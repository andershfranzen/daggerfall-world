// Classic human class enemies: careers, levelled health, starting equipment, armour and attacks.
//
// Adapted from Daggerfall Unity (MIT License, Copyright (C) 2009-2023 Daggerfall Workshop):
//   Game/Entities/EnemyEntity.cs      SetEnemyCareer (class branch), SetEnemyEquipment (armour clamp to 60)
//   Game/Formulas/FormulaHelper.cs    RollEnemyClassMaxHealth, RandomMaterial, RandomArmorMaterial,
//                                     CalculateAttackDamage / CalculateWeaponAttackDamage (enemy branch)
//   Game/Items/ItemHelper.cs          AssignEnemyStartingEquipment
//   Game/Items/ItemBuilder.cs         materialsByModifier
//   Game/Items/DaggerfallUnityItem.cs GetMaterialArmorValue, GetShieldArmorValue, GetShieldProtectedBodyParts
//   Game/EnemyAttack.cs / EnemyMotor.cs  bow range 6-51.2 m, 1/32 shot chance per classic update (1/16 s)
// Full licence text: ./THIRD_PARTY_NOTICES.txt.
//
// Careers come from the operator's CLASS00-17.CFG through the character feature's loader; without
// game data the character ruleset's approximate fallback careers are used and `careerSource` says so.

import { CLASSES } from '../../../client/gameplay/character/rules.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadCareers } from '../character.js';
import { parseMonsterCfg } from './careers.js';
import {
  WEAPON_MATERIALS,
  damageModifier,
  dice100,
  handToHandMax,
  handToHandMin,
  rollRange,
  struckBodyPart,
  successfulHit,
} from './formulas.js';

/** ItemBuilder.materialsByModifier, iron..daedric. */
const MATERIALS_BY_MODIFIER = [64, 128, 10, 21, 13, 8, 5, 3, 2, 5];
const WEAPON_MATERIAL_MOD = [-1, 0, 0, 1, 2, 3, 3, 4, 5, 6];
const PLATE_ARMOR = [7, 9, 9, 11, 13, 15, 15, 17, 19, 21];

/** Classic weapon base damage (CalculateWeaponMin/MaxDamage) and skill, keyed by inventory template base. */
export const CLASS_WEAPONS = Object.freeze({
  dagger: { name: 'Dagger', min: 1, max: 6, skill: 'Short Blade' },
  tanto: { name: 'Tanto', min: 1, max: 8, skill: 'Short Blade' },
  staff: { name: 'Staff', min: 1, max: 8, skill: 'Blunt Weapon' },
  shortsword: { name: 'Shortsword', min: 1, max: 8, skill: 'Short Blade' },
  broadsword: { name: 'Broadsword', min: 1, max: 12, skill: 'Long Blade' },
  saber: { name: 'Saber', min: 3, max: 12, skill: 'Long Blade' },
  longsword: { name: 'Longsword', min: 2, max: 16, skill: 'Long Blade' },
  katana: { name: 'Katana', min: 3, max: 16, skill: 'Long Blade' },
  claymore: { name: 'Claymore', min: 2, max: 18, skill: 'Long Blade' },
  'dai-katana': { name: 'Dai-katana', min: 3, max: 21, skill: 'Long Blade' },
  mace: { name: 'Mace', min: 1, max: 12, skill: 'Blunt Weapon' },
  flail: { name: 'Flail', min: 2, max: 14, skill: 'Blunt Weapon' },
  warhammer: { name: 'Warhammer', min: 3, max: 18, skill: 'Blunt Weapon' },
  'battle-axe': { name: 'Battle Axe', min: 2, max: 12, skill: 'Axe' },
});
// Weapons enum ranges used by AssignEnemyStartingEquipment.
const VARIANT0_WEAPONS = ['broadsword', 'saber', 'longsword']; // Broadsword(118)..Longsword(120)
const VARIANT1_WEAPONS = ['claymore', 'dai-katana', 'mace', 'flail', 'warhammer', 'battle-axe']; // Claymore(122)..Battle_Axe(127)
const OFFHAND_WEAPONS = ['dagger', 'tanto', 'staff', 'shortsword']; // Dagger(113)..Shortsword(116)

/** Bow range (EnemyAttack.min/maxRangedDistance) and the per-second chance from 1/32 per 1/16 s update. */
export const BOW_MIN_RANGE = 6;
export const BOW_MAX_RANGE = 51.2;
export const CLASSIC_UPDATE_S = 0.0625;
export const BOW_SHOT_CHANCE = 1 / 32;

/** FormulaHelper.RandomMaterial: index into WEAPON_MATERIALS. */
export function randomMaterial(level, random) {
  let levelModifier = level - 10;
  levelModifier *= levelModifier >= 0 ? 2 : 4;
  let combined = Math.max(0, Math.min(256, levelModifier + Math.floor(random() * 256)));
  let material = 0;
  while (material < MATERIALS_BY_MODIFIER.length - 1 && MATERIALS_BY_MODIFIER[material] < combined) {
    combined -= MATERIALS_BY_MODIFIER[material++];
  }
  return material;
}

/** FormulaHelper.RandomArmorMaterial: 'leather' | 'chain' | a plate metal name. */
export function randomArmorMaterial(level, random) {
  const roll = 1 + Math.floor(random() * 100);
  if (roll >= 90) return WEAPON_MATERIALS[randomMaterial(level, random)];
  if (roll >= 70) return 'chain';
  return 'leather';
}

const armorValueOf = (material) => (material === 'leather' ? 3 : material === 'chain' ? 6 : PLATE_ARMOR[WEAPON_MATERIALS.indexOf(material)] ?? 0);

