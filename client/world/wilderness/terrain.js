// Wilderness ground for one map pixel and its neighbours, from the player's WOODS.WLD.
//
// Pure, DOM- and Node-neutral: the browser renderer (scene.js) and the server (collision, spawn height) import the same
// functions, so the ground a player walks on is the ground drawn.
//
// Ported from Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop), .ref/daggerfall-unity:
//   - API/WoodsFile.cs: header, data offsets, small height map, 5x5 large map data per pixel,
//     GetHeightMapValuesRange1Dim and GetLargeHeightMapValuesRange (border stripped, rows inverted, map Y descending).
//   - Terrain/DefaultTerrainSampler.cs GenerateSamplesJob: bicubic small map * 8 + bicubic large map * 4 + ground noise
//     GetNoise(0.3)*GetNoise(0.9)*10, ocean floor 3.4*8, sample = clamp01(h / 1539). Index law (JobHelpers.cs JobA):
//     sample(x east, y north) = data[y + x * 129].
//   - Terrain/TerrainTexturing.cs GenerateTileDataJob + AssignTilesJob: water / beach dirt (+-1.5 jitter from
//     Unity.Mathematics Random.CreateFromIndex) / Perlin-weighted dirt, grass, stone, then the 64-entry marching squares
//     lookup that yields Daggerfall ground tile bytes (record 0-55, +64 rotate, +128 flip).
//   - Terrain/TerrainNature.cs DefaultTerrainNature: chances 0.2 dirt / 0.9 grass / 0.05 stone, elevation scale
//     clamp(worldHeight/128, 0.4, 1), desert x0.25, steepness <= 50 deg, beach line, records 1-31, sink steepness/70.
//   - StreamingWorld's game-scene TerrainScale 1.25 (DaggerfallUnityGame.unity), MaxTerrainHeight 1539.
// Adapted with credit from the MIT port in .ref/dfjs-research-03 ((c) 2026 Lattymoy): src/formats/woodsFile.js,
// src/formats/umRandom.js, src/world/perlin.js, src/world/terrain/terrainSampler.js and terrainTiles.js.
//
// Location Loader behaviour (World of Daggerfall's loader, KABoissonneault/DFU-LocationLoader; no license file, so no
// code is copied - this is an independent implementation of the behaviour it documents in LocationLoader.cs):
//   - each instance's ground = mean of the heightmap samples over its tile rect, bounds inclusive, clamped to 0..128;
//   - type 0 rects flatten the terrain: every interior sample (1..126 on both axes) within 10 tiles of the nearest rect
//     is lerped from that rect's ground to the original height by SmoothStep(0, 1, distance / 10);
//   - type 1 roots stand on their ground plus Lerp(0, heightOffset, sink), heightOffset = min(0, lowest sample under
//     the rect - ground); type 2/3 stand at the ocean elevation (3.4 * 8 * TerrainScale).
//
// DEPARTURES (stated, deterministic):
//   - Unity's Mathf.PerlinNoise is closed source. Ken Perlin's improved noise (reference permutation, z = 0, remapped
//     to [0, 1]) stands in, as in the MIT reference port. Heights differ from DFU by at most the ground-noise term
//     (<= 10 * 0.25 m of 1539 * 1.25 scale before clamping) and the dirt/grass/stone weights differ in detail.
//   - Nature flats use a xorshift128 generator seeded like Unity's Random.InitState(MakeTerrainKey(x, y)); Unity's
//     float/int range mapping is not public, so individual trees are not DFU's, only the rules and density are.
//   - Classic town footprints use their mean WOODS elevation and blend out across pixel boundaries.
//
// Frame: the scene frame of docs/wilderness-protocol.md - right-handed metres, +y up, east +x, north -z, origin at
// the centre of the visited pixel. Heights are absolute ground metres minus `datum` (y = 0 at the site ground).

export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 500;
export const HDIM = 129; // TerrainSampler.defaultHeightmapDimension
export const TDIM = 128; // MapsFile.WorldMapTileDim
export const PIXEL_SIZE = 819.2; // MapsFile.WorldMapTerrainDim * MeshReader.GlobalScale
export const HALF_PIXEL = PIXEL_SIZE / 2;
export const TILE_SIZE = PIXEL_SIZE / TDIM; // 6.4 m
export const MAX_TERRAIN_HEIGHT = 1539;
export const TERRAIN_SCALE = 1.25; // StreamingWorld.TerrainScale in the game scene
export const HEIGHT_MAX = MAX_TERRAIN_HEIGHT * TERRAIN_SCALE; // 1923.75 m for a sample of 1.0
const BASE_HEIGHT_SCALE = 8;
const NOISE_MAP_SCALE = 4;
const EXTRA_NOISE_SCALE = 10;
export const SCALED_OCEAN_ELEVATION = Math.fround(3.4 * BASE_HEIGHT_SCALE);
export const SCALED_BEACH_ELEVATION = Math.fround(5.0 * BASE_HEIGHT_SCALE);
/** Metres of a sample on the sea floor clamp (type 2/3 Location Loader roots stand here). */
export const OCEAN_Y = SCALED_OCEAN_ELEVATION * TERRAIN_SCALE;
const LL_TRANSITION = 10; // LocationLoader.BlendTerrain transitionWidth, tiles

