// Dynamic regional economy helpers: live monthly Merchants' power step and regional holiday trade pricing
// beyond the three global trade holidays (docs/shops-and-economy.md).

import {
  basketLine, priceAdjust, priceTrend, tradePrice,
} from '../../../client/gameplay/economy/rules.js';

const INGREDIENTS = Object.freeze([
  'PlantIngredients1', 'PlantIngredients2', 'CreatureIngredients1', 'CreatureIngredients2',
  'CreatureIngredients3', 'MiscellaneousIngredients1', 'MiscellaneousIngredients2', 'MetalIngredients',
]);

/**
 * Regional holiday trade discounts for ordinary (non-guild) shops.
 * Global trade holidays (merchants-festival, tales-and-tallow, warriors-festival) are already applied by
 * client/gameplay/atmosphere/holidays.js inside basketLine().
 */
export const REGIONAL_HOLIDAY_RULES = Object.freeze({
  saturalia: Object.freeze({ name: 'half', multiplier: 0.5, groups: null }), // Wayrest (day 355): gift-giving half price
  'festival-of-blades': Object.freeze({ name: 'half-arms', multiplier: 0.5, groups: Object.freeze(['Weapons', 'Armor']) }), // Alik'r Desert (day 86)
  'dancing-day': Object.freeze({ name: 'half-finery', multiplier: 0.5, groups: Object.freeze(['MensClothing', 'WomensClothing', 'Jewellery']) }), // Daggerfall (day 173)
  'broken-diamonds': Object.freeze({ name: 'half-gems', multiplier: 0.5, groups: Object.freeze(['Gems', 'Jewellery']) }), // Glenpoint (day 293)
  'appreciation-day': Object.freeze({ name: 'half', multiplier: 0.5, groups: null }), // Anticlere (day 231)
  'koomu-alazeri': Object.freeze({ name: 'half-lore', multiplier: 0.5, groups: Object.freeze(['Books', 'ReligiousItems']) }), // Ykalon (day 221)
  'baranth-do': Object.freeze({ name: 'half-ingredients', multiplier: 0.5, groups: INGREDIENTS }), // Alik'r Desert (day 348)
});

/**
 * Applies a regional holiday trade discount to a base basket-line cost.
 * Returns {price, holiday, rule} where `rule` is null when no regional trade rule applies.
 */
export function regionalHolidayPrice(baseCost, holidayKey, { guildFaction = null, itemGroup = null } = {}) {
  const base = Math.max(0, Math.floor(Number(baseCost) || 0));
  if (!holidayKey || guildFaction != null) return { price: base, holiday: holidayKey ?? null, rule: null };
  const rule = REGIONAL_HOLIDAY_RULES[holidayKey];
  if (!rule) return { price: base, holiday: holidayKey, rule: null };
  if (rule.groups && !rule.groups.includes(itemGroup)) return { price: base, holiday: holidayKey, rule: null };
  const discounted = Math.floor(base * rule.multiplier);
  return { price: base > 0 ? Math.max(1, discounted) : 0, holiday: holidayKey, rule: rule.name };
}

/** Classic basketLine plus regional holiday trade discounts. */
export function adjustedBasketLine(value, quantity, ctx, itemGroup = null) {
  const line = basketLine(value, quantity, ctx, itemGroup);
  if (!ctx?.holiday) return line;
  return regionalHolidayPrice(line, ctx.holiday, { guildFaction: ctx.guildFaction ?? null, itemGroup }).price;
}

/** Classic buyPrice using adjustedBasketLine so shelf and counter prices match on regional holidays. */
export function adjustedBuyPrice(value, quantity, ctx, itemGroup = null) {
  return Math.max(1, tradePrice(adjustedBasketLine(value, quantity, ctx, itemGroup), ctx.quality, false, ctx));
}

/** Counts how many of the 62 Iliac Bay regions currently have PricesHigh (>2000) or PricesLow (<500). */
export function monthlyPriceCounts(classicMinutes, regionCount = 62) {
  const highRegions = [];
  const lowRegions = [];
  for (let r = 0; r < regionCount; r++) {
    const trend = priceTrend(priceAdjust(r, classicMinutes));
    if (trend === 'high') highRegions.push(r);
    else if (trend === 'low') lowRegions.push(r);
  }
  return { highCount: highRegions.length, lowCount: lowRegions.length, highRegions, lowRegions };
}

/**
 * Classic monthly Merchants' faction power step (PlayerEntity / UpdateRegionalPrices):
 * >= 3 regions with PricesHigh raises The Merchants' power by 1; >= 3 with PricesLow lowers it by 1.
 */
export function merchantsMonthlyDelta({ highCount = 0, lowCount = 0 } = {}) {
  return (highCount >= 3 ? 1 : 0) - (lowCount >= 3 ? 1 : 0);
}
