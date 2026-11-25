// End to end: accounts (server/accounts.js) wired into the game server, as server/main.js does it.
// Register over HTTP, enter /ws with the session cookie, and check that bans, revocation and logout
// take effect on the socket.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createGameServer, CLOSE } from '../server/game.js';
import { createAccounts, runCli } from '../server/accounts.js';

const PASSWORD = 'lantern by the gate';
let tmp, accounts, server, base, origin;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'dfw-acctws-'));
  const clientDir = join(tmp, 'client');
  const siteDir = join(tmp, 'site');
  mkdirSync(clientDir);
  mkdirSync(siteDir);
  writeFileSync(join(clientDir, 'play.html'), '<!doctype html><title>play</title>');
  writeFileSync(join(siteDir, 'index.html'), '<!doctype html><title>site</title>');
  accounts = createAccounts({
    dbPath: join(tmp, 'accounts.db'),
    scrypt: { N: 1024, r: 8, p: 1, keyLen: 32 },
    moderationPollMs: 20,
  });
  server = createGameServer({
    host: '127.0.0.1',
    port: 0,
    dbPath: join(tmp, 'game.db'),
    clientDir,
    siteDir,
    accounts,
  });
  const addr = await server.start();
  origin = `http://127.0.0.1:${addr.port}`;
  base = `ws://127.0.0.1:${addr.port}/ws`;
});

after(async () => {
  await server.close();
  accounts.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function post(path, body, cookie) {
  const res = await fetch(origin + path, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, json: await res.json(), cookie: setCookie ? setCookie.split(';')[0] : null };
}

function connect(cookie, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(base, { headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...headers } });
    const messages = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('error', () => {});
  });
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

test('the game socket refuses upgrades without a session', async () => {
  assert.equal((await connect(null)).status, 401);
  assert.equal((await connect('__Host-dfw_session=' + 'x'.repeat(43))).status, 401);
});

test('a registered account joins under its account name', async () => {
  const reg = await post('/api/register', { username: 'Quill', password: PASSWORD });
  assert.equal(reg.status, 201);
  const { ws, messages } = await connect(reg.cookie);
  ws.send(JSON.stringify({ type: 'join', name: 'Impostor' }));
  const welcome = await waitFor(() => messages.find((m) => m.type === 'welcome'));
  assert.equal(welcome.player.name, 'Quill');
  ws.close();
  await closed(ws);
});

test('logout invalidates the cookie for new sockets', async () => {
  const { cookie } = await post('/api/login', { username: 'Quill', password: PASSWORD });
  assert.ok((await connect(cookie)).ws);
  await post('/api/logout', {}, cookie);
  assert.equal((await connect(cookie)).status, 401);
});

test('logout closes only the game connections of the signed-out session', async () => {
  // Two independent sessions of one account (e.g. two browsers).
  const a = await post('/api/login', { username: 'Quill', password: PASSWORD });
  const b = await post('/api/login', { username: 'Quill', password: PASSWORD });
  assert.notEqual(a.cookie, b.cookie);
  const connA = await connect(a.cookie);
  connA.ws.send(JSON.stringify({ type: 'join' }));
  await waitFor(() => connA.messages.find((m) => m.type === 'welcome'));
  // Session B is connected but not joined: joining would take over the shared character.
  const connB = await connect(b.cookie);
  assert.ok(connB.ws);

  const closedA = closed(connA.ws);
  let bClosed = false;
  connB.ws.once('close', () => (bClosed = true));
  const out = await post('/api/logout', {}, a.cookie);
  assert.equal(out.status, 200);

  const { code, reason } = await closedA;
  assert.equal(code, CLOSE.ACCOUNT);
  assert.equal(reason, 'signed out');
  assert.equal((await connect(a.cookie)).status, 401);

  // B is untouched: still open, can join the character, and its cookie still upgrades.
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(bClosed, false);
  assert.equal(connB.ws.readyState, WebSocket.OPEN);
  connB.ws.send(JSON.stringify({ type: 'join' }));
  const welcome = await waitFor(() => connB.messages.find((m) => m.type === 'welcome'));
  assert.equal(welcome.player.name, 'Quill');
  const extra = await connect(b.cookie);
  assert.ok(extra.ws);
  extra.ws.close();
  connB.ws.close();
  await closed(connB.ws);
  await post('/api/logout', {}, b.cookie);
});

test('mute is visible to the runtime through isMuted', async () => {
  const id = accounts.find('Quill').id;
  accounts.mute('Quill', { minutes: 5 });
  assert.equal(accounts.isMuted(id), true);
  accounts.unmute('Quill');
  assert.equal(accounts.isMuted(id), false);
});

test('an operator ban from the CLI disconnects the live socket and blocks re-entry', async () => {
  const { cookie } = await post('/api/login', { username: 'Quill', password: PASSWORD });
  const { ws, messages } = await connect(cookie);
  ws.send(JSON.stringify({ type: 'join' }));
  await waitFor(() => messages.find((m) => m.type === 'welcome'));
  const done = closed(ws);
  assert.equal(runCli(['ban', 'Quill', 'test'], { dbPath: accounts.config.dbPath, out: () => {} }), 0);
  const { code } = await done;
  assert.equal(code, CLOSE.ACCOUNT);
  assert.equal((await connect(cookie)).status, 401);
  assert.equal((await post('/api/login', { username: 'Quill', password: PASSWORD })).status, 403);
  accounts.unban('Quill');
});

test('revoking sessions disconnects the account', async () => {
  const { cookie } = await post('/api/login', { username: 'Quill', password: PASSWORD });
  const { ws, messages } = await connect(cookie);
  ws.send(JSON.stringify({ type: 'join' }));
  await waitFor(() => messages.find((m) => m.type === 'welcome'));
  const done = closed(ws);
  accounts.revokeSessions('Quill');
  assert.equal((await done).code, CLOSE.ACCOUNT);
  assert.equal((await connect(cookie)).status, 401);
});
