import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CharacterDraft } from '../client/gameplay/character/draft.js';
import { updateSavedCampaignInstance } from '../server/rpg/campaign/progress.js';
import { OPENING_DUNGEON } from '../server/rpg/campaign/sites.js';
import { loadCatalog } from '../server/rpg/quests/catalog.js';
import { answerPrompt, createInstance, updateQuest } from '../server/rpg/quests/engine.js';
import {
  accountSession, createFixtureWorld, discoverFeatures, LiveClient, localArena2,
  readPersisted, startLiveWorld, STRICT, tempDir,
} from './support/rpg-session.mjs';

const dataPath = (process.env.ARENA2_DIR && existsSync(join(process.env.ARENA2_DIR, 'S0000999.QBN')) ? process.env.ARENA2_DIR : null) ?? localArena2();
const gate = { skip: !dataPath && !STRICT ? 'operator ARENA2 unavailable' : false };
const quest = (client, name) => client.character.quests.active.find((q) => q.name === name);

async function until(world, get, description) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    world.tick(1000);
    const match = get();
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

function warriorDraft() {
  const draft = new CharacterDraft('Aldora');
  draft.race = 'Breton';
  draft.gender = 'Female';
  draft.chooseClass('Warrior');
  return draft;
}

function spendDraft(draft, rolled) {
  draft.syncRoll(rolled);
  draft.autoDistribute('attributes');
  draft.autoDistribute('skills');
  return draft.createRequest();
}

test('fresh account starts inside Privateer’s Hold over WebSocket and rejoins there', gate, async (t) => {
  assert.ok(dataPath, 'strict integration requires the installed game files');
  const temp = tempDir('dfw-campaign-live-');
  const live = await startLiveWorld({ dir: temp.dir, arena2Dir: dataPath });
  t.after(async () => { try { await live.close(); } finally { temp.remove(); } });
  await live.server.runtime.ctx.services.quests.openingReady;
  const session = await accountSession(live.base, 'Aldora');
  assert.ok(session.cookie, 'account session created');
  async function join() {
    const client = new LiveClient(live.port, { cookie: session.cookie, origin: live.base });
    await client.opened;
    client.send({ type: 'join' });
    return client;
  }
  const first = await join();
  await first.stateWhere((rpg) => rpg.character?.character?.created === false, 'new character');
  const draft = warriorDraft();
  const roll = await first.act('character.roll', draft.rollRequest());
  assert.ok(roll.ok, roll.error);
  const rolled = await first.stateWhere((rpg) => rpg.character.character.draft, 'attribute roll');
  const created = await first.act('character.create', spendDraft(draft, rolled.character.character.draft));
  assert.ok(created.ok, created.error);
  const landed = await first.stateWhere((rpg) => rpg.character.location === OPENING_DUNGEON, 'opening room');
  assert.ok(landed.character.quests.active.some((q) => q.name === '_TUTOR__' && q.prompt?.id === 1010));
  assert.equal((await first.act('portal.leave')).ok, false, 'exit cannot be used from the opening room');
  await first.close();

  const rejoined = await join();
  const resumed = await rejoined.stateWhere((rpg) => rpg.character.location === OPENING_DUNGEON, 'saved opening room');
  assert.deepEqual(resumed.character.quests.active.map((q) => q.uid), landed.character.quests.active.map((q) => q.uid));
  assert.equal(resumed.character.portal.footY, landed.character.portal.footY);
  await rejoined.close();
  t.diagnostic('Production HTTP account, WebSocket character creation, authored start, tutorial prompt and save/rejoin.');
});

