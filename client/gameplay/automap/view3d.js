// Rotatable 3D perspective automap: camera maths, the architectural scene built from the real scene mesh, and the
// draw list of the canvas fallback. DOM-free so it runs under `node --test`.
//
// The 3D view is drawn from the same triangles the game renders (never from the lossy 2D plan): every face keeps its
// own normal, so it can be back-face culled (dungeon and interior shells face inward, which is what lets the classic
// automap look into a room from outside), flat shaded by direction, and outlined only along structural edges
// (creases, polygon borders and silhouettes), never along the diagonals inside a flat polygon.
//
// client/gameplay/automap/render3d.js draws the scene with a WebGL depth buffer; build3DDrawList() below is the
// opaque, back-face culled, depth-sorted fallback for browsers without WebGL2.
//
// World convention: +x east, +y up, -z north, metres (client/hud-contract.md).

import { clampScale, meshOf, atlasSampler, triangleColour } from './model.js';
import { DEFAULT_ORBIT_YAW, DEFAULT_ORBIT_PITCH, MIN_ORBIT_PITCH, MAX_ORBIT_PITCH } from './prefs.js';
import { CELL, Y_STEP } from './memory.js';

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------------------------------- camera

/**
 * A perspective camera orbiting (centerX, centerY, centerZ) from above.
 * - orbitYaw: horizontal orbit in radians; 0 looks north from the south, so north is up the screen.
 * - orbitPitch: elevation above the horizon in radians ([0.18, 1.48]; 1.48 is nearly straight down).
 * - scale: shared with the 2D plan's zoom (px/m) so both views zoom alike.
 */
export function make3DView({
  centerX = 0,
  centerY = 0,
  centerZ = 0,
  orbitYaw = DEFAULT_ORBIT_YAW,
  orbitPitch = DEFAULT_ORBIT_PITCH,
  scale = 6,
  width = 640,
  height = 480,
} = {}) {
  const s = clampScale(scale);
  return {
    centerX: Number.isFinite(centerX) ? centerX : 0,
    centerY: Number.isFinite(centerY) ? centerY : 0,
    centerZ: Number.isFinite(centerZ) ? centerZ : 0,
    orbitYaw: Number.isFinite(orbitYaw) ? wrapAngle(orbitYaw) : DEFAULT_ORBIT_YAW,
    orbitPitch: clamp(Number.isFinite(orbitPitch) ? orbitPitch : DEFAULT_ORBIT_PITCH, MIN_ORBIT_PITCH, MAX_ORBIT_PITCH),
    scale: s,
    width: Math.max(1, width || 640),
    height: Math.max(1, height || 480),
  };
}

/** Orbit distance from the target in metres, inversely proportional to scale. */
export function orbitDistance(view) {
  return clamp(180 / Math.max(0.25, view.scale || 4), 6, 720);
}

/** Focal length in CSS pixels (about a 42° vertical field of view: little distortion, still clearly perspective). */
export function focalLength(view) {
  return Math.max(180, Math.min(view.width, view.height) * 1.3);
}

/** Camera-space coordinates of a world point: right, up, and distance in front of the camera. */
function toCamera(view, x, y, z) {
  const dx = x - view.centerX, dy = y - view.centerY, dz = z - view.centerZ;
  const cy = Math.cos(view.orbitYaw), sy = Math.sin(view.orbitYaw);
  const rx = cy * dx + sy * dz;
  const rz = -sy * dx + cy * dz; // toward the camera's ground position
  const cp = Math.cos(view.orbitPitch), sp = Math.sin(view.orbitPitch);
  // The camera sits behind (+rz) and above (+y) the target, looking down at it.
  return [rx, cp * dy - sp * rz, orbitDistance(view) - (sp * dy + cp * rz)];
}

/**
 * Project world (x, y, z) to canvas pixels. Returns { sx, sy, depth, factor, visible }; `factor` is px per metre at
 * that depth, `visible` is false for points behind the camera.
 */
export function project3D(view, x, y, z) {
  const [rx, up, depth] = toCamera(view, x, y, z);
  if (depth <= 0.5) return { sx: NaN, sy: NaN, depth, factor: 0, visible: false };
  const factor = focalLength(view) / depth;
  return { sx: view.width / 2 + rx * factor, sy: view.height / 2 - up * factor, depth, factor, visible: true };
}

/** World position of the camera eye. */
export function cameraPosition3D(view) {
  const d = orbitDistance(view);
  const cp = Math.cos(view.orbitPitch), sp = Math.sin(view.orbitPitch);
  const cy = Math.cos(view.orbitYaw), sy = Math.sin(view.orbitYaw);
  const rz = cp * d;
  return [view.centerX - sy * rz, view.centerY + sp * d, view.centerZ + cy * rz];
}

/**
 * Column-major 4×4 clip matrix that matches project3D() exactly (so canvas markers sit on the WebGL geometry).
 * Depth maps [near, far] metres in front of the camera to the depth buffer.
 */
