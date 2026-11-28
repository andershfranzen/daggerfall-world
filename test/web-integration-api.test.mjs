// Web-integration backend APIs & accounts contract tests:
//   - GET/HEAD /healthz
//   - GET/HEAD /api/status
//   - GET/HEAD /api/me/character (unauth, no char, uncreated, created, privacy boundary, ranks, sync & async sessionUser)
//   - POST /api/me/chronicles-privacy (offline & online toggle, hiscores visibility sync, CSRF/JSON checks)
//   - accounts.sessionUser(req) & accounts.healthy() for both createAccounts (SQLite) and createPostgresAccounts (Postgres)
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createAccounts, createPostgresAccounts } from '../server/accounts.js';
import { createGameServer } from '../server/game.js';
import { openStore } from '../server/db.js';
import { TOTAL_CLASSIC_PLACES } from '../server/hiscores/index.js';

const FAST_SCRYPT = { N: 2 ** 10, r: 8, p: 1, keyLen: 32 };
const PASSWORD = 'correct horse battery staple';

function createHarness(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dfw-web-int-'));
  const clientDir = join(dir, 'client');
  const siteDir = join(dir, 'site');
  mkdirSync(clientDir);
  mkdirSync(siteDir);
  writeFileSync(join(clientDir, 'play.html'), '<!doctype html><title>play</title>');
  writeFileSync(join(siteDir, 'index.html'), '<!doctype html><title>site</title>');

  const gameDbPath = join(dir, 'game.db');
  const store = opts.store ?? openStore(gameDbPath);
  const accounts = opts.accounts !== undefined
    ? opts.accounts
    : createAccounts({
        dbPath: join(dir, 'accounts.db'),
        scrypt: FAST_SCRYPT,
        moderationPollMs: 0,
        limits: {
          api: [500, 60_000],
          login: [100, 60_000],
          register: [100, 60_000],
        },
        ...(opts.accountsOpts ?? {}),
      });

  const server = createGameServer({
    host: '127.0.0.1',
    port: 0,
    store,
    clientDir,
    siteDir,
    accounts,
    features: opts.features ?? [],
    ...(opts.serverOpts ?? {}),
  });

  let origin = null;
  let wsUrl = null;

  return {
    dir,
    store,
    accounts,
    server,
    get origin() { return origin; },
    get wsUrl() { return wsUrl; },
    async start() {
      const addr = await server.start();
      origin = `http://127.0.0.1:${addr.port}`;
      wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
    },
    async stop() {
      await server.close();
      if (accounts && typeof accounts.close === 'function') await accounts.close();
      rmSync(dir, { recursive: true, force: true });
    },
    async api(path, { method = 'GET', body, jar, headers = {} } = {}) {
      const h = { ...headers };
      if (method === 'POST' && !('Origin' in h) && !('origin' in h)) h.Origin = origin;
      if (body !== undefined && !('Content-Type' in h) && !('content-type' in h)) {
        h['Content-Type'] = 'application/json';
      }
      if (jar?.cookie) h.Cookie = jar.cookie;
      const res = await fetch(origin + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      });
      const setCookie = res.headers.get('set-cookie');
      if (jar && setCookie) {
        const [pair] = setCookie.split(';');
        const value = pair.slice(pair.indexOf('=') + 1);
        jar.cookie = value ? pair : '';
      }
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      return { status: res.status, headers: res.headers, text, json, setCookie };
    },
    async register(username, password = PASSWORD) {
      const jar = {};
      const res = await this.api('/api/register', { method: 'POST', body: { username, password }, jar });
      assert.equal(res.status, 201, `register ${username} failed: ${res.text}`);
      return { user: res.json.user, jar };
    },
    connect(cookie) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl, {
          headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
        });
        const messages = [];
        ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
        ws.once('unexpected-response', (_req, res) => reject(new Error(`ws unexpected ${res.statusCode}`)));
        ws.once('open', () => resolve({ ws, messages }));
        ws.once('error', reject);
      });
    },
  };
}

