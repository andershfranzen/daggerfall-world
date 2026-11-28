// Integration tests for the authoritative server: real HTTP + WebSocket clients, isolated temp DB.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { request } from 'node:http';
import WebSocket from 'ws';
import { createGameServer, CLOSE } from '../server/game.js';

let tmp;
let clientDir;
let siteDir;
let dbPath;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dfw-test-'));
  clientDir = join(tmp, 'client');
  mkdirSync(join(clientDir, 'js'), { recursive: true });
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>t</title>');
  writeFileSync(join(clientDir, 'js', 'main.js'), 'export const x = 1;');
  writeFileSync(join(clientDir, '.secret.json'), '{}');
  writeFileSync(join(tmp, 'outside.json'), '{"leak":true}');
  symlinkSync(join(tmp, 'outside.json'), join(clientDir, 'link.json'));
  dbPath = join(tmp, 'db', 'world.db');

  // Shape of a Next.js static export (output: 'export', trailingSlash: true).
  siteDir = join(tmp, 'site');
  const site = (rel, body) => {
    mkdirSync(join(siteDir, rel, '..'), { recursive: true });
    writeFileSync(join(siteDir, rel), body);
  };
  site('index.html', '<!doctype html><title>home</title>');
  site('index.txt', 'rsc-home');
  site('404.html', '<!doctype html><title>custom 404</title>');
  site('guide/index.html', '<!doctype html><title>guide</title>');
  site('guide/index.txt', 'rsc-guide');
  site('guide/__next.guide/__PAGE__.txt', 'rsc-segment');
  site('guide/__next._tree.txt', 'rsc-tree');
  site('development/index.html', '<!doctype html><title>development</title>');
  site('_next/static/chunks/app-123.js', 'console.log(1)');
  site('_next/static/media/font.woff2', 'w');
  site('images/mark.svg', '<svg/>');
  site('play.html', 'site must not shadow the game');
  site('CREDITS.md', 'not allow-listed');
  // A game-client page that must never shadow the website root.
  writeFileSync(join(clientDir, 'play.html'), '<!doctype html><title>play</title>');
});

after(() => rmSync(tmp, { recursive: true, force: true }));

async function startServer(extra = {}) {
  // Isolated from production RPG features (collision etc.); test/rpg-runtime*.test.mjs covers them.
  const server = createGameServer({ host: '127.0.0.1', port: 0, dbPath, clientDir, siteDir, features: [], ...extra });
  const { port } = await server.start();
  return { server, port };
}

class Client {
  constructor(port, headers) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    this.closed = new Promise((resolve) => this.ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })));
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (d) => {
      const msg = JSON.parse(d);
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => !w(msg));
    });
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  // Resolves with the first message (past or future) matching pred.
  next(pred, timeout = 3000) {
    const found = this.messages.find(pred);
    if (found) {
      this.messages.splice(this.messages.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for message')), timeout);
      this.waiters.push((msg) => {
        if (!pred(msg)) return false;
        clearTimeout(t);
        this.messages.splice(this.messages.indexOf(msg), 1);
        resolve(msg);
        return true;
      });
    });
  }
  async join(name, token) {
    await this.opened;
    this.send({ type: 'join', name, token });
    return this.next((m) => m.type === 'welcome' || m.type === 'error');
  }
  latestState() {
    this.messages = this.messages.filter((m) => m.type !== 'state');
    return this.next((m) => m.type === 'state');
  }
  close() {
    this.ws.close();
    return this.closed;
  }
}