export function viewProjection3D(view, near = 0.5, far = 4000) {
  const cy = Math.cos(view.orbitYaw), sy = Math.sin(view.orbitYaw);
  const cp = Math.cos(view.orbitPitch), sp = Math.sin(view.orbitPitch);
  const f = focalLength(view);
  const kx = (2 * f) / view.width, ky = (2 * f) / view.height;
  // Rows of the camera basis in world space: right, up, and "toward the camera" (depth = dist - toward·p).
  const R = [cy, 0, sy], U = [sp * sy, cp, -sp * cy], B = [-cp * sy, sp, cp * cy];
  const c = [view.centerX, view.centerY, view.centerZ];
  const dot = (a) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
  const dist = orbitDistance(view);
  // depth = dist + dot(B, c) - B·p
  const d0 = dist + dot(B);
  const A = (far + near) / (far - near), Bz = (-2 * far * near) / (far - near);
  return new Float32Array([
    kx * R[0], ky * U[0], -A * B[0], -B[0],
    kx * R[1], ky * U[1], -A * B[1], -B[1],
    kx * R[2], ky * U[2], -A * B[2], -B[2],
    -kx * dot(R), -ky * dot(U), A * d0 + Bz, d0,
  ]);
}

/** World [x, z] under canvas pixel (sx, sy) on the horizontal plane y = planeY, or null when the ray misses it. */
export function unproject3D(view, sx, sy, planeY = view.centerY) {
  const cy = Math.cos(view.orbitYaw), sy_ = Math.sin(view.orbitYaw);
  const cp = Math.cos(view.orbitPitch), sp = Math.sin(view.orbitPitch);
  const f = focalLength(view);
  const a = (sx - view.width / 2) / f, b = -(sy - view.height / 2) / f;
  // Ray direction = right·a + up·b + forward, with forward = -(toward the camera).
  const dx = cy * a + sp * sy_ * b + cp * sy_;
  const dy = cp * b - sp;
  const dz = sy_ * a - sp * cy * b - cp * cy;
  if (!(dy < -1e-6)) return null;
  const eye = cameraPosition3D(view);
  const t = (planeY - eye[1]) / dy;
  return t > 0 ? [eye[0] + dx * t, eye[2] + dz * t] : null;
}

/** Orbit horizontally (dYaw) and tilt elevation (dPitch). */
export function orbit3D(view, dYaw = 0, dPitch = 0) {
  return make3DView({
    ...view,
    orbitYaw: view.orbitYaw + (Number.isFinite(dYaw) ? dYaw : 0),
    orbitPitch: view.orbitPitch + (Number.isFinite(dPitch) ? dPitch : 0),
  });
}

/** Pan the target over the ground plane by a screen-space drag (dx, dy): the content follows the pointer. */
export function pan3D(view, dx, dy) {
  const mPerPx = orbitDistance(view) / Math.max(1, focalLength(view));
  const sinP = Math.max(0.3, Math.sin(view.orbitPitch));
  const cy = Math.cos(view.orbitYaw), sy = Math.sin(view.orbitYaw);
  // Screen right is (cy, sy) and screen up (away from the camera) is (sy, -cy) on the ground plane.
  const wx = (-dx * cy + (dy / sinP) * sy) * mPerPx;
  const wz = (-dx * sy - (dy / sinP) * cy) * mPerPx;
  return { ...view, centerX: view.centerX + wx, centerZ: view.centerZ + wz };
}

/**
 * Frame a target: a world box {minX,maxX,minY,maxY,minZ,maxZ}, or a Float32Array of points (x, y, z triples) for a
 * tight fit to the real outline. Aims at the target's middle (at height `centerY`, default its floor) and picks the
 * largest zoom at which everything stays `pad` pixels inside the canvas, then centres the outline on screen.
 */
export function fit3D(view, target, { pad = 40, centerY = null, minScale = 0.25, maxScale = 48 } = {}) {
  let pts = null;
  if (target instanceof Float32Array) pts = target;
  else if (target && Number.isFinite(target.minX) && Number.isFinite(target.maxX)) {
    const y0 = Number.isFinite(target.minY) ? target.minY : view.centerY;
    const y1 = Number.isFinite(target.maxY) ? target.maxY : y0;
    const c = [];
    for (const x of [target.minX, target.maxX]) for (const y of [y0, y1]) for (const z of [target.minZ, target.maxZ]) c.push(x, y, z);
    pts = new Float32Array(c);
  }
  if (!pts || pts.length < 3) return view;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    if (pts[i] < minX) minX = pts[i]; if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minY) minY = pts[i + 1];
    if (pts[i + 2] < minZ) minZ = pts[i + 2]; if (pts[i + 2] > maxZ) maxZ = pts[i + 2];
  }
  let out = make3DView({
    ...view,
    centerX: (minX + maxX) / 2,
    centerY: Number.isFinite(centerY) ? centerY : minY,
    centerZ: (minZ + maxZ) / 2,
  });
  /** Screen extent of the target at a zoom, or null when part of it is behind the camera. */
  const extent = (v) => {
    let x0 = Infinity, x1 = -Infinity, t = Infinity, b = -Infinity;
    for (let i = 0; i < pts.length; i += 3) {
      const p = project3D(v, pts[i], pts[i + 1], pts[i + 2]);
      if (!p.visible) return null;
      if (p.sx < x0) x0 = p.sx; if (p.sx > x1) x1 = p.sx;
      if (p.sy < t) t = p.sy; if (p.sy > b) b = p.sy;
    }
    return { x0, x1, t, b };
  };
  // Zoom so the outline's size fits, then slide the target so the outline is centred; repeat as perspective shifts.
  for (let pass = 0; pass < 4; pass++) {
    let lo = minScale, hi = maxScale;
    for (let i = 0; i < 24; i++) {
      const mid = Math.sqrt(lo * hi);
      const e = extent({ ...out, scale: mid });
      if (e && e.x1 - e.x0 <= out.width - 2 * pad && e.b - e.t <= out.height - 2 * pad) lo = mid; else hi = mid;
    }
    out = { ...out, scale: clampScale(lo) };
    const e = extent(out);
    if (!e) break;
    const dx = out.width / 2 - (e.x0 + e.x1) / 2, dy = out.height / 2 - (e.t + e.b) / 2;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) break;
    const moved = pan3D(out, dx, dy);
    out = { ...out, centerX: moved.centerX, centerZ: moved.centerZ };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- palette

