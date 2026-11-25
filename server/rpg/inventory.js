// Inventory, equipment, gold and loot for the shared-world gameplay runtime.
// Owns rpg.inventory, rpg.equipment, rpg.gold and rpg.weaponView (see docs/gameplay-protocol.md
// and client/gameplay/inventory/CONTRACT.md).
//
// Item statistics, material multipliers, hand rules, weapon animation files and
// armour values are adapted from Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall
// Workshop): Assets/Resources/ItemTemplates.txt, Game/Items/ItemBuilder.cs,
// Game/Items/DaggerfallUnityItem.cs, Game/Items/ItemEquipTable.cs,
// Game/Items/ItemHelper.cs, Game/Formulas/FormulaHelper.cs and
// Utility/WeaponBasics.cs. Only numeric facts and file *names* are recorded here;
// all art is read in the browser from the player's own game files.

import { randomBytes } from 'node:crypto';
import { itemArt, LOOT_HEAP_SPRITE } from '../../client/gameplay/inventory/images.js';
import { CLOTH_DYES, METAL_DYES } from '../../client/gameplay/inventory/dyes.js';
import { maxEncumbrance } from '../../client/gameplay/inventory/weight.js';

import { TEMPLATE_ROWS, GROUPS as CLASSIC_GROUPS } from './items/classicTemplates.js';
import { createBookLibrary } from './items/books.js';
import { isMapItem, createMapReader } from './items/mapItem.js';

export { CLOTH_DYES, METAL_DYES, maxEncumbrance };

export const INVENTORY_VERSION = 2; // 1: sample kit, 2: starter clothing
export const MAX_STACK = 9999;
export const MAX_ITEMS = 200;
export const LOOT_REACH = 3.5; // metres
export const LOOT_LIFETIME_MS = 10 * 60_000;
export const GOLD_PER_KG = 400;

/** Equipment slots, in paper-doll order. Keys match rpg.equipment. */
export const SLOTS = Object.freeze([
  'head', 'rightArm', 'leftArm', 'chestArmor', 'gloves', 'legsArmor', 'feet', 'rightHand', 'leftHand',
  'cloak', 'chestClothes', 'legsClothes',
  // Jewellery (ItemEquipTable.GetJewellerySlot, package 16): two of each, first free slot first.
  'amulet0', 'amulet1', 'bracer0', 'bracer1', 'ring0', 'ring1', 'bracelet0', 'bracelet1', 'mark0', 'mark1',
]);
export const SLOT_LABELS = Object.freeze({
  head: 'Head', rightArm: 'Right pauldron', leftArm: 'Left pauldron', chestArmor: 'Chest',
  gloves: 'Hands', legsArmor: 'Legs', feet: 'Feet', rightHand: 'Right hand', leftHand: 'Left hand',
  cloak: 'Cloak', chestClothes: 'Shirt', legsClothes: 'Trousers',
  amulet0: 'Amulet', amulet1: 'Second amulet', bracer0: 'Bracer', bracer1: 'Second bracer', ring0: 'Ring', ring1: 'Second ring',
  bracelet0: 'Bracelet', bracelet1: 'Second bracelet', mark0: 'Mark', mark1: 'Second mark',
});
/** Jewellery template index -> its slot pair (Amulet, Torc and Cloth amulet share the amulet slots; wands are held, not worn). */
const JEWEL_SLOTS = { 133: ['amulet0', 'amulet1'], 138: ['amulet0', 'amulet1'], 139: ['amulet0', 'amulet1'], 134: ['bracer0', 'bracer1'],
  135: ['ring0', 'ring1'], 136: ['bracelet0', 'bracelet1'], 137: ['mark0', 'mark1'] };
export const jewelSlots = (it) => (it?.group === 'jewellery' ? JEWEL_SLOTS[it.index] ?? null : null);
/** Body parts that carry an armour value; armour slots protect the matching part. */
export const BODY_PARTS = Object.freeze(['head', 'rightArm', 'leftArm', 'chest', 'hands', 'legs', 'feet']);
const SLOT_PART = { head: 'head', rightArm: 'rightArm', leftArm: 'leftArm', chestArmor: 'chest', gloves: 'hands', legsArmor: 'legs', feet: 'feet' };

// Classic FPS weapon animation files (WeaponBasics.GetWeaponFilename).
export const WEAPON_FILES = Object.freeze({
  LongBlade: 'WEAPON04.CIF', Staff: 'WEAPON01.CIF', Dagger: 'WEAPON02.CIF', Mace: 'WEAPON05.CIF',
  Flail: 'WEAPON06.CIF', Warhammer: 'WEAPON07.CIF', Battleaxe: 'WEAPON08.CIF', Bow: 'WEAPON09.CIF',
  Melee: 'WEAPON10.CIF',
});

// Weapon materials: index, weight/value/condition multipliers, to-hit/damage modifier.
const WEAPON_MATERIALS = ['iron', 'steel', 'silver', 'elven', 'dwarven', 'mithril', 'adamantium', 'ebony', 'orcish', 'daedric'];
const WEIGHT_MUL = [4, 5, 4, 4, 3, 4, 4, 2, 4, 5];
const VALUE_MUL = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
const CONDITION_MUL = [4, 6, 6, 8, 12, 16, 20, 24, 28, 32];
const MATERIAL_MOD = [-1, 0, 0, 1, 2, 3, 3, 4, 5, 6];
const PLATE_ARMOR = [7, 9, 9, 11, 13, 15, 15, 17, 19, 21];
export const ARMOR_MATERIALS = Object.freeze(['leather', 'chain', ...WEAPON_MATERIALS]);
export const MATERIALS = Object.freeze({ weapon: WEAPON_MATERIALS, armor: ARMOR_MATERIALS });
// Stored armour variants are classic offsets from the template's first record.
const ARMOR_VARIANTS = {
  cuirass: [[0], [4], [1, 2, 3]],
  gauntlets: [[0], [1], [1]],
  greaves: [[0, 1], [6], [2, 3, 4, 5]],
  'left-pauldron': [[0], [4], [1, 2, 3]],
  'right-pauldron': [[0], [4], [1, 2, 3]],
  helm: Array(3).fill([0, 1, 2, 3, 4, 5]),
  boots: [[0], [1, 2], [1, 2]],
};

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const metalDyeOf = (material) => (material === 'leather' || material === 'chain' || !material ? 'silver' : material);

/*
 * Base templates. `index` is the classic template index; `world` and `icon` are
 * {archive, record} references into the player's TEXTURE.nnn files.
 * Weapon icons live in TEXTURE.234; armour icons in TEXTURE.245-252 by sex and
 * body type (client picks the archive, see `iconSet:'armor'`).
 */
const W = (index, name, weight, price, hp, world, icon, weaponType, skill, min, max, hands) => ({
  index, name, group: 'weapon', weight, price, hp, world, icon, weapon: { weaponType, skill, min, max, hands },
});
const A = (index, name, weight, price, hp, world, record, slot, variants, shield = 0) => ({
  index, name, group: shield ? 'shield' : 'armor', weight, price, hp, world, icon: { archive: 251, record }, slot, variants, shield,
});
const T = (archive, record) => ({ archive, record });
// Template drawOrderOrEffect for armour (higher draws later on the paper doll).
const ARMOR_DRAW_ORDER = { 102: 50, 103: 70, 104: 30, 105: 60, 106: 60, 107: 0, 108: 20, 109: 110, 110: 110, 111: 110, 112: 110 };
/*
 * Clothing: [male template index, female template index] and player-texture
 * records in TEXTURE.239 (men) / TEXTURE.235 (women), offset by body type.
 * `null` means the classic game has no version for that sex; the other sex's
 * art is used. drawOrder is the template's drawOrderOrEffect.
 */
const C = (index, name, weight, price, hp, slot, male, female, maleVariants, drawOrder, dye = 'blue', cloak = false, femaleVariants = maleVariants) => ({
  index, name, group: 'clothing', weight, price, hp, world: T(204, 0), slot,
  clothing: { male, female, maleVariants, femaleVariants, variants: Math.max(maleVariants, femaleVariants), drawOrder, dye, cloak },
});

