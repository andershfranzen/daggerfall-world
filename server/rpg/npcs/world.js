// Operator ARENA2 access for source-backed people. Reads only MAPS.BSA, BLOCKS.BSA, CLIMATE.PAK, FACTION.TXT,
// FLATS.CFG and NAMEGEN.DAT, through the same location/block readers the renderer and the door survey use, so ids,
// positions and buildings agree with portals and town services. Results are small plain objects, cached per
// active location with a bound (the caller evicts idle locations).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { arena2Files, parseTownId } from '../collision/arena2.js';
import { BsaArchive, NAME_RECORD, readBlob } from '../../../client/world/bsa.js';
import { parseRmbFull, parseRdb } from '../../../client/world/interiors/blocks.js';
import { parseRmbFlats } from '../../../client/world/scenery/rmbFlats.js';
import { readDungeon } from '../../../client/world/interiors/dungeonMaps.js';
import { parseLocation, buildingPortalId, exteriorOf, interiorLocation } from '../../../client/world/interiors/index.js';
import { regionIndexOf, climateAt, climateSettings } from '../../../client/world/maps.js';
import { readLocationReplaced, resolveRmbBlock } from '../../../client/world/wilderness/replacements.js';
import { parseFactionText } from '../../../client/gameplay/npcs/factionFile.js';
import { buildingDirectory } from '../../../client/world/interiors/buildingDirectory.js';
import { indexFiles } from '../../../client/world/files.js';
import {
  interiorPeople, exteriorPeople, dungeonPeople, interiorQuestMarkers, dungeonQuestMarkers, readNameBanks, parseFlatsCfg,
  regionFactions, NAMED_BUILDINGS, buildingKey,
} from './people.js';
import { buildNavGrid } from './population.js';

const CACHE = 12;
/** FACTION.TXT The Thieves Guild (42) and The Dark Brotherhood (108): halls stay off public directions (DFU hides them). */
export const SECRET_FACTIONS = new Set([42, 108]);
export const SECRET_ROLES = new Set(['thieves', 'brotherhood', 'witch']);

function dataFile(dir, name) {
  const want = name.toLowerCase();
  let root = dir;
  let names = readdirSync(root);
  if (!names.some((n) => n.toLowerCase() === want)) {
    const sub = names.find((n) => /^arena2$/i.test(n));
    if (sub) {
      root = join(root, sub);
      names = readdirSync(root);
    }
  }
  const f = names.find((n) => n.toLowerCase() === want);
  return f ? join(root, f) : null;
}

/** Static data tables of the install: factions, flats and name banks. Missing files degrade to null. */
export function readTables(dir) {
  const read = (name, enc) => {
    const p = dir && dataFile(dir, name);
    return p ? readFileSync(p, enc) : null;
  };
  let factions = null, flatsCfg = null, banks = null;
  try { const t = read('FACTION.TXT', 'latin1'); if (t) factions = parseFactionText(t); } catch { /* absent or malformed */ }
  try { const t = read('FLATS.CFG', 'latin1'); if (t) flatsCfg = parseFlatsCfg(t); } catch { /* absent */ }
  try { const b = read('NAMEGEN.DAT'); if (b) banks = readNameBanks(b); } catch { /* absent */ }
  return { factions, flatsCfg, banks };
}

/**
 * @param {string} dir ARENA2 directory
 * @param {Promise|object|null} worldData WorldData replacements provider (as for loadTown)
 * @param {{spawnLocal?: (townId) => Promise<{x,z}>}} [hooks] town spawn origin (overland frame or loadTown)
 */
