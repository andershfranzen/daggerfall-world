// Unified Land PvP eligibility policy, balance tuning, Elo math, and durable persistence helpers.
//
// Single authoritative policy consumed by server/rpg/combat.js, server/rpg/magic.js,
// server/rpg/law.js, and every Land PvP mode (duels, ranked arena, open district, order sieges).

export const PVP_DEFAULTS = Object.freeze({
  // Combat balance multipliers (leaves PvE formulas untouched)
  pvpDamageScale: 0.65,
  pvpHealScale: 0.75,
  pvpDotScale: 0.65,
  pvpMaxHitFraction: 0.45,
  pvpCcMaxRounds: 2,

  // Consent Duels
  duelInviteRange: 18,
  duelInviteTtlMs: 30_000,
  duelCountdownMs: 3_000,
  duelRingRadius: 18,
  duelOobGraceMs: 5_000,
  duelMaxDurationMs: 180_000,
  duelDisconnectGraceMs: 15_000,
  duelConsumableAllowance: 3,

  // Ranked 1v1 Arena
  arenaLocation: 'arena:Iliac/Grand Arena',
  arenaAcceptMs: 20_000,
  arenaCountdownMs: 5_000,
  arenaMaxDurationMs: 240_000,
  arenaDisconnectGraceMs: 20_000,
  arenaInitialElo: 1200,
  arenaKFactor: 32,
  arenaConsumableAllowance: 3,
  arenaRepeatPairCap: 3,
  arenaRepeatWindowMs: 24 * 60 * 60_000,
  arenaSpawnA: Object.freeze({ x: -10, z: 0, yaw: Math.PI / 2 }),
  arenaSpawnB: Object.freeze({ x: 10, z: 0, yaw: -Math.PI / 2 }),
  arenaSpectatorSpot: Object.freeze({ x: 0, z: -16, yaw: 0 }),

  // Open PvP District
  districtLocation: 'pvp:Iliac/Bloodmarket Ward',
  districtName: 'Bloodmarket Ward',
  districtSafeExitLocation: 'town:Daggerfall/Gothway Garden',
  districtSafeExitSpot: Object.freeze({ x: 0, z: 12, yaw: 0 }),
  districtBounds: Object.freeze({ minX: -60, maxX: 60, minZ: -60, maxZ: 60 }),
  districtEntrance: Object.freeze({ x: 0, z: 54, yaw: 0 }),
  districtSafeZoneRadius: 8,
  districtCombatTagMs: 15_000,
  districtRespawnProtectMs: 8_000,
  districtKillRepeatWindowMs: 10 * 60_000,
  districtHonorPerKill: 25,

  // Order Sieges
  siegeSeatId: 'keep:iliac-bay/castle-gothway',
  siegeSeatName: 'Castle Gothway',
  siegeSceneLocation: 'siege:Iliac/Castle Gothway',
  siegeTeamCap: 10,
  siegeDurationMs: 600_000,
  siegeCapturePoint: Object.freeze({ x: 0, z: 0 }),
  siegeCaptureRadius: 7,
  siegeCaptureGoal: 100,
  siegeCaptureRatePerSec: 10,
  siegeDecayRatePerSec: 5,
  siegeAttackerRally: Object.freeze({ x: 0, z: 32, yaw: 0 }),
  siegeDefenderRally: Object.freeze({ x: 0, z: -32, yaw: Math.PI }),
  siegeRespawnProtectMs: 5_000,
  siegePrestigeCap: 500,
});

export const PVP_WORLD_KEYS = Object.freeze({
  arenaRatings: 'pvp:arena:ratings',
  arenaHistory: 'pvp:arena:history',
  arenaPairs: 'pvp:arena:pairs',
  districtScores: 'pvp:district:scores',
  siegePrefix: 'pvp:siege:',
  siegeTenurePrefix: 'pvp:siege:tenure:',
  siegeStandings: 'pvp:siege:standings',
  duelStats: 'pvp:duels:stats',
});

export const dist2d = (a, b) => Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.z ?? 0) - (b?.z ?? 0));

