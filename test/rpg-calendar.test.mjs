// Package 20: classic holidays and their prices, legal and unsafe rest, loitering, rest encounters,
// travel refusal and personal (rest/travel/prison) time against the shared clock.
// Runs the real runtime with travel (starter catalogue), atmosphere and calendar; combat's hooks
// (restEncounter, monsterThreatens) and package 2's tavern bed service are stubs here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installTravel } from '../server/rpg/travel.js';
import { install as installAtmosphere } from '../server/rpg/atmosphere.js';
import { install as installCalendar, placeKind } from '../server/rpg/calendar.js';
import { CLASSIC_GAME_START_TIME, MINUTES_PER_DAY, dateFromMinutes } from '../client/gameplay/atmosphere/calendar.js';
import {
  HOLIDAYS, HOLIDAY, holidayAt, holidayIdAt, holidayInfo, holidayPrice, holidaysOf, dayOfYearAt, shopsClosed,
} from '../client/gameplay/atmosphere/holidays.js';

const EPOCH = Date.UTC(2026, 0, 1);
const DAGGERFALL = 17; // MAPS region index
const WAYREST = 23;
/** Classic minutes at `hour`:00 on day-of-year `doy` of 3E405. */
const minuteOn = (doy, hour = 12) => CLASSIC_GAME_START_TIME - (3 * MINUTES_PER_DAY + 13 * 60 + 30) + (doy - 1) * MINUTES_PER_DAY + hour * 60;

describe('holiday calendar (FormulaHelper.GetHolidayId)', () => {
  test('53 holidays with classic ids, stable keys and days', () => {
    assert.equal(HOLIDAYS.length, 53);
    assert.deepEqual(HOLIDAYS.map((h) => h.id), Array.from({ length: 53 }, (_, i) => i + 1));
    assert.equal(HOLIDAY.Suns_Rest, 'suns-rest');
    assert.equal(holidayInfo('suns-rest').id, 31);
    assert.equal(holidayInfo(31).key, 'suns-rest');
    assert.equal(holidayInfo('Merchants_Festival').key, 'merchants-festival');
    const sr = holidayInfo('suns-rest');
    assert.deepEqual([sr.dayOfYear, sr.month, sr.day, sr.regionIndex, sr.textId], [200, 6, 20, null, 8380]);
    assert.equal(holidayInfo('hearts-day').dayOfYear, 46);
    assert.equal(holidayInfo('new-life').dayOfYear, 1);
    assert.equal(holidayInfo('harvest-end').dayOfYear, 237); // matches package 2's tavern menu day
    assert.equal(new Set(HOLIDAYS.map((h) => h.key)).size, 53);
  });

  test('day of year agrees with the shared calendar', () => {
    for (const m of [CLASSIC_GAME_START_TIME, minuteOn(200), minuteOn(360, 23), minuteOn(1, 0)]) {
      assert.equal(dayOfYearAt(m), dateFromMinutes(m).dayOfYear);
    }
    assert.equal(dayOfYearAt(minuteOn(200)), 200);
  });

  test('universal and regional holidays', () => {
    assert.equal(holidayAt(minuteOn(200), DAGGERFALL), 'suns-rest');
    assert.equal(holidayAt(minuteOn(200), WAYREST), 'suns-rest');
    // Day of the Dead (id 18, day 103) belongs to region index 17 only.
    assert.equal(holidayAt(minuteOn(103), DAGGERFALL), 'day-of-the-dead');
    assert.equal(holidayAt(minuteOn(103), WAYREST), null);
    assert.equal(holidayIdAt(minuteOn(103), DAGGERFALL), 18);
    assert.equal(holidayAt(minuteOn(104), DAGGERFALL), null);
    assert.equal(holidayAt(minuteOn(103), null), null);
    // Days 356..360 are never holidays (Saturalia is 355).
    assert.equal(holidayAt(minuteOn(355), WAYREST), 'saturalia');
    for (let d = 356; d <= 360; d++) assert.equal(holidayIdAt(minuteOn(d), WAYREST), 0);
    // Every holiday falls on its day the next year too.
    assert.equal(holidayAt(minuteOn(200) + 360 * MINUTES_PER_DAY, 0), 'suns-rest');
    assert.ok(holidaysOf(DAGGERFALL).some((h) => h.key === 'dancing-day'));
    assert.ok(!holidaysOf(WAYREST).some((h) => h.key === 'dancing-day'));
    assert.equal(shopsClosed('suns-rest'), true);
    assert.equal(shopsClosed('new-life'), false);
  });

  test('service prices follow the classic consumers', () => {
    const p = (service, price, key, opts) => holidayPrice(service, price, key, opts);
    assert.deepEqual(p('tavern', 3, 'new-life'), { price: 0, free: true, holiday: 'new-life', rule: 'free' });
    assert.equal(p('tavern', 3, 'harvest-end').price, 1);
    assert.equal(p('tavern', 1, 'harvest-end').price, 1); // never 0
    assert.equal(p('tavern', 3, 'suns-rest').price, 3);
    assert.equal(p('identify', 40, 'witches-festival').price, 0);
    assert.equal(p('spell', 101, 'witches-festival').price, 50);
    assert.equal(p('spell', 1, 'witches-festival').price, 1);
    assert.equal(p('cure', 300, 'first-harvest').price, 0);
    assert.equal(p('cure', 300, 'second-harvest').free, true);
    assert.equal(p('cure', 300, 'south-winds-prayer').price, 0);
    assert.equal(p('cure', 301, 'north-winds-festival').price, 150);
    assert.equal(p('trade', 100, 'merchants-festival', { guildFaction: null }).price, 50);
    assert.equal(p('trade', 100, 'merchants-festival', { guildFaction: 40 }).price, 100);
    assert.equal(p('trade', 100, 'tales-and-tallow', { guildFaction: 40 }).price, 50);
    assert.equal(p('trade', 100, 'tales-and-tallow', { guildFaction: null }).price, 100);
    assert.equal(p('trade', 100, 'warriors-festival', { guildFaction: null, itemGroup: 'Weapons' }).price, 50);
    assert.equal(p('trade', 100, 'warriors-festival', { guildFaction: null, itemGroup: 'Armor' }).price, 100);
    // CalculateRoomCost: 7 a day, the Heart's Day night is free.
    assert.equal(p('room', 21, null, { days: 3, startDayOfYear: 45 }).price, 14);
    assert.equal(p('room', 7, null, { days: 1, startDayOfYear: 46 }).price, 0);
    assert.equal(p('room', 21, null, { days: 3, startDayOfYear: 47 }).price, 21);
  });
});