export const BASES = Object.freeze({
  dagger: W(113, 'Dagger', 0.5, 1, 50, T(207, 5), T(234, 5), 'Dagger', 'Short Blade', 1, 6, 'either'),
  tanto: W(114, 'Tanto', 0.75, 3, 50, T(207, 10), T(234, 22), 'LongBlade', 'Short Blade', 1, 8, 'either'),
  shortsword: W(116, 'Shortsword', 2.5, 5, 300, T(207, 3), T(234, 19), 'LongBlade', 'Short Blade', 1, 8, 'either'),
  wakizashi: W(117, 'Wakizashi', 2.0, 8, 200, T(207, 2), T(234, 26), 'LongBlade', 'Short Blade', 1, 10, 'either'),
  broadsword: W(118, 'Broadsword', 5.0, 10, 600, T(207, 2), T(234, 2), 'LongBlade', 'Long Blade', 1, 12, 'either'),
  saber: W(119, 'Saber', 3.75, 12, 700, T(207, 2), T(234, 17), 'LongBlade', 'Long Blade', 3, 12, 'either'),
  longsword: W(120, 'Longsword', 4.5, 15, 800, T(207, 2), T(234, 12), 'LongBlade', 'Long Blade', 2, 16, 'either'),
  katana: W(121, 'Katana', 2.5, 25, 600, T(207, 15), T(234, 10), 'LongBlade', 'Long Blade', 3, 16, 'either'),
  claymore: W(122, 'Claymore', 7.5, 30, 1400, T(207, 2), T(234, 4), 'LongBlade', 'Long Blade', 2, 18, 'both'),
  'dai-katana': W(123, 'Dai-katana', 3.5, 50, 800, T(207, 2), T(234, 7), 'LongBlade', 'Long Blade', 3, 21, 'both'),
  staff: W(115, 'Staff', 2.0, 5, 300, T(207, 7), T(234, 21), 'Staff', 'Blunt Weapon', 1, 8, 'both'),
  mace: W(124, 'Mace', 4.5, 10, 800, T(207, 6), T(234, 14), 'Mace', 'Blunt Weapon', 1, 12, 'either'),
  flail: W(125, 'Flail', 7.0, 15, 1000, T(207, 6), T(234, 8), 'Flail', 'Blunt Weapon', 2, 14, 'both'),
  warhammer: W(126, 'Warhammer', 7.0, 20, 1600, T(214, 3), T(234, 25), 'Warhammer', 'Blunt Weapon', 3, 18, 'both'),
  'battle-axe': W(127, 'Battle Axe', 6.0, 20, 1200, T(207, 4), T(234, 0), 'Battleaxe', 'Axe', 2, 12, 'either'),
  'war-axe': W(128, 'War Axe', 7.5, 20, 800, T(207, 4), T(234, 24), 'Battleaxe', 'Axe', 2, 16, 'both'),
  'short-bow': W(129, 'Short Bow', 1.0, 10, 50, T(207, 8), T(234, 16), 'Bow', 'Archery', 4, 16, 'both'),
  'long-bow': W(130, 'Long Bow', 1.5, 20, 100, T(207, 8), T(234, 11), 'Bow', 'Archery', 4, 18, 'both'),

  // Armour: [leather, chain, plate] icon variant per piece (ItemBuilder.SetVariant).
  cuirass: A(102, 'Cuirass', 12.5, 100, 4096, T(207, 11), 3, 'chestArmor', [0, 4, 1]),
  gauntlets: A(103, 'Gauntlets', 1.25, 50, 2048, T(207, 13), 8, 'gloves', [0, 1, 1]),
  greaves: A(104, 'Greaves', 2.5, 80, 3072, T(207, 13), 10, 'legsArmor', [0, 6, 2]),
  'left-pauldron': A(105, 'Left Pauldron', 2.0, 60, 2048, T(207, 13), 17, 'leftArm', [0, 4, 1]),
  'right-pauldron': A(106, 'Right Pauldron', 2.0, 60, 2048, T(207, 13), 22, 'rightArm', [0, 4, 1]),
  helm: A(107, 'Helm', 2.5, 80, 2560, T(207, 12), 27, 'head', [0, 1, 2]),
  boots: A(108, 'Boots', 2.0, 50, 2560, T(204, 1), 0, 'feet', [0, 1, 1]),
  buckler: A(109, 'Buckler', 2.0, 10, 512, T(207, 10), 33, 'leftHand', [0, 0, 0], 1),
  'round-shield': A(110, 'Round Shield', 4.5, 20, 1280, T(207, 10), 34, 'leftHand', [0, 0, 0], 2),
  'kite-shield': A(111, 'Kite Shield', 7.5, 30, 2048, T(207, 9), 35, 'leftHand', [0, 0, 0], 3),
  'tower-shield': A(112, 'Tower Shield', 12.5, 50, 2560, T(207, 9), 36, 'leftHand', [0, 0, 0], 4),

  // Potions share the Glass Bottle template (83). Each recipe selects its own classic record.
  arrow: { index: 131, name: 'Arrow', group: 'ammo', weight: 0.25, price: 2, hp: 1, world: T(207, 16), stack: true },
  'potion-of-healing': { index: 83, name: 'Potion of Healing', group: 'potion', weight: 0.25, price: 30, hp: 1, world: T(205, 15), stack: true, effect: { stat: 'health', amount: 30 } },
  'potion-of-stamina': { index: 83, name: 'Potion of Stamina', group: 'potion', weight: 0.25, price: 25, hp: 1, world: T(205, 11), stack: true, effect: { stat: 'fatigue', amount: 40 } },
  'potion-of-magicka': { index: 83, name: 'Potion of Magicka', group: 'potion', weight: 0.25, price: 40, hp: 1, world: T(205, 12), stack: true, effect: { stat: 'magicka', amount: 30 } },
  ruby: { index: 0, name: 'Ruby', group: 'gem', weight: 0.25, price: 250, hp: 1000, world: T(254, 0), stack: true },
  emerald: { index: 1, name: 'Emerald', group: 'gem', weight: 0.25, price: 425, hp: 1000, world: T(254, 1), stack: true },
  sapphire: { index: 2, name: 'Sapphire', group: 'gem', weight: 0.25, price: 375, hp: 1000, world: T(254, 2), stack: true },
  diamond: { index: 3, name: 'Diamond', group: 'gem', weight: 0.25, price: 500, hp: 1000, world: T(254, 3), stack: true },
  jade: { index: 4, name: 'Jade', group: 'gem', weight: 0.25, price: 10, hp: 1000, world: T(254, 4), stack: true },
  turquoise: { index: 5, name: 'Turquoise', group: 'gem', weight: 0.25, price: 50, hp: 1000, world: T(254, 5), stack: true },
  malachite: { index: 6, name: 'Malachite', group: 'gem', weight: 0.25, price: 25, hp: 1000, world: T(254, 7), stack: true },
  amber: { index: 7, name: 'Amber', group: 'gem', weight: 0.25, price: 100, hp: 1000, world: T(254, 8), stack: true },
  pearl: { index: 77, name: 'Pearl', group: 'gem', weight: 0.25, price: 150, hp: 1000, world: T(254, 6), stack: true },
  // Clothing (unisex unless one record is null).
  shoes: C(147, 'Shoes', 0.5, 4, 125, 'feet', 10, 10, 1, 20, 'brown'),
  'tall-boots': C(148, 'Tall Boots', 1.5, 3, 300, 'feet', 11, 11, 1, 18, 'brown'),
  sandals: C(150, 'Sandals', 0.25, 1, 120, 'feet', 15, 15, 1, 20, 'tan'),
  'casual-pants': C(151, 'Casual Pants', 0.5, 5, 150, 'legsClothes', 16, 16, 4, 10, 'brown', false, 5),
  breeches: C(152, 'Breeches', 0.5, 5, 150, 'legsClothes', 18, null, 2, 19, 'grey'),
  loincloth: C(162, 'Loincloth', 0.25, 3, 100, 'legsClothes', 44, 44, 3, 10, 'tan'),
  'long-skirt': C(175, 'Long Skirt', 0.5, 10, 130, 'legsClothes', 102, 102, 2, 35, 'purple'),
  'short-shirt': C(165, 'Short Shirt', 0.5, 5, 100, 'chestClothes', 50, 50, 5, 40, 'white'),
  'long-shirt': C(167, 'Long Shirt', 0.5, 10, 70, 'chestClothes', 63, 63, 5, 40, 'white'),
  vest: C(180, 'Vest', 0.5, 3, 130, 'chestClothes', 109, 109, 1, 40, 'brown', false, 2),
  'open-tunic': C(173, 'Open Tunic', 0.5, 5, 150, 'chestClothes', 100, 100, 1, 40, 'green'),
  'short-tunic': C(158, 'Short Tunic', 0.5, 5, 150, 'chestClothes', 35, null, 2, 40, 'red'),
  'plain-robes': C(163, 'Plain Robes', 1.0, 4, 150, 'chestClothes', 47, 47, 2, 80, 'grey'),
  'priest-robes': C(164, 'Priest Robes', 1.0, 100, 180, 'chestClothes', 49, 49, 1, 80, 'white'),
  'casual-cloak': C(154, 'Casual Cloak', 1.0, 5, 140, 'cloak', 21, 21, 6, 90, 'blue', true),
  'formal-cloak': C(155, 'Formal Cloak', 1.0, 25, 120, 'cloak', 30, 30, 2, 90, 'red', true),

  'big-tooth': { index: 56, name: 'Big Tooth', group: 'ingredient', weight: 0.5, price: 8, hp: 7, world: T(254, 57), stack: true },
  // Transportation (ItemTemplates 94: hasNoEncumbrance, so it weighs nothing in the pack). Ridden
  // outdoors through server/rpg/mount.js; priced as a horse by travel. Art: TEXTURE.201 record 0.
  horse: { index: 94, name: 'Horse', group: 'transport', weight: 0, price: 1000, hp: 100, world: T(201, 0) },
  // ItemTemplates 93 (hasNoEncumbrance): opens the 750 kg wagon (server/rpg/property.js) and the cart travel rate.
  'small-cart': { index: 93, name: 'Small Cart', group: 'transport', weight: 0, price: 150, hp: 1400, world: T(213, 1) },
});

// ---------------------------------------------------------------------------
// Ordinary classic items beyond weapons, armour and clothing (generated from ItemTemplates.txt, see
// tools/gen-classic-items.mjs): ingredients, gems, jewellery, religious items, books, lights, drugs, paintings,
// maps, quest props and miscellaneous items. Keys are the kebab-cased template names; a name that would collide
// with an existing key gets the group suffix (`gold-ingredient`). Lights carry `light.radius` (capacityOrTarget,
// DFU EnablePlayerTorch torchLight.range); their condition is the burn time in 20 s ticks.

