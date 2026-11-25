// MAPS.BSA location reader and CLIMATE.PAK lookup.
//
// Layout follows Daggerfall Unity's API/MapsFile.cs and API/PakFile.cs (MIT,
// (c) 2009-2023 Daggerfall Workshop) as also translated in daggerfall-js-source
// src/formats/mapsFile.js (MIT, (c) 2026 Lattymoy). Only the exterior fields a
// town layout needs are decoded. See client/world/THIRD_PARTY_NOTICES.txt.
//
// MAPS.BSA is a NameRecord BSA with four records per region:
//   MAPPITEM.nnn  location records (u32 offset table, then records)
//   MAPDITEM.nnn  dungeon records (unused here)
//   MAPTABLE.nnn  17 bytes per location: i32 mapId, u32 longitude bits, i32 latitude bits, u8, u32
//   MAPNAMES.nnn  u32 count, then 32-byte NUL-padded names

import { WorldDataError } from './errors.js';

export const REGION_NAMES = [
  "Alik'r Desert", 'Dragontail Mountains', 'Glenpoint Foothills', 'Daggerfall Bluffs',
  'Yeorth Burrowland', 'Dwynnen', 'Ravennian Forest', 'Devilrock',
  'Malekna Forest', 'Isle of Balfiera', 'Bantha', "Dak'fron",
  'Islands in the Western Iliac Bay', 'Tamarilyn Point', 'Lainlyn Cliffs', 'Bjoulsae River',
  'Wrothgarian Mountains', 'Daggerfall', 'Glenpoint', 'Betony', 'Sentinel', 'Anticlere', 'Lainlyn', 'Wayrest',
  'Gen Tem High Rock village', 'Gen Rai Hammerfell village', 'Orsinium Area', 'Skeffington Wood',
  'Hammerfell bay coast', 'Hammerfell sea coast', 'High Rock bay coast', 'High Rock sea coast',
  'Northmoor', 'Menevia', 'Alcaire', 'Koegria', 'Bhoriane', 'Kambria', 'Phrygias', 'Urvaius',
  'Ykalon', 'Daenia', 'Shalgora', 'Abibon-Gora', 'Kairou', 'Pothago', 'Myrkwasa', 'Ayasofya',
  'Tigonus', 'Kozanset', 'Satakalaam', 'Totambu', 'Mournoth', 'Ephesus', 'Santaki', 'Antiphyllos',
  'Bergama', 'Gavaudon', 'Tulune', 'Glenumbra Moors', 'Ilessan Hills', 'Cybiades',
];

/** Both named legacy addresses and numeric slot addresses enter the same readers. */
export function regionIndexOf(region) {
  const index = typeof region === 'number' || /^\d+$/.test(region)
    ? Number(region) : REGION_NAMES.findIndex(n => n.toLowerCase() === String(region).toLowerCase());
  if (!Number.isInteger(index) || !REGION_NAMES[index]) throw new WorldDataError(`Unknown region "${region}"`);
  return index;
}

export const foldName = value => String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export const locationId = (region, location) => `town:${region}/${location}`;

/** Preserve historic instance keys (also used for deterministic NPCs) wherever the name was addressable. */
export function classicTownId(region, index, sourceName, first) {
  return first ? locationId(REGION_NAMES[region], sourceName) : locationId(region, index);
}

/** MAPNAMES ordinal, never a name round trip when the caller supplied a slot. */
export function resolveLocationIndex(names, region, address) {
  const index = typeof address === 'number' || /^\d+$/.test(address)
    ? Number(address) : names.findIndex(n => foldName(n) === foldName(address));
  if (!Number.isInteger(index) || index < 0 || index >= names.length) {
    throw new WorldDataError(`MAPS.BSA: no location "${address}" in region ${REGION_NAMES[region] ?? region}`);
  }
  return index;
}

