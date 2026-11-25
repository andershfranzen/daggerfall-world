// Player locomotion rule shared by the server (authority, server/rpg/collision.js) and the browser
// (prediction, client/main.js). DOM-free and Node-free: both sides step the same body against the
// same CollisionWorld (client/gameplay/collision/world.js) with the same numbers, so a prediction
// only diverges through latency or a modifier the browser has not heard about yet.
//
// Modes: 'ground' (walking, running, crouching), 'air' (jumping or falling), 'climb' (on a wall),
// 'swim' (in a water volume deeper than the wading depth) and 'levitate' (Levitate spell).
//
// Classic references (Daggerfall Unity, MIT): PlayerSpeedChanger (run and swim speed), AcrobatMotor
// (jump, gravity, falling damage threshold), ClimbingMotor, LevitateMotor, PlayerEntity (breath).
// Values marked "approximation" are project choices where the classic rule needs data this
// server does not model (game-time fatigue units, random climbing checks); they are deterministic
// so the browser can predict them.

import { velocity, SPEED } from './motion.js';

/** Slab floor of an airborne body (client/gameplay/collision/world.js FLY_STEP): it may land on a ledge this far above its feet. */
const FLY_STEP = 0.2;

export const LOCO = Object.freeze({
  walk: SPEED, // m/s, the server's base ground speed
  gravity: 20, // m/s² (AcrobatMotor gravity)
  terminal: 40, // m/s
  jumpSpeed: 6.2, // m/s at Jumping 0: ~0.96 m rise
  jumpSkillBonus: 2, // m/s added at Jumping 100 (approximation)
  jumpSpellScale: 1.5, // Jumping spell
  safeFall: 5, // m (AcrobatMotor fallingDamageThreshold)
  fallDamagePerMetre: 5, // health per metre beyond safeFall (approximation)
  slowfallSpeed: 2, // m/s maximum descent under Slowfall
  height: 1.8,
  crouchHeight: 0.9,
  eye: 1.6,
  crouchEye: 0.75,
  crouchScale: 0.5, // crouch/sneak speed factor (approximation of PlayerSpeedChanger crouch speed)
  slowScale: 0.5, // classic walk-slowly modifier (Alt held), approximation
  wadeDepth: 1.0, // water deeper than this over the feet makes the body swim
  floatDepth: 1.45, // a swimmer at rest floats with feet this far below the surface (head above)
  climbDelay: 1.2, // s pushing against a wall before climbing starts at Climbing 0 (approximation)
  climbDelayMin: 0.25,
  climbSpeed: 0.8, // m/s up a wall at Climbing 0 (approximation)
  climbSkillBonus: 1.4, // m/s added at Climbing 100
  levitateSpeed: SPEED,
  breathBase: 10, // s of breath before drowning starts, plus Endurance / 4 (approximation of PlayerEntity breath)
  drownEvery: 1, // s between drowning damage
  // Fatigue per second / per action (real-time approximation of PlayerEntity fatigue loss).
  runFatigue: 2,
  swimFatigue: 1,
  climbFatigue: 2,
  jumpFatigue: 3,
});

export const MODES = Object.freeze(['ground', 'air', 'climb', 'swim', 'levitate']);

/** A fresh body standing at (x, y, z). */
export function newBody(x, z, y = null) {
  return {
    x, z, y, vy: 0, mode: 'ground', crouch: false, running: false,
    peak: null, breath: null, underwater: false, drownT: 0, climbHold: 0, jumpSeq: null, moving: false, slow: false, speed: 0,
  };
}

/**
 * Modifiers from the character and its active effects. Every field is optional; the defaults are a
 * level-one character with no spells. The server builds this from services (server/rpg/locomotion.js);
 * the browser builds it from its own `state` snapshot (client/gameplay/movement.js).
 */
