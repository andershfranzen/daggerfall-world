// Shipyard rules: hulls, refits, worth, repair and stores (pure; no runtime, no clock, no DOM).
//
// Our own numbers, written for this server. The design follows the published shape of a port shipwright
// (a hull ladder from a cheap beach-launched boat to the classic deeds, refit tiers, carpenter's stores,
// shot and provisions), but no names, text or data are copied from any reference project.
//
// The two classic deeds (Small ship 100,000, Large galleon 200,000: client/gameplay/property/rules.js SHIPS)
// are the top of the ladder and keep their classic prices, decks and cabins.
import { SHIPS } from '../../../client/gameplay/property/rules.js';

/** Hull classes, cheapest first. `capacity` is cargo units (one crate or bale each); speeds are m/s at sea. */
export const HULLS = Object.freeze({
  rowboat: Object.freeze({
    id: 'rowboat', label: 'Rowboat', price: 450, crewMin: 0, crewMax: 2, guns: 0, hullMax: 40, sailMax: 0, capacity: 6,
    speed: 2.4, turn: 1.4, draft: 'beach', oars: true,
    line: 'A clinker-built boat with two pairs of oars. No crew needed: launch it from any shore of this harbour.',
  }),
  cutter: Object.freeze({
    id: 'cutter', label: 'Coastal cutter', price: 6_000, crewMin: 2, crewMax: 6, guns: 2, hullMax: 120, sailMax: 80, capacity: 30,
    speed: 4.6, turn: 1.1, draft: 'beach',
    line: 'A single-masted fore-and-aft rig with two swivel guns. Quick, handy and cheap to crew.',
  }),
  cog: Object.freeze({
    id: 'cog', label: 'Merchant cog', price: 24_000, crewMin: 6, crewMax: 16, guns: 4, hullMax: 260, sailMax: 160, capacity: 120,
    speed: 3.7, turn: 0.7, draft: 'quay',
    line: 'A broad, deep trader with a square sail and castles at either end. Slow, but the hold is huge for her size.',
  }),
  small: Object.freeze({
    id: 'small', label: SHIPS.small.label, price: SHIPS.small.price, crewMin: 10, crewMax: 30, guns: 10, hullMax: 420, sailMax: 260,
    capacity: 160, speed: 4.2, turn: 0.75, draft: 'quay', classic: 'small',
    line: 'The classic two-masted ship of the Iliac Bay, with a captain\'s cabin and a gun deck.',
  }),
  large: Object.freeze({
    id: 'large', label: SHIPS.large.label, price: SHIPS.large.price, crewMin: 24, crewMax: 70, guns: 24, hullMax: 900, sailMax: 520,
    capacity: 400, speed: 3.6, turn: 0.5, draft: 'quay', classic: 'large',
    line: 'A three-masted galleon with two gun decks and a hold for a merchant prince.',
  }),
});
export const HULL_IDS = Object.freeze(Object.keys(HULLS));
export const hullOf = (id) => HULLS[id] ?? null;

/** Refit lines and tiers. Each tier costs a share of the hull's price (at least REFIT_MIN gold). */
export const REFIT_LINES = Object.freeze({
  hold: Object.freeze({ id: 'hold', label: 'Hold', per: 0.25, text: 'Deeper hold: +25% cargo per tier' }),
  rigging: Object.freeze({ id: 'rigging', label: 'Rigging', per: 0.08, text: 'New canvas and running rigging: +8% speed per tier' }),
  hull: Object.freeze({ id: 'hull', label: 'Hull', per: 0.2, text: 'Doubled planking: +20% hull strength per tier' }),
  guns: Object.freeze({ id: 'guns', label: 'Guns', per: 0.25, text: 'Extra gun ports: +25% guns per tier' }),
});
export const REFIT_IDS = Object.freeze(Object.keys(REFIT_LINES));
export const REFIT_TIERS = 3;
export const REFIT_SHARE = Object.freeze([0.08, 0.14, 0.22]);
export const REFIT_MIN = 60;

/** Lines a hull cannot take, with the reason. */
export function refitBlocked(hullId, line) {
  const h = hullOf(hullId);
  if (!h) return 'No such ship.';
  if (h.oars && (line === 'rigging' || line === 'guns')) return 'A rowboat has neither mast nor gun ports.';
  return null;
}
export function refitCost(hullId, line, tier) {
  const h = hullOf(hullId);
  if (!h || !REFIT_LINES[line] || !(tier >= 0 && tier < REFIT_TIERS)) return null;
  return Math.max(REFIT_MIN, Math.round(h.price * REFIT_SHARE[tier]));
}
export function refitGold(hullId, refits = {}) {
  let gold = 0;
  for (const l of REFIT_IDS) for (let t = 0; t < Math.min(REFIT_TIERS, refits[l] | 0); t++) gold += refitCost(hullId, l, t) ?? 0;
  return gold;
}

