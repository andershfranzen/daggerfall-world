// Classic regional banking and item repair: pure rules shared by the server feature
// (server/rpg/townServices.js) and the browser panel (client/gameplay/townServices.js).
//
// Numbers follow Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop):
//   - DaggerfallBankManager.cs: per-region accounts, letters of credit with a 1% commission
//     (locCommission = 1.01) and a 100 gold minimum, deposit-all of carried letters.
//   - FormulaHelper.CalculateCost / CalculateItemRepairCost / CalculateItemRepairTime.
//   - FightersGuild.ReducedRepairCost.
//   - RMBLayout.IsRepairShop (Armorer, GeneralStore, WeaponSmith) and DFLocation.BuildingTypes.
// Only numeric rules are reproduced; all wording is original to this project.

import { regionNameOf } from '../travel/identity.js';
import { calculateCost, tradePrice, NEUTRAL_ADJUST } from '../economy/rules.js';

/** DFLocation.BuildingTypes values used by town services. */
export const BUILDING_TYPE = Object.freeze({ Armorer: 2, Bank: 3, GeneralStore: 9, WeaponSmith: 13 });

/** Service counters by classic building type. */
export const SERVICE_BUILDINGS = Object.freeze({
  [BUILDING_TYPE.Bank]: { type: 'bank', label: 'Bank', services: ['bank'] },
  [BUILDING_TYPE.Armorer]: { type: 'armorer', label: 'Armorer', services: ['repair'] },
  [BUILDING_TYPE.WeaponSmith]: { type: 'weaponsmith', label: 'Weaponsmith', services: ['repair'] },
  [BUILDING_TYPE.GeneralStore]: { type: 'general', label: 'General Store', services: ['repair'] },
});

/** Metres from a building's street door at which its counter can be used. */
export const DOOR_REACH = 4;
/** Metres from a smith NPC (same as conversation range). */
export const NPC_REACH = 3.5;

export const GOLD_PER_KG = 400;
export const LETTER_MIN = 100;
export const LETTER_COMMISSION = 1.01;
export const MAX_BALANCE = 1_000_000_000;
export const MAX_LETTERS = 40;
export const MAX_REPAIRS = 12;
export const MINUTES_PER_DAY = 1440;
export const REPAIRABLE_GROUPS = Object.freeze(['weapon', 'armor', 'shield']);

/** "town:Daggerfall/Gothway Garden" or "interior:Daggerfall/Gothway Garden/1,2/3" -> {region, location}. */
export function placeOf(id) {
  if (typeof id !== 'string' || id.length > 200) return null;
  let m = /^town:([^/]+)\/([^/]+)$/.exec(id);
  // Numeric record addresses (`town:0/272`) bank in the region they belong to.
  if (m) return { kind: 'town', region: regionNameOf(m[1]), location: m[2], town: id };
  m = /^interior:([^/]+)\/([^/]+)\/(\d{1,2}),(\d{1,2})\/(\d{1,2})$/.exec(id);
  if (m) {
    return {
      kind: 'interior', region: regionNameOf(m[1]), location: m[2], town: `town:${m[1]}/${m[2]}`,
      counterId: `b:${+m[3]},${+m[4]}:${+m[5]}`,
    };
  }
  return null;
}

/** Account key for a region name (case-insensitive, stable). */
export const regionKey = (region) => String(region || '').trim().toLowerCase();

/** C#-style integer division (truncates toward zero). */
const idiv = (a, b) => Math.trunc(a / b);

/**
 * FormulaHelper.CalculateCost: regional price adjustment (per mille, client/gameplay/economy/rules.js), then
 * cost = 2 * (cost * (quality - 10) / 100 + cost).
 */
export function shopCost(base, quality, adjust = NEUTRAL_ADJUST) {
  return Math.max(1, calculateCost(base, quality, adjust));
}

