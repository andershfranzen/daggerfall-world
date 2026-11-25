// Brief D (docs/world-expansion-plan.md): the exterior stream's cache, composition plan and
// frame shifts, with fake builders. The live route runs in the browser (progress report).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExteriorStream, PREFETCH_EDGE } from '../client/world/exterior/stream.js';
import { Renderer } from '../client/render/renderer.js';

import { PIXEL, HALF, townFrame, townMeshOffset } from '../client/world/exterior/frame.js';
import { groundFor, offsetGround } from '../client/lib/ground.js';
import { Predictor } from '../client/lib/motion.js';

const GOTHWAY = 'town:Daggerfall/Gothway Garden';
const HOLD = "town:Daggerfall/Privateer's Hold";
const placement = {
  [GOTHWAY]: { id: GOTHWAY, px: 109, py: 159, regionIndex: 17, index: 197, width: 4, height: 3, custom: false, origin: { x: 32, y: 40 }, elevation: 491.248 },
  [HOLD]: { id: HOLD, px: 109, py: 158, regionIndex: 17, index: 179, width: 1, height: 1, custom: true, origin: { x: 72, y: 55 }, elevation: 202.617 },
};
const datum = { '109,159': 491.21, '109,158': 192.12, '110,159': 500.5, '108,159': 480 };
const tick = () => new Promise((r) => setTimeout(r, 0));
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await tick(); };

function fixture({ slow = new Set(), limits } = {}) {
  const built = [];
  const evicted = [];
  const gates = new Map();
  let clock = 0;
  const stream = new ExteriorStream({
    limits,
    now: () => clock,
    async buildWild(key, ctrl) {
      built.push(key);
      if (slow.has(key)) await new Promise((r) => gates.set(key, r));
      if (ctrl.aborted) throw Object.assign(new Error('x'), { name: 'AbortError' });
      const [px, py] = key.slice(11).split(',').map(Number);
      const towns = Object.values(placement).filter((t) => Math.abs(t.px - px) <= 1 && Math.abs(t.py - py) <= 1);
      return { kind: 'wilderness', location: key, positions: new Float32Array(9), wilderness: { px, py, datum: datum[`${px},${py}`] ?? 300, towns, heightAt: () => 0 } };
    },
    async buildTown(key, p) {
      built.push(key);
      if (slow.has(key)) await new Promise((r) => gates.set(key, r));
      return { kind: 'town', name: key, positions: new Float32Array(9), source: { spawnLocal: key === GOTHWAY ? { x: 257.6, z: 180.8 } : { x: 40, z: 60 } } };
    },
    townPixel: (id) => placement[id] && { px: placement[id].px, py: placement[id].py },
    onEvict: (mesh, key) => evicted.push(key),
  });
  return { stream, built, evicted, gates, advance: (ms) => { clock += ms; } };
}

test('exterior buffers publish together, are reused on entry and are released on cancellation', async () => {
  const r = Object.create(Renderer.prototype);
  const freed = [];
  Object.assign(r, { gpu: new Map(), dungeonPoses: new WeakMap(), contextVersion: 1, lost: false,
    buffer: data => ({ data }), gl: { deleteBuffer: b => freed.push(b) } });
  const pixel = { positions: new Float32Array(9), uniformColor: [1, 1, 1] };
  const work = r.uploadParts(pixel);
  work.next();
  assert.equal(r.gpu.has(pixel), false);
  work.return();
  assert.equal(freed.length, 1);
  assert.equal(r.gpu.has(pixel), false);
  await r.prepareExterior(pixel, { aborted: false });
  const uploaded = r.gpu.get(pixel);
  assert.equal(uploaded.col, null);
  assert.equal(uploaded.bytes, 3 * 24);
  assert.equal(r.upload(pixel), uploaded);

  const painted = r.upload({ positions: pixel.positions, colors: new Float32Array(9).fill(0.5) });
  assert.ok(painted.col);
  assert.equal(painted.bytes, 3 * 36);
});

