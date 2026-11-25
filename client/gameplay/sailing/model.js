// Sailing UI model: pure readers over the server's snapshots. No DOM, no invented state.
//
// Sources (server-authoritative full snapshots; the browser never merges in its own guesses):
//   gameEvent {kind:'sailing.state', role, helm, vessel, wind, nearby, ports, dockRange?}   aboard (server/rpg/sailing.js)
//   gameEvent {kind:'sailing.state', vessel:null, own, ownsShip, port, ports, quay?}        ashore
//   gameEvent {kind:'naval.state', t, self, contacts, projectiles}                         naval combat v1
// A field the server did not send reads as null, and the UI hides the control that needs it.

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(v) ? v : null);
const pair = (v) => (Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1]) && v[1] > 0 ? [Math.max(0, v[0]), v[1]] : null);
const list = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * Bow azimuth of each classic deck in its own town frame, mirrored from server/rpg/sailing/voyage.js DECK_BOW (measured
 * from the installed SHIPAA blocks). A `vessel.deckBow` sent by the server wins.
 */
export const DECK_BOW = Object.freeze({ small: Math.PI / 2, large: Math.PI });
/** The deck-frame look yaw as a sea compass bearing: the deck turns with the ship. */
export const seaLook = (lookYaw, v) => (Number.isFinite(lookYaw) && v && Number.isFinite(v.heading) && Number.isFinite(v.deckBow) ? lookYaw - v.deckBow + v.heading : null);

/** Canvas settings the server accepts for `sailing.control {sails}`, struck to full. */
export const SAIL_STEPS = Object.freeze([0, 0.5, 1]);
export const SAIL_LABELS = Object.freeze({ 0: 'Sails struck', 0.5: 'Half sail', 1: 'Full sail' });
/** Oar settings for `sailing.control {oars}`. */
export const OAR_STEPS = Object.freeze([-1, 0, 1]);
export const OAR_LABELS = Object.freeze({ '-1': 'Backing oars', 0: 'Oars shipped', 1: 'Pulling oars' });
export const ROLE_LABELS = Object.freeze({ none: 'Ashore', passenger: 'Aboard', helm: 'At the helm', captain: 'Captain' });
const MS_TO_KNOTS = 1.943844;
const CARDINALS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function readPorts(v) {
  return list(v).filter((p) => str(p.id)).map((p) => ({ id: p.id, name: str(p.name) ?? p.id, region: str(p.region), x: num(p.x), z: num(p.z), distance: num(p.distance), charted: p.charted === true ? true : p.charted === false ? false : null }));
}

/**
 * Normalise a sailing.state event. `location` is the player's current location id, used only to tell the deck from
 * the cabin below it (the vessel names its deck location). Returns null for anything that is not one.
 */
