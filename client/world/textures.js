// TEXTURE.nnn and ART_PAL.COL decoding (first frame of a record only).
//
// Adapted from daggerfall-js-source src/formats/textureFile.js and dfPalette.js
// (MIT, (c) 2026 Lattymoy), translations of Daggerfall Unity's
// API/TextureFile.cs and API/DFPalette.cs (MIT, (c) 2009-2023 Daggerfall
// Workshop). See client/world/THIRD_PARTY_NOTICES.txt.

import { WorldDataError } from './errors.js';

const SOLID_SIZE = 32;
const ROW_ENCODING_RLE = 0x8000;
const RECORD_RLE = 0x1108;
const IMAGE_RLE = 0x0108;

export const textureFileName = (archive) => `TEXTURE.${String(archive).padStart(3, '0')}`;

/** Parse a 768-byte (.PAL) or 776-byte (.COL, 8-byte header) palette into 256*3 RGB bytes. */
export function parsePalette(bytes, label = 'palette') {
  if (bytes.length === 776) return bytes.slice(8, 776);
  if (bytes.length === 768) return bytes.slice(0, 768);
  throw new WorldDataError(`${label}: expected 768 or 776 bytes, got ${bytes.length}`);
}

/** A parsed TEXTURE.nnn archive. decode(record) returns {width,height,data:Uint8Array palette indices}, top row first. */
export class TextureArchive {
  constructor(bytes, archive) {
    this.archive = archive;
    this.label = textureFileName(archive);
    this.bytes = bytes;
    if (bytes.length < 26) throw new WorldDataError(`${this.label}: file is too short`);
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.solid = archive === 0 || archive === 1;
    this.recordCount = this.view.getInt16(0, true);
    if (this.recordCount < 0 || 26 + this.recordCount * 20 > bytes.length) {
      throw new WorldDataError(`${this.label}: invalid record count ${this.recordCount}`);
    }
    this.records = [];
    for (let r = 0; r < this.recordCount; r++) {
      const hp = 26 + r * 20;
      const pos = this.view.getInt32(hp + 2, true);
      if (this.solid) {
        this.records.push({ pos, width: SOLID_SIZE, height: SOLID_SIZE });
        continue;
      }
      if (pos < 0 || pos + 28 > bytes.length) throw new WorldDataError(`${this.label}: record ${r} header out of range`);
      const v = this.view;
      this.records.push({
        pos,
        width: v.getInt16(pos + 4, true),
        height: v.getInt16(pos + 6, true),
        compression: v.getInt16(pos + 8, true),
        dataOffset: v.getUint32(pos + 14, true),
        frameCount: v.getUint16(pos + 20, true),
      });
    }
  }

  decode(record) {
    const rec = this.records[record];
    if (!rec) throw new WorldDataError(`${this.label}: record ${record} does not exist (archive has ${this.recordCount})`);
    const { width, height } = rec;
    if (this.solid) {
      const index = this.archive === 0 ? record & 0xff : (128 + record) & 0xff;
      return { width, height, data: new Uint8Array(width * height).fill(index) };
    }
    if (width <= 0 || height <= 0 || width > 1024 || height > 1024) {
      throw new WorldDataError(`${this.label}: record ${record} has invalid size ${width}x${height}`);
    }
    const data = new Uint8Array(width * height);
    const b = this.bytes;
    const v = this.view;
    const chk = (at, n) => {
      if (at < 0 || at + n > b.length) throw new WorldDataError(`${this.label}: record ${record} image data out of range`);
    };
    if (rec.compression === RECORD_RLE || rec.compression === IMAGE_RLE) {
      let hp = rec.pos + rec.dataOffset; // frame 0 row headers
      chk(hp, height * 4);
      let dst = 0;
      for (let y = 0; y < height; y++, hp += 4) {
        let src = rec.pos + v.getInt16(hp, true);
        const encoding = v.getUint16(hp + 2, true);
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
              data.fill(b[src++], dst, Math.min(dst - probe, data.length));
              dst -= probe;
              rowPos -= probe;
            } else if (probe > 0) {
              chk(src, probe);
              data.set(b.subarray(src, src + Math.min(probe, data.length - dst)), dst);
              src += probe;
              dst += probe;
              rowPos += probe;
            } else {
              throw new WorldDataError(`${this.label}: record ${record} has a zero RLE probe`);
            }
          }
        } else {
          chk(src, width);
          data.set(b.subarray(src, src + width), dst);
          dst += width;
        }
      }
    } else if (rec.frameCount <= 1) {
      // Uncompressed single frame: rows on a fixed 256-byte stride.
      let src = rec.pos + rec.dataOffset;
      chk(src, (height - 1) * 256 + width);
      for (let y = 0; y < height; y++, src += 256) data.set(b.subarray(src, src + width), y * width);
    } else {
      // Uncompressed multi-frame: frame offset table, then cx, cy and transparent-run rows.
      const base = rec.pos + rec.dataOffset;
      chk(base, 4);
      let src = base + v.getInt32(base, true);
      chk(src, 4);
      const cx = v.getInt16(src, true);
      const cy = v.getInt16(src + 2, true);
      src += 4;
      let dst = 0;
      for (let y = 0; y < cy && dst < data.length; y++) {
        let x = 0;
        while (x < cx) {
          chk(src, 2);
          const skip = b[src++];
          dst += skip;
          x += skip;
          const run = b[src++];
          chk(src, run);
          for (let i = 0; i < run; i++) if (dst < data.length) data[dst++] = b[src++];
          else src++;
          x += run;
        }
      }
    }
    return { width, height, data };
  }
}
