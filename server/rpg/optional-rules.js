// Optional DFU Gameplay Rules, Endgame Builds, Wardrobe/Succession, and Beyond-Iliac-Bay Expansion Hooks (§7 & §9).
//
// Covers:
//   1. DFU Optional Gameplay Rules (explicitly scoped: world / operator / player):
//      - enemyInfighting, enhancedEnemyAI, advancedClimbing, alternateEncounters,
//        weaponHandSwitching, instantRepairs, magicItemRepairs, restLimits, guildQuestList.
//      - Quest Debugger (transactional, owner/operator-scoped read-only inspection + dry-run repair).
//   2. Endgame Progression & Build Comparison:
//      - Renown tiers, Firmament constellations, Martial/Arcane specializations, Equipment Sets,
//        and deterministic side-by-side `compareBuilds(character, buildA, buildB)`.
//   3. Wardrobe & Cosmetics Collection (zero combat power; durable unlocks & equipped cosmetics).
//   4. Family Succession Data Model (lineage, heir designation, tagged heirlooms).
//   5. Beyond-Iliac-Bay Province Expansion Registry (manifest-driven province hooks).
//
// Actions:
//   rules.status            {}
//   rules.set               { rule, value }
//   rules.repairItem        { itemId }
//   rules.questDebug        { uid?, includeRepairScan? }
//   endgame.status          {}
//   endgame.selectFirmament { signId }
//   endgame.selectSpec      { specId }
//   endgame.compareBuilds   { buildA, buildB }
//   wardrobe.status         {}
//   wardrobe.unlock         { cosmeticId }
//   wardrobe.equip          { slot, cosmeticId }
//   succession.status       {}
//   succession.designate    { lineageName?, heirName?, heirCharacterId? }
//   succession.tagHeirloom  { itemId }
//   expansion.list          {}
//
// Services (ctx.services.optionalRules):
//   getRule, setRule, resolveEnemyInfighting, evaluateEnhancedAI, climbingParams, repairItem,
//   questDebug, awardRenown, compareBuilds, registerExpansion, listExpansions

export const name = 'optionalRules';
export const WORLD_PREFIX = 'optionalRules/';

export const DEFAULT_WORLD_RULES = Object.freeze({
  enemyInfighting: { value: true, scope: 'world', label: 'Enemy Infighting (DFU)' },
  enhancedEnemyAI: { value: true, scope: 'world', label: 'Enhanced Enemy AI (DFU)' },
  advancedClimbing: { value: true, scope: 'player', label: 'Advanced Climbing (DFU)' },
  alternateEncounters: { value: false, scope: 'world', label: 'Alternate Encounter Selection' },
  weaponHandSwitching: { value: true, scope: 'player', label: 'Weapon Hand Switching' },
  instantRepairs: { value: false, scope: 'world', label: 'Instant Shop Repairs (DFU)' },
  magicItemRepairs: { value: false, scope: 'world', label: 'Magic Item Repairs (DFU)' },
  restLimits: { value: true, scope: 'world', label: 'Classic Rest Limits' },
  guildQuestList: { value: true, scope: 'world', label: 'DFU Guild Quest List' },
});

export const RENOWN_TIERS = Object.freeze([
  Object.freeze({ rank: 0, min: 0, title: 'Wayfarer' }),
  Object.freeze({ rank: 1, min: 50, title: 'Iliac Sworn' }),
  Object.freeze({ rank: 2, min: 150, title: 'Bay Champion' }),
  Object.freeze({ rank: 3, min: 350, title: 'Knight of the Reach' }),
  Object.freeze({ rank: 4, min: 700, title: 'Legend of High Rock' }),
]);

export const FIRMAMENT_SIGNS = Object.freeze([
  Object.freeze({ id: 'warrior', name: 'The Warrior', attackBonus: 12, mitigationBonus: 6, spellBonus: 0, healthBonus: 20 }),
  Object.freeze({ id: 'mage', name: 'The Mage', attackBonus: 0, mitigationBonus: 2, spellBonus: 18, healthBonus: 5 }),
  Object.freeze({ id: 'thief', name: 'The Thief', attackBonus: 10, mitigationBonus: 8, spellBonus: 4, healthBonus: 10 }),
  Object.freeze({ id: 'steed', name: 'The Steed', attackBonus: 6, mitigationBonus: 5, spellBonus: 5, healthBonus: 15 }),
]);

