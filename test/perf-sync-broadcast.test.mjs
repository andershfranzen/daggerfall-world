// Regression tests for the scaling work in docs/world-performance.md: runtime.sync's cached diff keys and
// partial `rpg` snapshots, and broadcastState's `stateDelta` frames next to legacy `state`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { createRpgRuntime, DEFAULT_LOCATION } from '../server/rpg/runtime.js';
import { createGameServer } from '../server/game.js';
import { mergeRpg } from '../client/gameplay/api.js';

const quiet = { error() {}, warn() {}, log() {} };
const player = (id, rpg = {}, extra = {}) => ({ id, name: `P${id}`, x: 0, z: 0, yaw: 0, moving: false, rpg, dirty: false, ...extra });
const json = (v) => JSON.parse(JSON.stringify(v)); // what the wire carries

test('runtime.sync: delta players get only changed fields, merged state always equals the full snapshot', () => {
  const players = new Map();
  const sent = [];
  let ready = { status: 'loading' };
  let mods = undefined;
  const rt = createRpgRuntime({
    players, save() {}, log: quiet,
    send: (p, msg) => sent.push([p.id, json(msg)]),
    services: { locomotionMods: () => mods },
    features: [(ctx) => {
      ctx.readiness('npcs', () => ready);
      ctx.entities.set('rat', { id: 'rat', location: DEFAULT_LOCATION, x: 1, z: 2, hp: 3, _ai: {} });
      ctx.entities.set('key', { id: 'key', location: DEFAULT_LOCATION, x: 0, z: 0, visibleTo: [2] });
    }],
  });
  const add = (p) => { players.set(p.id, p); rt.join(p); return p; };
  const a = add(player(1, { inventory: [{ id: 'i', name: 'Big inventory' }] }, { delta: true }));
  const b = add(player(2, {}, { delta: true }));
  const legacy = add(player(3));
  const merged = new Map();
  const step = (mutate, expectSent) => {
    mutate();
    sent.length = 0;
    rt.sync();
    assert.deepEqual(sent.map(([id]) => id).sort(), expectSent, 'who got a snapshot');
    for (const [id, msg] of sent) {
      merged.set(id, mergeRpg(merged.get(id), msg));
      if (id === 3) for (const k of ['character', 'entities', 'peers', 'readiness']) assert.ok(k in msg, `legacy gets full ${k}`);
    }
    for (const p of [a, b, legacy]) {
      // Peer positions are not part of the diff (they stream through `state`), for legacy clients too.
      const still = ({ type, peers, ...m }) => ({ ...m, peers: peers.map(({ x, z, yaw, moving, ...rest }) => rest) });
      assert.deepEqual(still(merged.get(p.id)), still(json(rt.rpgMessage(p))), `merged state of ${p.id}`);
    }
  };
  step(() => {}, [1, 2, 3]); // first snapshots are full
  step(() => {}, []); // idle: nothing resent
  step(() => { a.x = 9; b.yaw = 1; }, []); // peer positions stream through `state`
  step(() => { rt.entities.get('rat').x = 4; }, [1, 2, 3]);
  assert.deepEqual(Object.keys(sent.find(([id]) => id === 1)[1]).sort(), ['entityDelta', 'selfId', 'type'], 'only the moved entity is sent as entityDelta');
  assert.deepEqual(sent.find(([id]) => id === 1)[1].entityDelta, { upsert: [{ id: 'rat', location: DEFAULT_LOCATION, x: 4, z: 2, hp: 3 }] });
  step(() => { a.rpg.gold = 5; }, [1]); // a private sheet change reaches only its owner
  assert.deepEqual(Object.keys(sent.find(([id]) => id === 1)[1]).sort(), ['character', 'selfId', 'type']);
  step(() => { a.rpg.readied = true; }, [1, 2, 3]); // public peer field: others get `peers`
  assert.deepEqual(Object.keys(sent.find(([id]) => id === 2)[1]).sort(), ['peers', 'selfId', 'type']);
  step(() => { rt.entities.get('key').visibleTo = [1]; }, [1, 2]);
  assert.deepEqual(sent.find(([id]) => id === 1)[1].entityDelta, { upsert: [{ id: 'key', location: DEFAULT_LOCATION, x: 0, z: 0 }] });
  assert.deepEqual(sent.find(([id]) => id === 2)[1].entityDelta, { remove: ['key'] });
  step(() => { ready = { status: 'ready' }; }, [1, 2, 3]);
  step(() => { mods = { swim: 1 }; }, [1, 2, 3]);
  step(() => { a.rpg.location = 'dungeon:Crypt'; }, [1, 2, 3]);
  // Location change sends full `entities`, never `entityDelta`.
  assert.ok('entities' in sent.find(([id]) => id === 1)[1]);
  assert.ok(!('entityDelta' in sent.find(([id]) => id === 1)[1]));
  // force and resetSync always send a full snapshot, also to delta players.
  sent.length = 0;
  rt.sync([a], { force: true });
  assert.ok(['character', 'entities', 'peers', 'readiness'].every((k) => k in sent[0][1]));
  assert.ok(!('entityDelta' in sent[0][1]));
  rt.resetSync(b);
  sent.length = 0;
  rt.sync([b]);
  assert.ok(['character', 'entities', 'peers', 'readiness'].every((k) => k in sent[0][1]));
  assert.ok(!('entityDelta' in sent[0][1]));
});

