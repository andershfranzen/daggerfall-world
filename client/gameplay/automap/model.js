// Local automap model: a top-down plan of the current scene mesh (town exterior, building interior or dungeon).
// DOM-free so it runs under `node --test`; client/gameplay/automap.js draws it on a canvas.
//
// The plan comes only from the triangles and atlas of the mesh the game already built from the player's own
// archives (client/world/town.js, client/world/interiors/scene.js). Nothing here ships or invents layout data.
//
// Level slicing follows the idea of Daggerfall Unity's Automap (Assets/Scripts/Game/Automap.cs,
// UpdateSlicingPositionY: geometry above the player's eye + a small bias is cut away; MIT, (c) 2009-2023
// Daggerfall Workshop). The code here is original; see automap/NOTICE.txt.
//
// Coordinates are the renderer's output space: +y up, north is -z, east is +x, metres. On screen north is up,
// so screen x grows with world x and screen y grows with world z. Yaw 0 faces north, positive yaw turns
// clockwise toward east (client/hud-contract.md).

export const EYE_HEIGHT = 1.6;
/** Geometry whose lowest point is more than this above the viewed floor is cut away (DFU: eye + 0.2 bias). */
export const SLICE_ABOVE_FLOOR = EYE_HEIGHT + 0.2;
/** Geometry whose highest point is this far below the viewed floor is drawn dimmed, as a lower level. */
export const BELOW_FLOOR = 0.75;
/** Lower levels are shown (dimmed) down to this far below the viewed floor; deeper geometry is hidden. */
export const LOWER_DEPTH = 10;
const BIN = 0.5; // height bucket (m) for painter order and slicing
const WALK_NY = 0.55; // matches client/gameplay/collision/world.js WALKABLE_NY
const WALL_NY = 0.25; // |n.y| below this is drawn as a wall line, above as a filled surface
export const MIN_SCALE = 0.25; // px per metre
export const MAX_SCALE = 48;

/**
 * 'town' | 'interior' | 'dungeon' | 'unknown' from a location id (client/world/interiors/index.js parseLocation):
 * `town:R/L`, `interior:R/L/bx,by/record`, `dungeon:R/L`. `building:` is accepted as an alias of interior.
 */
export function locationKind(location) {
  const m = /^([a-z]+):/i.exec(String(location ?? ''));
  const k = m ? m[1].toLowerCase() : '';
  if (k === 'building') return 'interior';
  return k === 'town' || k === 'interior' || k === 'dungeon' ? k : 'unknown';
}

// ---------------------------------------------------------------------------------------------- projection

/**
 * A view centred on world (centerX, centerZ) at `scale` px/m in a width×height canvas. `rotation` is the yaw that
 * points up the screen: 0 is north up; the player's yaw gives a heading-up map (classic automap orientation).
 */
export function makeView({ centerX = 0, centerZ = 0, scale = 4, width = 640, height = 480, rotation = 0 } = {}) {
  return { centerX, centerZ, scale: clampScale(scale), width, height, rotation: Number.isFinite(rotation) ? rotation : 0 };
}

export const clampScale = (s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number.isFinite(s) ? s : 4));

const rot = (view) => {
  const r = view.rotation || 0;
  return [Math.cos(r), Math.sin(r)];
};

export function worldToScreen(view, x, z) {
  const [c, s] = rot(view);
  const X = (x - view.centerX) * view.scale, Z = (z - view.centerZ) * view.scale;
  return [view.width / 2 + c * X + s * Z, view.height / 2 - s * X + c * Z];
}

export function screenToWorld(view, sx, sy) {
  const [c, s] = rot(view);
  const X = sx - view.width / 2, Y = sy - view.height / 2;
  return [view.centerX + (c * X - s * Y) / view.scale, view.centerZ + (s * X + c * Y) / view.scale];
}

/** Canvas transform [a,b,c,d,e,f] mapping world (x,z) to screen pixels: setTransform(...). */
export function viewTransform(view) {
  const [cs, sn] = rot(view);
  const k = view.scale;
  const a = k * cs, b = -k * sn, c = k * sn, d = k * cs;
  return [a, b, c, d, view.width / 2 - (a * view.centerX + c * view.centerZ), view.height / 2 - (b * view.centerX + d * view.centerZ)];
}

