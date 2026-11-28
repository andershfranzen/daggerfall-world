// Funded Buy Orders for §6 Player Market.
//
// Features:
//  - Gold-escrowed buy orders for permitted stackables & tradeable catalog items
//  - Partial or full fulfillment with server-verified item eligibility & template match
//  - Automatic item claim delivery to buyer and gold proceeds claim delivery to seller
//  - Unused escrowed gold returned via claim_records on cancel or expiry

import { randomBytes } from 'node:crypto';
import {
  assertItemEligible,
  describeTemplate,
  normalizeRecord,
  resolveTemplate,
  takeForTransfer,
} from '../inventory.js';
import {
  ORDER_PREFIX,
  ESCROW_KINDS,
  CLAIM_KINDS,
  MarketError,
  clampInt,
  cleanOpKey,
  computeSaleTax,
  int,
} from './config.js';
import { assertNearMarketBoard } from './boards.js';

const newOrderId = () => `ord_${randomBytes(6).toString('hex')}`;
const DISALLOWED_ORDER_GROUPS = new Set(['quest', 'transport', 'letter']);

function pairKeyOf(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}

export function projectBuyOrderPublic(order) {
  if (!order) return null;
  return {
    id: order.id,
    revision: order.revision,
    status: order.status,
    buyerCharacterId: order.buyerCharacterId,
    buyerName: order.buyerName,
    template: order.template,
    itemName: order.itemName,
    group: order.group,
    stackable: order.stackable,
    unitPrice: order.unitPrice,
    initialQuantity: order.initialQuantity,
    remainingQuantity: order.remainingQuantity,
    remainingEscrowGold: order.unitPrice * order.remainingQuantity,
    saleTaxRate: order.saleTaxRate,
    boardId: order.boardId,
    region: order.region,
    town: order.town,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    settledAt: order.settledAt,
  };
}

