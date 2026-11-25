// Classic health-condition tables: diseases, poisons, monster carriers, vampire clans, moons.
//
// Numbers adapted from Daggerfall Unity (MIT License, Copyright (c) Daggerfall Workshop):
//   MagicAndEffects/Effects/Diseases/DiseaseEffect.cs   GetClassicDiseaseData (classic disease table)
//   MagicAndEffects/Effects/Poisons/PoisonEffect.cs     poison delays, durations and per-minute effects
//   Formulas/FormulaHelper.cs                           OnMonsterHit carriers, specialInfectionChance, GetVampireClan
//   MagicAndEffects/Effects/Special/VampirismEffect.cs, LycanthropyEffect.cs, PassiveSpecialsEffect.cs
//   Utility/DaggerfallDateTime.cs                       GetLunarPhase
// https://github.com/Interkarma/daggerfall-unity (commit 3d85a28). Text shown to players comes from the
// operator's own TEXT.RSC where classic has a record; nothing from the game archives is copied here.

export const ATTRIBUTES = Object.freeze(['Strength', 'Intelligence', 'Willpower', 'Agility', 'Endurance', 'Personality', 'Speed', 'Luck']);

/** DiseaseData days value meaning "lasts until cured". */
export const PERMANENT = 0xff;

// Diseases enum order. Columns: STR INT WIL AGI END PER SPD LUC HEA FAT SPL minDamage maxDamage minDays maxDays.
const DISEASE_ROWS = [
  ['WitchesPox', "Witches' Pox", 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 2, 10, PERMANENT, PERMANENT],
  ['Plague', 'Plague', 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 30, PERMANENT, PERMANENT],
  ['YellowFever', 'Yellow Fever', 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 5, 10, PERMANENT, PERMANENT],
  ['StomachRot', 'Stomach Rot', 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 5, PERMANENT, PERMANENT],
  ['Consumption', 'Consumption', 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 2, 10, PERMANENT, PERMANENT],
  ['BrainFever', 'Brain Fever', 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 5, PERMANENT, PERMANENT],
  ['SwampRot', 'Swamp Rot', 1, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 2, 10, PERMANENT, PERMANENT],
  ['CalironsCurse', "Caliron's Curse", 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 5, 10, 3, 18],
  ['Cholera', 'Cholera', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 5, 30, PERMANENT, PERMANENT],
  ['Leprosy', 'Leprosy', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 5, 30, PERMANENT, PERMANENT],
  ['WoundRot', 'Wound Rot', 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 2, 4, PERMANENT, PERMANENT],
  ['RedDeath', 'Red Death', 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 2, 10, PERMANENT, PERMANENT],
  ['BloodRot', 'Blood Rot', 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 5, 10, 3, 18],
  ['TyphoidFever', 'Typhoid Fever', 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 2, 10, PERMANENT, PERMANENT],
  ['Dementia', 'Dementia', 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 2, 10, PERMANENT, PERMANENT],
  ['Chrondiasis', 'Chrondiasis', 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 5, 10, PERMANENT, PERMANENT],
  ['WizardFever', 'Wizard Fever', 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 4, 3, 18],
];

export const DISEASES = Object.freeze(DISEASE_ROWS.map(([id, name, ...n], index) => Object.freeze({
  index,
  key: `Disease-${id}`,
  name,
  /** TEXT.RSC record describing the disease once incubation is over (DiseaseEffect: 100 + type). */
  textId: 100 + index,
  stats: Object.freeze(Object.fromEntries(ATTRIBUTES.map((a, i) => [a, n[i]]))),
  health: n[8], fatigue: n[9], magicka: n[10],
  minDamage: n[11], maxDamage: n[12], minDays: n[13], maxDays: n[14],
  permanent: n[13] === PERMANENT,
})));

export function diseaseOf(v) {
  if (Number.isInteger(v)) return DISEASES[v] ?? null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/^Disease-/i, '').replace(/[^a-z]/gi, '').toLowerCase();
  return DISEASES.find((d) => d.key.slice(8).toLowerCase() === s || d.name.replace(/[^a-z]/gi, '').toLowerCase() === s) ?? null;
}

