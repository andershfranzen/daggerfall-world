// Shared configuration, constants, error helpers, and validation utilities for §6 Player Market.

export const MARKET_WORLD_PREFIX = 'market:';
export const LISTING_PREFIX = 'market:listing:';
export const AUCTION_PREFIX = 'market:auction:';
export const ORDER_PREFIX = 'market:order:';
export const LEDGER_KEY = 'market:ledger';
export const TRADERS_PREFIX = 'market:trader:';

export const ESCROW_KINDS = Object.freeze({
  LISTING_ITEM: 'market_listing',
  AUCTION_ITEM: 'auction_item',
  AUCTION_BID: 'auction_bid',
  BUY_ORDER_GOLD: 'buy_order_gold',
});

export const CLAIM_KINDS = Object.freeze({
  PURCHASE_ITEM: 'market_purchase',
  SALE_PROCEEDS: 'market_proceeds',
  LISTING_CANCELLED: 'market_cancelled',
  LISTING_EXPIRED: 'market_expired',
  AUCTION_WON: 'auction_won',
  AUCTION_PROCEEDS: 'auction_proceeds',
  AUCTION_OUTBID: 'auction_outbid',
  AUCTION_UNSOLD: 'auction_unsold',
  AUCTION_CANCELLED: 'auction_cancelled',
  AUCTION_RESERVE_REFUND: 'auction_reserve_refund',
  BUY_ORDER_ITEM: 'buy_order_item',
  BUY_ORDER_PROCEEDS: 'buy_order_proceeds',
  BUY_ORDER_CANCELLED: 'buy_order_cancelled',
  BUY_ORDER_EXPIRED: 'buy_order_expired',
  ESCROW_REFUND: 'escrow_refund',
});

export const MARKET_DEFAULTS = Object.freeze({
  listingFeeRate: 0.02,
  minListingFee: 1,
  saleTaxRate: 0.05,
  buyOrderFeeRate: 0,
  minPrice: 1,
  maxPrice: 100_000_000,
  maxQuantity: 9999,
  defaultListingDurationMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  minListingDurationMs: 60 * 1000, // 1 minute
  maxListingDurationMs: 14 * 24 * 60 * 60 * 1000, // 14 days
  defaultAuctionDurationMs: 24 * 60 * 60 * 1000, // 24 hours
  minAuctionDurationMs: 5 * 60 * 1000, // 5 minutes
  maxAuctionDurationMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  defaultBuyOrderDurationMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  minBuyOrderDurationMs: 60 * 1000,
  maxBuyOrderDurationMs: 14 * 24 * 60 * 60 * 1000,
  antiSnipeWindowMs: 2 * 60 * 1000, // 2 minutes before close
  antiSnipeExtensionMs: 2 * 60 * 1000, // extend by 2 minutes from bid time
  maxAntiSnipeExtensions: 10,
  minBidIncrementRate: 0.05,
  settlementIntervalMs: 5_000,
  settlementBatchLimit: 25,
  boardReach: 16, // metres from town market board
  maxActiveListingsPerAccount: 20,
  maxActiveAuctionsPerAccount: 10,
  maxActiveBuyOrdersPerAccount: 10,
  maxTotalObligationsPerAccount: 30,
  pageSizeDefault: 20,
  pageSizeMax: 50,
  repeatTradeWindowMs: 60 * 60 * 1000, // 1 hour
  repeatTradeThreshold: 6, // flag suspicious pair after 6 trades/hour
  opKeyTtlMs: 24 * 60 * 60 * 1000, // 24 hours
});

export class MarketError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'MarketError';
    this.code = code;
    this.expose = true;
    Object.assign(this, extra);
  }
}

export function int(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function clampInt(v, min, max, fallback = min) {
  const n = int(v, NaN);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function resolveMarketConfig(ctx) {
  const overrides = ctx?.config?.market && typeof ctx.config.market === 'object' ? ctx.config.market : {};
  return { ...MARKET_DEFAULTS, ...overrides };
}

export function computeListingFee(totalValue, cfg) {
  const raw = Math.floor(Math.max(0, totalValue) * cfg.listingFeeRate);
  return Math.max(cfg.minListingFee, raw);
}

export function computeSaleTax(gross, cfg) {
  const g = Math.max(0, Math.trunc(gross));
  const tax = Math.floor(g * cfg.saleTaxRate);
  return Math.min(g, Math.max(0, tax));
}

export function computeMinBidIncrement(startPrice, currentHighBid, customIncrement, cfg) {
  if (Number.isSafeInteger(customIncrement) && customIncrement >= 1) return customIncrement;
  const base = Math.max(1, currentHighBid > 0 ? currentHighBid : startPrice);
  return Math.max(1, Math.ceil(base * cfg.minBidIncrementRate));
}

export function itemQualityTier(item) {
  if (!item || typeof item !== 'object') return 'common';
  if (item.magic?.artifact) return 'artifact';
  if (item.magic) return 'enchanted';
  if (item.crafted?.quality) return String(item.crafted.quality).toLowerCase();
  const mat = String(item.material ?? '').toLowerCase();
  if (mat === 'daedric' || mat === 'ebony' || mat === 'orcish') return 'masterwork';
  if (mat === 'adamantium' || mat === 'mithril' || mat === 'dwarven') return 'fine';
  if (mat === 'elven' || mat === 'silver') return 'good';
  return 'common';
}

export function summarizeItemPublic(item) {
  if (!item || typeof item !== 'object') return null;
  const out = {
    template: item.template,
    base: item.base ?? null,
    name: item.name || item.template,
    group: item.group || 'misc',
    material: item.material ?? null,
    quality: itemQualityTier(item),
    weight: Number.isFinite(item.weight) ? item.weight : 0,
    value: Number.isFinite(item.value) ? item.value : 0,
    condition: Number.isFinite(item.condition) ? item.condition : 0,
    maxCondition: Number.isFinite(item.maxCondition) ? item.maxCondition : 0,
    stackable: Boolean(item.stackable),
    variant: item.variant ?? 0,
    icon: item.icon ? structuredClone(item.icon) : null,
  };
  if (item.damage) out.damage = { ...item.damage };
  if (Number.isFinite(item.armorValue)) out.armorValue = item.armorValue;
  if (item.crafted) {
    out.crafted = {
      maker: item.crafted.maker ?? item.crafted.makerName ?? null,
      quality: item.crafted.quality ?? null,
      profession: item.crafted.profession ?? null,
    };
  }
  if (item.magic) {
    out.magic = {
      identified: item.magic.identified !== false,
      name: item.magic.identified !== false ? (item.magic.name ?? null) : null,
      enchantmentCount: Array.isArray(item.magic.enchantments) ? item.magic.enchantments.length : 0,
      artifact: Boolean(item.magic.artifact),
    };
  }
  return out;
}

export function cleanOpKey(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  if (!s || s.length > 128) throw new MarketError('INVALID_OP_KEY', 'Operation key must be 1..128 characters.');
  return s;
}
