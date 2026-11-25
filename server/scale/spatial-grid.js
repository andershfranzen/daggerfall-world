// O(1)-cell spatial hash grid and deterministic Area-of-Interest (AOI) culling.
//
// Turns worst-case O(N^2) peer visibility and broadcast in packed towns into O(N * K),
// keeping tick + AOI queries under a few milliseconds even with 500+ players in one city.
//
// Priority order for any viewer:
//   1. Priority peers in the same scene (party members, active trade/duel/combat partners),
//      always included regardless of distance or crowd cap.
//   2. Nearest non-priority peers within `viewRadius`, up to `maxVisiblePeers` total.
// Ties break deterministically by peer id so crowd culling never flickers between ticks.

export const DEFAULT_CELL_SIZE = 32; // meters
export const DEFAULT_VIEW_RADIUS = 128; // meters
export const DEFAULT_MAX_VISIBLE_PEERS = 64;

// Encode 2D integer cell coordinates (cx, cz) into a single safe JS integer key (zero string allocations).
// Supports cell coordinates in [-4_194_304, +4_194_303] (~134 million meters at 32 m cell size).
const CELL_BIAS = 0x400000; // 4,194,304
const CELL_STRIDE = 0x800000; // 8,388,608

function cellKey(cx, cz) {
  return (cx + CELL_BIAS) * CELL_STRIDE + (cz + CELL_BIAS);
}