const RMB_PREFIXES = [
  'TVRN', 'GENR', 'RESI', 'WEAP', 'ARMR', 'ALCH', 'BANK', 'BOOK',
  'CLOT', 'FURN', 'GEMS', 'LIBR', 'PAWN', 'TEMP', 'TEMP', 'PALA',
  'FARM', 'DUNG', 'CAST', 'MANR', 'SHRI', 'RUIN', 'SHCK', 'GRVE',
  'FILL', 'KRAV', 'KDRA', 'KOWL', 'KMOO', 'KCAN', 'KFLA', 'KHOR',
  'KROS', 'KWHE', 'KSCA', 'KHAW', 'MAGE', 'THIE', 'DARK', 'FIGH',
  'CUST', 'WALL', 'MARK', 'SHIP', 'WITC',
];
const LETTER2 = ['A', 'L', 'M', 'S'];

const cstr = (bytes, at, max) => {
  let s = '';
  for (let i = 0; i < max && at + i < bytes.length && bytes[at + i] !== 0; i++) s += String.fromCharCode(bytes[at + i]);
  return s;
};

/** MapsFile.ResolveRmbBlockName. */
export function resolveRmbBlockName(blockIndex, blockNumber, blockCharacter, letter1ForRmbName) {
  const prefix = RMB_PREFIXES[blockIndex];
  if (prefix === undefined) throw new WorldDataError(`MAPS.BSA: invalid RMB block index ${blockIndex}`);
  const letter1 = blockCharacter & 0x10 ? String.fromCharCode(letter1ForRmbName) : 'A';
  const letter2 = LETTER2[((2 * blockCharacter) & 0xff) >> 6];
  const numbers =
    blockIndex === 13 || blockIndex === 14
      ? String.fromCharCode((blockCharacter & 0xf) + 65) + String(blockNumber)
      : String(blockNumber).padStart(2, '0');
  return `${prefix}${letter1}${letter2}${numbers}.RMB`;
}

async function regionRecord(maps, kind, region) {
  const name = `${kind}.${String(region).padStart(3, '0')}`;
  const i = maps.indexOfName(name);
  if (i < 0) throw new WorldDataError(`MAPS.BSA: record ${name} is missing`);
  return maps.read(i);
}

/** Location names of a region. */
export async function readRegionNames(maps, region) {
  const b = await regionRecord(maps, 'MAPNAMES', region);
  if (b.length < 4) return [];
  const n = new DataView(b.buffer, b.byteOffset).getUint32(0, true);
  if (4 + n * 32 > b.length) throw new WorldDataError(`MAPS.BSA: MAPNAMES.${String(region).padStart(3, '0')} is truncated`);
  const names = [];
  for (let k = 0; k < n; k++) names.push(cstr(b, 4 + k * 32, 32));
  return names;
}

/**
 * Read a location's exterior layout.
 * @returns {{name, region, regionName, index, mapId, longitude, latitude, width, height, blockNames: string[]}}
 */