/** Face classes of the architectural scene. */
export const FACE = Object.freeze({ FLOOR: 0, WALL: 1, CEILING: 2, RAMP: 3, DOOR: 4, GROUND: 5 });

/**
 * Cartographic palette matched to the granite & verdigris interface: warm stone floors, cool slate walls,
 * verdigris ramps and stairs, brass doors. Colours are linear-ish sRGB bytes; lighting is applied on top.
 */
export const PALETTE = Object.freeze({
  background: [13, 14, 16],
  backgroundEdge: [6, 7, 8],
  floor: [176, 166, 144],
  wall: [150, 156, 165],
  ceiling: [92, 96, 104],
  ramp: [96, 176, 170],
  door: [222, 164, 72],
  ground: [104, 116, 96],
  water: [58, 132, 178],
  edge: [16, 18, 21],
  below: [58, 72, 86],
  above: [226, 206, 168],
  grid: [95, 163, 165],
  ghost: [164, 218, 219],
});
const CLASS_COLOUR = [PALETTE.floor, PALETTE.wall, PALETTE.ceiling, PALETTE.ramp, PALETTE.door, PALETTE.ground];

/**
 * Fixed world-space light, high in the south-west: it shines into the rooms from the default camera's side, so the
 * walls that face the viewer are lit. Floors are brightest; N/S walls and E/W walls get clearly different tones.
 */
export const LIGHT_DIR = Object.freeze((() => {
  const v = [-0.36, 0.74, 0.57];
  const l = Math.hypot(...v);
  return v.map((c) => c / l);
})());
export const AMBIENT = 0.46;

/** Lambert term shared by the WebGL shader and the canvas fallback. */
export function faceLight(nx, ny, nz) {
  const d = nx * LIGHT_DIR[0] + ny * LIGHT_DIR[1] + nz * LIGHT_DIR[2];
  // Half-Lambert keeps faces turned away from the light readable instead of black.
  return AMBIENT + (1 - AMBIENT) * (0.5 + 0.5 * d) ** 1.35;
}

/**
 * Colour of a face at height y relative to the viewed floor: levels below turn cool and dark, levels above warm and
 * light, and walls darken slightly toward their foot so rooms read as sculpted. Returns [r, g, b] 0..255.
 */