test('installed campaign opening, tutorial choice, resurrection at the exit and Lady Brisienna (fixture)', gate, async (t) => {
  assert.ok(dataPath, 'strict integration requires the installed game files');
  const temp = tempDir('dfw-campaign-');
  const dbPath = `${temp.dir}/world.db`;
  const world = await createFixtureWorld({ dbPath, features: (await discoverFeatures()).features, dataPath });
  t.after(() => { try { world.close(); } finally { temp.remove(); } });
  assert.deepEqual(world.installErrors, []);
  await world.ctx.services.quests.openingReady;
  let client = world.connect('campaign-opening', 'Aldora');
  const other = world.connect('campaign-control', 'Brannoc');
  const opening = world.ctx.services.portals.into(OPENING_DUNGEON);
  const draft = warriorDraft();
  client.must('character.roll', draft.rollRequest());
  client.must('character.create', spendDraft(draft, client.character.character.draft));

  const saved = readPersisted(dbPath, client.id);
  assert.equal(client.character.location, OPENING_DUNGEON);
  assert.equal(saved.rpg.location, OPENING_DUNGEON);
  assert.equal(saved.x, opening.meta.newCharacterStart.x);
  assert.equal(saved.z, opening.meta.newCharacterStart.z);
  assert.notEqual(opening.meta.newCharacterStart.z, opening.entrances[0].enter.z);
  assert.equal(client.events('questVideo').filter((event) => event.sequence === 'opening').length, 1);
  assert.deepEqual(other.character.quests.active, []);
  assert.match(client.act('portal.leave').error, /exit door/);

  const tutorial = quest(client, '_TUTOR__');
  assert.equal(tutorial.prompt.id, 1010);
  assert.equal(other.act('quest.answer', { uid: tutorial.uid, yes: true }).ok, false);
  client.must('quest.answer', { uid: tutorial.uid, yes: true });
  world.clock.advance(60_000);
  world.tick(1000);
  assert.equal(quest(client, '_TUTOR__').prompt.id, 1013);
  client.must('quest.answer', { uid: tutorial.uid, yes: false });
  assert.ok(quest(client, 'S0000977'), 'declining opens the source curse episode');

  const contact = quest(client, '_BRISIEN');
  assert.equal(contact.clocks['s.00'].running, false);
  assert.equal(quest(client, 'S0000999'), undefined);
  client.leave();
  client = world.connect('campaign-opening', 'Aldora');
  assert.equal(client.character.location, OPENING_DUNGEON);
  assert.equal(quest(client, '_BRISIEN').uid, contact.uid);
  assert.equal(client.events('questVideo').length, 0);

  // DAMAGE FIXTURE: defeat the character in the opening room and let normal resurrection run.
  // A town-origin respawn within a stacked dungeon can strand the player in solid geometry.
  const p = world.players.get(client.id);
  const door = opening.entrances[0].enter;
  const collision = world.ctx.services.collision.instanceWorld(OPENING_DUNGEON);
  const returnTo = structuredClone(p.rpg.portal.returnTo);
  world.ctx.services.hurtPlayerBy(p, 10_000, { name: 'Fixture damage' });
  assert.equal(p.rpg.character.health, 0);
  world.clock.advance(16_501); // combat resurrectMs: the death movie's cap
  world.tick(1000);
  assert.ok(p.rpg.character.health > 0);
  assert.equal(p.rpg.location, OPENING_DUNGEON);
  assert.equal(p.x, door.x);
  assert.equal(p.z, door.z);
  assert.equal(p.rpg.portal.footY, collision.heightAt(door.x, door.z, door.y));
  assert.deepEqual(p.rpg.portal.returnTo, returnTo);
  assert.ok(collision.isClear(p.x, p.z, p.rpg.portal.footY));
  client.must('portal.leave');
  assert.equal(client.character.location, opening.from);
  assert.ok(quest(client, 'S0000999'), 'leaving starts the source backbone');
  const delivery = quest(client, '_BRISIEN').clocks['s.00'];
  assert.ok(delivery.running);
  assert.ok(delivery.total >= 7 * 1440 && delivery.total <= 14 * 1440);

  world.clock.advance(delivery.total * 5000);
  world.tick(1000);
  const invited = quest(client, '_BRISIEN');
  assert.equal(invited.items['i.00'].held, true);
  client.must('quest.use', { uid: invited.uid, item: 'i.00' });
  assert.ok(client.events('questMessage').some((event) => event.id === undefined && event.uid === invited.uid && event.text.length > 50));
  assert.deepEqual(other.character.quests.active, []);

  const town = invited.places['l.01'].location;
  client.must('travel.go', { to: town });
  await world.ctx.services.interiors.survey(town);
  const interior = await until(world, () => quest(client, '_BRISIEN').places['l.01'].interior, 'invitation tavern');
  const tavern = world.ctx.services.portals.into(interior);
  assert.equal(tavern.meta.buildingType, 15);
  // POSITIONING FIXTURE: stand at the actual tavern door, then use its production entry.
  p.x = tavern.entrances[0].x;
  p.z = tavern.entrances[0].z;
  client.must('portal.use', { portalId: tavern.id });
  await world.ctx.services.collision.whenSettled(interior);
  const lady = await until(world, () => client.state.entities.find((e) => e.kind === 'npc' && e.faction === 352), 'Lady Brisienna');
  const tavernWorld = world.ctx.services.collision.instanceWorld(interior);
  const ladyY = Number.isFinite(lady.y) ? lady.y : tavernWorld.standHeight(lady.x, lady.z);
  assert.ok(tavernWorld.isClear(lady.x, lady.z, ladyY), 'Lady Brisienna must stand on clear interior floor');
  const walk = tavernWorld.move(p.x, p.z, lady.x, lady.z, { y: p.rpg.portal.footY });
  assert.ok(Math.hypot(walk.x - lady.x, walk.z - lady.z) <= 3.5, `Lady Brisienna must be walkable from the tavern entrance (stopped ${Math.hypot(walk.x - lady.x, walk.z - lady.z).toFixed(2)}m away)`);
  p.x = walk.x;
  p.z = walk.z;
  client.must('npc.talk', { targetId: lady.id });
  assert.equal(client.character.quests.globals[31], true);
  assert.equal(readPersisted(dbPath, client.id).rpg.quests.globals[31], true);
  assert.equal(other.character.quests.globals[31], undefined);
  t.diagnostic('Character wizard, tutorial response, resurrection on the exit floor, private letter and named tavern meeting. Damage, clock, tavern door and NPC positions staged.');
});

