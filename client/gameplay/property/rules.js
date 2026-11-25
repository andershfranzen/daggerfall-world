// Classic loans, houses, ships, wagon and owned storage: pure rules shared by the server feature
// (server/rpg/property.js) and the browser panel (client/gameplay/property.js). DOM-free.
//
// Numbers follow Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop), revision 3d85a28:
//   - DaggerfallBankManager.cs: loans (minimum 100, due one classic year after borrowing, repaid from
//     carried gold first and then the regional account), house price = model radius × 1280, deed sale
//     at 85%, ships 100,000 (small) / 200,000 (large), one house per region, one ship.
//   - FormulaHelper.CalculateMaxBankLoan (level × 50,000) and CalculateBankLoanRepayment (amount + 10%).
//   - LoanChecker.cs: reminders 6, 3 and 1 months before the due date; on the due date the debt is
//     taken from the regional account and, if any remains, the loan defaults once (legal reputation
//     LoanDefault = 10 in PlayerEntity.reputationLossPerCrime).
//   - BuildingDirectory.GetHousesForSale: every HouseForSale plus random House1-4 up to
//     min(buildings / 10, 20), reseeded each month.
//   - ItemHelper.WagonKgLimit = 750; DaggerfallInventoryWindow: the wagon needs a Small Cart and, in a
//     dungeon, the player within 5 m of the exit.
// Only numeric rules are reproduced; all wording is original to this project.

import { MINUTES_PER_DAY, DAYS_PER_MONTH, DAYS_PER_YEAR } from '../atmosphere/calendar.js';

export const LOAN_MIN = 100;
export const LOAN_PER_LEVEL = 50_000;
export const LOAN_INTEREST = 0.1;
export const LOAN_TERM_MINUTES = DAYS_PER_YEAR * MINUTES_PER_DAY;
export const MINUTES_PER_MONTH = DAYS_PER_MONTH * MINUTES_PER_DAY;
export const LOAN_REMINDER_MONTHS = Object.freeze([6, 3, 1]);
export const LOAN_DEFAULT_REPUTATION = 10;

export const HOUSE_PRICE_MULT = 1280;
export const DEED_SELL_MULT = 0.85;
export const MAX_HOUSES_FOR_SALE = 20;

export const WAGON_KG_LIMIT = 750;
export const WAGON_DUNGEON_REACH = 5;
export const CART_TEMPLATE = 'small-cart';
export const MAX_STORED_ITEMS = 200;
/** Gold stored in a house or hold is counted like gold carried (400 pieces per kg). */
export const GOLD_PER_KG = 400;

/** Ship types: index into the bank's ship list, the deck record in MAPS.BSA region 31 and its price. */
export const SHIPS = Object.freeze({
  small: Object.freeze({ type: 'small', label: 'Small ship', price: 100_000, regionIndex: 31, locationIndex: 1, mapId: 1050578 }),
  large: Object.freeze({ type: 'large', label: 'Large galleon', price: 200_000, regionIndex: 31, locationIndex: 2, mapId: 2102157 }),
});
export const SHIP_TYPES = Object.freeze(Object.keys(SHIPS));

const int = (v) => (Number.isFinite(v) ? Math.trunc(v) : 0);

/** FormulaHelper.CalculateMaxBankLoan. */
export const maxLoan = (level) => Math.max(1, int(level)) * LOAN_PER_LEVEL;
/** FormulaHelper.CalculateBankLoanRepayment: what is owed for `amount` borrowed. */
export const loanRepayment = (amount) => Math.trunc(amount + amount * LOAN_INTEREST);
/** DaggerfallBankManager.GetHousePrice: (int)(radius × 1280). */
export const housePrice = (radius) => Math.trunc((Number(radius) || 0) * HOUSE_PRICE_MULT);
/** GetHouseSellPrice / GetShipSellPrice: (int)(price × 0.85). */
export const deedSellPrice = (price) => Math.trunc(price * DEED_SELL_MULT);
export const shipPrice = (type) => SHIPS[type]?.price ?? 0;

