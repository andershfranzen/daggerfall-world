// Authoritative sailing: owned vessels on the Iliac Bay, helm, wind, sails, oars, rudder, anchor, grounding, ports,
// crews, and persistent vessel state (docs: see the contract block below; physics in server/rpg/sailing/voyage.js).
//
// Two coordinate worlds stay separate:
//   - a crew member's own x/z/yaw are the ORIGINAL personal deck coordinates on the classic ship location
//     (services.property.shipLocation(type)); locomotion, collision and the cabin door work exactly as before;
//   - the vessel's sea pose {x, z, yaw, speed} is metres on the overland global grid (x east, z south, yaw 0 north).
//
// Every crew on one ship type shares the same classic deck location, so presence is scoped: a player on a ship deck
// or in its cabin is in scene `vessel:<id>` (a launched vessel's crew) or `own:<playerId>` (the classic personal
// ship.board path). runtime.js, game.js, peers.js and the reach checks consult `services.presenceScope` so two crews
// never see, hear, trade with or target each other. Holds stay per character (server/rpg/property.js); aboard a
// vessel only its owner reaches a hold and the cabin door.
//
// CONTRACT (services.sailing):
//   vesselFor(p) -> the live canonical vessel p owns or is aboard, or null
//   vessels() / byId(id) / crewOf(v) (online players aboard) / canCommand(p, v) / aboard(p)
//   save(v) (world row `sailing:vessel:<id>`, transactional inside actions) / publish(v, {full})
//   presenceScope(p) / refusal(p, verb) / holdAllowed(p) / wreck(v, {text}) / putAshore(p, portId?)
//   ports() / wind(x, z) / voyage (pure physics exports)
// Vessel: {id, ownerId, ownerName, type, name, x, z, yaw, speed, anchored, grounded, docked, sails, oars, rudder,
//          helmId, crewIds, hull:{hp,max}, sunk, naval:{}, launchedAt, updatedAt}
// Actions: sailing.sync, sailing.launch, sailing.board, sailing.leave, sailing.helm, sailing.control,
//          sailing.anchor, sailing.dock. Private event {kind:'sailing.state', silent, full, at, role, helm, vessel,
//          wind, nearby, ports}.
//
// Coast data (open water and the Bay's ports) comes from `services.coast` when a feature provides it, otherwise from
// server/rpg/sailing/coast.js's createCoast({dataPath, log, travel}) when that module exists.
import { exteriorTownOf } from '../../client/gameplay/property/rules.js';
import { parseLocationId } from '../../client/gameplay/travel/catalog.js';
import * as voyage from './sailing/voyage.js';
import { fromGlobal } from '../../client/world/exterior/frame.js';
import { wildernessId } from '../../client/world/wilderness/data.js';
import { installChart } from './sailing/chart.js';

const { HULLS, hullOf, windAt, stepVessel, canDock, wrap, DOCK_RANGE, DOCK_SPEED } = voyage;

export const name = 'sailing';
export const VERSION = 1;
export const ROW_PREFIX = 'sailing:vessel:';
export const RETIRED_PREFIX = 'sailing:retired:';

const REQUEST_RE = /^[\w-]{6,64}$/;
const RECENT_MAX = 64;
/** Publish cadence (ms) under way and lying still; persistence cadence while she moves. */
export const PUBLISH_MOVING_MS = 250;
export const PUBLISH_IDLE_MS = 1000;
export const SAVE_MS = 5000;
/** How far other vessels are listed (m) and how many ports a periodic state carries. */
export const NEARBY_RANGE = 3000;
export const PORTS_PERIODIC = 12;
export const MAX_CREW = 12;
/** Open-sea compression applies beyond this distance from every berth and from every other ship (m). */
export const HARBOUR_M = 1600;
export const CONTACT_M = 1500;
/** Harbours within this distance of a vessel are charted ahead of her arrival (coast.js charts on demand). */
export const WARM_M = 8000;
/** How near a charted quay (m) a player on its shore stands to board there. */
export const QUAY_REACH = 120;
/** The naval owner's opaque `vessel.naval` is persisted up to this many bytes of JSON. */
export const NAVAL_MAX_BYTES = 8192;
/** A charter's opaque booking record (server/rpg/passage.js) and an autopilot's waypoint list are bounded too. */
export const CHARTER_MAX_BYTES = 4096;
export const AUTOPILOT_MAX_POINTS = 400;
/** An autopilot takes a waypoint within this many metres, and comes in under oars within APPROACH_M of the berth. */
export const WAYPOINT_M = 60;
export const APPROACH_M = 400;
/** A captain's plotted course gives the helm back when a hostile ship comes within this many metres. */
export const COURSE_ALERT_M = 1000;
/** How long a course waits for coast.js to route a pair before giving up (ms). */
export const ROUTE_WAIT_MS = 120_000;
/** Within this of a waypoint with a hard turn after it she shortens sail; below CHANNEL_M clearance she is in a channel. */
export const TURN_SLOW_M = 400;
export const CHANNEL_M = 40;
/** Below this clearance (m) to land a vessel sails 1:1 (coast.js caps clearance at 63.75 in open water). */
export const OPEN_CLEARANCE_M = 60;
/** Shore geometry for the renderer: one read per SHORE_CELL_M cell, covering SHORE_RADIUS_M about its centre. */
export const SHORE_CELL_M = 1024;
export const SHORE_RADIUS_M = 2500;
/** Water around a vessel is prepared off the tick within this radius, again after she moves this far. */
export const PREPARE_RADIUS_M = 3000;
export const PREPARE_STEP_M = 600;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
const r3 = (v) => Math.round(v * 1000) / 1000;
const fail = (msg) => {
  throw new Error(msg);
};

const HANDLING_KEYS = ['sailMax', 'oarMax', 'oarAstern', 'turnSail', 'turnOar'];
function cleanHandling(h) {
  const out = {};
  for (const k of HANDLING_KEYS) if (Number.isFinite(h?.[k]) && h[k] >= 0 && h[k] < 50) out[k] = h[k];
  return out;
}

function cleanAutopilot(a) {
  if (!isObj(a) || typeof a.to !== 'string' || !Array.isArray(a.points)) return null;
  const points = a.points.filter((q) => isObj(q) && Number.isFinite(q.x) && Number.isFinite(q.z)).slice(0, AUTOPILOT_MAX_POINTS).map((q) => ({ x: q.x, z: q.z }));
  if (!points.length) return null;
  return { to: a.to.slice(0, 200), points, i: Math.max(0, Math.min(points.length - 1, Math.trunc(num(a.i)))), routed: a.routed === true, backUntil: num(a.backUntil) };
}

/** Normalises one persisted vessel row; null when unusable. */
export function normalizeVessel(raw) {
  if (!isObj(raw) || typeof raw.id !== 'string' || !/^v[\w-]{1,40}$/.test(raw.id)) return null;
  // A charter (server/rpg/passage.js) has no owner: ownerId null and a `charter` record.
  const isCharter = raw.ownerId === null && isObj(raw.charter);
  if (!isCharter && !Number.isSafeInteger(raw.ownerId)) return null;
  if (!HULLS[raw.type]) return null;
  if (![raw.x, raw.z, raw.yaw].every(Number.isFinite)) return null;
  const h = hullOf(raw.type);
  const hull = isObj(raw.hull) ? { ...raw.hull, hp: Math.max(0, num(raw.hull.hp, h.hull)), max: Math.max(1, num(raw.hull.max, h.hull)) } : { hp: h.hull, max: h.hull };
  return {
    id: raw.id, ownerId: raw.ownerId, ownerName: String(raw.ownerName ?? '').slice(0, 40), type: raw.type,
    name: String(raw.name ?? '').slice(0, 64) || `${raw.ownerName ?? 'A'}'s ship`,
    x: raw.x, z: raw.z, yaw: wrap(raw.yaw), speed: num(raw.speed),
    anchored: raw.anchored !== false, grounded: raw.grounded === true,
    ...(raw.grounded === true && (raw.groundedDir === 1 || raw.groundedDir === -1) ? { groundedDir: raw.groundedDir } : {}),
    docked: typeof raw.docked === 'string' ? raw.docked.slice(0, 200) : null,
    sails: [0, 0.5, 1].includes(raw.sails) ? raw.sails : 0,
    oars: [-1, 0, 1].includes(raw.oars) ? raw.oars : 0,
    rudder: Math.max(-1, Math.min(1, num(raw.rudder))),
    helmId: null, // the helm is a live hand: nobody holds it after a restart
    crewIds: Array.isArray(raw.crewIds) ? raw.crewIds.filter(Number.isSafeInteger).slice(0, MAX_CREW) : [],
    hull, sunk: raw.sunk === true,
    naval: isObj(raw.naval) && JSON.stringify(raw.naval).length <= NAVAL_MAX_BYTES ? raw.naval : {},
    ...(typeof raw.homePort === 'string' ? { homePort: raw.homePort.slice(0, 200) } : {}),
    ...(isCharter && JSON.stringify(raw.charter).length <= CHARTER_MAX_BYTES ? { charter: raw.charter } : isCharter ? { charter: {} } : {}),
    ...(cleanAutopilot(raw.autopilot) ? { autopilot: cleanAutopilot(raw.autopilot) } : {}),
    ...(typeof raw.lastPort === 'string' ? { lastPort: raw.lastPort.slice(0, 200) } : {}),
    ...(typeof raw.shipId === 'string' ? { shipId: raw.shipId.slice(0, 40) } : {}),
    ...(typeof raw.hullClass === 'string' ? { hullClass: raw.hullClass.slice(0, 20) } : {}),
    ...(isObj(raw.handling) ? { handling: cleanHandling(raw.handling) } : {}),
    launchedAt: num(raw.launchedAt), updatedAt: num(raw.updatedAt),
  };
}

/** What a vessel row stores (the live object minus nothing private: helmId is dropped on load). */
function serialize(v) {
  const out = JSON.parse(JSON.stringify({ ...v, x: r3(v.x), z: r3(v.z), yaw: r3(v.yaw), speed: r3(v.speed) }));
  if (JSON.stringify(out.naval ?? {}).length > NAVAL_MAX_BYTES) {
    console.warn(`[sailing] ${v.id}: vessel.naval exceeds ${NAVAL_MAX_BYTES} bytes; not persisted`);
    out.naval = {};
  }
  return out;
}