export class TerrainDataError extends Error {}

// ------------------------------------------------------------------------------------------------ WOODS.WLD

/**
 * WOODS.WLD reader over a byte-range function, so a 26 MB file is never read whole in the browser.
 * `read(offset, length)` returns (a promise of) a Uint8Array.
 */
export class WoodsFile {
  static async open(read, size) {
    if (!(size >= 144 + MAP_WIDTH * MAP_HEIGHT * 4)) throw new TerrainDataError('WOODS.WLD is too short');
    const head = await read(0, 32);
    const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const width = v.getUint32(4, true), height = v.getUint32(8, true), heightMapOffset = v.getUint32(28, true);
    if (width * height !== MAP_WIDTH * MAP_HEIGHT) throw new TerrainDataError('WOODS.WLD: invalid Width*Height in header');
    if (heightMapOffset + MAP_WIDTH * MAP_HEIGHT > size) throw new TerrainDataError('WOODS.WLD: height map is truncated');
    const offBytes = await read(144, MAP_WIDTH * MAP_HEIGHT * 4);
    const offsets = new Uint32Array(MAP_WIDTH * MAP_HEIGHT);
    const ov = new DataView(offBytes.buffer, offBytes.byteOffset, offBytes.byteLength);
    for (let i = 0; i < offsets.length; i++) offsets[i] = ov.getUint32(i * 4, true);
    const heightMap = (await read(heightMapOffset, MAP_WIDTH * MAP_HEIGHT)).slice();
    return new WoodsFile({ read, size, offsets, heightMap });
  }

  /** From the whole file in memory (Node, tests). */
  static fromBytes(bytes) {
    const read = (o, n) => bytes.subarray(o, o + n);
    return WoodsFile.open(read, bytes.length);
  }

  constructor({ read, size, offsets, heightMap }) {
    this.read = read;
    this.size = size;
    this.offsets = offsets;
    this.heightMap = heightMap;
    this.large = new Map(); // pixel index -> Uint8Array(25), row-major as in the file
  }

  static clampX(x) { return x < 0 ? 0 : x >= MAP_WIDTH - 1 ? MAP_WIDTH - 1 : x; }
  static clampY(y) { return y < 0 ? 0 : y >= MAP_HEIGHT - 1 ? MAP_HEIGHT - 1 : y; }

  /** WoodsFile.GetHeightMapValue, DFU's clamp. */
  heightAt(px, py) {
    return this.heightMap[WoodsFile.clampY(py) * MAP_WIDTH + WoodsFile.clampX(px)];
  }

  /** Read every large-map record the sampler needs for these pixels (each pixel reads x-1..x+1, y-2..y). */
  async prefetch(pixels) {
    const want = new Set();
    for (const { px, py } of pixels) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -2; dy <= 0; dy++) {
        want.add(WoodsFile.clampY(py + dy) * MAP_WIDTH + WoodsFile.clampX(px + dx));
      }
    }
    const jobs = [];
    for (const i of want) {
      if (this.large.has(i)) continue;
      const at = this.offsets[i] + 22;
      if (at + 25 > this.size) throw new TerrainDataError(`WOODS.WLD: map data of pixel ${i % MAP_WIDTH},${Math.floor(i / MAP_WIDTH)} is truncated`);
      jobs.push(Promise.resolve(this.read(at, 25)).then((b) => this.large.set(i, b.slice(0, 25))));
    }
    await Promise.all(jobs);
  }

  /** WoodsFile.GetLargeMapData: data[x][y] = file byte at y * 5 + x. */
  largeAt(px, py, x, y) {
    const i = WoodsFile.clampY(py) * MAP_WIDTH + WoodsFile.clampX(px);
    const rec = this.large.get(i);
    if (!rec) throw new TerrainDataError(`WOODS.WLD: map data of pixel ${px},${py} was not read`);
    return rec[y * 5 + x];
  }

  /** GetHeightMapValuesRange1Dim: dst[x + y * dim]. */
  smallRange(px, py, dim) {
    const dst = new Uint8Array(dim * dim);
    for (let y = 0; y < dim; y++) for (let x = 0; x < dim; x++) dst[x + y * dim] = this.heightAt(px + x, py + y);
    return dst;
  }

  /** GetLargeHeightMapValuesRange flattened as DFU's job does: lhm[r + c * side] = lhm2[r, c]. */
  largeRange(px, py, dim) {
    const len = 3, side = dim * len;
    const dst = new Uint8Array(side * side);
    for (let y = 0; y < dim; y++) {
      for (let x = 0; x < dim; x++) {
        const sx = px + x, sy = py - y;
        for (let iy = 1; iy < 1 + len; iy++) {
          for (let ix = 1; ix < 1 + len; ix++) {
            // dstData[startX + ix - 1, startY + iy - 1] = srcData[ix, 4 - iy]  (WoodsFile.cs)
            const r = x * len + ix - 1, c = y * len + iy - 1;
            dst[r + c * side] = this.largeAt(sx, sy, ix, 4 - iy);
          }
        }
      }
    }
    return dst;
  }
}

// ------------------------------------------------------------------------------------------------ noise and random

