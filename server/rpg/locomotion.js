// Locomotion consequences and modifiers (package 4: movement and activation).
//
// The body itself is stepped by server/rpg/collision.js with the shared rule in
// client/lib/locomotion.js. This feature supplies that rule's modifiers from other owners and turns
// its events into consequences:
//   - fatigue for running, swimming, climbing and jumping (services.spendFatigue, character owner)
//   - skill practice for Running, Swimming, Climbing and Jumping, tallied only from real activity
//   - falling and drowning damage (services.damagePlayer)
//   - player notices ({kind:'locomotion', ...}) for the HUD
//
// Services provided:
//   locomotionMods(p) -> modifiers for client/lib/locomotion.js normalizeMods
//   locomotionEvents(p, events, body)   called by collision.stepPlayer
//   isSwimming(p) -> bool               (conditional health regeneration, package 11)
//   locomotion.stateOf(p) -> {mode, crouch, running, slow, speed, y, underwater, breath, maxBreath} | null
//   locomotion.onActivity(fn)           fn(p, event, body) for every locomotion event (crime, combat, magic hooks)
//
// Services consumed (all optional): skillValue, effectiveAttribute / attributeValue, characterOf,
// magicStatus (levitating, slowfall, jumping, climbing, waterWalking, waterBreathing, paralyzed),
// characterTraversal (package 11), encumbrance (inventory swimming weight), encumbranceSpeed, mount.

import { maxBreath, normalizeMods } from '../../client/lib/locomotion.js';

export const name = 'locomotion';

/** Seconds of continuous activity per skill practice tally (approximation of classic per-activity tallies). */
export const PRACTICE_SECONDS = Object.freeze({ Running: 5, Swimming: 5, Climbing: 3 });

export function install(ctx) {
  const S = ctx.services;
  const live = new WeakMap(); // player -> {fatigue: fractional debt, practice: {skill: seconds}}
  const listeners = [];

  const liveOf = (p) => {
    let l = live.get(p);
    if (!l) live.set(p, (l = { fatigue: 0, practice: {} }));
    return l;
  };

  function attribute(p, key) {
    const v = S.effectiveAttribute?.(p, key);
    if (Number.isFinite(v)) return v;
    const a = S.attributeValue?.(p, key);
    return Number.isFinite(a) ? a : undefined;
  }

  function locomotionMods(p) {
    const status = (typeof S.magicStatus === 'function' ? S.magicStatus(p) : null) ?? {};
    const trav = (typeof S.characterTraversal === 'function' ? S.characterTraversal(p) : null) ?? {};
    const ch = S.characterOf?.(p) ?? p.rpg?.character ?? null;
    const skill = (name) => {
      const v = S.skillValue?.(p, name);
      return Number.isFinite(v) ? v : ch?.skills?.[name] ?? 0;
    };
    let encumbrance;
    try { encumbrance = S.encumbranceSpeed?.(p); } catch { encumbrance = undefined; }
    return {
      running: skill('Running'),
      jumping: skill('Jumping'),
      climbing: skill('Climbing'),
      swimming: skill('Swimming'),
      endurance: attribute(p, 'Endurance'),
      fatigue: Number.isFinite(ch?.fatigue) ? ch.fatigue : undefined,
      levitate: !!status.levitating,
      slowfall: !!status.slowfall,
      jumpSpell: !!status.jumping,
      climbSpell: !!status.climbing,
      waterWalk: !!status.waterWalking,
      waterBreath: !!status.waterBreathing,
      paralyzed: !!status.paralyzed,
      encumbrance,
      sinks: !!S.encumbrance?.(p)?.sinks,
      climbingBonus: trav.climbingBonus,
      swimmingBonus: trav.swimmingBonus,
      exertion: trav.exertionMultiplier,
      jumpScale: trav.jumpMultiplier,
      breathScale: S.guildBreathScale?.(p), // package 15: Temple of Kynareth
    };
  }

  function spendFatigue(p, amount) {
    const l = liveOf(p);
    l.fatigue += amount;
    const whole = Math.floor(l.fatigue);
    if (whole <= 0) return;
    l.fatigue -= whole;
    if (typeof S.spendFatigue === 'function') S.spendFatigue(p, whole);
  }

  function practise(p, skill, seconds) {
    const l = liveOf(p);
    const need = PRACTICE_SECONDS[skill];
    if (!need) return;
    l.practice[skill] = (l.practice[skill] ?? 0) + seconds;
    while (l.practice[skill] >= need) {
      l.practice[skill] -= need;
      S.advanceSkill?.(p, skill, 1);
    }
  }

  function hurt(p, damage, source) {
    if (!(damage > 0)) return null;
    return typeof S.damagePlayer === 'function' ? S.damagePlayer(p, damage, source) : null;
  }

  function locomotionEvents(p, events, body) {
    for (const ev of events) {
      switch (ev.kind) {
        case 'exert':
          if (ev.fatigue > 0) spendFatigue(p, ev.fatigue);
          if (ev.skill) practise(p, ev.skill, ev.seconds ?? 0);
          break;
        case 'jump':
          if (ev.fatigue > 0) spendFatigue(p, ev.fatigue);
          S.advanceSkill?.(p, 'Jumping', 1);
          break;
        case 'land':
          if (ev.damage > 0) {
            const r = hurt(p, ev.damage, { kind: 'fall', distance: ev.fall });
            ctx.notify(p, { kind: 'locomotion', event: 'fall', damage: ev.damage, distance: Math.round(ev.fall * 10) / 10, text: r?.dead ? 'You fell to your death.' : `You fall ${Math.round(ev.fall)} m and take ${ev.damage} damage.` });
          }
          break;
        case 'drown': {
          const r = hurt(p, ev.damage, { kind: 'drowning' });
          ctx.notify(p, { kind: 'locomotion', event: 'drown', damage: ev.damage, text: r?.dead ? 'You drowned.' : 'You are drowning!' });
          break;
        }
        case 'submerge':
          ctx.notify(p, { kind: 'locomotion', event: 'submerge', breath: body?.breath, text: 'You dive under the water.' });
          break;
        case 'climb':
          if (ev.start) ctx.notify(p, { kind: 'locomotion', event: 'climb', text: 'You start climbing.' });
          break;
        default:
          break;
      }
      for (const fn of listeners) {
        try { fn(p, ev, body); } catch (err) { (ctx.log ?? console).error?.('[locomotion] activity hook failed:', err.message); }
      }
    }
  }

  function stateOf(p) {
    const b = S.collision?.bodyOf?.(p);
    if (!b) return null;
    const mods = normalizeMods(locomotionMods(p));
    return {
      mode: b.mode, crouch: b.crouch, running: b.running, slow: b.slow, speed: b.speed, y: b.y,
      underwater: b.underwater, breath: b.breath, maxBreath: maxBreath(mods),
    };
  }

  S.locomotionMods = locomotionMods;
  S.locomotionEvents = locomotionEvents;
  S.isSwimming = (p) => S.collision?.bodyOf?.(p)?.mode === 'swim';
  S.locomotion = {
    stateOf,
    onActivity: (fn) => {
      if (typeof fn === 'function') listeners.push(fn);
    },
  };

  ctx.onLeave?.((p) => live.delete(p));
}
