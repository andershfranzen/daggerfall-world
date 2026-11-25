// World of Daggerfall wilderness rendering: shared ground (client/world/wilderness/terrain.js), scene assembly
// (client/world/wilderness/scene.js) and the browser feature (client/gameplay/wilderness.js).
// Synthetic WOODS.WLD fixtures cover the arithmetic; the operator's own ARENA2 and World of Daggerfall tree (git-ignored
// gamedata/) cover a real site when present, and those tests skip otherwise.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, openAsBlob, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  WoodsFile, generateSamples, generateTilemap, applyLocationLoader, sinkOffset, siteTiles, buildGround, sampleAt,
  HDIM, TDIM, HEIGHT_MAX, OCEAN_Y, MAP_WIDTH, MAP_HEIGHT,
} from '../client/world/wilderness/terrain.js';
import { modelMatrix, parseWildernessLocation } from '../client/world/wilderness/scene.js';
import { install, fetchDescriptor, neighbourLocations } from '../client/gameplay/wilderness.js';
import { createGameplayApi } from '../client/gameplay/api.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ARENA2 = join(ROOT, 'gamedata/DaggerfallGameFiles/arena2');
const WOD = join(ROOT, 'gamedata/world-of-daggerfall');
const haveArena = existsSync(join(ARENA2, 'WOODS.WLD'));
const haveWod = existsSync(join(WOD, 'Locations'));

// ------------------------------------------------------------------------------------------------ fixtures

/** A synthetic WOODS.WLD: heightmap from fn(px, py), large map bytes from big(px, py, x, y). */
function fakeWoods(fn, big = () => 0) {
  const N = MAP_WIDTH * MAP_HEIGHT;
  const heightAt = 144 + N * 4;
  const dataAt = heightAt + N;
  const bytes = new Uint8Array(dataAt + N * 47);
  const v = new DataView(bytes.buffer);
  v.setUint32(4, MAP_WIDTH, true);
  v.setUint32(8, MAP_HEIGHT, true);
  v.setUint32(28, heightAt, true);
  for (let i = 0; i < N; i++) {
    const px = i % MAP_WIDTH, py = Math.floor(i / MAP_WIDTH);
    v.setUint32(144 + i * 4, dataAt + i * 47, true);
    bytes[heightAt + i] = fn(px, py);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) bytes[dataAt + i * 47 + 22 + y * 5 + x] = big(px, py, x, y);
  }
  return bytes;
}

let FAKE;
const fake = () => (FAKE ??= fakeWoods((x, y) => (x * 3 + y * 5) % 200, (px, py, x, y) => (px * 7 + py * 11 + x * 13 + y * 17) % 90));

// ------------------------------------------------------------------------------------------------ terrain

test('DFU sampler: neighbouring pixels share their edge samples (east and north seams)', async () => {
  const woods = await WoodsFile.fromBytes(fake());
  const px = 300, py = 200;
  await woods.prefetch([{ px, py }, { px: px + 1, py }, { px, py: py - 1 }]);
  const a = generateSamples(woods, px, py);
  const east = generateSamples(woods, px + 1, py);
  const north = generateSamples(woods, px, py - 1);
  for (let y = 0; y < HDIM; y += 8) assert.ok(Math.abs(sampleAt(a, 128, y) - sampleAt(east, 0, y)) < 1e-6, `east seam y=${y}`);
  for (let x = 0; x < HDIM; x += 8) assert.ok(Math.abs(sampleAt(a, x, 128) - sampleAt(north, x, 0)) < 1e-6, `north seam x=${x}`);
  for (const s of a) assert.ok(s >= 0 && s <= 1);
});

