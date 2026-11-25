// Naval combat rules (pure: no runtime, no clock, no I/O).
//
// Adapted from Daggerfall Online by Lattymoy (MIT License, Copyright (c) 2026 Lattymoy), public snapshot
// .ref/dfjs-research-03 @ a3eb1605ea1dc391b691fe314377458a7e63e483:
//   src/systems/naval/navalShips.js     GUNS, hull builds (battery muzzles, hull and rig extents), SHIP_CLASSES, factions
//   src/systems/naval/shotKinds.js      SHOT factors (round, grape, chain, heated), shotGun, grape reach
//   src/systems/naval/navalGunnery.js   bow/stern arcs, ripple, reload with crew share, load groups
//   src/systems/naval/navalBallistics.js closed-form flight, elevation for range, seeded triangular scatter
//   src/systems/naval/navalDamage.js    STRUCK_AT, sinking, waterline bonus, fire, brace, bare poles, shotDamage
//   src/systems/naval/navalRam.js       ram threshold, share, glance, recoil, men per hull
//   src/systems/naval/navalBoarding.js  BOARD_RANGE, musters (DFU MobileTypes), surrender share, abandon range
//   src/systems/naval/navalPlunder.js   hold loot keys per faction (DFU loot matrix keys), strongboxes
//   src/systems/naval/navalLaw.js       notoriety amounts, witness range, piracy on first strike
//   src/systems/naval/navalAI.js        engage/disengage/flee ranges, bearing windows, lay error
//   src/systems/naval/navalDirector.js  spawn clear / despawn distances, spawn chance and roll period
//   src/net/sea/seaPrizeLaw.js          a wrecked player's prize: 1/3 of the hold's worth, 8 pieces at most
//   src/systems/helmWay.js              point of sail and wind share
// Numbers are the reference's; geometry is reduced to boxes in the ship's frame. No art, text or audio is used.
//
// Frames: world x east, z south, y up (sea level 0), metres. Ship frame: x starboard, y up, z forward (bow).
// Yaw 0 = north (-z); heading (sin yaw, -cos yaw); starboard (cos yaw, sin yaw).

export const G = 9.81;
const DEG = Math.PI / 180;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ------------------------------------------------------------------ guns and shot

export const GUNS = Object.freeze({
  long: Object.freeze({ speed: 62, minEl: -8, maxEl: 15, reload: 9, yawSpread: 1.6, pitchSpread: 0.9, radius: 0.11, hull: 14, sail: 3, crew: 1 }),
  swivel: Object.freeze({ speed: 55, minEl: -10, maxEl: 14, reload: 4, yawSpread: 1.3, pitchSpread: 0.8, radius: 0.07, hull: 5, sail: 2, crew: 2 }),
  heavy: Object.freeze({ speed: 68, minEl: -6, maxEl: 15, reload: 12, yawSpread: 2.0, pitchSpread: 1.0, radius: 0.15, hull: 30, sail: 4, crew: 2 }),
  chain: Object.freeze({ speed: 58, minEl: -6, maxEl: 16, reload: 7, yawSpread: 2.2, pitchSpread: 1.2, radius: 0.13, hull: 3, sail: 16, crew: 1 }),
  barrel: Object.freeze({ speed: 0, minEl: 0, maxEl: 0, reload: 6, yawSpread: 0, pitchSpread: 0, radius: 0.5, hull: 45, sail: 6, crew: 3 }),
});
export const BARREL = Object.freeze({ life: 90, fuse: 7, burn: 12, burnPerSecond: 2.5, stock: 4, arm: 1.6, reach: 3 });

