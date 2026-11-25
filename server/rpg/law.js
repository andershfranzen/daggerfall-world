// Crime, the City Watch and the courts (package 14, docs/law.md).
//
// Owns `rpg.law` on every character:
//   rep        {region: legalRep}   regional legal reputation, -100..100 (classic RegionData.LegalRep)
//   charge     the one open charge: {id, crime, region, location, at, witnessed, stage, sentence?, repLowered?}
//              stage: 'wanted' (guards dispatched) → 'halted' (a watchman demands surrender) → 'court' (awaiting the
//              plea) → 'defence' (not guilty: debate or lie) → closed into `history`.
//   history    closed cases, newest last (capped): {id, crime, region, verdict, fine, days, at}
//   prison     {chargeId, region, days, left} while serving a term (the term is time spent from the character's
//              own ledger; the shared world clock never moves)
//   banished   {region: true} after a severe sentence (guards appear at random there, classic flag 1)
//   picks      {portalId: skill} the Lockpicking value of the last failed attempt on an exterior door
//   tally      {thefts, violent}    classic TallyCrimeGuildRequirements counts
//
// Shared world state: `lawdoor:<from>#<portalId>` rows: exterior doors opened by a pick or an Open spell (one record
// per door, classic: lockpick, bash and Open change the same door), valid until the building next opens or 24 h.
//
// Actions
//   law.steal      {}                   Steal mode with nothing targeted: pick the nearest building lock outside, or
//                                       look at the shop shelves inside a shop
//   law.pickpocket {targetId}           Steal mode on a townsperson
//   law.shoplift   {key, quantity?}     take from the shelves of the shop you are in
//   law.surrender  {chargeId}           answer a watchman's halt
//   law.resist     {chargeId}
//   law.plead      {chargeId, plea}     'guilty' | 'notGuilty'
//   law.defend     {chargeId, method}   'debate' (Etiquette) | 'lie' (Streetwise)
//   law.status     {}                   resend the case view
// Services (ctx.services)
//   law: {regionOf, legalRep, changeLegalRep, wanted, crimeTally, commit, openDoor, doorOpen,
//         strikeTownsperson, provoked, jailed, shopliftBasket (package 12's unpaid basket, DoSteal)}
//   buildingEntryOverride(p, portal)    chained: true only for a door this feature recorded open
//   reportCrime(p, crime, {location})   other features' crimes (vagrancy from resting)
// Events: ctx.emit crimeCommitted {player, crime, region, witnessed}, crimeTally {player, thieving, amount},
//   crimeSentenced {player, crime, region, verdict, fine, days}, legalRepChanged {player, region, delta, value, reason}
// Game events (private): law.case {case, rep}, law.halt {chargeId, guardId, crime}, law.shelf {...}, law.court {...}

import { readFileSync } from 'node:fs';
import { parseLocation, exteriorOf } from '../../client/world/interiors/index.js';
import { REGION_NAMES } from '../../client/world/maps.js';
import { regionOf as climateRegionOf } from '../../client/gameplay/atmosphere/calendar.js';
import { parseFactionText } from '../../client/gameplay/npcs/factionFile.js';
import { BUILDING, buildingHours, isBuildingOpen, isShop, regionFactions } from './npcs/people.js';
import {
  CONSPIRACY_REP, CRIME_LABELS, THIEVING, VIOLENT, buildingLockValue, clampLegalRep, exteriorLockpickChance,
  goesToCourt, guildRescues, guiltyPlea, isCrime, pickpocketChance, pickpocketLoot, repLossFor, sentenceFor,
  sentenceRepair, shopliftCaughtChance, trial,
} from './law/rules.js';

export const name = 'law';

