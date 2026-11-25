// Integration tests for the RPG runtime over real WebSockets and a real SQLite file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { createGameServer, CLOSE } from '../server/game.js';
import { DEFAULT_LOCATION } from '../server/rpg/runtime.js';

let tmp, clientDir, siteDir;
let dbN = 0;
const freshDb = () => join(tmp, `db${++dbN}`, 'world.db');

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dfw-rpg-'));
  clientDir = join(tmp, 'client');
  siteDir = join(tmp, 'site');
  mkdirSync(clientDir, { recursive: true });
  mkdirSync(siteDir, { recursive: true });
  writeFileSync(join(clientDir, 'play.html'), '<!doctype html><title>play</title>');
});
after(() => rmSync(tmp, { recursive: true, force: true }));

// A small test-only feature set exercising the protocol.
function testWorld(ctx) {
  ctx.onJoin((p) => {
    p.rpg.gold ??= 100;
    p.rpg.joins = (p.rpg.joins ?? 0) + 1;
  });
  ctx.entities.set('rat', { id: 'rat', kind: 'monster', name: 'Rat', location: ctx.defaultLocation, x: 2, z: -2, yaw: 0, hp: 3, maxHp: 3, _ai: 'secret' });
  ctx.entities.set('ghost', { id: 'ghost', kind: 'monster', name: 'Ghost', location: 'dungeon:Crypt', x: 0, z: 0, yaw: 0, hp: 9, maxHp: 9 });
  ctx.onAction('trade.give', (p, { targetId, amount }) => {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive whole number');
    const t = ctx.players.get(targetId);
    if (!t || t === p || ctx.location(t) !== ctx.location(p)) throw new Error('no such player nearby');
    if (p.rpg.gold < amount) throw new Error('not enough gold');
    ctx.dirty(t);
    p.rpg.gold -= amount;
    t.rpg.gold += amount;
    ctx.notify(t, { kind: 'gift', from: p.id, amount });
  });
  ctx.onAction('debug.crash', (p) => {
    p.rpg.gold = -1;
    throw new TypeError('internal detail');
  });
  ctx.onAction('travel.go', (p, { to }) => {
    if (to !== 'dungeon:Crypt' && to !== ctx.defaultLocation) throw new Error('unknown destination');
    p.rpg.location = to;
  });
  ctx.onAction('combat.attack', (p, { targetId }) => {
    const e = ctx.entities.get(targetId);
    if (!e || e.location !== ctx.location(p)) throw new Error('no target');
    e.hp -= 1;
    ctx.nearby(ctx.location(p), { kind: 'swing', playerId: p.id });
  });
}

async function startServer(extra = {}) {
  const server = createGameServer({ host: '127.0.0.1', port: 0, clientDir, siteDir, features: [testWorld], ...extra });
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
    this.opened.catch(() => {});
    this.ws.on('message', (d) => {
      const msg = JSON.parse(d);
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => !w(msg));
    });
  }
  send(msg) {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
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
  async join(fields = {}) {
    await this.opened;
    this.send({ type: 'join', ...fields });
    return this.next((m) => m.type === 'welcome' || m.type === 'error');
  }
  // Latest rpg snapshot satisfying pred.
  rpg(pred = () => true) {
    return this.next((m) => m.type === 'rpg' && pred(m));
  }
  drop(type) {
    this.messages = this.messages.filter((m) => m.type !== type);
  }
  act(verb, args, seq) {
    this.send({ type: 'action', verb, args, ...(seq !== undefined ? { seq } : {}) });
  }
  close() {
    this.ws.close();
    return this.closed;
  }
}

function readCharacter(dbPath, id) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT name, rpg FROM players WHERE id = ?').get(id);
    return { name: row.name, rpg: JSON.parse(row.rpg) };
  } finally {
    db.close();
  }
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function upgradeStatus(port, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    ws.on('unexpected-response', (req, res) => {
      resolve(res.statusCode);
      req.destroy();
    });
    ws.on('open', () => {
      resolve(101);
      ws.close();
    });
    ws.on('error', () => {});
  });
}