test('DFU sampler: a flat sea pixel clamps to the ocean floor and tiles as water', async () => {
  const woods = await WoodsFile.fromBytes(fakeWoods(() => 0));
  await woods.prefetch([{ px: 10, py: 10 }]);
  const s = generateSamples(woods, 10, 10);
  for (const v of s) assert.ok(Math.abs(v * HEIGHT_MAX - OCEAN_Y) < 0.01 || v * HEIGHT_MAX > OCEAN_Y);
  const tiles = generateTilemap(s, 10, 10);
  const water = tiles.filter((t) => (t & 0x3f) === 0).length;
  assert.ok(water > tiles.length * 0.5, `mostly water tiles (${water}/${tiles.length})`);
});

test('Location Loader: a type-0 rect is flattened to its mean and blended over 10 tiles', () => {
  const s = new Float32Array(HDIM * HDIM);
  for (let x = 0; x < HDIM; x++) for (let y = 0; y < HDIM; y++) s[y + x * HDIM] = (x + y) / 1000;
  const t = { type: 0, tx: 64, ty: 64, halfW: 4, halfH: 3, sink: 0 };
  const before = Float32Array.from(s);
  const [ground] = applyLocationLoader(s, [t]);
  let sum = 0, n = 0;
  for (let y = 61; y <= 67; y++) for (let x = 60; x <= 68; x++) { sum += before[y + x * HDIM]; n++; }
  assert.ok(Math.abs(ground - sum / n) < 1e-7, 'ground is the inclusive rect mean');
  assert.ok(Math.abs(sampleAt(s, 64, 64) - ground) < 1e-7);
  assert.ok(Math.abs(sampleAt(s, 60, 67) - ground) < 1e-7, 'rect corner flattened');
  assert.equal(sampleAt(s, 40, 64), before[64 + 40 * HDIM], 'beyond 10 tiles untouched');
  const mid = sampleAt(s, 73, 64); // 5 tiles out: halfway in smoothstep
  assert.ok(Math.abs(mid - (ground + before[64 + 73 * HDIM]) / 2) < 1e-6);
  assert.equal(sampleAt(s, 0, 64), before[64], 'border samples never touched');
});

test('Location Loader: type-1 sink lowers toward the lowest ground under the rect; sea types stand at the ocean', () => {
  const s = new Float32Array(HDIM * HDIM).fill(0.1);
  s[20 + 20 * HDIM] = 0.09;
  const t = { type: 1, tx: 20, ty: 20, halfW: 2, halfH: 2, sink: 0.5 };
  const g = applyLocationLoader(s, [t])[0];
  const off = sinkOffset(s, t, g);
  assert.ok(off < 0);
  assert.ok(Math.abs(off - ((0.09 - g) * HEIGHT_MAX) * 0.5) < 1e-3);
  assert.deepEqual(siteTiles({ instanceType: 1, tile: { x: 5, y: 6 }, rect: { width: 25.6, depth: 12.8 }, sink: 0.3 }), { type: 1, tx: 5, ty: 6, halfW: 2, halfH: 1, sink: 0.3 });
  assert.deepEqual(siteTiles({ anchor: [-409.6 + 64, 0, 409.6 - 32], rect: { width: 12.8, depth: 12.8 } }), { type: 0, tx: 10, ty: 5, halfW: 1, halfH: 1, sink: 0 });
});

test('ground field: datum is the spawn site, sites are lifted to their Location Loader ground, heightAt matches samples', async () => {
  const woods = await WoodsFile.fromBytes(fake());
  const site = { id: 'wod:300,200:64,64', instanceType: 0, tile: { x: 64, y: 64 }, anchor: [0, 0, 0], rect: { x: -25.6, z: -25.6, width: 51.2, depth: 51.2 } };
  const g = await buildGround(woods, { px: 300, py: 200, sitesByPixel: new Map([['300,200', [site]]]), ring: 1, spawn: { x: 0, z: 30 } });
  assert.equal(g.pixels.size, 9);
  assert.ok(Math.abs(g.siteLift(site.id)) < 1e-9, 'spawn site is y = 0');
  assert.ok(Math.abs(g.heightAt(0, 0)) < 1e-3, 'flattened centre stands at the datum');
  const p = g.pixels.get('300,200');
  // tile corner (10, 20): x = -409.6 + 64, z = 409.6 - 128
  assert.ok(Math.abs(g.heightAt(-409.6 + 64, 409.6 - 128) - (sampleAt(p.samples, 10, 20) * HEIGHT_MAX - g.datum)) < 1e-6);
  // Neighbour to the east is continuous across the seam.
  assert.ok(Math.abs(g.heightAt(409.59, 100) - g.heightAt(409.61, 100)) < 0.05);
  assert.equal(g.heightAt(5000, 0), null);
});