export function normalizeMods(m = {}) {
  const n = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    baseSpeed: n(m.baseSpeed, LOCO.walk) > 0 ? n(m.baseSpeed, LOCO.walk) : LOCO.walk,
    mounted: !!m.mounted,
    running: n(m.running, 0),
    jumping: n(m.jumping, 0),
    climbing: n(m.climbing, 0),
    swimming: n(m.swimming, 0),
    endurance: n(m.endurance, 50),
    fatigue: n(m.fatigue, Infinity),
    levitate: !!m.levitate,
    slowfall: !!m.slowfall,
    jumpSpell: !!m.jumpSpell,
    climbSpell: !!m.climbSpell,
    waterWalk: !!m.waterWalk,
    waterBreath: !!m.waterBreath,
    paralyzed: !!m.paralyzed,
    encumbrance: Math.min(1, Math.max(0.1, n(m.encumbrance, 1))), // speed factor from the inventory owner
    sinks: !!m.sinks,
    // Character traversal (package 11: services.characterTraversal): racial/advantage bonuses.
    climbingBonus: n(m.climbingBonus, 0),
    swimmingBonus: n(m.swimmingBonus, 0),
    exertion: Math.max(0, n(m.exertion, 1)), // fatigue cost multiplier
    jumpScale: Math.max(0, n(m.jumpScale, 1)),
    // Temple of Kynareth (package 15, client/gameplay/guilds/perks.js breathScale): Temple.DeepBreath.
    breathScale: Math.min(2, Math.max(1, n(m.breathScale, 1))),
  };
}

const baseBreath = (mods) => LOCO.breathBase + Math.floor(Math.max(0, mods.endurance) / 4);
/** Seconds of breath; GuildManager.DeepBreath scales the breath a dive starts with. */
export const maxBreath = (mods) => Math.floor(baseBreath(mods) * (mods.breathScale ?? 1));

/** PlayerSpeedChanger: run = base * (1.35 + Running / 200); swim = base * Swimming / 200 + base / 4. */
export function speedOf(body, mods) {
  const base = mods.baseSpeed * mods.encumbrance;
  switch (body.mode) {
    case 'swim': return mods.waterWalk ? base : mods.baseSpeed * (Math.min(100, mods.swimming + mods.swimmingBonus) / 200) + mods.baseSpeed / 4;
    case 'levitate': return LOCO.levitateSpeed * mods.encumbrance;
    case 'climb': return 0;
    default:
      if (body.crouch) return base * LOCO.crouchScale;
      if (body.running) return base * (1.35 + mods.running / 200);
      return body.slow ? base * LOCO.slowScale : base;
  }
}

export const bodyHeight = (body) => (body.crouch ? LOCO.crouchHeight : LOCO.height);
export const eyeHeight = (body) => (body.crouch ? LOCO.crouchEye : LOCO.eye);

/** Whether an active Water Walking effect can support this saved foot position. */
export function canResumeWaterWalk(world, x, z, portal) {
  const surface = world?.waterAt(x, z);
  return Number.isFinite(surface) && Number.isFinite(portal?.footY) && Math.abs(portal.footY - surface) <= 0.001
    && world.fits(x, z, surface, { height: LOCO.height });
}

export function canResumeSwim(world, x, z, portal) {
  const y = portal?.footY;
  if (!Number.isFinite(y)) return false;
  const surface = world?.waterAt(x, z);
  if (!Number.isFinite(surface) || surface - y <= LOCO.wadeDepth) return false;
  if (portal.swimming !== true) {
    // Legacy saves have no swim marker. Only bypass floor recovery for a clear body well above a
    // real pool bottom, where the normal 2 m floor search would discard the saved position.
    const floor = world.floorBelow(x, z, y);
    if (floor === null || y - floor <= 2) return false;
  }
  return world.fits(x, z, y, { height: LOCO.height }) || onlyBottomContact(world, x, z, y, LOCO.height);
}

/**
 * Advance one body by dt seconds. Mutates and returns `body`; also returns events for consequences
 * owned elsewhere (fatigue, skill practice, damage, stealth):
 *   {kind:'jump'} {kind:'land', fall, damage} {kind:'climb', start|stop} {kind:'swim', start|stop}
 *   {kind:'submerge'} {kind:'surface'} {kind:'drown', damage} {kind:'stance', crouch}
 *   {kind:'exert', fatigue, skill}  (accumulated per step: running, swimming, climbing)
 * `input`: {forward, strafe, yaw, run, slow, crouch, rise (-1..1), jumpSeq (counter: a new value is one press)}.
 * `world`: CollisionWorld, or null (an open plane at the body's height).
 */
