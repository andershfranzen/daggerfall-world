// Ordinary social-giver routes (package 17) on the production feature manifest and the operator's ARENA2:
//   A0C10Y05  escort: the commoner's betrothed joins the player as a travelling companion (classic `add _P_ face`,
//             the questor and the companion hidden from the world) and both are taken to a remote temple's priest;
//             the travel clock expiring first fails the job.
//   K0C00Y07  ransom: a merchant's lover is held by a Thieves Guild kidnapper who takes the merchant's gem as ransom;
//             the job's own clock lets it lapse with the gem kept.
// Positions are set by the fixture (FIXTURE POSITIONING) at doors and beside people; every quest step is a normal
// production action (quest.request/accept, npc.talk, travel.go, portal.use/leave, rest.start, quest.answer).
// Requires gamedata/…/arena2; skipped without it (RPG_INTEGRATION_STRICT=1 makes that a failure).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverFeatures, createFixtureWorld, readPersisted, tempDir, STRICT, localArena2, featuresWithQuestCatalog,
} from './support/rpg-session.mjs';
import * as R from '../client/gameplay/character/rules.js';
import { exteriorOf } from '../client/world/interiors/index.js';
import { loadCatalog, parseQuestList } from '../server/rpg/quests/catalog.js';
import * as questsFeature from '../server/rpg/quests.js';

const ARENA2 = localArena2();
const gate = ARENA2 ? {} : STRICT ? {} : { skip: 'operator ARENA2 not present in gamedata/' };
const discovered = ARENA2 ? await discoverFeatures() : { features: [] };
const SHOP = 'interior:Daggerfall/Gothway Garden/3,0/16';