export function accountKeyOf(playerOrId, ctx) {
  const fromSvc = ctx?.services?.accountKeyOf?.(playerOrId);
  if (fromSvc) return String(fromSvc);
  if (playerOrId && typeof playerOrId === 'object') {
    if (playerOrId.accountId != null) return `acct:${playerOrId.accountId}`;
    if (playerOrId.account?.id != null) return `acct:${playerOrId.account.id}`;
    if (playerOrId.id != null) return `char:${playerOrId.id}`;
  }
  if (typeof playerOrId === 'string' && playerOrId) return playerOrId;
  if (Number.isSafeInteger(playerOrId)) {
    const live = ctx?.players?.get?.(playerOrId);
    if (live) return accountKeyOf(live, ctx);
    return `char:${playerOrId}`;
  }
  return null;
}

export function sameAccount(a, b, ctx) {
  const ka = accountKeyOf(a, ctx);
  const kb = accountKeyOf(b, ctx);
  return !!(ka && kb && ka === kb);
}

/**
 * Standard Elo update for 1v1 ranked arena.
 * scoreA: 1 for A win, 0 for B win, 0.5 for draw.
 */
export function computeElo(ratingA, ratingB, scoreA, kFactor = 32) {
  const ra = Number.isFinite(ratingA) ? ratingA : 1200;
  const rb = Number.isFinite(ratingB) ? ratingB : 1200;
  const expectedA = 1 / (1 + Math.pow(10, (rb - ra) / 400));
  const expectedB = 1 - expectedA;
  const scoreB = 1 - scoreA;
  const deltaA = Math.round(kFactor * (scoreA - expectedA));
  const deltaB = Math.round(kFactor * (scoreB - expectedB));
  return {
    nextA: Math.max(100, ra + deltaA),
    nextB: Math.max(100, rb + deltaB),
    deltaA,
    deltaB,
  };
}

/**
 * Persist a world-state mutation via `ctx.services.runDurable` when available,
 * mirroring into `ctx.dirtyWorld` and tracking the promise for deterministic flush in tests.
 */
export function createDurableHelper(ctx) {
  const pending = new Set();

  function persist(opKey, scope, worldKey, valueOrMutator) {
    const runDurable = ctx?.services?.runDurable;
    if (typeof runDurable === 'function') {
      const p = Promise.resolve()
        .then(() => runDurable(opKey, { resourceKey: worldKey, ...scope }, async (tx) => {
          const prev = typeof valueOrMutator === 'function' ? await tx.getWorld(worldKey) : null;
          const next = typeof valueOrMutator === 'function' ? valueOrMutator(prev) : valueOrMutator;
          await tx.putWorld(worldKey, next);
          return next;
        }))
        .catch((err) => {
          ctx?.log?.warn?.(`[pvp] durable write ${opKey} failed: ${err?.message ?? err}`);
          // Still mirror into dirtyWorld fallback so simulation state is not silently dropped.
          try {
            if (typeof valueOrMutator !== 'function') ctx?.dirtyWorld?.(worldKey, valueOrMutator);
          } catch {}
          return null;
        });
      pending.add(p);
      p.finally(() => pending.delete(p));
      return p;
    }
    const next = typeof valueOrMutator === 'function' ? valueOrMutator(null) : valueOrMutator;
    try {
      ctx?.dirtyWorld?.(worldKey, next);
    } catch {}
    return Promise.resolve({ replayed: false, result: next });
  }

  async function flush() {
    while (pending.size > 0) {
      await Promise.all([...pending]);
    }
  }

  return { persist, flush, pending };
}

/**
 * Builds the single authoritative Land PvP eligibility policy across all modes.
 * Checked by combat (melee, bows/arrows, pets), magic (direct, area, reflected, DOTs, heals),
 * and law (crime suppression).
 */