export const SPECIALIZATIONS = Object.freeze([
  Object.freeze({ id: 'vanguard', track: 'martial', name: 'Iron Vanguard', attackBonus: 14, mitigationBonus: 14, spellBonus: 0, healthBonus: 35 }),
  Object.freeze({ id: 'duelist', track: 'martial', name: 'Iliac Duelist', attackBonus: 22, mitigationBonus: 6, spellBonus: 2, healthBonus: 15 }),
  Object.freeze({ id: 'battlemage', track: 'arcane', name: 'Bay Battlemage', attackBonus: 10, mitigationBonus: 8, spellBonus: 18, healthBonus: 20 }),
  Object.freeze({ id: 'arcanist', track: 'arcane', name: 'Aetherius Arcanist', attackBonus: 2, mitigationBonus: 4, spellBonus: 28, healthBonus: 10 }),
]);

export const EQUIPMENT_SETS = Object.freeze([
  Object.freeze({
    id: 'set-sentinel-guard',
    name: 'Sentinel Guard Panoply',
    twoPiece: { mitigationBonus: 10, healthBonus: 25 },
    fourPiece: { attackBonus: 12, mitigationBonus: 18, healthBonus: 40 },
  }),
  Object.freeze({
    id: 'set-direnni-weave',
    name: 'Direnni Spellweave',
    twoPiece: { spellBonus: 12, mitigationBonus: 4 },
    fourPiece: { spellBonus: 26, healthBonus: 15 },
  }),
  Object.freeze({
    id: 'set-corsair-raider',
    name: 'Iliac Corsair Leathers',
    twoPiece: { attackBonus: 12, mitigationBonus: 5 },
    fourPiece: { attackBonus: 24, mitigationBonus: 10, healthBonus: 20 },
  }),
]);

export const COSMETIC_CATALOG = Object.freeze([
  Object.freeze({ id: 'cloak-daggerfall-crimson', slot: 'cloak', name: 'Daggerfall Crimson Cloak', rarity: 'common', defaultUnlocked: true }),
  Object.freeze({ id: 'cloak-sentinel-gold', slot: 'cloak', name: 'Sentinel Sun-Weave Cloak', rarity: 'rare', defaultUnlocked: false }),
  Object.freeze({ id: 'dye-wayrest-emerald', slot: 'dye', name: 'Wayrest Emerald Dye', rarity: 'common', defaultUnlocked: true }),
  Object.freeze({ id: 'heraldry-dragon-crest', slot: 'heraldry', name: 'Dragon Crest Tabard', rarity: 'epic', defaultUnlocked: false }),
  Object.freeze({ id: 'title-bay-explorer', slot: 'title', name: 'Explorer of the Iliac Bay', rarity: 'rare', defaultUnlocked: true }),
]);

export const DEFAULT_EXPANSIONS = Object.freeze([
  Object.freeze({
    id: 'skyrim-western-reach',
    province: 'Skyrim',
    region: 'Western Reach',
    manifestVersion: '0.1.0',
    gateLocation: 'town:Wrothgarian Mountains/Shedungent',
    climate: 'alpine-mountain',
    status: 'preview-hook',
    requiredRenownRank: 2,
    summary: 'Mountain pass expansion hook linking Wrothgar into the Western Reach.',
  }),
  Object.freeze({
    id: 'cyrodiil-colovian-highlands',
    province: 'Cyrodiil',
    region: 'Colovian Highlands',
    manifestVersion: '0.1.0',
    gateLocation: 'town:Wayrest/Wayrest',
    climate: 'temperate-highlands',
    status: 'preview-hook',
    requiredRenownRank: 3,
    summary: 'Overland trade road hook beyond southern High Rock and Hammerfell.',
  }),
  Object.freeze({
    id: 'hammerfell-dragonstar-frontier',
    province: 'Hammerfell',
    region: 'Dragonstar Frontier',
    manifestVersion: '0.1.0',
    gateLocation: "town:Alik'r Desert/The Stuvam Graveyard",
    climate: 'arid-canyon',
    status: 'preview-hook',
    requiredRenownRank: 2,
    summary: 'Desert caravan frontier extending eastward beyond the Iliac Bay.',
  }),
]);

