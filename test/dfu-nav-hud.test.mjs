// Comprehensive unit & integration tests for DFU Navigation, Controls, Localization,
// Quickslots, Contextual Help, HUD Conveniences, Road-Following, Touch Controls & Local ZIP Loader.
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { buildAutomap } from '../client/gameplay/automap/model.js';
import { createAutomapController } from '../client/gameplay/automap/controller.js';
import { packCells } from '../client/gameplay/automap/memory.js';
import {
  make3DView, project3D, orbit3D, pan3D, build3DDrawList,
  unproject3D, viewProjection3D, cameraPosition3D, fit3D, build3DScene, exploredMask, framePoints, FACE,
} from '../client/gameplay/automap/view3d.js';
import {
  loadAutomapPrefs, saveAutomapPrefs, resetAutomapPrefs, DEFAULT_AUTOMAP_PREFS,
} from '../client/gameplay/automap/prefs.js';
import {
  DEFAULT_MOVE_BINDINGS, normalizeMoveBindings, rebindMove,
  DEFAULT_GAMEPAD_SETTINGS, normalizeGamepadSettings, mapGamepadAxes,
  normalizeCameraPrefs, normalizeHudLayout, clampHudOffset,
  exportSettingsJson, importSettingsJson, loadSettings, saveSettings,
} from '../client/gameplay/shell.js';
import { PAD } from '../client/input.js';
import {
  t, setLocale, getLocale, listLocales, registerLocalePack, translateServerMessage,
  getLocaleMeta,
} from '../client/lib/i18n.js';
import {
  autoPopulateQuickslots, quickslotCandidates, quickslotActivation,
  arrowStatusOf, soonestQuestDeadline, formatCountdown, restWarningsFor,
  dungeonWagonPrompt, tutorialStepsFor, buildHelpEntries, filterHelpEntries,
  install as installQuickslots,
} from '../client/gameplay/quickslots.js';
import {
  planRoadRoute, stepRoadGuidance, selectJunctionBranch, install as installRoadFollow,
} from '../client/gameplay/travel/road-follow.js';
import {
  parseZipEntries, extractArena2FromZip, computeStickVector, createTouchState,
  install as installTouch,
} from '../client/lib/touch.js';
import { createGameplayApi } from '../client/gameplay/api.js';

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function floorQuad(y, cx = 0, cz = 0, s = 12) {
  const h = s / 2;
  const a = [cx - h, y, cz - h], b = [cx + h, y, cz - h], c = [cx + h, y, cz + h], d = [cx - h, y, cz + h];
  return [...a, ...d, ...c, ...a, ...c, ...b];
}
function rampQuad(y0, y1, cx = 0, cz = 0, s = 8) {
  const h = s / 2;
  const a = [cx - h, y0, cz - h], b = [cx + h, y0, cz - h], c = [cx + h, y1, cz + h], d = [cx - h, y1, cz + h];
  return [...a, ...d, ...c, ...a, ...c, ...b];
}
function wallQuad(x0, z0, x1, z1, y0, y1) {
  return [x0, y0, z0, x1, y0, z1, x1, y1, z1, x0, y0, z0, x1, y1, z1, x0, y1, z0];
}

