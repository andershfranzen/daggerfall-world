// Authoritative multiplayer server: HTTP static delivery + WebSocket game protocol on /ws,
// with the shared online RPG runtime (server/rpg/runtime.js, docs/rpg-runtime.md).
import { createServer } from 'node:http';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import {
  openStore,
  CorruptCharacterError,
  DurableConflictError,
  SlotError,
  MAX_CHARACTER_SLOTS,
  ARCHIVE_WINDOW_MS,
  createKeyedLock,
} from './db.js';
import { openSqliteChatLog, createChatLogService } from './chat-log.js';
import { createHiscoresService, isHiscoresPath, projectCharacter, TOTAL_CLASSIC_PLACES } from './hiscores/index.js';
import { createSceneSpatialIndex } from './scale/spatial-grid.js';
import { createSiteHandler } from './static.js';
import { handlePublicWorldMap, handlePublicWorldPois, publicWorldMap, PUBLIC_MAP_PATH, PUBLIC_MAP_POIS_PATH } from './public-world-map.js';
import { createLocalAssets } from './local-assets.js';
import { createRpgRuntime, DEFAULT_LOCATION } from './rpg/runtime.js';
import { handleWildernessScene, WILDERNESS_SCENE_PATH } from './rpg/wilderness/http.js';
import { createLocalWodPack } from './rpg/wilderness/local-pack.js';
import { DEFAULT_ROOT as WOD_ROOT } from './rpg/wilderness.js';
import { handleWorldDataHttp, WORLDDATA_PATH } from './rpg/wilderness/replacements.js';
import * as manifest from './rpg/features.js';

export const PRODUCTION_FEATURES = manifest.features ?? manifest.default ?? [];

export const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 8080,
  dbPath: fileURLToPath(new URL('./data/daggerfallworld.db', import.meta.url)),
  clientDir: fileURLToPath(new URL('../client/', import.meta.url)),
  siteDir: fileURLToPath(new URL('../website/out/', import.meta.url)), // `npm run build` output
  // Dev only: { handle(req, res), upgrade(req, socket, head) } from the Next.js dev server.
  // Requests the game client does not serve, and non-/ws upgrades (HMR), go there instead of siteDir.
  website: null,
  // Optional account integration (server/accounts.js): { handleHttp, resolveUpgrade, isMuted?, onModeration? }.
  // When set, /ws requires a verified account unless allowGuests is true.
  accounts: null,
  allowGuests: false,
  // RPG feature installers. undefined = production manifest (server/rpg/features.js); [] isolates.
  features: undefined,
  // Operator-supplied ARENA2 directory (read-only, never served). Exposed to features as ctx.dataPath.
  arena2Dir: null,
  wodPath: null,
  defaultLocation: DEFAULT_LOCATION,
  maxSpeed: 4, // m/s
  tickHz: 25,
  snapshotEveryTicks: 2, // 12.5 Hz snapshots
  stateHeartbeatMs: 1000, // unchanged `state` per location is resent at most this often
  inputTimeoutMs: 400, // stop moving if the client stops refreshing input
  worldHalfExtent: 512, // positions are clamped to [-extent, extent] on x and z
  maxPlayers: 2000, // 0 or Infinity = uncapped single world
  aoiThreshold: 64, // activate spatial AOI culling once a single scene exceeds this many players
  aoiRadius: 128,
  maxVisiblePeers: 64,
  worldBus: null,
  chatLog: null,
  joinTimeoutMs: 10_000,
  saveIntervalMs: 5_000,
  heartbeatMs: 15_000,
  maxPayloadBytes: 4096,
  wsBackpressureBytes: 256 * 1024, // skip transient state frames for slow WAN sockets above 256 KB queued
  wsMaxBufferedBytes: 4 * 1024 * 1024, // disconnect chronically stalled sockets above 4 MB queued
  msgRatePerSec: 40, // token bucket for all messages
  msgBurst: 80,
  chatRatePerSec: 4, // CHAT_LIMITS.local (server/rpg/social/chat.js); 1/s with a burst of 5 was too tight
  chatBurst: 12,
  actionRatePerSec: 10,
  actionBurst: 20,
  accountActionRatePerSec: null, // defaults to actionRatePerSec when null
  accountActionBurst: null, // defaults to actionBurst when null
  maxChatLength: 200,
  maxNameLength: 24,
  maxCharacterSlots: MAX_CHARACTER_SLOTS,
  archiveWindowMs: ARCHIVE_WINDOW_MS,
  archivePurgeIntervalMs: 60_000,
});

// Close codes (4000-4999 are application-defined).
export const CLOSE = Object.freeze({
  SHUTDOWN: 1001,
  POLICY: 1008,
  FULL: 1013,
  REPLACED: 4000,
  PROTOCOL: 4001,
  RATE_LIMIT: 4002,
  INVALID_TOKEN: 4003,
  ACCOUNT: 4004,
});

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _'-]*$/u;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const MAX_API_BODY_BYTES = 4096;

function sendJson(req, res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function sameOriginRequest(req, accounts) {
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (origin === undefined) return site === undefined || site === 'same-origin'; // non-browser clients
  const publicOrigin = accounts?.config?.publicOrigin;
  if (publicOrigin) return origin === publicOrigin;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function isHttpsRequest(req, accounts) {
  if (req.socket?.encrypted) return true;
  return Boolean(accounts?.config?.trustProxy) &&
    String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
}

function readJsonBody(req, limit = MAX_API_BODY_BYTES) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    return Promise.reject(Object.assign(new Error('expected application/json'), { status: 415 }));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooLarge) return;
      size += c.length;
      if (size > limit) {
        tooLarge = true;
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(Object.assign(new Error('invalid JSON'), { status: 400 }));
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return reject(Object.assign(new Error('expected a JSON object'), { status: 400 }));
      }
      resolve(body);
    });
    req.on('error', reject);
  });
}

const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
function wrapAngle(a) {
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  else if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

function bucket(ratePerSec, burst) {
  let tokens = burst;
  let last = performance.now();
  return () => {
    const now = performance.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * ratePerSec);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

export function cleanName(raw, maxLen) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > maxLen || !NAME_RE.test(name)) return null;
  return name;
}

/** Accepts `{id, username}` from accounts.resolveUpgrade; anything else counts as unauthenticated. */
function normalizeAccount(a) {
  if (!a || typeof a !== 'object') return null;
  const id = typeof a.id === 'number' && Number.isSafeInteger(a.id) ? a.id : typeof a.id === 'string' && a.id ? a.id : null;
  if (id === null || String(id).length > 128 || typeof a.username !== 'string' || !a.username) return null;
  const out = { id, username: a.username };
  if (typeof a.sessionKey === 'string' && a.sessionKey) out.sessionKey = a.sessionKey; // opaque, never sent to clients
  return out;
}

/** Resolves the ARENA2 directory and refuses one inside a publicly served root. */
function resolveDataPath(dir, roots) {
  if (!dir) return null;
  const real = realpathSync(resolve(dir));
  if (!statSync(real).isDirectory()) throw new Error(`game data path ${dir} is not a directory`);
  for (const r of roots) {
    let root;
    try {
      root = realpathSync(r);
    } catch {
      continue;
    }
    if (real === root || real.startsWith(root.endsWith(sep) ? root : root + sep)) {
      throw new Error(`game data path must not be inside a publicly served directory (${root})`);
    }
  }
  return real;
}

