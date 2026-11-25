// Daggerfall Unity "WorldData" replacements (as shipped by World of Daggerfall) -> the existing loader structures.
//
// DOM- and Node-neutral. Nothing here reads files: callers hand in JSON text (server: the operator's installed pack;
// browser: same-origin descriptors from GET /api/wilderness/worlddata/..., or the player's own copy of the pack in
// their selected folder) and get back plain, bounded objects in the shapes client/world/blocks.js parseRmb(),
// client/world/interiors/blocks.js parseRmbFull() and client/world/scenery/rmbFlats.js parseRmbFlats() return.
// No mod data is copied into this repository.
//
// Semantics follow Daggerfall Unity's Utility/AssetInjection/WorldDataReplacement.cs, API/BlocksFile.cs,
// API/MapsFile.cs and API/DFBlock.cs (MIT, (c) 2009-2023 Daggerfall Workshop), written independently from them:
//   - `<BLOCKNAME>.json` (for example `ALCHAS00.RMB.json`) replaces the whole DFBlock whose resolved name is
//     BLOCKNAME. Resolution order is BlocksFile.GetBlockIndex/GetBlock: exact BLOCKS.BSA name, then a new block
//     that only exists as JSON, then the BSA prefix/suffix alternate (CheckName). The replacement keeps the BSA index.
//   - `location-<region>-<index>.json` replaces MAPS.BSA location <index> of region <region> (MapsFile.ReadLocation);
//     the region's MAPNAMES entry still finds it, and its JSON Name becomes the location's name.
//   - Arrays are authoritative: DFU never reads FldHeader.Num*Records for JSON blocks (they are often stale).
//   - Ground tiles/scenery are flattened row-major (y outer, x inner), the file order, by DFBlock.RmbGroundDataConverter.
// Not supported (none are present in World of Daggerfall 0.4.0): variants (`-<variant>.json`), building replacements
// (`<block>-<n>-building<r>.json`), `locationnew-*` additions, `region-*.json` and RDB/RDI blocks.

import { WorldDataError } from '../errors.js';
import { readLocation, REGION_NAMES } from '../maps.js';
import { resolveBlockIndex } from '../blocks.js';

export const WORLDDATA_VERSION = 1;
/** Hard limits on untrusted JSON (the largest WoD 0.4.0 file is 288 KB; models per list peak at 277). */
export const WORLDDATA_LIMITS = Object.freeze({
  fileBytes: 2 * 1024 * 1024,
  files: 128,
  subRecords: 32,
  models: 2048,
  flats: 2048,
  section3: 2048,
  people: 512,
  doors: 256,
  blockNames: 64,
  totalModels: 16384,
});

const BLOCK_NAME_RE = /^[A-Z0-9_]{1,16}\.RMB$/;
const BLOCK_FILE_RE = /^([A-Za-z0-9_]{1,16}\.RMB)\.json$/i;
const LOCATION_FILE_RE = /^location-(\d{1,2})-(\d{1,5})\.json$/i;
const NAME_RE = /^[^/:#\u0000-\u001f]{1,64}$/;

/** DFLocation.BuildingTypes (DFU serializes the enum by name or by number). */
const BUILDING_TYPES = [
  'Alchemist', 'HouseForSale', 'Armorer', 'Bank', 'Town4', 'Bookseller', 'ClothingStore', 'FurnitureStore', 'GemStore',
  'GeneralStore', 'Library', 'GuildHall', 'PawnShop', 'WeaponSmith', 'Temple', 'Tavern', 'Palace', 'House1', 'House2',
  'House3', 'House4', 'House5', 'House6', 'Town23', 'Ship',
];
const BUILDING_SPECIAL = { Special1: 0x74, Special2: 0xdf, Special3: 0xf9, Special4: 0xfa };

/** What a WorldData file name means to DFU, or null when DFU would never read it. */
export function classifyWorldDataFile(fileName) {
  const base = String(fileName).split(/[\\/]/).pop();
  let m = LOCATION_FILE_RE.exec(base);
  if (m) {
    const region = Number(m[1]), index = Number(m[2]);
    return region < REGION_NAMES.length ? { kind: 'location', region, index, key: `${region}-${index}` } : null;
  }
  m = BLOCK_FILE_RE.exec(base);
  if (m) return { kind: 'block', name: m[1].toUpperCase() };
  return null;
}

/** DFU/FullSerializer JSON: `\0` (not valid JSON) appears inside padded C strings. Size-checked. */
export function parseDfuJson(text, label = 'WorldData') {
  if (typeof text !== 'string') throw new WorldDataError(`${label}: expected JSON text`);
  if (text.length > WORLDDATA_LIMITS.fileBytes) throw new WorldDataError(`${label}: file is larger than ${WORLDDATA_LIMITS.fileBytes} bytes`);
  let out = '';
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 92) continue; // backslash
    if (text[i + 1] === '0') {
      out += text.slice(last, i) + '\\u0000';
      last = i + 2;
    }
    i++; // skip the escaped character
  }
  out += text.slice(last);
  try {
    return JSON.parse(out);
  } catch (err) {
    throw new WorldDataError(`${label}: invalid JSON (${err.message})`);
  }
}

