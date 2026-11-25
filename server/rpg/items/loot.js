// Classic loot generation as data plus small generators. Every rule cites its Daggerfall Unity source (MIT,
// (c) 2009-2023 Daggerfall Workshop, revision 3d85a283672a4955e32992097ea7719e896dbadb):
//   Game/Items/LootTables.cs            loot chance matrices A-U, dungeon-type keys, GenerateRandomLoot
//   Internal/DaggerfallLoot.cs          GenerateItems, RandomlyAddMap/Potion/PotionRecipe, StockShopShelf,
//                                       StockHouseContainer, CreateStockedDate
//   Internal/DaggerfallLootDataTables.cs shop item groups, private-property item groups, treasure icon records
//   Game/Items/ItemBuilder.cs           CreateRandomWeapon/Armor/Clothing/Book/ReligiousItem/Gem/Jewellery/Ingredient
//   Game/Formulas/FormulaHelper.cs      RandomMaterial, RandomArmorMaterial
//
// Output is a list of item specs `{template, quantity?, variant?, extra?}` for inventory.makeItemRecord / giveItem.
// `rand()` returns [0,1) (Unity Random.Range stand-in) so stocking can be seeded.

import { BASES, MATERIALS, classicGroupTemplates } from '../inventory.js';
import { CLOTH_DYES } from '../../../client/gameplay/inventory/dyes.js';

const between = (rand, min, maxInclusive) => min + Math.floor(rand() * (maxInclusive - min + 1));
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
/** Dice100.SuccessRoll: Random.Range(0, 100) < chance. */
const success = (rand, chance) => Math.floor(rand() * 100) < chance;

