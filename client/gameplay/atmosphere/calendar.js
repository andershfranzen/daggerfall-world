// Shared world calendar, daylight and weather rules. Pure functions, no DOM: the
// server (server/rpg/atmosphere.js) and the browser module import this same file so
// both sides agree on every date and forecast.
//
// Calendar arithmetic follows Daggerfall Unity's Utility/DaggerfallDateTime.cs
// (MIT, (c) 2009-2023 Daggerfall Workshop) by way of daggerfall-js-source
// src/systems/gameDate.js (MIT, (c) 2026 Lattymoy): twelve 30-day months, a
// 7-day week, dawn at 06:00 and dusk at 18:00, the classic minute counter and its
// epoch, and the new-game start of 13:30 on the 4th of Morning Star, 3E405.
// Notices: client/gameplay/atmosphere/NOTICES.txt.
//
// The weather schedule and the light curve are this project's own.

import { regionNameOf } from '../travel/identity.js';
import { CLIMATE } from '../travel/catalog.js';

export const MINUTES_PER_HOUR = 60;
export const HOURS_PER_DAY = 24;
export const MINUTES_PER_DAY = 1440;
export const DAYS_PER_WEEK = 7;
export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const DAYS_PER_YEAR = 360;
export const MINUTES_PER_YEAR = DAYS_PER_YEAR * MINUTES_PER_DAY;
export const DAWN_HOUR = 6;
export const DUSK_HOUR = 18;

/** DaggerfallDateTime.cs:28-29: classic epoch (seconds) and new-game start (classic minutes). */
export const CLASSIC_EPOCH_IN_SECONDS = 12566016000;
export const CLASSIC_GAME_START_TIME = 523530;
/** Wall-clock instant at which the shared world reads CLASSIC_GAME_START_TIME. */
export const WORLD_EPOCH_MS = Date.UTC(2026, 0, 1);
/** WorldTime.cs: TimeScale = 12 (one real second is twelve game seconds). */
export const DEFAULT_TIME_SCALE = 12;

export const DAY_NAMES = Object.freeze(['Sundas', 'Morndas', 'Tirdas', 'Middas', 'Turdas', 'Fredas', 'Loredas']);
export const MONTH_NAMES = Object.freeze([
  'Morning Star', "Sun's Dawn", 'First Seed', "Rain's Hand", 'Second Seed', 'Midyear',
  "Sun's Height", 'Last Seed', 'Hearthfire', 'Frostfall', "Sun's Dusk", 'Evening Star',
]);
/** GetSeasonValue: clean month boundaries. */
const SEASON_OF_MONTH = Object.freeze(['Winter', 'Winter', 'Spring', 'Spring', 'Spring', 'Summer', 'Summer', 'Summer', 'Fall', 'Fall', 'Fall', 'Winter']);

/** DFU WeatherType names, lower-cased. */
export const WEATHER = Object.freeze(['sunny', 'cloudy', 'overcast', 'fog', 'rain', 'thunder', 'snow']);
export const WEATHER_LABEL = Object.freeze({
  sunny: 'Clear', cloudy: 'Cloudy', overcast: 'Overcast', fog: 'Fog', rain: 'Rain', thunder: 'Thunderstorm', snow: 'Snow', indoors: 'Indoors',
});
/** Game hours a forecast holds before the next roll. */
export const WEATHER_PERIOD_HOURS = 6;

