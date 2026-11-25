// Account service: registration, login, cookie sessions, CSRF/origin checks, rate limits, moderation.
// Runs the accounts HTTP handler on its own loopback server so it does not depend on game.js.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAccounts,
  createLimiter,
  hashPassword,
  verifyPassword,
  usernameProblem,
  passwordProblem,
  parseCookies,
  runCli,
  COOKIE_SECURE,
} from '../server/accounts.js';

const FAST_SCRYPT = { N: 2 ** 10, r: 8, p: 1, keyLen: 32 };
const PASSWORD = 'correct horse battery';

function harness(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dfw-accounts-'));
  const dbPath = join(dir, 'accounts.db');
  const accounts = createAccounts({ dbPath, scrypt: FAST_SCRYPT, moderationPollMs: 20, ...opts });
  const server = createServer((req, res) => {
    if (req.url.startsWith('/api/')) return accounts.handleHttp(req, res);
    if (req.url === '/whoami') {
      const user = accounts.resolveUpgrade(req);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ user }));
    }
    res.writeHead(404).end();
  });
  let base;
  return {
    accounts,
    dbPath,
    get base() {
      return base;
    },
    async start() {
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${server.address().port}`;
    },
    async stop() {
      await new Promise((r) => server.close(r));
      accounts.close();
      rmSync(dir, { recursive: true, force: true });
    },
    // Browser-like same-origin JSON request with a cookie jar.
    async api(path, { method = 'POST', body, jar, headers = {} } = {}) {
      const h = { Origin: base, ...headers };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (jar?.cookie) h.Cookie = jar.cookie;
      const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
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

describe('validation and hashing', () => {
  test('account names', () => {
    assert.equal(usernameProblem('Cyrus'), null);
    assert.equal(usernameProblem('a_b-c9'), null);
    assert.match(usernameProblem('ab'), /3–20/);
    assert.match(usernameProblem('9lives'), /starting with a letter/);
    assert.match(usernameProblem('has space'), /3–20/);
    assert.match(usernameProblem('Ålfred'), /3–20/); // ASCII only: no look-alike impersonation
    assert.match(usernameProblem('Admin'), /reserved/);
    assert.match(usernameProblem(undefined), /Enter/);
  });

  test('passwords', () => {
    assert.equal(passwordProblem(PASSWORD, 'Cyrus'), null);
    assert.match(passwordProblem('short', 'Cyrus'), /at least 10/);
    assert.match(passwordProblem('xxCyrusxxxxx', 'cyrus'), /must not contain/);
    assert.match(passwordProblem('x'.repeat(257), 'Cyrus'), /at most 256/);
  });

  test('scrypt hash round-trip, unique salts, rejects malformed', async () => {
    const a = await hashPassword(PASSWORD, FAST_SCRYPT);
    const b = await hashPassword(PASSWORD, FAST_SCRYPT);
    assert.match(a, /^scrypt\$1024\$8\$1\$[\w-]+\$[\w-]+$/);
    assert.notEqual(a, b);
    assert.equal(await verifyPassword(PASSWORD, a), true);
    assert.equal(await verifyPassword(PASSWORD + '!', a), false);
    assert.equal(await verifyPassword(PASSWORD, 'sha1$abc'), false);
    assert.equal(await verifyPassword(PASSWORD, null), false);
  });

  test('cookie parsing keeps the first value', () => {
    assert.deepEqual(parseCookies('a=1; b=2; a=3'), { a: '1', b: '2' });
    assert.deepEqual(parseCookies(undefined), {});
  });

  test('sliding-window limiter', () => {
    let t = 0;
    const l = createLimiter(2, 1000, () => t);
    assert.equal(l.hit('k'), 0);
    assert.equal(l.hit('k'), 0);
    assert.equal(l.hit('k'), 1000);
    t = 500;
    assert.equal(l.check('k'), 500);
    assert.equal(l.hit('other'), 0);
    t = 1001;
    assert.equal(l.hit('k'), 0);
  });
});

describe('HTTP API', () => {
  const h = harness();
  before(() => h.start());
  after(() => h.stop());

  test('GET /api/me without a session', async () => {
    const r = await h.api('/api/me', { method: 'GET' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { user: null });
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  test('register sets a __Host- HttpOnly Secure SameSite=Strict cookie and /api/me resolves it', async () => {
    const jar = {};
    const r = await h.api('/api/register', { body: { username: 'Cyrus', password: PASSWORD }, jar });
    assert.equal(r.status, 201);
    assert.equal(r.json.user.username, 'Cyrus');
    assert.ok(Number.isInteger(r.json.user.id));
    assert.ok(r.setCookie.startsWith(`${COOKIE_SECURE}=`));
    for (const attr of ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Secure']) assert.ok(r.setCookie.includes(attr), attr);
    assert.ok(!/Domain=/i.test(r.setCookie));
    const me = await h.api('/api/me', { method: 'GET', jar });
    assert.deepEqual(me.json, { user: r.json.user });
    const who = await fetch(h.base + '/whoami', { headers: { Cookie: jar.cookie } }).then((x) => x.json());
    assert.deepEqual({ id: who.user.id, username: who.user.username }, r.json.user);
    assert.match(who.user.sessionKey, /^\d+$/);
  });

  test('names are unique case-insensitively', async () => {
    const r = await h.api('/api/register', { body: { username: 'cYRUS', password: PASSWORD } });
    assert.equal(r.status, 409);
    assert.equal(r.json.field, 'username');
  });

  test('invalid registration input names the field', async () => {
    let r = await h.api('/api/register', { body: { username: 'x', password: PASSWORD } });
    assert.equal(r.status, 400);
    assert.equal(r.json.field, 'username');
    r = await h.api('/api/register', { body: { username: 'Valid_Name', password: 'short' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.field, 'password');
  });

  test('login: success, wrong password, unknown name give the same error', async () => {
    const jar = {};
    const ok = await h.api('/api/login', { body: { username: 'cyrus', password: PASSWORD }, jar });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.username, 'Cyrus'); // stored casing
    const bad = await h.api('/api/login', { body: { username: 'Cyrus', password: 'wrong password!' } });
    const unknown = await h.api('/api/login', { body: { username: 'Nobody', password: 'wrong password!' } });
    assert.equal(bad.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(bad.json.error, unknown.json.error);
  });

  test('logout deletes the server session even if the cookie is replayed', async () => {
    const jar = {};
    await h.api('/api/login', { body: { username: 'Cyrus', password: PASSWORD }, jar });
    const stolen = jar.cookie;
    const out = await h.api('/api/logout', { jar });
    assert.equal(out.status, 200);
    assert.match(out.setCookie, /Max-Age=0/);
    const me = await h.api('/api/me', { method: 'GET', jar: { cookie: stolen } });
    assert.equal(me.json.user, null);
    assert.match(me.setCookie ?? '', /Max-Age=0/); // dead cookie is cleared
  });

  test('cross-origin and non-JSON POSTs are refused', async () => {
    let r = await h.api('/api/login', {
      body: { username: 'Cyrus', password: PASSWORD },
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(r.status, 403);
    r = await h.api('/api/login', {
      body: { username: 'Cyrus', password: PASSWORD },
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(r.status, 403);
    const form = await fetch(h.base + '/api/login', {
      method: 'POST',
      headers: { Origin: h.base, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=Cyrus&password=x',
    });
    assert.equal(form.status, 415);
  });

  test('oversized bodies, unknown routes and wrong methods', async () => {
    const big = await h.api('/api/login', { body: { username: 'Cyrus', password: 'x'.repeat(10_000) } });
    assert.equal(big.status, 413);
    assert.equal((await h.api('/api/nope', { method: 'GET' })).status, 404);
    const m = await h.api('/api/login', { method: 'GET' });
    assert.equal(m.status, 405);
    assert.equal(m.headers.get('allow'), 'POST');
  });

  test('forged or malformed cookies resolve to nobody', async () => {
    for (const cookie of [`${COOKIE_SECURE}=${'A'.repeat(43)}`, `${COOKIE_SECURE}=../../etc`, 'dfw_session=x']) {
      const r = await h.api('/api/me', { method: 'GET', jar: { cookie } });
      assert.equal(r.json.user, null);
    }
  });
});

describe('rate limits', () => {
  const h = harness({ limits: { login: [3, 60_000], loginName: [2, 60_000], register: [1, 60_000] } });
  before(() => h.start());
  after(() => h.stop());

  test('registration per IP', async () => {
    assert.equal((await h.api('/api/register', { body: { username: 'First', password: PASSWORD } })).status, 201);
    const r = await h.api('/api/register', { body: { username: 'Second', password: PASSWORD } });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  });

  test('failed logins per account name, then per IP', async () => {
    const bad = { username: 'First', password: 'not the password' };
    assert.equal((await h.api('/api/login', { body: bad })).status, 401);
    assert.equal((await h.api('/api/login', { body: bad })).status, 401);
    // Account name is now locked, even with the right password.
    assert.equal((await h.api('/api/login', { body: { username: 'First', password: PASSWORD } })).status, 429);
    // IP budget (3) is exhausted too.
    assert.equal((await h.api('/api/login', { body: { username: 'Other', password: PASSWORD } })).status, 429);
  });
});

describe('sessions and moderation', () => {
  let clock = 1_000_000;
  const h = harness({
    now: () => clock,
    sessionTtlMs: 10_000,
    sessionRenewAfterMs: 1_000,
    maxSessionsPerAccount: 2,
    limits: { login: [100, 60_000] },
  });
  const events = [];
  before(async () => {
    await h.start();
    h.accounts.onModeration((e) => events.push(e));
  });
  after(() => h.stop());

  async function signIn(name) {
    const jar = {};
    const r = await h.api('/api/login', { body: { username: name, password: PASSWORD }, jar });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    return jar;
  }

  test('sessions expire and slide', async () => {
    const jar = {};
    await h.api('/api/register', { body: { username: 'Mara', password: PASSWORD }, jar });
    clock += 5_000;
    const me = await h.api('/api/me', { method: 'GET', jar });
    assert.equal(me.json.user.username, 'Mara');
    assert.match(me.setCookie, /Max-Age=10/); // renewed
    clock += 8_000; // 13s after creation but only 8s after renewal
    assert.equal((await h.api('/api/me', { method: 'GET', jar })).json.user.username, 'Mara');
    clock += 11_000;
    assert.equal((await h.api('/api/me', { method: 'GET', jar })).json.user, null);
  });

  test('old sessions beyond the per-account cap are dropped', async () => {
    const a = await signIn('Mara');
    clock += 1;
    await signIn('Mara');
    clock += 1;
    await signIn('Mara');
    assert.equal((await h.api('/api/me', { method: 'GET', jar: a })).json.user, null);
  });

  test('mute is reported by isMuted and /api/me, and expires', async () => {
    const jar = await signIn('Mara');
    const id = h.accounts.find('Mara').id;
    assert.equal(h.accounts.isMuted(id), false);
    h.accounts.mute('Mara', { minutes: 1, reason: 'spam' });
    assert.equal(h.accounts.isMuted(id), true);
    const me = await h.api('/api/me', { method: 'GET', jar });
    assert.equal(me.json.muted.until, clock + 60_000);
    clock += 61_000;
    assert.equal(h.accounts.isMuted(id), false);
    h.accounts.mute('mara'); // permanent
    assert.equal(h.accounts.isMuted(id), true);
    h.accounts.unmute('Mara');
    assert.equal(h.accounts.isMuted(id), false);
    assert.equal(h.accounts.isMuted(999_999), false);
  });

  test('logout notifies onSessionEnd with only that session key', async () => {
    const a = await signIn('Mara');
    const b = await signIn('Mara');
    const keyA = h.accounts.resolveUpgrade({ headers: { cookie: a.cookie } }).sessionKey;
    const keyB = h.accounts.resolveUpgrade({ headers: { cookie: b.cookie } }).sessionKey;
    assert.notEqual(keyA, keyB);
    const ended = [];
    const off = h.accounts.onSessionEnd((e) => ended.push(e));
    await h.api('/api/logout', { jar: a });
    off();
    assert.deepEqual(ended, [{ accountId: h.accounts.find('Mara').id, sessionKey: keyA, reason: 'logout' }]);
    assert.equal(h.accounts.resolveUpgrade({ headers: { cookie: b.cookie } }).sessionKey, keyB);
  });

  test('revoke signs out everywhere and notifies the runtime', async () => {
    const jar = await signIn('Mara');
    events.length = 0;
    const r = h.accounts.revokeSessions('Mara');
    assert.ok(r.revoked >= 1);
    assert.deepEqual(events, [{ accountId: r.id, action: 'revoke' }]);
    assert.equal((await h.api('/api/me', { method: 'GET', jar })).json.user, null);
  });

  test('ban refuses upgrade and login; unban restores login', async () => {
    const jar = await signIn('Mara');
    const req = { headers: { cookie: jar.cookie } };
    assert.equal(h.accounts.resolveUpgrade(req).username, 'Mara');
    events.length = 0;
    h.accounts.ban('Mara', { reason: 'griefing' });
    assert.equal(events[0].action, 'ban');
    assert.equal(h.accounts.resolveUpgrade(req), null);
    const login = await h.api('/api/login', { body: { username: 'Mara', password: PASSWORD } });
    assert.equal(login.status, 403);
    assert.match(login.json.error, /banned: griefing/);
    // A wrong password never reveals the ban.
    assert.equal((await h.api('/api/login', { body: { username: 'Mara', password: 'wrong wrong wrong' } })).status, 401);
    h.accounts.unban('Mara');
    await signIn('Mara');
  });

  test('operator CLI changes reach the running service via the moderation poll', async () => {
    const jar = await signIn('Mara');
    events.length = 0;
    const lines = [];
    assert.equal(runCli(['ban', 'Mara', 'cli', 'reason'], { dbPath: h.dbPath, out: (l) => lines.push(l), now: () => clock }), 0);
    assert.match(lines.join('\n'), /banned Mara/);
    const deadline = Date.now() + 2000;
    while (!events.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(events, [{ accountId: h.accounts.find('Mara').id, action: 'ban' }]);
    assert.equal(h.accounts.resolveUpgrade({ headers: { cookie: jar.cookie } }), null);

    lines.length = 0;
    runCli(['mute', 'Mara', '5', 'loud'], { dbPath: h.dbPath, out: (l) => lines.push(l), now: () => clock });
    assert.equal(h.accounts.isMuted(h.accounts.find('Mara').id), true);
    runCli(['list'], { dbPath: h.dbPath, out: (l) => lines.push(l), now: () => clock });
    assert.match(lines.join('\n'), /Mara.*BANNED, muted until/);
    assert.equal(runCli(['ban', 'Ghost'], { dbPath: h.dbPath, out: () => {} }), 1);
  });
});

describe('development escape hatch', () => {
  const h = harness({ secureCookies: false });
  before(() => h.start());
  after(() => h.stop());

  test('COOKIE_SECURE=0 uses a plain cookie without Secure', async () => {
    const r = await h.api('/api/register', { body: { username: 'Devon', password: PASSWORD }, jar: {} });
    assert.equal(r.status, 201);
    assert.ok(r.setCookie.startsWith('dfw_session='));
    assert.ok(!r.setCookie.includes('Secure'));
  });
});

describe('HTTPS enforcement behind a proxy', () => {
  const h = harness({ requireHttps: true, trustProxy: true, publicOrigin: 'https://play.example.org' });
  before(() => h.start());
  after(() => h.stop());

  test('requires X-Forwarded-Proto https and the configured public origin', async () => {
    const body = { username: 'Proxied', password: PASSWORD };
    const origin = { Origin: 'https://play.example.org' };
    assert.equal((await h.api('/api/register', { body, headers: origin })).status, 403);
    assert.equal(
      (await h.api('/api/register', { body, headers: { ...origin, 'X-Forwarded-Proto': 'http' } })).status,
      403
    );
    assert.equal(
      (await h.api('/api/register', { body, headers: { Origin: h.base, 'X-Forwarded-Proto': 'https' } })).status,
      403
    );
    assert.equal(
      (await h.api('/api/register', { body, headers: { ...origin, 'X-Forwarded-Proto': 'https' } })).status,
      201
    );
  });

  test('rate limits key on the right-most forwarded address', async () => {
    const lim = harness({ trustProxy: true, limits: { register: [1, 60_000] } });
    await lim.start();
    try {
      const reg = (username, xff) =>
        lim.api('/api/register', { body: { username, password: PASSWORD }, headers: { 'X-Forwarded-For': xff } });
      assert.equal((await reg('Alpha', '1.1.1.1, 10.0.0.1')).status, 201);
      // Spoofed left-most entry does not help: the proxy-appended address is the same.
      assert.equal((await reg('Bravo', '9.9.9.9, 10.0.0.1')).status, 429);
      assert.equal((await reg('Charlie', '10.0.0.2')).status, 201);
    } finally {
      await lim.stop();
    }
  });
});