// ------------------------------------------------------------------------------------------------ server

function setup({ minute = minuteOn(150, 13), restEncounter, monsterThreatens, ownsBuilding, guildCanRest, portals } = {}) {
  let wall = EPOCH + (minute - CLASSIC_GAME_START_TIME) * 5000; // 12x: one game minute per 5 real seconds
  const players = new Map();
  const notes = [];
  const emitted = [];
  const encounterCalls = [];
  const runtime = createRpgRuntime({
    players,
    features: [
      { name: 'travel', install: (ctx) => installTravel(ctx) },
      { name: 'atmosphere', install: (ctx) => installAtmosphere(ctx, { wallNow: () => wall, restSecondsPerHour: 1 }) },
      { name: 'calendar', install: installCalendar },
      {
        name: 'stubs',
        install(ctx) {
          if (restEncounter) ctx.services.restEncounter = (p, m) => { encounterCalls.push([p.id, m]); return restEncounter(p, m); };
          if (monsterThreatens) ctx.services.monsterThreatens = monsterThreatens;
          if (ownsBuilding) ctx.services.ownsBuilding = ownsBuilding;
          if (guildCanRest) ctx.services.guildCanRest = guildCanRest;
          if (portals) ctx.services.portals = portals;
          ctx.services.reportCrime = (p, crime, info) => emitted.push(['reportCrime', p.id, crime, info.location]);
          for (const name of ['crime', 'timeSpent', 'restEnd', 'holiday', 'travel']) {
            ctx.on(name, (ev) => emitted.push([name, ev.player?.id, ev.reason ?? ev.crime ?? ev.holiday?.key ?? ev.to ?? null, ev.minutes ?? null, ev]));
          }
        },
      },
    ],
    save() {},
    send: (p, msg) => { if (msg.type === 'gameEvent') notes.push({ ...msg.event, pid: p.id }); },
    log: { info() {}, warn() {}, error() {} },
  });
  const join = (id, location = 'town:Daggerfall/Gothway Garden', extra = {}) => {
    const p = {
      id, name: `P${id}`, x: 0, z: 0, yaw: 0, moving: false,
      rpg: {
        location, gold: 500,
        character: { maxHealth: 40, health: 10, maxFatigue: 120, fatigue: 20, maxMagicka: 60, magicka: 5, attributes: { Endurance: 60 }, skills: { Medical: 20 } },
        ...extra,
      },
    };
    players.set(id, p);
    runtime.join(p);
    return p;
  };
  return {
    runtime, notes, emitted, encounterCalls, join, s: runtime.ctx.services, ctx: runtime.ctx,
    act: (p, verb, args) => runtime.act(p, verb, args),
    tick: (dt) => runtime.tick(dt),
    setMinute: (m) => { wall = EPOCH + (m - CLASSIC_GAME_START_TIME) * 5000; },
    of: (kind, id) => notes.filter((n) => n.kind === kind && (id === undefined || n.pid === id)),
  };
}

