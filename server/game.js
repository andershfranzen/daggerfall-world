// Authoritative multiplayer server: HTTP static delivery + WebSocket game protocol on /ws,
// with the shared online RPG runtime (server/rpg/runtime.js, docs/rpg-runtime.md).
import { createServer } from 'node:http';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { openStore, CorruptCharacterError } from './db.js';
import { openSqliteChatLog, createChatLogService } from './chat-log.js';
import { createHiscoresService, isHiscoresPath } from './hiscores/index.js';
import { createSceneSpatialIndex } from './scale/spatial-grid.js';
import { createSiteHandler } from './static.js';
import { handlePublicWorldMap, PUBLIC_MAP_PATH } from './public-world-map.js';
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
  chatRatePerSec: 1,
  chatBurst: 5,
  actionRatePerSec: 10,
  actionBurst: 20,
  accountActionRatePerSec: null, // defaults to actionRatePerSec when null
  accountActionBurst: null, // defaults to actionBurst when null
  maxChatLength: 200,
  maxNameLength: 24,
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
      // Moderation hook for chat features (party/regional/global). Guests are never muted here.
      isMuted: (p) => !!(accounts?.isMuted && p?.accountId != null && accounts.isMuted(p.accountId)),
      ...(chatLog ? { logChat: chatLog.logChat, queryChat: chatLog.queryChat, recentChat: chatLog.recentChat } : {}),
      ...(hiscores ? { hiscores } : {}),
    },
  });
  const services = runtime.ctx.services;
  runtime.ctx.isMuted = (p) => services.isMuted(p); // alias used by chat features

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
  // Self-deletion (POST /api/delete-account): disconnect every socket and unlink/delete the account's character row.
  const unsubscribeAccountDelete =
    typeof accounts?.onAccountDelete === 'function'
      ? accounts.onAccountDelete(({ accountId } = {}) => {
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
          if (typeof store.deleteForAccount === 'function') {
            return Promise.resolve()
              .then(async () => {
                const deletedId = await store.deleteForAccount(accountId);
                if (deletedId != null) {
                  orphans.delete(deletedId);
                  if (hiscores) await hiscores.removePlayer(deletedId);
                }
              })
              .catch((err) => {
                console.error('[game] failed to delete character for deleted account:', err?.message ?? err);
              });
          }
          try {
            const row = store.findByAccount(accountId);
            if (row && typeof row.then === 'function') {
              return row
                .then((resolved) => {
                  if (resolved) {
                    orphans.delete(resolved.id);
                    if (hiscores) void hiscores.removePlayer(resolved.id);
                  }
                })
                .catch((err) => {
                  console.error('[game] failed to delete character for deleted account:', err?.message ?? err);
                });
            }
            if (row) {
              orphans.delete(row.id);
              if (store.db?.isOpen) {
                store.transaction(() => {
                  store.db.prepare('DELETE FROM account_characters WHERE account_id = ?').run(key);
                  store.db.prepare('DELETE FROM players WHERE id = ?').run(row.id);
                });
              }
              if (hiscores) void hiscores.removePlayer(row.id);
            }
          } catch (err) {
            console.error('[game] failed to delete character for deleted account:', err.message);
          }
        })
      : null;

  const http = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === PUBLIC_MAP_PATH) {
      return handlePublicWorldMap(req, res, players, services.travel, services.sailing, cfg.worldBus ? { worldBus: cfg.worldBus } : undefined);
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
    if (!accounts) {
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, null));
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
        wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, account));
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
          const priorityIds = typeof services.partyOf === 'function' ? (services.partyOf(p)?.memberIds ?? []) : [];
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

  function onConnection(ws, account) {
    sockets.add(ws);
    ws.isAlive = true;
    const conn = {
      ws,
      account,
      player: null,
      joining: false,
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
      if (conn.account) await joinAccount(conn, msg);
      else await joinGuest(conn, msg);
    } finally {
      conn.joining = false;
    }
  }

  function handleArrived(conn) {
    const p = conn.player;
    if (!p.arriving) return;
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

  // Accounts mode: identity comes from the verified upgrade, never from message fields. The
  // character is found by account id (server-owned); the display name is the account username.
  async function joinAccount(conn, msg) {
    const { ws, account } = conn;
    const name = cleanName(account.username, cfg.maxNameLength);
    if (!name) return fatal(ws, CLOSE.ACCOUNT, 'account name cannot be used in game');
    let row = await loadCharacter(ws, () => store.findByAccount(account.id));
    if (row === undefined) return;
    if (conn.player || conn.replaced || ws.readyState !== ws.OPEN || closing) return;
    if (!row) {
      if (serverFull()) return fatal(ws, CLOSE.FULL, 'server full');
      if (msg.claimToken !== undefined && msg.claimToken !== null) {
        const t = msg.claimToken;
        row = typeof t === 'string' && TOKEN_RE.test(t) ? await loadCharacter(ws, () => store.claimGuest(account.id, account.username, t, name)) : null;
        if (row === undefined) return;
        if (conn.player || conn.replaced || ws.readyState !== ws.OPEN || closing) return;
        if (!row) return sendError(ws, 'guest character could not be claimed');
      } else {
        row = await store.createForAccount(account.id, account.username, name);
        if (conn.player || conn.replaced || ws.readyState !== ws.OPEN || closing) return;
      }
    } else if (row.username !== account.username) {
      await store.setAccountUsername(account.id, account.username);
      if (conn.player || conn.replaced || ws.readyState !== ws.OPEN || closing) return;
    }
    admit(conn, { ...row, name }, { token: null, account: { id: account.id, username: account.username } }, { accountId: account.id });
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
    if (services.isMuted(p)) return sendError(conn.ws, 'you are muted');
    if (!p.chatOk()) return sendError(conn.ws, 'chatting too fast');
    // Local chat reaches the speaker's location, and outdoors the players visible across a
    // boundary within the same range (server/rpg/peers.js). Indoors stays private to the room.
    const sceneOf = runtime.sceneOf ?? runtime.locationOf;
    const scene = sceneOf(p);
    const channel = msg.channel === 'shout' || msg.channel === 'yell' ? 'shout' : 'say';
    services.logChat?.(p, { channel, location: scene, text });
    const data = JSON.stringify({ type: 'chat', name: p.name, text, ...(channel === 'shout' ? { channel: 'shout' } : {}) });
    const audience = typeof services.chatAudience === 'function'
      ? services.chatAudience(p, channel)
      : (() => {
          const near = new Set((services.peerView?.across(p) ?? []).map((a) => a.player));
          return [...players.values()].filter((q) => sceneOf(q) === scene || near.has(q));
        })();
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
    /** Public summary of an account's character, or null. */
    characterForAccount(accountId) {
      const row = store.findByAccount(accountId);
      if (row && typeof row.then === 'function') {
        return row.then((r) => (r ? { id: r.id, name: r.name } : null));
      }
      return row ? { id: row.id, name: row.name } : null;
    },
    async start() {
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