export const SHOT_ORDER = Object.freeze(['round', 'grape', 'chain', 'heated']);
export const SHOT = Object.freeze({
  round: Object.freeze({ speed: 1, spread: 1, sweep: 0, hull: 1, sail: 1, crew: 1, reload: 1, fire: null, rigFire: false }),
  grape: Object.freeze({ speed: 0.82, spread: 2.4, sweep: 0.45, hull: 0.2, sail: 0.6, crew: 4, reload: 0.9, fire: null, rigFire: false }),
  chain: Object.freeze({ speed: 0.9, spread: 1.6, sweep: 0.3, hull: 0.22, sail: 4, crew: 0.6, reload: 1.15, fire: null, rigFire: false }),
  heated: Object.freeze({ speed: 1, spread: 1.1, sweep: 0, hull: 0.85, sail: 0.8, crew: 1, reload: 1.6, fire: 0.45, rigFire: true }),
});
export const GRAPE_FULL_S = 1.2;
export const GRAPE_SPENT_S = 2.6;
export const SHOT_SWITCH = 0.5;
export const shotId = (s) => (SHOT_ORDER.includes(s) ? s : 'round');
export const naturalShot = (gunKind) => (gunKind === 'chain' ? 'chain' : 'round');
export const loadOf = (gunKind, shot) => (gunKind === 'barrel' ? null : shot == null ? naturalShot(gunKind) : shotId(shot));

/** The gun as it fires `shot`: the load's factors over its natural load's (shotKinds.js shotGun). */
export function shotGun(gunKind, shot) {
  const gun = GUNS[gunKind];
  const own = naturalShot(gunKind);
  const s = shot == null ? own : shotId(shot);
  if (!gun || gunKind === 'barrel' || s === own) return { ...gun, shot: gunKind === 'barrel' ? null : s };
  const a = SHOT[s], o = SHOT[own];
  const k = (key) => a[key] / o[key];
  return {
    ...gun, shot: s, speed: gun.speed * k('speed'), yawSpread: gun.yawSpread * k('spread'), pitchSpread: gun.pitchSpread * k('spread'),
    radius: gun.radius + Math.max(0, a.sweep - o.sweep), reload: gun.reload * k('reload'),
    hull: gun.hull * k('hull'), sail: gun.sail * k('sail'), crew: gun.crew * k('crew'),
  };
}
export const shotFireChance = (shot) => (shot == null ? FIRE_CHANCE : (SHOT[shotId(shot)].fire ?? FIRE_CHANCE));
export const shotRigFire = (shot) => shot != null && SHOT[shotId(shot)].rigFire;
/** Grapeshot's men fall off with flight time (whole to 1.2 s, half by 2.6 s). */
export function shotReach(shot, t) {
  if (shot !== 'grape' || !(t > GRAPE_FULL_S)) return 1;
  return 1 - 0.5 * Math.min(1, (t - GRAPE_FULL_S) / (GRAPE_SPENT_S - GRAPE_FULL_S));
}

// ------------------------------------------------------------------ gunnery

export const SIDES = Object.freeze(['starboard', 'port', 'bow', 'stern']);
export const LOAD_GROUPS = Object.freeze(['broadside', 'bow', 'stern']);
export const loadGroupOf = (side) => (side === 'starboard' || side === 'port' ? 'broadside' : side === 'bow' || side === 'stern' ? side : null);
export const BOW_ARC = 35;
export const STERN_ARC = 40;
export const RIPPLE_S = 0.09;
export const RELOAD_UNDERMANNED = 0.8;
export const RELOAD_SINGLEHANDED = 1.4;
export const BARREL_DROP_S = 1.2;
export const BALL_LIFE = 9;
export const NEAR_MISS_M = 8;

/** A battery's reload (s): the load's, slower undermanned, slower still with no crew at all. */
export function reloadSeconds(gunKind, crewShare, crewed, shot = null) {
  if (!GUNS[gunKind]) return 0;
  if (gunKind === 'barrel') return BARREL_DROP_S;
  const g = shotGun(gunKind, loadOf(gunKind, shot));
  if (!crewed) return g.reload * RELOAD_SINGLEHANDED;
  return g.reload * (1 + RELOAD_UNDERMANNED * (1 - clamp(crewShare, 0, 1)));
}