/** Build a real ZIP archive buffer supporting Stored (0) and Deflate (8) entries. */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { path, data, compress = false } of entries) {
    const nameBuf = Buffer.from(path, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const method = compress ? 8 : 0;
    const payload = compress ? zlib.deflateRawSync(raw) : raw;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return new Uint8Array(Buffer.concat([...locals, cdBuf, eocd]));
}

// ================================================================== 1. Rotatable 3D Automap & Prefs

test('3D automap projects stacked rooms and ramps, respects fog and slice, and orbits/tilts cleanly', () => {
  const m = {
    positions: new Float32Array([
      ...floorQuad(0, 0, 0, 14),
      ...floorQuad(4, 0, 0, 10),
      ...rampQuad(0, 4, 8, 0, 6),
      ...wallQuad(-7, -7, 7, -7, 0, 3.8),
    ]),
  };
  const ctl = createAutomapController();
  ctl.resize(640, 420);
  ctl.setLocation("dungeon:Daggerfall/Privateer's Hold");
  ctl.setScene(m);
  ctl.ensureMap();
  // Reveal cells on floor 0 (including room centroid & wall) and ramp
  ctl.applyExplored({
    location: "dungeon:Daggerfall/Privateer's Hold",
    cells: packCells([[0, 0, 0], [1, -2, 0], [-2, 1, 0], [3, 0, 4], [4, 0, 4], [0, 0, 8], [-3, -4, 0]]),
    full: true,
  });
  ctl.setCamera({ x: 0, y: 1.6, z: 0, yaw: 0 });

  assert.equal(ctl.viewMode, '2d');
  assert.equal(ctl.setViewMode('3d'), true);
  const v0 = ctl.view3d();
  const pCenter = project3D(v0, 0, 0, 0);
  assert.equal(pCenter.visible, true);
  assert.ok(Math.abs(pCenter.sx - 320) < 1 && Math.abs(pCenter.sy - 210) < 1);

  // Orbit yaw and pitch clamping
  const beforeYaw = ctl.orbitYaw;
  ctl.orbit(0.4, 0.25);
  assert.ok(Math.abs(ctl.orbitYaw - beforeYaw) > 0.3);
  ctl.orbit(0, 10);
  assert.ok(ctl.orbitPitch <= 1.48);
  ctl.orbit(0, -10);
  assert.ok(ctl.orbitPitch >= 0.18);

  // Panning in 3D moves target on XZ plane and disables follow
  ctl.pan(30, -20);
  assert.equal(ctl.follow, false);
  const panTest = pan3D(make3DView({ width: 640, height: 420 }), 40, 0);
  assert.notEqual(panTest.centerX, 0);

  // Build 3D draw list respecting explored fog & adjustable slice
  const v3 = ctl.view3d();
  const drawFog = build3DDrawList(ctl.map, ctl.slice(), v3, { fog: true, seen: (x, z, y) => ctl.seen(x, z, y) });
  assert.ok(drawFog.count > 0, '3D draw list contains explored polygons');
  assert.ok(drawFog.polys.some((p) => p.kind === 'fill'), '3D draw list has floor fills');
  // Sorted back-to-front (painter order)
  for (let i = 1; i < drawFog.polys.length; i++) {
    assert.ok(drawFog.polys[i - 1].depth >= drawFog.polys[i].depth);
  }

  // Adjustable slice offset shifts slice top/below and persists when rememberSlice is on
  const sliceBefore = ctl.slice().top;
  ctl.stepSliceOffset(2);
  assert.equal(ctl.sliceOffset, 2);
  assert.equal(ctl.slice().top, sliceBefore + 2);
  assert.equal(ctl.prefs.savedSlices["dungeon:Daggerfall/Privateer's Hold"].sliceOffset, 2);

  // Recenter restores follow and resets slice offset
  ctl.recenter({ resetOrbit: true });
  assert.equal(ctl.follow, true);
  assert.equal(ctl.sliceOffset, 0);
});

/** A level rectangle x0..x1, z0..z1 at height y, facing up (two triangles). */
function rectQuad(y, x0, z0, x1, z1) {
  const a = [x0, y, z0], b = [x1, y, z0], c = [x1, y, z1], d = [x0, y, z1];
  return [...a, ...d, ...c, ...a, ...c, ...b];
}
/** The same rectangle facing down (a ceiling seen from inside the room). */
function ceilingQuad(y, x0, z0, x1, z1) {
  const a = [x0, y, z0], b = [x1, y, z0], c = [x1, y, z1], d = [x0, y, z1];
  return [...a, ...c, ...d, ...a, ...b, ...c];
}
/** A closed 14 m room, 4 m high, every face turned inward like a dungeon shell. */
function roomShell() {
  return [
    ...rectQuad(0, -7, -7, 7, 7), ...ceilingQuad(4, -7, -7, 7, 7),
    ...wallQuad(-7, -7, 7, -7, 0, 4), ...wallQuad(7, 7, -7, 7, 0, 4), // north wall faces south, south wall faces north
    ...wallQuad(-7, 7, -7, -7, 0, 4), ...wallQuad(7, -7, 7, 7, 0, 4), // west wall faces east, east wall faces west
  ];
}

test('3D camera: north is up, the clip matrix matches the marker projection, and pixels unproject onto the floor', () => {
  const top = make3DView({ orbitYaw: 0, orbitPitch: 0.8, width: 800, height: 500 });
  assert.ok(project3D(top, 0, 0, -5).sy < 250, 'north of the target is up the screen');
  assert.ok(project3D(top, 5, 0, 0).sx > 400, 'east is to the right (not mirrored)');
  assert.ok(project3D(top, 0, 3, 0).sy < 250, 'height rises up the screen');
  assert.ok(cameraPosition3D(top)[1] > 0, 'the camera is above the floor');
  assert.ok(cameraPosition3D(top)[2] > 0, 'and south of the target at yaw 0');

  const view = make3DView({ centerX: 3, centerY: 2, centerZ: -5, orbitYaw: 0.65, orbitPitch: 0.72, scale: 5, width: 800, height: 500 });
  const m = viewProjection3D(view, 0.5, 1000);
  for (const p of [[3, 2, -5], [10, 4, -12], [-7, 0, 3], [20, 9, 9]]) {
    const a = project3D(view, ...p);
    const c = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
    assert.ok(Math.abs((c[0] / c[3] * 0.5 + 0.5) * 800 - a.sx) < 1e-3, 'clip x matches project3D');
    assert.ok(Math.abs((1 - (c[1] / c[3] * 0.5 + 0.5)) * 500 - a.sy) < 1e-3, 'clip y matches project3D');
    assert.ok(Math.abs(c[3] - a.depth) < 1e-3, 'clip w is the depth');
    assert.ok(c[2] / c[3] > -1 && c[2] / c[3] < 1, 'inside the depth range');
    const [x, z] = unproject3D(view, a.sx, a.sy, p[1]);
    assert.ok(Math.abs(x - p[0]) < 1e-3 && Math.abs(z - p[2]) < 1e-3, 'a pixel unprojects to the point on its plane');
  }
  assert.equal(unproject3D(view, 400, -1e6, 2), null, 'a ray above the horizon misses the floor');

  // Dragging right carries the content right: the target moves the other way along the screen's right axis.
  const p0 = project3D(view, 3, 2, -5);
  const moved = pan3D(view, 40, -25);
  const p1 = project3D(moved, 3, 2, -5);
  assert.ok(Math.abs(p1.sx - p0.sx - 40) < 4 && Math.abs(p1.sy - p0.sy + 25) < 4, 'pan follows the pointer (to within perspective)');

  // Framing: every point ends up inside the canvas, and the outline fills it in at least one direction.
  const pts = new Float32Array([-20, 0, -40, 30, 0, -40, 30, 4, 10, -20, 0, 10, 5, 2, -15]);
  const fitted = fit3D(view, pts, { pad: 40 });
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const p = project3D(fitted, pts[i], pts[i + 1], pts[i + 2]);
    x0 = Math.min(x0, p.sx); x1 = Math.max(x1, p.sx); y0 = Math.min(y0, p.sy); y1 = Math.max(y1, p.sy);
  }
  assert.ok(x0 >= 38 && x1 <= 762 && y0 >= 38 && y1 <= 462, 'the framed outline is inside the padded canvas');
  assert.ok(x1 - x0 > 700 || y1 - y0 > 400, 'and fills the canvas (no postage stamp)');
  assert.ok(Math.abs((x0 + x1) / 2 - 400) < 3 && Math.abs((y0 + y1) / 2 - 250) < 3, 'centred on screen');
});

