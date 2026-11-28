// Classic packages 20/21, renderer part: outdoor scenes take the season's classic look
// (client/world/exterior/season.js) and drawn scenes change in place when the shared clock
// crosses into or out of Winter, without a page reload or per-tick rebuilds.
//
// Pure rules and the controller run on fakes; the installed-data cases need ARENA2 and are
// skipped without it.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lookFor, lookOf, skyIndexFor, reskinMesh, sceneClimate } from '../client/world/exterior/season.js';
import { applyClimate } from '../client/world/town.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };

describe('season rules (DFU ClimateSwaps, TerrainMaterialProvider, DaggerfallSky)', () => {
  test('only Winter changes textures; spring and fall use the summer set', () => {
    assert.deepEqual(lookFor('Winter'), { winter: true });
    for (const s of ['Fall', 'Spring', 'Summer', undefined]) assert.deepEqual(lookFor(s), { winter: false });
    assert.deepEqual(lookOf({}), { winter: false }, 'meshes from before looks count as summer');
  });

  test('winter ground, buildings and nature follow the climate, desert-based climates stay dry', () => {
    // Ground: groundArchive + 1 unless the climate base is desert (0).
    assert.equal(applyClimate(302, 0, 300, true), 303, 'woodlands ground snows');
    assert.equal(applyClimate(102, 0, 100, true), 103, 'mountain ground snows');
    assert.equal(applyClimate(402, 0, 400, true), 403, 'swamp and rainforest ground snows (TerrainMaterialProvider: only Desert type is skipped)');
    assert.equal(applyClimate(2, 0, 0, true), 2, 'desert and subtropical ground stays');
    // Nature: only woodland, hills, haunted and mountain sets have winter flats.
    for (const a of [504, 506, 508, 510]) assert.equal(applyClimate(a, 0, 300, true), a + 1);
    for (const a of [500, 501, 502, 503]) assert.equal(applyClimate(a, 0, 400, true), a);
    // Buildings: a snow set gets its winter variant, a non-snow set and desert do not.
    assert.equal(applyClimate(2, 0, 300, true), 303);
    assert.equal(applyClimate(2, 0, 0, true), 2);
    assert.equal(applyClimate(2, 0, 300, false), 302);
  });

  test('day sky: SkyBase + season, rain sky for fog, rain and thunder, snow sky for snow', () => {
    assert.equal(skyIndexFor(231, 'Fall', 'sunny'), 16, 'package 20 before: SKY16');
    assert.equal(skyIndexFor(231, 'Winter', 'snow', 'x') >= 22 && skyIndexFor(231, 'Winter', 'snow', 'x') <= 23, true, 'package 20 after: snow sky');
    assert.equal(skyIndexFor(231, 'Winter', 'sunny'), 19);
    assert.equal(skyIndexFor(231, 'Winter', 'overcast'), 19, 'overcast keeps the season sky (WeatherManager.SetOvercast)');
    assert.ok([20, 21].includes(skyIndexFor(231, 'Summer', 'rain', 'a')));
    assert.ok([20, 21].includes(skyIndexFor(231, 'Summer', 'fog', 'a')));
    assert.ok([4, 5].includes(skyIndexFor(226, 'Summer', 'thunder', 'a')), 'mountain base 0');
    assert.equal(skyIndexFor(224, 'Winter', 'sunny'), 11, 'a desert winter keeps a desert sky');
    assert.equal(skyIndexFor(229, 'Winter', 'sunny'), 27, 'subtropical');
    assert.equal(skyIndexFor(231, 'Winter', 'snow', 'k'), skyIndexFor(231, 'Winter', 'snow', 'k'), 'stable for every player');
  });

  test('reskin keeps the mesh, positions and collision data and swaps only textures', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const colliders = { cylinders: [1] };
    const target = {
      kind: 'wilderness', positions, uv: new Float32Array(6), atlas: { width: 1, height: 1, pixels: new Uint8Array([1, 1, 1, 1]) },
      colliders, wilderness: { climate: { value: 231, groundArchive: 302 } }, flats: { billboards: { vertices: new Float32Array([1]), count: 1 }, atlas: { pixels: new Uint8Array([1]) } },
      mechanisms: [{ id: 'gate:0', alternateUv: new Float32Array([0]) }], look: { winter: false },
    };
    const fresh = {
      ...target, positions: new Float32Array(positions), atlas: { width: 1, height: 1, pixels: new Uint8Array([9, 9, 9, 9]) },
      wilderness: { climate: { value: 231, groundArchive: 303 } }, flats: { billboards: { vertices: new Float32Array([2]), count: 1 }, atlas: { pixels: new Uint8Array([2]) } },
      mechanisms: [{ id: 'gate:0', alternateUv: new Float32Array([5]) }], look: { winter: true },
    };
    const changed = reskinMesh(target, fresh);
    assert.deepEqual(changed, { uv: false, atlas: true, flats: true, mechanisms: 1 });
    assert.equal(target.positions, positions, 'same positions array');
    assert.equal(target.colliders, colliders, 'collision untouched');
    assert.equal(target.atlas.pixels[0], 9);
    assert.equal(target.wilderness.climate.groundArchive, 303);
    assert.deepEqual(target.look, { winter: true });
    assert.equal(sceneClimate(target), 231);
    // Different geometry: nothing changes.
    const before = target.atlas;
    assert.equal(reskinMesh(target, { ...fresh, positions: new Float32Array(3), atlas: { width: 1, height: 1, pixels: new Uint8Array(4) } }), null);
    assert.equal(target.atlas, before);
  });
});

