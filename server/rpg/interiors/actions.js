// Shared dungeon mechanisms: authored RDB actions, triggers and door locks for every player in one instance.
//
// The executor follows Daggerfall Unity's Internal/DaggerfallAction.cs, DaggerfallActionDoor.cs and
// DaggerfallActionCollision.cs (MIT, (c) 2009-2023 Daggerfall Workshop, revision 3d85a28). Opcode data and
// formulas live in client/world/interiors/dungeonActions.js so Play and the audit read the same rules.
//
// Actions
//   dungeon.use    {id}         direct activation (doors, switches, text, transports, the Mantella)
//   dungeon.pick   {id}         pick a locked door (classic Steal mode on a door)
//   dungeon.answer {id, text}   reply to an opcode 12 prompt that was shown to this player
//   dungeon.sync   {}           resend the shared state
// Triggers handled here: direct, walk-on and walk-into contact while the player moves, weapon swings (attack
// trigger and door bashing, through the combat 'swing' event) and door toggles.
// Services
//   ctx.services.dungeonLocks  {lockOf(location,id), isOpen(location,id), pick(p,id), bash(p,id),
//                               unlock(p,id,{method}), lock(p,id,value), doorOnLine(location,x1,y1,z1,x2,y2,z2),
//                               enemyOpen(location,id), enemyBash(location,id)} — the one lock ledger for RDB doors.
// Consumed (all optional): takeDoorMagic(p) -> {operation:'open'|'lock', level}|null (package 9),
//   objectCast(source, spellIndex, player, {level}) (package 9), conditionExposure(p, {...}) (package 10),
//   hurtPlayerBy / damagePlayer, advanceSkill, skillValue.
// Events
//   gameEvent dungeonState {location, active, locks}     shared poses and lock values, to occupants
//   gameEvent dungeonText  {id, record, label}            TEXT.RSC record for this player (client reads its files)
//   gameEvent dungeonPrompt {id, record}                  opcode 12 prompt for this player
//   gameEvent dungeonHazard {id, pool, amount, kind}      trap feedback for this player
//   gameEvent dungeonCue {id, cue, x, z}                  'unlock' | 'lock' | 'bash' | 'trap' sound cues, to occupants
//   ctx.emit('dungeonTrespass', {player, location, id, reason}), ctx.emit('dungeonSpell', {...}) without objectCast,
//   ctx.emit('questGlobal', {player, index, value}) for opcode 31.

import {
  OP, CAUSE, MAGIC_LOCK, accepts, collisionTrigger, directAction, doorTextRecord, hazardAmount, mechanismLabel,
  mechanismAimPoints, mechanismBounds, opcodeFamily, answerMatches, textInputRecord, trespass, SPELL_COOLDOWN, TEXT_BASE, triggerFlag, TRIGGER,
} from '../../../client/world/interiors/dungeonActions.js';
import { parseLocation } from '../../../client/world/interiors/index.js';

export const RESET_GRACE_MS = 5 * 60_000;
const REACH = 2.6;
const MELEE_REACH = 2.6;
const MELEE_ARC = Math.PI / 3;
const EYE = 1.6;
const BODY = 1.8;
const RADIUS = 0.35;
const DAGGERFALL_CASTLE = 'dungeon:Daggerfall/Daggerfall';
const DAGGERFALL_TOWN = 'town:Daggerfall/Daggerfall';
const DAGGERFALL_FOYER_DOORS = ['0,0:22866', '0,0:22818'];
/**
 * Re-fire interval for damage, drain and spell contact while a player keeps moving in contact:
 * DaggerfallActionCollision.Timeout (0.12 s). The per-activation counters that DFU calibrated against classic
 * ("approximates classic based on observation": a spell every 22 activations, opcode 21 every 20) assume this cadence.
 */
export const HAZARD_REPEAT_MS = 120;
/** Doors opened by toggling accept these trigger flags for their own action (DaggerfallActionDoor.ExecuteActionOnToggle). */
const DOOR_TOGGLE_TRIGGERS = new Set([TRIGGER.DIRECT, TRIGGER.DIRECT6, TRIGGER.MULTI, TRIGGER.COLLISION9, TRIGGER.DOOR]);
const inDungeon = (location) => parseLocation(location)?.kind === 'dungeon';
const d100 = (random) => 1 + Math.floor(random() * 100);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const centre = (b) => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2];
const horizontalGap = (b, x, z) => Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minZ - z, 0, z - b.maxZ));

