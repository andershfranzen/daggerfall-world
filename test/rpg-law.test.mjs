// Package 14: crime, the City Watch and the courts (server/rpg/law.js, server/rpg/law/rules.js).
// Real runtime transactions with the real inventory and npcs features; combat, the clock and the
// portal registry are small stand-ins so every roll is scripted.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installInventory } from '../server/rpg/inventory.js';
import { install as installNpcs } from '../server/rpg/npcs.js';
import { install as installLaw, CITY_WATCH } from '../server/rpg/law.js';
import { createPortalRegistry } from '../server/rpg/interiors/portals.js';
import {
  buildingLockValue, exteriorLockpickChance, goesToCourt, guiltyPlea, pickpocketChance, repLossFor, sentenceFor,
  sentenceRepair, shopliftCaughtChance, trial, defendChance,
} from '../server/rpg/law/rules.js';

const TOWN = 'town:Daggerfall/Gothway Garden';
const SHOP = 'interior:Daggerfall/Gothway Garden/0,0/3';
const WAYREST = 'town:Wayrest/Wayrest';

/** Scripted random: returns queued values, then 0.99. */
function dice() {
  const q = [];
  const r = () => (q.length ? q.shift() : 0.99);
  r.push = (...v) => q.push(...v);
  return r;
}

function stack({ minutes = 13 * 60, saved = new Map() } = {}) {
  const players = new Map();
  const sent = [];
  const saves = [];
  const random = dice();
  let now = 0;
  let clock = minutes;
  let failSave = false;
  const registry = createPortalRegistry();
  registry.register({
    id: 'b3', from: TOWN, to: SHOP, kind: 'building', label: 'The Silver Scales',
    entrances: [{ x: 10, z: 0, enter: { x: 0, z: 0, yaw: 0 }, exit: { x: 10, y: 6.5, z: 2, yaw: 0 } }],
    exits: [{ x: 0, z: 1 }], meta: { buildingType: 9, quality: 10, regionIndex: 17 },
  });
  const spawned = [];
  const stub = (ctx) => {
    Object.assign(ctx.services, {
      worldClock: () => ({ minutes: clock }),
      advanceSkill: () => null,
      spendTime: (p, m, reason) => {
        const from = clock + (p.rpg.spent ?? 0);
        p.rpg.spent = (p.rpg.spent ?? 0) + m;
        p.rpg.spentReason = reason;
        ctx.emit('timeSpent', { player: p, minutes: m, reason, from, to: from + m });
        return m;
      },
      guildRank: (p, g) => p.rpg.testGuilds?.[g] ?? null,
      portals: Object.assign(registry, {
        transfer(p, landing) {
          ctx.dirty(p);
          p.rpg.location = landing.location;
          p.x = landing.x;
          p.z = landing.z;
          ctx.notify(p, { kind: 'teleport', ...landing });
        },
      }),
      createEnemy(location, id, x, z, opts) {
        const e = { id: `monster-${spawned.length + 1}`, kind: 'monster', monsterId: id, name: 'City Watch', location, x, z, hp: 30, origin: opts.origin };
        ctx.entities.set(e.id, e);
        spawned.push(e);
        return e;
      },
    });
  };
  const runtime = createRpgRuntime({
    players,
    features: [
      { name: 'stub', install: stub },
      { name: 'inventory', install: installInventory },
      { name: 'npcs', install: installNpcs },
      { name: 'law', install: (ctx) => installLaw(ctx, { random, patrolMs: 1e12 }) },
    ],
    save: (list) => {
      if (failSave) {
        failSave = false;
        throw new Error('fixture save failure');
      }
      saves.push(list.map((p) => p.id));
      for (const p of list) saved.set(p.id, structuredClone(p.rpg));
    },
    send: (p, msg) => sent.push([p.id, msg]),
    now: () => now,
    log: { warn() {}, error() {} },
  });
  const join = (id, name, extra = {}) => {
    const p = { id, name, x: 0, z: 0, yaw: 0, rpg: { location: TOWN, character: { level: 3, skills: { Pickpocket: 40, Lockpicking: 60, Etiquette: 30, Streetwise: 30 }, attributes: { Personality: 50 } }, ...extra } };
    players.set(id, p);
    runtime.join(p);
    p.rpg.gold = 500;
    return p;
  };
  const events = (id, kind) => sent.filter(([pid, m]) => pid === id && m.type === 'gameEvent' && m.event.kind === kind).map(([, m]) => m.event);
  const tick = (ms) => { now += ms; runtime.tick(ms / 1000, now); };
  return { runtime, players, sent, saves, random, join, events, tick, spawned, registry,
    failSave: () => { failSave = true; }, saved,
    setClock: (m) => { clock = m; }, act: (p, verb, args) => runtime.act(p, verb, args) };
}

