// Open PvP District (Land PvP §4):
//   - Marked Iliac Bay district (`pvp:Iliac/Bloodmarket Ward`) with explicit boundary warning & entry flag.
//   - Entrance safe zone around gate; crossing past safe zone arms open PvP combat.
//   - Combat-tag timer preventing instant safe-zone exit, travel, rest, Recall, or slot-switch/archive exploits.
//   - Normal equipment wear & inventory retention; safe respawn outside the district with brief respawn protection.
//   - Honor/score tracking with repeat-kill diminishing per account pair & disconnect telemetry persisted via `runDurable`.

import { PVP_WORLD_KEYS, accountKeyOf, dist2d, sameAccount } from './policy.js';

export function createDistrictManager(ctx, cfg, shared) {
  const { durable, notifyPvp, pushState, relocatePlayer } = shared;
  const now = () => (typeof ctx.now === 'function' ? ctx.now() : Date.now());
  const locationOf = (p) => (typeof ctx.location === 'function' ? ctx.location(p) : p?.rpg?.location);

  const flagged = new Map(); // playerId -> { enteredAt, returnPoint, warned: true }
  const combatTagUntil = new Map(); // playerId -> monotonic ms
  const respawnProtectUntil = new Map(); // playerId -> monotonic ms
  const scores = new Map(); // charId -> { id, name, honor, kills, deaths, streak, bestStreak, combatDisconnects, updatedAt }
  const recentKills = new Map(); // "killerAcct|victimAcct" -> [wall timestamps]

  // Hydrate persisted district scores
  for (const [key, val] of ctx.loadWorld?.(PVP_WORLD_KEYS.districtScores) ?? []) {
    if (key === PVP_WORLD_KEYS.districtScores && val && typeof val === 'object') {
      for (const [cid, rec] of Object.entries(val)) {
        if (rec && typeof rec === 'object') scores.set(Number(cid), { ...rec });
      }
    }
  }

  function ensureScore(playerId, name = null) {
    let rec = scores.get(playerId);
    if (!rec) {
      rec = {
        id: playerId,
        name: name || ctx.players.get(playerId)?.name || `Traveller ${playerId}`,
        honor: 0,
        kills: 0,
        deaths: 0,
        streak: 0,
        bestStreak: 0,
        combatDisconnects: 0,
        updatedAt: null,
      };
      scores.set(playerId, rec);
    } else if (name && rec.name !== name) {
      rec.name = name;
    }
    return rec;
  }

  function scoresSnapshot() {
    const out = {};
    for (const [cid, rec] of scores) out[String(cid)] = rec;
    return out;
  }

  function persistScores(opSuffix, characterIds = []) {
    durable.persist(
      `pvp:district:${opSuffix}`,
      { characterIds },
      PVP_WORLD_KEYS.districtScores,
      scoresSnapshot(),
    );
  }

  function isInDistrictLocation(p) {
    return locationOf(p) === cfg.districtLocation;
  }

  function isInSafeZone(p) {
    if (!isInDistrictLocation(p)) return false;
    return dist2d(p, cfg.districtEntrance) <= cfg.districtSafeZoneRadius;
  }

  function combatTagRemainingMs(playerId) {
    const until = combatTagUntil.get(playerId) ?? 0;
    return Math.max(0, until - now());
  }

  function isCombatTagged(playerId) {
    return combatTagRemainingMs(playerId) > 0;
  }

  function applyCombatTag(p, reason = 'combat') {
    if (!p) return;
    const until = now() + cfg.districtCombatTagMs;
    const prev = combatTagUntil.get(p.id) ?? 0;
    combatTagUntil.set(p.id, Math.max(prev, until));
    if (prev <= now()) {
      notifyPvp(p, {
        kind: 'pvp.combatTag',
        remainingMs: cfg.districtCombatTagMs,
        reason,
        text: `Combat tagged for ${Math.ceil(cfg.districtCombatTagMs / 1000)}s — safe exit, travel, and character switch locked.`,
      });
    }
  }

  function respawnProtectionUntilOf(p) {
    return respawnProtectUntil.get(p?.id) ?? 0;
  }

  function grantRespawnProtection(p, durationMs = cfg.districtRespawnProtectMs) {
    if (!p) return;
    const until = now() + durationMs;
    respawnProtectUntil.set(p.id, until);
    notifyPvp(p, {
      kind: 'pvp.respawnProtection',
      durationMs,
      text: `Respawn protection active for ${Math.ceil(durationMs / 1000)}s.`,
    });
  }

  // ------------------------------------------------------------------ actions

  function enter(p, args = {}) {
    if (!p?.rpg?.character || p.rpg.defeated) throw new Error('You cannot enter the Open PvP district right now.');
    const custody = ctx.services?.law?.custody?.(p);
    if (custody) throw new Error(custody);
    if (ctx.services?.sailing?.aboard?.(p)) throw new Error('Go ashore before entering the Open PvP district.');
    if (shared.isInAnyMatch(p.id)) throw new Error('Finish your current PvP match first.');

    if (isInDistrictLocation(p) && flagged.has(p.id)) {
      return stateFor(p);
    }

    if (args.acknowledgeWarning !== true) {
      const warning = {
        kind: 'pvp.districtWarning',
        districtName: cfg.districtName,
        location: cfg.districtLocation,
        combatTagSec: Math.ceil(cfg.districtCombatTagMs / 1000),
        respawnProtectSec: Math.ceil(cfg.districtRespawnProtectMs / 1000),
        rules: [
          'Crossing past the entrance gate flags you for open player-vs-player combat.',
          'Normal equipment wear applies; your carried inventory is retained on defeat.',
          `Engaging in PvP applies a ${Math.ceil(cfg.districtCombatTagMs / 1000)}s combat timer blocking safe exit, travel, and slot switches.`,
          'Town Watch bounties are suspended inside this declared PvP ward.',
        ],
        text: `Warning: ${cfg.districtName} is an Open PvP district. Confirm entry to proceed.`,
      };
      notifyPvp(p, warning);
      return { warningRequired: true, warning };
    }

    const ret = {
      location: locationOf(p),
      x: p.x,
      z: p.z,
      yaw: p.yaw ?? 0,
    };
    flagged.set(p.id, { enteredAt: now(), returnPoint: ret, warned: true });
    p.rpg.pvpDistrict = { flagged: true, returnPoint: ret };
    relocatePlayer(p, {
      location: cfg.districtLocation,
      x: cfg.districtEntrance.x,
      z: cfg.districtEntrance.z,
      yaw: cfg.districtEntrance.yaw,
    });
    ctx.dirty?.(p);
    notifyPvp(p, {
      kind: 'pvp.districtEntered',
      districtName: cfg.districtName,
      location: cfg.districtLocation,
      safeGateRadius: cfg.districtSafeZoneRadius,
      text: `Entered ${cfg.districtName}. You are at the safe entrance gate — step further in to engage in Open PvP.`,
    });
    pushState(p);
    return stateFor(p);
  }

  function exit(p) {
    if (!isInDistrictLocation(p) && !flagged.has(p.id)) {
      throw new Error('You are not in the Open PvP district.');
    }
    const tagLeft = combatTagRemainingMs(p.id);
    if (tagLeft > 0) {
      throw new Error(`You are combat-tagged and cannot exit for ${Math.ceil(tagLeft / 1000)}s.`);
    }
    const rec = flagged.get(p.id);
    const dest = rec?.returnPoint ?? {
      location: cfg.districtSafeExitLocation,
      ...cfg.districtSafeExitSpot,
    };
    flagged.delete(p.id);
    delete p.rpg.pvpDistrict;
    relocatePlayer(p, dest);
    ctx.dirty?.(p);
    notifyPvp(p, {
      kind: 'pvp.districtExited',
      location: dest.location,
      text: `You have safely left ${cfg.districtName}.`,
    });
    pushState(p);
    return { exited: true, location: dest.location };
  }

  // ------------------------------------------------------------------ combat hooks

  function onCombatInteraction(attacker, defender) {
    if (isInDistrictLocation(attacker) && isInDistrictLocation(defender)) {
      // Stepping out of safe zone or dealing damage tags both players
      applyCombatTag(attacker, 'attack');
      applyCombatTag(defender, 'attacked');
    }
  }

  function onHelpfulInteraction(caster, target) {
    if (isInDistrictLocation(caster) && isInDistrictLocation(target) && isCombatTagged(target.id)) {
      applyCombatTag(caster, 'assist');
    }
  }

  function onPlayerDefeated(victim, killer) {
    if (!isInDistrictLocation(victim)) return false;

    const victimScore = ensureScore(victim.id, victim.name);
    victimScore.deaths += 1;
    victimScore.streak = 0;
    victimScore.updatedAt = new Date().toISOString();

    let honorAwarded = 0;
    let repeatCapped = false;
    const affectedIds = [victim.id];

    if (killer && killer.id !== victim.id && ctx.players.get(killer.id) === killer && !sameAccount(killer, victim, ctx)) {
      affectedIds.push(killer.id);
      const kAcct = accountKeyOf(killer, ctx);
      const vAcct = accountKeyOf(victim, ctx);
      const pk = `${kAcct}|${vAcct}`;
      const wallNow = Date.now();
      const recent = (recentKills.get(pk) ?? []).filter((ts) => wallNow - ts < cfg.districtKillRepeatWindowMs);
      const repeatCount = recent.length;
      recent.push(wallNow);
      recentKills.set(pk, recent);

      // Diminishing honor for repeated kills against the same account in window: 100%, 50%, 25%, then 0
      const mult = repeatCount === 0 ? 1 : repeatCount === 1 ? 0.5 : repeatCount === 2 ? 0.25 : 0;
      honorAwarded = Math.floor(cfg.districtHonorPerKill * mult);
      repeatCapped = honorAwarded === 0;

      const killerScore = ensureScore(killer.id, killer.name);
      killerScore.kills += 1;
      killerScore.honor += honorAwarded;
      killerScore.streak += 1;
      if (killerScore.streak > killerScore.bestStreak) killerScore.bestStreak = killerScore.streak;
      killerScore.updatedAt = new Date().toISOString();

      notifyPvp(killer, {
        kind: 'pvp.districtKill',
        victimId: victim.id,
        victimName: victim.name,
        honorAwarded,
        repeatCapped,
        totalHonor: killerScore.honor,
        text: repeatCapped
          ? `Defeated ${victim.name} (diminishing returns: 0 honor).`
          : `Defeated ${victim.name} in ${cfg.districtName}! (+${honorAwarded} Honor)`,
      });
      pushState(killer);
    }

    persistScores(`kill:${victim.id}:${Date.now()}`, affectedIds);

    // Clear combat tag & respawn safely OUTSIDE the district with brief respawn protection (normal inventory retained!)
    combatTagUntil.delete(victim.id);
    flagged.delete(victim.id);
    delete victim.rpg.pvpDistrict;
    delete victim.rpg.defeated;
    const c = victim.rpg?.character;
    if (c) {
      c.health = Math.max(1, Math.floor((c.maxHealth ?? 50) * 0.75));
      if (Number.isFinite(c.maxFatigue)) c.fatigue = Math.max(c.fatigue ?? 0, Math.floor(c.maxFatigue * 0.75));
    }
    relocatePlayer(victim, {
      location: cfg.districtSafeExitLocation,
      x: cfg.districtSafeExitSpot.x,
      z: cfg.districtSafeExitSpot.z,
      yaw: cfg.districtSafeExitSpot.yaw,
    });
    grantRespawnProtection(victim, cfg.districtRespawnProtectMs);
    ctx.dirty?.(victim);
    notifyPvp(victim, {
      kind: 'pvp.districtRespawn',
      killerName: killer?.name ?? null,
      location: cfg.districtSafeExitLocation,
      text: `You fell in ${cfg.districtName} and respawned safely outside with your gear intact.`,
    });
    pushState(victim);
    return true;
  }

  // ------------------------------------------------------------------ tick & lifecycle

  function tick(_dt, t) {
    // Expire combat tags
    for (const [pid, until] of [...combatTagUntil]) {
      if (t >= until) {
        combatTagUntil.delete(pid);
        const p = ctx.players.get(pid);
        if (p) {
          notifyPvp(p, { kind: 'pvp.combatTagExpired', text: 'Your PvP combat tag has expired.' });
          pushState(p);
        }
      }
    }
    // Expire respawn protection
    for (const [pid, until] of [...respawnProtectUntil]) {
      if (t >= until) respawnProtectUntil.delete(pid);
    }
    // Keep players inside district bounds and prevent re-entering safe gate while combat-tagged
    for (const p of ctx.players.values()) {
      if (!isInDistrictLocation(p)) continue;
      if (!flagged.has(p.id)) {
        flagged.set(p.id, { enteredAt: t, returnPoint: { location: cfg.districtSafeExitLocation, ...cfg.districtSafeExitSpot }, warned: true });
      }
      // Clamp to district perimeter
      const b = cfg.districtBounds;
      if (p.x < b.minX) p.x = b.minX;
      else if (p.x > b.maxX) p.x = b.maxX;
      if (p.z < b.minZ) p.z = b.minZ;
      else if (p.z > b.maxZ) p.z = b.maxZ;
      // Combat-tagged fighters cannot retreat into the safe entrance gate
      if (isCombatTagged(p.id) && isInSafeZone(p)) {
        const dx = p.x - cfg.districtEntrance.x;
        const dz = p.z - cfg.districtEntrance.z;
        const d = Math.hypot(dx, dz) || 1;
        const push = cfg.districtSafeZoneRadius + 0.5;
        p.x = cfg.districtEntrance.x + (dx / d) * push;
        p.z = cfg.districtEntrance.z + ((dz || -1) / d) * push;
      }
    }
  }

  function onLeave(p) {
    if (isCombatTagged(p.id)) {
      const rec = ensureScore(p.id, p.name);
      rec.combatDisconnects += 1;
      rec.updatedAt = new Date().toISOString();
      persistScores(`disc:${p.id}:${Date.now()}`, [p.id]);
    }
  }

  function onJoin(p) {
    if (isInDistrictLocation(p) || p.rpg?.pvpDistrict?.flagged) {
      if (isInDistrictLocation(p)) {
        flagged.set(p.id, {
          enteredAt: now(),
          returnPoint: p.rpg?.pvpDistrict?.returnPoint ?? { location: cfg.districtSafeExitLocation, ...cfg.districtSafeExitSpot },
          warned: true,
        });
        grantRespawnProtection(p, Math.min(4000, cfg.districtRespawnProtectMs));
      } else {
        delete p.rpg.pvpDistrict;
      }
    }
  }

  function onPurge(characterId) {
    flagged.delete(characterId);
    combatTagUntil.delete(characterId);
    respawnProtectUntil.delete(characterId);
    scores.delete(characterId);
  }

  function engagementOf(p) {
    if (!isInDistrictLocation(p)) return null;
    const rec = flagged.get(p.id);
    if (!rec) return null;
    return {
      mode: 'district',
      matchId: cfg.districtLocation,
      phase: 'active',
      inSafeZone: isInSafeZone(p),
    };
  }

  function blockerFor(characterId) {
    const left = combatTagRemainingMs(characterId);
    if (left > 0) {
      return {
        code: 'PVP_COMBAT_TAGGED',
        message: `You are combat-tagged in ${cfg.districtName} (${Math.ceil(left / 1000)}s remaining).`,
        route: 'pvp',
      };
    }
    return null;
  }

  function leaderboard(limit = 15) {
    return [...scores.values()]
      .sort((a, b) => b.honor - a.honor || b.kills - a.kills || a.id - b.id)
      .slice(0, Math.max(1, Math.min(50, limit)));
  }

  function stateFor(p) {
    const inDistrict = isInDistrictLocation(p);
    const inSafe = inDistrict && isInSafeZone(p);
    const combatants = [];
    for (const q of ctx.players.values()) {
      if (isInDistrictLocation(q) && !q.arriving) {
        combatants.push({ id: q.id, name: q.name, safe: isInSafeZone(q) });
      }
    }
    return {
      districtName: cfg.districtName,
      location: cfg.districtLocation,
      inDistrict,
      inSafeZone: inSafe,
      flagged: inDistrict && !inSafe,
      combatTagMsLeft: combatTagRemainingMs(p.id),
      respawnProtectMsLeft: Math.max(0, respawnProtectionUntilOf(p) - now()),
      score: ensureScore(p.id, p.name),
      leaderboard: leaderboard(10),
      occupantCount: combatants.length,
      safeGate: { ...cfg.districtEntrance, radius: cfg.districtSafeZoneRadius },
      bounds: cfg.districtBounds,
    };
  }

  return {
    enter,
    exit,
    onCombatInteraction,
    onHelpfulInteraction,
    onPlayerDefeated,
    isCombatTagged,
    combatTagRemainingMs,
    respawnProtectionUntilOf,
    grantRespawnProtection,
    applyCombatTag,
    tick,
    onLeave,
    onJoin,
    onPurge,
    engagementOf,
    blockerFor,
    leaderboard,
    stateFor,
    scores,
  };
}
