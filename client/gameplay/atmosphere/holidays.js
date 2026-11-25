// Classic holidays and their service effects. Pure functions shared by the server and browser.
//
// The calendar tables follow Daggerfall Unity FormulaHelper.GetHolidayId (MIT, (c) 2009-2023
// Daggerfall Workshop): 53 holidays, each on one day of the 360-day year, celebrated either in
// every region or in exactly one MAPS region (regionIndex is 0-based; the source table stores
// regionIndex + 1 and 0xFF for "everywhere"). Days 356-360 are never holidays.
//
// IDs. `id` is the classic DFLocation.Holidays ordinal (1..53). `key` is this project's stable
// kebab-case name derived from the enum (Suns_Rest -> 'suns-rest'). Consumers compare keys;
// both are stable. Old_Life_Festival (54) has no calendar day in the source and is not listed.
//
// Service effects (who consumes them, source file in the reference revision):
//   suns-rest            shops are locked all day            PlayerActivate.cs:1297
//   hearts-day           a rented room costs nothing that day FormulaHelper.CalculateRoomCost
//   new-life             tavern food and drink are free       DaggerfallTavernWindow.cs:318
//   harvest-end          tavern food and drink half (min 1)   DaggerfallTavernWindow.cs:318
//   witches-festival     identification free, spell price half (min 1)
//                                                             FormulaHelper.CalculateItemIdentifyCost,
//                                                             DaggerfallSpellBookWindow.cs:526
//   south-winds-prayer, first-harvest, second-harvest
//                        temple disease cure free             DaggerfallGuildServiceCureDisease.cs:66
//   north-winds-festival temple disease cure half             DaggerfallGuildServiceCureDisease.cs:88
//   merchants-festival   non-guild shop purchases half        DaggerfallTradeWindow.cs:444
//   tales-and-tallow     Mages Guild shop purchases half
//   warriors-festival    non-guild weapon purchases half
// Every holiday shows its TEXT.RSC record 8349 + id when the player steps outside
// (PlayerEnterExit.cs:567).

import { MINUTES_PER_DAY, DAYS_PER_YEAR } from './calendar.js';

const ENUM = [
  'New_Life', 'Scour_Day', 'Ovanka', 'South_Winds_Prayer', 'Day_of_Lights', 'Waking_Day', 'Mad_Pelagius',
  'Othroktide', 'Day_of_Release', 'Hearts_Day', 'Perserverance_Day', 'Aduros_Nau', 'First_Harvest',
  'Day_of_Waiting', 'Flower_Day', 'Festival_of_Blades', 'Gardtide', 'Day_of_the_Dead', 'Day_of_Shame',
  'Jesters_Day', 'Second_Harvest', 'Marukhs_Day', 'Fire_Festival', 'Fishing_Day', 'Drigh_RZimb', 'Mid_Year',
  'Dancing_Day', 'Tibedetha', 'Merchants_Festival', 'Divad_Etept', 'Suns_Rest', 'Fiery_Night', 'Maiden_Katrica',
  'Koomu_Alazeri', 'Feast_of_the_Tiger', 'Appreciation_Day', 'Harvest_End', 'Tales_and_Tallow', 'Khurat',
  'Riglametha', 'Childrens_Day', 'Dirij_Tereur', 'Witches_Festival', 'Broken_Diamonds', 'Emperors_Birthday',
  'Serpents_Dance', 'Moon_Festival', 'Hel_Anseilak', 'Warriors_Festival', 'North_Winds_Festival', 'Baranth_Do',
  'Chila', 'Saturalia',
];

// Display names where the enum drops an apostrophe or spells a word differently.
const DISPLAY = {
  Hearts_Day: "Heart's Day", Suns_Rest: "Sun's Rest", Mad_Pelagius: 'Mad Pelagius', Marukhs_Day: "Marukh's Day",
  Merchants_Festival: "Merchants' Festival", Jesters_Day: "Jester's Day", Childrens_Day: "Children's Day",
  Witches_Festival: "Witches' Festival", Emperors_Birthday: "Emperor's Birthday", Serpents_Dance: "Serpent's Dance",
  Warriors_Festival: "Warriors' Festival", Harvest_End: "Harvest's End", Drigh_RZimb: "Drigh R'Zimb",
  Perserverance_Day: 'Day of Perseverance', New_Life: 'New Life Festival', Tales_and_Tallow: 'Tales and Tallows',
  Mid_Year: 'Mid Year Celebration', Dirij_Tereur: 'Dirij Tereur', Divad_Etept: 'Divad Etep’t',
};

