// Indexed ARENA2 UI pictures. IMG layout and the headerless compass dimensions follow
// Daggerfall Unity's API/ImgFile.cs (MIT, © 2009–2023 Daggerfall Workshop).
// Only metadata is shipped. All pixels and palettes come from the active file source.
import { indexFiles } from '../world/files.js';
import { WorldDataError } from '../world/errors.js';
import { parsePalette } from '../world/textures.js';

const RAW_SIZES = Object.freeze({ 'COMPASS.IMG': [322, 14], 'MASK04I0.IMG': [40, 80] });

export function decodeImg(bytes, label) {
  const raw = RAW_SIZES[label] ?? [320, 200];
  if (bytes.length === raw[0] * raw[1]) return { width: raw[0], height: raw[1], indices: bytes };
  if (bytes.length < 12) throw new WorldDataError(`${label}: file is too short`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = v.getInt16(4, true), height = v.getInt16(6, true), compression = v.getUint16(8, true);
  if (compression !== 0) throw new WorldDataError(`${label}: compressed images are not supported here`);
  if (width <= 0 || height <= 0 || 12 + width * height > bytes.length) throw new WorldDataError(`${label}: invalid image size ${width}x${height}`);
  return { width, height, indices: bytes.subarray(12, 12 + width * height) };
}

export function cropImg({ width, height, indices }, [x, y, w, h]) {
  if (x < 0 || y < 0 || x + w > width || y + h > height || w <= 0 || h <= 0) return null;
  const cropped = new Uint8Array(w * h);
  for (let i = 0; i < h; i++) {
    const start = (y + i) * width + x;
    cropped.set(indices.subarray(start, start + w), i * w);
  }
  return { width: w, height: h, indices: cropped };
}

export function toRgba({ width, height, indices }, palette, transparent = false) {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    if (transparent && index === 0) continue;
    const c = index * 3;
    out[i * 4] = palette[c];
    out[i * 4 + 1] = palette[c + 1];
    out[i * 4 + 2] = palette[c + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function artCanvas(width, height, rgba) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}

/** Owns promises for one file selection, so a slow old read cannot populate a replacement cache. */
export class ClassicUiArt {
  constructor(files) {
    this.index = indexFiles(files ?? []);
    this.cache = new Map();
  }

  bytes(name) {
    if (!this.cache.has(name)) {
      const file = this.index.get(name);
      this.cache.set(name, file ? file.arrayBuffer().then((b) => new Uint8Array(b)).catch(() => null) : Promise.resolve(null));
    }
    return this.cache.get(name);
  }

  palette() {
    this.colors ??= this.bytes('ART_PAL.COL').then((b) => b ? parsePalette(b, 'ART_PAL.COL') : null).catch(() => null);
    return this.colors;
  }

  async picture(name, rect, transparent = false) {
    const [bytes, palette] = await Promise.all([this.bytes(name), this.palette()]);
    if (!bytes || !palette) return null;
    try {
      const img = decodeImg(bytes, name);
      const pixels = rect ? cropImg(img, rect) : img;
      return pixels ? artCanvas(pixels.width, pixels.height, toRgba(pixels, palette, transparent)) : null;
    } catch {
      return null;
    }
  }
}
