// Placement rules for town exteriors (doors only), building interiors and dungeons, in Unity space.
//
// Adapted from daggerfall-js-source src/world/interior/interiorLayout.js and src/world/rdbLayout.js
// (MIT, (c) 2026 Lattymoy), translations of Daggerfall Unity's Internal/DaggerfallInterior.cs (AddModels,
// AddActionDoors, IsBadInteriorModel, FindClosestEnterMarker), Utility/RDBLayout.cs (GetModelMatrix, IsActionDoor,
// AddModels, AddFlats, exit-door filtering), Internal/DaggerfallDungeon.cs (block grid) and Utility/RMBLayout.cs
// (MIT, (c) 2009-2023 Daggerfall Workshop). See THIRD_PARTY_NOTICES.txt.
//
// Departures, all recorded here:
//  - Building room doors are placed open. Dungeon action doors start closed
//    and keep an alternate pose for the shared action service.
//  - Flats (people, lights, treasure, decorations) are not drawn, exactly as the town loader does not draw them.
//    Editor markers are read for placement only.

import { WorldDataError } from '../errors.js';
import { RDB_TYPE } from './blocks.js';
import { mul, translate, rotX, rotY, rotZ, yawDegrees, point, SCALE, DOOR_TYPE } from './scene.js';
import { OP, actionRecord, actionTransform, dungeonObjectId, objectPoint, startingLock } from './dungeonActions.js';

const RMB_DIMENSION = 4096;
export const BLOCK_SIZE = RMB_DIMENSION * SCALE; // 102.4 m
export const RDB_SIDE = 2048 * SCALE; // 51.2 m
const PROPS_OFFSET_Y = -4;
const PROP_MODEL_TYPE = 3;
const EDITOR_FLATS = 199;
export const MARKER = Object.freeze({ REST: 4, ENTER: 8, START: 10, QUEST_SPAWN: 11, RANDOM_ENEMY: 15, FIXED_ENEMY: 16, QUEST_ITEM: 18 });
const DOOR_MODEL_BASE = 9000;
const EXIT_DOOR_MODEL = 70300;
const RED_BRICK_DOOR = 72100;
const OPEN_ANGLE = -90;

// DaggerfallInterior.IsBadInteriorModel: block index -> records where the misplaced model 31000 is dropped.
const BAD_INTERIOR = new Map([
  [51, [1]], [84, [8, 9, 10, 11]], [88, [2, 3, 4]], [96, [2, 5, 6]], [106, [1]], [154, [0, 1, 2]],
  [155, [0, 1, 2, 3]], [156, [0, 1]], [158, [6, 7]], [159, [0]], [169, [5, 8]], [388, [2, 3, 4, 5]], [502, [2]],
  [513, [1, 2, 12]], [514, [0, 5, 6]], [516, [0]], [534, [10]], [537, [5]], [538, [12]], [574, [10, 12]],
  [575, [12, 13]], [597, [7, 8]], [601, [6, 7]], [680, [7, 8]], [697, [0, 1, 2, 3]], [1195, [1]], [1278, [1, 2, 3, 4]],
]);
export const isBadInteriorModel = (blockIndex, recordIndex, modelId) =>
  modelId === 31000 && (BAD_INTERIOR.get(blockIndex)?.includes(recordIndex) ?? false);

// ---------------------------------------------------------------------------
// Town exterior (same transforms as client/world/town.js)

/** Unity-space frame of building sub-record `sub` in block (bx, by) of a town. */
export function subRecordFrame(bx, by, sub) {
  return mul(
    translate(bx * BLOCK_SIZE + sub.xPos * SCALE, 0, by * BLOCK_SIZE + (RMB_DIMENSION - sub.zPos) * SCALE),
    rotY(yawDegrees(sub.yRotation)),
  );
}

/** A model of an RMB sub-record (exterior or interior), relative to the sub-record frame. */
export const rmbModelMatrix = (m, yNegate = true) =>
  mul(translate(m.xPos * SCALE, (yNegate ? -m.yPos : m.yPos) * SCALE, m.zPos * SCALE), rotY(yawDegrees(m.yRotation)));

