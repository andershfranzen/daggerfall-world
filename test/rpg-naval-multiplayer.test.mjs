// End-to-end multiplayer sailing, naval combat, offline prize escrow, boarding/wreck edge cases,
// and admiralty bounty persistence across server restarts (no installed classic ARENA2 data required).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { features as manifest } from '../server/rpg/features.js';
import { install as sailing } from '../server/rpg/sailing.js';
import { install as naval } from '../server/rpg/naval.js';
import { install as admiralty } from '../server/rpg/admiralty.js';
import { makeItem } from '../server/rpg/inventory.js';
import { createFixtureWorld, tempDir } from './support/rpg-session.mjs';

const PORT_A = 'town:Daggerfall/Daggerfall';
const PORT_B = 'town:Wayrest/Wayrest';
const PORTS = [
  { id: PORT_A, name: 'Daggerfall', region: 'Daggerfall', x: 1000, z: 1000, yaw: Math.PI, quay: { x: 0, z: -40, yaw: 0 } },
  { id: PORT_B, name: 'Wayrest', region: 'Wayrest', x: 3500, z: 1000, yaw: Math.PI, quay: { x: 0, z: 30, yaw: 0 } },
];
const coast = {
  status: 'ready',
  isWater: () => true,
  ports: () => PORTS,
  portOf: (id) => PORTS.find((p) => p.id === id) ?? null,
  nearestPort: (x, z) => PORTS
    .map((port) => ({ port, distance: Math.hypot(port.x - x, port.z - z) }))
    .sort((a, b) => a.distance - b.distance)[0],
  route: (from, to) => {
    const a = PORTS.find((p) => p.id === from);
    const b = PORTS.find((p) => p.id === to);
    if (!a || !b) return null;
    const mid = { x: (a.x + b.x) / 2, z: Math.max(a.z, b.z) + 1200 };
    return { points: [{ x: a.x, z: a.z }, mid, { x: b.x, z: b.z }], metres: Math.hypot(b.x - a.x, b.z - a.z) * 1.3 };
  },
};

/** Lightweight melee enemy stub so boarding/repel works without ARENA2 monster tables. */
function boardingCombatStub(ctx) {
  let seq = 1;
  ctx.services.createEnemy = (loc, mobile, x, z, opts = {}) => {
    const id = `e-naval-${seq++}`;
    const e = { id, location: loc, mobile, x, z, hp: 30, maxHp: 30, dead: false, visibleTo: opts.visibleTo ?? null, origin: opts.origin ?? 'naval' };
    ctx.entities.set(id, e);
    return e;
  };
  ctx.services.banishMonster = (e) => {
    if (!e) return false;
    e.dead = true;
    ctx.entities.delete(e.id);
    return true;
  };
  ctx.services.damageEntity = (attacker, e, dmg) => {
    if (!e || e.dead) return;
    e.hp = Math.max(0, e.hp - dmg);
    if (e.hp <= 0) {
      e.dead = true;
      ctx.entities.delete(e.id);
      ctx.emit('kill', { player: attacker, entity: e });
    }
  };
}

/** Minimal fixture helper: grant ship deed/gold/hold items and port readiness without staging sea coordinates. */
function mpFixture(ctx) {
  ctx.services.townProperty = (town) => ({ status: 'ready', port: PORTS.some((p) => p.id === town) });
  ctx.onAction('fixture.setup', (p, { type, gold = 5000, level = 5 } = {}) => {
    p.rpg.location = PORT_A;
    p.x = 0; p.z = -40; p.yaw = 0;
    if (gold) p.rpg.gold = gold;
    if (level && p.rpg.character) p.rpg.character.level = level;
    if (type) p.rpg.property = { ...(p.rpg.property ?? {}), version: 0, ship: { type, boughtAt: 0 } };
  });
  ctx.onAction('fixture.hold', (p, { items }) => {
    const st = p.rpg.property ??= {};
    st.stores ??= {};
    st.stores.ship = items.map(([t, q]) => makeItem(t, q));
  });
  ctx.onAction('fixture.fillHold', (p) => {
    const st = p.rpg.property ??= {};
    st.stores ??= {};
    st.stores.ship = Array.from({ length: 250 }, () => makeItem('iron-dagger', 1));
  });
  ctx.onAction('fixture.fillPack', (p) => {
    while (p.rpg.inventory.length < 200) p.rpg.inventory.push(makeItem('iron-dagger', 1));
  });
  ctx.onAction('fixture.emptyPack', (p) => {
    p.rpg.inventory = p.rpg.inventory.filter((i) => i.template !== 'iron-dagger' || i.equipped);
  });
}

