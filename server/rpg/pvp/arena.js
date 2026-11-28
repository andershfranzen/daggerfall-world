// Ranked & Practice 1v1 Arena (Land PvP §4):
//   - Ranked and practice queues, Elo matchmaking, match-ready accept window.
//   - Isolated arena match scene via `presenceScope`, equipment bracket & consumable allowance.
//   - Durable Elo rating, W/L/draw record, match history, and repeated-pair reward cap via `runDurable`.
//   - Separate spectator viewing area sharing only fight-relevant public data (no private stats/inventory).
//   - Void fights interrupted by server restart and restore players to return points on join.

import { randomBytes } from 'node:crypto';
import { PVP_WORLD_KEYS, accountKeyOf, computeElo, sameAccount } from './policy.js';

const newArenaId = () => `arena_${randomBytes(5).toString('hex')}`;

export function createArenaManager(ctx, cfg, shared) {
  const { durable, notifyPvp, pushState, relocatePlayer } = shared;
  const now = () => (typeof ctx.now === 'function' ? ctx.now() : Date.now());
  const locationOf = (p) => (typeof ctx.location === 'function' ? ctx.location(p) : p?.rpg?.location);

  const queues = { ranked: [], practice: [] }; // [{ playerId, accountKey, name, rating, queuedAt }]
  const matches = new Map(); // matchId -> matchRecord
  const playerMatch = new Map(); // playerId -> { matchId, role: 'fighter'|'spectator' }

  const ratings = new Map(); // charId -> { id, name, elo, wins, losses, draws, streak, season, updatedAt }
  const history = []; // recent completed matches (capped 100)
  const pairLog = new Map(); // "acctA|acctB" -> [timestamps]

  // Hydrate persisted arena data
  for (const [key, val] of ctx.loadWorld?.('pvp:arena:') ?? []) {
    if (key === PVP_WORLD_KEYS.arenaRatings && val && typeof val === 'object') {
      for (const [cid, rec] of Object.entries(val)) {
        if (rec && typeof rec === 'object') ratings.set(Number(cid), { ...rec });
      }
    } else if (key === PVP_WORLD_KEYS.arenaHistory && Array.isArray(val)) {
      history.push(...val.slice(-100));
    } else if (key === PVP_WORLD_KEYS.arenaPairs && val && typeof val === 'object') {
      for (const [pk, list] of Object.entries(val)) {
        if (Array.isArray(list)) pairLog.set(pk, [...list]);
      }
    }
  }

  function ensureRating(playerId, name = null) {
    let rec = ratings.get(playerId);
    if (!rec) {
      rec = {
        id: playerId,
        name: name || ctx.players.get(playerId)?.name || `Fighter ${playerId}`,
        elo: cfg.arenaInitialElo,
        wins: 0,
        losses: 0,
        draws: 0,
        streak: 0,
        season: 1,
        updatedAt: null,
      };
      ratings.set(playerId, rec);
    } else if (name && rec.name !== name) {
      rec.name = name;
    }
    return rec;
  }

  function pairKey(acctA, acctB) {
    return acctA < acctB ? `${acctA}|${acctB}` : `${acctB}|${acctA}`;
  }

  function countRecentPairMatches(acctA, acctB, t = Date.now()) {
    const pk = pairKey(acctA, acctB);
    const list = (pairLog.get(pk) ?? []).filter((ts) => t - ts < cfg.arenaRepeatWindowMs);
    pairLog.set(pk, list);
    return list.length;
  }

  function recordPairMatch(acctA, acctB, t = Date.now()) {
    const pk = pairKey(acctA, acctB);
    const list = (pairLog.get(pk) ?? []).filter((ts) => t - ts < cfg.arenaRepeatWindowMs);
    list.push(t);
    pairLog.set(pk, list);
    return list.length;
  }

  function ratingsSnapshot() {
    const out = {};
    for (const [cid, rec] of ratings) out[String(cid)] = rec;
    return out;
  }

  function pairsSnapshot() {
    const out = {};
    for (const [k, list] of pairLog) if (list.length) out[k] = list;
    return out;
  }

  function removeFromQueues(playerId) {
    for (const mode of ['ranked', 'practice']) {
      const idx = queues[mode].findIndex((e) => e.playerId === playerId);
      if (idx >= 0) queues[mode].splice(idx, 1);
    }
  }

  function queueEntryOf(playerId) {
    for (const mode of ['ranked', 'practice']) {
      const found = queues[mode].find((e) => e.playerId === playerId);
      if (found) return { mode, ...found };
    }
    return null;
  }

  function captureReturn(p) {
    const c = p.rpg?.character;
    return {
      location: locationOf(p),
      x: p.x,
      z: p.z,
      yaw: p.yaw ?? 0,
      health: c?.health ?? 50,
      maxHealth: c?.maxHealth ?? 50,
      fatigue: c?.fatigue ?? 50,
      maxFatigue: c?.maxFatigue ?? 50,
      magicka: c?.magicka ?? 50,
      maxMagicka: c?.maxMagicka ?? 50,
    };
  }

  function restoreFromArena(p, ret) {
    if (!p || !ret) return;
    const c = p.rpg?.character;
    if (c) {
      c.health = Math.max(1, Math.min(c.maxHealth ?? ret.maxHealth, ret.health));
      if (Number.isFinite(ret.fatigue) && Number.isFinite(c.maxFatigue)) c.fatigue = Math.min(c.maxFatigue, ret.fatigue);
      if (Number.isFinite(ret.magicka) && Number.isFinite(c.maxMagicka)) c.magicka = Math.min(c.maxMagicka, ret.magicka);
    }
    delete p.rpg.defeated;
    delete p.rpg.pvpArenaReturn;
    relocatePlayer(p, { location: ret.location, x: ret.x, z: ret.z, yaw: ret.yaw });
    ctx.dirty?.(p);
  }

  function matchPublicView(m, viewerId = null) {
    if (!m) return null;
    const t = now();
    return {
      id: m.id,
      queueMode: m.queueMode,
      phase: m.phase,
      sceneScope: m.scope,
      location: cfg.arenaLocation,
      spectatorCount: m.spectators.size,
      isSpectator: viewerId != null && m.spectators.has(viewerId),
      isFighter: viewerId != null && m.fighters.includes(viewerId),
      acceptMsLeft: m.phase === 'accept' ? Math.max(0, m.acceptDeadline - t) : 0,
      countdownMsLeft: m.phase === 'countdown' ? Math.max(0, m.startsAt - t) : 0,
      timeRemainingMs: m.phase === 'active' ? Math.max(0, m.endsAt - t) : cfg.arenaMaxDurationMs,
      fighters: m.fighters.map((fid) => {
        const live = ctx.players.get(fid);
        const rec = ensureRating(fid, m.names[fid]);
        return {
          id: fid,
          name: m.names[fid],
          elo: rec.elo,
          hp: live?.rpg?.character?.health ?? 0,
          maxHp: live?.rpg?.character?.maxHealth ?? 50,
          accepted: !!m.accepted[fid],
          disconnected: m.disconnectedAt[fid] != null,
          consumablesUsed: m.consumablesUsed[fid] ?? 0,
          consumablesMax: cfg.arenaConsumableAllowance,
        };
      }),
    };
  }

  function enterArenaScene(m) {
    const t = now();
    m.phase = 'countdown';
    m.startsAt = t + cfg.arenaCountdownMs;
    m.endsAt = m.startsAt + cfg.arenaMaxDurationMs;
    const spawns = [cfg.arenaSpawnA, cfg.arenaSpawnB];
    m.fighters.forEach((fid, idx) => {
      const p = ctx.players.get(fid);
      if (!p) return;
      const ret = captureReturn(p);
      m.returns[fid] = ret;
      p.rpg.pvpArenaReturn = { matchId: m.id, ...ret };
      // Restore full combat vitals on arena entry for fair matched start
      const c = p.rpg.character;
      if (c) {
        c.health = c.maxHealth ?? c.health;
        if (Number.isFinite(c.maxFatigue)) c.fatigue = c.maxFatigue;
        if (Number.isFinite(c.maxMagicka)) c.magicka = c.maxMagicka;
      }
      relocatePlayer(p, { location: cfg.arenaLocation, ...spawns[idx] });
      ctx.dirty?.(p);
    });
    const view = matchPublicView(m);
    for (const fid of m.fighters) {
      const p = ctx.players.get(fid);
      if (p) {
        notifyPvp(p, {
          kind: 'pvp.arenaCountdown',
          match: view,
          text: `Arena match starting in ${Math.ceil(cfg.arenaCountdownMs / 1000)}s!`,
        });
        pushState(p);
      }
    }
  }

  function tryMatchmake(queueMode) {
    const q = queues[queueMode];
    if (q.length < 2) return null;
    // Pick best compatible pair (different accounts, closest Elo)
    let bestPair = null;
    let bestDiff = Infinity;
    for (let i = 0; i < q.length; i++) {
      for (let j = i + 1; j < q.length; j++) {
        const a = q[i];
        const b = q[j];
        if (a.accountKey && b.accountKey && a.accountKey === b.accountKey) continue;
        const pa = ctx.players.get(a.playerId);
        const pb = ctx.players.get(b.playerId);
        if (!pa || !pb || pa.arriving || pb.arriving) continue;
        const diff = Math.abs(a.rating - b.rating);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestPair = [i, j];
        }
      }
    }
    if (!bestPair) return null;
    const [i, j] = bestPair;
    const b = q.splice(j, 1)[0];
    const a = q.splice(i, 1)[0];

    const t = now();
    const id = newArenaId();
    const match = {
      id,
      mode: 'arena',
      queueMode,
      phase: 'accept',
      scope: `arena:${id}`,
      fighters: [a.playerId, b.playerId],
      names: { [a.playerId]: a.name, [b.playerId]: b.name },
      accountKeys: { [a.playerId]: a.accountKey, [b.playerId]: b.accountKey },
      accepted: { [a.playerId]: false, [b.playerId]: false },
      returns: {},
      spectators: new Map(), // playerId -> returnPoint
      disconnectedAt: {},
      consumablesUsed: { [a.playerId]: 0, [b.playerId]: 0 },
      createdAt: t,
      acceptDeadline: t + cfg.arenaAcceptMs,
      startsAt: 0,
      endsAt: 0,
    };
    matches.set(id, match);
    playerMatch.set(a.playerId, { matchId: id, role: 'fighter' });
    playerMatch.set(b.playerId, { matchId: id, role: 'fighter' });

    const view = matchPublicView(match);
    for (const fid of match.fighters) {
      const p = ctx.players.get(fid);
      if (p) {
        notifyPvp(p, {
          kind: 'pvp.arenaMatchFound',
          match: view,
          text: `${queueMode === 'ranked' ? 'Ranked' : 'Practice'} Arena match found! Accept within ${Math.ceil(cfg.arenaAcceptMs / 1000)}s.`,
        });
        pushState(p);
      }
    }
    return match;
  }

  function ejectSpectators(m, reason = 'match ended') {
    for (const [sid, ret] of [...m.spectators]) {
      m.spectators.delete(sid);
      playerMatch.delete(sid);
      const sp = ctx.players.get(sid);
      if (sp) {
        delete sp.rpg.pvpArenaReturn;
        relocatePlayer(sp, ret);
        notifyPvp(sp, { kind: 'pvp.arenaSpectateEnd', matchId: m.id, reason, text: `Returned from arena viewing gallery (${reason}).` });
        pushState(sp);
      }
    }
  }

  function finishMatch(m, { winnerId = null, loserId = null, outcome = 'win', reason = '' } = {}) {
    if (!m || m.phase === 'ended') return;
    m.phase = 'ended';
    m.endedAt = now();
    matches.delete(m.id);

    let ratingChange = null;
    let rewardCapped = false;

    if (m.queueMode === 'ranked' && outcome !== 'void' && outcome !== 'cancelled') {
      const [idA, idB] = m.fighters;
      const recA = ensureRating(idA, m.names[idA]);
      const recB = ensureRating(idB, m.names[idB]);
      const acctA = m.accountKeys[idA];
      const acctB = m.accountKeys[idB];
      const priorPairs = countRecentPairMatches(acctA, acctB);
      rewardCapped = priorPairs >= cfg.arenaRepeatPairCap;

      const scoreA = outcome === 'draw' ? 0.5 : winnerId === idA ? 1 : 0;
      const elo = rewardCapped
        ? { nextA: recA.elo, nextB: recB.elo, deltaA: 0, deltaB: 0 }
        : computeElo(recA.elo, recB.elo, scoreA, cfg.arenaKFactor);

      recA.elo = elo.nextA;
      recB.elo = elo.nextB;
      const iso = new Date().toISOString();
      recA.updatedAt = iso;
      recB.updatedAt = iso;
      if (outcome === 'draw') {
        recA.draws += 1;
        recB.draws += 1;
        recA.streak = 0;
        recB.streak = 0;
      } else if (winnerId === idA) {
        recA.wins += 1;
        recB.losses += 1;
        recA.streak = Math.max(0, recA.streak) + 1;
        recB.streak = 0;
      } else {
        recB.wins += 1;
        recA.losses += 1;
        recB.streak = Math.max(0, recB.streak) + 1;
        recA.streak = 0;
      }
      recordPairMatch(acctA, acctB);

      ratingChange = {
        [idA]: { elo: recA.elo, delta: elo.deltaA },
        [idB]: { elo: recB.elo, delta: elo.deltaB },
        rewardCapped,
      };

      const entry = {
        id: m.id,
        queueMode: m.queueMode,
        at: iso,
        fighters: [
          { id: idA, name: m.names[idA], elo: recA.elo, delta: elo.deltaA },
          { id: idB, name: m.names[idB], elo: recB.elo, delta: elo.deltaB },
        ],
        winnerId,
        outcome,
        reason,
        rewardCapped,
      };
      history.push(entry);
      if (history.length > 100) history.splice(0, history.length - 100);

      durable.persist(
        `pvp:arena:ratings:${m.id}`,
        { characterIds: [idA, idB] },
        PVP_WORLD_KEYS.arenaRatings,
        ratingsSnapshot(),
      );
      durable.persist(
        `pvp:arena:history:${m.id}`,
        { characterIds: [idA, idB] },
        PVP_WORLD_KEYS.arenaHistory,
        history.slice(-100),
      );
      durable.persist(
        `pvp:arena:pairs:${m.id}`,
        { characterIds: [idA, idB] },
        PVP_WORLD_KEYS.arenaPairs,
        pairsSnapshot(),
      );
    }

    const ev = {
      kind: 'pvp.arenaEnd',
      matchId: m.id,
      queueMode: m.queueMode,
      outcome,
      winnerId,
      winnerName: winnerId != null ? m.names[winnerId] : null,
      loserId,
      loserName: loserId != null ? m.names[loserId] : null,
      reason,
      ratingChange,
      rewardCapped,
      text: outcome === 'void' || outcome === 'cancelled'
        ? `Arena match ${outcome}: ${reason || 'cancelled'}.`
        : outcome === 'draw'
          ? `Arena match ended in a draw (${reason}).`
          : `${m.names[winnerId]} wins the ${m.queueMode} arena match!${rewardCapped ? ' (Repeat pair rating cap reached)' : ''}`,
    };

    for (const fid of m.fighters) {
      playerMatch.delete(fid);
      const p = ctx.players.get(fid);
      const ret = m.returns[fid];
      if (p) {
        if (ret) restoreFromArena(p, ret);
        notifyPvp(p, ev);
        pushState(p);
      } else if (ret) {
        shared.storePendingRestore(fid, { reason: `Arena match ended (${outcome})`, returnPoint: ret });
      }
    }
    for (const sid of m.spectators.keys()) {
      const sp = ctx.players.get(sid);
      if (sp) notifyPvp(sp, ev);
    }
    ejectSpectators(m, outcome);
    ctx.emit?.('pvpArenaEnded', { matchId: m.id, queueMode: m.queueMode, outcome, winnerId, loserId, ratingChange });
  }

  // ------------------------------------------------------------------ actions

  function joinQueue(p, args = {}) {
    if (!p?.rpg?.character || p.rpg.defeated) throw new Error('You cannot enter the arena queue right now.');
    const custody = ctx.services?.law?.custody?.(p);
    if (custody) throw new Error(custody);
    if (ctx.services?.sailing?.aboard?.(p)) throw new Error('Go ashore before queueing for the arena.');
    if (shared.isInAnyMatch(p.id)) throw new Error('Finish your current PvP engagement first.');
    if (queueEntryOf(p.id)) throw new Error('You are already in an arena queue.');

    const queueMode = args.mode === 'practice' ? 'practice' : 'ranked';
    const rec = ensureRating(p.id, p.name);
    const entry = {
      playerId: p.id,
      accountKey: accountKeyOf(p, ctx),
      name: p.name,
      rating: rec.elo,
      queuedAt: now(),
    };
    queues[queueMode].push(entry);
    ctx.onRollback?.(() => removeFromQueues(p.id));
    notifyPvp(p, { kind: 'pvp.arenaQueued', mode: queueMode, elo: rec.elo, text: `Joined the ${queueMode} 1v1 arena queue (Elo ${rec.elo}).` });
    pushState(p);
    const matched = tryMatchmake(queueMode);
    return { queued: true, mode: queueMode, matched: !!matched, matchId: matched?.id ?? null };
  }

  function leaveQueue(p) {
    const existing = queueEntryOf(p.id);
    if (!existing) throw new Error('You are not in an arena queue.');
    removeFromQueues(p.id);
    notifyPvp(p, { kind: 'pvp.arenaDequeued', text: 'Left the arena queue.' });
    pushState(p);
    return { dequeued: true };
  }

  function acceptMatch(p, args = {}) {
    const ref = playerMatch.get(p.id);
    const m = ref ? matches.get(ref.matchId) : null;
    if (!m || ref.role !== 'fighter' || m.phase !== 'accept') throw new Error('No arena match awaits your acceptance.');
    if (args.matchId && String(args.matchId) !== m.id) throw new Error('No such arena match awaits you.');
    m.accepted[p.id] = true;
    notifyPvp(p, { kind: 'pvp.arenaAccepted', matchId: m.id, text: 'Arena match accepted. Waiting for opponent...' });
    if (m.fighters.every((fid) => m.accepted[fid])) {
      enterArenaScene(m);
    } else {
      for (const fid of m.fighters) {
        const fp = ctx.players.get(fid);
        if (fp) pushState(fp);
      }
    }
    return matchPublicView(m, p.id);
  }

  function declineMatch(p) {
    const ref = playerMatch.get(p.id);
    const m = ref ? matches.get(ref.matchId) : null;
    if (!m || ref.role !== 'fighter' || m.phase !== 'accept') throw new Error('No pending arena match to decline.');
    finishMatch(m, { outcome: 'cancelled', reason: `${p.name} declined` });
    return { declined: true };
  }

  function forfeit(p) {
    const ref = playerMatch.get(p.id);
    const m = ref ? matches.get(ref.matchId) : null;
    if (!m || ref.role !== 'fighter' || (m.phase !== 'countdown' && m.phase !== 'active')) {
      throw new Error('You are not fighting in an arena match.');
    }
    const winnerId = m.fighters.find((id) => id !== p.id);
    finishMatch(m, { winnerId, loserId: p.id, outcome: 'forfeit', reason: `${p.name} surrendered` });
    return { forfeited: true, matchId: m.id };
  }

  function spectate(p, args = {}) {
    if (!p?.rpg?.character || p.rpg.defeated) throw new Error('You cannot spectate right now.');
    if (shared.isInAnyMatch(p.id)) throw new Error('Leave your current PvP engagement before spectating.');
    if (queueEntryOf(p.id)) removeFromQueues(p.id);
    const matchId = args.matchId ? String(args.matchId) : [...matches.values()].find((m) => m.phase === 'active' || m.phase === 'countdown')?.id;
    const m = matchId ? matches.get(matchId) : null;
    if (!m || (m.phase !== 'countdown' && m.phase !== 'active')) {
      throw new Error('There is no active arena match to spectate.');
    }
    const ret = captureReturn(p);
    m.spectators.set(p.id, ret);
    playerMatch.set(p.id, { matchId: m.id, role: 'spectator' });
    p.rpg.pvpArenaReturn = { matchId: m.id, spectator: true, ...ret };
    relocatePlayer(p, { location: cfg.arenaLocation, ...cfg.arenaSpectatorSpot });
    ctx.dirty?.(p);
    const view = matchPublicView(m, p.id);
    notifyPvp(p, { kind: 'pvp.arenaSpectating', match: view, text: `Entered the Grand Arena gallery for ${m.names[m.fighters[0]]} vs ${m.names[m.fighters[1]]}.` });
    pushState(p);
    return view;
  }

  function leaveSpectate(p) {
    const ref = playerMatch.get(p.id);
    if (!ref || ref.role !== 'spectator') throw new Error('You are not spectating an arena match.');
    const m = matches.get(ref.matchId);
    const ret = m?.spectators.get(p.id) ?? p.rpg?.pvpArenaReturn;
    m?.spectators.delete(p.id);
    playerMatch.delete(p.id);
    delete p.rpg.pvpArenaReturn;
    if (ret) relocatePlayer(p, { location: ret.location, x: ret.x, z: ret.z, yaw: ret.yaw });
    ctx.dirty?.(p);
    notifyPvp(p, { kind: 'pvp.arenaSpectateEnd', matchId: ref.matchId, text: 'You left the arena spectator gallery.' });
    pushState(p);
    return { left: true };
  }

  function leaderboard(limit = 20) {
    return [...ratings.values()]
      .sort((a, b) => b.elo - a.elo || b.wins - a.wins || a.id - b.id)
      .slice(0, Math.max(1, Math.min(50, limit)));
  }

  // ------------------------------------------------------------------ combat & lifecycle hooks

  function onFighterDefeated(defender, attacker) {
    const ref = playerMatch.get(defender.id);
    if (!ref || ref.role !== 'fighter') return false;
    const m = matches.get(ref.matchId);
    if (!m || m.phase !== 'active') return false;
    const winnerId = m.fighters.find((id) => id !== defender.id) ?? attacker?.id ?? null;
    finishMatch(m, { winnerId, loserId: defender.id, outcome: 'win', reason: `${defender.name} defeated` });
    return true;
  }

  function checkConsumableAllowance(p) {
    const ref = playerMatch.get(p.id);
    if (!ref || ref.role !== 'fighter') return { allowed: true };
    const m = matches.get(ref.matchId);
    if (!m) return { allowed: true };
    const used = m.consumablesUsed[p.id] ?? 0;
    if (used >= cfg.arenaConsumableAllowance) {
      return { allowed: false, reason: `Arena consumable allowance reached (${cfg.arenaConsumableAllowance}).` };
    }
    m.consumablesUsed[p.id] = used + 1;
    return { allowed: true, remaining: cfg.arenaConsumableAllowance - m.consumablesUsed[p.id] };
  }

  function tick(_dt, t) {
    for (const m of [...matches.values()]) {
      if (m.phase === 'ended') continue;
      if (m.phase === 'accept') {
        if (t >= m.acceptDeadline) {
          finishMatch(m, { outcome: 'cancelled', reason: 'acceptance timed out' });
        }
        continue;
      }
      if (m.phase === 'countdown' && t >= m.startsAt) {
        m.phase = 'active';
        const view = matchPublicView(m);
        for (const fid of m.fighters) {
          const fp = ctx.players.get(fid);
          if (fp) {
            notifyPvp(fp, { kind: 'pvp.arenaStart', match: view, text: 'Fight! The arena gates are open.' });
            pushState(fp);
          }
        }
        for (const sid of m.spectators.keys()) {
          const sp = ctx.players.get(sid);
          if (sp) notifyPvp(sp, { kind: 'pvp.arenaStart', match: view });
        }
      }
      // Disconnect grace window
      for (const fid of m.fighters) {
        const at = m.disconnectedAt[fid];
        if (at != null && t - at >= cfg.arenaDisconnectGraceMs) {
          const otherId = m.fighters.find((id) => id !== fid);
          if (m.disconnectedAt[otherId] != null) {
            finishMatch(m, { outcome: 'draw', reason: 'both fighters disconnected' });
          } else {
            finishMatch(m, { winnerId: otherId, loserId: fid, outcome: 'forfeit', reason: `${m.names[fid]} disconnected` });
          }
          break;
        }
      }
      if (m.phase === 'ended') continue;
      if (m.phase === 'active' && t >= m.endsAt) {
        finishMatch(m, { outcome: 'draw', reason: 'time limit reached' });
      }
    }
  }

  function onLeave(p) {
    removeFromQueues(p.id);
    const ref = playerMatch.get(p.id);
    if (!ref) return;
    const m = matches.get(ref.matchId);
    if (!m || m.phase === 'ended') {
      playerMatch.delete(p.id);
      return;
    }
    if (ref.role === 'spectator') {
      m.spectators.delete(p.id);
      playerMatch.delete(p.id);
      return;
    }
    if (m.phase === 'accept') {
      finishMatch(m, { outcome: 'cancelled', reason: `${p.name} left` });
      return;
    }
    m.disconnectedAt[p.id] = now();
    const other = ctx.players.get(m.fighters.find((id) => id !== p.id));
    if (other) {
      notifyPvp(other, { kind: 'pvp.arenaOpponentDisconnected', matchId: m.id, graceMs: cfg.arenaDisconnectGraceMs, text: `${p.name} disconnected from the arena.` });
      pushState(other);
    }
  }

  function onJoin(p) {
    const ref = playerMatch.get(p.id);
    const m = ref ? matches.get(ref.matchId) : null;
    if (m && m.phase !== 'ended' && ref.role === 'fighter') {
      delete m.disconnectedAt[p.id];
      notifyPvp(p, { kind: 'pvp.arenaRejoined', match: matchPublicView(m, p.id), text: 'You rejoined your active arena match.' });
      return;
    }
    // Restart recovery: return player stuck in arena scene back to return point
    const ret = p.rpg?.pvpArenaReturn;
    if (ret || locationOf(p) === cfg.arenaLocation) {
      const landing = ret
        ? { location: ret.location, x: ret.x, z: ret.z, yaw: ret.yaw ?? 0 }
        : { location: cfg.districtSafeExitLocation, ...cfg.districtSafeExitSpot };
      delete p.rpg.pvpArenaReturn;
      relocatePlayer(p, landing);
      ctx.dirty?.(p);
      notifyPvp(p, { kind: 'pvp.arenaVoided', text: 'Your interrupted arena match was voided; you have been returned safely.' });
    }
  }

  function onPurge(characterId) {
    removeFromQueues(characterId);
    const ref = playerMatch.get(characterId);
    if (ref) {
      const m = matches.get(ref.matchId);
      if (m && m.phase !== 'ended') {
        if (ref.role === 'spectator') m.spectators.delete(characterId);
        else {
          const otherId = m.fighters.find((id) => id !== characterId);
          finishMatch(m, { winnerId: otherId, loserId: characterId, outcome: 'forfeit', reason: 'character removed' });
        }
      }
      playerMatch.delete(characterId);
    }
    ratings.delete(characterId);
  }

  function presenceScopeOf(p) {
    const ref = playerMatch.get(p?.id);
    if (!ref) return null;
    const m = matches.get(ref.matchId);
    if (!m || m.phase === 'ended' || m.phase === 'accept') return null;
    return m.scope;
  }

  function engagementOf(p) {
    const ref = playerMatch.get(p?.id);
    if (!ref) return null;
    const m = matches.get(ref.matchId);
    if (!m || m.phase === 'ended' || m.phase === 'accept') return null;
    return {
      mode: 'arena',
      matchId: m.id,
      phase: m.phase,
      role: ref.role,
    };
  }

  function blockerFor(characterId) {
    const ref = playerMatch.get(characterId);
    if (ref && ref.role === 'fighter') {
      const m = matches.get(ref.matchId);
      if (m && m.phase !== 'ended') {
        return {
          code: 'PVP_ARENA_ACTIVE',
          message: 'Complete or forfeit your active Arena match before archiving or switching characters.',
          route: 'pvp',
        };
      }
    }
    return null;
  }

  function stateFor(p) {
    const ref = playerMatch.get(p.id);
    const active = ref ? matchPublicView(matches.get(ref.matchId), p.id) : null;
    const liveMatches = [...matches.values()]
      .filter((m) => m.phase === 'active' || m.phase === 'countdown')
      .map((m) => matchPublicView(m, p.id));
    return {
      queue: queueEntryOf(p.id),
      queueCounts: { ranked: queues.ranked.length, practice: queues.practice.length },
      activeMatch: active,
      rating: ensureRating(p.id, p.name),
      leaderboard: leaderboard(15),
      liveMatches,
      recentHistory: history.slice(-10).reverse(),
    };
  }

  return {
    joinQueue,
    leaveQueue,
    acceptMatch,
    declineMatch,
    forfeit,
    spectate,
    leaveSpectate,
    leaderboard,
    onFighterDefeated,
    checkConsumableAllowance,
    tick,
    onLeave,
    onJoin,
    onPurge,
    presenceScopeOf,
    engagementOf,
    blockerFor,
    stateFor,
    matches,
    queues,
    ratings,
    history,
  };
}
