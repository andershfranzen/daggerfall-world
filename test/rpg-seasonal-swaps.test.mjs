// Live in-place seasonal texture swaps and authentic Daggerfall Chronicles / DFU
// climate × season weather tables.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  lookFor, lookOf, reskinMesh, isDesertClimate, hasWinterSwap,
} from '../client/world/exterior/season.js';
import { applyClimate } from '../client/world/town.js';
import {
  WEATHER, WEATHER_TABLE, climateWeatherGroup, weatherWeightsFor, weatherAt,
  isSnowFreeClimate, MINUTES_PER_DAY, CLASSIC_GAME_START_TIME,
} from '../client/gameplay/atmosphere/calendar.js';
import {
  install as installServerAtmosphere, DEFAULTS,
  WEATHER_TABLE as SERVER_WEATHER_TABLE,
  climateWeatherGroup as serverClimateGroup,
  weatherWeightsFor as serverWeatherWeightsFor,
} from '../server/rpg/atmosphere.js';
import { CLIMATE } from '../client/gameplay/travel/catalog.js';
import { install as installWilderness } from '../client/gameplay/wilderness.js';
import { createGameplayApi } from '../client/gameplay/api.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };

function makeTownMesh(location, {
  region = 'Daggerfall', name = 'Gothway Garden', regionIndex = 17, locationIndex = 197,
  climateValue = CLIMATE.WOODLANDS, climateBase = 300, winter = false,
} = {}) {
  const pixelVal = winter && climateBase !== 0 ? 240 : 40;
  return {
    kind: 'town',
    name,
    region,
    positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 0, 2]),
    uv: new Float32Array([0, 0, 1, 0, 0, winter && climateBase !== 0 ? 0.5 : 1]),
    atlas: { width: 2, height: 2, pixels: new Uint8Array(16).fill(pixelVal) },
    colliders: { cylinders: [{ x: 1, z: 1, r: 0.5 }] },
    spawn: { x: 0, y: 0, z: 0, yaw: 0 },
    mechanisms: [{ id: 'gate:0', firstTriangle: 0, triangleCount: 1, alternateUv: new Float32Array([winter && climateBase !== 0 ? 0.75 : 0.25, 0]) }],
    look: { winter: !!winter },
    source: {
      townId: location,
      region,
      regionIndex,
      locationIndex,
      longitude: 109 * 128 + 64,
      latitude: (499 - 159) * 128 + 64,
      climate: { value: climateValue, climateBase, groundArchive: climateBase + 2 },
    },
    stats: { climateSwapFallbacks: [] },
  };
}