const pick = (names) => manifest.filter((f) => names.includes(f.name));
const FEATURES = ({ yard = true, withAdmiralty = false, navalOpts = {} } = {}) => [
  ...pick(['character', 'inventory', 'travel', 'property', 'social']),
  { name: 'combatStub', install: boardingCombatStub },
  { name: 'mpFixture', install: mpFixture },
  { name: 'sailing', install: (ctx) => sailing(ctx, { coast, loadCoast: false, seaCompression: 1 }) },
  ...(yard ? pick(['shipyard']) : []),
  { name: 'naval', install: (ctx) => naval(ctx, { spawn: false, sinkS: 1, scuttleS: 2, stateHz: 4, seed: 19, ...navalOpts }) },
  ...(withAdmiralty ? [{ name: 'admiralty', install: (ctx) => admiralty(ctx, { seaMs: 200, sweepMs: 200 }) }] : []),
];

async function makeWorld(t, opts = {}) {
  const tmp = tempDir('dfw-naval-mp-', '/var/tmp');
  const dbPath = join(tmp.dir, 'world.db');
  const world = await createFixtureWorld({ dbPath, features: FEATURES(opts) });
  t.after(() => { world.close(); tmp.remove(); });
  assert.deepEqual(world.installErrors, []);
  const tick = (ms, step = 100) => { for (let i = 0; i < ms; i += step) world.tick(step); };
  const must = (c, verb, args = {}) => { const r = c.act(verb, args); assert.ok(r.ok, `${verb}: ${r.error}`); return r; };
  const joinCaptain = (account, name, type = 'small') => {
    const c = world.connect(account, name);
    c.act('character.roll', { race: 'Breton', gender: 'Female', className: 'Warrior' });
    c.act('character.create', { race: 'Breton', gender: 'Female', className: 'Warrior' });
    must(c, 'fixture.setup', { type });
    return c;
  };
  const readWorldRows = (prefix) => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare('SELECT key, value FROM world_state WHERE key LIKE ?').all(`${prefix}%`)
        .map((r) => [r.key, JSON.parse(r.value)]);
    } finally {
      db.close();
    }
  };
  return { world, tick, must, joinCaptain, readWorldRows, dbPath };
}

/** Sail a vessel genuinely out of Port A (south along yaw=π) past the 600 m safe harbour boundary. */
function sailToOpenSea(fx, client, targetDist = 750) {
  const S = fx.world.ctx.services;
  const v = S.sailing.aboard(client.player);
  assert.ok(v, 'must be aboard to sail');
  if (v.anchored) fx.must(client, 'sailing.anchor', { down: false });
  fx.must(client, 'sailing.control', { sails: 1, oars: 1, rudder: 0 });
  const port = PORTS[0];
  for (let i = 0; i < 2400; i++) {
    fx.world.tick(250);
    if (Math.hypot(v.x - port.x, v.z - port.z) >= targetDist) break;
  }
  fx.must(client, 'sailing.control', { sails: 0, oars: 0, rudder: 0 });
  assert.ok(Math.hypot(v.x - port.x, v.z - port.z) >= targetDist, `vessel should have sailed past ${targetDist} m from port (at ${Math.round(Math.hypot(v.x - port.x, v.z - port.z))} m)`);
  return v;
}