export function shadeFace(colour, nx, ny, nz, y, floorY) {
  const light = faceLight(nx, ny, nz);
  const dy = y - floorY;
  const below = clamp((-dy - 0.75) / 9, 0, 1);
  const above = clamp((dy - 2.2) / 12, 0, 1);
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let c = colour[i];
    c += (PALETTE.below[i] - c) * below * 0.72;
    c += (PALETTE.above[i] - c) * above * 0.3;
    out[i] = clamp(Math.round(c * light * (1 - below * 0.28)), 0, 255);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- scene

const QUANT = 40; // 2.5 cm vertex weld for edge matching
const COPLANAR = 0.9995;
const FLAT = 0.985; // floors are level to within ~10°
/** A slope is a stair or ramp when it is gentle, or climbs at least this far; short steep strips are wall chamfers. */
const GENTLE = 0.86;
const RAMP_RISE = 1.6;
const RAMP_AREA = 2; // m² of one flat slope
const CREASE = Math.cos((24 * Math.PI) / 180);
const scenes = new WeakMap();

/**
 * Architectural scene of a mesh (cached per mesh).
 * @returns {{
 *   kind: string, count: number, bounds: object,
 *   pos: Float32Array,      // 9 per triangle
 *   normal: Float32Array,   // 3 per triangle (unit, front side)
 *   colour: Uint8Array,     // 3 per triangle (unlit base colour, uniform across each flat polygon)
 *   cls: Uint8Array,        // FACE.* per triangle
 *   edges: Float32Array,    // 6 per structural edge
 *   edgeNormals: Float32Array, // 6 per edge: the normals of the two faces that meet there
 *   edgeCrease: Uint8Array, // 1 = always drawn when a face shows, 0 = drawn only as a silhouette
 *   edgeTris: Int32Array,   // 2 per edge (second is -1 on a border)
 *   water: Array            // [{minX,maxX,minZ,maxZ,y}]
 * }}
 */
export function build3DScene(mesh, { kind = 'unknown' } = {}) {
  const cached = mesh && scenes.get(mesh);
  if (cached && cached.kind === kind) return cached;
  const P = mesh?.positions;
  if (!P || !(P.length >= 9)) return null;
  const total = Math.floor(P.length / 9);
  const sample = atlasSampler(mesh.atlas);
  const uv = mesh.uv && mesh.uv.length >= total * 6 ? mesh.uv : null;
  const g0 = mesh.ground?.firstTriangle ?? total;
  const g1 = g0 + (mesh.ground?.triangleCount ?? 0);
  // Outdoors a slope is a roof, not a stair: only interiors and dungeons pick out ramps.
  const indoors = kind !== 'town';
  const doorTri = new Uint8Array(total);
  for (const d of Array.isArray(mesh.actionDoors) ? mesh.actionDoors : []) {
    const a = d?.firstTriangle | 0, n = d?.triangleCount | 0;
    for (let t = Math.max(0, a); t < Math.min(total, a + n); t++) doorTri[t] = 1;
  }

  // Pass 1: keep visible triangles; normal, class and sampled texture colour of each.
  const pos = new Float32Array(total * 9);
  const normal = new Float32Array(total * 3);
  const area = new Float32Array(total);
  const tex = new Float32Array(total * 3);
  const cls = new Uint8Array(total);
  let n = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let t = 0; t < total; t++) {
    const o = t * 9;
    const ax = P[o], ay = P[o + 1], az = P[o + 2];
    const ux = P[o + 3] - ax, uy = P[o + 4] - ay, uz = P[o + 5] - az;
    const vx = P[o + 6] - ax, vy = P[o + 7] - ay, vz = P[o + 8] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 1e-9)) continue;
    const col = triangleColour(sample, uv, t);
    if (!col && sample) continue; // alpha-tested away
    const up = ny / len;
    const c = doorTri[t] ? FACE.DOOR
      : t >= g0 && t < g1 ? FACE.GROUND
        : up >= 0.55 ? (up > FLAT || !indoors ? FACE.FLOOR : FACE.RAMP)
          : up <= -0.55 ? FACE.CEILING : FACE.WALL;
    for (let i = 0; i < 9; i++) pos[n * 9 + i] = P[o + i];
    normal[n * 3] = nx / len; normal[n * 3 + 1] = up; normal[n * 3 + 2] = nz / len;
    area[n] = len / 2;
    const tc = col ?? CLASS_COLOUR[c];
    tex[n * 3] = tc[0]; tex[n * 3 + 1] = tc[1]; tex[n * 3 + 2] = tc[2];
    cls[n] = c;
    for (let i = 0; i < 9; i += 3) {
      const x = P[o + i], y = P[o + i + 1], z = P[o + i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    n++;
  }
  if (!n) return null;

  // Pass 2: weld vertices and find the faces on each edge.
  const vid = new Map();
  const vertexOf = (x, y, z) => {
    const k = `${Math.round(x * QUANT)},${Math.round(y * QUANT)},${Math.round(z * QUANT)}`;
    let id = vid.get(k);
    if (id === undefined) { id = vid.size; vid.set(k, id); }
    return id;
  };
  const tv = new Int32Array(n * 3);
  for (let t = 0; t < n; t++) for (let i = 0; i < 3; i++) tv[t * 3 + i] = vertexOf(pos[t * 9 + i * 3], pos[t * 9 + i * 3 + 1], pos[t * 9 + i * 3 + 2]);
  const V = vid.size + 1;
  const edgeMap = new Map(); // key -> [t0, corner0, t1, extra]
  for (let t = 0; t < n; t++) {
    for (let i = 0; i < 3; i++) {
      const a = tv[t * 3 + i], b = tv[t * 3 + ((i + 1) % 3)];
      if (a === b) continue;
      const k = a < b ? a * V + b : b * V + a;
      const e = edgeMap.get(k);
      if (!e) edgeMap.set(k, [t, i, -1, 0]);
      else if (e[2] < 0) e[2] = t;
      else e[3]++;
    }
  }

  // Pass 3: flat polygons. Triangles joined across coplanar same-class edges form one polygon; so do coplanar
  // neighbours that only touch along a T-junction (no shared vertices), which is how most module borders meet.
  const parent = new Int32Array(n);
  for (let t = 0; t < n; t++) parent[t] = t;
  const find = (t) => { while (parent[t] !== t) { parent[t] = parent[parent[t]]; t = parent[t]; } return t; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const dotN = (a, b) => normal[a * 3] * normal[b * 3] + normal[a * 3 + 1] * normal[b * 3 + 1] + normal[a * 3 + 2] * normal[b * 3 + 2];
  for (const e of edgeMap.values()) {
    if (e[2] < 0 || e[3]) continue;
    if (cls[e[0]] === cls[e[2]] && dotN(e[0], e[2]) > COPLANAR) join(e[0], e[2]);
  }
  // Spatial hash of triangles for the T-junction test.
  const GRID = 2;
  const cellKey = (ix, iy, iz) => ((ix + 2048) * 4096 + (iy + 2048)) * 4096 + (iz + 2048);
  const grid = new Map();
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const x0 = Math.floor((Math.min(pos[o], pos[o + 3], pos[o + 6]) - 0.1) / GRID), x1 = Math.floor((Math.max(pos[o], pos[o + 3], pos[o + 6]) + 0.1) / GRID);
    const y0 = Math.floor((Math.min(pos[o + 1], pos[o + 4], pos[o + 7]) - 0.1) / GRID), y1 = Math.floor((Math.max(pos[o + 1], pos[o + 4], pos[o + 7]) + 0.1) / GRID);
    const z0 = Math.floor((Math.min(pos[o + 2], pos[o + 5], pos[o + 8]) - 0.1) / GRID), z1 = Math.floor((Math.max(pos[o + 2], pos[o + 5], pos[o + 8]) + 0.1) / GRID);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) continue; // enormous faces (town ground) are not indexed
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) {
      const k = cellKey(ix, iy, iz);
      const list = grid.get(k);
      if (list) list.push(t); else grid.set(k, [t]);
    }
  }
  /** A triangle other than `self`, coplanar with it and of its class, that covers point (x, y, z); or -1. */
  const coplanarAt = (self, x, y, z) => {
    const list = grid.get(cellKey(Math.floor(x / GRID), Math.floor(y / GRID), Math.floor(z / GRID)));
    if (!list) return -1;
    const nx = normal[self * 3], ny = normal[self * 3 + 1], nz = normal[self * 3 + 2];
    for (const t of list) {
      if (t === self || cls[t] !== cls[self] || dotN(t, self) < COPLANAR) continue;
      const o = t * 9;
      const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
      if (Math.abs((x - ax) * nx + (y - ay) * ny + (z - az) * nz) > 0.04) continue;
      // Barycentric test in the triangle's own plane.
      const e0x = pos[o + 3] - ax, e0y = pos[o + 4] - ay, e0z = pos[o + 5] - az;
      const e1x = pos[o + 6] - ax, e1y = pos[o + 7] - ay, e1z = pos[o + 8] - az;
      const px = x - ax, py = y - ay, pz = z - az;
      const d00 = e0x * e0x + e0y * e0y + e0z * e0z, d01 = e0x * e1x + e0y * e1y + e0z * e1z, d11 = e1x * e1x + e1y * e1y + e1z * e1z;
      const d20 = px * e0x + py * e0y + pz * e0z, d21 = px * e1x + py * e1y + pz * e1z;
      const den = d00 * d11 - d01 * d01;
      if (!(Math.abs(den) > 1e-12)) continue;
      const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
      if (v >= -1e-3 && w >= -1e-3 && v + w <= 1.001) return t;
    }
    return -1;
  };
  const seam = new Set(); // border edges that are only a T-junction inside one flat polygon
  for (const [k, e] of edgeMap) {
    if (e[2] >= 0) continue;
    const t = e[0], i = e[1], j = (i + 1) % 3, c = (i + 2) % 3, o = t * 9;
    const ax = pos[o + i * 3], ay = pos[o + i * 3 + 1], az = pos[o + i * 3 + 2];
    const bx = pos[o + j * 3], by = pos[o + j * 3 + 1], bz = pos[o + j * 3 + 2];
    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const nx = normal[t * 3], ny = normal[t * 3 + 1], nz = normal[t * 3 + 2];
    // In-plane direction leaving the triangle across this edge.
    let ox = ny * ez - nz * ey, oy = nz * ex - nx * ez, oz = nx * ey - ny * ex;
    const ol = Math.hypot(ox, oy, oz);
    if (!(ol > 1e-9)) continue;
    ox /= ol; oy /= ol; oz /= ol;
    if ((pos[o + c * 3] - ax) * ox + (pos[o + c * 3 + 1] - ay) * oy + (pos[o + c * 3 + 2] - az) * oz > 0) { ox = -ox; oy = -oy; oz = -oz; }
    const R = 0.06;
    const n1 = coplanarAt(t, ax + ex * 0.3 + ox * R, ay + ey * 0.3 + oy * R, az + ez * 0.3 + oz * R);
    if (n1 < 0) continue;
    const n2 = coplanarAt(t, ax + ex * 0.7 + ox * R, ay + ey * 0.7 + oy * R, az + ez * 0.7 + oz * R);
    if (n2 < 0) continue;
    seam.add(k);
    join(t, n1);
    join(t, n2);
  }

  // Stairs and ramps: a slope that is gentle or climbs between levels. Short steep strips (the chamfered foot of a
  // corridor wall) belong to the wall.
  const rise = new Float32Array(n * 2);
  for (let t = 0; t < n; t++) { rise[t * 2] = Infinity; rise[t * 2 + 1] = -Infinity; }
  for (let t = 0; t < n; t++) {
    if (cls[t] !== FACE.RAMP) continue;
    const r = find(t), o = t * 9;
    rise[r * 2] = Math.min(rise[r * 2], pos[o + 1], pos[o + 4], pos[o + 7]);
    rise[r * 2 + 1] = Math.max(rise[r * 2 + 1], pos[o + 1], pos[o + 4], pos[o + 7]);
  }
  const slopeArea = new Float32Array(n);
  for (let t = 0; t < n; t++) if (cls[t] === FACE.RAMP) slopeArea[find(t)] += area[t];
  const reclass = new Uint8Array(n);
  for (let t = 0; t < n; t++) {
    if (cls[t] !== FACE.RAMP) continue;
    const r = find(t);
    const gentle = normal[t * 3 + 1] > GENTLE;
    // Too small to walk up (the bevel of a prop, a trim strip): a gentle one reads as floor, a steep one as wall.
    if (slopeArea[r] < RAMP_AREA) reclass[t] = gentle ? 1 : 2;
    else if (!gentle && rise[r * 2 + 1] - rise[r * 2] < RAMP_RISE) reclass[t] = 2;
  }
  for (let t = 0; t < n; t++) if (reclass[t]) cls[t] = reclass[t] === 1 ? FACE.FLOOR : FACE.WALL;

  const sum = new Float64Array(n * 4);
  for (let t = 0; t < n; t++) {
    const r = find(t), w = Math.max(1e-6, area[t]);
    sum[r * 4] += tex[t * 3] * w; sum[r * 4 + 1] += tex[t * 3 + 1] * w; sum[r * 4 + 2] += tex[t * 3 + 2] * w; sum[r * 4 + 3] += w;
  }
  // Indoors the palette leads and the texture only tints (wood, moss, brick); outdoors the texture colour leads.
  const tint = kind === 'town' ? 0.82 : 0.2;
  const colour = new Uint8Array(n * 3);
  for (let t = 0; t < n; t++) {
    const r = find(t), w = sum[r * 4 + 3] || 1;
    const base = CLASS_COLOUR[cls[t]];
    const k = cls[t] === FACE.DOOR ? 0.1 : cls[t] === FACE.RAMP ? Math.min(tint, 0.35) : tint;
    for (let i = 0; i < 3; i++) colour[t * 3 + i] = clamp(Math.round(base[i] + (sum[r * 4 + i] / w - base[i]) * k), 0, 255);
  }

  // Pass 4: structural edges. Joins inside a flat polygon are dropped; creases and borders always show; gentle
  // bends only as silhouettes (decided per view from the two face normals).
  const eP = [], eN = [], eC = [], eT = [];
  for (const [k, e] of edgeMap) {
    const t0 = e[0], t1 = e[2];
    if (seam.has(k)) continue;
    let crease = 1;
    if (t1 >= 0 && !e[3]) {
      const d = dotN(t0, t1);
      if (d > COPLANAR && cls[t0] === cls[t1]) continue;
      crease = d < CREASE || cls[t0] !== cls[t1] ? 1 : 0;
    }
    const i = e[1], j = (i + 1) % 3;
    eP.push(pos[t0 * 9 + i * 3], pos[t0 * 9 + i * 3 + 1], pos[t0 * 9 + i * 3 + 2], pos[t0 * 9 + j * 3], pos[t0 * 9 + j * 3 + 1], pos[t0 * 9 + j * 3 + 2]);
    const o = t1 >= 0 ? t1 : t0;
    eN.push(normal[t0 * 3], normal[t0 * 3 + 1], normal[t0 * 3 + 2], normal[o * 3], normal[o * 3 + 1], normal[o * 3 + 2]);
    eC.push(crease);
    eT.push(t0, t1);
  }

  const scene = {
    kind,
    count: n,
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
    pos: pos.subarray(0, n * 9),
    normal: normal.subarray(0, n * 3),
    colour,
    cls: cls.subarray(0, n),
    edges: new Float32Array(eP),
    edgeNormals: new Float32Array(eN),
    edgeCrease: new Uint8Array(eC),
    edgeTris: new Int32Array(eT),
    water: Array.isArray(mesh.water) ? mesh.water.filter((w) => Number.isFinite(w?.y) && Number.isFinite(w?.minX)) : [],
  };
  scenes.set(mesh, scene);
  return scene;
}