// ------------------------------------------------------------------------------------------------ transforms

test('modelMatrix mirrors Unity model z into the right-handed frame, then rotates, scales and lifts', () => {
  const nested = [0, 0, -2, 0, 0, 3, 0, 0, -4, 0, 0, 0, 10, 20, 30, 1];
  const composed = modelMatrix({ matrix: nested, position: [10, 20, 30] }, 8, { x: 100, z: -50 });
  assert.deepEqual(Array.from(composed), [...nested.slice(0, 12), 110, 28, -20, 1]);
  assert.equal(nested[13], 20, 'the shared descriptor is immutable');
  const m = modelMatrix({ position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [2, 2, 2] }, 5, { x: 10, z: -20 });
  const at = (x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
  assert.deepEqual(at(0, 0, 1), [11, 7, -19]); // Unity +z (north) -> scene -z
  assert.deepEqual(at(1, 0, 0), [13, 7, -17]);
  // 90 degrees about +y in the scene frame maps east (+x) to north (-z).
  const s = Math.SQRT1_2;
  const r = modelMatrix({ position: [0, 0, 0], rotation: [0, s, 0, s], scale: [1, 1, 1] });
  assert.ok(Math.abs(r[0]) < 1e-9 && Math.abs(r[2] + 1) < 1e-9);
  assert.deepEqual(parseWildernessLocation('wilderness:233,131'), { px: 233, py: 131 });
  assert.equal(parseWildernessLocation('wilderness:1000,1'), null);
  assert.equal(parseWildernessLocation('town:Daggerfall/Daggerfall'), null);
  assert.equal(neighbourLocations(0, 0).length, 3);
});

// ------------------------------------------------------------------------------------------------ feature

function fakeApi() {
  const applied = [];
  const api = createGameplayApi({ send: () => true, applyScene: (m) => applied.push(m) });
  api.files = [new File([new Uint8Array(1)], 'WOODS.WLD')];
  return { api, applied };
}
const rpgAt = (api, location) => api._receiveRpg({ type: 'rpg', character: { location } });
const tick = () => new Promise((r) => setTimeout(r, 0));

test('feature: a wilderness location loads through api.setScene and reports loading then ready', async () => {
  const { api, applied } = fakeApi();
  const events = [];
  api.on('wildernessScene', (e) => events.push(e));
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (url.includes('233%2C131')) return new Response(JSON.stringify({ v: 1, id: 'wilderness:233,131', px: 233, py: 131, sites: [] }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const build = async (o) => ({
    kind: 'wilderness', location: o.location, positions: new Float32Array(9), name: 'x', flats: null, sky: null, warnings: [], stats: {},
    wilderness: { px: 233, py: 131, sites: [{ id: 's', name: 'Orc Camp', kind: 'camp', prefab: 'P', pixel: '233,131' }], heightAt: () => 0, climate: {} },
    neighbours: o.neighbours.size,
  });
  rpgAt(api, 'town:Daggerfall/Gothway Garden');
  install(api, { build, fetchFn, loadModels: async () => ({}) });
  rpgAt(api, 'wilderness:233,131');
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(calls.length, 9, 'the pixel and its eight neighbours');
  assert.deepEqual(events.map((e) => e.status), ['loading', 'ready']);
  assert.equal(events[1].site.name, 'Orc Camp');
  assert.equal(applied.length, 1);
  assert.equal(api.town.kind, 'wilderness');
  assert.equal(typeof api.wilderness.heightAt, 'function');
  rpgAt(api, 'town:Daggerfall/Gothway Garden');
  assert.equal(api.wilderness, null, 'leaving drops the wilderness state');
});

test('feature: a load overtaken by another location is cancelled and never applied', async () => {
  const { api, applied } = fakeApi();
  const events = [];
  api.on('wildernessScene', (e) => events.push(e));
  let release;
  const gate = new Promise((r) => { release = r; });
  const signals = [];
  const build = async (o) => {
    signals.push(o.signal);
    await gate;
    return { kind: 'wilderness', location: o.location, positions: new Float32Array(9), warnings: [], stats: {}, wilderness: { px: 1, py: 1, sites: [], heightAt: () => 0 } };
  };
  const fetchFn = async () => new Response('{}', { status: 404 });
  rpgAt(api, 'town:Daggerfall/Gothway Garden');
  install(api, { build, fetchFn, loadModels: async () => null });
  rpgAt(api, 'wilderness:10,10');
  for (let i = 0; i < 5; i++) await tick();
  rpgAt(api, 'town:Daggerfall/Gothway Garden');
  release();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(signals[0].aborted, true, 'the build was told to stop');
  assert.equal(applied.length, 0, 'the stale scene was dropped');
  assert.deepEqual(events.map((e) => e.status), ['loading']);
});

test('feature: data errors are reported once, readably', async () => {
  const { api } = fakeApi();
  const events = [];
  api.on('wildernessScene', (e) => events.push(e));
  const fetchFn = async () => new Response(JSON.stringify({ error: 'World of Daggerfall data is not installed on this server.' }), { status: 503 });
  rpgAt(api, 'town:Daggerfall/Gothway Garden');
  install(api, { build: async () => { throw new Error('unreachable'); }, fetchFn, loadModels: async () => null });
  rpgAt(api, 'wilderness:5,5');
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(events.map((e) => e.status), ['loading', 'error']);
  assert.match(events[1].message, /not installed/);
  rpgAt(api, 'wilderness:5,5');
  await tick();
  assert.equal(events.length, 2, 'a new snapshot in the same location does not retry a failed scene');
  assert.equal(await fetchDescriptor('wilderness:5,5', {
    fetchFn: async () => Response.json({ pack: 'missing' }, { status: 503 }),
  }), null, 'without the mod, overland uses the classic terrain');
  await assert.rejects(fetchDescriptor('wilderness:5,5', { fetchFn: async () => new Response('{"v":1}', { status: 200 }) }), /malformed/);
  assert.equal(await fetchDescriptor('wilderness:5,5', { fetchFn: async () => new Response('', { status: 404 }) }), null);
});

// ------------------------------------------------------------------------------------------------ live operator data

async function arenaFiles() {
  const files = [];
  for (const n of readdirSync(ARENA2)) files.push(new File([await openAsBlob(join(ARENA2, n))], n));
  return files;
}

test('live data: a real World of Daggerfall site is built from ARENA2 with its exact models on Location Loader ground', { skip: !(haveArena && haveWod) && 'operator ARENA2 or World of Daggerfall tree not installed' }, async () => {
  const { createWodStore } = await import('../server/rpg/wilderness/store.js');
  const { composeScene } = await import('../client/world/wilderness/data.js');
  const { buildWildernessScene } = await import('../client/world/wilderness/scene.js');
  const store = createWodStore({ root: WOD, log: { log() {}, info() {}, warn() {}, error() {} } });
  await store.init();
  const px = 233, py = 131;
  const sites = store.sceneSites(px, py);
  assert.ok(sites.length > 0, 'pixel 233,131 has sites in this tree');
  const descriptor = composeScene({ px, py, region: store.regionAt(px, py), sites });
  const files = await arenaFiles();
  const ctrl = { aborted: false };
  const m = await buildWildernessScene({ files, descriptor, signal: ctrl });
  assert.equal(m.kind, 'wilderness');
  assert.equal(m.location, 'wilderness:233,131');
  assert.ok(m.stats.groundTriangles > 30000, 'terrain drawn');
  assert.ok(m.stats.modelInstances > 10, 'site models drawn');
  assert.ok(m.stats.siteFlats > 0);
  assert.equal(m.positions.length, m.uv.length / 2 * 3);
  assert.ok(m.sky && m.sky.width > 0, 'climate sky read');
  assert.equal(m.wilderness.climate.groundArchive % 100, 2);
  // Every drawn site's root lies on the drawn ground at its anchor (flattened rect).
  for (const s of m.wilderness.sites) {
    const d = sites.find((x) => x.id === s.id);
    if (d.instanceType !== 0) continue;
    const h = m.wilderness.heightAt(d.anchor[0], d.anchor[2]);
    assert.ok(Math.abs(h - s.lift) < 0.05, `${s.id}: ground ${h.toFixed(3)} vs root ${s.lift.toFixed(3)}`);
  }
  // Cancellation is honoured between steps.
  await assert.rejects(buildWildernessScene({ files, descriptor, signal: { aborted: true } }), (e) => e.name === 'AbortError');
});

test('live data: a pixel with no site still gets real terrain and nature', { skip: !haveArena && 'operator ARENA2 not installed' }, async () => {
  const { buildWildernessScene } = await import('../client/world/wilderness/scene.js');
  const m = await buildWildernessScene({ files: await arenaFiles(), descriptor: null, location: 'wilderness:420,160' });
  assert.equal(m.wilderness.sites.length, 0);
  assert.equal(m.stats.horizonPixels, 40);
  assert.ok(m.bounds.maxX > 2800 && m.bounds.minZ < -2800, 'distant terrain reaches beyond the former 3×3 cells');
  const { worldFromTown } = await import('../client/gameplay/collision/world.js');
  const collision = worldFromTown(m);
  assert.ok(collision.bounds.maxX < 1230 && collision.bounds.minZ > -1230, 'visual horizon stays out of movement bounds');
  assert.equal(m.wilderness.heightAt(2600, 0), null, 'the visual horizon does not become walkable collision');
  assert.ok(m.stats.groundTriangles > 30000);
  assert.ok(Math.abs(m.wilderness.heightAt(0, 0)) < 1e-6, 'datum is the ground at the spawn');
});

test('Location Loader: a type-1 sink reads every pixel its rect overlaps (LocationHelper.GetOverlappingTerrainSections)', async () => {
  const { overlapSections, sinkOffsetAcross } = await import('../client/world/wilderness/terrain.js');
  const t = { type: 1, tx: 78, ty: 49, halfW: 174, halfH: 165, sink: 1 };
  const secs = overlapSections(t, 615, 325);
  assert.deepEqual([...new Set(secs.map((s) => s.px))].sort(), [614, 615, 616]);
  assert.deepEqual([...new Set(secs.map((s) => s.py))].sort(), [324, 325, 326], 'north offsets move to smaller map rows');
  const own = secs.find((s) => s.px === 615 && s.py === 325);
  assert.deepEqual([own.xMin, own.xMax, own.yMin, own.yMax], [0, 128, 0, 128]);
  const flat = new Float32Array(HDIM * HDIM).fill(0.1);
  const low = Float32Array.from(flat); low[5 + 40 * HDIM] = 0.05; // tile (40, 5) lies in the section x 32..128, y 0..86
  const samplesOf = (x, y) => (x === 614 && y === 324 ? low : flat);
  const off = sinkOffsetAcross(samplesOf, t, 615, 325, 0.1);
  assert.ok(Math.abs(off - (0.05 - 0.1) * HEIGHT_MAX) < 1e-3, 'lowered to the lowest ground in a neighbouring pixel');
});
