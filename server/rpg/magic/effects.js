// Classic spell effect templates: classic (type, subType) keys, governing magic school,
// supported settings (D)uration/(C)hance/(M)agnitude and spellmaker cost coefficients
// [costA, costB, offsetGold]. Values transcribed from Daggerfall Unity's effect classes in
// Assets/Scripts/Game/MagicAndEffects/Effects (MIT License,
// Copyright (c) 2009-2023 Daggerfall Workshop). Contains no Bethesda game data.
//
// `support` states what this server does with an effect:
//   applied      — changes authoritative game state (health, fatigue, magicka, death, active effects).
//   tracked      — becomes a timed status on the target that is shown to players and exposed through
//                  ctx.services.magicStatus / magicModifiers; its world consequence (movement, AI,
//                  visibility, damage absorption) depends on other features consulting that service.
//   unsupported  — the classic effect family has no counterpart in this world yet; spells made only
//                  of such effects cannot be learned or cast and say so.

const ROWS = [
  ['Paralyze', 0, -1, 'Alteration', 'DC', [28, 100], [28, 100], null, 'other'],
  ['ContinuousDamage-Health', 1, 0, 'Destruction', 'DM', [28, 8], null, [40, 28], 'other'],
  ['ContinuousDamage-Fatigue', 1, 1, 'Destruction', 'DM', [20, 8], null, [40, 28], 'other'],
  ['ContinuousDamage-SpellPoints', 1, 2, 'Destruction', 'DM', [40, 8], null, [40, 28], 'other'],
  ['CreateItem', 2, -1, 'Mysticism', 'D', [60, 120], null, null, 'self'],
  ['Cure-Disease', 3, 0, 'Restoration', 'C', null, [8, 100], null, 'all'],
  ['Cure-Poison', 3, 1, 'Restoration', 'C', null, [8, 100], null, 'all'],
  ['Cure-Paralyzation', 3, 2, 'Restoration', 'C', null, [20, 140], null, 'all'],
  ['Damage-Health', 4, 0, 'Destruction', 'M', null, null, [20, 28], 'other'],
  ['Damage-Fatigue', 4, 1, 'Destruction', 'M', null, null, [20, 28], 'other'],
  ['Damage-SpellPoints', 4, 2, 'Destruction', 'M', null, null, [20, 28], 'other'],
  ['Disintegrate', 5, -1, 'Destruction', 'C', null, [80, 140], null, 'other'],
  ['Dispel-Magic', 6, 0, 'Mysticism', 'C', null, [120, 180], null, 'self'],
  ['Dispel-Undead', 6, 1, 'Mysticism', 'C', null, [80, 140], null, 'self'],
  ['Dispel-Daedra', 6, 2, 'Mysticism', 'C', null, [120, 180], null, 'self'],
  ['Drain-Strength', 7, 0, 'Destruction', 'M', null, null, [8, 100, 116], 'other'],
  ['Drain-Intelligence', 7, 1, 'Destruction', 'M', null, null, [8, 100, 116], 'other'],
  ['Drain-Willpower', 7, 2, 'Destruction', 'M', null, null, [8, 100, 116], 'other'],
  ['Drain-Agility', 7, 3, 'Destruction', 'M', null, null, [8, 100, 116], 'other'],
  ['Drain-Endurance', 7, 4, 'Destruction', 'M', null, null, [8, 100, 116], 'other'],
  ['Drain-Personality', 7, 5, 'Destruction', 'M', null, null, [8, 100, 116], 'other'],
  ['Drain-Speed', 7, 6, 'Destruction', 'M', null, null, [8, 100, 116], 'other'],
  ['Drain-Luck', 7, 7, 'Destruction', 'M', null, null, [8, 100, 116], 'other'],
  ['ElementalResistance-Fire', 8, 0, 'Alteration', 'DC', [100, 100], [8, 100], null, 'all'],
  ['ElementalResistance-Frost', 8, 1, 'Alteration', 'DC', [100, 100], [8, 100], null, 'all'],
  ['ElementalResistance-Poison', 8, 2, 'Alteration', 'DC', [100, 100], [8, 100], null, 'all'],
  ['ElementalResistance-Shock', 8, 3, 'Alteration', 'DC', [100, 100], [8, 100], null, 'all'],
  ['ElementalResistance-Magicka', 8, 4, 'Alteration', 'DC', [100, 100], [8, 100], null, 'all'],
  ['Fortify-Strength', 9, 0, 'Restoration', 'DM', [28, 100], null, [40, 120], 'all'],
  ['Fortify-Intelligence', 9, 1, 'Restoration', 'DM', [28, 100], null, [40, 120], 'all'],
  ['Fortify-Willpower', 9, 2, 'Restoration', 'DM', [28, 100], null, [40, 120], 'all'],
  ['Fortify-Agility', 9, 3, 'Restoration', 'DM', [28, 100], null, [40, 120], 'all'],
  ['Fortify-Endurance', 9, 4, 'Restoration', 'DM', [28, 100], null, [40, 120], 'all'],
  ['Fortify-Personality', 9, 5, 'Restoration', 'DM', [28, 100], null, [40, 120], 'all'],
  ['Fortify-Speed', 9, 6, 'Restoration', 'DM', [28, 100], null, [40, 120], 'all'],
  ['Fortify-Luck', 9, 7, 'Restoration', 'DM', [28, 100], null, [40, 120], 'all'],
  ['Heal-Strength', 10, 0, 'Restoration', 'M', null, null, [40, 28], 'all'],
  ['Heal-Intelligence', 10, 1, 'Restoration', 'M', null, null, [40, 28], 'all'],
  ['Heal-Willpower', 10, 2, 'Restoration', 'M', null, null, [40, 28], 'all'],
  ['Heal-Agility', 10, 3, 'Restoration', 'M', null, null, [40, 28], 'all'],
  ['Heal-Endurance', 10, 4, 'Restoration', 'M', null, null, [40, 28], 'all'],
  ['Heal-Personality', 10, 5, 'Restoration', 'M', null, null, [40, 28], 'all'],
  ['Heal-Speed', 10, 6, 'Restoration', 'M', null, null, [40, 28], 'all'],
  ['Heal-Luck', 10, 7, 'Restoration', 'M', null, null, [40, 28], 'all'],
  ['Heal-Health', 10, 8, 'Restoration', 'M', null, null, [20, 28], 'all'],
  ['Heal-Fatigue', 10, 9, 'Restoration', 'M', null, null, [8, 28], 'all'],
  ['Transfer-Strength', 11, 0, 'Destruction', 'M', null, null, [60, 100, 40], 'other'],
  ['Transfer-Intelligence', 11, 1, 'Destruction', 'M', null, null, [60, 100, 40], 'other'],
  ['Transfer-Willpower', 11, 2, 'Destruction', 'M', null, null, [60, 100, 40], 'other'],
  ['Transfer-Agility', 11, 3, 'Destruction', 'M', null, null, [60, 100, 40], 'other'],
  ['Transfer-Endurance', 11, 4, 'Destruction', 'M', null, null, [60, 100, 40], 'other'],
  ['Transfer-Personality', 11, 5, 'Destruction', 'M', null, null, [60, 100, 40], 'other'],
  ['Transfer-Speed', 11, 6, 'Destruction', 'M', null, null, [60, 100, 40], 'other'],
  ['Transfer-Luck', 11, 7, 'Destruction', 'M', null, null, [60, 100, 40], 'other'],
  ['Transfer-Health', 11, 8, 'Destruction', 'M', null, null, [60, 100, 40], 'other'],
  ['Transfer-Fatigue', 11, 9, 'Destruction', 'M', null, null, [60, 100, 40], 'other'],
  ['SoulTrap', 12, -1, 'Mysticism', 'DC', [60, 68], [40, 68], null, 'other'],
  ['Invisibility-Normal', 13, 0, 'Illusion', 'D', [40, 120], null, null, 'all'],
  ['Invisibility-True', 13, 1, 'Illusion', 'D', [60, 140], null, null, 'all'],
  ['Levitate', 14, -1, 'Thaumaturgy', 'D', [60, 100], null, null, 'self'],
  ['Light', 15, -1, 'Illusion', 'D', [8, 40], null, null, 'self'],
  ['Lock', 16, -1, 'Mysticism', 'C', null, [28, 120, 120], null, 'self'],
  ['Open', 17, -1, 'Mysticism', 'C', null, [20, 100], null, 'self'],
  ['Regenerate', 18, -1, 'Restoration', 'DM', [100, 20], null, [8, 8], 'all'],
  ['Silence', 19, -1, 'Mysticism', 'DC', [20, 100], [20, 100], null, 'all'],
  ['SpellAbsorption', 20, -1, 'Restoration', 'DC', [28, 140], [28, 140], null, 'all'],
  ['SpellReflection', 21, -1, 'Thaumaturgy', 'DC', [28, 140], [28, 140], null, 'all'],
  ['SpellResistance', 22, -1, 'Thaumaturgy', 'DC', [20, 100], [20, 100], null, 'all'],
  ['Chameleon-Normal', 23, 0, 'Illusion', 'D', [20, 80], null, null, 'all'],
  ['Chameleon-True', 23, 1, 'Illusion', 'D', [40, 120], null, null, 'all'],
  ['Shadow-Normal', 24, 0, 'Illusion', 'D', [20, 80], null, null, 'all'],
  ['Shadow-True', 24, 1, 'Illusion', 'D', [40, 120], null, null, 'all'],
  ['Slowfall', 25, -1, 'Alteration', 'D', [20, 100], null, null, 'self'],
  ['FreeAction', 26, -1, 'Restoration', 'D', [20, 8], null, null, 'all'],
  ['Jumping', 27, -1, 'Alteration', 'D', [20, 8], null, null, 'all'],
  ['Climbing', 28, -1, 'Alteration', 'D', [20, 20], null, null, 'all'],
  ['MorphSelf', 29, -1, 'Illusion', '', null, null, null, 'self'],
  ['WaterBreathing', 30, -1, 'Alteration', 'D', [20, 8], null, null, 'all'],
  ['WaterWalking', 31, -1, 'Thaumaturgy', 'D', [20, 8], null, null, 'all'],
  ['Pacify-Animal', 33, 0, 'Thaumaturgy', 'C', null, [60, 100, 160], null, 'other'],
  ['Pacify-Undead', 33, 1, 'Thaumaturgy', 'C', null, [80, 140, 60], null, 'other'],
  ['Pacify-Humanoid', 33, 2, 'Thaumaturgy', 'C', null, [80, 140, 60], null, 'other'],
  ['Pacify-Daedra', 33, 3, 'Thaumaturgy', 'C', null, [60, 120, 36], null, 'other'],
  ['Charm', 34, -1, 'Thaumaturgy', 'C', null, [40, 60], null, 'other'],
  ['Shield', 35, -1, 'Alteration', 'DM', [28, 8], null, [80, 60], 'all'],
  ['Detect-Magic', 39, 0, 'Thaumaturgy', 'D', [20, 8, 200], null, null, 'self'],
  ['Detect-Enemy', 39, 1, 'Thaumaturgy', 'D', [20, 8, 200], null, null, 'self'],
  ['Detect-Treasure', 39, 2, 'Thaumaturgy', 'D', [20, 8, 160], null, null, 'self'],
  ['Identify', 40, -1, 'Thaumaturgy', 'C', null, [40, 100, 28], null, 'self'],
  ['Teleport-Effect', 43, -1, 'Mysticism', '', null, null, null, 'self'],
  ['ComprehendLanguages', 44, -1, 'Mysticism', 'DC', [60, 68], [40, 68], null, 'self'],
];