function makeTownHarness({
  location = 'town:Daggerfall/Gothway Garden',
  region = 'Daggerfall',
  name = 'Gothway Garden',
  climateValue = CLIMATE.WOODLANDS,
  climateBase = 300,
  season = 'Fall',
  weather = 'sunny',
  startTime = 0,
  slowTown = false,
  initialWinter = lookFor(season).winter,
} = {}) {
  const api = createGameplayApi({ send: () => true, applyScene: () => {} });
  api.files = [new File([new Uint8Array(1)], 'MAPS.BSA')];
  let t = startTime;
  const calls = { loadTown: [], loadScenery: [], reskins: [], exteriorLook: [] };
  const state = { season, weather, gate: null };
  api.atmosphere = {
    now: () => ({ minutes: 3067200, date: { season: state.season }, weather: state.weather, indoors: false }),
    get clockKnown() { return false; },
  };
  const renderer = {
    addPass: () => () => {}, setLayers() {}, retain() {}, release() {}, prepareExterior: async () => {},
    reskin(mesh, changed) { calls.reskins.push({ mesh, changed }); return true; },
  };
  api.renderer = renderer;
  api.on('exteriorLook', (ev) => calls.exteriorLook.push(ev));

  const initialTown = makeTownMesh(location, { region, name, climateValue, climateBase, winter: initialWinter });
  const loadTown = async (_files, opts) => {
    calls.loadTown.push({ region: opts.region, location: opts.location, winter: !!opts.winter });
    if (slowTown && state.gate) await state.gate;
    return makeTownMesh(location, {
      region, name, regionIndex: opts.region, locationIndex: opts.location,
      climateValue, climateBase, winter: !!opts.winter,
    });
  };
  const loadScenery = async (_files, _mesh, opts) => {
    calls.loadScenery.push({ winter: !!opts.winter });
    return { billboards: { vertices: new Float32Array(0), count: 0 }, atlas: { width: 1, height: 1, pixels: new Uint8Array(4) } };
  };
  const build = async (o) => ({
    kind: 'wilderness', location: o.location, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
    uv: new Float32Array(6), atlas: { width: 1, height: 1, pixels: new Uint8Array([o.winter ? 255 : 0, 0, 0, 255]) },
    warnings: [], stats: {}, flats: null, sky: { horizon: [0, 0, 0], zenith: [0, 0, 0], index: 16 },
    look: { winter: !!o.winter },
    wilderness: { px: 109, py: 159, datum: 100, towns: [], sites: [], climate: { value: climateValue }, heightAt: () => 0 },
  });
  const loadSky = async (_files, index) => ({
    index, file: `SKY${index}.DAT`, horizon: [0, 0, 0], zenith: [0, 0, 0], width: 1, height: 1, pixels: new Uint8Array(4),
  });

  api._receiveRpg({ type: 'rpg', character: { location } });
  api.town = initialTown;
  installWilderness(api, {
    build, loadTown, loadScenery, loadSky,
    now: () => t,
    fetchFn: async () => new Response('{}', { status: 404 }),
    loadModels: async () => null,
    loadPack: async () => null,
    readCatalog: async () => new Map([[location, { x: 109, y: 159, regionIndex: 17, index: 197 }]]),
  });
  api.emit('scene', initialTown);

  const frames = async (n = 1, step = 1100) => {
    for (let i = 0; i < n; i++) {
      t += step;
      api.emit('frame', { camera: { x: 5, z: -3, yaw: 1.2 }, renderer });
      await settle(5);
    }
  };
  const clock = () => api.emit('event', { kind: 'clock', minutes: 3067200 });
  return { api, initialTown, calls, state, frames, clock, renderer, advance: (ms) => { t += ms; } };
}