/** Steer a vessel under its own sails/oars toward (tx, tz) until within `within` metres. */
function sailNear(fx, client, tx, tz, within = 90) {
  const S = fx.world.ctx.services;
  const v = S.sailing.aboard(client.player);
  if (v.anchored) fx.must(client, 'sailing.anchor', { down: false });
  for (let i = 0; i < 6000; i++) {
    const dx = tx - v.x, dz = tz - v.z;
    const d = Math.hypot(dx, dz);
    if (d <= within) break;
    const want = Math.atan2(dx, -dz);
    let err = want - v.yaw;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    const rudder = Math.max(-1, Math.min(1, err * 2));
    fx.must(client, 'sailing.control', { sails: d > 180 ? 1 : 0, oars: 1, rudder: Math.round(rudder * 20) / 20 });
    fx.world.tick(250);
  }
  fx.must(client, 'sailing.control', { sails: 0, oars: 0, rudder: 0 });
  for (let i = 0; i < 80 && Math.abs(v.speed) > 0.5; i++) fx.world.tick(250);
  assert.ok(Math.hypot(tx - v.x, tz - v.z) <= within + 25, `should sail near (${tx}, ${tz}), got dist ${Math.round(Math.hypot(tx - v.x, tz - v.z))}`);
}

/** Steer the vessel to bring a battery to bear on `target` and fire round shot until `stop()` returns true. */
function engageUntil(fx, client, targetId, stop, maxVolleys = 8) {
  const S = fx.world.ctx.services;
  const v = S.sailing.aboard(client.player);
  client.act('naval.load', { group: 'bow', shot: 'round' });
  fx.tick(6000);
  for (let k = 0; k < maxVolleys && !stop(); k++) {
    const t = S.naval.record(targetId);
    if (!t) break;
    // Turn bow directly toward the target under oars.
    for (let i = 0; i < 120; i++) {
      const want = Math.atan2(t.x - v.x, -(t.z - v.z));
      let err = want - v.yaw;
      while (err > Math.PI) err -= Math.PI * 2;
      while (err < -Math.PI) err += Math.PI * 2;
      if (Math.abs(err) < 0.08) break;
      fx.must(client, 'sailing.control', { sails: 0, oars: 1, rudder: Math.max(-1, Math.min(1, err * 3)) });
      fx.world.tick(200);
    }
    fx.must(client, 'sailing.control', { sails: 0, oars: 0, rudder: 0 });
    const r = client.act('naval.fire', { side: 'bow', targetId });
    if (!r.ok && /still loading/i.test(r.error)) {
      fx.tick(4000);
      client.act('naval.fire', { side: 'bow', targetId });
    }
    fx.tick(4000);
  }
}

