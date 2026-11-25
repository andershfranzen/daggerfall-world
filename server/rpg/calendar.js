// Holidays, personal time and rest/travel legality (docs/calendar-rest-protocol.md).
//
// The shared world clock lives in atmosphere.js and never moves for one player. This feature adds:
//   - the classic holiday calendar per region (client/gameplay/atmosphere/holidays.js) and its
//     service price rules, plus the holiday notice a player sees on stepping outside;
//   - each character's own clock (`playerMinutes`) = shared minutes + personal ledger minutes, for
//     private timers that should count that character's rest, travel and prison time;
//   - where sleeping is legal (DaggerfallRestWindow.CanRest) and what may block rest or travel.

import { dateFromMinutes, formatDate } from '../../client/gameplay/atmosphere/calendar.js';
import { holidayAt, holidayIdAt, holidayInfo, holidayPrice, dayOfYearAt } from '../../client/gameplay/atmosphere/holidays.js';
import { REGION_NAMES, regionOfPlace } from '../../client/gameplay/travel/catalog.js';
import { exteriorOf } from '../../client/world/interiors/index.js';
import { BUILDING } from './npcs/people.js';

export const name = 'calendar';

/** DFRegion.LocationTypes that PlayerGPS.IsPlayerInTown treats as a town. */
const TOWN_TYPES = new Set(['city', 'hamlet', 'village', 'farm', 'wealthy', 'tavern', 'temple']);
/** TEXT.RSC record 17 (DaggerfallRestWindow.cityCampingIllegal). */
export const CITY_CAMPING_ILLEGAL = 17;

/** Kind of place a location id names: 'town' exterior, 'interior', 'dungeon', 'wilderness' or 'unknown'. */
export function placeKind(location) {
  const s = String(location ?? '');
  if (s.startsWith('town:')) return 'town';
  if (s.startsWith('interior:') || s.startsWith('building:')) return 'interior';
  if (s.startsWith('dungeon:')) return 'dungeon';
  if (s.startsWith('wilderness:')) return 'wilderness';
  return 'unknown';
}

