// Overland: walking out of a classic exterior into `wilderness:<px>,<py>`, across neighbouring
// pixels and back into the town. Synthetic placement first; the real ARENA2 run (Gothway Garden,
// with the collision feature loading the town's geometry) is skipped when the data is not installed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import {
  install as installOverland, townFrame, tileOrigin, townToWild, wildToTown, toGlobal, fromGlobal,
  parseWildernessId, wildernessId, pushedEdges, HALF, PIXEL, EDGE,
} from '../server/rpg/overland.js';
import { createCollision } from '../server/rpg/collision.js';
import { CollisionWorld, openPlaneWorld } from '../client/gameplay/collision/world.js';

const quiet = { info() {}, warn() {}, error() {} };
const near = (a, b, eps) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

describe('frames', () => {
  test('ids are canonical map pixels only', () => {
    assert.deepEqual(parseWildernessId('wilderness:0,0'), { px: 0, py: 0 });
    assert.deepEqual(parseWildernessId('wilderness:999,499'), { px: 999, py: 499 });
    for (const bad of ['wilderness:1000,0', 'wilderness:0,500', 'wilderness:01,2', 'wilderness:-1,2', 'wilderness:1,2,3', 'wilderness: 1,2', 'town:A/B', 5]) {
      assert.equal(parseWildernessId(bad), null, String(bad));
    }
    assert.equal(wildernessId(12, 34), 'wilderness:12,34');
  });

  test('classic locations are centred in their pixel (TerrainHelper.GetLocationTerrainTileOrigin)', () => {
    assert.deepEqual(tileOrigin(4, 3), { x: 32, y: 40 });
    assert.deepEqual(tileOrigin(8, 8), { x: 0, y: 0 });
    assert.deepEqual(tileOrigin(1, 1, true), { x: 72, y: 55 });
    assert.deepEqual(tileOrigin(1, 1, false), { x: 56, y: 56 });
  });

  test('town frame: the walk rect maps onto the location rect, north stays north', () => {
    // Gothway Garden: 4x3 blocks, spawn 257.6 m east and 180.8 m north of the grid's SW corner.
    const f = townFrame({ id: 'town:A/B', px: 100, py: 200, width: 4, height: 3, spawnLocal: { x: 257.6, z: 180.8 } });
    const want = { minX: -257.6, maxX: 409.6 - 257.6, minZ: 180.8 - 307.2, maxZ: 180.8 };
    for (const k of Object.keys(want)) assert.ok(Math.abs(f.walk[k] - want[k]) < 1e-9, k);
    // SW corner of the grid: 32 tiles east, 40 tiles north of the pixel's SW corner.
    const sw = townToWild(f, f.walk.minX, f.walk.maxZ);
    assert.ok(Math.abs(sw.x - (32 * 6.4 - HALF)) < 1e-9);
    assert.ok(Math.abs(sw.z - (HALF - 40 * 6.4)) < 1e-9);
    // The north edge (−z) of the town is north in the wilderness too.
    const n = townToWild(f, 0, f.walk.minZ);
    assert.ok(n.z < sw.z);
    assert.ok(Math.abs(n.z - f.rect.minZ) < 1e-9);
    const back = wildToTown(f, n.x, n.z);
    assert.ok(Math.abs(back.x) < 1e-9 && Math.abs(back.z - f.walk.minZ) < 1e-9);
  });

  test('global grid: pixels tile without flips, map y grows south', () => {
    const a = toGlobal(10, 20, HALF - 1, 0);
    const b = fromGlobal(a.e + 2, a.s);
    assert.deepEqual([b.px, b.py], [11, 20]);
    assert.ok(Math.abs(b.x - (-HALF + 1)) < 1e-6);
    const c = fromGlobal(...Object.values(toGlobal(10, 20, 0, -HALF - 1))); // walking north
    assert.deepEqual([c.px, c.py], [10, 19]);
    assert.ok(Math.abs(c.z - (HALF - 1)) < 1e-6);
  });

  test('an edge only triggers when pushing out through it', () => {
    const b = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
    assert.equal(pushedEdges(b, 10, 0, { vx: 1, vz: 0 }).ox, 1);
    assert.equal(pushedEdges(b, 10, 0, { vx: -1, vz: 0 }), null); // turned back
    assert.equal(pushedEdges(b, 10, 0, null), null); // standing still at the wall
    assert.equal(pushedEdges(b, 10.5, 0, null).ox, 1); // already outside
    assert.equal(pushedEdges(b, 0, -10, { vx: 0, vz: -1 }).oz, -1);
    assert.equal(pushedEdges(b, 9 - EDGE, 0, { vx: 1, vz: 0 }), null);
  });
});

// ---------------------------------------------------------------------------- synthetic world

