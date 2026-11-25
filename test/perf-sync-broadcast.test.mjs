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
  const a = add(player(1, { inventory: [{ id: 'i', name: 'Big inventory' }] }, { delta: true, patch: true }));
  const b = add(player(2, {}, { delta: true, patch: true }));
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
  assert.deepEqual(sent.find(([id]) => id === 1)[1].entityDelta, { patch: [{ id: 'rat', x: 4 }] }, 'only the changed field');
  step(() => { a.rpg.gold = 5; }, [1]); // a private sheet change reaches only its owner
  assert.deepEqual(Object.keys(sent.find(([id]) => id === 1)[1]).sort(), ['character', 'selfId', 'type']);
  step(() => { a.rpg.readied = true; }, [1, 2, 3]); // public peer field: others get that peer in `peerDelta`
  assert.deepEqual(Object.keys(sent.find(([id]) => id === 2)[1]).sort(), ['peerDelta', 'selfId', 'type']);
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
  const d = player(1, {}, { delta: true, patch: true });
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

// ---- crowd culling keeps trade partners ---------------------------------------------------------

test('runtime.sync crowd cap keeps an open trade partner who is not among the 64 nearest', async () => {
  const inventory = await import('../server/rpg/inventory.js');
  const social = await import('../server/rpg/social.js');
  const players = new Map();
  const last = new Map();
  const rt = createRpgRuntime({ players, save() {}, log: quiet, send: (p, msg) => last.set(p.id, mergeRpg(last.get(p.id), json(msg))), features: [inventory, social] });
  const add = (id, x) => { const p = player(id, {}, { x }); players.set(id, p); rt.join(p); return p; };
  const a = add(1, 0);
  const b = add(2, 7); // within trade reach (8 m), but 66 others stand closer
  for (let i = 3; i <= 68; i++) add(i, 1 + (i % 5) * 0.2);
  assert.equal(rt.act(a, 'trade.request', { targetId: 2 }).error, undefined);
  rt.sync(undefined, { force: true });
  const ids = (p) => last.get(p.id).peers.map((q) => q.id);
  assert.equal(ids(a).length, 64);
  assert.ok(ids(a).includes(2), 'trade partner B is in A\'s rpg peers');
  assert.ok(ids(b).includes(1), 'trade partner A is in B\'s rpg peers');
});

