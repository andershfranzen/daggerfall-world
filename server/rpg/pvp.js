// Land PvP Feature (docs/multiplayer-feature-plan.md §4).
//
// Combines:
//   - Unified PvP eligibility policy (server/rpg/pvp/policy.js)
//   - Consent Duels (server/rpg/pvp/duels.js)
//   - Ranked & Practice 1v1 Arena (server/rpg/pvp/arena.js)
//   - Open PvP District (server/rpg/pvp/district.js)
//   - Scheduled Order Sieges (server/rpg/pvp/siege.js)
//
// Exports `install(ctx, options)` for Wave 2B wiring into server/rpg/runtime.js.

import { PVP_DEFAULTS, createDurableHelper, createPvpPolicy } from './pvp/policy.js';
import { createDuelsManager } from './pvp/duels.js';
import { createArenaManager } from './pvp/arena.js';
import { createDistrictManager } from './pvp/district.js';
import { createSiegeManager } from './pvp/siege.js';

export const name = 'pvp';
export { PVP_DEFAULTS };

export function install(ctx, options = {}) {
  const cfg = { ...PVP_DEFAULTS, ...(ctx.config?.pvp ?? {}), ...options };
  const S = (ctx.services ||= {});
  const durable = createDurableHelper(ctx);
  const pendingRestores = new Map(); // playerId -> { reason, vitals?, returnPoint? }

  function notifyPvp(p, event) {
    if (!p || !ctx.notify) return;
    ctx.notify(p, event);
  }

  function relocatePlayer(p, landing) {
    if (!p || !landing) return;
    if (typeof S.portals?.transfer === 'function') {
      try {
        S.portals.transfer(p, landing, { label: landing.location });
        return;
      } catch {
        // Fallback to direct relocation when portals registry doesn't know synthetic arena/pvp/siege scenes
      }
    }
    const from = ctx.location?.(p) ?? p.rpg?.location;
    ctx.dirty?.(p);
    p.rpg ??= {};
    p.rpg.location = landing.location;
    if (Number.isFinite(landing.x)) p.x = landing.x;
    if (Number.isFinite(landing.z)) p.z = landing.z;
    if (Number.isFinite(landing.yaw)) p.yaw = landing.yaw;
    p.moving = false;
    p.dirty = true;
    notifyPvp(p, { kind: 'teleport', location: landing.location, x: p.x, z: p.z, yaw: p.yaw ?? 0, silent: true });
    if (from !== landing.location) {
      ctx.emit?.('locationChanged', { player: p, from, to: landing.location });
    }
  }

  let duels;
  let arena;
  let district;
  let siege;

  function stateFor(p) {
    return {
      duel: duels.stateFor(p),
      arena: arena.stateFor(p),
      district: district.stateFor(p),
      siege: siege.stateFor(p),
    };
  }

  function pushState(p) {
    if (!p || ctx.players.get(p.id) !== p) return;
    notifyPvp(p, { kind: 'pvp.state', silent: true, state: stateFor(p) });
  }

  function isInAnyMatch(playerId) {
    const p = ctx.players.get(playerId);
    if (!p) return false;
    return !!(duels.engagementOf(p) || arena.engagementOf(p) || siege.engagementOf(p));
  }

  const shared = {
    durable,
    notifyPvp,
    pushState,
    relocatePlayer,
    isInAnyMatch,
    storePendingRestore: (pid, rec) => pendingRestores.set(pid, rec),
  };

  duels = createDuelsManager(ctx, cfg, shared);
  arena = createArenaManager(ctx, cfg, shared);
  district = createDistrictManager(ctx, cfg, shared);
  siege = createSiegeManager(ctx, cfg, shared);

  const policy = createPvpPolicy(ctx, cfg, {
    duels,
    arena,
    district,
    siege,
    respawnProtectionUntil: (p) => Math.max(
      district.respawnProtectionUntilOf(p),
      siege.respawnProtectionUntilOf(p),
    ),
  });

  // ------------------------------------------------------------------ combat & damage integration hooks

  function resolvePlayerAttacker(source) {
    if (!source) return null;
    if (ctx.players.get(source.id) === source) return source;
    if (source.kind === 'reflected' && source.player && ctx.players.get(source.player.id) === source.player) {
      return source.player;
    }
    if (source._ally != null) return ctx.players.get(source._ally) ?? null;
    return null;
  }

  /**
   * Called by `server/rpg/combat.js` before applying damage to a player.
   * Returns `{ blocked?, amount?, floorHp?, onNonLethal? }`.
   */
  function onPlayerDamage(defender, amount, source, cause = 'melee') {
    const attacker = resolvePlayerAttacker(source);
    if (!attacker || attacker === defender) {
      return { blocked: false, amount };
    }

    const kind = cause === 'spell' ? 'spell' : cause === 'dot' ? 'dot' : cause === 'arrow' ? 'arrow' : source?._ally != null ? 'pet' : 'melee';
    const elig = policy.canPlayerHarmPlayer(attacker, defender, { kind });
    if (!elig.allowed) {
      return { blocked: true, amount: 0, reason: elig.reason };
    }

    // Apply Open PvP District combat-tag on both fighters
    if (elig.mode === 'district') {
      district.onCombatInteraction(attacker, defender);
    }

    const scaled = policy.scaleDamage(amount, attacker, defender, { kind });

    // Consent Duels always end non-lethally at 1 HP (no death penalty or item loss)
    if (elig.mode === 'duel') {
      return {
        blocked: false,
        amount: scaled,
        floorHp: 1,
        mode: 'duel',
        onNonLethal: () => duels.onNonLethalFinish(defender, attacker),
      };
    }

    return { blocked: false, amount: scaled, mode: elig.mode };
  }

  /**
   * Called by `server/rpg/combat.js` when a player reaches 0 HP from a PvP source.
   * Returns `true` if PvP handled the defeat (custom respawn/match completion), `false` to run default PvE defeat.
   */
  function onPlayerDefeat(defender, source) {
    const attacker = resolvePlayerAttacker(source);
    if (arena.onFighterDefeated(defender, attacker)) return true;
    if (siege.onPlayerDefeated(defender, attacker)) return true;
    if (district.onPlayerDefeated(defender, attacker)) return true;
    return false;
  }

  function onPlayerHelp(caster, target) {
    if (caster && target && caster !== target) {
      district.onHelpfulInteraction(caster, target);
    }
  }

  function travelBlocker(p) {
    if (!p) return null;
    if (duels.engagementOf(p)) return 'You cannot travel during an active duel.';
    if (arena.engagementOf(p)) return 'You cannot travel during an arena match.';
    if (siege.engagementOf(p)) return 'Leave the siege battle before travelling.';
    const tagLeft = district.combatTagRemainingMs(p.id);
    if (tagLeft > 0) return `You are PvP combat-tagged (${Math.ceil(tagLeft / 1000)}s remaining).`;
    return null;
  }

  function isInventoryLocked(p) {
    return duels.isInventoryLocked(p);
  }

  function checkConsumableAllowance(p) {
    const d = duels.checkConsumableAllowance(p);
    if (!d.allowed) return d;
    return arena.checkConsumableAllowance(p);
  }

  // ------------------------------------------------------------------ chain shared runtime services

  const prevPresenceScope = S.presenceScope;
  S.presenceScope = (p) => {
    const arenaScope = arena.presenceScopeOf(p);
    if (arenaScope) return arenaScope;
    const siegeScope = siege.presenceScopeOf(p);
    if (siegeScope) return siegeScope;
    return prevPresenceScope?.(p) ?? null;
  };

  if (S.preventTravel instanceof Map) S.preventTravel.set('pvp', travelBlocker);
  else S.preventTravel = new Map([['pvp', travelBlocker]]);

  if (S.preventRest instanceof Map) S.preventRest.set('pvp', travelBlocker);
  else S.preventRest = new Map([['pvp', travelBlocker]]);

  // Register archive & slot-switch blockers on `ctx.services.characterBlockers`
  if (!Array.isArray(S.characterBlockers)) S.characterBlockers = [];
  S.characterBlockers.push((_accountId, characterId, _kind) => {
    const id = Number(characterId);
    const out = [];
    const db = duels.blockerFor(id);
    if (db) out.push(db);
    const ab = arena.blockerFor(id);
    if (ab) out.push(ab);
    const sb = siege.blockerFor(id);
    if (sb) out.push(sb);
    const distb = district.blockerFor(id);
    if (distb) out.push(distb);
    return out;
  });

  // Register cleanup on `ctx.services.onCharacterPurge`
  if (!Array.isArray(S.onCharacterPurge)) S.onCharacterPurge = [];
  S.onCharacterPurge.push(({ characterId } = {}) => {
    const id = Number(characterId);
    if (!Number.isSafeInteger(id)) return;
    pendingRestores.delete(id);
    duels.onPurge(id);
    arena.onPurge(id);
    district.onPurge(id);
    siege.onPurge(id);
  });

  // ------------------------------------------------------------------ actions

  ctx.onAction('pvp.status', (p) => {
    const st = stateFor(p);
    pushState(p);
    return st;
  });

  // Consent Duels
  ctx.onAction('pvp.duel.invite', (p, args) => duels.invite(p, args));
  ctx.onAction('pvp.duel.accept', (p, args) => duels.accept(p, args));
  ctx.onAction('pvp.duel.decline', (p, args) => duels.decline(p, args));
  ctx.onAction('pvp.duel.forfeit', (p) => duels.forfeit(p));

  // Ranked / Practice 1v1 Arena
  ctx.onAction('pvp.arena.queue', (p, args) => arena.joinQueue(p, args));
  ctx.onAction('pvp.arena.dequeue', (p) => arena.leaveQueue(p));
  ctx.onAction('pvp.arena.accept', (p, args) => arena.acceptMatch(p, args));
  ctx.onAction('pvp.arena.decline', (p) => arena.declineMatch(p));
  ctx.onAction('pvp.arena.forfeit', (p) => arena.forfeit(p));
  ctx.onAction('pvp.arena.spectate', (p, args) => arena.spectate(p, args));
  ctx.onAction('pvp.arena.leaveSpectate', (p) => arena.leaveSpectate(p));
  ctx.onAction('pvp.arena.leaderboard', (p, args) => {
    const board = arena.leaderboard(Number(args?.limit) || 20);
    notifyPvp(p, { kind: 'pvp.arenaLeaderboard', leaderboard: board, silent: true });
    return board;
  });

  // Open PvP District
  ctx.onAction('pvp.district.enter', (p, args) => district.enter(p, args));
  ctx.onAction('pvp.district.exit', (p) => district.exit(p));
  ctx.onAction('pvp.district.status', (p) => {
    const st = district.stateFor(p);
    notifyPvp(p, { kind: 'pvp.districtStatus', district: st, silent: true });
    return st;
  });

  // Order Sieges
  ctx.onAction('pvp.siege.status', (p) => {
    const st = siege.stateFor(p);
    notifyPvp(p, { kind: 'pvp.siegeStatus', siege: st, silent: true });
    return st;
  });
  ctx.onAction('pvp.siege.schedule', (p, args) => siege.schedule(p, args));
  ctx.onAction('pvp.siege.register', (p, args) => siege.register(p, args));
  ctx.onAction('pvp.siege.enter', (p, args) => siege.enter(p, args));
  ctx.onAction('pvp.siege.leave', (p) => siege.leave(p));

  // ------------------------------------------------------------------ lifecycle & tick

  ctx.onJoin((p) => {
    const pend = pendingRestores.get(p.id);
    if (pend) {
      pendingRestores.delete(p.id);
      if (pend.vitals) {
        const c = p.rpg?.character;
        if (c && Number.isFinite(pend.vitals.health)) c.health = Math.max(1, Math.min(c.maxHealth ?? pend.vitals.maxHealth, pend.vitals.health));
        delete p.rpg?.pvpDuelLock;
      }
      if (pend.returnPoint) relocatePlayer(p, pend.returnPoint);
      ctx.dirty?.(p);
      notifyPvp(p, { kind: 'pvp.restored', text: pend.reason || 'Your PvP state has been restored.' });
    }
    duels.onJoin(p);
    arena.onJoin(p);
    district.onJoin(p);
    siege.onJoin(p);
    pushState(p);
  });

  ctx.onLeave((p) => {
    duels.onLeave(p);
    arena.onLeave(p);
    district.onLeave(p);
    siege.onLeave(p);
  });

  ctx.onTick((dt, now) => {
    duels.tick(dt, now);
    arena.tick(dt, now);
    district.tick(dt, now);
    siege.tick(dt, now);
  });

  // ------------------------------------------------------------------ public service API

  const api = {
    cfg,
    canPlayerHarmPlayer: (attacker, defender, opts) => policy.canPlayerHarmPlayer(attacker, defender, opts),
    canPlayerHelpPlayer: (caster, target, opts) => policy.canPlayerHelpPlayer(caster, target, opts),
    captureProjectileContext: (actor) => policy.captureProjectileContext(actor),
    scaleDamage: (raw, attacker, defender, opts) => policy.scaleDamage(raw, attacker, defender, opts),
    scaleHeal: (raw, caster, target) => policy.scaleHeal(raw, caster, target),
    isLegalPvpCrimeSuppressed: (player, crime, opts) => policy.isLegalPvpCrimeSuppressed(player, crime, opts),
    isUnpolicedScene: (location) => policy.isUnpolicedScene(location),
    onPlayerDamage,
    onPlayerDefeat,
    onPlayerHelp,
    travelBlocker,
    isInventoryLocked,
    checkConsumableAllowance,
    isInCombat: (p) => !!(p && (policy.getPlayerEngagement(p) || district.isCombatTagged(p.id))),
    engagementOf: (p) => policy.getPlayerEngagement(p),
    stateFor,
    flushDurable: () => durable.flush(),
    duels,
    arena,
    district,
    siege,
  };

  S.pvp = api;
  // Also expose top-level helpers on ctx.services per §4 unified policy contract
  S.canPlayerHarmPlayer = api.canPlayerHarmPlayer;
  S.canPlayerHelpPlayer = api.canPlayerHelpPlayer;

  return api;
}

export default install;
