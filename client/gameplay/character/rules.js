// Character rules shared by the authoritative server (server/rpg/character.js) and the browser wizard.
// Pure ES module: no DOM, no Node APIs. Server-side calls are authoritative; the browser uses the same
// functions only to preview and pre-validate what it will ask the server to do.
//
// The formulas below are adapted from Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop) and its
// JavaScript translation in daggerfall-js-source / dfjs (MIT, (c) 2026 Lattymoy). See NOTICE.txt in this
// directory. Sources consulted:
//   FormulaHelper.cs   SpellPoints, HitPointsModifier, CalculateSkillUsesForAdvancement,
//                      CalculatePlayerLevel, CalculateHitPointsPerLevelUp, BonusPool, MaxStatValue
//   StatsRollout.cs    career base + Range(0..10) per attribute, bonus pool Range(6..14); free edit 10..75
//   SkillsRollout.cs   default 3..6, primary 28+0..3, major 18+0..3, minor 13+0..3, +6 per group
//   DaggerfallSkills.cs GetPrimaryStat, GetAdvancementMultiplier
//   PlayerEntity.cs    TallySkill, RaiseSkills, SetCurrentLevelUpSkillSum, reflexes modifier
//   CreateCharCustomClass.cs / CreateCharSpecialAdvantageWindow.cs  custom class HP, difficulty and
//                      advancement multiplier, advantage/disadvantage costs
//   API/ClassFile.cs   CLASS*.CFG record layout (see cfg.js)
// No Bethesda text, art or data tables are reproduced here. Class descriptions are original.

export const ATTRIBUTES = Object.freeze([
  'Strength', 'Intelligence', 'Willpower', 'Agility', 'Endurance', 'Personality', 'Speed', 'Luck',
]);
export const ATTRIBUTE_ABBR = Object.freeze({
  Strength: 'STR', Intelligence: 'INT', Willpower: 'WIL', Agility: 'AGI',
  Endurance: 'END', Personality: 'PER', Speed: 'SPD', Luck: 'LUC',
});

// DFCareer.Skills order (the index is what CLASS*.CFG stores).
export const SKILLS = Object.freeze([
  'Medical', 'Etiquette', 'Streetwise', 'Jumping', 'Orcish', 'Harpy', 'Giantish', 'Dragonish', 'Nymph',
  'Daedric', 'Spriggan', 'Centaurian', 'Impish', 'Lockpicking', 'Mercantile', 'Pickpocket', 'Stealth',
  'Swimming', 'Climbing', 'Backstabbing', 'Dodging', 'Running', 'Destruction', 'Restoration', 'Illusion',
  'Alteration', 'Thaumaturgy', 'Mysticism', 'Short Blade', 'Long Blade', 'Hand-to-Hand', 'Axe',
  'Blunt Weapon', 'Archery', 'Critical Strike',
]);
export const SKILL_INDEX = Object.freeze(Object.fromEntries(SKILLS.map((s, i) => [s, i])));

// DaggerfallSkills.GetPrimaryStat
const S = (names, stat) => names.map((n) => [n, stat]);
export const SKILL_ATTRIBUTE = Object.freeze(Object.fromEntries([
  ...S(['Medical', 'Orcish', 'Harpy', 'Giantish', 'Dragonish', 'Nymph', 'Daedric', 'Spriggan', 'Centaurian',
    'Impish', 'Lockpicking'], 'Intelligence'),
  ...S(['Etiquette', 'Streetwise', 'Mercantile'], 'Personality'),
  ...S(['Jumping', 'Climbing', 'Axe', 'Blunt Weapon'], 'Strength'),
  ...S(['Pickpocket', 'Stealth', 'Backstabbing', 'Short Blade', 'Long Blade', 'Hand-to-Hand', 'Archery',
    'Critical Strike'], 'Agility'),
  ...S(['Swimming'], 'Endurance'),
  ...S(['Dodging', 'Running'], 'Speed'),
  ...S(['Destruction', 'Restoration', 'Illusion', 'Alteration', 'Thaumaturgy', 'Mysticism'], 'Willpower'),
]));

// DaggerfallSkills.GetAdvancementMultiplier
export const SKILL_ADVANCEMENT = Object.freeze({
  Medical: 12, Etiquette: 1, Streetwise: 1, Jumping: 5,
  Orcish: 15, Harpy: 15, Giantish: 15, Dragonish: 15, Nymph: 15, Daedric: 15, Spriggan: 15, Centaurian: 15, Impish: 15,
  Lockpicking: 2, Mercantile: 1, Pickpocket: 2, Stealth: 2, Swimming: 1, Climbing: 2, Backstabbing: 1,
  Dodging: 4, Running: 50, Destruction: 1, Restoration: 2, Illusion: 1, Alteration: 1, Thaumaturgy: 2,
  Mysticism: 1, 'Short Blade': 2, 'Long Blade': 2, 'Hand-to-Hand': 2, Axe: 2, 'Blunt Weapon': 2,
  Archery: 1, 'Critical Strike': 8,
});

