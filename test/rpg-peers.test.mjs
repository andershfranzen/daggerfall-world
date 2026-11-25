// Brief E: nearby players stay visible across outdoor boundaries (server/rpg/peers.js).
// Synthetic town placement (no game data): the real runtime and overland frame service, then the
// real HTTP/WebSocket server (server/game.js) with two signed-in sockets walking with real input.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installOverland, townFrame, townToWild, HALF } from '../server/rpg/overland.js';
import { install as installPeers, createPeerView, VIEW_RANGE, MAX_ACROSS, HYSTERESIS } from '../server/rpg/peers.js';
import { sanitizePlayer } from '../client/lib/net.js';
import { tempDir, startLiveWorld, accountSession, LiveClient } from './support/rpg-session.mjs';
import { createCollision } from '../server/rpg/collision.js';
import { CollisionWorld, openPlaneWorld } from '../client/gameplay/collision/world.js';
import { parseWildernessId } from '../server/rpg/overland.js';

const quiet = { info() {}, warn() {}, error() {} };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

// Gothway Garden's real placement: 4x3 blocks in map pixel (109, 159).
const HOME = { id: 'town:Daggerfall/Gothway Garden', region: 'Daggerfall', name: 'Gothway Garden', x: 109, y: 159 };
const META = { [HOME.id]: { width: 4, height: 3, spawnLocal: { x: 257.6, z: 180.8 } } };
const PIX = 'wilderness:109,159';
const EAST = 'wilderness:110,159';
const frame = townFrame({ id: HOME.id, px: HOME.x, py: HOME.y, ...META[HOME.id] });

const syntheticOverland = (ctx) => installOverland(ctx, { loadCatalog: async () => [HOME], loadMeta: async (e) => META[e.id] });

async function fixture() {
  const players = new Map();
  const sent = [];
  let api;
  const runtime = createRpgRuntime({
    players, save() {}, log: quiet, defaultLocation: HOME.id, config: { worldHalfExtent: 1024 },
    send: (p, msg) => sent.push([p.id, msg]),
    features: [(ctx) => { api = syntheticOverland(ctx); }, installPeers],
  });
  await api.ready;
  await api.service.whenPlaced(HOME.id);
  const view = runtime.ctx.services.peerView;
  const put = (id, location, x, z, extra = {}) => {
    let p = players.get(id);
    if (!p) {
      p = { id, name: `P${id}`, x, z, yaw: 0, forward: 0, strafe: 0, moving: false, rpg: { location } };
      players.set(id, p);
      runtime.join(p);
    }
    Object.assign(p, { x, z }, extra);
    p.rpg.location = location;
    view.invalidate();
    return p;
  };
  const ids = (p) => view.across(p).map((a) => a.player.id).sort();
  return { runtime, players, view, put, ids, sent, overland: api.service };
}