export function stepBody(world, body, input, dt, modsIn) {
  const mods = modsIn && modsIn.baseSpeed !== undefined && modsIn.encumbrance !== undefined ? modsIn : normalizeMods(modsIn);
  const events = [];
  if (!(dt > 0)) return events;
  // Paralysis removes every voluntary input (walking, rising, jumping, climbing); gravity and buoyancy still act.
  const still = mods.paralyzed;
  const f = still ? 0 : clampAxis(input.forward), s = still ? 0 : clampAxis(input.strafe), rise = still ? 0 : clampAxis(input.rise);
  const yaw = Number.isFinite(input.yaw) ? input.yaw : 0;
  if (!Number.isFinite(body.y)) body.y = world ? world.standHeight(body.x, body.z) : 0;
  if (body.breath === null || !Number.isFinite(body.breath)) body.breath = maxBreath(mods);

  // Inputs that change stance or start a jump.
  // The first counter seen (join, reconnect) is adopted without jumping.
  const jumpPressed = !still && Number.isFinite(input.jumpSeq) && body.jumpSeq !== null && input.jumpSeq !== body.jumpSeq;
  if (Number.isFinite(input.jumpSeq)) body.jumpSeq = input.jumpSeq;
  const wantCrouch = still ? body.crouch : !!input.crouch && !mods.mounted && body.mode === 'ground';
  if (wantCrouch !== body.crouch) {
    // Standing up needs head room.
    if (wantCrouch || !world || world.fits(body.x, body.z, body.y, { height: LOCO.height, step: world.player.step })) {
      body.crouch = wantCrouch;
      events.push({ kind: 'stance', crouch: body.crouch });
    }
  }
  if (body.mode !== 'ground' && body.crouch && !(world && !world.fits(body.x, body.z, body.y, { height: LOCO.height }))) body.crouch = false;

  if (still && body.mode === 'climb') {
    body.mode = 'air'; body.vy = 0; body.peak = body.y;
    events.push({ kind: 'climb', stop: true });
  }

  // Environment.
  const waterY = world ? world.waterAt(body.x, body.z) : null;
  const depth = waterY === null ? 0 : waterY - body.y;
  if (mods.levitate && body.mode !== 'levitate') {
    body.mode = 'levitate'; body.vy = 0; body.peak = null; body.climbHold = 0;
  } else if (!mods.levitate && body.mode === 'levitate') {
    body.mode = 'air'; body.vy = 0; body.peak = body.y;
  }
  if (body.mode === 'ground' && !mods.waterWalk && waterY !== null && Math.abs(depth) <= 0.05) {
    const floor = world.floorBelow(body.x, body.z, body.y);
    if (floor === null || body.y - floor > world.player.step) {
      body.mode = 'air'; body.vy = 0; body.peak = body.y;
    }
  }
  if (body.mode !== 'levitate' && body.mode !== 'swim' && waterY !== null && depth > LOCO.wadeDepth) {
    if (body.mode === 'air' && body.peak !== null) events.push({ kind: 'land', fall: Math.max(0, body.peak - body.y), damage: 0, water: true });
    body.mode = 'swim'; body.vy = Math.max(body.vy, -2); body.peak = null; body.crouch = false; body.climbHold = 0;
    events.push({ kind: 'swim', start: true });
  }

  const moving = f !== 0 || s !== 0;
  body.running = !!input.run && !input.slow && body.mode === 'ground' && !body.crouch && !mods.mounted && f > 0 && mods.fatigue > 0;
  body.slow = !still && !!input.slow && body.mode === 'ground' && !body.running;
  const speed = speedOf(body, mods);
  const [vx, vz] = velocity(f, s, yaw, speed);
  const x0 = body.x, z0 = body.z;
  let tx = x0 + vx * dt, tz = z0 + vz * dt;
  const height = bodyHeight(body);

  if (body.mode === 'ground') {
    if (moving) moveGround(world, body, tx, tz, height, mods.waterWalk);
    // Walked off an edge higher than a stair: fall instead of snapping down.
    // Pushing into a wall: start climbing after the delay.
    // Head-on and stopped: sliding or creeping along a wall (even ~5% of the speed) is not a climb.
    const pushed = moving && f > 0.5 && Math.abs(s) < 0.5 && Math.hypot(body.x - x0, body.z - z0) < Math.hypot(tx - x0, tz - z0) * 0.03;
    if (pushed && !mods.mounted && !body.crouch && mods.fatigue > 0 && world) {
      body.climbHold += dt;
      const skill = mods.climbSpell ? 100 : Math.min(100, mods.climbing + mods.climbingBonus);
      const delay = Math.max(LOCO.climbDelayMin, LOCO.climbDelay - skill / 100);
      if (body.climbHold >= delay && wallAhead(world, body, yaw)) {
        body.mode = 'climb'; body.vy = 0; body.climbHold = 0; body.peak = null;
        events.push({ kind: 'climb', start: true });
      }
    } else body.climbHold = 0;
    if (body.mode === 'ground' && jumpPressed && !mods.mounted && mods.fatigue > 0
      && (!world || world.fits(body.x, body.z, body.y + 0.05, { height }))) {
      const skill = mods.jumping;
      body.vy = (LOCO.jumpSpeed + (LOCO.jumpSkillBonus * skill) / 100) * (mods.jumpSpell ? LOCO.jumpSpellScale : 1) * mods.jumpScale;
      body.mode = 'air'; body.peak = body.y; body.crouch = false;
      events.push({ kind: 'jump', fatigue: LOCO.jumpFatigue * mods.exertion, skill: 'Jumping' });
    }
    if (body.running && moving) events.push({ kind: 'exert', fatigue: LOCO.runFatigue * mods.exertion * dt, skill: 'Running', seconds: dt });
  } else if (body.mode === 'climb') {
    const skill = mods.climbSpell ? 100 : Math.min(100, mods.climbing + mods.climbingBonus);
    if (f <= 0 || mods.fatigue <= 0 || !world) {
      // Let go: fall from here.
      body.mode = 'air'; body.vy = 0; body.peak = body.y;
      events.push({ kind: 'climb', stop: true });
    } else {
      const up = (LOCO.climbSpeed + (LOCO.climbSkillBonus * skill) / 100) * dt;
      const ny = body.y + up;
      if (world.fits(body.x, body.z, ny, { height: LOCO.height, step: LOCO.height - 0.05 })) body.y = ny;
      // Try to get over the top: the whole body forward at the new height with the airborne slab, far
      // enough to clear a thin wall or fence (onto a thick wall's top, the landing finds its roof).
      const reach = world.player.radius * 2 + 0.3;
      const fx = body.x + Math.sin(yaw) * reach, fz = body.z - Math.cos(yaw) * reach;
      const m = world.move(body.x, body.z, fx, fz, { y: body.y, fly: true, height: LOCO.height });
      if (!m.blocked) {
        body.x = m.x; body.z = m.z;
        body.mode = 'air'; body.vy = 0; body.peak = body.y;
        events.push({ kind: 'climb', stop: true, top: true });
      } else if (!wallAhead(world, body, yaw)) {
        body.mode = 'air'; body.vy = 0; body.peak = body.y;
        events.push({ kind: 'climb', stop: true });
      }
      events.push({ kind: 'exert', fatigue: LOCO.climbFatigue * mods.exertion * dt, skill: 'Climbing', seconds: dt });
    }
  } else {
    // air, swim, levitate: horizontal sweep that keeps the body's height.
    if (moving && world) {
      const st = { y: body.y, fly: true, height };
      const m = world.move(x0, z0, tx, tz, st);
      body.x = m.x; body.z = m.z;
      if (m.blocked && body.mode === 'swim' && waterY !== null && body.y >= waterY - LOCO.floatDepth - 0.1) {
        // Climb out of the water onto a ledge at most one stair above the surface: probe the floor just past
        // the edge and vault onto it when the body fits there.
        const len = Math.hypot(vx, vz) || 1;
        const reach = world.player.radius * 2 + 0.15;
        const ax = m.x + (vx / len) * reach, az = m.z + (vz / len) * reach;
        const h = world.heightAt(ax, az, waterY);
        if (h !== null && h > body.y && waterY - h <= LOCO.wadeDepth) {
          const v = world.move(m.x, m.z, ax, az, { y: h, fly: true, height: LOCO.height });
          if (!v.blocked) {
            body.x = v.x; body.z = v.z; body.y = h; body.mode = 'ground'; body.vy = 0;
            events.push({ kind: 'swim', stop: true });
          }
        }
      }
    } else if (moving) {
      body.x = tx; body.z = tz;
    }
    if (body.mode === 'air') stepAir(world, body, dt, mods, height, events);
    else if (body.mode === 'swim') stepSwim(world, body, dt, mods, rise, height, events);
    else if (body.mode === 'levitate') stepVertical(world, body, rise * LOCO.levitateSpeed * dt, height);
  }

  // Breath: the eye under the surface.
  const wY = world ? world.waterAt(body.x, body.z) : null;
  const under = wY !== null && body.y + eyeHeight(body) < wY;
  if (under !== body.underwater) {
    body.underwater = under;
    events.push({ kind: under ? 'submerge' : 'surface' });
  }
  const full = maxBreath(mods);
  body.breath = Math.min(full, body.breath);
  if (under && !mods.waterBreath) {
    body.breath = Math.max(0, body.breath - dt);
    if (body.breath <= 0) {
      body.drownT += dt;
      while (body.drownT >= LOCO.drownEvery) {
        body.drownT -= LOCO.drownEvery;
        events.push({ kind: 'drown', damage: Math.max(1, Math.round(baseBreath(mods) / 5)) });
      }
    }
  } else {
    if (!under) body.breath = Math.min(full, body.breath + dt * 4);
    body.drownT = 0;
  }

  body.moving = body.x !== x0 || body.z !== z0;
  body.speed = Math.hypot(body.x - x0, body.z - z0) / dt;
  return events;
}

