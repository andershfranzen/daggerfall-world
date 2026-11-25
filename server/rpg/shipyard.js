// Shipyard, fleet, ship's stores, crew hall, port market and harbour board (docs: header of this file).
//
// Owns `rpg.shipyard` (per character, saved with the character):
//   { version: 1,
//     ships:  [{ id, hull, name, port, at:'port'|'sea', departedAt, paid, boughtAt, hullHp, sailHp,
//                refits:{hold,rigging,hull,guns}, stores:{provisions,shot,timber},
//                crew:[{id,name,role,wage,morale}], cargo:[{good,qty,paid?,contractId?}], legacy?:'small'|'large' }],
//     active: shipId|null,
//     contracts: [{id, shipId, from, to, toName, units, kind, pay, due, takenAt}],
//     done: [contractId…]          paid once, never again
//     taken: {day, offers:[id…], recruits:[id…]}   today's board offers and recruits this captain already took
//     market: {[portId]: {day, bought:{good:n}, sold:{good:n}}}
//     ports: [portId…]             real sea ports this captain has seen (fallback destinations for the board)
//     recent: [requestId…], seq }
//
// Existing classic owners: a `rpg.property.ship` deed (small/large) appears in the fleet as `legacy-<type>`
// with a one-time skeleton crew and stores; its private item hold stays `rpg.property.stores.ship`. Buying a
// Small ship or Large galleon here when the character has no classic deed also writes that deed, so the classic
// deck, cabin and free sea passage work unchanged.
//
// Every action is validated first and changes state inside the runtime's single transaction: a refusal or a
// failed save leaves gold, letters of credit, ships, stores, crew and cargo untouched. A repeated `requestId`
// is refused before anything else.
//
// Services on ctx.services.shipyard (for sailing core and naval combat; see contract notes on each):
//   fleet(p), ship(p, id), active(p), stats(p, id), canSail(p, id), dockedAt(p, id)
//   departed(p, id), arrived(p, id, portId)
//   spend(p, id, {shot, provisions, timber}), damage(p, id, {hull, sail}), seaRepair(p, id)
//   loseCrew(p, id, n), gainCrew(p, id, hands), addCargo(p, id, goods), takeCargo(p, id, share)
// Events: ctx.emit('shipyardChanged', {player, shipId, reason}).
import {
  HULLS, HULL_IDS, REFIT_IDS, REFIT_LINES, REFIT_TIERS, STORES, STORE_IDS, TIMBER_MENDS, cleanShipName, defaultShipName,
  hullOf, refitBlocked, refitCost, repairQuote, salePrice, shipWorth, statsOf,
} from './sailing/yard.js';
import { DESERT, MORALE_HUNGRY, MORALE_MAX, MORALE_PORT, MORALE_START, MORALE_UNPAID, ROLES, WAGE, dailyWages, recruitsAt, roleCounts } from './sailing/yardCrew.js';
import { CONTRACTS_MAX, CONTRACT_GOOD, GOODS, LATE_SHARE, boardAt, marketAt } from './sailing/yardTrade.js';
import { SHIPS, deedSellPrice, exteriorTownOf } from '../../client/gameplay/property/rules.js';
import { placeOf } from '../../client/gameplay/townServices/rules.js';

export const name = 'shipyard';
export const VERSION = 1;

