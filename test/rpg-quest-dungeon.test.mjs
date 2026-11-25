// Dungeon and story quests on the production feature manifest and the operator's ARENA2.
//
//   K0C00Y08 "A Rare Book" (brief I): a source merchant (server/rpg/npcs questGroup 'Merchants') offers the
//   original QRC text; the remote dungeon is picked by Place.SelectRemoteDungeonSite rules and revealed on the
//   travel map; the book lies on a stable RDB quest item marker (services.interiors.questMarkers).
//   S0000008 -> S0000016 (Mantellan Crux): LATE-STAGE FIXTURE. The test starts S0000008 through the operator entry
//   (services.quests.start) and supplies positions as it exercises the Gothryd delivery and return from the Crux.
//
// Positions inside instances are set by the fixture (labelled below); the browser scenario walks them for real.
// Requires gamedata/…/arena2; skipped without it (RPG_INTEGRATION_STRICT=1 makes that a failure).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverFeatures, createFixtureWorld, readPersisted, tempDir, STRICT, localArena2, featuresWithQuestCatalog,
} from './support/rpg-session.mjs';
import { PERMANENT_PLACES } from '../server/rpg/quests/tables.js';
import { MANTELLAN } from '../client/world/interiors/dungeonAccess.js';
import { LYSANDUS_TOMB } from '../server/rpg/campaign/sites.js';

const ARENA2 = localArena2();
const gate = ARENA2 ? {} : STRICT ? {} : { skip: 'operator ARENA2 not present in gamedata/' };
const discovered = ARENA2 ? await discoverFeatures() : { features: [] };
const SHOP = 'interior:Daggerfall/Gothway Garden/3,0/16'; // general store with a source Merchants questor
const gold = (c) => Number(c.character.gold) || 0;

async function questWorld(t, names) {
  assert.ok(ARENA2, 'RPG_INTEGRATION_STRICT=1 requires gamedata/…/arena2');
  const tmp = tempDir();
  const dbPath = `${tmp.dir}/world.db`;
  const features = await featuresWithQuestCatalog(discovered.features, ARENA2, names);
  const world = await createFixtureWorld({ dbPath, features, dataPath: ARENA2 });
  t.after(() => {
    try { world.close(); } finally { tmp.remove(); }
  });
  await world.ctx.services.interiors.ready;
  return { world, dbPath };
}

