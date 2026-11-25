// Server collision feature: area loading, holding during loads, fallback notices, cache
// eviction, area changes, the browser predictor hook, and the game loop integration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollision, install } from '../server/rpg/collision.js';
import { AreaCache } from '../server/rpg/collision/areas.js';
import { parseTownId } from '../server/rpg/collision/arena2.js';
import { install as installClient } from '../client/gameplay/collision.js';
import { worldFromTown } from '../client/gameplay/collision/world.js';
import { synthWorld } from './rpg-collision.test.mjs';

const TOWN = 'town:Daggerfall/Gothway Garden';
const OTHER = 'town:Wayrest/Wayrest';

test('stacked dungeon floors use the entry marker for old saves and restore the last occupied floor', async () => {
  const loc = 'dungeon:Daggerfall/Test';
  const floors = [4, 8].map(y => ({ x0: -8, x1: 8, z0: -8, z1: 8, y }));
  const mesh = { kind: 'dungeon', location: loc, spawn: { y: 8.2 }, positions: synthWorld({ floors }).positions };
  const world = worldFromTown(mesh);
  assert.equal(world.standHeight(0, 0), 8);
  const { ctx } = fakeCtx();
  const { service, movePlayer } = createCollision(ctx, { fixtures: { [loc]: world }, preloadDefault: false });
  await service.whenSettled(loc);
  assert.equal(service.groundAt(loc, 0, 0), 8);
  assert.equal(service.groundAt(loc, 0, 0, 4.2), 4, 'authored actors keep their floor below the dungeon entry');
  for (const saved of [undefined, 4]) {
    const p = { x: 0, z: 0, rpg: { location: loc, portal: { to: loc, footY: saved } } };
    assert.deepEqual(movePlayer(p, 1, 0), { x: 1, z: 0 });
    assert.equal(p.rpg.portal.footY, saved ?? 8);
  }
});

function fakeCtx({ dataPath = null } = {}) {
  const ticks = [], joins = [], leaves = [], notes = [];
  const ctx = {
    players: new Map(),
    services: {},
    config: { worldHalfExtent: 100 },
    dataPath,
    defaultLocation: TOWN,
    log: { warn() {}, error() {} },
    location: (p) => p.rpg?.location ?? TOWN,
    notify: (p, ev) => notes.push([p.id, ev]),
    onJoin: (f) => joins.push(f),
    onLeave: (f) => leaves.push(f),
    onTick: (f) => ticks.push(f),
  };
  return { ctx, ticks, joins, leaves, notes, join: (p) => { ctx.players.set(p.id, p); joins.forEach((f) => f(p)); } };
}

const player = (id, x = 0, z = 0, location = TOWN) => ({ id, x, z, rpg: { location } });
const wallWorld = () => synthWorld({ walls: [{ a: [-10, -2], b: [10, -2] }] });

test('players hold position while their area loads, then collide with walls', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { ctx, join } = fakeCtx();
  const c = createCollision(ctx, { load: async () => (await gate, { world: wallWorld(), source: 'test' }) });
  const p = player(1);
  join(p);
  assert.deepEqual(ctx.services.movePlayer(p, 0, -1), { x: 0, z: 0 }, 'held while loading');
  assert.equal(ctx.services.canSee(TOWN, 0, 0, 0, -5), false, 'unknown sight is not granted');
  assert.equal(ctx.services.collision.status(TOWN).status, 'loading');
  release();
  await ctx.services.collision.whenSettled(TOWN);
  const m = ctx.services.movePlayer(p, 0, -5);
  assert.ok(m.z > -2 && Math.abs(m.z - (-2 + 0.35)) < 0.02, `stopped at the wall: ${m.z}`);
  assert.equal(ctx.services.canSee(TOWN, 0, 0, 0, -5), false);
  assert.equal(ctx.services.canSee(TOWN, 0, 0, 5, 0), true);
  assert.equal(c.cache.peek(TOWN).source, 'test');
});

