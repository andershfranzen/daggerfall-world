// Sailing over real WebSockets (server/game.js + server/rpg/sailing.js) on a private port and a /var/tmp SQLite file.
//
// FIXTURE: real accounts (fast scrypt) through the game server's own HTTP origin; a test-only `fixture.deed` action writes a ship deed and stands the player at a port (the
// purchase itself is covered by rpg-property.test.mjs). The coast is invented test water with two ports. Checks the
// production broadcast path: `state` and `chat` reach only the speaker's crew when two crews share one classic deck,
// periodic sailing.state reaches the crew, and a crew member who reconnects is back aboard with a full snapshot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startLiveWorld, accountSession } from './support/rpg-session.mjs';
import { install as inventory } from '../server/rpg/inventory.js';
import { install as travel } from '../server/rpg/travel.js';
import { install as property } from '../server/rpg/property.js';
import { install as social } from '../server/rpg/social.js';
import { install as peers } from '../server/rpg/peers.js';
import { install as sailing } from '../server/rpg/sailing.js';

const PORT_A = 'town:Daggerfall/Daggerfall';
const PORTS = [
  { id: PORT_A, name: 'Daggerfall', region: 'Daggerfall', x: 1000, z: 1000, yaw: Math.PI / 2, quay: { x: 0, z: -40, yaw: 0 } },
  { id: 'town:Wayrest/Wayrest', name: 'Wayrest', region: 'Wayrest', x: 4000, z: 1000, yaw: -Math.PI / 2, quay: { x: 0, z: 30, yaw: 0 } },
];
const coast = {
  status: 'ready', isWater: () => true, ports: () => PORTS, portOf: (id) => PORTS.find((p) => p.id === id) ?? null,
  nearestPort: (x, z) => PORTS.map((port) => ({ port, distance: Math.hypot(port.x - x, port.z - z) })).sort((a, b) => a.distance - b.distance)[0],
};
function fixture(ctx) {
  ctx.onAction('fixture.deed', (p, { type }) => {
    p.rpg.location = PORT_A;
    if (type) p.rpg.property = { version: 0, ship: { type, boughtAt: 0 } };
    p.x = 0;
    p.z = -40;
  });
}
const FEATURES = [
  { name: 'inventory', install: inventory },
  { name: 'travel', install: travel },
  { name: 'property', install: property },
  { name: 'social', install: social },
  { name: 'peers', install: peers },
  { name: 'sailing', install: (ctx) => sailing(ctx, { coast, loadCoast: false }) },
  { name: 'fixture', install: fixture },
];

let tmp;
before(() => {
  tmp = mkdtempSync('/var/tmp/dfw-sailing-ws-');
  for (const d of ['client', 'site']) mkdirSync(join(tmp, d), { recursive: true });
  writeFileSync(join(tmp, 'client', 'play.html'), '<!doctype html><title>play</title>');
});
after(() => rmSync(tmp, { recursive: true, force: true }));

class Client {
  constructor(port, cookie) {
    this.messages = [];
    this.waiters = [];
    this.seq = 0;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.closed = new Promise((resolve) => this.ws.on('close', resolve));
    this.ws.on('message', (d) => {
      const msg = JSON.parse(d);
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => !w(msg));
    });
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  next(pred, timeout = 4000, what = 'message') {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeout);
      this.waiters.push((msg) => {
        if (!pred(msg)) return false;
        clearTimeout(t);
        resolve(msg);
        return true;
      });
    });
  }
  async join(name) {
    await this.opened;
    const w = this.next((m) => m.type === 'welcome' || m.type === 'error', 4000, 'welcome');
    this.send({ type: 'join', name, account: true });
    const msg = await w;
    if (msg.type !== 'welcome') throw new Error(msg.message);
    this.id = msg.id;
    return msg;
  }
  async act(verb, args = {}) {
    const seq = ++this.seq;
    const w = this.next((m) => m.type === 'actionResult' && m.seq === seq, 4000, `result of ${verb}`);
    this.send({ type: 'action', seq, verb, args });
    return w;
  }
  async must(verb, args = {}) {
    const r = await this.act(verb, args);
    if (!r.ok) throw new Error(`${verb}: ${r.error}`);
    return r;
  }
  event(kind, pred = () => true, timeout = 4000) {
    return this.next((m) => m.type === 'gameEvent' && m.event.kind === kind && pred(m.event), timeout, kind).then((m) => m.event);
  }
  close() {
    this.ws.close();
    return this.closed;
  }
}