function compareId(a, b) {
  if (a === b) return 0;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function compareCandidate(a, b) {
  return a.distSq - b.distSq || compareId(a.entry.id, b.entry.id);
}

export class SpatialGrid {
  /**
   * @param {object} [options]
   * @param {number} [options.cellSize=32]
   * @param {number} [options.viewRadius=128]
   * @param {number} [options.maxVisiblePeers=64] 0 or Infinity disables the crowd cap.
   */
  constructor(options = {}) {
    const cellSize = Number(options.cellSize ?? DEFAULT_CELL_SIZE);
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new RangeError(`SpatialGrid cellSize must be a positive finite number, got ${options.cellSize}`);
    }
    const viewRadius = Number(options.viewRadius ?? DEFAULT_VIEW_RADIUS);
    if (!Number.isFinite(viewRadius) || viewRadius < 0) {
      throw new RangeError(`SpatialGrid viewRadius must be a non-negative finite number, got ${options.viewRadius}`);
    }
    const rawCap = options.maxVisiblePeers ?? DEFAULT_MAX_VISIBLE_PEERS;
    const maxVisiblePeers = rawCap === 0 || rawCap === Infinity ? Infinity : Number(rawCap);
    if (maxVisiblePeers !== Infinity && (!Number.isInteger(maxVisiblePeers) || maxVisiblePeers < 0)) {
      throw new RangeError(`SpatialGrid maxVisiblePeers must be a non-negative integer or Infinity, got ${rawCap}`);
    }

    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
    this.viewRadius = viewRadius;
    this.maxVisiblePeers = maxVisiblePeers;

    /** @type {Map<string|number, { id: string|number, x: number, z: number, cx: number, cz: number, key: number, ref: any }>} */
    this.entries = new Map();
    /** @type {Map<number, Set<object>>} */
    this.cells = new Map();
  }

  get size() {
    return this.entries.size;
  }

  get cellCount() {
    return this.cells.size;
  }

  /** Insert or update an entity's 2D position in O(1) time. */
  upsert(entity, x = entity?.x ?? 0, z = entity?.z ?? 0) {
    if (!entity || entity.id === undefined || entity.id === null) {
      throw new TypeError('SpatialGrid.upsert requires an entity with an id');
    }
    const nx = Number.isFinite(x) ? x : 0;
    const nz = Number.isFinite(z) ? z : 0;
    const cx = Math.floor(nx * this.invCellSize);
    const cz = Math.floor(nz * this.invCellSize);
    const key = cellKey(cx, cz);

    let entry = this.entries.get(entity.id);
    if (entry) {
      entry.x = nx;
      entry.z = nz;
      entry.ref = entity;
      if (entry.key !== key) {
        const oldBucket = this.cells.get(entry.key);
        if (oldBucket) {
          oldBucket.delete(entry);
          if (oldBucket.size === 0) this.cells.delete(entry.key);
        }
        entry.cx = cx;
        entry.cz = cz;
        entry.key = key;
        let bucket = this.cells.get(key);
        if (!bucket) this.cells.set(key, (bucket = new Set()));
        bucket.add(entry);
      }
      return entry;
    }

    entry = { id: entity.id, x: nx, z: nz, cx, cz, key, ref: entity };
    this.entries.set(entity.id, entry);
    let bucket = this.cells.get(key);
    if (!bucket) this.cells.set(key, (bucket = new Set()));
    bucket.add(entry);
    return entry;
  }

  /** Remove an entity by id or entity object in O(1) time. */
  remove(idOrEntity) {
    const id = idOrEntity && typeof idOrEntity === 'object' ? idOrEntity.id : idOrEntity;
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    const bucket = this.cells.get(entry.key);
    if (bucket) {
      bucket.delete(entry);
      if (bucket.size === 0) this.cells.delete(entry.key);
    }
    return true;
  }

  has(id) {
    return this.entries.has(id);
  }

  /** Ids of every indexed entity (server/game.js prunes players no longer in the scene). */
  ids() {
    return this.entries.keys();
  }

  clear() {
    this.entries.clear();
    this.cells.clear();
  }

  /** Replace grid contents from an iterable of entities. */
  rebuild(entities) {
    this.clear();
    for (const entity of entities) {
      if (entity && entity.id !== undefined && entity.id !== null) {
        this.upsert(entity, entity.x, entity.z);
      }
    }
    return this;
  }

  /**
   * Query visible peers for `viewer` in deterministic priority order:
   *   1. Priority peers (party members, trade/duel/combat partners) in this grid,
   *      sorted by distance then id. Always included regardless of crowd cap or radius.
   *   2. Nearest non-priority peers within `viewRadius`, sorted by distance then id,
   *      filling remaining slots up to `maxVisiblePeers`.
   *
   * @param {object} viewer - `{ id, x, z }`
   * @param {object} [options]
   * @param {number} [options.viewRadius]
   * @param {number} [options.maxVisiblePeers]
   * @param {Iterable<string|number>|Set<string|number>} [options.priorityIds]
   * @param {(peer: any, viewer: any) => boolean} [options.isPriority]
   * @param {(peer: any, viewer: any) => boolean} [options.filter]
   * @param {boolean} [options.includeSelf=false]
   * @param {boolean} [options.includeArriving=false]
   * @returns {any[]} Ordered list of peer entity references.
   */
  query(viewer, options = {}) {
    if (!viewer) return [];
    const viewerId = viewer.id;
    const vx = Number.isFinite(viewer.x) ? viewer.x : 0;
    const vz = Number.isFinite(viewer.z) ? viewer.z : 0;
    const radius = options.viewRadius ?? this.viewRadius;
    const radiusSq = radius * radius;
    const rawCap = options.maxVisiblePeers ?? this.maxVisiblePeers;
    const cap = rawCap === 0 || rawCap === Infinity ? Infinity : rawCap;
    const includeSelf = options.includeSelf === true;
    const includeArriving = options.includeArriving === true;
    const filter = typeof options.filter === 'function' ? options.filter : null;
    const isPriority = typeof options.isPriority === 'function' ? options.isPriority : null;

    const prioritySet = options.priorityIds
      ? (options.priorityIds instanceof Set ? options.priorityIds : new Set(options.priorityIds))
      : null;

    const eligible = (entry) => {
      if (!includeSelf && entry.id === viewerId) return false;
      if (!includeArriving && entry.ref?.arriving === true && entry.id !== viewerId) return false;
      if (filter && !filter(entry.ref, viewer)) return false;
      return true;
    };

    // 1. Collect explicit priority peers (O(|priorityIds|) — never missed even outside viewRadius).
    const seenPriority = new Set();
    const priorityCandidates = [];
    if (prioritySet && prioritySet.size > 0) {
      for (const pid of prioritySet) {
        if (!includeSelf && pid === viewerId) continue;
        const entry = this.entries.get(pid);
        if (!entry || !eligible(entry)) continue;
        seenPriority.add(pid);
        const dx = entry.x - vx;
        const dz = entry.z - vz;
        priorityCandidates.push({ entry, distSq: dx * dx + dz * dz });
      }
    }

    // 2. Scan overlapping grid cells within viewRadius.
    const minCx = Math.floor((vx - radius) * this.invCellSize);
    const maxCx = Math.floor((vx + radius) * this.invCellSize);
    const minCz = Math.floor((vz - radius) * this.invCellSize);
    const maxCz = Math.floor((vz + radius) * this.invCellSize);

    const nearbyCandidates = [];
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const bucket = this.cells.get(cellKey(cx, cz));
        if (!bucket) continue;
        for (const entry of bucket) {
          if (seenPriority.has(entry.id)) continue;
          if (!eligible(entry)) continue;
          const dx = entry.x - vx;
          const dz = entry.z - vz;
          const distSq = dx * dx + dz * dz;
          if (isPriority && isPriority(entry.ref, viewer)) {
            seenPriority.add(entry.id);
            priorityCandidates.push({ entry, distSq });
            continue;
          }
          if (distSq <= radiusSq) {
            nearbyCandidates.push({ entry, distSq });
          }
        }
      }
    }

    if (priorityCandidates.length > 1) priorityCandidates.sort(compareCandidate);

    const result = [];
    for (let i = 0; i < priorityCandidates.length; i++) {
      result.push(priorityCandidates[i].entry.ref);
    }

    const remaining = cap === Infinity ? nearbyCandidates.length : Math.max(0, cap - result.length);
    if (remaining > 0 && nearbyCandidates.length > 0) {
      if (nearbyCandidates.length > 1) nearbyCandidates.sort(compareCandidate);
      const take = Math.min(remaining, nearbyCandidates.length);
      for (let i = 0; i < take; i++) {
        result.push(nearbyCandidates[i].entry.ref);
      }
    }

    return result;
  }
}

