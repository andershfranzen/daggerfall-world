// Live PostgreSQL 17 integration test (runs when DFW_LIVE_PG_URL is set, skips otherwise).
// Exercises the REAL pg driver against a real PostgreSQL instance:
//   - server/storage/schema.sql (players, account_characters, world_state, accounts, sessions, moderation_log, chat_messages)
//   - server/storage/postgres-game.js + createBufferedGameStore
//   - server/storage/postgres-accounts.js + real PostgreSQL LISTEN/NOTIFY moderation fan-out
//   - server/chat-log.js (openPostgresChatLog)
//   - server/scale/world-bus.js (createPostgresBus real LISTEN/NOTIFY cross-worker messaging)
//   - tools/migrate-to-postgres.mjs (real SQLite -> real PostgreSQL 17 migration + idempotency)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { openStore } from '../server/db.js';
import { createAccounts, createPostgresAccounts } from '../server/accounts.js';
import { createGameServer, CLOSE } from '../server/game.js';
import { openPostgresGameStore, createBufferedGameStore, createPgPool } from '../server/storage/postgres-game.js';
import { openPostgresAccountStore } from '../server/storage/postgres-accounts.js';
import { openPostgresChatLog } from '../server/chat-log.js';
import { createPostgresBus } from '../server/scale/world-bus.js';
import { migrateSqliteToPostgres } from '../tools/migrate-to-postgres.mjs';

const PG_URL = process.env.DFW_LIVE_PG_URL;
const MAIN_JS = fileURLToPath(new URL('../server/main.js', import.meta.url));

function cookieHeader(res) {
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  return setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
}

function connectWs(port, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    const queue = [];
    const waiters = [];
    let closed = null;
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const idx = waiters.findIndex((w) => w.pred(msg));
      if (idx !== -1) {
        const [w] = waiters.splice(idx, 1);
        w.resolve(msg);
      } else {
        queue.push(msg);
      }
    });
    ws.on('close', (code, reason) => {
      closed = { code, reason: String(reason) };
      for (const w of waiters.splice(0)) w.reject(new Error(`ws closed (${code}: ${reason})`));
    });
    ws.once('open', () => {
      resolve({
        ws,
        send: (obj) => ws.send(JSON.stringify(obj)),
        next: (pred = () => true, timeoutMs = 5000) => {
          const idx = queue.findIndex(pred);
          if (idx !== -1) return Promise.resolve(queue.splice(idx, 1)[0]);
          if (closed) return Promise.reject(new Error(`ws already closed (${closed.code})`));
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('ws message timeout')), timeoutMs);
            waiters.push({
              pred,
              resolve: (m) => { clearTimeout(t); res(m); },
              reject: (e) => { clearTimeout(t); rej(e); },
            });
          });
        },
        waitClose: (timeoutMs = 5000) => {
          if (closed) return Promise.resolve(closed);
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('ws close timeout')), timeoutMs);
            ws.once('close', (code, reason) => { clearTimeout(t); res({ code, reason: String(reason) }); });
          });
        },
      });
    });
    ws.once('error', reject);
  });
}

