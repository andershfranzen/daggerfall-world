// Horse riding and the travel journey: buying a horse in normal play, mounted vs walking speed
// through the real game loop (with collision), dismounting at doors, client prediction parity,
// the authoritative fare and its retries, and journey progress along the classic route.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installInventory } from '../server/rpg/inventory.js';
import { install as installNpcs } from '../server/rpg/npcs.js';
import { install as installTravel } from '../server/rpg/travel.js';
import { install as installMount } from '../server/rpg/mount.js';
import { createCollision } from '../server/rpg/collision.js';
import { Catalog, locationId } from '../client/gameplay/travel/catalog.js';
import { quoteJourney, journeyRoute, routeAt, presentationMs, travelMinutes } from '../client/gameplay/travel/journey.js';
import {
  compositeWorld, frameRoute, closeView, lerpView, timelineAt, dayAt, toCanvas, MAP_W, MAP_H,
} from '../client/gameplay/travel/journeyView.js';
import { rideSpeed, rideRefusal, isRiding, WALK_SPEED } from '../client/gameplay/mount/rules.js';
import { decodeCfa, ridingRect } from '../client/gameplay/mount/cfa.js';
import { mountedItems, horseFlip, RIDER_LIFT } from '../client/gameplay/mount/sprites.js';
import { Predictor, SPEED } from '../client/lib/motion.js';
import { openPlaneWorld } from '../client/gameplay/collision/world.js';
import { synthWorld } from './rpg-collision.test.mjs';

const HOME = 'town:Daggerfall/Gothway Garden';
const ARENA2 = new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url);

function syntheticWorld() {
  const L = (region, regionIndex, name, type, x, y) => ({
    id: locationId(region, name), region, regionIndex, name, type, discovered: true, x, y, index: 0, mapId: 1,
  });
  return {
    catalog: new Catalog([
      L('Daggerfall', 17, 'Gothway Garden', 'hamlet', 109, 159),
      L('Daggerfall', 17, 'Daggerfall', 'city', 207, 213),
      L('Daggerfall', 17, 'Ashfield Hamlet', 'hamlet', 112, 161),
      L('Wayrest', 23, 'Wayrest', 'city', 859, 244),
    ], 'files'),
    climate: { atMapPixel: () => 231 },
    politic: null,
  };
}

/** A real runtime with inventory, npcs, travel and mount installed. */
async function stack() {
  const players = new Map();
  const sent = [];
  let travelApi;
  let clock = 0;
  const runtime = createRpgRuntime({
    players,
    features: [
      { name: 'inventory', install: installInventory },
      { name: 'npcs', install: installNpcs },
      { name: 'travel', install: (ctx) => { travelApi = installTravel(ctx, { loadWorld: async () => syntheticWorld() }); } },
      { name: 'mount', install: installMount },
    ],
    save: () => {},
    send: (p, msg) => sent.push([p.id, msg]),
    dataPath: '/fake/arena2',
    now: () => clock,
    config: { maxSpeed: 4 },
    log: { info() {}, warn() {}, error() {} },
  });
  await travelApi.ready;
  const join = (id, rpg = {}) => {
    const p = { id, name: `Rider${id}`, x: 0, z: 0, yaw: 0, moving: false, rpg: { location: HOME, ...rpg } };
    players.set(id, p);
    runtime.join(p);
    return p;
  };
  const events = (id, kind) => sent.filter(([to, m]) => to === id && m.type === 'gameEvent' && m.event.kind === kind).map(([, m]) => m.event);
  const advance = (ms) => { clock += ms; runtime.tick(ms / 1000, clock); };
  return { runtime, join, sent, events, services: runtime.ctx.services, advance };
}

