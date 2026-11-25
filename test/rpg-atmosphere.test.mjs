// Shared calendar, regional weather and interruptible rest (server/rpg/atmosphere.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { install, DEFAULTS } from '../server/rpg/atmosphere.js';
import {
  CLASSIC_GAME_START_TIME, dateFromMinutes, formatDate, formatTime, weatherAt, regionOf, isIndoors,
  recoveryPerHour, daylight, sunDirection, worldMinutesAt, MINUTES_PER_DAY, WEATHER,
} from '../client/gameplay/atmosphere/calendar.js';

function fakeCtx() {
  const handlers = { join: [], leave: [], tick: [], actions: new Map(), events: new Map() };
  const notes = [];
  const dirty = new Set();
  const ctx = {
    players: new Map(),
    entities: new Map(),
    services: {},
    onJoin: (fn) => handlers.join.push(fn),
    onLeave: (fn) => handlers.leave.push(fn),
    onTick: (fn) => handlers.tick.push(fn),
    onAction: (verb, fn) => handlers.actions.set(verb, fn),
    on: (name, fn) => { if (!handlers.events.has(name)) handlers.events.set(name, []); handlers.events.get(name).push(fn); },
    emit: (name, payload) => { for (const fn of handlers.events.get(name) ?? []) fn(payload); },
    notify: (p, ev) => notes.push({ id: p.id, ...ev }),
    nearby: () => {},
    dirty: (p) => dirty.add(p.id),
    now: () => 0,
  };
  return {
    ctx, notes, dirty,
    join(p) { ctx.players.set(p.id, p); handlers.join.forEach((f) => f(p)); },
    leave(p) { handlers.leave.forEach((f) => f(p)); ctx.players.delete(p.id); },
    tick(dt) { handlers.tick.forEach((f) => f(dt, 0)); },
    act(p, verb, args) { return handlers.actions.get(verb)(p, args); },
  };
}

const character = () => ({
  race: 'Breton', className: 'Spellsword', level: 1,
  attributes: { Endurance: 60 }, skills: { Medical: 20 },
  health: 10, maxHealth: 40, fatigue: 20, maxFatigue: 120, magicka: 5, maxMagicka: 60,
});
const player = (id, extra = {}) => ({ id, name: `P${id}`, x: 0, z: 0, yaw: 0, moving: false, rpg: { location: 'town:Daggerfall/Gothway Garden', character: character() }, ...extra });

test('calendar: the new-game start is 13:30, 4th of Morning Star, 3E405', () => {
  const d = dateFromMinutes(CLASSIC_GAME_START_TIME);
  assert.equal(d.year, 405);
  assert.equal(d.month, 0);
  assert.equal(d.day, 4);
  assert.equal(formatTime(d), '13:30');
  assert.equal(d.monthName, 'Morning Star');
  assert.equal(d.season, 'Winter');
  assert.match(formatDate(d), /4th of Morning Star, 3E405$/);
});

test('calendar: 30-day months, 12 months, 7-day week roll over exactly', () => {
  const start = dateFromMinutes(CLASSIC_GAME_START_TIME);
  const nextMonth = dateFromMinutes(CLASSIC_GAME_START_TIME + 30 * MINUTES_PER_DAY);
  assert.equal(nextMonth.month, 1);
  assert.equal(nextMonth.day, start.day);
  const nextYear = dateFromMinutes(CLASSIC_GAME_START_TIME + 360 * MINUTES_PER_DAY);
  assert.equal(nextYear.year, 406);
  assert.equal(nextYear.dayOfYear, start.dayOfYear);
  assert.equal(dateFromMinutes(CLASSIC_GAME_START_TIME + 7 * MINUTES_PER_DAY).weekday, (start.weekday + 7) % 7);
  assert.equal(dateFromMinutes(CLASSIC_GAME_START_TIME + MINUTES_PER_DAY).weekday, (start.weekday + 1) % 7);
});

test('world clock runs at 12x from a fixed epoch', () => {
  const epochMs = 1_000_000;
  assert.equal(worldMinutesAt(epochMs, { epochMs }), CLASSIC_GAME_START_TIME);
  assert.equal(worldMinutesAt(epochMs + 5 * 60_000, { epochMs }), CLASSIC_GAME_START_TIME + 60); // 5 real min = 1 game hour
  assert.equal(worldMinutesAt(epochMs - 999, { epochMs }), CLASSIC_GAME_START_TIME);
});

