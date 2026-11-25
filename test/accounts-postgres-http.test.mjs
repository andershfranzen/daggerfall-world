// Full HTTP, WebSocket-upgrade, lifecycle, and LISTEN/NOTIFY moderation test suite
// for createPostgresAccounts (PostgreSQL accounts runtime).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import {
  createPostgresAccounts,
  COOKIE_SECURE,
  COOKIE_INSECURE,
} from '../server/accounts.js';
import {
  createPostgresAccounts as reExportedCreatePostgresAccounts,
  openPostgresAccountStore,
} from '../server/storage/index.js';

const FAST_SCRYPT = { N: 2 ** 10, r: 8, p: 1, keyLen: 32 };
const PW1 = 'first lantern at dawn';
const PW2 = 'second lantern at dusk';
const PW3 = 'third lantern by midnight';

/**
 * In-memory mock PostgreSQL Pool + Client supporting full accounts, sessions,
 * moderation_log, transactions (BEGIN/COMMIT/ROLLBACK), unique constraints (23505),
 * ON DELETE CASCADE, and LISTEN/UNLISTEN + pg_notify() fan-out on COMMIT.
 */
function createMockAccountsPgPool() {
  let state = {
    schemaApplied: 0,
    accounts: new Map(), // id -> row
    sessions: new Map(), // id -> row
    moderationLog: new Map(), // id -> row
    seqs: { accounts: 0, sessions: 0, moderation_log: 0 },
  };

  const listeners = new Map(); // channel -> Set<client>
  let ended = false;

  function cloneState(s) {
    return {
      schemaApplied: s.schemaApplied,
      accounts: new Map([...s.accounts].map(([k, v]) => [k, structuredClone(v)])),
      sessions: new Map([...s.sessions].map(([k, v]) => [k, structuredClone(v)])),
      moderationLog: new Map([...s.moderationLog].map(([k, v]) => [k, structuredClone(v)])),
      seqs: { ...s.seqs },
    };
  }

  function uniqueError(constraint) {
    const err = new Error(`duplicate key value violates unique constraint "${constraint}"`);
    err.code = '23505';
    return err;
  }

  function deliverNotifications(notifications) {
    for (const { channel, payload } of notifications) {
      const set = listeners.get(channel);
      if (!set) continue;
      for (const client of set) {
        client.emit('notification', { channel, payload });
      }
    }
  }

  async function executeSql(rawSql, params = [], clientCtx = null) {
    const sql = rawSql.replace(/\s+/g, ' ').trim();

    if (/^BEGIN$/i.test(sql)) {
      clientCtx.txSnapshot = cloneState(state);
      clientCtx.pendingNotifications = [];
      return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT$/i.test(sql)) {
      const pending = clientCtx.pendingNotifications ?? [];
      clientCtx.txSnapshot = null;
      clientCtx.pendingNotifications = [];
      deliverNotifications(pending);
      return { rows: [], rowCount: 0 };
    }
    if (/^ROLLBACK$/i.test(sql)) {
      if (clientCtx.txSnapshot) {
        state = clientCtx.txSnapshot;
        clientCtx.txSnapshot = null;
      }
      clientCtx.pendingNotifications = [];
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 }; // single-process mock: no contention

    if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      state.schemaApplied += 1;
      return { rows: [], rowCount: 0 };
    }

    const listenMatch = /^LISTEN\s+([a-zA-Z0-9_]+)$/i.exec(sql);
    if (listenMatch) {
      const ch = listenMatch[1];
      if (!listeners.has(ch)) listeners.set(ch, new Set());
      listeners.get(ch).add(clientCtx.client);
      return { rows: [], rowCount: 0 };
    }
    const unlistenMatch = /^UNLISTEN\s+([a-zA-Z0-9_]+)$/i.exec(sql);
    if (unlistenMatch) {
      listeners.get(unlistenMatch[1])?.delete(clientCtx.client);
      return { rows: [], rowCount: 0 };
    }

    if (/^SELECT pg_notify\(\$1, \$2\)$/i.test(sql)) {
      const note = { channel: params[0], payload: params[1] };
      if (clientCtx?.txSnapshot) clientCtx.pendingNotifications.push(note);
      else deliverNotifications([note]);
      return { rows: [{ pg_notify: '' }], rowCount: 1 };
    }

    // ---- accounts ----

    if (sql.startsWith('INSERT INTO accounts (username, username_key, password_hash, created_at, recovery_hash)')) {
      const [username, username_key, password_hash, created_at, recovery_hash] = params;
      for (const a of state.accounts.values()) {
        if (a.username_key === username_key) throw uniqueError('accounts_username_key_key');
      }
      const id = ++state.seqs.accounts;
      const row = {
        id: String(id),
        username,
        username_key,
        password_hash,
        recovery_hash: recovery_hash ?? null,
        created_at: String(created_at),
        last_login_at: null,
        muted_until: null,
        mute_reason: null,
        banned_at: null,
        ban_reason: null,
      };
      state.accounts.set(id, row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }

    if (sql.startsWith('INSERT INTO accounts (username, username_key, password_hash, created_at)')) {
      const [username, username_key, password_hash, created_at] = params;
      for (const a of state.accounts.values()) {
        if (a.username_key === username_key) throw uniqueError('accounts_username_key_key');
      }
      const id = ++state.seqs.accounts;
      const row = {
        id: String(id),
        username,
        username_key,
        password_hash,
        recovery_hash: null,
        created_at: String(created_at),
        last_login_at: null,
        muted_until: null,
        mute_reason: null,
        banned_at: null,
        ban_reason: null,
      };
      state.accounts.set(id, row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }

    if (sql === 'SELECT * FROM accounts WHERE username_key = $1') {
      for (const a of state.accounts.values()) {
        if (a.username_key === params[0]) return { rows: [structuredClone(a)], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql === 'SELECT * FROM accounts WHERE id = $1') {
      const a = state.accounts.get(Number(params[0]));
      return { rows: a ? [structuredClone(a)] : [], rowCount: a ? 1 : 0 };
    }

    if (sql === 'UPDATE accounts SET last_login_at = $1 WHERE id = $2') {
      const a = state.accounts.get(Number(params[1]));
      if (a) a.last_login_at = String(params[0]);
      return { rows: [], rowCount: a ? 1 : 0 };
    }

    if (sql === 'UPDATE accounts SET password_hash = $1 WHERE id = $2') {
      const a = state.accounts.get(Number(params[1]));
      if (a) a.password_hash = params[0];
      return { rows: [], rowCount: a ? 1 : 0 };
    }

    if (sql === 'UPDATE accounts SET recovery_hash = $1 WHERE id = $2') {
      const a = state.accounts.get(Number(params[1]));
      if (a) a.recovery_hash = params[0] ?? null;
      return { rows: [], rowCount: a ? 1 : 0 };
    }

    if (sql === 'UPDATE accounts SET password_hash = $1, recovery_hash = $2 WHERE id = $3') {
      const a = state.accounts.get(Number(params[2]));
      if (a) {
        a.password_hash = params[0];
        a.recovery_hash = params[1] ?? null;
      }
      return { rows: [], rowCount: a ? 1 : 0 };
    }

    if (sql === 'UPDATE accounts SET password_hash = $1, recovery_hash = $2 WHERE id = $3 AND recovery_hash = $4') {
      const a = state.accounts.get(Number(params[2]));
      const hit = !!a && a.recovery_hash === params[3];
      if (hit) {
        a.password_hash = params[0];
        a.recovery_hash = params[1] ?? null;
      }
      return { rows: [], rowCount: hit ? 1 : 0 };
    }

    if (sql === 'DELETE FROM accounts WHERE id = $1') {
      const accId = Number(params[0]);
      const existed = state.accounts.delete(accId);
      if (existed) {
        for (const [sid, s] of state.sessions) {
          if (Number(s.account_id) === accId) state.sessions.delete(sid);
        }
        for (const [mid, m] of state.moderationLog) {
          if (Number(m.account_id) === accId) state.moderationLog.delete(mid);
        }
      }
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    if (sql === 'SELECT muted_until FROM accounts WHERE id = $1') {
      const a = state.accounts.get(Number(params[0]));
      return { rows: a ? [{ muted_until: a.muted_until }] : [], rowCount: a ? 1 : 0 };
    }

    if (sql === 'UPDATE accounts SET muted_until = $1, mute_reason = $2 WHERE id = $3') {
      const a = state.accounts.get(Number(params[2]));
      if (a) {
        a.muted_until = params[0] == null ? null : String(params[0]);
        a.mute_reason = params[1];
      }
      return { rows: [], rowCount: a ? 1 : 0 };
    }

    if (sql === 'UPDATE accounts SET muted_until = NULL, mute_reason = NULL WHERE id = $1') {
      const a = state.accounts.get(Number(params[0]));
      if (a) {
        a.muted_until = null;
        a.mute_reason = null;
      }
      return { rows: [], rowCount: a ? 1 : 0 };
    }

    if (sql === 'UPDATE accounts SET banned_at = $1, ban_reason = $2 WHERE id = $3') {
      const a = state.accounts.get(Number(params[2]));
      if (a) {
        a.banned_at = String(params[0]);
        a.ban_reason = params[1];
      }
      return { rows: [], rowCount: a ? 1 : 0 };
    }

    if (sql === 'UPDATE accounts SET banned_at = NULL, ban_reason = NULL WHERE id = $1') {
      const a = state.accounts.get(Number(params[0]));
      if (a) {
        a.banned_at = null;
        a.ban_reason = null;
      }
      return { rows: [], rowCount: a ? 1 : 0 };
    }

    // ---- sessions ----

    if (sql.startsWith('INSERT INTO sessions (token_hash, account_id, created_at, last_seen_at, expires_at)')) {
      const [token_hash, account_id, created_at, last_seen_at, expires_at] = params;
      for (const s of state.sessions.values()) {
        if (s.token_hash === token_hash) throw uniqueError('sessions_token_hash_key');
      }
      const id = ++state.seqs.sessions;
      const row = {
        id: String(id),
        token_hash,
        account_id: String(account_id),
        created_at: String(created_at),
        last_seen_at: String(last_seen_at),
        expires_at: String(expires_at),
      };
      state.sessions.set(id, row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    if (sql.startsWith('DELETE FROM sessions WHERE account_id = $1 AND id NOT IN')) {
      const [accountId, limit] = params;
      const owned = [...state.sessions.values()]
        .filter((s) => Number(s.account_id) === Number(accountId))
        .sort((a, b) => Number(b.last_seen_at) - Number(a.last_seen_at) || Number(b.id) - Number(a.id));
      const keep = new Set(owned.slice(0, Number(limit)).map((s) => Number(s.id)));
      let deleted = 0;
      for (const s of owned) {
        if (!keep.has(Number(s.id))) {
          state.sessions.delete(Number(s.id));
          deleted += 1;
        }
      }
      return { rows: [], rowCount: deleted };
    }

    if (sql.includes('FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = $1')) {
      for (const s of state.sessions.values()) {
        if (s.token_hash === params[0]) {
          const a = state.accounts.get(Number(s.account_id));
          if (!a) return { rows: [], rowCount: 0 };
          return {
            rows: [
              {
                sid: s.id,
                last_seen_at: s.last_seen_at,
                expires_at: s.expires_at,
                id: a.id,
                username: a.username,
                banned_at: a.banned_at,
                muted_until: a.muted_until,
              },
            ],
            rowCount: 1,
          };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql === 'SELECT id FROM sessions WHERE account_id = $1') {
      const rows = [...state.sessions.values()]
        .filter((s) => Number(s.account_id) === Number(params[0]))
        .map((s) => ({ id: s.id }));
      return { rows, rowCount: rows.length };
    }

    if (sql === 'SELECT id FROM sessions WHERE account_id = $1 AND id <> $2') {
      const rows = [...state.sessions.values()]
        .filter((s) => Number(s.account_id) === Number(params[0]) && Number(s.id) !== Number(params[1]))
        .map((s) => ({ id: s.id }));
      return { rows, rowCount: rows.length };
    }

    if (sql === 'UPDATE sessions SET last_seen_at = $1, expires_at = $2 WHERE id = $3') {
      const s = state.sessions.get(Number(params[2]));
      if (s) {
        s.last_seen_at = String(params[0]);
        s.expires_at = String(params[1]);
      }
      return { rows: [], rowCount: s ? 1 : 0 };
    }

    if (sql === 'DELETE FROM sessions WHERE token_hash = $1') {
      let deleted = 0;
      for (const [id, s] of state.sessions) {
        if (s.token_hash === params[0]) {
          state.sessions.delete(id);
          deleted += 1;
        }
      }
      return { rows: [], rowCount: deleted };
    }

    if (sql === 'DELETE FROM sessions WHERE id = $1') {
      const existed = state.sessions.delete(Number(params[0]));
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    if (sql === 'DELETE FROM sessions WHERE account_id = $1 AND id <> $2') {
      let deleted = 0;
      for (const [id, s] of state.sessions) {
        if (Number(s.account_id) === Number(params[0]) && Number(s.id) !== Number(params[1])) {
          state.sessions.delete(id);
          deleted += 1;
        }
      }
      return { rows: [], rowCount: deleted };
    }

    if (sql === 'DELETE FROM sessions WHERE account_id = $1') {
      let deleted = 0;
      for (const [id, s] of state.sessions) {
        if (Number(s.account_id) === Number(params[0])) {
          state.sessions.delete(id);
          deleted += 1;
        }
      }
      return { rows: [], rowCount: deleted };
    }

    if (sql === 'DELETE FROM sessions WHERE expires_at <= $1') {
      const ts = Number(params[0]);
      let deleted = 0;
      for (const [id, s] of state.sessions) {
        if (Number(s.expires_at) <= ts) {
          state.sessions.delete(id);
          deleted += 1;
        }
      }
      return { rows: [], rowCount: deleted };
    }

    // ---- moderation_log ----

    if (sql.startsWith('INSERT INTO moderation_log (account_id, action, reason, until, actor, at)')) {
      const id = ++state.seqs.moderation_log;
      let row;
      if (sql.includes("'mute'")) {
        const [account_id, reason, until, actor, at] = params;
        row = { id: String(id), account_id: String(account_id), action: 'mute', reason, until: until == null ? null : String(until), actor, at: String(at) };
      } else if (sql.includes("'unmute'")) {
        const [account_id, actor, at] = params;
        row = { id: String(id), account_id: String(account_id), action: 'unmute', reason: null, until: null, actor, at: String(at) };
      } else if (sql.includes("'ban'")) {
        const [account_id, reason, actor, at] = params;
        row = { id: String(id), account_id: String(account_id), action: 'ban', reason, until: null, actor, at: String(at) };
      } else if (sql.includes("'unban'")) {
        const [account_id, actor, at] = params;
        row = { id: String(id), account_id: String(account_id), action: 'unban', reason: null, until: null, actor, at: String(at) };
      } else if (sql.includes("'revoke'") && params.length === 4) {
        const [account_id, reason, actor, at] = params;
        row = { id: String(id), account_id: String(account_id), action: 'revoke', reason, until: null, actor, at: String(at) };
      } else if (sql.includes("'revoke'")) {
        const [account_id, actor, at] = params;
        row = { id: String(id), account_id: String(account_id), action: 'revoke', reason: null, until: null, actor, at: String(at) };
      } else {
        throw new Error(`Unhandled moderation_log SQL: ${sql}`);
      }
      state.moderationLog.set(id, row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    throw new Error(`MockAccountsPgPool: unhandled SQL: ${sql}`);
  }

  return {
    get state() {
      return state;
    },
    get ended() {
      return ended;
    },
    get listenerCount() {
      let n = 0;
      for (const s of listeners.values()) n += s.size;
      return n;
    },
    async query(sql, params = []) {
      return executeSql(sql, params, null);
    },
    async connect() {
      const client = new EventEmitter();
      const ctx = { client, txSnapshot: null, pendingNotifications: [] };
      client.query = (sql, params = []) => executeSql(sql, params, ctx);
      client.release = () => {
        for (const set of listeners.values()) set.delete(client);
      };
      return client;
    },
    async end() {
      ended = true;
    },
  };
}

async function createHarness(opts = {}) {
  const pool = opts.pool ?? createMockAccountsPgPool();
  const accounts = await createPostgresAccounts({
    pool,
    scrypt: FAST_SCRYPT,
    limits: {
      api: [500, 60_000],
      login: [100, 60_000],
      register: [100, 60_000],
      password: [100, 60_000],
      recover: [100, 60_000],
      recoverName: [100, 60_000],
      ...(opts.limits ?? {}),
    },
    ...opts,
  });

  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) return accounts.handleHttp(req, res);
    if (req.url === '/whoami') {
      const user = await accounts.resolveUpgrade(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ user }));
    }
    res.writeHead(404).end();
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    pool,
    accounts,
    base,
    async stop() {
      await new Promise((r) => server.close(r));
      await accounts.close();
    },
    async api(path, { method = 'POST', body, jar, headers = {} } = {}) {
      const h = { Origin: base, ...headers };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (jar?.cookie) h.Cookie = jar.cookie;
      const res = await fetch(base + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (jar && setCookie) {
        const [pair] = setCookie.split(';');
        const value = pair.slice(pair.indexOf('=') + 1);
        jar.cookie = value ? pair : '';
        jar.raw = setCookie;
      }
      const text = await res.text();
      return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null, setCookie };
    },
  };
}

describe('createPostgresAccounts exports & lifecycle storage methods', () => {
  it('is re-exported from server/storage/index.js and reports backend: postgres', async () => {
    assert.equal(reExportedCreatePostgresAccounts, createPostgresAccounts);
    const pool = createMockAccountsPgPool();
    const accounts = await createPostgresAccounts({
      pool,
      scrypt: FAST_SCRYPT,
      trustProxy: true,
      requireHttps: true,
      publicOrigin: 'https://play.example.org',
      secureCookies: true,
    });
    assert.equal(accounts.config.backend, 'postgres');
    assert.equal(accounts.config.trustProxy, true);
    assert.equal(accounts.config.requireHttps, true);
    assert.equal(accounts.config.publicOrigin, 'https://play.example.org');
    assert.equal(accounts.config.secureCookies, true);
    assert.equal(accounts.cookieName, COOKIE_SECURE);
    assert.equal(pool.listenerCount, 1);

    await accounts.close();
    assert.equal(pool.listenerCount, 0);
    assert.equal(pool.ended, false); // injected pool is not closed
  });

  it('postgres-accounts store exposes all lifecycle methods directly', async () => {
    const pool = createMockAccountsPgPool();
    const store = await openPostgresAccountStore({ pool, now: () => 1_000_000 });

    const acc = await store.createAccount('Barenziah', 'hash1', 1_000_000, 'a'.repeat(64));
    assert.equal(acc.recovery_hash, 'a'.repeat(64));

    await store.setPassword(acc.id, 'hash2');
    assert.equal((await store.get(acc.id)).password_hash, 'hash2');

    await store.setRecoveryHash(acc.id, 'b'.repeat(64));
    assert.equal((await store.get(acc.id)).recovery_hash, 'b'.repeat(64));

    await store.setPasswordAndRecovery(acc.id, 'hash3', 'c'.repeat(64));
    const updated = await store.get(acc.id);
    assert.equal(updated.password_hash, 'hash3');
    assert.equal(updated.recovery_hash, 'c'.repeat(64));

    // recoverAccount spends the code only while it is still the stored one.
    assert.equal(await store.recoverAccount(acc.id, 'hashX', 'd'.repeat(64), { expectedRecoveryHash: 'b'.repeat(64) }), null);
    assert.equal((await store.get(acc.id)).password_hash, 'hash3');
    const spent = await store.recoverAccount(acc.id, 'hash4', 'd'.repeat(64), { expectedRecoveryHash: 'c'.repeat(64) });
    assert.ok(spent?.logId);
    assert.equal((await store.get(acc.id)).recovery_hash, 'd'.repeat(64));
    assert.equal(await store.recoverAccount(acc.id, 'hash5', 'e'.repeat(64), { expectedRecoveryHash: 'c'.repeat(64) }), null);

    const s1 = await store.createSession(acc.id, 't1', { ts: 1_000_000 });
    const s2 = await store.createSession(acc.id, 't2', { ts: 1_000_001 });
    const s3 = await store.createSession(acc.id, 't3', { ts: 1_000_002 });

    assert.deepEqual((await store.listSessionIds(acc.id)).sort(), [s1.sid, s2.sid, s3.sid].sort());
    assert.deepEqual((await store.listOtherSessionIds(acc.id, s2.sid)).sort(), [s1.sid, s3.sid].sort());

    assert.equal(await store.deleteOtherSessions(acc.id, s2.sid), 2);
    assert.deepEqual(await store.listSessionIds(acc.id), [s2.sid]);

    assert.equal(await store.getMuteUntil(acc.id), null);
    await store.mute('Barenziah', { minutes: 5 });
    assert.equal(await store.getMuteUntil(acc.id), 1_000_000 + 5 * 60_000);

    assert.equal(await store.deleteAccount(acc.id), 1);
    assert.equal(await store.get(acc.id), null);
    assert.deepEqual(await store.listSessionIds(acc.id), []);

    await store.close();
  });
});

describe('createPostgresAccounts HTTP API (all 10 endpoints)', () => {
  let h;
  before(async () => {
    h = await createHarness();
  });
  after(async () => {
    await h.stop();
  });

  it('GET and HEAD /api/me without session', async () => {
    const r = await h.api('/api/me', { method: 'GET' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { user: null });
    assert.equal(r.headers.get('cache-control'), 'no-store');

    const head = await fetch(h.base + '/api/me', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });

  it('POST /api/register validates input, sets cookie, stores SHA-256 recovery_hash, enforces uniqueness', async () => {
    // Validation errors
    let bad = await h.api('/api/register', { body: { username: 'ab', password: PW1 } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.field, 'username');

    bad = await h.api('/api/register', { body: { username: 'Cyrus', password: 'short' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.field, 'password');

    // Successful registration
    const jar = {};
    const reg = await h.api('/api/register', { body: { username: 'Cyrus', password: PW1 }, jar });
    assert.equal(reg.status, 201);
    assert.equal(reg.json.user.username, 'Cyrus');
    assert.ok(Number.isInteger(reg.json.user.id));
    assert.match(reg.json.recoveryCode, /^[0-9A-F]{4}(-[0-9A-F]{4}){7}$/);
    assert.ok(reg.setCookie.startsWith(`${COOKIE_SECURE}=`));
    for (const attr of ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure']) {
      assert.ok(reg.setCookie.includes(attr), attr);
    }

    // Stored recovery_hash is SHA-256, never plaintext
    const storedAcc = await h.accounts.store.get(reg.json.user.id);
    assert.match(storedAcc.recovery_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(storedAcc.recovery_hash, reg.json.recoveryCode);

    // /api/me and /whoami (resolveUpgrade) resolve the session
    const me = await h.api('/api/me', { method: 'GET', jar });
    assert.deepEqual(me.json, { user: reg.json.user });
    const who = await fetch(h.base + '/whoami', { headers: { Cookie: jar.cookie } }).then((x) => x.json());
    assert.deepEqual({ id: who.user.id, username: who.user.username }, reg.json.user);
    assert.match(who.user.sessionKey, /^\d+$/);

    // Case-insensitive duplicate rejected with 409
    const dup = await h.api('/api/register', { body: { username: 'cYRUS', password: PW1 } });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.field, 'username');
  });

  it('POST /api/login handles success, wrong password, unknown user, and POST /api/logout revokes only that session', async () => {
    const jarA = {};
    const jarB = {};
    const ok = await h.api('/api/login', { body: { username: 'cyrus', password: PW1 }, jar: jarA });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.username, 'Cyrus');

    await h.api('/api/login', { body: { username: 'Cyrus', password: PW1 }, jar: jarB });

    const bad = await h.api('/api/login', { body: { username: 'Cyrus', password: 'wrong password!' } });
    const unknown = await h.api('/api/login', { body: { username: 'Nobody', password: 'wrong password!' } });
    assert.equal(bad.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(bad.json.error, unknown.json.error);

    const keyA = (await h.accounts.resolveUpgrade({ headers: { cookie: jarA.cookie } })).sessionKey;
    const keyB = (await h.accounts.resolveUpgrade({ headers: { cookie: jarB.cookie } })).sessionKey;
    assert.notEqual(keyA, keyB);

    const ended = [];
    const off = h.accounts.onSessionEnd((e) => ended.push(e));
    const stolenA = jarA.cookie;
    const out = await h.api('/api/logout', { jar: jarA });
    off();

    assert.equal(out.status, 200);
    assert.match(out.setCookie, /Max-Age=0/);
    assert.deepEqual(ended, [{ accountId: ok.json.user.id, sessionKey: keyA, reason: 'logout' }]);

    // Replayed stolen cookie fails and is cleared
    const replay = await h.api('/api/me', { method: 'GET', jar: { cookie: stolenA } });
    assert.equal(replay.json.user, null);
    assert.match(replay.setCookie ?? '', /Max-Age=0/);

    // Session B remains active
    assert.equal((await h.accounts.resolveUpgrade({ headers: { cookie: jarB.cookie } })).sessionKey, keyB);
  });

  it('POST /api/password updates hash and revokes only other sessions with onSessionEnd', async () => {
    const jarA = {};
    const jarB = {};
    await h.api('/api/login', { body: { username: 'Cyrus', password: PW1 }, jar: jarA });
    await h.api('/api/login', { body: { username: 'Cyrus', password: PW1 }, jar: jarB });

    assert.equal((await h.api('/api/password', { body: { currentPassword: PW1, newPassword: PW2 } })).status, 401);
    assert.equal((await h.api('/api/password', { body: { currentPassword: 'wrong password!', newPassword: PW2 }, jar: jarA })).status, 401);
    assert.equal((await h.api('/api/password', { body: { currentPassword: PW1, newPassword: 'short' }, jar: jarA })).status, 400);

    const keyB = (await h.accounts.resolveUpgrade({ headers: { cookie: jarB.cookie } })).sessionKey;
    const ended = [];
    const off = h.accounts.onSessionEnd((e) => ended.push(e));
    const res = await h.api('/api/password', { body: { currentPassword: PW1, newPassword: PW2 }, jar: jarA });
    off();

    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.ok(res.json.revokedSessions >= 1);
    assert.ok(ended.some((e) => e.sessionKey === keyB && e.reason === 'password_change'));

    // Session B revoked, Session A still valid
    assert.equal((await h.api('/api/me', { method: 'GET', jar: jarB })).json.user, null);
    assert.equal((await h.api('/api/me', { method: 'GET', jar: jarA })).json.user.username, 'Cyrus');

    // Old password fails, new password works
    assert.equal((await h.api('/api/login', { body: { username: 'Cyrus', password: PW1 } })).status, 401);
    assert.equal((await h.api('/api/login', { body: { username: 'Cyrus', password: PW2 } })).status, 200);
  });

  it('POST /api/logout-all revokes all sessions, clears cookie, and fires onSessionEnd + onModeration once', async () => {
    const jarA = {};
    const jarB = {};
    await h.api('/api/login', { body: { username: 'Cyrus', password: PW2 }, jar: jarA });
    await h.api('/api/login', { body: { username: 'Cyrus', password: PW2 }, jar: jarB });
    const cookieA = jarA.cookie;
    const cookieB = jarB.cookie;

    assert.equal((await h.api('/api/logout-all', {})).status, 401);

    const ended = [];
    const modEvents = [];
    const offS = h.accounts.onSessionEnd((e) => ended.push(e));
    const offM = h.accounts.onModeration((e) => modEvents.push(e));
    const res = await h.api('/api/logout-all', { jar: jarA });
    offS();
    offM();

    assert.equal(res.status, 200);
    assert.equal(res.json.user, null);
    assert.ok(res.json.revokedSessions >= 2);
    assert.match(res.setCookie, /Max-Age=0/);
    assert.equal(ended.length, res.json.revokedSessions);
    assert.ok(ended.every((e) => e.reason === 'logout-all'));
    assert.equal(modEvents.length, 1);
    assert.equal(modEvents[0].action, 'revoke');

    assert.equal(await h.accounts.resolveUpgrade({ headers: { cookie: cookieA } }), null);
    assert.equal(await h.accounts.resolveUpgrade({ headers: { cookie: cookieB } }), null);
  });

  it('POST /api/recovery-code, /api/recover, and /api/clear-recovery full lifecycle', async () => {
    const jar = {};
    const reg = await h.api('/api/register', { body: { username: 'Symmachus', password: PW1 }, jar });
    const code1 = reg.json.recoveryCode;
    const oldCookie = jar.cookie;

    // Rotate recovery code
    assert.equal((await h.api('/api/recovery-code', { body: { password: 'wrong password!' }, jar })).status, 401);
    const rot = await h.api('/api/recovery-code', { body: { password: PW1 }, jar });
    assert.equal(rot.status, 200);
    const code2 = rot.json.recoveryCode;
    assert.notEqual(code2, code1);

    // Old code fails with same error as unknown username
    const badOld = await h.api('/api/recover', { body: { username: 'Symmachus', recoveryCode: code1, newPassword: PW2 } });
    const badUser = await h.api('/api/recover', { body: { username: 'Ghost', recoveryCode: code2, newPassword: PW2 } });
    assert.equal(badOld.status, 401);
    assert.equal(badUser.status, 401);
    assert.equal(badOld.json.error, badUser.json.error);

    // Recover using lowercase + no hyphens
    const ended = [];
    const modEvents = [];
    const offS = h.accounts.onSessionEnd((e) => ended.push(e));
    const offM = h.accounts.onModeration((e) => modEvents.push(e));
    const recoveredJar = {};
    const rec = await h.api('/api/recover', {
      body: { username: 'symmachus', recoveryCode: code2.replace(/-/g, '').toLowerCase(), newPassword: PW2 },
      jar: recoveredJar,
    });
    offS();
    offM();

    assert.equal(rec.status, 200);
    assert.equal(rec.json.user.username, 'Symmachus');
    assert.match(rec.json.recoveryCode, /^[0-9A-F]{4}(-[0-9A-F]{4}){7}$/);
    assert.notEqual(rec.json.recoveryCode, code2);
    assert.ok(ended.some((e) => e.reason === 'recovery'));
    assert.equal(modEvents.length, 1);
    assert.equal(modEvents[0].action, 'revoke');

    // Old session invalid, new session & password valid, old code consumed
    assert.equal(await h.accounts.resolveUpgrade({ headers: { cookie: oldCookie } }), null);
    assert.equal((await h.api('/api/me', { method: 'GET', jar: recoveredJar })).json.user.username, 'Symmachus');
    assert.equal((await h.api('/api/recover', { body: { username: 'Symmachus', recoveryCode: code2, newPassword: PW3 } })).status, 401);
    assert.equal((await h.api('/api/login', { body: { username: 'Symmachus', password: PW2 } })).status, 200);

    // Clear recovery code
    assert.equal((await h.api('/api/clear-recovery', { body: { password: 'wrong password!' }, jar: recoveredJar })).status, 401);
    const clr = await h.api('/api/clear-recovery', { body: { password: PW2 }, jar: recoveredJar });
    assert.equal(clr.status, 200);
    assert.equal(clr.json.cleared, true);
    assert.equal((await h.api('/api/recover', { body: { username: 'Symmachus', recoveryCode: rec.json.recoveryCode, newPassword: PW3 } })).status, 401);
  });

  it('POST /api/delete-account verifies password, deletes account & sessions, fires onAccountDelete and onSessionEnd', async () => {
    const jar = {};
    const reg = await h.api('/api/register', { body: { username: 'Lysandus', password: PW1 }, jar });
    const accountId = reg.json.user.id;
    const oldCookie = jar.cookie;

    assert.equal((await h.api('/api/delete-account', { body: { password: 'wrong password!' }, jar })).status, 401);

    const deletedEvents = [];
    const endedEvents = [];
    const offD = h.accounts.onAccountDelete((e) => deletedEvents.push(e));
    const offS = h.accounts.onSessionEnd((e) => endedEvents.push(e));
    const del = await h.api('/api/delete-account', { body: { password: PW1 }, jar });
    offD();
    offS();

    assert.equal(del.status, 200);
    assert.equal(del.json.deleted, true);
    assert.equal(del.json.user, null);
    assert.match(del.setCookie, /Max-Age=0/);
    assert.deepEqual(deletedEvents, [{ accountId, username: 'Lysandus' }]);
    assert.equal(endedEvents.length, 1);
    assert.equal(endedEvents[0].reason, 'account_deleted');

    // Old session dead, account gone, username reusable
    assert.equal(await h.accounts.resolveUpgrade({ headers: { cookie: oldCookie } }), null);
    assert.equal(await h.accounts.find('Lysandus'), null);
    assert.equal((await h.api('/api/login', { body: { username: 'Lysandus', password: PW1 } })).status, 401);
    assert.equal((await h.api('/api/register', { body: { username: 'Lysandus', password: PW2 } })).status, 201);
  });

  it('enforces CSRF/Origin, Content-Type, body limits, 404, and 405', async () => {
    assert.equal(
      (await h.api('/api/login', { body: { username: 'Cyrus', password: PW2 }, headers: { Origin: 'https://evil.example' } })).status,
      403,
    );
    assert.equal(
      (await h.api('/api/login', { body: { username: 'Cyrus', password: PW2 }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status,
      403,
    );
    const form = await fetch(h.base + '/api/login', {
      method: 'POST',
      headers: { Origin: h.base, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=Cyrus&password=x',
    });
    assert.equal(form.status, 415);
    assert.equal((await h.api('/api/login', { body: { username: 'Cyrus', password: 'x'.repeat(10_000) } })).status, 413);
    assert.equal((await h.api('/api/nope', { method: 'GET' })).status, 404);
    const m = await h.api('/api/login', { method: 'GET' });
    assert.equal(m.status, 405);
    assert.equal(m.headers.get('allow'), 'POST');
  });
});

describe('createPostgresAccounts synchronous isMuted, LISTEN/NOTIFY, sessions, and rate limits', () => {
  it('hydrates isMuted on resolveUpgrade/login and updates synchronously via LISTEN/NOTIFY across processes', async () => {
    let clock = 2_000_000;
    const pool = createMockAccountsPgPool();
    const h = await createHarness({
      pool,
      now: () => clock,
      sessionTtlMs: 10_000,
      sessionRenewAfterMs: 1_000,
      maxSessionsPerAccount: 2,
    });
    // Simulate a second process (operator CLI or another worker) sharing the same PG database
    const remoteStore = await openPostgresAccountStore({ pool, applySchema: false, now: () => clock });
    const modEvents = [];
    const offMod = h.accounts.onModeration((e) => modEvents.push(e));

    try {
      const jar = {};
      const reg = await h.api('/api/register', { body: { username: 'Mara', password: PW1 }, jar });
      const id = reg.json.user.id;
      assert.equal(h.accounts.isMuted(id), false);
      assert.equal(h.accounts.isMuted(String(id)), false);

      // Remote process mutes for 2 minutes -> LISTEN/NOTIFY updates synchronous cache immediately!
      await remoteStore.mute('Mara', { minutes: 2, reason: 'spam', actor: 'cli:op' });
      assert.equal(h.accounts.isMuted(id), true);
      assert.equal(h.accounts.isMuted(String(id)), true);

      const meMuted = await h.api('/api/me', { method: 'GET', jar });
      assert.equal(meMuted.json.muted.until, clock + 120_000);

      // Mute expires when clock advances
      clock += 121_000;
      assert.equal(h.accounts.isMuted(id), false);

      // New login after session expired; test permanent mute + unmute via LISTEN/NOTIFY
      const jar2 = {};
      await h.api('/api/login', { body: { username: 'Mara', password: PW1 }, jar: jar2 });
      await remoteStore.mute('Mara', { actor: 'cli:op' }); // permanent
      assert.equal(h.accounts.isMuted(id), true);
      await remoteStore.unmute('Mara', { actor: 'cli:op' });
      assert.equal(h.accounts.isMuted(id), false);

      // Verify resolveUpgrade hydrates muteCache even if a fresh accounts instance starts after mute
      await remoteStore.mute('Mara', { minutes: 5, actor: 'cli:op' });
      const freshAccounts = await createPostgresAccounts({ pool, applySchema: false, scrypt: FAST_SCRYPT, now: () => clock });
      try {
        assert.equal(freshAccounts.isMuted(id), false); // not cached yet
        const upgraded = await freshAccounts.resolveUpgrade({ headers: { cookie: jar2.cookie } });
        assert.equal(upgraded.username, 'Mara');
        assert.equal(freshAccounts.isMuted(id), true); // hydrated by resolveUpgrade!
      } finally {
        await freshAccounts.close();
      }
      await remoteStore.unmute('Mara', { actor: 'cli:op' });

      // Cross-process revoke and ban deliver onModeration events
      modEvents.length = 0;
      await remoteStore.revokeSessions('Mara', { actor: 'cli:op' });
      assert.deepEqual(modEvents, [{ accountId: id, action: 'revoke' }]);
      assert.equal(await h.accounts.resolveUpgrade({ headers: { cookie: jar2.cookie } }), null);

      modEvents.length = 0;
      await remoteStore.ban('Mara', { reason: 'griefing', actor: 'cli:op' });
      assert.deepEqual(modEvents, [{ accountId: id, action: 'ban' }]);

      const bannedLogin = await h.api('/api/login', { body: { username: 'Mara', password: PW1 } });
      assert.equal(bannedLogin.status, 403);
      assert.match(bannedLogin.json.error, /banned: griefing/);
      assert.equal((await h.api('/api/login', { body: { username: 'Mara', password: 'wrong wrong wrong' } })).status, 401);

      await remoteStore.unban('Mara', { actor: 'cli:op' });
      assert.equal((await h.api('/api/login', { body: { username: 'Mara', password: PW1 } })).status, 200);
    } finally {
      offMod();
      await remoteStore.close();
      await h.stop();
    }
  });

  it('supports sliding session renewal, per-account session cap, HTTPS/proxy rules, insecure cookie mode, and rate limits', async () => {
    let clock = 5_000_000;
    const h = await createHarness({
      now: () => clock,
      sessionTtlMs: 10_000,
      sessionRenewAfterMs: 1_000,
      maxSessionsPerAccount: 2,
      limits: { recover: [3, 60_000], recoverName: [2, 60_000] },
    });
    try {
      const jar = {};
      const reg = await h.api('/api/register', { body: { username: 'Gortwog', password: PW1 }, jar });
      clock += 5_000;
      const renewed = await h.api('/api/me', { method: 'GET', jar });
      assert.equal(renewed.json.user.username, 'Gortwog');
      assert.match(renewed.setCookie, /Max-Age=10/);

      // Per-account session cap (max 2)
      const s1 = {};
      const s2 = {};
      const s3 = {};
      await h.api('/api/login', { body: { username: 'Gortwog', password: PW1 }, jar: s1 });
      clock += 1;
      await h.api('/api/login', { body: { username: 'Gortwog', password: PW1 }, jar: s2 });
      clock += 1;
      await h.api('/api/login', { body: { username: 'Gortwog', password: PW1 }, jar: s3 });
      assert.equal((await h.api('/api/me', { method: 'GET', jar: s1 })).json.user, null);
      assert.equal((await h.api('/api/me', { method: 'GET', jar: s3 })).json.user.username, 'Gortwog');

      // Recovery rate limits (per-username + per-IP)
      assert.equal((await h.api('/api/recover', { body: { username: 'Gortwog', recoveryCode: '0000-0000', newPassword: PW2 } })).status, 401);
      assert.equal((await h.api('/api/recover', { body: { username: 'Gortwog', recoveryCode: '0000-0000', newPassword: PW2 } })).status, 401);
      const lockedName = await h.api('/api/recover', { body: { username: 'Gortwog', recoveryCode: reg.json.recoveryCode, newPassword: PW2 } });
      assert.equal(lockedName.status, 429);
      assert.ok(Number(lockedName.headers.get('retry-after')) > 0);
      assert.equal((await h.api('/api/recover', { body: { username: 'OtherUser', recoveryCode: '0000-0000', newPassword: PW2 } })).status, 429);
    } finally {
      await h.stop();
    }

    // HTTPS + trustProxy + publicOrigin + right-most X-Forwarded-For
    const proxied = await createHarness({
      requireHttps: true,
      trustProxy: true,
      publicOrigin: 'https://play.example.org',
      limits: { register: [1, 60_000] },
    });
    try {
      const origin = { Origin: 'https://play.example.org' };
      assert.equal((await proxied.api('/api/register', { body: { username: 'Alpha', password: PW1 }, headers: origin })).status, 403);
      assert.equal(
        (await proxied.api('/api/register', { body: { username: 'Alpha', password: PW1 }, headers: { ...origin, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '1.1.1.1, 10.0.0.1' } })).status,
        201,
      );
      assert.equal(
        (await proxied.api('/api/register', { body: { username: 'Bravo', password: PW1 }, headers: { ...origin, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '9.9.9.9, 10.0.0.1' } })).status,
        429,
      );
    } finally {
      await proxied.stop();
    }

    // Insecure cookie escape hatch
    const dev = await createHarness({ secureCookies: false });
    try {
      const r = await dev.api('/api/register', { body: { username: 'Devon', password: PW1 }, jar: {} });
      assert.equal(r.status, 201);
      assert.ok(r.setCookie.startsWith(`${COOKIE_INSECURE}=`));
      assert.ok(!r.setCookie.includes('Secure'));
    } finally {
      await dev.stop();
    }
  });
});