test('runtime.sync: entityDelta cuts wire bytes by >85% when 1 of 20 entities moves', () => {
  const players = new Map();
  const bytes = { delta: 0, legacy: 0 };
  const merged = new Map();
  const rt = createRpgRuntime({
    players, save() {}, log: quiet,
    send: (p, msg) => {
      const wire = JSON.stringify(msg);
      if (p.delta) bytes.delta += wire.length;
      else bytes.legacy += wire.length;
      merged.set(p.id, mergeRpg(merged.get(p.id), JSON.parse(wire)));
    },
    features: [(ctx) => {
      for (let i = 0; i < 20; i++) {
        ctx.entities.set(`mob-${i}`, {
          id: `mob-${i}`, kind: 'monster', name: `Giant Rat #${i}`,
          location: DEFAULT_LOCATION, x: i * 2, z: i * -1.5, yaw: 0,
          hp: 24, maxHp: 24, level: 2, sprite: 'rat', state: 'wander',
        });
      }
    }],
  });
  const d = player(1, {}, { delta: true });
  const l = player(2, {}, { delta: false });
  players.set(1, d); rt.join(d);
  players.set(2, l); rt.join(l);
  rt.sync(); // initial full snapshots
  bytes.delta = 0;
  bytes.legacy = 0;
  for (let step = 1; step <= 10; step++) {
    rt.entities.get('mob-0').x = step * 0.5;
    rt.sync();
  }
  assert.ok(bytes.delta > 0 && bytes.legacy > 0);
  const ratio = bytes.delta / bytes.legacy;
  assert.ok(ratio < 0.15, `expected >85% savings, got delta=${bytes.delta} B vs legacy=${bytes.legacy} B (${(ratio * 100).toFixed(1)}%)`);
  assert.deepEqual(merged.get(1).entities, merged.get(2).entities);
});

test('runtime.sync: shared per-location work is serialized once per sync, not once per viewer', () => {
  const players = new Map();
  let peerCalls = 0;
  const rt = createRpgRuntime({
    players, save() {}, send() {}, log: quiet,
    services: { peerConcealment: () => void peerCalls++ },
    features: [],
  });
  for (let i = 1; i <= 20; i++) { const p = player(i); players.set(i, p); rt.join(p); }
  rt.sync();
  assert.equal(peerCalls, 20, 'each public peer built once for 20 viewers');
});

// ---- broadcastState ----------------------------------------------------------------------------