// ---------------------------------------------------------------------------------------------- validation

const int = (v, lo, hi, what, label) => {
  const n = typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v;
  if (!Number.isInteger(n) || n < lo || n > hi) throw new WorldDataError(`${label}: ${what} ${JSON.stringify(v)} is out of range`);
  return n;
};
const optInt = (v, lo, hi, what, label, dflt = 0) => (v === undefined || v === null ? dflt : int(v, lo, hi, what, label));
const num = (v, lo, hi, what, label, dflt) => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new WorldDataError(`${label}: ${what} is out of range`);
  return v;
};
const list = (v, max, what, label) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new WorldDataError(`${label}: ${what} is not an array`);
  if (v.length > max) throw new WorldDataError(`${label}: ${what} has ${v.length} entries (limit ${max})`);
  return v;
};
const POS = 1 << 20; // native units; a block is 4096 wide, so +/-1M is far beyond any sane placement
const ROT = 1 << 15;

function buildingType(v, label) {
  if (typeof v === 'number') return int(v, -1, 0xffff, 'building type', label);
  if (typeof v === 'string') {
    const i = BUILDING_TYPES.indexOf(v);
    if (i >= 0) return i;
    if (v in BUILDING_SPECIAL) return BUILDING_SPECIAL[v];
    if (v === 'None') return -1;
  }
  throw new WorldDataError(`${label}: unknown building type ${JSON.stringify(v)}`);
}

/** RmbBlock3dObjectRecord -> {modelId, objectType, xPos, yPos, zPos, yRotation[, xRotation, zRotation, scale]}. */
function model(m, label) {
  if (!m || typeof m !== 'object') throw new WorldDataError(`${label}: model record is not an object`);
  const modelId = m.ModelIdNum !== undefined ? int(m.ModelIdNum, 0, 99999, 'model id', label) : int(m.ModelId, 0, 99999, 'model id', label);
  const out = {
    modelId,
    objectType: optInt(m.ObjectType, 0, 255, 'object type', label),
    xPos: int(m.XPos, -POS, POS, 'XPos', label),
    yPos: int(m.YPos, -POS, POS, 'YPos', label),
    zPos: int(m.ZPos, -POS, POS, 'ZPos', label),
    yRotation: optInt(m.YRotation, -ROT, ROT, 'YRotation', label),
  };
  // DFU 0.11+ honours X/Z rotation and per-axis scale (RMBLayout.GetModelScaleVector: 0 means 1).
  const xr = optInt(m.XRotation, -ROT, ROT, 'XRotation', label);
  const zr = optInt(m.ZRotation, -ROT, ROT, 'ZRotation', label);
  const s = [m.XScale, m.YScale, m.ZScale].map((v) => num(v, -64, 64, 'scale', label, 1) || 1);
  if (xr) out.xRotation = xr;
  if (zr) out.zRotation = zr;
  if (s.some((v) => v !== 1)) out.scale = s;
  return out;
}

