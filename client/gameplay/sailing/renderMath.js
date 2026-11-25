// Sailing renderer math: frames, sea waves, ship motion, ballistic shots and the normalised view of the
// authoritative sailing/naval snapshots. DOM-free and GL-free so it is unit tested in Node
// (test/sailing-render.test.mjs).
//
// FRAMES
//   Chart  - canonical sea frame: metres, x east, z south, y up, sea level y = 0. Yaw 0 = north (-z), clockwise
//            toward east; heading vector (sin yaw, -cos yaw). Ship x/z come only from the server's chart pose.
//   Deck   - the renderer's world while aboard: the classic "Your Ship" block's own coordinates, in which every
//            player walks (deck-local feet, never chart metres). The deck never moves in its own frame; the sea,
//            sky, other ships, shores and shots are drawn moved and tilted into it.
//   Ship   - hull-local: origin at the hull's waterline centre, bow toward -z, starboard +x, up +y. The deck frame
//            is the ship frame turned by `bowYaw` and moved to the hull pivot (`deckToShip`).
//   Rel    - chart axes with the own ship's chart position as origin (float64 subtraction on the CPU so the GPU
//            never sees 1e5 m coordinates).
//
// The heading convention matches the game's camera yaw (forward = (sin yaw, -cos yaw)), so a chart yaw is a
// rotation about +y by -yaw.

export const TAU = Math.PI * 2;
export const G = 9.81;
export const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const fin = (v) => Number.isFinite(v);
const num = (v, d = null) => (Number.isFinite(v) ? v : d);
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- 4x4 matrices (column-major, float64)

export function m4() { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
export function mul(a, b, out = new Float64Array(16)) {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let i = 0; i < 4; i++) {
    r[c * 4 + i] = a[i] * b[c * 4] + a[4 + i] * b[c * 4 + 1] + a[8 + i] * b[c * 4 + 2] + a[12 + i] * b[c * 4 + 3];
  }
  out.set(r);
  return out;
}
export function tr(x, y, z) { const m = m4(); m[12] = x; m[13] = y; m[14] = z; return m; }
export function sc(x, y = x, z = x) { const m = m4(); m[0] = x; m[5] = y; m[10] = z; return m; }
/** Right-handed rotation about +y (a > 0 turns +x toward -z). */
export function rotY(a) { const c = Math.cos(a), s = Math.sin(a), m = m4(); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; }
export function rotX(a) { const c = Math.cos(a), s = Math.sin(a), m = m4(); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; }
export function rotZ(a) { const c = Math.cos(a), s = Math.sin(a), m = m4(); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; }
export const chain = (...ms) => ms.reduce((acc, m) => mul(acc, m), m4());
export function apply(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}
export function applyDir(m, x, y, z) {
  return [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
}
/** Inverse of a rigid (rotation + translation, optional uniform scale) matrix. */
export function invRigid(m) {
  const s2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2] || 1;
  const r = m4();
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[j * 4 + i] = m[i * 4 + j] / s2;
  const t = applyDir(r, m[12], m[13], m[14]);
  r[12] = -t[0]; r[13] = -t[1]; r[14] = -t[2];
  return r;
}
export const f32 = (m) => Float32Array.from(m);

/** Chart yaw (0 north, clockwise) as a matrix turning ship-forward (-z) to the heading. */
export const yawMatrix = (yaw) => rotY(-yaw);
/** Heading unit vector on the chart. */
export const headingVec = (yaw) => [Math.sin(yaw), -Math.cos(yaw)];
/** Ship tilt: pitch (+ bow up) and heel (+ starboard down). */
export const tiltMatrix = (pitch, heel) => mul(rotX(pitch), rotZ(-heel));

/**
 * The own hull in its deck frame. `bounds` are the deck model's triangle bounds (model triangles only),
 * `bowYaw` the deck-frame yaw the bow points along (0 = -z). The pivot sits on the waterline (deck-frame y 0).
 */
