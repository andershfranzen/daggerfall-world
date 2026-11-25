// Outdoor surroundings around a town: a terrain apron shaped by WOODS.WLD's world
// heightmap, textured with the climate's ground tiles, plus nature flats.
//
// Read from the data, with sources:
//   - WOODS.WLD header and the 1000x500 byte heightmap at HeightMapOffset, per
//     Daggerfall Unity's API/WoodsFile.cs (ReadHeader, ReadHeightMap,
//     GetHeightMapValue clamping) and daggerfall-js-source src/formats/woodsFile.js.
//   - Map pixel of a location: MapsFile.LongitudeLatitudeToMapPixel (x = lon/128,
//     y = 499 - lat/128). One map pixel spans MapsFile.WorldMapTerrainDim (32768
//     native units = 819.2 m).
//   - Height scale DefaultTerrainSampler.baseHeightScale = 8 and ocean elevation
//     3.4 * 8; nature chances 0.2 dirt / 0.9 grass / 0.05 stone, elevation scale
//     clamp(height / 128, 0.4, 1), desert x0.25, record range 1-31, and a 4-tile
//     clearance around the town, per Terrain/TerrainNature.cs DefaultTerrainNature.
//   - Ground tile records 0 water, 1 dirt, 2 grass, 3 stone of the climate ground
//     archive, per Terrain/TerrainTexturing.cs.
// (MIT, (c) 2009-2023 Daggerfall Workshop; MIT, (c) 2026 Lattymoy.) See THIRD_PARTY_NOTICES.txt.
//
// This project's own, deterministic work: the apron shape and extent, the blend
// down to the flat town ground, bilinear interpolation of the coarse heightmap,
// the small detail noise standing in for DFU's per-pixel noise sampler, the tile
// choice from slope and noise, the hash used for nature placement and the
// density cap. It is not DFU's terrain generator and does not claim to match it.

import { WorldDataError } from '../errors.js';

export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 500;
const MAP_PIXEL_SIZE = 32768 * 0.025; // 819.2 m
const BASE_HEIGHT_SCALE = 8;
const OCEAN_HEIGHT = 3.4; // in heightmap units (scaledOceanElevation / baseHeightScale)
const TILE = 6.4;

/** Read the WOODS.WLD heightmap only (500,000 bytes), via a byte-range reader. */
export async function readWoodsHeightmap(read, size) {
  if (size < 32 + 112) throw new WorldDataError('WOODS.WLD: file is too short');
  const head = await read(0, 32);
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const width = v.getUint32(4, true);
  const height = v.getUint32(8, true);
  const at = v.getUint32(28, true);
  if (width * height !== MAP_WIDTH * MAP_HEIGHT) throw new WorldDataError('WOODS.WLD: invalid map size in header');
  if (at + MAP_WIDTH * MAP_HEIGHT > size) throw new WorldDataError('WOODS.WLD: heightmap is truncated');
  return await read(at, MAP_WIDTH * MAP_HEIGHT);
}

/** WoodsFile.GetHeightMapValue with DFU's clamping. */
export function heightAt(map, px, py) {
  const x = Math.min(Math.max(px, 0), MAP_WIDTH - 1);
  const y = Math.min(Math.max(py, 0), MAP_HEIGHT - 1);
  return map[y * MAP_WIDTH + x];
}

export const mapPixelOf = (longitude, latitude) => ({ x: Math.trunc(longitude / 128), y: 499 - Math.trunc(latitude / 128) });

// ---------------------------------------------------------------------------- deterministic noise

/** 32-bit integer hash of two ints and a seed (lowbias32 mix). */
export function hash2(x, y, seed) {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}
const unit = (h) => h / 4294967296;