/** RmbBlockFlatObjectRecord / RmbBlockPeopleRecord -> parseRmbFull flat shape. */
function flat(f, label) {
  if (!f || typeof f !== 'object') throw new WorldDataError(`${label}: flat record is not an object`);
  return {
    xPos: int(f.XPos, -POS, POS, 'XPos', label),
    yPos: int(f.YPos, -POS, POS, 'YPos', label),
    zPos: int(f.ZPos, -POS, POS, 'ZPos', label),
    // DFU reads JSON archives as int; mods use > 511 for custom texture archives (WoD: 1010). Consumers skip unknown ones.
    archive: int(f.TextureArchive, 0, 65535, 'texture archive', label),
    record: int(f.TextureRecord, 0, 127, 'texture record', label),
    factionId: optInt(f.FactionID ?? f.FactionId, -32768, 65535, 'faction', label),
    flags: optInt(f.Flags, 0, 255, 'flags', label),
  };
}

function door(d, label) {
  if (!d || typeof d !== 'object') throw new WorldDataError(`${label}: door record is not an object`);
  return {
    xPos: int(d.XPos, -POS, POS, 'XPos', label),
    yPos: int(d.YPos, -POS, POS, 'YPos', label),
    zPos: int(d.ZPos, -POS, POS, 'ZPos', label),
    yRotation: optInt(d.YRotation, -ROT, ROT, 'YRotation', label),
    openRotation: optInt(d.OpenRotation, -ROT, ROT, 'OpenRotation', label),
    doorModelIndex: optInt(d.DoorModelIndex, 0, 255, 'door model index', label),
  };
}

function blockData(b, label, budget) {
  const src = b && typeof b === 'object' ? b : {};
  const models = list(src.Block3dObjectRecords, WORLDDATA_LIMITS.models, 'models', label).map((m) => model(m, label));
  budget.models += models.length;
  return {
    models,
    flats: list(src.BlockFlatObjectRecords, WORLDDATA_LIMITS.flats, 'flats', label).map((f) => flat(f, label)),
    people: list(src.BlockPeopleRecords, WORLDDATA_LIMITS.people, 'people', label).map((f) => flat(f, label)),
    doors: list(src.BlockDoorRecords, WORLDDATA_LIMITS.doors, 'doors', label).map((d) => door(d, label)),
    // Section 3 records are kept by DFU but never laid out; only their count is carried.
    section3: list(src.BlockSection3Records, WORLDDATA_LIMITS.section3, 'section 3', label).length,
  };
}

function groundArrays(g, label) {
  const tiles = new Array(256).fill(0);
  const scenery = new Array(256).fill(255);
  // RmbGroundDataConverter only fills the arrays when Header, GroundTiles and GroundScenery are all present.
  if (!g || typeof g !== 'object' || !Array.isArray(g.GroundTiles) || !Array.isArray(g.GroundScenery)) return { tiles, scenery, present: false };
  if (g.GroundTiles.length !== 256 || g.GroundScenery.length !== 256) throw new WorldDataError(`${label}: ground arrays must have 256 entries`);
  for (let i = 0; i < 256; i++) {
    const t = g.GroundTiles[i] ?? {};
    // DFU's MeshReader and TerrainHelper use TextureRecord/IsRotated/IsFlipped, not TileBitfield.
    const rec = t.TextureRecord !== undefined ? int(t.TextureRecord, 0, 63, 'ground record', label) : optInt(t.TileBitfield, 0, 255, 'ground bits', label) & 0x3f;
    const rot = t.IsRotated !== undefined ? !!t.IsRotated : (optInt(t.TileBitfield, 0, 255, 'ground bits', label) & 0x40) !== 0;
    const flip = t.IsFlipped !== undefined ? !!t.IsFlipped : (optInt(t.TileBitfield, 0, 255, 'ground bits', label) & 0x80) !== 0;
    tiles[i] = rec | (rot ? 0x40 : 0) | (flip ? 0x80 : 0);
    const s = optInt(g.GroundScenery[i]?.TextureRecord, -1, 62, 'scenery record', label, -1);
    scenery[i] = s < 0 ? 255 : (s + 1) * 4; // BlocksFile.ReadRmbGroundSceneryData inverse (low two bits are not serialized)
  }
  return { tiles, scenery, present: true };
}

