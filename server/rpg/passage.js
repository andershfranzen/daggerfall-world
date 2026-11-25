// Sea passage for players without a ship of their own: book a berth on a friendly charter at a real port and SAIL to
// the chosen port, never jump there.
//
// Design source: Daggerfall Online (Lattymoy, MIT), .ref/dfjs-research-03 @ a3eb1605 - src/systems/naval/passage.js
// (the law: destinations nearest first, the classic fare, the eight winds, the charter record) and
// src/scenes/naval/passageHost.js (offer -> ask -> book all-or-nothing, the passage's life, end). Ideas and numbers are
// reimplemented here for an authoritative multiplayer server; no code is copied verbatim.
//
// This feature owns the booking and the passenger's record only. The voyage itself - the vessel, its pose, wind,
// routing, grounding and docking - belongs to the sailing core (server/rpg/sailing.js) through a narrow interface
// resolved at call time from ctx.services.sailing (the "berth interface"):
//   charter({fromPortId, toPortId, type, name, master, record}) -> vessel   an ownerless NPC vessel docked at the berth
//   embark(p, vessel)          p aboard as a passenger (no command)
//   setCourse(vessel, portId)  her master sails for the port (the core's autopilot steps her)
//   disembark(p, vessel)       ashore at the port where she lies docked
//   retire(vessel)             an empty charter leaves the world (never an owned vessel)
//   byId(id), aboard(p), crewOf(vessel), ports()                            (also services.coast.ports())
// No simulation happens here. A passenger's own deed, ship and holds (server/rpg/property.js) are never touched.
//
// Fare: Daggerfall's ship passage (TravelTimeCalculator.CalculateTripCost travelShip arm, client/gameplay/travel/journey.js
// tripCost): 25 gold for every 24 ocean pixels and 25 more, every pixel of the voyage counted as sea. Classic instant
// travel (travel.go) is unchanged.
//
// rpg.passage = { voyage: Voyage|null, trips, lastRequestId }
// Voyage = { id, vesselId, ship, master, type, from:{id,name,px,py}, to:{id,name,px,py}, fare, state, bookedAt, requestId }
//   state: 'boarding' (aboard, not yet cast off - cancel refunds) | 'underway' | 'arrived' (docked at `to`)
//
// Actions (all accept requestId; a repeated one answers again and changes nothing):
//   passage.offer {}                       -> passage.status with offers
//   passage.book {toPortId, expectFare}    pay, charter, aboard, cast off
//   passage.rejoin {}                      back aboard after a reconnect or a restart
//   passage.disembark {}                   ashore - only where she lies docked at the paid-for port
//   passage.cancel {}                      only before she casts off: ashore at the quay, fare refunded
//   passage.sync {}                        -> passage.status
// Event: private silent {kind:'passage.status', here, voyage, offers, gold}; plain {kind:'passage', text} for words.

import { tripCost } from '../../client/gameplay/travel/journey.js';

export const name = 'passage';

/** A port within this many map pixels is walked to, never sailed (DFO VOYAGE_LANDFALL_PX). */
export const LANDFALL_PX = 2;
/** Overland frame (client/world/exterior/frame.js): a map pixel is 819.2 m. */
export const PIXEL_M = 819.2;
/** Hull a charter is sailed in. DFO PASSAGE_HULLS never use the rowboat; the core's 'large' is the classic large ship. */
export const PASSAGE_TYPE = 'large';
/** Ship and master names (invented for this project; not game data). */
const SHIP_NAMES = Object.freeze(['Grey Tern', 'Saint Kynareth', 'Gull of Wayrest', 'Morning Brine', 'Iliac Maid', 'Stalwart', 'Lady Ebon', 'Sea Hound']);
const MASTERS = Object.freeze(['Aldric Vane', 'Mira Tolle', 'Jesk Brennan', 'Oswin Harl', 'Talwyn Crane', 'Bera Holt']);

const REQUEST_RE = /^[\w-]{6,64}$/;

