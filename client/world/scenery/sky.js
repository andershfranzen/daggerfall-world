// SKYnn.DAT day-sky panoramas.
//
// File layout follows Daggerfall Unity's API/SkyFile.cs (MIT, (c) 2009-2023
// Daggerfall Workshop) and its translation in daggerfall-js-source
// src/formats/skyFile.js (MIT, (c) 2026 Lattymoy): 32 palettes of 776 bytes
// (768 RGB bytes 8 bytes in), then 64 raw 512x220 frames from offset 549120,
// indexed record * 32 + frame, record 0 = east half, record 1 = west half.
// Sky selection follows MapsFile.GetWorldClimateSettings (SkyBase) and
// Internal/DaggerfallSky.cs (SkyIndex = SkyBase + season, SkyFrame default 31,
// afternoon frames 32-63 reuse 63 - n with the halves swapped, clear/fog colour =
// first pixel of the west image's bottom row). See THIRD_PARTY_NOTICES.txt.

import { WorldDataError } from '../errors.js';

export const SKY_WIDTH = 512;
export const SKY_HEIGHT = 220;
const FRAME_BYTES = SKY_WIDTH * SKY_HEIGHT;
const IMAGE_DATA_AT = 549120;
const PALETTE_STRIDE = 776;
export const SKY_FILE_SIZE = IMAGE_DATA_AT + 64 * FRAME_BYTES;

/** DaggerfallDateTime.Seasons order, which is also the SKY file order within a climate's set. */
export const SEASONS = Object.freeze({ fall: 0, spring: 1, summer: 2, winter: 3 });
/** DaggerfallSky.SkyFrame default (late morning). */
export const DEFAULT_SKY_FRAME = 31;

export const skyFileName = (index) => `SKY${String(index).padStart(2, '0')}.DAT`;

/**
 * Decode a day sky as one 1024x220 RGBA panorama, top row first: east half on
 * the left, west half on the right (the seam between them faces north).
 * @param {(offset:number,length:number)=>Promise<Uint8Array>} read - byte range reader for the SKY file
 * @param {number} size - file size in bytes
 */
export async function readDaySky(read, size, frame = DEFAULT_SKY_FRAME, label = 'SKY') {
  if (size < SKY_FILE_SIZE) throw new WorldDataError(`${label}: file is truncated (${size} bytes, expected ${SKY_FILE_SIZE})`);
  if (!(frame >= 0 && frame < 64)) throw new WorldDataError(`${label}: invalid sky frame ${frame}`);
  let target = frame;
  let swap = false;
  if (frame >= 32) {
    target = 63 - frame;
    swap = true;
  }
  const palette = await read(PALETTE_STRIDE * target + 8, 768);
  const east = await read(IMAGE_DATA_AT + FRAME_BYTES * target, FRAME_BYTES);
  const west = await read(IMAGE_DATA_AT + FRAME_BYTES * (32 + target), FRAME_BYTES);
  const [left, right] = swap ? [west, east] : [east, west];
  const width = SKY_WIDTH * 2;
  const pixels = new Uint8Array(width * SKY_HEIGHT * 4);
  for (let y = 0; y < SKY_HEIGHT; y++) {
    for (let x = 0; x < width; x++) {
      const src = x < SKY_WIDTH ? left[y * SKY_WIDTH + x] : right[y * SKY_WIDTH + x - SKY_WIDTH];
      const o = (y * width + x) * 4;
      pixels[o] = palette[src * 3];
      pixels[o + 1] = palette[src * 3 + 1];
      pixels[o + 2] = palette[src * 3 + 2];
      pixels[o + 3] = 255;
    }
  }
  // DFU clearColor: element 0 of the west image's bottom-up colours = bottom-left pixel.
  const w = swap ? east : west;
  const ci = w[(SKY_HEIGHT - 1) * SKY_WIDTH];
  const horizon = [palette[ci * 3] / 255, palette[ci * 3 + 1] / 255, palette[ci * 3 + 2] / 255];
  // Mean colour of the top row, for a zenith fallback.
  const zenith = [0, 0, 0];
  for (let x = 0; x < width; x++) for (let k = 0; k < 3; k++) zenith[k] += pixels[x * 4 + k] / 255 / width;
  return { width, height: SKY_HEIGHT, pixels, horizon, zenith, frame };
}

const frameOf = (palette, east, west, frame, swap) => {
  const [left, right] = swap ? [west, east] : [east, west];
  const width = SKY_WIDTH * 2;
  const pixels = new Uint8Array(width * SKY_HEIGHT * 4);
  for (let y = 0; y < SKY_HEIGHT; y++) {
    for (let x = 0; x < width; x++) {
      const src = x < SKY_WIDTH ? left[y * SKY_WIDTH + x] : right[y * SKY_WIDTH + x - SKY_WIDTH];
      const o = (y * width + x) * 4;
      pixels[o] = palette[src * 3];
      pixels[o + 1] = palette[src * 3 + 1];
      pixels[o + 2] = palette[src * 3 + 2];
      pixels[o + 3] = 255;
    }
  }
  const w = swap ? east : west;
  const ci = w[(SKY_HEIGHT - 1) * SKY_WIDTH];
  const horizon = [palette[ci * 3] / 255, palette[ci * 3 + 1] / 255, palette[ci * 3 + 2] / 255];
  const zenith = [0, 0, 0];
  for (let x = 0; x < width; x++) for (let k = 0; k < 3; k++) zenith[k] += pixels[x * 4 + k] / 255 / width;
  // Mean colour of the rows a third to two thirds of the way up, where the sky dome takes over from the painting.
  const mid = [0, 0, 0];
  const y0 = Math.round(SKY_HEIGHT * 0.28), y1 = Math.round(SKY_HEIGHT * 0.62);
  for (let y = y0; y < y1; y++) for (let x = 0; x < width; x += 4) for (let k = 0; k < 3; k++) mid[k] += pixels[(y * width + x) * 4 + k];
  for (let k = 0; k < 3; k++) mid[k] /= 255 * (y1 - y0) * (width / 4);
  return { width, height: SKY_HEIGHT, pixels, horizon, zenith, mid, frame };
};