/** Polls the fixture (asynchronous loads use real I/O) until `fn()` is truthy. */
async function until(world, fn, what, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    world.tick(250);
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** FIXTURE POSITIONING: moves a character through the production portal transfer to a landing. */
function placeAt(world, c, location, at, portal = null) {
  const p = world.players.get(c.id);
  world.ctx.services.portals.transfer(p, { location, x: at.x, y: at.y ?? 0, z: at.z, yaw: 0 }, { portal });
  world.tick(40);
}
const standBy = (world, c, e, dz = 0.8) => {
  const p = world.players.get(c.id);
  p.x = e.x;
  p.z = e.z + dz;
  if (p.rpg.portal && Number.isFinite(e.y)) p.rpg.portal.footY = e.y;
};

async function enterShop(world, c) {
  const shop = world.ctx.services.portals.at(world.ctx.defaultLocation).find((b) => b.to === SHOP);
  assert.ok(shop, 'the general store is a surveyed building');
  placeAt(world, c, SHOP, shop.entrances[0].inner, shop);
  await world.ctx.services.collision.whenSettled(SHOP);
  return until(world, () => c.state.entities.find((e) => e.kind === 'npc' && e.questGroup === 'Merchants'), 'the merchant');
}

/** Leaves the current building or dungeon through its own door (portal.leave). */
async function leaveInstance(world, c) {
  const loc = c.character.location;
  if (!/^(interior|dungeon):/.test(loc)) return;
  await world.ctx.services.interiors.survey(loc); // after a restart the doors are surveyed again first
  const door = world.ctx.services.portals.into(loc);
  const at = door.entrances[0].inner;
  standBy(world, c, { x: at.x, y: at.y, z: at.z }, 0); // FIXTURE POSITIONING: at the exit door
  await until(world, () => {
    world.clock.advance(1000);
    const r = c.act('portal.leave', {});
    if (!r.ok && !/loading|moment/i.test(r.error)) throw new Error(`portal.leave: ${r.error}`);
    return r.ok;
  }, 'the way out to load');
}

/** Normal production entrance: travel to the revealed dungeon's exterior and use its door. */
async function enterDungeon(world, c, town) {
  await leaveInstance(world, c);
  world.clock.advance(5000);
  c.must('travel.go', { to: town });
  await world.ctx.services.interiors.survey(town);
  const door = world.ctx.services.portals.at(town).find((x) => x.kind === 'dungeon');
  const p = world.players.get(c.id);
  p.x = door.entrances[0].x;
  p.z = door.entrances[0].z; // FIXTURE POSITIONING: standing at the authored entrance
  await world.ctx.services.collision.whenSettled(door.to);
  await until(world, () => {
    world.clock.advance(1000);
    const r = c.act('portal.use', { portalId: door.id });
    if (!r.ok && !/loading|moment/i.test(r.error)) throw new Error(`portal.use: ${r.error}`);
    return r.ok;
  }, 'the dungeon entrance to load');
  assert.equal(c.character.location, door.to, 'inside the dungeon');
  return door.to;
}

describe('[asset] K0C00Y08 A Rare Book through a source merchant and a dungeon marker', () => {
  test('offer → advance → reveal → book on marker → private pickup → restart → return → paid once', gate, async (t) => {
    const { world, dbPath } = await questWorld(t, ['K0C00Y08']);
    const a = world.connect('acct-a', 'Aldora');
    const b = world.connect('acct-b', 'Brannoc');
    const merchant = await enterShop(world, a);
    await enterShop(world, b);
    assert.equal(merchant.questGiver, true);
    standBy(world, a, merchant);
    standBy(world, b, merchant, -0.8);
    world.tick(40);

    // B joins A's party first: a revealed site is shared map knowledge, nothing else.
    a.must('party.invite', { targetId: b.id });
    b.must('party.accept', { fromId: a.id });
    const g0 = gold(a);
    a.must('quest.request', { targetId: merchant.id });
    const offer = a.events('questOffer').at(-1);
    assert.match(offer.text, /book/i, 'original QRC offer text');
    assert.equal(b.act('quest.accept', { offerId: offer.offerId }).ok, false, "B cannot accept A's offer");
    a.must('quest.accept', { offerId: offer.offerId });
    const inst = a.character.quests.active.find((q) => q.name === 'K0C00Y08');
    const [advanceKey, rewardKey] = ['i.01', 'i.00'];
    const advance = inst.items[advanceKey].gold;
    const reward = inst.items[rewardKey].gold;
    assert.ok(advance >= 5 && advance <= 50, `advance ${advance} within the classic 5..50`);
    assert.ok(reward > advance, 'separate completion payment');
    assert.equal(gold(a), g0 + advance, 'advance paid on acceptance');
    assert.ok(!b.character.quests?.active?.length, 'B has no quest');

    const place = inst.places['l.00'];
    assert.ok(place.interior?.startsWith('dungeon:Daggerfall/'), `remote dungeon in the giver's region: ${place.interior}`);
    const entry = world.ctx.services.travel.lookup(place.location);
    assert.ok(['keep', 'labyrinth', 'ruin', 'graveyard'].includes(entry.type) && entry.dungeonType <= 16, 'Place.IsDungeonType');
    assert.equal(inst.giver.buildingName, "Doctor Mordistyr's Gear");
    assert.ok(inst.log[0].text.includes(inst.giver.buildingName + ', Gothway Garden'), 'journal names the giver’s shop');

    // Marker binding is asynchronous (dungeon survey); it is stable once chosen.
    const marker = await until(world, () => a.character.quests.active[0].items['i.02'].markerAt, 'the book marker');
    const markers = await world.ctx.services.interiors.questMarkers(place.interior);
    assert.ok(markers.some((m) => m.id === marker.id && m.x === marker.x), 'book stands on an authored quest item marker');

    // A cannot turn in before the objective.
    const g1 = gold(a);
    a.must('npc.talk', { targetId: merchant.id });
    assert.equal(gold(a), g1, 'no completion reward before the book');

    // Both travel there; B is a helper without the quest.
    await enterDungeon(world, a, place.location);
    await enterDungeon(world, b, place.location);
    const book = await until(world, () => a.state.entities.find((e) => e.kind === 'questItem'), 'the book entity');
    assert.equal(book.marker, marker.id);
    assert.ok(Math.abs(book.y - marker.y) < 1e-6, 'book on the marker’s floor');
    assert.equal(b.entity(book.id), null, 'B cannot see A’s book');
    standBy(world, b, book);
    assert.equal(b.act('quest.click', { targetId: book.id }).ok, false, 'B cannot take it');
    standBy(world, a, book);
    const pa = world.players.get(a.id);
    pa.rpg.portal.footY = book.y + 10; // same x/z, another storey
    assert.match(a.act('quest.click', { targetId: book.id }).error ?? '', /another level/, 'unreachable from another floor');
    standBy(world, a, book);
    a.must('quest.click', { targetId: book.id });
    assert.equal(a.character.quests.active[0].items['i.02'].held, true);
    assert.equal(a.act('quest.click', { targetId: book.id }).ok, false, 'a second pickup fails');
    assert.equal(gold(a), g1, 'pickup pays nothing');

    // Owner disconnects mid-objective; the server restarts on the same database.
    world.leave(a);
    assert.equal(readPersisted(dbPath, a.id).rpg.quests.active[0].items['i.02'].held, true, 'held book saved');
    world.restart();
    await world.ctx.services.interiors.ready;
    const a2 = world.connect('acct-a', 'Aldora');
    const b2 = world.connect('acct-b', 'Brannoc');
    await until(world, () => a2.character.location === place.interior && world.ctx.services.collision.instanceWorld(place.interior), 'resume inside');
    const resumed = a2.character.quests.active[0];
    assert.equal(resumed.uid, inst.uid, 'same instance after restart');
    assert.deepEqual(resumed.items['i.02'].markerAt, marker, 'marker record survives reload');
    assert.ok(!a2.state.entities.some((e) => e.kind === 'questItem'), 'taken book is not respawned');

    // Leave through the dungeon door and travel back to the shop.
    await leaveInstance(world, a2);
    world.clock.advance(5000);
    a2.must('travel.go', { to: world.ctx.defaultLocation });
    const m2 = await enterShop(world, a2);
    await enterShop(world, b2);
    standBy(world, a2, m2);
    standBy(world, b2, m2, -0.8);
    world.tick(40);
    const ga = gold(a2);
    const gb = gold(b2);
    b2.act('npc.talk', { targetId: m2.id });
    assert.equal(gold(b2), gb, 'B talking to the merchant earns nothing');
    a2.must('npc.talk', { targetId: m2.id });
    assert.equal(gold(a2), ga + reward, `completion ${reward} gold paid once`);
    assert.equal(gold(b2), gb, 'the party helper receives no payment');
    assert.ok(!b2.character.quests?.active?.length && !b2.character.quests?.done?.length, 'B never had the quest');
    assert.equal(a2.character.quests.done[0].uid, inst.uid);
    assert.equal(a2.character.quests.done[0].result, 'success');
    a2.must('npc.talk', { targetId: m2.id });
    world.tick(5000);
    assert.equal(gold(a2), ga + reward, 'a second turn-in pays nothing');
    assert.equal(readPersisted(dbPath, a.id).rpg.quests.done.filter((d) => d.uid === inst.uid).length, 1);
    t.diagnostic(`K0C00Y08: advance ${advance}, reward ${reward}, ${place.interior} marker ${marker.id} (${marker.block})`);
  });

  test('expiry (timed fixture): the clock ends the quest as failure; the advance is kept, no reward', gate, async (t) => {
    const { world } = await questWorld(t, ['K0C00Y08']);
    const a = world.connect('acct-a', 'Aldora');
    const merchant = await enterShop(world, a);
    standBy(world, a, merchant);
    world.tick(40);
    a.must('quest.request', { targetId: merchant.id });
    a.must('quest.accept', { offerId: a.events('questOffer').at(-1).offerId });
    const inst = a.character.quests.active[0];
    const clock = inst.clocks['s.00'];
    assert.ok(clock.running && clock.total > 1440, `travel-based clock (${clock.total} minutes)`);
    const g = gold(a);
    // TIMED FIXTURE: use the same personal time ledger that records rest and travel.
    world.ctx.services.spendTime(world.players.get(a.id), clock.total + 60, 'fixture');
    world.tick(1100);
    assert.equal(a.character.quests.active.length, 0);
    assert.equal(a.character.quests.done[0].result, 'failed');
    assert.equal(gold(a), g, 'no completion payment after expiry');
  });
});

const STORY = ['S0000008', 'S0000016', 'S0000100', 'S0000101', 'S0000102', 'S0000103', 'S0000104', 'S0000106'];
const CASTLE = 'dungeon:Daggerfall/Daggerfall';
const questOf = (c, name) => c.character.quests.active.find((q) => q.name === name) ?? null;
const individualOf = (c, faction) => c.state.entities.find((e) => e.kind === 'npc' && e.individual && e.faction === faction && !e.quest);

/** FIXTURE POSITIONING: next to an entity or point, on its storey, on clear floor. */
function besideOnFloor(world, c, at) {
  const p = world.players.get(c.id);
  const loc = c.character.location;
  const col = world.ctx.services.collision;
  const spot = col.nearestClear(loc, at.x, at.z + 0.9, 3, at.y) ?? { x: at.x, z: at.z + 0.9 };
  p.x = spot.x;
  p.z = spot.z;
  const y = col.groundAt(loc, p.x, p.z, at.y);
  if (p.rpg.portal && Number.isFinite(y)) p.rpg.portal.footY = y;
  world.tick(40);
}

/** Production door into a dungeon instance from wherever the character stands (FIXTURE POSITIONING at the door). */
async function intoDungeon(world, c, dungeon) {
  await world.ctx.services.interiors.survey(dungeon);
  const door = world.ctx.services.portals.into(dungeon);
  placeAt(world, c, door.from, { x: door.entrances[0].x, z: door.entrances[0].z });
  await world.ctx.services.collision.whenSettled(dungeon);
  await until(world, () => {
    world.clock.advance(1000);
    const r = c.act('portal.use', { portalId: door.id });
    if (!r.ok && !/loading|moment/i.test(r.error)) throw new Error(`portal.use: ${r.error}`);
    return r.ok;
  }, `${dungeon} to load`);
}

describe('[asset] S0000008 → S0000016 Mantellan Crux prerequisites (LATE-STAGE FIXTURE)', () => {
  test('Brisienna → totem → activation → Gothryd delivery → Nulfaga → Mantellan Crux → Mantella → Shedungent', gate, async (t) => {
    const { world, dbPath } = await questWorld(t, STORY);
    const a = world.connect('acct-a', 'Aldora');
    const b = world.connect('acct-b', 'Brannoc');
    const pa = () => world.players.get(a.id);
    // LATE-STAGE FIXTURE: S0000015 (end of the main campaign) is what starts S0000008 in play.
    const story = world.ctx.services.quests.start(pa(), 'S0000008');
    assert.ok(story, 'S0000008 started for A');
    assert.ok(!b.character.quests?.active?.length, 'B has no story quest');
    assert.throws(() => world.ctx.services.interiors.questTransfer(world.players.get(b.id), story), /Journey|requires/i, 'B cannot use A’s instance');

    // 7-14 days later Brisienna's letter arrives and she waits in a tavern.
    world.ctx.services.spendTime(pa(), 14 * 1440 + 60, 'fixture');
    world.tick(1100);
    let q8 = questOf(a, 'S0000008');
    const bris = q8.people['p.00'];
    assert.equal(bris.name, 'Lady Brisienna');
    assert.equal(bris.individual, 352);
    const tavernTown = q8.places['l.01'].location;
    world.clock.advance(5000);
    a.must('travel.go', { to: tavernTown });
    await world.ctx.services.interiors.survey(tavernTown);
    const tavern = await until(world, () => questOf(a, 'S0000008').places['l.01'].interior, 'tavern binding');
    const tdoor = world.ctx.services.portals.into(tavern);
    placeAt(world, a, tavern, tdoor.entrances[0].inner, tdoor);
    const brisE = await until(world, () => a.state.entities.find((e) => e._quest === undefined && e.kind === 'npc' && e.name === 'Lady Brisienna'), 'Brisienna');
    assert.equal(brisE.faction, 352);
    assert.deepEqual(brisE.sprite, { archive: 182, record: 27 }, 'FACTION.TXT flat for Brisienna');
    standBy(world, a, brisE);
    a.must('npc.talk', { targetId: brisE.id });
    q8 = questOf(a, 'S0000008');
    assert.ok(q8.prompt, 'Brisienna asks');
    assert.equal(b.act('quest.answer', { uid: q8.uid, yes: true }).ok, false, 'B cannot answer');
    a.must('quest.answer', { uid: q8.uid, yes: true });
    q8 = questOf(a, 'S0000008');
    assert.equal(q8.items['i.01'].location, 'town:Daggerfall/Daggerfall', 'totem placed at Castle Daggerfall');

    // Castle Daggerfall: the totem lies on a quest item marker; picking it up starts the clock.
    await intoDungeon(world, a, CASTLE);
    const totem = await until(world, () => a.state.entities.find((e) => e.kind === 'questItem'), 'the totem');
    besideOnFloor(world, a, totem);
    a.must('quest.click', { targetId: totem.id });
    world.ctx.services.spendTime(pa(), 5, 'fixture');
    world.tick(1100);
    q8 = questOf(a, 'S0000008');
    assert.equal(q8.items['i.01'].held, true);
    assert.equal(q8.tasks['s.06'].t, true, 'pc at Castle Daggerfall');
    assert.equal(q8.tasks['s.07'].t, false, 'WRONG STEP: not activated while still in the castle');

    // Wrong step: Nulfaga before delivery does not send the player (Daggerfall Unity _clearnulfaga_).
    await intoDungeon(world, a, MANTELLAN.returnDungeon);
    const nul0 = await until(world, () => individualOf(a, 303), 'Nulfaga');
    besideOnFloor(world, a, nul0);
    a.must('npc.talk', { targetId: nul0.id });
    world.tick(1100);
    assert.ok(!questOf(a, 'S0000016'), 'no Mantellan Crux before delivering the totem');
    assert.equal(questOf(a, 'S0000008').tasks['s.39'].t, false, 'early click cleared');
    assert.equal(questOf(a, 'S0000008').tasks['s.07'].t, true, 'leaving the castle activated the totem');

    // Delivery to King Gothryd, the authored individual in Castle Daggerfall.
    await intoDungeon(world, a, CASTLE);
    const goth = await until(world, () => individualOf(a, 364), 'King Gothryd');
    const g0 = gold(a);
    besideOnFloor(world, a, goth);
    // Wrong target: another court individual does not take the totem.
    const other = a.state.entities.find((e) => e.individual && e.faction !== 364 && Math.hypot(e.x - goth.x, e.z - goth.z) < 6);
    if (other) { besideOnFloor(world, a, other); a.act('npc.talk', { targetId: other.id }); world.tick(300); besideOnFloor(world, a, goth); }
    assert.equal(questOf(a, 'S0000008').items['i.01'].held, true, 'still holding the totem');
    a.must('npc.talk', { targetId: goth.id });
    world.tick(1100);
    q8 = questOf(a, 'S0000008');
    assert.equal(q8.items['i.01'].held, false, 'totem handed over');
    assert.equal(world.ctx.services.quests.globals(pa())[1], true, 'global GothrydGotTotem');
    assert.equal(q8.tasks['s.40'].t, true, 'delivered');
    // Classic _S.37_ is "when _S.46_ and _S.07_": activation (_S.07_, not in Castle Daggerfall) is false while A is
    // still in the castle, so Gothryd's 10000 gold arrives as A steps outside.
    assert.equal(gold(a), g0, 'no payment while still inside the castle');
    await leaveInstance(world, a);
    world.tick(1100);
    assert.equal(gold(a), g0 + 10000, 'Gothryd pays 10000 gold once, outside the castle');
    world.tick(1100);
    assert.equal(gold(a), g0 + 10000, 'and only once');

    // Nulfaga now sends A to the Mantellan Crux through the dungeon owner's quest transfer.
    await intoDungeon(world, a, MANTELLAN.returnDungeon);
    const nul = await until(world, () => individualOf(a, 303), 'Nulfaga');
    besideOnFloor(world, a, nul);
    await world.ctx.services.interiors.prepareQuestTransfer();
    a.must('npc.talk', { targetId: nul.id });
    await until(world, () => a.character.location === MANTELLAN.dungeon, 'transfer into the Mantellan Crux');
    const q16 = questOf(a, 'S0000016');
    assert.ok(q16, 'S0000016 active');
    assert.ok(!questOf(a, 'S0000008'), 'S0000008 ended');
    assert.equal(a.character.quests.done.find((d) => d.name === 'S0000008').result, 'ended');
    assert.deepEqual(pa().rpg.mantellan, { uid: q16.uid, stage: 'inside' });
    assert.ok(!b.character.quests?.active?.length && b.character.location !== MANTELLAN.dungeon, 'B was not moved');

    // Restart inside: same instance, still inside, transfer not repeated.
    world.restart();
    await world.ctx.services.interiors.ready;
    const a2 = world.connect('acct-a', 'Aldora');
    world.connect('acct-b', 'Brannoc');
    await until(world, () => world.ctx.services.collision.instanceWorld(MANTELLAN.dungeon), 'Crux geometry');
    assert.equal(a2.character.location, MANTELLAN.dungeon);
    assert.equal(questOf(a2, 'S0000016').uid, q16.uid);
    assert.equal(readPersisted(dbPath, a.id).rpg.mantellan.stage, 'inside');

    // The Mantella (authored model 74143) returns A to Shedungent and sets global 36; S0000016 ends.
    const scene = await world.ctx.services.interiors.scene(MANTELLAN.dungeon);
    const mantella = scene.mechanisms.find((m) => m.mantella);
    besideOnFloor(world, a2, { x: mantella.x, y: mantella.y - 1.6, z: mantella.z });
    await until(world, () => {
      const r = a2.act('dungeon.use', { id: mantella.id });
      if (!r.ok && !/loading|reach/i.test(r.error)) throw new Error(`dungeon.use: ${r.error}`);
      if (!r.ok) besideOnFloor(world, a2, { x: mantella.x, y: mantella.y - 1.6, z: mantella.z });
      return r.ok;
    }, 'the Mantella');
    assert.equal(a2.character.location, MANTELLAN.returnDungeon, 'back in Shedungent');
    assert.equal(world.ctx.services.quests.globals(world.players.get(a2.id))[36], true, 'FinishedMantellanCrux');
    world.ctx.services.spendTime(world.players.get(a2.id), 5, 'fixture');
    world.tick(1100);
    world.tick(1100);
    assert.ok(!questOf(a2, 'S0000016'), 'S0000016 ended cleanly');
    const done16 = a2.character.quests.done.find((d) => d.name === 'S0000016');
    assert.equal(done16.result, 'ended');
    assert.ok(a2.events('questVideo').some((e) => e.video === 14), 'Gothryd ending video cue');
    t.diagnostic(`S0000008 ${story.uid} → S0000016 ${q16.uid}; active ${a2.character.quests.active.map((q) => q.name).join(',')}; done ${a2.character.quests.done.map((d) => `${d.name}:${d.result}`).join(',')}`);
  });

  test('permanent sites map to the operator’s MAPS records', gate, async (t) => {
    const { world } = await questWorld(t, ['S0000008', 'S0000016']);
    const tr = world.ctx.services.travel;
    for (const [n, site] of PERMANENT_PLACES) {
      const town = site.location.replace(/^dungeon:/, 'town:');
      assert.ok(tr.lookup(town), `${n}: ${town} is catalogued`);
    }
    assert.equal(PERMANENT_PLACES.get('mantellan_crux').location, MANTELLAN.dungeon);
    assert.equal(PERMANENT_PLACES.get('shedungent1').location, MANTELLAN.returnDungeon);
  });
});

test('[asset] Emperor’s letter on the authored Orsinium marker (campaign checkpoint fixture)', gate, async (t) => {
  const { world } = await questWorld(t, ['S0000020', 'S0000988']);
  const client = world.connect('acct-orcish-treaty', 'Aldora');
  const player = world.players.get(client.id);
  const services = world.ctx.services;
  const orsinium = 'dungeon:Orsinium Area/Orsinium';

  // CAMPAIGN CHECKPOINT: supply the prior wedding outcome and start this quest through the operator entry.
  player.rpg.quests.globals[23] = true;
  const treaty = services.quests.start(player, 'S0000020');
  assert.ok(treaty);
  await intoDungeon(world, client, CASTLE);
  const mynisera = await until(world, () => individualOf(client, 366), 'Mynisera');
  besideOnFloor(world, client, mynisera);
  client.must('npc.talk', { targetId: mynisera.id });
  client.must('quest.answer', { uid: treaty.uid, yes: true });
  assert.equal(questOf(client, treaty.name).items['i.01'].held, true);

  await intoDungeon(world, client, orsinium);
  const gortwog = await until(world, () => individualOf(client, 357), 'Gortwog');
  besideOnFloor(world, client, gortwog);
  client.must('npc.talk', { targetId: gortwog.id });
  assert.equal(questOf(client, treaty.name).items['i.01'].held, false);

  const letter = await until(world, () => client.state.entities.find((entity) => entity.kind === 'questItem' && entity.name === 'The Emperor’s letter'), 'the Emperor’s letter');
  const [marker] = await services.interiors.questMarkers(orsinium);
  assert.equal(marker.block, 'S0000022.RDB');
  assert.deepEqual([letter.marker, letter.x, letter.y, letter.z], [marker.id, marker.x, marker.floor, marker.z]);
  besideOnFloor(world, client, letter);
  client.must('quest.click', { targetId: letter.id });
  assert.equal(questOf(client, treaty.name).items['i.00'].held, true);
  client.must('quest.use', { uid: treaty.uid, item: 'i.00' });
  assert.ok(client.events('questMessage').some((event) => event.title === letter.name && event.text));

  await intoDungeon(world, client, CASTLE);
  const returnAudience = await until(world, () => individualOf(client, 366), 'Mynisera on return');
  besideOnFloor(world, client, returnAudience);
  client.must('npc.talk', { targetId: returnAudience.id });
  assert.equal(services.quests.globals(player)[29], true);
  assert.ok(questOf(client, 'S0000988'));
  t.diagnostic('The operator supplied the wedding outcome and staged the quest start and positions. Named audiences, placement, pickup, reading and return use game actions.');
});

test('[asset] Medora, Lysandus, Woodborne diary and Nulfaga testimony (campaign checkpoint fixture)', gate, async (t) => {
  const { world } = await questWorld(t, ['S0000022', 'S0000015', 'S0000008']);
  const a = world.connect('acct-revenge', 'Aldora');
  const p = world.players.get(a.id);
  const revelation = world.ctx.services.quests.start(p, 'S0000022');
  assert.ok(revelation, 'operator stages the revelation chapter; previous campaign quests are outside this fixture');
  await intoDungeon(world, a, 'dungeon:Isle of Balfiera/Direnni Tower');
  const medora = await until(world, () => individualOf(a, 363), 'Medora at Direnni Tower');
  besideOnFloor(world, a, medora);
  a.must('npc.talk', { targetId: medora.id });
  assert.equal(questOf(a, 'S0000022').items['i.00'].held, false, 'Medora still needs time');
  world.ctx.services.spendTime(p, 31 * 1440, 'fixture');
  world.tick(1100);
  a.must('npc.talk', { targetId: medora.id });
  assert.equal(questOf(a, 'S0000022').items['i.00'].held, true, 'Medora supplies the dust');

  await intoDungeon(world, a, LYSANDUS_TOMB);
  const tomb = await world.ctx.services.interiors.scene(LYSANDUS_TOMB);
  const shrine = tomb.mechanisms.find((m) => m.modelId === 74069 && m.action?.axis === 43);
  assert.ok(shrine, 'the shrine carries the classic dungeon trigger');
  besideOnFloor(world, a, { x: shrine.x + 0.4, y: shrine.y, z: shrine.z - 2.4 });
  a.must('dungeon.use', { id: shrine.id });
  assert.equal(world.ctx.services.quests.globals(p)[43], true);
  assert.ok(a.events('questVideo').some((event) => event.video === 5));
  const revenge = questOf(a, 'S0000015');
  assert.ok(revenge, 'the shrine starts the revenge chapter');
  const hall = 'dungeon:Wayrest/Woodborne Hall';
  await intoDungeon(world, a, hall);
  const [, , marker] = await world.ctx.services.npcs.questSpawn(hall);
  const woodborne = await until(world, () => questOf(a, 'S0000015').foes['f.00'].spawnAt, 'Woodborne’s spawn');
  assert.deepEqual([woodborne.id, woodborne.x, woodborne.z], [marker.id ?? marker.key, marker.x, marker.z], 'Woodborne uses the authored spawn marker');
  const diary = await until(world, () => a.state.entities.find((e) => e.kind === 'questItem'), 'Woodborne’s diary');
  const markers = await world.ctx.services.interiors.questMarkers(hall);
  assert.equal(diary.marker, markers[1].id, 'the diary uses the authored marker index');
  besideOnFloor(world, a, diary);
  a.must('quest.click', { targetId: diary.id });
  assert.ok(questOf(a, 'S0000015').items['i.00'].held);
  a.must('quest.use', { uid: revenge.uid, item: 'i.00' });
  assert.ok(questOf(a, 'S0000015').log.some((entry) => entry.id === 1018));

  await intoDungeon(world, a, MANTELLAN.returnDungeon);
  const nulfaga = await until(world, () => individualOf(a, 303), 'Nulfaga in Shedungent');
  const initialRep = world.ctx.services.reputation(p, 303);
  besideOnFloor(world, a, nulfaga);
  a.must('npc.talk', { targetId: nulfaga.id });
  const globals = world.ctx.services.quests.globals(p);
  assert.equal(globals[0], true, 'showing the evidence to Nulfaga lifts the curse');
  assert.equal(world.ctx.services.reputation(p, 303), initialRep + 25);
  assert.equal(globals[1], undefined, 'the delivery flag is reserved for the actual Totem');
  assert.ok(a.events('questVideo').some((event) => event.video === 13), 'Lysandus video cue');
  assert.equal(questOf(a, 'S0000008'), null, 'both prerequisite court arcs still matter');
});

test('[asset] Underking Totem handover after the source letter (campaign checkpoint fixture)', gate, async (t) => {
  const { world } = await questWorld(t, STORY);
  const a = world.connect('acct-underking', 'Aldora');
  const p = world.players.get(a.id);
  const services = world.ctx.services;
  // CAMPAIGN CHECKPOINT: satisfactory standing from the earlier Underking arc and a staged Totem quest start.
  services.adjustReputation(p, 354, 1);
  const totemQuest = services.quests.start(p, 'S0000008');
  assert.ok(totemQuest);
  assert.equal(totemQuest.people['p.05'].faction, 354);
  services.spendTime(p, 15 * 1440, 'fixture');
  world.tick(1100);
  const tavernTown = questOf(a, 'S0000008').places['l.01'].location;
  await services.interiors.survey(tavernTown);
  const tavernId = await until(world, () => questOf(a, 'S0000008').places['l.01'].interior, 'Brisienna’s tavern');
  const tavern = services.portals.into(tavernId);
  placeAt(world, a, tavernId, tavern.entrances[0].inner, tavern);
  const brisienna = await until(world, () => a.state.entities.find((e) => e.kind === 'npc' && e.faction === 352), 'Lady Brisienna');
  besideOnFloor(world, a, brisienna);
  a.must('npc.talk', { targetId: brisienna.id });
  a.must('quest.answer', { uid: totemQuest.uid, yes: true });

  await intoDungeon(world, a, CASTLE);
  const totem = await until(world, () => a.state.entities.find((e) => e.kind === 'questItem'), 'the Totem');
  besideOnFloor(world, a, totem);
  a.must('quest.click', { targetId: totem.id });
  await leaveInstance(world, a);
  assert.equal(questOf(a, 'S0000008').items['i.04'].held, false, 'letter waits for the source clock');
  services.spendTime(p, 8 * 1440, 'fixture');
  world.tick(1100);
  const ready = questOf(a, 'S0000008');
  assert.equal(ready.items['i.04'].held, true, 'the Underking invitation arrived');
  a.must('quest.use', { uid: totemQuest.uid, item: 'i.04' });
  await services.interiors.survey(ready.places['l.02'].location);
  const templeId = await until(world, () => questOf(a, 'S0000008').places['l.02'].interior, 'the Underking’s temple');
  const temple = services.portals.into(templeId);
  assert.equal(temple.meta.buildingType, 14);
  placeAt(world, a, templeId, temple.entrances[0].inner, temple);
  const underking = await until(world, () => a.state.entities.find((e) => e.kind === 'npc' && e.faction === 354), 'the Underking');
  besideOnFloor(world, a, underking);
  a.must('npc.talk', { targetId: underking.id });
  assert.equal(questOf(a, 'S0000008').items['i.01'].held, false);
  assert.equal(services.quests.globals(p)[6], true);
  assert.equal(services.quests.globals(p)[1], undefined);
  const artifact = services.artifactTemplate?.('Necromancers_Amulet');
  assert.ok(artifact, 'Necromancer’s Amulet resolves in the installed artifact catalogue');
  assert.equal(services.countItem(p, artifact), 1);
  assert.ok(services.findItem(p, artifact)?.magic?.enchantments?.length);
  a.leave();
  const resumed = world.connect('acct-underking', 'Aldora');
  assert.ok(resumed.character.inventory.find((item) => item.magic?.artifact === artifact)?.magic?.enchantments?.length);
  assert.equal(services.countItem(world.players.get(resumed.id), artifact), 1);
});
