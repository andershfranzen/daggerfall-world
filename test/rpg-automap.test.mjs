// Local automap (client/gameplay/automap.js + automap/model.js + automap/controller.js).
// Fixtures are tiny hand-written triangle lists, not game data.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeView, worldToScreen, screenToWorld, headingVector, compassName, zoomAt, panBy, fitView, viewTransform,
  buildAutomap, detectFloors, floorIndexFor, sliceFor, visiblePieces, locationKind, doorMarkers, SLICE_ABOVE_FLOOR,
} from '../client/gameplay/automap/model.js';
import { createAutomapController, meshLocation } from '../client/gameplay/automap/controller.js';
import { packCells } from '../client/gameplay/automap/memory.js';
import { createGameplayApi } from '../client/gameplay/api.js';
import * as automapFeature from '../client/gameplay/automap.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

/** Horizontal square floor of side `s` at height y centred at (cx, cz), two upward triangles. */
function floorQuad(y, cx = 0, cz = 0, s = 10) {
  const h = s / 2;
  const a = [cx - h, y, cz - h], b = [cx + h, y, cz - h], c = [cx + h, y, cz + h], d = [cx - h, y, cz + h];
  // CCW seen from above (+y): a, d, c then a, c, b
  return [...a, ...d, ...c, ...a, ...c, ...b];
}
/** Vertical wall from (x0,z0) to (x1,z1) between y0 and y1. */
function wall(x0, z0, x1, z1, y0, y1) {
  return [x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y1, z0];
}
const mesh = (...parts) => ({ positions: new Float32Array(parts.flat()) });

test('projection: north (−z) is up the screen, east (+x) is right', () => {
  const v = makeView({ centerX: 10, centerZ: 20, scale: 4, width: 200, height: 100 });
  assert.deepEqual(worldToScreen(v, 10, 20), [100, 50]);
  const [nx, ny] = worldToScreen(v, 10, 15); // 5 m north
  assert.equal(nx, 100);
  assert.ok(ny < 50);
  assert.equal(ny, 30);
  const [ex, ey] = worldToScreen(v, 15, 20); // 5 m east
  assert.equal(ex, 120);
  assert.equal(ey, 50);
  const [wx, wz] = screenToWorld(v, ...worldToScreen(v, -3.5, 7.25));
  close(wx, -3.5); close(wz, 7.25);
  const [a, b, c, d, e, f] = viewTransform(v);
  assert.deepEqual([a * 15 + c * 20 + e, b * 15 + d * 20 + f], [120, 50]);
});

test('player heading: yaw 0 points up (north), π/2 right (east), π down', () => {
  let [dx, dy] = headingVector(0);
  close(dx, 0); close(dy, -1);
  [dx, dy] = headingVector(Math.PI / 2);
  close(dx, 1); close(dy, 0);
  [dx, dy] = headingVector(Math.PI);
  close(dx, 0); close(dy, 1);
  assert.equal(compassName(0), 'north');
  assert.equal(compassName(Math.PI / 2), 'east');
  assert.equal(compassName(-Math.PI / 2), 'west');
  assert.equal(compassName(-Math.PI / 4), 'north-west');
});

test('zoom keeps the point under the cursor; pan moves content with the pointer; fit shows everything', () => {
  const v = makeView({ centerX: 0, centerZ: 0, scale: 4, width: 400, height: 300 });
  const before = screenToWorld(v, 300, 100);
  const z = zoomAt(v, 2, 300, 100);
  assert.equal(z.scale, 8);
  const after = screenToWorld(z, 300, 100);
  close(after[0], before[0]); close(after[1], before[1]);
  const p = panBy(v, 40, 0);
  assert.deepEqual(worldToScreen(p, 0, 0), [240, 150]);
  const f = fitView({ minX: -50, maxX: 50, minZ: -20, maxZ: 80 }, 400, 300, 10);
  for (const [x, zz] of [[-50, -20], [50, 80]]) {
    const [sx, sy] = worldToScreen(f, x, zz);
    assert.ok(sx >= 9.99 && sx <= 390.01 && sy >= 9.99 && sy <= 290.01, `${sx},${sy}`);
  }
});