test('missing operator data falls back to an open plane and tells the players', async () => {
  const { ctx, join, notes } = fakeCtx({ dataPath: null });
  install(ctx);
  const p = player(7);
  join(p);
  const s = await ctx.services.collision.whenSettled(TOWN);
  assert.equal(s.status, 'fallback');
  assert.match(s.reason, /no game data/);
  const ev = notes.find(([id, e]) => id === 7 && e.kind === 'collision');
  assert.ok(ev, 'player notified');
  assert.equal(ev[1].status, 'fallback');
  assert.match(ev[1].text, /no game data/i);
  const m = ctx.services.movePlayer(p, 3, -4);
  assert.deepEqual([m.x, m.z], [3, -4]);
  assert.ok(Math.abs(ctx.services.movePlayer(p, 500, 0).x - (100 - 0.35)) < 1e-6, 'bounded by worldHalfExtent');
  assert.equal(ctx.services.canSee(TOWN, 0, 0, 50, 50), true);
  // Notified once, not every tick.
  ctx.services.movePlayer(p, 1, 1);
  assert.equal(notes.filter(([id, e]) => id === 7 && e.kind === 'collision').length, 1);
});

test('fixtures are used before operator data; a missing configured scene cannot become an open plane', async () => {
  const { ctx } = fakeCtx({ dataPath: '/nonexistent' });
  createCollision(ctx, { fixtures: { [TOWN]: wallWorld() } });
  assert.equal((await ctx.services.collision.whenSettled(TOWN)).status, 'ready');
  const d = await ctx.services.collision.whenSettled('dungeon:Daggerfall/Privateer\'s Hold');
  assert.equal(d.status, 'unavailable');
  assert.match(d.reason, /no exterior geometry/);
});

test('a configured scene load failure holds movement until an occupied-area retry restores the walls', async () => {
  let now = 1000, attempts = 0;
  const { ctx, join, ticks } = fakeCtx({ dataPath: '/operator/arena2' });
  createCollision(ctx, {
    cache: { now: () => now, retryUnavailableMs: 5000 },
    load: async () => {
      if (++attempts === 1) throw new Error('scene read interrupted');
      return { world: wallWorld(), source: 'retry' };
    },
  });
  const p = player(3);
  join(p);
  assert.equal((await ctx.services.collision.whenSettled(TOWN)).status, 'unavailable');
  assert.deepEqual(ctx.services.movePlayer(p, 0, -5), { x: 0, z: 0 });
  assert.equal(ctx.services.canSee(TOWN, 0, 0, 0, -5), false);
  now += 5001;
  for (const tick of ticks) tick(5.1);
  assert.equal((await ctx.services.collision.whenSettled(TOWN)).status, 'ready');
  assert.equal(attempts, 2);
  assert.ok(ctx.services.movePlayer(p, 0, -5).z > -2);
});

test('changing area switches geometry and resets the foot height', async () => {
  const { ctx, join } = fakeCtx();
  const raised = synthWorld({ floors: [{ x0: -5, z0: -5, x1: 5, z1: 5, y: 0.5 }] });
  createCollision(ctx, {
    preloadDefault: false,
    load: async (loc) => ({ world: loc === TOWN ? wallWorld() : raised, source: loc }),
  });
  const p = player(2);
  join(p);
  await ctx.services.collision.whenSettled(TOWN);
  ctx.services.movePlayer(p, 0, -1);
  p.rpg.location = OTHER;
  p.x = 0; p.z = 0;
  assert.deepEqual(ctx.services.movePlayer(p, 0, -5), { x: 0, z: 0 }, 'new area holds while loading');
  await ctx.services.collision.whenSettled(OTHER);
  const m = ctx.services.movePlayer(p, 0, -4);
  assert.equal(m.z, -4, 'the old area\'s wall is gone');
  assert.equal(ctx.services.collision.groundAt(OTHER, 0, 0), 0.5);
});

