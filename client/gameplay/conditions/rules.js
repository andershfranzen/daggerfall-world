// Shared condition rules for the browser and the server (server/rpg/conditions.js).
// Lunar phases adapted from Daggerfall Unity, Utility/DaggerfallDateTime.cs GetLunarPhase (MIT License,
// Copyright (c) Daggerfall Workshop): a 32-day cycle, Masser offset +3 and Secunda -1 so full moons
// line up with classic Daggerfall.

export const PHASE_LABEL = Object.freeze({
  full: 'Full', threeWane: 'Waning gibbous', halfWane: 'Waning half', oneWane: 'Waning crescent',
  new: 'New', oneWax: 'Waxing crescent', halfWax: 'Waxing half', threeWax: 'Waxing gibbous',
});

/** `date` is client/gameplay/atmosphere/calendar.js dateFromMinutes(); returns a PHASE_LABEL key. */
export function lunarPhase(date, masser) {
  const ratio = (date.dayOfYear + date.year * 12 * 30 + (masser ? 3 : -1)) % 32;
  if (ratio === 0) return 'full';
  if (ratio === 16) return 'new';
  if (ratio <= 5) return 'threeWane';
  if (ratio <= 10) return 'halfWane';
  if (ratio <= 15) return 'oneWane';
  if (ratio <= 22) return 'oneWax';
  if (ratio <= 28) return 'halfWax';
  return 'threeWax';
}
export const moonsOf = (date) => ({ masser: lunarPhase(date, true), secunda: lunarPhase(date, false) });
export const isFullMoon = (date) => lunarPhase(date, true) === 'full' || lunarPhase(date, false) === 'full';
