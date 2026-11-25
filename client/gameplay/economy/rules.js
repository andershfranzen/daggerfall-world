// Classic shop economy: pure price rules shared by the server (server/rpg/npcs.js, server/rpg/economy.js,
// server/rpg/townServices.js) and the browser (client/gameplay/shop.js, client/gameplay/townServices.js).
//
// Numbers follow Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop), revision 3d85a283:
//   - FormulaHelper.CalculateCost, CalculateTradePrice, ApplyRegionalPriceAdjustment,
//     RandomizeInitialRegionalPrices and UpdateRegionalPrices.
//   - DaggerfallTradeWindow.UpdateCostAndGold / GetTradePrice (holiday halving per basket line, trade price on the total)
//     and storeBuysItemType (which item groups each shop buys).
// The holiday rule itself is package 20's (client/gameplay/atmosphere/holidays.js).
// Pure module: no DOM, no I/O. All wording is original to this project.

import { dateFromMinutes } from '../atmosphere/calendar.js';
import { holidayAt, holidayPrice } from '../atmosphere/holidays.js';
import { REGION_NAMES } from '../../world/maps.js';

/** C#-style integer division (truncates toward zero). */
export const idiv = (a, b) => Math.trunc(a / b);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** DFLocation.BuildingTypes used by the economy. */
export const BUILDING = Object.freeze({
  Alchemist: 0, Armorer: 2, Bookseller: 5, ClothingStore: 6, FurnitureStore: 7, GemStore: 8, GeneralStore: 9,
  PawnShop: 12, WeaponSmith: 13,
});

/** Classic ItemGroups (ItemEnums.cs) by id. */
export const ITEM_GROUP = Object.freeze({
  Drugs: 0, UselessItems1: 1, Armor: 2, Weapons: 3, MagicItems: 4, Artifacts: 5, MensClothing: 6, Books: 7, Furniture: 8,
  UselessItems2: 9, ReligiousItems: 10, Maps: 11, WomensClothing: 12, Paintings: 13, Gems: 14, PlantIngredients1: 15,
  PlantIngredients2: 16, CreatureIngredients1: 17, CreatureIngredients2: 18, CreatureIngredients3: 19,
  MiscellaneousIngredients1: 20, MetalIngredients: 21, MiscellaneousIngredients2: 22, Transportation: 23, Deeds: 24,
  Jewellery: 25, QuestItems: 26, MiscItems: 27, Currency: 28,
});
export const ITEM_GROUP_NAME = Object.freeze(Object.fromEntries(Object.entries(ITEM_GROUP).map(([k, v]) => [v, k])));

const G = ITEM_GROUP;
const INGREDIENTS = [G.PlantIngredients1, G.PlantIngredients2, G.CreatureIngredients1, G.CreatureIngredients2,
  G.CreatureIngredients3, G.MiscellaneousIngredients1, G.MiscellaneousIngredients2, G.MetalIngredients];

/** DaggerfallTradeWindow.storeBuysItemType: groups a shop of this building type will buy. */
export const STORE_BUYS = Object.freeze({
  [BUILDING.Alchemist]: [G.Gems, ...INGREDIENTS],
  [BUILDING.Armorer]: [G.Armor, G.Weapons],
  [BUILDING.Bookseller]: [G.Books],
  [BUILDING.ClothingStore]: [G.MensClothing, G.WomensClothing],
  [BUILDING.FurnitureStore]: [G.Furniture],
  [BUILDING.GemStore]: [G.Gems, G.Jewellery],
  [BUILDING.GeneralStore]: [G.Books, G.MensClothing, G.WomensClothing, G.Transportation, G.Jewellery, G.Weapons, G.UselessItems2],
  [BUILDING.PawnShop]: [G.Armor, G.Books, G.MensClothing, G.WomensClothing, G.Gems, G.Jewellery, G.ReligiousItems, G.Weapons,
    G.UselessItems2, G.Paintings],
  [BUILDING.WeaponSmith]: [G.Armor, G.Weapons],
});

