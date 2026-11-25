// Tests for expanded classic QBN opcodes/triggers and upgraded `makePermanent` (0x36) for non-standard item classes.
// All quest scripts here are synthetic fixtures written for these tests and are NOT Daggerfall quests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installInventory, normalizeRpg } from '../server/rpg/inventory.js';
import { install as installCharacter } from '../server/rpg/character.js';
import { install as installQuests, resolveSkillName } from '../server/rpg/quests.js';
import { compileAction, ACTION_TABLE } from '../server/rpg/quests/actions.js';
import { parseQuest } from '../server/rpg/quests/script.js';
import { analyseQuest } from '../server/rpg/quests/engine.js';
import { permanentFallbackItem } from '../server/rpg/quests/itemIdentity.js';
import { permanentQuestItem, deliverCampaignRewards } from '../server/rpg/campaign/rewards.js';

const TOWN = 'town:Daggerfall/Gothway Garden';
const ok = (r) => assert.equal(r.ok, true, r.error);

const head = (name, title) => `
Quest: ${name}
DisplayName: ${title}

QRC:

QuestorOffer:  [1000]
TEST OFFER ${name}.

RefuseQuest:  [1001]
TEST REFUSED.

AcceptQuest:  [1002]
TEST ACCEPTED.

QuestComplete:  [1004]
TEST COMPLETE.

Message:  1010
TEST MESSAGE 1010.

Message:  1011
TEST MESSAGE 1011.
`;

function catalogOf(...texts) {
  const quests = new Map();
  for (const text of texts) {
    const def = parseQuest(text);
    const group = quests.size ? null : 'Commoners';
    const analysis = analyseQuest(def);
    quests.set(def.name, {
      name: def.name,
      source: 'script',
      def,
      meta: { group, membership: 'N', minReq: 0, oneTime: false, adult: false },
      analysis,
    });
  }
  return { quests, failures: [], listSource: 'fixture', scriptsDir: null, dataPath: null };
}

function makeRuntime(texts, { withCharacter = false, withInventory = false, extraServices = {} } = {}) {
  const players = new Map();
  const notices = [];
  const emitted = [];
  let svc = null;
  const features = [
    (ctx) => {
      svc = ctx.services;
      Object.assign(ctx.services, extraServices);
      for (const ev of ['questTrainPc', 'questKillFoe', 'questChangeFoeTeam', 'questSpawnGuards', 'questWorldChange']) {
        ctx.on(ev, (payload) => emitted.push({ event: ev, ...payload }));
      }
    },
    ...(withInventory ? [installInventory] : []),
    ...(withCharacter ? [installCharacter] : []),
    (ctx) => installQuests(ctx, { catalog: catalogOf(...texts) }),
  ];
  const rt = createRpgRuntime({
    players,
    features,
    defaultLocation: TOWN,
    dataPath: null,
    save: () => {},
    send: (p, msg) => {
      if (msg?.type === 'gameEvent') notices.push({ to: p.id, ...msg.event });
    },
    log: { error() {}, warn() {}, info() {} },
  });
  const giver = { id: 'npc:giver', kind: 'npc', role: 'crier', name: 'Aldis', location: TOWN, x: 0, z: 0, faction: 201, questGiver: true };
  rt.entities.set(giver.id, giver);
  const add = (id, opts = {}) => {
    const p = { id, name: id, x: 0, z: 0, yaw: 0, rpg: { location: TOWN, gold: 0, ...opts.rpg } };
    players.set(id, p);
    rt.join(p);
    return p;
  };
  return { rt, svc, giver, notices, emitted, add };
}

// ---------------------------------------------------------------------------
// 1. Compiler & static analyser coverage for newly implemented QBN patterns
// ---------------------------------------------------------------------------

