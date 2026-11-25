// Pure sailing physics for server/rpg/sailing.js: hulls, wind, sail power, one integration step.
//
// FRAME: global metres on the overland grid (server/rpg/overland.js): x = E (east), z = S (south).
// yaw radians, 0 = north (−z), +π/2 = east: forward = (sin yaw, −cos yaw). speed m/s along forward
// (negative = astern). Wind is given as the direction it blows FROM (same yaw convention) and m/s.
//
// Adapted from the public DFO reference (.ref/dfjs-research-03 at a3eb1605, MIT License, Copyright (c) 2026 Lattymoy):
//   - src/systems/helmWay.js: the responsive helm's point of sail (pointOfSail: 0.9 running, 1 on the quarter, 0.55
//     dead into the wind), the bounded wind share (windShare) and the rudder's steerage curve (steerage);
//   - src/systems/comeSailAway/comeSailAway.js: GetSailPower's square and lateen curves (kept as the classic read-out
//     for the HUD), and UpdateWind's quarter: by day from the north-west, by night from the south-west, flipped south
//     of map row 250, strength scaled by the weather (fog ×0.1, rain ×1.5, storm ×2).
// The speeds, turn rates and hull lengths below are this project's own, sized for Daggerfall's small ship and galleon.

export const TAU = Math.PI * 2;
export const PIXEL = 819.2;

/** Handling per ship type (property SHIPS keys). Lengths in metres; speeds m/s; turns rad/s; accelerations m/s². */
export const HULLS = Object.freeze({
  small: Object.freeze({
    type: 'small', length: 22, beam: 7, draught: 2,
    sailMax: 7, oarMax: 2, oarAstern: 1.2, sailAccel: 0.35, oarAccel: 0.8, drag: 0.12, anchorBrake: 1.6,
    turnSail: 12 * Math.PI / 180, turnOar: 16 * Math.PI / 180,
    rig: Object.freeze({ lateen: 1, square: 0 }), hull: 400,
  }),
  large: Object.freeze({
    type: 'large', length: 42, beam: 11, draught: 4.5,
    sailMax: 9, oarMax: 1.2, oarAstern: 0.8, sailAccel: 0.22, oarAccel: 0.4, drag: 0.08, anchorBrake: 1.2,
    turnSail: 7 * Math.PI / 180, turnOar: 6 * Math.PI / 180,
    rig: Object.freeze({ lateen: 0.35, square: 1 }), hull: 1000,
  }),
});
export const hullOf = (type) => HULLS[type] ?? HULLS.small;
/** A vessel's handling: her deck type's figures, overridden by `v.handling` (the shipyard's hull class and refits). */
export const handlingOf = (v) => (v?.handling ? { ...hullOf(v.type), ...v.handling } : hullOf(v?.type));

/** Speed under which a vessel may make fast to a berth, and how close to it (m). */
export const DOCK_SPEED = 1.6;
export const DOCK_RANGE = 160;
/** Hull damage per m/s of way when she strikes ground (above GROUND_HARM_SPEED). */
export const GROUND_HARM_SPEED = 2;
export const GROUND_HARM = 6;
/** Integration sub-step (s). */
export const STEP = 0.1;

export const wrap = (a) => {
  let r = a % TAU;
  if (r <= -Math.PI) r += TAU;
  else if (r > Math.PI) r -= TAU;
  return r;
};
export const forwardOf = (yaw) => ({ x: Math.sin(yaw), z: -Math.cos(yaw) });
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * clamp(t, 0, 1);

/** A small deterministic hash noise in [0,1) for the wind's drift. */
function noise(n) {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}
function smoothNoise(t) {
  const i = Math.floor(t);
  const f = t - i;
  const u = f * f * (3 - 2 * f);
  return lerp(noise(i), noise(i + 1), u);
}

const WEATHER_WIND = Object.freeze({ fog: 0.1, rain: 1.5, thunder: 2, snow: 1.25, overcast: 1.1 });