export const SKILL_CATEGORIES = Object.freeze({
  Languages: ['Orcish', 'Harpy', 'Giantish', 'Dragonish', 'Nymph', 'Daedric', 'Spriggan', 'Centaurian', 'Impish', 'Etiquette', 'Streetwise'],
  Magic: ['Destruction', 'Restoration', 'Illusion', 'Alteration', 'Thaumaturgy', 'Mysticism'],
  Combat: ['Short Blade', 'Long Blade', 'Hand-to-Hand', 'Axe', 'Blunt Weapon', 'Archery', 'Critical Strike', 'Backstabbing', 'Dodging'],
  Stealth: ['Lockpicking', 'Pickpocket', 'Stealth', 'Mercantile'],
  Body: ['Medical', 'Jumping', 'Swimming', 'Climbing', 'Running'],
});
export const MAGIC_SKILLS = Object.freeze([...SKILL_CATEGORIES.Magic]);

// ------------------------------------------------------------------ constants (verbatim values)

export const MAX_STAT = 100; // FormulaHelper.MaxStatValue
export const MAX_SKILL = 100;
export const MASTERED_SKILL_CAP = 95;
export const STAT_BONUS_ROLL = [0, 10];
export const STAT_BONUS_POOL = [6, 14];
export const LEVEL_BONUS_POOL = [4, 6];
export const SKILL_DEFAULT = [3, 6];
export const SKILL_GROUP_MIN = Object.freeze({ primary: 28, major: 18, minor: 13 });
export const SKILL_GROUP_ROLL = 3;
export const SKILL_GROUP_POOL = 6;
export const SKILL_USES_CAP = 20000;
export const REFLEXES = Object.freeze(['Very High', 'High', 'Average', 'Low', 'Very Low']); // PlayerReflexes 0..4
export const GENDERS = Object.freeze(['Male', 'Female']);
export const FACE_COUNT = 10; // classic offers ten faces per race and gender

export const CUSTOM = Object.freeze({
  minHp: 4, maxHp: 30, defaultHp: 8,
  minDifficulty: -12, maxDifficulty: 40,
  statMin: 10, statMax: 75, statDefault: 50, statTotal: 400,
  defaultSpellMultiplier: 0.5,
});

// ------------------------------------------------------------------ races

// Classic races have no attribute modifiers; RaceTemplate grants the resistances listed. Descriptions are
// original summaries. `art` is a palette hint for the original portrait renderer (art.js).
export const RACES = Object.freeze([
  { id: 1, name: 'Breton', resist: ['Magic'], blurb: 'Hardy folk of the Iliac Bay with a natural resistance to magic.', art: { skin: '#e7c3a0', hair: '#6b4a2a' } },
  { id: 2, name: 'Redguard', resist: [], blurb: 'Desert-born warriors whose sword traditions are known across the Bay.', art: { skin: '#8a5a3c', hair: '#1c1410' } },
  { id: 3, name: 'Nord', resist: ['Frost'], blurb: 'Tall northerners who shrug off cold and favour heavy weapons.', art: { skin: '#f0d0b4', hair: '#c9a066' } },
  { id: 4, name: 'Dark Elf', resist: [], blurb: 'Ashen-skinned elves skilled in both blade and spell.', art: { skin: '#7d8590', hair: '#2a1e24' } },
  { id: 5, name: 'High Elf', resist: [], immune: ['Paralysis'], blurb: 'Proud, gifted spellcasters who cannot be paralysed.', art: { skin: '#e8d49a', hair: '#e9e1c4' } },
  { id: 6, name: 'Wood Elf', resist: [], blurb: 'Quick forest folk, masters of the bow and of moving unseen.', art: { skin: '#b88a5c', hair: '#4a3420' } },
  { id: 7, name: 'Khajiit', resist: [], blurb: 'Agile cat-folk with a gift for climbing and close fighting.', art: { skin: '#c9984e', hair: '#5a3a18' } },
  { id: 8, name: 'Argonian', resist: [], blurb: 'Reptilian swimmers from the marshes, at home in water and mire.', art: { skin: '#6f8a5a', hair: '#3e4e30' } },
]);
export const RACE_BY_NAME = Object.freeze(Object.fromEntries(RACES.map((r) => [r.name, r])));

// ------------------------------------------------------------------ classes