const TOWN_A = { id: 'town:Daggerfall/Ashby', region: 'Daggerfall', name: 'Ashby', x: 100, y: 200 };
const TOWN_B = { id: 'town:Daggerfall/Bigcity', region: 'Daggerfall', name: 'Bigcity', x: 102, y: 200 };
const META = {
  [TOWN_A.id]: { width: 4, height: 3, spawnLocal: { x: 257.6, z: 180.8 } },
  [TOWN_B.id]: { width: 8, height: 8, spawnLocal: { x: 400, z: 400 } },
};

/** A flat CollisionWorld covering exactly a town's walk rect, so the body stops at the open seam. */
function flatTown(f) {
  const w = f.walk;
  const positions = new Float32Array([
    w.minX, 0, w.minZ, w.minX, 0, w.maxZ, w.maxX, 0, w.maxZ,
    w.minX, 0, w.minZ, w.maxX, 0, w.maxZ, w.maxX, 0, w.minZ,
  ]);
  return new CollisionWorld({ name: f.id, openEdges: true, positions, groundFirstTriangle: 0, groundTriangleCount: 2 }, { cell: 64 });
}

async function world({ withCollision = true, wilderness = true, surface = null } = {}) {
  const players = new Map();
  const events = [];
  const emitted = [];
  const entered = [];
  const discovered = [];
  let clock = 1000;
  let api, coll;
  const fixtures = {};
  for (const t of [TOWN_A, TOWN_B]) fixtures[t.id] = flatTown(townFrame({ id: t.id, px: t.x, py: t.y, ...META[t.id] }));
  const runtime = createRpgRuntime({
    players,
    save() {},
    send: (p, msg) => msg.type === 'gameEvent' && events.push([p.id, msg.event]),
    now: () => clock,
    log: quiet,
    defaultLocation: TOWN_A.id,
    config: { worldHalfExtent: 1024 },
    features: [
      (ctx) => {
        if (withCollision) {
          coll = createCollision(ctx, {
            fixtures,
            preloadDefault: false,
            // A flat pixel surface reaching one block past each seam, as the
            // ARENA2 loader composes it. Other locations fall back to the open plane.
            load: async (loc) => {
              if (!parseWildernessId(loc)) throw new Error(`no geometry for ${loc}`);
              if (surface) return surface(loc);
              const world = openPlaneWorld(HALF + 102.4, `flat ${loc}`);
              world.datum = 0;
              return { world, source: 'synthetic surface' };
            },
          });
        }
        ctx.services.travel = { discover: (p, id) => discovered.push([p.id, id]) };
        if (wilderness) {
          ctx.services.wilderness = {
            parse: parseWildernessId,
            isWilderness: (id) => parseWildernessId(id) !== null,
            onEnter: (p, id) => entered.push([p.id, id]),
          };
        }
        api = installOverland(ctx, {
          loadCatalog: async () => [TOWN_A, TOWN_B],
          loadMeta: async (e) => META[e.id],
        });
        ctx.on('overland', (e) => emitted.push([e.player.id, e.from, e.to, e.side]));
      },
    ],
  });
  await api.ready;
  const join = (id, rpg) => {
    const p = { id, name: `P${id}`, x: 0, z: 0, yaw: 0, forward: 0, strafe: 0, moving: false, rpg };
    players.set(id, p);
    runtime.join(p);
    return p;
  };
  const settle = async () => {
    for (const t of [TOWN_A, TOWN_B]) await api.service.whenPlaced(t.id);
    for (let i = 0; i < 4; i++) {
      for (const p of players.values()) {
        if (!coll) continue;
        await coll.service.whenSettled(p.rpg.location);
        const at = api.service.globalOf(p.rpg.location, p.x, p.z);
        if (at) await coll.service.whenSettled(wildernessId(Math.floor(at.e / PIXEL), Math.floor(at.s / PIXEL)));
      }
      await new Promise((r) => setImmediate(r));
    }
  };
  /** One server tick: game.js movement (through collision when installed), then features. */
  const tick = (dtMs = 40) => {
    clock += dtMs;
    for (const p of players.values()) {
      if (!p.forward && !p.strafe) continue;
      const s = Math.sin(p.yaw), c = Math.cos(p.yaw);
      const nx = p.x + (s * p.forward + c * p.strafe) * 4 * (dtMs / 1000);
      const nz = p.z + (-c * p.forward + s * p.strafe) * 4 * (dtMs / 1000);
      const m = coll ? coll.movePlayer(p, nx, nz) : { x: nx, z: nz };
      p.x = m.x;
      p.z = m.z;
    }
    runtime.tick(dtMs / 1000, clock);
  };
  /** Walk with a heading until the location changes or `maxTicks` pass. */
  const walk = async (p, yaw, maxTicks = 200) => {
    const start = p.rpg.location;
    p.yaw = yaw;
    p.forward = 1;
    for (let i = 0; i < maxTicks && p.rpg.location === start; i++) {
      tick();
      if (i % 10 === 0) await settle();
    }
    p.forward = 0;
    return p.rpg.location;
  };
  return { runtime, players, events, emitted, entered, discovered, api, coll, join, tick, walk, settle, advance: (ms) => { clock += ms; } };
}