/**
 * The wind over the Bay at classic `minutes` (shared world clock) near global point (x, z).
 * By day it blows from the north-west, by night from the south-west (UpdateWind's quarter), flipped south of map
 * row 250, wandering ±60° on a slow noise; strength 4–8 m/s scaled by the weather. Every vessel in one water reads
 * the same wind at the same minute.
 * @returns {{from:number, speed:number}}
 */
export function windAt(minutes, z = 0, weather = null) {
  const m = Number.isFinite(minutes) ? minutes : 0;
  const hour = Math.floor(m / 60) % 24;
  const night = hour <= 6 || hour >= 18;
  // UpdateWind: right + back by day (blowing toward SE → from NW), right + forward by night (toward NE → from SW).
  let from = night ? -3 * Math.PI / 4 : -Math.PI / 4;
  if (z / PIXEL > 250) from = wrap(from + Math.PI);
  from = wrap(from + (smoothNoise(m / 97) - 0.5) * (2 * Math.PI / 3));
  const speed = (4 + 4 * smoothNoise(m / 53 + 17)) * (WEATHER_WIND[weather] ?? 1);
  return { from, speed: Math.round(speed * 100) / 100 };
}

/** Angle (0..π) between the way the wind blows TO and her heading: 0 running before it, π head to wind. */
export function windAngle(yaw, windFrom) {
  return Math.abs(wrap(windFrom + Math.PI - yaw));
}

/** GetSailPower's square curve: 1 running, 0 on the beam, aback (negative, doubled) beyond. θ in degrees. */
export function squarePower(deg) {
  const v = lerp(1, 0, deg / 90) + (deg > 90 ? -(deg - 90) / 90 : 0);
  return v < 0 ? v * 2 * 0.25 : v; // aback, softened: she gathers sternway slowly
}
/** GetSailPower's lateen curve: 0.5 running, 1 at 135°, back to 0.5 at 165°, nothing in the wind's eye. */
export function lateenPower(deg) {
  if (deg <= 135) return lerp(0.5, 1, deg / 135);
  if (deg <= 165) return lerp(1, 0.5, (deg - 135) / 30);
  return 0;
}

/** Classic GetSailPower read-out of her rig (−0.5..1) on heading `yaw` in a wind from `windFrom` (HUD only). */
export function classicSailPower(type, yaw, windFrom) {
  const deg = windAngle(yaw, windFrom) * 180 / Math.PI;
  const { rig } = hullOf(type);
  const total = rig.lateen + rig.square;
  return (rig.lateen * lateenPower(deg) + rig.square * squarePower(deg)) / total;
}

/** helmWay.js POINT_OF_SAIL / pointOfSail: share of her best way at `offRun` degrees off a dead run. */
export const POINT_OF_SAIL = Object.freeze({ run: 0.9, quarter: 45, head: 0.55 });
export function pointOfSail(offRun) {
  const d = Math.min(180, Math.abs(Number(offRun) || 0));
  const { run, quarter, head } = POINT_OF_SAIL;
  if (d <= quarter) return run + ((1 - run) * (1 - Math.cos((Math.PI * d) / quarter))) / 2;
  return head + ((1 - head) * (1 + Math.cos((Math.PI * (d - quarter)) / (180 - quarter)))) / 2;
}
/** helmWay.js windShare, rated at this server's middle wind (6 m/s): bounded 0.3..2. */
export const WIND_RATED = 6;
export const windShare = (speed) => clamp((Number(speed) || 0) / WIND_RATED, 0.3, 2);
/** helmWay.js steerage shape: a floor at rest, peaking at `peak` m/s, easing past it. */
export function steerage(way, peak) {
  const x = Math.max(0, way) / peak;
  return 0.25 + 0.75 * x * Math.exp(1 - x);
}

/** Drive share (0..1) of her canvas on heading `yaw` in a wind from `windFrom`: the responsive helm's point of sail. */
export function sailPower(type, yaw, windFrom) {
  return pointOfSail(windAngle(yaw, windFrom) * 180 / Math.PI);
}

/** The responsive helm never lies in irons; kept for the HUD contract. */
export function inIrons() {
  return false;
}

// ------------------------------------------------------------------ frames

