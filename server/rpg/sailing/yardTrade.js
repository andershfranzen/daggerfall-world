// Port commodity market and harbour delivery board (pure).
//
// Each port makes two goods (cheap, plentiful) and wants two (dear, scarce); every other good trades near its
// base price with a small daily drift. A captain's dealings in one port on one day are capped by that port's
// stock (buying) and demand (selling), so buying and selling back on the spot never pays: the buy price is
// always above the sell price for the same port and day.
import { hash, unit } from './yard.js';

/** Goods: one unit fills one cargo slot. */
export const GOODS = Object.freeze({
  grain: Object.freeze({ id: 'grain', label: 'Grain', base: 8 }),
  fish: Object.freeze({ id: 'fish', label: 'Salt fish', base: 10 }),
  salt: Object.freeze({ id: 'salt', label: 'Salt', base: 12 }),
  timber: Object.freeze({ id: 'timber', label: 'Timber', base: 14 }),
  wool: Object.freeze({ id: 'wool', label: 'Wool cloth', base: 22 }),
  ale: Object.freeze({ id: 'ale', label: 'Ale', base: 16 }),
  iron: Object.freeze({ id: 'iron', label: 'Iron bars', base: 30 }),
  wine: Object.freeze({ id: 'wine', label: 'Wine', base: 34 }),
  glass: Object.freeze({ id: 'glass', label: 'Glassware', base: 46 }),
  dyes: Object.freeze({ id: 'dyes', label: 'Dyes', base: 58 }),
  spices: Object.freeze({ id: 'spices', label: 'Spices', base: 80 }),
  silk: Object.freeze({ id: 'silk', label: 'Silk', base: 110 }),
});
export const GOOD_IDS = Object.freeze(Object.keys(GOODS));
export const MADE_K = 0.65;
export const WANT_K = 1.45;
export const DRIFT = 0.1;
export const SPREAD = 0.08;
export const STOCK = Object.freeze({ made: 60, normal: 25, wanted: 6 });
export const DEMAND = Object.freeze({ made: 6, normal: 25, wanted: 60 });

/** {made:[id,id], wanted:[id,id]} for a port. */
export function portProfile(portId) {
  const order = [...GOOD_IDS].sort((a, b) => hash(`${portId}|${a}`) - hash(`${portId}|${b}`));
  return { made: order.slice(0, 2), wanted: order.slice(2, 4) };
}
const standOf = (prof, id) => (prof.made.includes(id) ? 'made' : prof.wanted.includes(id) ? 'wanted' : 'normal');

/** Mid price of a good at a port on a day (before spread and haggling). */
export function midPrice(portId, id, day) {
  const g = GOODS[id];
  if (!g) return null;
  const stand = standOf(portProfile(portId), id);
  const k = stand === 'made' ? MADE_K : stand === 'wanted' ? WANT_K : 1;
  const drift = 1 + DRIFT * (2 * unit(`${portId}|${id}|${day}`) - 1);
  return Math.max(1, g.base * k * drift);
}

/** The market at a port on a day for one captain. `edge` 0..0.1 is a haggling discount; `dealt` {bought:{id:n}, sold:{id:n}}. */
export function marketAt(portId, day, { edge = 0, dealt = null } = {}) {
  const prof = portProfile(portId);
  return GOOD_IDS.map((id) => {
    const stand = standOf(prof, id);
    const mid = midPrice(portId, id, day);
    const buy = Math.max(1, Math.ceil(mid * (1 + SPREAD) * (1 - edge)));
    const sell = Math.max(1, Math.min(buy - 1, Math.floor(mid * (1 - SPREAD) * (1 + edge))));
    return {
      id, label: GOODS[id].label, stand, buy, sell,
      stock: Math.max(0, STOCK[stand] - (dealt?.bought?.[id] | 0)),
      demand: Math.max(0, DEMAND[stand] - (dealt?.sold?.[id] | 0)),
    };
  });
}

// ------------------------------------------------------------------ harbour board

export const BOARD_OFFERS = 3;
export const CONTRACTS_MAX = 3;
export const CONTRACT_GOOD = 'consignment';
const CARGO_KINDS = Object.freeze([
  'sealed crates of the Guild of Merchants', 'casks of temple wine', 'bundled post and parcels', 'a nobleman\'s furniture',
  'bales of fine cloth', 'chests of minted coin under seal', 'barrels of lamp oil', 'a scholar\'s library',
]);
/** Map pixels to leagues (Daggerfall's world map: 1 pixel is about one league across). */
export const PX_LEAGUE = 1;
export const PAY_BASE = 60;
export const PAY_PER_LEAGUE = 7;
export const PAY_PER_UNIT = 5;
export const LATE_SHARE = 0.5;

/** Distance in leagues between two ports with map pixel positions, or null. */
export function leaguesBetween(a, b) {
  if (![a?.px, a?.py, b?.px, b?.py].every(Number.isFinite)) return null;
  return Math.max(1, Math.round(Math.hypot(a.px - b.px, a.py - b.py) * PX_LEAGUE));
}

/**
 * The day's offers at a port: [{id, from, to, toName, units, kind, pay, days, leagues}].
 * `ports` are real sea ports [{id, name, px, py}] (the port itself is skipped); `route(a,b)` may give {days, leagues}.
 */
export function boardAt(port, day, ports, { route = null, taken = [] } = {}) {
  const dests = (ports ?? []).filter((q) => q?.id && q.id !== port.id);
  if (!dests.length) return [];
  const out = [];
  for (let i = 0; i < BOARD_OFFERS; i++) {
    const seed = `${port.id}|${day}|b${i}`;
    const to = dests[hash(seed + 'to') % dests.length];
    // The destination is part of the notice's id: a notice whose port list changed is a different notice.
    const id = `hb-${day.toString(36)}-${(hash(port.id) % 1679616).toString(36)}-${i}${(hash(to.id) % 1296).toString(36)}`;
    if (taken.includes(id)) continue;
    const r = route?.(port.id, to.id) ?? null;
    if (r === false) continue; // no water path between these ports
    const leagues = Number.isFinite(r?.leagues) ? Math.max(1, Math.round(r.leagues)) : leaguesBetween(port, to) ?? 20;
    const units = 4 + (hash(seed + 'u') % 22);
    const sailDays = Number.isFinite(r?.days) ? r.days : Math.max(1, leagues / 25);
    out.push({
      id, from: port.id, fromName: port.name ?? null, to: to.id, toName: to.name ?? to.id, units,
      kind: CARGO_KINDS[hash(seed + 'k') % CARGO_KINDS.length],
      pay: Math.round(PAY_BASE + leagues * PAY_PER_LEAGUE + units * PAY_PER_UNIT),
      days: Math.ceil(sailDays * 2 + 3), leagues,
    });
  }
  return out;
}
