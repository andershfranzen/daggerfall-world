import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, DurableConflictError } from '../server/db.js';
import { createBufferedGameStore } from '../server/storage/postgres-game.js';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import {
  install as installInventory,
  addItem,
  equip,
  itemFingerprint,
  MAX_ITEMS,
} from '../server/rpg/inventory.js';
import { install as installMarket, MarketError, ESCROW_KINDS, CLAIM_KINDS } from '../server/rpg/market.js';

function createHarness(opts = {}) {
  let clock = opts.startTime ?? 1_700_000_000_000;
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'dfw-market-test-'));
  const dbPath = opts.dbPath ?? join(dir, 'market.db');
  const store = openStore(dbPath, { now: () => clock });
  const players = new Map();
  const events = [];

  const runtime = createRpgRuntime({
    players,
    features: [installInventory, installMarket],
    save: (list, world = []) => store.saveCharacters(list, world),
    worldStore: { load: (prefix) => store.loadWorld(prefix) },
    send: (p, msg) => events.push({ playerId: p.id, msg }),
    config: {
      market: {
        wallNow: () => clock,
        autoStartupSettle: opts.autoStartupSettle ?? false,
        ...(opts.marketConfig ?? {}),
      },
    },
    services: {
      store,
      runDurable: (...args) => store.runDurable(...args),
      ...(opts.extraServices ?? {}),
    },
  });

  function spawnAccountCharacter(accountId, username, charName, { slot = null, gold = 500, location = 'town:Daggerfall/Gothway Garden', x = 0, z = 0 } = {}) {
    const row = store.createCharacterSlot(accountId, username, {
      slot,
      name: charName,
      draft: false,
      grandfathered: false,
    });
    const p = {
      id: row.id,
      name: row.name,
      accountId: String(accountId),
      x,
      z,
      yaw: 0,
      rpg: {
        location,
        gold,
        inventory: [],
        equipment: {},
        inventoryVersion: 2,
        character: { name: charName, created: true, level: 5, stats: { strength: 60 } },
      },
    };
    players.set(p.id, p);
    runtime.join(p);
    p.rpg.gold = gold;
    store.saveCharacters([p]);
    return p;
  }

  return {
    dir,
    dbPath,
    store,
    players,
    runtime,
    events,
    market: runtime.ctx.services.market,
    get now() { return clock; },
    setNow(ts) { clock = ts; },
    advance(ms) { clock += ms; return clock; },
    spawnAccountCharacter,
    close({ keepFiles = false } = {}) {
      store.close();
      if (!keepFiles) rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('§6 Player Market', () => {
  test('fixed-price listing: partial-stack buy while seller offline, fees/taxes, fingerprint/metadata preservation, and idempotency', async () => {
    const h = createHarness();
    try {
      const seller = h.spawnAccountCharacter('acct-1', 'alice', 'Alice', { gold: 200 });
      const buyer = h.spawnAccountCharacter('acct-2', 'bob', 'Bob', { gold: 1000 });

      const arrows = addItem(seller.rpg, 'arrow', 20, {
        extra: { crafted: { maker: 'Alice', quality: 'fine', profession: 'smithing' } },
      });
      const origFp = itemFingerprint(arrows);
      h.store.saveCharacters([seller]);

      const initialGold = seller.rpg.gold + buyer.rpg.gold;
      const initialItems = 20;

      // Quote preview
      const quote = h.market.quoteListing(seller, { itemId: arrows.id, quantity: 20, unitPrice: 10 });
      assert.equal(quote.grossTotal, 200);
      assert.equal(quote.listingFee, 4); // 2%
      assert.equal(quote.estSaleTax, 10); // 5%

      // Create listing with idempotency key
      const created = await h.market.createListing(seller, {
        itemId: arrows.id,
        quantity: 20,
        unitPrice: 10,
        opKey: 'list-arrows-1',
      });
      assert.equal(created.ok, true);
      assert.equal(created.replayed, false);
      assert.equal(created.listing.remainingQuantity, 20);
      assert.equal(created.listingFee, 4);
      assert.equal(seller.rpg.gold, 196);
      assert.equal(seller.rpg.inventory.length, 0);

      // Idempotency replay returns same result without charging twice
      const replay = await h.market.createListing(seller, {
        itemId: arrows.id,
        quantity: 20,
        unitPrice: 10,
        opKey: 'list-arrows-1',
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.listing.id, created.listing.id);
      assert.equal(seller.rpg.gold, 196);

      // Reused opKey with different params fails with DurableConflictError
      await assert.rejects(
        () => h.market.createListing(seller, { itemId: arrows.id, quantity: 10, unitPrice: 10, opKey: 'list-arrows-1' }),
        (err) => err instanceof DurableConflictError && err.code === 'DURABLE_KEY_CONFLICT',
      );

      // Seller goes offline before purchase
      h.players.delete(seller.id);

      // Buyer buys partial stack (7 of 20)
      const bought = await h.market.buyListing(buyer, {
        listingId: created.listing.id,
        quantity: 7,
        expectedRev: 1,
        expectedUnitPrice: 10,
        opKey: 'buy-arrows-1',
      });
      assert.equal(bought.ok, true);
      assert.equal(bought.purchasedQuantity, 7);
      assert.equal(bought.gross, 70);
      assert.equal(bought.saleTax, 3); // floor(70 * 0.05) = 3
      assert.equal(bought.sellerProceeds, 67);
      assert.equal(bought.listing.remainingQuantity, 13);
      assert.equal(bought.listing.revision, 2);
      assert.equal(buyer.rpg.gold, 930);

      // Buyer collects item claim and verifies exact crafted metadata & fingerprint
      const buyerClaims = await h.market.listClaims(buyer);
      assert.equal(buyerClaims.length, 1);
      assert.equal(buyerClaims[0].kind, CLAIM_KINDS.PURCHASE_ITEM);
      assert.equal(buyerClaims[0].item.quantity, 7);
      assert.equal(itemFingerprint(buyerClaims[0].item), origFp);
      assert.deepEqual(buyerClaims[0].item.crafted, { maker: 'Alice', quality: 'fine', profession: 'smithing' });

      const claimRes = await h.market.claimOne(buyer, { claimId: buyerClaims[0].id });
      assert.equal(claimRes.ok, true);
      assert.equal(buyer.rpg.inventory.length, 1);
      assert.equal(buyer.rpg.inventory[0].quantity, 7);
      assert.equal(itemFingerprint(buyer.rpg.inventory[0]), origFp);

      // Seller comes back online and collects proceeds claim
      h.players.set(seller.id, seller);
      const sellerClaims = await h.market.listClaims(seller);
      assert.equal(sellerClaims.length, 1);
      assert.equal(sellerClaims[0].kind, CLAIM_KINDS.SALE_PROCEEDS);
      assert.equal(sellerClaims[0].gold, 67);
      await h.market.claimOne(seller, { claimId: sellerClaims[0].id });
      assert.equal(seller.rpg.gold, 263);

      // Conservation check
      const rec = await h.market.reconcile({ players: [seller, buyer] });
      assert.equal(rec.ok, true, JSON.stringify(rec.issues));
      assert.equal(rec.totals.totalConservedGold, initialGold);
      assert.equal(rec.totals.totalConservedItemsQty, initialItems);
    } finally {
      h.close();
    }
  });

  test('stale-revision & stale-price quote protection, proximity checks, eligibility enforcement, and pagination/filter/sort', async () => {
    const h = createHarness();
    try {
      const seller = h.spawnAccountCharacter('acct-1', 'alice', 'Alice', { gold: 500 });
      const buyer = h.spawnAccountCharacter('acct-2', 'bob', 'Bob', { gold: 500 });

      // Eligibility rejections: equipped, quest, bound, stolen, conjured, corrupted
      const sword = addItem(seller.rpg, 'steel-longsword', 1);
      equip(seller.rpg, sword.id, 'rightHand');
      await assert.rejects(
        () => h.market.createListing(seller, { itemId: sword.id, quantity: 1, unitPrice: 50 }),
        (err) => err.code === 'EQUIPPED_ITEM',
      );
      const questIt = addItem(seller.rpg, 'ruby', 1, { extra: { quest: { uid: 'q1' } } });
      await assert.rejects(
        () => h.market.createListing(seller, { itemId: questIt.id, quantity: 1, unitPrice: 50 }),
        (err) => err.code === 'QUEST_ITEM',
      );
      const boundIt = addItem(seller.rpg, 'ruby', 1, { extra: { bound: { scope: 'character' } } });
      await assert.rejects(
        () => h.market.createListing(seller, { itemId: boundIt.id, quantity: 1, unitPrice: 50 }),
        (err) => err.code === 'BOUND_ITEM',
      );
      const stolenIt = addItem(seller.rpg, 'emerald', 1, { extra: { stolen: { from: 'shop', at: 1 } } });
      await assert.rejects(
        () => h.market.createListing(seller, { itemId: stolenIt.id, quantity: 1, unitPrice: 50 }),
        (err) => err.code === 'STOLEN_ITEM',
      );
      const conjuredIt = addItem(seller.rpg, 'iron-dagger', 1, { extra: { conjuredUntil: 99999 } });
      await assert.rejects(
        () => h.market.createListing(seller, { itemId: conjuredIt.id, quantity: 1, unitPrice: 50 }),
        (err) => err.code === 'CONJURED_ITEM',
      );
      seller.rpg.inventory.push({ id: 'corrupt-1', template: 'nonexistent-corrupt-item', name: 'Glitch', quantity: 1 });
      await assert.rejects(
        () => h.market.createListing(seller, { itemId: 'corrupt-1', quantity: 1, unitPrice: 50 }),
        (err) => err.code === 'CORRUPTED_ITEM',
      );
      // Clean corrupt entry before valid listings
      seller.rpg.inventory = seller.rpg.inventory.filter((i) => i.id !== 'corrupt-1');

      // Proximity check: outside town or too far from board
      const gem = addItem(seller.rpg, 'ruby', 5);
      seller.rpg.location = 'dungeon:Daggerfall/Privateers Hold';
      await assert.rejects(
        () => h.market.createListing(seller, { itemId: gem.id, quantity: 5, unitPrice: 40 }),
        (err) => err.code === 'BOARD_UNAVAILABLE',
      );
      seller.rpg.location = 'town:Daggerfall/Gothway Garden';
      seller.x = 50;
      await assert.rejects(
        () => h.market.createListing(seller, { itemId: gem.id, quantity: 5, unitPrice: 40 }),
        (err) => err.code === 'BOARD_OUT_OF_RANGE',
      );
      seller.x = 0;

      // Create 3 listings for search/filter/sort/pagination
      const pots = addItem(seller.rpg, 'potion-of-healing', 10);
      const axe = addItem(seller.rpg, 'ebony-battle-axe', 1);
      h.store.saveCharacters([seller]);

      const l1 = await h.market.createListing(seller, { itemId: gem.id, quantity: 5, unitPrice: 40 });
      const l2 = await h.market.createListing(seller, { itemId: pots.id, quantity: 10, unitPrice: 15 });
      const l3 = await h.market.createListing(seller, { itemId: axe.id, quantity: 1, unitPrice: 300 });

      // Stale price lock rejection
      await assert.rejects(
        () => h.market.buyListing(buyer, { listingId: l1.listing.id, quantity: 1, expectedRev: 1, expectedUnitPrice: 35 }),
        (err) => err.code === 'STALE_PRICE' && err.freshQuote?.unitPrice === 40,
      );

      // Buy 1 to bump revision to 2, then attempt stale expectedRev: 1
      await h.market.buyListing(buyer, { listingId: l1.listing.id, quantity: 1, expectedRev: 1, expectedUnitPrice: 40 });
      await assert.rejects(
        () => h.market.buyListing(buyer, { listingId: l1.listing.id, quantity: 1, expectedRev: 1, expectedUnitPrice: 40 }),
        (err) => err.code === 'STALE_QUOTE' && err.freshQuote?.revision === 2 && err.freshQuote?.remainingQuantity === 4,
      );

      // Browse, filter, sort, paginate
      const page1 = h.market.browseListings({ sort: 'price_asc', page: 1, pageSize: 2 });
      assert.equal(page1.total, 3);
      assert.equal(page1.totalPages, 2);
      assert.equal(page1.hasMore, true);
      assert.deepEqual(page1.items.map((x) => x.unitPrice), [15, 40]);

      const page2 = h.market.browseListings({ sort: 'price_asc', page: 2, pageSize: 2 });
      assert.equal(page2.items.length, 1);
      assert.equal(page2.items[0].id, l3.listing.id);

      const masterworkOnly = h.market.browseListings({ quality: 'masterwork', q: 'ebony' });
      assert.equal(masterworkOnly.total, 1);
      assert.equal(masterworkOnly.items[0].id, l3.listing.id);

      // Cancel remaining l1 -> creates single return claim for 4 rubies
      const cancelled = await h.market.cancelListing(seller, { listingId: l1.listing.id });
      assert.equal(cancelled.listing.status, 'cancelled');
      const sClaims = await h.market.listClaims(seller);
      const retClaim = sClaims.find((c) => c.kind === CLAIM_KINDS.LISTING_CANCELLED);
      assert.ok(retClaim);
      assert.equal(retClaim.item.quantity, 4);

      // Second cancel fails cleanly (no duplicate claim)
      await assert.rejects(
        () => h.market.cancelListing(seller, { listingId: l1.listing.id }),
        (err) => err.code === 'LISTING_NOT_ACTIVE',
      );
    } finally {
      h.close();
    }
  });

  test('timed auctions: outbid refund claims, anti-snipe extension, reserve-not-met, buyout, and restart settlement', async () => {
    const h = createHarness({
      marketConfig: {
        minAuctionDurationMs: 60_000,
        antiSnipeWindowMs: 120_000,
        antiSnipeExtensionMs: 120_000,
      },
    });
    const dir = h.dir;
    const dbPath = h.dbPath;
    try {
      const seller = h.spawnAccountCharacter('acct-1', 'alice', 'Alice', { gold: 300 });
      const b1 = h.spawnAccountCharacter('acct-2', 'bob', 'Bob', { gold: 1000 });
      const b2 = h.spawnAccountCharacter('acct-3', 'cara', 'Cara', { gold: 1000 });

      // Multi-unit stack rejected for auctions
      const stack = addItem(seller.rpg, 'arrow', 10);
      await assert.rejects(
        () => h.market.createAuction(seller, { itemId: stack.id, startPrice: 20 }),
        (err) => err.code === 'AUCTION_SINGLE_ITEM_ONLY',
      );

      // 1. Auction with anti-snipe + outbid refund + restart settlement
      const katana = addItem(seller.rpg, 'daedric-katana', 1);
      h.store.saveCharacters([seller]);
      const a1 = await h.market.createAuction(seller, {
        itemId: katana.id,
        startPrice: 100,
        reservePrice: 150,
        minIncrement: 25,
        durationMs: 300_000, // 5 min
      });
      assert.equal(a1.ok, true);
      const origEndsAt = a1.auction.endsAt;

      // Bid 1 below start fails
      await assert.rejects(
        () => h.market.placeBid(b1, { auctionId: a1.auction.id, amount: 90 }),
        (err) => err.code === 'BID_TOO_LOW',
      );

      // Bob bids 120 (not in anti-snipe window yet)
      const bid1 = await h.market.placeBid(b1, { auctionId: a1.auction.id, amount: 120 });
      assert.equal(bid1.extended, false);
      assert.equal(b1.rpg.gold, 880);

      // Advance into last 60s (inside 120s anti-snipe window)
      h.advance(240_000);
      // Cara bids 160 (meets reserve 150, outbids Bob, triggers anti-snipe extension!)
      const bid2 = await h.market.placeBid(b2, { auctionId: a1.auction.id, amount: 160 });
      assert.equal(bid2.extended, true);
      assert.ok(bid2.endsAt > origEndsAt, 'anti-snipe must extend endsAt');
      assert.equal(b2.rpg.gold, 840);

      // Bob immediately receives outbid refund claim of 120g
      const bobClaims = await h.market.listClaims(b1);
      assert.equal(bobClaims.length, 1);
      assert.equal(bobClaims[0].kind, CLAIM_KINDS.AUCTION_OUTBID);
      assert.equal(bobClaims[0].gold, 120);

      // 2. Auction with buyout (instant settlement + refunds prior high bidder)
      const helm = addItem(seller.rpg, 'ebony-helm', 1);
      h.store.saveCharacters([seller]);
      const a2 = await h.market.createAuction(seller, {
        itemId: helm.id,
        startPrice: 50,
        buyoutPrice: 200,
        durationMs: 300_000,
      });
      await h.market.placeBid(b1, { auctionId: a2.auction.id, amount: 60 });
      const bo = await h.market.buyoutAuction(b2, { auctionId: a2.auction.id });
      assert.equal(bo.boughtOut, true);
      assert.equal(bo.gross, 200);
      assert.equal(bo.saleTax, 10);
      assert.equal(bo.sellerProceeds, 190);

      // 3. Auction with unmet reserve
      const dagger = addItem(seller.rpg, 'silver-dagger', 1);
      h.store.saveCharacters([seller]);
      const a3 = await h.market.createAuction(seller, {
        itemId: dagger.id,
        startPrice: 50,
        reservePrice: 200,
        durationMs: 60_000,
      });
      await h.market.placeBid(b1, { auctionId: a3.auction.id, amount: 75 });

      // Simulate server restart AFTER both a1 (extended) and a3 are past their deadlines!
      const afterEndTs = bid2.endsAt + 10_000;
      h.close({ keepFiles: true });

      const h2 = createHarness({
        dir,
        dbPath,
        startTime: afterEndTs,
        autoStartupSettle: true,
        marketConfig: {
          minAuctionDurationMs: 60_000,
          antiSnipeWindowMs: 120_000,
          antiSnipeExtensionMs: 120_000,
        },
      });
      try {
        await h2.market.flush();

        // Late bid after deadline on settled auction must fail
        await assert.rejects(
          () => h2.market.placeBid(b1, { auctionId: a1.auction.id, amount: 250 }),
          (err) => err.code === 'AUCTION_ENDED',
        );

        // Cara won a1 (katana) + bought out a2 (helm)
        const caraClaims = await h2.market.listClaims(b2);
        assert.ok(caraClaims.some((c) => c.kind === CLAIM_KINDS.AUCTION_WON && c.sourceRef === a1.auction.id && c.item?.template === 'daedric-katana'));
        assert.ok(caraClaims.some((c) => c.kind === CLAIM_KINDS.AUCTION_WON && c.sourceRef === a2.auction.id && c.item?.template === 'ebony-helm'));

        // Alice got proceeds for a1 (160 - 8 = 152) and a2 (190), plus unsold dagger return for a3
        const aliceClaims = await h2.market.listClaims(seller);
        assert.ok(aliceClaims.some((c) => c.kind === CLAIM_KINDS.AUCTION_PROCEEDS && c.sourceRef === a1.auction.id && c.gold === 152));
        assert.ok(aliceClaims.some((c) => c.kind === CLAIM_KINDS.AUCTION_PROCEEDS && c.sourceRef === a2.auction.id && c.gold === 190));
        assert.ok(aliceClaims.some((c) => c.kind === CLAIM_KINDS.AUCTION_UNSOLD && c.sourceRef === a3.auction.id && c.item?.template === 'silver-dagger'));

        // Bob got outbid refunds (120 + 60) AND reserve-not-met refund (75)
        const bobClaims2 = await h2.market.listClaims(b1);
        assert.ok(bobClaims2.some((c) => c.kind === CLAIM_KINDS.AUCTION_RESERVE_REFUND && c.sourceRef === a3.auction.id && c.gold === 75));

        const rec = await h2.market.reconcile();
        assert.equal(rec.ok, true, JSON.stringify(rec.issues));
        assert.equal(rec.totals.heldEscrowCount, 0);
      } finally {
        h2.close();
      }
    } finally {
      // h2.close() removes dir; ignore if already cleaned
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  test('funded buy orders: partial fulfillment, item validation, claim delivery, and cancel refund', async () => {
    const h = createHarness();
    try {
      const buyer = h.spawnAccountCharacter('acct-1', 'alice', 'Alice', { gold: 1000 });
      const seller = h.spawnAccountCharacter('acct-2', 'bob', 'Bob', { gold: 100 });

      const potions = addItem(seller.rpg, 'potion-of-healing', 6);
      const wrongItem = addItem(seller.rpg, 'ruby', 2);
      h.store.saveCharacters([seller]);
      const initialGold = buyer.rpg.gold + seller.rpg.gold;

      // Buyer escrows 10 × 25g = 250g for Potion of Healing
      const orderRes = await h.market.createBuyOrder(buyer, {
        template: 'potion-of-healing',
        quantity: 10,
        unitPrice: 25,
      });
      assert.equal(orderRes.escrowedGold, 250);
      assert.equal(buyer.rpg.gold, 750);

      // Wrong template rejected
      await assert.rejects(
        () => h.market.fillBuyOrder(seller, { orderId: orderRes.order.id, itemId: wrongItem.id, quantity: 1 }),
        (err) => err.code === 'ITEM_MISMATCH',
      );

      // Partial fill: seller delivers 4 of 10
      const fill = await h.market.fillBuyOrder(seller, {
        orderId: orderRes.order.id,
        itemId: potions.id,
        quantity: 4,
        expectedRev: 1,
      });
      assert.equal(fill.filledQuantity, 4);
      assert.equal(fill.gross, 100);
      assert.equal(fill.saleTax, 5);
      assert.equal(fill.sellerProceeds, 95);
      assert.equal(fill.order.remainingQuantity, 6);
      assert.equal(fill.order.remainingEscrowGold, 150);

      // Buyer receives 4 potions claim, seller receives 95g claim
      const bClaims = await h.market.listClaims(buyer);
      assert.equal(bClaims.length, 1);
      assert.equal(bClaims[0].kind, CLAIM_KINDS.BUY_ORDER_ITEM);
      assert.equal(bClaims[0].item.quantity, 4);

      const sClaims = await h.market.listClaims(seller);
      assert.equal(sClaims.length, 1);
      assert.equal(sClaims[0].kind, CLAIM_KINDS.BUY_ORDER_PROCEEDS);
      assert.equal(sClaims[0].gold, 95);

      // Buyer cancels remaining 6 -> receives 150g refund claim
      const cancel = await h.market.cancelBuyOrder(buyer, { orderId: orderRes.order.id });
      assert.equal(cancel.refundedGold, 150);
      await h.market.claimAll(buyer);
      await h.market.claimAll(seller);

      assert.equal(buyer.rpg.gold, 900); // 1000 - 100 spent
      assert.equal(seller.rpg.gold, 195); // 100 + 95 proceeds
      const rec = await h.market.reconcile({ players: [buyer, seller] });
      assert.equal(rec.ok, true, JSON.stringify(rec.issues));
      assert.equal(rec.totals.totalConservedGold, initialGold); // 900 + 195 + 5 tax = 1100
    } finally {
      h.close();
    }
  });

  test('house traders: homes.verifyTraderAccess integration, fallback adapter, shared escrow without duplication, and house-sale detach', async () => {
    let allowVisitor = true;
    const h = createHarness({
      extraServices: {
        homes: {
          verifyTraderAccess(actor, { houseId, traderId, mode }) {
            if (mode === 'manage') {
              return actor.id === 1
                ? { ok: true, houseId: houseId || 'house-df-1', traderId: traderId || 'trader-1', ownerCharacterId: 1, town: 'Daggerfall', region: 'Daggerfall', label: 'Alice Manor Trader' }
                : { ok: false, code: 'TRADER_NOT_OWNER', reason: 'Only owner may manage' };
            }
            if (!allowVisitor && actor.id !== 1) {
              return { ok: false, code: 'TRADER_ACCESS_DENIED', reason: 'Home is private' };
            }
            return { ok: true, houseId: houseId || 'house-df-1', traderId: traderId || 'trader-1', ownerCharacterId: 1, town: 'Daggerfall', region: 'Daggerfall', label: 'Alice Manor Trader' };
          },
        },
      },
    });
    try {
      const owner = h.spawnAccountCharacter('acct-1', 'alice', 'Alice', { gold: 200 });
      const visitor = h.spawnAccountCharacter('acct-2', 'bob', 'Bob', { gold: 500 });
      const gem = addItem(owner.rpg, 'diamond', 3);
      h.store.saveCharacters([owner]);

      // Owner lists directly at house trader
      const listed = await h.market.createListing(owner, {
        itemId: gem.id,
        quantity: 3,
        unitPrice: 100,
        houseId: 'house-df-1',
        traderId: 'trader-1',
      });
      assert.equal(listed.listing.houseTrader.traderId, 'trader-1');

      // Appears BOTH at house trader AND on public market boards, backed by ONE escrow row!
      const traderView = await h.market.browseHouseTrader(visitor, { houseId: 'house-df-1', traderId: 'trader-1' });
      assert.equal(traderView.items.length, 1);
      const boardView = h.market.browseListings({ q: 'diamond' });
      assert.equal(boardView.items.length, 1);
      assert.equal(boardView.items[0].id, traderView.items[0].id);

      const heldEscrows = h.store.listEscrow({ status: 'held' });
      assert.equal(heldEscrows.length, 1);

      // Private house blocks visitor browse/buy
      allowVisitor = false;
      await assert.rejects(
        () => h.market.browseHouseTrader(visitor, { houseId: 'house-df-1', traderId: 'trader-1' }),
        (err) => err.code === 'TRADER_ACCESS_DENIED',
      );
      allowVisitor = true;

      // Visitor buys 1 diamond from house trader (even outside town board location!)
      visitor.rpg.location = 'interior:Daggerfall/AliceManor';
      const buyRes = await h.market.buyListing(visitor, {
        listingId: listed.listing.id,
        quantity: 1,
        expectedRev: 1,
        houseId: 'house-df-1',
        traderId: 'trader-1',
      });
      assert.equal(buyRes.listing.remainingQuantity, 2);

      // Detach before house sale preserves the 2 remaining escrowed diamonds on public board
      assert.equal(h.market.hasActiveHouseTraderListings('house-df-1'), true);
      const detached = await h.market.detachAllForHouse('house-df-1');
      assert.deepEqual(detached, [listed.listing.id]);
      assert.equal(h.market.hasActiveHouseTraderListings('house-df-1'), false);

      const afterBoard = h.market.browseListings({ q: 'diamond' });
      assert.equal(afterBoard.items.length, 1);
      assert.equal(afterBoard.items[0].remainingQuantity, 2);
      assert.equal(afterBoard.items[0].houseTrader, null);

      const rec = await h.market.reconcile();
      assert.equal(rec.ok, true, JSON.stringify(rec.issues));
    } finally {
      h.close();
    }
  });

  test('house traders fallback adapter when ctx.services.homes is not installed (guests access & assign/detach)', async () => {
    const h = createHarness();
    try {
      const owner = h.spawnAccountCharacter('acct-1', 'alice', 'Alice', { gold: 300 });
      const guest = h.spawnAccountCharacter('acct-2', 'bob', 'Bob', { gold: 500 });
      const stranger = h.spawnAccountCharacter('acct-3', 'cara', 'Cara', { gold: 500 });

      await h.market.registerHouseTrader({
        houseId: 'house-fallback-1',
        traderId: 'trader-fallback-1',
        ownerCharacterId: owner.id,
        ownerAccountId: owner.accountId,
        region: 'Wayrest',
        town: 'Wayrest',
        label: 'Wayrest Guildhall Stall',
        access: 'guests',
        guests: [guest.id],
      });

      const sapph = addItem(owner.rpg, 'sapphire', 2);
      h.store.saveCharacters([owner]);
      const lst = await h.market.createListing(owner, { itemId: sapph.id, quantity: 2, unitPrice: 90 });

      // Assign existing listing without duplicating escrow
      await h.market.assignHouseTrader(owner, { listingId: lst.listing.id, houseId: 'house-fallback-1', traderId: 'trader-fallback-1' });
      assert.equal(h.store.listEscrow({ status: 'held' }).length, 1);

      // Stranger blocked; invited guest allowed to browse & buy
      await assert.rejects(
        () => h.market.browseHouseTrader(stranger, { traderId: 'trader-fallback-1' }),
        (err) => err.code === 'TRADER_ACCESS_DENIED',
      );
      const view = await h.market.browseHouseTrader(guest, { traderId: 'trader-fallback-1' });
      assert.equal(view.items.length, 1);
      const bought = await h.market.buyListing(guest, {
        listingId: lst.listing.id,
        quantity: 1,
        expectedRev: 2,
        houseId: 'house-fallback-1',
        traderId: 'trader-fallback-1',
      });
      assert.equal(bought.listing.remainingQuantity, 1);

      // Owner detaches remaining stock cleanly
      const det = await h.market.detachHouseTrader(owner, { listingId: lst.listing.id });
      assert.equal(det.listing.houseTrader, null);
      assert.equal((await h.market.reconcile()).ok, true);
    } finally {
      h.close();
    }
  });

  test('safety: anti-self-trade across account slots, account obligation caps, archive blockers, and purge counterparty refund', async () => {
    const h = createHarness({
      marketConfig: {
        maxActiveListingsPerAccount: 2,
        maxTotalObligationsPerAccount: 3,
      },
    });
    try {
      // Account 1 has TWO character slots!
      const slot1 = h.spawnAccountCharacter('acct-1', 'alice', 'AliceOne', { slot: 1, gold: 500 });
      const slot2 = h.spawnAccountCharacter('acct-1', 'alice', 'AliceTwo', { slot: 2, gold: 500 });
      // Account 2 is an independent counterparty
      const bob = h.spawnAccountCharacter('acct-2', 'bob', 'Bob', { slot: 1, gold: 1000 });

      const r1 = addItem(slot1.rpg, 'ruby', 2);
      const r2 = addItem(slot1.rpg, 'emerald', 1);
      const r3 = addItem(slot2.rpg, 'sapphire', 1);
      const sword = addItem(slot1.rpg, 'elven-longsword', 1);
      h.store.saveCharacters([slot1, slot2]);

      const lst1 = await h.market.createListing(slot1, { itemId: r1.id, quantity: 2, unitPrice: 50 });

      // Strict anti-self-trade across slots of the same account!
      await assert.rejects(
        () => h.market.buyListing(slot2, { listingId: lst1.listing.id, quantity: 1, expectedRev: 1 }),
        (err) => err.code === 'SELF_TRADE_FORBIDDEN',
      );

      // Account-wide listing cap across slots (slot1 creates 2nd listing -> slot2 blocked at cap=2)
      await h.market.createListing(slot1, { itemId: r2.id, quantity: 1, unitPrice: 50 });
      await assert.rejects(
        () => h.market.createListing(slot2, { itemId: r3.id, quantity: 1, unitPrice: 50 }),
        (err) => err.code === 'ACCOUNT_LISTING_CAP',
      );

      // Create auction on slot1 (total obligations = 3 = cap)
      const auc = await h.market.createAuction(slot1, { itemId: sword.id, startPrice: 100 });
      // Slot2 cannot bid on Slot1's auction!
      await assert.rejects(
        () => h.market.placeBid(slot2, { auctionId: auc.auction.id, amount: 120 }),
        (err) => err.code === 'SELF_TRADE_FORBIDDEN',
      );

      // Account total obligation cap (3) blocks new buy order on slot2
      await assert.rejects(
        () => h.market.createBuyOrder(slot2, { template: 'arrow', quantity: 5, unitPrice: 2 }),
        (err) => err.code === 'ACCOUNT_OBLIGATION_CAP',
      );

      // Bob places high bid on slot1's auction
      await h.market.placeBid(bob, { auctionId: auc.auction.id, amount: 150 });
      assert.equal(bob.rpg.gold, 850);

      // Archive blockers registered on ctx.services.characterBlockers
      assert.ok(Array.isArray(h.runtime.ctx.services.characterBlockers));
      const slot1Blockers = [];
      for (const fn of h.runtime.ctx.services.characterBlockers) {
        slot1Blockers.push(...(await fn('acct-1', slot1.id, 'archive')));
      }
      assert.ok(slot1Blockers.some((b) => b.code === 'MARKET_ACTIVE_LISTINGS'));
      assert.ok(slot1Blockers.some((b) => b.code === 'MARKET_ACTIVE_AUCTIONS'));

      const bobBlockers = [];
      for (const fn of h.runtime.ctx.services.characterBlockers) {
        bobBlockers.push(...(await fn('acct-2', bob.id, 'archive')));
      }
      assert.ok(bobBlockers.some((b) => b.code === 'MARKET_ACTIVE_BIDS'));

      // Character purge cleanup on slot1 refunds counterparty Bob's 150g bid via claim_records!
      assert.ok(Array.isArray(h.runtime.ctx.services.onCharacterPurge));
      for (const hook of h.runtime.ctx.services.onCharacterPurge) {
        await hook({ characterId: slot1.id, accountId: 'acct-1' });
      }
      // Run purge hook a second time to verify idempotency (no double refund!)
      for (const hook of h.runtime.ctx.services.onCharacterPurge) {
        await hook({ characterId: slot1.id, accountId: 'acct-1' });
      }

      const bobClaims = await h.market.listClaims(bob);
      assert.equal(bobClaims.length, 1);
      assert.equal(bobClaims[0].kind, CLAIM_KINDS.ESCROW_REFUND);
      assert.equal(bobClaims[0].gold, 150);

      // Bob collects refund and now has zero archive blockers
      await h.market.claimOne(bob, { claimId: bobClaims[0].id });
      assert.equal(bob.rpg.gold, 1000);
      const bobAfter = await h.market.checkCharacterBlockers('acct-2', bob.id, 'archive');
      assert.equal(bobAfter.length, 0);
    } finally {
      h.close();
    }
  });

  test('full pack / overweight claim safety & gold+item conservation under concurrent buyers, bidders, and order cancel race', async () => {
    const h = createHarness();
    try {
      const seller = h.spawnAccountCharacter('acct-1', 'seller', 'Seller', { gold: 500 });
      const buyers = [1, 2, 3, 4, 5].map((i) =>
        h.spawnAccountCharacter(`acct-b${i}`, `buyer${i}`, `Buyer${i}`, { gold: 500 }),
      );

      // 1. Race 5 concurrent buyers each attempting to buy 3 units from a 10-unit stack (no expectedRev lock so stock contention is tested)
      const arrows = addItem(seller.rpg, 'arrow', 10);
      h.store.saveCharacters([seller]);

      const initialGold = seller.rpg.gold + buyers.reduce((s, b) => s + b.rpg.gold, 0);
      const listed = await h.market.createListing(seller, { itemId: arrows.id, quantity: 10, unitPrice: 20 });

      const buyResults = await Promise.allSettled(
        buyers.map((b, idx) =>
          h.market.buyListing(b, { listingId: listed.listing.id, quantity: 3, opKey: `race-buy-${idx}` }),
        ),
      );
      const succeeded = buyResults.filter((r) => r.status === 'fulfilled');
      const failed = buyResults.filter((r) => r.status === 'rejected');
      assert.equal(succeeded.length, 3, 'exactly 3 buyers (9 units) should succeed from 10-unit stack');
      assert.equal(failed.length, 2, 'remaining 2 buyers must fail cleanly with insufficient stock');

      // 2. Race 4 concurrent identical bids on an auction (deterministic tie handling: exactly 1 wins!)
      const shield = addItem(seller.rpg, 'steel-buckler', 1);
      h.store.saveCharacters([seller]);
      const auc = await h.market.createAuction(seller, { itemId: shield.id, startPrice: 50, minIncrement: 10 });
      const bidResults = await Promise.allSettled(
        buyers.slice(0, 4).map((b, idx) =>
          h.market.placeBid(b, { auctionId: auc.auction.id, amount: 80, opKey: `race-bid-${idx}` }),
        ),
      );
      assert.equal(bidResults.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(bidResults.filter((r) => r.status === 'rejected').length, 3);

      // 3. Race buy-order fill against cancellation (exactly one wins; zero gold/item duplication)
      const ruby = addItem(seller.rpg, 'ruby', 1);
      h.store.saveCharacters([seller]);
      const ord = await h.market.createBuyOrder(buyers[4], { template: 'ruby', quantity: 1, unitPrice: 100 });
      const raceOrd = await Promise.allSettled([
        h.market.fillBuyOrder(seller, { orderId: ord.order.id, itemId: ruby.id, quantity: 1 }),
        h.market.cancelBuyOrder(buyers[4], { orderId: ord.order.id }),
      ]);
      assert.equal(raceOrd.filter((r) => r.status === 'fulfilled').length, 1);
      assert.equal(raceOrd.filter((r) => r.status === 'rejected').length, 1);

      // 4. Full pack safety when claiming
      const fullBuyer = buyers[0];
      const buyerClaims = await h.market.listClaims(fullBuyer);
      if (buyerClaims.length > 0 && buyerClaims[0].item) {
        for (let i = fullBuyer.rpg.inventory.length; i < MAX_ITEMS; i++) {
          fullBuyer.rpg.inventory.push({ id: `pad-${i}`, template: 'iron-dagger', name: 'Iron Dagger', group: 'weapon', quantity: 1, weight: 0.01, value: 1, condition: 50, maxCondition: 50 });
        }
        h.store.saveCharacters([fullBuyer]);
        await assert.rejects(
          () => h.market.claimOne(fullBuyer, { claimId: buyerClaims[0].id }, { ignoreWeight: true }),
          (err) => err.code === 'PACK_FULL',
        );
        // Remove padding and confirm claim is still pending & succeeds now
        fullBuyer.rpg.inventory = fullBuyer.rpg.inventory.filter((it) => !it.id.startsWith('pad-'));
        h.store.saveCharacters([fullBuyer]);
        const okClaim = await h.market.claimOne(fullBuyer, { claimId: buyerClaims[0].id });
        assert.equal(okClaim.ok, true);
      }

      // 5. Full reconciliation: exact gold and item conservation across all participants, escrows, claims & fees!
      const allPlayers = [seller, ...buyers];
      const rec = await h.market.reconcile({ players: allPlayers });
      assert.equal(rec.ok, true, JSON.stringify(rec.issues));
      assert.equal(rec.totals.totalConservedGold, initialGold);
      assert.equal(rec.totals.totalConservedItemsQty, 12); // 10 arrows + 1 shield + 1 ruby
    } finally {
      h.close();
    }
  });

  test('runtime.act WebSocket action dispatch and buffered PostgreSQL-compatible store integration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dfw-market-buf-'));
    let clock = 1_700_000_000_000;
    const sqlite = openStore(join(dir, 'buf.db'), { now: () => clock });
    // Wrap sqlite with createBufferedGameStore to verify write-behind drain + fencing + worldCache mirroring!
    const pgLike = {
      backend: 'postgres',
      pool: null,
      create: (...a) => Promise.resolve(sqlite.create(...a)),
      findByToken: (...a) => Promise.resolve(sqlite.findByToken(...a)),
      findByAccount: (...a) => Promise.resolve(sqlite.findByAccount(...a)),
      listByAccount: (...a) => Promise.resolve(sqlite.listByAccount(...a)),
      findAccountCharacter: (...a) => Promise.resolve(sqlite.findAccountCharacter(...a)),
      isDisplayNameAvailable: (...a) => Promise.resolve(sqlite.isDisplayNameAvailable(...a)),
      createCharacterSlot: (...a) => Promise.resolve(sqlite.createCharacterSlot(...a)),
      createForAccount: (...a) => Promise.resolve(sqlite.createForAccount(...a)),
      claimGuest: (...a) => Promise.resolve(sqlite.claimGuest(...a)),
      setAccountUsername: (...a) => Promise.resolve(sqlite.setAccountUsername(...a)),
      selectCharacter: (...a) => Promise.resolve(sqlite.selectCharacter(...a)),
      touchCharacterPlayed: (...a) => Promise.resolve(sqlite.touchCharacterPlayed(...a)),
      markCharacterDraftComplete: (...a) => Promise.resolve(sqlite.markCharacterDraftComplete(...a)),
      renameCharacter: (...a) => Promise.resolve(sqlite.renameCharacter(...a)),
      archiveCharacter: (...a) => Promise.resolve(sqlite.archiveCharacter(...a)),
      restoreCharacter: (...a) => Promise.resolve(sqlite.restoreCharacter(...a)),
      purgeExpiredArchived: (...a) => Promise.resolve(sqlite.purgeExpiredArchived(...a)),
      deleteAllForAccount: (...a) => Promise.resolve(sqlite.deleteAllForAccount(...a)),
      deleteForAccount: (...a) => Promise.resolve(sqlite.deleteForAccount(...a)),
      getDurableOp: (...a) => Promise.resolve(sqlite.getDurableOp(...a)),
      pruneDurableOps: (...a) => Promise.resolve(sqlite.pruneDurableOps(...a)),
      listEscrow: (...a) => Promise.resolve(sqlite.listEscrow(...a)),
      listClaims: (...a) => Promise.resolve(sqlite.listClaims(...a)),
      loadWorld: (...a) => Promise.resolve(sqlite.loadWorld(...a)),
      saveCharacters: (...a) => Promise.resolve(sqlite.saveCharacters(...a)),
      close: () => Promise.resolve(sqlite.close()),
      async runDurable(opKey, scope, fn, tracker) {
        return sqlite.runDurable(opKey, scope, async (tx) => {
          const wrappedTx = {
            ...tx,
            saveCharacters(ps, w = []) {
              tx.saveCharacters(ps, w);
              if (tracker) {
                for (const p of ps ?? []) tracker.playerIds.add(Number(p.id));
                for (const [k, v] of w ?? []) tracker.world.set(k, v === undefined ? null : structuredClone(v));
              }
            },
            putWorld(k, v) {
              tx.putWorld(k, v);
              if (tracker) tracker.world.set(k, v === undefined ? null : structuredClone(v));
            },
          };
          return fn(wrappedTx);
        });
      },
    };
    const buffered = createBufferedGameStore(pgLike);
    const players = new Map();
    const events = [];
    try {
      const runtime = createRpgRuntime({
        players,
        features: [installInventory, installMarket],
        save: (list, world = []) => buffered.saveCharacters(list, world),
        worldStore: { load: (prefix) => buffered.loadWorld(prefix) },
        send: (p, msg) => events.push({ playerId: p.id, msg }),
        config: { market: { wallNow: () => clock, autoStartupSettle: false } },
        services: { store: buffered, runDurable: (...a) => buffered.runDurable(...a) },
      });

      const rA = await buffered.createCharacterSlot('acct-1', 'alice', { name: 'Alice', draft: false });
      const rB = await buffered.createCharacterSlot('acct-2', 'bob', { name: 'Bob', draft: false });
      const alice = { id: rA.id, name: 'Alice', accountId: 'acct-1', x: 0, z: 0, yaw: 0, rpg: { location: 'town:Daggerfall/Gothway Garden', gold: 300, inventory: [], equipment: {}, inventoryVersion: 2, character: { created: true, level: 3, stats: { strength: 50 } } } };
      const bob = { id: rB.id, name: 'Bob', accountId: 'acct-2', x: 0, z: 0, yaw: 0, rpg: { location: 'town:Daggerfall/Gothway Garden', gold: 300, inventory: [], equipment: {}, inventoryVersion: 2, character: { created: true, level: 3, stats: { strength: 50 } } } };
      players.set(alice.id, alice);
      players.set(bob.id, bob);
      runtime.join(alice);
      runtime.join(bob);
      const gem = addItem(alice.rpg, 'emerald', 2);
      buffered.saveCharacters([alice, bob]);
      await buffered.flush();

      // Dispatch via runtime.act
      assert.equal(runtime.act(alice, 'market.list', { itemId: gem.id, quantity: 2, unitPrice: 50, opKey: 'ws-list-1' }).ok, true);
      await runtime.ctx.services.market.flush();

      const listEv = events.find((e) => e.playerId === alice.id && e.msg?.event?.kind === 'market.result' && e.msg.event.action === 'market.list');
      assert.ok(listEv?.msg.event.ok, 'market.list event succeeded');
      const listingId = listEv.msg.event.data.listing.id;

      // Browse via runtime.act
      assert.equal(runtime.act(bob, 'market.browse', { q: 'emerald' }).ok, true);
      const browseEv = events.find((e) => e.playerId === bob.id && e.msg?.event?.kind === 'market.browse');
      assert.equal(browseEv?.msg.event.items.length, 1);

      // Buy via runtime.act
      assert.equal(runtime.act(bob, 'market.buy', { listingId, quantity: 1, expectedRev: 1, opKey: 'ws-buy-1' }).ok, true);
      await runtime.ctx.services.market.flush();

      // Claim via runtime.act
      assert.equal(runtime.act(bob, 'market.claimAll', {}).ok, true);
      await runtime.ctx.services.market.flush();
      assert.equal(bob.rpg.inventory.some((i) => i.template === 'emerald' && i.quantity === 1), true);

      // World cache mirrored the durable listing write
      const cached = buffered.loadWorld('market:listing:');
      assert.equal(cached.length, 1);
      assert.equal(cached[0][1].remainingQuantity, 1);
    } finally {
      await buffered.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