/** Sea metres → map pixel and pixel-local metres (overland frame). */
export function seaToPixel(x, z) {
  const px = Math.floor(x / PIXEL);
  const py = Math.floor(z / PIXEL);
  return { px, py, xw: x - px * PIXEL - PIXEL / 2, zw: z - py * PIXEL - PIXEL / 2 };
}
export const pixelToSea = (px, py, xw = 0, zw = 0) => ({ x: px * PIXEL + PIXEL / 2 + xw, z: py * PIXEL + PIXEL / 2 + zw });

/**
 * Bow azimuth of each classic deck in its own town frame (yaw convention), measured from the installed SHIPAA blocks:
 * the small ship's keel runs along x (−5..45 m) with the bow at +x; the galleon's along z (−48..48 m), bow at +z.
 */
export const DECK_BOW = Object.freeze({ small: Math.PI / 2, large: Math.PI });
/** A deck-local point (personal deck feet) placed in the sea under vessel `v`. */
export function deckToSea(v, x, z) {
  const a = v.yaw - (DECK_BOW[v.type] ?? 0);
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x + x * c - z * s, z: v.z + x * s + z * c };
}

/** Target speed for her current orders. */
export function targetSpeed(v, wind, wayShare = 1) {
  const h = handlingOf(v);
  if (v.anchored || v.docked) return 0;
  let target = 0;
  if (v.sails > 0 && h.sailMax > 0) {
    // wayShare (0..1): the naval owner's canvas damage, grapples and sinking take her sail way.
    const share = Number.isFinite(wayShare) ? clamp(wayShare, 0, 1) : 1;
    if (wind.speed > 0) target += h.sailMax * v.sails * sailPower(v.type, v.yaw, wind.from) * windShare(wind.speed) * share;
  }
  if (v.oars > 0) target += h.oarMax;
  else if (v.oars < 0) target -= h.oarAstern;
  return clamp(target, -h.oarAstern, h.sailMax * 2 + h.oarMax);
}

/** The points of her hull that must float: bow, middle, stern. */
export function hullPoints(v, x = v.x, z = v.z, yaw = v.yaw) {
  const h = handlingOf(v);
  const f = forwardOf(yaw);
  const half = h.length / 2;
  return [
    { x: x + f.x * half, z: z + f.z * half },
    { x, z },
    { x: x - f.x * half, z: z - f.z * half },
  ];
}

/**
 * May she move her hull to (nx, nz)? Her middle must float, and her leading end (bow under way, stern going astern)
 * must not run from water onto land. A leading end already over land (a berth laid close under the quay for a long
 * hull) may move as long as it is not driven further in: she can always work her way out to open water.
 */
export function movesFree(v, nx, nz, isWater) {
  const [bow0, mid0, stern0] = hullPoints(v);
  const [bow1, mid1, stern1] = hullPoints(v, nx, nz);
  if (!isWater(mid1.x, mid1.z)) return false;
  void mid0;
  const astern = v.speed < 0;
  const lead0 = astern ? stern0 : bow0, lead1 = astern ? stern1 : bow1;
  if (isWater(lead1.x, lead1.z)) return true;
  // Already over land at her leading end: only if she does not drive deeper (her middle stays afloat).
  return !isWater(lead0.x, lead0.z) && isWater(mid1.x, mid1.z);
}

/**
 * Advance one vessel by `dt` seconds. Mutates v (x, z, yaw, speed, grounded) and returns what happened:
 * {moved, grounded:bool (newly struck), struck:{id}|null, harm:number}.
 * @param {object} v       vessel
 * @param {number} dt
 * @param {object} env     {wind:{from,speed}, isWater(x,z)->bool, others:[{id,x,z,type}]}
 */
