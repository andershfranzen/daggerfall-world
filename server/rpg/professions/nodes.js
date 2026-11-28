// Gathering nodes (§3): authored regional/biome placement + deterministic fallback,
// persistent depletion & UTC respawn deadlines, reach/floor/LOS/tool/rank validation,
// and movement/combat interruption.
import { createHash } from 'node:crypto';
import { PROFESSIONS, TOOL_KINDS, findEquippedTool, toolTierOf } from './catalog.js';

export const GATHER_REACH = 3.5; // metres
export const FLOOR_TOLERANCE = 2.5; // metres vertical floor check
export const MOVE_INTERRUPT_DIST = 0.6; // metres moved cancels active gathering
export const NODE_WORLD_PREFIX = 'prof:node:';

const MARKERS = Object.freeze({
  mining: Object.freeze({ kind: 'ore', glyph: '◆', color: '#7fa6b2' }),
  woodcutting: Object.freeze({ kind: 'tree', glyph: '▲', color: '#68b074' }),
  herbalism: Object.freeze({ kind: 'herb', glyph: '❀', color: '#7bc7a4' }),
  fishing: Object.freeze({ kind: 'fish', glyph: '≈', color: '#5fa3a5' }),
});

/** Authored node templates per archetype. */
export const NODE_ARCHETYPES = Object.freeze({
  'iron-vein': {
    profession: 'mining', name: 'Iron Ore Vein', requiredTool: 'pickaxe', minRank: 1, minToolTier: 1,
    maxCharges: 3, gatherDurationMs: 2200, respawnMs: 120_000, toolWear: 2, xp: 18,
    yields: [{ template: 'iron-ore', minQty: 1, maxQty: 2 }, { template: 'coal-lump', minQty: 1, maxQty: 1, chance: 0.6 }],
  },
  'silver-vein': {
    profession: 'mining', name: 'Silver Seam', requiredTool: 'pickaxe', minRank: 3, minToolTier: 2,
    maxCharges: 3, gatherDurationMs: 2800, respawnMs: 180_000, toolWear: 3, xp: 34,
    yields: [{ template: 'silver-ore', minQty: 1, maxQty: 2 }, { template: 'coal-lump', minQty: 1, maxQty: 1, chance: 0.5 }],
  },
  'rough-timber-stand': {
    profession: 'woodcutting', name: 'Pine & Timber Stand', requiredTool: 'hatchet', minRank: 1, minToolTier: 1,
    maxCharges: 3, gatherDurationMs: 2000, respawnMs: 120_000, toolWear: 2, xp: 16,
    yields: [{ template: 'rough-timber', minQty: 1, maxQty: 2 }, { template: 'resin-sap', minQty: 1, maxQty: 1, chance: 0.45 }],
  },
  'oak-timber-stand': {
    profession: 'woodcutting', name: 'Gnarled Oak Stand', requiredTool: 'hatchet', minRank: 2, minToolTier: 1,
    maxCharges: 3, gatherDurationMs: 2600, respawnMs: 160_000, toolWear: 3, xp: 28,
    yields: [{ template: 'oak-timber', minQty: 1, maxQty: 2 }, { template: 'resin-sap', minQty: 1, maxQty: 1, chance: 0.65 }],
  },
  'meadow-herb-patch': {
    profession: 'herbalism', name: 'Wild Sage & Berry Patch', requiredTool: 'sickle', minRank: 1, minToolTier: 1,
    maxCharges: 3, gatherDurationMs: 1800, respawnMs: 90_000, toolWear: 1, xp: 15,
    yields: [
      { template: 'wild-sage', minQty: 1, maxQty: 2 },
      { template: 'red-berries', minQty: 1, maxQty: 1, chance: 0.7 },
      { template: 'green-leaves', minQty: 1, maxQty: 2, chance: 0.6 },
    ],
  },
  'highland-herb-patch': {
    profession: 'herbalism', name: 'Highland Thyme & Aloe Cluster', requiredTool: 'sickle', minRank: 2, minToolTier: 1,
    maxCharges: 3, gatherDurationMs: 2200, respawnMs: 135_000, toolWear: 2, xp: 26,
    yields: [
      { template: 'mountain-thyme', minQty: 1, maxQty: 2 },
      { template: 'aloe', minQty: 1, maxQty: 1, chance: 0.75 },
      { template: 'red-flowers', minQty: 1, maxQty: 1, chance: 0.5 },
    ],
  },
  'creek-fishing-spot': {
    profession: 'fishing', name: 'Clear Creek Pool', requiredTool: 'rod', minRank: 1, minToolTier: 1,
    maxCharges: 4, gatherDurationMs: 2400, respawnMs: 110_000, toolWear: 1, xp: 17,
    yields: [{ template: 'river-trout', minQty: 1, maxQty: 2 }, { template: 'coastal-kelp', minQty: 1, maxQty: 1, chance: 0.5 }],
  },
  'bay-fishing-spot': {
    profession: 'fishing', name: 'Iliac Bay Shoal', requiredTool: 'rod', minRank: 2, minToolTier: 1,
    maxCharges: 4, gatherDurationMs: 2800, respawnMs: 150_000, toolWear: 2, xp: 30,
    yields: [{ template: 'iliac-perch', minQty: 1, maxQty: 2 }, { template: 'bay-cod', minQty: 1, maxQty: 1, chance: 0.45 }],
  },
});