/**
 * A day sky with every hour of it: readDaySky()'s result for `frame`, plus `frameAt(n)` decoding any of the 64
 * frames on demand from the file's bytes, which stay in memory (7.7 MB). The last few decoded frames are kept.
 */
export async function readTimedSky(read, size, frame = DEFAULT_SKY_FRAME, label = 'SKY') {
  if (size < SKY_FILE_SIZE) throw new WorldDataError(`${label}: file is truncated (${size} bytes, expected ${SKY_FILE_SIZE})`);
  if (!(frame >= 0 && frame < 64)) throw new WorldDataError(`${label}: invalid sky frame ${frame}`);
  const palettes = await read(0, PALETTE_STRIDE * 32);
  const images = await read(IMAGE_DATA_AT, 64 * FRAME_BYTES);
  const cache = new Map();
  const frameAt = (n) => {
    const f = Math.min(63, Math.max(0, Math.floor(Number(n) || 0)));
    let hit = cache.get(f);
    if (hit) return hit;
    const swap = f >= 32;
    const t = swap ? 63 - f : f;
    hit = frameOf(
      palettes.subarray(PALETTE_STRIDE * t + 8, PALETTE_STRIDE * t + 8 + 768),
      images.subarray(FRAME_BYTES * t, FRAME_BYTES * (t + 1)),
      images.subarray(FRAME_BYTES * (32 + t), FRAME_BYTES * (33 + t)),
      f, swap,
    );
    cache.set(f, hit);
    if (cache.size > 4) cache.delete(cache.keys().next().value);
    return hit;
  };
  return { ...frameAt(frame), frameAt };
}

export const NIGHT_SKY_WIDTH = 512;
export const NIGHT_SKY_HEIGHT = 219;
export const NIGHT_PALETTE_FILE = 'NIGHTSKY.COL';

/** DaggerfallSky.LoadNightSky: the NITEnnI0.IMG for a SKY index. */
export function nightSkyFileName(skyIndex) {
  const n = skyIndex <= 7 ? 3 : skyIndex <= 15 ? 1 : skyIndex <= 23 ? 2 : 0;
  return `NITE0${n}I0.IMG`;
}

/**
 * Decode a night sky (a headerless 512x219 image, drawn once per half of the horizon) with NIGHTSKY.COL.
 * Alpha is 255 on the ridge silhouette and 0 on open sky (palette indices 17..31, where DFU scatters its stars).
 * @param {Uint8Array} image NITEnnI0.IMG bytes
 * @param {Uint8Array} col NIGHTSKY.COL bytes (8-byte header, then 256 RGB entries)
 */
export function decodeNightSky(image, col, label = 'NITE') {
  const n = NIGHT_SKY_WIDTH * NIGHT_SKY_HEIGHT;
  if (image.length < n) throw new WorldDataError(`${label}: file is truncated (${image.length} bytes, expected ${n})`);
  if (col.length < 776) throw new WorldDataError(`${NIGHT_PALETTE_FILE}: file is truncated (${col.length} bytes, expected 776)`);
  const pixels = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const s = image[i];
    pixels[i * 4] = col[8 + s * 3];
    pixels[i * 4 + 1] = col[8 + s * 3 + 1];
    pixels[i * 4 + 2] = col[8 + s * 3 + 2];
    pixels[i * 4 + 3] = s > 16 && s < 32 ? 0 : 255;
  }
  return { width: NIGHT_SKY_WIDTH, height: NIGHT_SKY_HEIGHT, pixels };
}

/**
 * The whole classic sky for a SKY index: the timed day sky and, when its two files are there, the night sky.
 * @param {(name:string)=>({size:number, read:(offset:number,length:number)=>Promise<Uint8Array>}|null)} open - file by upper-case name
 */
export async function readClassicSky(open, index, frame = DEFAULT_SKY_FRAME) {
  const name = skyFileName(index);
  const f = open(name);
  if (!f) throw new WorldDataError(`${name} is not in the selected folder.`);
  const sky = { ...(await readTimedSky(f.read, f.size, frame, name)), index, file: name, night: null };
  const nightName = nightSkyFileName(index);
  const nf = open(nightName), cf = open(NIGHT_PALETTE_FILE);
  if (nf && cf) {
    try {
      sky.night = { ...decodeNightSky(await nf.read(0, NIGHT_SKY_WIDTH * NIGHT_SKY_HEIGHT), await cf.read(0, 776), nightName), file: nightName };
    } catch { /* the day sky stands alone; the night ridge is drawn without the classic silhouette */ }
  }
  return sky;
}

/** MapsFile.GetWorldClimateSettings SkyBase for a CLIMATE.PAK value. */
export function skyBase(worldClimate) {
  switch (worldClimate) {
    case 224: case 225: return 8; // desert
    case 226: return 0; // mountain
    case 223: case 227: case 228: case 229: return 24; // ocean, rainforest, swamp, subtropical
    default: return 16; // mountain woods, woodlands, haunted woodlands, default
  }
}

/** MapsFile.GetWorldClimateSettings NatureArchive (summer set). */
export function natureArchive(worldClimate) {
  switch (worldClimate) {
    case 224: case 225: return 503;
    case 226: return 510;
    case 227: return 500;
    case 228: return 502;
    case 229: return 501;
    case 230: return 506;
    case 232: return 508;
    default: return 504; // ocean, woodlands, default
  }
}
