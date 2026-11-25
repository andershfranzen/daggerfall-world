// Classic shop shelf stock (server side): which catalogue items a shelf holds, by building type, shop quality and the
// level of the player who opens it, re-rolled once per game day.
//
// Rules follow Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop), revision 3d85a283:
//   - DaggerfallLoot.StockShopShelf: per item group of the shop, every template whose rarity <= shop quality is stocked
//     with chance chanceMod * 5 * (21 - rarity) / 100 %; weapons/armour take FormulaHelper.RandomMaterial /
//     RandomArmorMaterial for the player's level; general stores always add a Horse and a Small Cart.
//   - DaggerfallLootDataTables.itemGroups<Shop> (group, chanceMod pairs).
//   - DaggerfallInterior: every shelf prop of a shop is its own container, stocked on its own.
//   - DaggerfallLoot.CreateStockedDate: a shelf is re-stocked when opened on a later day than it was stocked.
//   - ItemTemplates.txt rarity, ItemEnums.cs group membership (TEMPLATE_RARITY / TEMPLATE_GROUP below are facts copied
//     from those files).
//   - DaggerfallLoot.RandomlyAddPotionRecipe(25): every alchemist shelf has a 25 % chance of one potion recipe. Classic
//     alchemists do not shelve potions; potions are sold by package 16's potion merchants (Mages Guild, temples).
//   - ItemGroups.MagicItems (pawnshops, chanceMod 10; general stores, chanceMod 0): GetItemTemplate(MagicItems, 0) reads
//     template 0 (Ruby, rarity 10), so a shop of quality >= 10 rolls chanceMod * 5 * 11 / 100 % for one
//     ItemBuilder.CreateRandomMagicItem (package 16's MAGIC.DEF items, unidentified).
//   - Furniture stores: StockShopShelf has no case for them (itemGroups stays {0}), so their shelves hold nothing,
//     although DaggerfallLootDataTables lists itemGroupsFurnitureStore (paintings). Their shelves stay empty here too.
// Groups without catalogue items contribute nothing until those items exist.

import * as inventory from '../inventory.js';
const { BASES, MATERIALS } = inventory;
import { CLOTH_DYES } from '../../../client/gameplay/inventory/dyes.js';
import { BUILDING, ITEM_GROUP, ITEM_GROUP_NAME, d100, rng, seedOf } from '../../../client/gameplay/economy/rules.js';

const G = ITEM_GROUP;

/** DaggerfallLootDataTables.itemGroups<Shop>: [group, chanceMod, …]. */
export const SHOP_GROUPS = Object.freeze({
  [BUILDING.Alchemist]: [0x0E, 0x1E, 0x0F, 0x32, 0x10, 0x32, 0x11, 0x1E, 0x12, 0x14, 0x13, 0x14, 0x14, 0x3C, 0x15, 0x28, 0x16, 0x1E],
  [BUILDING.Armorer]: [0x02, 0x50, 0x03, 0x14],
  [BUILDING.Bookseller]: [0x07, 0x28, 0x0B, 0x05],
  [BUILDING.ClothingStore]: [0x06, 0x32, 0x0C, 0x32],
  [BUILDING.FurnitureStore]: [0x0D, 0x14],
  [BUILDING.GemStore]: [0x0E, 0x28, 0x19, 0x32],
  [BUILDING.GeneralStore]: [0x03, 0x14, 0x06, 0x0A, 0x07, 0x0A, 0x09, 0x32, 0x17, 0x00, 0x0C, 0x0A, 0x04, 0x00],
  [BUILDING.PawnShop]: [0x02, 0x0A, 0x03, 0x0A, 0x04, 0x0A, 0x07, 0x0A, 0x09, 0x14, 0x0D, 0x05, 0x0E, 0x0A, 0x19, 0x0A, 0x0A, 0x0A],
  [BUILDING.WeaponSmith]: [0x02, 0x1E, 0x03, 0x46],
});

/** ItemTemplates.txt `rarity` by template index (0..287). */
export const TEMPLATE_RARITY = Object.freeze([10, 14, 15, 15, 5, 6, 13, 7, 1, 2, 3, 3, 3, 4, 3, 3, 2, 2, 3, 4, 3, 6, 4, 4, 8, 5, 6, 6, 3, 4, 5, 4, 5, 8, 10, 12, 16, 20, 15, 13, 14, 7, 9, 4, 12, 20, 20, 8, 4, 15, 11, 12, 16, 20, 16, 18, 6, 3, 1, 1, 1, 5, 3, 2, 4, 13, 4, 4, 10, 6, 3, 4, 6, 6, 8, 12, 10, 12, 1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 2, 2, 3, 4, 4, 6, 7, 10, 13, 15, 16, 16, 17, 18, 3, 3, 3, 3, 3, 3, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 4, 2, 4, 3, 5, 2, 2, 1, 1, 1, 1, 2, 3, 5, 3, 3, 3, 3, 3, 1, 2, 6, 1, 1, 3, 3, 1, 1, 3, 3, 3, 4, 3, 3, 1, 1, 3, 3, 1, 1, 3, 1, 3, 5, 2, 2, 1, 1, 2, 3, 5, 6, 3, 3, 1, 1, 1, 2, 6, 1, 1, 3, 3, 1, 1, 3, 3, 3, 4, 3, 3, 1, 3, 3, 1, 3, 2, 4, 2, 4, 5, 8, 1, 3, 4, 6, 1, 2, 3, 4, 3, 5, 2, 1, 2, 4, 4, 6, 6, 4, 2, 3, 2, 4, 1, 3, 2, 6, 2, 2, 1, 8, 6, 6, 3, 1, 4, 1, 3, 3, 2, 3, 4, 6, 2, 7, 5, 8, 9, 13, 12, 15, 0, 0, 9, 0, 0, 3, 3, 3, 3, 3, 0, 0, 0]);