/** Seeded RNG (mulberry32) — one seed per volley so every viewer could scatter it the same way. */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const shotPosition = (p0, v0, t) => [p0[0] + v0[0] * t, p0[1] + v0[1] * t - 0.5 * G * t * t, p0[2] + v0[2] * t];
export function timeToHeight(y0, vy, h) {
  const d = vy * vy + 2 * G * (y0 - h);
  if (d < 0) return null;
  const t = (vy + Math.sqrt(d)) / G;
  return t >= 0 ? t : null;
}
export function rangeAt(elevation, speed, dy) {
  const t = timeToHeight(dy, Math.sin(elevation) * speed, 0);
  return t == null ? 0 : Math.cos(elevation) * speed * t;
}
export function elevationForRange(range, speed, dy, lo, hi) {
  if (!(range > 0)) return lo;
  const v2 = speed * speed;
  const disc = v2 * v2 - G * (G * range * range - 2 * dy * v2);
  if (disc < 0) return hi;
  return clamp(Math.atan((v2 - Math.sqrt(disc)) / (G * range)), lo, hi);
}
export const maxRange = (speed, dy, hi) => rangeAt(Math.min(hi, 45 * DEG), speed, dy);
export function launchVelocity(dir, elevation, speed, carry = null) {
  const l = Math.hypot(dir[0], dir[2]) || 1;
  const c = (Math.cos(elevation) * speed) / l, s = Math.sin(elevation) * speed;
  return [dir[0] * c + (carry?.[0] ?? 0), s + (carry?.[1] ?? 0), dir[2] * c + (carry?.[2] ?? 0)];
}
/** A lay bent by up to the spread in each axis (triangular: most near the lay). */
export function scatter(dir, elevation, yawSpreadDeg, pitchSpreadDeg, rand) {
  const tri = () => rand() + rand() - 1;
  const a = tri() * yawSpreadDeg * DEG, c = Math.cos(a), s = Math.sin(a);
  return { dir: [dir[0] * c + dir[2] * s, 0, -dir[0] * s + dir[2] * c], elevation: elevation + tri() * pitchSpreadDeg * DEG };
}

// ------------------------------------------------------------------ hulls (ship frame: x starboard, y up, z forward)

/** z positions of n guns evenly along [a, b]. */
const spread = (n, a, b) => Array.from({ length: n }, (_, i) => (n === 1 ? (a + b) / 2 : a + ((b - a) * i) / (n - 1)));

/**
 * The reference's hull builds, reduced: `side` the broadside gun, muzzle x/y and the z span its ports lie on (the
 * reference's own first and last muzzle), `bow`/`stern` batteries' muzzles, hull box [−halfWidth, halfWidth] ×
 * [keel, top] × [aftZ, bowZ] (the hull collider's bounds), rig box (the union of the reference's rig boxes; a ball tears
 * canvas passing through it and flies on), hull/sail points before
 * toughness (×1.6), the hull's crew, whether its stem is a ram, and how far its canvas drives it (`sailWay`).
 */
