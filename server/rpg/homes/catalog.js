// Shared furnishing catalogue, placement bounds, floor, door-clearance, collision, and cap checks
// for Personal Homes (server/rpg/homes.js) and Order Halls (server/rpg/guildhall.js).

export const MAX_FURNISHINGS_PER_HOME = 40;
export const MAX_FURNISHINGS_PER_HALL = 80;
export const DOOR_CLEARANCE_M = 1.6;
export const MAX_FLOOR_INDEX = 3;
export const FLOOR_HEIGHT_M = 3.2;
export const DEFAULT_ROOM_HALF_EXTENT = 12;

export const FURNISHING_CATALOG = Object.freeze({
  'oak-table': Object.freeze({
    id: 'oak-table',
    name: 'Oak Table',
    kind: 'decor',
    category: 'Furniture',
    price: 120,
    width: 1.4,
    depth: 0.9,
    height: 0.85,
    solid: false,
    allowOverlap: false,
    maxPerSpace: 12,
    sprite: { archive: 211, record: 4 },
  }),
  'dining-chair': Object.freeze({
    id: 'dining-chair',
    name: 'Carved Chair',
    kind: 'decor',
    category: 'Furniture',
    price: 45,
    width: 0.6,
    depth: 0.6,
    height: 0.95,
    solid: false,
    allowOverlap: false,
    maxPerSpace: 16,
    sprite: { archive: 211, record: 2 },
  }),
  'brass-lamp': Object.freeze({
    id: 'brass-lamp',
    name: 'Brass Table Lamp',
    kind: 'decor',
    category: 'Lighting',
    price: 75,
    width: 0.4,
    depth: 0.4,
    height: 0.6,
    solid: false,
    allowOverlap: false,
    lightRadius: 6,
    maxPerSpace: 12,
    sprite: { archive: 210, record: 1 },
  }),
  'wall-painting': Object.freeze({
    id: 'wall-painting',
    name: 'Iliac Bay Painting',
    kind: 'decor',
    category: 'Art',
    price: 160,
    width: 0.9,
    depth: 0.2,
    height: 1.1,
    solid: false,
    allowOverlap: false,
    maxPerSpace: 12,
    sprite: { archive: 211, record: 14 },
  }),
  bookshelf: Object.freeze({
    id: 'bookshelf',
    name: "Scholar's Bookshelf",
    kind: 'decor',
    category: 'Furniture',
    price: 180,
    width: 1.2,
    depth: 0.5,
    height: 2.0,
    solid: false,
    allowOverlap: false,
    maxPerSpace: 8,
    sprite: { archive: 211, record: 8 },
  }),
  'hearth-rug': Object.freeze({
    id: 'hearth-rug',
    name: 'Woven Hearth Rug',
    kind: 'decor',
    category: 'Flooring',
    price: 90,
    width: 1.8,
    depth: 1.2,
    height: 0.05,
    solid: false,
    allowOverlap: true,
    maxPerSpace: 8,
    sprite: { archive: 211, record: 18 },
  }),
  'order-banner': Object.freeze({
    id: 'order-banner',
    name: 'Heraldic Banner',
    kind: 'decor',
    category: 'Art',
    price: 140,
    width: 0.6,
    depth: 0.25,
    height: 2.2,
    solid: false,
    allowOverlap: false,
    maxPerSpace: 10,
    sprite: { archive: 211, record: 21 },
  }),
  'storage-chest': Object.freeze({
    id: 'storage-chest',
    name: 'Ironbound Storage Chest',
    kind: 'chest',
    category: 'Storage',
    price: 250,
    width: 1.0,
    depth: 0.6,
    height: 0.7,
    solid: false,
    allowOverlap: false,
    capacity: 60,
    maxPerSpace: 4,
    sprite: { archive: 211, record: 6 },
  }),
  'house-trader': Object.freeze({
    id: 'house-trader',
    name: 'House Trader Stall',
    kind: 'trader',
    category: 'Commerce',
    price: 500,
    width: 1.3,
    depth: 0.85,
    height: 1.8,
    solid: false,
    allowOverlap: false,
    maxPerSpace: 1,
    homeOnly: true,
    sprite: { archive: 211, record: 10 },
  }),
  // Carpentry-crafted furniture items (server/rpg/professions/catalog.js FURNITURE_SPECS)
  'crafted-oak-chair': Object.freeze({
    id: 'crafted-oak-chair',
    name: 'Carved Oak Chair',
    kind: 'decor',
    category: 'Crafted Furniture',
    price: 0,
    craftedTemplate: 'crafted-oak-chair',
    width: 0.7,
    depth: 0.7,
    height: 0.95,
    solid: false,
    allowOverlap: false,
    maxPerSpace: 16,
    sprite: { archive: 211, record: 2 },
  }),
  'crafted-hearth-table': Object.freeze({
    id: 'crafted-hearth-table',
    name: 'Hearthside Table',
    kind: 'decor',
    category: 'Crafted Furniture',
    price: 0,
    craftedTemplate: 'crafted-hearth-table',
    width: 1.6,
    depth: 0.9,
    height: 0.85,
    solid: false,
    allowOverlap: false,
    maxPerSpace: 12,
    sprite: { archive: 211, record: 4 },
  }),
  'crafted-brass-lamp': Object.freeze({
    id: 'crafted-brass-lamp',
    name: 'Artisan Brass Lamp',
    kind: 'decor',
    category: 'Crafted Lighting',
    price: 0,
    craftedTemplate: 'crafted-brass-lamp',
    width: 0.4,
    depth: 0.4,
    height: 0.6,
    solid: false,
    allowOverlap: false,
    lightRadius: 6,
    maxPerSpace: 12,
    sprite: { archive: 210, record: 1 },
  }),
  'crafted-framed-painting': Object.freeze({
    id: 'crafted-framed-painting',
    name: 'Framed Iliac Painting',
    kind: 'decor',
    category: 'Crafted Art',
    price: 0,
    craftedTemplate: 'crafted-framed-painting',
    width: 1.0,
    depth: 0.2,
    height: 1.1,
    solid: false,
    allowOverlap: false,
    maxPerSpace: 12,
    sprite: { archive: 211, record: 14 },
  }),
  'crafted-guild-banner-stand': Object.freeze({
    id: 'crafted-guild-banner-stand',
    name: 'Order Banner Stand',
    kind: 'decor',
    category: 'Crafted Heraldry',
    price: 0,
    craftedTemplate: 'crafted-guild-banner-stand',
    width: 0.8,
    depth: 0.8,
    height: 2.2,
    solid: false,
    allowOverlap: false,
    maxPerSpace: 10,
    sprite: { archive: 211, record: 21 },
  }),
});

