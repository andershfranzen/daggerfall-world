// The law at sea (server/rpg/admiralty.js): piracy through the real court, regional notoriety and navy hostility,
// captain's standing and log, harbour boards (bounty, hunt, survey), the spyglass, idempotent receipts, two captains
// sharing a sea, rollback, expiry and a restart. Real runtime transactions with the real inventory, npcs and law
// features; sailing and naval are fixtures shaped like their contracts (/var/tmp/naval-dfw/contract.md).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installInventory } from '../server/rpg/inventory.js';
import { install as installNpcs } from '../server/rpg/npcs.js';
import { install as installLaw } from '../server/rpg/law.js';
import {
  install as installAdmiralty, boardFor, casksOf, HAUL_M, rankOf, NOTORIETY, NAVY_HUNTS, CONTRACTS_MAX, MINUTES_PER_DAY, normalize, knowledgeOf, KNOW,
} from '../server/rpg/admiralty.js';
import { readAdmiralty, readGlass, glassWords, readSea } from '../client/gameplay/sailing/admiralty.js';
import { repLossFor } from '../server/rpg/law/rules.js';

const SEA = 'sea:Iliac Bay';
const PORTS = [
  { id: 'town:Wayrest/Wayrest', name: 'Wayrest', region: 'Wayrest', x: 0, z: 0 },
  { id: 'town:Daggerfall/Daggerfall', name: 'Daggerfall', region: 'Daggerfall', x: 20_000, z: 0 },
];

function withCtx(opts = {}) {
  let ctx = null;
  const saved = opts.saved ?? new Map();
  const world = opts.world ?? new Map();
  const clock = opts.clock ?? { m: 10 * MINUTES_PER_DAY + 8 * 60 };
  const players = new Map();
  const sent = [];
  let now = 1000;
  let failSave = false;
  const vessels = new Map();
  let npcs = [];
  const saves = [];
  const runtime = createRpgRuntime({
    players,
    features: [
      { name: 'stub', install: (c) => { ctx = c; Object.assign(c.services, {
        worldClock: () => ({ minutes: clock.m }),
        advanceSkill: () => null,
        sailing: {
          ports: () => PORTS,
          vessels: () => [...vessels.values()],
          vesselFor: (p) => [...vessels.values()].find((v) => v.captain === p.id || v.crew.has(p.id)) ?? null,
          canCommand: (p, v) => v?.captain === p.id,
          isWater: () => true,
        },
        naval: { nearbyFor: (v, r = 1500) => npcs.filter((n) => Math.hypot(n.x - v.x, n.z - v.z) <= r), ...(opts.naval ?? {}) },
        ...(opts.shipyard ? { shipyard: opts.shipyard } : {}),
      }); } },
      { name: 'inventory', install: installInventory },
      { name: 'npcs', install: installNpcs },
      { name: 'law', install: (c) => installLaw(c, { patrolMs: 1e12, random: () => 0.99 }) },
      { name: 'admiralty', install: (c) => installAdmiralty(c, { sweepMs: 1000 }) },
      ...(opts.extra ?? []),
    ],
    save: (list, rows = []) => {
      if (failSave) { failSave = false; throw new Error('fixture save failure'); }
      saves.push(list.map((p) => p.id));
      for (const p of list) saved.set(p.id, structuredClone(p.rpg));
      for (const [k, v] of rows) { if (v == null) world.delete(k); else world.set(k, structuredClone(v)); }
    },
    worldStore: { load: (prefix) => [...world].filter(([k]) => k.startsWith(prefix)) },
    send: (p, msg) => sent.push([p.id, msg]),
    now: () => now,
    log: { warn() {}, error(...a) { console.error(...a); }, info() {} },
  });
  const join = (id) => {
    const fresh = !saved.has(id);
    const rpg = fresh ? { location: SEA, character: { level: 5, skills: {}, attributes: { Personality: 50 } } } : structuredClone(saved.get(id));
    const p = { id, name: id, x: 0, z: 0, yaw: 0, rpg };
    players.set(id, p);
    runtime.join(p);
    if (fresh) p.rpg.gold = 100;
    return p;
  };
  const ship = (id, captain, x, z, extra = {}) => { const v = { id, captain, x, z, mooredAt: null, crew: new Set(), ...extra }; vessels.set(id, v); return v; };
  const events = (id, kind) => sent.filter(([pid, m]) => pid === id && m.type === 'gameEvent' && m.event.kind === kind).map(([, m]) => m.event);
  return {
    runtime, players, saved, world, sent, saves, clock, join, ship, vessels, events,
    last: (id, kind) => events(id, kind).at(-1),
    tick: (ms) => { now += ms; runtime.tick(ms / 1000, now); },
    advance: (ms) => { now += ms; },
    setNpcs: (l) => { npcs = l; },
    emit: (name, payload) => ctx.emit(name, payload),
    ctx: () => ctx,
    act: (p, verb, args) => runtime.act(p, verb, args),
    failSave: () => { failSave = true; },
  };
}

const merchant = (n, x = 3000, z = 0, extra = {}) => ({ id: `npc:${n}`, uid: `npc:${n}@${n}00`, kind: 'npc', faction: 'merchant', classId: 'cog', hull: 'small', x, z, ...extra });
const pirate = (n, x = 3000, z = 0, extra = {}) => ({ id: `npc:${n}`, uid: `npc:${n}@${n}00`, kind: 'npc', faction: 'pirate', classId: 'sloop', hull: 'small', x, z, ...extra });
const navy = (n, x, z) => ({ id: `npc:${n}`, uid: `npc:${n}@${n}00`, kind: 'npc', faction: 'navy', classId: 'frigate', hull: 'galley', x, z });