// The eighteen standard careers, in CLASS00..CLASS17.CFG order. These are this ruleset's APPROXIMATE
// fallback values (no game data ships with the project); they are not the classic numbers. When the
// operator configures ARENA2_DIR, the server loads the exact careers from CLASS*.CFG and publishes them
// to the browser (character.career / draft.career), which then spends and displays against those.
const C = (name, hp, spell, attrs, primary, major, minor, extra = {}) => {
  const [Strength, Intelligence, Willpower, Agility, Endurance, Personality, Speed, Luck] = attrs;
  return Object.freeze({
    name, hitPointsPerLevel: hp, spellPointMultiplier: spell, advancementMultiplier: 1,
    attributes: Object.freeze({ Strength, Intelligence, Willpower, Agility, Endurance, Personality, Speed, Luck }),
    primarySkills: Object.freeze(primary), majorSkills: Object.freeze(major), minorSkills: Object.freeze(minor),
    advantages: Object.freeze(extra.advantages ?? []), disadvantages: Object.freeze(extra.disadvantages ?? []),
    noRegenMagicka: !!extra.noRegenMagicka, group: extra.group ?? 'Mixed', blurb: extra.blurb ?? '',
  });
};

export const CLASSES = Object.freeze([
  C('Mage', 6, 2.0, [35, 60, 55, 40, 40, 45, 45, 40],
    ['Alteration', 'Destruction', 'Mysticism'], ['Illusion', 'Restoration', 'Thaumaturgy'],
    ['Daedric', 'Dragonish', 'Etiquette', 'Harpy', 'Nymph', 'Short Blade'],
    { group: 'Magic', blurb: 'A scholar of all six schools, fragile in a fight but deep in magicka.' }),
  C('Spellsword', 12, 1.5, [45, 50, 45, 45, 45, 40, 40, 40],
    ['Destruction', 'Long Blade', 'Restoration'], ['Alteration', 'Blunt Weapon', 'Mysticism'],
    ['Archery', 'Dodging', 'Etiquette', 'Illusion', 'Running', 'Thaumaturgy'],
    { group: 'Magic', blurb: 'Blade in one hand, spell in the other.' }),
  C('Battlemage', 10, 1.75, [50, 55, 45, 40, 45, 40, 35, 40],
    ['Destruction', 'Long Blade', 'Mysticism'], ['Alteration', 'Axe', 'Thaumaturgy'],
    ['Archery', 'Blunt Weapon', 'Daedric', 'Dodging', 'Restoration', 'Running'],
    { group: 'Magic', blurb: 'A war-wizard trained to destroy, armoured enough to survive doing it.' }),
  C('Sorcerer', 8, 3.0, [40, 60, 55, 40, 40, 40, 45, 40],
    ['Destruction', 'Mysticism', 'Thaumaturgy'], ['Alteration', 'Daedric', 'Illusion'],
    ['Dragonish', 'Harpy', 'Nymph', 'Restoration', 'Short Blade', 'Spriggan'],
    {
      group: 'Magic', noRegenMagicka: true,
      advantages: [{ key: 'spellAbsorption', option: 'general' }],
      disadvantages: [{ key: 'inabilityToRegen' }],
      blurb: 'Vast magicka that never returns on its own; it must be drawn from hostile spells.',
    }),
  C('Healer', 8, 1.75, [40, 50, 55, 40, 45, 50, 35, 40],
    ['Medical', 'Restoration', 'Alteration'], ['Etiquette', 'Mysticism', 'Blunt Weapon'],
    ['Illusion', 'Mercantile', 'Nymph', 'Spriggan', 'Streetwise', 'Thaumaturgy'],
    { group: 'Magic', blurb: 'A mender of wounds and curer of disease.' }),
  C('Nightblade', 12, 1.5, [40, 50, 45, 50, 40, 40, 45, 40],
    ['Backstabbing', 'Illusion', 'Short Blade'], ['Destruction', 'Lockpicking', 'Stealth'],
    ['Alteration', 'Climbing', 'Critical Strike', 'Dodging', 'Mysticism', 'Streetwise'],
    { group: 'Mixed', blurb: 'A spellcasting killer who works from the shadows.' }),
  C('Bard', 10, 1.0, [40, 50, 40, 45, 40, 55, 45, 45],
    ['Etiquette', 'Streetwise', 'Short Blade'], ['Illusion', 'Mercantile', 'Pickpocket'],
    ['Archery', 'Climbing', 'Dodging', 'Lockpicking', 'Running', 'Stealth'],
    { group: 'Mixed', blurb: 'A silver-tongued wanderer with a little of everything.' }),
  C('Burglar', 12, 0.5, [40, 45, 40, 55, 40, 40, 50, 45],
    ['Climbing', 'Lockpicking', 'Stealth'], ['Dodging', 'Pickpocket', 'Short Blade'],
    ['Backstabbing', 'Etiquette', 'Jumping', 'Mercantile', 'Running', 'Streetwise'],
    { group: 'Stealth', blurb: 'A specialist in locked doors and darkened houses.' }),
  C('Rogue', 14, 0.5, [50, 40, 40, 50, 45, 40, 45, 45],
    ['Short Blade', 'Streetwise', 'Long Blade'], ['Backstabbing', 'Dodging', 'Pickpocket'],
    ['Archery', 'Climbing', 'Etiquette', 'Lockpicking', 'Running', 'Stealth'],
    { group: 'Stealth', blurb: 'A brawler of the back alleys, as quick with a blade as with a lie.' }),
  C('Acrobat', 12, 0.5, [40, 40, 40, 55, 45, 40, 55, 40],
    ['Climbing', 'Dodging', 'Jumping'], ['Running', 'Short Blade', 'Stealth'],
    ['Backstabbing', 'Hand-to-Hand', 'Lockpicking', 'Pickpocket', 'Streetwise', 'Swimming'],
    { group: 'Stealth', advantages: [{ key: 'athleticism' }], blurb: 'Nimble and tireless, hard to pin down and harder to catch.' }),
  C('Thief', 10, 0.5, [40, 45, 40, 55, 40, 45, 50, 45],
    ['Lockpicking', 'Pickpocket', 'Stealth'], ['Climbing', 'Dodging', 'Short Blade'],
    ['Backstabbing', 'Etiquette', 'Jumping', 'Mercantile', 'Running', 'Streetwise'],
    { group: 'Stealth', blurb: 'Light fingers, quiet feet and a nose for valuables.' }),
  C('Assassin', 16, 0.5, [45, 45, 40, 55, 45, 35, 50, 40],
    ['Backstabbing', 'Critical Strike', 'Short Blade'], ['Archery', 'Climbing', 'Stealth'],
    ['Dodging', 'Jumping', 'Lockpicking', 'Long Blade', 'Running', 'Streetwise'],
    { group: 'Stealth', blurb: 'A professional killer: one clean blow, then gone.' }),
  C('Monk', 16, 0.5, [45, 40, 50, 55, 45, 40, 50, 35],
    ['Critical Strike', 'Dodging', 'Hand-to-Hand'], ['Climbing', 'Jumping', 'Stealth'],
    ['Etiquette', 'Medical', 'Mysticism', 'Restoration', 'Running', 'Swimming'],
    { group: 'Combat', advantages: [{ key: 'expertiseIn', option: 'Hand-to-Hand' }], blurb: 'An unarmed fighter of iron discipline.' }),
  C('Archer', 18, 0.5, [50, 40, 40, 55, 45, 35, 45, 40],
    ['Archery', 'Critical Strike', 'Running'], ['Dodging', 'Long Blade', 'Stealth'],
    ['Axe', 'Climbing', 'Jumping', 'Short Blade', 'Swimming', 'Streetwise'],
    { group: 'Combat', blurb: 'Death from a distance; keep the bowstring dry.' }),
  C('Ranger', 18, 0.5, [50, 40, 40, 50, 50, 35, 45, 40],
    ['Archery', 'Long Blade', 'Stealth'], ['Climbing', 'Running', 'Swimming'],
    ['Axe', 'Dodging', 'Giantish', 'Medical', 'Orcish', 'Spriggan'],
    { group: 'Combat', blurb: 'A wilderness hunter at home far from any road.' }),
  C('Barbarian', 24, 0.5, [60, 35, 35, 45, 60, 35, 45, 35],
    ['Axe', 'Blunt Weapon', 'Running'], ['Hand-to-Hand', 'Long Blade', 'Swimming'],
    ['Archery', 'Climbing', 'Critical Strike', 'Dodging', 'Jumping', 'Orcish'],
    { group: 'Combat', advantages: [{ key: 'rapidHealing', option: 'general' }], blurb: 'A fearsome brawler who heals almost as fast as they bleed.' }),
  C('Warrior', 22, 0.5, [60, 35, 40, 45, 55, 35, 45, 40],
    ['Long Blade', 'Axe', 'Blunt Weapon'], ['Archery', 'Dodging', 'Hand-to-Hand'],
    ['Critical Strike', 'Giantish', 'Jumping', 'Orcish', 'Running', 'Swimming'],
    { group: 'Combat', blurb: 'A soldier through and through; masters every weapon of war.' }),
  C('Knight', 20, 0.5, [55, 40, 45, 40, 55, 50, 35, 40],
    ['Etiquette', 'Long Blade', 'Blunt Weapon'], ['Axe', 'Dragonish', 'Restoration'],
    ['Archery', 'Critical Strike', 'Giantish', 'Hand-to-Hand', 'Medical', 'Running'],
    { group: 'Combat', blurb: 'Armoured nobility, sworn to a code and trained to the lance.' }),
]);
export const CLASS_BY_NAME = Object.freeze(Object.fromEntries(CLASSES.map((c) => [c.name, c])));