test('guest RPG: snapshots, multi-character trade, rollback, validation, persistence', async () => {
  const dbPath = freshDb();
  let { server, port } = await startServer({ dbPath });
  const a = new Client(port);
  const b = new Client(port);
  const wa = await a.join({ name: 'Alice' });
  const wb = await b.join({ name: 'Bob' });
  assert.equal(wa.type, 'welcome');

  // Private snapshot: own character, visible entities only, public peers.
  let ra = await a.rpg((m) => m.peers.length === 1);
  assert.equal(ra.selfId, wa.id);
  assert.equal(ra.character.gold, 100);
  assert.equal(ra.character.location, DEFAULT_LOCATION);
  assert.deepEqual(ra.entities.map((e) => e.id), ['rat']);
  assert.equal(ra.entities[0]._ai, undefined);
  assert.deepEqual(Object.keys(ra.peers[0]).sort(), ['id', 'moving', 'name', 'x', 'yaw', 'z']);
  assert.equal(ra.peers[0].id, wb.id);

  // Trade: two characters change in one action and one transaction.
  b.drop('rpg');
  a.act('trade.give', { targetId: wb.id, amount: 30 });
  assert.deepEqual((await b.next((m) => m.type === 'gameEvent')).event, { kind: 'gift', from: wa.id, amount: 30 });
  assert.equal((await b.rpg((m) => m.character.gold === 130)).character.gold, 130);
  assert.equal((await a.rpg((m) => m.character.gold === 70)).character.gold, 70);
  assert.equal(readCharacter(dbPath, wa.id).rpg.gold, 70, 'saved immediately');
  assert.equal(readCharacter(dbPath, wb.id).rpg.gold, 130);

  // Readable failures, internal failures hidden and rolled back.
  a.act('trade.give', { targetId: wb.id, amount: 1000 });
  assert.deepEqual(await a.next((m) => m.type === 'error'), { type: 'error', message: 'not enough gold', verb: 'trade.give' });
  a.act('debug.crash', {});
  assert.deepEqual(await a.next((m) => m.type === 'error'), { type: 'error', message: 'action failed', verb: 'debug.crash' });
  a.act('trade.give', { targetId: wb.id, amount: 5 }, 7);
  assert.deepEqual(await a.next((m) => m.type === 'actionResult'), { type: 'actionResult', seq: 7, verb: 'trade.give', ok: true });
  assert.equal(readCharacter(dbPath, wa.id).rpg.gold, 65, 'crash did not persist its mutation');

  // Payload validation.
  a.act('trade.give', [1, 2]);
  assert.match((await a.next((m) => m.type === 'error')).message, /args must be an object/);
  a.send('{"type":"action","verb":"trade.give","args":{"__proto__":{"amount":1}}}');
  assert.match((await a.next((m) => m.type === 'error')).message, /invalid action argument/);
  a.act('nope.nothing', {});
  assert.match((await a.next((m) => m.type === 'error')).message, /unknown action/);
  a.act('../etc', {});
  assert.equal((await a.next((m) => m.type === 'error')).message, 'invalid action');
  a.send({ type: 'action', args: {} });
  assert.match((await a.next((m) => m.type === 'error')).message, /verb/);

  // No redundant rpg snapshots while nothing changes, even when a peer only moves.
  await sleep(200);
  a.drop('rpg');
  for (let i = 0; i < 5; i++) {
    b.send({ type: 'input', forward: 1, strafe: 0, yaw: 0 });
    await sleep(100);
  }
  await sleep(200);
  assert.equal(a.messages.filter((m) => m.type === 'rpg').length, 0);
  // ...but entity changes are pushed to occupants.
  b.act('combat.attack', { targetId: 'rat' });
  assert.equal((await a.next((m) => m.type === 'gameEvent')).event.kind, 'swing');
  assert.equal((await a.rpg((m) => m.entities[0]?.hp === 2)).entities[0].hp, 2);

  // Restart: characters come back with their RPG state; join handlers see returning players.
  await server.close();
  await a.closed;
  ({ server, port } = await startServer({ dbPath }));
  try {
    const a2 = new Client(port);
    const w2 = await a2.join({ token: wa.token });
    assert.equal(w2.id, wa.id);
    const r = await a2.rpg();
    assert.equal(r.character.gold, 65);
    assert.equal(r.character.joins, 2);
    await a2.close();
  } finally {
    await server.close();
  }
});