// Poisons enum (128..139). Delay and duration are in game minutes (one magic round each).
const POISON_ROWS = [
  ['Nux_Vomica', 'Nux Vomica', 4, 4, 3, 10],
  ['Arsenic', 'Arsenic', 10, 10, 20, 1000],
  ['Moonseed', 'Moonseed', 0, 0, 1, 4],
  ['Drothweed', 'Drothweed', 5, 10, 5, 30],
  ['Somnalius', 'Somnalius', 0, 0, 2, 10],
  ['Pyrrhic_Acid', 'Pyrrhic Acid', 0, 0, 1, 2],
  ['Magebane', 'Magebane', 2, 2, 5, 20],
  ['Thyrwort', 'Thyrwort', 0, 0, 1, 3],
  ['Indulcet', 'Indulcet', 2, 12, 2, 6],
  ['Sursum', 'Sursum', 1, 4, 2, 2],
  ['Quaesto_Vil', 'Quaesto Vil', 2, 12, 1, 4],
  ['Aegrotat', 'Aegrotat', 0, 0, 5, 20],
];
export const POISON_START = 128;
export const POISONS = Object.freeze(POISON_ROWS.map(([id, name, minStart, maxStart, minRounds, maxRounds], index) => Object.freeze({
  index, classic: POISON_START + index, key: `Poison-${id}`, name, minStart, maxStart, minRounds, maxRounds,
  drug: index >= 8,
})));

export function poisonOf(v) {
  if (Number.isInteger(v)) return POISONS[v >= POISON_START ? v - POISON_START : v] ?? null;
  if (typeof v !== 'string') return null;
  const s = v.replace(/^Poison-/i, '').replace(/[^a-z]/gi, '').toLowerCase();
  return POISONS.find((p) => p.key.slice(7).replace(/_/g, '').toLowerCase() === s) ?? null;
}

/**
 * One minute of an active poison (PoisonEffect.IncrementPoisonEffects). `roll(min,max)` mirrors
 * UnityEngine.Random.Range(int,int): max exclusive. Returns {stats, health, fatigue, magicka}; stats are signed.
 */
export function poisonMinute(index, roll) {
  const o = { stats: {}, health: 0, fatigue: 0, magicka: 0 };
  const st = (a, n) => { o.stats[a] = (o.stats[a] ?? 0) + n; };
  switch (index) {
    case 0: o.health = roll(2, 12); break;
    case 1: o.health = 2; st('Endurance', -1); break;
    case 2: o.health = roll(1, 10); break;
    case 3: st('Strength', -roll(5, 10)); st('Agility', -roll(1, 5)); st('Speed', -roll(1, 5)); break;
    case 4: o.fatigue = roll(10, 100); break;
    case 5: o.health = roll(1, 30); break;
    case 6: st('Willpower', -roll(1, 5)); o.magicka = roll(5, 15); break;
    case 7: st('Willpower', -roll(5, 20)); st('Personality', -roll(10, 20)); break;
    case 8: o.fatigue = roll(10, 100); st('Luck', roll(4, 10)); break;
    case 9: st('Intelligence', -roll(10, 30)); st('Strength', roll(5, 20)); break;
    case 10: st('Willpower', -roll(1, 4)); o.fatigue = -roll(5, 10); break;
    case 11: st('Endurance', -roll(1, 5)); o.magicka = -roll(5, 10); break;
  }
  return o;
}

// FormulaHelper.OnMonsterHit disease lists.
const D = Object.fromEntries(DISEASES.map((d) => [d.key.slice(8), d.index]));
export const DISEASE_LIST_A = Object.freeze([D.Plague]);
export const DISEASE_LIST_B = Object.freeze([D.Plague, D.StomachRot, D.BrainFever]);
export const DISEASE_LIST_C = Object.freeze([D.Plague, D.YellowFever, D.StomachRot, D.Consumption, D.BrainFever, D.SwampRot,
  D.Cholera, D.Leprosy, D.RedDeath, D.TyphoidFever, D.Dementia]);

/** FormulaHelper.specialInfectionChance, percent. */
export const SPECIAL_INFECTION_CHANCE = 0.6;

/**
 * Melee carriers by MobileTypes id. `chance` is a percent rolled once per landed hit; `special`
 * is a supernatural infection that bypasses saving throws (AssignBundleFlags.SpecialInfection).
 */