test('the cache keeps occupied and recent areas only, and loads one at a time', async () => {
  let t = 0, running = 0, peak = 0;
  const cache = new AreaCache({
    now: () => t,
    maxAreas: 2,
    idleMs: 1000,
    load: async (loc) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running--;
      return { world: { byteSize: 10, loc }, source: loc };
    },
    fallback: () => ({ world: {}, source: 'plane' }),
  });
  await Promise.all(['a', 'b', 'c', 'd'].map((l) => cache.whenSettled(l)));
  assert.equal(peak, 1, 'serial loads');
  t = 10;
  cache.sweep(new Set(['a']));
  assert.deepEqual([...cache.areas.keys()].sort(), ['a', 'd'], 'over cap: least recent unoccupied evicted');
  t = 5000;
  cache.sweep(new Set(['a']));
  assert.deepEqual([...cache.areas.keys()], ['a'], 'idle unoccupied dropped, occupied kept');
});

test('a slow loader times out into the fallback', async () => {
  const cache = new AreaCache({
    loadTimeoutMs: 20,
    load: () => new Promise(() => {}),
    fallback: () => ({ world: { byteSize: 0 }, source: 'plane' }),
  });
  const a = await cache.whenSettled('x');
  assert.equal(a.status, 'fallback');
  assert.match(a.reason, /longer than/);
});

test('location ids parse like the travel catalogue', () => {
  assert.deepEqual(parseTownId(TOWN), { region: 'Daggerfall', location: 'Gothway Garden' });
  assert.equal(parseTownId('building:x'), null);
  assert.equal(parseTownId('town:/x'), null);
});

test('browser module: constrainMove predicts against the scene and defers to server fallbacks', () => {
  const handlers = new Map();
  const messages = [];
  const api = {
    location: null,
    town: null,
    on: (n, f) => handlers.set(n, f),
    message: (t) => messages.push(t),
  };
  installClient(api);
  assert.deepEqual(api.constrainMove(0, 0, 0, -5), { x: 0, z: 0 }, 'hold until scene geometry arrives');
  const w = wallWorld();
  handlers.get('scene')({ name: 'wall', positions: w.positions, ground: { included: true, firstTriangle: 2, triangleCount: 2 } });
  handlers.get('location')({ location: TOWN, previous: null });
  api.location = TOWN;
  const m = api.constrainMove(0, 0, 0, -5);
  assert.ok(m.z > -2, `predicted stop ${m.z}`);
  assert.equal(api.canSee(0, 0, 0, -5), false);
  handlers.get('event')({ kind: 'collision', status: 'fallback', location: TOWN, text: 'no data' });
  assert.deepEqual(api.constrainMove(0, 0, 0, -5), { x: 0, z: -5 });
  assert.deepEqual(messages, [], 'the game shell already displays the server notice');
  handlers.get('location')({ location: OTHER, previous: TOWN });
  api.location = OTHER;
  assert.deepEqual(api.constrainMove(0, 0, 0, -5), { x: 0, z: 0 }, 'travelled: hold until the new scene is ready');
  const wild = 'wilderness:109,158';
  api.location = wild;
  handlers.get('scene')({ location: wild, positions: w.positions, ground: { included: true, firstTriangle: 2, triangleCount: 2 } });
  handlers.get('location')({ location: wild, previous: OTHER });
  assert.equal(api.collisionReady(), true, 'a matching scene delivered before the location event stays active');
  assert.ok(api.constrainMove(0, 0, 0, -5).z > -2);
  handlers.get('event')({ kind: 'collision', status: 'fallback', location: wild });
  assert.equal(api.collisionReady(), false, 'no movement through a wilderness pixel in fallback');
  handlers.get('event')({ kind: 'collision', status: 'ready', location: wild });
  assert.equal(api.collisionReady(), true);
});