describe('pure rules', () => {
  test('ranks, board determinism, glass knowledge, normalisation bounds', () => {
    assert.equal(rankOf(0).title, 'Unsworn');
    assert.equal(rankOf(50).title, 'Privateer');
    const port = { ...PORTS[0] };
    const a = boardFor({ port, day: 12, level: 5 });
    const b = boardFor({ port, day: 12, level: 5 });
    assert.deepEqual(a, b, 'same port and day, same board for every captain');
    assert.equal(a.length, 4);
    assert.deepEqual(new Set(a.map((o) => o.kind)), new Set(['bounty', 'hunt', 'survey', 'salvage']));
    const salvage = a.find((o) => o.kind === 'salvage');
    const c = { ...salvage, id: `${salvage.id}@x` };
    assert.equal(casksOf(c).length, salvage.need);
    assert.deepEqual(casksOf(c), casksOf({ ...c }), 'casks lie in the same places every time');
    for (const k of casksOf(c)) { const d = Math.hypot(k.x - c.wreck.x, k.z - c.wreck.z); assert.ok(d >= 39 && d <= 161, `cask ${d} m off`); }
    assert.notDeepEqual(boardFor({ port, day: 13, level: 5 }).map((o) => o.id), a.map((o) => o.id));
    assert.equal(knowledgeOf(0, { dist: 1000, held: 0.7 }), KNOW.colours);
    assert.equal(knowledgeOf(0, { dist: 1000, held: 2 }), KNOW.colours, 'too far to study');
    assert.equal(knowledgeOf(0, { dist: 800, held: 1.5 }), KNOW.studied);
    const n = normalize({ standing: { Wayrest: 5000, x: 'bad' }, notoriety: { Wayrest: -4, Daggerfall: 400 }, contracts: Array(9).fill({ id: 'a', kind: 'hunt', region: 'W', need: 99, done: -3, pay: -9999 }), receipts: Array(400).fill('r') });
    assert.equal(n.standing.Wayrest, 999);
    assert.equal(n.notoriety.Daggerfall, 100);
    assert.equal(n.notoriety.Wayrest, undefined);
    assert.equal(n.contracts.length, CONTRACTS_MAX);
    assert.equal(n.contracts[0].pay, 0);
    assert.equal(n.contracts[0].need, 10);
    assert.equal(n.receipts.length, 256);
  });
});

describe('piracy and notoriety', () => {
  test('first strike on a lawful ship charges piracy in that port region once; replays change nothing', () => {
    const s = withCtx();
    const p = s.join('cap');
    const v = s.ship('v1', 'cap', 2900, 0);
    const ev = { player: p, vessel: v, target: merchant(1), act: 'fire' };
    const r = s.ctx().runAtomic(p, 'naval.fire', () => s.emit('naval.fire', ev));
    assert.equal(r.ok, true);
    const a = s.saved.get('cap').admiralty;
    assert.equal(a.notoriety.Wayrest, NOTORIETY.fire);
    assert.equal(a.standing.Wayrest, -5);
    assert.equal(a.log.piracy, 1);
    assert.equal(s.saved.get('cap').law.charge.crime, 'piracy');
    assert.equal(s.saved.get('cap').law.charge.region, 'Wayrest');
    // Replay: the same event again, inside and outside an action.
    s.ctx().runAtomic(p, 'naval.fire', () => s.emit('naval.fire', ev));
    s.emit('naval.lawful', { ...ev, firstStrike: false });
    const b = s.saved.get('cap').admiralty;
    assert.equal(b.notoriety.Wayrest, NOTORIETY.fire);
    assert.equal(b.log.piracy, 1);
    assert.ok(s.events('cap', 'admiralty.news').some((e) => /Piracy!/.test(e.text)));
  });

  test('sinking lawful ships brings the navy; pirates never charge; waters are the nearest port region', () => {
    const s = withCtx();
    const p = s.join('cap');
    const v = s.ship('v1', 'cap', 19_000, 0);
    const adm = s.ctx().services.admiralty;
    const t = merchant(2, 19_500, 0);
    s.emit('naval.lawful', { player: p, vessel: v, target: t, act: 'fire' });
    assert.equal(adm.notoriety(p, 'Daggerfall'), 30);
    assert.equal(adm.hostileTo(p, navy(9, 25_000, 0)), true, 'a piracy warrant in Daggerfall turns its navy');
    assert.equal(adm.hostileTo(p, navy(9, 100, 0)), false, 'Wayrest has no quarrel');
    s.emit('naval.sunk', { player: p, target: t });
    assert.equal(adm.notoriety(p, 'Daggerfall'), 30 + NOTORIETY.sink);
    assert.ok(adm.notoriety(p, 'Daggerfall') >= NAVY_HUNTS);
    assert.equal(adm.stanceFor(p, navy(9, 25_000, 0)), 'hostile');
    assert.equal(adm.stanceFor(p, merchant(5, 100, 0)), 'safe');
    assert.equal(adm.stanceFor(p, pirate(6, 100, 0)), 'hostile');
    assert.equal(adm.stanceFor(p, { kind: 'player', faction: 'player', colours: 'peace' }), 'safe');
    // Notoriety decays twelve a game day.
    s.clock.m += MINUTES_PER_DAY;
    assert.equal(adm.notoriety(p, 'Daggerfall'), 50 - NOTORIETY.decayPerDay);
    // Firing on a pirate is no crime.
    s.emit('naval.lawful', { player: p, vessel: v, target: pirate(3, 19_500, 0), act: 'fire' });
    assert.equal(s.players.get('cap').rpg.admiralty.log.piracy, 1);
  });

  test('only the actor naval names is charged: never the captain for a mate, other accounts or player ships', () => {
    const s = withCtx();
    const cap = s.join('cap');
    const mate = s.join('mate');
    const other = s.join('other');
    const idle = s.join('idle'); // no ship at all
    const v = s.ship('v1', 'cap', 2900, 0);
    v.crew.add('mate');
    s.ship('v2', 'other', 3100, 0);
    s.emit('naval.lawful', { player: other, vessel: v, target: merchant(1), act: 'fire' }); // names a ship that is not theirs
    s.emit('naval.lawful', { player: idle, target: merchant(1), act: 'fire' }); // not at sea
    s.emit('naval.sunk', { player: idle, target: pirate(9) });
    s.emit('naval.sunk', { player: cap, vessel: v, target: { id: 'v2', uid: 'v2', kind: 'player', faction: 'player', ownerId: 'other', hull: 'small', x: 3100, z: 0 } });
    s.emit('naval.sunk', { player: { id: 'ghost', rpg: {} }, vessel: v, target: pirate(4) }); // not an online player
    // The mate's own hand (naval names the firer): the mate answers for it, not the captain.
    s.emit('naval.lawful', { player: mate, vessel: v, target: merchant(12), act: 'fire' });
    assert.equal(mate.rpg.admiralty.log.piracy, 1);
    assert.equal(mate.rpg.law.charge.crime, 'piracy');
    for (const p of [cap, other, idle]) {
      const a = p.rpg.admiralty;
      assert.equal(a.log.piracy, 0, p.id);
      assert.deepEqual(a.notoriety, {}, p.id);
      assert.deepEqual(a.standing, {}, p.id);
      assert.equal(p.rpg.law.charge ?? null, null, p.id);
    }
  });

  test('a pirate ended pays standing, legal repute and the knightly order', () => {
    const s = withCtx();
    const p = s.join('cap');
    const v = s.ship('v1', 'cap', 2900, 0);
    s.emit('naval.sunk', { player: p, target: pirate(7, 3000, 0, { hull: 'large' }) });
    s.emit('naval.repelled', { vessel: { ...v, ownerId: 'cap' }, by: pirate(8) }); // naval's shape: the owner is credited
    s.emit('naval.repelled', { vessel: { id: 'vx', ownerId: 'nobody' }, by: pirate(10) });
    const a = p.rpg.admiralty;
    assert.equal(a.standing.Wayrest, 2 * 4 + 2 * 2);
    assert.equal(a.log.sunk.pirate, 1);
    assert.equal(a.log.repelled, 1);
    assert.equal(p.rpg.law.rep.Wayrest, 2);
    assert.ok(s.saved.get('cap').admiralty.log.sunk.pirate === 1, 'tick-time deed saved through runAtomic');
  });
});