describe('multiplayer naval combat, offline prize escrow & voyage integration', () => {
  test('unstaged open-sea PvP wreck -> loser disconnects -> offline prize escrow (shipyard goods) -> restart -> rejoin reconciliation -> harbour return', async (t) => {
    const fx = await makeWorld(t, { yard: true });
    const { world, tick, must, joinCaptain, readWorldRows } = fx;
    const S = () => world.ctx.services;

    const a = joinCaptain('mp-escrow-a', 'Anselm', 'large');
    const b = joinCaptain('mp-escrow-b', 'Brisienna', 'small');
    must(b, 'sailing.board');
    must(b, 'sailing.launch');

    // Load trade goods into Brisienna's shipyard hold and a private ruby into her classic item hold.
    const vB = S().sailing.aboard(b.player);
    const lb = S().shipyard.shipOfVessel(vB);
    S().shipyard.addCargo(lb.player, lb.shipId, [{ good: 'spices', qty: 6 }, { good: 'silk', qty: 4 }, { good: 'grain', qty: 18 }]);
    must(b, 'fixture.hold', { items: [['ruby', 3]] });
    const cargoUnits = (p, shipId) => S().shipyard.ship(p, shipId).cargo.reduce((n, c) => n + c.qty, 0);
    const bUnits0 = cargoUnits(lb.player, lb.shipId);
    assert.equal(bUnits0, 28);

    // Brisienna sails out of Port A first, then Anselm casts off and pursues into open sea (>600 m from port).
    sailToOpenSea(fx, b, 900);
    must(a, 'sailing.board');
    must(a, 'sailing.launch');
    const vA = S().sailing.aboard(a.player);
    const la = S().shipyard.shipOfVessel(vA);
    const aUnits0 = cargoUnits(la.player, la.shipId);
    sailToOpenSea(fx, a, 750);
    // Bring A within close broadside/bow range of B under its own helm.
    sailNear(fx, a, vB.x, vB.z - 60, 75);

    must(a, 'naval.colours', { hostile: true });
    must(b, 'naval.colours', { hostile: true });

    // Batter B down until she sinks and wrecks.
    S().naval.damage(vB, Math.max(0, vB.hull.hp - 15), 'shot');
    tick(100);
    engageUntil(fx, a, vB.id, () => vB.sunk, 10);
    assert.ok(vB.sunk, 'Brisienna is sunk and towed to port');
    assert.ok(vB.naval.wreck && !vB.naval.wreck.taken, 'wreck prize recorded');

    // Brisienna disconnects BEFORE Anselm claims the prize!
    b.leave();
    assert.equal(world.players.get(b.id), undefined, 'Brisienna is offline');
    const holdRowsBefore = readWorldRows('naval:hold:');
    assert.ok(holdRowsBefore.some(([k]) => k === `naval:hold:${vB.id}`), 'hold snapshot persisted in world_state');

    // Anselm sails over the wreck if needed and claims the prize while Brisienna is offline.
    sailNear(fx, a, vB.naval.wreck.x, vB.naval.wreck.z, 80);
    const mA = a.mark();
    must(a, 'naval.plunder', { targetId: vB.id });
    const aUnits1 = cargoUnits(a.player, la.shipId);
    const moved = aUnits1 - aUnits0;
    assert.ok(moved > 0 && moved <= 8, `Anselm received ${moved} escrowed cargo units`);
    const prizeEv = a.since(mA, 'gameEvent').map((x) => x.event).find((e) => e.kind === 'naval' && Array.isArray(e.prizeGoods));
    assert.ok(prizeEv && prizeEv.escrowed === true, 'victor notified of escrowed trade goods');

    // Duplicate claim refused immediately.
    const dup1 = a.act('naval.plunder', { targetId: vB.id });
    assert.equal(dup1.ok, false, 'duplicate plunder refused');

    // Escrow row persisted in world_state; hold snapshot cleared.
    const escrowRows = readWorldRows('naval:escrow:');
    assert.equal(escrowRows.length, 1, 'one escrow row persisted');
    assert.equal(escrowRows[0][1].ownerId, b.id);
    assert.equal(readWorldRows('naval:hold:').length, 0, 'hold snapshot cleared after claim');

    // Server restarts BEFORE Brisienna rejoins!
    world.restart();
    const a2 = world.connect('mp-escrow-a', 'Anselm');
    tick(200);
    assert.equal(cargoUnits(a2.player, la.shipId), aUnits1, 'victor cargo survives restart');
    assert.equal(a2.act('naval.plunder', { targetId: vB.id }).ok, false, 'still refused after restart');

    // Brisienna rejoins after restart -> escrow reconciles atomically!
    const b2 = world.connect('mp-escrow-b', 'Brisienna');
    tick(200);
    const bUnits1 = cargoUnits(b2.player, lb.shipId);
    assert.equal(bUnits0 - bUnits1, moved, 'loser hold debited by exact escrowed amount');
    assert.ok(S().shipyard.ship(b2.player, lb.shipId).cargo.every((c) => c.qty > 0), 'no zero or negative cargo lots');
    assert.deepEqual(
      b2.player.rpg.property.stores.ship.map((i) => [i.template, i.quantity]),
      [['ruby', 3]],
      'private item hold untouched when shipyard is installed',
    );
    const lostEv = b2.events('naval').find((e) => Array.isArray(e.lostGoods) && e.escrowed === true);
    assert.ok(lostEv, 'returning captain informed of escrowed cargo debit');
    assert.equal(readWorldRows('naval:escrow:').length, 0, 'escrow row deleted after reconciliation');

    // Second restart + rejoin: strictly idempotent (no second debit).
    world.restart();
    const b3 = world.connect('mp-escrow-b', 'Brisienna');
    tick(200);
    assert.equal(cargoUnits(b3.player, lb.shipId), bUnits1, 'idempotent: no second debit after restart');

    // Anselm sails into Port B, docks, and goes ashore.
    const a3 = world.connect('mp-escrow-a', 'Anselm');
    tick(200);
    must(a3, 'sailing.helm', { take: true });
    sailNear(fx, a3, PORTS[1].x, PORTS[1].z, 100);
    must(a3, 'sailing.dock');
    must(a3, 'sailing.leave');
    assert.equal(S().sailing.aboard(a3.player), null, 'Anselm is ashore at Port B');
    assert.equal(cargoUnits(a3.player, la.shipId), aUnits1, 'plundered cargo intact in harbour');
  });

  test('PvP surrender -> loser disconnects -> classic hold escrow with pack-full rollback and rejoin reconciliation', async (t) => {
    const fx = await makeWorld(t, { yard: false });
    const { world, tick, must, joinCaptain, readWorldRows } = fx;
    const S = () => world.ctx.services;

    const a = joinCaptain('mp-surr-a', 'Alaric', 'large');
    const b = joinCaptain('mp-surr-b', 'Bryn', 'small');
    must(b, 'sailing.board');
    must(b, 'sailing.launch');
    must(b, 'fixture.hold', { items: [['ebony-longsword', 1], ['iron-longsword', 1], ['iron-dagger', 1], ['iron-mace', 1]] });

    const vB = S().sailing.aboard(b.player);
    sailToOpenSea(fx, b, 900);
    must(a, 'sailing.board');
    must(a, 'sailing.launch');
    const vA = S().sailing.aboard(a.player);
    sailToOpenSea(fx, a, 750);
    sailNear(fx, a, vB.x, vB.z - 50, 55);

    must(a, 'naval.colours', { hostile: true });
    must(b, 'naval.colours', { hostile: true });

    // A hits B so B's lastHitBy is A's vessel, then B surrenders and disconnects before A grapples.
    engageUntil(fx, a, vB.id, () => S().naval.record(vB.id)?.lastHitBy === vA.id, 6);
    assert.equal(S().naval.record(vB.id).lastHitBy, vA.id, 'A registered a hit on B');
    must(b, 'naval.surrender');
    const holdB0 = structuredClone(b.player.rpg.property.stores.ship);
    b.leave();
    assert.equal(world.players.get(b.id), undefined, 'B is offline');

    // A closes within 32 m and grapples B's surrendered ship.
    sailNear(fx, a, vB.x, vB.z, 22);
    must(a, 'naval.grapple', { targetId: vB.id });

    // Fill A's ship hold AND pack so plunder fails and must roll back completely.
    must(a, 'fixture.fillHold');
    must(a, 'fixture.fillPack');
    const failRes = a.act('naval.plunder', { targetId: vB.id });
    assert.equal(failRes.ok, false, 'full hold + pack refuses plunder');
    assert.match(failRes.error, /pack cannot hold/i);
    assert.equal(readWorldRows('naval:escrow:').length, 0, 'rolled back: no escrow written');
    assert.equal(vB.naval.surrender.taken ?? false, false, 'rolled back: surrender not marked taken');

    // Empty A's pack and claim cleanly.
    must(a, 'fixture.emptyPack');
    const packBefore = a.player.rpg.inventory.length;
    must(a, 'naval.plunder', { targetId: vB.id });
    const gained = a.player.rpg.inventory.length - packBefore;
    assert.ok(gained >= 1 && gained < holdB0.length, `A gained ${gained} prize item(s)`);
    assert.equal(a.act('naval.plunder', { targetId: vB.id }).ok, false, 'second claim refused');

    // B rejoins -> classic hold reconciles cleanly without negative quantities.
    const b2 = world.connect('mp-surr-b', 'Bryn');
    tick(200);
    const holdB1 = b2.player.rpg.property.stores.ship ?? [];
    assert.equal(holdB0.length - holdB1.length, gained, 'loser hold lost exact count of prize items');
    assert.ok(holdB1.every((it) => (it.quantity ?? 1) >= 1), 'no negative quantities');
    assert.ok(b2.events('naval').some((e) => Array.isArray(e.lost) && e.escrowed === true), 'loser notified on rejoin');
    assert.equal(readWorldRows('naval:escrow:').length, 0, 'escrow cleared');
  });

  test('wreck claim survives server restart while loser is offline', async (t) => {
    const fx = await makeWorld(t, { yard: true });
    const { world, tick, must, joinCaptain } = fx;
    const S = () => world.ctx.services;

    const a = joinCaptain('mp-rw-a', 'Corin', 'large');
    const b = joinCaptain('mp-rw-b', 'Daria', 'small');
    must(b, 'sailing.board');
    must(b, 'sailing.launch');

    const vB = S().sailing.aboard(b.player);
    const lb = S().shipyard.shipOfVessel(vB);
    S().shipyard.addCargo(lb.player, lb.shipId, [{ good: 'spices', qty: 9 }]);

    sailToOpenSea(fx, b, 900);
    must(a, 'sailing.board');
    must(a, 'sailing.launch');
    const vA = S().sailing.aboard(a.player);
    sailToOpenSea(fx, a, 750);
    sailNear(fx, a, vB.x, vB.z - 50, 60);
    must(a, 'naval.colours', { hostile: true });
    must(b, 'naval.colours', { hostile: true });
    S().naval.damage(vB, Math.max(0, vB.hull.hp - 10), 'shot');
    tick(100);
    engageUntil(fx, a, vB.id, () => vB.sunk, 8);
    assert.ok(vB.sunk, 'Daria is wrecked');
    const wreckPos = { x: vB.naval.wreck.x, z: vB.naval.wreck.z };
    b.leave();
    a.leave();

    // Server restarts BEFORE Corin claims the wreck!
    world.restart();
    const a2 = world.connect('mp-rw-a', 'Corin');
    tick(200);
    must(a2, 'sailing.helm', { take: true });
    sailNear(fx, a2, wreckPos.x, wreckPos.z, 80);
    must(a2, 'naval.plunder', { targetId: vB.id });
    const la2 = S().shipyard.shipOfVessel(S().sailing.aboard(a2.player));
    const taken = S().shipyard.ship(la2.player, la2.shipId).cargo.reduce((n, c) => n + c.qty, 0);
    assert.ok(taken > 0, `Corin claimed ${taken} spices from wreck after restart`);

    // Daria rejoins and reconciles.
    const b2 = world.connect('mp-rw-b', 'Daria');
    tick(200);
    const left = S().shipyard.ship(b2.player, lb.shipId).cargo.reduce((n, c) => n + c.qty, 0);
    assert.equal(9 - left, taken, 'Daria reconciled exact spices lost after restart');
  });

  test('edge cases: party members aboard sinking ship return ashore (online & offline); disconnect mid-boarding and mid-repel', async (t) => {
    const fx = await makeWorld(t, { yard: false });
    const { world, tick, must, joinCaptain } = fx;
    const S = () => world.ctx.services;

    // 1. Party members aboard a sinking vessel (one online, one offline).
    const cap = joinCaptain('mp-edge-cap', 'Edric', 'large');
    const mate1 = joinCaptain('mp-edge-m1', 'Faye', null);
    const mate2 = joinCaptain('mp-edge-m2', 'Gavin', null);
    must(cap, 'party.invite', { targetId: mate1.id });
    must(mate1, 'party.accept', { fromId: cap.id });
    must(cap, 'party.invite', { targetId: mate2.id });
    must(mate2, 'party.accept', { fromId: cap.id });

    must(cap, 'sailing.board');
    const vCap = S().sailing.aboard(cap.player);
    must(mate1, 'sailing.board', { vesselId: vCap.id });
    must(mate2, 'sailing.board', { vesselId: vCap.id });
    must(cap, 'sailing.launch');
    sailToOpenSea(fx, cap, 800);

    // Mate 2 goes offline mid-voyage.
    mate2.leave();

    // Sink Captain Edric's ship.
    S().naval.damage(vCap, vCap.hull.max + 50, 'shot');
    tick(2500);
    assert.ok(vCap.sunk, 'Edric\'s ship sank');
    assert.equal(S().sailing.aboard(cap.player), null, 'captain returned ashore');
    assert.equal(S().sailing.aboard(mate1.player), null, 'online party member returned ashore');
    assert.ok(!S().property.isShipLocation(world.runtime.locationOf(mate1.player)), 'online mate is on land');
    assert.ok(mate1.events('sailing').some((e) => e.wrecked === true), 'online mate received wreck notice');

    // Offline party member rejoins -> safely ashore, not stranded on a deck, and removed from crewIds.
    const mate2Back = world.connect('mp-edge-m2', 'Gavin');
    tick(100);
    assert.equal(S().sailing.aboard(mate2Back.player), null, 'offline mate returned ashore on rejoin');
    assert.ok(!S().property.isShipLocation(world.runtime.locationOf(mate2Back.player)), 'offline mate is on land, not stranded on ship deck');
    assert.ok(!vCap.crewIds.includes(mate2Back.id), 'offline mate cleared from vessel crewIds');

    // 2. Solo captain disconnects mid-boarding -> foes banished and grapple cut immediately.
    const solo = joinCaptain('mp-edge-solo', 'Hilda', 'small');
    must(solo, 'sailing.board');
    must(solo, 'sailing.launch');
    const vSolo = sailToOpenSea(fx, solo, 900);
    const pid = S().naval.spawn('pirateSloop', vSolo.x + 15, vSolo.z, 0);
    const pirate = S().naval.record(pid);
    pirate.d.state = 'struck';
    pirate.speed = 0;
    must(solo, 'naval.grapple', { targetId: pid });
    must(solo, 'naval.board', { targetId: pid });
    const boardFoes = [...world.ctx.entities.values()].filter((e) => e.naval === `board:${pid}`);
    assert.ok(boardFoes.length >= 3, 'boarding foes spawned');
    solo.leave();
    assert.equal([...world.ctx.entities.values()].filter((e) => e.naval === `board:${pid}`).length, 0, 'boarding foes banished on disconnect');
    assert.equal(pirate.grappledTo, null, 'grapple cut when solo boarder disconnects');
    S().naval.despawn(pid);

    // 3. Party boarding continues when captain disconnects while party mate remains aboard to win.
    const cap2 = joinCaptain('mp-edge-c2', 'Ivar', 'large');
    const mate3 = joinCaptain('mp-edge-m3', 'Jora', null);
    must(cap2, 'party.invite', { targetId: mate3.id });
    must(mate3, 'party.accept', { fromId: cap2.id });
    must(cap2, 'sailing.board');
    const v2 = S().sailing.aboard(cap2.player);
    must(mate3, 'sailing.board', { vesselId: v2.id });
    must(cap2, 'sailing.launch');
    sailToOpenSea(fx, cap2, 750);
    const pid2 = S().naval.spawn('pirateSloop', v2.x + 15, v2.z, 0);
    const pirate2 = S().naval.record(pid2);
    pirate2.d.state = 'struck';
    pirate2.speed = 0;
    must(cap2, 'naval.grapple', { targetId: pid2 });
    must(cap2, 'naval.board', { targetId: pid2 });
    cap2.leave(); // captain disconnects mid-boarding, mate3 stays!
    const liveFoes = [...world.ctx.entities.values()].filter((e) => e.naval === `board:${pid2}`);
    assert.ok(liveFoes.length >= 3, 'boarding continues while party mate is still aboard');
    for (const f of liveFoes) S().damageEntity(mate3.player, f, 1000);
    tick(200);
    assert.equal(pirate2.prize, true, 'party mate won the boarding after captain disconnected');
    S().naval.despawn(pid2);
    mate3.leave();

    // 4. Disconnect mid-repel -> repel foes banished and grapple cut.
    const def = joinCaptain('mp-edge-def', 'Kael', 'small');
    must(def, 'sailing.board');
    must(def, 'sailing.launch');
    const vDef = S().sailing.aboard(def.player);
    sailNear(fx, def, 1500, 1750, 80);
    S().naval.damage(vDef, Math.floor(vDef.hull.max * 0.6), 'shot');
    const pid3 = S().naval.spawn('pirateBrig', vDef.x + 18, vDef.z, 0);
    const pirate3 = S().naval.record(pid3);
    pirate3.speed = 0;
    tick(1000);
    const repelFoes = [...world.ctx.entities.values()].filter((e) => e.naval === `repel:${pid3}`);
    assert.ok(repelFoes.length > 0, 'pirate sent repel party aboard');
    def.leave();
    assert.equal([...world.ctx.entities.values()].filter((e) => e.naval === `repel:${pid3}`).length, 0, 'repel foes banished on disconnect');
    assert.equal(pirate3.grappledTo, null, 'repel grapple cut on disconnect');
    S().naval.despawn(pid3);
  });

  test('admiralty bounty persistence: take bounty -> sail & sink quarry -> restart -> return to harbour -> claim purse (other holder voided)', async (t) => {
    const fx = await makeWorld(t, { yard: true, withAdmiralty: true });
    const { world, tick, must, joinCaptain } = fx;
    const S = () => world.ctx.services;

    const a = joinCaptain('mp-adm-a', 'Lydia', 'large');
    const b = joinCaptain('mp-adm-b', 'Marcus', 'small');

    // Both inspect the harbour board at Port A and take the same bounty offer.
    must(a, 'admiralty.board');
    const boardA = a.events('admiralty.state').at(-1).board;
    const bountyOffer = boardA.offers.find((o) => o.kind === 'bounty');
    assert.ok(bountyOffer, 'port board has a bounty offer');
    must(a, 'admiralty.take', { offerId: bountyOffer.id });
    must(b, 'admiralty.take', { offerId: bountyOffer.id });
    const cA = a.player.rpg.admiralty.contracts[0];
    assert.equal(cA.status, 'open');

    // Lydia boards, launches, loads bow round shot, and sails toward the quarry site.
    must(a, 'sailing.board');
    must(a, 'sailing.launch');
    must(a, 'naval.load', { group: 'bow', shot: 'round' });
    sailNear(fx, a, cA.quarry.x, cA.quarry.z, 500);
    tick(600);
    const qId = S().admiralty.quarryShip(bountyOffer.id);
    assert.ok(qId, 'admiralty spawned the bounty quarry when Lydia neared its waters');

    // Close on quarry and sink it.
    const qRec = S().naval.record(qId);
    qRec.d.hull = 1;
    qRec.speed = 0;
    sailNear(fx, a, qRec.x, qRec.z - 80, 95);
    engageUntil(fx, a, qId, () => a.player.rpg.admiralty.contracts[0].status === 'done', 8);
    tick(2500);
    assert.equal(a.player.rpg.admiralty.contracts[0].status, 'done', 'Lydia\'s bounty is marked done');

    // Server restarts while Lydia is still at sea and before Marcus checks his board.
    const goldBefore = a.player.rpg.gold;
    world.restart();

    const a2 = world.connect('mp-adm-a', 'Lydia');
    const b2 = world.connect('mp-adm-b', 'Marcus');
    tick(400);

    // Marcus's duplicate bounty is voided after restart because admiralty:quarry:<offer> persisted.
    assert.equal(b2.player.rpg.admiralty.contracts[0].status, 'void', 'second captain\'s bounty voided across restart');

    // Lydia sails back into Port A, docks, and claims her bounty purse.
    assert.equal(a2.player.rpg.admiralty.contracts[0].status, 'done', 'Lydia\'s done bounty persisted across restart');
    must(a2, 'sailing.helm', { take: true });
    sailNear(fx, a2, PORTS[0].x, PORTS[0].z, 100);
    must(a2, 'sailing.dock');
    must(a2, 'admiralty.claim', { contractId: cA.id });
    assert.equal(a2.player.rpg.gold, goldBefore + cA.pay, 'bounty purse paid after restart and harbour return');
    assert.ok((a2.player.rpg.admiralty.standing.Daggerfall ?? 0) > 0, 'crown standing awarded');
  });
});
