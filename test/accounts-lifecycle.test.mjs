// Account lifecycle APIs & game-server integration:
// /api/password, /api/logout-all, /api/delete-account, /api/recovery-code, /api/clear-recovery, /api/recover,
// onAccountDelete character cleanup, and per-account WebSocket action rate limiting.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { createAccounts, hashPassword } from '../server/accounts.js';
import { createGameServer, CLOSE } from '../server/game.js';

const FAST_SCRYPT = { N: 2 ** 10, r: 8, p: 1, keyLen: 32 };
const PW1 = 'first lantern at dawn';
const PW2 = 'second lantern at dusk';
const PW3 = 'third lantern by midnight';

function createHarness(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dfw-lifecycle-'));
  const clientDir = join(dir, 'client');
  const siteDir = join(dir, 'site');
  mkdirSync(clientDir);
  mkdirSync(siteDir);
  writeFileSync(join(clientDir, 'play.html'), '<!doctype html><title>play</title>');
  writeFileSync(join(siteDir, 'index.html'), '<!doctype html><title>site</title>');
  const accountsDbPath = join(dir, 'accounts.db');
  const accounts = createAccounts({
    dbPath: accountsDbPath,
    scrypt: FAST_SCRYPT,
    moderationPollMs: 20,
    limits: {
      api: [500, 60_000],
      login: [100, 60_000],
      register: [100, 60_000],
      password: [100, 60_000],
      recover: [100, 60_000],
      recoverName: [100, 60_000],
      ...(opts.limits ?? {}),
    },
    ...(opts.accounts ?? {}),
  });
  const server = createGameServer({
    host: '127.0.0.1',
    port: 0,
    dbPath: join(dir, 'game.db'),
    clientDir,
    siteDir,
    accounts,
    features: opts.features ?? [],
    ...(opts.server ?? {}),
  });
  let origin, wsUrl;
  return {
    accounts,
    accountsDbPath,
    server,
    get origin() { return origin; },
    async start() {
      const addr = await server.start();
      origin = `http://127.0.0.1:${addr.port}`;
      wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
    },
    async stop() {
      await server.close();
      accounts.close();
      rmSync(dir, { recursive: true, force: true });
    },
    async api(path, { method = 'POST', body, jar, headers = {} } = {}) {
      const h = { Origin: origin, ...headers };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (jar?.cookie) h.Cookie = jar.cookie;
      const res = await fetch(origin + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (jar && setCookie) {
        const [pair] = setCookie.split(';');
        const value = pair.slice(pair.indexOf('=') + 1);
        jar.cookie = value ? pair : '';
      }
      const text = await res.text();
      return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null, setCookie };
    },
    connect(cookie) {
      return new Promise((resolve) => {
        const ws = new WebSocket(wsUrl, { headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } });
        const messages = [];
        ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
        ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
        ws.once('open', () => resolve({ ws, messages }));
        ws.once('error', () => {});
      });
    },
  };
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out');
}

