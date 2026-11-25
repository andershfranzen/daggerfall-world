// Fast-travel time and cost, shared by server and browser so the quote the
// player sees is the price the server charges.
//
// A JavaScript translation of Daggerfall Unity's Game/Utility/TravelTimeCalculator.cs
// (CalculateTravelTime, CalculateTripCost) and the day rounding in
// Game/UserInterfaceWindows/DaggerfallTravelPopUp.cs (MIT, (c) 2009-2023 Daggerfall
// Workshop). Notices: client/gameplay/travel/NOTICES.txt.
//
// Differences: the start point is passed in rather than read from the player's GPS,
// and guild fast-travel and free tavern room benefits are left to callers through
// `freeInnRooms` / `ownsShip`.

import { CLIMATE } from './catalog.js';
import { freeShipTravel } from '../guilds/perks.js';
import { SHIP_TYPES } from '../property/rules.js';

/** The travel popup waives passage for ship owners and knights of rank six or higher. */
export function hasFreeShipPassage(rpg) {
  return SHIP_TYPES.includes(rpg?.property?.ship?.type) || rpg?.travel?.ownsShip === true
    || freeShipTravel(rpg?.guilds?.knights?.rank);
}

/** TravelTimeCalculator.climateIndices: index into TERRAIN_MODIFIERS by (climate - Ocean). */
const CLIMATE_INDICES = [0, 0, 0, 1, 2, 3, 4, 5, 5, 5];
/** TravelTimeCalculator.terrainMovementModifiers. */
const TERRAIN_MODIFIERS = [240, 220, 200, 200, 230, 250];

export const SPEEDS = Object.freeze(['cautious', 'reckless']);
export const LODGINGS = Object.freeze(['inn', 'camp']);
export const TRANSPORTS = Object.freeze(['foot', 'horse', 'cart']);

/** Fills in and validates journey options from untrusted input. Unknown values fall back to classic defaults. */
export function normalizeOptions(o = {}) {
  return {
    speed: SPEEDS.includes(o.speed) ? o.speed : 'reckless',
    lodging: LODGINGS.includes(o.lodging) ? o.lodging : 'camp',
    ship: o.ship === true,
  };
}

/**
 * Minutes taken along the classic stepped line from `from` to `to` (map pixels).
 * @param {{x,y}} from
 * @param {{x,y}} to
 * @param {{climateAt?: (x:number,y:number)=>number, speed?, lodging?, ship?, transport?, onStep?}} opts
 *   `climateAt` returns the CLIMATE.PAK value at a map pixel; without it every
 *   step counts as Woodlands (the server's fallback when it has no PAK file).
 *   `onStep(x, y, minutesSoFar, climate)` sees every pixel of the classic route (minutes before
 *   the final reckless halving, which scales every step alike).
 */
export function travelMinutes(from, to, opts = {}) {
  const { speed = 'reckless', lodging = 'camp', ship = false, transport = 'foot', climateAt = null, onStep = null } = opts;
  const transportModifier = transport === 'horse' ? 128 : transport === 'cart' ? 192 : 256;
  let x = from.x | 0, y = from.y | 0;
  const dx = (to.x | 0) - x, dy = (to.y | 0) - y;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  const furthest = Math.max(ax, ay);
  const sx = dx >= 0 ? 1 : -1, sy = dy >= 0 ? 1 : -1;
  let acc = 0, total = 0, oceanPixels = 0;
  const terrain = {};
  for (let n = 0; n < furthest; n++) {
    if (furthest === ax) {
      x += sx;
      acc += ay;
      if (acc > ax) { acc -= ax; y += sy; }
    } else {
      y += sy;
      acc += ax;
      if (acc > ay) { acc -= ay; x += sx; }
    }
    let climate = climateAt ? climateAt(x, y) : CLIMATE.WOODLANDS;
    if (!(climate >= CLIMATE.OCEAN && climate <= CLIMATE.HAUNTED_WOODLANDS)) climate = CLIMATE.WOODLANDS;
    let minutes;
    if (climate === CLIMATE.OCEAN) {
      oceanPixels++;
      minutes = ship ? 51 : 255;
    } else {
      const mod = TERRAIN_MODIFIERS[CLIMATE_INDICES[climate - CLIMATE.OCEAN]];
      minutes = (((102 * transportModifier) >> 8) * (256 - mod + 256)) >> 8;
    }
    if (lodging !== 'inn') minutes = (300 * minutes) >> 8;
    total += minutes;
    terrain[climate] = (terrain[climate] ?? 0) + 1;
    if (onStep) onStep(x, y, total, climate);
  }
  if (speed !== 'cautious') total >>= 1;
  return { minutes: total, oceanPixels, steps: furthest, terrain };
}

