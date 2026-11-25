// Classic regional banking and item repair (docs/town-services.md).
//
// Owns `rpg.townServices`:
//   { version: 1,
//     accounts: { [regionKey]: {region, gold} },           one bank account per region
//     letters:  [{id, amount, region, issuedAt}],          legacy records only: moved into the pack as Letter of Credit
//                                                          items (template letter-of-credit, `credit` extra) on join
//     repairs:  [{ticket, counterId, town, shop, item, cost, leftAt, readyAt}],  items left at a shop
//     recent:   [requestId…], seq }                         replay guard for client retries
//
// Counters are real buildings from the operator's ARENA2 data (Bank; Armorer, General Store and
// WeaponSmith repair, as RMBLayout.IsRepairShop) and the NPC feature's `role:'smith'` townsfolk.
// A counter serves only a player in the same town within reach of one of its street doors (or
// inside its interior, once interiors exist), or within conversation range of the smith.
//
// Every action validates first and then changes state through the equipment services
// (takeGold/addGold/takeItem), inside the runtime's single-transaction action, so a failure or a
// failed save leaves gold, items, balances and tickets untouched. A repeated `requestId` is
// refused, so a client retry after a disconnect can never repeat a transaction.
import {
  DOOR_REACH, GOLD_PER_KG, LETTER_MIN, MAX_BALANCE, MAX_LETTERS, MAX_REPAIRS, NPC_REACH,
  goldAmount, letterCost, placeOf, regionKey, repairBatchMinutes, repairCost, repairMinutes, repairRefusal, formatWait,
} from '../../client/gameplay/townServices/rules.js';
import { describeTemplate, normalizeRpg, resolveTemplate, MAX_ITEMS } from './inventory.js';
import { arena2ServiceLoader } from './townServices/buildings.js';
import { regionIndexOf } from '../../client/gameplay/economy/rules.js';
import { buildingAccess } from './townServices/access.js';
import { installTavern } from './townServices/tavern.js';

export const name = 'townServices';
export const VERSION = 1;

const ID_RE = /^[\w:,.-]{1,80}$/;
const REQUEST_RE = /^[\w-]{6,64}$/;
const RECENT_MAX = 64;
const AREA_LIMIT = 6;
const RETRY_MS = 5 * 60_000;

const fail = (msg) => {
  throw new Error(msg);
};
const int = (v, d = 0) => (Number.isFinite(v) ? Math.trunc(v) : d);
/** ItemTemplates 275, MiscItems.Letter_of_credit. */
const LETTER_TEMPLATE = 'letter-of-credit';
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Normalizes stored state in place; drops anything malformed. */
export function normalizeState(rpg) {
  const raw = isObj(rpg.townServices) ? rpg.townServices : {};
  const accounts = {};
  if (isObj(raw.accounts)) {
    for (const [k, a] of Object.entries(raw.accounts)) {
      if (!isObj(a) || typeof a.region !== 'string' || regionKey(a.region) !== k) continue;
      const gold = Math.max(0, Math.min(MAX_BALANCE, int(a.gold)));
      accounts[k] = { region: a.region.slice(0, 64), gold };
    }
  }
  const letters = (Array.isArray(raw.letters) ? raw.letters : [])
    .filter((l) => isObj(l) && typeof l.id === 'string' && Number.isInteger(l.amount) && l.amount > 0)
    .slice(0, MAX_LETTERS)
    .map((l) => ({ id: l.id.slice(0, 40), amount: Math.min(MAX_BALANCE, l.amount), region: String(l.region ?? '').slice(0, 64), issuedAt: int(l.issuedAt) }));
  const repairs = (Array.isArray(raw.repairs) ? raw.repairs : [])
    .filter((r) => isObj(r) && typeof r.ticket === 'string' && isObj(r.item) && typeof r.item.id === 'string' && typeof r.counterId === 'string')
    .slice(0, MAX_REPAIRS)
    .map((r) => ({
      ticket: r.ticket.slice(0, 40), counterId: r.counterId.slice(0, 80), town: String(r.town ?? ''), shop: String(r.shop ?? '').slice(0, 80),
      item: r.item, cost: Math.max(0, int(r.cost)), leftAt: int(r.leftAt), readyAt: int(r.readyAt),
    }));
  const recent = (Array.isArray(raw.recent) ? raw.recent : []).filter((s) => typeof s === 'string' && REQUEST_RE.test(s)).slice(-RECENT_MAX);
  rpg.townServices = { version: VERSION, accounts, letters, repairs, recent, seq: Math.max(0, int(raw.seq)) };
  return rpg.townServices;
}

