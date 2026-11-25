// Privacy-safe public appearance & classic character figure projection for multiplayer peers.
// Pure ES module: no DOM, no I/O, no mutation of player state.
//
// Consumed by `server/rpg/runtime.js` (`publicPeer`) so nearby players receive enough
// visual metadata to render classic humanoid character figures and equipment silhouettes
// without exposing private character sheets, unequipped pack items, gold, quests, or stats.

import { CLOTH_DYES } from '../../client/gameplay/inventory/dyes.js';

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * Visually visible paper-doll / character equipment slots in deterministic order.
 * Matches the exact slot keys used by `server/rpg/inventory.js` (`rpg.equipment`),
 * plus `cloak2` for secondary cloak layering. Jewellery slots (`amulet0..mark1`)
 * are intentionally excluded.
 */
export const VISIBLE_EQUIP_SLOTS = Object.freeze([
  'head',
  'cloak',
  'cloak2',
  'chestArmor',
  'leftArm',
  'rightArm',
  'gloves',
  'legsArmor',
  'feet',
  'chestClothes',
  'legsClothes',
  'rightHand',
  'leftHand',
]);

/** Accepted slot key aliases mapped to canonical `VISIBLE_EQUIP_SLOTS` keys. */
export const SLOT_ALIASES = Object.freeze({
  hands: 'gloves',
  cloak1: 'cloak',
});

/** Canonical classic humanoid figure archetypes. */
export const ARCHETYPES = Object.freeze([
  'mage',
  'battlemage',
  'spellsword',
  'sorcerer',
  'healer',
  'nightblade',
  'bard',
  'thief',
  'rogue',
  'assassin',
  'archer',
  'ranger',
  'monk',
  'barbarian',
  'warrior',
  'knight',
]);

/** Ordered armor material tiers from unarmored (`none`) to `daedric`. */
export const ARMOR_TIERS = Object.freeze([
  'none',
  'leather',
  'chain',
  'iron',
  'steel',
  'silver',
  'elven',
  'dwarven',
  'mithril',
  'adamantium',
  'ebony',
  'orcish',
  'daedric',
]);

const ARMOR_TIER_RANK = Object.freeze(Object.fromEntries(ARMOR_TIERS.map((tier, i) => [tier, i])));

/** Standard 18 classic Daggerfall classes -> canonical figure archetype. */
const STANDARD_CLASS_ARCHETYPE = Object.freeze({
  mage: 'mage',
  spellsword: 'spellsword',
  battlemage: 'battlemage',
  sorcerer: 'sorcerer',
  healer: 'healer',
  nightblade: 'nightblade',
  bard: 'bard',
  burglar: 'thief',
  rogue: 'rogue',
  acrobat: 'rogue',
  thief: 'thief',
  assassin: 'assassin',
  monk: 'monk',
  archer: 'archer',
  ranger: 'ranger',
  barbarian: 'barbarian',
  warrior: 'warrior',
  knight: 'knight',
});

const MAGIC_SKILLS = new Set(['Destruction', 'Restoration', 'Illusion', 'Alteration', 'Thaumaturgy', 'Mysticism']);
const STEALTH_SKILLS = new Set(['Stealth', 'Lockpicking', 'Pickpocket', 'Climbing', 'Dodging']);
const ASSASSIN_SKILLS = new Set(['Backstabbing', 'Critical Strike', 'Short Blade', 'Stealth']);
const SOCIAL_SKILLS = new Set(['Etiquette', 'Streetwise', 'Mercantile']);
const WILDERNESS_SKILLS = new Set(['Stealth', 'Climbing', 'Swimming', 'Running']);
const HEAVY_WEAPON_SKILLS = new Set(['Axe', 'Blunt Weapon']);
const SHIELD_BASES = new Set(['buckler', 'round-shield', 'kite-shield', 'tower-shield']);
const BOW_BASES = new Set(['short-bow', 'long-bow']);
const DAGGER_BASES = new Set(['dagger', 'tanto']);
const BLUNT_BASES = new Set(['mace', 'flail', 'warhammer']);