/** p.rpg.sailing: {version, vesselId|null, shore:{location,x,z,yaw}|null, recent:[]}. */
export function normalizeSailing(rpg) {
  const raw = isObj(rpg.sailing) ? rpg.sailing : {};
  const s = raw.shore;
  const shore = isObj(s) && typeof s.location === 'string' && [s.x, s.z, s.yaw].every(Number.isFinite)
    ? { location: s.location.slice(0, 200), x: s.x, z: s.z, yaw: s.yaw } : null;
  rpg.sailing = {
    version: VERSION,
    vesselId: typeof raw.vesselId === 'string' && /^v[\w-]{1,40}$/.test(raw.vesselId) ? raw.vesselId : null,
    shore,
    recent: (Array.isArray(raw.recent) ? raw.recent : []).filter((r) => typeof r === 'string' && REQUEST_RE.test(r)).slice(-RECENT_MAX),
  };
  return rpg.sailing;
}

export function install(ctx, options = {}) {
  const log = ctx.log ?? console;
  const services = (ctx.services ||= {});
  const vessels = new Map();
  const lastPublish = new Map(); // vessel id -> ms
  const lastSave = new Map(); // vessel id -> ms
  const lastWarm = new Map(); // vessel id -> ms
  const fullDue = new Set(); // player ids owed a full snapshot
  const weatherCache = new Map(); // vessel id -> {at, type}
  let coast = options.coast ?? null;
  let coastError = null;
  let seaCompressionDefault = 1;

  // ------------------------------------------------------------------ coast

  function coastService() {
    if (services.coast) return services.coast;
    return coast;
  }
  // Lazy: the chart is read only when someone with a ship (or a vessel at sea) needs it, never for a fresh world or a
  // landlocked player. One load per server; every caller shares it.
  let coastStarted = !!coast || options.loadCoast === false;
  let coastLoading;
  let shutDown = false;
  function ensureCoast() {
    if (shutDown) return Promise.resolve();
    if (coastStarted || services.coast) return coastLoading ?? coastService()?.ready;
    coastStarted = true;
    coastLoading = import('./sailing/coast.js')
      .then((m) => {
        if (services.coast || shutDown) return; // shutdown before the module finished importing: never start a worker
        const make = m.createCoast ?? m.default;
        if (typeof make !== 'function') throw new Error('coast.js has no createCoast');
        coast = make({ dataPath: ctx.dataPath, log, travel: services.travel, config: ctx.config });
        madeCoast = true;
        // Shared with the shipyard's harbour board and anyone else who reads the chart.
        if (!services.coast) services.coast = coast;
        if (Number.isFinite(m.SEA_COMPRESSION)) seaCompressionDefault = m.SEA_COMPRESSION;
        // Once the chart is open, chart the harbours captains are standing in and vessels are sailing near.
        return Promise.resolve(coast?.ready).then(() => {
          for (const q of ctx.players.values()) if (wantsSea(q)) warmTown(exteriorTownOf(ctx.location(q)));
          for (const v of vessels.values()) {
            if (v.docked) warmTown(v.docked);
            else warmPorts(v.x, v.z);
          }
        }).catch(() => {});
      })
      .catch((err) => {
        coastError = err?.code === 'ERR_MODULE_NOT_FOUND' ? 'The sea charts are not installed on this server.' : String(err?.message ?? err);
        log.warn?.(`[sailing] no coast: ${coastError}`);
      });
    return coastLoading;
  }
  const wantsSea = (p) => !!p?.rpg && (!!p.rpg.sailing?.vesselId || !!p.rpg.property?.ship || (p.rpg.shipyard?.ships?.length ?? 0) > 0 || !!services.shipyard?.deckType?.(p));
  // Server shutdown (server/game.js emits 'shutdown'): close the coast's workers we started so the process can exit.
  let madeCoast = false;
  ctx.on?.('shutdown', () => {
    shutDown = true;
    if (madeCoast) {
      try {
        coast?.close?.();
      } catch (err) {
        log.warn?.(`[sailing] coast close failed: ${err?.message ?? err}`);
      }
    }
  });
  const coastReady = () => coastService()?.status === 'ready' ? coastService() : null;
  function needCoast() {
    ensureCoast();
    const c = coastReady();
    if (!c) fail(coastService()?.status === 'loading' ? 'The harbour master is still reading the charts. Try again in a moment.' : (coastError ?? 'There are no sea charts on this server.'));
    return c;
  }
  /** A planned berth (coast.js plans on demand: an unplanned entry has berthReady:false and no x/z yet). */
  const berthed = (pt) => (pt && pt.berthReady !== false && Number.isFinite(pt.x) && Number.isFinite(pt.z) ? pt : null);
  const portById = (id) => {
    if (!id) return null;
    const c = coastReady();
    return c ? berthed(c.portOf?.(id) ?? c.ports().find((p) => p.id === id) ?? null) : null;
  };
  /** nearestPort with a planned berth (the winner is planned by coast.js if it was not yet). */
  const nearestBerth = (x, z) => {
    const r = coastReady()?.nearestPort?.(x, z);
    return r && berthed(r.port) ? r : null;
  };
  installChart(ctx, async () => { await ensureCoast(); return needCoast(); }, ashorePort);
  const isWater = (x, z) => {
    const c = coastReady();
    return c ? !!c.isWater(x, z) : true;
  };

  // ------------------------------------------------------------------ load

  for (const [key, value] of ctx.loadWorld(ROW_PREFIX)) {
    const v = normalizeVessel(value);
    if (v && key === ROW_PREFIX + v.id) vessels.set(v.id, v);
    else log.warn?.(`[sailing] dropped malformed vessel row ${key}`);
  }

  // ------------------------------------------------------------------ helpers

  const location = (p) => ctx.location(p);
  const stateOf = (p) => {
    if (!isObj(p.rpg)) p.rpg = {};
    if (!isObj(p.rpg.sailing) || p.rpg.sailing.version !== VERSION) normalizeSailing(p.rpg);
    return p.rpg.sailing;
  };
  const online = (id) => {
    for (const q of ctx.players.values()) if (q.id === id) return q;
    return null;
  };
  // SHIPYARD (server/rpg/shipyard.js): the captain's flagship decides the deck; else the classic property deed.
  const shipTypeOf = (p) => services.shipyard?.deckType?.(p) ?? (services.property?.ownsShip?.(p) ? p.rpg?.property?.ship?.type ?? null : null);
  const deckOf = (v) => services.property?.shipLocation?.(v.type) ?? null;
  const isShipPlace = (loc) => !!services.property?.isShipLocation?.(loc);
  const ownVessel = (p) => vessels.get(`v${p.id}`) ?? null;

  /**
   * SHIPYARD handling: the flagship's class and rigging refits set her way and turn (services.shipyard.statsOf:
   * speed m/s at sea, turn relative to the small ship's 0.75, oars for a rowboat). Kept on the vessel row so she
   * handles the same while her owner is offline. Without the shipyard she keeps her deck type's figures.
   */
  function yardHandling(v) {
    let st = null;
    try {
      st = v.shipId ? services.shipyard?.statsOf?.(v) ?? null : null;
    } catch {
      st = null;
    }
    if (!st) return false;
    const base = hullOf(v.type);
    const turn = Number.isFinite(st.turn) && st.turn > 0 ? st.turn / 0.75 : 1;
    const speed = Number.isFinite(st.speed) && st.speed > 0 ? st.speed : base.sailMax;
    const next = cleanHandling({
      sailMax: st.oars ? 0 : speed, oarMax: st.oars ? speed : base.oarMax, oarAstern: st.oars ? speed * 0.6 : base.oarAstern,
      turnSail: base.turnSail * turn, turnOar: base.turnOar * turn,
    });
    if (JSON.stringify(next) === JSON.stringify(v.handling ?? null)) return false;
    touch(v);
    v.handling = next;
    return true;
  }

  function aboard(p) {
    if (!p?.rpg) return null;
    const id = p.rpg.sailing?.vesselId;
    if (!id) return null;
    const v = vessels.get(id);
    return v && isShipPlace(location(p)) ? v : null;
  }
  const crewOf = (v) => [...ctx.players.values()].filter((q) => q.rpg?.sailing?.vesselId === v.id && isShipPlace(location(q)));
  const canCommand = (p, v) => !!p && !!v && !v.sunk && (v.ownerId === p.id || v.helmId === p.id) && aboard(p) === v;

  /** Snapshot a vessel so a failed action restores it. */
  const touched = new WeakSet();
  function touch(v) {
    if (!ctx.inAction?.() || touched.has(v)) return;
    touched.add(v);
    const before = structuredClone(v);
    ctx.onRollback(() => {
      for (const k of Object.keys(v)) delete v[k];
      Object.assign(v, before);
    });
    ctx.afterCommit(() => touched.delete(v));
    ctx.onRollback(() => touched.delete(v));
  }

  function save(v) {
    v.updatedAt = Date.now();
    lastSave.set(v.id, ctx.now());
    ctx.dirtyWorld(ROW_PREFIX + v.id, serialize(v));
  }
  function forget(v) {
    vessels.delete(v.id);
    lastPublish.delete(v.id);
    lastSave.delete(v.id);
    ctx.dirtyWorld(ROW_PREFIX + v.id, null);
  }

  function claimRequest(st, args) {
    const rid = args?.requestId;
    if (rid == null) return;
    if (typeof rid !== 'string' || !REQUEST_RE.test(rid)) fail('Invalid request.');
    if (st.recent.includes(rid)) fail('That was already done.');
    st.recent.push(rid);
    if (st.recent.length > RECENT_MAX) st.recent.splice(0, st.recent.length - RECENT_MAX);
  }

  function move(p, landing, label) {
    if (typeof services.portals?.transfer === 'function') {
      services.portals.transfer(p, landing, { label });
      return;
    }
    const from = location(p);
    ctx.dirty(p);
    p.rpg.location = landing.location;
    delete p.rpg.portal;
    Object.assign(p, { x: landing.x, z: landing.z, yaw: landing.yaw, moving: false, forward: 0, strafe: 0 });
    ctx.notify(p, { kind: 'teleport', location: landing.location, x: landing.x, y: landing.y ?? 0, z: landing.z, yaw: landing.yaw, label });
    ctx.emit('locationChanged', { player: p, from, to: landing.location });
  }

  const say = (p, text, extra = {}) => ctx.notify(p, { kind: 'sailing', text, ...extra });
  const tellCrew = (v, text, extra = {}) => {
    for (const q of crewOf(v)) say(q, text, extra);
  };

  function newVessel(p, port) {
    const type = shipTypeOf(p);
    const h = hullOf(type);
    const label = type === 'large' ? 'galleon' : 'ship';
    return {
      id: `v${p.id}`, ownerId: p.id, ownerName: String(p.name ?? '').slice(0, 40), type, shipId: `legacy-${type}`, hullClass: type,
      name: `${p.name}'s ${label}`.slice(0, 64),
      x: port.x, z: port.z, yaw: wrap(num(port.yaw)), speed: 0,
      anchored: true, grounded: false, docked: port.id, sails: 0, oars: 0, rudder: 0,
      helmId: null, crewIds: [], hull: { hp: h.hull, max: h.hull }, sunk: false, naval: {},
      launchedAt: 0, updatedAt: Date.now(),
    };
  }

  function weatherFor(v) {
    const now = ctx.now();
    const c = weatherCache.get(v.id);
    if (c && now - c.at < 10_000) return c.type;
    let type = null;
    try {
      const near = nearestBerth(v.x, v.z)?.port?.id ?? v.docked;
      type = near ? services.weatherAt?.(near)?.type ?? null : null;
    } catch {
      type = null;
    }
    weatherCache.set(v.id, { at: now, type });
    return type;
  }
  const minutes = () => num(services.worldClock?.()?.minutes, ctx.now() / 1000);
  const windFor = (v) => windAt(minutes(), v.z, weatherFor(v));

  function landOnDeck(v, slot) {
    const deck = deckOf(v);
    services.collision?.preload?.(deck);
    services.interiors?.survey?.(deck)?.catch?.(() => {});
    const x = (slot % 3 - 1) * 1.5;
    const z = Math.floor(slot / 3) * 1.5;
    const y = services.collision?.groundAt?.(deck, x, z);
    return { location: deck, x, y: Number.isFinite(y) ? y : undefined, z, yaw: 0 };
  }

  function syncCrewIds(v) {
    const ids = crewOf(v).map((q) => q.id);
    const offline = v.crewIds.filter((id) => !online(id));
    v.crewIds = [...new Set([...ids, ...offline])].slice(0, MAX_CREW);
  }

  // ------------------------------------------------------------------ state

  function vesselView(v, wind) {
    const crew = crewOf(v);
    return {
      id: v.id, ownerId: v.ownerId, ownerName: v.ownerName, type: v.type, name: v.name,
      x: r3(v.x), z: r3(v.z), yaw: r3(v.yaw), speed: r3(v.speed),
      anchored: v.anchored, grounded: v.grounded, docked: v.docked, sunk: v.sunk,
      sails: v.sails, oars: v.oars, rudder: v.rudder, helmId: v.helmId,
      helmName: crew.find((q) => q.id === v.helmId)?.name ?? null,
      crew: crew.map((q) => ({ id: q.id, name: q.name })),
      hull: { ...v.hull }, length: hullOf(v.type).length, deck: deckOf(v),
      // A plotted course (autopilot) as the crew should see it: the remaining waypoints to the destination berth.
      course: v.autopilot ? {
        to: v.autopilot.to, name: portById(v.autopilot.to)?.name ?? null, routed: !!v.autopilot.routed,
        points: v.autopilot.points.slice(v.autopilot.i, v.autopilot.i + 64).map((q) => ({ x: r3(q.x), z: r3(q.z) })),
      } : null, deckBow: voyage.DECK_BOW[v.type] ?? 0, timeScale: v.timeScale ?? 1,
      shipId: v.shipId ?? null, hullClass: v.hullClass ?? v.type, ...(v.handling ? { handling: { ...v.handling } } : {}),
      ...(wind ? { pointOfSail: r3(voyage.sailPower(v.type, v.yaw, wind.from)), classicPower: r3(voyage.classicSailPower(v.type, v.yaw, wind.from)) } : {}),
      naval: v.naval,
    };
  }

  function nearbyOf(v, viewer) {
    const out = [];
    for (const o of vessels.values()) {
      if (o === v || o.sunk) continue;
      const d = Math.hypot(o.x - v.x, o.z - v.z);
      if (d > NEARBY_RANGE) continue;
      out.push({ id: o.id, kind: o.charter ? 'charter' : 'player', type: o.type, name: o.name, ownerName: o.ownerName, x: r3(o.x), z: r3(o.z), yaw: r3(o.yaw), speed: r3(o.speed), anchored: o.anchored, docked: o.docked, distance: Math.round(d) });
    }
    try {
      const extra = services.naval?.project?.(v, viewer) ?? services.naval?.nearbyFor?.(v);
      if (extra) for (const e of extra) if (isObj(e) && e.id !== v.id && !out.some((o) => o.id === e.id)) out.push(e);
    } catch (err) {
      log.error?.('[sailing] naval projection failed:', err);
    }
    // Admiralty (server/rpg/admiralty.js): how this viewer stands with each ship (navy hunting a pirate: hostile).
    if (typeof services.admiralty?.stanceFor === 'function') {
      for (const e of out) {
        try {
          e.stance = services.admiralty.stanceFor(viewer, e) ?? null;
        } catch {
          e.stance = null;
        }
        if (e.stance === 'hostile') e.hostile = true;
      }
    }
    out.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
    return out;
  }

  /** coast.js port towns ({id, name, region, px, py}); [] when the coast lists only charted ports. */
  function portStubs() {
    try {
      const list = coastReady()?.portTowns?.();
      return Array.isArray(list) ? list.filter((t) => t && typeof t.id === 'string' && t.harbour !== false && Number.isFinite(t.px) && Number.isFinite(t.py)) : [];
    } catch {
      return [];
    }
  }
  /** Ask coast.js to chart the harbours near a point (a vessel closing a coast, a captain in a port town). */
  const warmed = new Map(); // port id -> ms
  function warmPorts(x, z, radius = WARM_M) {
    const c = coastReady();
    if (!c?.portOf) return;
    const now = ctx.now();
    for (const t of portStubs()) {
      const at = voyage.pixelToSea(t.px, t.py);
      if (Math.hypot(at.x - x, at.z - z) > radius) continue;
      if (now - (warmed.get(t.id) ?? -Infinity) < 30_000) continue;
      warmed.set(t.id, now);
      try {
        c.portOf(t.id);
        services.overland?.whenPlaced?.(t.id)?.catch?.(() => {});
      } catch {
        /* charting is best effort */
      }
    }
  }
  /**
   * coast.js reads a cold coastal pixel on the main thread (~2 ms); prepareAround loads the water about a point off
   * the tick so the physics' isWater/segmentClear stay ~0.05 ms. Re-asked when she has moved PREPARE_STEP_M.
   */
  const prepared = new Map(); // vessel id -> {x, z}
  function prepareSea(v, force = false) {
    const c = coastReady();
    if (typeof c?.prepareAround !== 'function') return;
    const last = prepared.get(v.id);
    if (!force && last && Math.hypot(last.x - v.x, last.z - v.z) < PREPARE_STEP_M) return;
    prepared.set(v.id, { x: v.x, z: v.z });
    try {
      Promise.resolve(c.prepareAround(v.x, v.z, PREPARE_RADIUS_M)).catch(() => {});
    } catch {
      /* best effort */
    }
  }

  /**
   * Shore geometry near a vessel for the renderer (coast.shoreNear, cached by coast.js per 1024 m cell): computed off
   * the tick after prepareAround, once per SHORE_CELL_M cell, and sent to a crew member only when its cell changes.
   */
  const shores = new Map(); // vessel id -> {key, data}
  const shoreBusy = new Set(); // vessel ids with a pending shore read
  const shoreSent = new Map(); // player id -> shore key last sent
  const shoreKey = (x, z) => `${Math.floor(x / SHORE_CELL_M)},${Math.floor(z / SHORE_CELL_M)}`;
  function refreshShore(v) {
    const c = coastReady();
    if (typeof c?.shoreNear !== 'function' || shoreBusy.has(v.id)) return;
    const key = shoreKey(v.x, v.z);
    if (shores.get(v.id)?.key === key) return;
    shoreBusy.add(v.id);
    const at = { x: (Math.floor(v.x / SHORE_CELL_M) + 0.5) * SHORE_CELL_M, z: (Math.floor(v.z / SHORE_CELL_M) + 0.5) * SHORE_CELL_M };
    // shoreNear traces in coast.js's worker; the vessel's own prepareSea (3 km) already warms the water about her, so
    // no second prepareAround runs here (two overlapping runs stalled the loop in the real-data profile).
    new Promise((r) => setImmediate(r))
      .then(() => (shutDown || !vessels.has(v.id) ? null : c.shoreNear(at.x, at.z, SHORE_RADIUS_M)))
      .then((data) => {
        if (data && !shutDown && vessels.has(v.id)) shores.set(v.id, { key, data });
      })
      .catch((err) => log.warn?.(`[sailing] shore near ${v.id}: ${err?.message ?? err}`))
      .finally(() => shoreBusy.delete(v.id));
  }

  function warmTown(id) {
    const c = coastReady();
    if (!c?.portOf || typeof id !== 'string') return;
    try {
      c.portOf(id);
      services.overland?.whenPlaced?.(id)?.catch?.(() => {}); // the town frame its quay is placed in
    } catch {
      /* best effort */
    }
  }

  function portsFor(v, full) {
    const c = coastReady();
    if (!c) return [];
    // Planned berths are charted; unplanned port towns (berthReady:false) sit at their map pixel's centre.
    const list = c.ports().filter((pt) => pt.harbour !== false).map((pt) => {
      const b = berthed(pt);
      const at = b ?? (Number.isFinite(pt.px) && Number.isFinite(pt.py) ? voyage.pixelToSea(pt.px, pt.py) : null);
      if (!at) return null;
      return { id: pt.id, name: pt.name, region: pt.region, x: r3(at.x), z: r3(at.z), yaw: b ? r3(num(b.yaw)) : null, charted: !!b, distance: Math.round(Math.hypot(at.x - v.x, at.z - v.z)) };
    }).filter(Boolean);
    // Port towns whose harbour is not charted yet (coast.js charts on demand): their map pixel's centre.
    const known = new Set(list.map((pt) => pt.id));
    for (const t of portStubs()) {
      if (known.has(t.id)) continue;
      const at = voyage.pixelToSea(t.px, t.py);
      list.push({ id: t.id, name: t.name, region: t.region, x: r3(at.x), z: r3(at.z), yaw: null, charted: false, distance: Math.round(Math.hypot(at.x - v.x, at.z - v.z)) });
    }
    list.sort((a, b) => a.distance - b.distance);
    return full ? list : list.slice(0, PORTS_PERIODIC);
  }

  // Per-player ordering of sailing.state (resets with the server; clients drop older seq within one session).
  const seqs = new Map();
  const nextSeq = (p) => {
    const n = (seqs.get(p.id) ?? 0) + 1;
    seqs.set(p.id, n);
    return n;
  };

  function roleOf(p, v) {
    if (v.ownerId === p.id) return 'captain';
    if (v.helmId === p.id) return 'helm';
    return 'passenger';
  }

  function stateEvent(p, v, full) {
    const wind = windFor(v);
    refreshShore(v);
    const shore = shores.get(v.id);
    const sendShore = shore && (full || shoreSent.get(p.id) !== shore.key);
    if (sendShore) shoreSent.set(p.id, shore.key);
    return {
      ...(sendShore ? { coast: shore.data, coastKey: shore.key } : {}),
      kind: 'sailing.state', silent: true, full: !!full, at: Math.round(ctx.now()), seq: nextSeq(p),
      role: roleOf(p, v), helm: v.helmId === p.id,
      vessel: vesselView(v, wind), wind: { from: r3(wind.from), speed: wind.speed },
      nearby: nearbyOf(v, p), ports: portsFor(v, full),
      ...(full ? { dockRange: DOCK_RANGE, dockSpeed: DOCK_SPEED } : {}),
    };
  }

  function publish(v, { full = false, only = null } = {}) {
    lastPublish.set(v.id, ctx.now());
    for (const q of only ? [only] : crewOf(v)) {
      const isFull = full || fullDue.delete(q.id);
      ctx.notify(q, stateEvent(q, v, isFull));
    }
  }

  function ashorePort(p) {
    const loc = location(p);
    return loc.startsWith('wilderness:') ? portAtQuay(p) : portById(exteriorTownOf(loc));
  }

  /** Sync with no vessel: tell the client plainly (ashore, or the ship it owns). */
  function ashoreEvent(p) {
    const own = ownVessel(p);
    const pt = ashorePort(p);
    const quay = [];
    if (pt) {
      for (const id of services.partyOf?.(p)?.memberIds ?? []) {
        if (id === p.id) continue;
        const member = online(id);
        const v = member && ownVessel(member);
        if (v && !v.sunk && v.docked === pt.id) quay.push({ id: v.id, name: v.name, ownerName: v.ownerName });
      }
      // A charter at this quay with a passage booked for this player (server/rpg/passage.js).
      for (const v of vessels.values()) {
        if (v.charter && !v.sunk && v.docked === pt.id && (v.charter.passengerIds ?? []).includes(p.id)) quay.push({ id: v.id, name: v.name, ownerName: v.ownerName, charter: true });
      }
    }
    return {
      kind: 'sailing.state', silent: true, full: true, at: Math.round(ctx.now()), seq: nextSeq(p), role: null, helm: false, vessel: null,
      own: own ? vesselView(own) : null, ownsShip: !!shipTypeOf(p),
      port: pt ? { id: pt.id, name: pt.name, region: pt.region } : null,
      quay,
      ports: own ? portsFor(own, true) : [],
      coast: coastService()?.status ?? (coastError ? 'failed' : 'loading'),
    };
  }

  // ------------------------------------------------------------------ crew movement

  function joinCrew(p, v) {
    const st = stateOf(p);
    const crew = crewOf(v);
    if (crew.length >= MAX_CREW) fail('There is no room aboard.');
    st.shore = { location: location(p), x: r3(p.x), z: r3(p.z), yaw: r3(p.yaw) };
    services.mount?.dismount?.(p);
    if (p.rpg.mount?.riding) p.rpg.mount.riding = false;
    move(p, landOnDeck(v, crew.length), v.name);
    st.vesselId = v.id;
    ctx.dirty(p);
    touch(v);
    syncCrewIds(v);
    fullDue.add(p.id);
    ctx.emit('sailingAboardChanged', { player: p, vessel: v });
  }

  /**
   * Where a port's quay puts a person ashore, in the town's own frame. coast.js gives the quay in GLOBAL metres;
   * the town frame comes from services.overland.localOf (the town's placement). Until that town is placed, the
   * town's arrival point (0, 0) is used.
   */
  function quayLanding(port) {
    const q = port?.quay;
    const fallback = { location: port.id, x: 0, y: 0, z: 0, yaw: 0 };
    if (!q || ![q.x, q.z].every(Number.isFinite)) return fallback;
    const ov = services.overland;
    try {
      // The quay inside the town's own block grid: stand there in the town (overland's destinationAt rule).
      const f = ov?.townFrame?.(port.id);
      const g = fromGlobal(q.x, q.z);
      if (f?.rect && f.px === g.px && f.py === g.py && g.x >= f.rect.minX && g.x <= f.rect.maxX && g.z >= f.rect.minZ && g.z <= f.rect.maxZ) {
        const at = ov.localOf(port.id, q.x, q.z);
        if (at && Number.isFinite(at.x) && Number.isFinite(at.z)) return { location: port.id, x: r3(at.x), y: 0, z: r3(at.z), yaw: num(q.yaw) };
      }
      // The harbour lies outside the town (Daggerfall's roadstead is pixels away): the quay's own wilderness pixel.
      if (f || ov?.status === 'ready') {
        if (ov?.townAt?.(g.px, g.py) && !(f && f.px === g.px && f.py === g.py)) {
          // Another town stands in that pixel: use the global frame through overland when it can.
          const other = ov.townAt(g.px, g.py);
          const at = ov.localOf(other.id, q.x, q.z);
          if (at && Number.isFinite(at.x)) return { location: other.id, x: r3(at.x), y: 0, z: r3(at.z), yaw: num(q.yaw) };
        }
        return { location: wildernessId(g.px, g.py), x: r3(g.x), y: 0, z: r3(g.z), yaw: num(q.yaw) };
      }
      // No overland service (fixtures): the town frame if it answers.
      const at = ov?.localOf?.(port.id, q.x, q.z);
      if (at && Number.isFinite(at.x) && Number.isFinite(at.z)) return { location: port.id, x: r3(at.x), y: 0, z: r3(at.z), yaw: num(q.yaw) };
    } catch (err) {
      log.warn?.(`[sailing] quay landing for ${port.id}: ${err?.message ?? err}`);
    }
    return fallback;
  }
  /** QUAY_REACH: a player standing this close to a charted quay (global metres) is at that harbour. */
  function portAtQuay(p) {
    const loc = location(p);
    let g = null;
    try {
      g = services.overland?.globalOf?.(loc, p.x, p.z) ?? null;
    } catch {
      g = null;
    }
    if (!g || !Number.isFinite(g.e)) return null;
    let best = null;
    for (const pt of coastReady()?.ports?.() ?? []) {
      const q = pt.quay;
      if (!q) continue;
      const d = Math.hypot(q.x - g.e, q.z - g.s);
      if (d <= QUAY_REACH && (!best || d < best.d)) best = { pt, d };
    }
    return best?.pt ?? null;
  }

  /** Put p ashore at a port's quay (or where they boarded when that was this port). Nothing here throws. */
  function putAshore(p, portId = null) {
    const st = stateOf(p);
    const v = st.vesselId ? vessels.get(st.vesselId) : null;
    const port = portId ? portById(portId) : null;
    let landing = null;
    if (port) landing = quayLanding(port);
    if (st.shore && (!port || st.shore.location === port.id)) landing = { ...st.shore, y: 0 };
    if (!landing && port) landing = { location: port.id, x: 0, y: 0, z: 0, yaw: 0 };
    if (!landing) landing = { location: ctx.defaultLocation, x: 0, y: 0, z: 0, yaw: 0 };
    ctx.dirty(p);
    st.vesselId = null;
    st.shore = null;
    if (v) {
      touch(v);
      if (v.helmId === p.id) v.helmId = null;
      v.crewIds = v.crewIds.filter((id) => id !== p.id);
    }
    move(p, landing, 'the shore');
    ctx.emit('sailingAboardChanged', { player: p, vessel: null });
    return landing;
  }

  // ------------------------------------------------------------------ lifecycle

  if (vessels.size) ensureCoast();

  ctx.onJoin((p) => {
    const st = stateOf(p);
    fullDue.add(p.id);
    if (wantsSea(p)) {
      ensureCoast();
      warmTown(exteriorTownOf(location(p)));
    }
    // A vessel whose owner no longer holds the deed (sold, or a save from before) is broken up.
    const own = ownVessel(p);
    if (own && !shipTypeOf(p)) {
      for (const q of crewOf(own)) if (q !== p) putAshoreQuietly(q, own.docked);
      forget(own);
    }
    if (!st.vesselId) return;
    const v = vessels.get(st.vesselId);
    if (!v || v.sunk) {
      putAshoreQuietly(p, v?.docked ?? retired.get(st.vesselId) ?? null);
      return;
    }
    // Reconnect: back on the deck they left (their own deck feet are kept).
    if (location(p) !== deckOf(v) && !(isShipPlace(location(p)) && exteriorTownOf(location(p)) === deckOf(v))) {
      p.rpg.location = deckOf(v);
      delete p.rpg.portal;
      Object.assign(p, { x: 0, z: 0, yaw: 0 });
    }
    if (!v.crewIds.includes(p.id)) v.crewIds.push(p.id);
  });

  /** Outside any action (join): move without the transfer service. */
  function putAshoreQuietly(p, portId) {
    const st = stateOf(p);
    const v = st.vesselId ? vessels.get(st.vesselId) : null;
    const port = portId ? portById(portId) : null;
    const landing = st.shore
      ?? (port ? quayLanding(port) : null)
      ?? (portId ? { location: portId, x: 0, z: 0, yaw: 0 } : { location: ctx.defaultLocation, x: 0, z: 0, yaw: 0 });
    st.vesselId = null;
    st.shore = null;
    if (v) {
      if (v.helmId === p.id) v.helmId = null;
      if (v.crewIds.includes(p.id)) {
        v.crewIds = v.crewIds.filter((id) => id !== p.id);
        save(v);
      }
    }
    if (landing) {
      p.rpg.location = landing.location;
      delete p.rpg.portal;
      Object.assign(p, { x: landing.x, z: landing.z, yaw: landing.yaw, moving: false });
    }
    ctx.dirty(p);
  }

  ctx.onLeave((p) => {
    fullDue.delete(p.id);
    shoreSent.delete(p.id);
    const v = aboard(p);
    if (!v) return;
    if (v.helmId === p.id) {
      v.helmId = null;
      v.rudder = 0;
    }
    // Nobody left aboard: she lets go her anchor rather than sail on unattended.
    if (!crewOf(v).some((q) => q !== p) && !v.docked && !v.anchored && !v.charter) {
      delete v.autopilot;
      v.anchored = true;
      v.sails = 0;
      v.oars = 0;
    }
    save(v); // her last pose, and any helm or anchor change
  });

  // The shipyard changed a captain's ship (refit, repair, crew, bind): her handling and hull follow; the crew hears.
  ctx.on?.('shipyardChanged', (ev) => {
    const v = ev?.player ? ownVessel(ev.player) : null;
    if (!v || (ev.shipId && v.shipId && ev.shipId !== v.shipId)) return;
    yardHandling(v);
    save(v);
    if (crewOf(v).length) publish(v);
  });

  ctx.on?.('connectionReset', (ev) => {
    if (ev?.player) fullDue.add(ev.player.id);
  });

  // Any way off the ship other than the gangway (teleport, recall, death elsewhere) ends a crew member's passage.
  ctx.on?.('locationChanged', (ev) => {
    const p = ev?.player;
    if (p && wantsSea(p)) warmTown(exteriorTownOf(ev.to));
    const id = p?.rpg?.sailing?.vesselId;
    if (!id || isShipPlace(ev.to)) return;
    const v = vessels.get(id);
    ctx.dirty(p);
    p.rpg.sailing.vesselId = null;
    p.rpg.sailing.shore = null;
    if (v) {
      touch(v);
      if (v.helmId === p.id) v.helmId = null;
      v.crewIds = v.crewIds.filter((x) => x !== p.id);
      save(v);
    }
  });

  // Fast travel from a deck would leave the ship behind at sea.
  if (services.preventTravel instanceof Map) {
    services.preventTravel.set('sailing', (p) => (aboard(p) ? 'You are aboard ship. Make fast at a port and go ashore first.' : null));
  } else {
    services.preventTravel = new Map([['sailing', (p) => (aboard(p) ? 'You are aboard ship. Make fast at a port and go ashore first.' : null)]]);
  }

  // ------------------------------------------------------------------ tick

  ctx.onTick((dt) => {
    const now = ctx.now();
    const all = [...vessels.values()];
    // NPC hulls (server/rpg/naval.js) are obstacles too: a vessel stops short of them; ramming is naval's.
    let navalActors = [];
    try {
      const rows = services.naval?.actors?.();
      if (rows) navalActors = [...rows].filter((o) => o && Number.isFinite(o.x) && Number.isFinite(o.z) && !o.sunk).map((o) => ({ id: o.id, x: o.x, z: o.z, yaw: o.yaw, type: HULLS[o.type] ? o.type : 'small' }));
    } catch {
      navalActors = [];
    }
    for (const v of all) {
      // Deeds sold while the owner is online: the vessel is broken up once everyone is ashore.
      const owner = online(v.ownerId);
      if (owner && !shipTypeOf(owner) && !crewOf(v).length) {
        forget(v);
        continue;
      }
      const crew = crewOf(v);
      if (![v.x, v.z, v.yaw, v.speed].every(Number.isFinite)) recoverPose(v, now);
      if (v.docked && v.autopilot?.pending && !v.sunk) awaitRoute(v, now);
      if (v.sunk || v.docked) {
        if (crew.length && now - (lastPublish.get(v.id) ?? -Infinity) >= PUBLISH_IDLE_MS) publish(v);
        continue;
      }
      if (v.autopilot) steerAutopilot(v, now);
      if (!crew.length && !v.anchored && !v.charter) {
        delete v.autopilot;
        v.anchored = true;
        v.sails = 0;
        v.oars = 0;
      }
      const moving = v.speed !== 0 || (!v.anchored && (v.sails > 0 || v.oars !== 0));
      if (moving) {
        const wasX = v.x, wasZ = v.z, wasSpeed = v.speed;
        if (now - (lastWarm.get(v.id) ?? -Infinity) >= 2000) {
          lastWarm.set(v.id, now);
          warmPorts(v.x, v.z);
          prepareSea(v);
        }
        const others = all.filter((o) => o !== v && !o.sunk).concat(navalActors);
        const scale = seaScale(v, others);
        if (scale !== (v.timeScale ?? 1)) v.timeScale = scale;
        const c = coastReady();
        const r = stepVessel(v, dt, {
          wind: windFor(v), isWater, wayShare: navalWayShare(v), others, timeScale: scale,
          segmentClear: typeof c?.segmentClear === 'function' ? (ax, az, bx, bz) => c.segmentClear(ax, az, bx, bz).ok !== false : null,
        });
        if (r.grounded) {
          tellCrew(v, 'She runs aground! Back your oars or turn her head to open water.', { grounded: true });
          ctx.emit('sailingGrounded', { vessel: v, harm: r.harm });
        }
        if (r.harm > 0) {
          v.hull.hp = Math.max(0, v.hull.hp - r.harm);
          if (v.hull.hp <= 0) wreck(v, { text: 'Her hull is stove in on the rocks. You struggle ashore.' });
        }
        if (r.struck) ctx.emit('sailingCollision', { vessel: v, other: vessels.get(r.struck.id) ?? r.struck, speed: r.struck.speed });
        const cameToRest = v.speed === 0 && wasSpeed !== 0;
        if (cameToRest || r.grounded || ((v.x !== wasX || v.z !== wasZ) && now - (lastSave.get(v.id) ?? -Infinity) >= SAVE_MS)) save(v);
      }
      if (v.sunk) continue;
      const cadence = moving ? PUBLISH_MOVING_MS : PUBLISH_IDLE_MS;
      if (crew.length && now - (lastPublish.get(v.id) ?? -Infinity) >= cadence) publish(v);
    }
  });

  /** Sinking or a stove-in hull: every crew member ashore at the nearest port; she lies wrecked at that port. */
  function wreck(v, { text = 'Your ship is lost. You make it ashore.' } = {}) {
    touch(v);
    const near = nearestBerth(v.x, v.z)?.port ?? (v.docked ? portById(v.docked) : null);
    for (const q of crewOf(v)) {
      putAshore(q, near?.id ?? null);
      say(q, text, { wrecked: true });
    }
    v.sunk = true;
    v.speed = 0;
    v.sails = 0;
    v.oars = 0;
    v.rudder = 0;
    v.helmId = null;
    v.anchored = true;
    if (near) Object.assign(v, { docked: near.id, x: near.x, z: near.z, yaw: wrap(num(near.yaw)) });
    save(v);
    ctx.emit('sailingWrecked', { vessel: v, port: near?.id ?? null });
  }

  // ------------------------------------------------------------------ actions

  function common(p, args) {
    const custody = services.law?.custody?.(p);
    if (custody) fail(custody);
    if (p.rpg?.defeated) fail('You cannot do that while you are down.');
    claimRequest(stateOf(p), args);
  }

  /**
   * Open-sea time compression (coast.js SEA_COMPRESSION, e.g. 60×): far from every berth (HARBOUR_M) and with no
   * other vessel or naval contact within CONTACT_M, a voyage's distance runs fast so the Bay is crossed in minutes.
   * Near a harbour, another ship or a fight, she sails 1:1. Shown as vessel.timeScale.
   */
  function seaScale(v, others) {
    const k = Number.isFinite(options.seaCompression) ? options.seaCompression : Number.isFinite(ctx.config?.sailing?.seaCompression) ? ctx.config.sailing.seaCompression : seaCompressionDefault;
    if (!(k > 1)) return 1;
    const c = coastReady();
    const near = c?.nearestPort?.(v.x, v.z);
    if (!c || (near && near.distance < HARBOUR_M)) return 1;
    if (others.some((o) => Math.hypot(o.x - v.x, o.z - v.z) < CONTACT_M)) return 1;
    try {
      const contacts = services.naval?.nearbyFor?.(v, CONTACT_M);
      if (Array.isArray(contacts) && contacts.length) return 1;
    } catch {
      /* naval unavailable: no contacts */
    }
    // A hand on the rudder turns at the true rate: compress only a steady course (her turning circle stays real).
    if (Math.abs(v.rudder) > 0.15) return 1;
    // Close to land (coast.js clearance is capped at ~64 m in open water): real time.
    try {
      if (typeof c.clearanceAt === 'function' && c.clearanceAt(v.x, v.z) < OPEN_CLEARANCE_M) return 1;
    } catch {
      /* no clearance data: judge by the berth distance alone */
    }
    // On a course: only a straight leg is compressed, and never so much that one second's stride passes the waypoint.
    const a = v.autopilot;
    if (a && !a.pending) {
      if (Math.abs(a.err ?? 0) > 0.08) return 1;
      const t = a.points?.[a.i];
      const way = Math.abs(v.speed);
      if (t && way > 0.1) {
        const d = Math.hypot(t.x - v.x, t.z - v.z);
        return Math.max(1, Math.min(k, Math.floor(d / (way * 3))));
      }
    }
    return k;
  }

  /**
   * A vessel whose pose went non-finite (a berth read before it was planned, a bad external write) would never move
   * again and serialises as nulls: put her back at her last (or home) berth, made fast, and re-plan any course.
   */
  function recoverPose(v, now) {
    const port = portById(v.docked) ?? portById(v.lastPort) ?? portById(v.homePort) ?? null;
    log.error?.(`[sailing] ${v.id}: non-finite pose (${v.x}, ${v.z}, ${v.yaw}, ${v.speed}); recovering at ${port?.id ?? 'nowhere'}`);
    if (!port) {
      if (!Number.isFinite(v.yaw)) v.yaw = 0;
      if (!Number.isFinite(v.speed)) v.speed = 0;
      return;
    }
    Object.assign(v, { x: port.x, z: port.z, yaw: wrap(num(port.yaw)), speed: 0, docked: port.id, anchored: true, grounded: false, sails: 0, oars: 0, rudder: 0 });
    delete v.groundedDir;
    if (v.autopilot) Object.assign(v.autopilot, { pending: true, routed: false, points: [], i: 0, from: port.id, askedAt: now, routeAskedAt: -Infinity });
    save(v);
    publish(v, { full: true });
  }

  /** NAVAL: the share of her sail way her canvas and grapples allow (services.naval.wayShare, 0..1). */
  function navalWayShare(v) {
    try {
      const s = services.naval?.wayShare?.(v);
      return Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 1;
    } catch {
      return 1;
    }
  }
  /** NAVAL: why her helm cannot answer now (shot away, grappled, sinking), or null. */
  function helmBlocked(v) {
    try {
      const why = services.naval?.helmBlocked?.(v);
      return typeof why === 'string' && why ? why : null;
    } catch {
      return null;
    }
  }

  function requireHelm(p) {
    const v = aboard(p);
    if (!v) fail('You are not aboard a ship.');
    if (v.sunk) fail('Your ship is wrecked.');
    const blocked = helmBlocked(v);
    if (blocked) fail(blocked);
    if (v.helmId !== p.id) fail(v.ownerId === p.id ? 'Take the helm first.' : 'Only the helmsman can do that.');
    touch(v);
    return v;
  }

  const waitingForBerth = new WeakSet();
  ctx.onAction('sailing.sync', (p, args) => {
    stateOf(p);
    if (wantsSea(p) || args?.harbour) ensureCoast();
    const v = aboard(p);
    if (v) publish(v, { full: true, only: p });
    else {
      const event = ashoreEvent(p);
      ctx.notify(p, event);
      if (args?.harbour && !event.port && !waitingForBerth.has(p)) {
        const loc = location(p);
        const town = exteriorTownOf(loc);
        if (!town && !loc.startsWith('wilderness:')) return;
        ctx.afterCommit(async () => {
          waitingForBerth.add(p);
          try {
            await ensureCoast();
            const c = coastReady();
            if (town) await c?.whenPort?.(town);
            else await c?.harbours;
            if (online(p.id) === p && location(p) === loc && !aboard(p)) ctx.notify(p, ashoreEvent(p));
          } catch (err) {
            log.warn?.('[sailing] harbour lookup failed:', err?.message ?? err);
          } finally {
            waitingForBerth.delete(p);
          }
        });
      }
    }
  });

  /** The town p stands in (exterior street, not indoors), with its port. */
  function portHere(p) {
    const loc = location(p);
    if (isShipPlace(loc)) fail('Go ashore first.');
    if (!parseLocationId(loc)) {
      // Standing on the quay itself (a harbour outside its town's walls).
      if (/^wilderness:/.test(loc)) {
        needCoast();
        const at = portAtQuay(p);
        if (at) return at;
      }
      fail('Go out to the harbour first.');
    }
    const c = needCoast();
    const port = c.portOf?.(loc) ?? c.ports().find((pt) => pt.id === loc) ?? null;
    if (port && port.harbour === false) fail('There is no harbour here.');
    // Harbours are charted on demand (portOf asks for this one); a known port town not yet charted says so.
    if (!port && c.portTowns?.()?.some?.((t) => t.id === loc)) fail('The harbour master is still charting the berths here. Try again in a moment.');
    if (!port) fail('There is no harbour here.');
    if (port.berthReady === false) fail('The harbour master is still charting the berths here. Try again in a moment.');
    return port;
  }

  function boardOwn(p) {
    if (!shipTypeOf(p)) fail('You own no ship. The bank of a port town sells them.');
    const port = portHere(p);
    let v = ownVessel(p);
    // SHIPYARD: the one vessel sails the captain's flagship (its berth, hull, stores and crew).
    const bindYard = services.shipyard?.bindVessel;
    if (v && bindYard) {
      touch(v);
      bindYard(p, v);
    }
    if (v && v.sunk) fail('Your ship lies wrecked. She must be repaired before she can sail.');
    if (v && v.docked !== port.id) {
      const at = portById(v.docked)?.name;
      fail(v.docked ? `Your ship is docked at ${at ?? v.docked}.` : 'Your ship is at sea.');
    }
    if (!v) {
      v = newVessel(p, port);
      vessels.set(v.id, v);
      ctx.onRollback(() => vessels.delete(v.id));
      if (bindYard) {
        bindYard(p, v);
        if (v.docked !== port.id) fail(`${v.name} is berthed at ${portById(v.docked)?.name ?? v.docked}.`);
      }
    }
    if (v.type !== shipTypeOf(p)) {
      touch(v);
      v.type = shipTypeOf(p);
    }
    joinCrew(p, v);
    return v;
  }

  ctx.onAction('sailing.board', (p, args) => {
    common(p, args);
    if (aboard(p)) fail('You are already aboard.');
    if (isShipPlace(location(p))) fail('Go ashore first.');
    const id = typeof args.vesselId === 'string' ? args.vesselId : null;
    let v;
    if (!id || id === `v${p.id}`) {
      v = boardOwn(p);
      say(p, `You board ${v.name} at ${portById(v.docked)?.name ?? 'the quay'}.`);
    } else {
      v = vessels.get(id);
      if (!v || v.sunk) fail('That ship is not here.');
      const port = portHere(p);
      if (v.docked !== port.id) fail('That ship is not at this quay.');
      if (v.charter) {
        // A booked passenger (server/rpg/passage.js) rejoins their charter; nobody else boards one.
        if (!(v.charter.passengerIds ?? []).includes(p.id)) fail(`You have no passage booked on ${v.name}.`);
      } else {
        const owner = online(v.ownerId);
        if (!owner) fail('Her captain is not here to take you aboard.');
        if (!services.sameParty?.(p, owner)) fail(`Only ${v.ownerName}'s party may board.`);
      }
      joinCrew(p, v);
      say(p, `You board ${v.name}.`);
      tellCrew(v, `${p.name} comes aboard.`);
    }
    save(v);
    publish(v, { full: true });
  });

  ctx.onAction('sailing.launch', (p, args) => {
    common(p, args);
    let v = aboard(p);
    if (!v) v = boardOwn(p);
    else touch(v);
    if (v.ownerId !== p.id) fail('Only her captain can cast off.');
    if (v.sunk) fail('Your ship is wrecked.');
    if (!v.docked) fail('She is already under way.');
    // SHIPYARD: hands, provisions, a sound hull and a hold within capacity before she casts off.
    v.shipId ??= `legacy-${v.type}`; // a classic deed's ship in the shipyard's fleet
    const yardRefusal = services.shipyard?.canSail?.(p, v.shipId) ?? null;
    if (yardRefusal) fail(yardRefusal);
    const blocked = helmBlocked(v);
    if (blocked) fail(blocked);
    yardHandling(v);
    const port = portById(v.docked);
    if (port) {
      v.homePort ??= port.id;
      v.lastPort = port.id;
    }
    v.docked = null;
    v.anchored = false;
    v.grounded = false;
    v.speed = 0;
    v.helmId = p.id;
    v.launchedAt = minutes();
    if (port) Object.assign(v, { x: port.x, z: port.z, yaw: wrap(num(port.yaw)) });
    prepareSea(v, true);
    save(v);
    tellCrew(v, `${v.name} casts off from ${port?.name ?? 'the quay'}. ${p.name} has the helm.`);
    ctx.emit('sailingLaunched', { vessel: v, port: port?.id ?? null, player: p });
    publish(v, { full: true });
  });

  ctx.onAction('sailing.leave', (p, args) => {
    common(p, args);
    const v = aboard(p);
    if (!v) fail('You are not aboard a ship.');
    if (!v.docked) fail('You are at sea. Make fast at a port first.');
    if (location(p) !== deckOf(v)) fail('Go up on deck first.');
    touch(v);
    const port = v.docked;
    putAshore(p, port);
    say(p, `You go ashore at ${portById(port)?.name ?? 'the quay'}.`);
    tellCrew(v, `${p.name} goes ashore.`);
    save(v);
    publish(v);
    ctx.notify(p, ashoreEvent(p));
  });

  ctx.onAction('sailing.helm', (p, args) => {
    common(p, args);
    const v = aboard(p);
    if (!v) fail('You are not aboard a ship.');
    if (v.sunk) fail('Your ship is wrecked.');
    if (args.take !== false) {
      const blocked = helmBlocked(v);
      if (blocked) fail(blocked);
    }
    touch(v);
    if (args.give != null) {
      if (v.ownerId !== p.id) fail('Only her captain gives the helm.');
      const q = crewOf(v).find((c) => c.id === Number(args.give));
      if (!q) fail('They are not aboard.');
      v.helmId = q.id;
      tellCrew(v, `${q.name} takes the helm.`);
    } else if (args.take === false) {
      if (v.helmId !== p.id) fail('You do not have the helm.');
      v.helmId = null;
      v.rudder = 0;
      tellCrew(v, `${p.name} leaves the helm.`);
    } else {
      if (v.helmId === p.id) fail('You already have the helm.');
      if (v.ownerId !== p.id) fail(`${v.ownerName} must give you the helm.`);
      v.helmId = p.id;
      tellCrew(v, `${p.name} takes the helm.`);
    }
    save(v);
    publish(v);
  });

  ctx.onAction('sailing.control', (p, args) => {
    const v = requireHelm(p);
    if (v.docked) fail('Cast off first.');
    // Helm takeover: any hand on the wheel or the sheets ends the plotted course.
    if (v.autopilot && !v.charter) dropCourse(v, `${p.name} takes her off the course.`);
    if (args.sails !== undefined) {
      if (![0, 0.5, 1].includes(args.sails)) fail('Sails are struck (0), half (0.5) or full (1).');
      v.sails = args.sails;
    }
    if (args.oars !== undefined) {
      if (![-1, 0, 1].includes(args.oars)) fail('Oars back (-1), rest (0) or pull (1).');
      v.oars = args.oars;
    }
    if (args.rudder !== undefined) {
      if (typeof args.rudder !== 'number') fail('Which way?');
      v.rudder = Math.round(Math.max(-1, Math.min(1, args.rudder)) * 20) / 20;
    }
    save(v);
    publish(v);
  });

  // A captain's plotted course to a charted port (coast.route, like a passage master's): the helm holder sets or
  // clears it; she then steers, trims and makes fast herself until the helm takes over or danger breaks it off.
  ctx.onAction('sailing.course', (p, args) => {
    claimRequest(stateOf(p), args);
    const v = requireHelm(p);
    if (v.charter) fail('This ship keeps her master\'s course.');
    if (args.portId == null) {
      if (!v.autopilot) fail('No course is set.');
      dropCourse(v, `${p.name} clears the course.`);
      return;
    }
    if (typeof args.portId !== 'string') fail('Which port?');
    if (v.docked) fail('Cast off first.');
    if (v.anchored) fail('Weigh anchor first.');
    const danger = courseDanger(v);
    if (danger) fail(`${danger}. Keep her in hand.`);
    const r = setCourse(v, args.portId);
    tellCrew(v, `Course set for ${portById(args.portId)?.name ?? args.portId}: ${Math.round(r.distance / 100) / 10} km.`, { course: args.portId, ...r });
  });

  ctx.onAction('sailing.anchor', (p, args) => {
    claimRequest(stateOf(p), args);
    const v = requireHelm(p);
    if (v.autopilot && !v.charter && args.down !== false) dropCourse(v, null);
    if (v.docked) fail('She is made fast to the quay.');
    const down = args.down !== false;
    if (down === v.anchored) fail(down ? 'The anchor is already down.' : 'The anchor is already up.');
    v.anchored = down;
    save(v);
    tellCrew(v, down ? 'The anchor goes down.' : 'Anchor aweigh!');
    publish(v);
  });

  ctx.onAction('sailing.dock', (p, args) => {
    claimRequest(stateOf(p), args);
    const v = requireHelm(p);
    if (v.docked) fail('She is already made fast.');
    const c = needCoast();
    const near = c.ports().filter((pt) => pt.berthReady !== false && Number.isFinite(pt.x) && Number.isFinite(pt.z))
      .map((pt) => ({ pt, d: Math.hypot(pt.x - v.x, pt.z - v.z) })).sort((a, b) => a.d - b.d)[0];
    if (!near || near.d > DOCK_RANGE) fail(near ? `The nearest berth, ${near.pt.name}, is ${Math.round(near.d)} m off.` : 'There is no harbour near.');
    if (!canDock(v, near.pt)) fail('Take the way off her first.');
    Object.assign(v, {
      docked: near.pt.id, lastPort: near.pt.id, anchored: true, grounded: false, speed: 0, sails: 0, oars: 0, rudder: 0,
      x: near.pt.x, z: near.pt.z, yaw: wrap(num(near.pt.yaw)),
    });
    services.travel?.discover?.(p, near.pt.id);
    services.overland?.whenPlaced?.(near.pt.id)?.catch?.(() => {});
    save(v);
    tellCrew(v, `${v.name} makes fast at ${near.pt.name}. You may go ashore.`);
    ctx.emit('sailingDocked', { vessel: v, port: near.pt.id, player: p });
    publish(v, { full: true });
  });

  // ------------------------------------------------------------------ presence

  /** Scene partition on ship decks and cabins; null elsewhere. */
  function presenceScope(p) {
    if (!p?.rpg || !isShipPlace(location(p))) return null;
    const id = p.rpg.sailing?.vesselId;
    if (id && vessels.has(id)) return `vessel:${id}`;
    return `own:${p.id}`;
  }
  const prevPresenceScope = services.presenceScope;
  services.presenceScope = (p) => presenceScope(p) ?? (typeof prevPresenceScope === 'function' ? prevPresenceScope(p) : null);

  // ------------------------------------------------------------------ property hooks

  function refusal(p, verb) {
    const v = aboard(p);
    const own = ownVessel(p);
    if (verb === 'ship.board') {
      if (v) return 'You are already aboard.';
      if (own && !own.docked) return 'Your ship is at sea.';
    }
    if (verb === 'ship.leave' && v) return 'Go ashore by the gangway: make fast at a port, then leave the ship.';
    if (verb === 'ship.sell' && own) {
      if (!own.docked) return 'Your ship is at sea. Bring her into port first.';
      if (crewOf(own).length || own.crewIds.length) return 'See everyone ashore before you sell her.';
    }
    return null;
  }
  /** Aboard a vessel only its owner reaches a hold or the cabin; elsewhere property decides (undefined). */
  const holdAllowed = (p) => {
    const v = aboard(p);
    return v ? v.ownerId === p.id : undefined;
  };

  /**
   * NAVAL: after a wreck, she is back made fast at her last port (else her home port, else the nearest); her crew
   * stay aboard on her deck. The naval/shipyard owners set her hull; she sails again once hull.hp > 0.
   */
  function respawn(v, { reason = 'wrecked' } = {}) {
    const c = coastReady();
    const port = portById(v.lastPort) ?? portById(v.homePort) ?? nearestBerth(v.x, v.z)?.port ?? null;
    touch(v);
    Object.assign(v, { speed: 0, sails: 0, oars: 0, rudder: 0, anchored: true, grounded: false, helmId: null });
    delete v.groundedDir;
    if (port) Object.assign(v, { docked: port.id, lastPort: port.id, x: port.x, z: port.z, yaw: wrap(num(port.yaw)) });
    if (v.hull?.hp > 0) v.sunk = false;
    save(v);
    tellCrew(v, port ? `${v.name} is brought into ${port.name}.` : `${v.name} rides at anchor.`, { respawn: reason });
    ctx.emit('sailingRespawned', { vessel: v, port: port?.id ?? null, reason });
    publish(v, { full: true });
    return port?.id ?? null;
  }

  // ------------------------------------------------------------------ charters (server/rpg/passage.js)

  const retired = new Map(); // charter id -> port id it was retired at (an offline passenger lands there)
  for (const [key, value] of ctx.loadWorld(RETIRED_PREFIX)) {
    if (typeof value?.port === 'string') retired.set(key.slice(RETIRED_PREFIX.length), value.port);
  }
  let charterSeq = 0;

  /** An ownerless NPC vessel made fast at `fromPortId`'s berth, persisted like any other. Call inside an action. */
  function charter({ fromPortId, toPortId = null, type = 'large', name = null, master = 'the master', record = {} } = {}) {
    const c = needCoast();
    const from = berthed(c.portOf?.(fromPortId) ?? null);
    if (!from) fail('The harbour master is still charting the berths here. Try again in a moment.');
    if (!HULLS[type]) fail('No such ship.');
    if (!isObj(record) || JSON.stringify(record).length > CHARTER_MAX_BYTES) fail('That booking is too large.');
    const id = `vc-${Date.now().toString(36)}${(++charterSeq).toString(36)}`;
    const h = hullOf(type);
    const v = {
      id, ownerId: null, ownerName: String(master).slice(0, 40), type, name: String(name ?? `The ${master}'s ship`).slice(0, 64),
      x: from.x, z: from.z, yaw: wrap(num(from.yaw)), speed: 0, anchored: true, grounded: false, docked: from.id,
      homePort: from.id, lastPort: from.id, sails: 0, oars: 0, rudder: 0, helmId: null, crewIds: [],
      hull: { hp: h.hull, max: h.hull }, sunk: false, naval: {}, charter: structuredClone({ ...record, toPortId: record.toPortId ?? toPortId }),
      launchedAt: 0, updatedAt: Date.now(),
    };
    vessels.set(id, v);
    ctx.onRollback(() => vessels.delete(id));
    save(v);
    return v;
  }

  /** Put p aboard a charter as a passenger (passage.js authorises). Call inside an action. */
  function embark(p, v) {
    if (!v?.charter || vessels.get(v.id) !== v) fail('That ship is not taking passengers.');
    if (aboard(p) === v) return; // a reconnected passenger is already back aboard (onJoin)
    if (aboard(p)) fail('You are already aboard.');
    if (isShipPlace(location(p))) fail('Go ashore first.');
    if (v.sunk) fail('That ship is lost.');
    joinCrew(p, v);
    touch(v);
    const ids = new Set(v.charter.passengerIds ?? []);
    ids.add(p.id);
    v.charter.passengerIds = [...ids];
    save(v);
    publish(v, { full: true });
  }

  /** Ashore at her docked port (passage.js calls it at the destination, or at the origin before she sails). */
  function disembark(p, v) {
    if (aboard(p) !== v) fail('You are not aboard that ship.');
    if (!v.docked) fail('You are at sea. Wait until she makes port.');
    putAshore(p, v.docked);
    save(v);
    if (crewOf(v).length) publish(v);
  }

  /** Autopilot to a port: coast.js route when it has one (else a straight course, replaced once routed). */
  /** Estimated real seconds for `metres` at her cruise, with open-sea compression. */
  function etaFor(v, metres) {
    const cruise = Math.max(0.5, voyage.handlingOf(v).sailMax * 0.75);
    return Math.round(metres / cruise / Math.max(1, seaCompressionDefault));
  }

  /**
   * Autopilot to a port along coast.js's water route (never a straight line over land). The route is computed in a
   * worker: until it is cached she waits (`autopilot.pending`) where she is - made fast at her berth, or holding her
   * way at sea - and casts off once it arrives; a port pair with no route gives the helm back.
   */
  function setCourse(v, portId) {
    if (!v || vessels.get(v.id) !== v) fail('No such ship.');
    if (v.sunk) fail('That ship is lost.');
    const c = needCoast();
    const to = berthed(c.portOf?.(portId) ?? null);
    if (!to) fail('The harbour master is still charting that berth. Try again in a moment.');
    if (v.docked === portId) fail('She is already there.');
    touch(v);
    const from = v.docked ?? v.lastPort ?? c.nearestPort?.(v.x, v.z)?.port?.id ?? null;
    if (!from) fail('There is no charted water route from here.');
    v.autopilot = { to: portId, points: [], i: 0, routed: false, pending: true, from, askedAt: ctx.now(), backUntil: 0 };
    const route = c.route?.(from, portId) ?? null;
    if (route?.points?.length) beginCourse(v, route);
    else {
      save(v);
      tellCrew(v, `The master plots a course for ${to.name}.`, { course: portId, pending: true });
      publish(v, { full: true });
    }
    const metres = route?.metres ?? Math.hypot(to.x - v.x, to.z - v.z) * 1.4;
    return { distance: Math.round(metres), eta: etaFor(v, metres), pending: !route };
  }

  /** The route is known: lay her on it and, from a berth, cast off. False when no clear water leads to it. */
  function beginCourse(v, route) {
    const a = v.autopilot;
    const c = coastReady();
    a.points = route.points.slice(0, AUTOPILOT_MAX_POINTS).map((q) => ({ x: q.x, z: q.z }));
    a.routed = true;
    a.pending = false;
    a.metres = route.metres ?? null;
    if (v.docked) a.i = Math.min(1, a.points.length - 1);
    else {
      // At sea: the first waypoint ahead she can reach in clear water.
      const start = nearestAhead(v, a.points);
      let pick = -1;
      for (let k = start; k < a.points.length && pick < 0; k++) {
        const q = a.points[k];
        if (!c?.segmentClear || c.segmentClear(v.x, v.z, q.x, q.z, { clearance: 8 }).ok !== false) pick = k;
      }
      if (pick < 0) {
        dropCourse(v, 'No clear water leads to the route from here. You have the helm.');
        return false;
      }
      a.i = pick;
    }
    const leaving = !!v.docked;
    if (v.docked) {
      v.lastPort = v.docked;
      v.homePort ??= v.docked;
    }
    Object.assign(v, { docked: null, anchored: false, grounded: false, sails: 1, oars: 0, rudder: 0 });
    prepareSea(v, true);
    save(v);
    const to = portById(a.to);
    if (leaving) {
      tellCrew(v, `${v.name} weighs anchor for ${to?.name ?? a.to}.`);
      ctx.emit('sailingLaunched', { vessel: v, port: v.lastPort ?? null, player: null });
    }
    publish(v, { full: true });
    return true;
  }

  /** A pending course: cast off when the worker's route arrives; give up on a pair with no route. */
  function awaitRoute(v, now) {
    const a = v.autopilot;
    const c = coastReady();
    if (!c || now - (a.routeAskedAt ?? -Infinity) < 500) return;
    a.routeAskedAt = now;
    const route = c.route?.(a.from, a.to) ?? null;
    if (route?.points?.length) {
      touch(v);
      beginCourse(v, route);
      return;
    }
    const unreachable = (c.unreachablePorts?.() ?? []).some((u) => (u?.id ?? u) === a.to || (u?.id ?? u) === a.from);
    if (unreachable || now - a.askedAt > ROUTE_WAIT_MS) {
      const name = portById(a.to)?.name ?? a.to;
      touch(v);
      if (v.charter) {
        delete v.autopilot;
        save(v);
        tellCrew(v, `The master can find no sea road to ${name}.`, { course: null });
        ctx.emit('sailingCourseFailed', { vessel: v, port: a.to });
        publish(v);
      } else dropCourse(v, `No sea road to ${name} is charted. You have the helm.`);
    }
  }

  function nearestAhead(v, pts) {
    let best = 0, bd = Infinity;
    pts.forEach((q, i) => {
      const d = Math.hypot(q.x - v.x, q.z - v.z);
      if (d < bd) { bd = d; best = i; }
    });
    return Math.min(best + 1, pts.length - 1);
  }
  /** A captain's own course ends: the helm is a hand again (manual takeover, danger, aground or arrival). */
  function dropCourse(v, text) {
    if (!v.autopilot) return;
    touch(v);
    delete v.autopilot;
    v.rudder = 0;
    save(v);
    if (text) tellCrew(v, text, { course: null });
    publish(v);
  }
  /** Danger near an owned vessel on her own course: a hostile ship within COURSE_ALERT_M, or a fight aboard. */
  function courseDanger(v) {
    try {
      const rows = services.naval?.nearbyFor?.(v, COURSE_ALERT_M) ?? [];
      for (const r of rows) {
        if (!r) continue;
        const d = Number.isFinite(r.distance) ? r.distance : Math.hypot((r.x ?? Infinity) - v.x, (r.z ?? Infinity) - v.z);
        if (d > COURSE_ALERT_M) continue;
        if (r.hostile === true || r.sinking === true) return `${r.name ?? 'A ship'} bears down on you`;
      }
      if (crewOf(v).some((q) => services.enemiesNearby?.(q))) return 'Enemies aboard';
    } catch {
      /* naval or combat unavailable: no danger known */
    }
    return null;
  }

  /** Remove a charter with nobody aboard; never an owned vessel. */
  function retire(v) {
    if (!v?.charter || v.ownerId !== null) fail('Only a charter can be retired.');
    if (crewOf(v).length) fail('There are still people aboard.');
    const port = v.docked ?? v.lastPort ?? null;
    if (port) {
      retired.set(v.id, port);
      ctx.dirtyWorld(RETIRED_PREFIX + v.id, { port, at: Date.now() });
    }
    forget(v);
  }

  /** The hand on a charter's helm: follows the waypoints, comes in under oars and makes fast at the berth. */
  function steerAutopilot(v, now) {
    const a = v.autopilot;
    const c = coastReady();
    if (!c || v.sunk) return;
    if (a.pending) return awaitRoute(v, now);
    if (v.docked) return;
    const to = berthed(c.portOf?.(a.to) ?? null);
    const lastIdx = a.points.length - 1;
    // Take every waypoint she has reached or passed (a compressed stride may step past it).
    for (;;) {
      const target = a.points[a.i];
      if (!target || a.i >= lastIdx) break;
      const prev = a.i > 0 ? a.points[a.i - 1] : null;
      const d = Math.hypot(target.x - v.x, target.z - v.z);
      const reach = Math.max(WAYPOINT_M, Math.abs(v.speed) * (v.timeScale ?? 1) * 2);
      const passed = prev && ((target.x - prev.x) * (v.x - target.x) + (target.z - prev.z) * (v.z - target.z)) > 0;
      if (d < reach || passed) a.i++;
      else break;
    }
    const target = a.points[a.i] ?? (to ? { x: to.x, z: to.z } : null);
    if (!target) return;
    const berth = to ?? a.points[lastIdx];
    const toBerth = Math.hypot(berth.x - v.x, berth.z - v.z);
    // Made fast.
    if (to && toBerth <= DOCK_RANGE && Math.abs(v.speed) <= DOCK_SPEED) {
      Object.assign(v, { docked: to.id, lastPort: to.id, anchored: true, grounded: false, speed: 0, sails: 0, oars: 0, rudder: 0, x: to.x, z: to.z, yaw: wrap(num(to.yaw)) });
      delete v.autopilot;
      save(v);
      tellCrew(v, `${v.name} makes fast at ${to.name}.`);
      ctx.emit('sailingDocked', { vessel: v, port: to.id, player: null });
      publish(v, { full: true });
      return;
    }
    if (!v.charter) {
      // A captain's own course: aground or danger hands the helm back at once.
      if (v.grounded) return dropCourse(v, 'She touches bottom. The course is broken off: you have the helm.');
      const danger = courseDanger(v);
      if (danger) return dropCourse(v, `${danger}! The course is broken off: you have the helm.`);
    }
    // Aground (charter): back water a while, then rejoin the route at a waypoint in clear water.
    if (v.grounded && !(a.backUntil > now)) {
      a.backUntil = now + 6000;
      a.groundings = (a.groundings ?? 0) + 1;
    }
    if (a.backUntil > now) {
      Object.assign(v, { sails: 0, oars: -1, rudder: 0 });
      if (a.backUntil - now < 300) {
        const k = nearestAhead(v, a.points);
        a.i = Math.max(Math.min(a.i, lastIdx), Math.min(k, lastIdx));
      }
      return;
    }
    const want = Math.atan2(target.x - v.x, -(target.z - v.z));
    const err = wrap(want - v.yaw);
    a.err = err;
    v.rudder = Math.max(-1, Math.min(1, err * 2.5));
    const way = Math.abs(v.speed);
    // Coming in: canvas off, back water to take her way off, then pull gently up to the berth.
    if (toBerth < APPROACH_M * 2) {
      const limit = toBerth < DOCK_RANGE ? DOCK_SPEED * 0.8 : Math.max(1.5, Math.min(4, toBerth / 100));
      const canvas = voyage.handlingOf(v).sailMax > 0 && toBerth > DOCK_RANGE * 0.5;
      if (way > limit + 0.3) Object.assign(v, { sails: 0, oars: -1 });
      else if (way < limit) Object.assign(v, canvas && Math.abs(err) < 1 ? { sails: 0.5, oars: 0 } : { sails: 0, oars: 1 });
      else Object.assign(v, { sails: 0, oars: 0 });
      return;
    }
    // Slow for turns and narrow water: a hard turn ahead, a big heading error, or a channel (clearance) asks for
    // less way, so the rudder can hold her on the leg.
    const dTarget = Math.hypot(target.x - v.x, target.z - v.z);
    const next = a.points[a.i + 1];
    let turnAhead = 0;
    if (next && dTarget < TURN_SLOW_M) {
      const leg1 = Math.atan2(target.x - v.x, -(target.z - v.z));
      const leg2 = Math.atan2(next.x - target.x, -(next.z - target.z));
      turnAhead = Math.abs(wrap(leg2 - leg1));
    }
    let clearance = Infinity;
    try {
      clearance = typeof c.clearanceAt === 'function' ? c.clearanceAt(v.x, v.z) : Infinity;
    } catch {
      clearance = Infinity;
    }
    let limit = Infinity;
    if (Math.abs(err) > 0.9) limit = 2;
    else if (Math.abs(err) > 0.4 || turnAhead > 0.8) limit = 4;
    if (clearance < CHANNEL_M) limit = Math.min(limit, 3.5);
    if (way > limit + 0.5) Object.assign(v, { sails: 0, oars: way > limit + 2 ? -1 : 0 });
    else if (limit < Infinity) Object.assign(v, { sails: 0.5, oars: 0 });
    else Object.assign(v, { sails: 1, oars: 0 });
  }

  services.sailing = {
    vesselFor: (p) => aboard(p) ?? (p ? ownVessel(p) : null),
    vessels: () => vessels.values(),
    byId: (id) => vessels.get(id) ?? null,
    touch, // snapshot a vessel for rollback before another feature changes it inside an action (shipyard)
    crewOf,
    canCommand,
    aboard,
    save,
    publish,
    presenceScope,
    refusal,
    holdAllowed,
    wreck,
    putAshore,
    ports: () => coastReady()?.ports() ?? [],
    wind: (x = 0, z = 0) => windAt(minutes(), z, null),
    get coastStatus() { return coastService()?.status ?? (coastError ? 'failed' : coastStarted ? 'loading' : 'idle'); },
    voyage,
    respawn,
    /** The coast chart, started on first ask (lazy); null until coast.js is loaded. Also services.coast once made. */
    coast() {
      ensureCoast();
      return coastService() ?? null;
    },
    /** Every port town coast.js knows ({id,name,region,regionIndex,px,py}); [] until ready. Asking starts the coast. */
    portTowns() {
      ensureCoast();
      try {
        return coastReady()?.portTowns?.() ?? [];
      } catch {
        return [];
      }
    },
    /** The charted harbour p stands at: their port town, or within 120 m of its quay (a wilderness quay); else null. */
    harbourHere: (p) => {
      try {
        return ashorePort(p) ?? null;
      } catch {
        return null;
      }
    },
    /** coast.reachable(from, to): true / false, or null while not yet charted (asking charts both ends). */
    reachable(fromId, toId) {
      ensureCoast();
      const c = coastReady();
      if (!c) return null;
      try {
        if (typeof c.reachable === 'function') return c.reachable(fromId, toId) ?? null;
        const r = c.route?.(fromId, toId);
        return r ? true : null;
      } catch {
        return null;
      }
    },
    /** Port towns with no navigable harbour. */
    unreachablePorts() {
      try {
        return coastReady()?.unreachablePorts?.() ?? [];
      } catch {
        return [];
      }
    },
    /** Chart one harbour on demand (starts the coast if needed). Returns the port when already charted, else null. */
    warm(townId) {
      ensureCoast();
      if (typeof townId !== 'string') return null;
      warmTown(townId);
      return portById(townId);
    },
    /** Read-only: the coast if it was ever started (never starts it). */
    get coastNow() { return coastService() ?? null; },
    /** Start the lazy coast load (idempotent). */
    ensureCoast,
    charter,
    embark,
    disembark,
    setCourse,
    retire,
    /** true/false once the chart is ready; null while it loads (asking starts the lazy load). */
    isWater: (x, z) => {
      if (!coastReady()) {
        ensureCoast();
        return null;
      }
      return isWater(x, z);
    },
    wayShare: navalWayShare,
  };

  return { vessels, presenceScope, publish, save, aboard };
}

export default install;