function clampAxis(v) {
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

function moveGround(world, body, tx, tz, height, waterWalk) {
  if (!world) { body.x = tx; body.z = tz; return; }
  const before = body.y;
  const st = { y: body.y, height: height === LOCO.height ? undefined : height, waterWalk };
  const m = world.move(body.x, body.z, tx, tz, st);
  body.x = m.x; body.z = m.z;
  if (before - m.y > world.player.step) {
    // Over a drop. While part of the footprint is still on the ledge the body stays on it; otherwise it
    // keeps its height and falls from the edge.
    body.y = before;
    if (!(supportAt(world, m.x, m.z, before, 0.05) >= before - 0.05)) { body.mode = 'air'; body.vy = 0; body.peak = before; }
  } else body.y = m.y;
}

/** Something solid in front of the body between knee and head height. */
function wallAhead(world, body, yaw) {
  const d = world.player.radius + 0.2;
  const x = body.x + Math.sin(yaw) * d, z = body.z - Math.cos(yaw) * d;
  return !world.fits(x, z, body.y, { height: LOCO.height, step: FLY_STEP });
}

function stepAir(world, body, dt, mods, height, events) {
  body.vy = Math.max(-LOCO.terminal, body.vy - LOCO.gravity * dt);
  if (mods.slowfall && body.vy < -LOCO.slowfallSpeed) body.vy = -LOCO.slowfallSpeed;
  if (body.peak === null || body.y > body.peak) body.peak = body.y;
  const floor = world ? floorUnder(world, body, mods) : 0;
  let ny = body.y + body.vy * dt;
  if (body.vy > 0 && world && !world.fits(body.x, body.z, ny, { height })) {
    body.vy = 0; ny = body.y; // head hit a ceiling
  }
  if (floor === null) { body.y = ny; return; }
  if (ny <= floor) {
    const fall = Math.max(0, (body.peak ?? floor) - floor);
    const safe = mods.slowfall || mods.levitate;
    const damage = safe || fall <= LOCO.safeFall ? 0 : Math.round((fall - LOCO.safeFall) * LOCO.fallDamagePerMetre);
    body.y = floor; body.vy = 0; body.mode = 'ground'; body.peak = null;
    events.push({ kind: 'land', fall, damage });
  } else body.y = ny;
}

function floorUnder(world, body, mods) {
  const f = supportAt(world, body.x, body.z, body.y, FLY_STEP);
  const waterY = mods.waterWalk ? world.waterAt(body.x, body.z) : null;
  if (waterY !== null && body.y >= waterY - 0.05) return f === null ? waterY : Math.max(f, waterY);
  return f;
}

/** Highest surface at most `tol` above y under the body's footprint (centre and rim), so a body half over a ledge stands on it. */
function supportAt(world, x, z, y, tol) {
  let best = world.floorBelow(x, z, y, tol);
  const r = world.player.radius * 0.7;
  for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
    const h = world.floorBelow(x + dx, z + dz, y, tol);
    if (h !== null && (best === null || h > best)) best = h;
  }
  return best;
}