test('live PostgreSQL 17 end-to-end: game store, buffered commits, accounts + LISTEN/NOTIFY, chat log, world bus, and SQLite migration', {
  skip: !PG_URL ? 'set DFW_LIVE_PG_URL to run live PostgreSQL integration test' : false,
}, async () => {
  const pool = await createPgPool(PG_URL);
  const tmp = mkdtempSync(join(tmpdir(), 'dfw-live-pg-'));
  try {
    // 1. Game store + schema + buffered write-behind commits.
    const pgGame = await openPostgresGameStore({ pool, applySchema: true });
    const buffered = createBufferedGameStore(pgGame);

    const accChar = await pgGame.createForAccount('pg-acc-1', 'Gothryd', 'Gothryd');
    assert.ok(accChar.id > 0);
    accChar.x = 42.5;
    accChar.z = -17.25;
    accChar.rpg = { gold: 777, location: 'town:Daggerfall/Gothway Garden' };
    buffered.saveCharacters([accChar], [['pg-test:shop:1', { purse: 1200 }]]);
    await buffered.flush();

    const loaded = await pgGame.findByAccount('pg-acc-1');
    assert.equal(loaded.x, 42.5);
    assert.equal(loaded.rpg.gold, 777);
    const worldRows = await pgGame.loadWorld('pg-test:');
    assert.deepEqual(worldRows, [['pg-test:shop:1', { purse: 1200 }]]);

    // 2. Accounts store + real LISTEN/NOTIFY moderation fan-out.
    const pgAccounts = await openPostgresAccountStore({ pool, applySchema: false });
    const receivedMod = [];
    const unsub = await pgAccounts.listenModeration((ev) => receivedMod.push(ev));
    const createdAcc = await pgAccounts.createAccount('LivePgHero', 'scrypt$1024$8$1$salt$hash');
    assert.ok(createdAcc.id > 0);
    await pgAccounts.ban('LivePgHero', { reason: 'live pg moderation check', actor: 'test-operator' });
    for (let i = 0; i < 40 && !receivedMod.length; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(receivedMod.some((e) => e.accountId === createdAcc.id && e.action === 'ban'), 'real PG LISTEN/NOTIFY delivered ban event');
    await unsub();

    // 3. Persistent chat log in real PostgreSQL chat_messages table.
    const pgChat = await openPostgresChatLog(pool);
    await pgChat.record({
      channel: 'shout',
      location: 'town:Daggerfall/Gothway Garden',
      senderPlayerId: accChar.id,
      senderAccountId: String(createdAcc.id),
      senderName: 'Gothryd',
      body: 'Live Postgres chat persistence works!',
    });
    const chatRes = await pgChat.query({ senderName: 'gothryd', channel: 'shout' });
    assert.equal(chatRes.rows.length, 1);
    assert.equal(chatRes.rows[0].body, 'Live Postgres chat persistence works!');

    // 4. Real PostgreSQL LISTEN/NOTIFY cross-worker WorldBus.
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    const workerA = await createPostgresBus({ client: clientA, publishClient: pool, workerId: 'worker-daggerfall', secret: 'live-pg-secret' }).connect();
    const workerB = await createPostgresBus({ client: clientB, publishClient: pool, workerId: 'worker-sentinel', secret: 'live-pg-secret' }).connect();
    const relayed = [];
    workerB.onChat((msg) => relayed.push(msg));
    await workerA.publishChat({ channel: 'global', from: 'Gothryd', text: 'Cross-worker PG bus hello!' });
    for (let i = 0; i < 40 && !relayed.length; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(relayed.some((m) => m.text === 'Cross-worker PG bus hello!'), 'real PG WorldBus relayed cross-worker chat');
    await workerA.close();
    await workerB.close();
    clientA.release();
    clientB.release();

    // 5. Real SQLite -> PostgreSQL 17 migration via tools/migrate-to-postgres.mjs (into clean target tables).
    await pool.query('TRUNCATE account_characters, players, world_state, sessions, moderation_log, accounts RESTART IDENTITY CASCADE');
    const sqliteGamePath = join(tmp, 'game.db');
    const sqliteAccPath = join(tmp, 'accounts.db');
    const sg = openStore(sqliteGamePath);
    const migRow = sg.createForAccount('mig-acc-99', 'Barenziah', 'Barenziah');
    migRow.rpg = { gold: 999, migrated: true };
    sg.saveCharacters([migRow], [['mig:world:1', { ok: true }]]);
    sg.close();
    const sa = createAccounts({ dbPath: sqliteAccPath, secureCookies: false, scrypt: { N: 1024, r: 8, p: 1, keyLen: 32 } });
    sa.close();

    const summary1 = await migrateSqliteToPostgres({ gameDbPath: sqliteGamePath, accountsDbPath: sqliteAccPath, databaseUrl: PG_URL, pool });
    assert.ok(summary1.game.players >= 1);
    const summary2 = await migrateSqliteToPostgres({ gameDbPath: sqliteGamePath, accountsDbPath: sqliteAccPath, databaseUrl: PG_URL, pool });
    assert.ok(summary2.game.players >= 1, 'migration is idempotent on repeat run');
    const migrated = await pgGame.findByAccount('mig-acc-99');
    assert.equal(migrated.name, 'Barenziah');
    assert.equal(migrated.rpg.gold, 999);

    await pgAccounts.close();
    await pgGame.close();
  } finally {
    await pool.end();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('live PostgreSQL 17 full HTTP + WebSocket game server (zero SQLite): register, password, WS join, chat persistence, cold restart, delete-account', {
  skip: !PG_URL ? 'set DFW_LIVE_PG_URL to run live PostgreSQL integration test' : false,
}, async () => {
  const adminPool = await createPgPool(PG_URL);
  await adminPool.query(
    'TRUNCATE chat_messages, account_characters, players, world_state, sessions, moderation_log, accounts RESTART IDENTITY CASCADE'
  );

  const bootStack = async () => {
    const accounts = await createPostgresAccounts({
      connectionString: PG_URL,
      secureCookies: false,
      scrypt: { N: 1024, r: 8, p: 1, keyLen: 32 },
    });
    const pgGame = await openPostgresGameStore({ connectionString: PG_URL, applySchema: false });
    const store = createBufferedGameStore(pgGame);
    await store.preloadWorld();
    const chatLog = await openPostgresChatLog(pgGame.pool);
    const server = createGameServer({
      accounts,
      store,
      chatLog,
      host: '127.0.0.1',
      port: 0,
    });
    const addr = await server.start();
    return { accounts, store, chatLog, server, port: addr.port, base: `http://127.0.0.1:${addr.port}` };
  };

  let stack1 = null;
  let stack2 = null;
  try {
    // --- Boot 1 ---
    stack1 = await bootStack();

    // 1. Register via /api/register on Postgres
    const regRes = await fetch(`${stack1.base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: stack1.base },
      body: JSON.stringify({ username: 'PgHeroine', password: 'InitialPassword#1' }),
    });
    assert.equal(regRes.status, 201);
    const regBody = await regRes.json();
    assert.equal(regBody.user.username, 'PgHeroine');
    assert.ok(typeof regBody.recoveryCode === 'string' && regBody.recoveryCode.length >= 16, 'returns one-time recoveryCode');
    let cookie = cookieHeader(regRes);
    assert.ok(cookie.includes('dfw_session='), 'sets session cookie');

    // 2. Change password via /api/password
    const pwRes = await fetch(`${stack1.base}/api/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: stack1.base, cookie },
      body: JSON.stringify({ currentPassword: 'InitialPassword#1', newPassword: 'RotatedPassword#2' }),
    });
    assert.equal(pwRes.status, 200);

    // 3. Re-login with rotated password
    const loginRes = await fetch(`${stack1.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: stack1.base },
      body: JSON.stringify({ username: 'PgHeroine', password: 'RotatedPassword#2' }),
    });
    assert.equal(loginRes.status, 200);
    cookie = cookieHeader(loginRes);
    assert.ok(cookie.includes('dfw_session='));

    // 4. Connect over WebSocket /ws (async resolveUpgrade + async handleJoin -> Postgres)
    const sock1 = await connectWs(stack1.port, cookie);
    sock1.send({ type: 'join', name: 'PgHeroine' });
    const welcome1 = await sock1.next((m) => m.type === 'welcome');
    assert.ok(welcome1.id > 0);
    assert.equal(welcome1.player.name, 'PgHeroine');
    const persistedPlayerId = welcome1.id;

    // 5. Send a town-wide shout chat and verify persistence in real Postgres chat_messages
    sock1.send({ type: 'chat', text: '/shout Hail from live PostgreSQL 17!' });
    await sock1.next((m) => m.type === 'chat' && m.text.includes('Hail from live PostgreSQL 17!'));
    let chatRows = [];
    for (let i = 0; i < 40; i++) {
      const res = await adminPool.query('SELECT channel, sender_name, body FROM chat_messages ORDER BY id DESC');
      chatRows = res.rows;
      if (chatRows.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(chatRows.some((r) => r.sender_name === 'PgHeroine' && r.body.includes('Hail from live PostgreSQL 17!')), 'chat persisted in PG chat_messages');

    // 6. Cleanly shut down server 1 (flushes buffered writes to Postgres)
    await stack1.server.close();
    await stack1.accounts.close();
    stack1 = null;

    // --- Boot 2 (cold restart against same PostgreSQL 17 database) ---
    stack2 = await bootStack();

    // 7. Reconnect over /ws using the SAME Postgres session cookie -> resumes same character ID
    const sock2 = await connectWs(stack2.port, cookie);
    sock2.send({ type: 'join', name: 'PgHeroine' });
    const welcome2 = await sock2.next((m) => m.type === 'welcome');
    assert.equal(welcome2.id, persistedPlayerId, 'character ID survived cold restart via PostgreSQL');
    assert.equal(welcome2.player.name, 'PgHeroine');

    // 8. Delete account via /api/delete-account -> disconnects live socket and removes PG rows
    const delPromise = sock2.waitClose();
    const delRes = await fetch(`${stack2.base}/api/delete-account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: stack2.base, cookie },
      body: JSON.stringify({ password: 'RotatedPassword#2' }),
    });
    assert.equal(delRes.status, 200);
    const closedEv = await delPromise;
    assert.equal(closedEv.code, CLOSE.ACCOUNT, 'active WS kicked with CLOSE.ACCOUNT on self-delete');

    // Wait briefly for async deleteForAccount to settle in Postgres
    let remainingPlayers = 1;
    for (let i = 0; i < 40; i++) {
      const r = await adminPool.query('SELECT COUNT(*)::int AS n FROM players WHERE id = $1', [persistedPlayerId]);
      remainingPlayers = r.rows[0].n;
      if (remainingPlayers === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(remainingPlayers, 0, 'player row deleted from Postgres on account deletion');

    const meAfter = await fetch(`${stack2.base}/api/me`, { headers: { cookie } });
    assert.equal(meAfter.status, 200);
    assert.equal((await meAfter.json()).user, null, 'deleted account session is rejected');
  } finally {
    if (stack1) {
      await stack1.server.close().catch(() => {});
      await stack1.accounts.close().catch(() => {});
    }
    if (stack2) {
      await stack2.server.close().catch(() => {});
      await stack2.accounts.close().catch(() => {});
    }
    await adminPool.end();
  }
});

test('live PostgreSQL 17 server/main.js boot via DATABASE_URL, redacted logs, HTTP APIs, and graceful SIGTERM', {
  skip: !PG_URL ? 'set DFW_LIVE_PG_URL to run live PostgreSQL integration test' : false,
}, async () => {
  const parsed = new URL(PG_URL);
  const secretPass = decodeURIComponent(parsed.password || '');

  const child = spawn(process.execPath, [MAIN_JS, '--dev'], {
    env: {
      ...process.env,
      DATABASE_URL: PG_URL,
      ACCOUNTS_DATABASE_URL: '',
      HOST: '127.0.0.1',
      PORT: '0',
      COOKIE_SECURE: '0',
      LOCAL_ASSETS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });

  let port = null;
  try {
    // Wait until server prints listening line
    for (let i = 0; i < 200; i++) {
      const m = stdout.match(/daggerfallworld server listening on http:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        port = Number(m[1]);
        break;
      }
      if (child.exitCode !== null) {
        throw new Error(`server/main.js exited early (${child.exitCode}):\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(port && port > 0, `server/main.js bound to ephemeral port (stdout=${stdout}, stderr=${stderr})`);

    // Wait a tick for the database/accounts banner lines to flush
    for (let i = 0; i < 40 && !stdout.includes('accounts:'); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.match(stdout, /database:\s+postgres(?:ql)?:\/\/\*\*\*:\*\*\*@/i, 'database URL logged with redacted credentials');
    assert.match(stdout, /accounts:\s+postgres(?:ql)?:\/\/\*\*\*:\*\*\*@/i, 'accounts URL logged with redacted credentials');
    if (secretPass) {
      assert.equal(stdout.includes(secretPass), false, 'stdout must never leak DB password');
      assert.equal(stderr.includes(secretPass), false, 'stderr must never leak DB password');
    }

    const base = `http://127.0.0.1:${port}`;
    const mapRes = await fetch(`${base}/api/world-map`);
    assert.equal(mapRes.status, 200);
    const mapJson = await mapRes.json();
    assert.equal(typeof mapJson.online, 'number');

    const regRes = await fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'MainBootHero', password: 'MainBootPassword#9' }),
    });
    assert.equal(regRes.status, 201);

    // Graceful shutdown on SIGTERM
    const exitCode = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('SIGTERM shutdown timeout')), 10_000);
      child.once('exit', (code) => { clearTimeout(t); resolve(code); });
      child.kill('SIGTERM');
    });
    assert.equal(exitCode, 0, `server/main.js exited cleanly with 0 (stderr=${stderr})`);
    assert.match(stdout, /SIGTERM received, saving and shutting down/);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
    }
  }
});
