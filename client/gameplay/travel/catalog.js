// World catalogue for travel: every MAPS.BSA location with its classic map pixel,
// location type and discovered flag, plus CLIMATE.PAK / POLITIC.PAK lookups.
// Pure module with no DOM; the server (server/rpg/travel.js) and the browser map
// panel (client/gameplay/travel.js) import the same code so both agree on names,
// coordinates and terrain.
//
// Record layouts follow Daggerfall Unity's API/MapsFile.cs (ReadMapTable,
// LongitudeLatitudeToMapPixel, GetClimateIndex, GetPoliticIndex), API/PakFile.cs
// and API/DFRegion.cs (MIT, (c) 2009-2023 Daggerfall Workshop). The BSA reader is
// client/world/bsa.js (adapted from daggerfall-js-source, MIT). Notices:
// client/gameplay/travel/NOTICES.txt and client/world/THIRD_PARTY_NOTICES.txt.
//
// No game data lives here. Everything is read from the player's or operator's files.

import { BsaArchive, NAME_RECORD, readBlob } from '../../world/bsa.js';
import { REGION_NAMES, locationId, foldName as fold, classicTownId } from '../../world/maps.js';
import { WorldDataError } from '../../world/errors.js';
import { parseWildernessId } from '../../world/wilderness/data.js';

export { REGION_NAMES, WorldDataError, locationId };

/** World map size in map pixels (MapsFile.MaxMapPixelX/Y). */
export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 500;

/** DFRegion.LocationTypes, in classic order. */
export const LOCATION_TYPES = Object.freeze([
  { id: 'city', label: 'City' }, // 0 TownCity
  { id: 'hamlet', label: 'Hamlet' }, // 1 TownHamlet
  { id: 'village', label: 'Village' }, // 2 TownVillage
  { id: 'farm', label: 'Farmstead' }, // 3 HomeFarms
  { id: 'labyrinth', label: 'Labyrinth' }, // 4 DungeonLabyrinth
  { id: 'temple', label: 'Temple' }, // 5 ReligionTemple
  { id: 'tavern', label: 'Tavern' }, // 6 Tavern
  { id: 'keep', label: 'Keep' }, // 7 DungeonKeep
  { id: 'wealthy', label: 'Manor' }, // 8 HomeWealthy
  { id: 'cult', label: 'Shrine' }, // 9 ReligionCult
  { id: 'ruin', label: 'Ruin' }, // 10 DungeonRuin
  { id: 'poor', label: 'Cottage' }, // 11 HomePoor
  { id: 'graveyard', label: 'Graveyard' }, // 12 Graveyard
  { id: 'coven', label: 'Coven' }, // 13 Coven
  { id: 'ships', label: 'Your ship' }, // 14 HomeYourShips
]);

/** Classic map dot palette indices into FMAP_PAL.COL (DaggerfallTravelMapWindow locationPixelColors). */
export const DOT_PALETTE_INDEX = Object.freeze({
  labyrinth: 237, keep: 240, ruin: 243, graveyard: 246, coven: 0, farm: 53, wealthy: 51, poor: 55,
  temple: 96, cult: 101, tavern: 39, city: 33, hamlet: 35, village: 37,
});

/** Climate values (MapsFile.Climates). */
export const CLIMATE = Object.freeze({
  OCEAN: 223, DESERT: 224, DESERT2: 225, MOUNTAIN: 226, RAINFOREST: 227, SWAMP: 228,
  SUBTROPICAL: 229, MOUNTAIN_WOODS: 230, WOODLANDS: 231, HAUNTED_WOODLANDS: 232,
});

export const CLIMATE_LABELS = Object.freeze({
  223: 'Ocean', 224: 'Desert', 225: 'Desert', 226: 'Mountains', 227: 'Rainforest', 228: 'Swamp',
  229: 'Subtropical', 230: 'Mountain woods', 231: 'Woodlands', 232: 'Haunted woodlands',
});