test('location kind decides whether the plan is sliced into floors', () => {
  assert.equal(locationKind('town:Daggerfall/Gothway Garden'), 'town');
  assert.equal(locationKind("dungeon:Daggerfall/Privateer's Hold"), 'dungeon');
  assert.equal(locationKind('interior:Daggerfall/Gothway Garden/1,2/12'), 'interior');
  assert.equal(locationKind('building:Daggerfall/Gothway Garden/12'), 'interior');
  assert.equal(locationKind(null), 'unknown');
  const town = buildAutomap(mesh(floorQuad(0), floorQuad(6)), { kind: 'town' });
  assert.equal(town.sliced, false);
  assert.deepEqual(town.floors, []);
  assert.deepEqual(sliceFor(town, 0), { top: Infinity, below: -Infinity, bottom: -Infinity });
});

test('floors: storeys are detected from walkable area and the player floor follows feet height', () => {
  const m = mesh(
    floorQuad(0, 0, 0, 20), floorQuad(4, 0, 0, 16), floorQuad(8.5, 0, 0, 12),
    floorQuad(0.3, 30, 0, 1), // small step: too close to the ground floor to be its own storey
    wall(-10, -10, 10, -10, 0, 12),
  );
  const map = buildAutomap(m, { kind: 'interior' });
  assert.equal(map.sliced, true);
  assert.deepEqual(map.floors.map((f) => f.y), [0, 4, 8.5]);
  assert.equal(floorIndexFor(map.floors, 0), 0);
  assert.equal(floorIndexFor(map.floors, 4.1), 1);
  assert.equal(floorIndexFor(map.floors, 3.8), 1); // on the stairs just below the landing
  assert.equal(floorIndexFor(map.floors, 20), 2);
  assert.deepEqual(detectFloors([]), []);
});

test('floor filtering: geometry above the viewed floor is cut, lower floors are dimmed', () => {
  const m = mesh(floorQuad(0, 0, 0, 20), floorQuad(4, 0, 0, 16), floorQuad(8, 0, 0, 12),
    wall(-8, -8, 8, -8, 0, 3.5), wall(-8, 8, 8, 8, 4, 7.5), wall(-6, 6, 6, 6, 8, 11.5));
  const map = buildAutomap(m, { kind: 'dungeon' });
  const at = (floorY) => {
    const shown = visiblePieces(map, sliceFor(map, floorY));
    return {
      current: shown.filter((s) => s.mode === 'current').map((s) => `${s.piece.kind}@${s.piece.yMin}`),
      below: shown.filter((s) => s.mode === 'below').map((s) => `${s.piece.kind}@${s.piece.yMin}`),
      maxY: Math.max(...shown.map((s) => s.piece.yMin)),
    };
  };
  const ground = at(0);
  assert.ok(ground.maxY <= 0 + SLICE_ABOVE_FLOOR, 'nothing above the ground storey');
  assert.ok(ground.current.includes('fill@0') && ground.current.includes('wall@0'));
  assert.deepEqual(ground.below, []);
  const middle = at(4);
  assert.ok(middle.current.includes('fill@4') && middle.current.includes('wall@4'));
  assert.ok(!middle.current.includes('fill@8') && !middle.below.includes('fill@8'), 'upper storey hidden');
  assert.ok(middle.below.includes('fill@0'), 'ground storey dimmed below');
  const top = at(8);
  assert.ok(top.current.includes('fill@8') && top.below.includes('fill@4'));
  // Far deeper levels are hidden rather than piled up under the current one.
  const deep = buildAutomap(mesh(floorQuad(-30, 0, 0, 20), floorQuad(0, 0, 0, 20)), { kind: 'dungeon' });
  const shownDeep = visiblePieces(deep, sliceFor(deep, 0)).map((v) => v.piece.yMin);
  assert.ok(!shownDeep.includes(-30), 'a level 30 m down is not drawn');
});