describe('holidays on the server', () => {
  test('a player stepping into a town on a holiday is told once per date; prices use their region', () => {
    const h = setup({ minute: minuteOn(103, 9) });
    const a = h.join(1);
    const b = h.join(2, 'town:Wayrest/Wayrest');
    h.tick(0.1);
    h.tick(0.1);
    const toA = h.of('holiday', 1);
    assert.equal(toA.length, 1, 'Day of the Dead announced once in Daggerfall');
    assert.equal(toA[0].key, 'day-of-the-dead');
    assert.equal(toA[0].textId, 8349 + 18);
    assert.equal(h.of('holiday', 2).length, 0, 'not a holiday in Wayrest');
    assert.equal(h.s.holidayFor(a).key, 'day-of-the-dead');
    assert.equal(h.s.holidayFor(b), null);
    // Reconnecting the same day does not repeat it (kept on the character).
    h.runtime.leave(a);
    h.runtime.ctx.players.delete(1);
    h.runtime.ctx.players.set(1, a);
    h.runtime.join(a);
    h.tick(0.1);
    assert.equal(h.of('holiday', 1).length, 1);
    // Next Sun's Rest: both players, every region, shops-closed note.
    h.setMinute(minuteOn(200, 9));
    h.tick(0.1);
    assert.equal(h.of('holiday', 1).at(-1).key, 'suns-rest');
    assert.equal(h.of('holiday', 2).at(-1).key, 'suns-rest');
    assert.match(h.of('holiday', 2).at(-1).text, /shops are closed/);
    assert.equal(h.s.holidayAt(null, DAGGERFALL), 'suns-rest');
    // Clock event carries the holiday for the HUD.
    h.act(a, 'time.sync');
    assert.equal(h.of('clock', 1).at(-1).holiday.key, 'suns-rest');
    // Merchants' Festival (day 190) halves a Daggerfall shop price.
    h.setMinute(minuteOn(190, 10));
    assert.deepEqual(h.s.holidayPrice('trade', 80, { p: a }), { price: 40, free: false, holiday: 'merchants-festival', rule: 'half' });
    assert.equal(h.s.holidayPrice('trade', 80, { p: a, guildFaction: 40 }).price, 80);
  });

  test('no notice indoors or in the wilderness', () => {
    const h = setup({ minute: minuteOn(200, 9) });
    h.join(1, 'interior:Daggerfall/Gothway Garden/0,0/10');
    h.join(2, 'dungeon:Daggerfall/Privateer\'s Hold');
    h.tick(0.1);
    assert.equal(h.of('holiday').length, 0);
  });
});