test('actions.js compiles all expanded QBN triggers and actions and preserves unknownOpcode as unsupported', () => {
  const cases = [
    ['when skill Short_Blade is at least 35', 'whenSkill', 'trigger', 'exact', true, { skill: 'Short_Blade', op: '>=', amount: 35 }],
    ['when skill Medical is at most 15', 'whenSkill', 'trigger', 'exact', true, { skill: 'Medical', op: '<=', amount: 15 }],
    ['when skill 28 is > 40', 'whenSkill', 'trigger', 'exact', true, { skill: '28', op: '>', amount: 40 }],
    ['when repute with _giver_ is at most -5', 'whenRepute', 'trigger', 'exact', true, { faction: null, person: '_giver_', op: '<=', amount: -5 }],
    ['when repute with faction 201 is < 10', 'whenRepute', 'trigger', 'exact', true, { faction: 201, person: null, op: '<', amount: 10 }],
    ['when repute with faction 40 is > 25', 'whenRepute', 'trigger', 'exact', true, { faction: 40, person: null, op: '>', amount: 25 }],
    ['when repute with _giver_ exceeds 12', 'whenRepute', 'trigger', 'exact', true, { faction: null, person: '_giver_', op: '>', amount: 12 }],
    ['pay 50 money do _paid_ otherwise do _broke_', 'payMoney', 'action', 'exact', false, { gold: 50, task: '_paid_', otherwise: '_broke_' }],
    ['pay 10 money set _paid_', 'payMoney', 'action', 'exact', false, { gold: 10, task: '_paid_', otherwise: null }],
    ['train pc Long_Blade', 'trainPc', 'action', 'approx', false, { skill: 'Long_Blade', amount: null }],
    ['train pc Restoration by 5', 'trainPc', 'action', 'approx', false, { skill: 'Restoration', amount: 5 }],
    ['kill foe _bandit_', 'killFoe', 'action', 'exact', false, { foe: '_bandit_' }],
    ['change foe _bandit_ team 2', 'changeFoe', 'action', 'approx', false, { foe: '_bandit_', team: 2 }],
    ['change foe _bandit_ team PlayerAlly', 'changeFoe', 'action', 'approx', false, { foe: '_bandit_', team: 'PlayerAlly' }],
    ['spawn city guards', 'spawnGuards', 'action', 'approx', false, { immediate: false }],
    ['spawn city guards immediate', 'spawnGuards', 'action', 'approx', false, { immediate: true }],
    ['change weather Rain', 'world', 'action', 'approx', false, { aspect: 'weather', value: 'Rain' }],
    ['change season Winter', 'world', 'action', 'approx', false, { aspect: 'season', value: 'Winter' }],
    ['weather Snow', 'world', 'action', 'approx', false, { aspect: 'weather', value: 'Snow' }],
    ['pc at any tavern set _atTavern_', 'pcAtAny', 'action', 'approx', false, { placeType: 'tavern', task: '_atTavern_', say: undefined }],
    ['pc at any temple do _atTemple_ saying 1010', 'pcAtAny', 'action', 'approx', false, { placeType: 'temple', task: '_atTemple_', say: '1010' }],
    ['run quest T0C00Y99', 'startQuest', 'action', 'exact', false, { quest: 'T0C00Y99' }],
    ['start quest _BRISIEN', 'startQuest', 'action', 'exact', false, { quest: '_BRISIEN' }],
    ['teleport pc to _shrine_ marker 2', 'teleportPc', 'action', 'approx', false, { place: '_shrine_', marker: 2 }],
  ];
  for (const [line, name, kind, status, always, args] of cases) {
    const c = compileAction(line);
    assert.equal(c.name, name, line);
    assert.equal(c.kind, kind, line);
    assert.equal(c.status, status, line);
    assert.equal(c.always, always, line);
    assert.deepEqual(c.args, args, line);
  }
  // Unverified 0x3c and unimplemented named-spell cast stay unsupported.
  assert.equal(compileAction('unknown opcode 0x3c').status, 'unsupported');
  assert.equal(compileAction('unknown opcode 0x3c').name, 'unknownOpcode');
  assert.equal(compileAction('cast spell Shield on _giver_').status, 'unsupported');
  assert.equal(compileAction('cast spell Shield on _giver_').name, 'castOther');
  assert.ok(ACTION_TABLE.some((r) => r.name === 'whenSkill' && r.status === 'exact'));
  assert.ok(ACTION_TABLE.some((r) => r.name === 'payMoney' && r.status === 'exact'));
  assert.ok(ACTION_TABLE.some((r) => r.name === 'killFoe' && r.status === 'exact'));
  assert.ok(ACTION_TABLE.some((r) => r.name === 'unknownOpcode' && r.status === 'unsupported'));
});

