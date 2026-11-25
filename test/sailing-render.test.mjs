// Sailing renderer: frames, waves, motion, shot flight and snapshot reading (client/gameplay/sailing/render*.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../client/gameplay/sailing/renderMath.js';
import { analyseDeck, quadOutline, stripTriangles, triangleRuns } from '../client/gameplay/sailing/renderHull.js';
import { triangulate, ringArea, buildLand, landPatch } from '../client/gameplay/sailing/renderCoast.js';
import { seaGrid } from '../client/gameplay/sailing/renderSea.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

/** server/rpg/sailing/voyage.js deckToSea, restated: the renderer must place deck points where the server does. */
const DECK_BOW = { small: Math.PI / 2, large: Math.PI };
function deckToSea(v, x, z) {
  const a = v.yaw - DECK_BOW[v.type];
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x + x * c - z * s, z: v.z + x * s + z * c };
}

test('deck points land on the chart where the sailing core puts them', () => {
  for (const type of ['small', 'large']) {
    const hull = R.hullFrame({ minX: -10, maxX: 10, minZ: -40, maxZ: 40 }, { bowYaw: DECK_BOW[type], waterY: 1.5 });
    for (const yaw of [0, 0.7, Math.PI / 2, -2.4, Math.PI]) {
      const v = { type, x: 12345.6, z: -6789.1, yaw };
      const inv = R.invRigid(R.relToDeck(hull, { yaw, pitch: 0, heel: 0, heave: 0 }));
      for (const [x, z] of [[0, 0], [3, -17], [-8, 25]]) {
        const rel = R.apply(inv, x, 1.5, z);
        const want = deckToSea(v, x, z);
        near(rel[0] + v.x, want.x, 1e-6);
        near(rel[2] + v.z, want.z, 1e-6);
        near(rel[1], 0, 1e-9); // the waterline is sea level
      }
    }
  }
});

test('the bow points along the chart heading (yaw 0 north, x east, z south)', () => {
  const hull = R.hullFrame(null, { bowYaw: Math.PI, waterY: 0 });
  const inv = R.invRigid(R.relToDeck(hull, { yaw: Math.PI / 2, pitch: 0, heel: 0, heave: 0 }));
  const bow = R.apply(inv, 0, 0, 30);
  near(bow[0], 30); near(bow[2], 0); // east
  const [hx, hz] = R.headingVec(Math.PI);
  near(hx, 0); near(hz, 1); // south
});

test('heel lays the starboard side down and pitch lifts the bow; heave lifts the hull off the sea', () => {
  const hull = R.hullFrame(null, { bowYaw: 0, waterY: 0 });
  const inv = (pose) => R.invRigid(R.relToDeck(hull, { yaw: 0, pitch: 0, heel: 0, heave: 0, ...pose }));
  assert.ok(R.apply(inv({ heel: 0.2 }), 5, 0, 0)[1] < 0, 'starboard (+x when bow is -z) goes down');
  assert.ok(R.apply(inv({ pitch: 0.1 }), 0, 0, -20)[1] > 0, 'bow rises');
  near(R.apply(inv({ heave: 0.7 }), 0, 0, 0)[1], 0.7);
});

test('the wave field is a chart field: same height from any ship origin, and it travels with the wind', () => {
  const a = R.waveSet({ toward: 1, windSpeed: 8, origin: [1000, 2000], time: 50 });
  const b = R.waveSet({ toward: 1, windSpeed: 8, origin: [1300, 1900], time: 50 });
  // Chart point (1100, 2050): rel (100, 50) from a, (-200, 150) from b.
  near(R.waveHeight(a, 100, 50), R.waveHeight(b, -200, 150), 1e-6);
  const later = R.waveSet({ toward: 1, windSpeed: 8, origin: [1000, 2000], time: 51 });
  assert.notEqual(R.waveHeight(a, 0, 0).toFixed(5), R.waveHeight(later, 0, 0).toFixed(5));
  assert.ok(R.seaState(20) > R.seaState(3));
});