export function installDungeonActions(ctx, { source, graceMs = RESET_GRACE_MS, localTeleport, finishMantella, random = Math.random }) {
  const instances = new Map();
  const contacts = new WeakMap(); // player -> Map(id -> {cause, last})
  const lastPos = new WeakMap();
  const locationOf = ctx.location;
  const S = ctx.services;

  function state(location) {
    const s = instances.get(location);
    if (s?.emptySince != null && ctx.now() - s.emptySince >= graceMs) {
      instances.delete(location);
      return null;
    }
    return s;
  }

  function fresh() {
    return {
      open: new Set(), locks: new Map(), counts: new Map(), cooldowns: new Map(), busy: new Map(),
      seen: new Set(), picks: new Map(), prompts: new Map(), emptySince: null, mechanisms: null, bounds: new Map(),
    };
  }

  function prepare(s, scene) {
    s.mechanisms = new Map((scene.mechanisms ?? []).map((m) => [m.id, m]));
    for (const m of s.mechanisms.values()) {
      if (m.flat || !Number.isInteger(m.firstTriangle) || !(m.triangleCount > 0) || !scene.positions) continue;
      const base = mechanismBounds(scene.positions, m.firstTriangle * 9, (m.firstTriangle + m.triangleCount) * 9);
      const alt = m.alternate?.length && !m.door && !m.linkedDoor ? mechanismBounds(m.alternate) : null;
      s.bounds.set(m.id, { base, alt });
    }
  }

  function castleVisit(p, location) {
    const portal = p.rpg?.portal;
    if (location === DAGGERFALL_CASTLE && portal?.id === 'dungeon' && portal.to === location &&
        portal.from === DAGGERFALL_TOWN && portal.returnTo?.location === DAGGERFALL_TOWN) return portal;
    return null;
  }

  function rememberFoyer(p, location, s) {
    const portal = castleVisit(p, location);
    if (!portal || !DAGGERFALL_FOYER_DOORS.every((id) => s.locks.has(id))) return;
    ctx.dirty(p);
    portal.daggerfallFoyer = DAGGERFALL_FOYER_DOORS.map((id) => ({ id, open: s.open.has(id), lock: s.locks.get(id) }));
  }

  function restoreFoyer(p, location, s) {
    const portal = castleVisit(p, location);
    if (!portal || DAGGERFALL_FOYER_DOORS.some((id) => s.open.has(id) || s.locks.has(id))) return false;
    let doors = portal.daggerfallFoyer;
    if (doors === undefined) {
      // The only route into the court side of the authored entry block passes the guard's two doors.
      // Older saves preserve that landing but predate saved foyer state. The entrance is at x=50.075.
      if (!(p.x >= 0 && p.x < 44.8 && p.z >= -51.2 && p.z <= 0 &&
            portal.footY >= 25.6 && portal.footY <= 32.3)) return false;
      doors = DAGGERFALL_FOYER_DOORS.map((id) => ({ id, open: true, lock: 0 }));
    }
    if (!Array.isArray(doors) || doors.length !== DAGGERFALL_FOYER_DOORS.length ||
        !doors.every((door, i) => door?.id === DAGGERFALL_FOYER_DOORS[i] && typeof door.open === 'boolean' &&
          Number.isInteger(door.lock) && door.lock >= 0 && door.lock <= 255)) return false;
    for (const { id, open, lock } of doors) {
      if (open) s.open.add(id);
      s.locks.set(id, lock);
    }
    return true;
  }

  function occupy(p, location, { resume = false } = {}) {
    if (!inDungeon(location) || !source) return;
    let s = state(location);
    if (!s) {
      s = fresh();
      instances.set(location, s);
      Promise.resolve(source.scene(location)).then((scene) => prepare(s, scene))
        .catch((err) => ctx.log?.warn?.('[dungeon]', err.message));
    }
    s.emptySince = null;
    const restored = resume && restoreFoyer(p, location, s);
    rememberFoyer(p, location, s);
    if (restored) ctx.nearby(location, snapshot(location, s));
    else ctx.notify(p, snapshot(location, s));
  }

  function depart(p, location) {
    if (!inDungeon(location)) return;
    contacts.delete(p);
    const s = instances.get(location);
    if (s) rememberFoyer(p, location, s);
    s?.prompts.delete(p.id);
    if (s && s.emptySince == null && ![...ctx.players.values()].some((q) => q !== p && locationOf(q) === location)) {
      s.emptySince = ctx.now();
    }
  }

  const lockEntries = (s) => [...(s?.locks ?? [])].filter(([id, v]) => !s.mechanisms || v !== (s.mechanisms.get(id)?.lock ?? 0));
  const snapshot = (location, s) => ({ kind: 'dungeonState', location, active: [...(s?.open ?? [])], locks: Object.fromEntries(lockEntries(s)) });
  const foot = (p, world) => {
    const y = p.rpg.portal?.footY;
    return Number.isFinite(y) ? world.heightAt(p.x, p.z, y) : null;
  };
  const levelOf = (p) => Math.max(1, Math.trunc(p.rpg?.character?.level ?? 1) || 1);
  const skillOf = (p, name) => {
    const v = typeof S.skillValue === 'function' ? S.skillValue(p, name) : p.rpg?.character?.skills?.[name];
    return Number(typeof v === 'object' ? v?.value : v) || 0;
  };
  const boundsNow = (s, m, open = s.open) => {
    const b = s.bounds.get(m.id);
    return b ? (open.has(m.id) && b.alt ? b.alt : b.base) : null;
  };

  function reachable(p, m, world, reach = REACH) {
    const y = foot(p, world);
    if (y == null) return false;
    const own = (triangle) => world.mechanismAt?.(triangle) === m.id ||
      (triangle >= m.firstTriangle && triangle < m.firstTriangle + m.triangleCount);
    // Aim at the authored origin (a door's hinge) and at the middle of the object's resting geometry: wide doors in
    // deep frames are only visible through their middle.
    const b = instances.get(locationOf(p))?.bounds.get(m.id)?.base;
    return mechanismAimPoints(m, b).some(([tx, ty, tz]) => Math.hypot(p.x - tx, p.z - tz) <= reach &&
      Math.abs(y + EYE - ty) <= (m.door ? 1.25 : 1.8) &&
      // The object itself can fill the ray (a closed door or a lever in its other pose). Everything else blocks.
      world.segmentClear(p.x, y + EYE, p.z, tx, ty, tz, own));
  }

  /**
   * One transaction over the instance. `start(tx)` drives the activation through tx.receive / tx.toggleDoor.
   * State is copied, committed only if the obstruction checks pass, and restored by the runtime on rollback.
   */
  function transact(p, location, s, world, start) {
    const before = {
      open: s.open, locks: s.locks, counts: s.counts, cooldowns: s.cooldowns, busy: s.busy, seen: s.seen, picks: s.picks, prompts: s.prompts,
    };
    const open = new Set(s.open);
    const locks = new Map(s.locks);
    const counts = new Map(s.counts);
    const cooldowns = new Map(s.cooldowns);
    const busy = new Map(s.busy);
    const seen = new Set(s.seen);
    const picks = new Map(s.picks);
    const prompts = new Map(s.prompts);
    const now = ctx.now();
    const lock = (m) => locks.get(m.id) ?? m.lock ?? 0;
    const effects = [];
    const moved = [];
    const visited = new Set();
    let destination = null;
    let mantella = false;

    const playing = (m, depth = 0) => !!m && depth < 64 && ((busy.get(m.id) ?? 0) > now || playing(s.mechanisms.get(m.link), depth + 1));

    // DaggerfallAction.Receive / Play.
    function receive(m, cause) {
      if (!m?.action || visited.has(m.id)) return false;
      if (!accepts(m.action.trigger, cause)) return false;
      if (playing(m)) return false;
      visited.add(m.id);
      const count = (counts.get(m.id) ?? 0) + 1;
      counts.set(m.id, count);
      play(m, count);
      return true;
    }

    function play(m, count) {
      const { action } = m;
      // Play activates the next object before the delegate, except for the text-input prompt, which gates it.
      if (action.opcode !== OP.TEXT_INPUT) receive(s.mechanisms.get(m.link), CAUSE.CHAIN);
      switch (opcodeFamily(action.opcode)) {
        case 'motion':
          if (m.moving) {
            if (m.forwardOnly && open.has(m.id)) break;
            const opening = !open.has(m.id);
            if (opening) open.add(m.id); else open.delete(m.id);
            // RDBLayout.AddAction: opcodes 2-7 always take 50 ticks; DaggerfallAction.Duration is ActionDuration / 20 s.
            busy.set(m.id, now + (((action.opcode >= 2 && action.opcode <= 7) ? 50 : action.duration ?? 0) / 20) * 1000);
            moved.push({ m, opening });
          }
          break;
        case 'door':
          if (!(m.door || m.linkedDoor)) break;
          switch (action.opcode) {
            case OP.LOCK: if (!lock(m)) locks.set(m.id, 16); break;
            case OP.UNLOCK: locks.set(m.id, 0); break;
            case OP.OPEN: if (!open.has(m.id)) { locks.set(m.id, 0); open.add(m.id); } break;
            case OP.CLOSE: if (open.delete(m.id)) locks.set(m.id, m.lock ?? 0); break;
          }
          break;
        case 'teleport':
          if (m.destination) destination = m.destination;
          break;
        case 'global':
          if (m.mantella) mantella = true;
          else effects.push({ kind: 'global', index: action.axis });
          break;
        case 'text':
          effects.push({ kind: 'text', m, record: TEXT_BASE[OP.TEXT] + (action.index ?? 0) });
          break;
        case 'textInput':
          prompts.set(p.id, m.id);
          effects.push({ kind: 'prompt', m, record: textInputRecord(action) });
          break;
        case 'doorText': {
          const record = doorTextRecord(action);
          const key = `${p.id}|${m.id}`;
          if (record != null && !seen.has(key)) {
            seen.add(key);
            effects.push({ kind: 'text', m, record, top: true });
          } else if (trespass(action)) {
            effects.push({ kind: 'trespass', m, reason: 'doorText' });
          }
          break;
        }
        case 'damage': case 'magicka': {
          const hit = hazardAmount(action, { level: levelOf(p), count, random: (lo, hi) => lo + Math.floor(random() * (hi - lo)) });
          if (hit) effects.push({ kind: 'hazard', m, ...hit });
          break;
        }
        case 'spell': {
          const left = (cooldowns.get(m.id) ?? 0) - SPELL_COOLDOWN.step;
          if (left <= 0) {
            cooldowns.set(m.id, SPELL_COOLDOWN.reset);
            effects.push({ kind: 'spell', m, index: action.index ?? 0 });
          } else cooldowns.set(m.id, left);
          break;
        }
        case 'poison':
          effects.push({ kind: 'poison', m, index: action.index ?? 0 });
          break;
        default: break; // Activate, Dialogue (people flats talk through their own feature) and unexplained opcodes.
      }
    }

    // DaggerfallActionDoor.ToggleDoor(activatedByPlayer) for direct use, picking, bashing and Open.
    function toggleDoor(m, { ignoreLocks = false, byPlayer = true } = {}) {
      const action = m.action;
      const doorTextFirst = byPlayer && action?.opcode === OP.DOOR_TEXT && (action.index ?? 0) > 0 &&
        [TRIGGER.DOOR, TRIGGER.DIRECT, TRIGGER.MULTI].includes(triggerFlag(action.trigger)) && !open.has(m.id);
      if (doorTextFirst && doorTextRecord(action) != null && !seen.has(`${p.id}|${m.id}`)) {
        receiveOnToggle(m);
        return 'text';
      }
      if (!open.has(m.id)) {
        if (lock(m) && !ignoreLocks) throw new Error(lock(m) >= MAGIC_LOCK ? 'This is a magically held lock.' : 'The door is locked.');
        if (byPlayer) receiveOnToggle(m);
        open.add(m.id);
        locks.set(m.id, 0);
        return 'opened';
      }
      open.delete(m.id);
      if (byPlayer) receiveOnToggle(m);
      return 'closed';
    }
    function receiveOnToggle(m) {
      if (!m.action || visited.has(m.id) || !DOOR_TOGGLE_TRIGGERS.has(triggerFlag(m.action.trigger))) return;
      visited.add(m.id);
      const count = (counts.get(m.id) ?? 0) + 1;
      counts.set(m.id, count);
      // A door's own open/close opcode describes the toggle itself; its chain and side effects still run.
      if (opcodeFamily(m.action.opcode) === 'door') receive(s.mechanisms.get(m.link), CAUSE.CHAIN);
      else play(m, count);
    }

    const cues = [];
    const tx = { receive, toggleDoor, lock, locks, open, picks, prompts, effects, result: null, cue: (m, cue) => cues.push({ id: m.id, cue, sound: m.action?.index ?? 0, x: m.x, z: m.z }) };
    start(tx);

    // Riders on a platform move with it (translation only; rotating pieces are not carried).
    const riders = [];
    for (const { m, opening } of moved) {
      const b = s.bounds.get(m.id);
      if (!b?.base || !b.alt || ![1, 2, 3, 4, 5, 6, 7].includes(m.action.opcode)) continue;
      const from = opening ? b.base : b.alt, to = opening ? b.alt : b.base;
      const [ax, ay, az] = centre(from), [bx, by, bz] = centre(to);
      for (const q of ctx.players.values()) {
        if (locationOf(q) !== location || riders.some((r) => r.q === q)) continue;
        const y = foot(q, world);
        if (y == null || Math.abs(y - from.maxY) > 0.4 || horizontalGap(from, q.x, q.z) > RADIUS * 0.5) continue;
        riders.push({ q, x: q.x + bx - ax, y: y + by - ay, z: q.z + bz - az });
      }
    }

    const changed = [...before.open].some((id) => !open.has(id)) || [...open].some((id) => !before.open.has(id));
    const closing = [...before.open].some((id) => !open.has(id)) || [...open].some((id) => !before.open.has(id) && !s.mechanisms.get(id)?.door);
    const clear = closing ? [...ctx.players.values()].filter((q) => locationOf(q) === location && !riders.some((r) => r.q === q))
      .map((q) => [q, foot(q, world)]).filter(([q, y]) => y != null && world.isClear(q.x, q.z, y)) : [];
    Object.assign(s, { open, locks, counts, cooldowns, busy, seen, picks, prompts });
    const rollback = () => Object.assign(s, before);
    try {
      if (clear.some(([q, y]) => !world.isClear(q.x, q.z, y))) throw new Error('Someone is in the way.');
      for (const r of riders) {
        localTeleport(r.q, { x: r.x, y: r.y, z: r.z, yaw: r.q.yaw }, world);
        // The shared locomotion body keeps its own foot height: move it with the platform (package 4 contract).
        const body = S.collision?.bodyOf?.(r.q);
        if (body && Number.isFinite(r.q.rpg.portal?.footY)) body.y = r.q.rpg.portal.footY;
      }
      if (mantella) finishMantella(p);
      else if (destination) localTeleport(p, destination, world);
    } catch (err) {
      rollback();
      throw err;
    }
    ctx.onRollback(rollback);
    if (tx.result?.text) effects.push({ kind: 'note', m: tx.result.m ?? null, text: tx.result.text });
    deliver(p, location, effects);
    const locksChanged = [...locks].some(([id, v]) => before.locks.get(id) !== v);
    if (location === DAGGERFALL_CASTLE && DAGGERFALL_FOYER_DOORS.some((id) =>
      before.open.has(id) !== open.has(id) || before.locks.get(id) !== locks.get(id))) {
      for (const visitor of ctx.players.values()) {
        if (locationOf(visitor) === location) rememberFoyer(visitor, location, s);
      }
    }
    if (changed || locksChanged) ctx.nearby(location, snapshot(location, s));
    for (const e of effects) if (e.kind === 'hazard' || e.kind === 'spell' || e.kind === 'poison') cues.push({ id: e.m.id, cue: 'trap', sound: e.m.action?.index ?? 0, x: e.m.x, z: e.m.z });
    for (const c of cues) ctx.nearby(location, { kind: 'dungeonCue', ...c });
    return tx.result;
  }

  // Player-facing consequences after the state commits. Missing optional services degrade to events.
  function deliver(p, location, effects) {
    for (const e of effects) {
      try {
        switch (e.kind) {
          case 'note':
            ctx.notify(p, { kind: 'dungeonText', id: e.m?.id ?? null, record: null, text: e.text });
            break;
          case 'text':
            ctx.notify(p, { kind: 'dungeonText', id: e.m.id, record: e.record, label: mechanismLabel(e.m), top: !!e.top });
            break;
          case 'prompt':
            ctx.notify(p, { kind: 'dungeonPrompt', id: e.m.id, record: e.record });
            break;
          case 'global':
            ctx.emit('questGlobal', { player: p, index: e.index, value: true });
            break;
          case 'trespass':
            ctx.emit('dungeonTrespass', { player: p, location, id: e.m.id, reason: e.reason });
            break;
          case 'hazard': {
            let applied = 0;
            const c = p.rpg?.character;
            if (e.pool === 'health') {
              if (typeof S.hurtPlayerBy === 'function') applied = Number(S.hurtPlayerBy(p, e.amount, { kind: 'trap', id: e.m.id })) || 0;
              else if (typeof S.damagePlayer === 'function') { S.damagePlayer(p, e.amount, { kind: 'trap', id: e.m.id }); applied = e.amount; }
              else if (c && typeof c.health === 'number') { applied = Math.min(c.health, e.amount); c.health -= applied; }
            } else if (c && typeof c.magicka === 'number') {
              applied = Math.min(c.magicka, e.amount);
              c.magicka -= applied;
            }
            ctx.dirty(p);
            ctx.notify(p, { kind: 'dungeonHazard', id: e.m.id, pool: e.pool, amount: applied });
            break;
          }
          case 'spell': {
            const from = { id: `dungeon:${e.m.id}`, mechanism: { id: e.m.id, firstTriangle: e.m.firstTriangle, triangleCount: e.m.triangleCount },
              // A plate or wall that casts on contact is a trap; a clicked object keeps its prompt label.
              name: directAction(e.m.action?.trigger) ? mechanismLabel(e.m) : 'trap', location, x: e.m.x, y: e.m.y, z: e.m.z };
            if (typeof S.objectCast === 'function') S.objectCast(from, e.index, p, { level: levelOf(p) });
            else ctx.emit('dungeonSpell', { player: p, index: e.index, level: levelOf(p), source: from });
            ctx.notify(p, { kind: 'dungeonHazard', id: e.m.id, pool: 'spell', spell: e.index });
            break;
          }
          case 'poison': {
            // Opcode 26 has one installed record. DFU leaves the delegate empty ("Seems to poison"); the record's index
            // byte is read as the classic poison number, the same byte DFU uses for spell and text indices.
            const out = typeof S.conditionExposure === 'function' && e.index >= 0 && e.index <= 11
              ? S.conditionExposure(p, { source: null, delivery: 'trap', poison: e.index }) : null;
            ctx.notify(p, { kind: 'dungeonHazard', id: e.m.id, pool: 'poison', contracted: out?.contracted ?? [] });
            break;
          }
        }
      } catch (err) {
        ctx.log?.warn?.('[dungeon] effect', e.kind, err.message);
      }
    }
  }

  function context(p, id) {
    const location = locationOf(p);
    if (!inDungeon(location)) throw new Error('There is no dungeon mechanism here.');
    const s = state(location);
    const world = S.collision?.instanceWorld(location);
    if (!s?.mechanisms || !world) throw new Error('The dungeon is still loading.');
    const m = typeof id === 'string' ? s.mechanisms.get(id) : null;
    return { location, s, world, m };
  }

  // ---------------------------------------------------------------- doors and locks

  function useDoor(p, location, s, world, m) {
    return transact(p, location, s, world, (tx) => {
      // Open and Lock wait on the caster until an eligible door is activated (PlayerActivate.Handle{Lock,Open}Effect).
      const magic = typeof S.takeDoorMagic === 'function' ? S.takeDoorMagic(p) : null;
      const power = Math.max(1, Math.trunc(Number(magic?.level)) || 1);
      if (magic?.operation === 'lock') {
        if (tx.lock(m)) { tx.result = { text: 'This door is already locked.' }; return; }
        // Lock.TriggerLockEffect: lock at the caster's level, then close an open door (obstruction rules apply).
        if (tx.open.has(m.id)) tx.toggleDoor(m, { byPlayer: false });
        tx.locks.set(m.id, power);
        tx.cue(m, 'lock');
        tx.result = { text: 'The door is locked.' };
        return;
      }
      if (magic?.operation === 'open') {
        if (tx.lock(m) > power) {
          tx.result = { text: 'The lock resists your spell.' };
          return;
        }
        tx.locks.set(m.id, 0);
        if (!tx.open.has(m.id)) tx.toggleDoor(m, { ignoreLocks: true });
        tx.cue(m, 'unlock');
        tx.result = { text: 'The lock opens.' };
        return;
      }
      tx.toggleDoor(m);
    });
  }

  /** DaggerfallActionDoor.AttemptLockpicking with FormulaHelper.CalculateInteriorLockpickingChance. */
  function pick(p, id) {
    const { location, s, world, m } = context(p, id);
    if (!m?.door) throw new Error('There is no lock to pick there.');
    if (!reachable(p, m, world)) throw new Error('Door is out of reach.');
    return transact(p, location, s, world, (tx) => {
      if (tx.open.has(m.id) || !tx.lock(m)) { tx.result = { text: 'This door is not locked.' }; return; }
      const skill = skillOf(p, 'Lockpicking');
      const key = `${p.id}|${m.id}`;
      if (tx.picks.get(key) === skill) { tx.result = { text: 'You have already failed to pick this lock.', picked: false }; return; }
      if (tx.lock(m) >= MAGIC_LOCK) { tx.result = { text: 'This is a magically held lock.', picked: false }; return; }
      if (typeof S.advanceSkill === 'function') S.advanceSkill(p, 'Lockpicking', 1);
      const chance = clamp(5 * (levelOf(p) - tx.lock(m)) + skill, 5, 95);
      if (d100(random) > chance) {
        tx.picks.set(key, skill);
        tx.result = { text: 'You fail to pick the lock.', picked: false, chance };
        return;
      }
      tx.locks.set(m.id, 0);
      tx.toggleDoor(m, { ignoreLocks: true });
      tx.cue(m, 'unlock');
      tx.result = { text: 'You pick the lock.', picked: true, chance };
    });
  }

  /** DaggerfallActionDoor.AttemptBash: an open door is bashed shut; a closed one opens on d100 <= 20 - lock. */
  function bashIn(p, location, s, world, m) {
    return transact(p, location, s, world, (tx) => {
      tx.cue(m, 'bash');
      if (tx.open.has(m.id)) { tx.toggleDoor(m, { byPlayer: false }); tx.result = { bashed: 'closed' }; }
      else if (tx.lock(m) < MAGIC_LOCK && d100(random) <= 20 - tx.lock(m)) {
        tx.locks.set(m.id, 0);
        tx.toggleDoor(m, { ignoreLocks: true, byPlayer: false });
        tx.result = { bashed: 'opened' };
      } else tx.result = { bashed: 'held' };
      if (/^dungeon:[^/]+\/(castle|palace)/i.test(location)) tx.effects.push({ kind: 'trespass', m, reason: 'bash' });
    });
  }

  function bash(p, id) {
    const { location, s, world, m } = context(p, id);
    if (!m?.door) throw new Error('There is no door there.');
    if (!reachable(p, m, world, MELEE_REACH)) throw new Error('Door is out of reach.');
    return bashIn(p, location, s, world, m);
  }

  // ---------------------------------------------------------------- actions

  ctx.onAction('dungeon.use', (p, { id }) => {
    const { location, s, world, m } = context(p, id);
    if (!m || (!m.door && !directAction(m.action?.trigger))) throw new Error('That mechanism cannot be used directly.');
    if (!reachable(p, m, world)) throw new Error(`${mechanismLabel(m)} is out of reach.`);
    if (m.door) { useDoor(p, location, s, world, m); return; }
    transact(p, location, s, world, (tx) => {
      if (!tx.receive(m, CAUSE.DIRECT)) tx.result = { text: 'It is still moving.' };
    });
  });

  ctx.onAction('dungeon.pick', (p, { id }) => pick(p, id));

  ctx.onAction('dungeon.answer', (p, { id, text }) => {
    const { location, s, world, m } = context(p, id);
    if (!m || m.action?.opcode !== OP.TEXT_INPUT || s.prompts.get(p.id) !== m.id) throw new Error('Nobody is waiting for an answer.');
    if (typeof text !== 'string' || text.length > 40) throw new Error('That answer is too long.');
    if (!reachable(p, m, world, REACH + 1)) throw new Error(`${mechanismLabel(m)} is out of reach.`);
    return transact(p, location, s, world, (tx) => {
      tx.prompts.delete(p.id);
      // DaggerfallAction.UserInputHandler: a matching answer activates the next object; anything else does nothing.
      const right = answerMatches(m.action, text);
      if (right) tx.receive(s.mechanisms.get(m.link), CAUSE.CHAIN);
      if (!right) tx.result = { text: 'Nothing happens.' };
    });
  });

  ctx.onAction('dungeon.sync', (p) => {
    const location = locationOf(p);
    if (inDungeon(location)) ctx.notify(p, snapshot(location, state(location)));
  });

  // Weapon swings: doors are bashed and attack-triggered objects receive the hit (WeaponManager in DFU). A monster
  // nearer in the swing arc takes the blow instead, as the classic hit test stops at the first collider.
  ctx.on('swing', (ev) => {
    const p = ev?.player;
    const location = p && locationOf(p);
    if (ev.ranged || !inDungeon(location)) return;
    const s = state(location);
    const world = S.collision?.instanceWorld(location);
    if (!s?.mechanisms || !world) return;
    const facing = (x, z) => {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < 0.3) return true;
      let off = Math.atan2(x - p.x, -(z - p.z)) - (p.yaw ?? 0);
      off = Math.atan2(Math.sin(off), Math.cos(off));
      return Math.abs(off) <= MELEE_ARC;
    };
    let best = null, bestD = MELEE_REACH;
    for (const m of s.mechanisms.values()) {
      if (!m.door && !accepts(m.action?.trigger, CAUSE.ATTACK)) continue;
      const d = Math.hypot(m.x - p.x, m.z - p.z);
      if (d <= bestD && facing(m.x, m.z) && reachable(p, m, world, MELEE_REACH)) { best = m; bestD = d; }
    }
    if (!best) return;
    for (const e of ctx.entities?.values?.() ?? []) {
      const hidden = e.visibleTo != null && !(e.visibleTo instanceof Set ? e.visibleTo.has(p.id) : Array.isArray(e.visibleTo) && e.visibleTo.includes(p.id));
      if (e.kind === 'monster' && !e.dead && !hidden && e.location === location && Math.hypot(e.x - p.x, e.z - p.z) < bestD && facing(e.x, e.z)) return;
    }
    try {
      if (best.door) bashIn(p, location, s, world, best);
      else transact(p, location, s, world, (tx) => { tx.receive(best, CAUSE.ATTACK); });
    } catch (err) {
      ctx.notify(p, { kind: 'dungeonText', id: best.id, record: null, text: err.message });
    }
  });

  // Walk-on and walk-into contact. DaggerfallActionCollision only fires while the player is actively moving.
  ctx.onTick(() => {
    const occupants = new Set();
    for (const p of ctx.players.values()) {
      const location = locationOf(p);
      if (!inDungeon(location)) continue;
      occupants.add(location);
      const s = state(location);
      if (!s) { occupy(p, location); continue; }
      s.emptySince = null;
      if (!s.mechanisms) continue;
      const world = S.collision?.instanceWorld(location);
      if (!world) continue;
      const prev = lastPos.get(p);
      const moving = !prev || Math.hypot(p.x - prev.x, p.z - prev.z) > 1e-3 || prev.location !== location;
      lastPos.set(p, { x: p.x, z: p.z, location });
      const y = foot(p, world);
      const old = contacts.get(p) ?? new Map();
      const now = new Map();
      contacts.set(p, now);
      if (y == null) continue;
      for (const m of s.mechanisms.values()) {
        if (!collisionTrigger(m.action?.trigger)) continue;
        const cause = contactOf(s, m, p, y);
        if (!cause || !accepts(m.action.trigger, cause)) continue;
        const was = old.get(m.id);
        const t = ctx.now();
        const family = opcodeFamily(m.action.opcode);
        const repeats = family === 'damage' || family === 'magicka' || family === 'spell' || family === 'motion';
        now.set(m.id, { last: was?.last ?? t });
        if (was && (!moving || !repeats || t - was.last < (family === 'motion' ? 0 : HAZARD_REPEAT_MS))) continue;
        if (was && family === 'motion' && (s.busy.get(m.id) ?? 0) > t) continue;
        now.get(m.id).last = t;
        try { transact(p, location, s, world, (tx) => { tx.receive(m, cause); }); } catch { /* Active mechanisms can be obstructed. */ }
      }
    }
    for (const [location, s] of instances) {
      if (occupants.has(location)) continue;
      s.emptySince ??= ctx.now();
      state(location);
    }
  });

  /** Contact cause between a player standing at foot height y and a mechanism, or null. */
  function contactOf(s, m, p, y) {
    const b = boundsNow(s, m);
    if (b) {
      const gap = horizontalGap(b, p.x, p.z);
      if (gap <= 0.05 && Math.abs(y - b.maxY) <= 0.35) return CAUSE.WALK_ON;
      if (gap <= RADIUS + 0.1 && y < b.maxY - 0.35 && y + BODY > b.minY) return CAUSE.WALK_INTO;
      return null;
    }
    // Flats and objects without geometry: the authored point within a body width on the same floor.
    if (Math.abs(y - m.y) > (m.flat ? 1.2 : 0.85) || Math.hypot(p.x - m.x, p.z - m.z) > 0.6) return null;
    return triggerFlag(m.action.trigger) === TRIGGER.WALK_ON ? CAUSE.WALK_ON : CAUSE.WALK_INTO;
  }

  /** Closed RDB action doors are the only thing between two points: the first such door's id, else null. */
  function doorOnLine(location, x1, y1, z1, x2, y2, z2) {
    const s = state(location);
    const world = S.collision?.instanceWorld(location);
    if (!s?.mechanisms || !world) return null;
    let hit = null;
    const clear = world.segmentClear(x1, y1, z1, x2, y2, z2, (t) => {
      const id = world.mechanismAt?.(t);
      const m = id && s.mechanisms.get(id);
      if (!m?.door || s.open.has(id)) return false;
      hit ??= id;
      return true;
    });
    return clear ? hit : null;
  }

  /** DaggerfallActionDoor.ToggleDoor from an enemy: an unlocked closed door opens, without the player's door actions. */
  function enemyOpen(location, id) {
    const s = state(location);
    const m = s?.mechanisms?.get(id);
    if (!m?.door || s.open.has(id) || (s.locks.get(id) ?? m.lock ?? 0) > 0) return false;
    const before = s.open;
    s.open = new Set(s.open).add(id);
    ctx.onRollback?.(() => { s.open = before; });
    ctx.nearby(location, snapshot(location, s));
    return true;
  }

  /** DaggerfallActionDoor.AttemptBash(byPlayer: false) on a closed door: opens on d100 <= 20 - lock, never at >= 20. */
  function enemyBash(location, id, x = null, z = null) {
    const s = state(location);
    const m = s?.mechanisms?.get(id);
    if (!m?.door || s.open.has(id)) return false;
    const lock = s.locks.get(id) ?? m.lock ?? 0;
    ctx.nearby(location, { kind: 'dungeonCue', id, cue: 'bash', sound: m.action?.index ?? 0, x: x ?? m.x, z: z ?? m.z });
    if (lock >= MAGIC_LOCK || d100(random) > 20 - lock) return 'held';
    const before = { open: s.open, locks: s.locks };
    s.open = new Set(s.open).add(id);
    s.locks = new Map(s.locks).set(id, 0);
    ctx.onRollback?.(() => Object.assign(s, before));
    ctx.nearby(location, snapshot(location, s));
    return 'opened';
  }

  S.dungeonLocks = {
    doorOnLine,
    enemyOpen,
    enemyBash,
    lockOf: (location, id) => {
      const s = instances.get(location);
      const m = s?.mechanisms?.get(id);
      return m ? (s.locks.get(id) ?? m.lock ?? 0) : null;
    },
    isOpen: (location, id) => instances.get(location)?.open.has(id) ?? false,
    pick,
    bash,
    /** Quest keys and scripted unlocks: clears the lock without opening. */
    unlock(p, id, { method = 'key' } = {}) {
      const { location, s, world, m } = context(p, id);
      if (!m?.door) throw new Error('There is no lock there.');
      return transact(p, location, s, world, (tx) => { tx.locks.set(m.id, 0); tx.result = { method }; });
    },
    lock(p, id, value) {
      const { location, s, world, m } = context(p, id);
      if (!m?.door) throw new Error('There is no lock there.');
      const v = clamp(Math.trunc(Number(value)) || 0, 0, 255);
      return transact(p, location, s, world, (tx) => { tx.locks.set(m.id, v); });
    },
  };

  return {
    occupy,
    depart,
    active: (location, id) => instances.get(location)?.open.has(id) ?? false,
  };
}