// ------------------------------------------------------------------ controller

function makeHarness({ season = 'Fall', weather = 'sunny', failFirst = false, slow = false } = {}) {
  return import('../client/gameplay/wilderness.js').then(async ({ install }) => {
    const { createGameplayApi } = await import('../client/gameplay/api.js');
    const api = createGameplayApi({ send: () => true, applyScene: () => {} });
    api.files = [new File([new Uint8Array(1)], 'WOODS.WLD')];
    let t = 0;
    const calls = { builds: [], skies: [], reskins: [] };
    const state = { season, weather, fail: failFirst, gate: null };
    api.atmosphere = { now: () => ({ minutes: 3067200, date: { season: state.season }, weather: state.weather, indoors: false }) };
    const renderer = {
      addPass: () => () => {}, setLayers() {}, retain() {}, release() {}, prepareExterior: async () => {},
      reskin(mesh, changed) { calls.reskins.push({ mesh, changed }); return true; },
    };
    api.renderer = renderer;
    const build = async (o) => {
      calls.builds.push({ location: o.location, winter: o.winter });
      if (slow && state.gate) await state.gate;
      if (state.fail) { state.fail = false; throw new Error('disk hiccup'); }
      const py = Number(o.location.split(',')[1]);
      return {
        kind: 'wilderness', location: o.location, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, py]), uv: new Float32Array(6),
        atlas: { width: 1, height: 1, pixels: new Uint8Array([o.winter ? 255 : 0, 0, 0, 255]) }, warnings: [], stats: {},
        flats: null, sky: { horizon: [0, 0, 0], zenith: [0, 0, 0], index: 16 }, look: { winter: !!o.winter },
        wilderness: { px: 109, py, datum: 100, towns: [], sites: [], climate: { value: 231 }, heightAt: () => 0 },
      };
    };
    const loadSky = async (files, index) => { calls.skies.push(index); return { index, file: `SKY${index}.DAT`, horizon: [index / 32, 0, 0], zenith: [0, 0, 0], width: 1, height: 1, pixels: new Uint8Array(4) }; };
    api._receiveRpg({ type: 'rpg', character: { location: 'wilderness:109,159' } });
    install(api, { build, loadSky, now: () => t, fetchFn: async () => new Response('{}', { status: 404 }), loadModels: async () => null, loadPack: async () => null });
    await settle();
    const frames = async (n = 1, step = 1100) => {
      for (let i = 0; i < n; i++) { t += step; api.emit('frame', { camera: { x: 0, z: 0 }, renderer }); await settle(5); }
    };
    return { api, calls, state, frames, clock: () => api.emit('event', { kind: 'clock', minutes: 3067200 }) };
  });
}