const REQUEST_RE = /^[\w-]{6,64}$/;
const ID_RE = /^[\w-]{1,48}$/;
const RECENT_MAX = 64;
const DONE_MAX = 256;
const SHIPS_MAX = 6;
const PORTS_MAX = 64;
const DAY = 1440;
const SEA_PIXEL = 819.2; // metres per world-map pixel (server/rpg/sailing/voyage.js PIXEL)
const fail = (msg) => {
  throw new Error(msg);
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const int = (v, d = 0) => (Number.isFinite(v) ? Math.trunc(v) : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : null);
const ids = (list, n) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string' && ID_RE.test(s)).slice(-n) : []);
const gold = (n) => Math.round(n).toLocaleString('en-US');

function cleanShip(s) {
  if (!isObj(s) || typeof s.id !== 'string' || !ID_RE.test(s.id) || !hullOf(s.hull)) return null;
  const refits = {};
  for (const l of REFIT_IDS) refits[l] = clamp(int(s.refits?.[l]), 0, REFIT_TIERS);
  const st = statsOf(s.hull, refits);
  const stores = {};
  for (const k of STORE_IDS) stores[k] = clamp(int(s.stores?.[k]), 0, st.stores[k]);
  const crew = (Array.isArray(s.crew) ? s.crew : []).filter((h) => isObj(h) && typeof h.id === 'string' && ID_RE.test(h.id) && ROLES.includes(h.role))
    .slice(0, st.crewMax)
    .map((h) => ({ id: h.id, name: str(h.name, 48) ?? 'A hand', role: h.role, wage: clamp(int(h.wage, WAGE[h.role]), 0, 1000), morale: clamp(int(h.morale, MORALE_START), 0, MORALE_MAX) }));
  const cargo = (Array.isArray(s.cargo) ? s.cargo : []).filter((c) => isObj(c) && (GOODS[c.good] || (c.good === CONTRACT_GOOD && typeof c.contractId === 'string')) && int(c.qty) > 0)
    .map((c) => ({ good: c.good, qty: int(c.qty), ...(Number.isFinite(c.paid) ? { paid: Math.max(0, c.paid) } : {}), ...(c.contractId ? { contractId: String(c.contractId).slice(0, 48) } : {}) }));
  return {
    id: s.id, hull: s.hull, name: cleanShipName(s.name) ?? defaultShipName(s.id), port: str(s.port), at: s.at === 'sea' ? 'sea' : 'port',
    departedAt: Number.isFinite(s.departedAt) ? Math.trunc(s.departedAt) : null, arrivedAt: Number.isFinite(s.arrivedAt) ? Math.trunc(s.arrivedAt) : null, paid: Math.max(0, int(s.paid, hullOf(s.hull).price)),
    boughtAt: int(s.boughtAt), hullHp: clamp(Number.isFinite(s.hullHp) ? Math.round(s.hullHp) : st.hullMax, 0, st.hullMax),
    sailHp: clamp(Number.isFinite(s.sailHp) ? Math.round(s.sailHp) : st.sailMax, 0, st.sailMax),
    refits, stores, crew, cargo, ...(s.legacy === 'small' || s.legacy === 'large' ? { legacy: s.legacy } : {}),
  };
}

/** Normalizes stored state in place; drops anything malformed. */
export function normalizeShipyard(rpg) {
  const raw = isObj(rpg.shipyard) ? rpg.shipyard : {};
  const ships = [];
  for (const s of Array.isArray(raw.ships) ? raw.ships : []) {
    const c = cleanShip(s);
    if (c && !ships.some((x) => x.id === c.id) && ships.length < SHIPS_MAX + 2) ships.push(c);
  }
  const contracts = (Array.isArray(raw.contracts) ? raw.contracts : []).filter((c) => isObj(c) && ID_RE.test(c.id ?? '') && ships.some((s) => s.id === c.shipId) && typeof c.to === 'string')
    .slice(0, CONTRACTS_MAX).map((c) => ({
      id: c.id, shipId: c.shipId, from: str(c.from), fromName: str(c.fromName, 80), to: str(c.to), toName: str(c.toName, 80) ?? c.to,
      units: clamp(int(c.units), 1, 999), kind: str(c.kind, 80) ?? 'cargo', pay: clamp(int(c.pay), 0, 1e6), due: int(c.due), takenAt: int(c.takenAt),
    }));
  const market = {};
  for (const [k, m] of Object.entries(isObj(raw.market) ? raw.market : {})) {
    if (typeof k !== 'string' || k.length > 200 || k === '__proto__' || !isObj(m)) continue;
    const side = (o) => Object.fromEntries(Object.entries(isObj(o) ? o : {}).filter(([g, n]) => GOODS[g] && int(n) > 0).map(([g, n]) => [g, int(n)]));
    market[k] = { day: int(m.day), bought: side(m.bought), sold: side(m.sold) };
  }
  const taken = isObj(raw.taken) ? raw.taken : {};
  rpg.shipyard = {
    version: VERSION, ships, active: ships.some((s) => s.id === raw.active) ? raw.active : (ships[0]?.id ?? null), contracts,
    done: ids(raw.done, DONE_MAX), taken: { day: int(taken.day, -1), offers: ids(taken.offers, 32), recruits: ids(taken.recruits, 64) },
    market, ports: (Array.isArray(raw.ports) ? raw.ports : []).filter((s) => typeof s === 'string' && s.length <= 200).slice(-PORTS_MAX),
    legacyGranted: (Array.isArray(raw.legacyGranted) ? raw.legacyGranted : []).filter((t) => t === 'small' || t === 'large'),
    recent: (Array.isArray(raw.recent) ? raw.recent : []).filter((s) => typeof s === 'string' && REQUEST_RE.test(s)).slice(-RECENT_MAX),
    seq: Math.max(0, int(raw.seq)),
  };
  return rpg.shipyard;
}

export function install(ctx) {
  const log = ctx.log ?? console;
  const services = (ctx.services ||= {});
  const knownPorts = new Map(); // port id -> {id, name, region, px, py}: every real port any captain stood in

  // ------------------------------------------------------------------ state

  const stateOf = (p) => {
    if (!isObj(p.rpg)) p.rpg = {};
    if (!isObj(p.rpg.shipyard) || p.rpg.shipyard.version !== VERSION) normalizeShipyard(p.rpg);
    if (syncLegacy(p, p.rpg.shipyard)) ctx.dirty?.(p);
    return p.rpg.shipyard;
  };
  const worldMinutes = () => {
    const c = typeof services.worldClock === 'function' ? services.worldClock() : null;
    return c && Number.isFinite(c.minutes) ? Math.trunc(c.minutes) : 0;
  };
  const playerMinutes = (p) => {
    const v = typeof services.playerMinutes === 'function' ? services.playerMinutes(p) : null;
    return Number.isFinite(v) ? Math.trunc(v) : worldMinutes();
  };
  const today = () => Math.floor(worldMinutes() / DAY);
  const location = (p) => (typeof ctx.location === 'function' ? ctx.location(p) : p.rpg?.location);
  const say = (p, text, extra = {}) => ctx.notify(p, { kind: 'shipyard', text, ...extra });
  const changed = (p, shipId, reason) => {
    ctx.dirty?.(p);
    try {
      ctx.emit?.('shipyardChanged', { player: p, shipId, reason });
    } catch (err) {
      log.error?.('[shipyard] shipyardChanged listener failed:', err);
    }
  };

  /** Mirror a classic property deed into the fleet (once granted a skeleton crew and stores), drop a sold one. */
  function syncLegacy(p, st) {
    const deed = isObj(p.rpg.property?.ship) ? p.rpg.property.ship.type : null;
    let touched = false;
    for (let i = st.ships.length - 1; i >= 0; i--) {
      const s = st.ships[i];
      if (s.legacy && s.legacy !== deed) {
        st.ships.splice(i, 1);
        st.contracts = st.contracts.filter((c) => c.shipId !== s.id);
        if (st.active === s.id) st.active = st.ships[0]?.id ?? null;
        touched = true;
      }
    }
    if (!deed || !SHIPS[deed] || st.ships.some((s) => s.legacy === deed)) return touched;
    const id = `legacy-${deed}`;
    const ship = cleanShip({ id, hull: deed, name: `The ${SHIPS[deed].label}`, port: null, at: 'port', paid: SHIPS[deed].price, boughtAt: int(p.rpg.property.ship.boughtAt), legacy: deed });
    if (!st.legacyGranted.includes(deed)) {
      st.legacyGranted.push(deed);
      const stats = statsOf(deed);
      ship.crew = Array.from({ length: stats.crewMin }, (_, i) => ({ id: `${id}-h${i}`, name: recruitsAt(id, i)[0].name, role: i === 0 ? 'Mate' : i === 1 ? 'Gunner' : 'Deckhand', wage: WAGE[i === 0 ? 'Mate' : i === 1 ? 'Gunner' : 'Deckhand'], morale: MORALE_START }));
      ship.stores = { provisions: Math.min(stats.stores.provisions, (stats.crewMin + 1) * 10), shot: stats.guns * 4, timber: 4 };
    }
    st.ships.unshift(ship);
    st.active ||= id;
    return true;
  }

  function claimRequest(st, args) {
    const rid = args?.requestId;
    if (rid == null) return;
    if (typeof rid !== 'string' || !REQUEST_RE.test(rid)) fail('Invalid request.');
    if (st.recent.includes(rid)) fail('That was already done.');
    st.recent.push(rid);
    if (st.recent.length > RECENT_MAX) st.recent.splice(0, st.recent.length - RECENT_MAX);
  }
  function freshDay(st) {
    const d = today();
    if (st.taken.day !== d) st.taken = { day: d, offers: [], recruits: [] };
    return d;
  }

  // ------------------------------------------------------------------ ports

  function portInfo(id) {
    const e = services.travel?.lookup?.(id);
    const pl = placeOf(id);
    return {
      id, name: e?.name ?? pl?.location ?? id, region: e?.region ?? pl?.region ?? null,
      px: Number.isFinite(e?.x) ? e.x : Number.isFinite(e?.px) ? e.px : null, py: Number.isFinite(e?.y) ? e.y : Number.isFinite(e?.py) ? e.py : null,
    };
  }
  /** The real port town the player stands in (outside or in one of its buildings), or a refusal. */
  function portOf(p) {
    const loc = location(p);
    const town = exteriorTownOf(loc);
    if (!town) return { port: null, refusal: 'There is no shipyard here. Ships are bought and fitted in port towns.' };
    if (services.property?.isShipLocation?.(town)) return { port: null, refusal: 'Go ashore in a port first.' };
    const tp = typeof services.townProperty === 'function' ? services.townProperty(town) : null;
    if (!tp || tp.status !== 'ready') return { port: null, refusal: tp?.status === 'failed' ? 'This town has no harbour records.' : 'The harbourmaster is still reading the town records. Try again in a moment.' };
    if (tp.port !== true) return { port: null, refusal: 'This town has no harbour. Ships are bought and fitted in port towns.' };
    const info = portInfo(town);
    knownPorts.set(town, info);
    return { port: info, refusal: null };
  }
  function needPort(p) {
    const { port, refusal } = portOf(p);
    if (!port) fail(refusal);
    return port;
  }
  /** Real sea ports for the harbour board: the geography service's, else every port this captain or anyone here has seen. */
  function seaPorts(st) {
    // Consignees live somewhere: dungeons, ruins, graveyards, covens and shrines flagged as harbours get no cargo.
    const UNINHABITED = new Set([4, 7, 9, 10, 12, 13, 'labyrinth', 'keep', 'cult', 'ruin', 'graveyard', 'coven']);
    const real = (list) => (Array.isArray(list) ? list.filter((q) => q && typeof q.id === 'string' && !q.id.startsWith('fallback:') && !UNINHABITED.has(q.type)) : []);
    let list = typeof services.seaPorts === 'function' ? real(services.seaPorts()) : [];
    const c = coastObj();
    if (!list.length && c) {
      list = real(c.portTowns?.());
      if (!list.length) list = real(c.ports?.());
      const bad = unreachableIds(c);
      list = list.filter((q) => !bad.has(q.id));
    }
    if (!list.length && typeof services.sailing?.ports === 'function') list = real(services.sailing.ports());
    if (list.length) {
      return list.map((q) => ({
        id: q.id, name: q.name ?? portInfo(q.id).name,
        px: Number.isFinite(q.px) ? q.px : Number.isFinite(q.x) ? q.x / SEA_PIXEL : null,
        py: Number.isFinite(q.py) ? q.py : Number.isFinite(q.z) ? q.z / SEA_PIXEL : null,
      }));
    }
    const out = new Map(knownPorts);
    for (const id of st.ports) if (!out.has(id)) out.set(id, portInfo(id));
    return [...out.values()];
  }
  /**
   * The real coast (server/rpg/sailing/coast.js), shared with the sailing core: services.coast once started, else
   * services.sailing.coast() which starts the lazy chart. Never its labelled fallback world.
   */
  function coastObj() {
    let c = services.coast ?? null;
    if (!c && typeof services.sailing?.coast === 'function') {
      try {
        c = services.sailing.coast();
      } catch {
        c = null;
      }
    }
    if (!c || c.world?.fallback === true || c.status === 'failed') return null;
    return c;
  }
  const unreachableIds = (c) => new Set((c?.unreachablePorts?.() ?? []).map((u) => u?.id).filter(Boolean));
  /** Sea route {leagues, days}; null while the coast is still working it out (the map distance stands in); `false`
   *  only when the coast has found no water to one of the two ports (the offer is skipped). */
  const route = (a, b) => {
    if (typeof services.seaRoute === 'function') return services.seaRoute(a, b);
    const c = coastObj();
    if (!c) return null;
    const bad = unreachableIds(c);
    if (bad.has(a) || bad.has(b)) return false;
    if (c.status !== 'ready' || typeof c.route !== 'function') return null;
    const r = c.route(a, b);
    return r && Number.isFinite(r.leagues) ? r : null;
  };

  /** Where a ship lies now: the sailing core's word when it has one, else this record's. */
  function dockedAt(p, ship) {
    const v = vesselOf(p, ship);
    if (v) return v.sunk ? null : (v.docked ?? null);
    if (ship.at !== 'port') return null;
    return ship.port;
  }
  /** The sailing core's live vessel for a ship record: a classic deed sails as the owner's vessel `v<playerId>`. */
  function vesselOf(p, ship) {
    const sail = services.sailing;
    if (!sail) return null;
    const byShip = [...(sail.vessels?.() ?? [])].find((v) => v?.shipId === ship.id && v.ownerId === p.id);
    if (byShip) return byShip;
    const own = sail.byId?.(`v${p.id}`) ?? null;
    return own && ship.legacy && own.type === ship.legacy && own.shipId == null ? own : null;
  }
  /** A ship of the player's lying at this port. A classic deed's ship never sailed yet answers at any port. */
  function shipHere(p, st, shipId, port) {
    const s = shipById(st, shipId);
    pullHull(p, s);
    const at = dockedAt(p, s);
    if (s.legacy && s.port == null && s.at === 'port' && !vesselOf(p, s)) {
      s.port = port.id;
      return s;
    }
    if (at !== port.id) fail(s.at === 'sea' ? `${s.name} is at sea.` : `${s.name} is berthed at ${portInfo(s.port).name}, not here.`);
    if (services.naval?.inCombat?.(p, s.id)) fail('Not while the ship is in combat.');
    return s;
  }
  function shipById(st, shipId) {
    const s = st.ships.find((x) => x.id === shipId);
    if (!s) fail('No such ship of yours.');
    return s;
  }

  // ------------------------------------------------------------------ money

  const spendable = (p) => (typeof services.spendableGold === 'function' ? services.spendableGold(p) : Math.max(0, int(p.rpg?.gold)));
  function pay(p, amount, what) {
    amount = Math.max(0, Math.round(amount));
    if (!amount) return;
    if (amount > spendable(p)) fail(`${what} costs ${gold(amount)} gold. You have ${gold(spendable(p))}.`);
    if (typeof services.spendGold === 'function') services.spendGold(p, amount);
    else if (typeof services.takeGold === 'function') services.takeGold(p, amount);
    else fail('The shipyard cannot take payment right now.');
  }
  function earn(p, amount) {
    amount = Math.max(0, Math.round(amount));
    if (!amount) return;
    if (typeof services.addGold !== 'function') fail('The shipyard cannot pay out right now.');
    for (let left = amount; left > 0; left -= 9999) services.addGold(p, Math.min(9999, left));
  }
  /** Admiralty rank with this port's region: 0..0.2 off yard work (server/rpg/admiralty.js; 0 when absent). */
  const rankOff = (p, port) => clamp(Number(port ? services.admiralty?.yardDiscount?.(p, port.region) : 0) || 0, 0, 0.2);
  const yardPrice = (gold, off) => (gold > 0 ? Math.max(1, Math.round(gold * (1 - off))) : 0);
  const quoteRepair = (p, s, port, stats) => {
    const q = repairQuote(s, stats);
    const off = rankOff(p, port);
    return { hull: { ...q.hull, gold: yardPrice(q.hull.gold, off) }, sail: { ...q.sail, gold: yardPrice(q.sail.gold, off) } };
  };
  const quoteRefit = (p, s, line, port) => {
    const c = refitCost(s.hull, line, s.refits[line]);
    return c == null ? null : yardPrice(c, rankOff(p, port));
  };
  /** Mercantile haggling: up to 10% off buying and onto selling. */
  const edgeOf = (p) => clamp((Number(p.rpg?.character?.skills?.Mercantile) || 0) / 1000, 0, 0.1);

  const cargoUsed = (s) => s.cargo.reduce((n, c) => n + c.qty, 0);
  const capacityOf = (s) => statsOf(s.hull, s.refits).capacity;

  // ------------------------------------------------------------------ voyage settlement

  /** Arrival at a real port: wages and rations for the days at sea, desertion, delivery contracts. Idempotent per voyage. */
  function settleArrival(p, st, s, portId, vessel = null) {
    const lines = [];
    const now = playerMinutes(p);
    const launched = vessel && Number.isFinite(vessel.launchedAt) ? vessel.launchedAt + (now - worldMinutes()) : null;
    const start = s.departedAt ?? launched;
    const days = start != null ? Math.max(0, now - start) / DAY : 0;
    s.at = 'port';
    s.port = portId;
    s.departedAt = null;
    if (!st.ports.includes(portId)) st.ports.push(portId);
    if (st.ports.length > PORTS_MAX) st.ports.splice(0, st.ports.length - PORTS_MAX);
    if (days > 0) {
      const mouths = s.crew.length + 1;
      const need = Math.ceil(mouths * days);
      const eaten = Math.min(need, s.stores.provisions);
      s.stores.provisions -= eaten;
      const hungry = need > eaten;
      const wages = Math.ceil(dailyWages(s) * days);
      const paid = Math.min(wages, spendable(p));
      if (paid > 0) pay(p, paid, 'Wages');
      const unpaid = wages > paid;
      for (const h of s.crew) {
        if (hungry) h.morale -= MORALE_HUNGRY * Math.ceil(days * (1 - eaten / need));
        if (unpaid) h.morale -= MORALE_UNPAID;
        h.morale = clamp(h.morale + MORALE_PORT, 0, MORALE_MAX);
      }
      if (wages) lines.push(unpaid ? `You could pay only ${gold(paid)} of ${gold(wages)} gold in wages.` : `Wages paid: ${gold(wages)} gold.`);
      if (hungry) lines.push('The provisions ran out on the way; the crew went hungry.');
    }
    const gone = s.crew.filter((h) => h.morale <= DESERT);
    if (gone.length) {
      s.crew = s.crew.filter((h) => h.morale > DESERT);
      lines.push(`${gone.map((h) => h.name).join(', ')} ${gone.length > 1 ? 'have' : 'has'} left the ship.`);
    }
    for (const c of [...st.contracts]) {
      if (c.shipId !== s.id || c.to !== portId || st.done.includes(c.id)) continue;
      const late = now > c.due;
      const reward = late ? Math.floor(c.pay * LATE_SHARE) : c.pay;
      s.cargo = s.cargo.filter((x) => x.contractId !== c.id);
      st.contracts = st.contracts.filter((x) => x.id !== c.id);
      st.done.push(c.id);
      if (st.done.length > DONE_MAX) st.done.splice(0, st.done.length - DONE_MAX);
      earn(p, reward);
      lines.push(late ? `Delivered ${c.kind} late to ${c.toName}: the consignee pays half, ${gold(reward)} gold.` : `Delivered ${c.kind} to ${c.toName}: ${gold(reward)} gold paid.`);
      ctx.emit?.('shipyardDelivery', { player: p, contract: { ...c }, reward, late });
    }
    return lines;
  }

  /** Inside an action: run in its transaction. Outside: its own transaction (saved or rolled back); a refusal throws. */
  function atomic(p, label, fn) {
    if (ctx.inAction?.() || typeof ctx.runAtomic !== 'function') return fn();
    let out;
    const r = ctx.runAtomic(p, label, () => {
      out = fn();
    });
    if (r && r.ok === false) fail(r.error ?? 'That could not be done.');
    return out;
  }

  // ------------------------------------------------------------------ views

  function shipView(p, st, s, port) {
    pullHull(p, s);
    const stats = statsOf(s.hull, s.refits);
    const here = port && (dockedAt(p, s) === port.id || (s.legacy && s.port == null && s.at === 'port' && !vesselOf(p, s)));
    return {
      id: s.id, name: s.name, hull: s.hull, label: stats.label, legacy: s.legacy ?? null, active: st.active === s.id,
      port: s.port, portName: s.port ? portInfo(s.port).name : null, at: s.at, here: !!here,
      hullHp: s.hullHp, sailHp: s.sailHp, stats, refits: { ...s.refits }, stores: { ...s.stores },
      crew: s.crew.map((h) => ({ ...h })), roles: roleCounts(s), wages: dailyWages(s),
      cargo: s.cargo.map((c) => ({ ...c, label: c.good === CONTRACT_GOOD ? 'Consignment' : GOODS[c.good].label })), cargoUsed: cargoUsed(s),
      worth: shipWorth(s), salePrice: s.legacy ? deedSellPrice(SHIPS[s.legacy].price) : salePrice(s), repair: quoteRepair(p, s, port, stats),
      refitCosts: Object.fromEntries(REFIT_IDS.map((l) => [l, refitBlocked(s.hull, l) || s.refits[l] >= REFIT_TIERS ? null : quoteRefit(p, s, l, port)])),
      canSail: sailRefusal(p, s),
    };
  }
  function status(p) {
    const st = stateOf(p);
    const { port, refusal } = portOf(p);
    const day = freshDay(st);
    const view = {
      kind: 'shipyard.status', port, refusal, day, gold: spendable(p), active: st.active,
      hulls: HULL_IDS.map((h) => ({ ...HULLS[h], stats: statsOf(h) })),
      refitLines: REFIT_IDS.map((l) => ({ ...REFIT_LINES[l], tiers: REFIT_TIERS })),
      stores: STORE_IDS.map((k) => ({ ...STORES[k] })),
      fleet: st.ships.map((s) => shipView(p, st, s, port)),
      contracts: st.contracts.map((c) => ({ ...c, overdue: playerMinutes(p) > c.due })),
      market: [], board: [], recruits: [],
    };
    if (port) {
      view.market = marketAt(port.id, day, { edge: edgeOf(p), dealt: st.market[port.id]?.day === day ? st.market[port.id] : null });
      view.board = boardAt(port, day, seaPorts(st), { route, taken: st.taken.offers });
      view.recruits = recruitsAt(port.id, day, st.taken.recruits);
    }
    return view;
  }
  const sendStatus = (p) => ctx.notify(p, status(p));

  // ------------------------------------------------------------------ rules shared by actions and services

  function sailRefusal(p, s) {
    const stats = statsOf(s.hull, s.refits);
    if (s.hullHp <= 0) return `${s.name} is a wreck. Have her repaired first.`;
    if (s.crew.length < stats.crewMin) return `${s.name} needs at least ${stats.crewMin} hands to sail; she has ${s.crew.length}.`;
    if (stats.crewMin > 0 && s.stores.provisions < s.crew.length + 1) return `${s.name} has no provisions. Buy some at the shipyard.`;
    if (cargoUsed(s) > stats.capacity) return `${s.name} is overloaded.`;
    return null;
  }

  // ------------------------------------------------------------------ actions

  const handlers = {
    status: () => {},
    buy(p, st, args, port) {
      const h = hullOf(args.hull);
      if (!h) fail('Which ship?');
      if (args.expectPrice !== undefined && args.expectPrice !== h.price) fail(`The price is now ${gold(h.price)} gold. Look again.`);
      if (st.ships.length >= SHIPS_MAX) fail(`The harbour registers at most ${SHIPS_MAX} ships to one captain.`);
      const named = args.name == null ? null : cleanShipName(args.name);
      if (args.name != null && !named) fail('That name will not fit on a stern board.');
      pay(p, h.price, `The ${h.label.toLowerCase()}`);
      const id = `sh-${(++st.seq).toString(36)}-${(int(ctx.now?.() ?? 0) % 1679616).toString(36)}`;
      const classic = h.classic && !p.rpg.property?.ship ? h.classic : null;
      const ship = cleanShip({ id, hull: h.id, name: named ?? defaultShipName(`${p.id}|${id}`), port: port.id, at: 'port', paid: h.price, boughtAt: playerMinutes(p), ...(classic ? { legacy: classic } : {}) });
      if (classic) {
        if (!isObj(p.rpg.property)) fail('The harbour registry is closed right now.');
        p.rpg.property.ship = { type: classic, boughtAt: worldMinutes() };
        st.legacyGranted.push(classic); // a ship bought here comes with no free crew
        services.travel?.discover?.(p, services.property?.shipLocation?.(classic));
      }
      st.ships.push(ship);
      st.active = ship.id;
      say(p, `${ship.name}, a ${h.label.toLowerCase()}, is yours for ${gold(h.price)} gold, berthed here at ${port.name}.${h.crewMin ? ` Sign on at least ${h.crewMin} hands at the crew hall and buy provisions before you sail.` : ' Push off whenever you like.'}`);
      return ship.id;
    },
    sell(p, st, args, port) {
      const s = shipHere(p, st, args.shipId, port);
      if (s.cargo.length) fail('Empty the hold first. The shipwright does not buy cargo.');
      if (st.contracts.some((c) => c.shipId === s.id)) fail('She still carries a consignment. Deliver or abandon it first.');
      if (s.legacy && p.rpg.property?.stores?.ship?.length) fail('Your belongings are still in her hold. Take them out first.');
      const price = s.legacy ? deedSellPrice(SHIPS[s.legacy].price) : salePrice(s);
      if (s.legacy) {
        if (services.property?.isShipLocation?.(location(p))) fail('Go ashore first.');
        const sailing = services.sailing?.refusal?.(p, 'ship.sell');
        if (sailing) fail(sailing);
        p.rpg.property.ship = null;
        p.rpg.property.board = null;
        delete p.rpg.property.stores?.ship;
      }
      st.ships = st.ships.filter((x) => x !== s);
      if (st.active === s.id) st.active = st.ships[0]?.id ?? null;
      earn(p, price);
      say(p, `The shipwright buys ${s.name} for ${gold(price)} gold.${s.crew.length ? ' Her crew are paid off on the quay.' : ''}`);
      return s.id;
    },
    rename(p, st, args) {
      const s = shipById(st, args.shipId);
      const n = cleanShipName(args.name);
      if (!n) fail('That name will not fit on a stern board.');
      s.name = n;
      say(p, `She is the ${n} now.`);
      return s.id;
    },
    activate(p, st, args) {
      const s = shipById(st, args.shipId);
      const v = services.sailing?.byId?.(`v${p.id}`) ?? null;
      if (v && !v.docked && !v.sunk && v.shipId && v.shipId !== s.id) fail('Your flagship is at sea. Bring her into port first.');
      if (v && services.sailing?.crewOf?.(v)?.length) fail('See everyone ashore before you change your flagship.');
      st.active = s.id;
      say(p, `${s.name} is your flagship.`);
      return s.id;
    },
    refit(p, st, args, port) {
      const s = shipHere(p, st, args.shipId, port);
      const line = args.line;
      if (!REFIT_LINES[line]) fail('Which refit?');
      const blocked = refitBlocked(s.hull, line);
      if (blocked) fail(blocked);
      if (s.refits[line] >= REFIT_TIERS) fail(`Her ${REFIT_LINES[line].label.toLowerCase()} is already the best the yard can build.`);
      const cost = quoteRefit(p, s, line, port);
      if (args.expectPrice !== undefined && args.expectPrice !== cost) fail(`The price is now ${gold(cost)} gold. Look again.`);
      pay(p, cost, 'That refit');
      const before = statsOf(s.hull, s.refits);
      s.refits[line]++;
      const after = statsOf(s.hull, s.refits);
      if (line === 'hull') s.hullHp = Math.min(after.hullMax, s.hullHp + (after.hullMax - before.hullMax));
      say(p, `The yard refits ${s.name}'s ${REFIT_LINES[line].label.toLowerCase()} to tier ${s.refits[line]} for ${gold(cost)} gold.`);
      return s.id;
    },
    reclass(p, st, args, port) {
      const s = shipHere(p, st, args.shipId, port);
      const h = hullOf(args.hull);
      if (!h || h.id === s.hull) fail('Which hull?');
      if (s.legacy) fail('A classic deed keeps its own hull. Buy a new ship instead.');
      if (h.price <= hullOf(s.hull).price) fail('The yard rebuilds only into a larger hull. Sell her and buy a smaller one instead.');
      if (h.classic) fail(`The ${h.label.toLowerCase()} is sold only as a new deed.`);
      const tradeIn = salePrice(s);
      const cost = Math.max(0, h.price - tradeIn);
      if (args.expectPrice !== undefined && args.expectPrice !== cost) fail(`The price is now ${gold(cost)} gold. Look again.`);
      const stats = statsOf(h.id);
      if (s.crew.length > stats.crewMax) fail(`The ${h.label.toLowerCase()} berths only ${stats.crewMax} hands. Dismiss some first.`);
      if (cargoUsed(s) > stats.capacity) fail('Her cargo will not fit in the new hull.');
      pay(p, cost, `Rebuilding her as a ${h.label.toLowerCase()}`);
      s.hull = h.id;
      s.paid = h.price;
      for (const l of REFIT_IDS) s.refits[l] = 0;
      s.hullHp = stats.hullMax;
      s.sailHp = stats.sailMax;
      for (const k of STORE_IDS) s.stores[k] = Math.min(s.stores[k], stats.stores[k]);
      say(p, `The yard rebuilds ${s.name} as a ${h.label.toLowerCase()}: ${gold(h.price)} gold less ${gold(tradeIn)} for her old hull, ${gold(cost)} paid.`);
      return s.id;
    },
    repair(p, st, args, port) {
      const s = shipHere(p, st, args.shipId, port);
      const part = args.part ?? 'all';
      if (!['hull', 'sail', 'all'].includes(part)) fail('Repair what?');
      const q = quoteRepair(p, s, port);
      const cost = (part !== 'sail' ? q.hull.gold : 0) + (part !== 'hull' ? q.sail.gold : 0);
      if (!cost) fail(`${s.name} needs no repairs.`);
      if (args.expectPrice !== undefined && args.expectPrice !== cost) fail(`The price is now ${gold(cost)} gold. Look again.`);
      pay(p, cost, 'The repairs');
      const stats = statsOf(s.hull, s.refits);
      if (part !== 'sail') s.hullHp = stats.hullMax;
      if (part !== 'hull') s.sailHp = stats.sailMax;
      say(p, `The shipwrights make ${s.name} sound for ${gold(cost)} gold.`);
      return s.id;
    },
    supply(p, st, args, port) {
      const s = shipHere(p, st, args.shipId, port);
      const k = args.store;
      if (!STORES[k]) fail('Which stores?');
      const qty = int(args.qty);
      if (!(qty > 0)) fail('How many?');
      const cap = statsOf(s.hull, s.refits).stores[k];
      if (!cap) fail(`${s.name} has no use for ${STORES[k].label.toLowerCase()}.`);
      if (s.stores[k] + qty > cap) fail(`${s.name} can stow only ${cap - s.stores[k]} more.`);
      const cost = qty * STORES[k].price;
      pay(p, cost, `${qty} ${STORES[k].label.toLowerCase()}`);
      s.stores[k] += qty;
      say(p, `${qty} ${STORES[k].label.toLowerCase()} stowed aboard ${s.name} for ${gold(cost)} gold.`);
      return s.id;
    },
    hire(p, st, args, port) {
      const s = shipHere(p, st, args.shipId, port);
      const day = freshDay(st);
      const r = recruitsAt(port.id, day, st.taken.recruits).find((x) => x.id === args.recruitId);
      if (!r) fail('That sailor has already signed on elsewhere.');
      const stats = statsOf(s.hull, s.refits);
      if (s.crew.length >= stats.crewMax) fail(`${s.name} berths only ${stats.crewMax} hands.`);
      pay(p, r.fee, `Signing ${r.name}`);
      st.taken.recruits.push(r.id);
      s.crew.push({ id: r.id, name: r.name, role: r.role, wage: r.wage, morale: MORALE_START });
      say(p, `${r.name} signs on to ${s.name} as ${r.role.toLowerCase()} for ${gold(r.fee)} gold and ${r.wage} a day.`);
      return s.id;
    },
    dismiss(p, st, args, port) {
      const s = shipHere(p, st, args.shipId, port);
      const h = s.crew.find((x) => x.id === args.handId);
      if (!h) fail('No such hand aboard.');
      s.crew = s.crew.filter((x) => x !== h);
      say(p, `${h.name} is paid off and goes ashore.`);
      return s.id;
    },
    assign(p, st, args, port) {
      const s = shipHere(p, st, args.shipId, port);
      const h = s.crew.find((x) => x.id === args.handId);
      if (!h) fail('No such hand aboard.');
      if (args.role != null) {
        if (!ROLES.includes(args.role)) fail('No such post.');
        h.role = args.role;
      }
      if (args.toShipId != null && args.toShipId !== s.id) {
        const t = shipHere(p, st, args.toShipId, port);
        if (t.crew.length >= statsOf(t.hull, t.refits).crewMax) fail(`${t.name} has no berth free.`);
        s.crew = s.crew.filter((x) => x !== h);
        t.crew.push(h);
        say(p, `${h.name} goes across to ${t.name}${args.role ? ` as ${h.role.toLowerCase()}` : ''}.`);
        return t.id;
      }
      if (args.role == null) fail('Assign to what?');
      say(p, `${h.name} is ${s.name}'s ${h.role.toLowerCase()} now.`);
      return s.id;
    },
    trade(p, st, args, port) {
      const s = shipHere(p, st, args.shipId, port);
      const g = GOODS[args.good];
      if (!g) fail('Which goods?');
      const qty = int(args.qty);
      if (!(qty > 0) || qty > 999) fail('How many?');
      const day = freshDay(st);
      const m = (st.market[port.id] = st.market[port.id]?.day === day ? st.market[port.id] : { day, bought: {}, sold: {} });
      for (const k of Object.keys(st.market)) if (k !== port.id && st.market[k].day !== day) delete st.market[k];
      const row = marketAt(port.id, day, { edge: edgeOf(p), dealt: m }).find((r) => r.id === g.id);
      if (args.side === 'buy') {
        if (args.expectPrice !== undefined && args.expectPrice !== row.buy) fail(`${g.label} now sells at ${row.buy} gold. Look again.`);
        if (qty > row.stock) fail(row.stock ? `The market has only ${row.stock} ${g.label.toLowerCase()} left today.` : `The market has no more ${g.label.toLowerCase()} today.`);
        const free = capacityOf(s) - cargoUsed(s);
        if (qty > free) fail(`${s.name} has room for ${free} more.`);
        pay(p, qty * row.buy, `${qty} ${g.label.toLowerCase()}`);
        const lot = s.cargo.find((c) => c.good === g.id);
        if (lot) {
          lot.paid = ((lot.paid ?? row.buy) * lot.qty + row.buy * qty) / (lot.qty + qty);
          lot.qty += qty;
        } else s.cargo.push({ good: g.id, qty, paid: row.buy });
        m.bought[g.id] = (m.bought[g.id] | 0) + qty;
        say(p, `You load ${qty} ${g.label.toLowerCase()} aboard ${s.name} at ${row.buy} gold each.`);
      } else if (args.side === 'sell') {
        if (args.expectPrice !== undefined && args.expectPrice !== row.sell) fail(`${g.label} now fetches ${row.sell} gold. Look again.`);
        const lot = s.cargo.find((c) => c.good === g.id);
        if (!lot || lot.qty < qty) fail(`${s.name} carries only ${lot?.qty ?? 0} ${g.label.toLowerCase()}.`);
        if (qty > row.demand) fail(row.demand ? `The market will take only ${row.demand} more today.` : `Nobody here wants more ${g.label.toLowerCase()} today.`);
        lot.qty -= qty;
        if (!lot.qty) s.cargo = s.cargo.filter((c) => c !== lot);
        m.sold[g.id] = (m.sold[g.id] | 0) + qty;
        earn(p, qty * row.sell);
        say(p, `You sell ${qty} ${g.label.toLowerCase()} for ${gold(qty * row.sell)} gold.`);
      } else fail('Buy or sell?');
      return s.id;
    },
    'contract.take'(p, st, args, port) {
      const s = shipHere(p, st, args.shipId, port);
      const day = freshDay(st);
      const o = boardAt(port, day, seaPorts(st), { route, taken: st.taken.offers }).find((x) => x.id === args.offerId);
      if (!o || st.done.includes(o.id)) fail('That notice has been taken down.');
      if (st.contracts.length >= CONTRACTS_MAX) fail(`The harbour board trusts one captain with ${CONTRACTS_MAX} consignments at a time.`);
      const free = capacityOf(s) - cargoUsed(s);
      if (o.units > free) fail(`${s.name} has room for ${free}; the consignment is ${o.units}.`);
      const now = playerMinutes(p);
      const c = { id: o.id, shipId: s.id, from: o.from, fromName: o.fromName, to: o.to, toName: o.toName, units: o.units, kind: o.kind, pay: o.pay, due: now + o.days * DAY, takenAt: now };
      st.contracts.push(c);
      st.taken.offers.push(o.id);
      s.cargo.push({ good: CONTRACT_GOOD, qty: o.units, contractId: c.id });
      say(p, `${s.name} loads ${o.kind} for ${o.toName}: ${gold(o.pay)} gold on delivery within ${o.days} days.`);
      return s.id;
    },
    'contract.abandon'(p, st, args) {
      const c = st.contracts.find((x) => x.id === args.contractId);
      if (!c) fail('No such consignment.');
      const s = st.ships.find((x) => x.id === c.shipId);
      if (s) s.cargo = s.cargo.filter((x) => x.contractId !== c.id);
      st.contracts = st.contracts.filter((x) => x !== c);
      st.done.push(c.id); // never paid later
      say(p, `You give up the consignment for ${c.toName}. The harbour board will remember.`);
      return c.shipId;
    },
  };
  const ANYWHERE = new Set(['status', 'rename', 'activate', 'contract.abandon']);

  for (const [verb, fn] of Object.entries(handlers)) {
    ctx.onAction(`shipyard.${verb}`, (p, args = {}) => {
      const st = stateOf(p);
      if (verb !== 'status') claimRequest(st, args); // first: a replay is refused as such; any later refusal rolls it back
      const custody = verb !== 'status' ? services.law?.custody?.(p) : null;
      if (custody) fail(custody);
      const port = ANYWHERE.has(verb) ? null : needPort(p);
      const shipId = fn(p, st, args, port);
      if (verb !== 'status') {
        const s = st.ships.find((x) => x.id === shipId);
        if (s && ['repair', 'refit', 'reclass', 'rename'].includes(verb)) {
          pushHull(p, s);
          const v = services.sailing?.byId?.(`v${p.id}`);
          if (v && v.shipId === s.id && v.name !== s.name) { services.sailing.touch?.(v); v.name = s.name; services.sailing.save?.(v); }
        }
        changed(p, shipId ?? null, verb);
      }
      sendStatus(p);
    });
  }

  // ------------------------------------------------------------------ lifecycle

  ctx.onJoin((p) => {
    stateOf(p);
    relink(p);
    // Docked by a party helmsman while the captain was away: settle that voyage now (idempotent).
    const v = services.sailing?.byId?.(`v${p.id}`) ?? null;
    const s = v?.shipId ? stateOf(p).ships.find((x) => x.id === v.shipId) : null;
    if (s && v.docked && s.at === 'sea') safe(() => api.arrived(p, s.id, v.docked));
  });
  let relinkAt = 0;
  ctx.onTick?.(() => {
    const t = ctx.now?.() ?? 0;
    if (t - relinkAt < 1000) return;
    relinkAt = t;
    for (const p of ctx.players.values()) relink(p);
  });
  ctx.on?.('vesselDeparted', (ev) => ev?.player && ev.shipId && safe(() => api.departed(ev.player, ev.shipId)));
  // Sailing core (server/rpg/sailing.js): a vessel made fast at a port. Its owner's matching ship settles the voyage.
  ctx.on?.('sailingDocked', (ev) => {
    const v = ev?.vessel;
    const owner = v ? [...ctx.players.values()].find((q) => q.id === v.ownerId) : null;
    if (!owner || typeof ev.port !== 'string') return;
    const st = stateOf(owner);
    const s = st.ships.find((x) => x.id === v.shipId) ?? st.ships.find((x) => x.legacy && x.legacy === v.type);
    if (s) safe(() => api.arrived(owner, s.id, ev.port));
  });
  ctx.on?.('sailingLaunched', (ev) => {
    const v = ev?.vessel;
    const owner = v ? [...ctx.players.values()].find((q) => q.id === v.ownerId) : null;
    if (!owner) return;
    const s = stateOf(owner).ships.find((x) => x.id === v.shipId) ?? stateOf(owner).ships.find((x) => x.legacy && x.legacy === v.type);
    if (s && s.at !== 'sea') safe(() => api.departed(owner, s.id, { force: true }));
  });
  ctx.on?.('vesselArrived', (ev) => ev?.player && ev.shipId && ev.port && safe(() => api.arrived(ev.player, ev.shipId, ev.port)));
  function safe(fn) {
    try {
      return fn();
    } catch (err) {
      log.error?.('[shipyard]', err?.message ?? err);
      return null;
    }
  }

  // ------------------------------------------------------------------ sailing-core vessel bridge
  //
  // The sailing core keeps one live vessel per captain (`v<playerId>`, server/rpg/sailing.js). It sails the captain's
  // FLAGSHIP (rpg.shipyard.active): bindVessel stamps v.shipId / v.hullClass / v.name and the hull maxima from the
  // flagship's record, and links v.stores, v.crew and v.sailHp to that record as non-enumerable accessors, so naval
  // combat (server/rpg/naval.js) spends the record's own shot, loses its own hands and tears its own canvas, and the
  // vessel's saved row never duplicates them. The vessel's hull {hp, max} is the live truth while she is out; the record
  // follows it (pullHull) and the yard pushes repairs and refits back (pushHull).

  const LINKED = Symbol('shipyardLinked');
  /** Deck type the core sails for this captain's flagship: a classic deed's own type; every yard hull the small deck. */
  function deckType(p) {
    const st = stateOf(p);
    const s = st.ships.find((x) => x.id === st.active) ?? null;
    if (!s) return null;
    return s.legacy ?? hullOf(s.hull)?.classic ?? 'small';
  }
  function link(p, v) {
    if (!v || v[LINKED] === p.id) return;
    const rec = () => {
      const st = stateOf(p);
      return st.ships.find((x) => x.id === v.shipId) ?? null;
    };
    const acc = (key) => ({
      configurable: true, enumerable: false,
      get: () => rec()?.[key],
      set: (val) => {
        const r = rec();
        if (!r) return;
        if (key === 'sailHp') r.sailHp = clamp(Math.round(Number(val) || 0), 0, statsOf(r.hull, r.refits).sailMax);
        else if (key === 'crew' && Array.isArray(val)) r.crew = val;
        else if (key === 'stores' && isObj(val)) Object.assign(r.stores, val);
      },
    });
    for (const k of ['stores', 'crew', 'sailHp']) Object.defineProperty(v, k, acc(k));
    Object.defineProperty(v, LINKED, { value: p.id, configurable: true, enumerable: false });
  }
  function pullHull(p, s) {
    const v = services.sailing?.byId?.(`v${p.id}`) ?? null;
    if (!v || v.shipId !== s.id || !Number.isFinite(v.hull?.hp)) return;
    const max = statsOf(s.hull, s.refits).hullMax;
    s.hullHp = clamp(Math.round(v.hull.hp), 0, max);
  }
  function pushHull(p, s) {
    const v = services.sailing?.byId?.(`v${p.id}`) ?? null;
    if (!v || v.shipId !== s.id) return;
    const max = statsOf(s.hull, s.refits).hullMax;
    if (!isObj(v.hull) || v.hull.hp !== s.hullHp || v.hull.max !== max) {
      services.sailing.touch?.(v);
      v.hull = { hp: s.hullHp, max };
      if (v.sunk && s.hullHp > 0) v.sunk = false;
      try { services.sailing.save?.(v); services.sailing.publish?.(v); } catch (err) { log.error?.('[shipyard] vessel save failed', err); }
    }
  }
  /**
   * Sailing core hook (boardOwn): make the captain's one vessel sail the flagship. A ship left at a quay keeps that
   * berth in its record; the flagship's berth becomes the vessel's. Answers the vessel.
   */
  function bindVessel(p, v) {
    const st = stateOf(p);
    const s = st.ships.find((x) => x.id === st.active) ?? null;
    if (!s) return v;
    link(p, v);
    if (v.shipId === s.id) return v;
    if (v.shipId && !v.docked && !v.sunk) fail('Your flagship is at sea. Bring her into port first.');
    const prev = st.ships.find((x) => x.id === v.shipId) ?? (v.shipId == null ? st.ships.find((x) => x.legacy && x.legacy === v.type) : null);
    ctx.dirty?.(p);
    if (prev && prev !== s) {
      if (Number.isFinite(v.hull?.hp)) prev.hullHp = clamp(Math.round(v.hull.hp), 0, statsOf(prev.hull, prev.refits).hullMax);
      prev.port = v.docked ?? prev.port;
      prev.at = 'port';
    }
    if (s.legacy && s.port == null) s.port = v.docked ?? null;
    const stats = statsOf(s.hull, s.refits);
    const berth = s.port ? services.sailing?.ports?.()?.find((q) => q.id === s.port) ?? null : null;
    v.shipId = s.id;
    v.hullClass = s.hull;
    v.type = deckType(p);
    v.name = s.name;
    v.hull = { hp: s.hullHp, max: stats.hullMax };
    v.sunk = s.hullHp <= 0;
    if (s.port) {
      v.docked = s.port;
      v.anchored = true;
      v.speed = 0;
      if (berth) Object.assign(v, { x: berth.x, z: berth.z, ...(Number.isFinite(berth.yaw) ? { yaw: berth.yaw } : {}) });
    }
    changed(p, s.id, 'bind');
    return v;
  }
  /** Naval combat: a vessel's maxima from its ship record (+ handCount). */
  function vesselStats(v) {
    const p = ownerOfVessel(v);
    if (!p) return null;
    const st = stateOf(p);
    const s = st.ships.find((x) => x.id === v.shipId) ?? (v.shipId == null ? st.ships.find((x) => x.legacy && x.legacy === v.type) : null);
    return s ? { ...statsOf(s.hull, s.refits), handCount: s.crew.length } : null;
  }
  const ownerOfVessel = (v) => (v ? [...ctx.players.values()].find((q) => q.id === v.ownerId) ?? null : null);
  /** Links an online captain's vessel after a restart or reconnect (accessors are never saved with the vessel row). */
  function relink(p) {
    const v = services.sailing?.byId?.(`v${p.id}`) ?? null;
    if (v && v.shipId && v[LINKED] !== p.id) link(p, v);
  }

  // ------------------------------------------------------------------ services

  const live = (p, id) => stateOf(p).ships.find((s) => s.id === id) ?? null;
  /** A ship about to change: its owner joins the running transaction first, so a rollback restores them too. */
  const mut = (p, id) => {
    const s = live(p, id);
    if (s) ctx.dirty?.(p);
    return s;
  };
  const ownerOf = (v) => (v ? [...ctx.players.values()].find((q) => q.id === v.ownerId) ?? null : null);
  const api = {
    fleet: (p) => stateOf(p).ships.map((s) => structuredClone(s)),
    ship: live,
    active: (p) => stateOf(p).active,
    stats(p, id) {
      const s = live(p, id);
      return s ? { ...statsOf(s.hull, s.refits), roles: roleCounts(s), hands: s.crew.length } : null;
    },
    canSail(p, id) {
      const s = live(p, id);
      return s ? sailRefusal(p, s) : 'No such ship of yours.';
    },
    dockedAt: (p, id) => {
      const s = live(p, id);
      return s ? dockedAt(p, s) : null;
    },
    /** Sailing core: the vessel left port. Starts the voyage clock for wages and rations. */
    departed(p, id, { force = false } = {}) {
      return atomic(p, 'shipyard.departed', () => {
        const s = live(p, id);
        if (!s || s.at === 'sea') return false;
        const refusal = force ? null : sailRefusal(p, s);
        if (refusal) fail(refusal);
        s.at = 'sea';
        s.departedAt = playerMinutes(p);
        changed(p, s.id, 'departed');
        return true;
      });
    },
    /** Sailing core: the vessel made fast at a real port town. Settles the voyage; pays each delivery once. */
    arrived(p, id, portId) {
      return atomic(p, 'shipyard.arrived', () => {
        const st = stateOf(p);
        const s = st.ships.find((x) => x.id === id);
        if (!s || typeof portId !== 'string') return null;
        const town = exteriorTownOf(portId) ?? portId;
        const tp = typeof services.townProperty === 'function' ? services.townProperty(town) : null;
        if (tp && tp.status === 'ready' && tp.port !== true) fail('That town has no harbour.');
        const vessel = vesselOf(p, s);
        if (s.at === 'port' && s.port === town && !(vessel && s.departedAt == null && vessel.launchedAt > (s.arrivedAt ?? -Infinity))) return [];
        knownPorts.set(town, portInfo(town));
        const lines = settleArrival(p, st, s, town, vessel);
        s.arrivedAt = worldMinutes();
        if (lines.length) say(p, `${s.name} makes fast at ${portInfo(town).name}. ${lines.join(' ')}`);
        changed(p, s.id, 'arrived');
        return lines;
      });
    },
    /** Naval combat: spend stores; answers what was actually spent. */
    spend(p, id, want = {}) {
      const s = mut(p, id);
      const out = { shot: 0, provisions: 0, timber: 0 };
      if (!s) return out;
      for (const k of STORE_IDS) {
        const n = clamp(int(want[k]), 0, s.stores[k]);
        s.stores[k] -= n;
        out[k] = n;
      }
      if (out.shot || out.provisions || out.timber) changed(p, s.id, 'spend');
      return out;
    },
    damage(p, id, { hull = 0, sail = 0 } = {}) {
      const s = mut(p, id);
      if (!s) return null;
      s.hullHp = Math.max(0, Math.round(s.hullHp - Math.max(0, hull)));
      s.sailHp = Math.max(0, Math.round(s.sailHp - Math.max(0, sail)));
      changed(p, s.id, 'damage');
      return { hullHp: s.hullHp, sailHp: s.sailHp, sunk: s.hullHp <= 0 };
    },
    /** One timber from the stores mends TIMBER_MENDS hull (the carpenter at sea). */
    seaRepair(p, id) {
      const s = mut(p, id);
      if (!s || s.stores.timber < 1) return 0;
      const max = statsOf(s.hull, s.refits).hullMax;
      if (s.hullHp >= max) return 0;
      s.stores.timber--;
      const mended = Math.min(TIMBER_MENDS, max - s.hullHp);
      s.hullHp += mended;
      changed(p, s.id, 'seaRepair');
      return mended;
    },
    loseCrew(p, id, n = 1) {
      const s = mut(p, id);
      if (!s) return [];
      const order = [...s.crew].sort((a, b) => (a.role === 'Deckhand' ? 0 : 1) - (b.role === 'Deckhand' ? 0 : 1) || s.crew.indexOf(b) - s.crew.indexOf(a));
      const lost = order.slice(0, clamp(int(n), 0, s.crew.length));
      s.crew = s.crew.filter((h) => !lost.includes(h));
      if (lost.length) changed(p, s.id, 'loseCrew');
      return lost.map((h) => h.name);
    },
    gainCrew(p, id, hands = []) {
      const s = mut(p, id);
      if (!s) return 0;
      const max = statsOf(s.hull, s.refits).crewMax;
      let n = 0;
      for (const h of hands) {
        if (s.crew.length >= max) break;
        const role = ROLES.includes(h?.role) ? h.role : 'Deckhand';
        s.crew.push({ id: `pr-${(++stateOf(p).seq).toString(36)}`, name: str(h?.name, 48) ?? 'A pressed hand', role, wage: WAGE[role], morale: 40 });
        n++;
      }
      if (n) changed(p, s.id, 'gainCrew');
      return n;
    },
    addCargo(p, id, goods = []) {
      const s = mut(p, id);
      const left = [];
      let loaded = 0;
      for (const g of goods) {
        if (!s || !GOODS[g?.good]) continue;
        const room = capacityOf(s) - cargoUsed(s);
        const n = clamp(int(g.qty), 0, room);
        if (n) {
          const lot = s.cargo.find((c) => c.good === g.good);
          if (lot) lot.qty += n;
          else s.cargo.push({ good: g.good, qty: n });
          loaded += n;
        }
        if (int(g.qty) > n) left.push({ good: g.good, qty: int(g.qty) - n });
      }
      if (loaded) changed(p, s.id, 'addCargo');
      return { loaded, left };
    },
    /** Plundered: a share of each trade good (consignments are sealed and stay). */
    takeCargo(p, id, share = 0.5) {
      const s = mut(p, id);
      if (!s) return [];
      const out = [];
      for (const c of s.cargo) {
        if (c.good === CONTRACT_GOOD) continue;
        const n = Math.floor(c.qty * clamp(Number(share) || 0, 0, 1));
        if (n) {
          c.qty -= n;
          out.push({ good: c.good, qty: n });
        }
      }
      s.cargo = s.cargo.filter((c) => c.qty > 0);
      if (out.length) changed(p, s.id, 'takeCargo');
      return out;
    },
    /** The shipyard record behind a sailing-core vessel: {player, shipId} (its owner must be online), or null. */
    shipOfVessel(v) {
      const p = ownerOf(v);
      if (!p) return null;
      const st = stateOf(p);
      const s = st.ships.find((x) => x.id === v.shipId) ?? st.ships.find((x) => x.legacy && x.legacy === v.type);
      return s ? { player: p, shipId: s.id } : null;
    },
    /**
     * Prize law: move trade goods from one captain's hold to another's, atomically inside the caller's action.
     * At most `maxPieces` units and about `share` of the loser's goods by value; never more than the winner's free
     * room; sealed consignments never move. Answers [{good, qty, label}] moved.
     */
    transferCargo(fromP, fromId, toP, toId, { maxPieces = 8, share = 1 / 3 } = {}) {
      const a = mut(fromP, fromId);
      const b = mut(toP, toId);
      if (!a || !b || a === b) return [];
      let room = capacityOf(b) - cargoUsed(b);
      let pieces = clamp(int(maxPieces), 0, 999);
      let worth = a.cargo.filter((c) => GOODS[c.good]).reduce((n, c) => n + GOODS[c.good].base * c.qty, 0) * clamp(Number(share) || 0, 0, 1);
      const moved = [];
      for (const c of [...a.cargo].filter((x) => GOODS[x.good]).sort((x, y) => GOODS[y.good].base - GOODS[x.good].base)) {
        const n = Math.min(c.qty, room, pieces, Math.floor(worth / GOODS[c.good].base));
        if (n <= 0) continue;
        c.qty -= n;
        room -= n;
        pieces -= n;
        worth -= n * GOODS[c.good].base;
        const lot = b.cargo.find((x) => x.good === c.good);
        if (lot) lot.qty += n;
        else b.cargo.push({ good: c.good, qty: n });
        moved.push({ good: c.good, qty: n, label: GOODS[c.good].label });
      }
      a.cargo = a.cargo.filter((c) => c.qty > 0);
      if (moved.length) {
        changed(fromP, a.id, 'plundered');
        changed(toP, b.id, 'plunder');
      }
      return moved;
    },
    /** Offline prize escrow reconciliation: debit specific trade goods from a hold (idempotent, never negative). */
    debitCargo(p, id, goods = []) {
      const s = mut(p, id);
      if (!s) return [];
      const debited = [];
      for (const g of goods) {
        if (!GOODS[g?.good]) continue;
        const want = Math.max(0, int(g.qty));
        if (!want) continue;
        const lot = s.cargo.find((c) => c.good === g.good);
        if (!lot) continue;
        const n = Math.min(lot.qty, want);
        if (n > 0) {
          lot.qty -= n;
          debited.push({ good: g.good, qty: n, label: GOODS[g.good].label });
        }
      }
      s.cargo = s.cargo.filter((c) => c.qty > 0);
      if (debited.length) changed(p, s.id, 'plundered');
      return debited;
    },
    status,
    deckType,
    bindVessel,
    statsOf: vesselStats,
  };
  services.shipyard = api;
  return { stateOf, status, api };
}
