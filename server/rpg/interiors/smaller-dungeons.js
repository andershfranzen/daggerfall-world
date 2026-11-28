// DFU Smaller Dungeons: deterministic 5-block dungeon layouts for eligible non-story sites.
//
// Follows Daggerfall Unity's MapsFile.cs Smaller Dungeons design:
//   - Main-quest, permanent story, and already-small (<= 5 blocks) dungeons keep their classic layout.
//   - Eligible multi-block non-story dungeons deterministically reduce to 5 blocks:
//       1 core interior block at (0, 0) carrying the start marker & quest markers
//       + 4 cardinal border blocks at (-1,0), (1,0), (0,-1), (0,1).
//   - Layout selection is strictly server-owned and deterministic from (region, locationId, dungeonName),
//     producing a stable `layoutId` shared by every client and preserved across restarts.
//   - Active quests pin their assigned `layoutId` so toggling Smaller Dungeons never invalidates
//     an in-flight quest's geometry, collision, portal returns, Recall anchors, or automap memory.
//
// Actions:
//   dungeon.layout.select  { location?, mode: 'classic' | 'smaller' }
//   dungeon.layout.info    { location? }
//
// Services (ctx.services.smallerDungeons):
//   isEligible(spec), buildLayout(dungeon, opts), selectLayout(locationOrDungeon, opts),
//   pinQuestLayout(player, questUid, location, layout), unpinQuestLayout(player, questUid),
//   pinnedLayoutFor(player, location), automapKey(location, layoutId),
//   recallAnchorMeta(location, layoutId), getAssigned(location)

import { parseLocation } from '../../../client/world/interiors/index.js';
import { MANTELLAN } from '../../../client/world/interiors/dungeonAccess.js';

export const name = 'smallerDungeons';
export const WORLD_PREFIX = 'smallerDungeons/';
export const SMALLER_BLOCK_COUNT = 5;

const LAYOUT_MODES = new Set(['classic', 'smaller']);

// DFU MapsFile.cs non-shrinkable story/main-quest/permanent dungeons (normalized lowercase names & location IDs).
export const STORY_DUNGEON_NAMES = Object.freeze(new Set([
  "privateer's hold",
  'scourg barrow',
  'shedungent',
  'mantellan crux',
  'direnni tower',
  'castle daggerfall',
  'daggerfall',
  'castle wayrest',
  'wayrest',
  'castle sentinel',
  'sentinel',
  'orsinium',
  'orsinium castle',
  "lysandus' tomb",
  'tomb of lysandus',
  'woodborne hall',
  'castle llugwych',
  'llugwych',
  'castle necromoghan',
  'the citadel of the ebony blade',
  'wrothgarian ruins',
]));

export const STORY_DUNGEON_LOCATION_IDS = Object.freeze(new Set([
  50000, // Mantellan Crux
  50004, // Shedungent (returnPlace - 1)
  50005, // Shedungent
  50015, // Orsinium
  245764, // Privateer's Hold classic ID
]));

// Classic DFU border block pool used when capping the 4 cardinal faces of the core block.
const BORDER_BLOCK_POOL = Object.freeze([
  'B0000001.RDB', 'B0000002.RDB', 'B0000003.RDB', 'B0000004.RDB',
  'B0000005.RDB', 'B0000006.RDB', 'B0000007.RDB', 'B0000008.RDB',
  'B0000009.RDB', 'B0000010.RDB', 'B0000011.RDB', 'B0000012.RDB',
  'B0000013.RDB', 'B0000014.RDB',
]);

const CARDINAL_OFFSETS = Object.freeze([
  Object.freeze({ x: -1, z: 0, edge: 'west' }),
  Object.freeze({ x: 1, z: 0, edge: 'east' }),
  Object.freeze({ x: 0, z: -1, edge: 'south' }),
  Object.freeze({ x: 0, z: 1, edge: 'north' }),
]);