// Hold an input for `ms`, refreshing at ~10 Hz like the browser client does.
async function hold(client, input, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    client.send({ type: 'input', ...input });
    await sleep(100);
  }
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('two clients: join, movement, chat, validation; persistence across restart', async () => {
  let { server, port } = await startServer();
  const a = new Client(port);
  const b = new Client(port);
  const wa = await a.join('Alice');
  const wb = await b.join('  Bob   the  Brave ');
  assert.equal(wa.type, 'welcome');
  assert.equal(typeof wa.token, 'string');
  assert.ok(wa.token.length >= 40);
  assert.deepEqual(wa.player, { id: wa.id, name: 'Alice', x: 0, z: 0, yaw: 0, moving: false });
  assert.equal(wb.player.name, 'Bob the Brave');
  assert.notEqual(wa.id, wb.id);

  // Both players visible to both.
  const s0 = await b.latestState();
  assert.deepEqual(s0.players.map((p) => p.id).sort(), [wa.id, wb.id].sort());

  // Alice walks forward with yaw 0 -> toward -z at <= 4 m/s.
  await hold(a, { forward: 1, strafe: 0, yaw: 0 }, 600);
  let me = (await b.latestState()).players.find((p) => p.id === wa.id);
  assert.equal(me.moving, true);
  assert.ok(me.z < -1.5 && me.z > -3.2, `z=${me.z}`);
  assert.ok(Math.abs(me.x) < 1e-6);

  // Out-of-range axes are clamped, diagonal is normalized: yaw +pi/2 (turned right) forward -> +x.
  const z1 = me.z;
  await hold(a, { forward: 5, strafe: 0, yaw: Math.PI / 2 }, 500);
  me = (await b.latestState()).players.find((p) => p.id === wa.id);
  assert.ok(me.x > 1 && me.x < 2.6, `x=${me.x}`);
  assert.ok(Math.abs(me.z - z1) < 0.05);

  // Idle expiry: stop refreshing -> stops moving.
  await sleep(700);
  const still = (await b.latestState()).players.find((p) => p.id === wa.id);
  assert.equal(still.moving, false);
  await sleep(200);
  const still2 = (await b.latestState()).players.find((p) => p.id === wa.id);
  assert.equal(still2.x, still.x);
  assert.equal(still2.z, still.z);

  // Chat reaches both, sanitized.
  b.send({ type: 'chat', text: '  hello\u0007 world  ' });
  assert.deepEqual(await a.next((m) => m.type === 'chat'), { type: 'chat', name: 'Bob the Brave', text: 'hello world' });
  assert.deepEqual(await b.next((m) => m.type === 'chat'), { type: 'chat', name: 'Bob the Brave', text: 'hello world' });

  // Non-fatal errors.
  a.send({ type: 'input', forward: 'x', strafe: 0, yaw: 0 });
  assert.equal((await a.next((m) => m.type === 'error')).type, 'error');
  a.ws.send('not json');
  assert.match((await a.next((m) => m.type === 'error')).message, /JSON/);
  a.send({ type: 'chat', text: 'x'.repeat(500) });
  assert.match((await a.next((m) => m.type === 'error')).message, /longer/);
  a.send({ type: 'join', name: 'Again' });
  assert.match((await a.next((m) => m.type === 'error')).message, /already/);
  const bad = new Client(port);
  assert.equal((await bad.join('<script>')).type, 'error');
  await bad.close();

  // Restart: state persisted on close.
  const final = (await a.latestState()).players.find((p) => p.id === wa.id);
  const shutdown = a.closed;
  await server.close();
  assert.equal((await shutdown).code, CLOSE.SHUTDOWN);
  await b.closed;

  ({ server, port } = await startServer());
  try {
    const a2 = new Client(port);
    const w2 = await a2.join('Ignored New Name', wa.token);
    assert.equal(w2.type, 'welcome');
    assert.equal(w2.id, wa.id);
    assert.equal(w2.token, wa.token);
    assert.equal(w2.player.name, 'Alice');
    assert.ok(Math.abs(w2.player.x - final.x) < 0.01 && Math.abs(w2.player.z - final.z) < 0.01);
    assert.ok(Math.abs(w2.player.yaw - Math.PI / 2) < 0.01);

    // Same token from another connection replaces the old session.
    const a3 = new Client(port);
    const w3 = await a3.join(undefined, wa.token);
    assert.equal(w3.id, wa.id);
    assert.equal((await a2.closed).code, CLOSE.REPLACED);
    const s = await a3.latestState();
    assert.equal(s.players.filter((p) => p.id === wa.id).length, 1);

    // Invalid token is explicit and fatal.
    const imposter = new Client(port);
    const err = await imposter.join('Alice', 'A'.repeat(43));
    assert.deepEqual(err, { type: 'error', message: 'invalid token' });
    assert.equal((await imposter.closed).code, CLOSE.INVALID_TOKEN);
    await a3.close();
  } finally {
    await server.close();
  }
});

test('protocol guards: join-first, timeout, rate limit, origin, bounds', async () => {
  const { server, port } = await startServer({ joinTimeoutMs: 300, worldHalfExtent: 1, msgBurst: 10, msgRatePerSec: 5 });
  try {
    const c = new Client(port);
    await c.opened;
    c.send({ type: 'chat', text: 'hi' });
    assert.match((await c.next((m) => m.type === 'error')).message, /join first/);
    assert.equal((await c.closed).code, CLOSE.PROTOCOL);

    // Bounds clamp.
    const w = new Client(port);
    await w.join('Walker');
    await hold(w, { forward: 1, strafe: 0, yaw: 0 }, 700);
    const me = (await w.latestState()).players[0];
    assert.equal(me.z, -1);

    // Flooding closes the connection.
    for (let i = 0; i < 100; i++) w.send({ type: 'input', forward: 0, strafe: 0, yaw: 0 });
    assert.equal((await w.closed).code, CLOSE.RATE_LIMIT);

    // Cross-origin upgrade is refused; same-origin works.
    const evil = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'http://evil.example' } });
    await new Promise((resolve) => evil.on('error', resolve));
    const good = new Client(port, { Origin: `http://127.0.0.1:${port}` });
    assert.equal((await good.join('Local')).type, 'welcome');
    await good.close();
  } finally {
    await server.close();
  }
});