const PERM = [
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21,
  10, 23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149,
  56, 87, 174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229,
  122, 60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209,
  76, 132, 187, 208, 89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217,
  226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42,
  223, 183, 170, 213, 119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98,
  108, 110, 79, 113, 224, 232, 178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179,
  162, 241, 81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50,
  45, 127, 4, 150, 254, 138, 236, 205, 93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180,
];
const P = new Uint8Array(512);
for (let i = 0; i < 256; i++) P[i] = P[i + 256] = PERM[i];
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (t, a, b) => a + t * (b - a);
function grad(hash, x, y) {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : 0;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}
/** Stand-in for Mathf.PerlinNoise (see DEPARTURES): improved Perlin noise at z = 0, in [0, 1]. */
export function perlinNoise(x, y) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
  x -= Math.floor(x);
  y -= Math.floor(y);
  const u = fade(x), v = fade(y);
  const a = P[X] + Y, b = P[X + 1] + Y;
  const n = lerp(v, lerp(u, grad(P[a], x, y), grad(P[b], x - 1, y)), lerp(u, grad(P[a + 1], x, y - 1), grad(P[b + 1], x - 1, y - 1)));
  return (n + 1) / 2;
}

/** TerrainHelper.GetNoise (clamp01). */
function getNoise(x, y, frequency, amplitude, persistance, octaves, seed = 0) {
  let v = 0;
  for (let i = 0; i < octaves; i++) {
    v += perlinNoise(seed + x * frequency, seed + y * frequency) * amplitude;
    frequency *= 2;
    amplitude *= persistance;
  }
  return Math.min(1, Math.max(0, v));
}

/** TerrainTexturing's local GetNoise: clamp to [-1, 1]. */
function getNoiseSigned(x, y, frequency, amplitude, persistance, octaves, seed) {
  let v = 0;
  for (let i = 0; i < octaves; i++) {
    v += perlinNoise(seed + x * frequency, seed + y * frequency) * amplitude;
    frequency *= 2;
    amplitude *= persistance;
  }
  return Math.min(1, Math.max(-1, v));
}

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
/** Unity.Mathematics.Random.CreateFromIndex(index).NextFloat(min, max) (open source, exact). */
function umFloatRangeFromIndex(index, min, max) {
  let n = (index + 62) >>> 0;
  n = (n ^ 61 ^ (n >>> 16)) >>> 0;
  n = Math.imul(n, 9) >>> 0;
  n = (n ^ (n >>> 4)) >>> 0;
  n = Math.imul(n, 0x27d4eb2d) >>> 0;
  n = (n ^ (n >>> 15)) >>> 0;
  let s = n;
  const step = () => {
    const t = s;
    s = (s ^ (s << 13)) >>> 0;
    s = (s ^ (s >>> 17)) >>> 0;
    s = (s ^ (s << 5)) >>> 0;
    return t;
  };
  step(); // the constructor's burn
  U32[0] = (0x3f800000 | (step() >>> 9)) >>> 0;
  const f = F32[0] - 1;
  return Math.fround(Math.fround(f * Math.fround(max - min)) + min);
}

