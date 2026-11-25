// Decoders for the player's local spell art: multi-image CIF casting animations (FIRE00C6.CIF …)
// and the ICON00I0.IMG spell icon atlas. IMG header/RLE layout and the cast frame sequence follow
// Daggerfall Unity's BaseImageFile, CifRciFile, SpellIconCollection and FPSSpellCasting
// (MIT License, Copyright (c) 2009-2023 Daggerfall Workshop). Nothing here bundles game art.

export const CAST_FILES = Object.freeze({
  fire: 'FIRE00C6.CIF', cold: 'FRST00C6.CIF', poison: 'POIS00C6.CIF', shock: 'SHOK00C6.CIF', magic: 'MJIC00C6.CIF',
});
export const ICON_FILE = 'ICON00I0.IMG';
export const PALETTE_FILE = 'ART_PAL.COL';
/** FPSSpellCasting: frames 0..5 then back to 0, 40 ms each; frame 5 releases the spell. */
export const CAST_SEQUENCE = Object.freeze([0, 1, 2, 3, 4, 5, 0]);
export const CAST_FRAME_S = 0.04;
/** Small frames (0, 5 and fire 4) sit 13.4% in from the screen edge. */
export const SMALL_FRAME_ADJUST = 0.134;
export const NATIVE_W = 300; // DFU scales hands against a 300x200 frame
export const NATIVE_H = 200;
export const ICON_SIZE = 16;
export const ICON_COLUMNS = 20;
export const ICON_COUNT = 69;
const MAX_SIDE = 1024;

export class SpellArtError extends Error {}

/** 768-byte .PAL or 776-byte .COL → 768 RGB bytes. */
export function parsePalette(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length === 776) return b.subarray(8);
  if (b.length === 768) return b;
  throw new SpellArtError(`${PALETTE_FILE}: expected 768 or 776 bytes, got ${b.length}`);
}

function rle(src, pos, end, out) {
  let o = 0;
  while (o < out.length) {
    if (pos >= end) throw new SpellArtError('RLE data ends early');
    const code = src[pos++];
    if (code > 127) {
      if (pos >= end) throw new SpellArtError('RLE run past end of record');
      const px = src[pos++];
      const n = Math.min(code - 127, out.length - o);
      out.fill(px, o, o + n);
      o += n;
    } else {
      const n = Math.min(code + 1, out.length - o);
      if (pos + n > end) throw new SpellArtError('RLE literal past end of record');
      out.set(src.subarray(pos, pos + n), o);
      pos += code + 1;
      o += n;
    }
  }
}

/** Parse a CIF made of consecutive IMG records. Returns [{width,height,x,y,pixels}]. */
export function readImageRecords(bytes, label = 'CIF') {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out = [];
  let pos = 0;
  while (pos + 12 <= b.length && out.length < 64) {
    const x = dv.getInt16(pos, true);
    const y = dv.getInt16(pos + 2, true);
    const width = dv.getInt16(pos + 4, true);
    const height = dv.getInt16(pos + 6, true);
    const compression = dv.getUint16(pos + 8, true);
    const length = dv.getUint16(pos + 10, true);
    const data = pos + 12;
    if (width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE) throw new SpellArtError(`${label}: bad record size ${width}x${height}`);
    if (data + length > b.length) throw new SpellArtError(`${label}: record ${out.length} is truncated`);
    const pixels = new Uint8Array(width * height);
    if (compression === 0) {
      if (length < pixels.length) throw new SpellArtError(`${label}: record ${out.length} is short`);
      pixels.set(b.subarray(data, data + pixels.length));
    } else if (compression === 2) {
      rle(b, data, data + length, pixels);
    } else {
      throw new SpellArtError(`${label}: unsupported compression 0x${compression.toString(16)}`);
    }
    out.push({ width, height, x, y, pixels });
    pos = data + length;
  }
  if (!out.length) throw new SpellArtError(`${label}: no images`);
  return out;
}

/** Palette indices → RGBA; index 0 is transparent when `transparent`. */
export function toRgba(img, palette, transparent = true) {
  const rgba = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0; i < img.pixels.length; i++) {
    const c = img.pixels[i];
    rgba[i * 4] = palette[c * 3];
    rgba[i * 4 + 1] = palette[c * 3 + 1];
    rgba[i * 4 + 2] = palette[c * 3 + 2];
    rgba[i * 4 + 3] = transparent && c === 0 ? 0 : 255;
  }
  return rgba;
}

/** Cut one 16x16 icon from the 320x64 ICON00I0.IMG atlas (headerless; or with a 12-byte header). */
export function iconPixels(bytes, index) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const W = ICON_COLUMNS * ICON_SIZE;
  const start = b.length === W * 64 ? 0 : b.length >= W * 64 + 12 ? 12 : -1;
  if (start < 0) throw new SpellArtError(`${ICON_FILE}: unexpected size ${b.length}`);
  const i = Math.max(0, Math.min(ICON_COUNT - 1, index | 0));
  const ox = (i % ICON_COLUMNS) * ICON_SIZE;
  const oy = Math.floor(i / ICON_COLUMNS) * ICON_SIZE;
  const pixels = new Uint8Array(ICON_SIZE * ICON_SIZE);
  for (let y = 0; y < ICON_SIZE; y++) {
    pixels.set(b.subarray(start + (oy + y) * W + ox, start + (oy + y) * W + ox + ICON_SIZE), y * ICON_SIZE);
  }
  return { width: ICON_SIZE, height: ICON_SIZE, x: 0, y: 0, pixels };
}

/**
 * Screen rectangles for both casting hands (DFU FPSSpellCasting.AlignLeftHand/AlignRightHand):
 * the right hand is the mirrored left hand. Fit the original aspect ratio on wide and tall views. Returns { left:{x,y,w,h}, right:{...,mirror:true} }.
 */
export function handRects(screenW, screenH, frame, frameIndex, element) {
  const scale = Math.min(screenW / NATIVE_W, screenH / NATIVE_H);
  const small = frameIndex === 0 || frameIndex === 5 || (element === 'fire' && frameIndex === 4);
  const off = small ? SMALL_FRAME_ADJUST : 0;
  const w = frame.width * scale;
  const h = frame.height * scale;
  const y = screenH - h;
  return { left: { x: screenW * off, y, w, h }, right: { x: screenW * (1 - off) - w, y, w, h, mirror: true } };
}

/** Index File objects by upper-case base name. */
export function indexFiles(files) {
  const map = new Map();
  for (const f of files ?? []) {
    const name = String(f?.name ?? '').split(/[\\/]/).pop().toUpperCase();
    if (name) map.set(name, f);
  }
  return map;
}