const SIGN_BY_ID = new Map(FIRMAMENT_SIGNS.map((s) => [s.id, s]));
const SPEC_BY_ID = new Map(SPECIALIZATIONS.map((s) => [s.id, s]));
const SET_BY_ID = new Map(EQUIPMENT_SETS.map((s) => [s.id, s]));
const COSMETIC_BY_ID = new Map(COSMETIC_CATALOG.map((c) => [c.id, c]));

export function renownTierOf(points) {
  const n = Math.max(0, Math.trunc(Number(points) || 0));
  let tier = RENOWN_TIERS[0];
  for (const t of RENOWN_TIERS) if (n >= t.min) tier = t;
  return { ...tier, points: n };
}

/** Pure DFU Enemy Infighting rule: distinct hostile monster factions can turn on each other. */
export function resolveEnemyInfighting(attacker, target, enabled = true) {
  if (!enabled || !attacker || !target) return { hostile: false, reason: 'disabled-or-invalid' };
  if (attacker.id && target.id && attacker.id === target.id) return { hostile: false, reason: 'same-entity' };
  const gA = String(attacker.group ?? attacker.faction ?? 'unknown').toLowerCase();
  const gB = String(target.group ?? target.faction ?? 'unknown').toLowerCase();
  if (gA === gB) return { hostile: false, reason: 'same-faction' };
  return { hostile: true, reason: 'cross-faction-infighting', factions: [gA, gB] };
}

/** Pure DFU Enhanced Enemy AI decision evaluator. */
export function evaluateEnhancedAI(monster, context = {}, enabled = true) {
  const hp = Math.max(0, Number(monster?.hp) || 0);
  const maxHp = Math.max(1, Number(monster?.maxHp) || 1);
  const hpRatio = hp / maxHp;
  if (!enabled) {
    return { enhanced: false, action: 'direct-advance', flankAngle: 0, openDoors: false, retreat: false };
  }
  const hasRanged = Boolean(monster?.hasBow || monster?.hasSpells);
  const dist = Number.isFinite(context.distance) ? context.distance : 5;
  const blockedByDoor = Boolean(context.blockedByDoor);
  const alliesNearby = Math.max(0, Math.trunc(Number(context.alliesNearby) || 0));

  if (hpRatio <= 0.2 && monster?.intelligent !== false) {
    return { enhanced: true, action: 'retreat-and-recover', flankAngle: Math.PI, openDoors: true, retreat: true };
  }
  if (blockedByDoor && monster?.canOpenDoors !== false) {
    return { enhanced: true, action: 'open-door', flankAngle: 0, openDoors: true, retreat: false };
  }
  if (hasRanged && dist < 4.5) {
    return { enhanced: true, action: 'kite-backstep', flankAngle: 0.35, openDoors: true, retreat: false };
  }
  if (alliesNearby >= 1 && dist <= 8) {
    const flankAngle = ((Number(monster?.id) || 1) % 2 === 0 ? 1 : -1) * 0.65;
    return { enhanced: true, action: 'flank-target', flankAngle, openDoors: true, retreat: false };
  }
  return { enhanced: true, action: 'tactical-advance', flankAngle: 0, openDoors: true, retreat: false };
}