/** A ship's figures with its refits applied. */
export function statsOf(hullId, refits = {}) {
  const h = hullOf(hullId);
  if (!h) return null;
  const tier = (l) => Math.max(0, Math.min(REFIT_TIERS, refits?.[l] | 0));
  const guns = h.guns ? h.guns + Math.ceil(h.guns * REFIT_LINES.guns.per) * tier('guns') : 0;
  return {
    hull: h.id, label: h.label, crewMin: h.crewMin, crewMax: h.crewMax, guns,
    hullMax: Math.round(h.hullMax * (1 + REFIT_LINES.hull.per * tier('hull'))),
    sailMax: h.sailMax,
    capacity: Math.round(h.capacity * (1 + REFIT_LINES.hold.per * tier('hold'))),
    speed: Math.round(h.speed * (1 + REFIT_LINES.rigging.per * tier('rigging')) * 100) / 100,
    turn: h.turn, draft: h.draft, oars: !!h.oars, classic: h.classic ?? null,
    stores: storeCaps(h, guns),
  };
}

// ------------------------------------------------------------------ stores

/** Ship's stores: one provision feeds one person a day; one shot fires one gun once; one timber mends TIMBER_MENDS hull. */
export const STORES = Object.freeze({
  provisions: Object.freeze({ id: 'provisions', label: 'Provisions', price: 2, text: 'Salt meat, biscuit and water: one person, one day' }),
  shot: Object.freeze({ id: 'shot', label: 'Round shot & powder', price: 6, text: 'One charge for one gun' }),
  timber: Object.freeze({ id: 'timber', label: 'Carpenter\'s timber', price: 30, text: 'Planks, pitch and canvas for repairs at sea' }),
});
export const STORE_IDS = Object.freeze(Object.keys(STORES));
export const TIMBER_MENDS = 25;
export function storeCaps(h, guns = h.guns) {
  return {
    provisions: Math.max(20, (h.crewMax + 1) * 30),
    shot: guns * 20,
    timber: Math.max(2, Math.round(h.hullMax / TIMBER_MENDS)),
  };
}

// ------------------------------------------------------------------ worth, repair

/** A ship's worth sold back: what was paid, half its refits, scaled by its hull's state (a wreck keeps 60%). */
export const SALE_SHARE = 0.6;
export const WRECK_FLOOR = 0.6;
export function shipWorth(ship, stats = statsOf(ship.hull, ship.refits)) {
  const h = hullOf(ship.hull);
  if (!h || !stats) return 0;
  const paid = Number.isFinite(ship.paid) ? Math.max(0, Math.min(h.price, ship.paid)) : h.price;
  const share = stats.hullMax ? Math.max(0, Math.min(1, ship.hullHp / stats.hullMax)) : 1;
  return Math.max(1, Math.round((paid + refitGold(ship.hull, ship.refits) * 0.5) * (WRECK_FLOOR + (1 - WRECK_FLOOR) * share)));
}
export const salePrice = (ship) => Math.max(1, Math.trunc(shipWorth(ship) * SALE_SHARE));

/** Yard repair: gold per point of hull and of sail. */
export const REPAIR_PRICE = Object.freeze({ hull: 4, sail: 2 });
export function repairQuote(ship, stats = statsOf(ship.hull, ship.refits)) {
  const hull = Math.max(0, stats.hullMax - ship.hullHp);
  const sail = Math.max(0, stats.sailMax - ship.sailHp);
  return { hull: { points: hull, gold: Math.ceil(hull * REPAIR_PRICE.hull) }, sail: { points: sail, gold: Math.ceil(sail * REPAIR_PRICE.sail) } };
}

// ------------------------------------------------------------------ names

const SHIP_NAMES = Object.freeze([
  'Gull', 'Saltwind', 'Kingfisher', 'Brine Maiden', 'Bay Runner', 'Grey Heron', 'Mermaid\'s Purse', 'Lantern', 'Swift Otter',
  'Tidewright', 'Iliac Rose', 'Morning Star', 'Wavecutter', 'Lucky Cod', 'Cormorant', 'Stormpetrel', 'Sea Hare', 'Old Faithful',
]);
export function cleanShipName(raw) {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32);
  return s.length >= 2 ? s : null;
}
export const defaultShipName = (seed) => SHIP_NAMES[(hash(String(seed)) >>> 0) % SHIP_NAMES.length];

/** FNV-1a 32-bit; deterministic seeds for offers, recruits and prices. */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
/** Deterministic [0,1) from a seed string. */
export const unit = (s) => hash(s) / 4294967296;
