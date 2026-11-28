// Package 17 quest engine: the classic opcodes identified from the installed QBN files and the objective families
// they drive. Synthetic fixtures below are written for these tests and are NOT Daggerfall quests; they only exercise
// the script syntax the decompiler emits. Tests marked "classic" read the operator's ARENA2 from gamedata/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installQuests } from '../server/rpg/quests.js';
import { parseQuest } from '../server/rpg/quests/script.js';
import { analyseQuest } from '../server/rpg/quests/engine.js';
import { compileAction } from '../server/rpg/quests/actions.js';
import { readQbn, decompileQbn } from '../server/rpg/quests/qbn.js';
import { loadCatalog, metaFromName } from '../server/rpg/quests/catalog.js';

const ARENA2 = [process.env.ARENA2_DIR, 'gamedata/DaggerfallGameFiles/arena2', 'gamedata/arena2', 'gamedata/ARENA2'].filter(Boolean).find((d) => existsSync(join(d, 'A0C00Y10.QBN')));
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
TEST LOG.

Message:  1011
TEST ASK: will you help?

Message:  1012
TEST YOU FEEL ILL.

Message:  1013
TEST LETTER TEXT.

Message:  1015
TEST LEFT AT THE SHRINE.
`;

/** SYNTHETIC: branching job with legal standing, an illness, a spell to cast and a letter that chains a second job. */
const BRANCHES = `${head('T0C00Y11', 'Synthetic branches')}
QBN:
Item _reward_ gold range 50 to 50
Item _letter_ letter used 1013
Item _relic_ religious

Person _giver_ group Questor
Person _hermit_ group Resident1 remote

Place _shrine_ local temple

Clock _late_ 3.00:00

	log 1010 step 0
	start timer _late_
	prompt 1011 yes _yes_ no _no_
	npc _hermit_ at home
	cast spell 51 do _slept_

_yes_ task:
	legal repute +10
	make pc ill with disease 7 saying 1012
	pick one of _red_ _blue_

_no_ task:
	legal repute -20
	end quest

variable _red_
variable _blue_

_learned_ task:
	level 2 completed

_liked_ task:
	when repute with faction 201 is at least 5

variable _slept_

_left_ task:
	dropped _relic_ at _shrine_ saying 1015

_handed_ task:
	when _slept_ and _learned_ and _left_
	cure disease 7
	give pc _letter_ notify 1013
	_letter_ used do _chain_

_chain_ task:
	start quest T0C00Y12
	give pc _reward_
	end quest

_late_ task:
	end quest
`;

/** SYNTHETIC: chained follow-up, started by the first job; sends a foe after the player (town or site, not wilderness). */
const FOLLOW = `${head('T0C00Y12', 'Synthetic follow-up')}
QBN:
Person _giver_ group Questor
Foe _stalker_ is Giant_rat

	send _stalker_ every 1 minutes 3 times with 100% success
