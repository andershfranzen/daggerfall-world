// Classic CFA animation reader (first-person horse and cart art, MRED00I0.CFA /
// MRED01I0.CFA). Pure module, no DOM: bytes in, palette indices out.
//
// Header and RLE layout follow Daggerfall Unity's API/CfaFile.cs and
// API/BaseImageFile.cs ReadRleData (MIT, (c) 2009-2023 Daggerfall Workshop).
// Like DFU, only 8-bit unmuxed images are supported, which covers the riding art.
// Notices: client/gameplay/travel/NOTICES.txt.

/** Classic riding art, drawn with ART_PAL.COL (CfaFile.PaletteName). */
export const HORSE_CFA = 'MRED00I0.CFA';
export const CART_CFA = 'MRED01I0.CFA';
export const CFA_PALETTE = 'ART_PAL.COL';
/** TransportManager: seconds between riding frames, classic screen height, horizontal squash. */
export const RIDE_FRAME_SECONDS = 0.125;
export const NATIVE_SCREEN_HEIGHT = 200;
export const RIDE_SCALE_X = 0.8;

/**
 * @param {Uint8Array} bytes whole CFA file
 * @returns {{width:number, height:number, frames:Uint8Array[]}} frames are width*height palette indices, 0 = transparent
 */
export function decodeCfa(bytes, label = 'CFA') {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) throw new Error(`${label}: file is too short`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = v.getInt16(0, true);
  const height = v.getInt16(2, true);
  const widthCompressed = v.getInt16(4, true);
  const bitsPerPixel = bytes[10];
  const frameCount = bytes[11];
  const headerSize = v.getInt16(12, true);
  if (width <= 0 || height <= 0 || width > 1024 || height > 1024) throw new Error(`${label}: invalid size ${width}x${height}`);
  if (frameCount < 1 || frameCount > 64) throw new Error(`${label}: invalid frame count ${frameCount}`);
  if (bitsPerPixel !== 8 || widthCompressed !== width) throw new Error(`${label}: only 8-bit unmuxed CFA images are supported`);
  if (headerSize < 14 || headerSize >= bytes.length) throw new Error(`${label}: invalid header size ${headerSize}`);
  const total = width * height * frameCount;
  const out = new Uint8Array(total);
  let src = headerSize, pos = 0;
  while (pos < total) {
    if (src >= bytes.length) throw new Error(`${label}: image data ends early`);
    const code = bytes[src++];
    if (code > 127) {
      if (src >= bytes.length) throw new Error(`${label}: image data ends early`);
      const px = bytes[src++];
      const n = Math.min(code - 127, total - pos);
      out.fill(px, pos, pos + n);
      pos += n;
    } else {
      const n = code + 1;
      if (src + n > bytes.length) throw new Error(`${label}: image data ends early`);
      out.set(bytes.subarray(src, src + Math.min(n, total - pos)), pos);
      src += n;
      pos += n;
    }
  }
  const frames = [];
  for (let f = 0; f < frameCount; f++) frames.push(out.subarray(f * width * height, (f + 1) * width * height));
  return { width, height, frames };
}

/**
 * Where TransportManager.OnGUI draws the riding art on a screen of `screenW` x `screenH`
 * pixels: centred, bottom aligned, scaled by height with the classic 0.8 squash.
 */
export function ridingRect(img, screenW, screenH, offsetBottom = 0) {
  const sy = screenH / NATIVE_SCREEN_HEIGHT;
  const sx = sy * RIDE_SCALE_X;
  const w = img.width * sx, h = img.height * sy;
  return { x: screenW / 2 - w / 2, y: screenH - h - offsetBottom, w, h };
}