describe('naval ids and the navy', () => {
  test('ids without a uid are scoped to the server boot: replays dedupe, a restarted counter is a new ship', () => {
    const saved = new Map();
    const s1 = withCtx({ saved, extra: [] });
    const p = s1.join('cap');
    s1.ship('v1', 'cap', 2900, 0);
    const bare = { id: 'npc:1', kind: 'npc', faction: 'pirate', hull: 'sloop', x: 3000, z: 0 };
    s1.emit('naval.sunk', { player: p, target: bare });
    s1.emit('naval.sunk', { player: p, target: bare });
    assert.equal(p.rpg.admiralty.log.sunk.pirate, 1);
    const s2 = withCtx({ saved });
    const p2 = s2.join('cap');
    s2.ship('v1', 'cap', 2900, 0);
    s2.emit('naval.sunk', { player: p2, target: bare }); // naval restarted: npc:1 is another ship now
    assert.equal(p2.rpg.admiralty.log.sunk.pirate, 2);
  });

  test('seaLaw.wanted(vessel) answers naval: a hunted captain at the helm or owning the ship', () => {
    const s = withCtx();
    const p = s.join('cap');
    const v = s.ship('v1', 'cap', 19_000, 0, { ownerId: 'cap' });
    const law = s.ctx().services.seaLaw;
    assert.equal(law.wanted(v), false);
    s.emit('naval.lawful', { player: p, target: merchant(60, 19_400, 0), act: 'fire' });
    assert.equal(law.wanted(v), true, 'warrant in Daggerfall waters');
    assert.equal(law.wanted({ ...v, x: 0 }), false, 'not in Wayrest waters');
    assert.equal(law.wanted({ id: 'v9', ownerId: 'nobody', x: 19_000, z: 0 }), false);
  });
});

describe('harbour board', () => {
  const dock = (s, id) => { const v = s.ship(`v-${id}`, id, 100, 0, { mooredAt: 'town:Wayrest/Wayrest' }); return v; };

  test('the board is in port only, take is bounded, and a wanted pirate is refused', () => {
    const s = withCtx();
    const p = s.join('cap');
    const v = s.ship('v-cap', 'cap', 5000, 0);
    assert.match(s.act(p, 'admiralty.board', {}).error, /in port/);
    v.x = 100; v.mooredAt = 'town:Wayrest/Wayrest';
    assert.equal(s.act(p, 'admiralty.board', {}).ok, true);
    const st = readAdmiralty(s.last('cap', 'admiralty.state'));
    assert.equal(st.board.portName, 'Wayrest');
    assert.equal(st.board.offers.length, 4);
    for (const o of st.board.offers.slice(0, 3)) assert.equal(s.act(p, 'admiralty.take', { offerId: o.id }).ok, true);
    assert.match(s.act(p, 'admiralty.take', { offerId: st.board.offers[3].id }).error, /hold 3/);
    assert.match(s.act(p, 'admiralty.take', { offerId: st.board.offers[0].id }).error, /already taken/);
    assert.equal(p.rpg.admiralty.contracts.length, 3);
    assert.match(s.act(p, 'admiralty.take', { offerId: 'town:Wayrest/Wayrest#0#9' }).error, /no longer/);
    // Piracy in Wayrest waters: the board will not deal.
    const q = s.join('rogue');
    const rv = dock(s, 'rogue');
    s.emit('naval.lawful', { player: q, vessel: rv, target: merchant(11, 900, 0), act: 'fire' });
    s.act(q, 'admiralty.board', {});
    const rs = readAdmiralty(s.last('rogue', 'admiralty.state'));
    assert.match(rs.board.refused, /warrant/);
    assert.match(s.act(q, 'admiralty.take', { offerId: st.board.offers[0].id }).error, /warrant/);
  });

  test('one bounty, two captains: only the one who ends her is paid, once; the other is void', () => {
    const world = new Map();
    const saved = new Map();
    const s = withCtx({ world, saved });
    const a = s.join('alice');
    const b = s.join('bob');
    const va = dock(s, 'alice');
    const vb = dock(s, 'bob');
    s.act(a, 'admiralty.board', {});
    const offer = readAdmiralty(s.last('alice', 'admiralty.state')).board.offers.find((o) => o.kind === 'bounty');
    assert.ok(offer, 'a bounty is posted');
    assert.equal(s.act(a, 'admiralty.take', { offerId: offer.id }).ok, true);
    assert.equal(s.act(b, 'admiralty.take', { offerId: offer.id }).ok, true);
    const site = a.rpg.admiralty.contracts[0].quarry;
    // Bob's sinking of some other pirate far from the site is not the quarry.
    s.emit('naval.sunk', { player: b, vessel: vb, target: pirate(20, site.x + 5000, site.z) });
    assert.equal(b.rpg.admiralty.contracts[0].status, 'open');
    // Alice ends the quarry (by its key from naval's spawnQuarry), twice (replay).
    const quarry = pirate(21, site.x + 100, site.z, { quarry: offer.id });
    s.emit('naval.sunk', { player: a, vessel: va, target: quarry });
    s.emit('naval.sunk', { player: a, vessel: va, target: quarry });
    assert.equal(a.rpg.admiralty.contracts[0].status, 'done');
    assert.equal(world.get(`admiralty:quarry:${offer.id}`).by, 'alice');
    // Bob also "sinks" her later (a duplicate claim from another account): nothing.
    s.emit('naval.sunk', { player: b, vessel: vb, target: { ...quarry, uid: 'npc:21@other' } });
    s.tick(1500);
    assert.equal(b.rpg.admiralty.contracts[0].status, 'void');
    assert.match(s.act(b, 'admiralty.claim', { contractId: b.rpg.admiralty.contracts[0].id }).error, /nothing to claim/);
    const gold0 = a.rpg.gold;
    const cid = a.rpg.admiralty.contracts[0].id;
    // A failed save rolls the claim back entirely.
    s.failSave();
    assert.equal(s.act(a, 'admiralty.claim', { contractId: cid }).ok, false);
    assert.equal(a.rpg.gold, gold0);
    assert.equal(a.rpg.admiralty.contracts.length, 1);
    const ok = s.act(a, 'admiralty.claim', { contractId: cid });
    assert.equal(ok.ok, true);
    assert.equal(a.rpg.gold, gold0 + offer.pay);
    assert.equal(a.rpg.admiralty.log.contracts.bounty, 1);
    assert.match(s.act(a, 'admiralty.claim', { contractId: cid }).error, /no such contract/);
    assert.equal(a.rpg.gold, gold0 + offer.pay);
    // A third captain cannot take the ended bounty.
    const c = s.join('carol');
    dock(s, 'carol');
    assert.match(s.act(c, 'admiralty.take', { offerId: offer.id }).error, /already been ended/);
  });

  test('hunt counts pirates in its waters; expiry fails a contract; abandon costs a point', () => {
    const s = withCtx();
    const p = s.join('cap');
    const v = dock(s, 'cap');
    s.act(p, 'admiralty.board', {});
    const offers = readAdmiralty(s.last('cap', 'admiralty.state')).board.offers;
    const hunt = offers.find((o) => o.kind === 'hunt');
    const survey = offers.find((o) => o.kind === 'survey');
    s.act(p, 'admiralty.take', { offerId: hunt.id });
    s.act(p, 'admiralty.take', { offerId: survey.id });
    const h = p.rpg.admiralty.contracts.find((c) => c.kind === 'hunt');
    s.emit('naval.sunk', { player: p, target: pirate(30, 21_000, 0) }); // Daggerfall's waters
    assert.equal(h.done, 0);
    for (let i = 0; i < h.need; i++) s.emit('naval.boarded', { player: p, vessel: v, target: pirate(31 + i, 1000, 500) });
    assert.equal(h.status, 'done');
    // Survey left to run out.
    s.clock.m += 3 * MINUTES_PER_DAY;
    const standing = p.rpg.admiralty.standing.Wayrest;
    s.tick(1500);
    assert.equal(p.rpg.admiralty.contracts.some((c) => c.kind === 'survey'), false);
    assert.equal(p.rpg.admiralty.standing.Wayrest, standing - 3);
    assert.equal(p.rpg.admiralty.log.failed, 1);
    assert.equal(p.rpg.admiralty.contracts.find((c) => c.kind === 'hunt').status, 'done', 'a finished contract waits for its claim');
    assert.equal(s.act(p, 'admiralty.claim', { contractId: h.id }).ok, true);
    assert.match(s.act(p, 'admiralty.take', { offerId: offers.find((o) => o.kind === 'bounty').id }).error, /no longer/, 'yesterday\'s board is gone');
    s.act(p, 'admiralty.board', {});
    const bounty = readAdmiralty(s.last('cap', 'admiralty.state')).board.offers.find((o) => o.kind === 'bounty');
    assert.equal(s.act(p, 'admiralty.take', { offerId: bounty.id }).ok, true);
    const st = p.rpg.admiralty.standing.Wayrest;
    assert.equal(s.act(p, 'admiralty.abandon', { contractId: p.rpg.admiralty.contracts[0].id }).ok, true);
    assert.equal(p.rpg.admiralty.standing.Wayrest, st - 1);
    assert.equal(p.rpg.admiralty.contracts.length, 0);
    assert.match(s.act(p, 'admiralty.take', { offerId: bounty.id }).error, /already taken/, 'no re-taking an abandoned notice');
  });
});