`;

const fixtureCatalog = (...texts) => {
  const quests = new Map();
  for (const text of texts) {
    const def = parseQuest(text);
    // Only the first quest is offered by the giver; the follow-up is started by `start quest` alone.
    const group = quests.size ? null : 'Commoners';
    quests.set(def.name, { name: def.name, source: 'script', def, meta: { ...metaFromName(def.name), group, membership: 'N', minReq: 0 }, analysis: analyseQuest(def) });
  }
  return { quests, failures: [], listSource: 'test' };
};

function makeWorld(catalog) {
  let clock = 0;
  const players = new Map();
  const sent = new Map();
  const calls = { legal: [], apply: [], cure: [], emitted: [] };
  const features = [
    (ctx) => {
      ctx.onAction('npc.talk', (p, { targetId }) => ctx.emit('talk', { player: p, entity: ctx.entities.get(targetId) }));
      ctx.onAction('npc.topic', (p, { targetId }) => ctx.emit('npcWork', { player: p, entity: ctx.entities.get(targetId) }));
      ctx.services.reputation = (p, f) => p.rpg.factions?.[f] ?? 0;
      ctx.services.adjustReputation = (p, f, d) => { p.rpg.factions = p.rpg.factions || {}; p.rpg.factions[f] = (p.rpg.factions[f] ?? 0) + d; };
      ctx.services.addGold = (p, n) => { p.rpg.gold = (p.rpg.gold ?? 0) + n; };
      // Inventory stand-in: real items with ids, so `give item to` can be seen taking one back.
      let seq = 0;
      ctx.services.giveItem = (p, template, quantity = 1) => {
        const it = { id: `it${++seq}`, template, quantity };
        (p.rpg.inventory ||= []).push(it);
        return it;
      };
      ctx.services.takeItem = (p, id) => { p.rpg.inventory = (p.rpg.inventory || []).filter((i) => i.id !== id); };
      // Stand-ins for the law (package 14) and condition (package 10) owners' published services.
      ctx.services.law = { regionOf: () => 'Daggerfall', changeLegalRep: (p, region, delta, reason) => calls.legal.push({ id: p.id, region, delta, reason }) };
      ctx.services.applyCondition = (p, what) => calls.apply.push({ id: p.id, ...what });
      ctx.services.cureCondition = (p, what) => calls.cure.push({ id: p.id, what });
      for (const k of ['questLegalRepute', 'questDisease', 'questCure']) ctx.on(k, (ev) => calls.emitted.push(k + ':' + ev.player.id));
    },
    (ctx) => installQuests(ctx, { catalog }),
  ];
  const rt = createRpgRuntime({
    players, features, dataPath: null,
    save: () => {},
    send: (p, msg) => { if (!sent.has(p.id)) sent.set(p.id, []); sent.get(p.id).push(msg); },
    now: () => clock,
    log: { error() {}, warn() {}, info() {} },
  });
  const giver = { id: 'npc:test:0', kind: 'npc', role: 'crier', title: 'Town Crier', name: 'Anna Giver', location: TOWN, x: 0, z: -3, yaw: 0, questGiver: true, faction: 201 };
  rt.entities.set(giver.id, giver);
  const join = (id, name) => {
    const p = { id, name, x: 0, z: -2, yaw: 0, rpg: { gold: 0, location: TOWN, character: { name, level: 1, gender: 'Male' } } };
    players.set(id, p);
    rt.join(p);
    return p;
  };
  const events = (p, kind) => (sent.get(p.id) || []).filter((m) => m.type === 'gameEvent' && (!kind || m.event.kind === kind)).map((m) => m.event);
  const advance = (ms) => { clock += ms; for (let i = 0; i < 3; i++) rt.tick(1); };
  return { rt, players, giver, join, events, advance, calls };
}

/** SYNTHETIC: the player is handed a gem, then the script gives it to a foe (GiveItem.cs). */
const HANDOFF = `${head('T0C00Y13', 'Synthetic hand-off')}
QBN:
Item _gem_ ruby
Foe _thief_ is Thief

	give pc _gem_
	start timer _later_

Clock _later_ 0.00:01 0.00:00

_later_ task:
	give item _gem_ to _thief_
