// BLOCKS.BSA RMB (exterior city block) reader.
//
// Layout follows Daggerfall Unity's API/BlocksFile.cs (MIT, (c) 2009-2023
// Daggerfall Workshop) as also translated in daggerfall-js-source
// src/formats/blocksFile.js (MIT, (c) 2026 Lattymoy). Only exterior models and
// ground tiles are decoded; interiors, flats, people and doors are skipped.
// See client/world/THIRD_PARTY_NOTICES.txt.

import { WorldDataError } from './errors.js';

const FLD_COUNTS = 3;
const BLOCK_POSITIONS_AT = FLD_COUNTS; // 32 x 20 bytes
const BUILDING_DATA_AT = BLOCK_POSITIONS_AT + 32 * 20; // 32 x 26 bytes
const SECTION2_AT = BUILDING_DATA_AT + 32 * 26; // 32 x 4 bytes
const BLOCK_SIZES_AT = SECTION2_AT + 32 * 4; // 32 x int32
const GROUND_AT = BLOCK_SIZES_AT + 32 * 4; // 8-byte header, 256 tiles, 256 scenery
const AUTOMAP_AT = GROUND_AT + 8 + 256 + 256; // 64 x 64
const NAMES_AT = AUTOMAP_AT + 64 * 64; // 13 + 32 x 13
const BLOCK_DATA_AT = NAMES_AT + 13 + 32 * 13;

const MODEL_RECORD_SIZE = 66;
const FLAT_RECORD_SIZE = 17;
const SECTION3_RECORD_SIZE = 16;
const PEOPLE_RECORD_SIZE = 17;
const DOOR_RECORD_SIZE = 19;

/** BlocksFile.ReadRmbModelRecords for `count` records at `pos`. */
function readModels(v, pos, count, label) {
  const out = [];
  for (let i = 0; i < count; i++) {
    if (pos + MODEL_RECORD_SIZE > v.byteLength) throw new WorldDataError(`${label}: model record overruns block`);
    const id1 = v.getInt16(pos, true);
    const id2 = v.getUint8(pos + 2);
    out.push({
      modelId: id1 * 100 + id2,
      objectType: v.getUint8(pos + 3),
      // +4..+23 unknowns/nulls, +24..+35 XPos1/YPos1/ZPos1 (unused by DFU)
      xPos: v.getInt32(pos + 36, true),
      yPos: v.getInt32(pos + 40, true),
      zPos: v.getInt32(pos + 44, true),
      yRotation: v.getInt16(pos + 52, true),
    });
    pos += MODEL_RECORD_SIZE;
  }
  return { models: out, pos };
}

/**
 * Parse an RMB block.
 * @returns {{name, groundTiles: Uint8Array, subRecords: [{xPos,zPos,yRotation,models}], misc3d}}
 *   groundTiles holds the 16x16 raw tile bitfields in file order (row-major, row 0 first).
 */
export function parseRmb(bytes, name) {
  const label = `BLOCKS.BSA ${name}`;
  if (bytes.length < BLOCK_DATA_AT) throw new WorldDataError(`${label}: record is too short for an RMB block`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numBlockData = bytes[0];
  const numMisc3d = bytes[1];
  const numMiscFlat = bytes[2];
  if (numBlockData > 32) throw new WorldDataError(`${label}: invalid sub-record count ${numBlockData}`);

  const groundTiles = bytes.slice(GROUND_AT + 8, GROUND_AT + 8 + 256);

  const subRecords = [];
  let position = BLOCK_DATA_AT;
  for (let i = 0; i < numBlockData; i++) {
    const bp = BLOCK_POSITIONS_AT + i * 20;
    const sub = {
      xPos: v.getInt32(bp + 8, true),
      zPos: v.getInt32(bp + 12, true),
      yRotation: v.getInt32(bp + 16, true),
      models: [],
    };
    // Exterior sub-record header: five u8 counts + six int16.
    if (position + 17 > bytes.length) throw new WorldDataError(`${label}: sub-record ${i} overruns block`);
    const n3d = bytes[position];
    const { models, pos: flatsAt } = readModels(v, position + 17, n3d, label);
    sub.models = models;
    // Editor start markers (TEXTURE.199 record 10) among the exterior flats: where DFU's
    // RandomStartMarker places an arrival in a block without streets (the two "Your Ship" decks).
    const nFlat = bytes[position + 1];
    if (nFlat && flatsAt + nFlat * FLAT_RECORD_SIZE <= bytes.length) {
      for (let k = 0; k < nFlat; k++) {
        const f = flatsAt + k * FLAT_RECORD_SIZE;
        const bits = v.getUint16(f + 12, true);
        if (bits >> 7 !== 199 || (bits & 0x7f) !== 10) continue;
        (sub.startMarkers ??= []).push({ xPos: v.getInt32(f, true), yPos: v.getInt32(f + 4, true), zPos: v.getInt32(f + 8, true) });
      }
    }
    subRecords.push(sub);
    const size = v.getInt32(BLOCK_SIZES_AT + i * 4, true);
    if (size <= 0) throw new WorldDataError(`${label}: invalid sub-record size ${size}`);
    position += size;
  }
  if (position > bytes.length) throw new WorldDataError(`${label}: sub-records overrun block`);
  const { models: misc3d } = readModels(v, position, numMisc3d, label);
  if (position + numMisc3d * MODEL_RECORD_SIZE + numMiscFlat * FLAT_RECORD_SIZE > bytes.length) {
    throw new WorldDataError(`${label}: misc records overrun block`);
  }
  return { name, groundTiles, subRecords, misc3d };
}

/** BlocksFile.CheckName: exact name, else the last block with the same 4-char prefix and 6-char suffix. */
export function resolveBlockIndex(blocksBsa, name) {
  const i = blocksBsa.indexOfName(name);
  if (i >= 0) return i;
  const prefix = name.slice(0, 4);
  const suffix = name.slice(-6);
  let found = -1;
  for (let k = 0; k < blocksBsa.count; k++) {
    const n = blocksBsa.entries[k].name;
    if (n.startsWith(prefix) && n.endsWith(suffix)) found = k;
  }
  return found;
}

// Exported for synthetic tests.
export const RMB_LAYOUT = Object.freeze({
  BLOCK_POSITIONS_AT,
  BLOCK_SIZES_AT,
  GROUND_AT,
  BLOCK_DATA_AT,
  MODEL_RECORD_SIZE,
  FLAT_RECORD_SIZE,
  SECTION3_RECORD_SIZE,
  PEOPLE_RECORD_SIZE,
  DOOR_RECORD_SIZE,
});