const townsperson = (s, id, x, z, extra = {}) => {
  const e = { id, kind: 'npc', role: 'townsfolk', mobile: true, name: `Resident ${id}`, location: TOWN, x, z, faction: null, ...extra };
  s.runtime.entities.set(id, e);
  return e;
};

describe('classic rules', () => {
  test('tables and chances follow the reference formulas', () => {
    assert.equal(repLossFor('murder'), 20);
    assert.equal(repLossFor('pickpocketing'), 2);
    assert.equal(sentenceRepair('murder'), 9);
    assert.equal(buildingLockValue(13), 6);
    assert.equal(exteriorLockpickChance(6, 20), 5);
    assert.equal(exteriorLockpickChance(2, 60), 50);
    assert.equal(pickpocketChance(120), 95);
    assert.equal(shopliftCaughtChance(40, 10, 3), 73);
    assert.equal(defendChance(-50, 30, 40), 5);
    assert.deepEqual(guiltyPlea({ fine: 120, days: 9 }), { fine: 60, days: 4 });
  });
  test('surrender: low reputation is beaten down, good reputation goes to court', () => {
    assert.equal(goesToCourt(-30, false, () => 0), false);
    assert.equal(goesToCourt(-30, true, () => 0), true);
    assert.equal(goesToCourt(5, false, () => 0.1), true);
    assert.equal(goesToCourt(-5, false, () => 0.1), false);
    assert.equal(goesToCourt(-5, true, () => 0.1), true);
  });
  test('sentence: penalty in 40-gold units of a fine or three days; unpaid fine becomes days', () => {
    // pickpocketing at rep 0: base 200 -> 5 units; alternate coin flips (two rolls for severity first).
    const seq = [0.99, 0.99, 0.1, 0.9, 0.1, 0.9, 0.1];
    const s = sentenceFor('pickpocketing', 0, 1000, () => seq.shift());
    assert.deepEqual(s, { severe: false, fine: 120, days: 6 });
    const seq2 = [0.99, 0.99, 0.1, 0.1, 0.1, 0.1, 0.1];
    assert.deepEqual(sentenceFor('pickpocketing', 0, 50, () => seq2.shift()), { severe: false, fine: 50, days: 3 });
  });
  test('trial: skill and personality can free the accused; otherwise the fine may change', () => {
    assert.equal(trial({ legalRep: 0, skill: 60, personality: 60, sentence: { fine: 80, days: 3 } }, () => 0.1).free, true);
    const r = trial({ legalRep: 0, skill: 0, personality: 0, sentence: { fine: 80, days: 3 } }, (() => { const q = [0.99, 0.1]; return () => q.shift(); })());
    assert.deepEqual([r.free, r.fine, r.days], [false, 160, 3]);
  });
});