export const FURNISHING_LIST = Object.freeze(Object.values(FURNISHING_CATALOG));

const TWO_PI = Math.PI * 2;
const r3 = (n) => Math.round(n * 1000) / 1000;

export function getCatalogItem(catalogId) {
  if (typeof catalogId !== 'string') return null;
  return Object.hasOwn(FURNISHING_CATALOG, catalogId) ? FURNISHING_CATALOG[catalogId] : null;
}

export function normalizeYaw(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  let y = n % TWO_PI;
  if (y < 0) y += TWO_PI;
  return r3(y);
}

/** Rotated half-extents (hx, hz) for axis-aligned overlap check on the floor plane. */
export function footprintHalfExtents(spec, yaw) {
  const w = Number(spec?.width) || 0.6;
  const d = Number(spec?.depth) || 0.6;
  const c = Math.abs(Math.cos(yaw || 0));
  const s = Math.abs(Math.sin(yaw || 0));
  return {
    hx: (w * c + d * s) / 2,
    hz: (w * s + d * c) / 2,
  };
}

function boxesOverlap(a, b, pad = 0.05) {
  return (
    Math.abs(a.x - b.x) < a.hx + b.hx - pad
    && Math.abs(a.z - b.z) < a.hz + b.hz - pad
  );
}

/**
 * Derive conservative room bounds from interior radius or collision world.
 */