test('the campaign backbone uses a current court audience when the character qualifies (script checkpoint)', gate, () => {
  assert.ok(dataPath, 'strict integration requires the installed game files');
  const { def } = loadCatalog({ dataPath }).quests.get('S0000999');
  for (const blockedBy of ['level', 'standing']) {
    let level = blockedBy === 'level' ? 1 : 3;
    let standing = blockedBy === 'standing' ? -10 : 0;
    let minute = 100;
    const messages = [];
    const starts = [];
    const host = {
      level: () => level,
      factionRepute: (_, faction) => faction === 394 ? standing : -10,
      itemName: (item) => item.symbol,
      global: () => false,
      text: () => '',
      message: (_, id) => messages.push(id),
      grant() {},
      startQuest: (_, name) => starts.push(name),
    };
    const inst = createInstance(def, { uid: 'court-backbone-checkpoint', seed: 1, giver: null, host, now: minute });
    function tick(audience = false) {
      if (audience) inst.individualClicks = [394];
      for (let i = 0; i < 4; i++) updateQuest(def, inst, host, ++minute);
    }

    tick(true);
    assert.ok(messages.includes(blockedBy === 'level' ? 1032 : 1031));
    assert.deepEqual(starts, []);
    level = 3;
    standing = 0;
    tick();
    assert.deepEqual(starts, [], 'qualifying elsewhere can deliver the letter without starting the court interview');
    assert.ok(messages.includes(1026));
    tick(true);
    tick(true);
    assert.deepEqual(starts, ['S0000004']);
  }
});

test('Cyndassa’s hunt starts the courier episode on returning from the kill (script checkpoint)', gate, () => {
  assert.ok(dataPath, 'strict integration requires the installed game files');
  const { def } = loadCatalog({ dataPath }).quests.get('S0000007');
  const starts = [];
  const messages = [];
  let minute = 100;
  const host = {
    location: () => 'dungeon:Daggerfall/Daggerfall',
    remoteTown: () => 'town:Daggerfall/Gothway Garden',
    individual: (person) => ({ name: person.value, factionId: person.factionId }),
    reputation: () => 0,
    itemName: (item) => item.symbol,
    isAt: () => false,
    text: () => '',
    message: (_, id) => messages.push(id),
    prompt() {},
    placed() {},
    adjustReputation() {},
    startQuest: (_, name) => starts.push(name),
  };
  const inst = createInstance(def, { uid: 'werebeast-checkpoint', seed: 1, giver: null, host, now: minute });
  function tick(audience = false) {
    if (audience) inst.people['p.00'].clicked = true;
    for (let i = 0; i < 4; i++) updateQuest(def, inst, host, ++minute);
  }

  tick();
  assert.ok(answerPrompt(def, inst, true));
  tick();
  assert.equal(inst.places['l.00'].interior, 'dungeon:Betony/Tristore Laboratory');
  assert.equal(inst.foes['f.00'].marker, 1, 'the hunted werewolf uses the authored spawn marker');
  tick(true);
  assert.ok(messages.includes(1003), 'the early audience tells the player to finish the hunt');
  inst.foes['f.00'].kills = 1; // SCRIPT CHECKPOINT: the Tristore Laboratory werewolf was killed.
  tick();
  assert.deepEqual(starts, [], 'the kill alone cannot complete the audience in Daggerfall');
  tick(true);
  tick(true);
  assert.deepEqual(starts, ['S0000012']);
});