function cleanText(value, maxLen = 40) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(CONTROL_RE, ' ').trim();
  if (!cleaned) return null;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

function clampInt(value, lo, hi, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(value)));
}

function sanitizeDoll(item) {
  const src = item?.doll;
  if (!src || typeof src !== 'object' || typeof src.set !== 'string') return null;
  const set = src.set;
  if (set === 'weapon') {
    const out = { set: 'weapon' };
    if (Number.isInteger(src.record)) out.record = src.record;
    if (Number.isInteger(src.drawOrder)) out.drawOrder = src.drawOrder;
    const dye = cleanText(src.dye, 20);
    if (dye) out.dye = dye;
    return out;
  }
  if (set === 'armor') {
    const out = { set: 'armor' };
    const variant = Array.isArray(src.variants) && src.variants.includes(item.variant) ? item.variant : null;
    const record = variant !== null && Number.isInteger(src.baseRecord)
      ? src.baseRecord + variant
      : src.record;
    if (Number.isInteger(record)) out.record = record;
    if (Number.isInteger(src.drawOrder)) out.drawOrder = src.drawOrder;
    const dye = cleanText(src.dye, 20);
    if (dye) out.dye = dye;
    return out;
  }
  if (set === 'clothing') {
    const out = { set: 'clothing' };
    if (Number.isInteger(src.male)) out.male = src.male;
    if (Number.isInteger(src.female)) out.female = src.female;
    if (Number.isInteger(src.drawOrder)) out.drawOrder = src.drawOrder;
    const dye = cleanText(src.dye, 20);
    if (dye) out.dye = dye;
    if (src.cloak === true) out.cloak = true;
    if (Number.isInteger(item.variant) && item.variant > 0) out.variant = item.variant;
    return out;
  }
  return null;
}

function projectSlotItem(item) {
  if (!item || typeof item !== 'object') return null;
  const template = cleanText(item.template, 64);
  if (!template) return null;

  const out = { template };
  const base = cleanText(item.base, 48);
  if (base) out.base = base;
  const group = cleanText(item.group, 24);
  if (group) out.group = group;
  const material = cleanText(item.material, 24);
  if (material) out.material = material;
  const dye = cleanText(item.dye, 24);
  if (dye) out.dye = dye;
  const skill = cleanText(item.skill, 32);
  if (skill) out.skill = skill;
  const name = cleanText(item.name, 64);
  if (name) out.name = name;
  const doll = sanitizeDoll(item);
  if (doll) out.doll = doll;
  return out;
}

function classifyWeaponKind(item) {
  if (!item || typeof item !== 'object') return 'none';
  if (item.group && item.group !== 'weapon') return 'none';
  const base = typeof item.base === 'string' ? item.base.toLowerCase() : '';
  const template = typeof item.template === 'string' ? item.template.toLowerCase() : '';
  const skill = typeof item.skill === 'string' ? item.skill : '';
  const weaponType = typeof item.weaponType === 'string' ? item.weaponType : '';

  if (BOW_BASES.has(base) || skill === 'Archery' || weaponType === 'Bow' || template.includes('bow')) return 'bow';
  if (base === 'staff' || weaponType === 'Staff' || template.endsWith('-staff') || template === 'staff') return 'staff';
  if (DAGGER_BASES.has(base) || weaponType === 'Dagger' || template.includes('dagger') || template.includes('tanto')) return 'dagger';
  if (skill === 'Axe' || weaponType === 'Battleaxe' || base.includes('axe') || template.includes('axe')) return 'axe';
  if (skill === 'Blunt Weapon' || BLUNT_BASES.has(base) || weaponType === 'Mace' || weaponType === 'Flail' || weaponType === 'Warhammer') return 'blunt';
  if (skill === 'Long Blade' || skill === 'Short Blade' || weaponType === 'LongBlade') return 'blade';
  return item.group === 'weapon' ? 'blade' : 'none';
}