function stepSwim(world, body, dt, mods, rise, height, events) {
  const waterY = world?.waterAt(body.x, body.z) ?? null;
  const floor = world ? world.floorBelow(body.x, body.z, body.y + 0.3) : null;
  if (waterY === null || (floor !== null && waterY - floor <= LOCO.wadeDepth && body.y <= floor + 0.3)) {
    // Out of the water volume, or the bottom is shallow enough to wade.
    body.mode = floor !== null && body.y - floor < 0.5 ? 'ground' : 'air';
    if (body.mode === 'ground') body.y = floor;
    body.vy = 0; body.peak = body.y;
    events.push({ kind: 'swim', stop: true });
    return;
  }
  const speed = speedOf(body, mods);
  const rest = waterY - LOCO.floatDepth;
  const top = mods.waterWalk ? waterY : rest;
  // LevitateMotor applies downward movement ahead of either vertical control when the pack is too heavy.
  if (mods.sinks && !mods.waterWalk) rise = -1;
  let dy;
  if (rise !== 0) dy = rise * speed * 0.8 * dt;
  else dy = Math.max(-1, Math.min(1, rest - body.y)) * Math.min(1, dt * 1.5); // drift back to the surface
  if (body.y + dy > top && rise >= 0) dy = Math.max(0, top - body.y);
  stepVertical(world, body, dy, height);
  if (floor !== null && body.y < floor) body.y = floor;
  if (mods.waterWalk && body.y >= waterY) {
    body.mode = 'ground'; body.vy = 0;
    events.push({ kind: 'swim', stop: true });
  }
  events.push({ kind: 'exert', fatigue: LOCO.swimFatigue * mods.exertion * dt, skill: 'Swimming', seconds: dt });
}