const TOUGH = 1.6;
const tough = (hp) => Math.round(hp * TOUGH);
export const HULL_BUILDS = Object.freeze({
  0: { gun: null, sideX: 0, sideY: 0, span: [0, 0], ports: 0, bow: null, stern: null, hullHp: tough(60), sailHp: 0, crew: 0, deck: 0.1, bowZ: 2.94, aftZ: -2.14, halfWidth: 1.08, keel: -0.23, top: 0.78, rig: null, ram: false },
  1: { gun: 'swivel', sideX: 2.65, sideY: 2.62, span: [-2.3, 2.3], ports: 3, bow: { gun: 'swivel', muzzles: [[-0.35, 2.62, 6.25]] }, stern: null, hullHp: tough(150), sailHp: tough(60), crew: 0, deck: 0.9, bowZ: 6.24, aftZ: -6.24, halfWidth: 2.03, keel: -0.62, top: 2.59, rig: { x: 3.32, y: [2.72, 8.87], z: [-5.35, 7.24] }, ram: false },
  2: { gun: 'long', sideX: 5.949, sideY: 2.2435, span: [-7.595, 6.5135], ports: 5, bow: { gun: 'chain', muzzles: [[-1.15, 7.45, 19.15], [1.15, 7.45, 19.15]] }, stern: { gun: 'barrel', muzzles: [[0, 5.4, -20.6]] }, hullHp: tough(420), sailHp: tough(160), crew: 24, deck: 6.2, bowZ: 21.93, aftZ: -19.91, halfWidth: 5.86, keel: -4.64, top: 12.3, rig: { x: 6.3, y: [7.7, 17.82], z: [-8.2, 22.5] }, ram: false },
  3: { gun: 'long', sideX: 9.3, sideY: 11.1, span: [-20, 16], ports: 4, bow: { gun: 'heavy', muzzles: [[-1.6, 8.3, 45], [0, 8.3, 46], [1.6, 8.3, 45]] }, stern: null, hullHp: tough(520), sailHp: tough(90), crew: 60, deck: 10.25, bowZ: 51.27, aftZ: -41.89, halfWidth: 11.17, keel: -2.46, top: 14.09, rig: { x: 25, y: [17, 36.9], z: [12.5, 17] }, ram: true },
  4: { gun: 'long', sideX: 6.785, sideY: 3.4982, span: [-9.2435, 6.8825], ports: 5, bow: { gun: 'chain', muzzles: [[-1.15, 9.95, 20.45], [1.15, 9.95, 20.45]] }, stern: { gun: 'barrel', muzzles: [[0, 8.9, -23.6]] }, hullHp: tough(560), sailHp: tough(220), crew: 30, deck: 7.81, bowZ: 26.14, aftZ: -23.31, halfWidth: 6.7, keel: -4.59, top: 11.55, rig: { x: 5.7, y: [9.3, 19.07], z: [9, 29.3] }, ram: false },
});
for (const b of Object.values(HULL_BUILDS)) Object.freeze(b);
export const HULL_NAMES = Object.freeze({ 0: 'boat', 1: 'sloop', 2: 'galleon', 3: 'galley', 4: 'carrack' });

/** Player hull ids (server/rpg/sailing/yard.js and the classic deeds) onto the reference builds they fight as. */
export const PLAYER_HULL = Object.freeze({ rowboat: 0, cutter: 1, cog: 1, small: 2, large: 4 });

/**
 * One ship's batteries in its own frame. `broadsideGuns` overrides the per-side port count (a refit or a yard's gun
 * count); ports lie evenly along the reference build's span.
 */
export function batteriesOf(hull, broadsideGuns = null) {
  const b = HULL_BUILDS[hull];
  if (!b) return {};
  const out = {};
  const n = broadsideGuns == null ? b.ports : Math.max(0, Math.floor(broadsideGuns));
  if (b.gun && n > 0) {
    const zs = spread(n, b.span[0], b.span[1]);
    out.starboard = { gun: b.gun, muzzles: zs.map((z) => [b.sideX, b.sideY, z]), dir: [1, 0, 0] };
    out.port = { gun: b.gun, muzzles: zs.map((z) => [-b.sideX, b.sideY, z]), dir: [-1, 0, 0] };
  }
  if (b.bow) out.bow = { gun: b.bow.gun, muzzles: b.bow.muzzles, dir: [0, 0, 1] };
  if (b.stern) out.stern = { gun: b.stern.gun, muzzles: b.stern.muzzles, dir: [0, 0, -1] };
  return out;
}

// ------------------------------------------------------------------ classes and factions

export const FACTIONS = Object.freeze({
  pirate: Object.freeze({ id: 'pirate', title: 'Pirates', hostile: true, lawful: false, flees: false }),
  merchant: Object.freeze({ id: 'merchant', title: 'Merchantman', hostile: false, lawful: true, flees: true }),
  navy: Object.freeze({ id: 'navy', title: 'Navy', hostile: false, lawful: true, flees: false }),
});