test('3D architecture: flat polygons have no diagonal or T-junction seams, faces are classed and culled, cutaway clips', () => {
  // A closed room: 12 structural edges (the box), none of the 6 quad diagonals.
  const room = { positions: new Float32Array(roomShell()) };
  const scene = build3DScene(room, { kind: 'dungeon' });
  assert.equal(scene.count, 12);
  assert.equal(scene.edgeCrease.length, 12, 'only the box edges are drawn');
  for (let e = 0; e < 12; e++) {
    const d = [0, 1, 2].filter((k) => Math.abs(scene.edges[e * 6 + k] - scene.edges[e * 6 + 3 + k]) > 1e-6);
    assert.equal(d.length, 1, 'every drawn edge is axis-aligned: no triangle diagonal');
  }
  const count = (s, c) => [...s.cls].filter((v) => v === c).length;
  assert.deepEqual([count(scene, FACE.FLOOR), count(scene, FACE.WALL), count(scene, FACE.CEILING)], [2, 8, 2]);

  // Looking down from outside, the ceiling and the two near walls are culled: the room is open to the viewer.
  const map = buildAutomap(room, { kind: 'dungeon' });
  const view = make3DView({ centerY: 0, orbitYaw: 0.65, orbitPitch: 0.8, scale: 6, width: 640, height: 420 });
  const whole = build3DDrawList(map, { top: Infinity, below: -Infinity, bottom: -Infinity }, view);
  const fills = whole.polys.filter((p) => p.kind === 'fill');
  assert.equal(fills.filter((p) => p.cls === FACE.CEILING).length, 0, 'the ceiling faces away and is culled');
  assert.equal(fills.filter((p) => p.cls === FACE.FLOOR).length, 2);
  assert.equal(fills.filter((p) => p.cls === FACE.WALL).length, 4, 'only the two far walls (inner faces) remain');
  assert.ok(fills.every((p) => p.alpha === 1), 'faces are opaque: no translucent overdraw');
  assert.ok(whole.polys.some((p) => p.kind === 'edge'), 'structural edges are drawn');
  // Both triangles of a flat polygon get exactly the same colour.
  const floorColours = new Set(fills.filter((p) => p.cls === FACE.FLOOR).map((p) => p.colour.join(',')));
  assert.equal(floorColours.size, 1, 'a floor is one flat colour across its triangles');
  // Cutaway at 1.8 m: walls are clipped to the plane, nothing reaches above it.
  const cut = build3DDrawList(map, { top: 1.8, below: -0.75, bottom: -10 }, view);
  const topRow = project3D(view, 0, 1.8, -7).sy;
  const wallTop = Math.min(...cut.polys.filter((p) => p.cls === FACE.WALL).flatMap((p) => p.pts.map((q) => q[1])));
  assert.ok(wallTop > project3D(view, 7, 4, -7).sy + 5, 'walls no longer reach their full height');
  assert.ok(Number.isFinite(topRow));
  // From underneath nothing of the floor shows (it faces up), as with any single-sided shell.
  for (let i = 1; i < cut.polys.length; i++) assert.ok(cut.polys[i - 1].depth >= cut.polys[i].depth, 'far to near');

  // T-junction: one long floor polygon meeting two half-length neighbours shows no line where they meet.
  const tj = build3DScene({ positions: new Float32Array([...rectQuad(0, -6, -6, 0, 6), ...rectQuad(0, 0, -6, 6, 0), ...rectQuad(0, 0, 0, 6, 6)]) }, { kind: 'dungeon' });
  for (let e = 0; e < tj.edgeCrease.length; e++) {
    const onSeam = Math.abs(tj.edges[e * 6]) < 1e-6 && Math.abs(tj.edges[e * 6 + 3]) < 1e-6;
    const interior = Math.abs(tj.edges[e * 6 + 2]) < 1e-6 && Math.abs(tj.edges[e * 6 + 5]) < 1e-6;
    assert.ok(!onSeam && !interior, 'no edge inside the flat floor');
  }
  assert.equal(tj.edgeCrease.length, 7, 'only the outline of the floor remains');
  assert.equal(new Set(Array.from({ length: tj.count }, (_, t) => [...tj.colour.subarray(t * 3, t * 3 + 3)].join(','))).size, 1);

  // Stairs and ramps climb between levels; a short steep strip at the foot of a wall is part of the wall.
  const strip = (x0, x1, y0, y1, z0, z1) => [x0, y0, z0, x0, y1, z1, x1, y1, z1, x0, y0, z0, x1, y1, z1, x1, y0, z0];
  const slopes = build3DScene({ positions: new Float32Array([...strip(0, 4, 0, 4, 0, 8), ...strip(10, 14, 0, 0.6, 0, 0.6)]) }, { kind: 'dungeon' });
  assert.deepEqual([...slopes.cls], [FACE.RAMP, FACE.RAMP, FACE.WALL, FACE.WALL]);
  // Outdoors a slope is a roof: no ramp class in towns.
  assert.equal(count(build3DScene({ positions: new Float32Array(strip(0, 4, 0, 4, 0, 8)) }, { kind: 'town' }), FACE.RAMP), 0);

  // Action doors are picked out by their triangle range.
  const doors = build3DScene({ positions: new Float32Array(roomShell()), actionDoors: [{ firstTriangle: 4, triangleCount: 2 }] }, { kind: 'dungeon' });
  assert.equal(count(doors, FACE.DOOR), 2);

  // Exploration: only faces over explored cells (2 m squares) show; the framing outline follows them.
  const two = { positions: new Float32Array([...rectQuad(0, 0, 0, 4, 4), ...rectQuad(0, 40, 40, 44, 44)]) };
  const sc = build3DScene(two, { kind: 'dungeon' });
  const mask = exploredMask(sc, new Map([['0,0', [0]], ['1,1', [0]]]));
  assert.deepEqual([...mask], [1, 1, 0, 0]);
  const outline = framePoints(sc, mask);
  for (let i = 0; i < outline.length; i += 3) assert.ok(outline[i] <= 4 && outline[i + 2] <= 4, 'unexplored ground is not framed');
});

