#!/usr/bin/env node
// Player accounts: registration, password login, cookie sessions, operator moderation.
//
// Storage: its own SQLite file (default server/data/accounts.db, WAL), separate from the
// game store so identity data can be backed up, restored or wiped on its own.
//
// Contract with the game runtime (server/game.js, createGameServer({ accounts })):
//   accounts.handleHttp(req, res)      -> Promise; answers every /api/* request (JSON).
//   accounts.resolveUpgrade(req)       -> { id, username } | null from the session cookie.
//                                         null for no/expired/revoked session or a banned account.
//   accounts.isMuted(accountId)        -> boolean (temporary or permanent mute in force).
//   accounts.onModeration(fn)          -> unsubscribe; fn({ accountId, action }) when an account is
//                                         banned or its sessions are revoked, including changes made
//                                         by the operator CLI in another process. The runtime should
//                                         disconnect that account's live sockets.
//   accounts.onSessionEnd(fn)          -> unsubscribe; fn({ accountId, sessionKey, reason }) when
//                                         one session is signed out or revoked (logout, password_change,
//                                         logout-all, recovery, account_deleted). resolveUpgrade also returns
//                                         an opaque `sessionKey`; the runtime should close only connections
//                                         opened with that key, leaving the account's other sessions connected.
//                                         Fallback: while no onSessionEnd listener is registered, accounts
//                                         closes those upgraded sockets itself with a WebSocket close frame
//                                         (code 4004, reason "signed out"), so logout works with any runtime.
//   accounts.onAccountDelete(fn)       -> unsubscribe; fn({ accountId, username }) when an account is
//                                         self-deleted via POST /api/delete-account. The runtime should
//                                         disconnect its live sockets and remove/unlink its character row.
//   accounts.close()                   -> stops the moderation poll and closes the DB.
//
// Operator CLI (works while the server is running; SQLite WAL allows a second writer):
//   node server/accounts.js list | show <name> | mute <name> [minutes] [reason] | unmute <name>
//                           ban <name> [reason] | unban <name> | revoke <name>
// Uses ACCOUNTS_DB_PATH (default server/data/accounts.db).
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

export const ACCOUNT_DEFAULTS = Object.freeze({
  dbPath: fileURLToPath(new URL('./data/accounts.db', import.meta.url)),
  // Cookies are always Secure + __Host- unless explicitly disabled. Browsers accept Secure cookies
  // from http://localhost and http://127.0.0.1, so loopback development keeps production behaviour.
  secureCookies: true,
  // Trust X-Forwarded-For / X-Forwarded-Proto from a reverse proxy on the same host / network.
  trustProxy: false,
  // If set (e.g. "https://play.example.org"), POST requests must carry exactly this Origin.
  // Otherwise the Origin must match the Host header.
  publicOrigin: null,
  // Refuse login/register unless the request arrived over HTTPS (directly or via a trusted proxy).
  requireHttps: false,
  sessionTtlMs: 30 * 24 * 3600_000,
  sessionRenewAfterMs: 24 * 3600_000, // sliding expiry: extend at most once a day
  maxSessionsPerAccount: 10,
  scrypt: { N: 2 ** 15, r: 8, p: 1, keyLen: 32 },
  minPasswordLength: 10,
  maxPasswordLength: 256,
  maxBodyBytes: 4096,
  moderationPollMs: 2000,
  sessionEndCloseCode: 4004, // fallback close code for sockets of a signed-out session
  // Rate limits: [events, windowMs]
  limits: {
    api: [120, 60_000], // any /api request, per client IP
    login: [10, 5 * 60_000], // login attempts per IP
    loginName: [8, 15 * 60_000], // failed logins per account name (all IPs)
    register: [5, 3600_000], // accounts created per IP
    password: [10, 15 * 60_000], // password-verified account mutations per account
    recover: [5, 15 * 60_000], // recovery attempts per IP
    recoverName: [5, 15 * 60_000], // failed recovery attempts per account name (all IPs)
  },
  now: () => Date.now(),
});

export const COOKIE_SECURE = '__Host-dfw_session';
export const COOKIE_INSECURE = 'dfw_session';

const USERNAME_RE = /^[A-Za-z][A-Za-z0-9_-]{2,19}$/;
const RESERVED = new Set([
  'admin', 'administrator', 'operator', 'moderator', 'mod', 'gm', 'gamemaster', 'system', 'server',
  'root', 'staff', 'support', 'daggerfall', 'guest', 'anonymous', 'null', 'undefined',
]);
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const FOREVER = Number.MAX_SAFE_INTEGER;

export function usernameKey(name) {
  return String(name).toLowerCase();
}

/** Returns an error message for an invalid account name, or null. */
export function usernameProblem(name) {
  if (typeof name !== 'string' || !name) return 'Enter an account name.';
  if (!USERNAME_RE.test(name)) {
    return 'Account names are 3–20 characters: letters, digits, _ and -, starting with a letter.';
  }
  if (RESERVED.has(usernameKey(name))) return 'That account name is reserved.';
  return null;
}

export function passwordProblem(password, username, cfg = ACCOUNT_DEFAULTS) {
  if (typeof password !== 'string' || !password) return 'Enter a password.';
  const len = [...password].length;
  if (len < cfg.minPasswordLength) return `Passwords need at least ${cfg.minPasswordLength} characters.`;
  if (len > cfg.maxPasswordLength) return `Passwords can be at most ${cfg.maxPasswordLength} characters.`;
  if (typeof username === 'string' && password.toLowerCase().includes(username.toLowerCase())) {
    return 'Your password must not contain your account name.';
  }
  return null;
}

// ---------------------------------------------------------------- password hashing (scrypt)

export async function hashPassword(password, params = ACCOUNT_DEFAULTS.scrypt) {
  const { N, r, p, keyLen } = params;
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, keyLen, { N, r, p, maxmem: 256 * N * r });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const parts = typeof stored === 'string' ? stored.split('$') : [];
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (![N, r, p].every(Number.isInteger) || N > 2 ** 20 || !expected.length) return false;
  const key = await scrypt(String(password).normalize('NFKC'), salt, expected.length, {
    N, r, p, maxmem: 256 * N * r,
  });
  return timingSafeEqual(key, expected);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

const DUMMY_RECOVERY_HASH = Buffer.alloc(32);

export function generateRecoveryCode() {
  return randomBytes(16).toString('hex').toUpperCase().match(/.{4}/g).join('-');
}

export function normalizeRecoveryCode(code) {
  return String(code).replace(/[\s-]+/g, '').toUpperCase();
}

function hashRecoveryCode(code) {
  return sha256(normalizeRecoveryCode(code));
}

function verifyRecoveryCode(code, storedHash) {
  const normalized = typeof code === 'string' ? normalizeRecoveryCode(code) : '';
  const actual = createHash('sha256').update(normalized).digest();
  const validStored = typeof storedHash === 'string' && /^[0-9a-f]{64}$/i.test(storedHash);
  const expected = validStored ? Buffer.from(storedHash, 'hex') : DUMMY_RECOVERY_HASH;
  const eq = timingSafeEqual(actual, expected);
  return validStored && normalized.length > 0 && eq;
}

// ---------------------------------------------------------------- rate limiting