test('a ship heels away from the wind under sail and sits up at anchor', () => {
  const calm = R.waveSet({ toward: 0, windSpeed: 0.1, origin: [0, 0], time: 0 }).map((w) => ({ ...w, amp: 0 }));
  const v = { x: 0, z: 0, yaw: 0, length: 80, beam: 20, sail: 1, cls: 'large' };
  const fromStarboard = R.shipMotion(calm, v, { from: Math.PI / 2, speed: 10 });
  const fromPort = R.shipMotion(calm, v, { from: -Math.PI / 2, speed: 10 });
  assert.ok(fromStarboard.heel < -0.05, 'wind from starboard heels her to port');
  assert.ok(fromPort.heel > 0.05);
  near(R.shipMotion(calm, { ...v, sail: 0 }, { from: Math.PI / 2, speed: 10 }).heel, 0);
});

test('shot follows the naval contract closed form and ends at the sea', () => {
  const b = { p0: [10, 4, -5], v0: [100, 30, 0], t0: 200 };
  const p = R.ballAt(b, 201);
  near(p[0], 110); near(p[1], 4 + 30 - 0.5 * R.G); near(p[2], -5);
  const T = R.ballFlightTime(b);
  near(R.ballAt(b, 200 + T)[1], 0, 1e-6);
});

test('server clock follows the latest event and survives a restart', () => {
  const c = new R.ServerClock();
  c.observe(500, 10);
  near(c.now(11), 501);
  c.observe(503, 12); // a later event raises the estimate
  near(c.now(12), 503);
  c.observe(5, 13); // the server restarted
  near(c.now(14), 6);
});

test('snapshots normalise to drawable vessels (sailing core and naval rows)', () => {
  const own = R.readVessel({ id: 'v1', type: 'large', x: 5, z: 6, yaw: 1, speed: 3, anchored: false, sails: 0.5, hull: { hp: 30, max: 60 }, deck: 'town:31/2' });
  assert.equal(own.cls, 'large'); assert.equal(own.sail, 0.5); assert.equal(own.hullHealth, 0.5); assert.equal(own.location, 'town:31/2');
  const npc = R.readVessel({ id: 'npc:3', kind: 'npc', hull: 'sloop', faction: 'pirate', x: 1, z: 2, yaw: 0, speed: 4, hullHp: 10, maxHull: 40, sailHp: 5, maxSail: 20, state: 'sinking', fire: 2, colours: 'hostile' });
  assert.equal(npc.cls, 'small'); assert.equal(npc.faction, 'pirate'); assert.equal(npc.state, 'sinking'); assert.equal(npc.colours, 'hostile'); assert.equal(npc.sailHealth, 0.25);
  assert.equal(R.readVessel({ id: 'x', hull: 'galleon', x: 0, z: 0 }).cls, 'large');
  assert.equal(R.readVessel({ id: 'x' }), null, 'no chart pose, nothing to draw');
  const w = R.readWind({ from: 1, speed: 7 });
  near(w.from, 1);
  near(R.readWind({ toward: 0, speed: 3 }).from, Math.PI);
});

test('a contact is dead-reckoned between snapshots and snaps on a jump', () => {
  const t = new R.VesselTrack(40);
  t.update({ x: 0, z: 0, yaw: Math.PI / 2, speed: 5, anchored: false }, 0);
  const p = t.predict(1);
  near(p.x, 5); near(p.z, 0, 1e-9);
  t.sample(0, 0.016);
  t.update({ x: 500, z: 0, yaw: 0, speed: 0, anchored: true }, 2);
  near(t.sample(2, 0.016).x, 500);
});

test('sinking takes the hull down over the naval founder time', () => {
  assert.equal(R.sinkPose('afloat', 10).drop, 0);
  assert.ok(R.sinkPose('sinking', 5).drop < R.sinkPose('sinking', 15).drop);
  near(R.sinkPose('sinking', R.SINK_SECONDS).progress, 1);
});