describe('[fixture] peer projection', () => {
  test('across a town edge: each sees the other where they really stand, in its own frame', async () => {
    const w = await fixture();
    const a = w.put(1, HOME.id, frame.walk.maxX - 2, 10); // inside, 2 m from the east edge
    const outside = townToWild(frame, frame.walk.maxX + 3, 10); // 3 m beyond it, in the town's pixel
    const b = w.put(2, PIX, outside.x, outside.z);
    const [ab] = w.view.across(a);
    assert.equal(ab.player, b);
    near(ab.x, frame.walk.maxX + 3);
    near(ab.z, 10);
    near(ab.distance, 5);
    const [ba] = w.view.across(b);
    assert.equal(ba.player, a);
    const inWild = townToWild(frame, a.x, a.z);
    near(ba.x, inWild.x);
    near(ba.z, inWild.z);
  });

  test('a pixel edge and a diagonal corner agree from every side', async () => {
    const w = await fixture();
    const c = [
      w.put(1, 'wilderness:109,158', HALF - 1, HALF - 1),
      w.put(2, 'wilderness:110,158', -HALF + 1, HALF - 1),
      w.put(3, PIX, HALF - 1, -HALF + 1),
      w.put(4, EAST, -HALF + 1, -HALF + 1),
    ];
    for (const p of c) assert.deepEqual(w.ids(p), [1, 2, 3, 4].filter((id) => id !== p.id), `P${p.id}`);
    // P4 seen from P1's frame sits 2 m east and 2 m south of P1.
    const p4 = w.view.across(c[0]).find((a) => a.player.id === 4);
    near(p4.x - c[0].x, 2);
    near(p4.z - c[0].z, 2);
  });

  test('range, hysteresis, cap; same location and indoors never project', async () => {
    const w = await fixture();
    const a = w.put(1, PIX, HALF - 1, 0);
    const b = w.put(2, EAST, -HALF + 1 + (VIEW_RANGE - 2) - 2, 0); // VIEW_RANGE - 2 m away
    assert.deepEqual(w.ids(a), [2]);
    w.put(2, EAST, b.x + 10, 0); // now 8 m past the radius but inside the hysteresis band
    assert.ok(VIEW_RANGE + 8 < VIEW_RANGE * HYSTERESIS);
    assert.deepEqual(w.ids(a), [2], 'already shown: stays');
    w.put(2, EAST, -HALF + 1 + VIEW_RANGE * HYSTERESIS + 5, 0);
    assert.deepEqual(w.ids(a), [], 'gone beyond the band');
    w.put(2, EAST, -HALF + 1 + VIEW_RANGE + 8, 0);
    assert.deepEqual(w.ids(a), [], 'not shown before: the plain radius applies');

    const same = w.put(3, PIX, HALF - 3, 0);
    assert.ok(!w.ids(a).includes(3), 'same-location players come from the location itself, never twice');
    const inside = w.put(4, 'interior:Daggerfall/Gothway Garden/0,0/1', HALF - 1, 0);
    assert.ok(!w.ids(a).includes(4), 'indoors is never seen from outside');
    assert.deepEqual(w.view.across(inside), [], 'nor sees out');
    void same;
    for (let i = 0; i < MAX_ACROSS + 6; i++) w.put(100 + i, EAST, -HALF + 1 + i * 0.5, 3);
    assert.equal(w.view.across(a).length, MAX_ACROSS, 'bounded per viewer');
    assert.equal(w.view.across(a)[0].player.id, 100, 'nearest first');
  });

  test('rpg snapshot: projected peers carry public appearance only, once, and switch to local on crossing', async () => {
    const w = await fixture();
    const a = w.put(1, HOME.id, frame.walk.maxX - 2, 0);
    const o = townToWild(frame, frame.walk.maxX + 3, 0);
    const b = w.put(2, PIX, o.x, o.z);
    b.rpg.quests = { v: 1, active: [{ uid: 'secret', title: 'Private objective' }] };
    b.rpg.gold = 999;
    b.rpg.character = { race: 'breton', gender: 'female', name: 'B', health: 3 };
    w.sent.length = 0;
    w.runtime.sync(undefined, { force: true });
    const msgA = w.sent.filter(([id, m]) => id === a.id && m.type === 'rpg').at(-1)[1];
    const peer = msgA.peers.find((p) => p.id === b.id);
    assert.equal(peer.across, true);
    near(peer.x, frame.walk.maxX + 3, 1e-3);
    const text = JSON.stringify(peer);
    for (const secret of ['secret', 'Private objective', '999', 'wilderness', 'health', '"location"']) assert.ok(!text.includes(secret), `${secret} leaked: ${text}`);
    // B walks into town: now an ordinary same-location peer, listed exactly once.
    w.put(2, HOME.id, frame.walk.maxX - 1, 0);
    w.sent.length = 0;
    w.runtime.sync(undefined, { force: true });
    const after = w.sent.filter(([id, m]) => id === a.id && m.type === 'rpg').at(-1)[1];
    const listed = after.peers.filter((p) => p.id === b.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].across, undefined);
  });

  test('the browser keeps the across flag (no arrive/depart notices for peers seen over an edge)', () => {
    assert.equal(sanitizePlayer({ id: 2, name: 'B', x: 1, z: 2, yaw: 0, across: true }).across, true);
    assert.equal('across' in sanitizePlayer({ id: 2, name: 'B', x: 1, z: 2, yaw: 0 }), false);
    assert.equal('across' in sanitizePlayer({ id: 2, name: 'B', x: 1, z: 2, yaw: 0, across: 'yes' }), false);
  });

  test('a location whose frame is still loading is simply not projected', () => {
    const players = new Map([[1, { id: 1, x: 0, z: 0, rpg: { location: PIX } }], [2, { id: 2, x: 0, z: 0, rpg: { location: 'town:X/Y' } }]]);
    const view = createPeerView({
      players, locationOf: (p) => p.rpg.location,
      overland: () => ({ globalOf: (loc, x, z) => (loc === PIX ? { e: x, s: z } : null), localOf: (loc, e, s) => ({ x: e, z: s }) }),
    });
    assert.deepEqual(view.across(players.get(1)), []);
    assert.equal(view.stats().unplaced, 1);
  });
});

