// Weather follows the political region across the walking seam: a wilderness pixel shares the sky of
// the region POLITIC.PAK puts it in (travel feature), so walking out of Gothway Garden keeps the
// weather. Real runtime with the atmosphere and travel features on the installed ARENA2 (skips
// without gamedata/); cold start and the browser fallback run without data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installAtmosphere, DEFAULTS } from '../server/rpg/atmosphere.js';
import { install as installTravel } from '../server/rpg/travel.js';
import { regionOfPlace } from '../client/gameplay/travel/catalog.js';
import { MINUTES_PER_DAY, MINUTES_PER_YEAR, weatherAt, regionOf } from '../client/gameplay/atmosphere/calendar.js';

const ARENA2 = new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url).pathname;
const skip = existsSync(join(ARENA2, 'MAPS.BSA')) ? false : 'local Daggerfall data not present';
const quiet = { info() {}, warn() {}, error() {} };
const HOME = 'town:Daggerfall/Gothway Garden';

function world({ dataPath, loadWorld } = {}) {
  const players = new Map();
  const events = [];
  let atmo, travel;
  const runtime = createRpgRuntime({
    players, save() {}, log: quiet, dataPath, defaultLocation: HOME,
    send: (p, msg) => msg.type === 'gameEvent' && msg.event.kind === 'clock' && events.push([p.id, msg.event]),
    features: [
      (ctx) => { atmo = installAtmosphere(ctx, { wallNow: () => DEFAULTS.epochMs + 9 * 3600e3 }); },
      (ctx) => { travel = installTravel(ctx, loadWorld ? { loadWorld } : undefined); },
    ],
  });
  const join = (id, location, rpg = {}) => {
    const p = { id, name: `P${id}`, x: 0, z: 0, yaw: 0, rpg: { ...rpg, location } };
    players.set(id, p);
    runtime.join(p);
    return p;
  };
  const clockOf = (p) => { runtime.tick(0.05, 1); return atmo.clockEvent(p); };
  return { runtime, atmo, get travel() { return travel; }, join, clockOf, events };
}

test('installed data: Gothway Garden, its pixel and the neighbouring pixel share region and weather at one time', { skip }, async () => {
  const w = world({ dataPath: ARENA2 });
  await w.travel.ready;
  const town = w.join(1, HOME);
  const own = w.join(2, 'wilderness:109,159');
  const east = w.join(3, 'wilderness:110,159');
  const indoors = w.join(4, 'interior:Daggerfall/Gothway Garden/2,1/15');
  const [a, b, c, d] = [town, own, east, indoors].map(w.clockOf);
  assert.deepEqual([a.region, b.region, c.region, d.region], ['Daggerfall', 'Daggerfall', 'Daggerfall', 'Daggerfall']);
  assert.equal(a.minutes, b.minutes);
  assert.equal(b.weather, a.weather, 'no weather jump across the town edge');
  assert.equal(c.weather, a.weather, 'nor across the pixel edge');
  assert.equal(d.weather, 'indoors');
  assert.equal(b.location, 'wilderness:109,159', 'the clock event names the place it describes');
  // Before: the pixel id itself was the weather key.
  assert.equal(regionOf('wilderness:109,159'), '109,159');
  // A whole season of weather periods agrees, not just this one.
  for (let h = 0; h < 24 * 90; h += 6) {
    const m = DEFAULTS.startMinutes + h * 60;
    assert.equal(w.atmo.weatherFor('wilderness:109,159', m).type, w.atmo.weatherFor(HOME, m).type, `hour ${h}`);
  }
});

test('installed climate suppresses snow in subtropical and desert places, including their wilderness pixels', { skip }, async () => {
  const w = world({ dataPath: ARENA2 });
  await w.travel.ready;
  const sentinel = 'town:Sentinel/Sentinel';
  const atriga = "town:Alik'r Desert/Atriga";
  const mountain = "town:Alik'r Desert/Bubyrydata";
  const winter = MINUTES_PER_YEAR + 344 * MINUTES_PER_DAY;
  assert.equal(w.clockOf(w.join(1, sentinel)).climate, 229, 'the installed climate is subtropical');
  assert.equal(w.clockOf(w.join(2, atriga)).climate, 224, 'the installed climate is desert');
  for (const location of [sentinel, 'wilderness:397,343', atriga, 'wilderness:589,392']) {
    assert.equal(weatherAt(w.travel.service.regionOf(location), winter, location).type, 'snow', 'the regional schedule rolls snow');
    assert.equal(w.atmo.weatherFor(location, winter).type, 'sunny');
  }
  assert.equal(w.atmo.weatherFor(mountain, winter).type, 'snow', 'snow reaches a mountain town in the same political region');
  assert.equal(w.atmo.weatherFor(HOME, 5 * MINUTES_PER_YEAR + 330 * MINUTES_PER_DAY).type, 'snow', 'a winter roll still reaches the woodlands');
});

test('the browser resolves the same region from its own map data', { skip }, async () => {
  const { loadWorldFromDir } = await import('../server/rpg/travel/data.js');
  const data = await loadWorldFromDir(ARENA2);
  for (const id of ['wilderness:109,159', 'wilderness:110,159', 'wilderness:109,160', HOME]) assert.equal(regionOfPlace(id, data), 'Daggerfall', id);
  // Every classic location's own pixel resolves to that location's region.
  const off = data.catalog.locations.filter((e) => regionOfPlace(`wilderness:${e.x},${e.y}`, data) !== e.region);
  assert.equal(off.length, 0, off.slice(0, 3).map((e) => e.id).join(', '));
  assert.equal(regionOfPlace('town:0/272', null), "Alik'r Desert");
  assert.equal(regionOfPlace('wilderness:109,159', null), null, 'unknown until the data loads');
});

test('cold start: while the map loads a wilderness player keeps the last town region, then the political one', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const politic = { atMapPixel: () => 128 + 17 }; // Daggerfall
  const catalog = { atPixel: () => null, get: () => null, size: 1, regions: ['Daggerfall'] };
  const w = world({ dataPath: '/nonexistent', loadWorld: async () => { await gate; return { catalog, politic, climate: null }; } });
  const p = w.join(1, 'wilderness:109,159', { travel: { lastTown: HOME } });
  const before = w.clockOf(p);
  assert.equal(before.region, 'Daggerfall', 'last town region while loading');
  const stranger = w.join(2, 'wilderness:109,159');
  assert.equal(w.clockOf(stranger).region, '109,159', 'no history and no data: the old pixel key, never an error');
  release();
  await w.travel.ready;
  assert.equal(w.clockOf(stranger).region, 'Daggerfall', 'political region once the data has loaded');
  assert.equal(w.clockOf(p).weather, weatherAt('Daggerfall', before.minutes, 'wilderness:109,159').type);
});
