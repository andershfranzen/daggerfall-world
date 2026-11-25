// loadTown(files): assemble a Daggerfall town exterior from the player's own
// ARENA2 data as flat, renderer-ready triangle arrays. Output contract:
// client/world/README.md.
//
// Layout transforms follow Daggerfall Unity's Utility/RMBLayout.cs,
// Internal/DaggerfallLocation.cs, MeshReader.cs and Utility/ClimateSwaps.cs
// (MIT, (c) 2009-2023 Daggerfall Workshop). See THIRD_PARTY_NOTICES.txt.
//
// Internally everything is first placed in DFU's left-handed "Unity" space
// (x east, y up, z north, metres = native units * 0.025), then mirrored to the
// right-handed output space (x east, y up, -z north) and translated so the
// spawn point is the origin.

import { BsaArchive, NAME_RECORD, NUMBER_RECORD, readBlob } from './bsa.js';
import { climateAt, climateSettings, regionIndexOf } from './maps.js';
import { parseRmb } from './blocks.js';
import { decodeMesh, patchRecord } from './arch3d.js';
import { TextureArchive, parsePalette, textureFileName } from './textures.js';
import { indexFiles, requireFiles } from './files.js';
import { WorldDataError } from './errors.js';
import { defaultWorldData, readLocationReplaced, resolveRmbBlock, rmbModelLocal } from './wilderness/replacements.js';
import { townFlatColliders } from './scenery/colliders.js';
import { GATE_OPEN, GATE_CLOSED, isCityGate } from './cityGates.js';

export { WorldDataError };

export const DEFAULT_TOWN = Object.freeze({ region: 'Daggerfall', location: 'Gothway Garden' });

/** DFU MeshReader.GlobalScale: metres per native unit. */
export const SCALE = 0.025;
const RMB_DIMENSION = 4096; // native units per block side
export const BLOCK_SIZE = RMB_DIMENSION * SCALE; // 102.4 m
const TILE_SIZE = BLOCK_SIZE / 16; // 6.4 m
const ROTATION_DIVISOR = 5.68888888888889; // native yaw units per degree
const PROPS_OFFSET_Y = -4; // RMBLayout.propsOffsetY (native units)
/** DaggerfallGroundPlane.GroundOffset * GlobalScale: ground mesh sits 2.5 cm below y=0 to avoid depth fighting. */
export const GROUND_MESH_Y = -1 * SCALE;
const ATLAS_WIDTH = 2048;
/** TEXTURE.x02 ground records: 46 = cobbled road, 47 = road edge (verified by mean colour, see README). */
export const STREET_TILES = new Set([46]);
export const ROAD_TILES = new Set([46, 47]);
/** Walkable non-water ground: everything except records 0 (water) and the shore/water edge sets 4, 19-22, 49 (mean colour is blue). */
const WALKABLE_TILES = new Set(Array.from({ length: 56 }, (_, i) => i).filter((i) => ![0, 4, 19, 20, 21, 22, 49].includes(i)));
/**
 * Spawn tiers, tried in order. Towns with cobbled streets (Gothway Garden
 * included) resolve in the first; road-less hamlets, farms and manors fall
 * through to plain walkable ground.
 */
export const SPAWN_TIERS = [
  { name: 'street', here: STREET_TILES, ahead: ROAD_TILES, aheadTiles: 3 },
  { name: 'road', here: ROAD_TILES, ahead: ROAD_TILES, aheadTiles: 1 },
  { name: 'ground', here: WALKABLE_TILES, ahead: WALKABLE_TILES, aheadTiles: 1 },
];
const ATLAS_PAD = 2;

// ---------------------------------------------------------------------------
// Climate texture swaps (Daggerfall Unity ClimateSwaps.ApplyClimate).

const SNOW_SETS = new Set([2, 7, 9, 12, 14, 17, 26, 29, 35, 38, 42, 58, 61, 64, 69, 79, 80, 82, 83]);
const CLIMATE_SETS = new Set([
  ...SNOW_SETS, 74,
  11, 16, 19, 20, 22, 23, 24, 25, 28, 37, 40, 41, 44, 45, 47, 48, 60, 63, 66, 68,
]);
const SUPPRESS_CLIMATE_INDEX = new Set([75, 76, 77, 79, 80, 82, 83]);