test('resolveSkillName normalises underscored, camelCase, spaced, and numeric skill identifiers', () => {
  assert.equal(resolveSkillName('Short_Blade'), 'Short Blade');
  assert.equal(resolveSkillName('ShortBlade'), 'Short Blade');
  assert.equal(resolveSkillName('Hand-to-Hand'), 'Hand-to-Hand');
  assert.equal(resolveSkillName('hand_to_hand'), 'Hand-to-Hand');
  assert.equal(resolveSkillName('0'), 'Medical');
  assert.equal(resolveSkillName('28'), 'Short Blade');
  assert.equal(resolveSkillName('NoSuchSkill'), null);
});

// ---------------------------------------------------------------------------
// 2. Runtime execution of whenSkill, whenRepute variants, payMoney, trainPc
// ---------------------------------------------------------------------------

test('whenSkill, whenRepute (<=, <, >), payMoney (paid & otherwise), and trainPc run end-to-end', () => {
  const script = `${head('T0C00Y50', 'Skills, Repute, Pay & Train')}
QBN:
Person _giver_ group Questor
variable _payNow_
variable _paid_
variable _broke_
variable _trainNow_

_skilled_ task:
	when skill Short_Blade is at least 30

_lowSkill_ task:
	when skill Medical is at most 10

_lowRep_ task:
	when repute with faction 201 is at most 5

_gtRep_ task:
	when repute with _giver_ is > 10

_doPay_ task:
	when _payNow_
	pay 50 money do _paid_ otherwise do _broke_

_doTrain_ task:
	when _trainNow_
	train pc Long_Blade by 15
`;
  let rep = 3;
  const { rt, svc, giver, emitted, add } = makeRuntime([script], {
    withCharacter: true,
    withInventory: true,
    extraServices: {
      reputation: (_p, fid) => (fid === 201 ? rep : 0),
    },
  });
  const p = add('p1');
  p.rpg.character.skills['Short Blade'] = 25;
  p.rpg.character.skills.Medical = 8;
  p.rpg.character.skills['Long Blade'] = 10;
  p.rpg.gold = 20;

  ok(rt.act(p, 'quest.request', { targetId: giver.id }));
  ok(rt.act(p, 'quest.accept', { offerId: p.rpg.quests.offer.id }));
  const inst = p.rpg.quests.active[0];

  // Initial trigger evaluation
  assert.equal(inst.tasks.skilled.t, false);
  assert.equal(inst.tasks.lowskill.t, true);
  assert.equal(inst.tasks.lowrep.t, true);
  assert.equal(inst.tasks.gtrep.t, false);

  // Non-latching re-evaluation when skill & repute change
  p.rpg.character.skills['Short Blade'] = 35;
  p.rpg.character.skills.Medical = 20;
  rep = 12;
  svc.quests.run(p);
  assert.equal(inst.tasks.skilled.t, true);
  assert.equal(inst.tasks.lowskill.t, false);
  assert.equal(inst.tasks.lowrep.t, false);
  assert.equal(inst.tasks.gtrep.t, true);

  // Drop skill back below threshold -> unlatches
  p.rpg.character.skills['Short Blade'] = 20;
  svc.quests.run(p);
  assert.equal(inst.tasks.skilled.t, false);

  // payMoney: insufficient gold triggers otherwise without deducting gold
  inst.tasks.paynow.t = true;
  svc.quests.run(p);
  assert.equal(inst.tasks.paid.t, false);
  assert.equal(inst.tasks.broke.t, true);
  assert.equal(p.rpg.gold, 20);

  // Rearm payMoney by clearing _payNow_ and _doPay_, then fund player and retry
  inst.tasks.paynow.t = false;
  inst.tasks.broke.t = false;
  svc.quests.run(p);
  p.rpg.gold = 80;
  inst.tasks.paynow.t = true;
  svc.quests.run(p);
  assert.equal(inst.tasks.paid.t, true);
  assert.equal(inst.tasks.broke.t, false);
  assert.equal(p.rpg.gold, 30, 'transactional gold deduction');

  // trainPc: advances skill uses via character service and emits event
  const usesBefore = p.rpg.character.skillUses['Long Blade'];
  inst.tasks.trainnow.t = true;
  svc.quests.run(p);
  assert.ok(p.rpg.character.skillUses['Long Blade'] > usesBefore || p.rpg.character.skills['Long Blade'] > 10);
  assert.ok(emitted.some((e) => e.event === 'questTrainPc' && e.skill === 'Long Blade' && e.amount === 15));
});