const LIGHT_TEMPLATES = new Set([247, 248, 253, 269]); // DaggerfallUnityItem.IsLightSource
const OIL_TEMPLATE = 252;
const LANTERN_TEMPLATE = 248;
const GROUP_NAMES = {
  Drugs: 'drug', UselessItems1: 'misc', Books: 'book', UselessItems2: 'misc', ReligiousItems: 'religious', Maps: 'map',
  Paintings: 'painting', Gems: 'gem', PlantIngredients1: 'ingredient', PlantIngredients2: 'ingredient',
  CreatureIngredients1: 'ingredient', CreatureIngredients2: 'ingredient', CreatureIngredients3: 'ingredient',
  MiscellaneousIngredients1: 'ingredient', MetalIngredients: 'ingredient', MiscellaneousIngredients2: 'ingredient',
  Jewellery: 'jewellery', QuestItems: 'quest', MiscItems: 'misc',
};
const kebab = (s) => s.toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Classic template index -> {key, ...base}; also keyed by (ItemGroups id, group index). */
const CLASSIC_BY_INDEX = new Map();
const CLASSIC_BY_GROUP = new Map(); // `${groupId}:${groupIndex}` -> key
function classicMiscBases(existing) {
  const out = {};
  const rows = new Map(TEMPLATE_ROWS.map((r) => [r[0], r]));
  for (const [gname, g] of Object.entries(CLASSIC_GROUPS)) {
    g.members.forEach((index, groupIndex) => {
      const r = rows.get(index);
      if (!r) return;
      const [, name, weight, hp, capacity, price, enchantPoints, rarity, variants, ingredient, wa, wr] = r;
      let key = CLASSIC_BY_INDEX.get(index)?.key;
      if (!key) {
        key = index === 277 ? 'book' : kebab(name);
        const taken = (k) => Object.hasOwn(existing, k) || Object.hasOwn(out, k) || k === 'gold';
        // Existing hand-made entries with the same classic index (gems, pearl, big tooth) keep their key.
        const same = Object.entries(existing).find(([, b]) => b.index === index && b.group !== 'potion');
        if (same) key = same[0];
        else if (taken(key)) key = `${key}-${GROUP_NAMES[gname]}`;
        if (!same) {
          let group = GROUP_NAMES[gname];
          if (LIGHT_TEMPLATES.has(index)) group = 'light';
          else if (index === 279) group = 'letter';
          out[key] = {
            index, name, group, weight, price, hp, world: { archive: wa, record: wr },
            stack: !!ingredient || index === OIL_TEMPLATE || group === 'book' ? true : undefined,
            rarity, variants, enchantPoints, classicGroup: g.id, groupIndex,
            ...(LIGHT_TEMPLATES.has(index) ? { light: { radius: capacity } } : {}),
          };
        }
        CLASSIC_BY_INDEX.set(index, { key });
      }
      const gk = `${g.id}:${groupIndex}`;
      if (!CLASSIC_BY_GROUP.has(gk)) CLASSIC_BY_GROUP.set(gk, key);
    });
  }
  return out;
}

/**
 * Every item base: the hand-made BASES above, the generated classic ordinary items, and bases other features
 * register at install time (registerBases). Kept separate from the frozen BASES export so other modules'
 * iteration over BASES is unchanged.
 */
const ALL_BASES = { ...BASES };
Object.assign(ALL_BASES, classicMiscBases(ALL_BASES));
for (const [k, b] of Object.entries(ALL_BASES)) {
  if (Number.isInteger(b.index) && !CLASSIC_BY_INDEX.has(b.index) && b.group !== 'potion' && b.group !== 'transport') CLASSIC_BY_INDEX.set(b.index, { key: k });
}

/**
 * Register additional item bases (another feature's templates, e.g. recipe potions or artifacts). Same shape as a
 * BASES entry: {index, name, group, weight, price, hp, world:{archive,record}, stack?, effect?, light?}.
 * An existing key is never replaced. Returns the keys added.
 */
export function registerBases(obj) {
  const added = [];
  for (const [k, b] of Object.entries(obj || {})) {
    if (typeof k !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(k) || Object.hasOwn(ALL_BASES, k) || k === 'gold') continue;
    if (!b || typeof b.name !== 'string' || typeof b.group !== 'string') continue;
    ALL_BASES[k] = { ...b, world: { ...(b.world ?? { archive: 205, record: 0 }) } };
    added.push(k);
  }
  return added;
}

/** Every base by key (hand-made BASES + generated classic ordinary items + registered). Read-only view. */
export const allBases = () => ALL_BASES;

/** Template key for a classic (ItemGroups id, group index) pair, e.g. (7, 0) -> 'book'. Null when unknown. */
export function templateForClassic(groupId, groupIndex) {
  return CLASSIC_BY_GROUP.get(`${groupId}:${groupIndex}`) ?? null;
}
/** Template key for a classic template index (ItemTemplates.txt), or null. */
export function templateForIndex(index) {
  return CLASSIC_BY_INDEX.get(index)?.key ?? null;
}
/** Template keys of a classic item group by name (ItemEnums.cs), in enum order. */
export function classicGroupTemplates(groupName) {
  const g = CLASSIC_GROUPS[groupName];
  return g ? g.members.map((_, i) => templateForClassic(g.id, i)).filter(Boolean) : [];
}

/** Unarmed pseudo-weapon (hand-to-hand), returned when the right hand is empty. */
export const UNARMED = Object.freeze({
  template: 'unarmed', name: 'Hand-to-Hand', weaponType: 'Melee', weaponFile: WEAPON_FILES.Melee,
  skill: 'Hand-to-Hand', damage: { min: 1, max: 2 }, hands: 'either', material: null, materialModifier: 0,
});

/** Resolve a template key such as `iron-longsword`, `chain-cuirass`, `longsword` or `arrow`. */
export function resolveTemplate(key) {
  if (typeof key !== 'string' || key.length > 64) return null;
  const k = key.toLowerCase();
  if (Object.hasOwn(ALL_BASES, k)) {
    const b = ALL_BASES[k];
    if (b.group === 'weapon') return { key: `iron-${k}`, base: k, material: 'iron' };
    if (b.group === 'armor') return { key: `leather-${k}`, base: k, material: 'leather' };
    if (b.group === 'shield') return { key: k, base: k, material: null };
    if (b.group === 'clothing') return { key: `${b.clothing.dye}-${k}`, base: k, material: null, dye: b.clothing.dye };
    return { key: k, base: k, material: null };
  }
  const dash = k.indexOf('-');
  if (dash < 0) return null;
  const material = k.slice(0, dash);
  const base = k.slice(dash + 1);
  if (!Object.hasOwn(ALL_BASES, base)) return null;
  const b = ALL_BASES[base];
  if (b.group === 'weapon' && WEAPON_MATERIALS.includes(material)) return { key: k, base, material };
  if (b.group === 'armor' && ARMOR_MATERIALS.includes(material)) return { key: k, base, material };
  if (k === 'steel-buckler') return { key: k, base, material };
  if (b.group === 'clothing' && Object.hasOwn(CLOTH_DYES, material)) return { key: k, base, material: null, dye: material };
  return null;
}

export const isTemplate = (key) => key === 'gold' || resolveTemplate(key) !== null;

const round2 = (v) => Math.round(v * 100) / 100;
/** Unity's Mathf.Round: halves round to the even neighbour. */
const roundEven = (v) => {
  const f = Math.floor(v);
  const d = v - f;
  return d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f;
};