export const CITY_WATCH = 146;
const REGION_FACTION = 201; // fallback Daggerfall court faction when FACTION.TXT / guilds are unavailable
const PEOPLE_REGION = 'Daggerfall';
const HISTORY_CAP = 50;
const PICKPOCKET_CAP = 200;
const ID_RE = /^[\w:,.#-]{1,120}$/;

export const DEFAULTS = Object.freeze({
  /** PlayerActivate.PickpocketDistance: 128 classic units. */
  pickpocketReach: 3.2,
  /** Reach for an exterior door lock (the registry's door reach). */
  doorReach: 3,
  /** A watchman this close halts the suspect. */
  haltRange: 3.5,
  /** A halt left unanswered this long counts as resisting. */
  haltMs: 30_000,
  /** Guards giving up when they cannot reach the suspect. */
  pursuitMs: 180_000,
  /** Classic prison screen: one day per 0.3 s. */
  prisonMsPerDay: 300,
  /** Classic SpawnCityGuards: at most this many active watchmen per location. */
  maxGuards: 5,
  /** Outdoors: watchmen dispatched for a fresh crime. Indoors classic spawns 2..5 at the door. */
  outdoorGuards: 2,
  /** Guards step in from this far outdoors. */
  guardDistance: 14,
  /** Criminal conspiracy / banishment patrol checks, real ms between rolls (one classic game minute at 12x is 5 s). */
  patrolMs: 5_000,
  /** An opened exterior door stays open at most this long (game minutes). */
  doorOpenMinutes: 24 * 60,
  /** Recent pickpocket attempts per character survive NPC population rebuilds for this long (real ms). */
  pickpocketMemoryMs: 24 * 60 * 60_000,
});

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.trunc(Number(v) || 0)));
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export function install(ctx, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const S = (ctx.services ||= {});
  const log = ctx.log ?? console;

  const guards = new Map(); // entity id -> {suspectId, chargeId, region, spawnedAt, halted, haltAt}
  const doors = new Map(); // `${from}#${id}` -> {openedBy, how, at, until}
  const lastPatrol = new Map(); // player id -> ms
  const lastDispatch = new Map();
  const chargeSeq = { n: 0 };

  let parsedFactions = options.factions ?? null;
  if (!parsedFactions && typeof ctx.dataFile === 'function') {
    try { parsedFactions = parseFactionText(readFileSync(ctx.dataFile('FACTION.TXT'), 'latin1')); } catch { parsedFactions = null; }
  }
  const courtCache = new Map(); // region name -> faction id | null

  // ------------------------------------------------------------------ state

  function state(p) {
    const rpg = (p.rpg ||= {});
    let l = rpg.law;
    if (!l || typeof l !== 'object' || Array.isArray(l)) l = rpg.law = {};
    if (!l.rep || typeof l.rep !== 'object' || Array.isArray(l.rep)) l.rep = {};
    for (const [k, v] of Object.entries(l.rep)) {
      if (!Number.isFinite(v) || typeof k !== 'string' || k.length > 60) delete l.rep[k];
      else l.rep[k] = clampLegalRep(v);
    }
    if (!Array.isArray(l.history)) l.history = [];
    if (!l.banished || typeof l.banished !== 'object' || Array.isArray(l.banished)) l.banished = {};
    if (!l.picks || typeof l.picks !== 'object' || Array.isArray(l.picks)) l.picks = {};
    if (!l.pickpockets || typeof l.pickpockets !== 'object' || Array.isArray(l.pickpockets)) l.pickpockets = {};
    for (const [k, v] of Object.entries(l.pickpockets)) {
      if (typeof k !== 'string' || k.length > 120 || !Number.isFinite(v)) delete l.pickpockets[k];
    }
    if (!l.tally || typeof l.tally !== 'object') l.tally = { thefts: 0, violent: 0 };
    if (l.charge && (typeof l.charge !== 'object' || !isCrime(l.charge.crime) || typeof l.charge.region !== 'string')) l.charge = null;
    if (l.charge === undefined) l.charge = null;
    if (l.prison && (typeof l.prison !== 'object' || !Number.isFinite(l.prison.left))) l.prison = null;
    if (l.prison === undefined) l.prison = null;
    return l;
  }

  /** Jurisdiction: the region named by the location id (town/interior/dungeon), or the climate region of a pixel. */
  function regionOf(location) {
    const loc = String(location ?? '');
    const known = S.travel?.regionOf?.(loc);
    if (known) return known;
    const parsed = parseLocation(loc);
    if (parsed) return parsed.region;
    const m = /^(?:town|dungeon|interior):([^/]+)\//.exec(loc);
    if (m) return m[1];
    return climateRegionOf(loc);
  }
  const kindOf = (location) => parseLocation(location)?.kind ?? (String(location).startsWith('wilderness:') ? 'wilderness' : 'other');
  /** Towns and their buildings have a City Watch; dungeons and the wilderness do not (classic). */
  const policed = (location) => {
    const k = kindOf(location);
    return k === 'town' || k === 'interior';
  };

  const legalRep = (p, region = regionOf(ctx.location(p))) => state(p).rep[region] ?? 0;

  function changeLegalRep(p, region, delta, reason = 'event') {
    if (typeof region !== 'string' || !region) throw new TypeError('changeLegalRep needs a region');
    const d = Math.trunc(Number(delta) || 0);
    ctx.dirty(p);
    const l = state(p);
    const before = l.rep[region] ?? 0;
    const value = clampLegalRep(before + d);
    if (value === 0) delete l.rep[region];
    else l.rep[region] = value;
    if (value !== before) ctx.emit('legalRepChanged', { player: p, region, delta: value - before, value, reason });
    return value;
  }

  function regionIndexFromName(region) {
    if (typeof region !== 'string' || !region) return -1;
    const want = region.toLowerCase();
    return REGION_NAMES.findIndex((n) => n.toLowerCase() === want);
  }

  /** Resolves the regional noble court (or people) faction id for any Iliac Bay region. */
  function courtFactionFor(region) {
    if (typeof region !== 'string' || !region) return null;
    const idx = regionIndexFromName(region);
    if (options.regionCourtFactions) {
      const explicit = options.regionCourtFactions[region] ?? (idx >= 0 ? options.regionCourtFactions[idx] : null);
      if (Number.isInteger(explicit)) return explicit;
    }
    if (idx >= 0) {
      const fromGuilds = S.regionCourt?.(idx) ?? S.regionFaction?.(idx);
      if (Number.isInteger(fromGuilds)) return fromGuilds;
    }
    if (courtCache.has(region)) return courtCache.get(region);
    let resolved = null;
    if (idx >= 0 && parsedFactions) {
      const rf = regionFactions(parsedFactions, idx);
      resolved = rf.court ?? rf.people ?? null;
    }
    if (resolved == null && region === PEOPLE_REGION) resolved = REGION_FACTION;
    courtCache.set(region, resolved);
    return resolved;
  }

  /** Classic also moves the region's court/people faction across every Iliac Bay region. */
  function peopleRep(p, region, delta) {
    if (!delta || typeof S.adjustReputation !== 'function') return;
    const fid = courtFactionFor(region);
    if (fid == null) return;
    S.adjustReputation(p, fid, delta);
  }

  function prunePickpockets(l, now) {
    const ttl = cfg.pickpocketMemoryMs;
    const entries = Object.entries(l.pickpockets);
    let changed = false;
    for (const [k, ts] of entries) {
      if (!Number.isFinite(ts) || (ttl > 0 && now - ts >= ttl)) {
        delete l.pickpockets[k];
        changed = true;
      }
    }
    const remaining = Object.entries(l.pickpockets);
    if (remaining.length > PICKPOCKET_CAP) {
      remaining.sort((a, b) => a[1] - b[1]);
      for (const [k] of remaining.slice(0, remaining.length - PICKPOCKET_CAP)) {
        delete l.pickpockets[k];
        changed = true;
      }
    }
    return changed;
  }

  const wanted = (p, region) => {
    const c = state(p).charge;
    return c && (region == null || c.region === region) ? c : null;
  };

  const jailed = (p) => !!state(p).prison;
  const skillOf = (p, name) => Math.trunc(S.skillValue?.(p, name) ?? p.rpg.character?.skills?.[name] ?? 0);
  const custody = (p) => {
    const l = p.rpg?.law;
    if (l?.prison) return 'You are in prison.';
    if (l?.charge?.stage === 'court' || l?.charge?.stage === 'defence') return 'The court has not finished with you.';
    return null;
  };

  function caseView(p) {
    const l = state(p);
    const c = l.charge;
    return {
      kind: 'law.case',
      silent: true,
      case: c ? {
        id: c.id, crime: c.crime, label: CRIME_LABELS[c.crime], region: c.region, stage: c.stage, witnessed: c.witnessed,
        sentence: c.stage === 'court' || c.stage === 'defence' ? { fine: c.sentence?.fine ?? 0, days: c.sentence?.days ?? 0, severe: !!c.sentence?.severe } : null,
      } : null,
      prison: l.prison ? { days: l.prison.days, left: l.prison.left, region: l.prison.region } : null,
      rep: { ...l.rep },
      banished: Object.keys(l.banished),
      last: l.history.at(-1) ?? null,
    };
  }
  const sendCase = (p) => ctx.notify(p, caseView(p));
  const say = (p, text, extra = {}) => ctx.notify(p, { kind: 'law', silent: true, text, ...extra });

  // ------------------------------------------------------------------ crimes

  /**
   * A crime by `p`. Unwitnessed crimes change nothing but the guild tally. A witnessed crime in a policed place opens
   * (or upgrades) the character's single charge in that region and dispatches the watch. Returns the charge or null.
   */
  function commit(p, crime, { location = ctx.location(p), witnessed = true, at = null } = {}) {
    if (!isCrime(crime)) throw new TypeError(`unknown crime ${crime}`);
    const region = regionOf(location);
    ctx.emit('crimeCommitted', { player: p, crime, region, witnessed: !!witnessed });
    if (!witnessed || !policed(location) || custody(p)) return null;
    ctx.dirty(p);
    const l = state(p);
    let c = l.charge;
    if (c && c.region !== region) {
      // One charge per character (classic CrimeCommitted). A crime in another jurisdiction replaces an old one there.
      c = null;
    }
    if (!c) {
      c = l.charge = {
        id: `${p.id}.${Date.now().toString(36)}.${(++chargeSeq.n).toString(36)}`,
        crime, region, location, at: S.worldClock?.()?.minutes ?? null, witnessed: true, stage: 'wanted',
      };
    } else if (repLossFor(crime) > repLossFor(c.crime)) {
      // A graver crime while already wanted: the charge becomes the graver one (still one charge).
      const previousLoss = repLossFor(c.crime);
      c.crime = crime;
      c.location = location;
      if (c.repLowered) {
        const loss = repLossFor(crime);
        changeLegalRep(p, c.region, previousLoss - loss, 'crime');
        peopleRep(p, c.region, Math.trunc(previousLoss / 2) - Math.trunc(loss / 2));
      }
    }
    ctx.afterCommit(() => sendCase(p));
    if (policed(location) && !l.prison) dispatch(p, c, at);
    return c;
  }

  /** Classic LowerRepForCrime, once per charge (when the watch first confronts the suspect). */
  function lowerRep(p, c) {
    if (c.repLowered) return;
    c.repLowered = true;
    const loss = repLossFor(c.crime);
    changeLegalRep(p, c.region, -loss, 'crime');
    peopleRep(p, c.region, -Math.trunc(loss / 2));
  }

  function tally(p, thieving, amount) {
    ctx.dirty(p);
    const t = state(p).tally;
    if (thieving) t.thefts = clampInt((t.thefts ?? 0) + amount, 0, 1e6);
    else t.violent = clampInt((t.violent ?? 0) + amount, 0, 1e6);
    ctx.emit('crimeTally', { player: p, thieving: !!thieving, amount });
  }

  // ------------------------------------------------------------------ the watch

  const lawGuards = (location) => [...guards.entries()].map(([id, g]) => ({ e: ctx.entities.get(id), g }))
    .filter(({ e }) => e && !e.dead && e.location === location);

  /** Classic SpawnCityGuards(true) for `p` in their location. */
  function dispatch(p, c, at = null) {
    const location = ctx.location(p);
    if (!policed(location) || regionOf(location) !== c.region || typeof S.createEnemy !== 'function') return;
    const present = lawGuards(location);
    if (present.some(({ g }) => g.suspectId === p.id && g.chargeId === c.id) || present.length >= cfg.maxGuards) return;
    const prior = lastDispatch.get(p.id);
    if (prior?.chargeId === c.id && prior.location === location && ctx.now() - prior.at < cfg.patrolMs) return;
    lastDispatch.set(p.id, { chargeId: c.id, location, at: ctx.now() });
    ctx.onRollback?.(() => {
      if (prior) lastDispatch.set(p.id, prior);
      else lastDispatch.delete(p.id);
    });
    if (c.stage === 'halted') {
      ctx.dirty(p);
      c.stage = 'wanted';
    }
    const inside = kindOf(location) === 'interior';
    const want = Math.min(cfg.maxGuards - present.length, inside ? 2 + Math.floor(random() * 4) : cfg.outdoorGuards);
    const spots = [];
    if (inside) {
      const door = S.portals?.into?.(location)?.exits?.[0];
      if (door) for (let i = 0; i < want; i++) spots.push({ x: door.x + (i - want / 2) * 0.6, z: door.z, y: door.y });
    }
    while (spots.length < want) {
      const a = random() * 2 * Math.PI;
      const r = inside ? 3 : cfg.guardDistance;
      spots.push({ x: p.x + Math.sin(a) * r, z: p.z - Math.cos(a) * r });
    }
    if (at) spots[0] = at;
    const level = Math.max(1, Math.trunc(p.rpg?.character?.level) || 1);
    let made = 0;
    for (const s of spots.slice(0, want)) {
      let e = null;
      try {
        e = S.createEnemy(location, CITY_WATCH, s.x, s.z, { origin: 'law', level, y: s.y });
      } catch (err) {
        log.warn?.(`[law] could not place a watchman: ${err?.message ?? err}`);
      }
      if (!e) continue;
      e.hostile = false; // walk up and demand surrender first
      Object.assign(e._home ??= {}, { x: p.x, z: p.z });
      e.lawSuspect = p.id; // public: clients may show who the watch is after
      guards.set(e.id, { suspectId: p.id, chargeId: c.id, region: c.region, spawnedAt: ctx.now(), halted: false, haltAt: 0 });
      ctx.onRollback?.(() => guards.delete(e.id));
      made++;
    }
    if (made) ctx.nearby(location, { kind: 'law.watch', suspectId: p.id, count: made });
    else log.warn?.('[law] no watchman could be placed');
  }

  function dismiss(id, why = 'gone') {
    const e = ctx.entities.get(id);
    const g = guards.get(id);
    guards.delete(id);
    if (g) ctx.onRollback?.(() => guards.set(id, g));
    if (!e || e.dead) return;
    ctx.touchEntity?.(e);
    ctx.entities.delete(id);
    ctx.nearby(e.location, { kind: 'law.watchLeaves', entityId: id, reason: why });
  }

  function provoke(e, p) {
    if (typeof S.provokeEnemy === 'function') S.provokeEnemy(e, p);
    else {
      e.hostile = true;
      e._targetId = p.id;
    }
  }

  function halt(p, c, e, g) {
    g.halted = true;
    g.haltAt = ctx.now();
    if (c.stage === 'wanted') c.stage = 'halted';
    lowerRep(p, c);
    ctx.dirty(p);
    ctx.notify(p, { kind: 'law.halt', silent: true, chargeId: c.id, guardId: e.id, crime: c.crime, label: CRIME_LABELS[c.crime],
      text: `Halt! You are under arrest for ${CRIME_LABELS[c.crime]}. Do you surrender?` });
    sendCase(p);
  }

  /** Take the suspect before the court: indoors they are brought outside first (classic CourtWindow). */
  function arrest(p, c, voluntary) {
    ctx.dirty(p);
    lowerRep(p, c);
    if (p.rpg.defeated) {
      S.reviveFromArrest?.(p);
      delete p.rpg.defeated;
    }
    for (const [id, g] of guards) if (g.suspectId === p.id) dismiss(id, 'arrest');
    const loc = ctx.location(p);
    if (kindOf(loc) === 'interior' && p.rpg.portal?.returnTo && typeof S.portals?.transfer === 'function') {
      const r = p.rpg.portal.returnTo;
      // Building return points can lack height. Match the entrance used so an arrest keeps its exterior floor.
      const entrance = S.portals.into?.(loc)?.entrances?.find(({ exit }) => exit.x === r.x && exit.z === r.z);
      S.portals.transfer(p, { ...r, yaw: r.yaw ?? 0, y: r.y ?? entrance?.exit.y }, { label: 'the court' });
    }
    // Thieves Guild / Dark Brotherhood may get a member released (rolled once, saved with the case).
    const guild = THIEVING.has(c.crime) ? 'thieves' : VIOLENT.has(c.crime) ? 'darkBrotherhood' : null;
    const rank = guild && typeof S.guildRank === 'function' ? S.guildRank(p, guild) : null;
    if (guild && rank != null && guildRescues(rank, random)) {
      close(p, c, { verdict: `released by the ${guild === 'thieves' ? 'Thieves Guild' : 'Dark Brotherhood'}`, fine: 0, days: 0, repaired: true });
      return;
    }
    c.sentence = sentenceFor(c.crime, legalRep(p, c.region), Math.max(0, Math.trunc(p.rpg.gold) || 0), random);
    c.stage = 'court';
    c.voluntary = !!voluntary;
    ctx.notify(p, { kind: 'law.court', silent: true, chargeId: c.id, crime: c.crime, label: CRIME_LABELS[c.crime], region: c.region,
      text: `You stand before the court of ${c.region}, charged with ${CRIME_LABELS[c.crime]}. How do you plead?`,
      choices: ['guilty', 'notGuilty'] });
    sendCase(p);
  }

  /** Close the case: one verdict, saved once. */
  function close(p, c, { verdict, fine = 0, days = 0, repaired = false, banished = false }) {
    ctx.dirty(p);
    const l = state(p);
    if (l.charge?.id !== c.id) throw new Error('That case is already closed.');
    if (fine > 0) {
      const pay = Math.min(fine, Math.max(0, Math.trunc(p.rpg.gold) || 0));
      days += Math.trunc((fine - pay) / 40);
      if (typeof S.takeGold === 'function') { if (pay > 0) S.takeGold(p, pay); }
      else p.rpg.gold -= pay;
      fine = pay;
    }
    if (repaired) {
      const back = sentenceRepair(c.crime);
      changeLegalRep(p, c.region, back, 'sentence');
      peopleRep(p, c.region, Math.trunc(back / 2));
    }
    if (banished) l.banished[c.region] = true;
    const record = { id: c.id, crime: c.crime, region: c.region, verdict, fine, days, at: S.worldClock?.()?.minutes ?? null };
    l.history.push(record);
    if (l.history.length > HISTORY_CAP) l.history.splice(0, l.history.length - HISTORY_CAP);
    l.charge = null;
    if (days > 0) l.prison = { chargeId: c.id, region: c.region, days, left: days, location: ctx.location(p), x: p.x, z: p.z };
    for (const [id, g] of guards) if (g.suspectId === p.id) dismiss(id, 'closed');
    ctx.emit('crimeSentenced', { player: p, crime: c.crime, region: c.region, verdict, fine, days });
    const parts = [verdict === 'free' ? 'You are free to go.' : `Verdict: ${verdict}.`];
    if (fine > 0) parts.push(`You pay a fine of ${fine} gold.`);
    if (days > 0) parts.push(`You are sentenced to ${days} day${days === 1 ? '' : 's'} in prison.`);
    if (banished) parts.push(`You are banished from ${c.region}.`);
    ctx.notify(p, { kind: 'law.verdict', silent: true, chargeId: c.id, verdict, fine, days, banished, region: c.region, text: parts.join(' ') });
    sendCase(p);
    if (!days) release(p, { reposition: verdict !== 'free' && (verdict === 'guilty' || banished), silent: true });
    return record;
  }

  /** Classic ReleaseFromPrison: four hours pass for this character and they are put at the town's entrance. */
  function release(p, { reposition = true, silent = false } = {}) {
    ctx.dirty(p);
    const l = state(p);
    const served = l.prison?.days ?? 0;
    l.prison = null;
    S.spendTime?.(p, served * 1440 + 240, 'prison');
    S.revivePlayer?.(p);
    if (reposition) {
      const loc = ctx.location(p);
      const town = kindOf(loc) === 'interior' ? exteriorOf(loc) : loc;
      if (town && typeof S.portals?.transfer === 'function') {
        S.portals.transfer(p, { location: town, x: 0, z: 0, yaw: 0 }, { label: 'the town gate' });
      } else {
        p.x = 0;
        p.z = 0;
      }
    }
    if (!silent) say(p, served ? `After ${served} day${served === 1 ? '' : 's'} you are released.` : 'You are released.');
    sendCase(p);
  }

  // ------------------------------------------------------------------ doors (exterior locks)

  const doorKey = (portal) => `${portal.from}#${portal.id}`;
  const minutesNow = () => S.worldClock?.()?.minutes ?? null;

  function doorRecord(portal) {
    const k = doorKey(portal);
    const d = doors.get(k);
    if (!d) return null;
    const now = minutesNow();
    if (now != null && d.until != null && now >= d.until) {
      doors.delete(k);
      ctx.onRollback?.(() => doors.set(k, d));
      ctx.dirtyWorld?.(`lawdoor:${k}`, null);
      return null;
    }
    return d;
  }
  const doorOpen = (portal) => !!(portal && doorRecord(portal));

  /** Until the building's next opening hour (or `doorOpenMinutes`). */
  function openUntil(portal) {
    const now = minutesNow();
    if (now == null) return null;
    let until = now + cfg.doorOpenMinutes;
    const hours = buildingHours(portal.meta?.buildingType);
    if (hours && hours.close > hours.open) {
      const day = Math.floor(now / 1440) * 1440;
      let next = day + hours.open * 60;
      if (next <= now) next += 1440;
      until = Math.min(until, next);
    }
    return until;
  }

  function openDoor(p, portal, how = 'pick') {
    if (!portal || portal.kind !== 'building') throw new Error('That is not a building door.');
    const k = doorKey(portal);
    const prev = doors.get(k);
    const rec = { openedBy: p?.id ?? null, how, at: minutesNow(), until: openUntil(portal) };
    doors.set(k, rec);
    ctx.onRollback?.(() => { if (prev) doors.set(k, prev); else doors.delete(k); });
    ctx.dirtyWorld?.(`lawdoor:${k}`, rec);
    return rec;
  }

  for (const [key, v] of ctx.loadWorld?.('lawdoor:') ?? []) {
    if (v && typeof v === 'object') doors.set(key.slice('lawdoor:'.length), { ...v });
  }

  // Package 2 (townServices/access.js) asks this before refusing a locked door.
  const previousOverride = S.buildingEntryOverride;
  S.buildingEntryOverride = (p, portal) => !!previousOverride?.(p, portal) || doorOpen(portal);

  /** Would this character be let in through the front door right now (open hours, property, guild, quest)? */
  function lawfulEntry(p, portal) {
    const access = S.buildingAccess;
    if (typeof access?.lockedReason === 'function') {
      try {
        return access.lockedReason(p, portal) == null;
      } catch {
        return false;
      }
    }
    const type = portal.meta?.buildingType;
    if (!Number.isInteger(type)) return true;
    if (S.ownsBuilding?.(p, portal)) return true;
    const canOpen = type <= BUILDING.Palace || (type >= BUILDING.House1 && type <= BUILDING.House4);
    const hour = Number.isFinite(minutesNow()) ? Math.floor(minutesNow() / 60) % 24 : 12;
    const privateHall = type === BUILDING.House2 && portal.meta?.factionId > 0;
    return canOpen && !privateHall && isBuildingOpen(type, hour);
  }

  function nearestDoor(p) {
    const loc = ctx.location(p);
    let best = null, bd = cfg.doorReach;
    for (const portal of S.portals?.at?.(loc) ?? []) {
      if (portal.kind !== 'building') continue;
      for (const en of portal.entrances) {
        const d = dist(en, p);
        if (d <= bd) {
          bd = d;
          best = portal;
        }
      }
    }
    return best;
  }

  function pickLock(p, portal) {
    const l = state(p);
    if (lawfulEntry(p, portal) || doorOpen(portal)) {
      say(p, `The door of ${portal.label} is not locked.`);
      return;
    }
    const skill = skillOf(p, 'Lockpicking');
    const lock = buildingLockValue(portal.meta?.quality);
    const k = doorKey(portal);
    if (Number.isFinite(l.picks[k]) && skill <= l.picks[k]) {
      say(p, `This lock is beyond you for now (lock strength ${lock}).`);
      return;
    }
    ctx.dirty(p);
    S.advanceSkill?.(p, 'Lockpicking', 1);
    const chance = exteriorLockpickChance(lock, skill);
    const roll = 1 + Math.floor(random() * 100);
    if (chance > roll) {
      delete l.picks[k];
      openDoor(p, portal, 'pick');
      tally(p, true, 1);
      say(p, `You pick the lock of ${portal.label}.`, { lockpick: 'success', portalId: portal.id, chance });
    } else {
      l.picks[k] = skill;
      say(p, 'You fail to pick the lock.', { lockpick: 'failure', portalId: portal.id, chance });
    }
  }

  function bashDoor(p, id) {
    requireSuspectFree(p);
    const loc = ctx.location(p);
    const portal = S.portals?.get?.(loc, id);
    if (portal?.kind !== 'building') throw new Error('There is no building door there.');
    const entrance = portal.entrances.find((at) => {
      const dx = at.x - p.x, dz = at.z - p.z;
      const distance = Math.hypot(dx, dz);
      return distance <= cfg.doorReach &&
        (distance < 0.4 || dx * Math.sin(p.yaw) - dz * Math.cos(p.yaw) >= distance * 0.5);
    });
    if (!entrance) throw new Error('Face the door and stand closer.');
    const locked = !lawfulEntry(p, portal) && !doorOpen(portal);
    const opened = !locked || 1 + Math.floor(random() * 100) <= 25 - buildingLockValue(portal.meta?.quality);
    if (opened && locked) openDoor(p, portal, 'bash');
    say(p, opened ? `The door of ${portal.label} gives way.` : 'The door holds.');
    const witnessed = random() < 0.10;
    commit(p, opened ? 'breakingAndEntering' : 'attemptedBreakingAndEntering', { witnessed, at: entrance });
  }

  // Committed entry: interiors emits locationChanged inside the portal.use transaction.
  ctx.on('locationChanged', ({ player: p, from, to, portal } = {}) => {
    if (!p || !portal || portal.kind !== 'building' || portal.to !== to || portal.from !== from) return;
    if (!doorOpen(portal) || lawfulEntry(p, portal)) return;
    ctx.dirty(p);
    // Witnesses are whoever lives or works there at this hour; they may still be loading, so the check finishes in
    // the tick once the people of `to` are ready.
    state(p).intrusion = { location: to, portalId: portal.id, since: ctx.now() };
    ctx.afterCommit(() => {
      const job = S.npcs?.peopleAt?.(to);
      if (job?.then) job.then(() => loadedAt.set(to, ctx.now()), () => loadedAt.set(to, ctx.now()));
      else loadedAt.set(to, ctx.now());
    });
  });

  function occupants(location, p) {
    return (S.npcsAt?.(location) ?? []).filter((e) => e.kind === 'npc' && e.location === location
      && (e.visibleTo == null || (e.visibleTo instanceof Set ? e.visibleTo.has(p.id) : e.visibleTo.includes?.(p.id))));
  }
  // People are published into ctx.entities by the npcs tick after their source resolves: allow one more second.
  const loadedAt = new Map(); // location -> ms its people resolved
  const peopleReady = (location, intrusion) => {
    const t = loadedAt.get(location);
    if (t != null) return ctx.now() - t >= 1000;
    if (!S.npcs?.peopleAt) return true;
    // A reconnect inside the building: ask again.
    if (!intrusion.asked) {
      intrusion.asked = true;
      S.npcs.peopleAt(location).then(() => loadedAt.set(location, ctx.now()), () => loadedAt.set(location, ctx.now()));
    }
    return false;
  };

  // ------------------------------------------------------------------ townsfolk

  function requireSuspectFree(p) {
    const reason = custody(p);
    if (reason) throw new Error(reason);
  }

  function npcTarget(p, targetId, reach) {
    if (typeof targetId !== 'string' || !ID_RE.test(targetId)) throw new Error('Steal from whom?');
    const e = ctx.entities.get(targetId);
    if (!e || e.kind !== 'npc' || e.location !== ctx.location(p)) throw new Error('There is nobody like that here.');
    if (e.visibleTo != null && !(e.visibleTo instanceof Set ? e.visibleTo.has(p.id) : e.visibleTo.includes?.(p.id))) throw new Error('There is nobody like that here.');
    if (!(dist(e, p) <= reach)) throw new Error(`You are too far away from ${e.name}.`);
    return e;
  }

  function strikeTownsperson(p, e, { weapon = 'unarmed' } = {}) {
    requireSuspectFree(p);
    if (!e || e.kind !== 'npc' || !e.mobile) return { killed: false, crime: null, refused: 'You cannot attack townsfolk.' };
    ctx.touchEntity?.(e);
    const at = { x: e.x, z: e.z };
    if (e.role === 'guard') {
      // WeaponManager: striking a watchman in the street turns him into a hostile City Watch knight (assault).
      ctx.entities.delete(e.id);
      const c = commit(p, 'assault', { at });
      if (c) for (const { e: g, g: rec } of lawGuards(ctx.location(p))) {
        if (rec.suspectId === p.id) { rec.halted = true; provoke(g, p); }
      }
      return { killed: false, crime: 'assault', weapon };
    }
    // A townsperson dies to one blow (MobilePersonNPC); murder, always seen.
    ctx.entities.delete(e.id);
    ctx.nearby(e.location, { kind: 'law.slain', entityId: e.id, name: e.name, playerId: p.id });
    tally(p, false, 5);
    commit(p, 'murder', { at });
    ctx.emit('civilianKilled', { player: p, entity: e });
    return { killed: true, crime: 'murder', weapon };
  }

  /** A player's blow landed on a passive enemy (package 8 calls this before the hostile flip). */
  function provoked(p, e) {
    if (!p || !e) return null;
    const g = guards.get(e.id);
    const isWatch = e.monsterId === CITY_WATCH || e._m?.guard === true;
    if (!isWatch) return null;
    const c = state(p).charge;
    if (g && g.suspectId === p.id && c) {
      const halted = g.halted;
      ctx.onRollback?.(() => { g.halted = halted; });
      g.halted = true;
      return c.crime; // resisting arrest: the charge stands
    }
    return commit(p, 'assault', { at: { x: e.x, z: e.z } })?.crime ?? null;
  }

  // ------------------------------------------------------------------ actions

  ctx.onAction('law.status', (p) => { state(p); sendCase(p); });

  ctx.onAction('law.steal', (p) => {
    requireSuspectFree(p);
    if (!p.rpg.character) throw new Error('Create a character first.');
    const loc = ctx.location(p);
    if (kindOf(loc) === 'interior') {
      const shelf = S.shopShelf?.(loc);
      if (!shelf) throw new Error('There is nothing here to steal.');
      ctx.notify(p, { kind: 'law.shelf', location: loc, shop: shelf.kind, items: shelf.items.filter((i) => i.quantity > 0) });
      return;
    }
    const portal = nearestDoor(p);
    if (!portal) throw new Error('There is no lock here to pick.');
    pickLock(p, portal);
  });

  ctx.onAction('law.pickpocket', (p, args) => {
    requireSuspectFree(p);
    const ch = p.rpg.character;
    if (!ch) throw new Error('Create a character first.');
    const e = npcTarget(p, args.targetId, cfg.pickpocketReach);
    if (e.role === 'guard') throw new Error(`${e.name} keeps a hand on his purse.`);
    const l = state(p);
    const now = ctx.now();
    prunePickpockets(l, now);
    const key = String(e.id);
    if (Object.hasOwn(l.pickpockets, key)) throw new Error(`${e.name} is watching you closely now.`);
    const prev = l.pickpockets[key];
    l.pickpockets[key] = now;
    prunePickpockets(l, now);
    ctx.onRollback?.(() => {
      if (prev === undefined) delete l.pickpockets[key];
      else l.pickpockets[key] = prev;
    });
    ctx.dirty(p);
    S.advanceSkill?.(p, 'Pickpocket', 1);
    const chance = pickpocketChance(skillOf(p, 'Pickpocket'));
    if (1 + Math.floor(random() * 100) <= chance) {
      const gold = pickpocketLoot(random);
      if (gold > 0) {
        if (typeof S.addGold === 'function') S.addGold(p, gold);
        else p.rpg.gold = (p.rpg.gold || 0) + gold;
        tally(p, true, 1);
        say(p, `You pinched ${gold} gold piece${gold === 1 ? '' : 's'}.`, { pickpocket: 'success', gold });
      } else say(p, 'You find nothing of value.', { pickpocket: 'success', gold: 0 });
      return;
    }
    say(p, 'You are not successful.', { pickpocket: 'caught' });
    commit(p, 'pickpocketing', { at: { x: e.x, z: e.z } });
  });

  ctx.onAction('law.shoplift', (p, args) => {
    requireSuspectFree(p);
    const ch = p.rpg.character;
    if (!ch) throw new Error('Create a character first.');
    const loc = ctx.location(p);
    const shelf = S.shopShelf?.(loc);
    if (!shelf) throw new Error('There is nothing here to steal.');
    const qty = args.quantity ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) throw new Error('Take between 1 and 10.');
    if (typeof args.key !== 'string' || !ID_RE.test(args.key)) throw new Error('Take what?');
    const item = shelf.items.find((i) => i.key === args.key);
    if (!item || item.quantity < qty) throw new Error('That is not on the shelves.');
    const portal = S.portals?.into?.(loc);
    const quality = shelf.quality ?? portal?.meta?.quality ?? 0;
    const weightAndCount = Math.trunc(item.weight * qty) + qty;
    const name = qty > 1 ? `${qty} × ${item.name}` : item.name;
    if (S.law.shopliftBasket(p, { location: loc, quality, weightAndCount, name }).caught) return;
    const taken = shelf.take(args.key, qty);
    if (typeof S.giveItem !== 'function') throw new Error('You cannot carry that.');
    S.giveItem(p, taken.template, qty, { variant: taken.variant, extra: { ...taken.extra, stolen: { from: loc, at: Date.now() } } });
  });

  function chargeFor(p, args, stages) {
    const c = state(p).charge;
    if (!c || typeof args.chargeId !== 'string' || c.id !== args.chargeId) throw new Error('There is no such case against you.');
    if (!stages.includes(c.stage)) throw new Error('That is not possible now.');
    return c;
  }

  ctx.onAction('law.surrender', (p, args) => {
    const c = chargeFor(p, args, ['halted', 'wanted']);
    const halted = lawGuards(ctx.location(p)).some(({ g }) => g.suspectId === p.id && g.chargeId === c.id && g.halted);
    if (!halted) throw new Error('There is nobody here to surrender to.');
    arrest(p, c, true);
  });

  ctx.onAction('law.resist', (p, args) => {
    const c = chargeFor(p, args, ['halted']);
    ctx.dirty(p);
    c.stage = 'wanted';
    for (const { e, g } of lawGuards(ctx.location(p))) if (g.suspectId === p.id) provoke(e, p);
    say(p, 'You resist arrest!');
    sendCase(p);
  });

  ctx.onAction('law.plead', (p, args) => {
    const c = chargeFor(p, args, ['court']);
    if (args.plea === 'guilty') {
      if (c.sentence.severe) {
        close(p, c, { verdict: 'banished', banished: true });
        return;
      }
      const { fine, days } = guiltyPlea(c.sentence);
      close(p, c, { verdict: 'guilty', fine, days, repaired: true });
      return;
    }
    if (args.plea !== 'notGuilty') throw new Error('Plead guilty or not guilty.');
    ctx.dirty(p);
    c.stage = 'defence';
    ctx.notify(p, { kind: 'law.court', silent: true, chargeId: c.id, crime: c.crime, label: CRIME_LABELS[c.crime], region: c.region,
      text: 'How will you convince the court?', choices: ['debate', 'lie'] });
    sendCase(p);
  });

  ctx.onAction('law.defend', (p, args) => {
    const c = chargeFor(p, args, ['defence']);
    const skillName = args.method === 'debate' ? 'Etiquette' : args.method === 'lie' ? 'Streetwise' : null;
    if (!skillName) throw new Error('Debate or lie.');
    const ch = p.rpg.character ?? {};
    S.advanceSkill?.(p, skillName, 1);
    const r = trial({
      legalRep: legalRep(p, c.region),
      skill: skillOf(p, skillName),
      personality: Math.trunc(S.attributeValue?.(p, 'Personality') ?? ch.attributes?.Personality ?? 0),
      sentence: c.sentence,
    }, random);
    if (r.free) {
      close(p, c, { verdict: 'free', repaired: true });
      return;
    }
    if (c.sentence.severe) {
      close(p, c, { verdict: 'banished', banished: true });
      return;
    }
    close(p, c, { verdict: 'guilty', fine: r.fine, days: r.days, repaired: true });
  });

  // ------------------------------------------------------------------ services

  S.law = {
    regionOf, courtFactionFor, legalRep, changeLegalRep, wanted, jailed, custody, commit, openDoor, bashDoor, doorOpen: (id, from) => {
      if (id && typeof id === 'object') return doorOpen(id);
      return !!(from && doors.has(`${from}#${id}`) && doorRecord({ from, id }));
    },
    crimeTally: (p) => ({ ...state(p).tally }),
    strikeTownsperson,
    provoked,
    caseOf: (p) => caseView(p),
  };
  /**
   * Package 12 basket theft (DaggerfallTradeWindow.DoSteal): the goods `p` picked from the shelves of the open shop
   * `location` and did not pay for. Rolls CalculateShopliftingChance on the basket's weight + item count, tallies
   * Pickpocket. Returns {caught, chance}. On success the caller hands the goods over (and this tallies the thieving
   * crime); when caught the theft is charged here and the caller puts the goods back. Throws while in custody.
   */
  S.law.shopliftBasket = (p, { location = ctx.location(p), quality = 0, weightAndCount = 1, name = 'the goods' } = {}) => {
    requireSuspectFree(p);
    if (!p.rpg.character) throw new Error('Create a character first.');
    ctx.dirty(p);
    const chance = shopliftCaughtChance(skillOf(p, 'Pickpocket'), quality, weightAndCount);
    S.advanceSkill?.(p, 'Pickpocket', 1);
    const meta = S.portals?.into?.(location)?.meta;
    const clock = minutesNow();
    const hour = Number.isFinite(clock) ? Math.floor(clock / 60) % 24 : 12;
    const open = !Number.isInteger(meta?.buildingType) || (isShop(meta.buildingType) && (
      S.buildingAccess?.publicOpen?.(meta.buildingType, meta.regionIndex, clock) ?? isBuildingOpen(meta.buildingType, hour)));
    const staff = open ? occupants(location, p).find((e) => e.shop) : null;
    const caught = !!staff && 1 + Math.floor(random() * 100) <= chance;
    if (caught) {
      say(p, `${staff.name} sees you try to walk off with ${name}!`, { shoplift: 'caught', chance });
      commit(p, 'theft', { location, at: staff });
    } else {
      tally(p, true, 1);
      say(p, `You slip ${name} out unseen.`, { shoplift: 'success', chance });
    }
    return { caught, chance };
  };
  S.reportCrime = (p, crime, { location } = {}) => {
    if (crime === 'vagrancy' || isCrime(crime)) return commit(p, crime, { location: location ?? ctx.location(p) });
    return null;
  };
  S.preventRest?.set?.('jail', custody);
  S.preventTravel?.set?.('jail', custody);

  // ------------------------------------------------------------------ events

  ctx.on('defeat', ({ player: p, entity } = {}) => {
    if (!p) return;
    const c = state(p).charge;
    const byWatch = c && entity && guards.get(entity.id)?.suspectId === p.id;
    if (byWatch) {
      lowerRep(p, c);
      if (goesToCourt(legalRep(p, c.region), false, random)) {
        arrest(p, c, false);
        return;
      }
      say(p, 'The watch leave you where you fell.');
    }
    for (const [id, g] of guards) if (g.suspectId === p.id) dismiss(id, 'suspect fell');
  });

  // ------------------------------------------------------------------ lifecycle

  ctx.onJoin((p) => {
    const l = state(p);
    // A watch halt does not survive a reconnect (the watchmen are gone); the charge does.
    if (l.charge?.stage === 'halted') l.charge.stage = 'wanted';
    lastPatrol.set(p.id, ctx.now());
  });

  ctx.onLeave((p) => {
    for (const [id, g] of guards) if (g.suspectId === p.id) dismiss(id, 'suspect left');
    lastPatrol.delete(p.id);
    lastDispatch.delete(p.id);
    prisonAcc.delete(p.id);
  });

  const prisonAcc = new Map(); // player id -> ms accumulated toward the next day
  ctx.onTick((dt, now) => {
    // Guards: follow, halt, give up.
    for (const [id, g] of [...guards]) {
      const e = ctx.entities.get(id);
      if (!e || e.dead) { guards.delete(id); continue; }
      const p = ctx.players.get(g.suspectId);
      const c = p && state(p).charge;
      if (!p || p.rpg?.defeated || ctx.location(p) !== e.location || !c || c.id !== g.chargeId ||
        (now - g.spawnedAt > cfg.pursuitMs && c.stage !== 'halted')) {
        dismiss(id, 'lost');
        continue;
      }
      if (e.hostile === true) continue; // combat drives a resisting arrest
      // Walk up to the suspect and stop an arm's length away.
      const d = dist(e, p);
      const k = d > 1.4 ? (d - 1.4) / d : 0;
      Object.assign(e._home, { x: e.x + (p.x - e.x) * k, z: e.z + (p.z - e.z) * k });
      if (!g.halted && c.stage === 'wanted' && d <= cfg.haltRange && !p.arriving &&
        Math.abs((e.y ?? 0) - (p.rpg.portal?.footY ?? 0)) <= 2) {
        ctx.dirty(p);
        halt(p, c, e, g);
      } else if (g.halted && c.stage === 'halted' && now - g.haltAt > cfg.haltMs) {
        ctx.dirty(p);
        c.stage = 'wanted';
        say(p, 'You ignore the watch. They draw their weapons!');
        for (const { e: o, g: og } of lawGuards(e.location)) if (og.suspectId === p.id) provoke(o, p);
        sendCase(p);
      }
    }
    for (const p of ctx.players.values()) {
      if (!p.rpg || p.arriving) continue;
      const l = state(p);
      // Prison: one day per prisonMsPerDay; the character's own time is spent on release.
      if (l.prison) {
        const acc = (prisonAcc.get(p.id) ?? 0) + dt * 1000;
        const daysDone = Math.floor(acc / cfg.prisonMsPerDay);
        prisonAcc.set(p.id, acc - daysDone * cfg.prisonMsPerDay);
        if (daysDone > 0) {
          const left = Math.max(0, l.prison.left - daysDone);
          if (left === 0) {
            const result = ctx.runAtomic(p, 'law.release', () => {
              release(p, { reposition: true });
              ctx.notify(p, { kind: 'law.released' });
            });
            if (result.ok) prisonAcc.delete(p.id);
            else prisonAcc.set(p.id, acc);
          } else {
            l.prison.left = left;
            ctx.dirty(p);
            ctx.notify(p, { kind: 'law.prison', left, days: l.prison.days, silent: true });
          }
        }
        // Re-read after an atomic release, which can restore the saved object on rollback.
        const prison = state(p).prison;
        if (prison && ctx.location(p) === prison.location && Number.isFinite(prison.x)) {
          p.x = prison.x;
          p.z = prison.z;
        }
        p.moving = false;
        continue;
      }
      // Committed entry through a forced door: anybody there sees the trespasser.
      if (l.intrusion) {
        const loc = ctx.location(p);
        if (loc !== l.intrusion.location) { delete l.intrusion; p.dirty = true; }
        else if (peopleReady(loc, l.intrusion)) {
          const seen = occupants(loc, p);
          delete l.intrusion;
          p.dirty = true;
          if (seen.length) {
            say(p, `${seen[0].name} catches you in ${S.portals?.into?.(loc)?.label ?? 'the building'}!`);
            commit(p, 'trespassing', { at: { x: seen[0].x, z: seen[0].z } });
          } else ctx.emit('crimeCommitted', { player: p, crime: 'trespassing', region: regionOf(loc), witnessed: false });
        }
      }
      // Classic: a low legal reputation or a banishment brings the watch unprovoked (criminal conspiracy).
      const loc = ctx.location(p);
      if (p.rpg.defeated || !p.rpg.character) continue;
      if (l.charge) {
        if (l.charge.stage === 'halted' && !lawGuards(loc).some(({ g }) => g.chargeId === l.charge.id && g.halted)) {
          l.charge.stage = 'wanted';
          ctx.dirty(p);
        }
        if (!custody(p) && regionOf(loc) === l.charge.region) dispatch(p, l.charge);
        continue;
      }
      if (kindOf(loc) !== 'town') continue;
      if (now - (lastPatrol.get(p.id) ?? 0) < cfg.patrolMs) continue;
      lastPatrol.set(p.id, now);
      const region = regionOf(loc);
      const rep = l.rep[region] ?? 0;
      const chance = l.banished[region] ? 0.10 : rep < CONSPIRACY_REP ? 0.05 : 0;
      if (chance && random() < chance) {
        p.dirty = true;
        commit(p, 'criminalConspiracy', { location: loc });
      }
    }
  });
}

export default install;