describe('live in-place seasonal texture swaps (town & wilderness)', () => {
  test('loaded town swaps Fall → Winter → Spring in place without teleport or empty frame', async () => {
    const h = makeTownHarness({ season: 'Fall' });
    await settle();
    const town = h.initialTown;
    const origPositions = town.positions;
    const origColliders = town.colliders;
    const origSpawn = town.spawn;

    h.clock();
    await h.frames(3);
    assert.equal(h.calls.loadTown.length, 0, 'Fall matches initial town look');

    // Cross into Winter while standing in town.
    h.state.season = 'Winter';
    h.state.weather = 'snow';
    h.clock();
    await h.frames(4);

    assert.equal(h.api.town, town, 'same town mesh reference stays applied');
    assert.equal(town.positions, origPositions, 'geometry positions unchanged');
    assert.equal(town.colliders, origColliders, 'collision cylinders unchanged');
    assert.equal(town.spawn, origSpawn, 'spawn untouched');
    assert.deepEqual(town.look, { winter: true });
    assert.equal(town.atlas.pixels[0], 240, 'winter atlas applied in place');
    assert.equal(town.mechanisms[0].alternateUv[0], 0.75, 'city gate alternate UVs updated');
    assert.equal(h.calls.loadTown.length, 1);
    assert.equal(h.calls.loadTown[0].winter, true);
    assert.equal(h.calls.reskins.length, 1, 'renderer.reskin hook triggered');
    assert.equal(h.calls.reskins[0].mesh, town);
    assert.equal(h.calls.reskins[0].changed.atlas, true);
    assert.equal(h.calls.reskins[0].changed.uv, true);
    assert.equal(h.calls.reskins[0].changed.mechanisms, 1);
    assert.ok(h.calls.loadScenery.some((c) => c.winter === true), 'town flats refreshed for winter');
    assert.equal(h.calls.exteriorLook.at(-1).look.winter, true);

    // Cross out of Winter into Spring while still standing in town.
    h.state.season = 'Spring';
    h.state.weather = 'sunny';
    h.clock();
    await h.frames(4);

    assert.equal(h.api.town, town, 'same town mesh stays applied on thaw');
    assert.deepEqual(town.look, { winter: false });
    assert.equal(town.atlas.pixels[0], 40, 'summer atlas restored in place');
    assert.equal(h.calls.loadTown.length, 2);
    assert.equal(h.calls.loadTown[1].winter, false);
    assert.equal(h.calls.reskins.length, 2);
  });

  test('desert-based climates (climateBase === 0) keep dry ground/buildings and skip redundant rebuilds', async () => {
    // Pure helpers
    assert.equal(isDesertClimate(CLIMATE.DESERT), true);
    assert.equal(isDesertClimate(CLIMATE.DESERT2), true);
    assert.equal(isDesertClimate(CLIMATE.SUBTROPICAL), true);
    assert.equal(isDesertClimate(CLIMATE.WOODLANDS), false);
    assert.equal(isDesertClimate(CLIMATE.MOUNTAIN), false);

    assert.equal(hasWinterSwap({ kind: 'town', source: { climate: { value: 224, climateBase: 0 } } }), false);
    assert.equal(hasWinterSwap({ kind: 'town', source: { climate: { value: 229, climateBase: 0 } } }), false);
    assert.equal(hasWinterSwap({ kind: 'town', source: { climate: { value: 231, climateBase: 300 } } }), true);
    assert.equal(hasWinterSwap({ kind: 'town', source: { climate: { value: 226, climateBase: 100 } } }), true);

    // applyClimate leaves desert base 0 dry in winter
    assert.equal(applyClimate(2, 0, 0, true), 2);
    assert.equal(applyClimate(35, 0, 0, true), 35);
    assert.equal(applyClimate(504, 0, 0, true), 504);
    assert.equal(applyClimate(2, 0, 300, true), 303);

    // Live controller in Sentinel (Subtropical, climateBase === 0)
    const h = makeTownHarness({
      location: 'town:Sentinel/Sentinel',
      region: 'Sentinel',
      name: 'Sentinel',
      climateValue: CLIMATE.SUBTROPICAL,
      climateBase: 0,
      season: 'Fall',
    });
    await settle();
    const beforeAtlas = h.initialTown.atlas;
    h.clock();
    await h.frames(3);
    h.state.season = 'Winter';
    h.clock();
    await h.frames(4);

    assert.deepEqual(h.initialTown.look, { winter: true });
    assert.equal(h.initialTown.atlas, beforeAtlas, 'dry desert atlas kept untouched');
    assert.equal(h.calls.loadTown.length, 0, 'no redundant town rebuild for desert climateBase === 0');
    assert.equal(h.calls.reskins.length, 0, 'no redundant GPU texture upload');
    assert.equal(h.calls.exteriorLook.length, 1);
    assert.deepEqual(h.calls.exteriorLook[0].changed, { uv: false, atlas: false, flats: false, mechanisms: 0 });
  });

  test('race condition: leaving town for an interior mid-reskin aborts and discards stale build', async () => {
    const h = makeTownHarness({ season: 'Fall', slowTown: true });
    await settle();
    h.clock();
    await h.frames(2);

    let release;
    h.state.gate = new Promise((r) => { release = r; });
    h.state.season = 'Winter';
    h.clock();
    await h.frames(3);
    assert.equal(h.api.exterior.stats().season.reskinning, 'town:Daggerfall/Gothway Garden');

    // Player enters an interior while the winter town build is still in flight.
    h.api._receiveRpg({ type: 'rpg', character: { location: 'interior:Daggerfall/Gothway Garden/2,1/15' } });
    h.api.town = { kind: 'interior', positions: new Float32Array(0) };
    h.api.emit('scene', h.api.town);
    await settle(5);
    assert.equal(h.api.exterior.stats().season.reskinning, null, 'in-flight reskin aborted immediately on leaving exterior');

    // Stale build resolves late: must be ignored.
    release();
    await settle(10);
    assert.equal(h.calls.reskins.length, 0, 'renderer.reskin never called for stale build');
    assert.deepEqual(h.initialTown.look, { winter: false }, 'abandoned town was not mutated');
    assert.ok(h.api.exterior.stats().season.discarded >= 1);
  });

  test('race condition: season flipping back mid-reskin discards stale town result', async () => {
    const h = makeTownHarness({ season: 'Fall', slowTown: true });
    await settle();
    h.clock();
    await h.frames(2);

    let release;
    h.state.gate = new Promise((r) => { release = r; });
    h.state.season = 'Winter';
    h.clock();
    await h.frames(3);
    assert.equal(h.api.exterior.stats().season.reskinning, 'town:Daggerfall/Gothway Garden');

    // Season flips back before build finishes.
    h.state.season = 'Fall';
    h.clock();
    await h.frames(3);
    release();
    await settle(10);

    assert.equal(h.calls.reskins.length, 0);
    assert.deepEqual(h.initialTown.look, { winter: false });
    assert.ok(h.api.exterior.stats().season.discarded >= 1);
  });

  test('reskinMesh checks atlas height changes and preserves geometry/colliders', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const target = {
      kind: 'town', positions, uv: new Float32Array(6),
      atlas: { width: 2, height: 1, pixels: new Uint8Array(8).fill(1) },
      look: { winter: false },
    };
    const fresh = {
      kind: 'town', positions: new Float32Array(positions), uv: new Float32Array(6),
      atlas: { width: 2, height: 2, pixels: new Uint8Array(16).fill(1) },
      look: { winter: true },
    };
    const changed = reskinMesh(target, fresh);
    assert.equal(changed.atlas, true);
    assert.equal(target.atlas.height, 2);
    assert.equal(target.positions, positions);
  });

  test('arrival: a town built before the season was known is not shown until it wears the server season', async () => {
    // The shell builds its bootstrap town (Gothway Garden) before joining, always in summer; a winter
    // server then places the player there. No 'frame' events run behind the loading screen: only the
    // arrival gate polls api.exterior.arrival().
    const loc = 'town:Daggerfall/Gothway Garden';
    const h = makeTownHarness({ season: 'Winter', initialWinter: false });
    await settle();
    assert.notEqual(h.api.exterior.arrival(loc).status, 'ready', 'the season is not known yet');
    h.clock();
    let status = null;
    for (let i = 0; i < 40 && (status = h.api.exterior.arrival(loc).status) !== 'ready'; i++) await settle(5);
    assert.equal(status, 'ready');
    assert.deepEqual(h.initialTown.look, { winter: true }, 'winter textures before the first visible frame');
    assert.equal(h.initialTown.atlas.pixels[0], 240);
    assert.equal(h.calls.loadTown.filter((c) => c.winter).length, 1);
  });

  test('arrival: a server that never sends its clock does not hold the loading screen forever', async () => {
    const loc = 'town:Daggerfall/Gothway Garden';
    const h = makeTownHarness({ season: 'Winter', initialWinter: false });
    await settle();
    assert.notEqual(h.api.exterior.arrival(loc).status, 'ready', 'waits for the clock at first');
    h.advance(4000);
    assert.notEqual(h.api.exterior.arrival(loc).status, 'ready', 'still inside the wait');
    h.advance(2000);
    assert.equal(h.api.exterior.arrival(loc).status, 'ready', 'shown as built once the wait is over');
    assert.deepEqual(h.initialTown.look, { winter: false });
  });

  test('arrival: a town already in the season is ready without a rebuild once the clock is known', async () => {
    const loc = 'town:Daggerfall/Gothway Garden';
    const h = makeTownHarness({ season: 'Winter' });
    await settle();
    h.clock();
    let status = null;
    for (let i = 0; i < 40 && (status = h.api.exterior.arrival(loc).status) !== 'ready'; i++) await settle(5);
    assert.equal(status, 'ready');
    assert.equal(h.calls.loadTown.length, 0);
  });

  test('clock event triggers look check even when performance.now() < 1000', async () => {
    const h = makeTownHarness({ season: 'Fall', startTime: 100 });
    await settle();
    h.clock();
    await h.frames(1, 50); // t = 150 (< 1000 ms)
    assert.deepEqual(h.api.exterior.look(), { winter: false }, 'initial look settled immediately on first frame');
  });
});