/** Sliding-window counter keyed by string. hit() returns 0 when allowed, else ms until retry. */
export function createLimiter(max, windowMs, now = () => Date.now()) {
  const hits = new Map(); // key -> timestamps (ascending)
  let lastSweep = now();
  function prune(list, t) {
    while (list.length && list[0] <= t - windowMs) list.shift();
  }
  function sweep(t) {
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const [k, list] of hits) {
      prune(list, t);
      if (!list.length) hits.delete(k);
    }
  }
  return {
    check(key) {
      const t = now();
      const list = hits.get(key);
      if (!list) return 0;
      prune(list, t);
      return list.length >= max ? list[0] + windowMs - t : 0;
    },
    hit(key) {
      const t = now();
      sweep(t);
      let list = hits.get(key);
      if (!list) hits.set(key, (list = []));
      prune(list, t);
      if (list.length >= max) return list[0] + windowMs - t;
      list.push(t);
      return 0;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

// ---------------------------------------------------------------- storage

export function openAccountStore(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER,
      muted_until INTEGER,
      mute_reason TEXT,
      banned_at INTEGER,
      ban_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_account ON sessions(account_id);
    CREATE TABLE IF NOT EXISTS moderation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      reason TEXT,
      until INTEGER,
      actor TEXT NOT NULL,
      at INTEGER NOT NULL
    );
  `);
  const accCols = new Set(db.prepare('PRAGMA table_info(accounts)').all().map((c) => c.name));
  if (!accCols.has('recovery_hash')) db.exec('ALTER TABLE accounts ADD COLUMN recovery_hash TEXT');
  const q = {
    insert: db.prepare(
      'INSERT INTO accounts (username, username_key, password_hash, created_at, recovery_hash) VALUES (?, ?, ?, ?, ?)'
    ),
    byKey: db.prepare('SELECT * FROM accounts WHERE username_key = ?'),
    byId: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    list: db.prepare(
      `SELECT a.*, (SELECT COUNT(*) FROM sessions s WHERE s.account_id = a.id AND s.expires_at > ?) AS sessions
       FROM accounts a ORDER BY a.id`
    ),
    touchLogin: db.prepare('UPDATE accounts SET last_login_at = ? WHERE id = ?'),
    setPassword: db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?'),
    setRecovery: db.prepare('UPDATE accounts SET recovery_hash = ? WHERE id = ?'),
    setPasswordAndRecovery: db.prepare('UPDATE accounts SET password_hash = ?, recovery_hash = ? WHERE id = ?'),
    deleteAccount: db.prepare('DELETE FROM accounts WHERE id = ?'),
    setMute: db.prepare('UPDATE accounts SET muted_until = ?, mute_reason = ? WHERE id = ?'),
    setBan: db.prepare('UPDATE accounts SET banned_at = ?, ban_reason = ? WHERE id = ?'),
    muteOf: db.prepare('SELECT muted_until FROM accounts WHERE id = ?'),
    sessInsert: db.prepare(
      'INSERT INTO sessions (token_hash, account_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)'
    ),
    sessGet: db.prepare(
      `SELECT s.id AS sid, s.last_seen_at, s.expires_at, a.id, a.username, a.banned_at
       FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?`
    ),
    sessIdsForAccount: db.prepare('SELECT id FROM sessions WHERE account_id = ?'),
    sessIdsOther: db.prepare('SELECT id FROM sessions WHERE account_id = ? AND id != ?'),
    sessTouch: db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?'),
    sessDelete: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    sessDeleteId: db.prepare('DELETE FROM sessions WHERE id = ?'),
    sessDeleteOther: db.prepare('DELETE FROM sessions WHERE account_id = ? AND id != ?'),
    sessDeleteAccount: db.prepare('DELETE FROM sessions WHERE account_id = ?'),
    sessExpire: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    sessTrim: db.prepare(
      `DELETE FROM sessions WHERE account_id = ? AND id NOT IN
         (SELECT id FROM sessions WHERE account_id = ? ORDER BY last_seen_at DESC LIMIT ?)`
    ),
    log: db.prepare(
      'INSERT INTO moderation_log (account_id, action, reason, until, actor, at) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    logSince: db.prepare('SELECT id, account_id, action FROM moderation_log WHERE id > ? ORDER BY id'),
    logMax: db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM moderation_log'),
    dataVersion: db.prepare('PRAGMA data_version'),
  };
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  const norm = (row) => (row ? { ...row, id: Number(row.id) } : null);
  return {
    db,
    q,
    tx,
    find: (name) => norm(q.byKey.get(usernameKey(name))),
    get: (id) => norm(q.byId.get(id)),
    close() {
      if (db.isOpen) {
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch {}
        db.close();
      }
    },
  };
}

// ---------------------------------------------------------------- moderation (shared by server + CLI)

function moderation(store, now) {
  function target(name) {
    const acc = store.find(name);
    if (!acc) throw new Error(`no account named ${JSON.stringify(name)}`);
    return acc;
  }
  return {
    mute(name, { minutes = null, reason = null, actor = 'operator' } = {}) {
      const acc = target(name);
      const until = minutes == null ? FOREVER : now() + Math.round(minutes * 60_000);
      store.tx(() => {
        store.q.setMute.run(until, reason, acc.id);
        store.q.log.run(acc.id, 'mute', reason, until === FOREVER ? null : until, actor, now());
      });
      return { id: acc.id, username: acc.username, mutedUntil: until === FOREVER ? null : until };
    },
    unmute(name, { actor = 'operator' } = {}) {
      const acc = target(name);
      store.tx(() => {
        store.q.setMute.run(null, null, acc.id);
        store.q.log.run(acc.id, 'unmute', null, null, actor, now());
      });
      return { id: acc.id, username: acc.username };
    },
    ban(name, { reason = null, actor = 'operator' } = {}) {
      const acc = target(name);
      store.tx(() => {
        store.q.setBan.run(now(), reason, acc.id);
        store.q.sessDeleteAccount.run(acc.id);
        store.q.log.run(acc.id, 'ban', reason, null, actor, now());
      });
      return { id: acc.id, username: acc.username };
    },
    unban(name, { actor = 'operator' } = {}) {
      const acc = target(name);
      store.tx(() => {
        store.q.setBan.run(null, null, acc.id);
        store.q.log.run(acc.id, 'unban', null, null, actor, now());
      });
      return { id: acc.id, username: acc.username };
    },
    revokeSessions(name, { actor = 'operator' } = {}) {
      const acc = target(name);
      const n = store.tx(() => {
        const { changes } = store.q.sessDeleteAccount.run(acc.id);
        store.q.log.run(acc.id, 'revoke', null, null, actor, now());
        return Number(changes);
      });
      return { id: acc.id, username: acc.username, revoked: n };
    },
  };
}

// ---------------------------------------------------------------- HTTP helpers

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    ...headers,
  });
  res.end(res.req?.method === 'HEAD' ? undefined : data);
}

export function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- shared runtime helpers

function createHttpHelpers(cfg, cookieName) {
  function clientIp(req) {
    if (cfg.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff) {
        // The proxy appends the address it saw; the right-most entry is the one we can trust.
        const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
        if (parts.length) return parts[parts.length - 1];
      }
    }
    return req.socket?.remoteAddress ?? 'unknown';
  }

  function isHttps(req) {
    if (req.socket?.encrypted) return true;
    return cfg.trustProxy && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https';
  }

  function sameOrigin(req) {
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    if (origin === undefined) return site === undefined || site === 'same-origin'; // non-browser clients
    if (cfg.publicOrigin) return origin === cfg.publicOrigin;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  function cookie(value, maxAgeSec) {
    const attrs = [`${cookieName}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
    if (cfg.secureCookies) attrs.push('Secure');
    return attrs.join('; ');
  }

  function tokenFrom(req) {
    const t = parseCookies(req.headers.cookie)[cookieName];
    return t && TOKEN_RE.test(t) ? t : null;
  }

  function limited(res, ms, message = 'Too many attempts. Please wait and try again.') {
    sendJson(res, 429, { error: message }, { 'Retry-After': String(Math.max(1, Math.ceil(ms / 1000))) });
  }

  async function jsonBody(req) {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw Object.assign(new Error('expected application/json'), { status: 415 });
    const text = await readBody(req, cfg.maxBodyBytes);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw Object.assign(new Error('invalid JSON'), { status: 400 });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw Object.assign(new Error('expected a JSON object'), { status: 400 });
    }
    return body;
  }

  return { clientIp, isHttps, sameOrigin, cookie, tokenFrom, limited, jsonBody };
}

