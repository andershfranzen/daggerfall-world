// WEAPON*.CIF reader for the first-person weapon view, plus ART_PAL.COL.
//
// Adapted from daggerfall-js-source src/formats/cifRciFile.js, baseImageFile.js
// and dfPalette.js (MIT, (c) 2026 Lattymoy), translations of Daggerfall Unity's
// API/CifRciFile.cs, API/BaseImageFile.cs and API/DFPalette.cs (MIT, (c)
// 2009-2023 Daggerfall Workshop). See ./THIRD_PARTY_NOTICES.txt.
//
// Kept from the source: the weapon layout (a plain IMG "held" record first,
// except WEAPON09.CIF, the bow, which has none; then animation records whose
// 31-slot frame offset list defines the frame count by its non-zero entries),
// the classic RLE scheme, the 64-record cap and index 0 as transparent.
// Departures, all defensive: every read is bounds-checked and malformed input
// throws CifError instead of reading past the buffer; the RLE decoder stops at
// the destination length; dimensions are capped; decoding works on bytes from
// a File the player selected and never on bundled data. Pixel rows are kept
// top-first (DFU flips them for Unity textures; a 2D canvas does not need it).

export class CifError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CifError';
  }
}

/** CifRciFile.cs `new Record[64]` - the weapon loop's only stride is the file's own TotalSize. */
export const MAX_WEAPON_RECORDS = 64;
/** No weapon image is larger than the 320x200 surface; allow generous headroom for odd files. */
export const MAX_SIDE = 1024;
const ANIM_HEADER = 12 + 31 * 2 + 2;
const COMPRESSION_UNCOMPRESSED = 0x0000;
const COMPRESSION_RLE = 0x0002;

/**
 * Parses a 768-byte .PAL or 776-byte .COL palette into 256 RGB triples.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} 768 bytes
 */
export function parsePalette(bytes, label = 'palette') {
  if (!(bytes instanceof Uint8Array)) throw new CifError(`${label}: expected bytes`);
  if (bytes.length === 776) return bytes.slice(8, 776);
  if (bytes.length === 768) return bytes.slice(0, 768);
  throw new CifError(`${label}: expected 768 or 776 bytes, got ${bytes.length}`);
}

/**
 * Classic RLE (code > 127: run of the next byte, code - 127 times; else a
 * literal copy of code + 1 bytes) into `dst`. Throws on truncated input.
 * Returns the source position after the last byte consumed.
 */
export function decodeRle(src, srcPos, dst, label = 'RLE') {
  const length = dst.length;
  let pos = 0;
  while (pos < length) {
    if (srcPos >= src.length) throw new CifError(`${label}: pixel data ends early`);
    const code = src[srcPos++];
    if (code > 127) {
      if (srcPos >= src.length) throw new CifError(`${label}: pixel data ends early`);
      const pixel = src[srcPos++];
      const n = Math.min(code - 127, length - pos);
      dst.fill(pixel, pos, pos + n);
      pos += n;
    } else {
      const n = code + 1;
      if (srcPos + n > src.length) throw new CifError(`${label}: pixel data ends early`);
      const take = Math.min(n, length - pos);
      dst.set(src.subarray(srcPos, srcPos + take), pos);
      srcPos += n;
      pos += take;
    }
  }
  return srcPos;
}

function checkSize(label, width, height) {
  if (!(width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE)) {
    throw new CifError(`${label}: invalid image size ${width}x${height}`);
  }
}

/**
 * One WEAPON*.CIF. `records[r]` is `{kind:'held'|'anim', width, height,
 * frameCount, xOffset, yOffset}`; `frame(r, f)` decodes lazily to
 * `{width, height, data}` with palette indices, top row first.
 */
export class WeaponCif {
  /**
   * @param {Uint8Array} bytes full file contents
   * @param {string} fileName e.g. "WEAPON04.CIF"; WEAPON09 (the bow) has no held record
   */
  constructor(bytes, fileName) {
    if (!(bytes instanceof Uint8Array)) throw new CifError(`${fileName}: expected bytes`);
    this.fileName = String(fileName).toUpperCase();
    if (!/^WEAPO.*\.CIF$/.test(this.fileName)) throw new CifError(`${fileName}: not a weapon CIF`);
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.records = [];
    this.cache = new Map();
    this.#read();
  }

  get recordCount() {
    return this.records.length;
  }

