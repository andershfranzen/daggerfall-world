// Scene assembly for building interiors and dungeons: Unity-space placement matrices, static door extraction and
// renderer-ready triangle/UV/atlas output in the same contract as client/world/town.js (README.md "Output").
//
// Door extraction adapts daggerfall-js-source src/world/meshReader.js (subMeshDoorType + the LoadVertices door pass)
// and src/world/staticDoors.js (MIT, (c) 2026 Lattymoy), translations of Daggerfall Unity's MeshReader.LoadVertices
// and GameObjectHelper.GetStaticDoors (MIT, (c) 2009-2023 Daggerfall Workshop). The atlas packer follows
// client/world/town.js. See THIRD_PARTY_NOTICES.txt.
//
// Spaces: models are placed in DFU's left-handed Unity space (x east, y up, z north, metres), then mirrored to the
// right-handed output space with (x, y, z) -> (x, y, -z). No other offset is applied, so a server can map any
// Unity-space point with the same rule.

import { BsaArchive, NUMBER_RECORD, readBlob } from '../bsa.js';
import { decodeMesh, patchRecord } from '../arch3d.js';
import { TextureArchive, parsePalette, textureFileName } from '../textures.js';
import { emitTexturedPolygon, applyClimate } from '../town.js';
import { WorldDataError } from '../errors.js';
import { ROTATION_DIVISOR } from './blocks.js';

export const SCALE = 0.025;
export const DOOR_TYPE = Object.freeze({ NONE: 0, BUILDING: 1, DUNGEON_ENTRANCE: 2, DUNGEON_EXIT: 3 });
const ATLAS_WIDTH = 2048;
const ATLAS_PAD = 2;

// ---------------------------------------------------------------------------
// 3x4 affine matrices, row-major [r00 r01 r02 tx | r10 r11 r12 ty | r20 r21 r22 tz], Unity conventions.

export const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
export const translate = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
const rad = (d) => (d * Math.PI) / 180;
export function rotX(deg) {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0];
}
export function rotY(deg) {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0];
}
export function rotZ(deg) {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg));
  return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
}
/** a · b (b applied first). */
export function mul(a, b) {
  const o = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let v = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
      if (c === 3) v += a[r * 4 + 3];
      o[r * 4 + c] = v;
    }
  }
  return o;
}
export const point = (m, x, y, z) => [
  m[0] * x + m[1] * y + m[2] * z + m[3],
  m[4] * x + m[5] * y + m[6] * z + m[7],
  m[8] * x + m[9] * y + m[10] * z + m[11],
];
export const vector = (m, x, y, z) => [m[0] * x + m[1] * y + m[2] * z, m[4] * x + m[5] * y + m[6] * z, m[8] * x + m[9] * y + m[10] * z];
/** Unity space -> output space. */
export const toOutput = ([x, y, z]) => [x, y, -z];
/** Native yaw units -> Unity degrees, as DFU's -rot / RotationDivisor. */
export const yawDegrees = (raw) => -raw / ROTATION_DIVISOR;

// ---------------------------------------------------------------------------
// Doors

/** MeshReader.LoadVertices door law: the type a plane's texture archive (and, for ruins, record) makes. */
export function doorTypeOf(textureArchive, textureRecord) {
  let a = textureArchive;
  if (a > 100 && a !== 331 && a !== 156) a -= Math.trunc(a / 100) * 100;
  switch (a) {
    case 74: return DOOR_TYPE.BUILDING;
    case 56: return DOOR_TYPE.DUNGEON_ENTRANCE;
    case 331: return textureRecord > 0 ? DOOR_TYPE.DUNGEON_ENTRANCE : DOOR_TYPE.NONE;
    case 95: return DOOR_TYPE.DUNGEON_EXIT;
    default: return DOOR_TYPE.NONE;
  }
}

/**
 * Doors of a decoded model in model space (Unity axes, metres): one per door plane, centre = (v0 + v2) / 2,
 * normal = normalize(cross(v0 - v2, v0 - v1)) pointing away from the door face, as in DFU.
 */
