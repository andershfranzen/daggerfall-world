// Outdoor positions use metres, east +x, south +z, and up +y. A pixel-local
// origin is its centre. A town-local origin is loadTown's native spawn.
import { TERRAIN_PIXEL_SIZE as PIXEL, HALF_PIXEL as HALF, TILE_METRES as TILE } from '../wilderness/data.js';

export { PIXEL, HALF, TILE };
export const BLOCK = 16 * TILE;

/**
 * Where a classic location's block grid sits in its map pixel (TerrainHelper.GetLocationTerrainTileOrigin):
 * SW corner in tiles from the pixel's SW corner.
 */
export function tileOrigin(width, height, custom = false) {
  if (custom && width === 1 && height === 1) return { x: 72, y: 55 };
  return { x: (128 - width * 16) / 2, y: (128 - height * 16) / 2 };
}

/**
 * Town placement for overland maths, from loadTown().source or an equivalent record.
 * @param {{id:string, px:number, py:number, width:number, height:number, spawnLocal:{x:number,z:number}, custom?:boolean}} m
 */
export function townFrame(m) {
  const o = tileOrigin(m.width, m.height, m.custom);
  const w = m.width * BLOCK, h = m.height * BLOCK;
  const sx = m.spawnLocal.x, sz = m.spawnLocal.z;
  // Unity pixel-local SW corner of the block grid.
  const ox = o.x * TILE, oz = o.y * TILE;
  return {
    ...m,
    origin: o,
    // Walkable ground in the town's own frame (the collision walk bounds).
    walk: { minX: -sx, maxX: w - sx, minZ: sz - h, maxZ: sz },
    // The same rectangle in the pixel's wilderness frame.
    rect: { minX: ox - HALF, maxX: ox + w - HALF, minZ: HALF - (oz + h), maxZ: HALF - oz },
    // town (x,z) -> wilderness (x,z) offset: xw = x + dx, zw = z + dz
    dx: ox + sx - HALF,
    dz: HALF - oz - sz,
  };
}

export const townToWild = (f, x, z) => ({ x: x + f.dx, z: z + f.dz });
export const wildToTown = (f, x, z) => ({ x: x - f.dx, z: z - f.dz });
export const toGlobal = (px, py, x, z) => ({ e: px * PIXEL + HALF + x, s: py * PIXEL + HALF + z });
// Recover exact boundary ownership after multiplying a decimal pixel size.
function pixelIndex(m) {
  const q = m / PIXEL, n = Math.round(q);
  return Math.abs(q - n) <= 2 * Number.EPSILON * Math.max(1, n) ? n : Math.floor(q);
}
export const inPixel = (px, py, e, s) => ({ x: e - px * PIXEL - HALF, z: s - py * PIXEL - HALF });
export function fromGlobal(e, s) {
  const px = pixelIndex(e), py = pixelIndex(s);
  return { px, py, ...inPixel(px, py, e, s) };
}

/** Key an authored object by its owning pixel and source indices, even when seen from another pixel. */
export function exteriorObjectKey(px, py, ...sourcePath) {
  return [`pixel:${px},${py}`, ...sourcePath.map(part => encodeURIComponent(String(part)))].join('/');
}

/** Translation for a native town mesh into a wilderness scene with a known absolute datum. */
export function townMeshOffset(placement, source, scene) {
  const f = townFrame({ ...placement, spawnLocal: source.spawnLocal });
  return {
    x: (f.px - scene.px) * PIXEL + f.dx,
    y: f.elevation - scene.datum,
    z: (f.py - scene.py) * PIXEL + f.dz,
  };
}