/** Neutral regional price adjustment (per mille). */
export const NEUTRAL_ADJUST = 1000;
/** Quality assumed for a counter without building data (a roster merchant or a smith in the street). */
export const DEFAULT_QUALITY = 10;

// ------------------------------------------------------------------------------------------------ regions

/** Region index for any place address (`town:Daggerfall/…`, `interior:17/…`), or -1. */
export function regionIndexOf(location) {
  const m = /^[a-z]+:([^/]+)\//.exec(String(location ?? ''));
  if (!m) return -1;
  if (/^\d+$/.test(m[1])) return REGION_NAMES[Number(m[1])] ? Number(m[1]) : -1;
  const want = m[1].toLowerCase();
  return REGION_NAMES.findIndex((n) => n.toLowerCase() === want);
}

/** FNV-1a 32-bit. */
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
/** mulberry32 PRNG returning [0,1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const seedOf = (s) => hash32(String(s));
/** Dice100.Roll (1..100) from a [0,1) source. */
export const d100 = (r) => 1 + Math.floor(r() * 100);

const adjustCache = new Map(); // `${region}|${year}` -> Uint16Array of per-day values (index dayOfYear - 1)

/**
 * Regional price adjustment (per mille, 250..4000) of a region on a game day, shared by every player.
 * Classic keeps one value per region in the save: RandomizeInitialRegionalPrices (750..1250) at a new game, then
 * UpdateRegionalPrices once per elapsed day. Here every region starts a fresh 750..1250 value on New Life of each
 * year and takes one classic step per day, seeded by (region, year, day), so the whole server sees the same market.
 * The chance of a rise includes (The Merchants' power − the region's province faction power) / 5, read from the
 * operator's FACTION.TXT by the server (setFactionPowers). Without game data the term is 0.
 */
export function priceAdjust(regionIndex, classicMinutes) {
  if (!Number.isInteger(regionIndex) || regionIndex < 0 || !Number.isFinite(classicMinutes)) return NEUTRAL_ADJUST;
  const { year, dayOfYear } = dateFromMinutes(classicMinutes);
  const power = idiv(powerDelta.get(regionIndex) ?? 0, 5);
  const key = `${regionIndex}|${year}|${power}`;
  let days = adjustCache.get(key);
  if (!days) {
    days = new Uint16Array(360);
    const init = rng(seedOf(`price:${regionIndex}:${year}`));
    let adj = 750 + Math.floor(init() * 501);
    days[0] = adj;
    for (let d = 1; d < 360; d++) {
      const r = rng(seedOf(`price:${regionIndex}:${year}:${d}`));
      const chanceOfRise = power + 50 - idiv(adj - 1000, 25);
      // Dice100.FailedRoll(chance) lowers prices by 2 %, otherwise they rise by 2 %.
      adj = d100(r) > chanceOfRise ? idiv(49 * adj, 50) : idiv(51 * adj, 50);
      adj = clamp(adj, 250, 4000);
      days[d] = adj;
    }
    if (adjustCache.size > 256) adjustCache.clear();
    adjustCache.set(key, days);
  }
  return days[clamp(dayOfYear, 1, 360) - 1];
}

/** FactionFile.FactionIDs.The_Merchants and FactionFile.FactionTypes.Province. */
export const MERCHANTS_FACTION = 510;
const PROVINCE_TYPE = 7;
/** regionIndex -> merchants' power minus the region's power (FormulaHelper.UpdateRegionalPrices). */
const powerDelta = new Map();
/**
 * Reads faction powers from a parsed FACTION.TXT (client/gameplay/npcs/factionFile.js). PersistentFactionData
 * .FindFactionByTypeAndRegion(7, region): the province of that region, else the last province with region -1.
 * Without The Merchants (classic returns early) every region keeps a 0 term. Returns the number of regions set.
 */