  #need(pos, n, what) {
    if (pos < 0 || pos + n > this.bytes.length) throw new CifError(`${this.fileName}: ${what} out of range`);
  }

  #read() {
    const v = this.view;
    const len = this.bytes.length;
    let pos = 0;
    if (this.fileName !== 'WEAPON09.CIF') {
      this.#need(pos, 12, 'held image header');
      const rec = {
        kind: 'held',
        position: pos,
        xOffset: v.getInt16(pos, true),
        yOffset: v.getInt16(pos + 2, true),
        width: v.getInt16(pos + 4, true),
        height: v.getInt16(pos + 6, true),
        compression: v.getUint16(pos + 8, true),
        dataLength: v.getUint16(pos + 10, true),
        dataPosition: pos + 12,
        frameCount: 1,
      };
      checkSize(`${this.fileName} held image`, rec.width, rec.height);
      if (rec.compression !== COMPRESSION_UNCOMPRESSED && rec.compression !== COMPRESSION_RLE) {
        throw new CifError(`${this.fileName}: unsupported held image compression 0x${rec.compression.toString(16)}`);
      }
      this.#need(rec.dataPosition, rec.dataLength, 'held image data');
      this.records.push(rec);
      pos = rec.dataPosition + rec.dataLength;
    }
    while (pos < len) {
      if (this.records.length >= MAX_WEAPON_RECORDS) throw new CifError(`${this.fileName}: too many records`);
      this.#need(pos, ANIM_HEADER, `record ${this.records.length} header`);
      const rec = {
        kind: 'anim',
        position: pos,
        width: v.getUint16(pos, true),
        height: v.getUint16(pos + 2, true),
        lastFrameWidth: v.getUint16(pos + 4, true),
        xOffset: v.getInt16(pos + 6, true),
        lastFrameYOffset: v.getInt16(pos + 8, true),
        dataLength: v.getInt16(pos + 10, true),
        offsets: [],
        totalSize: v.getUint16(pos + 12 + 62, true),
        frameCount: 0,
        yOffset: 0,
      };
      // Non-zero entries define the frame count, as in ReadWeaponCif.
      for (let i = 0; i < 31; i++) {
        const o = v.getUint16(pos + 12 + i * 2, true);
        if (o !== 0) rec.offsets.push(o);
      }
      rec.frameCount = rec.offsets.length;
      checkSize(`${this.fileName} record ${this.records.length}`, rec.width, rec.height);
      if (rec.frameCount === 0) throw new CifError(`${this.fileName}: record ${this.records.length} has no frames`);
      if (rec.totalSize < ANIM_HEADER) throw new CifError(`${this.fileName}: record ${this.records.length} has invalid size`);
      this.#need(pos, rec.totalSize, `record ${this.records.length} data`);
      for (const o of rec.offsets) {
        if (o < ANIM_HEADER || o >= rec.totalSize) throw new CifError(`${this.fileName}: record ${this.records.length} frame offset out of range`);
      }
      this.records.push(rec);
      pos += rec.totalSize;
    }
    if (this.records.length === 0) throw new CifError(`${this.fileName}: no images`);
  }

  size(record) {
    const r = this.records[record];
    return r ? { width: r.width, height: r.height } : { width: 0, height: 0 };
  }

  frameCount(record) {
    return this.records[record]?.frameCount ?? 0;
  }

  /** Indexed bitmap `{width,height,data}` for (record, frame); throws on invalid input. */
  frame(record, frame) {
    const r = this.records[record];
    if (!r || !(frame >= 0 && frame < r.frameCount)) throw new CifError(`${this.fileName}: no frame ${record}:${frame}`);
    const key = `${record}:${frame}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const data = new Uint8Array(r.width * r.height);
    const label = `${this.fileName} ${key}`;
    if (r.kind === 'held') {
      if (r.compression === COMPRESSION_RLE) {
        const end = decodeRle(this.bytes.subarray(0, r.dataPosition + r.dataLength), r.dataPosition, data, label);
        void end;
      } else {
        if (r.dataLength < data.length) throw new CifError(`${label}: pixel data is short`);
        data.set(this.bytes.subarray(r.dataPosition, r.dataPosition + data.length));
      }
    } else {
      // A frame never reads past its own record.
      decodeRle(this.bytes.subarray(0, r.position + r.totalSize), r.position + r.offsets[frame], data, label);
    }
    const bmp = { width: r.width, height: r.height, data };
    this.cache.set(key, bmp);
    return bmp;
  }
}

/**
 * Indexed bitmap → RGBA (Uint8ClampedArray, top row first) with index 0
 * transparent, as CIF art is drawn.
 * @param {{width:number,height:number,data:Uint8Array}} bmp
 * @param {Uint8Array} palette 768 RGB bytes from parsePalette
 */
export function toRgba(bmp, palette) {
  const out = new Uint8ClampedArray(bmp.width * bmp.height * 4);
  for (let i = 0; i < bmp.data.length; i++) {
    const idx = bmp.data[i];
    if (idx === 0) continue;
    const o = i * 4;
    const p = idx * 3;
    out[o] = palette[p];
    out[o + 1] = palette[p + 1];
    out[o + 2] = palette[p + 2];
    out[o + 3] = 255;
  }
  return out;
}
