// Solid flats: client/world/scenery/colliders.js (which flats are solid, how big) and the post
// primitive of client/gameplay/collision/posts.js inside CollisionWorld. Real-data cases skip
// without the operator's ARENA2 under gamedata/.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CollisionWorld, worldFromTown } from '../client/gameplay/collision/world.js';
import { flatSolidity, measureFlat, flatCylinders, joinCylinders, summerNature } from '../client/world/scenery/colliders.js';
import { indexFiles } from '../client/world/files.js';

const ground = (half = 50) => new Float32Array([
  -half, 0, -half, -half, 0, half, half, 0, half,
  -half, 0, -half, half, 0, half, half, 0, -half,
]);
const world = (cylinders) => new CollisionWorld({ positions: ground(), groundFirstTriangle: 0, groundTriangleCount: 2, cylinders: Float32Array.from(cylinders) });

describe('post primitive in CollisionWorld', () => {
  const trunk = [0, -5, 0, 10, 0.3]; // x, z, y0, y1, r

  test('walking into a trunk stops at its surface; the body never overlaps it', () => {
    const w = world(trunk);
    const m = w.move(0, 0, 0, -10);
    assert.equal(m.blocked, true);
    assert.ok(Math.abs(m.z - -(5 - 0.3 - 0.35)) < 0.02, `stopped at ${m.z}`);
    assert.ok(w.penetration(m.x, m.z, 0) <= 0.011);
  });

  test('an open passage beside the trunk is walkable, and a glancing walk slides past', () => {
    const w = world(trunk);
    const clear = w.move(0.7, 0, 0.7, -10);
    assert.equal(clear.blocked, false);
    const slide = w.move(0.3, 0, 0.3, -10, { y: 0 }); // outside the head-on band (sin 20° × 0.65 m)
    assert.ok(slide.z < -5.5, `slid past to ${slide.z}`);
    assert.ok(slide.x > 0.6, 'pushed sideways around the trunk');
  });

  test('holding W at a trunk for 6 s keeps the walker at it; only a glancing walk slides round', () => {
    const hold = (x0, yaw) => {
      const w = world(trunk), st = { y: 0 };
      let x = x0, z = 0;
      for (let i = 0; i < 150; i++) { const m = w.move(x, z, x + Math.sin(yaw) * 0.16, z - Math.cos(yaw) * 0.16, st); x = m.x; z = m.z; }
      return { x, z };
    };
    for (const lateral of [0, 1e-6, 0.05, 0.15]) {
      const p = hold(lateral, 0);
      assert.ok(p.z > -5 + 0.3, `lateral ${lateral}: held at z=${p.z.toFixed(3)}`);
    }
    assert.ok(hold(0.45, 0).z < -6, 'a glancing walk 0.45 m off the centre line slides past');
  });

  test('a fast step cannot tunnel through a thin post', () => {
    const w = world([0, -5, 0, 4, 0.1]);
    const m = w.move(0, 0, 0, -10, { y: 0 });
    assert.ok(m.z > -5, `tunnelled to ${m.z}`);
  });

  test('a post at or below step height is stepped over; one in the head slab blocks', () => {
    assert.equal(world([0, -5, 0, 0.7, 0.4]).move(0, 0, 0, -10).blocked, false);
    assert.equal(world([0, -5, 1.0, 3, 0.4]).move(0, 0, 0, -10).blocked, true);
    assert.equal(world([0, -5, 2.5, 6, 0.4]).move(0, 0, 0, -10).blocked, false, 'above the head (a crown starting at 2.5 m) never blocks');
  });

  test('a body saved inside a post can walk out but not deeper', () => {
    const w = world(trunk);
    const out = w.move(0, -5.1, 0, -4, { y: 0 });
    assert.ok(out.z > -4.4, `escaped to ${out.z}`);
    assert.ok(w.penetration(out.x, out.z, 0) <= 0.011);
    const near = w.nearestClear(0, -5);
    assert.ok(near && w.isClear(near.x, near.z));
  });

  test('posts block sight through them, not past them', () => {
    const w = world(trunk);
    assert.equal(w.canSee(0, 0, 0, -10), false);
    assert.equal(w.canSee(1, 0, 1, -10), true);
    assert.equal(world([0, -5, 0, 1.0, 0.3]).canSee(0, 0, 0, -10), true, 'a 1 m rock does not hide eyes at 1.6 m');
  });

  test('worldFromTown takes colliders from the scene mesh; meshes without colliders are unchanged', () => {
    const mesh = { kind: 'town', positions: ground(), ground: { included: true, firstTriangle: 0, triangleCount: 2 }, colliders: { cylinders: Float32Array.from(trunk) } };
    assert.equal(worldFromTown(mesh).posts.count, 1);
    assert.equal(worldFromTown({ ...mesh, colliders: undefined }).posts, null);
    assert.equal(worldFromTown({ ...mesh, colliders: null }).move(0, 0, 0, -10).blocked, false);
  });

  test('a world built from a prebuilt (worker) triangle index still has its posts', () => {
    const mesh = { kind: 'wilderness', positions: ground(), ground: { included: true, firstTriangle: 0, triangleCount: 2 }, colliders: { cylinders: Float32Array.from(trunk) } };
    const spatialIndex = worldFromTown(mesh).spatialIndex();
    const w = worldFromTown(mesh, { spatialIndex });
    assert.equal(w.posts.count, 1);
    assert.equal(w.move(0, 0, 0, -10).blocked, true);
  });

  test('joinCylinders translates by each part offset', () => {
    const j = joinCylinders([{ cylinders: Float32Array.from(trunk) }, { cylinders: Float32Array.from(trunk), offset: { x: 10, y: 2, z: -3 } }]);
    assert.deepEqual(Array.from(j.slice(5)), [10, -8, 2, 12, Math.fround(0.3)]);
  });

  test('ten thousand posts: index and moves stay cheap', () => {
    const c = [];
    for (let i = 0; i < 10000; i++) c.push(((i * 7919) % 1000) / 10 - 50, ((i * 104729) % 1000) / 10 - 50, 0, 8, 0.3);
    const t0 = performance.now();
    const w = world(c);
    const built = performance.now() - t0;
    const t1 = performance.now();
    let x = 0, z = 0;
    for (let i = 0; i < 2000; i++) { const m = w.move(x, z, x + 0.16, z, { y: 0 }); x = m.blocked ? x - 3 : m.x; z = m.blocked ? z + 0.37 : m.z; if (x > 45) x = -45; if (z > 45) z = -45; }
    const moved = performance.now() - t1;
    assert.ok(built < 200, `index ${built.toFixed(1)} ms`);
    assert.ok(moved < 500, `2000 moves ${moved.toFixed(1)} ms`);
    assert.ok(w.posts.byteSize < 1.5e6);
  });
});

