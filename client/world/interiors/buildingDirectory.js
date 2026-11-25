// Named buildings draw their individual seeds, factions and qualities from MAPS.BSA in block order.
// Daggerfall Unity's RMBLayout.GetLocationBuildingData and FormulaHelper.GenerateBuildingName (MIT).
import { readRegionNames } from '../maps.js';
import { parseRmbFull } from './blocks.js';
import { resolveRmbBlock } from '../wilderness/replacements.js';
import { readBlob } from '../bsa.js';
import { parseFactionText } from '../../gameplay/npcs/factionFile.js';
import { parseTextRsc } from '../../gameplay/character/classic.js';
import { dfRandom, readNameBanks } from './nameBanks.js';
import { SHOP_PREFIX, SHOP_SUFFIX, TAVERN_PREFIX, TAVERN_SUFFIX } from './buildingWords.js';

export const NAMED_BUILDINGS = new Set([0, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

/** MAPS.BSA location building list (DFLocation.BuildingData, 26 bytes each). */
export async function locationBuildingList(maps, region, index) {
  const names = await readRegionNames(maps, region);
  const rec = maps.indexOfName(`MAPPITEM.${String(region).padStart(3, '0')}`);
  if (rec < 0) return [];
  const b = await maps.read(rec);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const need = (at, n) => {
    if (at < 0 || at + n > b.length) throw new Error('MAPS.BSA building list overruns MAPPITEM');
  };
  need(index * 4, 4);
  let pos = names.length * 4 + v.getUint32(index * 4, true);
  need(pos, 4);
  pos += 4 + v.getUint32(pos, true) * 6 + 112;
  need(pos, 7);
  const count = v.getUint16(pos, true);
  pos += 7;
  need(pos, count * 26);
  const out = [];
  for (let i = 0; i < count; i++) {
    const at = pos + i * 26;
    out.push({ nameSeed: v.getUint16(at, true), factionId: v.getUint16(at + 18, true), buildingType: b[at + 24], quality: b[at + 25] });
  }
  return out;
}

/**
 * Assigns location-level data to every named RMB building, in DFU's order (block rows, block
 * columns, sub-records). Returns Map portalId -> {quality, nameSeed, factionId}.
 */
export async function pooledBuildingData(data, loc, list, blockAt = null) {
  async function readBlock(name) {
    const r = await resolveRmbBlock(data.blocks, name, data.worldData);
    return r.index < 0 ? null : r.block ?? parseRmbFull(await data.blocks.read(r.index), r.name);
  }
  const pool = list.filter((b) => NAMED_BUILDINGS.has(b.buildingType)).map((b) => ({ ...b, used: false }));
  const out = new Map();
  for (let by = 0; by < loc.height; by++) {
    for (let bx = 0; bx < loc.width; bx++) {
      const name = loc.blockNames[by * loc.width + bx];
      const rmb = blockAt ? await blockAt(name, bx, by) : await readBlock(name);
      if (!rmb) continue;
      for (const sub of rmb.subRecords) {
        const t = sub.building.buildingType;
        if (!NAMED_BUILDINGS.has(t)) continue;
        const item = pool.find((p) => !p.used && p.buildingType === t);
        if (item) item.used = true;
        const { quality, nameSeed, factionId } = item ?? sub.building;
        const entry = { buildingType: t, quality, nameSeed, factionId };
        // Classic assigns the Raven chapterhouse after consuming the original building's pool entry.
        if (sub.houseFile === 'KRAVE01.HS2') {
          entry.buildingType = 11;
          entry.factionId = 414;
        }
        out.set(`b:${bx},${by}:${sub.index}`, entry);
      }
    }
  }
  return out;
}

const ROYAL_TITLES = ['Lord', 'King', 'Queen', 'Duke', 'Duchess', 'Marquis', 'Marquise', 'Count', 'Countess', 'Baron', 'Baroness', 'Lord', 'Lady'];
const CASTLE_RECORDS = new Map([['Daggerfall', 475], ['Wayrest', 476], ['Sentinel', 477]]);

// These files are optional for the geometry reader. A partial installation still gets usable door labels.
async function namingTables(index) {
  async function read(name, parse) {
    const file = index.get(name);
    if (!file) return null;
    try { return parse(await readBlob(file, 0, file.size)); } catch { return null; }
  }
  const [banks, factions, text] = await Promise.all([
    read('NAMEGEN.DAT', readNameBanks),
    read('FACTION.TXT', bytes => parseFactionText(new TextDecoder('windows-1252').decode(bytes))),
    read('TEXT.RSC', parseTextRsc),
  ]);
  const temples = new Map(), rulers = new Map();
  for (const f of factions?.values() ?? []) {
    if (!temples.has(f.parent)) temples.set(f.parent, f.name);
    if (f.type === 7) rulers.set(f.region, ROYAL_TITLES[f.ruler] ?? 'Lord');
  }
  return { banks, factions, text, temples, rulers };
}

/** The English classic name, or null if a required record is absent. No shared RNG state. */
export function classicBuildingName(type, building, region, loc, tables) {
  if (type === 3) return loc.regionName ? `The Bank of ${loc.regionName}` : null;
  if (type === 11) return tables.factions?.get(building.factionId)?.name || null;
  if (type === 14) return tables.temples.get(building.factionId) || null;
  if (type === 16) {
    const id = CASTLE_RECORDS.get(loc.name);
    return id ? tables.text?.text(id)?.trim().replace(/\.$/, '') || null : null;
  }

  const suffixes = type === 15 ? TAVERN_SUFFIX : SHOP_SUFFIX[type];
  if (!suffixes || !Number.isInteger(building.nameSeed)) return null;
  const rng = dfRandom(building.nameSeed);
  const pick = list => list[rng.rand() % list.length];
  // Classic draws the suffix first. Changing this order renames every inn.
  const suffix = pick(suffixes);
  let prefix = pick(type === 15 ? TAVERN_PREFIX : SHOP_PREFIX);
  if (prefix.includes('%ef')) {
    // The original DOS shop macro always used the male Breton bank, even in Hammerfell.
    const bank = tables.banks?.[0];
    if (!bank?.[0]?.length || !bank[1]?.length) return null;
    rng.rand();
    prefix = prefix.replace('%ef', pick(bank[0]) + pick(bank[1]));
  }
  return prefix.replace('%cn', loc.displayName || loc.name).replace('%rt', tables.rulers.get(region) ?? 'Lord') + ' ' + suffix;
}

/** One directory for a town's door survey, interiors, NPCs and counters. */
export async function buildingDirectory(data, region, loc, blockAt) {
  let list = loc.buildings;
  if (!list) {
    try { list = await locationBuildingList(data.maps, region, loc.index); } catch { list = []; }
  }
  data.namingTables ??= namingTables(data.index);
  const [tables, directory] = await Promise.all([data.namingTables, pooledBuildingData(data, loc, list, blockAt)]);
  for (const b of directory.values()) b.name = classicBuildingName(b.buildingType, b, region, loc, tables);
  return directory;
}