/** ItemEnums.cs: classic ItemGroups id of each template index (-1 = none). Plant ingredients take their later group. */
export const TEMPLATE_GROUP = Object.freeze([14, 14, 14, 14, 14, 14, 14, 14, 16, 16, 16, 16, 16, 16, 15, 16, 16, 16, 15, 15, 15, 16, 16, 15, 16, 15, 16, 16, 16, 16, 16, 16, 16, 17, 19, 17, 19, 19, 17, 17, 17, 17, 17, 17, 17, 17, 18, 18, 18, 18, 17, 17, 18, 17, 17, 20, 20, 20, 20, 20, 20, 17, 20, 20, 20, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 22, 22, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 23, 23, 23, 23, 23, 23, -1, -1, -1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 27, 25, 25, 25, 25, 25, 25, 25, 25, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, -1, 9, 9, 9, -1, -1, 9, 9, 26, 26, 26, 26, 10, 10, 10, 10, 10, 10, 10, 10, -1, 10, 10, 10, 10, 10, -1, -1, 27, 27, 28, 7, 27, 9, 26, 27, 26, 26, 13, 27, 27, 27]);

/** ItemBuilder.materialsByModifier (Iron … Daedric). */
const MATERIALS_BY_MODIFIER = [64, 128, 10, 21, 13, 8, 5, 3, 2, 5];

/** FormulaHelper.RandomMaterial: index into the weapon materials (0 iron … 9 daedric). */
export function randomMaterial(level, r) {
  let mod = Math.trunc(level) - 10;
  mod = mod >= 0 ? mod * 2 : mod * 4;
  let combined = Math.max(0, Math.min(256, mod + Math.floor(r() * 256)));
  let m = 0;
  while (m < MATERIALS_BY_MODIFIER.length - 1 && MATERIALS_BY_MODIFIER[m] < combined) combined -= MATERIALS_BY_MODIFIER[m++];
  return m;
}

/** FormulaHelper.RandomArmorMaterial as a catalogue armour material ('leather', 'chain' or a plate metal). */
export function randomArmorMaterial(level, r) {
  const roll = d100(r);
  if (roll >= 90) return MATERIALS.weapon[randomMaterial(level, r)];
  if (roll >= 70) return 'chain';
  return 'leather';
}

/** Group id of a catalogue base (its classic template index), honouring catalogue groups for shared indices. */
export function baseGroup(base) {
  const b = BASES[base];
  if (!b) return -1;
  if (b.group === 'potion') return -1; // potions share the Glass Bottle template; see POTION_SHOPS
  if (b.group === 'clothing') return b.index >= 182 ? G.WomensClothing : G.MensClothing;
  return Number.isInteger(b.index) ? TEMPLATE_GROUP[b.index] ?? -1 : -1;
}
export const baseRarity = (base) => TEMPLATE_RARITY[BASES[base]?.index] ?? 1;

/** Catalogue bases by classic group (recomputed lazily: other packages add bases to the catalogue at load time). */
let byGroupCache = null;
function basesByGroup() {
  if (byGroupCache && byGroupCache.size === Object.keys(BASES).length) return byGroupCache.groups;
  const groups = new Map();
  for (const base of Object.keys(BASES)) {
    const g = baseGroup(base);
    if (g < 0) continue;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(base);
  }
  byGroupCache = { size: Object.keys(BASES).length, groups };
  return groups;
}

/** DaggerfallLoot.RandomlyAddPotionRecipe chance on every alchemist shelf. */
export const RECIPE_CHANCE = 25;
/** Rarity of template 0 (Ruby), which StockShopShelf reads for the single MagicItems "template". */
const MAGIC_ITEM_RARITY = TEMPLATE_RARITY[0];

const dyes = Object.keys(CLOTH_DYES);