/** Pure DFU Advanced Climbing parameters. */
export function climbingParams(player, enabled = true) {
  const climbingSkill = Number(player?.rpg?.character?.skills?.Climbing) || 20;
  if (!enabled) {
    return {
      advanced: false,
      strafeClimb: false,
      maxWallSlopeDeg: 85,
      verticalSpeed: 1.4,
      fatiguePerSecond: 3.0,
      gripBonus: Math.round(climbingSkill * 0.5),
    };
  }
  return {
    advanced: true,
    strafeClimb: true,
    maxWallSlopeDeg: 95,
    verticalSpeed: Math.round((1.85 + climbingSkill * 0.01) * 100) / 100,
    fatiguePerSecond: Math.max(1.0, Math.round((2.1 - climbingSkill * 0.01) * 100) / 100),
    gripBonus: Math.round(climbingSkill * 0.85 + 10),
  };
}

/** Evaluates one endgame build configuration against character baseline stats. */
export function evaluateEndgameBuild(character, build = {}) {
  const level = Math.max(1, Number(character?.level) || 1);
  const str = Number(character?.attributes?.Strength) || 50;
  const intel = Number(character?.attributes?.Intelligence) || 50;
  const end = Number(character?.attributes?.Endurance) || 50;

  const renownPoints = Math.max(0, Number(build.renownPoints) || 0);
  const renown = renownTierOf(renownPoints);
  const sign = SIGN_BY_ID.get(build.firmamentId) ?? FIRMAMENT_SIGNS[0];
  const spec = SPEC_BY_ID.get(build.specId) ?? SPECIALIZATIONS[0];
  const eqSet = SET_BY_ID.get(build.setId) ?? null;
  const setPieces = Math.max(0, Math.min(4, Math.trunc(Number(build.setPieces) || 0)));

  let attack = Math.round(level * 2.5 + str * 0.4 + renown.rank * 4 + sign.attackBonus + spec.attackBonus);
  let mitigation = Math.round(level * 1.5 + end * 0.35 + renown.rank * 3 + sign.mitigationBonus + spec.mitigationBonus);
  let spellpower = Math.round(level * 2.2 + intel * 0.45 + renown.rank * 3 + sign.spellBonus + spec.spellBonus);
  let survivability = Math.round(100 + level * 8 + end * 1.2 + renown.rank * 12 + sign.healthBonus + spec.healthBonus);

  const activeSetBonuses = [];
  if (eqSet && setPieces >= 2) {
    attack += eqSet.twoPiece.attackBonus ?? 0;
    mitigation += eqSet.twoPiece.mitigationBonus ?? 0;
    spellpower += eqSet.twoPiece.spellBonus ?? 0;
    survivability += eqSet.twoPiece.healthBonus ?? 0;
    activeSetBonuses.push(`${eqSet.name} (2pc)`);
  }
  if (eqSet && setPieces >= 4) {
    attack += eqSet.fourPiece.attackBonus ?? 0;
    mitigation += eqSet.fourPiece.mitigationBonus ?? 0;
    spellpower += eqSet.fourPiece.spellBonus ?? 0;
    survivability += eqSet.fourPiece.healthBonus ?? 0;
    activeSetBonuses.push(`${eqSet.name} (4pc)`);
  }

  const totalScore = Math.round(attack * 1.15 + spellpower * 1.1 + mitigation * 1.2 + survivability * 0.4);
  return {
    renownTier: renown.title,
    renownRank: renown.rank,
    firmament: sign.name,
    specialization: spec.name,
    equipmentSet: eqSet ? `${eqSet.name} (${setPieces}pc)` : 'None',
    activeSetBonuses,
    metrics: { attack, mitigation, spellpower, survivability, totalScore },
  };
}

/** Single high-level endgame build comparison returning exact deltas between buildA and buildB. */
export function compareBuilds(character, buildA, buildB) {
  const a = evaluateEndgameBuild(character, buildA);
  const b = evaluateEndgameBuild(character, buildB);
  const delta = {
    attack: b.metrics.attack - a.metrics.attack,
    mitigation: b.metrics.mitigation - a.metrics.mitigation,
    spellpower: b.metrics.spellpower - a.metrics.spellpower,
    survivability: b.metrics.survivability - a.metrics.survivability,
    totalScore: b.metrics.totalScore - a.metrics.totalScore,
  };
  return {
    buildA: a,
    buildB: b,
    delta,
    recommendation: delta.totalScore > 0 ? 'buildB' : (delta.totalScore < 0 ? 'buildA' : 'even'),
  };
}

