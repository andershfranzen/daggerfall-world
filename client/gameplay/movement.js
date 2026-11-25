// Browser side of the shared locomotion rule (client/lib/locomotion.js): the modifiers the server
// derives for this player (server/rpg/locomotion.js locomotionMods), rebuilt from the player's own
// `state` snapshot so prediction matches, and the per-frame `api.movement` view other features read
// (package 21: underwater view, footsteps and landing sounds; combat: stealth display).
// DOM-free so it can be unit tested in Node.

import { statsOf } from './api.js';
import { eyeHeight, maxBreath, normalizeMods } from '../lib/locomotion.js';
import { breathScale } from './guilds/perks.js';

/** Statuses on the local player from its active spell effects (rpg.magic.active[].status). */
export function activeStatuses(state) {
  const rpg = state?.character && typeof state.character === 'object' ? state.character : null;
  const active = rpg?.magic?.active ?? state?.magic?.active;
  const out = new Set();
  if (Array.isArray(active)) for (const a of active) if (a && typeof a.status === 'string' && !(a.roundsLeft <= 0)) out.add(a.status);
  return out;
}

/** Locomotion modifiers for the local body; `baseSpeed` is the mount feature's ground speed, if any. */
export function movementMods(state, { baseSpeed, traversal } = {}) {
  const mount = Number.isFinite(baseSpeed) && baseSpeed > 0 ? { baseSpeed, mounted: true } : {};
  if (state?.locomotion) return normalizeMods({ ...state.locomotion, ...mount });
  const ch = statsOf(state);
  const skills = ch?.skills ?? {};
  const attrs = ch?.attributes ?? {};
  const st = activeStatuses(state);
  const t = traversal ?? ch?.traversal ?? {};
  return normalizeMods({
    ...mount,
    running: skills.Running,
    jumping: skills.Jumping,
    climbing: skills.Climbing,
    swimming: skills.Swimming,
    endurance: ch?.effectiveAttributes?.Endurance ?? attrs.Endurance, // package 11: effective value when changed
    fatigue: Number.isFinite(ch?.fatigue) ? ch.fatigue : undefined,
    levitate: st.has('levitating'),
    slowfall: st.has('slowfall'),
    jumpSpell: st.has('jumping'),
    climbSpell: st.has('climbing'),
    waterWalk: st.has('waterWalking'),
    waterBreath: st.has('waterBreathing'),
    paralyzed: st.has('paralyzed'),
    climbingBonus: t.climbingBonus,
    swimmingBonus: t.swimmingBonus,
    exertion: t.exertionMultiplier,
    jumpScale: t.jumpMultiplier,
    breathScale: breathScale(ch?.guilds ?? (state?.character && typeof state.character === 'object' ? state.character.guilds : null)),
  });
}

/** Private RPG snapshots carry the server's remaining breath for a saved swimmer in this location. */
export function syncSwimBreath(body, portal, location) {
  if (portal?.swimming === true && portal.to === location && Number.isFinite(portal.breath)) {
    body.breath = Math.max(0, portal.breath);
  }
}

/** The `api.movement` view of a body in a world (null world: no water). */
export function movementView(body, world, mods) {
  const waterY = world?.waterAt ? world.waterAt(body.x, body.z) : null;
  const underwater = waterY !== null && body.y + eyeHeight(body) < waterY;
  const swimming = body.mode === 'swim';
  return {
    x: body.x,
    z: body.z,
    mode: body.mode,
    grounded: body.mode === 'ground',
    swimming,
    underwater,
    climbing: body.mode === 'climb',
    levitating: body.mode === 'levitate',
    crouch: !!body.crouch,
    running: !!body.running,
    slow: !!body.slow,
    speed: body.speed ?? 0,
    y: body.y,
    breath: body.breath,
    maxBreath: maxBreath(mods),
    waterBreathing: mods.waterBreath,
    lowBreath: body.breath < Math.floor(mods.endurance / 8) + 4, // HUDBreathBar.UpdateBreathBar
    ...(swimming || underwater || (waterY !== null && body.y < waterY) ? { surface: 'water' } : {}),
  };
}

/** Body mode a replicated stance stands for (client/lib/locomotion.js publicBody). */
export function modeOfStance(stance) {
  return stance === 'air' || stance === 'climb' || stance === 'swim' || stance === 'levitate' ? stance : 'ground';
}