export function readSailing(ev, { location = null, selfId = null } = {}) {
  if (!isObj(ev) || ev.kind !== 'sailing.state') return null;
  const v = isObj(ev.vessel) && ev.vessel.id != null ? ev.vessel : null;
  const vessel = v ? {
    id: String(v.id), name: str(v.name) ?? 'Ship', type: str(v.type), ownerId: v.ownerId == null ? null : String(v.ownerId), ownerName: str(v.ownerName),
    x: num(v.x), z: num(v.z), heading: num(v.yaw), speed: num(v.speed),
    sails: SAIL_STEPS.includes(v.sails) ? v.sails : null,
    oars: OAR_STEPS.includes(v.oars) ? v.oars : null,
    rudder: num(v.rudder),
    anchored: typeof v.anchored === 'boolean' ? v.anchored : null,
    grounded: v.grounded === true, sunk: v.sunk === true,
    docked: str(v.docked),
    helmId: v.helmId == null ? null : String(v.helmId), helmName: str(v.helmName),
    hull: isObj(v.hull) ? pair([v.hull.hp, v.hull.max]) : null,
    crew: list(v.crew).map((c) => ({ id: String(c.id), name: str(c.name) ?? 'Sailor' })),
    deck: str(v.deck),
    pointOfSail: num(v.pointOfSail),
    deckBow: num(v.deckBow) ?? DECK_BOW[v.type] ?? null,
    course: isObj(v.course) && str(v.course.to) ? { to: v.course.to, name: str(v.course.name) ?? v.course.to, routed: v.course.routed !== false, points: list(v.course.points).filter((q) => Number.isFinite(q.x) && Number.isFinite(q.z)).map((q) => ({ x: q.x, z: q.z })) } : null,
  } : null;
  const role = vessel ? (['captain', 'helm', 'passenger'].includes(ev.role) ? ev.role : 'passenger') : 'none';
  const ports = readPorts(ev.ports);
  const own = isObj(ev.own) && ev.own.id != null ? { id: String(ev.own.id), name: str(ev.own.name) ?? 'Your ship', docked: str(ev.own.docked), sunk: ev.own.sunk === true } : null;
  const port = isObj(ev.port) && str(ev.port.id) ? { id: ev.port.id, name: str(ev.port.name) ?? ev.port.id, region: str(ev.port.region) } : null;
  return {
    at: num(ev.at), full: ev.full === true,
    role,
    helm: ev.helm === true || (!!vessel && selfId != null && vessel.helmId === String(selfId)),
    spot: vessel ? (vessel.deck && location ? (location === vessel.deck ? 'deck' : 'below') : 'deck') : null,
    vessel,
    wind: isObj(ev.wind) && Number.isFinite(ev.wind.from) ? { from: ev.wind.from, speed: num(ev.wind.speed) } : null,
    nearby: list(ev.nearby).filter((n) => n.id != null).map((n) => ({
      id: String(n.id), kind: str(n.kind), name: str(n.name) ?? str(n.title) ?? 'Ship', ownerName: str(n.ownerName), distance: num(n.distance),
      x: num(n.x), z: num(n.z), heading: num(n.yaw), speed: num(n.speed), docked: str(n.docked),
      hull: pair([n.hullHp, n.maxHull]), sails: pair([n.sailHp, n.maxSail]), crew: pair([n.crew, n.maxCrew]),
      hostile: n.colours === 'hostile' || n.faction === 'pirate', state: str(n.state),
    })),
    ports,
    dockRange: num(ev.dockRange),
    // ashore only
    port, own, ownsShip: ev.ownsShip === true,
    quay: list(ev.quay).filter((q) => q.id != null).map((q) => ({ id: String(q.id), name: str(q.name) ?? 'Ship', ownerName: str(q.ownerName) })),
    coast: str(ev.coast),
  };
}

export const SIDES = Object.freeze(['port', 'starboard', 'bow', 'stern']);
export const SIDE_LABELS = Object.freeze({ port: 'Port', starboard: 'Starboard', bow: 'Bow', stern: 'Stern' });
export const SHOT_LABELS = Object.freeze({ round: 'Round shot', grape: 'Grape', chain: 'Chain', heated: 'Heated shot' });
/** The four munitions a non-barrel gun can load from the shared shot pool (naval SHOT_ORDER); barrel guns take barrels. */
export const SHOTS = Object.freeze(['round', 'grape', 'chain', 'heated']);
export const GUN_LABELS = Object.freeze({ long: 'Long guns', swivel: 'Swivels', heavy: 'Heavy guns', chain: 'Chain guns', barrel: 'Barrel drop' });
/** Which load group feeds a firing side (naval contract v1). */
export const groupOf = (side) => (side === 'bow' || side === 'stern' ? side : 'broadside');

/** A public ship view from naval (contacts[] and self): hull/sails/crew pairs and combat state. */
function readView(v) {
  if (!isObj(v) || v.id == null) return null;
  return {
    id: String(v.id), kind: str(v.kind), name: str(v.title) ?? str(v.name) ?? 'Ship', faction: str(v.faction), ownerId: v.ownerId == null ? null : String(v.ownerId),
    x: num(v.x), z: num(v.z), heading: num(v.yaw), speed: num(v.speed),
    hull: pair([v.hullHp, v.maxHull]), sails: pair([v.sailHp, v.maxSail]), crew: pair([v.crew, v.maxCrew]),
    state: str(v.state) ?? 'afloat', fire: num(v.fire) ?? 0, colours: str(v.colours), grappledTo: v.grappledTo == null ? null : String(v.grappledTo),
    type: str(v.type) ?? str(v.hull), plundered: !!v.plundered, flagship: v.flagship === true,
  };
}