/** Derived, display-ready fields for a template key (no id/quantity/condition). */
export function describeTemplate(key) {
  const r = resolveTemplate(key);
  if (!r) throw new Error(`Unknown item "${key}".`);
  const b = ALL_BASES[r.base];
  let weight = b.weight;
  let value = b.price;
  let maxCondition = b.hp;
  const out = {
    template: r.key, base: r.base, index: b.index, group: b.group, material: r.material,
    stackable: !!b.stack, world: { ...b.world },
  };
  if (b.group === 'weapon') {
    const m = WEAPON_MATERIALS.indexOf(r.material);
    value *= 3 * VALUE_MUL[m];
    weight = roundEven(Math.trunc(weight * 4) * WEIGHT_MUL[m] / 4) / 4;
    maxCondition = Math.trunc(maxCondition * CONDITION_MUL[m] / 4);
    const wt = b.weapon.weaponType;
    Object.assign(out, {
      name: `${cap(r.material)} ${b.name}`,
      slot: 'rightHand', hands: b.weapon.hands, skill: b.weapon.skill,
      weaponType: wt, weaponFile: WEAPON_FILES[wt],
      damage: { min: b.weapon.min, max: b.weapon.max }, materialModifier: MATERIAL_MOD[m],
      icon: { ...b.icon, set: 'weapon', dye: r.material },
      // Paper doll: TEXTURE.234 (male) / 233 (female). One-handed weapons use record + 1 in the right hand.
      doll: { set: 'weapon', record: b.index === 121 ? b.icon.record - 1 : b.icon.record, drawOrder: 100, dye: r.material },
    });
  } else if (b.group === 'armor' || b.group === 'shield') {
    let armorValue = b.shield;
    let family = 0;
    if (b.group === 'armor') {
      if (r.material === 'leather') {
        weight = roundEven(Math.trunc(weight * 4) / 2) / 4;
        armorValue = 3;
      } else if (r.material === 'chain') {
        value *= 2;
        armorValue = 6;
        family = 1;
      } else {
        armorValue = PLATE_ARMOR[WEAPON_MATERIALS.indexOf(r.material)];
        family = 2;
      }
    }
    if (WEAPON_MATERIALS.includes(r.material)) {
      const m = WEAPON_MATERIALS.indexOf(r.material);
      value *= 3 * VALUE_MUL[m];
      weight = roundEven(Math.trunc(weight * 4) * WEIGHT_MUL[m] / 4) / 4;
      maxCondition = Math.trunc(maxCondition * CONDITION_MUL[m] / 4);
    }
    const covers = b.group === 'shield'
      ? { 1: ['leftArm', 'hands'], 2: ['leftArm', 'hands', 'legs'], 3: ['leftArm', 'hands', 'legs'], 4: ['head', 'leftArm', 'hands', 'legs'] }[b.shield]
      : [SLOT_PART[b.slot]];
    const art = {
      set: 'armor', baseRecord: b.icon.record, record: b.icon.record + b.variants[family],
      variants: ARMOR_VARIANTS[r.base]?.[family] ?? [0], dye: metalDyeOf(r.material),
    };
    Object.assign(out, {
      name: r.material ? `${cap(r.material)} ${b.name}` : b.name,
      slot: b.slot, armorValue, covers, hands: b.group === 'shield' ? 'left' : undefined,
      icon: { ...art, archive: b.icon.archive },
      doll: { ...art, drawOrder: ARMOR_DRAW_ORDER[b.index] },
    });
  } else if (b.group === 'clothing') {
    const c = b.clothing;
    const doll = {
      set: 'clothing', ...c, dye: r.dye,
    };
    Object.assign(out, {
      name: r.dye === c.dye ? b.name : `${cap(r.dye)} ${b.name}`,
      dye: r.dye, slot: b.slot, variants: c.variants,
      icon: { ...doll }, doll,
    });
  } else {
    Object.assign(out, { name: b.name, icon: { ...b.world } });
    if (b.effect) out.effect = { ...b.effect };
    if (b.light) out.light = { ...b.light };
  }
  if (Number.isInteger(b.classicGroup)) Object.assign(out, { classicGroup: b.classicGroup, groupIndex: b.groupIndex });
  out.weight = round2(weight);
  out.value = value;
  out.maxCondition = maxCondition;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** Template keys offered by the catalogue (every base in every legal material). */
export function catalogue() {
  const keys = [];
  for (const [base, b] of Object.entries(ALL_BASES)) {
    if (b.group === 'weapon') for (const m of WEAPON_MATERIALS) keys.push(`${m}-${base}`);
    else if (b.group === 'armor') for (const m of ARMOR_MATERIALS) keys.push(`${m}-${base}`);
    else if (b.group === 'clothing') for (const d of Object.keys(CLOTH_DYES)) keys.push(`${d}-${base}`);
    else keys.push(base);
  }
  return [...keys, 'steel-buckler'];
}

/** Starting kit granted once per character. [template, quantity, slot?] */
export const STARTER_KIT = Object.freeze([
  ['iron-longsword', 1, 'rightHand'],
  ['steel-dagger', 1],
  ['iron-battle-axe', 1],
  ['iron-mace', 1],
  ['short-bow', 1],
  ['arrow', 24],
  ['leather-cuirass', 1, 'chestArmor'],
  ['leather-helm', 1, 'head'],
  ['leather-boots', 1, 'feet'],
  ['leather-gauntlets', 1],
  ['buckler', 1],
  ['potion-of-healing', 3],
  ['potion-of-stamina', 1],
]);
/** Clothing added by inventory version 2 (also granted to version-1 characters once). */
export const STARTER_CLOTHES = Object.freeze([
  ['white-short-shirt', 1, 'chestClothes'],
  ['brown-casual-pants', 1, 'legsClothes'],
  ['blue-casual-cloak', 1],
  ['brown-shoes', 1],
]);
export const STARTER_GOLD = 100;

const newId = () => `it-${randomBytes(6).toString('base64url')}`;
const int = (v, d = 0) => (Number.isFinite(v) ? Math.trunc(v) : d);

/** Build a persistent item record. `extra`: per-item state (see ITEM_EXTRAS). */
export function makeItem(template, quantity = 1, id = newId(), extra = null) {
  const d = describeTemplate(template);
  const it = { id, ...d, quantity, condition: d.maxCondition };
  applyVariant(it);
  if (extra) applyExtras(it, extra, true);
  return it;
}

function applyVariant(item, variant) {
  if (item.group === 'clothing') item.variant = Math.max(0, Math.min(item.variants - 1, int(variant)));
  if (item.group === 'armor' && item.doll.variants.includes(variant)) item.variant = variant;
  // Books and other generic items with several classic variants keep the stored one (CreateRandomBook).
  if (!item.doll && item.group !== 'clothing' && Number.isInteger(variant) && variant > 0) {
    const n = ALL_BASES[item.base]?.variants ?? 0;
    if (variant < n) item.variant = variant;
  }
}

/*
 * Per-item state that survives normalisation and transfers (each value plain JSON ≤ 4 KB):
 *   magic   {enchantments:[{type,param}], identified:bool, name?, uses?, value?, defIndex?, soul?, artifact?}
 *           Enchanted items: displayed name is magic.name once identified, the base name before. Classic charges are
 *           the item's condition: MAGIC.DEF `uses` becomes maxCondition (ItemBuilder.CreateRegularMagicItem).
 *   bookId  installed BOKnnnnn.TXT number; the name and value come from that file (title, DFU price rule).
 *   letter  {title, lines:[string], from?} readable parchment (quest letters, notes).
 *   quest   {uid, symbol, ...} quest owner's marker; quest items never stack and are not sold.
 *   owner   {kind, id, name?} property/shop/house ownership marker (stolen goods, deeds).
 *   recipe  {key, name?} potion recipe (package 16).
 *   stolen  {from, at} set when taken from private property.
 *   conjuredUntil  last personal game minute that summoned equipment can exist.
 * Items with any of these never merge into a stack unless the state is identical (books with the same id).
 */
export const ITEM_EXTRAS = Object.freeze(['magic', 'bookId', 'letter', 'quest', 'owner', 'recipe', 'stolen', 'conjuredUntil', 'credit']);
const MAX_EXTRA_BYTES = 4096;
let bookLibrary = null; // set by install(ctx) from the operator's ARENA2 files

export const hasExtras = (it) => ITEM_EXTRAS.some((k) => it?.[k] !== undefined);
const extrasKey = (it) => JSON.stringify(ITEM_EXTRAS.map((k) => it?.[k] ?? null));
/** True when two records may share a stack. */
const sameStack = (a, b) => a.template === b.template && extrasKey(a) === extrasKey(b) && !a.magic && !a.quest && !b.magic && !b.quest;

function cleanExtra(k, v) {
  if (v === undefined || v === null) return undefined;
  if (k === 'bookId') return Number.isInteger(v) && v >= 0 && v <= 0xffff ? v : undefined;
  if (k === 'conjuredUntil') return Number.isSafeInteger(v) && v > 0 ? v : undefined;
  if (typeof v !== 'object' || Array.isArray(v)) return undefined;
  let text;
  try { text = JSON.stringify(v); } catch { return undefined; }
  if (!text || text.length > MAX_EXTRA_BYTES) return undefined;
  return JSON.parse(text);
}

/** Copy allowlisted per-item state from `src` onto `it` and refresh the derived name/value/condition. */
function applyExtras(it, src, fresh = false) {
  for (const k of ITEM_EXTRAS) {
    const v = cleanExtra(k, src?.[k]);
    if (v !== undefined) it[k] = v;
  }
  if (it.bookId !== undefined) {
    const info = bookLibrary?.info(it.bookId);
    if (info) {
      it.name = info.title;
      it.value = info.price;
      it.author = info.author;
    }
  }
  if (it.letter) it.name = typeof it.letter.title === 'string' && it.letter.title ? it.letter.title.slice(0, 80) : 'Letter';
  // A letter of credit (package 13, DaggerfallBankManager.Withdraw_LOC): its value is the gold it is good for.
  if (it.credit) {
    const amount = int(it.credit.amount, 0);
    if (it.template === 'letter-of-credit' && amount > 0) it.value = amount;
    else delete it.credit;
  }
  if (it.magic) {
    const m = it.magic;
    m.identified = m.identified !== false;
    if (Number.isInteger(m.uses) && m.uses > 0) {
      it.maxCondition = m.uses;
      if (fresh) it.condition = m.uses;
    }
    if (Number.isInteger(m.value) && m.value >= 0) it.value = m.value;
    // FeatherWeight (type 11) makes the item weigh 0.25 kg; ExtraWeight (type 23) multiplies it by 4.
    const types = Array.isArray(m.enchantments) ? m.enchantments.map((e) => e?.type) : [];
    if (types.includes(11)) it.weight = 0.25;
    else if (types.includes(23)) it.weight = round2(it.weight * 4);
    if (m.identified && typeof m.name === 'string' && m.name) it.name = m.name.slice(0, 80);
  }
  if (hasExtras(it) && it.stackable && (it.magic || it.quest)) it.stackable = false;
  it.condition = Math.max(0, Math.min(it.maxCondition, int(src?.condition, it.condition)));
  return it;
}

/** Refresh derived fields of a stored record from the catalogue; drops unknown items. */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.template !== 'string') return null;
  const r = resolveTemplate(raw.template);
  if (!r) return null;
  const d = describeTemplate(r.key);
  const quantity = Math.max(1, Math.min(MAX_STACK, int(raw.quantity, 1)));
  const condition = Math.max(0, Math.min(d.maxCondition, int(raw.condition, d.maxCondition)));
  const id = typeof raw.id === 'string' && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : newId();
  const it = { id, ...d, quantity: d.stackable ? quantity : 1, condition };
  applyVariant(it, raw.variant);
  if (hasExtras(raw)) {
    applyExtras(it, raw);
    if (!it.stackable) it.quantity = 1;
  }
  return it;
}

/** A normalised copy of an item record (for containers and other owners that store records). Null if invalid. */
export const normalizeRecord = (raw) => normalizeItem(raw);

/** Ensure rpg.inventory/equipment/gold are valid. Pure apart from mutating `rpg`. */
export function normalizeRpg(rpg, restriction = () => null) {
  const seen = new Set();
  const items = [];
  for (const raw of Array.isArray(rpg.inventory) ? rpg.inventory : []) {
    const it = normalizeItem(raw);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    items.push(it);
  }
  rpg.inventory = items.slice(0, MAX_ITEMS);
  const eq = rpg.equipment && typeof rpg.equipment === 'object' ? rpg.equipment : {};
  rpg.equipment = {};
  for (const it of rpg.inventory) delete it.equipped;
  for (const slot of SLOTS) {
    const it = rpg.inventory.find((i) => i.id === eq[slot]);
    if (it && !it.equipped && canOccupy(it, slot) && !restriction(it)) {
      rpg.equipment[slot] = it.id;
      it.equipped = slot;
    }
  }
  // A two-handed weapon blocks the left hand.
  const rh = itemIn(rpg, 'rightHand');
  if (rh && rh.hands === 'both' && rpg.equipment.leftHand) {
    delete itemIn(rpg, 'leftHand').equipped;
    delete rpg.equipment.leftHand;
  }
  rpg.gold = Math.max(0, Math.min(1e9, int(rpg.gold, 0)));
  updateWeaponView(rpg);
  updateLightSource(rpg);
  return rpg;
}

