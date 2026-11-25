// Real bank and repair counters of a town, read from the operator's ARENA2 directory.
//
// Reuses the shared world loaders rather than duplicating them:
//   - client/world/town.js loadTown()            spawn origin of the town's output space (same as collision)
//   - client/world/interiors/index.js            locationPortals(): every enterable building door, in output space
//   - client/world/interiors/blocks.js           parseRmbFull(): per-block building data
// Building quality and name seed follow RMBLayout.GetLocationBuildingData in Daggerfall Unity
// (MIT, (c) 2009-2023 Daggerfall Workshop): named buildings take their data, in order, from the
// location's MAPS.BSA building list.
import { arena2Files, parseTownId } from '../collision/arena2.js';
import { loadTown } from '../../../client/world/town.js';
import { openWorldData, locationPortals } from '../../../client/world/interiors/index.js';
import { REGION_NAMES } from '../../../client/world/maps.js';
export { pooledBuildingData, locationBuildingList } from '../../../client/world/interiors/buildingDirectory.js';
import { SERVICE_BUILDINGS } from '../../../client/gameplay/townServices/rules.js';

const ROMAN = ['', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII', ' IX', ' X'];
const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Pure step: turn locationPortals() output into service counters.
 * @param {{buildings: Array}} portals
 * @param {Map<string, {quality:number}>} [pooled]
 */
export function countersFromPortals(portals, pooled = new Map()) {
  const counters = [];
  const seen = new Map();
  for (const b of portals.buildings || []) {
    const def = SERVICE_BUILDINGS[b.buildingType];
    if (!def || !Array.isArray(b.doors) || !b.doors.length) continue;
    const n = (seen.get(def.type) ?? 0) + 1;
    seen.set(def.type, n);
    const pool = pooled.get(b.portalId);
    const quality = Math.max(1, Math.min(20, Math.trunc(pool?.quality ?? b.quality) || 10));
    counters.push({
      id: b.portalId,
      kind: 'building',
      type: def.type,
      buildingType: b.buildingType,
      regionIndex: portals.regionIndex,
      services: [...def.services],
      name: b.name || `${def.label}${ROMAN[n - 1] ?? ` ${n}`}`,
      quality,
      interior: b.target ?? null,
      doors: b.doors.map((d) => ({ x: r2(d.x), z: r2(d.z) })),
    });
  }
  return counters;
}

/** DFLocation.BuildingTypes HouseForSale (1) and House1-House4 (17-20): the residences a bank can sell. */
const HOUSE_TYPES = new Set([1, 17, 18, 19, 20]);

/**
 * Package 13: residences of a town for DaggerfallBankManager house sales. Each keeps its portal id, interior,
 * building type, a street door and the radius of its building model (the price base).
 */
export function housesFromPortals(portals) {
  const out = [];
  for (const b of portals.buildings || []) {
    if (!HOUSE_TYPES.has(b.buildingType) || !(b.radius > 0) || !b.target) continue;
    out.push({ id: b.portalId, buildingType: b.buildingType, interior: b.target, radius: Math.round(b.radius * 1000) / 1000,
      door: b.doors?.[0] ? { x: r2(b.doors[0].x), z: r2(b.doors[0].z) } : null });
  }
  return out;
}

/**
 * Loader for the town-services feature: resolves `{counters, source}` for a `town:` id, or
 * rejects with a readable reason. Archives are opened once and reused; the decoded town mesh
 * is dropped as soon as its spawn origin is known.
 */
export function arena2ServiceLoader(dataPath, worldData = null) {
  let files = null;
  let data = null;
  return async (location) => {
    if (!dataPath) throw new Error('no game data is configured on this server');
    const town = parseTownId(location);
    if (!town) throw new Error(`${location} is not a town`);
    files ??= await arena2Files(dataPath);
    data ??= await openWorldData(files, { worldData });
    const t = await loadTown(files, { ...town, worldData });
    const spawnLocal = t.source.spawnLocal;
    const regionIndex = t.source.regionIndex;
    const portals = await locationPortals(data, { region: regionIndex, location: t.source.locationIndex }, spawnLocal);
    data.rmb?.clear?.(); // per-town block cache; meshes stay cached in data.lib
    return {
      counters: countersFromPortals(portals), source: `ARENA2 ${REGION_NAMES[regionIndex]}/${portals.name}`,
      port: portals.port === true, houses: housesFromPortals(portals),
      // BuildingDirectory.GetHousesForSale divides every building of the location by ten, not only named ones.
      buildingCount: portals.buildings.length, regionIndex,
    };
  };
}