export function createPvpPolicy(ctx, cfg, providers) {
  const now = () => (typeof ctx.now === 'function' ? ctx.now() : Date.now());
  const locationOf = (p) => (typeof ctx.location === 'function' ? ctx.location(p) : p?.rpg?.location);
  const sameScene = (a, b) => (typeof ctx.sameScene === 'function' ? ctx.sameScene(a, b) : locationOf(a) === locationOf(b));
  const isAlivePlayer = (p) => (
    !!p &&
    ctx.players?.get?.(p.id) === p &&
    !p.arriving &&
    !p.rpg?.defeated &&
    (p.rpg?.character?.health ?? 0) > 0
  );

  function getPlayerEngagement(p) {
    if (!p) return null;
    const duel = providers.duels?.engagementOf?.(p);
    if (duel) return duel;
    const arena = providers.arena?.engagementOf?.(p);
    if (arena) return arena;
    const siege = providers.siege?.engagementOf?.(p);
    if (siege) return siege;
    const district = providers.district?.engagementOf?.(p);
    if (district) return district;
    return null;
  }

  /** Snapshot context attached to arrows, spell missiles, and DOTs at launch time. */
  function captureProjectileContext(actor) {
    if (!actor) return null;
    const eng = getPlayerEngagement(actor);
    return {
      actorId: actor.id,
      location: locationOf(actor),
      scope: ctx.services?.presenceScope?.(actor) ?? null,
      mode: eng?.mode ?? null,
      matchId: eng?.matchId ?? null,
      team: eng?.team ?? null,
      capturedAt: now(),
    };
  }

  function hasRespawnProtection(p) {
    const until = providers.respawnProtectionUntil?.(p) ?? 0;
    return until > now();
  }

  /**
   * Authoritative harm eligibility check.
   * Used by melee, arrows (launch + impact), direct/area/reflected spells, DOTs, and summons/pets.
   */
  function canPlayerHarmPlayer(attacker, defender, opts = {}) {
    if (!attacker || !defender || attacker === defender || attacker.id === defender.id) {
      return { allowed: false, mode: null, matchId: null, reason: 'You cannot attack yourself.' };
    }
    if (!isAlivePlayer(attacker) || !isAlivePlayer(defender)) {
      return { allowed: false, mode: null, matchId: null, reason: 'That target is not available.' };
    }
    if (locationOf(attacker) !== locationOf(defender) || !sameScene(attacker, defender)) {
      return { allowed: false, mode: null, matchId: null, reason: 'That player is not in your scene.' };
    }
    if (hasRespawnProtection(defender)) {
      return { allowed: false, mode: null, matchId: null, reason: `${defender.name} is protected after respawning.` };
    }

    const attEng = getPlayerEngagement(attacker);
    const defEng = getPlayerEngagement(defender);

    // Projectile / DOT launch-context verification: crossing a boundary or ending a match mid-flight cancels hits.
    const proj = opts.projectileContext ?? null;
    if (proj) {
      const currentScope = ctx.services?.presenceScope?.(defender) ?? null;
      if (proj.location && locationOf(defender) !== proj.location) {
        return { allowed: false, mode: null, matchId: null, reason: 'Target crossed a scene boundary.' };
      }
      if ((proj.scope ?? null) !== currentScope) {
        return { allowed: false, mode: null, matchId: null, reason: 'Target is in another instance.' };
      }
      if (proj.mode !== (defEng?.mode ?? null) || (proj.matchId ?? null) !== (defEng?.matchId ?? null)) {
        return { allowed: false, mode: null, matchId: null, reason: 'Target is no longer in the same PvP engagement.' };
      }
      if (proj.mode !== (attEng?.mode ?? null) || (proj.matchId ?? null) !== (attEng?.matchId ?? null)) {
        return { allowed: false, mode: null, matchId: null, reason: 'Attacker left the PvP engagement.' };
      }
    }

    // 1. Consent Duel
    if (attEng?.mode === 'duel' || defEng?.mode === 'duel') {
      if (attEng?.mode !== 'duel' || defEng?.mode !== 'duel' || attEng.matchId !== defEng.matchId) {
        return { allowed: false, mode: null, matchId: null, reason: 'You cannot interfere in an active duel.' };
      }
      if (attEng.phase !== 'active') {
        return { allowed: false, mode: 'duel', matchId: attEng.matchId, reason: 'Wait for the duel countdown to finish.' };
      }
      if (attEng.outOfBounds || defEng.outOfBounds) {
        return { allowed: false, mode: 'duel', matchId: attEng.matchId, reason: 'Duel combat is only permitted inside the ring.' };
      }
      return { allowed: true, mode: 'duel', matchId: attEng.matchId };
    }

    // 2. Ranked / Practice 1v1 Arena
    if (attEng?.mode === 'arena' || defEng?.mode === 'arena') {
      if (attEng?.role === 'spectator' || defEng?.role === 'spectator') {
        return { allowed: false, mode: null, matchId: null, reason: 'Spectators cannot participate in arena combat.' };
      }
      if (attEng?.mode !== 'arena' || defEng?.mode !== 'arena' || attEng.matchId !== defEng.matchId) {
        return { allowed: false, mode: null, matchId: null, reason: 'That player is in another arena match.' };
      }
      if (attEng.phase !== 'active') {
        return { allowed: false, mode: 'arena', matchId: attEng.matchId, reason: 'The arena match has not started yet.' };
      }
      return { allowed: true, mode: 'arena', matchId: attEng.matchId };
    }

    // 3. Order Siege
    if (attEng?.mode === 'siege' || defEng?.mode === 'siege') {
      if (attEng?.mode !== 'siege' || defEng?.mode !== 'siege' || attEng.matchId !== defEng.matchId) {
        return { allowed: false, mode: null, matchId: null, reason: 'That player is not a combatant in this siege.' };
      }
      if (attEng.phase !== 'active') {
        return { allowed: false, mode: 'siege', matchId: attEng.matchId, reason: 'The siege battle is not active.' };
      }
      if (attEng.team === defEng.team) {
        return { allowed: false, mode: 'siege', matchId: attEng.matchId, reason: 'You cannot attack an ally on your siege team.' };
      }
      return { allowed: true, mode: 'siege', matchId: attEng.matchId, team: attEng.team };
    }

    // 4. Open PvP District
    if (attEng?.mode === 'district' || defEng?.mode === 'district') {
      if (attEng?.mode !== 'district' || defEng?.mode !== 'district') {
        return { allowed: false, mode: null, matchId: null, reason: 'Both players must be flagged inside the Open PvP district.' };
      }
      if (attEng.inSafeZone || defEng.inSafeZone) {
        return { allowed: false, mode: 'district', matchId: attEng.matchId, reason: 'Combat is prohibited inside the district safe entrance.' };
      }
      if (sameAccount(attacker, defender, ctx)) {
        return { allowed: false, mode: null, matchId: null, reason: 'You cannot attack another character on your own account.' };
      }
      return { allowed: true, mode: 'district', matchId: attEng.matchId };
    }

    return { allowed: false, mode: null, matchId: null, reason: 'You cannot attack other travellers.' };
  }

  /**
   * Authoritative helpful-action (healing, buffs, revive) eligibility check.
   * Prevents bystanders from healing duelists/arena combatants or assisting enemy siege teams,
   * while preserving normal co-op healing/reviving in safe PvE zones.
   */
  function canPlayerHelpPlayer(caster, target, opts = {}) {
    if (!caster || !target) return { allowed: false, mode: null, matchId: null, reason: 'Invalid target.' };
    if (caster === target || caster.id === target.id) {
      const eng = getPlayerEngagement(caster);
      return { allowed: true, mode: eng?.mode ?? null, matchId: eng?.matchId ?? null };
    }
    if (locationOf(caster) !== locationOf(target) || !sameScene(caster, target)) {
      return { allowed: false, mode: null, matchId: null, reason: 'That player is not in your scene.' };
    }

    const castEng = getPlayerEngagement(caster);
    const targEng = getPlayerEngagement(target);

    const proj = opts.projectileContext ?? null;
    if (proj && (proj.mode !== (targEng?.mode ?? null) || (proj.matchId ?? null) !== (targEng?.matchId ?? null))) {
      return { allowed: false, mode: null, matchId: null, reason: 'Target PvP state changed in flight.' };
    }

    // Duel: 1v1 isolated — neither outsider nor opponent can heal/buff/revive a duelist.
    if (castEng?.mode === 'duel' || targEng?.mode === 'duel') {
      return { allowed: false, mode: 'duel', matchId: targEng?.matchId ?? castEng?.matchId ?? null, reason: 'Outside assistance is forbidden during a duel.' };
    }

    // Arena: 1v1 isolated — spectators and opponents cannot heal/buff/revive combatants.
    if (castEng?.mode === 'arena' || targEng?.mode === 'arena') {
      return { allowed: false, mode: 'arena', matchId: targEng?.matchId ?? castEng?.matchId ?? null, reason: 'Assistance is forbidden in 1v1 arena matches.' };
    }

    // Siege: only teammates in the same active siege may assist each other.
    if (castEng?.mode === 'siege' || targEng?.mode === 'siege') {
      if (castEng?.mode === 'siege' && targEng?.mode === 'siege' && castEng.matchId === targEng.matchId && castEng.team === targEng.team) {
        return { allowed: true, mode: 'siege', matchId: castEng.matchId, team: castEng.team };
      }
      return { allowed: false, mode: 'siege', matchId: targEng?.matchId ?? castEng?.matchId ?? null, reason: 'You may only assist allies on your siege team.' };
    }

    // Open PvP District: unflagged / safe-zone players cannot pocket-heal active combatants.
    if (targEng?.mode === 'district' && !targEng.inSafeZone) {
      if (castEng?.mode !== 'district' || castEng.inSafeZone) {
        return { allowed: false, mode: 'district', matchId: targEng.matchId, reason: 'Enter the Open PvP district beyond the safe gate to assist combatants.' };
      }
      return { allowed: true, mode: 'district', matchId: targEng.matchId };
    }

    // Normal PvE world: co-op healing and reviving allowed.
    return { allowed: true, mode: null, matchId: null };
  }

  function scaleDamage(rawDamage, attacker, defender, { kind = 'melee' } = {}) {
    const n = Number(rawDamage) || 0;
    if (n <= 0) return 0;
    const scale = kind === 'dot' ? cfg.pvpDotScale : cfg.pvpDamageScale;
    const maxHp = Math.max(1, defender?.rpg?.character?.maxHealth ?? 50);
    const cap = Math.max(1, Math.floor(maxHp * cfg.pvpMaxHitFraction));
    return Math.max(1, Math.min(cap, Math.round(n * scale)));
  }

  function scaleHeal(rawHeal, caster, target) {
    const n = Number(rawHeal) || 0;
    if (n <= 0) return 0;
    const eng = getPlayerEngagement(target);
    if (!eng) return n;
    return Math.max(1, Math.round(n * cfg.pvpHealScale));
  }

  /**
   * Determines whether a town-guard crime should be suppressed because it arose from a legal PvP mode.
   * Non-PvP safe-zone crimes (pickpocketing, shoplifting, attacking NPCs) are NEVER suppressed.
   */
  function isLegalPvpCrimeSuppressed(player, crime, opts = {}) {
    if (!player) return false;
    const loc = opts.location ?? locationOf(player);
    if (isUnpolicedScene(loc)) {
      return crime === 'assault' || crime === 'murder' || crime === 'vagrancy' || opts.pvp === true;
    }
    if (opts.pvp === true) {
      const eng = getPlayerEngagement(player);
      return !!(eng && (eng.mode === 'duel' || eng.mode === 'arena' || eng.mode === 'district' || eng.mode === 'siege'));
    }
    return false;
  }

  function isUnpolicedScene(location) {
    if (!location) return false;
    return (
      location === cfg.arenaLocation ||
      location === cfg.districtLocation ||
      location === cfg.siegeSceneLocation ||
      String(location).startsWith('arena:') ||
      String(location).startsWith('pvp:') ||
      String(location).startsWith('siege:')
    );
  }

  return {
    getPlayerEngagement,
    captureProjectileContext,
    hasRespawnProtection,
    canPlayerHarmPlayer,
    canPlayerHelpPlayer,
    scaleDamage,
    scaleHeal,
    isLegalPvpCrimeSuppressed,
    isUnpolicedScene,
  };
}
