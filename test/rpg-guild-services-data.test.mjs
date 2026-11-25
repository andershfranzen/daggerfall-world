// Package 15 with the installed game files: real halls of the city of Daggerfall, real staff, real bookshelves,
// the real world map and TEXT.RSC, every production feature (FIXTURE layer of test/support/rpg-session.mjs).
//
// Labels used below:
//   EARNED   the player reaches the state through ordinary actions (joining, donating, talking).
//   FIXTURE  state written by the test (gold, a rank a short test cannot earn, a reputation) — stated per step.
//   CLOCK    the fixture's controlled world clock moves the shared game time forward.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CharacterDraft } from '../client/gameplay/character/draft.js';
import { createFixtureWorld, discoverFeatures, localArena2, tempDir } from './support/rpg-session.mjs';

const dataPath = localArena2();
const gate = { skip: !dataPath && 'ARENA2 is not installed', timeout: 240_000 };
const DAGGERFALL = 'town:Daggerfall/Daggerfall';
const MAGES = 'interior:Daggerfall/Daggerfall/1,2/0';
const KYNARETH = 'interior:Daggerfall/Daggerfall/3,4/13';
const THIEVES = 'interior:Daggerfall/Daggerfall/3,1/16';
const KNIGHTS = 'interior:Daggerfall/Daggerfall/6,5/15';
const GAME_MINUTE_MS = 5000; // DEFAULT_TIME_SCALE 12: one game minute is five fixture seconds

async function open(t, { guildRandom = null } = {}) {
  const temp = tempDir('dfw-guild-data-');
  let { features } = await discoverFeatures();
  if (guildRandom) features = features.map((f) => (f.name === 'guilds' ? { ...f, install: (ctx) => f.install(ctx, { random: guildRandom }) } : f));
  const world = await createFixtureWorld({ dbPath: `${temp.dir}/world.db`, features, dataPath });
  t.after(() => { try { world.close(); } finally { temp.remove(); } });
  assert.deepEqual(world.installErrors, []);
  await world.ctx.services.quests.openingReady;
  await world.ctx.services.interiors.survey(DAGGERFALL);
  return world;
}

function create(world, account, className) {
  const client = world.connect(account, 'Aldora');
  const d = new CharacterDraft('Aldora');
  d.race = 'Breton'; d.gender = 'Female'; d.chooseClass(className);
  client.must('character.roll', d.rollRequest());
  d.syncRoll(client.character.character.draft); d.autoDistribute('attributes'); d.autoDistribute('skills');
  client.must('character.create', d.createRequest());
  return { client, p: world.players.get(client.id) };
}