describe('spyglass survey', () => {
  test('studied needs the hold near; each ship counts once; ships fired on and player ships never count', () => {
    const s = withCtx();
    const p = s.join('cap');
    const v = s.ship('v-cap', 'cap', 100, 0, { mooredAt: 'town:Wayrest/Wayrest' });
    s.act(p, 'admiralty.board', {});
    const survey = readAdmiralty(s.last('cap', 'admiralty.state')).board.offers.find((o) => o.kind === 'survey');
    s.act(p, 'admiralty.take', { offerId: survey.id });
    v.mooredAt = null;
    const c = p.rpg.admiralty.contracts[0];
    const ships = [
      { ...merchant(40, 900, 0), title: 'Cog', state: 'afloat', speed: 3, hullHp: 200, maxHull: 260, crew: 9, maxCrew: 16 },
      { ...merchant(41, 1500, 0), title: 'Far cog' },
      { ...merchant(42, 600, 0), title: 'Fired-on cog' },
      { id: 'v-bob', uid: 'v-bob', kind: 'player', faction: 'player', ownerId: 'bob', hull: 'small', x: 400, z: 0, colours: 'peace' },
    ];
    s.setNpcs(ships);
    const look = (id) => s.act(p, 'admiralty.glass', { targetId: id });
    // A held look on the near cog: hull, then colours, then studied.
    assert.equal(look('npc:40').ok, true);
    assert.equal(readGlass(s.last('cap', 'admiralty.glass')).know, 0);
    s.advance(700); look('npc:40');
    assert.equal(readGlass(s.last('cap', 'admiralty.glass')).know, 1);
    s.advance(800); look('npc:40');
    const g = readGlass(s.last('cap', 'admiralty.glass'));
    assert.equal(g.know, 2);
    assert.equal(g.stance, 'safe');
    assert.match(glassWords(g), /Hull 77%/);
    assert.equal(c.done, 1);
    s.advance(800); look('npc:40');
    assert.equal(c.done, 1, 'the same ship once');
    // Switching ships restarts the hold; the far one is never studied.
    look('npc:41'); s.advance(2000); look('npc:41');
    assert.equal(readGlass(s.last('cap', 'admiralty.glass')).know, 1);
    assert.equal(c.done, 1);
    // Fired on first: studying her does not count.
    s.emit('naval.lawful', { player: p, vessel: v, target: ships[2], act: 'fire' });
    look('npc:42'); s.advance(1500); look('npc:42');
    assert.equal(c.done, 1);
    // Another captain's ship: never counts.
    look('v-bob'); s.advance(1500); look('v-bob');
    assert.equal(c.done, 1);
    assert.match(look('npc:99').error, /No ship/);
    s.vessels.clear();
    assert.match(look('npc:40').error, /deck/);
  });
});