// LootTables.DefaultLootTables: key, MinGold, MaxGold, P1, P2, C1, C2, C3, M1, AM, WP, MI, CL, BK, M2, RL.
const MATRIX_ROWS = [
  ['-', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ['A', 1, 10, 0, 0, 0, 0, 0, 0, 5, 5, 2, 4, 0, 2, 0],
  ['B', 0, 0, 10, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  ['C', 2, 20, 10, 10, 5, 5, 5, 5, 5, 25, 3, 0, 2, 2, 2],
  ['D', 1, 4, 6, 6, 6, 6, 6, 6, 0, 0, 0, 0, 0, 0, 4],
  ['E', 20, 80, 0, 0, 0, 0, 0, 0, 10, 10, 3, 4, 2, 1, 15],
  ['F', 4, 30, 2, 2, 5, 5, 5, 2, 50, 50, 1, 0, 0, 3, 0],
  ['G', 3, 15, 0, 0, 0, 0, 0, 0, 50, 50, 1, 5, 0, 3, 0],
  ['H', 2, 10, 0, 0, 0, 0, 0, 0, 0, 100, 1, 2, 0, 0, 0],
  ['I', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 5],
  ['J', 50, 150, 0, 0, 0, 0, 0, 0, 5, 5, 3, 0, 0, 0, 0],
  ['K', 1, 10, 3, 3, 3, 3, 3, 3, 5, 5, 3, 0, 5, 2, 100],
  ['L', 1, 20, 0, 0, 3, 3, 3, 3, 50, 50, 1, 75, 0, 5, 3],
  ['M', 1, 15, 1, 1, 1, 1, 1, 2, 10, 10, 1, 15, 2, 3, 1],
  ['N', 1, 80, 5, 5, 5, 5, 5, 5, 5, 5, 1, 20, 5, 2, 5],
  ['O', 5, 20, 1, 1, 1, 1, 1, 1, 10, 15, 2, 0, 0, 0, 0],
  ['P', 5, 20, 5, 5, 5, 5, 5, 5, 5, 10, 2, 0, 10, 5, 0],
  ['Q', 20, 80, 2, 2, 8, 8, 8, 2, 10, 25, 3, 35, 5, 3, 0],
  ['R', 5, 20, 0, 0, 3, 3, 3, 5, 5, 15, 2, 0, 0, 0, 0],
  ['S', 50, 125, 5, 5, 5, 5, 5, 15, 10, 10, 3, 0, 5, 5, 0],
  ['T', 20, 80, 0, 0, 0, 0, 0, 0, 100, 100, 1, 0, 0, 0, 0],
  ['U', 7, 30, 5, 5, 5, 5, 5, 10, 10, 10, 2, 0, 2, 2, 10],
];
const FIELDS = ['key', 'MinGold', 'MaxGold', 'P1', 'P2', 'C1', 'C2', 'C3', 'M1', 'AM', 'WP', 'MI', 'CL', 'BK', 'M2', 'RL'];
export const LOOT_MATRICES = Object.freeze(Object.fromEntries(MATRIX_ROWS.map((r) => [r[0], Object.freeze(Object.fromEntries(FIELDS.map((f, i) => [f, r[i]])))])));

/** LootTables.GenerateLoot: dungeon type (DFRegion.DungeonTypes 0-18) -> matrix key. */
export const DUNGEON_LOOT_KEYS = Object.freeze(['K', 'N', 'N', 'N', 'K', 'M', 'M', 'Q', 'K', 'U', 'D', 'N', 'L', 'F', 'S', 'N', 'M', 'L', 'N']);

/** DaggerfallLootDataTables.randomTreasureIconIndices (TEXTURE.216 records for random treasure piles). */
export const TREASURE_ICON_RECORDS = Object.freeze([0, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 37, 43, 44, 45, 46, 47]);
export const TREASURE_ARCHIVE = 216;

/** DaggerfallLoot.CreateStockedDate: year * 1000 + day of year. `clock` is server/rpg/atmosphere worldClock(). */
export function stockedDate(clock) {
  if (!clock) return 0;
  const year = Number(clock.year) || 0;
  const doy = Number.isFinite(clock.dayOfYear) ? clock.dayOfYear : Number.isFinite(clock.day) && Number.isFinite(clock.month) ? clock.month * 30 + clock.day : 0;
  return year * 1000 + doy;
}

// --------------------------------------------------------------- base item generators (ItemBuilder)

const MATERIALS_BY_MODIFIER = [64, 128, 10, 21, 13, 8, 5, 3, 2, 5]; // ItemBuilder.materialsByModifier

/** FormulaHelper.RandomMaterial(playerLevel): weapon material name. */
export function randomMaterial(level, rand) {
  let mod = level - 10;
  mod = mod >= 0 ? mod * 2 : mod * 4;
  let combined = Math.max(0, Math.min(256, mod + Math.floor(rand() * 256)));
  let m = 0;
  while (m < MATERIALS_BY_MODIFIER.length - 1 && MATERIALS_BY_MODIFIER[m] < combined) combined -= MATERIALS_BY_MODIFIER[m++];
  return MATERIALS.weapon[m];
}

/** FormulaHelper.RandomArmorMaterial: 70-89 chain, 90+ plate of RandomMaterial, otherwise leather. */
export function randomArmorMaterial(level, rand) {
  const roll = between(rand, 1, 100);
  if (roll >= 90) return randomMaterial(level, rand);
  if (roll >= 70) return 'chain';
  return 'leather';
}

const byIndex = (lo, hi) => Object.entries(BASES).filter(([, b]) => b.index >= lo && b.index <= hi && (b.group === 'weapon' || b.group === 'armor' || b.group === 'shield' || b.group === 'ammo'))
  .sort((a, b) => a[1].index - b[1].index).map(([k]) => k);
const WEAPONS = byIndex(113, 131); // Weapons enum order, Dagger..Arrow
const ARMOR = byIndex(102, 112); // Armor enum order, Cuirass..Tower Shield

/** ItemBuilder.CreateRandomWeapon: any weapon (arrows come as 1-20) in RandomMaterial. */
export function randomWeapon(level, rand) {
  const base = pick(rand, WEAPONS);
  if (BASES[base].group === 'ammo') return { template: base, quantity: between(rand, 1, 20) };
  return { template: `${randomMaterial(level, rand)}-${base}` };
}

/** ItemBuilder.CreateRandomArmor: any armour piece or shield in RandomArmorMaterial (shields have no material here). */
export function randomArmor(level, rand) {
  const base = pick(rand, ARMOR);
  if (BASES[base].group === 'shield') return { template: base };
  return { template: `${randomArmorMaterial(level, rand)}-${base}` };
}

const CLOTHES = Object.entries(BASES).filter(([, b]) => b.group === 'clothing');
/** ItemBuilder.CreateRandomClothing: a garment the wearer's sex has, random dye and variant. */
export function randomClothing(gender, rand) {
  const female = gender === 'female';
  const list = CLOTHES.filter(([, b]) => (female ? b.clothing.female : b.clothing.male) !== null);
  const [base, b] = pick(rand, list.length ? list : CLOTHES);
  const dye = pick(rand, Object.keys(CLOTH_DYES));
  const variants = female ? b.clothing.femaleVariants : b.clothing.maleVariants;
  return { template: `${dye}-${base}`, variant: Math.floor(rand() * Math.max(1, variants)) };
}

/** A random item of a classic group by name (ItemBuilder.CreateRandomGem/Jewellery/ReligiousItem/Ingredient/Drug). */
export function randomOfGroup(groupName, rand) {
  const list = classicGroupTemplates(groupName);
  return list.length ? { template: pick(rand, list) } : null;
}

/** ItemBuilder.CreateRandomBook: a uniformly chosen installed book with a random variant (0-1). */
export function randomBook(books, rand) {
  const id = books?.randomId(rand);
  return id === null || id === undefined ? null : { template: 'book', variant: Math.floor(rand() * 2), extra: { bookId: id } };
}

// --------------------------------------------------------------- loot tables

/**
 * LootTables.GenerateRandomLoot(matrix, player). The first four ingredient categories scale with player level, the
 * others do not; each category rolls repeatedly at halved chance. Magic items are delegated to `magicItem(rand)`
 * (package 16 owns MAGIC.DEF regular items); without it the roll is reported in `skipped`.
 * @returns {{items: object[], skipped: string[]}}
 */
export function generateRandomLoot(matrixKey, { level = 1, gender = 'male', rand = Math.random, books = null, magicItem = null } = {}) {
  const m = LOOT_MATRICES[matrixKey] ?? LOOT_MATRICES['-'];
  const items = [];
  const skipped = [];
  const lvl = Math.max(1, level | 0);
  const gold = between(rand, m.MinGold, m.MaxGold) * lvl;
  if (gold > 0) items.push({ template: 'gold', quantity: gold });
  const repeat = (chance, make) => {
    for (let c = chance; success(rand, Math.trunc(c)); c *= 0.5) {
      const it = make();
      if (it) items.push(it);
    }
  };
  repeat(m.WP, () => randomWeapon(lvl, rand));
  repeat(m.AM, () => randomArmor(lvl, rand));
  repeat(m.C1 * lvl, () => randomOfGroup('CreatureIngredients1', rand));
  repeat(m.C2 * lvl, () => randomOfGroup('CreatureIngredients2', rand));
  repeat(m.C3, () => randomOfGroup('CreatureIngredients3', rand));
  repeat(m.P1 * lvl, () => randomOfGroup('PlantIngredients1', rand));
  repeat(m.P2 * lvl, () => randomOfGroup('PlantIngredients2', rand));
  repeat(m.M1, () => randomOfGroup('MiscellaneousIngredients1', rand));
  repeat(m.M2, () => randomOfGroup('MiscellaneousIngredients2', rand));
  repeat(m.MI, () => {
    const it = typeof magicItem === 'function' ? magicItem(rand) : null;
    if (!it) skipped.push('magicItem');
    return it;
  });
  repeat(m.CL, () => randomClothing(gender, rand));
  repeat(m.BK, () => {
    const it = randomBook(books, rand);
    if (!it) skipped.push('book');
    return it;
  });
  repeat(m.RL, () => randomOfGroup('ReligiousItems', rand));
  return { items, skipped };
}

/**
 * DaggerfallLoot.GenerateItems(key): the matrix's random loot, plus for keys J-O a map, potion and potion-recipe
 * chance (2/1/1/2/2/15 %, 4 %, 2 %; RandomlyAddMap/Potion/PotionRecipe). Maps, potions and recipes are reported in
 * `skipped` unless the caller supplies them (`extras.map/potion/recipe(rand)` -> item spec).
 */
export function generateItems(key, opts = {}) {
  const out = generateRandomLoot(key, opts);
  const rand = opts.rand ?? Math.random;
  const alpha = String(key).charCodeAt(0) - 64;
  if (alpha >= 10 && alpha <= 15) {
    const add = (chance, name) => {
      if (!success(rand, chance)) return;
      const it = opts.extras?.[name]?.(rand);
      if (it) out.items.push(it); else out.skipped.push(name);
    };
    add([2, 1, 1, 2, 2, 15][alpha - 10], 'map');
    add(4, 'potion');
    add(2, 'recipe');
  }
  return { key, ...out };
}

/** Random treasure of a dungeon (LootTables.GenerateLoot): GenerateItems with the dungeon type's matrix key. */
export function dungeonTreasure(dungeonType, opts = {}) {
  return generateItems(DUNGEON_LOOT_KEYS[dungeonType] ?? 'N', opts);
}

// ItemGroups ids used by the private-property tables (ItemEnums.cs).
const GROUP_BY_ID = {
  0: 'Drugs', 2: 'Armor', 3: 'Weapons', 4: 'MagicItems', 6: 'MensClothing', 7: 'Books', 9: 'UselessItems2',
  10: 'ReligiousItems', 11: 'Maps', 12: 'WomensClothing', 13: 'Paintings', 14: 'Gems', 15: 'PlantIngredients1',
  16: 'PlantIngredients2', 17: 'CreatureIngredients1', 18: 'CreatureIngredients2', 19: 'CreatureIngredients3',
  20: 'MiscellaneousIngredients1', 21: 'MetalIngredients', 22: 'MiscellaneousIngredients2', 25: 'Jewellery',
};

// DaggerfallLootDataTables.privatePropertyItemsModels*, indexed by DFLocation.BuildingTypes (0-23).
const H = (...rows) => rows.map((r) => Object.freeze(r));
export const PRIVATE_PROPERTY = Object.freeze({
  models0to1: H([6, 12], [6, 12], [2, 6, 12], [6, 12], [2, 6, 12], [6, 12], [6, 12], [6, 12], [6, 12], [6, 12], [6, 12], [2, 6, 12], [2, 6, 12], [2, 6, 12], [6, 12], [6, 12], [2, 6, 12], [2, 6, 12], [6, 12], [6, 12], [6, 12], [6, 12], [6, 12], [6, 12]),
  models2to3: H([6, 9, 12], [6, 9, 12], [3, 6, 9, 12], [7, 9, 11], [9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20, 25], [7, 9, 11], [6, 9, 12], [6, 9, 12], [9, 11, 14, 25], [9, 10], [9, 11], [3, 9, 10, 11], [3, 9, 11], [3, 9], [7, 9, 10, 11, 14], [3, 9, 10], [3, 9, 10, 11, 25], [3, 9, 10, 11], [6, 9, 12], [6, 9, 12], [6, 9, 12], [6, 9, 12], [6, 9, 12], [6, 9, 12]),
  models4to10: H([7, 14, 15, 16, 17, 18, 19, 21], [9, 21], [9, 21], [7, 25], [9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20], [7, 9, 10, 11], [6, 9, 10, 12, 15, 16], [9], [7, 9, 10, 21], [9], [9, 13], [9, 10, 13], [9, 10], [9, 10, 21], [4, 9, 10, 20], [9, 15, 16], [7, 9, 13, 20], [7, 9, 13, 20], [9, 10], [9, 10], [9, 10], [9, 10], [9, 10], [9, 10]),
  models11to14: H([7, 9, 20], [7, 9, 20], [3, 6, 9, 12], [9, 13, 14], [2, 3, 9], [7, 9], [6, 9, 12], [9], [3, 9, 21, 14], [9, 10], [9], [9, 3, 14], [9, 13, 25], [3, 9, 10, 21], [7, 9, 10], [6, 9, 12], [4, 7, 9, 13, 25], [7, 9, 13, 25], [3, 9], [3, 9], [3, 9], [3, 9], [3, 9], [3, 9]),
  models15up: H([15, 16, 17, 18, 19, 21], [2, 21], [2, 21], [13, 25], [2, 3, 4, 13, 14, 15, 16, 17, 18, 19, 21], [7, 13], [6, 9, 12, 15, 16], [9, 13], [9, 21], [9], [9, 13], [2, 9, 13], [2, 3, 9], [3, 9, 21], [9, 10, 13], [9, 15, 16], [9, 13, 25], [9, 13, 25], [6, 9, 12], [6, 9, 12], [6, 9, 12], [6, 9, 12], [6, 9, 12], [6, 9, 12]),
});

/** DaggerfallLoot.StockHouseContainer's table choice by furniture model record (ModelIdNum % 100). */
export function privatePropertyList(buildingType, modelRecord) {
  if (!(buildingType >= 0 && buildingType <= 23)) return null;
  const t = modelRecord >= 15 ? 'models15up' : modelRecord >= 11 ? 'models11to14' : modelRecord >= 4 ? 'models4to10' : modelRecord >= 2 ? 'models2to3' : 'models0to1';
  return PRIVATE_PROPERTY[t][buildingType] ?? null;
}

/**
 * DaggerfallLoot.StockHouseContainer: one group chosen from the furniture's list; items of it are added while
 * DFRandom % 100 <= continueChance, which halves after each item (always at least one item).
 * @returns {{items: object[], skipped: string[]}}
 */
export function stockHouseContainer(buildingType, modelRecord, { level = 1, gender = 'male', rand = Math.random, books = null, magicItem = null } = {}) {
  const list = privatePropertyList(buildingType, modelRecord);
  const items = [];
  const skipped = [];
  if (!list) return { items, skipped };
  const groupId = pick(rand, list);
  const group = GROUP_BY_ID[groupId];
  let chance = 100;
  for (;;) {
    let it = null;
    if (group === 'MensClothing' || group === 'WomensClothing') it = randomClothing(gender, rand);
    else if (group === 'MagicItems') { it = typeof magicItem === 'function' ? magicItem(rand) : null; if (!it) skipped.push('magicItem'); }
    else if (group === 'Books') { it = randomBook(books, rand); if (!it) skipped.push('book'); }
    else if (group === 'Weapons') it = randomWeapon(level, rand);
    else if (group === 'Armor') it = randomArmor(level, rand);
    else if (group) { it = randomOfGroup(group, rand); if (!it) skipped.push(group); }
    if (it) items.push(it);
    chance >>= 1;
    if (Math.floor(rand() * 32768) % 100 > chance) break;
  }
  return { items, skipped, group };
}

// DaggerfallLootDataTables.itemGroups<Shop>: pairs of (ItemGroups id, chance modifier).
export const SHOP_ITEM_GROUPS = Object.freeze({
  0: [14, 30, 15, 50, 16, 50, 17, 30, 18, 20, 19, 20, 20, 60, 21, 40, 22, 30], // Alchemist
  2: [2, 80, 3, 20], // Armorer
  5: [7, 40, 11, 5], // Bookseller
  6: [6, 50, 12, 50], // Clothing store
  8: [14, 40, 25, 50], // Gem store
  9: [3, 20, 6, 10, 7, 10, 9, 50, 23, 0, 12, 10, 4, 0], // General store
  12: [2, 10, 3, 10, 4, 10, 7, 10, 9, 20, 13, 5, 14, 10, 25, 10, 10, 10], // Pawn shop
  13: [2, 30, 3, 70], // Weapon smith
});

/** Shelf books (DaggerfallLoot.StockShopShelf Books branch): (quality+3)/5, minus one at 4+, plus one; that many + 1. */
export function shelfBookCount(quality) {
  let q = Math.trunc((quality + 3) / 5);
  if (q >= 4) q -= 1;
  q += 1;
  return q + 1;
}