test('per-location state, chat and snapshots', async () => {
  const { server, port } = await startServer({ dbPath: freshDb() });
  try {
    const a = new Client(port);
    const b = new Client(port);
    const wa = await a.join({ name: 'Delver' });
    const wb = await b.join({ name: 'Stayer' });
    await a.rpg((m) => m.peers.length === 1);

    a.act('travel.go', { to: 'dungeon:Crypt' });
    const there = await a.rpg((m) => m.character.location === 'dungeon:Crypt');
    assert.deepEqual(there.entities.map((e) => e.id), ['ghost']);
    assert.deepEqual(there.peers, []);
    assert.deepEqual((await b.rpg((m) => m.peers.length === 0)).peers, []);

    a.drop('state');
    b.drop('state');
    assert.deepEqual((await a.next((m) => m.type === 'state')).players.map((p) => p.id), [wa.id]);
    assert.deepEqual((await b.next((m) => m.type === 'state')).players.map((p) => p.id), [wb.id]);

    b.send({ type: 'chat', text: 'anyone here?' });
    await b.next((m) => m.type === 'chat');
    a.send({ type: 'chat', text: 'deep below' });
    assert.equal((await a.next((m) => m.type === 'chat')).text, 'deep below');
    await sleep(150);
    assert.equal(a.messages.filter((m) => m.type === 'chat').length, 0, 'other location chat not received');
    assert.equal(b.messages.filter((m) => m.type === 'chat').length, 0);

    // Cross-location trades are refused.
    a.act('trade.give', { targetId: wb.id, amount: 1 });
    assert.equal((await a.next((m) => m.type === 'error')).message, 'no such player nearby');
    await a.close();
    await b.close();
  } finally {
    await server.close();
  }
});

test('duplicate sessions move the live character without re-running join or losing state', async () => {
  const dbPath = freshDb();
  const { server, port } = await startServer({ dbPath });
  try {
    const a = new Client(port);
    const b = new Client(port);
    const wa = await a.join({ name: 'Twin' });
    const wb = await b.join({ name: 'Witness' });
    a.act('trade.give', { targetId: wb.id, amount: 10 });
    await a.rpg((m) => m.character.gold === 90);

    const a2 = new Client(port);
    const w2 = await a2.join({ token: wa.token });
    assert.equal(w2.id, wa.id);
    assert.equal((await a.closed).code, CLOSE.REPLACED);
    const r = await a2.rpg();
    assert.equal(r.character.gold, 90);
    assert.equal(r.character.joins, 1, 'join handlers did not run again');

    // The old socket closing must not remove or save over the live character.
    await sleep(100);
    a2.act('trade.give', { targetId: wb.id, amount: 5 });
    await a2.rpg((m) => m.character.gold === 85);
    const st = await b.next((m) => m.type === 'state');
    assert.equal(st.players.filter((p) => p.id === wa.id).length, 1);
    assert.equal(server.runtime.ctx.players.size, 2);
    await a2.close();
    await sleep(100);
    assert.equal(readCharacter(dbPath, wa.id).rpg.gold, 85);
    await b.close();
  } finally {
    await server.close();
  }
});

function fakeAccounts(users) {
  const listeners = new Set();
  const sessionListeners = new Set();
  const muted = new Set();
  return {
    muted,
    handleHttp(req, res) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ handled: req.url, method: req.method }));
    },
    resolveUpgrade(req) {
      const key = req.headers['x-test-session'];
      return users[key] ? { ...users[key], sessionKey: `key-${key}` } : null;
    },
    isMuted: (id) => muted.has(id),
    onModeration(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onSessionEnd(fn) {
      sessionListeners.add(fn);
      return () => sessionListeners.delete(fn);
    },
    logout(accountId, sessionKey) {
      for (const fn of sessionListeners) fn({ accountId, sessionKey, reason: 'logout' });
    },
    moderate(accountId, action) {
      for (const fn of listeners) fn({ accountId, action });
    },
  };
}