export async function readLocation(maps, region, locationName) {
  const names = await readRegionNames(maps, region);
  const index = resolveLocationIndex(names, region, locationName);
  const name = names[index];

  const table = await regionRecord(maps, 'MAPTABLE', region);
  if ((index + 1) * 17 > table.length) throw new WorldDataError('MAPS.BSA: MAPTABLE is truncated');
  const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const t = index * 17;
  const mapId = tv.getInt32(t, true);
  const longitude = (tv.getUint32(t + 4, true) & 0x1ffffff) >> 8;
  const latitude = (tv.getInt32(t + 8, true) & 0xffffff) >> 8;
  // DFRegion.LocationTypes (0 city … 14 ships): bits 27-31 of the longitude word after the 2-bit shift.
  const locationType = ((tv.getUint32(t + 4, true) * 4) >>> 0) >>> 27;

  const p = await regionRecord(maps, 'MAPPITEM', region);
  const pv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const need = (at, n) => {
    if (at < 0 || at + n > p.length) throw new WorldDataError(`MAPS.BSA: location "${locationName}" record overruns MAPPITEM`);
  };
  need(index * 4, 4);
  let pos = names.length * 4 + pv.getUint32(index * 4, true);
  need(pos, 4);
  const doorCount = pv.getUint32(pos, true);
  pos += 4 + doorCount * 6;
  need(pos, 112);
  const recordName = cstr(p, pos + 71, 32);
  pos += 112; // LocationRecordElementHeader
  need(pos, 7);
  const buildingCount = pv.getUint16(pos, true);
  pos += 7 + buildingCount * 26;
  need(pos, 32 + 4 + 4 + 2 + 4 + 3 + 192);
  pos += 32; // AnotherName
  pos += 4; // MapId
  pos += 4; // LocationId
  const width = p[pos];
  const height = p[pos + 1];
  pos += 2 + 4;
  const letter1 = p[pos];
  const portTown = p[pos + 1]; // ExteriorData.PortTownAndUnknown: nonzero where the bank sells ships
  pos += 3;
  const blockIndex = p.subarray(pos, pos + 64);
  const blockNumber = p.subarray(pos + 64, pos + 128);
  const blockCharacter = p.subarray(pos + 128, pos + 192);
  if (width < 1 || height < 1 || width * height > 64) {
    throw new WorldDataError(`MAPS.BSA: location "${locationName}" has invalid exterior size ${width}x${height}`);
  }
  const blockNames = [];
  for (let i = 0; i < width * height; i++) {
    blockNames.push(resolveRmbBlockName(blockIndex[i], blockNumber[i], blockCharacter[i], letter1));
  }
  return {
    name,
    locationType,
    townId: classicTownId(region, index, name, index === resolveLocationIndex(names, region, name)),
    recordName,
    region,
    regionName: REGION_NAMES[region],
    index,
    mapId,
    longitude,
    latitude,
    width,
    height,
    blockNames,
    portTown,
  };
}

/** Decode CLIMATE.PAK (1001x500 RLE rows) and return the climate value at a location. */
export function climateAt(pakBytes, longitude, latitude) {
  const W = 1001;
  const H = 500;
  const v = new DataView(pakBytes.buffer, pakBytes.byteOffset, pakBytes.byteLength);
  const mapX = Math.trunc(longitude / 128);
  const mapY = 499 - Math.trunc(latitude / 128);
  if (mapX < 0 || mapX >= W || mapY < 0 || mapY >= H) throw new WorldDataError('CLIMATE.PAK: location outside map');
  if (H * 4 > pakBytes.length) throw new WorldDataError('CLIMATE.PAK: file is truncated');
  let at = v.getUint32(mapY * 4, true);
  let x = 0;
  while (x < W) {
    if (at + 3 > pakBytes.length) throw new WorldDataError('CLIMATE.PAK: row data is truncated');
    const count = v.getUint16(at, true);
    const value = pakBytes[at + 2];
    at += 3;
    if (count === 0) throw new WorldDataError('CLIMATE.PAK: zero-length run');
    if (mapX < x + count) return value;
    x += count;
  }
  throw new WorldDataError('CLIMATE.PAK: row too short');
}

/** MapsFile.GetWorldClimateSettings: climate base (archive hundreds) and ground archive. */
export function climateSettings(worldClimate) {
  switch (worldClimate) {
    case 223: return { climateBase: 400, groundArchive: 402, label: 'Ocean' };
    case 224:
    case 225: return { climateBase: 0, groundArchive: 2, label: 'Desert' };
    case 226: return { climateBase: 100, groundArchive: 102, label: 'Mountain' };
    case 227: return { climateBase: 400, groundArchive: 402, label: 'Rainforest' };
    case 228: return { climateBase: 400, groundArchive: 402, label: 'Swamp' };
    case 229: return { climateBase: 0, groundArchive: 2, label: 'Subtropical' };
    case 230: return { climateBase: 300, groundArchive: 102, label: 'MountainWoods' };
    case 231: return { climateBase: 300, groundArchive: 302, label: 'Woodlands' };
    case 232: return { climateBase: 300, groundArchive: 302, label: 'HauntedWoodlands' };
    default: return { climateBase: 300, groundArchive: 302, label: 'Default' };
  }
}