test('3D framing: opens on the explored area, keeps a camera the player placed, and recentres on request', () => {
  const ctl = createAutomapController();
  const loc = 'dungeon:Daggerfall/Test Hold';
  ctl.resize(900, 500);
  ctl.setLocation(loc);
  ctl.setScene({ positions: new Float32Array([...roomShell(), ...rectQuad(0, 7, -2, 30, 2)]) });
  ctl.ensureMap();
  const cells = [];
  for (let ix = -4; ix <= 15; ix++) for (let iz = -4; iz <= 3; iz++) cells.push([ix, iz, 0]);
  ctl.applyExplored({ location: loc, cells: packCells(cells), full: true });
  ctl.setCamera({ x: -5, y: 1.6, z: -5, yaw: 0 });
  assert.equal(ctl.frame3d(), false, 'nothing to frame in the 2D plan');
  ctl.setViewMode('3d');
  assert.equal(ctl.framing, 'auto');
  assert.equal(ctl.frame3d(), true);
  assert.equal(ctl.follow, false, 'the explored area is framed whole, off the player');
  const v = ctl.view3d();
  const pts = ctl.outline3d();
  let x0 = Infinity, x1 = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const p = project3D(v, pts[i], pts[i + 1], pts[i + 2]);
    assert.ok(p.visible && p.sx >= 30 && p.sx <= 870 && p.sy >= 30 && p.sy <= 470, 'everything explored is in view');
    x0 = Math.min(x0, p.sx); x1 = Math.max(x1, p.sx);
  }
  assert.ok(x1 - x0 > 500, 'the plan fills the canvas instead of floating small in a void');

  // The player zooms: later automatic framing leaves their camera alone.
  ctl.zoom(1.5);
  assert.equal(ctl.framing, 'manual');
  const scale = ctl.view.scale;
  assert.equal(ctl.frame3d(), false);
  assert.equal(ctl.view.scale, scale);
  // "Explored" (0) fits on request; C recentres on the player and keeps following.
  ctl.fitAll();
  assert.ok(Math.abs(ctl.view.scale - v.scale) < 1e-6, 'fit returns to the framed zoom');
  ctl.recenter();
  assert.equal(ctl.framing, 'player');
  assert.equal(ctl.follow, true);
  assert.equal(ctl.view.centerX, -5);
  // Cutaway on: the outline (and so the framing) stops at the cut plane.
  const top = ctl.slice().top;
  const out = ctl.outline3d();
  for (let i = 1; i < out.length; i += 3) assert.ok(out[i] <= top + 1e-6);
});