test('a town drawn in its pixel and the pixel drawn around the town use townMeshOffset both ways', async () => {
  const { stream } = fixture();
  await stream.request('wilderness:109,159');
  await stream.request(GOTHWAY);
  const wild = stream.ready('wilderness:109,159'), town = stream.ready(GOTHWAY);
  const fromWild = stream.offset(GOTHWAY, 'wilderness:109,159');
  const expected = townMeshOffset(placement[GOTHWAY], town.source, wild.wilderness);
  assert.deepEqual(fromWild.map((v) => +v.toFixed(6)), [expected.x, expected.y, expected.z].map((v) => +v.toFixed(6)));
  const fromTown = stream.offset('wilderness:109,159', GOTHWAY);
  fromWild.forEach((v, i) => assert.ok(Math.abs(v + fromTown[i]) < 1e-9));
  // A point at the town gate is the same absolute spot in either frame.
  const f = townFrame({ ...placement[GOTHWAY], spawnLocal: town.source.spawnLocal });
  const gate = { x: 10, z: f.walk.minZ };
  const shift = stream.crossing(GOTHWAY, 'wilderness:109,159');
  assert.ok(Math.abs(gate.x + shift.x - (gate.x + f.dx)) < 1e-9 && Math.abs(gate.z + shift.z - (gate.z + f.dz)) < 1e-9);
  assert.equal(shift.provisional, false);
  const back = stream.crossing('wilderness:109,159', GOTHWAY);
  assert.ok(Math.abs(shift.x + back.x) < 1e-9 && Math.abs(shift.y + back.y) < 1e-9 && Math.abs(shift.z + back.z) < 1e-9);
});

test('plans: a pixel draws its towns; a town draws its pixel and the neighbouring town, never itself', async () => {
  const { stream } = fixture();
  let plan = stream.plan('wilderness:109,159');
  assert.deepEqual([...plan.need.keys()], ['wilderness:109,159']);
  await stream.request('wilderness:109,159');
  plan = stream.plan('wilderness:109,159');
  assert.deepEqual([...plan.need.keys()].sort(), ['wilderness:109,159', GOTHWAY, HOLD].sort());
  await stream.request(GOTHWAY); await stream.request(HOLD);
  plan = stream.plan('wilderness:109,159');
  assert.deepEqual(plan.layers.map((l) => l.key).sort(), [GOTHWAY, HOLD].sort());
  plan = stream.plan(GOTHWAY);
  assert.deepEqual(plan.layers.map((l) => l.key).sort(), ['wilderness:109,159', HOLD].sort());
  assert.ok(!plan.layers.some((l) => l.key === GOTHWAY), 'no duplicate of the current town');
});

test('walking toward a pixel edge prefetches that pixel (and both at a corner) without drawing it', async () => {
  const { stream } = fixture();
  await stream.request('wilderness:109,159');
  const plan = stream.plan('wilderness:109,159', { x: HALF - PREFETCH_EDGE / 2, z: -HALF + 10 });
  const need = [...plan.need.keys()];
  for (const k of ['wilderness:110,159', 'wilderness:109,158', 'wilderness:110,158']) assert.ok(need.includes(k), k);
  assert.ok(!need.includes('wilderness:108,159'));
  await stream.request('wilderness:110,159');
  assert.ok(!stream.plan('wilderness:109,159').layers.some((l) => l.key === 'wilderness:110,159'));
});

test('pixel crossings: a ready destination shifts exactly; a loading one is provisional in height', async () => {
  const { stream } = fixture();
  await stream.request('wilderness:109,159');
  const cold = stream.crossing('wilderness:109,159', 'wilderness:110,159');
  assert.ok(Math.abs(cold.x + PIXEL) < 1e-6 && cold.y === 0 && cold.z === 0 && cold.provisional === true);
  await stream.request('wilderness:110,159');
  const warm = stream.crossing('wilderness:109,159', 'wilderness:110,159');
  assert.ok(Math.abs(warm.y - (491.21 - 500.5)) < 1e-9 && warm.provisional === false);
  assert.equal(stream.crossing('wilderness:109,159', 'wilderness:120,159'), null, 'not adjacent: fast travel resets');
  // The predictor keeps its history in the new frame: no reconcile snap afterwards.
  const p = new Predictor();
  p.reset(409, 5);
  p.update(1, 0, Math.PI / 2, 0.05, 0);
  p.shift(warm.x, warm.z);
  assert.ok(Math.abs(p.x - (409.2 - PIXEL)) < 1e-9);
  p.reconcile(409.2 - PIXEL + 0.01, 5, 0.01);
  assert.ok(Math.abs(p.renderX - (409.2 - PIXEL)) < 0.05, 'a server position in the new frame reconciles smoothly');
});

