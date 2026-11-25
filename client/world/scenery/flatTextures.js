// TEXTURE.nnn flat (billboard) records: every animation frame, plus the record's
// world scale.
//
// Record header and frame decoding follow Daggerfall Unity's API/TextureFile.cs
// (ReadRecords, ReadRle, ReadImage) and billboard sizing follows MeshReader.cs
// GetScaledBillboardSize with BlocksFile.ScaleDivisor = 256 (MIT, (c) 2009-2023
// Daggerfall Workshop), via the JavaScript translation in daggerfall-js-source
// src/formats/textureFile.js (MIT, (c) 2026 Lattymoy). See THIRD_PARTY_NOTICES.txt.

import { WorldDataError } from '../errors.js';

const ROW_ENCODING_RLE = 0x8000;
const RECORD_RLE = 0x1108;
const IMAGE_RLE = 0x0108;
const SCALE_DIVISOR = 256;
const SCALE = 0.025;

export class FlatArchive {
  constructor(bytes, archive) {
    this.archive = archive;
    this.label = `TEXTURE.${String(archive).padStart(3, '0')}`;
    if (bytes.length < 26) throw new WorldDataError(`${this.label}: file is too short`);
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.recordCount = this.view.getInt16(0, true);
    if (this.recordCount < 0 || 26 + this.recordCount * 20 > bytes.length) {
      throw new WorldDataError(`${this.label}: invalid record count ${this.recordCount}`);
    }
    this.records = [];
    for (let r = 0; r < this.recordCount; r++) {
      const pos = this.view.getInt32(26 + r * 20 + 2, true);
      if (pos < 0 || pos + 28 > bytes.length) throw new WorldDataError(`${this.label}: record ${r} header out of range`);
      const v = this.view;
      this.records.push({
        pos,
        width: v.getInt16(pos + 4, true),
        height: v.getInt16(pos + 6, true),
        compression: v.getInt16(pos + 8, true),
        dataOffset: v.getUint32(pos + 14, true),
        frameCount: v.getUint16(pos + 20, true),
        scaleX: v.getInt16(pos + 24, true),
        scaleY: v.getInt16(pos + 26, true),
      });
    }
  }

  record(record) {
    const rec = this.records[record];
    if (!rec) throw new WorldDataError(`${this.label}: record ${record} does not exist (archive has ${this.recordCount})`);
    if (rec.width <= 0 || rec.height <= 0 || rec.width > 1024 || rec.height > 1024) {
      throw new WorldDataError(`${this.label}: record ${record} has invalid size ${rec.width}x${rec.height}`);
    }
    return rec;
  }

  /** World size in metres (GetScaledBillboardSize * GlobalScale). */
  size(record) {
    const r = this.record(record);
    const w = r.width + Math.trunc(r.width * (r.scaleX / SCALE_DIVISOR));
    const h = r.height + Math.trunc(r.height * (r.scaleY / SCALE_DIVISOR));
    return { width: w * SCALE, height: h * SCALE };
  }

  frameCount(record) {
    return Math.max(1, this.record(record).frameCount);
  }

  /** Palette indices of one frame, top row first. Index 0 is transparent in flats. */
  decode(record, frame = 0) {
    const rec = this.record(record);
    const { width, height } = rec;
    const frames = Math.max(1, rec.frameCount);
    if (frame < 0 || frame >= frames) throw new WorldDataError(`${this.label}: record ${record} has no frame ${frame}`);
    const data = new Uint8Array(width * height);
    const b = this.bytes;
    const v = this.view;
    const chk = (at, n) => {
      if (at < 0 || at + n > b.length) throw new WorldDataError(`${this.label}: record ${record} frame ${frame} data out of range`);
    };
    if (rec.compression === RECORD_RLE || rec.compression === IMAGE_RLE) {
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
              data.fill(b[src++], dst, Math.min(dst - probe, rowEnd));
              dst -= probe;
              rowPos -= probe;
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
    } else if (frames === 1) {
      let src = rec.pos + rec.dataOffset;
      chk(src, (height - 1) * 256 + width);
      for (let y = 0; y < height; y++, src += 256) data.set(b.subarray(src, src + width), y * width);
    } else {
      const base = rec.pos + rec.dataOffset;
      chk(base + frame * 4, 4);
      let src = base + v.getInt32(base + frame * 4, true);
      chk(src, 4);
      const cx = v.getInt16(src, true);
      const cy = v.getInt16(src + 2, true);
      src += 4;
      for (let y = 0; y < Math.min(cy, height); y++) {
        let x = 0;
        let dst = y * width;
        while (x < cx) {
          chk(src, 2);
          const skip = b[src++];
          x += skip;
          dst += skip;
          const run = b[src++];
          chk(src, run);
          for (let i = 0; i < run; i++, x++, src++) if (x < width) data[dst++] = b[src];
        }
      }
    }
    return { width, height, data };
  }
}