/** FormulaHelper.GetHolidayId: region per holiday (0xFF = all regions, else MAPS regionIndex + 1). */
const REGION = [0xFF, 0x19, 0x01, 0xFF, 0x1D, 0x05, 0x19, 0x06, 0x3C, 0xFF, 0x29, 0x1A,
  0xFF, 0x02, 0x19, 0x01, 0x0E, 0x12, 0x14, 0xFF, 0xFF, 0x1C, 0x21, 0x1F, 0x2C, 0xFF, 0x12,
  0x23, 0xFF, 0x38, 0xFF, 0x01, 0x30, 0x29, 0x0B, 0x16, 0xFF, 0xFF, 0x11, 0x17, 0x14, 0x01,
  0xFF, 0x13, 0xFF, 0x33, 0x3C, 0x2E, 0xFF, 0xFF, 0x01, 0x2D, 0x18];
/** FormulaHelper.GetHolidayId: day of the year (1..360) per holiday. */
const DAY = [0x01, 0x02, 0x0C, 0x0F, 0x10, 0x12, 0x20, 0x23, 0x26, 0x2E, 0x39, 0x3A,
  0x43, 0x45, 0x55, 0x56, 0x5B, 0x67, 0x6E, 0x76, 0x7F, 0x81, 0x8C, 0x96, 0x97, 0xA6, 0xAD,
  0xAE, 0xBE, 0xC0, 0xC8, 0xD1, 0xD4, 0xDD, 0xE0, 0xE7, 0xED, 0xF3, 0xF6, 0xFC, 0x103, 0x113,
  0x11B, 0x125, 0x12C, 0x12F, 0x134, 0x13E, 0x140, 0x159, 0x15C, 0x162, 0x163];

export const HOLIDAY_TEXT_BASE = 8349;

const keyOf = (enumName) => enumName.toLowerCase().replace(/_/g, '-');

/** All 53 calendar holidays: {id, key, enumName, name, dayOfYear, month (0-based), day, regionIndex|null, textId}. */
export const HOLIDAYS = Object.freeze(ENUM.map((enumName, i) => {
  const dayOfYear = DAY[i];
  return Object.freeze({
    id: i + 1,
    key: keyOf(enumName),
    enumName,
    name: DISPLAY[enumName] ?? enumName.replace(/_/g, ' '),
    dayOfYear,
    month: Math.floor((dayOfYear - 1) / 30),
    day: ((dayOfYear - 1) % 30) + 1,
    regionIndex: REGION[i] === 0xFF ? null : REGION[i] - 1,
    textId: HOLIDAY_TEXT_BASE + i + 1,
  });
}));

const BY_KEY = new Map(HOLIDAYS.map((h) => [h.key, h]));
const BY_ID = new Map(HOLIDAYS.map((h) => [h.id, h]));

/** Holiday constants by enum-style name, e.g. HOLIDAY.Suns_Rest === 'suns-rest'. */
export const HOLIDAY = Object.freeze(Object.fromEntries(HOLIDAYS.map((h) => [h.enumName, h.key])));

/** Looks up a holiday by key ('suns-rest'), classic id (31) or enum name ('Suns_Rest'). */
export function holidayInfo(ref) {
  if (typeof ref === 'number') return BY_ID.get(ref) ?? null;
  if (typeof ref !== 'string') return null;
  return BY_KEY.get(ref) ?? BY_KEY.get(keyOf(ref)) ?? null;
}

