// Presence during arrival: a client that joins with `arrival: true` holds its loading screen until its place is
// complete (client/main.js). Until it sends {type:'arrived'}, other players neither see it (state, rpg peers) nor
// does it wait on them; monsters cannot target it. Clients that do not ask for this are visible at once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createGameServer } from '../server/game.js';

let tmp;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dfw-arrival-'));
  for (const d of ['client', 'site']) mkdirSync(join(tmp, d), { recursive: true });
  writeFileSync(join(tmp, 'client', 'play.html'), '<!doctype html><title>play</title>');
});
after(() => rmSync(tmp, { recursive: true, force: true }));

let dbN = 0;
let combatCtx = null;
function world(ctx) {
  combatCtx = ctx;
}

async function startServer() {
  const server = createGameServer({
    host: '127.0.0.1', port: 0, clientDir: join(tmp, 'client'), siteDir: join(tmp, 'site'),
    dbPath: join(tmp, `db${++dbN}`, 'world.db'), features: [world],
  });
  const { port } = await server.start();
  return { server, port };
}

class Client {
  constructor(port) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.opened = new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.ws.on('message', (d) => {
      const m = JSON.parse(d);
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => !w(m));
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  /** The next message (not yet consumed) satisfying pred. */
  next(pred, timeout = 3000) {
    const i = this.messages.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.messages.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for message')), timeout);
      this.waiters.push((m) => {
        if (!pred(m)) return false;
        clearTimeout(t);
        this.messages.splice(this.messages.indexOf(m), 1);
        resolve(m);
        return true;
      });
    });
  }
  async join(name, arrival = true) {
    await this.opened;
    this.send({ type: 'join', name, ...(arrival ? { arrival: true } : {}) });
    this.welcome = await this.next((m) => m.type === 'welcome');
    this.id = this.welcome.id;
    return this.welcome;
  }
  /** Latest `state` list of player names seen so far (drains the queue). */
  async seen() {
    await new Promise((r) => setTimeout(r, 250)); // a few server ticks
    const states = this.messages.filter((m) => m.type === 'state');
    this.messages = this.messages.filter((m) => m.type !== 'state');
    return states.length ? states.at(-1).players.map((p) => p.name).sort() : null;
  }
  async peers() {
    const rpgs = this.messages.filter((m) => m.type === 'rpg');
    return rpgs.length ? rpgs.at(-1).peers.map((p) => p.name).sort() : null;
  }
  close() { this.ws.close(); }
}

test('two clients loading at once: invisible to each other until each arrives, and neither waits on the other', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const a = new Client(port), b = new Client(port);
  t.after(() => { a.close(); b.close(); });
  const [wa, wb] = await Promise.all([a.join('Ada'), b.join('Bram')]);
  assert.equal(wa.arrival, true, 'the welcome confirms the server holds this player back');
  assert.equal(wb.arrival, true);

  // Both still loading: each sees only themselves; the server never needs the other's arrival.
  assert.deepEqual(await a.seen(), ['Ada']);
  assert.deepEqual(await b.seen(), ['Bram']);
  assert.deepEqual(await a.peers(), []);
  assert.deepEqual(await b.peers(), []);

  // A finishes first and enters: B (still loading) now sees A; A still does not see B.
  a.send({ type: 'arrived' });
  assert.deepEqual(await b.seen(), ['Ada', 'Bram']);
  assert.deepEqual(await a.seen(), ['Ada']);
  assert.deepEqual(await b.peers(), ['Ada']);

  // B enters: both see each other.
  b.send({ type: 'arrived' });
  assert.deepEqual(await a.seen(), ['Ada', 'Bram']);
  assert.deepEqual(await a.peers(), ['Bram']);
  // A repeated or late `arrived` is harmless.
  b.send({ type: 'arrived' });
  assert.deepEqual(await b.seen(), ['Ada', 'Bram']);
});

test('clients that do not hold an arrival screen are visible at once; an arriving player is flagged until it arrives', async (t) => {
  const { server, port } = await startServer();
  t.after(() => server.close());
  const old = new Client(port), fresh = new Client(port);
  t.after(() => { old.close(); fresh.close(); });
  const w = await old.join('Legacy', false);
  assert.equal(w.arrival, undefined);
  await fresh.join('Newcomer');
  assert.deepEqual(await fresh.seen(), ['Legacy', 'Newcomer']);
  assert.deepEqual(await old.seen(), ['Legacy']);
  const p = [...combatCtx.players.values()].find((q) => q.name === 'Newcomer');
  assert.equal(p.arriving, true);
  fresh.send({ type: 'arrived' });
  await old.seen();
  assert.equal(p.arriving, false);
});