test('plan colours come from the scene atlas and alpha-tested faces are skipped', () => {
  const positions = new Float32Array([...floorQuad(0), ...floorQuad(1, 20, 0)]);
  // 2x1 atlas: left texel opaque blue-grey, right texel transparent.
  const atlas = { width: 2, height: 1, pixels: new Uint8Array([60, 90, 120, 255, 0, 0, 0, 0]) };
  const uv = new Float32Array(4 * 6);
  for (let i = 0; i < 12; i += 2) { uv[i] = 0.25; uv[i + 1] = 0.5; } // first quad -> left texel
  for (let i = 12; i < 24; i += 2) { uv[i] = 0.75; uv[i + 1] = 0.5; } // second quad -> transparent
  const map = buildAutomap({ positions, uv, atlas }, { kind: 'town' });
  const fills = map.pieces.filter((p) => p.kind === 'fill');
  assert.equal(fills.length, 1);
  assert.equal(fills[0].data.length, 12);
  assert.deepEqual(fills[0].colour, [60, 96, 120]);
  assert.throws(() => buildAutomap({ positions: new Float32Array(0) }), /no geometry/);
});

test('doors from interior scenes become markers in output space', () => {
  const out = doorMarkers([
    { type: 3, centre: [1, 0, 5], normal: [0, 0, 1] }, // Unity space: z north -> output −z
    { type: 1, x: 2, y: 0, z: 3 },
    { type: 0, x: 0, z: 0 },
  ]);
  assert.deepEqual(out.map((d) => [d.label, d.x, d.z]), [['Exit', 1, -5], ['Door', 2, 3]]);
});

test('controller: map change resets the plan and view; the player indicator tracks position and yaw', () => {
  let builds = 0;
  const ctl = createAutomapController({ build: (m, o) => { builds++; return buildAutomap(m, o); } });
  ctl.resize(400, 300);
  ctl.setLocation('town:Daggerfall/Gothway Garden');
  ctl.setScene(mesh(floorQuad(0, 0, 0, 100)));
  assert.equal(ctl.kind, 'town');
  ctl.ensureMap();
  ctl.ensureMap();
  assert.equal(builds, 1, 'plan is built once per scene');

  ctl.setCamera({ x: 12, y: 1.6, z: -8, yaw: Math.PI / 2 });
  let me = ctl.playerMarker();
  assert.deepEqual([me.x, me.y], [200, 150], 'following keeps the player centred');
  close(me.dx, 1); close(me.dy, 0);
  assert.match(ctl.describe(), /facing east/);

  ctl.pan(100, 0); // stop following, player moves right on screen
  me = ctl.playerMarker();
  assert.equal(me.x, 300);
  ctl.setCamera({ x: 12, y: 1.6, z: -18, yaw: 0 }); // walk 10 m north
  me = ctl.playerMarker();
  assert.ok(me.y < 150, 'walking north moves the marker up');
  close(me.dy, -1);
  ctl.recenter();
  me = ctl.playerMarker();
  assert.deepEqual([me.x, me.y], [200, 150]);

  // Entering a dungeon: old plan dropped, new kind, floors follow the player.
  const v0 = ctl.version;
  assert.equal(ctl.setLocation("dungeon:Daggerfall/Privateer's Hold"), true);
  assert.ok(ctl.version > v0);
  assert.equal(ctl.map, null);
  assert.equal(ctl.kind, 'dungeon');
  ctl.setScene(mesh(floorQuad(-6, 0, 0, 30), floorQuad(0, 0, 0, 30)));
  ctl.ensureMap();
  assert.equal(builds, 2);
  assert.equal(ctl.floors.length, 0, 'indoors, storeys this character has not explored are not listed');
  ctl.applyExplored({ location: "dungeon:Daggerfall/Privateer's Hold", cells: packCells([[0, 0, -12], [0, 0, 0]]), full: true });
  assert.equal(ctl.floors.length, 2);
  ctl.setCamera({ x: 0, y: -6 + 1.6, z: 0, yaw: 0 });
  assert.equal(ctl.playerFloor(), 0);
  assert.equal(ctl.viewedFloor(), 0);
  ctl.stepFloor(1);
  assert.equal(ctl.viewedFloor(), 1);
  assert.equal(ctl.slice().top, 0 + SLICE_ABOVE_FLOOR);
  ctl.stepFloor(5);
  assert.equal(ctl.viewedFloor(), 1, 'clamped to the top floor');
  ctl.recenter();
  assert.equal(ctl.floor, null, 'recentre returns to the player floor');
  assert.equal(ctl.setLocation("dungeon:Daggerfall/Privateer's Hold"), false, 'same location is not a change');
});