function ensurePlayerRulesState(p) {
  if (!p.rpg || typeof p.rpg !== 'object') p.rpg = {};
  if (!p.rpg.optionalRules || typeof p.rpg.optionalRules !== 'object') {
    p.rpg.optionalRules = { advancedClimbing: true, weaponHandSwitching: true };
  }
  if (!p.rpg.endgame || typeof p.rpg.endgame !== 'object') {
    p.rpg.endgame = { renown: 0, firmamentId: 'warrior', specId: 'vanguard', setId: 'set-sentinel-guard', setPieces: 2, renownLog: [] };
  }
  if (!p.rpg.wardrobe || typeof p.rpg.wardrobe !== 'object') {
    p.rpg.wardrobe = {
      unlocked: COSMETIC_CATALOG.filter((c) => c.defaultUnlocked).map((c) => c.id),
      equipped: { cloak: 'cloak-daggerfall-crimson', dye: 'dye-wayrest-emerald', heraldry: null, title: 'title-bay-explorer' },
    };
  }
  if (!p.rpg.succession || typeof p.rpg.succession !== 'object') {
    p.rpg.succession = {
      lineageName: `${p.name || 'House'} Lineage`,
      generation: 1,
      heirCharacterId: null,
      heirName: null,
      heirloomItemIds: [],
      history: [],
    };
  }
  return {
    rules: p.rpg.optionalRules,
    endgame: p.rpg.endgame,
    wardrobe: p.rpg.wardrobe,
    succession: p.rpg.succession,
  };
}