// ---- live: real game.js, two signed-in sockets, real input ------------------------------------

/** Flat ground: the town's walk rect, and an open plane over each map pixel (as test/rpg-overland.test.mjs). */
function flatCollision(ctx) {
  const w = frame.walk;
  const positions = new Float32Array([w.minX, 0, w.minZ, w.minX, 0, w.maxZ, w.maxX, 0, w.maxZ, w.minX, 0, w.minZ, w.maxX, 0, w.maxZ, w.maxX, 0, w.minZ]);
  createCollision(ctx, {
    fixtures: { [HOME.id]: new CollisionWorld({ name: HOME.id, openEdges: true, positions, groundFirstTriangle: 0, groundTriangleCount: 2 }, { cell: 64 }) },
    load: async (loc) => {
      if (!parseWildernessId(loc)) throw new Error(`no geometry for ${loc}`);
      const world = openPlaneWorld(HALF + 102.4, `flat ${loc}`);
      world.datum = 0;
      return { world, source: 'synthetic surface' };
    },
  });
}

/** Test-only verb that places a player (stands in for a long walk to the edge). */
function placer(ctx) {
  ctx.onAction('test.place', (p, args) => {
    p.rpg.location = args.location;
    p.x = args.x;
    p.z = args.z;
    p.yaw = args.yaw ?? 0;
    ctx.services.peerView?.invalidate();
  });
}

