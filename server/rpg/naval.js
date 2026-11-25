// Naval combat: broadsides, shot kinds, hull/sail/crew damage, ramming, NPC merchant/raider/patrol ships, grapple and
// boarding with ordinary combat foes, raid win/retreat, once-only plunder, player wrecks and mutual-consent player
// ship combat. Wire contract: docs/naval-combat.md (events naval.state/shot/hit/ram/news, actions naval.*).
//
// Mechanics adapted from Daggerfall Online (Lattymoy, MIT) — see server/rpg/sailing/combatRules.js for the list.
// The server owns every ball: a volley is launched here, flown in closed form p(t) = p0 + v0 t − ½ g t² each tick,
// tested against every hull and rig box, and its hits are applied and published here. Clients only draw.
//
// Hooks (all optional; the module degrades gracefully):
//   services.sailing  vesselFor(p), vessels(), crewOf(v), canCommand(p,v), save(v), publish(v), ports(), wind(x,z)|
//                     windAt, isWater(x,z), respawn(v,{reason}), stats(v)
//   services.createEnemy / banishMonster (combat) — boarding musters are ordinary melee foes on the boarder's deck
//   services.spawnLoot (inventory) — a prize's hold is spilled once as a loot pile at the plunderer's feet
//   services.seaLaw / reportCrime (law) — piracy on a first strike against a lawful ship
//
// Persistence: a player vessel's combat state lives in `vessel.naval` (and mirrors `hullHp`/`sailHp` when the vessel
// carries them) and is saved through services.sailing.save(v). Inside actions every mutation is undone on rollback.
import {
  GUNS, SHOT_ORDER, SIDES, BARREL, BALL_LIFE, RIPPLE_S, SHOT_SWITCH, LOAD_GROUPS, loadGroupOf, loadOf, shotId, naturalShot,
  shotGun, shotFireChance, shotRigFire, shotReach, reloadSeconds, mulberry32, shotPosition, elevationForRange, maxRange,
  launchVelocity, scatter, HULL_BUILDS, HULL_NAMES, PLAYER_HULL, batteriesOf, FACTIONS, SHIP_CLASSES, classById, pickClass,
  STRUCK_AT, SINK_SECONDS, WATERLINE_BAND, FIRE_HP, FIRE_SECONDS, FIRE_STACK, FIRE_SAIL, FIRE_CREW_S, BRACE_TAKEN,
  SHIP_TOUGHNESS, PLAYER_CREW_TOUGHNESS, hitZone, shotDamage, wayShare as canvasWay, ramBlow, recoilShare, RAM_REACH,
  RAM_COOLDOWN_S, RAM_A_MAN, ballMen, BOARD_RANGE, ABANDON_RANGE, musterOf, repelPartyOf, boardingWon, holdKeys,
  seaPrizePlaces, ENGAGE_RANGE, DISENGAGE, FLEE_RANGE, CHASE_GIVE_UP_S, BEAR_DEG, BOW_BEAR, LAY_ERR, SPAWN_CLEAR,
  DESPAWN_BEYOND, FIRST_ROLL_S, SHIP_SPAWN_CHANCE, PORT_PIRATE_K, pointOfSail, windShare, wrap, fwd, toWorld, toLocal,
  dirToWorld, bearingOf, sideForBearing, segmentBox, hullBox, rigBox, clamp, G, WITNESS_RANGE,
} from './sailing/combatRules.js';
import { generateRandomLoot } from './items/loot.js';
import { GOODS } from './sailing/yardTrade.js';
import { MAX_STORED_ITEMS as MAX_HOLD } from '../../client/gameplay/property/rules.js';

export const name = 'naval';
const HOLD_PREFIX = 'naval:hold:';
const ESCROW_PREFIX = 'naval:escrow:';

const DEG = Math.PI / 180;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const fail = (m) => { throw new Error(m); };

/** Defaults; tests and operators may override through `install(ctx, opts)`. */
export const NAVAL_DEFAULTS = Object.freeze({
  viewM: 1500, // contacts and shots are published to crews within this
  safePortM: 600, // no player-vs-player fire inside this of a port; pirates do not engage inside it either
  stateHz: 2,
  spawn: true, // the director places NPC ships around vessels at sea
  maxNear: 3, // most NPC ships within DESPAWN_BEYOND of one vessel
  rollS: FIRST_ROLL_S,
  spawnChance: SHIP_SPAWN_CHANCE,
  sinkS: SINK_SECONDS,
  wreckPrizeS: 600, // how long a wreck's hold may be taken by her killer
  scuttleS: 30, // a plundered prize goes down after this
  saveEveryS: 5,
  shotStock: 60, // shot carried by a vessel that has no shipyard stores (economy owns `stores.shot` when present)
  shotPrice: 6,
  seed: 0x5ea,
});