export const SCHOOLS = ['Alteration', 'Destruction', 'Illusion', 'Mysticism', 'Restoration', 'Thaumaturgy'];
export const ATTRIBUTES = ['Strength', 'Intelligence', 'Willpower', 'Agility', 'Endurance', 'Personality', 'Speed', 'Luck'];

// How each implemented key behaves. Anything absent here is unsupported.
const BEHAVIOUR = {
  CreateItem: { support: 'applied', kind: 'createItem' },
  'Damage-Health': { support: 'applied', kind: 'damage', pool: 'health', harmful: true },
  'Damage-Fatigue': { support: 'applied', kind: 'damage', pool: 'fatigue', harmful: true },
  'Damage-SpellPoints': { support: 'applied', kind: 'damage', pool: 'magicka', harmful: true },
  'ContinuousDamage-Health': { support: 'applied', kind: 'dot', pool: 'health', harmful: true },
  'ContinuousDamage-Fatigue': { support: 'applied', kind: 'dot', pool: 'fatigue', harmful: true },
  'ContinuousDamage-SpellPoints': { support: 'applied', kind: 'dot', pool: 'magicka', harmful: true },
  'Transfer-Health': { support: 'applied', kind: 'transfer', pool: 'health', harmful: true },
  'Transfer-Fatigue': { support: 'applied', kind: 'transfer', pool: 'fatigue', harmful: true },
  Disintegrate: { support: 'applied', kind: 'disintegrate', harmful: true },
  'Dispel-Undead': { support: 'applied', kind: 'banish', group: 'undead', harmful: true },
  'Dispel-Daedra': { support: 'applied', kind: 'banish', group: 'daedra', harmful: true },
  Paralyze: { support: 'tracked', kind: 'status', status: 'paralyzed', harmful: true },
  Silence: { support: 'tracked', kind: 'status', status: 'silenced', harmful: true },
  'Heal-Health': { support: 'applied', kind: 'heal', pool: 'health' },
  'Heal-Fatigue': { support: 'applied', kind: 'heal', pool: 'fatigue' },
  Regenerate: { support: 'applied', kind: 'hot', pool: 'health' },
  'Cure-Paralyzation': { support: 'applied', kind: 'cure', removes: ['Paralyze'] },
  'Cure-Poison': { support: 'applied', kind: 'cure', condition: 'poison' },
  'Cure-Disease': { support: 'applied', kind: 'cure', condition: 'disease' },
  'Dispel-Magic': { support: 'applied', kind: 'dispel' },
  Shield: { support: 'tracked', kind: 'shield' },
  Light: { support: 'tracked', kind: 'status', status: 'light' },
  'Invisibility-Normal': { support: 'tracked', kind: 'status', status: 'invisible' },
  'Invisibility-True': { support: 'tracked', kind: 'status', status: 'invisible' },
  'Chameleon-Normal': { support: 'tracked', kind: 'status', status: 'chameleon' },
  'Chameleon-True': { support: 'tracked', kind: 'status', status: 'chameleon' },
  'Shadow-Normal': { support: 'tracked', kind: 'status', status: 'shadow' },
  'Shadow-True': { support: 'tracked', kind: 'status', status: 'shadow' },
  Levitate: { support: 'tracked', kind: 'status', status: 'levitating' },
  Slowfall: { support: 'tracked', kind: 'status', status: 'slowfall' },
  Jumping: { support: 'tracked', kind: 'status', status: 'jumping' },
  Climbing: { support: 'tracked', kind: 'status', status: 'climbing' },
  WaterWalking: { support: 'tracked', kind: 'status', status: 'waterWalking' },
  WaterBreathing: { support: 'tracked', kind: 'status', status: 'waterBreathing' },
  FreeAction: { support: 'tracked', kind: 'status', status: 'freeAction' },
  SpellResistance: { support: 'tracked', kind: 'status', status: 'spellResistance' },
  SpellReflection: { support: 'tracked', kind: 'status', status: 'spellReflection' },
  SpellAbsorption: { support: 'tracked', kind: 'status', status: 'spellAbsorption' },
  'Teleport-Effect': { support: 'applied', kind: 'recall' },
  Open: { support: 'tracked', kind: 'door', operation: 'open' },
  Lock: { support: 'tracked', kind: 'door', operation: 'lock' },
  SoulTrap: { support: 'tracked', kind: 'soulTrap', status: 'soulTrapped', harmful: true },
  Charm: { support: 'applied', kind: 'pacify', group: 'class', harmful: true },
  Identify: { support: 'applied', kind: 'identify' },
  'Detect-Enemy': { support: 'tracked', kind: 'status', status: 'detectEnemy' },
  'Detect-Magic': { support: 'tracked', kind: 'status', status: 'detectMagic' },
  'Detect-Treasure': { support: 'tracked', kind: 'status', status: 'detectTreasure' },
  ComprehendLanguages: { support: 'tracked', kind: 'status', status: 'comprehendLanguages' },
  MorphSelf: { support: 'applied', kind: 'morphSelf' },
};
for (const attribute of ATTRIBUTES) {
  BEHAVIOUR[`Fortify-${attribute}`] = { support: 'tracked', kind: 'fortify', attribute };
  BEHAVIOUR[`Drain-${attribute}`] = { support: 'applied', kind: 'drainAttribute', attribute, harmful: true };
  BEHAVIOUR[`Heal-${attribute}`] = { support: 'applied', kind: 'healAttribute', attribute };
  BEHAVIOUR[`Transfer-${attribute}`] = { support: 'applied', kind: 'transferAttribute', attribute, harmful: true };
}
for (const group of ['Animal', 'Undead', 'Humanoid', 'Daedra']) {
  BEHAVIOUR[`Pacify-${group}`] = { support: 'applied', kind: 'pacify', group: group.toLowerCase(), harmful: true };
}
for (const el of ['Fire', 'Frost', 'Poison', 'Shock', 'Magicka']) {
  BEHAVIOUR[`ElementalResistance-${el}`] = { support: 'tracked', kind: 'status', status: `resist${el}` };
}