/** FightersGuild.ReducedRepairCost: (((10 - rank) << 8) / 10 * price) >> 8. */
export function fightersDiscount(price, rank) {
  if (!Number.isInteger(rank) || rank < 0) return price;
  const r = Math.min(9, rank);
  return (idiv((10 - r) << 8, 10) * price) >> 8;
}

/**
 * FormulaHelper.CalculateItemRepairCost, then DaggerfallTradeWindow.GetTradePrice (CalculateTradePrice, buying) when
 * `price` = {adjust, mercantile, personality} is given. Returns 0 for an undamaged item.
 */
export function repairCost({ value, condition, maxCondition }, quality, fightersRank = null, price = null) {
  if (!(maxCondition > 0) || condition >= maxCondition) return 0;
  let cost = Math.max(1, idiv(10 * Math.max(0, Math.trunc(value) || 0), 100));
  cost = shopCost(cost, quality, price?.adjust ?? NEUTRAL_ADJUST);
  if (fightersRank != null) cost = fightersDiscount(cost, fightersRank);
  if (price) cost = tradePrice(cost, quality, false, price);
  return Math.max(1, cost);
}

/**
 * DaggerfallTradeWindow.UpdateRepairTimes for items left together: each item takes its own time, except the slowest,
 * which takes its time plus half of everyone else's. Returns minutes in input order.
 */
export function repairBatchMinutes(items) {
  const own = items.map((it) => repairMinutes(it));
  if (own.length < 2) return own;
  const total = own.reduce((a, b) => a + b, 0);
  const longest = Math.max(...own);
  const i = own.indexOf(longest);
  own[i] = longest + idiv(total - longest, 2);
  return own;
}

/** FormulaHelper.CalculateItemRepairTime, converted from game seconds to whole game minutes. */
export function repairMinutes({ condition, maxCondition }) {
  const damage = Math.max(0, Math.trunc(maxCondition) - Math.trunc(condition));
  const seconds = Math.max(idiv(damage * 86400, 1000), 86400);
  return Math.ceil(seconds / 60);
}

/** Why an item cannot be left for repair, or null. */
export function repairRefusal(item) {
  if (!item || typeof item !== 'object') return 'You do not have that item.';
  if (!REPAIRABLE_GROUPS.includes(item.group)) return `${item.name || 'That'} cannot be repaired here.`;
  if (item.quest) return `${item.name} cannot be left with a smith.`;
  if (item.stackable || (item.quantity ?? 1) !== 1) return `${item.name} cannot be repaired.`;
  if (!(item.maxCondition > 0)) return `${item.name} cannot be repaired.`;
  // Classic smiths do not repair magic items (DaggerfallTradeWindow, AllowMagicRepairs off) or isNotRepairable templates.
  if ((Array.isArray(item.enchantments) && item.enchantments.length) || item.magic || item.artifact) return `${item.name} is enchanted; no smith will work on it.`;
  if (item.notRepairable) return `${item.name} cannot be repaired.`;
  if (item.conjuredUntil) return `${item.name} is conjured; it will not last long enough to mend.`;
  if (item.condition >= item.maxCondition) return `${item.name} does not need repairing.`;
  return null;
}

/** DaggerfallBankManager.Withdraw_LOC: the account is charged amount * 1.01, truncated. */
export function letterCost(amount) {
  return Math.trunc(amount * LETTER_COMMISSION);
}

/** Whole game hours (rounded up) until `readyAt`, or 0 when ready. */
export function hoursLeft(readyAt, nowMinutes) {
  return Math.max(0, Math.ceil((readyAt - nowMinutes) / 60));
}

export function formatWait(readyAt, nowMinutes) {
  const h = hoursLeft(readyAt, nowMinutes);
  if (h <= 0) return 'ready';
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'}`;
  const d = Math.ceil(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

/** Positive whole gold amount from untrusted input, or null. */
export function goldAmount(v) {
  return Number.isInteger(v) && v > 0 && v <= MAX_BALANCE ? v : null;
}