export function hullFrame(bounds, { bowYaw = 0, waterY = 0 } = {}) {
  const b = bounds ?? { minX: -6, maxX: 6, minZ: -20, maxZ: 20 };
  // The deck origin is the vessel's chart point (server/rpg/sailing/voyage.js deckToSea): the pivot sits under it.
  const cx = 0, cz = 0;
  const alongZ = Math.abs(Math.cos(bowYaw)) > 0.5;
  const length = alongZ ? b.maxZ - b.minZ : b.maxX - b.minX;
  const beam = alongZ ? b.maxX - b.minX : b.maxZ - b.minZ;
  const pivot = [cx, waterY, cz];
  // deck = T(pivot) * yawMatrix(bowYaw) * ship  =>  ship = yawMatrix(-bowYaw) * T(-pivot) * deck
  const shipToDeck = mul(tr(...pivot), yawMatrix(bowYaw));
  return { pivot, bowYaw, length: Math.max(4, length), beam: Math.max(2, beam), shipToDeck, deckToShip: invRigid(shipToDeck) };
}

/**
 * Chart-relative (Rel) -> deck matrix for the own ship's pose: the sea and everything on it drawn into the deck.
 * pose: {yaw, pitch, heel, heave}. Rel = chart minus the own ship's chart x/z.
 */
export function relToDeck(hull, pose) {
  // ship -> rel = T(0, heave, 0) * yaw * tilt ; deck = shipToDeck * ship
  const shipToRel = chain(tr(0, pose.heave ?? 0, 0), yawMatrix(pose.yaw ?? 0), tiltMatrix(pose.pitch ?? 0, pose.heel ?? 0));
  return mul(hull.shipToDeck, invRigid(shipToRel));
}

/** Rotation only (no translation) taking chart directions into deck directions, for the sky. */
export function relToDeckRotation(hull, pose) {
  const m = relToDeck(hull, pose);
  m[12] = m[13] = m[14] = 0;
  return m;
}

/** Model matrix of another ship (its ship frame) in Rel: position offset (float64) then yaw, tilt and heave. */
export function shipToRel(dx, dz, pose) {
  return chain(tr(dx, pose.heave ?? 0, dz), yawMatrix(pose.yaw ?? 0), tiltMatrix(pose.pitch ?? 0, pose.heel ?? 0));
}

// ---------------------------------------------------------------- sea waves (shared by CPU motion and the shader)

/** Base wave train relative to the wind (direction offsets in radians, wavelength m, amplitude per unit sea state). */
export const WAVE_TRAIN = Object.freeze([
  { off: 0.0, len: 38, amp: 0.55 },
  { off: 0.55, len: 21, amp: 0.3 },
  { off: -0.7, len: 13, amp: 0.18 },
  { off: 1.25, len: 7.5, amp: 0.09 },
  { off: -1.6, len: 4.2, amp: 0.05 },
  // Ripples: lighting only (the sea shader displaces the first five).
  { off: 0.3, len: 2.7, amp: 0.03 },
  { off: -1.1, len: 1.8, amp: 0.02 },
  { off: 2.2, len: 1.2, amp: 0.012 },
]);
export const DISPLACING_WAVES = 5;

/** Sea state 0.2..1.6 from wind speed (m/s). */
export const seaState = (windSpeed) => clamp((num(windSpeed, 6)) / 9, 0.2, 1.6);

/**
 * Waves for a frame. `toward` is the yaw the wind blows toward (waves run with it). `origin` is the own ship's
 * chart x/z (float64), `time` seconds of a clock shared by all clients (wall clock). Phases are folded on the CPU
 * so the shader only sees small numbers. Returns [{kx, kz, amp, phase, omega}] in Rel.
 */
export function waveSet({ toward = 0, windSpeed = 6, origin = [0, 0], time = 0 } = {}) {
  const s = seaState(windSpeed);
  return WAVE_TRAIN.map((w) => {
    const dir = toward + w.off;
    const k = TAU / w.len;
    const kx = Math.sin(dir) * k, kz = -Math.cos(dir) * k;
    const omega = Math.sqrt(G * k);
    const phase = ((kx * origin[0] + kz * origin[1] - omega * (time % 86400)) % TAU + TAU) % TAU;
    return { kx, kz, amp: w.amp * s, phase, omega };
  });
}

/** Sea surface height at a Rel point for a waveSet (the shader's own sum). */
export function waveHeight(waves, x, z) {
  let h = 0;
  const n = Math.min(waves.length, DISPLACING_WAVES);
  for (let i = 0; i < n; i++) { const w = waves[i]; h += w.amp * Math.sin(w.kx * x + w.kz * z + w.phase); }
  return h;
}