/** The architectural scene behind a plan built by buildAutomap(), or of `mesh` when the plan came from elsewhere. */
export function sceneFor(map, mesh = null) {
  const m = mesh ?? meshOf(map);
  return m ? build3DScene(m, { kind: map?.kind ?? 'unknown' }) : null;
}

/** How far above an explored cell's floor its room (walls, ceiling) is taken to reach, and the slack below it. */
const ROOM_HEIGHT = 5;
const FLOOR_SLACK = 1.25;

/**
 * Which triangles this character has explored: Uint8Array mask (1 = shown). A face shows when it stands over an
 * explored cell and overlaps that cell's room height, exactly the ground the 2D plan uncovers.
 * @param cells Map "ix,iz" -> [iy] (controller.cellIndex())
 */
export function exploredMask(scene, cells) {
  const mask = new Uint8Array(scene.count);
  if (!cells?.size) return mask;
  const P = scene.pos;
  const cache = new Map();
  const at = (x, z) => {
    const ix = Math.floor(x / CELL), iz = Math.floor(z / CELL);
    const k = ix * 65536 + iz;
    let v = cache.get(k);
    if (v === undefined) { v = cells.get(`${ix},${iz}`) ?? null; cache.set(k, v); }
    return v;
  };
  for (let t = 0; t < scene.count; t++) {
    const o = t * 9;
    const lo = Math.min(P[o + 1], P[o + 4], P[o + 7]), hi = Math.max(P[o + 1], P[o + 4], P[o + 7]);
    const test = (x, z) => {
      const ys = at(x, z);
      if (!ys) return false;
      for (const iy of ys) { const y = iy * Y_STEP; if (hi >= y - FLOOR_SLACK && lo <= y + ROOM_HEIGHT) return true; }
      return false;
    };
    if (test((P[o] + P[o + 3] + P[o + 6]) / 3, (P[o + 2] + P[o + 5] + P[o + 8]) / 3)
      || test(P[o], P[o + 2]) || test(P[o + 3], P[o + 5]) || test(P[o + 6], P[o + 8])) mask[t] = 1;
  }
  return mask;
}