function createSocketTracker(cfg) {
  // Live upgraded sockets per session id, for the logout fallback. Entries leave on socket close.
  const sessionSockets = new Map(); // sid -> Set<net.Socket>
  const sessionListeners = new Set();
  const deleteListeners = new Set();

  function notifyAccountDelete(accountId, username) {
    const event = { accountId, username };
    for (const fn of deleteListeners) {
      try {
        fn(event);
      } catch (err) {
        console.error('[accounts] account delete listener failed:', err.message);
      }
    }
  }

  function trackSocket(sid, socket) {
    if (!socket || typeof socket.once !== 'function' || socket.destroyed) return;
    let set = sessionSockets.get(sid);
    if (!set) sessionSockets.set(sid, (set = new Set()));
    if (set.has(socket)) return;
    set.add(socket);
    socket.once('close', () => {
      set.delete(socket);
      if (!set.size && sessionSockets.get(sid) === set) sessionSockets.delete(sid);
    });
  }

  // Unmasked server close frame (RFC 6455 §5.5.1). Node writes each frame atomically with respect
  // to the ws library's own writes (both are synchronous socket.write calls on one thread).
  function closeFrame(code, reason) {
    const text = Buffer.from(reason, 'utf8').subarray(0, 123);
    const frame = Buffer.alloc(4 + text.length);
    frame[0] = 0x88;
    frame[1] = 2 + text.length;
    frame.writeUInt16BE(code, 2);
    text.copy(frame, 4);
    return frame;
  }

  function endSession(accountId, sid, reason) {
    const sockets = sessionSockets.get(sid);
    sessionSockets.delete(sid);
    const event = { accountId, sessionKey: String(sid), reason };
    if (sessionListeners.size) {
      for (const fn of sessionListeners) {
        try {
          fn(event);
        } catch (err) {
          console.error('[accounts] session listener failed:', err.message);
        }
      }
      return;
    }
    for (const socket of sockets ?? []) {
      if (socket.destroyed) continue;
      try {
        if (socket.writable) socket.write(closeFrame(cfg.sessionEndCloseCode, 'signed out'));
        socket.end();
        setTimeout(() => socket.destroy(), 1000).unref();
      } catch {
        socket.destroy();
      }
    }
  }

  return { sessionSockets, sessionListeners, deleteListeners, notifyAccountDelete, trackSocket, endSession };
}

function createHttpDispatcher(routes, helpers, limiters, cfg) {
  const { clientIp, isHttps, sameOrigin, limited } = helpers;
  return async function handleHttp(req, res) {
    try {
      const path = String(req.url ?? '').split('?')[0];
      const route = routes[path];
      if (!route) return sendJson(res, 404, { error: 'not found' });
      const fn = route[req.method];
      if (!fn) return sendJson(res, 405, { error: 'method not allowed' }, { Allow: Object.keys(route).join(', ') });
      const ip = clientIp(req);
      const wait = limiters.api.hit(ip);
      if (wait) return limited(res, wait, 'Too many requests. Please slow down.');
      if (req.method === 'POST') {
        if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request refused' });
        if (cfg.secureCookies && cfg.requireHttps && !isHttps(req)) {
          return sendJson(res, 403, { error: 'HTTPS required' });
        }
      }
      await fn(req, res);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err.status) return sendJson(res, err.status, { error: err.message });
      console.error('[accounts] request failed:', err);
      sendJson(res, 500, { error: 'internal error' });
    }
  };
}

// ---------------------------------------------------------------- service