/** A misc 3D model of an RMB block, in town Unity space. */
export const miscModelMatrix = (bx, by, m) =>
  mul(
    translate(bx * BLOCK_SIZE + m.xPos * SCALE, (-m.yPos + PROPS_OFFSET_Y) * SCALE, by * BLOCK_SIZE + (m.zPos + RMB_DIMENSION) * SCALE),
    rotY(yawDegrees(m.yRotation)),
  );

// ---------------------------------------------------------------------------
// Building interior

export const hasInterior = (sub) => sub.interior.models.length > 0;

/**
 * DaggerfallInterior layout of one building sub-record, in the sub-record frame.
 * @returns {Promise<{placements, actionDoorPlacements:number[], enterMarkers:Array<number[]>}>}
 */
export async function interiorLayout(lib, sub, blockIndex, recordIndex) {
  if (!hasInterior(sub)) throw new WorldDataError('This building has no interior.');
  const placements = [];
  for (const m of sub.interior.models) {
    if (isBadInteriorModel(blockIndex, recordIndex, m.modelId)) continue;
    let matrix;
    if (m.objectType === PROP_MODEL_TYPE) {
      // Props: Y is not negated, then the model stands on its lowest vertex.
      const mesh = await lib.mesh(m.modelId);
      // DFU moves the transform by -bottomY after placing it; with a yaw-only rotation that is a world Y shift.
      matrix = mul(translate(0, -mesh.lowestY, 0), rmbModelMatrix(m, false));
    } else {
      matrix = rmbModelMatrix(m);
    }
    placements.push({ modelId: m.modelId, matrix });
  }
  const actionDoorPlacements = [];
  for (const d of sub.interior.doors) {
    actionDoorPlacements.push(placements.length);
    placements.push({
      modelId: DOOR_MODEL_BASE + (d.doorModelIndex % 5),
      matrix: mul(rmbModelMatrix(d), rotY(OPEN_ANGLE)),
      actionDoor: true,
    });
  }
  const enterMarkers = sub.interior.flats
    .filter((f) => f.archive === EDITOR_FLATS && f.record === MARKER.ENTER)
    .map((f) => [f.xPos * SCALE, -f.yPos * SCALE, f.zPos * SCALE]);
  return { placements, actionDoorPlacements, enterMarkers };
}

/** DaggerfallInterior.shopShelvesObjectGroupIndices: shelf props are models 41000 + one of these. */
export const SHOP_SHELF_INDICES = Object.freeze(new Set([5, 6, 11, 12, 13, 14, 15, 16, 17, 18, 19, 26, 28, 29, 31, 35, 36, 37, 40, 41, 42, 44, 46, 47, 48, 49, 808]));
/** RMBLayout.IsShop building types. */
export const SHOP_BUILDING_TYPES = Object.freeze(new Set([0, 2, 5, 6, 7, 8, 9, 12, 13]));

/**
 * Shop shelves of an interiorLayout() (DaggerfallInterior.AddFurnitureAction), in stable placement order and interior
 * output coordinates: {number, modelId, x, y, z, r} with the centre of the model's bounds and `r` its horizontal
 * half-extent.
 */
export async function shopShelves(lib, placements) {
  const out = [];
  for (const pl of placements) {
    if (pl.actionDoor || !SHOP_SHELF_INDICES.has(pl.modelId - 41000)) continue;
    const mesh = await lib.mesh(pl.modelId);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of mesh.planes) {
      for (const q of p.points) {
        const v = point(pl.matrix, q.x * SCALE, -q.y * SCALE, q.z * SCALE);
        for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], v[i]); hi[i] = Math.max(hi[i], v[i]); }
      }
    }
    if (!Number.isFinite(lo[0])) continue;
    const r3 = (v) => Math.round(v * 1000) / 1000;
    out.push({
      number: out.length + 1, modelId: pl.modelId,
      x: r3((lo[0] + hi[0]) / 2), y: r3(lo[1]), z: r3(-(lo[2] + hi[2]) / 2),
      r: r3(Math.max(hi[0] - lo[0], hi[2] - lo[2]) / 2),
    });
  }
  return out;
}