/** Unit screen-space direction of a yaw (y down): yaw 0 points up the screen, π/2 to the right (north-up view). */
export function headingVector(yaw, rotation = 0) {
  return [Math.sin(yaw - rotation), -Math.cos(yaw - rotation)];
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export function compassName(yaw) {
  const turn = ((yaw / (2 * Math.PI)) % 1 + 1) % 1;
  return COMPASS[Math.round(turn * 8) % 8];
}

/** Zoom by `factor` keeping the world point under screen (sx, sy) fixed. */
export function zoomAt(view, factor, sx = view.width / 2, sy = view.height / 2) {
  const [wx, wz] = screenToWorld(view, sx, sy);
  const scale = clampScale(view.scale * factor);
  const next = { ...view, scale, centerX: wx, centerZ: wz };
  const [cx, cz] = screenToWorld(next, sx, sy);
  return { ...next, centerX: wx - (cx - wx), centerZ: wz - (cz - wz) };
}

/** Pan by a screen-pixel offset (content moves with the pointer). */
export function panBy(view, dx, dy) {
  const [c, s] = rot(view);
  return { ...view, centerX: view.centerX - (c * dx - s * dy) / view.scale, centerZ: view.centerZ - (s * dx + c * dy) / view.scale };
}

/** View that fits `bounds` ({minX,maxX,minZ,maxZ}) into width×height with `pad` pixels on every side. */
export function fitView(bounds, width, height, pad = 16, rotation = 0) {
  const bw = Math.max(1, bounds.maxX - bounds.minX);
  const bd = Math.max(1, bounds.maxZ - bounds.minZ);
  const c = Math.abs(Math.cos(rotation)), s = Math.abs(Math.sin(rotation));
  const w = c * bw + s * bd, d = s * bw + c * bd;
  const scale = clampScale(Math.min((width - 2 * pad) / w, (height - 2 * pad) / d));
  return makeView({ centerX: (bounds.minX + bounds.maxX) / 2, centerZ: (bounds.minZ + bounds.maxZ) / 2, scale, width, height, rotation });
}

/** Where (x,z) lies in bounds, as words: "the north-west", "the centre", ... */
export function regionWords(bounds, x, z) {
  const fx = (x - bounds.minX) / Math.max(1e-6, bounds.maxX - bounds.minX);
  const fz = (z - bounds.minZ) / Math.max(1e-6, bounds.maxZ - bounds.minZ);
  const ns = fz < 1 / 3 ? 'north' : fz > 2 / 3 ? 'south' : '';
  const ew = fx < 1 / 3 ? 'west' : fx > 2 / 3 ? 'east' : '';
  if (!ns && !ew) return 'the centre';
  return `the ${[ns, ew].filter(Boolean).join('-')}`;
}

// ---------------------------------------------------------------------------------------------- floors

/**
 * Storey heights from walkable surfaces [{y, area}]: area-weighted height histogram peaks, at least `minGap`
 * apart, each carrying at least `minShare` of the walkable area (or `minArea` m²). A level with `storeyArea` m² of
 * floor always counts, however large the whole place is: big dungeons such as Privateer's Hold spread ~20,000 m²
 * over a dozen levels, so a share alone dropped the 720 m² entrance level. Sorted bottom to top.
 */
export function detectFloors(surfaces, { bin = 0.25, minGap = 2.2, minShare = 0.04, minArea = 6, storeyArea = 400, max = 16 } = {}) {
  const hist = new Map();
  let total = 0;
  for (const { y, area } of surfaces) {
    if (!(area > 0) || !Number.isFinite(y)) continue;
    const k = Math.round(y / bin);
    hist.set(k, (hist.get(k) ?? 0) + area);
    total += area;
  }
  if (!total) return [];
  const need = Math.max(minArea, Math.min(total * minShare, storeyArea));
  const peaks = [];
  for (const [k, area] of [...hist].sort((a, b) => b[1] - a[1])) {
    if (area < need) break;
    const y = k * bin;
    if (peaks.some((p) => Math.abs(p.y - y) < minGap)) continue;
    peaks.push({ y, area });
    if (peaks.length >= max) break;
  }
  return peaks.sort((a, b) => a.y - b.y).map((p, i) => ({ index: i, y: p.y, area: p.area }));
}

/** Index of the floor a player standing at feet height `feetY` is on: the highest floor at or below them. */
export function floorIndexFor(floors, feetY) {
  if (!floors.length || !Number.isFinite(feetY)) return floors.length ? 0 : -1;
  let best = 0;
  for (let i = 0; i < floors.length; i++) if (floors[i].y <= feetY + 0.5) best = i;
  return best;
}

/**
 * "Ground level (2 of 3)", "Lower level 1 (1 of 3)", ... `groundY` (optional) is the height of the level that counts
 * as ground, e.g. the entrance; without it the storey nearest y = 0 is ground. `explored`: `floors` are only the
 * storeys a character has explored, so even one of them is named ("Ground level (1 of 1 explored)").
 */
export function floorLabel(floors, index, groundY = NaN, { explored = false } = {}) {
  if (index < 0 || index >= floors.length || (floors.length <= 1 && !explored)) return '';
  const f = floors[index];
  let rel;
  if (Number.isFinite(groundY)) {
    // Levels are counted from the ground (entrance) height among the listed storeys only, so a character who has
    // only seen a deep level is told it is below the entrance without learning how many levels lie between.
    if (Math.abs(f.y - groundY) <= 1) rel = 0;
    else if (f.y < groundY) rel = -floors.filter((g) => g.y < groundY - 1 && g.y >= f.y).length;
    else rel = floors.filter((g) => g.y > groundY + 1 && g.y <= f.y).length;
  } else {
    const ground = floors.reduce((g, h, i) => (Math.abs(h.y) < Math.abs(floors[g].y) ? i : g), 0);
    rel = index - ground;
  }
  const name = rel === 0 ? 'Ground level' : rel > 0 ? `Upper level ${rel}` : `Lower level ${-rel}`;
  return `${name} (${index + 1} of ${floors.length}${explored ? ' explored' : ''})`;
}

/**
 * The height slab to show. `floorY` is the viewed floor (selected storey, or the player's feet when following).
 * Towns (no slicing) show everything at full strength.
 */
export function sliceFor(map, floorY) {
  if (!map?.sliced || !Number.isFinite(floorY)) return { top: Infinity, below: -Infinity, bottom: -Infinity };
  return { top: floorY + SLICE_ABOVE_FLOOR, below: floorY - BELOW_FLOOR, bottom: floorY - LOWER_DEPTH };
}

/** 'hidden' | 'below' | 'current' for a piece spanning [yMin, yMax] under a slice. */
export function visibility(slice, yMin, yMax) {
  if (yMin > slice.top || yMax < (slice.bottom ?? -Infinity)) return 'hidden';
  if (yMax < slice.below) return 'below';
  return 'current';
}

/** Pieces of the plan to draw for a slice, in painter order (low to high): [{piece, mode}]. */
export function visiblePieces(map, slice) {
  const out = [];
  for (const piece of map.pieces) {
    const mode = visibility(slice, piece.yMin, piece.yMax);
    if (mode !== 'hidden') out.push({ piece, mode });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- build

function atlasSampler(atlas) {
  if (!atlas?.pixels || !(atlas.width > 0) || !(atlas.height > 0)) return null;
  const { width: W, height: H, pixels: P } = atlas;
  return (u, v) => {
    const x = Math.min(W - 1, Math.max(0, Math.floor(u * W)));
    const y = Math.min(H - 1, Math.max(0, Math.floor(v * H)));
    const o = (y * W + x) * 4;
    return P[o + 3] < 128 ? null : [P[o], P[o + 1], P[o + 2]];
  };
}

/** Average texture colour of triangle t from 4 samples (centroid and corner-inset points); null if transparent. */
function triangleColour(sample, uv, t) {
  if (!sample || !uv) return null;
  const o = t * 6;
  const u0 = uv[o], v0 = uv[o + 1], u1 = uv[o + 2], v1 = uv[o + 3], u2 = uv[o + 4], v2 = uv[o + 5];
  const cu = (u0 + u1 + u2) / 3, cv = (v0 + v1 + v2) / 3;
  const pts = [[cu, cv], [(u0 + cu) / 2, (v0 + cv) / 2], [(u1 + cu) / 2, (v1 + cv) / 2], [(u2 + cu) / 2, (v2 + cv) / 2]];
  let r = 0, g = 0, b = 0, n = 0;
  for (const [u, v] of pts) {
    const c = sample(u, v);
    if (!c) continue;
    r += c[0]; g += c[1]; b += c[2]; n++;
  }
  return n ? [r / n, g / n, b / n] : null;
}

class Floats {
  constructor() { this.a = new Float32Array(64); this.n = 0; }
  push(...v) {
    if (this.n + v.length > this.a.length) {
      const b = new Float32Array(Math.max(this.a.length * 2, this.n + v.length));
      b.set(this.a);
      this.a = b;
    }
    for (const x of v) this.a[this.n++] = x;
  }
  done() { return this.a.slice(0, this.n); }
}

const binOf = (y) => Math.floor(y / BIN);

/**
 * Build the plan of a scene mesh.
 * @param {{positions: Float32Array, uv?: Float32Array, atlas?: object, bounds?: object, ground?: object, doors?: any[]}} mesh
 * @param {{kind?: string}} opts  kind from locationKind(); towns are not sliced into floors
 * @returns {{kind, sliced, bounds, floors, pieces, markers, triangles}}
 *   pieces: [{yMin, yMax, kind:'fill'|'wall', colour:[r,g,b]|null, data: Float32Array}] in painter order;
 *   fill data is x,z ×3 per triangle, wall data is x0,z0,x1,z1 per segment.
 */
export function buildAutomap(mesh, { kind = 'unknown' } = {}) {
  const P = mesh?.positions;
  if (!P || !(P.length >= 9)) throw new Error('automap: the scene has no geometry');
  const T = Math.floor(P.length / 9);
  const sample = atlasSampler(mesh.atlas);
  const uv = mesh.uv && mesh.uv.length >= T * 6 ? mesh.uv : null;
  const g0 = mesh.ground?.firstTriangle ?? T;
  const g1 = g0 + (mesh.ground?.triangleCount ?? 0);
  const groups = new Map(); // key -> {yMin,yMax,kind,colour,data:Floats}
  const walk = [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;

  for (let t = 0; t < T; t++) {
    const o = t * 9;
    const ax = P[o], ay = P[o + 1], az = P[o + 2];
    const bx = P[o + 3], by = P[o + 4], bz = P[o + 5];
    const cx = P[o + 6], cy = P[o + 7], cz = P[o + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-9)) continue;
    const yMin = Math.min(ay, by, cy), yMax = Math.max(ay, by, cy);
    minX = Math.min(minX, ax, bx, cx); maxX = Math.max(maxX, ax, bx, cx);
    minZ = Math.min(minZ, az, bz, cz); maxZ = Math.max(maxZ, az, bz, cz);
    const up = Math.abs(ny) / len;
    const ground = t >= g0 && t < g1;
    if (up >= WALK_NY && !ground) walk.push({ y: (ay + by + cy) / 3, area: len / 2 });

    if (up < WALL_NY) {
      // Vertical face: its plan is a line between the two farthest-apart corners.
      const pts = [[ax, az], [bx, bz], [cx, cz]];
      let best = 0, i0 = 0, i1 = 1;
      for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
        const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]);
        if (d > best) { best = d; i0 = i; i1 = j; }
      }
      if (best < 0.05) continue;
      const key = `w${binOf(yMin)}:${binOf(yMax)}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { yMin: binOf(yMin) * BIN, yMax: (binOf(yMax) + 1) * BIN, kind: 'wall', colour: null, data: new Floats() }));
      g.data.push(pts[i0][0], pts[i0][1], pts[i1][0], pts[i1][1]);
      continue;
    }
    let col = triangleColour(sample, uv, t);
    if (!col && sample) continue; // fully transparent (alpha-tested) face: not visible from above either
    col = col ?? [150, 150, 150];
    const shade = up >= WALK_NY ? 1 : 0.82; // slopes and roofs a little darker than floors
    const q = col.map((c) => Math.min(255, Math.round((c * shade) / 12) * 12));
    const key = `f${binOf(yMin)}:${binOf(yMax)}:${q.join(',')}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { yMin: binOf(yMin) * BIN, yMax: (binOf(yMax) + 1) * BIN, kind: 'fill', colour: q, data: new Floats() }));
    g.data.push(ax, az, bx, bz, cx, cz);
  }
  if (!Number.isFinite(minX)) throw new Error('automap: the scene has no visible geometry');

  const pieces = [...groups.values()]
    .map((g) => ({ yMin: g.yMin, yMax: g.yMax, kind: g.kind, colour: g.colour, data: g.data.done() }))
    // Painter order: lower surfaces first; at equal height fills before wall lines so walls stay on top.
    .sort((a, b) => (a.yMin + a.yMax) - (b.yMin + b.yMax) || (a.kind === b.kind ? 0 : a.kind === 'fill' ? -1 : 1));

  const sliced = kind !== 'town';
  const floors = sliced ? detectFloors(walk) : [];
  return {
    kind,
    sliced,
    bounds: { minX, maxX, minZ, maxZ },
    floors,
    pieces,
    markers: doorMarkers(mesh.doors),
    triangles: T,
  };
}