/** Day of year (1..360) of a classic minute count, exactly as GetHolidayId computes it. */
export function dayOfYearAt(classicMinutes) {
  const m = Math.max(0, Math.floor(Number(classicMinutes) || 0));
  return Math.floor((m % (DAYS_PER_YEAR * MINUTES_PER_DAY)) / MINUTES_PER_DAY) + 1;
}

/** FormulaHelper.GetHolidayId: classic id 1..53, or 0. `regionIndex` is the 0-based MAPS region. */
export function holidayIdAt(classicMinutes, regionIndex) {
  const doy = dayOfYearAt(classicMinutes);
  if (doy > 355) return 0;
  const r = Number.isInteger(regionIndex) ? regionIndex : -2;
  for (let i = 0; i < DAY.length; i++) {
    if ((REGION[i] === 0xFF || REGION[i] === r + 1) && DAY[i] === doy) return i + 1;
  }
  return 0;
}

/** The holiday key celebrated at that minute in that region, or null. */
export function holidayAt(classicMinutes, regionIndex) {
  return BY_ID.get(holidayIdAt(classicMinutes, regionIndex))?.key ?? null;
}

/** Holidays in a region (or everywhere when regionIndex is null) in calendar order. */
export function holidaysOf(regionIndex) {
  return HOLIDAYS.filter((h) => h.regionIndex === null || h.regionIndex === regionIndex);
}

/** Shops (RMBLayout.IsShop types) are locked all day. */
export const shopsClosed = (key) => key === 'suns-rest';

const half = (price, min1) => {
  const v = Math.floor(price / 2);
  return min1 && v === 0 ? 1 : v;
};

/**
 * Applies a holiday's classic price rule. Returns {price, free, holiday, rule} where `rule` names the
 * effect applied (null when the holiday does not change this service).
 *   service: 'tavern' (food/drink), 'room', 'identify', 'spell', 'cure', 'trade'
 *   opts.guildFaction  faction of the selling guild (trade); 40 = Mages Guild; null for ordinary shops
 *   opts.itemGroup     'Weapons' for weapons (trade)
 *   opts.days          rental days (room); one day of a rental that spans Heart's Day is free
 *   opts.startDayOfYear  rental start (room)
 */
export function holidayPrice(service, price, key, opts = {}) {
  const base = Math.max(0, Math.floor(Number(price) || 0));
  const out = (p, rule) => ({ price: p, free: p === 0 && base > 0, holiday: key ?? null, rule });
  switch (service) {
    case 'tavern':
      if (key === 'new-life') return out(0, 'free');
      if (key === 'harvest-end') return out(half(base, true), 'half');
      break;
    case 'identify':
      if (key === 'witches-festival') return out(0, 'free');
      break;
    case 'spell':
      if (key === 'witches-festival') return out(half(base, true), 'half');
      break;
    case 'cure':
      if (key === 'south-winds-prayer' || key === 'first-harvest' || key === 'second-harvest') return out(0, 'free');
      if (key === 'north-winds-festival') return out(Math.floor(base / 2), 'half');
      break;
    case 'trade': {
      const guild = opts.guildFaction ?? null;
      if (key === 'merchants-festival' && guild === null) return out(Math.floor(base / 2), 'half');
      if (key === 'tales-and-tallow' && guild === MAGES_GUILD_FACTION) return out(Math.floor(base / 2), 'half');
      if (key === 'warriors-festival' && guild === null && opts.itemGroup === 'Weapons') return out(Math.floor(base / 2), 'half');
      break;
    }
    case 'room': {
      // FormulaHelper.CalculateRoomCost: 7 gold a day, no charge for the day that is Heart's Day (day 46).
      const days = Math.max(0, Math.floor(Number(opts.days) || 0));
      const start = Number(opts.startDayOfYear);
      if (days && Number.isFinite(start) && start <= HEARTS_DAY && start + days > HEARTS_DAY) {
        const perDay = days ? base / days : 0;
        return { ...out(Math.round(perDay * (days - 1)), 'hearts-day'), holiday: 'hearts-day' };
      }
      break;
    }
    default:
      break;
  }
  return out(base, null);
}

export const MAGES_GUILD_FACTION = 40;
export const HEARTS_DAY = DAY[9];