test('in the wilderness, prediction waits for nearby town walls and discards loads overtaken by travel', async () => {
  const handlers = new Map();
  const location = 'wilderness:109,159';
  let releaseTown;
  const api = {
    location, on: (n, f) => handlers.set(n, f),
    exterior: { load: id => {
      assert.equal(id, TOWN);
      return new Promise(resolve => { releaseTown = resolve; });
    } },
  };
  installClient(api);
  const mesh = {
    kind: 'wilderness', location, positions: synthWorld({}).positions,
    ground: { included: true, firstTriangle: 0, triangleCount: 2 },
    wilderness: { px: 109, py: 159, datum: 10, towns: [
      { id: TOWN, px: 109, py: 159, width: 1, height: 1, elevation: 10 },
    ] },
  };
  // A one-block town with the spawn at its centre has the same origin as its pixel.
  const town = { positions: wallWorld().positions, source: { spawnLocal: { x: 51.2, z: 51.2 } } };
  const load = handlers.get('scene')(mesh);
  assert.equal(api.collisionReady(), false);
  releaseTown(town);
  await load;
  assert.equal(api.collisionReady(), true);
  assert.ok(api.constrainMove(0, 0, 0, -5).z > -2);
  assert.equal(api.canSee(0, 0, 0, -5), false);

  const late = handlers.get('scene')({ ...mesh });
  api.location = OTHER;
  handlers.get('location')({ location: OTHER, previous: location });
  await handlers.get('scene')({ ...mesh, kind: 'town', location: OTHER, wilderness: null });
  releaseTown(town);
  await late;
  assert.equal(api.canSee(0, 0, 0, -5), true, 'old walls cannot replace the new scene');
});

test('a walking crossing uses prefetched collision immediately and stays solid if the next pixel is late', async () => {
  const handlers = new Map();
  const first = 'wilderness:0,0', second = 'wilderness:0,1';
  const wall = wallWorld();
  for (let i = 2; i < wall.positions.length; i += 3) wall.positions[i] += 409.6;
  const mesh = { kind: 'wilderness', location: first, positions: wall.positions,
    wilderness: { towns: [] }, ground: { included: true, firstTriangle: 2, triangleCount: 2 } };
  const api = {
    on: (key, h) => handlers.set(key, h), location: first,
    exterior: { ready: id => id === first ? mesh : null, stream: {
      pixelOf: () => ({ px: 0, py: 0 }),
      crossing: () => ({ x: 0, y: 0, z: -819.2 }),
    } },
  };
  installClient(api);
  await handlers.get('exteriorScene')({ status: 'ready', mesh });
  handlers.get('scene')(mesh);
  assert.equal(api.collisionReady(), true, 'an already indexed pixel activates in this turn');

  handlers.get('event')({ kind: 'overland', status: 'moved', from: first, to: second });
  api.location = second;
  handlers.get('location')({ previous: first, location: second });
  assert.equal(api.collisionReady(), true, 'keep walking on the old checked surface');
  const at = api.constrainMove(0, -409.6, 0, -414.6);
  assert.ok(Math.abs(at.z + 409.6 + 1.65) < 0.02, 'the wall still blocks in the new coordinates');
  assert.equal(api.collisionLocal(), 'loading', 'the new primary collision is still being prepared');
  handlers.get('event')({ kind: 'collision', status: 'unavailable', location: second });
  assert.equal(api.collisionReady(), false, 'the server can still hold the walker');

  api.location = TOWN;
  handlers.get('location')({ previous: second, location: TOWN });
  assert.equal(api.collisionReady(), false, 'a separate fast-travel destination cannot borrow that surface');
});

test('game server tick routes movement through movePlayer', async () => {
  const { createGameServer } = await import('../server/game.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dfw-col-'));
  const feature = (ctx) => createCollision(ctx, { fixtures: { [TOWN]: wallWorld() }, load: async () => { throw new Error('none'); } });
  const srv = createGameServer({ port: 0, dbPath: join(dir, 'db.sqlite'), features: [feature], defaultLocation: TOWN });
  const { port } = await srv.start();
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d)));
  await new Promise((r) => ws.once('open', r));
  ws.send(JSON.stringify({ type: 'join', name: 'Walker' }));
  const wait = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = msgs.find(pred);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('timeout');
  };
  try {
    const welcome = await wait((m) => m.type === 'welcome');
    const id = welcome.id;
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
      ws.send(JSON.stringify({ type: 'input', forward: 1, strafe: 0, yaw: 0 }));
      await new Promise((r) => setTimeout(r, 80));
    }
    msgs.length = 0;
    const st = await wait((m) => m.type === 'state' && m.players.some((p) => p.id === id));
    const me = st.players.find((p) => p.id === id);
    assert.ok(me.z > -2 && me.z < -1.5, `server stopped the player at the wall: z=${me.z}`);
  } finally {
    ws.close();
    await srv.close();
  }
});
