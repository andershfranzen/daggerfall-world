// MAPS.BSA dungeon records (MAPDITEM.nnn) for one location.
//
// Adapted from daggerfall-js-source src/formats/mapsFile.js (MIT, (c) 2026 Lattymoy) `_readLocationRecordElement`
// and `_readMapDItem`, translations of Daggerfall Unity's API/MapsFile.cs ReadLocationRecordElement / ReadMapDItem
// (MIT, (c) 2009-2023 Daggerfall Workshop), including the Orsinium border-block repair.
// See THIRD_PARTY_NOTICES.txt.

import { WorldDataError } from '../errors.js';
import { readRegionNames, resolveLocationIndex, REGION_NAMES } from '../maps.js';

export const RDB_BLOCK_LETTERS = ['N', 'W', 'L', 'S', 'B', 'M'];

const cstr = (bytes, at, max) => {
  let s = '';
  for (let i = 0; i < max && at + i < bytes.length && bytes[at + i] !== 0; i++) s += String.fromCharCode(bytes[at + i]);
  return s;
};

async function regionRecord(maps, kind, region) {
  const name = `${kind}.${String(region).padStart(3, '0')}`;
  const i = maps.indexOfName(name);
  if (i < 0) throw new WorldDataError(`MAPS.BSA: record ${name} is missing`);
  return maps.read(i);
}

/** The exterior LocationRecordElementHeader's locationId of a named location. */
async function exteriorLocationId(maps, region, index, names) {
  const p = await regionRecord(maps, 'MAPPITEM', region);
  const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
  if ((index + 1) * 4 > p.length) throw new WorldDataError('MAPS.BSA: MAPPITEM offset table is truncated');
  let pos = names.length * 4 + v.getUint32(index * 4, true);
  if (pos + 4 > p.length) throw new WorldDataError('MAPS.BSA: MAPPITEM record overruns');
  pos += 4 + v.getUint32(pos, true) * 6;
  if (pos + 112 > p.length) throw new WorldDataError('MAPS.BSA: MAPPITEM record overruns');
  return v.getUint16(pos + 33, true);
}

/**
 * Read a location's dungeon block grid. Returns null when the location has no dungeon.
 * @returns {Promise<null|{name, region, regionName, locationId, dungeonType, dungeonName, blocks: Array<{x,z,blockName,isStartingBlock}>}>}
 */
export async function readDungeon(maps, region, locationName) {
  const names = await readRegionNames(maps, region);
  const index = resolveLocationIndex(names, region, locationName);
  const locationId = await exteriorLocationId(maps, region, index, names);
  // MapsFile.ReadMapTable: 17 bytes per location; byte 12 is DFRegion.DungeonTypes (255 = none).
  const table = await regionRecord(maps, 'MAPTABLE', region);
  if ((index + 1) * 17 > table.length) throw new WorldDataError('MAPS.BSA: MAPTABLE is truncated');
  const dungeonType = table[index * 17 + 12];

  const d = await regionRecord(maps, 'MAPDITEM', region);
  if (d.length < 4) return null;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const count = v.getUint32(0, true);
  if (4 + count * 8 > d.length) throw new WorldDataError('MAPS.BSA: MAPDITEM offset table is truncated');
  let offset = -1;
  for (let i = 0; i < count; i++) {
    if (v.getUint16(4 + i * 8 + 6, true) === locationId) {
      offset = v.getUint32(4 + i * 8, true);
      break;
    }
  }
  if (offset < 0) return null;
  let pos = 4 + count * 8 + offset;
  const need = (n) => {
    if (pos + n > d.length) throw new WorldDataError(`MAPS.BSA: dungeon of "${names[index]}" overruns MAPDITEM`);
  };
  need(4);
  pos += 4 + v.getUint32(pos, true) * 6;
  need(112);
  const dungeonName = cstr(d, pos + 71, 32);
  const ownId = v.getUint16(pos + 33, true);
  pos += 112;
  need(17);
  const blockCount = v.getUint16(pos + 10, true);
  pos += 17;
  need(blockCount * 4);
  const blocks = [];
  for (let i = 0; i < blockCount; i++, pos += 4) {
    const bits = v.getUint16(pos + 2, true);
    const letter = RDB_BLOCK_LETTERS[bits >> 11];
    if (!letter) throw new WorldDataError(`MAPS.BSA: dungeon of "${names[index]}" names an unknown block type ${bits >> 11}`);
    blocks.push({
      x: v.getInt8(pos),
      z: v.getInt8(pos + 1),
      isStartingBlock: (bits & 0x400) !== 0,
      blockName: `${letter}${String(bits & 0x3ff).padStart(7, '0')}.RDB`,
    });
  }
  // MapsFile: Orsinium's border block overlaps another one; classic moves it.
  if (ownId === 50015 && blocks[13]) blocks[13].z = -2;
  if (!blocks.some((b) => b.isStartingBlock)) {
    throw new WorldDataError(`MAPS.BSA: dungeon of "${names[index]}" has no starting block`);
  }
  return { name: names[index], region, index, regionName: REGION_NAMES[region], locationId, dungeonLocationId: ownId, dungeonType, dungeonName: dungeonName || names[index], blocks };
}