test('daylight and sun follow dawn 06:00 / dusk 18:00', () => {
  assert.equal(daylight(12 * 60), 1);
  assert.equal(daylight(0), 0);
  assert.ok(daylight(6 * 60) > 0 && daylight(6 * 60) < 1);
  assert.ok(sunDirection(8 * 60)[0] > 0, 'morning sun in the east');
  assert.ok(sunDirection(16 * 60)[0] < 0, 'evening sun in the west');
  for (const m of [0, 360, 720, 1080]) assert.ok(Math.abs(Math.hypot(...sunDirection(m)) - 1) < 1e-9);
});

test('weather is deterministic per region and period, seasonal, and absent indoors', () => {
  const a = weatherAt('Daggerfall', CLASSIC_GAME_START_TIME);
  assert.deepEqual(weatherAt('Daggerfall', CLASSIC_GAME_START_TIME + 10), a);
  assert.ok(WEATHER.includes(a.type));
  assert.ok(a.nextChangeMinutes > CLASSIC_GAME_START_TIME);
  // No snow in summer across many periods; snow occurs in winter.
  const summer = CLASSIC_GAME_START_TIME + 160 * MINUTES_PER_DAY; // Sun's Height
  const winter = CLASSIC_GAME_START_TIME;
  const types = (base) => new Set(Array.from({ length: 200 }, (_, i) => weatherAt('Wayrest', base + i * 360).type));
  assert.ok(!types(summer).has('snow'));
  assert.ok(types(winter).has('snow'));
  assert.equal(weatherAt('Daggerfall', winter, 'dungeon:Privateer\'s Hold').type, 'indoors');
  assert.equal(regionOf('town:Daggerfall/Gothway Garden'), 'Daggerfall');
  assert.ok(isIndoors('interior:Daggerfall/The Bat and Barrel'));
  assert.ok(!isIndoors('town:Daggerfall/Gothway Garden'));
});

test('recovery per hour follows the DFU formulas', () => {
  const r = recoveryPerHour(character());
  // floor(60/10)-5 = 1; (20+60)*40/1000 = 3.2 -> floor(4.2) = 4
  assert.equal(r.health, 4);
  assert.equal(r.fatigue, 15);
  assert.equal(r.magicka, 7);
  assert.deepEqual(recoveryPerHour({}), { health: 0, fatigue: 0, magicka: 0 });
});

test('players share the same date; joining sends the clock', () => {
  let wall = DEFAULTS.epochMs + 60 * 60_000; // one real hour → 12 game hours later
  const h = fakeCtx();
  install(h.ctx, { wallNow: () => wall });
  const a = player(1), b = player(2, { rpg: { location: 'town:Daggerfall/Gothway Garden', character: character() } });
  h.join(a); h.join(b);
  const clocks = h.notes.filter((n) => n.kind === 'clock');
  assert.equal(clocks.length, 2);
  assert.equal(clocks[0].minutes, CLASSIC_GAME_START_TIME + 720);
  assert.equal(clocks[0].date, clocks[1].date);
  assert.equal(clocks[0].weather, clocks[1].weather);
  assert.equal(clocks[0].minutesPerSecond, 0.2);
  assert.deepEqual(a.rpg.atmosphere, { restedHours: 0, personalMinutes: 0, lastRestEnded: null });
});

test('resting recovers vitals without advancing the shared clock', () => {
  let wall = DEFAULTS.epochMs;
  const h = fakeCtx();
  install(h.ctx, { wallNow: () => wall });
  const a = player(1), b = player(2);
  h.join(a); h.join(b);
  const before = h.ctx.services.worldClock().minutes;
  h.act(a, 'rest.start', { hours: 3 });
  assert.ok(h.ctx.services.isResting(a));
  assert.throws(() => h.act(a, 'rest.start', { hours: 1 }), /already resting/);
  for (let i = 0; i < 10; i++) h.tick(0.5); // 5 s ≥ 3 × 1.5 s
  assert.ok(!h.ctx.services.isResting(a));
  assert.equal(a.rpg.character.health, 10 + 3 * 4);
  assert.equal(a.rpg.character.fatigue, 20 + 3 * 15);
  assert.equal(a.rpg.character.magicka, 5 + 3 * 7);
  assert.equal(a.rpg.atmosphere.restedHours, 3);
  assert.equal(b.rpg.character.health, 10, 'other players are unaffected');
  assert.equal(h.ctx.services.worldClock().minutes, before, 'world clock did not jump');
  const done = h.notes.find((n) => n.kind === 'rest' && n.state === 'done');
  assert.equal(done.hoursDone, 3);
  assert.ok(h.dirty.has(1));
});

