// RMB exterior flat records and ground scenery, laid out in the town's output space.
//
// Record layout follows Daggerfall Unity's API/BlocksFile.cs (ReadRmbFldHeader,
// ReadRmbGroundSceneryData, ReadRmbBlockSubRecord, ReadRmbFlatObjectRecords) and
// placement follows Utility/RMBLayout.cs (AddNatureFlats, AddLights,
// AddMiscBlockFlats, AddExteriorBlockFlats), MIT, (c) 2009-2023 Daggerfall
// Workshop. The JavaScript reading style follows daggerfall-js-source
// src/formats/blocksFile.js (MIT, (c) 2026 Lattymoy). See THIRD_PARTY_NOTICES.txt
// in this directory.

import { WorldDataError } from '../errors.js';
import { RMB_LAYOUT } from '../blocks.js';

export const SCALE = 0.025; // metres per native unit (MeshReader.GlobalScale)
const RMB_DIMENSION = 4096;
export const BLOCK_SIZE = RMB_DIMENSION * SCALE; // 102.4 m
const TILE_DIMENSION = 256; // native units per ground tile
const BLOCK_FLATS_OFFSET_Y = -6; // RMBLayout.blockFlatsOffsetY (native)
const NATURE_FLATS_OFFSET_Y = -2; // RMBLayout.natureFlatsOffsetY (native)

export const EDITOR_ARCHIVE = 199; // TextureReader.EditorFlatsTextureArchive
export const ANIMALS_ARCHIVE = 201; // TextureReader.AnimalsTextureArchive
export const LIGHTS_ARCHIVE = 210; // TextureReader.LightsTextureArchive
/** RDBLayout.NPCFlatArchives: people billboards. These belong to the NPC/actor systems, not static scenery. */
export const NPC_ARCHIVES = new Set([334, 346, 357, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184]);
export const isNatureArchive = (a) => a >= 500 && a <= 511;

/** MaterialReader.GetFlatType, with people separated out. */
export function flatKind(archive) {
  if (archive === LIGHTS_ARCHIVE) return 'light';
  if (archive === EDITOR_ARCHIVE) return 'editor';
  if (archive === ANIMALS_ARCHIVE) return 'animal';
  if (isNatureArchive(archive)) return 'nature';
  if (NPC_ARCHIVES.has(archive)) return 'person';
  return 'decoration';
}

function readFlats(v, pos, count, label) {
  const out = [];
  for (let i = 0; i < count; i++) {
    if (pos + RMB_LAYOUT.FLAT_RECORD_SIZE > v.byteLength) throw new WorldDataError(`${label}: flat record overruns block`);
    const bitfield = v.getUint16(pos + 12, true);
    out.push({
      position: pos, // byte offset in the block record (DFU flat record Position; NPC name seeds)
      xPos: v.getInt32(pos, true),
      yPos: v.getInt32(pos + 4, true),
      zPos: v.getInt32(pos + 8, true),
      archive: bitfield >> 7,
      record: bitfield & 0x7f,
      factionId: v.getInt16(pos + 14, true),
      flags: v.getUint8(pos + 16),
    });
    pos += RMB_LAYOUT.FLAT_RECORD_SIZE;
  }
  return out;
}

/**
 * Parse the flat-related parts of an RMB block.
 * @returns {{name, scenery: Uint8Array, subRecords: [{xPos,zPos,yRotation,flats}], miscFlats}}
 *   `scenery` is the raw 16x16 ground-scenery bitfield array in file order (row-major, row 0 first).
 */