function isRobeItem(item) {
  if (!item || typeof item !== 'object') return false;
  const base = typeof item.base === 'string' ? item.base.toLowerCase() : '';
  const template = typeof item.template === 'string' ? item.template.toLowerCase() : '';
  const name = typeof item.name === 'string' ? item.name.toLowerCase() : '';
  return base.includes('robe') || template.includes('robe') || name.includes('robe');
}

function isShieldItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.group === 'shield') return true;
  const base = typeof item.base === 'string' ? item.base.toLowerCase() : '';
  return SHIELD_BASES.has(base);
}

function normalizeDyeKey(dye) {
  const key = cleanText(dye, 24)?.toLowerCase() ?? null;
  if (!key) return null;
  return Object.hasOwn(CLOTH_DYES, key) ? key : key;
}

function resolveEquippedItems(rpg) {
  const eq = rpg?.equipment && typeof rpg.equipment === 'object' ? rpg.equipment : null;
  const inv = Array.isArray(rpg?.inventory) ? rpg.inventory : [];
  if (!eq) return {};

  const byId = new Map();
  for (const item of inv) {
    if (item && typeof item.id === 'string' && !byId.has(item.id)) byId.set(item.id, item);
  }

  // Build normalized slot -> raw item map (resolving aliases like `hands` -> `gloves`).
  const rawBySlot = Object.create(null);
  for (const slot of VISIBLE_EQUIP_SLOTS) {
    const ref = eq[slot];
    if (ref != null) {
      const item = typeof ref === 'string' ? byId.get(ref) : (typeof ref === 'object' ? ref : null);
      if (item) rawBySlot[slot] = item;
    }
  }
  for (const [alias, canonical] of Object.entries(SLOT_ALIASES)) {
    if (rawBySlot[canonical]) continue;
    const ref = eq[alias];
    if (ref == null) continue;
    const item = typeof ref === 'string' ? byId.get(ref) : (typeof ref === 'object' ? ref : null);
    if (item) rawBySlot[canonical] = item;
  }
  return rawBySlot;
}

/**
 * Projects `rpg.equipment` + `rpg.inventory` into a compact, privacy-safe `worn` map
 * keyed by canonical visible slot, plus summary silhouette fields.
 */
export function projectVisibleEquipment(rpg) {
  const rawBySlot = resolveEquippedItems(rpg);
  const worn = {};

  let highestArmorRank = 0;
  let hasRobe = false;
  let hasShield = false;

  for (const slot of VISIBLE_EQUIP_SLOTS) {
    const raw = rawBySlot[slot];
    if (!raw) continue;
    const projected = projectSlotItem(raw);
    if (!projected) continue;
    worn[slot] = projected;

    if (projected.group === 'armor') {
      const rank = ARMOR_TIER_RANK[projected.material] ?? 0;
      if (rank > highestArmorRank) highestArmorRank = rank;
    }
    if (isShieldItem(projected)) {
      hasShield = true;
      const rank = ARMOR_TIER_RANK[projected.material] ?? 0;
      if (rank > highestArmorRank) highestArmorRank = rank;
    }
    if (isRobeItem(projected)) hasRobe = true;
  }

  const armorTier = ARMOR_TIERS[highestArmorRank] ?? 'none';
  const wearingHeavyArmor = highestArmorRank >= ARMOR_TIER_RANK.chain;
  const wearingRobes = hasRobe; // a cloak over ordinary clothes is not a robe

  const primaryWeapon = rawBySlot.rightHand?.group === 'weapon'
    ? rawBySlot.rightHand
    : (rawBySlot.leftHand?.group === 'weapon' ? rawBySlot.leftHand : null);
  const weaponKind = classifyWeaponKind(primaryWeapon);

  const dyeCandidates = [
    worn.cloak?.dye,
    worn.cloak2?.dye,
    worn.chestClothes?.dye,
    worn.legsClothes?.dye,
    worn.feet?.group === 'clothing' ? worn.feet.dye : null,
  ];
  let primaryDye = null;
  for (const candidate of dyeCandidates) {
    const normalized = normalizeDyeKey(candidate);
    if (normalized) {
      primaryDye = normalized;
      break;
    }
  }

  return {
    worn,
    armorTier,
    wearingRobes,
    wearingHeavyArmor,
    hasShield,
    weaponKind,
    primaryDye,
  };
}