describe('persistence', () => {
  test('standing, notoriety, contracts, receipts and ended quarries survive a restart; replays after it do nothing', () => {
    const saved = new Map();
    const world = new Map();
    const clock = { m: 10 * MINUTES_PER_DAY + 8 * 60 };
    const s1 = withCtx({ saved, world, clock });
    const a = s1.join('alice');
    const va = s1.ship('va', 'alice', 100, 0, { mooredAt: 'town:Wayrest/Wayrest' });
    s1.act(a, 'admiralty.board', {});
    const offers = readAdmiralty(s1.last('alice', 'admiralty.state')).board.offers;
    const bounty = offers.find((o) => o.kind === 'bounty');
    s1.act(a, 'admiralty.take', { offerId: bounty.id });
    const site = a.rpg.admiralty.contracts[0].quarry;
    const q = pirate(50, site.x, site.z); // no quarry key: matched by the site (naval without spawnQuarry)
    s1.emit('naval.sunk', { player: a, vessel: va, target: q });
    s1.emit('naval.fire', { player: a, vessel: va, target: merchant(51, 300, 0), act: 'fire' });
    const before = structuredClone(saved.get('alice').admiralty);
    assert.equal(before.contracts[0].status, 'done');

    const s2 = withCtx({ saved, world, clock });
    const a2 = s2.join('alice');
    const va2 = s2.ship('va', 'alice', 100, 0, { mooredAt: 'town:Wayrest/Wayrest' });
    assert.deepEqual(a2.rpg.admiralty.standing, before.standing);
    assert.equal(a2.rpg.admiralty.contracts[0].status, 'done');
    s2.emit('naval.sunk', { player: a2, vessel: va2, target: q });
    s2.emit('naval.fire', { player: a2, vessel: va2, target: merchant(51, 300, 0), act: 'fire' });
    assert.deepEqual(a2.rpg.admiralty.standing, before.standing, 'replayed after restart: no double credit or charge');
    assert.equal(a2.rpg.admiralty.log.piracy, 1);
    const b2 = s2.join('bob');
    s2.ship('vb', 'bob', 100, 0, { mooredAt: 'town:Wayrest/Wayrest' });
    assert.match(s2.act(b2, 'admiralty.take', { offerId: bounty.id }).error, /already been ended/);
    const g = a2.rpg.gold;
    assert.equal(s2.act(a2, 'admiralty.claim', { contractId: a2.rpg.admiralty.contracts[0].id }).ok, true);
    assert.equal(a2.rpg.gold, g + bounty.pay);
  });
});