/** Authored RMB 199.4 rest markers, in stable record order and output coordinates. */
export function roomBeds(sub) {
  return sub.interior.flats.filter((f) => f.archive === EDITOR_FLATS && f.record === MARKER.REST)
    .map((f, i) => ({ number: i + 1, x: f.xPos * SCALE, y: -f.yPos * SCALE, z: -f.zPos * SCALE }));
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
const closest = (list, p, key = (x) => x) => {
  let best = null, bd = Infinity;
  for (const it of list) {
    const d = dist2(key(it), p);
    if (d < bd) {
      bd = d;
      best = it;
    }
  }
  return best;
};

/** Distance from a door to a landing point, as PlayerEnterExit (controller radius 0.35 + 0.4). */
export const INTERIOR_LANDING = 0.75;
/** Distance outside an exterior door, PlayerEnterExit.TransitionExterior (radius * 3). */
export const EXTERIOR_LANDING = 1.05;

/**
 * PlayerEnterExit.TransitionInterior landing: closest enter marker to the exterior door, then the closest interior
 * building door to that, landing in front of it; else above the marker. All points in the sub-record frame.
 * @param {Array} interiorDoors placed doors (sub frame) of the interior models
 * @returns {{position:number[], facing:number[]|null}}
 */
export function interiorLanding(exteriorDoorCentre, interiorDoors, enterMarkers) {
  let check = exteriorDoorCentre;
  const marker = closest(enterMarkers, check);
  if (marker) check = marker;
  const door = closest(interiorDoors.filter((d) => d.type === DOOR_TYPE.BUILDING), check, (d) => d.centre);
  if (door) {
    const n = door.normal;
    return { position: [door.centre[0] + n[0] * INTERIOR_LANDING, door.centre[1], door.centre[2] + n[2] * INTERIOR_LANDING], facing: n };
  }
  if (marker) return { position: marker, facing: null };
  throw new WorldDataError('This building has no entrance inside.');
}

export { closest, dist2 };

// ---------------------------------------------------------------------------
// Dungeon

/** DaggerfallBillboard: a block's start marker (199.10) holds its water level, -8 * SoundIndex, or 10000 for none. */
const waterLevels = new WeakMap();
export function blockWaterLevel(rdb) {
  if (waterLevels.has(rdb)) return waterLevels.get(rdb);
  const start = rdb.objects.find((o) => o.type === RDB_TYPE.Flat && o.flat.archive === EDITOR_FLATS && o.flat.record === MARKER.START);
  const level = start && start.flat.soundIndex ? -8 * start.flat.soundIndex : 10000;
  waterLevels.set(rdb, level);
  return level;
}

/** RDBLayout.GetModelMatrix: T * Rz * Rx * Ry, relative to the block. */
export function rdbModelMatrix(obj) {
  const m = obj.model;
  return mul(
    mul(mul(translate(obj.xPos * SCALE, -obj.yPos * SCALE, obj.zPos * SCALE), rotZ(yawDegrees(m.zRotation))), rotX(yawDegrees(m.xRotation))),
    rotY(yawDegrees(m.yRotation)),
  );
}

/** RDBLayout.IsActionDoor. */
export function isRdbActionDoor(rdb, ref) {
  const r = rdb.modelReferences[ref];
  if (!r || r.modelId === RED_BRICK_DOOR) return false;
  return r.description === 'DOR' || r.description === 'DDR' || r.description === 'NEW' || r.description === 'CAV';
}

/**
 * DaggerfallDungeon layout: every block at (X, 0, Z) * RDBSide; exit doors (70300) only in the starting block.
 * @param {Array<{x,z,isStartingBlock,rdb}>} blocks parsed RDB blocks with their grid positions
 */
export function dungeonLayout(blocks, { metadataOnly = false } = {}) {
  const placements = [];
  const actionDoorPlacements = [];
  const startMarkers = [];
  const enterMarkers = [];
  const enemyMarkers = [];
  const questMarkers = [];
  const questSpawns = [];
  const mechanisms = [];
  const water = [];
  for (const b of blocks) {
    const frame = translate(b.x * RDB_SIDE, 0, b.z * RDB_SIDE);
    // PlayerEnterExit/PlayerMotor: a block below its start marker's water level is flooded. Unity y = -level * scale;
    // the block spans [x, x + RDBSide] x [z, z + RDBSide] in Unity space, mirrored to output space (z -> -z).
    const level = blockWaterLevel(b.rdb);
    if (level !== 10000) {
      water.push({ minX: b.x * RDB_SIDE, maxX: (b.x + 1) * RDB_SIDE, minZ: -(b.z + 1) * RDB_SIDE, maxZ: -b.z * RDB_SIDE, y: -level * SCALE, block: b.rdb.name });
    }
    const byOffset = metadataOnly ? null : new Map(b.rdb.objects.filter((obj) => obj.position > 0).map((obj) => [obj.position, obj]));
    for (const obj of b.rdb.objects) {
      if (metadataOnly && obj.type !== RDB_TYPE.Flat) continue;
      const action = metadataOnly ? null : actionRecord(obj);
      const target = action && byOffset.get(action.nextOffset);
      const link = target ? dungeonObjectId(b, target.position) : null;
      const destination = target && action.opcode === OP.TELEPORT
        ? { ...objectPoint(b, target, frame), yaw: yawDegrees(target.model?.yRotation ?? 0) * Math.PI / 180 }
        : null;
      if (obj.type === RDB_TYPE.Model) {
        const ref = b.rdb.modelReferences[obj.model.modelIndex];
        const modelId = ref.modelId;
        if (!modelId) continue; // an unused reference slot
        if (modelId === EXIT_DOOR_MODEL && !b.isStartingBlock) continue;
        const matrix = mul(frame, rdbModelMatrix(obj));
        const door = isRdbActionDoor(b.rdb, obj.model.modelIndex);
        const linkedDoor = !door && [OP.OPEN, OP.CLOSE].includes(action?.opcode);
        const alternate = door || linkedDoor ? mul(matrix, rotY(OPEN_ANGLE)) : actionTransform(matrix, action, ref.description);
        const placement = placements.length;
        if (door) actionDoorPlacements.push(placement);
        if (door || action) {
          mechanisms.push({
            ...objectPoint(b, obj, frame), modelId, door, linkedDoor, action, link, destination,
            placement, moving: !!alternate && !door && !linkedDoor, lock: door ? startingLock(obj.model.triggerFlagStartingLock) : 0,
            forwardOnly: ref.description === 'C0X' && action?.opcode === OP.MOVE && action.axis === 11,
            mantella: modelId === 74143 && b.rdb.name === 'S0000005.RDB' && obj.position === 13737 && action?.opcode === OP.GLOBAL && action.axis === 36,
          });
        }
        placements.push({ modelId, matrix, alternate, actionDoor: door, block: b.rdb.name });
      } else if (obj.type === RDB_TYPE.Flat) {
        if (action) mechanisms.push({ ...objectPoint(b, obj, frame), action, link, destination, flat: true });
        if (obj.flat.archive !== EDITOR_FLATS) continue;
        const p = point(frame, obj.xPos * SCALE, -obj.yPos * SCALE, obj.zPos * SCALE);
        if (obj.flat.record === MARKER.START && b.isStartingBlock) startMarkers.push(p);
        else if (obj.flat.record === MARKER.ENTER && b.isStartingBlock) enterMarkers.push(p);
        else if (obj.flat.record === MARKER.QUEST_ITEM) questMarkers.push(objectPoint(b, obj, frame));
        else if (obj.flat.record === MARKER.QUEST_SPAWN) questSpawns.push(objectPoint(b, obj, frame));
        else if (obj.flat.record === MARKER.FIXED_ENEMY || obj.flat.record === MARKER.RANDOM_ENEMY) {
          // RDBLayout.AddFixedRDBEnemy: the mobile id is FactionOrMobileId & 0xff (the 8 MSBs are garbage); 99 is
          // a known invalid type and is skipped. Random markers draw from the dungeon type's encounter table.
          const mobile = (obj.flat.magnitude | (obj.flat.soundIndex << 8)) & 0xff;
          if (obj.flat.record === MARKER.FIXED_ENEMY && mobile === 99) continue;
          enemyMarkers.push({
            position: p,
            fixed: obj.flat.record === MARKER.FIXED_ENEMY,
            mobile,
            key: `${b.rdb.name}:${obj.root}/${obj.index}`,
            // Classic values RDBLayout reads with the marker: Action (99 = passive), Flags (random slot / gender),
            // raw YPos and the block start marker's water level (-8 * SoundIndex, 10000 = no water).
            action: obj.flat.action,
            flags: obj.flat.flags,
            rawY: obj.yPos,
            waterLevel: blockWaterLevel(b.rdb),
          });
        }
      }
    }
  }
  return { placements, actionDoorPlacements, startMarkers, enterMarkers, enemyMarkers, questMarkers, questSpawns, mechanisms, water };
}