function makeCreatedRpg(overrides = {}) {
  return {
    location: 'town:Daggerfall/Daggerfall',
    portal: { from: 'town:Daggerfall/Daggerfall', to: 'building:Daggerfall/Daggerfall/secret-lair' },
    inventory: [{ id: 'secret-ring', name: 'Ring of Private Secrets', value: 9999 }],
    gold: 424242,
    spells: ['secret-spell'],
    character: {
      created: true,
      race: 'Breton',
      className: 'Spellsword',
      level: 12,
      skills: {
        'Long Blade': 65,
        Destruction: 55,
        Restoration: 40,
      },
    },
    travel: {
      discovered: ['town:Daggerfall/Daggerfall', 'town:Wayrest/Wayrest'],
      trips: 7,
    },
    guilds: {
      mages: { rank: 4, reputation: 45 },
    },
    playerGuild: {
      id: 'order-1',
      name: 'Blades of Iliac',
      tag: 'BOI',
      rank: 'Leader',
    },
    chronicles: {
      hidden: false,
      questsCompleted: 5,
      monstersSlain: 23,
      updatedAt: 1_700_000_000_000,
    },
    ...overrides,
  };
}

async function waitFor(fn, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out');
}

describe('accounts.sessionUser & accounts.healthy', () => {
  test('SQLite createAccounts: sessionUser and healthy lifecycle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dfw-acc-health-'));
    const accounts = createAccounts({ dbPath: join(dir, 'accounts.db'), scrypt: FAST_SCRYPT, moderationPollMs: 0 });
    const h = createHarness({ accounts });
    await h.start();
    try {
      assert.equal(accounts.healthy(), true);
      assert.equal(accounts.sessionUser({ headers: {} }), null);
      assert.equal(accounts.sessionUser(null), null);

      const { user, jar } = await h.register('Cyrus');
      assert.deepEqual(accounts.sessionUser({ headers: { cookie: jar.cookie } }), user);

      // Logout clears sessionUser
      await h.api('/api/logout', { method: 'POST', jar });
      assert.equal(accounts.sessionUser({ headers: { cookie: jar.cookie } }), null);

      // Re-login then ban invalidates sessionUser
      const jar2 = {};
      await h.api('/api/login', { method: 'POST', body: { username: 'Cyrus', password: PASSWORD }, jar: jar2 });
      assert.deepEqual(accounts.sessionUser({ headers: { cookie: jar2.cookie } }), user);
      accounts.ban('Cyrus', { reason: 'test' });
      assert.equal(accounts.sessionUser({ headers: { cookie: jar2.cookie } }), null);

      // Closing accounts DB makes healthy() false and sessionUser() safely null
      accounts.close();
      assert.equal(accounts.healthy(), false);
      assert.equal(accounts.sessionUser({ headers: { cookie: jar2.cookie } }), null);
    } finally {
      await h.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Postgres createPostgresAccounts: async sessionUser and async healthy', async () => {
    let healthyShouldFail = false;
    const sessions = new Map();
    const accountsMap = new Map();
    let seq = 1;

    const mockStore = {
      pool: {
        async query(sql) {
          if (/SELECT\s+1/i.test(sql)) {
            if (healthyShouldFail) throw new Error('pg connection lost');
            return { rows: [{ '?column?': 1 }], rowCount: 1 };
          }
          return { rows: [{ n: 0 }], rowCount: 1 };
        },
      },
      async find(name) {
        return accountsMap.get(name.toLowerCase()) ?? null;
      },
      async get(id) {
        for (const a of accountsMap.values()) if (a.id === id) return a;
        return null;
      },
      async createAccount(username, passwordHash, createdAt, recoveryHash) {
        const acc = {
          id: seq++,
          username,
          username_key: username.toLowerCase(),
          password_hash: passwordHash,
          recovery_hash: recoveryHash,
          created_at: createdAt,
          last_login_at: null,
          muted_until: null,
          banned_at: null,
        };
        accountsMap.set(acc.username_key, acc);
        return acc;
      },
      async createSession(accountId, tokenHash, { ts, ttlMs }) {
        const acc = await this.get(accountId);
        sessions.set(tokenHash, {
          sid: seq++,
          id: acc.id,
          username: acc.username,
          banned_at: acc.banned_at,
          muted_until: acc.muted_until,
          last_seen_at: ts,
          expires_at: ts + ttlMs,
        });
      },
      async getSession(tokenHash) {
        if (healthyShouldFail) throw new Error('session query error');
        return sessions.get(tokenHash) ?? null;
      },
      async deleteSessionById(sid) {
        for (const [k, v] of sessions) if (v.sid === sid) sessions.delete(k);
      },
      async touchSession() {},
      async getMuteUntil() { return null; },
      async close() {},
    };

    const pgAccounts = await createPostgresAccounts({ store: mockStore, scrypt: FAST_SCRYPT });
    try {
      assert.equal(await pgAccounts.healthy(), true);
      assert.equal(await pgAccounts.sessionUser({ headers: {} }), null);

      const h = createHarness({ accounts: pgAccounts });
      await h.start();
      try {
        const { user, jar } = await h.register('Barenziah');
        assert.deepEqual(await pgAccounts.sessionUser({ headers: { cookie: jar.cookie } }), user);

        // Simulated PG outage: healthy() -> false, sessionUser() -> null (no throw)
        healthyShouldFail = true;
        assert.equal(await pgAccounts.healthy(), false);
        assert.equal(await pgAccounts.sessionUser({ headers: { cookie: jar.cookie } }), null);

        // Recovery
        healthyShouldFail = false;
        assert.equal(await pgAccounts.healthy(), true);
        assert.deepEqual(await pgAccounts.sessionUser({ headers: { cookie: jar.cookie } }), user);
      } finally {
        await h.stop();
      }
      // After close
      assert.equal(await pgAccounts.healthy(), false);
    } finally {
      await pgAccounts.close();
    }
  });
});