function summarizeWornForArchetype(wornItems) {
  if (!wornItems || typeof wornItems !== 'object') {
    return {
      weaponKind: 'none',
      wearingRobes: false,
      wearingHeavyArmor: false,
      hasShield: false,
    };
  }
  // Accept direct output of `projectVisibleEquipment(rpg)`.
  if ('weaponKind' in wornItems && 'wearingHeavyArmor' in wornItems && 'wearingRobes' in wornItems) {
    return {
      weaponKind: wornItems.weaponKind ?? 'none',
      wearingRobes: !!wornItems.wearingRobes,
      wearingHeavyArmor: !!wornItems.wearingHeavyArmor,
      hasShield: !!wornItems.hasShield,
    };
  }

  const entries = Array.isArray(wornItems)
    ? wornItems.map((item) => [null, item])
    : Object.entries(wornItems);

  let highestArmorRank = 0;
  let hasRobe = false;
  let hasShield = false;
  let weaponKind = 'none';

  for (const [slot, item] of entries) {
    if (!item || typeof item !== 'object') continue;
    if (item.group === 'armor') {
      const rank = ARMOR_TIER_RANK[item.material] ?? 0;
      if (rank > highestArmorRank) highestArmorRank = rank;
    }
    if (isShieldItem(item)) {
      hasShield = true;
      const rank = ARMOR_TIER_RANK[item.material] ?? 0;
      if (rank > highestArmorRank) highestArmorRank = rank;
    }
    if (isRobeItem(item)) hasRobe = true;
    if (item.group === 'weapon' && (slot === 'rightHand' || weaponKind === 'none')) {
      const kind = classifyWeaponKind(item);
      if (kind !== 'none') weaponKind = kind;
    }
  }

  const wearingHeavyArmor = highestArmorRank >= ARMOR_TIER_RANK.chain;
  const wearingRobes = hasRobe; // a cloak over ordinary clothes is not a robe
  return { weaponKind, wearingRobes, wearingHeavyArmor, hasShield };
}

function skillWeights(spec) {
  const weights = new Map();
  const add = (list, w) => {
    if (!Array.isArray(list)) return;
    for (const s of list) {
      if (typeof s === 'string') weights.set(s, (weights.get(s) ?? 0) + w);
    }
  };
  add(spec?.primarySkills, 3);
  add(spec?.majorSkills, 2);
  add(spec?.minorSkills, 1);
  return weights;
}

function sumMatching(weights, set) {
  let total = 0;
  for (const [skill, weight] of weights.entries()) {
    if (set.has(skill)) total += weight;
  }
  return total;
}

function hasAdvantage(spec, key, option) {
  const list = Array.isArray(spec?.advantages) ? spec.advantages : [];
  return list.some((a) => a && a.key === key && (option == null || a.option === option));
}

function hasDisadvantage(spec, key, option) {
  const list = Array.isArray(spec?.disadvantages) ? spec.disadvantages : [];
  return list.some((d) => d && d.key === key && (option == null || d.option === option));
}

/**
 * Classifies any character (standard or Custom class) into one of the 16 canonical
 * classic humanoid figure archetypes.
 */