test('independent automap preferences persist separately from exploration memory and handle exterior zoom/reset', () => {
  const storage = memoryStorage();
  const saved = saveAutomapPrefs({
    viewMode: '3d',
    minimapEnabled: true,
    minimapCorner: 'bottom-left',
    minimapSize: 'large',
    rememberSlice: true,
    exteriorDefaultZoom: 4.5,
    exteriorResetOnOpen: true,
  }, storage);
  assert.equal(saved.viewMode, '3d');
  assert.equal(saved.minimapEnabled, true);
  assert.equal(saved.exteriorDefaultZoom, 4.5);

  const loaded = loadAutomapPrefs(storage);
  assert.deepEqual(loaded, saved);

  const ctl = createAutomapController({ prefs: loaded });
  ctl.setLocation('town:Daggerfall/Gothway Garden');
  assert.equal(ctl.view.scale, 4.5);
  ctl.zoom(2);
  assert.equal(ctl.view.scale, 9);
  ctl.resetExteriorView();
  assert.equal(ctl.view.scale, 4.5);

  const reset = resetAutomapPrefs(storage);
  assert.equal(reset.viewMode, DEFAULT_AUTOMAP_PREFS.viewMode);
  assert.equal(reset.minimapEnabled, false);
});

// ================================================================== 2. Remapping, Camera Prefs, Movable HUD, Portable Settings & i18n