export function setFactionPowers(factions) {
  powerDelta.clear();
  adjustCache.clear();
  const list = factions instanceof Map ? [...factions.values()] : [];
  const merchants = list.find((f) => f.id === MERCHANTS_FACTION);
  if (!Number.isFinite(merchants?.power)) return 0;
  let fallback = null;
  const byRegion = new Map();
  for (const f of list) {
    if (f.type !== PROVINCE_TYPE || !Number.isFinite(f.power)) continue;
    if (f.region === -1) fallback = f;
    else if (Number.isInteger(f.region) && !byRegion.has(f.region)) byRegion.set(f.region, f);
  }
  for (let r = 0; r < 62; r++) {
    const f = byRegion.get(r) ?? fallback;
    if (f) powerDelta.set(r, merchants.power - f.power);
  }
  return powerDelta.size;
}
export const regionPowerDelta = (regionIndex) => powerDelta.get(regionIndex) ?? 0;

/** "high" / "low" / null, from PlayerEntity.RegionDataFlags.PricesHigh / PricesLow. */
export function priceTrend(adjust) {
  if (adjust > 2000) return 'high';
  if (adjust < 500) return 'low';
  return null;
}

/** FormulaHelper.ApplyRegionalPriceAdjustment. */
export function applyRegional(cost, adjust = NEUTRAL_ADJUST) {
  return Math.max(1, idiv(Math.trunc(cost) * Math.trunc(adjust), 1000));
}

// ------------------------------------------------------------------------------------------------ prices

/** FormulaHelper.CalculateCost: regional adjustment, then 2 * (cost * (quality - 10) / 100 + cost). */
export function calculateCost(baseValue, quality = DEFAULT_QUALITY, adjust = NEUTRAL_ADJUST) {
  let cost = Math.max(1, Math.trunc(baseValue) || 0);
  cost = applyRegional(cost, adjust);
  cost = 2 * (idiv(cost * (Math.trunc(quality) - 10), 100) + cost);
  return cost;
}

/**
 * FormulaHelper.CalculateTradePrice. The merchant's Mercantile and Personality are 5 * (quality - 10) + 50; the
 * player's live Mercantile skill and Personality pull the price toward them.
 */
export function tradePrice(cost, quality, selling, { mercantile = 0, personality = 50 } = {}) {
  const merchant = 5 * (Math.trunc(quality) - 10) + 50;
  const merc = clamp(Math.trunc(mercantile) || 0, 0, 100);
  const pers = clamp(Math.trunc(personality) || 0, 0, 100);
  let dm, dp, amount;
  if (selling) {
    dm = ((idiv((100 - merchant) << 8, 200) + 128) * (idiv(merc << 8, 200) + 128)) >> 8;
    dp = ((idiv((100 - merchant) << 8, 200) + 128) * (idiv(pers << 8, 200) + 128)) >> 8;
    amount = ((((179 * dm) >> 8) + ((51 * dp) >> 8)) * cost) >> 8;
  } else {
    dm = ((idiv(merchant << 8, 200) + 128) * (idiv((100 - merc) << 8, 200) + 128)) >> 8;
    dp = (((idiv(merchant << 8, 200) + 128) * (idiv((100 - pers) << 8, 200) + 128)) >> 8) << 6;
    amount = ((((192 * dm) >> 8) + (dp >> 8)) * cost) >> 8;
  }
  return Math.max(0, amount);
}

/**
 * Everything a price depends on besides the item: `{quality, adjust, mercantile, personality, holiday, guildFaction}`.
 * `holiday` is a DFLocation.Holidays key from holidayAt() (or null).
 */