/** xorshift128 seeded like Random.InitState (see DEPARTURES). */
export class NatureRandom {
  constructor(seed) {
    this.x = seed >>> 0;
    this.y = (Math.imul(this.x, 1812433253) + 1) >>> 0;
    this.z = (Math.imul(this.y, 1812433253) + 1) >>> 0;
    this.w = (Math.imul(this.z, 1812433253) + 1) >>> 0;
  }
  next() {
    const t = (this.x ^ (this.x << 11)) >>> 0;
    this.x = this.y; this.y = this.z; this.z = this.w;
    this.w = (this.w ^ (this.w >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return this.w;
  }
  value() { return (this.next() & 0x7fffff) / 0x7fffff; }
  range(min, max) { return min + (max - min) * this.value(); }
  int(min, max) { return min + (this.next() % (max - min)); }
}

// ------------------------------------------------------------------------------------------------ DFU sampler

/** TerrainHelper.CubicInterpolator. */
function cubic(v0, v1, v2, v3, f) {
  const A = (v3 - v2) - (v0 - v1);
  const B = (v0 - v1) - A;
  const C = v2 - v0;
  return A * f * f * f + B * f * f + C * f + v1;
}

/**
 * DefaultTerrainSampler.GenerateSamplesJob for one map pixel. Requires woods.prefetch() of the pixel.
 * @returns {Float32Array} normalized samples; sample(x east, y north) = out[y + x * HDIM]
 */
export function generateSamples(woods, px, py, stepX = 1, stepY = 1) {
  const hDim = HDIM;
  const div = (hDim - 1) / 3;
  const sd = 4, ld = 9;
  const shm = woods.smallRange(px - 2, py - 2, sd);
  const lhm = woods.largeRange(px - 1, py, 3);
  const S = (r, c) => shm[r + c * sd];
  const L = (r, c) => lhm[r + c * ld];
  const rows = TDIM / stepY + 1;
  const out = new Float32Array((TDIM / stepX + 1) * rows);
  for (let index = 0; index < out.length; index++) {
    const x = Math.floor(index / rows) * stepX; // JobA.Col
    const y = (index % rows) * stepY; // JobA.Row
    const ix = Math.floor(x / div), iy = Math.floor(y / div);
    const sfracx = x / (hDim - 1), sfracy = y / (hDim - 1);
    const fracx = (x - ix * div) / div, fracy = (y - iy * div) / div;
    let h = 0;
    let x1 = cubic(S(0, 3), S(1, 3), S(2, 3), S(3, 3), sfracx);
    let x2 = cubic(S(0, 2), S(1, 2), S(2, 2), S(3, 2), sfracx);
    let x3 = cubic(S(0, 1), S(1, 1), S(2, 1), S(3, 1), sfracx);
    let x4 = cubic(S(0, 0), S(1, 0), S(2, 0), S(3, 0), sfracx);
    h += cubic(x1, x2, x3, x4, sfracy) * BASE_HEIGHT_SCALE;
    x1 = cubic(L(ix, iy), L(ix + 1, iy), L(ix + 2, iy), L(ix + 3, iy), fracx);
    x2 = cubic(L(ix, iy + 1), L(ix + 1, iy + 1), L(ix + 2, iy + 1), L(ix + 3, iy + 1), fracx);
    x3 = cubic(L(ix, iy + 2), L(ix + 1, iy + 2), L(ix + 2, iy + 2), L(ix + 3, iy + 2), fracx);
    x4 = cubic(L(ix, iy + 3), L(ix + 1, iy + 3), L(ix + 2, iy + 3), L(ix + 3, iy + 3), fracx);
    h += cubic(x1, x2, x3, x4, fracy) * NOISE_MAP_SCALE;
    const nx = px * (hDim - 1) + x;
    const ny = (MAP_HEIGHT - py) * (hDim - 1) + y;
    h += getNoise(nx, ny, 0.3, 0.5, 0.5, 1) * getNoise(nx, ny, 0.9, 0.5, 0.5, 1) * EXTRA_NOISE_SCALE;
    if (h < SCALED_OCEAN_ELEVATION) h = SCALED_OCEAN_ELEVATION;
    out[index] = Math.min(1, Math.max(0, h / MAX_TERRAIN_HEIGHT));
  }
  return out;
}

/** heightmapSamples[y, x] of DFU / Location Loader. */
export const sampleAt = (samples, x, y) => samples[y + x * HDIM];

// ------------------------------------------------------------------------------------------------ Location Loader

/**
 * A wilderness site from the scene descriptor as Location Loader tile data. Uses `site.tile` / `site.size` when the
 * descriptor carries them; otherwise derives them from `anchor` and `rect` (scene metres).
 * @returns {{type:number, tx:number, ty:number, halfW:number, halfH:number, sink:number}}
 */
export function siteTiles(site) {
  const type = Number.isInteger(site.instanceType) ? site.instanceType : 0;
  let tx, ty;
  if (site.tile && Number.isFinite(site.tile.x) && Number.isFinite(site.tile.y)) {
    tx = site.tile.x;
    ty = site.tile.y;
  } else {
    const a = site.anchor ?? [0, 0, 0];
    tx = Math.round((a[0] + HALF_PIXEL) / TILE_SIZE);
    ty = Math.round((HALF_PIXEL - a[2]) / TILE_SIZE);
  }
  let halfW = 0, halfH = 0;
  if (site.size && Number.isFinite(site.size.halfWidth)) {
    halfW = site.size.halfWidth;
    halfH = site.size.halfHeight;
  } else if (site.rect && Number.isFinite(site.rect.width)) {
    halfW = Math.max(0, Math.round(Math.abs(site.rect.width) / TILE_SIZE / 2));
    halfH = Math.max(0, Math.round(Math.abs(site.rect.depth ?? site.rect.height ?? 0) / TILE_SIZE / 2));
  }
  return { type, tx, ty, halfW, halfH, sink: Number.isFinite(site.sink) ? site.sink : 0 };
}

/** Mean of the samples over the inclusive rect, clamped to 0..128 (LocationLoader.OnTerrainPromoted). */
export function rectAverage(samples, t) {
  const minX = Math.max(t.tx - t.halfW, 0), minY = Math.max(t.ty - t.halfH, 0);
  const maxX = Math.min(t.tx + t.halfW, TDIM), maxY = Math.min(t.ty + t.halfH, TDIM);
  let sum = 0, n = 0;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) { sum += sampleAt(samples, x, y); n++; }
  return n ? sum / n : sampleAt(samples, Math.min(TDIM, Math.max(0, t.tx)), Math.min(TDIM, Math.max(0, t.ty)));
}

function distanceFromRect(r, x, y) {
  let sq = 0;
  if (x > r.xMax) sq += (x - r.xMax) ** 2;
  else if (x < r.xMin) sq += (r.xMin - x) ** 2;
  if (y > r.yMax) sq += (y - r.yMax) ** 2;
  else if (y < r.yMin) sq += (r.yMin - y) ** 2;
  return sq === 0 ? 0 : Math.sqrt(sq);
}
const smoothStep = (a, b, t) => {
  t = Math.min(1, Math.max(0, t));
  t = -2 * t * t * t + 3 * t * t;
  return b * t + a * (1 - t);
};

/**
 * Location Loader's per-pixel pass: each site's ground (normalized) from the unblended samples, then BlendTerrain over
 * the type-0 rects. Mutates `samples`. Returns the grounds in site order.
 */
export function applyLocationLoader(samples, tiles) {
  const grounds = tiles.map((t) => rectAverage(samples, t));
  const rects = [];
  tiles.forEach((t, i) => {
    if (t.type !== 0) return;
    rects.push({ xMin: t.tx - t.halfW, yMin: t.ty - t.halfH, xMax: t.tx + t.halfW, yMax: t.ty + t.halfH, ground: grounds[i] });
  });
  if (!rects.length) return grounds;
  for (let y = 1; y < TDIM - 1; y++) {
    for (let x = 1; x < TDIM - 1; x++) {
      let avg = 0, dist = 128;
      for (const r of rects) {
        const d = distanceFromRect(r, x, y);
        if (d === 0) { dist = 0; avg = r.ground; break; }
        if (d < dist) { dist = d; avg = r.ground; }
      }
      if (dist < LL_TRANSITION) {
        const i = y + x * HDIM;
        samples[i] = smoothStep(avg, samples[i], dist / LL_TRANSITION);
      }
    }
  }
  return grounds;
}

/** Location Loader's type-1 sink: Lerp(0, min(0, lowest sample under the rect - ground), sink), metres. */
export function sinkOffset(samples, t, ground) {
  if (!(t.sink > 0)) return 0;
  const minX = Math.max(t.tx - t.halfW, 0), minY = Math.max(t.ty - t.halfH, 0);
  const maxX = Math.min(t.tx + t.halfW, TDIM), maxY = Math.min(t.ty + t.halfH, TDIM);
  let low = 0;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const d = (sampleAt(samples, x, y) - ground) * HEIGHT_MAX;
    if (d < low) low = d;
  }
  return low * Math.min(1, t.sink);
}

