// Player-funded Sea Bounties integrated with Admiralty and Naval PvP (§9).
//
// Extends server/rpg/admiralty.js NPC harbour bounties with player-funded contracts:
//   - Any captain can fund a bounty on another player captain, escrowing gold immediately.
//   - Outcome validation uses server/rpg/naval.js PvP events (`naval.sunk`, `naval.boarded`)
//     or `services.seaBounties.validateNavalPvpOutcome`, enforcing mutual PvP and rejecting
//     self-bounties / same-account laundering.
//   - Settled payouts move into durable character-owned claims (`seaBounties/` world rows)
//     so disconnect and server restart never lose or duplicate a captain's earned payout.
//
// Actions:
//   seaBounty.board   {}
//   seaBounty.post    { targetId, targetName?, amount, reason?, durationHours? }
//   seaBounty.accept  { bountyId }
//   seaBounty.cancel  { bountyId }
//   seaBounty.claim   { bountyId }
//
// Services (ctx.services.seaBounties):
//   post, accept, cancel, claim, validateNavalPvpOutcome, listOpen, claimsFor, getBounty

import { randomBytes } from 'node:crypto';

export const name = 'seaBounties';
export const WORLD_PREFIX = 'seaBounties/';
export const MIN_BOUNTY = 100;
export const MAX_BOUNTY = 500_000;
export const POSTING_FEE_RATE = 0.05;
export const DEFAULT_DURATION_HOURS = 72;

function toId(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isSafeInteger(n) ? n : null;
}

