// Synthetic collision tests: walls, corners, tunnelling, steps, bounds, line of sight.
// Real Gothway Garden geometry: rpg-collision-gothway.test.mjs. Server feature: rpg-collision-server.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CollisionWorld, PLAYER, openPlaneWorld } from '../client/gameplay/collision/world.js';

test('an indexed world observes the current door state for sight and movement', () => {
  const mesh = synthWorld({ walls: [{ a: [-3, 0], b: [3, 0] }] });
  let open = false;
  const world = new CollisionWorld({
    positions: mesh.positions, groundFirstTriangle: 2, groundTriangleCount: 2,
    triangleEnabled: (triangle) => triangle >= 2 || !open,
  }, { spatialIndex: mesh.spatialIndex() });
  for (open of [false, true, false]) {
    assert.equal(world.canSee(0, -2, 0, 2), open);
    assert.equal(world.move(0, -2, 0, 2).z > 0, open);
  }
});

/** Builds a world from boxes/walls/floors plus a ground plane of half-extent `half`. */
export function synthWorld({ walls = [], boxes = [], floors = [], half = 20 } = {}) {
  const tris = [];
  const quad = (a, b, c, d) => tris.push(...a, ...b, ...c, ...a, ...c, ...d);
  const wall = ([ax, az], [bx, bz], y0 = 0, y1 = 3) => quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]);
  for (const w of walls) wall(w.a, w.b, w.y0, w.y1);
  for (const { x0, z0, x1, z1, y0 = 0, y1 = 3 } of boxes) {
    wall([x0, z0], [x1, z0], y0, y1);
    wall([x1, z0], [x1, z1], y0, y1);
    wall([x1, z1], [x0, z1], y0, y1);
    wall([x0, z1], [x0, z0], y0, y1);
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]); // roof
  }
  for (const { x0, z0, x1, z1, y } of floors) quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0]);
  const groundFirstTriangle = tris.length / 9;
  quad([-half, -0.025, -half], [-half, -0.025, half], [half, -0.025, half], [half, -0.025, -half]);
  return new CollisionWorld({ positions: new Float32Array(tris), groundFirstTriangle, groundTriangleCount: 2 });
}

const R = PLAYER.radius;
const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;

test('open ground: a move goes exactly where asked', () => {
  const w = synthWorld();
  const m = w.move(0, 0, 3, -4);
  assert.ok(near(m.x, 3) && near(m.z, -4));
  assert.equal(m.blocked, false);
  assert.ok(near(m.y, -0.025, 1e-4));
});

test('a wall stops a body one radius short and slides it along the wall', () => {
  const w = synthWorld({ walls: [{ a: [-10, -2], b: [10, -2] }] });
  const head = w.move(0, 0, 0, -5);
  assert.equal(head.blocked, true);
  assert.ok(near(head.z, -2 + R, 0.01), `stopped at ${head.z}`);
  // Diagonal into the wall: z stays at the wall, x keeps moving (slide).
  const slide = w.move(0, -1.5, 4, -5.5);
  assert.ok(near(slide.z, -2 + R, 0.01), `z ${slide.z}`);
  assert.ok(slide.x > 3.5, `slid to x=${slide.x}`);
});

test('fast moves cannot tunnel through a zero-thickness wall', () => {
  const w = synthWorld({ walls: [{ a: [-10, -2], b: [10, -2] }] });
  for (const dist of [0.5, 2.1, 5, 40, 200]) {
    const m = w.move(0, 0, 0.3, -dist);
    assert.ok(m.z > -2, `crossed with dist ${dist}: z=${m.z}`);
  }
  // Grazing angle: nearly parallel, ending behind the wall.
  const g = w.move(-9, -1.6, 9, -2.4);
  assert.ok(g.z > -2, `grazing crossed: ${g.z}`);
});

test('a concave corner holds the body in both axes without jitter or escape', () => {
  const w = synthWorld({ walls: [{ a: [-10, -2], b: [2, -2] }, { a: [2, -2], b: [2, 10] }] });
  let s = { y: null }, x = 0, z = 0;
  for (let i = 0; i < 60; i++) {
    const m = w.move(x, z, x + 0.12, z - 0.12, s);
    x = m.x; z = m.z;
  }
  assert.ok(near(x, 2 - R, 0.02) && near(z, -2 + R, 0.02), `corner rest ${x},${z}`);
  // And an acute wedge (30°) never lets the body through either wall.
  const wedge = synthWorld({ walls: [{ a: [0, 0], b: [10, 0] }, { a: [0, 0], b: [10, 5.77] }] });
  s = { y: null };
  x = 8; z = 2;
  for (let i = 0; i < 200; i++) {
    const m = wedge.move(x, z, x - 0.16, z, s);
    x = m.x; z = m.z;
    assert.ok(z > 0 && z < x * 0.577, `escaped wedge at ${x},${z}`);
  }
});