/**
 * A DFU DFBlock JSON (RMB) -> plain, bounded descriptor (JSON-safe). See hydrateBlock() for loader shapes.
 * @param {object} raw parsed JSON
 * @param {string} blockName the name DFU looked it up by (file name without `.json`)
 */
export function normalizeBlock(raw, blockName) {
  const name = String(blockName).toUpperCase();
  const label = `WorldData ${name}`;
  if (!BLOCK_NAME_RE.test(name)) throw new WorldDataError(`${label}: not an RMB block name`);
  if (!raw || typeof raw !== 'object' || !raw.RmbBlock || typeof raw.RmbBlock !== 'object') throw new WorldDataError(`${label}: not a DFBlock with an RmbBlock`);
  if (raw.Type !== undefined && raw.Type !== 'Rmb' && raw.Type !== 1) throw new WorldDataError(`${label}: block type ${JSON.stringify(raw.Type)} is not RMB`);
  const rmb = raw.RmbBlock;
  const fld = rmb.FldHeader && typeof rmb.FldHeader === 'object' ? rmb.FldHeader : {};
  const subs = list(rmb.SubRecords, WORLDDATA_LIMITS.subRecords, 'sub-records', label);
  const positions = list(fld.BlockPositions, 64, 'block positions', label);
  const buildingsRaw = list(fld.BuildingDataList, 64, 'building data', label);
  const budget = { models: 0 };
  const subRecords = subs.map((s, i) => {
    const sl = `${label} sub-record ${i}`;
    if (!s || typeof s !== 'object') throw new WorldDataError(`${sl}: not an object`);
    // JSON sub-records carry their own position (WorldDataReplacement copies none from BlockPositions).
    const p = s.XPos === undefined && positions[i] ? positions[i] : s;
    const bd = buildingsRaw[i] ?? {};
    return {
      index: i,
      ...(typeof fld.OtherNames?.[i] === 'string' ? { houseFile: fld.OtherNames[i].slice(0, 13) } : {}),
      xPos: int(p.XPos, -POS, POS, 'XPos', sl),
      zPos: int(p.ZPos, -POS, POS, 'ZPos', sl),
      yRotation: optInt(p.YRotation, -ROT, ROT, 'YRotation', sl),
      building: {
        nameSeed: optInt(bd.NameSeed, 0, 65535, 'name seed', sl),
        factionId: optInt(bd.FactionId, 0, 65535, 'faction', sl),
        sector: optInt(bd.Sector, -32768, 32767, 'sector', sl),
        buildingType: bd.BuildingType === undefined ? -1 : buildingType(bd.BuildingType, sl),
        quality: optInt(bd.Quality, 0, 255, 'quality', sl),
      },
      exterior: blockData(s.Exterior, `${sl} exterior`, budget),
      interior: blockData(s.Interior, `${sl} interior`, budget),
    };
  });
  const misc3d = list(rmb.Misc3dObjectRecords, WORLDDATA_LIMITS.models, 'misc 3D models', label).map((m) => model(m, label));
  const miscFlats = list(rmb.MiscFlatObjectRecords, WORLDDATA_LIMITS.flats, 'misc flats', label).map((f) => flat(f, label));
  budget.models += misc3d.length;
  if (budget.models > WORLDDATA_LIMITS.totalModels) throw new WorldDataError(`${label}: ${budget.models} models (limit ${WORLDDATA_LIMITS.totalModels})`);
  const ground = groundArrays(fld.GroundData, label);
  return {
    v: WORLDDATA_VERSION,
    kind: 'rmb',
    name,
    groundTiles: ground.tiles,
    scenery: ground.scenery,
    groundPresent: ground.present,
    subRecords,
    misc3d,
    miscFlats,
  };
}