test('the courier signet earns the lead for Orcish Treaty (script checkpoint)', gate, () => {
  assert.ok(dataPath, 'strict integration requires the installed game files');
  const { def } = loadCatalog({ dataPath }).quests.get('S0000012');
  const court = 'dungeon:Daggerfall/Daggerfall';
  const messages = [];
  const starts = [];
  let location = court;
  let minute = 100;
  const host = {
    location: () => location,
    remoteTown: (_, resource) => resource?.types?.includes('palace') ? 'town:Daggerfall/Daggerfall' : 'town:Daggerfall/Gothway Garden',
    individual: (person) => person.factionId ? { name: person.value, factionId: person.factionId } : null,
    makeName: () => 'Test courier',
    itemName: (item) => item.symbol,
    travelMinutes: () => 1000,
    text: () => '',
    message: (_, id) => messages.push(id),
    prompt() {},
    placed() {},
    adjustReputation() {},
    grant: (inst, item) => { inst.items[item].held = true; },
    hasItem: (inst, item) => inst.items[item].held,
    releaseItem: (inst, item) => { inst.items[item].held = false; },
    startQuest: (_, name) => starts.push(name),
    end: (inst) => { inst.status = 'ended'; },
  };
  const inst = createInstance(def, { uid: 'courier-checkpoint', seed: 99, giver: null, host, now: minute });
  function tick(person) {
    if (person) inst.people[person].clicked = true;
    for (let i = 0; i < 4; i++) updateQuest(def, inst, host, ++minute);
  }

  // SCRIPT CHECKPOINT: supply audiences and time directly to the installed quest runner.
  tick('p.00');
  assert.equal(inst.prompt?.id, 1000);
  assert.ok(answerPrompt(def, inst, true));
  tick();
  assert.equal(inst.items['i.00'].held, true, 'Mynisera hands over her signet');
  assert.equal(inst.people['p.02'].place, 'l.00');
  location = inst.places['l.00'].location;
  tick('p.02');
  assert.ok(messages.includes(1020));
  assert.equal(inst.clocks['s.04'].running, true, 'the dispatcher starts the search clock');
  assert.equal(inst.people['p.01'].place, undefined);
  minute = inst.clocks['s.04'].endAt;
  tick();
  assert.equal(inst.people['p.01'].place, 'l.01');
  assert.equal(inst.clocks['s.07'].running, true);
  location = inst.places['l.01'].location;
  tick('p.01');
  assert.equal(inst.items['i.02'].held, true, 'the messenger trades the lead for the signet');
  assert.equal(inst.clocks['s.07'].running, false);
  assert.deepEqual(starts, []);
  location = court;
  tick('p.00');
  assert.equal(inst.items['i.00'].held, false);
  assert.deepEqual(starts, ['S0000020']);
  assert.equal(inst.status, 'ended');
});