describe('acquiring a horse', () => {
  test('the provisioner sells a horse, and owning it prices journeys by horse', async () => {
    const t = await stack();
    const p = t.join(1, { gold: 3000 });
    const merchant = [...t.runtime.ctx.entities.values()].find((e) => e.kind === 'npc' && e.location === HOME && e.role === 'merchant');
    assert.ok(merchant, 'the town has a provisioner');
    p.x = merchant.x; p.z = merchant.z + 1;
    const ask = (verb, args) => {
      const r = t.runtime.act(p, verb, args);
      assert.equal(r.ok, true, r.error);
      return t.sent.filter(([id, m]) => id === 1 && m.type === 'gameEvent').map(([, m]) => m.event).at(-1);
    };
    const talk = ask('npc.talk', { targetId: merchant.id });
    const trade = ask('npc.topic', { targetId: merchant.id, session: talk.session, topic: 'trade' });
    const horse = trade.shop.items.find((i) => i.key === 'horse');
    assert.ok(horse, 'a horse is for sale');
    assert.ok(horse.price >= 1000, `priced from the classic 1000 gold (${horse.price})`);
    const foot = t.services.travel.quote(p, 'town:Wayrest/Wayrest', {});
    const gold0 = p.rpg.gold;
    ask('npc.buy', { targetId: merchant.id, session: talk.session, key: 'horse', quantity: 1, price: horse.price });
    assert.equal(p.rpg.gold, gold0 - horse.price);
    const owned = p.rpg.inventory.find((i) => i.template === 'horse');
    assert.ok(owned, 'the horse is in the pack');
    assert.equal(owned.weight, 0, 'a horse weighs nothing in the pack (hasNoEncumbrance)');
    const q = t.services.travel.quote(p, 'town:Wayrest/Wayrest', {});
    assert.equal(q.transport, 'horse');
    assert.ok(q.minutes < foot.minutes, 'a horse shortens the road');
    assert.equal(t.runtime.act(p, 'mount.ride', { on: true }).ok, true, 'and can be ridden at once');
  });

  test('without a horse, riding is refused and nothing changes', async () => {
    const t = await stack();
    const p = t.join(1, { gold: 0 });
    const r = t.runtime.act(p, 'mount.ride', { on: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /no horse/i);
    assert.equal(p.rpg.mount.riding, false);
    assert.equal(t.services.moveSpeed(p), null);
  });
});

describe('riding', () => {
  test('mount and dismount outdoors; speed, peers and events follow; a second observer is told', async () => {
    const t = await stack();
    const p = t.join(1);
    t.join(2);
    t.services.giveItem(p, 'horse');
    assert.deepEqual(t.runtime.act(p, 'mount.ride', {}), { ok: true });
    assert.equal(p.rpg.mount.riding, true);
    assert.equal(isRiding(p.rpg), true);
    const v = t.services.moveSpeed(p);
    assert.equal(v, rideSpeed(p.rpg.character));
    assert.ok(v > 2 * WALK_SPEED * 0.95, `mounted ${v} m/s is about twice the walk`);
    assert.equal(t.events(1, 'mount').at(-1).mounted, true);
    const seen = t.events(2, 'mount').at(-1);
    assert.deepEqual([seen.playerId, seen.mounted, seen.name], [1, true, 'Rider1']);
    assert.equal(t.events(1, 'mount').filter((e) => e.name).length, 0, 'the rider gets their own message, not the bystander one');
    t.runtime.sync();
    const view = t.sent.filter(([id, m]) => id === 2 && m.type === 'rpg').at(-1)[1];
    assert.equal(view.peers.find((x) => x.id === 1).mounted, true, 'other players see the rider');
    assert.deepEqual(t.runtime.act(p, 'mount.ride', { on: false }), { ok: true });
    assert.equal(p.rpg.mount.riding, false);
    assert.equal(t.services.moveSpeed(p), null);
    t.runtime.sync();
    const view2 = t.sent.filter(([id, m]) => id === 2 && m.type === 'rpg').at(-1)[1];
    assert.equal(view2.peers.find((x) => x.id === 1).mounted, undefined);
  });

  test('indoors: no mounting, and walking through a door leaves the horse outside', async () => {
    const t = await stack();
    const p = t.join(1, { location: 'building:Daggerfall/Gothway Garden/3' });
    t.services.giveItem(p, 'horse');
    const r = t.runtime.act(p, 'mount.ride', { on: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /indoors/);
    p.rpg.location = HOME;
    assert.equal(t.runtime.act(p, 'mount.ride', { on: true }).ok, true);
    p.rpg.location = 'building:Daggerfall/Gothway Garden/3'; // a portal moved them inside
    t.advance(50);
    assert.equal(p.rpg.mount.riding, false, 'dismounted at the door');
    assert.equal(t.services.moveSpeed(p), null);
    assert.match(t.events(1, 'mount').at(-1).text, /outside/);
    p.rpg.location = HOME;
    t.advance(50);
    assert.equal(p.rpg.mount.riding, false, 'still on foot coming back out');
  });

  test('selling or losing the horse dismounts; a stale save cannot ride', async () => {
    const t = await stack();
    const p = t.join(1, { mount: { riding: true } });
    assert.equal(p.rpg.mount.riding, false, 'riding without a horse is cleared on join');
    t.services.giveItem(p, 'horse');
    t.runtime.act(p, 'mount.ride', { on: true });
    const horse = p.rpg.inventory.find((i) => i.template === 'horse');
    t.services.takeItem(p, horse.id, 1);
    t.advance(50);
    assert.equal(p.rpg.mount.riding, false);
    assert.equal(rideRefusal(p.rpg), 'You have no horse. General stores sell them.');
  });

  test('prediction parity: the browser predictor moves exactly as the server speed says', () => {
    const sheet = { attributes: { Speed: 63 } };
    const server = rideSpeed(sheet, 4);
    const pr = new Predictor();
    pr.reset(0, 0);
    for (let i = 0; i < 60; i++) pr.update(1, 0, 0, 1 / 60, i / 60, rideSpeed(sheet));
    assert.ok(Math.abs(-pr.z - server) < 1e-9, `predicted ${-pr.z} vs server ${server}`);
    const walk = new Predictor();
    walk.reset(0, 0);
    for (let i = 0; i < 60; i++) walk.update(1, 0, 0, 1 / 60, i / 60);
    assert.ok(Math.abs(-walk.z - SPEED) < 1e-9);
    assert.equal(rideSpeed({ attributes: { Speed: 50 } }), 8.5, 'DFU (Speed+375)/(50+150) of the 4 m/s walk');
  });
});

describe('the game loop', () => {
  async function server(features) {
    const { createGameServer } = await import('../server/game.js');
    const dir = mkdtempSync(join(tmpdir(), 'dfw-mount-'));
    const srv = createGameServer({ port: 0, dbPath: join(dir, 'db.sqlite'), features, defaultLocation: HOME });
    const { port } = await srv.start();
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d)));
    await new Promise((r) => ws.once('open', r));
    const wait = async (pred, ms = 4000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = msgs.find(pred);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 15));
      }
      throw new Error('timeout');
    };
    return { srv, ws, msgs, wait };
  }

  // Stands in for a purchase: the inventory feature normalises this into a real Horse record.
  const horseFeature = (ctx) => {
    ctx.onJoin((p) => {
      if (!p.rpg.inventory?.some((i) => i.template === 'horse')) ctx.services.giveItem(p, 'horse');
    });
  };

  // Records every tick's dt and each player's position after the loop moved them, so speeds are
  // measured per tick from the server's own clock: exact under any machine load.
  const recorder = (log) => (ctx) => ctx.onTick((dt) => {
    for (const p of ctx.players.values()) log.push({ dt, x: p.x, z: p.z, riding: ctx.services.mount?.isRiding(p) === true, speed: ctx.services.moveSpeed?.(p) ?? null });
  });

  async function drive(s, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      s.ws.send(JSON.stringify({ type: 'input', forward: 1, strafe: 0, yaw: 0 }));
      await new Promise((r) => setTimeout(r, 50));
    }
    s.ws.send(JSON.stringify({ type: 'input', forward: 0, strafe: 0, yaw: 0 }));
    await new Promise((r) => setTimeout(r, 150));
  }

  /** Per-tick speeds (m/s) while moving, split by riding. */
  function speeds(log) {
    const out = { foot: [], horse: [] };
    for (let i = 1; i < log.length; i++) {
      const a = log[i - 1], b = log[i];
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < 1e-6 || !(b.dt > 0)) continue;
      (b.riding ? out.horse : out.foot).push(d / b.dt);
    }
    return out;
  }

  test('the server moves a rider at the mounted speed and a walker at the walk, tick by tick', async () => {
    const log = [];
    const open = (ctx) => createCollision(ctx, { fixtures: { [HOME]: openPlaneWorld(400) }, load: async () => { throw new Error('none'); } });
    const s = await server([open, installInventory, horseFeature, installMount, recorder(log)]);
    try {
      s.ws.send(JSON.stringify({ type: 'join', name: 'Rider' }));
      await s.wait((m) => m.type === 'welcome');
      await drive(s, 600);
      s.ws.send(JSON.stringify({ type: 'action', verb: 'mount.ride', args: { on: true }, seq: 1 }));
      const res = await s.wait((m) => m.type === 'actionResult' && m.seq === 1);
      assert.equal(res.ok, true, res.error);
      await drive(s, 600);
      const v = speeds(log);
      const want = log.find((e) => e.riding)?.speed;
      assert.ok(v.foot.length >= 2 && v.horse.length >= 2, `moved on foot (${v.foot.length} ticks) and mounted (${v.horse.length} ticks)`);
      assert.ok(want > 8, `mounted speed ${want} m/s`);
      for (const x of v.foot) assert.ok(x <= 4 + 1e-6, `walking tick at ${x} m/s never exceeds the walk`);
      for (const x of v.horse) assert.ok(x <= want + 1e-6, `riding tick at ${x} m/s never exceeds the ride`);
      assert.ok(Math.abs(Math.max(...v.foot) - 4) < 1e-6, 'a free walking tick runs at exactly 4 m/s');
      assert.ok(Math.abs(Math.max(...v.horse) - want) < 1e-6, `a free riding tick runs at exactly ${want} m/s`);
    } finally {
      s.ws.close();
      await s.srv.close();
    }
  });

  test('collision still stops a rider at a wall', async () => {
    const log = [];
    const wall = synthWorld({ walls: [{ a: [-10, -2], b: [10, -2] }] });
    const walled = (ctx) => createCollision(ctx, { fixtures: { [HOME]: wall }, load: async () => { throw new Error('none'); } });
    const s = await server([walled, installInventory, horseFeature, installMount, recorder(log)]);
    try {
      s.ws.send(JSON.stringify({ type: 'join', name: 'Rider' }));
      await s.wait((m) => m.type === 'welcome');
      s.ws.send(JSON.stringify({ type: 'action', verb: 'mount.ride', args: { on: true }, seq: 1 }));
      assert.equal((await s.wait((m) => m.type === 'actionResult' && m.seq === 1)).ok, true);
      await drive(s, 900);
      const riding = log.filter((e) => e.riding);
      assert.ok(riding.length > 0);
      assert.ok(riding.every((e) => e.z > -2), 'never through the wall');
      assert.ok(Math.min(...riding.map((e) => e.z)) < -1, 'rode up to it');
    } finally {
      s.ws.close();
      await s.srv.close();
    }
  });
});