/** A DFU DFLocation JSON -> {region, index, name, longitude, latitude, mapId, width, height, blockNames}. */
export function normalizeLocation(raw, region, index) {
  const label = `WorldData location-${region}-${index}`;
  if (!raw || typeof raw !== 'object') throw new WorldDataError(`${label}: not a DFLocation`);
  const ext = raw.Exterior?.ExteriorData;
  if (!ext || typeof ext !== 'object') throw new WorldDataError(`${label}: Exterior.ExteriorData is missing`);
  const width = int(ext.Width, 1, 8, 'width', label);
  const height = int(ext.Height, 1, 8, 'height', label);
  const names = list(ext.BlockNames, WORLDDATA_LIMITS.blockNames, 'block names', label);
  if (names.length < width * height) throw new WorldDataError(`${label}: ${names.length} block names for a ${width}x${height} exterior`);
  const blockNames = names.slice(0, width * height).map((n) => {
    const s = String(n).toUpperCase();
    if (!BLOCK_NAME_RE.test(s)) throw new WorldDataError(`${label}: block name ${JSON.stringify(n)} is not an RMB block`);
    return s;
  });
  const name = String(raw.Name ?? ext.AnotherName ?? '');
  if (!NAME_RE.test(name)) throw new WorldDataError(`${label}: invalid location name`);
  // The file name is what DFU looks the replacement up by; the JSON indexes must agree when present.
  if (raw.RegionIndex !== undefined && raw.RegionIndex !== region) throw new WorldDataError(`${label}: RegionIndex ${raw.RegionIndex} does not match the file name`);
  if (raw.LocationIndex !== undefined && raw.LocationIndex !== index) throw new WorldDataError(`${label}: LocationIndex ${raw.LocationIndex} does not match the file name`);
  const mt = raw.MapTableData ?? {};
  const buildings = list(raw.Exterior?.Buildings, 512, 'buildings', label).map((b) => ({
    nameSeed: optInt(b?.NameSeed, 0, 65535, 'name seed', label),
    factionId: optInt(b?.FactionId, 0, 65535, 'faction', label),
    sector: optInt(b?.Sector, -32768, 32767, 'sector', label),
    buildingType: b?.BuildingType === undefined ? -1 : buildingType(b.BuildingType, label),
    quality: optInt(b?.Quality, 0, 255, 'quality', label),
  }));
  const hasDungeon = Array.isArray(raw.Dungeon?.Blocks) && raw.Dungeon.Blocks.length > 0;
  return {
    v: WORLDDATA_VERSION,
    kind: 'location',
    region,
    regionName: REGION_NAMES[region],
    index,
    name,
    mapId: optInt(mt.MapId, -(2 ** 31), 2 ** 32, 'map id', label, null),
    longitude: optInt(mt.Longitude, 0, 1 << 17, 'longitude', label, null),
    latitude: optInt(mt.Latitude, 0, 1 << 16, 'latitude', label, null),
    width,
    height,
    blockNames,
    buildings,
    // Dungeon replacements (Dungeon.Blocks) are not supported; a replacement that adds one is reported, not used.
    dungeon: hasDungeon ? 'unsupported' : null,
  };
}

/** Descriptor (JSON) -> the union of parseRmb/parseRmbFull/parseRmbFlats shapes, with typed ground arrays. */
export function hydrateBlock(desc, blockIndex = -1) {
  if (!desc || desc.kind !== 'rmb' || !Array.isArray(desc.groundTiles) || desc.groundTiles.length !== 256) {
    throw new WorldDataError('WorldData: malformed block descriptor');
  }
  return {
    name: desc.name,
    blockIndex,
    replaced: true,
    groundTiles: Uint8Array.from(desc.groundTiles),
    scenery: Uint8Array.from(desc.scenery),
    subRecords: desc.subRecords.map((s) => ({ ...s, models: s.exterior.models, flats: s.exterior.flats })),
    misc3d: desc.misc3d,
    miscFlats: desc.miscFlats,
  };
}

// ---------------------------------------------------------------------------------------------- providers
//
// A provider is `{ source, index(): Promise<{blocks: string[], locations: [{region,index,name}]}>,
//                  block(name): Promise<descriptor|null>, location(region, index): Promise<descriptor|null> }`.
// `null` (no provider) and an empty provider both mean vanilla.

/**
 * Provider over in-memory files. `entries`: [{name, text}] (text may be a function returning a Promise<string> so
 * nothing is read until used). Unknown names are ignored; malformed files are reported once via `onError` and then
 * behave as absent (DFU logs and falls back the same way when a replacement cannot be deserialized).
 */