export function install(ctx) {
  const services = (ctx.services ||= {});
  const bounties = new Map(); // bountyId -> bounty record

  for (const [k, v] of ctx.loadWorld?.(WORLD_PREFIX) ?? []) {
    if (v && typeof v === 'object' && typeof v.id === 'string') {
      bounties.set(k.slice(WORLD_PREFIX.length), hydrate(v));
    }
  }

  function hydrate(raw) {
    return {
      id: String(raw.id),
      posterId: Number(raw.posterId),
      posterAccountId: raw.posterAccountId ?? null,
      posterName: String(raw.posterName ?? 'Captain'),
      targetId: Number(raw.targetId),
      targetAccountId: raw.targetAccountId ?? null,
      targetName: String(raw.targetName ?? `Captain #${raw.targetId}`),
      amount: Math.max(0, Math.trunc(Number(raw.amount) || 0)),
      fee: Math.max(0, Math.trunc(Number(raw.fee) || 0)),
      reason: String(raw.reason ?? 'Piracy on the Iliac Bay').slice(0, 140),
      region: String(raw.region ?? 'Daggerfall'),
      status: raw.status === 'settled' || raw.status === 'claimed' || raw.status === 'cancelled' || raw.status === 'expired'
        ? raw.status
        : 'open',
      hunters: Array.isArray(raw.hunters) ? [...new Set(raw.hunters.map(Number).filter(Number.isSafeInteger))] : [],
      winnerId: toId(raw.winnerId),
      winnerName: raw.winnerName ? String(raw.winnerName) : null,
      validation: raw.validation && typeof raw.validation === 'object' ? { ...raw.validation } : null,
      claimOwnerId: toId(raw.claimOwnerId),
      claimKind: raw.claimKind === 'refund' ? 'refund' : (raw.claimKind === 'payout' ? 'payout' : null),
      claimPaid: Boolean(raw.claimPaid),
      createdAt: Number(raw.createdAt) || 0,
      expiresAt: Number(raw.expiresAt) || 0,
      settledAt: Number.isFinite(raw.settledAt) ? raw.settledAt : null,
      claimedAt: Number.isFinite(raw.claimedAt) ? raw.claimedAt : null,
    };
  }

  function saveBounty(b) {
    const prev = bounties.has(b.id) ? structuredClone(bounties.get(b.id)) : null;
    bounties.set(b.id, b);
    ctx.dirtyWorld?.(`${WORLD_PREFIX}${b.id}`, b);
    ctx.onRollback?.(() => {
      if (prev) bounties.set(b.id, prev);
      else bounties.delete(b.id);
    });
  }

  function nowMs() {
    return Math.trunc(ctx.now?.() ?? Date.now());
  }

  function expireDue() {
    const t = nowMs();
    for (const b of bounties.values()) {
      if (b.status === 'open' && b.expiresAt > 0 && t >= b.expiresAt) {
        b.status = 'expired';
        b.claimOwnerId = b.posterId;
        b.claimKind = 'refund';
        b.settledAt = t;
        saveBounty(b);
      }
    }
  }

  function admiraltyContextFor(p) {
    try {
      const region = services.admiralty?.regionAt?.(p.x ?? 0, p.z ?? 0) ?? 'Daggerfall';
      const standing = services.admiralty?.standing?.(p, region) ?? 0;
      const notoriety = services.admiralty?.notoriety?.(p, region) ?? 0;
      const rank = services.admiralty?.rankOf?.(standing) ?? { rank: 0, title: 'Unsworn' };
      return { region, standing, notoriety, rank };
    } catch {
      return { region: 'Daggerfall', standing: 0, notoriety: 0, rank: { rank: 0, title: 'Unsworn' } };
    }
  }

  function boardView(p) {
    expireDue();
    const list = [...bounties.values()]
      .filter((b) => b.status === 'open' || b.claimOwnerId === p.id || b.posterId === p.id)
      .sort((a, b) => b.amount - a.amount || a.createdAt - b.createdAt)
      .map((b) => ({
        id: b.id,
        posterId: b.posterId,
        posterName: b.posterName,
        targetId: b.targetId,
        targetName: b.targetName,
        amount: b.amount,
        fee: b.fee,
        reason: b.reason,
        region: b.region,
        status: b.status,
        huntersCount: b.hunters.length,
        acceptedByMe: b.hunters.includes(p.id),
        winnerId: b.winnerId,
        winnerName: b.winnerName,
        claimableByMe: !b.claimPaid && b.claimOwnerId === p.id && (b.status === 'settled' || b.status === 'cancelled' || b.status === 'expired'),
        claimKind: b.claimKind,
        expiresAt: b.expiresAt,
      }));
    return { bounties: list, admiralty: admiraltyContextFor(p) };
  }

  function post(p, { targetId, targetName, amount, reason, durationHours } = {}) {
    expireDue();
    const tid = toId(targetId);
    if (tid == null) throw new Error('Specify a valid target captain ID.');
    if (tid === p.id) throw new Error('You cannot post a sea bounty on yourself.');
    const targetPlayer = ctx.players.get(tid) ?? null;
    if (targetPlayer && p.accountId != null && targetPlayer.accountId != null && targetPlayer.accountId === p.accountId) {
      throw new Error('You cannot post a sea bounty on another character of your own account.');
    }
    const amt = Math.trunc(Number(amount) || 0);
    if (amt < MIN_BOUNTY || amt > MAX_BOUNTY) {
      throw new Error(`Sea bounties must be between ${MIN_BOUNTY} and ${MAX_BOUNTY} gold.`);
    }
    const fee = Math.max(5, Math.round(amt * POSTING_FEE_RATE));
    const total = amt + fee;
    const purse = Number(p.rpg?.gold) || 0;
    if (purse < total) throw new Error(`You need ${total} gold (${amt} escrow + ${fee} harbour fee).`);

    ctx.dirty(p);
    if (typeof services.takeGold === 'function') services.takeGold(p, total);
    else p.rpg.gold = purse - total;

    const hours = Math.max(1, Math.min(168, Math.trunc(Number(durationHours) || DEFAULT_DURATION_HOURS)));
    const t = nowMs();
    const adm = admiraltyContextFor(p);
    const bounty = hydrate({
      id: `sb_${randomBytes(5).toString('hex')}`,
      posterId: p.id,
      posterAccountId: p.accountId ?? null,
      posterName: p.name,
      targetId: tid,
      targetAccountId: targetPlayer?.accountId ?? null,
      targetName: targetName || targetPlayer?.name || `Captain #${tid}`,
      amount: amt,
      fee,
      reason: String(reason || 'Hostile action on the Iliac Bay').trim().slice(0, 140),
      region: adm.region,
      status: 'open',
      hunters: [],
      createdAt: t,
      expiresAt: t + hours * 3600_000,
    });
    saveBounty(bounty);
    ctx.notify(p, {
      kind: 'seaBounty',
      bounty,
      ...boardView(p),
      text: `Posted ${amt} gold sea bounty on ${bounty.targetName} (fee ${fee} gold escrowed).`,
    });
    return bounty;
  }

  function accept(p, bountyId) {
    expireDue();
    const b = bounties.get(String(bountyId ?? ''));
    if (!b || b.status !== 'open') throw new Error('That sea bounty is no longer open.');
    if (b.targetId === p.id) throw new Error('You cannot accept a bounty posted on yourself.');
    if (p.accountId != null && b.targetAccountId != null && p.accountId === b.targetAccountId) {
      throw new Error('Characters of the target account cannot hunt this bounty.');
    }
    if (!b.hunters.includes(p.id)) {
      b.hunters.push(p.id);
      saveBounty(b);
    }
    ctx.notify(p, {
      kind: 'seaBounty',
      bounty: b,
      ...boardView(p),
      text: `Accepted sea bounty on ${b.targetName} (${b.amount} gold).`,
    });
    return b;
  }

  function cancel(p, bountyId) {
    expireDue();
    const b = bounties.get(String(bountyId ?? ''));
    if (!b) throw new Error('Sea bounty not found.');
    if (b.posterId !== p.id) throw new Error('Only the poster may cancel an open sea bounty.');
    if (b.status !== 'open') throw new Error(`Cannot cancel a bounty that is already ${b.status}.`);
    b.status = 'cancelled';
    b.claimOwnerId = p.id;
    b.claimKind = 'refund';
    b.settledAt = nowMs();
    saveBounty(b);
    ctx.notify(p, {
      kind: 'seaBounty',
      bounty: b,
      ...boardView(p),
      text: `Cancelled bounty on ${b.targetName}; ${b.amount} gold escrow is ready to claim.`,
    });
    return b;
  }

  /**
   * Validates a naval PvP victory (sink or board) and settles matching open player bounties
   * into durable claims owned by the winning captain.
   */
  function validateNavalPvpOutcome({ killer, targetPlayerId, targetShip = null, act = 'sunk', pvpVerified = true, vesselId = null }) {
    expireDue();
    if (!killer || !Number.isSafeInteger(killer.id)) return [];
    const tid = toId(targetPlayerId ?? targetShip?.ownerId);
    if (tid == null || tid === killer.id) return [];
    if (!pvpVerified) return [];

    const settled = [];
    const t = nowMs();
    for (const b of bounties.values()) {
      if (b.status !== 'open' || b.targetId !== tid) continue;
      if (killer.accountId != null && b.targetAccountId != null && killer.accountId === b.targetAccountId) continue;
      b.status = 'settled';
      b.winnerId = killer.id;
      b.winnerName = killer.name;
      b.claimOwnerId = killer.id;
      b.claimKind = 'payout';
      b.settledAt = t;
      b.validation = {
        act,
        pvpVerified: true,
        vesselId: vesselId ?? null,
        targetVesselId: targetShip?.id ?? null,
        validatedAt: t,
      };
      saveBounty(b);
      settled.push(b);

      ctx.notify(killer, {
        kind: 'seaBountySettled',
        bounty: b,
        text: `Sea bounty on ${b.targetName} validated via naval PvP (${act})! Claim ${b.amount} gold at any harbour board.`,
      });
      const poster = ctx.players.get(b.posterId);
      if (poster) {
        ctx.notify(poster, {
          kind: 'seaBountySettled',
          bounty: b,
          text: `${killer.name} claimed your sea bounty on ${b.targetName}.`,
        });
      }
    }
    return settled;
  }

  function claim(p, bountyId) {
    expireDue();
    const b = bounties.get(String(bountyId ?? ''));
    if (!b) throw new Error('Sea bounty claim not found.');
    if (b.claimPaid) throw new Error('This sea bounty payout has already been claimed.');
    if (b.claimOwnerId !== p.id) throw new Error('You do not own the payout claim for this sea bounty.');
    if (b.status !== 'settled' && b.status !== 'cancelled' && b.status !== 'expired') {
      throw new Error('This sea bounty is not ready for payout.');
    }

    ctx.dirty(p);
    if (typeof services.addGold === 'function') services.addGold(p, b.amount);
    else p.rpg.gold = (Number(p.rpg.gold) || 0) + b.amount;

    b.claimPaid = true;
    b.status = 'claimed';
    b.claimedAt = nowMs();
    saveBounty(b);

    if (b.claimKind === 'payout') {
      services.optionalRules?.awardRenown?.(p, 15, `seaBounty:${b.id}`);
    }

    ctx.notify(p, {
      kind: 'seaBountyClaimed',
      bounty: b,
      amount: b.amount,
      claimKind: b.claimKind,
      ...boardView(p),
      text: b.claimKind === 'refund'
        ? `Collected ${b.amount} gold refund from cancelled/expired sea bounty.`
        : `Collected ${b.amount} gold sea bounty payout for defeating ${b.targetName}!`,
    });
    return { bountyId: b.id, amount: b.amount, claimKind: b.claimKind };
  }

  // Listen to live naval PvP events from server/rpg/naval.js.
  for (const evName of ['naval.sunk', 'naval.boarded']) {
    ctx.on?.(evName, ({ player, vessel, target }) => {
      if (!player || !target) return;
      // Only player-owned ships in mutual naval PvP settle player bounties.
      const isPlayerTarget = target.kind === 'player' || target.pvp === true || Number.isSafeInteger(target.ownerId);
      if (!isPlayerTarget) return;
      validateNavalPvpOutcome({
        killer: player,
        targetPlayerId: target.ownerId,
        targetShip: target,
        act: evName.split('.')[1],
        pvpVerified: target.pvp !== false,
        vesselId: vessel,
      });
    });
  }

  ctx.onAction?.('seaBounty.board', (p) => {
    ctx.notify(p, { kind: 'seaBounty', ...boardView(p), silent: true });
  });
  ctx.onAction?.('seaBounty.post', (p, args) => post(p, args));
  ctx.onAction?.('seaBounty.accept', (p, args) => accept(p, args?.bountyId));
  ctx.onAction?.('seaBounty.cancel', (p, args) => cancel(p, args?.bountyId));
  ctx.onAction?.('seaBounty.claim', (p, args) => claim(p, args?.bountyId));

  services.seaBounties = {
    post,
    accept,
    cancel,
    claim,
    validateNavalPvpOutcome,
    getBounty: (id) => bounties.get(id) ?? null,
    listOpen: () => {
      expireDue();
      return [...bounties.values()].filter((b) => b.status === 'open');
    },
    claimsFor: (playerId) => {
      expireDue();
      return [...bounties.values()].filter((b) => !b.claimPaid && b.claimOwnerId === playerId);
    },
  };
}