/** TravelTimeCalculator.CalculateTripCost. Returns gold for inns and ship passage. */
export function tripCost(minutes, oceanPixels, { lodging = 'camp', ship = false, ownsShip = false, freePassage = ownsShip, freeInnRooms = false } = {}) {
  const hours = Math.trunc((minutes + 59) / 60);
  let inn = 0;
  if (lodging === 'inn' && !freeInnRooms) {
    inn = 5 * Math.trunc((hours - oceanPixels) / 24);
    if (inn < 0) inn = 0;
    inn += 5;
  }
  let passage = 0;
  if (oceanPixels > 0 && !freePassage && ship) passage = 25 * (Math.trunc(oceanPixels / 24) + 1);
  return { inn, passage, total: inn + passage };
}

/** Whole days shown on the classic popup: DFU rounds up only when there is a remainder. */
export const travelDays = (minutes) => Math.trunc(minutes / 1440) + (minutes % 1440 > 0 ? 1 : 0);

/**
 * Full quote for a journey between two catalogue entries.
 * @returns {{minutes, days, oceanPixels, cost:{inn,passage,total}, options, shipUseful:boolean, distance:number}}
 */
export function quoteJourney(from, to, options = {}, { climateAt = null, transport = 'foot', ownsShip = false, freePassage = ownsShip, freeInnRooms = false, fastTravel = null } = {}) {
  const o = normalizeOptions(options);
  const t = travelMinutes(from, to, { ...o, transport, climateAt });
  // GuildManager.FastTravel (Akatosh, client/gameplay/guilds/perks.js) shortens the journey before days and cost.
  const minutes = typeof fastTravel === 'function' ? Math.max(0, Math.trunc(fastTravel(t.minutes)) || 0) : t.minutes;
  const cost = tripCost(minutes, t.oceanPixels, { lodging: o.lodging, ship: o.ship, freePassage, freeInnRooms });
  return {
    minutes,
    days: travelDays(minutes),
    oceanPixels: t.oceanPixels,
    steps: t.steps,
    terrain: t.terrain,
    cost,
    options: o,
    transport,
    shipUseful: t.oceanPixels > 0,
  };
}

// ------------------------------------------------------------------ journey presentation
//
// The server commits a journey at once (fare, arrival, discovery) and the browser then shows it:
// the traveller rides or walks the same stepped route the price was computed on, with progress
// measured in that route's own minutes, so slow country (and sea) takes visibly longer.

/** Real seconds the journey is shown for: brief, a little longer for long roads. */
export function presentationMs(days, { reducedMotion = false } = {}) {
  if (reducedMotion) return 1500;
  const d = Number.isFinite(days) && days > 0 ? days : 1;
  return Math.round(Math.min(7000, Math.max(3200, 2600 + 300 * d)));
}

/**
 * The classic route as map-pixel waypoints with progress `f` in [0, 1] by travel time.
 * @returns {{points: {x:number, y:number, f:number, climate:number}[], minutes:number}}
 */
export function journeyRoute(from, to, opts = {}) {
  const raw = [{ x: from.x | 0, y: from.y | 0, m: 0, climate: null }];
  travelMinutes(from, to, { ...opts, onStep: (x, y, m, climate) => raw.push({ x, y, m, climate }) });
  // The classic stepped line can stop a pixel short on the minor axis; the traveller still arrives.
  const last = raw[raw.length - 1];
  if (last.x !== (to.x | 0) || last.y !== (to.y | 0)) raw.push({ x: to.x | 0, y: to.y | 0, m: last.m, climate: last.climate });
  const total = raw[raw.length - 1].m || 1;
  return {
    points: raw.map((p, i) => ({ x: p.x, y: p.y, f: i === raw.length - 1 ? 1 : raw.length > 1 ? p.m / total : 1, climate: p.climate })),
    minutes: total,
  };
}

/** Map-pixel position (fractional) along a route at progress `f`. */
export function routeAt(points, f) {
  if (!points.length) return { x: 0, y: 0 };
  if (f <= 0 || points.length === 1) return { x: points[0].x, y: points[0].y };
  if (f >= 1) { const l = points[points.length - 1]; return { x: l.x, y: l.y }; }
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].f <= f) lo = mid; else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const t = b.f > a.f ? (f - a.f) / (b.f - a.f) : 1;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}