export function memoryWorldData(entries, { source = 'memory', onError = null, allow = null } = {}) {
  const blocks = new Map();
  const locations = new Map();
  let count = 0;
  for (const e of entries) {
    const c = classifyWorldDataFile(e.name);
    if (!c || (allow && !allow(e.name))) continue;
    if (++count > WORLDDATA_LIMITS.files) break;
    if (c.kind === 'block' && !blocks.has(c.name)) blocks.set(c.name, { read: e.text, value: undefined });
    if (c.kind === 'location' && !locations.has(c.key)) locations.set(c.key, { ...c, read: e.text, value: undefined });
  }
  const load = async (slot, fn, label) => {
    if (slot.value !== undefined) return slot.value;
    slot.value ??= (async () => {
      try {
        const text = typeof slot.read === 'function' ? await slot.read() : slot.read;
        return fn(parseDfuJson(text, label));
      } catch (err) {
        onError?.(err);
        return null;
      }
    })();
    return slot.value;
  };
  const block = async (name) => {
    const key = String(name).toUpperCase();
    const slot = blocks.get(key);
    return slot ? load(slot, (raw) => normalizeBlock(raw, key), `WorldData ${key}`) : null;
  };
  const location = async (region, index) => {
    const slot = locations.get(`${region}-${index}`);
    return slot ? load(slot, (raw) => normalizeLocation(raw, region, index), `WorldData location-${region}-${index}`) : null;
  };
  let indexP = null;
  return {
    source,
    block,
    location,
    async index() {
      indexP ??= (async () => {
        const locs = [];
        for (const s of locations.values()) {
          const d = await location(s.region, s.index);
          if (d) locs.push({ region: d.region, index: d.index, name: d.name });
        }
        return { v: WORLDDATA_VERSION, blocks: [...blocks.keys()].sort(), locations: locs };
      })();
      return indexP;
    },
  };
}

export const WORLDDATA_PATH = '/api/wilderness/worlddata';

/**
 * Same-origin provider (browser). Reads the small index once, then fetches only the descriptors a load asks for.
 * Resolves to null when the server has no WorldData route (404) so the caller can fall back; 503 (pack missing or
 * loading on the server) means vanilla, matching what the server itself uses.
 */
export async function remoteWorldData({ fetchFn = globalThis.fetch, base = '' } = {}) {
  if (typeof fetchFn !== 'function') return null;
  let res;
  try {
    res = await fetchFn(`${base}${WORLDDATA_PATH}`, { credentials: 'same-origin' });
  } catch {
    return null;
  }
  if (res.status === 404) return null;
  if (!res.ok) return emptyWorldData('server (vanilla)');
  const index = await res.json();
  const blockSet = new Set(Array.isArray(index.blocks) ? index.blocks : []);
  const locSet = new Set((index.locations ?? []).map((l) => `${l.region}-${l.index}`));
  const cache = new Map();
  const get = (key, url) => {
    if (!cache.has(key)) {
      cache.set(key, (async () => {
        const r = await fetchFn(`${base}${url}`, { credentials: 'same-origin' });
        if (!r.ok) throw new WorldDataError(`WorldData: the server could not provide ${key} (${r.status})`);
        return r.json();
      })());
    }
    return cache.get(key);
  };
  return {
    source: 'server',
    index: async () => index,
    block: async (name) => {
      const key = String(name).toUpperCase();
      return blockSet.has(key) ? get(key, `${WORLDDATA_PATH}/block?name=${encodeURIComponent(key)}`) : null;
    },
    location: async (region, idx) => (locSet.has(`${region}-${idx}`) ? get(`${region}-${idx}`, `${WORLDDATA_PATH}/location?region=${region}&index=${idx}`) : null),
  };
}

export function emptyWorldData(source = 'vanilla') {
  return { source, index: async () => ({ v: WORLDDATA_VERSION, blocks: [], locations: [] }), block: async () => null, location: async () => null };
}