export function createGameServer(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  if (cfg.dataPath && !cfg.arena2Dir) cfg.arena2Dir = cfg.dataPath;
  cfg.arena2Dir = resolveDataPath(cfg.arena2Dir, [cfg.clientDir, cfg.siteDir]);
  cfg.wodPath = resolveDataPath(cfg.wodPath ?? process.env.WOD_PATH ?? (existsSync(WOD_ROOT) ? WOD_ROOT : null), [cfg.clientDir, cfg.siteDir]);
  const wodAssets = createLocalWodPack(cfg.wodPath);
  const accounts = cfg.accounts || null;
  const store = cfg.store ?? (cfg.openStore ?? openStore)(cfg.dbPath); // store/openStore: PG cutover or test fault injection
  const serveStatic = createSiteHandler({
    clientDir: cfg.clientDir,
    siteDir: cfg.siteDir,
    fallback: cfg.website ? cfg.website.handle : null,
  });
  // Dev convenience (server/local-assets.js): loopback-only same-origin reads of the installed ARENA2.
  // Off unless the caller passes options (server/main.js does); never a static root.
  const localAssets = createLocalAssets(
    cfg.localAssets
      ? { arena2Dir: cfg.arena2Dir, host: cfg.host, publicRoots: [cfg.clientDir, cfg.siteDir], wodAssets, ...cfg.localAssets }
      : { env: { LOCAL_ASSETS: 'off' } },
  );
  // Silent localhost default: the server rules read the same auto-discovered ARENA2 the page uses.
  if (!cfg.arena2Dir && localAssets.enabled) cfg.arena2Dir = localAssets.dir;
  const players = new Map(); // id -> player (only joined, live sessions)
  const sockets = new Set();
  const conns = new Set();
  // Characters whose final save on leave failed: id -> last in-memory state. Retried by persist();
  // a rejoin resumes from this (newer than the DB) and removes it, so it can never overwrite a newer session.
  const orphans = new Map();
  const lastState = new Map(); // player -> { data, at } of the last `state` sent
  const accountActionBuckets = new Map(); // String(accountId) -> { ok, lastUsed }
  const withLocks = createKeyedLock();
  const withAccountLock = (accountId, fn) => withLocks([`acct:${String(accountId)}`], fn);
  const pendingAccountCleanups = new Set(); // String(accountId) for retryable deletion cleanup
  let lastArchivePurgeAt = 0;
  function accountActionOk(accountId) {
    const key = String(accountId);
    const rate = cfg.accountActionRatePerSec ?? cfg.actionRatePerSec;
    const burst = cfg.accountActionBurst ?? cfg.actionBurst;
    let entry = accountActionBuckets.get(key);
    if (!entry) {
      entry = { ok: bucket(rate, burst), lastUsed: 0 };
      accountActionBuckets.set(key, entry);
    }
    entry.lastUsed = performance.now();
    return entry.ok();
  }
  function pruneAccountActionBuckets() {
    if (!accountActionBuckets.size) return;
    const rate = cfg.accountActionRatePerSec ?? cfg.actionRatePerSec;
    const burst = cfg.accountActionBurst ?? cfg.actionBurst;
    const staleMs = Math.ceil((burst / Math.max(rate, 0.001)) * 1000) + 60_000;
    const cutoff = performance.now() - staleMs;
    for (const [k, entry] of accountActionBuckets) {
      if (entry.lastUsed < cutoff) accountActionBuckets.delete(k);
    }
  }
  let tickTimer = null;
  let saveTimer = null;
  let heartbeatTimer = null;
  let tickCount = 0;
  let lastTick = performance.now();
  let closing = null;

  const chatLogStore = cfg.chatLog ?? (store.db ? openSqliteChatLog(store.db) : null);
  const chatLog = chatLogStore ? createChatLogService(chatLogStore) : null;
  const hiscores = cfg.hiscores === false
    ? null
    : (cfg.hiscores ?? createHiscoresService({
      hiscoresStore: cfg.hiscoresStore ?? null,
      gameStore: store,
      accounts,
      trustProxy: !!accounts?.config?.trustProxy,
    }));
  const spatialIndex = createSceneSpatialIndex({ viewRadius: cfg.aoiRadius, maxVisiblePeers: cfg.maxVisiblePeers });

  const runtime = createRpgRuntime({
    players,
    features: cfg.features ?? PRODUCTION_FEATURES,
    save: (list, world = []) => {
      const resolvedWorld = world.map(([k, v]) => [k, typeof v === 'function' ? v() : v]);
      store.saveCharacters(list, resolvedWorld);
      if (hiscores && (list?.length || resolvedWorld.length)) {
        void hiscores.syncPlayers(list, resolvedWorld);
      }
    },
    worldStore: { load: (prefix) => store.loadWorld(prefix) },
    send: (p, msg) => send(p.ws, msg),
    dataPath: cfg.arena2Dir,
    defaultLocation: cfg.defaultLocation,
    config: Object.freeze({
      tickHz: cfg.tickHz,
      maxSpeed: cfg.maxSpeed,
      worldHalfExtent: cfg.worldHalfExtent,
      arena2Dir: cfg.arena2Dir,
      wodPath: cfg.wodPath,
    }),
    services: {
      wodAssets,
      store,
      ...(typeof store.runDurable === 'function' ? { runDurable: (...args) => store.runDurable(...args) } : {}),
      // Moderation hook for chat features (party/regional/global). Guests are never muted here.
      isMuted: (p) => !!(accounts?.isMuted && p?.accountId != null && accounts.isMuted(p.accountId)),
      ...(chatLog ? { logChat: chatLog.logChat, queryChat: chatLog.queryChat, recentChat: chatLog.recentChat } : {}),
      ...(hiscores ? { hiscores } : {}),
    },
  });
  const services = runtime.ctx.services;
  runtime.ctx.isMuted = (p) => services.isMuted(p); // alias used by chat features

  // Uncreated Play-client characters (`conn.arrival === true`) remain in `arriving` staging
  // (hidden from peers, combat, chat, movement, and the public world map) until character creation
  // completes and their starting scene finishes loading.
  const isUncreated = (p) => p?.rpg?.character?.created === false;

  // Mark slot draft complete (and sync name if changed) when character creation finishes.
  runtime.ctx.on?.('characterCreated', ({ player: p } = {}) => {
    if (p && p.conn?.arrival === true) {
      p.arriving = true;
      p.dirty = true;
      broadcastState(true);
      runtime.sync();
    }
    if (!p || p.accountId == null || typeof store.markCharacterDraftComplete !== 'function') return;
    const chosen = cleanName(p.rpg?.character?.name ?? p.name, cfg.maxNameLength);
    Promise.resolve(store.markCharacterDraftComplete(p.accountId, p.id, chosen && chosen !== p.name ? chosen : null))
      .then((updated) => {
        if (updated && updated.name && updated.name !== p.name) {
          p.name = updated.name;
          p.dirty = true;
        }
      })
      .catch((err) => {
        // Non-fatal if chosen name collides with another account; keep reserved slot name and still clear draft.
        if (err instanceof SlotError && err.code === 'NAME_TAKEN') {
          Promise.resolve(store.markCharacterDraftComplete(p.accountId, p.id, null)).catch(() => {});
        }
      });
  });

  const unsubscribeModeration =
    typeof accounts?.onModeration === 'function'
      ? accounts.onModeration(({ accountId, action } = {}) => {
          for (const c of conns) {
            if (c.account && String(c.account.id) === String(accountId)) fatal(c.ws, CLOSE.ACCOUNT, 'account access revoked');
          }
          if (hiscores && (action === 'ban' || action === 'unban')) {
            void hiscores.rebuild();
          }
        })
      : null;
  // Logout ends one session: close only the sockets upgraded with that session's key.
  const unsubscribeSessionEnd =
    typeof accounts?.onSessionEnd === 'function'
      ? accounts.onSessionEnd(({ accountId, sessionKey } = {}) => {
          for (const c of conns) {
            if (!c.account || String(c.account.id) !== String(accountId)) continue;
            if (sessionKey == null || c.account.sessionKey === String(sessionKey)) fatal(c.ws, CLOSE.ACCOUNT, 'signed out');
          }
        })
      : null;
  async function settleCharacterObligationsForPurge(charId, accountId) {
    const id = Number(charId);

    // 1. Run feature-owned purge hooks FIRST (market counterparty refunds, guildhall vault depositor
    //    claims & succession, homes relinquishment, pvp cleanup) so feature-specific state & ledgers
    //    reconcile cleanly before the generic fallback sweep below.
    if (Array.isArray(services.onCharacterPurge)) {
      for (const hook of services.onCharacterPurge) {
        if (typeof hook === 'function') await Promise.resolve(hook({ characterId: id, accountId: String(accountId) }));
      }
    }

    // 2. Generic fallback: settle or return any remaining held counterparty escrow before purging the character.
    if (typeof store.listEscrow === 'function' && typeof store.runDurable === 'function') {
      const held = await store.listEscrow({ involvingCharacterId: id, status: 'held', limit: 200 });
      for (const esc of held) {
        await store.runDurable(
          `purge-escrow:${esc.id}`,
          { accountId: String(accountId), characterId: id, resourceKey: `escrow:${esc.id}`, params: { escrowId: esc.id, purgeChar: id } },
          async (tx) => {
            const cur = await tx.getEscrow(esc.id);
            if (!cur || cur.status !== 'held') return { skipped: true };
            const hasCounterparty = cur.counterpartyCharacterId != null && Number(cur.counterpartyCharacterId) !== id;
            const ownerIsCounterparty = cur.ownerCharacterId != null && Number(cur.ownerCharacterId) !== id;
            const refundTarget = ownerIsCounterparty ? cur.ownerCharacterId : (hasCounterparty ? cur.counterpartyCharacterId : null);
            if (refundTarget != null && (cur.gold > 0 || cur.item != null)) {
              await tx.createClaim({
                ownerCharacterId: refundTarget,
                kind: 'escrow_refund',
                sourceRef: cur.sourceRef ?? cur.id,
                gold: cur.gold,
                item: cur.item,
                reason: 'Counterparty account deleted',
              });
              await tx.updateEscrowStatus(cur.id, cur.revision, 'refunded');
            } else {
              await tx.updateEscrowStatus(cur.id, cur.revision, 'released');
            }
            return { settled: cur.id };
          },
        );
      }
    }

    // 3. Generic fallback: player order leadership succession when guildhall feature is not mounted.
    const orderRows = (await Promise.resolve(store.loadWorld('pguild:'))) ?? [];
    for (const [key, ord] of orderRows) {
      if (!ord || typeof ord !== 'object' || !ord.members || !ord.members[String(id)]) continue;
      const updated = structuredClone(ord);
      delete updated.members[String(id)];
      const remaining = Object.values(updated.members).filter((m) => m && Number.isSafeInteger(m.id));
      if (!remaining.length) {
        await Promise.resolve(store.saveCharacters([], [[key, null]]));
      } else {
        if (Number(updated.leaderId) === id) {
          const rankPriority = (r) => (r === 'Officer' ? 0 : r === 'Member' ? 1 : 2);
          remaining.sort((a, b) => {
            const rp = rankPriority(a.rank) - rankPriority(b.rank);
            if (rp !== 0) return rp;
            const ta = Date.parse(a.joinedAt ?? '') || 0;
            const tb = Date.parse(b.joinedAt ?? '') || 0;
            if (ta !== tb) return ta - tb;
            return Number(a.id) - Number(b.id);
          });
          const successor = remaining[0];
          updated.leaderId = successor.id;
          updated.members[String(successor.id)].rank = 'Leader';
        }
        await Promise.resolve(store.saveCharacters([], [[key, updated]]));
      }
    }
  }

  async function cleanupDeletedAccount(accountId) {
    if (accountId === undefined || accountId === null) return;
    const key = String(accountId);
    accountActionBuckets.delete(key);
    for (const c of conns) {
      if (!c.account || String(c.account.id) !== key) continue;
      const p = c.player;
      if (p && p.conn === c && players.get(p.id) === p) {
        orphans.delete(p.id);
        c.player = null;
        leave(p, { skipSave: true });
      }
      fatal(c.ws, CLOSE.ACCOUNT, 'account deleted');
    }
    return withAccountLock(key, async () => {
      try {
        let rows = [];
        if (typeof store.listByAccount === 'function') {
          rows = (await store.listByAccount(accountId, { includeArchived: true })) ?? [];
        } else {
          const single = await store.findByAccount(accountId);
          if (single) rows = [single];
        }
        for (const r of rows) {
          orphans.delete(r.id);
          await settleCharacterObligationsForPurge(r.id, key);
          if (hiscores) await hiscores.removePlayer(r.id);
        }
        let deletedIds = [];
        if (typeof store.deleteAllForAccount === 'function') {
          deletedIds = (await store.deleteAllForAccount(accountId)) ?? [];
        } else if (typeof store.deleteForAccount === 'function') {
          const deletedId = await store.deleteForAccount(accountId);
          if (deletedId != null) deletedIds = [deletedId];
        } else if (store.db?.isOpen) {
          store.transaction(() => {
            store.db.prepare('DELETE FROM account_characters WHERE account_id = ?').run(key);
            for (const r of rows) store.db.prepare('DELETE FROM players WHERE id = ?').run(r.id);
          });
          deletedIds = rows.map((r) => r.id);
        }
        for (const id of deletedIds) {
          orphans.delete(id);
          if (hiscores) await hiscores.removePlayer(id);
        }
        pendingAccountCleanups.delete(key);
        return deletedIds;
      } catch (err) {
        pendingAccountCleanups.add(key);
        console.error('[game] failed to delete characters for deleted account (will retry):', err?.message ?? err);
      }
    });
  }

  async function runExpiredArchivePurge(at = Date.now()) {
    if (typeof store.purgeExpiredArchived !== 'function') return [];
    try {
      const purged = (await store.purgeExpiredArchived({ at, limit: 25 })) ?? [];
      for (const p of purged) {
        orphans.delete(p.playerId);
        try {
          await settleCharacterObligationsForPurge(p.playerId, p.accountId);
        } catch {}
        if (hiscores) {
          try { await hiscores.removePlayer(p.playerId); } catch {}
        }
      }
      return purged;
    } catch (err) {
      console.error('[game] archive purge failed:', err?.message ?? err);
      return [];
    }
  }

  // Self-deletion (POST /api/delete-account): disconnect every socket and unlink/delete all characters for the account.
  const unsubscribeAccountDelete =
    typeof accounts?.onAccountDelete === 'function'
      ? accounts.onAccountDelete(({ accountId } = {}) => cleanupDeletedAccount(accountId))
      : null;

  function findLivePlayerByAccount(accountId) {
    const key = String(accountId);
    for (const p of players.values()) {
      if (p.accountId != null && String(p.accountId) === key) return p;
    }
    return null;
  }

  function coarseLocationName(rpg) {
    const loc = typeof rpg?.location === 'string' && rpg.location ? rpg.location : cfg.defaultLocation;
    if (!loc) return 'Iliac Bay';
    const looked = services.travel?.lookup?.(loc);
    if (looked?.name) {
      return looked.region ? `${looked.name}, ${looked.region}` : looked.name;
    }
    const m = /^(town|dungeon|interior|wild|sea):([^/]+)\/(.+)$/.exec(loc);
    if (!m) return loc.slice(0, 60);
    const [, kind, region, rest] = m;
    const place = rest.split('/')[0];
    if (kind === 'wild') return `${region} Wilderness`;
    if (kind === 'sea') return 'Iliac Bay (At Sea)';
    if (kind === 'dungeon') return `${place} (${region})`;
    if (kind === 'interior') return `${place}, ${region}`;
    return `${place}, ${region}`;
  }

  function projectRosterEntry(row) {
    const live = players.get(row.id);
    const orphan = !live ? orphans.get(row.id) : null;
    const src = live ?? orphan ?? row;
    const rpg = src.rpg ?? {};
    const ch = rpg.character ?? {};
    const created = ch.created === true;
    return {
      id: row.id,
      slot: row.slot ?? 1,
      name: src.name || row.displayName || row.name,
      status: row.status ?? 'active',
      draft: Boolean(row.draft) && !created,
      created,
      race: created ? (ch.race || 'Unknown') : null,
      className: created ? (ch.className || ch.class || 'Adventurer') : null,
      level: created ? (Number.isFinite(Number(ch.level)) ? Math.max(1, Math.trunc(Number(ch.level))) : 1) : 1,
      location: typeof rpg.location === 'string' ? rpg.location : cfg.defaultLocation,
      locationName: created ? coarseLocationName(rpg) : 'Character Creation',
      lastPlayedAt: row.lastPlayedAt ?? row.linkedAt ?? null,
      lastSelected: Boolean(row.lastSelected),
      online: Boolean(live),
      archivedAt: row.archivedAt ?? null,
      purgeAfter: row.purgeAfter ?? null,
      grandfathered: Boolean(row.grandfathered),
    };
  }

  async function saveAndFlush(list, world = []) {
    if (!list?.length && !world?.length) return;
    await Promise.resolve(store.saveCharacters(list, world));
    if (typeof store.flush === 'function') await store.flush();
    for (const p of list ?? []) p.dirty = false;
    if (hiscores && (list?.length || world?.length)) void hiscores.syncPlayers(list, world);
  }

  async function checkCharacterBlockers(accountId, characterId, kind = 'archive') {
    const blockers = [];
    const id = Number(characterId);
    const live = players.get(id);

    if (live) {
      if (live.rpg?.combat?.inCombat === true || services.inCombat?.(live) || services.pvp?.hasActiveCommitment?.(live)) {
        blockers.push({
          code: 'ACTIVE_COMBAT',
          message: 'Finish your active combat engagement before doing that.',
          route: 'world',
        });
      }
      if (services.tradePartnerOf?.(live) != null) {
        blockers.push({
          code: 'ACTIVE_TRADE',
          message: 'Complete or cancel your active trade before doing that.',
          route: 'social',
        });
      }
      if (services.law?.custody?.(live)) {
        blockers.push({
          code: 'IN_CUSTODY',
          message: 'Resolve your current legal custody before doing that.',
          route: 'world',
        });
      }
      if (kind === 'switch' && live.arriving === true && !isUncreated(live)) {
        blockers.push({
          code: 'ACTIVE_TRANSITION',
          message: 'Wait until your character finishes arriving before switching.',
          route: 'world',
        });
      }
    }

    if (kind === 'archive') {
      if (typeof store.listEscrow === 'function') {
        const held = await store.listEscrow({ ownerCharacterId: id, status: 'held', limit: 1 });
        if (held.length > 0) {
          blockers.push({
            code: 'OPEN_ESCROW',
            message: 'Cancel or settle your open market listings, bids, or escrow before archiving.',
            route: 'market',
          });
        }
      }
      if (typeof store.listClaims === 'function') {
        const claims = await store.listClaims({ ownerCharacterId: id, status: 'pending', limit: 1 });
        if (claims.length > 0) {
          blockers.push({
            code: 'UNSETTLED_CLAIMS',
            message: 'Collect your unsettled claims or proceeds before archiving.',
            route: 'market',
          });
        }
      }
      const visitors = services.homes?.activeVisitorsOf?.(id) ?? live?.rpg?.property?.activeVisitors ?? [];
      if (Array.isArray(visitors) && visitors.length > 0) {
        blockers.push({
          code: 'ACTIVE_HOME_VISITORS',
          message: 'Dismiss active visitors from your home before archiving.',
          route: 'property',
        });
      }
      const orderRows = (await Promise.resolve(store.loadWorld('pguild:'))) ?? [];
      for (const [, ord] of orderRows) {
        if (!ord || typeof ord !== 'object') continue;
        if (Number(ord.leaderId) !== id) continue;
        const memberCount = ord.members ? Object.keys(ord.members).length : 0;
        const hasSharedAssets = memberCount > 1 || Number(ord.treasury ?? 0) > 0 || Boolean(ord.hall) || (Array.isArray(ord.vault) && ord.vault.length > 0);
        if (hasSharedAssets) {
          blockers.push({
            code: 'SOLE_ORDER_LEADER',
            message: `Transfer leadership of ${ord.name || 'your order'} or settle its shared assets before archiving.`,
            route: 'guilds',
          });
          break;
        }
      }
    }

    if (Array.isArray(services.characterBlockers)) {
      const seenCodes = new Set(blockers.map((b) => b.code).filter(Boolean));
      for (const fn of services.characterBlockers) {
        if (typeof fn !== 'function') continue;
        const extra = await Promise.resolve(fn(String(accountId), id, kind));
        if (Array.isArray(extra)) {
          for (const b of extra) {
            if (!b || !b.message) continue;
            if (b.code && seenCodes.has(b.code)) continue;
            if (b.code) seenCodes.add(b.code);
            blockers.push(b);
          }
        }
      }
    }

    return blockers;
  }

  async function listRosterForAccount(accountId) {
    if (typeof store.purgeExpiredArchived === 'function') {
      await store.purgeExpiredArchived({ accountId });
    }
    if (typeof store.listByAccount === 'function') {
      return (await store.listByAccount(accountId, { includeArchived: true })) ?? [];
    }
    const single = await store.findByAccount(accountId);
    return single ? [{ ...single, slot: single.slot ?? 1, status: single.status ?? 'active' }] : [];
  }

  function parseQueryParam(req, key) {
    try {
      const u = new URL(req.url, 'http://localhost');
      return u.searchParams.get(key);
    } catch {
      return null;
    }
  }

  function parseCharacterId(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : NaN;
  }

  function parseUpgradeIntent(req) {
    try {
      const u = new URL(req.url, 'http://localhost');
      const cidRaw = u.searchParams.get('characterId');
      const swRaw = u.searchParams.get('switch');
      const characterId = cidRaw != null && cidRaw !== '' ? parseCharacterId(cidRaw) : null;
      return {
        characterId: Number.isSafeInteger(characterId) ? characterId : null,
        switch: swRaw === '1' || swRaw === 'true',
      };
    } catch {
      return { characterId: null, switch: false };
    }
  }

  function requirePostSecurity(req, res, corp) {
    if (!sameOriginRequest(req, accounts)) {
      sendJson(req, res, 403, { error: 'cross-origin request refused' }, corp);
      return false;
    }
    if (accounts?.config?.secureCookies && accounts?.config?.requireHttps && !isHttpsRequest(req, accounts)) {
      sendJson(req, res, 403, { error: 'HTTPS required' }, corp);
      return false;
    }
    return true;
  }

  async function handleCharactersList(req, res) {
    const corp = { 'Cross-Origin-Resource-Policy': 'same-origin' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD', ...corp });
    }
    try {
      const user = await resolveSessionUser(req);
      if (!user) return sendJson(req, res, 401, { error: 'sign in required' }, corp);
      const roster = await listRosterForAccount(user.id);
      const live = findLivePlayerByAccount(user.id);
      const characters = await Promise.all(roster.map(async (row) => {
        const entry = projectRosterEntry(row);
        if (entry.status === 'active') {
          entry.blockers = await checkCharacterBlockers(user.id, row.id, 'archive');
        } else {
          entry.blockers = [];
        }
        return entry;
      }));
      sendJson(req, res, 200, {
        maxSlots: cfg.maxCharacterSlots,
        archiveWindowMs: cfg.archiveWindowMs,
        activeCharacterId: live ? live.id : null,
        characters,
      }, corp);
    } catch (err) {
      console.error('[game] GET /api/characters failed:', err?.message ?? err);
      if (!res.headersSent) sendJson(req, res, 500, { error: 'internal error' }, corp);
    }
  }

  async function handleCharactersStart(req, res) {
    const corp = { 'Cross-Origin-Resource-Policy': 'same-origin' };
    if (req.method !== 'POST') {
      return sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST', ...corp });
    }
    if (!requirePostSecurity(req, res, corp)) return;
    try {
      const user = await resolveSessionUser(req);
      if (!user) return sendJson(req, res, 401, { error: 'sign in required' }, corp);
      if (!accountActionOk(user.id)) return sendJson(req, res, 429, { error: 'too many requests; slow down' }, corp);
      const body = await readJsonBody(req, accounts?.config?.maxBodyBytes ?? MAX_API_BODY_BYTES);
      const rawSlot = body.slot === undefined || body.slot === null ? null : Number(body.slot);
      if (rawSlot !== null && (!Number.isInteger(rawSlot) || rawSlot < 1 || rawSlot > cfg.maxCharacterSlots)) {
        return sendJson(req, res, 400, { error: `slot must be between 1 and ${cfg.maxCharacterSlots}`, code: 'INVALID_SLOT' }, corp);
      }
      const rawName = body.name === undefined || body.name === null || body.name === '' ? user.username : body.name;
      const name = cleanName(rawName, cfg.maxNameLength);
      if (!name) {
        return sendJson(req, res, 400, {
          error: `invalid name: 1-${cfg.maxNameLength} letters, digits, spaces, _ ' - (must start with a letter or digit)`,
          code: 'INVALID_NAME',
          field: 'name',
        }, corp);
      }
      const opKey = typeof body.opKey === 'string' && body.opKey.trim() ? body.opKey.trim().slice(0, 128) : null;

      const created = await withAccountLock(user.id, async () => {
        if (opKey && typeof store.getDurableOp === 'function' && typeof store.runDurable === 'function') {
          const scope = { accountId: user.id, resourceKey: 'roster:start', params: { slot: rawSlot, name } };
          const existing = await store.getDurableOp(opKey, scope);
          if (existing) {
            // Replay or conflict check through runDurable.
            const replay = await store.runDurable(opKey, scope, () => existing.result);
            return replay.result;
          }
          const row = await store.createCharacterSlot(user.id, user.username, {
            slot: rawSlot,
            name,
            maxSlots: cfg.maxCharacterSlots,
            draft: true,
          });
          const summary = projectRosterEntry(row);
          await store.runDurable(opKey, scope, () => summary);
          return summary;
        }
        const row = await store.createCharacterSlot(user.id, user.username, {
          slot: rawSlot,
          name,
          maxSlots: cfg.maxCharacterSlots,
          draft: true,
        });
        return projectRosterEntry(row);
      });
      return sendJson(req, res, 201, { ok: true, character: created }, corp);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof SlotError || err instanceof DurableConflictError || err?.status) {
        return sendJson(req, res, err.status || 409, { error: err.message, code: err.code }, corp);
      }
      console.error('[game] POST /api/characters/start failed:', err?.message ?? err);
      sendJson(req, res, 500, { error: 'internal error' }, corp);
    }
  }

  async function handleCharactersArchive(req, res) {
    const corp = { 'Cross-Origin-Resource-Policy': 'same-origin' };
    if (req.method !== 'POST') {
      return sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST', ...corp });
    }
    if (!requirePostSecurity(req, res, corp)) return;
    try {
      const user = await resolveSessionUser(req);
      if (!user) return sendJson(req, res, 401, { error: 'sign in required' }, corp);
      if (!accountActionOk(user.id)) return sendJson(req, res, 429, { error: 'too many requests; slow down' }, corp);
      const body = await readJsonBody(req, accounts?.config?.maxBodyBytes ?? MAX_API_BODY_BYTES);
      const characterId = parseCharacterId(body.characterId);
      if (!Number.isSafeInteger(characterId)) {
        return sendJson(req, res, 400, { error: 'valid characterId is required', code: 'INVALID_CHARACTER_ID' }, corp);
      }
      const confirmName = typeof body.confirmName === 'string' ? body.confirmName.trim() : '';

      const out = await withAccountLock(user.id, async () => {
        const row = typeof store.findAccountCharacter === 'function'
          ? await store.findAccountCharacter(user.id, characterId)
          : null;
        if (!row) throw new SlotError('NOT_FOUND', 'Character not found.', 404);
        if (row.status !== 'active') throw new SlotError('INVALID_STATE', 'Character is already archived.', 409);
        const expectedName = (players.get(row.id)?.name || row.displayName || row.name).trim();
        if (!confirmName || confirmName !== expectedName) {
          throw new SlotError('CONFIRM_NAME_MISMATCH', `Type "${expectedName}" to confirm archiving this character.`, 400);
        }
        const blockers = await checkCharacterBlockers(user.id, characterId, 'archive');
        if (blockers.length > 0) {
          const err = new SlotError('ARCHIVE_BLOCKED', blockers[0].message, 409);
          err.blockers = blockers;
          throw err;
        }
        // If this character is currently online, save & leave safely first (retiring active party/invites).
        const live = players.get(characterId);
        if (live) {
          await saveAndFlush([live]);
          const oldConn = live.conn;
          if (oldConn) {
            oldConn.replaced = true;
            oldConn.player = null;
            fatal(oldConn.ws, CLOSE.ACCOUNT, 'character archived');
          }
          leave(live);
          if (typeof store.flush === 'function') await store.flush();
        }
        const archived = await store.archiveCharacter(user.id, characterId, { archiveWindowMs: cfg.archiveWindowMs });
        if (hiscores) await hiscores.removePlayer(characterId);
        return projectRosterEntry(archived);
      });
      return sendJson(req, res, 200, { ok: true, character: out }, corp);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof SlotError || err instanceof DurableConflictError || err?.status) {
        return sendJson(req, res, err.status || 409, {
          error: err.message,
          code: err.code,
          ...(err.blockers ? { blockers: err.blockers } : {}),
        }, corp);
      }
      console.error('[game] POST /api/characters/archive failed:', err?.message ?? err);
      sendJson(req, res, 500, { error: 'internal error' }, corp);
    }
  }

  async function handleCharactersRestore(req, res) {
    const corp = { 'Cross-Origin-Resource-Policy': 'same-origin' };
    if (req.method !== 'POST') {
      return sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST', ...corp });
    }
    if (!requirePostSecurity(req, res, corp)) return;
    try {
      const user = await resolveSessionUser(req);
      if (!user) return sendJson(req, res, 401, { error: 'sign in required' }, corp);
      if (!accountActionOk(user.id)) return sendJson(req, res, 429, { error: 'too many requests; slow down' }, corp);
      const body = await readJsonBody(req, accounts?.config?.maxBodyBytes ?? MAX_API_BODY_BYTES);
      const characterId = parseCharacterId(body.characterId);
      if (!Number.isSafeInteger(characterId)) {
        return sendJson(req, res, 400, { error: 'valid characterId is required', code: 'INVALID_CHARACTER_ID' }, corp);
      }
      const restored = await withAccountLock(user.id, async () => {
        const row = await store.restoreCharacter(user.id, characterId);
        if (hiscores && row.rpg?.character?.created && row.rpg?.chronicles?.hidden !== true) {
          await hiscores.syncPlayer({ id: row.id, name: row.name, rpg: row.rpg, accountId: user.id });
          hiscores.invalidate?.();
        }
        return projectRosterEntry(row);
      });
      return sendJson(req, res, 200, { ok: true, character: restored }, corp);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof SlotError || err instanceof DurableConflictError || err?.status) {
        return sendJson(req, res, err.status || 409, { error: err.message, code: err.code }, corp);
      }
      console.error('[game] POST /api/characters/restore failed:', err?.message ?? err);
      sendJson(req, res, 500, { error: 'internal error' }, corp);
    }
  }

  async function handleCharactersSelect(req, res) {
    const corp = { 'Cross-Origin-Resource-Policy': 'same-origin' };
    if (req.method !== 'POST') {
      return sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST', ...corp });
    }
    if (!requirePostSecurity(req, res, corp)) return;
    try {
      const user = await resolveSessionUser(req);
      if (!user) return sendJson(req, res, 401, { error: 'sign in required' }, corp);
      const body = await readJsonBody(req, accounts?.config?.maxBodyBytes ?? MAX_API_BODY_BYTES);
      const characterId = parseCharacterId(body.characterId);
      if (!Number.isSafeInteger(characterId)) {
        return sendJson(req, res, 400, { error: 'valid characterId is required', code: 'INVALID_CHARACTER_ID' }, corp);
      }
      const selected = await withAccountLock(user.id, async () => {
        const row = await store.selectCharacter(user.id, characterId);
        return projectRosterEntry(row);
      });
      return sendJson(req, res, 200, { ok: true, character: selected }, corp);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof SlotError || err?.status) {
        return sendJson(req, res, err.status || 409, { error: err.message, code: err.code }, corp);
      }
      console.error('[game] POST /api/characters/select failed:', err?.message ?? err);
      sendJson(req, res, 500, { error: 'internal error' }, corp);
    }
  }

  async function resolveSessionUser(req) {
    if (!accounts || typeof accounts.sessionUser !== 'function') return null;
    try {
      const u = await accounts.sessionUser(req);
      if (!u || typeof u !== 'object') return null;
      const id = typeof u.id === 'number' && Number.isSafeInteger(u.id)
        ? u.id
        : typeof u.id === 'string' && u.id
          ? u.id
          : null;
      if (id === null || typeof u.username !== 'string' || !u.username) return null;
      return { id, username: u.username };
    } catch {
      return null;
    }
  }

  async function handleHealthz(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
    }
    let ok = !closing;
    if (ok && accounts && typeof accounts.healthy === 'function') {
      try {
        ok = Boolean(await accounts.healthy());
      } catch {
        ok = false;
      }
    }
    sendJson(req, res, ok ? 200 : 503, { ok });
  }

  function handlePublicStatus(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
    }
    try {
      const mapExtra = {
        ...(cfg.worldBus ? { worldBus: cfg.worldBus } : {}),
        ...(services.worldClock ? { worldClock: services.worldClock } : {}),
      };
      const snap = publicWorldMap(players.values(), services.travel?.lookup, Date.now(), services.sailing, mapExtra);
      const maxPlayers = cfg.maxPlayers === 0 || !Number.isFinite(cfg.maxPlayers) || cfg.maxPlayers < 0
        ? null
        : cfg.maxPlayers;
      sendJson(req, res, 200, {
        ok: true,
        online: snap.online,
        vessels: snap.vessels,
        maxPlayers,
        worldTime: snap.worldTime ?? null,
      });
    } catch (err) {
      console.error('[game] status request failed:', err?.message ?? err);
      sendJson(req, res, 500, { error: 'unavailable' });
    }
  }

  async function handleMeCharacter(req, res) {
    const corp = { 'Cross-Origin-Resource-Policy': 'same-origin' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD', ...corp });
    }
    try {
      const user = await resolveSessionUser(req);
      if (!user) return sendJson(req, res, 401, { error: 'sign in required' }, corp);

      const requestedId = parseCharacterId(parseQueryParam(req, 'characterId'));
      let charRow = null;
      if (Number.isSafeInteger(requestedId)) {
        const owned = typeof store.findAccountCharacter === 'function'
          ? await store.findAccountCharacter(user.id, requestedId)
          : null;
        if (owned && owned.status === 'active') {
          charRow = players.get(owned.id) ?? orphans.get(owned.id) ?? owned;
        }
      } else {
        charRow = findLivePlayerByAccount(user.id);
        if (!charRow) {
          const stored = await store.findByAccount(user.id);
          if (stored) charRow = orphans.get(stored.id) ?? stored;
        }
      }
      if (!charRow || !charRow.rpg?.character?.created) {
        return sendJson(req, res, 200, { character: null }, corp);
      }

      const rpg = charRow.rpg;
      const chroniclesHidden = rpg?.chronicles?.hidden === true;
      const projectionRow = {
        id: charRow.id,
        name: charRow.name,
        accountId: user.id,
        rpg: chroniclesHidden
          ? { ...rpg, chronicles: { ...(rpg.chronicles ?? {}), hidden: false } }
          : rpg,
      };
      const projected = projectCharacter(projectionRow, { requireCreated: true });
      if (!projected) return sendJson(req, res, 200, { character: null }, corp);

      let overallRank = null;
      let levelRank = null;
      if (!chroniclesHidden && hiscores && typeof hiscores.getPlayer === 'function') {
        try {
          const profile = await hiscores.getPlayer(projected.name);
          overallRank = profile?.summary?.overallRank ?? null;
          levelRank = profile?.summary?.levelRank ?? null;
        } catch {
          // Non-fatal: omit ranks when hiscores is temporarily unavailable.
        }
      }

      sendJson(req, res, 200, {
        character: {
          name: projected.name,
          race: projected.race,
          className: projected.className,
          level: projected.level,
          totalSkill: projected.totalSkill,
          placesDiscovered: projected.placesDiscovered,
          totalClassicPlaces: TOTAL_CLASSIC_PLACES,
          questsCompleted: projected.questsCompleted,
          monstersSlain: projected.monstersSlain,
          guilds: projected.guilds,
          order: projected.order,
          chroniclesHidden,
          overallRank,
          levelRank,
        },
      }, corp);
    } catch (err) {
      console.error('[game] /api/me/character failed:', err?.message ?? err);
      if (!res.headersSent) sendJson(req, res, 500, { error: 'internal error' }, corp);
    }
  }

  async function handleMeChroniclesPrivacy(req, res) {
    const corp = { 'Cross-Origin-Resource-Policy': 'same-origin' };
    if (req.method !== 'POST') {
      return sendJson(req, res, 405, { error: 'method not allowed' }, { Allow: 'POST', ...corp });
    }
    try {
      if (!sameOriginRequest(req, accounts)) {
        return sendJson(req, res, 403, { error: 'cross-origin request refused' }, corp);
      }
      if (accounts?.config?.secureCookies && accounts?.config?.requireHttps && !isHttpsRequest(req, accounts)) {
        return sendJson(req, res, 403, { error: 'HTTPS required' }, corp);
      }
      const user = await resolveSessionUser(req);
      if (!user) return sendJson(req, res, 401, { error: 'sign in required' }, corp);

      const body = await readJsonBody(req, accounts?.config?.maxBodyBytes ?? MAX_API_BODY_BYTES);
      if (typeof body.hidden !== 'boolean') {
        return sendJson(req, res, 400, { error: 'hidden must be a boolean' }, corp);
      }
      const hidden = Boolean(body.hidden);
      const ts = Date.now();

      const live = findLivePlayerByAccount(user.id);
      if (live) {
        if (!live.rpg?.character?.created) {
          return sendJson(req, res, 404, { error: 'no created character' }, corp);
        }
        if (!live.rpg.chronicles || typeof live.rpg.chronicles !== 'object' || Array.isArray(live.rpg.chronicles)) {
          live.rpg.chronicles = {};
        }
        live.rpg.chronicles.hidden = hidden;
        live.rpg.chronicles.updatedAt = ts;
        live.dirty = true;
        await Promise.resolve(store.saveCharacters([live]));
        live.dirty = false;
        if (hiscores) {
          await hiscores.syncPlayer(live);
          hiscores.invalidate();
        }
        try {
          runtime.sync();
        } catch {}
        return sendJson(req, res, 200, { ok: true, hidden }, corp);
      }

      const stored = await store.findByAccount(user.id);
      const target = stored ? (orphans.get(stored.id) ?? stored) : null;
      if (!target || !target.rpg?.character?.created) {
        return sendJson(req, res, 404, { error: 'no created character' }, corp);
      }
      if (!target.rpg.chronicles || typeof target.rpg.chronicles !== 'object' || Array.isArray(target.rpg.chronicles)) {
        target.rpg.chronicles = {};
      }
      target.rpg.chronicles.hidden = hidden;
      target.rpg.chronicles.updatedAt = ts;
      await Promise.resolve(store.saveCharacters([target]));
      if (orphans.get(target.id) === target) orphans.delete(target.id);
      if (hiscores) {
        await hiscores.syncPlayer({
          id: target.id,
          name: target.name,
          rpg: target.rpg,
          accountId: user.id,
        });
        hiscores.invalidate();
      }
      return sendJson(req, res, 200, { ok: true, hidden }, corp);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err?.status) return sendJson(req, res, err.status, { error: err.message }, corp);
      console.error('[game] /api/me/chronicles-privacy failed:', err?.message ?? err);
      sendJson(req, res, 500, { error: 'internal error' }, corp);
    }
  }

  const http = createServer((req, res) => {
    const path = String(req.url ?? '').split('?')[0];
    if (path === '/healthz') {
      Promise.resolve()
        .then(() => handleHealthz(req, res))
        .catch((err) => {
          console.error('[game] /healthz failed:', err?.message ?? err);
          if (!res.headersSent) sendJson(req, res, 503, { ok: false });
        });
      return;
    }
    if (path === '/api/status') {
      return handlePublicStatus(req, res);
    }
    if (path === '/api/characters') {
      void handleCharactersList(req, res);
      return;
    }
    if (path === '/api/characters/start') {
      void handleCharactersStart(req, res);
      return;
    }
    if (path === '/api/characters/archive') {
      void handleCharactersArchive(req, res);
      return;
    }
    if (path === '/api/characters/restore') {
      void handleCharactersRestore(req, res);
      return;
    }
    if (path === '/api/characters/select') {
      void handleCharactersSelect(req, res);
      return;
    }
    if (path === '/api/me/character') {
      void handleMeCharacter(req, res);
      return;
    }
    if (path === '/api/me/chronicles-privacy') {
      void handleMeChroniclesPrivacy(req, res);
      return;
    }
    if (path === PUBLIC_MAP_PATH) {
      const mapExtra = {
        ...(cfg.worldBus ? { worldBus: cfg.worldBus } : {}),
        ...(services.worldClock ? { worldClock: services.worldClock } : {}),
      };
      return handlePublicWorldMap(req, res, players, services.travel, services.sailing, mapExtra);
    }
    if (path === PUBLIC_MAP_POIS_PATH) {
      return handlePublicWorldPois(req, res, services.travel);
    }
    if (hiscores && isHiscoresPath(path)) {
      Promise.resolve()
        .then(() => hiscores.handleHttp(req, res))
        .catch((err) => {
          console.error('[game] hiscores request failed:', err);
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"hiscores unavailable"}');
        });
      return;
    }
    if (path === WORLDDATA_PATH || path.startsWith(WORLDDATA_PATH + '/')) {
      handleWorldDataHttp(services.worldData?.ready, req, res);
      return;
    }
    if (path === WILDERNESS_SCENE_PATH) {
      handleWildernessScene(services.wilderness, req, res);
      return;
    }
    if (localAssets.owns(path)) {
      localAssets.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
      return;
    }
    if (accounts && (path === '/api' || path.startsWith('/api/'))) {
      Promise.resolve()
        .then(() => accounts.handleHttp(req, res))
        .catch((err) => {
          console.error('[game] accounts request failed:', err);
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"internal error"}');
        });
      return;
    }
    if (path === '/ws') {
      res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8', Upgrade: 'websocket' });
      return res.end('Upgrade Required');
    }
    serveStatic(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  http.headersTimeout = 10_000;
  http.requestTimeout = 15_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxPayloadBytes, perMessageDeflate: false });

  http.on('upgrade', (req, socket, head) => {
    const reject = (status, text) => {
      if (!socket.destroyed) {
        socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      }
    };
    if (closing) return reject(503, 'Service Unavailable');
    if (req.url.split('?')[0] !== '/ws') {
      if (cfg.website?.upgrade) return cfg.website.upgrade(req, socket, head); // Next.js HMR in dev
      return reject(404, 'Not Found');
    }
    // Same-origin only for browsers. Non-browser clients (no Origin header) are allowed.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      let ok = false;
      try {
        ok = new URL(origin).host === req.headers.host;
      } catch {}
      if (!ok) return reject(403, 'Forbidden');
    }
    const upgradeIntent = parseUpgradeIntent(req);
    if (!accounts) {
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, null, upgradeIntent));
      return;
    }
    Promise.resolve()
      .then(() => accounts.resolveUpgrade(req))
      .then(
        (resolved) => normalizeAccount(resolved),
        (err) => {
          console.error('[game] account lookup failed:', err?.message ?? err);
          return null;
        },
      )
      .then((account) => {
        if (socket.destroyed) return;
        if (closing) return reject(503, 'Service Unavailable');
        if (!account && !cfg.allowGuests) return reject(401, 'Unauthorized');
        wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, account, upgradeIntent));
      })
      .catch((err) => {
        console.error('[game] upgrade failed:', err?.message ?? err);
        reject(500, 'Internal Server Error');
      });
  });

  function send(ws, msg) {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function sendError(ws, message, extra) {
    send(ws, { type: 'error', message, ...extra });
  }

  function fatal(ws, code, message) {
    sendError(ws, message);
    ws.close(code, message.slice(0, 120));
  }

  function publicPlayer(p) {
    const out = { id: p.id, name: p.name, x: r3(p.x), z: r3(p.z), yaw: r3(p.yaw), moving: p.moving };
    // Vertical position and stance from the locomotion step (server/rpg/collision.js); absent without it.
    if (typeof services.bodyView === 'function') {
      try { Object.assign(out, services.bodyView(p)); } catch {}
    }
    return out;
  }

  // `state` goes to each location's occupants, plus outdoor players just across a town gate or
  // map-pixel edge (server/rpg/peers.js, projected into the viewer's frame and marked `across`).
  // A message is sent only when it changed or the heartbeat is due.
  //
  // Clients that join with `delta: true` (client/lib/net.js) get the same roster as `stateDelta` frames:
  // `players` holds new entries in full and, for known ids, only the fields that changed; `gone` lists ids
  // that left (an id in both `gone` and `players` is replaced, e.g. when a field disappears). A full `state`
  // still starts every new socket and location, and is resent on `force` and on the idle heartbeat.
  function broadcastState(force = false) {
    const groups = new Map();
    // Grouped by presence scene: crews sharing one classic ship deck are separate scenes (server/rpg/sailing.js).
    const sceneOf = runtime.sceneOf ?? runtime.locationOf;
    for (const p of players.values()) {
      const scene = sceneOf(p);
      if (!groups.has(scene)) groups.set(scene, []);
      groups.get(scene).push(p);
    }
    const now = performance.now();
    const view = services.peerView;
    const pub = new Map(); // each player's public entry, built once per broadcast
    const publicOf = (q) => {
      let o = pub.get(q);
      if (!o) pub.set(q, (o = publicPlayer(q)));
      return o;
    };
    for (const q of lastState.keys()) if (players.get(q.id) !== q) lastState.delete(q);
    for (const [scene, group] of groups) {
      const loc = runtime.locationOf(group[0]);
      // A player still on their loading screen (`arriving`) sees themselves, but nobody else sees them yet.
      const visibleGroup = group.filter((q) => !q.arriving);
      const useAoi = cfg.aoiThreshold > 0 && visibleGroup.length > cfg.aoiThreshold;
      if (useAoi) {
        const activeIds = new Set();
        for (const q of visibleGroup) {
          activeIds.add(q.id);
          spatialIndex.upsert(scene, q);
        }
        const grid = spatialIndex.gridOf(scene);
        if (grid && grid.size > activeIds.size) {
          for (const id of [...grid.ids()]) if (!activeIds.has(id)) spatialIndex.remove(id);
        }
      }
      const local = useAoi ? null : visibleGroup.map(publicOf);
      let shared = null;
      for (const p of group) {
        const across = view ? view.across(p) : [];
        let mine;
        if (useAoi) {
          // Party members and the trade partner stay visible past the crowd cap and the radius.
          const priorityIds = [...(services.partyOf?.(p)?.memberIds ?? []), services.tradePartnerOf?.(p) ?? p.id];
          const nearby = spatialIndex.query(scene, p, { priorityIds });
          mine = [publicOf(p), ...nearby.map(publicOf)];
        } else {
          mine = p.arriving ? local.concat(publicOf(p)) : local;
        }
        const list = across.length
          ? mine.concat(across.map(({ player, x, z }) => ({ ...publicOf(player), x: r3(x), z: r3(z), across: true })))
          : mine;
        const full = () => (!useAoi && list === local ? (shared ??= stateData(loc, local)) : stateData(loc, list));
        const prev = lastState.get(p);
        if (p.delta) {
          // The same socket still shows this location: send what changed, if anything.
          const known = !force && prev?.ws === p.ws && prev.location === loc;
          let data = known ? deltaData(loc, prev.sent, list) : null;
          if (!data) {
            if (known && now - prev.at < cfg.stateHeartbeatMs) continue;
            data = full();
          }
          if (p.ws.readyState === p.ws.OPEN) {
            if (p.ws.bufferedAmount > cfg.wsMaxBufferedBytes) {
              fatal(p.ws, CLOSE.RATE_LIMIT, 'connection too slow');
              continue;
            }
            if (p.ws.bufferedAmount > cfg.wsBackpressureBytes) continue;
            lastState.set(p, { ws: p.ws, location: loc, sent: new Map(list.map((o) => [o.id, o])), at: now });
            p.ws.send(data);
          }
          continue;
        }
        const data = full();
        if (!force && prev && prev.data === data && now - prev.at < cfg.stateHeartbeatMs) continue;
        if (p.ws.readyState === p.ws.OPEN) {
          if (p.ws.bufferedAmount > cfg.wsMaxBufferedBytes) {
            fatal(p.ws, CLOSE.RATE_LIMIT, 'connection too slow');
            continue;
          }
          if (p.ws.bufferedAmount > cfg.wsBackpressureBytes) continue;
          lastState.set(p, { data, at: now });
          p.ws.send(data);
        }
      }
    }
  }

  const stateData = (location, players) => JSON.stringify({ type: 'state', location, players });

  /** `stateDelta` from the entries last sent to a viewer to `list`, or null when nothing changed. */
  function deltaData(location, sent, list) {
    const changed = [];
    const gone = [];
    const ids = new Set();
    for (const o of list) {
      ids.add(o.id);
      const old = sent.get(o.id);
      if (old === o) continue;
      if (!old) {
        changed.push(o);
        continue;
      }
      if (Object.keys(old).some((k) => !(k in o))) {
        gone.push(o.id); // a field disappeared: replace the whole entry
        changed.push(o);
        continue;
      }
      let d = null;
      for (const k in o) if (o[k] !== old[k]) (d ??= { id: o.id })[k] = o[k];
      if (d) changed.push(d);
    }
    for (const id of sent.keys()) if (!ids.has(id)) gone.push(id);
    if (!changed.length && !gone.length) return null;
    return JSON.stringify(gone.length ? { type: 'stateDelta', location, players: changed, gone } : { type: 'stateDelta', location, players: changed });
  }

  function saveNow(list) {
    store.saveCharacters(list);
    for (const p of list) p.dirty = false;
    if (hiscores && list?.length) void hiscores.syncPlayers(list);
  }

  function persist(list) {
    for (const [id, o] of orphans) if (players.has(id) && players.get(id) !== o) orphans.delete(id);
    const dirty = [...new Set([...list.filter((p) => p.dirty), ...orphans.values()])];
    const world = runtime.takePendingWorld?.() ?? [];
    if (!dirty.length && !world.length) return;
    try {
      const resolvedWorld = world.map(([k, v]) => [k, typeof v === 'function' ? v() : v]);
      store.saveCharacters(dirty, resolvedWorld);
      for (const p of dirty) p.dirty = false;
      for (const o of dirty) if (orphans.get(o.id) === o) orphans.delete(o.id);
      if (hiscores) void hiscores.syncPlayers(dirty, resolvedWorld);
    } catch (err) {
      runtime.restorePendingWorld?.(world);
      console.error('[game] failed to save characters:', err.message);
    }
  }

  function tick() {
    const now = performance.now();
    const dt = Math.min((now - lastTick) / 1000, 0.25); // clamp after stalls
    lastTick = now;
    const ext = cfg.worldHalfExtent;
    for (const p of players.values()) {
      if (services.law?.custody?.(p)) {
        p.moving = false;
        continue;
      }
      if (typeof services.stepPlayer === 'function') {
        stepWithLocomotion(p, now, dt, ext);
        continue;
      }
      const active = now - p.inputAt <= cfg.inputTimeoutMs && (p.forward !== 0 || p.strafe !== 0);
      if (!active) {
        p.moving = false;
        continue;
      }
      // yaw = 0 faces -z; positive yaw turns right (toward +x).
      const s = Math.sin(p.yaw);
      const c = Math.cos(p.yaw);
      let vx = s * p.forward + c * p.strafe;
      let vz = -c * p.forward + s * p.strafe;
      const len = Math.hypot(vx, vz);
      if (len > 1) {
        vx /= len;
        vz /= len;
      }
      // A feature may change a player's ground speed (server/rpg/mount.js: on horseback).
      let speed = cfg.maxSpeed;
      if (typeof services.moveSpeed === 'function') {
        try {
          const v = services.moveSpeed(p);
          if (Number.isFinite(v) && v > 0) speed = Math.min(v, cfg.maxSpeed * 4);
        } catch (err) {
          console.error('[game] moveSpeed failed:', err.message);
        }
      }
      let nx = clamp(p.x + vx * speed * dt, -ext, ext);
      let nz = clamp(p.z + vz * speed * dt, -ext, ext);
      // Operator geometry (collision, area bounds) may adjust the proposed position.
      if (typeof services.movePlayer === 'function') {
        try {
          const m = services.movePlayer(p, nx, nz);
          if (m && Number.isFinite(m.x) && Number.isFinite(m.z)) {
            nx = clamp(m.x, -ext, ext);
            nz = clamp(m.z, -ext, ext);
          } else {
            nx = p.x;
            nz = p.z;
          }
        } catch (err) {
          console.error('[game] movePlayer failed:', err.message);
          nx = p.x;
          nz = p.z;
        }
      }
      p.moving = nx !== p.x || nz !== p.z;
      if (p.moving) {
        p.x = nx;
        p.z = nz;
        p.dirty = true;
      }
    }
    runtime.tick(dt, now);
    if (++tickCount % cfg.snapshotEveryTicks === 0 && players.size) {
      broadcastState();
      runtime.sync();
    }
  }

  // Full locomotion (gravity, jumping, climbing, swimming, stances) runs every tick, also without input,
  // so a falling or swimming body keeps moving. Stale input (client stopped refreshing) counts as released keys.
  function stepWithLocomotion(p, now, dt, ext) {
    const fresh = now - p.inputAt <= cfg.inputTimeoutMs;
    const input = {
      forward: fresh ? p.forward : 0,
      strafe: fresh ? p.strafe : 0,
      yaw: p.yaw,
      run: fresh && !!p.run,
      slow: fresh && !!p.slow,
      crouch: !!p.crouch, // a stance persists between messages
      rise: fresh ? p.rise ?? 0 : 0,
      jumpSeq: p.jumpSeq,
    };
    let speed;
    if (typeof services.moveSpeed === 'function') {
      try {
        const v = services.moveSpeed(p);
        if (Number.isFinite(v) && v > 0) speed = Math.min(v, cfg.maxSpeed * 4);
      } catch (err) {
        console.error('[game] moveSpeed failed:', err.message);
      }
    }
    let m;
    try {
      m = services.stepPlayer(p, input, dt, speed);
    } catch (err) {
      console.error('[game] stepPlayer failed:', err.message);
      m = null;
    }
    const nx = m && Number.isFinite(m.x) ? clamp(m.x, -ext, ext) : p.x;
    const nz = m && Number.isFinite(m.z) ? clamp(m.z, -ext, ext) : p.z;
    p.moving = nx !== p.x || nz !== p.z;
    if (p.moving) {
      p.x = nx;
      p.z = nz;
      p.dirty = true;
    }
  }

  function onConnection(ws, account, upgradeIntent = null) {
    sockets.add(ws);
    ws.isAlive = true;
    const conn = {
      ws,
      account,
      upgradeIntent,
      player: null,
      joining: false,
      switching: false,
      replaced: false,
      msgOk: bucket(cfg.msgRatePerSec, cfg.msgBurst),
      actionOk: bucket(cfg.actionRatePerSec, cfg.actionBurst),
      drops: 0,
      joinTimer: null,
    };
    conns.add(conn);
    conn.joinTimer = setTimeout(() => {
      if (!conn.player && !conn.replaced) fatal(ws, CLOSE.PROTOCOL, 'join timeout');
    }, cfg.joinTimeoutMs);

    ws.on('pong', () => (ws.isAlive = true));
    ws.on('error', () => {}); // e.g. oversize payload; 'close' follows
    ws.on('close', () => {
      clearTimeout(conn.joinTimer);
      sockets.delete(ws);
      conns.delete(conn);
      const p = conn.player;
      conn.player = null;
      if (p && p.conn === conn && players.get(p.id) === p) leave(p);
    });

    ws.on('message', (data, isBinary) => {
      if (conn.replaced) return;
      if (!conn.msgOk()) {
        if (++conn.drops > cfg.msgBurst) return fatal(ws, CLOSE.RATE_LIMIT, 'rate limit exceeded');
        return; // silently drop small overages
      }
      conn.drops = 0;
      if (isBinary) return sendError(ws, 'binary messages are not supported');
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return sendError(ws, 'invalid JSON');
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
        return sendError(ws, 'message must be an object with a string type');
      }
      if (!conn.player) {
        if (msg.type !== 'join') return sendError(ws, 'join first');
        if (conn.joining) return;
        handleJoin(conn, msg).catch((err) => {
          console.error('[game] join failed:', err?.message ?? err);
          if (ws.readyState === ws.OPEN) fatal(ws, CLOSE.POLICY, 'join failed');
        });
        return;
      }
      switch (msg.type) {
        case 'input':
          return handleInput(conn, msg);
        case 'chat':
          return handleChat(conn, msg);
        case 'action':
          return handleAction(conn, msg);
        case 'arrived':
          return handleArrived(conn);
        case 'switch':
          if (conn.switching) return;
          handleSwitch(conn, msg).catch((err) => {
            console.error('[game] switch failed:', err?.message ?? err);
            if (ws.readyState === ws.OPEN) sendError(ws, 'character switch failed', { code: 'SWITCH_FAILED' });
          });
          return;
        case 'join':
          return sendError(ws, 'already joined');
        default:
          return sendError(ws, `unknown message type`);
      }
    });
  }

  function leave(p, { skipSave = false } = {}) {
    let toSave = [p];
    try {
      toSave = runtime.leave(p);
    } catch (err) {
      console.error('[game] leave failed:', err);
    }
    players.delete(p.id);
    const saveList = skipSave ? toSave.filter((q) => q !== p) : toSave;
    if (saveList.length) {
      try {
        saveNow(saveList);
      } catch (err) {
        console.error('[game] failed to save on leave:', err.message);
        for (const q of saveList) {
          if (q === p) orphans.set(p.id, p);
          else q.dirty = true;
        }
      }
    }
    if (!closing) {
      broadcastState(true);
      runtime.sync();
    }
  }

  async function loadCharacter(ws, fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CorruptCharacterError) {
        console.error('[game]', err.message);
        fatal(ws, CLOSE.POLICY, 'character data unavailable');
        return undefined;
      }
      throw err;
    }
  }

  function serverFull() {
    const limit = cfg.maxPlayers === 0 ? Number.POSITIVE_INFINITY : cfg.maxPlayers;
    return players.size >= limit;
  }

  async function handleJoin(conn, msg) {
    const { ws } = conn;
    if (conn.joining || conn.player || conn.replaced || ws.readyState !== ws.OPEN) return;
    conn.joining = true;
    try {
      // `arrival: true`: the client holds a loading screen after the welcome and sends {type:'arrived'} once its
      // place is complete (client/main.js). Until then others do not see this player and monsters ignore them.
      conn.arrival = msg.arrival === true;
      // `delta: true`: the client applies `stateDelta` frames and merges partial `rpg` snapshots (client/lib/net.js).
      conn.delta = msg.delta === true;
      // `patch: true`: the client also merges `peerDelta` and `entityDelta.patch` (client/gameplay/api.js mergeRpg).
      conn.patch = msg.patch === true;
      if (conn.account) await joinAccount(conn, msg);
      else await joinGuest(conn, msg);
    } finally {
      conn.joining = false;
    }
  }

  function handleArrived(conn) {
    const p = conn.player;
    if (!p.arriving || isUncreated(p)) return;
    p.arriving = false;
    broadcastState(true);
    runtime.sync();
  }

  async function joinGuest(conn, msg) {
    const { ws } = conn;
    let row;
    let token;
    if (msg.token !== undefined && msg.token !== null) {
      row = typeof msg.token === 'string' && TOKEN_RE.test(msg.token) ? await loadCharacter(ws, () => store.findByToken(msg.token)) : null;
      if (row === undefined) return;
      if (conn.player || conn.replaced || ws.readyState !== ws.OPEN || closing) return;
      if (!row) return fatal(ws, CLOSE.INVALID_TOKEN, 'invalid token');
      token = msg.token;
    } else {
      const name = cleanName(msg.name, cfg.maxNameLength);
      if (!name) {
        return sendError(
          ws,
          `invalid name: 1-${cfg.maxNameLength} letters, digits, spaces, _ ' - (must start with a letter or digit)`
        );
      }
      if (serverFull()) return fatal(ws, CLOSE.FULL, 'server full');
      ({ row, token } = await store.create(name));
      if (conn.player || conn.replaced || ws.readyState !== ws.OPEN || closing) return;
    }
    admit(conn, row, { token }, { accountId: null });
  }

  // Accounts mode: identity comes from the verified upgrade, never from message fields.
  // All joins and switches for an account are serialized by withAccountLock.
  async function joinAccount(conn, msg) {
    const { ws, account } = conn;
    const fallbackName = cleanName(account.username, cfg.maxNameLength);
    if (!fallbackName) return fatal(ws, CLOSE.ACCOUNT, 'account name cannot be used in game');

    const rawCharId = msg.characterId !== undefined && msg.characterId !== null
      ? parseCharacterId(msg.characterId)
      : conn.upgradeIntent?.characterId ?? null;
    if (rawCharId !== null && !Number.isSafeInteger(rawCharId)) {
      return sendError(ws, 'invalid characterId', { code: 'INVALID_CHARACTER_ID' });
    }
    const wantSwitch = msg.switch === true || conn.upgradeIntent?.switch === true;

    await withAccountLock(account.id, async () => {
      if (conn.player || conn.replaced || ws.readyState !== ws.OPEN || closing) return;

      const roster = await loadCharacter(ws, () => listRosterForAccount(account.id));
      if (roster === undefined) return;
      if (conn.player || conn.replaced || ws.readyState !== ws.OPEN || closing) return;

      const active = roster.filter((r) => (r.status ?? 'active') === 'active');
      let row = null;

      if (rawCharId !== null) {
        const chosen = roster.find((r) => Number(r.id) === rawCharId);
        if (!chosen) return sendError(ws, 'character not found', { code: 'CHARACTER_NOT_FOUND' });
        if ((chosen.status ?? 'active') !== 'active') {
          return sendError(ws, 'character is archived; restore it before joining', { code: 'CHARACTER_ARCHIVED' });
        }
        row = chosen;
      } else if (active.length === 1) {
        row = active[0];
      } else if (active.length > 1) {
        return sendError(ws, 'select a character before joining', {
          code: 'SELECTOR_REQUIRED',
          characters: active.map(projectRosterEntry),
        });
      } else if (roster.length >= cfg.maxCharacterSlots) {
        return sendError(ws, 'all character slots are archived; restore a character before joining', {
          code: 'ALL_SLOTS_ARCHIVED',
        });
      } else if (roster.length === 0) {
        if (serverFull()) return fatal(ws, CLOSE.FULL, 'server full');
        if (msg.claimToken !== undefined && msg.claimToken !== null) {
          const t = msg.claimToken;
          row = typeof t === 'string' && TOKEN_RE.test(t)
            ? await loadCharacter(ws, () => store.claimGuest(account.id, account.username, t, fallbackName))
            : null;
          if (row === undefined) return;
          if (conn.player || conn.replaced || ws.readyState !== ws.OPEN || closing) return;
          if (!row) return sendError(ws, 'guest character could not be claimed');
        } else {
          row = await store.createForAccount(account.id, account.username, fallbackName);
          if (conn.player || conn.replaced || ws.readyState !== ws.OPEN || closing) return;
        }
      } else {
        // Has archived slot(s) and free slot(s), but 0 active slots: require explicit start/restore.
        return sendError(ws, 'no active character selected; create or restore a character first', {
          code: 'SELECTOR_REQUIRED',
          characters: [],
        });
      }

      if (row.username && row.username !== account.username && typeof store.setAccountUsername === 'function') {
        await store.setAccountUsername(account.id, account.username);
        if (conn.player || conn.replaced || ws.readyState !== ws.OPEN || closing) return;
      }

      // Check whether another character on this account is already live.
      const live = findLivePlayerByAccount(account.id);
      if (live && live.id !== row.id) {
        if (!wantSwitch) {
          return sendError(ws, 'another character on this account is active; confirm switch to change characters', {
            code: 'SWITCH_REQUIRED',
            activeCharacterId: live.id,
          });
        }
        const blockers = await checkCharacterBlockers(account.id, live.id, 'switch');
        if (blockers.length > 0) {
          return sendError(ws, blockers[0].message, { code: 'SWITCH_BLOCKED', blockers });
        }
        // Save the currently active character BEFORE leaving so a save failure never loses state or switches blindly.
        try {
          await saveAndFlush([live]);
        } catch (err) {
          console.error('[game] switch aborted: failed to save active character:', err?.message ?? err);
          return sendError(ws, 'Could not save your active character; switch cancelled.', { code: 'SWITCH_SAVE_FAILED' });
        }
        if (conn.player || conn.replaced || ws.readyState !== ws.OPEN || closing) return;

        // Run ordinary leave lifecycle on the first character and verify final leave save succeeds before admitting the second.
        let toSave = [live];
        try {
          toSave = runtime.leave(live);
        } catch (err) {
          console.error('[game] leave failed during switch:', err);
        }
        players.delete(live.id);
        const oldConn = live.conn;
        if (oldConn) {
          oldConn.replaced = true;
          oldConn.player = null;
          fatal(oldConn.ws, CLOSE.REPLACED, 'switched character');
        }
        if (toSave.length) {
          try {
            await saveAndFlush(toSave);
          } catch (err) {
            console.error('[game] switch final save failed:', err?.message ?? err);
            for (const q of toSave) {
              if (q === live) orphans.set(live.id, live);
              else q.dirty = true;
            }
            if (!closing) {
              broadcastState(true);
              runtime.sync();
            }
            return sendError(ws, 'Could not finalize saving your previous character; switch cancelled.', { code: 'SWITCH_SAVE_FAILED' });
          }
        }
        if (!closing) {
          broadcastState(true);
          runtime.sync();
        }
      }

      if (conn.player || conn.replaced || ws.readyState !== ws.OPEN || closing) return;
      if (typeof store.touchCharacterPlayed === 'function') {
        try { await store.touchCharacterPlayed(account.id, row.id); } catch {}
      }
      const displayName = row.displayName || row.name || fallbackName;
      admit(
        conn,
        { ...row, name: displayName },
        { token: null, account: { id: account.id, username: account.username }, slot: row.slot ?? 1 },
        { accountId: account.id },
      );
    });
  }

  /** Explicit in-session character switch on an already-joined authenticated socket. */
  async function handleSwitch(conn, msg) {
    const { ws, account } = conn;
    if (!account) return sendError(ws, 'character switching requires a signed-in account', { code: 'ACCOUNT_REQUIRED' });
    const targetId = parseCharacterId(msg.characterId);
    if (!Number.isSafeInteger(targetId)) return sendError(ws, 'valid characterId is required', { code: 'INVALID_CHARACTER_ID' });
    if (conn.switching || conn.replaced || ws.readyState !== ws.OPEN || closing) return;
    conn.switching = true;
    try {
      await withAccountLock(account.id, async () => {
        const cur = conn.player;
        if (!cur || conn.replaced || ws.readyState !== ws.OPEN || closing) return;
        if (cur.id === targetId) return sendError(ws, 'already playing that character', { code: 'ALREADY_ACTIVE' });

        const target = typeof store.findAccountCharacter === 'function'
          ? await loadCharacter(ws, () => store.findAccountCharacter(account.id, targetId))
          : null;
        if (target === undefined) return;
        if (!target) return sendError(ws, 'character not found', { code: 'CHARACTER_NOT_FOUND' });
        if ((target.status ?? 'active') !== 'active') {
          return sendError(ws, 'character is archived; restore it before switching', { code: 'CHARACTER_ARCHIVED' });
        }

        const blockers = await checkCharacterBlockers(account.id, cur.id, 'switch');
        if (blockers.length > 0) {
          return sendError(ws, blockers[0].message, { code: 'SWITCH_BLOCKED', blockers });
        }

        // Pre-save current character before mutating live membership; abort cleanly on save failure.
        try {
          await saveAndFlush([cur]);
        } catch (err) {
          console.error('[game] in-session switch aborted on save failure:', err?.message ?? err);
          return sendError(ws, 'Could not save your active character; switch cancelled.', { code: 'SWITCH_SAVE_FAILED' });
        }
        if (conn.player !== cur || conn.replaced || ws.readyState !== ws.OPEN || closing) return;

        let toSave = [cur];
        try {
          toSave = runtime.leave(cur);
        } catch (err) {
          console.error('[game] leave failed during in-session switch:', err);
        }
        players.delete(cur.id);
        lastState.delete(cur);
        conn.player = null;
        if (toSave.length) {
          try {
            await saveAndFlush(toSave);
          } catch (err) {
            console.error('[game] in-session switch final save failed:', err?.message ?? err);
            for (const q of toSave) {
              if (q === cur) orphans.set(cur.id, cur);
              else q.dirty = true;
            }
            if (!closing) {
              broadcastState(true);
              runtime.sync();
            }
            return sendError(ws, 'Could not finalize saving your previous character; switch cancelled.', { code: 'SWITCH_SAVE_FAILED' });
          }
        }
        if (conn.replaced || ws.readyState !== ws.OPEN || closing) return;
        if (typeof store.touchCharacterPlayed === 'function') {
          try { await store.touchCharacterPlayed(account.id, target.id); } catch {}
        }
        const displayName = target.displayName || target.name || account.username;
        admit(
          conn,
          { ...target, name: displayName },
          { token: null, account: { id: account.id, username: account.username }, slot: target.slot ?? 1, switched: true },
          { accountId: account.id },
        );
      });
    } finally {
      conn.switching = false;
    }
  }

  function admit(conn, row, welcome, identity) {
    const { ws } = conn;
    const existing = players.get(row.id);
    if (existing) {
      // Same character from a newer session (duplicate tab, reconnect, claimed guest): move the live
      // character to the new socket. No leave/join handlers run, so nothing is duplicated or lost.
      const old = existing.conn;
      if (old) {
        old.replaced = true;
        old.player = null;
        fatal(old.ws, CLOSE.REPLACED, 'signed in from another session');
      }
      clearTimeout(conn.joinTimer);
      existing.ws = ws;
      existing.conn = conn;
      existing.name = row.name;
      existing.accountId = identity.accountId;
      existing.forward = 0;
      existing.strafe = 0;
      existing.inputAt = 0;
      existing.chatOk = bucket(cfg.chatRatePerSec, cfg.chatBurst);
      existing.dirty = true;
      existing.arriving = conn.arrival === true;
      existing.delta = conn.delta === true;
      existing.patch = conn.patch === true;
      conn.player = existing;
      runtime.resetSync(existing);
      send(ws, { type: 'welcome', id: existing.id, ...welcome, ...(conn.arrival ? { arrival: true } : {}), player: publicPlayer(existing) });
      broadcastState(true);
      runtime.sync();
      return;
    }
    if (serverFull()) return fatal(ws, CLOSE.FULL, 'server full');

    clearTimeout(conn.joinTimer);
    const orphan = orphans.get(row.id);
    if (orphan) {
      orphans.delete(row.id);
      row = { ...row, x: orphan.x, z: orphan.z, yaw: orphan.yaw, rpg: orphan.rpg };
    }
    const p = {
      id: row.id,
      name: row.name,
      x: clamp(row.x, -cfg.worldHalfExtent, cfg.worldHalfExtent),
      z: clamp(row.z, -cfg.worldHalfExtent, cfg.worldHalfExtent),
      yaw: wrapAngle(row.yaw),
      moving: false,
      forward: 0,
      strafe: 0,
      inputAt: 0,
      dirty: false,
      rpg: row.rpg ?? {},
      accountId: identity.accountId,
      ws,
      conn,
      chatOk: bucket(cfg.chatRatePerSec, cfg.chatBurst),
      arriving: conn.arrival === true,
      delta: conn.delta === true,
      patch: conn.patch === true,
    };
    conn.player = p;
    players.set(p.id, p);
    runtime.join(p);
    try {
      saveNow([p]); // persist defaults applied by join handlers
    } catch (err) {
      console.error('[game] failed to save joined character:', err.message);
    }
    send(ws, { type: 'welcome', id: p.id, ...welcome, ...(conn.arrival ? { arrival: true } : {}), player: publicPlayer(p) });
    broadcastState(true);
    runtime.sync();
  }

  function handleInput(conn, msg) {
    const { forward, strafe, yaw } = msg;
    if (![forward, strafe, yaw].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return sendError(conn.ws, 'input requires finite numbers forward, strafe, yaw');
    }
    const p = conn.player;
    if (p.arriving && isUncreated(p)) return;
    p.forward = clamp(forward, -1, 1);
    p.strafe = clamp(strafe, -1, 1);
    // Optional traversal fields (older clients omit them: walking only). Booleans, a vertical axis and a
    // jump press counter (a changed value is one press, so a coalesced or repeated message cannot double-jump).
    p.run = msg.run === true;
    p.slow = msg.slow === true;
    p.crouch = msg.crouch === true;
    p.rise = typeof msg.rise === 'number' && Number.isFinite(msg.rise) ? clamp(msg.rise, -1, 1) : 0;
    if (Number.isSafeInteger(msg.jump) && msg.jump >= 0) p.jumpSeq = msg.jump;
    const y = wrapAngle(yaw);
    if (y !== p.yaw) p.dirty = true;
    p.yaw = y;
    p.inputAt = performance.now();
  }

  function handleChat(conn, msg) {
    if (typeof msg.text !== 'string') return sendError(conn.ws, 'chat requires text');
    const text = msg.text.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return sendError(conn.ws, 'empty chat message');
    if (text.length > cfg.maxChatLength) {
      return sendError(conn.ws, `chat message longer than ${cfg.maxChatLength} characters`);
    }
    const p = conn.player;
    if (p.arriving && isUncreated(p)) return sendError(conn.ws, 'create your character before speaking in the world');
    if (services.isMuted(p)) return sendError(conn.ws, 'you are muted');
    if (!p.chatOk()) return sendError(conn.ws, 'chatting too fast');
    // Local chat reaches the speaker's location, and outdoors the players visible across a
    // boundary within the same range (server/rpg/peers.js). Indoors stays private to the room.
    const sceneOf = runtime.sceneOf ?? runtime.locationOf;
    const scene = sceneOf(p);
    const channel = msg.channel === 'shout' || msg.channel === 'yell' ? 'shout' : 'say';
    const data = JSON.stringify({ type: 'chat', name: p.name, text, ...(channel === 'shout' ? { channel: 'shout' } : {}) });
    const audience = typeof services.chatAudience === 'function'
      ? services.chatAudience(p, channel)
      : (() => {
          const near = new Set((services.peerView?.across(p) ?? []).map((a) => a.player));
          return [...players.values()].filter((q) => sceneOf(q) === scene || near.has(q));
        })();
    const logged = services.logChat?.(p, { channel, location: scene, text, recipientIds: audience.filter((q) => q !== p).map((q) => q.id) });
    if (logged === null) return sendError(conn.ws, 'chat is unavailable right now'); // moderation: never deliver unlogged chat
    for (const q of audience) {
      if (q.ws.readyState === q.ws.OPEN) q.ws.send(data);
    }
  }

  function handleAction(conn, msg) {
    const seq = Number.isSafeInteger(msg.seq) && msg.seq >= 0 ? msg.seq : undefined;
    const verb = typeof msg.verb === 'string' ? msg.verb.slice(0, 100) : undefined;
    const reply = (ok, error) => {
      if (seq !== undefined) send(conn.ws, { type: 'actionResult', seq, verb, ok, ...(error ? { error } : {}) });
      else if (!ok) sendError(conn.ws, error, { verb });
    };
    const accountId = conn.account?.id ?? conn.player?.accountId;
    if (!conn.actionOk() || (accountId != null && !accountActionOk(accountId))) {
      return reply(false, 'acting too fast');
    }
    if (verb === undefined) return reply(false, 'action requires a verb');
    const r = runtime.act(conn.player, verb, msg.args);
    reply(r.ok, r.error);
  }

  return {
    config: cfg,
    runtime,
    chatLog,
    hiscores,
    localAssets: Object.freeze({ enabled: localAssets.enabled, dir: localAssets.dir, reason: localAssets.reason }),
    /** Public summary of an account's primary active character, or null. */
    characterForAccount(accountId) {
      const row = store.findByAccount(accountId);
      if (row && typeof row.then === 'function') {
        return row.then((r) => (r ? { id: r.id, name: r.name } : null));
      }
      return row ? { id: row.id, name: row.name } : null;
    },
    /** All characters for an account (active + archived). */
    charactersForAccount(accountId) {
      return listRosterForAccount(accountId).then((rows) => rows.map(projectRosterEntry));
    },
    /** Runs a bounded expired-archive purge pass now (also runs periodically). */
    purgeExpiredArchived(at = Date.now()) {
      return runExpiredArchivePurge(at);
    },
    async start() {
      await runExpiredArchivePurge(Date.now());
      lastArchivePurgeAt = Date.now();
      if (typeof services.market?.settleDue === 'function') {
        try { await services.market.settleDue(); } catch (err) {
          console.error('[game] startup market settlement failed:', err?.message ?? err);
        }
      }
      await new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(cfg.port, cfg.host, () => {
          http.off('error', reject);
          resolve();
        });
      });
      lastTick = performance.now();
      tickTimer = setInterval(tick, 1000 / cfg.tickHz);
      saveTimer = setInterval(() => {
        persist([...players.values()]);
        pruneAccountActionBuckets();
        if (pendingAccountCleanups.size) {
          for (const acctId of [...pendingAccountCleanups]) void cleanupDeletedAccount(acctId);
        }
        const nowTs = Date.now();
        if (nowTs - lastArchivePurgeAt >= cfg.archivePurgeIntervalMs) {
          lastArchivePurgeAt = nowTs;
          void runExpiredArchivePurge(nowTs);
        }
      }, cfg.saveIntervalMs);
      heartbeatTimer = setInterval(() => {
        for (const ws of wss.clients) {
          if (ws.isAlive === false) {
            ws.terminate();
            continue;
          }
          ws.isAlive = false;
          ws.ping();
        }
      }, cfg.heartbeatMs);
      return http.address();
    },
    address: () => http.address(),
    close() {
      if (closing) return closing;
      closing = (async () => {
        clearInterval(tickTimer);
        clearInterval(saveTimer);
        clearInterval(heartbeatTimer);
        if (typeof unsubscribeModeration === 'function') unsubscribeModeration();
        if (typeof unsubscribeSessionEnd === 'function') unsubscribeSessionEnd();
        if (typeof unsubscribeAccountDelete === 'function') unsubscribeAccountDelete();
        accountActionBuckets.clear();
        persist([...players.values()]);
        const done = [...sockets].map(
          (ws) =>
            new Promise((resolve) => {
              ws.once('close', resolve);
              ws.close(CLOSE.SHUTDOWN, 'server shutting down');
              setTimeout(() => {
                ws.terminate();
                resolve();
              }, 1000).unref();
            })
        );
        await Promise.all(done);
        persist([...players.values()]);
        runtime.ctx.emit('shutdown');
        players.clear();
        wss.close();
        await new Promise((resolve) => {
          http.close(() => resolve());
          http.closeAllConnections();
        });
        await Promise.allSettled([
          services.market?.flush?.(),
          services.homes?.whenIdle?.(),
          services.guildhall?.whenIdle?.(),
          services.pvp?.flushDurable?.(),
        ]);
        if (typeof store.flush === 'function') await store.flush();
        if (hiscores && typeof hiscores.close === 'function') {
          await hiscores.close();
        }
        if (chatLogStore && typeof chatLogStore.close === 'function' && (!store.db || chatLogStore.db !== store.db)) {
          await chatLogStore.close();
        }
        if (typeof store.close === 'function') await store.close();
      })();
      return closing;
    },
  };
}
