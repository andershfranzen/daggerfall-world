// Spell formulas adapted from Daggerfall Unity FormulaHelper / BaseEntityEffect
// (MIT License, Copyright (c) 2009-2023 Daggerfall Workshop):
// CalculateEffectCosts, ApplyTargetCostMultiplier, CalculateTotalEffectCosts (5 point floor),
// GetMagnitude, SetDuration, ChanceValue, SavingThrow and MagicResist.

export const CAST_COST_FLOOR = 5;
const TARGET_COST_MULTIPLIER = { caster: 1, touch: 1, singleAtRange: 1.5, areaAroundCaster: 2, areaAtRange: 2.5 };
// Zero-component effects (e.g. Teleport) get a fudge cost in DFU to match classic casting cost.
const FUDGE_COSTS = { a: 60, b: 100, offset: 160 };

const trunc = Math.trunc;

function componentCost(costs, starting, increase, perLevel) {
  return trunc(costs.offset + costs.a * starting + costs.b * trunc(increase / Math.max(1, perLevel)));
}

/** Gold cost of one effect entry with spellmaker settings (independent of caster skill). */
export function effectGoldCost(template, s) {
  let gold = 0;
  let active = false;
  if (template.duration && template.durationCosts) {
    active = true;
    gold += componentCost(template.durationCosts, s.durationBase, s.durationPlus, s.durationPerLevel);
  }
  if (template.chance && template.chanceCosts) {
    active = true;
    gold += componentCost(template.chanceCosts, s.chanceBase, s.chancePlus, s.chancePerLevel);
  }
  if (template.magnitude && template.magnitudeCosts) {
    active = true;
    const base = trunc((s.magnitudeBaseMax + s.magnitudeBaseMin) / 2);
    const plus = trunc((s.magnitudePlusMax + s.magnitudePlusMin) / 2);
    gold += componentCost(template.magnitudeCosts, base, plus, s.magnitudePerLevel);
  }
  if (!active) gold += componentCost(FUDGE_COSTS, 1, 1, 1);
  return gold;
}

/**
 * Spell costs for a caster. `skillOf(school)` returns the caster's live skill value.
 * Returns { gold, magicka }.
 */
export function spellCosts(spell, skillOf = () => 0) {
  let gold = 0;
  let magicka = 0;
  for (const e of spell.effects) {
    const g = effectGoldCost(e.template, e.settings);
    const skill = Math.max(0, Math.min(100, skillOf(e.template.school) | 0));
    gold += g;
    magicka += trunc((g * (110 - skill)) / 400);
  }
  const mult = TARGET_COST_MULTIPLIER[spell.targetType] ?? 1;
  gold = trunc(gold * mult);
  magicka = trunc(magicka * mult);
  return { gold, magicka: Math.max(CAST_COST_FLOOR, magicka) };
}

const randInt = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/** Raw magnitude roll before saving throws. */
export function rollMagnitude(s, casterLevel, rng = Math.random) {
  const base = randInt(rng, s.magnitudeBaseMin, Math.max(s.magnitudeBaseMin, s.magnitudeBaseMax));
  const plus = randInt(rng, s.magnitudePlusMin, Math.max(s.magnitudePlusMin, s.magnitudePlusMax));
  return base + plus * Math.floor(casterLevel / Math.max(1, s.magnitudePerLevel));
}

/** Duration in magic rounds. */
export function durationRounds(s, casterLevel) {
  const mult = Math.max(1, Math.floor(casterLevel / Math.max(1, s.durationPerLevel)));
  return s.durationBase + s.durationPlus * mult;
}

/** Chance of an effect succeeding, percent. */
export function chanceValue(s, casterLevel) {
  return s.chanceBase + s.chancePlus * Math.floor(casterLevel / Math.max(1, s.chancePerLevel));
}

export const magicResist = (willpower) => Math.floor((willpower | 0) / 10);

// Tolerance adjustments (DFU mixes flags rather than classic's absolute immune/critical).
const TOLERANCE = { immune: 50, resistant: 25, low: -25, critical: -50 };