// ------------------------------------------------------------------ special advantages (custom classes)

// CreateCharSpecialAdvantageWindow difficulty table. `options` lists valid secondary keys; cost per option.
export const ADVANTAGES = Object.freeze({
  acuteHearing: { label: 'Acute hearing', cost: 1 },
  adrenalineRush: { label: 'Adrenaline rush', cost: 4 },
  athleticism: { label: 'Athleticism', cost: 4 },
  bonusToHit: { label: 'Bonus to hit', options: { Animals: 6, Daedra: 3, Humanoid: 6, Undead: 6 } },
  expertiseIn: { label: 'Expertise in', cost: 2, options: weaponOptions(2) },
  immunity: { label: 'Immunity', cost: 10, options: elementOptions(10) },
  increasedMagery: { label: 'Increased magery', options: { '1x INT': 2, '1.5x INT': 4, '1.75x INT': 6, '2x INT': 8, '3x INT': 10 } },
  rapidHealing: { label: 'Rapid healing', options: { general: 4, 'in darkness': 3, 'in light': 2 } },
  regenerateHealth: { label: 'Regenerate health', options: { general: 14, 'in darkness': 10, 'in light': 6, 'while immersed': 2 } },
  resistance: { label: 'Resistance', cost: 5, options: elementOptions(5) },
  spellAbsorption: { label: 'Spell absorption', options: { general: 14, 'in darkness': 12, 'in light': 8 } },
});
export const DISADVANTAGES = Object.freeze({
  criticalWeakness: { label: 'Critical weakness', cost: -14, options: elementOptions(-14) },
  damage: { label: 'Damage', options: { 'from holy places': -6, 'from sunlight': -10 } },
  darknessPoweredMagery: { label: 'Darkness-powered magery', options: { 'lower magic ability in daylight': -7, 'unable to use magic in daylight': -10 } },
  forbiddenArmorType: { label: 'Forbidden armor type', options: { Chain: -2, Leather: -1, Plate: -5 } },
  forbiddenMaterial: { label: 'Forbidden material', options: { Adamantium: -5, Daedric: -2, Dwarven: -7, Ebony: -5, Elven: -9, Iron: -1, Mithril: -6, Orcish: -3, Silver: -6, Steel: -10 } },
  forbiddenShieldTypes: { label: 'Forbidden shield types', cost: -1, options: { Buckler: -1, 'Round Shield': -1, 'Kite Shield': -1, 'Tower Shield': -1 } },
  forbiddenWeaponry: { label: 'Forbidden weaponry', cost: -2, options: weaponOptions(-2) },
  inabilityToRegen: { label: 'Inability to regenerate spell points', cost: -14 },
  lightPoweredMagery: { label: 'Light-powered magery', options: { 'lower magic ability in darkness': -10, 'unable to use magic in darkness': -14 } },
  lowTolerance: { label: 'Low tolerance', cost: -5, options: elementOptions(-5) },
  phobia: { label: 'Phobia', cost: -4, options: { Animals: -4, Daedra: -4, Humanoid: -4, Undead: -4 } },
});
const MAGERY = Object.freeze({ '1x INT': 1, '1.5x INT': 1.5, '1.75x INT': 1.75, '2x INT': 2, '3x INT': 3 });