const NORTH = 0, EAST = Math.PI / 2, SOUTH = Math.PI, WEST = -Math.PI / 2;

describe('walking out and back (synthetic placement, real collision feature)', () => {
  test('north out of town: same pixel, same east-west position, just outside the town rect', async () => {
    const w = await world();
    const p = w.join(1, { location: TOWN_A.id });
    await w.settle();
    const f = w.api.service.townFrame(TOWN_A.id);
    p.x = 20;
    p.z = f.walk.minZ + 3;
    assert.equal(await w.walk(p, NORTH), 'wilderness:100,200');
    const expect = townToWild(f, 20, f.walk.minZ);
    assert.ok(Math.abs(p.x - expect.x) < 1e-3, `x ${p.x} vs ${expect.x}`);
    assert.ok(Math.abs(p.z - expect.z) < 1e-3);
    near(p.z, f.rect.minZ, 0.001);
    assert.deepEqual(w.entered, [[1, 'wilderness:100,200']]);
    assert.deepEqual(w.emitted, [[1, TOWN_A.id, 'wilderness:100,200', 'north']]);
    const ev = w.events.find(([, e]) => e.kind === 'overland' && e.status === 'moved');
    assert.match(ev[1].text, /leave Ashby by the north road/);
    near(ev[1].shift.x, f.dx, EDGE);
    near(ev[1].shift.z, f.dz, EDGE);
  });

  test('walking back south re-enters through the north side at the matching street position', async () => {
    const w = await world();
    const p = w.join(1, { location: TOWN_A.id });
    await w.settle();
    const f = w.api.service.townFrame(TOWN_A.id);
    p.x = -40;
    p.z = f.walk.minZ + 2;
    await w.walk(p, NORTH);
    assert.equal(await w.walk(p, SOUTH), TOWN_A.id);
    assert.ok(Math.abs(p.x - -40) < 0.05, `x ${p.x}`);
    assert.ok(p.z >= f.walk.minZ - EDGE && p.z < f.walk.minZ + 0.17, `z ${p.z}`);
    assert.deepEqual(w.discovered.at(-1), [1, TOWN_A.id]);
    assert.equal(w.emitted.at(-1)[3], 'south'); // walked south, in through the north side
  });

  test('a frame change adds no distance and an immediate reversal walks back normally', async () => {
    const w = await world();
    const p = w.join(1, { location: TOWN_A.id });
    await w.settle();
    const f = w.api.service.townFrame(TOWN_A.id);
    p.z = f.walk.minZ + 1;
    for (const direction of [NORTH, SOUTH, NORTH]) {
      const from = p.rpg.location;
      p.yaw = direction;
      p.forward = 1;
      for (let i = 0; i < 12 && p.rpg.location === from; ++i) {
        const before = w.api.service.globalOf(from, p.x, p.z);
        w.tick();
        const after = w.api.service.globalOf(p.rpg.location, p.x, p.z);
        assert.ok(Math.hypot(after.e - before.e, after.s - before.s) <= 0.1601,
          '40 ms of walking can cover at most 16 cm, even across a boundary');
      }
      assert.notEqual(p.rpg.location, from);
      p.forward = 0;
      const at = p.rpg.location;
      for (let i = 0; i < 3; ++i) w.tick();
      assert.equal(p.rpg.location, at);
    }
    assert.equal(w.emitted.length, 3);
  });

  test('west then across neighbouring pixels, then east into a full 8x8 city in the next-but-one pixel', async () => {
    const w = await world();
    const p = w.join(1, { location: TOWN_A.id });
    await w.settle();
    const f = w.api.service.townFrame(TOWN_A.id);
    p.z = 0;
    p.x = f.walk.maxX - 2;
    assert.equal(await w.walk(p, EAST), 'wilderness:100,200');
    assert.equal(await w.walk(p, EAST, 3000), 'wilderness:101,200');
    assert.ok(Math.abs(p.x - (-HALF)) < 1e-3, `x ${p.x}`);
    // Bigcity fills pixel 102 completely: stepping east goes straight into the town's west edge.
    assert.equal(await w.walk(p, EAST, 6000), TOWN_B.id);
    const fb = w.api.service.townFrame(TOWN_B.id);
    assert.ok(p.x >= fb.walk.minX - EDGE && p.x < fb.walk.minX + 0.17, `x ${p.x}`);
    assert.deepEqual(w.emitted.map((e) => e[2]), ['wilderness:100,200', 'wilderness:101,200', TOWN_B.id]);
    // Never more than one pixel per transition.
    const g = w.emitted.map(([, from, to]) => [w.api.service.globalOf(from, 0, 0), to]);
    assert.equal(g.length, 3);
  });

  test('walking out of a city that fills its pixel lands in the neighbouring pixel', async () => {
    const w = await world();
    const p = w.join(1, { location: TOWN_B.id });
    await w.settle();
    const fb = w.api.service.townFrame(TOWN_B.id);
    p.x = 0;
    p.z = fb.walk.maxZ - 1;
    assert.equal(await w.walk(p, SOUTH), 'wilderness:102,201');
    assert.ok(Math.abs(p.z - (-HALF)) < 1e-3);
    // Global position is continuous across the step.
    const gTown = w.api.service.globalOf(TOWN_B.id, 0, fb.walk.maxZ);
    const gWild = w.api.service.globalOf(p.rpg.location, p.x, p.z);
    assert.ok(Math.abs(gTown.e - gWild.e) < 1e-3 && Math.abs(gTown.s - gWild.s) < 1e-3);
  });

  test('peers: each walker is scoped to the new location immediately', async () => {
    const w = await world();
    const a = w.join(1, { location: TOWN_A.id });
    const b = w.join(2, { location: TOWN_A.id });
    await w.settle();
    const f = w.api.service.townFrame(TOWN_A.id);
    a.z = f.walk.minZ + 1;
    await w.walk(a, NORTH);
    const snap = (p) => w.runtime.snapshot?.(p);
    if (snap(b)) {
      assert.ok(!snap(b).peers.some((q) => q.id === 1 || q[0] === 1));
    }
    assert.equal(w.runtime.locationOf(a), 'wilderness:100,200');
    assert.equal(w.runtime.locationOf(b), TOWN_A.id);
    assert.equal(w.entered.length, 1);
  });
});

