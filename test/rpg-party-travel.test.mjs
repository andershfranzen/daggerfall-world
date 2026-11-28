// Party coordination tests: optional location sharing (coarse/exact/off + restricted areas),
// map pings, travel-to-leader fare/route quotes, expiring ready-check, atomic group travel commit,
// and rollback / proposal refresh on eligibility change, disconnect, or save failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as inventory from '../server/rpg/inventory.js';
import * as travel from '../server/rpg/travel.js';
import * as social from '../server/rpg/social.js';

const flush = () => new Promise((r) => setImmediate(r));

function makeWorld({ enemies = new Set(), protectedPvp = new Set(), clockStart = 10_000 } = {}) {
  let clock = clockStart;
  const players = new Map();
  const db = new Map();
  const sent = new Map();
  const saves = [];
  const timeSpent = [];
  let failNextSave = false;
  const quiet = { info() {}, warn() {}, error() {}, log() {} };

  const rt = createRpgRuntime({
    players,
    features: [inventory, travel, social],
    log: quiet,
    now: () => clock,
    services: {
      enemiesNearby: (p) => enemies.has(p.id),
      pvp: { isProtected: (p) => protectedPvp.has(p.id) },
      spendTime: (p, mins, reason) => timeSpent.push({ id: p.id, mins, reason }),
    },
    save(list) {
      if (failNextSave) {
        failNextSave = false;
        throw new Error('simulated save fault');
      }
      saves.push(list.map((p) => p.id).sort((a, b) => a - b));
      for (const p of list) db.set(p.id, structuredClone(p.rpg));
    },
    send(p, msg) {
      (sent.get(p.id) ?? sent.set(p.id, []).get(p.id)).push(msg);
    },
  });

  function join(id, name, { location = 'town:Daggerfall/Gothway Garden', gold = 500, x = 0, z = 0, rpg = {} } = {}) {
    const p = {
      id,
      name,
      accountId: `acct-${id}`,
      x,
      z,
      yaw: 0,
      moving: false,
      rpg: { location, gold, ...structuredClone(rpg) },
    };
    players.set(id, p);
    rt.join(p);
    // Inventory join gives starter gold if missing; enforce requested test purse.
    p.rpg.gold = gold;
    return p;
  }

  function leave(p) {
    rt.leave(p);
    players.delete(p.id);
  }

  const act = (p, verb, args = {}) => rt.act(p, verb, args);
  const ok = (p, verb, args = {}) => {
    const r = act(p, verb, args);
    assert.equal(r.error, undefined, `${verb} failed: ${r.error}`);
    return r;
  };
  const eventsOf = (p) => (sent.get(p.id) ?? []).filter((m) => m.type === 'gameEvent').map((m) => m.event);
  const socialOf = (p) => eventsOf(p).filter((e) => e.social).at(-1)?.social;
  const tick = (ms = 100) => {
    clock += ms;
    rt.tick(ms / 1000, clock);
  };
  const failSave = () => { failNextSave = true; };

  function formParty(leader, ...others) {
    for (const o of others) {
      ok(leader, 'party.invite', { targetId: o.id });
      ok(o, 'party.accept', { fromId: leader.id });
    }
  }

  return { rt, players, db, saves, timeSpent, join, leave, act, ok, eventsOf, socialOf, tick, failSave, formParty };
}

test('party location sharing defaults to coarse, supports exact pins, respects restricted/PvP zones, and isolates third accounts', () => {
  const protectedPvp = new Set();
  const w = makeWorld({ protectedPvp });
  const a = w.join(1, 'Ada', { x: 42, z: -18 });
  const b = w.join(2, 'Bram', { x: 10, z: 25 });
  const outsider = w.join(3, 'Outsider');

  w.formParty(a, b);

  // Coarse sharing by default: region + landmark, no exact coords.
  const bView1 = w.socialOf(b).party.members.find((m) => m.id === a.id);
  assert.equal(bView1.locationSharing.mode, 'coarse');
  assert.equal(bView1.locationSharing.region, 'Daggerfall');
  assert.equal(bView1.locationSharing.landmark, 'Gothway Garden');
  assert.equal(bView1.locationSharing.exact, null);

  // Ada opts in to exact pins -> Bram sees exact coordinates.
  w.ok(a, 'party.locationShare', { mode: 'exact' });
  const bView2 = w.socialOf(b).party.members.find((m) => m.id === a.id);
  assert.equal(bView2.locationSharing.mode, 'exact');
  assert.equal(bView2.locationSharing.exact.x, 42);
  assert.equal(bView2.locationSharing.exact.z, -18);

  // Protected PvP zone or interior suppresses exact pin automatically.
  protectedPvp.add(a.id);
  w.ok(b, 'social.sync');
  const bViewPvp = w.socialOf(b).party.members.find((m) => m.id === a.id);
  assert.equal(bViewPvp.locationSharing.restricted, true);
  assert.equal(bViewPvp.locationSharing.exact, null);
  protectedPvp.delete(a.id);

  // Map pings reach party members only, never outsiders, and expire on tick.
  w.ok(a, 'party.ping', { label: 'Tavern Gate', note: 'Regroup here' });
  assert.equal(w.socialOf(b).party.pings.length, 1);
  assert.equal(w.socialOf(b).party.pings[0].label, 'Tavern Gate');
  assert.equal(w.socialOf(b).party.pings[0].exact.x, 42);
  assert.equal(w.socialOf(outsider).party, null, 'third account receives neither party location nor pings');
  assert.equal(w.eventsOf(outsider).filter((e) => e.partyPing).length, 0);

  // Off mode hides location.
  w.ok(a, 'party.locationShare', { mode: 'off' });
  const bViewOff = w.socialOf(b).party.members.find((m) => m.id === a.id);
  assert.equal(bViewOff.locationSharing.shared, false);
  assert.equal(bViewOff.location, null);

  // Pings expire after TTL.
  w.tick(65_000);
  assert.equal(w.socialOf(b).party.pings.length, 0);
});

