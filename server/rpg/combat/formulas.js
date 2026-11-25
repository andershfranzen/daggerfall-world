// Classic Daggerfall melee and ranged combat rolls.
//
// Adapted from Daggerfall Unity (MIT License, Copyright (C) 2009-2023 Daggerfall
// Workshop): Assets/Scripts/Game/Formulas/FormulaHelper.cs (CalculateAttackDamage,
// CalculateSuccessfulHit and its component sub-formulas, weapon damage tables,
// swing modifiers, backstab), Items/DaggerfallUnityItem.cs (material modifiers,
// armour values, shield coverage), Game/EnemyAttack.cs (melee timer) and
// Game/WeaponManager.cs (reach, swing fatigue). Full licence text:
// ./THIRD_PARTY_NOTICES.txt.

/** WeaponMaterialTypes order; index is the classic material value. */
export const WEAPON_MATERIALS = ['iron', 'steel', 'silver', 'elven', 'dwarven', 'mithril', 'adamantium', 'ebony', 'orcish', 'daedric'];
const WEAPON_MATERIAL_MOD = [-1, 0, 0, 1, 2, 3, 3, 4, 5, 6];

/** WeaponManager.defaultWeaponReach and EnemyAttack.MeleeDistance (metres). */
export const MELEE_REACH = 2.25;
/** Server-side cap on hitscan arrow range (classic arrows are physical projectiles). */
export const BOW_RANGE = 40;
/** WeaponManager.swingWeaponFatigueLoss, in raw fatigue units (64 per displayed point). */
export const SWING_FATIGUE = 11 / 64;
const CLASSIC_FRAME_UPDATE = 980;

/**
 * Swing direction modifiers (CalculateSwingModifiers). Classic does not apply
 * them to unarmed attacks. Left/right strikes carry no modifier.
 */
export const SWINGS = Object.freeze({
  up: { toHit: 10, damage: -4 },
  downRight: { toHit: 5, damage: -2 },
  downLeft: { toHit: -5, damage: 2 },
  down: { toHit: -10, damage: 4 },
  left: { toHit: 0, damage: 0 },
  right: { toHit: 0, damage: 0 },
});

/** CalculateStruckBodyPart: Head 0, RightArm 1, LeftArm 2, Chest 3, Hands 4, Legs 5, Feet 6. */
const BODY_PARTS = [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 6];
export const BODY_PART_NAMES = Object.freeze(['head', 'rightArm', 'leftArm', 'chest', 'hands', 'legs', 'feet']);

export const rollRange = (min, max, random) => min + Math.floor(random() * (max - min + 1));
export const dice100 = (chance, random) => 1 + Math.floor(random() * 100) <= chance;

/**
 * Normalise an equipped weapon record from the inventory service
 * (`services.getEquippedWeapon`) into the fields the rolls need, or null for
 * hand-to-hand. Material index follows WeaponMaterialTypes (iron 0 ... daedric 9).
 */
export function weaponOf(item) {
  if (!item || item.template === 'unarmed' || !item.damage) return null;
  const materialIndex = Math.max(0, WEAPON_MATERIALS.indexOf(String(item.material ?? 'iron')));
  const base = String(item.base ?? '');
  return {
    name: item.name ?? 'weapon',
    skill: item.skill ?? 'Hand-to-Hand',
    min: Math.max(0, Math.trunc(item.damage.min) || 0),
    max: Math.max(0, Math.trunc(item.damage.max) || 0),
    material: WEAPON_MATERIALS[materialIndex],
    materialIndex,
    materialMod: WEAPON_MATERIAL_MOD[materialIndex],
    blunt: item.skill === 'Blunt Weapon',
    bow: item.weaponType === 'Bow' || item.skill === 'Archery',
    base,
  };
}

/**
 * To-hit armour values for the seven body parts from the inventory service's
 * per-part armour ratings (`services.getArmorValues`): unarmoured is 100 and
 * every armour point subtracts 5 (DaggerfallEntity.UpdateEquippedArmorValues).
 */
export function armorToHit(ratings) {
  return BODY_PART_NAMES.map((part) => 100 - 5 * (Number(ratings?.[part]) || 0));
}

export const damageModifier = (strength) => Math.floor((strength - 50) / 5);
export const handToHandMin = (skill) => Math.floor(skill / 10) + 1;
export const handToHandMax = (skill) => Math.floor(skill / 5) + 1;

/**
 * Seconds between a player's swings: a five-frame classic weapon animation at
 * GetMeleeWeaponAnimTime per frame. Speed 50 gives about one second.
 */
export function swingSeconds(speed, bow = false) {
  const frame = (3 * (115 - clampStat(speed))) / CLASSIC_FRAME_UPDATE;
  return frame * 5 * (bow ? 1.5 : 1);
}

