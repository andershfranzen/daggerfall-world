// Unit tests for the DOM-free parts of the browser client.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { velocity, wrapAngle, lerpAngle, Predictor, SnapshotBuffer, InputSender, SPEED } from '../client/lib/motion.js';
import { Identity, nameProblem, cleanDisplayName, profileKey } from '../client/lib/identity.js';
import { selectArena2 } from '../client/lib/files.js';
import { Ground } from '../client/lib/ground.js';
import { Connection, CLOSE, describeClose, sanitizePlayer } from '../client/lib/net.js';
import * as M from '../client/lib/mat.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('velocity matches the server convention (yaw 0 → -z, positive yaw → +x)', () => {
  let [vx, vz] = velocity(1, 0, 0);
  near(vx, 0); near(vz, -SPEED);
  [vx, vz] = velocity(1, 0, Math.PI / 2);
  near(vx, SPEED); near(vz, 0);
  [vx, vz] = velocity(0, 1, 0); // strafe right at yaw 0 → +x
  near(vx, SPEED); near(vz, 0);
  [vx, vz] = velocity(1, 1, 0); // diagonal normalised
  near(Math.hypot(vx, vz), SPEED);
});

test('angles wrap and interpolate across ±π', () => {
  near(wrapAngle(3 * Math.PI), Math.PI);
  near(wrapAngle(-Math.PI), Math.PI);
  near(Math.abs(lerpAngle(3, -3, 0.5)), Math.PI, 1e-3);
});

test('predictor follows input and reconciles to authoritative history', () => {
  const p = new Predictor();
  p.reset(0, 0);
  for (let i = 1; i <= 10; i++) p.update(1, 0, 0, 0.05, i * 0.05); // 0.5 s forward
  near(p.z, -2);
  // Server lags ~0.1 s and agrees with our history → no correction.
  p.reconcile(0, -1.6, 0.5);
  near(p.z, -2);
  // Server is 0.3 m off laterally → correction applied, but faded visually.
  p.reconcile(0.3, -1.6, 0.5);
  near(p.x, 0.3, 1e-6);
  near(p.renderX, 0, 1e-6);
  // Far off → snap.
  p.reconcile(50, 50, 0.5);
  near(p.renderX, 50); near(p.renderZ, 50);
});

test('predictor corrects to the server when stationary', () => {
  const p = new Predictor();
  p.reset(1, 1);
  p.reconcile(1.5, 1, 0);
  near(p.x, 1.5);
});

test('snapshot buffer interpolates with delay', () => {
  const b = new SnapshotBuffer(0.1);
  b.push(1.0, { x: 0, z: 0, yaw: 0, moving: true });
  b.push(1.1, { x: 1, z: 0, yaw: 0, moving: true });
  const s = b.sample(1.15);
  near(s.x, 0.5);
  assert.equal(s.moving, true);
  assert.equal(b.sample(5).x, 1);
});

test('input sender: immediate on change, ~10 Hz refresh while moving, quiet when idle', () => {
  const s = new InputSender();
  assert.ok(s.poll(0, 0, 0, 0));
  assert.equal(s.poll(0, 0, 0, 1), null); // idle, unchanged
  assert.ok(s.poll(1, 0, 0, 1.01)); // started moving
  assert.equal(s.poll(1, 0, 0, 1.05), null);
  assert.ok(s.poll(1, 0, 0, 1.12)); // refresh
  assert.ok(s.poll(0, 0, 0, 1.13)); // stop: immediate
  assert.equal(s.poll(0, 0, 0.5, 1.15), null); // yaw change rate limited (<50 ms)
  assert.ok(s.poll(0, 0, 0.5, 1.2));
});

test('name validation mirrors the server rule', () => {
  assert.equal(nameProblem('Ysmir'), null);
  assert.equal(nameProblem("Lady Brisienna-2"), null);
  assert.ok(nameProblem(''));
  assert.ok(nameProblem('-dash'));
  assert.ok(nameProblem('bad<name>'));
  assert.equal(cleanDisplayName('  a   b  '), 'a b');
  assert.equal(profileKey(' Ysmir  Wulf '), 'ysmir wulf');
});

function memStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

function fakeLocks() {
  const held = new Set();
  return {
    held,
    request(name, opts, cb) {
      if (held.has(name)) return Promise.resolve(cb(null));
      held.add(name);
      return Promise.resolve(cb({ name })).finally(() => held.delete(name));
    },
  };
}

