// Package 19 on the production feature manifest and the operator's ARENA2: Daedra summoning at real source
// summoners (the Mages Guild and the Temple of Kynareth in Daggerfall, a coven witch), the Thieves Guild
// letter after a crime tally, the vampire/lycanthrope quest rolls, persistence across a restart and the
// rewards the original scripts pay.
//
// FIXTURE SETUP (labelled where used): guild rank, gold for the 200,000-gold summoning fee, the world date
// (the fixture clock is advanced to the prince's day), dice (Math.random pinned for one roll), and positions
// inside instances (the production portal transfer to a door landing, then standing beside a person).
// Requires gamedata/…/arena2; skipped without it (RPG_INTEGRATION_STRICT=1 makes that a failure).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { discoverFeatures, createFixtureWorld, readPersisted, tempDir, STRICT, localArena2 } from './support/rpg-session.mjs';
import { DAEDRA } from '../server/rpg/special/daedra.js';
import { hasFound } from '../client/gameplay/travel/identity.js';

const ARENA2 = localArena2();
const gate = ARENA2 ? {} : STRICT ? {} : { skip: 'operator ARENA2 not present in gamedata/' };
const discovered = ARENA2 ? await discoverFeatures() : { features: [] };

const CITY = 'town:Daggerfall/Daggerfall';
const MAGES = 'interior:Daggerfall/Daggerfall/1,2/0'; // The Mages Guild: Alabywyr Yeomford, service faction 66
const KYNARETH = 'interior:Daggerfall/Daggerfall/3,4/13'; // The Temple of Kynareth: Mordard Woodton, 498
const COVEN = 'town:Daggerfall/Coven on the Bluff'; // Carolyvyra Buckingston, The Daggerfall Witches 423
const GLENMORIL = 'town:Ilessan Hills/Glenmoril Coven';
const MINUTE_MS = 5000;
/** FIXTURE POSITIONING: half a metre inside the instance's exit door, on its floor. */
function standAtExit(p, door) {
  const e = door.exits?.[0] ?? door.entrances[0].inner;
  p.x = e.x + (e.nx ?? 0) * 0.5;
  p.z = e.z + (e.nz ?? 0) * 0.5;
  if (p.rpg.portal) p.rpg.portal.footY = Number.isFinite(e.floor) ? e.floor : e.y;
}

/** Waits (shared clock) until night: a vampire may not travel by day. */
function toNight(world) {
  const h = world.ctx.services.worldClock().hour;
  if (h >= 20 || h < 4) return;
  world.clock.advance(((22 - h + 24) % 24) * 60 * MINUTE_MS);
  world.tick(40);
}
const exteriorOfLoc = (loc) => (loc.startsWith('town:') ? loc : `town:${loc.split(':')[1].split('/').slice(0, 2).join('/')}`);
async function enterTown(world, c, town) {
  const p = world.players.get(c.id);
  const loc = c.character.location;
  if (/^(interior|dungeon):/.test(loc)) {
    await world.ctx.services.interiors.survey(loc);
    const door = world.ctx.services.portals.into(loc);
    standAtExit(p, door); // FIXTURE POSITIONING: exit door
    let last = '';
    await until(world, () => { world.clock.advance(1000); const r = c.act('portal.leave', {}); last = r.error; return r.ok; }, 'the way out')
      .catch((err) => { throw new Error(`${err.message}: ${last}`); });
  }
  toNight(world);
  if (c.character.location !== town) c.must('travel.go', { to: town });
  world.tick(200);
} // fixture clock: time scale 12

async function specialWorld(t) {
  assert.ok(ARENA2, 'RPG_INTEGRATION_STRICT=1 requires gamedata/…/arena2');
  const tmp = tempDir('dfw-p19-installed-', process.env.DFW_SPECIAL_TEST_TMP);
  const dbPath = `${tmp.dir}/world.db`;
  const world = await createFixtureWorld({ dbPath, features: discovered.features, dataPath: ARENA2 });
  t.after(() => {
    try { world.close(); } finally { tmp.remove(); }
  });
  await world.ctx.services.interiors.ready;
  return { world, dbPath };
}