export function modelDoors(mesh) {
  const out = [];
  for (const plane of mesh.planes) {
    const type = doorTypeOf(plane.archive, plane.record);
    if (type === DOOR_TYPE.NONE || plane.points.length < 3) continue;
    const [p0, p1, p2] = plane.points;
    const v0 = [p0.x * SCALE, -p0.y * SCALE, p0.z * SCALE];
    const v1 = [p1.x * SCALE, -p1.y * SCALE, p1.z * SCALE];
    const v2 = [p2.x * SCALE, -p2.y * SCALE, p2.z * SCALE];
    const u = [v0[0] - v2[0], v0[1] - v2[1], v0[2] - v2[2]];
    const w = [v0[0] - v1[0], v0[1] - v1[1], v0[2] - v1[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n) || 1;
    n = n.map((k) => k / len);
    const size = {
      width: Math.max(Math.abs(v2[0] - v0[0]), Math.abs(v2[2] - v0[2])),
      height: Math.abs(v2[1] - v0[1]),
    };
    out.push({ type, centre: [(v0[0] + v2[0]) / 2, (v0[1] + v2[1]) / 2, (v0[2] + v2[2]) / 2], normal: n, size });
  }
  return out;
}

/** A model door placed by `matrix` (Unity space), returned in Unity space with a horizontal unit normal. */
export function placeDoor(door, matrix) {
  const centre = point(matrix, ...door.centre);
  const n = vector(matrix, ...door.normal);
  const h = Math.hypot(n[0], n[2]) || 1;
  return { type: door.type, centre, normal: [n[0] / h, 0, n[2] / h], size: door.size };
}

/** Output-space door: position + outward unit normal in the x/z plane. */
export function doorToOutput(d) {
  const [x, y, z] = toOutput(d.centre);
  const [nx, , nz] = toOutput(d.normal);
  return { type: d.type, x, y, z, nx, nz, width: d.size.width, height: d.size.height };
}

// ---------------------------------------------------------------------------
// Archive access shared by every scene of one data selection

/** Lazily opened ARCH3D models and TEXTURE archives for one file index (Map basename -> File). */
export class ModelLibrary {
  constructor(index) {
    this.index = index;
    this.meshes = new Map();
    this.textures = new Map();
    this.arch = null;
    this.palette = null;
  }
  async open() {
    if (this.arch) return this;
    const arch = this.index.get('ARCH3D.BSA');
    if (!arch) throw new WorldDataError('ARCH3D.BSA is missing from the selected Daggerfall data');
    this.arch = await BsaArchive.open(arch, 'ARCH3D.BSA', NUMBER_RECORD);
    return this;
  }
  async mesh(modelId) {
    let m = this.meshes.get(modelId);
    if (m) return m;
    await this.open();
    const k = this.arch.indexOfId(modelId);
    if (k < 0) throw new WorldDataError(`ARCH3D.BSA: model ${modelId} is missing`);
    const bytes = await this.arch.read(k);
    patchRecord(bytes, this.arch.entries[k].position);
    m = decodeMesh(bytes, modelId);
    m.doors = modelDoors(m);
    let lowest = Infinity;
    for (const p of m.planes) for (const q of p.points) lowest = Math.min(lowest, -q.y * SCALE);
    m.lowestY = Number.isFinite(lowest) ? lowest : 0;
    this.meshes.set(modelId, m);
    return m;
  }
  async paletteBytes() {
    if (this.palette) return this.palette;
    const f = this.index.get('ART_PAL.COL');
    if (!f) throw new WorldDataError('ART_PAL.COL is missing from the selected Daggerfall data');
    this.palette = parsePalette(await readBlob(f, 0, f.size), 'ART_PAL.COL');
    return this.palette;
  }
  async textureArchive(archive) {
    let t = this.textures.get(archive);
    if (t) return t;
    const name = textureFileName(archive);
    const f = this.index.get(name);
    if (!f) throw new WorldDataError(`${name} is missing from the selected Daggerfall data`);
    t = new TextureArchive(new Uint8Array(await f.arrayBuffer()), archive);
    this.textures.set(archive, t);
    return t;
  }
}

// ---------------------------------------------------------------------------
// Mesh output

async function buildAtlas(keys, lib) {
  const palette = await lib.paletteBytes();
  const images = [];
  for (const key of keys) images.push({ key, ...(await lib.textureArchive(key.archive)).decode(key.record) });
  const order = images.map((_, i) => i).sort((a, b) => images[b].height - images[a].height || images[b].width - images[a].width);
  let x = 0, y = 0, shelf = 0;
  const place = new Array(images.length);
  for (const i of order) {
    const w = images[i].width + ATLAS_PAD * 2;
    const h = images[i].height + ATLAS_PAD * 2;
    if (w > ATLAS_WIDTH) throw new WorldDataError(`texture ${images[i].key.archive}:${images[i].key.record} is wider than the atlas`);
    if (x + w > ATLAS_WIDTH) {
      x = 0;
      y += shelf;
      shelf = 0;
    }
    place[i] = { x, y };
    x += w;
    shelf = Math.max(shelf, h);
  }
  let height = 1;
  while (height < y + shelf) height *= 2;
  const width = ATLAS_WIDTH;
  const pixels = new Uint8Array(width * height * 4);
  const rects = new Map();
  for (let i = 0; i < images.length; i++) {
    const { width: w, height: h, data, key } = images[i];
    const { x: px, y: py } = place[i];
    for (let yy = -ATLAS_PAD; yy < h + ATLAS_PAD; yy++) {
      const sy = ((yy % h) + h) % h;
      for (let xx = -ATLAS_PAD; xx < w + ATLAS_PAD; xx++) {
        const sx = ((xx % w) + w) % w;
        const idx = data[sy * w + sx];
        const o = ((py + ATLAS_PAD + yy) * width + (px + ATLAS_PAD + xx)) * 4;
        pixels[o] = palette[idx * 3];
        pixels[o + 1] = palette[idx * 3 + 1];
        pixels[o + 2] = palette[idx * 3 + 2];
        pixels[o + 3] = idx === 0 ? 0 : 255; // DFU MaterialReader: model palette index 0 is transparent
      }
    }
    rects.set(key.id, { u0: (px + ATLAS_PAD) / width, v0: (py + ATLAS_PAD) / height, du: w / width, dv: h / height, width: w, height: h });
  }
  return { atlas: { width, height, pixels }, rects };
}

class Growable {
  constructor(n) {
    this.a = new Float32Array(n);
    this.n = 0;
  }
  push(...v) {
    if (this.n + v.length > this.a.length) {
      const b = new Float32Array(Math.max(this.a.length * 2, this.n + v.length));
      b.set(this.a);
      this.a = b;
    }
    for (const x of v) this.a[this.n++] = x;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

/**
 * Collect the static doors of placed models without building geometry (server-side validation path).
 * @param {Array<{modelId:number, matrix:number[]}>} placements
 */
export async function placedDoors(lib, placements) {
  const out = [];
  for (let i = 0; i < placements.length; i++) {
    const pl = placements[i];
    const mesh = await lib.mesh(pl.modelId);
    for (const d of mesh.doors) out.push({ ...placeDoor(d, pl.matrix), placement: i, modelId: pl.modelId });
  }
  return out;
}

/**
 * Build renderer-ready output for placed models.
 * @param {ModelLibrary} lib
 * @param {Array<{modelId:number, matrix:number[]}>} placements  Unity-space placement matrices
 * @param {{climateBase?: number|null, label: string}} opts
 */
export async function buildScene(lib, placements, { climateBase = null, label }) {
  const keyMap = new Map();
  const fallbacks = new Set();
  const keyOf = (plane) => {
    let archive = climateBase == null ? plane.archive : applyClimate(plane.archive, plane.record, climateBase);
    if (!lib.index.has(textureFileName(archive))) {
      if (archive !== plane.archive) fallbacks.add(`${archive}->${plane.archive}`);
      archive = plane.archive;
    }
    const id = `${archive}:${plane.record}`;
    if (!keyMap.has(id)) keyMap.set(id, { id, archive, record: plane.record });
    return id;
  };
  const meshes = [];
  for (const pl of placements) {
    const mesh = await lib.mesh(pl.modelId);
    meshes.push(mesh);
    for (const p of mesh.planes) keyOf(p);
  }
  if (!placements.length) throw new WorldDataError(`${label}: nothing to build`);
  const { atlas, rects } = await buildAtlas([...keyMap.values()], lib);

  const pos = new Growable(1 << 18);
  const uvs = new Growable(1 << 17);
  const sink = {
    tri(a, b, c, ua, ub, uc) {
      pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      uvs.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
    },
  };
  const doors = [];
  const ranges = [];
  for (let i = 0; i < placements.length; i++) {
    const { matrix, alternate } = placements[i];
    const mesh = meshes[i];
    const first = pos.n / 9;
    const alternative = alternate ? new Growable(128) : null;
    const alternativeSink = alternative && {
      tri(a, b, c) {
        alternative.push(a[0], a[1], -a[2], b[0], b[1], -b[2], c[0], c[1], -c[2]);
      },
    };
    for (const plane of mesh.planes) {
      const rect = rects.get(keyOf(plane));
      const polygon = (transform) => plane.points.map((q) => ({
        p: point(transform, q.x * SCALE, -q.y * SCALE, q.z * SCALE),
        s: q.u / rect.width,
        t: q.v / rect.height,
      }));
      emitTexturedPolygon(sink, polygon(matrix), rect);
      if (alternative) emitTexturedPolygon(alternativeSink, polygon(alternate), rect);
    }
    const range = { firstTriangle: first, triangleCount: pos.n / 9 - first };
    if (alternative) range.alternate = alternative.done();
    ranges.push(range);
    for (const d of mesh.doors) doors.push({ ...placeDoor(d, matrix), placement: i, modelId: placements[i].modelId });
  }
  const positions = pos.done();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i + 2] = -positions[i + 2];
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return {
    positions,
    colors: new Float32Array(positions.length).fill(1),
    uv: uvs.done(),
    atlas,
    uvConvention: 'atlas-v-down',
    frontFace: 'ccw',
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
    doors,
    ranges,
    stats: {
      modelInstances: placements.length,
      uniqueModels: new Set(placements.map((p) => p.modelId)).size,
      textures: rects.size,
      triangles: positions.length / 9,
      droppedPlanes: [...new Set(meshes)].reduce((a, m) => a + m.failedPlanes, 0),
      climateSwapFallbacks: [...fallbacks],
    },
  };
}