test('Orcish Treaty requires a fresh audience with Mynisera once the court is ready (script checkpoint)', gate, () => {
  assert.ok(dataPath, 'strict integration requires the installed game files');
  const { def } = loadCatalog({ dataPath }).quests.get('S0000020');
  for (const court of [23, 28]) { // Morgiah's Wedding or Barenziah's Book
    const globals = new Set();
    const starts = [];
    const messages = [];
    const host = {
      location: () => 'dungeon:Daggerfall/Daggerfall',
      individual: (person) => ({ name: person.value, factionId: person.factionId }),
      makeName: () => 'Test NPC',
      itemName: (item) => item.symbol,
      global: (i) => globals.has(i),
      setGlobal: (i, value) => value ? globals.add(i) : globals.delete(i),
      text: () => '',
      message: (_, msg) => messages.push(msg),
      prompt() {},
      revealAt: (_, place, region, mapId) => assert.deepEqual([place, region, mapId], ['l.00', 26, 146892]),
      grant: (inst, item) => { inst.items[item].held = true; },
      hasItem: (inst, item) => inst.items[item]?.held === true,
      releaseItem: (inst, item) => { inst.items[item].held = false; },
      placed() {},
      adjustReputation() {},
      startQuest: (_, name) => starts.push(name),
      end: (inst) => { inst.status = 'ended'; },
    };
    let inst = createInstance(def, { uid: 'orcish-treaty-checkpoint', seed: 1, giver: null, host, now: 100 });
    function tick(person) {
      if (person) inst.people[person].clicked = true;
      for (let minute = 100; minute < 104; minute++) updateQuest(def, inst, host, minute);
    }

    tick('p.00');
    assert.equal(inst.prompt, null);
    assert.ok(messages.includes(1040), 'Mynisera explains the missing lead');
    if (court === 28) {
      // LEGACY SAVE FIXTURE: the old script retained this first audience in the active task array.
      inst = JSON.parse(JSON.stringify(inst));
      inst.story = true;
      inst.report = { source: 'classic' };
      delete inst.tasks['until.s.02'];
      inst.tasks['s.03'].a.pop();
      inst.tasks['s.00'].t = true;
      updateSavedCampaignInstance(inst, def);
    }
    globals.add(court); // SCRIPT CHECKPOINT: supply the result of one earlier royal court route.
    tick();
    assert.equal(inst.prompt, null, 'court completion elsewhere cannot make Mynisera speak remotely');
    tick('p.00');
    assert.equal(inst.prompt?.id, 1000);
    assert.ok(answerPrompt(def, inst, true));
    tick();
    assert.equal(inst.items['i.01'].held, true, 'Mynisera gives her message to Gortwog');
    assert.equal(inst.places['l.00'].interior, 'dungeon:Orsinium Area/Orsinium');
    tick('p.01');
    assert.equal(inst.items['i.01'].held, false, 'Gortwog takes her message');
    assert.equal(inst.items['i.00'].place, 'l.00', 'the actual Emperor’s letter is placed in Orsinium');
    assert.equal(inst.items['i.00'].marker, 0, 'the reference script selects the authored item marker');
    inst.items['i.00'].held = true; // SCRIPT CHECKPOINT: item pickup at its placed site.
    tick('p.00');
    assert.equal(inst.status, 'ended');
    assert.deepEqual(starts, ['S0000988']);
    assert.deepEqual([...globals], [court, 29]);
  }
});

test('the King of Worms needs a fresh audience after both Lich’s Soul objectives (script checkpoint)', gate, () => {
  assert.ok(dataPath, 'strict integration requires the installed game files');
  const { def } = loadCatalog({ dataPath }).quests.get('S0000021');
  const globals = new Set();
  let minute = 100;
  let location = 'dungeon:Dragontail Mountains/Scourg Barrow';
  const host = {
    location: () => location,
    inTown: () => location.startsWith('town:'),
    individual: (person) => ({ name: person.value, factionId: person.factionId }),
    level: () => 7,
    reputation: () => 10,
    itemName: (item) => item.symbol,
    global: (i) => globals.has(i),
    setGlobal: (i, value) => value ? globals.add(i) : globals.delete(i),
    text: () => '',
    message() {},
    prompt() {},
    placed() {},
    grant: (inst, item) => { inst.items[item].held = true; },
    hasItem: (inst, item) => inst.items[item]?.held === true,
    releaseItem: (inst, item) => { inst.items[item].held = false; },
    adjustReputation() {},
    end: (inst) => { inst.status = 'ended'; },
  };
  let inst = createInstance(def, { uid: 'lich-soul-checkpoint', seed: 1, giver: null, host, now: minute });
  function tick(person) {
    if (person) inst.people[person].clicked = true;
    for (let i = 0; i < 4; i++) updateQuest(def, inst, host, ++minute);
  }

  tick('p.00');
  assert.equal(inst.prompt, null, 'the King has yet to send his summons');
  location = 'town:Dragontail Mountains/Scourg Barrow';
  minute += 1410;
  tick();
  assert.equal(inst.foes['f.00'].ambush, 1);
  inst.foes['f.00'].kills = 1; // SCRIPT CHECKPOINT: the zombie courier is defeated.
  tick();
  assert.equal(inst.prompt, null, 'an old audience does not start the quest from the zombie fight');
  minute += 1410;
  tick();
  assert.equal(inst.foes['f.00'].ambush, 1, 'the initial summons stops once the courier was defeated');

  location = 'dungeon:Dragontail Mountains/Scourg Barrow';
  tick('p.00');
  assert.equal(inst.prompt?.id, 1000);
  assert.ok(answerPrompt(def, inst, true));
  tick();
  assert.equal(inst.items['i.00'].held, true);
  assert.equal(inst.foes['f.01'].place, 'l.00', 'the Lich appears in Sentinel');
  tick('p.00');
  assert.equal(inst.items['i.00'].held, true, 'the scarab stays with the player before the Lich fight');
  // LEGACY SAVE FIXTURE: both the stale audience and repeatable summons could be present on active saves.
  inst = JSON.parse(JSON.stringify(inst));
  inst.story = true;
  inst.report = { source: 'classic' };
  delete inst.tasks['until.s.15'];
  delete inst.tasks['s.18'];
  inst.tasks['s.02'].t = true;
  inst.tasks['s.10'].t = true;
  inst.tasks['s.06'].d = false;
  inst.tasks['s.08'].a.pop();
  updateSavedCampaignInstance(inst, def);
  location = 'dungeon:Sentinel/Sentinel';
  inst.foes['f.01'].kills = 1; // SCRIPT CHECKPOINT: the Lich is defeated in Sentinel.
  tick();
  assert.equal(inst.status, 'active', 'killing the Lich cannot stand in for a return to the King');
  assert.equal(globals.has(33), false);
  assert.equal(inst.tasks['s.06'].d, true, 'the summons stays stopped after restoring the save');
  location = 'dungeon:Dragontail Mountains/Scourg Barrow';
  inst.items['i.00'].held = false; // SCRIPT CHECKPOINT: return without the scarab first.
  tick('p.00');
  assert.equal(inst.status, 'active', 'the King still needs the scarab');
  inst.items['i.00'].held = true;
  tick('p.00');
  assert.equal(inst.status, 'ended');
  assert.deepEqual([...globals], [33]);
});