describe('classic Daggerfall Chronicles / DFU climate × season weather tables', () => {
  const SEASONS = ['Winter', 'Spring', 'Summer', 'Fall'];

  test('every climate × season table row sums to 100 and matches WEATHER length', () => {
    assert.deepEqual(Object.keys(WEATHER_TABLE).sort(), ['Desert', 'Mountains', 'Rainforest', 'Subtropical', 'Swamp', 'Woodlands']);
    assert.equal(SERVER_WEATHER_TABLE, WEATHER_TABLE, 'server re-exports the shared WEATHER_TABLE');
    assert.equal(serverClimateGroup, climateWeatherGroup);
    assert.equal(serverWeatherWeightsFor, weatherWeightsFor);

    for (const [group, bySeason] of Object.entries(WEATHER_TABLE)) {
      for (const season of SEASONS) {
        const w = bySeason[season];
        assert.equal(w.length, WEATHER.length, `${group}.${season} has 7 weather weights`);
        const sum = w.reduce((a, b) => a + b, 0);
        assert.equal(sum, 100, `${group}.${season} sums to 100 (got ${sum})`);
      }
    }
  });

  test('all 10 CLIMATE.PAK codes map to the authentic WeatherTable group', () => {
    assert.equal(climateWeatherGroup(CLIMATE.DESERT), 'Desert');
    assert.equal(climateWeatherGroup(CLIMATE.DESERT2), 'Desert');
    assert.equal(climateWeatherGroup(CLIMATE.MOUNTAIN), 'Mountains');
    assert.equal(climateWeatherGroup(CLIMATE.RAINFOREST), 'Rainforest');
    assert.equal(climateWeatherGroup(CLIMATE.SWAMP), 'Swamp');
    assert.equal(climateWeatherGroup(CLIMATE.SUBTROPICAL), 'Subtropical');
    assert.equal(climateWeatherGroup(CLIMATE.MOUNTAIN_WOODS), 'Woodlands');
    assert.equal(climateWeatherGroup(CLIMATE.WOODLANDS), 'Woodlands');
    assert.equal(climateWeatherGroup(CLIMATE.HAUNTED_WOODLANDS), 'Woodlands');
    assert.equal(climateWeatherGroup(CLIMATE.OCEAN), 'Woodlands');
    assert.equal(climateWeatherGroup(null), 'Woodlands');
  });

  test('snow-free climates (Desert, Desert2, Rainforest, Subtropical) never roll snow in any season', () => {
    const snowFree = [CLIMATE.DESERT, CLIMATE.DESERT2, CLIMATE.RAINFOREST, CLIMATE.SUBTROPICAL];
    for (const climate of snowFree) {
      assert.equal(isSnowFreeClimate(climate), true);
      for (const season of SEASONS) {
        const w = weatherWeightsFor(climate, season);
        assert.equal(w[WEATHER.indexOf('snow')], 0, `climate ${climate} has 0 snow in ${season}`);
      }
      // Sample 500 winter periods across multiple regions
      for (let i = 0; i < 500; i++) {
        const res = weatherAt("Alik'r Desert", CLASSIC_GAME_START_TIME + i * 360, "town:Alik'r Desert/Atriga", climate);
        assert.notEqual(res.type, 'snow', `climate ${climate} rolled snow at period ${i}`);
      }
    }
  });

  test('Desert summer is strictly dry (sunny or cloudy only); Mountains winter gets heavy snow and no rain', () => {
    // 1st of Midyear (day 150) + 300 × 6h (75 days) stays strictly within the 90-day Summer.
    const summerBase = CLASSIC_GAME_START_TIME + 150 * MINUTES_PER_DAY;
    const desertSummer = new Set();
    for (let i = 0; i < 300; i++) {
      desertSummer.add(weatherAt('Sentinel', summerBase + i * 360, 'town:Sentinel/Test', CLIMATE.DESERT).type);
    }
    assert.deepEqual([...desertSummer].sort(), ['cloudy', 'sunny']);

    // Winter in Mountains (35% snow, 0% rain, 0% thunder)
    const winterBase = CLASSIC_GAME_START_TIME; // 4 Morning Star (Winter)
    const counts = Object.fromEntries(WEATHER.map((w) => [w, 0]));
    const N = 200; // 200 × 6h = 50 days (stays inside Morning Star + Sun's Dawn, both Winter)
    for (let i = 0; i < N; i++) {
      const w = weatherAt('Wrothgarian Mountains', winterBase + i * 360, 'town:Wrothgarian Mountains/Peak', CLIMATE.MOUNTAIN);
      counts[w.type]++;
    }
    assert.equal(counts.rain, 0, 'Mountains winter has 0% rain');
    assert.equal(counts.thunder, 0, 'Mountains winter has 0% thunder');
    assert.ok(counts.snow >= 45 && counts.snow <= 95, `Mountains winter snow ~35% (got ${counts.snow}/${N})`);
  });

  test('Swamp has frequent fog; Rainforest has heavy rain; Woodlands snows in winter and is mostly sunny in summer', () => {
    const winterBase = CLASSIC_GAME_START_TIME;
    const summerBase = CLASSIC_GAME_START_TIME + 160 * MINUTES_PER_DAY;
    const sample = (region, base, climate, n = 200) => {
      const c = Object.fromEntries(WEATHER.map((w) => [w, 0]));
      for (let i = 0; i < n; i++) c[weatherAt(region, base + i * 360, 'town:Test/Place', climate).type]++;
      return c;
    };

    const swampWinter = sample('Glenumbra Moors', winterBase, CLIMATE.SWAMP);
    assert.ok(swampWinter.fog >= 25, `Swamp winter fog ~25% (got ${swampWinter.fog}/200)`);
    assert.ok(swampWinter.snow >= 12, `Swamp winter snow ~15% (got ${swampWinter.snow}/200)`);

    const rainSpring = sample('Pothago', CLASSIC_GAME_START_TIME + 70 * MINUTES_PER_DAY, CLIMATE.RAINFOREST);
    assert.ok(rainSpring.rain >= 50, `Rainforest spring rain ~37% (got ${rainSpring.rain}/200)`);
    assert.equal(rainSpring.snow, 0);

    const woodWinter = sample('Daggerfall', winterBase, CLIMATE.WOODLANDS);
    assert.ok(woodWinter.snow >= 25, `Woodlands winter snow ~25% (got ${woodWinter.snow}/200)`);

    const woodSummer = sample('Daggerfall', summerBase, CLIMATE.WOODLANDS);
    assert.equal(woodSummer.snow, 0);
    assert.ok(woodSummer.sunny >= 95, `Woodlands summer sunny ~60% (got ${woodSummer.sunny}/200)`);
  });

  test('server atmosphere uses climate × season tables per player location', () => {
    const notes = [];
    const handlers = { join: [], leave: [], tick: [], actions: new Map(), events: new Map() };
    const climates = new Map([
      ["town:Alik'r Desert/Atriga", CLIMATE.DESERT],
      ["town:Alik'r Desert/Bubyrydata", CLIMATE.MOUNTAIN],
      ['town:Daggerfall/Gothway Garden', CLIMATE.WOODLANDS],
    ]);
    const ctx = {
      players: new Map(),
      entities: new Map(),
      services: {
        travel: {
          climateOf: (loc) => climates.get(loc) ?? null,
          regionOf: (loc) => (loc.includes("Alik'r Desert") ? "Alik'r Desert" : 'Daggerfall'),
        },
      },
      onJoin: (fn) => handlers.join.push(fn),
      onLeave: (fn) => handlers.leave.push(fn),
      onTick: (fn) => handlers.tick.push(fn),
      onAction: (v, fn) => handlers.actions.set(v, fn),
      on: (n, fn) => { if (!handlers.events.has(n)) handlers.events.set(n, []); handlers.events.get(n).push(fn); },
      emit() {},
      notify: (p, ev) => notes.push({ id: p.id, ...ev }),
      dirty() {},
    };
    const atmo = installServerAtmosphere(ctx, { wallNow: () => DEFAULTS.epochMs });

    // Across 200 winter periods in Alik'r Desert, Atriga (Desert) never snows while Bubyrydata (Mountain) does.
    let mountainSnows = 0;
    for (let i = 0; i < 200; i++) {
      const m = CLASSIC_GAME_START_TIME + i * 360;
      const desertW = atmo.weatherFor("town:Alik'r Desert/Atriga", m);
      const mountainW = atmo.weatherFor("town:Alik'r Desert/Bubyrydata", m);
      assert.notEqual(desertW.type, 'snow');
      if (mountainW.type === 'snow') mountainSnows++;
    }
    assert.ok(mountainSnows >= 45, `Mountain in Alik'r Desert snows ~35% in winter (got ${mountainSnows}/200)`);
  });
});