function valueNoise(x, z, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = x - x0, fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = unit(hash2(x0, z0, seed)), b = unit(hash2(x0 + 1, z0, seed));
  const c = unit(hash2(x0, z0 + 1, seed)), d = unit(hash2(x0 + 1, z0 + 1, seed));
  return (a + (b - a) * sx) * (1 - sz) + (c + (d - c) * sx) * sz;
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ---------------------------------------------------------------------------- apron

/**
 * Build the surroundings in loadTown's output space.
 * @param {object} o
 * @param {{minX,maxX,minZ,maxZ}} o.townRect - the town's ground rectangle (output space)
 * @param {Uint8Array|null} o.heightmap - WOODS.WLD heightmap, or null for a flat apron
 * @param {{x:number,y:number}} o.mapPixel - the town's map pixel
 * @param {{x:number,z:number}} o.pixelOffset - output-space position of the town's map pixel centre
 * @param {number} o.seed
 * @param {number} [o.extent] - metres the apron reaches beyond the town rectangle
 * @param {number} [o.cell] - grid cell size in metres (a multiple of the 6.4 m tile)
 * @param {boolean} [o.desert]
 * @param {number} [o.maxNature]
 */
export function buildSurroundings(o) {
  const { townRect, heightmap, mapPixel, pixelOffset, seed } = o;
  const extent = o.extent ?? 2560;
  const cell = o.cell ?? 12.8;
  const maxNature = o.maxNature ?? 16000;
  const natureRange = o.natureRange ?? 800;

  // World height (heightmap units) at an output-space point, bilinear between pixel centres.
  const rawHeight = (x, z) => {
    if (!heightmap) return null;
    const fx = mapPixel.x + (x - pixelOffset.x) / MAP_PIXEL_SIZE;
    const fy = mapPixel.y + (z - pixelOffset.z) / MAP_PIXEL_SIZE; // +z is south, as is +map y
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const h00 = heightAt(heightmap, x0, y0), h10 = heightAt(heightmap, x0 + 1, y0);
    const h01 = heightAt(heightmap, x0, y0 + 1), h11 = heightAt(heightmap, x0 + 1, y0 + 1);
    return (h00 + (h10 - h00) * tx) * (1 - ty) + (h01 + (h11 - h01) * tx) * ty;
  };
  const townCx = (townRect.minX + townRect.maxX) / 2, townCz = (townRect.minZ + townRect.maxZ) / 2;
  const townRaw = heightmap ? rawHeight(townCx, townCz) : 0;
  const worldHeight = heightmap ? heightAt(heightmap, mapPixel.x, mapPixel.y) : 64;
  const oceanY = (OCEAN_HEIGHT - townRaw) * BASE_HEIGHT_SCALE;
  const coastal = !!heightmap && townRaw > OCEAN_HEIGHT; // a town can only stand above the sea

  // Distance from the town rectangle (0 inside).
  const edge = (x, z) => {
    const dx = Math.max(townRect.minX - x, 0, x - townRect.maxX);
    const dz = Math.max(townRect.minZ - z, 0, z - townRect.maxZ);
    return Math.hypot(dx, dz);
  };
  const groundY = -0.045; // just under the town ground mesh (-0.025)
  const heightOf = (x, z) => {
    const d = edge(x, z);
    const blend = smooth(24, 420, d);
    let y = 0;
    if (heightmap) y += (rawHeight(x, z) - townRaw) * BASE_HEIGHT_SCALE;
    y += (valueNoise(x / 90, z / 90, seed) - 0.5) * 7 + (valueNoise(x / 23, z / 23, seed + 1) - 0.5) * 1.6;
    return groundY + y * blend;
  };
  const isWater = (y) => heightmap && coastal && y < oceanY;

  // Keep near-ground resolution and use wider cells at the horizon. Sharing the same
  // axis between adjacent rows keeps their edges joined even at the resolution change.
  function axis(min, max) {
    const apron = [];
    for (let d = 0; d < extent;) {
      d = Math.min(extent, d + (d < 768 ? cell : cell * 4));
      apron.push(d);
    }
    const points = apron.map(d => min - d).reverse();
    const interiorCells = Math.max(1, Math.round((max - min) / cell));
    for (let i = 0; i <= interiorCells; i++) points.push(min + (max - min) * i / interiorCells);
    return points.concat(apron.map(d => max + d));
  }
  const xs = axis(townRect.minX, townRect.maxX), zs = axis(townRect.minZ, townRect.maxZ);
  const nx = xs.length - 1, nz = zs.length - 1;
  const H = new Float32Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) H[j * (nx + 1) + i] = heightOf(xs[i], zs[j]);

  const pos = [], nrm = [], tile = [], rec = [];
  const inTown = (x, z) => x > townRect.minX - 1e-3 && x < townRect.maxX + 1e-3 && z > townRect.minZ - 1e-3 && z < townRect.maxZ + 1e-3;
  const counts = [0, 0, 0, 0];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const ax = xs[i], az = zs[j], bx = xs[i + 1], bz = zs[j + 1];
      const dx = bx - ax, dz = bz - az;
      if (inTown((ax + bx) / 2, (az + bz) / 2)) continue; // the town draws its own ground here
      const cx = (ax + bx) / 2, cz = (az + bz) / 2;
      let y00 = H[j * (nx + 1) + i], y10 = H[j * (nx + 1) + i + 1];
      let y01 = H[(j + 1) * (nx + 1) + i], y11 = H[(j + 1) * (nx + 1) + i + 1];
      const mean = (y00 + y10 + y01 + y11) / 4;
      const slope = Math.max(Math.abs(y10 - y00) / dx, Math.abs(y01 - y00) / dz, Math.abs(y11 - y10) / dz, Math.abs(y11 - y01) / dx);
      let record;
      if (isWater(mean)) {
        record = 0;
        y00 = y10 = y01 = y11 = oceanY;
      } else if (slope > 0.55) record = 3;
      else {
        const n = valueNoise(cx / 40, cz / 40, seed + 7);
        record = slope > 0.35 || n > 0.8 ? 1 : 2;
      }
      counts[record]++;
      // Normal from the cell's two diagonals (y up).
      const ux = dx, uy = y11 - y00, uz = dz;
      const vx = dx, vy = y10 - y01, vz = -dz;
      let nxv = uy * vz - uz * vy, nyv = uz * vx - ux * vz, nzv = ux * vy - uy * vx;
      if (nyv < 0) { nxv = -nxv; nyv = -nyv; nzv = -nzv; }
      const l = Math.hypot(nxv, nyv, nzv) || 1;
      const quad = [[ax, y00, az], [bx, y10, az], [bx, y11, bz], [ax, y01, bz]];
      // Counter-clockwise seen from above in output space (+y up, -z north): a, d, c / a, c, b.
      for (const k of [0, 3, 2, 0, 2, 1]) {
        const [px, py, pz] = quad[k];
        pos.push(px, py, pz);
        nrm.push(nxv / l, nyv / l, nzv / l);
        tile.push((px - townRect.minX) / TILE, (pz - townRect.minZ) / TILE);
        rec.push(record);
      }
    }
  }

  // Nature flats: one candidate per 6.4 m tile within natureRange of the town edge.
  const elevationScale = Math.min(Math.max(worldHeight / 128, 0.4), 1);
  const climateScale = o.desert ? 0.25 : 1;
  const chance = { 1: 0.2, 2: 0.9, 3: 0.05 };
  const nature = [];
  function cellIndex(axis, value) {
    if (value < axis[0] || value >= axis.at(-1)) return -1;
    let low = 0, high = axis.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (value < axis[mid]) high = mid;
      else low = mid;
    }
    return low;
  }
  const groundAt = (x, z) => {
    const i = cellIndex(xs, x), j = cellIndex(zs, z);
    if (i < 0 || j < 0 || i >= nx || j >= nz) return null;
    const tx = (x - xs[i]) / (xs[i + 1] - xs[i]), tz = (z - zs[j]) / (zs[j + 1] - zs[j]);
    const h = (a, b) => H[(j + b) * (nx + 1) + i + a];
    return (h(0, 0) + (h(1, 0) - h(0, 0)) * tx) * (1 - tz) + (h(0, 1) + (h(1, 1) - h(0, 1)) * tx) * tz;
  };
  const clearance = 4 * TILE;
  // Spread the budget evenly: DFU's density is far beyond a browser draw budget, so it is scaled down.
  const area = (townRect.maxX - townRect.minX + 2 * natureRange) * (townRect.maxZ - townRect.minZ + 2 * natureRange) / (TILE * TILE);
  const density = Math.min(1, maxNature / Math.max(1, area * 0.9 * elevationScale * climateScale));
  const tx0 = Math.floor((townRect.minX - natureRange) / TILE), tx1 = Math.ceil((townRect.maxX + natureRange) / TILE);
  const tz0 = Math.floor((townRect.minZ - natureRange) / TILE), tz1 = Math.ceil((townRect.maxZ + natureRange) / TILE);
  for (let tz = tz0; tz < tz1 && nature.length < maxNature; tz++) {
    for (let tx = tx0; tx < tx1 && nature.length < maxNature; tx++) {
      const h = hash2(tx, tz, seed + 101);
      const x = (tx + unit(hash2(tx, tz, seed + 102))) * TILE, z = (tz + unit(hash2(tx, tz, seed + 103))) * TILE;
      if (edge(x, z) < clearance || edge(x, z) > natureRange) continue;
      const y = groundAt(x, z);
      if (y === null || isWater(y)) continue;
      const slope = Math.abs((groundAt(x + 1, z) ?? y) - y) + Math.abs((groundAt(x, z + 1) ?? y) - y);
      if (slope > 1.2) continue; // too steep (DFU: steepness > 50 degrees)
      const n = valueNoise(Math.round(x / cell) * cell / 40, Math.round(z / cell) * cell / 40, seed + 7);
      const record = slope > 0.55 ? 3 : slope > 0.35 || n > 0.8 ? 1 : 2;
      if (unit(h) > chance[record] * elevationScale * climateScale * density) continue;
      nature.push({ x, y: y - slope * 0.15, z, record: 1 + (hash2(tx, tz, seed + 104) % 31) });
    }
  }

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    tiles: new Float32Array(tile),
    records: new Uint8Array(rec),
    nature,
    oceanY: coastal ? oceanY : null,
    stats: { cells: pos.length / 18, water: counts[0], dirt: counts[1], grass: counts[2], stone: counts[3], nature: nature.length, extent, heightmap: !!heightmap, townRaw },
  };
}