export function install(ctx, options = {}) {
  const services = (ctx.services ||= {});
  const worldRules = new Map();
  for (const [k, spec] of Object.entries(DEFAULT_WORLD_RULES)) {
    const initial = options.rules?.[k] ?? ctx.config?.optionalRules?.[k] ?? spec.value;
    worldRules.set(k, { ...spec, value: Boolean(initial) });
  }
  for (const [k, v] of ctx.loadWorld?.(`${WORLD_PREFIX}rule:`) ?? []) {
    const ruleName = k.slice(`${WORLD_PREFIX}rule:`.length);
    if (worldRules.has(ruleName) && v && typeof v.value === 'boolean') {
      worldRules.get(ruleName).value = v.value;
    }
  }

  const expansions = new Map(DEFAULT_EXPANSIONS.map((e) => [e.id, { ...e }]));

  function getRule(ruleName, player = null) {
    const entry = worldRules.get(ruleName);
    if (!entry) return false;
    if (entry.scope === 'player' && player) {
      const st = ensurePlayerRulesState(player).rules;
      if (typeof st[ruleName] === 'boolean') return st[ruleName];
    }
    return entry.value;
  }

  function setRule(ruleName, value, { player = null, operator = false } = {}) {
    const entry = worldRules.get(ruleName);
    if (!entry) throw new Error(`Unknown optional rule "${ruleName}".`);
    const boolVal = Boolean(value);
    if (entry.scope === 'player' && player) {
      ctx.dirty(player);
      ensurePlayerRulesState(player).rules[ruleName] = boolVal;
      return { rule: ruleName, value: boolVal, scope: 'player' };
    }
    if (!operator && player && player.role !== 'operator' && ctx.config?.allowPlayerWorldRules !== true && options.allowPlayerWorldRules === false) {
      throw new Error(`Rule "${ruleName}" is server-scoped and requires operator permission.`);
    }
    const prev = entry.value;
    entry.value = boolVal;
    ctx.dirtyWorld?.(`${WORLD_PREFIX}rule:${ruleName}`, { value: boolVal });
    ctx.onRollback?.(() => { entry.value = prev; });
    return { rule: ruleName, value: boolVal, scope: entry.scope };
  }

  function repairItem(p, itemId) {
    if (!Array.isArray(p.rpg?.inventory)) throw new Error('Inventory unavailable.');
    const item = p.rpg.inventory.find((it) => it && it.id === itemId);
    if (!item) throw new Error('Item not found in inventory.');
    const isMagic = Boolean(item.enchantments?.length || item.magic || item.artifact);
    if (isMagic && !getRule('magicItemRepairs', p)) {
      throw new Error('Magic item repairs are disabled by world rules.');
    }
    const maxCond = Math.max(1, Number(item.maxCondition ?? item.maxDurability) || 100);
    const curCond = Number(item.condition ?? item.durability ?? maxCond);
    if (curCond >= maxCond) throw new Error(`${item.name || item.template} is already in full condition.`);
    const missing = maxCond - curCond;
    const cost = Math.max(5, Math.round(missing * (isMagic ? 2.5 : 1.0)));
    const purse = Number(p.rpg.gold) || 0;
    if (purse < cost) throw new Error(`Repair requires ${cost} gold.`);

    ctx.dirty(p);
    if (typeof services.takeGold === 'function') services.takeGold(p, cost);
    else p.rpg.gold = purse - cost;

    const instant = getRule('instantRepairs', p);
    if (instant) {
      if ('condition' in item || !('durability' in item)) item.condition = maxCond;
      if ('durability' in item) item.durability = maxCond;
    } else {
      item.repairTicket = {
        readyAt: Math.trunc((ctx.now?.() ?? Date.now()) + 60_000),
        targetCondition: maxCond,
      };
    }
    return { itemId: item.id, name: item.name || item.template, cost, instant, magic: isMagic, condition: item.condition ?? curCond };
  }

  function questDebug(p, { uid = null, includeRepairScan = true } = {}) {
    const active = Array.isArray(p.rpg?.quests?.active) ? p.rpg.quests.active : [];
    const filtered = uid ? active.filter((q) => String(q.uid ?? q.name) === String(uid)) : active;
    const partyQuests = services.partyQuests?.activeForPlayer?.(p) ?? [];
    const repairScan = includeRepairScan && services.questRepair?.scan ? services.questRepair.scan(p) : [];
    return {
      ownerId: p.id,
      ownerName: p.name,
      scope: 'character-scoped-readonly',
      activeCount: filtered.length,
      quests: filtered.map((q) => ({
        uid: q.uid ?? q.name,
        name: q.name,
        title: q.title ?? q.name,
        places: Object.entries(q.places ?? {}).map(([k, v]) => ({ key: k, location: v.interior ?? v.location, layoutId: v.layoutId ?? null })),
        items: Object.entries(q.items ?? {}).map(([k, v]) => ({ key: k, name: v.name, given: Boolean(v.given), handedOver: Boolean(v.handedOver), markerId: v.markerId ?? null })),
        tasksActive: Object.entries(q.tasks ?? {}).filter(([, t]) => t?.t).map(([k]) => k),
      })),
      partyQuests: partyQuests.map((pq) => ({ uid: pq.uid, title: pq.title, progress: pq.progress, goal: pq.goal, layoutId: pq.layoutId, status: pq.status })),
      globals: { ...(p.rpg?.quests?.globals ?? {}) },
      repairIssues: repairScan.filter((f) => f.needsRepair),
    };
  }

  function awardRenown(p, points, source = 'activity') {
    const delta = Math.max(0, Math.trunc(Number(points) || 0));
    if (!delta) return renownTierOf(ensurePlayerRulesState(p).endgame.renown);
    const { endgame } = ensurePlayerRulesState(p);
    ctx.dirty(p);
    endgame.renown = (Number(endgame.renown) || 0) + delta;
    endgame.renownLog = [{ points: delta, source, at: Math.trunc(ctx.now?.() ?? Date.now()) }, ...(endgame.renownLog ?? [])].slice(0, 20);
    return renownTierOf(endgame.renown);
  }

  function rulesSnapshot(p) {
    const out = {};
    for (const [k, spec] of worldRules) {
      out[k] = { value: getRule(k, p), scope: spec.scope, label: spec.label };
    }
    return out;
  }

  ctx.onJoin?.((p) => {
    ensurePlayerRulesState(p);
  });

  ctx.onAction?.('rules.status', (p) => {
    ctx.notify(p, {
      kind: 'optionalRules',
      rules: rulesSnapshot(p),
      climbing: climbingParams(p, getRule('advancedClimbing', p)),
      silent: true,
    });
  });

  ctx.onAction?.('rules.set', (p, args) => {
    const res = setRule(String(args?.rule ?? ''), args?.value, { player: p });
    ctx.notify(p, {
      kind: 'optionalRules',
      rules: rulesSnapshot(p),
      changed: res,
      text: `${res.rule} (${res.scope}) set to ${res.value ? 'ON' : 'OFF'}.`,
    });
  });

  ctx.onAction?.('rules.repairItem', (p, args) => {
    const res = repairItem(p, args?.itemId);
    ctx.notify(p, {
      kind: 'itemRepaired',
      ...res,
      text: res.instant
        ? `Instantly repaired ${res.name} for ${res.cost} gold.`
        : `Submitted ${res.name} for repair (${res.cost} gold).`,
    });
  });

  ctx.onAction?.('rules.questDebug', (p, args) => {
    const report = questDebug(p, { uid: args?.uid ?? null, includeRepairScan: args?.includeRepairScan !== false });
    ctx.notify(p, { kind: 'questDebug', report, silent: true });
  });

  ctx.onAction?.('endgame.status', (p) => {
    const { endgame } = ensurePlayerRulesState(p);
    const tier = renownTierOf(endgame.renown);
    const activeBuild = evaluateEndgameBuild(p.rpg?.character, {
      renownPoints: endgame.renown,
      firmamentId: endgame.firmamentId,
      specId: endgame.specId,
      setId: endgame.setId,
      setPieces: endgame.setPieces,
    });
    ctx.notify(p, {
      kind: 'endgame',
      endgame: { ...endgame, tier },
      activeBuild,
      catalogs: { firmaments: FIRMAMENT_SIGNS, specializations: SPECIALIZATIONS, sets: EQUIPMENT_SETS },
      silent: true,
    });
  });

  ctx.onAction?.('endgame.selectFirmament', (p, args) => {
    const sign = SIGN_BY_ID.get(String(args?.signId ?? ''));
    if (!sign) throw new Error('Unknown Firmament sign.');
    const { endgame } = ensurePlayerRulesState(p);
    ctx.dirty(p);
    endgame.firmamentId = sign.id;
    ctx.notify(p, { kind: 'endgame', endgame: { ...endgame, tier: renownTierOf(endgame.renown) }, text: `Aligned Firmament to ${sign.name}.` });
  });

  ctx.onAction?.('endgame.selectSpec', (p, args) => {
    const spec = SPEC_BY_ID.get(String(args?.specId ?? ''));
    if (!spec) throw new Error('Unknown specialization.');
    const { endgame } = ensurePlayerRulesState(p);
    ctx.dirty(p);
    endgame.specId = spec.id;
    ctx.notify(p, { kind: 'endgame', endgame: { ...endgame, tier: renownTierOf(endgame.renown) }, text: `Selected specialization: ${spec.name}.` });
  });

  ctx.onAction?.('endgame.compareBuilds', (p, args) => {
    const comparison = compareBuilds(p.rpg?.character, args?.buildA ?? {}, args?.buildB ?? {});
    ctx.notify(p, { kind: 'buildComparison', comparison, silent: true });
  });

  ctx.onAction?.('wardrobe.status', (p) => {
    const { wardrobe } = ensurePlayerRulesState(p);
    ctx.notify(p, { kind: 'wardrobe', wardrobe: structuredClone(wardrobe), catalog: COSMETIC_CATALOG, silent: true });
  });

  ctx.onAction?.('wardrobe.unlock', (p, args) => {
    const cos = COSMETIC_BY_ID.get(String(args?.cosmeticId ?? ''));
    if (!cos) throw new Error('Unknown cosmetic item.');
    const { wardrobe } = ensurePlayerRulesState(p);
    ctx.dirty(p);
    if (!wardrobe.unlocked.includes(cos.id)) wardrobe.unlocked.push(cos.id);
    ctx.notify(p, { kind: 'wardrobe', wardrobe: structuredClone(wardrobe), catalog: COSMETIC_CATALOG, text: `Unlocked cosmetic: ${cos.name}.` });
  });

  ctx.onAction?.('wardrobe.equip', (p, args) => {
    const cos = COSMETIC_BY_ID.get(String(args?.cosmeticId ?? ''));
    if (!cos) throw new Error('Unknown cosmetic item.');
    const { wardrobe } = ensurePlayerRulesState(p);
    if (!wardrobe.unlocked.includes(cos.id)) throw new Error(`Unlock "${cos.name}" before equipping it.`);
    ctx.dirty(p);
    wardrobe.equipped[cos.slot] = cos.id;
    ctx.notify(p, { kind: 'wardrobe', wardrobe: structuredClone(wardrobe), catalog: COSMETIC_CATALOG, text: `Equipped cosmetic ${cos.name} (${cos.slot}).` });
  });

  ctx.onAction?.('succession.status', (p) => {
    const { succession } = ensurePlayerRulesState(p);
    ctx.notify(p, { kind: 'succession', succession: structuredClone(succession), silent: true });
  });

  ctx.onAction?.('succession.designate', (p, args) => {
    const { succession } = ensurePlayerRulesState(p);
    ctx.dirty(p);
    if (typeof args?.lineageName === 'string' && args.lineageName.trim()) {
      succession.lineageName = args.lineageName.trim().slice(0, 64);
    }
    if (typeof args?.heirName === 'string' && args.heirName.trim()) {
      succession.heirName = args.heirName.trim().slice(0, 48);
    }
    if (Number.isSafeInteger(Number(args?.heirCharacterId))) {
      succession.heirCharacterId = Number(args.heirCharacterId);
    }
    ctx.notify(p, {
      kind: 'succession',
      succession: structuredClone(succession),
      text: `Updated family succession (${succession.lineageName}; heir: ${succession.heirName ?? 'Unassigned'}).`,
    });
  });

  ctx.onAction?.('succession.tagHeirloom', (p, args) => {
    const itemId = String(args?.itemId ?? '');
    const inv = Array.isArray(p.rpg?.inventory) ? p.rpg.inventory : [];
    const item = inv.find((it) => it && it.id === itemId);
    if (!item) throw new Error('Choose an item in your inventory to tag as an heirloom.');
    const { succession } = ensurePlayerRulesState(p);
    ctx.dirty(p);
    item.heirloom = true;
    if (!succession.heirloomItemIds.includes(itemId)) succession.heirloomItemIds.push(itemId);
    ctx.notify(p, {
      kind: 'succession',
      succession: structuredClone(succession),
      text: `Tagged ${item.name || item.template} as a family heirloom.`,
    });
  });

  ctx.onAction?.('expansion.list', (p) => {
    const { endgame } = ensurePlayerRulesState(p);
    const tier = renownTierOf(endgame.renown);
    const list = [...expansions.values()].map((e) => ({
      ...e,
      eligible: tier.rank >= (e.requiredRenownRank ?? 0),
    }));
    ctx.notify(p, { kind: 'expansions', provinces: list, renownRank: tier.rank, silent: true });
  });

  services.optionalRules = {
    getRule,
    setRule,
    rulesSnapshot,
    resolveEnemyInfighting: (a, b) => resolveEnemyInfighting(a, b, getRule('enemyInfighting')),
    evaluateEnhancedAI: (m, c) => evaluateEnhancedAI(m, c, getRule('enhancedEnemyAI')),
    climbingParams: (p) => climbingParams(p, getRule('advancedClimbing', p)),
    repairItem,
    questDebug,
    awardRenown,
    compareBuilds,
    evaluateEndgameBuild,
    registerExpansion(spec) {
      if (!spec || typeof spec.id !== 'string' || !spec.province) throw new Error('Expansion requires id and province.');
      expansions.set(spec.id, { ...spec });
      return expansions.get(spec.id);
    },
    listExpansions: () => [...expansions.values()],
  };
}