/** Deterministic 32-bit FNV-1a hash. */
export function hash32(input) {
  const s = String(input ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic mulberry32 PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeLocationSpec(locationOrDungeon) {
  if (typeof locationOrDungeon === 'string') {
    const parsed = parseLocation(locationOrDungeon);
    return {
      location: locationOrDungeon,
      region: parsed?.region ?? 'Unknown',
      dungeonName: parsed?.location ?? locationOrDungeon,
      locationId: hash32(locationOrDungeon) & 0xffff,
      blocks: null,
      isStorySite: false,
      dungeonType: null,
    };
  }
  if (!locationOrDungeon || typeof locationOrDungeon !== 'object') {
    throw new Error('A valid dungeon location or descriptor is required.');
  }
  const location = locationOrDungeon.location
    ?? (locationOrDungeon.regionName && locationOrDungeon.name
      ? `dungeon:${locationOrDungeon.regionName}/${locationOrDungeon.name}`
      : `dungeon:${locationOrDungeon.region ?? 'Unknown'}/${locationOrDungeon.dungeonName ?? locationOrDungeon.name ?? 'Site'}`);
  const parsed = parseLocation(location);
  return {
    location,
    region: locationOrDungeon.regionName ?? parsed?.region ?? String(locationOrDungeon.region ?? 'Unknown'),
    dungeonName: locationOrDungeon.dungeonName ?? locationOrDungeon.name ?? parsed?.location ?? location,
    locationId: Number.isInteger(locationOrDungeon.locationId)
      ? locationOrDungeon.locationId
      : (Number.isInteger(locationOrDungeon.dungeonLocationId) ? locationOrDungeon.dungeonLocationId : (hash32(location) & 0xffff)),
    blocks: Array.isArray(locationOrDungeon.blocks) ? locationOrDungeon.blocks : null,
    isStorySite: Boolean(locationOrDungeon.isStorySite),
    dungeonType: locationOrDungeon.dungeonType ?? null,
    questMarkers: Array.isArray(locationOrDungeon.questMarkers) ? locationOrDungeon.questMarkers : null,
    returnPoint: locationOrDungeon.returnPoint ?? null,
  };
}

/**
 * Checks whether a dungeon is eligible for DFU's Smaller Dungeons 5-block layout.
 * Story/main-quest sites, Mantellan Crux, and dungeons with <= 5 blocks stay classic.
 */
export function isSmallerDungeonEligible(locationOrDungeon) {
  const spec = normalizeLocationSpec(locationOrDungeon);
  if (spec.isStorySite) return { eligible: false, reason: 'story-site' };
  if (spec.location === MANTELLAN.dungeon || spec.location === MANTELLAN.returnDungeon) {
    return { eligible: false, reason: 'story-site' };
  }
  const lowerName = String(spec.dungeonName ?? '').trim().toLowerCase();
  if (STORY_DUNGEON_NAMES.has(lowerName)) return { eligible: false, reason: 'story-site' };
  if (STORY_DUNGEON_LOCATION_IDS.has(spec.locationId)) return { eligible: false, reason: 'story-site' };
  if (Array.isArray(spec.blocks) && spec.blocks.length > 0 && spec.blocks.length <= SMALLER_BLOCK_COUNT) {
    return { eligible: false, reason: 'already-small' };
  }
  return { eligible: true, reason: 'eligible' };
}

/** Canonical deterministic layout ID for a dungeon and mode. */
export function layoutIdFor(locationOrDungeon, mode = 'classic') {
  const spec = normalizeLocationSpec(locationOrDungeon);
  const cleanMode = mode === 'smaller' ? 'smaller' : 'classic';
  const seedHex = hash32(`${spec.region}:${spec.locationId}:${spec.dungeonName}`).toString(16).padStart(8, '0');
  return `${cleanMode}:v1:${spec.locationId}:${seedHex}`;
}

function isBorderBlockName(blockName) {
  return typeof blockName === 'string' && /^B\d+\.RDB$/i.test(blockName);
}

/**
 * Builds the deterministic layout descriptor for a dungeon (either classic or DFU 5-block Smaller Dungeon).
 * Both clients and restarts produce identical blocks, layoutId, collisionHash, and remapped quest markers.
 */
export function buildSmallerDungeonLayout(locationOrDungeon, opts = {}) {
  const spec = normalizeLocationSpec(locationOrDungeon);
  const eligibility = isSmallerDungeonEligible(spec);
  const requestedMode = opts.mode === 'smaller' ? 'smaller' : 'classic';
  const effectiveMode = requestedMode === 'smaller' && eligibility.eligible ? 'smaller' : 'classic';
  const seed = hash32(`${spec.region}:${spec.locationId}:${spec.dungeonName}`);
  const rng = mulberry32(seed);
  const layoutId = layoutIdFor(spec, effectiveMode);

  const sourceBlocks = Array.isArray(spec.blocks) && spec.blocks.length
    ? spec.blocks.map((b) => ({
      x: Number(b.x) || 0,
      z: Number(b.z) || 0,
      blockName: String(b.blockName),
      isStartingBlock: Boolean(b.isStartingBlock),
    }))
    : defaultSyntheticClassicBlocks(seed);

  let blocks;
  let startBlock;
  if (effectiveMode === 'classic') {
    blocks = sourceBlocks.map((b) => Object.freeze({ ...b }));
    startBlock = blocks.find((b) => b.isStartingBlock) ?? blocks[0];
  } else {
    // DFU 5-block layout: 1 deterministic interior core block at (0,0) + 4 cardinal border blocks.
    const interiors = sourceBlocks.filter((b) => !isBorderBlockName(b.blockName));
    const borders = sourceBlocks.filter((b) => isBorderBlockName(b.blockName));
    const chosenCore = interiors.find((b) => b.isStartingBlock)
      ?? (interiors.length ? interiors[Math.floor(rng() * interiors.length)] : sourceBlocks[0]);
    const core = Object.freeze({
      x: 0,
      z: 0,
      blockName: chosenCore.blockName,
      isStartingBlock: true,
      role: 'core',
    });
    const borderPool = borders.length ? borders.map((b) => b.blockName) : BORDER_BLOCK_POOL;
    const capBlocks = CARDINAL_OFFSETS.map((off, idx) => {
      const pick = borderPool[(Math.floor(rng() * borderPool.length) + idx) % borderPool.length];
      return Object.freeze({
        x: off.x,
        z: off.z,
        blockName: pick,
        isStartingBlock: false,
        role: 'border',
        edge: off.edge,
      });
    });
    blocks = [core, ...capBlocks];
    startBlock = core;
  }

  // Deterministic collision hash derived from exact block coordinates & names so two clients / restarts verify parity.
  const geometrySignature = blocks.map((b) => `${b.x},${b.z}:${b.blockName}:${b.isStartingBlock ? 1 : 0}`).join('|');
  const collisionHash = hash32(`${layoutId}|${geometrySignature}`).toString(16).padStart(8, '0');

  // Remap/anchor quest markers inside the active blocks so objectives remain reachable in 5-block layouts.
  const rawMarkers = spec.questMarkers ?? [
    { id: 'qm:0,0:primary', blockX: 0, blockZ: 0, x: 16.0, y: 0, z: -16.0, kind: 'questItem' },
    { id: 'qm:0,0:foe', blockX: 0, blockZ: 0, x: 24.0, y: 0, z: -24.0, kind: 'questFoe' },
  ];
  const questMarkers = rawMarkers.map((m, idx) => {
    if (effectiveMode === 'classic') return Object.freeze({ ...m, layoutId });
    // Pin marker into core block (0, 0) deterministically while preserving local offset inside the 64m block.
    const localX = ((Number(m.x) || 0) % 64 + 64) % 64;
    const localZ = -(((Math.abs(Number(m.z) || 0)) % 64));
    return Object.freeze({
      ...m,
      id: m.id ?? `qm:smaller:${idx}`,
      blockX: 0,
      blockZ: 0,
      x: Math.round(localX * 1000) / 1000,
      y: Number.isFinite(m.y) ? m.y : 0,
      z: Math.round(localZ * 1000) / 1000,
      layoutId,
    });
  });

  const portalReturn = spec.returnPoint
    ? Object.freeze({ ...spec.returnPoint, layoutId })
    : Object.freeze({
      location: spec.location.replace(/^dungeon:/, 'town:'),
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      layoutId,
    });

  return Object.freeze({
    location: spec.location,
    region: spec.region,
    dungeonName: spec.dungeonName,
    locationId: spec.locationId,
    layoutId,
    mode: effectiveMode,
    requestedMode,
    eligible: eligibility.eligible,
    eligibilityReason: eligibility.reason,
    blockCount: blocks.length,
    blocks: Object.freeze(blocks),
    startBlock,
    collisionHash,
    questMarkers: Object.freeze(questMarkers),
    portalReturn,
    automapKey: effectiveMode === 'smaller' ? `${spec.location}@${layoutId}` : spec.location,
    recallMeta: Object.freeze({
      location: spec.location,
      layoutId,
      mode: effectiveMode,
      collisionHash,
    }),
  });
}

function defaultSyntheticClassicBlocks(seed) {
  const rng = mulberry32(seed);
  const interiors = ['N0000001.RDB', 'W0000002.RDB', 'L0000003.RDB', 'M0000004.RDB', 'N0000005.RDB', 'W0000006.RDB'];
  const blocks = [
    { x: 0, z: 0, blockName: interiors[Math.floor(rng() * interiors.length)], isStartingBlock: true },
    { x: 1, z: 0, blockName: interiors[1], isStartingBlock: false },
    { x: 0, z: 1, blockName: interiors[2], isStartingBlock: false },
    { x: 1, z: 1, blockName: interiors[3], isStartingBlock: false },
    { x: -1, z: 0, blockName: BORDER_BLOCK_POOL[0], isStartingBlock: false },
    { x: 2, z: 0, blockName: BORDER_BLOCK_POOL[1], isStartingBlock: false },
    { x: 0, z: -1, blockName: BORDER_BLOCK_POOL[2], isStartingBlock: false },
    { x: 1, z: 2, blockName: BORDER_BLOCK_POOL[3], isStartingBlock: false },
  ];
  return blocks;
}

function ensurePlayerLayoutState(p) {
  if (!p.rpg || typeof p.rpg !== 'object') p.rpg = {};
  const cur = p.rpg.dungeonLayout;
  if (!cur || typeof cur !== 'object') {
    p.rpg.dungeonLayout = { preference: 'classic', pinned: {} };
  } else {
    if (!LAYOUT_MODES.has(cur.preference)) cur.preference = 'classic';
    if (!cur.pinned || typeof cur.pinned !== 'object') cur.pinned = {};
  }
  return p.rpg.dungeonLayout;
}

export function install(ctx, options = {}) {
  const services = (ctx.services ||= {});
  const defaultMode = LAYOUT_MODES.has(options.defaultMode ?? ctx.config?.smallerDungeonsMode)
    ? (options.defaultMode ?? ctx.config?.smallerDungeonsMode)
    : (ctx.config?.smallerDungeons ? 'smaller' : 'classic');

  // Shared server-owned assignments persisted across restarts: location -> { layoutId, mode, collisionHash, blocks, assignedAt }
  const assigned = new Map();
  for (const [k, v] of ctx.loadWorld?.(WORLD_PREFIX) ?? []) {
    if (v && typeof v === 'object' && typeof v.layoutId === 'string') {
      assigned.set(k.slice(WORLD_PREFIX.length), v);
    }
  }

  function persistAssignment(location, layout) {
    const record = {
      location,
      layoutId: layout.layoutId,
      mode: layout.mode,
      collisionHash: layout.collisionHash,
      blockCount: layout.blockCount,
      blocks: layout.blocks,
      automapKey: layout.automapKey,
      assignedAt: Math.trunc(ctx.now?.() ?? Date.now()),
    };
    const prev = assigned.get(location);
    assigned.set(location, record);
    ctx.dirtyWorld?.(`${WORLD_PREFIX}${location}`, record);
    ctx.onRollback?.(() => {
      if (prev) assigned.set(location, prev);
      else assigned.delete(location);
    });
    return record;
  }

  function pinnedLayoutFor(p, location) {
    const st = ensurePlayerLayoutState(p);
    return st.pinned[location] ?? null;
  }

  /**
   * Pins an active quest to the dungeon layout it was assigned, guaranteeing that later
   * toggling Smaller Dungeons or restarting the server keeps the quest on its original layoutId.
   */
  function pinQuestLayout(p, questUid, location, layoutSpec = null) {
    if (!p || !questUid || !location) throw new Error('Quest layout pin requires player, questUid, and location.');
    const st = ensurePlayerLayoutState(p);
    const existing = st.pinned[location];
    if (existing && existing.questUids?.includes(questUid)) return existing;
    const layout = layoutSpec && typeof layoutSpec === 'object' && layoutSpec.layoutId
      ? layoutSpec
      : selectLayout(location, { player: p, mode: st.preference });
    const pin = existing
      ? { ...existing, questUids: [...new Set([...(existing.questUids ?? []), questUid])] }
      : {
        location,
        layoutId: layout.layoutId,
        mode: layout.mode,
        collisionHash: layout.collisionHash,
        automapKey: layout.automapKey,
        questUids: [questUid],
        pinnedAt: Math.trunc(ctx.now?.() ?? Date.now()),
      };
    ctx.dirty?.(p);
    st.pinned[location] = pin;
    persistAssignment(location, layout);
    return pin;
  }

  function unpinQuestLayout(p, questUid) {
    const st = ensurePlayerLayoutState(p);
    let changed = false;
    for (const [loc, pin] of Object.entries(st.pinned)) {
      if (!Array.isArray(pin.questUids) || !pin.questUids.includes(questUid)) continue;
      const next = pin.questUids.filter((id) => id !== questUid);
      changed = true;
      ctx.dirty?.(p);
      if (next.length) st.pinned[loc] = { ...pin, questUids: next };
      else delete st.pinned[loc];
    }
    return changed;
  }

  function selectLayout(locationOrDungeon, opts = {}) {
    const spec = normalizeLocationSpec(locationOrDungeon);
    const player = opts.player ?? null;
    const pin = player ? pinnedLayoutFor(player, spec.location) : null;
    // Active quest pin always takes precedence over current preference.
    let mode;
    if (opts.pinnedLayoutId) {
      mode = String(opts.pinnedLayoutId).startsWith('smaller:') ? 'smaller' : 'classic';
    } else if (pin) {
      mode = pin.mode;
    } else if (LAYOUT_MODES.has(opts.mode)) {
      mode = opts.mode;
    } else if (player) {
      mode = ensurePlayerLayoutState(player).preference ?? defaultMode;
    } else if (assigned.has(spec.location)) {
      mode = assigned.get(spec.location).mode;
    } else {
      mode = defaultMode;
    }

    const layout = buildSmallerDungeonLayout(spec, { mode });
    if (opts.persist !== false) persistAssignment(spec.location, layout);
    return {
      ...layout,
      pinnedByQuest: Boolean(pin),
      pinnedQuestUids: pin?.questUids ?? [],
    };
  }

  ctx.onJoin?.((p) => {
    ensurePlayerLayoutState(p);
  });

  ctx.onAction?.('dungeon.layout.select', (p, args) => {
    const mode = String(args?.mode ?? '').toLowerCase();
    if (!LAYOUT_MODES.has(mode)) throw new Error('Choose either classic or smaller dungeon layout.');
    const st = ensurePlayerLayoutState(p);
    const location = typeof args?.location === 'string' && args.location.startsWith('dungeon:')
      ? args.location
      : (ctx.location(p).startsWith('dungeon:') ? ctx.location(p) : null);
    ctx.dirty(p);
    st.preference = mode;
    let layout = null;
    if (location) {
      const pin = st.pinned[location];
      if (pin && pin.mode !== mode) {
        layout = selectLayout(location, { player: p });
        ctx.notify(p, {
          kind: 'dungeonLayout',
          preference: st.preference,
          layout,
          pinned: true,
          text: `Preference set to ${mode}, but ${layout.dungeonName} stays pinned to ${pin.mode} for your active quest.`,
        });
        return;
      }
      layout = selectLayout(location, { player: p, mode });
    }
    ctx.notify(p, {
      kind: 'dungeonLayout',
      preference: st.preference,
      layout,
      pinned: false,
      text: layout
        ? `Dungeon layout for ${layout.dungeonName}: ${layout.mode} (${layout.blockCount} blocks, ${layout.layoutId}).`
        : `Default dungeon layout set to ${mode}.`,
    });
  });

  ctx.onAction?.('dungeon.layout.info', (p, args) => {
    const st = ensurePlayerLayoutState(p);
    const location = typeof args?.location === 'string' && args.location
      ? args.location
      : (ctx.location(p).startsWith('dungeon:') ? ctx.location(p) : 'dungeon:Daggerfall/The Dungeon of Peristair');
    const layout = selectLayout(location, { player: p, persist: false });
    ctx.notify(p, {
      kind: 'dungeonLayout',
      preference: st.preference,
      layout,
      pinned: layout.pinnedByQuest,
      pinnedLocations: Object.values(st.pinned),
      silent: true,
    });
  });

  services.smallerDungeons = {
    isEligible: isSmallerDungeonEligible,
    buildLayout: buildSmallerDungeonLayout,
    layoutIdFor,
    selectLayout,
    pinQuestLayout,
    unpinQuestLayout,
    pinnedLayoutFor,
    automapKey: (location, layoutId) => (layoutId && String(layoutId).startsWith('smaller:') ? `${location}@${layoutId}` : location),
    recallAnchorMeta: (location, layoutId) => ({
      location,
      layoutId: layoutId ?? layoutIdFor(location, defaultMode),
      mode: String(layoutId ?? '').startsWith('smaller:') ? 'smaller' : 'classic',
    }),
    getAssigned: (location) => assigned.get(location) ?? null,
    defaultMode,
  };
}