describe('travel by horse', () => {
  test('the server charges the fare it quotes, records the route and the rider, and a retry is free', async () => {
    const t = await stack();
    const p = t.join(1, { gold: 500 });
    t.services.giveItem(p, 'horse');
    t.runtime.act(p, 'mount.ride', { on: true });
    const to = 'town:Wayrest/Wayrest';
    const options = { speed: 'reckless', lodging: 'inn', ship: true };
    const q = t.services.travel.quote(p, to, options);
    assert.equal(q.transport, 'horse');
    assert.ok(q.cost.total > 0);
    const wrong = t.runtime.act(p, 'travel.go', { to, options, expectCost: q.cost.total + 1, requestId: 'trip-aaaaaa' });
    assert.equal(wrong.ok, false, 'a stale price is refused');
    assert.equal(t.events(1, 'travel').length, 0, 'a refusal sends no journey');
    assert.equal(p.rpg.location, HOME);

    const gold0 = p.rpg.gold;
    const r = t.runtime.act(p, 'travel.go', { to, options, expectCost: q.cost.total, requestId: 'trip-bbbbbb' });
    assert.deepEqual(r, { ok: true });
    assert.equal(p.rpg.gold, gold0 - q.cost.total);
    const ev = t.events(1, 'travel').at(-1);
    assert.equal(ev.requestId, 'trip-bbbbbb');
    assert.equal(ev.mounted, true);
    assert.deepEqual([ev.route.from.x, ev.route.from.y, ev.route.to.x, ev.route.to.y], [109, 159, 859, 244]);
    assert.equal(ev.route.from.name, 'Gothway Garden');
    assert.equal(ev.days, q.days);
    assert.equal(ev.showMs, presentationMs(q.days));
    assert.equal(p.rpg.travel.lastTrip.requestId, 'trip-bbbbbb');
    assert.equal(isRiding(p.rpg), true, 'still mounted on arrival outdoors');

    // The answer was lost; the client asks again with the same request id.
    t.advance(5000);
    const again = t.runtime.act(p, 'travel.go', { to, options, expectCost: q.cost.total, requestId: 'trip-bbbbbb' });
    assert.deepEqual(again, { ok: true });
    assert.equal(p.rpg.gold, gold0 - q.cost.total, 'not charged twice');
    assert.equal(p.rpg.travel.trips, 1);
    assert.equal(t.events(1, 'travel').at(-1).repeat, true);
    // A new request to the same place is refused as usual.
    assert.match(t.runtime.act(p, 'travel.go', { to, requestId: 'trip-cccccc' }).error, /already in/);
  });

  test('nearby and cross-region routes follow the classic stepped line, with progress by travel time', () => {
    const from = { x: 109, y: 159 };
    for (const to of [{ x: 112, y: 161 }, { x: 859, y: 244 }]) {
      const climateAt = (x) => (x > 400 ? 223 : 231);
      const r = journeyRoute(from, to, { climateAt, transport: 'horse' });
      const m = travelMinutes(from, to, { climateAt, transport: 'horse' });
      assert.ok(r.points.length === m.steps + 1 || r.points.length === m.steps + 2, 'every classic step, plus the arrival when the line stops a pixel short');
      assert.deepEqual([r.points[0].x, r.points[0].y], [from.x, from.y]);
      assert.deepEqual([r.points.at(-1).x, r.points.at(-1).y], [to.x, to.y]);
      assert.equal(r.points.at(-1).f, 1);
      for (let i = 1; i < r.points.length; i++) {
        assert.ok(r.points[i].f >= r.points[i - 1].f);
        assert.ok(Math.abs(r.points[i].x - r.points[i - 1].x) <= 1 && Math.abs(r.points[i].y - r.points[i - 1].y) <= 1, 'one pixel per step');
      }
      const mid = routeAt(r.points, 0.5);
      assert.ok(mid.x >= Math.min(from.x, to.x) && mid.x <= Math.max(from.x, to.x));
    }
    // Slower country (desert, 223) takes a larger share of the bar than its share of the distance.
    const r = journeyRoute({ x: 0, y: 0 }, { x: 10, y: 0 }, { climateAt: (x) => (x <= 5 ? 225 : 231) });
    const q = quoteJourney({ x: 0, y: 0 }, { x: 10, y: 0 }, {}, { climateAt: (x) => (x <= 5 ? 225 : 231) });
    assert.notEqual(r.points[5].f, 0.5);
    assert.ok(q.minutes > 0);
    assert.equal(dayAt(0, 9), 1);
    assert.equal(dayAt(0.5, 9), 5);
    assert.equal(dayAt(1, 9), 9);
  });

  test('the journey view starts close on the origin, frames both ends, and respects reduced motion', () => {
    const aspect = 16 / 9;
    const from = { x: 109, y: 159 }, to = { x: 859, y: 244 };
    const close = closeView(from, aspect);
    const frame = frameRoute(from, to, aspect);
    for (const p of [from, to]) {
      const c = toCanvas(frame, 1600, 900, p.x, p.y);
      assert.ok(c.x > 0 && c.x < 1600 && c.y > 0 && c.y < 900, 'both ends are on screen');
    }
    assert.ok(close.w < frame.w);
    const near = frameRoute(from, { x: 112, y: 161 }, aspect);
    assert.ok(near.w >= 90 && near.w < 200, 'a short trip stays zoomed in');
    const half = lerpView(close, frame, 0.5, aspect);
    assert.ok(half.w > close.w && half.w < frame.w);
    assert.ok(frame.cx - frame.w / 2 >= 0 && frame.cx + frame.w / 2 <= MAP_W && frame.cy + frame.h / 2 <= MAP_H);
    assert.equal(timelineAt(0, 4000).zoomOut, 0);
    assert.equal(timelineAt(4000, 4000).progress, 1);
    assert.equal(timelineAt(2000, 4000).zoomOut, 1);
    assert.equal(timelineAt(0, 1500, { reducedMotion: true }).zoomOut, 1, 'reduced motion: no zoom');
    assert.ok(presentationMs(9, { reducedMotion: true }) <= 1500);
    assert.ok(presentationMs(1) >= 3000 && presentationMs(400) <= 7000);
  });
});

