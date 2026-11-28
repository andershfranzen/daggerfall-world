// §3 Professions feature module:
//   - Gathering nodes (Mining, Woodcutting, Herbalism, Fishing) with persistent depletion & UTC respawn
//   - Crafting stations (Smithing anvils/forges, Carpentry workbenches, Cooking hearths) & progression
//   - Classic Potion Maker (Alchemy) & Item Maker (Enchanting) XP/metadata hooks
//   - Account-scoped Daily Crafting Writs (UTC day reset) via runDurable & world_state
//   - Economy balance & NPC crafted buyback anti-exploit guard
//
// Exports:
//   name = 'professions'
//   install(ctx, options?) -> { services }
//   Re-exports catalog, nodes, crafting, writs, and economy helpers for integration and testing.

import { createHash } from 'node:crypto';
import * as inventory from './inventory.js';
import {
  PROFESSIONS,
  PROFESSION_IDS,
  GATHERING_PROFESSIONS,
  CRAFTING_PROFESSIONS,
  ARCANE_PROFESSIONS,
  MAX_RANK,
  RANK_TITLES,
  RANK_XP_THRESHOLDS,
  QUALITY_TIERS,
  TOOL_KINDS,
  STATION_KINDS,
  PROFESSION_ITEM_BASES,
  FURNITURE_SPECS,
  FOOD_EFFECTS,
  RECIPES,
  RECIPE_BY_ID,
  rankForXp,
  rankTitle,
  xpProgressFor,
  qualityForRank,
  registerProfessionItems,
  toolKindOf,
  toolTierOf,
  findEquippedTool,
  recipesForProfession,
} from './professions/catalog.js';
import {
  GATHER_REACH,
  FLOOR_TOLERANCE,
  MOVE_INTERRUPT_DIST,
  NODE_WORLD_PREFIX,
  NODE_ARCHETYPES,
  AUTHORED_NODES,
  nodesForLocation,
  findNodeDefinition,
  nodeWorldKey,
  resolveNodeState,
  publicNodeView,
  rollNodeYields,
  validateGatherPrerequisites,
} from './professions/nodes.js';
import {
  STATION_REACH,
  AUTHORED_STATIONS,
  stationsForLocation,
  findStationDefinition,
  ensureProfessionsState,
  awardProfessionXp,
  buildProfessionsSummary,
  countEligibleInput,
  planCraftCapacity,
  validateStationProximity,
  executeCraftOnRpg,
  buildRecipeBookView,
  consumeCraftedFood,
  applyFieldRepairKit,
} from './professions/crafting.js';
import {
  WRIT_WORLD_PREFIX,
  utcDayKey,
  nextUtcResetMs,
  writAccountKey,
  writWorldKey,
  getDailyWrits,
  normalizeWritRecord,
  buildWritBoardView,
  executeWritTurnIn,
} from './professions/writs.js';
import {
  NPC_CRAFTED_BUYBACK_RATE,
  npcSellPriceForCrafted,
  auditRecipeEconomy,
  auditAllRecipes,
} from './professions/economy.js';

export const name = 'professions';
const OP_WORLD_PREFIX = 'prof:op:';

export {
  PROFESSIONS,
  PROFESSION_IDS,
  GATHERING_PROFESSIONS,
  CRAFTING_PROFESSIONS,
  ARCANE_PROFESSIONS,
  MAX_RANK,
  RANK_TITLES,
  RANK_XP_THRESHOLDS,
  QUALITY_TIERS,
  TOOL_KINDS,
  STATION_KINDS,
  PROFESSION_ITEM_BASES,
  FURNITURE_SPECS,
  FOOD_EFFECTS,
  RECIPES,
  RECIPE_BY_ID,
  rankForXp,
  rankTitle,
  xpProgressFor,
  qualityForRank,
  registerProfessionItems,
  toolKindOf,
  toolTierOf,
  findEquippedTool,
  recipesForProfession,
  GATHER_REACH,
  FLOOR_TOLERANCE,
  MOVE_INTERRUPT_DIST,
  NODE_WORLD_PREFIX,
  NODE_ARCHETYPES,
  AUTHORED_NODES,
  nodesForLocation,
  findNodeDefinition,
  nodeWorldKey,
  resolveNodeState,
  publicNodeView,
  rollNodeYields,
  STATION_REACH,
  AUTHORED_STATIONS,
  stationsForLocation,
  findStationDefinition,
  ensureProfessionsState,
  awardProfessionXp,
  buildProfessionsSummary,
  countEligibleInput,
  planCraftCapacity,
  executeCraftOnRpg,
  buildRecipeBookView,
  consumeCraftedFood,
  applyFieldRepairKit,
  WRIT_WORLD_PREFIX,
  utcDayKey,
  nextUtcResetMs,
  writAccountKey,
  writWorldKey,
  getDailyWrits,
  normalizeWritRecord,
  buildWritBoardView,
  executeWritTurnIn,
  NPC_CRAFTED_BUYBACK_RATE,
  npcSellPriceForCrafted,
  auditRecipeEconomy,
  auditAllRecipes,
};

