// Scheduled Order Sieges (Land PvP §4):
//   - Pilot contested seat (`Castle Gothway`, `keep:iliac-bay/castle-gothway`).
//   - Scheduled attack/defense windows with order registration (requires Leader/Officer or siegeRegister permission).
//   - Frozen eligible rosters at lock time (late-joining order members cannot enter after lock).
//   - Capped teams, rally points, capture point progress, attacker vs defender scoring in an isolated battle scene.
//   - Attackers hold capture point to 100% to win; defenders win if timer expires.
//   - Persistent keep tenure, standings, and capped prestige / cosmetic heraldry via `runDurable`.

import { randomBytes } from 'node:crypto';
import { PVP_WORLD_KEYS, dist2d } from './policy.js';

const newSiegeId = () => `siege_${randomBytes(5).toString('hex')}`;

export function createSiegeManager(ctx, cfg, shared) {
  const { durable, notifyPvp, pushState, relocatePlayer } = shared;
  const now = () => (typeof ctx.now === 'function' ? ctx.now() : Date.now());
  const locationOf = (p) => (typeof ctx.location === 'function' ? ctx.location(p) : p?.rpg?.location);

  const sieges = new Map(); // siegeId -> siegeRecord
  const activeParticipants = new Map(); // playerId -> { siegeId, team: 'attacker'|'defender', returnPoint }
  const respawnProtectUntil = new Map(); // playerId -> monotonic ms

  let tenure = {
    seatId: cfg.siegeSeatId,
    seatName: cfg.siegeSeatName,
    holderOrderId: null,
    holderOrderName: 'Unclaimed Garrison',
    holderOrderTag: null,
    heraldry: 'banner-silver-watch',
    heldSince: null,
    defenses: 0,
    prestige: 0,
  };

  const standings = new Map(); // orderId -> { orderId, orderName, orderTag, wins, losses, captures, defenses, prestige, heraldry }

  // Hydrate persisted siege tenure, schedules, and standings
  const tenureKey = `${PVP_WORLD_KEYS.siegeTenurePrefix}${cfg.siegeSeatId}`;
  for (const [key, val] of ctx.loadWorld?.(PVP_WORLD_KEYS.siegePrefix) ?? []) {
    if (key === tenureKey && val && typeof val === 'object') {
      tenure = { ...tenure, ...val };
    } else if (key === PVP_WORLD_KEYS.siegeStandings && val && typeof val === 'object') {
      for (const [oid, rec] of Object.entries(val)) {
        if (rec && typeof rec === 'object') standings.set(oid, { ...rec });
      }
    } else if (key.startsWith(`${PVP_WORLD_KEYS.siegePrefix}match:`) && val && typeof val === 'object') {
      if (val.phase !== 'ended') {
        sieges.set(val.id, {
          ...val,
          frozenRoster: {
            attacker: Array.isArray(val.frozenRoster?.attacker) ? [...val.frozenRoster.attacker] : [],
            defender: Array.isArray(val.frozenRoster?.defender) ? [...val.frozenRoster.defender] : [],
          },
          onField: { attacker: new Set(), defender: new Set() },
        });
      }
    }
  }

  function standingsSnapshot() {
    const out = {};
    for (const [oid, rec] of standings) out[oid] = rec;
    return out;
  }

  function persistSiege(s) {
    const serial = {
      id: s.id,
      seatId: s.seatId,
      seatName: s.seatName,
      phase: s.phase,
      scope: s.scope,
      lockAt: s.lockAt,
      startAt: s.startAt,
      endAt: s.endAt,
      attackerOrder: s.attackerOrder,
      defenderOrder: s.defenderOrder,
      frozenRoster: {
        attacker: [...(s.frozenRoster?.attacker ?? [])],
        defender: [...(s.frozenRoster?.defender ?? [])],
      },
      captureProgress: s.captureProgress,
      scores: { ...s.scores },
      winnerTeam: s.winnerTeam ?? null,
      winnerOrder: s.winnerOrder ?? null,
      reason: s.reason ?? null,
    };
    durable.persist(
      `pvp:siege:match:${s.id}:${s.phase}:${Math.trunc(s.captureProgress)}`,
      { resourceKey: `${PVP_WORLD_KEYS.siegePrefix}match:${s.id}` },
      `${PVP_WORLD_KEYS.siegePrefix}match:${s.id}`,
      serial,
    );
  }

  function persistTenure(opSuffix) {
    durable.persist(
      `pvp:siege:tenure:${opSuffix}`,
      { resourceKey: tenureKey },
      tenureKey,
      { ...tenure },
    );
  }

  function persistStandings(opSuffix) {
    durable.persist(
      `pvp:siege:standings:${opSuffix}`,
      { resourceKey: PVP_WORLD_KEYS.siegeStandings },
      PVP_WORLD_KEYS.siegeStandings,
      standingsSnapshot(),
    );
  }

  /** Resolves a player's order record from guildhall service (or fallback rpg.playerGuild). */
  function resolveOrder(p) {
    const gh = ctx.services?.guildhall;
    if (gh?.orderOf) {
      const ord = gh.orderOf(p);
      if (ord) {
        const mem = ord.members?.[String(p.id)];
        return {
          id: ord.id,
          name: ord.name,
          tag: ord.tag,
          rank: mem?.rank ?? 'Member',
          permissions: ord.permissions ?? null,
          memberIds: Object.values(ord.members ?? {}).map((m) => Number(m.id)).filter(Number.isSafeInteger),
        };
      }
    }
    const pg = p?.rpg?.playerGuild;
    if (pg && pg.id) {
      return {
        id: pg.id,
        name: pg.name ?? 'Order',
        tag: pg.tag ?? 'ORD',
        rank: pg.rank ?? 'Member',
        permissions: null,
        memberIds: [p.id],
      };
    }
    return null;
  }

  function resolveOrderById(orderId) {
    if (!orderId) return null;
    const ord = ctx.services?.guildhall?.orders?.get?.(orderId);
    if (ord) {
      return {
        id: ord.id,
        name: ord.name,
        tag: ord.tag,
        memberIds: Object.values(ord.members ?? {}).map((m) => Number(m.id)).filter(Number.isSafeInteger),
      };
    }
    // Collect live players matching orderId if guildhall isn't mounted in lightweight fixture
    const ids = [];
    let name = null;
    let tag = null;
    for (const p of ctx.players.values()) {
      if (p.rpg?.playerGuild?.id === orderId) {
        ids.push(p.id);
        name ??= p.rpg.playerGuild.name;
        tag ??= p.rpg.playerGuild.tag;
      }
    }
    if (!ids.length) return null;
    return { id: orderId, name: name ?? 'Order', tag: tag ?? 'ORD', memberIds: ids };
  }

  function canRegisterSiege(p, order) {
    if (!order) return false;
    const gh = ctx.services?.guildhall;
    if (typeof gh?.hasOrderPermission === 'function') {
      return Boolean(gh.hasOrderPermission(p, 'siegeOfficer'));
    }
    if (order.rank === 'Leader' || order.rank === 'Officer') return true;
    if (order.permissions?.siegeRegister?.includes?.(order.rank)) return true;
    if (order.permissions?.[order.rank]?.siegeOfficer === true) return true;
    return false;
  }

  function ensureStanding(ord) {
    if (!ord?.id) return null;
    let rec = standings.get(ord.id);
    if (!rec) {
      rec = {
        orderId: ord.id,
        orderName: ord.name,
        orderTag: ord.tag,
        wins: 0,
        losses: 0,
        captures: 0,
        defenses: 0,
        prestige: 0,
        heraldry: `banner-${String(ord.tag || 'order').toLowerCase()}`,
      };
      standings.set(ord.id, rec);
    } else {
      rec.orderName = ord.name;
      rec.orderTag = ord.tag;
    }
    return rec;
  }

  function siegePublicView(s, viewerId = null) {
    if (!s) return null;
    const t = now();
    const part = viewerId != null ? activeParticipants.get(viewerId) : null;
    return {
      id: s.id,
      seatId: s.seatId,
      seatName: s.seatName,
      phase: s.phase, // 'scheduled' | 'locked' | 'active' | 'ended'
      location: cfg.siegeSceneLocation,
      lockAt: s.lockAt,
      startAt: s.startAt,
      endAt: s.endAt,
      lockInMs: Math.max(0, s.lockAt - t),
      startsInMs: Math.max(0, s.startAt - t),
      timeRemainingMs: s.phase === 'active' ? Math.max(0, s.endAt - t) : Math.max(0, s.endAt - s.startAt),
      attackerOrder: s.attackerOrder,
      defenderOrder: s.defenderOrder,
      frozenRosterCounts: {
        attacker: s.frozenRoster.attacker.length,
        defender: s.frozenRoster.defender.length,
      },
      onFieldCounts: {
        attacker: s.onField.attacker.size,
        defender: s.onField.defender.size,
      },
      teamCap: cfg.siegeTeamCap,
      capturePoint: { ...cfg.siegeCapturePoint, radius: cfg.siegeCaptureRadius },
      captureProgress: Math.round(s.captureProgress * 10) / 10,
      captureGoal: cfg.siegeCaptureGoal,
      scores: { ...s.scores },
      winnerTeam: s.winnerTeam ?? null,
      winnerOrder: s.winnerOrder ?? null,
      myTeam: part && part.siegeId === s.id ? part.team : null,
      eligibleTeam: viewerId != null
        ? (s.frozenRoster.attacker.includes(viewerId) ? 'attacker' : s.frozenRoster.defender.includes(viewerId) ? 'defender' : null)
        : null,
    };
  }

  function freezeRosters(s) {
    if (!s || s.phase !== 'scheduled') return;
    s.phase = 'locked';
    const att = s.attackerOrder ? resolveOrderById(s.attackerOrder.id) : null;
    const def = s.defenderOrder ? resolveOrderById(s.defenderOrder.id) : null;
    const attIds = att?.memberIds ?? s.registeredMembers?.attacker ?? [];
    const defIds = def?.memberIds ?? s.registeredMembers?.defender ?? [];
    // Deduplicate & freeze exact eligible roster at lock time
    s.frozenRoster = {
      attacker: [...new Set(attIds)],
      defender: [...new Set(defIds)],
    };
    persistSiege(s);
    for (const p of ctx.players.values()) {
      const inAtt = s.frozenRoster.attacker.includes(p.id);
      const inDef = s.frozenRoster.defender.includes(p.id);
      if (inAtt || inDef) {
        notifyPvp(p, {
          kind: 'pvp.siegeLocked',
          siege: siegePublicView(s, p.id),
          text: `Siege roster locked for ${s.seatName}! Prepare to rally.`,
        });
        pushState(p);
      }
    }
  }

  function startBattle(s) {
    if (!s || (s.phase !== 'scheduled' && s.phase !== 'locked')) return;
    if (s.phase === 'scheduled') freezeRosters(s);
    s.phase = 'active';
    persistSiege(s);
    for (const p of ctx.players.values()) {
      const inAtt = s.frozenRoster.attacker.includes(p.id);
      const inDef = s.frozenRoster.defender.includes(p.id);
      if (inAtt || inDef) {
        notifyPvp(p, {
          kind: 'pvp.siegeStarted',
          siege: siegePublicView(s, p.id),
          text: `The siege of ${s.seatName} has begun! Enter the battle scene to fight for the keep.`,
        });
        pushState(p);
      }
    }
  }

  function finishSiege(s, winnerTeam, reason) {
    if (!s || s.phase === 'ended') return;
    s.phase = 'ended';
    s.winnerTeam = winnerTeam;
    s.winnerOrder = winnerTeam === 'attacker' ? s.attackerOrder : s.defenderOrder;
    s.reason = reason;

    const attStand = s.attackerOrder ? ensureStanding(s.attackerOrder) : null;
    const defStand = s.defenderOrder ? ensureStanding(s.defenderOrder) : null;

    if (winnerTeam === 'attacker' && s.attackerOrder) {
      tenure = {
        seatId: s.seatId,
        seatName: s.seatName,
        holderOrderId: s.attackerOrder.id,
        holderOrderName: s.attackerOrder.name,
        holderOrderTag: s.attackerOrder.tag,
        heraldry: `banner-${String(s.attackerOrder.tag || 'order').toLowerCase()}`,
        heldSince: new Date().toISOString(),
        defenses: 0,
        prestige: Math.min(cfg.siegePrestigeCap, (attStand?.prestige ?? 0) + 100),
      };
      if (attStand) {
        attStand.wins += 1;
        attStand.captures += 1;
        attStand.prestige = Math.min(cfg.siegePrestigeCap, attStand.prestige + 100);
      }
      if (defStand) defStand.losses += 1;
    } else if (winnerTeam === 'defender') {
      if (s.defenderOrder) {
        tenure = {
          seatId: s.seatId,
          seatName: s.seatName,
          holderOrderId: s.defenderOrder.id,
          holderOrderName: s.defenderOrder.name,
          holderOrderTag: s.defenderOrder.tag,
          heraldry: `banner-${String(s.defenderOrder.tag || 'order').toLowerCase()}`,
          heldSince: tenure.holderOrderId === s.defenderOrder.id && tenure.heldSince ? tenure.heldSince : new Date().toISOString(),
          defenses: (tenure.holderOrderId === s.defenderOrder.id ? tenure.defenses : 0) + 1,
          prestige: Math.min(cfg.siegePrestigeCap, (defStand?.prestige ?? 0) + 75),
        };
        if (defStand) {
          defStand.wins += 1;
          defStand.defenses += 1;
          defStand.prestige = Math.min(cfg.siegePrestigeCap, defStand.prestige + 75);
        }
      }
      if (attStand) attStand.losses += 1;
    }

    persistSiege(s);
    persistTenure(s.id);
    persistStandings(s.id);

    const winLabel = s.winnerOrder ? `[${s.winnerOrder.tag}] ${s.winnerOrder.name}` : winnerTeam === 'defender' ? 'the Garrison' : 'Attackers';
    const ev = {
      kind: 'pvp.siegeEnded',
      siegeId: s.id,
      seatName: s.seatName,
      winnerTeam,
      winnerOrder: s.winnerOrder,
      tenure: { ...tenure },
      reason,
      text: `${winLabel} wins the siege of ${s.seatName} (${reason})!`,
    };

    // Return all combatants from the dedicated siege scene
    for (const [pid, part] of [...activeParticipants]) {
      if (part.siegeId !== s.id) continue;
      activeParticipants.delete(pid);
      s.onField.attacker.delete(pid);
      s.onField.defender.delete(pid);
      const p = ctx.players.get(pid);
      if (p) {
        delete p.rpg.pvpSiegeReturn;
        delete p.rpg.defeated;
        relocatePlayer(p, part.returnPoint);
        ctx.dirty?.(p);
        notifyPvp(p, ev);
        pushState(p);
      } else {
        shared.storePendingRestore(pid, { reason: `Siege ended (${reason})`, returnPoint: part.returnPoint });
      }
    }
    ctx.emit?.('pvpSiegeEnded', { siegeId: s.id, winnerTeam, winnerOrder: s.winnerOrder, tenure: { ...tenure } });
  }

  // ------------------------------------------------------------------ actions

  function schedule(p, args = {}) {
    const t = now();
    const lockDelayMs = Number.isFinite(Number(args.lockDelayMs)) ? Math.max(0, Number(args.lockDelayMs)) : 60_000;
    const startDelayMs = Number.isFinite(Number(args.startDelayMs)) ? Math.max(lockDelayMs, Number(args.startDelayMs)) : lockDelayMs + 30_000;
    const durationMs = Number.isFinite(Number(args.durationMs)) ? Math.max(10_000, Number(args.durationMs)) : cfg.siegeDurationMs;

    // Only one non-ended siege per seat at a time
    for (const existing of sieges.values()) {
      if (existing.seatId === cfg.siegeSeatId && existing.phase !== 'ended') {
        throw new Error(`A siege for ${cfg.siegeSeatName} is already scheduled or active.`);
      }
    }

    const id = newSiegeId();
    const defOrder = tenure.holderOrderId
      ? { id: tenure.holderOrderId, name: tenure.holderOrderName, tag: tenure.holderOrderTag }
      : null;

    const s = {
      id,
      seatId: cfg.siegeSeatId,
      seatName: cfg.siegeSeatName,
      phase: 'scheduled',
      scope: `siege:${id}`,
      lockAt: t + lockDelayMs,
      startAt: t + startDelayMs,
      endAt: t + startDelayMs + durationMs,
      attackerOrder: null,
      defenderOrder: defOrder,
      registeredMembers: { attacker: [], defender: defOrder ? (resolveOrderById(defOrder.id)?.memberIds ?? []) : [] },
      frozenRoster: { attacker: [], defender: [] },
      onField: { attacker: new Set(), defender: new Set() },
      captureProgress: 0,
      scores: { attacker: 0, defender: 0 },
      winnerTeam: null,
      winnerOrder: null,
      reason: null,
    };
    sieges.set(id, s);
    persistSiege(s);
    if (p) {
      notifyPvp(p, { kind: 'pvp.siegeScheduled', siege: siegePublicView(s, p.id), text: `Siege window scheduled for ${s.seatName}.` });
      pushState(p);
    }
    return siegePublicView(s, p?.id);
  }

  function register(p, args = {}) {
    const order = resolveOrder(p);
    if (!order) throw new Error('You must belong to a player Order to register for a siege.');
    if (!canRegisterSiege(p, order)) throw new Error('Only an Order Leader or Officer with siege permission may register for a siege.');

    const siegeId = args.siegeId ? String(args.siegeId) : [...sieges.values()].find((x) => x.phase === 'scheduled')?.id;
    const s = siegeId ? sieges.get(siegeId) : null;
    if (!s) throw new Error('There is no open siege window to register for.');
    if (s.phase !== 'scheduled' || now() >= s.lockAt) {
      throw new Error('Siege registration is closed — rosters are already locked.');
    }

    const side = args.side === 'defender' ? 'defender' : 'attacker';
    if (side === 'attacker') {
      if (s.defenderOrder?.id === order.id) throw new Error('Your order is already registered as defender.');
      if (s.attackerOrder && s.attackerOrder.id !== order.id) throw new Error(`${s.attackerOrder.name} already holds the attacker slot.`);
      s.attackerOrder = { id: order.id, name: order.name, tag: order.tag };
      s.registeredMembers.attacker = [...order.memberIds];
    } else {
      if (s.attackerOrder?.id === order.id) throw new Error('Your order is already registered as attacker.');
      if (s.defenderOrder && s.defenderOrder.id !== order.id) throw new Error(`${s.defenderOrder.name} already holds the defender slot.`);
      s.defenderOrder = { id: order.id, name: order.name, tag: order.tag };
      s.registeredMembers.defender = [...order.memberIds];
    }

    persistSiege(s);
    const view = siegePublicView(s, p.id);
    notifyPvp(p, {
      kind: 'pvp.siegeRegistered',
      siege: view,
      text: `[${order.tag}] ${order.name} registered as ${side} for the siege of ${s.seatName}.`,
    });
    pushState(p);
    return view;
  }

  function enter(p, args = {}) {
    if (!p?.rpg?.character || p.rpg.defeated) throw new Error('You cannot enter the siege right now.');
    const custody = ctx.services?.law?.custody?.(p);
    if (custody) throw new Error(custody);
    if (shared.isInAnyMatch(p.id)) throw new Error('Leave your current PvP match before entering a siege.');

    const siegeId = args.siegeId ? String(args.siegeId) : [...sieges.values()].find((x) => x.phase === 'active' || x.phase === 'locked')?.id;
    const s = siegeId ? sieges.get(siegeId) : null;
    if (!s || (s.phase !== 'active' && s.phase !== 'locked')) {
      throw new Error('There is no active siege battle to enter.');
    }

    let team = null;
    if (s.frozenRoster.attacker.includes(p.id)) team = 'attacker';
    else if (s.frozenRoster.defender.includes(p.id)) team = 'defender';
    if (!team) {
      throw new Error('You are not on the frozen eligible roster for this siege.');
    }

    if (s.onField[team].size >= cfg.siegeTeamCap && !s.onField[team].has(p.id)) {
      throw new Error(`Your siege team is at capacity (${cfg.siegeTeamCap}).`);
    }

    const ret = { location: locationOf(p), x: p.x, z: p.z, yaw: p.yaw ?? 0 };
    activeParticipants.set(p.id, { siegeId: s.id, team, returnPoint: ret });
    s.onField[team].add(p.id);
    p.rpg.pvpSiegeReturn = { siegeId: s.id, team, ...ret };

    const rally = team === 'attacker' ? cfg.siegeAttackerRally : cfg.siegeDefenderRally;
    relocatePlayer(p, { location: cfg.siegeSceneLocation, ...rally });
    respawnProtectUntil.set(p.id, now() + cfg.siegeRespawnProtectMs);
    ctx.dirty?.(p);

    const view = siegePublicView(s, p.id);
    notifyPvp(p, {
      kind: 'pvp.siegeEntered',
      siege: view,
      text: `Entered the siege of ${s.seatName} at the ${team} rally point.`,
    });
    pushState(p);
    return view;
  }

  function leave(p) {
    const part = activeParticipants.get(p.id);
    if (!part) throw new Error('You are not in a siege battle.');
    const s = sieges.get(part.siegeId);
    s?.onField?.[part.team]?.delete(p.id);
    activeParticipants.delete(p.id);
    delete p.rpg.pvpSiegeReturn;
    relocatePlayer(p, part.returnPoint);
    ctx.dirty?.(p);
    notifyPvp(p, { kind: 'pvp.siegeLeft', siegeId: part.siegeId, text: 'You withdrew from the siege battle.' });
    pushState(p);
    return { left: true };
  }

  // ------------------------------------------------------------------ combat & tick hooks

  function onPlayerDefeated(victim, killer) {
    const part = activeParticipants.get(victim.id);
    if (!part) return false;
    const s = sieges.get(part.siegeId);
    if (!s || s.phase !== 'active') return false;

    const killerPart = killer ? activeParticipants.get(killer.id) : null;
    if (killerPart && killerPart.siegeId === s.id && killerPart.team !== part.team) {
      s.scores[killerPart.team] += 10;
    }

    // Respawn at team rally point with brief respawn protection
    delete victim.rpg.defeated;
    const c = victim.rpg?.character;
    if (c) {
      c.health = Math.max(1, c.maxHealth ?? 50);
      if (Number.isFinite(c.maxFatigue)) c.fatigue = c.maxFatigue;
    }
    const rally = part.team === 'attacker' ? cfg.siegeAttackerRally : cfg.siegeDefenderRally;
    relocatePlayer(victim, { location: cfg.siegeSceneLocation, ...rally });
    respawnProtectUntil.set(victim.id, now() + cfg.siegeRespawnProtectMs);
    ctx.dirty?.(victim);
    notifyPvp(victim, {
      kind: 'pvp.siegeRespawn',
      siegeId: s.id,
      team: part.team,
      text: `You fell in the siege and rallied at the ${part.team} camp.`,
    });
    pushState(victim);
    return true;
  }

  function tick(dt, t) {
    for (const [pid, until] of [...respawnProtectUntil]) {
      if (t >= until) respawnProtectUntil.delete(pid);
    }

    for (const s of [...sieges.values()]) {
      if (s.phase === 'ended') continue;
      if (s.phase === 'scheduled' && t >= s.lockAt) {
        freezeRosters(s);
      }
      if ((s.phase === 'scheduled' || s.phase === 'locked') && t >= s.startAt) {
        startBattle(s);
      }
      if (s.phase !== 'active') continue;

      // Count living attackers vs defenders on the capture point
      let attOnPoint = 0;
      let defOnPoint = 0;
      for (const pid of s.onField.attacker) {
        const p = ctx.players.get(pid);
        if (p && !p.rpg?.defeated && (p.rpg?.character?.health ?? 0) > 0 && locationOf(p) === cfg.siegeSceneLocation) {
          if (dist2d(p, cfg.siegeCapturePoint) <= cfg.siegeCaptureRadius) attOnPoint += 1;
        }
      }
      for (const pid of s.onField.defender) {
        const p = ctx.players.get(pid);
        if (p && !p.rpg?.defeated && (p.rpg?.character?.health ?? 0) > 0 && locationOf(p) === cfg.siegeSceneLocation) {
          if (dist2d(p, cfg.siegeCapturePoint) <= cfg.siegeCaptureRadius) defOnPoint += 1;
        }
      }

      if (attOnPoint > defOnPoint) {
        const diff = attOnPoint - defOnPoint;
        s.captureProgress = Math.min(cfg.siegeCaptureGoal, s.captureProgress + cfg.siegeCaptureRatePerSec * dt * Math.min(3, diff));
        s.scores.attacker += Math.round(diff * dt * 2);
      } else if (defOnPoint > attOnPoint && s.captureProgress > 0) {
        s.captureProgress = Math.max(0, s.captureProgress - cfg.siegeDecayRatePerSec * dt);
        s.scores.defender += Math.round(dt * 2);
      } else if (attOnPoint === 0 && s.captureProgress > 0) {
        s.captureProgress = Math.max(0, s.captureProgress - cfg.siegeDecayRatePerSec * 0.5 * dt);
      }

      if (s.captureProgress >= cfg.siegeCaptureGoal) {
        finishSiege(s, 'attacker', 'capture point secured');
      } else if (t >= s.endAt) {
        finishSiege(s, 'defender', 'defenders held until time expired');
      }
    }
  }

  function onLeave(p) {
    const part = activeParticipants.get(p.id);
    if (!part) return;
    const s = sieges.get(part.siegeId);
    s?.onField?.[part.team]?.delete(p.id);
    activeParticipants.delete(p.id);
  }

  function onJoin(p) {
    const ret = p.rpg?.pvpSiegeReturn;
    if (ret || locationOf(p) === cfg.siegeSceneLocation) {
      const s = ret ? sieges.get(ret.siegeId) : null;
      if (s && s.phase === 'active' && s.frozenRoster[ret.team]?.includes(p.id)) {
        activeParticipants.set(p.id, { siegeId: s.id, team: ret.team, returnPoint: { location: ret.location, x: ret.x, z: ret.z, yaw: ret.yaw ?? 0 } });
        s.onField[ret.team].add(p.id);
        return;
      }
      const landing = ret
        ? { location: ret.location, x: ret.x, z: ret.z, yaw: ret.yaw ?? 0 }
        : { location: cfg.districtSafeExitLocation, ...cfg.districtSafeExitSpot };
      delete p.rpg.pvpSiegeReturn;
      relocatePlayer(p, landing);
      ctx.dirty?.(p);
    }
  }

  function onPurge(characterId) {
    const part = activeParticipants.get(characterId);
    if (part) {
      sieges.get(part.siegeId)?.onField?.[part.team]?.delete(characterId);
      activeParticipants.delete(characterId);
    }
    respawnProtectUntil.delete(characterId);
    for (const s of sieges.values()) {
      s.frozenRoster.attacker = s.frozenRoster.attacker.filter((id) => id !== characterId);
      s.frozenRoster.defender = s.frozenRoster.defender.filter((id) => id !== characterId);
    }
  }

  function presenceScopeOf(p) {
    const part = activeParticipants.get(p?.id);
    if (!part) return null;
    const s = sieges.get(part.siegeId);
    if (!s || s.phase === 'ended') return null;
    return s.scope;
  }

  function engagementOf(p) {
    const part = activeParticipants.get(p?.id);
    if (!part) return null;
    const s = sieges.get(part.siegeId);
    if (!s || s.phase === 'ended') return null;
    return {
      mode: 'siege',
      matchId: s.id,
      phase: s.phase,
      team: part.team,
    };
  }

  function blockerFor(characterId) {
    const part = activeParticipants.get(characterId);
    if (!part) return null;
    const s = sieges.get(part.siegeId);
    if (!s || s.phase === 'ended') return null;
    return {
      code: 'PVP_SIEGE_ACTIVE',
      message: `Leave the active siege of ${s.seatName} before archiving or switching characters.`,
      route: 'pvp',
    };
  }

  function respawnProtectionUntilOf(p) {
    return respawnProtectUntil.get(p?.id) ?? 0;
  }

  function stateFor(p) {
    const current = [...sieges.values()].find((s) => s.phase !== 'ended') ?? [...sieges.values()].at(-1) ?? null;
    return {
      tenure: { ...tenure },
      activeSiege: siegePublicView(current, p.id),
      standings: [...standings.values()].sort((a, b) => b.prestige - a.prestige || b.wins - a.wins),
      myOrder: resolveOrder(p),
    };
  }

  return {
    schedule,
    register,
    enter,
    leave,
    freezeRosters,
    startBattle,
    finishSiege,
    onPlayerDefeated,
    tick,
    onLeave,
    onJoin,
    onPurge,
    presenceScopeOf,
    engagementOf,
    blockerFor,
    respawnProtectionUntilOf,
    stateFor,
    getTenure: () => ({ ...tenure }),
    sieges,
    standings,
  };
}