/**
 * @param {object} ctx
 * @param {object} [options]
 * @param {(townId:string) => Promise<{counters:Array, source:string}>} [options.loadCounters]
 */
export function install(ctx, options = {}) {
  const log = ctx.log ?? console;
  const services = (ctx.services ||= {});
  const access = buildingAccess(ctx);
  services.buildingAccess = access;
  services.tavern = installTavern(ctx);
  const loadCounters = options.loadCounters ?? (ctx.dataPath ? arena2ServiceLoader(ctx.dataPath, services.worldData?.ready) : null);
  const areas = new Map(); // town id -> {status, counters, reason, source, settledAt, usedAt, promise}
  const lastLocation = new Map(); // player id -> location announced
  const pricingAt = new Map(); // player id -> ms the live price inputs were last compared
  let loadQueue = Promise.resolve();

  const stateOf = (p) => {
    if (!isObj(p.rpg)) p.rpg = {};
    if (!isObj(p.rpg.townServices) || p.rpg.townServices.version !== VERSION) normalizeState(p.rpg);
    return p.rpg.townServices;
  };
  const clockMinutes = () => {
    const c = typeof services.worldClock === 'function' ? services.worldClock() : null;
    return c && Number.isFinite(c.minutes) ? Math.trunc(c.minutes) : null;
  };
  // Every event carries the shared clock so the panel can count down repairs on its own.
  const say = (p, text, extra = {}) => ctx.notify(p, { kind: 'townServices', text, clock: clockMinutes(), ...extra });

  // ------------------------------------------------------------------ counters

  function area(town) {
    let a = areas.get(town);
    const now = ctx.now();
    if (a && a.status === 'unavailable' && a.retry && now - a.settledAt > RETRY_MS) {
      areas.delete(town);
      a = null;
    }
    if (!a) {
      a = { town, status: 'loading', counters: [], reason: null, source: null, settledAt: 0, usedAt: now, retry: false };
      areas.set(town, a);
      if (!loadCounters) settle(a, 'unavailable', [], 'this server has no game data, so it has no banks or shops', null, false);
      else {
        a.promise = loadQueue = loadQueue.then(() => loadCounters(town)).then(
          (r) => {
            // Property data from the same survey (server/rpg/property.js): port flag and residences.
            a.property = { port: r?.port === true, houses: Array.isArray(r?.houses) ? r.houses : [], buildingCount: Number.isInteger(r?.buildingCount) ? r.buildingCount : null, regionIndex: Number.isInteger(r?.regionIndex) ? r.regionIndex : null };
            settle(a, 'ready', Array.isArray(r?.counters) ? r.counters : [], null, r?.source ?? null, false);
          },
          (err) => {
            log.warn?.(`[townServices] ${town}: ${err?.message ?? err}`);
            settle(a, 'unavailable', [], err?.message || 'could not read this town', null, true);
          },
        );
      }
      evict();
    }
    a.usedAt = now;
    return a;
  }

  function settle(a, status, counters, reason, source, retry) {
    Object.assign(a, { status, counters, reason, source, retry, settledAt: ctx.now() });
    if (areas.get(a.town) !== a) return;
    for (const p of ctx.players.values()) {
      if (placeOf(ctx.location(p))?.town === a.town) {
        try {
          ctx.notify(p, countersEvent(p));
        } catch {}
      }
    }
  }

  function evict() {
    if (areas.size <= AREA_LIMIT) return;
    const occupied = new Set([...ctx.players.values()].map((p) => placeOf(ctx.location(p))?.town));
    const idle = [...areas.values()].filter((a) => a.status !== 'loading' && !occupied.has(a.town)).sort((x, y) => x.usedAt - y.usedAt);
    while (areas.size > AREA_LIMIT && idle.length) areas.delete(idle.shift().town);
  }

  /** Smith NPCs (npc feature metadata) at a location, as repair counters. */
  function npcCounters(location) {
    const out = [];
    for (const e of ctx.entities.values()) {
      if (e?.kind !== 'npc' || e.role !== 'smith' || e.location !== location) continue;
      out.push({
        id: `npc:${e.id}`, kind: 'npc', type: 'smith', npcId: e.id, services: ['repair'], quality: 10,
        name: `${e.name}, ${e.title || 'Smith'}`, doors: [{ x: e.x, z: e.z }],
      });
    }
    return out;
  }

  function countersAt(location) {
    const place = placeOf(location);
    if (!place) return { status: 'unavailable', reason: 'there are no banks or shops here', counters: [] };
    const a = area(place.town);
    const npcs = place.kind === 'town' ? npcCounters(location) : [];
    return { status: a.status, reason: a.reason, source: a.source, counters: [...a.counters, ...npcs], place };
  }

  function countersEvent(p) {
    const loc = ctx.location(p);
    const c = countersAt(loc);
    return {
      kind: 'townServices.counters',
      location: loc,
      status: c.status,
      reason: c.reason,
      counters: c.counters.map(({ id, kind, type, services: s, name: n, quality, doors, npcId }) => ({ id, kind, type, services: s, name: n, quality, doors, npcId })),
      reach: { door: DOOR_REACH, npc: NPC_REACH },
      clock: clockMinutes(),
      // Classic repair prices also follow the region's market (client/gameplay/economy/rules.js priceAdjust).
      market: typeof services.regionPriceAdjust === 'function' ? { adjust: services.regionPriceAdjust(regionIndexOf(loc)) } : null,
      // The authoritative live Mercantile and Personality the server prices with (package 12), so the browser's repair
      // quote matches; re-sent when they change (a blessing or condition ending).
      trade: tradeInputs(p),
    };
  }
  function tradeInputs(p) {
    const t = typeof services.tradeInputs === 'function' ? services.tradeInputs(p) : null;
    return t && (Number.isFinite(t.mercantile) || Number.isFinite(t.personality)) ? { mercantile: t.mercantile, personality: t.personality } : null;
  }
  /** What the counters event depends on besides the place: the region's market today and the live trade inputs. */
  function pricingKey(p, loc) {
    const t = tradeInputs(p);
    const adjust = typeof services.regionPriceAdjust === 'function' ? services.regionPriceAdjust(regionIndexOf(loc)) : '';
    return `${adjust}|${t?.mercantile ?? ''}|${t?.personality ?? ''}`;
  }

  /** Distance from p to the counter's nearest door (or NPC), or Infinity when not in the same place. */
  function distanceTo(p, counter, place) {
    if (counter.kind === 'building' && place.kind === 'interior') return place.counterId === counter.id ? 0 : Infinity;
    if (place.kind !== 'town') return Infinity;
    if (counter.kind === 'npc') {
      const e = ctx.entities.get(counter.npcId);
      if (!e || e.location !== ctx.location(p)) return Infinity;
      return Math.hypot(e.x - p.x, e.z - p.z);
    }
    let best = Infinity;
    for (const d of counter.doors) best = Math.min(best, Math.hypot(d.x - p.x, d.z - p.z));
    return best;
  }

  /** The counter `args.counterId` offering `service`, validated for proximity. */
  function counterFor(p, args, service) {
    const id = args?.counterId;
    if (typeof id !== 'string' || !ID_RE.test(id)) fail('Which counter?');
    const loc = ctx.location(p);
    const c = countersAt(loc);
    const counter = c.counters.find((k) => k.id === id);
    if (!counter) {
      if (c.status === 'loading') fail('The town ledgers are still being read. Try again in a moment.');
      fail('There is no such counter here.');
    }
    if (!counter.services.includes(service)) fail(`${counter.name} does not offer that.`);
    if (counter.kind === 'building' && !access.publicOpen(counter.buildingType, counter.regionIndex)) {
      fail(`${counter.name} is closed.`);
    }
    const reach = counter.kind === 'npc' ? NPC_REACH : DOOR_REACH;
    const d = distanceTo(p, counter, c.place);
    if (!(d <= reach)) fail(`You must be at ${counter.name} to do that${Number.isFinite(d) ? ` (${Math.round(d)} m away)` : ''}.`);
    return { counter, place: c.place };
  }

  /** Classic trade-price inputs for a repair at this counter: the region's market and the player's Mercantile and Personality. */
  function repairPrice(p, counter) {
    const loc = ctx.location(p);
    const pc = typeof services.priceContext === 'function' ? services.priceContext(p, loc, counter.quality) : null;
    return pc ? { adjust: pc.adjust, mercantile: pc.mercantile, personality: pc.personality } : null;
  }

  /** Replay guard: refuse a request id that has already been processed. */
  function claimRequest(ts, args) {
    const rid = args?.requestId;
    if (rid == null) return;
    if (typeof rid !== 'string' || !REQUEST_RE.test(rid)) fail('Invalid request.');
    if (ts.recent.includes(rid)) fail('That was already done.');
    ts.recent.push(rid);
    if (ts.recent.length > RECENT_MAX) ts.recent.splice(0, ts.recent.length - RECENT_MAX);
  }

  function account(ts, region) {
    const k = regionKey(region);
    if (!k || k === '__proto__' || k === 'constructor' || k === 'prototype') fail('This region has no bank.');
    if (!Object.hasOwn(ts.accounts, k)) ts.accounts[k] = { region, gold: 0 };
    return ts.accounts[k];
  }

  const goldOf = (p) => Math.max(0, int(p.rpg?.gold));
  /** Letters of Credit carried in the pack (ItemTemplates 275 with a `credit` record), oldest first. */
  const lettersOf = (p) => (Array.isArray(p.rpg?.inventory) ? p.rpg.inventory : [])
    .filter((it) => it?.template === LETTER_TEMPLATE && int(it.credit?.amount) > 0);
  /** PlayerEntity.GetGoldAmount: carried gold plus the letters of credit. */
  const spendable = (p) => goldOf(p) + lettersOf(p).reduce((n, l) => n + int(l.credit.amount), 0);
  /**
   * PlayerEntity.DeductGoldAmount: carried gold when it covers the price, else letters first (a letter worth more
   * than what is left keeps the difference), then gold. Returns {gold, credit}. Refuses before changing anything.
   */
  function spendGold(p, amount) {
    amount = Math.max(0, int(amount));
    if (amount > spendable(p)) fail(`You need ${amount} gold.`);
    if (amount <= goldOf(p)) {
      if (amount) services.takeGold(p, amount);
      return { gold: amount, credit: 0 };
    }
    let left = amount, credit = 0;
    for (const l of lettersOf(p)) {
      if (left <= 0) break;
      const v = int(l.credit.amount);
      if (left < v) {
        l.credit.amount = v - left;
        l.value = l.credit.amount;
        credit += left;
        left = 0;
        ctx.dirty(p);
        ctx.emit?.('inventoryChanged', { player: p, reason: 'credit' });
      } else {
        services.takeItem(p, l.id, 1);
        credit += v;
        left -= v;
      }
    }
    if (left > 0) services.takeGold(p, left);
    return { gold: left, credit };
  }
  services.creditAmount = (p) => lettersOf(p).reduce((n, l) => n + int(l.credit.amount), 0);
  services.spendableGold = spendable;
  services.spendGold = spendGold;
  const needInventory = () => {
    for (const s of ['takeGold', 'addGold', 'takeItem']) if (typeof services[s] !== 'function') fail('The counter is closed right now.');
  };

  // ------------------------------------------------------------------ lifecycle

  ctx.onJoin((p) => {
    const state = stateOf(p);
    // Letters written before they were items become Letters of Credit in the pack (same amount and region).
    if (state.letters.length && typeof services.giveItem === 'function') {
      const keep = [];
      for (const l of state.letters) {
        try {
          services.giveItem(p, LETTER_TEMPLATE, 1, { extra: { credit: { amount: l.amount, region: l.region, issuedAt: l.issuedAt } } });
        } catch (err) {
          keep.push(l); // a full pack keeps the record until there is room
        }
      }
      state.letters = keep;
      ctx.dirty(p);
    }
    for (const ticket of Array.isArray(state.repairs) ? state.repairs : []) {
      if (!resolveTemplate(ticket?.item?.template)) continue;
      const { icon } = describeTemplate(ticket.item.template);
      ticket.item.icon = icon;
    }
    lastLocation.delete(p.id);
  });
  ctx.onLeave((p) => {
    lastLocation.delete(p.id);
  });

  // Announce counters on arrival in a new place (join, travel, entering a building).
  ctx.onTick(() => {
    for (const p of ctx.players.values()) {
      const loc = ctx.location(p);
      if (!placeOf(loc)) {
        lastLocation.set(p.id, loc);
        continue;
      }
      // A new place is announced at once; live price inputs (blessings, conditions) are re-checked about once a second.
      const prev = lastLocation.get(p.id);
      if (typeof prev === 'string' && prev.startsWith(`${loc}|`) && ctx.now() - (pricingAt.get(p.id) ?? 0) < 1000) continue;
      pricingAt.set(p.id, ctx.now());
      const key = `${loc}|${pricingKey(p, loc)}`;
      if (prev === key) continue;
      lastLocation.set(p.id, key);
      try {
        ctx.notify(p, countersEvent(p));
      } catch (err) {
        log.error?.('[townServices] announce failed:', err);
      }
    }
  });

  // A smith NPC offers repairs: tell the player where the controls are.
  ctx.on('talk', (ev) => {
    const p = ev?.player;
    const e = ev?.entity;
    if (!p || e?.kind !== 'npc' || e.role !== 'smith') return;
    ctx.notify(p, { kind: 'townServices.offer', counterId: `npc:${e.id}`, services: ['repair'], text: `${e.name} can repair your weapons and armour (Bank & Repairs).` });
  });

  // ------------------------------------------------------------------ actions

  ctx.onAction('town.services', (p) => {
    stateOf(p);
    ctx.notify(p, countersEvent(p));
  });

  ctx.onAction('bank.deposit', (p, args) => {
    const ts = stateOf(p);
    const { place } = counterFor(p, args, 'bank');
    const amount = goldAmount(args.amount);
    if (!amount) fail('Choose how much gold to deposit.');
    // DaggerfallBankManager.DepositGold: gold in the wagon (package 13) counts once the purse is empty.
    const wagon = Math.max(0, int(services.property?.wagonGold?.(p)));
    if (goldOf(p) + wagon < amount) fail(`You only have ${goldOf(p)} gold${wagon ? ` and ${wagon} in your wagon` : ''}.`);
    const acct = account(ts, place.region);
    if (acct.gold + amount > MAX_BALANCE) fail('The bank cannot hold that much for you.');
    needInventory();
    claimRequest(ts, args);
    const fromPurse = Math.min(goldOf(p), amount);
    if (fromPurse) services.takeGold(p, fromPurse);
    if (amount > fromPurse) services.property.takeWagonGold(p, amount - fromPurse);
    acct.gold += amount;
    say(p, `Deposited ${amount} gold${amount > fromPurse ? ` (${amount - fromPurse} from your wagon)` : ''}. Your balance in ${acct.region} is ${acct.gold}.`);
  });

  ctx.onAction('bank.withdraw', (p, args) => {
    const ts = stateOf(p);
    const { place } = counterFor(p, args, 'bank');
    const amount = goldAmount(args.amount);
    if (!amount) fail('Choose how much gold to withdraw.');
    const acct = account(ts, place.region);
    if (acct.gold < amount) fail(`Your account in ${acct.region} holds only ${acct.gold} gold.`);
    if (typeof services.carriedWeight === 'function' && typeof services.maxEncumbrance === 'function') {
      if (services.carriedWeight(p) + amount / GOLD_PER_KG > services.maxEncumbrance(p)) fail('You cannot carry that much gold.');
    }
    needInventory();
    claimRequest(ts, args);
    acct.gold -= amount;
    services.addGold(p, amount);
    say(p, `Withdrew ${amount} gold. Your balance in ${acct.region} is ${acct.gold}.`);
  });

  ctx.onAction('bank.letter', (p, args) => {
    const ts = stateOf(p);
    const { place } = counterFor(p, args, 'bank');
    const amount = goldAmount(args.amount);
    if (!amount || amount < LETTER_MIN) fail(`A letter of credit must be for at least ${LETTER_MIN} gold.`);
    const cost = letterCost(amount);
    const acct = account(ts, place.region);
    if (acct.gold < cost) fail(`A letter for ${amount} gold costs ${cost} from your account; you have ${acct.gold}.`);
    if (lettersOf(p).length >= MAX_LETTERS) fail('You are carrying too many letters of credit.');
    needInventory();
    claimRequest(ts, args);
    acct.gold -= cost;
    // A physical Letter of Credit (ItemTemplates 275) in the pack, worth `amount` (DaggerfallBankManager.Withdraw_LOC).
    services.giveItem(p, LETTER_TEMPLATE, 1, { extra: { credit: { amount, region: acct.region, issuedAt: clockMinutes() ?? 0 } } });
    say(p, `The bank writes you a letter of credit for ${amount} gold (${cost} from your account).`);
  });

  ctx.onAction('bank.redeem', (p, args) => {
    const ts = stateOf(p);
    const { place } = counterFor(p, args, 'bank');
    const letters = lettersOf(p);
    if (!letters.length) fail('You carry no letters of credit.');
    const acct = account(ts, place.region);
    const total = letters.reduce((n, l) => n + l.credit.amount, 0);
    if (acct.gold + total > MAX_BALANCE) fail('The bank cannot hold that much for you.');
    needInventory();
    claimRequest(ts, args);
    const count = letters.length;
    // DepositAll_LOC: every letter carried is paid into this region's account.
    for (const l of letters) services.takeItem(p, l.id, 1);
    acct.gold += total;
    say(p, `Deposited ${count} letter${count === 1 ? '' : 's'} of credit worth ${total} gold. Your balance in ${acct.region} is ${acct.gold}.`);
  });

  ctx.onAction('repair.leave', (p, args) => {
    const ts = stateOf(p);
    const { counter, place } = counterFor(p, args, 'repair');
    const now = clockMinutes();
    if (now == null) fail('Repairs are unavailable right now.');
    // One item (`itemId`) or several left together (`itemIds`, classic batch timing); `cost` is the total quoted.
    const ids = Array.isArray(args.itemIds) ? args.itemIds : [args.itemId];
    if (!ids.length || ids.length > MAX_REPAIRS || new Set(ids).size !== ids.length) fail('Choose what to leave for repair.');
    const items = ids.map((id) => (p.rpg.inventory || []).find((i) => i && i.id === id));
    for (const item of items) {
      const refusal = repairRefusal(item);
      if (refusal) fail(refusal);
      if (item.equipped) fail(`Unequip ${item.name} first.`);
    }
    if (ts.repairs.length + items.length > MAX_REPAIRS) fail('You already have too many items with smiths.');
    const rank = typeof services.guildRank === 'function' ? services.guildRank(p, 'fighters') : null;
    const price = repairPrice(p, counter);
    const costs = items.map((item) => repairCost(item, counter.quality, rank, price));
    const cost = costs.reduce((a, b) => a + b, 0);
    if (args.cost !== cost) fail('The price has changed. Look again.');
    if (goldOf(p) < cost) fail(`${items.length > 1 ? 'Those repairs cost' : `Repairing ${items[0].name} costs`} ${cost} gold.`);
    needInventory();
    claimRequest(ts, args);
    services.takeGold(p, cost);
    const minutes = repairBatchMinutes(items);
    const tickets = items.map((item, i) => {
      const rec = services.takeItem(p, item.id, 1);
      if (!rec || rec.id !== item.id) fail('The smith could not take that item.');
      const ticket = { ticket: `rp${(++ts.seq).toString(36)}`, counterId: counter.id, town: place.town, shop: counter.name, item: rec, cost: costs[i], leftAt: now, readyAt: now + minutes[i] };
      ts.repairs.push(ticket);
      return ticket;
    });
    const last = Math.max(...tickets.map((t) => t.readyAt));
    const what = tickets.length > 1 ? `${tickets.length} items` : tickets[0].item.name;
    say(p, `You leave ${what} with ${counter.name} for ${cost} gold. ${tickets.length > 1 ? 'Everything' : 'It'} will be ready in ${formatWait(last, now)}.`);
  });

  ctx.onAction('repair.collect', (p, args) => {
    const ts = stateOf(p);
    const t = ts.repairs.find((r) => r.ticket === args.ticket);
    if (!t) fail('You have nothing waiting under that ticket.');
    const loc = ctx.location(p);
    // Tickets left with a legacy roster smith (`npc:npc:<hash>:<slot>`, before source-backed people) are collected
    // at any real repair counter of the same town: no stand-in smith is spawned for them.
    const legacySmith = /^npc:npc:[0-9a-z]+:\d+$/.test(t.counterId) && !ctx.entities.has(t.counterId.slice(4));
    if (placeOf(loc)?.town !== t.town || (args.counterId !== t.counterId && !legacySmith)) fail(`Your ${t.item.name} is with ${t.shop} in ${placeOf(t.town)?.location ?? 'another town'}.`);
    counterFor(p, args, 'repair');
    const now = clockMinutes();
    if (now == null) fail('Repairs are unavailable right now.');
    const done = now >= t.readyAt;
    if (!done && args.interrupt !== true) fail(`${t.item.name} will be ready in ${formatWait(t.readyAt, now)}.`);
    const rpg = p.rpg;
    if (!Array.isArray(rpg.inventory)) fail('Your pack is unavailable.');
    if (rpg.inventory.length >= MAX_ITEMS) fail('Your pack cannot hold any more items.');
    if (rpg.inventory.some((i) => i?.id === t.item.id)) {
      log.error?.(`[townServices] ${p.name}: item ${t.item.id} is already in the pack; refusing to duplicate it`);
      fail('The smith cannot find your item. Please report this.');
    }
    const weight = Number(t.item.weight) || 0;
    if (typeof services.carriedWeight === 'function' && typeof services.maxEncumbrance === 'function') {
      if (services.carriedWeight(p) + weight > services.maxEncumbrance(p)) fail(`You cannot carry ${t.item.name} right now.`);
    }
    claimRequest(ts, args);
    const item = { ...t.item };
    delete item.equipped;
    if (done) item.condition = item.maxCondition;
    rpg.inventory.push(item);
    normalizeRpg(rpg);
    if (!rpg.inventory.some((i) => i.id === item.id)) fail('The smith cannot return that item.');
    ts.repairs.splice(ts.repairs.indexOf(t), 1);
    ctx.dirty(p);
    ctx.emit('inventoryChanged', { player: p, reason: 'repair' });
    say(p, done ? `${item.name} is as good as new.` : `You take back ${item.name} unrepaired.`);
  });

  // ------------------------------------------------------------------ cross-domain services

  Object.assign(services, {
    /**
     * Package 12: the exact total `repair.leave` will charge this player at `counterId` for `itemIds` (classic repair cost,
     * Fighters Guild discount, regional market and trade price), or null when the counter is unknown. Read-only.
     */
    repairQuote: (p, counterId, itemIds) => {
      const counter = countersAt(ctx.location(p)).counters.find((k) => k.id === counterId);
      if (!counter) return null;
      const rank = typeof services.guildRank === 'function' ? services.guildRank(p, 'fighters') : null;
      const price = repairPrice(p, counter);
      const ids = Array.isArray(itemIds) ? itemIds : [itemIds];
      let total = 0;
      for (const id of ids) {
        const item = (p.rpg.inventory || []).find((i) => i && i.id === id);
        if (!item) return null;
        total += repairCost(item, counter.quality, rank, price);
      }
      return total;
    },
    /** Counters at a location: {status, reason, counters}. Starts loading when unknown. */
    townCounters: (location) => {
      const c = countersAt(String(location));
      return { status: c.status, reason: c.reason, counters: c.counters.map((k) => ({ ...k })) };
    },
    /** Read-only balance of a player's account in a region. */
    bankBalance: (p, region) => stateOf(p).accounts[regionKey(region)]?.gold ?? 0,
    /** Package 13 (server/rpg/property.js): the bank counter `args.counterId`, validated for reach and hours. */
    bankCounter: (p, args) => counterFor(p, args, 'bank'),
    /** Package 13: change a regional balance inside the current action. Refuses to go below zero. */
    bankAdjust: (p, region, delta) => {
      const acct = account(stateOf(p), region);
      const next = acct.gold + Math.trunc(delta);
      if (next < 0) fail(`Your account in ${acct.region} holds only ${acct.gold} gold.`);
      if (next > MAX_BALANCE) fail('The bank cannot hold that much for you.');
      ctx.dirty(p);
      acct.gold = next;
      return next;
    },
    /** Package 13: port flag, residences and building count of a town once its counters are read. */
    townProperty: (town) => {
      const a = area(String(town));
      return a.status === 'ready' ? { status: 'ready', ...(a.property ?? { port: false, houses: [], buildingCount: null, regionIndex: null }) } : { status: a.status, reason: a.reason };
    },
    /** Resolves when the counters for a town id are known (tests and warm-up). */
    townCountersSettled: (town) => {
      const a = area(String(town));
      return Promise.resolve(a.promise).then(() => ({ status: a.status, reason: a.reason }));
    },
  });

  return { areas, countersAt, stateOf };
}