function weaponOptions(cost) {
  return Object.fromEntries(['Short Blade', 'Long Blade', 'Hand-to-Hand', 'Axe', 'Blunt Weapon', 'Missile Weapons'].map((w) => [w, cost]));
}
function elementOptions(cost) {
  return Object.fromEntries(['Disease', 'Fire', 'Frost', 'Magic', 'Paralysis', 'Poison', 'Shock'].map((e) => [e, cost]));
}

// ------------------------------------------------------------------ random

export const rangeInclusive = (rng, lo, hi) => lo + Math.floor(rng() * (hi + 1 - lo));

// ------------------------------------------------------------------ derived values (FormulaHelper)

export const hitPointsModifier = (endurance) => Math.floor(endurance / 10) - 5;
export const maxHealthAtLevel1 = (career) => 25 + career.hitPointsPerLevel;
export const spellPoints = (intelligence, multiplier) => Math.floor(intelligence * multiplier);
export const maxFatigue = (attrs) => attrs.Strength + attrs.Endurance;
export const attributeModifier = (value) => Math.floor(value / 10) - 5;

export function hitPointsPerLevelUp(career, endurance, rng) {
  const hp = career.hitPointsPerLevel;
  const add = rangeInclusive(rng, Math.trunc(hp / 2), hp) + hitPointsModifier(endurance);
  return add < 1 ? 1 : add;
}

