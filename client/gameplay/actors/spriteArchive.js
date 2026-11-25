// Multi-frame TEXTURE.nnn reader for mobile sprites (creatures, people, corpses, loot).
//
// client/world/textures.js decodes frame 0 only, which is all the town's
// architecture needs. Mobiles need every frame of every record, plus the
// per-record scale that sets their size in the world, so this reader parses
// the full record header and decodes any (record, frame) lazily.
//
// Adapted from daggerfall-js-source src/formats/textureFile.js (MIT, (c) 2026
// Lattymoy), a translation of Daggerfall Unity's API/TextureFile.cs (MIT,
// (c) 2009-2023 Daggerfall Workshop). See ./THIRD_PARTY_NOTICES.txt.
// File layout per the public UESP "Daggerfall:TEXTURE.XXX" format notes.

import { WorldDataError } from '../../world/errors.js';
import { textureFileName, parsePalette } from '../../world/textures.js';

export { textureFileName, parsePalette };

const ROW_ENCODING_RLE = 0x8000;
const RECORD_RLE = 0x1108;
const IMAGE_RLE = 0x0108;
const MAX_SIDE = 1024;
/** Billboard scale fields are fractions of 256 (BlocksFile.ScaleDivisor). */
export const SCALE_DIVISOR = 256;
/** Native units per metre factor used throughout the client (MeshReader.GlobalScale). */
export const UNIT = 0.025;

/**
 * World size in metres of a record, as Daggerfall Unity computes it:
 * size + trunc(size * scale / 256), times the global unit scale.
 */
export function recordWorldSize(width, height, scaleX, scaleY) {
  const w = width + Math.trunc((width * scaleX) / SCALE_DIVISOR);
  const h = height + Math.trunc((height * scaleY) / SCALE_DIVISOR);
  return { width: w * UNIT, height: h * UNIT };
}

export class SpriteArchive {
  /**
   * @param {Uint8Array} bytes full TEXTURE.nnn contents
   * @param {number} archive archive number (for messages and table lookups)
   */
  constructor(bytes, archive) {
    this.archive = archive;
    this.label = textureFileName(archive);
    if (!(bytes instanceof Uint8Array)) throw new WorldDataError(`${this.label}: expected bytes`);
    if (archive === 0 || archive === 1) throw new WorldDataError(`${this.label}: solid-colour archives have no sprites`);
    if (bytes.length < 26) throw new WorldDataError(`${this.label}: file is too short`);
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const v = this.view;
    this.recordCount = v.getInt16(0, true);
    if (this.recordCount <= 0 || 26 + this.recordCount * 20 > bytes.length) {
      throw new WorldDataError(`${this.label}: invalid record count ${this.recordCount}`);
    }
    this.records = [];
    for (let r = 0; r < this.recordCount; r++) {
      const pos = v.getInt32(26 + r * 20 + 2, true);
      if (pos < 0 || pos + 28 > bytes.length) throw new WorldDataError(`${this.label}: record ${r} header out of range`);
      const rec = {
        pos,
        offsetX: v.getInt16(pos, true),
        offsetY: v.getInt16(pos + 2, true),
        width: v.getInt16(pos + 4, true),
        height: v.getInt16(pos + 6, true),
        compression: v.getInt16(pos + 8, true),
        dataOffset: v.getUint32(pos + 14, true),
        frameCount: v.getUint16(pos + 20, true),
        scaleX: v.getInt16(pos + 24, true),
        scaleY: v.getInt16(pos + 26, true),
      };
      if (rec.width <= 0 || rec.height <= 0 || rec.width > MAX_SIDE || rec.height > MAX_SIDE) {
        throw new WorldDataError(`${this.label}: record ${r} has invalid size ${rec.width}x${rec.height}`);
      }
      if (rec.frameCount < 1 || rec.frameCount > 64) {
        throw new WorldDataError(`${this.label}: record ${r} has invalid frame count ${rec.frameCount}`);
      }
      rec.world = recordWorldSize(rec.width, rec.height, rec.scaleX, rec.scaleY);
      this.records.push(rec);
    }
    this.cache = new Map();
  }

  frameCount(record) {
    return this.records[record]?.frameCount ?? 0;
  }