export const CARRIERS = Object.freeze({
  0: { name: 'Rat', disease: { chance: 5, list: DISEASE_LIST_B } }, // DF Chronicles list (DFU note)
  3: { name: 'Giant Bat', disease: { chance: 2, list: DISEASE_LIST_B } },
  9: { name: 'Werewolf', special: 'werewolf' },
  14: { name: 'Wereboar', special: 'wereboar' },
  17: { name: 'Zombie', disease: { chance: 2, list: DISEASE_LIST_C } },
  19: { name: 'Mummy', disease: { chance: 5, list: DISEASE_LIST_C } },
  28: { name: 'Vampire', special: 'vampirism', disease: { chance: 2, list: DISEASE_LIST_A } },
  30: { name: 'Vampire Ancient', special: 'vampirism', disease: { chance: 2, list: DISEASE_LIST_A } },
});

// Vampire clans: FACTION.TXT faction ids (FactionFile.FactionIDs.The_*).
export const CLANS = Object.freeze({
  150: 'Vraseth', 151: 'Haarvenu', 152: 'Thrafey', 153: 'Lyrezi', 154: 'Montalion',
  155: 'Khulari', 156: 'Garlythi', 157: 'Anthotis', 158: 'Selenu',
});
export const DEFAULT_CLAN = 153; // "The Lyrezi are the default like in classic"
export const clanName = (id) => CLANS[id] ?? CLANS[DEFAULT_CLAN];

// PlayerEntity.AssignPlayerVampireSpells: common spells, then each clan's SPELLS.STD records.
const CLAN_SPELLS = {
  150: [85], 151: [20, 33], 152: [64], 153: [23, 6], 154: [94],
  155: [50], 156: [17], 157: [], 158: [11, 12, 13],
};
export const vampireSpellIndices = (clan) => [4, 90, 91, ...(CLAN_SPELLS[clan] ?? CLAN_SPELLS[DEFAULT_CLAN])];

/** VampirismEffect.SetStatMods / LycanthropyEffect.SetStatMods (beast form only). */
export const VAMPIRE_STATS = Object.freeze(['Strength', 'Willpower', 'Agility', 'Endurance', 'Personality', 'Speed', 'Luck']);
export const VAMPIRE_STAT_BONUS = 20;
export const VAMPIRE_SKILLS = Object.freeze(['Jumping', 'Running', 'Stealth', 'Critical Strike', 'Climbing', 'Hand-to-Hand']);
export const BEAST_STATS = Object.freeze(['Strength', 'Agility', 'Endurance', 'Speed']);
export const BEAST_STAT_BONUS = 40;
export const BEAST_SKILLS = Object.freeze(['Swimming', 'Running', 'Stealth', 'Critical Strike', 'Climbing', 'Hand-to-Hand', 'Jumping']);
export const SUPERNATURAL_SKILL_BONUS = 30;

/** PassiveSpecialsEffect: 12 health every 4 game minutes in sunlight. */
export const SUN_DAMAGE = 12;
export const SUN_DAMAGE_MINUTES = 4;
/** VampirismEffect.IsSatiated: fed within one day. */
export const VAMPIRE_SATED_MINUTES = 1440;
/** LycanthropyEffect: urge to kill after 30 days; then max health shrinks by 24 a day, never below 4. */
export const NEED_TO_KILL_MINUTES = 1440 * 30;
export const NEED_TO_KILL_LOSS_PER_DAY = 24;
export const NEED_TO_KILL_MIN_HEALTH = 4;
/** LycanthropyEffect.CanCastMorphSelf: once a day. */
export const MORPH_COOLDOWN_MINUTES = 1440;
/** Infection → dream after the first day, full curse after more than three (VampirismInfection, LycanthropyInfection). */
export const INFECTION_DREAM_DAYS = 1;
export const INFECTION_DEPLOY_DAYS = 4;

/** TEXT.RSC records used here. */
export const TEXT = Object.freeze({ healthy: 18, notSated: 36, deathIsNotEternal: 401 });

// Moons are shared with the browser.
export { lunarPhase, moonsOf, isFullMoon, PHASE_LABEL } from '../../../client/gameplay/conditions/rules.js';