export function install(ctx) {
  const s = ctx.services;
  const nowMinutes = () => s.worldClock?.().minutes ?? 0;

  s.preventRest ??= new Map();
  s.preventTravel ??= new Map();

  /** 0-based MAPS region index of any place address, or null. */
  function regionIndexOf(location) {
    const name = s.travel?.regionOf?.(location) ?? regionOfPlace(location);
    if (!name) return null;
    const i = REGION_NAMES.indexOf(name);
    if (i >= 0) return i;
    const lower = name.toLowerCase();
    const ci = REGION_NAMES.findIndex((r) => r.toLowerCase() === lower);
    return ci >= 0 ? ci : null;
  }

  /** Is this place a town in the classic sense (city, village, farm, manor, tavern, temple)? */
  function inTown(location) {
    const town = placeKind(location) === 'town' ? location : exteriorOf(location);
    if (!town || !town.startsWith('town:')) return false;
    const entry = s.travel?.lookup?.(town);
    return entry ? TOWN_TYPES.has(entry.type) : true; // unknown while loading: treat as a town (stricter)
  }

  const personalMinutes = (p) => Math.max(0, Number(p?.rpg?.atmosphere?.personalMinutes) || 0);
  const playerMinutes = (p) => nowMinutes() + personalMinutes(p);

  // ---------------------------------------------------------------- holidays

  s.holidayAt = (minutes, regionIndex) => holidayAt(minutes ?? nowMinutes(), regionIndex);
  s.holidayIdAt = (minutes, regionIndex) => holidayIdAt(minutes ?? nowMinutes(), regionIndex);
  s.holidayInfo = holidayInfo;
  s.regionIndexOf = regionIndexOf;
  /** Today's holiday where the player stands, or null. */
  s.holidayFor = (p, minutes = nowMinutes()) => {
    const regionIndex = regionIndexOf(ctx.location(p));
    const info = holidayInfo(holidayIdAt(minutes, regionIndex));
    return info ? { ...info, regionIndex } : null;
  };
  /** Classic holiday price rule for a service; see holidays.js holidayPrice. */
  s.holidayPrice = (service, price, opts = {}) => {
    const minutes = opts.minutes ?? nowMinutes();
    const regionIndex = Number.isInteger(opts.regionIndex) ? opts.regionIndex : opts.p ? regionIndexOf(ctx.location(opts.p)) : null;
    const key = holidayAt(minutes, regionIndex);
    const startDayOfYear = opts.startDayOfYear ?? dayOfYearAt(minutes);
    return holidayPrice(service, price, key, { ...opts, startDayOfYear });
  };

  // ---------------------------------------------------------------- personal time

  s.personalMinutes = personalMinutes;
  s.playerMinutes = playerMinutes;
  s.playerClock = (p) => {
    const minutes = playerMinutes(p);
    return { minutes, ...dateFromMinutes(minutes) };
  };

  // ---------------------------------------------------------------- legality

  const firstMessage = (registry, p) => {
    for (const [key, fn] of registry) {
      try {
        const msg = fn(p);
        if (msg) return String(msg);
      } catch (err) {
        ctx.log?.error?.(`[calendar] ${key} check failed:`, err);
      }
    }
    return null;
  };
  s.restPrevented = (p) => firstMessage(s.preventRest, p);
  s.travelPrevented = (p) => firstMessage(s.preventTravel, p);

  /**
   * DaggerfallRestWindow.CanRest for places that are not inns (package 2 handles inn beds).
   * Returns {ok:true, encounters:boolean} or {ok:false, error, crime?, textId?}.
   * Loitering (RestModes.Loiter) skips CanRest in classic and is allowed anywhere.
   */
  s.restPermission = (p, location = ctx.location(p), mode = 'hours') => {
    const kind = placeKind(location);
    const encounters = kind !== 'interior';
    if (mode === 'loiter') return { ok: true, encounters };
    if (kind === 'town' && inTown(location)) {
      return { ok: false, crime: 'vagrancy', textId: CITY_CAMPING_ILLEGAL, error: 'Camping within the town is forbidden. Find an inn or leave the town to rest.' };
    }
    if (kind === 'interior' && inTown(location)) {
      const portal = s.portals?.into?.(location) ?? null;
      const type = portal?.meta?.buildingType;
      if (s.ownsBuilding?.(p, portal ?? location)) return { ok: true, encounters: false };
      if (type === BUILDING.Ship) return { ok: true, encounters: false };
      if (type !== BUILDING.Tavern && s.guildCanRest?.(p, portal ?? location)) return { ok: true, encounters: false };
      return { ok: false, error: 'You have not rented a room here.' };
    }
    return { ok: true, encounters };
  };

  /** Reports vagrancy (classic Crimes.Vagrancy, then SpawnCityGuards). Outside actions it is a no-op for rollback. */
  s.reportVagrancy = (p, location = ctx.location(p)) => {
    ctx.emit('crime', { player: p, crime: 'vagrancy', location });
    s.reportCrime?.(p, 'vagrancy', { location });
  };

  // ---------------------------------------------------------------- holiday notice

  // PlayerEnterExit shows TEXT.RSC 8349 + id when the player steps outside on a holiday. Once per
  // character per holiday date, kept on the character so a reconnect does not repeat it.
  function announce(p) {
    const loc = ctx.location(p);
    if (placeKind(loc) !== 'town' || p.arriving) return;
    const minutes = nowMinutes();
    const h = s.holidayFor(p, minutes);
    if (!h) return;
    const d = dateFromMinutes(minutes);
    const stamp = `${d.year}:${d.dayOfYear}:${h.id}`;
    const cal = p.rpg.calendar && typeof p.rpg.calendar === 'object' ? p.rpg.calendar : (p.rpg.calendar = {});
    if (cal.holidaySeen === stamp) return;
    cal.holidaySeen = stamp;
    ctx.dirty(p);
    ctx.notify(p, {
      kind: 'holiday', id: h.id, key: h.key, name: h.name, textId: h.textId, regionIndex: h.regionIndex,
      date: formatDate(d),
      text: `Today is ${h.name}.${effectNote(h.key)}`,
    });
    ctx.emit('holiday', { player: p, holiday: h });
  }

  ctx.on('travel', ({ player }) => {
    if (player) announce(player);
  });

  ctx.onTick(() => {
    for (const p of ctx.players.values()) announce(p);
  });

  return { regionIndexOf, inTown, playerMinutes };
}

/** One-line hint at the classic service change on that day. */
export function effectNote(key) {
  switch (key) {
    case 'suns-rest': return ' The shops are closed.';
    case 'new-life': return ' Food and drink are free at the taverns.';
    case 'harvest-end': return ' Taverns serve food and drink at half price.';
    case 'hearts-day': return ' A night at an inn costs nothing.';
    case 'witches-festival': return ' Identification is free and spells cost half.';
    case 'merchants-festival': return ' Merchants sell at half price.';
    case 'tales-and-tallow': return ' The Mages Guild sells at half price.';
    case 'warriors-festival': return ' Weapons are sold at half price.';
    case 'south-winds-prayer': case 'first-harvest': case 'second-harvest': return ' The temples cure diseases for free.';
    case 'north-winds-festival': return ' The temples cure diseases at half price.';
    default: return '';
  }
}