test('travel-to-leader quote and full atomic party journey commit fares, time, and relocation together', () => {
  const w = makeWorld();
  // Leader Ada is in Wayrest; Bram & Cyra are in Daggerfall/Gothway Garden.
  const a = w.join(1, 'Ada', { location: 'town:Wayrest/Wayrest', gold: 500 });
  const b = w.join(2, 'Bram', { location: 'town:Daggerfall/Gothway Garden', gold: 300 });
  const c = w.join(3, 'Cyra', { location: 'town:Daggerfall/Gothway Garden', gold: 300 });
  w.formParty(a, b, c);

  // Quote travel-to-leader using inns so fares are non-zero.
  w.ok(b, 'party.travelQuote', { options: { speed: 'cautious', lodging: 'inn', ship: false } });
  const quote = w.eventsOf(b).filter((e) => e.partyTravelQuote).at(-1).partyTravelQuote;
  assert.equal(quote.to, 'town:Wayrest/Wayrest');
  assert.equal(quote.mine.eligible, true);
  assert.ok(quote.mine.cost > 0, 'inn lodging produces a positive fare');
  assert.ok(quote.mine.days >= 1);

  // Propose group travel to leader's destination.
  w.ok(a, 'party.travelPropose', { options: { speed: 'cautious', lodging: 'inn', ship: false } });
  const prop = w.socialOf(b).party.travelProposal;
  assert.ok(prop);
  assert.equal(prop.to, 'town:Wayrest/Wayrest');
  assert.equal(prop.revision, 1);

  const bPart = prop.participants.find((x) => x.id === b.id);
  const cPart = prop.participants.find((x) => x.id === c.id);
  assert.ok(bPart.cost > 0 && cPart.cost > 0);

  // Bram confirms -> waiting on Cyra; nobody has paid or moved yet.
  w.ok(b, 'party.travelRespond', { proposalId: prop.id, revision: prop.revision, response: 'ready', expectCost: bPart.cost });
  assert.equal(b.rpg.location, 'town:Daggerfall/Gothway Garden');
  assert.equal(b.rpg.gold, 300);

  // Cyra confirms -> atomic group commit!
  w.saves.length = 0;
  w.ok(c, 'party.travelRespond', { proposalId: prop.id, revision: prop.revision, response: 'ready', expectCost: cPart.cost });

  assert.equal(b.rpg.location, 'town:Wayrest/Wayrest');
  assert.equal(c.rpg.location, 'town:Wayrest/Wayrest');
  assert.equal(b.rpg.gold, 300 - bPart.cost);
  assert.equal(c.rpg.gold, 300 - cPart.cost);
  assert.equal(a.rpg.gold, 500, 'leader already there pays nothing');
  assert.equal(w.socialOf(a).party.travelProposal, null, 'proposal cleared after commit');
  assert.deepEqual(w.saves, [[2, 3]], 'both travelling members saved in one atomic transaction');
  assert.deepEqual(w.timeSpent.map((t) => t.id).sort(), [2, 3]);
});