test('identity: owning tab persists token; second tab gets a separate in-memory guest', async () => {
  const storage = memStorage();
  const locks = fakeLocks();
  const tab1 = new Identity({ storage, locks });
  const tab2 = new Identity({ storage, locks });

  const a = await tab1.claim('Ysmir');
  assert.equal(a.owned, true);
  assert.equal(a.token, null);
  a.adopt('T1');
  assert.equal(tab1.storedToken('ysmir'), 'T1');

  const b = await tab2.claim('ysmir');
  assert.equal(b.owned, false);
  assert.equal(b.token, null, 'second tab must not reuse the first tab’s token');
  b.adopt('T2');
  assert.equal(tab2.storedToken('ysmir'), 'T1', 'second tab must not overwrite storage');
  assert.equal(b.token, 'T2');

  a.release();
  await new Promise((r) => setTimeout(r, 0));
  const c = await tab2.claim('Ysmir');
  assert.equal(c.owned, true);
  assert.equal(c.token, 'T1');
  c.invalidate('T1');
  assert.equal(tab2.storedToken('ysmir'), null);
});

test('identity works without Web Locks or storage', async () => {
  const id = new Identity({ storage: null, locks: null });
  const c = await id.claim('x');
  assert.equal(c.owned, true);
  c.adopt('tok');
  assert.equal(c.token, 'tok');
});

const file = (name, path) => ({ file: { name, size: 1, lastModified: 0 }, path });

test('selectArena2 finds ARENA2 inside an install folder', () => {
  const r = selectArena2([
    file('DAGGER.EXE', 'DAGGER/DAGGER.EXE'),
    file('ARCH3D.BSA', 'DAGGER/ARENA2/ARCH3D.BSA'),
    file('BLOCKS.BSA', 'DAGGER/ARENA2/BLOCKS.BSA'),
    file('MAPS.BSA', 'DAGGER/ARENA2/MAPS.BSA'),
    file('TEXTURE.000', 'DAGGER/ARENA2/TEXTURE.000'),
    file('X.BSA', 'DAGGER/OTHER/X.BSA'),
  ]);
  assert.equal(r.problem, null);
  assert.equal(r.dir, 'DAGGER/ARENA2');
  assert.equal(r.files.length, 4);
  assert.deepEqual(r.missing, []);
});

test('selectArena2 reports missing archives and empty / wrong folders', () => {
  assert.ok(selectArena2([]).problem);
  assert.ok(selectArena2([file('a.txt', 'x/a.txt')]).problem);
  const r = selectArena2([file('ARCH3D.BSA', 'arena2/ARCH3D.BSA')]);
  assert.equal(r.problem, null);
  assert.deepEqual(r.missing, ['BLOCKS.BSA', 'MAPS.BSA']);
});

test('ground picks reachable surfaces and ignores walls', () => {
  // Floor at y=0 over [-10,10]², a raised platform at y=0.5 and a roof at y=5 over [0,2]².
  const quad = (x0, x1, z0, z1, y) => [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1];
  const wall = [0, 0, 0, 0, 5, 0, 0, 5, 2];
  const pos = new Float32Array([...quad(-10, 10, -10, 10, 0), ...quad(0, 2, 0, 2, 5), ...quad(-4, -2, 0, 2, 0.5), ...wall]);
  const g = new Ground(pos);
  assert.equal(g.heightAt(1, 1, null), 0); // spawn: lowest
  assert.equal(g.heightAt(1, 1, 0), 0); // roof too high
  near(g.heightAt(-3, 1, 0), 0.5); // step up
  const exterior = new Ground(pos, { terrainHeightAt: () => 4.8 });
  assert.equal(exterior.heightAt(1, 1), 5);
  assert.equal(exterior.heightAt(-3, 1), 4.8, 'embedded undersides stay below the terrain');
  assert.equal(g.heightAt(50, 50, 0), null);
});

test('matrices: projection of a point straight ahead lands at screen centre', () => {
  const proj = M.perspective(new Float32Array(16), Math.PI / 2, 1, 0.1, 100);
  const view = M.lookAt(new Float32Array(16), [0, 0, 0], [0, 0, -1], [0, 1, 0]);
  const vp = M.multiply(new Float32Array(16), proj, view);
  const p = M.projectToScreen(vp, 0, 0, -5, 200, 100);
  near(p.x, 100); near(p.y, 50);
  assert.equal(M.projectToScreen(vp, 0, 0, 5, 200, 100), null);
  const inv = M.invert(new Float32Array(16), vp);
  const id = M.multiply(new Float32Array(16), vp, inv);
  for (let i = 0; i < 16; i++) near(id[i], i % 5 === 0 ? 1 : 0, 1e-4);
});