test('accounts mode: verified upgrades only, server-owned character mapping, mute and moderation', async () => {
  const dbPath = freshDb();
  const users = { s1: { id: 1, username: 'alice' }, s2: { id: 2, username: 'bob' } };
  const accounts = fakeAccounts(users);
  let { server, port } = await startServer({ dbPath, accounts });
  try {
    const api = await get(port, '/api/session');
    assert.equal(api.status, 200);
    assert.deepEqual(JSON.parse(api.body), { handled: '/api/session', method: 'GET' });

    assert.equal(await upgradeStatus(port), 401);
    assert.equal(await upgradeStatus(port, { 'x-test-session': 'forged' }), 401);

    const a = new Client(port, { 'x-test-session': 's1' });
    const wa = await a.join({ name: 'Mallory', token: 'B'.repeat(43) }); // message identity is ignored
    assert.equal(wa.type, 'welcome');
    assert.equal(wa.token, null);
    assert.deepEqual(wa.account, { id: 1, username: 'alice' }); // no sessionKey leaks to the client
    assert.equal(wa.player.name, 'alice');
    assert.equal(server.characterForAccount(1).id, wa.id);
    assert.equal(server.characterForAccount(99), null);
    await a.rpg();

    accounts.muted.add(1);
    a.send({ type: 'chat', text: 'hello' });
    assert.equal((await a.next((m) => m.type === 'error')).message, 'you are muted');
    assert.equal(server.runtime.ctx.services.isMuted(server.runtime.ctx.players.get(wa.id)), true);
    accounts.muted.delete(1);

    accounts.moderate(1, 'ban');
    assert.equal((await a.closed).code, CLOSE.ACCOUNT);

    // Same account later (or after restart) gets the same server-owned character.
    await server.close();
    ({ server, port } = await startServer({ dbPath, accounts }));
    const a2 = new Client(port, { 'x-test-session': 's1' });
    const w2 = await a2.join();
    assert.equal(w2.id, wa.id);
    assert.equal((await a2.rpg()).character.joins, 2);
    // A second tab replaces the first.
    const a3 = new Client(port, { 'x-test-session': 's1' });
    assert.equal((await a3.join()).id, wa.id);
    assert.equal((await a2.closed).code, CLOSE.REPLACED);

    // Logout closes only the signed-out session's sockets.
    const other = new Client(port, { 'x-test-session': 's2' });
    await other.join();
    accounts.logout(2, 'key-other-device');
    accounts.logout(1, 'key-s2');
    await sleep(100);
    assert.equal(other.ws.readyState, WebSocket.OPEN, 'another session key stays connected');
    accounts.logout(2, 'key-s2');
    assert.deepEqual(await other.closed, { code: CLOSE.ACCOUNT, reason: 'signed out' });
    assert.equal(a3.ws.readyState, WebSocket.OPEN);
    await a3.close();
  } finally {
    await server.close();
  }
});

test('accounts with development guests: guest claim revokes the guest token', async () => {
  const dbPath = freshDb();
  const accounts = fakeAccounts({ s2: { id: 2, username: 'bob' } });
  const { server, port } = await startServer({ dbPath, accounts, allowGuests: true });
  try {
    const g = new Client(port);
    const wg = await g.join({ name: 'Wanderer' });
    g.act('trade.give', { targetId: wg.id, amount: 1 }); // self-trade refused, state unchanged
    await g.next((m) => m.type === 'error');

    const bob = new Client(port, { 'x-test-session': 's2' });
    const bad = await bob.join({ claimToken: 'C'.repeat(43) });
    assert.deepEqual(bad, { type: 'error', message: 'guest character could not be claimed' });
    bob.send({ type: 'join', claimToken: wg.token });
    const wb = await bob.next((m) => m.type === 'welcome');
    assert.equal(wb.id, wg.id, 'claimed the guest character');
    assert.equal(wb.player.name, 'bob');
    assert.equal((await g.closed).code, CLOSE.REPLACED);
    assert.equal((await bob.rpg()).character.gold, 100);

    // The old guest token no longer opens the (now account-owned) character.
    const thief = new Client(port);
    const err = await thief.join({ token: wg.token });
    assert.deepEqual(err, { type: 'error', message: 'invalid token' });
    assert.equal((await thief.closed).code, CLOSE.INVALID_TOKEN);
    await bob.close();
    assert.equal(readCharacter(dbPath, wg.id).name, 'bob');
  } finally {
    await server.close();
  }
});