/** Explored mask from a `seen(x, z, y)` predicate (tests, and callers without the cell index). */
function maskFromSeen(scene, seen) {
  const mask = new Uint8Array(scene.count);
  const P = scene.pos;
  for (let t = 0; t < scene.count; t++) {
    const o = t * 9;
    const lo = Math.min(P[o + 1], P[o + 4], P[o + 7]);
    const cx = (P[o] + P[o + 3] + P[o + 6]) / 3, cz = (P[o + 2] + P[o + 5] + P[o + 8]) / 3;
    if (seen(cx, cz, lo) || seen(cx, cz, (P[o + 1] + P[o + 4] + P[o + 7]) / 3)
      || seen(P[o], P[o + 2], P[o + 1]) || seen(P[o + 3], P[o + 5], P[o + 4]) || seen(P[o + 6], P[o + 8], P[o + 7])
      || seen(P[o], P[o + 2], lo) || seen(P[o + 3], P[o + 5], lo) || seen(P[o + 6], P[o + 8], lo)) mask[t] = 1;
  }
  return mask;
}

/** Bounding box of the shown (explored) triangles at or below `top`, or null when nothing shows. */
export function sceneBounds(scene, mask = null, top = Infinity, bottom = -Infinity) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const P = scene.pos;
  for (let t = 0; t < scene.count; t++) {
    if (mask && !mask[t]) continue;
    for (let i = 0; i < 9; i += 3) {
      const x = P[t * 9 + i], y = P[t * 9 + i + 1], z = P[t * 9 + i + 2];
      if (y > top + 0.01 || y < bottom) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY, minZ, maxZ } : null;
}

