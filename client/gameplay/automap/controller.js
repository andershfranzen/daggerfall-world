// Automap state shared by the panel (client/gameplay/automap.js) and the tests: the current plan, the viewed
// floor, the camera-like view (centre/zoom), follow mode and the live player marker. DOM-free.

import {
  buildAutomap, locationKind, makeView, fitView, zoomAt, panBy, worldToScreen, headingVector, floorIndexFor,
  floorLabel, sliceFor, visiblePieces, describePosition, EYE_HEIGHT, clampScale,
} from './model.js';
import { fogged, parseCellKey, cellsBounds, cellIndexMap, isExplored, unpackCells, cellKey, Y_STEP, CELL } from './memory.js';
import {
  DEFAULT_ORBIT_YAW, DEFAULT_ORBIT_PITCH, MIN_ORBIT_PITCH, MAX_ORBIT_PITCH,
  MIN_SLICE_OFFSET, MAX_SLICE_OFFSET, normalizeAutomapPrefs,
} from './prefs.js';
import { make3DView, pan3D, fit3D, sceneFor, exploredMask, sceneBounds, framePoints } from './view3d.js';

const QUARTER = Math.PI / 2;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** The location a scene mesh was built for: interiors/dungeons carry `location`, towns carry region + name. */
export function meshLocation(mesh) {
  if (typeof mesh?.location === 'string' && mesh.location) return mesh.location;
  if (mesh?.region && mesh?.name && !mesh.kind) return `town:${mesh.region}/${mesh.name}`;
  return null;
}
const sameLocation = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();

const DEFAULT_SCALE = { town: 2.5, interior: 14, dungeon: 6, unknown: 4 };
/** 3D auto-framing: the explored area is framed whole down to this zoom; past it the view stays on the player. */
const MIN_FRAME_SCALE = { town: 0.6, interior: 2.5, dungeon: 1.1, unknown: 1.1 };
const MAX_FRAME_SCALE = { town: 6, interior: 16, dungeon: 11, unknown: 9 };
/** Explored cells (2 m squares) at one foot height that make it a storey of its own when the plan missed it. */
export const EXPLORED_STOREY_CELLS = 12;