const ordinal = (n) => {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

/**
 * Classic minutes → calendar fields. `day` is the 1-based day of the month; `month` is 0-based.
 * Matches DaggerfallDateTime.FromClassicDaggerfallTime + FromSeconds.
 */
export function dateFromMinutes(classicMinutes) {
  const m = Math.floor(Number(classicMinutes) || 0);
  const total = Math.floor(CLASSIC_EPOCH_IN_SECONDS / 60) + m; // minutes from year 0
  const year = Math.floor(total / MINUTES_PER_YEAR);
  let rest = total - year * MINUTES_PER_YEAR;
  const month = Math.floor(rest / (DAYS_PER_MONTH * MINUTES_PER_DAY));
  rest -= month * DAYS_PER_MONTH * MINUTES_PER_DAY;
  const day0 = Math.floor(rest / MINUTES_PER_DAY);
  rest -= day0 * MINUTES_PER_DAY;
  const hour = Math.floor(rest / 60);
  const minute = rest % 60;
  const weekday = day0 % DAYS_PER_WEEK; // DayValue = (Days)Day
  return {
    classicMinutes: m,
    year, month, day: day0 + 1, hour, minute,
    dayOfYear: month * DAYS_PER_MONTH + day0 + 1,
    minuteOfDay: hour * 60 + minute,
    weekday,
    dayName: DAY_NAMES[weekday],
    monthName: MONTH_NAMES[month],
    season: SEASON_OF_MONTH[month],
    isNight: hour < DAWN_HOUR || hour >= DUSK_HOUR,
  };
}

export const pad2 = (n) => String(n).padStart(2, '0');

/** "Turdas, 4th of Morning Star, 3E405". */
export function formatDate(d) {
  return `${d.dayName}, ${ordinal(d.day)} of ${d.monthName}, 3E${d.year}`;
}
export function formatTime(d) {
  return `${pad2(d.hour)}:${pad2(d.minute)}`;
}

/** World clock in classic minutes for a wall-clock instant. Shared by every player. */
export function worldMinutesAt(wallMs, { epochMs, timeScale = DEFAULT_TIME_SCALE, startMinutes = CLASSIC_GAME_START_TIME }) {
  const realSeconds = Math.max(0, (wallMs - epochMs) / 1000);
  return startMinutes + Math.floor((realSeconds * timeScale) / 60);
}

// ---------------------------------------------------------------- daylight

/**
 * 0 at deep night, 1 at full day, smooth through dawn (05:00-07:30) and dusk (17:00-19:30).
 * @param {number} minuteOfDay 0..1439 (fractional allowed)
 */
export function daylight(minuteOfDay) {
  const h = (((minuteOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY) / 60;
  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  return Math.min(smooth(DAWN_HOUR - 1, DAWN_HOUR + 1.5, h), 1 - smooth(DUSK_HOUR - 1, DUSK_HOUR + 1.5, h));
}

/** Sun direction (unit vector, y up) for the renderer. Rises in the east (+x), sets in the west. */
export function sunDirection(minuteOfDay) {
  const t = (minuteOfDay / MINUTES_PER_DAY) * Math.PI * 2; // 0 = midnight
  const elev = -Math.cos(t); // +1 at noon
  const x = Math.sin(t); // 06:00 → +x (east), 18:00 → -x (west)
  const y = Math.max(0.12, elev * 0.85 + 0.05);
  const z = 0.35;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

// ---------------------------------------------------------------- weather

/** FNV-1a 32-bit, for a stable per-region, per-period roll. */
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // final avalanche
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Weights per season: [sunny, cloudy, overcast, fog, rain, thunder, snow]. */
const WEATHER_WEIGHTS = Object.freeze({
  Winter: [22, 20, 18, 8, 4, 0, 28],
  Spring: [34, 24, 12, 8, 16, 6, 0],
  Summer: [50, 22, 8, 3, 9, 8, 0],
  Fall: [30, 24, 16, 10, 16, 4, 0],
});

// Daggerfall Unity WeatherManager.IsSnowFreeClimate, using the CLIMATE.PAK values.
export function isSnowFreeClimate(climate) {
  return climate === CLIMATE.DESERT || climate === CLIMATE.DESERT2
    || climate === CLIMATE.RAINFOREST || climate === CLIMATE.SUBTROPICAL;
}

/** Region key from a player location string ("town:Daggerfall/Gothway Garden" → "Daggerfall"). */
export function regionOf(location) {
  const s = String(location ?? '');
  const body = s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
  return regionNameOf(body.split('/')[0]) || 'Daggerfall';
}

/** Interiors and dungeons have no sky. */
export function isIndoors(location) {
  return /^(interior|dungeon|building|house|shop|tavern|temple|guild|palace|castle|inside)[:/]/i.test(String(location ?? ''));
}

/**
 * Deterministic forecast for a region at a world time. Each region rolls every
 * WEATHER_PERIOD_HOURS. Snow-free climates turn that region's snow into clear weather.
 * @returns {{type:string,label:string,period:number,nextChangeMinutes:number,intensity:number}}
 */
export function weatherAt(region, classicMinutes, location, climate) {
  const periodLen = WEATHER_PERIOD_HOURS * 60;
  const period = Math.floor(classicMinutes / periodLen);
  const nextChangeMinutes = (period + 1) * periodLen;
  if (location !== undefined && isIndoors(location)) {
    return { type: 'indoors', label: WEATHER_LABEL.indoors, period, nextChangeMinutes, intensity: 0 };
  }
  const season = dateFromMinutes(period * periodLen).season;
  const weights = WEATHER_WEIGHTS[season];
  const roll = hash32(`${String(region).toLowerCase()}#${period}`);
  const total = weights.reduce((a, b) => a + b, 0);
  let pick = roll % total;
  let type = 'sunny';
  for (let i = 0; i < weights.length; i++) {
    if (pick < weights[i]) { type = WEATHER[i]; break; }
    pick -= weights[i];
  }
  if (type === 'snow' && isSnowFreeClimate(climate)) type = 'sunny';
  const intensity = 0.5 + ((roll >>> 20) % 50) / 100; // 0.5..0.99
  return { type, label: WEATHER_LABEL[type], period, nextChangeMinutes, intensity };
}

// ---------------------------------------------------------------- resting

/**
 * Per-hour recovery while resting, after Daggerfall Unity's FormulaHelper:
 * CalculateHealthRecoveryRate (HealingRateModifier(endurance) + (medical+60)*maxHealth/1000, min 1),
 * CalculateFatigueRecoveryRate (maxFatigue/8, min 1) and CalculateSpellPointRecoveryRate (maxMagicka/8, min 1).
 */
export function recoveryPerHour(character, { endurance, rapid = false, noMagicka = false } = {}) {
  const c = character ?? {};
  const stat = (map, name, dflt) => {
    const v = map?.[name];
    const n = typeof v === 'object' && v !== null ? Number(v.value ?? v.live ?? v.base) : Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  const end = endurance ?? stat(c.attributes, 'Endurance', 50);
  const medical = stat(c.skills, 'Medical', 0);
  const maxHealth = Math.max(0, Number(c.maxHealth) || 0);
  const maxFatigue = Math.max(0, Number(c.maxFatigue) || 0);
  const maxMagicka = Math.max(0, Number(c.maxMagicka) || 0);
  return {
    health: maxHealth ? Math.max(Math.floor(Math.floor(end / 10) - 5 + ((medical + (rapid ? 100 : 60)) * maxHealth) / 1000), 1) : 0,
    fatigue: maxFatigue ? Math.max(Math.floor(maxFatigue / 8), 1) : 0,
    magicka: maxMagicka && !noMagicka ? Math.max(Math.floor(maxMagicka / 8), 1) : 0,
  };
}
