// Consent Duels (Land PvP §4):
//   - Invite / accept / decline / cancel / forfeit honoring `services.isBlocked` and `services.canInteract`.
//   - Permitted outdoor spaces only (blocks interiors, dungeons, arena/siege scenes, and ships).
//   - Countdown timer, ring boundary with out-of-bounds countdown/forfeit.
//   - Temporary combat state with consumable allowance & inventory/equipment mutation lock during duel.
//   - Non-lethal 1 HP finish (no death penalty or item loss), normal vitals & return point restoration.
//   - Disconnect rejoin grace window before forfeit; server restart/interruption voids cleanly.

import { randomBytes } from 'node:crypto';
import { PVP_WORLD_KEYS, accountKeyOf, dist2d, sameAccount } from './policy.js';

const newDuelId = () => `duel_${randomBytes(5).toString('hex')}`;

function isOutdoorPermitted(location, ctx) {
  if (!location || typeof location !== 'string') return false;
  const kind = location.split(':')[0].toLowerCase();
  if (kind !== 'town' && kind !== 'wilderness') return false;
  if (ctx.services?.sailing?.aboard?.({ rpg: { location } })) return false;
  return true;
}

export function createDuelsManager(ctx, cfg, shared) {
  const { durable, notifyPvp, pushState } = shared;
  const now = () => (typeof ctx.now === 'function' ? ctx.now() : Date.now());
  const locationOf = (p) => (typeof ctx.location === 'function' ? ctx.location(p) : p?.rpg?.location);

  const invites = new Map(); // inviteId -> { id, fromId, toId, fromName, toName, location, center, radius, createdAt, expiresAt }
  const matches = new Map(); // matchId -> duelRecord
  const playerDuel = new Map(); // playerId -> matchId
  const duelStats = new Map(); // charId -> { wins, losses, draws, lastAt }

  // Load persisted duel stats
  for (const [key, val] of ctx.loadWorld?.(PVP_WORLD_KEYS.duelStats) ?? []) {
    if (key === PVP_WORLD_KEYS.duelStats && val && typeof val === 'object') {
      for (const [cid, rec] of Object.entries(val)) {
        if (rec && typeof rec === 'object') duelStats.set(Number(cid), { ...rec });
      }
    }
  }

  function statsSnapshot() {
    const out = {};
    for (const [cid, rec] of duelStats) out[String(cid)] = rec;
    return out;
  }

  function recordOutcomeStats(winnerId, loserId, isDraw, matchId) {
    const ts = new Date().toISOString();
    const bump = (id, field) => {
      if (!Number.isSafeInteger(id)) return;
      const cur = duelStats.get(id) ?? { wins: 0, losses: 0, draws: 0, lastAt: null };
      cur[field] += 1;
      cur.lastAt = ts;
      duelStats.set(id, cur);
    };
    if (isDraw) {
      bump(winnerId, 'draws');
      bump(loserId, 'draws');
    } else {
      bump(winnerId, 'wins');
      bump(loserId, 'losses');
    }
    durable.persist(
      `pvp:duel:result:${matchId}`,
      { characterIds: [winnerId, loserId].filter(Number.isSafeInteger) },
      PVP_WORLD_KEYS.duelStats,
      statsSnapshot(),
    );
  }

  function duelOf(playerId) {
    const id = playerDuel.get(playerId);
    return id ? matches.get(id) ?? null : null;
  }

  function captureVitals(p) {
    const c = p?.rpg?.character;
    return {
      health: c?.health ?? 50,
      maxHealth: c?.maxHealth ?? 50,
      fatigue: c?.fatigue ?? 50,
      maxFatigue: c?.maxFatigue ?? 50,
      magicka: c?.magicka ?? 50,
      maxMagicka: c?.maxMagicka ?? 50,
      x: p.x,
      z: p.z,
      yaw: p.yaw ?? 0,
      location: locationOf(p),
    };
  }

  function restoreVitals(p, snap) {
    if (!p || !snap) return;
    const c = p.rpg?.character;
    if (c) {
      c.health = Math.max(1, Math.min(c.maxHealth ?? snap.maxHealth, snap.health));
      if (Number.isFinite(snap.fatigue) && Number.isFinite(c.maxFatigue)) {
        c.fatigue = Math.max(0, Math.min(c.maxFatigue, snap.fatigue));
      }
      if (Number.isFinite(snap.magicka) && Number.isFinite(c.maxMagicka)) {
        c.magicka = Math.max(0, Math.min(c.maxMagicka, snap.magicka));
      }
    }
    if (p.rpg?.defeated) delete p.rpg.defeated;
    if (locationOf(p) === snap.location && Number.isFinite(snap.x) && Number.isFinite(snap.z)) {
      p.x = snap.x;
      p.z = snap.z;
    }
    delete p.rpg?.pvpDuelLock;
    ctx.dirty?.(p);
  }

  function clearInvitesFor(playerId, reason = null) {
    for (const [id, inv] of [...invites]) {
      if (inv.fromId === playerId || inv.toId === playerId) {
        invites.delete(id);
        if (reason) {
          const from = ctx.players.get(inv.fromId);
          const to = ctx.players.get(inv.toId);
          if (from) notifyPvp(from, { kind: 'pvp.duelInviteCancelled', inviteId: id, reason });
          if (to) notifyPvp(to, { kind: 'pvp.duelInviteCancelled', inviteId: id, reason });
        }
      }
    }
  }

  function duelPublicView(m, viewerId = null) {
    if (!m) return null;
    const t = now();
    const oob = {};
    for (const pid of m.participants) {
      const since = m.oobSince[pid];
      if (since != null) {
        oob[pid] = Math.max(0, Math.ceil((cfg.duelOobGraceMs - (t - since)) / 1000));
      }
    }
    return {
      id: m.id,
      phase: m.phase,
      location: m.location,
      center: m.center,
      radius: m.radius,
      participants: m.participants.map((pid) => ({
        id: pid,
        name: m.names[pid],
        hp: ctx.players.get(pid)?.rpg?.character?.health ?? 0,
        maxHp: ctx.players.get(pid)?.rpg?.character?.maxHealth ?? 50,
        disconnected: m.disconnectedAt[pid] != null,
        oobRemainingSec: oob[pid] ?? null,
        consumablesUsed: m.consumablesUsed[pid] ?? 0,
        consumablesMax: cfg.duelConsumableAllowance,
      })),
      countdownMsLeft: m.phase === 'countdown' ? Math.max(0, m.startsAt - t) : 0,
      timeRemainingMs: m.phase === 'active' ? Math.max(0, m.endsAt - t) : cfg.duelMaxDurationMs,
      isParticipant: viewerId != null && m.participants.includes(viewerId),
    };
  }

  function finishDuel(m, { winnerId = null, loserId = null, outcome = 'win', reason = '' } = {}) {
    if (!m || m.phase === 'ended') return;
    m.phase = 'ended';
    m.endedAt = now();
    matches.delete(m.id);
    for (const pid of m.participants) {
      playerDuel.delete(pid);
      const p = ctx.players.get(pid);
      if (p) {
        restoreVitals(p, m.savedVitals[pid]);
      } else {
        // Store pending restoration for disconnected participant when they rejoin.
        shared.storePendingRestore(pid, {
          reason: `Duel ended (${reason || outcome})`,
          vitals: m.savedVitals[pid],
        });
      }
    }
    if (outcome !== 'void') {
      if (outcome === 'draw') {
        recordOutcomeStats(m.participants[0], m.participants[1], true, m.id);
      } else if (winnerId != null && loserId != null) {
        recordOutcomeStats(winnerId, loserId, false, m.id);
      }
    }
    const winnerName = winnerId != null ? m.names[winnerId] : null;
    const loserName = loserId != null ? m.names[loserId] : null;
    const text = outcome === 'void'
      ? `Duel voided: ${reason || 'interrupted'}. Both fighters restored.`
      : outcome === 'draw'
        ? `Duel between ${m.names[m.participants[0]]} and ${m.names[m.participants[1]]} ended in a draw (${reason}).`
        : `${winnerName} wins the duel against ${loserName}${reason ? ` (${reason})` : ''}!`;

    const ev = {
      kind: 'pvp.duelEnd',
      matchId: m.id,
      outcome,
      winnerId,
      winnerName,
      loserId,
      loserName,
      reason,
      text,
    };
    ctx.nearby?.(m.location, ev);
    for (const pid of m.participants) {
      const p = ctx.players.get(pid);
      if (p) pushState(p);
    }
    ctx.emit?.('pvpDuelEnded', { matchId: m.id, outcome, winnerId, loserId, reason });
  }

  // ------------------------------------------------------------------ actions

  function invite(p, args = {}) {
    if (!p?.rpg?.character || p.rpg.defeated) throw new Error('You cannot duel right now.');
    const targetId = Number(args.targetId);
    if (!Number.isSafeInteger(targetId) || targetId === p.id) throw new Error('Choose another nearby traveller to challenge.');
    const target = ctx.players.get(targetId);
    if (!target || target.arriving || !target.rpg?.character || target.rpg.defeated) {
      throw new Error('That traveller is not available to duel.');
    }
    if (sameAccount(p, target, ctx)) throw new Error('You cannot duel another character on your own account.');
    if (ctx.services?.sailing?.aboard?.(p) || ctx.services?.sailing?.aboard?.(target)) {
      throw new Error('Land duels cannot be started aboard a ship.');
    }
    const loc = locationOf(p);
    if (loc !== locationOf(target) || ctx.sameScene?.(p, target) === false) {
      throw new Error('You must be in the same location to challenge someone.');
    }
    if (!isOutdoorPermitted(loc, ctx)) {
      throw new Error('Consent duels are only permitted in outdoor towns or wilderness.');
    }
    if (dist2d(p, target) > cfg.duelInviteRange) {
      throw new Error(`${target.name} is too far away to challenge.`);
    }
    if (shared.isInAnyMatch(p.id)) throw new Error('You are already engaged in a PvP match.');
    if (shared.isInAnyMatch(target.id)) throw new Error(`${target.name} is already engaged in a PvP match.`);

    // Honor directed blocks & social canInteract without leaking block status!
    if (typeof ctx.services?.canInteract === 'function') {
      const check = ctx.services.canInteract(p, target, 'duel');
      if (!check.ok) throw new Error(check.reason || 'That player is not accepting duel challenges right now.');
    } else if (ctx.services?.isBlocked?.(p, target)) {
      throw new Error('That player is not accepting duel challenges right now.');
    }

    // Deduplicate pending invite between same pair
    for (const inv of invites.values()) {
      if ((inv.fromId === p.id && inv.toId === target.id) || (inv.fromId === target.id && inv.toId === p.id)) {
        throw new Error('A duel challenge is already pending between you.');
      }
    }

    const t = now();
    const inv = {
      id: newDuelId(),
      fromId: p.id,
      toId: target.id,
      fromName: p.name,
      toName: target.name,
      location: loc,
      center: { x: Math.round(((p.x + target.x) / 2) * 100) / 100, z: Math.round(((p.z + target.z) / 2) * 100) / 100 },
      radius: cfg.duelRingRadius,
      createdAt: t,
      expiresAt: t + cfg.duelInviteTtlMs,
    };
    invites.set(inv.id, inv);
    ctx.onRollback?.(() => invites.delete(inv.id));

    notifyPvp(p, { kind: 'pvp.duelInviteSent', invite: inv, text: `You challenged ${target.name} to a duel.` });
    notifyPvp(target, { kind: 'pvp.duelInvite', invite: inv, text: `${p.name} challenges you to a duel!` });
    pushState(p);
    pushState(target);
    return inv;
  }

  function accept(p, args = {}) {
    const inv = args.inviteId
      ? invites.get(String(args.inviteId))
      : [...invites.values()].find((x) => x.toId === p.id);
    if (!inv || inv.toId !== p.id) throw new Error('No such duel challenge awaits you.');
    const t = now();
    if (t >= inv.expiresAt) {
      invites.delete(inv.id);
      throw new Error('That duel challenge has expired.');
    }
    const challenger = ctx.players.get(inv.fromId);
    if (!challenger || challenger.arriving || challenger.rpg?.defeated) {
      invites.delete(inv.id);
      throw new Error('Your challenger is no longer available.');
    }
    if (ctx.services?.isBlocked?.(p, challenger)) {
      invites.delete(inv.id);
      throw new Error('That duel challenge is no longer available.');
    }
    const loc = locationOf(p);
    if (loc !== inv.location || locationOf(challenger) !== inv.location || !isOutdoorPermitted(loc, ctx)) {
      invites.delete(inv.id);
      throw new Error('Both fighters must remain in the same permitted outdoor area.');
    }
    if (dist2d(p, challenger) > cfg.duelInviteRange * 1.25) {
      throw new Error('Move closer to your challenger to accept the duel.');
    }
    if (shared.isInAnyMatch(p.id) || shared.isInAnyMatch(challenger.id)) {
      invites.delete(inv.id);
      throw new Error('One of the fighters is already in a PvP match.');
    }

    invites.delete(inv.id);
    clearInvitesFor(p.id);
    clearInvitesFor(challenger.id);

    const center = {
      x: Math.round(((challenger.x + p.x) / 2) * 100) / 100,
      z: Math.round(((challenger.z + p.z) / 2) * 100) / 100,
    };
    const match = {
      id: newDuelId(),
      mode: 'duel',
      phase: 'countdown',
      location: loc,
      center,
      radius: cfg.duelRingRadius,
      participants: [challenger.id, p.id],
      names: { [challenger.id]: challenger.name, [p.id]: p.name },
      accountKeys: { [challenger.id]: accountKeyOf(challenger, ctx), [p.id]: accountKeyOf(p, ctx) },
      savedVitals: { [challenger.id]: captureVitals(challenger), [p.id]: captureVitals(p) },
      oobSince: {},
      disconnectedAt: {},
      consumablesUsed: { [challenger.id]: 0, [p.id]: 0 },
      createdAt: t,
      startsAt: t + cfg.duelCountdownMs,
      endsAt: t + cfg.duelCountdownMs + cfg.duelMaxDurationMs,
    };

    matches.set(match.id, match);
    playerDuel.set(challenger.id, match.id);
    playerDuel.set(p.id, match.id);
    ctx.dirty?.(challenger);
    ctx.dirty?.(p);
    challenger.rpg.pvpDuelLock = match.id;
    p.rpg.pvpDuelLock = match.id;

    ctx.onRollback?.(() => {
      matches.delete(match.id);
      playerDuel.delete(challenger.id);
      playerDuel.delete(p.id);
      delete challenger.rpg.pvpDuelLock;
      delete p.rpg.pvpDuelLock;
    });

    const view = duelPublicView(match);
    ctx.nearby?.(loc, {
      kind: 'pvp.duelCountdown',
      duel: view,
      text: `Duel starting between ${challenger.name} and ${p.name} in ${Math.ceil(cfg.duelCountdownMs / 1000)}s!`,
    });
    pushState(challenger);
    pushState(p);
    return view;
  }

  function decline(p, args = {}) {
    const inv = args.inviteId
      ? invites.get(String(args.inviteId))
      : [...invites.values()].find((x) => x.toId === p.id || x.fromId === p.id);
    if (!inv || (inv.toId !== p.id && inv.fromId !== p.id)) throw new Error('No pending duel challenge found.');
    invites.delete(inv.id);
    const otherId = inv.fromId === p.id ? inv.toId : inv.fromId;
    const other = ctx.players.get(otherId);
    const label = inv.toId === p.id ? `${p.name} declined the duel challenge.` : `${p.name} withdrew the duel challenge.`;
    notifyPvp(p, { kind: 'pvp.duelDeclined', inviteId: inv.id, text: label });
    if (other) notifyPvp(other, { kind: 'pvp.duelDeclined', inviteId: inv.id, text: label });
    pushState(p);
    if (other) pushState(other);
    return { declined: true, inviteId: inv.id };
  }

  function forfeit(p) {
    const m = duelOf(p.id);
    if (!m || m.phase === 'ended') throw new Error('You are not in an active duel.');
    const winnerId = m.participants.find((id) => id !== p.id);
    finishDuel(m, { winnerId, loserId: p.id, outcome: 'forfeit', reason: `${p.name} forfeited` });
    return { forfeited: true, matchId: m.id };
  }

  // ------------------------------------------------------------------ combat hooks

  function onNonLethalFinish(defender, attacker) {
    const m = duelOf(defender.id);
    if (!m || m.phase !== 'active') return false;
    const winnerId = m.participants.find((id) => id !== defender.id) ?? attacker?.id ?? null;
    finishDuel(m, { winnerId, loserId: defender.id, outcome: 'win', reason: 'yielded at 1 HP' });
    return true;
  }

  function checkConsumableAllowance(p) {
    const m = duelOf(p.id);
    if (!m) return { allowed: true };
    const used = m.consumablesUsed[p.id] ?? 0;
    if (used >= cfg.duelConsumableAllowance) {
      return { allowed: false, reason: `Duel consumable limit reached (${cfg.duelConsumableAllowance}).` };
    }
    m.consumablesUsed[p.id] = used + 1;
    return { allowed: true, remaining: cfg.duelConsumableAllowance - m.consumablesUsed[p.id] };
  }

  function isInventoryLocked(p) {
    const m = duelOf(p?.id);
    return m ? 'You cannot alter inventory or equipment during an active duel.' : null;
  }

  // ------------------------------------------------------------------ tick & lifecycle

  function tick(_dt, t) {
    // Expire stale invites
    for (const [id, inv] of [...invites]) {
      if (t >= inv.expiresAt) {
        invites.delete(id);
        const from = ctx.players.get(inv.fromId);
        const to = ctx.players.get(inv.toId);
        if (from) {
          notifyPvp(from, { kind: 'pvp.duelInviteExpired', inviteId: id, text: `Duel challenge to ${inv.toName} expired.` });
          pushState(from);
        }
        if (to) {
          notifyPvp(to, { kind: 'pvp.duelInviteExpired', inviteId: id, text: `Duel challenge from ${inv.fromName} expired.` });
          pushState(to);
        }
      }
    }

    for (const m of [...matches.values()]) {
      if (m.phase === 'ended') continue;

      // Countdown -> Active transition
      if (m.phase === 'countdown' && t >= m.startsAt) {
        m.phase = 'active';
        ctx.nearby?.(m.location, {
          kind: 'pvp.duelStart',
          duel: duelPublicView(m),
          text: `Duel begun! ${m.names[m.participants[0]]} vs ${m.names[m.participants[1]]}!`,
        });
        for (const pid of m.participants) {
          const p = ctx.players.get(pid);
          if (p) pushState(p);
        }
      }

      // Disconnect grace timer
      let disconnCount = 0;
      for (const pid of m.participants) {
        const at = m.disconnectedAt[pid];
        if (at != null) {
          disconnCount += 1;
          if (t - at >= cfg.duelDisconnectGraceMs) {
            const otherId = m.participants.find((id) => id !== pid);
            if (m.disconnectedAt[otherId] != null) {
              finishDuel(m, { outcome: 'draw', reason: 'both fighters disconnected' });
            } else {
              finishDuel(m, { winnerId: otherId, loserId: pid, outcome: 'forfeit', reason: `${m.names[pid]} failed to rejoin in time` });
            }
            break;
          }
        }
      }
      if (m.phase === 'ended' || disconnCount === 2) continue;

      // Time limit -> draw
      if (m.phase === 'active' && t >= m.endsAt) {
        finishDuel(m, { outcome: 'draw', reason: 'time limit reached' });
        continue;
      }

      // Ring boundary check (both countdown & active)
      for (const pid of m.participants) {
        if (m.disconnectedAt[pid] != null) continue;
        const p = ctx.players.get(pid);
        if (!p) continue;
        const leftScene = locationOf(p) !== m.location;
        const outside = leftScene || dist2d(p, m.center) > m.radius;
        if (outside) {
          if (m.oobSince[pid] == null) {
            m.oobSince[pid] = t;
            notifyPvp(p, {
              kind: 'pvp.duelOutOfBounds',
              matchId: m.id,
              graceMs: cfg.duelOobGraceMs,
              text: `Return to the duel ring within ${Math.ceil(cfg.duelOobGraceMs / 1000)}s or forfeit!`,
            });
            pushState(p);
          } else if (t - m.oobSince[pid] >= cfg.duelOobGraceMs || leftScene) {
            const otherId = m.participants.find((id) => id !== pid);
            finishDuel(m, { winnerId: otherId, loserId: pid, outcome: 'forfeit', reason: `${m.names[pid]} left the duel ring` });
            break;
          }
        } else if (m.oobSince[pid] != null) {
          delete m.oobSince[pid];
          notifyPvp(p, { kind: 'pvp.duelInBounds', matchId: m.id, text: 'You returned inside the duel ring.' });
          pushState(p);
        }
      }
    }
  }

  function onLeave(p) {
    clearInvitesFor(p.id, 'player disconnected');
    const m = duelOf(p.id);
    if (!m || m.phase === 'ended') return;
    m.disconnectedAt[p.id] = now();
    const otherId = m.participants.find((id) => id !== p.id);
    const other = ctx.players.get(otherId);
    if (other) {
      notifyPvp(other, {
        kind: 'pvp.duelOpponentDisconnected',
        matchId: m.id,
        graceMs: cfg.duelDisconnectGraceMs,
        text: `${p.name} disconnected. Waiting ${Math.ceil(cfg.duelDisconnectGraceMs / 1000)}s for rejoin.`,
      });
      pushState(other);
    }
  }

  function onJoin(p) {
    const m = duelOf(p.id);
    if (m && m.phase !== 'ended') {
      if (m.disconnectedAt[p.id] != null) {
        delete m.disconnectedAt[p.id];
        p.rpg.pvpDuelLock = m.id;
        notifyPvp(p, { kind: 'pvp.duelRejoined', duel: duelPublicView(m, p.id), text: 'You rejoined your active duel!' });
        const other = ctx.players.get(m.participants.find((id) => id !== p.id));
        if (other) {
          notifyPvp(other, { kind: 'pvp.duelOpponentRejoined', matchId: m.id, text: `${p.name} rejoined the duel!` });
          pushState(other);
        }
      }
      return;
    }
    // Server restart recovery: player had a duel lock saved on disk before restart -> void & clear cleanly.
    if (p.rpg?.pvpDuelLock) {
      delete p.rpg.pvpDuelLock;
      ctx.dirty?.(p);
      notifyPvp(p, { kind: 'pvp.duelVoided', text: 'Your previous duel was voided by a server restart; your state has been restored.' });
    }
  }

  function onPurge(characterId) {
    clearInvitesFor(characterId, 'character purged');
    const m = duelOf(characterId);
    if (m && m.phase !== 'ended') {
      const winnerId = m.participants.find((id) => id !== characterId);
      finishDuel(m, { winnerId, loserId: characterId, outcome: 'forfeit', reason: 'character removed' });
    }
    duelStats.delete(characterId);
  }

  function engagementOf(p) {
    const m = duelOf(p.id);
    if (!m || m.phase === 'ended') return null;
    return {
      mode: 'duel',
      matchId: m.id,
      phase: m.phase,
      outOfBounds: m.oobSince[p.id] != null || dist2d(p, m.center) > m.radius,
    };
  }

  function blockerFor(characterId) {
    const m = duelOf(characterId);
    if (!m || m.phase === 'ended') return null;
    return {
      code: 'PVP_DUEL_ACTIVE',
      message: 'Finish or forfeit your active duel before archiving or switching characters.',
      route: 'pvp',
    };
  }

  function stateFor(p) {
    const m = duelOf(p.id);
    const incoming = [...invites.values()].filter((i) => i.toId === p.id);
    const outgoing = [...invites.values()].filter((i) => i.fromId === p.id);
    return {
      active: duelPublicView(m, p.id),
      incomingInvites: incoming,
      outgoingInvites: outgoing,
      stats: duelStats.get(p.id) ?? { wins: 0, losses: 0, draws: 0, lastAt: null },
    };
  }

  return {
    invite,
    accept,
    decline,
    forfeit,
    duelOf,
    engagementOf,
    onNonLethalFinish,
    checkConsumableAllowance,
    isInventoryLocked,
    tick,
    onLeave,
    onJoin,
    onPurge,
    blockerFor,
    stateFor,
    voidAllOnShutdown: () => {
      for (const m of [...matches.values()]) finishDuel(m, { outcome: 'void', reason: 'server interruption' });
    },
    matches,
    invites,
  };
}