/**
 * Location Loader's overlapping terrain sections of a type-1/3 instance standing on pixel (wx, wy)
 * (LocationHelper.GetOverlappingTerrainSections): [{px, py, xMin, xMax, yMin, yMax}] tile bounds, inclusive.
 */
export function overlapSections(t, wx, wy) {
  const out = [];
  const x0 = Math.floor((t.tx - t.halfW) / TDIM), y0 = Math.floor((t.ty - t.halfH) / TDIM);
  const x1 = Math.trunc((t.tx + t.halfW) / TDIM), y1 = Math.trunc((t.ty + t.halfH) / TDIM);
  for (let xo = x0; xo <= x1; xo++) {
    for (let yo = y0; yo <= y1; yo++) {
      const px = wx + xo, py = wy - yo;
      if (px < 0 || py < 0 || px >= MAP_WIDTH || py >= MAP_HEIGHT) continue;
      out.push({
        px, py,
        xMin: Math.max(t.tx - t.halfW - xo * TDIM, 0), xMax: Math.min(t.tx + t.halfW - xo * TDIM, TDIM),
        yMin: Math.max(t.ty - t.halfH - yo * TDIM, 0), yMax: Math.min(t.ty + t.halfH - yo * TDIM, TDIM),
      });
    }
  }
  return out;
}

/**
 * LocationLoader.FindAdjustedHeightOffset across every pixel the instance overlaps, then Lerp(0, offset, sink):
 * metres. `samplesOf(px, py)` answers a pixel's samples (raw DFU samples for pixels not built).
 */
export function sinkOffsetAcross(samplesOf, t, wx, wy, ground) {
  if (!(t.sink > 0)) return 0;
  let low = 0;
  for (const s of overlapSections(t, wx, wy)) {
    const samples = samplesOf(s.px, s.py);
    if (!samples) continue;
    for (let x = s.xMin; x <= s.xMax; x++) for (let y = s.yMin; y <= s.yMax; y++) {
      const d = (sampleAt(samples, x, y) - ground) * HEIGHT_MAX;
      if (d < low) low = d;
    }
  }
  return low * Math.min(1, t.sink);
}

/** Root height of a site in absolute metres (LocationLoader.GetLocationPosition). */
export function siteRootHeight(t, ground, sink) {
  if (t.type === 2 || t.type === 3) return OCEAN_Y;
  return ground * HEIGHT_MAX + sink;
}

// ------------------------------------------------------------------------------------------------ DFU tiles

const TDATA = TDIM + 1;
const TILE_SEED = 417028;
const WATER = 0, DIRT = 1, GRASS = 2, STONE = 3;

