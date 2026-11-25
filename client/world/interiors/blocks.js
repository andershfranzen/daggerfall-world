// BLOCKS.BSA readers for building interiors (RMB sub-records) and dungeon blocks (RDB).
//
// Adapted from daggerfall-js-source src/formats/blocksFile.js (MIT, (c) 2026 Lattymoy), itself a translation of
// Daggerfall Unity's API/BlocksFile.cs (MIT, (c) 2009-2023 Daggerfall Workshop): ReadRmbFldHeader,
// ReadRmbBlockData, ReadRmbBlockSubRecord, ReadRmbModelRecords, ReadRmbFlatObjectRecords, ReadRdbHeader,
// ReadRdbModelReferenceList, ReadRdbObjectSectionRootList, ReadRdbObjects, ReadRdbModelResource,
// ReadRdbFlatResource and FixRdbData. Only the fields this game uses are kept. See THIRD_PARTY_NOTICES.txt.
//
// Every read is bounds-checked; a malformed record throws WorldDataError instead of returning partial data.

import { WorldDataError } from '../errors.js';

export const ROTATION_DIVISOR = 5.68888888888889;
export const RDB_TYPE = Object.freeze({ Model: 0x01, Light: 0x02, Flat: 0x03 });

const BLOCK_POSITIONS_AT = 3;
const BUILDING_DATA_AT = BLOCK_POSITIONS_AT + 32 * 20;
const BUILDING_DATA_SIZE = 26;
const SECTION2_AT = BUILDING_DATA_AT + 32 * BUILDING_DATA_SIZE;
const BLOCK_SIZES_AT = SECTION2_AT + 32 * 4;
const GROUND_AT = BLOCK_SIZES_AT + 32 * 4;
const AUTOMAP_AT = GROUND_AT + 8 + 256 + 256;
const NAMES_AT = AUTOMAP_AT + 64 * 64;
const BLOCK_DATA_AT = NAMES_AT + 13 + 32 * 13;

function reader(bytes, label) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (at, n, what) => {
    if (!(at >= 0) || at + n > bytes.length) throw new WorldDataError(`${label}: ${what} overruns the record`);
  };
  return { v, need };
}

function readModels(r, pos, count) {
  r.need(pos, count * 66, 'model records');
  const out = [];
  for (let i = 0; i < count; i++, pos += 66) {
    const id1 = r.v.getInt16(pos, true);
    out.push({
      modelId: id1 * 100 + r.v.getUint8(pos + 2),
      objectType: r.v.getUint8(pos + 3),
      xPos: r.v.getInt32(pos + 36, true),
      yPos: r.v.getInt32(pos + 40, true),
      zPos: r.v.getInt32(pos + 44, true),
      yRotation: r.v.getInt16(pos + 52, true),
    });
  }
  return { list: out, pos };
}

function readFlats(r, pos, count) {
  r.need(pos, count * 17, 'flat records');
  const out = [];
  for (let i = 0; i < count; i++, pos += 17) {
    const bits = r.v.getUint16(pos + 12, true);
    out.push({
      position: pos, // byte offset in the block record (DFU RmbBlockPeopleRecord.Position; NPC name seeds)
      xPos: r.v.getInt32(pos, true),
      yPos: r.v.getInt32(pos + 4, true),
      zPos: r.v.getInt32(pos + 8, true),
      archive: bits >> 7,
      record: bits & 0x7f,
      factionId: r.v.getInt16(pos + 14, true),
      flags: r.v.getUint8(pos + 16),
    });
  }
  return { list: out, pos };
}

/** BlocksFile.ReadRmbBlockSubRecord: header (5 counts + 6 shorts), models, flats, section3, people, doors. */
function readSubRecord(r, pos) {
  r.need(pos, 17, 'sub-record header');
  const bytes = r.v;
  const n3d = bytes.getUint8(pos);
  const nFlat = bytes.getUint8(pos + 1);
  const nSec3 = bytes.getUint8(pos + 2);
  const nPeople = bytes.getUint8(pos + 3);
  const nDoor = bytes.getUint8(pos + 4);
  pos += 17;
  const models = readModels(r, pos, n3d);
  const flats = readFlats(r, models.pos, nFlat);
  pos = flats.pos;
  r.need(pos, nSec3 * 16, 'section 3 records');
  pos += nSec3 * 16;
  const people = readFlats(r, pos, nPeople);
  pos = people.pos;
  r.need(pos, nDoor * 19, 'door records');
  const doors = [];
  for (let i = 0; i < nDoor; i++, pos += 19) {
    doors.push({
      xPos: r.v.getInt32(pos, true),
      yPos: r.v.getInt32(pos + 4, true),
      zPos: r.v.getInt32(pos + 8, true),
      yRotation: r.v.getInt16(pos + 12, true),
      openRotation: r.v.getInt16(pos + 14, true),
      doorModelIndex: r.v.getUint8(pos + 16),
    });
  }
  return { sub: { models: models.list, flats: flats.list, people: people.list, doors }, pos };
}

