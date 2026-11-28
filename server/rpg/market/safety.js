// Market safety invariants, anti-self-trade across account slots, account obligation caps,
// character archive blockers, character purge cleanup, repeat-trade monitoring, and conservation reconciliation.

import { itemFingerprint } from '../inventory.js';
import {
  LISTING_PREFIX,
  AUCTION_PREFIX,
  ORDER_PREFIX,
  ESCROW_KINDS,
  CLAIM_KINDS,
  MarketError,
} from './config.js';

const MARKET_ESCROW_KINDS = new Set(Object.values(ESCROW_KINDS));

export function createMarketSafety(ctx, cfg, mstore) {
  const auditAlerts = []; // bounded in-memory list of repeat-trade alerts

  /**
   * Enforces strict anti-self-trade across all character slots of the same account.
   */
  async function assertNotSelfTrade(actor, targetCharacterId, targetAccountId = null) {
    const actorCharId = Number(actor?.id);
    if (Number.isSafeInteger(actorCharId) && Number.isSafeInteger(Number(targetCharacterId)) && actorCharId === Number(targetCharacterId)) {
      throw new MarketError('SELF_TRADE_FORBIDDEN', 'You cannot buy, fulfill, or bid on your own market listing.');
    }
    const actorAcct = await mstore.resolveAccountId(actor);
    const otherAcct = targetAccountId != null && targetAccountId !== ''
      ? String(targetAccountId)
      : await mstore.resolveAccountId(targetCharacterId);
    if (actorAcct != null && otherAcct != null && actorAcct === otherAcct) {
      throw new MarketError(
        'SELF_TRADE_FORBIDDEN',
        'Self-trading or bidding across characters on the same account is forbidden.',
      );
    }
  }

  /**
   * Checks account-wide (or character-wide for guests) active obligation caps inside a durable transaction.
   */
  async function assertWithinObligationCaps(tx, accountId, characterId, kind) {
    const filter = accountId != null
      ? { ownerAccountId: String(accountId), status: 'held', limit: 500 }
      : { ownerCharacterId: Number(characterId), status: 'held', limit: 500 };
    const held = (await tx.listEscrow(filter)).filter((e) => MARKET_ESCROW_KINDS.has(e.kind));

    const listingsCount = held.filter((e) => e.kind === ESCROW_KINDS.LISTING_ITEM).length;
    const auctionsCount = held.filter((e) => e.kind === ESCROW_KINDS.AUCTION_ITEM).length;
    const ordersCount = held.filter((e) => e.kind === ESCROW_KINDS.BUY_ORDER_GOLD).length;
    const totalCount = held.length;

    if (totalCount >= cfg.maxTotalObligationsPerAccount) {
      throw new MarketError(
        'ACCOUNT_OBLIGATION_CAP',
        `Account market cap reached (${cfg.maxTotalObligationsPerAccount} active listings, bids, and orders across all character slots).`,
        { cap: cfg.maxTotalObligationsPerAccount, current: totalCount },
      );
    }
    if (kind === ESCROW_KINDS.LISTING_ITEM && listingsCount >= cfg.maxActiveListingsPerAccount) {
      throw new MarketError(
        'ACCOUNT_LISTING_CAP',
        `Account fixed-price listing cap reached (${cfg.maxActiveListingsPerAccount} active listings).`,
        { cap: cfg.maxActiveListingsPerAccount, current: listingsCount },
      );
    }
    if (kind === ESCROW_KINDS.AUCTION_ITEM && auctionsCount >= cfg.maxActiveAuctionsPerAccount) {
      throw new MarketError(
        'ACCOUNT_AUCTION_CAP',
        `Account auction cap reached (${cfg.maxActiveAuctionsPerAccount} active auctions).`,
        { cap: cfg.maxActiveAuctionsPerAccount, current: auctionsCount },
      );
    }
    if (kind === ESCROW_KINDS.BUY_ORDER_GOLD && ordersCount >= cfg.maxActiveBuyOrdersPerAccount) {
      throw new MarketError(
        'ACCOUNT_BUY_ORDER_CAP',
        `Account buy order cap reached (${cfg.maxActiveBuyOrdersPerAccount} active buy orders).`,
        { cap: cfg.maxActiveBuyOrdersPerAccount, current: ordersCount },
      );
    }
    return { listingsCount, auctionsCount, ordersCount, totalCount };
  }

  /**
   * Computes current account obligation usage for UI cap meters.
   */
  async function getObligationUsage(accountId, characterId) {
    const filter = accountId != null
      ? { ownerAccountId: String(accountId), status: 'held', limit: 500 }
      : { ownerCharacterId: Number(characterId), status: 'held', limit: 500 };
    const held = (await Promise.resolve(mstore.store.listEscrow(filter))).filter((e) => MARKET_ESCROW_KINDS.has(e.kind));
    return {
      listings: held.filter((e) => e.kind === ESCROW_KINDS.LISTING_ITEM).length,
      auctions: held.filter((e) => e.kind === ESCROW_KINDS.AUCTION_ITEM).length,
      bids: held.filter((e) => e.kind === ESCROW_KINDS.AUCTION_BID).length,
      buyOrders: held.filter((e) => e.kind === ESCROW_KINDS.BUY_ORDER_GOLD).length,
      total: held.length,
      caps: {
        listings: cfg.maxActiveListingsPerAccount,
        auctions: cfg.maxActiveAuctionsPerAccount,
        buyOrders: cfg.maxActiveBuyOrdersPerAccount,
        total: cfg.maxTotalObligationsPerAccount,
      },
    };
  }

  /**
   * Monitors settlements for suspicious high-frequency repeat trading between the same account pair.
   * Logs only anonymized pair hash, counts, and reason code — never private account info.
   */
  function inspectSettlementPattern(ledgerSnapshot, settlement) {
    if (!settlement || !settlement.pairKey) return null;
    const cutoff = settlement.at - cfg.repeatTradeWindowMs;
    const recent = (ledgerSnapshot?.recentSettlements ?? []).filter(
      (s) => s && s.pairKey === settlement.pairKey && s.at >= cutoff,
    );
    if (recent.length >= cfg.repeatTradeThreshold) {
      const alert = {
        code: 'REPEAT_TRADE_PATTERN',
        pairKey: settlement.pairKey,
        count: recent.length,
        volume: recent.reduce((sum, s) => sum + (Number(s.gross) || 0), 0),
        at: settlement.at,
      };
      auditAlerts.push(alert);
      if (auditAlerts.length > 100) auditAlerts.shift();
      ctx?.log?.warn?.(`[market] REPEAT_TRADE_PATTERN pair=${alert.pairKey} count=${alert.count} volume=${alert.volume}`);
      return alert;
    }
    return null;
  }

  /**
   * Character archive blocker callback registered on `ctx.services.characterBlockers`.
   */
  async function checkCharacterBlockers(_accountId, characterId, kind = 'archive') {
    if (kind !== 'archive') return [];
    const cid = Number(characterId);
    const blockers = [];

    const activeListings = [...mstore.listings.values()].filter(
      (l) => l.status === 'active' && Number(l.sellerCharacterId) === cid,
    );
    if (activeListings.length > 0) {
      blockers.push({
        code: 'MARKET_ACTIVE_LISTINGS',
        message: `Cancel or settle ${activeListings.length} active market listing${activeListings.length === 1 ? '' : 's'} before archiving.`,
        route: 'market',
      });
    }

    const activeAuctions = [...mstore.auctions.values()].filter(
      (a) => a.status === 'active' && Number(a.sellerCharacterId) === cid,
    );
    if (activeAuctions.length > 0) {
      blockers.push({
        code: 'MARKET_ACTIVE_AUCTIONS',
        message: `Resolve ${activeAuctions.length} active auction${activeAuctions.length === 1 ? '' : 's'} before archiving.`,
        route: 'market',
      });
    }

    const activeBids = [...mstore.auctions.values()].filter(
      (a) => a.status === 'active' && Number(a.highBidderCharacterId) === cid,
    );
    if (activeBids.length > 0) {
      blockers.push({
        code: 'MARKET_ACTIVE_BIDS',
        message: `Wait for ${activeBids.length} active auction bid${activeBids.length === 1 ? '' : 's'} to conclude before archiving.`,
        route: 'market',
      });
    }

    const activeOrders = [...mstore.orders.values()].filter(
      (o) => o.status === 'active' && Number(o.buyerCharacterId) === cid,
    );
    if (activeOrders.length > 0) {
      blockers.push({
        code: 'MARKET_ACTIVE_BUY_ORDERS',
        message: `Cancel ${activeOrders.length} active buy order${activeOrders.length === 1 ? '' : 's'} before archiving.`,
        route: 'market',
      });
    }

    const pendingClaims = (await Promise.resolve(
      mstore.store.listClaims({ ownerCharacterId: cid, status: 'pending', limit: 50 }),
    )).filter((c) => Object.values(CLAIM_KINDS).includes(c.kind));
    if (pendingClaims.length > 0) {
      blockers.push({
        code: 'MARKET_UNCLAIMED_PROCEEDS',
        message: `Collect ${pendingClaims.length} unclaimed market item or payout record${pendingClaims.length === 1 ? '' : 's'} before archiving.`,
        route: 'market',
      });
    }

    return blockers;
  }

  /**
   * Counterparty-escrow return & cleanup callback registered on `ctx.services.onCharacterPurge`.
   * Idempotent with `server/game.js`'s generic escrow refund pass: checks `escrow.status === 'held'`
   * inside `runDurable` before refunding so counterparty claims are created at most once.
   */
  async function handleCharacterPurge({ characterId, accountId } = {}) {
    const cid = Number(characterId);
    if (!Number.isSafeInteger(cid)) return { purgedListings: 0, purgedAuctions: 0, clearedBids: 0, purgedOrders: 0, refundedCounterparties: 0 };

    let purgedListings = 0;
    let purgedAuctions = 0;
    let clearedBids = 0;
    let purgedOrders = 0;
    let refundedCounterparties = 0;

    // 1. Purge seller's active fixed-price listings.
    const ownListings = [...mstore.listings.values()].filter(
      (l) => l.status === 'active' && Number(l.sellerCharacterId) === cid,
    );
    for (const listing of ownListings) {
      const { result } = await mstore.runDurable(
        `market-purge-listing:${listing.id}:${cid}`,
        { accountId: accountId ?? listing.sellerAccountId, characterId: cid, resourceKey: `${LISTING_PREFIX}${listing.id}`, params: { id: listing.id, cid } },
        async (tx) => {
          const cur = await tx.getWorld(`${LISTING_PREFIX}${listing.id}`);
          if (!cur || cur.status !== 'active') return { skipped: true };
          const esc = await tx.getEscrow(cur.escrowId);
          if (esc && esc.status === 'held') {
            await tx.updateEscrowStatus(esc.id, esc.revision, 'released', { item: null });
          }
          cur.status = 'purged';
          cur.remainingQuantity = 0;
          cur.houseTrader = null;
          cur.revision = (cur.revision || 1) + 1;
          cur.settledAt = mstore.wallNow();
          await tx.putWorld(`${LISTING_PREFIX}${listing.id}`, cur);
          return { listing: cur };
        },
      );
      if (result?.listing) {
        mstore.listings.set(result.listing.id, result.listing);
        purgedListings += 1;
      }
    }

    // 2. Purge seller's active auctions — MUST refund counterparty high bidder's escrowed gold first!
    const ownAuctions = [...mstore.auctions.values()].filter(
      (a) => a.status === 'active' && Number(a.sellerCharacterId) === cid,
    );
    for (const auction of ownAuctions) {
      const { result } = await mstore.runDurable(
        `market-purge-auction:${auction.id}:${cid}`,
        { accountId: accountId ?? auction.sellerAccountId, characterId: cid, resourceKey: `${AUCTION_PREFIX}${auction.id}`, params: { id: auction.id, cid } },
        async (tx) => {
          const cur = await tx.getWorld(`${AUCTION_PREFIX}${auction.id}`);
          if (!cur || cur.status !== 'active') return { skipped: true };
          let refunded = false;
          if (cur.highBidEscrowId && cur.highBidderCharacterId != null && Number(cur.highBidderCharacterId) !== cid) {
            const bidEsc = await tx.getEscrow(cur.highBidEscrowId);
            if (bidEsc && bidEsc.status === 'held' && bidEsc.gold > 0) {
              await tx.createClaim({
                ownerCharacterId: Number(cur.highBidderCharacterId),
                ownerAccountId: cur.highBidderAccountId ?? null,
                kind: CLAIM_KINDS.ESCROW_REFUND,
                sourceRef: cur.id,
                gold: bidEsc.gold,
                item: null,
                reason: 'Auction seller account deleted; bid refunded',
              });
              await tx.updateEscrowStatus(bidEsc.id, bidEsc.revision, 'refunded', { gold: 0 });
              refunded = true;
            }
          }
          const itemEsc = await tx.getEscrow(cur.itemEscrowId);
          if (itemEsc && itemEsc.status === 'held') {
            await tx.updateEscrowStatus(itemEsc.id, itemEsc.revision, 'released', { item: null, counterpartyCharacterId: null });
          }
          cur.status = 'purged';
          cur.highBid = 0;
          cur.highBidderCharacterId = null;
          cur.highBidderAccountId = null;
          cur.highBidderName = null;
          cur.highBidEscrowId = null;
          cur.revision = (cur.revision || 1) + 1;
          cur.settledAt = mstore.wallNow();
          await tx.putWorld(`${AUCTION_PREFIX}${auction.id}`, cur);
          return { auction: cur, refunded };
        },
      );
      if (result?.auction) {
        mstore.auctions.set(result.auction.id, result.auction);
        purgedAuctions += 1;
        if (result.refunded) refundedCounterparties += 1;
      }
    }

    // 3. Clear active high bids placed by the purged character on OTHER players' auctions.
    const bidAuctions = [...mstore.auctions.values()].filter(
      (a) => a.status === 'active' && Number(a.highBidderCharacterId) === cid && Number(a.sellerCharacterId) !== cid,
    );
    for (const auction of bidAuctions) {
      const { result } = await mstore.runDurable(
        `market-purge-bidder:${auction.id}:${cid}`,
        { accountId: accountId ?? auction.highBidderAccountId, characterId: cid, resourceKey: `${AUCTION_PREFIX}${auction.id}`, params: { id: auction.id, cid } },
        async (tx) => {
          const cur = await tx.getWorld(`${AUCTION_PREFIX}${auction.id}`);
          if (!cur || cur.status !== 'active' || Number(cur.highBidderCharacterId) !== cid) return { skipped: true };
          if (cur.highBidEscrowId) {
            const bidEsc = await tx.getEscrow(cur.highBidEscrowId);
            if (bidEsc && bidEsc.status === 'held') {
              await tx.updateEscrowStatus(bidEsc.id, bidEsc.revision, 'released', { gold: 0 });
            }
          }
          const itemEsc = await tx.getEscrow(cur.itemEscrowId);
          if (itemEsc && itemEsc.status === 'held') {
            await tx.updateEscrowStatus(itemEsc.id, itemEsc.revision, 'held', { counterpartyCharacterId: null });
          }
          cur.highBid = 0;
          cur.highBidderCharacterId = null;
          cur.highBidderAccountId = null;
          cur.highBidderName = null;
          cur.highBidEscrowId = null;
          cur.revision = (cur.revision || 1) + 1;
          await tx.putWorld(`${AUCTION_PREFIX}${auction.id}`, cur);
          return { auction: cur };
        },
      );
      if (result?.auction) {
        mstore.auctions.set(result.auction.id, result.auction);
        clearedBids += 1;
      }
    }

    // 4. Purge buyer's active buy orders.
    const ownOrders = [...mstore.orders.values()].filter(
      (o) => o.status === 'active' && Number(o.buyerCharacterId) === cid,
    );
    for (const order of ownOrders) {
      const { result } = await mstore.runDurable(
        `market-purge-order:${order.id}:${cid}`,
        { accountId: accountId ?? order.buyerAccountId, characterId: cid, resourceKey: `${ORDER_PREFIX}${order.id}`, params: { id: order.id, cid } },
        async (tx) => {
          const cur = await tx.getWorld(`${ORDER_PREFIX}${order.id}`);
          if (!cur || cur.status !== 'active') return { skipped: true };
          const esc = await tx.getEscrow(cur.escrowId);
          if (esc && esc.status === 'held') {
            await tx.updateEscrowStatus(esc.id, esc.revision, 'released', { gold: 0 });
          }
          cur.status = 'purged';
          cur.remainingQuantity = 0;
          cur.revision = (cur.revision || 1) + 1;
          cur.settledAt = mstore.wallNow();
          await tx.putWorld(`${ORDER_PREFIX}${order.id}`, cur);
          return { order: cur };
        },
      );
      if (result?.order) {
        mstore.orders.set(result.order.id, result.order);
        purgedOrders += 1;
      }
    }

    // 5. Forfeit any remaining unclaimed claims belonging to the purged character.
    const pendingClaims = await Promise.resolve(mstore.store.listClaims({ ownerCharacterId: cid, status: 'pending', limit: 200 }));
    for (const c of pendingClaims) {
      await mstore.runDurable(
        `market-purge-claim:${c.id}:${cid}`,
        { accountId: accountId ?? c.ownerAccountId, characterId: cid, resourceKey: `claim:${c.id}`, params: { claimId: c.id, cid } },
        async (tx) => {
          const cur = await tx.getClaim(c.id);
          if (!cur || cur.status !== 'pending') return { skipped: true };
          await tx.claimRecord(cur.id, cur.revision, 'forfeited');
          return { forfeited: cur.id };
        },
      );
    }

    return { purgedListings, purgedAuctions, clearedBids, purgedOrders, refundedCounterparties };
  }

  /**
   * Reconciles all active market records against `escrow_records`, `claim_records`, and the fee/tax ledger.
   * Returns `{ ok, issues, totals }` for conservation auditing and tests.
   */
  async function reconcile({ players = null } = {}) {
    const issues = [];
    const heldEscrows = (await Promise.resolve(mstore.store.listEscrow({ status: 'held', limit: 500 })))
      .filter((e) => MARKET_ESCROW_KINDS.has(e.kind));
    const pendingClaims = await Promise.resolve(mstore.store.listClaims({ status: 'pending', limit: 500 }));
    const escrowById = new Map(heldEscrows.map((e) => [e.id, e]));
    const referencedEscrows = new Set();

    let escrowedItemsQty = 0;
    let escrowedGold = 0;

    for (const l of mstore.listings.values()) {
      if (l.status !== 'active') continue;
      const esc = escrowById.get(l.escrowId);
      if (!esc) {
        issues.push(`Active listing ${l.id} missing held escrow ${l.escrowId}`);
        continue;
      }
      referencedEscrows.add(esc.id);
      if (!esc.item || esc.item.quantity !== l.remainingQuantity) {
        issues.push(`Listing ${l.id} qty mismatch (listing=${l.remainingQuantity}, escrow=${esc.item?.quantity ?? 0})`);
      }
      if (esc.item && itemFingerprint(esc.item) !== l.fingerprint) {
        issues.push(`Listing ${l.id} item fingerprint mismatch`);
      }
      escrowedItemsQty += esc.item?.quantity ?? 0;
    }

    for (const a of mstore.auctions.values()) {
      if (a.status !== 'active') continue;
      const itemEsc = escrowById.get(a.itemEscrowId);
      if (!itemEsc || !itemEsc.item) {
        issues.push(`Active auction ${a.id} missing held item escrow ${a.itemEscrowId}`);
      } else {
        referencedEscrows.add(itemEsc.id);
        escrowedItemsQty += itemEsc.item.quantity ?? 1;
      }
      if (a.highBid > 0 && a.highBidEscrowId) {
        const bidEsc = escrowById.get(a.highBidEscrowId);
        if (!bidEsc || bidEsc.gold !== a.highBid) {
          issues.push(`Active auction ${a.id} high bid escrow mismatch (bid=${a.highBid}, escrow=${bidEsc?.gold ?? 'missing'})`);
        } else {
          referencedEscrows.add(bidEsc.id);
          escrowedGold += bidEsc.gold;
        }
      }
    }

    for (const o of mstore.orders.values()) {
      if (o.status !== 'active') continue;
      const esc = escrowById.get(o.escrowId);
      const expectedGold = o.remainingQuantity * o.unitPrice;
      if (!esc || esc.gold !== expectedGold) {
        issues.push(`Active buy order ${o.id} escrow mismatch (expected=${expectedGold}, actual=${esc?.gold ?? 'missing'})`);
      } else {
        referencedEscrows.add(esc.id);
        escrowedGold += esc.gold;
      }
    }

    for (const esc of heldEscrows) {
      if (!referencedEscrows.has(esc.id)) {
        issues.push(`Orphan held market escrow ${esc.id} (${esc.kind}) not referenced by any active listing/auction/order`);
      }
    }

    let pendingClaimGold = 0;
    let pendingClaimItemsQty = 0;
    for (const c of pendingClaims) {
      pendingClaimGold += Number(c.gold ?? 0);
      if (c.item) pendingClaimItemsQty += Number(c.item.quantity ?? 1);
    }

    const led = mstore.getLedger();
    let playerGold = null;
    let playerItemsQty = null;
    if (Array.isArray(players)) {
      playerGold = players.reduce((sum, p) => sum + (Number(p?.rpg?.gold) || 0), 0);
      playerItemsQty = players.reduce(
        (sum, p) => sum + (Array.isArray(p?.rpg?.inventory) ? p.rpg.inventory.reduce((s, it) => s + (Number(it?.quantity) || 0), 0) : 0),
        0,
      );
    }

    return {
      ok: issues.length === 0,
      issues,
      totals: {
        heldEscrowCount: heldEscrows.length,
        escrowedGold,
        escrowedItemsQty,
        pendingClaimCount: pendingClaims.length,
        pendingClaimGold,
        pendingClaimItemsQty,
        totalListingFees: led.totalListingFees,
        totalSaleTaxes: led.totalSaleTaxes,
        totalGoldSunk: led.totalListingFees + led.totalSaleTaxes,
        ...(playerGold !== null ? { playerGold, totalConservedGold: playerGold + escrowedGold + pendingClaimGold + led.totalListingFees + led.totalSaleTaxes } : {}),
        ...(playerItemsQty !== null ? { playerItemsQty, totalConservedItemsQty: playerItemsQty + escrowedItemsQty + pendingClaimItemsQty } : {}),
      },
    };
  }

  return {
    assertNotSelfTrade,
    assertWithinObligationCaps,
    getObligationUsage,
    inspectSettlementPattern,
    getAuditAlerts: () => auditAlerts.slice(),
    checkCharacterBlockers,
    handleCharacterPurge,
    reconcile,
  };
}