export function applyClimate(archive, record, climateBase, winter = false) {
  if (archive % 100 === 74 && record === 3) return archive;
  if (archive > 499) return winter && climateBase !== 0 && [504, 506, 508, 510].includes(archive) ? archive + 1 : archive;
  const set = archive % 100;
  if (!CLIMATE_SETS.has(set)) return archive;
  if (climateBase === 400 && set === 41) return archive; // swamp has no marble floors
  const base = SUPPRESS_CLIMATE_INDEX.has(archive) ? archive : climateBase + set;
  const snow = winter && climateBase !== 0 && SNOW_SETS.has(set)
    && !(climateBase === 400 && set === 35) && !(set === 9 && record > 3) && !(archive === 82 && record > 1);
  return snow ? base + 1 : base;
}

// ---------------------------------------------------------------------------
// Ground tiles (MeshReader.GetSimpleGroundPlaneMesh + TextureReader tileset atlas)

/**
 * Image-space (s right, t down) sample coordinates of a ground tile's four
 * corners, ordered [SW, SE, NE, NW] in world space, for the tile's rotation
 * and flip bits. In DFU the unrotated image's top edge faces north (+z).
 * Variants per TextureReader.GetTerrainTilesetTexture: rotate = 90deg CCW,
 * flip = 180deg, rotate+flip = rotate(flip).
 */
export function groundTileCorners(bitfield) {
  const rotated = (bitfield & 0x40) !== 0;
  const flipped = (bitfield & 0x80) !== 0;
  // Bottom-up texture coords (u right, v up) of each world corner, before variant.
  const corners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  // dst(u,v) samples src(f(u,v)).
  const map = ([u, v]) => {
    if (rotated && !flipped) return [v, 1 - u];
    if (!rotated && flipped) return [1 - u, 1 - v];
    if (rotated && flipped) return [1 - v, u];
    return [u, v];
  };
  return corners.map((c) => {
    const [u, v] = map(c);
    return [u, 1 - v]; // to image space (t down)
  });
}

/** Ground tile texture record (bits 0-5); DFU draws records >= 56 as grass (record 2). */
export const groundTileRecord = (bitfield) => ((bitfield & 0x3f) < 56 ? bitfield & 0x3f : 2);

// ---------------------------------------------------------------------------
// Geometry helpers

function yawMatrix(degrees) {
  const r = (degrees * Math.PI) / 180;
  return { c: Math.cos(r), s: Math.sin(r) };
}
// Unity Quaternion.Euler(0, deg, 0) applied to (x, z).
const rotY = (m, x, z) => [x * m.c + z * m.s, -x * m.s + z * m.c];

/** Sutherland-Hodgman clip of a convex polygon (vertices {p:[x,y,z], s, t}) to an axis range on s or t. */
function clipAxis(poly, key, lo, hi) {
  const clipOne = (input, inside, intersectAt) => {
    const out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i];
      const b = input[(i + 1) % input.length];
      const ain = inside(a);
      const bin = inside(b);
      if (ain) out.push(a);
      if (ain !== bin) {
        const k = (intersectAt - a[key]) / (b[key] - a[key]);
        out.push({
          p: [a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k],
          s: key === 's' ? intersectAt : a.s + (b.s - a.s) * k,
          t: key === 't' ? intersectAt : a.t + (b.t - a.t) * k,
        });
      }
    }
    return out;
  };
  let r = clipOne(poly, (q) => q[key] >= lo, lo);
  if (r.length < 3) return r;
  r = clipOne(r, (q) => q[key] <= hi, hi);
  return r;
}

const MAX_CELLS_PER_PLANE = 4096;

/**
 * Split a textured convex polygon at integer s/t lines so every piece maps into
 * one texture repeat, then emit fan triangles with atlas UVs. DFU's
 * MeshReader.LoadIndices emits (q0, q[i+1], q[i]), clockwise-front for Unity.
 * The z mirror to output space leaves the on-screen winding unchanged, so for
 * WebGL's counter-clockwise front faces each triangle is reversed: (q0, q[i], q[i+1]).
 */
