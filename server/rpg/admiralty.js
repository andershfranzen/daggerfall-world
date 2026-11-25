// The law at sea: piracy, regional notoriety and navy hostility, a captain's log and standing with each region's
// crown, harbour boards (bounties, pirate hunts, spyglass surveys) and the spyglass itself.
//
// Design follows Daggerfall Online (Lattymoy, MIT; pinned .ref/dfjs-research-03 src/systems/naval/navalLaw.js,
// harbourBoard.js, captainLedger.js, shipKnowledge.js): Piracy is the classic court's own crime (law/rules.js
// CRIMES.piracy, 10); notoriety is a 0..100 wanted level per crown's waters that decays each game day and makes that
// crown's navy hunt the captain; standing is a crown's regard and earns ranks. What applies here and what does not:
//   - waters: the region of the nearest real port (services.sailing.ports()), so piracy is regional, not three crowns;
//   - crime: charged through the existing court (services.law.commit at that region's port), so the charge, the watch on
//     landing there, legal reputation (once per charge) and the trial are the law feature's, not a copy;
//   - board kinds: bounty, hunt, survey and salvage. Deliveries are the shipyard's jobs (yardTrade.js boardAt);
//   - combat, damage, prizes and plunder stay naval's (server/rpg/naval.js). This module only listens to its events.
//
// Owns `rpg.admiralty` on every character:
//   standing   {region: n}  crown's regard, -99..999 (ranks: Unsworn, Sworn Captain 15, Privateer 50, Commodore 120,
//              Admiral 250)
//   notoriety  {region: n}  0..100, decays NOTORIETY.decayPerDay per game day (`stamp`: world minutes of last decay)
//   log        captain's log counts: sunk/taken by trade, repelled, piracy, plunder, contracts by kind, earned, failed
//   contracts  held contracts: {id, offer, kind, region, portId, portName, title, pay, standing, until, need, done,
//              seen:[uids], site?, quarry?, status:'open'|'done'|'void'}
//   taken      offer ids already taken (an offer is taken once per character)
//   receipts   idempotence keys of applied deeds and paid contracts (bounded ring)
// Shared world rows: `admiralty:quarry:<offerId>` {ended:true, by, at} - a bounty's quarry ends once for everybody,
//   so two captains holding the same posted bounty cannot both be paid for one ship.
//
// Inputs (ctx.on, emitted by server/rpg/naval.js): naval.lawful {player, vessel, target, act:'fire'} (first strike on a
//   lawful ship), naval.struck / naval.sunk / naval.boarded {player, target}, naval.repelled {vessel, by},
//   naval.plundered {player, target, gold}. Only the player naval names, and only while they have a ship at sea (and it is
//   the ship named, when one is), is charged or credited - never crew mates or accounts nearby; player-crewed targets
//   are never piracy and never count for anything (PvP is naval's mutual opt-in). Each deed applies once per target
//   uid (naval's `uid` when sent, else its id scoped to this server boot: naval's npc ids restart from 1).
// Bounty quarry: put to sea through naval's spawn(class, x, z, yaw, {quarry, title}) when a holder's ship nears her
//   waters, again after a despawn or a restart; only that very actor is the quarry (actor ids are unique within a boot),
//   and her end by anybody else ends the notice for everybody. Salvage: `need` casks lie about the contract's wreck site,
//   private to its holder; ordinary NPC wrecks leave shared flotsam casks (`admiralty:flotsam:<id>` world rows, 120 game
//   minutes) whose goods load into the hauling owner's hold through services.shipyard.addCargo.
// Actions: admiralty.status {} | admiralty.board {} | admiralty.take {offerId} | admiralty.abandon {contractId} |
//   admiralty.claim {contractId} | admiralty.glass {targetId} | admiralty.haul {caskId}
// Private sea event (renderer, chart, deck): admiralty.sea {vesselId, reach, maxSpeed, casks:[{id, x, z, kind:'salvage'|'wreck',
//   label, haul}], sites:[{id, kind:'bounty'|'salvage', x, z, name, radius, shipId?}]} on change, at most once a second.
// Services: services.admiralty (alias services.seaLaw): {regionAt, notoriety, standing, rankOf, hostileTo, stanceFor,
//   perks, state}
// Events: private gameEvent admiralty.state (silent), admiralty.glass (silent), admiralty.news (text).

import { repLossFor } from './law/rules.js';
import { GOODS, GOOD_IDS } from './sailing/yardTrade.js';

export const name = 'admiralty';

export const NOTORIETY = Object.freeze({ max: 100, fire: 30, sink: 20, board: 15, decayPerDay: 12 });
/** From this notoriety in a region's waters its navy fights the captain on sight. */
export const NAVY_HUNTS = 50;
/** From this notoriety a region's harbourmasters keep no favours and post no work for the captain. */
export const PERKS_REFUSED_AT = 25;
export const BOARD_REFUSED_AT = NAVY_HUNTS;
export const MINUTES_PER_DAY = 24 * 60;

export const CROWN_RANKS = Object.freeze([
  Object.freeze({ rank: 0, at: -Infinity, key: 'unsworn', title: 'Unsworn' }),
  Object.freeze({ rank: 1, at: 15, key: 'sworn', title: 'Sworn Captain' }),
  Object.freeze({ rank: 2, at: 50, key: 'privateer', title: 'Privateer' }),
  Object.freeze({ rank: 3, at: 120, key: 'commodore', title: 'Commodore' }),
  Object.freeze({ rank: 4, at: 250, key: 'admiral', title: 'Admiral' }),
]);
export const RANK_PERKS = Object.freeze([
  Object.freeze({ yard: 0, pay: 0, offers: 0 }),
  Object.freeze({ yard: 0.05, pay: 0.1, offers: 1 }),
  Object.freeze({ yard: 0.1, pay: 0.2, offers: 1 }),
  Object.freeze({ yard: 0.15, pay: 0.3, offers: 2 }),
  Object.freeze({ yard: 0.2, pay: 0.4, offers: 2 }),
]);
export const STANDING_MIN = -99;
export const STANDING_MAX = 999;
/** A pirate's end, times her size. */
export const DEED_STANDING = Object.freeze({ sink: 2, board: 3, repel: 2 });
/** Piracy against a region's lawful ship, once an act a ship. */
export const PIRACY_STANDING = Object.freeze({ fire: -5, sink: -8, board: -10 });
/** Legal reputation and the knightly order (DFU Generic_Knightly_Order 844) for a pirate's end. */
export const PIRATE_REWARD = Object.freeze({ sink: { legal: 1, knightly: 1 }, board: { legal: 1, knightly: 2 }, repel: { legal: 1, knightly: 1 } });
export const KNIGHTLY_FACTION = 844;
/** A ship's size by hull, naval's names (sailing/combatRules.js HULL_NAMES) and the yard's: her purse and regard multiply by it. */
export const HULL_SIZE = Object.freeze({ boat: 1, sloop: 1, small: 2, galleon: 2, galley: 3, large: 4, carrack: 4 });

export const BOARD_KINDS = Object.freeze(['bounty', 'hunt', 'survey', 'salvage']);
export const BOARD_OFFERS = 4;
export const CONTRACTS_MAX = 3;
export const TERM_DAYS = Object.freeze({ bounty: 4, hunt: 3, survey: 2, salvage: 3 });
export const PAY_BASE = Object.freeze({ bounty: 150, hunt: 85, survey: 50, salvage: 65 });
export const PAY_LEVEL = 0.12;
export const STANDING_DONE = Object.freeze({ bounty: 3, hunt: 1, survey: 2, salvage: 3 });
export const STANDING_FAILED = -3;
export const STANDING_ABANDONED = -1;
export const NEED = Object.freeze({ hunt: [2, 4], survey: [3, 5], salvage: [3, 5] });
/** A bounty's quarry: naval's pirate class by the notice's hull (sailing/combatRules.js SHIP_CLASSES). */
export const QUARRY_CLASS = Object.freeze({ small: 'pirateBrig', galley: 'pirateGalley', large: 'pirateFlagship' });
/** The quarry is put to sea when a holder's ship comes within this of her waters (inside naval's DESPAWN_BEYOND, 1,900 m). */
export const QUARRY_SPAWN_M = 1700;
/** Casks: shown within SEA_SHOW_M of a ship, hauled within HAUL_M at no more than HAUL_SPEED (m/s). */
export const SEA_SHOW_M = 1500;
export const HAUL_M = 30;
export const HAUL_SPEED = 2.5;
/** A salvage wreck's casks lie this far about her site (m). */
export const CASK_SPREAD = Object.freeze([40, 160]);
/** Flotsam of an ordinary wreck floats this many game minutes (10 real minutes at 12x), at most FLOTSAM_MAX at once. */
export const FLOTSAM_MINUTES = 120;
export const FLOTSAM_MAX = 64;
/** A bounty's quarry lies this far off her port (m); a pirate ended within QUARRY_REACH_M of it is her. */
export const SITE_M = Object.freeze({ near: 1500, far: 4000 });
export const QUARRY_REACH_M = 900;
/** The sea within this of a port's quay is the port's (naval's SAFE_PORT_M). */
export const PORT_REACH_M = 600;

