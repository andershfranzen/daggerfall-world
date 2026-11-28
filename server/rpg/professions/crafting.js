// Crafting stations, character profession progression, recipe crafting, crafted item metadata,
// and classic Potion Maker / Item Maker XP hooks (§3).
import * as inventory from '../inventory.js';
import {
  PROFESSIONS,
  PROFESSION_IDS,
  PROFESSIONS_VERSION,
  RECIPES,
  RECIPE_BY_ID,
  STATION_KINDS,
  FURNITURE_SPECS,
  FOOD_EFFECTS,
  rankForXp,
  xpProgressFor,
  qualityForRank,
  registerProfessionItems,
} from './catalog.js';
import { FLOOR_TOLERANCE } from './nodes.js';

export const STATION_REACH = 4.0; // metres

function makeStation(id, location, kind, name, x, y, z, reach = STATION_REACH) {
  const info = STATION_KINDS[kind];
  if (!info) throw new Error(`Unknown station kind "${kind}"`);
  return Object.freeze({
    id,
    kind: 'crafting_station',
    stationKind: kind,
    profession: info.profession,
    stationLabel: info.label,
    location,
    name,
    x,
    y,
    z,
    reach,
  });
}

/** Authored crafting stations across starter and regional towns. */
export const AUTHORED_STATIONS = Object.freeze({
  'town:Daggerfall/Gothway Garden': Object.freeze([
    makeStation('station:gothway:anvil', 'town:Daggerfall/Gothway Garden', 'anvil', 'Gothway Anvil & Forge', 4, 0, -4),
    makeStation('station:gothway:workbench', 'town:Daggerfall/Gothway Garden', 'workbench', 'Gothway Carpenter Bench', -4, 0, -4),
    makeStation('station:gothway:hearth', 'town:Daggerfall/Gothway Garden', 'hearth', 'Gothway Commons Hearth', 0, 0, 5),
  ]),
  'town:Daggerfall/Daggerfall': Object.freeze([
    makeStation('station:daggerfall:anvil', 'town:Daggerfall/Daggerfall', 'anvil', 'Castle Quarter Forge', 10, 0, -8),
    makeStation('station:daggerfall:workbench', 'town:Daggerfall/Daggerfall', 'workbench', 'Joiners Guild Workbench', -10, 0, -8),
    makeStation('station:daggerfall:hearth', 'town:Daggerfall/Daggerfall', 'hearth', 'Market Square Hearth', 0, 0, 10),
  ]),
  'town:Wayrest/Wayrest': Object.freeze([
    makeStation('station:wayrest:anvil', 'town:Wayrest/Wayrest', 'anvil', 'Wayrest Harbor Forge', 8, 0, -6),
    makeStation('station:wayrest:workbench', 'town:Wayrest/Wayrest', 'workbench', 'Shipwright Workbench', -8, 0, -6),
    makeStation('station:wayrest:hearth', 'town:Wayrest/Wayrest', 'hearth', 'Bayfront Hearth', 0, 0, 8),
  ]),
  'town:Sentinel/Sentinel': Object.freeze([
    makeStation('station:sentinel:anvil', 'town:Sentinel/Sentinel', 'anvil', 'Sentinel Redguard Forge', 8, 0, -6),
    makeStation('station:sentinel:workbench', 'town:Sentinel/Sentinel', 'workbench', 'Sentinel Artisan Bench', -8, 0, -6),
    makeStation('station:sentinel:hearth', 'town:Sentinel/Sentinel', 'hearth', 'Oasis Spice Hearth', 0, 0, 8),
  ]),
});

const STATION_BY_ID = new Map();
for (const list of Object.values(AUTHORED_STATIONS)) {
  for (const s of list) STATION_BY_ID.set(s.id, s);
}

/**
 * Returns crafting stations available in `location` (authored stations + optional active survival campfire
 * for `player` when cooking in the wilderness).
 */
export function stationsForLocation(location, player = null) {
  const base = AUTHORED_STATIONS[location] ? [...AUTHORED_STATIONS[location]] : [];
  const camp = player?.rpg?.survival?.camp;
  if (camp?.active && camp.fireLit && camp.location === location) {
    base.push(makeStation(
      `station:camp:${player.id}`,
      location,
      'hearth',
      'Campfire Hearth',
      Number(camp.x) || 0,
      0,
      Number(camp.z) || 0,
      STATION_REACH,
    ));
  }
  return base;
}