test('operator game data is exposed to features but never served', async () => {
  const data = join(tmp, 'ARENA2');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'MAPS.BSA'), 'operator data');
  let seen = null;
  const { server, port } = await startServer({ dbPath: freshDb(), arena2Dir: data, features: [(ctx) => (seen = ctx.dataPath)] });
  try {
    assert.equal(seen, realpathSync(data));
    assert.equal(server.config.arena2Dir, realpathSync(data));
    for (const path of ['/ARENA2/MAPS.BSA', '/MAPS.BSA', '/arena2/MAPS.BSA']) {
      assert.equal((await get(port, path)).status, 404, path);
    }
  } finally {
    await server.close();
  }
  const inside = join(clientDir, 'ARENA2');
  mkdirSync(inside, { recursive: true });
  assert.throws(() => createGameServer({ port: 0, dbPath: freshDb(), clientDir, siteDir, arena2Dir: inside }), /publicly served/);
});

test('a failed final save is retried without overwriting a newer session', async () => {
  const dbPath = freshDb();
  let failSaves = false;
  const { openStore } = await import('../server/db.js');
  const faulty = (path) => {
    const s = openStore(path);
    const save = s.saveCharacters.bind(s);
    s.saveCharacters = (list) => {
      if (failSaves) throw new Error('disk I/O error');
      return save(list);
    };
    return s;
  };
  const { server, port } = await startServer({ dbPath, openStore: faulty, saveIntervalMs: 100 });
  try {
    const a = new Client(port);
    const b = new Client(port);
    const wa = await a.join({ name: 'Orphan' });
    const wb = await b.join({ name: 'Banker' });
    a.act('trade.give', { targetId: wb.id, amount: 20 });
    await a.rpg((m) => m.character.gold === 80);

    // Leave while the disk fails: the DB keeps the old value, memory keeps the newer one.
    failSaves = true;
    a.act('trade.give', { targetId: wb.id, amount: 1 });
    assert.match((await a.next((m) => m.type === 'error')).message, /could not save/);
    for (let i = 0; i < 4; i++) {
      a.send({ type: 'input', forward: 1, strafe: 0, yaw: 0 }); // moves only in memory now
      await sleep(100);
    }
    await sleep(450);
    await a.close();
    await sleep(50);
    assert.equal(readCharacter(dbPath, wa.id).rpg.gold, 80);
    const ro = new DatabaseSync(dbPath, { readOnly: true });
    const dbZ = ro.prepare('SELECT z FROM players WHERE id = ?').get(wa.id).z;
    ro.close();
    assert.equal(dbZ, 0, 'position never reached the disk');

    // Rejoin before the retry succeeds: the session resumes from the newer in-memory state.
    const a2 = new Client(port);
    const w2 = await a2.join({ token: wa.token });
    assert.equal(w2.id, wa.id);
    assert.ok(w2.player.z < -0.5, `resumed at the unsaved position, z=${w2.player.z}`);
    failSaves = false;
    a2.act('trade.give', { targetId: wb.id, amount: 5 });
    await a2.rpg((m) => m.character.gold === 75);
    await sleep(350); // several periodic saves
    assert.equal(readCharacter(dbPath, wa.id).rpg.gold, 75, 'stale orphan never overwrote the live session');
    await a2.close();
    await b.close();
  } finally {
    await server.close();
  }
});