/** A voyage's length in map pixels: the longest axis, as Daggerfall's travel walk counts steps. */
export const passagePixels = (a, b) => Math.max(Math.abs((b.px | 0) - (a.px | 0)), Math.abs((b.py | 0) - (a.py | 0)));

/** THE FARE: the classic ship passage with every pixel of the voyage counted as ocean; no inn (a passenger sleeps aboard). */
export const passageFare = (a, b) => tripCost(0, Math.max(1, passagePixels(a, b)), { ship: true }).passage;

const WINDS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
/** Which way a port lies in the eight winds; map y runs south. '' for the same pixel. */
export function passageWind(a, b) {
  const dx = (b.px | 0) - (a.px | 0), dn = (a.py | 0) - (b.py | 0);
  if (!dx && !dn) return '';
  const deg = (Math.atan2(dx, dn) * 180) / Math.PI; // 0 = north, 90 = east
  return WINDS[(Math.round(((deg + 360) % 360) / 45)) % 8];
}

/** A port record from the geo owner, normalised. Prices use the TOWN's map pixel (px, py); x/z (the berth, 1-2 px off)
 *  is only a last resort for a record without one. */
export function portRecord(p) {
  if (!p || typeof p.id !== 'string' || !p.id) return null;
  const nm = String(p.name ?? '').trim();
  if (!nm) return null;
  const px = Number.isFinite(p.px) ? p.px | 0 : Number.isFinite(p.x) ? Math.floor(p.x / PIXEL_M) : null;
  const py = Number.isFinite(p.py) ? p.py | 0 : Number.isFinite(p.z) ? Math.floor(p.z / PIXEL_M) : null;
  if (px === null || py === null) return null;
  return { id: p.id, name: nm.slice(0, 64), region: String(p.region ?? '').slice(0, 64), px, py };
}

/**
 * THE PORTS HER MASTER SAILS FOR from `here`: every known, reachable port that is not here nor within landfall reach,
 * nearest first then by name - each {port, fare, bearing, pixels}.
 */
export function passageDestinations(ports, here, { known = () => true, reachable = () => true } = {}) {
  const out = [];
  for (const raw of ports ?? []) {
    const port = portRecord(raw);
    if (!port || port.id === here.id || !known(port) || !reachable(here, port)) continue;
    const pixels = passagePixels(here, port);
    if (pixels <= LANDFALL_PX) continue;
    out.push({ port, fare: passageFare(here, port), bearing: passageWind(here, port), pixels });
  }
  return out.sort((a, b) => a.pixels - b.pixels || a.port.name.localeCompare(b.port.name));
}

/** A voyage record read back from a save; null for anything malformed. */
export function voyageRecord(x) {
  const place = (q) => (q && typeof q.id === 'string' && q.id && typeof q.name === 'string'
    ? { id: q.id, name: q.name.slice(0, 64), px: q.px | 0, py: q.py | 0 } : null);
  const from = place(x?.from), to = place(x?.to);
  if (!from || !to || typeof x.id !== 'string' || typeof x.vesselId !== 'string') return null;
  const state = ['boarding', 'underway', 'arrived'].includes(x.state) ? x.state : 'underway';
  return {
    id: x.id, vesselId: x.vesselId, from, to, state,
    ship: typeof x.ship === 'string' ? x.ship.slice(0, 64) : 'The ship',
    master: typeof x.master === 'string' ? x.master.slice(0, 64) : null,
    type: typeof x.type === 'string' ? x.type : PASSAGE_TYPE,
    fare: Math.max(0, Math.floor(Number(x.fare) || 0)),
    bookedAt: Number.isFinite(x.bookedAt) ? x.bookedAt : 0,
    requestId: typeof x.requestId === 'string' ? x.requestId : null,
  };
}

/** Deterministic pick so a port's charter has a stable name for a given booking. */
const pick = (list, seed) => {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return list[(h >>> 0) % list.length];
};

