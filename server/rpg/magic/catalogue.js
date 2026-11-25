// Builds the server spell catalogue: the operator's SPELLS.STD when ARENA2 is available, otherwise
// a small set of original spells assembled from the same effect templates.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseSpellsStd, TARGET_TYPES, ELEMENTS } from './spells-std.js';
import { effectTemplate } from './effects.js';
import { spellCosts } from './formulas.js';

/** DFU ClassicEffectRecordToEffectSettings: per-level divisors are clamped to at least 1. */
function settingsFromRecord(r) {
  return {
    durationBase: r.durationBase, durationPlus: r.durationMod, durationPerLevel: Math.max(1, r.durationPerLevel),
    chanceBase: r.chanceBase, chancePlus: r.chanceMod, chancePerLevel: Math.max(1, r.chancePerLevel),
    magnitudeBaseMin: r.magnitudeBaseLow, magnitudeBaseMax: r.magnitudeBaseHigh,
    magnitudePlusMin: r.magnitudeLevelBase, magnitudePlusMax: r.magnitudeLevelHigh,
    magnitudePerLevel: Math.max(1, r.magnitudePerLevel),
  };
}

function supportOf(effects) {
  const usable = effects.filter((e) => e.template.support !== 'unsupported').length;
  if (usable === effects.length) return effects.every((e) => e.template.support === 'applied') ? 'full' : 'tracked';
  return usable ? 'partial' : 'unsupported';
}

export function makeSpell({ id, name, index = null, element, targetType, icon = 0, listPrice = null, effects, origin, hidden = false }) {
  const spell = { id, name, index, element, targetType, icon, origin, hidden, effects };
  spell.support = supportOf(effects);
  spell.baseCosts = spellCosts(spell, () => 0);
  spell.price = listPrice ?? spell.baseCosts.gold;
  spell.harmful = effects.some((e) => e.template.behaviour?.harmful);
  spell.schools = [...new Set(effects.map((e) => e.template.school))];
  return spell;
}

/** Convert parsed SPELLS.STD records into spells. */
export function spellsFromStd(records) {
  const seen = new Map();
  const out = [];
  for (const rec of records) {
    const effects = [];
    rec.effects.forEach((raw, slot) => {
      if (raw.type < 0) return;
      let { type, subType } = raw;
      // DFU runtime fix: Free Action (index 10) slot 0 wrongly references Cure Paralyzation.
      if (rec.index === 10 && slot === 0 && type === 3 && subType === 2) { type = 26; subType = -1; }
      const template = effectTemplate(type, subType);
      if (template) effects.push({ template, settings: settingsFromRecord(raw), type, subType });
      else effects.push({ template: unknownTemplate(type, subType), settings: settingsFromRecord(raw), type, subType });
    });
    if (!effects.length) continue;
    const n = seen.get(rec.index) ?? 0;
    seen.set(rec.index, n + 1);
    const id = n ? `std:${rec.index}.${n}` : `std:${rec.index}`;
    const spell = makeSpell({
      id,
      name: rec.name.replace(/^!/, ''),
      index: rec.index,
      element: ELEMENTS[rec.element] ?? 'magic',
      // Null Magicka is recorded as Touch, but its classic picker dispels a spell on the caster.
      targetType: rec.index === 59 && effects.some((e) => e.template.key === 'Dispel-Magic')
        ? 'caster' : TARGET_TYPES[rec.rangeType] ?? 'caster',
      icon: rec.icon,
      listPrice: rec.cost || null,
      effects,
      origin: 'SPELLS.STD',
      hidden: rec.name.startsWith('!'),
    });
    // The unmodified record (GetClassicSpellRecord) for classic cost formulas; not sent to clients or saves.
    Object.defineProperty(spell, 'classic', { value: Object.freeze({ rangeType: rec.rangeType, effects: rec.effects }), enumerable: false });
    out.push(spell);
  }
  return out;
}

function unknownTemplate(type, subType) {
  return Object.freeze({ key: `Classic-${type}-${subType}`, type, subType, school: 'Mysticism', name: `Unknown effect ${type}/${subType}`,
    targets: 'all', duration: false, chance: false, magnitude: false, support: 'unsupported', behaviour: null,
    reason: 'unknown classic effect type' });
}

const S = (o) => ({ durationBase: 1, durationPlus: 1, durationPerLevel: 1, chanceBase: 1, chancePlus: 1, chancePerLevel: 1,
  magnitudeBaseMin: 1, magnitudeBaseMax: 1, magnitudePlusMin: 1, magnitudePlusMax: 1, magnitudePerLevel: 1, ...o });
const fx = (type, subType, settings) => ({ template: effectTemplate(type, subType), settings: S(settings), type, subType });