describe('which flats are solid', () => {
  test('DFU catalogue: trees and rocks solid, plants passable; winter shares its summer archive', () => {
    assert.equal(flatSolidity(504, 13), 'tree');
    assert.equal(flatSolidity(505, 13), 'tree', 'temperate winter');
    assert.equal(summerNature(511), 510);
    assert.equal(flatSolidity(504, 5), 'prop', 'woodland rock');
    for (const r of [1, 2, 7, 8, 9, 10, 21, 22, 23, 24, 26, 27, 28, 29]) assert.equal(flatSolidity(504, r), null, `504.${r} plant`);
    assert.equal(flatSolidity(503, 14), null, 'desert cactus is a plant in the catalogue');
  });

  test('props, lights, actors, loot and crops', () => {
    assert.equal(flatSolidity(205, 0), 'prop', 'barrel');
    assert.equal(flatSolidity(212, 0), 'prop', 'well');
    assert.equal(flatSolidity(210, 28), 'prop', 'street lamp');
    assert.equal(flatSolidity(210, 1), null, 'camp fire');
    assert.equal(flatSolidity(210, 25), null, 'hanging lantern');
    assert.equal(flatSolidity(201, 0), null, 'animals are actors');
    assert.equal(flatSolidity(182, 3), null, 'people are actors');
    assert.equal(flatSolidity(216, 3), null, 'treasure');
    assert.equal(flatSolidity(301, 5), null, 'crops');
    assert.equal(flatSolidity(213, 15), null, 'shrub');
    assert.equal(flatSolidity(212, 0, { kind: 'loot' }), null);
  });

  // 20x40 px at 0.05 m per px: 1 x 2 m.
  const img = (fill) => {
    const w = 20, h = 40, data = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fill(x, h - 1 - y)) data[y * w + x] = 7;
    return { width: w, height: h, data };
  };
  const size = { width: 1, height: 2 };

  test('measured: a trunk is its own width at the base centre, to its top', () => {
    const s = measureFlat(img((x, y) => (x >= 8 && x < 12) || y > 30), size, 'tree');
    assert.ok(Math.abs(s.radius - 0.1) < 1e-9, `radius ${s.radius}`);
    assert.ok(Math.abs(s.top - 2) < 1e-9);
  });

  test('measured: nothing at the base centre, or nothing on the ground, gives no collider', () => {
    assert.equal(measureFlat(img((x) => x < 3), size, 'prop'), null, 'post drawn at the sprite edge');
    assert.equal(measureFlat(img((x, y) => y > 25), size, 'prop'), null, 'hanging');
    assert.equal(measureFlat(img((x, y) => y < 10), size, 'prop'), null, 'shorter than a step');
  });

  test('a missing TEXTURE file drops only its colliders and names it', async () => {
    const out = await flatCylinders(indexFiles([]), [{ archive: 504, record: 13, x: 0, y: 0, z: 0 }, { archive: 504, record: 1, x: 0, y: 0, z: 0 }]);
    assert.equal(out.cylinders.length, 0);
    assert.deepEqual(out.stats.missingArchives, [504]);
    assert.equal(out.stats.passable, 1);
  });
});

