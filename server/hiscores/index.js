// Unified Chronicles of the Iliac Bay (Hiscores) service wiring storage (SQLite or PostgreSQL),
// projection rules, cached ranking engine, and public read-only HTTP API.
import {
  TOTAL_CLASSIC_PLACES,
  CORE_BOARDS,
  GUILD_BOARDS,
  SKILL_BOARDS,
  ORDERS_BOARD,
  ALL_BOARDS,
  BOARD_BY_ID,
  resolveBoard,
  publicCategoriesPayload,
  skillSlug,
} from './categories.js';
import { projectCharacter, projectOrders, scoreForBoard } from './project.js';
import { createHiscoresEngine } from './engine.js';
import { openSqliteHiscoresStore } from './sqlite-store.js';
import { openPostgresHiscoresStore, loadHiscoresSchemaSql } from './postgres-store.js';
import { HISCORES_PATH, isHiscoresPath, createHiscoresHttpHandler, handleHiscoresRequest } from './http.js';

export {
  TOTAL_CLASSIC_PLACES,
  CORE_BOARDS,
  GUILD_BOARDS,
  SKILL_BOARDS,
  ORDERS_BOARD,
  ALL_BOARDS,
  BOARD_BY_ID,
  resolveBoard,
  publicCategoriesPayload,
  skillSlug,
  projectCharacter,
  projectOrders,
  scoreForBoard,
  createHiscoresEngine,
  openSqliteHiscoresStore,
  openPostgresHiscoresStore,
  loadHiscoresSchemaSql,
  HISCORES_PATH,
  isHiscoresPath,
  createHiscoresHttpHandler,
  handleHiscoresRequest,
};

const PGUILD_PREFIX = 'pguild:';

async function collectBannedAccountIds(accounts) {
  const out = new Set();
  if (!accounts) return out;
  try {
    if (typeof accounts.listBannedAccountIds === 'function') {
      const ids = await accounts.listBannedAccountIds();
      for (const id of ids ?? []) if (id != null) out.add(String(id));
      return out;
    }
    const store = accounts.store;
    if (store?.db && typeof store.db.prepare === 'function') {
      const rows = store.db.prepare('SELECT id FROM accounts WHERE banned_at IS NOT NULL').all();
      for (const r of rows) if (r?.id != null) out.add(String(r.id));
    } else if (store?.pool && typeof store.pool.query === 'function') {
      const res = await store.pool.query('SELECT id FROM accounts WHERE banned_at IS NOT NULL');
      for (const r of res?.rows ?? []) if (r?.id != null) out.add(String(r.id));
    }
  } catch {
    // Non-fatal: accounts store may be a mock or unavailable.
  }
  return out;
}

/**
 * Create the live Hiscores service for `server/game.js`.
 *
 * Options:
 *   - `hiscoresStore`: pre-opened SQLite or PostgreSQL hiscores store (takes precedence)
 *   - `gameStore`: `server/db.js` SQLite store (`gameStore.db`) or buffered PG store (`gameStore.pool`)
 *   - `accounts`: optional accounts service (used to exclude banned accounts)
 *   - `ttlMs`: snapshot cache TTL in ms (default 30_000)
 *   - `requireCreated`: exclude uncreated characters (default true)
 *   - `requireLinked`: require account-linked characters (default false so dev/guest worlds still work)
 *   - `trustProxy`, `corsOrigin`, `rateLimit`: forwarded to `createHiscoresHttpHandler`
 */