/** Most heel the wind lays a ship over under full sail (radians), by hull class. */
export const MAX_WIND_HEEL = Object.freeze({ boat: 0.2, small: 0.15, galley: 0.1, large: 0.12 });

/**
 * Pitch, heel and heave a hull takes from the waves under it and the wind in its sails. Deterministic given
 * the same snapshot and clock, so every crew member sees the same motion.
 * vessel: {x, z (Rel), yaw, length, beam, sail 0..1, cls}; wind: {from, speed}. Server heel/pitch win when sent.
 */
export function shipMotion(waves, vessel, wind) {
  const [fx, fz] = headingVec(vessel.yaw);
  const sx = -fz, sz = fx; // starboard = heading turned clockwise
  const hl = vessel.length / 2, hb = vessel.beam / 2;
  const at = (a, b) => waveHeight(waves, vessel.x + fx * a + sx * b, vessel.z + fz * a + sz * b);
  const bow = at(hl * 0.8, 0), stern = at(-hl * 0.8, 0), port = at(0, -hb), stb = at(0, hb), mid = at(0, 0);
  // Long hulls ride over short waves: damp by hull size.
  const damp = 1 / (1 + vessel.length / 45);
  let pitch = Math.atan2(bow - stern, vessel.length * 0.8) * (0.6 + damp);
  let heel = Math.atan2(port - stb, vessel.beam) * (0.35 + damp);
  const heave = ((bow + stern + port + stb + mid) / 5) * (0.45 + damp * 0.5);
  if (wind && fin(wind.from) && vessel.sail > 0) {
    const rel = wrapPi(wind.from - vessel.yaw); // > 0: wind from starboard, heel to port
    const force = clamp(num(wind.speed, 6) / 12, 0, 1.4);
    heel += -(MAX_WIND_HEEL[vessel.cls] ?? 0.12) * vessel.sail * force * Math.sin(rel);
  }
  if (fin(vessel.heel)) heel = vessel.heel;
  if (fin(vessel.pitch)) pitch = vessel.pitch;
  return { pitch: clamp(pitch, -0.3, 0.3), heel: clamp(heel, -0.6, 0.6), heave };
}

// ---------------------------------------------------------------- sinking

/**
 * A ship going down: extra heel, bow-down pitch and a drop below the waterline from the naval view's state.
 * `since` seconds since the sinking began (or 0..1 progress when only a fraction is known).
 */
export const SINK_SECONDS = 22; // naval: a ship founders 22 s after the sinking news
export function sinkPose(state, since) {
  if (state === 'wrecked') return { drop: 9, heel: 0.55, pitch: -0.25, progress: 1 };
  if (state !== 'sinking') return { drop: 0, heel: 0, pitch: 0, progress: 0 };
  const p = clamp(num(since, 0) / SINK_SECONDS, 0, 1);
  const e = p * p * (3 - 2 * p);
  return { drop: e * 9, heel: e * 0.55, pitch: -e * 0.25, progress: p };
}

// ---------------------------------------------------------------- shots

/** A ball's chart position at server time t: p0 + v0 (t - t0) - g/2 (t - t0)^2 on y (naval contract v1). */
export function ballAt(ball, t, g = G) {
  const dt = t - ball.t0;
  return [ball.p0[0] + ball.v0[0] * dt, ball.p0[1] + ball.v0[1] * dt - 0.5 * g * dt * dt, ball.p0[2] + ball.v0[2] * dt];
}
/** Seconds until a ball falls back to sea level (its natural end when no hit arrives). */
export function ballFlightTime(ball, g = G) {
  const [, y0] = ball.p0, vy = ball.v0[1];
  const disc = vy * vy + 2 * g * Math.max(0, y0);
  return (vy + Math.sqrt(disc)) / g;
}

/**
 * Server clock estimate. Every event carries the server's t (seconds); an event is never received before it
 * was sent, so the largest (t - localNow) seen is the best lower bound on the offset. Slowly forgets so a
 * server restart (clock jump) is followed.
 */
export class ServerClock {
  constructor() { this.offset = null; }
  observe(serverT, localNow) {
    if (!fin(serverT) || !fin(localNow)) return;
    const o = serverT - localNow;
    if (this.offset === null || o > this.offset || Math.abs(o - this.offset) > 30) this.offset = o;
    else this.offset -= 0.002; // drift down slowly; the next event pushes it back up
  }
  now(localNow) { return this.offset === null ? null : localNow + this.offset; }
}