describe('exterior controller: the drawn scene follows the season in place', () => {
  test('Fall to Winter at the boundary: same mesh, winter textures, one rebuild, no per-tick work', async () => {
    const h = await makeHarness({ season: 'Fall' });
    const scene = h.api.town;
    assert.equal(scene?.location, 'wilderness:109,159');
    h.clock();
    await h.frames(3);
    assert.equal(h.calls.builds.length, 1, 'Fall: the built scene already matches');
    assert.deepEqual(h.calls.skies, [16], 'Fall woodland sky SKY16');
    h.state.season = 'Winter';
    h.state.weather = 'snow';
    await h.frames(4);
    assert.equal(h.api.town, scene, 'the same scene object stays applied: positions, ground and collision are kept');
    assert.deepEqual(scene.look, { winter: true });
    assert.equal(scene.atlas.pixels[0], 255, 'winter atlas');
    assert.equal(h.calls.reskins.length, 1);
    assert.equal(h.calls.reskins[0].mesh, scene);
    assert.ok([22, 23].includes(h.calls.skies.at(-1)), 'snow sky');
    const builds = h.calls.builds.length;
    await h.frames(10);
    assert.equal(h.calls.builds.length, builds, 'no further builds while the season holds');
    assert.equal(h.calls.reskins.length, 1);
    const s = h.api.exterior.stats().season;
    assert.equal(s.reskinned, 1);
    assert.deepEqual(s.drawn, [{ key: 'wilderness:109,159', winter: true }]);
  });

  test('a late clock packet: nothing changes on a guessed season, the shared clock decides', async () => {
    const h = await makeHarness({ season: 'Winter' });
    // Built with the local estimate (winter); before the clock event the look is not enforced.
    await h.frames(3);
    assert.equal(h.calls.reskins.length, 0);
    h.state.season = 'Fall'; // the server's clock arrives and says Fall
    h.clock();
    await h.frames(4);
    assert.deepEqual(h.api.town.look, { winter: false }, 'corrected in place once the clock is known');
    assert.equal(h.calls.reskins.length, 1);
  });

  test('a season that flips back before the build finishes never shows the stale look', async () => {
    const h = await makeHarness({ season: 'Fall', slow: true });
    h.clock();
    await h.frames(2);
    let release;
    h.state.gate = new Promise((r) => { release = r; });
    h.state.season = 'Winter';
    await h.frames(3);
    assert.equal(h.api.exterior.stats().season.reskinning, 'wilderness:109,159');
    h.state.season = 'Fall';
    await h.frames(3);
    release();
    await settle();
    await h.frames(2);
    assert.deepEqual(h.api.town.look, { winter: false });
    assert.equal(h.calls.reskins.length, 0, 'the abandoned winter build was discarded');
    assert.ok(h.api.exterior.stats().season.discarded >= 1);
  });

  test('a failed seasonal build keeps the old look and retries later, not every tick', async () => {
    const h = await makeHarness({ season: 'Fall' });
    h.clock();
    await h.frames(2);
    h.state.fail = true;
    h.state.season = 'Winter';
    await h.frames(4);
    assert.deepEqual(h.api.town.look, { winter: false });
    const after = h.calls.builds.length;
    await h.frames(5);
    assert.equal(h.calls.builds.length, after, 'waits before retrying');
    await h.frames(15, 1500);
    assert.deepEqual(h.api.town.look, { winter: true }, 'recovered');
    assert.equal(h.api.exterior.stats().season.failed, 1);
  });

  test('a place change: cached scenes nobody draws are dropped, the new place is built in the current look', async () => {
    const h = await makeHarness({ season: 'Fall' });
    h.clock();
    await h.frames(2);
    await h.api.exterior.load('wilderness:109,158');
    h.state.season = 'Winter';
    await h.frames(4);
    assert.ok(!h.api.exterior.stats().cache.keys.includes('wilderness:109,158'), 'stale cached neighbour dropped');
    h.api._receiveRpg({ type: 'rpg', character: { location: 'wilderness:109,158' } });
    await settle();
    await h.frames(3);
    assert.equal(h.api.town.location, 'wilderness:109,158');
    assert.deepEqual(h.api.town.look, { winter: true });
    assert.equal(h.calls.builds.filter((b) => b.location === 'wilderness:109,158').at(-1).winter, true);
  });
});

// ------------------------------------------------------------------ installed ARENA2