describe('[live] two browsers either side of a boundary', () => {
  let world, tmp;
  const clients = [];
  after(async () => {
    for (const c of clients) await c.close().catch(() => {});
    await world?.close();
    tmp?.remove();
  });

  test('walking across the gate: no gap, no duplicate, continuous position; indoors and distance hide; chat reaches', async () => {
    tmp = tempDir('dfw-peers-');
    world = await startLiveWorld({ dir: tmp.dir, features: [flatCollision, syntheticOverland, installPeers, placer] });
    const open = async (name) => {
      const jar = await accountSession(world.base, name);
      const c = new LiveClient(world.port, { cookie: jar.cookie });
      clients.push(c);
      await c.opened;
      c.send({ type: 'join', name, account: true });
      c.welcome = await c.next((m) => m.type === 'welcome', 'welcome');
      return c;
    };
    const a = await open('peera');
    const b = await open('peerb');
    const far = await open('peerfar');
    const ida = a.welcome.id, idb = b.welcome.id;
    // test.place with a generous wait (LiveClient.act allows 4 s, too short on a busy machine).
    const place = async (c, args) => {
      const seq = (c.seq = (c.seq ?? 0) + 1);
      const from = c.messages.length;
      c.send({ type: 'action', seq, verb: 'test.place', args });
      const saved = c.cursor;
      c.cursor = from;
      const m = await c.next((x) => x.type === 'actionResult' && x.seq === seq, `test.place #${seq}`, 15000);
      c.cursor = saved;
      return { ok: m.ok === true };
    };

    // A waits just inside the east edge; B stands 12 m outside, facing west (toward the town).
    assert.equal((await place(a, { location: HOME.id, x: frame.walk.maxX - 3, z: 5 })).ok, true);
    const out = townToWild(frame, frame.walk.maxX + 12, 5);
    assert.equal((await place(b, { location: PIX, x: out.x, z: out.z, yaw: -Math.PI / 2 })).ok, true);
    assert.equal((await place(far, { location: 'wilderness:112,159', x: 0, z: 0 })).ok, true); // ~2 km east

    const states = (c, from) => c.messages.slice(from).filter((m) => m.type === 'state');
    await a.next((m) => m.type === 'state' && m.players.some((p) => p.id === idb), 'A sees B across the edge', 15000);
    await b.next((m) => m.type === 'state' && m.players.some((p) => p.id === ida), 'B sees A across the edge', 15000);

    // Chat from across the edge reaches A, not the distant player.
    const farMark = far.messages.length; // everyone started in town; count from here on
    b.send({ type: 'chat', text: 'over here' });
    await a.next((m) => m.type === 'chat' && m.text === 'over here', 'A hears B', 15000);

    // B walks west with real input until the server has moved B into the town.
    const mark = a.messages.length;
    b.cursor = b.messages.length;
    const send = () => b.send({ type: 'input', forward: 1, strafe: 0, yaw: -Math.PI / 2 });
    send();
    const keep = setInterval(send, 100);
    try {
      await b.next((m) => m.type === 'rpg' && m.character?.location === HOME.id, 'B enters the town', 30000);
      await new Promise((r) => setTimeout(r, 600)); // a few more ticks inside
    } finally {
      clearInterval(keep);
      b.send({ type: 'input', forward: 0, strafe: 0, yaw: -Math.PI / 2 });
    }
    const seen = states(a, mark);
    assert.ok(seen.length >= 5, `${seen.length} state messages`);
    let prev = null;
    let flagged = 0;
    for (const s of seen) {
      const bs = s.players.filter((p) => p.id === idb);
      assert.equal(bs.length, 1, 'B exactly once in every state A received');
      const pb = bs[0];
      if (pb.across) flagged++;
      // A state goes out every 2 ticks; game.js clamps a stalled tick to 0.25 s at 4 m/s, so B moves at
      // most 2 m between states, including the crossing (overland.js). A frame
      // error would be hundreds of metres.
      if (prev) assert.ok(Math.hypot(pb.x - prev.x, pb.z - prev.z) <= 2 + 0.01, `continuous in A's frame: ${JSON.stringify(prev)} -> ${JSON.stringify(pb)}`);
      prev = pb;
    }
    assert.ok(flagged > 0 && !seen.at(-1).players.find((p) => p.id === idb).across, 'projected before, local after');
    assert.ok(!states(far, farMark).some((s) => s.players.some((p) => p.id === ida || p.id === idb)), 'the distant account never sees the pair');
    assert.ok(!far.messages.slice(farMark).some((m) => m.type === 'chat'), 'nor hears them');

    // B goes indoors: A stops seeing B.
    const indoor = a.messages.length;
    assert.equal((await place(b, { location: 'interior:Daggerfall/Gothway Garden/0,0/1', x: 1, z: 1 })).ok, true);
    await a.next((m) => m.type === 'state' && !m.players.some((p) => p.id === idb), 'B gone from A after entering', 15000);
    assert.ok(a.messages.slice(indoor).filter((m) => m.type === 'state').length >= 1);
  });
});