/** Groups stocked from the hand-made catalogue (materials, dyes); every other group comes from the classic templates. */
const HAND_MADE = new Set([G.Weapons, G.Armor, G.MensClothing, G.WomensClothing]);
/** Template keys of a classic group with their classic template index (package 7's generated catalogue). */
function classicMembers(group) {
  const keys = typeof inventory.classicGroupTemplates === 'function' ? inventory.classicGroupTemplates(ITEM_GROUP_NAME[group]) : [];
  const out = [];
  for (const key of keys) {
    let index = null;
    try {
      index = inventory.describeTemplate(key)?.index ?? null;
    } catch {
      continue;
    }
    if (Number.isInteger(index)) out.push({ key, index });
  }
  if (!out.length) for (const base of basesByGroup().get(group) ?? []) out.push({ key: base, index: BASES[base].index });
  return out;
}

/** DaggerfallLoot.StockShopShelf book count: ((quality + 3) / 5, less one from 4, plus one) + 1 random books. */
export function shelfBooks(quality) {
  let q = Math.trunc((Math.trunc(quality) + 3) / 5);
  if (q >= 4) q--;
  q++;
  return q + 1;
}

/**
 * Stock of one shelf. Returns [{template, quantity, extra?}] in catalogue keys.
 * @param {{buildingType:number, quality:number, level:number, seed:string, female?:boolean, resolve:(key)=>boolean,
 *   randomBook?:(rand)=>number|null, randomRecipe?:(rand)=>{template,extra}|null,
 *   randomMagic?:(rand, level)=>{template,extra}|null}} o
 */
export function stockShelf({ buildingType, quality, level = 1, seed, female = false, resolve = () => true, randomBook = null, randomRecipe = null, randomMagic = null }) {
  if (buildingType === BUILDING.FurnitureStore) return []; // StockShopShelf: no case, nothing stocked (see above)
  const table = SHOP_GROUPS[buildingType];
  if (!table) return [];
  const r = rng(seedOf(seed));
  const out = [];
  const add = (template, quantity = 1, extra = null) => { if (resolve(template)) out.push({ template, quantity, ...(extra ? { extra } : {}) }); };
  if (buildingType === BUILDING.GeneralStore) {
    add('horse');
    add('small-cart');
  }
  if (buildingType === BUILDING.Alchemist && randomRecipe && d100(r) <= RECIPE_CHANCE) {
    const rec = randomRecipe(r);
    if (rec?.template) add(rec.template, 1, rec.extra ?? null);
  }
  const groups = basesByGroup();
  for (let i = 0; i < table.length; i += 2) {
    let group = table[i];
    const chanceMod = table[i + 1];
    if (group === G.MensClothing && female) group = G.WomensClothing;
    if (group === G.WomensClothing && !female) group = G.MensClothing;
    if (group === G.Furniture || group === G.UselessItems1 || group === G.Transportation) continue; // transport: added above
    if (group === G.MagicItems) {
      if (MAGIC_ITEM_RARITY > quality || !randomMagic) continue;
      if (d100(r) <= Math.trunc(chanceMod * 5 * (21 - MAGIC_ITEM_RARITY) / 100)) {
        const m = randomMagic(r, level);
        if (m?.template) add(m.template, 1, m.extra ?? null);
      }
      continue;
    }
    if (group === G.Books) {
      for (let j = 0; j < shelfBooks(quality); j++) {
        const bookId = randomBook ? randomBook(r) : null;
        if (Number.isInteger(bookId)) add('book', 1, { bookId });
      }
      continue;
    }
    if (!HAND_MADE.has(group)) {
      for (const { key, index } of classicMembers(group)) {
        const rarity = TEMPLATE_RARITY[index] ?? 1;
        if (rarity > quality) continue;
        const chance = Math.trunc(chanceMod * 5 * (21 - rarity) / 100);
        if (d100(r) <= chance) add(key);
      }
      continue;
    }
    // The catalogue's clothing is unisex: a men's or women's roll covers every clothing base.
    const bases = group === G.MensClothing || group === G.WomensClothing
      ? [...(groups.get(G.MensClothing) ?? []), ...(groups.get(G.WomensClothing) ?? [])]
      : groups.get(group) ?? [];
    for (const base of bases) {
      const rarity = baseRarity(base);
      if (rarity > quality) continue;
      const chance = Math.trunc(chanceMod * 5 * (21 - rarity) / 100);
      if (!(d100(r) <= chance)) continue;
      const b = BASES[base];
      if (b.group === 'weapon') add(`${MATERIALS.weapon[randomMaterial(level, r)]}-${base}`);
      else if (b.group === 'armor') add(`${randomArmorMaterial(level, r)}-${base}`);
      else if (b.group === 'ammo') add(base, 1 + Math.floor(r() * 20)); // ItemBuilder.CreateWeapon: 1..20 arrows
      else if (b.group === 'clothing') add(`${dyes[Math.floor(r() * dyes.length)]}-${base}`);
      else add(base);
    }
  }
  return out;
}

/** Day stamp of DaggerfallLoot.CreateStockedDate (year * 1000 + day of year) for classic minutes. */
export const stockedDate = (date) => date.year * 1000 + date.dayOfYear;