// ---------------------------------------------------------------------------
// 3. killFoe, changeFoe, spawnGuards (with & without law), world (MP-safe), pcAtAny, run quest
// ---------------------------------------------------------------------------

test('killFoe, changeFoe, spawnGuards, world (multiplayer-isolated), pcAtAny, and run quest execute and survive reload', () => {
  const mainScript = `${head('T0C00Y51', 'World, Foes, Guards, PcAtAny')}
QBN:
Item _clue_ trinket
Person _giver_ group Questor
Place _den_ local tavern
Foe _raider_ is Giant_rat
variable _doTeam_
variable _doKill_
variable _doGuards_
variable _doWorld_
variable _doChain_
variable _inTavern_
variable _inDungeon_

	place foe _raider_ at _den_
	give item _clue_ to _raider_
	pc at any tavern set _inTavern_
	pc at any dungeon set _inDungeon_

_teamTask_ task:
	when _doTeam_
	change foe _raider_ team 3

_killTask_ task:
	when _doKill_
	kill foe _raider_

_slain_ task:
	killed 1 _raider_

_guardTask_ task:
	when _doGuards_
	spawn city guards immediate

_worldTask_ task:
	when _doWorld_
	change weather Rain
	change season Winter

_chainTask_ task:
	when _doChain_
	run quest T0C00Y52
`;
  const followScript = `${head('T0C00Y52', 'Chained Follow-up')}
QBN:
Person _giver_ group Questor
	say 1010
`;

  const guardCalls = [];
  const atmoCalls = [];
  const portals = {
    'interior:Daggerfall/Gothway Garden:tavern0': { id: 'p-tavern', from: TOWN, kind: 'building', meta: { buildingType: 15, buildingName: 'The Red Lion' } },
  };
  const { rt, svc, giver, notices, emitted, add } = makeRuntime([mainScript, followScript], {
    extraServices: {
      law: { spawnGuards: (player, opts) => guardCalls.push({ playerId: player.id, ...opts }) },
      atmosphere: { setPlayerOverride: (player, aspect, value) => atmoCalls.push({ playerId: player.id, aspect, value }) },
      portals: { into: (loc) => portals[loc] ?? null, at: () => [] },
    },
  });

  const p1 = add('p1');
  const p2 = add('p2');

  ok(rt.act(p1, 'quest.request', { targetId: giver.id }));
  ok(rt.act(p1, 'quest.accept', { offerId: p1.rpg.quests.offer.id }));
  const inst = p1.rpg.quests.active[0];

  // Foe is spawned in ctx.entities
  const liveFoes = () => [...rt.entities.values()].filter((e) => e._quest?.uid === inst.uid && e._quest.foe === 'raider');
  assert.equal(liveFoes().length, 1);
  assert.equal(inst.items.clue.holder, 'raider');

  // changeFoe sets team on instance and live entity
  inst.tasks.doteam.t = true;
  svc.quests.run(p1);
  assert.equal(inst.foes.raider.team, 3);
  assert.equal(liveFoes()[0].questTeam, 3);
  assert.ok(emitted.some((e) => e.event === 'questChangeFoeTeam' && e.team === 3));

  // killFoe marks slain, removes live entity, returns held item to player, triggers `killed 1 _raider_`
  inst.tasks.dokill.t = true;
  svc.quests.run(p1);
  assert.equal(inst.foes.raider.kills, 1);
  assert.equal(inst.foes.raider.removed, true);
  assert.equal(liveFoes().length, 0);
  assert.equal(inst.items.clue.held, true);
  assert.equal(inst.items.clue.holder, null);
  assert.equal(inst.tasks.slain.t, true);
  assert.ok(emitted.some((e) => e.event === 'questKillFoe' && e.foe === 'raider'));

  // spawnGuards invokes law service hook and records state
  inst.tasks.doguards.t = true;
  svc.quests.run(p1);
  assert.equal(guardCalls.length, 1);
  assert.equal(guardCalls[0].playerId, 'p1');
  assert.equal(guardCalls[0].immediate, true);
  assert.equal(inst.guardsSpawned.immediate, true);

  // world (change weather / change season) scopes privately to p1, never affects p2
  inst.tasks.doworld.t = true;
  svc.quests.run(p1);
  assert.deepEqual(inst.worldOverrides, { weather: 'Rain', season: 'Winter' });
  assert.deepEqual(atmoCalls, [
    { playerId: 'p1', aspect: 'weather', value: 'Rain' },
    { playerId: 'p1', aspect: 'season', value: 'Winter' },
  ]);
  assert.ok(notices.some((n) => n.to === 'p1' && n.kind === 'questWorld' && n.aspect === 'weather' && n.value === 'Rain'));
  assert.ok(!notices.some((n) => n.to === 'p2' && n.kind === 'questWorld'), 'other players never receive private quest weather');

  // pcAtAny evaluates building type and dungeon location
  assert.equal(inst.tasks.intavern.t, false);
  p1.rpg.location = 'interior:Daggerfall/Gothway Garden:tavern0';
  svc.quests.run(p1);
  assert.equal(inst.tasks.intavern.t, true);
  assert.equal(inst.tasks.indungeon.t, false);

  p1.rpg.location = 'dungeon:Daggerfall/Privateers Hold';
  svc.quests.run(p1);
  assert.equal(inst.tasks.intavern.t, false);
  assert.equal(inst.tasks.indungeon.t, true);

  // run quest starts T0C00Y52 for p1 only
  inst.tasks.dochain.t = true;
  svc.quests.run(p1);
  assert.ok(p1.rpg.quests.active.some((q) => q.name === 'T0C00Y52'));
  assert.equal(p2.rpg.quests.active.length, 0);

  // Persistence across JSON save/reload
  const saved = JSON.parse(JSON.stringify(p1.rpg));
  p1.rpg = saved;
  svc.quests.run(p1);
  const reloaded = p1.rpg.quests.active.find((q) => q.name === 'T0C00Y51');
  assert.equal(reloaded.foes.raider.team, 3);
  assert.equal(reloaded.foes.raider.kills, 1);
  assert.equal(reloaded.foes.raider.removed, true);
  assert.deepEqual(reloaded.worldOverrides, { weather: 'Rain', season: 'Winter' });
  assert.equal(reloaded.guardsSpawned.immediate, true);
});