describe('quarry, salvage and flotsam (stub naval and shipyard)', () => {
  const dock = (s, id, extra = {}) => s.ship(`v-${id}`, id, 100, 0, { mooredAt: 'town:Wayrest/Wayrest', speed: 0, ownerId: id, ...extra });
  const takeKind = (s, p, kind) => {
    s.act(p, 'admiralty.board', {});
    const o = readAdmiralty(s.last(p.id, 'admiralty.state')).board.offers.find((x) => x.kind === kind);
    assert.equal(s.act(p, 'admiralty.take', { offerId: o.id }).ok, true);
    return { offer: o, c: p.rpg.admiralty.contracts.find((x) => x.offer === o.id) };
  };
  function navalStub() {
    const spawned = new Map(); // key -> id
    let n = 100;
    return {
      spawned,
      spawnQuarry: ({ key }) => { if (!spawned.has(key)) spawned.set(key, `npc:${n++}`); return spawned.get(key); },
    };
  }

  test('the quarry is put to sea only near her waters, is that very ship, and another pirate there pays nothing', () => {
    const nav = navalStub();
    const s = withCtx({ naval: nav });
    const a = s.join('alice');
    const va = dock(s, 'alice');
    const { offer, c } = takeKind(s, a, 'bounty');
    s.tick(1100);
    assert.equal(nav.spawned.size, 0, 'not while she lies in port, far off');
    va.mooredAt = null; va.x = c.quarry.x + 1000; va.z = c.quarry.z;
    s.tick(1100);
    const qid = nav.spawned.get(offer.id);
    assert.ok(qid, 'spawned once a holder nears her waters');
    const sea = readSea(s.last('alice', 'admiralty.sea'));
    assert.equal(sea.sites.find((x) => x.kind === 'bounty').shipId, qid);
    // A different pirate sunk right on her site is not her.
    s.emit('naval.sunk', { player: a, vessel: va.id, target: pirate(7, c.quarry.x, c.quarry.z) });
    assert.equal(c.status, 'open');
    // Her own end (target.quarry from naval) pays.
    s.emit('naval.sunk', { player: a, vessel: va.id, target: { ...pirate(8, c.quarry.x + 500, c.quarry.z), id: qid, quarry: offer.id } });
    assert.equal(c.status, 'done');
  });

  test('a quarry sunk by another captain without the notice, or by the navy, voids every holder', () => {
    const nav = navalStub();
    const s = withCtx({ naval: nav });
    const a = s.join('alice');
    const b = s.join('bob');
    const va = dock(s, 'alice');
    dock(s, 'bob');
    const { offer, c } = takeKind(s, a, 'bounty');
    va.mooredAt = null; va.x = c.quarry.x; va.z = c.quarry.z + 900;
    s.tick(1100);
    const qid = nav.spawned.get(offer.id);
    s.emit('naval.sunk', { player: b, vessel: 'v-bob', target: { ...pirate(9, c.quarry.x, c.quarry.z), id: qid } }); // id match, no quarry field
    assert.equal(s.world.get(`admiralty:quarry:${offer.id}`)?.by, 'bob');
    assert.deepEqual(b.rpg.admiralty.standing, { Wayrest: 2 * 2 }, 'bob is paid as for any pirate, not the bounty');
    s.tick(1100);
    assert.equal(a.rpg.admiralty.contracts[0].status, 'void');
  });

  test('salvage: casks show near the wreck, haul from your own deck, hove to, within reach, once each', () => {
    const s = withCtx();
    const a = s.join('alice');
    const b = s.join('bob');
    const va = dock(s, 'alice');
    const vb = dock(s, 'bob');
    const { c } = takeKind(s, a, 'salvage');
    const casks = casksOf(c);
    s.tick(1100);
    assert.equal(readSea(s.last('alice', 'admiralty.sea')).casks.length, 0, 'none in sight from port');
    assert.equal(readSea(s.last('alice', 'admiralty.sea')).sites[0].kind, 'salvage', 'the chart knows the site');
    va.mooredAt = null; va.x = casks[0].x + 10; va.z = casks[0].z;
    s.tick(1100);
    const sea = readSea(s.last('alice', 'admiralty.sea'));
    assert.equal(sea.casks.length, c.need);
    assert.equal(sea.casks.find((k) => k.id === casks[0].id).haul, true);
    va.speed = 4;
    assert.match(s.act(a, 'admiralty.haul', { caskId: casks[0].id }).error, /Heave to/);
    va.speed = 1;
    // Bob alongside cannot haul Alice's salvage, and sees none of it.
    vb.mooredAt = null; vb.x = va.x; vb.z = va.z;
    assert.match(s.act(b, 'admiralty.haul', { caskId: casks[0].id }).error, /not one of your salvage/);
    assert.equal(readSea(s.last('bob', 'admiralty.sea'))?.casks.length ?? 0, 0);
    for (const k of casks) {
      if (Math.hypot(k.x - va.x, k.z - va.z) > HAUL_M) assert.match(s.act(a, 'admiralty.haul', { caskId: k.id }).error, /out of reach/);
      va.x = k.x; va.z = k.z + 5;
      assert.equal(s.act(a, 'admiralty.haul', { caskId: k.id }).ok, true);
      assert.match(s.act(a, 'admiralty.haul', { caskId: k.id }).error, /not one of your|already aboard/);
    }
    const c2 = a.rpg.admiralty.contracts[0]; // a refused action restores state: read it afresh
    assert.equal(c2.status, 'done');
    assert.equal(c2.done, c2.need);
    assert.equal(a.rpg.admiralty.log.hauled, c2.need);
    assert.equal(s.saved.get('alice').admiralty.contracts[0].status, 'done', 'saved with the haul');
  });

  test('flotsam: a wreck leaves casks of goods; the owner hauls them into the hold once; full holds and others are refused', () => {
    const holds = new Map([['alice', []], ['bob', []]]);
    const room = new Map([['alice', 3], ['bob', 50]]);
    const shipyard = {
      shipOfVessel: (v) => ({ player: [...s.players.values()].find((p) => p.id === v.ownerId), shipId: `ship-${v.ownerId}` }),
      addCargo: (p, id, goods) => {
        let loaded = 0;
        for (const g of goods) { const n = Math.min(g.qty, room.get(p.id)); room.set(p.id, room.get(p.id) - n); loaded += n; if (n) holds.get(p.id).push({ good: g.good, qty: n }); }
        return { loaded, left: [] };
      },
    };
    const world = new Map();
    const saved = new Map();
    var s = withCtx({ shipyard, world, saved });
    const a = s.join('alice');
    const b = s.join('bob');
    const mate = s.join('mate');
    const va = s.ship('v-alice', 'alice', 3000, 0, { ownerId: 'alice', speed: 0 });
    va.crew.add('mate');
    const vb = s.ship('v-bob', 'bob', 3000, 0, { ownerId: 'bob', speed: 0 });
    s.emit('naval.sunk', { player: b, vessel: 'v-bob', target: merchant(70, 3020, 0) });
    s.emit('naval.sunk', { player: b, vessel: 'v-bob', target: merchant(70, 3020, 0) }); // replay: no second wreck
    s.tick(1100);
    const casks = readSea(s.last('alice', 'admiralty.sea')).casks.filter((k) => k.kind === 'wreck');
    assert.ok(casks.length >= 2 && casks.length <= 3, `${casks.length} casks`);
    assert.equal([...world.keys()].filter((k) => k.startsWith('admiralty:flotsam:')).length, casks.length, 'persisted');
    const k0 = casks[0];
    va.x = k0.x; va.z = k0.z;
    assert.match(s.act(mate, 'admiralty.haul', { caskId: k0.id }).error, /captain/);
    const r = s.act(a, 'admiralty.haul', { caskId: k0.id });
    assert.equal(r.ok, true, r.error);
    assert.ok(holds.get('alice').length === 1);
    // Bob alongside the same cask: gone, or what Alice's full hold left.
    vb.x = k0.x; vb.z = k0.z;
    const rb = s.act(b, 'admiralty.haul', { caskId: k0.id });
    const aliceGot = holds.get('alice')[0].qty;
    if (rb.ok) assert.equal(holds.get('bob')[0].qty + aliceGot, Number(/^(\d+)/.exec(k0.label)[1]), 'never more than the cask held');
    else assert.match(rb.error, /drifted/);
    // Restart: the rest of the flotsam is still there.
    const s2 = withCtx({ shipyard, world, saved });
    s = s2;
    const a2 = s2.join('alice');
    const va2 = s2.ship('v-alice', 'alice', casks[1].x, casks[1].z, { ownerId: 'alice', speed: 0 });
    s2.tick(1100);
    assert.ok(readSea(s2.last('alice', 'admiralty.sea')).casks.some((k) => k.id === casks[1].id));
    room.set('alice', 0);
    assert.match(s2.act(a2, 'admiralty.haul', { caskId: casks[1].id }).error, /hold is full/);
    room.set('alice', 50);
    assert.equal(s2.act(a2, 'admiralty.haul', { caskId: casks[1].id }).ok, true);
    // Two hours of game time: the rest drifts away and its rows go.
    s2.clock.m += 121;
    s2.tick(1100);
    assert.equal(readSea(s2.last('alice', 'admiralty.sea')).casks.filter((k) => k.kind === 'wreck').length, 0);
    void va2;
  });
});

// ------------------------------------------------------------------ with the real sailing core and naval combat
// FIXTURE world (in-process runtime, real SQLite under /var/tmp, real combat/sailing/naval/law with the installed
// classic data, invented test water): naval's own events drive the law at sea.
import { join as pathJoin } from 'node:path';
import { features as manifest } from '../server/rpg/features.js';
import { install as combatFeature } from '../server/rpg/combat.js';
import { install as sailingFeature } from '../server/rpg/sailing.js';
import { install as navalFeature } from '../server/rpg/naval.js';
import { createFixtureWorld, tempDir, localArena2 } from './support/rpg-session.mjs';