/**
 * Normalise a naval.state event (server/rpg/naval.js contract v1): {t, self, contacts, projectiles}. `ready` is
 * seconds until each side can fire at the event's time (0 = loaded); `receivedAt` (ms, local) lets the readout count down.
 */
export function readNaval(ev, receivedAt = 0) {
  if (!isObj(ev) || ev.kind !== 'naval.state') return null;
  const self = isObj(ev.self) ? ev.self : {};
  const ready = {};
  if (isObj(self.ready)) for (const side of SIDES) if (Number.isFinite(self.ready[side])) ready[side] = Math.max(0, self.ready[side]);
  const loads = {};
  if (isObj(self.loads)) for (const g of ['broadside', 'bow', 'stern']) if (str(self.loads[g])) loads[g] = self.loads[g];
  const ammo = isObj(self.ammo) ? { shot: num(self.ammo.shot), barrels: num(self.ammo.barrels) } : { shot: null, barrels: null };
  const guns = {};
  if (isObj(self.guns)) for (const side of SIDES) {
    const g = self.guns[side];
    if (isObj(g) && str(g.gun)) guns[side] = { gun: g.gun, count: num(g.count) ?? 0, range: num(g.range) };
  }
  const b = isObj(self.boarding) && self.boarding.targetId != null ? self.boarding : null;
  return {
    t: num(ev.t), receivedAt,
    self: readView(self),
    ready, loads, ammo, guns,
    braced: self.braced === true,
    safeHarbour: self.safeHarbour === true,
    repel: isObj(self.repel) ? { byId: String(self.repel.byId), foesLeft: num(self.repel.foesLeft), foesTotal: num(self.repel.foesTotal) } : null,
    wreck: isObj(self.wreck) ? { id: String(self.wreck.id) } : null,
    boarding: b ? { id: String(b.targetId), phase: str(b.phase), foesLeft: num(b.foesLeft), foesTotal: num(b.foesTotal) } : null,
    contacts: list(ev.contacts).map(readView).filter(Boolean),
  };
}

/** Seconds until `side` is ready now, counting down from the snapshot; null when naval sent no battery for it. */
export function readyIn(n, side, nowMs) {
  const r = n?.ready?.[side];
  if (r == null) return null;
  return Math.max(0, r - Math.max(0, (nowMs - (n.receivedAt || nowMs)) / 1000));
}

const TAU = Math.PI * 2;
export const wrap = (a) => ((a % TAU) + TAU) % TAU;
/** Compass degrees (0 = north, clockwise) from a server heading in radians, same convention. */
export const degrees = (rad) => Math.round(wrap(rad) * 180 / Math.PI) % 360;
export const cardinal = (rad) => CARDINALS[Math.round(wrap(rad) / (TAU / 16)) % 16];
export const knots = (ms) => (Number.isFinite(ms) ? Math.round(ms * MS_TO_KNOTS * 10) / 10 : null);

/** Point of sail from the wind's bearing (where it blows FROM) and the vessel heading. */
export function pointOfSail(heading, windFrom) {
  if (!Number.isFinite(heading) || !Number.isFinite(windFrom)) return null;
  let rel = wrap(windFrom - heading);
  if (rel > Math.PI) rel = TAU - rel; // 0 = dead ahead (in irons), π = astern (running)
  const deg = rel * 180 / Math.PI;
  if (deg < 40) return 'In irons';
  if (deg < 70) return 'Close-hauled';
  if (deg < 110) return 'Beam reach';
  if (deg < 160) return 'Broad reach';
  return 'Running';
}