/** WorldData files inside a player's own selected folder (their copy of the pack), or null. */
export function worldDataFromFiles(files) {
  const entries = [];
  for (const f of files ?? []) {
    const path = f?.webkitRelativePath || f?.name || '';
    if (!classifyWorldDataFile(path)) continue;
    if (typeof f.size === 'number' && f.size > WORLDDATA_LIMITS.fileBytes) continue;
    entries.push({ name: path.split('/').pop(), text: () => f.text() });
  }
  return entries.length ? memoryWorldData(entries, { source: 'player files' }) : null;
}

const browserCache = new WeakMap();
let remoteP = null;

/**
 * The provider the browser's normal loaders use: the game server's (authoritative, so feet and doors match the
 * server), else WorldData in the player's own selected files, else vanilla. Memoised per file selection.
 */
export function browserWorldData(files) {
  const key = files && typeof files === 'object' ? files : browserCache;
  let p = browserCache.get(key);
  if (!p) {
    p = (async () => {
      if (typeof globalThis.location !== 'undefined' && globalThis.location?.origin) {
        remoteP ??= remoteWorldData().catch(() => null);
        const remote = await remoteP;
        if (remote) return remote;
      }
      return (files && worldDataFromFiles(files)) || null;
    })();
    browserCache.set(key, p);
  }
  return p;
}

let processDefault = null;

/**
 * Server only: the provider loaders use when called without `options.worldData` (null = vanilla). Set once at
 * startup by server/rpg/wilderness/replacements.js so collision, doors and town services share one layout.
 */
export function setDefaultWorldData(provider) {
  processDefault = provider ?? null;
}

/**
 * Default for loaders called without `options.worldData`: the browser provider in a page; in Node, the provider
 * registered with setDefaultWorldData(), else vanilla.
 */
export function defaultWorldData(files) {
  return typeof globalThis.document !== 'undefined' ? browserWorldData(files) : Promise.resolve(processDefault);
}

// ---------------------------------------------------------------------------------------------- loader hooks

/**
 * Resolve an RMB block name exactly as DFU does with replacements active.
 * @returns {Promise<{index:number, name:string, block:object|null}>} `block` is the hydrated replacement, or null
 *   when the caller should parse BLOCKS.BSA record `index` itself. index is -1 when neither exists.
 */
export async function resolveRmbBlock(bsa, name, worldData) {
  const wanted = String(name).toUpperCase();
  const wd = await worldData;
  let index = bsa.indexOfName(wanted);
  if (index < 0 && wd) {
    // BlocksFile.GetBlockIndex: blocks that only exist as JSON get indexes after the BSA (AssignNewIndex).
    const desc = await wd.block(wanted);
    if (desc) {
      const added = (await wd.index()).blocks.filter((b) => bsa.indexOfName(b) < 0);
      const at = bsa.count + Math.max(0, added.indexOf(wanted));
      return { index: at, name: wanted, block: hydrateBlock(desc, at) };
    }
  }
  if (index < 0) {
    index = resolveBlockIndex(bsa, wanted);
    if (index < 0) return { index: -1, name: wanted, block: null };
  }
  const resolved = bsa.entries[index].name;
  const desc = wd ? await wd.block(resolved) : null;
  return { index, name: resolved, block: desc ? hydrateBlock(desc, index) : null };
}

/**
 * MapsFile.ReadLocation with location replacements: `locationName` may be the MAPNAMES name or the replacement's
 * own name. Returns readLocation()'s shape; `replaced` is set when a WorldData location was applied.
 */
export async function readLocationReplaced(maps, region, locationName, worldData) {
  const wd = await worldData;
  if (!wd) return readLocation(maps, region, locationName);
  const idx = await wd.index();
  const replacement = typeof locationName === 'string' && idx.locations.find(
    l => l.region === region && l.name.toLowerCase() === locationName.toLowerCase(),
  );
  const loc = await readLocation(maps, region, replacement?.index ?? locationName);
  const rep = await wd.location(region, loc.index);
  if (!rep) return loc;
  // `name` stays the MAPNAMES entry: it is the location id every server feature (travel, collision, doors) keys
  // on. `displayName` is what DFU shows (the replacement's Name).
  return {
    ...loc,
    displayName: rep.name,
    longitude: rep.longitude ?? loc.longitude,
    latitude: rep.latitude ?? loc.latitude,
    mapId: rep.mapId ?? loc.mapId,
    width: rep.width,
    height: rep.height,
    blockNames: rep.blockNames,
    buildings: rep.buildings,
    replaced: { source: wd.source, file: `location-${region}-${loc.index}.json` },
  };
}