describe('GET/HEAD /healthz', () => {
  test('returns 200 when accounts healthy, 503 when unhealthy, and supports HEAD', async () => {
    const h = createHarness();
    await h.start();
    try {
      const get = await h.api('/healthz');
      assert.equal(get.status, 200);
      assert.deepEqual(get.json, { ok: true });
      assert.equal(get.headers.get('cache-control'), 'no-store');
      assert.equal(get.headers.get('x-content-type-options'), 'nosniff');

      const head = await h.api('/healthz', { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.text, '');
      assert.equal(head.headers.get('cache-control'), 'no-store');

      const badMethod = await h.api('/healthz', { method: 'POST', body: {} });
      assert.equal(badMethod.status, 405);

      // Closing accounts DB causes /healthz to return 503 { ok: false }
      h.accounts.close();
      const down = await h.api('/healthz');
      assert.equal(down.status, 503);
      assert.deepEqual(down.json, { ok: false });
      assert.equal(down.headers.get('cache-control'), 'no-store');
      assert.equal(down.headers.get('x-content-type-options'), 'nosniff');
    } finally {
      await h.stop();
    }
  });

  test('returns 200 when server has no accounts configured', async () => {
    const h = createHarness({ accounts: null });
    await h.start();
    try {
      const r = await h.api('/healthz');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { ok: true });
    } finally {
      await h.stop();
    }
  });
});