describe('legal and unsafe rest', () => {
  test('place kinds', () => {
    assert.equal(placeKind('town:Daggerfall/Daggerfall'), 'town');
    assert.equal(placeKind('interior:Daggerfall/Daggerfall/1,2/3'), 'interior');
    assert.equal(placeKind('dungeon:Daggerfall/X'), 'dungeon');
    assert.equal(placeKind('wilderness:109,160'), 'wilderness');
  });

  test('sleeping in a town street is vagrancy: refused and reported; loitering there is legal', () => {
    const h = setup();
    const a = h.join(1);
    const r = h.act(a, 'rest.start', { hours: 8 });
    assert.equal(r.ok, true, 'the refusal commits so the crime is kept');
    assert.equal(h.s.isResting(a), false);
    const refused = h.of('rest', 1).at(-1);
    assert.equal(refused.state, 'refused');
    assert.equal(refused.reason, 'vagrancy');
    assert.equal(refused.textId, 17);
    assert.ok(h.emitted.some(([k, id, c]) => k === 'crime' && id === 1 && c === 'vagrancy'));
    assert.ok(h.emitted.some(([k, id, c, loc]) => k === 'reportCrime' && id === 1 && c === 'vagrancy' && loc === 'town:Daggerfall/Gothway Garden'));
    const l = h.act(a, 'rest.start', { mode: 'loiter', hours: 2 });
    assert.equal(l.ok, true);
    assert.equal(h.s.isResting(a), true);
  });

  test('inside a town building: only owners, rentals (package 2) and guild members may sleep', () => {
    const portal = (type) => ({ into: () => ({ kind: 'building', meta: { buildingType: type } }) });
    const loc = 'interior:Daggerfall/Gothway Garden/0,0/10';
    let h = setup({ portals: portal(9) });
    let a = h.join(1, loc);
    assert.deepEqual(h.act(a, 'rest.start', { hours: 2 }), { ok: false, error: 'You have not rented a room here.' });
    assert.equal(h.act(a, 'rest.start', { mode: 'loiter', hours: 2 }).ok, true, 'loiter needs no room');

    h = setup({ portals: portal(17), ownsBuilding: (p) => p.id === 1 });
    a = h.join(1, loc);
    const b = h.join(2, loc);
    assert.equal(h.act(a, 'rest.start', { hours: 2 }).ok, true, 'own house');
    assert.equal(h.act(b, 'rest.start', { hours: 2 }).ok, false, 'someone else’s house');

    h = setup({ portals: portal(11), guildCanRest: () => true });
    a = h.join(1, loc);
    assert.equal(h.act(a, 'rest.start', { hours: 2 }).ok, true, 'Fighters Guild hall');
    h = setup({ portals: portal(15), guildCanRest: () => true });
    a = h.join(1, loc);
    assert.equal(h.act(a, 'rest.start', { hours: 2 }).ok, false, 'guild privilege never covers a tavern');
  });

  test('the wilderness and dungeons are legal; a blocker or a threatening monster refuses or ends rest', () => {
    const hostile = new Set();
    const h = setup({ monsterThreatens: (e) => hostile.has(e.id) });
    const a = h.join(1, 'wilderness:109,160');
    h.ctx.entities.set('m1', { id: 'm1', kind: 'monster', location: a.rpg.location, x: 5, z: 0, hp: 10, name: 'Rat' });
    assert.equal(h.act(a, 'rest.start', { hours: 3 }).ok, true, 'a passive monster (monsterThreatens false) does not stop rest');
    h.act(a, 'rest.stop');
    hostile.add('m1');
    assert.match(h.act(a, 'rest.start', { hours: 3 }).error, /enemies nearby \(Rat\)/);
    hostile.clear();
    h.s.preventRest.set('test', (p) => (p.rpg.jailed ? 'You cannot rest in a prison cell.' : null));
    a.rpg.jailed = true;
    assert.equal(h.act(a, 'rest.start', { hours: 3 }).error, 'You cannot rest in a prison cell.');
    a.rpg.jailed = false;
    assert.equal(h.act(a, 'rest.start', { hours: 3 }).ok, true);
    a.rpg.jailed = true;
    h.tick(0.1);
    assert.equal(h.s.isResting(a), false);
    assert.equal(h.of('rest', 1).at(-1).reason, 'prevented');
    const d = h.join(2, 'dungeon:Daggerfall/Privateer\'s Hold');
    assert.equal(h.act(d, 'rest.start', { hours: 1 }).ok, true);
  });
});