describe('mount art', () => {
  test('CFA decoding and riding layout', () => {
    // 2x1, two frames, RLE: run of 2 x colour 5, then literal [7, 0]
    const b = new Uint8Array(76 + 5);
    const v = new DataView(b.buffer);
    v.setInt16(0, 2, true); v.setInt16(2, 1, true); v.setInt16(4, 2, true);
    b[10] = 8; b[11] = 2; v.setInt16(12, 76, true);
    b.set([129, 5, 1, 7, 0], 76);
    const img = decodeCfa(b);
    assert.deepEqual([...img.frames[0]], [5, 5]);
    assert.deepEqual([...img.frames[1]], [7, 0]);
    b[10] = 4;
    assert.throws(() => decodeCfa(b), /8-bit/);
    const rect = ridingRect({ width: 106, height: 105 }, 1280, 800);
    assert.equal(rect.h, 420);
    assert.equal(rect.y + rect.h, 800);
    assert.ok(Math.abs(rect.x + rect.w / 2 - 640) < 1e-9);
  });

  test('the installed MRED00I0.CFA decodes to the four classic riding frames', { skip: !existsSync(new URL('MRED00I0.CFA', ARENA2)) && 'no local ARENA2' }, () => {
    const img = decodeCfa(new Uint8Array(readFileSync(new URL('MRED00I0.CFA', ARENA2))), 'MRED00I0.CFA');
    assert.deepEqual([img.width, img.height, img.frames.length], [106, 105, 4]);
    assert.ok(img.frames.every((f) => f.some((c) => c !== 0)));
  });

  test('a mounted peer is drawn as the horse flat with the rider on its back', () => {
    const rider = { key: 'p:1', id: 1, x: 0, y: 0, z: 0, w: 1, h: 1.8, light: 1 };
    const horse = { sprite: { recordCount: 2, records: [{ world: { width: 2.4, height: 2.2 } }, { world: { width: 2.1, height: 2.2 } }] } };
    const [h, r] = mountedItems(rider, horse, { x: 0, z: 10 }, { coat: 1, facing: 2 });
    assert.equal(h.entry, horse);
    assert.equal(h.record, 1);
    assert.equal(h.flip, true);
    assert.equal(r.y, RIDER_LIFT);
    assert.ok(r.z > 0, 'rider drawn a little nearer the camera');
    assert.equal(mountedItems(rider, null, { x: 0, z: 10 }).length, 1, 'rider still drawn while horse art loads');
    assert.equal(horseFlip(6), false);
  });

  test('the bay composite fills every map pixel', () => {
    const img = (w, h, rgb) => ({ width: w, height: h, rgba: new Uint8ClampedArray(w * h * 4).map((_, i) => (i % 4 === 3 ? 255 : rgb[i % 4])) });
    const w = compositeWorld((n) => (n === 'FMAP0I17.IMG' ? img(320, 160, [10, 120, 20]) : n === 'FMAP0I23.IMG' ? img(320, 160, [30, 60, 170]) : null));
    assert.equal(w.maps, 2);
    assert.ok(w.rgba.every((v, i) => i % 4 !== 3 || v === 255));
    const at = (x, y) => [...w.rgba.subarray((y * 1000 + x) * 4, (y * 1000 + x) * 4 + 3)];
    assert.deepEqual(at(100, 150), [10, 120, 20], 'Daggerfall map pasted at its corner (39,106)');
    assert.deepEqual(at(5, 5), [30, 60, 170], 'gaps filled with the maps’ water');
  });
});

describe('journey camera', () => {
  test('the raised eye stands above and behind the traveller, looking down at their feet', async () => {
    const { raisedCamera, blendCamera } = await import('../client/gameplay/journey.js');
    const cam = raisedCamera(10, 2, -5, 0.3);
    assert.ok(Math.abs(cam.y - 2 - 18) < 1e-9 && cam.pitch < -0.5, 'eighteen metres over the feet, looking down');
    const fwd = [Math.sin(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.pitch), -Math.cos(cam.yaw) * Math.cos(cam.pitch)];
    const s = (2 - cam.y) / fwd[1];
    assert.ok(Math.abs(cam.x + fwd[0] * s - 10) < 1e-6 && Math.abs(cam.z + fwd[2] * s + 5) < 1e-6, 'line of sight meets the feet');
    const mid = blendCamera({ x: 0, y: 0, z: 0, yaw: 3, pitch: 0 }, { x: 2, y: 2, z: 2, yaw: -3, pitch: -1 }, 0.5);
    assert.ok(Math.abs(Math.abs(mid.yaw) - Math.PI) < 0.01, 'yaw turns the short way round');
  });
});
