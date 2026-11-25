// Interiors and dungeons from the player's (browser) or operator's (server) own ARENA2 files.
//
// One module serves both sides so portal ids, landing points and exits agree exactly:
//  - locationPortals(): every enterable building door and dungeon entrance of a town, with landing points.
//  - loadInterior() / loadDungeon(): renderer-ready scenes in the client/world/town.js output contract.
//
// Location ids:
//   town:<Region>/<Location>                       exterior (client/world/town.js, spawn-centred output space)
//   interior:<Region>/<Location>/<bx>,<by>/<rec>   building sub-record <rec> of block (bx, by)
//   dungeon:<Region>/<Location>                    the location's MAPS dungeon
// Interior and dungeon output space is the Unity layout space mirrored on z (scene.js), with no other offset.
//
// MIT notices for the adapted code: THIRD_PARTY_NOTICES.txt in this directory.

import { BsaArchive, NAME_RECORD, readBlob } from '../bsa.js';
import { climateAt, climateSettings, regionIndexOf } from '../maps.js';
import { indexFiles, requireFiles } from '../files.js';
import { WorldDataError } from '../errors.js';
import { defaultWorldData, readLocationReplaced, resolveRmbBlock } from '../wilderness/replacements.js';
import { parseRmbFull, parseRdb } from './blocks.js';
import { buildingDirectory, NAMED_BUILDINGS } from './buildingDirectory.js';
import { readDungeon } from './dungeonMaps.js';
import { interiorFlats } from './flats.js';
import { interiorContainers, dungeonContainers } from './containers.js';
import { ModelLibrary, buildScene, placedDoors, placeDoor, mul, point, DOOR_TYPE } from './scene.js';
import { graveyardAccess, GRAVEYARD_ACCESS, isMantellan } from './dungeonAccess.js';
import {
  subRecordFrame, rmbModelMatrix, miscModelMatrix, interiorLayout, interiorLanding, dungeonLayout, hasInterior,
  closest, EXTERIOR_LANDING, RDB_SIDE, roomBeds, shopShelves, SHOP_BUILDING_TYPES,
} from './layout.js';

export { DOOR_TYPE, WorldDataError };