test('all seven installed S0000016 endings resolve from saved receipt flags (script checkpoint)', gate, () => {
  assert.ok(dataPath, 'strict integration requires the installed game files');
  const { def } = loadCatalog({ dataPath }).quests.get('S0000016');
  const branches = [
    ['Gothryd', 1, 11, 14], ['King of Worms', 2, 12, 6], ['Gortwog', 3, 13, 8],
    ['Akorithi', 4, 14, 9], ['Underking', 6, 16, 15], ['Eadwyre', 7, 17, 7], ['Brisienna', 8, 18, 10],
  ];
  for (const [recipient, receipt, ending, movie] of branches) {
    // SCRIPT CHECKPOINT: an already delivered Totem. Physical handover and travel are tested separately.
    const globals = new Set([receipt]);
    const movies = [];
    const host = {
      global: (i) => globals.has(i),
      setGlobal: (i, value) => value ? globals.add(i) : globals.delete(i),
      text: () => '',
      message() {},
      transfer: () => true,
      video: (_, cue) => movies.push(cue),
      end: (quest) => { quest.status = 'ended'; },
    };
    let inst = createInstance(def, { uid: 'ending-checkpoint', seed: 1, giver: null, host, now: 100 });
    updateQuest(def, inst, host, 100);
    assert.deepEqual(movies, [], `${recipient} waits for the Mantella`);
    inst = JSON.parse(JSON.stringify(inst));
    globals.add(36);
    for (let minute = 101; minute < 106; minute++) updateQuest(def, inst, host, minute);
    assert.equal(inst.status, 'ended', recipient);
    assert.deepEqual(movies, [3, movie], recipient);
    assert.deepEqual([...globals].sort((a, b) => a - b), [receipt, ending, 36], recipient);
  }
});

test('tutorial lessons include Daggerfall World controls and auto-save guidance without altering other quests', async () => {
  const { annotateTutorialText } = await import('../server/rpg/campaign/tutorial.js');
  const saveLesson = annotateTutorialText('_TUTOR__', 1030, 'Classic save prompt.');
  assert.match(saveLesson, /saved automatically on the server/i);
  assert.match(saveLesson, /no Save Game menu under Esc/i);
  assert.ok(saveLesson.indexOf('saved automatically') < saveLesson.indexOf('Classic save prompt.'));
  assert.match(annotateTutorialText('_TUTOR__', 1012, 'Move lesson'), /W A S D/);
  assert.match(annotateTutorialText('_TUTOR__', 1020, 'Door lesson'), /press G/i);
  assert.equal(annotateTutorialText('_BRISIEN', 1030, 'Unrelated quest'), 'Unrelated quest');
});

