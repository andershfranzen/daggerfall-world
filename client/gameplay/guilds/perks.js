// Guild and temple membership perks that both the browser and the server need (package 15).
//
// The server stores memberships as `rpg.guilds[group] = {rank, variant?}` (server/rpg/guilds.js). The browser
// reads the same object from the character state, so it can price a journey exactly as the server will.
// Formulas follow the Daggerfall Unity guild classes (MIT, (c) 2009-2023 Daggerfall Workshop):
// Temple.FastTravel, Temple.DeepBreath, Temple.AvoidDeath and KnightlyOrder.FreeTavernRooms.

/** Deity faction ids (Temple.Divines). */
export const AKATOSH = 26;
export const KYNARETH = 35;
export const STENDARR = 33;

/** KnightlyOrder.Orders: the order's faction id and its home region index (FACTION.TXT, 0-based). */
export const ORDER_HOME_REGION = Object.freeze({
  368: 17, 408: 20, 409: 23, 410: 21, 411: 22, 413: 18, 414: 5, 415: 43, 416: 51, 417: 54,
});

const rankOf = (m) => (m && Number.isInteger(m.rank) && m.rank >= 0 ? m.rank : null);
export const freeShipTravel = (rank) => Number.isInteger(rank) && rank >= 6;
/** Rank in the temple of `deity`, or null. */
export function templeRankOf(guilds, deity) {
  const m = guilds?.temple;
  return m && m.variant === deity ? rankOf(m) : null;
}

/** Temple.FastTravel: Akatosh members spend (95 - rank)% of the journey time. */
export function fastTravelMinutes(minutes, guilds) {
  const rank = templeRankOf(guilds, AKATOSH);
  if (rank === null || !Number.isFinite(minutes)) return minutes;
  return Math.trunc(((95 - rank) / 100) * minutes);
}

/** Temple.DeepBreath: Kynareth members hold their breath (10 + rank) / 10 times as long. */
export function breathScale(guilds) {
  const rank = templeRankOf(guilds, KYNARETH);
  return rank === null ? 1 : (10 + rank) / 10;
}

/**
 * Temple.AvoidDeath: a Stendarr member who is not under water escapes death when Random.Range(0, 50) < rank.
 * `roll` is that integer roll, 0..49.
 */
export function avoidsDeath(guilds, roll, submerged = false) {
  const rank = templeRankOf(guilds, STENDARR);
  return rank !== null && !submerged && Number.isFinite(roll) && roll < rank;
}

/** KnightlyOrder.FreeTavernRooms: rank 4 or higher, or any rank in the order's home region. */
export function freeTavernRooms(guilds, regionIndex) {
  const m = guilds?.knights;
  const rank = rankOf(m);
  if (rank === null) return false;
  return rank >= 4 || (ORDER_HOME_REGION[m.variant] ?? -1) === regionIndex;
}