/** Matrix-free model-local transform for records with X/Z rotation or scale (Unity Quaternion.Euler ZXY order). */
export function rmbModelLocal(m, divisor = 5.68888888888889) {
  if (!m.xRotation && !m.zRotation && !m.scale) return null;
  const rad = (v) => ((-(v ?? 0) / divisor) * Math.PI) / 180;
  const ax = rad(m.xRotation), ay = rad(m.yRotation), az = rad(m.zRotation);
  const [sx, sy, sz] = m.scale ?? [1, 1, 1];
  const cx = Math.cos(ax), sxn = Math.sin(ax), cy = Math.cos(ay), syn = Math.sin(ay), cz = Math.cos(az), szn = Math.sin(az);
  // R = Ry * Rx * Rz (Unity applies z, then x, then y).
  const r = [
    [cy * cz + syn * sxn * szn, -cy * szn + syn * sxn * cz, syn * cx],
    [cx * szn, cx * cz, -sxn],
    [-syn * cz + cy * sxn * szn, syn * szn + cy * sxn * cz, cy * cx],
  ];
  return (x, y, z) => {
    const px = x * sx, py = y * sy, pz = z * sz;
    return [r[0][0] * px + r[0][1] * py + r[0][2] * pz, r[1][0] * px + r[1][1] * py + r[1][2] * pz, r[2][0] * px + r[2][1] * py + r[2][2] * pz];
  };
}

/**
 * Model placements of one RMB block (parseRmb() or hydrateBlock() shape) in DFU Unity space, block SW corner at the
 * origin, metres: what GameObjectHelper.CreateRMBBlockGameObject(name, 0, 0) lays out and what Location Loader's
 * type-5 (RMB) prefab objects instantiate. Same transforms as client/world/town.js, including the X/Z rotation and
 * scale WorldData blocks use on misc models.
 * @returns {Array<{modelId:number, kind:'building'|'misc', place:(x:number,y:number,z:number)=>number[]}>}
 */
export function rmbBlockPlacements(rmb, { scale = 0.025, divisor = 5.68888888888889 } = {}) {
  const dim = 4096, props = -4;
  const yaw = (deg) => { const r = (deg * Math.PI) / 180; return { c: Math.cos(r), s: Math.sin(r) }; };
  const rotY = (m, x, z) => [x * m.c + z * m.s, -x * m.s + z * m.c];
  const out = [];
  for (const sub of rmb.subRecords) {
    const sm = yaw(-sub.yRotation / divisor);
    const sx = sub.xPos * scale, sz = (dim - sub.zPos) * scale;
    for (const m of sub.models ?? sub.exterior.models) {
      const local = rmbModelLocal(m, divisor);
      const mm = yaw(-m.yRotation / divisor);
      const mx = m.xPos * scale, my = -m.yPos * scale, mz = m.zPos * scale;
      out.push({
        modelId: m.modelId,
        kind: 'building',
        place: (x, y, z) => {
          let ax, ay = y, az;
          if (local) [ax, ay, az] = local(x, y, z);
          else [ax, az] = rotY(mm, x, z);
          const [bx, bz] = rotY(sm, ax + mx, az + mz);
          return [sx + bx, ay + my, sz + bz];
        },
      });
    }
  }
  for (const m of rmb.misc3d) {
    const local = rmbModelLocal(m, divisor);
    const mm = yaw(-m.yRotation / divisor);
    const mx = m.xPos * scale, my = (-m.yPos + props) * scale, mz = (m.zPos + dim) * scale;
    out.push({
      modelId: m.modelId,
      kind: 'misc',
      place: (x, y, z) => {
        if (local) {
          const [lx, ly, lz] = local(x, y, z);
          return [mx + lx, ly + my, mz + lz];
        }
        const [ax, az] = rotY(mm, x, z);
        return [mx + ax, y + my, mz + az];
      },
    });
  }
  return out;
}