test('a slow destination keeps the request order: current place first, stale results dropped', async () => {
  const { stream, built, gates } = fixture({ slow: new Set(['wilderness:110,159']) });
  stream.request('wilderness:110,159', 0.5); // a prefetch starts
  stream.request('wilderness:109,158', 0);
  stream.request('wilderness:108,159', 3);
  await settle();
  assert.deepEqual(built, ['wilderness:110,159']);
  stream.cancelExcept(new Set(['wilderness:108,159', 'wilderness:109,158']));
  gates.get('wilderness:110,159')();
  await settle();
  assert.equal(stream.ready('wilderness:110,159'), null, 'a cancelled build is never stored');
  assert.equal(stream.stats().discarded + stream.stats().cancelled >= 1, true);
  assert.deepEqual(built.slice(1), ['wilderness:108,159', 'wilderness:109,158'], 'the current place builds before the prefetch');
});

test('ten round trips over a town gate and two pixel edges return the cache to its bound', async () => {
  const { stream, evicted, advance } = fixture({ limits: { wild: 3, town: 2 } });
  const route = ['wilderness:108,159', 'wilderness:109,159', GOTHWAY, 'wilderness:109,159', 'wilderness:110,159', 'wilderness:111,159', 'wilderness:110,159', 'wilderness:109,159'];
  for (let trip = 0; trip < 10; trip++) {
    for (const loc of route) {
      await stream.request(loc, 3);
      for (let i = 0; i < 3; i++) {
        const plan = stream.plan(loc, { x: 0, z: 0 });
        stream.pin(plan.need.keys());
        await Promise.all([...plan.need].map(([k, p]) => stream.request(k, p).catch(() => null)));
      }
      advance(1000);
      const s = stream.stats();
      assert.ok(s.wild <= Math.max(3, [...stream.pinned].filter((k) => k.startsWith('wilderness:')).length));
      assert.ok(s.town <= Math.max(2, [...stream.pinned].filter((k) => k.startsWith('town:')).length));
    }
  }
  assert.ok(evicted.length > 0, 'eviction ran');
  // Stand still beyond the idle interval: only what the view pins remains.
  stream.pin(['wilderness:109,159']);
  advance(60000);
  stream.enforce(true);
  const s = stream.stats();
  assert.deepEqual(s.keys, ['wilderness:109,159']);
  assert.equal(s.loading + s.queued, 0);
});

test('shared ground: wilderness terrain is answered by its sampler, and an offset view agrees with the original', () => {
  // Two terrain triangles and one roof triangle 3 m up.
  const tri = (y, x0 = 0) => [x0, y, 0, x0 + 4, y, 0, x0, y, 4];
  const positions = new Float32Array([...tri(0), ...tri(0, 4), ...tri(3)]);
  const mesh = { kind: 'wilderness', positions, ground: { included: true, firstTriangle: 0, triangleCount: 2 }, wilderness: { heightAt: () => 0.5 } };
  const g = groundFor(mesh);
  assert.equal(groundFor(mesh), g, 'built once per mesh');
  assert.equal(g.heightAt(1, 1, null), 0.5, 'terrain from the sampler');
  assert.equal(g.heightAt(1, 1, 2.9), 3, 'the roof is still a surface');
  const o = offsetGround(g, [100, -10, 50]);
  assert.equal(o.heightAt(101, 51, 2.9 - 10), 3 - 10);
  assert.equal(o.heightAt(101, 51, null), 0.5 - 10);
});