/**
 * Classic trade-price inputs. CalculateTradePrice reads the player's LIVE Mercantile (Skills.GetLiveSkillValue) and
 * LIVE Personality (Stats.LivePersonality): pass them as `mercantile` / `personality` (the server's
 * services.tradeInputs, or the `trade` field of townServices.counters in the browser). Without them the stored
 * character values are used (fallback-only fixtures, no character feature).
 */
export function priceContext({ quality = DEFAULT_QUALITY, regionIndex = -1, minutes = null, character = null, guildFaction = null, mercantile = null, personality = null } = {}) {
  const live = (name, fallback) => {
    const given = name === 'Mercantile' ? mercantile : name === 'Personality' ? personality : null;
    if (Number.isFinite(given)) return Math.trunc(given);
    const v = character?.skills?.[name] ?? (name === 'Personality' ? character?.effectiveAttributes?.[name] : undefined) ?? character?.attributes?.[name];
    const n = typeof v === 'object' && v ? v.value : v;
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    quality: Math.trunc(quality) || DEFAULT_QUALITY,
    adjust: priceAdjust(regionIndex, minutes),
    mercantile: live('Mercantile', 0),
    personality: live('Personality', 50),
    holiday: Number.isFinite(minutes) && regionIndex >= 0 ? holidayAt(minutes, regionIndex) : null,
    guildFaction,
  };
}

/** One basket line's cost before the trade price: CalculateCost × quantity, halved on the matching holiday. */
export function basketLine(value, quantity, ctx, itemGroup = null) {
  const line = calculateCost(value, ctx.quality, ctx.adjust) * Math.max(1, Math.trunc(quantity) || 1);
  if (!ctx.holiday) return line;
  return holidayPrice('trade', line, ctx.holiday, { guildFaction: ctx.guildFaction ?? null, itemGroup: itemGroup ?? undefined }).price;
}

/** Price the player pays for `quantity` of an item worth `value` (DaggerfallTradeWindow Buy). */
export function buyPrice(value, quantity, ctx, itemGroup = null) {
  return Math.max(1, tradePrice(basketLine(value, quantity, ctx, itemGroup), ctx.quality, false, ctx));
}

/** Gold the player receives for `quantity` of an item worth `value` (Sell; SellMagic at a fence uses the same cost). */
export function sellPrice(value, quantity, ctx) {
  const line = calculateCost(value, ctx.quality, ctx.adjust) * Math.max(1, Math.trunc(quantity) || 1);
  return tradePrice(line, ctx.quality, true, ctx);
}

/** Classic ItemGroups name ('Weapons', …) of an inventory item or catalogue description, or null. */
export function itemGroupOf(item, groupByIndex = null) {
  if (!item) return null;
  const g = item.group;
  if (g === 'weapon' || g === 'ammo') return 'Weapons';
  if (g === 'armor' || g === 'shield') return 'Armor';
  if (g === 'gem') return 'Gems';
  if (g === 'transport') return 'Transportation';
  if (g === 'book') return 'Books';
  if (g === 'clothing') return Number(item.index) >= 182 ? 'WomensClothing' : 'MensClothing';
  if (groupByIndex && Number.isInteger(item.index) && groupByIndex[item.index] >= 0) return ITEM_GROUP_NAME[groupByIndex[item.index]];
  if (g === 'ingredient') return 'MiscellaneousIngredients1';
  if (g === 'potion') return 'UselessItems1';
  return null;
}

/** Why a shop of `buildingType` will not buy this item (storeBuysItemType), or null. Unknown building types buy anything. */
export function storeRefusal(buildingType, groupName) {
  const groups = STORE_BUYS[buildingType];
  if (!groups) return null;
  return groupName && groups.includes(ITEM_GROUP[groupName]) ? null : 'That is not something this shop deals in.';
}

/** "Prices are high in this region" style note, or null. */
export function marketNote(adjust) {
  const t = priceTrend(adjust);
  if (t === 'high') return 'Prices are high in this region at the moment.';
  if (t === 'low') return 'Prices are low in this region at the moment.';
  return null;
}