async function questWorld(t, names) {
  const tmp = tempDir();
  const dbPath = `${tmp.dir}/world.db`;
  const features = await featuresWithQuestCatalog(discovered.features, ARENA2, names);
  const world = await createFixtureWorld({ dbPath, features, dataPath: ARENA2 });
  t.after(() => { try { world.close(); } finally { tmp.remove(); } });
  await world.ctx.services.interiors.ready;
  return { world, dbPath };
}
async function until(world, fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    world.tick(250);
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
/** FIXTURE POSITIONING: production portal transfer to a landing. */
function placeAt(world, c, location, at, portal = null) {
  world.ctx.services.portals.transfer(world.players.get(c.id), { location, x: at.x, y: at.y ?? 0, z: at.z, yaw: 0 }, { portal });
  world.tick(40);
}
/** FIXTURE POSITIONING: beside an entity on its storey, on clear floor. */
function beside(world, c, at) {
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
/** Into a building or dungeon through its own door (FIXTURE POSITIONING at the door). */
async function enter(world, c, interior) {
  const s = world.ctx.services;
  const town = interior.startsWith('dungeon:') ? `town:${interior.slice(8)}` : null;
  if (town) {
    if (c.character.location !== town) c.must('travel.go', { to: town });
    await s.interiors.survey(town);
  } else {
    const exterior = s.portals.into(interior)?.from;
    if (exterior && c.character.location !== exterior) { world.clock.advance(5000); c.must('travel.go', { to: exterior }); }
    await s.interiors.survey(exterior);
  }
  const door = s.portals.into(interior);
  placeAt(world, c, door.from, { x: door.entrances[0].x, z: door.entrances[0].z });
  await s.collision.whenSettled(interior);
  await until(world, () => {
    world.clock.advance(1000);
    const r = c.act('portal.use', { portalId: door.id });
    if (!r.ok && !/loading|moment|locked/i.test(r.error)) throw new Error(`portal.use: ${r.error}`);
    return r.ok;
  }, `${interior} to open`);
  return door;
}
async function leave(world, c) {
  const loc = c.character.location;
  if (!/^(interior|dungeon):/.test(loc)) return;
  await world.ctx.services.interiors.survey(loc);
  const door = world.ctx.services.portals.into(loc);
  const p = world.players.get(c.id);
  p.x = door.entrances[0].inner.x; // FIXTURE POSITIONING: at the exit door
  p.z = door.entrances[0].inner.z;
  if (p.rpg.portal) p.rpg.portal.footY = door.entrances[0].enter?.y ?? p.rpg.portal.footY;
  await until(world, () => {
    world.clock.advance(1000);
    const r = c.act('portal.leave', {});
    if (!r.ok && !/loading|moment/i.test(r.error)) throw new Error(`portal.leave: ${r.error}`);
    return r.ok;
  }, 'the way out');
  world.clock.advance(5000);
}
function createCharacter(c, gender = 'Male') {
  c.must('character.roll', { className: 'Warrior' });
  const d = c.character.character.draft;
  const attributes = { ...d.attributeBase };
  let pool = d.bonusPool;
  for (const a of R.ATTRIBUTES) { const add = Math.min(pool, R.MAX_STAT - attributes[a]); attributes[a] += add; pool -= add; }
  const career = d.career ?? R.CLASSES.find((k) => k.name === d.className);
  const skills = {};
  for (const g of ['primary', 'major', 'minor']) {
    let left = R.SKILL_GROUP_POOL;
    for (const sk of R.SKILLS.filter((x) => R.skillGroupOf(career, x) === g)) {
      const add = Math.min(left, R.MAX_SKILL - d.skillBase[sk]);
      if (add > 0) { skills[sk] = d.skillBase[sk] + add; left -= add; }
    }
  }
  c.must('character.create', { race: 'Nord', gender, attributes, skills });
}
const gold = (c) => Number(c.character.gold) || 0;
const questOf = (c, name) => c.character.quests?.active?.find((q) => q.name === name) ?? null;

/**
 * A named building of the start town whose resident offers `group` work today. With `gender`, only such a giver:
 * QuestList-Classic M/F social jobs follow the questor's sex (DaggerfallQuestOfferWindow passes questorNPC.gender).
 */
async function socialGiver(world, c, group, gender = null) {
  const s = world.ctx.services;
  const town = world.ctx.defaultLocation;
  const work = await s.npcs.workAt(town, c.id);
  await s.interiors.survey(town);
  const jobs = work.filter((w) => w.group === group && s.portals.at(town).some((sp) => sp.to === w.interior));
  assert.ok(jobs.length, `a named building whose resident offers ${group} work today`);
  const seen = [];
  for (const job of jobs) {
    if (c.character.location !== job.interior) { await leave(world, c); await enter(world, c, job.interior); }
    const giver = await until(world, () => c.state.entities.find((e) => e.questGiver && e.questGroup === group), 'the giver');
    seen.push(`${giver.name} (${giver.gender})`);
    if (gender && giver.gender !== gender) continue;
    beside(world, c, giver);
    return { job, giver, seen };
  }
  throw new Error(`no ${gender} ${group} giver today: ${seen.join(', ')}`);
}

/** Goes to a quest person wherever the engine put them (remote towns bind once surveyed) and talks to them. */
async function meet(world, c, uid, k) {
  const s = world.ctx.services;
  const cur = () => c.character.quests.active.find((q) => q.uid === uid);
  const elsewhere = (town) => c.character.location !== town && exteriorOf(c.character.location) !== town;
  const town = cur().places[cur().people[k].place]?.location;
  if (town && !/^(interior|dungeon):/.test(town) && elsewhere(town)) {
    await leave(world, c);
    world.clock.advance(5000);
    c.must('travel.go', { to: town });
    await s.interiors.survey(town);
  }
  const pl = await until(world, () => { const q = cur(); const pk = q.people[k].place; return pk && (q.places[pk].interior || q.places[pk].noBuilding) && q.places[pk]; }, `${k}'s place`);
  if (pl.interior) {
    if (c.character.location !== pl.interior) { await leave(world, c); await enter(world, c, pl.interior); }
  } else await leave(world, c);
  const e = await until(world, () => c.state.entities.find((x) => x.quest && x.kind === 'npc' && x.name === cur().people[k].name), `${k} in ${pl.interior}`);
  beside(world, c, e);
  c.must('npc.talk', { targetId: e.id });
  world.tick(500);
  return { place: pl, entity: e };
}

describe('[asset] social-giver routes: escort, ransom and expiry', () => {
  test('A0C10Y05: the betrothed travels with the player to a remote priest; private, survives a restart, pays once', gate, async (t) => {
    const { world, dbPath } = await questWorld(t, ['A0C10Y05']);
    const a = world.connect('acct-escort-a', 'Aldora');
    const b = world.connect('acct-escort-b', 'Brannoc');
    createCharacter(a);
    createCharacter(b);
    const { job, giver } = await socialGiver(world, a, 'Commoners', 'male');
    a.must('quest.request', { targetId: giver.id });
    a.must('quest.accept', { offerId: a.events('questOffer').at(-1).offerId });
    const uid = questOf(a, 'A0C10Y05').uid;
    const cur = () => a.character.quests.active.find((q) => q.uid === uid);
    // Classic symbols are positional (p.NN): the questor, the betrothed (placed at the remote house2) and the priest
    // (placed at the remote temple).
    const keyAt = (q, building) => Object.keys(q.people).find((k) => q.places[q.people[k].place]?.building === building);
    const QG = Object.keys(cur().people).find((k) => cur().people[k].questor);
    const BETROTHED = keyAt(cur(), 'house2');
    const PRIEST = keyAt(cur(), 'temple');
    assert.ok(QG && BETROTHED && PRIEST, `questor ${QG}, betrothed ${BETROTHED}, priest ${PRIEST}`);
    // Start-up: `hide npc _qgiver_` + `add _qgiver_ face`. The questor leaves the room for A only and travels as a face.
    world.tick(500);
    assert.deepEqual(cur().faces?.map((f) => f.person), [QG], 'the questor travels with A');
    assert.equal(a.entity(giver.id), null, 'A no longer sees the questor in the room');
    assert.equal(a.act('npc.talk', { targetId: giver.id }).ok, false, 'nor can A talk to them there');
    await enter(world, b, job.interior);
    await until(world, () => b.entity(giver.id), 'B still sees the giver');

    const home = await meet(world, a, uid, BETROTHED);
    assert.ok(home.place.interior, `the betrothed's remote house is a building: ${home.place.interior}`);
    await until(world, () => cur().people[BETROTHED].hidden, 'the betrothed to join');
    assert.deepEqual(cur().faces.map((f) => f.person).sort(), [BETROTHED, QG].sort(), 'the betrothed joins the faces');
    world.tick(500);
    assert.ok(!a.state.entities.some((e) => e.id === home.entity.id), 'the betrothed no longer stands in the house');
    assert.ok(a.events('questMessage').some((e) => e.uid === uid && e.id === 1011), 'message 1011 from the QRC');

    // Restart mid-escort: the companions persist and the questor stays away from the giver's room for A.
    world.restart();
    await world.ctx.services.interiors.ready;
    const a2 = world.connect('acct-escort-a', 'Aldora');
    world.tick(1000);
    const cur2 = () => a2.character.quests.active.find((q) => q.uid === uid);
    assert.deepEqual(cur2().faces.map((f) => f.person).sort(), [BETROTHED, QG].sort());
    assert.equal(world.ctx.services.npcs.isPersonAway(giver.id, a2.id), true, 'the questor is still away for A');

    const g0 = gold(a2);
    const rep0 = world.ctx.services.reputation(world.players.get(a2.id), giver.faction);
    const RULER = cur2().people[Object.keys(cur2().people).find((k) => !cur2().people[k].questor && ![BETROTHED, PRIEST].includes(k))];
    const ruler0 = world.ctx.services.reputation(world.players.get(a2.id), RULER.faction);
    const temple = await meet(world, a2, uid, PRIEST);
    assert.ok(temple.place.interior, `the priest stands in a temple: ${temple.place.interior}`);
    await until(world, () => cur2()?.success, 'the wedding to be paid');
    const paid = gold(a2) - g0;
    assert.ok(paid > 0, `paid ${paid}`);
    assert.notEqual(RULER.faction, giver.faction, '`factiontype Province` (-2.7) is the region, not the questor');
    assert.equal(world.ctx.services.reputation(world.players.get(a2.id), RULER.faction), ruler0 - 20, '`change repute with _ruler_ by -20` at the wedding');
    // `_questdone_`: when the player leaves the temple the questor is restored and the job ends.
    await leave(world, a2);
    await until(world, () => a2.character.quests.done.find((d) => d.uid === uid), 'the job to end');
    assert.equal(a2.character.quests.done.find((d) => d.uid === uid).result, 'success');
    world.tick(500);
    assert.equal(gold(a2), g0 + paid, 'paid once');
    assert.equal(world.ctx.services.npcs.isPersonAway(giver.id, a2.id), false, '`restore npc _qgiver_` returns the questor');
    const pa = world.players.get(a2.id);
    t.diagnostic(`reputation: giver ${giver.faction} ${rep0} -> ${world.ctx.services.reputation(pa, giver.faction)}; ruler ${RULER.faction} ${ruler0} -> ${world.ctx.services.reputation(pa, RULER.faction)}`);
    assert.equal(world.ctx.services.reputation(pa, giver.faction), rep0 + 5, `Quest.FactionId ${giver.faction} +5 on success`);
    assert.equal(readPersisted(dbPath, a2.id).rpg.quests.done.filter((d) => d.uid === uid).length, 1);
    t.diagnostic(`A0C10Y05: house ${home.place.interior}; temple ${temple.place.interior}; paid ${paid}`);
  });
  test('A0C10Y05 expiry: the travel clock runs out before the wedding; the companions leave, nothing is paid, −2', gate, async (t) => {
    const { world } = await questWorld(t, ['A0C10Y05']);
    const a = world.connect('acct-escort-late', 'Aldora');
    createCharacter(a);
    const { giver } = await socialGiver(world, a, 'Commoners', 'male');
    a.must('quest.request', { targetId: giver.id });
    a.must('quest.accept', { offerId: a.events('questOffer').at(-1).offerId });
    const uid = questOf(a, 'A0C10Y05').uid;
    const inst = questOf(a, 'A0C10Y05');
    const clock = Object.values(inst.clocks)[0];
    const pa = world.players.get(a.id);
    const rep0 = world.ctx.services.reputation(pa, giver.faction);
    const g0 = gold(a);
    // Waiting with the production loiter action (classic RestModes.Loiter) in the giver's room until the clock ends.
    let waited = 0;
    await until(world, () => {
      if (a.character.quests.done.find((d) => d.uid === uid)) return true;
      const r = a.act('rest.start', { mode: 'loiter', hours: 24 });
      if (r.ok) waited += 24;
      else if (!/already resting/i.test(r.error)) throw new Error(`rest.start: ${r.error}`);
      world.tick(2000);
      return false;
    }, 'the travel clock to expire', 120000);
    const done = a.character.quests.done.find((d) => d.uid === uid);
    assert.equal(done.result, 'failed');
    assert.ok(a.events('questMessage').some((e) => e.uid === uid && e.id === 1020), 'message 1020: the betrothed waited in vain');
    assert.equal(gold(a), g0, 'nothing paid');
    assert.equal(world.ctx.services.npcs.isPersonAway(giver.id, a.id), false, 'the questor is back in their room');
    await until(world, () => a.entity(giver.id), 'A sees the questor again');
    assert.equal(world.ctx.services.reputation(pa, giver.faction), rep0 - 2, 'Quest.FactionId −2 on failure');
    t.diagnostic(`A0C10Y05 expiry: clock ${clock.total} min; loitered ${waited} h requested`);
  });

  /** A merchant in the Gothway Garden shop offers the quest (the catalogue holds only that one). */
  async function merchantOffer(world, a, name) {
    await enter(world, a, SHOP);
    const m = await until(world, () => a.state.entities.find((e) => e.kind === 'npc' && e.questGroup === 'Merchants'), 'the merchant');
    beside(world, a, m);
    a.must('quest.request', { targetId: m.id });
    a.must('quest.accept', { offerId: a.events('questOffer').at(-1).offerId });
    assert.ok(questOf(a, name), `${name} accepted`);
    return m;
  }

  test('K0C00Y07 ransom: the merchant’s gem pays the Thieves Guild kidnapper; private, once, and the merchant pays', gate, async (t) => {
    const { world, dbPath } = await questWorld(t, ['K0C00Y07']);
    const a = world.connect('acct-ransom-a', 'Aldora');
    const b = world.connect('acct-ransom-b', 'Brannoc');
    createCharacter(a);
    createCharacter(b);
    const merchant = await merchantOffer(world, a, 'K0C00Y07');
    const uid = questOf(a, 'K0C00Y07').uid;
    const cur = () => a.character.quests.active.find((q) => q.uid === uid);
    const GEM = Object.keys(cur().items).find((k) => cur().items[k].className === 'gem');
    const KIDNAPPER = Object.keys(cur().people).find((k) => cur().people[k].faction === 42);
    assert.ok(cur().items[GEM].held, 'the merchant hands over the gem (get item)');
    assert.ok(KIDNAPPER, 'the kidnapper is a member of the Thieves Guild (faction code -1.42)');

    const den = await meet(world, a, uid, KIDNAPPER);
    // B goes to the same building and sees nobody of A's job.
    await enter(world, b, den.place.interior);
    world.tick(500);
    assert.equal(b.entity(den.entity.id), null, 'B does not see A’s kidnapper');
    assert.equal(b.act('npc.talk', { targetId: den.entity.id }).ok, false, 'nor can B talk to them');
    // Toting the gem to the kidnapper opens the ransom question (message 1011, or 1012 with Thieves Guild standing).
    const prompt = await until(world, () => cur().prompt, 'the ransom question');
    assert.ok([1011, 1012].includes(prompt.id), `prompt ${prompt.id}`);
    assert.equal(cur().items[GEM].held, false, 'the gem is handed over');
    a.must('quest.answer', { uid, yes: true });
    world.tick(500);
    assert.ok(a.events('questMessage').some((e) => e.uid === uid && [1018, 1019].includes(e.id)), 'the kidnapper accepts the ransom');
    // A second click on the kidnapper does nothing more.
    a.must('npc.talk', { targetId: den.entity.id });
    world.tick(500);
    assert.equal(cur().prompt, null);

    world.restart();
    await world.ctx.services.interiors.ready;
    const a2 = world.connect('acct-ransom-a', 'Aldora');
    world.tick(1000);
    await leave(world, a2);
    await enter(world, a2, SHOP);
    const m2 = await until(world, () => a2.state.entities.find((e) => e.id === merchant.id), 'the merchant again');
    beside(world, a2, m2);
    const g0 = gold(a2);
    a2.must('npc.talk', { targetId: m2.id });
    world.tick(1000);
    const done = a2.character.quests.done.find((d) => d.uid === uid);
    assert.equal(done?.result, 'success');
    const paid = gold(a2) - g0;
    assert.ok(paid >= 5 && paid <= 25, `ransom-route payment ${paid} from the classic 5..25 range`);
    assert.ok(a2.events('questMessage').some((e) => e.uid === uid && e.id === 1020), 'message 1020 from the merchant');
    a2.must('npc.talk', { targetId: m2.id });
    world.tick(1000);
    assert.equal(gold(a2), g0 + paid, 'paid once');
    assert.equal(readPersisted(dbPath, a2.id).rpg.quests.done.filter((d) => d.uid === uid).length, 1);
    t.diagnostic(`K0C00Y07 ransom: kidnapper in ${den.place.interior}; prompt ${prompt.id}; paid ${paid}`);
  });

  test('K0C00Y07 expiry: the job lapses, the carried gem is kept, and the merchant’s −5 runs after `end quest`', gate, async (t) => {
    const { world, dbPath } = await questWorld(t, ['K0C00Y07']);
    const a = world.connect('acct-ransom-late', 'Aldora');
    createCharacter(a);
    const merchant = await merchantOffer(world, a, 'K0C00Y07');
    const uid = questOf(a, 'K0C00Y07').uid;
    const pa = world.players.get(a.id);
    const rep0 = world.ctx.services.reputation(pa, merchant.faction);
    const g0 = gold(a);
    const inv0 = (pa.rpg.inventory ?? []).map((i) => i.id);
    const gem = questOf(a, 'K0C00Y07').items['i.00'];
    assert.equal(gem.held, true, 'the merchant handed over the gem');
    assert.ok(gem.template, `the gem was rolled as an inventory gem (${gem.template})`);
    await until(world, () => {
      if (a.character.quests.done.find((d) => d.uid === uid)) return true;
      const r = a.act('rest.start', { mode: 'loiter', hours: 24 });
      if (!r.ok && !/already resting/i.test(r.error)) throw new Error(`rest.start: ${r.error}`);
      world.tick(2000);
      return false;
    }, 'the job clock to expire', 120000);
    assert.equal(a.character.quests.done.find((d) => d.uid === uid).result, 'failed');
    assert.equal(gold(a), g0, 'nothing paid');
    // `have _gem_ set _S.20_` → `make _gem_ permanent` and `_S.21_` (message 1022, −5) run in the update after
    // `end quest` (Quest.EndQuest ticksToEnd = 2). Item.MakePermanent: the gem the player carries stays theirs.
    const added = (pa.rpg.inventory ?? []).filter((i) => !inv0.includes(i.id));
    assert.deepEqual(added.map((i) => [i.template, i.group, i.quantity, i.quest ?? null]), [[gem.template, 'gem', 1, null]], 'the carried gem is now an ordinary inventory gem');
    assert.deepEqual(pa.rpg.quests.campaignRewards ?? {}, {}, 'nothing left queued');
    t.diagnostic(`K0C00Y07 expiry: kept ${added[0].name} (${gem.template}); inventory ${inv0.length} -> ${pa.rpg.inventory.length}`);
    assert.ok(a.events('questMessage').some((e) => e.uid === uid && e.id === 1022), 'message 1022: the merchant gave up');
    // 1022 also says `change repute with _qgiver_ by -5`; the failure takes Quest.FactionId −2.
    assert.equal(world.ctx.services.reputation(pa, merchant.faction), rep0 - 5 - 2);
    // Saved with the character, and a restart and rejoin neither repeat nor lose it.
    const kept = (inv) => inv.filter((i) => i.template === gem.template && !inv0.includes(i.id)).map((i) => i.id);
    assert.deepEqual(kept(readPersisted(dbPath, a.id).rpg.inventory), [added[0].id]);
    world.restart();
    await world.ctx.services.interiors.ready;
    const a2 = world.connect('acct-ransom-late', 'Aldora');
    world.tick(2000);
    assert.deepEqual(kept(world.players.get(a2.id).rpg.inventory), [added[0].id], 'once only after rejoin');
    assert.deepEqual(kept(readPersisted(dbPath, a2.id).rpg.inventory), [added[0].id]);
  });
  test('QuestList-Classic social M: the questor’s sex decides (DaggerfallQuestOfferWindow passes questorNPC.gender)', gate, async (t) => {
    // The operator's QuestList-Classic row for A0C10Y05 is "A0C10Y05, Commoners, M, 1, 0". Without a QuestList the
    // name is read (A0C… → N); the row is supplied here as an operator list would supply it.
    const row = parseQuestList('A0C10Y05, Commoners, M, 1, 0, Passed').get('A0C10Y05');
    const full = loadCatalog({ dataPath: ARENA2 });
    const entry = { ...full.quests.get('A0C10Y05'), meta: row };
    const catalog = { ...full, quests: new Map([['A0C10Y05', entry]]) };
    const features = discovered.features.map((f) => (f.name === 'quests' ? { name: 'quests', install: (ctx) => questsFeature.install(ctx, { catalog }) } : f));
    const tmp = tempDir();
    const world = await createFixtureWorld({ dbPath: `${tmp.dir}/world.db`, features, dataPath: ARENA2 });
    t.after(() => { try { world.close(); } finally { tmp.remove(); } });
    await world.ctx.services.interiors.ready;
    const a = world.connect('acct-sex-a', 'Aldora');
    createCharacter(a, 'Female');
    const s = world.ctx.services;
    const town = world.ctx.defaultLocation;
    const work = (await s.npcs.workAt(town, a.id)).filter((w) => w.group === 'Commoners');
    await s.interiors.survey(town);
    const results = [];
    for (const job of work.filter((w) => s.portals.at(town).some((sp) => sp.to === w.interior))) {
      if (a.character.location !== job.interior) { await leave(world, a); await enter(world, a, job.interior); }
      const giver = await until(world, () => a.state.entities.find((e) => e.questGiver && e.questGroup === 'Commoners'), 'the giver');
      beside(world, a, giver);
      const r = a.act('quest.request', { targetId: giver.id });
      const offered = r.ok && a.events('questOffer').some((o) => o.giver?.id === giver.id);
      results.push({ gender: giver.gender, offered });
      if (offered) a.must('quest.refuse', { offerId: a.events('questOffer').at(-1).offerId });
      if (results.some((x) => x.gender === 'male') && results.some((x) => x.gender === 'female')) break;
    }
    t.diagnostic(`Commoners givers: ${JSON.stringify(results)}`);
    const male = results.find((x) => x.gender === 'male');
    const female = results.find((x) => x.gender === 'female');
    assert.ok(male && female, 'a male and a female Commoners giver today');
    assert.equal(male.offered, true, 'a male questor offers the M job to a female player');
    assert.equal(female.offered, false, 'a female questor has no M job');
  });
});