const cls = (id, faction, hull, title, o) => Object.freeze({
  id, faction, hull, title,
  hullHp: Math.round(HULL_BUILDS[hull].hullHp * o.hullHp), sailHp: Math.round(HULL_BUILDS[hull].sailHp * o.sailHp),
  crew: o.crew, speed: o.speed, turn: o.turn, skill: o.skill, range: o.range, cargo: o.cargo, minLevel: o.minLevel,
  weight: o.weight, boarders: o.boarders, flagship: !!o.flagship, tactic: o.tactic ?? 'broadside',
});
export const SHIP_CLASSES = Object.freeze([
  cls('pirateSloop', 'pirate', 1, 'Pirate Sloop', { hullHp: 1.1, sailHp: 1, crew: 10, speed: 4.6, turn: 16, skill: 0.45, range: 50, cargo: 1, minLevel: 1, weight: 5, boarders: 8 }),
  cls('pirateBrig', 'pirate', 2, 'Pirate Brigantine', { hullHp: 0.9, sailHp: 0.9, crew: 22, speed: 7.6, turn: 9, skill: 0.55, range: 95, cargo: 2, minLevel: 4, weight: 4, boarders: 13 }),
  cls('pirateGalley', 'pirate', 3, 'Corsair Galley', { hullHp: 0.85, sailHp: 1, crew: 40, speed: 6.6, turn: 8, skill: 0.5, range: 80, cargo: 2, minLevel: 7, weight: 2, boarders: 13, tactic: 'bow' }),
  cls('pirateFlagship', 'pirate', 4, 'Pirate Flagship', { hullHp: 1.15, sailHp: 1, crew: 34, speed: 6.4, turn: 6, skill: 0.7, range: 110, cargo: 4, minLevel: 9, weight: 1, boarders: 20, flagship: true }),
  cls('merchantCoaster', 'merchant', 1, 'Coasting Trader', { hullHp: 0.9, sailHp: 1, crew: 5, speed: 4.0, turn: 13, skill: 0.25, range: 60, cargo: 1, minLevel: 1, weight: 5, boarders: 5 }),
  cls('merchantGalleon', 'merchant', 2, 'Merchant Galleon', { hullHp: 0.8, sailHp: 0.9, crew: 14, speed: 6.5, turn: 8, skill: 0.3, range: 110, cargo: 3, minLevel: 3, weight: 3, boarders: 9 }),
  cls('merchantCarrack', 'merchant', 4, 'Merchant Carrack', { hullHp: 0.9, sailHp: 0.9, crew: 18, speed: 5.4, turn: 5, skill: 0.3, range: 120, cargo: 4, minLevel: 5, weight: 2, boarders: 11 }),
  cls('navyCutter', 'navy', 2, 'Navy Cutter', { hullHp: 1, sailHp: 1, crew: 26, speed: 8.0, turn: 10, skill: 0.75, range: 90, cargo: 2, minLevel: 1, weight: 3, boarders: 14 }),
  cls('navyGalley', 'navy', 3, 'War Galley', { hullHp: 1, sailHp: 1, crew: 60, speed: 6.8, turn: 9, skill: 0.7, range: 70, cargo: 2, minLevel: 6, weight: 2, boarders: 18, tactic: 'bow' }),
]);
export const classById = (id) => SHIP_CLASSES.find((c) => c.id === id) ?? null;

/** A weighted class pick for a faction (or any) at a captain level. */
export function pickClass(rand, { level = 1, faction = null, pirateK = 1 } = {}) {
  const pool = SHIP_CLASSES.filter((c) => c.minLevel <= Math.max(1, level) && (!faction || c.faction === faction));
  const w = (c) => c.weight * (c.faction === 'pirate' ? pirateK : 1);
  const total = pool.reduce((n, c) => n + w(c), 0);
  let r = rand() * total;
  for (const c of pool) if ((r -= w(c)) <= 0) return c;
  return pool[pool.length - 1] ?? SHIP_CLASSES[0];
}

// ------------------------------------------------------------------ damage