test('sanitizePlayer and describeClose', () => {
  assert.equal(sanitizePlayer(null), null);
  assert.deepEqual(sanitizePlayer({ id: 3, name: 'a', x: 'no', z: 2, yaw: NaN, moving: 1 }), { id: '3', name: 'a', x: 0, z: 2, yaw: 0, moving: true });
  // The locomotion body fields survive (foot height reconciliation, respawn on stacked floors, remote stance).
  assert.deepEqual(sanitizePlayer({ id: 4, name: 'b', x: 1, z: 2, yaw: 0, y: 12.8, stance: 'swim', speed: 1.5 }),
    { id: '4', name: 'b', x: 1, z: 2, yaw: 0, moving: false, y: 12.8, stance: 'swim', speed: 1.5 });
  assert.deepEqual(sanitizePlayer({ id: 5, x: 0, z: 0, yaw: 0, y: NaN, stance: 7, speed: 'x' }), { id: '5', name: '?', x: 0, z: 0, yaw: 0, moving: false });
  assert.equal(describeClose(CLOSE.REPLACED).auto, false);
  assert.equal(describeClose(CLOSE.ABNORMAL).auto, true);
});

// --- Connection against a scripted fake WebSocket

class FakeWS {
  static script = null;
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWS.last = this;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(data) {
    this.sent.push(JSON.parse(data));
    FakeWS.script?.(this, JSON.parse(data));
  }
  recv(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code, reason }));
  }
}

test('connection: join → welcome, state/chat dispatch, close info', async () => {
  FakeWS.script = (ws, msg) => {
    if (msg.type === 'join') ws.recv({ type: 'welcome', id: 'p1', token: 'tok', player: { id: 'p1', name: msg.name, x: 1, z: 2, yaw: 0, moving: false } });
  };
  const c = new Connection('ws://x/ws', { WebSocketImpl: FakeWS });
  const w = await c.connect({ name: 'Ysmir', token: null });
  assert.equal(w.token, 'tok');
  assert.equal(FakeWS.last.sent[0].token, undefined, 'no token key when creating a guest');
  const got = [];
  c.onState = (p, location) => got.push(['state', p, location]);
  c.onChat = (m) => got.push(['chat', m]);
  FakeWS.last.recv({ type: 'state', location: 'wilderness:109,159', players: [{ id: 'p1', name: 'Ysmir', x: 0, z: 0, yaw: 0, moving: false }, { bogus: 1 }] });
  FakeWS.last.recv({ type: 'chat', name: 'A', text: 'hi' });
  assert.equal(got[0][1].length, 1);
  assert.equal(got[0][2], 'wilderness:109,159');
  assert.deepEqual(got[1][1], { name: 'A', text: 'hi' });
  assert.ok(c.sendInput(1, 0, 0.5));
  assert.deepEqual(FakeWS.last.sent.at(-1), { type: 'input', forward: 1, strafe: 0, yaw: 0.5 });
  const closed = new Promise((r) => (c.onClose = r));
  FakeWS.last.close(CLOSE.REPLACED, 'signed in from another session');
  assert.equal((await closed).code, CLOSE.REPLACED);
});

test('connection: invalid token and name rejection map to typed errors', async () => {
  FakeWS.script = (ws) => { ws.recv({ type: 'error', message: 'invalid token' }); ws.close(CLOSE.INVALID_TOKEN, 'invalid token'); };
  await assert.rejects(new Connection('ws://x', { WebSocketImpl: FakeWS }).connect({ name: 'a', token: 'x' }), { kind: 'invalid-token' });
  FakeWS.script = (ws) => ws.recv({ type: 'error', message: 'invalid name: bad' });
  await assert.rejects(new Connection('ws://x', { WebSocketImpl: FakeWS }).connect({ name: '!' }), { kind: 'rejected', retryable: false });
  FakeWS.script = (ws) => ws.close(1006);
  await assert.rejects(new Connection('ws://x', { WebSocketImpl: FakeWS }).connect({ name: 'a' }), { kind: 'unreachable' });
});