test('static delivery is rooted in client dir and safe', async () => {
  const { server, port } = await startServer();
  try {
    let r = await get(port, '/index.html');
    assert.equal(r.status, 200);
    assert.match(r.type, /^text\/html/);
    r = await get(port, '/js/main.js');
    assert.equal(r.status, 200);
    assert.match(r.type, /^text\/javascript/);
    for (const p of ['/../outside.json', '/%2e%2e/outside.json', '/js/%2e%2e%2f..%2foutside.json', '/link.json', '/.secret.json', '/js', '/missing.html', '/js/main.js%00.html', '/..%5coutside.json']) {
      r = await get(port, p);
      assert.equal(r.status, 404, p);
      assert.ok(!r.body.includes('leak'), p);
    }
    assert.equal((await get(port, '/ws')).status, 426);
  } finally {
    await server.close();
  }
});

test('website export and game client share one origin', async () => {
  const { server, port } = await startServer();
  try {
    const ok = async (path, re, body) => {
      const r = await get(port, path);
      assert.equal(r.status, 200, path);
      assert.match(r.type, re, path);
      if (body) assert.equal(r.body, body, path);
      return r;
    };
    // Website pages, direct loads and reloads.
    assert.match((await ok('/', /^text\/html/)).body, /home/);
    assert.match((await ok('/guide/', /^text\/html/)).body, /guide/);
    assert.match((await ok('/development/', /^text\/html/)).body, /development/);
    assert.match((await ok('/guide/?x=1', /^text\/html/)).body, /guide/);
    // RSC navigation payloads, including nested segment files.
    await ok('/index.txt', /^text\/plain/, 'rsc-home');
    await ok('/guide/index.txt?_rsc=abc', /^text\/plain/, 'rsc-guide');
    await ok('/guide/__next.guide/__PAGE__.txt', /^text\/plain/, 'rsc-segment');
    await ok('/guide/__next._tree.txt', /^text\/plain/, 'rsc-tree');
    // Hashed assets are immutable; everything else revalidates.
    let r = await ok('/_next/static/chunks/app-123.js', /^text\/javascript/);
    assert.match(r.headers['cache-control'], /immutable/);
    await ok('/_next/static/media/font.woff2', /^font\/woff2/);
    r = await ok('/images/mark.svg', /^image\/svg/);
    assert.equal(r.headers['cache-control'], 'no-cache');
    // Game client wins for exact files and opts out of CDN/browser TTL caching so deploys land immediately.
    const playRes = await ok('/play.html', /^text\/html/, undefined);
    assert.match(playRes.body, /play/);
    assert.match(playRes.headers['cache-control'], /no-store/);
    assert.equal(playRes.headers['cdn-cache-control'], 'no-store');
    const jsRes = await ok('/js/main.js', /^text\/javascript/);
    assert.match(jsRes.headers['cache-control'], /no-store/);
    assert.equal(jsRes.headers['cdn-cache-control'], 'no-store');
    // trailingSlash redirect keeps the query string.
    r = await get(port, '/guide?x=1');
    assert.equal(r.status, 308);
    assert.equal(r.headers.location, '/guide/?x=1');
    // Unknown routes get the exported 404 page with status 404.
    for (const p of ['/nope', '/nope/', '/guide/nope/', '/CREDITS.md', '/_next/', '/.env', '/guide/.hidden/x.txt', '//evil.example/']) {
      r = await get(port, p);
      assert.equal(r.status, 404, p);
      assert.ok(!r.headers.location, p);
    }
    assert.match((await get(port, '/nope/')).body, /custom 404/);
    // Database and server sources are unreachable.
    for (const p of ['/server/game.js', '/db/world.db', '/../db/world.db', '/%2e%2e/db/world.db']) {
      assert.equal((await get(port, p)).status, 404, p);
    }
    r = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/', method: 'POST' }, (res) => resolve(res.statusCode));
      req.on('error', reject);
      req.end();
    });
    assert.equal(r, 405);
  } finally {
    await server.close();
  }
});

test('standalone game opens the launcher when there is no website export', async () => {
  const { server, port } = await startServer({ siteDir: join(tmp, 'no-such-site') });
  try {
    assert.equal((await get(port, '/play.html')).status, 200);
    const r = await get(port, '/');
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/play.html');
  } finally {
    await server.close();
  }
});

test('dev mode hands non-game requests and non-/ws upgrades to the website server', async () => {
  const seen = [];
  const website = {
    handle(req, res) {
      seen.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('next-dev');
    },
    upgrade(req, socket) {
      seen.push(`upgrade ${req.url}`);
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    },
  };
  const { server, port } = await startServer({ website });
  try {
    assert.equal((await get(port, '/guide/')).body, 'next-dev');
    assert.match((await get(port, '/play.html')).body, /play/); // game client still first
    assert.equal((await get(port, '/ws')).status, 426);
    const hmr = new WebSocket(`ws://127.0.0.1:${port}/_next/webpack-hmr`);
    await new Promise((resolve) => hmr.once('error', resolve).once('close', resolve).once('open', resolve));
    hmr.terminate();
    assert.deepEqual(seen, ['/guide/', 'upgrade /_next/webpack-hmr']);
    const c = new Client(port);
    assert.equal((await c.join('Dev')).type, 'welcome'); // game WebSocket unaffected
    c.ws.close();
  } finally {
    await server.close();
  }
});
