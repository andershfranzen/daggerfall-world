// Timed Auctions for §6 Player Market.
//
// Features:
//  - Individual eligible items only (`assertItemEligible(item, 'auction')`)
//  - Starting price, optional reserve price, minimum bid increment, optional buyout
//  - High-bid gold escrow with automatic outbid refund via `claim_records`
//  - Late-bid anti-snipe extension window
//  - Deterministic tie handling & bid-vs-close enforcement in the same transaction boundary
//  - Startup + periodic settlement of all due auctions in bounded batches (restart-safe, zero lost gold/items)

import { randomBytes } from 'node:crypto';
import {
  assertItemEligible,
  itemFingerprint,
  normalizeRecord,
  takeForTransfer,
} from '../inventory.js';
import {
  AUCTION_PREFIX,
  ESCROW_KINDS,
  CLAIM_KINDS,
  MarketError,
  clampInt,
  cleanOpKey,
  computeListingFee,
  computeMinBidIncrement,
  computeSaleTax,
  int,
  summarizeItemPublic,
} from './config.js';
import { assertNearMarketBoard } from './boards.js';

const newAuctionId = () => `auc_${randomBytes(6).toString('hex')}`;

function pairKeyOf(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}

export function projectAuctionPublic(auction, cfg) {
  if (!auction) return null;
  const minNextBid = auction.highBid > 0
    ? auction.highBid + computeMinBidIncrement(auction.startPrice, auction.highBid, auction.minIncrement, cfg)
    : auction.startPrice;
  return {
    id: auction.id,
    revision: auction.revision,
    status: auction.status,
    sellerCharacterId: auction.sellerCharacterId,
    sellerName: auction.sellerName,
    item: auction.itemSummary,
    fingerprint: auction.fingerprint,
    startPrice: auction.startPrice,
    reserveMet: auction.highBid >= auction.reservePrice,
    hasReserve: auction.reservePrice > auction.startPrice,
    minIncrement: auction.minIncrement,
    minNextBid,
    buyoutPrice: auction.buyoutPrice,
    highBid: auction.highBid,
    highBidderCharacterId: auction.highBidderCharacterId,
    highBidderName: auction.highBidderName,
    bidCount: auction.bidCount,
    extensions: auction.extensions,
    listingFee: auction.listingFee,
    saleTaxRate: auction.saleTaxRate,
    boardId: auction.boardId,
    region: auction.region,
    town: auction.town,
    createdAt: auction.createdAt,
    endsAt: auction.endsAt,
    settledAt: auction.settledAt,
  };
}

