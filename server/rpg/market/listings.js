// Fixed-Price Town Market Boards & House Trader listings.
//
// Features:
//  - Paginated browse/search/filter/sort with stable tie-breaker
//  - Strict item eligibility via `server/rpg/inventory.js` (`takeForTransfer`, `assertItemEligible`, `itemFingerprint`, `splitStack`)
//  - Durable item escrow (`escrow_records`) & offline claims (`claim_records`) via `runDurable`
//  - Stale-revision & unit-price lock quote protection (`expectedRev`, `expectedUnitPrice`)
//  - Partial-stack purchases, listing fees & sale tax, cancellation & expiry
//  - House Traders backed by the exact same `escrow_records` & `claim_records` ledger (zero duplication)

import { randomBytes } from 'node:crypto';
import {
  assertItemEligible,
  itemFingerprint,
  normalizeRecord,
  splitStack,
  takeForTransfer,
} from '../inventory.js';
import {
  LISTING_PREFIX,
  TRADERS_PREFIX,
  ESCROW_KINDS,
  CLAIM_KINDS,
  MarketError,
  clampInt,
  cleanOpKey,
  computeListingFee,
  computeSaleTax,
  int,
  summarizeItemPublic,
} from './config.js';
import { assertNearMarketBoard, verifyHouseTraderAccess } from './boards.js';

const newListingId = () => `lst_${randomBytes(6).toString('hex')}`;

function pairKeyOf(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}

export function projectListingPublic(listing) {
  if (!listing) return null;
  return {
    id: listing.id,
    revision: listing.revision,
    status: listing.status,
    sellerCharacterId: listing.sellerCharacterId,
    sellerName: listing.sellerName,
    item: listing.itemSummary,
    fingerprint: listing.fingerprint,
    unitPrice: listing.unitPrice,
    initialQuantity: listing.initialQuantity,
    remainingQuantity: listing.remainingQuantity,
    totalPrice: listing.unitPrice * listing.remainingQuantity,
    listingFee: listing.listingFee,
    saleTaxRate: listing.saleTaxRate,
    boardId: listing.boardId,
    region: listing.region,
    town: listing.town,
    houseTrader: listing.houseTrader ? { ...listing.houseTrader } : null,
    createdAt: listing.createdAt,
    expiresAt: listing.expiresAt,
  };
}