function buildNode(id, location, archetypeKey, x, y, z, overrides = {}) {
  const arch = NODE_ARCHETYPES[archetypeKey];
  if (!arch) throw new Error(`Unknown node archetype "${archetypeKey}"`);
  return Object.freeze({
    id,
    location,
    archetype: archetypeKey,
    x,
    y,
    z,
    ...arch,
    ...overrides,
    marker: MARKERS[arch.profession],
    yields: Object.freeze((overrides.yields ?? arch.yields).map((g) => Object.freeze({ ...g }))),
  });
}

/**
 * Authored gathering nodes across major Iliac Bay regions/biomes.
 * Every starter scene has at least two nodes per track so multiple players can gather concurrently.
 */
export const AUTHORED_NODES = Object.freeze({
  'town:Daggerfall/Gothway Garden': Object.freeze([
    buildNode('node:gothway:iron-1', 'town:Daggerfall/Gothway Garden', 'iron-vein', 12, 0, -8),
    buildNode('node:gothway:iron-2', 'town:Daggerfall/Gothway Garden', 'iron-vein', 18, 0, -14),
    buildNode('node:gothway:timber-1', 'town:Daggerfall/Gothway Garden', 'rough-timber-stand', -12, 0, -10),
    buildNode('node:gothway:timber-2', 'town:Daggerfall/Gothway Garden', 'oak-timber-stand', -18, 0, -16),
    buildNode('node:gothway:herb-1', 'town:Daggerfall/Gothway Garden', 'meadow-herb-patch', 8, 0, 12),
    buildNode('node:gothway:herb-2', 'town:Daggerfall/Gothway Garden', 'highland-herb-patch', 15, 0, 16),
    buildNode('node:gothway:fish-1', 'town:Daggerfall/Gothway Garden', 'creek-fishing-spot', -10, 0, 14),
    buildNode('node:gothway:fish-2', 'town:Daggerfall/Gothway Garden', 'bay-fishing-spot', -17, 0, 18),
  ]),
  'town:Daggerfall/Daggerfall': Object.freeze([
    buildNode('node:daggerfall:iron-1', 'town:Daggerfall/Daggerfall', 'iron-vein', 24, 0, -18),
    buildNode('node:daggerfall:silver-1', 'town:Daggerfall/Daggerfall', 'silver-vein', 32, 0, -24),
    buildNode('node:daggerfall:timber-1', 'town:Daggerfall/Daggerfall', 'oak-timber-stand', -22, 0, -15),
    buildNode('node:daggerfall:herb-1', 'town:Daggerfall/Daggerfall', 'meadow-herb-patch', 14, 0, 22),
    buildNode('node:daggerfall:fish-1', 'town:Daggerfall/Daggerfall', 'bay-fishing-spot', -24, 0, 24),
  ]),
  'town:Wayrest/Wayrest': Object.freeze([
    buildNode('node:wayrest:iron-1', 'town:Wayrest/Wayrest', 'iron-vein', 20, 0, -16),
    buildNode('node:wayrest:timber-1', 'town:Wayrest/Wayrest', 'oak-timber-stand', -16, 0, -20),
    buildNode('node:wayrest:herb-1', 'town:Wayrest/Wayrest', 'meadow-herb-patch', 16, 0, 18),
    buildNode('node:wayrest:fish-1', 'town:Wayrest/Wayrest', 'bay-fishing-spot', -14, 0, 26),
    buildNode('node:wayrest:fish-2', 'town:Wayrest/Wayrest', 'creek-fishing-spot', -22, 0, 28),
  ]),
  'town:Sentinel/Sentinel': Object.freeze([
    buildNode('node:sentinel:silver-1', 'town:Sentinel/Sentinel', 'silver-vein', 22, 0, -18),
    buildNode('node:sentinel:herb-1', 'town:Sentinel/Sentinel', 'highland-herb-patch', 14, 0, 16, { name: 'Desert Aloe & Flower Patch' }),
    buildNode('node:sentinel:timber-1', 'town:Sentinel/Sentinel', 'rough-timber-stand', -18, 0, -14, { name: 'Dry Scrub Timber' }),
    buildNode('node:sentinel:fish-1', 'town:Sentinel/Sentinel', 'bay-fishing-spot', -20, 0, 22),
  ]),
  'town:Wrothgarian Mountains/Crossway': Object.freeze([
    buildNode('node:wrothgar:iron-1', 'town:Wrothgarian Mountains/Crossway', 'iron-vein', 14, 0, -12),
    buildNode('node:wrothgar:silver-1', 'town:Wrothgarian Mountains/Crossway', 'silver-vein', 20, 0, -18),
    buildNode('node:wrothgar:herb-1', 'town:Wrothgarian Mountains/Crossway', 'highland-herb-patch', -12, 0, 12),
    buildNode('node:wrothgar:timber-1', 'town:Wrothgarian Mountains/Crossway', 'rough-timber-stand', -16, 0, -10),
  ]),
});