/** The glass: colours within GLASS_FAR_M held GLASS_STUDY_S, guns, hands and hold within GLASS_NEAR_M held GLASS_STUDY_NEAR_S. */
export const GLASS_FAR_M = 1800;
export const GLASS_NEAR_M = 900;
export const GLASS_STUDY_S = 0.6;
export const GLASS_STUDY_NEAR_S = 1.4;
export const KNOW = Object.freeze({ hull: 0, colours: 1, studied: 2 });

const RECEIPTS_MAX = 256;
const TAKEN_MAX = 64;
const SEEN_MAX = 16;
const LOG_TRADES = Object.freeze(['pirate', 'merchant', 'navy']);
const LAWFUL = new Set(['merchant', 'navy']);
const ID_RE = /^[\w:,.#@/' -]{1,160}$/;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const int = (v, d = 0) => (Number.isFinite(v) ? Math.trunc(v) : d);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** FNV-1a 32-bit. */
export function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
/** mulberry32 over a seed: a deterministic stream for a port's board on a day. */
export function stream(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function rankOf(standing) {
  const s = Number(standing) || 0;
  let r = CROWN_RANKS[0];
  for (const x of CROWN_RANKS) if (s >= x.at) r = x;
  return r;
}
export const perksOf = (standing, notoriety = 0) => (notoriety >= PERKS_REFUSED_AT ? RANK_PERKS[0] : RANK_PERKS[rankOf(standing).rank]);
export const anchorsOf = (n) => clamp(Math.floor((Number(n) || 0) / 25), 0, 4);
export const sizeOf = (target) => (target?.flagship ? 4 : HULL_SIZE[target?.hull] ?? 1);

/** Standing a deed is worth with the region it is charged to. */
export function standingFor(act, target) {
  if (!target) return 0;
  if (target.faction === 'pirate') return (DEED_STANDING[act] ?? 0) * sizeOf(target);
  if (LAWFUL.has(target.faction)) return PIRACY_STANDING[act] ?? 0;
  return 0;
}

/** A contract's purse: base by kind, times the captain's level and rank's pay, to the nearest five. */
export function payOf(kind, { level = 1, size = 1, need = 1, pay = 0 } = {}) {
  const k = (1 + PAY_LEVEL * (Math.max(1, level | 0) - 1)) * (1 + Math.max(0, Number(pay) || 0));
  const g = kind === 'bounty' ? PAY_BASE.bounty * Math.max(1, size) * k : (PAY_BASE[kind] ?? 0) * need * k;
  return Math.max(5, Math.round(g / 5) * 5);
}

const PIRATE_NAMES = Object.freeze(['Red Gull', 'Widow\'s Due', 'Salt Hag', 'Black Tern', 'Drowned Crown', 'Gallows Wind',
  'Rot-Tooth Ann', 'Mercy\'s End', 'Iliac Cutthroat', 'Bloody Shoal', 'Kraken\'s Lass', 'Grey Reaver']);
const QUARRY_HULLS = Object.freeze(['small', 'small', 'galley', 'large']);
const WRECK_NAMES = Object.freeze(['Gilded Heron', 'Bay Matron', 'Saint Kynareth', 'Wayward Ewe', 'Lantern of Tulune', 'Glenpoint Lass',
  'Ninefold', 'Copper Wren', 'Sentinel Pearl', 'Old Brennan']);

/** A salvage contract's casks: deterministic about her wreck, `need` of them. */
export function casksOf(c) {
  if (!c?.wreck) return [];
  const out = [];
  for (let k = 0; k < c.need; k++) {
    const r = stream(hash(`${c.id}#cask${k}`));
    const a = r() * Math.PI * 2, d = CASK_SPREAD[0] + r() * (CASK_SPREAD[1] - CASK_SPREAD[0]);
    out.push({ id: `s:${c.id}#${k}`, x: Math.round(c.wreck.x + Math.sin(a) * d), z: Math.round(c.wreck.z - Math.cos(a) * d) });
  }
  return out;
}

/**
 * The board a port posts on a world day: BOARD_OFFERS plus the rank's more, kinds in turn off the port's stream.
 * Pure and deterministic, so every captain in the port reads the same board and a taken offer can be re-derived.
 * @param {{port:{id:string,name:string,x:number,z:number,region:string}, day:number, level?:number, perks?:{offers?:number,pay?:number},
 *   isWater?:(x:number,z:number)=>boolean}} o
 */
export function boardFor({ port, day, level = 1, perks = RANK_PERKS[0], isWater = null }) {
  const r = stream(hash(`${port.id}#${day}`));
  const n = BOARD_OFFERS + (perks?.offers | 0);
  const first = Math.floor(r() * BOARD_KINDS.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const kind = BOARD_KINDS[(first + i) % BOARD_KINDS.length];
    const id = `${port.id}#${day}#${i}`;
    const base = { id, kind, region: port.region, portId: port.id, portName: port.name, days: TERM_DAYS[kind] };
    if (kind === 'bounty') {
      const site = siteFor(port, r, isWater);
      if (!site) continue;
      const hull = QUARRY_HULLS[Math.min(QUARRY_HULLS.length - 1, Math.floor((level - 1) / 4) + Math.floor(r() * 2))];
      const name = PIRATE_NAMES[Math.floor(r() * PIRATE_NAMES.length)];
      const pay = payOf('bounty', { level, size: HULL_SIZE[hull], pay: perks?.pay });
      out.push({ ...base, title: `Bounty: the ${name}`, words: `A pirate ${hull === 'large' ? 'galleon' : hull === 'galley' ? 'galley' : 'brigantine'} preying on ${port.region}'s shipping, last seen ${site.words} of ${port.name}. Sink or take her.`,
        pay, standing: STANDING_DONE.bounty * HULL_SIZE[hull], need: 1, quarry: { name, hull, x: site.x, z: site.z } });
    } else if (kind === 'salvage') {
      const site = siteFor(port, r, isWater);
      if (!site) continue;
      const [lo, hi] = NEED.salvage;
      const need = lo + Math.floor(r() * (hi - lo + 1));
      const good = GOOD_IDS[Math.floor(r() * GOOD_IDS.length)];
      const name = `${WRECK_NAMES[Math.floor(r() * WRECK_NAMES.length)]}`;
      out.push({ ...base, title: `Salvage: the ${name}`, words: `The merchantman ${name} went down ${site.words} of ${port.name} with ${GOODS[good].label.toLowerCase()} aboard. Raise ${need} casks of her cargo where she lies.`,
        pay: payOf('salvage', { level, need, pay: perks?.pay }), standing: STANDING_DONE.salvage, need, wreck: { name, x: site.x, z: site.z } });
    } else {
      const [lo, hi] = NEED[kind];
      const need = lo + Math.floor(r() * (hi - lo + 1));
      const pay = payOf(kind, { level, need, pay: perks?.pay });
      out.push(kind === 'hunt'
        ? { ...base, title: `Hunt: ${need} pirates`, words: `End ${need} pirate ships, sunk or taken, in ${port.region}'s waters.`, pay, standing: STANDING_DONE.hunt * need, need }
        : { ...base, title: `Survey: ${need} ships`, words: `Study ${need} different ships through your spyglass in ${port.region}'s waters, without firing on them.`, pay, standing: STANDING_DONE.survey, need });
    }
  }
  return out;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
/** Open water off a port: eight ways from a drawn one, the first point whose neighbourhood is water. */
export function siteFor(port, r, isWater) {
  const first = Math.floor(r() * 8);
  const want = SITE_M.near + r() * (SITE_M.far - SITE_M.near);
  const open = (x, z) => typeof isWater !== 'function'
    || [[0, 0], [150, 0], [-150, 0], [0, 150], [0, -150]].every(([dx, dz]) => isWater(x + dx, z + dz));
  for (let k = 0; k < 8; k++) {
    const w = (first + k) % 8;
    const a = w * (Math.PI / 4); // 0 = north (-z), clockwise toward +x east
    for (const d of [want, SITE_M.near, SITE_M.far]) {
      const x = Math.round(port.x + Math.sin(a) * d), z = Math.round(port.z - Math.cos(a) * d);
      if (open(x, z)) return { x, z, words: `${(d / 1000).toFixed(1)} km ${COMPASS[w]}` };
    }
  }
  return null;
}

/** What a frame of the glass earns: knowledge never lowered. */
export function knowledgeOf(known, { dist: d, held = 0, struck = false }) {
  let k = clamp(known | 0, KNOW.hull, KNOW.studied);
  if (struck) return KNOW.studied;
  if (d <= 220) k = Math.max(k, KNOW.colours);
  if (held >= GLASS_STUDY_S && d <= GLASS_FAR_M) k = Math.max(k, KNOW.colours);
  if (held >= GLASS_STUDY_NEAR_S && d <= GLASS_NEAR_M) k = KNOW.studied;
  return k;
}

export function newLog() {
  const z = () => Object.fromEntries(LOG_TRADES.map((k) => [k, 0]));
  return { sunk: z(), taken: z(), repelled: 0, piracy: 0, plunder: 0, contracts: Object.fromEntries(BOARD_KINDS.map((k) => [k, 0])), failed: 0, earned: 0, hauled: 0 };
}

/** Normalise a saved `rpg.admiralty` (bounded, every number clamped). */
export function normalize(a) {
  if (!isObj(a)) a = {};
  const out = { v: 1, standing: {}, notoriety: {}, stamp: Number.isFinite(a.stamp) ? a.stamp : null, log: newLog(), contracts: [], taken: [], receipts: [] };
  for (const [k, v] of Object.entries(isObj(a.standing) ? a.standing : {})) if (typeof k === 'string' && k.length <= 60 && Number.isFinite(v) && v) out.standing[k] = clamp(Math.trunc(v), STANDING_MIN, STANDING_MAX);
  for (const [k, v] of Object.entries(isObj(a.notoriety) ? a.notoriety : {})) if (typeof k === 'string' && k.length <= 60 && Number.isFinite(v) && v > 0) out.notoriety[k] = clamp(v, 0, NOTORIETY.max);
  const l = isObj(a.log) ? a.log : {};
  for (const g of ['sunk', 'taken']) for (const t of LOG_TRADES) out.log[g][t] = clamp(int(l[g]?.[t]), 0, 1e6);
  for (const k of BOARD_KINDS) out.log.contracts[k] = clamp(int(l.contracts?.[k]), 0, 1e6);
  for (const k of ['repelled', 'piracy', 'plunder', 'failed', 'earned', 'hauled']) out.log[k] = clamp(int(l[k]), 0, 1e9);
  for (const c of Array.isArray(a.contracts) ? a.contracts : []) {
    if (out.contracts.length >= CONTRACTS_MAX) break;
    if (!isObj(c) || !BOARD_KINDS.includes(c.kind) || typeof c.id !== 'string' || !ID_RE.test(c.id) || typeof c.region !== 'string') continue;
    const need = clamp(int(c.need, 1), 1, 10);
    out.contracts.push({
      id: c.id, offer: typeof c.offer === 'string' ? c.offer : c.id, kind: c.kind, region: c.region.slice(0, 60),
      portId: String(c.portId ?? '').slice(0, 160), portName: String(c.portName ?? '').slice(0, 80),
      title: String(c.title ?? '').slice(0, 120), words: String(c.words ?? '').slice(0, 300),
      pay: clamp(int(c.pay), 0, 1e6), standing: clamp(int(c.standing), 0, 60), until: Number.isFinite(c.until) ? c.until : 0,
      need, done: clamp(int(c.done), 0, need),
      seen: Array.isArray(c.seen) ? c.seen.filter((s) => typeof s === 'string' && s.length <= 160).slice(-SEEN_MAX) : [],
      quarry: c.kind === 'bounty' && isObj(c.quarry) && Number.isFinite(c.quarry.x) && Number.isFinite(c.quarry.z)
        ? { name: String(c.quarry.name ?? 'pirate').slice(0, 40), hull: HULL_SIZE[c.quarry.hull] ? c.quarry.hull : 'small', x: c.quarry.x, z: c.quarry.z, actorId: typeof c.quarry.actorId === 'string' ? c.quarry.actorId : null } : null,
      wreck: c.kind === 'salvage' && isObj(c.wreck) && Number.isFinite(c.wreck.x) && Number.isFinite(c.wreck.z)
        ? { name: String(c.wreck.name ?? 'wreck').slice(0, 40), x: c.wreck.x, z: c.wreck.z } : null,
      status: ['open', 'done', 'void'].includes(c.status) ? c.status : 'open',
    });
  }
  out.taken = (Array.isArray(a.taken) ? a.taken : []).filter((s) => typeof s === 'string' && s.length <= 200).slice(-TAKEN_MAX);
  out.receipts = (Array.isArray(a.receipts) ? a.receipts : []).filter((s) => typeof s === 'string' && s.length <= 200).slice(-RECEIPTS_MAX);
  return out;
}

export function install(ctx, options = {}) {
  const S = (ctx.services ||= {});
  const log = ctx.log ?? console;
  const quarries = new Map(); // offer id -> {ended, by, at} (world rows)
  for (const [k, v] of ctx.loadWorld?.('admiralty:quarry:') ?? []) if (isObj(v)) quarries.set(k.slice('admiralty:quarry:'.length), v);
  const quarryActor = new Map(); // offer id -> naval actor id (this boot)
  const actorQuarry = new Map(); // naval actor id -> offer id
  const flotsam = new Map(); // cask id -> {id, x, z, good, qty, until (world minutes), from}
  for (const [k, v] of ctx.loadWorld?.('admiralty:flotsam:') ?? []) {
    if (isObj(v) && GOODS[v.good] && Number.isFinite(v.x) && Number.isFinite(v.z) && int(v.qty) > 0 && Number.isFinite(v.until)) {
      const id = k.slice('admiralty:flotsam:'.length);
      flotsam.set(id, { id, x: v.x, z: v.z, good: v.good, qty: clamp(int(v.qty), 1, 50), until: v.until, from: String(v.from ?? 'wreck').slice(0, 40) });
    }
  }
  const wrecked = new Set(); // wreck uids that already left flotsam
  const lastSea = new Map(); // player id -> JSON of last admiralty.sea
  const glass = new Map(); // player id -> {targetId, since}
  const known = new Map(); // player id -> Map(uid -> KNOW)
  const lastSent = new Map(); // player id -> JSON of last admiralty.state
  const lastTick = new Map();
  const BOOT = options.bootId ?? `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

  // ------------------------------------------------------------------ clock, ports, state

  const minutes = () => {
    const m = S.worldClock?.()?.minutes;
    return Number.isFinite(m) ? m : Math.floor(ctx.now() / 5000); // 12x: a game minute every 5 s
  };
  const today = () => Math.floor(minutes() / MINUTES_PER_DAY);
  const regionOfPort = (p) => p.region ?? S.law?.regionOf?.(p.id) ?? (/^town:([^/]+)\//.exec(p.id)?.[1]) ?? 'the Iliac Bay';
  function ports() {
    let list = [];
    try { list = S.sailing?.ports?.() ?? []; } catch (err) { log.warn?.('[admiralty] ports failed:', err?.message ?? err); }
    return list.filter((p) => p && typeof p.id === 'string' && Number.isFinite(p.x) && Number.isFinite(p.z))
      .map((p) => ({ id: p.id, name: p.name ?? p.id, x: p.x, z: p.z, region: regionOfPort(p) }));
  }
  function nearestPort(x, z) {
    let best = null, bd = Infinity;
    for (const p of ports()) {
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < bd) { bd = d; best = p; }
    }
    return best ? { port: best, distance: bd } : null;
  }
  /** The region whose waters a point lies in: the nearest port's. */
  const regionAt = (x, z) => (Number.isFinite(x) && Number.isFinite(z) ? nearestPort(x, z)?.port.region ?? null : null);

  function state(p) {
    const rpg = (p.rpg ||= {});
    if (!isObj(rpg.admiralty) || rpg.admiralty.v !== 1 || !isObj(rpg.admiralty.log)) rpg.admiralty = normalize(rpg.admiralty);
    return rpg.admiralty;
  }
  /** Notoriety decays NOTORIETY.decayPerDay a game day since the last stamp. */
  function decay(p) {
    const a = state(p);
    const now = minutes();
    if (a.stamp == null) { a.stamp = now; return a; }
    const days = (now - a.stamp) / MINUTES_PER_DAY;
    if (!(days > 0.01)) return a;
    for (const [k, v] of Object.entries(a.notoriety)) {
      const w = v - NOTORIETY.decayPerDay * days;
      if (w > 0) a.notoriety[k] = Math.round(w * 100) / 100;
      else delete a.notoriety[k];
    }
    a.stamp = now;
    return a;
  }
  const notoriety = (p, region) => (region ? decay(p).notoriety[region] ?? 0 : 0);
  const standing = (p, region) => (region ? state(p).standing[region] ?? 0 : 0);
  const perks = (p, region) => perksOf(standing(p, region), notoriety(p, region));
  const levelOf = (p) => clamp(int(p.rpg?.character?.level, 1), 1, 100);

  function receipt(a, key) {
    if (a.receipts.includes(key)) return false;
    a.receipts.push(key);
    if (a.receipts.length > RECEIPTS_MAX) a.receipts.splice(0, a.receipts.length - RECEIPTS_MAX);
    return true;
  }
  function addNotoriety(a, region, n) {
    if (!region || !n) return;
    a.notoriety[region] = clamp((a.notoriety[region] ?? 0) + n, 0, NOTORIETY.max);
  }
  function addStanding(p, a, region, n, news) {
    if (!region || !n) return;
    const before = a.standing[region] ?? 0;
    const after = clamp(before + Math.trunc(n), STANDING_MIN, STANDING_MAX);
    if (after) a.standing[region] = after; else delete a.standing[region];
    const r0 = rankOf(before), r1 = rankOf(after);
    if (r1.rank !== r0.rank) news.push(r1.rank > r0.rank ? `${region} names you ${r1.title}.` : `${region} no longer counts you ${r0.title}.`);
  }

  // ------------------------------------------------------------------ views

  function contractView(c, now = minutes()) {
    const left = Math.max(0, c.until - now);
    const d = Math.floor(left / MINUTES_PER_DAY), h = Math.floor((left % MINUTES_PER_DAY) / 60);
    const term = c.status === 'done' ? 'Done: claim at any harbour' : c.status === 'void' ? 'Void: another captain ended her'
      : left <= 0 ? 'Time is up' : d > 0 ? `${d} ${d === 1 ? 'day' : 'days'}${h ? `, ${h} h` : ''} left` : `${Math.max(1, h)} h left`;
    const progress = c.kind === 'hunt' ? `${c.done} of ${c.need} ended` : c.kind === 'survey' ? `${c.done} of ${c.need} studied`
      : c.kind === 'salvage' ? `${c.done} of ${c.need} casks raised`
      : c.status === 'done' ? 'Ended' : 'At large';
    return { id: c.id, kind: c.kind, region: c.region, portName: c.portName, title: c.title, words: c.words, pay: c.pay,
      standing: c.standing, need: c.need, done: c.done, status: c.status, progress, left: term,
      site: c.status !== 'open' ? null : c.quarry ? { kind: 'bounty', x: c.quarry.x, z: c.quarry.z, name: c.quarry.name }
        : c.wreck ? { kind: 'salvage', x: c.wreck.x, z: c.wreck.z, name: c.wreck.name } : null };
  }

  function view(p) {
    const a = decay(p);
    const regions = [...new Set([...Object.keys(a.standing), ...Object.keys(a.notoriety)])].sort();
    const here = harbourOf(p);
    let board = null;
    if (here) {
      const refused = refusal(p, here.region);
      board = { portId: here.id, portName: here.name, region: here.region, refused,
        offers: refused ? [] : offersAt(p, here).map((o) => ({ id: o.id, kind: o.kind, title: o.title, words: o.words, pay: o.pay, standing: o.standing, days: o.days, need: o.need, taken: a.taken.includes(o.id) })) };
    }
    const wanted = (region) => S.law?.wanted?.(p, region)?.crime === 'piracy';
    return {
      kind: 'admiralty.state', silent: true,
      regions: regions.map((r) => {
        const s = a.standing[r] ?? 0, n = a.notoriety[r] ?? 0, rk = rankOf(s);
        const next = CROWN_RANKS[rk.rank + 1];
        return { region: r, standing: s, rank: rk.rank, title: rk.title, next: next ? { title: next.title, wanting: next.at - s } : null,
          notoriety: Math.round(n), anchors: anchorsOf(n), hunted: n >= NAVY_HUNTS || wanted(r), perks: perksOf(s, n) };
      }),
      contracts: a.contracts.map((c) => contractView(c)),
      log: a.log,
      board,
      max: CONTRACTS_MAX,
    };
  }
  function send(p, force = false) {
    if (!ctx.players?.get?.(p.id) && ctx.players?.size) return;
    const v = view(p);
    const json = JSON.stringify(v);
    if (!force && lastSent.get(p.id) === json) return;
    lastSent.set(p.id, json);
    ctx.notify(p, v);
  }
  const sendLater = (p, force = false) => ctx.afterCommit(() => send(p, force));
  const news = (p, lines) => {
    if (!lines.length) return;
    ctx.afterCommit(() => ctx.notify(p, { kind: 'admiralty.news', text: lines.join(' ') }));
  };

  // ------------------------------------------------------------------ harbour

  function vesselOf(p) {
    try { return S.sailing?.vesselFor?.(p) ?? null; } catch { return null; }
  }
  /** The port a captain stands in: their ship moored or within PORT_REACH_M of its quay, or ashore in the port town. */
  function harbourOf(p) {
    const list = ports();
    if (!list.length) return null;
    const v = vesselOf(p);
    if (v) {
      const berth = v.docked ?? v.mooredAt; // sailing core: `docked` (port id, null at sea)
      if (berth) { const m = list.find((q) => q.id === berth); if (m) return m; }
      if (Number.isFinite(v.x) && Number.isFinite(v.z)) {
        const n = nearestPort(v.x, v.z);
        return n && n.distance <= PORT_REACH_M ? n.port : null;
      }
      return null;
    }
    const loc = String(ctx.location?.(p) ?? '');
    return list.find((q) => loc === q.id || loc.startsWith(`${q.id}/`) || loc.startsWith(`interior:${q.id.slice(5)}/`)) ?? null;
  }
  function refusal(p, region) {
    if (S.law?.wanted?.(p, region)?.crime === 'piracy') return `The harbourmaster of ${region} has a warrant out for you for piracy.`;
    if (notoriety(p, region) >= BOARD_REFUSED_AT) return `No harbourmaster in ${region} will post work for a known pirate.`;
    return null;
  }
  function offersAt(p, port) {
    let isWater = null;
    // null while the chart loads: unknown counts as water, so a port's board is the same all day for everybody.
    if (typeof S.sailing?.isWater === 'function') isWater = (x, z) => { try { return S.sailing.isWater(x, z) !== false; } catch { return true; } };
    return boardFor({ port, day: today(), level: levelOf(p), perks: perks(p, port.region), isWater });
  }

  // ------------------------------------------------------------------ deeds at sea

  function run(p, label, fn) {
    if (ctx.inAction?.()) { ctx.dirty(p); fn(); return { ok: true }; }
    if (typeof ctx.runAtomic === 'function') return ctx.runAtomic(p, label, () => { ctx.dirty(p); fn(); });
    ctx.dirty(p);
    fn();
    p.dirty = true;
    return { ok: true };
  }
  const vesselId = (v) => (v == null ? null : typeof v === 'object' ? v.id ?? null : v);
  /** The named actor has a ship (owned or aboard), and it is the ship the event names when it names one. */
  function commands(p, vessel) {
    if (typeof S.sailing?.vesselFor !== 'function') return true;
    const mine = vesselOf(p);
    if (!mine) return false;
    const named = vesselId(vessel);
    return named == null || named === mine.id;
  }
  const uidOf = (t) => (t && (typeof t.uid === 'string' || Number.isFinite(t.uid)) ? String(t.uid) : t?.id != null ? `${BOOT}:${t.id}` : null);
  const npcTarget = (t) => isObj(t) && t.kind !== 'player' && t.faction !== 'player' && !t.ownerId;

  /** Validates a naval event: the acting captain online and commanding the vessel named, an NPC target with a uid. */
  function accept(ev, act) {
    const p = ev?.player;
    if (!p || typeof p !== 'object' || !p.rpg) return null;
    if (ctx.players?.size && ctx.players.get(p.id) !== p) return null;
    const t = ev.target;
    if (!npcTarget(t)) return null; // PvP: naval's mutual opt-in, never piracy and never credit
    const uid = uidOf(t);
    if (!uid || uid.length > 120) return null;
    if (!commands(p, ev.vessel)) { log.warn?.(`[admiralty] ${act} by ${p.id} ignored: not commanding ${vesselId(ev.vessel)}`); return null; }
    return { p, t, uid };
  }

  function deed(act, ev) {
    const ok = accept(ev, act);
    if (!ok) return;
    const { p, t, uid } = ok;
    const region = t.region ?? regionAt(t.x, t.z) ?? regionAt(p.x, p.z);
    if (!region) return;
    const res = run(p, `admiralty.${act}`, () => {
      const a = decay(p);
      if (!receipt(a, `${act}:${uid}`)) return; // replayed or duplicate event
      const lines = [];
      if (LAWFUL.has(t.faction)) {
        if (act === 'fire' || act === 'board') {
          // The court's own crime, charged at a port of these waters (law.commit: one charge, reputation once per charge).
          const port = ports().filter((q) => q.region === region).sort((x, y) => Math.hypot(x.x - t.x, x.z - t.z) - Math.hypot(y.x - t.x, y.z - t.z))[0];
          if (port && typeof S.law?.commit === 'function') S.law.commit(p, 'piracy', { location: port.id, witnessed: true });
          else if (S.law?.changeLegalRep) S.law.changeLegalRep(p, region, -repLossFor('piracy'), 'piracy');
          if (act === 'fire') a.log.piracy++;
        }
        if (act === 'fire' || act === 'sink' || act === 'board') {
          const before = a.notoriety[region] ?? 0;
          addNotoriety(a, region, NOTORIETY[act]);
          addStanding(p, a, region, PIRACY_STANDING[act], lines);
          if (act === 'fire') lines.unshift(`Piracy! ${region} will hear of an attack on a ${t.faction === 'navy' ? 'crown ship' : 'merchantman'}.`);
          if (before < NAVY_HUNTS && a.notoriety[region] >= NAVY_HUNTS) lines.push(`${region}'s navy now hunts you on sight.`);
        }
        if (act === 'sink') a.log.sunk[t.faction]++;
        if (act === 'board') a.log.taken[t.faction]++;
      } else if (t.faction === 'pirate' && (act === 'sink' || act === 'board' || act === 'repel')) {
        addStanding(p, a, region, standingFor(act, t), lines);
        const r = PIRATE_REWARD[act];
        if (S.law?.changeLegalRep) S.law.changeLegalRep(p, region, r.legal, 'pirate');
        if (typeof S.adjustReputation === 'function') { try { S.adjustReputation(p, KNIGHTLY_FACTION, r.knightly); } catch { /* faction unknown here */ } }
        if (act === 'sink') a.log.sunk.pirate++;
        else if (act === 'board') a.log.taken.pirate++;
        else a.log.repelled++;
        if (act !== 'repel') advanceEnd(p, a, t, region, lines);
      } else return;
      news(p, lines);
      sendLater(p);
    });
    if (res && res.ok === false) log.warn?.(`[admiralty] ${act} for ${p.id} not saved: ${res.error}`);
  }

  /** A pirate ended by the captain's hand: hunts in her waters, and a bounty whose quarry she is. */
  function advanceEnd(p, a, t, region, lines) {
    for (const c of a.contracts) {
      if (c.status !== 'open') continue;
      if (c.kind === 'hunt' && c.region === region) {
        c.done = Math.min(c.need, c.done + 1);
        if (c.done >= c.need) { c.status = 'done'; lines.push(`${c.title}: done. Claim your purse at any harbour.`); }
      } else if (c.kind === 'bounty' && c.quarry) {
        if (!isQuarry(t, c)) continue;
        const q = quarries.get(c.offer);
        if (q?.ended) continue; // already ended by someone: void on the next look
        const row = { ended: true, by: p.id, at: minutes() };
        const prev = q;
        quarries.set(c.offer, row);
        ctx.onRollback?.(() => { if (prev) quarries.set(c.offer, prev); else quarries.delete(c.offer); });
        ctx.dirtyWorld(`admiralty:quarry:${c.offer}`, row);
        c.status = 'done';
        lines.push(`The ${c.quarry.name} is ended. Claim the bounty at any harbour.`);
      }
    }
  }

  /** Whether a naval ship is this bounty's own quarry: the very actor we put to sea for it (never another pirate near). */
  function isQuarry(t, c) {
    if (!isObj(t) || !c?.quarry || t.faction !== 'pirate') return false;
    if (t.quarry != null) return String(t.quarry) === c.offer;
    if (typeof S.naval?.spawnQuarry === 'function' || typeof S.naval?.spawn === 'function') return actorQuarry.get(String(t.id)) === c.offer;
    return Number.isFinite(t.x) && Math.hypot(t.x - c.quarry.x, t.z - c.quarry.z) <= QUARRY_REACH_M; // no spawner: her waters
  }
  /** A quarry ended by any other hand (another captain without the notice, the navy, the sea): ended for everybody. */
  function quarryGone(ev) {
    const t = ev?.target;
    const offer = t?.quarry != null ? String(t.quarry) : t?.id != null ? actorQuarry.get(String(t.id)) : null;
    if (!offer || quarries.get(offer)?.ended) return;
    const by = ev.player?.rpg ? ev.player : null;
    if (by && state(by).contracts.some((c) => c.offer === offer && c.status === 'open')) return; // the holder's deed pays it
    const row = { ended: true, by: by?.id ?? null, at: minutes() };
    const write = () => {
      quarries.set(offer, row);
      ctx.onRollback?.(() => quarries.delete(offer));
      ctx.dirtyWorld(`admiralty:quarry:${offer}`, row);
    };
    // Saved with the named player's transaction when there is one (durable at once); else on the next periodic save.
    if (by && ctx.players?.get?.(by.id) === by) run(by, 'admiralty.quarry', write);
    else write();
  }

  // Flotsam: an NPC ship gone down leaves casks of her trade where she sank, for any captain to haul.
  function wreckFlotsam(ev) {
    const t = ev?.target;
    if (!npcTarget(t) || !Number.isFinite(t.x) || !Number.isFinite(t.z)) return;
    const uid = uidOf(t);
    if (!uid || wrecked.has(uid)) return;
    wrecked.add(uid);
    if (wrecked.size > 512) wrecked.delete(wrecked.values().next().value);
    let anyone = false;
    try { anyone = (S.sailing?.vessels?.() ?? []).some((v) => !v.sunk && Math.hypot(v.x - t.x, v.z - t.z) <= SEA_SHOW_M); } catch { anyone = false; }
    if (!anyone || flotsam.size >= FLOTSAM_MAX) return;
    const by = ev.player?.rpg && ctx.players?.get?.(ev.player.id) === ev.player ? ev.player : null;
    if (by) run(by, 'admiralty.flotsam', () => leave(t, uid));
    else leave(t, uid);
  }
  function leave(t, uid) {
    const r = stream(hash(uid));
    const n = t.faction === 'merchant' ? 2 + Math.floor(r() * 2) : 1 + Math.floor(r() * 2);
    const pool = t.faction === 'navy' ? ['iron', 'timber', 'ale'] : t.faction === 'pirate' ? ['ale', 'wine', 'spices', 'silk'] : GOOD_IDS;
    for (let k = 0; k < n; k++) {
      const id = `w:${hash(`${uid}#${k}`).toString(36)}${k}`;
      const good = pool[Math.floor(r() * pool.length)];
      const f = { id, x: Math.round(t.x + (r() - 0.5) * 50), z: Math.round(t.z + (r() - 0.5) * 50), good, qty: 1 + Math.floor(r() * (t.faction === 'merchant' ? 6 : 3)),
        until: minutes() + FLOTSAM_MINUTES, from: String(t.title ?? t.faction).slice(0, 40) };
      flotsam.set(id, f);
      ctx.onRollback?.(() => flotsam.delete(id));
      ctx.dirtyWorld(`admiralty:flotsam:${id}`, { x: f.x, z: f.z, good: f.good, qty: f.qty, until: f.until, from: f.from });
    }
  }
  ctx.on('naval.sunk', quarryGone);
  ctx.on('naval.boarded', quarryGone);
  ctx.on('naval.sunk', wreckFlotsam);

  ctx.on('naval.lawful', (ev) => { if (!ev?.act || ev.act === 'fire') deed('fire', ev); });
  ctx.on('naval.fire', (ev) => { if (ev?.target && LAWFUL.has(ev.target.faction)) deed('fire', ev); }); // contract v1 shape
  ctx.on('naval.sunk', (ev) => deed('sink', ev));
  ctx.on('naval.boarded', (ev) => deed('board', ev));
  ctx.on('naval.repelled', (ev) => {
    // Boarders thrown back off a player's deck: credited to that ship's owner.
    const v = ev?.vessel;
    const player = ev?.player ?? (v && v.ownerId != null ? ctx.players?.get?.(v.ownerId) : null);
    deed('repel', { player, vessel: v, target: ev?.target ?? ev?.by });
  });
  ctx.on('naval.struck', (ev) => {
    const ok = accept(ev, 'struck');
    if (!ok) return;
    const k = known.get(ok.p.id) ?? new Map();
    k.set(ok.uid, KNOW.studied);
    known.set(ok.p.id, k);
  });
  ctx.on('naval.plundered', (ev) => {
    const ok = accept(ev, 'plunder');
    if (!ok) return;
    const gold = clamp(int(ev.gold), 0, 1e7);
    run(ok.p, 'admiralty.plunder', () => {
      const a = state(ok.p);
      if (!receipt(a, `plunder:${ok.uid}`)) return;
      a.log.plunder = clamp(a.log.plunder + gold, 0, 1e9);
      sendLater(ok.p);
    });
  });

  // ------------------------------------------------------------------ actions

  const need = (p) => {
    if (p.rpg?.law?.prison) throw new Error('You are in prison.');
  };
  const idArg = (v, what) => {
    if (typeof v !== 'string' || !ID_RE.test(v)) throw new Error(`Which ${what}?`);
    return v;
  };

  ctx.onAction('admiralty.status', (p) => { decay(p); sendLater(p, true); });

  ctx.onAction('admiralty.board', (p) => {
    need(p);
    if (!harbourOf(p)) throw new Error('The harbourmaster\'s board is in port. Moor at a harbour first.');
    sendLater(p, true);
  });

  ctx.onAction('admiralty.take', (p, args) => {
    need(p);
    const offerId = idArg(args.offerId, 'contract');
    const port = harbourOf(p);
    if (!port) throw new Error('Take contracts at a harbourmaster\'s board, in port.');
    const why = refusal(p, port.region);
    if (why) throw new Error(why);
    const offer = offersAt(p, port).find((o) => o.id === offerId);
    if (!offer) throw new Error('That notice is no longer on this board.');
    const a = decay(p);
    if (a.taken.includes(offer.id)) throw new Error('You have already taken that contract.');
    if (a.contracts.length >= CONTRACTS_MAX) throw new Error(`You hold ${CONTRACTS_MAX} contracts already.`);
    if (offer.kind === 'bounty' && quarries.get(offer.id)?.ended) throw new Error('That pirate has already been ended.');
    ctx.dirty(p);
    a.taken.push(offer.id);
    if (a.taken.length > TAKEN_MAX) a.taken.splice(0, a.taken.length - TAKEN_MAX);
    const c = { id: `${offer.id}@${p.id}`.slice(0, 160), offer: offer.id, kind: offer.kind, region: offer.region, portId: offer.portId, portName: offer.portName,
      title: offer.title, words: offer.words, pay: offer.pay, standing: offer.standing, until: minutes() + offer.days * MINUTES_PER_DAY,
      need: offer.need, done: 0, seen: [], quarry: offer.quarry ? { ...offer.quarry, actorId: null } : null,
      wreck: offer.wreck ? { ...offer.wreck } : null, status: 'open' };
    a.contracts.push(c);
    ctx.afterCommit(() => ctx.notify(p, { kind: 'admiralty.news', text: `Taken: ${c.title}.` }));
    sendLater(p, true);
    return { contractId: c.id };
  });

  ctx.onAction('admiralty.abandon', (p, args) => {
    const id = idArg(args.contractId, 'contract');
    const a = decay(p);
    const i = a.contracts.findIndex((c) => c.id === id);
    if (i < 0) throw new Error('You hold no such contract.');
    ctx.dirty(p);
    const [c] = a.contracts.splice(i, 1);
    const lines = [`You give up ${c.title}.`];
    if (c.status === 'open') addStanding(p, a, c.region, STANDING_ABANDONED, lines);
    news(p, lines);
    sendLater(p, true);
  });

  ctx.onAction('admiralty.claim', (p, args) => {
    need(p);
    const id = idArg(args.contractId, 'contract');
    if (!harbourOf(p)) throw new Error('Claim your purse from a harbourmaster, in port.');
    const a = decay(p);
    const i = a.contracts.findIndex((c) => c.id === id);
    if (i < 0) throw new Error('You hold no such contract.');
    const c = a.contracts[i];
    if (c.status !== 'done') throw new Error(c.status === 'void' ? 'There is nothing to claim: give it up instead.' : 'That contract is not finished.');
    ctx.dirty(p);
    if (!receipt(a, `paid:${c.id}`)) throw new Error('That purse has already been paid.');
    a.contracts.splice(i, 1);
    if (typeof S.addGold === 'function') S.addGold(p, c.pay);
    else p.rpg.gold = clamp(int(p.rpg.gold) + c.pay, 0, 1e9);
    const lines = [`${c.portName || c.region}'s harbourmaster pays you ${c.pay} gold for ${c.title}.`];
    addStanding(p, a, c.region, c.standing, lines);
    a.log.contracts[c.kind]++;
    a.log.earned = clamp(a.log.earned + c.pay, 0, 1e9);
    news(p, lines);
    sendLater(p, true);
    return { paid: c.pay };
  });

  /**
   * The spyglass: hold it on a ship. The first look starts the hold; looks after GLASS_STUDY_S (colours, far) and
   * GLASS_STUDY_NEAR_S (studied, near) on the same ship raise knowledge. The server keeps the hold time, so a client
   * cannot study faster than it can look. Studied ships count once for surveys in their waters, never ones fired on.
   */
  ctx.onAction('admiralty.glass', (p, args) => {
    const targetId = idArg(args.targetId, 'ship');
    const v = vesselOf(p);
    if (!v || !Number.isFinite(v.x)) throw new Error('Raise your glass from a ship\'s deck.');
    let views = [];
    try { views = S.naval?.nearbyFor?.(v, GLASS_FAR_M) ?? []; } catch { views = []; }
    const t = views.find((s) => s && String(s.id) === targetId);
    if (!t || !Number.isFinite(t.x)) throw new Error('No ship lies in your glass there.');
    const d = Math.hypot(t.x - v.x, t.z - v.z);
    if (d > GLASS_FAR_M) throw new Error('She is too far for the glass.');
    const uid = uidOf(t);
    const now = ctx.now();
    const g = glass.get(p.id);
    const held = g && g.targetId === targetId ? (now - g.since) / 1000 : 0;
    if (!g || g.targetId !== targetId) {
      const prev = g;
      glass.set(p.id, { targetId, since: now });
      ctx.onRollback?.(() => { if (prev) glass.set(p.id, prev); else glass.delete(p.id); });
    }
    const k = known.get(p.id) ?? new Map();
    const before = k.get(uid) ?? KNOW.hull;
    const after = knowledgeOf(before, { dist: d, held, struck: t.state === 'struck' || t.state === 'prize' });
    if (after !== before) {
      k.set(uid, after);
      if (k.size > 256) k.delete(k.keys().next().value);
      known.set(p.id, k);
      ctx.onRollback?.(() => k.set(uid, before));
    }
    const a = decay(p);
    const lines = [];
    if (after === KNOW.studied && npcTarget(t) && !a.receipts.includes(`fire:${uid}`)) {
      const region = regionAt(t.x, t.z);
      for (const c of a.contracts) {
        if (c.kind !== 'survey' || c.status !== 'open' || c.region !== region || c.seen.includes(uid)) continue;
        ctx.dirty(p);
        c.seen.push(uid);
        if (c.seen.length > SEEN_MAX) c.seen.splice(0, c.seen.length - SEEN_MAX);
        c.done = Math.min(c.need, c.done + 1);
        if (c.done >= c.need) { c.status = 'done'; lines.push(`${c.title}: done. Claim your purse at any harbour.`); }
        else lines.push(`${c.title}: ${c.done} of ${c.need} studied.`);
        sendLater(p);
      }
    }
    news(p, lines);
    const card = glassCard(p, t, after, d);
    ctx.afterCommit(() => ctx.notify(p, { kind: 'admiralty.glass', silent: true, ...card, held: Math.round(held * 10) / 10 }));
    return card;
  });

  function glassCard(p, t, k, d) {
    const hullWord = { boat: 'boat', sloop: 'sloop', small: 'two-master', galleon: 'two-master', galley: 'galley', large: 'galleon', carrack: 'carrack' }[t.hull] ?? 'ship';
    const card = { targetId: String(t.id), know: k, distance: Math.round(d), hull: hullWord, speed: Number.isFinite(t.speed) ? Math.round(t.speed * 10) / 10 : null };
    if (k >= KNOW.colours) {
      Object.assign(card, { faction: t.faction ?? null, title: t.title ?? null, classId: t.classId ?? null, colours: t.colours ?? null, stance: stanceFor(p, t) });
    }
    if (k >= KNOW.studied) {
      const bounty = state(p).contracts.find((c) => c.kind === 'bounty' && c.status === 'open' && isQuarry(t, c));
      Object.assign(card, { hullHp: t.hullHp ?? null, maxHull: t.maxHull ?? null, sailHp: t.sailHp ?? null, maxSail: t.maxSail ?? null,
        crew: t.crew ?? null, maxCrew: t.maxCrew ?? null, state: t.state ?? null, bounty: bounty ? { title: bounty.title, pay: bounty.pay } : null });
    }
    return card;
  }

  // ------------------------------------------------------------------ quarry, expiry

  /**
   * Puts a bounty's quarry to sea when a holder's ship nears her waters: one actor per notice, shared by every holder,
   * put back after naval despawned her (nobody near) or the server restarted. Never once she is ended or going down.
   */
  function ensureQuarry(c, v) {
    if (!c.quarry || c.status !== 'open' || quarries.get(c.offer)?.ended) return null;
    if (!v || !Number.isFinite(v.x) || Math.hypot(v.x - c.quarry.x, v.z - c.quarry.z) > QUARRY_SPAWN_M) return null;
    const classId = QUARRY_CLASS[c.quarry.hull] ?? QUARRY_CLASS.small;
    if (typeof S.naval?.spawnQuarry === 'function') {
      // naval's own: idempotent per key, never despawned by distance, null once she has gone down; ends carry target.quarry.
      let id = null;
      try { id = S.naval.spawnQuarry({ key: c.offer, classId, x: c.quarry.x, z: c.quarry.z, name: `the ${c.quarry.name}` }); } catch (err) { log.warn?.('[admiralty] spawnQuarry failed:', err?.message ?? err); }
      if (typeof id === 'string') { quarryActor.set(c.offer, id); actorQuarry.set(id, c.offer); }
      return typeof id === 'string' ? id : null;
    }
    if (typeof S.naval?.spawn !== 'function') return null;
    const known = quarryActor.get(c.offer);
    const rec = known ? S.naval.record?.(known) : null;
    if (rec && rec.quarry === c.offer) return known; // afloat, struck or going down: the event settles her
    if (known) { quarryActor.delete(c.offer); actorQuarry.delete(known); }
    let id = null;
    try {
      id = S.naval.spawn(classId, c.quarry.x, c.quarry.z, hash(c.offer) % 628 / 100,
        { quarry: c.offer, title: `the ${c.quarry.name}` });
    } catch (err) { log.warn?.('[admiralty] quarry spawn failed:', err?.message ?? err); }
    if (typeof id !== 'string') return null;
    quarryActor.set(c.offer, id);
    actorQuarry.set(id, c.offer);
    return id;
  }

  /** The ship a player is aboard (sailing core's `aboard`), else the one sailing names for them. */
  function aboardOf(p) {
    try { return typeof S.sailing?.aboard === 'function' ? S.sailing.aboard(p) ?? null : vesselOf(p); } catch { return null; }
  }
  /** Contracts whose casks a deck shows: the player's own, and the captain's of the ship they stand on. */
  function shownContracts(p, v) {
    const own = state(p).contracts.map((c) => ({ c, mine: true }));
    const owner = v?.ownerId != null && v.ownerId !== p.id ? ctx.players?.get?.(v.ownerId) : null;
    return owner?.rpg ? own.concat(state(owner).contracts.map((c) => ({ c, mine: false }))) : own;
  }

  /** The sea about a player's ship: casks within SEA_SHOW_M, and the sites of their contracts (for the chart). */
  function seaView(p) {
    const v = aboardOf(p);
    const casks = [];
    const sites = [];
    const at = v && Number.isFinite(v.x) ? v : null;
    const near = (x, z) => at && Math.hypot(x - at.x, z - at.z) <= SEA_SHOW_M;
    const reach = (x, z) => !!at && Math.hypot(x - at.x, z - at.z) <= HAUL_M;
    for (const { c, mine } of shownContracts(p, v)) {
      if (c.status !== 'open') continue;
      if (mine && c.quarry) sites.push({ id: c.id, kind: 'bounty', x: c.quarry.x, z: c.quarry.z, name: c.quarry.name, radius: QUARRY_REACH_M,
        shipId: quarryActor.get(c.offer) ?? null });
      if (c.wreck) {
        if (mine) sites.push({ id: c.id, kind: 'salvage', x: c.wreck.x, z: c.wreck.z, name: c.wreck.name, radius: CASK_SPREAD[1] });
        for (const k of casksOf(c)) if (!c.seen.includes(k.id) && near(k.x, k.z)) casks.push({ ...k, kind: 'salvage', label: `Cask from the ${c.wreck.name}`, haul: mine && reach(k.x, k.z) });
      }
    }
    for (const f of flotsam.values()) if (near(f.x, f.z)) casks.push({ id: f.id, x: f.x, z: f.z, kind: 'wreck', label: `${f.qty} × ${GOODS[f.good].label} (${f.from})`, haul: reach(f.x, f.z) });
    return { kind: 'admiralty.sea', silent: true, vesselId: v?.id ?? null, reach: HAUL_M, maxSpeed: HAUL_SPEED, casks, sites };
  }
  function sendSea(p, force = false) {
    const ev = seaView(p);
    const json = JSON.stringify(ev);
    if (!force && lastSea.get(p.id) === json) return;
    lastSea.set(p.id, json);
    ctx.notify(p, ev);
  }

  /**
   * Haul a cask aboard: from the deck of a ship the player commands, within HAUL_M, hove to (at most HAUL_SPEED).
   * A salvage cask counts for the holder's own contract; a wreck's cask of goods goes into the ship's hold through the
   * shipyard (its owner's hold: only the owner hauls). Both once - a hauled cask is gone for everybody.
   */
  ctx.onAction('admiralty.haul', (p, args) => {
    need(p);
    const caskId = idArg(args.caskId, 'cask');
    const v = aboardOf(p);
    if (!v || !Number.isFinite(v.x)) throw new Error('Haul casks from your ship\'s deck.');
    if (typeof S.sailing?.canCommand === 'function' && !S.sailing.canCommand(p, v)) throw new Error('Only the captain can order a cask hauled aboard.');
    if (Math.abs(Number(v.speed) || 0) > HAUL_SPEED) throw new Error('Heave to first: she is moving too fast to haul a cask.');
    const a = decay(p);
    const lines = [];
    if (caskId.startsWith('s:')) {
      const c = a.contracts.find((x) => x.kind === 'salvage' && x.status === 'open' && casksOf(x).some((k) => k.id === caskId));
      if (!c) throw new Error('That cask is not one of your salvage.');
      if (c.seen.includes(caskId)) throw new Error('That cask is already aboard.');
      const k = casksOf(c).find((x) => x.id === caskId);
      if (Math.hypot(k.x - v.x, k.z - v.z) > HAUL_M) throw new Error('The cask is out of reach of your boathook.');
      ctx.dirty(p);
      c.seen.push(caskId);
      c.done = Math.min(c.need, c.done + 1);
      a.log.hauled++;
      if (c.done >= c.need) { c.status = 'done'; lines.push(`${c.title}: every cask raised. Claim your purse at any harbour.`); }
      else lines.push(`A cask from the ${c.wreck.name} is hauled aboard (${c.done} of ${c.need}).`);
    } else {
      const f = flotsam.get(caskId);
      if (!f || f.until <= minutes()) throw new Error('That cask has drifted away.');
      if (Math.hypot(f.x - v.x, f.z - v.z) > HAUL_M) throw new Error('The cask is out of reach of your boathook.');
      const ship = S.shipyard?.shipOfVessel?.(v);
      if (!ship || typeof S.shipyard?.addCargo !== 'function') throw new Error('This ship has no hold to stow cargo in.');
      if (ship.player !== p) throw new Error('Only her owner can stow cargo in this ship\'s hold.');
      ctx.dirty(p);
      const got = S.shipyard.addCargo(p, ship.shipId, [{ good: f.good, qty: f.qty }]);
      if (!(got?.loaded > 0)) throw new Error('Your hold is full.');
      const prev = { ...f };
      f.qty -= got.loaded;
      ctx.onRollback?.(() => flotsam.set(caskId, prev));
      if (f.qty > 0) ctx.dirtyWorld(`admiralty:flotsam:${caskId}`, { x: f.x, z: f.z, good: f.good, qty: f.qty, until: f.until, from: f.from });
      else { flotsam.delete(caskId); ctx.dirtyWorld(`admiralty:flotsam:${caskId}`, null); }
      a.log.hauled++;
      lines.push(`Hauled aboard: ${got.loaded} × ${GOODS[f.good].label}${f.qty > 0 ? ` (${f.qty} left: your hold is full)` : ''}.`);
    }
    news(p, lines);
    sendLater(p);
    ctx.afterCommit(() => { for (const q of ctx.players?.values?.() ?? []) if (q?.rpg) sendSea(q); });
    return { ok: true };
  });

  function seaTick() {
    const now = minutes();
    for (const [id, f] of flotsam) if (f.until <= now) { flotsam.delete(id); ctx.dirtyWorld(`admiralty:flotsam:${id}`, null); }
    for (const p of ctx.players?.values?.() ?? []) {
      if (!p?.rpg) continue;
      const v = aboardOf(p);
      if (v) for (const c of state(p).contracts) if (c.kind === 'bounty') ensureQuarry(c, v);
      sendSea(p);
    }
  }

  function sweep(p) {
    const a = decay(p);
    const now = minutes();
    const lines = [];
    let changed = false;
    for (let i = a.contracts.length - 1; i >= 0; i--) {
      const c = a.contracts[i];
      if (c.kind === 'bounty' && c.status === 'open' && quarries.get(c.offer)?.ended && quarries.get(c.offer).by !== p.id) {
        c.status = 'void'; changed = true; lines.push(`The ${c.quarry?.name ?? 'quarry'} was ended by another captain; your bounty is void.`);
      }
      if (c.status === 'open' && now >= c.until) {
        a.contracts.splice(i, 1);
        addStanding(p, a, c.region, STANDING_FAILED, lines);
        a.log.failed++;
        lines.unshift(`${c.title}: time is up. The contract has failed.`);
        changed = true;
      }
    }
    if (changed) { p.dirty = true; for (const l of lines) ctx.notify(p, { kind: 'admiralty.news', text: l }); }
    return changed;
  }

  ctx.onJoin((p) => { state(p); decay(p); try { sweep(p); } catch (err) { log.error?.('[admiralty] join sweep failed:', err); } send(p, true); });
  ctx.onLeave?.((p) => { glass.delete(p.id); known.delete(p.id); lastSent.delete(p.id); lastTick.delete(p.id); lastSea.delete(p.id); });
  let lastSeaTick = -Infinity;
  ctx.onTick((dt, now) => {
    if (now - lastSeaTick >= (options.seaMs ?? 1000)) {
      lastSeaTick = now;
      try { seaTick(); } catch (err) { log.error?.('[admiralty] sea tick failed:', err); }
    }
    for (const p of ctx.players?.values?.() ?? []) {
      if (!p?.rpg) continue;
      if (now - (lastTick.get(p.id) ?? -Infinity) < (options.sweepMs ?? 5000)) continue;
      lastTick.set(p.id, now);
      try { sweep(p); send(p); } catch (err) { log.error?.('[admiralty] sweep failed:', err); }
    }
  });

  // ------------------------------------------------------------------ services

  /** Whether a naval actor fights the captain on sight. Navy: notoriety >= NAVY_HUNTS in her waters, or a piracy warrant there. */
  function hostileTo(p, actor) {
    if (!p?.rpg || !isObj(actor)) return false;
    if (actor.faction === 'pirate') return true;
    if (actor.faction !== 'navy') return false;
    const region = actor.region ?? regionAt(actor.x, actor.z);
    if (!region) return false;
    return notoriety(p, region) >= NAVY_HUNTS || S.law?.wanted?.(p, region)?.crime === 'piracy';
  }
  /** 'safe' | 'hostile' colours of a ship as this captain should read them. */
  function stanceFor(p, v) {
    if (!isObj(v)) return 'safe';
    if (v.faction === 'player' || v.kind === 'player') return v.colours === 'hostile' ? 'hostile' : 'safe';
    if (v.state === 'struck' || v.state === 'prize' || v.state === 'wrecked') return 'safe';
    return hostileTo(p, v) ? 'hostile' : 'safe';
  }

  /** naval's question for a navy ship: is this player vessel's captain wanted in the waters she sails? */
  function wanted(v) {
    if (!isObj(v) || !Number.isFinite(v.x)) return false;
    const ids = [v.ownerId, v.helmId].filter((x) => x != null);
    return ids.some((id) => { const p = ctx.players?.get?.(id); return !!p && hostileTo(p, { faction: 'navy', x: v.x, z: v.z }); });
  }

  S.admiralty = S.seaLaw = {
    wanted,
    regionAt, notoriety, standing, rankOf: (p, region) => rankOf(standing(p, region)), perks, hostileTo, stanceFor,
    /** Yard price share off for a rank in the port's region (0 while hunted). */
    yardDiscount: (p, region) => perks(p, region).yard,
    state: (p) => view(p),
    /** The cask and site view a deck shows (also sent as the private admiralty.sea event). */
    sea: (p) => seaView(p),
    /** naval actor id of a bounty's quarry this boot, or null. */
    quarryShip: (offerId) => quarryActor.get(offerId) ?? null,
  };
}

export default install;