function stepVertical(world, body, dy, height) {
  if (!dy || !world) { body.y += dy || 0; return; }
  const ny = body.y + dy;
  if (dy > 0 && !world.fits(body.x, body.z, ny, { height })) {
    const { x, y, z } = body;
    // A sloped floor can overlap the rim of the body at its centre floor. Allow a rise out of
    // that existing contact only while the upper body has clearance at both ends.
    if (world.fits(x, z, y, { height }) || !onlyBottomContact(world, x, z, y, height)
      || !world.fits(x, z, ny, { height, step: world.player.step })) return;
  }
  if (dy < 0) {
    const floor = world.floorBelow(body.x, body.z, body.y);
    if (floor !== null && ny < floor) { body.y = floor; return; }
  }
  body.y = ny;
}

function onlyBottomContact(world, x, z, y, height) {
  const floor = world.floorBelow(x, z, y);
  const step = world.player.step;
  return floor !== null && y - floor <= step && world.fits(x, z, y, { height, step });
}

/** Compact public view of a body for snapshots (`state.players[]`). Ground walkers omit `stance`. */
export function publicBody(body) {
  if (!body || !Number.isFinite(body.y)) return {};
  const out = { y: Math.round(body.y * 1000) / 1000 };
  const stance = body.mode !== 'ground' ? body.mode : body.crouch ? 'crouch' : body.running ? 'run' : body.slow ? 'slow' : null;
  if (stance) out.stance = stance;
  // Horizontal speed actually covered (m/s): combat's stealth reads the real movement magnitude.
  if (body.moving) out.speed = Math.round(body.speed * 100) / 100;
  return out;
}
