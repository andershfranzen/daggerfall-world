// Shared world clock, regional weather and interruptible resting.
//
// THE CLOCK IS SHARED AND NEVER SKIPS. World time is a pure function of wall-clock
// time (Daggerfall's 12x timescale from a fixed epoch), so it survives restarts with
// no stored state and every connected player reads the same date. One player resting
// or travelling does not move it for anyone: a rest runs in accelerated *recovery*
// time (one rested hour per `restSecondsPerHour` real seconds) while the world keeps
// its pace, and other features that consume time for a single player
// (`ctx.services.spendTime`) only record it against that player's own ledger.
//
// Calendar and recovery formulas live in client/gameplay/atmosphere/calendar.js so the
// browser and the server share one implementation.

import {
  CLASSIC_GAME_START_TIME,
  DEFAULT_TIME_SCALE,
  dateFromMinutes,
  formatDate,
  formatTime,
  isIndoors,
  recoveryPerHour,
  regionOf,
  weatherAt,
  WEATHER_LABEL,
  WEATHER_TABLE,
  climateWeatherGroup,
  weatherWeightsFor,
  WORLD_EPOCH_MS,
} from '../../client/gameplay/atmosphere/calendar.js';

export { WEATHER_TABLE, climateWeatherGroup, weatherWeightsFor };

export const DEFAULTS = Object.freeze({
  /** Wall-clock instant at which the world reads the new-game start (3E405, 4 Morning Star, 13:30). */
  epochMs: WORLD_EPOCH_MS,
  timeScale: DEFAULT_TIME_SCALE,
  startMinutes: CLASSIC_GAME_START_TIME,
  /** Real seconds per rested hour. */
  restSecondsPerHour: 1.5,
  maxRestHours: 99,
  /** A living monster this close (world units) in the same location makes resting unsafe. */
  safeRadius: 40,
  /** Movement beyond this distance (world units) breaks a rest. */
  moveTolerance: 0.75,
});

const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.trunc(v)));