describe('encounters while resting', () => {
  test('restEncounter is asked once per rested minute from the rest start; a monster ends the rest before that hour heals', () => {
    let start;
    const h = setup({ restEncounter: (p, m) => (m === start + 60 + 37 ? { id: 'w', name: 'Wolf' } : null) });
    const a = h.join(1, 'wilderness:109,160');
    start = h.s.worldClock().minutes;
    assert.equal(h.act(a, 'rest.start', { hours: 5 }).ok, true);
    h.tick(1); // hour 1: minutes start+1..start+60, no foe
    assert.equal(a.rpg.atmosphere.restedHours, 1);
    const healthAfterOne = a.rpg.character.health;
    h.tick(1); // hour 2: foe at minute 37
    assert.equal(h.s.isResting(a), false);
    const end = h.of('rest', 1).at(-1);
    assert.equal(end.reason, 'encounter');
    assert.match(end.text, /Wolf/);
    assert.equal(a.rpg.character.health, healthAfterOne, 'the interrupted hour recovers nothing');
    assert.equal(a.rpg.atmosphere.restedHours, 1);
    assert.equal(a.rpg.atmosphere.personalMinutes, 60);
    const mins = h.encounterCalls.map(([, m]) => m);
    assert.deepEqual(mins.slice(0, 3), [start + 1, start + 2, start + 3]);
    assert.equal(mins.at(-1), start + 97);
    assert.equal(mins.length, 97);
  });

  test('no encounter rolls in town buildings; loitering in the wilderness can still be interrupted', () => {
    const h = setup({ restEncounter: () => ({ name: 'Bandit' }), ownsBuilding: () => true, portals: { into: () => ({ meta: { buildingType: 17 } }) } });
    const a = h.join(1, 'interior:Daggerfall/Gothway Garden/0,0/10');
    assert.equal(h.act(a, 'rest.start', { hours: 2 }).ok, true);
    h.tick(2.5);
    assert.equal(h.encounterCalls.length, 0);
    assert.equal(h.of('rest', 1).at(-1).reason, 'done');
    const b = h.join(2, 'wilderness:109,160');
    assert.equal(h.act(b, 'rest.start', { mode: 'loiter', hours: 4 }).ok, true);
    h.tick(1);
    assert.equal(h.of('rest', 2).at(-1).reason, 'encounter');
  });
});