test('feature: a walking handoff keeps the old scene in place until the destination is actually applied, then hands over exactly', async () => {
  const { install } = await import('../client/gameplay/wilderness.js');
  const { createGameplayApi } = await import('../client/gameplay/api.js');
  const applied = [];
  const api = createGameplayApi({ send: () => true, applyScene: (m) => applied.push(m) });
  api.files = [new File([new Uint8Array(1)], 'WOODS.WLD')];
  const rebases = [];
  api.rebaseScene = (o) => rebases.push(o);
  const D = { 'wilderness:109,159': 491.21, 'wilderness:109,158': 192.12 };
  const build = async (o) => ({
    kind: 'wilderness', location: o.location, positions: new Float32Array(9), warnings: [], stats: {}, flats: null, sky: null,
    wilderness: { px: 109, py: Number(o.location.split(',')[1]), datum: D[o.location], towns: [], sites: [], heightAt: () => 0 },
  });
  const rpgAt = (location) => api._receiveRpg({ type: 'rpg', character: { location } });
  rpgAt('wilderness:109,159');
  install(api, { build, fetchFn: async () => new Response('{}', { status: 404 }), loadModels: async () => null, loadPack: async () => null });
  await settle();
  assert.equal(applied.at(-1)?.location, 'wilderness:109,159');
  await api.exterior.load('wilderness:109,158'); // resident before the step
  // Publication of the next scene is held back, as a busy frame or a slow feature would.
  let publish;
  const gate = new Promise((r) => { publish = r; });
  const setScene = api.setScene.bind(api);
  api.setScene = (m, o) => setScene(gate.then(() => m), o);
  api.emit('event', { kind: 'overland', status: 'moved', from: 'wilderness:109,159', to: 'wilderness:109,158' });
  rpgAt('wilderness:109,158');
  const shift = api.exterior.crossing('wilderness:109,159', 'wilderness:109,158');
  assert.ok(Math.abs(shift.z - PIXEL) < 1e-6 && Math.abs(shift.y - (491.21 - 192.12)) < 1e-6, 'exact shift, height included');
  await settle();
  assert.equal(applied.at(-1)?.location, 'wilderness:109,159', 'not yet published');
  assert.deepEqual(rebases.at(-1).map((v) => +v.toFixed(6)), [shift.x, shift.y, shift.z].map((v) => +v.toFixed(6)), 'old scene and ground drawn in the new frame meanwhile');
  assert.equal(api.exterior.stats().rebased.from, 'wilderness:109,159');
  publish();
  await settle();
  assert.equal(applied.at(-1)?.location, 'wilderness:109,158');
  assert.equal(api.exterior.stats().rebased, null, 'the applied scene replaces the translated one');
  // Fast travel to a neighbour (no overland event) is not carried.
  rpgAt('wilderness:109,159');
  assert.equal(api.exterior.crossing('wilderness:109,158', 'wilderness:109,159'), null);
});

test('feature: overland steps announced before their snapshot chain, cancel on reversal, and clear on other moves', async () => {
  const { install } = await import('../client/gameplay/wilderness.js');
  const { createGameplayApi } = await import('../client/gameplay/api.js');
  const api = createGameplayApi({ send: () => true, applyScene: () => {} });
  api.files = [new File([new Uint8Array(1)], 'WOODS.WLD')];
  const rebases = [];
  api.rebaseScene = (o) => rebases.push(o);
  const D = { 'wilderness:109,159': 491.21, 'wilderness:109,158': 192.12, 'wilderness:109,157': 150 };
  const build = async (o) => ({
    kind: 'wilderness', location: o.location, positions: new Float32Array(9), warnings: [], stats: {}, flats: null, sky: null,
    wilderness: { px: 109, py: Number(o.location.split(',')[1]), datum: D[o.location] ?? 100, towns: [], sites: [], heightAt: () => 0 },
  });
  const rpgAt = (location) => api._receiveRpg({ type: 'rpg', character: { location } });
  const moved = (from, to, extra = {}) => api.emit('event', { kind: 'overland', status: 'moved', from, to, ...extra });
  const A = 'wilderness:109,159', B = 'wilderness:109,158', C = 'wilderness:109,157';
  rpgAt(A);
  install(api, { build, fetchFn: async () => new Response('{}', { status: 404 }), loadModels: async () => null, loadPack: async () => null });
  await settle();

  moved(A, B);
  assert.deepEqual(api.exterior.pendingCrossing(), { from: A, to: B });
  moved(B, A);
  assert.equal(api.exterior.pendingCrossing(), null, 'a reversal before the snapshot leaves nothing to carry');

  moved(A, B, { shift: { x: 0, z: 819.2 } });
  moved(B, C, { shift: { x: 0, z: 819.2 } });
  assert.deepEqual(api.exterior.pendingCrossing(), { from: A, to: C });
  api.emit('event', { kind: 'travel', to: 'town:Daggerfall/Daggerfall' });
  assert.equal(api.exterior.pendingCrossing(), null, 'fast travel clears a pending step');

  moved(C, B);
  assert.equal(api.exterior.pendingCrossing(), null, 'an event for another place is ignored');

  // A delayed handoff A -> B leaves a translated scene; fast travel back to A must not reuse it as a turn-back.
  let publish;
  const gate = new Promise((r) => { publish = r; });
  const setScene = api.setScene.bind(api);
  api.setScene = (m, o) => setScene(gate.then(() => m), o);
  moved(A, B);
  rpgAt(B);
  assert.ok(api.exterior.crossing(A, B), 'the walk is carried');
  assert.equal(api.exterior.stats().rebased?.from, A);
  rpgAt(A); // no overland event: a reset, not a carry
  assert.equal(api.exterior.crossing(B, A), null);
  assert.equal(api.exterior.stats().rebased, null);
  assert.deepEqual(rebases.at(-1), [0, 0, 0], 'the translated scene is dropped');
  publish();
  await settle();
});