const AUTHORED_BY_ID = new Map();
for (const list of Object.values(AUTHORED_NODES)) {
  for (const n of list) AUTHORED_BY_ID.set(n.id, n);
}

function hashSeed(str) {
  const buf = createHash('sha256').update(String(str)).digest();
  return buf.readUInt32BE(0);
}

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const proceduralCache = new Map();

/**
 * Returns deterministic resource nodes for any location (authored towns, or deterministic
 * biome-derived wilderness/town fallback; interiors & dungeons return empty by default).
 */
export function nodesForLocation(location) {
  if (!location || typeof location !== 'string') return [];
  if (AUTHORED_NODES[location]) return AUTHORED_NODES[location];
  if (location.startsWith('interior:') || location.startsWith('dungeon:')) return [];
  if (proceduralCache.has(location)) return proceduralCache.get(location);

  const h = createHash('sha256').update(`nodes:${location}`).digest('hex').slice(0, 8);
  const rand = prng(hashSeed(`nodes:${location}`));
  const lower = location.toLowerCase();
  const isMountain = lower.includes('mountain') || lower.includes('hill') || lower.includes('bluff') || lower.includes('cliff');
  const isCoast = lower.includes('bay') || lower.includes('coast') || lower.includes('isle') || lower.includes('betony') || lower.includes('river');
  const isForest = lower.includes('forest') || lower.includes('wood') || lower.includes('moor');

  const picks = [
    isMountain ? 'silver-vein' : 'iron-vein',
    'iron-vein',
    isForest ? 'oak-timber-stand' : 'rough-timber-stand',
    isMountain ? 'highland-herb-patch' : 'meadow-herb-patch',
    isCoast ? 'bay-fishing-spot' : 'creek-fishing-spot',
  ];
  const nodes = picks.map((arch, idx) => {
    const angle = (idx / picks.length) * Math.PI * 2 + rand() * 0.5;
    const radius = 14 + Math.round(rand() * 14);
    const x = Math.round(Math.cos(angle) * radius * 10) / 10;
    const z = Math.round(Math.sin(angle) * radius * 10) / 10;
    return buildNode(`node:${h}:${idx + 1}`, location, arch, x, 0, z);
  });
  Object.freeze(nodes);
  if (proceduralCache.size > 256) proceduralCache.clear();
  proceduralCache.set(location, nodes);
  return nodes;
}