describe('personal time and the shared clock', () => {
  test('two players: one rests, one loiters, a third travels; the world clock is the same for all', () => {
    const h = setup();
    const resting = h.join(1, 'wilderness:109,160');
    const waiting = h.join(2, 'wilderness:109,160');
    const traveller = h.join(3, 'town:Daggerfall/Gothway Garden');
    const world0 = h.s.worldClock().minutes;
    assert.equal(h.act(resting, 'rest.start', { hours: 3 }).ok, true);
    assert.equal(h.act(waiting, 'rest.start', { mode: 'loiter', hours: 2 }).ok, true);
    const before = { ...waiting.rpg.character };
    h.tick(1); h.tick(1); h.tick(1);
    assert.equal(h.of('rest', 1).at(-1).reason, 'done');
    assert.equal(h.of('rest', 2).at(-1).reason, 'done');
    assert.match(h.of('rest', 2).at(-1).text, /loitering after 2 hours/);
    assert.equal(resting.rpg.atmosphere.personalMinutes, 180);
    assert.equal(resting.rpg.atmosphere.restedHours, 3);
    assert.ok(resting.rpg.character.health > 10, 'rest heals');
    assert.equal(waiting.rpg.atmosphere.personalMinutes, 120);
    assert.equal(waiting.rpg.atmosphere.restedHours, 0, 'loitering is not rest');
    assert.equal(waiting.rpg.character.health, before.health, 'loitering recovers nothing');
    // Hourly timeSpent with each character's own from/to.
    const spent = h.emitted.filter(([k]) => k === 'timeSpent');
    assert.deepEqual(spent.filter(([, id]) => id === 1).map(([, , r, m]) => [r, m]), [['rest', 60], ['rest', 60], ['rest', 60]]);
    const last1 = spent.filter(([, id]) => id === 1).at(-1)[4];
    assert.equal(last1.to - last1.from, 60);
    assert.equal(last1.to, world0 + 180);

    // Travel: the traveller's own clock moves by the journey; the world's does not.
    assert.equal(h.act(traveller, 'travel.go', { to: 'town:Daggerfall/Daggerfall', options: { speed: 'cautious', lodging: 'camp' } }).ok, true);
    const trip = traveller.rpg.travel.lastTrip;
    assert.ok(trip.minutes > 0);
    assert.equal(traveller.rpg.atmosphere.personalMinutes, trip.minutes);
    assert.ok(h.emitted.some(([k, id, r, m]) => k === 'timeSpent' && id === 3 && r === 'travel' && m === trip.minutes));
    assert.equal(h.s.worldClock().minutes, world0, 'nobody moved the shared clock');
    assert.equal(h.s.playerMinutes(traveller), world0 + trip.minutes);
    assert.equal(h.s.playerMinutes(resting), world0 + 180);
    assert.equal(h.s.playerMinutes(waiting), world0 + 120);
    assert.equal(h.s.playerClock(resting).minutes, world0 + 180);
    // Everyone still reads the same date.
    for (const p of [resting, waiting, traveller]) {
      h.act(p, 'time.sync');
      assert.equal(h.of('clock', p.id).at(-1).minutes, world0);
    }
  });

  test('prison time is personal; release can be computed on the prisoner’s own clock', () => {
    const h = setup();
    const a = h.join(1);
    const b = h.join(2);
    const w = h.s.worldClock().minutes;
    assert.equal(h.s.spendTime(a, 7 * MINUTES_PER_DAY, 'prison'), 7 * MINUTES_PER_DAY);
    assert.equal(h.s.playerMinutes(a), w + 7 * MINUTES_PER_DAY);
    assert.equal(h.s.playerMinutes(b), w);
    assert.equal(h.s.playerClock(a).dayOfYear, dateFromMinutes(w).dayOfYear + 7);
    const ev = h.emitted.find(([k, id, r]) => k === 'timeSpent' && id === 1 && r === 'prison')[4];
    assert.deepEqual([ev.from, ev.to], [w, w + 7 * MINUTES_PER_DAY]);
  });
});

describe('journey interruptions', () => {
  test('no departure with a threatening enemy or while a blocker applies; a journey ends a rest', () => {
    const hostile = new Set(['m1']);
    const h = setup({ monsterThreatens: (e) => hostile.has(e.id) });
    const a = h.join(1);
    h.ctx.entities.set('m1', { id: 'm1', kind: 'monster', location: a.rpg.location, x: 10, z: 0, hp: 5, name: 'Orc' });
    const go = () => h.act(a, 'travel.go', { to: 'town:Daggerfall/Daggerfall' });
    assert.equal(go().error, 'You cannot travel with enemies nearby.');
    assert.equal(a.rpg.location, 'town:Daggerfall/Gothway Garden');
    hostile.clear();
    h.s.preventTravel.set('sun', () => 'The sun would burn you. Wait for nightfall.');
    assert.equal(go().error, 'The sun would burn you. Wait for nightfall.');
    assert.equal(a.rpg.atmosphere.personalMinutes, 0, 'a refused journey costs no time');
    h.s.preventTravel.delete('sun');
    // A player loitering in the street sets off: the wait is broken first, then the journey is charged.
    assert.equal(h.act(a, 'rest.start', { mode: 'loiter', hours: 5 }).ok, true);
    assert.equal(go().ok, true);
    assert.equal(h.s.isResting(a), false);
    assert.equal(h.of('rest', 1).at(-1).reason, 'travel');
    assert.equal(a.rpg.atmosphere.personalMinutes, a.rpg.travel.lastTrip.minutes);
  });
});
