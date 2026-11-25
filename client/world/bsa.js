// BSA archive reader over a lazily read Blob/File.
//
// Adapted from daggerfall-js-source src/formats/bsaFile.js (MIT, (c) 2026 Lattymoy),
// itself a translation of Daggerfall Unity's API/BsaFile.cs (MIT, (c) 2009-2023
// Daggerfall Workshop). See client/world/THIRD_PARTY_NOTICES.txt.
//
// Format (little-endian):
//   int16 directoryCount, uint16 directoryType at offset 0. Records are packed
//   from offset 4 in directory order. The directory sits at the end of the file:
//     NameRecord   (0x0100): 18 bytes/entry = 14-byte NUL-padded name + int32 size
//     NumberRecord (0x0200):  8 bytes/entry = uint32 id + int32 size
// Changes from the source: records are read on demand with Blob.slice so a
// 30 MB archive is never held whole; directory sizes are validated against
// the file length; names are matched case-insensitively.

import { WorldDataError } from './errors.js';

export const NAME_RECORD = 0x0100;
export const NUMBER_RECORD = 0x0200;

/** Read `length` bytes at `offset` from a Blob (File). */
export async function readBlob(blob, offset, length) {
  const buf = await blob.slice(offset, offset + length).arrayBuffer();
  if (buf.byteLength !== length) {
    throw new WorldDataError(`${blob.name ?? 'file'}: short read at ${offset} (wanted ${length}, got ${buf.byteLength})`);
  }
  return new Uint8Array(buf);
}

export class BsaArchive {
  /** Use BsaArchive.open(). */
  constructor(blob, label, type, entries) {
    this.blob = blob;
    this.label = label;
    this.directoryType = type;
    this.entries = entries; // [{name, id, size, position}]
    this._byName = new Map();
    this._byId = new Map();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.name !== null && !this._byName.has(e.name)) this._byName.set(e.name, i);
      if (e.id !== null && !this._byId.has(e.id)) this._byId.set(e.id, i);
    }
  }

  /**
   * Parse the header and directory of a BSA archive.
   * @param {Blob} blob
   * @param {string} label - file name for error messages
   * @param {number} [expectedType] - NAME_RECORD or NUMBER_RECORD
   */
  static async open(blob, label, expectedType) {
    const size = blob.size;
    if (size < 4) throw new WorldDataError(`${label}: file is too small to be a BSA archive (${size} bytes)`);
    const head = await readBlob(blob, 0, 4);
    const hv = new DataView(head.buffer);
    const count = hv.getInt16(0, true);
    const type = hv.getUint16(2, true);
    if (type !== NAME_RECORD && type !== NUMBER_RECORD) {
      throw new WorldDataError(`${label}: not a BSA archive (directory type 0x${type.toString(16)})`);
    }
    if (expectedType !== undefined && type !== expectedType) {
      throw new WorldDataError(`${label}: unexpected BSA directory type 0x${type.toString(16)}`);
    }
    const entrySize = type === NAME_RECORD ? 18 : 8;
    const dirBytes = entrySize * count;
    if (count <= 0 || dirBytes + 4 > size) {
      throw new WorldDataError(`${label}: invalid BSA directory (count ${count}, file ${size} bytes)`);
    }
    const dir = await readBlob(blob, size - dirBytes, dirBytes);
    const dv = new DataView(dir.buffer);
    const entries = new Array(count);
    let position = 4;
    for (let i = 0; i < count; i++) {
      const at = i * entrySize;
      let name = null;
      let id = null;
      let recSize;
      if (type === NAME_RECORD) {
        let s = '';
        for (let k = 0; k < 14 && dir[at + k] !== 0; k++) s += String.fromCharCode(dir[at + k]);
        name = s.toUpperCase();
        recSize = dv.getInt32(at + 14, true);
      } else {
        id = dv.getUint32(at, true);
        recSize = dv.getInt32(at + 4, true);
      }
      if (recSize < 0) throw new WorldDataError(`${label}: negative record size in directory entry ${i}`);
      entries[i] = { name, id, size: recSize, position };
      position += recSize;
    }
    if (position > size - dirBytes) {
      throw new WorldDataError(`${label}: BSA records overrun the directory (truncated or corrupt file)`);
    }
    return new BsaArchive(blob, label, type, entries);
  }

  get count() {
    return this.entries.length;
  }

  indexOfName(name) {
    const i = this._byName.get(String(name).toUpperCase());
    return i === undefined ? -1 : i;
  }

  indexOfId(id) {
    const i = this._byId.get(id);
    return i === undefined ? -1 : i;
  }

  /** Record bytes as a fresh Uint8Array. */
  async read(index) {
    const e = this.entries[index];
    if (!e) throw new WorldDataError(`${this.label}: record index ${index} out of range`);
    return readBlob(this.blob, e.position, e.size);
  }
}