export function findNodeDefinition(nodeId, locationHint = null) {
  if (!nodeId || typeof nodeId !== 'string') return null;
  if (AUTHORED_BY_ID.has(nodeId)) return AUTHORED_BY_ID.get(nodeId);
  if (locationHint) {
    const found = nodesForLocation(locationHint).find((n) => n.id === nodeId);
    if (found) return found;
  }
  for (const list of proceduralCache.values()) {
    const found = list.find((n) => n.id === nodeId);
    if (found) return found;
  }
  return null;
}

export function nodeWorldKey(nodeId) {
  return `${NODE_WORLD_PREFIX}${nodeId}`;
}

/**
 * Resolves live node depletion/recovery state from a persisted record + current UTC epoch ms.
 * Unloaded nodes automatically recover when `nowUtc >= persisted.respawnAt`.
 */
export function resolveNodeState(nodeDef, persisted, nowUtc) {
  const maxCharges = nodeDef.maxCharges;
  if (!persisted || typeof persisted !== 'object') {
    return {
      nodeId: nodeDef.id,
      location: nodeDef.location,
      charges: maxCharges,
      maxCharges,
      depletedAt: null,
      respawnAt: null,
      revision: 0,
      lastHarvesterId: null,
    };
  }
  const respawnAt = Number.isFinite(persisted.respawnAt) ? persisted.respawnAt : null;
  if (respawnAt !== null && nowUtc >= respawnAt) {
    return {
      nodeId: nodeDef.id,
      location: nodeDef.location,
      charges: maxCharges,
      maxCharges,
      depletedAt: null,
      respawnAt: null,
      revision: Math.max(0, Math.trunc(Number(persisted.revision) || 0)) + 1,
      lastHarvesterId: persisted.lastHarvesterId ?? null,
    };
  }
  const charges = Math.max(0, Math.min(maxCharges, Math.trunc(Number(persisted.charges ?? maxCharges))));
  return {
    nodeId: nodeDef.id,
    location: nodeDef.location,
    charges,
    maxCharges,
    depletedAt: Number.isFinite(persisted.depletedAt) ? persisted.depletedAt : null,
    respawnAt,
    revision: Math.max(0, Math.trunc(Number(persisted.revision) || 0)),
    lastHarvesterId: persisted.lastHarvesterId ?? null,
  };
}

/** Public view of a node for client HUD/scene snapshots. */
export function publicNodeView(nodeDef, state, nowUtc) {
  const depleted = state.charges <= 0;
  const respawnRemainingMs = depleted && state.respawnAt != null ? Math.max(0, state.respawnAt - nowUtc) : 0;
  return {
    id: nodeDef.id,
    kind: 'resource_node',
    location: nodeDef.location,
    name: nodeDef.name,
    profession: nodeDef.profession,
    professionName: PROFESSIONS[nodeDef.profession]?.name ?? nodeDef.profession,
    requiredTool: nodeDef.requiredTool,
    requiredToolLabel: TOOL_KINDS[nodeDef.requiredTool]?.label ?? nodeDef.requiredTool,
    minRank: nodeDef.minRank,
    minToolTier: nodeDef.minToolTier,
    x: nodeDef.x,
    y: nodeDef.y,
    z: nodeDef.z,
    charges: state.charges,
    maxCharges: state.maxCharges,
    depleted,
    respawnAt: state.respawnAt,
    respawnRemainingMs,
    gatherDurationMs: nodeDef.gatherDurationMs,
    marker: nodeDef.marker,
    revision: state.revision,
  };
}

/** Compute deterministic or RNG-backed harvest yield items for one harvest charge. */
export function rollNodeYields(nodeDef, professionRank, rng = Math.random) {
  const out = [];
  for (const entry of nodeDef.yields) {
    if (entry.chance != null && rng() > entry.chance) continue;
    const span = Math.max(0, (entry.maxQty ?? entry.minQty) - entry.minQty);
    let qty = entry.minQty + (span > 0 ? Math.floor(rng() * (span + 1)) : 0);
    // High profession rank grants a modest deterministic bonus chance on primary material (capped +1).
    if (entry.chance == null && professionRank >= nodeDef.minRank + 3 && rng() < 0.35) qty += 1;
    if (qty > 0) out.push({ template: entry.template, quantity: qty });
  }
  if (!out.length && nodeDef.yields.length) {
    out.push({ template: nodeDef.yields[0].template, quantity: Math.max(1, nodeDef.yields[0].minQty) });
  }
  return out;
}