export function usesForAdvancement(skillValue, skillName, careerMultiplier, level) {
  const levelMod = Math.pow(1.04, level);
  return Math.floor((skillValue * SKILL_ADVANCEMENT[skillName] * careerMultiplier * levelMod * 2) / 5 + 1);
}

/** PlayerEntity.RaiseSkills reflexes modifier: (uses * (0x10000 - ((reflexes - 2) << 13))) >> 16 */
export function effectiveUses(uses, reflexes) {
  const raw = REFLEXES.indexOf(reflexes);
  const idx = raw < 0 ? 2 : raw;
  const mod = 0x10000 - ((idx - 2) << 13);
  return (uses * mod) >> 16;
}

/** PlayerEntity.SetCurrentLevelUpSkillSum: primaries + majors - lowest major + highest minor. */
export function levelUpSkillSum(skills, career) {
  let sum = 0;
  for (const s of career.primarySkills) sum += skills[s] ?? 0;
  const majors = career.majorSkills.map((s) => skills[s] ?? 0);
  sum += majors.reduce((a, b) => a + b, 0) - Math.min(...majors);
  sum += Math.max(...career.minorSkills.map((s) => skills[s] ?? 0));
  return sum;
}

export const levelFor = (startingSum, currentSum) => Math.floor((currentSum - startingSum + 28) / 15);

/** Fraction of the way to the next level, for the sheet's progress bar. */
export function levelProgress(startingSum, currentSum) {
  const v = (currentSum - startingSum + 28) / 15;
  return v - Math.floor(v);
}

export function derivedMaxima(attrs, career) {
  return {
    maxFatigue: maxFatigue(attrs),
    maxMagicka: spellPoints(attrs.Intelligence, career.spellPointMultiplier),
  };
}

// ------------------------------------------------------------------ rolls

export function rollAttributes(career, rng) {
  const base = {};
  for (const a of ATTRIBUTES) base[a] = Math.min(MAX_STAT, career.attributes[a] + rangeInclusive(rng, ...STAT_BONUS_ROLL));
  return { base, bonusPool: rangeInclusive(rng, ...STAT_BONUS_POOL) };
}

export function rollSkills(career, rng) {
  const base = {};
  for (const s of SKILLS) base[s] = rangeInclusive(rng, ...SKILL_DEFAULT);
  for (const [group, list] of groupsOf(career)) {
    for (const s of list) base[s] = SKILL_GROUP_MIN[group] + rangeInclusive(rng, 0, SKILL_GROUP_ROLL);
  }
  return { base, pools: { primary: SKILL_GROUP_POOL, major: SKILL_GROUP_POOL, minor: SKILL_GROUP_POOL } };
}

export function groupsOf(career) {
  return [['primary', career.primarySkills], ['major', career.majorSkills], ['minor', career.minorSkills]];
}

export function skillGroupOf(career, skill) {
  for (const [g, list] of groupsOf(career)) if (list.includes(skill)) return g;
  return null;
}

// ------------------------------------------------------------------ validation

export class RuleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuleError';
    this.expose = true; // player-readable: the runtime passes the message through
  }
}
const fail = (msg) => { throw new RuleError(msg); };
const isInt = (v) => Number.isInteger(v);

/** Validates a hand distribution of the attribute bonus pool. Returns a clean copy. */
export function validateAttributeSpend(base, pool, proposed) {
  if (!proposed || typeof proposed !== 'object') fail('Attributes are missing.');
  const out = {};
  let spent = 0;
  let headroom = 0;
  for (const a of ATTRIBUTES) {
    const v = proposed[a];
    if (!isInt(v)) fail(`${a} must be a whole number.`);
    if (v < base[a]) fail(`${a} cannot be lowered below its rolled value of ${base[a]}.`);
    if (v > MAX_STAT) fail(`${a} cannot exceed ${MAX_STAT}.`);
    spent += v - base[a];
    headroom += Math.max(0, MAX_STAT - base[a]);
    out[a] = v;
  }
  for (const k of Object.keys(proposed)) if (!ATTRIBUTES.includes(k)) fail(`Unknown attribute "${k}".`);
  const target = Math.min(pool, headroom);
  if (spent !== target) fail(spent < target ? `Distribute all bonus points (${target - spent} left).` : 'Too many bonus points were spent.');
  return out;
}