export function emitTexturedPolygon(out, poly, rect) {
  let minS = Infinity, maxS = -Infinity, minT = Infinity, maxT = -Infinity;
  for (const q of poly) {
    if (q.s < minS) minS = q.s;
    if (q.s > maxS) maxS = q.s;
    if (q.t < minT) minT = q.t;
    if (q.t > maxT) maxT = q.t;
  }
  const eps = 1e-6;
  const s0 = Math.floor(minS + eps), s1 = Math.max(s0 + 1, Math.ceil(maxS - eps));
  const t0 = Math.floor(minT + eps), t1 = Math.max(t0 + 1, Math.ceil(maxT - eps));
  if ((s1 - s0) * (t1 - t0) > MAX_CELLS_PER_PLANE) {
    throw new WorldDataError(`texture repeats ${(s1 - s0) * (t1 - t0)} times on one face`);
  }
  for (let i = s0; i < s1; i++) {
    const colPoly = s1 - s0 === 1 ? poly : clipAxis(poly, 's', i, i + 1);
    if (colPoly.length < 3) continue;
    for (let j = t0; j < t1; j++) {
      const cell = t1 - t0 === 1 ? colPoly : clipAxis(colPoly, 't', j, j + 1);
      if (cell.length < 3) continue;
      const uvOf = (q) => {
        const ls = Math.min(1, Math.max(0, q.s - i));
        const lt = Math.min(1, Math.max(0, q.t - j));
        return [rect.u0 + ls * rect.du, rect.v0 + lt * rect.dv];
      };
      for (let k = 1; k < cell.length - 1; k++) out.tri(cell[0].p, cell[k].p, cell[k + 1].p, uvOf(cell[0]), uvOf(cell[k]), uvOf(cell[k + 1]));
    }
  }
}