function closed(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) return resolve({ code: ws._closeCode });
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe('account lifecycle APIs', () => {
  const h = createHarness();
  before(() => h.start());
  after(() => h.stop());

  test('register returns a one-time recoveryCode stored only as a SHA-256 hash', async () => {
    const jar = {};
    const reg = await h.api('/api/register', { body: { username: 'Barenziah', password: PW1 }, jar });
    assert.equal(reg.status, 201);
    assert.match(reg.json.recoveryCode, /^[0-9A-F]{4}(-[0-9A-F]{4}){7}$/);

    // Verify plaintext recoveryCode is never stored in accounts.db.
    const db = new DatabaseSync(h.accountsDbPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT recovery_hash FROM accounts WHERE id = ?').get(reg.json.user.id);
      assert.match(row.recovery_hash, /^[0-9a-f]{64}$/);
      assert.notEqual(row.recovery_hash, reg.json.recoveryCode);
    } finally {
      db.close();
    }
  });

  test('POST /api/password validates, updates hash, revokes other sessions and closes their /ws sockets', async () => {
    const jarA = {};
    const jarB = {};
    await h.api('/api/login', { body: { username: 'Barenziah', password: PW1 }, jar: jarA });
    await h.api('/api/login', { body: { username: 'Barenziah', password: PW1 }, jar: jarB });

    // Unauthenticated rejected
    assert.equal((await h.api('/api/password', { body: { currentPassword: PW1, newPassword: PW2 } })).status, 401);
    // Cross-origin rejected
    assert.equal(
      (await h.api('/api/password', { body: { currentPassword: PW1, newPassword: PW2 }, jar: jarA, headers: { Origin: 'https://evil.example' } })).status,
      403
    );
    // Wrong current password rejected
    assert.equal((await h.api('/api/password', { body: { currentPassword: 'wrong password!', newPassword: PW2 }, jar: jarA })).status, 401);
    // Weak new password rejected
    assert.equal((await h.api('/api/password', { body: { currentPassword: PW1, newPassword: 'short' }, jar: jarA })).status, 400);

    // Connect live /ws sockets for both sessions (A joins, B stays upgraded)
    const connA = await h.connect(jarA.cookie);
    connA.ws.send(JSON.stringify({ type: 'join' }));
    await waitFor(() => connA.messages.find((m) => m.type === 'welcome'));
    const connB = await h.connect(jarB.cookie);
    const bClosed = closed(connB.ws);

    const res = await h.api('/api/password', { body: { currentPassword: PW1, newPassword: PW2 }, jar: jarA });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.ok(res.json.revokedSessions >= 1);

    // Other device socket B closes immediately, while A stays open and valid
    assert.equal((await bClosed).code, CLOSE.ACCOUNT);
    assert.equal((await h.api('/api/me', { method: 'GET', jar: jarB })).json.user, null);
    assert.equal((await h.api('/api/me', { method: 'GET', jar: jarA })).json.user.username, 'Barenziah');
    assert.equal(connA.ws.readyState, WebSocket.OPEN);

    // Old password fails, new password works
    assert.equal((await h.api('/api/login', { body: { username: 'Barenziah', password: PW1 } })).status, 401);
    assert.equal((await h.api('/api/login', { body: { username: 'Barenziah', password: PW2 } })).status, 200);

    connA.ws.close();
    await closed(connA.ws);
  });

  test('POST /api/logout-all revokes all sessions, clears cookie, and closes every live /ws socket', async () => {
    const jarA = {};
    const jarB = {};
    await h.api('/api/login', { body: { username: 'Barenziah', password: PW2 }, jar: jarA });
    await h.api('/api/login', { body: { username: 'Barenziah', password: PW2 }, jar: jarB });
    const cookieA = jarA.cookie;
    const cookieB = jarB.cookie;

    const connA = await h.connect(cookieA);
    connA.ws.send(JSON.stringify({ type: 'join' }));
    await waitFor(() => connA.messages.find((m) => m.type === 'welcome'));
    const connB = await h.connect(cookieB);
    const closedA = closed(connA.ws);
    const closedB = closed(connB.ws);

    const res = await h.api('/api/logout-all', { jar: jarA });
    assert.equal(res.status, 200);
    assert.equal(res.json.user, null);
    assert.ok(res.json.revokedSessions >= 2);
    assert.match(res.setCookie, /Max-Age=0/);

    assert.equal((await closedA).code, CLOSE.ACCOUNT);
    assert.equal((await closedB).code, CLOSE.ACCOUNT);
    assert.equal((await h.connect(cookieA)).status, 401);
    assert.equal((await h.connect(cookieB)).status, 401);
  });

  test('recovery code rotation, clearing, and POST /api/recover password reset', async () => {
    const jar = {};
    const reg = await h.api('/api/register', { body: { username: 'Symmachus', password: PW1 }, jar });
    const code1 = reg.json.recoveryCode;

    // Rotate recovery code
    const rot = await h.api('/api/recovery-code', { body: { password: PW1 }, jar });
    assert.equal(rot.status, 200);
    const code2 = rot.json.recoveryCode;
    assert.notEqual(code2, code1);

    // Old code fails with same generic 401 as unknown username
    const badOld = await h.api('/api/recover', { body: { username: 'Symmachus', recoveryCode: code1, newPassword: PW2 } });
    const badUser = await h.api('/api/recover', { body: { username: 'NoSuchUser', recoveryCode: code2, newPassword: PW2 } });
    assert.equal(badOld.status, 401);
    assert.equal(badUser.status, 401);
    assert.equal(badOld.json.error, badUser.json.error);

    // Open a live socket on the old session; recovery must disconnect it
    const conn = await h.connect(jar.cookie);
    conn.ws.send(JSON.stringify({ type: 'join' }));
    await waitFor(() => conn.messages.find((m) => m.type === 'welcome'));
    const oldCookie = jar.cookie;
    const sockClosed = closed(conn.ws);

    // Recover using lowercase + no hyphens (tests normalization)
    const recoveredJar = {};
    const rec = await h.api('/api/recover', {
      body: { username: 'symmachus', recoveryCode: code2.replace(/-/g, '').toLowerCase(), newPassword: PW2 },
      jar: recoveredJar,
    });
    assert.equal(rec.status, 200);
    assert.equal(rec.json.user.username, 'Symmachus');
    assert.match(rec.json.recoveryCode, /^[0-9A-F]{4}(-[0-9A-F]{4}){7}$/);
    assert.notEqual(rec.json.recoveryCode, code2);

    // Old socket closed, old session invalid, new session & new password work, old code consumed
    assert.equal((await sockClosed).code, CLOSE.ACCOUNT);
    assert.equal((await h.connect(oldCookie)).status, 401);
    assert.equal((await h.api('/api/me', { method: 'GET', jar: recoveredJar })).json.user.username, 'Symmachus');
    assert.equal((await h.api('/api/recover', { body: { username: 'Symmachus', recoveryCode: code2, newPassword: PW3 } })).status, 401);
    assert.equal((await h.api('/api/login', { body: { username: 'Symmachus', password: PW2 } })).status, 200);

    // Clear recovery code: subsequent recover fails
    const clr = await h.api('/api/clear-recovery', { body: { password: PW2 }, jar: recoveredJar });
    assert.equal(clr.status, 200);
    assert.equal(clr.json.cleared, true);
    assert.equal((await h.api('/api/recover', { body: { username: 'Symmachus', recoveryCode: rec.json.recoveryCode, newPassword: PW3 } })).status, 401);
  });

  test('a recovery code is single-use even when two /api/recover requests race', async () => {
    const reg = await h.api('/api/register', { body: { username: 'Mannimarco', password: PW1 } });
    const code = reg.json.recoveryCode;
    const jars = [{}, {}];
    const results = await Promise.all([
      h.api('/api/recover', { body: { username: 'Mannimarco', recoveryCode: code, newPassword: PW2 }, jar: jars[0] }),
      h.api('/api/recover', { body: { username: 'Mannimarco', recoveryCode: code, newPassword: PW3 }, jar: jars[1] }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
    // The winner's password and session are the ones in force.
    const win = results.findIndex((r) => r.status === 200);
    assert.equal((await h.api('/api/me', { method: 'GET', jar: jars[win] })).json.user?.username, 'Mannimarco');
    assert.equal((await h.api('/api/login', { body: { username: 'Mannimarco', password: win === 0 ? PW2 : PW3 } })).status, 200);
  });

  test('a recovery code issued by the pre-registration sign-up service still resets the password, once', async () => {
    // That service stored scrypt(code without separators) and accepted any punctuation between the groups.
    const reg = await h.api('/api/register', { body: { username: 'Medora', password: PW1 } });
    const db = new DatabaseSync(h.accountsDbPath);
    try {
      db.prepare('UPDATE accounts SET recovery_hash = ? WHERE id = ?')
        .run(await hashPassword('K7QM2XWP9RTBHD4NV3YZ', FAST_SCRYPT), reg.json.user.id);
    } finally {
      db.close();
    }
    const recover = (recoveryCode, newPassword) =>
      h.api('/api/recover', { body: { username: 'Medora', recoveryCode, newPassword } });
    assert.equal((await recover('K7QM-2XWP-9RTB-HD4N-V3YA', PW2)).status, 401);
    const ok = await recover(' k7qm 2xwp.9rtb-hd4n-v3yz ', PW2);
    assert.equal(ok.status, 200);
    assert.match(ok.json.recoveryCode, /^[0-9A-F]{4}(-[0-9A-F]{4}){7}$/);
    assert.equal((await recover('K7QM-2XWP-9RTB-HD4N-V3YZ', PW3)).status, 401, 'the old code is spent');
    assert.equal((await h.api('/api/login', { body: { username: 'Medora', password: PW2 } })).status, 200);
    assert.equal((await recover(ok.json.recoveryCode, PW3)).status, 200, 'the replacement code works');
  });

  test('GET /api/account and /api/stats answer the website account page and player count', async () => {
    assert.equal((await h.api('/api/account', { method: 'GET' })).status, 401);
    const jar = {};
    const reg = await h.api('/api/register', { body: { username: 'Akorithi', password: PW1 }, jar });
    await h.api('/api/login', { body: { username: 'Akorithi', password: PW1 } }); // a second session elsewhere
    const { status, json } = await h.api('/api/account', { method: 'GET', jar });
    assert.equal(status, 200);
    assert.deepEqual(Object.keys(json.account).sort(), ['activeSessions', 'createdAt', 'hasRecoveryCode', 'id', 'lastLoginAt', 'username']);
    assert.deepEqual(
      { ...json.account, createdAt: typeof json.account.createdAt, lastLoginAt: typeof json.account.lastLoginAt },
      { id: reg.json.user.id, username: 'Akorithi', createdAt: 'number', lastLoginAt: 'number', activeSessions: 2, hasRecoveryCode: true }
    );
    const stats = await h.api('/api/stats', { method: 'GET' });
    assert.equal(stats.status, 200);
    assert.ok(stats.json.accounts >= 1);
    assert.equal(stats.headers.get('cache-control'), 'public, max-age=30');
  });

  test('POST /api/delete-account disconnects live /ws sockets and deletes the character row', async () => {
    const jar = {};
    const reg = await h.api('/api/register', { body: { username: 'Lysandus', password: PW1 }, jar });
    const accountId = reg.json.user.id;

    // Join the game to create a character row
    const conn = await h.connect(jar.cookie);
    conn.ws.send(JSON.stringify({ type: 'join' }));
    await waitFor(() => conn.messages.find((m) => m.type === 'welcome'));
    assert.equal(h.server.characterForAccount(accountId)?.name, 'Lysandus');

    // Wrong password refused
    assert.equal((await h.api('/api/delete-account', { body: { password: 'wrong password!' }, jar })).status, 401);

    const deletedEvents = [];
    const off = h.accounts.onAccountDelete((e) => deletedEvents.push(e));
    const sockClosed = closed(conn.ws);

    const del = await h.api('/api/delete-account', { body: { password: PW1 }, jar });
    off();
    assert.equal(del.status, 200);
    assert.equal(del.json.deleted, true);
    assert.equal(del.json.user, null);
    assert.match(del.setCookie, /Max-Age=0/);
    assert.deepEqual(deletedEvents, [{ accountId, username: 'Lysandus' }]);

    // Socket closed, character unlinked/deleted, account gone, username can be re-registered
    assert.equal((await sockClosed).code, CLOSE.ACCOUNT);
    assert.equal(h.server.characterForAccount(accountId), null);
    assert.equal(h.accounts.find('Lysandus'), null);
    assert.equal((await h.api('/api/login', { body: { username: 'Lysandus', password: PW1 } })).status, 401);
    assert.equal((await h.api('/api/register', { body: { username: 'Lysandus', password: PW2 } })).status, 201);
  });
});

describe('recovery rate limits and per-account WS action rate limiting', () => {
  test('POST /api/recover enforces per-username and per-IP rate limits', async () => {
    const h = createHarness({ limits: { recover: [3, 60_000], recoverName: [2, 60_000] } });
    await h.start();
    try {
      const reg = await h.api('/api/register', { body: { username: 'Gortwog', password: PW1 } });
      assert.equal((await h.api('/api/recover', { body: { username: 'Gortwog', recoveryCode: '0000-0000', newPassword: PW2 } })).status, 401);
      assert.equal((await h.api('/api/recover', { body: { username: 'Gortwog', recoveryCode: '0000-0000', newPassword: PW2 } })).status, 401);
      // Per-username locked even with valid recovery code
      const lockedName = await h.api('/api/recover', { body: { username: 'Gortwog', recoveryCode: reg.json.recoveryCode, newPassword: PW2 } });
      assert.equal(lockedName.status, 429);
      assert.ok(Number(lockedName.headers.get('retry-after')) > 0);
      // Per-IP budget (3) exhausted for another username too
      assert.equal((await h.api('/api/recover', { body: { username: 'OtherUser', recoveryCode: '0000-0000', newPassword: PW2 } })).status, 429);
    } finally {
      await h.stop();
    }
  });

  test('per-account WS action rate limit persists across reconnects', async () => {
    const h = createHarness({
      server: { actionRatePerSec: 0.1, actionBurst: 2 },
      features: [(ctx) => {
        ctx.onAction('test.ping', () => {});
      }],
    });
    await h.start();
    try {
      const jar = {};
      await h.api('/api/register', { body: { username: 'Morgiah', password: PW1 }, jar });

      // First socket exhausts the burst of 2
      const c1 = await h.connect(jar.cookie);
      c1.ws.send(JSON.stringify({ type: 'join' }));
      await waitFor(() => c1.messages.find((m) => m.type === 'welcome'));
      c1.ws.send(JSON.stringify({ type: 'action', verb: 'test.ping', seq: 1 }));
      c1.ws.send(JSON.stringify({ type: 'action', verb: 'test.ping', seq: 2 }));
      await waitFor(() => c1.messages.filter((m) => m.type === 'actionResult').length >= 2);
      assert.equal(c1.messages.find((m) => m.seq === 1).ok, true);
      assert.equal(c1.messages.find((m) => m.seq === 2).ok, true);
      c1.ws.close();
      await closed(c1.ws);

      // Reconnecting on a brand-new WebSocket does NOT reset the account's action bucket
      const c2 = await h.connect(jar.cookie);
      c2.ws.send(JSON.stringify({ type: 'join' }));
      await waitFor(() => c2.messages.find((m) => m.type === 'welcome'));
      c2.ws.send(JSON.stringify({ type: 'action', verb: 'test.ping', seq: 3 }));
      const r3 = await waitFor(() => c2.messages.find((m) => m.type === 'actionResult' && m.seq === 3));
      assert.equal(r3.ok, false);
      assert.match(r3.error, /too fast/i);
      c2.ws.close();
      await closed(c2.ws);
    } finally {
      await h.stop();
    }
  });
});

test('session cap keeps the newest session when last_seen_at ties (same order as PostgreSQL)', async () => {
  const h = createHarness({ accounts: { now: () => 1_800_000_000_000, maxSessionsPerAccount: 2 } });
  await h.start();
  try {
    await h.api('/api/register', { body: { username: 'Jagar', password: PW1 } });
    const jars = [{}, {}, {}];
    for (const jar of jars) await h.api('/api/login', { body: { username: 'Jagar', password: PW1 }, jar });
    const users = [];
    for (const jar of jars) users.push((await h.api('/api/me', { method: 'GET', jar })).json.user?.username ?? null);
    assert.deepEqual(users, [null, 'Jagar', 'Jagar']);
  } finally {
    await h.stop();
  }
});
