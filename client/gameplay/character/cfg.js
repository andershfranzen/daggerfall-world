// CLASS*.CFG reader. Adapted from Daggerfall Unity API/ClassFile.cs and DFCareer.StructureData (MIT,
// Daggerfall Workshop) via daggerfall-js-source src/formats/classFile.js (MIT, Lattymoy). See NOTICE.txt.
// Reads a player- or operator-supplied file. No class data ships with this project.
//
// Record (little-endian, 74 bytes): u8 resist, immune, lowTol, critWeak; u16 ability|spellpoint bits;
// u8 rapidHealing, regeneration, unknown, spellAbsorption, attackModifier; u16 forbiddenMaterials;
// u8 expertise, u16 weapon/armor/shield restrictions; u8 x3 primary, x3 major, x6 minor skills; char[16] name;
// 8 unknown bytes; u16 hp per level; u32 16.16 advancement multiplier; u16 x8 attributes.

import { ADVANTAGES, ATTRIBUTES, SKILLS } from './rules.js';

export const CFG_RECORD_BYTES = 74;

// DFCareer.GetSpellPointMultiplier: (bits & 0x1C00) >> 8
const SPELL_POINT_MULTIPLIERS = { 0: 3.0, 4: 2.0, 8: 1.75, 12: 1.5, 16: 1.0, 20: 0.5 };
const EFFECTS = ['Paralysis', 'Magic', 'Poison', 'Fire', 'Frost', 'Shock', 'Disease'];
const WEAPONS = ['Short Blade', 'Long Blade', 'Hand-to-Hand', 'Axe', 'Blunt Weapon', 'Missile Weapons'];
const MATERIALS = ['Iron', 'Steel', 'Silver', 'Elven', 'Dwarven', 'Mithril', 'Adamantium', 'Ebony', 'Orcish', 'Daedric'];
const GROUPS = ['Undead', 'Daedra', 'Humanoid', 'Animals'];
const LIGHT = ['in light', 'in darkness', 'general'];

// Each entry maps the bytes and bits defined by DFCareer.SetFromCFG to the character sheet vocabulary.
const ABILITIES = [
  [0, 'resistance', EFFECTS], [8, 'immunity', EFFECTS],
  [16, 'lowTolerance', EFFECTS], [24, 'criticalWeakness', EFFECTS],
  [32, 'acuteHearing'], [33, 'athleticism'], [34, 'adrenalineRush'],
  [35, 'inabilityToRegen'], [36, 'damage', ['from sunlight', 'from holy places']],
  [38, 'lightPoweredMagery', ['unable to use magic in darkness', 'lower magic ability in darkness']],
  [40, 'darknessPoweredMagery', ['unable to use magic in daylight', 'lower magic ability in daylight']],
  [48, 'rapidHealing', LIGHT], [56, 'regenerateHealth', ['in light', 'in darkness', 'while immersed', 'general']],
  [72, 'spellAbsorption', LIGHT], [80, 'bonusToHit', GROUPS], [84, 'phobia', GROUPS],
  [88, 'forbiddenMaterial', MATERIALS], [104, 'expertiseIn', WEAPONS],
  [112, 'forbiddenWeaponry', WEAPONS], [118, 'forbiddenArmorType', ['Leather', 'Chain', 'Plate']],
  [121, 'forbiddenShieldTypes', ['Buckler', 'Round Shield', 'Kite Shield', 'Tower Shield']],
];

function visitAbilityBits(visit) {
  for (const [offset, key, options = [undefined]] of ABILITIES) {
    options.forEach((option, i) => {
      const bit = offset + i;
      visit(bit >> 3, 1 << (bit & 7), key, option);
    });
  }
}

const MAGERY_OPTION = { 3: '3x INT', 2: '2x INT', 1.75: '1.75x INT', 1.5: '1.5x INT', 1: '1x INT' };