export function createHiscoresService(options = {}) {
  const {
    hiscoresStore: explicitStore = null,
    gameStore = null,
    accounts = null,
    ttlMs = 30_000,
    requireCreated = true,
    requireLinked = false,
    trustProxy = false,
    corsOrigin = null,
    rateLimit = null,
    log = console,
  } = options;

  let store = explicitStore;
  if (!store && gameStore?.db) {
    store = openSqliteHiscoresStore(gameStore.db, { ownsDb: false });
  }

  let initialRebuildDone = false;
  let initialRebuildPromise = null;

  async function ensureInitialRebuild() {
    if (initialRebuildDone || !store) return;
    if (!initialRebuildPromise) {
      initialRebuildPromise = (async () => {
        try {
          const bannedAccountIds = await collectBannedAccountIds(accounts);
          await store.rebuildFromTables({
            projectCharacter,
            projectOrders,
            bannedAccountIds,
            requireCreated,
            requireLinked,
          });
          initialRebuildDone = true;
        } catch (err) {
          log?.error?.('[hiscores] initial rebuild failed:', err?.message ?? err);
        } finally {
          initialRebuildPromise = null;
        }
      })();
    }
    await initialRebuildPromise;
  }

  const engine = createHiscoresEngine({
    ttlMs,
    resolveBoard,
    scoreForBoard,
    publicCategoriesPayload,
    loadSnapshot: async () => {
      if (!store) return { characters: [], orders: [], generatedAt: Date.now() };
      await ensureInitialRebuild();
      return store.loadSnapshot();
    },
  });

  const handleHttp = createHiscoresHttpHandler(engine, {
    trustProxy,
    ...(corsOrigin ? { corsOrigin } : {}),
    ...(rateLimit ? { rateLimit } : {}),
  });

  async function syncPlayers(playersList, worldEntries = []) {
    if (!store) return;
    try {
      await ensureInitialRebuild();
      const bannedAccountIds = await collectBannedAccountIds(accounts);
      const toUpsert = [];
      const toRemove = [];
      for (const p of playersList ?? []) {
        if (!p || p.id == null) continue;
        const projected = projectCharacter(
          {
            id: p.id,
            name: p.name,
            rpg: p.rpg,
            accountId: p.accountId ?? null,
            lastSeen: Date.now(),
          },
          { requireCreated, requireLinked, bannedAccountIds },
        );
        if (projected) toUpsert.push(projected);
        else toRemove.push(p.id);
      }
      if (toUpsert.length) await store.upsertCharacters(toUpsert);
      for (const id of toRemove) await store.removeCharacter(id);

      const hasOrderChanges = Array.isArray(worldEntries) && worldEntries.some(([k]) => typeof k === 'string' && k.startsWith(PGUILD_PREFIX));
      if (hasOrderChanges && typeof gameStore?.loadWorld === 'function') {
        const snap = await store.loadSnapshot();
        const byId = new Map(snap.characters.map((c) => [c.playerId, c]));
        const allOrderRows = await gameStore.loadWorld(PGUILD_PREFIX);
        const projectedOrders = projectOrders(allOrderRows, byId);
        await store.syncOrders(projectedOrders);
      }
      if (toUpsert.length || toRemove.length || hasOrderChanges) {
        engine.invalidate();
      }
    } catch (err) {
      if (err?.code === '23503') return; // player row concurrently deleted (e.g. account self-delete during disconnect)
      log?.error?.('[hiscores] syncPlayers failed:', err?.message ?? err);
    }
  }

  function syncPlayer(player) {
    if (!player) return Promise.resolve();
    return syncPlayers([player]);
  }

  async function rebuild() {
    if (!store) return { characters: 0, orders: 0, skipped: 0 };
    const bannedAccountIds = await collectBannedAccountIds(accounts);
    const summary = await store.rebuildFromTables({
      projectCharacter,
      projectOrders,
      bannedAccountIds,
      requireCreated,
      requireLinked,
    });
    initialRebuildDone = true;
    engine.invalidate();
    return summary;
  }

  async function removePlayer(playerId) {
    if (!store || playerId == null) return false;
    const removed = await store.removeCharacter(playerId);
    engine.invalidate();
    return removed;
  }

  async function close() {
    if (store && typeof store.close === 'function') {
      await store.close();
    }
  }

  return {
    store,
    engine,
    handleHttp,
    getCategories: () => engine.getCategories(),
    getBoard: (params) => engine.getBoard(params),
    getOrders: (params) => engine.getOrders(params),
    getPlayer: (nameOrId) => engine.getPlayer(nameOrId),
    comparePlayers: (a, b) => engine.comparePlayers(a, b),
    getStats: () => engine.getStats(),
    invalidate: () => engine.invalidate(),
    syncPlayer,
    syncPlayers,
    rebuild,
    removePlayer,
    close,
  };
}

export default createHiscoresService;