class GrowableF32 {
  constructor(n = 1 << 16) {
    this.a = new Float32Array(n);
    this.n = 0;
  }
  push3(x, y, z) {
    if (this.n + 3 > this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
    this.a[this.n++] = y;
    this.a[this.n++] = z;
  }
  push2(x, y) {
    if (this.n + 2 > this.a.length) {
      const b = new Float32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
    this.a[this.n++] = y;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

// ---------------------------------------------------------------------------
// Texture atlas

async function buildAtlas(keys, index, palette, label) {
  const archives = new Map();
  const images = [];
  for (const key of keys) {
    const { archive, record, opaque } = key;
    let ta = archives.get(archive);
    if (ta === undefined) {
      const name = textureFileName(archive);
      const f = index.get(name);
      if (!f) throw new WorldDataError(`${name} is missing from the selected Daggerfall data (needed by ${label})`);
      ta = new TextureArchive(new Uint8Array(await f.arrayBuffer()), archive);
      archives.set(archive, ta);
    }
    const img = ta.decode(record);
    images.push({ key, ...img });
  }
  // Shelf pack, tallest first.
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
    // Padding repeats the texture (wrap), matching DFU's repeat sampling.
    for (let yy = -ATLAS_PAD; yy < h + ATLAS_PAD; yy++) {
      const sy = ((yy % h) + h) % h;
      for (let xx = -ATLAS_PAD; xx < w + ATLAS_PAD; xx++) {
        const sx = ((xx % w) + w) % w;
        const idx = data[sy * w + sx];
        const o = ((py + ATLAS_PAD + yy) * width + (px + ATLAS_PAD + xx)) * 4;
        pixels[o] = palette[idx * 3];
        pixels[o + 1] = palette[idx * 3 + 1];
        pixels[o + 2] = palette[idx * 3 + 2];
        // DFU MaterialReader: model textures treat palette index 0 as transparent; ground tiles are opaque.
        pixels[o + 3] = !key.opaque && idx === 0 ? 0 : 255;
      }
    }
    rects.set(key.id, {
      u0: (px + ATLAS_PAD) / width,
      v0: (py + ATLAS_PAD) / height,
      du: w / width,
      dv: h / height,
      width: w,
      height: h,
    });
  }
  return { atlas: { width, height, pixels }, rects };
}

// ---------------------------------------------------------------------------
// Spawn search

/**
 * Choose a navigable street point: on a cobbled road tile with road continuing
 * three tiles (19.2 m) to the north, no geometry between 0.1 m and 2.2 m within
 * 1.5 m, and a clear 1 m wide, 12 m long corridor looking north. Candidates are
 * tile centres and tile-edge midpoints, nearest the town centre first.
 */
function findSpawn(tris, groundTiles, widthBlocks, heightBlocks, tiers) {
  const cell = 0.5;
  const W = Math.ceil((widthBlocks * BLOCK_SIZE) / cell);
  const H = Math.ceil((heightBlocks * BLOCK_SIZE) / cell);
  const blocked = new Uint8Array(W * H);
  const lo = 0.1, hi = 2.2;
  for (let i = 0; i < tris.length; i += 9) {
    const y0 = tris[i + 1], y1 = tris[i + 4], y2 = tris[i + 7];
    if (Math.max(y0, y1, y2) < lo || Math.min(y0, y1, y2) > hi) continue;
    const minX = Math.min(tris[i], tris[i + 3], tris[i + 6]);
    const maxX = Math.max(tris[i], tris[i + 3], tris[i + 6]);
    const minZ = Math.min(tris[i + 2], tris[i + 5], tris[i + 8]);
    const maxZ = Math.max(tris[i + 2], tris[i + 5], tris[i + 8]);
    const cx0 = Math.max(0, Math.floor(minX / cell)), cx1 = Math.min(W - 1, Math.floor(maxX / cell));
    const cz0 = Math.max(0, Math.floor(minZ / cell)), cz1 = Math.min(H - 1, Math.floor(maxZ / cell));
    for (let z = cz0; z <= cz1; z++) for (let x = cx0; x <= cx1; x++) blocked[z * W + x] = 1;
  }
  const isBlocked = (x, z) => {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    if (cx < 0 || cz < 0 || cx >= W || cz >= H) return true;
    return blocked[cz * W + cx] === 1;
  };
  const tileAt = (x, z) => {
    const bx = Math.floor(x / BLOCK_SIZE), bz = Math.floor(z / BLOCK_SIZE);
    if (bx < 0 || bz < 0 || bx >= widthBlocks || bz >= heightBlocks) return -1;
    const tx = Math.floor((x - bx * BLOCK_SIZE) / TILE_SIZE);
    const tz = Math.floor((z - bz * BLOCK_SIZE) / TILE_SIZE);
    return groundTileRecord(groundTiles[bz * widthBlocks + bx][(15 - tz) * 16 + tx]);
  };
  const ok = (x, z, tier) => {
    if (!tier.here.has(tileAt(x, z))) return false;
    for (let k = 1; k <= tier.aheadTiles; k++) if (!tier.ahead.has(tileAt(x, z + k * TILE_SIZE))) return false;
    for (let dz = -1.5; dz <= 1.5; dz += cell) {
      for (let dx = -1.5; dx <= 1.5; dx += cell) {
        if (dx * dx + dz * dz <= 2.25 && isBlocked(x + dx, z + dz)) return false;
      }
    }
    for (let d = 0; d <= 12; d += cell) {
      for (const dx of [-0.5, 0, 0.5]) if (isBlocked(x + dx, z + d)) return false;
    }
    return true;
  };
  const cx = (widthBlocks * BLOCK_SIZE) / 2, cz = (heightBlocks * BLOCK_SIZE) / 2;
  const candidates = [];
  const n = TILE_SIZE / 2;
  for (let z = n / 2; z < heightBlocks * BLOCK_SIZE; z += n) {
    for (let x = n / 2; x < widthBlocks * BLOCK_SIZE; x += n) candidates.push([x, z, (x - cx) ** 2 + (z - cz) ** 2]);
  }
  candidates.sort((a, b) => a[2] - b[2]);
  for (const tier of tiers) {
    for (const [x, z] of candidates) if (ok(x, z, tier)) return { x, z, tileRecord: tileAt(x, z), tier: tier.name };
  }
  return null;
}

/**
 * A block without streets (the "Your Ship" decks, SHIPAA00/SHIPAA01) is entered at its first editor start
 * marker, as DFU's StreamingWorld RandomStartMarker does. Unity space, placed like the sub-record's models.
 */
function startMarkerSpawn(blocks) {
  for (const b of blocks) {
    for (const sub of b.rmb.subRecords ?? []) {
      const m = sub.startMarkers?.[0];
      // Block-relative like the misc records (RMBLayout: x, z + RMBDimension).
      if (m) return { x: b.x * BLOCK_SIZE + m.xPos * SCALE, z: b.y * BLOCK_SIZE + (m.zPos + RMB_DIMENSION) * SCALE, markerY: -m.yPos * SCALE, tileRecord: -1, tier: 'start-marker' };
    }
  }
  // No marker (SHIPAA01): the origin of the block's first building model, as placed in the loop above.
  for (const b of blocks) {
    const sub = b.rmb.subRecords?.[0];
    const m = sub?.models?.[0];
    if (!m) continue;
    const [rx, rz] = rotY(yawMatrix(-sub.yRotation / ROTATION_DIVISOR), m.xPos * SCALE, m.zPos * SCALE);
    return { x: b.x * BLOCK_SIZE + sub.xPos * SCALE + rx, z: b.y * BLOCK_SIZE + (RMB_DIMENSION - sub.zPos) * SCALE + rz, tileRecord: -1, tier: 'model-origin' };
  }
  return null;
}

/**
 * Foot height on a deck for a spawn without streets: DFU's PlayerMotor.FixStanding drops an arrival from the
 * marker onto the first floor below it, so the body stands on the highest upward-facing model surface under
 * the spawn that is no more than a step above the marker (any height for the marker-less SHIPAA01) and has
 * standing room. Unity space, model triangles only (the sea-level ground tiles are not a deck).
 */
export function deckHeight(positions, x, z, cap = Infinity, { step = 0.75, height = 1.8 } = {}) {
  const hs = [];
  for (let o = 0; o + 9 <= positions.length; o += 9) {
    const ax = positions[o], ay = positions[o + 1], az = positions[o + 2];
    const bx = positions[o + 3], by = positions[o + 4], bz = positions[o + 5];
    const cx = positions[o + 6], cy = positions[o + 7], cz = positions[o + 8];
    const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(d) < 1e-9) continue;
    const w1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d;
    const w2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d;
    const w3 = 1 - w1 - w2;
    if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const ny = uz * vx - ux * vz, len = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
    hs.push({ y: w1 * ay + w2 * by + w3 * cy, up: len > 0 && Math.abs(ny) / len >= 0.55 });
  }
  const floors = hs.filter((h) => h.up && h.y <= cap + step).map((h) => h.y).sort((a, b) => b - a);
  for (const y of floors) if (!hs.some((h) => h.y > y + step && h.y < y + height)) return y;
  return null;
}

// ---------------------------------------------------------------------------

/**
 * Load a town exterior from local Daggerfall files.
 * @param {Iterable<File>} files - files of an ARENA2 folder or of the folder containing it
 * @param {{region?: string|number, location?: string|number, worldData?: object|null}} [options] - defaults to Gothway Garden, Daggerfall.
 *   `worldData`: Daggerfall Unity WorldData replacements (wilderness/replacements.js); null forces vanilla. Omitted:
 *   the page uses the game server's, Node uses none (the server passes its provider explicitly).
 *   `winter`: Daggerfall Unity's ClimateSeason.Winter textures (snow ground, roofs and walls where the climate has them);
 *   geometry is the same either way (client/world/exterior/season.js).
 * @returns {Promise<object>} see client/world/README.md
 */
export async function loadTown(files, options = {}) {
  const regionName = options.region ?? DEFAULT_TOWN.region;
  const locationName = options.location ?? DEFAULT_TOWN.location;
  const index = indexFiles(files);
  const [mapsF, blocksF, archF, climateF, palF] = requireFiles(index, ['MAPS.BSA', 'BLOCKS.BSA', 'ARCH3D.BSA', 'CLIMATE.PAK', 'ART_PAL.COL']);

  const region = regionIndexOf(regionName);

  const maps = await BsaArchive.open(mapsF, 'MAPS.BSA', NAME_RECORD);
  const blocksBsa = await BsaArchive.open(blocksF, 'BLOCKS.BSA', NAME_RECORD);
  const arch = await BsaArchive.open(archF, 'ARCH3D.BSA', NUMBER_RECORD);
  const palette = parsePalette(await readBlob(palF, 0, palF.size), 'ART_PAL.COL');

  const worldData = options.worldData !== undefined ? options.worldData : defaultWorldData(files);
  const loc = await readLocationReplaced(maps, region, locationName, worldData);
  const climateValue = climateAt(await readBlob(climateF, 0, climateF.size), loc.longitude, loc.latitude);
  const climate = climateSettings(climateValue);
  const winter = !!options.winter;
  // TerrainMaterialProvider.GetClimateInfo: snow ground in winter except for desert-based climates.
  const groundArchive = winter && climate.climateBase !== 0 ? climate.groundArchive + 1 : climate.groundArchive;

  // --- Blocks and model instances (Unity space) ---
  const blocks = [];
  const instances = []; // { modelId, place(x,y,z) -> [x,y,z] }
  for (let by = 0; by < loc.height; by++) {
    for (let bx = 0; bx < loc.width; bx++) {
      const wanted = loc.blockNames[by * loc.width + bx];
      const r = await resolveRmbBlock(blocksBsa, wanted, worldData);
      if (r.index < 0) throw new WorldDataError(`BLOCKS.BSA: block ${wanted} (used by ${loc.name}) is missing`);
      const bytes = r.block ? null : await blocksBsa.read(r.index);
      const rmb = r.block ?? parseRmb(bytes, r.name);
      const ox = bx * BLOCK_SIZE, oz = by * BLOCK_SIZE;
      blocks.push({ name: rmb.name, x: bx, y: by, rmb, bytes });
      for (const sub of rmb.subRecords) {
        const sm = yawMatrix(-sub.yRotation / ROTATION_DIVISOR);
        const sx = sub.xPos * SCALE, sz = (RMB_DIMENSION - sub.zPos) * SCALE;
        for (const m of sub.models) {
          const mm = yawMatrix(-m.yRotation / ROTATION_DIVISOR);
          const mx = m.xPos * SCALE, my = -m.yPos * SCALE, mz = m.zPos * SCALE;
          instances.push({
            modelId: m.modelId,
            place: (x, y, z) => {
              const [ax, az] = rotY(mm, x, z);
              const [bx2, bz2] = rotY(sm, ax + mx, az + mz);
              return [ox + sx + bx2, y + my, oz + sz + bz2];
            },
            rotate: (x, z) => rotY(sm, ...rotY(mm, x, z)),
          });
        }
      }
      for (const m of rmb.misc3d) {
        const mm = yawMatrix(-m.yRotation / ROTATION_DIVISOR);
        const mx = m.xPos * SCALE, my = (-m.yPos + PROPS_OFFSET_Y) * SCALE, mz = (m.zPos + RMB_DIMENSION) * SCALE;
        const local = rmbModelLocal(m, ROTATION_DIVISOR); // WorldData X/Z rotation and scale (RMBLayout misc TRS)
        instances.push({
          modelId: m.modelId,
          place: local
            ? (x, y, z) => {
                const [lx, ly, lz] = local(x, y, z);
                return [ox + mx + lx, ly + my, oz + mz + lz];
              }
            : (x, y, z) => {
                const [ax, az] = rotY(mm, x, z);
                return [ox + mx + ax, y + my, oz + mz + az];
              },
          rotate: (x, z) => rotY(mm, x, z),
        });
      }
    }
  }

  // --- Meshes ---
  const meshes = new Map();
  const modelIds = new Set(instances.map(inst => inst.modelId));
  if (modelIds.has(GATE_OPEN) || modelIds.has(GATE_CLOSED)) {
    modelIds.add(GATE_OPEN);
    modelIds.add(GATE_CLOSED);
  }
  for (const modelId of modelIds) {
    const k = arch.indexOfId(modelId);
    if (k < 0) throw new WorldDataError(`ARCH3D.BSA: model ${modelId} (used by ${loc.name}) is missing`);
    const bytes = await arch.read(k);
    patchRecord(bytes, arch.entries[k].position);
    meshes.set(modelId, decodeMesh(bytes, modelId));
  }

  // --- Texture keys ---
  const keyMap = new Map();
  const keyFor = (archive, record, opaque) => {
    const id = `${opaque ? 'g' : 'm'}${archive}:${record}`;
    if (!keyMap.has(id)) keyMap.set(id, { id, archive, record, opaque });
    return id;
  };
  const swapFallbacks = new Set();
  const textureKeyOfPlane = (p) => {
    let archive = applyClimate(p.archive, p.record, climate.climateBase, winter);
    if (!index.has(textureFileName(archive))) {
      swapFallbacks.add(`${archive}->${p.archive}`);
      archive = p.archive;
    }
    return keyFor(archive, p.record, false);
  };
  for (const mesh of meshes.values()) for (const p of mesh.planes) p.key = textureKeyOfPlane(p);
  for (const b of blocks) for (const t of b.rmb.groundTiles) keyFor(groundArchive, groundTileRecord(t), true);
  const { atlas, rects } = await buildAtlas([...keyMap.values()], index, palette, loc.name);

  // --- Emit Unity-space triangles ---
  const pos = new GrowableF32(1 << 20);
  const uvs = new GrowableF32(1 << 19);
  function triangles(points, tex) {
    return { tri(a, b, c, ua, ub, uc) {
      points.push3(...a);
      points.push3(...b);
      points.push3(...c);
      tex.push2(...ua);
      tex.push2(...ub);
      tex.push2(...uc);
    } };
  }
  function emitModel(inst, id, out) {
    const mesh = meshes.get(id);
    for (const plane of mesh.planes) {
      const rect = rects.get(plane.key);
      const poly = plane.points.map((q) => ({
        p: inst.place(q.x * SCALE, -q.y * SCALE, q.z * SCALE),
        s: q.u / rect.width,
        t: q.v / rect.height,
      }));
      emitTexturedPolygon(out, poly, rect);
    }
  }
  const sink = triangles(pos, uvs);
  const mechanisms = [];
  for (const inst of instances) {
    if (!isCityGate(inst.modelId)) {
      emitModel(inst, inst.modelId, sink);
      continue;
    }
    const firstTriangle = pos.n / 9;
    emitModel(inst, GATE_OPEN, sink);
    const alt = new GrowableF32(512), altUv = new GrowableF32(512);
    const altSink = triangles(alt, altUv);
    emitModel(inst, GATE_CLOSED, altSink);
    const triangleCount = Math.max(pos.n / 9 - firstTriangle, alt.n / 9);
    // Both phase variants occupy the same GPU range. Degenerate padding has
    // no visible surface and no collision.
    const padTo = (out, count) => {
      const p = inst.place(0, 0, 0), uv = [0, 0];
      for (let i = count; i < triangleCount; ++i) out.tri(p, p, p, uv, uv, uv);
    };
    padTo(sink, pos.n / 9 - firstTriangle);
    padTo(altSink, alt.n / 9);
    mechanisms.push({ id: `gate:${mechanisms.length}`, firstTriangle, triangleCount, alternate: alt.done(), alternateUv: altUv.done() });
  }
  const modelTriangles = pos.n / 9;
  const modelVertexFloats = pos.n;

  // Ground: one quad per 6.4 m tile at GROUND_MESH_Y.
  for (const b of blocks) {
    for (let tz = 0; tz < 16; tz++) {
      for (let tx = 0; tx < 16; tx++) {
        const bits = b.rmb.groundTiles[(15 - tz) * 16 + tx];
        const rect = rects.get(`g${groundArchive}:${groundTileRecord(bits)}`);
        const x0 = b.x * BLOCK_SIZE + tx * TILE_SIZE, z0 = b.y * BLOCK_SIZE + tz * TILE_SIZE;
        const x1 = x0 + TILE_SIZE, z1 = z0 + TILE_SIZE;
        const y = GROUND_MESH_Y;
        const c = groundTileCorners(bits).map(([s, t]) => [rect.u0 + s * rect.du, rect.v0 + t * rect.dv]);
        const sw = [x0, y, z0], se = [x1, y, z0], ne = [x1, y, z1], nw = [x0, y, z1];
        // Counter-clockwise seen from above in output space (DFU's sw,nw,ne / sw,ne,se reversed).
        sink.tri(sw, ne, nw, c[0], c[2], c[3]);
        sink.tri(sw, se, ne, c[0], c[1], c[2]);
      }
    }
  }

  const unityPositions = pos.done();
  const uv = uvs.done();

  // --- Spawn (Unity space) ---
  const groundTiles = blocks.map((b) => b.rmb.groundTiles);
  const spawnU = findSpawn(unityPositions.subarray(0, modelVertexFloats), groundTiles, loc.width, loc.height, SPAWN_TIERS)
    ?? startMarkerSpawn(blocks);
  if (!spawnU) throw new WorldDataError(`${loc.name}: no open street found for the spawn point`);
  // A deck spawn (the ships) stands on the model, not on the sea-level ground mesh.
  const spawnY = spawnU.tileRecord === -1
    ? deckHeight(unityPositions.subarray(0, modelVertexFloats), spawnU.x, spawnU.z, spawnU.markerY ?? Infinity) ?? 0 : 0;

  // --- Mirror to output space and centre on spawn ---
  const positions = unityPositions;
  for (const { alternate } of mechanisms) {
    for (let i = 0; i < alternate.length; i += 3) {
      alternate[i] -= spawnU.x;
      alternate[i + 2] = -(alternate[i + 2] - spawnU.z);
    }
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= spawnU.x;
    positions[i + 2] = -(positions[i + 2] - spawnU.z);
    const x = positions[i]; // bounds from the stored float32 values
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
    const y = positions[i + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const colors = new Float32Array(positions.length).fill(1);
  const triangleCount = positions.length / 9;
  // Solid flats (trees, rocks, wells, lamp posts) as upright cylinders for CollisionWorld.
  const colliders = options.flatColliders === false ? null
    : await townFlatColliders(index, blocks, { x: spawnU.x, z: spawnU.z }, climateValue);

  return {
    name: loc.name,
    ...(loc.replaced ? { displayName: loc.displayName } : {}),
    region: loc.regionName,
    positions,
    colors,
    uv,
    atlas,
    uvConvention: 'atlas-v-down',
    frontFace: 'ccw',
    bounds: { minX, maxX, minZ, maxZ, minY, maxY },
    spawn: { x: 0, y: spawnY, z: 0, yaw: 0, forward: [0, 0, -1], ...(spawnY ? { deck: true } : {}) },
    colliders,
    look: { winter },
    ...(mechanisms.length ? { mechanisms } : {}),
    ground: {
      included: true,
      meshY: GROUND_MESH_Y,
      walkY: 0,
      firstTriangle: modelTriangles,
      triangleCount: triangleCount - modelTriangles,
    },
    source: {
      townId: loc.townId,
      region: loc.regionName,
      regionIndex: region,
      locationIndex: loc.index,
      mapId: loc.mapId,
      longitude: loc.longitude,
      latitude: loc.latitude,
      climate: { value: climateValue, ...climate },
      width: loc.width,
      height: loc.height,
      blocks: blocks.map((b) => ({ name: b.name, x: b.x, y: b.y, ...(b.rmb.replaced ? { replaced: true } : {}) })),
      ...(loc.replaced ? { worldData: loc.replaced } : {}),
      spawnTileRecord: spawnU.tileRecord,
      spawnTier: spawnU.tier,
      spawnLocal: { x: spawnU.x, z: spawnU.z },
    },
    stats: {
      modelInstances: instances.length,
      uniqueModels: meshes.size,
      textures: rects.size,
      triangles: triangleCount,
      modelTriangles,
      groundTriangles: triangleCount - modelTriangles,
      droppedPlanes: [...meshes.values()].reduce((a, m) => a + m.failedPlanes, 0),
      climateSwapFallbacks: [...swapFallbacks],
    },
  };
}