export function createAccounts(options = {}) {
  const cfg = { ...ACCOUNT_DEFAULTS, ...options, limits: { ...ACCOUNT_DEFAULTS.limits, ...options.limits } };
  const now = cfg.now;
  const store = options.store ?? openAccountStore(cfg.dbPath);
  const mod = moderation(store, now);
  const cookieName = cfg.secureCookies ? COOKIE_SECURE : COOKIE_INSECURE;
  const limiters = Object.fromEntries(
    Object.entries(cfg.limits).map(([k, [max, win]]) => [k, createLimiter(max, win, now)])
  );
  // Constant-cost dummy for unknown account names, so login timing does not reveal which names exist.
  const dummyHash = hashPassword(randomBytes(16).toString('hex'), cfg.scrypt);
  const http = createHttpHelpers(cfg, cookieName);
  const { clientIp, cookie, tokenFrom, limited, jsonBody } = http;
  const tracker = createSocketTracker(cfg);
  const { sessionSockets, sessionListeners, deleteListeners, notifyAccountDelete, trackSocket, endSession } = tracker;

  // Moderation fan-out. PRAGMA data_version changes when another connection (the CLI) commits.
  const listeners = new Set();
  let lastLogId = Number(store.q.logMax.get().id);
  let lastDataVersion = Number(Object.values(store.q.dataVersion.get())[0]);
  function drainModeration() {
    if (!store.db.isOpen) return;
    const rows = store.q.logSince.all(lastLogId);
    for (const row of rows) {
      lastLogId = Number(row.id);
      if (row.action !== 'ban' && row.action !== 'revoke') continue;
      const event = { accountId: Number(row.account_id), action: row.action };
      for (const fn of listeners) {
        try {
          fn(event);
        } catch (err) {
          console.error('[accounts] moderation listener failed:', err.message);
        }
      }
    }
  }
  const pollTimer = cfg.moderationPollMs > 0
    ? setInterval(() => {
        if (!store.db.isOpen) return;
        const v = Number(Object.values(store.q.dataVersion.get())[0]);
        if (v !== lastDataVersion) {
          lastDataVersion = v;
          drainModeration();
        }
      }, cfg.moderationPollMs)
    : null;
  pollTimer?.unref();
  const sweepTimer = setInterval(() => {
    if (store.db.isOpen) store.q.sessExpire.run(now());
  }, 3600_000);
  sweepTimer.unref();

  /** Session lookup shared by /api/me and the WebSocket upgrade. Applies sliding renewal. */
  function sessionFor(req) {
    const token = tokenFrom(req);
    if (!token) return null;
    const row = store.q.sessGet.get(sha256(token));
    if (!row) return null;
    const t = now();
    if (row.expires_at <= t || row.banned_at != null) {
      store.q.sessDeleteId.run(row.sid);
      return null;
    }
    let renewed = false;
    if (t - row.last_seen_at >= cfg.sessionRenewAfterMs) {
      store.q.sessTouch.run(t, t + cfg.sessionTtlMs, row.sid);
      renewed = true;
    }
    return { token, renewed, sid: Number(row.sid), user: { id: Number(row.id), username: row.username } };
  }

  function startSession(accountId) {
    const token = randomBytes(32).toString('base64url');
    const t = now();
    store.tx(() => {
      store.q.sessInsert.run(sha256(token), accountId, t, t, t + cfg.sessionTtlMs);
      store.q.sessTrim.run(accountId, accountId, cfg.maxSessionsPerAccount);
      store.q.touchLogin.run(t, accountId);
    });
    return cookie(token, Math.floor(cfg.sessionTtlMs / 1000));
  }

  function mutedPayload(id) {
    const row = store.q.muteOf.get(id);
    const until = row?.muted_until;
    if (until == null || until <= now()) return null;
    return { until: until === FOREVER ? null : until };
  }

  async function register(req, res) {
    const ip = clientIp(req);
    const body = await jsonBody(req);
    const { username, password } = body;
    const uProblem = usernameProblem(username);
    if (uProblem) return sendJson(res, 400, { error: uProblem, field: 'username' });
    const pProblem = passwordProblem(password, username, cfg);
    if (pProblem) return sendJson(res, 400, { error: pProblem, field: 'password' });
    const wait = limiters.register.check(ip);
    if (wait) return limited(res, wait, 'Too many new accounts from this network. Please try again later.');
    if (store.find(username)) {
      return sendJson(res, 409, { error: 'That account name is taken.', field: 'username' });
    }
    const hash = await hashPassword(password, cfg.scrypt);
    const recoveryCode = generateRecoveryCode();
    const recoveryHash = hashRecoveryCode(recoveryCode);
    let id;
    try {
      ({ lastInsertRowid: id } = store.q.insert.run(username, usernameKey(username), hash, now(), recoveryHash));
    } catch (err) {
      if (/UNIQUE/i.test(err.message)) {
        return sendJson(res, 409, { error: 'That account name is taken.', field: 'username' });
      }
      throw err;
    }
    limiters.register.hit(ip);
    id = Number(id);
    const setCookie = startSession(id);
    sendJson(res, 201, { user: { id, username }, recoveryCode }, { 'Set-Cookie': setCookie });
  }

  async function login(req, res) {
    const ip = clientIp(req);
    const body = await jsonBody(req);
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return sendJson(res, 400, { error: 'Enter your account name and password.' });
    }
    if (username.length > 64 || password.length > cfg.maxPasswordLength * 4) {
      return sendJson(res, 401, { error: 'Incorrect account name or password.' });
    }
    const key = usernameKey(username);
    const wait = limiters.login.hit(ip) || limiters.loginName.check(key);
    if (wait) return limited(res, wait);
    const acc = store.find(username);
    const ok = acc
      ? await verifyPassword(password, acc.password_hash)
      : (await verifyPassword(password, await dummyHash), false);
    if (!ok) {
      limiters.loginName.hit(key);
      return sendJson(res, 401, { error: 'Incorrect account name or password.' });
    }
    if (acc.banned_at != null) {
      return sendJson(res, 403, {
        error: acc.ban_reason ? `This account is banned: ${acc.ban_reason}` : 'This account is banned.',
      });
    }
    limiters.loginName.reset(key);
    const setCookie = startSession(acc.id);
    sendJson(res, 200, { user: { id: acc.id, username: acc.username } }, { 'Set-Cookie': setCookie });
  }

  function logout(req, res) {
    const token = tokenFrom(req);
    if (token) {
      const row = store.q.sessGet.get(sha256(token));
      store.q.sessDelete.run(sha256(token));
      if (row) endSession(Number(row.id), Number(row.sid), 'logout');
    }
    sendJson(res, 200, { user: null }, { 'Set-Cookie': cookie('', 0) });
  }

  function logoutAll(req, res) {
    const s = sessionFor(req);
    if (!s) return sendJson(res, 401, { error: 'Sign in first.' });
    const sids = store.tx(() => {
      const rows = store.q.sessIdsForAccount.all(s.user.id);
      store.q.sessDeleteAccount.run(s.user.id);
      store.q.log.run(s.user.id, 'revoke', 'self logout-all', null, 'self', now());
      return rows.map((r) => Number(r.id));
    });
    drainModeration();
    for (const sid of sids) endSession(s.user.id, sid, 'logout-all');
    sendJson(res, 200, { user: null, revokedSessions: sids.length }, { 'Set-Cookie': cookie('', 0) });
  }

  async function verifyCurrentPassword(req, res, s, rawPassword, field = 'password') {
    if (typeof rawPassword !== 'string' || !rawPassword) {
      sendJson(res, 400, { error: 'Enter your current password.', field });
      return null;
    }
    if (rawPassword.length > cfg.maxPasswordLength * 4) {
      sendJson(res, 401, { error: 'Current password is incorrect.', field });
      return null;
    }
    const key = String(s.user.id);
    const wait = limiters.password.check(key);
    if (wait) {
      limited(res, wait);
      return null;
    }
    const acc = store.get(s.user.id);
    if (!acc || acc.banned_at != null) {
      sendJson(res, 401, { error: 'Sign in first.' });
      return null;
    }
    const ok = await verifyPassword(rawPassword, acc.password_hash);
    if (!ok) {
      limiters.password.hit(key);
      sendJson(res, 401, { error: 'Current password is incorrect.', field });
      return null;
    }
    limiters.password.reset(key);
    return acc;
  }

  async function changePassword(req, res) {
    const s = sessionFor(req);
    if (!s) return sendJson(res, 401, { error: 'Sign in first.' });
    const body = await jsonBody(req);
    const { currentPassword, newPassword } = body;
    const acc = await verifyCurrentPassword(req, res, s, currentPassword, 'currentPassword');
    if (!acc) return;
    const pProblem = passwordProblem(newPassword, acc.username, cfg);
    if (pProblem) return sendJson(res, 400, { error: pProblem, field: 'newPassword' });
    const newHash = await hashPassword(newPassword, cfg.scrypt);
    const otherSids = store.tx(() => {
      store.q.setPassword.run(newHash, acc.id);
      const rows = store.q.sessIdsOther.all(acc.id, s.sid);
      store.q.sessDeleteOther.run(acc.id, s.sid);
      return rows.map((r) => Number(r.id));
    });
    for (const sid of otherSids) endSession(acc.id, sid, 'password_change');
    sendJson(res, 200, { ok: true, user: s.user, revokedSessions: otherSids.length });
  }

  async function rotateRecoveryCode(req, res) {
    const s = sessionFor(req);
    if (!s) return sendJson(res, 401, { error: 'Sign in first.' });
    const body = await jsonBody(req);
    const acc = await verifyCurrentPassword(req, res, s, body.password ?? body.currentPassword, 'password');
    if (!acc) return;
    const recoveryCode = generateRecoveryCode();
    store.q.setRecovery.run(hashRecoveryCode(recoveryCode), acc.id);
    sendJson(res, 200, { recoveryCode });
  }

  async function clearRecoveryCode(req, res) {
    const s = sessionFor(req);
    if (!s) return sendJson(res, 401, { error: 'Sign in first.' });
    const body = await jsonBody(req);
    const acc = await verifyCurrentPassword(req, res, s, body.password ?? body.currentPassword, 'password');
    if (!acc) return;
    store.q.setRecovery.run(null, acc.id);
    sendJson(res, 200, { cleared: true });
  }

  async function deleteAccount(req, res) {
    const s = sessionFor(req);
    if (!s) return sendJson(res, 401, { error: 'Sign in first.' });
    const body = await jsonBody(req);
    const acc = await verifyCurrentPassword(req, res, s, body.password ?? body.currentPassword, 'password');
    if (!acc) return;
    const sids = store.tx(() => {
      const rows = store.q.sessIdsForAccount.all(acc.id);
      store.q.deleteAccount.run(acc.id);
      return rows.map((r) => Number(r.id));
    });
    notifyAccountDelete(acc.id, acc.username);
    for (const sid of sids) endSession(acc.id, sid, 'account_deleted');
    sendJson(res, 200, { deleted: true, user: null }, { 'Set-Cookie': cookie('', 0) });
  }

  async function recover(req, res) {
    const ip = clientIp(req);
    const body = await jsonBody(req);
    const { username, recoveryCode, newPassword } = body;
    if (
      typeof username !== 'string' || !username ||
      typeof recoveryCode !== 'string' || !recoveryCode ||
      typeof newPassword !== 'string' || !newPassword
    ) {
      return sendJson(res, 400, { error: 'Enter your account name, recovery code, and new password.' });
    }
    const pProblem = passwordProblem(newPassword, username, cfg);
    if (pProblem) return sendJson(res, 400, { error: pProblem, field: 'newPassword' });
    if (username.length > 64 || recoveryCode.length > 128) {
      return sendJson(res, 401, { error: 'Incorrect account name or recovery code.' });
    }
    const key = usernameKey(username);
    const wait = limiters.recover.hit(ip) || limiters.recoverName.check(key);
    if (wait) return limited(res, wait);
    const acc = store.find(username);
    const ok = verifyRecoveryCode(recoveryCode, acc?.recovery_hash ?? null);
    if (!ok) {
      limiters.recoverName.hit(key);
      return sendJson(res, 401, { error: 'Incorrect account name or recovery code.' });
    }
    if (acc.banned_at != null) {
      return sendJson(res, 403, {
        error: acc.ban_reason ? `This account is banned: ${acc.ban_reason}` : 'This account is banned.',
      });
    }
    limiters.recoverName.reset(key);
    const newHash = await hashPassword(newPassword, cfg.scrypt);
    const nextCode = generateRecoveryCode();
    const nextHash = hashRecoveryCode(nextCode);
    const oldSids = store.tx(() => {
      const rows = store.q.sessIdsForAccount.all(acc.id);
      store.q.setPasswordAndRecovery.run(newHash, nextHash, acc.id);
      store.q.sessDeleteAccount.run(acc.id);
      store.q.log.run(acc.id, 'revoke', 'password recovery', null, 'recovery', now());
      return rows.map((r) => Number(r.id));
    });
    drainModeration();
    for (const sid of oldSids) endSession(acc.id, sid, 'recovery');
    const setCookie = startSession(acc.id);
    sendJson(
      res,
      200,
      { user: { id: acc.id, username: acc.username }, recoveryCode: nextCode },
      { 'Set-Cookie': setCookie }
    );
  }

  function me(req, res) {
    const s = sessionFor(req);
    const headers = {};
    if (!s && tokenFrom(req)) headers['Set-Cookie'] = cookie('', 0); // drop a dead cookie
    if (s?.renewed) headers['Set-Cookie'] = cookie(s.token, Math.floor(cfg.sessionTtlMs / 1000));
    const muted = s ? mutedPayload(s.user.id) : null;
    sendJson(res, 200, { user: s ? s.user : null, ...(muted ? { muted } : {}) }, headers);
  }

  const routes = {
    '/api/me': { GET: me, HEAD: me },
    '/api/register': { POST: register },
    '/api/login': { POST: login },
    '/api/logout': { POST: logout },
    '/api/logout-all': { POST: logoutAll },
    '/api/password': { POST: changePassword },
    '/api/delete-account': { POST: deleteAccount },
    '/api/recovery-code': { POST: rotateRecoveryCode },
    '/api/clear-recovery': { POST: clearRecoveryCode },
    '/api/recover': { POST: recover },
  };

  const handleHttp = createHttpDispatcher(routes, http, limiters, cfg);

  return {
    config: cfg,
    cookieName,
    store,
    handleHttp,
    resolveUpgrade(req) {
      try {
        const s = sessionFor(req);
        if (!s) return null;
        trackSocket(s.sid, req.socket);
        return { ...s.user, sessionKey: String(s.sid) };
      } catch (err) {
        console.error('[accounts] session lookup failed:', err.message);
        return null;
      }
    },
    isMuted(accountId) {
      try {
        return mutedPayload(accountId) !== null;
      } catch {
        return false;
      }
    },
    onSessionEnd(fn) {
      sessionListeners.add(fn);
      return () => sessionListeners.delete(fn);
    },
    onAccountDelete(fn) {
      deleteListeners.add(fn);
      return () => deleteListeners.delete(fn);
    },
    onModeration(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // In-process operator actions (same as the CLI). Listeners are notified synchronously.
    mute(name, opts) {
      const r = mod.mute(name, opts);
      drainModeration();
      return r;
    },
    unmute(name, opts) {
      const r = mod.unmute(name, opts);
      drainModeration();
      return r;
    },
    ban(name, opts) {
      const r = mod.ban(name, opts);
      drainModeration();
      return r;
    },
    unban(name, opts) {
      const r = mod.unban(name, opts);
      drainModeration();
      return r;
    },
    revokeSessions(name, opts) {
      const r = mod.revokeSessions(name, opts);
      drainModeration();
      return r;
    },
    find: (name) => {
      const a = store.find(name);
      return a && { id: a.id, username: a.username };
    },
    listBannedAccountIds: () => {
      if (!store.db?.isOpen) return [];
      return store.db.prepare('SELECT id FROM accounts WHERE banned_at IS NOT NULL').all().map((r) => String(r.id));
    },
    close() {
      clearInterval(pollTimer);
      clearInterval(sweepTimer);
      listeners.clear();
      sessionListeners.clear();
      deleteListeners.clear();
      sessionSockets.clear();
      store.close();
    },
  };
}