test('two crews on one classic deck: state and chat stay with each crew; periodic state and reconnect', async () => {
  const live = await startLiveWorld({ dir: tmp, features: FEATURES });
  const { server, port } = live;
  try {
    const jars = {};
    for (const n of ['anselm', 'brisienna', 'cyrus']) {
      jars[n] = await accountSession(live.base, n);
      assert.ok(jars[n].cookie, `account ${n}: ${jars[n].status}`);
    }
    const a = new Client(port, jars.anselm.cookie), b = new Client(port, jars.brisienna.cookie), c = new Client(port, jars.cyrus.cookie);
    await a.join('anselm');
    await b.join('brisienna');
    await c.join('cyrus');
    await a.must('fixture.deed', { type: 'large' });
    await b.must('fixture.deed', {});
    await c.must('fixture.deed', { type: 'large' });
    await a.must('party.invite', { targetId: b.id });
    await b.must('party.accept', { fromId: a.id });

    await a.must('sailing.board');
    const inParty = b.event('sailing.state', (e) => !e.vessel && e.quay?.length);
    await b.must('sailing.sync', { harbour: true });
    assert.deepEqual((await inParty).quay.map((q) => q.id), [`v${a.id}`]);
    const outsideParty = c.event('sailing.state', (e) => !e.vessel);
    await c.must('sailing.sync', { harbour: true });
    assert.deepEqual((await outsideParty).quay, []);
    await b.must('sailing.board', { vesselId: `v${a.id}` });
    await c.must('sailing.board');
    const deck = server.runtime.locationOf(server.runtime.ctx.players.get(a.id));
    assert.equal(server.runtime.locationOf(server.runtime.ctx.players.get(c.id)), deck, 'one classic deck location');

    // The broadcast `state` for that location: Anselm sees Brisienna, never Cyrus; Cyrus sees only himself.
    const sa = await a.next((m) => m.type === 'state' && m.location === deck && m.players.some((p) => p.id === b.id), 4000, 'crew state');
    assert.ok(!sa.players.some((p) => p.id === c.id), 'the other crew is not in our state');
    const sc = await c.next((m) => m.type === 'state' && m.location === deck, 4000, 'other crew state');
    assert.deepEqual(sc.players.map((p) => p.id), [c.id]);

    // Chat on deck reaches the speaker's crew only.
    const heard = b.next((m) => m.type === 'chat' && m.text === 'Hoist the mainsail', 4000, 'crew chat');
    c.messages.length = 0;
    a.send({ type: 'chat', text: 'Hoist the mainsail' });
    await heard;
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!c.messages.some((m) => m.type === 'chat'), 'the other crew hears nothing');

    // Under way: periodic silent sailing.state to the passenger.
    await a.must('sailing.launch');
    await a.must('sailing.control', { sails: 1 });
    const s1 = await b.event('sailing.state', (e) => e.vessel?.speed > 0, 6000);
    assert.equal(s1.silent, true);
    assert.equal(s1.role, 'passenger');
    assert.equal(s1.vessel.helmName, server.runtime.ctx.players.get(a.id).name);

    // The passenger reconnects aboard and gets a full snapshot on sync.
    await b.close();
    await new Promise((r) => setTimeout(r, 200));
    const b2 = new Client(port, jars.brisienna.cookie);
    await b2.join('brisienna');
    assert.equal(b2.id, b.id);
    const full = b2.event('sailing.state', (e) => e.full === true);
    await b2.must('sailing.sync');
    const f = await full;
    assert.equal(f.vessel.id, `v${a.id}`);
    assert.ok(f.ports.length === 2);
    await Promise.all([a.close(), b2.close(), c.close()]);
  } finally {
    await live.close();
  }
});