test('feature: leaving the game screen drops a pending overland step', async () => {
  const { install } = await import('../client/gameplay/wilderness.js');
  const { createGameplayApi } = await import('../client/gameplay/api.js');
  const api = createGameplayApi({ send: () => true, applyScene: () => {} });
  api._receiveRpg({ type: 'rpg', character: { location: 'wilderness:109,159' } });
  install(api, { build: async () => { throw new Error('unused'); }, fetchFn: async () => new Response('{}', { status: 404 }), loadModels: async () => null, loadPack: async () => null });
  api.emit('event', { kind: 'overland', status: 'moved', from: 'wilderness:109,159', to: 'wilderness:109,158' });
  assert.ok(api.exterior.pendingCrossing());
  api.emit('screen', 'game');
  assert.ok(api.exterior.pendingCrossing(), 'still in game');
  api.emit('screen', 'landing');
  assert.equal(api.exterior.pendingCrossing(), null);
  api.emit('event', { kind: 'overland', status: 'moved', from: 'wilderness:109,159', to: 'wilderness:109,158' });
  api.emit('screen', 'loading');
  assert.equal(api.exterior.pendingCrossing(), null);
});

// ------------------------------------------------------------------ arrival and shared town scenery

function arrivalFixture({ failScenery = new Set() } = {}) {
  const calls = { scenery: [], towns: [], wild: [] };
  const fail = new Set(failScenery);
  const source = (id) => id === GOTHWAY
    ? { spawnLocal: { x: 257.6, z: 180.8 }, longitude: 109 * 128 + 5, latitude: (499 - 159) * 128 + 5, region: 'Daggerfall', townId: GOTHWAY, blocks: [], climate: 231 }
    : { spawnLocal: { x: 40, z: 60 }, longitude: 109 * 128 + 5, latitude: (499 - 158) * 128 + 5, region: 'Daggerfall', townId: HOLD, blocks: [], climate: 231 };
  const townMesh = (id) => ({ kind: 'town', name: id.split('/')[1], positions: new Float32Array(9), source: source(id) });
  const opts = {
    build: async (o) => {
      calls.wild.push(o.location);
      const [px, py] = o.location.slice(11).split(',').map(Number);
      const towns = Object.values(placement).filter((t) => Math.abs(t.px - px) <= 1 && Math.abs(t.py - py) <= 1);
      return { kind: 'wilderness', location: o.location, positions: new Float32Array(9), warnings: [], stats: {}, flats: null, sky: null, wilderness: { px, py, datum: datum[`${px},${py}`] ?? 300, towns, sites: [], heightAt: () => 0 } };
    },
    fetchFn: async () => new Response('{}', { status: 404 }), loadModels: async () => null, loadPack: async () => null,
    loadTown: async (files, o) => { const id = o.location === 197 ? GOTHWAY : HOLD; calls.towns.push(id); return townMesh(id); },
    loadScenery: async (files, town) => {
      calls.scenery.push(town.source.townId);
      if (fail.has(town.source.townId)) throw new Error(`no flats for ${town.source.townId}`);
      return { billboards: { vertices: new Float32Array(0), count: 0 }, atlas: { width: 1, height: 1, pixels: new Uint8Array(4) }, sky: { horizon: [0.5, 0.5, 0.5], zenith: [0.4, 0.4, 0.6] }, warnings: [], stats: {}, town: town.name };
    },
  };
  return { calls, fail, opts, townMesh };
}