describe('blocked, unready and diagonal arrivals', () => {
  test('a surface still loading holds the walker at the town edge, then lets them through', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const w = await world({ surface: async (loc) => { await gate; return { world: openPlaneWorld(HALF + 102.4, loc), source: 'late' }; } });
    const p = w.join(1, { location: TOWN_A.id });
    for (const t of [TOWN_A, TOWN_B]) await w.api.service.whenPlaced(t.id);
    await w.coll.service.whenSettled(TOWN_A.id);
    const f = w.api.service.townFrame(TOWN_A.id);
    p.z = f.walk.minZ + 1;
    p.yaw = NORTH;
    p.forward = 1;
    for (let i = 0; i < 60; i++) w.tick();
    assert.equal(p.rpg.location, TOWN_A.id, 'held while the wilderness surface loads');
    assert.ok(p.z >= f.walk.minZ, 'never pushed past the town edge');
    assert.equal(w.coll.service.status('wilderness:100,200').status, 'loading');
    release();
    await w.settle();
    for (let i = 0; i < 5 && p.rpg.location === TOWN_A.id; i++) w.tick();
    assert.equal(p.rpg.location, 'wilderness:100,200');
  });

  test('a surface without geometry never lets a walker leave or enter', async () => {
    const w = await world({ surface: async () => { throw new Error('ARENA2 is missing a block'); } });
    const p = w.join(1, { location: TOWN_A.id });
    await w.settle();
    assert.equal(w.coll.service.status('wilderness:100,200').status, 'fallback');
    const f = w.api.service.townFrame(TOWN_A.id);
    p.z = f.walk.minZ + 1;
    assert.equal(await w.walk(p, NORTH, 100), TOWN_A.id);
    assert.ok(w.events.some(([, e]) => e.kind === 'overland' && e.status === 'blocked'));
    assert.equal(w.emitted.length, 0);
  });

  test('a wall on the town edge blocks the way from both sides; the gate beside it opens', async () => {
    const fa = townFrame({ id: TOWN_A.id, px: TOWN_A.x, py: TOWN_A.y, ...META[TOWN_A.id] });
    // A wall just outside the north edge (the flat town fixture has none), leaving a 10 m gate at pixel x 0..10.
    const z0 = fa.rect.minZ - 1.2;
    const walls = [{ minX: fa.rect.minX - 5, maxX: 0, minZ: z0, maxZ: z0 + 0.6 }, { minX: 10, maxX: fa.rect.maxX + 5, minZ: z0, maxZ: z0 + 0.6 }];
    // A flat surface with both wall boxes standing on it.
    const h = HALF + 102.4;
    const tris = [-h, 0, -h, -h, 0, h, h, 0, h, -h, 0, -h, h, 0, h, h, 0, -h];
    for (const wall of walls) {
      const { minX: a, maxX: b, minZ: c, maxZ: d } = wall, y = 4;
      const quad = (P, Q, R, T) => tris.push(...P, ...Q, ...R, ...P, ...R, ...T);
      quad([a, 0, c], [b, 0, c], [b, y, c], [a, y, c]); quad([a, 0, d], [a, y, d], [b, y, d], [b, 0, d]);
      quad([a, 0, c], [a, y, c], [a, y, d], [a, 0, d]); quad([b, 0, c], [b, 0, d], [b, y, d], [b, y, c]);
    }
    const walled = new CollisionWorld({ name: 'walls', positions: new Float32Array(tris), groundFirstTriangle: 0, groundTriangleCount: 2 }, { cell: 16 });
    walled.datum = 0;
    const w = await world({ surface: async () => ({ world: walled, source: 'walls' }) });
    const p = w.join(1, { location: TOWN_A.id });
    await w.settle();
    const f = w.api.service.townFrame(TOWN_A.id);
    // From inside, behind the wall: the edge is reachable, but the handoff sweep meets the wall.
    const wallX = wildToTown(f, -40, 0).x;
    p.x = wallX;
    p.z = f.walk.minZ + 1;
    assert.equal(await w.walk(p, NORTH, 100), TOWN_A.id);
    assert.ok(w.events.some(([, e]) => e.status === 'blocked'));
    // Through the gate it opens.
    p.x = wildToTown(f, 5, 0).x;
    p.z = f.walk.minZ + 1;
    assert.equal(await w.walk(p, NORTH), 'wilderness:100,200');
    // From outside, against the wall: held on the wilderness side, never placed in the town.
    p.x = -40;
    p.z = z0 - 3;
    w.events.length = 0;
    p.yaw = SOUTH;
    p.forward = 1;
    for (let i = 0; i < 40; i++) w.tick();
    p.forward = 0;
    assert.equal(p.rpg.location, 'wilderness:100,200');
    assert.ok(p.z < z0, `kept outside the wall (z ${p.z})`);
    // Back through the gate.
    p.x = 5;
    p.z = z0 - 3;
    assert.equal(await w.walk(p, SOUTH), TOWN_A.id);
  });

  test('a destination town whose placement is still loading holds the walker in their pixel', async () => {
    let release;
    const late = new Promise((r) => { release = r; });
    const players = new Map();
    let clock = 0, api;
    const runtime = createRpgRuntime({
      players, save() {}, send() {}, now: () => clock, log: quiet, config: { worldHalfExtent: 1024 },
      features: [(ctx) => {
        createCollision(ctx, { preloadDefault: false, load: async (loc) => ({ world: Object.assign(openPlaneWorld(HALF + 102.4, loc), { datum: 0 }), source: 'flat' }) });
        ctx.services.wilderness = { parse: parseWildernessId, isWilderness: (id) => !!parseWildernessId(id), onEnter() {} };
        api = installOverland(ctx, {
          loadCatalog: async () => [TOWN_B],
          loadMeta: async (e) => { await late; return META[e.id]; },
        });
      }],
    });
    await api.ready;
    const p = { id: 1, name: 'P', x: HALF, z: 0, yaw: EAST, forward: 1, strafe: 0, rpg: { location: 'wilderness:101,200' } };
    players.set(1, p);
    runtime.join(p);
    for (let i = 0; i < 30; i++) { clock += 40; runtime.tick(0.04, clock); await new Promise((r) => setImmediate(r)); }
    assert.equal(p.rpg.location, 'wilderness:101,200', 'never guessed into an unplaced town');
    release();
    await api.service.whenPlaced(TOWN_B.id);
    for (let i = 0; i < 30 && p.rpg.location === 'wilderness:101,200'; i++) { clock += 40; runtime.tick(0.04, clock); await new Promise((r) => setImmediate(r)); }
    assert.equal(p.rpg.location, TOWN_B.id);
  });

  test('a diagonal pixel corner: walking north-west lands in the diagonal pixel at the same global point', async () => {
    const w = await world();
    const p = w.join(1, { location: 'wilderness:105,205' });
    await w.settle();
    p.x = -HALF + 0.3;
    p.z = -HALF + 0.3;
    const before = toGlobal(105, 205, -HALF, -HALF);
    assert.equal(await w.walk(p, -Math.PI / 4, 20), 'wilderness:104,204');
    assert.equal(w.emitted.at(-1)[3], 'north-west');
    const after = w.api.service.globalOf(p.rpg.location, p.x, p.z);
    near(after.e, before.e, 1e-3);
    near(after.s, before.s, 1e-3);
    // And the reverse diagonal returns to the original pixel.
    assert.equal(await w.walk(p, (3 * Math.PI) / 4, 400), 'wilderness:105,205');
    assert.equal(w.emitted.at(-1)[3], 'south-east');
  });
});