export function createBuyOrdersService(ctx, cfg, mstore, safety) {
  /**
   * Posts a gold-escrowed buy order for a permitted stackable or tradeable catalog template.
   */
  async function createBuyOrder(buyer, args = {}, opts = {}) {
    const rawTemplate = String(args.template ?? '').trim();
    const qty = int(args.quantity ?? 1, 0);
    const unitPrice = int(args.unitPrice, 0);
    const durationMs = clampInt(
      args.durationMs,
      cfg.minBuyOrderDurationMs,
      cfg.maxBuyOrderDurationMs,
      cfg.defaultBuyOrderDurationMs,
    );
    const opKey = cleanOpKey(args.opKey ?? args.requestId);

    const resolved = resolveTemplate(rawTemplate);
    if (!resolved) throw new MarketError('UNKNOWN_TEMPLATE', `Unknown item template "${rawTemplate}".`);
    const desc = describeTemplate(resolved.key);
    if (DISALLOWED_ORDER_GROUPS.has(desc.group) || resolved.key === 'letter-of-credit') {
      throw new MarketError('TEMPLATE_NOT_PERMITTED', `${desc.name} cannot be requested in a buy order.`);
    }
    if (qty < 1 || qty > cfg.maxQuantity) {
      throw new MarketError('INVALID_QUANTITY', `Quantity must be between 1 and ${cfg.maxQuantity}.`);
    }
    if (unitPrice < cfg.minPrice || unitPrice > cfg.maxPrice) {
      throw new MarketError('INVALID_PRICE', `Unit price must be between ${cfg.minPrice} and ${cfg.maxPrice} gold.`);
    }

    const totalEscrow = unitPrice * qty;
    if (!Number.isSafeInteger(totalEscrow) || totalEscrow > cfg.maxPrice * 10) {
      throw new MarketError('INVALID_TOTAL', 'Buy order total exceeds safe gold limit.');
    }

    const board = assertNearMarketBoard(buyer, cfg, { skipProximity: opts.skipProximity });
    const buyerAccountId = await mstore.resolveAccountId(buyer);
    const orderId = newOrderId();

    let committedBuyer = null;
    let committedOrder = null;

    const { replayed, result } = await mstore.runDurable(
      opKey,
      {
        accountId: buyerAccountId,
        characterId: buyer.id,
        resourceKey: `${ORDER_PREFIX}${opKey || orderId}`,
        params: { op: 'order.create', template: resolved.key, qty, unitPrice, durationMs },
        ttlMs: cfg.opKeyTtlMs,
      },
      async (tx) => {
        const now = typeof cfg.wallNow === 'function' ? cfg.wallNow() : tx.now;
        await safety.assertWithinObligationCaps(tx, buyerAccountId, buyer.id, ESCROW_KINDS.BUY_ORDER_GOLD);

        const buyerChar = await mstore.loadCharacterInTx(tx, buyer);
        if (buyerChar.rpg.gold < totalEscrow) {
          throw new MarketError('INSUFFICIENT_GOLD', `You need ${totalEscrow} gold to fund this buy order.`);
        }

        buyerChar.rpg.gold -= totalEscrow;
        await tx.saveCharacters([buyerChar]);

        const expiresAt = now + durationMs;
        const escrow = await tx.createEscrow({
          kind: ESCROW_KINDS.BUY_ORDER_GOLD,
          ownerAccountId: buyerAccountId,
          ownerCharacterId: buyerChar.id,
          sourceRef: orderId,
          gold: totalEscrow,
          item: null,
          status: 'held',
          expiresAt,
        });

        const order = {
          id: orderId,
          revision: 1,
          status: 'active',
          escrowId: escrow.id,
          buyerCharacterId: buyerChar.id,
          buyerAccountId,
          buyerName: buyerChar.name,
          template: desc.template,
          itemName: desc.name,
          group: desc.group,
          stackable: Boolean(desc.stackable),
          unitPrice,
          initialQuantity: qty,
          remainingQuantity: qty,
          saleTaxRate: cfg.saleTaxRate,
          boardId: board.id,
          region: board.region,
          town: board.town,
          createdAt: now,
          expiresAt,
          settledAt: null,
        };

        await tx.putWorld(`${ORDER_PREFIX}${orderId}`, order);
        committedBuyer = buyerChar;
        committedOrder = order;

        return {
          order: projectBuyOrderPublic(order),
          escrowId: escrow.id,
          escrowedGold: totalEscrow,
          remainingGold: buyerChar.rpg.gold,
        };
      },
    );

    if (!replayed && committedBuyer) {
      mstore.applyCommittedCharacter(committedBuyer, buyer);
      mstore.orders.set(committedOrder.id, committedOrder);
    }

    return { ok: true, replayed, ...result };
  }

  /**
   * Partially or fully fulfills an active funded buy order using an eligible item from seller's inventory.
   * Delivers item to buyer and proceeds (minus sale tax) to seller via `claim_records`.
   */
  async function fillBuyOrder(seller, args = {}, opts = {}) {
    const orderId = String(args.orderId ?? '');
    const itemId = String(args.itemId ?? '');
    const qty = int(args.quantity ?? 1, 0);
    const expectedRev = args.expectedRev != null ? int(args.expectedRev, -1) : null;
    const opKey = cleanOpKey(args.opKey ?? args.requestId);

    if (!orderId) throw new MarketError('INVALID_ORDER', 'Choose a buy order to fulfill.');
    if (!itemId) throw new MarketError('INVALID_ITEM', 'Choose an item from your pack to deliver.');
    if (qty < 1 || qty > cfg.maxQuantity) throw new MarketError('INVALID_QUANTITY', 'Invalid delivery quantity.');

    assertNearMarketBoard(seller, cfg, { skipProximity: opts.skipProximity });
    const sellerAccountId = await mstore.resolveAccountId(seller);

    let committedSeller = null;
    let committedOrder = null;
    let committedLedger = null;
    let settlementInfo = null;

    const { replayed, result } = await mstore.runDurable(
      opKey,
      {
        accountId: sellerAccountId,
        characterId: seller.id,
        resourceKey: `${ORDER_PREFIX}${orderId}`,
        params: { op: 'order.fill', orderId, itemId, qty, expectedRev },
        ttlMs: cfg.opKeyTtlMs,
      },
      async (tx) => {
        const now = typeof cfg.wallNow === 'function' ? cfg.wallNow() : tx.now;
        const order = await tx.getWorld(`${ORDER_PREFIX}${orderId}`);
        if (!order) throw new MarketError('ORDER_NOT_FOUND', 'Buy order not found.');

        if (order.status !== 'active' || now >= order.expiresAt || order.remainingQuantity <= 0) {
          throw new MarketError('ORDER_CLOSED', 'This buy order is no longer active.');
        }

        await safety.assertNotSelfTrade(seller, order.buyerCharacterId, order.buyerAccountId);

        if (expectedRev !== null && order.revision !== expectedRev) {
          throw new MarketError('STALE_QUOTE', 'This buy order changed since you viewed it. Refresh and try again.', {
            freshQuote: projectBuyOrderPublic(order),
          });
        }
        if (qty > order.remainingQuantity) {
          throw new MarketError('EXCEEDS_ORDER_QUANTITY', `This buy order only needs ${order.remainingQuantity} more.`);
        }

        const sellerChar = await mstore.loadCharacterInTx(tx, seller);
        const found = sellerChar.rpg.inventory.find((i) => i && i.id === itemId);
        if (!found) {
          const rawFound = (sellerChar._rawInventory ?? []).find((i) => i && i.id === itemId);
          if (rawFound && !normalizeRecord(rawFound)) {
            throw new MarketError('CORRUPTED_ITEM', 'That item record is corrupted and cannot fulfill a buy order.');
          }
          throw new MarketError('ITEM_NOT_FOUND', 'You do not have that item.');
        }
        if (!normalizeRecord(found)) {
          throw new MarketError('CORRUPTED_ITEM', 'That item record is corrupted and cannot fulfill a buy order.');
        }
        assertItemEligible(found, 'market');
        if (found.template !== order.template) {
          throw new MarketError('ITEM_MISMATCH', `This buy order requires ${order.itemName} (${order.template}).`);
        }
        if (found.maxCondition > 0 && found.condition <= 0) {
          throw new MarketError('BROKEN_ITEM', 'Broken items cannot fulfill a buy order.');
        }
        if (found.quantity < qty) {
          throw new MarketError('INSUFFICIENT_QUANTITY', `You only have ${found.quantity} ${found.name}.`);
        }

        const esc = await tx.getEscrow(order.escrowId);
        const gross = order.unitPrice * qty;
        if (!esc || esc.status !== 'held' || esc.gold < gross) {
          throw new MarketError('ESCROW_UNAVAILABLE', 'Buy order gold escrow is insufficient.');
        }

        const taken = takeForTransfer(sellerChar.rpg, itemId, qty, 'market');
        await tx.saveCharacters([sellerChar]);

        const saleTax = computeSaleTax(gross, cfg);
        const sellerProceeds = gross - saleTax;
        const nextRem = order.remainingQuantity - qty;
        const nextEscrowGold = esc.gold - gross;

        await tx.updateEscrowStatus(esc.id, esc.revision, nextRem === 0 ? 'settled' : 'held', {
          gold: nextEscrowGold,
          counterpartyCharacterId: sellerChar.id,
        });

        const buyerClaim = await tx.createClaim({
          ownerCharacterId: order.buyerCharacterId,
          ownerAccountId: order.buyerAccountId,
          kind: CLAIM_KINDS.BUY_ORDER_ITEM,
          sourceRef: order.id,
          gold: 0,
          item: taken,
          reason: `Buy order filled (${qty}x ${taken.name} by ${sellerChar.name})`,
        });

        const sellerClaim = await tx.createClaim({
          ownerCharacterId: sellerChar.id,
          ownerAccountId: sellerAccountId,
          kind: CLAIM_KINDS.BUY_ORDER_PROCEEDS,
          sourceRef: order.id,
          gold: sellerProceeds,
          item: null,
          reason: `Filled buy order for ${qty}x ${taken.name} (${gross}g - ${saleTax}g tax)`,
        });

        order.remainingQuantity = nextRem;
        if (nextRem === 0) {
          order.status = 'filled';
          order.settledAt = now;
        }
        order.revision += 1;

        const settlement = {
          kind: 'buy_order_fill',
          refId: order.id,
          at: now,
          quantity: qty,
          unitPrice: order.unitPrice,
          gross,
          saleTax,
          sellerProceeds,
          pairKey: pairKeyOf(order.buyerAccountId ?? `c:${order.buyerCharacterId}`, sellerAccountId ?? `c:${sellerChar.id}`),
        };
        const nextLedger = await mstore.recordLedgerInTx(tx, { saleTax, gross, settlement });
        await tx.putWorld(`${ORDER_PREFIX}${order.id}`, order);

        committedSeller = sellerChar;
        committedOrder = order;
        committedLedger = nextLedger;
        settlementInfo = settlement;

        return {
          order: projectBuyOrderPublic(order),
          filledQuantity: qty,
          gross,
          saleTax,
          sellerProceeds,
          buyerClaimId: buyerClaim.id,
          sellerClaimId: sellerClaim.id,
        };
      },
    );

    if (!replayed && committedSeller) {
      mstore.applyCommittedCharacter(committedSeller, seller);
      mstore.orders.set(committedOrder.id, committedOrder);
      mstore.applyLedger(committedLedger);
      safety.inspectSettlementPattern(committedLedger, settlementInfo);
    }

    return { ok: true, replayed, ...result };
  }

  /**
   * Cancels an active buy order and returns unused escrowed gold via `claim_records`.
   */
  async function cancelBuyOrder(actor, args = {}) {
    const orderId = String(args.orderId ?? '');
    const opKey = cleanOpKey(args.opKey ?? args.requestId);
    if (!orderId) throw new MarketError('INVALID_ORDER', 'Choose a buy order to cancel.');
    const actorAccountId = await mstore.resolveAccountId(actor);
    let committedOrder = null;

    const { replayed, result } = await mstore.runDurable(
      opKey,
      {
        accountId: actorAccountId,
        characterId: actor.id,
        resourceKey: `${ORDER_PREFIX}${orderId}`,
        params: { op: 'order.cancel', orderId },
        ttlMs: cfg.opKeyTtlMs,
      },
      async (tx) => {
        const now = typeof cfg.wallNow === 'function' ? cfg.wallNow() : tx.now;
        const order = await tx.getWorld(`${ORDER_PREFIX}${orderId}`);
        if (!order) throw new MarketError('ORDER_NOT_FOUND', 'Buy order not found.');
        if (Number(order.buyerCharacterId) !== Number(actor.id)) {
          throw new MarketError('FORBIDDEN', 'You can only cancel your own buy orders.');
        }
        if (order.status !== 'active') {
          throw new MarketError('ORDER_NOT_ACTIVE', `Buy order is already ${order.status}.`);
        }

        const esc = await tx.getEscrow(order.escrowId);
        let refundClaim = null;
        if (esc && esc.status === 'held') {
          await tx.updateEscrowStatus(esc.id, esc.revision, 'refunded', { gold: 0 });
          if (esc.gold > 0) {
            refundClaim = await tx.createClaim({
              ownerCharacterId: order.buyerCharacterId,
              ownerAccountId: order.buyerAccountId,
              kind: CLAIM_KINDS.BUY_ORDER_CANCELLED,
              sourceRef: order.id,
              gold: esc.gold,
              item: null,
              reason: `Cancelled buy order for ${order.itemName}; unused gold refunded`,
            });
          }
        }

        order.status = 'cancelled';
        order.remainingQuantity = 0;
        order.settledAt = now;
        order.revision += 1;
        await tx.putWorld(`${ORDER_PREFIX}${order.id}`, order);
        committedOrder = order;

        return {
          order: projectBuyOrderPublic(order),
          refundClaimId: refundClaim?.id ?? null,
          refundedGold: refundClaim?.gold ?? 0,
        };
      },
    );

    if (!replayed && committedOrder) {
      mstore.orders.set(committedOrder.id, committedOrder);
    }
    return { ok: true, replayed, ...result };
  }

  /**
   * Expires due buy orders in bounded batches, returning unused escrowed gold via claims.
   */
  async function expireDueBuyOrders(nowMs = mstore.wallNow(), { limit = cfg.settlementBatchLimit } = {}) {
    const due = [...mstore.orders.values()]
      .filter((o) => o.status === 'active' && o.expiresAt <= nowMs)
      .sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id))
      .slice(0, limit);

    const expired = [];
    for (const o of due) {
      let committedOrder = null;
      const { result } = await mstore.runDurable(
        `order-expire:${o.id}`,
        { resourceKey: `${ORDER_PREFIX}${o.id}`, params: { op: 'order.expire', orderId: o.id } },
        async (tx) => {
          const now = typeof cfg.wallNow === 'function' ? cfg.wallNow() : tx.now;
          const cur = await tx.getWorld(`${ORDER_PREFIX}${o.id}`);
          if (!cur || cur.status !== 'active' || cur.expiresAt > now) return { skipped: true };
          const esc = await tx.getEscrow(cur.escrowId);
          let refundClaim = null;
          if (esc && esc.status === 'held') {
            await tx.updateEscrowStatus(esc.id, esc.revision, 'expired', { gold: 0 });
            if (esc.gold > 0) {
              refundClaim = await tx.createClaim({
                ownerCharacterId: cur.buyerCharacterId,
                ownerAccountId: cur.buyerAccountId,
                kind: CLAIM_KINDS.BUY_ORDER_EXPIRED,
                sourceRef: cur.id,
                gold: esc.gold,
                item: null,
                reason: `Expired buy order for ${cur.itemName}; unused gold refunded`,
              });
            }
          }
          cur.status = 'expired';
          cur.remainingQuantity = 0;
          cur.settledAt = now;
          cur.revision += 1;
          await tx.putWorld(`${ORDER_PREFIX}${cur.id}`, cur);
          committedOrder = cur;
          return { orderId: cur.id, refundClaimId: refundClaim?.id ?? null };
        },
      );
      if (committedOrder) {
        mstore.orders.set(committedOrder.id, committedOrder);
        expired.push(result);
      }
    }
    return expired;
  }

  /**
   * Paginated browse / search / filter / sort over active funded buy orders.
   */
  function browseBuyOrders(query = {}) {
    const now = mstore.wallNow();
    const search = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
    const group = typeof query.group === 'string' && query.group.trim() && query.group !== 'all' ? query.group.trim().toLowerCase() : null;
    const region = typeof query.region === 'string' && query.region.trim() && query.region !== 'all' ? query.region.trim().toLowerCase() : null;
    const template = typeof query.template === 'string' && query.template.trim() ? query.template.trim().toLowerCase() : null;
    const sort = typeof query.sort === 'string' ? query.sort : 'price_desc';
    const pageSize = clampInt(query.limit ?? query.pageSize, 1, cfg.pageSizeMax, cfg.pageSizeDefault);
    const pageNum = Math.max(1, int(query.page, 1));

    const matched = [];
    for (const o of mstore.orders.values()) {
      if (o.status !== 'active' || o.remainingQuantity <= 0 || o.expiresAt <= now) continue;
      if (group && String(o.group ?? '').toLowerCase() !== group) continue;
      if (region && String(o.region ?? '').toLowerCase() !== region) continue;
      if (template && String(o.template ?? '').toLowerCase() !== template) continue;
      if (search) {
        const hay = [o.itemName, o.template, o.group, o.buyerName, o.region, o.town].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(search)) continue;
      }
      matched.push(o);
    }

    matched.sort((a, b) => {
      let cmp = 0;
      switch (sort) {
        case 'price_asc':
          cmp = a.unitPrice - b.unitPrice;
          break;
        case 'ending_soon':
          cmp = a.expiresAt - b.expiresAt;
          break;
        case 'qty_desc':
          cmp = b.remainingQuantity - a.remainingQuantity;
          break;
        case 'price_desc':
        default:
          cmp = b.unitPrice - a.unitPrice;
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
      items: matched.slice(start, start + pageSize).map(projectBuyOrderPublic),
    };
  }

  return {
    createBuyOrder,
    fillBuyOrder,
    cancelBuyOrder,
    expireDueBuyOrders,
    browseBuyOrders,
  };
}