test('all 34 S0000* campaign scripts pass static analysis and S0000008 -> S0000016 chains all 7 Totem recipients to all 7 endings', gate, () => {
  assert.ok(dataPath, 'strict integration requires the installed game files');
  const cat = loadCatalog({ dataPath, artifact: () => true });
  const campaignScripts = [...cat.quests.values()].filter((q) => /^S0000/i.test(q.name));
  assert.equal(campaignScripts.length, 34, 'all 34 S0000001-S0000999 scripts loaded');
  for (const q of campaignScripts) {
    const unsup = q.analysis.unsupported.filter((u) => !u.includes('not a guild or social quest') && !u.includes('no offer text'));
    assert.deepEqual(unsup, [], `${q.name} has unsupported actions: ${unsup.join(', ')}`);
  }

  const def008 = cat.quests.get('S0000008').def;
  const def016 = cat.quests.get('S0000016').def;
  // [recipient, personKey in S0000008, receiptGlobal, handoverMsg, endingGlobal, endingMovie]
  const routes = [
    ['Gothryd', 'p.01', 1, 1053, 11, 14],
    ['King of Worms', 'p.06', 2, 1054, 12, 6],
    ['Gortwog', 'p.04', 3, 1052, 13, 8],
    ['Akorithi', 'p.03', 4, 1050, 14, 9],
    ['Underking', 'p.05', 6, 1055, 16, 15],
    ['Eadwyre', 'p.02', 7, 1051, 17, 7],
    ['Brisienna', 'p.00', 8, 1056, 18, 10],
  ];

  for (const [recipient, personKey, receipt, handoverMsg, ending, movie] of routes) {
    const globals = new Set();
    const starts = [];
    const messages = [];
    const movies = [];
    let minute = 100;
    const host = {
      location: () => 'dungeon:Daggerfall/Daggerfall',
      remoteTown: () => 'town:Daggerfall/Daggerfall',
      isAt: () => false,
      inTown: () => false,
      reputation: () => 0,
      travelMinutes: () => 1000,
      individual: (person) => ({ name: person.value, factionId: person.factionId }),
      makeName: () => 'Test NPC',
      itemName: (item) => item.symbol,
      global: (i) => globals.has(i),
      setGlobal: (i, value) => (value ? globals.add(i) : globals.delete(i)),
      text: () => '',
      message: (_, id) => messages.push(id),
      prompt() {},
      placed() {},
      adjustReputation() {},
      grant: (inst, item) => { if (inst.items[item]) inst.items[item].held = true; },
      hasItem: (inst, item) => inst.items[item]?.held === true,
      releaseItem: (inst, item) => { if (inst.items[item]) inst.items[item].held = false; },
      makePermanent() {},
      transfer: () => true,
      video: (_, cue) => movies.push(cue),
      startQuest: (_, name) => starts.push(name),
      end: (inst) => { inst.status = 'ended'; },
    };

    // 1. Run S0000008 (Who Gets the Totem): meet Brisienna (_P.00_) and accept _S.02_ so the Totem is placed at Castle Daggerfall
    const inst008 = createInstance(def008, { uid: `totem-${recipient}`, seed: 1, giver: null, host, now: minute });
    const step = (inst, def, n = 4) => { for (let i = 0; i < n; i++) updateQuest(def, inst, host, ++minute); };
    step(inst008, def008);
    inst008.people['p.00'].clicked = true;
    step(inst008, def008);
    assert.equal(inst008.prompt?.id, 1000, `${recipient}: Brisienna offers the Totem quest`);
    assert.ok(answerPrompt(def008, inst008, true), `${recipient}: accept Totem quest`);
    step(inst008, def008);
    assert.equal(inst008.items['i.01'].place, 'l.00', `${recipient}: Totem placed at Castle Daggerfall`);

    // Pick up the Totem (_I.01_) and verify an early visit to Nulfaga (303) before delivery does NOT start S0000016
    inst008.items['i.01'].held = true;
    inst008.items['i.01'].clicked = true;
    step(inst008, def008);
    inst008.individualClicks = [303];
    step(inst008, def008);
    assert.ok(!starts.includes('S0000016'), `${recipient}: early Nulfaga visit must not trigger S0000016`);

    // Hand the Totem to this recipient
    inst008.people[personKey].clicked = true;
    step(inst008, def008);
    assert.equal(globals.has(receipt), true, `${recipient}: receipt global ${receipt} set`);
    assert.ok(messages.includes(handoverMsg), `${recipient}: handover message ${handoverMsg} shown`);

    // Fresh audience with Nulfaga (303) after delivery triggers S0000016
    inst008.individualClicks = [303];
    step(inst008, def008);
    assert.ok(starts.includes('S0000016'), `${recipient}: Nulfaga starts S0000016 after Totem delivery`);
    assert.equal(inst008.status, 'ended', `${recipient}: S0000008 ends after starting S0000016`);

    // 2. Chain into S0000016 (Journey to Aetherius) carrying the live globals from S0000008
    const inst016 = createInstance(def016, { uid: `ending-${recipient}`, seed: 1, giver: null, host, now: minute });
    step(inst016, def016, 2);
    assert.deepEqual(movies, [], `${recipient}: waits for Mantella`);
    globals.add(36); // FinishedMantellanCrux
    step(inst016, def016, 6);
    assert.equal(inst016.status, 'ended', `${recipient}: S0000016 ends`);
    assert.deepEqual(movies, [3, movie], `${recipient}: plays Mantella + ending movie ${movie}`);
    assert.equal(globals.has(ending), true, `${recipient}: ending global ${ending} set`);
  }
});