export function findStationDefinition(stationId, locationHint = null, player = null) {
  if (!stationId || typeof stationId !== 'string') return null;
  if (STATION_BY_ID.has(stationId)) return STATION_BY_ID.get(stationId);
  if (locationHint) {
    return stationsForLocation(locationHint, player).find((s) => s.id === stationId) ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Character-scoped profession progression (stored in p.rpg.professions)
// ---------------------------------------------------------------------------

export function ensureProfessionsState(rpg) {
  if (!rpg || typeof rpg !== 'object') throw new Error('Player RPG state missing.');
  const raw = rpg.professions && typeof rpg.professions === 'object' ? rpg.professions : {};
  const rawTracks = raw.tracks && typeof raw.tracks === 'object' ? raw.tracks : {};
  const tracks = {};
  for (const id of PROFESSION_IDS) {
    const t = rawTracks[id] && typeof rawTracks[id] === 'object' ? rawTracks[id] : {};
    const xp = Math.max(0, Math.floor(Number(t.xp) || 0));
    const rank = rankForXp(xp);
    tracks[id] = {
      xp,
      rank,
      actions: Math.max(0, Math.floor(Number(t.actions) || 0)),
    };
  }
  const extraUnlocked = Array.isArray(raw.unlockedRecipes)
    ? raw.unlockedRecipes.filter((id) => RECIPE_BY_ID.has(id))
    : [];
  const unlocked = new Set(extraUnlocked);
  for (const r of RECIPES) {
    if ((tracks[r.profession]?.rank ?? 1) >= r.minRank) unlocked.add(r.id);
  }
  rpg.professions = {
    version: PROFESSIONS_VERSION,
    tracks,
    unlockedRecipes: [...unlocked],
  };
  return rpg.professions;
}

/**
 * Awards XP to a character's profession track, updating rank and auto-unlocking newly eligible recipes.
 * Returns `{ profession, xpGained, xp, previousRank, rank, rankedUp, newlyUnlocked }`.
 */
export function awardProfessionXp(rpg, professionId, amount) {
  if (!PROFESSIONS[professionId]) throw new Error(`Unknown profession "${professionId}".`);
  const st = ensureProfessionsState(rpg);
  const track = st.tracks[professionId];
  const gain = Math.max(0, Math.floor(Number(amount) || 0));
  const previousRank = track.rank;
  track.xp += gain;
  track.rank = rankForXp(track.xp);
  track.actions += 1;

  const beforeUnlocked = new Set(st.unlockedRecipes);
  const newlyUnlocked = [];
  for (const r of RECIPES) {
    if (r.profession === professionId && track.rank >= r.minRank && !beforeUnlocked.has(r.id)) {
      beforeUnlocked.add(r.id);
      newlyUnlocked.push(r.id);
    }
  }
  st.unlockedRecipes = [...beforeUnlocked];

  return {
    profession: professionId,
    professionName: PROFESSIONS[professionId].name,
    xpGained: gain,
    xp: track.xp,
    previousRank,
    rank: track.rank,
    rankedUp: track.rank > previousRank,
    newlyUnlocked,
  };
}

export function buildProfessionsSummary(rpg) {
  const st = ensureProfessionsState(rpg);
  const tracks = PROFESSION_IDS.map((id) => {
    const meta = PROFESSIONS[id];
    const t = st.tracks[id];
    const prog = xpProgressFor(t.xp);
    return {
      id,
      name: meta.name,
      kind: meta.kind,
      tool: meta.tool ?? null,
      station: meta.station ?? null,
      description: meta.description,
      actions: t.actions,
      ...prog,
    };
  });
  return {
    version: st.version,
    tracks,
    unlockedRecipes: [...st.unlockedRecipes],
  };
}

// ---------------------------------------------------------------------------
// Inventory eligibility & capacity helpers for crafting
// ---------------------------------------------------------------------------

/** Counts eligible crafting units of `template` in `rpg.inventory` (excludes equipped/quest/stolen/conjured). */
export function countEligibleInput(rpg, template) {
  const resolved = inventory.resolveTemplate(template);
  if (!resolved || !Array.isArray(rpg?.inventory)) return 0;
  let total = 0;
  for (const it of rpg.inventory) {
    if (!it || it.template !== resolved.key) continue;
    const elig = inventory.checkItemEligibility(it, 'craft');
    if (elig.ok) total += Math.max(0, Math.trunc(Number(it.quantity) || 0));
  }
  return total;
}

/**
 * Computes exact inventory weight delta and slot delta for a craft job BEFORE mutating anything.
 * Guarantees overweight or full-pack checks refuse cleanly without touching inputs or gold.
 */
export function planCraftCapacity(rpg, recipe, batches, maxEncumbranceKg, craftedMeta) {
  registerProfessionItems();
  const inv = Array.isArray(rpg.inventory) ? rpg.inventory : [];
  let consumedWeight = 0;
  let freedSlots = 0;
  const consumptionPlan = [];

  for (const inp of recipe.inputs) {
    const resolved = inventory.resolveTemplate(inp.template);
    if (!resolved) throw new Error(`Unknown input template "${inp.template}".`);
    const needed = inp.quantity * batches;
    let remaining = needed;
    const matching = inv.filter((it) => it && it.template === resolved.key);
    let sawIneligible = null;

    for (const it of matching) {
      const elig = inventory.checkItemEligibility(it, 'craft');
      if (!elig.ok) {
        if (!sawIneligible) sawIneligible = elig;
        continue;
      }
      if (remaining <= 0) break;
      const takeQty = Math.min(it.quantity, remaining);
      consumptionPlan.push({ itemId: it.id, quantity: takeQty, name: it.name, template: it.template });
      consumedWeight += (Number(it.weight) || 0) * takeQty;
      if (takeQty === it.quantity) freedSlots += 1;
      remaining -= takeQty;
    }

    if (remaining > 0) {
      if (sawIneligible && matching.reduce((n, i) => n + i.quantity, 0) >= needed) {
        const err = new Error(sawIneligible.reason);
        err.code = sawIneligible.code;
        throw err;
      }
      const desc = inventory.describeTemplate(resolved.key);
      const err = new Error(`Need ${needed} × ${desc.name} (have ${needed - remaining}).`);
      err.code = 'MISSING_MATERIALS';
      throw err;
    }
  }

  const outDesc = inventory.describeTemplate(recipe.output.template);
  const outQty = recipe.output.quantity * batches;
  const addedWeight = (Number(outDesc.weight) || 0) * outQty;
  const totalFee = (recipe.fee || 0) * batches;
  const goldWeightDelta = -totalFee / inventory.GOLD_PER_KG;

  const currentWeight = inventory.carriedWeight(rpg);
  const projectedWeight = Math.round((currentWeight - consumedWeight + addedWeight + goldWeightDelta) * 100) / 100;
  if (projectedWeight > maxEncumbranceKg) {
    const err = new Error(`Crafted output would exceed your carry limit (${projectedWeight.toFixed(1)} / ${maxEncumbranceKg} kg).`);
    err.code = 'OVERWEIGHT';
    throw err;
  }

  // Compute net slot count after removals & insertions.
  let addedSlots = 0;
  if (outDesc.stackable) {
    const proto = inventory.makeItem(outDesc.template, 1, 'probe', { crafted: craftedMeta });
    const existingStack = inv.find((it) => {
      if (!it || !inventory.canMergeStacks(it, proto)) return false;
      const fullConsumed = consumptionPlan.some((c) => c.itemId === it.id && c.quantity === it.quantity);
      return !fullConsumed && (it.quantity + outQty <= inventory.MAX_STACK);
    });
    addedSlots = existingStack ? 0 : 1;
  } else {
    addedSlots = outQty;
  }

  const projectedSlots = inv.length - freedSlots + addedSlots;
  if (projectedSlots > inventory.MAX_ITEMS) {
    const err = new Error('Your pack does not have enough free slots for the crafted item.');
    err.code = 'PACK_FULL';
    throw err;
  }

  return {
    consumptionPlan,
    outDesc,
    outQty,
    totalFee,
    projectedWeight,
    projectedSlots,
  };
}

/** Validates station proximity, floor, visibility, recipe eligibility, and gold before crafting. */
export function validateStationProximity(ctx, player, stationDef) {
  const fail = (code, msg) => {
    const err = new Error(msg);
    err.code = code;
    throw err;
  };
  if (!stationDef) fail('STATION_NOT_FOUND', 'That crafting station does not exist.');
  if (player.rpg?.defeated) fail('PLAYER_DEFEATED', 'You cannot craft while defeated.');
  const loc = ctx.location(player);
  if (loc !== stationDef.location) fail('WRONG_LOCATION', 'You must stand near the crafting station.');
  const dist = Math.hypot((Number(player.x) || 0) - stationDef.x, (Number(player.z) || 0) - stationDef.z);
  if (dist > (stationDef.reach ?? STATION_REACH)) {
    fail('OUT_OF_REACH', `Move closer to ${stationDef.name} (${dist.toFixed(1)} m away).`);
  }
  const footY = ctx.services?.collision?.footY?.(player) ?? (Number.isFinite(player.footY) ? player.footY : (Number.isFinite(player.y) ? player.y : 0));
  if (Number.isFinite(footY) && Number.isFinite(stationDef.y) && Math.abs(footY - stationDef.y) > FLOOR_TOLERANCE) {
    fail('WRONG_FLOOR', `${stationDef.name} is on a different floor.`);
  }
  if (typeof ctx.services?.canSee === 'function') {
    if (!ctx.services.canSee(loc, Number(player.x) || 0, Number(player.z) || 0, stationDef.x, stationDef.z)) {
      fail('NO_LINE_OF_SIGHT', `You cannot reach ${stationDef.name} from here.`);
    }
  }
}

/**
 * Executes a validated crafting job directly on `rpg`, consuming inputs via `takeForTransfer('craft')`,
 * deducting gold fee, creating crafted output tagged with maker/quality metadata, and awarding XP.
 */
export function executeCraftOnRpg(player, rpg, recipe, batches, maxEncumbranceKg, nowUtc) {
  registerProfessionItems();
  const st = ensureProfessionsState(rpg);
  const track = st.tracks[recipe.profession];
  if (!track || track.rank < recipe.minRank) {
    const err = new Error(`${recipe.name} requires ${PROFESSIONS[recipe.profession]?.name ?? recipe.profession} Rank ${recipe.minRank}.`);
    err.code = 'RANK_TOO_LOW';
    throw err;
  }
  if (!st.unlockedRecipes.includes(recipe.id)) {
    const err = new Error(`You have not unlocked the recipe for ${recipe.name}.`);
    err.code = 'RECIPE_LOCKED';
    throw err;
  }

  const totalFee = (recipe.fee || 0) * batches;
  if ((rpg.gold || 0) < totalFee) {
    const err = new Error(`Need ${totalFee} gold for station supplies (you have ${rpg.gold || 0}).`);
    err.code = 'INSUFFICIENT_GOLD';
    throw err;
  }

  const quality = qualityForRank(track.rank, recipe.minRank);
  const craftedMeta = {
    makerId: player.id,
    makerName: player.name || `Adventurer #${player.id}`,
    profession: recipe.profession,
    recipeId: recipe.id,
    quality: quality.label,
    qualityKey: quality.key,
    qualityTier: quality.tier,
    craftedAt: nowUtc,
    ...(FURNITURE_SPECS[recipe.output.template] ? { furniture: FURNITURE_SPECS[recipe.output.template] } : {}),
  };

  // Validate inputs, eligibility, weight, and slots BEFORE charging anything.
  const plan = planCraftCapacity(rpg, recipe, batches, maxEncumbranceKg, craftedMeta);

  // Consume materials via inventory.takeForTransfer(..., 'craft').
  for (const step of plan.consumptionPlan) {
    inventory.takeForTransfer(rpg, step.itemId, step.quantity, 'craft');
  }
  if (totalFee > 0) {
    inventory.removeItem(rpg, 'gold', totalFee);
  }

  // Create crafted items tagged with maker/quality metadata.
  const createdIds = [];
  let createdRecord = null;
  if (plan.outDesc.stackable) {
    const it = inventory.addItem(rpg, plan.outDesc.template, plan.outQty, { extra: { crafted: craftedMeta } });
    createdIds.push(it.id);
    createdRecord = it;
  } else {
    for (let i = 0; i < plan.outQty; i++) {
      const it = inventory.addItem(rpg, plan.outDesc.template, 1, { extra: { crafted: craftedMeta } });
      createdIds.push(it.id);
      createdRecord = it;
    }
  }

  const xpResult = awardProfessionXp(rpg, recipe.profession, recipe.xp * batches);

  return {
    recipeId: recipe.id,
    recipeName: recipe.name,
    profession: recipe.profession,
    batches,
    outputTemplate: plan.outDesc.template,
    outputName: createdRecord?.name ?? plan.outDesc.name,
    outputQuantity: plan.outQty,
    createdIds,
    quality,
    crafted: craftedMeta,
    feePaid: totalFee,
    xp: xpResult,
  };
}

/** Builds recipe book view for UI with live player inventory counts and craftability flags. */
export function buildRecipeBookView(rpg, filterProfession = null) {
  registerProfessionItems();
  const st = ensureProfessionsState(rpg);
  const unlocked = new Set(st.unlockedRecipes);
  const list = filterProfession ? RECIPES.filter((r) => r.profession === filterProfession) : RECIPES;
  return list.map((r) => {
    const track = st.tracks[r.profession];
    const rank = track?.rank ?? 1;
    const isUnlocked = unlocked.has(r.id) && rank >= r.minRank;
    const outDesc = inventory.describeTemplate(r.output.template);
    const inputs = r.inputs.map((inp) => {
      const d = inventory.describeTemplate(inp.template);
      const have = countEligibleInput(rpg, inp.template);
      return { template: inp.template, name: d.name, quantity: inp.quantity, have, enough: have >= inp.quantity };
    });
    const quality = qualityForRank(rank, r.minRank);
    const canCraft = isUnlocked && (rpg.gold || 0) >= r.fee && inputs.every((i) => i.enough);
    return {
      id: r.id,
      name: r.name,
      profession: r.profession,
      professionName: PROFESSIONS[r.profession]?.name ?? r.profession,
      stationKind: r.stationKind,
      stationLabel: STATION_KINDS[r.stationKind]?.label ?? r.stationKind,
      category: r.category,
      minRank: r.minRank,
      xp: r.xp,
      fee: r.fee,
      description: r.description,
      unlocked: isUnlocked,
      canCraft,
      quality,
      inputs,
      output: {
        template: r.output.template,
        name: outDesc.name,
        quantity: r.output.quantity,
        weight: outDesc.weight,
        value: outDesc.value,
        furniture: FURNITURE_SPECS[r.output.template] ?? null,
        food: FOOD_EFFECTS[r.output.template] ?? null,
      },
    };
  });
}

/**
 * Consume a cooked food item, applying recovery through existing character vitals
 * (`health`, `fatigue`, `magicka`) and optional survival food/water if enabled.
 */
export function consumeCraftedFood(rpg, itemId) {
  const it = (rpg?.inventory ?? []).find((x) => x && x.id === itemId);
  if (!it) throw new Error('You do not have that food item.');
  const eff = FOOD_EFFECTS[it.template];
  if (!eff || it.group !== 'food') throw new Error(`${it.name} is not edible food.`);

  const ch = rpg.character;
  const restored = {};
  if (ch && typeof ch === 'object') {
    for (const [stat, maxKey] of [['health', 'maxHealth'], ['fatigue', 'maxFatigue'], ['magicka', 'maxMagicka']]) {
      const amt = eff[stat];
      if (amt > 0 && Number.isFinite(ch[stat]) && Number.isFinite(ch[maxKey])) {
        const before = ch[stat];
        ch[stat] = Math.min(ch[maxKey], ch[stat] + amt);
        if (ch[stat] > before) restored[stat] = ch[stat] - before;
      }
    }
  }
  if (rpg.survival?.enabled) {
    if (eff.survivalFood > 0) rpg.survival.food = Math.min(100, Math.round(((rpg.survival.food ?? 100) + eff.survivalFood) * 10) / 10);
    if (eff.survivalWater > 0) rpg.survival.water = Math.min(100, Math.round(((rpg.survival.water ?? 100) + eff.survivalWater) * 10) / 10);
  }
  inventory.removeItem(rpg, it.id, 1);
  return { itemName: it.name, template: it.template, restored };
}

/**
 * Use a crafted `field-repair-kit` to repair a worn tool, weapon, or armor piece in inventory.
 * Preserves item identity and `crafted` metadata!
 */
export function applyFieldRepairKit(rpg, kitItemId, targetItemId) {
  const kit = (rpg?.inventory ?? []).find((x) => x && x.id === kitItemId);
  if (!kit || kit.template !== 'field-repair-kit') throw new Error('Select a Field Repair Kit.');
  const target = (rpg?.inventory ?? []).find((x) => x && x.id === targetItemId);
  if (!target) throw new Error('Item to repair not found.');
  if (!Number.isFinite(target.maxCondition) || target.maxCondition <= 1) throw new Error(`${target.name} cannot be repaired.`);
  if (target.condition >= target.maxCondition) throw new Error(`${target.name} is already in pristine condition.`);

  const qualityBonus = kit.crafted?.qualityTier ? (kit.crafted.qualityTier - 1) * 0.15 : 0;
  const restoreAmt = Math.max(20, Math.ceil(target.maxCondition * (0.45 + qualityBonus)));
  const before = target.condition;
  target.condition = Math.min(target.maxCondition, target.condition + restoreAmt);
  inventory.removeItem(rpg, kit.id, 1);
  return {
    targetId: target.id,
    targetName: target.name,
    repairedBy: target.condition - before,
    condition: target.condition,
    maxCondition: target.maxCondition,
    crafted: target.crafted ?? null,
  };
}