const ARENA2 = fileURLToPath(new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url));
const skip = existsSync(ARENA2 + 'MAPS.BSA') ? false : 'local Daggerfall data not present';

describe('real Gothway Garden flats', { skip }, () => {
  let files, town, w;
  before(async () => {
    const { arena2Files } = await import('../server/rpg/collision/arena2.js');
    const { loadTown } = await import('../client/world/town.js');
    files = await arena2Files(ARENA2);
    town = await loadTown(files, { region: 'Daggerfall', location: 'Gothway Garden' });
    w = worldFromTown(town);
  });

  test('trees and props are solid, grass and crops are not, and the spawn stays clear', () => {
    const st = town.colliders.stats;
    assert.ok(st.trees > 100 && st.props > 50, JSON.stringify(st));
    assert.ok(st.passable > 0);
    assert.equal(w.isClear(0, 0), true);
  });

  test('walking at every tree trunk stops at it; the canopy beside it is passable', () => {
    const c = town.colliders.cylinders;
    let tried = 0, stopped = 0, passed = 0;
    for (let i = 0; i < c.length && tried < 40; i += 5) {
      const [x, z, , , r] = c.slice(i, i + 5);
      const fromZ = z + 3;
      if (!w.isClear(x, fromZ) || w.move(x, fromZ, x, z + r + 0.4).blocked) continue; // clear run-up
      tried++;
      const m = w.move(x, fromZ, x, z - 3);
      if (m.blocked && m.z > z) stopped++;
      const side = r + 0.4; // just outside trunk + body
      const s = w.move(x + side, fromZ, x + side, z - 3);
      if (!s.blocked || Math.abs(s.x - x) >= side - 0.01) passed++;
    }
    assert.ok(tried >= 10, `${tried} trunks tried`);
    assert.equal(stopped, tried, 'every trunk stops a direct walk');
    assert.ok(passed >= tried * 0.7, `${passed}/${tried} side passages open`);
  });

  test('without TEXTURE files the town still loads, with no flat colliders', async () => {
    const { loadTown } = await import('../client/world/town.js');
    const t = await loadTown(files.filter((f) => !/^TEXTURE\.5\d\d$/i.test(f.name)), { region: 'Daggerfall', location: 'Gothway Garden' });
    assert.equal(t.colliders.stats.trees, 0);
    assert.ok(t.colliders.stats.missingArchives.includes(504) || t.colliders.stats.missingArchives.length > 0);
    assert.equal(t.positions.length, town.positions.length);
  });
});