/** Validates the +6 per group skill distribution. Returns a clean copy. */
export function validateSkillSpend(base, career, proposed) {
  if (!proposed || typeof proposed !== 'object') fail('Skills are missing.');
  const out = {};
  for (const k of Object.keys(proposed)) if (!(k in SKILL_INDEX)) fail(`Unknown skill "${k}".`);
  const spentBy = { primary: 0, major: 0, minor: 0 };
  for (const s of SKILLS) {
    const v = proposed[s] ?? base[s];
    if (!isInt(v)) fail(`${s} must be a whole number.`);
    const group = skillGroupOf(career, s);
    if (!group) {
      if (v !== base[s]) fail(`${s} is not one of your class skills and cannot be raised now.`);
    } else {
      if (v < base[s]) fail(`${s} cannot be lowered below ${base[s]}.`);
      if (v > MAX_SKILL) fail(`${s} cannot exceed ${MAX_SKILL}.`);
      spentBy[group] += v - base[s];
    }
    out[s] = v;
  }
  for (const g of ['primary', 'major', 'minor']) {
    if (spentBy[g] !== SKILL_GROUP_POOL) {
      fail(spentBy[g] < SKILL_GROUP_POOL
        ? `Distribute all ${g} skill points (${SKILL_GROUP_POOL - spentBy[g]} left).`
        : `Too many ${g} skill points were spent.`);
    }
  }
  return out;
}

export function validateLevelSpend(current, pool, proposed) {
  if (!proposed || typeof proposed !== 'object') fail('Attributes are missing.');
  const out = {};
  let spent = 0;
  let headroom = 0;
  for (const a of ATTRIBUTES) {
    const v = proposed[a];
    if (!isInt(v)) fail(`${a} must be a whole number.`);
    if (v < current[a]) fail(`${a} cannot be lowered.`);
    if (v > MAX_STAT) fail(`${a} cannot exceed ${MAX_STAT}.`);
    spent += v - current[a];
    headroom += Math.max(0, MAX_STAT - current[a]);
    out[a] = v;
  }
  for (const k of Object.keys(proposed)) if (!ATTRIBUTES.includes(k)) fail(`Unknown attribute "${k}".`);
  const target = Math.min(pool, headroom);
  if (spent !== target) fail(spent < target ? `Distribute all bonus points (${target - spent} left).` : 'Too many bonus points were spent.');
  return out;
}

const NAME_RE = /^[\p{L}][\p{L}\p{M} '.-]*$/u;
export function cleanCharacterName(raw, max = 24) {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > max || !NAME_RE.test(name)) return null;
  return name;
}

// ------------------------------------------------------------------ custom classes

function lookupCost(table, entry) {
  const def = table[entry?.key];
  if (!def) fail(`Unknown special ability "${entry?.key}".`);
  if (def.options) {
    if (!(entry.option in def.options)) fail(`Choose a valid option for ${def.label.toLowerCase()}.`);
    return def.options[entry.option];
  }
  if (entry.option != null && entry.option !== '') fail(`${def.label} takes no option.`);
  return def.cost;
}

export function customDifficulty(hp, advantages = [], disadvantages = []) {
  let points = hp >= CUSTOM.defaultHp ? hp - CUSTOM.defaultHp : -2 * (CUSTOM.defaultHp - hp);
  for (const a of advantages) points += lookupCost(ADVANTAGES, a);
  for (const d of disadvantages) points += lookupCost(DISADVANTAGES, d);
  return points;
}

/** CreateCharCustomClass.UpdateDifficulty */
export const advancementMultiplierFor = (difficulty) => Math.round((0.3 + (2.7 * (difficulty + 12)) / 52) * 100) / 100;

/**
 * Validates a player-designed class and returns an immutable career with the same shape as CLASSES entries.
 * Throws RuleError with a player-readable message on the first problem.
 */