describe('guards', () => {
  test('the map edge holds the walker inside', async () => {
    const w = await world();
    const p = w.join(1, { location: 'wilderness:0,10' });
    await w.settle();
    p.x = -HALF + 0.3;
    p.yaw = WEST;
    p.forward = 1;
    for (let i = 0; i < 20; i++) w.tick();
    assert.equal(p.rpg.location, 'wilderness:0,10');
    assert.ok(p.x >= -HALF);
    assert.ok(w.events.some(([, e]) => e.status === 'edge'));
  });

  test('invalid saved wilderness ids return to the default town; no transitions without data', async () => {
    const w = await world();
    const p = w.join(1, { location: 'wilderness:5000,1' });
    assert.equal(p.rpg.location, TOWN_A.id);
    const players = new Map();
    let installed;
    const rt = createRpgRuntime({ players, save() {}, send() {}, log: quiet, features: [(ctx) => { installed = installOverland(ctx); }] });
    assert.equal(installed.service.status, 'missing');
    const q = { id: 9, name: 'Q', x: 0, z: 0, yaw: 0, forward: 1, strafe: 0, rpg: { location: 'wilderness:3,3' } };
    players.set(9, q);
    rt.join(q);
    q.x = HALF + 1;
    rt.tick(0.04, 5);
    assert.equal(q.rpg.location, 'wilderness:3,3');
  });

  test('entering a town from the wilderness needs walking in, not standing or leaving', async () => {
    const w = await world();
    const p = w.join(1, { location: 'wilderness:100,200' });
    await w.settle();
    const f = w.api.service.townFrame(TOWN_A.id);
    // Inside the rect but heading away from it: stays in the wilderness.
    p.x = f.rect.minX + 1;
    p.z = 0;
    p.yaw = WEST;
    p.forward = 1;
    w.tick();
    assert.equal(p.rpg.location, 'wilderness:100,200');
    p.forward = 0;
    w.tick();
    assert.equal(p.rpg.location, 'wilderness:100,200');
    // Walking east into it from outside enters by the west side.
    p.x = f.rect.minX - 1;
    assert.equal(await w.walk(p, EAST), TOWN_A.id);
    assert.equal(w.emitted.at(-1)[3], 'east');
  });
});