/** DFLocation.BuildingData (26 bytes): only the fields shown to players. */
function readBuilding(v, pos) {
  return {
    nameSeed: v.getUint16(pos, true),
    factionId: v.getUint16(pos + 18, true),
    sector: v.getInt16(pos + 20, true),
    buildingType: v.getUint8(pos + 24),
    quality: v.getUint8(pos + 25),
  };
}

/**
 * Parse an RMB block with both the exterior and the interior of every building sub-record.
 * @returns {{name, subRecords: Array<{index,xPos,zPos,yRotation,building,exterior,interior}>, misc3d: Array}}
 */
export function parseRmbFull(bytes, name) {
  const label = `BLOCKS.BSA ${name}`;
  const r = reader(bytes, label);
  r.need(0, BLOCK_DATA_AT, 'RMB header');
  const count = bytes[0];
  if (count > 32) throw new WorldDataError(`${label}: invalid sub-record count ${count}`);
  const subRecords = [];
  let position = BLOCK_DATA_AT;
  for (let i = 0; i < count; i++) {
    const bp = BLOCK_POSITIONS_AT + i * 20;
    const ext = readSubRecord(r, position);
    const int = readSubRecord(r, ext.pos);
    subRecords.push({
      index: i,
      houseFile: cstr(bytes, NAMES_AT + 13 + i * 13, 13),
      xPos: r.v.getInt32(bp + 8, true),
      zPos: r.v.getInt32(bp + 12, true),
      yRotation: r.v.getInt32(bp + 16, true),
      building: readBuilding(r.v, BUILDING_DATA_AT + i * BUILDING_DATA_SIZE),
      exterior: ext.sub,
      interior: int.sub,
    });
    const size = r.v.getInt32(BLOCK_SIZES_AT + i * 4, true);
    if (size <= 0) throw new WorldDataError(`${label}: invalid sub-record size ${size}`);
    position += size;
  }
  const misc3d = readModels(r, position, bytes[1]).list;
  return { name, subRecords, misc3d };
}