export function createPeopleSource(dir, worldData = null, hooks = {}) {
  const tables = readTables(dir);
  let archivesP = null;
  const archives = () => (archivesP ??= (async () => {
    const files = await arena2Files(dir);
    const byName = (re) => files.find((f) => re.test(f.name));
    const maps = await BsaArchive.open(byName(/^MAPS\.BSA$/i), 'MAPS.BSA', NAME_RECORD);
    const blocks = await BsaArchive.open(byName(/^BLOCKS\.BSA$/i), 'BLOCKS.BSA', NAME_RECORD);
    const climate = byName(/^CLIMATE\.PAK$/i);
    return { files, index: indexFiles(files), maps, blocks, climate, worldData };
  })());

  const locations = new Map(); // town id -> Promise<location info>
  const cache = new Map(); // location id -> Promise<result>
  const remember = (map, key, make) => {
    let job = map.get(key);
    if (job) {
      map.delete(key);
      map.set(key, job);
      return job;
    }
    job = make();
    map.set(key, job);
    job.catch(() => map.delete(key));
    while (map.size > CACHE) map.delete(map.keys().next().value);
    return job;
  };

  /** Location record, its blocks (full + flats + automap) and pooled building data. */
  function locationInfo(townId) {
    return remember(locations, townId, async () => {
      const a = await archives();
      const t = parseTownId(townId);
      if (!t) throw new Error(`${townId} is not a town`);
      const region = regionIndexOf(t.region);
      const loc = await readLocationReplaced(a.maps, region, t.location, a.worldData);
      const blocks = [];
      for (let by = 0; by < loc.height; by++) {
        for (let bx = 0; bx < loc.width; bx++) {
          const r = await resolveRmbBlock(a.blocks, loc.blockNames[by * loc.width + bx], a.worldData);
          if (r.index < 0) throw new Error(`BLOCKS.BSA: block ${loc.blockNames[by * loc.width + bx]} is missing`);
          let full, flats, automap = null, groundTiles = null;
          if (r.block) {
            full = { name: r.name, subRecords: r.block.subRecords, misc3d: r.block.misc3d };
            flats = r.block;
            // Replacement JSON carries no automap; the vanilla block of the same name supplies it when present.
            const v = a.blocks.indexOfName(r.name);
            if (v >= 0 && v < a.blocks.count) automap = readAutomap(await a.blocks.read(v));
            groundTiles = r.block.groundTiles;
          } else {
            const bytes = await a.blocks.read(r.index);
            full = parseRmbFull(bytes, r.name);
            flats = parseRmbFlats(bytes, r.name);
            automap = readAutomap(bytes);
            groundTiles = readGroundTiles(bytes);
          }
          blocks.push({ x: bx, y: by, name: r.name, blockIndex: r.index, full, flats, automap, groundTiles });
        }
      }
      let pooled = new Map();
      try {
        pooled = await buildingDirectory(a, region, loc, (_name, bx, by) => blocks[by * loc.width + bx].full);
      } catch { /* RMB building data stands in, as townServices does */ }
      let climate = null;
      if (a.climate) climate = climateSettings(climateAt(await readBlob(a.climate, 0, a.climate.size), loc.longitude, loc.latitude));
      let dungeon = null;
      try { dungeon = await readDungeon(a.maps, region, loc.index); } catch { dungeon = null; }
      return { townId, region, regionName: t.region, loc, blocks, pooled, climate, dungeon, locationType: await locationTypeOf(a.maps, region, loc.index) };
    });
  }

  const ctxOf = (info) => ({ regionIndex: info.region, locationIndex: info.loc.index, ...tables });

  /** People in one building interior, its quest markers and its building record. */
  function interior(location) {
    return remember(cache, location, async () => {
      const p = parseLocation(location);
      if (!p || p.kind !== 'interior') throw new Error(`${location} is not an interior`);
      const info = await locationInfo(exteriorOf(location));
      const block = info.blocks.find((b) => b.x === p.bx && b.y === p.by);
      const sub = block?.full.subRecords[p.record];
      if (!sub) throw new Error(`${location}: no such building record`);
      const pooled = info.pooled.get(buildingPortalId(p.bx, p.by, p.record));
      const building = { ...sub.building, ...(pooled ?? {}) };
      const people = interiorPeople({ location, sub, bx: p.bx, by: p.by, building, ...ctxOf(info) });
      return { location, building: { ...building, key: buildingKey(p.bx, p.by, p.record) }, people, markers: interiorQuestMarkers(sub) };
    });
  }

  function dungeon(location) {
    return remember(cache, location, async () => {
      const p = parseLocation(location);
      if (!p || p.kind !== 'dungeon') throw new Error(`${location} is not a dungeon`);
      const info = await locationInfo(exteriorOf(location));
      if (!info.dungeon) throw new Error(`${info.loc.name} has no dungeon`);
      const a = await archives();
      const blocks = [];
      for (const b of info.dungeon.blocks) {
        const bi = a.blocks.indexOfName(b.blockName);
        if (bi < 0) throw new Error(`BLOCKS.BSA: dungeon block ${b.blockName} is missing`);
        blocks.push({ x: b.x, z: b.z, rdb: parseRdb(await a.blocks.read(bi), a.blocks.entries[bi].name, bi) });
      }
      return { location, people: dungeonPeople({ location, blocks, ...ctxOf(info) }), markers: dungeonQuestMarkers(blocks) };
    });
  }

  /** Authored exterior people, the navgrid for mobile townspeople, the climate's people and the work list. */
  function town(location) {
    return remember(cache, location, async () => {
      const info = await locationInfo(location);
      const spawnLocal = await (hooks.spawnLocal ? hooks.spawnLocal(location) : Promise.reject(new Error('no spawn origin')));
      const people = exteriorPeople({ location, blocks: info.blocks.map((b) => ({ x: b.x, y: b.y, name: b.name, rmb: b.flats })), spawnLocal, ...ctxOf(info) });
      const nav = buildNavGrid(info.blocks, info.loc.width, info.loc.height, spawnLocal);
      const named = namedBuildingPeople(info);
      return {
        location,
        people,
        nav,
        blocks: info.loc.width * info.loc.height,
        climatePeople: climatePeople(info.climate?.label),
        locationType: info.locationType,
        wandering: hasWanderingPeople(info.locationType),
        regionIndex: info.region,
        work: workCandidates(named),
        residents: residentList(named),
        secretHalls: named.filter(({ building, people }) => SECRET_FACTIONS.has(building.factionId) || people.some((e) => SECRET_ROLES.has(e.role))).map((n) => n.interior),
        buildings: buildingList(info),
      };
    });
  }

  /** People of every named building (the same records and ids the interiors publish). */
  function namedBuildingPeople(info) {
    const out = [];
    const region = regionFactions(tables.factions, info.region);
    const { region: rn, location: ln } = parseLocation(info.townId);
    for (const b of info.blocks) {
      for (const sub of b.full.subRecords) {
        const pooled = info.pooled.get(buildingPortalId(b.x, b.y, sub.index));
        const building = { ...sub.building, ...(pooled ?? {}) };
        if (!NAMED_BUILDINGS.has(building.buildingType)) continue;
        const interior = interiorLocation(rn, ln, b.x, b.y, sub.index);
        out.push({ interior, building, people: interiorPeople({ location: interior, sub, bx: b.x, by: b.y, building, region, ...ctxOf(info) }) });
      }
    }
    return out;
  }

  /** Every person who could offer work (TalkManager.GetBuildingList candidates), before the 1-in-4 roll. */
  function workCandidates(named) {
    const out = [];
    for (const { interior, building, people } of named) {
      for (const person of people) {
        if (!person._workGroup) continue;
        out.push({
          id: person.id, name: person.name, interior, people: person._source.people, group: person._workGroup,
          buildingType: building.buildingType, ...(person.individual ? { individual: person.faction } : {}),
        });
      }
    }
    return out;
  }

  /**
   * Named adults of the named buildings, for "Where is …?" directions. `secret` marks people and halls of the
   * underworld guilds (and witches), which the asker's directions never list.
   */
  function residentList(named) {
    const out = [];
    for (const { interior, building, people } of named) {
      const hallSecret = SECRET_FACTIONS.has(building.factionId) || people.some((e) => SECRET_ROLES.has(e.role));
      for (const e of people) {
        if (e.child || !e.name || e.name === e.title) continue;
        out.push({
          id: e.id, name: e.name, title: e.title, role: e.role, interior, x: e.x, y: e.y, z: e.z,
          buildingType: building.buildingType,
          ...(e.individual ? { individual: e.faction } : {}),
          ...(hallSecret || SECRET_ROLES.has(e.role) || SECRET_FACTIONS.has(e.faction) ? { secret: true } : {}),
        });
      }
    }
    return out;
  }

  function buildingList(info) {
    const out = [];
    for (const b of info.blocks) {
      for (const sub of b.full.subRecords) {
        const pooled = info.pooled.get(buildingPortalId(b.x, b.y, sub.index));
        out.push({ bx: b.x, by: b.y, record: sub.index, people: sub.interior.people.length, ...sub.building, ...(pooled ?? {}) });
      }
    }
    return out;
  }

  return {
    tables,
    interior,
    dungeon,
    town,
    locationInfo,
    evict(location) {
      cache.delete(location);
    },
    get cached() {
      return { locations: locations.size, results: cache.size };
    },
  };
}