/** MapsFile.LongitudeLatitudeToMapPixel. */
export function mapPixelOf(longitude, latitude) {
  return { x: Math.trunc(longitude / 128), y: MAP_HEIGHT - 1 - Math.trunc(latitude / 128) };
}

// ---------------------------------------------------------------------------- location ids

const ID_PREFIX = 'town:';

/**
 * Parse `town:Region/Location`. Region names never contain '/', so the first '/' splits.
 * Returns null for other prefixes (`building:`, `dungeon:` belong to the interiors feature).
 */
export function parseLocationId(id) {
  if (typeof id !== 'string' || !id.startsWith(ID_PREFIX) || id.length > 120) return null;
  const rest = id.slice(ID_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1 || rest.includes('/', slash + 1)) return null;
  return { region: rest.slice(0, slash), location: rest.slice(slash + 1) };
}

export const isTownId = (id) => parseLocationId(id) !== null;

/** The classic travel calculator works in map pixels, including departures on foot in the wilderness. */
export function wildernessOrigin(id, politic) {
  const pixel = parseWildernessId(id);
  if (!pixel) return null;
  const { px: x, py: y } = pixel;
  const regionIndex = (politic?.atMapPixel(x, y) ?? 0) - 128;
  return { id, x, y, regionIndex, region: REGION_NAMES[regionIndex] ?? '' };
}

/**
 * Political region name of any place address, or null when it cannot be told yet:
 * town/interior/dungeon addresses name their region (numeric record addresses included);
 * a wilderness pixel uses POLITIC.PAK, then the catalogue record standing in that pixel.
 * `world` is readWorld()'s {catalog, politic} (null while the map data loads).
 */
export function regionOfPlace(location, world = null) {
  if (typeof location !== 'string') return null;
  const pixel = parseWildernessId(location);
  if (pixel) {
    const fromPak = world?.politic ? wildernessOrigin(location, world.politic)?.region : '';
    if (fromPak) return fromPak;
    return world?.catalog?.atPixel?.(pixel.px, pixel.py)?.region ?? null;
  }
  const m = /^(?:town|dungeon|interior|building):([^/]+)\//.exec(location);
  if (!m) return null;
  return /^\d+$/.test(m[1]) ? REGION_NAMES[Number(m[1])] ?? null : m[1];
}

/** CLIMATE.PAK value for a town or wilderness address, or null without the installed map. */
export function climateOfPlace(location, world) {
  if (!world?.climate) return null;
  const pixel = parseWildernessId(location);
  if (pixel) return world.climate.atMapPixel(pixel.px, pixel.py);
  const town = parseLocationId(location) ? world.catalog.get(location) : null;
  return town ? world.climate.atMapPixel(town.x, town.y) : null;
}

// ---------------------------------------------------------------------------- PAK files

/**
 * A decoded PAK map (CLIMATE.PAK, POLITIC.PAK): 1001 x 500 bytes, RLE rows of
 * (u16 count, u8 value) behind a u32 row-offset table (PakFile.cs).
 */
export class PakMap {
  constructor(bytes, label) {
    const W = 1001, H = 500;
    if (bytes.length < H * 4) throw new WorldDataError(`${label}: file is truncated`);
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const data = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      let at = v.getUint32(y * 4, true);
      let x = 0;
      while (x < W) {
        if (at + 3 > bytes.length) throw new WorldDataError(`${label}: row ${y} is truncated`);
        const count = v.getUint16(at, true);
        const value = bytes[at + 2];
        at += 3;
        if (count === 0) throw new WorldDataError(`${label}: zero-length run in row ${y}`);
        data.fill(value, y * W + x, Math.min(W, x + count) + y * W);
        x += count;
      }
    }
    this.width = W;
    this.height = H;
    this.data = data;
    this.label = label;
  }

  /** PakFile.GetValue, clamped to the map. */
  value(x, y) {
    const cx = Math.min(this.width - 1, Math.max(0, x | 0));
    const cy = Math.min(this.height - 1, Math.max(0, y | 0));
    return this.data[cy * this.width + cx];
  }

  /** MapsFile.GetClimateIndex / GetPoliticIndex: +1 on x to line up with the height map. */
  atMapPixel(x, y) {
    return this.value(x + 1, y);
  }
}