export function stepVessel(v, dt, env) {
  const h = handlingOf(v);
  const out = { moved: false, grounded: false, struck: null, harm: 0 };
  if (v.sunk || v.docked) {
    v.speed = 0;
    return out;
  }
  let left = Math.max(0, Math.min(dt, 5));
  let scale = Number.isFinite(env.timeScale) && env.timeScale > 1 ? env.timeScale : 1;
  while (left > 1e-6) {
    const s = Math.min(STEP, left);
    left -= s;
    const target = targetSpeed(v, env.wind, env.wayShare);
    const accel = v.anchored ? h.anchorBrake : v.oars !== 0 && v.sails === 0 ? h.oarAccel : Math.max(h.sailAccel, v.oars ? h.oarAccel * 0.5 : 0);
    const brake = Math.max(accel, h.drag);
    const diff = target - v.speed;
    const rate = Math.abs(target) < Math.abs(v.speed) ? brake : accel;
    v.speed += clamp(diff, -rate * s, rate * s);
    if (Math.abs(v.speed) < 1e-3 && target === 0) v.speed = 0;

    // Steerage: a rudder answers her way; oars give a little turn at rest.
    if (v.rudder && !v.anchored) {
      const way = Math.abs(v.speed);
      const rowing = v.oars !== 0;
      const max = rowing && v.sails === 0 ? h.turnOar : h.turnSail;
      const steer = Math.max(rowing ? 0.5 : 0, Math.min(1, steerage(way, h.sailMax * 0.5)));
      const sign = v.speed < 0 ? -1 : 1;
      v.yaw = wrap(v.yaw + v.rudder * max * steer * sign * s);
    }
    if (v.speed === 0) continue;
    const f = forwardOf(v.yaw);
    // Hard aground: she stays pressed on the shore while her way still drives her into it (a metre's sounding ahead).
    if (v.grounded && env.isWater && Math.sign(v.speed) === (v.groundedDir ?? 1)) {
      const d = Math.sign(v.speed);
      if (!movesFree(v, v.x + f.x * d, v.z + f.z * d, env.isWater)) {
        v.speed = 0;
        continue;
      }
    }
    // timeScale: open-sea compression of distance (her speed, turn and accelerations stay physical). A compressed
    // stride that would cross land (coast segmentClear, bow included) falls back to 1:1 for the rest of this step,
    // so compression never carries her onto a shore; she grounds normally if due.
    let stride = v.speed * s * scale;
    if (scale > 1 && env.segmentClear) {
      const bow = Math.sign(v.speed) * hullOf(v.type).length / 2;
      if (!env.segmentClear(v.x, v.z, v.x + f.x * (stride + bow), v.z + f.z * (stride + bow))) {
        scale = 1;
        stride = v.speed * s;
      }
    }
    const nx = v.x + f.x * stride;
    const nz = v.z + f.z * stride;
    // Ground: every hull point must stay in navigable water.
    if (env.isWater && !movesFree(v, nx, nz, env.isWater)) {
      if (!v.grounded) {
        out.grounded = true;
        if (Math.abs(v.speed) > GROUND_HARM_SPEED) out.harm += Math.round((Math.abs(v.speed) - GROUND_HARM_SPEED) * GROUND_HARM);
      }
      v.grounded = true;
      v.groundedDir = Math.sign(v.speed) || 1;
      v.speed = 0;
      continue;
    }
    // Other hulls: she stops short of a ship she would run into (ramming is the naval owner's).
    let blocked = null;
    for (const o of env.others ?? []) {
      if (o.id === v.id) continue;
      const r = (hullOf(v.type).length + hullOf(o.type).length) / 2 * 0.6;
      const before = Math.hypot(v.x - o.x, v.z - o.z);
      const after = Math.hypot(nx - o.x, nz - o.z);
      if (after < r && after < before) { blocked = o; break; }
    }
    if (blocked) {
      out.struck = { id: blocked.id, speed: v.speed };
      v.speed = 0;
      continue;
    }
    v.x = nx;
    v.z = nz;
    v.grounded = false;
    delete v.groundedDir;
    out.moved = true;
  }
  return out;
}

/** Is she at a berth's quay range and slow enough to make fast? */
export function canDock(v, port) {
  return !!port && Math.hypot(v.x - port.x, v.z - port.z) <= DOCK_RANGE && Math.abs(v.speed) <= DOCK_SPEED;
}