// ---------------------------------------------------------------- PostgreSQL accounts service

export async function createPostgresAccounts(options = {}) {
  const cfg = {
    ...ACCOUNT_DEFAULTS,
    ...options,
    backend: 'postgres',
    limits: { ...ACCOUNT_DEFAULTS.limits, ...options.limits },
  };
  const now = cfg.now;
  const ownsStore = !options.store;
  const store =
    options.store ??
    (await (await import('./storage/postgres-accounts.js')).openPostgresAccountStore({
      connectionString: options.connectionString ?? options.databaseUrl,
      pool: options.pool ?? null,
      poolOptions: options.poolOptions,
      applySchema: options.applySchema ?? true,
      schemaSql: options.schemaSql ?? null,
      now,
    }));

  const cookieName = cfg.secureCookies ? COOKIE_SECURE : COOKIE_INSECURE;
  const limiters = Object.fromEntries(
    Object.entries(cfg.limits).map(([k, [max, win]]) => [k, createLimiter(max, win, now)]),
  );
  const dummyHash = hashPassword(randomBytes(16).toString('hex'), cfg.scrypt);
  const http = createHttpHelpers(cfg, cookieName);
  const { clientIp, cookie, tokenFrom, limited, jsonBody } = http;
  const tracker = createSocketTracker(cfg);
  const { sessionSockets, sessionListeners, deleteListeners, notifyAccountDelete, trackSocket, endSession } = tracker;

  // Synchronous mute cache hydrated on login, resolveUpgrade, /api/me, mute/unmute, and LISTEN/NOTIFY.
  const muteCache = new Map(); // String(accountId) -> mutedUntil ms (FOREVER for permanent mute)
  function setMuteCache(accountId, until) {
    const key = String(accountId);
    if (until == null) {
      muteCache.delete(key);
      return;
    }
    const n = Number(until);
    if (!Number.isFinite(n) || n <= now()) {
      muteCache.delete(key);
      return;
    }
    muteCache.set(key, n);
  }

  // Real-time moderation fan-out via PostgreSQL LISTEN/NOTIFY (deduplicated by moderation_log.id).
  const listeners = new Set();
  const seenModIds = new Set();
  function handleModerationEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    if (ev.id != null) {
      const modId = Number(ev.id);
      if (seenModIds.has(modId)) return;
      seenModIds.add(modId);
      if (seenModIds.size > 1000) {
        const oldest = seenModIds.values().next().value;
        seenModIds.delete(oldest);
      }
    }
    const accountId = Number(ev.accountId);
    if (ev.action === 'mute') {
      setMuteCache(accountId, ev.until == null ? FOREVER : Number(ev.until));
      return;
    }
    if (ev.action === 'unmute') {
      setMuteCache(accountId, null);
      return;
    }
    if (ev.action !== 'ban' && ev.action !== 'revoke') return;
    const event = { accountId, action: ev.action };
    for (const fn of listeners) {
      try {
        fn(event);
      } catch (err) {
        console.error('[accounts] moderation listener failed:', err.message);
      }
    }
  }

  let closed = false;
  const unsubscribeListen =
    typeof store.listenModeration === 'function' ? await store.listenModeration(handleModerationEvent) : null;

  const sweepTimer = setInterval(() => {
    if (!closed && typeof store.expireSessions === 'function') {
      store.expireSessions(now()).catch(() => {});
    }
  }, 3600_000);
  sweepTimer.unref();

  async function sessionFor(req) {
    const token = tokenFrom(req);
    if (!token) return null;
    const row = await store.getSession(sha256(token));
    if (!row) return null;
    const t = now();
    if (row.expires_at <= t || row.banned_at != null) {
      await store.deleteSessionById(row.sid);
      return null;
    }
    let renewed = false;
    if (t - row.last_seen_at >= cfg.sessionRenewAfterMs) {
      await store.touchSession(row.sid, t, t + cfg.sessionTtlMs);
      renewed = true;
    }
    return {
      token,
      renewed,
      sid: Number(row.sid),
      mutedUntil: row.muted_until,
      user: { id: Number(row.id), username: row.username },
    };
  }

  async function startSession(accountId) {
    const token = randomBytes(32).toString('base64url');
    await store.createSession(accountId, sha256(token), {
      ts: now(),
      ttlMs: cfg.sessionTtlMs,
      maxSessions: cfg.maxSessionsPerAccount,
    });
    return cookie(token, Math.floor(cfg.sessionTtlMs / 1000));
  }

  async function mutedPayload(id, preloadedUntil = undefined) {
    const until = preloadedUntil !== undefined ? preloadedUntil : await store.getMuteUntil(id);
    setMuteCache(id, until);
    if (until == null || until <= now()) return null;
    return { until: until === FOREVER ? null : until };
  }

  async function register(req, res) {
    const ip = clientIp(req);
    const body = await jsonBody(req);
    const { username, password } = body;
    const uProblem = usernameProblem(username);
    if (uProblem) return sendJson(res, 400, { error: uProblem, field: 'username' });
    const pProblem = passwordProblem(password, username, cfg);
    if (pProblem) return sendJson(res, 400, { error: pProblem, field: 'password' });
    const wait = limiters.register.check(ip);
    if (wait) return limited(res, wait, 'Too many new accounts from this network. Please try again later.');
    if (await store.find(username)) {
      return sendJson(res, 409, { error: 'That account name is taken.', field: 'username' });
    }
    const hash = await hashPassword(password, cfg.scrypt);
    const recoveryCode = generateRecoveryCode();
    const recoveryHash = hashRecoveryCode(recoveryCode);
    let acc;
    try {
      acc = await store.createAccount(username, hash, now(), recoveryHash);
    } catch (err) {
      if (err.code === '23505' || /UNIQUE|duplicate key/i.test(err.message)) {
        return sendJson(res, 409, { error: 'That account name is taken.', field: 'username' });
      }
      throw err;
    }
    limiters.register.hit(ip);
    const id = Number(acc.id);
    setMuteCache(id, null);
    const setCookie = await startSession(id);
    sendJson(res, 201, { user: { id, username: acc.username }, recoveryCode }, { 'Set-Cookie': setCookie });
  }

  async function login(req, res) {
    const ip = clientIp(req);
    const body = await jsonBody(req);
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
      return sendJson(res, 400, { error: 'Enter your account name and password.' });
    }
    if (username.length > 64 || password.length > cfg.maxPasswordLength * 4) {
      return sendJson(res, 401, { error: 'Incorrect account name or password.' });
    }
    const key = usernameKey(username);
    const wait = limiters.login.hit(ip) || limiters.loginName.check(key);
    if (wait) return limited(res, wait);
    const acc = await store.find(username);
    const ok = acc
      ? await verifyPassword(password, acc.password_hash)
      : (await verifyPassword(password, await dummyHash), false);
    if (!ok) {
      limiters.loginName.hit(key);
      return sendJson(res, 401, { error: 'Incorrect account name or password.' });
    }
    if (acc.banned_at != null) {
      return sendJson(res, 403, {
        error: acc.ban_reason ? `This account is banned: ${acc.ban_reason}` : 'This account is banned.',
      });
    }
    limiters.loginName.reset(key);
    setMuteCache(acc.id, acc.muted_until);
    const setCookie = await startSession(acc.id);
    sendJson(res, 200, { user: { id: acc.id, username: acc.username } }, { 'Set-Cookie': setCookie });
  }

  async function logout(req, res) {
    const token = tokenFrom(req);
    if (token) {
      const tokenHash = sha256(token);
      const row = await store.getSession(tokenHash);
      await store.deleteSessionByToken(tokenHash);
      if (row) endSession(Number(row.id), Number(row.sid), 'logout');
    }
    sendJson(res, 200, { user: null }, { 'Set-Cookie': cookie('', 0) });
  }

  async function logoutAll(req, res) {
    const s = await sessionFor(req);
    if (!s) return sendJson(res, 401, { error: 'Sign in first.' });
    const { sids, logId } = await store.revokeAccountSessions(s.user.id, {
      reason: 'self logout-all',
      actor: 'self',
      ts: now(),
    });
    handleModerationEvent({ id: logId, accountId: s.user.id, action: 'revoke' });
    for (const sid of sids) endSession(s.user.id, sid, 'logout-all');
    sendJson(res, 200, { user: null, revokedSessions: sids.length }, { 'Set-Cookie': cookie('', 0) });
  }

  async function verifyCurrentPassword(req, res, s, rawPassword, field = 'password') {
    if (typeof rawPassword !== 'string' || !rawPassword) {
      sendJson(res, 400, { error: 'Enter your current password.', field });
      return null;
    }
    if (rawPassword.length > cfg.maxPasswordLength * 4) {
      sendJson(res, 401, { error: 'Current password is incorrect.', field });
      return null;
    }
    const key = String(s.user.id);
    const wait = limiters.password.check(key);
    if (wait) {
      limited(res, wait);
      return null;
    }
    const acc = await store.get(s.user.id);
    if (!acc || acc.banned_at != null) {
      sendJson(res, 401, { error: 'Sign in first.' });
      return null;
    }
    const ok = await verifyPassword(rawPassword, acc.password_hash);
    if (!ok) {
      limiters.password.hit(key);
      sendJson(res, 401, { error: 'Current password is incorrect.', field });
      return null;
    }
    limiters.password.reset(key);
    return acc;
  }

  async function changePassword(req, res) {
    const s = await sessionFor(req);
    if (!s) return sendJson(res, 401, { error: 'Sign in first.' });
    const body = await jsonBody(req);
    const { currentPassword, newPassword } = body;
    const acc = await verifyCurrentPassword(req, res, s, currentPassword, 'currentPassword');
    if (!acc) return;
    const pProblem = passwordProblem(newPassword, acc.username, cfg);
    if (pProblem) return sendJson(res, 400, { error: pProblem, field: 'newPassword' });
    const newHash = await hashPassword(newPassword, cfg.scrypt);
    const otherSids = await store.changePasswordAndRevokeOthers(acc.id, newHash, s.sid);
    for (const sid of otherSids) endSession(acc.id, sid, 'password_change');
    sendJson(res, 200, { ok: true, user: s.user, revokedSessions: otherSids.length });
  }

  async function rotateRecoveryCode(req, res) {
    const s = await sessionFor(req);
    if (!s) return sendJson(res, 401, { error: 'Sign in first.' });
    const body = await jsonBody(req);
    const acc = await verifyCurrentPassword(req, res, s, body.password ?? body.currentPassword, 'password');
    if (!acc) return;
    const recoveryCode = generateRecoveryCode();
    await store.setRecoveryHash(acc.id, hashRecoveryCode(recoveryCode));
    sendJson(res, 200, { recoveryCode });
  }

  async function clearRecoveryCode(req, res) {
    const s = await sessionFor(req);
    if (!s) return sendJson(res, 401, { error: 'Sign in first.' });
    const body = await jsonBody(req);
    const acc = await verifyCurrentPassword(req, res, s, body.password ?? body.currentPassword, 'password');
    if (!acc) return;
    await store.setRecoveryHash(acc.id, null);
    sendJson(res, 200, { cleared: true });
  }

  async function deleteAccount(req, res) {
    const s = await sessionFor(req);
    if (!s) return sendJson(res, 401, { error: 'Sign in first.' });
    const body = await jsonBody(req);
    const acc = await verifyCurrentPassword(req, res, s, body.password ?? body.currentPassword, 'password');
    if (!acc) return;
    const sids = await store.deleteAccountAndSessions(acc.id);
    setMuteCache(acc.id, null);
    notifyAccountDelete(acc.id, acc.username);
    for (const sid of sids) endSession(acc.id, sid, 'account_deleted');
    sendJson(res, 200, { deleted: true, user: null }, { 'Set-Cookie': cookie('', 0) });
  }

  async function recover(req, res) {
    const ip = clientIp(req);
    const body = await jsonBody(req);
    const { username, recoveryCode, newPassword } = body;
    if (
      typeof username !== 'string' || !username ||
      typeof recoveryCode !== 'string' || !recoveryCode ||
      typeof newPassword !== 'string' || !newPassword
    ) {
      return sendJson(res, 400, { error: 'Enter your account name, recovery code, and new password.' });
    }
    const pProblem = passwordProblem(newPassword, username, cfg);
    if (pProblem) return sendJson(res, 400, { error: pProblem, field: 'newPassword' });
    if (username.length > 64 || recoveryCode.length > 128) {
      return sendJson(res, 401, { error: 'Incorrect account name or recovery code.' });
    }
    const key = usernameKey(username);
    const wait = limiters.recover.hit(ip) || limiters.recoverName.check(key);
    if (wait) return limited(res, wait);
    const acc = await store.find(username);
    const ok = verifyRecoveryCode(recoveryCode, acc?.recovery_hash ?? null);
    if (!ok) {
      limiters.recoverName.hit(key);
      return sendJson(res, 401, { error: 'Incorrect account name or recovery code.' });
    }
    if (acc.banned_at != null) {
      return sendJson(res, 403, {
        error: acc.ban_reason ? `This account is banned: ${acc.ban_reason}` : 'This account is banned.',
      });
    }
    limiters.recoverName.reset(key);
    const newHash = await hashPassword(newPassword, cfg.scrypt);
    const nextCode = generateRecoveryCode();
    const nextHash = hashRecoveryCode(nextCode);
    const { sids: oldSids, logId } = await store.recoverAccount(acc.id, newHash, nextHash, { ts: now() });
    handleModerationEvent({ id: logId, accountId: acc.id, action: 'revoke' });
    for (const sid of oldSids) endSession(acc.id, sid, 'recovery');
    setMuteCache(acc.id, acc.muted_until);
    const setCookie = await startSession(acc.id);
    sendJson(
      res,
      200,
      { user: { id: acc.id, username: acc.username }, recoveryCode: nextCode },
      { 'Set-Cookie': setCookie },
    );
  }

  async function me(req, res) {
    const s = await sessionFor(req);
    const headers = {};
    if (!s && tokenFrom(req)) headers['Set-Cookie'] = cookie('', 0); // drop a dead cookie
    if (s?.renewed) headers['Set-Cookie'] = cookie(s.token, Math.floor(cfg.sessionTtlMs / 1000));
    const muted = s ? await mutedPayload(s.user.id, s.mutedUntil) : null;
    sendJson(res, 200, { user: s ? s.user : null, ...(muted ? { muted } : {}) }, headers);
  }

  const routes = {
    '/api/me': { GET: me, HEAD: me },
    '/api/register': { POST: register },
    '/api/login': { POST: login },
    '/api/logout': { POST: logout },
    '/api/logout-all': { POST: logoutAll },
    '/api/password': { POST: changePassword },
    '/api/delete-account': { POST: deleteAccount },
    '/api/recovery-code': { POST: rotateRecoveryCode },
    '/api/clear-recovery': { POST: clearRecoveryCode },
    '/api/recover': { POST: recover },
  };

  const handleHttp = createHttpDispatcher(routes, http, limiters, cfg);

  return {
    config: cfg,
    cookieName,
    store,
    handleHttp,
    async resolveUpgrade(req) {
      try {
        const s = await sessionFor(req);
        if (!s) return null;
        const mutedUntil = s.mutedUntil !== undefined ? s.mutedUntil : await store.getMuteUntil(s.user.id);
        setMuteCache(s.user.id, mutedUntil);
        trackSocket(s.sid, req.socket);
        return { ...s.user, sessionKey: String(s.sid) };
      } catch (err) {
        console.error('[accounts] session lookup failed:', err.message);
        return null;
      }
    },
    isMuted(accountId) {
      const key = String(accountId);
      const until = muteCache.get(key);
      if (until == null) return false;
      if (until <= now()) {
        muteCache.delete(key);
        return false;
      }
      return true;
    },
    onSessionEnd(fn) {
      sessionListeners.add(fn);
      return () => sessionListeners.delete(fn);
    },
    onAccountDelete(fn) {
      deleteListeners.add(fn);
      return () => deleteListeners.delete(fn);
    },
    onModeration(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async mute(name, opts) {
      const r = await store.mute(name, opts);
      handleModerationEvent({ id: r.logId, accountId: r.id, action: 'mute', until: r.mutedUntil });
      return r;
    },
    async unmute(name, opts) {
      const r = await store.unmute(name, opts);
      handleModerationEvent({ id: r.logId, accountId: r.id, action: 'unmute' });
      return r;
    },
    async ban(name, opts) {
      const r = await store.ban(name, opts);
      handleModerationEvent({ id: r.logId, accountId: r.id, action: 'ban' });
      return r;
    },
    async unban(name, opts) {
      return store.unban(name, opts);
    },
    async revokeSessions(name, opts) {
      const r = await store.revokeSessions(name, opts);
      handleModerationEvent({ id: r.logId, accountId: r.id, action: 'revoke' });
      return r;
    },
    async find(name) {
      const a = await store.find(name);
      return a && { id: a.id, username: a.username };
    },
    async listBannedAccountIds() {
      if (store.pool && typeof store.pool.query === 'function') {
        const res = await store.pool.query('SELECT id FROM accounts WHERE banned_at IS NOT NULL');
        return (res?.rows ?? []).map((r) => String(r.id));
      }
      return [];
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(sweepTimer);
      if (typeof unsubscribeListen === 'function') {
        await unsubscribeListen();
      }
      listeners.clear();
      sessionListeners.clear();
      deleteListeners.clear();
      sessionSockets.clear();
      muteCache.clear();
      seenModIds.clear();
      if (ownsStore && typeof store.close === 'function') {
        await store.close();
      }
    },
  };
}