export function parseRmbFlats(bytes, name) {
  const label = `BLOCKS.BSA ${name}`;
  const { BLOCK_POSITIONS_AT, BLOCK_SIZES_AT, GROUND_AT, BLOCK_DATA_AT, MODEL_RECORD_SIZE, FLAT_RECORD_SIZE } = RMB_LAYOUT;
  if (bytes.length < BLOCK_DATA_AT) throw new WorldDataError(`${label}: record is too short for an RMB block`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numBlockData = bytes[0];
  const numMisc3d = bytes[1];
  const numMiscFlat = bytes[2];
  if (numBlockData > 32) throw new WorldDataError(`${label}: invalid sub-record count ${numBlockData}`);
  const scenery = bytes.slice(GROUND_AT + 8 + 256, GROUND_AT + 8 + 512);

  const subRecords = [];
  let position = BLOCK_DATA_AT;
  for (let i = 0; i < numBlockData; i++) {
    const bp = BLOCK_POSITIONS_AT + i * 20;
    if (position + 17 > bytes.length) throw new WorldDataError(`${label}: sub-record ${i} overruns block`);
    const n3d = bytes[position];
    const nFlat = bytes[position + 1];
    const flats = readFlats(v, position + 17 + n3d * MODEL_RECORD_SIZE, nFlat, label);
    subRecords.push({
      xPos: v.getInt32(bp + 8, true),
      zPos: v.getInt32(bp + 12, true),
      yRotation: v.getInt32(bp + 16, true),
      flats,
    });
    const size = v.getInt32(BLOCK_SIZES_AT + i * 4, true);
    if (size <= 0) throw new WorldDataError(`${label}: invalid sub-record size ${size}`);
    position += size;
  }
  const miscAt = position + numMisc3d * MODEL_RECORD_SIZE;
  if (miscAt + numMiscFlat * FLAT_RECORD_SIZE > bytes.length) throw new WorldDataError(`${label}: misc flat records overrun block`);
  const miscFlats = readFlats(v, miscAt, numMiscFlat, label);
  return { name, scenery, subRecords, miscFlats };
}

/** BlocksFile.ReadRmbGroundSceneryData: texture record of a scenery bitfield, -1 when empty. */
export const sceneryRecord = (bits) => (bits < 255 ? Math.floor(bits / 4) - 1 : -1);

/**
 * Lay out the static flats of a town in the output space of loadTown (x east,
 * y up, -z north, origin at the spawn). People (non-zero faction ids and NPC
 * archives) and editor markers are excluded; they are not static scenery.
 *
 * @param {Array<{x:number,y:number,rmb:ReturnType<typeof parseRmbFlats>}>} blocks - block grid coordinates
 * @param {{x:number,z:number}} spawnLocal - town.source.spawnLocal (DFU Unity space, metres)
 * @param {number} natureArchive - climate nature archive (500-511)
 * @returns {{flats: Array<{archive,record,kind,x,y,z,source}>, skipped: {people:number, editor:number}}}
 *   x/y/z is the billboard's base centre: the bottom edge sits at y.
 */
export function layoutTownFlats(blocks, spawnLocal, natureArchive) {
  const flats = [];
  const skipped = { people: 0, editor: 0 };
  const toOut = (ux, uy, uz) => [ux - spawnLocal.x, uy, -(uz - spawnLocal.z)];
  const push = (archive, record, ux, uy, uz, source) => {
    const [x, y, z] = toOut(ux, uy, uz);
    flats.push({ archive, record, kind: flatKind(archive), x, y, z, source });
  };
  for (const b of blocks) {
    const ox = b.x * BLOCK_SIZE, oz = b.y * BLOCK_SIZE;
    // AddNatureFlats: one per scenery tile, at the tile's north-west corner.
    for (let ty = 0; ty < 16; ty++) {
      for (let tx = 0; tx < 16; tx++) {
        const record = sceneryRecord(b.rmb.scenery[(15 - ty) * 16 + tx]);
        if (record < 1) continue;
        push(natureArchive, record, ox + tx * TILE_DIMENSION * SCALE, NATURE_FLATS_OFFSET_Y * SCALE,
          oz + (ty * TILE_DIMENSION + TILE_DIMENSION) * SCALE, 'scenery');
      }
    }
    // AddLights + AddMiscBlockFlats.
    for (const f of b.rmb.miscFlats) {
      if (f.archive === EDITOR_ARCHIVE) { skipped.editor++; continue; }
      if (f.factionId !== 0 || NPC_ARCHIVES.has(f.archive)) { skipped.people++; continue; }
      push(f.archive, f.record, ox + f.xPos * SCALE, (-f.yPos + BLOCK_FLATS_OFFSET_Y) * SCALE,
        oz + (f.zPos + RMB_DIMENSION) * SCALE, 'misc');
    }
    // AddExteriorBlockFlats: sub-record offset (XPos, 0, -ZPos), no sub-record yaw.
    for (const sub of b.rmb.subRecords) {
      for (const f of sub.flats) {
        if (f.archive === EDITOR_ARCHIVE) { skipped.editor++; continue; }
        if (f.factionId !== 0 || NPC_ARCHIVES.has(f.archive)) { skipped.people++; continue; }
        let archive = f.archive;
        let uy = (-f.yPos + BLOCK_FLATS_OFFSET_Y) * SCALE;
        if (isNatureArchive(archive)) {
          // DFU swaps to the climate's nature set and assigns natureFlatsOffsetY to the z
          // component; we apply it to the height, keeping the record's own x/z.
          archive = natureArchive;
          uy = NATURE_FLATS_OFFSET_Y * SCALE;
        }
        push(archive, f.record, ox + (f.xPos + sub.xPos) * SCALE, uy,
          oz + (f.zPos + RMB_DIMENSION - sub.zPos) * SCALE, 'exterior');
      }
    }
  }
  return { flats, skipped };
}