/** Walk in through the building's real door and wait for its people. */
async function enter(world, p, interior) {
  const spec = world.ctx.services.portals.at(DAGGERFALL).find((s) => s.to === interior);
  const land = spec.entrances[0].enter;
  world.ctx.services.portals.transfer(p, { location: interior, x: land.x, y: land.y, z: land.z, yaw: land.yaw ?? 0 }, { portal: spec, entrance: spec.entrances[0] });
  for (let i = 0; i < 60 && ![...world.ctx.entities.values()].some((e) => e.location === interior && e.kind === 'npc'); i++) {
    world.tick(250);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const staff = (world, interior, service) => [...world.ctx.entities.values()].find((e) => e.location === interior && e.kind === 'npc' && (e.services ?? []).includes(service));
function talkTo(client, p, e, service, extra = {}) {
  Object.assign(p, { x: e.x, z: e.z + 1 });
  if (p.rpg.portal && Number.isFinite(e.y)) p.rpg.portal.footY = e.y; // stand on the speaker's floor
  const v = client.must('npc.talk', { targetId: e.id });
  const view = client.events('dialogue').at(-1);
  if (!service) return view;
  client.must('npc.service', { targetId: e.id, session: view.session, service, ...extra });
  return client.events('dialogue').at(-1);
}

test('installed data: EARNED Kynareth standing by donation, CLOCK 28 days, promotion by talking; blessing from TEXT.RSC', gate, async (t) => {
  const world = await open(t);
  const { client, p } = create(world, 'guild-kyn', 'Acrobat');
  await enter(world, p, KYNARETH);
  const trainer = staff(world, KYNARETH, 'join');
  const donor = staff(world, KYNARETH, 'donate');
  assert.ok(trainer && donor, 'the temple’s own trainer and donation priest');
  let v = talkTo(client, p, trainer, 'join');
  assert.match(v.text, /Welcome to The Temple of Kynareth/);
  assert.deepEqual([p.rpg.guilds.temple.rank, p.rpg.guilds.temple.variant], [0, 35]);
  // FIXTURE: gold for the offerings.
  for (let i = 0; i < 4; i++) world.ctx.services.addGold(p, 5000);
  v = talkTo(client, p, donor, 'donate', { amount: 1000 });
  assert.match(v.text, /Kynareth has blessed your endurance/, 'the operator’s TEXT.RSC 717');
  const endurance = p.rpg.character.attributes.Endurance;
  assert.equal(world.ctx.services.effectiveAttribute(p, 'Endurance'), endurance + 1);
  // EARNED: each 1000-gold offering at standing ≤ 20 is a certain +1 (2·1000/|rep| + 1 ≥ 100 %).
  for (let i = 0; i < 9; i++) talkTo(client, p, donor, 'donate', { amount: 1000 });
  assert.equal(world.ctx.services.reputation(p, 35), 11);
  v = talkTo(client, p, trainer);
  assert.equal(p.rpg.guilds.temple.rank, 0, 'no rank change within 28 days of joining');
  // CLOCK: 28 game days.
  world.clock.advance(28 * 1440 * GAME_MINUTE_MS);
  v = talkTo(client, p, trainer);
  assert.match(v.text, /From today you are Acolyte/);
  assert.equal(p.rpg.guilds.temple.rank, 1);
  assert.equal(world.ctx.services.guildBreathScale(p), 1.1, 'Kynareth breath at rank 1');
  assert.equal(world.ctx.services.locomotionMods(p).breathScale, 1.1);
  t.diagnostic(`EARNED promotion: standing 11, rank 1 after 28 game days; Endurance ${endurance}→${endurance + 1} blessed.`);
});

test('installed data: FIXTURE Mages Guild rank 8, the real porter teleports to Wayrest at once and for free', gate, async (t) => {
  const world = await open(t);
  const { client, p } = create(world, 'guild-tp', 'Mage');
  await enter(world, p, MAGES);
  world.ctx.services.guilds.addMembership(p, 'mages', null, 8); // FIXTURE rank
  const porter = staff(world, MAGES, 'teleport');
  assert.ok(porter, 'the Mages Guild porter (faction 62)');
  let v = talkTo(client, p, porter, 'teleport');
  assert.deepEqual(v.teleport, { open: true });
  const gold = p.rpg.gold;
  client.must('npc.service', { targetId: porter.id, session: v.session, service: 'teleport', to: 'town:Wayrest/Wayrest' });
  assert.equal(p.rpg.location, 'town:Wayrest/Wayrest');
  assert.equal(p.rpg.portal, undefined, 'out of the hall');
  assert.equal(p.rpg.gold, gold);
  assert.ok(client.events('teleport').some((e) => e.location === 'town:Wayrest/Wayrest'));
  // Places the player has never heard of are refused.
  const unknown = world.ctx.services.travel.regionLocations(17).find((e) => !e.discovered && e.type !== 'ships');
  await enter(world, p, MAGES);
  v = talkTo(client, p, porter, 'teleport');
  assert.match(client.act('npc.service', { targetId: porter.id, session: v.session, service: 'teleport', to: unknown.id }).error, /not yet heard of/);
});

test('installed data: bookshelves in the Mages Guild open at rank 2 (FIXTURE ranks); a real book is read', gate, async (t) => {
  const world = await open(t);
  const { client, p } = create(world, 'guild-lib', 'Mage');
  await enter(world, p, MAGES);
  const shelf = [...world.ctx.entities.values()].find((e) => e.location === MAGES && e.containerType === 'bookshelf');
  Object.assign(p, { x: shelf.x, z: shelf.z });
  assert.match(client.act('container.open', { containerId: shelf.id }).error, /members only/);
  world.ctx.services.guilds.addMembership(p, 'mages', null, 1);
  assert.match(client.act('container.open', { containerId: shelf.id }).error, /not risen high enough .* Scribe/);
  p.rpg.guilds.mages.rank = 2;
  client.must('container.open', { containerId: shelf.id });
  const list = client.events('container').at(-1);
  assert.ok(list.books?.length || list.items?.length, 'the shelf lists its books');
  const bookId = (list.books ?? list.items)[0].bookId ?? (list.books ?? list.items)[0].id;
  client.must('container.read', { containerId: shelf.id, bookId });
  const book = client.events('book').at(-1);
  assert.ok(book.title && book.pages.length > 0, `read “${book.title}”`);
});

test('installed data: secret halls on the map, a Thieves Guild promotion marks a real place; spymaster; Stendarr', gate, async (t) => {
  const world = await open(t, { guildRandom: () => 0 });
  const { client, p } = create(world, 'guild-tg', 'Burglar');
  world.ctx.services.portals.transfer(p, { location: DAGGERFALL, x: 0, z: 0, yaw: 0 });
  // EARNED membership through the initiation quest's success event; FIXTURE rank 5 and standing 65.
  world.ctx.emit('questComplete', { player: p, quest: { name: 'O0A0AL00' } });
  assert.equal(p.rpg.guilds.thieves.rank, 0);
  const hallSpec = world.ctx.services.portals.at(DAGGERFALL).find((s) => s.to === THIEVES);
  assert.equal(p.rpg.automap.names[DAGGERFALL]?.[hallSpec.id], 'Thieves Guild', 'the hall is named on the town map');
  p.rpg.guilds.thieves.rank = 5;
  world.ctx.services.adjustReputation(p, 42, 65);
  for (const s of ['Lockpicking', 'Pickpocket', 'Stealth', 'Streetwise']) p.rpg.character.skills[s] = Math.max(p.rpg.character.skills[s] ?? 0, 70);
  await enter(world, p, THIEVES);
  const trainer = staff(world, THIEVES, 'train');
  assert.ok(trainer, 'members meet the hall’s staff');
  const known = JSON.stringify(p.rpg.travel.found);
  world.clock.advance(28 * 1440 * GAME_MINUTE_MS); // CLOCK
  let v = talkTo(client, p, trainer);
  assert.equal(p.rpg.guilds.thieves.rank, 6);
  assert.match(v.text, /Thieves Guild/);
  assert.notEqual(JSON.stringify(p.rpg.travel.found), known, 'a new place on the travel map');
  assert.ok(p.rpg.automap.notebook.some((n) => n.source === 'guild'), 'and in the notebook');
  // Spymaster at rank 4+.
  const spy = staff(world, THIEVES, 'spymaster');
  if (spy) {
    v = talkTo(client, p, spy, 'spymaster');
    assert.match(v.text, /Spymaster/);
    assert.equal(v.spymaster, true);
  }
  // Stendarr (FIXTURE membership, rank 9; guild roll 0): lethal damage leaves 10 % health.
  delete p.rpg.guilds.temple;
  world.ctx.services.guilds.addMembership(p, 'temple', 33, 9);
  world.ctx.services.hurtPlayerBy(p, 100_000, { name: 'Fixture damage' });
  assert.equal(p.rpg.character.health, Math.max(1, Math.trunc(p.rpg.character.maxHealth * 0.1)));
  assert.ok(!p.rpg.defeated);
});

test('installed data: the knights’ Seneschal grants the rank-9 house through package 13', gate, async (t) => {
  const world = await open(t);
  const { client, p } = create(world, 'guild-ko', 'Knight');
  await enter(world, p, KNIGHTS);
  world.ctx.services.guilds.addMembership(p, 'knights', 368, 9); // FIXTURE rank
  const sen = staff(world, KNIGHTS, 'house');
  assert.ok(sen, 'the Seneschal (848)');
  assert.equal(typeof world.ctx.services.property?.grantHouse, 'function', 'package 13 grantHouse');
  let v = talkTo(client, p, sen, 'house');
  for (let i = 0; i < 80 && /not ready/.test(v.text); i++) { // the town's house records load on first use
    await new Promise((r) => setTimeout(r, 100));
    v = talkTo(client, p, sen, 'house');
  }
  const houses = Object.values(p.rpg.property?.houses ?? {});
  if (houses.length) {
    assert.equal(houses[0].price, 0, 'a free house');
    assert.equal(p.rpg.guilds.knights.flags & 2, 2);
    v = talkTo(client, p, sen, 'house');
    assert.match(v.text, /already received/);
    t.diagnostic(`granted ${houses[0].interior} in ${houses[0].town}`);
  } else {
    assert.doesNotMatch(v.text, /cannot hand over|not ready/);
    assert.equal(p.rpg.guilds.knights.flags & 2, 0, 'no flag without a house');
    t.diagnostic(`no house this month: ${v.text}`);
  }
});