test('rushed Privateer’s Hold exit queues pending prompts, stops indoor timers, and triggers Lesson 9 once', gate, () => {
  assert.ok(dataPath, 'strict integration requires the installed game files');
  const { def } = loadCatalog({ dataPath }).quests.get('_TUTOR__');
  let loc = OPENING_DUNGEON;
  let minute = 100;
  const prompts = [];
  const messages = [];
  const host = {
    location: () => loc,
    isAt: (pl) => (pl.interior ? loc === pl.interior : loc === pl.location),
    text: (_, id) => `msg-${id}`,
    message: (_, id) => messages.push(id),
    prompt: (inst, id) => { if (inst.prompt) inst.prompt.text = `prompt-${id}`; prompts.push(id); },
    startQuest() {},
    end: (inst) => { inst.status = 'ended'; },
  };
  const inst = createInstance(def, { uid: 'tutor-rush', seed: 1, giver: null, host, now: minute });
  const step = (n = 4) => { for (let i = 0; i < n; i++) updateQuest(def, inst, host, minute); };

  step();
  assert.equal(inst.prompt?.id, 1010);
  assert.ok(answerPrompt(def, inst, true));
  step();
  assert.ok(messages.includes(1012));

  // Advance so Lesson 2 (1013) fires while still inside Privateer's Hold, leave it unanswered, then exit the Hold.
  minute += 10;
  step();
  assert.equal(inst.prompt?.id, 1013);
  loc = 'town:Daggerfall/Gothway Garden';
  step();
  assert.equal(inst.prompt?.id, 1013, 'existing unanswered prompt is preserved instead of overwritten');
  assert.equal(inst.promptQueue?.[0]?.id, 1041, 'Lesson 8 (1041) waits in promptQueue');
  assert.equal(inst.clocks['s.04']?.running, false, 'indoor lesson timers do not run outdoors');

  // Answer Yes to 1013 -> queued 1041 promotes cleanly.
  assert.ok(answerPrompt(def, inst, true));
  step();
  assert.equal(inst.prompt?.id, 1041);
  // Advance past all indoor timers: no indoor lesson should interrupt 1041.
  minute += 60;
  step();
  assert.equal(inst.prompt?.id, 1041, 'stale indoor lesson timer never overwrites Lesson 8');

  assert.ok(answerPrompt(def, inst, true));
  step();
  // Arrive in Daggerfall city -> Lesson 9 (1045 / 1046) fires once.
  loc = 'town:Daggerfall/Daggerfall';
  step();
  assert.equal(messages.filter((m) => m === 1045).length, 1);
  assert.equal(inst.prompt?.id, 1046);
  assert.ok(answerPrompt(def, inst, true));
  step();
  // Leave Daggerfall and return -> Lesson 9 must NOT fire a second time.
  loc = 'town:Daggerfall/Gothway Garden';
  step();
  loc = 'town:Daggerfall/Daggerfall';
  step();
  assert.equal(messages.filter((m) => m === 1045).length, 1, 'Lesson 9 does not repeat on subsequent Daggerfall visits');
});