/** Original fallback spells (names and tunings are this project's own). */
export function fallbackSpells() {
  const list = [
    ['ward:ember-dart', 'Ember Dart', 'fire', 'singleAtRange', [fx(4, 0, { magnitudeBaseMin: 2, magnitudeBaseMax: 8, magnitudePlusMin: 1, magnitudePlusMax: 3 })]],
    ['ward:static-palm', 'Static Palm', 'shock', 'touch', [fx(4, 0, { magnitudeBaseMin: 4, magnitudeBaseMax: 12, magnitudePlusMin: 1, magnitudePlusMax: 4 })]],
    ['ward:hoarfrost-ring', 'Hoarfrost Ring', 'cold', 'areaAroundCaster', [fx(4, 0, { magnitudeBaseMin: 3, magnitudeBaseMax: 9, magnitudePlusMin: 1, magnitudePlusMax: 2 })]],
    ['ward:mending', 'Mending', 'magic', 'caster', [fx(10, 8, { magnitudeBaseMin: 5, magnitudeBaseMax: 12, magnitudePlusMin: 1, magnitudePlusMax: 4 })]],
    ['ward:knit-flesh', 'Knit Flesh', 'magic', 'touch', [fx(10, 8, { magnitudeBaseMin: 4, magnitudeBaseMax: 10, magnitudePlusMin: 1, magnitudePlusMax: 3 })]],
    ['ward:second-wind', 'Second Wind', 'magic', 'caster', [fx(10, 9, { magnitudeBaseMin: 8, magnitudeBaseMax: 16, magnitudePlusMin: 2, magnitudePlusMax: 2 })]],
    ['ward:slow-rot', 'Slow Rot', 'poison', 'singleAtRange', [fx(1, 0, { durationBase: 3, durationPlus: 1, magnitudeBaseMin: 1, magnitudeBaseMax: 3, magnitudePlusMin: 1, magnitudePlusMax: 1 })]],
    ['ward:bark-skin', 'Bark Skin', 'magic', 'caster', [fx(9, 4, { durationBase: 4, durationPlus: 1, magnitudeBaseMin: 5, magnitudeBaseMax: 10, magnitudePlusMin: 1, magnitudePlusMax: 2 })]],
    ['ward:still-water', 'Still Water', 'magic', 'touch', [fx(0, -1, { durationBase: 2, durationPlus: 1, chanceBase: 20, chancePlus: 3 })]],
    ['ward:soothing-rain', 'Soothing Rain', 'magic', 'caster', [fx(18, -1, { durationBase: 4, durationPlus: 1, magnitudeBaseMin: 1, magnitudeBaseMax: 2, magnitudePlusMin: 1, magnitudePlusMax: 1 })]],
  ];
  return list.map(([id, name, element, targetType, effects]) => makeSpell({ id, name, element, targetType, effects, origin: 'built-in' }));
}

/** Class starting spells (spell indices), from DFU Resources/StartingSpells.txt (MIT). */
export const STARTING_SPELLS = {
  Mage: [1, 37, 2, 97, 8], Spellsword: [8, 44, 37], Battlemage: [8, 2, 37], Sorcerer: [1, 37, 2, 97, 8],
  Healer: [97, 2, 1, 37], Nightblade: [44, 2], Bard: [37],
};
export const FALLBACK_STARTING = ['ward:ember-dart', 'ward:mending'];

function findFile(dir, name) {
  if (!dir || !existsSync(dir)) return null;
  const direct = join(dir, name);
  if (existsSync(direct)) return direct;
  const hit = readdirSync(dir).find((f) => f.toUpperCase() === name);
  if (hit) return join(dir, hit);
  const sub = readdirSync(dir).find((f) => f.toUpperCase() === 'ARENA2');
  return sub ? findFile(join(dir, sub), name) : null;
}

/** Load the catalogue. Returns { spells: Map, source, coverage, error? }. */
export function loadCatalogue({ arena2Dir = null, spellsStd = null } = {}) {
  let spells;
  let source;
  let error = null;
  try {
    const bytes = spellsStd ?? (findFile(arena2Dir, 'SPELLS.STD') && readFileSync(findFile(arena2Dir, 'SPELLS.STD')));
    if (bytes) {
      spells = spellsFromStd(parseSpellsStd(bytes));
      source = 'SPELLS.STD';
    }
  } catch (err) {
    error = `SPELLS.STD could not be read: ${err.message}`;
  }
  if (!spells?.length) {
    spells = fallbackSpells();
    source = 'built-in';
  }
  const map = new Map(spells.map((s) => [s.id, s]));
  const coverage = { total: spells.length, full: 0, tracked: 0, partial: 0, unsupported: 0, hidden: 0 };
  for (const s of spells) { coverage[s.support]++; if (s.hidden) coverage.hidden++; }
  return { spells: map, source, coverage, error };
}

/** Starting spell ids for a class in this catalogue. */
export function startingSpellIds(catalogue, className) {
  if (catalogue.source !== 'SPELLS.STD') return FALLBACK_STARTING.filter((id) => catalogue.spells.has(id));
  const indices = STARTING_SPELLS[className] ?? [];
  return indices.map((i) => `std:${i}`).filter((id) => catalogue.spells.has(id));
}