/**
 * Saving throw. Returns percent (0-100) of damage/duration the target suffers.
 * `target` = { willpower, tolerance: (element|'paralysis') => 'immune'|'resistant'|'low'|'critical'|undefined,
 *              resistChance: element => percent from active resistance effects }
 */
export function savingThrow({ element, paralysis = false, target, modifier = 0, rng = Math.random }) {
  const kinds = paralysis ? [element, 'paralysis'] : [element];
  if (kinds.some((kind) => target.immune?.(kind))) return 0;
  const resist = target.resistChance?.(element) ?? 0;
  if (resist > 0 && rng() * 100 < resist) return 0;
  let save = 50;
  for (const kind of kinds) {
    const t = target.tolerance?.(kind);
    if (t && TOLERANCE[t] !== undefined) save += TOLERANCE[t];
    save += target.modifier?.(kind) ?? 0;
  }
  save += modifier;
  if (save >= 100) return 0;
  save += magicResist(target.willpower ?? 50);
  save = Math.min(95, Math.max(5, save));
  const roll = 1 + Math.floor(rng() * 100);
  let pct = 100;
  if (roll <= save) pct = save - 20 <= roll ? 100 - 5 * (save - roll) : 0;
  return Math.min(100, Math.max(0, pct));
}

// ---- classic casting cost (FormulaHelper.CalculateCastingCost(SpellRecordData, enchantingItem) "reversed from
// classic") -------------------------------------------------------------------------------------------------------
// Tables copied from DFU: effectIndices (12 slots per classic effect type), effectCoefficients (4 per index),
// effectMagicSchools / settingsTypes (per classic effect type) and rangeTypeModifiers.
const CLASSIC_EFFECT_INDICES = [
  [0], [1, 2, 3], [4], [5, 5, 6], [7, 7, 7], [8], [9, 8, 9], [10, 10, 10, 10, 10, 10, 10, 10], [11, 11, 11, 11, 11],
  [12, 12, 12, 12, 12, 12, 12, 12], [13, 13, 13, 13, 13, 13, 13, 13, 7, 14], [15, 15, 15, 15, 15, 15, 15, 15, 15, 15],
  [0x26], [16, 17], [18], [19], [20], [0x28], [21], [22], [23], [23], [22], [24, 16], [24, 16], [20], [2], [2], [25],
  [26, 26, 26, 26, 26, 26, 26], [2], [2], [27], [26, 28, 28, 29], [30], [31], [0x27], [32], [32], [33, 33, 34], [35],
  [36], [7], [37], [0x29], [0x2A], [0x2A], [0x2A], [0x2A], [0x2A], [0x2A],
];
const CLASSIC_EFFECT_COEFFICIENTS = [
  [7, 25, 7, 25], [7, 2, 10, 7], [5, 2, 10, 7], [10, 2, 10, 7], [15, 30, 0, 0], [2, 25, 0, 0], [5, 35, 0, 0], [5, 7, 0, 0],
  [20, 35, 0, 0], [30, 45, 0, 0], [4, 25, 2, 25], [25, 25, 2, 25], [7, 25, 10, 30], [10, 7, 0, 0], [2, 7, 0, 0],
  [5, 5, 15, 25], [10, 30, 0, 0], [15, 35, 0, 0], [15, 25, 0, 0], [2, 10, 0, 0], [5, 25, 7, 30], [25, 5, 2, 2],
  [5, 25, 5, 25], [7, 35, 7, 35], [5, 20, 0, 0], [5, 5, 0, 0], [15, 25, 15, 25], [10, 20, 20, 40], [10, 5, 20, 35],
  [7, 2, 15, 30], [5, 2, 10, 15], [7, 2, 20, 15], [35, 2, 10, 25], [5, 2, 20, 30], [5, 2, 15, 25], [5, 2, 10, 25],
  [7, 12, 5, 5], [35, 45, 0, 0], [15, 17, 10, 17], [20, 17, 25, 35], [5, 25, 0, 0], [15, 17, 10, 17], [15, 15, 5, 5],
];
const CLASSIC_EFFECT_SCHOOLS = [0, 2, 3, 1, 2, 2, 3, 2, 0, 1, 1, 2, 3, 5, 4, 5, 3, 3, 1, 3, 1, 4, 4, 5, 5, 0, 1, 0, 0, 5,
  0, 4, 0, 4, 4, 0, 3, 3, 0, 4, 4, 4, 5, 3, 3, 0, 0, 4, 4, 4, 4];