// ---------------------------------------------------------------------------- real data

const root = fileURLToPath(new URL('..', import.meta.url));
const ARENA2 = ['gamedata/DaggerfallGameFiles/arena2', 'gamedata/DaggerfallGameFiles/ARENA2'].map((d) => root + d).find((d) => existsSync(d));

describe('real ARENA2 (Gothway Garden)', { skip: !ARENA2 && 'operator ARENA2 is not installed' }, () => {
  test('walk north out of Gothway Garden, cross into the next pixel, come back and walk into town', async () => {
    const players = new Map();
    const emitted = [];
    let clock = 0;
    let ov, coll;
    const runtime = createRpgRuntime({
      players, save() {}, send: (q, m) => process.env.OVERLAND_DEBUG && console.log('#', JSON.stringify(m.event ?? m.type)), now: () => clock, log: quiet, dataPath: ARENA2,
      config: { worldHalfExtent: 1024 },
      features: [(ctx) => {
        coll = createCollision(ctx, { preloadDefault: false });
        ctx.services.wilderness = { parse: parseWildernessId, isWilderness: (id) => !!parseWildernessId(id), onEnter() {} };
        ov = installOverland(ctx);
        ctx.on('overland', (e) => emitted.push([e.from, e.to, e.side]));
      }],
    });
    await ov.ready;
    const id = 'town:Daggerfall/Gothway Garden';
    const p = { id: 1, name: 'Walker', x: 0, z: 0, yaw: 0, forward: 0, strafe: 0, rpg: { location: id } };
    players.set(1, p);
    runtime.join(p);
    await ov.service.whenPlaced(id);
    await coll.service.whenSettled(id);
    const f = ov.service.townFrame(id);
    const here = ov.service.townAt(f.px, f.py);
    assert.equal(here.id, id);
    assert.equal(f.width, 4);
    assert.equal(f.height, 3);

    // Find a clear lane to the north edge in the real geometry, then walk it with the collision feature.
    let lane = null;
    for (let x = f.walk.minX + 3; x < f.walk.maxX - 3 && !lane; x += 1.6) {
      let clear = true;
      for (let z = f.walk.minZ + 0.5; z < f.walk.minZ + 25 && clear; z += 0.5) clear = coll.service.isClear(id, x, z);
      if (clear) lane = x;
    }
    assert.ok(lane !== null, 'some open ground reaches the north edge');
    p.x = lane;
    p.z = f.walk.minZ + 20;
    const step = async (yaw, n) => {
      p.yaw = yaw;
      p.forward = 1;
      const start = p.rpg.location;
      for (let i = 0; i < n && p.rpg.location === start; i++) {
        clock += 40;
        const s = Math.sin(p.yaw), c = Math.cos(p.yaw);
        const m = coll.movePlayer(p, p.x + s * 0.16, p.z - c * 0.16);
        p.x = m.x;
        p.z = m.z;
        runtime.tick(0.04, clock);
        if (i % 25 === 0) {
          await coll.service.whenSettled(p.rpg.location);
          for (const t of [id]) await ov.service.whenPlaced(t);
          const at = ov.service.globalOf(p.rpg.location, p.x, p.z);
          await coll.service.whenSettled(wildernessId(Math.floor(at.e / PIXEL), Math.floor(at.s / PIXEL)));
          // Whatever the crossing asked for (neighbour placement, destination surface) settles too.
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const t = ov.service.townAt(f.px + dx, f.py + dy);
            if (t) await ov.service.whenPlaced(t.id);
          }
          for (const loc of coll.service.cachedLocations()) await coll.service.whenSettled(loc);
        }
      }
      p.forward = 0;
      if (process.env.OVERLAND_DEBUG) console.log('# step', yaw, p.rpg.location, p.x, p.z);
      return p.rpg.location;
    };
    const wild = wildernessId(f.px, f.py);
    assert.equal(await step(NORTH, 400), wild);
    const g0 = ov.service.globalOf(wild, p.x, p.z);
    const expect = ov.service.globalOf(id, lane, f.walk.minZ);
    assert.ok(Math.abs(g0.e - expect.e) < 0.01 && Math.abs(g0.s - expect.s) < 0.01);

    // On to the next pixel north (the open-plane fallback holds them until it is drawn).
    assert.equal(await step(NORTH, 6000), wildernessId(f.px, f.py - 1));
    assert.ok(Math.abs(p.z - (HALF)) < 1e-3);
    assert.equal(await step(SOUTH, 400), wild);
    // And back into town by the north side, at the lane we left by.
    assert.equal(await step(SOUTH, 8000), id);
    assert.ok(Math.abs(p.x - lane) < 0.2, `x ${p.x} vs lane ${lane}`);
    assert.ok(p.z >= f.walk.minZ - EDGE && p.z < f.walk.minZ + 6.5);
    assert.ok(coll.service.isClear(id, p.x, p.z), 'arrival is on open ground');
    assert.deepEqual(emitted.map((e) => e[2]), ['north', 'north', 'south', 'south']);
    console.log(`# real run: ${emitted.map((e) => `${e[0]} -> ${e[1]} (${e[2]})`).join('; ')}`);
    console.log(`# Gothway Garden pixel ${f.px},${f.py}; town rect in pixel x ${f.rect.minX.toFixed(1)}..${f.rect.maxX.toFixed(1)}, z ${f.rect.minZ.toFixed(1)}..${f.rect.maxZ.toFixed(1)}`);
  });
});