const root = fileURLToPath(new URL('..', import.meta.url));
const ARENA2 = [process.env.ARENA2_DIR, process.env.DFW_ARENA2, root + 'gamedata/DaggerfallGameFiles/arena2', root + 'gamedata/DaggerfallGameFiles/ARENA2']
  .filter(Boolean)
  .find((d) => existsSync(d));

describe('installed ARENA2: winter and summer builds of one place', { skip: !ARENA2 && 'ARENA2 is not installed' }, () => {
  let files, loadTown, buildWildernessScene;
  before(async () => {
    ({ arena2Files: files } = await import('../server/rpg/collision/arena2.js'));
    files = await files(ARENA2);
    ({ loadTown } = await import('../client/world/town.js'));
    ({ buildWildernessScene } = await import('../client/world/wilderness/scene.js'));
  });

  test('woodland pixel: ground 302 -> 303 and nature 504 -> 505 with identical geometry', async () => {
    const at = 'wilderness:109,159';
    const fall = await buildWildernessScene({ files, location: at, worldData: null, season: 'fall', winter: false });
    const winter = await buildWildernessScene({ files, location: at, worldData: null, season: 'winter', winter: true });
    assert.equal(fall.wilderness.climate.groundArchive, 302);
    assert.equal(winter.wilderness.climate.groundArchive, 303);
    assert.equal(winter.wilderness.climate.natureArchive, 505);
    assert.deepEqual(winter.look, { winter: true });
    const target = { ...fall };
    const changed = reskinMesh(target, winter);
    assert.ok(changed && changed.atlas, 'atlas changed in place');
    assert.equal(target.positions, fall.positions);
  });

  test('Gothway Garden (woodlands): winter roofs and ground, same geometry and collision cylinders', async () => {
    const summer = await loadTown(files, { region: 17, location: 197, worldData: null });
    const winter = await loadTown(files, { region: 17, location: 197, worldData: null, winter: true });
    assert.deepEqual(summer.look, { winter: false });
    assert.deepEqual(winter.look, { winter: true });
    assert.equal(summer.positions.length, winter.positions.length);
    assert.ok(summer.positions.every((v, i) => v === winter.positions[i]), 'geometry identical');
    assert.deepEqual(summer.colliders?.cylinders?.length, winter.colliders?.cylinders?.length);
    assert.ok(!summer.atlas.pixels.every((v, i) => v === winter.atlas.pixels[i]), 'winter textures differ');

    // Live in-place reskin: Summer -> Winter -> Summer preserves positions & colliders while swapping atlas/UVs.
    const live = { ...summer };
    const origPos = live.positions;
    const origColliders = live.colliders;
    const toWinter = reskinMesh(live, winter);
    assert.ok(toWinter && toWinter.atlas, 'in-place summer -> winter swaps atlas');
    assert.deepEqual(live.look, { winter: true });
    assert.equal(live.positions, origPos, 'geometry buffer preserved');
    assert.equal(live.colliders, origColliders, 'collision preserved');
    assert.ok(live.atlas.pixels.every((v, i) => v === winter.atlas.pixels[i]), 'live atlas now matches winter');

    const toSummer = reskinMesh(live, summer);
    assert.ok(toSummer && toSummer.atlas, 'in-place winter -> summer swaps atlas back');
    assert.deepEqual(live.look, { winter: false });
    assert.equal(live.positions, origPos);
    assert.ok(live.atlas.pixels.every((v, i) => v === summer.atlas.pixels[i]), 'live atlas restored to summer');
  });

  test('a subtropical town (Sentinel) keeps its summer look in winter', async () => {
    const { readCatalog } = await import('../client/gameplay/travel/catalog.js');
    const maps = files.find((f) => /MAPS\.BSA$/i.test(f.name));
    const entry = (await readCatalog(maps)).get('town:Sentinel/Sentinel');
    assert.ok(entry, 'Sentinel is in MAPS.BSA');
    const summer = await loadTown(files, { region: entry.regionIndex, location: entry.index, worldData: null });
    assert.equal(summer.source.climate.climateBase, 0, 'desert-based climate');
    const winter = await loadTown(files, { region: entry.regionIndex, location: entry.index, worldData: null, winter: true });
    assert.ok(summer.atlas.pixels.every((v, i) => v === winter.atlas.pixels[i]), 'no snow in a snow-free climate');
  });
});