// ---------------------------------------------------------------- snapshots

const SAIL_LEVEL = { furled: 0, struck: 0, none: 0, half: 0.55, reefed: 0.55, full: 1 };
/** Classic ship classes by type name: the deck model and rig used to draw them. */
export function hullClass(type) {
  const t = String(type ?? '').toLowerCase();
  if (/boat|cog|skiff|row/.test(t)) return 'boat';
  if (/galley|corsair/.test(t)) return 'galley';
  if (/large|galleon|carrack|man.?o.?war|frigate/.test(t)) return 'large';
  return 'small'; // small ship, sloop, brig
}
const pair = (v) => (Array.isArray(v) && fin(v[0]) && fin(v[1]) && v[1] > 0 ? [Math.max(0, v[0]), v[1]] : null);
const frac = (p) => (p ? clamp(p[0] / p[1], 0, 1) : null);

/** A vessel or naval contact view, normalised: chart pose and what the drawing needs. Null without x/z. */
export function readVessel(v) {
  if (!isObj(v) || v.id == null) return null;
  const pos = Array.isArray(v.pos) ? v.pos : null;
  const x = num(v.x, pos ? num(pos[0]) : null), z = num(v.z, pos ? num(pos[pos.length === 2 ? 1 : 2]) : null);
  if (x === null || z === null) return null;
  const yaw = num(v.yaw, num(v.heading, 0));
  const sailsRaw = v.sail ?? v.sails ?? v.sailSet;
  let sail = typeof sailsRaw === 'string' ? (SAIL_LEVEL[sailsRaw] ?? 1) : fin(sailsRaw) ? clamp(sailsRaw, 0, 1) : null;
  const hull = pair(v.hull) ?? (isObj(v.hull) && fin(v.hull.hp) && fin(v.hull.max) && v.hull.max > 0 ? [v.hull.hp, v.hull.max] : null) ?? (fin(v.hullHp) && fin(v.maxHull) && v.maxHull > 0 ? [v.hullHp, v.maxHull] : null);
  const sailHp = pair(Array.isArray(v.sails) ? v.sails : null) ?? (fin(v.sailHp) && fin(v.maxSail) && v.maxSail > 0 ? [v.sailHp, v.maxSail] : null);
  const crew = pair(v.crew) ?? (fin(v.crew) ? [v.crew, num(v.maxCrew, v.crew) || 1] : null);
  const state = typeof v.state === 'string' ? v.state : v.sunk ? 'wrecked' : v.sinking ? 'sinking' : 'afloat';
  if (sail === null) sail = v.anchored || v.moored || v.mooredAt || v.docked || state === 'wrecked' ? 0 : 1;
  if (state === 'struck' || state === 'wrecked') sail = Math.min(sail, 0.15);
  return {
    id: String(v.id),
    name: typeof v.name === 'string' ? v.name : typeof v.title === 'string' ? v.title : null,
    kind: v.kind === 'npc' ? 'npc' : 'player',
    cls: hullClass(typeof v.hull === 'string' ? v.hull : v.type ?? v.hullClass ?? v.classId),
    type: typeof v.type === 'string' ? v.type : null,
    length: num(v.length, null),
    faction: typeof v.faction === 'string' ? v.faction : v.hostile ? 'pirate' : v.kind === 'npc' ? 'merchant' : 'player',
    x, z, yaw, speed: num(v.speed, 0),
    yawRate: num(v.yawRate, null), heel: num(v.heel, null), pitch: num(v.pitch, null),
    sail, sailHealth: frac(sailHp), hullHealth: frac(hull), crew: crew ? Math.round(crew[0]) : null,
    state, fire: clamp(num(v.fire, 0), 0, 3), colours: v.colours === 'hostile' || v.hostile === true ? 'hostile' : v.colours === 'struck' ? 'struck' : 'peace',
    anchored: v.anchored === true || !!v.mooredAt || v.moored === true || !!v.docked,
    grounded: v.grounded === true,
    oars: num(v.oars, 0),
    rudder: num(v.rudder, 0),
    helmId: v.helmId != null ? String(v.helmId) : null,
    ownerName: typeof v.ownerName === 'string' ? v.ownerName : null,
    flag: v.flag ?? v.naval?.flag ?? null,
    grappledTo: v.grappledTo != null ? String(v.grappledTo) : null,
    sinkingSince: num(v.sinkingSince, num(v.sinkStartedAt, null)),
    location: typeof v.location === 'string' ? v.location : typeof v.deck === 'string' ? v.deck : null,
  };
}