test('outer box corners slide the body around them', () => {
  const w = synthWorld({ boxes: [{ x0: -1, z0: -3, x1: 1, z1: -1 }] });
  const m = w.move(0.9, 0, 0.9, -6); // brushes the right half of the box front
  assert.ok(m.z > -1 || m.x > 1 + R - 0.02, `went through box: ${m.x},${m.z}`);
  assert.equal(w.isClear(0, -0.9), false, 'overlaps the front wall');
  assert.equal(w.isClear(0, 0), true);
  const c = w.nearestClear(0, -0.9);
  assert.ok(c && w.isClear(c.x, c.z));
});

test('a gap narrower than the body blocks; a wider one lets it through', () => {
  const narrow = synthWorld({ walls: [{ a: [-10, -2], b: [-0.3, -2] }, { a: [0.3, -2], b: [10, -2] }] });
  assert.ok(narrow.move(0, 0, 0, -5).z > -2);
  const wide = synthWorld({ walls: [{ a: [-10, -2], b: [-0.5, -2] }, { a: [0.5, -2], b: [10, -2] }] });
  assert.ok(near(wide.move(0, 0, 0, -5).z, -5));
});

test('steps and kerbs are climbed, walls above step height block, low overhangs block', () => {
  const w = synthWorld({
    boxes: [{ x0: -2, z0: -3, x1: 2, z1: -2, y0: 0, y1: 0.3 }], // 30 cm kerb
    walls: [{ a: [5, -10], b: [5, 10], y0: 0, y1: 1.0 }, { a: [-5, -10], b: [-5, 10], y0: 2.5, y1: 4 }, { a: [8, -10], b: [8, 10], y0: 1.2, y1: 3 }],
  });
  const s = { y: null };
  const up = w.move(0, 0, 0, -2.5, s);
  assert.ok(near(up.z, -2.5) && near(up.y, 0.3, 1e-4), `kerb ${up.z} ${up.y}`);
  const down = w.move(0, -2.5, 0, -4, s);
  assert.ok(near(down.y, -0.025, 1e-4));
  assert.ok(w.move(4, 0, 7, 0).x < 5, '1 m wall blocks');
  assert.ok(near(w.move(-4, 0, -7, 0).x, -7), 'wall from 2.5 m is head clearance');
  assert.ok(w.move(7, 0, 9, 0).x < 8, 'overhang from 1.2 m blocks');
});

test('bounds hold a body inside but never drag one in from outside', () => {
  const w = synthWorld({ half: 10 });
  assert.ok(near(w.move(0, 0, 50, 0).x, 10 - R, 1e-3));
  const out = w.move(30, 0, 40, 0);
  assert.ok(near(out.x, 30), 'cannot go further out');
  const back = w.move(30, 0, 25, 0);
  assert.ok(near(back.x, 30), 'no floor outside the plane: held, not teleported');
});

test('a body starting inside geometry can walk out but not deeper', () => {
  const w = synthWorld({ walls: [{ a: [-10, 0], b: [10, 0] }] });
  const s = { y: null };
  const out = w.move(0, 0.1, 0, 1, s);
  assert.ok(out.z > 0.1, `escape ${out.z}`);
  const deeper = w.move(0, 0.2, 0, 0.05, s);
  assert.ok(deeper.z >= 0.2 - 1e-6, `pushed deeper: ${deeper.z}`);
});

test('line of sight: walls occlude, open space and low walls do not, roofs over head do not', () => {
  const w = synthWorld({ boxes: [{ x0: -1, z0: -6, x1: 1, z1: -4 }], walls: [{ a: [5, -10], b: [5, 10], y0: 0, y1: 0.8 }] });
  assert.equal(w.canSee(0, 0, 0, -10), false);
  assert.equal(w.canSee(0, 0, 3, -10), true);
  assert.equal(w.canSee(3, 0, 8, 0), true, 'waist-high wall');
  assert.equal(w.canSee(3, 0, 8, 0, { eye: 0.5 }), false, 'low eye height');
  // Diagonal lines and exact grid-corner crossings.
  assert.equal(w.canSee(-3, -3, 3, -7), false);
  assert.equal(w.canSee(-4, -4, 4, -4), false);
  assert.equal(w.segmentClear(0, 5, 0, 0, 5, -10), true, 'above the roof');
});

test('open plane fallback: no obstacles, bounded', () => {
  const w = openPlaneWorld(50);
  assert.ok(near(w.move(0, 0, 100, 0).x, 50 - R));
  assert.equal(w.canSee(-40, -40, 40, 40), true);
  assert.equal(w.segmentClear(0, 1.4, 0, 0, -1.0, -3), false, 'downward projectile ray hits ground plane');
  assert.equal(w.segmentClear(0, 1.4, 0, 0, 0.2, -3), true, 'ray staying above ground stays clear');
});