describe('GET/HEAD /api/status', () => {
  test('returns lightweight status with online count, vessels, maxPlayers, and worldTime', async () => {
    const clockFeature = {
      name: 'test-clock',
      install(ctx) {
        ctx.services.worldClock = () => ({ minutes: 3 * 24 * 60 + 14 * 60 + 30 });
      },
    };
    const h = createHarness({
      features: [clockFeature],
      serverOpts: { maxPlayers: 250 },
    });
    await h.start();
    try {
      const r0 = await h.api('/api/status');
      assert.equal(r0.status, 200);
      assert.equal(r0.headers.get('cache-control'), 'no-store');
      assert.equal(r0.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r0.json.ok, true);
      assert.equal(r0.json.online, 0);
      assert.equal(r0.json.vessels, 0);
      assert.equal(r0.json.maxPlayers, 250);
      assert.ok(r0.json.worldTime && typeof r0.json.worldTime.dateLabel === 'string');
      assert.equal(typeof r0.json.worldTime.timeLabel, 'string');
      // Only expected keys
      assert.deepEqual(Object.keys(r0.json).sort(), ['maxPlayers', 'ok', 'online', 'vessels', 'worldTime']);

      // Join a player over WS and check online increments without leaking identity/location
      const { jar } = await h.register('StatusHero');
      const { ws, messages } = await h.connect(jar.cookie);
      try {
        ws.send(JSON.stringify({ type: 'join' }));
        await waitFor(() => messages.some((m) => m.type === 'welcome'));
        const r1 = await h.api('/api/status');
        assert.equal(r1.status, 200);
        assert.equal(r1.json.online, 1);
        assert.ok(!r1.text.includes('StatusHero'));
      } finally {
        ws.close();
      }

      const head = await h.api('/api/status', { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(head.text, '');

      const badMethod = await h.api('/api/status', { method: 'POST', body: {} });
      assert.equal(badMethod.status, 405);
    } finally {
      await h.stop();
    }
  });

  test('reports maxPlayers as null when uncapped (0 or Infinity) and worldTime as null when absent', async () => {
    const h = createHarness({ serverOpts: { maxPlayers: 0 } });
    await h.start();
    try {
      const r = await h.api('/api/status');
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, {
        ok: true,
        online: 0,
        vessels: 0,
        maxPlayers: null,
        worldTime: null,
      });
    } finally {
      await h.stop();
    }
  });
});

describe('GET/HEAD /api/me/character & POST /api/me/chronicles-privacy', () => {
  const h = createHarness();
  before(() => h.start());
  after(() => h.stop());

  test('unauthenticated requests return 401 with clean headers', async () => {
    const r = await h.api('/api/me/character');
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { error: 'sign in required' });
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');

    const p = await h.api('/api/me/chronicles-privacy', { method: 'POST', body: { hidden: true } });
    assert.equal(p.status, 401);
    assert.deepEqual(p.json, { error: 'sign in required' });
  });

  test('account with no character or uncreated character gets { character: null } and 404 on privacy toggle', async () => {
    const { user, jar } = await h.register('FreshHero');
    const none = await h.api('/api/me/character', { jar });
    assert.equal(none.status, 200);
    assert.deepEqual(none.json, { character: null });

    const privNone = await h.api('/api/me/chronicles-privacy', { method: 'POST', body: { hidden: true }, jar });
    assert.equal(privNone.status, 404);

    // Create an uncreated character row (character.created = false)
    const row = h.store.createForAccount(user.id, user.username, user.username);
    row.rpg = { character: { created: false, race: 'Nord' } };
    h.store.saveCharacters([row]);

    const uncreated = await h.api('/api/me/character', { jar });
    assert.equal(uncreated.status, 200);
    assert.deepEqual(uncreated.json, { character: null });

    const privUncreated = await h.api('/api/me/chronicles-privacy', { method: 'POST', body: { hidden: true }, jar });
    assert.equal(privUncreated.status, 404);
  });

  test('created character returns safe projected summary with ranks and excludes private fields', async () => {
    const { user, jar } = await h.register('Aurelia');
    const row = h.store.createForAccount(user.id, user.username, user.username);
    row.x = 123.456;
    row.z = -789.012;
    row.yaw = 1.5;
    row.rpg = makeCreatedRpg();
    h.store.saveCharacters([row]);
    await h.server.hiscores.syncPlayer({ id: row.id, name: row.name, rpg: row.rpg, accountId: user.id });

    const res = await h.api('/api/me/character', { jar });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

    const c = res.json.character;
    assert.ok(c);
    assert.equal(c.name, 'Aurelia');
    assert.equal(c.race, 'Breton');
    assert.equal(c.className, 'Spellsword');
    assert.equal(c.level, 12);
    assert.equal(c.totalSkill, 160);
    assert.equal(c.placesDiscovered, 2);
    assert.equal(c.totalClassicPlaces, TOTAL_CLASSIC_PLACES);
    assert.equal(c.questsCompleted, 5);
    assert.equal(c.monstersSlain, 23);
    assert.equal(c.guilds.mages.rank, 4);
    assert.deepEqual(c.order, { id: 'order-1', name: 'Blades of Iliac', tag: 'BOI', rank: 'Leader' });
    assert.equal(c.chroniclesHidden, false);
    assert.equal(c.overallRank, 1);
    assert.equal(c.levelRank, 1);

    // Privacy boundary: exact key whitelist & no sensitive values anywhere in payload
    assert.deepEqual(Object.keys(c).sort(), [
      'chroniclesHidden',
      'className',
      'guilds',
      'level',
      'levelRank',
      'monstersSlain',
      'name',
      'order',
      'overallRank',
      'placesDiscovered',
      'questsCompleted',
      'race',
      'totalClassicPlaces',
      'totalSkill',
    ]);
    for (const forbidden of [
      '123.456',
      '-789.012',
      'secret-lair',
      'Ring of Private Secrets',
      '424242',
      'secret-spell',
      'inventory',
      'password',
      'recovery',
      'token',
      'location',
    ]) {
      assert.ok(!res.text.includes(forbidden), `response must not leak ${forbidden}`);
    }

    const head = await h.api('/api/me/character', { method: 'HEAD', jar });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
  });

  test('POST /api/me/chronicles-privacy toggles hidden offline, updates hiscores visibility, and rejects CSRF/invalid input', async () => {
    const { user, jar } = await h.register('Voryn');
    const row = h.store.createForAccount(user.id, user.username, user.username);
    row.rpg = makeCreatedRpg({ character: { created: true, race: 'Dark Elf', className: 'Nightblade', level: 8, skills: { Stealth: 50 } } });
    h.store.saveCharacters([row]);
    await h.server.hiscores.syncPlayer({ id: row.id, name: row.name, rpg: row.rpg, accountId: user.id });

    // Confirm initially listed in public hiscores
    assert.equal((await h.api('/api/hiscores/player/Voryn')).status, 200);

    // Cross-origin & CSRF checks
    const badOrigin = await h.api('/api/me/chronicles-privacy', {
      method: 'POST',
      body: { hidden: true },
      jar,
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(badOrigin.status, 403);

    const badFetchSite = await h.api('/api/me/chronicles-privacy', {
      method: 'POST',
      body: { hidden: true },
      jar,
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(badFetchSite.status, 403);

    const badType = await h.api('/api/me/chronicles-privacy', {
      method: 'POST',
      body: '{"hidden":true}',
      jar,
      headers: { 'Content-Type': 'text/plain' },
    });
    assert.equal(badType.status, 415);

    const badVal = await h.api('/api/me/chronicles-privacy', {
      method: 'POST',
      body: { hidden: 'yes' },
      jar,
    });
    assert.equal(badVal.status, 400);

    const badMethod = await h.api('/api/me/chronicles-privacy', { method: 'GET', jar });
    assert.equal(badMethod.status, 405);

    // Hide character
    const hide = await h.api('/api/me/chronicles-privacy', { method: 'POST', body: { hidden: true }, jar });
    assert.equal(hide.status, 200);
    assert.deepEqual(hide.json, { ok: true, hidden: true });
    assert.equal(hide.headers.get('cache-control'), 'no-store');
    assert.equal(hide.headers.get('x-content-type-options'), 'nosniff');

    // Removed from public hiscores immediately
    assert.equal((await h.api('/api/hiscores/player/Voryn')).status, 404);
    const boardHidden = await h.api('/api/hiscores/board/overall');
    assert.ok(!boardHidden.json.entries.some((e) => e.name === 'Voryn'));

    // Owner still sees their character in /api/me/character with chroniclesHidden: true and null ranks
    const meHidden = await h.api('/api/me/character', { jar });
    assert.equal(meHidden.status, 200);
    assert.equal(meHidden.json.character.name, 'Voryn');
    assert.equal(meHidden.json.character.chroniclesHidden, true);
    assert.equal(meHidden.json.character.overallRank, null);
    assert.equal(meHidden.json.character.levelRank, null);

    // Persisted in store
    assert.equal(h.store.findByAccount(user.id).rpg.chronicles.hidden, true);

    // Unhide character
    const unhide = await h.api('/api/me/chronicles-privacy', { method: 'POST', body: { hidden: false }, jar });
    assert.equal(unhide.status, 200);
    assert.deepEqual(unhide.json, { ok: true, hidden: false });

    // Restored in public hiscores immediately
    assert.equal((await h.api('/api/hiscores/player/Voryn')).status, 200);
    const meVisible = await h.api('/api/me/character', { jar });
    assert.equal(meVisible.json.character.chroniclesHidden, false);
    assert.ok(Number.isInteger(meVisible.json.character.overallRank));
    assert.ok(Number.isInteger(meVisible.json.character.levelRank));
  });

  test('online player privacy toggle updates live player, persists, and syncs hiscores', async () => {
    const { user, jar } = await h.register('LiveKnight');
    const row = h.store.createForAccount(user.id, user.username, user.username);
    row.rpg = makeCreatedRpg({ character: { created: true, race: 'Redguard', className: 'Knight', level: 15, skills: { 'Long Blade': 80 } } });
    h.store.saveCharacters([row]);

    const { ws, messages } = await h.connect(jar.cookie);
    try {
      ws.send(JSON.stringify({ type: 'join' }));
      await waitFor(() => messages.some((m) => m.type === 'welcome'));

      // Live character is visible on hiscores
      assert.equal((await h.api('/api/hiscores/player/LiveKnight')).status, 200);

      // Toggle hidden while online
      const hide = await h.api('/api/me/chronicles-privacy', { method: 'POST', body: { hidden: true }, jar });
      assert.equal(hide.status, 200);
      assert.deepEqual(hide.json, { ok: true, hidden: true });
      assert.equal((await h.api('/api/hiscores/player/LiveKnight')).status, 404);
      const me = await h.api('/api/me/character', { jar });
      assert.equal(me.json.character.chroniclesHidden, true);
      assert.equal(me.json.character.level, 15);
    } finally {
      ws.close();
    }

    // After disconnect, persisted hidden=true remains intact
    await waitFor(() => h.store.findByAccount(user.id)?.rpg?.chronicles?.hidden === true);
    assert.equal((await h.api('/api/hiscores/player/LiveKnight')).status, 404);
  });

  test('supports async accounts.sessionUser (Promise) on /api/me/character and /api/me/chronicles-privacy', async () => {
    const asyncAccounts = {
      config: { publicOrigin: null, secureCookies: false, requireHttps: false, trustProxy: false },
      async sessionUser(req) {
        if (req.headers.cookie === 'auth=ok') return { id: 77, username: 'AsyncHero' };
        return null;
      },
      async healthy() {
        return true;
      },
      async handleHttp(_req, res) {
        res.writeHead(404).end();
      },
      resolveUpgrade() { return null; },
    };
    const ah = createHarness({ accounts: asyncAccounts });
    await ah.start();
    try {
      const row = ah.store.createForAccount(77, 'AsyncHero', 'AsyncHero');
      row.rpg = makeCreatedRpg();
      ah.store.saveCharacters([row]);

      const unauth = await ah.api('/api/me/character');
      assert.equal(unauth.status, 401);

      const ok = await ah.api('/api/me/character', { jar: { cookie: 'auth=ok' } });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.character.name, 'AsyncHero');
      assert.equal(ok.json.character.chroniclesHidden, false);

      const toggle = await ah.api('/api/me/chronicles-privacy', {
        method: 'POST',
        body: { hidden: true },
        jar: { cookie: 'auth=ok' },
      });
      assert.equal(toggle.status, 200);
      assert.deepEqual(toggle.json, { ok: true, hidden: true });
    } finally {
      await ah.stop();
    }
  });
});
