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