test('rest until healed stops at full vitals and caps at the maximum', () => {
  const h = fakeCtx();
  install(h.ctx, { wallNow: () => DEFAULTS.epochMs, restSecondsPerHour: 0.1 });
  const a = player(1);
  h.join(a);
  h.act(a, 'rest.start', { mode: 'healed' });
  for (let i = 0; i < 100 && h.ctx.services.isResting(a); i++) h.tick(0.1);
  const c = a.rpg.character;
  assert.equal(c.health, c.maxHealth);
  assert.equal(c.fatigue, c.maxFatigue);
  assert.equal(c.magicka, c.maxMagicka);
  assert.throws(() => h.act(a, 'rest.start', { mode: 'healed' }), /already fully rested/);
});

test('rest is refused when unsafe and interrupted by movement, enemies, damage and combat', () => {
  const h = fakeCtx();
  install(h.ctx, { wallNow: () => DEFAULTS.epochMs });
  const a = player(1);
  h.join(a);
  assert.throws(() => h.act(a, 'rest.start', {}), /how many hours/);
  h.ctx.entities.set('rat', { id: 'rat', kind: 'monster', name: 'Rat', location: a.rpg.location, x: 5, z: 5, hp: 3 });
  assert.throws(() => h.act(a, 'rest.start', { hours: 2 }), /enemies nearby/);
  h.ctx.entities.get('rat').hp = 0; // dead monsters do not count
  h.act(a, 'rest.start', { hours: 8 });
  h.ctx.entities.get('rat').hp = 3; // it gets up
  h.tick(0.1);
  assert.ok(!h.ctx.services.isResting(a));
  assert.equal(h.notes.at(-1).state, 'interrupted');
  assert.equal(h.notes.at(-1).reason, 'enemy');
  h.ctx.entities.delete('rat');

  h.act(a, 'rest.start', { hours: 8 });
  a.x = 3;
  h.tick(0.1);
  assert.equal(h.notes.at(-1).reason, 'moved');
  a.x = 0;

  h.act(a, 'rest.start', { hours: 8 });
  a.rpg.character.health -= 2;
  h.tick(0.1);
  assert.equal(h.notes.at(-1).reason, 'attacked');

  h.act(a, 'rest.start', { hours: 8 });
  h.ctx.emit('swing', { playerId: 1, direction: 'down' });
  assert.equal(h.notes.at(-1).reason, 'combat');

  h.act(a, 'rest.start', { hours: 8 });
  h.act(a, 'rest.stop');
  assert.equal(h.notes.at(-1).state, 'done');
  assert.throws(() => h.act(a, 'rest.stop'), /not resting/);

  a.rpg.readied = true;
  assert.throws(() => h.act(a, 'rest.start', { hours: 1 }), /Sheathe/);
  a.rpg.readied = false;
  delete a.rpg.character;
  assert.throws(() => h.act(a, 'rest.start', { hours: 1 }), /Create your character/);
});

test('spendTime records personal time only; clock refreshes on hour and location change', () => {
  let wall = DEFAULTS.epochMs;
  const h = fakeCtx();
  install(h.ctx, { wallNow: () => wall });
  const a = player(1);
  h.join(a);
  const m0 = h.ctx.services.worldClock().minutes;
  assert.equal(h.ctx.services.spendTime(a, 600, 'travel'), 600);
  assert.equal(a.rpg.atmosphere.personalMinutes, 600);
  assert.equal(h.ctx.services.worldClock().minutes, m0);

  const count = () => h.notes.filter((n) => n.kind === 'clock').length;
  const c0 = count();
  h.tick(0.04);
  assert.equal(count(), c0, 'no spam within the same hour');
  a.rpg.location = 'interior:Daggerfall/The Bat and Barrel';
  h.tick(0.04);
  assert.equal(count(), c0 + 1);
  assert.equal(h.notes.at(-1).indoors, true);
  assert.equal(h.notes.at(-1).weather, 'indoors');
  wall += 5 * 60_000; // one game hour
  h.tick(0.04);
  assert.equal(count(), c0 + 2);
  h.leave(a);
});