function makeLookup(index, rotate, flip) { return index + (rotate ? 64 : 0) + (flip ? 128 : 0); }
function addLookupRange(t, baseStart, baseEnd, shapeStart, saddle, reverse, o) {
  const L = makeLookup;
  if (reverse) {
    t.set([L(baseStart, 0, 0), L(shapeStart + 2, 1, 1), L(shapeStart + 2, 0, 0), L(shapeStart + 1, 1, 1), L(shapeStart + 2, 0, 1),
      L(shapeStart + 1, 0, 1), L(saddle, 1, 0), L(shapeStart, 1, 1), L(shapeStart + 2, 1, 0), L(saddle, 0, 0), L(shapeStart + 1, 0, 0),
      L(shapeStart, 0, 0), L(shapeStart + 1, 1, 0), L(shapeStart, 0, 1), L(shapeStart, 1, 0), L(baseEnd, 0, 0)], o);
  } else {
    t.set([L(baseStart, 0, 0), L(shapeStart, 1, 0), L(shapeStart, 0, 1), L(shapeStart + 1, 1, 0), L(shapeStart, 0, 0),
      L(shapeStart + 1, 0, 0), L(saddle, 0, 0), L(shapeStart + 2, 1, 0), L(shapeStart, 1, 1), L(saddle, 1, 0), L(shapeStart + 1, 0, 1),
      L(shapeStart + 2, 0, 1), L(shapeStart + 1, 1, 1), L(shapeStart + 2, 0, 0), L(shapeStart + 2, 1, 1), L(baseEnd, 0, 0)], o);
  }
}
const LOOKUP = new Uint8Array(64);
addLookupRange(LOOKUP, 0, 1, 5, 48, false, 0);
addLookupRange(LOOKUP, 2, 1, 10, 51, true, 16);
addLookupRange(LOOKUP, 2, 3, 15, 53, false, 32);
addLookupRange(LOOKUP, 3, 3, 15, 53, true, 48);

/**
 * GenerateTileDataJob + AssignTilesJob: the pixel's 128x128 ground tile bytes, tilemap[x + y * 128] (x east, y north).
 */
export function generateTilemap(samples, px, py) {
  const tileData = new Uint8Array(TDATA * TDATA);
  for (let index = 0; index < tileData.length; index++) {
    const x = index % TDATA, y = Math.floor(index / TDATA);
    const hx = Math.min(HDIM - 1, Math.max(0, Math.trunc(HDIM * (x / TDATA))));
    const hy = Math.min(HDIM - 1, Math.max(0, Math.trunc(HDIM * (y / TDATA))));
    const height = Math.fround(samples[hy + hx * HDIM] * MAX_TERRAIN_HEIGHT);
    let v;
    if (height <= SCALED_OCEAN_ELEVATION) v = WATER;
    else if (height <= Math.fround(SCALED_BEACH_ELEVATION + umFloatRangeFromIndex(index, -1.5, 1.5))) v = DIRT;
    else {
      const lat = px * TDIM + x, lon = 64000 - py * TDIM + y;
      const w = getNoiseSigned(lat, lon, 0.05, 0.9, 0.4, 3, TILE_SEED);
      v = w < 0.5 ? DIRT : w > 0.95 ? STONE : GRASS;
    }
    tileData[index] = v;
  }
  const tilemap = new Uint8Array(TDIM * TDIM);
  for (let index = 0; index < tilemap.length; index++) {
    const x = index % TDIM, y = Math.floor(index / TDIM);
    const i = x + y * TDATA;
    const b0 = tileData[i], b1 = tileData[i + 1], b2 = tileData[i + TDATA], b3 = tileData[i + TDATA + 1];
    const shape = (b0 & 1) | ((b1 & 1) << 1) | ((b2 & 1) << 2) | ((b3 & 1) << 3);
    const ring = (b0 + b1 + b2 + b3) >> 2;
    tilemap[index] = LOOKUP[shape | (ring << 4)];
  }
  return tilemap;
}

// ------------------------------------------------------------------------------------------------ the ground field

/** Scene-frame offset of pixel (px, py) relative to the visited pixel (cx, cy): east +x, south +z. */
export const pixelOffset = (px, py, cx, cy) => ({ x: (px - cx) * PIXEL_SIZE, z: (py - cy) * PIXEL_SIZE });

// Blend in global tile coordinates so a city that fills its pixel also flattens
// the neighbouring rows and the diagonal corner. Use the nearest rectangle as
// Location Loader does. Sort by owner to resolve equal-distance ties identically.
function flattenTowns(samples, px, py, towns) {
  const rects = [];
  for (const t of towns) {
    const xMin = (t.px - px) * TDIM + t.origin.x;
    const yMin = (py - t.py) * TDIM + t.origin.y;
    const r = { xMin, yMin, xMax: xMin + t.width * 16, yMax: yMin + t.height * 16, town: t };
    if (r.xMin < TDIM + LL_TRANSITION && r.yMin < TDIM + LL_TRANSITION &&
        r.xMax > -LL_TRANSITION && r.yMax > -LL_TRANSITION) rects.push(r);
  }
  if (!rects.length) return;
  for (let x = 0; x <= TDIM; x++) {
    for (let y = 0; y <= TDIM; y++) {
      let dist = LL_TRANSITION, nearest;
      for (const r of rects) {
        const d = distanceFromRect(r, x, y);
        if (d < dist) { dist = d; nearest = r; }
      }
      if (nearest) {
        const i = y + x * HDIM;
        samples[i] = smoothStep(nearest.town.sample, samples[i], dist / LL_TRANSITION);
      }
    }
  }
}

/**
 * Build the ground of a visited pixel and its neighbours.
 * @param {WoodsFile} woods
 * @param {{px:number, py:number, sitesByPixel?:Map<string, object[]>, ring?:number, towns?:object[], spawnSite?:string|null, spawn?:{x:number,z:number}, yieldWork?:()=>Promise<void>}} o
 *   sitesByPixel: `${px},${py}` -> descriptor sites standing on that pixel. ring: neighbour pixels on each side (0-1).
 * @returns {Promise<Ground>}
 */