test('broadcastState AOI keeps an open trade partner past the crowd cap', async () => {
  const inventory = await import('../server/rpg/inventory.js');
  const social = await import('../server/rpg/social.js');
  const tmp = mkdtempSync(join(tmpdir(), 'dfw-aoi-'));
  mkdirSync(join(tmp, 'c'));
  mkdirSync(join(tmp, 's'));
  const server = createGameServer({ host: '127.0.0.1', port: 0, dbPath: join(tmp, 'w.db'), clientDir: join(tmp, 'c'), siteDir: join(tmp, 's'), features: [inventory, social], aoiThreshold: 2, maxVisiblePeers: 1 });
  const { port } = await server.start();
  try {
    const [a, b, c] = [client(port, 'Ada', true), client(port, 'Bram', true), client(port, 'Cole', true)];
    await Promise.all([a, b, c].map((x) => x.ready));
    const live = server.runtime.ctx.players;
    live.get(a.id).x = 0;
    live.get(b.id).x = 6; // trade partner, farther than C
    live.get(c.id).x = 1;
    for (const id of [a.id, b.id, c.id]) live.get(id).z = 0;
    await sleep(300);
    assert.deepEqual([...a.roster.keys()].sort(), [a.id, c.id].sort(), 'cap 1: A sees only the nearest (C)');
    a.ws.send(JSON.stringify({ type: 'action', seq: 1, verb: 'trade.request', args: { targetId: b.id } }));
    await sleep(400);
    assert.ok(a.roster.has(b.id), 'trade partner B is visible to A under AOI');
    assert.ok(b.roster.has(a.id), 'trade partner A is visible to B under AOI');
    for (const x of [a, b, c]) x.ws.close();
  } finally {
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('broadcastState AOI survives a player leaving a culled scene (stale index entries are pruned)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dfw-aoi-'));
  mkdirSync(join(tmp, 'c'));
  mkdirSync(join(tmp, 's'));
  const server = createGameServer({ host: '127.0.0.1', port: 0, dbPath: join(tmp, 'w.db'), clientDir: join(tmp, 'c'), siteDir: join(tmp, 's'), features: [], aoiThreshold: 2, maxVisiblePeers: 8 });
  const { port } = await server.start();
  const crashes = [];
  const onCrash = (err) => crashes.push(err);
  process.on('uncaughtException', onCrash);
  try {
    const cs = ['A', 'B', 'C', 'D'].map((n) => client(port, n, true));
    await Promise.all(cs.map((x) => x.ready));
    await sleep(200);
    assert.equal(cs[0].roster.size, 4);
    cs[3].ws.close();
    await sleep(400);
    assert.deepEqual(crashes.map(String), [], 'no exception in the broadcast');
    assert.deepEqual([...cs[0].roster.keys()].sort(), [cs[0].id, cs[1].id, cs[2].id].sort(), 'the leaver is gone from the rebuilt roster');
    for (const x of cs.slice(0, 3)) x.ws.close();
  } finally {
    process.off('uncaughtException', onCrash);
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('runtime.sync crowd cap: peers swapping places inside the nearest 64 resend nothing', () => {
  const players = new Map();
  const sent = [];
  const rt = createRpgRuntime({ players, save() {}, log: quiet, send: (p, msg) => sent.push([p.id, msg]), features: [] });
  for (let i = 1; i <= 70; i++) { const p = player(i, {}, { x: i, delta: true, patch: true }); players.set(i, p); rt.join(p); }
  rt.sync();
  sent.length = 0;
  players.get(2).x = 3.5; // 2 and 3 swap distance order for viewer 1; the nearest-64 set is unchanged
  players.get(3).x = 2.5;
  rt.sync();
  assert.deepEqual(sent.filter(([id]) => id === 1), [], 'viewer 1 gets no peer resend for a reorder');
});

// ---- per-peer and field-level entity deltas ----------------------------------------------------

test('runtime.sync: random joins, leaves, moves, gear, travel, crowd churn and reconnects: delta state equals the full snapshot', () => {
  let s = 12345;
  const rand = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const LOCS = [DEFAULT_LOCATION, 'dungeon:Crypt'];
  const players = new Map();
  const merged = new Map(); // player id -> what a delta (or legacy) client rebuilt from the wire
  const sentKinds = { peerDelta: 0, patch: 0, upsert: 0, peers: 0, entities: 0 };
  let acrossOf = () => [];
  const rt = createRpgRuntime({
    players, save() {}, log: quiet,
    send: (p, msg) => {
      const m = json(msg);
      if (m.peerDelta) sentKinds.peerDelta++;
      if (m.entityDelta?.patch) sentKinds.patch++;
      if (m.entityDelta?.upsert) sentKinds.upsert++;
      if (m.peers) sentKinds.peers++;
      if (m.entities) sentKinds.entities++;
      if (!p.delta) for (const k of ['character', 'entities', 'peers', 'readiness']) assert.ok(k in m, `legacy ${p.id} gets full ${k}`);
      // A tab on the previous delta protocol (joined without `patch`) never gets what it cannot merge.
      if (!p.patch) assert.ok(!('peerDelta' in m) && !m.entityDelta?.patch, `player ${p.id} without patch got ${Object.keys(m)}`);
      merged.set(p.id, mergeRpg(merged.get(p.id), m));
    },
    services: { peerView: { across: (p) => acrossOf(p) } },
    features: [(ctx) => {
      for (let i = 0; i < 30; i++) {
        ctx.entities.set(`npc-${i}`, { id: `npc-${i}`, kind: 'npc', name: `Townsperson ${i}`, location: pick(LOCS), x: i, z: -i, yaw: 0, sprite: 'tp', state: 'walk', _ai: {} });
      }
    }],
  });
  let nextId = 1;
  const join = () => {
    const p = player(nextId++, { location: pick(LOCS) }, { x: rand() * 40, z: rand() * 40, ...((r) => ({ delta: r < 0.85, patch: r < 0.7 }))(rand()) }); // current, previous-protocol and legacy clients
    players.set(p.id, p);
    rt.join(p);
    merged.delete(p.id);
  };
  for (let i = 0; i < 80; i++) join();
  const live = () => [...players.values()];
  const byId = (list) => [...(list ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const still = (peers) => byId(peers).map(({ x, z, yaw, moving, ...rest }) => rest);
  const ops = [
    () => join(),
    () => { const p = pick(live()); rt.leave(p); players.delete(p.id); merged.delete(p.id); },
    () => { for (const p of live()) if (rand() < 0.5) { p.x += rand() * 6 - 3; p.z += rand() * 6 - 3; } }, // crowd-cap churn
    () => { const p = pick(live()); p.rpg.readied = !p.rpg.readied; }, // public appearance
    () => { const p = pick(live()); p.rpg.defeated = !p.rpg.defeated || undefined; },
    () => { const p = pick(live()); p.rpg.location = pick(LOCS); }, // travel
    () => { const p = pick(live()); p.rpg.gold = (p.rpg.gold ?? 0) + 1; },
    () => { const p = pick(live()); rt.resetSync(p); merged.delete(p.id); }, // reconnect: fresh client
    () => { for (const e of rt.entities.values()) if (rand() < 0.6) { e.x += 0.5; e.yaw = rand(); } }, // walking townspeople
    () => { const e = pick([...rt.entities.values()]); if (e.hp === undefined) e.hp = 5; else delete e.hp; }, // a field appears/goes
    () => { const e = pick([...rt.entities.values()]); e.location = pick(LOCS); },
    () => { const id = `npc-x${nextId++}`; rt.entities.set(id, { id, kind: 'npc', location: pick(LOCS), x: 0, z: 0 }); },
    () => { const e = pick([...rt.entities.values()]); rt.entities.delete(e.id); },
    () => { const e = pick([...rt.entities.values()]); e.visibleTo = rand() < 0.5 ? [pick(live()).id] : undefined; },
    () => { // a player seen across a boundary from some viewers
      const far = pick(live());
      acrossOf = (p) => (p.id % 3 === 0 && p !== far ? [{ player: far, x: 400, z: 1, distance: 30 }] : []);
    },
    () => { acrossOf = () => []; },
  ];
  for (let stepNo = 0; stepNo < 400; stepNo++) {
    pick(ops)();
    rt.sync();
    for (const p of live()) {
      const full = json(rt.rpgMessage(p));
      const got = merged.get(p.id);
      const ctx = `step ${stepNo}, player ${p.id} (delta ${p.delta})`;
      assert.deepEqual(got.character, full.character, `character, ${ctx}`);
      assert.deepEqual(got.readiness, full.readiness, `readiness, ${ctx}`);
      assert.deepEqual(byId(got.entities), byId(full.entities), `entities, ${ctx}`);
      assert.deepEqual(still(got.peers), still(full.peers), `peers, ${ctx}`);
    }
  }
  for (const k of ['peerDelta', 'patch', 'upsert', 'peers', 'entities']) assert.ok(sentKinds[k] > 0, `exercised ${k}`);
});

test('runtime.sync: a walking entity costs its changed fields; crowd churn costs only the peers that changed', () => {
  const players = new Map();
  const sent = [];
  const rt = createRpgRuntime({
    players, save() {}, log: quiet, send: (p, msg) => sent.push([p.id, json(msg)]),
    features: [(ctx) => ctx.entities.set('tp', { id: 'tp', kind: 'npc', name: 'Townsperson', location: DEFAULT_LOCATION, x: 1, z: 2, yaw: 0, sprite: 'tp-182-3', faction: 'Daggerfall', state: 'walk' })],
  });
  for (let i = 1; i <= 70; i++) { const p = player(i, {}, { x: i, delta: i === 1, patch: i === 1 }); players.set(i, p); rt.join(p); }
  rt.sync();
  sent.length = 0;
  rt.entities.get('tp').x = 1.5;
  rt.sync();
  assert.deepEqual(sent.find(([id]) => id === 1)[1].entityDelta, { patch: [{ id: 'tp', x: 1.5 }] });
  sent.length = 0;
  players.get(70).x = 1.2; // 70 enters viewer 1's nearest 64, 65 drops out
  rt.sync();
  const m = sent.find(([id]) => id === 1)[1];
  assert.deepEqual(Object.keys(m).sort(), ['peerDelta', 'selfId', 'type']);
  assert.deepEqual(m.peerDelta.upsert.map((q) => q.id), [70]);
  assert.deepEqual(m.peerDelta.remove, [65]);
});