function stableParamsHash(obj) {
  const walk = (v) => {
    if (v === null || v === undefined) return 'null';
    if (typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`;
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(v[k])}`).join(',')}}`;
  };
  return createHash('sha256').update(walk(obj)).digest('hex');
}

function makeConflictError(msg) {
  const err = new Error(msg);
  err.code = 'DURABLE_KEY_CONFLICT';
  err.status = 409;
  return err;
}

function cleanOpKey(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length > 128) throw new Error('opKey must be at most 128 characters.');
  return s;
}

function syncRpgInPlace(target, source) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, structuredClone(source));
}

/**
 * Installs the Professions feature onto an RPG runtime context `ctx`.
 *
 * Options (mostly for deterministic tests):
 *   - `utcNow`: () => number (UTC epoch ms, defaults to Date.now)
 *   - `now`: () => number (monotonic ms for gather timers, defaults to ctx.now or Date.now)
 *   - `rng`: () => number (defaults to Math.random)
 */
export function install(ctx, options = {}) {
  registerProfessionItems();
  const services = (ctx.services ??= {});
  const utcNow = options.utcNow ?? options.clock ?? (() => Date.now());
  const monoNow = options.now ?? options.clock ?? (() => (typeof ctx.now === 'function' ? ctx.now() : Date.now()));
  const rng = options.rng ?? Math.random;

  // In-memory mirrors of persisted world state (loaded at startup, updated on commit & durable writes).
  const nodeStates = new Map(); // nodeId -> persisted node state object
  const writStates = new Map(); // `${accountKey}:${utcDay}` -> { accountKey, utcDay, completed }
  const syncOps = new Map();    // `${scopeKey}:${opKey}` -> { paramsHash, result }

  // Transient active gathering sessions: playerId -> { nodeId, location, startX, startZ, startY, startedAt, durationMs, toolId }
  const activeGathers = new Map();
  // Active locations whose node/station entities are currently mounted in ctx.entities.
  const mountedLocations = new Set();

  // ---- Hydrate persisted world rows on startup ----
  if (typeof ctx.loadWorld === 'function') {
    for (const [k, v] of ctx.loadWorld(NODE_WORLD_PREFIX) ?? []) {
      if (typeof k === 'string' && k.startsWith(NODE_WORLD_PREFIX) && v && typeof v === 'object') {
        nodeStates.set(k.slice(NODE_WORLD_PREFIX.length), v);
      }
    }
    for (const [k, v] of ctx.loadWorld(WRIT_WORLD_PREFIX) ?? []) {
      if (typeof k === 'string' && k.startsWith(WRIT_WORLD_PREFIX) && v && typeof v === 'object') {
        writStates.set(k.slice(WRIT_WORLD_PREFIX.length), v);
      }
    }
    for (const [k, v] of ctx.loadWorld(OP_WORLD_PREFIX) ?? []) {
      if (typeof k === 'string' && k.startsWith(OP_WORLD_PREFIX) && v && typeof v === 'object') {
        syncOps.set(k.slice(OP_WORLD_PREFIX.length), v);
      }
    }
  }

  const maxCarryFor = (p) => {
    if (typeof services.maxEncumbrance === 'function') return services.maxEncumbrance(p);
    return inventory.maxEncumbrance(p.rpg || {});
  };

  function getNodeState(nodeDef, nowUtc = utcNow()) {
    const raw = nodeStates.get(nodeDef.id) ?? null;
    const resolved = resolveNodeState(nodeDef, raw, nowUtc);
    if (raw && raw.respawnAt != null && nowUtc >= raw.respawnAt) {
      // Unloaded node recovered lazily on access.
      nodeStates.set(nodeDef.id, resolved);
      ctx.dirtyWorld?.(nodeWorldKey(nodeDef.id), resolved);
    }
    return resolved;
  }

  function getWritState(player, nowUtc = utcNow()) {
    const accountKey = writAccountKey(player);
    const utcDay = utcDayKey(nowUtc);
    const cacheKey = `${accountKey}:${utcDay}`;
    const raw = writStates.get(cacheKey) ?? null;
    const norm = normalizeWritRecord(raw, accountKey, utcDay);
    writStates.set(cacheKey, norm);
    return { accountKey, utcDay, cacheKey, state: norm };
  }

  // ---- Scene entity synchronization ----

  function syncNodeEntity(nodeDef, state, nowUtc = utcNow()) {
    if (!ctx.entities) return;
    if (!mountedLocations.has(nodeDef.location)) return;
    const view = publicNodeView(nodeDef, state, nowUtc);
    ctx.entities.set(nodeDef.id, view);
  }

  function mountLocationEntities(location, nowUtc = utcNow()) {
    if (!ctx.entities || !location) return;
    mountedLocations.add(location);
    for (const nodeDef of nodesForLocation(location)) {
      const st = getNodeState(nodeDef, nowUtc);
      ctx.entities.set(nodeDef.id, publicNodeView(nodeDef, st, nowUtc));
    }
    for (const stDef of stationsForLocation(location)) {
      ctx.entities.set(stDef.id, { ...stDef });
    }
  }

  function pruneUnusedLocations() {
    if (!ctx.entities || !ctx.players) return;
    const activeLocs = new Set();
    for (const p of ctx.players.values()) activeLocs.add(ctx.location(p));
    for (const loc of [...mountedLocations]) {
      if (activeLocs.has(loc)) continue;
      mountedLocations.delete(loc);
      for (const n of nodesForLocation(loc)) ctx.entities.delete(n.id);
      for (const s of stationsForLocation(loc)) ctx.entities.delete(s.id);
    }
  }

  // ---- Active gather interruption ----

  function interruptGather(player, reason, message = null) {
    const sess = activeGathers.get(player.id);
    if (!sess) return false;
    activeGathers.delete(player.id);
    const text = message ?? (
      reason === 'moved' ? 'Gathering interrupted: you moved away.'
        : reason === 'combat' ? 'Gathering interrupted by combat.'
          : reason === 'tool' ? 'Gathering interrupted: your tool is no longer equipped or usable.'
            : reason === 'location' ? 'Gathering interrupted: you left the area.'
              : 'Gathering cancelled.'
    );
    ctx.notify?.(player, {
      kind: 'profession.gatherInterrupted',
      nodeId: sess.nodeId,
      reason,
      text,
    });
    return true;
  }

  // ---- Synchronous opKey idempotency helpers ----

  function checkSyncOp(scopeKey, opKey, params) {
    if (!opKey) return null;
    const full = `${scopeKey}:${opKey}`;
    const existing = syncOps.get(full);
    if (!existing) return null;
    const hash = stableParamsHash(params);
    if (existing.paramsHash !== hash) {
      throw makeConflictError(`operation key "${opKey}" was already used with different parameters`);
    }
    return { replayed: true, result: structuredClone(existing.result) };
  }

  function recordSyncOp(scopeKey, opKey, params, result) {
    if (!opKey) return;
    const full = `${scopeKey}:${opKey}`;
    const prev = syncOps.get(full);
    const rec = { paramsHash: stableParamsHash(params), result: structuredClone(result), at: utcNow() };
    syncOps.set(full, rec);
    ctx.onRollback?.(() => {
      if (prev) syncOps.set(full, prev);
      else syncOps.delete(full);
    });
    ctx.dirtyWorld?.(`${OP_WORLD_PREFIX}${full}`, rec);
  }

  // ---- Core Gather Logic (shared by sync action & runDurable path) ----

  function checkCapacityForYields(rpg, yields, maxEncumbranceKg) {
    let addedKg = 0;
    let addedSlots = 0;
    const inv = Array.isArray(rpg.inventory) ? rpg.inventory : [];
    for (const y of yields) {
      const desc = inventory.describeTemplate(y.template);
      addedKg += (Number(desc.weight) || 0) * y.quantity;
      if (desc.stackable) {
        const hasStack = inv.some((it) => it && it.template === desc.template && it.stackable && !inventory.hasExtras(it) && it.quantity + y.quantity <= inventory.MAX_STACK);
        if (!hasStack) addedSlots += 1;
      } else {
        addedSlots += y.quantity;
      }
    }
    const projectedKg = Math.round((inventory.carriedWeight(rpg) + addedKg) * 100) / 100;
    if (projectedKg > maxEncumbranceKg) {
      const err = new Error(`Harvested materials would exceed your carry limit (${projectedKg.toFixed(1)} / ${maxEncumbranceKg} kg).`);
      err.code = 'OVERWEIGHT';
      throw err;
    }
    if (inv.length + addedSlots > inventory.MAX_ITEMS) {
      const err = new Error('Your pack cannot hold any more items.');
      err.code = 'PACK_FULL';
      throw err;
    }
  }

  function validateActiveGatherForCompletion(player, nodeDef, nowMono, opts = {}) {
    const sess = activeGathers.get(player.id);
    if (!sess || sess.nodeId !== nodeDef.id) {
      if (opts.skipSessionCheck) return null;
      const err = new Error(`Start gathering ${nodeDef.name} before completing it.`);
      err.code = 'NO_ACTIVE_GATHER';
      throw err;
    }
    const moved = Math.hypot((Number(player.x) || 0) - sess.startX, (Number(player.z) || 0) - sess.startZ);
    if (moved > MOVE_INTERRUPT_DIST || ctx.location(player) !== sess.location) {
      interruptGather(player, moved > MOVE_INTERRUPT_DIST ? 'moved' : 'location');
      const err = new Error('Gathering was interrupted because you moved.');
      err.code = 'GATHER_INTERRUPTED';
      throw err;
    }
    const elapsed = nowMono - sess.startedAt;
    if (!opts.skipTimer && elapsed < sess.durationMs) {
      const err = new Error(`Still gathering ${nodeDef.name} (${Math.ceil((sess.durationMs - elapsed) / 100) / 10}s remaining).`);
      err.code = 'GATHER_TOO_EARLY';
      throw err;
    }
    return sess;
  }

  function applyGatherMutationOnState(player, rpg, nodeDef, currentNodeState, nowUtc) {
    if (currentNodeState.charges <= 0) {
      const remainSec = currentNodeState.respawnAt ? Math.max(1, Math.ceil((currentNodeState.respawnAt - nowUtc) / 1000)) : 60;
      const err = new Error(`${nodeDef.name} is depleted (recovers in ${remainSec}s).`);
      err.code = 'NODE_DEPLETED';
      throw err;
    }

    const st = ensureProfessionsState(rpg);
    const profRank = st.tracks[nodeDef.profession]?.rank ?? 1;
    const { tool } = validateGatherPrerequisites(ctx, { ...player, rpg }, nodeDef, profRank);

    const yields = rollNodeYields(nodeDef, profRank, rng);
    checkCapacityForYields(rpg, yields, maxCarryFor({ ...player, rpg }));

    // Grant harvested materials.
    const granted = [];
    for (const y of yields) {
      const rec = inventory.addItem(rpg, y.template, y.quantity);
      granted.push({ template: rec.template, name: rec.name, quantity: y.quantity, itemId: rec.id });
    }

    // Advance tool wear.
    const wear = Math.max(0, Math.trunc(Number(nodeDef.toolWear) || 0));
    const toolBroke = wear > 0 ? inventory.wearItem(rpg, tool.id, wear) : false;
    const updatedTool = rpg.inventory.find((i) => i.id === tool.id);

    // Award profession XP.
    const xpResult = awardProfessionXp(rpg, nodeDef.profession, nodeDef.xp);

    // Decrement shared node charge & start recovery deadline when depleted.
    const nextCharges = currentNodeState.charges - 1;
    const depleted = nextCharges <= 0;
    const nextNodeState = {
      nodeId: nodeDef.id,
      location: nodeDef.location,
      charges: nextCharges,
      maxCharges: nodeDef.maxCharges,
      depletedAt: depleted ? nowUtc : currentNodeState.depletedAt,
      respawnAt: depleted ? nowUtc + nodeDef.respawnMs : currentNodeState.respawnAt,
      revision: currentNodeState.revision + 1,
      lastHarvesterId: player.id,
    };

    return {
      nextNodeState,
      outcome: {
        nodeId: nodeDef.id,
        nodeName: nodeDef.name,
        profession: nodeDef.profession,
        yields: granted,
        xp: xpResult,
        toolWear: wear,
        toolCondition: updatedTool?.condition ?? 0,
        toolBroke,
        chargesRemaining: nextCharges,
        maxCharges: nodeDef.maxCharges,
        depleted,
        respawnAt: nextNodeState.respawnAt,
      },
    };
  }

  // ---- Durable async operations using ctx.services.runDurable ----

  async function completeGatherDurable(player, args = {}) {
    const nodeId = String(args.nodeId ?? '').trim();
    const nodeDef = findNodeDefinition(nodeId, ctx.location(player));
    if (!nodeDef) {
      const err = new Error('That resource node does not exist.');
      err.code = 'NODE_NOT_FOUND';
      throw err;
    }
    const opKey = cleanOpKey(args.opKey) ?? `gather:${player.id}:${nodeId}:${Math.floor(monoNow())}`;
    const nowMono = monoNow();

    // Check active gather session before entering tx (unless replay will handle it).
    const runDurable = services.runDurable ?? services.store?.runDurable?.bind(services.store);
    if (typeof runDurable !== 'function') {
      // Fallback to synchronous path when no durable store is attached.
      return completeGatherSync(player, { ...args, opKey });
    }

    const scope = {
      accountId: player.accountId ?? null,
      characterId: player.id,
      resourceKey: `node:${nodeDef.id}`,
      scopeKey: `prof:gather:a:${player.accountId ?? '-'}:c:${player.id}`,
      params: { action: 'gatherComplete', nodeId: nodeDef.id },
    };

    // Check if this exact opKey already committed (so replaying after session cleared still works!).
    const getDurableOp = services.store?.getDurableOp?.bind(services.store);
    const maybeExisting = typeof getDurableOp === 'function' ? await getDurableOp(opKey, scope) : null;
    if (!maybeExisting) {
      validateActiveGatherForCompletion(player, nodeDef, nowMono, { skipTimer: !!args.skipTimer, skipSessionCheck: !!args.skipSessionCheck });
    }

    let committedNodeState = null;
    let committedRpg = null;
    const durableRes = await runDurable(opKey, scope, async (tx) => {
      const nowUtc = utcNow();
      const persisted = await tx.getWorld(nodeWorldKey(nodeDef.id));
      const resolved = resolveNodeState(nodeDef, persisted ?? nodeStates.get(nodeDef.id) ?? null, nowUtc);
      const rpgClone = structuredClone(player.rpg || {});
      inventory.normalizeRpg(rpgClone);
      const { nextNodeState, outcome } = applyGatherMutationOnState(player, rpgClone, nodeDef, resolved, nowUtc);
      await tx.putWorld(nodeWorldKey(nodeDef.id), nextNodeState);
      if (typeof tx.saveCharacters === 'function') {
        await tx.saveCharacters([{ ...player, rpg: rpgClone }]);
      }
      committedNodeState = nextNodeState;
      committedRpg = rpgClone;
      return outcome;
    });

    if (!durableRes.replayed && committedRpg && committedNodeState) {
      syncRpgInPlace(player.rpg, committedRpg);
      nodeStates.set(nodeDef.id, committedNodeState);
      activeGathers.delete(player.id);
      const nowUtc = utcNow();
      syncNodeEntity(nodeDef, committedNodeState, nowUtc);
      const nodeView = publicNodeView(nodeDef, committedNodeState, nowUtc);
      ctx.nearby?.(nodeDef.location, { kind: 'profession.nodeDelta', node: nodeView });
      ctx.notify?.(player, {
        kind: 'profession.gatherComplete',
        replayed: false,
        ...durableRes.result,
        text: formatGatherText(durableRes.result),
      });
      ctx.emit?.('inventoryChanged', { player, reason: 'gather' });
      ctx.emit?.('professionHarvest', { player, node: nodeView, outcome: durableRes.result });
    } else if (durableRes.replayed) {
      activeGathers.delete(player.id);
      ctx.notify?.(player, {
        kind: 'profession.gatherComplete',
        replayed: true,
        ...durableRes.result,
        text: formatGatherText(durableRes.result),
      });
    }

    return durableRes;
  }

  async function craftDurable(player, args = {}) {
    const stationId = String(args.stationId ?? '').trim();
    const recipeId = String(args.recipeId ?? '').trim();
    const batches = Math.max(1, Math.min(20, Math.trunc(Number(args.quantity ?? 1) || 1)));
    const recipe = RECIPE_BY_ID.get(recipeId);
    if (!recipe) {
      const err = new Error('Unknown crafting recipe.');
      err.code = 'RECIPE_NOT_FOUND';
      throw err;
    }
    const stationDef = findStationDefinition(stationId, ctx.location(player), player);
    validateStationProximity(ctx, player, stationDef);
    if (stationDef.stationKind !== recipe.stationKind) {
      const err = new Error(`${recipe.name} must be crafted at a ${STATION_KINDS[recipe.stationKind]?.label ?? recipe.stationKind}.`);
      err.code = 'WRONG_STATION';
      throw err;
    }

    const opKey = cleanOpKey(args.opKey) ?? `craft:${player.id}:${recipeId}:${Math.floor(monoNow())}`;
    const runDurable = services.runDurable ?? services.store?.runDurable?.bind(services.store);
    if (typeof runDurable !== 'function') {
      return craftSync(player, { ...args, opKey });
    }

    const scope = {
      accountId: player.accountId ?? null,
      characterId: player.id,
      resourceKey: `craft:${player.id}`,
      params: { action: 'craft', stationId: stationDef.id, recipeId, batches },
    };

    let committedRpg = null;
    const durableRes = await runDurable(opKey, scope, async (tx) => {
      const nowUtc = utcNow();
      const rpgClone = structuredClone(player.rpg || {});
      inventory.normalizeRpg(rpgClone);
      const outcome = executeCraftOnRpg(player, rpgClone, recipe, batches, maxCarryFor({ ...player, rpg: rpgClone }), nowUtc);
      if (typeof tx.saveCharacters === 'function') {
        await tx.saveCharacters([{ ...player, rpg: rpgClone }]);
      }
      committedRpg = rpgClone;
      return outcome;
    });

    if (!durableRes.replayed && committedRpg) {
      syncRpgInPlace(player.rpg, committedRpg);
      ctx.emit?.('inventoryChanged', { player, reason: 'craft' });
      ctx.emit?.('professionCrafted', { player, outcome: durableRes.result });
    }
    ctx.notify?.(player, {
      kind: 'profession.crafted',
      replayed: durableRes.replayed,
      ...durableRes.result,
      text: formatCraftText(durableRes.result),
    });
    return durableRes;
  }

  async function turnInWritDurable(player, args = {}) {
    const writId = String(args.writId ?? '').trim();
    const nowUtc = utcNow();
    const accountKey = writAccountKey(player);
    const utcDay = utcDayKey(nowUtc);
    const wKey = writWorldKey(accountKey, utcDay);
    const opKey = cleanOpKey(args.opKey) ?? `writ:${accountKey}:${writId}`;

    const runDurable = services.runDurable ?? services.store?.runDurable?.bind(services.store);
    if (typeof runDurable !== 'function') {
      return turnInWritSync(player, { ...args, opKey });
    }

    const scope = {
      accountId: player.accountId ?? null,
      characterId: player.id,
      resourceKey: wKey,
      params: { action: 'writTurnIn', writId, utcDay },
    };

    let committedRpg = null;
    let committedWrit = null;
    const durableRes = await runDurable(opKey, scope, async (tx) => {
      const persisted = await tx.getWorld(wKey);
      const wState = normalizeWritRecord(persisted ?? writStates.get(`${accountKey}:${utcDay}`) ?? null, accountKey, utcDay);
      const rpgClone = structuredClone(player.rpg || {});
      inventory.normalizeRpg(rpgClone);
      const outcome = executeWritTurnIn(player, rpgClone, wState, writId, nowUtc, opKey);
      await tx.putWorld(wKey, wState);
      if (typeof tx.saveCharacters === 'function') {
        await tx.saveCharacters([{ ...player, rpg: rpgClone }]);
      }
      committedRpg = rpgClone;
      committedWrit = wState;
      return outcome;
    });

    if (!durableRes.replayed && committedRpg && committedWrit) {
      syncRpgInPlace(player.rpg, committedRpg);
      writStates.set(`${accountKey}:${utcDay}`, committedWrit);
      ctx.emit?.('inventoryChanged', { player, reason: 'writ' });
      ctx.emit?.('professionWritCompleted', { player, outcome: durableRes.result });
    }
    ctx.notify?.(player, {
      kind: 'profession.writCompleted',
      replayed: durableRes.replayed,
      ...durableRes.result,
      board: buildWritBoardView(player, writStates.get(`${accountKey}:${utcDay}`), nowUtc),
      text: `Delivered "${durableRes.result.title}" (+${durableRes.result.reward.gold} gp, +${durableRes.result.reward.xp} ${PROFESSIONS[durableRes.result.profession]?.name} XP).`,
    });
    return durableRes;
  }

  // ---- Synchronous action implementations (run inside runtime.js `transact`) ----

  function formatGatherText(res) {
    const loot = res.yields.map((y) => `${y.quantity} × ${y.name}`).join(', ');
    const rankMsg = res.xp?.rankedUp ? ` ${res.xp.professionName} reached Rank ${res.xp.rank}!` : '';
    const brokeMsg = res.toolBroke ? ' Your tool broke!' : '';
    return `Gathered ${loot} (+${res.xp?.xpGained ?? 0} ${res.xp?.professionName ?? ''} XP).${rankMsg}${brokeMsg}`;
  }

  function formatCraftText(res) {
    const rankMsg = res.xp?.rankedUp ? ` ${res.xp.professionName} reached Rank ${res.xp.rank}!` : '';
    return `Crafted ${res.outputQuantity > 1 ? `${res.outputQuantity} × ` : ''}${res.outputName} (${res.quality.label}, +${res.xp?.xpGained ?? 0} XP).${rankMsg}`;
  }

  function completeGatherSync(player, args = {}) {
    const nodeId = String(args.nodeId ?? '').trim();
    const nodeDef = findNodeDefinition(nodeId, ctx.location(player));
    if (!nodeDef) {
      const err = new Error('That resource node does not exist.');
      err.code = 'NODE_NOT_FOUND';
      throw err;
    }
    const opKey = cleanOpKey(args.opKey);
    const scopeKey = `c:${player.id}:gather`;
    const params = { action: 'gatherComplete', nodeId: nodeDef.id };
    const replayed = checkSyncOp(scopeKey, opKey, params);
    if (replayed) {
      activeGathers.delete(player.id);
      ctx.notify?.(player, { kind: 'profession.gatherComplete', replayed: true, ...replayed.result, text: formatGatherText(replayed.result) });
      return replayed;
    }

    const nowMono = monoNow();
    validateActiveGatherForCompletion(player, nodeDef, nowMono, { skipTimer: !!args.skipTimer, skipSessionCheck: !!args.skipSessionCheck });

    const nowUtc = utcNow();
    const prevNodeState = getNodeState(nodeDef, nowUtc);
    const prevRaw = nodeStates.get(nodeDef.id) ? structuredClone(nodeStates.get(nodeDef.id)) : null;
    const prevSess = activeGathers.get(player.id) ? { ...activeGathers.get(player.id) } : null;

    ctx.dirty?.(player);
    const { nextNodeState, outcome } = applyGatherMutationOnState(player, player.rpg, nodeDef, prevNodeState, nowUtc);
    nodeStates.set(nodeDef.id, nextNodeState);
    activeGathers.delete(player.id);

    ctx.onRollback?.(() => {
      if (prevRaw) nodeStates.set(nodeDef.id, prevRaw);
      else nodeStates.delete(nodeDef.id);
      if (prevSess) activeGathers.set(player.id, prevSess);
      syncNodeEntity(nodeDef, prevNodeState, nowUtc);
    });
    ctx.dirtyWorld?.(nodeWorldKey(nodeDef.id), nextNodeState);
    recordSyncOp(scopeKey, opKey, params, outcome);

    const nodeView = publicNodeView(nodeDef, nextNodeState, nowUtc);
    syncNodeEntity(nodeDef, nextNodeState, nowUtc);
    ctx.nearby?.(nodeDef.location, { kind: 'profession.nodeDelta', node: nodeView });
    ctx.notify?.(player, {
      kind: 'profession.gatherComplete',
      replayed: false,
      ...outcome,
      text: formatGatherText(outcome),
    });
    ctx.emit?.('inventoryChanged', { player, reason: 'gather' });
    ctx.emit?.('professionHarvest', { player, node: nodeView, outcome });
    return { replayed: false, result: outcome };
  }

  function craftSync(player, args = {}) {
    const stationId = String(args.stationId ?? '').trim();
    const recipeId = String(args.recipeId ?? '').trim();
    const batches = Math.max(1, Math.min(20, Math.trunc(Number(args.quantity ?? 1) || 1)));
    const recipe = RECIPE_BY_ID.get(recipeId);
    if (!recipe) {
      const err = new Error('Unknown crafting recipe.');
      err.code = 'RECIPE_NOT_FOUND';
      throw err;
    }
    const stationDef = findStationDefinition(stationId, ctx.location(player), player);
    validateStationProximity(ctx, player, stationDef);
    if (stationDef.stationKind !== recipe.stationKind) {
      const err = new Error(`${recipe.name} must be crafted at a ${STATION_KINDS[recipe.stationKind]?.label ?? recipe.stationKind}.`);
      err.code = 'WRONG_STATION';
      throw err;
    }

    const opKey = cleanOpKey(args.opKey);
    const scopeKey = `c:${player.id}:craft`;
    const params = { action: 'craft', stationId: stationDef.id, recipeId, batches };
    const replayed = checkSyncOp(scopeKey, opKey, params);
    if (replayed) {
      ctx.notify?.(player, { kind: 'profession.crafted', replayed: true, ...replayed.result, text: formatCraftText(replayed.result) });
      return replayed;
    }

    ctx.dirty?.(player);
    const outcome = executeCraftOnRpg(player, player.rpg, recipe, batches, maxCarryFor(player), utcNow());
    recordSyncOp(scopeKey, opKey, params, outcome);

    ctx.notify?.(player, {
      kind: 'profession.crafted',
      replayed: false,
      ...outcome,
      text: formatCraftText(outcome),
    });
    ctx.emit?.('inventoryChanged', { player, reason: 'craft' });
    ctx.emit?.('professionCrafted', { player, outcome });
    return { replayed: false, result: outcome };
  }

  function turnInWritSync(player, args = {}) {
    const writId = String(args.writId ?? '').trim();
    const nowUtc = utcNow();
    const { accountKey, utcDay, cacheKey, state } = getWritState(player, nowUtc);
    const opKey = cleanOpKey(args.opKey);
    const scopeKey = `${accountKey}:writ:${utcDay}`;
    const params = { action: 'writTurnIn', writId, utcDay };
    const replayed = checkSyncOp(scopeKey, opKey, params);
    if (replayed) {
      ctx.notify?.(player, {
        kind: 'profession.writCompleted',
        replayed: true,
        ...replayed.result,
        board: buildWritBoardView(player, state, nowUtc),
        text: `Delivered "${replayed.result.title}" (+${replayed.result.reward.gold} gp).`,
      });
      return replayed;
    }

    const prevWrit = structuredClone(state);
    ctx.dirty?.(player);
    const outcome = executeWritTurnIn(player, player.rpg, state, writId, nowUtc, opKey);
    ctx.onRollback?.(() => {
      writStates.set(cacheKey, prevWrit);
    });
    ctx.dirtyWorld?.(writWorldKey(accountKey, utcDay), state);
    recordSyncOp(scopeKey, opKey, params, outcome);

    ctx.notify?.(player, {
      kind: 'profession.writCompleted',
      replayed: false,
      ...outcome,
      board: buildWritBoardView(player, state, nowUtc),
      text: `Delivered "${outcome.title}" (+${outcome.reward.gold} gp, +${outcome.reward.xp} ${PROFESSIONS[outcome.profession]?.name} XP).`,
    });
    ctx.emit?.('inventoryChanged', { player, reason: 'writ' });
    ctx.emit?.('professionWritCompleted', { player, outcome });
    return { replayed: false, result: outcome };
  }

  // ---- Classic Potion Maker & Item Maker XP / Crafted Metadata Hooks ----

  function recordAlchemyCraft(player, recipeKey = null, { discovery = false } = {}) {
    if (!player?.rpg) return null;
    ctx.dirty?.(player);
    const xpGain = discovery ? 15 : (recipeKey ? 24 : 18);
    const xpResult = awardProfessionXp(player.rpg, 'alchemy', xpGain);
    ctx.notify?.(player, {
      kind: 'profession.xp',
      source: discovery ? 'recipeLearned' : 'potionMaker',
      recipeKey,
      ...xpResult,
      text: xpResult.rankedUp
        ? `Alchemy reached Rank ${xpResult.rank} (${rankTitle(xpResult.rank)})!`
        : `+${xpResult.xpGained} Alchemy XP.`,
    });
    return xpResult;
  }

  function recordEnchantingCraft(player, { itemId = null, enchantments = [], gold = 0 } = {}) {
    if (!player?.rpg) return null;
    ctx.dirty?.(player);
    const count = Array.isArray(enchantments) ? enchantments.length : 1;
    const xpGain = Math.min(80, 22 + count * 12);
    const xpResult = awardProfessionXp(player.rpg, 'enchanting', xpGain);

    // Attach/preserve crafted metadata on the enchanted item without overwriting an original smith's makerId.
    if (itemId && Array.isArray(player.rpg.inventory)) {
      const target = player.rpg.inventory.find((i) => i && i.id === itemId);
      if (target) {
        const quality = qualityForRank(xpResult.rank, 1);
        target.crafted = {
          ...(target.crafted && typeof target.crafted === 'object' ? target.crafted : {
            makerId: player.id,
            makerName: player.name || `Adventurer #${player.id}`,
            profession: 'enchanting',
            quality: quality.label,
            qualityKey: quality.key,
            qualityTier: quality.tier,
            craftedAt: utcNow(),
          }),
          enchantedById: player.id,
          enchantedByName: player.name || `Adventurer #${player.id}`,
          enchantedAt: utcNow(),
        };
      }
    }

    ctx.notify?.(player, {
      kind: 'profession.xp',
      source: 'itemMaker',
      itemId,
      gold,
      ...xpResult,
      text: xpResult.rankedUp
        ? `Enchanting reached Rank ${xpResult.rank} (${rankTitle(xpResult.rank)})!`
        : `+${xpResult.xpGained} Enchanting XP.`,
    });
    return xpResult;
  }

  // Subscribe cleanly to existing alchemy.js & combat.js runtime events.
  ctx.on?.('potionBrewed', ({ player, recipe } = {}) => {
    if (player) recordAlchemyCraft(player, recipe ?? null, { discovery: false });
  });
  ctx.on?.('recipeLearned', ({ player, recipe } = {}) => {
    if (player) recordAlchemyCraft(player, recipe ?? null, { discovery: true });
  });
  ctx.on?.('itemEnchanted', ({ player, itemId, enchantments, gold } = {}) => {
    if (player) recordEnchantingCraft(player, { itemId, enchantments, gold });
  });

  // Combat interrupts active gathering immediately.
  ctx.on?.('damage', ({ target, player } = {}) => {
    const p = target ?? player;
    if (p && activeGathers.has(p.id)) interruptGather(p, 'combat');
  });
  ctx.on?.('swing', ({ player } = {}) => {
    if (player && activeGathers.has(player.id)) interruptGather(player, 'combat', 'Gathering interrupted: you readied an attack.');
  });
  ctx.on?.('defeat', ({ player } = {}) => {
    if (player && activeGathers.has(player.id)) interruptGather(player, 'combat', 'Gathering interrupted: you were defeated.');
  });

  // ---- Lifecycle Hooks ----

  ctx.onJoin?.((player) => {
    if (!player.rpg || typeof player.rpg !== 'object') player.rpg = {};
    ensureProfessionsState(player.rpg);
    mountLocationEntities(ctx.location(player));
  });

  ctx.onLeave?.((player) => {
    activeGathers.delete(player.id);
    pruneUnusedLocations();
  });

  ctx.onTick?.((_dt, nowMs) => {
    const nowUtc = utcNow();
    const seenLocs = new Set();

    for (const p of ctx.players?.values?.() ?? []) {
      const loc = ctx.location(p);
      if (!seenLocs.has(loc)) {
        seenLocs.add(loc);
        if (!mountedLocations.has(loc)) mountLocationEntities(loc, nowUtc);
      }

      // Check active gather interruptions (movement, location change, tool lost/broken, defeated).
      const sess = activeGathers.get(p.id);
      if (sess) {
        if (p.rpg?.defeated) {
          interruptGather(p, 'combat', 'Gathering interrupted: you were defeated.');
          continue;
        }
        if (loc !== sess.location) {
          interruptGather(p, 'location');
          continue;
        }
        const moved = Math.hypot((Number(p.x) || 0) - sess.startX, (Number(p.z) || 0) - sess.startZ);
        if (moved > MOVE_INTERRUPT_DIST) {
          interruptGather(p, 'moved');
          continue;
        }
        const nodeDef = findNodeDefinition(sess.nodeId, loc);
        const tool = nodeDef ? findEquippedTool(p.rpg, nodeDef.requiredTool) : null;
        if (!tool || (tool.condition ?? 0) <= 0) {
          interruptGather(p, 'tool');
          continue;
        }
      }
    }

    // Recover any depleted nodes in active locations whose respawn deadline has elapsed.
    for (const loc of seenLocs) {
      for (const nodeDef of nodesForLocation(loc)) {
        const raw = nodeStates.get(nodeDef.id);
        if (raw && raw.respawnAt != null && nowUtc >= raw.respawnAt) {
          const recovered = getNodeState(nodeDef, nowUtc);
          const view = publicNodeView(nodeDef, recovered, nowUtc);
          syncNodeEntity(nodeDef, recovered, nowUtc);
          ctx.nearby?.(loc, { kind: 'profession.nodeDelta', node: view });
        }
      }
    }

    pruneUnusedLocations();
  });

  // ---- View Builders ----

  function nodesAt(location, nowUtc = utcNow()) {
    return nodesForLocation(location).map((n) => publicNodeView(n, getNodeState(n, nowUtc), nowUtc));
  }

  function stationsAt(location, player = null) {
    return stationsForLocation(location, player).map((s) => ({ ...s }));
  }

  function summaryOf(player) {
    const nowUtc = utcNow();
    const loc = ctx.location(player);
    const { state } = getWritState(player, nowUtc);
    const sess = activeGathers.get(player.id) ?? null;
    const nowMono = monoNow();
    return {
      professions: buildProfessionsSummary(player.rpg),
      recipes: buildRecipeBookView(player.rpg),
      writs: buildWritBoardView(player, state, nowUtc),
      location: loc,
      nearbyNodes: nodesAt(loc, nowUtc),
      nearbyStations: stationsAt(loc, player),
      gold: player.rpg?.gold ?? 0,
      encumbrance: typeof services.encumbrance === 'function'
        ? services.encumbrance(player)
        : { carried: inventory.carriedWeight(player.rpg || {}), max: maxCarryFor(player) },
      activeGather: sess ? {
        nodeId: sess.nodeId,
        elapsedMs: Math.max(0, nowMono - sess.startedAt),
        durationMs: sess.durationMs,
      } : null,
    };
  }

  // ---- WebSocket Actions ----

  ctx.onAction?.('profession.summary', (p) => {
    ensureProfessionsState(p.rpg);
    mountLocationEntities(ctx.location(p));
    ctx.notify(p, { kind: 'profession.summary', ...summaryOf(p), silent: true });
  });

  ctx.onAction?.('profession.nodes', (p) => {
    const loc = ctx.location(p);
    mountLocationEntities(loc);
    ctx.notify(p, {
      kind: 'profession.nodes',
      location: loc,
      nodes: nodesAt(loc),
      stations: stationsAt(loc, p),
      silent: true,
    });
  });

  ctx.onAction?.('profession.gatherStart', (p, args = {}) => {
    const nodeId = String(args.nodeId ?? '').trim();
    const loc = ctx.location(p);
    const nodeDef = findNodeDefinition(nodeId, loc);
    if (!nodeDef) {
      const err = new Error('That resource node does not exist.');
      err.code = 'NODE_NOT_FOUND';
      throw err;
    }
    const st = ensureProfessionsState(p.rpg);
    const rank = st.tracks[nodeDef.profession]?.rank ?? 1;
    const { tool, footY } = validateGatherPrerequisites(ctx, p, nodeDef, rank);

    const nowUtc = utcNow();
    const nodeState = getNodeState(nodeDef, nowUtc);
    if (nodeState.charges <= 0) {
      const remainSec = nodeState.respawnAt ? Math.max(1, Math.ceil((nodeState.respawnAt - nowUtc) / 1000)) : 60;
      const err = new Error(`${nodeDef.name} is depleted (recovers in ${remainSec}s).`);
      err.code = 'NODE_DEPLETED';
      throw err;
    }

    const prevSess = activeGathers.get(p.id) ?? null;
    const startedAt = monoNow();
    const sess = {
      nodeId: nodeDef.id,
      location: loc,
      startX: Number(p.x) || 0,
      startZ: Number(p.z) || 0,
      startY: footY,
      startedAt,
      durationMs: nodeDef.gatherDurationMs,
      toolId: tool.id,
      toolName: tool.name,
    };
    activeGathers.set(p.id, sess);
    ctx.onRollback?.(() => {
      if (prevSess) activeGathers.set(p.id, prevSess);
      else activeGathers.delete(p.id);
    });

    ctx.notify(p, {
      kind: 'profession.gatherStarted',
      nodeId: nodeDef.id,
      nodeName: nodeDef.name,
      profession: nodeDef.profession,
      professionName: PROFESSIONS[nodeDef.profession]?.name ?? nodeDef.profession,
      toolName: tool.name,
      durationMs: nodeDef.gatherDurationMs,
      charges: nodeState.charges,
      maxCharges: nodeState.maxCharges,
      text: `Gathering ${nodeDef.name} with ${tool.name}…`,
    });
  });

  ctx.onAction?.('profession.gatherCancel', (p) => {
    if (!interruptGather(p, 'cancelled', 'You stop gathering.')) {
      ctx.notify(p, { kind: 'profession.gatherInterrupted', reason: 'none', text: 'You are not gathering right now.', silent: true });
    }
  });

  ctx.onAction?.('profession.gatherComplete', (p, args = {}) => {
    completeGatherSync(p, args);
  });

  ctx.onAction?.('profession.stationOpen', (p, args = {}) => {
    const stationId = String(args.stationId ?? '').trim();
    const stationDef = findStationDefinition(stationId, ctx.location(p), p);
    validateStationProximity(ctx, p, stationDef);
    const st = ensureProfessionsState(p.rpg);
    const prof = stationDef.profession;
    ctx.notify(p, {
      kind: 'profession.station',
      station: { ...stationDef },
      profession: { id: prof, name: PROFESSIONS[prof].name, ...xpProgressFor(st.tracks[prof].xp) },
      recipes: buildRecipeBookView(p.rpg, prof),
      gold: p.rpg.gold ?? 0,
      encumbrance: typeof services.encumbrance === 'function'
        ? services.encumbrance(p)
        : { carried: inventory.carriedWeight(p.rpg), max: maxCarryFor(p) },
      silent: true,
    });
  });

  ctx.onAction?.('profession.craft', (p, args = {}) => {
    craftSync(p, args);
  });

  ctx.onAction?.('profession.writBoard', (p) => {
    const nowUtc = utcNow();
    const { state } = getWritState(p, nowUtc);
    ctx.notify(p, {
      kind: 'profession.writBoard',
      board: buildWritBoardView(p, state, nowUtc),
      silent: true,
    });
  });

  ctx.onAction?.('profession.writTurnIn', (p, args = {}) => {
    turnInWritSync(p, args);
  });

  ctx.onAction?.('profession.eat', (p, args = {}) => {
    ctx.dirty(p);
    const out = consumeCraftedFood(p.rpg, String(args.itemId ?? ''));
    const parts = Object.entries(out.restored).map(([k, v]) => `+${v} ${k}`);
    ctx.emit?.('inventoryChanged', { player: p, reason: 'eat' });
    ctx.notify(p, {
      kind: 'profession.ate',
      ...out,
      text: parts.length ? `You eat ${out.itemName} (${parts.join(', ')}).` : `You eat ${out.itemName}.`,
    });
  });

  ctx.onAction?.('profession.repairWithKit', (p, args = {}) => {
    ctx.dirty(p);
    const out = applyFieldRepairKit(p.rpg, String(args.kitItemId ?? ''), String(args.targetItemId ?? ''));
    ctx.emit?.('inventoryChanged', { player: p, reason: 'repairKit' });
    ctx.notify(p, {
      kind: 'profession.repaired',
      ...out,
      text: `Repaired ${out.targetName} (+${out.repairedBy} condition, ${out.condition}/${out.maxCondition}).`,
    });
  });

  // ---- Exported Service Surface on ctx.services.professions ----

  const profServices = {
    summaryOf,
    nodesAt,
    stationsAt,
    recipesFor: (p, prof = null) => buildRecipeBookView(p.rpg, prof),
    writBoardFor: (p) => buildWritBoardView(p, getWritState(p).state, utcNow()),
    activeGatherOf: (playerId) => activeGathers.get(playerId) ?? null,
    completeGatherDurable,
    craftDurable,
    turnInWritDurable,
    recordAlchemyCraft,
    recordEnchantingCraft,
    npcSellPriceForCrafted,
    auditEconomyBalance: auditAllRecipes,
    consumeCraftedFood: (p, itemId) => consumeCraftedFood(p.rpg, itemId),
    applyFieldRepairKit: (p, kitId, targetId) => applyFieldRepairKit(p.rpg, kitId, targetId),
  };

  services.professions = profServices;
  services.npcSellPriceForCrafted = npcSellPriceForCrafted;

  return { services: profServices };
}