// ---------------------------------------------------------------------------- catalogue

const cstr = (bytes, at, max) => {
  let s = '';
  for (let i = 0; i < max && at + i < bytes.length && bytes[at + i] !== 0; i++) s += String.fromCharCode(bytes[at + i]);
  return s;
};

/**
 * Read every region's MAPNAMES + MAPTABLE from MAPS.BSA.
 * @param {Blob} mapsBlob  MAPS.BSA
 * @returns {Promise<Catalog>}
 */
export async function readCatalog(mapsBlob, worldData = null) {
  const maps = await BsaArchive.open(mapsBlob, 'MAPS.BSA', NAME_RECORD);
  const provider = await worldData;
  const replacements = (await provider?.index())?.locations ?? [];
  const namesBySlot = new Map(replacements.map(l => [`${l.region}/${l.index}`, l.name]));
  const locations = [];
  for (let region = 0; region < REGION_NAMES.length; region++) {
    const suffix = String(region).padStart(3, '0');
    const ni = maps.indexOfName(`MAPNAMES.${suffix}`);
    const ti = maps.indexOfName(`MAPTABLE.${suffix}`);
    if (ni < 0 || ti < 0) continue; // a few region slots are empty in classic data
    if (maps.entries[ni].size < 4 || maps.entries[ti].size === 0) continue;
    const names = await maps.read(ni);
    const count = new DataView(names.buffer, names.byteOffset).getUint32(0, true);
    if (4 + count * 32 > names.length) throw new WorldDataError(`MAPS.BSA: MAPNAMES.${suffix} is truncated`);
    const table = await maps.read(ti);
    if (count * 17 > table.length) throw new WorldDataError(`MAPS.BSA: MAPTABLE.${suffix} is truncated`);
    const tv = new DataView(table.buffer, table.byteOffset, table.byteLength);
    for (let i = 0; i < count; i++) {
      const name = cstr(names, 4 + i * 32, 32);
      if (!name) continue;
      const t = i * 17;
      const mapId = tv.getInt32(t, true);
      const bits = tv.getUint32(t + 4, true);
      const longitude = (bits & 0x1ffffff) >>> 8;
      const type = ((bits * 4) >>> 0) >>> 27;
      const discovered = ((bits >>> 24) & 0x40) !== 0;
      const latitude = (tv.getInt32(t + 8, true) & 0xffffff) >>> 8;
      const px = mapPixelOf(longitude, latitude);
      locations.push({
        sourceName: name,
        region: REGION_NAMES[region],
        regionIndex: region,
        index: i,
        name: namesBySlot.get(`${region}/${i}`) ?? name,
        mapId,
        type: LOCATION_TYPES[type]?.id ?? 'unknown',
        dungeonType: table[t + 12], // DFRegion.DungeonTypes (0-16 carry quest markers; 255 = none)
        discovered,
        longitude,
        latitude,
        x: px.x,
        y: px.y,
      });
    }
  }
  if (!locations.length) throw new WorldDataError('MAPS.BSA contains no locations');
  return new Catalog(locations, 'files');
}