/**
 * Water surface of a flooded dungeon as triangles (Float32Array, 9 per triangle): a lid at the water level over
 * every shown floor that lies under it, so only water this character has seen is drawn.
 */
export function waterSurface3D(scene, mask = null) {
  if (!scene?.water?.length) return null;
  const out = [];
  const P = scene.pos;
  for (let t = 0; t < scene.count; t++) {
    if ((mask && !mask[t]) || (scene.cls[t] !== FACE.FLOOR && scene.cls[t] !== FACE.RAMP)) continue;
    const o = t * 9;
    const hi = Math.max(P[o + 1], P[o + 4], P[o + 7]);
    const cx = (P[o] + P[o + 3] + P[o + 6]) / 3, cz = (P[o + 2] + P[o + 5] + P[o + 8]) / 3;
    for (const w of scene.water) {
      if (hi >= w.y - 0.05 || cx < w.minX || cx > w.maxX || cz < w.minZ || cz > w.maxZ) continue;
      out.push(P[o], w.y, P[o + 2], P[o + 3], w.y, P[o + 5], P[o + 6], w.y, P[o + 8]);
      break;
    }
  }
  return out.length ? new Float32Array(out) : null;
}

/**
 * Outline points (x, y, z triples) of what the 3D view shows solid: vertices of the shown triangles under the
 * cutaway plane `top` (heights clamped to it), thinned to at most `max` points. For fit3D(). Null when empty.
 */
export function framePoints(scene, mask = null, top = Infinity, max = 6000) {
  const P = scene.pos;
  let shown = 0;
  for (let t = 0; t < scene.count; t++) if (!mask || mask[t]) shown++;
  const stride = Math.max(1, Math.ceil((shown * 3) / max));
  const out = [];
  let i = 0;
  for (let t = 0; t < scene.count; t++) {
    if (mask && !mask[t]) continue;
    const o = t * 9;
    if (Math.min(P[o + 1], P[o + 4], P[o + 7]) > top) continue;
    for (let v = 0; v < 9; v += 3) {
      if (i++ % stride) continue;
      out.push(P[o + v], Math.min(P[o + v + 1], top), P[o + v + 2]);
    }
  }
  return out.length ? new Float32Array(out) : null;
}

// ---------------------------------------------------------------------------------------------- canvas fallback