/** FormulaHelper.RollEnemyClassMaxHealth: 10 + level rolls of 1..hpPerLevel. */
export function rollClassHealth(level, hitPointsPerLevel, random) {
  let hp = 10;
  for (let i = 0; i < level; i++) hp += rollRange(1, Math.max(1, hitPointsPerLevel), random);
  return hp;
}

/**
 * ItemHelper.AssignEnemyStartingEquipment for a class enemy, then SetEnemyEquipment's armour values.
 * Boots are generated but, as in DFU's loop (Head..Feet exclusive), do not count towards armour.
 * Returns { weapon:{base,material,materialIndex,materialMod,min,max,skill,name}, items:[templates], armor:[7] }.
 */
export function rollEquipment(level, random, opts = {}) {
  // SetEnemyEquipment(Random.Range(0, 2)) for classes; orcs, centaurs and the warlord pass their fixed variant.
  const variant = Number.isInteger(opts.variant) ? opts.variant : Math.floor(random() * 2);
  const items = [];
  const armor = [100, 100, 100, 100, 100, 100, 100];
  const pickWeapon = (list) => {
    const base = list[Math.floor(random() * list.length)];
    const materialIndex = randomMaterial(level, random);
    items.push(`${WEAPON_MATERIALS[materialIndex]}-${base}`);
    const w = CLASS_WEAPONS[base];
    return { base, ...w, material: WEAPON_MATERIALS[materialIndex], materialIndex, materialMod: WEAPON_MATERIAL_MOD[materialIndex], blunt: w.skill === 'Blunt Weapon' };
  };
  let weapon;
  let chance;
  if (variant === 0) {
    weapon = pickWeapon(VARIANT0_WEAPONS);
    chance = 50;
    const shield = random() < 0.5 ? 'buckler' : 'round-shield'; // Buckler(109)..Round_Shield(110)
    if (dice100(chance, random)) {
      items.push(shield);
      // Shield values ignore material: buckler 1 on left arm and hands; round shield 2 also on legs.
      const [value, parts] = shield === 'buckler' ? [1, [2, 4]] : [2, [2, 4, 5]];
      for (const p of parts) armor[p] -= value * 5;
    } else if (dice100(chance, random)) {
      const base = OFFHAND_WEAPONS[Math.floor(random() * OFFHAND_WEAPONS.length)];
      items.push(`${WEAPON_MATERIALS[randomMaterial(level, random)]}-${base}`);
    }
  } else {
    weapon = pickWeapon(VARIANT1_WEAPONS);
    chance = variant === 2 ? 90 : 75;
  }
  // helm, right pauldron, left pauldron, cuirass, greaves, boots → body part (or none for boots)
  for (const [piece, part] of [['helm', 0], ['right-pauldron', 1], ['left-pauldron', 2], ['cuirass', 3], ['greaves', 5], ['boots', -1]]) {
    if (!dice100(chance, random)) continue;
    const material = randomArmorMaterial(level, random);
    items.push(`${material}-${piece}`);
    if (part >= 0) armor[part] -= armorValueOf(material) * 5;
  }
  if (Number.isFinite(opts.monsterArmor)) {
    // Monsters keep the better of their definition (ArmorValue * 5) and their equipment.
    for (let i = 0; i < 7; i++) if (armor[i] > opts.monsterArmor) armor[i] = opts.monsterArmor;
  } else {
    for (let i = 0; i < 7; i++) if (armor[i] > 60) armor[i] = 60; // class enemies clamp to 60
  }
  return { weapon, items, armor, variant };
}

export const CITY_WATCH_CAREER = 18;

/** Career for a class enemy (CLASSnn.CFG when available). Cached per data path. */
export function careerResolver(dataPath, log) {
  let careers = null;
  let watch;
  return (careerIndex) => {
    if (careerIndex === CITY_WATCH_CAREER) {
      // Knight_CityWatch uses CLASS18.CFG, which is not a player class; only the operator's file can supply it.
      // Its skill list names id 35 (no such skill), so only the enemy fields are read (skills are level*5+30).
      if (watch === undefined) {
        watch = null;
        try {
          const f = dataPath && readdirSync(dataPath).find((n) => n.toUpperCase() === 'CLASS18.CFG');
          if (f) watch = { career: parseMonsterCfg(new Uint8Array(readFileSync(join(dataPath, f)))), source: 'cfg' };
        } catch (err) {
          log?.warn?.(`[combat] CLASS18.CFG: ${err.message}`);
        }
      }
      return watch;
    }
    careers ??= loadCareers(dataPath, log ?? { warn() {} });
    const std = CLASSES[careerIndex];
    const c = std ? careers[std.name] : null;
    return c ? { career: c, source: c.source === 'cfg' ? 'cfg' : 'fallback' } : null;
  };
}

/**
 * A class enemy's weapon attack on a player (CalculateAttackDamage, enemy-class branch): to-hit is
 * the weapon skill (level*5+30) plus the material modifier x10; damage is the weapon roll plus the
 * strength modifier and material modifier. Weaponless classes use hand-to-hand without strength.
 */
export function classAttack({ attackerView, skill, weapon, targetView, random }) {
  const part = struckBodyPart(random);
  let toHit = skill;
  if (weapon) toHit += weapon.materialMod * 10;
  if (!successfulHit(attackerView, targetView, toHit, part, random)) return { damage: 0, hit: false, part };
  let damage;
  if (weapon) {
    damage = rollRange(weapon.min, weapon.max, random) + damageModifier(attackerView.strength) + weapon.materialMod;
    if (damage < 1) damage = 0;
  } else {
    damage = rollRange(handToHandMin(skill), handToHandMax(skill), random);
  }
  return { damage: Math.max(0, damage), hit: damage > 0, part };
}