/**
 * rpg.lightSource: the lit light ({itemId, template, name, radius, condition, maxCondition}) or null
 * (DFU PlayerEntity.LightSource). The atmosphere renderer draws it; burn-down is the inventory tick.
 */
function updateLightSource(rpg) {
  const id = rpg.lightSource?.itemId;
  const it = id ? rpg.inventory.find((i) => i.id === id) : null;
  rpg.lightSource = it && it.group === 'light' && it.condition > 0
    ? { itemId: it.id, template: it.template, name: it.name, radius: it.light?.radius ?? null, condition: it.condition, maxCondition: it.maxCondition }
    : null;
}

const WEARABLE = new Set(['weapon', 'armor', 'shield', 'clothing']);
/** Worn in an equipment slot: weapons, armour, clothing and the jewellery with a slot pair. */
export const isWearable = (it) => !!it && (WEARABLE.has(it.group) || !!jewelSlots(it));

function canOccupy(item, slot) {
  if (item.group === 'weapon') return slot === 'rightHand' || (slot === 'leftHand' && item.hands === 'either');
  if (item.group === 'jewellery') return !!jewelSlots(item)?.includes(slot);
  if (item.group === 'armor' || item.group === 'shield' || item.group === 'clothing') return item.slot === slot;
  return false;
}

const itemIn = (rpg, slot) => rpg.inventory.find((i) => i.id === rpg.equipment[slot]) || null;

function updateWeaponView(rpg) {
  const w = itemIn(rpg, 'rightHand');
  rpg.weaponView = w
    ? { itemId: w.id, template: w.template, name: w.name, weaponType: w.weaponType, weaponFile: w.weaponFile, material: w.material, hands: w.hands }
    : { itemId: null, template: UNARMED.template, name: UNARMED.name, weaponType: UNARMED.weaponType, weaponFile: UNARMED.weaponFile, material: null, hands: 'either' };
}

function unroundedCarriedWeight(rpg) {
  let kg = 0;
  for (const it of rpg.inventory || []) kg += it.weight * it.quantity;
  // Item records already use hundredths of a kilogram. Keep the finer weight of gold pieces.
  return (Math.round(kg * GOLD_PER_KG) + (rpg.gold || 0)) / GOLD_PER_KG;
}

export function carriedWeight(rpg) {
  return round2(unroundedCarriedWeight(rpg));
}

export function armorValues(rpg) {
  const out = Object.fromEntries(BODY_PARTS.map((p) => [p, 0]));
  for (const slot of SLOTS) {
    const it = itemIn(rpg, slot);
    if (!it || !it.covers) continue;
    for (const part of it.covers) out[part] += it.armorValue;
  }
  return out;
}

/** Validate then perform equip. Returns a message. */
export function equip(rpg, itemId, requestedSlot, restriction = () => null) {
  const it = rpg.inventory.find((i) => i.id === itemId);
  if (!it) throw new Error('You do not have that item.');
  if (!isWearable(it)) throw new Error(`${it.name} cannot be equipped.`);
  if (it.condition <= 0) throw new Error(`${it.name} is broken.`);
  const blocked = restriction(it);
  if (blocked) throw new Error(blocked);
  const pair = jewelSlots(it);
  let slot = requestedSlot ?? (pair ? (pair.includes(it.equipped) ? it.equipped : pair.find((s) => !rpg.equipment[s]) ?? pair[0]) : it.slot);
  if (!SLOTS.includes(slot)) throw new Error('No such equipment slot.');
  if (!canOccupy(it, slot)) throw new Error(`${it.name} does not fit the ${SLOT_LABELS[slot].toLowerCase()}.`);
  if (it.equipped === slot) return `${it.name} is already equipped.`;
  const freed = [];
  const free = (s) => {
    const cur = itemIn(rpg, s);
    if (cur) { delete cur.equipped; freed.push(cur.name); }
    delete rpg.equipment[s];
  };
  if (it.equipped) free(it.equipped);
  free(slot);
  if (it.hands === 'both') free('leftHand');
  if (slot === 'leftHand') {
    const rh = itemIn(rpg, 'rightHand');
    if (rh && rh.hands === 'both') free('rightHand');
  }
  rpg.equipment[slot] = it.id;
  it.equipped = slot;
  updateWeaponView(rpg);
  return freed.length ? `Equipped ${it.name} (removed ${freed.join(', ')}).` : `Equipped ${it.name}.`;
}

export function unequip(rpg, { itemId, slot } = {}) {
  if (slot == null && itemId != null) slot = rpg.inventory.find((i) => i.id === itemId)?.equipped;
  if (!SLOTS.includes(slot) || !rpg.equipment[slot]) throw new Error('Nothing is equipped there.');
  const it = itemIn(rpg, slot);
  delete rpg.equipment[slot];
  if (it) delete it.equipped;
  updateWeaponView(rpg);
  return `Unequipped ${it ? it.name : 'item'}.`;
}

/** Add items; merges stacks. Returns the affected record (or {template:'gold'}). */
export function addItem(rpg, template, quantity = 1, { variant, extra } = {}) {
  quantity = int(quantity, 0);
  if (quantity < 1 || quantity > MAX_STACK) throw new Error('Invalid quantity.');
  if (template === 'gold') {
    if (rpg.gold + quantity > 1e9) throw new Error('Too much gold.');
    rpg.gold += quantity;
    return { template: 'gold', quantity };
  }
  const r = resolveTemplate(template);
  if (!r) throw new Error(`Unknown item "${template}".`);
  const d = describeTemplate(r.key);
  const proto = extra ? applyExtras({ ...d, quantity: 1, condition: d.maxCondition }, extra, true) : null;
  const stackable = proto ? proto.stackable : d.stackable;
  if (stackable) {
    const probe = proto ?? d;
    const stack = rpg.inventory.find((i) => sameStack(i, probe));
    if (stack) {
      if (stack.quantity + quantity > MAX_STACK) throw new Error('That stack is full.');
      stack.quantity += quantity;
      return stack;
    }
    if (rpg.inventory.length >= MAX_ITEMS) throw new Error('Your pack cannot hold any more items.');
    const it = makeItem(d.template, quantity, newId(), extra);
    applyVariant(it, variant);
    rpg.inventory.push(it);
    return it;
  }
  if (rpg.inventory.length + quantity > MAX_ITEMS) throw new Error('Your pack cannot hold any more items.');
  let last;
  for (let n = 0; n < quantity; n++) {
    last = makeItem(d.template, 1, newId(), extra);
    applyVariant(last, variant);
    rpg.inventory.push(last);
  }
  return last;
}

/** Insert an existing record (keeps condition and per-item state); merges identical stackables. */
export function insertRecord(rpg, rec) {
  if (rec.template === 'gold') return addItem(rpg, 'gold', rec.quantity);
  if (rec.stackable) {
    const stack = rpg.inventory.find((i) => sameStack(i, rec));
    if (stack) {
      if (stack.quantity + rec.quantity > MAX_STACK) throw new Error('That stack is full.');
      stack.quantity += rec.quantity;
      return stack;
    }
  }
  if (rpg.inventory.length >= MAX_ITEMS) throw new Error('Your pack cannot hold any more items.');
  const it = { ...rec, id: rpg.inventory.some((i) => i.id === rec.id) ? newId() : rec.id };
  delete it.equipped;
  rpg.inventory.push(it);
  return it;
}

/** Validate a removal without changing state. Returns the item (or gold marker). */
function checkTake(rpg, itemId, quantity, { allowEquipped = false, consumeConjured = false } = {}) {
  quantity = int(quantity, 0);
  if (quantity < 1) throw new Error('Invalid quantity.');
  if (itemId === 'gold') {
    if (rpg.gold < quantity) throw new Error('You do not have enough gold.');
    return { template: 'gold', quantity };
  }
  const it = rpg.inventory.find((i) => i.id === itemId);
  if (!it) throw new Error('You do not have that item.');
  if (it.conjuredUntil && !consumeConjured) throw new Error(`${it.name} is conjured and cannot leave your pack.`);
  if (it.quantity < quantity) throw new Error(`You only have ${it.quantity} ${it.name}.`);
  if (it.equipped && !allowEquipped) throw new Error(`Unequip ${it.name} first.`);
  return it;
}

/** Remove items. Returns a detached record describing what was removed. */
export function removeItem(rpg, itemId, quantity = 1, opts) {
  const it = checkTake(rpg, itemId, quantity, opts);
  quantity = int(quantity, 0);
  if (it.template === 'gold') {
    rpg.gold -= quantity;
    return { template: 'gold', quantity };
  }
  if (it.equipped) unequip(rpg, { slot: it.equipped });
  if (it.quantity > quantity) {
    it.quantity -= quantity;
    return { ...it, id: newId(), quantity };
  }
  rpg.inventory.splice(rpg.inventory.indexOf(it), 1);
  return { ...it };
}