test('race with eligibility change and disconnect returns party to updated proposal; nobody pays or travels', () => {
  const enemies = new Set();
  const w = makeWorld({ enemies });
  const a = w.join(1, 'Ada', { location: 'town:Wayrest/Wayrest', gold: 500 });
  const b = w.join(2, 'Bram', { location: 'town:Daggerfall/Gothway Garden', gold: 300 });
  const c = w.join(3, 'Cyra', { location: 'town:Daggerfall/Gothway Garden', gold: 300 });
  w.formParty(a, b, c);

  w.ok(a, 'party.travelPropose', { options: { speed: 'cautious', lodging: 'inn', ship: false } });
  const prop1 = w.socialOf(b).party.travelProposal;
  w.ok(b, 'party.travelRespond', { proposalId: prop1.id, revision: prop1.revision, response: 'ready' });

  // Race: enemies appear beside Bram right before Cyra's final confirm!
  enemies.add(b.id);
  w.ok(c, 'party.travelRespond', { proposalId: prop1.id, revision: prop1.revision, response: 'ready' });

  // Nobody paid, nobody moved, and the party is returned to an updated proposal with reset confirmations!
  assert.equal(b.rpg.location, 'town:Daggerfall/Gothway Garden');
  assert.equal(c.rpg.location, 'town:Daggerfall/Gothway Garden');
  assert.equal(b.rpg.gold, 300);
  assert.equal(c.rpg.gold, 300);
  const prop2 = w.socialOf(c).party.travelProposal;
  assert.ok(prop2);
  assert.equal(prop2.revision, 2);
  assert.match(prop2.notice, /no longer eligible|Enemies nearby/i);
  assert.ok(prop2.participants.every((x) => !x.confirmed), 'confirmations reset on updated proposal');

  // Clear enemies and tick to refresh, then test disconnect mid ready-check.
  enemies.delete(b.id);
  w.tick(100);
  const prop3 = w.socialOf(c).party.travelProposal;
  assert.ok(prop3.revision >= 3);
  w.ok(a, 'party.travelRespond', { proposalId: prop3.id, revision: prop3.revision, response: 'ready' });
  w.ok(c, 'party.travelRespond', { proposalId: prop3.id, revision: prop3.revision, response: 'ready' });

  // Bram disconnects before confirming -> removed from proposal, confirmations reset, nobody travels!
  w.leave(b);
  assert.equal(c.rpg.location, 'town:Daggerfall/Gothway Garden');
  assert.equal(c.rpg.gold, 300);
  const prop4 = w.socialOf(c).party.travelProposal;
  assert.ok(prop4);
  assert.ok(prop4.revision > prop3.revision);
  assert.equal(prop4.participants.some((x) => x.id === b.id), false);
  assert.ok(prop4.participants.every((x) => !x.confirmed));
  assert.match(prop4.notice, /disconnected/);

  // Remaining members re-confirm updated proposal -> Cyra travels cleanly.
  w.ok(a, 'party.travelRespond', { proposalId: prop4.id, revision: prop4.revision, response: 'ready' });
  w.ok(c, 'party.travelRespond', { proposalId: prop4.id, revision: prop4.revision, response: 'ready' });
  assert.equal(c.rpg.location, 'town:Wayrest/Wayrest');
  assert.ok(c.rpg.gold < 300);
});

test('failed group commit (save error) rolls back every participant atomically; ready check also expires', async () => {
  const w = makeWorld();
  const a = w.join(1, 'Ada', { location: 'town:Wayrest/Wayrest', gold: 500 });
  const b = w.join(2, 'Bram', { location: 'town:Daggerfall/Gothway Garden', gold: 300 });
  const c = w.join(3, 'Cyra', { location: 'town:Daggerfall/Gothway Garden', gold: 300 });
  w.formParty(a, b, c);

  w.ok(a, 'party.travelPropose', { options: { speed: 'cautious', lodging: 'inn', ship: false } });
  const prop = w.socialOf(b).party.travelProposal;
  w.ok(b, 'party.travelRespond', { proposalId: prop.id, revision: prop.revision, response: 'ready' });

  // Inject save fault on the final confirming commit.
  w.failSave();
  const res = w.act(c, 'party.travelRespond', { proposalId: prop.id, revision: prop.revision, response: 'ready' });
  assert.match(res.error, /could not save/);
  await flush();

  // Nobody paid and nobody travelled; proposal is restored for retry or expiry.
  assert.equal(b.rpg.location, 'town:Daggerfall/Gothway Garden');
  assert.equal(c.rpg.location, 'town:Daggerfall/Gothway Garden');
  assert.equal(b.rpg.gold, 300);
  assert.equal(c.rpg.gold, 300);
  assert.ok(w.socialOf(c).party.travelProposal, 'proposal restored after failed save');

  // Expiry clears proposal and refuses late confirmation.
  w.tick(50_000);
  assert.equal(w.socialOf(c).party.travelProposal, null);
  assert.match(w.act(c, 'party.travelRespond', { proposalId: prop.id, revision: prop.revision, response: 'ready' }).error, /no active party travel/);
});