export function createAutomapController({ build = buildAutomap, prefs = null } = {}) {
  const initialPrefs = normalizeAutomapPrefs(prefs);
  const c = {
    location: null,
    kind: 'unknown',
    mesh: null,
    map: null,
    error: null,
    /** null = follow the player's own floor; otherwise an index into map.floors. */
    floor: null,
    /** Fine adjustable height slice offset in metres (DFU adjustable slice). */
    sliceOffset: 0,
    follow: true,
    view: makeView(),
    /** '2d' (classic top-down plan) or '3d' (rotatable perspective view). */
    viewMode: initialPrefs.viewMode,
    orbitYaw: initialPrefs.orbitYaw,
    orbitPitch: initialPrefs.orbitPitch,
    /** Independent automap preferences (never mixed into character exploration memory). */
    prefs: initialPrefs,
    player: null, // {x, z, yaw, feetY}
    version: 0, // bumps on anything that needs a redraw
    /** Classic cutaway: geometry above the viewed floor is cut away. Off shows every level at once. */
    cutaway: true,
    /** 'north' (north up, turned by `turn`) or 'heading' (the map turns with the player). */
    orientation: 'north',
    turn: 0, // manual quarter turns in north mode (radians)
    /** location -> Set of explored cell keys (this character only, from the server). */
    explored: new Map(),
    exploredVersion: 0,
    _floorCache: null,
    /**
     * Who placed the 3D camera: 'auto' (framed on the explored area; re-framed as more is explored), 'player'
     * (recentred on the player) or 'manual' (the player zoomed or panned).
     */
    framing: 'auto',

    /**
     * Location id changed. The scene mesh and the location can arrive in either order, so a mesh is kept and
     * only drawn while it belongs to the current location (meshLocation).
     */
    setLocation(location) {
      if ((location ?? null) === c.location) return false;
      const keep = c.mesh && (c.location === null ? !meshLocation(c.mesh) || sameLocation(meshLocation(c.mesh), location)
        : sameLocation(meshLocation(c.mesh), location));
      c.location = location ?? null;
      c.kind = locationKind(location);
      if (!keep) { c.mesh = null; c.map = null; c.error = null; }
      if (c.mesh && c.kind === 'unknown' && (c.mesh.kind === 'interior' || c.mesh.kind === 'dungeon')) c.kind = c.mesh.kind;
      if (c.map && c.map.kind !== c.kind) c.map = null;
      c.resetView();
      c.version++;
      return true;
    },

    /**
     * A scene mesh was applied. Returns true when it is new. The plan is built lazily (ensureMap).
     * `adopt: false` (meshes merely seen on screen) never overrides the server's location: a mesh that says it
     * belongs elsewhere is ignored.
     */
    setScene(mesh, { adopt = true } = {}) {
      if (!mesh || mesh === c.mesh) return false;
      const own = meshLocation(mesh);
      if (own && c.location && !sameLocation(own, c.location)) {
        if (!adopt) return false;
        // A scene for a location we have not been told about yet: adopt that location now.
        c.location = own;
        c.kind = locationKind(own);
      }
      c.mesh = mesh;
      if (c.kind === 'unknown' && (mesh.kind === 'interior' || mesh.kind === 'dungeon')) c.kind = mesh.kind;
      c.map = null;
      c.error = null;
      c.resetView();
      c.version++;
      return true;
    },

    ensureMap() {
      if (c.map || !c.mesh || c.error) return c.map;
      try {
        c.map = build(c.mesh, { kind: c.kind });
      } catch (err) {
        c.error = err;
      }
      return c.map;
    },

    resetView() {
      c.floor = null;
      c.sliceOffset = 0;
      c.follow = true;
      c.framing = 'auto';
      const defaultScale = c.kind === 'town' ? c.prefs.exteriorDefaultZoom : (DEFAULT_SCALE[c.kind] ?? 4);
      c.view = makeView({ ...c.view, scale: defaultScale, rotation: c.rotationFor(c.player) });
      if (c.player) c.view = { ...c.view, centerX: c.player.x, centerZ: c.player.z };
      if (c.prefs.rememberSlice && c.location && c.prefs.savedSlices?.[c.location]) {
        const saved = c.prefs.savedSlices[c.location];
        c.sliceOffset = Math.max(MIN_SLICE_OFFSET, Math.min(MAX_SLICE_OFFSET, Number(saved.sliceOffset) || 0));
        if (saved.floor !== null && Number.isInteger(saved.floor)) c.floor = saved.floor;
      }
    },

    /** Apply independent automap preferences without touching exploration memory. */
    applyPrefs(next) {
      c.prefs = normalizeAutomapPrefs(next);
      c.viewMode = c.prefs.viewMode;
      c.orbitYaw = c.prefs.orbitYaw;
      c.orbitPitch = c.prefs.orbitPitch;
      c.version++;
      return c.prefs;
    },

    /** Save current floor and slice offset for the active location when rememberSlice is on. */
    rememberSlice() {
      if (!c.prefs.rememberSlice || !c.location || c.kind === 'town') return;
      c.prefs = {
        ...c.prefs,
        savedSlices: {
          ...c.prefs.savedSlices,
          [c.location]: { floor: c.floor, sliceOffset: c.sliceOffset },
        },
      };
    },

    /** Reset exterior zoom & center back to the preferred exterior default zoom. */
    resetExteriorView() {
      c.follow = true;
      const scale = c.prefs.exteriorDefaultZoom ?? DEFAULT_SCALE.town;
      c.view = makeView({ ...c.view, scale, rotation: c.rotationFor(c.player) });
      if (c.player) c.view = { ...c.view, centerX: c.player.x, centerZ: c.player.z };
      c.version++;
    },

    setViewMode(mode) {
      const next = mode === '3d' ? '3d' : '2d';
      if (next === c.viewMode) return false;
      c.viewMode = next;
      c.prefs = { ...c.prefs, viewMode: next };
      c.version++;
      return true;
    },

    orbit(dYaw = 0, dPitch = 0) {
      const nextYaw = wrapAngle(c.orbitYaw + (Number.isFinite(dYaw) ? dYaw : 0));
      const nextPitch = Math.max(MIN_ORBIT_PITCH, Math.min(MAX_ORBIT_PITCH, c.orbitPitch + (Number.isFinite(dPitch) ? dPitch : 0)));
      if (nextYaw === c.orbitYaw && nextPitch === c.orbitPitch) return false;
      c.orbitYaw = nextYaw;
      c.orbitPitch = nextPitch;
      c.prefs = { ...c.prefs, orbitYaw: nextYaw, orbitPitch: nextPitch };
      c.version++;
      return true;
    },

    resetOrbit() {
      c.orbitYaw = DEFAULT_ORBIT_YAW;
      c.orbitPitch = DEFAULT_ORBIT_PITCH;
      c.prefs = { ...c.prefs, orbitYaw: c.orbitYaw, orbitPitch: c.orbitPitch };
      c.version++;
    },

    setSliceOffset(offset) {
      const v = Math.round(Math.max(MIN_SLICE_OFFSET, Math.min(MAX_SLICE_OFFSET, Number(offset) || 0)) * 2) / 2;
      if (v === c.sliceOffset) return false;
      c.sliceOffset = v;
      c.rememberSlice();
      c.version++;
      return true;
    },

    stepSliceOffset(delta) {
      return c.setSliceOffset(c.sliceOffset + delta);
    },

    /** Height of the floor on view: the selected storey, else the player's feet (towns: the player's feet). */
    viewedFloorY() {
      const picked = c.floor !== null && c.floor < c.floors.length ? c.floors[c.floor]?.y : null;
      return picked ?? c.player?.feetY ?? c.floors[c.playerFloor()]?.y ?? 0;
    },

    /** The architectural 3D scene of this place (automap/view3d.js), or null before the mesh arrives. */
    scene3d() {
      c.ensureMap();
      return c.map ? sceneFor(c.map, c.mesh) : null;
    },
    /** Triangles this character has explored (Uint8Array), or null where the whole place is shown. */
    mask3d() {
      const scene = c.scene3d();
      if (!scene || !c.fog) return null;
      const m = c._mask3d;
      if (m && m.scene === scene && m.v === c.exploredVersion && m.loc === c.location) return m.mask;
      const mask = exploredMask(scene, c.cellIndex());
      c._mask3d = { scene, v: c.exploredVersion, loc: c.location, mask };
      return mask;
    },
    /** Box of what the 3D view shows under the current cutaway (explored ground only, indoors), or null. */
    bounds3d() {
      const scene = c.scene3d();
      if (!scene) return null;
      return sceneBounds(scene, c.mask3d(), c.slice().top);
    },
    /** Outline of what the 3D view shows solid, for framing (points), or null. */
    outline3d() {
      const scene = c.scene3d();
      return scene ? framePoints(scene, c.mask3d(), c.slice().top) : null;
    },
    /** Frame everything shown in the 3D view. Returns false when there is nothing to frame. */
    fit3d({ minScale = 0.25, maxScale = 48 } = {}) {
      const box = c.outline3d();
      if (!box) return false;
      const v = fit3D(c.view3d(), box, { centerY: c.viewedFloorY() + c.sliceOffset, minScale, maxScale });
      c.follow = false;
      c.view = { ...c.view, centerX: v.centerX, centerZ: v.centerZ, scale: v.scale };
      c.version++;
      return true;
    },
    /**
     * Automatic 3D framing (panel opened, 3D switched on, more ground explored): the whole explored area when it
     * fits at a readable zoom, otherwise a comfortable view around the player. Leaves a camera the player placed.
     */
    frame3d({ force = false } = {}) {
      if (c.viewMode !== '3d' || (!force && c.framing !== 'auto')) return false;
      const lo = MIN_FRAME_SCALE[c.kind] ?? 2, hi = MAX_FRAME_SCALE[c.kind] ?? 9;
      const box = c.outline3d();
      const fitted = box ? fit3D(c.view3d(), box, { centerY: c.viewedFloorY() + c.sliceOffset, maxScale: hi }) : null;
      if (fitted && fitted.scale >= lo) {
        c.follow = false;
        c.view = { ...c.view, centerX: fitted.centerX, centerZ: fitted.centerZ, scale: fitted.scale };
      } else {
        c.follow = true;
        c.view = { ...c.view, scale: Math.max(lo * 2, Math.min(hi, DEFAULT_SCALE[c.kind] ?? 4)) };
        if (c.player) c.view = { ...c.view, centerX: c.player.x, centerZ: c.player.z };
      }
      c.framing = 'auto';
      c.version++;
      return true;
    },

    /** Current 3D perspective camera orbiting the viewed centre & floor height. */
    view3d() {
      return make3DView({
        centerX: c.view.centerX,
        centerY: c.viewedFloorY() + c.sliceOffset,
        centerZ: c.view.centerZ,
        orbitYaw: c.orbitYaw,
        orbitPitch: c.orbitPitch,
        scale: c.view.scale,
        width: c.view.width,
        height: c.view.height,
      });
    },

    /** Live camera from the `frame` event: {x, y (eye), z, yaw}. Returns true when the marker moved visibly. */
    setCamera(camera) {
      if (!camera || !Number.isFinite(camera.x) || !Number.isFinite(camera.z)) return false;
      const p = c.player;
      const next = {
        x: camera.x,
        z: camera.z,
        yaw: Number.isFinite(camera.yaw) ? camera.yaw : 0,
        feetY: Number.isFinite(camera.y) ? camera.y - EYE_HEIGHT : null,
      };
      const moved = !p || Math.hypot(next.x - p.x, next.z - p.z) > 0.02 || Math.abs(next.yaw - p.yaw) > 0.005
        || (next.feetY ?? 0) - (p.feetY ?? 0) > 0.05 || (p.feetY ?? 0) - (next.feetY ?? 0) > 0.05;
      c.player = next;
      if (c.follow) c.view = { ...c.view, centerX: next.x, centerZ: next.z };
      if (c.orientation === 'heading') c.view = { ...c.view, rotation: c.rotationFor(next) };
      if (moved) c.version++;
      return moved;
    },

    resize(width, height) {
      if (width === c.view.width && height === c.view.height) return;
      c.view = { ...c.view, width, height };
      c.version++;
    },

    // ---- floors
    /**
     * Storeys on show: indoors only those this character has explored (unvisited levels stay unknown), plus any
     * level they have stood on over at least EXPLORED_STOREY_CELLS cells that the plan's area rule missed.
     */
    get floors() {
      const all = c.map?.floors ?? [];
      if (!c.fog || !all.length) return all;
      const key = `${c.exploredVersion}|${all.length}|${c.location}`;
      if (c._floorCache?.key === key && c._floorCache.map === c.map) return c._floorCache.list;
      const counts = new Map(); // iy -> explored cells stood on at that height
      for (const k of c.cells()) { const iy = parseCellKey(k)[2]; counts.set(iy, (counts.get(iy) ?? 0) + 1); }
      const near = (list, y, d) => list.some((f) => Math.abs(f.y - y) <= d);
      const shown = all.filter((f) => [...counts.keys()].some((iy) => Math.abs(iy * Y_STEP - f.y) <= 1.25));
      // A level this character has walked across is a storey even when its floor is too small for the plan's
      // area rule (Privateer's Hold's new-character start level has ~380 m² in a ~19,500 m² dungeon).
      for (const [iy, n] of [...counts].sort((a, b) => b[1] - a[1])) {
        const y = iy * Y_STEP;
        if (n < EXPLORED_STOREY_CELLS || near(all, y, 1.25) || near(shown, y, 2.2)) continue;
        shown.push({ y, area: n * CELL * CELL, explored: true });
      }
      const list = shown.sort((a, b) => a.y - b.y).map((f, i) => ({ ...f, index: i }));
      c._floorCache = { key, map: c.map, list };
      return list;
    },
    /** The player's own floor index (or -1). */
    playerFloor() { return floorIndexFor(c.floors, c.player?.feetY); },
    /** The floor index on view: the selected one or, when following, the player's. */
    viewedFloor() { return c.floor ?? c.playerFloor(); },
    selectFloor(index) {
      const n = c.floors.length;
      c.floor = index === null || index === undefined || !n ? null : Math.max(0, Math.min(n - 1, index));
      c.rememberSlice();
      c.version++;
    },
    stepFloor(delta) {
      if (!c.floors.length) return false;
      c.selectFloor(c.viewedFloor() + delta);
      return true;
    },
    /** Height of the level named "Ground": the storey you enter on (its exit door), else the one nearest y = 0. */
    groundY() {
      const exit = c.map?.markers?.find((m) => m.type === 3 && Number.isFinite(m.y));
      const all = c.map?.floors ?? [];
      return exit && all.length ? all[floorIndexFor(all, exit.y - 1)]?.y ?? NaN : NaN;
    },
    floorText() { return floorLabel(c.floors, c.viewedFloor(), c.groundY(), { explored: c.fog }); },
    /**
     * Whether the storey selector is offered: whenever more than one storey is listed, and indoors as soon as one
     * storey of a multi-storey plan is explored (listing explored storeys only; unexplored ones stay hidden).
     */
    floorSelector() { return c.floors.length > 1 || (c.fog && c.floors.length === 1 && (c.map?.floors?.length ?? 0) > 1); },
    /** Height slab drawn: the selected storey, else the player's feet (DFU slices at the player's own height) + adjustable offset. */
    slice() {
      if (!c.map?.sliced || !c.cutaway) return sliceFor(null, NaN);
      const validFloor = c.floor !== null && c.floor < c.floors.length ? c.floors[c.floor]?.y : null;
      const base = validFloor ?? c.player?.feetY ?? c.floors[c.playerFloor()]?.y ?? 0;
      return sliceFor(c.map, base + c.sliceOffset);
    },
    pieces() { return c.map ? visiblePieces(c.map, c.slice()) : []; },

    // ---- navigation
    zoom(factor, sx, sy) {
      const before = c.view.scale;
      // Zoom about the player while following so the marker stays put.
      c.view = (c.follow || c.viewMode === '3d') ? { ...c.view, scale: clampScale(c.view.scale * factor) } : zoomAt(c.view, factor, sx, sy);
      if (c.view.scale !== before) { c.framing = 'manual'; c.version++; }
    },
    pan(dx, dy) {
      c.follow = false;
      c.framing = 'manual';
      if (c.viewMode === '3d') {
        const next3d = pan3D(c.view3d(), dx, dy);
        c.view = { ...c.view, centerX: next3d.centerX, centerZ: next3d.centerZ };
      } else {
        c.view = panBy(c.view, dx, dy);
      }
      c.version++;
    },
    recenter({ resetOrbit = false } = {}) {
      c.follow = true;
      c.framing = 'player';
      c.floor = null;
      c.sliceOffset = 0;
      if (resetOrbit) {
        c.orbitYaw = DEFAULT_ORBIT_YAW;
        c.orbitPitch = DEFAULT_ORBIT_PITCH;
      }
      if (c.player) c.view = { ...c.view, centerX: c.player.x, centerZ: c.player.z };
      c.version++;
    },
    fitAll() {
      if (!c.map) return;
      c.framing = 'manual';
      if (c.viewMode === '3d' && c.fit3d()) return;
      c.follow = false;
      const b = c.fog ? cellsBounds(c.cells()) : c.map.bounds;
      if (!b) return;
      c.view = fitView(b, c.view.width, c.view.height, 16, c.view.rotation);
      c.version++;
    },

    /** Player marker in canvas pixels: {x, y, dx, dy} (dx,dy = unit heading on screen), or null. */
    playerMarker() {
      if (!c.player) return null;
      const [x, y] = worldToScreen(c.view, c.player.x, c.player.z);
      const [dx, dy] = headingVector(c.player.yaw, c.view.rotation);
      return { x, y, dx, dy, yaw: c.player.yaw };
    },

    // ---- exploration memory (server-revealed, this character only)
    /** True when this place's plan is shown only where explored. */
    get fog() { return fogged(c.location) && c.kind !== 'town'; },
    cells(location = c.location) { return c.explored.get(String(location)) ?? new Set(); },
    /** Apply a private {kind:'automap', location, cells, full?} event. Returns true when anything changed. */
    applyExplored({ location, cells, full } = {}) {
      if (typeof location !== 'string' || !location) return false;
      let list;
      try { list = unpackCells(cells); } catch { return false; }
      let set = c.explored.get(location);
      if (!set || full) { set = new Set(); c.explored.set(location, set); }
      const before = set.size;
      for (const [ix, iz, iy] of list) set.add(cellKey(ix, iz, iy));
      if (!full && set.size === before) return false;
      c.exploredVersion++;
      c._index = null;
      if (location === c.location) c.version++;
      return true;
    },
    /** "ix,iz" -> [iy] of the current place, cached per exploration version. */
    cellIndex() {
      if (c._index?.v !== c.exploredVersion || c._index.loc !== c.location) c._index = { v: c.exploredVersion, loc: c.location, map: cellIndexMap(c.cells()) };
      return c._index.map;
    },
    /** Whether (x, z) at height y (optional) is on explored ground (always true outside fogged places). */
    seen(x, z, y = NaN) { return !c.fog || isExplored(c.cellIndex(), x, z, y); },
    /** Explored cells to draw for the current slice: [[ix, iz, iy, mode]] with mode 'current' | 'below'. */
    fogCells() {
      const sl = c.slice();
      const out = [];
      for (const k of c.cells()) {
        const [ix, iz, iy] = parseCellKey(k);
        const y = iy * Y_STEP;
        if (y > sl.top - 0.5 || y < (sl.bottom ?? -Infinity)) continue;
        out.push([ix, iz, iy, y < sl.below ? 'below' : 'current']);
      }
      return out;
    },
    exploredArea() { return c.cells().size * CELL * CELL; },

    // ---- orientation and cutaway (classic automap controls)
    rotationFor(player) {
      return c.orientation === 'heading' && Number.isFinite(player?.yaw) ? player.yaw : c.turn;
    },
    setOrientation(mode) {
      c.orientation = mode === 'heading' ? 'heading' : 'north';
      if (c.orientation === 'north') c.turn = 0;
      c.view = { ...c.view, rotation: c.rotationFor(c.player) };
      c.version++;
    },
    /** Turn the map's content a quarter (dir +1 clockwise, -1 anticlockwise). Leaves heading-up mode. */
    rotate(dir) {
      const base = c.orientation === 'heading' ? c.view.rotation : c.turn;
      c.orientation = 'north';
      c.turn = wrapAngle(Math.round((base - dir * QUARTER) / QUARTER) * QUARTER);
      c.view = { ...c.view, rotation: c.turn };
      c.version++;
    },
    setCutaway(on) {
      c.cutaway = !!on;
      c.version++;
    },
    orientationText() {
      if (c.orientation === 'heading') return 'Heading up';
      const q = ((Math.round(c.turn / QUARTER) % 4) + 4) % 4;
      return ['North up', 'East up', 'South up', 'West up'][q];
    },

    describe() {
      if (c.error) return `The map of this place could not be drawn: ${c.error.message}`;
      if (!c.map) return 'The map appears once this place has loaded.';
      const floor = c.floorText();
      const own = c.floor !== null && c.floor !== c.playerFloor() ? ` Showing ${floor}.` : '';
      // Indoors, position words are relative to what this character has explored, never to the unseen whole.
      const ref = c.fog ? { ...c.map, bounds: cellsBounds(c.cells()) ?? c.map.bounds } : c.map;
      const explored = c.fog ? ` Explored: about ${Math.round(c.exploredArea())} m².` : '';
      return describePosition(ref, c.player, c.floor === null ? floor : floorLabel(c.floors, c.playerFloor(), c.groundY(), { explored: c.fog })) + own + explored;
    },
  };
  return c;
}