/** Use an item: potions apply their effect, gear toggles equipped. */
export function useItem(rpg, itemId, restriction) {
  const it = rpg.inventory.find((i) => i.id === itemId);
  if (!it) throw new Error('You do not have that item.');
  if (isWearable(it)) {
    return it.equipped ? unequip(rpg, { slot: it.equipped }) : equip(rpg, it.id, undefined, restriction);
  }
  if (it.group === 'potion' && it.effect) {
    const c = rpg.character;
    const { stat, amount } = it.effect;
    const maxKey = `max${cap(stat)}`;
    if (!c || !Number.isFinite(c[stat]) || !Number.isFinite(c[maxKey])) throw new Error('Nothing happens.');
    if (c[stat] >= c[maxKey]) throw new Error(`Your ${stat} is already full.`);
    const before = c[stat];
    c[stat] = Math.min(c[maxKey], c[stat] + amount);
    removeItem(rpg, it.id, 1);
    return `You drink the ${it.name} (+${c[stat] - before} ${stat}).`;
  }
  if (it.group === 'light') return toggleLight(rpg, it.id);
  if (it.index === OIL_TEMPLATE) return refuelLantern(rpg, it.id);
  throw new Error(`You cannot use ${it.name} here.`);
}

/** DaggerfallInventoryWindow light use: light or douse a torch, lantern, candle or holy candle. */
export function toggleLight(rpg, itemId) {
  const it = rpg.inventory.find((i) => i.id === itemId);
  if (!it || it.group !== 'light') throw new Error('That is not a light.');
  if (it.condition <= 0) throw new Error(`Your ${it.name} has no fuel.`);
  if (rpg.lightSource?.itemId === it.id) {
    rpg.lightSource = null;
    return `You douse your ${it.name}.`;
  }
  rpg.lightSource = { itemId: it.id };
  updateLightSource(rpg);
  return `You light your ${it.name}.`;
}

/** Oil refuels the lantern when the oil fits (lantern.condition <= max - oil.condition); one bottle is used. */
export function refuelLantern(rpg, oilId) {
  const oil = rpg.inventory.find((i) => i.id === oilId);
  if (!oil || oil.index !== OIL_TEMPLATE) throw new Error('That is not oil.');
  const lantern = rpg.inventory.find((i) => i.index === LANTERN_TEMPLATE && i.group === 'light');
  if (!lantern || lantern.condition > lantern.maxCondition - oil.condition) throw new Error('Your lantern is full.');
  lantern.condition += oil.condition;
  removeItem(rpg, oil.id, 1);
  updateLightSource(rpg);
  return `You refuel your ${lantern.name}.`;
}

export const LIGHT_TICK_MS = 20_000; // EnablePlayerTorch.tickTimeInterval

/**
 * One burn tick of the lit light (EnablePlayerTorch.Update): condition falls by one; at zero the light dies and,
 * unless it is a lantern, is removed. Returns null, {burnedOut:false} or {burnedOut:true, name}.
 */
export function burnLight(rpg) {
  const id = rpg.lightSource?.itemId;
  if (!id) return null;
  const it = rpg.inventory.find((i) => i.id === id);
  if (!it || it.group !== 'light') { rpg.lightSource = null; return { burnedOut: false }; }
  if (it.condition > 0) it.condition -= 1;
  if (it.condition > 0) { updateLightSource(rpg); return { burnedOut: false }; }
  rpg.lightSource = null;
  if (it.index !== LANTERN_TEMPLATE) {
    if (it.quantity > 1) { it.quantity -= 1; it.condition = it.maxCondition; } else rpg.inventory.splice(rpg.inventory.indexOf(it), 1);
  }
  return { burnedOut: true, name: it.name };
}

/** Classic identify price: (25 * value) >> 8 (FormulaHelper.CalculateItemIdentifyCost before guild reductions). */
export const identifyCost = (item) => (25 * Math.max(0, int(item?.value, 0))) >> 8;

/** Mark an enchanted item identified. Returns {ok, name, already}. */
export function identify(rpg, itemId) {
  const it = rpg.inventory.find((i) => i.id === itemId);
  if (!it) throw new Error('You do not have that item.');
  if (!it.magic || it.magic.identified !== false) return { ok: true, name: it.name, already: true };
  it.magic.identified = true;
  if (typeof it.magic.name === 'string' && it.magic.name) it.name = it.magic.name.slice(0, 80);
  return { ok: true, name: it.name, already: false };
}

/** Wear an item by `amount` condition; broken items are unequipped. Returns true if it broke. */
export function wearItem(rpg, itemId, amount = 1) {
  const it = rpg.inventory.find((i) => i.id === itemId);
  if (!it || !(amount > 0)) return false;
  it.condition = Math.max(0, it.condition - Math.trunc(amount));
  if (it.condition === 0) {
    if (it.equipped) unequip(rpg, { slot: it.equipped });
    return true;
  }
  return false;
}

export function conditionLabel(it) {
  const pct = it.maxCondition > 0 ? (100 * it.condition) / it.maxCondition : 100;
  if (pct >= 92) return 'New';
  if (pct >= 76) return 'Almost new';
  if (pct >= 61) return 'Slightly used';
  if (pct >= 41) return 'Used';
  if (pct >= 16) return 'Worn';
  if (pct > 0) return 'Battered';
  return 'Broken';
}

export function grantStarterKit(rpg, restriction = () => null) {
  const version = int(rpg.inventoryVersion);
  if (version >= INVENTORY_VERSION) return false;
  const grant = (list) => {
    for (const [template, qty, slot] of list) {
      const it = addItem(rpg, template, qty);
      if (slot && !rpg.equipment[slot] && !restriction(it)) equip(rpg, it.id, slot);
    }
  };
  if (version < 1) {
    grant(STARTER_KIT);
    rpg.gold += STARTER_GOLD;
  }
  if (version < 2) grant(STARTER_CLOTHES);
  rpg.inventoryVersion = INVENTORY_VERSION;
  return true;
}

// ---------------------------------------------------------------------------