export function inferArchetype(character, wornItems = null) {
  const ch = character && typeof character === 'object' ? character : {};
  const isCustom = !!(ch.custom || ch.career?.custom);

  if (!isCustom && typeof ch.className === 'string') {
    const mapped = STANDARD_CLASS_ARCHETYPE[ch.className.trim().toLowerCase()];
    if (mapped) return mapped;
  }

  const spec = ch.custom ?? (ch.career?.custom ? ch.career : ch.career) ?? null;
  const weights = skillWeights(spec);
  const gear = summarizeWornForArchetype(wornItems);

  const spellMul = Number(spec?.spellPointMultiplier) || 0;
  const hpPerLevel = Number(spec?.hitPointsPerLevel) || 0;
  const noRegen = !!spec?.noRegenMagicka || hasDisadvantage(spec, 'inabilityToRegen');
  const forbidsPlate = hasDisadvantage(spec, 'forbiddenArmorType', 'Plate');

  const magicSkillScore = sumMatching(weights, MAGIC_SKILLS);
  const mageryBonus = spellMul >= 2.0 ? 4 : spellMul >= 1.5 ? 2.5 : spellMul >= 1.0 ? 1 : 0;
  const magicScore = magicSkillScore + mageryBonus;

  const restorationScore = (weights.get('Restoration') ?? 0) + (weights.get('Medical') ?? 0);
  const destructionScore = weights.get('Destruction') ?? 0;
  const illusionScore = weights.get('Illusion') ?? 0;

  const archerySkillScore = weights.get('Archery') ?? 0;
  const archeryScore = archerySkillScore + (gear.weaponKind === 'bow' ? 4 : 0);

  const stealthScore = sumMatching(weights, STEALTH_SKILLS);
  const assassinScore = sumMatching(weights, ASSASSIN_SKILLS) + (gear.weaponKind === 'dagger' ? 2 : 0);
  const socialScore = sumMatching(weights, SOCIAL_SKILLS);
  const wildernessScore = sumMatching(weights, WILDERNESS_SKILLS);

  const bladeScore = (weights.get('Long Blade') ?? 0) + (gear.weaponKind === 'blade' ? 2 : 0);
  const heavyWeaponScore = sumMatching(weights, HEAVY_WEAPON_SKILLS)
    + (gear.weaponKind === 'axe' || gear.weaponKind === 'blunt' ? 2 : 0);
  const unarmedScore = (weights.get('Hand-to-Hand') ?? 0)
    + (weights.get('Dodging') ?? 0)
    + (weights.get('Critical Strike') ?? 0)
    + (hasAdvantage(spec, 'expertiseIn', 'Hand-to-Hand') ? 3 : 0);

  const hasMeleeFocus = bladeScore >= 2 || heavyWeaponScore >= 2 || gear.wearingHeavyArmor
    || gear.weaponKind === 'blade' || gear.weaponKind === 'axe' || gear.weaponKind === 'blunt';

  // 1. Archery / Ranger
  if (archeryScore >= 4 || (archerySkillScore >= 3 && magicScore < 5)) {
    if ((bladeScore >= 2 || heavyWeaponScore >= 2) && wildernessScore >= 3) return 'ranger';
    return 'archer';
  }

  // 2. Magic & Hybrid Spellcasters
  const isSpellcaster = magicScore >= 4.5
    || (magicSkillScore >= 3 && (gear.wearingRobes || gear.weaponKind === 'staff'))
    || (spellMul >= 1.5 && magicSkillScore >= 2);

  if (isSpellcaster) {
    if ((stealthScore >= 3 || assassinScore >= 4) && (illusionScore >= 2 || (weights.get('Backstabbing') ?? 0) >= 2)) {
      return 'nightblade';
    }
    if (hasMeleeFocus && !gear.wearingRobes && gear.weaponKind !== 'staff') {
      const battlemageLean = destructionScore >= 3
        && (gear.wearingHeavyArmor || (weights.get('Axe') ?? 0) >= 2 || spellMul >= 1.75)
        && restorationScore < 3;
      return battlemageLean ? 'battlemage' : 'spellsword';
    }
    if (noRegen || spellMul >= 2.5 || hasAdvantage(spec, 'spellAbsorption')) return 'sorcerer';
    if (restorationScore >= 4 && destructionScore < 3) return 'healer';
    return 'mage';
  }

  // 3. Stealth / Subterfuge / Assassin / Bard
  const hasBackstabPrimary = (weights.get('Backstabbing') ?? 0) >= 2;
  const hasLockOrPick = (weights.get('Lockpicking') ?? 0) >= 2 || (weights.get('Pickpocket') ?? 0) >= 2;

  if (assassinScore >= 5 || (hasBackstabPrimary && ((weights.get('Short Blade') ?? 0) >= 2 || gear.weaponKind === 'dagger'))) {
    return 'assassin';
  }
  if (socialScore >= 5 && (illusionScore >= 1 || (weights.get('Short Blade') ?? 0) >= 2 || magicScore >= 1)) {
    return 'bard';
  }
  if (stealthScore >= 4 || hasLockOrPick) {
    if (hasLockOrPick) return 'thief';
    if (bladeScore >= 2 || (weights.get('Streetwise') ?? 0) >= 2) return 'rogue';
    return 'thief';
  }
  if (socialScore >= 5) return 'bard';

  // 4. Unarmed / Monk
  if (unarmedScore >= 5 && !gear.wearingHeavyArmor && (gear.weaponKind === 'none' || gear.weaponKind === 'staff')) {
    return 'monk';
  }

  // 5. Equipment-driven cues when custom skills are light or absent
  if (gear.weaponKind === 'bow') return 'archer';
  if (gear.wearingRobes || gear.weaponKind === 'staff') return 'mage';

  // 6. Heavy / Martial
  const etiquetteScore = weights.get('Etiquette') ?? 0;
  if ((gear.wearingHeavyArmor && gear.hasShield)
    || (!forbidsPlate && etiquetteScore >= 2 && (bladeScore >= 2 || heavyWeaponScore >= 2))
    || (gear.wearingHeavyArmor && restorationScore >= 2 && bladeScore >= 2)) {
    return 'knight';
  }

  if (gear.weaponKind === 'dagger' && !gear.wearingHeavyArmor && bladeScore < 3 && heavyWeaponScore < 3) {
    return 'assassin';
  }

  if ((hpPerLevel >= 22 && !gear.wearingHeavyArmor && !gear.hasShield)
    || (heavyWeaponScore >= 4 && !gear.wearingHeavyArmor && !gear.hasShield && forbidsPlate)) {
    return 'barbarian';
  }

  if (gear.weaponKind === 'axe' && !gear.wearingHeavyArmor && !gear.hasShield && heavyWeaponScore >= 2) {
    return 'barbarian';
  }

  return 'warrior';
}