test('spawnGuards degrades cleanly when law service is absent', () => {
  const script = `${head('T0C00Y53', 'Guards Without Law')}
QBN:
Person _giver_ group Questor
	spawn city guards
`;
  const { rt, giver, emitted, add } = makeRuntime([script]);
  const p = add('p1');
  ok(rt.act(p, 'quest.request', { targetId: giver.id }));
  ok(rt.act(p, 'quest.accept', { offerId: p.rpg.quests.offer.id }));
  assert.equal(p.rpg.quests.active[0].guardsSpawned.immediate, false);
  assert.ok(emitted.some((e) => e.event === 'questSpawnGuards' && e.immediate === false));
});

// ---------------------------------------------------------------------------
// 4. Upgraded makePermanent (0x36) for non-standard item classes + persistence
// ---------------------------------------------------------------------------

test('makePermanent converts non-standard template-less quest items into ordinary inventory records', () => {
  const players = new Map();
  let invCtx = null;
  const rt = createRpgRuntime({
    players,
    features: [
      installInventory,
      (ctx) => { invCtx = ctx; },
    ],
    defaultLocation: TOWN,
    dataPath: null,
    save: () => {},
    send: () => {},
    log: { error() {}, warn() {}, info() {} },
  });
  const p = { id: 'p1', name: 'p1', x: 0, z: 0, yaw: 0, rpg: { location: TOWN, gold: 0 } };
  players.set('p1', p);
  rt.join(p);
  p.rpg.inventory = [];
  p.rpg.quests = { v: 1, active: [], done: [], oneTime: [], seq: 0, minutes: 0, globals: {} };

  const quest = {
    uid: 'T0C00Y54-1-a',
    name: 'T0C00Y54',
    title: 'Relic Recovery',
    notes: [],
    items: {
      relic: { className: 'religious', template: null, held: true, name: 'Silver Chalice', weight: 1.5, value: 220, art: { icon: { archive: 211, record: 50 } } },
      trinket: { className: 'trinket', template: null, held: true, name: 'Engraved Locket' },
      magic: { className: 'magic_item', template: null, held: true, name: 'Runed Signet' },
      drug: { className: 'drug', template: null, held: true, name: 'Skooma Vial' },
      herb: { className: 'small_plant', template: null, held: true, name: 'Nightshade Sprig' },
      organ: { className: 'organs', template: null, held: true, name: 'Daedra Heart' },
      parcel: { className: 'junk', template: null, held: true, name: 'Sealed Parcel' },
      tunic: { className: 'mens_clothing', template: null, held: true, name: 'Silk Tunic' },
      deed: { className: 'deed', template: null, held: true, name: 'Manor Deed' },
    },
  };

  for (const k of Object.keys(quest.items)) {
    permanentQuestItem(invCtx, p, quest, k, () => '');
  }

  assert.equal(quest.notes.length, 0, 'none of the non-standard items stayed trapped in journal');
  assert.equal(p.rpg.inventory.length, Object.keys(quest.items).length);
  for (const [k, it] of Object.entries(quest.items)) {
    assert.equal(it.held, false, `${k} moved out of journal`);
    assert.equal(it.permanent, true, `${k} marked permanent`);
    assert.ok(it.template, `${k} received durable template`);
  }

  // Ordinary records: no `quest` marker, which would make them untradeable and unstorable.
  assert.ok(p.rpg.inventory.every((i) => i.quest === undefined), 'converted items are not quest items');
  assert.ok(p.rpg.inventory.some((i) => i.template === 'religious-item'));

  // Survives JSON save/reload + inventory normalizeRpg!
  const reloaded = JSON.parse(JSON.stringify(p.rpg));
  normalizeRpg(reloaded);
  assert.equal(reloaded.inventory.length, Object.keys(quest.items).length);
  assert.ok(reloaded.inventory.some((i) => i.template === 'religious-item'));
});

test('permanentFallbackItem handles custom classes and rejects gold/artifacts', () => {
  assert.equal(permanentFallbackItem({ className: 'gold', gold: 100 }), null);
  assert.equal(permanentFallbackItem({ className: 'artifact' }), null);
  assert.deepEqual(permanentFallbackItem({ className: 'exotic_curio', name: 'Dwemer Gyro' }), { template: 'glass-jar' });
});