export function install(ctx, opts = {}) {
  const cfg = { ...NAVAL_DEFAULTS, ...(ctx.config?.naval ?? {}), ...opts };
  const S = ctx.services;
  const log = ctx.log ?? console;
  const sail = () => S.sailing ?? null;
  const nowS = () => ctx.now() / 1000;
  const rng = mulberry32(cfg.seed >>> 0);

  /** id -> ship record (npc and player). Player records are rebuilt from vessels every tick. */
  const ships = new Map();
  /** live balls and barrels */
  let balls = [];
  let ballSeq = 1, volleySeq = 1, npcSeq = 1;
  const ramClock = new Map(); // `${a}|${b}` -> last ram second
  const wrecks = new Map(); // vessel id -> {v, wreck} while her killer may still haul up her hold
  const quarries = new Map(); // bounty key -> {id} live, or {sunk:true}
  const holdSnapshots = new Map(); // vessel id -> {ownerId, vesselId, shipId, goodsOnly, goods, items, at}
  const escrows = new Map(); // prize id -> {id, ownerId, vesselId, shipId, victorId, victorName, vesselName, goodsOnly, goods, items, createdAt}
  for (const [key, val] of ctx.loadWorld?.(HOLD_PREFIX) ?? []) {
    if (val && typeof val === 'object' && typeof val.vesselId === 'string') holdSnapshots.set(key.slice(HOLD_PREFIX.length), val);
  }
  for (const [key, val] of ctx.loadWorld?.(ESCROW_PREFIX) ?? []) {
    if (val && typeof val === 'object' && typeof val.id === 'string' && Number.isSafeInteger(val.ownerId)) escrows.set(key.slice(ESCROW_PREFIX.length), val);
  }
  /** The online player who commands a player ship: her owner when aboard, else her helmsman. */
  const captainOf = (rec) => {
    if (!isPlayer(rec)) return null;
    const crew = crewOf(rec.v);
    return crew.find((q) => q.id === rec.v.ownerId) ?? crew.find((q) => q.id === rec.v.helmId) ?? null;
  };
  const rollAt = new Map(); // vessel id -> next director roll (s)
  const lastState = new Map(); // player id -> last naval.state key
  const dirtyVessels = new Set();
  let lastSave = 0, stateAcc = 0;

  // ------------------------------------------------------------------ helpers: vessels and players

  const vessels = () => { try { return [...(sail()?.vessels?.() ?? [])]; } catch (err) { log.error?.('[naval] vessels() failed', err); return []; } };
  const crewOf = (v) => { try { return [...(sail()?.crewOf?.(v) ?? [])].filter((p) => p && ctx.players.get(p.id) === p); } catch { return []; } };
  const vesselFor = (p) => { try { return sail()?.vesselFor?.(p) ?? null; } catch { return null; } };
  /** The vessel `p` stands aboard (presence on her deck), never the one an owner has left in port. */
  const aboardOf = (p) => { try { const s = sail(); return typeof s?.aboard === 'function' ? s.aboard(p) ?? null : s?.vesselFor?.(p) ?? null; } catch { return null; } };
  const canCommand = (p, v) => { try { return sail()?.canCommand ? !!sail().canCommand(p, v) : v?.ownerId === p.id; } catch { return false; } };
  const ports = () => { try { return [...(sail()?.ports?.() ?? [])].filter((q) => Number.isFinite(q?.x) && Number.isFinite(q?.z)); } catch { return []; } };
  /** true / false, or null while the chart is still loading (or there is none). */
  const waterAt = (x, z) => {
    const s = sail();
    try {
      // sailing.isWater first (null while the chart loads, and it starts the load); services.coast is the same chart
      const f = typeof s?.isWater === 'function' ? s.isWater : typeof S.coast?.isWater === 'function' ? S.coast.isWater : null;
      if (!f) return null;
      const r = f(x, z);
      return r == null ? null : !!r;
    } catch { return null; }
  };
  /** Is there any chart service at all? (none: the sea is open everywhere, as in isolated tests) */
  const hasChart = () => typeof sail()?.isWater === 'function' || typeof S.coast?.isWater === 'function';
  /** A captain steers as if open water where the chart says nothing. */
  const isWater = (x, z) => waterAt(x, z) !== false;
  /** Ships are only ever placed where the chart says water. */
  const surelyWater = (x, z) => (waterAt(x, z) ?? (cfg.assumeWater === true ? true : false)) === true;
  /** Wind as {from (yaw rad), speed m/s}. */
  const windAt = (x, z) => {
    const s = sail();
    try {
      const w = typeof s?.wind === 'function' ? s.wind(x, z) : typeof s?.windAt === 'function' ? s.windAt(x, z) : s?.wind;
      if (w && Number.isFinite(w.from) && Number.isFinite(w.speed)) return w;
    } catch { /* fall through */ }
    return { from: -Math.PI / 4, speed: 6 };
  };
  const ownerOnline = (v) => (v?.ownerId != null ? ctx.players.get(v.ownerId) ?? null : null);
  const playerName = (id) => ctx.players.get(id)?.name ?? 'a captain';
  const levelOf = (p) => Math.max(1, Number(p?.rpg?.character?.level) || 1);

  /** True near a port (or berthed): no player-vs-player fire, no pirate engagement. */
  function inSafeHarbour(rec) {
    if (rec.kind === 'player' && (rec.v.docked || rec.v.atPort)) return true;
    for (const q of ports()) if (Math.hypot(q.x - rec.x, q.z - rec.z) <= cfg.safePortM) return true;
    return false;
  }
  const nearestPort = (x, z) => {
    let best = null, bd = Infinity;
    for (const q of ports()) { const d = Math.hypot(q.x - x, q.z - z); if (d < bd) { bd = d; best = q; } }
    return best ? { port: best, d: bd } : null;
  };

  // ------------------------------------------------------------------ records

  function blankDamage(maxHull, maxSail, maxCrew) {
    return { hull: maxHull, maxHull, sail: maxSail, maxSail, crew: maxCrew, maxCrew, fires: [], crewBurn: 0, state: 'afloat', sinkT: 0, lastHitAt: -1e9 };
  }
  function blankDeck(hull) {
    return { clocks: { starboard: 0, port: 0, bow: 0, stern: 0 }, len: { starboard: 1, port: 1, bow: 1, stern: 1 }, loads: { broadside: null, bow: null, stern: null }, braced: false, barrels: HULL_BUILDS[hull]?.stern?.gun === 'barrel' ? BARREL.stock : 0 };
  }

  /**
   * The shipyard record behind a vessel (server/rpg/shipyard.js): {player, shipId, ship} or null. Its stores.shot is
   * the ammunition, its crew list the hands that fall, its sailHp the canvas; hull damage is mirrored into its hullHp.
   */
  function yardOf(v) {
    try {
      const l = S.shipyard?.shipOfVessel?.(v);
      if (!l) return null;
      const ship = S.shipyard.ship?.(l.player, l.shipId);
      return ship ? { player: l.player, shipId: l.shipId, ship } : null;
    } catch { return null; }
  }

  /** Player vessel maxima: the shipyard's stats when published, else the reference build. */
  function vesselStats(v) {
    let st = null;
    try { st = sail()?.stats?.(v) ?? S.shipyard?.statsOf?.(v) ?? null; } catch { st = null; }
    const hullId = typeof v.hullClass === 'string' ? v.hullClass : v.type;
    const hull = PLAYER_HULL[hullId] ?? PLAYER_HULL[v.type] ?? 2;
    const b = HULL_BUILDS[hull];
    const guns = Number.isFinite(st?.guns) ? Math.floor(st.guns / 2) : null;
    const yard = yardOf(v);
    const handCount = yard ? yard.ship.crew?.length ?? 0 : Array.isArray(v.crew) ? v.crew.length : null;
    // the sailing core's hull {hp, max} is canonical for hull points (grounding harms it too)
    const coreMax = Number.isFinite(v.hull?.max) ? v.hull.max : null;
    return {
      hull,
      yard,
      maxHull: Math.max(1, Math.round(coreMax ?? st?.hullMax ?? b.hullHp)),
      maxSail: Math.max(0, Math.round(st?.sailMax ?? b.sailHp)),
      maxCrew: Math.max(0, Math.round(st?.crewMax ?? handCount ?? b.crew)),
      broadsideGuns: guns,
      handCount,
    };
  }

  /** The naval sub-state of a player vessel, created and normalised in place. */
  function navalOf(v) {
    const st = vesselStats(v);
    let n = v.naval;
    if (!n || typeof n !== 'object') {
      n = v.naval = { version: 1 };
    }
    if (!n.d || typeof n.d !== 'object') {
      n.d = blankDamage(st.maxHull, st.maxSail, st.maxCrew);
      if (Number.isFinite(v.hull?.hp)) n.d.hull = clamp(v.hull.hp, 0, st.maxHull);
    }
    const d = n.d;
    d.maxHull = st.maxHull; d.maxSail = st.maxSail; d.maxCrew = st.maxCrew;
    // a yard repair, grounding or any outside change to the canonical hull is adopted
    if (Number.isFinite(v.hull?.hp) && v.hull.hp !== n.mirrorHull) d.hull = clamp(v.hull.hp, 0, st.maxHull);
    if (Number.isFinite(v.sailHp) && v.sailHp !== n.mirrorSail) d.sail = clamp(v.sailHp, 0, st.maxSail);
    if (st.yard && Number.isFinite(st.yard.ship.sailHp) && st.yard.ship.sailHp !== n.mirrorSail) { d.sail = clamp(st.yard.ship.sailHp, 0, st.maxSail); n.mirrorSail = st.yard.ship.sailHp; }
    // relaunched after a wreck: she floats again on whatever the yard left her
    if (d.state === 'wrecked' && !v.sunk) { d.state = 'afloat'; d.sinkT = 0; d.fires = []; }
    if (st.handCount != null) d.crew = Math.min(st.handCount, st.maxCrew);
    d.hull = clamp(Number(d.hull) || 0, 0, d.maxHull);
    d.sail = clamp(Number(d.sail) || 0, 0, d.maxSail);
    d.crew = clamp(Math.round(Number(d.crew) || 0), 0, d.maxCrew);
    if (!Array.isArray(d.fires)) d.fires = [];
    if (!['afloat', 'struck', 'sinking', 'wrecked'].includes(d.state)) d.state = 'afloat';
    if (!n.deck || typeof n.deck !== 'object') n.deck = blankDeck(st.hull);
    for (const k of SIDES) { if (!Number.isFinite(n.deck.clocks?.[k])) (n.deck.clocks ??= {})[k] = 0; if (!Number.isFinite(n.deck.len?.[k])) (n.deck.len ??= {})[k] = 1; }
    n.deck.loads ??= { broadside: null, bow: null, stern: null };
    if (!Number.isFinite(n.deck.barrels)) n.deck.barrels = HULL_BUILDS[st.hull]?.stern?.gun === 'barrel' ? BARREL.stock : 0;
    n.colours = n.colours === 'hostile' ? 'hostile' : 'peace';
    if (!st.yard && (!v.stores || typeof v.stores !== 'object' || !Number.isFinite(v.stores.shot))) {
      if (!Number.isFinite(n.shot)) n.shot = cfg.shotStock;
    }
    return { n, st };
  }
  const mirror = (v) => {
    const n = v.naval;
    if (!n?.d) return;
    if (v.hull && typeof v.hull === 'object') { v.hull.hp = Math.max(0, Math.round(n.d.hull)); n.mirrorHull = v.hull.hp; }
    else { v.hull = { hp: Math.max(0, Math.round(n.d.hull)), max: n.d.maxHull }; n.mirrorHull = v.hull.hp; }
    if ('sailHp' in v) { v.sailHp = Math.round(n.d.sail); n.mirrorSail = v.sailHp; }
  };
  const shotLeft = (rec) => {
    if (rec.kind === 'npc') return Infinity;
    const y = yardOf(rec.v);
    if (y) return Math.max(0, y.ship.stores?.shot | 0);
    return Number.isFinite(rec.v.stores?.shot) ? rec.v.stores.shot : rec.v.naval.shot ?? 0;
  };
  function spendShot(rec, n) {
    if (rec.kind === 'npc') return;
    const y = yardOf(rec.v);
    if (y) { const got = S.shipyard.spend(y.player, y.shipId, { shot: n }); if ((got?.shot ?? 0) < n) fail('The shot locker is empty.'); return; }
    if (Number.isFinite(rec.v.stores?.shot)) rec.v.stores.shot = Math.max(0, rec.v.stores.shot - n);
    else rec.v.naval.shot = Math.max(0, (rec.v.naval.shot ?? 0) - n);
  }

  /** Brings player records in line with the sailing core's live vessels. */
  function syncPlayers() {
    const seen = new Set();
    for (const v of vessels()) {
      if (!v || v.id == null || v.sunk) continue;
      const id = String(v.id);
      if (v.docked && !ships.has(id)) continue; // berthed and never at sea this session: nothing to simulate
      seen.add(id);
      let rec = ships.get(id);
      const { n, st } = navalOf(v);
      if (!rec) {
        rec = { id, kind: 'player', v, hull: st.hull, faction: 'player', title: v.name || 'Ship', seed: hashStr(id) };
        ships.set(id, rec);
      }
      rec.v = v;
      rec.hull = st.hull;
      rec.broadsideGuns = st.broadsideGuns;
      rec.d = n.d;
      rec.deck = n.deck;
      rec.x = Number(v.x) || 0; rec.z = Number(v.z) || 0; rec.yaw = Number(v.yaw) || 0; rec.speed = Number(v.speed) || 0;
      rec.ownerId = v.ownerId ?? null;
      rec.title = v.name || rec.title;
      rec.colours = n.colours;
    }
    for (const [id, rec] of ships) if (rec.kind === 'player' && !seen.has(id)) ships.delete(id);
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  /** Records an undo for a ship record (and its vessel's naval state) while an action runs. */
  function guard(rec) {
    if (!ctx.inAction() || !rec) return;
    if (rec.kind === 'player') {
      const v = rec.v;
      try { sail()?.touch?.(v); } catch { /* our own snapshot below still restores the naval fields */ }
      const keep = { naval: structuredClone(v.naval), hull: structuredClone(v.hull), sailHp: v.sailHp, speed: v.speed, crew: Array.isArray(v.crew) ? [...v.crew] : v.crew, shot: v.stores?.shot, anchored: v.anchored, had: { sailHp: 'sailHp' in v } };
      ctx.onRollback(() => {
        v.naval = keep.naval;
        v.hull = keep.hull;
        v.anchored = keep.anchored;
        if (keep.had.sailHp) v.sailHp = keep.sailHp; else delete v.sailHp;
        v.speed = keep.speed;
        if (Array.isArray(keep.crew)) v.crew = keep.crew;
        if (v.stores && keep.shot !== undefined) v.stores.shot = keep.shot;
        rec.d = v.naval?.d; rec.deck = v.naval?.deck; rec.colours = v.naval?.colours;
      });
      try { sail()?.save?.(v); } catch (err) { throw err; }
    } else {
      const keep = structuredClone({ d: rec.d, deck: rec.deck, colours: rec.colours, grappledTo: rec.grappledTo, boarding: rec.boarding, plundered: rec.plundered, provoked: rec.provoked, ai: rec.ai, scuttleAt: rec.scuttleAt });
      const present = ships.get(rec.id) === rec;
      ctx.onRollback(() => {
        Object.assign(rec, structuredClone(keep));
        if (present) ships.set(rec.id, rec);
      });
    }
  }
  function guardBalls() {
    if (!ctx.inAction()) return;
    const keep = balls.slice();
    ctx.onRollback(() => { balls = keep; });
  }
  function markDirty(rec) {
    if (rec?.kind !== 'player') return;
    mirror(rec.v);
    if (ctx.inAction()) { try { sail()?.save?.(rec.v); } catch (err) { throw err; } }
    else dirtyVessels.add(rec.v);
  }
  function flushSaves(force = false) {
    const t = nowS();
    if (!force && t - lastSave < cfg.saveEveryS) return;
    lastSave = t;
    for (const v of dirtyVessels) {
      try { sail()?.save?.(v); } catch (err) { log.error?.('[naval] vessel save failed', err); continue; }
      dirtyVessels.delete(v);
    }
  }

  // ------------------------------------------------------------------ public views

  const maxima = (rec) => ({ hullHp: Math.round(rec.d.hull), maxHull: rec.d.maxHull, sailHp: Math.round(rec.d.sail), maxSail: rec.d.maxSail, crew: rec.d.crew, maxCrew: rec.d.maxCrew });
  function shipView(rec) {
    if (!rec) return null;
    const cls = rec.kind === 'npc' ? classById(rec.classId) : null;
    const view = {
      id: rec.id, uid: rec.uid ?? (rec.kind === 'player' ? `${rec.id}@${rec.v?.launchedAt ?? 0}` : rec.id), kind: rec.kind, classId: rec.classId ?? (rec.kind === 'player' ? `player:${rec.v.type}` : null),
      title: rec.title, faction: rec.faction, hull: HULL_NAMES[rec.hull] ?? 'galleon', type: rec.kind === 'player' ? rec.v.type : rec.hull >= 3 ? 'large' : 'small',
      x: r2(rec.x), z: r2(rec.z), yaw: r3(rec.yaw), speed: r2(rec.speed),
      ...maxima(rec), state: rec.d.state === 'afloat' && rec.boardedBy ? 'boarded' : rec.d.state, fire: rec.d.fires.length,
      colours: rec.d.state === 'struck' ? 'struck' : rec.kind === 'player' ? rec.colours : (rec.hostileTo?.size || FACTIONS[rec.faction]?.hostile ? 'hostile' : 'peace'),
    };
    if (rec.kind === 'player') { view.ownerId = rec.ownerId; view.name = rec.v.name ?? null; }
    if (cls) view.flagship = cls.flagship;
    if (rec.grappledTo) view.grappledTo = rec.grappledTo;
    if (rec.quarry) view.quarry = rec.quarry;
    if (rec.plundered) view.plundered = true;
    return view;
  }
  function deckView(rec) {
    const bat = batteriesOf(rec.hull, rec.broadsideGuns);
    const ready = {};
    for (const s of SIDES) ready[s] = bat[s] ? r2(rec.deck.clocks[s]) : null;
    const loads = {};
    for (const g of LOAD_GROUPS) {
      const side = g === 'broadside' ? 'starboard' : g;
      loads[g] = bat[side] ? loadOf(bat[side].gun, rec.deck.loads[g]) : null;
    }
    const guns = {};
    for (const s of SIDES) if (bat[s]) guns[s] = { gun: bat[s].gun, count: bat[s].muzzles.length, range: Math.round(rangeFor(rec, s)) };
    return { ready, loads, guns, braced: !!rec.deck.braced, ammo: { shot: Number.isFinite(shotLeft(rec)) ? shotLeft(rec) : null, barrels: rec.deck.barrels } };
  }
  function combatOf(rec) {
    if (!rec) return null;
    const out = { ...shipView(rec), ...deckView(rec), safeHarbour: inSafeHarbour(rec), wayShare: r3(wayFor(rec)) };
    if (rec.boarding) out.boarding = { targetId: rec.boarding.targetId, phase: rec.boarding.phase, foesLeft: rec.boarding.foes.filter((f) => !f.down).length, foesTotal: rec.boarding.foes.length };
    if (rec.repel) out.repel = { byId: rec.repel.byId, foesLeft: rec.repel.foes.filter((f) => !f.down).length, foesTotal: rec.repel.foes.length };
    if (rec.kind === 'player' && rec.v.naval?.wreck) out.wreck = { id: rec.v.naval.wreck.id, at: rec.v.naval.wreck.at };
    return out;
  }
  const ballView = (b) => ({ id: b.id, volleyId: b.volleyId, shooterId: b.shooterId, gun: b.gun, shot: b.shot, p0: b.p0.map(r3), v0: b.v0.map(r3), t0: r3(b.t0), life: b.kind === 'barrel' ? BARREL.life : BALL_LIFE, kind: b.kind });

  // ------------------------------------------------------------------ audience

  /** Online players aboard vessels within `radius` of (x, z). */
  function audience(x, z, radius = cfg.viewM) {
    const out = new Set();
    for (const rec of ships.values()) {
      if (rec.kind !== 'player') continue;
      if (Math.hypot(rec.x - x, rec.z - z) > radius) continue;
      for (const p of crewOf(rec.v)) out.add(p);
    }
    return [...out];
  }
  function tell(players, event) {
    for (const p of players) ctx.notify(p, { silent: true, t: r3(nowS()), ...event });
  }
  function news(x, z, what, rec, text, extra = {}) {
    tell(audience(x, z), { kind: 'naval.news', what, shipId: rec?.id ?? null, text, ...extra });
  }
  const crewNotify = (rec, text) => { if (rec?.kind === 'player') for (const p of crewOf(rec.v)) ctx.notify(p, { kind: 'naval', text }); };

  // ------------------------------------------------------------------ gunnery

  function rangeFor(rec, side) {
    const bat = batteriesOf(rec.hull, rec.broadsideGuns)[side];
    if (!bat || bat.gun === 'barrel') return bat ? 1.5 : 0;
    const gun = shotGun(bat.gun, loadOf(bat.gun, rec.deck.loads[loadGroupOf(side)]));
    const y = bat.muzzles.reduce((n, m) => n + m[1], 0) / bat.muzzles.length;
    return maxRange(gun.speed, y, gun.maxEl * DEG);
  }
  function crewShare(rec) { return rec.d.maxCrew > 0 ? rec.d.crew / rec.d.maxCrew : 1; }
  const crewed = (rec) => rec.d.maxCrew > 0;

  /**
   * Fires one battery. `range` the lay (m out along the fire; default the battery's longest or the target's), `skill`
   * the gun crew's (players 0.5, captains their class's). Returns the volley or throws a readable reason.
   */
  function fireBattery(rec, side, { range = null, target = null, skill = 0.5, firer = null } = {}) {
    if (!SIDES.includes(side)) fail('Which battery? (starboard, port, bow or stern)');
    const bat = batteriesOf(rec.hull, rec.broadsideGuns)[side];
    if (!bat) fail(`She carries no ${side} guns.`);
    if (rec.d.state !== 'afloat') fail(rec.d.state === 'struck' ? 'Your colours are struck.' : 'She is going down.');
    if (rec.deck.braced) fail('The crew are braced; let go to fight the guns.');
    if (rec.deck.clocks[side] > 0) fail(`The ${side} guns are still loading (${Math.ceil(rec.deck.clocks[side])} s).`);
    if (rec.grappledTo && bat.gun !== 'barrel') { /* point blank across the rail is allowed */ }
    const isBarrel = bat.gun === 'barrel';
    if (isBarrel && rec.deck.barrels <= 0) fail('No fire barrels left aboard.');
    const n = bat.muzzles.length;
    if (!isBarrel && shotLeft(rec) < n) fail(shotLeft(rec) > 0 ? `Only ${shotLeft(rec)} shot left; that battery needs ${n}.` : 'The shot locker is empty.');
    guardBalls();
    const t0 = nowS();
    const pose = { x: rec.x, z: rec.z, yaw: rec.yaw };
    const vel = [fwd(rec.yaw)[0] * rec.speed, 0, fwd(rec.yaw)[1] * rec.speed];
    const volleyId = `v${volleySeq++}`;
    const seed = (rng() * 0xffffffff) >>> 0;
    const rand = mulberry32(seed);
    const out = [];
    if (isBarrel) {
      const m = toWorld(pose, bat.muzzles[0]);
      const back = dirToWorld(rec.yaw, [0, 0, -1]);
      const b = { id: `b${ballSeq++}`, volleyId, kind: 'barrel', shooterId: rec.id, firerId: firer?.id ?? null, gun: 'barrel', shot: null, p0: [m[0] + back[0] * 1.5, 0, m[2] + back[2] * 1.5], v0: [0, 0, 0], t0, roll: rand(), hit: new Set() };
      out.push(b);
      rec.deck.barrels -= 1;
    } else {
      const load = loadOf(bat.gun, rec.deck.loads[loadGroupOf(side)]);
      const gun = shotGun(bat.gun, load);
      const dir = dirToWorld(rec.yaw, bat.dir);
      const centre = bat.muzzles.reduce((s, m) => [s[0] + m[0] / n, s[1] + m[1] / n, s[2] + m[2] / n], [0, 0, 0]);
      const cw = toWorld(pose, centre);
      let want = Number.isFinite(range) ? range : null;
      let layY = 0;
      if (want == null && target) {
        want = (target.x - cw[0]) * dir[0] + (target.z - cw[2]) * dir[2];
        layY = Math.max(0, HULL_BUILDS[target.hull]?.deck ?? 0) * 0.4;
      }
      const lo = gun.minEl * DEG, hi = gun.maxEl * DEG;
      const elevation = want == null ? hi * 0.45 + lo * 0.55 + (hi - lo) * 0 : want <= 0 ? lo : elevationForRange(want, gun.speed, cw[1] - layY, lo, hi);
      const k = clamp(1.5 - skill, 0.4, 1.5);
      bat.muzzles.forEach((m, i) => {
        const delay = i * RIPPLE_S;
        const p = toWorld(pose, m);
        const s = scatter(dir, elevation, gun.yawSpread * k, gun.pitchSpread * k, rand);
        out.push({
          id: `b${ballSeq++}`, volleyId, kind: 'ball', shooterId: rec.id, firerId: firer?.id ?? null, gun: bat.gun, shot: gun.shot,
          p0: [p[0] + vel[0] * delay, p[1], p[2] + vel[2] * delay], v0: launchVelocity(s.dir, s.elevation, gun.speed, vel), t0: t0 + delay, roll: rand(), hit: new Set(),
        });
      });
      spendShot(rec, n);
    }
    const len = reloadSeconds(bat.gun, crewShare(rec), crewed(rec) || rec.kind === 'npc', isBarrel ? null : loadOf(bat.gun, rec.deck.loads[loadGroupOf(side)]));
    rec.deck.clocks[side] = len;
    rec.lastFireAt = t0;
    rec.deck.len[side] = len || 1;
    balls.push(...out);
    const ev = { kind: 'naval.shot', volleyId, from: { id: rec.id, kind: rec.kind }, side, gun: bat.gun, shot: out[0]?.shot ?? null, g: G, balls: out.map((b) => ({ id: b.id, p0: b.p0.map(r3), v0: b.v0.map(r3), t0: r3(b.t0), kind: b.kind })) };
    tell(audience(rec.x, rec.z), ev);
    ctx.emit('naval.fire', { player: firer, vessel: rec.kind === 'player' ? rec.v.id : null, ship: shipView(rec), side, volleyId });
    return { volleyId, balls: out.length };
  }

  function setLoad(rec, group, shot) {
    if (!LOAD_GROUPS.includes(group)) fail('Which guns? (broadside, bow or stern)');
    if (!SHOT_ORDER.includes(shot)) fail(`Unknown shot "${shot}". Use round, grape, chain or heated.`);
    const bat = batteriesOf(rec.hull, rec.broadsideGuns);
    const sides = group === 'broadside' ? ['starboard', 'port'] : [group];
    const armed = sides.filter((s) => bat[s] && bat[s].gun !== 'barrel');
    if (!armed.length) fail('Those guns cannot take shot.');
    if (armed.every((s) => loadOf(bat[s].gun, rec.deck.loads[group]) === shot)) return false;
    for (const s of armed) {
      const was = reloadSeconds(bat[s].gun, crewShare(rec), true, loadOf(bat[s].gun, rec.deck.loads[group]));
      const now = reloadSeconds(bat[s].gun, crewShare(rec), true, shot);
      if (rec.deck.clocks[s] > 0) { const k = now / (was || 1); rec.deck.clocks[s] *= k; rec.deck.len[s] *= k; }
      else { rec.deck.clocks[s] = SHOT_SWITCH * now; rec.deck.len[s] = rec.deck.clocks[s] || 1; }
    }
    rec.deck.loads[group] = armed.every((s) => naturalShot(bat[s].gun) === shot) ? null : shot;
    return true;
  }

  // ------------------------------------------------------------------ rules of engagement

  const isPlayer = (rec) => rec?.kind === 'player';
  /** May a shot or ram from `a` harm `b`? */
  function mayHarm(a, b) {
    if (!a || !b || a === b) return false;
    if (b.d.state === 'wrecked') return false;
    if (isPlayer(a) && isPlayer(b)) {
      if (a.ownerId != null && a.ownerId === b.ownerId) return false;
      if (a.colours !== 'hostile' || b.colours !== 'hostile') return false;
      if (inSafeHarbour(a) || inSafeHarbour(b)) return false;
      return true;
    }
    return true;
  }
  function pvpRefusal(a, b) {
    if (!isPlayer(b)) return null;
    if (a.colours !== 'hostile') return 'Run up your fighting colours first (naval.colours) to engage another captain.';
    if (b.colours !== 'hostile') return 'She flies peaceful colours; you cannot attack other travellers.';
    if (inSafeHarbour(a) || inSafeHarbour(b)) return 'No fighting within a harbour\'s waters.';
    return null;
  }

  // ------------------------------------------------------------------ damage

  function ignite(rec, kind) {
    const f = kind === 'barrel' ? { hp: BARREL.burnPerSecond, t: BARREL.burn } : { hp: FIRE_HP, t: FIRE_SECONDS };
    if (rec.d.fires.length < FIRE_STACK) rec.d.fires.push(f);
    else {
      let low = 0;
      for (let i = 1; i < rec.d.fires.length; i++) if (rec.d.fires[i].hp * rec.d.fires[i].t < rec.d.fires[low].hp * rec.d.fires[low].t) low = i;
      if (rec.d.fires[low].hp * rec.d.fires[low].t < f.hp * f.t) rec.d.fires[low] = f;
    }
  }

  /** Mirrors applied hull/canvas loss into the shipyard record (its own maxima; repaired at its yard). */
  function yardDamage(rec, hull, sail) {
    if (!isPlayer(rec) || !(hull > 0 || sail > 0)) return;
    const y = yardOf(rec.v);
    if (!y) return;
    S.shipyard.damage(y.player, y.shipId, { hull: Math.round(hull), sail: Math.round(sail) });
    const after = S.shipyard.ship(y.player, y.shipId);
    if (after && Number.isFinite(after.sailHp)) { rec.d.sail = clamp(after.sailHp, 0, rec.d.maxSail); rec.v.naval.mirrorSail = after.sailHp; }
  }

  /** Lose `men` crew: a vessel with a hired crew list loses its hands (deckhands first). */
  function loseCrew(rec, men) {
    if (!(men > 0)) return;
    rec.d.crew = Math.max(0, rec.d.crew - men);
    const y = isPlayer(rec) ? yardOf(rec.v) : null;
    if (y) {
      const lost = S.shipyard.loseCrew(y.player, y.shipId, men) ?? [];
      rec.v.naval.crewLost = (rec.v.naval.crewLost ?? 0) + lost.length;
      if (lost.length) crewNotify(rec, `Lost overboard or fallen: ${lost.join(', ')}.`);
    } else if (isPlayer(rec) && Array.isArray(rec.v.crew)) {
      const order = ['Deckhand', 'Cook', 'Lookout', 'Carpenter', 'Gunner', 'Bosun', 'Mate'];
      for (let i = 0; i < men && rec.v.crew.length > 0; i++) {
        let idx = -1;
        for (const role of order) { idx = rec.v.crew.findIndex((h) => h?.role === role); if (idx >= 0) break; }
        rec.v.crew.splice(idx >= 0 ? idx : rec.v.crew.length - 1, 1);
      }
      rec.v.naval.crewLost = (rec.v.naval.crewLost ?? 0) + men;
    }
  }

  /**
   * Applies harm `{hull, sail, crew, fire?}` from `by` (a ship record or null). `floor` keeps the hull at or above it
   * (a ram never sinks a ship by itself). Handles state changes and the law.
   */
  function hurt(rec, harm, by, { floor = 0, kind = 'shot', firerId = null } = {}) {
    if (!rec || rec.d.state === 'wrecked') return;
    guard(rec);
    const was = rec.d.state;
    rec.d.lastHitAt = nowS();
    const h0 = rec.d.hull, s0 = rec.d.sail;
    rec.d.hull = Math.max(Math.min(rec.d.hull, floor), rec.d.hull - Math.max(0, harm.hull | 0));
    rec.d.sail = Math.max(0, rec.d.sail - Math.max(0, harm.sail | 0));
    yardDamage(rec, h0 - rec.d.hull, s0 - rec.d.sail);
    loseCrew(rec, Math.max(0, harm.crew | 0));
    if (harm.fire && rec.d.state !== 'sinking') ignite(rec, harm.fire);
    if (by) {
      rec.lastHitBy = by.id;
      if (isPlayer(by)) rec.lastHitByPlayer = firerId ?? by.ownerId ?? null;
      if (!isPlayer(rec)) { (rec.hostileTo ??= new Set()).add(by.id); rec.provoked = true; }
      lawOnHit(rec, by, firerId);
    }
    settle(rec, was);
    markDirty(rec);
  }

  function settle(rec, was = rec.d.state) {
    const d = rec.d;
    if (d.state === 'afloat' || d.state === 'struck') {
      if (d.hull <= 0) { d.state = 'sinking'; d.sinkT = 0; }
      else if (!isPlayer(rec) && d.state === 'afloat' && (d.hull <= d.maxHull * STRUCK_AT || (d.maxCrew > 0 && d.crew <= 0))) d.state = 'struck';
    }
    if (d.state !== was) onStateChange(rec, was);
  }

  function onStateChange(rec, was) {
    const d = rec.d;
    const by = rec.lastHitBy ? ships.get(rec.lastHitBy) : null;
    const byPlayer = rec.lastHitByPlayer != null ? ctx.players.get(rec.lastHitByPlayer) ?? null : null;
    if (d.state === 'struck') {
      rec.speedTarget = 0;
      if (rec.kind === 'npc') rec.hostileTo?.clear();
      news(rec.x, rec.z, 'struck', rec, `The ${rec.title} strikes her colours.`);
      ctx.emit('naval.struck', { player: byPlayer, vessel: by && isPlayer(by) ? by.v.id : null, target: shipView(rec) });
    } else if (d.state === 'sinking') {
      breakGrapple(rec);
      news(rec.x, rec.z, 'sinking', rec, `The ${rec.title} is going down!`);
      ctx.emit('naval.sunk', { player: byPlayer, vessel: by && isPlayer(by) ? by.v.id : null, target: shipView(rec), by: by ? shipView(by) : null });
      if (rec.quarry) quarries.set(rec.quarry, { sunk: true });
      if (isPlayer(rec)) {
        const prize = by && isPlayer(by) ? { id: `wreck:${rec.id}:${Math.round(nowS() * 1000)}`, killerOwnerId: by.ownerId ?? null, killerVesselId: by.id, x: rec.x, z: rec.z, at: nowS(), atWall: Date.now(), taken: false } : null;
        rec.v.naval.wreck = prize;
        snapshotHold(rec.v);
        crewNotify(rec, 'She is holed and sinking! Abandon ship or pray for the shore.');
      }
    }
  }

  function lawOnHit(rec, by, firerId) {
    if (!isPlayer(by) || isPlayer(rec)) return;
    const fac = FACTIONS[rec.faction];
    const first = !(rec.struckBy ??= new Set()).has(by.id);
    rec.struckBy.add(by.id);
    if (!first || !fac?.lawful) return;
    const captain = ctx.players.get(firerId ?? by.ownerId);
    ctx.emit('naval.lawful', { player: captain ?? null, vessel: by.v.id, target: shipView(rec), act: 'fire' });
    if (captain && !S.seaLaw) {
      try { S.reportCrime?.(captain, 'piracy'); } catch (err) { log.warn?.('[naval] piracy report failed', err?.message ?? err); }
    }
    // navy ships within witness range of a lawful ship struck turn on the attacker
    for (const o of ships.values()) {
      if (o.kind === 'npc' && o.faction === 'navy' && o.d.state === 'afloat' && Math.hypot(o.x - rec.x, o.z - rec.z) <= WITNESS_RANGE) (o.hostileTo ??= new Set()).add(by.id);
    }
  }

  // ------------------------------------------------------------------ balls in flight

  function stepBalls(t) {
    if (!balls.length) return;
    const keep = [];
    for (const b of balls) {
      if (t < b.t0) { keep.push(b); continue; }
      if (b.kind === 'barrel') {
        if (t - b.t0 > BARREL.life) continue;
        if (t - b.t0 < BARREL.arm) { keep.push(b); continue; }
        let boom = null;
        for (const rec of ships.values()) {
          if (rec.d.state === 'wrecked' || rec.d.state === 'sinking') continue;
          if (rec.id === b.shooterId && t - b.t0 < BARREL.fuse) continue;
          const l = toLocal(rec, [b.p0[0], 0, b.p0[2]]);
          const hb = hullBox(rec.hull);
          if (l[0] >= hb.min[0] - BARREL.reach && l[0] <= hb.max[0] + BARREL.reach && l[2] >= hb.min[2] - BARREL.reach && l[2] <= hb.max[2] + BARREL.reach) { boom = rec; break; }
        }
        if (!boom) { keep.push(b); continue; }
        const shooter = ships.get(b.shooterId) ?? null;
        if (shooter && !mayHarm(shooter, boom)) { keep.push(b); continue; }
        const gun = GUNS.barrel;
        const dmg = shotDamage(gun, 'holed', { braced: boom.deck.braced, roll: b.roll, tough: isPlayer(boom) ? PLAYER_CREW_TOUGHNESS : SHIP_TOUGHNESS });
        hurt(boom, { ...dmg, fire: 'barrel' }, shooter, { firerId: b.firerId });
        tell(audience(b.p0[0], b.p0[2]), { kind: 'naval.hit', ballId: b.id, volleyId: b.volleyId, target: { id: boom.id, kind: boom.kind }, zone: 'holed', point: [r2(b.p0[0]), 0, r2(b.p0[2])], damage: dmg, fire: true, view: shipView(boom) });
        continue;
      }
      const t1 = Math.min(t, b.t0 + BALL_LIFE);
      const ta = Math.max(b.t0, b.tLast ?? b.t0);
      b.tLast = t1;
      const a = shotPosition(b.p0, b.v0, ta - b.t0);
      const e = shotPosition(b.p0, b.v0, t1 - b.t0);
      let done = false;
      const gun = shotGun(b.gun, b.shot);
      const shooter = ships.get(b.shooterId) ?? null;
      // the first box the segment enters
      let best = null;
      for (const rec of ships.values()) {
        if (rec.id === b.shooterId || rec.d.state === 'wrecked') continue;
        const reach = Math.hypot(e[0] - a[0], e[2] - a[2]) + 80;
        if (Math.hypot(rec.x - a[0], rec.z - a[2]) > reach && Math.hypot(rec.x - e[0], rec.z - e[2]) > reach) continue;
        const la = toLocal(rec, a), le = toLocal(rec, e);
        const hb = hullBox(rec.hull);
        const th = segmentBox(la, le, hb.min, hb.max, gun.radius);
        if (th != null && (!best || th < best.t)) best = { rec, t: th, zone: 'hull' };
        const rb = rigBox(rec.hull);
        if (rb && !b.hit.has(rec.id) && rec.d.maxSail > 0) {
          const tr = segmentBox(la, le, rb.min, rb.max, gun.radius);
          if (tr != null && (th == null || tr < th) && (!best || tr < best.t)) best = { rec, t: tr, zone: 'rig' };
        }
      }
      if (best && shooter && !mayHarm(shooter, best.rec)) best = null; // a peaceful captain's planks: the ball passes harmlessly
      if (best) {
        const tt = ta + (t1 - ta) * best.t;
        const pt = shotPosition(b.p0, b.v0, tt - b.t0);
        const rec = best.rec;
        let zone = best.zone;
        if (zone === 'hull') zone = hitZone(pt[1]);
        const reach = shotReach(b.shot, tt - b.t0);
        const dmg = shotDamage(gun, zone, { braced: rec.deck.braced, roll: b.roll, tough: isPlayer(rec) ? PLAYER_CREW_TOUGHNESS : SHIP_TOUGHNESS, reach });
        let fire = false;
        if (zone === 'hull' && b.roll < shotFireChance(b.shot)) fire = true;
        if (zone === 'rig' && shotRigFire(b.shot) && b.roll < 0.5) fire = true;
        hurt(rec, { ...dmg, fire: fire ? 'gun' : null }, shooter, { firerId: b.firerId });
        tell(audience(pt[0], pt[2]), { kind: 'naval.hit', ballId: b.id, volleyId: b.volleyId, target: { id: rec.id, kind: rec.kind }, zone, point: pt.map(r2), damage: dmg, fire, view: shipView(rec) });
        if (zone === 'rig') { b.hit.add(rec.id); keep.push(b); }
        done = zone !== 'rig';
      }
      if (done) continue;
      if (e[1] <= 0) {
        const tl = timeToSea(b);
        const pt = shotPosition(b.p0, b.v0, tl);
        tell(audience(pt[0], pt[2]), { kind: 'naval.hit', ballId: b.id, volleyId: b.volleyId, target: null, zone: 'water', point: [r2(pt[0]), 0, r2(pt[2])], damage: null, fire: false });
        continue;
      }
      if (t1 >= b.t0 + BALL_LIFE) continue;
      if (!keep.includes(b)) keep.push(b);
    }
    balls = keep;
  }
  const timeToSea = (b) => { const d = b.v0[1] * b.v0[1] + 2 * G * b.p0[1]; return d < 0 ? 0 : (b.v0[1] + Math.sqrt(d)) / G; };

  // ------------------------------------------------------------------ ramming

  function stepRams(t) {
    const list = [...ships.values()].filter((r) => r.d.state === 'afloat' || r.d.state === 'struck');
    for (const a of list) {
      const ba = HULL_BUILDS[a.hull];
      if (Math.abs(a.speed) < 0.5) continue;
      const stem = toWorld(a, [0, 0, ba.bowZ * Math.sign(a.speed || 1)]);
      for (const b of list) {
        if (a === b) continue;
        const bb = HULL_BUILDS[b.hull];
        if (Math.hypot(a.x - b.x, a.z - b.z) > ba.bowZ + bb.bowZ + 10) continue;
        const l = toLocal(b, stem);
        const mx = Math.abs(l[0]) - bb.halfWidth, mz = Math.max(l[2] - bb.bowZ, bb.aftZ - l[2]);
        if (mx > RAM_REACH || mz > RAM_REACH) continue;
        const key = `${a.id}|${b.id}`;
        if (t - (ramClock.get(key) ?? -1e9) < RAM_COOLDOWN_S) continue;
        const side = mx >= mz;
        const nl = side ? [Math.sign(l[0]) || 1, 0, 0] : [0, 0, l[2] >= 0 ? 1 : -1];
        const normal = dirToWorld(b.yaw, nl);
        const va = fwd(a.yaw).map((c) => c * a.speed), vb = fwd(b.yaw).map((c) => c * b.speed);
        const closing = -((va[0] - vb[0]) * normal[0] + (va[1] - vb[1]) * normal[2]);
        applyRam(a, b, { closing, side, point: stem, t });
      }
    }
  }
  /** One ram of `a`'s stem into `b` (stem contact here, or the sailing core's collision). False: too gentle. */
  function applyRam(a, b, { closing, side, point, t }) {
    const ba = HULL_BUILDS[a.hull];
    const key = `${a.id}|${b.id}`;
    if (t - (ramClock.get(key) ?? -1e9) < RAM_COOLDOWN_S) return false;
    const blow = ramBlow({ closing, side, mine: a.d.maxHull, hers: b.d.maxHull, galley: !!ba.ram });
    if (!(blow > 0)) return false;
    {
      const stem = point;
        ramClock.set(key, t);
        if (!mayHarm(a, b)) { bump(a, b); return true; }
        const line = b.d.maxHull * STRUCK_AT;
        const dealt = Math.max(0, Math.min(blow, Math.floor(b.d.hull - line)));
        const k = recoilShare(!!ba.ram);
        const room = Math.max(0, Math.floor(a.d.hull - a.d.maxHull * STRUCK_AT - 1));
        const recoil = Math.min(Math.round(dealt * k), room);
        const men = ballMen(dealt / RAM_A_MAN, rng(), isPlayer(b) ? PLAYER_CREW_TOUGHNESS : SHIP_TOUGHNESS);
        hurt(b, { hull: dealt, sail: 0, crew: men }, a, { floor: line, kind: 'ram' });
        if (recoil > 0) hurt(a, { hull: recoil, sail: 0, crew: 0 }, null, { kind: 'ram' });
        bump(a, b);
        tell(audience(b.x, b.z), { kind: 'naval.ram', rammerId: a.id, targetId: b.id, point: [r2(stem[0]), 0, r2(stem[2])], side, closing: r2(closing), damage: dealt, recoil, men, view: shipView(b), rammerView: shipView(a) });
    }
    return true;
  }
  // The sailing core stopped a vessel short of another hull: a ram if her stem was not already counted.
  ctx.on('sailingCollision', ({ vessel, other, speed } = {}) => {
    try {
      syncPlayers();
      const a = vessel ? ships.get(String(vessel.id)) : null;
      const b = other ? ships.get(String(other.id)) : null;
      if (!a || !b || a === b) return;
      const brg = Math.abs(bearingOf(b, a.x, a.z));
      const side = brg > 35 && brg < 145;
      applyRam(a, b, { closing: Math.abs(Number(speed) || 0), side, point: toWorld(a, [0, 0, HULL_BUILDS[a.hull].bowZ]), t: nowS() });
    } catch (err) { log.error?.('[naval] collision failed', err); }
  });
  function bump(a, b) {
    for (const r of [a, b]) {
      if (isPlayer(r)) { r.v.speed = (Number(r.v.speed) || 0) * 0.3; r.speed = r.v.speed; markDirty(r); }
      else r.speed *= 0.3;
    }
  }

  // ------------------------------------------------------------------ fires, sinking, wrecks, clocks

  function stepShips(dt, t) {
    for (const rec of [...ships.values()]) {
      const d = rec.d;
      // reload clocks run unless braced
      if (!rec.deck.braced && d.state === 'afloat') for (const s of SIDES) if (rec.deck.clocks[s] > 0) rec.deck.clocks[s] = Math.max(0, rec.deck.clocks[s] - dt);
      // fires
      if (d.fires.length) {
        let hull = 0;
        for (const f of d.fires) { hull += f.hp * Math.min(dt, f.t); f.t -= dt; }
        d.fires = d.fires.filter((f) => f.t > 0);
        const was = d.state;
        if (d.state === 'afloat' || d.state === 'struck') {
          const h0 = d.hull, s0 = d.sail;
          d.hull = Math.max(0, d.hull - hull);
          d.sail = Math.max(0, d.sail - hull * FIRE_SAIL);
          rec.fireCarry = (rec.fireCarry ?? 0) + (h0 - d.hull);
          rec.fireSailCarry = (rec.fireSailCarry ?? 0) + (s0 - d.sail);
          if (rec.fireCarry >= 1 || rec.fireSailCarry >= 1) {
            const hh = Math.floor(rec.fireCarry), ss = Math.floor(rec.fireSailCarry);
            rec.fireCarry -= hh; rec.fireSailCarry -= ss;
            yardDamage(rec, hh, ss);
          }
          d.crewBurn += hull;
          const tough = isPlayer(rec) ? PLAYER_CREW_TOUGHNESS : SHIP_TOUGHNESS;
          while (d.crewBurn >= FIRE_CREW_S * tough) { d.crewBurn -= FIRE_CREW_S * tough; loseCrew(rec, 1); }
          settle(rec, was);
        }
        markDirty(rec);
      }
      if (d.state === 'sinking') {
        d.sinkT += dt;
        rec.speed = 0;
        if (isPlayer(rec)) { rec.v.speed = 0; }
        if (d.sinkT >= cfg.sinkS) {
          if (isPlayer(rec)) wreckPlayer(rec);
          else { news(rec.x, rec.z, 'sunk', rec, `The ${rec.title} has gone down.`); removeNpc(rec); }
        }
      }
      if (rec.kind === 'npc' && rec.scuttleAt && t >= rec.scuttleAt && d.state !== 'sinking') {
        const was = d.state;
        d.hull = 0; d.state = 'sinking'; d.sinkT = 0;
        onStateChange(rec, was);
      }
      // boarding bookkeeping
      if (rec.boarding) stepBoarding(rec);
      if (rec.repel) stepRepel(rec);
      if (rec.grappledTo) {
        const o = ships.get(rec.grappledTo);
        if (!o || o.d.state === 'sinking' || Math.hypot(o.x - rec.x, o.z - rec.z) > ABANDON_RANGE) breakGrapple(rec);
      }
    }
  }

  function wreckPlayer(rec) {
    const v = rec.v;
    const d = rec.d;
    snapshotHold(v);
    d.state = 'wrecked';
    d.fires = [];
    if (rec.boarding) endBoarding(rec, 'sunk');
    if (rec.repel) { banish(rec.repel.foes); rec.repel = null; }
    breakGrapple(rec);
    news(rec.x, rec.z, 'wrecked', rec, `The ${rec.title} is wrecked.`);
    ctx.emit('naval.wrecked', { vessel: v.id, killer: v.naval.wreck?.killerOwnerId != null ? ctx.players.get(v.naval.wreck.killerOwnerId) ?? null : null });
    d.hull = 0;
    d.sinkT = 0;
    v.naval.colours = 'peace';
    rec.colours = 'peace';
    for (const s of SIDES) rec.deck.clocks[s] = 0;
    rec.deck.braced = false;
    v.naval.wrecks = (v.naval.wrecks ?? 0) + 1;
    mirror(v);
    if (v.naval.wreck) wrecks.set(rec.id, { v, wreck: v.naval.wreck });
    const crew = crewOf(v);
    tell(crew, { kind: 'naval.news', what: 'respawn', shipId: rec.id, text: 'Your ship is lost. You make it ashore; the hulk is towed to port for the shipwright.' });
    let moved = false;
    try {
      if (typeof sail()?.wreck === 'function') { sail().wreck(v, { text: 'Your ship is lost. You make it ashore; the hulk is towed to port for the shipwright.' }); moved = true; }
      else if (typeof sail()?.respawn === 'function') { sail().respawn(v, { reason: 'wrecked' }); moved = true; }
    } catch (err) { log.error?.('[naval] wreck hand-off failed', err); }
    if (!moved) {
      // no sailing core to tow her: patched to float where she lies, what is left is the yard's work
      d.hull = Math.max(1, Math.ceil(d.maxHull * STRUCK_AT));
      d.sail = Math.ceil(d.maxSail * STRUCK_AT);
      d.state = 'afloat';
      v.speed = 0; v.anchored = true;
    }
    mirror(v);
    rec.x = v.x; rec.z = v.z; rec.speed = 0;
    dirtyVessels.add(v);
    flushSaves(true);
    if (v.sunk) ships.delete(rec.id);
  }

  function removeNpc(rec) {
    breakGrapple(rec);
    if (rec.boardedBy) {
      const b = ships.get(rec.boardedBy);
      if (b?.boarding?.targetId === rec.id) endBoarding(b, 'sunk');
    }
    ships.delete(rec.id);
  }

  // ------------------------------------------------------------------ grapple, boarding, plunder

  const edgeGap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) - HULL_BUILDS[a.hull].halfWidth - HULL_BUILDS[b.hull].halfWidth;

  function breakGrapple(rec) {
    const o = rec.grappledTo ? ships.get(rec.grappledTo) : null;
    if (o?.grappledTo === rec.id) o.grappledTo = null;
    rec.grappledTo = null;
  }

  function spawnFoes(p, list, tag, viewers = [p.id]) {
    const loc = ctx.location(p);
    const out = [];
    const lvl = levelOf(p);
    list.forEach((mobile, i) => {
      const a = (i / Math.max(1, list.length)) * Math.PI * 2;
      const rad = 3 + (i % 3);
      const e = S.createEnemy?.(loc, mobile, (Number(p.x) || 0) + Math.cos(a) * rad, (Number(p.z) || 0) + Math.sin(a) * rad, { level: lvl, origin: 'naval', key: `${tag}:${i}`, visibleTo: viewers });
      if (e) { e.naval = tag; out.push({ id: e.id, mobile, captain: i === 0, down: false }); }
    });
    return out;
  }
  function foesDown(foes) {
    for (const f of foes) {
      if (f.down) continue;
      const e = ctx.entities.get(f.id);
      if (!e || e.dead || !(e.hp > 0)) f.down = true;
    }
    const down = foes.filter((f) => f.down).length;
    return { down, total: foes.length, captainDown: foes.some((f) => f.captain && f.down) };
  }
  function banish(foes) {
    for (const f of foes) {
      const e = ctx.entities.get(f.id);
      if (e && !e.dead) { if (!S.banishMonster?.(e)) ctx.entities.delete(f.id); }
    }
  }

  function stepBoarding(rec) {
    const b = rec.boarding;
    const target = ships.get(b.targetId);
    if (!target) { endBoarding(rec, 'gone'); return; }
    if (b.phase === 'fight') {
      const tally = foesDown(b.foes);
      if (boardingWon(tally)) {
        b.phase = 'prize';
        target.d.state = 'struck';
        target.prize = true;
        target.prizeOf = rec.id;
        news(target.x, target.z, 'boardWon', target, `The ${target.title}'s crew throw down their arms. She is your prize.`);
        ctx.emit('naval.boarded', { player: captainOf(rec) ?? ctx.players.get(b.by) ?? crewOf(rec.v).find((q) => !q.rpg?.defeated) ?? null, vessel: rec.v.id, target: shipView(target) });
        banish(b.foes.filter((f) => !f.down));
        markDirty(rec);
      } else if (!crewOf(rec.v).some((p) => !p.rpg?.defeated)) {
        endBoarding(rec, 'repelled');
      }
    }
    if (edgeGap(rec, target) > ABANDON_RANGE) endBoarding(rec, 'abandoned');
  }
  function endBoarding(rec, why) {
    const b = rec.boarding;
    if (!b) return;
    banish(b.foes);
    const target = ships.get(b.targetId);
    if (target && target.boardedBy === rec.id) target.boardedBy = null;
    rec.boarding = null;
    breakGrapple(rec);
    const text = { retreat: 'You cut the grapples and fall back to your own deck.', repelled: 'The boarding is thrown back.', abandoned: 'The ships drift apart; the boarding is over.', sunk: 'The prize goes down under you.', gone: 'The boarding is over.' }[why] ?? 'The boarding is over.';
    news(rec.x, rec.z, why === 'retreat' ? 'retreat' : 'boardEnd', rec, text);
  }

  function stepRepel(rec) {
    const r = rec.repel;
    if (!crewOf(rec.v).length) {
      banish(r.foes);
      rec.repel = null;
      breakGrapple(rec);
      return;
    }
    const tally = foesDown(r.foes);
    const pirate = ships.get(r.byId);
    if (tally.down >= tally.total || !pirate) {
      rec.repel = null;
      breakGrapple(rec);
      if (pirate && pirate.d.state === 'afloat') {
        const was = pirate.d.state;
        pirate.d.state = 'struck';
        onStateChange(pirate, was);
      }
      crewNotify(rec, 'The boarders are thrown back into the sea!');
      ctx.emit('naval.repelled', { player: captainOf(rec), vessel: rec.v.id, target: pirate ? shipView(pirate) : null });
    }
  }

  // ------------------------------------------------------------------ NPC ships: director and captains

  function spawnNpc(near, captainLevel = 1) {
    const portNear = nearestPort(near.x, near.z);
    const pirateK = portNear && portNear.d < 3 * cfg.safePortM ? PORT_PIRATE_K : 1;
    const cls = pickClass(rng, { level: captainLevel, pirateK });
    for (let tries = 0; tries < 10; tries++) {
      const a = rng() * Math.PI * 2;
      const dist = SPAWN_CLEAR + rng() * (SPAWN_CLEAR * 1.2);
      const x = near.x + Math.sin(a) * dist, z = near.z - Math.cos(a) * dist;
      if (!surelyWater(x, z)) continue;
      return addNpc(cls, x, z, rng() * Math.PI * 2);
    }
    return null;
  }
  function addNpc(cls, x, z, yaw, extra = {}) {
    if (typeof cls === 'string') cls = classById(cls);
    if (!cls) return null;
    const id = `npc:${npcSeq++}`;
    const uid = `${id}@${Date.now().toString(36)}-${((rng() * 0xffffff) >>> 0).toString(36)}`;
    const rec = {
      id, kind: 'npc', classId: cls.id, title: cls.title, faction: cls.faction, hull: cls.hull, x, z, yaw, speed: cls.speed * 0.5,
      d: blankDamage(cls.hullHp, cls.sailHp, cls.crew), deck: blankDeck(cls.hull), colours: 'peace', seed: (rng() * 0xffffffff) >>> 0,
      uid, ai: { mode: 'route', next: 0, waypoint: null, chaseSince: null, home: { x, z } }, hostileTo: new Set(), ...extra,
    };
    ships.set(id, rec);
    return rec;
  }

  function stepDirector(t) {
    if (!cfg.spawn) return;
    for (const rec of ships.values()) {
      if (!isPlayer(rec) || rec.d.state !== 'afloat' || rec.v.docked) continue;
      const next = rollAt.get(rec.id);
      if (next == null) { rollAt.set(rec.id, t + cfg.rollS); continue; }
      if (t < next) continue;
      rollAt.set(rec.id, t + cfg.rollS);
      if (inSafeHarbour(rec)) continue;
      const near = [...ships.values()].filter((o) => o.kind === 'npc' && Math.hypot(o.x - rec.x, o.z - rec.z) < DESPAWN_BEYOND).length;
      if (near >= cfg.maxNear || rng() > cfg.spawnChance) continue;
      const lvl = Math.max(...crewOf(rec.v).map(levelOf), 1);
      const npc = spawnNpc(rec, lvl);
      if (npc) news(npc.x, npc.z, 'sighted', npc, `Sail ho! A ${npc.title} on the horizon.`);
    }
    // despawn ships far from every vessel (never one mid-fight with a player)
    for (const rec of [...ships.values()]) {
      if (rec.kind !== 'npc' || rec.boardedBy || rec.grappledTo || rec.noDespawn) continue;
      let close = Infinity;
      for (const o of ships.values()) if (isPlayer(o)) close = Math.min(close, Math.hypot(o.x - rec.x, o.z - rec.z));
      if (close > DESPAWN_BEYOND) removeNpc(rec);
    }
  }

  /** Is `rec` (NPC) an enemy of `o`? */
  function enemyOf(rec, o) {
    if (o === rec || o.d.state !== 'afloat') return false;
    if (rec.hostileTo?.has(o.id)) return !(isPlayer(o) && inSafeHarbour(o));
    if (rec.faction === 'pirate') {
      if (isPlayer(o)) return !inSafeHarbour(o) && !inSafeHarbour(rec);
      return o.faction === 'merchant' || o.faction === 'navy';
    }
    if (rec.faction === 'navy') {
      if (o.faction === 'pirate') return true;
      if (isPlayer(o)) {
        const p = captainOf(o);
        try {
          if (typeof S.admiralty?.hostileTo === 'function') return !!(p && S.admiralty.hostileTo(p, shipView(rec)));
          return !!(S.seaLaw?.wanted?.(o.v) ?? false);
        } catch { return false; }
      }
    }
    return false;
  }

  function stepNpcs(dt, t) {
    for (const rec of ships.values()) {
      if (rec.kind !== 'npc') continue;
      const cls = classById(rec.classId);
      const d = rec.d;
      if (d.state !== 'afloat' || rec.grappledTo) {
        rec.speed = Math.max(0, rec.speed - 0.6 * dt);
        moveNpc(rec, dt, cls, rec.yaw, 0);
        continue;
      }
      rec.ai.next -= dt;
      if (rec.ai.next <= 0) { rec.ai.next = 0.25; think(rec, cls, t); }
      moveNpc(rec, dt, cls, rec.ai.heading ?? rec.yaw, rec.ai.sails ?? 1);
      if (rec.ai.fire) tryFire(rec, cls);
    }
  }

  function think(rec, cls, t) {
    // a merchant runs from whoever is hurting it or from a pirate close aboard
    let foe = null, fd = Infinity;
    for (const o of ships.values()) {
      if (!enemyOf(rec, o)) continue;
      const dd = Math.hypot(o.x - rec.x, o.z - rec.z);
      if (dd < fd) { fd = dd; foe = o; }
    }
    const fleeFrom = FACTIONS[rec.faction]?.flees ? threatTo(rec) : null;
    rec.ai.fire = null;
    if (fleeFrom) {
      rec.ai.mode = 'flee';
      rec.ai.heading = Math.atan2(rec.x - fleeFrom.x, -(rec.z - fleeFrom.z));
      rec.ai.sails = 1;
      return;
    }
    if (foe && fd <= ENGAGE_RANGE * (rec.ai.mode === 'engage' ? DISENGAGE : 1)) {
      if (rec.ai.mode !== 'engage') { rec.ai.mode = 'engage'; rec.ai.chaseSince = t; rec.ai.targetId = foe.id; if (isPlayer(foe)) news(rec.x, rec.z, 'engage', rec, `The ${rec.title} bears down on you!`); }
      if (t - (rec.ai.chaseSince ?? t) > CHASE_GIVE_UP_S && fd > cls.range * 2) { rec.ai.mode = 'route'; rec.hostileTo?.delete(foe.id); return; }
      rec.ai.targetId = foe.id;
      const brg = Math.atan2(foe.x - rec.x, -(foe.z - rec.z));
      if (cls.tactic === 'bow') {
        rec.ai.heading = brg; // bows on: chasers and the ram
        rec.ai.sails = 1;
      } else {
        // lie broadside on at her range: steer 90° off the bearing, closing or opening by up to 40°
        const off = bearingOf(rec, foe.x, foe.z);
        const sideSign = off >= 0 ? 1 : -1; // keep the foe on the side it is already on
        const want = clamp((fd - cls.range) / cls.range, -1, 1) * 40 * DEG;
        rec.ai.heading = wrap(brg - sideSign * (90 * DEG - want));
        rec.ai.sails = fd < cls.range * 0.6 ? 0.6 : 1;
        // a pirate grapples a crippled player ship and sends a party across
        if (rec.faction === 'pirate' && isPlayer(foe) && !foe.repel && !rec.grappledTo && foe.d.hull <= foe.d.maxHull * 0.5 && rec.d.crew >= rec.d.maxCrew * 0.5 && edgeGap(rec, foe) <= BOARD_RANGE) startRepel(foe, rec, cls);
      }
      rec.ai.fire = foe.id;
      return;
    }
    rec.ai.mode = 'route';
    routeHeading(rec, cls);
  }

  function threatTo(rec) {
    let best = null, bd = Infinity;
    for (const o of ships.values()) {
      if (o === rec || o.d.state !== 'afloat') continue;
      const hit = rec.hostileTo?.has(o.id);
      const pirate = o.faction === 'pirate';
      const dd = Math.hypot(o.x - rec.x, o.z - rec.z);
      if ((hit && dd < ENGAGE_RANGE * DISENGAGE) || (pirate && dd < FLEE_RANGE)) if (dd < bd) { bd = dd; best = o; }
    }
    return best;
  }

  function routeHeading(rec, cls) {
    const ai = rec.ai;
    const list = ports();
    if (!ai.waypoint || Math.hypot(ai.waypoint.x - rec.x, ai.waypoint.z - rec.z) < 150) {
      if (rec.faction === 'merchant' && list.length) {
        if (ai.lane?.points?.length && ai.lane.i < ai.lane.points.length) {
          const pt = ai.lane.points[ai.lane.i++];
          ai.waypoint = { x: pt.x, z: pt.z, port: ai.lane.to };
        } else {
          // trade between the nearer ports along the chart's sea lane (never the one she is leaving)
          const sorted = list.map((q) => ({ q, d: Math.hypot(q.x - rec.x, q.z - rec.z) })).sort((a, b) => a.d - b.d);
          const from = sorted[0]?.q;
          const pick = sorted.filter((s) => s.d > 300).slice(0, 4);
          const q = pick.length ? pick[Math.floor(rng() * pick.length)].q : sorted[0].q;
          ai.lane = { from: from?.id ?? null, to: q.id ?? q.name ?? null, points: null, i: 0 };
          ai.waypoint = { x: q.x, z: q.z, port: ai.lane.to };
        }
      } else if (rec.faction === 'pirate') {
        // a raider hunts the nearest player ship in sight, else prowls
        let prey = null, pd = Infinity;
        for (const o of ships.values()) if (isPlayer(o) && o.d.state === 'afloat') { const dd = Math.hypot(o.x - rec.x, o.z - rec.z); if (dd < pd) { pd = dd; prey = o; } }
        if (prey && pd < ENGAGE_RANGE * 2) ai.waypoint = { x: prey.x, z: prey.z };
        else { const a = rng() * Math.PI * 2; ai.waypoint = { x: rec.x + Math.sin(a) * 800, z: rec.z - Math.cos(a) * 800 }; }
      } else {
        // a patrol beats around its station
        const a = rng() * Math.PI * 2;
        ai.waypoint = { x: ai.home.x + Math.sin(a) * 700, z: ai.home.z - Math.cos(a) * 700 };
      }
    }
    // the lane arrives when the chart has routed it (coast.route answers from its cache and asks its worker)
    if (rec.faction === 'merchant' && ai.lane && !ai.lane.points && ai.lane.from && ai.lane.to && ai.lane.from !== ai.lane.to) {
      try {
        const c = sail()?.coastNow ?? S.coast ?? null;
        const r = c?.route?.(ai.lane.from, ai.lane.to);
        if (r?.points?.length) {
          let i = 0, best = Infinity;
          r.points.forEach((pt, k) => { const d = Math.hypot(pt.x - rec.x, pt.z - rec.z); if (d < best) { best = d; i = k; } });
          ai.lane.points = r.points.map((pt) => ({ x: pt.x, z: pt.z }));
          const next = Math.min(i + 1, ai.lane.points.length - 1); // the point after the nearest: onward, never back
          const pt = ai.lane.points[next];
          ai.lane.i = next + 1;
          ai.waypoint = { x: pt.x, z: pt.z, port: ai.lane.to };
        }
      } catch { /* straight for her port meanwhile */ }
    }
    ai.heading = Math.atan2(ai.waypoint.x - rec.x, -(ai.waypoint.z - rec.z));
    ai.sails = 1;
  }

  function moveNpc(rec, dt, cls, heading, sails) {
    const wind = windAt(rec.x, rec.z);
    const toYaw = wind.from + Math.PI; // where the wind blows TO
    const turn = cls.turn * DEG * dt * (cls.tactic === 'bow' ? 1 : clamp(rec.speed / Math.max(1, cls.speed * 0.5), 0.35, 1));
    let h = heading;
    // no ship points higher than close-hauled: beat at 45° off the wind's eye
    const offRun = Math.abs(wrap(h - toYaw)) / DEG;
    if (cls.tactic !== 'bow' && offRun > 135) h = wrap(toYaw + Math.sign(wrap(h - toYaw) || 1) * 135 * DEG);
    // a captain keeps off the land: try turning away
    const look = Math.max(60, rec.speed * 22);
    const ahead = (y) => isWater(rec.x + Math.sin(y) * look, rec.z - Math.cos(y) * look);
    if (!ahead(h)) {
      for (const k of [30, -30, 60, -60, 90, -90, 135, -135, 180]) { const y = wrap(h + k * DEG); if (ahead(y)) { h = y; break; } }
    }
    const dyaw = clamp(wrap(h - rec.yaw), -turn, turn);
    rec.yaw = wrap(rec.yaw + dyaw);
    const off = Math.abs(wrap(rec.yaw - toYaw)) / DEG;
    const oars = cls.tactic === 'bow' ? 0.55 : 0;
    const way = rec.d.state === 'afloat' && !rec.grappledTo ? Math.max(oars, pointOfSail(off) * windShare(wind.speed / 4) * canvasWay(rec.d.sail, rec.d.maxSail) * sails) : 0;
    const target = cls.speed * way;
    rec.speed += clamp(target - rec.speed, -0.6 * dt, 0.35 * dt);
    const nx = rec.x + Math.sin(rec.yaw) * rec.speed * dt, nz = rec.z - Math.cos(rec.yaw) * rec.speed * dt;
    const w = waterAt(nx, nz);
    if (w === true || (w === null && cfg.assumeWater === true) || (w === null && !hasChart())) { rec.x = nx; rec.z = nz; }
    else rec.speed = 0; // land ahead, or the chart is still loading: she holds her ground until it answers
  }

  function tryFire(rec, cls) {
    const foe = ships.get(rec.ai.fire);
    if (!foe || foe.d.state !== 'afloat') return;
    const bat = batteriesOf(rec.hull);
    for (const side of SIDES) {
      if (!bat[side] || rec.deck.clocks[side] > 0) continue;
      const fd = Math.hypot(foe.x - rec.x, foe.z - rec.z);
      if (bat[side].gun === 'barrel') {
        if (fd < 40 && sideForBearing(bearingOf(rec, foe.x, foe.z)) === 'stern' && rec.deck.barrels > 0) fireBattery(rec, side, { skill: cls.skill });
        continue;
      }
      const reach = rangeFor(rec, side);
      if (fd > reach) continue;
      // lead the target by the flight time
      const gun = shotGun(bat[side].gun, null);
      const tof = fd / (gun.speed * 0.95);
      const lx = foe.x + Math.sin(foe.yaw) * foe.speed * tof, lz = foe.z - Math.cos(foe.yaw) * foe.speed * tof;
      const brg = bearingOf(rec, lx, lz);
      const ok = side === 'bow' ? Math.abs(brg) <= BOW_BEAR : side === 'stern' ? Math.abs(brg) >= 180 - BOW_BEAR
        : Math.abs(Math.abs(brg) - 90) <= BEAR_DEG && (side === 'starboard') === (brg > 0);
      if (!ok) continue;
      const out = Math.hypot(lx - rec.x, lz - rec.z);
      const err = (rng() - 0.5) * 2 * LAY_ERR * (1 - cls.skill) * 0.12;
      try { fireBattery(rec, side, { range: out * (1 + err), skill: cls.skill }); } catch { /* not ready */ }
    }
  }

  function startRepel(target, pirate, cls) {
    const captain = crewOf(target.v).find((p) => !p.rpg?.defeated) ?? null;
    if (!captain) return;
    pirate.grappledTo = target.id;
    target.grappledTo = pirate.id;
    const n = repelPartyOf(cls);
    const m = musterOf(cls).men;
    const list = [];
    for (let i = 0; i < n; i++) list.push(m[i % m.length]);
    const foes = spawnFoes(captain, list, `repel:${pirate.id}`, crewOf(target.v).map((q) => q.id));
    target.repel = { byId: pirate.id, foes };
    news(target.x, target.z, 'repel', target, `The ${pirate.title} grapples alongside — boarders away! Repel them!`);
  }

  // ------------------------------------------------------------------ way and helm (for the sailing core)

  function wayFor(rec) {
    if (!rec) return 1;
    const d = rec.d;
    if (d.state === 'sinking' || d.state === 'wrecked') return 0;
    if (rec.grappledTo) return 0;
    if (d.state === 'struck' && !isPlayer(rec)) return 0;
    return canvasWay(d.sail, d.maxSail);
  }
  function helmBlocked(rec) {
    if (!rec) return null;
    if (rec.d.state === 'sinking') return 'She is going down.';
    if (rec.grappledTo) return 'You are grappled alongside. Cut free (naval.retreat) to sail.';
    if (rec.repel) return 'Boarders on deck! Throw them back first.';
    return null;
  }

  // ------------------------------------------------------------------ periodic state to crews

  function publishStates(force = false, only = null) {
    for (const rec of ships.values()) {
      if (!isPlayer(rec)) continue;
      const crew = crewOf(rec.v);
      if (!crew.length) continue;
      const contacts = [];
      for (const o of ships.values()) if (o !== rec && Math.hypot(o.x - rec.x, o.z - rec.z) <= cfg.viewM) contacts.push(shipView(o));
      const proj = balls.filter((b) => Math.hypot(b.p0[0] - rec.x, b.p0[2] - rec.z) <= cfg.viewM + 600).map(ballView);
      const self = combatOf(rec);
      const busy = contacts.length || proj.length || rec.boarding || rec.repel || rec.d.fires.length || rec.d.state !== 'afloat';
      for (const p of crew) {
        if (only && p !== only) continue;
        const key = JSON.stringify([self, contacts.map((c) => [c.id, c.state, c.hullHp, c.sailHp, c.crew, c.colours])]);
        if (!force && !busy && lastState.get(p.id) === key) continue;
        lastState.set(p.id, key);
        ctx.notify(p, { kind: 'naval.state', silent: true, t: r3(nowS()), self, contacts, projectiles: proj });
      }
    }
  }

  // ------------------------------------------------------------------ actions

  function myShip(p, { command = true } = {}) {
    if (!sail()) fail('There is no sailing here.');
    const v = aboardOf(p);
    if (!v) fail('You are not aboard a ship.');
    if (v.sunk) fail('Your ship is wrecked.');
    syncPlayers();
    const rec = ships.get(String(v.id));
    if (!rec) fail(v.docked ? 'Your ship is berthed. Put to sea first.' : 'Your ship is not at sea.');
    if (command && !canCommand(p, v)) fail('Only her captain gives that order.');
    if (p.rpg?.defeated) fail('You are in no state to give orders.');
    return rec;
  }
  function targetOf(args, { wreck = false } = {}) {
    const id = String(args?.targetId ?? '');
    const t = ships.get(id);
    if (t) return t;
    const w = wreck ? wrecks.get(id) : null;
    if (w) return { id, kind: 'player', wreckOnly: true, v: w.v, d: w.v.naval.d, deck: w.v.naval.deck, x: w.wreck.x, z: w.wreck.z, hull: PLAYER_HULL[w.v.type] ?? 2, title: w.v.name ?? 'wreck', ownerId: w.v.ownerId };
    if (wreck) {
      const v = sail()?.byId?.(id) ?? null;
      if (v?.naval?.wreck && !v.naval.wreck.taken) {
        return { id, kind: 'player', wreckOnly: true, v, d: v.naval.d, deck: v.naval.deck, x: v.naval.wreck.x, z: v.naval.wreck.z, hull: PLAYER_HULL[v.type] ?? 2, title: v.name ?? 'wreck', ownerId: v.ownerId };
      }
    }
    fail('No such ship in sight.');
  }

  ctx.onAction('naval.sync', (p) => {
    syncPlayers();
    const v = aboardOf(p);
    const rec = v ? ships.get(String(v.id)) : null;
    if (!rec) { ctx.notify(p, { kind: 'naval.state', silent: true, t: r3(nowS()), self: null, contacts: [], projectiles: [] }); return; }
    lastState.delete(p.id);
    publishStates(true, p);
  });

  ctx.onAction('naval.load', (p, args) => {
    const rec = myShip(p);
    guard(rec);
    const changed = setLoad(rec, String(args.group ?? 'broadside'), String(args.shot ?? ''));
    markDirty(rec);
    ctx.notify(p, { kind: 'naval', text: changed ? `The ${args.group ?? 'broadside'} guns are drawn and loaded with ${args.shot} shot.` : `The ${args.group ?? 'broadside'} guns already hold ${args.shot}.` });
    publishStates(true, p);
  });

  ctx.onAction('naval.fire', (p, args) => {
    const rec = myShip(p);
    const side = String(args.side ?? '');
    const target = args.targetId != null ? ships.get(String(args.targetId)) ?? null : null;
    if (target) { const why = pvpRefusal(rec, target); if (why) fail(why); }
    if (isPlayer(rec) && inSafeHarbour(rec)) fail('No guns are fired within a harbour\'s waters.');
    guard(rec);
    const range = Number.isFinite(args.range) ? clamp(args.range, 0, 2000) : null;
    const r = fireBattery(rec, side, { range, target, skill: 0.5, firer: p });
    markDirty(rec);
    ctx.notify(p, { kind: 'naval', text: side === 'stern' && r.balls === 1 && batteriesOf(rec.hull)[side]?.gun === 'barrel' ? 'A fire barrel rolls off the stern.' : `The ${side} guns fire! (${r.balls})`, volleyId: r.volleyId });
  });

  ctx.onAction('naval.brace', (p, args) => {
    const rec = myShip(p);
    guard(rec);
    rec.deck.braced = args.on !== false;
    markDirty(rec);
    ctx.notify(p, { kind: 'naval', text: rec.deck.braced ? 'Brace! The crew hold on (half harm taken, guns silent).' : 'The crew return to the guns.' });
    publishStates(true, p);
  });

  ctx.onAction('naval.colours', (p, args) => {
    const rec = myShip(p);
    if (rec.d.state !== 'afloat') fail('Her colours are already struck.');
    const hostile = args.hostile === true;
    if (!hostile && rec.d.lastHitAt > nowS() - 30 && rec.colours === 'hostile') fail('You cannot strike your fighting colours in the heat of battle. Surrender instead.');
    guard(rec);
    rec.v.naval.colours = hostile ? 'hostile' : 'peace';
    rec.colours = rec.v.naval.colours;
    markDirty(rec);
    news(rec.x, rec.z, 'colours', rec, hostile ? `The ${rec.title} runs up her fighting colours.` : `The ${rec.title} flies peaceful colours.`, { colours: rec.colours });
  });

  ctx.onAction('naval.surrender', (p) => {
    const rec = myShip(p);
    if (rec.d.state !== 'afloat') fail('She is in no state to surrender.');
    guard(rec);
    rec.d.state = 'struck';
    rec.v.naval.colours = 'peace';
    rec.colours = 'peace';
    rec.v.naval.surrender = { id: `surrender:${rec.id}:${Math.round(nowS() * 1000)}`, at: nowS(), atWall: Date.now(), by: rec.lastHitBy ?? null };
    snapshotHold(rec.v);
    markDirty(rec);
    news(rec.x, rec.z, 'surrender', rec, `The ${rec.title} strikes her colours and surrenders.`);
  });

  ctx.onAction('naval.grapple', (p, args) => {
    const rec = myShip(p);
    const t = targetOf(args);
    if (t === rec) fail('That is your own ship.');
    if (rec.d.state !== 'afloat') fail('You cannot grapple in this state.');
    if (rec.grappledTo) fail('You are already grappled.');
    if (t.d.state !== 'struck') fail(t.d.state === 'afloat' ? 'She still fights. Bring her to strike her colours first.' : 'She cannot be grappled now.');
    if (isPlayer(t) && t.v.naval.surrender?.by !== rec.id && t.lastHitBy !== rec.id) fail('She surrendered to another captain.');
    if (t.plundered) fail('She has already been stripped.');
    const gap = edgeGap(rec, t);
    if (gap > BOARD_RANGE) fail(`She is ${Math.round(gap)} m off; close within ${BOARD_RANGE} m to throw the grapples.`);
    guard(rec); guard(t);
    rec.grappledTo = t.id; t.grappledTo = rec.id;
    rec.v.speed = 0; rec.speed = 0; t.speed = 0;
    if (isPlayer(t)) t.v.speed = 0;
    markDirty(rec); markDirty(t);
    news(t.x, t.z, 'grapple', t, `Grapples fly — the ${rec.title} lies alongside the ${t.title}.`);
  });

  ctx.onAction('naval.board', (p, args) => {
    const rec = myShip(p, { command: false });
    const t = targetOf(args);
    if (rec.grappledTo !== t.id) fail('Grapple her first.');
    if (rec.boarding) fail('Your crew are already across.');
    if (isPlayer(t)) fail('A surrendered captain gives up her hold without a fight; plunder her.');
    if (t.prize) fail('She is already your prize.');
    guard(rec); guard(t);
    const cls = classById(t.classId);
    const crewShareLeft = t.d.maxCrew > 0 ? t.d.crew / t.d.maxCrew : 0;
    let foes = [];
    if (t.d.crew > 0 && cls) {
      const m = musterOf(cls, crewShareLeft);
      foes = spawnFoes(p, [m.captain, ...m.men], `board:${t.id}`, crewOf(rec.v).map((q) => q.id));
    }
    rec.boarding = { targetId: t.id, phase: 'fight', by: p.id, foes, at: nowS() };
    t.boardedBy = rec.id;
    if (!foes.length) stepBoarding(rec);
    markDirty(rec);
    news(t.x, t.z, 'boardStart', t, foes.length ? `Boarders away! ${foes.length} of the ${t.title}'s crew stand to meet you.` : `The ${t.title}'s deck is empty.`, { foes: foes.map((f) => f.id) });
  });

  ctx.onAction('naval.retreat', (p) => {
    const rec = myShip(p);
    if (!rec.boarding && !rec.grappledTo) fail('There is nothing to cut free from.');
    guard(rec);
    const other = rec.grappledTo ? ships.get(rec.grappledTo) : null;
    if (other) guard(other);
    if (rec.boarding) endBoarding(rec, 'retreat');
    else { breakGrapple(rec); news(rec.x, rec.z, 'retreat', rec, 'You cut the grapples.'); }
    markDirty(rec);
  });

  ctx.onAction('naval.plunder', (p, args) => {
    const rec = myShip(p);
    const t = targetOf(args, { wreck: true });
    if (isPlayer(t)) return plunderPlayer(p, rec, t);
    if (!(t.prize && t.prizeOf === rec.id)) fail(rec.boarding?.targetId === t.id ? 'Her crew still fight.' : 'She is not your prize.');
    if (t.plundered) fail('Her hold has already been stripped.');
    guard(t); guard(rec);
    const cls = classById(t.classId);
    const lvl = levelOf(p);
    const items = [];
    for (const key of holdKeys(cls, t.seed)) {
      const r = generateRandomLoot(key, { level: lvl, rand: mulberry32((t.seed ^ hashStr(key + items.length)) >>> 0), books: S.books, magicItem: (rand) => S.randomMagicLoot?.(lvl, rand) });
      items.push(...r.items);
    }
    ctx.dirty(p);
    for (const it of items) giveLoot(p, it);
    t.plundered = { by: p.id, at: nowS() };
    t.scuttleAt = nowS() + cfg.scuttleS;
    if (rec.boarding?.targetId === t.id) { rec.boarding.phase = 'done'; rec.boarding = null; }
    breakGrapple(rec);
    const gold = items.filter((i) => i.template === 'gold').reduce((n, i) => n + (i.quantity | 0), 0);
    ctx.emit('naval.plundered', { player: p, vessel: rec.v.id, target: shipView(t), gold, items: items.length });
    news(t.x, t.z, 'plunder', t, `The ${t.title}'s hold is broken open (${items.length} lots${gold ? `, ${gold} gold` : ''}). She will be scuttled.`);
    ctx.notify(p, { kind: 'naval', text: `You carry off ${describe(items)}.`, prize: items.map((i) => ({ template: i.template, quantity: i.quantity ?? 1 })) });
    markDirty(rec);
  });

  const wreckAgeS = (w) => {
    const dt = nowS() - w.at;
    if (dt >= 0) return dt;
    return Number.isFinite(w.atWall) ? Math.max(0, (Date.now() - w.atWall) / 1000) : Infinity;
  };

  /** Persists an owner's prize-eligible hold manifest so an offline claim can settle fairly and reconcile on rejoin. */
  function snapshotHold(v) {
    if (!v || v.ownerId == null) return null;
    const owner = ownerOnline(v);
    if (!owner) return holdSnapshots.get(String(v.id)) ?? null;
    const id = String(v.id);
    let snap;
    if (S.shipyard) {
      const ya = yardOf(v);
      if (!ya) return null;
      const goods = (ya.ship.cargo ?? [])
        .filter((c) => GOODS[c.good] && (c.qty | 0) > 0)
        .map((c) => ({ good: c.good, qty: Math.trunc(c.qty), label: GOODS[c.good].label }));
      snap = { ownerId: v.ownerId, vesselId: id, shipId: ya.shipId, goodsOnly: true, goods, items: [], at: Date.now() };
    } else {
      const hold = holdOf(owner, v);
      snap = { ownerId: v.ownerId, vesselId: id, shipId: null, goodsOnly: false, goods: [], items: structuredClone(hold.list), at: Date.now() };
    }
    const prev = holdSnapshots.get(id);
    holdSnapshots.set(id, snap);
    if (ctx.inAction()) ctx.onRollback(() => { if (prev) holdSnapshots.set(id, prev); else holdSnapshots.delete(id); });
    ctx.dirtyWorld?.(HOLD_PREFIX + id, snap);
    return snap;
  }

  function clearHoldSnapshot(vesselId) {
    const id = String(vesselId);
    if (!holdSnapshots.has(id)) return;
    const prev = holdSnapshots.get(id);
    holdSnapshots.delete(id);
    if (ctx.inAction()) ctx.onRollback(() => holdSnapshots.set(id, prev));
    ctx.dirtyWorld?.(HOLD_PREFIX + id, null);
  }

  function saveEscrow(record) {
    const prev = escrows.get(record.id);
    escrows.set(record.id, record);
    if (ctx.inAction()) ctx.onRollback(() => { if (prev) escrows.set(record.id, prev); else escrows.delete(record.id); });
    ctx.dirtyWorld?.(ESCROW_PREFIX + record.id, record);
  }

  /** Same prize law as shipyard.transferCargo, evaluated against a snapshotted offline hold. */
  function pickOfflineGoods(snapGoods, victorShip, victorStats, { maxPieces = 8, share = 1 / 3 } = {}) {
    const used = (victorShip?.cargo ?? []).reduce((n, c) => n + Math.max(0, Math.trunc(c.qty || 0)), 0);
    let room = Math.max(0, (victorStats?.capacity ?? 0) - used);
    let pieces = Math.max(0, Math.min(999, Math.trunc(maxPieces)));
    const valid = (snapGoods ?? []).filter((c) => GOODS[c.good] && Math.trunc(c.qty || 0) > 0);
    let worth = valid.reduce((n, c) => n + GOODS[c.good].base * Math.trunc(c.qty), 0) * Math.max(0, Math.min(1, Number(share) || 0));
    const moved = [];
    for (const c of [...valid].sort((x, y) => GOODS[y.good].base - GOODS[x.good].base)) {
      const n = Math.min(Math.trunc(c.qty), room, pieces, Math.floor(worth / GOODS[c.good].base));
      if (n <= 0) continue;
      room -= n;
      pieces -= n;
      worth -= n * GOODS[c.good].base;
      moved.push({ good: c.good, qty: n, label: GOODS[c.good].label });
    }
    return moved;
  }

  /** Reconciles any escrowed offline prize debits for a returning captain (atomic, idempotent, never negative). */
  function reconcileEscrows(p) {
    const due = [...escrows.values()].filter((e) => e.ownerId === p.id);
    if (!due.length) return;
    const apply = (e) => {
      if (!escrows.has(e.id)) return; // already reconciled
      ctx.dirty(p);
      let lostGoods = [];
      const lostItems = [];
      if (e.goodsOnly && S.shipyard) {
        const shipId = e.shipId && S.shipyard.ship?.(p, e.shipId) ? e.shipId : S.shipyard.active?.(p);
        if (shipId && typeof S.shipyard.debitCargo === 'function') {
          lostGoods = S.shipyard.debitCargo(p, shipId, e.goods ?? []);
        }
      } else if (!e.goodsOnly && Array.isArray(e.items) && e.items.length) {
        const hold = holdOf(p, sail()?.byId?.(e.vesselId) ?? null);
        for (const debit of e.items) {
          let idx = debit.id ? hold.list.findIndex((x) => x.id === debit.id) : -1;
          if (idx < 0) idx = hold.list.findIndex((x) => x.template === debit.template && !x.quest && !x.owner);
          if (idx < 0) continue;
          const it = hold.list[idx];
          const have = Math.max(1, it.quantity | 0 || 1);
          const take = Math.min(have, Math.max(1, debit.quantity | 0 || 1));
          if (have > take) it.quantity = have - take;
          else hold.list.splice(idx, 1);
          lostItems.push({ template: it.template, name: it.name, quantity: take });
        }
        hold.commit();
      }
      escrows.delete(e.id);
      if (ctx.inAction()) ctx.onRollback(() => escrows.set(e.id, e));
      ctx.dirtyWorld?.(ESCROW_PREFIX + e.id, null);
      if (lostGoods.length) {
        const g = lostGoods.map((x) => `${x.qty} × ${x.label ?? x.good}`).join(', ');
        ctx.afterCommit(() => ctx.notify(p, { kind: 'naval', text: `${e.victorName} took from your hold while you were away: ${g}.`, lostGoods, escrowed: true }));
      } else if (lostItems.length) {
        const names = lostItems.map((i) => `${i.quantity > 1 ? `${i.quantity} × ` : ''}${i.name ?? i.template}`).join(', ');
        ctx.afterCommit(() => ctx.notify(p, { kind: 'naval', text: `${e.victorName} took ${lostItems.length} pieces from your hold while you were away: ${names}.`, lost: lostItems, escrowed: true }));
      }
    };
    for (const e of due) {
      if (typeof ctx.runAtomic === 'function') {
        const res = ctx.runAtomic(p, 'naval.escrowReconcile', () => apply(e));
        if (res && res.ok === false) log.warn?.(`[naval] escrow ${e.id} reconcile failed for ${p.id}: ${res.error}`);
      } else {
        apply(e);
        p.dirty = true;
      }
    }
  }

  /** A wrecked or surrendered captain's hold: a third of its worth (eight pieces at most), once (online or via offline escrow). */
  function plunderPlayer(p, rec, t) {
    const owner = ownerOnline(t.v);
    const n = t.v.naval;
    const surrendered = !t.wreckOnly && t.d.state === 'struck' && rec.grappledTo === t.id;
    const wreck = n.wreck && !n.wreck.taken && n.wreck.killerVesselId === rec.id && wreckAgeS(n.wreck) <= cfg.wreckPrizeS ? n.wreck : null;
    if (!surrendered && !wreck) fail('She is not your prize.');
    if (surrendered && n.surrender?.taken) fail('Her hold has already been taken.');
    if (wreck && Math.hypot(rec.x - wreck.x, rec.z - wreck.z) > ABANDON_RANGE) fail('Sail over the wreck to haul up her cargo.');
    const prizeId = wreck ? wreck.id : (n.surrender?.id ?? `surrender:${t.id}:${Math.round((n.surrender?.at ?? 0) * 1000)}`);
    if (escrows.has(prizeId)) fail('Her hold has already been taken.');

    const goodsOnly = !!S.shipyard;
    ctx.dirty(p);
    if (!t.wreckOnly) guard(t);
    guard(rec);
    if (t.wreckOnly && ctx.inAction()) { const keep = structuredClone(t.v.naval); const v = t.v; ctx.onRollback(() => { v.naval = keep; const w = wrecks.get(t.id); if (w) w.wreck = keep.wreck; }); }

    const finish = () => {
      if (wreck) wreck.taken = true; else n.surrender.taken = true;
      if (surrendered) { breakGrapple(rec); t.d.state = 'afloat'; }
      clearHoldSnapshot(t.id);
      if (t.wreckOnly) saveVessel(t.v); else markDirty(t);
      markDirty(rec);
    };

    if (!owner) {
      // Offline loser: settle from the persisted hold snapshot and record a world_state escrow debit for when they rejoin.
      const snap = holdSnapshots.get(t.id) ?? null;
      if (goodsOnly) {
        const yb = yardOf(rec.v);
        const ybStats = yb ? S.shipyard.stats?.(yb.player, yb.shipId) : null;
        const goods = yb && snap?.goodsOnly ? pickOfflineGoods(snap.goods, yb.ship, ybStats, { maxPieces: 8, share: 1 / 3 }) : [];
        if (goods.length) {
          S.shipyard.addCargo?.(yb.player, yb.shipId, goods);
          saveEscrow({
            id: prizeId, ownerId: t.v.ownerId, vesselId: t.id, shipId: snap.shipId ?? t.v.shipId ?? null,
            victorId: p.id, victorName: p.name ?? 'a captain', vesselName: t.title,
            goodsOnly: true, goods, items: [], createdAt: Date.now(),
          });
          finish();
          const g = goods.map((x) => `${x.qty} × ${x.label ?? x.good}`).join(', ');
          ctx.notify(p, { kind: 'naval', text: `Into your hold from the ${t.title}: ${g}.`, prizeGoods: goods, escrowed: true });
          ctx.emit('naval.plundered', { player: p, vessel: rec.v.id, target: shipView(t), gold: 0, items: 0, goods, pvp: true, escrowed: true });
          return;
        }
        finish();
        ctx.notify(p, { kind: 'naval', text: 'Her hold is empty.' });
        return;
      }
      const list = snap && !snap.goodsOnly && Array.isArray(snap.items) ? snap.items : [];
      const worths = list.map((it) => ({ worth: it.quest || it.owner ? 0 : worthOf(it) }));
      const picks = seaPrizePlaces(worths).sort((a, b) => b - a);
      if (!picks.length) {
        finish();
        ctx.notify(p, { kind: 'naval', text: 'Her hold is empty.' });
        return;
      }
      const moved = picks.map((i) => structuredClone(list[i]));
      const debitItems = moved.map((it) => ({ id: it.id ?? null, template: it.template, name: it.name ?? null, quantity: Math.max(1, it.quantity | 0 || 1) }));
      const dest = p.rpg.property?.ship ? holdOf(p, rec.v) : null;
      if (dest && dest.room >= moved.length) {
        for (const it of moved) if (dest.list.some((x) => x.id === it.id)) it.id = `${it.id}-p${Math.floor(rng() * 1e6)}`;
        dest.list.push(...moved);
        dest.commit();
      } else {
        for (const it of moved) giveRecord(p, it);
      }
      saveEscrow({
        id: prizeId, ownerId: t.v.ownerId, vesselId: t.id, shipId: null,
        victorId: p.id, victorName: p.name ?? 'a captain', vesselName: t.title,
        goodsOnly: false, goods: [], items: debitItems, createdAt: Date.now(),
      });
      finish();
      const names = moved.map((i) => `${i.quantity > 1 ? `${i.quantity} × ` : ''}${i.name ?? i.template}`).join(', ');
      ctx.notify(p, { kind: 'naval', text: `You haul ${moved.length} pieces from the ${t.title}: ${names}.`, prize: moved.map((i) => ({ template: i.template, name: i.name, quantity: i.quantity })), escrowed: true });
      ctx.emit('naval.plundered', { player: p, vessel: rec.v.id, target: shipView(t), gold: 0, items: moved.length, goods: [], pvp: true, escrowed: true });
      return;
    }

    ctx.dirty(owner); // snapshot the loser before her hold changes
    // With the shipyard installed the prize is trade goods only (its transferCargo: a third of their worth, eight
    // units, the winner's room); the classic item hold (property) is never touched. Without it, the item hold pays.
    const ya = yardOf(t.v), yb = yardOf(rec.v);
    const hold = goodsOnly ? { list: [], commit() {} } : holdOf(owner, t.v);
    const worths = hold.list.map((it) => ({ worth: it.quest || it.owner ? 0 : worthOf(it) }));
    const picks = seaPrizePlaces(worths).sort((a, b) => b - a);
    const goods = ya && yb ? S.shipyard.transferCargo?.(ya.player, ya.shipId, yb.player, yb.shipId, { maxPieces: 8, share: 1 / 3 }) ?? [] : [];
    if (goods.length) {
      const g = goods.map((x) => `${x.qty} × ${x.label ?? x.good}`).join(', ');
      ctx.notify(p, { kind: 'naval', text: `Into your hold from the ${t.title}: ${g}.`, prizeGoods: goods });
      ctx.notify(owner, { kind: 'naval', text: `${p.name} takes from your hold: ${g}.`, lostGoods: goods });
    }
    if (!picks.length && goods.length) {
      finish();
      ctx.emit('naval.plundered', { player: p, vessel: rec.v.id, target: shipView(t), gold: 0, items: 0, goods, pvp: true });
      return;
    }
    if (!picks.length) {
      finish();
      ctx.notify(p, { kind: 'naval', text: 'Her hold is empty.' });
      return;
    }
    const taken = picks.map((i) => hold.list[i]);
    for (const i of picks) hold.list.splice(i, 1);
    hold.commit();
    const moved = taken.map((it) => ({ ...it }));
    // into the winner's own ship hold when she has one with room, else her pack (refused whole if it cannot take it)
    const dest = p.rpg.property?.ship ? holdOf(p, rec.v) : null;
    if (dest && dest.room >= moved.length) {
      for (const it of moved) if (dest.list.some((x) => x.id === it.id)) it.id = `${it.id}-p${Math.floor(rng() * 1e6)}`;
      dest.list.push(...moved);
      dest.commit();
    } else {
      for (const it of moved) giveRecord(p, it);
    }
    finish();
    const names = moved.map((i) => `${i.quantity > 1 ? `${i.quantity} × ` : ''}${i.name ?? i.template}`).join(', ');
    ctx.notify(p, { kind: 'naval', text: `You haul ${moved.length} pieces from the ${t.title}: ${names}.`, prize: moved.map((i) => ({ template: i.template, name: i.name, quantity: i.quantity })) });
    ctx.notify(owner, { kind: 'naval', text: `${p.name} takes ${moved.length} pieces from your hold: ${names}.`, lost: moved.map((i) => ({ template: i.template, name: i.name, quantity: i.quantity })) });
    ctx.emit('naval.plundered', { player: p, vessel: rec.v.id, target: shipView(t), gold: 0, items: moved.length, goods, pvp: true });
  }
  const saveVessel = (v) => { if (ctx.inAction()) sail()?.save?.(v); else dirtyVessels.add(v); };
  const describe = (items) => {
    const gold = items.filter((i) => i.template === 'gold').reduce((n, i) => n + (i.quantity | 0), 0);
    const rest = items.filter((i) => i.template !== 'gold').length;
    return [gold ? `${gold} gold` : null, rest ? `${rest} piece${rest === 1 ? '' : 's'} of cargo` : null].filter(Boolean).join(' and ') || 'nothing of worth';
  };
  /** A generated loot entry into the pack (throws, and the action rolls back, when the pack refuses it). */
  function giveLoot(p, it) {
    const extra = {};
    for (const k of ['magic', 'bookId', 'letter', 'recipe']) if (it[k] !== undefined) extra[k] = it[k];
    if (it.template === 'gold') { if ((it.quantity | 0) > 0) S.giveItem(p, 'gold', it.quantity | 0); return; }
    S.giveItem(p, it.template, Math.max(1, it.quantity | 0 || 1), { variant: it.variant, ...(Object.keys(extra).length ? { extra } : it.extra ? { extra: it.extra } : {}) });
  }
  /** A whole item record (from another captain's hold) into the pack. */
  function giveRecord(p, rec) {
    if (rec.template === 'gold') { if ((rec.quantity | 0) > 0) S.giveItem(p, 'gold', rec.quantity | 0); return; }
    if (rec.stackable) { S.giveItem(p, rec.template, rec.quantity | 0 || 1); return; }
    const inv = p.rpg.inventory;
    if (!Array.isArray(inv) || inv.length >= 200) fail('Your pack cannot hold her cargo. Make room first.');
    const it = { ...rec };
    delete it.equipped;
    if (inv.some((x) => x.id === it.id)) it.id = `${it.id}-p${Math.floor(rng() * 1e6)}`;
    inv.push(it);
    ctx.dirty(p);
    ctx.emit('inventoryChanged', { player: p, reason: 'naval' });
  }
  function worthOf(it) {
    const q = Math.max(1, Number(it.quantity) || 1);
    if (it.template === 'gold') return q;
    const v = Number(it.magic?.value) || Number(it.value) || Number(it.price) || 0;
    return v * q;
  }
  /** A ship's hold: the shipyard's cargo when published, else the classic property ship store. */
  function holdOf(player, v) {
    const cargo = S.shipCargo?.holdOf?.(v);
    if (cargo && Array.isArray(cargo.list)) return { list: cargo.list, room: cargo.room ?? 32, commit: () => cargo.commit?.() };
    const prop = player.rpg.property ??= {};
    const stores = prop.stores ??= {};
    const list = stores.ship ??= [];
    return { list, room: Math.max(0, MAX_HOLD - list.length), commit: () => { if (!list.length) delete stores.ship; else stores.ship = list; ctx.dirty(player); } };
  }

  ctx.onAction('naval.repair', (p) => {
    const rec = myShip(p);
    if (rec.d.state === 'sinking') fail('Too late: she is going down.');
    const y = yardOf(rec.v);
    if (!y || typeof S.shipyard.seaRepair !== 'function') fail('There is no carpenter\'s timber aboard.');
    if (rec.d.hull >= rec.d.maxHull) fail('Her hull is sound.');
    guard(rec);
    const mended = S.shipyard.seaRepair(y.player, y.shipId);
    if (!(mended > 0)) fail(y.ship.stores?.timber > 0 ? 'Her hull is sound.' : 'There is no carpenter\'s timber aboard.');
    rec.d.hull = Math.min(rec.d.maxHull, rec.d.hull + mended);
    if (rec.d.state === 'struck' && rec.d.hull > rec.d.maxHull * STRUCK_AT) { /* a surrender stands until she is released */ }
    markDirty(rec);
    ctx.notify(p, { kind: 'naval', text: `The carpenter patches her planking (+${mended} hull).` });
  });

  ctx.onAction('naval.restock', (p, args) => {
    const rec = myShip(p);
    if (!inSafeHarbour(rec)) fail('Shot and powder are sold in port.');
    if (Number.isFinite(rec.v.stores?.shot) || yardOf(rec.v)) fail('Buy shot from the shipwright (shipyard.supply).');
    const want = clamp(Math.floor(Number(args.count) || cfg.shotStock), 1, 500);
    const need = Math.max(0, want - (rec.v.naval.shot ?? 0));
    const barrels = Math.max(0, (HULL_BUILDS[rec.hull].stern?.gun === 'barrel' ? BARREL.stock : 0) - rec.deck.barrels);
    if (!need && !barrels) fail('The lockers are full.');
    const cost = need * cfg.shotPrice;
    if ((p.rpg.gold ?? 0) < cost) fail(`That is ${cost} gold; you have ${p.rpg.gold ?? 0}.`);
    guard(rec);
    if (cost) { const took = S.takeItem?.(p, 'gold', cost); if (!took && cost) { p.rpg.gold -= cost; ctx.dirty(p); } }
    rec.v.naval.shot = (rec.v.naval.shot ?? 0) + need;
    rec.deck.barrels += barrels;
    markDirty(rec);
    ctx.notify(p, { kind: 'naval', text: `Stowed ${need} shot${barrels ? ` and ${barrels} fire barrels` : ''} for ${cost} gold.` });
  });

  // a boarding foe killed: settle the fight at once
  ctx.on('kill', ({ entity } = {}) => {
    if (!entity?.naval) return;
    for (const rec of ships.values()) { if (rec.boarding) stepBoarding(rec); if (rec.repel) stepRepel(rec); }
  });
  ctx.on('connectionReset', ({ player } = {}) => { if (player) lastState.delete(player.id); });

  // ------------------------------------------------------------------ tick

  let lastT = null;
  ctx.onTick((dt) => {
    const t = nowS();
    const step = lastT == null ? dt : Math.max(0, Math.min(1, t - lastT));
    lastT = t;
    try {
      syncPlayers();
      if (!ships.size && !balls.length) return;
      stepNpcs(step, t);
      stepShips(step, t);
      stepBalls(t);
      stepRams(t);
      stepDirector(t);
      for (const [id, w] of wrecks) if (w.wreck.taken || wreckAgeS(w.wreck) > cfg.wreckPrizeS) wrecks.delete(id);
      stateAcc += step;
      if (stateAcc >= 1 / cfg.stateHz) { stateAcc = 0; publishStates(); }
      flushSaves();
    } catch (err) {
      log.error?.('[naval] tick failed', err);
    }
  });
  ctx.onJoin?.((p) => {
    try { reconcileEscrows(p); } catch (err) { log.error?.('[naval] escrow reconcile failed', err); }
    const own = sail()?.byId?.(`v${p.id}`) ?? null;
    const unclaimed = (own?.naval?.wreck && !own.naval.wreck.taken) || (own?.naval?.surrender && !own.naval.surrender.taken);
    if (own && !unclaimed) clearHoldSnapshot(own.id);
  });
  ctx.onLeave((p) => {
    if (p) {
      lastState.delete(p.id);
      const own = sail()?.byId?.(`v${p.id}`) ?? null;
      if (own && (!own.docked || (own.naval?.wreck && !own.naval.wreck.taken) || (own.naval?.surrender && !own.naval.surrender.taken))) {
        snapshotHold(own);
      }
      const ab = aboardOf(p);
      const rec = ab ? ships.get(String(ab.id)) : null;
      if (rec) {
        const remaining = crewOf(rec.v).filter((q) => q !== p);
        if (rec.boarding && !remaining.some((q) => !q.rpg?.defeated)) endBoarding(rec, 'abandoned');
        if (rec.repel && !remaining.length) { banish(rec.repel.foes); rec.repel = null; breakGrapple(rec); }
      }
    }
    flushSaves(true);
  });

  // ------------------------------------------------------------------ services

  const recFor = (v) => (v ? ships.get(String(v.id)) ?? null : null);
  S.naval = {
    actors: () => [...ships.values()].filter((r) => r.kind === 'npc').map(shipView),
    shipView: (x) => shipView(typeof x === 'string' ? ships.get(x) : x?.kind ? x : recFor(x)),
    combatOf: (v) => combatOf(recFor(v)),
    wayShare: (v) => { const r = recFor(v); return r ? wayFor(r) : (v?.naval?.d ? canvasWay(v.naval.d.sail, v.naval.d.maxSail) : 1); },
    helmBlocked: (v) => helmBlocked(recFor(v)),
    /** sailing.state `nearby` rows for NPC ships (the core lists player vessels itself). */
    project: (v) => { const r = recFor(v); const at = r ?? v; if (!at) return []; return [...ships.values()].filter((o) => o.kind === 'npc' && Math.hypot(o.x - at.x, o.z - at.z) <= cfg.viewM).map((o) => ({ ...shipView(o), distance: Math.round(Math.hypot(o.x - at.x, o.z - at.z)) })); },
    nearbyFor: (v, radius = cfg.viewM) => { const r = recFor(v); if (!r) return []; return [...ships.values()].filter((o) => o !== r && Math.hypot(o.x - r.x, o.z - r.z) <= radius).map(shipView); },
    projectiles: (near, radius = cfg.viewM) => balls.filter((b) => !near || Math.hypot(b.p0[0] - near.x, b.p0[2] - near.z) <= radius).map(ballView),
    /** Outside harm (grounding, a storm): `harm` hull points to vessel `v`. */
    damage: (v, harm, kind = 'ground') => { syncPlayers(); const r = recFor(v); if (r && harm > 0) hurt(r, { hull: Math.round(harm), sail: 0, crew: 0 }, null, { kind }); },
    // test and operator hooks
    /**
     * Is `p`'s shipyard ship `shipId` (or any of her ships, when omitted) in a fight? Hit or fired within 30 s, burning,
     * sinking, grappled, boarding or repelling boarders, or the quarry of an engaged NPC. The shipyard refuses yard
     * work while it is.
     */
    inCombat: (p, shipId = null) => {
      syncPlayers();
      const t = nowS();
      for (const rec of ships.values()) {
        if (!isPlayer(rec)) continue;
        const y = yardOf(rec.v);
        const mine = y ? y.player?.id === p?.id && (shipId == null || y.shipId === shipId) : rec.v.ownerId === p?.id && shipId == null;
        if (!mine) continue;
        const d = rec.d;
        if (t - (d.lastHitAt ?? -1e9) < 30 || t - (rec.lastFireAt ?? -1e9) < 30) return true;
        if (d.fires.length || d.state === 'sinking' || rec.grappledTo || rec.boarding || rec.repel) return true;
        for (const o of ships.values()) if (o.kind === 'npc' && o.ai?.mode === 'engage' && o.ai.targetId === rec.id) return true;
      }
      return false;
    },
    /** A bounty's quarry (admiralty): one actor per key, never again once she has gone down. */
    spawnQuarry: ({ key, classId = 'pirateBrig', x, z, name = null } = {}) => {
      if (typeof key !== 'string' || !key || !Number.isFinite(x) || !Number.isFinite(z)) return null;
      const q = quarries.get(key);
      if (q?.sunk) return null;
      if (q?.id && ships.has(q.id)) return q.id;
      const r = addNpc(classId, x, z, rng() * Math.PI * 2, { quarry: key, noDespawn: true, ...(name ? { title: String(name).slice(0, 64) } : {}) });
      if (!r) return null;
      quarries.set(key, { id: r.id });
      return r.id;
    },
    spawn: (classId, x, z, yaw = 0, extra = {}) => { const r = addNpc(classId, x, z, yaw, extra); return r ? r.id : null; },
    despawn: (id) => { const r = ships.get(id); if (r?.kind === 'npc') removeNpc(r); },
    record: (id) => ships.get(id) ?? null,
    step: (dt) => { const t = nowS(); syncPlayers(); stepNpcs(dt, t); stepShips(dt, t); stepBalls(t); stepRams(t); },
    stats: () => ({ ships: ships.size, npcs: [...ships.values()].filter((r) => r.kind === 'npc').length, balls: balls.length }),
  };
  return S.naval;
}

export default { name, install };