export const STRUCK_AT = 0.25;
export const SINK_SECONDS = 22;
export const WATERLINE_BAND = 1.1;
export const HOLED_BONUS = 0.4;
export const FIRE_CHANCE = 0.06;
export const FIRE_HP = 1.4;
export const FIRE_SECONDS = 15;
export const FIRE_STACK = 3;
export const FIRE_SAIL = 0.5;
export const FIRE_CREW_S = 10;
export const BRACE_TAKEN = 0.5;
export const BARE_POLES = 0.35;
export const SHIP_TOUGHNESS = TOUGH;
export const PLAYER_CREW_TOUGHNESS = 2 * TOUGH;

export const hitZone = (overSea) => (overSea <= WATERLINE_BAND ? 'holed' : 'hull');
export const shotMen = (gun, zone) => (zone === 'rig' ? (gun.crew > 0 ? 1 : 0) : gun.crew);
export const ballMen = (men, roll, t = TOUGH) => (men > 0 ? Math.floor(men / t + clamp(roll, 0, 0.999999)) : 0);

/** One ball's harm in `zone` ('hull' | 'holed' | 'rig'), each ball 85–115% on its roll; bracing halves it. */
export function shotDamage(gun, zone, { braced = false, roll = 0.5, tough: t = TOUGH, reach = 1 } = {}) {
  const k = braced ? BRACE_TAKEN : 1;
  const r = clamp(roll, 0, 1);
  const sp = 0.85 + 0.3 * r;
  const men = ballMen(shotMen(gun, zone) * reach, r, t);
  if (zone === 'rig') return { hull: 0, sail: Math.round(Math.max(gun.sail * 2, gun.hull * 0.5) * k * sp), crew: men };
  const holed = zone === 'holed' ? 1 + HOLED_BONUS : 1;
  return { hull: Math.round(gun.hull * holed * k * sp), sail: Math.round(gun.sail * 0.25 * k * sp), crew: men };
}
/** Her way under what canvas she has left: bare poles keep 35%. */
export const wayShare = (sail, maxSail) => (maxSail > 0 ? BARE_POLES + (1 - BARE_POLES) * clamp(sail / maxSail, 0, 1) : 1);

// ------------------------------------------------------------------ ramming

export const RAM_SPEED = 1.6;
export const RAM_FULL_SPEED = 8;
export const RAM_SHARE = 0.15;
export const GALLEY_SHARE = 0.3;
export const RAM_GLANCE = 0.4;
export const RAM_RECOIL = 0.3;
export const BOW_RECOIL = 2;
export const GALLEY_RAM = 3;
export const RAM_A_MAN = 40;
export const RAM_REACH = 1.2;
export const RAM_COOLDOWN_S = 3;
export function ramBlow({ closing, side, mine, hers, galley = false }) {
  if (!(closing >= RAM_SPEED)) return 0;
  const pace = Math.min(1, closing / RAM_FULL_SPEED);
  const lesser = Math.max(0, Math.min(Number(mine) || 0, Number(hers) || 0));
  return Math.round((galley ? GALLEY_SHARE : RAM_SHARE) * lesser * pace * (side ? 1 : RAM_GLANCE));
}
export const recoilShare = (galley = false) => RAM_RECOIL * (galley ? 1 / GALLEY_RAM : BOW_RECOIL);

// ------------------------------------------------------------------ boarding