export async function buildGround(woods, { px, py, sitesByPixel = new Map(), ring = 1, towns = [], spawnSite = null, spawn = null, yieldWork } = {}) {
  if (!Number.isInteger(px) || !Number.isInteger(py) || px < 0 || py < 0 || px >= MAP_WIDTH || py >= MAP_HEIGHT) {
    throw new TerrainDataError(`map pixel ${px},${py} is outside the world`);
  }
  const list = [];
  for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
    const x = px + dx, y = py + dy;
    if (x < 0 || y < 0 || x >= MAP_WIDTH || y >= MAP_HEIGHT) continue;
    list.push({ px: x, py: y });
  }
  // Type-1 sinks read every pixel the instance overlaps (a mountain spans several): fetch those too.
  const tilesOf = new Map();
  const extra = new Map();
  for (const p of list) {
    const key = `${p.px},${p.py}`;
    const tiles = (sitesByPixel.get(key) ?? []).map(siteTiles);
    tilesOf.set(key, tiles);
    for (const t of tiles) {
      if ((t.type !== 1 && t.type !== 3) || !(t.sink > 0)) continue;
      for (const s of overlapSections(t, p.px, p.py)) extra.set(`${s.px},${s.py}`, { px: s.px, py: s.py });
    }
  }
  await woods.prefetch([...list, ...extra.values(), ...towns]);
  const raw = new Map();
  const rawOf = (x, y) => {
    const k = `${x},${y}`;
    if (!raw.has(k)) raw.set(k, generateSamples(woods, x, y));
    return raw.get(k);
  };
  const placements = towns.map(t => {
    const halfW = t.width * 8, halfH = t.height * 8;
    const tile = { tx: t.origin.x + halfW, ty: t.origin.y + halfH, halfW, halfH };
    const sample = Math.fround(rectAverage(rawOf(t.px, t.py), tile));
    // Native town ground is drawn 2.5 cm below its model origin. Give the
    // textured street a further 1 cm clearance above the flattened wilderness.
    return { ...t, tile, sample, elevation: sample * HEIGHT_MAX + 0.035 };
  }).sort((a, b) => a.py - b.py || a.px - b.px);
  const pixels = new Map();
  for (const p of list) {
    if (yieldWork) await yieldWork();
    const key = `${p.px},${p.py}`;
    const samples = Float32Array.from(rawOf(p.px, p.py));
    const sites = sitesByPixel.get(key) ?? [];
    const tiles = tilesOf.get(key);
    flattenTowns(samples, p.px, p.py, placements);
    const grounds = applyLocationLoader(samples, tiles);
    if (tiles.some(t => t.type === 0)) {
      // An overlapping mod site cannot cut a hole underneath a classic town.
      // Only restore the footprint itself; the shoulder was already blended.
      for (const t of placements) {
        if (t.px !== p.px || t.py !== p.py) continue;
        const { tx, ty, halfW, halfH } = t.tile;
        for (let x = tx - halfW; x <= tx + halfW; x++) {
          samples.fill(t.sample, x * HDIM + ty - halfH, x * HDIM + ty + halfH + 1);
        }
      }
    }
    const roots = tiles.map((t, i) => siteRootHeight(t, grounds[i], t.type === 1 ? sinkOffsetAcross(rawOf, t, p.px, p.py, grounds[i]) : 0));
    const tilemap = generateTilemap(samples, p.px, p.py);
    const off = pixelOffset(p.px, p.py, px, py);
    pixels.set(key, {
      px: p.px, py: p.py, key, samples, tilemap, offset: off, sites, tiles, grounds, roots,
      town: placements.find(t => t.px === p.px && t.py === p.py) ?? null,
      worldHeight: woods.heightAt(p.px, p.py),
      lift: sites.map((s, i) => ({ id: s.id, root: roots[i] })),
    });
  }
  const centre = pixels.get(`${px},${py}`);
  // Datum: the spawn site's root (the descriptor's y = 0), else the ground under the spawn / pixel centre.
  let datum = null;
  if (centre.sites.length) {
    let i = spawnSite ? centre.sites.findIndex((s) => s.id === spawnSite) : -1;
    if (i < 0 && spawn) {
      let best = Infinity;
      centre.sites.forEach((s, k) => {
        const a = s.anchor ?? [0, 0, 0];
        const d = (a[0] - spawn.x) ** 2 + (a[2] - spawn.z) ** 2;
        if (d < best) { best = d; i = k; }
      });
    }
    if (i < 0) i = 0;
    datum = centre.roots[i];
  }
  const g = new Ground(pixels, px, py, 0);
  if (datum === null) datum = g.absoluteHeightAt(spawn?.x ?? 0, spawn?.z ?? 0);
  g.datum = datum;
  return g;
}

/** The built ground: heights in scene metres (absolute minus datum), sampled on DFU's 6.4 m grid. */
export class Ground {
  constructor(pixels, px, py, datum) {
    this.pixels = pixels;
    this.px = px;
    this.py = py;
    this.datum = datum;
  }