test('arrival: a town waits for its pixel, the towns beside it and their scenery, not for prefetches; failures retry', async () => {
  const { install } = await import('../client/gameplay/wilderness.js');
  const { createGameplayApi } = await import('../client/gameplay/api.js');
  const { calls, fail, opts, townMesh } = arrivalFixture({ failScenery: [HOLD] });
  const api = createGameplayApi({ send: () => true, applyScene: () => {} });
  api.files = [new File([new Uint8Array(1)], 'WOODS.WLD')];
  api._receiveRpg({ type: 'rpg', character: { location: GOTHWAY } });
  install(api, opts);
  assert.equal(api.exterior.arrival(GOTHWAY).status, 'loading', 'the town scene is not published yet');
  await api.setScene(townMesh(GOTHWAY), { location: GOTHWAY });
  // No frames run behind the loading screen: arrival() itself drives the work.
  let a;
  for (let i = 0; i < 20; i++) { a = api.exterior.arrival(GOTHWAY); if (a.status !== 'loading') break; await settle(5); }
  assert.equal(a.status, 'failed', 'a visible neighbour town whose scenery failed blocks arrival');
  assert.match(a.error, /Privateer/);
  assert.deepEqual(Object.keys(a.parts).sort(), [GOTHWAY, HOLD, 'wilderness:109,159'].sort());
  assert.ok(!calls.wild.some((k) => k !== 'wilderness:109,159'), 'no speculative pixel was required');
  assert.equal(api.exterior.arrival(GOTHWAY).status, 'failed', 'stays failed without a retry');
  const tries = calls.scenery.filter((t) => t === HOLD).length;
  fail.clear();
  a = api.exterior.arrival(GOTHWAY, { retry: true });
  for (let i = 0; i < 20 && a.status !== 'ready'; i++) { await settle(5); a = api.exterior.arrival(GOTHWAY); }
  assert.equal(a.status, 'ready');
  assert.equal(calls.scenery.filter((t) => t === HOLD).length, tries + 1, 'retried once');
  assert.equal(calls.scenery.filter((t) => t === GOTHWAY).length, 1, 'each town scenery is built once');
});

test('arrival: a wilderness pixel waits for itself and the towns it draws', async () => {
  const { install } = await import('../client/gameplay/wilderness.js');
  const { createGameplayApi } = await import('../client/gameplay/api.js');
  const { opts } = arrivalFixture();
  const api = createGameplayApi({ send: () => true, applyScene: () => {} });
  api.files = [new File([new Uint8Array(1)], 'WOODS.WLD')];
  api._receiveRpg({ type: 'rpg', character: { location: 'wilderness:109,159' } });
  install(api, opts);
  let a = api.exterior.arrival('wilderness:109,159');
  assert.equal(a.status, 'loading');
  for (let i = 0; i < 30 && a.status !== 'ready'; i++) { await settle(5); a = api.exterior.arrival('wilderness:109,159'); }
  assert.equal(a.status, 'ready');
  assert.deepEqual(Object.keys(a.parts).sort(), ['wilderness:109,159', GOTHWAY, HOLD].sort());
  assert.equal(api.exterior.arrival('building:x').status, 'ready', 'not an exterior: nothing to add');
});

test('scenery feature: with streaming, the town scenery is the shared build and only the sky pass is its own', async () => {
  const { install } = await import('../client/gameplay/wilderness.js');
  const { install: installScenery } = await import('../client/gameplay/scenery.js');
  const { createGameplayApi } = await import('../client/gameplay/api.js');
  const { calls, opts, townMesh } = arrivalFixture();
  const api = createGameplayApi({ send: () => true, applyScene: () => {} });
  api.files = [new File([new Uint8Array(1)], 'WOODS.WLD')];
  api._receiveRpg({ type: 'rpg', character: { location: GOTHWAY } });
  install(api, opts);
  let ownLoads = 0;
  const feature = installScenery(api, { load: async () => { ownLoads++; throw new Error('should not build its own'); } });
  const town = townMesh(GOTHWAY);
  const shared = api.exterior.townScenery(town);
  await api.setScene(town, { location: GOTHWAY });
  await settle(10);
  assert.equal(ownLoads, 0);
  assert.equal(feature.status, 'ready');
  assert.equal(feature.data, await shared, 'the same data object');
  assert.equal(calls.scenery.filter((t) => t === GOTHWAY).length, 1);
  assert.equal(feature.pass.data.billboards.count, 0, 'the flats are drawn once, by the shared pass');
  assert.ok(feature.pass.data.sky);
});