export class Catalog {
  /**
   * @param {object[]} locations
   * @param {'files'|'classic'} source  'classic' = built-in starter list (no MAPS.BSA on the server)
   */
  constructor(locations, source) {
    this.source = source;
    this.byId = new Map();
    this.bySlot = new Map();
    this.byPixel = new Map();
    this.byName = new Map();
    const sourceNames = new Set();
    this.locations = locations.map(record => {
      const sourceName = record.sourceName ?? record.name;
      const legacy = fold(locationId(record.region, sourceName));
      const first = !sourceNames.has(legacy);
      sourceNames.add(legacy);
      const slotId = locationId(record.regionIndex, record.index);
      const id = classicTownId(record.regionIndex, record.index, sourceName, first);
      const entry = { ...record, sourceName, slotId, id };
      this.byId.set(id, entry);
      this.bySlot.set(slotId, entry);
      this.byPixel.set(`${record.x},${record.y}`, entry);
      return entry;
    });
    // Source aliases take precedence over a replacement with another record's original name.
    for (const field of ['sourceName', 'name']) {
      for (const entry of this.locations) {
        const key = fold(locationId(entry.region, entry[field]));
        const matches = this.byName.get(key) ?? [];
        if (!matches.includes(entry)) matches.push(entry);
        this.byName.set(key, matches);
      }
    }
    this.regions = [...new Set(locations.map(l => l.region))];
  }

  get size() {
    return this.locations.length;
  }

  at(regionIndex, index) {
    return this.bySlot.get(locationId(regionIndex, index)) ?? null;
  }

  atPixel(x, y) {
    return this.byPixel.get(`${x},${y}`) ?? null;
  }

  /** Numeric addresses are exact. An ambiguous old name uses its own saved slot or map pixel, else first match. */
  get(id, hint = null) {
    if (typeof id !== 'string') return null;
    const key = fold(id);
    const slot = this.bySlot.get(key);
    if (slot) return slot;
    const matches = this.byName.get(key);
    if (!matches) return null;
    if (hint && matches.length > 1) {
      const exact = this.at(hint.regionIndex, hint.index ?? hint.locationIndex) ?? this.atPixel(hint.x ?? hint.px, hint.y ?? hint.py);
      if (matches.includes(exact)) return exact;
    }
    return matches[0];
  }

  ambiguous(entry) {
    return this.byName.get(fold(locationId(entry.region, entry.name)))?.length > 1;
  }

  inRegion(region) {
    return this.locations.filter((l) => l.region === region);
  }

  /**
   * Name search over the given entries (default all), best first: exact, prefix,
   * word prefix, substring. `limit` caps the result.
   */
  search(query, { limit = 30, filter = null } = {}) {
    const q = fold(query).trim();
    if (!q) return [];
    const scored = [];
    for (const l of this.locations) {
      if (filter && !filter(l)) continue;
      const n = fold(l.name);
      const original = fold(l.sourceName);
      let s;
      if (n === q || original === q) s = 0;
      else if (n.startsWith(q) || original.startsWith(q)) s = 1;
      else if ([n, original].some(name => name.split(/[\s'-]+/).some(w => w.startsWith(q)))) s = 2;
      else if (n.includes(q) || original.includes(q)) s = 3;
      else if (fold(l.region).startsWith(q)) s = 4;
      else continue;
      scored.push([s, l]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name) || a[1].regionIndex - b[1].regionIndex || a[1].index - b[1].index);
    return scored.slice(0, limit).map(([, l]) => l);
  }
}

/** Load MAPS.BSA and both PAK maps from an index of File/Blob by upper-case name. */
export async function readWorld(index, worldData = null) {
  const need = ['MAPS.BSA', 'CLIMATE.PAK', 'POLITIC.PAK'];
  const missing = need.filter((n) => !index.has(n));
  if (missing.length) throw new WorldDataError(`Daggerfall data not found: ${missing.join(', ')}`);
  const [catalog, climateBytes, politicBytes] = await Promise.all([
    readCatalog(index.get('MAPS.BSA'), worldData),
    readBlob(index.get('CLIMATE.PAK'), 0, index.get('CLIMATE.PAK').size),
    readBlob(index.get('POLITIC.PAK'), 0, index.get('POLITIC.PAK').size),
  ]);
  return {
    catalog,
    climate: new PakMap(climateBytes, 'CLIMATE.PAK'),
    politic: new PakMap(politicBytes, 'POLITIC.PAK'),
  };
}