test('deck analysis finds the sail cloth, the mast and the waterline of a model', () => {
  // A hull slab (deck at 6), a mast to 30 and a 10x12 sail sheet high on it, then 2 sea tiles.
  const tris = [];
  const quad = (a, b, c, d) => { tris.push(...a, ...b, ...c, ...a, ...c, ...d); };
  quad([-5, 0, -30], [5, 0, -30], [5, 6, 30], [-5, 6, 30]);
  quad([-5, 6, -30], [5, 6, -30], [5, 6, 30], [-5, 6, 30]);
  quad([-0.3, 6, -5], [0.3, 6, -5], [0.3, 30, -5], [-0.3, 30, -5]);
  quad([-6, 14, -5.5], [6, 14, -5.5], [6, 26, -5.5], [-6, 26, -5.5]);
  const modelTris = tris.length / 9;
  quad([-50, -0.025, -50], [50, -0.025, -50], [50, -0.025, 50], [-50, -0.025, 50]);
  const town = { positions: new Float32Array(tris), spawn: { y: 6, deck: true }, ground: { firstTriangle: modelTris }, source: { regionIndex: 31, locationIndex: 2 } };
  const a = analyseDeck(town);
  assert.equal(a.triangles, modelTris);
  assert.equal(a.sails.length, 1);
  assert.equal(a.sailTriangles.size, 2);
  assert.ok(a.masts.length >= 1 && a.masts[0].top >= 29);
  assert.equal(a.bowYaw, Math.PI);
  assert.ok(a.waterY > 0 && a.waterY < 2);
  const [A, B] = a.sails[0].corners;
  near(A[1], 26, 1e-3); near(B[1], 26, 1e-3); // the yard edge first
  const stripped = stripTriangles(town.positions, a.sailTriangles, a.triangles);
  assert.equal(stripped.length, modelTris * 9);
  assert.deepEqual(triangleRuns([7, 3, 4, 5, 9]), [[3, 3], [7, 1], [9, 1]]);
  assert.equal(quadOutline([[0, 0, 0], [1, 0, 0]]), null);
});

test('coast rings become land with a beach under the water and a closed top', () => {
  const square = [[0, 0], [400, 0], [400, 400], [0, 400]];
  assert.equal(triangulate(square).length, 2);
  const l = [[0, 0], [300, 0], [300, 100], [100, 100], [100, 300], [0, 300]];
  assert.equal(triangulate(l).length, 4);
  assert.ok(Math.abs(ringArea(square)) === 160000);
  const land = buildLand([{ kind: 'island', ring: square.map(([x, z]) => [x + 1e5, z + 2e5]) }]);
  const got = [];
  const solids = { tri: (a, b, c) => got.push(a, b, c) };
  const n = land.draw(solids, (x, y, z) => [x - 1e5, y, z - 2e5], { x: 1e5, z: 2e5 }, 5000);
  assert.ok(n > 8);
  assert.ok(got.some((p) => p[1] < 0) && got.some((p) => p[1] > 5), 'runs from under the sea up to the land');
  const patch = landPatch((x, z) => (x > 0 ? 20 : -5), 0, 0, { size: 400, cells: 8 });
  assert.ok(patch.draw({ tri() {} }, (x, y, z) => [x, y, z]) > 0);
});

test('the sea grid reaches the horizon and stays in 16-bit indices', () => {
  const g = seaGrid();
  assert.ok(g.radius > 3000);
  assert.ok(g.pos.length / 2 < 65536);
});

test('a clipped shoreNear ring gets no beach along the query window', () => {
  const coast = R.readCoast({ centre: { x: 0, z: 0 }, radius: 1000, rings: [{ kind: 'land', clipped: true, ring: [[200, -1000], [1000, -1000], [1000, 1000], [200, 1000], [150, 0]] }] });
  assert.equal(coast.length, 1);
  assert.equal(coast[0].window.r, 1000);
  const land = buildLand(coast);
  const edges = land.pieces[0].tris.filter((t) => t[0][1] < 0); // underwater apron triangles
  assert.equal(edges.length, 2 * 2); // only the two real shore edges (of five) are aproned
});
