// §6 Player Market server feature (docs/multiplayer-feature-plan.md).
//
// Exports `name = 'market'` and `install(ctx)` for Wave 2B wiring into `server/rpg/features.js`.
// Built on Wave 1's durable transaction, escrow, and claim ledger (`ctx.services.store` / `runDurable`,
// `escrow_records`, `claim_records`) and `server/rpg/inventory.js` eligibility & stack helpers.

import {
  MARKET_DEFAULTS,
  ESCROW_KINDS,
  CLAIM_KINDS,
  MarketError,
  resolveMarketConfig,
} from './market/config.js';
import { FEATURED_BOARDS, boardForLocation } from './market/boards.js';
import { createMarketStore } from './market/store.js';
import { createMarketSafety } from './market/safety.js';
import { createListingsService, projectListingPublic } from './market/listings.js';
import { createAuctionsService, projectAuctionPublic } from './market/auctions.js';
import { createBuyOrdersService, projectBuyOrderPublic } from './market/orders.js';
import { createClaimsService } from './market/claims.js';

export const name = 'market';
export {
  MARKET_DEFAULTS,
  ESCROW_KINDS,
  CLAIM_KINDS,
  MarketError,
  FEATURED_BOARDS,
  boardForLocation,
};

export function install(ctx) {
  const cfg = resolveMarketConfig(ctx);
  const services = (ctx.services ||= {});
  const mstore = createMarketStore(ctx, cfg);
  const safety = createMarketSafety(ctx, cfg, mstore);
  const listingsSvc = createListingsService(ctx, cfg, mstore, safety);
  const auctionsSvc = createAuctionsService(ctx, cfg, mstore, safety);
  const ordersSvc = createBuyOrdersService(ctx, cfg, mstore, safety);
  const claimsSvc = createClaimsService(ctx, cfg, mstore);

  // Track in-flight async action promises so callers/tests can `await ctx.services.market.flush()`.
  const pendingOps = new Set();
  function trackOp(promise) {
    pendingOps.add(promise);
    const cleanup = () => pendingOps.delete(promise);
    promise.then(cleanup, cleanup);
    return promise;
  }

  async function flush() {
    while (pendingOps.size > 0) {
      await Promise.allSettled([...pendingOps]);
    }
  }

  // Register archive blockers & character purge hooks on `ctx.services`.
  if (!Array.isArray(services.characterBlockers)) services.characterBlockers = [];
  services.characterBlockers.push(safety.checkCharacterBlockers);

  if (!Array.isArray(services.onCharacterPurge)) services.onCharacterPurge = [];
  services.onCharacterPurge.push(safety.handleCharacterPurge);

  // Bounded periodic + startup settlement of due auctions, listings, and buy orders.
  let settling = false;
  let lastSettleTick = -Infinity;

  async function settleDue(nowMs = mstore.wallNow(), opts = {}) {
    if (!mstore.hasDurableStore()) return { skipped: true, auctions: [], listings: [], orders: [] };
    if (settling) return { skipped: true, auctions: [], listings: [], orders: [] };
    settling = true;
    try {
      const settledAuctions = await auctionsSvc.settleDueAuctions(nowMs, opts);
      const expiredListings = await listingsSvc.expireDueListings(nowMs, opts);
      const expiredOrders = await ordersSvc.expireDueBuyOrders(nowMs, opts);
      return {
        skipped: false,
        auctions: settledAuctions,
        listings: expiredListings,
        orders: expiredOrders,
      };
    } finally {
      settling = false;
    }
  }

  // Run startup settlement asynchronously so any due rows from before a restart settle immediately.
  if (cfg.autoStartupSettle !== false && mstore.hasDurableStore()) {
    const startup = Promise.resolve()
      .then(() => settleDue(mstore.wallNow()))
      .catch((err) => {
        ctx?.log?.error?.('[market] startup settlement failed:', err?.message ?? err);
      });
    trackOp(startup);
  }

  // Periodic settlement on runtime tick (non-blocking, bounded batches).
  ctx.onTick?.((_dt, nowMs) => {
    if (settling || !mstore.hasDurableStore()) return;
    if (nowMs - lastSettleTick < cfg.settlementIntervalMs) return;
    lastSettleTick = nowMs;
    const job = settleDue(mstore.wallNow()).catch((err) => {
      ctx?.log?.error?.('[market] periodic settlement failed:', err?.message ?? err);
    });
    trackOp(job);
  });

  // Record account mapping on join and gently alert players with pending offline claims.
  ctx.onJoin?.((p) => {
    if (p?.accountId != null && Number.isSafeInteger(Number(p.id))) {
      mstore.charToAccount.set(Number(p.id), String(p.accountId));
    }
    if (!mstore.hasDurableStore()) return;
    const check = Promise.resolve()
      .then(() => claimsSvc.listClaims(p, { status: 'pending', limit: 20 }))
      .then((claims) => {
        if (claims.length > 0 && ctx.players?.get?.(p.id) === p) {
          ctx.notify?.(p, {
            kind: 'market.notice',
            pendingClaims: claims.length,
            text: `You have ${claims.length} unclaimed market item${claims.length === 1 ? '' : 's'} or payout${claims.length === 1 ? '' : 's'} waiting at a town market board.`,
          });
        }
      })
      .catch(() => {});
    trackOp(check);
  });

  /**
   * Builds the authenticated character's private overview (own listings, auctions, bids, buy orders, claims, caps).
   */
  async function myOverview(actor) {
    const cid = Number(actor.id);
    const accountId = await mstore.resolveAccountId(actor);
    const myListings = [...mstore.listings.values()]
      .filter((l) => Number(l.sellerCharacterId) === cid && l.status === 'active')
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .map(projectListingPublic);
    const myAuctions = [...mstore.auctions.values()]
      .filter((a) => Number(a.sellerCharacterId) === cid && a.status === 'active')
      .sort((a, b) => a.endsAt - b.endsAt || a.id.localeCompare(b.id))
      .map((a) => projectAuctionPublic(a, cfg));
    const myBids = [...mstore.auctions.values()]
      .filter((a) => Number(a.highBidderCharacterId) === cid && a.status === 'active')
      .sort((a, b) => a.endsAt - b.endsAt || a.id.localeCompare(b.id))
      .map((a) => projectAuctionPublic(a, cfg));
    const myOrders = [...mstore.orders.values()]
      .filter((o) => Number(o.buyerCharacterId) === cid && o.status === 'active')
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .map(projectBuyOrderPublic);
    const claims = await claimsSvc.listClaims(actor, { status: 'pending', limit: 100 });
    const usage = await safety.getObligationUsage(accountId, cid);
    const board = boardForLocation(actor?.rpg?.location);
    return {
      board,
      gold: Number(actor?.rpg?.gold) || 0,
      listings: myListings,
      auctions: myAuctions,
      bids: myBids,
      orders: myOrders,
      claims,
      usage,
    };
  }

  // Helper to run an async durable action cleanly after `runtime.act` finishes its synchronous commit.
  function runAsyncAction(player, actionName, args, fn) {
    const requestId = args?.requestId ?? args?.opKey ?? null;
    const exec = () => {
      const job = Promise.resolve()
        .then(() => fn())
        .then((data) => {
          ctx.notify?.(player, {
            kind: 'market.result',
            action: actionName,
            requestId,
            ok: true,
            data,
          });
        })
        .catch((err) => {
          ctx.notify?.(player, {
            kind: 'market.result',
            action: actionName,
            requestId,
            ok: false,
            code: err?.code || 'MARKET_ERROR',
            error: err?.expose || err?.constructor === Error ? err.message : 'Market action failed.',
            ...(err?.freshQuote ? { freshQuote: err.freshQuote } : {}),
            ...(err?.minNextBid != null ? { minNextBid: err.minNextBid } : {}),
          });
        });
      trackOp(job);
    };
    if (typeof ctx.afterCommit === 'function' && ctx.inAction?.()) ctx.afterCommit(exec);
    else exec();
  }

  // ---- WebSocket RPG action handlers ----------------------------------------------------------

  ctx.onAction?.('market.boards', (p) => {
    const current = boardForLocation(p?.rpg?.location);
    ctx.notify?.(p, {
      kind: 'market.boards',
      current,
      boards: FEATURED_BOARDS,
    });
  });

  ctx.onAction?.('market.browse', (p, args = {}) => {
    const page = listingsSvc.browseListings(args);
    ctx.notify?.(p, {
      kind: 'market.browse',
      board: boardForLocation(p?.rpg?.location),
      ...page,
    });
  });

  ctx.onAction?.('market.quote', (p, args = {}) => {
    const quote = listingsSvc.quoteListing(p, args);
    ctx.notify?.(p, { kind: 'market.quote', ...quote });
  });

  ctx.onAction?.('market.list', (p, args = {}) => {
    runAsyncAction(p, 'market.list', args, () => listingsSvc.createListing(p, args));
  });

  ctx.onAction?.('market.buy', (p, args = {}) => {
    runAsyncAction(p, 'market.buy', args, () => listingsSvc.buyListing(p, args));
  });

  ctx.onAction?.('market.cancel', (p, args = {}) => {
    runAsyncAction(p, 'market.cancel', args, () => listingsSvc.cancelListing(p, args));
  });

  ctx.onAction?.('market.auctions', (p, args = {}) => {
    const page = auctionsSvc.browseAuctions(args);
    ctx.notify?.(p, {
      kind: 'market.auctions',
      board: boardForLocation(p?.rpg?.location),
      ...page,
    });
  });

  ctx.onAction?.('market.auction.create', (p, args = {}) => {
    runAsyncAction(p, 'market.auction.create', args, () => auctionsSvc.createAuction(p, args));
  });

  ctx.onAction?.('market.auction.bid', (p, args = {}) => {
    runAsyncAction(p, 'market.auction.bid', args, () => auctionsSvc.placeBid(p, args));
  });

  ctx.onAction?.('market.auction.buyout', (p, args = {}) => {
    runAsyncAction(p, 'market.auction.buyout', args, () => auctionsSvc.buyoutAuction(p, args));
  });

  ctx.onAction?.('market.auction.cancel', (p, args = {}) => {
    runAsyncAction(p, 'market.auction.cancel', args, () => auctionsSvc.cancelAuction(p, args));
  });

  ctx.onAction?.('market.orders', (p, args = {}) => {
    const page = ordersSvc.browseBuyOrders(args);
    ctx.notify?.(p, {
      kind: 'market.orders',
      board: boardForLocation(p?.rpg?.location),
      ...page,
    });
  });

  ctx.onAction?.('market.order.create', (p, args = {}) => {
    runAsyncAction(p, 'market.order.create', args, () => ordersSvc.createBuyOrder(p, args));
  });

  ctx.onAction?.('market.order.fill', (p, args = {}) => {
    runAsyncAction(p, 'market.order.fill', args, () => ordersSvc.fillBuyOrder(p, args));
  });

  ctx.onAction?.('market.order.cancel', (p, args = {}) => {
    runAsyncAction(p, 'market.order.cancel', args, () => ordersSvc.cancelBuyOrder(p, args));
  });

  ctx.onAction?.('market.claims', (p, args = {}) => {
    runAsyncAction(p, 'market.claims', args, async () => {
      const claims = await claimsSvc.listClaims(p, args);
      ctx.notify?.(p, { kind: 'market.claims', claims });
      return { claims };
    });
  });

  ctx.onAction?.('market.claim', (p, args = {}) => {
    runAsyncAction(p, 'market.claim', args, () => claimsSvc.claimOne(p, args));
  });

  ctx.onAction?.('market.claimAll', (p, args = {}) => {
    runAsyncAction(p, 'market.claimAll', args, () => claimsSvc.claimAll(p, args));
  });

  ctx.onAction?.('market.my', (p, args = {}) => {
    runAsyncAction(p, 'market.my', args, async () => {
      const data = await myOverview(p);
      ctx.notify?.(p, { kind: 'market.my', ...data });
      return data;
    });
  });

  ctx.onAction?.('market.trader.browse', (p, args = {}) => {
    runAsyncAction(p, 'market.trader.browse', args, async () => {
      const data = await listingsSvc.browseHouseTrader(p, args);
      ctx.notify?.(p, { kind: 'market.trader', ...data });
      return data;
    });
  });

  ctx.onAction?.('market.trader.assign', (p, args = {}) => {
    runAsyncAction(p, 'market.trader.assign', args, () => listingsSvc.assignHouseTrader(p, args));
  });

  ctx.onAction?.('market.trader.detach', (p, args = {}) => {
    runAsyncAction(p, 'market.trader.detach', args, () => listingsSvc.detachHouseTrader(p, args));
  });

  ctx.onAction?.('market.trader.buy', (p, args = {}) => {
    runAsyncAction(p, 'market.trader.buy', args, () => listingsSvc.buyListing(p, args));
  });

  // ---- Exported `ctx.services.market` API -----------------------------------------------------

  const marketApi = {
    config: cfg,
    boards: FEATURED_BOARDS,
    boardForLocation,
    // Fixed-price listings
    quoteListing: listingsSvc.quoteListing,
    createListing: listingsSvc.createListing,
    buyListing: listingsSvc.buyListing,
    cancelListing: listingsSvc.cancelListing,
    browseListings: listingsSvc.browseListings,
    expireDueListings: listingsSvc.expireDueListings,
    // House traders
    registerHouseTrader: listingsSvc.registerHouseTrader,
    assignHouseTrader: listingsSvc.assignHouseTrader,
    detachHouseTrader: listingsSvc.detachHouseTrader,
    detachAllForHouse: listingsSvc.detachAllForHouse,
    browseHouseTrader: listingsSvc.browseHouseTrader,
    hasActiveHouseTraderListings: listingsSvc.hasActiveHouseTraderListings,
    // Timed auctions
    createAuction: auctionsSvc.createAuction,
    placeBid: auctionsSvc.placeBid,
    buyoutAuction: auctionsSvc.buyoutAuction,
    cancelAuction: auctionsSvc.cancelAuction,
    browseAuctions: auctionsSvc.browseAuctions,
    settleDueAuctions: auctionsSvc.settleDueAuctions,
    // Funded buy orders
    createBuyOrder: ordersSvc.createBuyOrder,
    fillBuyOrder: ordersSvc.fillBuyOrder,
    cancelBuyOrder: ordersSvc.cancelBuyOrder,
    browseBuyOrders: ordersSvc.browseBuyOrders,
    expireDueBuyOrders: ordersSvc.expireDueBuyOrders,
    // Offline claims
    listClaims: claimsSvc.listClaims,
    claimOne: claimsSvc.claimOne,
    claimAll: claimsSvc.claimAll,
    // Overview, settlement, safety & reconciliation
    myOverview,
    settleDue,
    reconcile: safety.reconcile,
    getLedger: mstore.getLedger,
    getAuditAlerts: safety.getAuditAlerts,
    getObligationUsage: safety.getObligationUsage,
    checkCharacterBlockers: safety.checkCharacterBlockers,
    handleCharacterPurge: safety.handleCharacterPurge,
    hydrateAsync: mstore.hydrateAsync,
    flush,
  };

  services.market = marketApi;
  return marketApi;
}

export default { name, install };