test('install(api) registers the automap panel and follows scene and frame events', () => {
  const api = createGameplayApi({ send: () => true });
  const handle = automapFeature.install(api);
  const panel = api.getPanel('automap');
  assert.ok(panel, 'automap panel registered');
  assert.equal(panel.title, 'Automap');
  assert.equal(panel.key, 'KeyN');
  assert.ok(api.getPanel('map') === null, 'region map panel left to the travel feature');
  const ctl = handle.controller;
  api._receiveRpg({ type: 'rpg', character: { location: 'town:Daggerfall/Gothway Garden' } });
  assert.equal(ctl.location, 'town:Daggerfall/Gothway Garden');
  api.setScene(mesh(floorQuad(0, 0, 0, 50)));
  return Promise.resolve().then(() => {
    assert.ok(ctl.mesh, 'scene mesh received');
    api.emit('frame', { camera: { x: 3, y: 1.6, z: 4, yaw: 0 } });
    assert.deepEqual([ctl.player.x, ctl.player.z], [3, 4]);
    api._receiveRpg({ type: 'rpg', character: { location: 'interior:Daggerfall/Gothway Garden/0,1/3' } });
    assert.equal(ctl.kind, 'interior');
    assert.equal(ctl.mesh, null, 'old town plan discarded on map change');
  });
});

test('map change works whichever arrives first: the scene mesh or the location', () => {
  const town = { ...mesh(floorQuad(0)), region: 'Daggerfall', name: 'Gothway Garden' };
  const dungeon = { ...mesh(floorQuad(0)), kind: 'dungeon', location: "dungeon:Daggerfall/Privateer's Hold", name: "Privateer's Hold" };
  assert.equal(meshLocation(town), 'town:Daggerfall/Gothway Garden');
  assert.equal(meshLocation(dungeon), "dungeon:Daggerfall/Privateer's Hold");

  // Shell start-up: scene first, then the first RPG state names the location. The town plan survives.
  const ctl = createAutomapController();
  ctl.setScene(town);
  ctl.setLocation('town:Daggerfall/Gothway Garden');
  assert.equal(ctl.mesh, town);
  assert.equal(ctl.kind, 'town');

  // Travel into the dungeon with the scene landing before the location update.
  ctl.setScene(dungeon);
  assert.equal(ctl.kind, 'dungeon');
  assert.equal(ctl.location, "dungeon:Daggerfall/Privateer's Hold");
  ctl.setLocation("dungeon:Daggerfall/Privateer's Hold");
  assert.equal(ctl.mesh, dungeon, 'the dungeon plan is kept when its location arrives');
  assert.equal(ctl.ensureMap().sliced, true);

  // A stale town mesh still on screen (frame path) never relabels the dungeon.
  assert.equal(ctl.setScene(town, { adopt: false }), false);
  assert.equal(ctl.kind, 'dungeon');

  // Back out: location first; the dungeon mesh no longer applies and is not drawn under the town.
  ctl.setLocation('town:Daggerfall/Gothway Garden');
  assert.equal(ctl.mesh, null);
  assert.match(ctl.describe(), /once this place has loaded/);
  ctl.setScene(town);
  assert.equal(ctl.ensureMap().sliced, false);
});