export function install(ctx) {
  const S = ctx.services;
  const sailing = () => S.sailing ?? null;
  const fail = (msg) => { throw new Error(msg); };

  function ensure(p) {
    const r = p.rpg;
    if (!r.passage || typeof r.passage !== 'object') r.passage = { voyage: null, trips: 0, lastRequestId: null };
    const st = r.passage;
    st.voyage = st.voyage ? voyageRecord(st.voyage) : null;
    if (!Number.isInteger(st.trips)) st.trips = 0;
    return st;
  }

  /** Every port town on the chart (charted or not: a harbour is charted on demand), less those with no harbour. */
  function ports() {
    const c = S.coast, s = sailing();
    const list = c?.portTowns?.() ?? s?.portTowns?.() ?? c?.ports?.() ?? s?.ports?.() ?? [];
    const none = new Set([...(c?.unreachablePorts?.() ?? s?.unreachablePorts?.() ?? [])].map((u) => u?.id));
    return [...list].filter((q) => q?.harbour !== false && !q?.fallback && !String(q?.id ?? '').startsWith('fallback:')).map(portRecord).filter((q) => q && !none.has(q.id));
  }
  /** Ask the core to start (or warm) the sea chart around a harbour; never throws. */
  function warm(id) {
    try { sailing()?.warm?.(id); } catch { /* the chart says why on its own */ }
  }
  const charting = () => ['loading', 'idle'].includes(sailing()?.coastStatus) && !ports().length;

  /** The port the player stands in: the exterior town, or a building of it. */
  function herePort(p) {
    // On a harbour's own quay (it may lie outside the town grid, in the wilderness): the core knows.
    const h = sailing()?.harbourHere?.(p);
    if (h) return portRecord(ports().find((q) => q.id === (h.id ?? h)) ?? h);
    const loc = String(ctx.location(p) ?? '');
    const m = /^(?:town|interior|building):([^/]+\/[^/]+)/.exec(loc);
    if (!m) return null;
    const town = `town:${m[1]}`;
    return ports().find((q) => q.id === town) ?? null;
  }

  const known = (p) => (port) => {
    const t = S.travel;
    if (!t?.quote) return true; // no travel map on this server: every port is named on the chart
    try { t.quote(p, port.id); return true; } catch { return false; }
  };
  // coast.reachable(a, b): true = same open sea; false = no harbour / other water; null = a harbour not yet charted.
  // Only `true` sells a fare where the chart can answer; a server with no chart at all (no reachable) sells by the map.
  const reachable = (a, b) => {
    const c = S.coast ?? null, s = sailing();
    const r = c?.reachable ?? s?.reachable;
    if (typeof r !== 'function') return true;
    const ok = r.call(c?.reachable ? c : s, a.id, b.id);
    if (ok === null) s?.warm?.(b.id);
    return ok === true;
  };

  const gold = (p) => Math.max(0, Math.floor(Number(typeof S.spendableGold === 'function' ? S.spendableGold(p) : p.rpg.gold) || 0));
  function pay(p, n) {
    if (n <= 0) return;
    if (typeof S.spendGold === 'function') S.spendGold(p, n);
    else if (typeof S.takeItem === 'function') S.takeItem(p, 'gold', n);
    else p.rpg.gold = (Number(p.rpg.gold) || 0) - n;
  }
  function refund(p, n) {
    if (n <= 0) return;
    if (typeof S.addGold === 'function') for (let left = n; left > 0; left -= 9999) S.addGold(p, Math.min(9999, left));
    else p.rpg.gold = (Number(p.rpg.gold) || 0) + n;
  }

  const vesselOf = (v) => (v ? sailing()?.byId?.(v.vesselId) ?? null : null);
  const isAboard = (p, vessel) => !!vessel && sailing()?.aboard?.(p) === vessel;

  function voyageView(p, v) {
    if (!v) return null;
    const vessel = vesselOf(v);
    return {
      id: v.id, vesselId: v.vesselId, ship: v.ship, master: v.master, fare: v.fare, state: v.state,
      from: { id: v.from.id, name: v.from.name }, to: { id: v.to.id, name: v.to.name },
      aboard: isAboard(p, vessel), present: !!vessel,
      docked: vessel?.docked ?? null,
      bearing: passageWind(v.from, v.to),
    };
  }

  function status(p, { offers = false } = {}) {
    const st = ensure(p);
    const here = herePort(p);
    let list = null;
    if (offers && here && !st.voyage) {
      list = passageDestinations(ports(), here, { known: known(p), reachable }).map((d) => ({
        portId: d.port.id, name: d.port.name, region: d.port.region, bearing: d.bearing, pixels: d.pixels, fare: d.fare,
      }));
    }
    ctx.notify(p, {
      kind: 'passage.status', silent: true,
      here: here ? { id: here.id, name: here.name } : null,
      voyage: voyageView(p, st.voyage), offers: list, gold: gold(p),
      available: !!sailing()?.charter,
    });
  }

  const say = (p, text) => ctx.notify(p, { kind: 'passage', text });

  /** Replay guard: returns true when this requestId was already done (status repeated, nothing changes). */
  function replayed(p, args) {
    const st = ensure(p);
    const id = typeof args.requestId === 'string' && REQUEST_RE.test(args.requestId) ? args.requestId : null;
    if (id && st.lastRequestId === id) { status(p); return { replay: true, id }; }
    return { replay: false, id };
  }
  const remember = (p, id) => { if (id) ensure(p).lastRequestId = id; };

  function needCore() {
    const s = sailing();
    if (!s || typeof s.charter !== 'function' || typeof s.embark !== 'function' || typeof s.setCourse !== 'function') {
      fail('No ship sails from this harbour yet.');
    }
    return s;
  }

  /** Ashore where she lies docked: the berth interface's disembark, else the core's putAshore. */
  function ashore(p, vessel) {
    const s = sailing();
    if (typeof s?.disembark === 'function') s.disembark(p, vessel);
    else if (typeof s?.putAshore === 'function') s.putAshore(p, vessel.docked);
    else fail('Her gangway is not run out.');
  }

  /** End the passenger's record; retire an empty ownerless charter. */
  function close(p, v, vessel) {
    const st = ensure(p);
    st.voyage = null;
    ctx.dirty(p);
    const s = sailing();
    if (vessel && s?.retire && !vessel.ownerId) {
      const left = (s.crewOf?.(vessel) ?? []).filter((q) => q !== p);
      if (!left.length) s.retire(vessel);
    }
  }

  // ------------------------------------------------------------------ actions

  ctx.onAction('passage.sync', (p) => status(p));
  ctx.onAction('passage.offer', (p) => {
    const st = ensure(p);
    if (st.voyage) fail('You have a passage booked already.');
    const here = herePort(p);
    if (!here) {
      warm(String(ctx.location(p) ?? ''));
      if (charting()) fail('The harbour master is still charting the berths here. Try again in a moment.');
      fail('There is no harbour here. Find a port town to book passage.');
    }
    if (!sailing()?.charter) fail('No ship sails from this harbour yet.');
    warm(here.id);
    status(p, { offers: true });
  });

  ctx.onAction('passage.book', (p, args) => {
    const r = replayed(p, args);
    if (r.replay) return;
    const st = ensure(p);
    if (st.voyage) fail('You have a passage booked already.');
    if (sailing()?.aboard?.(p)) fail('You are already aboard a ship.');
    const here = herePort(p);
    if (!here) fail('There is no harbour here. Find a port town to book passage.');
    if (S.enemiesNearby?.(p)) fail('No master will take you aboard with enemies about.');
    const blocked = S.travelPrevented?.(p);
    if (blocked) fail(blocked);
    const s = needCore();
    const d = passageDestinations(ports(), here, { known: known(p), reachable }).find((x) => x.port.id === args.toPortId);
    if (!d) fail(typeof args.toPortId === 'string' && args.toPortId ? 'Her master knows no way there by sea from here.' : 'Choose a port to sail for.');
    if (args.expectFare !== undefined && args.expectFare !== d.fare) fail(`The fare has changed to ${d.fare} gold. Check it and confirm again.`);
    const have = gold(p);
    if (have < d.fare) fail(`You cannot afford the fare of ${d.fare} gold. You have ${have}.`);

    const id = `pv-${p.id}-${(st.trips + 1).toString(36)}-${Math.floor(ctx.now()).toString(36)}`;
    const ship = pick(SHIP_NAMES, `${here.id}>${d.port.id}#${st.trips}`);
    const master = pick(MASTERS, `${d.port.id}<${here.id}#${st.trips}`);
    const from = { id: here.id, name: here.name, px: here.px, py: here.py };
    const to = { id: d.port.id, name: d.port.name, px: d.port.px, py: d.port.py };
    const record = { passage: id, passengerIds: [p.id], fare: d.fare, from: from.id, to: to.id, bookedAt: Date.now() };

    // All or nothing: the core's calls run inside this action, so a throw anywhere rolls the whole booking back.
    const vessel = s.charter({ fromPortId: here.id, toPortId: to.id, type: PASSAGE_TYPE, name: ship, master, record });
    if (!vessel || typeof vessel.id !== 'string') fail('Her master cannot make ready to sail.');
    ctx.onRollback(() => { try { s.retire?.(vessel); } catch { /* core rolls back its own rows */ } });
    s.embark(p, vessel);
    s.setCourse(vessel, to.id);
    pay(p, d.fare);
    st.voyage = voyageRecord({ id, vesselId: vessel.id, ship, master, type: PASSAGE_TYPE, from, to, fare: d.fare, state: 'underway', bookedAt: record.bookedAt, requestId: r.id });
    st.trips += 1;
    remember(p, r.id);
    ctx.dirty(p);
    say(p, `Captain ${master} takes your ${d.fare} gold. The ${ship} sails for ${to.name}, ${passageWind(from, to)}. Her master steers; walk her deck as you like.`);
    status(p);
    ctx.emit('passage.booked', { player: p, voyage: st.voyage, vessel });
  });

  ctx.onAction('passage.rejoin', (p, args) => {
    const r = replayed(p, args);
    if (r.replay) return;
    const st = ensure(p);
    const v = st.voyage;
    if (!v) fail('You have no passage booked.');
    const vessel = vesselOf(v);
    if (!vessel) return settleLost(p, v);
    if (isAboard(p, vessel)) { status(p); return; }
    needCore().embark(p, vessel);
    remember(p, r.id);
    ctx.dirty(p);
    say(p, `You are back aboard the ${v.ship}, bound for ${v.to.name}.`);
    status(p);
  });

  ctx.onAction('passage.disembark', (p, args) => {
    const r = replayed(p, args);
    if (r.replay) return;
    const st = ensure(p);
    const v = st.voyage;
    if (!v) fail('You have no passage booked.');
    const vessel = vesselOf(v);
    if (!vessel) return settleLost(p, v);
    if (vessel.docked !== v.to.id) fail(`The ${v.ship} has not yet made ${v.to.name}. Her master will not put you over the side.`);
    if (isAboard(p, vessel)) ashore(p, vessel);
    remember(p, r.id);
    const name = v.ship, dest = v.to.name;
    close(p, v, vessel);
    say(p, `You step ashore at ${dest}. The ${name} stands out to sea.`);
    status(p);
    ctx.emit('passage.ended', { player: p, voyage: v, arrived: true });
  });

  ctx.onAction('passage.cancel', (p, args) => {
    const r = replayed(p, args);
    if (r.replay) return;
    const st = ensure(p);
    const v = st.voyage;
    if (!v) fail('You have no passage booked.');
    const vessel = vesselOf(v);
    if (vessel && vessel.docked !== v.from.id) fail('She has cast off. Her master sails on for your port.');
    if (vessel && isAboard(p, vessel)) ashore(p, vessel);
    refund(p, v.fare);
    remember(p, r.id);
    close(p, v, vessel);
    say(p, `Her master returns your ${v.fare} gold.`);
    status(p);
  });

  /** Her vessel is gone (an operator wipe, a core that lost her): the passage resolves in the passenger's favour. */
  function settleLost(p, v) {
    const st = ensure(p);
    if (v.state !== 'arrived') refund(p, v.fare);
    st.voyage = null;
    ctx.dirty(p);
    say(p, v.state === 'arrived' ? 'Your passage is over.' : `The ${v.ship} could not be found; her master's ${v.fare} gold is returned to you.`);
    status(p);
  }

  // ------------------------------------------------------------------ the passage's life

  /** Arrival: she lies docked at the paid-for port. Kept in a tick as well as on the core's event so either path works. */
  function checkArrival(p) {
    const st = p.rpg?.passage;
    const v = st?.voyage;
    if (!v || v.state === 'arrived') return;
    const vessel = vesselOf(v);
    if (!vessel) return;
    if (v.state === 'boarding' && vessel.docked !== v.from.id) v.state = 'underway';
    if (vessel.docked === v.to.id) {
      v.state = 'arrived';
      ctx.dirty(p);
      say(p, `The ${v.ship} is made fast at ${v.to.name}'s quay. Disembark to go ashore.`);
      status(p);
      ctx.emit('passage.arrived', { player: p, voyage: v, vessel });
    }
  }

  const onDocked = ({ vessel } = {}) => {
    if (!vessel) return;
    for (const p of ctx.players.values()) if (p.rpg?.passage?.voyage?.vesselId === vessel.id) checkArrival(p);
  };
  ctx.on('sailingDocked', onDocked); // the core's event (server/rpg/sailing.js)
  ctx.on('sailing.docked', onDocked);
  // A passenger put ashore by the core while the record still says aboard (a retire, a wreck): the status refreshes.
  ctx.on('sailingAboardChanged', ({ player } = {}) => { if (player?.rpg?.passage?.voyage) status(player); });
  // Her master can find no way (no route within the core's wait, or an end with no harbour): she never left, so each
  // passenger is put ashore at the berth they boarded from and the fare is returned; the empty charter is retired.
  ctx.on('sailingCourseFailed', ({ vessel } = {}) => {
    if (!vessel) return;
    for (const p of [...ctx.players.values()]) {
      const v = p.rpg?.passage?.voyage;
      if (v?.vesselId !== vessel.id || v.state === 'arrived') continue;
      const run = () => {
        ctx.dirty(p);
        const live = vesselOf(v);
        if (live && isAboard(p, live) && live.docked) ashore(p, live);
        refund(p, v.fare);
        close(p, v, live);
        say(p, `Her master can find no way to ${v.to.name} by sea. He returns your ${v.fare} gold.`);
        status(p);
      };
      if (typeof ctx.runAtomic === 'function') ctx.runAtomic(p, 'passage.courseFailed', run);
      else run();
    }
  });
  // She founders: the core puts her people ashore; the passage ends and, never having arrived, its fare is returned.
  ctx.on('sailingWrecked', ({ vessel } = {}) => {
    if (!vessel) return;
    for (const p of ctx.players.values()) {
      const v = p.rpg?.passage?.voyage;
      if (v?.vesselId !== vessel.id) continue;
      ctx.dirty(p);
      if (v.state !== 'arrived') refund(p, v.fare);
      p.rpg.passage.voyage = null;
      say(p, `The ${v.ship} founders. Her master returns your ${v.fare} gold.`);
      status(p);
    }
  });

  let acc = 0;
  ctx.onTick((dt) => {
    acc += Number(dt) || 0; // seconds
    if (acc < 1) return;
    acc = 0;
    for (const p of ctx.players.values()) checkArrival(p);
  });

  ctx.onJoin((p) => {
    const st = ensure(p);
    if (st.voyage) {
      // Reconnect / restart: tell the browser it can rejoin. Never auto-moves the player.
      status(p);
    }
  });

  S.passage = {
    /** The passenger's voyage (copy) or null. */
    voyageOf: (p) => (p?.rpg?.passage?.voyage ? { ...p.rpg.passage.voyage } : null),
    /** True when this player rides as a fare-paying passenger on `vessel` (the core may deny them command with it). */
    isPassenger: (p, vessel) => !!vessel && p?.rpg?.passage?.voyage?.vesselId === vessel.id,
    destinations: (p) => {
      const here = herePort(p);
      return here ? passageDestinations(ports(), here, { known: known(p), reachable }) : [];
    },
  };
}
