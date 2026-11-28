// Durable ledger & indexed in-memory read cache for §6 Player Market.
//
// Coordinates:
//  - `ctx.services.store` / `ctx.services.runDurable` (both SQLite & PostgreSQL buffered stores)
//  - Live in-memory player `rpg` synchronization (only updated AFTER durable commit succeeds)
//  - Account resolution across all character slots for strict anti-self-trade & account caps
//  - Hydration of listings, auctions, buy orders, fallback traders, and fee/tax ledger from `world_state`

import { normalizeRpg } from '../inventory.js';
import {
  LISTING_PREFIX,
  AUCTION_PREFIX,
  ORDER_PREFIX,
  LEDGER_KEY,
  TRADERS_PREFIX,
  MarketError,
} from './config.js';

function restoreInto(target, source) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, source);
}

/**
 * Resolves the backing durable store from `ctx.services` without failing lightweight unit-test runtimes
 * that mount production features without a backing SQLite/PostgreSQL store.
 */
export function resolveStore(ctx) {
  const getStore = () => ctx?.services?.store ?? null;
  const getRunDurable = () => {
    const s = getStore();
    if (typeof ctx?.services?.runDurable === 'function') return ctx.services.runDurable;
    if (typeof s?.runDurable === 'function') return (...args) => s.runDurable(...args);
    return null;
  };
  const hasDurableStore = () => Boolean(getStore() && getRunDurable());
  const store = getStore();
  const runDurable = (...args) => {
    const fn = getRunDurable();
    if (!fn) {
      throw new MarketError('STORE_UNAVAILABLE', 'Durable market storage is not configured on this server.');
    }
    return fn(...args);
  };
  return { store, runDurable, hasDurableStore };
}