// Why any remaining classic families are not available, shown in the spellbook.
const UNSUPPORTED_REASON = {};

function reasonFor(key) {
  if (UNSUPPORTED_REASON[key]) return UNSUPPORTED_REASON[key];
  const family = key.split('-')[0];
  return UNSUPPORTED_REASON[family] ?? 'not implemented';
}

const costs = (v) => (v ? { a: v[0], b: v[1], offset: v[2] ?? 0 } : null);
const label = (key) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replace('-', ': ').replace('Spell Points', 'Magicka');
const anyElement = /^(Paralyze|ContinuousDamage-|Damage-|Disintegrate|Drain-|SoulTrap|Silence|Charm)/;

/** Effect templates keyed by `type:subType` (subType -1 when unused). */
export const EFFECTS = new Map();
for (const [key, type, subType, school, flags, d, c, m, targets] of ROWS) {
  const b = BEHAVIOUR[key];
  EFFECTS.set(`${type}:${subType}`, Object.freeze({
    key, type, subType, school, name: label(key),
    targets: /^Dispel-(Undead|Daedra)$/.test(key) ? 'self' : targets,
    elements: anyElement.test(key) ? ['fire', 'cold', 'poison', 'shock', 'magic'] : ['magic'],
    duration: flags.includes('D'), chance: flags.includes('C'), magnitude: flags.includes('M'),
    spellMaker: key !== 'MorphSelf',
    showSpellIcon: !/^(?:CreateItem|Dispel-Magic|Lock|MorphSelf|Open|SoulTrap|Teleport)$|^(?:Drain|Transfer)-/.test(key),
    durationCosts: costs(d), chanceCosts: costs(c), magnitudeCosts: costs(m),
    support: b?.support ?? 'unsupported',
    behaviour: b ? Object.freeze({ ...b }) : null,
    reason: b ? null : reasonFor(key),
  }));
}

/** Look up an effect template by classic type/subType. */
export function effectTemplate(type, subType) {
  return EFFECTS.get(`${type}:${subType}`) ?? EFFECTS.get(`${type}:-1`) ?? null;
}