/** Wind as {from, speed}: accepts `from`, `toward`, or `dir`/`yaw` (treated as from, the compass habit). */
export function readWind(w) {
  if (!isObj(w)) return null;
  let from = num(w.from, null);
  if (from === null && fin(w.toward)) from = w.toward + Math.PI;
  if (from === null) from = num(w.dir, num(w.yaw, num(w.direction, null)));
  if (from === null) return null;
  return { from: wrapPi(from), speed: num(w.speed, 6) };
}

/** Coast rings in chart metres: [{kind, ring: [[x, z, h?], ...], height?}]. */
export function readCoast(list) {
  // coast.shoreNear's answer ({centre, radius, rings}) or a bare ring list.
  let win = null;
  if (isObj(list) && Array.isArray(list.rings)) {
    if (isObj(list.centre) && fin(list.centre.x) && fin(list.centre.z) && fin(list.radius)) win = { x: list.centre.x, z: list.centre.z, r: list.radius };
    list = list.rings;
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    const ring = Array.isArray(c) ? c : Array.isArray(c?.ring) ? c.ring : Array.isArray(c?.points) ? c.points : null;
    if (!ring || ring.length < 3) continue;
    const pts = ring.map((p) => (Array.isArray(p) ? [p[0], p[1], p[2]] : [p?.x, p?.z, p?.h])).filter((p) => fin(p[0]) && fin(p[1]));
    if (pts.length >= 3) out.push({ kind: c?.kind ?? 'land', id: c?.id ?? null, height: num(c?.height, null), ring: pts, clipped: c?.clipped === true, window: win });
  }
  return out;
}

/** Ports with chart positions: [{id, name, x, z, yaw?, here?}]. */
export function readPorts(list) {
  if (!Array.isArray(list)) return [];
  return list.map((p) => readVessel({ ...p, id: p?.id ?? p?.name })).filter(Boolean).map((p, i) => ({
    id: p.id, name: p.name ?? list[i]?.name ?? p.id, x: p.x, z: p.z, yaw: num(list[i]?.yaw, null), here: list[i]?.here === true, charted: list[i]?.charted !== false,
  }));
}

/**
 * Dead-reckoned chart pose of one vessel between snapshots, smoothed so a correction slides instead of
 * snapping (a jump of more than `snap` metres - a teleport, docking - snaps).
 */
export class VesselTrack {
  constructor(snap = 40) { this.snap = snap; this.base = null; this.pose = null; }
  update(v, at) {
    let yawRate = v.yawRate;
    if (!fin(yawRate) && this.base && at > this.base.at + 0.05) {
      const r = wrapPi(v.yaw - this.base.yaw) / (at - this.base.at);
      yawRate = Math.abs(r) < 0.6 ? r : 0;
    }
    this.base = { x: v.x, z: v.z, yaw: v.yaw, speed: v.anchored ? 0 : v.speed, yawRate: num(yawRate, 0), at };
  }
  predict(at) {
    const b = this.base;
    if (!b) return null;
    const dt = clamp(at - b.at, 0, 2.5);
    const yaw = b.yaw + b.yawRate * dt;
    const mid = b.yaw + b.yawRate * dt * 0.5;
    const [hx, hz] = headingVec(mid);
    return { x: b.x + hx * b.speed * dt, z: b.z + hz * b.speed * dt, yaw };
  }
  sample(at, dt) {
    const t = this.predict(at);
    if (!t) return null;
    if (!this.pose || Math.hypot(t.x - this.pose.x, t.z - this.pose.z) > this.snap) this.pose = { ...t };
    else {
      const k = 1 - Math.exp(-clamp(dt, 0, 0.5) * 5);
      this.pose.x += (t.x - this.pose.x) * k;
      this.pose.z += (t.z - this.pose.z) * k;
      this.pose.yaw += wrapPi(t.yaw - this.pose.yaw) * k;
    }
    return this.pose;
  }
}