async function withServer(fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'dfw-delta-'));
  mkdirSync(join(tmp, 'c'));
  mkdirSync(join(tmp, 's'));
  const server = createGameServer({ host: '127.0.0.1', port: 0, dbPath: join(tmp, 'w.db'), clientDir: join(tmp, 'c'), siteDir: join(tmp, 's'), features: [] });
  const { port } = await server.start();
  try {
    await fn(port);
  } finally {
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A raw client; with delta it rebuilds the roster exactly like client/lib/net.js. */
function client(port, name, delta) {
  const c = { bytes: { state: 0, stateDelta: 0 }, roster: null, location: null, types: new Set() };
  c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  c.ws.on('message', (d) => {
    const m = JSON.parse(d);
    c.types.add(m.type);
    if (m.type === 'welcome') c.id = m.id;
    if (m.type === 'state') {
      c.bytes.state += d.length;
      c.location = m.location;
      c.roster = new Map(m.players.map((p) => [p.id, p]));
    }
    if (m.type === 'stateDelta') {
      c.bytes.stateDelta += d.length;
      assert.equal(m.location, c.location);
      for (const id of m.gone ?? []) c.roster.delete(id);
      for (const p of m.players) c.roster.set(p.id, { ...c.roster.get(p.id), ...p });
    }
  });
  c.ready = new Promise((res) => c.ws.once('open', () => {
    c.ws.send(JSON.stringify({ type: 'join', name, ...(delta ? { delta: true } : {}) }));
    const t = setInterval(() => c.id && (clearInterval(t), res()), 5);
  }));
  c.input = (forward, yaw = 0) => c.ws.send(JSON.stringify({ type: 'input', forward, strafe: 0, yaw }));
  c.sorted = () => [...c.roster.values()].sort((x, y) => x.id - y.id);
  return c;
}

test('broadcastState: delta clients rebuild exactly the legacy roster with fewer bytes', async () => {
  await withServer(async (port) => {
    const legacy = client(port, 'Legacy', false);
    const delta = client(port, 'Delta', true);
    const idle = [client(port, 'Idle1', false), client(port, 'Idle2', false), client(port, 'Idle3', false)];
    await Promise.all([legacy, delta, ...idle].map((c) => c.ready));
    await sleep(200);
    legacy.bytes.state = delta.bytes.state = delta.bytes.stateDelta = 0;
    // Only one player walks; the rest stand still.
    const walk = setInterval(() => legacy.input(1, 0.3), 50);
    await sleep(1200);
    clearInterval(walk);
    legacy.input(0);
    await sleep(300);
    assert.deepEqual(delta.sorted(), legacy.sorted(), 'same roster, same quantized positions');
    assert.ok(delta.types.has('stateDelta'), 'delta frames were used');
    assert.ok(!legacy.types.has('stateDelta'), 'legacy clients never see stateDelta');
    const legacyBytes = legacy.bytes.state;
    const deltaBytes = delta.bytes.state + delta.bytes.stateDelta;
    assert.ok(deltaBytes * 3 < legacyBytes, `delta ${deltaBytes} B vs legacy ${legacyBytes} B`);

    // A leave reaches delta clients as `gone` (or a fresh full state) and the rosters still agree.
    idle[0].ws.close();
    await sleep(300);
    assert.equal(delta.roster.size, 4);
    assert.deepEqual(delta.sorted(), legacy.sorted());
    for (const c of [legacy, delta, idle[1], idle[2]]) c.ws.close();
  });
});

test('client/lib/net.js opts in and rebuilds the roster from stateDelta', async () => {
  const { Connection } = await import('../client/lib/net.js');
  let ws;
  class Fake {
    constructor() { ws = this; this.sent = []; this.readyState = 1; queueMicrotask(() => this.onopen?.()); }
    send(d) {
      const m = JSON.parse(d);
      this.sent.push(m);
      if (m.type === 'join') this.recv({ type: 'welcome', id: 1, token: 't', player: { id: 1, name: 'A', x: 0, z: 0, yaw: 0 } });
    }
    recv(m) { this.onmessage?.({ data: JSON.stringify(m) }); }
    close() {}
  }
  const c = new Connection('ws://x/ws', { WebSocketImpl: Fake });
  await c.connect({ name: 'A' });
  assert.equal(ws.sent[0].delta, true);
  const got = [];
  c.onState = (players, location) => got.push({ players, location });
  const loc = 'town:X';
  ws.recv({ type: 'state', location: loc, players: [{ id: 1, name: 'A', x: 0, z: 0, yaw: 0, moving: false }, { id: 2, name: 'B', x: 5, z: 5, yaw: 0, moving: false, stance: 'run' }] });
  ws.recv({ type: 'stateDelta', location: loc, players: [{ id: 1, x: 1.5 }, { id: 3, name: 'C', x: 9, z: 9, yaw: 0, moving: true }, { id: 2, name: 'B', x: 6, z: 5, yaw: 0, moving: true }], gone: [2] });
  assert.deepEqual(got.at(-1).players.map((p) => [p.id, p.name, p.x, p.moving, p.stance]), [['1', 'A', 1.5, false, undefined], ['3', 'C', 9, true, undefined], ['2', 'B', 6, true, undefined]]);
  ws.recv({ type: 'stateDelta', location: loc, players: [], gone: [3] });
  assert.deepEqual(got.at(-1).players.map((p) => p.id), ['1', '2']);
  ws.recv({ type: 'stateDelta', location: 'town:Other', players: [{ id: 9, name: 'Z', x: 0, z: 0, yaw: 0 }] });
  assert.equal(got.length, 3, 'a delta for another location is ignored until its full state arrives');
});