export function createListingsService(ctx, cfg, mstore, safety) {
  /**
   * Computes a non-mutating listing fee & sale-tax quote for the UI before confirmation.
   */
  function quoteListing(actor, { itemId, quantity = 1, unitPrice }) {
    const item = (actor?.rpg?.inventory ?? []).find((i) => i && i.id === String(itemId ?? ''));
    if (!item) throw new MarketError('ITEM_NOT_FOUND', 'You do not have that item.');
    const normalized = normalizeRecord(item);
    if (!normalized) throw new MarketError('CORRUPTED_ITEM', 'That item record is corrupted and cannot be listed.');
    assertItemEligible(item, 'market');
    const qty = int(quantity, 0);
    if (qty < 1 || qty > item.quantity || qty > cfg.maxQuantity) {
      throw new MarketError('INVALID_QUANTITY', `Quantity must be between 1 and ${Math.min(item.quantity, cfg.maxQuantity)}.`);
    }
    const price = int(unitPrice, 0);
    if (price < cfg.minPrice || price > cfg.maxPrice) {
      throw new MarketError('INVALID_PRICE', `Unit price must be between ${cfg.minPrice} and ${cfg.maxPrice} gold.`);
    }
    const grossTotal = price * qty;
    const listingFee = computeListingFee(grossTotal, cfg);
    const estSaleTax = computeSaleTax(grossTotal, cfg);
    return {
      item: summarizeItemPublic(item),
      quantity: qty,
      unitPrice: price,
      grossTotal,
      listingFee,
      saleTaxRate: cfg.saleTaxRate,
      estSaleTax,
      estNetProceeds: grossTotal - estSaleTax,
    };
  }

  /**
   * Creates a fixed-price listing (at a town board or directly assigned to an owned House Trader).
   */
  async function createListing(actor, args = {}, opts = {}) {
    const itemId = String(args.itemId ?? '');
    const qty = int(args.quantity ?? 1, 0);
    const unitPrice = int(args.unitPrice, 0);
    if (!itemId) throw new MarketError('INVALID_ITEM', 'Choose an item to list.');
    if (qty < 1 || qty > cfg.maxQuantity) throw new MarketError('INVALID_QUANTITY', 'Invalid listing quantity.');
    if (unitPrice < cfg.minPrice || unitPrice > cfg.maxPrice) {
      throw new MarketError('INVALID_PRICE', `Unit price must be between ${cfg.minPrice} and ${cfg.maxPrice} gold.`);
    }
    const durationMs = clampInt(
      args.durationMs,
      cfg.minListingDurationMs,
      cfg.maxListingDurationMs,
      cfg.defaultListingDurationMs,
    );
    const opKey = cleanOpKey(args.opKey ?? args.requestId);

    let board = null;
    let houseTrader = null;
    if (args.houseId || args.traderId) {
      const access = await verifyHouseTraderAccess(
        ctx,
        actor,
        { houseId: args.houseId, traderId: args.traderId, mode: 'manage' },
        mstore.traders,
      );
      houseTrader = {
        houseId: access.houseId,
        traderId: access.traderId,
        town: access.town,
        region: access.region,
        label: access.label,
      };
      board = { id: `trader:${access.traderId}`, region: access.region, town: access.town };
    } else {
      board = assertNearMarketBoard(actor, cfg, { skipProximity: opts.skipProximity });
    }

    const sellerAccountId = await mstore.resolveAccountId(actor);
    const listingId = newListingId();
    const grossTotal = unitPrice * qty;
    const listingFee = computeListingFee(grossTotal, cfg);

    let committedSeller = null;
    let committedListing = null;
    let committedLedger = null;

    const { replayed, result } = await mstore.runDurable(
      opKey,
      {
        accountId: sellerAccountId,
        characterId: actor.id,
        resourceKey: `${LISTING_PREFIX}${opKey || listingId}`,
        params: {
          op: 'listing.create',
          itemId,
          qty,
          unitPrice,
          durationMs,
          houseId: houseTrader?.houseId ?? null,
          traderId: houseTrader?.traderId ?? null,
        },
        ttlMs: cfg.opKeyTtlMs,
      },
      async (tx) => {
        const now = typeof cfg.wallNow === 'function' ? cfg.wallNow() : tx.now;
        await safety.assertWithinObligationCaps(tx, sellerAccountId, actor.id, ESCROW_KINDS.LISTING_ITEM);

        const seller = await mstore.loadCharacterInTx(tx, actor);
        const found = seller.rpg.inventory.find((i) => i && i.id === itemId);
        if (!found) {
          const rawFound = (seller._rawInventory ?? []).find((i) => i && i.id === itemId);
          if (rawFound && !normalizeRecord(rawFound)) {
            throw new MarketError('CORRUPTED_ITEM', 'That item record is corrupted and cannot be listed.');
          }
          throw new MarketError('ITEM_NOT_FOUND', 'You do not have that item.');
        }
        if (!normalizeRecord(found)) {
          throw new MarketError('CORRUPTED_ITEM', 'That item record is corrupted and cannot be listed.');
        }
        assertItemEligible(found, 'market');
        if (found.quantity < qty) {
          throw new MarketError('INSUFFICIENT_QUANTITY', `You only have ${found.quantity} ${found.name}.`);
        }
        if (seller.rpg.gold < listingFee) {
          throw new MarketError('INSUFFICIENT_GOLD', `You need ${listingFee} gold for the listing fee.`);
        }

        const taken = takeForTransfer(seller.rpg, itemId, qty, 'market');
        seller.rpg.gold -= listingFee;
        const fingerprint = itemFingerprint(taken);
        const expiresAt = now + durationMs;

        const escrow = await tx.createEscrow({
          kind: ESCROW_KINDS.LISTING_ITEM,
          ownerAccountId: sellerAccountId,
          ownerCharacterId: seller.id,
          sourceRef: listingId,
          gold: 0,
          item: taken,
          status: 'held',
          expiresAt,
        });

        const listing = {
          id: listingId,
          revision: 1,
          status: 'active',
          escrowId: escrow.id,
          sellerCharacterId: seller.id,
          sellerAccountId: sellerAccountId,
          sellerName: seller.name,
          itemSummary: summarizeItemPublic(taken),
          fingerprint,
          unitPrice,
          initialQuantity: qty,
          remainingQuantity: qty,
          listingFee,
          saleTaxRate: cfg.saleTaxRate,
          boardId: board.id,
          region: board.region,
          town: board.town,
          houseTrader,
          createdAt: now,
          expiresAt,
          settledAt: null,
        };

        await tx.saveCharacters([seller]);
        await tx.putWorld(`${LISTING_PREFIX}${listingId}`, listing);
        const nextLedger = await mstore.recordLedgerInTx(tx, { listingFee });

        committedSeller = seller;
        committedListing = listing;
        committedLedger = nextLedger;

        return {
          listing: projectListingPublic(listing),
          escrowId: escrow.id,
          listingFee,
          remainingGold: seller.rpg.gold,
        };
      },
    );

    if (!replayed && committedSeller) {
      mstore.applyCommittedCharacter(committedSeller, actor);
      mstore.listings.set(committedListing.id, committedListing);
      mstore.applyLedger(committedLedger);
    }

    return { ok: true, replayed, ...result };
  }

  /**
   * Purchases `quantity` units from an active fixed-price listing (via town board or house trader).
   * Enforces stale-revision (`expectedRev`) and unit-price lock (`expectedUnitPrice`) protection,
   * anti-self-trade across account slots, and atomic item/gold claim delivery.
   */
  async function buyListing(buyer, args = {}, opts = {}) {
    const listingId = String(args.listingId ?? '');
    const qty = int(args.quantity ?? 1, 0);
    const expectedRev = args.expectedRev != null ? int(args.expectedRev, -1) : null;
    const expectedUnitPrice = args.expectedUnitPrice != null ? int(args.expectedUnitPrice, -1) : null;
    const opKey = cleanOpKey(args.opKey ?? args.requestId);

    if (!listingId) throw new MarketError('INVALID_LISTING', 'Choose a listing to purchase.');
    if (qty < 1 || qty > cfg.maxQuantity) throw new MarketError('INVALID_QUANTITY', 'Invalid purchase quantity.');

    // Validate proximity either to a house trader (if buying at trader) or a town market board.
    if (args.houseId || args.traderId) {
      await verifyHouseTraderAccess(
        ctx,
        buyer,
        { houseId: args.houseId, traderId: args.traderId, mode: 'buy' },
        mstore.traders,
      );
    } else {
      assertNearMarketBoard(buyer, cfg, { skipProximity: opts.skipProximity });
    }

    const buyerAccountId = await mstore.resolveAccountId(buyer);
    let committedBuyer = null;
    let committedListing = null;
    let committedLedger = null;
    let settlementInfo = null;

    const { replayed, result } = await mstore.runDurable(
      opKey,
      {
        accountId: buyerAccountId,
        characterId: buyer.id,
        resourceKey: `${LISTING_PREFIX}${listingId}`,
        params: {
          op: 'listing.buy',
          listingId,
          qty,
          expectedRev,
          expectedUnitPrice,
        },
        ttlMs: cfg.opKeyTtlMs,
      },
      async (tx) => {
        const now = typeof cfg.wallNow === 'function' ? cfg.wallNow() : tx.now;
        const listing = await tx.getWorld(`${LISTING_PREFIX}${listingId}`);
        if (!listing) throw new MarketError('LISTING_NOT_FOUND', 'That listing no longer exists.');

        // If the listing is assigned to a specific house trader and buyer specified traderId, verify match.
        if (args.traderId && listing.houseTrader?.traderId !== String(args.traderId)) {
          throw new MarketError('TRADER_MISMATCH', 'That listing is not stocked at this house trader.');
        }

        if (listing.status !== 'active' || now >= listing.expiresAt || listing.remainingQuantity <= 0) {
          throw new MarketError('SOLD_OUT', 'This listing is no longer available.', {
            freshQuote: {
              listingId: listing.id,
              revision: listing.revision,
              status: now >= listing.expiresAt && listing.status === 'active' ? 'expired' : listing.status,
              unitPrice: listing.unitPrice,
              remainingQuantity: 0,
              expiresAt: listing.expiresAt,
            },
          });
        }

        // Strict anti-self-trade across all character slots of the same account.
        await safety.assertNotSelfTrade(buyer, listing.sellerCharacterId, listing.sellerAccountId);

        // Stale-revision & price-lock quote protection.
        const freshQuote = {
          listingId: listing.id,
          revision: listing.revision,
          status: listing.status,
          unitPrice: listing.unitPrice,
          remainingQuantity: listing.remainingQuantity,
          expiresAt: listing.expiresAt,
        };
        if (expectedRev !== null && listing.revision !== expectedRev) {
          throw new MarketError(
            'STALE_QUOTE',
            'This listing changed since you viewed it. Review the updated quote and try again.',
            { freshQuote },
          );
        }
        if (expectedUnitPrice !== null && listing.unitPrice !== expectedUnitPrice) {
          throw new MarketError(
            'STALE_PRICE',
            `Price changed to ${listing.unitPrice} gold per unit. Review the updated quote.`,
            { freshQuote },
          );
        }
        if (qty > listing.remainingQuantity) {
          throw new MarketError(
            'INSUFFICIENT_STOCK',
            `Only ${listing.remainingQuantity} remaining on this listing.`,
            { freshQuote },
          );
        }

        const esc = await tx.getEscrow(listing.escrowId);
        if (!esc || esc.status !== 'held' || !esc.item || esc.item.quantity < qty) {
          throw new MarketError('ESCROW_UNAVAILABLE', 'Escrowed stock for this listing is no longer available.', { freshQuote });
        }

        const gross = listing.unitPrice * qty;
        const saleTax = computeSaleTax(gross, cfg);
        const sellerProceeds = gross - saleTax;

        const buyerChar = await mstore.loadCharacterInTx(tx, buyer);
        if (buyerChar.rpg.gold < gross) {
          throw new MarketError('INSUFFICIENT_GOLD', `You need ${gross} gold (you have ${buyerChar.rpg.gold}).`);
        }

        const { remaining, split } = splitStack(esc.item, qty);
        buyerChar.rpg.gold -= gross;
        await tx.saveCharacters([buyerChar]);

        if (remaining === null) {
          await tx.updateEscrowStatus(esc.id, esc.revision, 'settled', {
            item: null,
            counterpartyCharacterId: buyerChar.id,
          });
          listing.remainingQuantity = 0;
          listing.status = 'sold';
          listing.settledAt = now;
        } else {
          await tx.updateEscrowStatus(esc.id, esc.revision, 'held', { item: remaining });
          listing.remainingQuantity = remaining.quantity;
        }
        listing.revision += 1;

        const buyerClaim = await tx.createClaim({
          ownerCharacterId: buyerChar.id,
          ownerAccountId: buyerAccountId,
          kind: CLAIM_KINDS.PURCHASE_ITEM,
          sourceRef: listing.id,
          gold: 0,
          item: split,
          reason: `Purchased ${qty}x ${split.name} from ${listing.sellerName}`,
        });

        const sellerClaim = await tx.createClaim({
          ownerCharacterId: listing.sellerCharacterId,
          ownerAccountId: listing.sellerAccountId,
          kind: CLAIM_KINDS.SALE_PROCEEDS,
          sourceRef: listing.id,
          gold: sellerProceeds,
          item: null,
          reason: `Sold ${qty}x ${split.name} (${gross}g - ${saleTax}g tax)`,
        });

        const settlement = {
          kind: 'fixed_sale',
          refId: listing.id,
          at: now,
          quantity: qty,
          unitPrice: listing.unitPrice,
          gross,
          saleTax,
          sellerProceeds,
          pairKey: pairKeyOf(buyerAccountId ?? `c:${buyerChar.id}`, listing.sellerAccountId ?? `c:${listing.sellerCharacterId}`),
        };
        const nextLedger = await mstore.recordLedgerInTx(tx, { saleTax, gross, settlement });
        await tx.putWorld(`${LISTING_PREFIX}${listing.id}`, listing);

        committedBuyer = buyerChar;
        committedListing = listing;
        committedLedger = nextLedger;
        settlementInfo = settlement;

        return {
          listing: projectListingPublic(listing),
          purchasedQuantity: qty,
          gross,
          saleTax,
          sellerProceeds,
          buyerClaimId: buyerClaim.id,
          sellerClaimId: sellerClaim.id,
          remainingGold: buyerChar.rpg.gold,
        };
      },
    );

    if (!replayed && committedBuyer) {
      mstore.applyCommittedCharacter(committedBuyer, buyer);
      mstore.listings.set(committedListing.id, committedListing);
      mstore.applyLedger(committedLedger);
      safety.inspectSettlementPattern(committedLedger, settlementInfo);
    }

    return { ok: true, replayed, ...result };
  }

  /**
   * Cancels an active fixed-price listing and creates exactly one claim for remaining escrowed items.
   */
  async function cancelListing(actor, args = {}) {
    const listingId = String(args.listingId ?? '');
    const opKey = cleanOpKey(args.opKey ?? args.requestId);
    if (!listingId) throw new MarketError('INVALID_LISTING', 'Choose a listing to cancel.');

    const actorAccountId = await mstore.resolveAccountId(actor);
    let committedListing = null;

    const { replayed, result } = await mstore.runDurable(
      opKey,
      {
        accountId: actorAccountId,
        characterId: actor.id,
        resourceKey: `${LISTING_PREFIX}${listingId}`,
        params: { op: 'listing.cancel', listingId },
        ttlMs: cfg.opKeyTtlMs,
      },
      async (tx) => {
        const now = typeof cfg.wallNow === 'function' ? cfg.wallNow() : tx.now;
        const listing = await tx.getWorld(`${LISTING_PREFIX}${listingId}`);
        if (!listing) throw new MarketError('LISTING_NOT_FOUND', 'Listing not found.');
        if (Number(listing.sellerCharacterId) !== Number(actor.id)) {
          throw new MarketError('FORBIDDEN', 'You can only cancel your own listings.');
        }
        if (listing.status !== 'active') {
          throw new MarketError('LISTING_NOT_ACTIVE', `Listing is already ${listing.status}.`);
        }

        const esc = await tx.getEscrow(listing.escrowId);
        let returnClaim = null;
        if (esc && esc.status === 'held') {
          await tx.updateEscrowStatus(esc.id, esc.revision, 'released', { item: null });
          if (esc.item) {
            returnClaim = await tx.createClaim({
              ownerCharacterId: listing.sellerCharacterId,
              ownerAccountId: listing.sellerAccountId,
              kind: CLAIM_KINDS.LISTING_CANCELLED,
              sourceRef: listing.id,
              gold: 0,
              item: esc.item,
              reason: `Cancelled listing for ${esc.item.name}`,
            });
          }
        }

        listing.status = 'cancelled';
        listing.remainingQuantity = 0;
        listing.houseTrader = null;
        listing.revision += 1;
        listing.settledAt = now;
        await tx.putWorld(`${LISTING_PREFIX}${listing.id}`, listing);
        committedListing = listing;

        return {
          listing: projectListingPublic(listing),
          returnClaimId: returnClaim?.id ?? null,
        };
      },
    );

    if (!replayed && committedListing) {
      mstore.listings.set(committedListing.id, committedListing);
    }

    return { ok: true, replayed, ...result };
  }

  /**
   * Expires due fixed-price listings in bounded batches, returning remaining items once via claims.
   */
  async function expireDueListings(nowMs = mstore.wallNow(), { limit = cfg.settlementBatchLimit } = {}) {
    const due = [...mstore.listings.values()]
      .filter((l) => l.status === 'active' && l.expiresAt <= nowMs)
      .sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id))
      .slice(0, limit);

    const expired = [];
    for (const l of due) {
      let committedListing = null;
      const { result } = await mstore.runDurable(
        `listing-expire:${l.id}`,
        { resourceKey: `${LISTING_PREFIX}${l.id}`, params: { op: 'listing.expire', listingId: l.id } },
        async (tx) => {
          const now = typeof cfg.wallNow === 'function' ? cfg.wallNow() : tx.now;
          const cur = await tx.getWorld(`${LISTING_PREFIX}${l.id}`);
          if (!cur || cur.status !== 'active' || cur.expiresAt > now) return { skipped: true };
          const esc = await tx.getEscrow(cur.escrowId);
          let claim = null;
          if (esc && esc.status === 'held') {
            await tx.updateEscrowStatus(esc.id, esc.revision, 'expired', { item: null });
            if (esc.item) {
              claim = await tx.createClaim({
                ownerCharacterId: cur.sellerCharacterId,
                ownerAccountId: cur.sellerAccountId,
                kind: CLAIM_KINDS.LISTING_EXPIRED,
                sourceRef: cur.id,
                gold: 0,
                item: esc.item,
                reason: `Expired listing for ${esc.item.name}`,
              });
            }
          }
          cur.status = 'expired';
          cur.remainingQuantity = 0;
          cur.houseTrader = null;
          cur.revision += 1;
          cur.settledAt = now;
          await tx.putWorld(`${LISTING_PREFIX}${cur.id}`, cur);
          committedListing = cur;
          return { listingId: cur.id, claimId: claim?.id ?? null };
        },
      );
      if (committedListing) {
        mstore.listings.set(committedListing.id, committedListing);
        expired.push(result);
      }
    }
    return expired;
  }

  /**
   * Assigns an existing active listing to a placed House Trader without duplicating stock or escrow.
   */
  async function assignHouseTrader(actor, args = {}) {
    const listingId = String(args.listingId ?? '');
    if (!listingId) throw new MarketError('INVALID_LISTING', 'Choose a listing to assign.');
    const access = await verifyHouseTraderAccess(
      ctx,
      actor,
      { houseId: args.houseId, traderId: args.traderId, mode: 'manage' },
      mstore.traders,
    );

    const actorAccountId = await mstore.resolveAccountId(actor);
    let committedListing = null;

    const { replayed, result } = await mstore.runDurable(
      cleanOpKey(args.opKey ?? args.requestId),
      {
        accountId: actorAccountId,
        characterId: actor.id,
        resourceKey: `${LISTING_PREFIX}${listingId}`,
        params: { op: 'trader.assign', listingId, houseId: access.houseId, traderId: access.traderId },
        ttlMs: cfg.opKeyTtlMs,
      },
      async (tx) => {
        const listing = await tx.getWorld(`${LISTING_PREFIX}${listingId}`);
        if (!listing || listing.status !== 'active') {
          throw new MarketError('LISTING_NOT_ACTIVE', 'Only active listings can be assigned to a house trader.');
        }
        if (Number(listing.sellerCharacterId) !== Number(actor.id)) {
          throw new MarketError('FORBIDDEN', 'You can only assign your own listings to a house trader.');
        }
        listing.houseTrader = {
          houseId: access.houseId,
          traderId: access.traderId,
          town: access.town,
          region: access.region,
          label: access.label,
        };
        listing.revision += 1;
        await tx.putWorld(`${LISTING_PREFIX}${listing.id}`, listing);
        committedListing = listing;
        return { listing: projectListingPublic(listing) };
      },
    );

    if (!replayed && committedListing) {
      mstore.listings.set(committedListing.id, committedListing);
      if (typeof ctx.services?.homes?.attachTraderListing === 'function') {
        try { ctx.services.homes.attachTraderListing(access.houseId, actor.id, committedListing.id); } catch {}
      }
    }
    return { ok: true, replayed, ...result };
  }

  /**
   * Detaches a listing from a House Trader (keeping the single escrow & public board listing intact).
   */
  async function detachHouseTrader(actor, args = {}) {
    const listingId = String(args.listingId ?? '');
    if (!listingId) throw new MarketError('INVALID_LISTING', 'Choose a listing to detach.');
    const actorAccountId = await mstore.resolveAccountId(actor);
    let prevHouseId = null;
    let committedListing = null;

    const { replayed, result } = await mstore.runDurable(
      cleanOpKey(args.opKey ?? args.requestId),
      {
        accountId: actorAccountId,
        characterId: actor.id,
        resourceKey: `${LISTING_PREFIX}${listingId}`,
        params: { op: 'trader.detach', listingId },
        ttlMs: cfg.opKeyTtlMs,
      },
      async (tx) => {
        const listing = await tx.getWorld(`${LISTING_PREFIX}${listingId}`);
        if (!listing) throw new MarketError('LISTING_NOT_FOUND', 'Listing not found.');
        if (Number(listing.sellerCharacterId) !== Number(actor.id)) {
          throw new MarketError('FORBIDDEN', 'You can only detach your own listings.');
        }
        prevHouseId = listing.houseTrader?.houseId ?? null;
        listing.houseTrader = null;
        listing.revision += 1;
        await tx.putWorld(`${LISTING_PREFIX}${listing.id}`, listing);
        committedListing = listing;
        return { listing: projectListingPublic(listing) };
      },
    );

    if (!replayed && committedListing) {
      mstore.listings.set(committedListing.id, committedListing);
      if (prevHouseId && typeof ctx.services?.homes?.detachTraderListing === 'function') {
        try { ctx.services.homes.detachTraderListing(prevHouseId, actor.id, committedListing.id); } catch {}
      }
    }
    return { ok: true, replayed, ...result };
  }

  /**
   * Helper for `homes` house-sale lifecycle: detaches all active trader listings for a house without losing escrow.
   */
  async function detachAllForHouse(houseId) {
    const hid = String(houseId ?? '');
    const affected = [...mstore.listings.values()].filter(
      (l) => l.status === 'active' && l.houseTrader?.houseId === hid,
    );
    const detached = [];
    for (const l of affected) {
      let committed = null;
      await mstore.runDurable(
        `trader-detach-house:${hid}:${l.id}`,
        { resourceKey: `${LISTING_PREFIX}${l.id}`, params: { op: 'trader.detachHouse', houseId: hid, listingId: l.id } },
        async (tx) => {
          const cur = await tx.getWorld(`${LISTING_PREFIX}${l.id}`);
          if (!cur || cur.houseTrader?.houseId !== hid) return { skipped: true };
          cur.houseTrader = null;
          cur.revision += 1;
          await tx.putWorld(`${LISTING_PREFIX}${cur.id}`, cur);
          committed = cur;
          return { listingId: cur.id };
        },
      );
      if (committed) {
        mstore.listings.set(committed.id, committed);
        detached.push(committed.id);
      }
    }
    return detached;
  }

  /**
   * Registers a fallback House Trader (persisted in `world_state`) when `ctx.services.homes` is not installed.
   */
  async function registerHouseTrader(spec) {
    const trader = {
      traderId: String(spec.traderId || `trader:${spec.houseId}`),
      houseId: String(spec.houseId),
      ownerCharacterId: Number(spec.ownerCharacterId),
      ownerAccountId: spec.ownerAccountId != null ? String(spec.ownerAccountId) : null,
      location: String(spec.location || ''),
      region: String(spec.region || 'Daggerfall'),
      town: String(spec.town || 'Daggerfall'),
      label: String(spec.label || 'House Trader'),
      access: spec.access || 'public', // 'public' | 'guests' | 'private'
      guests: Array.isArray(spec.guests) ? spec.guests.map(Number) : [],
      revoked: Boolean(spec.revoked),
    };
    await mstore.runDurable(
      null,
      { resourceKey: `${TRADERS_PREFIX}${trader.traderId}` },
      async (tx) => {
        await tx.putWorld(`${TRADERS_PREFIX}${trader.traderId}`, trader);
        return trader;
      },
    );
    mstore.traders.set(trader.traderId, trader);
    return trader;
  }

  /**
   * Browses a specific House Trader's stock (checking `verifyHouseTraderAccess`).
   */
  async function browseHouseTrader(viewer, args = {}) {
    const access = await verifyHouseTraderAccess(
      ctx,
      viewer,
      { houseId: args.houseId, traderId: args.traderId, mode: 'browse' },
      mstore.traders,
    );
    const page = browseListings({
      ...args,
      traderId: access.traderId,
      houseId: access.houseId,
    });
    return {
      trader: access,
      ...page,
    };
  }

  /**
   * Paginated browse / search / filter / sort over active fixed-price listings (and house trader listings).
   * Stable sort with unique `id` tie-breaker.
   */
  function browseListings(query = {}) {
    const now = mstore.wallNow();
    const search = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
    const group = typeof query.group === 'string' && query.group.trim() && query.group !== 'all' ? query.group.trim().toLowerCase() : null;
    const region = typeof query.region === 'string' && query.region.trim() && query.region !== 'all' ? query.region.trim().toLowerCase() : null;
    const quality = typeof query.quality === 'string' && query.quality.trim() && query.quality !== 'all' ? query.quality.trim().toLowerCase() : null;
    const minPrice = query.minPrice != null && query.minPrice !== '' ? int(query.minPrice, 0) : null;
    const maxPrice = query.maxPrice != null && query.maxPrice !== '' ? int(query.maxPrice, 0) : null;
    const sellerCharId = query.sellerCharacterId != null ? Number(query.sellerCharacterId) : null;
    const traderId = typeof query.traderId === 'string' && query.traderId.trim() ? query.traderId.trim() : null;
    const houseId = typeof query.houseId === 'string' && query.houseId.trim() ? query.houseId.trim() : null;
    const source = query.source === 'board' || query.source === 'trader' ? query.source : 'all';
    const sort = typeof query.sort === 'string' ? query.sort : 'price_asc';
    const pageSize = clampInt(query.limit ?? query.pageSize, 1, cfg.pageSizeMax, cfg.pageSizeDefault);
    const pageNum = Math.max(1, int(query.page, 1));

    const matched = [];
    for (const l of mstore.listings.values()) {
      if (l.status !== 'active' || l.remainingQuantity <= 0 || l.expiresAt <= now) continue;
      if (sellerCharId != null && Number(l.sellerCharacterId) !== sellerCharId) continue;
      if (traderId && l.houseTrader?.traderId !== traderId) continue;
      if (houseId && l.houseTrader?.houseId !== houseId) continue;
      if (source === 'board' && l.houseTrader) continue;
      if (source === 'trader' && !l.houseTrader) continue;
      if (group && String(l.itemSummary?.group ?? '').toLowerCase() !== group) continue;
      if (region && String(l.region ?? '').toLowerCase() !== region) continue;
      if (quality && String(l.itemSummary?.quality ?? '').toLowerCase() !== quality) continue;
      if (minPrice !== null && l.unitPrice < minPrice) continue;
      if (maxPrice !== null && l.unitPrice > maxPrice) continue;
      if (search) {
        const hay = [
          l.itemSummary?.name,
          l.itemSummary?.template,
          l.itemSummary?.group,
          l.itemSummary?.material,
          l.itemSummary?.crafted?.maker,
          l.sellerName,
          l.region,
          l.town,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(search)) continue;
      }
      matched.push(l);
    }

    matched.sort((a, b) => {
      let cmp = 0;
      switch (sort) {
        case 'price_desc':
          cmp = b.unitPrice - a.unitPrice;
          break;
        case 'newest':
          cmp = b.createdAt - a.createdAt;
          break;
        case 'ending_soon':
          cmp = a.expiresAt - b.expiresAt;
          break;
        case 'name_asc':
          cmp = String(a.itemSummary?.name ?? '').localeCompare(String(b.itemSummary?.name ?? ''));
          break;
        case 'qty_desc':
          cmp = b.remainingQuantity - a.remainingQuantity;
          break;
        case 'price_asc':
        default:
          cmp = a.unitPrice - b.unitPrice;
          break;
      }
      return cmp || a.id.localeCompare(b.id);
    });

    const total = matched.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(pageNum, totalPages);
    const start = (safePage - 1) * pageSize;
    const items = matched.slice(start, start + pageSize).map(projectListingPublic);

    return {
      page: safePage,
      pageSize,
      total,
      totalPages,
      hasMore: safePage < totalPages,
      sort,
      items,
    };
  }

  return {
    quoteListing,
    createListing,
    buyListing,
    cancelListing,
    expireDueListings,
    assignHouseTrader,
    detachHouseTrader,
    detachAllForHouse,
    registerHouseTrader,
    browseHouseTrader,
    browseListings,
    hasActiveHouseTraderListings: (houseId) => [...mstore.listings.values()].some(
      (l) => l.status === 'active' && l.houseTrader?.houseId === String(houseId),
    ),
  };
}
