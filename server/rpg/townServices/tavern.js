import { dateFromMinutes, DAYS_PER_YEAR, MINUTES_PER_DAY } from '../../../client/gameplay/atmosphere/calendar.js';
import { HEARTS_DAY, holidayAt, holidayPrice } from '../../../client/gameplay/atmosphere/holidays.js';
import { BUILDING } from '../npcs/people.js';

// Daggerfall Unity's DaggerfallTavernWindow and FormulaHelper identify the
// menu, four-hour recovery interval, holiday prices and classic room rate.
const MENU = [
  ['Ale', 1], ['Beer', 1], ['Mead', 2], ['Wine', 3], ['Bread', 1], ['Broth', 1],
  ['Cheese', 2], ['Fowl', 3], ['Gruel', 2], ['Pie', 2], ['Stew', 3],
];
const ROOM_RATE = 7;
const MAX_DAYS = 350;
const MEAL_INTERVAL = 240;
const REACH = 2.25;
const PREFIX = 'tavern:';
const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

export function installTavern(ctx) {
  const s = ctx.services;
  const reservations = new Map(ctx.loadWorld?.(PREFIX) ?? []);
  const now = () => s.worldClock?.()?.minutes;
  const ownMinutes = (p, minute) => s.playerMinutes?.(p) ?? minute;
  const releaseMinute = record => record?.releaseAt ?? record?.expiresAt;
  const currentInn = p => {
    const portal = s.portals?.into?.(ctx.location(p));
    return portal?.meta?.buildingType === BUILDING.Tavern ? portal : null;
  };

  function rental(p, inn, minute) {
    const record = p.rpg.tavern?.rooms?.[inn.to];
    if (!(releaseMinute(record) > minute) || !inn.meta.beds?.some(b => b.number === record.bed)) return null;
    const hold = reservations.get(PREFIX + inn.to)?.find(r => r.player === p.id && r.bed === record.bed);
    if (!(hold?.releaseAt > minute)) return null;
    return { ...record, releaseAt: Math.min(releaseMinute(record), hold.releaseAt) };
  }

  function menu(minute) {
    const holiday = (s.holidayAt ?? holidayAt)(minute, 0);
    return MENU.map(([name, normal], id) => {
      const { price } = holidayPrice('tavern', normal, holiday);
      return { id, name, cost: price, recovery: 2 * (price || normal) };
    });
  }

  function bedInfo(p, inn, record) {
    const bed = inn.meta.beds.find(b => b.number === record.bed);
    const floor = s.collision?.groundAt(inn.to, bed.x, bed.z, bed.y + 0.1) ?? bed.y;
    const foot = p.rpg.portal?.footY ?? 0;
    const dx = bed.x - p.x, dz = bed.z - p.z;
    const distance = Math.hypot(dx, dz);
    const direction = COMPASS[(Math.round(Math.atan2(dx, -dz) / (Math.PI / 4)) + 8) % 8];
    const storey = floor - foot > 1.6 ? 'upstairs' : foot - floor > 1.6 ? 'downstairs' : null;
    const line = !s.collision || s.collision.instanceWorld(inn.to)?.segmentClear(p.x, foot + 1.5, p.z, bed.x, floor + 1.5, bed.z);
    return { ...bed, y: floor, expiresAt: record.expiresAt, releaseAt: releaseMinute(record),
      near: !storey && distance <= REACH && !!line,
      directions: `${Math.round(distance)} m ${direction}${storey ? `, ${storey}` : ''}` };
  }

  function view(p, inn, minute = now()) {
    if (!inn || !Number.isFinite(minute)) return null;
    const active = rental(p, inn, minute);
    const base = releaseMinute(active) ?? minute;
    const firstDay = dateFromMinutes(base).dayOfYear;
    return {
      minute: ownMinutes(p, minute),
      menu: menu(minute),
      mealReadyAt: (p.rpg.tavern?.lastServedAt ?? -MEAL_INTERVAL) + MEAL_INTERVAL,
      roomRate: s.guilds?.freeTavernRoom?.(p, inn.meta.regionIndex) ? 0 : ROOM_RATE,
      maxDays: MAX_DAYS - Math.ceil((base - minute) / MINUTES_PER_DAY),
      freeDay: (HEARTS_DAY - firstDay + DAYS_PER_YEAR) % DAYS_PER_YEAR + 1,
      bed: active ? bedInfo(p, inn, active) : null,
      hasBeds: !!inn.meta.beds?.length,
    };
  }

  function saveReservations(key, ledger) {
    const previous = reservations.get(key);
    if (ledger.length) reservations.set(key, ledger);
    else reservations.delete(key);
    ctx.onRollback(() => {
      if (previous) reservations.set(key, previous);
      else reservations.delete(key);
    });
    ctx.dirtyWorld(key, ledger.length ? ledger : null);
  }

  // Character deadlines are expressed in personal time. The shared reservation
  // has a world-clock release minute, initially the same duration from "now".
  // Spending personal time moves that release earlier, atomically with the
  // spender's own state. A shopper never compares their clock with a guest's.
  ctx.on('timeSpent', ({ player: p, minutes }) => {
    const rooms = p.rpg.tavern?.rooms;
    const minute = now();
    if (!rooms || !Number.isFinite(minute) || !(minutes > 0)) return;
    ctx.dirty(p);
    for (const [location, room] of Object.entries(rooms)) {
      const key = PREFIX + location;
      const prior = reservations.get(key);
      const hold = prior?.find(r => r.player === p.id && r.bed === room.bed);
      if (!hold) {
        delete rooms[location];
        continue;
      }
      room.releaseAt = Math.min(releaseMinute(room), hold.releaseAt) - minutes;
      if (!(room.releaseAt > minute)) delete rooms[location];
      const others = prior.filter(r => r.player !== p.id && r.releaseAt > minute);
      if (room.releaseAt > minute) others.push({ player: p.id, bed: room.bed, releaseAt: room.releaseAt });
      saveReservations(key, others);
    }
  });

  function serve(p, keeper, args) {
    const inn = currentInn(p);
    const minute = now();
    if (!inn || !Number.isFinite(minute)) throw new Error('Room and board are available at the inn.');
    if (!p.rpg.character) throw new Error('Create your character first.');
    const quote = view(p, inn, minute);
    if (args.days == null && args.menuItem == null) return quote.bed
      ? `You have bed ${quote.bed.number}, ${quote.bed.directions}.`
      : 'What can I get you?';
    const state = p.rpg.tavern ??= { rooms: {} };
    for (const [location, room] of Object.entries(state.rooms)) {
      if (!(releaseMinute(room) > minute)) delete state.rooms[location];
    }

    function pay(cost) {
      if (cost !== args.cost) throw new Error('The price has changed. Ask again for the current price.');
      if (p.rpg.gold < cost) throw new Error(`You need ${cost} gold.`);
      if (cost) s.takeGold(p, cost);
    }

    if (args.menuItem != null) {
      const item = quote.menu.find(m => m.id === args.menuItem);
      if (!item) throw new Error('Choose something from the menu.');
      if (quote.minute < quote.mealReadyAt) throw new Error('You can order again four hours after your last meal or drink.');
      pay(item.cost);
      const recovered = s.healPlayer?.(p, item.recovery) ?? 0;
      state.lastServedAt = quote.minute;
      return `${keeper.name} serves you ${item.name.toLowerCase()} for ${item.cost} gold.${recovered ? ` You recover ${recovered} health.` : ''}`;
    }

    if (!Number.isInteger(args.days) || args.days < 1 || args.days > quote.maxDays) {
      throw new Error(`Choose a whole number of days. An inn rental can extend up to ${MAX_DAYS} days ahead.`);
    }
    if ((args.rentalExpiresAt ?? null) !== (quote.bed?.expiresAt ?? null)) throw new Error('Your booking has changed. Ask about the room again.');
    const key = PREFIX + inn.to;
    const occupied = (reservations.get(key) ?? []).filter(r => r.releaseAt > minute && r.player !== p.id);
    const bed = quote.bed?.number ?? inn.meta.beds?.find(b => occupied.every(r => r.bed !== b.number))?.number;
    if (!bed) throw new Error(quote.hasBeds ? 'All beds are taken at this inn.' : 'This inn has no beds to let.');
    const cost = quote.roomRate * (args.days - Number(args.days >= quote.freeDay));
    const duration = args.days * MINUTES_PER_DAY;
    pay(cost);
    const record = { bed, expiresAt: (quote.bed?.expiresAt ?? quote.minute) + duration,
      releaseAt: (quote.bed?.releaseAt ?? minute) + duration };
    state.rooms[inn.to] = record;
    saveReservations(key, [...occupied, { player: p.id, bed, releaseAt: record.releaseAt }]);
    const where = bedInfo(p, inn, record);
    return `${quote.bed ? 'I’ve extended your stay' : `Bed ${bed} is yours`} for ${args.days} ${args.days === 1 ? 'day' : 'days'} for ${cost} gold. It’s ${where.directions}.`;
  }

  function sleep(p, minute = now()) {
    const inn = currentInn(p);
    if (!inn) return null;
    const record = rental(p, inn, minute);
    if (!record) return { error: 'You need a current room rental to sleep at this inn.' };
    const bed = bedInfo(p, inn, record);
    if (!bed.near) return { error: `Go to your rented bed ${bed.number}. It’s ${bed.directions}.` };
    return { releaseAt: bed.releaseAt, bed: bed.number };
  }

  function hasRental(p, minute) {
    const inn = currentInn(p);
    return !!inn && !!rental(p, inn, minute);
  }

  return { view: p => view(p, currentInn(p)), serve, sleep, hasRental };
}