describe('law in the runtime', () => {
  test('a caught pickpocket gets exactly one charge in the right region; the watch halts only the suspect', () => {
    const s = stack();
    const thief = s.join(1, 'Thief');
    const other = s.join(2, 'Bystander');
    townsperson(s, 'npc:m:a:1', 1, 0);
    s.random.push(0.99); // d100 = 100 > 40: caught
    assert.deepEqual(s.act(thief, 'law.pickpocket', { targetId: 'npc:m:a:1' }), { ok: true });
    const c = thief.rpg.law.charge;
    assert.equal(c.crime, 'pickpocketing');
    assert.equal(c.region, 'Daggerfall');
    assert.equal(other.rpg.law.charge, null, 'the bystander is not charged');
    assert.equal(s.spawned.length, 2, 'two watchmen dispatched outdoors');
    assert.ok(s.spawned.every((e) => e.monsterId === CITY_WATCH && e.hostile === false && e.lawSuspect === 1));
    // A second attempt on the same person is refused; nothing changes.
    assert.match(s.act(thief, 'law.pickpocket', { targetId: 'npc:m:a:1' }).error, /watching you/);
    // Another player cannot answer this charge.
    assert.match(s.act(other, 'law.surrender', { chargeId: c.id }).error, /no such case/);
    // Watchmen walk up (combat moves them to _home); bring one within halt range.
    s.spawned[0].x = 2; s.spawned[0].z = 0;
    s.tick(100);
    assert.equal(thief.rpg.law.charge.stage, 'halted');
    assert.equal(s.events(1, 'law.halt').length, 1);
    assert.equal(s.events(2, 'law.halt').length, 0);
    assert.equal(thief.rpg.law.rep.Daggerfall, -2, 'legal reputation lowered once at the halt');
    s.spawned[1].x = 1; s.spawned[1].z = 0;
    s.tick(100);
    assert.equal(s.events(1, 'law.halt').length, 1, 'the second watchman does not repeat the halt');
    assert.equal(thief.rpg.law.rep.Daggerfall, -2, 'not lowered again');
  });

  test('surrender, guilty plea, fine paid, verdict saved once; a replayed plea is refused', () => {
    const s = stack();
    const thief = s.join(1, 'Thief');
    townsperson(s, 'npc:m:a:1', 1, 0);
    s.random.push(0.99);
    s.act(thief, 'law.pickpocket', { targetId: 'npc:m:a:1' });
    s.spawned[0].x = 2;
    s.tick(100);
    const id = thief.rpg.law.charge.id;
    // Court: severity rolls (no), then 5 units: all fines -> 200 gold.
    s.random.push(0.99, 0.99, 0.1, 0.1, 0.1, 0.1, 0.1);
    assert.deepEqual(s.act(thief, 'law.surrender', { chargeId: id }), { ok: true });
    assert.equal(thief.rpg.law.charge.stage, 'court');
    assert.deepEqual(thief.rpg.law.charge.sentence, { severe: false, fine: 200, days: 0 });
    assert.equal([...s.runtime.entities.values()].filter((e) => e.kind === 'monster').length, 0, 'watchmen leave after the arrest');
    const before = thief.rpg.gold;
    assert.deepEqual(s.act(thief, 'law.plead', { chargeId: id, plea: 'guilty' }), { ok: true });
    assert.equal(thief.rpg.gold, before - 100, 'guilty plea halves the fine');
    assert.equal(thief.rpg.law.charge, null);
    assert.equal(thief.rpg.law.history.length, 1);
    assert.deepEqual({ ...thief.rpg.law.history[0], at: 0, id: 0 }, { id: 0, crime: 'pickpocketing', region: 'Daggerfall', verdict: 'guilty', fine: 100, days: 0, at: 0 });
    assert.equal(thief.rpg.law.rep.Daggerfall ?? 0, -2 + sentenceRepair('pickpocketing'));
    assert.equal(thief.rpg.spent, 240, 'release: four hours of the character’s own time');
    assert.match(s.act(thief, 'law.plead', { chargeId: id, plea: 'guilty' }).error, /no such case/);
    assert.equal(thief.rpg.law.history.length, 1, 'still one verdict');
  });

  test('not guilty: a failed defence goes to prison; days pass on the character’s ledger, not the world clock', () => {
    const s = stack();
    const thief = s.join(1, 'Thief');
    townsperson(s, 'npc:m:a:1', 1, 0);
    s.random.push(0.99);
    s.act(thief, 'law.pickpocket', { targetId: 'npc:m:a:1' });
    s.spawned[0].x = 2;
    s.tick(100);
    const id = thief.rpg.law.charge.id;
    s.random.push(0.99, 0.99, 0.9, 0.9, 0.9, 0.9, 0.9); // all prison: 15 days
    s.act(thief, 'law.surrender', { chargeId: id });
    s.act(thief, 'law.plead', { chargeId: id, plea: 'notGuilty' });
    assert.equal(thief.rpg.law.charge.stage, 'defence');
    s.random.push(0.99, 0.5); // fail (d100 100 > chance), fine roll neutral
    assert.deepEqual(s.act(thief, 'law.defend', { chargeId: id, method: 'lie' }), { ok: true });
    assert.deepEqual([thief.rpg.law.prison.days, thief.rpg.law.prison.left], [15, 15]);
    assert.match(s.act(thief, 'law.steal', {}).error, /prison/);
    thief.x = 50; // tries to walk away
    s.tick(300 * 5);
    assert.equal(thief.x, thief.rpg.law.prison.x, 'held in place');
    assert.equal(thief.rpg.law.prison.left, 10);
    s.tick(300 * 10);
    assert.equal(thief.rpg.law.prison, null);
    assert.equal(thief.rpg.spent, 15 * 1440 + 240);
    assert.equal(thief.rpg.spentReason, 'prison');
    assert.equal(s.events(1, 'law.released').length, 1);
  });

  test('jurisdiction: a charge in Daggerfall brings no watch in Wayrest; reputations are separate', () => {
    const s = stack();
    const thief = s.join(1, 'Thief');
    townsperson(s, 'npc:m:a:1', 1, 0);
    s.random.push(0.99);
    s.act(thief, 'law.pickpocket', { targetId: 'npc:m:a:1' });
    s.spawned[0].x = 2;
    s.tick(100);
    thief.rpg.location = WAYREST;
    s.tick(100);
    assert.equal([...s.runtime.entities.values()].filter((e) => e.kind === 'monster').length, 0, 'the Daggerfall watch gives up');
    assert.equal(s.runtime.ctx.services.law.wanted(thief, 'Wayrest'), null);
    assert.ok(s.runtime.ctx.services.law.wanted(thief, 'Daggerfall'));
    assert.equal(s.runtime.ctx.services.law.legalRep(thief, 'Wayrest'), 0);
    // A crime in Wayrest replaces the open charge (still one charge, new jurisdiction).
    s.runtime.entities.set('npc:m:w:1', { id: 'npc:m:w:1', kind: 'npc', role: 'townsfolk', mobile: true, name: 'Wayrest local', location: WAYREST, x: 1, z: 0 });
    s.random.push(0.99);
    s.act(thief, 'law.pickpocket', { targetId: 'npc:m:w:1' });
    assert.equal(thief.rpg.law.charge.region, 'Wayrest');
  });

  test('exterior lock: one attempt per skill level; success opens the door for entry override; tally emitted', () => {
    const s = stack({ minutes: 2 * 60 }); // 02:00, general store closed
    const thief = s.join(1, 'Thief');
    const tallies = [];
    s.runtime.ctx.on('crimeTally', (e) => tallies.push([e.player.id, e.thieving, e.amount]));
    thief.x = 10; thief.z = 0.5;
    const portal = s.registry.get(TOWN, 'b3');
    assert.equal(s.runtime.ctx.services.buildingEntryOverride(thief, portal), false);
    s.random.push(0.99); // roll 100: chance 60 - 25 = 35 fails
    s.act(thief, 'law.steal', {});
    assert.equal(s.events(1, 'law').at(-1).lockpick, 'failure');
    s.act(thief, 'law.steal', {});
    assert.match(s.events(1, 'law').at(-1).text, /beyond you/);
    thief.rpg.character.skills.Lockpicking = 70;
    s.random.push(0.1);
    s.act(thief, 'law.steal', {});
    assert.equal(s.events(1, 'law').at(-1).lockpick, 'success');
    assert.equal(s.runtime.ctx.services.buildingEntryOverride(thief, portal), true);
    assert.deepEqual(tallies, [[1, true, 1]]);
    // Open until the store's opening hour (06:00).
    s.setClock(5 * 60 + 59);
    assert.equal(s.runtime.ctx.services.buildingEntryOverride(thief, portal), true);
    s.setClock(6 * 60);
    assert.equal(s.runtime.ctx.services.buildingEntryOverride(thief, portal), false);
  });

  test('committed entry through a forced door: occupants make it trespassing, an empty building does not', async () => {
    const s = stack({ minutes: 2 * 60 });
    const thief = s.join(1, 'Thief');
    const crimes = [];
    s.runtime.ctx.on('crimeCommitted', (e) => crimes.push([e.crime, e.witnessed]));
    const portal = s.registry.get(TOWN, 'b3');
    s.runtime.ctx.services.law.openDoor(thief, portal, 'pick');
    s.runtime.ctx.dirty(thief);
    thief.rpg.location = SHOP;
    thief.rpg.portal = { returnTo: { location: TOWN, x: 10, z: 2, yaw: 0 } };
    s.runtime.ctx.emit('locationChanged', { player: thief, from: TOWN, to: SHOP, portal });
    assert.equal(thief.rpg.law.intrusion.location, SHOP);
    s.runtime.entities.set('npc:keeper', { id: 'npc:keeper', kind: 'npc', name: 'Keeper', location: SHOP, x: 0, z: 0, sourced: true });
    await new Promise((r) => setTimeout(r, 5));
    s.tick(1100);
    assert.deepEqual(crimes, [['trespassing', true]]);
    assert.equal(thief.rpg.law.charge.crime, 'trespassing');
    assert.ok(s.spawned.length >= 2 && s.spawned.length <= 5, 'indoors: two to five watchmen at the door');
    s.tick(100);
    assert.equal(thief.rpg.law.charge.stage, 'halted');
    assert.deepEqual(s.act(thief, 'law.surrender', { chargeId: thief.rpg.law.charge.id }), { ok: true });
    assert.deepEqual(s.events(1, 'teleport').at(-1), { kind: 'teleport', location: TOWN, x: 10, y: 6.5, z: 2, yaw: 0 });
    // A lawful visitor in opening hours is never charged.
    s.setClock(13 * 60);
    const visitor = s.join(2, 'Visitor');
    s.runtime.ctx.emit('locationChanged', { player: visitor, from: TOWN, to: SHOP, portal });
    assert.equal(visitor.rpg.law.intrusion, undefined);
  });

  test('shoplifting takes stock from the shared ledger; a caught thief is charged with theft', () => {
    const s = stack();
    const thief = s.join(1, 'Thief');
    thief.rpg.location = SHOP;
    s.runtime.entities.set('npc:keeper', { id: 'npc:keeper', kind: 'npc', name: 'Keeper', location: SHOP, x: 0, z: 0, sourced: true, shop: 'general' });
    assert.deepEqual(s.act(thief, 'law.steal', {}), { ok: true });
    const shelf = s.events(1, 'law.shelf').at(-1);
    assert.ok(shelf.items.length > 0);
    const item = shelf.items[0];
    const packBefore = thief.rpg.inventory.length;
    s.random.push(0.99); // d100 100 > caught chance: unseen
    assert.deepEqual(s.act(thief, 'law.shoplift', { key: item.key }), { ok: true });
    assert.equal(s.runtime.ctx.services.shopShelf(SHOP).items.find((i) => i.key === item.key).quantity, item.quantity - 1);
    assert.ok(thief.rpg.inventory.length >= packBefore);
    assert.equal(thief.rpg.law.charge, null);
    s.random.push(0.01); // caught
    const afterFirst = thief.rpg.inventory.length;
    s.act(thief, 'law.shoplift', { key: item.key });
    assert.equal(thief.rpg.law.charge.crime, 'theft');
    assert.equal(s.runtime.ctx.services.shopShelf(SHOP).items.find((i) => i.key === item.key).quantity, item.quantity - 1);
    assert.equal(thief.rpg.inventory.length, afterFirst);
  });

  test('murdering a townsperson removes them, tallies violence and charges murder; striking a watchman is assault', () => {
    const s = stack();
    const p = s.join(1, 'Brute');
    const victim = townsperson(s, 'npc:m:a:9', 1, 0);
    const tallies = [];
    s.runtime.ctx.on('crimeTally', (e) => tallies.push([e.thieving, e.amount]));
    const r = s.runtime.ctx.services.law.strikeTownsperson(p, victim, { weapon: 'dagger' });
    assert.deepEqual(r, { killed: true, crime: 'murder', weapon: 'dagger' });
    assert.equal(s.runtime.entities.has(victim.id), false);
    assert.deepEqual(tallies, [[false, 5]]);
    assert.equal(p.rpg.law.charge.crime, 'murder');
    const s2 = stack();
    const q = s2.join(1, 'Brute');
    const watch = townsperson(s2, 'npc:m:g:1', 1, 0, { role: 'guard', title: 'City Watch' });
    assert.equal(s2.runtime.ctx.services.law.strikeTownsperson(q, watch).crime, 'assault');
    assert.ok(s2.spawned.every((e) => e.hostile === true), 'the watch fights back at once');
    assert.equal(s2.spawned[0].x, 1, 'a knight takes the watchman’s place');
  });

  test('defeat by the watch: legal reputation above zero goes to court; other players are never targeted', () => {
    const s = stack();
    const thief = s.join(1, 'Thief');
    s.join(2, 'Bystander');
    townsperson(s, 'npc:m:a:1', 1, 0);
    s.random.push(0.99);
    s.act(thief, 'law.pickpocket', { targetId: 'npc:m:a:1' });
    s.spawned[0].x = 2;
    s.tick(100);
    const id = thief.rpg.law.charge.id;
    s.act(thief, 'law.resist', { chargeId: id });
    assert.ok(s.spawned.every((e) => e.hostile === true && e._targetId === 1));
    thief.rpg.law.rep.Daggerfall = 5;
    thief.rpg.defeated = true;
    s.random.push(0.99, 0.99, 0.1, 0.1, 0.1, 0.1, 0.1);
    s.runtime.ctx.emit('defeat', { player: thief, entity: s.spawned[0] });
    assert.equal(thief.rpg.law.charge.stage, 'court');
  });

  test('vagrancy from the rest feature and the legal reputation API', () => {
    const s = stack();
    const p = s.join(1, 'Sleeper');
    const law = s.runtime.ctx.services.law;
    s.runtime.ctx.services.reportCrime(p, 'vagrancy', { location: TOWN });
    assert.equal(p.rpg.law.charge.crime, 'vagrancy');
    assert.equal(law.changeLegalRep(p, 'Wayrest', 250, 'quest'), 100);
    assert.equal(law.legalRep(p, 'Wayrest'), 100);
    assert.equal(law.regionOf('interior:Wayrest/Wayrest/1,2/3'), 'Wayrest');
  });

  test('a saved warrant is pursued on reconnect only in its region; a worse offence charges only the difference', () => {
    const first = stack();
    const p = first.join(1, 'Suspect');
    const law = first.runtime.ctx.services.law;
    law.commit(p, 'pickpocketing');
    first.spawned[0].x = 1;
    first.spawned[0].z = 0;
    first.tick(100);
    assert.equal(p.rpg.law.rep.Daggerfall, -2);
    law.commit(p, 'murder');
    assert.equal(p.rpg.law.rep.Daggerfall, -20);
    assert.equal(first.spawned.length, 2);
    const saved = structuredClone(p.rpg);
    const next = stack();
    const q = next.join(1, 'Suspect', { ...saved, location: WAYREST });
    next.tick(100);
    assert.equal(next.spawned.length, 0);
    q.rpg.location = TOWN;
    next.tick(100);
    assert.equal(next.spawned.length, 2);
    next.spawned[0].x = 1;
    next.spawned[0].z = 0;
    next.tick(100);
    assert.equal(next.events(1, 'law.halt').at(-1).crime, 'murder');
    assert.equal(q.rpg.law.rep.Daggerfall, -20);
  });

  test('a witnessed failed bash is an attempt; a successful bash opens the shared door', () => {
    const s = stack({ minutes: 2 * 60 });
    const p = s.join(1, 'Burglar');
    p.x = 10;
    p.z = 2;
    const law = s.runtime.ctx.services.law;
    const portal = s.registry.get(TOWN, 'b3');
    s.random.push(0.99, 0.01);
    law.bashDoor(p, 'b3');
    assert.equal(p.rpg.law.charge.crime, 'attemptedBreakingAndEntering');
    assert.equal(law.doorOpen(portal), false);
    s.random.push(0.01, 0.99);
    law.bashDoor(p, 'b3');
    assert.equal(law.doorOpen(portal), true);
    assert.equal(s.runtime.ctx.services.buildingEntryOverride(s.join(2, 'Visitor'), portal), true);
    assert.equal(p.rpg.law.charge.crime, 'attemptedBreakingAndEntering');
    p.z = 8;
    assert.throws(() => law.bashDoor(p, 'b3'), /stand closer/);
  });

  test('a restored defence, sentence and release spend time exactly once across a failed save', () => {
    const before = stack();
    const p = before.join(1, 'Suspect');
    before.runtime.ctx.services.law.commit(p, 'pickpocketing');
    before.spawned[0].x = 1;
    before.spawned[0].z = 0;
    before.tick(100);
    const id = p.rpg.law.charge.id;
    before.act(p, 'law.surrender', { chargeId: id });
    before.act(p, 'law.plead', { chargeId: id, plea: 'notGuilty' });
    const after = stack();
    const q = after.join(1, 'Suspect', structuredClone(before.saved.get(1)));
    const other = after.join(2, 'Bystander');
    assert.equal(q.rpg.law.charge.stage, 'defence');
    assert.deepEqual(q.rpg.law.charge.sentence, p.rpg.law.charge.sentence);
    after.act(q, 'law.defend', { chargeId: id, method: 'lie' });
    const prison = stack();
    const prisoner = prison.join(1, 'Suspect', structuredClone(after.saved.get(1)));
    const term = prisoner.rpg.law.prison.days;
    const clock = prison.runtime.ctx.services.worldClock().minutes;
    prison.failSave();
    prison.tick(term * 300);
    assert.equal(prisoner.rpg.law.prison.left, term);
    assert.equal(prisoner.rpg.spent, undefined);
    assert.equal(prison.events(1, 'law.released').length, 0);
    prison.tick(300);
    assert.equal(prisoner.rpg.law.prison, null);
    assert.equal(prison.saved.get(1).spent, term * 1440 + 240);
    assert.equal(prison.saved.get(1).spentReason, 'prison');
    assert.equal(prison.saved.get(1).law.history.length, 1);
    assert.equal(prison.events(1, 'law.released').length, 1);
    assert.equal(prison.runtime.ctx.services.worldClock().minutes, clock);
    assert.equal(other.rpg.spent, undefined);
  });
});