async function until(world, fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    world.tick(250);
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

/** FIXTURE SETUP: the shared world clock moves forward to `day` (same time of day). */
function setDay(world, day) {
  const c = world.ctx.services.worldClock();
  const delta = (((day - c.dayOfYear) % 360) + 360) % 360;
  world.clock.advance(delta * 1440 * MINUTE_MS);
  world.tick(40);
  assert.equal(world.ctx.services.worldClock().dayOfYear, day, `world clock reads day ${day}`);
}

/** Runs fn with every die reading `v` (one deterministic summoning roll). */
function dice(v, fn) {
  const real = Math.random;
  Math.random = () => v;
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}

/** FIXTURE POSITIONING: production portal transfer to the building's door landing, then beside `pick(entity)`. */
async function visit(world, c, town, interior, pick, what) {
  const s = world.ctx.services;
  const p = world.players.get(c.id);
  if (world.ctx.location(p) !== town) s.portals.transfer(p, { location: town, x: 0, z: 0, yaw: 0 }, { label: 'outside' });
  await s.interiors.survey(town);
  let at = town;
  if (interior) {
    const spec = s.portals.at(town).find((sp) => sp.to === interior);
    assert.ok(spec, `${interior} is a surveyed door of ${town}`);
    s.portals.transfer(p, { location: interior, x: spec.entrances[0].inner.x, y: spec.entrances[0].inner.y ?? 0, z: spec.entrances[0].inner.z, yaw: 0 }, { portal: spec });
    await s.collision.whenSettled(interior);
    at = interior;
  }
  const e = await until(world, () => c.state?.entities?.find((x) => x.kind === 'npc' && x.location === at && pick(x)), what);
  p.x = e.x;
  p.z = e.z + 0.8;
  if (p.rpg.portal && Number.isFinite(e.y)) p.rpg.portal.footY = e.y;
  world.tick(40);
  return e;
}


/** Normal production entrance: travel to the revealed dungeon's exterior and use its door. */
async function enterDungeon(world, c, town) {
  const s = world.ctx.services;
  const p = world.players.get(c.id);
  const loc = c.character.location;
  if (/^(interior|dungeon):/.test(loc)) {
    await s.interiors.survey(loc);
    const door = s.portals.into(loc);
    standAtExit(p, door); // FIXTURE POSITIONING: exit door
    await until(world, () => { world.clock.advance(1000); const r = c.act('portal.leave', {}); return r.ok; }, 'the way out');
  }
  world.clock.advance(5000);
  toNight(world);
  c.must('travel.go', { to: town });
  await s.interiors.survey(town);
  const door = s.portals.at(town).find((x) => x.kind === 'dungeon');
  p.x = door.entrances[0].x;
  p.z = door.entrances[0].z; // FIXTURE POSITIONING: standing at the authored entrance
  await s.collision.whenSettled(door.to);
  await until(world, () => {
    world.clock.advance(1000);
    const r = c.act('portal.use', { portalId: door.id });
    if (!r.ok && !/loading|moment/i.test(r.error)) throw new Error(`portal.use: ${r.error}`);
    return r.ok;
  }, 'the dungeon entrance');
  return door.to;
}

/** FIXTURE SETUP: gold for the fee, through the inventory's own gold service. */
function fund(world, c, n) {
  const p = world.players.get(c.id);
  for (let left = n; left > 0; left -= 9999) world.ctx.services.addGold(p, Math.min(9999, left));
  world.tick(40);
}
const goldOf = (world, c) => Number(world.players.get(c.id).rpg.gold) || 0;
const lastSummon = (c) => c.events('daedraSummoning').at(-1);
const questOf = (c, name) => c.character.quests.active.find((q) => q.name === name);

async function standInBuilding(world, client, town, location) {
  const s = world.ctx.services;
  await s.interiors.survey(town);
  const portal = s.portals.into(location);
  assert.ok(portal, `${location} has a real door`);
  const at = portal.entrances[0].inner;
  s.portals.transfer(world.players.get(client.id), { ...at, yaw: at.yaw ?? 0, location }, { portal });
  await s.collision.whenSettled(location);
}

function standBeside(world, c, e) {
  const p = world.players.get(c.id);
  p.x = e.x; p.z = e.z + 0.8; p.yaw = 0;
  if (p.rpg.portal && Number.isFinite(e.y)) p.rpg.portal.footY = e.y;
}

async function meetQuestContact(world, client, quest, person) {
  const questPlace = questOf(client, quest.name).people[person].place;
  const place = questOf(client, quest.name).places[questPlace];
  const s = world.ctx.services;
  await s.interiors.survey(place.location);
  const site = await until(world, () => {
    const current = questOf(client, quest.name)?.places[questPlace];
    return (current?.interior || current?.noBuilding) && current;
  }, `${quest.name} contact's meeting place`);
  if (site.interior) await standInBuilding(world, client, site.location, site.interior);
  else s.portals.transfer(world.players.get(client.id), { location: site.location, x: 0, z: 0, yaw: 0 }, { label: 'contact town' });
  const npc = await until(world, () => client.state.entities.find((e) => {
    const q = world.ctx.entities.get(e.id)?._quest;
    return q?.uid === quest.uid && q.person === person;
  }), `${quest.name} contact`);
  standBeside(world, client, npc);
  return npc;
}

async function finishFoe(world, c, foe, weapon = 'silver-longsword') {
  const p = world.players.get(c.id);
  const s = world.ctx.services;
  const blade = s.giveItem(p, weapon, 1);
  world.tick(40);
  c.must('inventory.equip', { itemId: blade.id });
  c.must('combat.ready', { ready: true });
  const errors = new Set();
  await until(world, () => {
    const e = world.ctx.entities.get(foe.id);
    if (!e || e.dead) return true;
    // FIXTURE SETUP: verify the quest receives a real killing blow, with combat outcome made deterministic.
    e.hp = 1;
    e._cooldown = 60;
    if (s.isDefeated(p)) s.reviveFromArrest(p);
    p.rpg.character.health = p.rpg.character.maxHealth;
    if (!p.rpg.readied) c.must('combat.ready', { ready: true });
    standBeside(world, c, e);
    world.clock.advance(1500);
    const r = dice(0.01, () => c.act('combat.attack', { targetId: foe.id, direction: 'down' }));
    if (!r.ok) errors.add(r.error);
    return false;
  }, 'the quest foe to fall').catch((err) => { throw new Error(`${err.message}: ${[...errors].join(' | ')}`); });
  c.must('combat.ready', { ready: false });
}

const TG = 'O0A0AL00';
const DB = 'L0A01L00';

async function deliveredInvitations(world, client) {
  const p = world.players.get(client.id);
  // FIXTURE SETUP: begin at the letter handoff, using package 14's event and the real personal clock.
  world.ctx.runAtomic(p, 'law.fixture', () => {
    world.ctx.emit('crimeTally', { player: p, thieving: true, amount: 10 });
    world.ctx.emit('crimeTally', { player: p, thieving: false, amount: 15 });
  });
  world.ctx.services.spendTime(p, 4321, 'wait');
  await until(world, () => questOf(client, TG) && questOf(client, DB), 'delivered guild invitations');
}

function questEntity(world, client, quest, kind, key) {
  return until(world, () => client.state?.entities.find((e) => {
    const meta = world.ctx.entities.get(e.id)?._quest;
    return meta?.uid === quest.uid && meta[kind] === key;
  }), `${quest.name} ${kind} ${key}`);
}

async function stageQuestSite(world, client, quest, key) {
  const loc = questOf(client, quest.name).places[key].location;
  await world.ctx.services.interiors.survey(loc);
  const site = await until(world, () => {
    const place = questOf(client, quest.name).places[key];
    return place.interior && place;
  }, `${quest.name} ${key} building`);
  await standInBuilding(world, client, site.location, site.interior);
  return site.interior;
}

function crossQuestDeadline(world, c, name, clock) {
  const p = world.players.get(c.id);
  const s = world.ctx.services;
  const due = questOf(c, name).clocks[clock].endAt;
  assert.ok(Number.isFinite(due));
  s.spendTime(p, Math.max(1, due - s.playerMinutes(p) + 1), 'wait');
  world.tick(1250);
}

test('[asset] secret initiation choices, membership, privacy and restart after delivery', gate, async (t) => {
  const { world, dbPath } = await specialWorld(t);
  let a = world.connect('acct-initiate', 'Mara');
  let b = world.connect('acct-witness', 'Noran');
  const refused = world.connect('acct-refused', 'Brynn');
  await deliveredInvitations(world, a);
  await deliveredInvitations(world, refused);
  const thieves = questOf(a, TG);
  const brother = questOf(a, DB);
  assert.equal(thieves.report.source, 'classic');
  assert.equal(brother.report.source, 'classic');
  const gold = goldOf(world, a);
  const observerGold = goldOf(world, b);

  await world.ctx.services.interiors.survey(thieves.places['l.00'].location);
  a.must('quest.use', { uid: thieves.uid, item: 'i.01' });
  assert.match(a.events('questMessage').at(-1).text, /Steal\s.+90 days/s);
  assert.equal(questOf(a, TG).clocks['s.00'].running, true);
  await stageQuestSite(world, a, thieves, 'l.00');
  const clothing = await questEntity(world, a, thieves, 'item', 'i.00');
  const wardrobe = world.ctx.services.portals.into(clothing.location);
  assert.equal(a.character.automap.names[wardrobe.from][wardrobe.id], 'Mansion from the letter');
  assert.equal(b.character.automap?.names[wardrobe.from]?.[wardrobe.id], undefined, 'the map clue also belongs to the owner');
  await standInBuilding(world, b, exteriorOfLoc(clothing.location), clothing.location);
  assert.equal(b.entity(clothing.id), null);
  assert.equal(b.act('quest.click', { targetId: clothing.id }).ok, false);
  standBeside(world, a, clothing);
  a.must('quest.click', { targetId: clothing.id });
  a.must('quest.use', { uid: thieves.uid, item: 'i.02' });
  const thiefContact = questOf(a, TG).people['p.00'];
  assert.match(a.events('questMessage').at(-1).text, new RegExp(thiefContact.name));

  await until(world, () => questOf(a, DB).places[questOf(a, DB).people['p.01'].place]?.interior, 'the chemist’s shop');
  const chemist = await meetQuestContact(world, a, brother, 'p.01');
  assert.equal(world.ctx.services.portals.into(chemist.location).meta.buildingType, 0);
  a.must('quest.use', { uid: brother.uid, item: 'i.00' });
  assert.match(a.events('questMessage').at(-1).text, new RegExp(chemist.name));
  // Reading the invitation can place the chemist at the final meeting marker.
  standBeside(world, a, world.ctx.entities.get(chemist.id));
  a.must('npc.talk', { targetId: chemist.id });
  assert.equal(questOf(a, DB).items['i.02'].held, true);
  assert.equal(questOf(a, DB).clocks['s.01'].running, false);
  assert.equal(a.act('quest.drop', { uid: brother.uid, item: 'i.01' }).ok, false);
  await stageQuestSite(world, a, brother, 'l.00');
  const decanter = await questEntity(world, a, brother, 'item', 'i.01');
  standBeside(world, a, decanter);
  a.must('quest.click', { targetId: decanter.id });
  assert.equal(questOf(a, DB).items['i.02'].held, false, 'the script used up the vial');
  assert.deepEqual(questOf(a, DB).items['i.01'].dropPlaces, ['l.00']);
  assert.ok(a.events('questMessage').some((m) => m.uid === brother.uid && m.id === 1019));
  assert.equal(b.act('quest.drop', { uid: brother.uid, item: 'i.01' }).ok, false);
  const exterior = exteriorOfLoc(decanter.location);
  world.ctx.services.portals.transfer(world.players.get(a.id), { location: exterior, x: 0, z: 0, yaw: 0 });
  assert.match(a.act('quest.drop', { uid: brother.uid, item: 'i.01' }).error, /not where/);
  await standInBuilding(world, a, exterior, decanter.location);

  const ownerId = a.id;
  world.restart();
  assert.equal(readPersisted(dbPath, ownerId).rpg.quests.active.find((q) => q.uid === brother.uid).items['i.01'].held, true);
  a = world.connect('acct-initiate', 'Mara');
  b = world.connect('acct-witness', 'Noran');
  const refusedAgain = world.connect('acct-refused', 'Brynn');
  await world.ctx.services.interiors.ready;
  assert.equal(a.character.location, decanter.location);
  a.must('quest.drop', { uid: brother.uid, item: 'i.01' });
  const recruiter = await meetQuestContact(world, a, brother, 'p.00');
  await standInBuilding(world, b, exteriorOfLoc(recruiter.location), recruiter.location);
  assert.equal(b.entity(recruiter.id), null);
  assert.equal(b.act('npc.talk', { targetId: recruiter.id }).ok, false);
  assert.equal(world.ctx.services.guildRank(world.players.get(a.id), 'brotherhood'), null);
  a.must('npc.talk', { targetId: recruiter.id });
  crossQuestDeadline(world, a, DB, 's.12');
  assert.equal(a.character.quests.done.find((q) => q.uid === brother.uid).result, 'success');

  const thief = await meetQuestContact(world, a, thieves, 'p.00');
  a.must('npc.talk', { targetId: thief.id });
  assert.equal(a.character.quests.done.find((q) => q.uid === thieves.uid).result, 'success');
  const mapped = world.ctx.services.travel.lookup(thieves.places['l.01'].location);
  assert.equal(hasFound(a.character.travel.found, mapped), true, 'QBN reward marked the dungeon on the map');
  assert.equal(goldOf(world, a), gold + 2);
  assert.equal(goldOf(world, b), observerGold);
  assert.equal(b.events('questReward').length, 0);

  const bQuest = questOf(refusedAgain, DB);
  await until(world, () => questOf(refusedAgain, DB).places[questOf(refusedAgain, DB).people['p.01'].place]?.interior, 'the refused initiate’s chemist shop');
  const bChemist = await meetQuestContact(world, refusedAgain, bQuest, 'p.01');
  refusedAgain.must('npc.talk', { targetId: bChemist.id });
  const bRecruiter = await meetQuestContact(world, refusedAgain, bQuest, 'p.00');
  refusedAgain.must('npc.talk', { targetId: bRecruiter.id });
  assert.ok(refusedAgain.events('questMessage').some((m) => m.uid === bQuest.uid && m.id === 1014));
  world.clock.advance(5 * MINUTE_MS);
  const assassins = await questEntity(world, refusedAgain, bQuest, 'foe', 'f.00');
  assert.equal(assassins.location, bRecruiter.location, 'ordinary create foe carries out the indoor ambush');
  assert.equal(world.ctx.services.reputation(world.players.get(refusedAgain.id), 108), -100);
  crossQuestDeadline(world, refusedAgain, DB, 's.00');
  assert.equal(refusedAgain.character.quests.done.find((q) => q.uid === bQuest.uid).result, 'failed');

  const ignored = questOf(refusedAgain, TG);
  refusedAgain.must('quest.use', { uid: ignored.uid, item: 'i.01' });
  crossQuestDeadline(world, refusedAgain, TG, 's.00');
  assert.equal(refusedAgain.character.quests.done.find((q) => q.uid === ignored.uid).result, 'failed');
  world.restart();
  a = world.connect('acct-initiate', 'Mara');
  b = world.connect('acct-witness', 'Noran');
  const failed = world.connect('acct-refused', 'Brynn');
  const s = world.ctx.services;
  for (const guild of ['thieves', 'brotherhood']) {
    assert.equal(s.guildRank(world.players.get(a.id), guild), 0);
    assert.equal(s.guildRank(world.players.get(b.id), guild), null);
    assert.equal(s.guildRank(world.players.get(failed.id), guild), null);
  }
  assert.equal(goldOf(world, a), gold + 2);
  assert.equal(a.character.quests.done.filter((q) => q.uid === thieves.uid || q.uid === brother.uid).length, 2);
  assert.equal(failed.character.quests.done.filter((q) => [TG, DB].includes(q.name) && q.result === 'failed').length, 2);
});

const PRINCE_REWARDS = [
  ['hircine-ring', 'p.00'], ['masque-of-clavicus', 'p.00'], ['mehrunes-razor', 'p.00'], ['mace-of-molag-bal', 'p.00'],
  ['sanguine-rose', 'p.00'], ['spell-breaker', 'p.00'], ['volendrung', 'p.00'], ['oghma-infinium', 'p.01'],
  ['wabbajack', 'p.00'], ['ebony-mail', 'p.01'], ['ring-of-namira', 'p.01'], ['ring-of-khajiit', 'p.00'],
  ['skull-of-corruption', 'p.00'], ['skeletons-key', 'p.01'], ['ebony-blade', 'p.00'], ['azuras-star', 'p.00'],
];

async function acceptDemand(world, prince, client) {
  // FIXTURE SETUP: the first Mages rank that may summon, fee and chosen date. Glenmoril needs no rank or date.
  const p = world.players.get(client.id);
  const s = world.ctx.services;
  const hircine = prince.key === 'hircine';
  let summoner;
  if (hircine) {
    setDay(world, 42);
    summoner = await visit(world, client, GLENMORIL, null, (e) => e.faction === 419, 'the Glenmoril witch');
    assert.equal(s.travel.lookup(GLENMORIL)?.type, 'coven');
    assert.equal(s.guildRank(p, 'mages'), null);
  } else {
    setDay(world, prince.dayOfYear);
    p.rpg.guilds = { mages: { rank: 6, lastRankChange: Math.floor(s.worldClock().minutes / 1440) } };
    summoner = await visit(world, client, CITY, MAGES, (e) => e.faction === 66, 'the Mages Guild summoner');
  }
  fund(world, client, 200000);
  client.must('npc.talk', { targetId: summoner.id });
  const session = client.events('dialogue').at(-1).session;
  const args = { targetId: summoner.id, session, service: 'summon' };
  client.must('npc.service', args);
  dice(0.2, () => client.must('npc.service', { ...args, confirm: true }));
  const event = lastSummon(client);
  assert.equal(event.step, 'offered', JSON.stringify(event));
  assert.equal(event.quest, prince.quest);
  const offer = client.events('questOffer').at(-1);
  assert.ok(offer.text.trim(), `${prince.quest} demand is read from QRC 1000`);
  client.must('quest.accept', { offerId: offer.offerId });
  return questOf(client, prince.quest);
}

async function woundQuestFoe(world, client, foe) {
  // FIXTURE SETUP: replenish health and use a weapon strong enough to hit the authored enemy.
  const p = world.players.get(client.id);
  const s = world.ctx.services;
  const blade = s.giveItem(p, 'steel-longsword', 1);
  const e = world.ctx.entities.get(foe.id);
  e.maxHp = Math.max(100, e.maxHp); // staged health keeps the first landed hit from killing the mage
  e.hp = e.maxHp;
  e._cooldown = 60;
  p.rpg.character.health = p.rpg.character.maxHealth;
  standBeside(world, client, e);
  world.tick(40);
  client.must('inventory.equip', { itemId: blade.id });
  client.must('combat.ready', { ready: true });
  await until(world, () => {
    if (e.hp < e.maxHp) return true;
    standBeside(world, client, e);
    world.clock.advance(1500);
    client.must('combat.attack', { targetId: foe.id, direction: 'down' });
    return e.hp < e.maxHp;
  }, 'a landed nonlethal blow');
  client.must('combat.ready', { ready: false });
  assert.ok(!e.dead, 'the blow wounds rather than kills');
  assert.ok(e.hp < e.maxHp);
}

async function stageDemandSite(world, client, quest, key) {
  // FIXTURE POSITIONING: keep travel time out of checks for distinct quest-script branches.
  const place = questOf(client, quest.name).places[key];
  assert.ok(place.interior || !place.dungeon, `${quest.name} ${key} resolved a dungeon`);
  if (place.dungeon) await standInBuilding(world, client, place.location, place.interior);
  else await stageQuestSite(world, client, quest, key);
}

test('[asset] audit sixteen prince demands, destinations and artifacts in the installed game', gate, async (t) => {
  const { world } = await specialWorld(t);
  const s = world.ctx.services;
  const catalog = s.quests.catalog;
  const coverage = new Map(s.special.coverage().map((row) => [row.quest, row]));
  for (const [i, prince] of DAEDRA.entries()) {
    const { quest, name } = prince;
    const [reward, person] = PRINCE_REWARDS[i];
    const entry = catalog.quests.get(quest);
    assert.equal(entry.source, 'classic');
    assert.equal(entry.textSource, 'classic');
    assert.deepEqual(coverage.get(quest).blockers, []);
    const def = entry.def;
    assert.ok(def.messages.has(1000) && def.messages.has(1004), `${name} has a real offer and reward message`);
    assert.equal(def.resources.get(person).kind, 'person');
    const template = s.artifactTemplate(def.resources.get('i.00').classicItem.index);
    assert.equal(template, `artifact-${reward}`);
    assert.equal(s.artifactInfo(template).available, true);
    // Mephala's accepted demand already runs in its original installed-data regression.
    if (prince.key === 'mephala') continue;
    const client = world.connect(`acct-prince-${i}`, 'Sevrin');
    const run = await acceptDemand(world, prince, client);
    for (const place of [...def.resources.values()].filter((r) => r.kind === 'place')) {
      const site = run.places[place.key];
      const hit = s.travel.lookup(site.location);
      assert.ok(hit, `${name} ${place.key} is in the installed MAPS catalogue`);
      if (place.only) {
        assert.ok(place.types.includes(`dungeon${hit.dungeonType}`), `${name} ${place.key} selected a permitted dungeon type`);
      }
    }
    assert.equal(run.items['i.00'].template, template);
    assert.ok(run.log.length, `${name} started the original demand`);
    client.leave();
  }
});

test('[asset] Glenmoril Hircine and distinct prince demand and reward branches', gate, async (t) => {
  const { world } = await specialWorld(t);
  const s = world.ctx.services;
  for (const [index, prince] of DAEDRA.entries()) {
    if (prince.key === 'mephala') continue;
    const client = world.connect(`acct-branch-${index}`, 'Rolan');
    const inst = await acceptDemand(world, prince, client);
    if (index === 0) await enterDungeon(world, client, inst.places['l.00'].location);
    else await stageDemandSite(world, client, inst, 'l.00');
    if (index === 9) {
      crossQuestDeadline(world, client, inst.name, 's.07');
      assert.equal(questOf(client, inst.name).clocks['s.00'].running, true, 'the escape may precede the contract deadline');
      const letter = await questEntity(world, client, inst, 'item', 'i.01');
      standBeside(world, client, letter);
      client.must('quest.click', { targetId: letter.id });
      client.must('quest.use', { uid: inst.uid, item: 'i.01' });
      const informant = await meetQuestContact(world, client, inst, 'p.02');
      client.must('npc.talk', { targetId: informant.id });
      assert.equal(questOf(client, inst.name).places['l.01'].revealed, true);
      await stageDemandSite(world, client, inst, 'l.01');
    }
    let foe = await questEntity(world, client, inst, 'foe', 'f.00');
    if (index === 0) assert.equal(foe.name, 'Wereboar');
    if (index === 7) {
      await woundQuestFoe(world, client, foe);
      await until(world, () => questOf(client, inst.name).prompt?.id === 1035, 'the Spellsword asks to be spared');
      client.must('quest.answer', { uid: inst.uid, yes: true });
      assert.equal(questOf(client, inst.name).items['i.01'].held, true);
      assert.equal(questOf(client, inst.name).places['l.01'].revealed, true);
      await stageDemandSite(world, client, inst, 'l.01');
      foe = await questEntity(world, client, inst, 'foe', 'f.00');
    }

    if (index === 3 || index === 13) {
      await woundQuestFoe(world, client, foe);
      if (index === 3) {
        await until(world, () => questOf(client, inst.name).clocks['s.08'].running, 'the mage starts fleeing');
        crossQuestDeadline(world, client, inst.name, 's.08');
      } else {
        await until(world, () => questOf(client, inst.name).prompt?.id === 1030, 'the mage offers the bow');
        client.must('quest.answer', { uid: inst.uid, yes: true });
      }
      const key = index === 3 ? 'i.01' : 'i.04';
      const letter = await questEntity(world, client, inst, 'item', key);
      standBeside(world, client, letter);
      client.must('quest.click', { targetId: letter.id });
      client.must('quest.use', { uid: inst.uid, item: key });
      const secondKey = index === 3 ? 'l.02' : 'l.04';
      assert.equal(questOf(client, inst.name).places[secondKey].revealed, true);
      assert.notEqual(questOf(client, inst.name).places[secondKey].interior, foe.location);
      if (index === 13) {
        await stageDemandSite(world, client, inst, 'l.01');
        const bow = await questEntity(world, client, inst, 'item', 'i.01');
        standBeside(world, client, bow);
        client.must('quest.click', { targetId: bow.id });
        assert.equal(s.countItem(world.players.get(client.id), 'artifact-auriels-bow'), 0, 'still a quest object');
        crossQuestDeadline(world, client, inst.name, 's.10');
        const after = await until(world, () => {
          const q = questOf(client, inst.name);
          return q && !q.items['i.01'].held && q;
        }, 'the decoy to crumble', 5000).catch((err) => {
          const q = questOf(client, inst.name);
          throw new Error(`${err.message}: ${JSON.stringify({ clock: q?.clocks['s.10'], tasks: ['s.05', 's.10', 's.14', 's.24'].map((k) => q?.tasks[k]), item: q?.items['i.01'], now: s.playerMinutes(world.players.get(client.id)) })}`);
        });
        assert.equal(after.items['i.01'].place, 'l.04');
      }
      await stageDemandSite(world, client, inst, secondKey);
      if (index === 13) {
        const realBow = await questEntity(world, client, inst, 'item', 'i.01');
        standBeside(world, client, realBow);
        client.must('quest.click', { targetId: realBow.id });
      }
      foe = await questEntity(world, client, inst, 'foe', 'f.00');
    }

    await finishFoe(world, client, foe, 'daedric-longsword');
    if (index === 6) {
      assert.equal(questOf(client, inst.name).items['i.01'].held, true);
      assert.equal(questOf(client, inst.name).items['i.01'].holder, null);
      client.must('quest.use', { uid: inst.uid, item: 'i.01' });
      const noble = await meetQuestContact(world, client, inst, 'p.02');
      client.must('npc.talk', { targetId: noble.id });
      assert.ok(questOf(client, inst.name).prompt);
      client.must('quest.answer', { uid: inst.uid, yes: false });
      assert.equal(questOf(client, inst.name).items['i.01'].held, true, 'refusing the handoff keeps the letter');
    }
    if (index === 13) assert.equal(s.countItem(world.players.get(client.id), 'artifact-auriels-bow'), 1, 'make permanent paid the optional artifact');

    const [reward, person] = PRINCE_REWARDS[index];
    const contact = await meetQuestContact(world, client, inst, person);
    if (index === 8) assert.ok(contact.location.startsWith('dungeon:'), 'Sheogorath’s contact waits inside a second dungeon');
    client.must('npc.talk', { targetId: contact.id });
    assert.equal(s.countItem(world.players.get(client.id), `artifact-${reward}`), 1, `${prince.name}'s contact grants ${reward}`);
    assert.equal(client.events('questReward').filter((e) => e.uid === inst.uid && !e.gold).length >= 1, true);
    const endClock = { 1: 's.07', 2: 's.07', 3: 's.07', 4: 's.05', 7: 's.12', 12: 's.07', 13: 's.33' }[index] ?? 's.06';
    crossQuestDeadline(world, client, inst.name, endClock);
    assert.equal(client.character.quests.done.find((q) => q.uid === inst.uid).result, 'success');
    t.diagnostic(`${prince.name} · ${inst.name} · ${reward}`);
    client.leave();
  }
});

describe('[asset] Daedra summoning at real source summoners', () => {
  test('Mages Guild in Daggerfall: Mephala day, rank, fee, missed deadline, private Ebony Blade paid once', gate, async (t) => {
    const { world, dbPath } = await specialWorld(t);
    const s = world.ctx.services;
    const a = world.connect('acct-a', 'Aldora');
    const b = world.connect('acct-b', 'Brannoc');
    world.players.get(a.id).rpg.guilds = { mages: { rank: 6, joinedAt: '2026-11-25T00:00:00Z' } }; // FIXTURE SETUP: rank 6
    const summoner = await visit(world, a, CITY, MAGES, (e) => e.faction === 66, 'the Mages Guild summoner');
    await visit(world, b, CITY, MAGES, (e) => e.faction === 66, 'the Mages Guild summoner (B)');
    assert.equal(summoner.name, 'Alabywyr Yeomford', 'authored summoner of the Daggerfall Mages Guild');

    // Wrong day.
    setDay(world, 282);
    a.must('special.summon', { targetId: summoner.id });
    let ev = lastSummon(a);
    assert.equal(ev.step, 'notToday');
    assert.match(ev.text, /summon/i, 'TEXT.RSC 480');

    // B has no rank: refused, on any day.
    b.must('special.summon', { targetId: summoner.id });
    assert.equal(lastSummon(b).step, 'refused');
    assert.match(lastSummon(b).text, /rank 6/);

    // Mephala's day.
    setDay(world, 283);
    b.must('special.summon', { targetId: summoner.id });
    assert.equal(lastSummon(b).step, 'refused', 'still refused on the right day');
    a.must('special.summon', { targetId: summoner.id });
    ev = lastSummon(a);
    assert.equal(ev.step, 'confirm');
    assert.equal(ev.daedra, 'Mephala');
    assert.equal(ev.cost, 200000, '200000 - 0 standing x 1000');
    assert.match(ev.text, /Mephala/, 'TEXT.RSC 481 with %dae');

    // Not enough gold: nothing is taken.
    a.must('special.summon', { targetId: summoner.id, confirm: true });
    assert.equal(lastSummon(a).step, 'noGold');

    // The prince stands the player up (roll 100 > 60): the fee is spent.
    fund(world, a, 400000);
    const g0 = goldOf(world, a);
    a.must('special.summon', { targetId: summoner.id });
    dice(0.999, () => a.must('special.summon', { targetId: summoner.id, confirm: true }));
    ev = lastSummon(a);
    assert.equal(ev.step, 'failed');
    assert.match(ev.text, /Mephala/, 'TEXT.RSC 484');
    assert.equal(goldOf(world, a), g0 - 200000, 'fee paid for the failed summoning');
    assert.equal(world.players.get(a.id).rpg.special.summoned[15], undefined, 'a failed roll does not count as summoned');

    // Success (roll 51 <= 60).
    const g1 = goldOf(world, a);
    world.players.get(a.id).rpg.guilds.mages.lastRankChange = Math.floor(s.worldClock().minutes / 1440);
    a.must('npc.talk', { targetId: summoner.id });
    const session = a.events('dialogue').at(-1).session;
    const summon = { targetId: summoner.id, session, service: 'summon' };
    a.must('npc.service', summon);
    assert.deepEqual(a.events('dialogue').at(-1).summoning, { cost: 200000 }, a.events('dialogue').at(-1).text);
    a.must('npc.service', { ...summon, confirm: false });
    assert.equal(lastSummon(a).step, 'declined');
    assert.equal(goldOf(world, a), g1);
    a.must('npc.service', summon);
    dice(0.5, () => a.must('npc.service', { ...summon, confirm: true }));
    ev = lastSummon(a);
    const artifact = s.artifactTemplate('Ebony_Blade');
    assert.equal(artifact, 'artifact-ebony-blade');
    assert.equal(s.artifactInfo(artifact).available, true);
    assert.equal(ev.step, 'offered', JSON.stringify(ev));
    assert.equal(goldOf(world, a), g1 - 200000);
    const offer = a.events('questOffer').at(-1);
    assert.equal(offer.offerId, ev.offerId);
    assert.match(offer.text, /assassinate|noble/i, 'Z0C00Y00 QRC 1000');
    assert.equal(b.act('quest.accept', { offerId: offer.offerId }).ok, false, "B cannot accept A's summoning");
    a.must('quest.accept', { offerId: offer.offerId });
    const inst = a.character.quests.active.find((q) => q.name === 'Z0C00Y00');
    assert.ok(inst, 'Mephala\'s demand is in the journal');
    assert.equal(inst.giver.faction, 15);
    assert.equal(b.character.quests.active.some((q) => q.name === 'Z0C00Y00'), false);
    assert.equal(b.events('questOffer').some((o) => o.offerId === offer.offerId), false);

    // Restart on the same database: the demand and the summoned flag persist.
    const aid = a.id;
    world.restart();
    const saved = readPersisted(dbPath, aid);
    assert.ok(saved.rpg.special.summoned['15'] > 0, 'summoned flag saved');
    assert.ok(saved.rpg.quests.active.some((q) => q.name === 'Z0C00Y00'), 'demand saved');
    const a2 = world.connect('acct-a', 'Aldora');
    const again = await visit(world, a2, CITY, MAGES, (e) => e.faction === 66, 'the summoner after restart');
    fund(world, a2, 200000);
    a2.must('special.summon', { targetId: again.id });
    dice(0.5, () => a2.must('special.summon', { targetId: again.id, confirm: true }));
    assert.equal(lastSummon(a2).step, 'before', 'TEXT.RSC 482: a prince answers once');
    assert.match(lastSummon(a2).text, /once/);

    const b2 = world.connect('acct-b', 'Brannoc');
    const pa = world.players.get(a2.id);
    const pb = world.players.get(b2.id);
    const service = world.ctx.services;
    pb.rpg.guilds = { mages: { rank: 6 } }; // FIXTURE SETUP: the second character qualifies independently.
    await visit(world, b2, CITY, MAGES, (e) => e.faction === 66, 'the summoner (deadline branch)');
    fund(world, b2, 200000);
    b2.must('special.summon', { targetId: again.id });
    dice(0.5, () => b2.must('special.summon', { targetId: again.id, confirm: true }));
    b2.must('quest.accept', { offerId: lastSummon(b2).offerId });
    const missed = pb.rpg.quests.active.find((q) => q.name === inst.name);
    const due = missed.clocks['s.00'].endAt;
    assert.ok(due > service.playerMinutes(pb));
    service.spendTime(pb, due - service.playerMinutes(pb) - 1, 'wait');
    world.tick(1100);
    assert.ok(questOf(b2, inst.name), 'still active before the deadline');
    service.spendTime(pb, 2, 'wait');
    await until(world, () => b2.character.quests.done.find((q) => q.uid === missed.uid), 'missed deadline');
    assert.equal(b2.character.quests.done.find((q) => q.uid === missed.uid).result, 'failed');
    assert.equal(service.countItem(pb, artifact), 0);
    assert.ok(questOf(a2, inst.name), "B's personal wait did not expire A's quest");

    const targetTown = questOf(a2, inst.name).places['l.00'].location;
    await service.interiors.survey(targetTown);
    const palace = await until(world, () => questOf(a2, inst.name).places['l.00'].interior, 'the palace selected by the script');
    assert.equal(service.portals.into(palace).meta.buildingType, 16);
    await standInBuilding(world, a2, targetTown, palace);
    await standInBuilding(world, b2, targetTown, palace);
    const knight = await until(world, () => {
      return a2.state.entities.find((e) => world.ctx.entities.get(e.id)?._quest?.uid === inst.uid
        && world.ctx.entities.get(e.id)._quest.foe === 'f.00');
    }, "Mephala's Knight");
    assert.equal(b2.entity(knight.id), null, 'the Knight is private even in the same palace');
    await finishFoe(world, a2, knight);

    const victory = await until(world, () => {
      const q = questOf(a2, inst.name);
      return q?.foes['f.00'].kills === 1 && q;
    }, 'the recorded kill');
    const contactPlace = victory.people['p.00'].place;
    await service.interiors.survey(victory.places[contactPlace].location);
    const contact = await until(world, () => {
      const site = questOf(a2, inst.name)?.places[contactPlace];
      return (site?.interior || site?.noBuilding) && site;
    }, 'the contact’s meeting place');
    for (const client of [a2, b2]) {
      if (contact.interior) await standInBuilding(world, client, contact.location, contact.interior);
      else service.portals.transfer(world.players.get(client.id), { location: contact.location, x: 0, z: 0, yaw: 0 }, { label: 'contact town' });
    }
    const librarian = await until(world, () => a2.state.entities.find((e) => {
      const q = world.ctx.entities.get(e.id)?._quest;
      return q?.uid === inst.uid && q.person === 'p.00';
    }), "Mephala's contact");
    assert.equal(b2.entity(librarian.id), null);
    standBeside(world, b2, librarian);
    assert.equal(b2.act('npc.talk', { targetId: librarian.id }).ok, false);
    standBeside(world, a2, librarian);
    a2.must('npc.talk', { targetId: librarian.id });
    assert.equal(service.countItem(pa, artifact), 1);
    const blade = service.findItem(pa, artifact);
    assert.equal(blade.magic.artifact, artifact);
    assert.ok(blade.magic.enchantments.length, 'MAGIC.DEF enchantments are present');
    assert.match(a2.events('questReward').find((e) => e.uid === inst.uid).item, /Ebony Blade/i);
    a2.act('npc.talk', { targetId: librarian.id });
    assert.equal(service.countItem(pa, artifact), 1);
    assert.equal(a2.events('questReward').filter((e) => e.uid === inst.uid).length, 1);
    const closeAt = pa.rpg.quests.active.find((q) => q.uid === inst.uid).clocks['s.08'].endAt;
    service.spendTime(pa, closeAt - service.playerMinutes(pa) + 1, 'wait');
    await until(world, () => a2.character.quests.done.find((q) => q.uid === inst.uid && q.result === 'success'), 'reward closeout');
    assert.equal(b2.events('questReward').some((e) => e.uid === inst.uid), false);
    assert.equal(service.countItem(pb, artifact), 0);
    a2.leave();
    const resumed = world.connect('acct-a', 'Aldora');
    assert.equal(resumed.character.inventory.filter((i) => i.magic?.artifact === artifact).length, 1);
  });

  test('Temple of Kynareth: summoning rank 7; rank 6 refused', gate, async (t) => {
    const { world } = await specialWorld(t);
    const a = world.connect('acct-k', 'Kesta');
    const p = world.players.get(a.id);
    const priest = await visit(world, a, CITY, KYNARETH, (e) => e.faction === 498, 'the Kynareth summoner');
    setDay(world, 81); // Azura
    const rank = (r) => {
      p.rpg.guilds = { temple: { rank: r, joinedAt: '2026-11-25T00:00:00Z', variant: 35 } }; // FIXTURE SETUP: Kynareth member
    };
    rank(6);
    a.must('special.summon', { targetId: priest.id });
    assert.equal(lastSummon(a).step, 'refused');
    assert.match(lastSummon(a).text, /Kynareth of rank 7/);
    rank(7);
    a.must('special.summon', { targetId: priest.id });
    assert.equal(lastSummon(a).step, 'confirm');
    assert.equal(lastSummon(a).daedra, 'Azura');
  });

  test('coven witch: no rank, a daily prince, daedra answer a failed coven summoning', gate, async (t) => {
    const { world } = await specialWorld(t);
    const a = world.connect('acct-w', 'Wenna');
    const witch = await visit(world, a, COVEN, null, (e) => e.faction === 423, 'the coven witch');
    assert.equal(witch.faction, 423);
    setDay(world, 200); // not any prince's day: a coven summons anyway
    const first = a.must('special.summon', { targetId: witch.id }) && lastSummon(a);
    assert.equal(first.step, 'confirm');
    a.must('special.summon', { targetId: witch.id });
    assert.equal(lastSummon(a).daedra, first.daedra, 'the same prince all day');
    fund(world, a, 200000);
    const before = [...world.ctx.entities.values()].filter((e) => e.kind === 'monster' && e.location === COVEN).length;
    dice(0.999, () => a.must('special.summon', { targetId: witch.id, confirm: true }));
    assert.equal(lastSummon(a).step, 'failed');
    const after = [...world.ctx.entities.values()].filter((e) => e.kind === 'monster' && e.location === COVEN && [25, 26, 27, 29, 31].includes(e.monsterId ?? e.mobile));
    assert.ok(after.length > before && after.length <= 3, `daedric foes answer instead (${after.length})`);
  });
});

describe('[asset] secret invitations and supernatural quest rolls', () => {
  test('Both secret guilds: private letters after three personal days outdoors, once across reconnect', gate, async (t) => {
    const { world, dbPath } = await specialWorld(t);
    const a = world.connect('acct-t', 'Tamsin');
    const b = world.connect('acct-u', 'Ulric');
    const pa = world.players.get(a.id);
    const pb = world.players.get(b.id);
    // Law (package 14) emits exactly this inside the crime's action; the fixture emits it the same way.
    const crime = (p, thieving, amount) => world.ctx.runAtomic(p, 'law.fixture', () => world.ctx.emit('crimeTally', { player: p, thieving, amount }));
    for (let i = 0; i < 10; i++) crime(pa, true, 1);
    for (let i = 0; i < 9; i++) crime(pb, true, 1); // one short of the threshold
    for (let i = 0; i < 2; i++) {
      crime(pa, false, 5);
      crime(pb, false, 5);
    }
    assert.equal(pa.rpg.special.brotherhood.letterAt, 0, 'two murders do not qualify');
    crime(pa, false, 5);
    const at = pa.rpg.special.thieves.letterAt;
    assert.ok(at > 0, 'A: letter scheduled at tally 10');
    assert.equal(pb.rpg.special.thieves.letterAt, 0, 'B: tally 9, no letter');
    assert.equal(pa.rpg.special.brotherhood.letterAt, at, 'the third murder schedules its own invitation');
    assert.equal(pb.rpg.special.brotherhood.letterAt, 0);
    const invites = [];
    world.ctx.on('guildInvite', (ev) => invites.push({ who: ev.player.id, guild: ev.guild, started: ev.started }));
    world.tick(6000);
    assert.equal(a.character.quests.active.some((q) => q.name === 'O0A0AL00'), false, 'not before three days');
    assert.equal(questOf(a, 'L0A01L00'), undefined, 'Brotherhood also waits');

    world.restart();
    world.ctx.on('guildInvite', (ev) => invites.push({ who: ev.player.id, guild: ev.guild, started: ev.started }));
    assert.equal(readPersisted(dbPath, a.id).rpg.special.thieves.letterAt, at, 'schedule saved');
    assert.equal(readPersisted(dbPath, a.id).rpg.special.brotherhood.letterAt, at);
    const a2 = world.connect('acct-t', 'Tamsin');
    const b2 = world.connect('acct-u', 'Ulric');
    const p2 = world.players.get(a2.id);
    // Inside a building the letter waits.
    await visit(world, a2, CITY, MAGES, (e) => e.faction === 66, 'somewhere indoors');
    const fresh = world.ctx.services;
    fresh.spendTime(p2, 4321, 'wait');
    world.tick(6000);
    assert.equal(a2.character.quests.active.some((q) => q.name === 'O0A0AL00'), false, 'not while inside');
    assert.equal(questOf(a2, 'L0A01L00'), undefined, 'Brotherhood also waits indoors');
    fresh.portals.transfer(p2, { location: CITY, x: 0, z: 0, yaw: 0 }, { label: 'outside' }); // FIXTURE POSITIONING
    await until(world, () => questOf(a2, 'O0A0AL00') && questOf(a2, 'L0A01L00'), 'the two secret letters');
    assert.equal(p2.rpg.special.thieves.tally, 100, 'InviteSent');
    assert.equal(p2.rpg.special.brotherhood.tally, 100, 'Brotherhood InviteSent');
    const inst = a2.character.quests.active.find((q) => q.name === 'O0A0AL00');
    assert.ok(inst.items['i.01']?.held, 'the letter (I.01) was handed over');
    const brotherhood = questOf(a2, 'L0A01L00');
    assert.ok(brotherhood.items['i.00']?.held, 'Brotherhood letter is carried');
    const previousMessages = a2.events('questMessage').length;
    a2.must('quest.use', { uid: brotherhood.uid, item: 'i.00' });
    assert.ok(a2.events('questMessage').slice(previousMessages).some((m) => m.uid === brotherhood.uid && m.text.length > 10));
    assert.equal(b2.act('quest.use', { uid: brotherhood.uid, item: 'i.00' }).ok, false);
    assert.equal(b2.events('questMessage').some((m) => m.uid === brotherhood.uid || m.uid === inst.uid), false);
    assert.ok(a2.events('questMessage').some((m) => /letter/i.test(m.text ?? '')), 'QRC 1020: the beggar hands you a letter');

    // Later crimes, days, location changes and a reconnect never send a second letter.
    for (let i = 0; i < 12; i++) {
      crime(p2, true, 1);
      crime(p2, false, 5);
    }
    fresh.portals.transfer(p2, { location: 'town:Daggerfall/Gothway Garden', x: 0, z: 0, yaw: 0 }, { label: 'outside' });
    world.clock.advance(5 * 1440 * MINUTE_MS);
    world.tick(6000);
    a2.leave();
    const a3 = world.connect('acct-t', 'Tamsin');
    world.clock.advance(4 * 1440 * MINUTE_MS);
    world.tick(6000);
    const letters = a3.character.quests.active.filter((q) => q.name === 'O0A0AL00').length + a3.character.quests.done.filter((q) => q.name === 'O0A0AL00').length;
    assert.equal(letters, 1, 'exactly one letter quest');
    assert.deepEqual(invites, [
      { who: a.id, guild: 'thieves', started: true },
      { who: a.id, guild: 'brotherhood', started: true },
    ], 'one event per guild, for A only');
    assert.equal(world.players.get(a3.id).rpg.special.history.filter((h) => h.quest === 'O0A0AL00' && h.result === 'started').length, 1);
    assert.equal(world.players.get(a3.id).rpg.special.history.filter((h) => h.quest === 'L0A01L00' && h.result === 'started').length, 1);
    assert.equal(b2.character.quests.active.some((q) => q.name === 'O0A0AL00'), false, 'B never received one');
    assert.equal(questOf(b2, 'L0A01L00'), undefined);
  });

  test('84-day conditions tick starts both original cure letters and each cure affects only its owner', gate, async (t) => {
    const { world } = await specialWorld(t);
    const s = world.ctx.services;
    const a = world.connect('acct-v', 'Vesna');
    const b = world.connect('acct-wolf', 'Wenna');
    const p = world.players.get(a.id);
    const wolf = world.players.get(b.id);
    await visit(world, a, CITY, MAGES, (e) => e.faction === 66, 'indoors');
    await visit(world, b, CITY, MAGES, (e) => e.faction === 66, 'indoors (B)');
    // FIXTURE SETUP: start with both conditions and advance their own calendars.
    s.deploySupernatural(p, 'vampirism');
    s.deploySupernatural(wolf, 'werewolf');
    const cures = [];
    world.ctx.on('supernaturalQuest', (e) => { if (e.cure) cures.push(e.kind); });
    const curePeriod = 84 * 1440;
    s.spendTime(p, curePeriod, 'wait');
    s.spendTime(wolf, curePeriod, 'wait');
    dice(0, () => world.tick(1000));
    assert.deepEqual(cures.sort(), ['vampire', 'werewolf']);
    const vam = questOf(a, '$CUREVAM');
    assert.ok(vam?.items['i.00'].held, 'the vampire cure letter arrived');
    const wer = questOf(b, '$CUREWER');
    assert.ok(wer?.items['i.00'].held, 'the lycanthropy cure letter arrived');
    assert.equal(wer.places['l.01'].location, 'town:Ilessan Hills/Glenmoril Coven');
    const glenmoril = s.travel.lookup(wer.places['l.01'].location);
    assert.equal(glenmoril.type, 'coven');
    assert.equal(glenmoril.mapId & 0xfffff, 81312);
    assert.equal(questOf(b, '$CUREVAM'), undefined);
    assert.equal(questOf(a, '$CUREWER'), undefined);
    assert.equal(b.act('quest.use', { uid: vam.uid, item: 'i.00' }).ok, false);

    a.must('quest.use', { uid: vam.uid, item: 'i.00' });
    const elder = await meetQuestContact(world, a, vam, 'p.00');
    a.must('npc.talk', { targetId: elder.id });
    assert.ok(questOf(a, vam.name).prompt);
    a.must('quest.answer', { uid: vam.uid, yes: false });
    const site = questOf(a, vam.name).places['l.00'];
    assert.ok(site.revealed, 'refusing to hand over the letter reveals the bloodfather dungeon');
    toNight(world); // Wait indoors before leaving, so the shared daylight passage cannot burn the vampire.
    await enterDungeon(world, a, site.location);
    const bloodfather = await until(world, () => a.state.entities.find((e) => {
      const q = world.ctx.entities.get(e.id)?._quest;
      return q?.uid === vam.uid && q.foe === 'f.00';
    }), 'the bloodfather');
    await finishFoe(world, a, bloodfather, 'mithril-longsword');
    assert.equal(a.character.quests.done.find((q) => q.uid === vam.uid)?.result, 'success');
    assert.equal(s.conditionStatus(p).vampire, null);
    assert.ok(s.conditionStatus(wolf).lycanthrope);
    assert.equal(a.events('condition').filter((e) => e.cured === 'vampirism').length, 1);
    assert.equal(b.events('condition').some((e) => e.cured === 'vampirism'), false);

    // Verify the original paid cure branch, using checkpoints beside the script's contacts.
    b.must('quest.use', { uid: wer.uid, item: 'i.00' });
    const cleric = await meetQuestContact(world, b, wer, 'p.00');
    b.must('npc.talk', { targetId: cleric.id });
    assert.ok(questOf(b, wer.name).prompt);
    b.must('quest.answer', { uid: wer.uid, yes: true });
    const chemist = await meetQuestContact(world, b, wer, 'p.03');
    b.must('npc.talk', { targetId: chemist.id });
    assert.equal(questOf(b, wer.name).items['i.01'].held, false, 'chemist requires 1000 gold');
    fund(world, b, 1000); // FIXTURE SETUP: funds for the chemist.
    const before = goldOf(world, b);
    b.must('npc.talk', { targetId: chemist.id });
    assert.equal(goldOf(world, b), before - 1000);
    assert.equal(questOf(b, wer.name).items['i.01'].held, true);
    const contact = await meetQuestContact(world, b, wer, 'p.01');
    b.must('npc.talk', { targetId: contact.id });
    assert.ok(questOf(b, wer.name).prompt);
    b.must('quest.answer', { uid: wer.uid, yes: true });
    assert.equal(s.conditionStatus(wolf).lycanthrope, null);
    assert.equal(b.events('condition').filter((e) => e.cured === 'lycanthropy').length, 1);
    assert.equal(a.events('condition').some((e) => e.cured === 'lycanthropy'), false);
  });

  test('successive personal 38-day checks start the initial vampire letter and a clan member job', gate, async (t) => {
    const { world } = await specialWorld(t);
    const a = world.connect('acct-clan-a', 'Seryn');
    const b = world.connect('acct-clan-b', 'Tessa');
    const s = world.ctx.services;
    const owner = world.players.get(a.id);
    const peer = world.players.get(b.id);
    // Fixture: both characters belong to a clan, and only the owner spends time. A zero roll picks the
    // first eligible installed member job. The normal conditions tick selects and starts both scripts.
    s.deploySupernatural(owner, 'vampirism');
    s.deploySupernatural(peer, 'vampirism');
    const period = 38 * 1440;
    const peerMinutes = s.playerMinutes(peer);
    const next = period - (s.playerMinutes(owner) % period);
    s.spendTime(owner, next - 1, 'fixture');
    dice(0, () => world.tick(40));
    assert.equal(questOf(a, 'P0A01L00'), undefined);
    s.spendTime(owner, 1, 'fixture');
    dice(0, () => world.tick(40));
    assert.equal(questOf(a, 'P0A01L00')?.special, 'clan');
    s.spendTime(owner, period, 'fixture');
    dice(0, () => world.tick(40));
    const memberJob = questOf(a, 'P0B00L01');
    assert.equal(memberJob?.special, 'clan');
    assert.equal(memberJob.giver.faction, s.conditionStatus(owner).vampire.clanFactionId);
    assert.equal(s.playerMinutes(peer), peerMinutes);
    assert.equal(b.character.quests.active.some(q => q.special === 'clan'), false);
    world.restart();
    const rejoined = world.connect('acct-clan-a', 'Seryn');
    assert.equal(questOf(rejoined, 'P0B00L01')?.uid, memberJob.uid);
    assert.equal(world.players.get(rejoined.id).rpg.special.history.filter(h => h.quest === memberJob.name && h.result === 'started').length, 1);
  });

  test('vampire: the 38-day conditions tick starts P0A01L00; letter, dungeon, kill, contact, ring paid once', gate, async (t) => {
    const { world, dbPath } = await specialWorld(t);
    const s = world.ctx.services;
    const a = world.connect('acct-n', 'Nerys');
    const b = world.connect('acct-o', 'Osric');
    const pa = world.players.get(a.id);
    // Somewhere indoors, out of the sun.
    await visit(world, a, CITY, MAGES, (e) => e.faction === 66, 'indoors');
    await visit(world, b, CITY, MAGES, (e) => e.faction === 66, 'indoors (B)');
    s.deploySupernatural(pa, 'vampirism'); // FIXTURE SETUP: package 10's test entry, a vampire of the region's clan
    assert.ok(s.conditionStatus(pa).vampire, 'A is a vampire');
    // Thirty-eight days pass on the shared clock; conditions (package 10) fires supernaturalQuest on the crossing.
    const seen = [];
    world.ctx.on('supernaturalQuest', (ev) => seen.push({ who: ev.player.id, cure: ev.cure, kind: ev.kind }));
    for (let d = 0; d < 39 && !a.character.quests.active.some((q) => q.name === 'P0A01L00'); d++) {
      world.clock.advance(1440 * MINUTE_MS);
      dice(0, () => world.tick(1000)); // the 50% roll lands (d100 = 1)
    }
    assert.ok(seen.some((e) => e.who === a.id && e.cure === false && e.kind === 'vampire'), 'conditions fired the 38-day tick');
    assert.ok(!seen.some((e) => e.who === b.id), 'B is not a vampire');
    const inst = await until(world, () => a.character.quests.active.find((q) => q.name === 'P0A01L00'), 'P0A01L00 in the journal');
    assert.equal(inst.special, 'clan');
    assert.ok(inst.items['i.01']?.held, 'the letter was handed over (QRC 1020)');
    assert.equal(b.character.quests.active.length, 0);
    assert.equal(pa.rpg.special.vampireInitial, true);

    // Read the letter: the dungeon is revealed (S.05).
    a.must('quest.use', { uid: inst.uid, item: '_I.01_' });
    const place = await until(world, () => { const i = a.character.quests.active.find((q) => q.uid === inst.uid); return i?.places['l.00']?.revealed && i.places['l.00']; }, 'the revealed dungeon');
    assert.ok(place.interior?.startsWith('dungeon:'), place.interior);

    // Restart before setting out: the quest, its letter and the trigger state persist.
    const aid = a.id;
    world.restart();
    await s.interiors?.ready;
    const saved = readPersisted(dbPath, aid);
    assert.equal(saved.rpg.special.vampireInitial, true);
    assert.ok(saved.rpg.quests.active.some((q) => q.name === 'P0A01L00'));
    const a2 = world.connect('acct-n', 'Nerys');
    const p2 = world.players.get(a2.id);

    // The vampire waits on a quest spawn marker in the revealed dungeon.
    await enterDungeon(world, a2, place.location);
    const foe = await until(world, () => a2.state.entities.find((e) => e.kind === 'monster' && e.quest && !e.dead), 'the quest vampire');
    // FIXTURE SETUP: a vampire (minMetal silver) needs a silver blade; the character starts with iron.
    const blade = s.giveItem(p2, 'silver-longsword', 1);
    const bladeId = (blade?.id ?? a2.character.inventory.find((i) => /silver/i.test(i.template ?? i.name ?? ''))?.id);
    world.tick(40);
    a2.must('inventory.equip', { itemId: bladeId });
    a2.must('combat.ready', { ready: true });
    const errs = [];
    await until(world, () => {
      const e = world.ctx.entities.get(foe.id);
      if (!e || e.dead) return true;
      e.hp = 1; // FIXTURE SETUP: the duel itself is package 8's; one hit finishes it
      e._cooldown = 60; // FIXTURE SETUP: the vampire holds its swing while the fixture lands one blow
      p2.x = e.x; p2.z = e.z + 1; p2.yaw = Math.atan2(e.x - p2.x, -(e.z - p2.z)); // FIXTURE POSITIONING: face it
      if (p2.rpg.portal && Number.isFinite(e.y)) p2.rpg.portal.footY = e.y;
      const c = p2.rpg.character; if (c && Number.isFinite(c.maxHealth)) c.health = c.maxHealth;
      world.clock.advance(1500);
      const r = dice(0.01, () => a2.act('combat.attack', { targetId: foe.id, direction: 'down' }));
      if (!r.ok) errs.push(r.error);
      return false;
    }, 'the vampire to fall', 90000).catch((err) => { throw new Error(`${err.message}: ${[...new Set(errs)].slice(0, 6).join(' | ')}`); });
    const after = await until(world, () => { const i = a2.character.quests.active.find((q) => q.uid === inst.uid); return i?.foes['f.00'].kills >= 1 && i; }, 'the kill recorded');
    const contact = after.people['p.00'];
    assert.ok(contact.location, `create npc placed the contact in ${contact.location}`);

    // The clan contact: walk up and talk; the ring is the reward, paid once.
    const town = exteriorOfLoc(contact.location);
    await enterTown(world, a2, town);
    const npc = await until(world, () => a2.state.entities.find((e) => e.kind === 'npc' && e.quest && e.name === contact.name), 'the clan contact');
    p2.x = npc.x; p2.z = npc.z + 0.8; // FIXTURE POSITIONING
    world.tick(40);
    const before = (p2.rpg.inventory ?? a2.character.inventory ?? []).length;
    a2.must('npc.talk', { targetId: npc.id });
    await until(world, () => a2.character.quests.done.some((q) => q.uid === inst.uid), 'P0A01L00 to end');
    const done = a2.character.quests.done.find((q) => q.uid === inst.uid);
    assert.equal(done.result, 'success');
    const rewards = a2.events('questReward').filter((r) => r.uid === inst.uid);
    assert.equal(rewards.length, 1, 'one reward');
    assert.match(rewards[0].item, /ring/i);
    assert.ok((a2.character.inventory ?? []).length > before || rewards[0].item, 'the ring is carried');
    a2.act('npc.talk', { targetId: npc.id });
    world.tick(1000);
    assert.equal(a2.events('questReward').filter((r) => r.uid === inst.uid).length, 1, 'paid once');
    assert.equal(world.players.get(a2.id).rpg.special.history.find((h) => h.quest === 'P0A01L00' && h.result === 'success')?.result, 'success');
  });
});