  /** Decode one frame: {width, height, data: Uint8Array palette indices, top row first, 0 = transparent}. */
  frame(record, frame = 0) {
    const rec = this.records[record];
    if (!rec) throw new WorldDataError(`${this.label}: record ${record} does not exist (archive has ${this.recordCount})`);
    if (!(frame >= 0 && frame < rec.frameCount)) throw new WorldDataError(`${this.label}: record ${record} has no frame ${frame}`);
    const key = record * 64 + frame;
    let img = this.cache.get(key);
    if (!img) {
      img = { width: rec.width, height: rec.height, data: this.#decode(record, rec, frame) };
      this.cache.set(key, img);
    }
    return img;
  }

  #decode(record, rec, frame) {
    const { width, height } = rec;
    const data = new Uint8Array(width * height);
    const b = this.bytes;
    const v = this.view;
    const chk = (at, n) => {
      if (at < 0 || at + n > b.length) throw new WorldDataError(`${this.label}: record ${record} frame ${frame} data out of range`);
    };
    if (rec.compression === RECORD_RLE || rec.compression === IMAGE_RLE) {
      // One row header (offset, encoding) per row, frames stacked one after another.
      let hp = rec.pos + rec.dataOffset + height * frame * 4;
      chk(hp, height * 4);
      let dst = 0;
      for (let y = 0; y < height; y++, hp += 4) {
        let src = rec.pos + v.getInt16(hp, true);
        const encoding = v.getUint16(hp + 2, true);
        const rowEnd = (y + 1) * width;
        if (encoding === ROW_ENCODING_RLE) {
          chk(src, 2);
          const rowWidth = v.getUint16(src, true);
          src += 2;
          let rowPos = 0;
          while (rowPos < rowWidth) {
            chk(src, 2);
            const probe = v.getInt16(src, true);
            src += 2;
            if (probe < 0) {
              chk(src, 1);
              const n = -probe;
              data.fill(b[src++], dst, Math.min(dst + n, rowEnd));
              dst += n;
              rowPos += n;
            } else if (probe > 0) {
              chk(src, probe);
              data.set(b.subarray(src, src + Math.max(0, Math.min(probe, rowEnd - dst))), dst);
              src += probe;
              dst += probe;
              rowPos += probe;
            } else {
              throw new WorldDataError(`${this.label}: record ${record} has a zero RLE probe`);
            }
          }
          dst = rowEnd;
        } else {
          chk(src, width);
          data.set(b.subarray(src, src + width), dst);
          dst = rowEnd;
        }
      }
    } else if (rec.frameCount === 1) {
      // Uncompressed single frame: rows on a fixed 256-byte stride.
      let src = rec.pos + rec.dataOffset;
      chk(src, (height - 1) * 256 + width);
      for (let y = 0; y < height; y++, src += 256) data.set(b.subarray(src, src + width), y * width);
    } else {
      // Uncompressed multi-frame: offset table, then per frame cx, cy and
      // (transparent skip, opaque run, run bytes) row segments.
      const base = rec.pos + rec.dataOffset;
      chk(base + frame * 4, 4);
      let src = base + v.getInt32(base + frame * 4, true);
      chk(src, 4);
      const cx = v.getInt16(src, true);
      const cy = v.getInt16(src + 2, true);
      src += 4;
      for (let y = 0; y < Math.min(cy, height); y++) {
        let x = 0;
        const row = y * width;
        while (x < cx) {
          chk(src, 2);
          x += b[src++]; // transparent run, already zero
          const run = b[src++];
          chk(src, run);
          for (let i = 0; i < run; i++, x++) {
            const px = b[src++];
            if (x < width) data[row + x] = px;
          }
        }
      }
    }
    return data;
  }
}

/**
 * Expand palette indices to RGBA. Index 0 is transparent, as for all
 * Daggerfall billboards. `flip` mirrors left-right.
 */
export function indicesToRgba(img, palette, { flip = false, out = null, outWidth = img.width, x0 = 0, y0 = 0 } = {}) {
  const { width, height, data } = img;
  const dst = out ?? new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = data[y * width + (flip ? width - 1 - x : x)];
      const o = ((y0 + y) * outWidth + x0 + x) * 4;
      if (i === 0) { dst[o] = dst[o + 1] = dst[o + 2] = dst[o + 3] = 0; continue; }
      dst[o] = palette[i * 3];
      dst[o + 1] = palette[i * 3 + 1];
      dst[o + 2] = palette[i * 3 + 2];
      dst[o + 3] = 255;
    }
  }
  return dst;
}