/** @param {Uint8Array} bytes */
export function parseClassCfg(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < CFG_RECORD_BYTES) throw new Error('Not a CLASS*.CFG record.');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 16;
  const u8 = () => v.getUint8(o++);
  const u16 = () => { const x = v.getUint16(o, true); o += 2; return x; };
  const u32 = () => { const x = v.getUint32(o, true); o += 4; return x; };
  const skill = (id) => {
    const name = SKILLS[id];
    if (!name) throw new Error(`CLASS*.CFG names unknown skill id ${id}.`);
    return name;
  };
  const primarySkills = [u8(), u8(), u8()].map(skill);
  const majorSkills = [u8(), u8(), u8()].map(skill);
  const minorSkills = [u8(), u8(), u8(), u8(), u8(), u8()].map(skill);
  let name = '';
  for (let i = 0; i < 16; i++) name += String.fromCharCode(u8());
  name = name.split('\0')[0].trim();
  o += 8;
  const hitPointsPerLevel = u16();
  const advRaw = u32();
  const advancementMultiplier = Math.round(((advRaw >>> 16) + (advRaw & 0xffff) / 65536) * 100) / 100;
  const attributes = {};
  for (const a of ATTRIBUTES) attributes[a] = u16();
  const spellPointMultiplier = SPELL_POINT_MULTIPLIERS[bytes[5] & 0x1c] ?? 1.0;
  const advantages = [];
  const disadvantages = [];
  visitAbilityBits((byte, mask, key, option) => {
    if (!(bytes[byte] & mask)) return;
    const list = Object.hasOwn(ADVANTAGES, key) ? advantages : disadvantages;
    list.push(Object.freeze(option === undefined ? { key } : { key, option }));
  });
  if (MAGERY_OPTION[spellPointMultiplier]) advantages.push(Object.freeze({ key: 'increasedMagery', option: MAGERY_OPTION[spellPointMultiplier] }));
  if (!name || hitPointsPerLevel < 1 || hitPointsPerLevel > 100) throw new Error('CLASS*.CFG record is malformed.');
  return Object.freeze({
    name, hitPointsPerLevel, spellPointMultiplier, advancementMultiplier,
    attributes: Object.freeze(attributes),
    primarySkills: Object.freeze(primarySkills), majorSkills: Object.freeze(majorSkills), minorSkills: Object.freeze(minorSkills),
    advantages: Object.freeze(advantages), disadvantages: Object.freeze(disadvantages),
    noRegenMagicka: !!(bytes[4] & 8),
    source: 'cfg',
  });
}

/** Encodes a career back into a record. Used by tests and to hand a custom class to tools expecting the format. */
export function encodeClassCfg(career) {
  const b = new Uint8Array(CFG_RECORD_BYTES);
  const v = new DataView(b.buffer);
  const mulCode = Object.entries(SPELL_POINT_MULTIPLIERS).find(([, m]) => m === career.spellPointMultiplier)?.[0] ?? 16;
  b[5] = Number(mulCode);
  if (career.noRegenMagicka) b[4] |= 8;
  const abilities = [...(career.advantages ?? []), ...(career.disadvantages ?? [])];
  visitAbilityBits((byte, mask, key, option) => {
    if (abilities.some((a) => a.key === key && a.option === option)) b[byte] |= mask;
  });
  let o = 16;
  for (const s of [...career.primarySkills, ...career.majorSkills, ...career.minorSkills]) b[o++] = SKILLS.indexOf(s);
  for (let i = 0; i < 16; i++) b[o + i] = i < career.name.length ? career.name.charCodeAt(i) & 0x7f : 0;
  o += 16 + 8;
  v.setUint16(o, career.hitPointsPerLevel, true); o += 2;
  const m = career.advancementMultiplier;
  v.setUint32(o, ((Math.floor(m) << 16) | Math.round((m - Math.floor(m)) * 65536)) >>> 0, true); o += 4;
  for (const a of ATTRIBUTES) { v.setUint16(o, career.attributes[a], true); o += 2; }
  return b;
}

/** CLASS00.CFG … CLASS17.CFG, case-insensitive. */
export const CLASS_FILE_RE = /^class(\d\d)\.cfg$/i;