/** Which battery bears along the camera's look: 'port' | 'starboard' | 'bow' | 'stern' (null without a heading). Yaw and heading share the compass convention. */
export function facingSide(lookYaw, heading, arc = Math.PI * 0.32) {
  if (!Number.isFinite(lookYaw) || !Number.isFinite(heading)) return null;
  let rel = wrap(lookYaw - heading);
  if (Math.abs(rel - Math.PI / 2) <= arc) return 'starboard';
  if (Math.abs(rel - Math.PI * 1.5) <= arc) return 'port';
  return rel < Math.PI / 2 || rel > Math.PI * 1.5 ? 'bow' : 'stern';
}

/** Bearing (compass radians) from a vessel to a port, both in sea metres (x east, z south). */
export function bearingTo(from, to) {
  if (!Number.isFinite(from?.x) || !Number.isFinite(to?.x)) return null;
  return wrap(Math.atan2(to.x - from.x, -(to.z - from.z)));
}
export const nearestPort = (s) => (s?.ports?.length ? [...s.ports].sort((a, b) => (a.distance ?? 1e12) - (b.distance ?? 1e12))[0] : null);
export const atHelm = (s) => !!s?.vessel && s.helm;
export const aboard = (s) => !!s?.vessel;
/** The server's canCommand: the owner or the helmsman aboard her. */
export const canCommand = (s) => !!s?.vessel && !s.vessel.sunk && (s.role === 'captain' || s.helm);
export const stepOf = (current, dir, steps) => {
  const i = steps.indexOf(current);
  const j = (i < 0 ? steps.indexOf(0) : i) + dir;
  return j >= 0 && j < steps.length && j !== i ? steps[j] : null;
};
const dist = (a, b) => (a && b && Number.isFinite(a.x) && Number.isFinite(b.x) ? Math.hypot(a.x - b.x, a.z - b.z) : null);
export const GRAPPLE_M = 32; // naval: water between the hulls
export const GRAPPLE_SLACK_M = 12; // two galleon half-beams

/** Ships around us: naval's contacts (with hull/sails/crew and combat state), else core's nearby list. */
export function shipsAround(s, n) {
  if (n?.contacts?.length) {
    const me = n.self;
    return n.contacts.filter((c) => c.id !== me?.id).map((c) => ({ ...c, distance: dist(c, me), hostile: c.colours === 'hostile' || c.faction === 'pirate' }));
  }
  return s?.nearby ?? [];
}

/** The encounter target: the ship we are grappled to or boarding, else the nearest hostile, else the nearest ship. */
export function encounterTarget(s, n) {
  if (!s) return null;
  const ships = shipsAround(s, n);
  const lock = n?.boarding?.id ?? n?.self?.grappledTo ?? null;
  if (lock) { const t = ships.find((x) => x.id === lock); if (t) return t; }
  const sorted = ships.filter((x) => !x.owned && x.ownerId !== String(s.vessel?.id ?? '')).sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
  return sorted.find((x) => x.hostile && x.state !== 'wrecked') ?? (aboard(s) ? sorted[0] ?? null : null);
}

/** Naval actions against the encounter target, from naval's own state words. */
export function navalActions(s, n, { wrecks = [] } = {}) {
  const out = [];
  if (!n || !aboard(s) || s.spot !== 'deck') return out;
  const t = encounterTarget(s, n);
  const me = n.self;
  const grappled = !!t && (me?.grappledTo === t.id || t.grappledTo === me?.id);
  // 32 m of water between the hulls (naval edgeGap); centre distance is offered with a galleon's beams of slack and
  // the server's refusal says how far off she is.
  if (t && !grappled && t.state === 'struck' && !t.plundered && (t.distance == null || t.distance <= GRAPPLE_M + GRAPPLE_SLACK_M)) out.push({ id: 'grapple', label: `Grapple ${t.name}`, verb: 'naval.grapple', args: { targetId: t.id } });
  if (t && grappled && t.kind !== 'player' && !n.boarding) out.push({ id: 'boardFoe', label: `Board ${t.name}`, verb: 'naval.board', args: { targetId: t.id } });
  let prize = null;
  if (n.boarding && (n.boarding.phase === 'prize' || n.boarding.phase === 'done')) prize = n.boarding.id; // NPC taken by boarding
  else if (t && grappled && t.kind === 'player' && t.state === 'struck') prize = t.id; // a surrendered player ship alongside
  const prizeView = prize ? shipsAround(s, n).find((x) => x.id === prize) : null;
  if (prize && !prizeView?.plundered) out.push({ id: 'plunder', label: 'Plunder the prize', verb: 'naval.plunder', args: { targetId: prize } });
  for (const w of wrecks) if (w.id !== prize) out.push({ id: `plunder:${w.id}`, label: `Haul up ${w.name ?? 'the wreck'}'s cargo`, verb: 'naval.plunder', args: { targetId: w.id } });
  if (grappled || n.boarding) out.push({ id: 'retreat', label: 'Cut loose', verb: 'naval.retreat', args: {} });
  return out;
}