export function createAuctionsService(ctx, cfg, mstore, safety) {
  /**
   * Creates a timed auction for a single eligible item.
   */
  async function createAuction(actor, args = {}, opts = {}) {
    const itemId = String(args.itemId ?? '');
    const startPrice = int(args.startPrice, 0);
    const reservePrice = args.reservePrice != null && args.reservePrice !== '' ? int(args.reservePrice, 0) : startPrice;
    const buyoutPrice = args.buyoutPrice != null && args.buyoutPrice !== '' ? int(args.buyoutPrice, 0) : null;
    const customIncrement = args.minIncrement != null && args.minIncrement !== '' ? int(args.minIncrement, 0) : null;
    const durationMs = clampInt(
      args.durationMs,
      cfg.minAuctionDurationMs,
      cfg.maxAuctionDurationMs,
      cfg.defaultAuctionDurationMs,
    );
    const opKey = cleanOpKey(args.opKey ?? args.requestId);

    if (!itemId) throw new MarketError('INVALID_ITEM', 'Choose an item to auction.');
    if (startPrice < cfg.minPrice || startPrice > cfg.maxPrice) {
      throw new MarketError('INVALID_PRICE', `Starting price must be between ${cfg.minPrice} and ${cfg.maxPrice} gold.`);
    }
    if (reservePrice < startPrice || reservePrice > cfg.maxPrice) {
      throw new MarketError('INVALID_RESERVE', 'Reserve price must be at least the starting price.');
    }
    if (buyoutPrice !== null && (buyoutPrice <= Math.max(startPrice, reservePrice) || buyoutPrice > cfg.maxPrice)) {
      throw new MarketError('INVALID_BUYOUT', 'Buyout price must exceed both starting and reserve prices.');
    }
    if (customIncrement !== null && (customIncrement < 1 || customIncrement > cfg.maxPrice)) {
      throw new MarketError('INVALID_INCREMENT', 'Minimum bid increment must be at least 1 gold.');
    }

    const board = assertNearMarketBoard(actor, cfg, { skipProximity: opts.skipProximity });
    const sellerAccountId = await mstore.resolveAccountId(actor);
    const auctionId = newAuctionId();
    const listingFee = computeListingFee(Math.max(startPrice, reservePrice), cfg);
    const minIncrement = computeMinBidIncrement(startPrice, 0, customIncrement, cfg);

    let committedSeller = null;
    let committedAuction = null;
    let committedLedger = null;

    const { replayed, result } = await mstore.runDurable(
      opKey,
      {
        accountId: sellerAccountId,
        characterId: actor.id,
        resourceKey: `${AUCTION_PREFIX}${opKey || auctionId}`,
        params: { op: 'auction.create', itemId, startPrice, reservePrice, buyoutPrice, minIncrement, durationMs },
        ttlMs: cfg.opKeyTtlMs,
      },
      async (tx) => {
        const now = typeof cfg.wallNow === 'function' ? cfg.wallNow() : tx.now;
        await safety.assertWithinObligationCaps(tx, sellerAccountId, actor.id, ESCROW_KINDS.AUCTION_ITEM);

        const seller = await mstore.loadCharacterInTx(tx, actor);
        const found = seller.rpg.inventory.find((i) => i && i.id === itemId);
        if (!found) {
          const rawFound = (seller._rawInventory ?? []).find((i) => i && i.id === itemId);
          if (rawFound && !normalizeRecord(rawFound)) {
            throw new MarketError('CORRUPTED_ITEM', 'That item record is corrupted and cannot be auctioned.');
          }
          throw new MarketError('ITEM_NOT_FOUND', 'You do not have that item.');
        }
        if (!normalizeRecord(found)) {
          throw new MarketError('CORRUPTED_ITEM', 'That item record is corrupted and cannot be auctioned.');
        }
        // Individual items only: reject stacks > 1 unless quantity === 1.
        const qty = int(args.quantity ?? (found.stackable ? found.quantity : 1), 1);
        assertItemEligible(found, 'auction', { quantity: qty });
        if (seller.rpg.gold < listingFee) {
          throw new MarketError('INSUFFICIENT_GOLD', `You need ${listingFee} gold for the auction listing fee.`);
        }

        const taken = takeForTransfer(seller.rpg, itemId, 1, 'auction');
        seller.rpg.gold -= listingFee;
        const fingerprint = itemFingerprint(taken);
        const endsAt = now + durationMs;

        const itemEscrow = await tx.createEscrow({
          kind: ESCROW_KINDS.AUCTION_ITEM,
          ownerAccountId: sellerAccountId,
          ownerCharacterId: seller.id,
          sourceRef: auctionId,
          gold: 0,
          item: taken,
          status: 'held',
          expiresAt: endsAt,
        });

        const auction = {
          id: auctionId,
          revision: 1,
          status: 'active',
          itemEscrowId: itemEscrow.id,
          sellerCharacterId: seller.id,
          sellerAccountId,
          sellerName: seller.name,
          itemSummary: summarizeItemPublic(taken),
          fingerprint,
          startPrice,
          reservePrice,
          minIncrement,
          buyoutPrice,
          highBid: 0,
          highBidderCharacterId: null,
          highBidderAccountId: null,
          highBidderName: null,
          highBidEscrowId: null,
          highBidAt: null,
          bidCount: 0,
          extensions: 0,
          listingFee,
          saleTaxRate: cfg.saleTaxRate,
          boardId: board.id,
          region: board.region,
          town: board.town,
          createdAt: now,
          originalEndsAt: endsAt,
          endsAt,
          settledAt: null,
        };

        await tx.saveCharacters([seller]);
        await tx.putWorld(`${AUCTION_PREFIX}${auctionId}`, auction);
        const nextLedger = await mstore.recordLedgerInTx(tx, { listingFee });

        committedSeller = seller;
        committedAuction = auction;
        committedLedger = nextLedger;

        return {
          auction: projectAuctionPublic(auction, cfg),
          listingFee,
          remainingGold: seller.rpg.gold,
        };
      },
    );

    if (!replayed && committedSeller) {
      mstore.applyCommittedCharacter(committedSeller, actor);
      mstore.auctions.set(committedAuction.id, committedAuction);
      mstore.applyLedger(committedLedger);
    }

    return { ok: true, replayed, ...result };
  }

  /**
   * Places a bid on an active auction.
   * Escrows bidder's gold, automatically creates a refund claim for the outbid high bidder,
   * enforces the server deadline in the same transaction boundary, and applies the anti-snipe extension window.
   */
  async function placeBid(bidder, args = {}, opts = {}) {
    const auctionId = String(args.auctionId ?? '');
    const amount = int(args.amount, 0);
    const opKey = cleanOpKey(args.opKey ?? args.requestId);
    if (!auctionId) throw new MarketError('INVALID_AUCTION', 'Choose an auction to bid on.');
    if (amount < cfg.minPrice || amount > cfg.maxPrice) {
      throw new MarketError('INVALID_BID', 'Enter a valid bid amount.');
    }

    assertNearMarketBoard(bidder, cfg, { skipProximity: opts.skipProximity });
    const bidderAccountId = await mstore.resolveAccountId(bidder);

    let committedBidder = null;
    let committedAuction = null;
    let committedLedger = null;
    let settlementInfo = null;

    const { replayed, result } = await mstore.runDurable(
      opKey,
      {
        accountId: bidderAccountId,
        characterId: bidder.id,
        resourceKey: `${AUCTION_PREFIX}${auctionId}`,
        params: { op: 'auction.bid', auctionId, amount },
        ttlMs: cfg.opKeyTtlMs,
      },
      async (tx) => {
        const now = typeof cfg.wallNow === 'function' ? cfg.wallNow() : tx.now;
        const auction = await tx.getWorld(`${AUCTION_PREFIX}${auctionId}`);
        if (!auction) throw new MarketError('AUCTION_NOT_FOUND', 'Auction not found.');
        if (auction.status !== 'active' || now >= auction.endsAt) {
          throw new MarketError('AUCTION_ENDED', 'This auction has already ended.');
        }

        // Strict anti-self-bid across all character slots of the seller's account.
        await safety.assertNotSelfTrade(bidder, auction.sellerCharacterId, auction.sellerAccountId);

        // Also forbid outbidding yourself (same account) while already holding the high bid.
        if (auction.highBidderCharacterId != null) {
          await safety.assertNotSelfTrade(bidder, auction.highBidderCharacterId, auction.highBidderAccountId);
        }

        // If bid meets/exceeds buyoutPrice, settle immediately as a buyout!
        if (auction.buyoutPrice != null && amount >= auction.buyoutPrice) {
          return await settleBuyoutInTx(tx, auction, bidder, bidderAccountId, now);
        }

        const minNextBid = auction.highBid > 0
          ? auction.highBid + computeMinBidIncrement(auction.startPrice, auction.highBid, auction.minIncrement, cfg)
          : auction.startPrice;
        if (amount < minNextBid) {
          throw new MarketError('BID_TOO_LOW', `Minimum next bid is ${minNextBid} gold.`, {
            minNextBid,
            highBid: auction.highBid,
            revision: auction.revision,
          });
        }

        await safety.assertWithinObligationCaps(tx, bidderAccountId, bidder.id, ESCROW_KINDS.AUCTION_BID);

        const bidderChar = await mstore.loadCharacterInTx(tx, bidder);
        if (bidderChar.rpg.gold < amount) {
          throw new MarketError('INSUFFICIENT_GOLD', `You need ${amount} gold to place this bid.`);
        }

        // Late-bid anti-snipe extension window.
        let extended = false;
        let nextEndsAt = auction.endsAt;
        if (
          auction.endsAt - now <= cfg.antiSnipeWindowMs
          && auction.extensions < cfg.maxAntiSnipeExtensions
        ) {
          const candidateEnd = now + cfg.antiSnipeExtensionMs;
          if (candidateEnd > auction.endsAt) {
            nextEndsAt = candidateEnd;
            auction.extensions += 1;
            extended = true;
          }
        }

        // Refund prior high bidder via claim_records atomically.
        let outbidClaimId = null;
        if (auction.highBidEscrowId) {
          const prevEsc = await tx.getEscrow(auction.highBidEscrowId);
          if (prevEsc && prevEsc.status === 'held') {
            await tx.updateEscrowStatus(prevEsc.id, prevEsc.revision, 'refunded', { gold: 0 });
            const outbidClaim = await tx.createClaim({
              ownerCharacterId: prevEsc.ownerCharacterId,
              ownerAccountId: prevEsc.ownerAccountId,
              kind: CLAIM_KINDS.AUCTION_OUTBID,
              sourceRef: auction.id,
              gold: prevEsc.gold,
              item: null,
              reason: `Outbid on ${auction.itemSummary?.name ?? 'auction'} (${amount}g)`,
            });
            outbidClaimId = outbidClaim.id;
          }
        }

        bidderChar.rpg.gold -= amount;
        await tx.saveCharacters([bidderChar]);

        const bidEscrow = await tx.createEscrow({
          kind: ESCROW_KINDS.AUCTION_BID,
          ownerAccountId: bidderAccountId,
          ownerCharacterId: bidderChar.id,
          counterpartyCharacterId: auction.sellerCharacterId,
          sourceRef: auction.id,
          gold: amount,
          item: null,
          status: 'held',
          expiresAt: nextEndsAt,
        });

        // Update item escrow counterparty so purge cleanup knows who holds the active bid.
        const itemEsc = await tx.getEscrow(auction.itemEscrowId);
        if (itemEsc && itemEsc.status === 'held') {
          await tx.updateEscrowStatus(itemEsc.id, itemEsc.revision, 'held', {
            counterpartyCharacterId: bidderChar.id,
          });
        }

        auction.highBid = amount;
        auction.highBidderCharacterId = bidderChar.id;
        auction.highBidderAccountId = bidderAccountId;
        auction.highBidderName = bidderChar.name;
        auction.highBidEscrowId = bidEscrow.id;
        auction.highBidAt = now;
        auction.bidCount += 1;
        auction.endsAt = nextEndsAt;
        auction.revision += 1;

        await tx.putWorld(`${AUCTION_PREFIX}${auction.id}`, auction);
        committedBidder = bidderChar;
        committedAuction = auction;

        return {
          auction: projectAuctionPublic(auction, cfg),
          boughtOut: false,
          extended,
          endsAt: auction.endsAt,
          outbidClaimId,
          remainingGold: bidderChar.rpg.gold,
        };
      },
    );

    async function settleBuyoutInTx(tx, auction, buyerActor, buyerAcct, now) {
      const buyout = auction.buyoutPrice;
      const buyerChar = await mstore.loadCharacterInTx(tx, buyerActor);
      if (buyerChar.rpg.gold < buyout) {
        throw new MarketError('INSUFFICIENT_GOLD', `You need ${buyout} gold for buyout.`);
      }

      const itemEsc = await tx.getEscrow(auction.itemEscrowId);
      if (!itemEsc || itemEsc.status !== 'held' || !itemEsc.item) {
        throw new MarketError('ESCROW_UNAVAILABLE', 'Auction item is no longer available.');
      }

      let outbidClaimId = null;
      if (auction.highBidEscrowId) {
        const prevEsc = await tx.getEscrow(auction.highBidEscrowId);
        if (prevEsc && prevEsc.status === 'held') {
          await tx.updateEscrowStatus(prevEsc.id, prevEsc.revision, 'refunded', { gold: 0 });
          const c = await tx.createClaim({
            ownerCharacterId: prevEsc.ownerCharacterId,
            ownerAccountId: prevEsc.ownerAccountId,
            kind: CLAIM_KINDS.AUCTION_OUTBID,
            sourceRef: auction.id,
            gold: prevEsc.gold,
            item: null,
            reason: `Auction bought out for ${auction.itemSummary?.name ?? 'item'}`,
          });
          outbidClaimId = c.id;
        }
      }

      buyerChar.rpg.gold -= buyout;
      await tx.saveCharacters([buyerChar]);

      const saleTax = computeSaleTax(buyout, cfg);
      const sellerProceeds = buyout - saleTax;

      await tx.updateEscrowStatus(itemEsc.id, itemEsc.revision, 'settled', {
        item: null,
        counterpartyCharacterId: buyerChar.id,
      });

      const winnerClaim = await tx.createClaim({
        ownerCharacterId: buyerChar.id,
        ownerAccountId: buyerAcct,
        kind: CLAIM_KINDS.AUCTION_WON,
        sourceRef: auction.id,
        gold: 0,
        item: itemEsc.item,
        reason: `Auction buyout for ${itemEsc.item.name}`,
      });

      const sellerClaim = await tx.createClaim({
        ownerCharacterId: auction.sellerCharacterId,
        ownerAccountId: auction.sellerAccountId,
        kind: CLAIM_KINDS.AUCTION_PROCEEDS,
        sourceRef: auction.id,
        gold: sellerProceeds,
        item: null,
        reason: `Auction buyout proceeds (${buyout}g - ${saleTax}g tax)`,
      });

      auction.status = 'sold';
      auction.highBid = buyout;
      auction.highBidderCharacterId = buyerChar.id;
      auction.highBidderAccountId = buyerAcct;
      auction.highBidderName = buyerChar.name;
      auction.highBidEscrowId = null;
      auction.highBidAt = now;
      auction.bidCount += 1;
      auction.settledAt = now;
      auction.revision += 1;

      const settlement = {
        kind: 'auction_buyout',
        refId: auction.id,
        at: now,
        quantity: 1,
        unitPrice: buyout,
        gross: buyout,
        saleTax,
        sellerProceeds,
        pairKey: pairKeyOf(buyerAcct ?? `c:${buyerChar.id}`, auction.sellerAccountId ?? `c:${auction.sellerCharacterId}`),
      };
      const nextLedger = await mstore.recordLedgerInTx(tx, { saleTax, gross: buyout, settlement });
      await tx.putWorld(`${AUCTION_PREFIX}${auction.id}`, auction);

      committedBidder = buyerChar;
      committedAuction = auction;
      committedLedger = nextLedger;
      settlementInfo = settlement;

      return {
        auction: projectAuctionPublic(auction, cfg),
        boughtOut: true,
        gross: buyout,
        saleTax,
        sellerProceeds,
        winnerClaimId: winnerClaim.id,
        sellerClaimId: sellerClaim.id,
        outbidClaimId,
        remainingGold: buyerChar.rpg.gold,
      };
    }

    if (!replayed && committedBidder) {
      mstore.applyCommittedCharacter(committedBidder, bidder);
      mstore.auctions.set(committedAuction.id, committedAuction);
      if (committedLedger) {
        mstore.applyLedger(committedLedger);
        safety.inspectSettlementPattern(committedLedger, settlementInfo);
      }
    }

    return { ok: true, replayed, ...result };
  }

  /**
   * Explicit buyout action on an active auction with a buyout price.
   */
  async function buyoutAuction(buyer, args = {}, opts = {}) {
    const auctionId = String(args.auctionId ?? '');
    const current = mstore.auctions.get(auctionId);
    if (!current) throw new MarketError('AUCTION_NOT_FOUND', 'Auction not found.');
    if (current.buyoutPrice == null) {
      throw new MarketError('NO_BUYOUT', 'This auction does not have a buyout price.');
    }
    return placeBid(buyer, { ...args, amount: current.buyoutPrice }, opts);
  }

  /**
   * Cancels an active auction ONLY if no bids have been placed yet.
   */
  async function cancelAuction(actor, args = {}) {
    const auctionId = String(args.auctionId ?? '');
    const opKey = cleanOpKey(args.opKey ?? args.requestId);
    if (!auctionId) throw new MarketError('INVALID_AUCTION', 'Choose an auction to cancel.');
    const actorAccountId = await mstore.resolveAccountId(actor);
    let committedAuction = null;

    const { replayed, result } = await mstore.runDurable(
      opKey,
      {
        accountId: actorAccountId,
        characterId: actor.id,
        resourceKey: `${AUCTION_PREFIX}${auctionId}`,
        params: { op: 'auction.cancel', auctionId },
        ttlMs: cfg.opKeyTtlMs,
      },
      async (tx) => {
        const now = typeof cfg.wallNow === 'function' ? cfg.wallNow() : tx.now;
        const auction = await tx.getWorld(`${AUCTION_PREFIX}${auctionId}`);
        if (!auction) throw new MarketError('AUCTION_NOT_FOUND', 'Auction not found.');
        if (Number(auction.sellerCharacterId) !== Number(actor.id)) {
          throw new MarketError('FORBIDDEN', 'You can only cancel your own auctions.');
        }
        if (auction.status !== 'active') {
          throw new MarketError('AUCTION_NOT_ACTIVE', `Auction is already ${auction.status}.`);
        }
        if (auction.bidCount > 0 || auction.highBid > 0) {
          throw new MarketError('AUCTION_HAS_BIDS', 'Auctions with active bids cannot be cancelled.');
        }

        const itemEsc = await tx.getEscrow(auction.itemEscrowId);
        let returnClaim = null;
        if (itemEsc && itemEsc.status === 'held') {
          await tx.updateEscrowStatus(itemEsc.id, itemEsc.revision, 'released', { item: null });
          if (itemEsc.item) {
            returnClaim = await tx.createClaim({
              ownerCharacterId: auction.sellerCharacterId,
              ownerAccountId: auction.sellerAccountId,
              kind: CLAIM_KINDS.AUCTION_CANCELLED,
              sourceRef: auction.id,
              gold: 0,
              item: itemEsc.item,
              reason: `Cancelled auction for ${itemEsc.item.name}`,
            });
          }
        }

        auction.status = 'cancelled';
        auction.settledAt = now;
        auction.revision += 1;
        await tx.putWorld(`${AUCTION_PREFIX}${auction.id}`, auction);
        committedAuction = auction;

        return {
          auction: projectAuctionPublic(auction, cfg),
          returnClaimId: returnClaim?.id ?? null,
        };
      },
    );

    if (!replayed && committedAuction) {
      mstore.auctions.set(committedAuction.id, committedAuction);
    }
    return { ok: true, replayed, ...result };
  }

  /**
   * Settles all due active auctions (`endsAt <= nowMs`) in bounded batches.
   * Safe on startup after crash/restart and idempotent under concurrent calls.
   */
  async function settleDueAuctions(nowMs = mstore.wallNow(), { limit = cfg.settlementBatchLimit } = {}) {
    const due = [...mstore.auctions.values()]
      .filter((a) => a.status === 'active' && a.endsAt <= nowMs)
      .sort((a, b) => a.endsAt - b.endsAt || a.id.localeCompare(b.id))
      .slice(0, limit);

    const settled = [];
    for (const a of due) {
      let committedAuction = null;
      let committedLedger = null;
      let settlementInfo = null;

      const { result } = await mstore.runDurable(
        `auction-settle:${a.id}`,
        { resourceKey: `${AUCTION_PREFIX}${a.id}`, params: { op: 'auction.settle', auctionId: a.id } },
        async (tx) => {
          const now = typeof cfg.wallNow === 'function' ? cfg.wallNow() : tx.now;
          const cur = await tx.getWorld(`${AUCTION_PREFIX}${a.id}`);
          if (!cur || cur.status !== 'active' || cur.endsAt > now) return { skipped: true };

          const itemEsc = await tx.getEscrow(cur.itemEscrowId);
          const hasWinner = cur.highBid > 0
            && cur.highBidderCharacterId != null
            && cur.highBidEscrowId != null
            && cur.highBid >= cur.reservePrice;

          if (hasWinner && itemEsc && itemEsc.status === 'held' && itemEsc.item) {
            const bidEsc = await tx.getEscrow(cur.highBidEscrowId);
            if (!bidEsc || bidEsc.status !== 'held' || bidEsc.gold < cur.highBid) {
              throw new MarketError('BID_ESCROW_MISMATCH', `Auction ${cur.id} bid escrow missing or inconsistent.`);
            }
            const gross = bidEsc.gold;
            const saleTax = computeSaleTax(gross, cfg);
            const sellerProceeds = gross - saleTax;

            await tx.updateEscrowStatus(itemEsc.id, itemEsc.revision, 'settled', { item: null });
            await tx.updateEscrowStatus(bidEsc.id, bidEsc.revision, 'settled', { gold: 0 });

            const winnerClaim = await tx.createClaim({
              ownerCharacterId: cur.highBidderCharacterId,
              ownerAccountId: cur.highBidderAccountId,
              kind: CLAIM_KINDS.AUCTION_WON,
              sourceRef: cur.id,
              gold: 0,
              item: itemEsc.item,
              reason: `Won auction for ${itemEsc.item.name} (${gross}g)`,
            });
            const sellerClaim = await tx.createClaim({
              ownerCharacterId: cur.sellerCharacterId,
              ownerAccountId: cur.sellerAccountId,
              kind: CLAIM_KINDS.AUCTION_PROCEEDS,
              sourceRef: cur.id,
              gold: sellerProceeds,
              item: null,
              reason: `Auction sold ${itemEsc.item.name} (${gross}g - ${saleTax}g tax)`,
            });

            cur.status = 'sold';
            cur.settledAt = now;
            cur.revision += 1;

            const settlement = {
              kind: 'auction_sale',
              refId: cur.id,
              at: now,
              quantity: 1,
              unitPrice: gross,
              gross,
              saleTax,
              sellerProceeds,
              pairKey: pairKeyOf(
                cur.highBidderAccountId ?? `c:${cur.highBidderCharacterId}`,
                cur.sellerAccountId ?? `c:${cur.sellerCharacterId}`,
              ),
            };
            const nextLedger = await mstore.recordLedgerInTx(tx, { saleTax, gross, settlement });
            await tx.putWorld(`${AUCTION_PREFIX}${cur.id}`, cur);

            committedAuction = cur;
            committedLedger = nextLedger;
            settlementInfo = settlement;

            return {
              auctionId: cur.id,
              outcome: 'sold',
              gross,
              saleTax,
              sellerProceeds,
              winnerClaimId: winnerClaim.id,
              sellerClaimId: sellerClaim.id,
            };
          }

          // Unsold (no bids or reserve not met): return item to seller & refund any below-reserve bidder.
          let sellerReturnClaimId = null;
          let bidderRefundClaimId = null;
          if (itemEsc && itemEsc.status === 'held') {
            await tx.updateEscrowStatus(itemEsc.id, itemEsc.revision, 'expired', { item: null, counterpartyCharacterId: null });
            if (itemEsc.item) {
              const c = await tx.createClaim({
                ownerCharacterId: cur.sellerCharacterId,
                ownerAccountId: cur.sellerAccountId,
                kind: CLAIM_KINDS.AUCTION_UNSOLD,
                sourceRef: cur.id,
                gold: 0,
                item: itemEsc.item,
                reason: cur.highBid > 0
                  ? `Auction ended below reserve (${cur.highBid}g < ${cur.reservePrice}g)`
                  : `Auction ended with no bids for ${itemEsc.item.name}`,
              });
              sellerReturnClaimId = c.id;
            }
          }
          if (cur.highBidEscrowId) {
            const bidEsc = await tx.getEscrow(cur.highBidEscrowId);
            if (bidEsc && bidEsc.status === 'held' && bidEsc.gold > 0) {
              await tx.updateEscrowStatus(bidEsc.id, bidEsc.revision, 'refunded', { gold: 0 });
              const rc = await tx.createClaim({
                ownerCharacterId: bidEsc.ownerCharacterId,
                ownerAccountId: bidEsc.ownerAccountId,
                kind: CLAIM_KINDS.AUCTION_RESERVE_REFUND,
                sourceRef: cur.id,
                gold: bidEsc.gold,
                item: null,
                reason: `Reserve price not met on ${cur.itemSummary?.name ?? 'auction'}; bid refunded`,
              });
              bidderRefundClaimId = rc.id;
            }
          }

          cur.status = 'expired';
          cur.settledAt = now;
          cur.revision += 1;
          await tx.putWorld(`${AUCTION_PREFIX}${cur.id}`, cur);
          committedAuction = cur;

          return {
            auctionId: cur.id,
            outcome: 'expired',
            sellerReturnClaimId,
            bidderRefundClaimId,
          };
        },
      );

      if (committedAuction) {
        mstore.auctions.set(committedAuction.id, committedAuction);
        if (committedLedger) {
          mstore.applyLedger(committedLedger);
          safety.inspectSettlementPattern(committedLedger, settlementInfo);
        }
        settled.push(result);
      }
    }
    return settled;
  }

  /**
   * Paginated browse / search / filter / sort over active timed auctions.
   */
  function browseAuctions(query = {}) {
    const now = mstore.wallNow();
    const search = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
    const group = typeof query.group === 'string' && query.group.trim() && query.group !== 'all' ? query.group.trim().toLowerCase() : null;
    const region = typeof query.region === 'string' && query.region.trim() && query.region !== 'all' ? query.region.trim().toLowerCase() : null;
    const quality = typeof query.quality === 'string' && query.quality.trim() && query.quality !== 'all' ? query.quality.trim().toLowerCase() : null;
    const sort = typeof query.sort === 'string' ? query.sort : 'ending_soon';
    const pageSize = clampInt(query.limit ?? query.pageSize, 1, cfg.pageSizeMax, cfg.pageSizeDefault);
    const pageNum = Math.max(1, int(query.page, 1));

    const matched = [];
    for (const a of mstore.auctions.values()) {
      if (a.status !== 'active' || a.endsAt <= now) continue;
      if (group && String(a.itemSummary?.group ?? '').toLowerCase() !== group) continue;
      if (region && String(a.region ?? '').toLowerCase() !== region) continue;
      if (quality && String(a.itemSummary?.quality ?? '').toLowerCase() !== quality) continue;
      if (search) {
        const hay = [a.itemSummary?.name, a.itemSummary?.template, a.itemSummary?.group, a.sellerName, a.region, a.town]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(search)) continue;
      }
      matched.push(a);
    }

    matched.sort((a, b) => {
      let cmp = 0;
      const pa = a.highBid > 0 ? a.highBid : a.startPrice;
      const pb = b.highBid > 0 ? b.highBid : b.startPrice;
      switch (sort) {
        case 'price_asc':
          cmp = pa - pb;
          break;
        case 'price_desc':
          cmp = pb - pa;
          break;
        case 'bids_desc':
          cmp = b.bidCount - a.bidCount;
          break;
        case 'newest':
          cmp = b.createdAt - a.createdAt;
          break;
        case 'ending_soon':
        default:
          cmp = a.endsAt - b.endsAt;
          break;
      }
      return cmp || a.id.localeCompare(b.id);
    });

    const total = matched.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(pageNum, totalPages);
    const start = (safePage - 1) * pageSize;

    return {
      page: safePage,
      pageSize,
      total,
      totalPages,
      hasMore: safePage < totalPages,
      sort,
      items: matched.slice(start, start + pageSize).map((a) => projectAuctionPublic(a, cfg)),
    };
  }

  return {
    createAuction,
    placeBid,
    buyoutAuction,
    cancelAuction,
    settleDueAuctions,
    browseAuctions,
  };
}