// ---------------------------------------------------------------- operator CLI

const USAGE = `usage: node server/accounts.js <command>
  list                          all accounts with status
  show <name>                   one account and its recent moderation log
  mute <name> [minutes] [reason]  mute chat (no minutes or 0 = until unmuted)
  unmute <name>
  ban <name> [reason]           refuse login and WebSocket entry; ends all sessions
  unban <name>
  revoke <name>                 sign the account out everywhere
env: ACCOUNTS_DB_PATH (default server/data/accounts.db)`;

function fmtTime(ms) {
  if (ms == null) return '-';
  if (ms >= FOREVER) return 'permanent';
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

export function runCli(argv, { dbPath, out = console.log, now = () => Date.now() } = {}) {
  const [cmd, name, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    out(USAGE);
    return 0;
  }
  const store = openAccountStore(dbPath);
  const mod = moderation(store, now);
  const actor = `cli:${process.env.USER || 'operator'}`;
  try {
    switch (cmd) {
      case 'list': {
        const rows = store.q.list.all(now());
        if (!rows.length) out('(no accounts)');
        for (const a of rows) {
          const flags = [];
          if (a.banned_at != null) flags.push('BANNED');
          if (a.muted_until != null && a.muted_until > now()) flags.push(`muted until ${fmtTime(a.muted_until)}`);
          out(`${String(a.id).padStart(5)}  ${a.username.padEnd(20)}  sessions=${a.sessions}  last=${fmtTime(a.last_login_at)}  ${flags.join(', ')}`);
        }
        return 0;
      }
      case 'show': {
        const a = name && store.find(name);
        if (!a) throw new Error(`no account named ${JSON.stringify(name)}`);
        out(`id ${a.id}  ${a.username}`);
        out(`created ${fmtTime(a.created_at)}  last login ${fmtTime(a.last_login_at)}`);
        out(`banned ${a.banned_at != null ? `${fmtTime(a.banned_at)} (${a.ban_reason ?? 'no reason'})` : 'no'}`);
        out(`muted ${a.muted_until != null && a.muted_until > now() ? `until ${fmtTime(a.muted_until)} (${a.mute_reason ?? 'no reason'})` : 'no'}`);
        const log = store.db
          .prepare('SELECT * FROM moderation_log WHERE account_id = ? ORDER BY id DESC LIMIT 20')
          .all(a.id);
        for (const l of log) out(`  ${fmtTime(l.at)}  ${l.action}  ${l.reason ?? ''}  by ${l.actor}`);
        return 0;
      }
      case 'mute': {
        const minutes = rest[0] !== undefined && /^\d+(\.\d+)?$/.test(rest[0]) ? Number(rest.shift()) : null;
        const r = mod.mute(name, { minutes: minutes || null, reason: rest.join(' ') || null, actor });
        out(`muted ${r.username} ${r.mutedUntil ? `until ${fmtTime(r.mutedUntil)}` : 'until unmuted'}`);
        return 0;
      }
      case 'unmute':
        out(`unmuted ${mod.unmute(name, { actor }).username}`);
        return 0;
      case 'ban':
        out(`banned ${mod.ban(name, { reason: rest.join(' ') || null, actor }).username}; sessions revoked`);
        return 0;
      case 'unban':
        out(`unbanned ${mod.unban(name, { actor }).username}`);
        return 0;
      case 'revoke': {
        const r = mod.revokeSessions(name, { actor });
        out(`revoked ${r.revoked} session(s) for ${r.username}`);
        return 0;
      }
      default:
        out(USAGE);
        return 2;
    }
  } catch (err) {
    out(`error: ${err.message}`);
    return 1;
  } finally {
    // No checkpoint here: the running server owns the WAL and checkpoints on its own shutdown.
    if (store.db.isOpen) store.db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbPath = process.env.ACCOUNTS_DB_PATH ? resolve(process.env.ACCOUNTS_DB_PATH) : ACCOUNT_DEFAULTS.dbPath;
  process.exitCode = runCli(process.argv.slice(2), { dbPath });
}