const cstr = (bytes, at, len) => {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = bytes[at + i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
};

/**
 * Parse an RDB dungeon block: the 750-entry model reference list and every object (models, flats, lights) of every
 * root list. Applies DFU's FixRdbData repairs when `blockIndex` names a repaired block.
 * @returns {{name, width, height, modelReferences: Array<{modelId,description}>, objects: Array<object>}}
 */
export function parseRdb(bytes, name, blockIndex = -1) {
  const label = `BLOCKS.BSA ${name}`;
  const r = reader(bytes, label);
  r.need(0, 20 + 750 * 12 + 512, 'RDB header');
  const width = r.v.getUint32(4, true);
  const height = r.v.getUint32(8, true);
  const rootOffset = r.v.getUint32(12, true);
  if (width * height > 64) throw new WorldDataError(`${label}: invalid object grid ${width}x${height}`);
  const modelReferences = [];
  for (let i = 0; i < 750; i++) {
    const at = 20 + i * 8;
    const id = cstr(bytes, at, 5);
    modelReferences.push({ modelId: /^\d+$/.test(id) ? Number.parseInt(id, 10) : 0, description: cstr(bytes, at + 5, 3) });
  }
  const expectRoot = 20 + 750 * 8 + 750 * 4 + 512;
  if (rootOffset !== expectRoot) throw new WorldDataError(`${label}: object root offset ${rootOffset} does not follow the header`);
  r.need(rootOffset, width * height * 4, 'object root list');

  const roots = [];
  for (let i = 0; i < width * height; i++) {
    const start = r.v.getInt32(rootOffset + i * 4, true);
    const list = [];
    let pos = start;
    const seen = new Set();
    while (pos >= 0) {
      if (seen.has(pos)) throw new WorldDataError(`${label}: object list loops`);
      seen.add(pos);
      r.need(pos, 25, 'object');
      const obj = {
        position: pos,
        index: list.length,
        root: i,
        xPos: r.v.getInt32(pos + 8, true),
        yPos: r.v.getInt32(pos + 12, true),
        zPos: r.v.getInt32(pos + 16, true),
        type: r.v.getUint8(pos + 20),
      };
      const res = r.v.getUint32(pos + 21, true);
      if (obj.type === RDB_TYPE.Model) {
        r.need(res, 23, 'model resource');
        obj.model = {
          xRotation: r.v.getInt32(res, true),
          yRotation: r.v.getInt32(res + 4, true),
          zRotation: r.v.getInt32(res + 8, true),
          modelIndex: r.v.getUint16(res + 12, true),
          triggerFlagStartingLock: r.v.getUint32(res + 14, true),
          soundIndex: r.v.getUint8(res + 18),
          actionOffset: r.v.getInt32(res + 19, true),
        };
        if (obj.model.modelIndex >= 750) throw new WorldDataError(`${label}: model index ${obj.model.modelIndex} out of range`);
        const at = obj.model.actionOffset;
        if (at > 0) {
          r.need(at, 10, 'model action');
          obj.model.action = {
            axis: r.v.getUint8(at),
            duration: r.v.getUint16(at + 1, true),
            magnitude: r.v.getUint16(at + 3, true),
            nextOffset: r.v.getInt32(at + 5, true),
            opcode: r.v.getUint8(at + 9),
          };
        }
      } else if (obj.type === RDB_TYPE.Flat) {
        r.need(res, 11, 'flat resource');
        const bits = r.v.getUint16(res, true);
        obj.flat = {
          position: res, // DFU RdbFlatResource.Position (NPC name seeds)
          archive: bits >> 7,
          record: bits & 0x7f,
          flags: r.v.getUint16(res + 2, true),
          magnitude: r.v.getUint8(res + 4),
          soundIndex: r.v.getUint8(res + 5),
          nextOffset: r.v.getInt32(res + 6, true),
          action: r.v.getUint8(res + 10),
        };
      } else if (obj.type === RDB_TYPE.Light) {
        r.need(res, 10, 'light resource');
        obj.light = { radius: r.v.getUint16(res + 8, true) };
      } else {
        throw new WorldDataError(`${label}: unknown object type ${obj.type}`);
      }
      list.push(obj);
      pos = r.v.getInt32(pos, true);
    }
    roots.push(list);
  }
  const block = { name, width, height, modelReferences, roots };
  fixRdbData(block, blockIndex);
  block.objects = block.roots.flat();
  return block;
}

const extraModel = (root, xPos, yPos, zPos, modelIndex, yRotation) => ({
  position: 0, index: -1, root, xPos, yPos, zPos, type: RDB_TYPE.Model,
  model: { xRotation: 0, yRotation, zRotation: 0, modelIndex, triggerFlagStartingLock: 0, soundIndex: 0, actionOffset: 0 },
});

/** BlocksFile.FixRdbData, verbatim repairs that keep classic dungeons connected. */
function fixRdbData(rdb, block) {
  const R = rdb.roots;
  const at = (root, i) => {
    const o = R[root]?.[i];
    if (!o) throw new WorldDataError(`${rdb.name}: expected object ${root}/${i} for DFU's repair is missing`);
    return o;
  };
  if (block === 994) {
    at(4, 18).model.modelIndex = 10;
    at(4, 18).xPos = 640;
    at(5, 8).model.modelIndex = 11;
  } else if (block === 945 || block === 946) {
    R[2] = [];
  } else if (block === 958) {
    at(0, 36).yPos = -300;
  } else if (block === 975) {
    at(0, 24).xPos = 543;
  } else if (block === 1025) {
    let wall = 0;
    for (let i = 0; i < rdb.modelReferences.length; i++) {
      if (rdb.modelReferences[i].modelId === 0) {
        rdb.modelReferences[i] = { modelId: 72100, description: 'DOR' };
        wall = i;
        break;
      }
    }
    const corner = at(5, 39);
    corner.xPos += 64;
    corner.zPos -= 64;
    corner.model.modelIndex = 35;
    corner.model.yRotation = -512;
    const exit = at(8, 0);
    exit.xPos = corner.xPos;
    exit.zPos = corner.zPos + 126;
    const start = at(4, 5);
    start.xPos = corner.xPos;
    start.zPos = corner.zPos;
    R[8] = [...R[8], extraModel(8, corner.xPos, corner.yPos, corner.zPos + 128, wall, -512)];
  } else if (block === 1034) {
    at(4, 38).model.modelIndex = 10;
    at(4, 38).model.yRotation = -512;
    at(5, 40).model.modelIndex = 10;
    at(5, 40).model.yRotation = -2560;
    R[6] = [...R[6], extraModel(6, 1152, -1792, 1920, 11, -512)];
    at(2, 0).model.modelIndex = 23;
  } else if (block === 1036) {
    at(4, 15).model.modelIndex = 5;
    at(5, 34).model.modelIndex = 7;
    at(5, 34).model.yRotation = -512;
    R[5] = [...R[5], extraModel(5, 1152, -384, 1408, 4, 512)];
  }
}