test('keyboard movement/look remapping, gamepad remapping, camera prefs, movable HUD & portable settings JSON', () => {
  // Movement/look remapping
  const mb = rebindMove(DEFAULT_MOVE_BINDINGS, 'moveForward', 'KeyI');
  assert.equal(mb.moveForward, 'KeyI');
  // Rebinding another action to KeyI unbinds moveForward cleanly
  const mb2 = rebindMove(mb, 'lookUp', 'KeyI');
  assert.equal(mb2.lookUp, 'KeyI');
  assert.equal(mb2.moveForward, null);
  assert.throws(() => rebindMove(mb2, 'moveBack', 'Escape'), /reserved/);
  assert.equal(normalizeMoveBindings({ moveForward: 'KeyU' }).moveForward, 'KeyU');

  // Gamepad remapping: deadzone, inversion, Southpaw axis swap
  const gp = normalizeGamepadSettings({
    deadzone: 0.2,
    invertLookY: true,
    invertMoveX: true,
    axes: { moveX: 2, moveY: 3, lookX: 0, lookY: 1 },
    buttons: { attack: PAD.RB, interact: PAD.Y },
  });
  assert.equal(gp.buttons.attack, PAD.RB);
  assert.equal(gp.buttons.interact, PAD.Y);
  // Raw within deadzone -> 0
  assert.deepEqual(mapGamepadAxes([0.1, 0.1, 0.05, 0.05], gp), [0, 0, 0, 0]);
  // Swapped & inverted axes
  const mapped = mapGamepadAxes([0.8, 0.8, 1.0, 0], gp);
  assert.ok(mapped[0] < -0.9, 'moveX reads axis 2 and is inverted');
  assert.ok(mapped[2] > 0.5 && mapped[3] < -0.5, 'lookY reads axis 1 and is inverted');

  // Camera & weapon presentation prefs
  const cam = normalizeCameraPrefs({
    mouseSmoothing: 0.5, movementAcceleration: 0.6, headBob: 0,
    handedness: 'left', cameraRecoil: 1.2, weaponGestureSensitivity: 1.8, bowDrawback: true,
  });
  assert.equal(cam.handedness, 'left');
  assert.equal(cam.headBob, 0);
  assert.equal(cam.bowDrawback, true);

  // Movable HUD layout clamping & reset
  const clamped = clampHudOffset(9999, -9999, { maxX: 300, maxY: 200 });
  assert.deepEqual(clamped, { x: 300, y: -200 });
  const layout = normalizeHudLayout({ vitals: { x: 40, y: -30 }, unknownWidget: { x: 10, y: 10 } });
  assert.deepEqual(layout, { vitals: { x: 40, y: -30 } });

  // Portable settings JSON export/import round-trip + persistence
  const storage = memoryStorage();
  const s = loadSettings(storage);
  s.locale = 'ja';
  s.moveBindings.moveForward = 'KeyU';
  s.camera.handedness = 'left';
  s.hudLayout = { vitals: { x: 24, y: -12 } };
  saveSettings(s, storage);
  const reloaded = loadSettings(storage);
  assert.equal(reloaded.locale, 'ja');
  assert.equal(reloaded.moveBindings.moveForward, 'KeyU');
  assert.equal(reloaded.camera.handedness, 'left');
  assert.deepEqual(reloaded.hudLayout, { vitals: { x: 24, y: -12 } });

  const json = exportSettingsJson(reloaded, { automapPrefs: { viewMode: '3d', minimapEnabled: true } });
  const imported = importSettingsJson(json);
  assert.equal(imported.ok, true);
  assert.equal(imported.settings.locale, 'ja');
  assert.equal(imported.settings.camera.handedness, 'left');
  assert.equal(imported.automapPrefs.viewMode, '3d');

  // Invalid JSON / unsupported schema version rejected safely
  assert.equal(importSettingsJson('{bad json').ok, false);
  assert.equal(importSettingsJson(JSON.stringify({ version: 99, settings: {} })).ok, false);
});

test('i18n supports selectable locales, non-Latin scripts (Japanese & Cyrillic), missing-key fallback, and community packs', () => {
  const prev = getLocale();
  try {
    const locales = listLocales();
    assert.ok(locales.some((l) => l.code === 'en'));
    assert.ok(locales.some((l) => l.code === 'ja' && l.script === 'CJK'));
    assert.ok(locales.some((l) => l.code === 'ru' && l.script === 'Cyrillic'));

    setLocale('ja', { persist: false });
    assert.equal(t('menu.settings'), '設定');
    assert.equal(t('hud.arrows', { count: 15 }), '矢: 15');
    // Key omitted from Japanese pack automatically falls back to English
    assert.equal(t('settings.bowDrawback'), 'Classic bow drawback');
    assert.match(getLocaleMeta('ja').fontStack, /Noto Sans CJK JP/);

    setLocale('ru', { persist: false });
    assert.equal(t('menu.character'), 'Персонаж');
    assert.equal(t('settings.mouseSmoothing'), 'Mouse smoothing'); // fallback to English

    // Community pack registration at runtime
    registerLocalePack('ko', {
      name: 'Korean',
      nativeName: '한국어',
      script: 'Hangul',
      fontStack: '"Noto Sans KR", sans-serif',
      messages: { 'menu.settings': '설정' },
    });
    setLocale('ko', { persist: false });
    assert.equal(t('menu.settings'), '설정');
    assert.equal(t('menu.close'), 'Close'); // fallback

    setLocale('es', { persist: false });
    assert.equal(translateServerMessage('Not connected.'), 'Sin conexión — acción no enviada.');
  } finally {
    setLocale(prev, { persist: false });
  }
});

// ================================================================== 3. Quickslots, Contextual Help & HUD Conveniences