const CLASSIC_SETTINGS_TYPES = [1, 2, 3, 4, 5, 4, 4, 2, 1, 6, 5, 6, 1, 3, 3, 3, 1, 4, 2, 1, 1, 1, 1, 3, 3, 3, 3, 3, 3, 1,
  3, 3, 1, 1, 1, 2, 2, 1, 1, 1, 1, 1, 3, 4, 1, 2, 2, 2, 2, 2, 2];
const CLASSIC_RANGE_MODIFIERS = [2, 2, 3, 4, 5];
/** DFU magicSkills, indexed by CLASSIC_EFFECT_SCHOOLS. */
export const CLASSIC_MAGIC_SCHOOLS = Object.freeze(['Alteration', 'Restoration', 'Destruction', 'Mysticism', 'Thaumaturgy', 'Illusion']);

/** FormulaHelper.getCostFromSettings: C# integer arithmetic, left to right. */
function classicSettingsCost(type, e, c) {
  const div = (a, b) => (b ? trunc(a / b) : 0); // a zero per-level divisor would throw in DFU; no classic record has one
  const avgBase = div(e.magnitudeBaseHigh + e.magnitudeBaseLow, 2);
  const avgLevel = div(e.magnitudeLevelBase + e.magnitudeLevelHigh, 2);
  switch (type) {
    case 1: return c[0] * e.durationBase + div(e.durationMod, e.durationPerLevel) * c[1] + c[2] * e.chanceBase + div(e.chanceMod, e.chancePerLevel) * c[3];
    case 2: return c[0] * e.durationBase + div(e.durationMod, e.durationPerLevel) * c[1] + avgBase * c[2] + div(avgLevel, e.magnitudePerLevel) * c[3];
    case 3: return c[0] * e.durationBase + div(e.durationMod, e.durationPerLevel) * c[1];
    case 4: return c[0] * e.chanceBase + div(e.chanceMod, e.chancePerLevel) * c[1];
    case 5: return c[0] * avgBase + div(avgLevel, e.magnitudePerLevel) * c[1];
    case 6: return c[0] * e.durationBase + div(c[1] * e.durationMod, e.durationPerLevel) + avgBase * c[2] + div(c[3], e.magnitudePerLevel) * avgLevel;
    default: return 0;
  }
}

/**
 * FormulaHelper.CalculateCastingCost for a raw SPELLS.STD record ({rangeType, effects:[{type, subType, durationBase,
 * durationMod, durationPerLevel, chanceBase, chanceMod, chancePerLevel, magnitudeBaseLow, magnitudeBaseHigh,
 * magnitudeLevelBase, magnitudeLevelHigh, magnitudePerLevel}]}). `skillOf(schoolName)` gives the caster's live skill;
 * omit it for the Item Maker's fixed 50 (enchantingItem = true).
 */
export function classicCastingCost(record, skillOf = null) {
  let cost = 0;
  for (const e of (record?.effects ?? []).slice(0, 3)) {
    if (!e || !(e.type >= 0) || e.type >= CLASSIC_SETTINGS_TYPES.length) continue;
    const slots = CLASSIC_EFFECT_INDICES[e.type];
    const index = e.subType === -1 || e.subType == null ? slots[0] : slots[e.subType] ?? 0;
    const coefficients = CLASSIC_EFFECT_COEFFICIENTS[index] ?? [0, 0, 0, 0];
    const skill = skillOf ? Math.trunc(Number(skillOf(CLASSIC_MAGIC_SCHOOLS[CLASSIC_EFFECT_SCHOOLS[e.type]])) || 0) : 50;
    cost += trunc(classicSettingsCost(CLASSIC_SETTINGS_TYPES[e.type], e, coefficients) * (110 - skill) / 100);
  }
  cost = (cost * (CLASSIC_RANGE_MODIFIERS[record?.rangeType] ?? 2)) >> 1;
  return Math.max(5, cost);
}