export const BOARD_RANGE = 32;
export const SURRENDER_SHARE = 0.7;
export const ABANDON_RANGE = 160;
export const MUSTER_MIN = 3;
export const MUSTER_MAX = 12;
export const REPEL_PARTY = Object.freeze({ min: 3, max: 6 });
/** DFU MobileTypes (EnemyBasics class ids). */
export const MOBILE = Object.freeze({ Spellsword: 129, BattleMage: 130, Nightblade: 133, Bard: 134, Rogue: 136, Thief: 138, Assassin: 139, Monk: 140, Archer: 141, Ranger: 142, Barbarian: 143, Warrior: 144, Knight: 145 });
export const MUSTERS = Object.freeze({
  pirate: { men: [MOBILE.Rogue, MOBILE.Barbarian, MOBILE.Thief, MOBILE.Rogue, MOBILE.Archer, MOBILE.Nightblade, MOBILE.Barbarian, MOBILE.Assassin], captain: MOBILE.Spellsword },
  merchant: { men: [MOBILE.Warrior, MOBILE.Archer, MOBILE.Monk, MOBILE.Warrior, MOBILE.Bard], captain: MOBILE.Ranger },
  navy: { men: [MOBILE.Knight, MOBILE.Warrior, MOBILE.Archer, MOBILE.Warrior, MOBILE.BattleMage, MOBILE.Knight], captain: MOBILE.Knight },
});
export function musterOf(shipClass, crewShare = 1) {
  const m = MUSTERS[shipClass.faction] ?? MUSTERS.pirate;
  const n = clamp(Math.round(shipClass.boarders * clamp(crewShare, 0, 1)), MUSTER_MIN, MUSTER_MAX);
  const men = [];
  for (let i = 0; i < n - 1; i++) men.push(m.men[i % m.men.length]);
  return { captain: m.captain, men };
}
export const repelPartyOf = (shipClass) => clamp(Math.round(shipClass.boarders / 3), REPEL_PARTY.min, REPEL_PARTY.max);
export function boardingWon({ captainDown, down, total }) {
  if (total <= 0) return true;
  if (down >= total) return true;
  return captainDown && down / total >= SURRENDER_SHARE;
}

// ------------------------------------------------------------------ plunder and prizes

/** DFU loot matrix keys a faction's hold draws its lots from; a flagship's last lot is its strongbox ('J'). */
export const HOLD_KEYS = Object.freeze({ pirate: ['S', 'E', 'Q'], merchant: ['Q', 'N', 'P', 'J'], navy: ['T', 'F', 'J'] });
export function holdKeys(shipClass, seed) {
  const keys = HOLD_KEYS[shipClass.faction] ?? HOLD_KEYS.merchant;
  const rng = mulberry32((seed ^ 0x401d) >>> 0);
  const lots = Math.max(1, Math.min(4, shipClass.cargo | 0));
  const out = [];
  for (let i = 0; i < lots; i++) out.push(keys[Math.floor(rng() * keys.length) % keys.length]);
  if (shipClass.flagship) out[lots - 1] = 'J';
  return out;
}
export const SEA_PRIZE_SHARE = 1 / 3;
export const SEA_PRIZE_PIECES_MAX = 8;
/**
 * A wrecked captain's prize: her most valuable pieces while they come to a third of the hold's worth (her best always),
 * eight at most. `hold` [{worth}] in hold order; returns the chosen indices.
 */
export function seaPrizePlaces(hold) {
  const rows = hold.map((it, i) => ({ i, w: Math.max(0, Number(it.worth) || 0) })).filter((x) => x.w > 0);
  const whole = rows.reduce((n, x) => n + x.w, 0);
  rows.sort((a, b) => b.w - a.w || a.i - b.i);
  const out = [];
  let taken = 0;
  for (const x of rows) {
    if (out.length >= SEA_PRIZE_PIECES_MAX) break;
    if (out.length > 0 && taken + x.w > whole * SEA_PRIZE_SHARE) continue;
    out.push(x.i);
    taken += x.w;
  }
  return out;
}

// ------------------------------------------------------------------ law

export const NOTORIETY = Object.freeze({ max: 100, fire: 30, sink: 20, board: 15, decayPerDay: 12 });
export const WITNESS_RANGE = 650;
export const notorietyLevel = (n) => Math.max(0, Math.min(4, Math.floor((Number(n) || 0) / 25)));

// ------------------------------------------------------------------ AI and director