const WOD = root + 'gamedata/world-of-daggerfall';
describe('real ARENA2 (Daggerfall city and the Port of Daggerfall)', { skip: (!ARENA2 || !existsSync(WOD)) && 'operator ARENA2 or the World of Daggerfall pack is not installed' }, () => {
  test('through the north gate and back, a wall lane holds, then south out of the city into the 3x3 port', async () => {
    const { serverWorldData } = await import('../server/rpg/wilderness/replacements.js');
    const wd = await serverWorldData(WOD, { log: { warn() {} } });
    const players = new Map();
    const emitted = [];
    const notices = [];
    let clock = 0, ov, coll;
    const runtime = createRpgRuntime({
      players, save() {}, now: () => clock, log: quiet, dataPath: ARENA2, config: { worldHalfExtent: 1024 },
      send: (_p, m) => m.type === 'gameEvent' && m.event.kind === 'overland' && notices.push(m.event.status),
      features: [(ctx) => {
        ctx.services.worldData = { ready: Promise.resolve(wd) };
        coll = createCollision(ctx, { preloadDefault: false });
        ctx.services.wilderness = { parse: parseWildernessId, isWilderness: (id) => !!parseWildernessId(id), onEnter() {} };
        ov = installOverland(ctx);
        ctx.on('overland', (e) => emitted.push([e.from, e.to, e.side]));
      }],
    });
    await ov.ready;
    const city = ov.service.townAt(207, 213), port = ov.service.townAt(207, 214);
    assert.ok(city && port, 'Daggerfall and the port stand in adjacent pixels');
    const p = { id: 1, name: 'Walker', x: 0, z: 0, yaw: 0, forward: 0, strafe: 0, rpg: { location: city.id } };
    players.set(1, p);
    runtime.join(p);
    const settle = async () => {
      for (const t of [city, port]) await ov.service.whenPlaced(t.id);
      for (let i = 0; i < 3; i++) for (const loc of coll.service.cachedLocations()) await coll.service.whenSettled(loc);
    };
    await settle();
    const f = ov.service.townFrame(city.id), fp = ov.service.townFrame(port.id);
    assert.deepEqual([f.width, f.height, fp.width, fp.height], [8, 8, 3, 3]);
    /** Walk with a heading for at most n ticks, stopping early on a location change or after `until`. */
    const go = async (yaw, n, until = () => false) => {
      p.yaw = yaw;
      p.forward = 1;
      const start = p.rpg.location;
      for (let i = 0; i < n && p.rpg.location === start && !until(); i++) {
        clock += 40;
        const s = Math.sin(yaw), c = Math.cos(yaw);
        const m = coll.movePlayer(p, p.x + s * 0.16, p.z - c * 0.16);
        p.x = m.x;
        p.z = m.z;
        runtime.tick(0.04, clock);
        if (i % 25 === 0) await settle();
      }
      p.forward = 0;
      return p.rpg.location;
    };
    const tw = (await coll.service.whenSettled(city.id), city.id);
    /** A gate: an open straight run from deep inside to the edge with wall on both sides. Returns {x, wall}. */
    const gate = (z0, z1) => {
      const open = [];
      for (let x = f.walk.minX + 1; x < f.walk.maxX - 1; x += 1) {
        let ok = true;
        for (let z = z0; ok && (z1 > z0 ? z < z1 : z > z1); z += Math.sign(z1 - z0) * 0.5) ok = coll.service.isClear(tw, x, z);
        open.push([x, ok]);
      }
      for (let i = 1; i < open.length; i++) {
        if (!open[i][1] || open[i - 1][1]) continue;
        let j = i;
        while (j < open.length && open[j][1]) j++;
        if (j < open.length && j - i >= 2) return { x: open[Math.floor((i + j - 1) / 2)][0], wall: open[Math.min(j + 5, open.length - 1)][0] };
        i = j;
      }
      return null;
    };
    const ng = gate(f.walk.minZ + 100, f.walk.minZ + 0.5);
    assert.ok(ng, 'a north gate');
    const north = ng.x;
    // Through the gate into the pixel north of the city, then back through the same gate.
    p.x = north;
    p.z = f.walk.minZ + 100;
    assert.equal(await go(NORTH, 1500), 'wilderness:207,212');
    const out = ov.service.globalOf(p.rpg.location, p.x, p.z);
    const expect = ov.service.globalOf(city.id, north, f.walk.minZ);
    assert.ok(Math.abs(out.e - expect.e) < 0.01 && Math.abs(out.s - expect.s) < 0.01, 'continuous across the seam');
    assert.equal(await go(SOUTH, 400), city.id, `notices ${notices}; at ${p.x.toFixed(2)},${p.z.toFixed(2)}`);
    assert.ok(Math.abs(p.x - north) < 0.2 && p.z >= f.walk.minZ - EDGE, 'back in through the gate');
    // A wall lane beside the gate: walking north from inside the wall never reaches the edge.
    const wallX = ng.wall;
    p.x = wallX;
    p.z = f.walk.minZ + 100;
    const before = emitted.length;
    assert.equal(await go(NORTH, 1000), city.id);
    assert.equal(emitted.length, before, 'no crossing through the wall');
    assert.ok(p.z > f.walk.minZ + 5, `held by the wall (z ${p.z.toFixed(1)})`);
    // South: out of the city into the port's pixel, and on into the port by its north side.
    const sg = gate(f.walk.maxZ - 100, f.walk.maxZ - 0.5);
    assert.ok(sg, 'a south gate');
    const south = sg.x;
    p.x = south;
    p.z = f.walk.maxZ - 100;
    assert.equal(await go(SOUTH, 1500), 'wilderness:207,214');
    assert.ok(Math.abs(p.z - (-HALF)) < 1e-3);
    // Head for an open lane of the port, then walk in.
    assert.equal((await coll.service.whenSettled(port.id)).status, 'ready');
    const portLane = (() => {
      for (let x = fp.walk.minX + 5; x < fp.walk.maxX - 5; x += 1) {
        let ok = true;
        for (let z = fp.walk.minZ + 0.5; ok && z < fp.walk.minZ + 25; z += 0.5) ok = coll.service.isClear(port.id, x, z);
        if (ok) return townToWild(fp, x, 0).x;
      }
      return null;
    })();
    assert.ok(portLane !== null, 'an open lane into the port');
    await go(p.x < portLane ? EAST : WEST, 6000, () => Math.abs(p.x - portLane) < 0.2);
    assert.ok(Math.abs(p.x - portLane) < 0.3, `reached the port lane (${p.x} vs ${portLane})`);
    assert.equal(await go(SOUTH, 6000), port.id);
    assert.ok(coll.service.isClear(port.id, p.x, p.z));
    console.log(`# real run: ${emitted.map((e) => `${e[0]} -> ${e[1]} (${e[2]})`).join('; ')}`);
  });
});