export function createMarketStore(ctx, cfg) {
  const { store, runDurable, hasDurableStore } = resolveStore(ctx);
  const wallNow = () => (typeof cfg.wallNow === 'function' ? cfg.wallNow() : Date.now());

  // Indexed in-memory mirrors (strictly updated after durable commits & hydrated on startup).
  const listings = new Map(); // id -> listing record
  const auctions = new Map(); // id -> auction record
  const orders = new Map(); // id -> buy order record
  const traders = new Map(); // traderId -> fallback house trader record
  const charToAccount = new Map(); // characterId (number) -> accountId (string)
  let ledger = {
    totalListingFees: 0,
    totalSaleTaxes: 0,
    totalVolume: 0,
    settlementCount: 0,
    recentSettlements: [], // bounded ring buffer for audit & repeat-trade monitoring
  };

  function hydrate() {
    const loadWorld = typeof ctx?.loadWorld === 'function'
      ? (p) => ctx.loadWorld(p)
      : (typeof store?.loadWorld === 'function' ? (p) => store.loadWorld(p) : null);
    if (!loadWorld) return;
    const rows = loadWorld('market:');
    // loadWorld on SQLite & buffered PG is synchronous; ignore if an unbuffered async PG returns a Promise here.
    if (!Array.isArray(rows)) return;
    for (const [key, val] of rows) {
      if (!val || typeof val !== 'object') continue;
      if (key.startsWith(LISTING_PREFIX) && typeof val.id === 'string') {
        listings.set(val.id, structuredClone(val));
        if (val.sellerCharacterId != null && val.sellerAccountId != null) {
          charToAccount.set(Number(val.sellerCharacterId), String(val.sellerAccountId));
        }
      } else if (key.startsWith(AUCTION_PREFIX) && typeof val.id === 'string') {
        auctions.set(val.id, structuredClone(val));
        if (val.sellerCharacterId != null && val.sellerAccountId != null) {
          charToAccount.set(Number(val.sellerCharacterId), String(val.sellerAccountId));
        }
        if (val.highBidderCharacterId != null && val.highBidderAccountId != null) {
          charToAccount.set(Number(val.highBidderCharacterId), String(val.highBidderAccountId));
        }
      } else if (key.startsWith(ORDER_PREFIX) && typeof val.id === 'string') {
        orders.set(val.id, structuredClone(val));
        if (val.buyerCharacterId != null && val.buyerAccountId != null) {
          charToAccount.set(Number(val.buyerCharacterId), String(val.buyerAccountId));
        }
      } else if (key.startsWith(TRADERS_PREFIX) && typeof val.traderId === 'string') {
        traders.set(val.traderId, structuredClone(val));
      } else if (key === LEDGER_KEY) {
        ledger = {
          totalListingFees: Number(val.totalListingFees ?? 0) || 0,
          totalSaleTaxes: Number(val.totalSaleTaxes ?? 0) || 0,
          totalVolume: Number(val.totalVolume ?? 0) || 0,
          settlementCount: Number(val.settlementCount ?? 0) || 0,
          recentSettlements: Array.isArray(val.recentSettlements) ? val.recentSettlements.slice(-200) : [],
        };
      }
    }
  }

  /**
   * Async re-hydration (useful when an unbuffered async Postgres store is used in tests).
   */
  async function hydrateAsync() {
    if (typeof store.loadWorld !== 'function') return;
    const rows = await Promise.resolve(store.loadWorld('market:'));
    if (!Array.isArray(rows)) return;
    listings.clear();
    auctions.clear();
    orders.clear();
    traders.clear();
    for (const [key, val] of rows) {
      if (!val || typeof val !== 'object') continue;
      if (key.startsWith(LISTING_PREFIX) && typeof val.id === 'string') listings.set(val.id, structuredClone(val));
      else if (key.startsWith(AUCTION_PREFIX) && typeof val.id === 'string') auctions.set(val.id, structuredClone(val));
      else if (key.startsWith(ORDER_PREFIX) && typeof val.id === 'string') orders.set(val.id, structuredClone(val));
      else if (key.startsWith(TRADERS_PREFIX) && typeof val.traderId === 'string') traders.set(val.traderId, structuredClone(val));
      else if (key === LEDGER_KEY) {
        ledger = {
          totalListingFees: Number(val.totalListingFees ?? 0) || 0,
          totalSaleTaxes: Number(val.totalSaleTaxes ?? 0) || 0,
          totalVolume: Number(val.totalVolume ?? 0) || 0,
          settlementCount: Number(val.settlementCount ?? 0) || 0,
          recentSettlements: Array.isArray(val.recentSettlements) ? val.recentSettlements.slice(-200) : [],
        };
      }
    }
  }

  hydrate();

  /**
   * Resolves the canonical account ID string for a player or character ID, consulting:
   *  1. player.accountId
   *  2. live ctx.players
   *  3. cached charToAccount map
   *  4. SQLite/PG `account_characters` table when available
   */
  async function resolveAccountId(playerOrId) {
    if (playerOrId && typeof playerOrId === 'object') {
      if (playerOrId.accountId != null && playerOrId.accountId !== '') {
        const acct = String(playerOrId.accountId);
        if (Number.isSafeInteger(Number(playerOrId.id))) charToAccount.set(Number(playerOrId.id), acct);
        return acct;
      }
      if (playerOrId.id != null) return resolveAccountId(playerOrId.id);
      return null;
    }
    const cid = Number(playerOrId);
    if (!Number.isSafeInteger(cid)) return null;
    const live = ctx?.players?.get?.(cid);
    if (live?.accountId != null && live.accountId !== '') {
      const acct = String(live.accountId);
      charToAccount.set(cid, acct);
      return acct;
    }
    if (charToAccount.has(cid)) return charToAccount.get(cid);
    // Query SQLite account_characters directly if open.
    if (store.db?.isOpen) {
      try {
        const row = store.db.prepare('SELECT account_id FROM account_characters WHERE player_id = ?').get(cid);
        if (row?.account_id != null) {
          const acct = String(row.account_id);
          charToAccount.set(cid, acct);
          return acct;
        }
      } catch {}
    }
    // Query PostgreSQL pool directly if present.
    const pool = store.pool ?? store.inner?.pool;
    if (pool && typeof pool.query === 'function') {
      try {
        const { rows } = await pool.query('SELECT account_id FROM account_characters WHERE player_id = $1', [cid]);
        if (rows?.[0]?.account_id != null) {
          const acct = String(rows[0].account_id);
          charToAccount.set(cid, acct);
          return acct;
        }
      } catch {}
    }
    return null;
  }

  /**
   * Loads an authoritative character clone inside a durable transaction.
   * Prefers live in-memory `rpg` for online players (so unsaved inventory/gold changes aren't lost),
   * while falling back to `tx.getCharacter(id)` for offline characters.
   */
  async function loadCharacterInTx(tx, actorOrId) {
    const id = typeof actorOrId === 'object' ? Number(actorOrId.id) : Number(actorOrId);
    const live = ctx?.players?.get?.(id) ?? (typeof actorOrId === 'object' ? actorOrId : null);
    const persisted = await tx.getCharacter(id);
    if (!persisted && !live) {
      throw new MarketError('CHARACTER_NOT_FOUND', 'Character record not found.');
    }
    const base = persisted
      ? {
          id: persisted.id,
          name: live?.name ?? persisted.name,
          x: live?.x ?? persisted.x,
          z: live?.z ?? persisted.z,
          yaw: live?.yaw ?? persisted.yaw,
          rpg: structuredClone(live?.rpg ?? persisted.rpg ?? {}),
        }
      : {
          id: live.id,
          name: live.name,
          x: live.x ?? 0,
          z: live.z ?? 0,
          yaw: live.yaw ?? 0,
          rpg: structuredClone(live.rpg ?? {}),
        };
    const rawInventory = Array.isArray(base.rpg?.inventory) ? structuredClone(base.rpg.inventory) : [];
    normalizeRpg(base.rpg);
    base._rawInventory = rawInventory;
    return base;
  }

  /**
   * Applies committed character state back onto any live in-memory player object (keeping object identity).
   */
  function applyCommittedCharacter(committed, callerPlayer = null) {
    if (!committed) return;
    const targets = new Set();
    const live = ctx?.players?.get?.(committed.id);
    if (live) targets.add(live);
    if (callerPlayer && Number(callerPlayer.id) === Number(committed.id)) targets.add(callerPlayer);
    for (const p of targets) {
      if (p.rpg && typeof p.rpg === 'object') restoreInto(p.rpg, structuredClone(committed.rpg));
      else p.rpg = structuredClone(committed.rpg);
      p.dirty = false;
      ctx?.emit?.('inventoryChanged', { player: p, reason: 'market' });
    }
  }

  /**
   * Updates the shared fee/tax/volume ledger inside a durable transaction and returns the new snapshot.
   */
  async function recordLedgerInTx(tx, { listingFee = 0, saleTax = 0, gross = 0, settlement = null } = {}) {
    const cur = (await tx.getWorld(LEDGER_KEY)) ?? {
      totalListingFees: 0,
      totalSaleTaxes: 0,
      totalVolume: 0,
      settlementCount: 0,
      recentSettlements: [],
    };
    const next = {
      totalListingFees: (Number(cur.totalListingFees) || 0) + Math.max(0, Math.trunc(listingFee)),
      totalSaleTaxes: (Number(cur.totalSaleTaxes) || 0) + Math.max(0, Math.trunc(saleTax)),
      totalVolume: (Number(cur.totalVolume) || 0) + Math.max(0, Math.trunc(gross)),
      settlementCount: (Number(cur.settlementCount) || 0) + (settlement ? 1 : 0),
      recentSettlements: Array.isArray(cur.recentSettlements) ? cur.recentSettlements.slice(-199) : [],
    };
    if (settlement) next.recentSettlements.push(settlement);
    await tx.putWorld(LEDGER_KEY, next);
    return next;
  }

  function applyLedger(nextLedger) {
    if (nextLedger) ledger = structuredClone(nextLedger);
  }

  function getLedger() {
    return structuredClone(ledger);
  }

  return {
    store,
    runDurable,
    hasDurableStore,
    wallNow,
    listings,
    auctions,
    orders,
    traders,
    charToAccount,
    hydrate,
    hydrateAsync,
    resolveAccountId,
    loadCharacterInTx,
    applyCommittedCharacter,
    recordLedgerInTx,
    applyLedger,
    getLedger,
  };
}