export const ENGAGE_RANGE = 750;
export const DISENGAGE = 1.35;
export const FLEE_RANGE = 320;
export const CHASE_GIVE_UP_S = 150;
export const BEAR_DEG = 13;
export const BOW_BEAR = 11;
export const LAY_ERR = 0.9;
export const SPAWN_CLEAR = 450;
export const DESPAWN_BEYOND = 1900;
export const FIRST_ROLL_S = 30;
export const SHIP_SPAWN_CHANCE = 0.8;
export const PORT_PIRATE_K = 0.5;

// ------------------------------------------------------------------ wind

export const POINT_OF_SAIL = Object.freeze({ run: 0.9, quarter: 45, head: 0.55 });
/** Share of best way for `offRun` degrees between heading and where the wind blows TO (0 running, 180 head to wind). */
export function pointOfSail(offRun) {
  const d = Math.min(180, Math.abs(Number(offRun) || 0));
  const { run, quarter, head } = POINT_OF_SAIL;
  if (d <= quarter) return run + ((1 - run) * (1 - Math.cos((Math.PI * d) / quarter))) / 2;
  return head + ((1 - head) * (1 + Math.cos((Math.PI * (d - quarter)) / (180 - quarter)))) / 2;
}
export const WIND_RATED = 1.5;
export const windShare = (len) => clamp(len / WIND_RATED, 0.3, 2);

// ------------------------------------------------------------------ frames

export const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
export const fwd = (yaw) => [Math.sin(yaw), -Math.cos(yaw)];
export const right = (yaw) => [Math.cos(yaw), Math.sin(yaw)];
/** Ship-frame point (x starboard, y up, z forward) to world. */
export function toWorld(pose, p) {
  const f = fwd(pose.yaw), r = right(pose.yaw);
  return [pose.x + r[0] * p[0] + f[0] * p[2], p[1], pose.z + r[1] * p[0] + f[1] * p[2]];
}
/** World point to ship frame. */
export function toLocal(pose, w) {
  const f = fwd(pose.yaw), r = right(pose.yaw);
  const dx = w[0] - pose.x, dz = w[2] - pose.z;
  return [dx * r[0] + dz * r[1], w[1], dx * f[0] + dz * f[1]];
}
/** World direction from a ship-frame direction (flat). */
export const dirToWorld = (yaw, d) => { const f = fwd(yaw), r = right(yaw); return [r[0] * d[0] + f[0] * d[2], 0, r[1] * d[0] + f[1] * d[2]]; };
/** Bearing (deg, −180..180, positive to starboard) of a world point off the bow. */
export function bearingOf(pose, x, z) {
  const l = toLocal(pose, [x, 0, z]);
  return Math.atan2(l[0], l[2]) / DEG;
}
export function sideForBearing(b) {
  const a = Math.abs(b);
  if (a <= BOW_ARC) return 'bow';
  if (a >= 180 - STERN_ARC) return 'stern';
  return b > 0 ? 'starboard' : 'port';
}

/** Segment a→b (ship frame) against an AABB grown by r: entry fraction or null (slab test). */
export function segmentBox(a, b, min, max, r = 0) {
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 3; k++) {
    const d = b[k] - a[k];
    const lo = min[k] - r, hi = max[k] + r;
    if (Math.abs(d) < 1e-9) {
      if (a[k] < lo || a[k] > hi) return null;
      continue;
    }
    let u = (lo - a[k]) / d, v = (hi - a[k]) / d;
    if (u > v) [u, v] = [v, u];
    t0 = Math.max(t0, u);
    t1 = Math.min(t1, v);
    if (t0 > t1) return null;
  }
  return t0;
}
export function hullBox(hull) {
  const b = HULL_BUILDS[hull];
  return { min: [-b.halfWidth, b.keel, b.aftZ], max: [b.halfWidth, b.top, b.bowZ] };
}
export function rigBox(hull) {
  const b = HULL_BUILDS[hull];
  return b.rig ? { min: [-b.rig.x, b.rig.y[0], b.rig.z[0]], max: [b.rig.x, b.rig.y[1], b.rig.z[1]] } : null;
}