/**
 * Validates all spatial, visibility, collision-readiness, tool, rank, and combat rules
 * before starting or completing a gather action. Throws an Error with `.code` on refusal.
 */
export function validateGatherPrerequisites(ctx, player, nodeDef, professionRank, opts = {}) {
  const fail = (code, msg) => {
    const err = new Error(msg);
    err.code = code;
    throw err;
  };
  if (!nodeDef) fail('NODE_NOT_FOUND', 'That resource node does not exist.');
  if (player.rpg?.defeated) fail('PLAYER_DEFEATED', 'You cannot gather while defeated.');
  if (ctx.services?.inCombat?.(player)) fail('IN_COMBAT', 'You cannot gather while in combat.');

  const loc = ctx.location(player);
  if (loc !== nodeDef.location) fail('WRONG_LOCATION', 'You are not in the same area as that resource node.');

  // Collision readiness gate (§3: enable interaction after collision is ready).
  if (typeof ctx.services?.collision?.status === 'function') {
    const st = ctx.services.collision.status(loc);
    if (st && (st.status === 'loading' || st.status === 'unavailable')) {
      fail('COLLISION_NOT_READY', 'Wait until this area finishes loading before gathering.');
    }
  }

  // Reach check.
  const dist = Math.hypot((Number(player.x) || 0) - nodeDef.x, (Number(player.z) || 0) - nodeDef.z);
  const reach = opts.reach ?? GATHER_REACH;
  if (dist > reach) {
    fail('OUT_OF_REACH', `Move closer to ${nodeDef.name} (${dist.toFixed(1)} m away; need within ${reach} m).`);
  }

  // Floor / vertical elevation check.
  const footY = ctx.services?.collision?.footY?.(player) ?? (Number.isFinite(player.footY) ? player.footY : (Number.isFinite(player.y) ? player.y : 0));
  if (Number.isFinite(footY) && Number.isFinite(nodeDef.y) && Math.abs(footY - nodeDef.y) > FLOOR_TOLERANCE) {
    fail('WRONG_FLOOR', `${nodeDef.name} is on a different floor.`);
  }

  // Visibility / Line-of-Sight check.
  if (typeof ctx.services?.canSee === 'function') {
    const visible = ctx.services.canSee(loc, Number(player.x) || 0, Number(player.z) || 0, nodeDef.x, nodeDef.z);
    if (!visible) {
      fail('NO_LINE_OF_SIGHT', `You do not have a clear line of sight to ${nodeDef.name}.`);
    }
  }

  // Profession rank check.
  const profName = PROFESSIONS[nodeDef.profession]?.name ?? nodeDef.profession;
  if (professionRank < nodeDef.minRank) {
    fail('RANK_TOO_LOW', `${nodeDef.name} requires ${profName} Rank ${nodeDef.minRank} (you are Rank ${professionRank}).`);
  }

  // Required equipped tool check.
  const tool = findEquippedTool(player.rpg, nodeDef.requiredTool);
  const toolLabel = TOOL_KINDS[nodeDef.requiredTool]?.label ?? nodeDef.requiredTool;
  if (!tool) {
    fail('TOOL_REQUIRED', `Equip a ${toolLabel} (${profName} Rank ${nodeDef.minRank}) to gather ${nodeDef.name}.`);
  }
  if ((tool.condition ?? 0) <= 0) {
    fail('TOOL_BROKEN', `Your ${tool.name} is broken and must be repaired before gathering.`);
  }
  const tier = toolTierOf(tool);
  if (tier < (nodeDef.minToolTier ?? 1)) {
    fail('TOOL_TIER_LOW', `${nodeDef.name} requires a higher-tier ${toolLabel} (tier ${nodeDef.minToolTier}).`);
  }

  return { tool, footY, dist };
}