const arena2 = localArena2();
const WATER = [
  { id: 'town:Daggerfall/Daggerfall', name: 'Daggerfall', region: 'Daggerfall', x: 1000, z: 1000, yaw: Math.PI / 2, quay: { x: 0, z: -40, yaw: 0 } },
  { id: 'town:Wayrest/Wayrest', name: 'Wayrest', region: 'Wayrest', x: 9000, z: 1000, yaw: -Math.PI / 2, quay: { x: 0, z: 30, yaw: 0 } },
];
const coast = {
  status: 'ready', isWater: () => true, ports: () => WATER, portOf: (id) => WATER.find((p) => p.id === id) ?? null,
  nearestPort: (x, z) => WATER.map((port) => ({ port, distance: Math.hypot(port.x - x, port.z - z) })).sort((a, b) => a.distance - b.distance)[0],
};
function stage(ctx) {
  const S = ctx.services;
  ctx.onAction('fixture.deed', (p, { type }) => {
    p.rpg.location = WATER[0].id;
    p.rpg.property = { ...(p.rpg.property ?? {}), version: 0, ship: { type, boughtAt: 0 } };
    p.x = 0; p.z = -40;
  });
  ctx.onAction('fixture.place', (p, { x, z, yaw = 0 }) => {
    const v = S.sailing.aboard(p) ?? S.sailing.byId(`v${p.id}`);
    Object.assign(v, { x, z, yaw, speed: 0, anchored: true, sails: 0, oars: 0, rudder: 0, docked: null });
    S.sailing.save(v);
  });
}

describe('with real sailing and naval (fixture world)', { skip: !arena2 && 'installed classic data required' }, () => {
  test('a broadside into a merchantman is piracy in Daggerfall waters; a pirate sunk is credited once; the navy is told', async (t) => {
    const tmp = tempDir('dfw-admiralty-', '/var/tmp');
    const pick = (names) => manifest.filter((f) => names.includes(f.name));
    const world = await createFixtureWorld({
      dbPath: pathJoin(tmp.dir, 'world.db'), dataPath: arena2,
      features: [
        ...pick(['character', 'inventory', 'alchemy', 'travel', 'npcs', 'property', 'social']),
        { name: 'combat', install: (ctx) => combatFeature(ctx, { random: () => 0.18, classicSpawns: false }) },
        { name: 'sailing', install: (ctx) => sailingFeature(ctx, { coast, loadCoast: false }) },
        { name: 'naval', install: (ctx) => navalFeature(ctx, { spawn: false, sinkS: 1, scuttleS: 2, stateHz: 4, seed: 7 }) },
        ...pick(['law']),
        { name: 'admiralty', install: installAdmiralty },
        { name: 'fixture', install: stage },
      ],
    });
    t.after(() => { world.close(); tmp.remove(); });
    assert.deepEqual(world.installErrors, []);
    const S = world.ctx.services;
    const must = (c, verb, args = {}) => { const r = c.act(verb, args); assert.ok(r.ok, `${verb}: ${r.error}`); return r; };
    const tick = (ms, step = 40) => { for (let i = 0; i < ms; i += step) world.tick(step); };
    const a = world.connect('adm-a', 'Riona');
    a.act('character.create', { race: 'Breton', gender: 'Female', className: 'Warrior' });
    must(a, 'fixture.deed', { type: 'small' });
    must(a, 'sailing.board');
    must(a, 'sailing.launch');
    must(a, 'fixture.place', { x: 1000, z: 6000, yaw: 0 });
    const b = world.connect('adm-b', 'Bram'); // a second account nearby, not aboard
    b.act('character.create', { race: 'Breton', gender: 'Male', className: 'Warrior' });
    const vA = S.sailing.aboard(a.player);
    assert.ok(vA);
    assert.equal(S.seaLaw, S.admiralty, 'naval sees the law at sea and leaves piracy to it');

    const mid = S.naval.spawn('merchantGalleon', 1120, 6000, 0);
    must(a, 'naval.fire', { side: 'starboard', targetId: mid });
    tick(3000);
    const adm = a.player.rpg.admiralty;
    assert.equal(adm.log.piracy, 1);
    assert.equal(adm.notoriety.Daggerfall, NOTORIETY.fire);
    assert.equal(a.player.rpg.law.charge?.crime, 'piracy');
    assert.equal(a.player.rpg.law.charge?.region, 'Daggerfall');
    assert.equal(S.seaLaw.wanted(vA), true, 'a navy ship anywhere in Daggerfall waters now asks and is told');
    S.naval.despawn(mid);
    // More shots at a fresh merchant are a second ship; the same one again never is.
    tick(9500); // reload
    must(a, 'naval.fire', { side: 'starboard', targetId: S.naval.spawn('merchantGalleon', 1120, 6000, 0) });
    tick(3000);
    assert.equal(adm.log.piracy, 2);

    // A pirate sloop, nearly done, finished by our broadside.
    for (const r of [...(S.naval.actors?.() ?? [])]) S.naval.despawn(r.id);
    const pid = S.naval.spawn('pirateSloop', 1140, 6000, 0);
    const pr = S.naval.record(pid);
    pr.d.hull = 1;
    const standing = adm.standing.Daggerfall ?? 0;
    tick(9500); // reload
    Object.assign(pr, { x: vA.x + 120, z: vA.z, speed: 0 });
    if (pr.ai) { pr.ai.next = 99; pr.ai.sails = 0; }
    must(a, 'naval.fire', { side: 'starboard', targetId: pid });
    tick(4000);
    assert.equal(adm.log.sunk.pirate, 1, `pirate state ${pr.d.state}`);
    assert.equal(adm.standing.Daggerfall, standing + 2 * 1);
    assert.deepEqual(b.player.rpg.admiralty?.standing ?? {}, {}, 'the account nearby is neither credited nor charged');
    assert.equal(b.player.rpg.law?.charge ?? null, null);
    assert.ok(a.events('admiralty.state').length > 0);
  });
});