export function install(ctx) {
  const loot = new Map(); // entity id -> {contents: record[], expires}
  let lootSeq = 0;
  const restrictionFor = (p) => (item) => {
    if ((item.slot === 'rightHand' || item.slot === 'leftHand') && ctx.services.conditionBeastForm?.(p)) {
      return 'You cannot equip weapons or shields in beast form.';
    }
    return ctx.services.equipmentRestriction?.(p, item);
  };
  const rpgOf = (p) => {
    if (!p.rpg || typeof p.rpg !== 'object') p.rpg = {};
    if (!Array.isArray(p.rpg.inventory) || !p.rpg.equipment || !Number.isFinite(p.rpg.gold)) normalizeRpg(p.rpg, restrictionFor(p));
    return p.rpg;
  };
  const say = (p, text, extra = {}) => ctx.notify?.(p, { kind: 'inventory', text, ...extra });
  const changed = (p, reason) => {
    ctx.dirty?.(p);
    ctx.emit?.('inventoryChanged', { player: p, reason });
  };
  ctx.services.clearEquippedHands = (p) => {
    const rpg = rpgOf(p);
    const slots = ['rightHand', 'leftHand'].filter((slot) => rpg.equipment[slot]);
    if (!slots.length) return;
    ctx.dirty(p);
    for (const slot of slots) unequip(rpg, { slot });
    changed(p, 'shapechange');
  };
  const conjurationMinute = (p) => Math.floor(ctx.services.playerMinutes?.(p) ??
    ((ctx.services.worldClock?.().minutes ?? ctx.now() / 5000) + (p.rpg?.atmosphere?.personalMinutes ?? 0)));
  function expireConjured(p) {
    const rpg = p.rpg;
    if (!Array.isArray(rpg?.inventory)) return;
    const minute = conjurationMinute(p);
    const expired = rpg.inventory.filter((it) => it.conjuredUntil && it.conjuredUntil < minute);
    if (!expired.length) return;
    ctx.dirty?.(p);
    for (const it of expired) {
      removeItem(rpg, it.id, it.quantity, { allowEquipped: true, consumeConjured: true });
      say(p, `Your conjured ${it.name} vanishes.`);
    }
    changed(p, 'conjuredExpiry');
  }
  const withRollback = (rpgs, fn) => {
    const snaps = rpgs.map((r) => JSON.stringify({ i: r.inventory, e: r.equipment, g: r.gold, w: r.weaponView, c: r.character }));
    try {
      return fn();
    } catch (err) {
      // Restore only what changed so references held by callers stay valid after validation errors.
      rpgs.forEach((r, n) => {
        if (JSON.stringify({ i: r.inventory, e: r.equipment, g: r.gold, w: r.weaponView, c: r.character }) === snaps[n]) return;
        const s = JSON.parse(snaps[n]);
        r.inventory = s.i; r.equipment = s.e; r.gold = s.g; r.weaponView = s.w;
        if (s.c !== undefined) r.character = s.c;
      });
      throw err;
    }
  };

  const services = {
    itemCatalogue: catalogue,
    describeItem: describeTemplate,
    conjurationMinute,
    findArrow(p) {
      expireConjured(p);
      let arrow = null;
      for (const item of rpgOf(p).inventory) {
        if (item.template !== 'arrow') continue;
        if (!arrow || (item.conjuredUntil ?? Infinity) < (arrow.conjuredUntil ?? Infinity)) arrow = item;
      }
      return arrow;
    },
    giveItem(p, template, quantity = 1, appearance) {
      const rpg = rpgOf(p);
      const it = withRollback([rpg], () => addItem(rpg, template, quantity, appearance));
      changed(p, 'give');
      return it;
    },
    takeItem(p, itemId, quantity = 1, opts) {
      const rpg = rpgOf(p);
      const rec = withRollback([rpg], () => removeItem(rpg, itemId, quantity, opts));
      changed(p, 'take');
      return rec;
    },
    /** Find the first unequipped item of `template` (for quests and trades). */
    findItem(p, template) {
      const r = resolveTemplate(template);
      return r ? rpgOf(p).inventory.find((i) => i.template === r.key && !i.conjuredUntil) || null : null;
    },
    countItem(p, template) {
      if (template === 'gold') return rpgOf(p).gold;
      const r = resolveTemplate(template);
      return r ? rpgOf(p).inventory.filter((i) => i.template === r.key && !i.conjuredUntil).reduce((n, i) => n + i.quantity, 0) : 0;
    },
    addGold: (p, n) => services.giveItem(p, 'gold', n),
    takeGold: (p, n) => services.takeItem(p, 'gold', n),
    /** Atomically move items/gold between two players. Validates both sides first. */
    transferItem(from, to, itemId, quantity = 1) {
      const a = rpgOf(from);
      const b = rpgOf(to);
      const rec = withRollback([a, b], () => {
        const moved = removeItem(a, itemId, quantity);
        insertRecord(b, moved);
        return moved;
      });
      changed(from, 'transfer');
      changed(to, 'transfer');
      return rec;
    },
    getEquippedWeapon(p) {
      const rpg = rpgOf(p);
      const w = itemIn(rpg, 'rightHand');
      return w ? { ...w } : { ...UNARMED };
    },
    getArmorValues: (p) => armorValues(rpgOf(p)),
    carriedWeight: (p) => carriedWeight(rpgOf(p)),
    maxEncumbrance: (p) => ctx.services.characterModifiers?.(p)?.encumbrance ?? maxEncumbrance(rpgOf(p)),
    /** Lower condition of an item (or 'weapon' for the readied weapon). Notifies on breakage. */
    damageItem(p, itemId, amount = 1) {
      const rpg = rpgOf(p);
      if (itemId === 'weapon') itemId = rpg.equipment.rightHand;
      const it = rpg.inventory.find((i) => i.id === itemId);
      if (!it) return false;
      const broke = wearItem(rpg, itemId, amount);
      ctx.dirty?.(p);
      if (broke) {
        say(p, `${it.name} has broken.`);
        changed(p, 'broken');
      }
      return broke;
    },
    /** Wear a random equipped armour piece covering `part` (or any). */
    damageArmor(p, amount = 1, part) {
      const rpg = rpgOf(p);
      const worn = SLOTS.map((s) => itemIn(rpg, s)).filter((i) => i?.covers && (!part || i.covers.includes(part)));
      if (!worn.length) return false;
      return services.damageItem(p, worn[Math.floor(Math.random() * worn.length)].id, amount);
    },
    /** Place a loot pile. contents: [{template, quantity}] or item records. */
    spawnLoot(location, x, z, contents, name = 'Treasure') {
      const recs = [];
      for (const c of contents || []) {
        if (c.conjuredUntil) continue;
        if (c.template === 'gold') { if (c.quantity > 0) recs.push({ template: 'gold', name: 'Gold pieces', quantity: int(c.quantity) }); continue; }
        if (c.id && c.template) { recs.push({ ...c }); continue; }
        const r = resolveTemplate(c.template);
        if (!r) throw new Error(`Unknown item "${c.template}".`);
        const d = describeTemplate(r.key);
        const q = Math.max(1, int(c.quantity, 1));
        if (d.stackable) recs.push(makeItem(r.key, q));
        else for (let n = 0; n < q; n++) recs.push(makeItem(r.key, 1));
      }
      if (!recs.length) return null;
      const id = `loot-${++lootSeq}`;
      for (const r of recs) delete r.equipped;
      ctx.entities.set(id, { id, kind: 'loot', name, location, x, z, yaw: 0, sprite: pileSprite(recs), count: recs.length });
      loot.set(id, { contents: recs, expires: ctx.now() + LOOT_LIFETIME_MS });
      return id;
    },
    lootContents: (id) => (loot.get(id)?.contents || []).map((r) => ({ ...r })),
  };
  Object.assign(ctx.services, services);

  // ----------------------------------------------------------------- ordinary items (package 7)
  bookLibrary = ctx.dataPath ? createBookLibrary(ctx.dataPath) : null;
  const findOwn = (p, itemId) => {
    const it = rpgOf(p).inventory.find((i) => i.id === itemId);
    if (!it) throw new Error('You do not have that item.');
    return it;
  };
  /** Full text of a readable item: books from the installed BOKnnnnn.TXT, letters from their record. */
  const readable = (it) => {
    if (it.group === 'book') {
      const b = it.bookId !== undefined ? bookLibrary?.read(it.bookId) : null;
      if (!b) throw new Error(`The pages of ${it.name} are blank: the game's books are not installed on this server.`);
      return { title: b.title, author: b.author, pages: b.pages, bookId: b.id };
    }
    if (it.letter) return { title: it.name, author: it.letter.from ?? null, pages: [Array.isArray(it.letter.lines) ? it.letter.lines.map(String) : []] };
    throw new Error(`There is nothing to read on ${it.name}.`);
  };
  Object.assign(services, {
    /** Installed classic books: {ids(), info(id), title(id), randomId(rand), read(id), count}. Null without game data. */
    books: bookLibrary,
    /** Title of a classic book id (quest dialogue, shelves). Null when unknown. */
    bookTitle: (id) => bookLibrary?.title(id) ?? null,
    /** A book item record for an installed book id (not yet given to anyone). */
    makeBook(bookId, variant = 0) {
      if (!bookLibrary?.has(bookId)) throw new Error(`Unknown book ${bookId}.`);
      const it = makeItem('book', 1, undefined, { bookId });
      applyVariant(it, variant);
      return it;
    },
    makeItemRecord: (template, quantity = 1, extra = null) => makeItem(resolveTemplate(template)?.key ?? template, quantity, undefined, extra),
    normalizeRecord,
    insertRecord(p, rec) {
      const rpg = rpgOf(p);
      const it = withRollback([rpg], () => insertRecord(rpg, normalizeItem(rec) ?? (() => { throw new Error('That item cannot be carried.'); })()));
      changed(p, 'insert');
      return it;
    },
    templateForClassic,
    templateForIndex,
    classicGroupTemplates,
    registerBases,
    readItem: (p, itemId) => readable(findOwn(p, itemId)),
    identifyItem(p, itemId) {
      const out = identify(rpgOf(p), String(itemId ?? ''));
      if (!out.already) changed(p, 'identify');
      return out;
    },
    unidentifiedItems: (p) => rpgOf(p).inventory.filter((i) => i.magic && i.magic.identified === false).map((i) => ({ ...i })),
    identifyCost,
    /** Spend item charges (condition). CastWhenUsed costs 10 (CastWhenUsed.durabilityLossOnUse). */
    useItemCharge(p, itemId, amount = 10) {
      const rpg = rpgOf(p);
      const it = findOwn(p, itemId);
      ctx.dirty?.(p);
      const broke = wearItem(rpg, it.id, amount);
      if (broke) {
        say(p, `${it.name} has broken.`);
        // A spent magic item is destroyed, as a broken item (DaggerfallUnityItem.LowerCondition).
        if (it.magic) rpg.inventory.splice(rpg.inventory.indexOf(it), 1);
      }
      changed(p, 'charge');
      return { remaining: Math.max(0, it.condition), broke };
    },
    /** Encumbrance in the classic sense: {carried, max, over, sinks}. `sinks`: DFU LevitateMotor (CarriedWeight*4 > 250). */
    encumbrance(p) {
      const rpg = rpgOf(p);
      const weight = unroundedCarriedWeight(rpg);
      const carried = round2(weight);
      const max = services.maxEncumbrance(p);
      return { carried, max, over: carried > max, sinks: weight * 4 > 250 };
    },
    /** True when `kg` more fits under the limit (pickups, purchases and rewards are refused otherwise). */
    canCarry: (p, kg) => carriedWeight(rpgOf(p)) + Math.max(0, Number(kg) || 0) <= services.maxEncumbrance(p),
    lightSource: (p) => rpgOf(p).lightSource ?? null,
  });
  Object.assign(ctx.services, services);

  ctx.onJoin((p) => {
    const rpg = rpgOf(p);
    const before = JSON.stringify(rpg.equipment);
    const restriction = restrictionFor(p);
    normalizeRpg(rpg, restriction);
    expireConjured(p);
    if (grantStarterKit(rpg, restriction) || JSON.stringify(rpg.equipment) !== before) ctx.dirty?.(p);
  });

  ctx.on?.('characterCreated', ({ player: p }) => {
    const rpg = rpgOf(p);
    const restriction = restrictionFor(p);
    const removed = SLOTS.map((slot) => itemIn(rpg, slot)).filter((item) => item && restriction(item));
    for (const item of removed) unequip(rpg, { itemId: item.id });
    if (removed.length) {
      changed(p, 'restricted');
      say(p, `Your class cannot equip ${removed.map((item) => item.name).join(', ')}.`);
    }
  });

  const reachable = (p, id) => {
    const e = ctx.entities.get(id);
    const pile = loot.get(id);
    if (!e || !pile || e.kind !== 'loot') throw new Error('There is nothing there to take.');
    if (e.location !== (p.rpg?.location ?? 'town:Daggerfall/Gothway Garden')) throw new Error('That is too far away.');
    if (Math.hypot(e.x - p.x, e.z - p.z) > LOOT_REACH) throw new Error('That is too far away.');
    return { e, pile };
  };
  const pileSprite = (contents) => {
    if (contents.length === 1) {
      const art = itemArt(contents[0], null, { ground: true });
      if (art) return { archive: art.archive, record: art.record };
    }
    return LOOT_HEAP_SPRITE;
  };
  const closePile = (id) => {
    ctx.entities.delete(id);
    loot.delete(id);
  };

  ctx.onAction('inventory.equip', (p, args = {}) => {
    expireConjured(p);
    const rpg = rpgOf(p);
    const msg = withRollback([rpg], () => equip(rpg, String(args.itemId ?? ''), args.slot ?? undefined, restrictionFor(p)));
    changed(p, 'equip');
    say(p, msg);
  });
  ctx.onAction('inventory.unequip', (p, args = {}) => {
    const rpg = rpgOf(p);
    const msg = withRollback([rpg], () => unequip(rpg, { itemId: args.itemId, slot: args.slot }));
    changed(p, 'unequip');
    say(p, msg);
  });
  const mapReader = createMapReader(ctx, { random: () => (typeof ctx.random === 'function' ? ctx.random : Math.random)() });
  ctx.onAction('inventory.use', (p, args = {}) => {
    const rpg = rpgOf(p);
    const itemId = String(args.itemId ?? '');
    const it = rpg.inventory.find((i) => i.id === itemId);
    // The Oghma Infinium is a book whose power is used, not read (OghmaInfiniumEffect).
    if (it && (it.group === 'book' || it.letter) && !it.magic?.enchantments?.length) return readAction(p, it);
    // Map items (both classic templates): reveal a place of the current region (server/rpg/items/mapItem.js).
    if (it && isMapItem(it)) {
      const out = mapReader.read(p, it, () => removeItem(rpg, it.id, 1));
      changed(p, 'use');
      say(p, out.text, { map: out });
      return;
    }
    if (!it) {
      const again = mapReader.repeat(p, itemId);
      if (again) { say(p, again.text, { map: again }); return; }
    }
    // Enchanted items and recipes: the enchanting owner (package 16, services.useMagicItem) handles artifacts,
    // recipes and charges; without it, CastWhenUsed goes straight to the spell owner below.
    // Non-wearables always go to it first (brewed potions, recipes, CastWhenUsed, artifacts); wearables only when
    // they carry a CastWhenUsed power, otherwise use = equip as in the classic inventory.
    // Used payloads: CastWhenUsed (type 0) and the artifact specials Sanguine Rose, Oghma, Skull and Azura's Star.
    const castable = !!it?.magic?.enchantments?.some?.((e) => e && (e.type === 0 || (e.type === 26 && [4, 5, 8, 9].includes(e.param))));
    if (it && (!isWearable(it) || castable)) {
      if (typeof ctx.services.useMagicItem === 'function') {
        const text = ctx.services.useMagicItem(p, it, args);
        if (text !== undefined) { changed(p, 'use'); say(p, text); return; }
      }
      if (castable && !isWearable(it)) return castFromItem(p, it, args);
    }
    if (it?.group === 'drug') {
      // DaggerfallInventoryWindow: drugs inflict their poison (Poisons 136-139 = template 78-81 + 58).
      if (typeof ctx.services.inflictPoison !== 'function') throw new Error(`Nothing happens when you take the ${it.name}.`);
      ctx.services.inflictPoison(p, { poison: it.index + 58, source: 'drug', itemName: it.name });
      withRollback([rpg], () => removeItem(rpg, it.id, 1));
      changed(p, 'use');
      say(p, `You take the ${it.name}.`);
      return;
    }
    const healthBefore = Number(rpg.character?.health) || 0;
    const msg = withRollback([rpg], () => useItem(rpg, itemId, restrictionFor(p)));
    changed(p, 'use');
    say(p, msg);
    // A healing potion reports like a healing spell: a private `heal` with what was restored.
    const healed = (Number(rpg.character?.health) || 0) - healthBefore;
    if (healed > 0) ctx.notify?.(p, { kind: 'heal', amount: healed });
  });
  function readAction(p, it) {
    const r = readable(it);
    ctx.notify?.(p, { kind: 'book', itemId: it.id, ...r });
    ctx.emit?.('itemRead', { player: p, item: { ...it }, bookId: r.bookId ?? null });
  }
  ctx.onAction('inventory.read', (p, args = {}) => readAction(p, findOwn(p, String(args.itemId ?? ''))));
  /** CastWhenUsed (enchantment type 0, param = SPELLS.STD index): the spell owner casts, then 10 charges are spent. */
  function castFromItem(p, it, args) {
    const ench = (it.magic.enchantments ?? []).find((e) => e && e.type === 0);
    if (!ench) throw new Error(`${it.name} has no power that can be used.`);
    if (it.condition <= 0) throw new Error(`${it.name} is spent.`);
    if (typeof ctx.services.castItemSpell !== 'function') throw new Error(`The magic of ${it.name} cannot be released yet.`);
    const castArgs = {};
    for (const k of ['targetId', 'yaw', 'pitch', 'recall']) if (args[k] !== undefined) castArgs[k] = args[k];
    ctx.services.castItemSpell(p, ench.param, castArgs, { itemName: it.name, itemId: it.id });
    services.useItemCharge(p, it.id, 10);
  }
  ctx.onAction('inventory.light', (p, args = {}) => {
    const rpg = rpgOf(p);
    const msg = withRollback([rpg], () => toggleLight(rpg, String(args.itemId ?? '')));
    changed(p, 'light');
    say(p, msg);
  });
  ctx.onAction('inventory.drop', (p, args = {}) => {
    const rpg = rpgOf(p);
    const itemId = String(args.itemId ?? '');
    const qty = args.quantity == null ? (itemId === 'gold' ? rpg.gold : rpg.inventory.find((i) => i.id === itemId)?.quantity ?? 1) : args.quantity;
    const rec = withRollback([rpg], () => removeItem(rpg, itemId, qty));
    const loc = rpg.location ?? 'town:Daggerfall/Gothway Garden';
    services.spawnLoot(loc, p.x, p.z, [rec], `${p.name}'s dropped items`);
    changed(p, 'drop');
    say(p, rec.template === 'gold' ? `Dropped ${rec.quantity} gold.` : `Dropped ${rec.quantity > 1 ? `${rec.quantity} × ` : ''}${rec.name}.`);
  });
  ctx.onAction('inventory.loot', (p, args = {}) => {
    const rpg = rpgOf(p);
    const id = String(args.targetId ?? '');
    const { e, pile } = reachable(p, id);
    const wanted = args.itemId == null ? pile.contents.slice() : pile.contents.filter((r) => r.id === args.itemId || (args.itemId === 'gold' && r.template === 'gold'));
    if (!wanted.length) throw new Error('That item is no longer there.');
    const addKg = wanted.reduce((kg, r) => kg + (r.template === 'gold' ? r.quantity / GOLD_PER_KG : r.weight * r.quantity), 0);
    if (carriedWeight(rpg) + addKg > services.maxEncumbrance(p)) throw new Error('You cannot carry that much.');
    withRollback([rpg], () => { for (const r of wanted) insertRecord(rpg, r); });
    pile.contents = pile.contents.filter((r) => !wanted.includes(r));
    if (!pile.contents.length) closePile(id);
    else {
      e.count = pile.contents.length;
      e.sprite = pileSprite(pile.contents);
      ctx.notify?.(p, { kind: 'loot', targetId: id, name: e.name, items: pile.contents.map((r) => ({ ...r })) });
    }
    changed(p, 'loot');
    const names = wanted.map((r) => (r.template === 'gold' ? `${r.quantity} gold` : r.quantity > 1 ? `${r.quantity} × ${r.name}` : r.name));
    say(p, `You take ${names.join(', ')}.`, {
      artItems: wanted.slice(0, 4).map(({ template, icon, variant }) => ({ template, icon, variant })),
    });
  });
  ctx.onAction('inventory.inspectLoot', (p, args = {}) => {
    const { e, pile } = reachable(p, String(args.targetId ?? ''));
    ctx.notify?.(p, { kind: 'loot', targetId: e.id, name: e.name, items: pile.contents.map((r) => ({ ...r })) });
  });

  // Monsters leave a loot pile with gold and sometimes an item. A combat feature that awards
  // loot itself sets `noLoot` on the payload or entity (see client/gameplay/inventory/CONTRACT.md).
  ctx.on?.('kill', ({ player, entity, noLoot } = {}) => {
    if (!entity || entity.kind !== 'monster' || noLoot || entity.noLoot) return;
    const lvl = Math.max(1, int(entity.level, Math.ceil((entity.maxHp || 10) / 10)));
    const contents = [{ template: 'gold', quantity: 1 + Math.floor(Math.random() * 10 * lvl) }];
    const roll = Math.random();
    if (roll < 0.25) contents.push({ template: 'potion-of-healing', quantity: 1 });
    else if (roll < 0.4) contents.push({ template: 'arrow', quantity: 3 + Math.floor(Math.random() * 8) });
    else if (roll < 0.5) contents.push({ template: ['iron-dagger', 'iron-shortsword', 'iron-mace', 'leather-helm', 'chain-boots'][Math.floor(Math.random() * 5)], quantity: 1 });
    else if (roll < 0.56) contents.push({ template: ['amber', 'pearl', 'ruby'][Math.floor(Math.random() * 3)], quantity: 1 });
    const id = services.spawnLoot(entity.location, entity.x, entity.z, contents, `${entity.name || 'Monster'}'s remains`);
    if (player && id) say(player, `${entity.name || 'The creature'} dropped something.`, { targetId: id });
  });

  ctx.on?.('timeSpent', ({ player }) => expireConjured(player));
  let lastExpiryCheck = -Infinity;
  ctx.onTick((_dt, now) => {
    for (const [id, pile] of loot) if (now >= pile.expires) closePile(id);
    if (now - lastExpiryCheck < 500) return;
    lastExpiryCheck = now;
    for (const p of ctx.players?.values?.() ?? []) expireConjured(p);
  });

  // Held lights burn one condition point per 20 s while lit (EnablePlayerTorch). Saved by the periodic save.
  let lastBurn = null;
  ctx.onTick((_dt, now) => {
    if (lastBurn === null) { lastBurn = now; return; }
    if (now - lastBurn < LIGHT_TICK_MS) return;
    lastBurn = now;
    for (const p of ctx.players?.values?.() ?? []) {
      if (!p.rpg?.lightSource) continue;
      const out = burnLight(p.rpg);
      if (!out) continue;
      ctx.dirty?.(p);
      if (out.burnedOut) {
        say(p, `Your ${out.name} has burned out.`);
        ctx.emit?.('inventoryChanged', { player: p, reason: 'light' });
      }
    }
  });

  return { services, loot };
}