export function buildCustomClass(spec) {
  if (!spec || typeof spec !== 'object') fail('The class design is missing.');
  const name = cleanCharacterName(spec.name, 16);
  if (!name) fail('Name your class (up to 16 letters).');
  if (CLASS_BY_NAME[name]) fail(`"${name}" is a standard class. Choose another name.`);
  const hp = spec.hitPointsPerLevel;
  if (!isInt(hp) || hp < CUSTOM.minHp || hp > CUSTOM.maxHp) fail(`Hit points per level must be ${CUSTOM.minHp}–${CUSTOM.maxHp}.`);

  const attrs = {};
  let total = 0;
  for (const a of ATTRIBUTES) {
    const v = spec.attributes?.[a];
    if (!isInt(v) || v < CUSTOM.statMin || v > CUSTOM.statMax) fail(`${a} must be between ${CUSTOM.statMin} and ${CUSTOM.statMax}.`);
    attrs[a] = v;
    total += v;
  }
  if (total !== CUSTOM.statTotal) fail(`Attributes must total ${CUSTOM.statTotal} (now ${total}).`);

  const lists = { primary: spec.primarySkills, major: spec.majorSkills, minor: spec.minorSkills };
  const need = { primary: 3, major: 3, minor: 6 };
  const seen = new Set();
  for (const [g, list] of Object.entries(lists)) {
    if (!Array.isArray(list) || list.length !== need[g]) fail(`Choose ${need[g]} ${g} skills.`);
    for (const s of list) {
      if (!(s in SKILL_INDEX)) fail(`Unknown skill "${s}".`);
      if (seen.has(s)) fail(`${s} is chosen more than once.`);
      seen.add(s);
    }
  }

  const advantages = normalizeAbilities(spec.advantages, ADVANTAGES);
  const disadvantages = normalizeAbilities(spec.disadvantages, DISADVANTAGES);
  const difficulty = customDifficulty(hp, advantages, disadvantages);
  if (difficulty < CUSTOM.minDifficulty || difficulty > CUSTOM.maxDifficulty) {
    fail(difficulty > CUSTOM.maxDifficulty
      ? 'This class is too powerful. Remove an advantage, lower hit points or add a disadvantage.'
      : 'This class is too weak. Add an advantage, raise hit points or remove a disadvantage.');
  }
  const magery = advantages.find((a) => a.key === 'increasedMagery');
  return Object.freeze({
    name, custom: true, hitPointsPerLevel: hp,
    spellPointMultiplier: magery ? MAGERY[magery.option] : CUSTOM.defaultSpellMultiplier,
    advancementMultiplier: advancementMultiplierFor(difficulty), difficulty,
    attributes: Object.freeze(attrs),
    primarySkills: Object.freeze([...lists.primary]), majorSkills: Object.freeze([...lists.major]), minorSkills: Object.freeze([...lists.minor]),
    advantages: Object.freeze(advantages), disadvantages: Object.freeze(disadvantages),
    noRegenMagicka: disadvantages.some((d) => d.key === 'inabilityToRegen'),
    group: 'Custom', blurb: 'A class of your own design.',
  });
}

function normalizeAbilities(list, table) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 14) fail('Too many special abilities.');
  const out = [];
  const keys = new Set();
  for (const e of list) {
    const entry = { key: String(e?.key ?? ''), ...(e?.option != null && e.option !== '' ? { option: String(e.option) } : {}) };
    lookupCost(table, entry);
    const id = `${entry.key}:${entry.option ?? ''}`;
    if (keys.has(id)) fail(`${table[entry.key].label} is listed twice.`);
    // Only one magery level, one healing mode etc. may be chosen.
    if (['increasedMagery', 'rapidHealing', 'regenerateHealth', 'spellAbsorption', 'darknessPoweredMagery', 'lightPoweredMagery'].includes(entry.key)
      && out.some((o) => o.key === entry.key)) fail(`Choose only one ${table[entry.key].label.toLowerCase()} option.`);
    keys.add(id);
    out.push(Object.freeze(entry));
  }
  return out;
}

export function describeAbility(entry) {
  const def = ADVANTAGES[entry.key] ?? DISADVANTAGES[entry.key];
  if (!def) return entry.key;
  return entry.option ? `${def.label} (${entry.option})` : def.label;
}

// The class questionnaire and biography read the classic data from the player's installation:
// see classic.js (TEXT.RSC 9000, CLASSES.DAT, BIOGnnT0.TXT). No question text lives in this module.

// ------------------------------------------------------------------ defaults for old guests

/** A deterministic, classic-legal default career for players who have not created a character yet. */
export const DEFAULT_CLASS = 'Warrior';
export const DEFAULT_RACE = 'Breton';

/** A mastered primary (100) limits further advancement of every other skill to 95. */
export function skillCeiling(skills, career, skill) {
  const mastered = career.primarySkills.some((s) => s !== skill && skills[s] >= MAX_SKILL);
  return mastered ? MASTERED_SKILL_CAP : MAX_SKILL;
}

/** Bonus points spread one at a time into the lowest value (the headless policy of the reference port). */
export function spendLowest(values, keys, pool) {
  for (let p = pool; p > 0; p--) {
    let low = keys[0];
    for (const k of keys) if (values[k] < values[low]) low = k;
    if (values[low] >= MAX_STAT) break;
    values[low] += 1;
  }
  return values;
}

export function defaultBuild(career = CLASS_BY_NAME[DEFAULT_CLASS]) {
  const attributes = {};
  for (const a of ATTRIBUTES) attributes[a] = career.attributes[a] + 5;
  spendLowest(attributes, ATTRIBUTES, 10);
  const skills = {};
  for (const s of SKILLS) skills[s] = 5;
  for (const [g, list] of groupsOf(career)) {
    for (const s of list) skills[s] = SKILL_GROUP_MIN[g] + 2;
    spendLowest(skills, list, SKILL_GROUP_POOL);
  }
  return { attributes, skills };
}
