// Non-owner sea passage (server/rpg/passage.js) on the real runtime, inventory and travel features over a real SQLite
// file in a private temp directory.
//
// FIXTURE: `fixtureCore` (test/support/passage-fixture.mjs) is a TEST STAND-IN for the sailing core's narrow berth interface (services.sailing:
// charter/embark/setCourse/disembark/retire/byId/aboard/crewOf) and the geo owner's coast.ports(). It moves a vessel in a
// straight line purely so the passage's own rules can be exercised; it is not the production simulation. Port pixels
// are the classic starter towns' map pixels (client/gameplay/travel/classic.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createFixtureWorld, tempDir, readPersisted } from './support/rpg-session.mjs';
import { install as inventory } from '../server/rpg/inventory.js';
import { install as travel } from '../server/rpg/travel.js';
import { install as passage, passageFare, passageDestinations, passageWind, passagePixels } from '../server/rpg/passage.js';
import { passageActions, offerRow } from '../client/gameplay/sailing/passage.js';
import { tripCost } from '../client/gameplay/travel/journey.js';

import { DF, SE, WR, GP, PORTS, fixtureCore } from './support/passage-fixture.mjs';

async function makeWorld(t, opts) {
  const { dir } = tempDir('dfw-passage-');
  const dbPath = join(dir, 'world.db');
  const world = await createFixtureWorld({
    dbPath,
    features: [
      { name: 'inventory', install: inventory },
      { name: 'travel', install: travel },
      fixtureCore(opts),
      { name: 'passage', install: passage },
    ],
  });
  t.after(() => { world.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.deepEqual(world.installErrors, []);
  return { world, dbPath };
}

function joinAt(world, account, name, { gold = 0, location = DF } = {}) {
  const c = world.connect(account, name);
  Object.assign(c.player.rpg, { location, gold });
  world.tick(100);
  return c;
}
const last = (c, kind) => c.events(kind).at(-1);
const status = (c) => { c.must('passage.sync', {}); return last(c, 'passage.status'); };
let rid = 0;
const req = () => `req-${++rid}-${Date.now().toString(36)}`;

test('rules: classic fare, eight winds, nearest first, landfall and reach', () => {
  const df = PORTS[0], se = PORTS[1];
  assert.equal(passagePixels(df, se), 190);
  assert.equal(passageFare(df, se), tripCost(0, 190, { ship: true }).passage);
  assert.equal(passageFare(df, se), 25 * (Math.trunc(190 / 24) + 1));
  assert.equal(passageWind(df, se), 'south-east');
  assert.equal(passageWind(df, PORTS[3]), 'north'); // (-40, -104): nearer north than north-west
  const near = { id: 'town:X/Near', name: 'Near', px: 208, py: 214 };
  const d = passageDestinations([...PORTS, near], { ...df }, { reachable: (a, b) => b.id !== GP });
  assert.deepEqual(d.map((x) => x.port.id), [SE, WR]); // Glenpoint unreachable, Near within landfall, never here
  assert.equal(offerRow({ name: 'Sentinel', bearing: 'south-east', fare: 225 }), 'Sentinel - south-east, 225 gold');
});

test('book, ride, walk, reconnect, rejoin and disembark at the chosen port; personal deed untouched', async (t) => {
  const { world, dbPath } = await makeWorld(t);
  const a = joinAt(world, 1, 'Fare', { gold: 1000 });
  a.player.rpg.property = { ship: { type: 'small', at: 'deed' }, stores: { ship: [{ template: 'cargo', quantity: 3 }] } };
  const deed = JSON.stringify(a.player.rpg.property);

  a.must('passage.offer', {});
  const offer = last(a, 'passage.status');
  assert.equal(offer.here.id, DF);
  assert.deepEqual(offer.offers.map((o) => o.portId), [GP, SE, WR]);
  const se = offer.offers.find((o) => o.portId === SE);
  assert.equal(se.fare, 200);
  assert.deepEqual(passageActions(offer).map((x) => x.id), ['book']);

  // Denials change nothing.
  assert.match(a.act('passage.book', { toPortId: SE, expectFare: 1 }).error, /fare has changed to 200/);
  assert.match(a.act('passage.book', { toPortId: 'town:Nowhere/Nowhere' }).error, /no way there/);
  assert.equal(a.player.rpg.gold, 1000);

  const id = req();
  a.must('passage.book', { toPortId: SE, expectFare: 200, requestId: id });
  assert.equal(a.player.rpg.gold, 800);
  assert.match(a.act('passage.book', { toPortId: SE, expectFare: 200 }).error, /booked already/);
  a.must('passage.book', { toPortId: SE, expectFare: 200, requestId: id }); // replay: no second fare
  assert.equal(a.player.rpg.gold, 800);
  let s = status(a);
  assert.equal(s.voyage.to.id, SE);
  assert.equal(s.voyage.aboard, true);
  assert.equal(world.ctx.services.sailing.byId(s.voyage.vesselId).ownerId, null);
  assert.match(a.act('passage.disembark', {}).error, /not yet made Sentinel/);

  // Move about the deck: personal deck coordinates are the player's own.
  a.moveTo?.(3, -4);
  world.tick(2000);
  assert.match(a.act('passage.cancel', {}).error, /cast off/);

  // Reconnect mid-voyage.
  world.leave(a);
  const a2 = world.connect(1, 'Fare');
  world.tick(100);
  s = status(a2);
  assert.ok(s.voyage && s.voyage.present);
  a2.must('passage.rejoin', {});
  assert.equal(status(a2).voyage.aboard, true);

  // Restart mid-voyage: vessel and record survive.
  world.restart();
  const a3 = world.connect(1, 'Fare');
  world.tick(100);
  assert.equal(status(a3).voyage.to.id, SE);
  a3.must('passage.rejoin', {});

  for (let i = 0; i < 20 && status(a3).voyage?.state !== 'arrived'; i++) world.tick(1000);
  s = status(a3);
  assert.equal(s.voyage.state, 'arrived');
  assert.equal(s.voyage.docked, SE);
  assert.deepEqual(passageActions(s).map((x) => x.id), ['disembark']);
  a3.must('passage.disembark', { requestId: req() });
  assert.equal(a3.player.rpg.location, SE);
  assert.equal(status(a3).voyage, null);
  assert.equal(JSON.stringify(a3.player.rpg.property), deed);
  assert.equal(world.ctx.services.sailing.byId(s.voyage.vesselId), null); // empty charter retired
  world.flushPending();
  const saved = readPersisted(dbPath, a3.player.id);
  assert.equal(saved.rpg.location, SE);
  assert.equal(saved.rpg.passage.voyage, null);
  assert.equal(saved.rpg.gold, 800);
});

test('denials: no harbour, too poor, unreachable, core refusal rolls back, cancel refunds before sailing', async (t) => {
  const { world } = await makeWorld(t, { unreachable: [WR] });
  const poor = joinAt(world, 2, 'Poor', { gold: 10 });
  assert.match(poor.act('passage.book', { toPortId: SE }).error, /cannot afford the fare of 200/);
  assert.match(poor.act('passage.book', { toPortId: WR }).error, /no way there/);
  const inland = joinAt(world, 3, 'Inland', { gold: 999, location: 'town:Anticlere/Anticlere' });
  assert.match(inland.act('passage.offer', {}).error, /no harbour here/);

  const b = joinAt(world, 4, 'Early', { gold: 500 });
  world.ctx.services.sailing.setCourse = () => { throw new Error('Her master knows no way there by sea from here.'); };
  assert.match(b.act('passage.book', { toPortId: SE }).error, /no way there/);
  assert.equal(b.player.rpg.gold, 500);
  assert.equal(b.player.rpg.location, DF);
  assert.equal(status(b).voyage, null);
});

test('cancel before she casts off refunds the fare', async (t) => {
  const { world } = await makeWorld(t);
  const c = joinAt(world, 5, 'Cautious', { gold: 400 });
  // Hold her at the berth: course set but not yet sailed (no tick).
  c.must('passage.book', { toPortId: SE });
  assert.equal(c.player.rpg.gold, 200);
  c.must('passage.cancel', {});
  assert.equal(c.player.rpg.gold, 400);
  assert.equal(c.player.rpg.location, DF);
  assert.equal(status(c).voyage, null);
});

test('classic instant travel still works alongside passage', async (t) => {
  const { world } = await makeWorld(t);
  const d = joinAt(world, 6, 'Classic', { gold: 0 });
  d.must('travel.go', { to: SE, options: { speed: 'cautious', lodging: 'camp', ship: false } });
  assert.equal(d.player.rpg.location, SE);
});

test('no route found: the core drops her course, the passenger lands at the origin quay and is refunded', async (t) => {
  const { world } = await makeWorld(t);
  const e = joinAt(world, 7, 'Stranded', { gold: 500 });
  e.must('passage.book', { toPortId: SE });
  assert.equal(e.player.rpg.gold, 300);
  const vessel = world.ctx.services.sailing.byId(status(e).voyage.vesselId);
  vessel.course = null; // FIXTURE: what the core does before emitting
  world.ctx.emit('sailingCourseFailed', { vessel, port: SE });
  assert.equal(e.player.rpg.gold, 500);
  assert.equal(e.player.rpg.location, DF);
  assert.equal(status(e).voyage, null);
  assert.equal(world.ctx.services.sailing.byId(vessel.id), null);
  assert.match(last(e, 'passage').text, /no way to Sentinel/);
});