/** Clip a convex polygon [[x,y,z],...] to y <= top (the cutaway plane). */
function clipTop(pts, top) {
  if (!Number.isFinite(top)) return pts;
  let any = false;
  for (const p of pts) if (p[1] > top) { any = true; break; }
  if (!any) return pts;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const ia = a[1] <= top, ib = b[1] <= top;
    if (ia) out.push(a);
    if (ia !== ib) {
      const k = (top - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * k, top, a[2] + (b[2] - a[2]) * k]);
    }
  }
  return out;
}

/**
 * Opaque, back-face culled, depth-sorted draw list for the 2D-canvas fallback (no WebGL2). Faces arrive already
 * lit, cut at the slice plane and sorted far to near; structural edges are separate entries just in front of their
 * faces. Respects exploration (`mask`, or a `seen(x, z, y)` predicate when `fog` is on) like the 2D plan.
 * Returns { polys: [{ kind:'fill'|'edge', cls, pts:[[sx,sy]...], depth, colour:[r,g,b], alpha }], count }.
 */
export function build3DDrawList(map, slice, view, { fog = false, seen = null, mask = null, mesh = null, floorY = null, maxPolys = 60000 } = {}) {
  const scene = sceneFor(map, mesh);
  if (!scene) return { polys: [], count: 0 };
  const shown = mask ?? (fog && typeof seen === 'function' ? maskFromSeen(scene, seen) : null);
  const top = Number.isFinite(slice?.top) ? slice.top : Infinity;
  const bottom = Number.isFinite(slice?.bottom) ? slice.bottom : -Infinity;
  const baseY = Number.isFinite(floorY) ? floorY : view.centerY;
  const eye = cameraPosition3D(view);
  const P = scene.pos, N = scene.normal;
  const w = view.width, h = view.height, margin = 60;
  const polys = [];
  const front = new Uint8Array(scene.count);

  const projectAll = (pts) => {
    const out = [];
    let depth = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y, z] of pts) {
      const p = project3D(view, x, y, z);
      if (!p.visible) return null;
      out.push([p.sx, p.sy]);
      depth += p.depth;
      if (p.sx < minX) minX = p.sx; if (p.sx > maxX) maxX = p.sx;
      if (p.sy < minY) minY = p.sy; if (p.sy > maxY) maxY = p.sy;
    }
    if (maxX < -margin || minX > w + margin || maxY < -margin || minY > h + margin) return null;
    return { pts: out, depth: depth / pts.length };
  };

  for (let t = 0; t < scene.count; t++) {
    if (shown && !shown[t]) continue;
    const o = t * 9;
    const nx = N[t * 3], ny = N[t * 3 + 1], nz = N[t * 3 + 2];
    // Back-face cull against the eye: inward-facing shells open up toward the viewer.
    if ((eye[0] - P[o]) * nx + (eye[1] - P[o + 1]) * ny + (eye[2] - P[o + 2]) * nz <= 0) continue;
    const yLo = Math.min(P[o + 1], P[o + 4], P[o + 7]), yHi = Math.max(P[o + 1], P[o + 4], P[o + 7]);
    if (yLo > top || yHi < bottom) continue;
    front[t] = 1;
    const tri = clipTop([[P[o], P[o + 1], P[o + 2]], [P[o + 3], P[o + 4], P[o + 5]], [P[o + 6], P[o + 7], P[o + 8]]], top);
    if (tri.length < 3) continue;
    const pr = projectAll(tri);
    if (!pr) continue;
    const yMid = (P[o + 1] + P[o + 4] + P[o + 7]) / 3;
    polys.push({
      kind: 'fill',
      cls: scene.cls[t],
      ramp: scene.cls[t] === FACE.RAMP,
      mode: yHi < (slice?.below ?? -Infinity) ? 'below' : 'current',
      pts: pr.pts,
      depth: pr.depth,
      colour: shadeFace([scene.colour[t * 3], scene.colour[t * 3 + 1], scene.colour[t * 3 + 2]], nx, ny, nz, Math.min(yMid, top), baseY),
      alpha: 1,
    });
  }

  const E = scene.edges, ET = scene.edgeTris, EC = scene.edgeCrease;
  for (let e = 0; e < EC.length; e++) {
    const a = ET[e * 2], b = ET[e * 2 + 1];
    const fa = front[a], fb = b >= 0 ? front[b] : 0;
    if (!(fa || fb) || (!EC[e] && fa === fb)) continue;
    const seg = clipTop([[E[e * 6], E[e * 6 + 1], E[e * 6 + 2]], [E[e * 6 + 3], E[e * 6 + 4], E[e * 6 + 5]]], top);
    if (seg.length < 2) continue;
    const pr = projectAll(seg.slice(0, 2));
    if (!pr) continue;
    polys.push({ kind: 'edge', cls: -1, mode: 'current', pts: pr.pts, depth: pr.depth - 0.06, colour: PALETTE.edge, alpha: 0.85 });
  }

  // Painter's order: farthest from the camera first. Over budget, the farthest faces go first.
  polys.sort((p, q) => q.depth - p.depth);
  const out = polys.length > maxPolys ? polys.slice(polys.length - maxPolys) : polys;
  return { polys: out, count: out.length };
}