/**
 * Contextual actions for the current snapshot, in display order: {id, label, key?, verb?, args?, local?}. Only what the
 * snapshot makes possible is listed; the server still validates each one.
 */
export function contextActions(s, n, opts = {}) {
  const out = [];
  if (!s) return out;
  const v = s.vessel;
  if (!v) {
    if (!s.port) return out;
    const ownHere = s.ownsShip && (!s.own || s.own.docked === s.port.id) && !s.own?.sunk;
    if (ownHere) {
      out.push({ id: 'board', label: s.own ? `Board ${s.own.name}` : 'Board your ship', verb: 'sailing.board', args: {} });
      out.push({ id: 'launch', label: 'Board and cast off', verb: 'sailing.launch', args: {} });
    } else if (!s.ownsShip) out.push({ id: 'buy', label: 'Buy a ship (bank)', local: 'property' });
    for (const q of s.quay) if (q.id !== s.own?.id) out.push({ id: `board:${q.id}`, label: `Board ${q.name}${q.ownerName ? ` (${q.ownerName})` : ''}`, verb: 'sailing.board', args: { vesselId: q.id } });
    out.push({ id: 'shipyard', label: 'Shipyard', local: 'shipyard' });
    return out;
  }
  const captain = s.role === 'captain';
  if (s.helm) out.push({ id: 'helm', label: 'Leave helm', key: 'KeyK', verb: 'sailing.helm', args: { take: false } });
  else if (captain && !v.helmId && !v.sunk) out.push({ id: 'helm', label: 'Take helm', key: 'KeyK', verb: 'sailing.helm', args: { take: true } });
  if (captain && v.docked) out.push({ id: 'castoff', label: 'Cast off', verb: 'sailing.launch', args: {} });
  if (s.helm && !v.docked) {
    if (v.course) out.push({ id: 'clearCourse', label: `Clear course (${v.course.name})`, verb: 'sailing.course', args: { portId: null } });
    if (v.anchored != null) out.push({ id: 'anchor', label: v.anchored ? 'Weigh anchor' : 'Drop anchor', key: 'KeyX', verb: 'sailing.anchor', args: { down: !v.anchored } });
    const near = nearestPort(s);
    if (near && (s.dockRange == null || (near.distance ?? Infinity) <= s.dockRange)) out.push({ id: 'dock', label: `Make fast at ${near.name}`, key: 'KeyY', verb: 'sailing.dock', args: {} });
  }
  if (!s.helm) out.push(...navalActions(s, n, opts));
  out.push({ id: 'ship', label: 'Ship & Sea', key: 'KeyU', local: 'panel' });
  if (captain && v.docked) out.push({ id: 'hold', label: 'Hold', local: 'property' });
  if (v.docked && s.spot === 'deck') out.push({ id: 'ashore', label: 'Go ashore', verb: 'sailing.leave', args: {} });
  if (v.docked) out.push({ id: 'shipyard', label: 'Shipyard', local: 'shipyard' });
  return out;
}

/** Can the helm lay a course now (sailing.course: helm holder, at sea, anchor up)? */
export const canSetCourse = (s) => !!s?.vessel && s.helm && !s.vessel.docked && !s.vessel.anchored && !s.vessel.sunk;