export function deriveRoomBounds(space, collisionWorld = null) {
  if (collisionWorld?.bounds && typeof collisionWorld.bounds === 'object') {
    const b = collisionWorld.bounds;
    if ([b.minX, b.maxX, b.minZ, b.maxZ].every(Number.isFinite)) {
      return { minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
    }
  }
  const rad = Number(space?.radius);
  const half = Number.isFinite(rad) && rad > 2 ? Math.min(36, Math.max(6, rad * 1.4)) : DEFAULT_ROOM_HALF_EXTENT;
  return { minX: -half, maxX: half, minZ: -half, maxZ: half };
}

/**
 * Server-authoritative placement validator shared by Personal Homes and Order Halls.
 * Confirms catalog item, room bounds, floor, placement cap, per-item cap, door clearances,
 * existing furnishing overlap, and collision geometry clearance.
 * Returns `{ ok: true, placement }` or `{ ok: false, code, reason }`.
 */
export function validateFurnishingPlacement({
  space,
  catalogId,
  x,
  y,
  z,
  yaw = 0,
  floor = 0,
  existing = [],
  ignoreId = null,
  maxTotal = MAX_FURNISHINGS_PER_HOME,
  isOrderHall = false,
  doorPositions = [],
  collisionWorld = null,
}) {
  const spec = getCatalogItem(catalogId);
  if (!spec) {
    return { ok: false, code: 'UNKNOWN_FURNISHING', reason: `Unknown furnishing "${catalogId}".` };
  }
  if (isOrderHall && spec.homeOnly) {
    return { ok: false, code: 'HOME_ONLY_FURNISHING', reason: `${spec.name} can only be placed in a personal home.` };
  }
  const nx = Number(x);
  const nz = Number(z);
  const nfloor = Number.isInteger(Number(floor)) ? Number(floor) : NaN;
  if (!Number.isFinite(nx) || !Number.isFinite(nz)) {
    return { ok: false, code: 'INVALID_COORDS', reason: 'Furnishing coordinates must be finite numbers.' };
  }
  if (!Number.isInteger(nfloor) || nfloor < 0 || nfloor > MAX_FLOOR_INDEX) {
    return { ok: false, code: 'INVALID_FLOOR', reason: `Floor must be between 0 and ${MAX_FLOOR_INDEX}.` };
  }
  let ny = y == null ? nfloor * FLOOR_HEIGHT_M : Number(y);
  if (!Number.isFinite(ny)) {
    return { ok: false, code: 'INVALID_COORDS', reason: 'Furnishing elevation must be finite.' };
  }
  const nyaw = normalizeYaw(yaw);

  // Cap checks (only count other placements when moving an existing one).
  const others = existing.filter((f) => f && f.id !== ignoreId);
  if (ignoreId == null && others.length >= maxTotal) {
    return { ok: false, code: 'FURNISHING_CAP', reason: `Furnishing limit reached (${maxTotal}).` };
  }
  if (spec.maxPerSpace != null) {
    const sameCount = others.filter((f) => f.catalogId === spec.id).length;
    if (sameCount >= spec.maxPerSpace) {
      return {
        ok: false,
        code: 'FURNISHING_TYPE_CAP',
        reason: `You can place at most ${spec.maxPerSpace} ${spec.name}${spec.maxPerSpace === 1 ? '' : 's'} here.`,
      };
    }
  }

  // Room bounds check.
  const bounds = deriveRoomBounds(space, collisionWorld);
  const ext = footprintHalfExtents(spec, nyaw);
  if (
    nx - ext.hx < bounds.minX
    || nx + ext.hx > bounds.maxX
    || nz - ext.hz < bounds.minZ
    || nz + ext.hz > bounds.maxZ
  ) {
    return { ok: false, code: 'OUT_OF_BOUNDS', reason: `${spec.name} does not fit within the room bounds.` };
  }

  // Door clearance check.
  const doors = Array.isArray(doorPositions) && doorPositions.length
    ? doorPositions
    : [{ x: 0, z: 0, floor: 0 }];
  for (const d of doors) {
    if (!d || !Number.isFinite(d.x) || !Number.isFinite(d.z)) continue;
    const doorFloor = Number.isInteger(d.floor) ? d.floor : 0;
    if (doorFloor !== nfloor) continue;
    const dist = Math.hypot(nx - d.x, nz - d.z);
    if (dist < DOOR_CLEARANCE_M) {
      return {
        ok: false,
        code: 'DOOR_CLEARANCE',
        reason: `${spec.name} is too close to the doorway (leave at least ${DOOR_CLEARANCE_M}m clear).`,
      };
    }
  }

  // Collision world floor + geometry clearance check (when collision service loaded this interior).
  if (collisionWorld) {
    if (typeof collisionWorld.heightAt === 'function') {
      const groundY = collisionWorld.heightAt(nx, nz, ny);
      if (groundY == null || !Number.isFinite(groundY)) {
        return { ok: false, code: 'NO_FLOOR', reason: 'There is no solid floor at that spot.' };
      }
      if (Math.abs(groundY - ny) > 1.5) {
        return { ok: false, code: 'FLOOR_MISMATCH', reason: 'That position does not match the selected floor level.' };
      }
      ny = r3(groundY);
    }
    if (typeof collisionWorld.isClear === 'function' && !collisionWorld.isClear(nx, nz, ny)) {
      return { ok: false, code: 'COLLISION_BLOCKED', reason: `${spec.name} overlaps walls or interior geometry.` };
    }
  }

  // Overlap check against other furnishings on the same floor (skipping flat rugs).
  if (!spec.allowOverlap) {
    const candidate = { x: nx, z: nz, hx: ext.hx, hz: ext.hz };
    for (const f of others) {
      if ((f.floor ?? 0) !== nfloor) continue;
      const otherSpec = getCatalogItem(f.catalogId);
      if (otherSpec?.allowOverlap) continue;
      const oext = footprintHalfExtents(otherSpec ?? { width: 0.8, depth: 0.8 }, f.yaw ?? 0);
      if (boxesOverlap(candidate, { x: f.x, z: f.z, hx: oext.hx, hz: oext.hz })) {
        return { ok: false, code: 'FURNISHING_OVERLAP', reason: `${spec.name} overlaps with ${f.name || 'another furnishing'}.` };
      }
    }
  }

  return {
    ok: true,
    spec,
    placement: {
      catalogId: spec.id,
      name: spec.name,
      kind: spec.kind,
      x: r3(nx),
      y: r3(ny),
      z: r3(nz),
      yaw: nyaw,
      floor: nfloor,
    },
  };
}

/** Refund value when removing or selling removable furniture (70% of catalog price). */
export function furnishingRefundValue(catalogId) {
  const spec = getCatalogItem(catalogId);
  return spec ? Math.trunc(spec.price * 0.7) : 0;
}