describe('quarry, salvage and wreck flotsam with real sailing, shipyard and naval (fixture world)', { skip: !arena2 && 'installed classic data required' }, () => {
  test('the quarry spawns near her waters, survives a restart, a decoy pirate pays nothing; salvage and flotsam are hauled once', async (t) => {
    const tmp = tempDir('dfw-admiralty-sea-', '/var/tmp');
    const pick = (names) => manifest.filter((f) => names.includes(f.name));
    const world = await createFixtureWorld({
      dbPath: pathJoin(tmp.dir, 'world.db'), dataPath: arena2,
      features: [
        ...pick(['character', 'inventory', 'alchemy', 'travel', 'npcs', 'property', 'social']),
        { name: 'combat', install: (ctx) => combatFeature(ctx, { random: () => 0.18, classicSpawns: false }) },
        { name: 'sailing', install: (ctx) => sailingFeature(ctx, { coast, loadCoast: false }) },
        ...pick(['shipyard']),
        { name: 'naval', install: (ctx) => navalFeature(ctx, { spawn: false, sinkS: 1, scuttleS: 2, stateHz: 4, seed: 7 }) },
        ...pick(['law']),
        { name: 'admiralty', install: (ctx) => installAdmiralty(ctx, { seaMs: 200 }) },
        { name: 'fixture', install: stage },
      ],
    });
    t.after(() => { world.close(); tmp.remove(); });
    assert.deepEqual(world.installErrors, []);
    const S = () => world.ctx.services;
    const must = (c, verb, args = {}) => { const r = c.act(verb, args); assert.ok(r.ok, `${verb}: ${r.error}`); return r; };
    const tick = (ms, step = 40) => { for (let i = 0; i < ms; i += step) world.tick(step); };
    const sea = (c) => readSea(c.events('admiralty.sea').at(-1));

    let a = world.connect('sea-a', 'Ysolde');
    a.act('character.create', { race: 'Breton', gender: 'Female', className: 'Warrior' });
    must(a, 'fixture.deed', { type: 'small' });
    must(a, 'sailing.board');
    must(a, 'sailing.launch');
    must(a, 'admiralty.board');
    const board = readAdmiralty(a.events('admiralty.state').at(-1)).board;
    assert.equal(board.portName, 'Daggerfall', 'the board of the port she lies docked at');
    const bounty = board.offers.find((o) => o.kind === 'bounty');
    const salvage = board.offers.find((o) => o.kind === 'salvage');
    must(a, 'admiralty.take', { offerId: bounty.id });
    must(a, 'admiralty.take', { offerId: salvage.id });
    const q = () => a.player.rpg.admiralty.contracts.find((c) => c.kind === 'bounty');

    // Far off, nothing; within QUARRY_SPAWN_M of her waters, naval's own quarry puts to sea.
    tick(400);
    assert.equal(S().admiralty.quarryShip(bounty.id), null);
    must(a, 'fixture.place', { x: q().quarry.x - 1200, z: q().quarry.z, yaw: Math.PI / 2 });
    tick(400);
    const first = S().admiralty.quarryShip(bounty.id);
    assert.ok(first && S().naval.record(first)?.quarry === bounty.id, 'the quarry is at sea');
    assert.match(S().naval.record(first).title, /the /);

    // Restart: the contract is kept; naval forgot her, so she is put to sea again for the holder.
    world.restart();
    a = world.connect('sea-a', 'Ysolde');
    if (!S().sailing.aboard(a.player)) must(a, 'sailing.board');
    tick(400);
    const again = S().admiralty.quarryShip(bounty.id);
    assert.ok(again && S().naval.record(again)?.quarry === bounty.id, 'the quarry is back after the restart');
    assert.equal(q().status, 'open');
    const vA = S().sailing.aboard(a.player);

    const sinkAlongside = (id) => {
      must(a, 'fixture.place', { x: vA.x, z: vA.z, yaw: 0 }); // bow north: the starboard battery bears east
      const r = S().naval.record(id);
      Object.assign(r, { x: vA.x + 120, z: vA.z, speed: 0, yaw: 0 });
      if (r.ai) { r.ai.next = 1e9; r.ai.sails = 0; r.ai.mode = 'route'; }
      r.d.hull = 1;
      tick(16000); // the battery reloads (a thin crew is slower)
      Object.assign(r, { x: vA.x + 120, z: vA.z, speed: 0 });
      must(a, 'naval.fire', { side: 'starboard', targetId: id });
      tick(4000);
      return r;
    };
    // A decoy: another pirate in her very waters.
    const decoy = sinkAlongside(S().naval.spawn('pirateBrig', vA.x + 120, vA.z, 0));
    assert.notEqual(decoy.d.state, 'afloat', 'the decoy went down');
    assert.equal(q().status, 'open', 'a different pirate does not pay the bounty');
    assert.equal(a.player.rpg.admiralty.log.sunk.pirate, 1);
    // The quarry herself.
    const her = sinkAlongside(again);
    assert.notEqual(her.d.state, 'afloat');
    assert.equal(q().status, 'done', 'her end pays the bounty');
    assert.equal(world.ctx.loadWorld(`admiralty:quarry:${bounty.id}`).length, 1, 'ended for everybody, on disk');

    // Salvage: casks about her wreck, hauled from the deck, hove to.
    const sc = () => a.player.rpg.admiralty.contracts.find((c) => c.kind === 'salvage');
    const casks = casksOf(sc());
    const b = world.connect('sea-b', 'Brann');
    b.act('character.create', { race: 'Breton', gender: 'Male', className: 'Warrior' });
    for (const k of casks) {
      must(a, 'fixture.place', { x: k.x, z: k.z + 8, yaw: 0 });
      tick(400);
      assert.ok(sea(a).casks.some((x) => x.id === k.id && x.haul), 'the cask is in reach on deck');
      assert.equal(b.act('admiralty.haul', { caskId: k.id }).ok, false, 'another account cannot haul it');
      must(a, 'admiralty.haul', { caskId: k.id });
      assert.equal(a.act('admiralty.haul', { caskId: k.id }).ok, false, 'once');
    }
    assert.equal(sc().status, 'done');

    // An ordinary wreck: a coaster sunk alongside leaves flotsam; its goods go into the real shipyard hold.
    const cargoOf = () => (a.player.rpg.shipyard?.ships ?? []).flatMap((s) => s.cargo ?? []).reduce((n, c) => n + c.qty, 0);
    const before = cargoOf();
    sinkAlongside(S().naval.spawn('merchantCoaster', vA.x + 120, vA.z, 0));
    tick(400);
    const flot = sea(a).casks.filter((x) => x.kind === 'wreck');
    assert.ok(flot.length >= 2, `flotsam ${flot.length}`);
    const f0 = flot[0];
    const n0 = Number(/^(\d+)/.exec(f0.label)[1]);
    must(a, 'fixture.place', { x: f0.x, z: f0.z + 5, yaw: 0 });
    tick(400);
    must(a, 'admiralty.haul', { caskId: f0.id });
    assert.equal(cargoOf(), before + n0, 'the goods are in the hold');
    assert.equal(a.act('admiralty.haul', { caskId: f0.id }).ok, false, 'the cask is gone');
    assert.equal(world.ctx.loadWorld(`admiralty:flotsam:${f0.id}`).length, 0);
    assert.ok(world.ctx.loadWorld('admiralty:flotsam:').length >= 1, 'the rest float on, on disk');
    console.log(`[evidence] quarry ${first} -> ${again} after restart; decoy ${decoy.id} unpaid; salvage ${casks.length} casks; flotsam ${flot.length} casks, ${n0} goods hauled`);
  });
});