const NAME_RE = /^[^/:#\u0000-\u001f]{1,64}$/;

export const townLocation = (region, location) => `town:${region}/${location}`;
export const dungeonLocation = (region, location) => `dungeon:${region}/${location}`;
export const interiorLocation = (region, location, bx, by, record) => `interior:${region}/${location}/${bx},${by}/${record}`;
export const buildingPortalId = (bx, by, record) => `b:${bx},${by}:${record}`;
export const DUNGEON_PORTAL_ID = 'dungeon';

/** Parse a location id. Returns null for anything malformed. */
export function parseLocation(id) {
  if (typeof id !== 'string' || id.length > 200) return null;
  let m = /^(town|dungeon):([^/]+)\/([^/]+)$/.exec(id);
  if (m) {
    if (!NAME_RE.test(m[2]) || !NAME_RE.test(m[3])) return null;
    return { kind: m[1], region: m[2], location: m[3] };
  }
  m = /^interior:([^/]+)\/([^/]+)\/(\d{1,2}),(\d{1,2})\/(\d{1,2})$/.exec(id);
  if (m && NAME_RE.test(m[1]) && NAME_RE.test(m[2])) {
    return { kind: 'interior', region: m[1], location: m[2], bx: +m[3], by: +m[4], record: +m[5] };
  }
  return null;
}

/** Exterior location id that owns an interior or dungeon id (or the id itself for a town). */
export function exteriorOf(id) {
  const p = parseLocation(id);
  return p ? townLocation(p.region, p.location) : null;
}

/** Server yaw (0 faces -z, positive turns toward +x) facing output-space direction (dx, dz). */
export const yawFacing = (dx, dz) => Math.atan2(dx, -dz);

const r3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Opened archives for one file selection. Cache it: every call below reuses the readers and meshes.
 * `options.worldData`: Daggerfall Unity WorldData replacements, as for loadTown (null forces vanilla).
 */
export async function openWorldData(files, options = {}) {
  const index = files instanceof Map ? files : indexFiles(files);
  const [mapsF, blocksF] = requireFiles(index, ['MAPS.BSA', 'BLOCKS.BSA', 'ARCH3D.BSA', 'ART_PAL.COL']);
  const maps = await BsaArchive.open(mapsF, 'MAPS.BSA', NAME_RECORD);
  const blocks = await BsaArchive.open(blocksF, 'BLOCKS.BSA', NAME_RECORD);
  const lib = await new ModelLibrary(index).open();
  const worldData = options.worldData !== undefined ? options.worldData : defaultWorldData(files instanceof Map ? null : files);
  return { index, maps, blocks, lib, worldData, rmb: new Map(), rdb: new Map(), locations: new Map(), rdbExits: new WeakMap() };
}

async function rmbBlock(data, name) {
  const r = await resolveRmbBlock(data.blocks, name, data.worldData);
  const bi = r.index;
  if (bi < 0) throw new WorldDataError(`BLOCKS.BSA: block ${name} is missing`);
  let b = data.rmb.get(bi);
  if (!b) {
    b = r.block ?? parseRmbFull(await data.blocks.read(bi), r.name);
    b.blockIndex = bi;
    data.rmb.set(bi, b);
  }
  return b;
}

async function rdbBlock(data, name) {
  const bi = data.blocks.indexOfName(name);
  if (bi < 0) throw new WorldDataError(`BLOCKS.BSA: dungeon block ${name} is missing`);
  let b = data.rdb.get(bi);
  if (!b) {
    b = parseRdb(await data.blocks.read(bi), data.blocks.entries[bi].name, bi);
    data.rdb.set(bi, b);
  }
  return b;
}

async function locationInfo(data, regionName, locationName) {
  const key = `${String(regionName).toLowerCase()}/${String(locationName).toLowerCase()}`;
  let info = data.locations.get(key);
  if (info) return info;
  const region = regionIndexOf(regionName);
  const loc = await readLocationReplaced(data.maps, region, locationName, data.worldData);
  let climateBase = null;
  const pak = data.index.get('CLIMATE.PAK');
  if (pak) {
    data.climateBytes ??= readBlob(pak, 0, pak.size);
    climateBase = climateSettings(climateAt(await data.climateBytes, loc.longitude, loc.latitude)).climateBase;
  }
  info = { region, loc, climateBase, dungeon: await readDungeon(data.maps, region, loc.index) };
  data.locations.set(key, info);
  return info;
}

function buildingsFor(data, info) {
  return info.buildings ??= buildingDirectory(data, info.region, info.loc, name => rmbBlock(data, name))
    .catch(() => {
      // A damaged neighbouring block can prevent a reliable name. The current room can still load.
      info.buildings = null;
      return new Map();
    });
}

/** Town Unity space -> town output space (town.source.spawnLocal is the origin). */
export function townPointToOutput([x, y, z], spawnLocal) {
  return [x - spawnLocal.x, y, -(z - spawnLocal.z)];
}

const outDoor = (d, spawnLocal) => {
  const [x, y, z] = townPointToOutput(d.centre, spawnLocal);
  const nx = d.normal[0], nz = -d.normal[2];
  return {
    x: r3(x), y: r3(y), z: r3(z), nx: r3(nx), nz: r3(nz),
    // Where a player leaving through this door stands, and the way they face.
    exit: { x: r3(x + nx * EXTERIOR_LANDING), z: r3(z + nz * EXTERIOR_LANDING), y: r3(y - d.size.height / 2), yaw: r3(yawFacing(nx, nz)) },
  };
};

/**
 * Every enterable door of a town. `spawnLocal` is town.source.spawnLocal from loadTown for the same location; it
 * places the doors in the town's output space.
 * @returns {Promise<{location, region, name, buildings: Array, dungeon: object|null}>}
 */
export async function locationPortals(data, { region, location }, spawnLocal, { dungeonOnly = false } = {}) {
  if (!spawnLocal || !Number.isFinite(spawnLocal.x) || !Number.isFinite(spawnLocal.z)) {
    throw new TypeError('locationPortals needs the town spawnLocal');
  }
  const info = await locationInfo(data, region, location);
  const { loc } = info;
  const { region: addressRegion, location: addressLocation } = parseLocation(loc.townId);
  const directory = dungeonOnly ? null : await buildingsFor(data, info);
  const buildings = [];
  const dungeonDoors = [];
  for (let by = 0; by < loc.height; by++) {
    for (let bx = 0; bx < loc.width; bx++) {
      const block = await rmbBlock(data, loc.blockNames[by * loc.width + bx]);
      for (const sub of block.subRecords) {
        const frame = subRecordFrame(bx, by, sub);
        const local = [];
        for (const m of sub.exterior.models) {
          const mesh = await data.lib.mesh(m.modelId);
          for (const d of mesh.doors) local.push(placeDoor(d, rmbModelMatrix(m)));
        }
        const buildingDoors = local.filter((d) => d.type === DOOR_TYPE.BUILDING);
        for (const d of local) if (d.type === DOOR_TYPE.DUNGEON_ENTRANCE) dungeonDoors.push(placeDoor(d, frame));
        if (dungeonOnly || !buildingDoors.length || !hasInterior(sub)) continue;
        // Landing inside for each exterior door (PlayerEnterExit.TransitionInterior), in interior output space.
        const lay = await interiorLayout(data.lib, sub, block.blockIndex, sub.index);
        const inner = await placedDoors(data.lib, lay.placements.filter((p) => !p.actionDoor));
        const exits = inner.filter((d) => d.type === DOOR_TYPE.BUILDING);
        const doors = buildingDoors.map((d) => {
          const town = placeDoor(d, frame);
          const land = interiorLanding(d.centre, inner, lay.enterMarkers);
          const facing = land.facing ?? [-d.normal[0], 0, -d.normal[2]];
          return {
            ...outDoor(town, spawnLocal),
            local: d.centre.map(r3),
            enter: { x: r3(land.position[0]), y: r3(land.position[1]), z: r3(-land.position[2]), yaw: r3(yawFacing(facing[0], -facing[2])) },
          };
        });
        const portalId = buildingPortalId(bx, by, sub.index);
        const entry = directory.get(portalId) ?? sub.building;
        buildings.push({
          portalId,
          name: entry.name || null,
          target: interiorLocation(addressRegion, addressLocation, bx, by, sub.index),
          block: block.name,
          blockIndex: block.blockIndex,
          bx,
          by,
          record: sub.index,
          buildingType: entry.buildingType,
          factionId: entry.factionId,
          quality: entry.quality,
          beds: entry.buildingType === 15 ? roomBeds(sub) : [],
          shelves: SHOP_BUILDING_TYPES.has(entry.buildingType) ? await shopShelves(data.lib, lay.placements) : [],
          // RMBLayout: the first exterior model is the building model; its radius prices a house.
          modelId: sub.exterior.models[0]?.modelId ?? null,
          radius: sub.exterior.models[0] ? (await data.lib.mesh(sub.exterior.models[0].modelId)).radius ?? null : null,
          doors,
          // Interior exit doors in interior output space.
          exits: exits.map((d) => ({ x: r3(d.centre[0]), y: r3(d.centre[1]), z: r3(-d.centre[2]) })),
        });
      }
      // Dungeon entrances are usually misc 3D models of the block (e.g. 43601 at Privateer's Hold).
      for (const m of block.misc3d) {
        const mesh = await data.lib.mesh(m.modelId);
        for (const d of mesh.doors) if (d.type === DOOR_TYPE.DUNGEON_ENTRANCE) dungeonDoors.push(placeDoor(d, miscModelMatrix(bx, by, m)));
      }
    }
  }
  let dungeon = null;
  if (info.dungeon) {
    const entry = await dungeonDetails(data, dungeonLocation(addressRegion, addressLocation), info);
    const questOnly = isMantellan(info.region, loc.index);
    const compatibility = !dungeonDoors.length && loc.width === 1 && loc.height === 1
      ? graveyardAccess(loc.blockNames[0]) : null;
    const access = questOnly ? 'quest-only' : compatibility ? GRAVEYARD_ACCESS : 'authored';
    const doors = compatibility ? [compatibility] : dungeonDoors.map((d) => outDoor(d, spawnLocal));
    dungeon = {
      ...entry, portalId: DUNGEON_PORTAL_ID, access,
      doors: questOnly ? [] : doors.map((d) => ({ ...d, enter: entry.start })),
    };
  }
  return { location: loc.townId, region: loc.regionName, regionIndex: info.region, name: loc.name, port: (loc.portTown ?? 0) !== 0, buildings, dungeon };
}

export async function dungeonBlocks(data, dungeon) {
  const out = [];
  for (const b of dungeon.blocks) out.push({ ...b, rdb: await rdbBlock(data, b.blockName) });
  return out;
}

export async function dungeonDetails(data, locationId, info = null) {
  const p = parseLocation(locationId);
  if (!p || p.kind !== 'dungeon') throw new WorldDataError(`"${locationId}" is not a dungeon location`);
  info ??= await locationInfo(data, p.region, p.location);
  const { dungeon } = info;
  if (!dungeon) throw new WorldDataError(`${info.loc.name} has no dungeon`);
  const blocks = await dungeonBlocks(data, dungeon);
  const lay = dungeonLayout(blocks, { metadataOnly: true });
  const doors = [];
  for (const block of blocks) {
    let summaries = data.rdbExits.get(block.rdb);
    if (!summaries) {
      summaries = new Map();
      data.rdbExits.set(block.rdb, summaries);
    }
    let cached = summaries.get(block.isStartingBlock);
    if (!cached) {
      const local = dungeonLayout([{ ...block, x: 0, z: 0 }]);
      cached = (await placedDoors(data.lib, local.placements.filter((placement) => !placement.actionDoor)))
        .filter((door) => door.type === DOOR_TYPE.DUNGEON_EXIT);
      summaries.set(block.isStartingBlock, cached);
    }
    for (const d of cached) doors.push({ ...d, centre: [d.centre[0] + block.x * RDB_SIDE, d.centre[1], d.centre[2] + block.z * RDB_SIDE] });
  }
  return {
    ...dungeonEntry(lay, doors, dungeon),
    target: locationId,
    name: dungeon.dungeonName,
    blocks: dungeon.blocks.length,
    blockRefs: dungeon.blocks,
    dungeonType: dungeon.dungeonType,
    sourceLocationId: dungeon.locationId,
    questMarkers: lay.questMarkers,
    questSpawns: lay.questSpawns,
  };
}

/** PlayerEnterExit.TransitionDungeonInterior: the starting block's start marker, facing away from the closest exit. */
function dungeonEntry(lay, doors, dungeon) {
  const exitDoors = doors.filter((d) => d.type === DOOR_TYPE.DUNGEON_EXIT);
  const start = lay.startMarkers[0] ?? null;
  if (!start) throw new WorldDataError(`${dungeon.dungeonName}: the starting block has no start marker`);
  const enter = lay.enterMarkers[0] ?? start;
  const ex = closest(exitDoors, start, (d) => d.centre);
  const facing = ex ? ex.normal : [0, 0, 1];
  return {
    start: { x: r3(start[0]), y: r3(start[1]), z: r3(-start[2]), yaw: r3(yawFacing(facing[0], -facing[2])) },
    newCharacterStart: { x: r3(enter[0]), y: r3(enter[1]), z: r3(-enter[2]), yaw: 0 },
    exits: exitDoors.map((d) => ({
      x: r3(d.centre[0]), y: r3(d.centre[1]), z: r3(-d.centre[2]),
      nx: r3(d.normal[0]), nz: r3(-d.normal[2]), floor: r3(d.centre[1] - d.size.height / 2),
    })),
    encounters: encounterSites(lay, dungeon),
  };
}

/**
 * Enemy sites of a dungeon in its output space, for the combat feature's encounterSites contract:
 * fixed markers `{x, y, z, monsters:[MobileTypes id], key}`, random markers `{x, y, z, table, count:1, key}` where
 * `table` is the MAPTABLE dungeon type (RandomEncounters.EncounterTables index 0-18).
 */
export function encounterSites(lay, dungeon) {
  const out = [];
  const table = dungeon.dungeonType;
  // RDBLayout classic selection seeds DFRandom with the dungeon record's own LocationId.
  const classicSeed = Number.isInteger(dungeon.dungeonLocationId) ? dungeon.dungeonLocationId : undefined;
  for (const m of lay.enemyMarkers ?? []) {
    const [x, y, z] = [r3(m.position[0]), r3(m.position[1]), r3(-m.position[2])];
    const water = Number.isInteger(m.waterLevel) && Number.isFinite(m.rawY) ? { waterLevel: m.waterLevel, markerY: m.rawY } : {};
    if (m.fixed) {
      const site = { x, y, z, monsters: [m.mobile], key: m.key, ...water };
      if (m.action === 99) site.passive = true; // EnemyReactionTypes.Passive (castle guards)
      // EnemyGenders flags apply to human types (RDBLayout.AddEnemy: type > 43).
      if (m.mobile > 43 && (m.flags & 1) === 1) site.gender = 'female';
      else if (m.mobile > 43 && (m.flags & 2) === 2) site.gender = 'male';
      out.push(site);
    } else if (table >= 0 && table <= 18) {
      out.push({ x, y, z, table, count: 1, key: m.key, slot: m.flags ?? 0, ...(classicSeed !== undefined ? { classicSeed } : {}), ...water });
    }
  }
  return out;
}

/** Load a building interior scene for `interior:` location id. */
export async function loadInterior(data, locationId) {
  const p = parseLocation(locationId);
  if (!p || p.kind !== 'interior') throw new WorldDataError(`"${locationId}" is not an interior location`);
  const info = await locationInfo(data, p.region, p.location);
  const { loc } = info;
  if (p.bx >= loc.width || p.by >= loc.height) throw new WorldDataError(`${loc.name} has no block ${p.bx},${p.by}`);
  const block = await rmbBlock(data, loc.blockNames[p.by * loc.width + p.bx]);
  const sub = block.subRecords[p.record];
  if (!sub) throw new WorldDataError(`${block.name} has no building record ${p.record}`);
  const lay = await interiorLayout(data.lib, sub, block.blockIndex, p.record);
  const scene = await buildScene(data.lib, lay.placements, { climateBase: info.climateBase, label: `${loc.name} interior` });
  const building = (NAMED_BUILDINGS.has(sub.building.buildingType)
    ? (await buildingsFor(data, info)).get(buildingPortalId(p.bx, p.by, p.record)) : null) ?? sub.building;
  return finishScene(scene, lay, {
    kind: 'interior',
    location: locationId,
    name: `${building.name || buildingTypeName(building.buildingType)}, ${loc.displayName || loc.name}`,
    region: loc.regionName,
    source: { block: block.name, blockIndex: block.blockIndex, bx: p.bx, by: p.by, record: p.record, buildingType: building.buildingType, quality: sub.building.quality, factionId: sub.building.factionId, locationType: loc.locationType },
    beds: building.buildingType === 15 ? roomBeds(sub) : [],
    // Lights and decorations of the room (flats.js); drawn by client/gameplay/scenery.js.
    flats: interiorFlats(sub),
    // Furniture, shelves and treasure markers that hold items (containers.js); used by server/rpg/containers.js.
    containers: interiorContainers({ ...sub, building: { ...sub.building, buildingType: building.buildingType } }, lay.placements),
  });
}

/** Load the dungeon scene of a location (`dungeon:` id, or region/location names). */
export async function loadDungeon(data, locationId) {
  const p = parseLocation(locationId);
  if (!p || p.kind !== 'dungeon') throw new WorldDataError(`"${locationId}" is not a dungeon location`);
  const info = await locationInfo(data, p.region, p.location);
  if (!info.dungeon) throw new WorldDataError(`${info.loc.name} has no dungeon`);
  const blocks = await dungeonBlocks(data, info.dungeon);
  const lay = dungeonLayout(blocks);
  const scene = await buildScene(data.lib, lay.placements, { climateBase: null, label: info.dungeon.dungeonName });
  const entry = dungeonEntry(lay, scene.doors.filter((d) => !lay.placements[d.placement].actionDoor), info.dungeon);
  return finishScene(scene, lay, {
    kind: 'dungeon',
    location: locationId,
    name: info.dungeon.dungeonName,
    region: info.loc.regionName,
    spawn: entry.start,
    exits: entry.exits,
    questMarkers: lay.questMarkers,
    questSpawns: lay.questSpawns,
    water: lay.water,
    containers: dungeonContainers(blocks, RDB_SIDE),
    dungeonType: info.dungeon.dungeonType,
    source: { blocks: info.dungeon.blocks.map((b) => ({ name: b.blockName, x: b.x, z: b.z, start: b.isStartingBlock })) },
  });
}

/** Render one referenced block in its local frame, with production model and exit filtering. */
export async function buildDungeonBlockScene(data, { blockName, isStartingBlock }) {
  const rdb = await rdbBlock(data, blockName);
  const lay = dungeonLayout([{ x: 0, z: 0, isStartingBlock, rdb }]);
  const scene = await buildScene(data.lib, lay.placements, { label: rdb.name });
  return finishScene(scene, lay, { kind: 'dungeon', name: rdb.name });
}

function finishScene(scene, lay, meta) {
  const actionDoors = lay.actionDoorPlacements.map((i) => ({ modelId: lay.placements[i].modelId, ...scene.ranges[i], open: meta.kind === 'interior' }));
  const doors = scene.doors
    .filter((d) => !lay.placements[d.placement].actionDoor)
    .map((d) => {
      const [x, y, z] = [d.centre[0], d.centre[1], -d.centre[2]];
      return { type: d.type, x: r3(x), y: r3(y), z: r3(z), nx: r3(d.normal[0]), nz: r3(-d.normal[2]) };
    });
  const { ranges, doors: _d, ...rest } = scene;
  const mechanisms = lay.mechanisms?.map((m) => ({ ...m, ...ranges[m.placement] }));
  return { ...meta, ...rest, doors, actionDoors, mechanisms, ground: { included: false } };
}

export { point, mul };

// DFLocation.BuildingTypes display names (DFU API/DFLocation.cs).
const BUILDING_TYPE_NAMES = [
  'Alchemist', 'House for sale', 'Armorer', 'Bank', 'Building', 'Bookseller', 'Clothing store', 'Furniture store',
  'Gem store', 'General store', 'Library', 'Guild hall', 'Pawn shop', 'Weaponsmith', 'Temple', 'Tavern', 'Palace',
  'House', 'House', 'House', 'House', 'House', 'House', 'Building', 'Ship',
];
export const buildingTypeName = (t) => BUILDING_TYPE_NAMES[t] ?? 'Building';

/** DFLocation.BuildingTypes.Ship: the cabin door on the "Your Ship" decks. */
export const SHIP_BUILDING_TYPE = 24;

/**
 * The floor a player must stand on to use a building door, or null when reach is horizontal only. A ship's
 * cabin door sits under walkable decks (2.6 m under the small ship's 5.8 m deck; 3.425 m under the large
 * ship's 6.625, 9.875 and 10.6 m decks), so its doorway's bottom edge, which is the floor of the outward
 * landing, is required. Other building doors keep horizontal reach.
 */
export const buildingDoorFloor = (b, d) => (b.buildingType === SHIP_BUILDING_TYPE && Number.isFinite(d.exit?.y) ? d.exit.y : null);

/**
 * Portal specs (server/rpg/interiors/portals.js register() input) for a locationPortals() result.
 * Building entrances carry `inner`: the door's own centre in interior space, so leaving picks the matching door.
 */
export function portalSpecs(portals) {
  const specs = [];
  for (const b of portals.buildings) {
    if (!b.exits.length) continue; // no door to leave by: not offered (DFU would strand the player)
    specs.push({
      id: b.portalId,
      from: portals.location,
      to: b.target,
      kind: 'building',
      label: b.name || buildingTypeName(b.buildingType),
      entrances: b.doors.map((d) => {
        const floor = buildingDoorFloor(b, d);
        return { x: d.x, y: d.y, z: d.z, ...(floor === null ? {} : { floor }), enter: d.enter,
          inner: { x: d.local[0], y: d.local[1], z: -d.local[2] }, exit: d.exit };
      }),
      exits: b.exits,
      meta: { block: b.block, record: b.record, buildingType: b.buildingType, buildingName: b.name || null,
        factionId: b.factionId, regionIndex: portals.regionIndex, quality: b.quality, beds: b.beds, shelves: b.shelves ?? [], encounters: [] },
    });
  }
  if (portals.dungeon?.exits.length && portals.dungeon.doors.length) {
    const d = portals.dungeon;
    specs.push({
      id: d.portalId,
      from: portals.location,
      to: d.target,
      kind: 'dungeon',
      label: d.name,
      entrances: d.doors.map((e) => ({ x: e.x, y: e.y, z: e.z, enter: e.enter, inner: e.enter, exit: e.exit })),
      exits: d.exits,
      meta: { blocks: d.blocks, dungeonType: d.dungeonType, encounters: d.encounters, access: d.access, newCharacterStart: d.newCharacterStart },
    });
  } else if (portals.dungeon?.access === 'quest-only') {
    const d = portals.dungeon;
    specs.push({ id: d.portalId, from: portals.location, to: d.target, kind: 'quest', label: d.name,
      entrances: [], exits: [], meta: { access: d.access, encounters: d.encounters } });
  }
  return specs;
}