export function install(ctx, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const wallNow = typeof options.wallNow === 'function' ? options.wallNow : () => Date.now();

  /** Per-player transient state, keyed by player id. */
  const seen = new Map(); // id -> { location, region, climate, weather, hour }
  const resting = new Map(); // id -> rest session

  const worldMinutes = () => {
    const real = Math.max(0, (wallNow() - cfg.epochMs) / 1000);
    return cfg.startMinutes + Math.floor((real * cfg.timeScale) / 60);
  };

  const locationOf = (p) => String(p?.rpg?.location ?? 'town:Daggerfall/Gothway Garden');

  /**
   * The political region whose weather a place shares. A wilderness pixel is in the region POLITIC.PAK
   * gives it (travel service), so walking out of a town keeps its sky. Until the map data has loaded,
   * a wilderness player keeps the region of the town they last stood in.
   */
  function regionFor(location, p = null) {
    const known = ctx.services.travel?.regionOf?.(location);
    if (known) return known;
    if (location.startsWith('wilderness:')) {
      const last = p?.rpg?.travel?.lastTown;
      if (typeof last === 'string' && last.startsWith('town:')) return regionOf(last);
    }
    return regionOf(location);
  }

  const climateFor = (location) => ctx.services.travel?.climateOf?.(location) ?? null;
  const weatherFor = (location, minutes = worldMinutes(), p = null) =>
    weatherAt(regionFor(location, p), minutes, location, climateFor(location));

  function clockEvent(p) {
    const minutes = worldMinutes();
    const date = dateFromMinutes(minutes);
    const location = locationOf(p);
    const region = regionFor(location, p);
    const climate = climateFor(location);
    const w = weatherAt(region, minutes, location, climate);
    return {
      kind: 'clock',
      minutes,
      minutesPerSecond: cfg.timeScale / 60,
      date: formatDate(date),
      time: formatTime(date),
      season: date.season,
      night: date.isNight,
      location,
      region,
      climate,
      indoors: isIndoors(location),
      weather: w.type,
      weatherLabel: w.label,
      weatherIntensity: w.intensity,
      weatherChangesAt: w.nextChangeMinutes,
      resting: restSummary(p),
      holiday: holidayOf(p, minutes),
    };
  }

  /** Today's holiday where the player stands (server/rpg/calendar.js), as {key, name, textId}, or null. */
  function holidayOf(p, minutes) {
    const h = ctx.services.holidayFor?.(p, minutes);
    return h ? { key: h.key, name: h.name, textId: h.textId } : null;
  }

  function sendClock(p) {
    const ev = clockEvent(p);
    const { location, region, climate, weather, minutes } = ev;
    seen.set(p.id, { location, region, climate, weather, hour: Math.floor(minutes / 60) });
    ctx.notify(p, ev);
  }

  function ledger(p) {
    if (!p.rpg) p.rpg = {};
    const a = p.rpg.atmosphere;
    if (!a || typeof a !== 'object') {
      p.rpg.atmosphere = { restedHours: 0, personalMinutes: 0, lastRestEnded: null };
    } else {
      a.restedHours = Number(a.restedHours) || 0;
      a.personalMinutes = Number(a.personalMinutes) || 0;
      if (a.lastRestEnded === undefined) a.lastRestEnded = null;
    }
    return p.rpg.atmosphere;
  }

  function restSummary(p) {
    const r = resting.get(p.id);
    if (!r) return null;
    return { mode: r.mode, hoursDone: r.hoursDone, hoursPlanned: r.mode === 'healed' ? null : r.hoursPlanned };
  }

  function vitalsFull(p) {
    const c = p.rpg.character;
    const rate = ctx.services.characterRestRecovery?.(p) ?? recoveryPerHour(c);
    return ['health', 'fatigue', 'magicka'].every((k) => {
      const max = Number(c?.[`max${k[0].toUpperCase()}${k.slice(1)}`]) || 0;
      return !rate[k] || (Number(c[k]) || 0) >= max;
    });
  }

  function threatNear(p) {
    const loc = locationOf(p);
    const threatens = ctx.services.monsterThreatens; // package 8: alive, hostile, sees the player, same floor
    for (const e of ctx.entities.values()) {
      if (e.kind !== 'monster' || e.location !== loc) continue;
      if (typeof threatens === 'function') {
        if (threatens(e, p) && Math.hypot((e.x ?? 0) - p.x, (e.z ?? 0) - p.z) <= cfg.safeRadius) return e;
        continue;
      }
      if (e.hp !== undefined && Number(e.hp) <= 0) continue;
      if (e.hostile === false) continue;
      if (Math.hypot((e.x ?? 0) - p.x, (e.z ?? 0) - p.z) <= cfg.safeRadius) return e;
    }
    return null;
  }

  function finishRest(p, reason, text) {
    const r = resting.get(p.id);
    if (!r) return false;
    resting.delete(p.id);
    const a = ledger(p);
    a.lastRestEnded = worldMinutes();
    ctx.dirty(p);
    const interrupted = reason !== 'done' && reason !== 'healed' && reason !== 'stopped';
    const loiter = r.mode === 'loiter';
    ctx.notify(p, {
      kind: 'rest',
      state: interrupted ? 'interrupted' : 'done',
      reason,
      hoursDone: r.hoursDone,
      mode: r.mode,
      text: text ?? (interrupted ? (loiter ? 'You stop waiting.' : 'Your rest was interrupted.')
        : loiter ? `You finish loitering after ${r.hoursDone} hour${r.hoursDone === 1 ? '' : 's'}.`
          : `You rested for ${r.hoursDone} hour${r.hoursDone === 1 ? '' : 's'}.`),
      vitals: vitals(p),
    });
    ctx.emit('restEnd', { player: p, reason, hours: r.hoursDone, mode: r.mode });
    return true;
  }

  function vitals(p) {
    const c = p.rpg?.character ?? {};
    return {
      health: c.health, maxHealth: c.maxHealth,
      fatigue: c.fatigue, maxFatigue: c.maxFatigue,
      magicka: c.magicka, maxMagicka: c.maxMagicka,
    };
  }

  function applyHour(p) {
    const c = p.rpg.character;
    const rate = ctx.services.characterRestRecovery?.(p) ?? recoveryPerHour(c);
    for (const k of ['health', 'fatigue', 'magicka']) {
      const maxKey = `max${k[0].toUpperCase()}${k.slice(1)}`;
      const max = Number(c[maxKey]) || 0;
      if (!max) continue;
      c[k] = Math.min(max, (Number(c[k]) || 0) + rate[k]);
    }
  }

  /** Calls restEncounter once per minute of the next rested hour; returns the first monster or null. */
  function rollEncounter(p, r) {
    const roll = ctx.services.restEncounter;
    if (typeof roll !== 'function') return null;
    const base = r.startMinute + r.hoursDone * 60;
    for (let i = 1; i <= 60; i++) {
      const foe = roll(p, base + i);
      if (foe) return foe;
    }
    return null;
  }

  // ---------------------------------------------------------------- services

  ctx.services.worldClock = () => {
    const minutes = worldMinutes();
    return { minutes, ...dateFromMinutes(minutes) };
  };
  ctx.services.weatherAt = (location) => weatherFor(location);
  ctx.services.isResting = (p) => resting.has(p?.id);
  /** A monster that would stop this player resting or travelling (GameManager.AreEnemiesNearby), or null. */
  ctx.services.enemiesNearby = (p) => threatNear(p);
  ctx.services.interruptRest = (p, reason = 'interrupted', text) => finishRest(p, reason, text);
  /**
   * Record game time a single player spent (travel, training, waiting). It is kept in
   * that player's own ledger and does NOT advance the shared world clock.
   */
  ctx.services.spendTime = (p, minutes, reason = 'time') => {
    const m = Math.max(0, Math.trunc(Number(minutes) || 0));
    if (!m) return 0;
    ctx.dirty(p);
    const a = ledger(p);
    const from = worldMinutes() + a.personalMinutes;
    a.personalMinutes += m;
    ctx.emit('timeSpent', { player: p, minutes: m, reason, from, to: from + m });
    return m;
  };

  // ---------------------------------------------------------------- actions

  ctx.onAction('rest.start', (p, args = {}) => {
    const c = p.rpg?.character;
    if (!c || !Number(c.maxHealth)) throw new Error('Create your character before resting.');
    if (resting.has(p.id)) throw new Error('You are already resting.');
    const mode = args.mode === 'healed' ? 'healed' : args.mode === 'loiter' ? 'loiter' : 'hours';
    let hours = 0;
    if (mode !== 'healed') {
      hours = Number(args.hours);
      if (!Number.isFinite(hours) || hours < 1) throw new Error('Choose how many hours to rest (at least 1).');
      hours = clampInt(hours, 1, cfg.maxRestHours);
    }
    if (p.moving) throw new Error('You cannot rest while moving.');
    if (p.rpg.readied) throw new Error('Sheathe your weapon before resting.');
    const threat = threatNear(p);
    if (threat) throw new Error(`You cannot rest with enemies nearby (${threat.name || 'a monster'}).`);
    const prevented = ctx.services.restPrevented?.(p);
    if (prevented) throw new Error(prevented);
    // Inn beds belong to the tavern service (package 2); loitering needs no bed (classic RestModes.Loiter).
    const sleep = mode === 'loiter' ? null : ctx.services.tavern?.sleep(p);
    if (sleep?.error) throw new Error(sleep.error);
    // Everywhere else: DaggerfallRestWindow.CanRest (server/rpg/calendar.js).
    const permit = sleep ? { ok: true, encounters: false }
      : ctx.services.restPermission?.(p, locationOf(p), mode) ?? { ok: true, encounters: false };
    if (!permit.ok) {
      if (!permit.crime) throw new Error(permit.error);
      // Classic refuses the rest AND records the crime (Crimes.Vagrancy, SpawnCityGuards), so this commits.
      ctx.services.reportVagrancy?.(p);
      ctx.notify(p, { kind: 'rest', state: 'refused', reason: permit.crime, textId: permit.textId ?? null, text: permit.error });
      return;
    }
    if (mode === 'healed' && vitalsFull(p)) throw new Error('You are already fully rested.');
    ledger(p);
    const maxHours = sleep?.releaseAt == null ? cfg.maxRestHours
      : Math.min(cfg.maxRestHours, Math.ceil((sleep.releaseAt - worldMinutes()) / 60));
    if (mode !== 'healed') hours = Math.min(hours, maxHours);
    ctx.onRollback?.(() => resting.delete(p.id));
    resting.set(p.id, {
      mode,
      hoursPlanned: hours,
      hoursDone: 0,
      acc: 0,
      x: p.x,
      z: p.z,
      location: locationOf(p),
      health: Number(c.health) || 0,
      maxHours,
      bed: sleep?.bed,
      startMinute: worldMinutes(),
      encounters: !!permit.encounters,
    });
    ctx.notify(p, {
      kind: 'rest',
      state: 'started',
      mode,
      hoursPlanned: mode === 'healed' ? null : hours,
      text: sleep ? `You settle into bed ${sleep.bed}.`
        : mode === 'loiter' ? `You wait for ${hours} hour${hours === 1 ? '' : 's'}.`
        : mode === 'healed' ? 'You settle down to rest until healed.' : `You settle down to rest for ${hours} hour${hours === 1 ? '' : 's'}.`,
    });
    ctx.emit('restStart', { player: p, mode, hours });
  });

  ctx.onAction('rest.stop', (p) => {
    if (!resting.has(p.id)) throw new Error('You are not resting.');
    finishRest(p, 'stopped', 'You get up.');
  });

  ctx.onAction('time.sync', (p) => {
    sendClock(p);
  });

  // ---------------------------------------------------------------- events

  // Anything violent involving a resting player wakes them.
  const wake = (id, reason, text) => {
    const p = typeof id === 'object' ? id : ctx.players.get(id);
    if (p && resting.has(p.id)) finishRest(p, reason, text);
  };
  ctx.on('swing', (ev) => wake(ev?.player ?? ev?.playerId, 'combat', 'You stop resting to fight.'));
  ctx.on('damage', (ev) => wake(ev?.target ?? ev?.player ?? ev?.playerId, 'attacked', 'You are woken by an attack!'));
  ctx.on('travel', (ev) => wake(ev?.player ?? ev?.playerId, 'travel', 'You break camp to travel.'));
  ctx.on('talk', (ev) => wake(ev?.player, 'talk', 'You stop resting to talk.'));

  ctx.onJoin((p) => {
    ledger(p);
    sendClock(p);
  });

  ctx.onLeave((p) => {
    resting.delete(p.id);
    seen.delete(p.id);
  });

  ctx.onTick((dt) => {
    const minutes = worldMinutes();
    const hour = Math.floor(minutes / 60);
    for (const p of ctx.players.values()) {
      // Rest progress and interruption.
      const r = resting.get(p.id);
      if (r) {
        const c = p.rpg?.character;
        const health = Number(c?.health) || 0;
        let threat, prevented;
        if (!c) finishRest(p, 'invalid', 'You cannot rest right now.');
        else if (locationOf(p) !== r.location) finishRest(p, 'moved', 'You leave your resting place.');
        else if (p.moving || Math.hypot(p.x - r.x, p.z - r.z) > cfg.moveTolerance) finishRest(p, 'moved', 'You get up and move on.');
        else if (r.bed != null && !ctx.services.tavern.hasRental(p, minutes)) finishRest(p, 'rentExpired', 'Your booking has ended.');
        else if (health < r.health) finishRest(p, 'attacked', 'You are woken by an attack!');
        else if ((threat = threatNear(p))) finishRest(p, 'enemy', `You are disturbed by ${threat.name || 'an enemy'}!`);
        else if ((prevented = ctx.services.restPrevented?.(p))) finishRest(p, 'prevented', prevented);
        else {
          r.acc += dt;
          while (r.acc >= cfg.restSecondsPerHour && resting.has(p.id)) {
            r.acc -= cfg.restSecondsPerHour;
            // Encounter rolls for each personal minute of this hour (package 8 owns timing and tables).
            const foe = r.encounters ? rollEncounter(p, r) : null;
            if (foe) {
              finishRest(p, 'encounter', `You are disturbed by ${foe.name ? `a ${foe.name}` : 'an enemy'}!`);
              break;
            }
            const healthBefore = c.health;
            if (r.mode !== 'loiter') applyHour(p);
            r.hoursDone += 1;
            r.health = Number(c.health) || 0;
            if (r.mode !== 'loiter') {
              ledger(p).restedHours += 1;
              ctx.emit('restHour', { player: p, healed: c.health - healthBefore });
            }
            ctx.services.spendTime(p, 60, r.mode === 'loiter' ? 'loiter' : 'rest');
            ctx.dirty(p);
            if (!resting.has(p.id)) break; // a timeSpent or restHour listener ended it
            if (r.bed != null && !ctx.services.tavern.hasRental(p, minutes)) finishRest(p, 'rentExpired', 'Your booking has ended.');
            else if (r.mode === 'healed' && vitalsFull(p)) finishRest(p, 'healed', `You feel fully rested after ${r.hoursDone} hour${r.hoursDone === 1 ? '' : 's'}.`);
            else if (r.mode !== 'healed' && r.hoursDone >= r.hoursPlanned) finishRest(p, 'done');
            else if (r.hoursDone >= r.maxHours) finishRest(p, 'done');
            else ctx.notify(p, { kind: 'rest', state: 'progress', hoursDone: r.hoursDone, hoursPlanned: r.mode === 'healed' ? null : r.hoursPlanned, vitals: vitals(p) });
          }
        }
      }

      // Clock/weather refresh on location change, weather change, or each game hour.
      const s = seen.get(p.id);
      const loc = locationOf(p);
      if (!s) { sendClock(p); continue; }
      if (s.location !== loc || s.hour !== hour) { sendClock(p); continue; }
      const region = regionFor(loc, p);
      const climate = climateFor(loc);
      if (s.region !== region || s.climate !== climate || s.weather !== weatherAt(region, minutes, loc, climate).type) sendClock(p);
    }
  });

  return { worldMinutes, weatherFor, clockEvent, label: WEATHER_LABEL };
}