/** Doors of an interior/dungeon scene (client/world/interiors/scene.js) as plan markers in output space. */
export function doorMarkers(doors) {
  const out = [];
  if (!Array.isArray(doors)) return out;
  for (const d of doors) {
    let x, y, z;
    if (Number.isFinite(d?.x) && Number.isFinite(d?.z)) ({ x, y = 0, z } = d);
    else if (Array.isArray(d?.centre)) [x, y, z] = [d.centre[0], d.centre[1], -d.centre[2]]; // Unity -> output
    else continue;
    const label = d.type === 3 ? 'Exit' : d.type === 2 ? 'Dungeon entrance' : d.type === 1 ? 'Door' : null;
    if (label) out.push({ x, y, z, type: d.type, label });
  }
  return out;
}

/** Plain-language summary of where the player is, for screen readers and the status line. */
export function describePosition(map, player, floorText = '') {
  if (!map || !player || !Number.isFinite(player.x) || !Number.isFinite(player.z)) return 'Your position is not known yet.';
  const where = regionWords(map.bounds, player.x, player.z);
  const facing = Number.isFinite(player.yaw) ? `, facing ${compassName(player.yaw)}` : '';
  return `You are in ${where} of the map${facing}${floorText ? `, ${floorText}` : ''}.`;
}