`;

test('give item to: the foe takes the quest item out of the player inventory (GiveItem.cs)', () => {
  const w = makeWorld(fixtureCatalog(HANDOFF));
  const p = w.join(1, 'Dara');
  ok(w.rt.act(p, 'npc.topic', { targetId: w.giver.id }));
  ok(w.rt.act(p, 'quest.accept', { offerId: w.events(p, 'questOffer').at(-1).offerId }));
  const inst = p.rpg.quests.active[0];
  assert.equal(inst.items.gem.given, true, 'the gem was handed over as a real item');
  assert.equal(p.rpg.inventory.length, 1);
  w.advance(5 * 60_000);
  assert.equal(inst.items.gem.holder, 'thief');
  assert.deepEqual(inst.foes.thief.holds, ['gem']);
  assert.equal(p.rpg.inventory.length, 0, 'the gem left the player inventory');
  assert.equal(inst.items.gem.given, false);
});

// ------------------------------------------------------------------ decoding

test('new opcode lines compile to their engine actions', () => {
  const cases = {
    'when repute with faction 391 is at least 15': ['whenRepute', 'exact'],
    'level 8 completed': ['levelCompleted', 'exact'],
    'cast spell 51 do _S.03_': ['castSpellDo', 'exact'],
    'dropped _I.00_ at _L.00_ saying 1015': ['dropped', 'exact'],
    'reveal _x_ in province 11 at 484567': ['revealAt', 'exact'],
    'npc _P.00_ at home': ['npcAtHome', 'exact'],
    'legal repute -20': ['legalRepute', 'exact'],
    'cast spell 17 on _F.00_': ['castOnFoe', 'approx'],
    'make pc ill with disease 7 saying 1012': ['makeIll', 'approx'],
    'cure lycanthropy': ['cure', 'approx'],
    'send _F.01_ every 80 minutes 30 times with 15% success': ['createFoe', 'approx'],
    'clicked _P.02_ and at least 20 gold otherwise do _S.10_': ['clickedNpcGold', 'exact'],
    'add foe _x_ face': ['addFoeFace', 'exact'],
    'drop foe _x_ face': ['addFoeFace', 'exact'],
    'add _P.00_ face': ['addFace', 'exact'],
    'add _P.00_ face saying 1012': ['addFace', 'exact'],
    'drop _P.00_ face': ['dropFace', 'exact'],
    'location marker _L.00_': ['locationMarker', 'ignored'],
    'play sound 11146 every 1 minutes 1 times': ['playSound', 'approx'],
  };
  for (const [line, [name, status]] of Object.entries(cases)) {
    const a = compileAction(line);
    assert.equal(a.name, name, line);
    assert.equal(a.status, status, line);
  }
  assert.equal(compileAction('send _F.01_ every 80 minutes 30 times with 15% success').args.send, true);
  assert.equal(compileAction('cast spell Shield on _giver_').status, 'unsupported', 'named spells on actors stay unsupported');
});

test('classic: every installed QBN opcode is decoded (including 0x3c in Auriel’s Bow, B0B71Y03)', { skip: !ARENA2 && 'no ARENA2 in gamedata/' }, () => {
  const unknown = new Map();
  for (const f of readdirSync(ARENA2).filter((x) => /\.qbn$/i.test(x))) {
    for (const code of decompileQbn(readQbn(readFileSync(join(ARENA2, f)))).unknownOpcodes) unknown.set(code, [...(unknown.get(code) ?? []), f]);
  }
  assert.deepEqual([...unknown.keys()], [], JSON.stringify([...unknown]));
  // Operand order, checked against Daggerfall Unity's translations of the same quests.
  const lines = (n) => decompileQbn(readQbn(readFileSync(join(ARENA2, `${n}.QBN`)))).lines.join('\n');
  assert.match(lines('B0B71Y03'), /_0x3c_ 19/);
  assert.match(lines('K0C30Y03'), /send _\S+_ every 80 minutes 30 times with 15% success/);
  assert.match(lines('S0000021'), /send _\S+_ every 1410 minutes indefinitely with 100% success/);
  assert.match(lines('A0C00Y11'), /clicked _\S+_ and at least 20 gold otherwise do _S\.10_/);
  assert.match(lines('R0C60Y24'), /reveal _\S+_ in province 11 at 484567/);
  assert.match(lines('S0000011'), /when repute with faction 391 is at least 15/);
  assert.match(lines('S0000010'), /level 8 completed/);
});

test('classic: random-dungeon placement no longer blocks; B0B71Y03 is offerable with artifacts and 243/302 quests are offerable', { skip: !ARENA2 && 'no ARENA2 in gamedata/' }, () => {
  const cat = loadCatalog({ dataPath: ARENA2, artifact: () => true });
  const all = [...cat.quests.values()];
  assert.ok(!all.some((q) => q.analysis.unsupported.some((u) => /random dungeons are not placed/.test(u))));
  assert.ok(!all.some((q) => q.analysis.unsupported.some((u) => /unknown opcode/i.test(u))));
  for (const n of ['K0C00Y09', 'A0C01Y03', 'N0C00Y12', 'R0C10Y21', 'B0B71Y03']) assert.equal(cat.quests.get(n).analysis.offerable, true, n);
  assert.equal(all.filter((q) => q.analysis.offerable).length, 243, 'all 243 guild/social/knightly quests are offerable');
  assert.deepEqual(cat.failures.map((f) => f.name).sort(), ['80C00Y00', 'A0C00Y04', 'N0C00Y01', 'R0C40Y23'], 'four QBN files ship without QRC text');
  const dragonslayer = cat.quests.get('B0B70Y16').def.resources;
  assert.deepEqual(dragonslayer.get('l.00').types, ['dungeon14']);
  assert.equal(dragonslayer.get('l.00').only, true);
  const binary = readQbn(readFileSync(join(ARENA2, 'B0B70Y16.QBN')));
  assert.deepEqual(binary.foes.map((foe) => foe.mobile), [40]);
});

// ------------------------------------------------------------------ runtime

test('a required remote dungeon type limits both ordinary offers and their destinations', () => {
  const script = `${head('T0C00Y13', 'Synthetic den quest')}
QBN:
Place _den_ remote dungeon14 only
  reveal _den_