export function createSpatialGrid(options) {
  return new SpatialGrid(options);
}

/**
 * Multi-scene spatial index: maintains one SpatialGrid per presence scene (town, dungeon, interior,
 * wilderness pixel, ship deck) and moves entities seamlessly when they change scenes.
 */
export function createSceneSpatialIndex(options = {}) {
  const scenes = new Map(); // sceneId -> SpatialGrid
  const entityScene = new Map(); // entityId -> sceneId

  function getOrCreate(sceneId) {
    let grid = scenes.get(sceneId);
    if (!grid) {
      grid = new SpatialGrid(options);
      scenes.set(sceneId, grid);
    }
    return grid;
  }

  return {
    upsert(sceneId, entity) {
      if (!entity || entity.id === undefined || entity.id === null) {
        throw new TypeError('SceneSpatialIndex.upsert requires an entity with an id');
      }
      const prevScene = entityScene.get(entity.id);
      if (prevScene !== undefined && prevScene !== sceneId) {
        const oldGrid = scenes.get(prevScene);
        if (oldGrid) {
          oldGrid.remove(entity.id);
          if (oldGrid.size === 0) scenes.delete(prevScene);
        }
      }
      entityScene.set(entity.id, sceneId);
      return getOrCreate(sceneId).upsert(entity, entity.x, entity.z);
    },
    remove(idOrEntity) {
      const id = idOrEntity && typeof idOrEntity === 'object' ? idOrEntity.id : idOrEntity;
      const prevScene = entityScene.get(id);
      if (prevScene === undefined) return false;
      entityScene.delete(id);
      const grid = scenes.get(prevScene);
      if (!grid) return false;
      const removed = grid.remove(id);
      if (grid.size === 0) scenes.delete(prevScene);
      return removed;
    },
    query(sceneId, viewer, queryOptions) {
      const grid = scenes.get(sceneId);
      return grid ? grid.query(viewer, queryOptions) : [];
    },
    gridOf(sceneId) {
      return scenes.get(sceneId) ?? null;
    },
    sceneCount() {
      return scenes.size;
    },
    size() {
      return entityScene.size;
    },
    clear() {
      scenes.clear();
      entityScene.clear();
    },
  };
}