test('quickslots populate from inventory and activate weapons/consumables via existing verbs', () => {
  const character = {
    inventory: [
      { id: 'w1', name: 'Iron Longsword', template: 'iron-longsword', slot: 'rightHand' },
      { id: 'w2', name: 'Shortbow', template: 'shortbow', slot: 'rightHand' },
      { id: 'p1', name: 'Potion of Healing', template: 'potion-of-healing', usable: true, quantity: 3 },
      { id: 'a1', name: 'Arrows', template: 'arrow', quantity: 18 },
    ],
    equipment: { rightHand: 'w1' },
  };
  const candidates = quickslotCandidates(character);
  assert.equal(candidates.length, 3);
  const slots = autoPopulateQuickslots(character);
  assert.equal(slots[0].itemId, 'w1'); // equipped weapon first
  assert.equal(slots[1].itemId, 'w2');
  assert.equal(slots[2].itemId, 'p1');

  assert.equal(quickslotActivation(slots[0], character).verb, 'combat.ready');
  assert.equal(quickslotActivation(slots[1], character).verb, 'inventory.equip');
  assert.equal(quickslotActivation(slots[2], character).verb, 'inventory.use');

  // Install feature into gameplay api and verify quickslot activation sends expected verb
  const sent = [];
  const api = createGameplayApi({ send: (verb, args) => { sent.push([verb, args]); return true; } });
  const qs = installQuickslots(api);
  api._receiveRpg({ type: 'rpg', selfId: '42', character });
  assert.ok(api.getPanel('help'), 'Help panel registered');
  assert.equal(qs.activateSlot(2), true);
  assert.deepEqual(sent[0], ['inventory.use', { itemId: 'p1' }]);
});

test('HUD conveniences compute arrow count, quest deadline countdown, rest warnings, dungeon-exit wagon prompt & dynamic tutorial/help', () => {
  const char = {
    location: "dungeon:Daggerfall/Privateer's Hold",
    inventory: [
      { id: 'b1', name: 'Longbow', template: 'longbow', slot: 'rightHand' },
      { id: 'ar1', name: 'Arrow', template: 'arrow', quantity: 4 },
      { id: 'cart1', name: 'Small Cart', template: 'small-cart' },
    ],
    equipment: { rightHand: 'b1' },
    quests: {
      v: 1,
      minutes: 1000,
      active: [{ id: 'q1', title: 'Urgent Delivery', clocks: { limit: { running: true, done: false, endAt: 1500 } } }],
    },
    conditions: { diseases: ['Plague'], poisons: [] },
  };

  const arrows = arrowStatusOf(char);
  assert.equal(arrows.count, 4);
  assert.equal(arrows.bowEquipped, true);
  assert.equal(arrows.low, true);
  assert.equal(arrows.empty, false);

  const dl = soonestQuestDeadline(char, 1000);
  assert.equal(dl.title, 'Urgent Delivery');
  assert.equal(dl.remaining, 500);
  assert.equal(dl.urgent, true);
  assert.equal(formatCountdown(500), '8h 20m left');

  const warns = restWarningsFor(
    { character: char, entities: [{ id: 'm1', kind: 'monster', hp: 20, x: 5, z: 5 }] },
    { x: 0, y: 1.6, z: 0 },
  );
  assert.ok(warns.some((w) => w.code === 'enemies'));
  assert.ok(warns.some((w) => w.code === 'disease'));

  const scene = { exits: [{ x: 2, y: 0, z: 1 }] };
  const wagonNear = dungeonWagonPrompt({ character: char }, { x: 0, y: 1.6, z: 0 }, scene);
  assert.ok(wagonNear && wagonNear.distance <= 5);
  const wagonFar = dungeonWagonPrompt({ character: char }, { x: 40, y: 1.6, z: 40 }, scene);
  assert.equal(wagonFar, null);

  // Tutorial & searchable Help reflect active remapped bindings
  const customSettings = {
    bindings: { ready: 'KeyR', attack: 'KeyH', interact: 'KeyE', settings: 'F9' },
    moveBindings: { moveForward: 'KeyI', strafeLeft: 'KeyJ', moveBack: 'KeyK', strafeRight: 'KeyL' },
    gamepad: { buttons: { interact: PAD.Y, attack: PAD.RB, ready: PAD.X } },
  };
  const steps = tutorialStepsFor(customSettings);
  assert.match(steps[0].body, /I\/J\/K\/L/);
  assert.match(steps[1].body, /Press R/);

  const help = buildHelpEntries(customSettings, { location: "dungeon:Daggerfall/Privateer's Hold" });
  assert.equal(help[0].id, 'ctx-privateer');
  const filtered = filterHelpEntries(help, 'wagon');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'wagon');
});

// ================================================================== 4. Road-Following & Junction Guidance

