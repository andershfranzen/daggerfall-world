// Offline Claims inbox & atomic collection for §6 Player Market.
//
// Delivers purchased items, won auction items, sale proceeds, outbid refunds, and cancelled/expired
// returns from `claim_records` into the owning character's inventory/gold purse with pack slot & weight checks.

import {
  GOLD_PER_KG,
  MAX_ITEMS,
  carriedWeight,
  insertRecord,
  maxEncumbrance,
  normalizeRecord,
} from '../inventory.js';
import { MarketError, cleanOpKey } from './config.js';
import { assertNearMarketBoard } from './boards.js';

export function createClaimsService(ctx, cfg, mstore) {
  function maxCarryOf(charObj) {
    const live = ctx?.players?.get?.(charObj.id);
    if (live && typeof ctx?.services?.maxEncumbrance === 'function') {
      return ctx.services.maxEncumbrance(live);
    }
    return maxEncumbrance(charObj.rpg);
  }

  function addedWeightOf(claim) {
    let kg = 0;
    if (claim.gold > 0) kg += claim.gold / GOLD_PER_KG;
    if (claim.item) {
      const w = Number.isFinite(claim.item.weight) ? claim.item.weight : 0;
      const q = Number.isFinite(claim.item.quantity) ? claim.item.quantity : 1;
      kg += w * q;
    }
    return kg;
  }

  /**
   * Lists pending (and optionally recently claimed) claims owned by `actor`.
   */
  async function listClaims(actor, { status = 'pending', limit = 100 } = {}) {
    const filter = { ownerCharacterId: Number(actor.id), limit };
    if (status && status !== 'all') filter.status = status;
    const rows = await Promise.resolve(mstore.store.listClaims(filter));
    return rows.map((c) => ({
      id: c.id,
      kind: c.kind,
      sourceRef: c.sourceRef,
      gold: c.gold,
      item: c.item ? { ...c.item } : null,
      status: c.status,
      reason: c.reason,
      revision: c.revision,
      createdAt: c.createdAt,
      claimedAt: c.claimedAt,
    }));
  }

  /**
   * Claims a single pending `claim_records` entry into the character's pack/gold purse.
   * Enforces ownership, board proximity, pack slot limits, and encumbrance capacity atomically.
   */
  async function claimOne(actor, args = {}, opts = {}) {
    const claimId = String(args.claimId ?? '');
    const opKey = cleanOpKey(args.opKey ?? args.requestId);
    if (!claimId) throw new MarketError('INVALID_CLAIM', 'Choose a claim to collect.');

    assertNearMarketBoard(actor, cfg, { skipProximity: opts.skipProximity });
    const actorAccountId = await mstore.resolveAccountId(actor);

    let committedChar = null;

    const { replayed, result } = await mstore.runDurable(
      opKey,
      {
        accountId: actorAccountId,
        characterId: actor.id,
        resourceKey: `claim:${claimId}`,
        params: { op: 'claim.collect', claimId },
        ttlMs: cfg.opKeyTtlMs,
      },
      async (tx) => {
        const claim = await tx.getClaim(claimId);
        if (!claim) throw new MarketError('CLAIM_NOT_FOUND', 'Claim record not found.');
        if (Number(claim.ownerCharacterId) !== Number(actor.id)) {
          throw new MarketError('FORBIDDEN', 'That claim belongs to another character.');
        }
        if (claim.status !== 'pending') {
          throw new MarketError('ALREADY_CLAIMED', `This claim has already been ${claim.status}.`);
        }

        const charObj = await mstore.loadCharacterInTx(tx, actor);

        // Encumbrance capacity check (unless bypassed by test/server option or pure gold within carry weight).
        if (!opts.ignoreWeight) {
          const curWeight = carriedWeight(charObj.rpg);
          const maxKg = maxCarryOf(charObj);
          const addKg = addedWeightOf(claim);
          if (curWeight + addKg > maxKg + 1e-6) {
            throw new MarketError(
              'PACK_OVERWEIGHT',
              `You cannot carry that much (${(curWeight + addKg).toFixed(1)} / ${maxKg.toFixed(1)} kg). Free some weight first.`,
            );
          }
        }

        if (claim.item) {
          const norm = normalizeRecord(claim.item);
          if (!norm) throw new MarketError('CORRUPTED_ITEM', 'Claimed item record is invalid.');
          try {
            insertRecord(charObj.rpg, norm);
          } catch (err) {
            const full = charObj.rpg.inventory.length >= MAX_ITEMS || /cannot hold|stack is full/i.test(err?.message ?? '');
            throw new MarketError(
              full ? 'PACK_FULL' : 'CLAIM_INSERT_FAILED',
              err?.message || 'Your pack cannot hold that item.',
            );
          }
        }
        if (claim.gold > 0) {
          if (charObj.rpg.gold + claim.gold > 1e9) {
            throw new MarketError('GOLD_CAP', 'You cannot carry that much gold.');
          }
          charObj.rpg.gold += claim.gold;
        }

        const settled = await tx.claimRecord(claim.id, claim.revision, 'claimed');
        await tx.saveCharacters([charObj]);
        committedChar = charObj;

        return {
          claim: settled,
          goldAdded: claim.gold,
          itemAdded: claim.item ? { id: claim.item.id, name: claim.item.name, quantity: claim.item.quantity } : null,
          gold: charObj.rpg.gold,
        };
      },
    );

    if (!replayed && committedChar) {
      mstore.applyCommittedCharacter(committedChar, actor);
    }

    return { ok: true, replayed, ...result };
  }

  /**
   * Collects all pending claims that fit in the character's pack/encumbrance.
   * Claims that fail due to full pack or weight remain safely pending for later collection!
   */
  async function claimAll(actor, args = {}, opts = {}) {
    assertNearMarketBoard(actor, cfg, { skipProximity: opts.skipProximity });
    const pending = await listClaims(actor, { status: 'pending', limit: 100 });
    const claimed = [];
    const skipped = [];

    for (const c of pending) {
      try {
        const res = await claimOne(actor, { claimId: c.id }, { ...opts, skipProximity: true });
        claimed.push(res);
      } catch (err) {
        if (err?.code === 'PACK_FULL' || err?.code === 'PACK_OVERWEIGHT' || err?.code === 'GOLD_CAP') {
          skipped.push({ claimId: c.id, code: err.code, reason: err.message });
        } else if (err?.code !== 'ALREADY_CLAIMED') {
          skipped.push({ claimId: c.id, code: err?.code || 'CLAIM_FAILED', reason: err?.message || 'Could not claim.' });
        }
      }
    }

    return {
      ok: true,
      claimedCount: claimed.length,
      skippedCount: skipped.length,
      claimed,
      skipped,
    };
  }

  return {
    listClaims,
    claimOne,
    claimAll,
  };
}