/** Why `amount` cannot be borrowed by a character of `level` in a region with `loan`, or null. */
export function loanRefusal(amount, level, loan) {
  if (loan?.defaulted) return 'This bank will not lend to you again: you defaulted on a loan here.';
  if (loan && loan.total > 0) return 'You must repay your loan in this region before borrowing again.';
  if (!Number.isInteger(amount) || amount < LOAN_MIN) return `The bank lends no less than ${LOAN_MIN} gold.`;
  if (amount > maxLoan(level)) return `At your standing the bank lends at most ${maxLoan(level)} gold.`;
  return null;
}

/** Whole classic months left before a due date (LoanChecker's count), never negative. */
export const monthsLeft = (due, now) => Math.max(0, Math.trunc((due - now) / MINUTES_PER_MONTH));

/** The reminder month crossed between two clock readings, or null (LoanChecker.CheckOverdueLoans). */
export function reminderCrossed(due, before, now) {
  if (!(due > now)) return null;
  const was = Math.trunc((due - before) / MINUTES_PER_MONTH);
  const is = Math.trunc((due - now) / MINUTES_PER_MONTH);
  if (!(is < was)) return null;
  return LOAN_REMINDER_MONTHS.find((m) => was >= m && is < m) ?? null;
}

/** Deterministic 32-bit hash of a string (FNV-1a). */
export function hash32(text) {
  let h = 0x811c9dc5;
  for (const c of String(text)) {
    h ^= c.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Small seeded generator (mulberry32) so server and browser agree on the month's offers. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * BuildingDirectory.GetHousesForSale: every HouseForSale (type 1) plus random House1-4 until
 * min(buildings/10, 20) are offered. Seeded by the town and the classic month index, so the list is
 * stable for a month and the same for every player.
 * @param {Array<{id, buildingType, radius}>} houses
 * @param {{town:string, monthIndex:number, buildingCount?:number}} opts
 */
export function housesForSale(houses, { town, monthIndex, buildingCount = null, excluded = () => false }) {
  const list = Array.isArray(houses) ? houses.filter((h) => h && !excluded(h)) : [];
  const total = Number.isInteger(buildingCount) && buildingCount > 0 ? buildingCount : list.length * 10;
  const max = Math.min(Math.trunc(total / 10), MAX_HOUSES_FOR_SALE);
  const forSale = list.filter((h) => h.buildingType === 1);
  const candidates = list.filter((h) => h.buildingType >= 17 && h.buildingType <= 20).sort((a, b) => (a.id < b.id ? -1 : 1));
  const next = rng(hash32(`${town}#${monthIndex}`));
  for (let c = max - forSale.length; c > 0 && candidates.length; c--) {
    forSale.push(candidates.splice(Math.floor(next() * candidates.length), 1)[0]);
  }
  return forSale.map((h) => ({ ...h, price: housePrice(h.radius) }));
}

/** Weight in kg of stored records (gold at 400 per kg). */
export function storedWeight(items) {
  let kg = 0;
  for (const it of Array.isArray(items) ? items : []) {
    if (!it) continue;
    kg += it.template === 'gold' ? (it.quantity || 0) / GOLD_PER_KG : (Number(it.weight) || 0) * (it.quantity || 1);
  }
  return Math.round(kg * 100) / 100;
}

/** "town:Region/Location" -> "Region" for an interior or town id, or null. */
export function exteriorTownOf(location) {
  if (typeof location !== 'string') return null;
  let m = /^town:([^/]+)\/([^/]+)$/.exec(location);
  if (m) return location;
  m = /^interior:([^/]+)\/([^/]+)\/\d{1,2},\d{1,2}\/\d{1,3}$/.exec(location);
  return m ? `town:${m[1]}/${m[2]}` : null;
}