test('road-following guides continuously from town gate through junction across map-pixel boundaries', () => {
  const route = planRoadRoute({
    from: { px: 109, py: 158, localX: 0, localZ: 0, label: 'Gothway Garden Gate' },
    to: { px: 111, py: 158, localX: 0, localZ: 0, label: 'Daggerfall City' },
  });
  assert.ok(route.waypoints.length >= 3);
  assert.equal(route.waypoints[1].kind, 'junction');
  assert.ok(route.waypoints[1].branches.length >= 2);

  // Standing at town gate facing north (yaw 0), destination is east -> Bear right
  const g1 = stepRoadGuidance(route, { pixel: { px: 109, py: 158 }, x: 0, z: 0, yaw: 0 });
  assert.equal(g1.compass.short, 'E');
  assert.equal(g1.steerCue, 'Bear right');

  // Approaching junction (within 30m) facing east (π/2) -> On road + activeJunction offered
  const jwp = route.waypoints[1];
  const gJunc = stepRoadGuidance(route, { pixel: { px: jwp.px, py: jwp.py }, x: -42, z: 0, yaw: Math.PI / 2 });
  assert.equal(gJunc.steerCue, 'On road');
  assert.ok(gJunc.activeJunction, 'junction branch prompt triggered');

  // Crossing pixel boundary into 111,158 and arriving at destination
  const gCross = stepRoadGuidance(route, { pixel: { px: 110, py: 158 }, x: 0, z: 0, yaw: Math.PI / 2 });
  assert.ok(gCross.crossingsPassed >= 1);
  const gArrive = stepRoadGuidance(route, { pixel: { px: 111, py: 158 }, x: 10, z: 0, yaw: Math.PI / 2 });
  assert.equal(gArrive.arrived, true);

  // Branch selection reroutes cleanly
  const r2 = planRoadRoute({ from: { px: 109, py: 158 }, to: { px: 111, py: 158 } });
  const rerouted = selectJunctionBranch(r2, 'left', { px: 110, py: 158 }, 0, 0);
  assert.notEqual(rerouted.destination, r2.destination);

  // Feature install exposes api.roadFollow
  const api = createGameplayApi({ send: () => true });
  const rf = installRoadFollow(api);
  api._receiveRpg({ type: 'rpg', character: { location: 'wilderness:109,158' } });
  api.camera = { x: 0, y: 1.6, z: 0, yaw: Math.PI / 2 };
  const active = rf.startRoute({ px: 110, py: 158, label: 'East Crossing' });
  assert.ok(active && rf.guidance);
});

// ================================================================== 5. Phone Touch Controls & Local ARENA2 ZIP Loader

test('touch thumbstick math handles deadzone, walk/run zones, look accumulation, and local ARENA2 ZIP extraction', async () => {
  assert.deepEqual(computeStickVector(2, 2, 56), { forward: 0, strafe: 0, running: false, magnitude: 0, clampedX: 0, clampedY: 0 });
  const walk = computeStickVector(0, -28, 56);
  assert.ok(walk.forward > 0.3 && walk.forward < 0.7);
  assert.equal(walk.running, false);
  const run = computeStickVector(0, -56, 56);
  assert.equal(run.forward, 1);
  assert.equal(run.running, true);

  const ts = createTouchState();
  ts.addLook(20, -10, 0.01, false);
  const d = ts.consumeLook();
  assert.ok(Math.abs(d.yaw - 0.2) < 1e-6 && Math.abs(d.pitch - 0.1) < 1e-6);
  assert.deepEqual(ts.consumeLook(), { yaw: 0, pitch: 0 });

  // Local ARENA2 ZIP loader: Stored (0) + Deflate (8) entries inside nested ARENA2/ folder
  const zipBuf = makeZip([
    { path: 'Daggerfall/ARENA2/ARCH3D.BSA', data: 'ARCH3D-TEST-DATA', compress: false },
    { path: 'Daggerfall/ARENA2/BLOCKS.BSA', data: 'BLOCKS-COMPRESSED-DATA-'.repeat(20), compress: true },
    { path: 'Daggerfall/ARENA2/MAPS.BSA', data: 'MAPS-COMPRESSED-DATA-'.repeat(15), compress: true },
    { path: 'Daggerfall/README.TXT', data: 'ignore me', compress: false },
  ]);

  const parsed = parseZipEntries(zipBuf);
  assert.equal(parsed.length, 4);
  const sel = await extractArena2FromZip(zipBuf);
  assert.equal(sel.fromZip, true);
  assert.equal(sel.problem, null);
  assert.deepEqual(sel.missing, []);
  assert.equal(sel.files.length, 3);
  const mapsFile = sel.files.find((f) => f.name === 'MAPS.BSA');
  const mapsText = new TextDecoder().decode(await mapsFile.arrayBuffer());
  assert.equal(mapsText, 'MAPS-COMPRESSED-DATA-'.repeat(15));

  // Install touch feature cleanly in Node
  const api = createGameplayApi({ send: () => true });
  const touchApi = installTouch(api);
  assert.ok(touchApi.state && typeof touchApi.extractArena2FromZip === 'function');
});