/** EnemyAttack.ResetMeleeTimer in seconds, against a target of the given level and reflexes (0 best - 4 worst). */
export function monsterMeleeSeconds(targetLevel, reflexes, random) {
  let t = rollRange(1500, 3000, random);
  t -= 50 * (targetLevel - 10);
  t += 450 * (reflexes - 2);
  return Math.max(0, t) / CLASSIC_FRAME_UPDATE;
}

const clampStat = (v) => Math.max(1, Math.min(100, Number.isFinite(v) ? v : 50));

/**
 * CalculateSuccessfulHit. `attacker` and `target` are combat views:
 * { agility, luck, criticalStrike, dodging, armor:[7], monster:boolean }.
 */
export function successfulHit(attacker, target, chanceToHitMod, bodyPart, random) {
  let chance = chanceToHitMod;
  chance += target.armor[bodyPart] ?? 100;
  chance += Math.trunc((attacker.luck - target.luck) / 10) + Math.trunc((attacker.agility - target.agility) / 10);
  chance -= Math.trunc(target.dodging / 4);
  if (dice100(attacker.criticalStrike, random)) chance += Math.trunc(attacker.criticalStrike / 10);
  // CalculateAdrenalineRushToHit: the attacker's rush helps, the target's rush hinders.
  chance += attacker.adrenaline ?? 0;
  chance -= target.adrenaline ?? 0;
  chance += attacker.chanceToHit ?? 0; // attacker.ChanceToHitModifier
  if (target.monster) chance += 40;
  chance -= 50;
  chance = Math.max(3, Math.min(97, chance));
  return dice100(chance, random);
}

export const struckBodyPart = (random) => BODY_PARTS[Math.floor(random() * BODY_PARTS.length)];

/**
 * A player's weapon or hand-to-hand attack on a monster (CalculateAttackDamage
 * player branch). Returns { damage, hit, ineffective, skill, backstab }.
 */
export function playerAttack({ player, weapon, swing, monster, monsterView, facingAway, modifiers, random }) {
  if (weapon && monster.minMetal > weapon.materialIndex) {
    return { damage: 0, hit: false, ineffective: true, skill: weapon.skill };
  }
  const skill = weapon ? weapon.skill : 'Hand-to-Hand';
  let toHit = player.skill(skill) + (modifiers?.toHit ?? 0);
  let damageMod = modifiers?.damage ?? 0;
  if (weapon && swing) {
    toHit += swing.toHit;
    damageMod += swing.damage;
  }
  // Backstab: facing-away targets add the Backstabbing skill to hit and can triple damage.
  const backstab = facingAway ? player.skill('Backstabbing') : 0;
  toHit += backstab;
  if (weapon) toHit += weapon.materialMod * 10;
  const part = struckBodyPart(random);
  if (!successfulHit(player.view, monsterView, toHit, part, random)) {
    return { damage: 0, hit: false, skill, backstabbing: backstab > 0 };
  }
  let damage;
  if (weapon) {
    damage = rollRange(weapon.min, weapon.max, random) + damageMod;
    if (monster.id === 15) {
      // Skeletal Warrior: edged weapons halve damage, silver doubles it.
      if (!weapon.blunt) damage = Math.trunc(damage / 2);
      if (weapon.material === 'silver') damage *= 2;
    }
    damage += damageModifier(player.view.strength);
    damage += weapon.materialMod;
    if (damage < 1) damage = 0;
  } else {
    const h2h = player.skill('Hand-to-Hand');
    damage = rollRange(handToHandMin(h2h), handToHandMax(h2h), random) + damageMod + damageModifier(player.view.strength);
  }
  let backstabbed = false;
  if (backstab > 1 && dice100(backstab, random)) {
    damage *= 3;
    backstabbed = true;
  }
  return { damage: Math.max(0, damage), hit: true, skill, backstab: backstabbed, backstabbing: backstab > 0 };
}

/**
 * A monster's natural attack on a player (CalculateAttackDamage monster
 * branch): up to three claw/bite rolls, each gated by the target's Reflexes
 * and a to-hit roll. Returns { damage, hits }.
 */
export function monsterAttack({ monster, monsterView, playerView, reflexes, random }) {
  const toHit = monsterView.handToHand;
  const part = struckBodyPart(random);
  const reflexesChance = 50 - 10 * (reflexes - 2);
  let damage = 0;
  let hits = 0;
  for (const [min, max] of monster.attacks) {
    if (min > 0 && 1 + Math.floor(random() * 100) - 1 < reflexesChance && successfulHit(monsterView, playerView, toHit, part, random)) {
      const d = rollRange(min, max, random);
      if (d > 0) hits++;
      damage += d;
    }
  }
  return { damage, hits, part };
}