/**
 * Projects a player record `p` (or `rpg` state) into clean, privacy-safe public appearance
 * fields + a `figure` descriptor ready to merge into `publicPeer(p)`.
 *
 * STRICT PRIVACY: Never includes unequipped bag items, gold, attributes, skills, quests,
 * accountId, enchantments, charges, or private stats.
 */
export function projectPeerFigure(p, { guildTitle, orderTag } = {}) {
  const rpg = p?.rpg && typeof p.rpg === 'object' ? p.rpg : (p && typeof p === 'object' ? p : {});
  const ch = rpg.character && typeof rpg.character === 'object' ? rpg.character : null;

  const equip = projectVisibleEquipment(rpg);
  const archetype = inferArchetype(ch, equip);

  const race = cleanText(ch?.race, 40);
  const gender = cleanText(ch?.gender, 16);
  const className = cleanText(ch?.className, 40);
  const faceIndex = clampInt(ch?.faceIndex, 0, 9, 0);
  const level = Number.isFinite(ch?.level) && ch.level >= 1 ? clampInt(ch.level, 1, 100, 1) : null;
  const cleanOrderTag = cleanText(orderTag, 12);
  const cleanGuildTitle = cleanText(guildTitle, 48);

  const out = {};
  if (race) out.race = race;
  if (gender) out.gender = gender;
  if (className) out.className = className;
  out.faceIndex = faceIndex;
  if (level !== null) out.level = level;
  out.archetype = archetype;
  if (cleanOrderTag) out.orderTag = cleanOrderTag;
  if (cleanGuildTitle) out.guildTitle = cleanGuildTitle;

  out.figure = {
    archetype,
    armorTier: equip.armorTier,
    wearingRobes: equip.wearingRobes,
    wearingHeavyArmor: equip.wearingHeavyArmor,
    hasShield: equip.hasShield,
    weaponKind: equip.weaponKind,
    primaryDye: equip.primaryDye,
    worn: equip.worn,
  };

  return out;
}