/** MAPTABLE DFRegion.LocationTypes of a location (0 city … 14 ships), or -1. */
export async function locationTypeOf(maps, region, index) {
  const i = maps.indexOfName(`MAPTABLE.${String(region).padStart(3, '0')}`);
  if (i < 0) return -1;
  const t = await maps.read(i);
  if ((index + 1) * 17 > t.length) return -1;
  const bits = new DataView(t.buffer, t.byteOffset, t.byteLength).getUint32(index * 17 + 4, true);
  return ((bits * 4) >>> 0) >>> 27;
}

/** StreamingWorld: PopulationManager only for cities, hamlets, villages, farms, manors, temples and taverns. */
export const hasWanderingPeople = (type) => [0, 1, 2, 3, 8, 5, 6].includes(type);

/** RMB FLD automap (64x64 bytes, file order) from a raw block record. */
export function readAutomap(bytes) {
  const BLOCK_POSITIONS_AT = 3;
  const BUILDING_DATA_AT = BLOCK_POSITIONS_AT + 32 * 20;
  const SECTION2_AT = BUILDING_DATA_AT + 32 * 26;
  const BLOCK_SIZES_AT = SECTION2_AT + 32 * 4;
  const GROUND_AT = BLOCK_SIZES_AT + 32 * 4;
  const AUTOMAP_AT = GROUND_AT + 8 + 256 + 256;
  if (bytes.length < AUTOMAP_AT + 4096) return null;
  return bytes.slice(AUTOMAP_AT, AUTOMAP_AT + 4096);
}

/** RMB FLD ground tile bytes (16x16, file order) from a raw block record. */
export function readGroundTiles(bytes) {
  const GROUND_AT = 3 + 32 * 20 + 32 * 26 + 32 * 4 + 32 * 4;
  if (bytes.length < GROUND_AT + 8 + 256) return null;
  return bytes.slice(GROUND_AT + 8, GROUND_AT + 8 + 256);
}

/** MapsFile.GetWorldClimateSettings().People */
const CLIMATE_PEOPLE = { Desert: 'redguard', Rainforest: 'redguard', Mountain: 'nord' };
export const climatePeople = (label) => CLIMATE_PEOPLE[label] ?? 'breton';
