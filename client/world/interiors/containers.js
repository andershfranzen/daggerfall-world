// Container sites of building interiors and dungeons, in the scene's output space (x, y, z with z mirrored as the
// rest of the interior output). Pure data shared by the server's container feature (server/rpg/containers.js);
// nothing is drawn from it.
//
// Classification follows Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop):
//   Internal/DaggerfallInterior.cs AddFurnitureAction: model ids 41000 + {shop shelf indices} are shop shelves in
//     shops, bookshelves in libraries/guild halls/temples, and house containers in owned houses; ids 418xx and
//     41000 + {house container indices} are house containers (private furniture), stocked by model record (id % 100).
//   AddFlats: editor marker 199/19 (Treasure) in taverns and Thieves Guild / Dark Brotherhood buildings is random
//     treasure. Utility/RDBLayout.cs: 199/19 in dungeons is random treasure, flats of TEXTURE.216 are fixed treasure.

import { point } from './scene.js';

const SCALE = 0.025;
const EDITOR = 199;
const TREASURE_MARKER = 19;
const FIXED_TREASURE_ARCHIVE = 216;
const CONTAINER_OFFSET = 41000;
const HOUSE_GROUP = 418;
const SHELF_INDICES = new Set([5, 6, 11, 12, 13, 14, 15, 16, 17, 18, 19, 26, 28, 29, 31, 35, 36, 37, 40, 41, 42, 44, 46, 47, 48, 49, 808]);
const HOUSE_INDICES = new Set([3, 4, 7, 8, 27, 32, 33, 34, 35, 37, 38, 50, 51]);
// DFLocation.BuildingTypes
const SHOPS = new Set([0, 2, 5, 6, 7, 8, 9, 12, 13]); // RMBLayout.IsShop
const LIBRARY_LIKE = new Set([10, 11, 14]); // Library, GuildHall, Temple
const TAVERN = 15;
const THIEVES_GUILD = 42; // ThievesGuild.FactionId
const DARK_BROTHERHOOD = 108; // DarkBrotherhood.FactionId

const r3 = (v) => Math.round(v * 1000) / 1000;

/** 'shelf' | 'bookshelf' | 'house' | 'ownedShelf' | null for an interior model id in a building of `buildingType`. */
export function furnitureKind(modelId, buildingType) {
  const idx = modelId - CONTAINER_OFFSET;
  if (SHELF_INDICES.has(idx)) {
    if (SHOPS.has(buildingType)) return 'shelf';
    if (LIBRARY_LIKE.has(buildingType)) return 'bookshelf';
    return 'ownedShelf'; // a house container only in a house the player owns
  }
  if (Math.floor(modelId / 100) === HOUSE_GROUP || HOUSE_INDICES.has(idx)) return 'house';
  return null;
}

/**
 * Interior container sites. `placements` are interiorLayout() placements (same order as sub.interior.models minus
 * skipped bad models, each with its modelId and matrix).
 */
export function interiorContainers(sub, placements) {
  const building = sub.building ?? {};
  const out = [];
  placements.forEach((pl, i) => {
    if (pl.actionDoor) return;
    const kind = furnitureKind(pl.modelId, building.buildingType);
    if (!kind) return;
    const [x, y, z] = point(pl.matrix, 0, 0, 0);
    out.push({ id: `m${i}`, kind, modelId: pl.modelId, record: pl.modelId % 100, x: r3(x), y: r3(y), z: r3(-z) });
  });
  const treasureHere = building.buildingType === TAVERN || building.factionId === THIEVES_GUILD || building.factionId === DARK_BROTHERHOOD;
  (sub.interior?.flats ?? []).forEach((f, i) => {
    if (f.archive !== EDITOR || f.record !== TREASURE_MARKER || !treasureHere) return;
    out.push({ id: `f${i}`, kind: 'treasure', x: r3(f.xPos * SCALE), y: r3(-f.yPos * SCALE), z: r3(-f.zPos * SCALE) });
  });
  return out;
}

/** Dungeon treasure sites: random (199/19) and fixed (216/n) treasure flats of every block, keyed by block and offset. */
export function dungeonContainers(blocks, blockSide) {
  const out = [];
  for (const b of blocks) {
    for (const obj of b.rdb.objects) {
      if (obj.type !== 3 || !obj.flat) continue; // RDB_TYPE.Flat
      const random = obj.flat.archive === EDITOR && obj.flat.record === TREASURE_MARKER;
      const fixed = obj.flat.archive === FIXED_TREASURE_ARCHIVE;
      if (!random && !fixed) continue;
      const x = b.x * blockSide + obj.xPos * SCALE;
      const y = -obj.yPos * SCALE;
      const z = b.z * blockSide + obj.zPos * SCALE;
      out.push({
        id: `${b.rdb.name}:${obj.position}`, kind: 'treasure', fixed,
        ...(fixed ? { sprite: { archive: FIXED_TREASURE_ARCHIVE, record: obj.flat.record } } : {}),
        x: r3(x), y: r3(y), z: r3(-z),
      });
    }
  }
  return out;
}