`;
  const w = makeWorld(fixtureCatalog(script));
  const locations = [{ id: 'town:Daggerfall/Other Ruin', type: 'ruin', dungeonType: 6 }];
  w.rt.ctx.services.travel = {
    lookup: (id) => id === TOWN ? { regionIndex: 17 } : null,
    regionLocations: () => locations,
  };
  const p = w.join(1, 'Rhea');
  assert.match(w.rt.act(p, 'quest.request', { targetId: w.giver.id }).error, /no work for you right now/);

  const den = 'town:Daggerfall/Dragon Den';
  locations.push({ id: den, type: 'ruin', dungeonType: 14 });
  ok(w.rt.act(p, 'quest.request', { targetId: w.giver.id }));
  const offer = w.events(p, 'questOffer').at(-1);
  ok(w.rt.act(p, 'quest.accept', { offerId: offer.offerId }));
  assert.equal(p.rpg.quests.active[0].places.den.location, den);
});

test('branches, refusal, legal standing, illness, spell, drop, letter and chaining run once per player', () => {
  const w = makeWorld(fixtureCatalog(BRANCHES, FOLLOW));
  const p = w.join(1, 'Rhea');
  const q = w.join(2, 'Quill');

  // Player 2 takes the refusal branch of the prompt: legal repute -20, quest over, nothing paid.
  ok(w.rt.act(q, 'npc.topic', { targetId: w.giver.id }));
  const qOffer = w.events(q, 'questOffer').find((o) => /T0C00Y11/.test(o.text));
  ok(w.rt.act(q, 'quest.accept', { offerId: qOffer.offerId }));
  assert.match(w.events(q, 'questPrompt').at(-1).text, /TEST ASK/);
  ok(w.rt.act(q, 'quest.answer', { uid: q.rpg.quests.active[0].uid, yes: false }));
  assert.deepEqual(w.calls.legal.filter((c) => c.id === 2).map((c) => c.delta), [-20]);
  assert.equal(q.rpg.quests.active.length, 0);
  assert.equal(q.rpg.gold, 0);

  ok(w.rt.act(p, 'npc.topic', { targetId: w.giver.id }));
  ok(w.rt.act(p, 'quest.accept', { offerId: w.events(p, 'questOffer').find((o) => /T0C00Y11/.test(o.text)).offerId }));
  const uid = p.rpg.quests.active[0].uid;
  // A rejected action restores the character from its snapshot, so always read the live instance.
  const live = () => p.rpg.quests.active.find((i) => i.uid === uid) ?? p.rpg.quests.done.find((d) => d.uid === uid);
  let inst = live();
  assert.equal(inst.people.hermit.atHome, true, '0x52 keeps the person at home');
  assert.equal(inst.people.hermit.location, inst.people.hermit.home);
  ok(w.rt.act(p, 'quest.answer', { uid: inst.uid, yes: true }));
  assert.deepEqual(w.calls.legal.filter((c) => c.id === 1), [{ id: 1, region: 'Daggerfall', delta: 10, reason: 'quest' }]);
  assert.deepEqual(w.calls.apply, [{ id: 1, disease: 7 }], 'illness handed to the condition owner');
  assert.ok(w.events(p, 'questMessage').some((e) => /YOU FEEL ILL/.test(e.text)));
  assert.equal(Number(inst.tasks.red.t) + Number(inst.tasks.blue.t), 1, 'pick one of starts exactly one branch');

  // Repute condition is not latching: it follows the live value.
  p.rpg.factions = { 201: 5 };
  w.advance(1000);
  assert.equal(inst.tasks.liked.t, true);
  p.rpg.factions = { 201: 4 };
  w.advance(1000);
  assert.equal(inst.tasks.liked.t, false, 'drops again when reputation falls');

  // Dropping the relic only works at the shrine (here: the town stands in for an unsurveyed temple).
  inst = live();
  inst.items.relic.held = true;
  const far = p.rpg.location;
  p.rpg.location = 'town:Daggerfall/Daggerfall';
  assert.match(w.rt.act(p, 'quest.drop', { uid: inst.uid, item: 'relic' }).error, /not where/);
  p.rpg.location = far;
  assert.equal(w.rt.act(q, 'quest.drop', { uid: inst.uid, item: 'relic' }).ok, false, 'another player cannot act on it');
  ok(w.rt.act(p, 'quest.drop', { uid: inst.uid, item: 'relic' }));
  inst = live();
  assert.equal(inst.tasks.left.t, true);

  // Level and spell conditions.
  p.rpg.character.level = 2;
  w.rt.ctx.emit('spellCast', { player: p, spell: { id: 'std:17' } });
  w.advance(1000);
  assert.equal(inst.tasks.slept.t, false, 'another spell does not count');
  w.rt.ctx.emit('spellCast', { player: q, spell: { id: 'std:51' } });
  w.advance(1000);
  assert.equal(inst.tasks.slept.t, false, 'another player casting does not count');
  w.rt.ctx.emit('spellCast', { player: p, spell: { id: 'std:51' } });
  w.advance(1000);
  assert.equal(inst.tasks.handed.t, true);
  assert.deepEqual(w.calls.cure, [{ id: 1, what: { disease: 7 } }]);
  assert.equal(inst.items.letter.held, true, 'the letter is in the journal');
  assert.equal(p.rpg.gold, 0, 'nothing paid before the letter is read');

  // Reading the letter chains the follow-up and pays exactly once.
  ok(w.rt.act(p, 'quest.use', { uid: inst.uid, item: 'letter' }));
  assert.ok(w.events(p, 'questMessage').some((e) => /LETTER TEXT/.test(e.text)));
  assert.equal(p.rpg.gold, 50);
  assert.equal(p.rpg.quests.done.find((d) => d.name === 'T0C00Y11').result, 'success');
  const follow = p.rpg.quests.active.find((i) => i.name === 'T0C00Y12');
  assert.ok(follow, 'start quest chained the follow-up');
  w.advance(10_000);
  assert.equal(p.rpg.gold, 50, 'paid once');

  // CreateFoe.TryPlacement: `send` deploys only inside a location's rect (PlayerGPS.IsPlayerInLocationRect: a town or
  // site, indoors or out). In open wilderness a successful roll waits, and no new spawn is rolled meanwhile.
  const before = follow.foes.stalker.ambush ?? 0;
  p.rpg.location = 'wilderness:Daggerfall/100,200';
  w.advance(5 * 60_000);
  assert.equal(follow.foes.stalker.ambush ?? 0, before, 'no sent foe in the wilderness');
  p.rpg.location = 'interior:Daggerfall/Gothway Garden/3,0/16';
  w.advance(1000);
  assert.equal(follow.foes.stalker.ambush, before + 1, 'the one pending spawn deploys inside the town (indoors counts)');
  assert.equal(follow.foes.stalker.location, p.rpg.location);
  assert.ok(w.calls.emitted.includes('questLegalRepute:1') && w.calls.emitted.includes('questDisease:1') && w.calls.emitted.includes('questCure:1'));
});

test('the deadline fails the branching job and pays nothing', () => {
  const w = makeWorld(fixtureCatalog(BRANCHES, FOLLOW));
  const p = w.join(1, 'Cai');
  ok(w.rt.act(p, 'npc.topic', { targetId: w.giver.id }));
  ok(w.rt.act(p, 'quest.accept', { offerId: w.events(p, 'questOffer').find((o) => /T0C00Y11/.test(o.text)).offerId }));
  ok(w.rt.act(p, 'quest.answer', { uid: p.rpg.quests.active[0].uid, yes: true }));
  w.rt.ctx.emit('timeSpent', { player: p, minutes: 3 * 1440 + 5 });
  w.advance(1000);
  assert.equal(p.rpg.quests.done[0].result, 'failed');
  assert.equal(p.rpg.gold, 0);
  assert.ok(!p.rpg.quests.active.some((i) => i.name === 'T0C00Y12'), 'no chained job after failure');
});

test('special triggers: offerSpecial uses the normal offer flow; startSpecial runs without an offer', () => {
  const w = makeWorld(fixtureCatalog(BRANCHES, FOLLOW));
  const p = w.join(1, 'Dana');
  const svc = w.rt.ctx.services.quests;
  const offer = svc.offerSpecial(p, 'T0C00Y12', { giver: { id: w.giver.id, name: 'Summoner', faction: 7, location: TOWN }, source: 'daedra' });
  assert.equal(w.events(p, 'questOffer').at(-1).offerId, offer.id);
  ok(w.rt.act(p, 'quest.accept', { offerId: offer.id }));
  assert.equal(p.rpg.quests.active[0].special, 'daedra');
  assert.equal(p.rpg.quests.active[0].giver.faction, 7);
  assert.throws(() => svc.offerSpecial(p, 'NOPE0000', { giver: { id: 'x', name: 'y' } }), /not installed/);
  const inst = svc.startSpecial(p, 'T0C00Y11', { source: 'cure', factionId: 3 });
  assert.equal(inst.special, 'cure');
  assert.deepEqual(svc.startSpecial(p, 'T0C00Y11', { source: 'cure' }).blocked, ['T0C00Y11 is already running']);
});
