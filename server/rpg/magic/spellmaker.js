// Classic Spell Maker settings and compatibility rules. Standard spells use their
// recorded settings, including legacy combinations the Maker would not allow.
import { randomUUID } from 'node:crypto';
import { makeSpell } from './catalogue.js';
import { EFFECTS } from './effects.js';
import { ELEMENTS, TARGET_TYPES } from './spells-std.js';

const templates = new Map([...EFFECTS.values()].map((template) => [template.key, template]));
const fields = {
  duration: [['durationBase', 'Base', 60], ['durationPlus', 'Increase', 60], ['durationPerLevel', 'Levels per increase', 20]],
  chance: [['chanceBase', 'Base %', 100], ['chancePlus', 'Increase %', 100], ['chancePerLevel', 'Levels per increase', 20]],
  magnitude: [
    ['magnitudeBaseMin', 'Base min', 100], ['magnitudeBaseMax', 'Base max', 100],
    ['magnitudePlusMin', 'Increase min', 100], ['magnitudePlusMax', 'Increase max', 100],
    ['magnitudePerLevel', 'Levels per increase', 20],
  ],
};

export function makerTemplates() {
  return [...templates.values()].filter((t) => t.support !== 'unsupported').map((t) => ({
    key: t.key, name: t.name, school: t.school, targets: t.targets, elements: t.elements,
    groups: Object.entries(fields).filter(([group]) => t[group]).map(([group, settings]) => ({
      group, fields: settings, costs: t[`${group}Costs`],
    })),
  }));
}

export function buildCustomSpell(draft, id = `custom:${randomUUID()}`) {
  const name = typeof draft.name === 'string' ? draft.name.trim().replace(/\s+/g, ' ') : '';
  if (!name || name.length > 32 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new Error('Enter a spell name of up to 32 characters.');
  const { element, targetType, icon = 0 } = draft;
  if (!ELEMENTS.includes(element) || !TARGET_TYPES.includes(targetType)) throw new Error('Choose an element and target.');
  if (!Number.isInteger(icon) || icon < 0 || icon >= 69) throw new Error('Choose a valid spell icon.');
  if (!Array.isArray(draft.effects) || !draft.effects.length || draft.effects.length > 3) throw new Error('Choose one to three effects.');
  const used = new Set();
  const effects = draft.effects.map((entry) => {
    const template = templates.get(entry?.key);
    if (!template || template.support === 'unsupported') throw new Error('That effect is unavailable in the Spell Maker.');
    if (used.has(template.key)) throw new Error('Each effect can appear only once.');
    used.add(template.key);
    if ((template.targets === 'self' && targetType !== 'caster') ||
        (template.targets === 'other' && targetType === 'caster') || !template.elements.includes(element)) {
      throw new Error(`${template.name} cannot use that element or target.`);
    }
    const settings = {};
    for (const [group, options] of Object.entries(fields)) {
      if (!template[group]) continue;
      for (const [key, label, max] of options) {
        const value = entry.settings?.[key] ?? 1;
        if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${label} must be between 1 and ${max}.`);
        settings[key] = value;
      }
    }
    if (settings.magnitudeBaseMin > settings.magnitudeBaseMax || settings.magnitudePlusMin > settings.magnitudePlusMax) {
      throw new Error('Each minimum magnitude must be at most its maximum.');
    }
    return { template, settings };
  });
  return makeSpell({ id, name, element, targetType, icon, effects, origin: 'Spell Maker' });
}

export function saveCustomSpell(spell) {
  const { id, name, element, targetType, icon } = spell;
  return { id, name, element, targetType, icon, effects: spell.effects.map(({ template, settings }) => ({ key: template.key, settings })) };
}