  /** Which pixel holds a scene point, and its tile-local sample coordinates (x east, y north) in 0..128. */
  locate(x, z) {
    const gx = (x + HALF_PIXEL) / PIXEL_SIZE, gz = (z + HALF_PIXEL) / PIXEL_SIZE; // gz grows south
    const dx = Math.floor(gx), dz = Math.floor(gz);
    const p = this.pixels.get(`${this.px + dx},${this.py + dz}`);
    if (!p) return null;
    const lx = (gx - dx) * TDIM; // east, 0..128
    const ly = (1 - (gz - dz)) * TDIM; // north, 0..128
    return { p, lx, ly };
  }

  /** Absolute ground metres, triangle-interpolated exactly as the mesh is split (see scene.js). */
  absoluteHeightAt(x, z) {
    const at = this.locate(x, z);
    if (!at) return null;
    const { p, lx, ly } = at;
    const ix = Math.min(TDIM - 1, Math.max(0, Math.floor(lx))), iy = Math.min(TDIM - 1, Math.max(0, Math.floor(ly)));
    const fx = Math.min(1, Math.max(0, lx - ix)), fy = Math.min(1, Math.max(0, ly - iy));
    const s = p.samples;
    const h00 = s[iy + ix * HDIM], h10 = s[iy + (ix + 1) * HDIM], h01 = s[iy + 1 + ix * HDIM], h11 = s[iy + 1 + (ix + 1) * HDIM];
    // Cells are split along the (0,0)-(1,1) diagonal.
    const h = fx >= fy ? h00 + (h10 - h00) * fx + (h11 - h10) * fy : h00 + (h11 - h01) * fx + (h01 - h00) * fy;
    return h * HEIGHT_MAX;
  }

  /** Ground height in scene metres (y = 0 is the site ground), or null outside the built pixels. */
  heightAt(x, z) {
    const h = this.absoluteHeightAt(x, z);
    return h === null ? null : h - this.datum;
  }

  /** Scene y of a site root (Location Loader's position) relative to the datum; descriptor objects add this. */
  siteLift(siteId) {
    for (const p of this.pixels.values()) {
      const i = p.sites.findIndex((s) => s.id === siteId);
      if (i >= 0) return p.roots[i] - this.datum;
    }
    return null;
  }

  /** Steepness in degrees at tile (x, y) of a pixel, from the sample gradient (TerrainData.GetSteepness). */
  static steepness(p, x, y) {
    const s = p.samples;
    const cx = Math.min(TDIM - 1, Math.max(1, x)), cy = Math.min(TDIM - 1, Math.max(1, y));
    const dx = (s[cy + (cx + 1) * HDIM] - s[cy + (cx - 1) * HDIM]) * HEIGHT_MAX / (2 * TILE_SIZE);
    const dy = (s[cy + 1 + cx * HDIM] - s[cy - 1 + cx * HDIM]) * HEIGHT_MAX / (2 * TILE_SIZE);
    return (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;
  }
}

// ------------------------------------------------------------------------------------------------ nature

/** World climate (CLIMATE.PAK value) of nature rules. */
const isDesertClimate = (c) => c === 224 || c === 225;

/**
 * DefaultTerrainNature / LocationTerrainNature for one built pixel: [{x, y, z, record}] in scene metres (y relative
 * to the datum). Type-0 site rects are kept clear (LocationTerrainNature).
 */
export function layoutNature(ground, p, worldClimate) {
  const elevationScale = Math.min(1, Math.max(0.4, p.worldHeight / 128));
  const climateScale = isDesertClimate(worldClimate) ? 0.25 : 1;
  const chance = [0, 0.2 * elevationScale * climateScale, 0.9 * elevationScale * climateScale, 0.05 * elevationScale * climateScale];
  const rects = p.tiles.filter((t) => t.type === 0).map((t) => ({ x0: t.tx - t.halfW, y0: t.ty - t.halfH, x1: t.tx + t.halfW, y1: t.ty + t.halfH }));
  if (p.town) {
    const { tx, ty, halfW, halfH } = p.town.tile;
    rects.push({ x0: tx - halfW, y0: ty - halfH, x1: tx + halfW, y1: ty + halfH });
  }
  const rng = new NatureRandom(((p.py << 16) + p.px) | 0);
  const out = [];
  for (let y = 0; y < TDIM; y++) {
    for (let x = 0; x < TDIM; x++) {
      const steep = Ground.steepness(p, x, y);
      if (steep > 50) continue;
      if (rects.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1)) continue;
      const tile = p.tilemap[x + y * TDIM] & 0x3f;
      if (tile < 1 || tile > 3) continue;
      if (rng.value() > chance[tile]) continue;
      const hx = Math.min(HDIM - 1, Math.trunc(HDIM * (x / TDIM))), hy = Math.min(HDIM - 1, Math.trunc(HDIM * (y / TDIM)));
      if (p.samples[hy + hx * HDIM] * MAX_TERRAIN_HEIGHT < SCALED_BEACH_ELEVATION) continue;
      const sx = p.offset.x - HALF_PIXEL + x * TILE_SIZE;
      const sz = p.offset.z + HALF_PIXEL - y * TILE_SIZE;
      const h = ground.heightAt(sx, sz);
      if (h === null) continue;
      out.push({ x: sx, y: h - steep / 70, z: sz, record: rng.int(1, 32) });
    }
  }
  return out;
}
