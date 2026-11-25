// Quest system tests. Synthetic fixtures below are written for these tests and are NOT
// Daggerfall quests; they only exercise the script syntax. Tests marked "classic" read the
// operator's own ARENA2 files from gamedata/ and are skipped when those are absent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installQuests } from '../server/rpg/quests.js';
import { parseQuest, parseQrcText } from '../server/rpg/quests/script.js';
import { analyseQuest } from '../server/rpg/quests/engine.js';
import { compileAction, ACTION_TABLE } from '../server/rpg/quests/actions.js';
import { readQbn, decompileQbn, symbolHash } from '../server/rpg/quests/qbn.js';
import { readQrc } from '../server/rpg/quests/qrc.js';
import { expand } from '../server/rpg/quests/text.js';
import { loadCatalog, catalogReport, metaFromName, parseQuestList } from '../server/rpg/quests/catalog.js';

const ARENA2 = ['gamedata/DaggerfallGameFiles/arena2', 'gamedata/arena2', 'gamedata/ARENA2'].find((d) => existsSync(join(d, 'A0C00Y10.QBN')));
const DFU_QUESTS = '.ref/daggerfall-unity/Assets/StreamingAssets/Quests';

test('building macros preserve proper names, including when the quest supplies the article', () => {
  const location = 'interior:Daggerfall/Gothway Garden/2,1/15';
  const def = { resources: new Map([['shop', { kind: 'place' }], ['giver', { kind: 'person' }]]) };
  const inst = {
    giver: { location, buildingName: 'The Superior General Store' },
    people: { giver: { location, questor: true } },
    places: { shop: { location, buildingName: 'The Superior General Store' } },
  };
  const render = template => expand(template, def, inst, { here: location }).text;
  assert.equal(render('Go to _shop_. Ask at the __giver_.'), 'Go to The Superior General Store. Ask at the Superior General Store.');
  assert.equal(render('The =shop_ in ___giver_.'), 'The Superior General Store in Gothway Garden.');
  delete inst.giver.buildingName;
  inst.people.giver.place = 'shop';
  assert.equal(render('__giver_'), 'The Superior General Store');
  inst.places.shop = { location, building: 'generalstore' };
  assert.equal(render('Look in the _shop_ for _unresolved_.'), 'Look in the general store for _unresolved_.');
});

// ------------------------------------------------------------------ synthetic fixtures

/** SYNTHETIC test quest (not vanilla content): fetch a parcel, defeat a rat, report back. */
const FIXTURE = `
Quest: T0C00Y01
DisplayName: Synthetic test errand

QRC:

QuestorOffer:  [1000]
TEST OFFER for %pcn: bring _parcel_ to _friend_ and deal with =pest_.

RefuseQuest:  [1001]
TEST REFUSED.

AcceptQuest:  [1002]
TEST ACCEPTED. _friend_ waits in __home_.

QuestComplete:  [1004]
TEST COMPLETE. Here is _reward_.

Message:  1010
TEST LOG: deliver _parcel_ to _friend_.

Message:  1020
TEST PEST SLAIN.

QBN:
Item _parcel_ letter used 1010
Item _reward_ gold range 40 to 40

Person _giver_ group Questor
Person _friend_ group Resident1

Place _home_ local house2

Clock _late_ 2.00:00

Foe _pest_ is Giant_rat

	get item _parcel_
	log 1010 step 0
	place npc _friend_ at _home_
	place foe _pest_ at _home_
	start timer _late_

_delivered_ task:
	toting _parcel_ and _friend_ clicked

_pestdead_ task:
	killed 1 _pest_
	say 1020

_paid_ task:
	when _delivered_ and _pestdead_
	give pc _reward_
	end quest

_late_ task:
	end quest
`;

const UNSUPPORTED_FIXTURE = `
Quest: T0C00Y02
DisplayName: Synthetic unsupported test

QRC:

QuestorOffer:  [1000]
TEST OFFER.

QBN:
Person _giver_ group Questor

	cast spell Shield on _giver_
	frobnicate the widget

_done_ task:
	end quest
`;

const fixtureCatalog = (...texts) => {
  const quests = new Map();
  for (const text of texts) {
    const def = parseQuest(text);
    quests.set(def.name, { name: def.name, source: 'script', def, meta: { ...metaFromName(def.name), group: 'Commoners', membership: 'N', minReq: 0 }, analysis: analyseQuest(def) });
  }
  return { quests, failures: [], listSource: 'test' };
};

// ------------------------------------------------------------------ harness

function makeWorld({ catalog, dataPath = null, nameBanks, portals } = {}) {
  let clock = 0;
  const players = new Map();
  const sent = new Map();
  const saves = [];
  const features = [
    // Stand-in for the NPC feature: talk emits `talk`, the work topic emits `npcWork`.
    (ctx) => {
      ctx.onAction('npc.talk', (p, { targetId }) => ctx.emit('talk', { player: p, entity: ctx.entities.get(targetId) }));
      ctx.onAction('npc.topic', (p, { targetId }) => ctx.emit('npcWork', { player: p, entity: ctx.entities.get(targetId) }));
      ctx.services.reputation = (p, f) => p.rpg.factions?.[f] ?? 0;
      ctx.services.adjustReputation = (p, f, d) => { p.rpg.factions = p.rpg.factions || {}; p.rpg.factions[f] = (p.rpg.factions[f] ?? 0) + d; };
      ctx.services.addGold = (p, n) => { p.rpg.gold = (p.rpg.gold ?? 0) + n; };
      if (portals) ctx.services.portals = portals;
    },
    (ctx) => installQuests(ctx, { catalog, nameBanks }),
    // Stand-in for combat: kill emits `kill` with the entity.
    (ctx) => ctx.onAction('combat.attack', (p, { targetId }) => {
      const e = ctx.entities.get(targetId);
      e.hp = 0;
      e.dead = true;
      ctx.emit('kill', { player: p, entity: e });
    }),
  ];
  const rt = createRpgRuntime({
    players,
    features,
    dataPath,
    save: (list) => saves.push(list.map((p) => p.id)),
    send: (p, msg) => { if (!sent.has(p.id)) sent.set(p.id, []); sent.get(p.id).push(msg); },
    now: () => clock,
    log: { error() {}, warn() {}, info() {} },
  });
  const giver = { id: 'npc:test:0', kind: 'npc', role: 'crier', title: 'Town Crier', name: 'Anna Giver', location: 'town:Daggerfall/Gothway Garden', x: 0, z: -3, yaw: 0, questGiver: true, faction: 201 };
  rt.entities.set(giver.id, giver);
  const join = (id, name) => {
    const p = { id, name, x: 0, z: -2, yaw: 0, rpg: { gold: 0, character: { name, level: 1, gender: 'Male' } } };
    players.set(id, p);
    rt.join(p);
    return p;
  };
  const events = (p, kind) => (sent.get(p.id) || []).filter((m) => m.type === 'gameEvent' && (!kind || m.event.kind === kind)).map((m) => m.event);
  const advance = (ms) => { clock += ms; for (let i = 0; i < 3; i++) rt.tick(1); };
  return { rt, players, giver, join, events, advance, saves, setClock: (v) => { clock = v; } };
}

const ok = (r) => assert.equal(r.ok, true, r.error);

// ------------------------------------------------------------------ parser and actions

test('script parser reads resources, tasks and message variants', () => {
  const def = parseQuest(FIXTURE);
  assert.equal(def.name, 'T0C00Y01');
  assert.equal(def.displayName, 'Synthetic test errand');
  assert.deepEqual([...def.resources.keys()].sort(), ['friend', 'giver', 'home', 'late', 'parcel', 'pest', 'reward']);
  assert.equal(def.resources.get('reward').range[1], 40);
  assert.equal(def.resources.get('giver').questor, true);
  assert.equal(def.tasks[0].type, 'headless');
  assert.equal(def.tasks.find((t) => t.symbol === 'paid').actions[0].name, 'when');
  assert.match(def.messages.get(1000).variants[0], /TEST OFFER/);
  const msgs = parseQrcText(['Message:  1011', 'first', '<--->', 'second', '']);
  assert.deepEqual(msgs.get(1011).variants, ['first', 'second']);
  assert.deepEqual(analyseQuest(def).unsupported, []);
});

test('unknown and unimplemented actions are inventoried, never treated as done', () => {
  assert.equal(compileAction('frobnicate the widget').name, 'unknown');
  assert.equal(compileAction('cast spell Shield on _giver_').status, 'unsupported');
  assert.equal(compileAction('dialog link for location _a_ person _b_').status, 'ignored');
  const a = analyseQuest(parseQuest(UNSUPPORTED_FIXTURE));
  assert.equal(a.offerable, false);
  assert.ok(a.unsupported.some((u) => u.includes('frobnicate')));
  assert.ok(a.unsupported.some((u) => u.includes('cast spell')));
  assert.ok(ACTION_TABLE.length > 50);
});

// ------------------------------------------------------------------ end-to-end on the runtime

test('offer, accept, talk, kill and reward run on the server with one payout', () => {
  const w = makeWorld({ catalog: fixtureCatalog(FIXTURE, UNSUPPORTED_FIXTURE) });
  const p = w.join(1, 'Rhea');
  ok(w.rt.act(p, 'npc.topic', { targetId: w.giver.id }));
  const offer = w.events(p, 'questOffer').at(-1);
  assert.equal(offer.title, 'Synthetic test errand', 'the unsupported fixture must never be offered');
  assert.match(offer.text, /TEST OFFER for Rhea/);
  ok(w.rt.act(p, 'quest.accept', { offerId: offer.offerId }));
  const inst = p.rpg.quests.active[0];
  assert.equal(inst.items.parcel.held, true, 'get item gives the parcel');
  assert.equal(inst.log[0].step, 0);
  assert.match(inst.log[0].text, /deliver letter to/);
  // friend and rat are private entities in the player's town
  const mine = [...w.rt.entities.values()].filter((e) => e._quest?.owner === 1);
  const friend = mine.find((e) => e.kind === 'npc');
  const rat = mine.find((e) => e.kind === 'monster');
  assert.ok(friend && rat);
  assert.deepEqual(friend.visibleTo, [1]);
  ok(w.rt.act(p, 'npc.talk', { targetId: friend.id }));
  assert.equal(inst.items.parcel.held, false, 'toting hands the parcel over');
  assert.equal(p.rpg.gold, 0);
  ok(w.rt.act(p, 'combat.attack', { targetId: rat.id }));
  assert.ok(w.events(p, 'questMessage').some((e) => /TEST PEST SLAIN/.test(e.text)));
  assert.equal(p.rpg.gold, 40, 'reward paid once');
  assert.equal(p.rpg.quests.active.length, 0);
  assert.equal(p.rpg.quests.done[0].result, 'success');
  // re-running does nothing more
  w.advance(10_000);
  assert.equal(p.rpg.gold, 40);
});

test('rejoin recovers a pre-naming save’s quest giver building from the original room', async () => {
  const w = makeWorld({ catalog: fixtureCatalog(FIXTURE) });
  const p = w.join(1, 'Ada');
  ok(w.rt.act(p, 'npc.topic', { targetId: w.giver.id }));
  ok(w.rt.act(p, 'quest.accept', { offerId: w.events(p, 'questOffer').at(-1).offerId }));
  const inst = p.rpg.quests.active[0];
  const location = 'interior:Daggerfall/Gothway Garden/2,1/15';
  inst.giver = { id: 'npc:i:oldroom:0', name: 'Test Giver', location };
  const reads = [];
  w.rt.ctx.services.npcs = { source: { interior: async id => {
    reads.push(id);
    return { building: { name: 'The Superior General Store' } };
  } } };
  w.rt.join(p);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(inst.giver, { id: 'npc:i:oldroom:0', name: 'Test Giver', location, buildingName: 'The Superior General Store' });
  w.rt.join(p);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(reads, [location]);
});

test('two players progress the same quest independently, and state survives a reload', () => {
  const w = makeWorld({ catalog: fixtureCatalog(FIXTURE) });
  const a = w.join(1, 'Ada');
  const b = w.join(2, 'Bo');
  for (const p of [a, b]) {
    ok(w.rt.act(p, 'npc.topic', { targetId: w.giver.id }));
    ok(w.rt.act(p, 'quest.accept', { offerId: w.events(p, 'questOffer').at(-1).offerId }));
  }
  const ratOf = (id) => [...w.rt.entities.values()].find((e) => e._quest?.owner === id && e.kind === 'monster');
  assert.notEqual(ratOf(1).id, ratOf(2).id);
  ok(w.rt.act(a, 'combat.attack', { targetId: ratOf(1).id }));
  assert.equal(a.rpg.quests.active[0].foes.pest.kills, 1);
  assert.equal(b.rpg.quests.active[0].foes.pest.kills, 0);
  // Reload Bo from JSON (as the database would) and finish the quest.
  const saved = JSON.parse(JSON.stringify(b.rpg));
  w.rt.leave(b);
  w.players.delete(2);
  assert.equal(ratOf(2), undefined, 'private entities leave with their owner');
  const b2 = { id: 2, name: 'Bo', x: 0, z: -2, yaw: 0, rpg: saved };
  w.players.set(2, b2);
  w.rt.join(b2);
  ok(w.rt.act(b2, 'combat.attack', { targetId: ratOf(2).id }));
  const friend = [...w.rt.entities.values()].find((e) => e._quest?.owner === 2 && e.kind === 'npc');
  ok(w.rt.act(b2, 'npc.talk', { targetId: friend.id }));
  assert.equal(b2.rpg.gold, 40);
  assert.equal(a.rpg.gold, 0, 'Ada has not delivered her parcel');
});

test('timers end the quest as failure and refusal shows the refuse text', () => {
  const w = makeWorld({ catalog: fixtureCatalog(FIXTURE) });
  const p = w.join(1, 'Cai');
  ok(w.rt.act(p, 'npc.topic', { targetId: w.giver.id }));
  ok(w.rt.act(p, 'quest.refuse', { offerId: w.events(p, 'questOffer').at(-1).offerId }));
  assert.match(w.events(p, 'questRefused').at(-1).text, /TEST REFUSED/);
  ok(w.rt.act(p, 'npc.topic', { targetId: w.giver.id }));
  ok(w.rt.act(p, 'quest.accept', { offerId: w.events(p, 'questOffer').at(-1).offerId }));
  w.advance(2 * 1440 * 5000 + 10_000); // fallback clock: 5 s per game minute
  assert.equal(p.rpg.quests.active.length, 0);
  assert.equal(p.rpg.quests.done[0].result, 'failed');
  assert.equal(p.rpg.gold, 0);
});

test('accepting a stale offer or answering without a prompt is refused', () => {
  const w = makeWorld({ catalog: fixtureCatalog(FIXTURE) });
  const p = w.join(1, 'Dee');
  assert.equal(w.rt.act(p, 'quest.accept', { offerId: 'nope' }).ok, false);
  assert.equal(w.rt.act(p, 'quest.answer', { uid: 'x', yes: true }).ok, false);
});

// ------------------------------------------------------------------ classic binary formats (synthetic bytes)

test('QBN reader and decompiler handle a synthetic compiled quest', () => {
  // One state, one foe, two opcodes: start-up places nothing; state 0 "killed 1 foe" then "end quest".
  const ops = [
    [0x02, [[9, 0], [7, 0], [0, 1]], 0xffff],
    [0x06, [[9, 0]], 0xffff],
  ];
  const size = 60 + 14 + 8 + ops.length * 87;
  const b = Buffer.alloc(size);
  b.writeUInt16LE(1, 16 + 7 * 2); // foes
  b.writeUInt16LE(ops.length, 16 + 8 * 2); // opcodes
  b.writeUInt16LE(1, 16 + 9 * 2); // states
  b.writeUInt16LE(60, 36 + 7 * 2);
  b.writeUInt16LE(60 + 14 + 8, 36 + 8 * 2);
  b.writeUInt16LE(60 + 14, 36 + 9 * 2);
  b[60 + 3] = 129; // Spellsword
  b[60 + 4] = 1;
  b.writeUInt32LE(symbolHash('target'), 60 + 6);
  b.writeUInt32LE(symbolHash('done'), 60 + 14 + 4);
  ops.forEach(([code, args, msg], i) => {
    const o = 60 + 14 + 8 + i * 87;
    b.writeUInt16LE(code, o);
    b.writeUInt16LE(args.length, o + 4);
    args.forEach(([sec, val], a) => {
      b.writeUInt16LE(sec, o + 6 + a * 15 + 5);
      b.writeInt32LE(val, o + 6 + a * 15 + 7);
    });
    b.writeUInt16LE(msg, o + 81);
  });
  const dec = decompileQbn(readQbn(b));
  assert.deepEqual(dec.lines.filter(Boolean), ['Foe _F.00_ is Spellsword', '_S.00_ task:', '\tkilled 1 _F.00_', '\tend quest']);
  assert.equal(symbolHash('monster'), 13988);
  assert.equal(symbolHash('_delay_'), 3155);
});

test('QRC reader decodes a synthetic record with variants', () => {
  const body = Buffer.from([...Buffer.from('Line one'), 0xfd, ...Buffer.from(' line two'), 0xff, ...Buffer.from('Other'), 0xfe]);
  const b = Buffer.alloc(2 + 12 + body.length);
  b.writeUInt16LE(12, 0);
  b.writeUInt16LE(1000, 2);
  b.writeUInt32LE(14, 4);
  b.writeUInt16LE(0xffff, 8);
  b.writeUInt32LE(b.length, 10);
  body.copy(b, 14);
  assert.deepEqual(readQrc(b).get(1000).variants, ['Line one\nline two', 'Other']);
});

// ------------------------------------------------------------------ classic files (operator data)

test('classic: every ARENA2 QBN parses and most decode fully', { skip: !ARENA2 && 'no ARENA2 in gamedata/' }, () => {
  const files = readdirSync(ARENA2).filter((f) => /\.qbn$/i.test(f));
  assert.ok(files.length > 250);
  let clean = 0;
  for (const f of files) {
    const d = decompileQbn(readQbn(readFileSync(join(ARENA2, f))));
    if (!d.unknownOpcodes.length) clean++;
  }
  assert.ok(clean / files.length > 0.8, `${clean}/${files.length} decoded without unknown opcodes`);
});

test('classic: A0C00Y10 decompiles to the same task structure as its reference script', { skip: !ARENA2 && 'no ARENA2 in gamedata/' }, () => {
  const dec = decompileQbn(readQbn(readFileSync(join(ARENA2, 'A0C00Y10.QBN'))));
  const def = parseQuest(dec.lines.join('\n'), { name: 'A0C00Y10', messages: readQrc(readFileSync(join(ARENA2, 'A0C00Y10.QRC'))) });
  assert.deepEqual([...def.resources.values()].map((r) => r.kind).sort(), ['clock', 'clock', 'clock', 'foe', 'person', 'place']);
  assert.equal(def.resources.get('f.00').foeName, 'Spellsword');
  assert.ok(def.tasks.find((t) => t.symbol === 'S.07').actions.some((a) => a.name === 'killed'));
  assert.ok(def.messages.get(1000).variants[0].length > 20, 'offer text read from the classic QRC');
  assert.equal(analyseQuest(def).offerable, true);
  if (existsSync(join(DFU_QUESTS, 'A0C00Y10.txt'))) {
    const ref = parseQuest(readFileSync(join(DFU_QUESTS, 'A0C00Y10.txt'), 'latin1'));
    const shape = (d) => d.tasks.map((t) => `${t.type}:${t.actions.map((a) => a.name).sort().join(',')}`).sort();
    // Daggerfall Unity moved one "saying" onto its own `say` line; otherwise identical.
    const norm = (xs) => xs.map((s) => s.replace(',say', '')).join('|');
    assert.equal(norm(shape(def)), norm(shape(ref)));
  }
});

test('classic: catalogue offers original quests read only from ARENA2', { skip: !ARENA2 && 'no ARENA2 in gamedata/' }, () => {
  const cat = loadCatalog({ dataPath: ARENA2 });
  const r = catalogReport(cat);
  assert.ok(r.total > 290);
  const names = r.offerable.map((x) => x.name);
  for (const n of ['A0C00Y10', 'A0C01Y01', 'R0C10Y00', 'M0C00Y11', 'N0C00Y10']) assert.ok(names.includes(n), `${n} offerable`);
  // Random-dungeon people and foes now run (package 17); what still blocks is reported, never hidden.
  assert.ok(!r.topBlockers.some((b) => /random dungeons/.test(b.reason)));
  assert.ok(r.topBlockers.some((b) => /not a guild or social quest/.test(b.reason)), 'story-started quests are reported, not hidden');
});

test('classic: A0C00Y10 plays from offer to its kill on the shared runtime', { skip: !ARENA2 && 'no ARENA2 in gamedata/' }, () => {
  const cat = loadCatalog({ dataPath: ARENA2 });
  const only = { ...cat, quests: new Map([['A0C00Y10', cat.quests.get('A0C00Y10')]]) };
  const w = makeWorld({ catalog: only, dataPath: ARENA2 });
  const p = w.join(1, 'Elsa');
  ok(w.rt.act(p, 'npc.topic', { targetId: w.giver.id }));
  const offer = w.events(p, 'questOffer').at(-1);
  assert.ok(offer.text.length > 40);
  ok(w.rt.act(p, 'quest.accept', { offerId: offer.offerId }));
  const inst = p.rpg.quests.active[0];
  // Start-up asks message 1025; yes leads to 1016; yes again logs the job (classic flow).
  assert.equal(w.events(p, 'questPrompt').at(-1).id, 1025);
  ok(w.rt.act(p, 'quest.answer', { uid: inst.uid, yes: true }));
  assert.equal(w.events(p, 'questPrompt').at(-1).id, 1016);
  ok(w.rt.act(p, 'quest.answer', { uid: inst.uid, yes: true }));
  assert.equal(inst.log.length, 1);
  // The foe appears at the inn after the 6-hour clock (fallback: 5 s per game minute).
  w.advance(6 * 60 * 5000 + 5000);
  const foe = [...w.rt.entities.values()].find((e) => e._quest?.owner === 1 && e.kind === 'monster');
  assert.ok(foe, 'quest foe placed');
  assert.equal(foe.monsterId, 129);
  ok(w.rt.act(p, 'combat.attack', { targetId: foe.id }));
  assert.equal(inst.success, true, '`give pc nothing` marks success');
});

test('quest places bind to a surveyed building of the right type; pc at needs that interior', () => {
  const town = 'town:Daggerfall/Gothway Garden';
  const houses = [
    { kind: 'building', from: town, to: 'interior:tavern', label: 'Tavern', meta: { buildingType: 15 }, entrances: [{ inner: { x: 1, z: 2 } }] },
    { kind: 'building', from: town, to: 'interior:house', label: 'House', meta: { buildingType: 18 }, entrances: [{ inner: { x: 3, z: 4 } }] },
  ];
  const portals = { at: (from) => houses.filter((h) => h.from === from), into: (to) => houses.find((h) => h.to === to) ?? null };
  const w = makeWorld({ catalog: fixtureCatalog(FIXTURE), portals });
  const p = w.join(1, 'Fen');
  ok(w.rt.act(p, 'npc.topic', { targetId: w.giver.id }));
  ok(w.rt.act(p, 'quest.accept', { offerId: w.events(p, 'questOffer').at(-1).offerId }));
  const inst = p.rpg.quests.active[0];
  assert.equal(inst.places.home.interior, 'interior:house', 'house2 binds to a house, not the tavern');
  const mine = [...w.rt.entities.values()].filter((e) => e._quest?.owner === 1);
  assert.ok(mine.length >= 2);
  assert.ok(mine.every((e) => e.location === 'interior:house'), 'friend and rat wait inside the house');
  assert.match(w.events(p, 'questAccepted').at(-1).text, /waits in Gothway Garden/);
});

test('a private quest person shown before its building’s collision loaded is re-placed on clear floor', () => {
  const town = 'town:Daggerfall/Gothway Garden';
  const houses = [{ kind: 'building', from: town, to: 'interior:house', label: 'House', meta: { buildingType: 18 }, entrances: [{ inner: { x: 3, z: 4 } }] }];
  const portals = { at: (from) => houses.filter((h) => h.from === from), into: (to) => houses.find((h) => h.to === to) ?? null };
  const w = makeWorld({ catalog: fixtureCatalog(FIXTURE), portals });
  let loaded = false;
  w.rt.ctx.services.collision = { nearestClear: (loc, x, z) => (loaded ? { x: 3, z: 1 } : null) };
  const p = w.join(1, 'Fen');
  ok(w.rt.act(p, 'npc.topic', { targetId: w.giver.id }));
  ok(w.rt.act(p, 'quest.accept', { offerId: w.events(p, 'questOffer').at(-1).offerId }));
  const friend = () => [...w.rt.entities.values()].find((e) => e._quest?.person === 'friend');
  assert.notDeepEqual([friend().x, friend().z], [3, 1], 'raw door-relative spot while collision is missing');
  loaded = true;
  w.advance(5000);
  assert.deepEqual([friend().x, friend().z], [3, 1], 'moved onto clear floor once collision is there');
  assert.deepEqual(friend().visibleTo, [1]);
});

test('a work giver standing indoors binds local places in the town around them, never their own room', () => {
  const town = 'town:Daggerfall/Gothway Garden';
  const tavern = 'interior:Daggerfall/Gothway Garden/2,2/6';
  const houses = [
    { kind: 'building', from: town, to: tavern, label: 'Tavern', meta: { buildingType: 15 }, entrances: [{ inner: { x: 1, z: 2 } }] },
    { kind: 'building', from: town, to: 'interior:house', label: 'House', meta: { buildingType: 18 }, entrances: [{ inner: { x: 3, z: 4 } }] },
  ];
  const portals = { at: (from) => houses.filter((h) => h.from === from), into: (to) => houses.find((h) => h.to === to) ?? null };
  const w = makeWorld({ catalog: fixtureCatalog(FIXTURE), portals });
  Object.assign(w.giver, { location: tavern, x: 0, z: 0 });
  const p = w.join(1, 'Fen');
  p.rpg.location = tavern;
  ok(w.rt.act(p, 'npc.topic', { targetId: w.giver.id }));
  ok(w.rt.act(p, 'quest.accept', { offerId: w.events(p, 'questOffer').at(-1).offerId }));
  const inst = p.rpg.quests.active[0];
  assert.equal(inst.places.home.location, town);
  assert.equal(inst.places.home.interior, 'interior:house', 'house2 is a house in town, not the giver’s tavern');
  const mine = () => [...w.rt.entities.values()].filter((e) => e._quest?.owner === 1);
  assert.ok(mine().length >= 2 && mine().every((e) => e.location === 'interior:house'));

  // A save made before this fix bound the place (and what stood there) to the giver's room: it moves to the house.
  const legacy = { location: tavern, building: 'house2', scope: 'local' };
  inst.places.home = legacy;
  inst.people.friend.location = tavern;
  inst.foes.pest.location = tavern;
  w.advance(1000);
  assert.equal(legacy.interior, 'interior:house');
  assert.equal(inst.people.friend.location, town);
  assert.ok(mine().length >= 2 && mine().every((e) => e.location === 'interior:house'), 'moved out of the tavern');
});

test('when ... and not ... evaluates like Daggerfall Unity', () => {
  const text = `Quest: T0C00Y03
QRC:

QuestorOffer:  [1000]
TEST.

QBN:
Person _giver_ group Questor

	start task _a_

variable _a_
variable _b_

_c_ task:
	when _a_ and not _b_
	say 1000

_d_ task:
	when _b_ or _a_
	say 1000
`;
  const w = makeWorld({ catalog: fixtureCatalog(text) });
  const p = w.join(1, 'Gil');
  ok(w.rt.act(p, 'npc.topic', { targetId: w.giver.id }));
  ok(w.rt.act(p, 'quest.accept', { offerId: w.events(p, 'questOffer').at(-1).offerId }));
  const t = p.rpg.quests.active[0].tasks;
  assert.equal(t.c.t, true);
  assert.equal(t.d.t, true);
});

test('classic: an operator quest list restricts the offer pool', { skip: !ARENA2 && 'no ARENA2 in gamedata/' }, async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'qlist-'));
  const file = join(dir, 'QuestList.txt');
  writeFileSync(file, 'schema: *name,group,membership,minReq,flag\nA0C00Y14, Commoners, N, 0, 0\n-A0C00Y10, Commoners, N, 0, 0\n');
  const r = catalogReport(loadCatalog({ dataPath: ARENA2, questList: file }));
  assert.deepEqual(r.offerable.map((x) => x.name), ['A0C00Y14']);
});

test('operator temple quests use the explicit membership letter, including custom filenames', () => {
  const entries = parseQuestList('CUSTOM01, HolyOrder, J, 3, 0\n00B00Y00, HolyOrder, K, 1, 0\nCUSTOM02, HolyOrder, M, 0, 0');
  assert.equal(entries.get('CUSTOM01').deity, 27);
  assert.equal(entries.get('CUSTOM01').minReq, 3);
  assert.equal(entries.get('00B00Y00').deity, 35);
  assert.equal(entries.get('CUSTOM02').deity, undefined);
});

test('a temple job with a reputation threshold reads standing with its deity', () => {
  const catalog = fixtureCatalog(FIXTURE);
  const name = 'T0C00Y01';
  catalog.quests.get(name).meta = parseQuestList(name + ', HolyOrder, K, 10, 0').get(name);
  const w = makeWorld({ catalog });
  w.giver.questGroup = 'HolyOrder';
  w.rt.ctx.services.guilds = { hallOf: () => ({ group: 'temple', variant: 35, factionId: 36 }) };
  w.rt.ctx.services.guildRank = () => 0;
  const p = w.join(1, 'Verna');
  p.rpg.factions = { [w.giver.faction]: 100, 36: 100, 35: 9 };
  const request = { targetId: w.giver.id };
  assert.match(w.rt.act(p, 'quest.request', request).error, /no work/);
  p.rpg.factions[35] = 10;
  ok(w.rt.act(p, 'quest.request', request));
  assert.equal(w.events(p, 'questOffer').at(-1).title, 'Synthetic test errand');
});

test('classic: a questor sent home by opcode 0x51 is only met there, not by clicking the giver in town', { skip: !ARENA2 && 'no ARENA2 in gamedata/' }, () => {
  const cat = loadCatalog({ dataPath: ARENA2 });
  for (const n of ['A0C00Y20', 'A0C00Y22', 'A0C01Y01']) {
    assert.ok(cat.quests.get(n).def.tasks[0].actions.some((a) => a.name === 'placeNpc'), `${n} moves its questor`);
  }
  const only = { ...cat, quests: new Map([['A0C00Y20', cat.quests.get('A0C00Y20')]]) };
  const w = makeWorld({ catalog: only, dataPath: ARENA2 });
  const p = w.join(1, 'Hal');
  ok(w.rt.act(p, 'npc.topic', { targetId: w.giver.id }));
  const offer = w.events(p, 'questOffer').at(-1);
  assert.doesNotMatch(offer.text, /_qgiver/, 'dropped-underscore macro resolved');
  ok(w.rt.act(p, 'quest.accept', { offerId: offer.offerId }));
  ok(w.rt.act(p, 'npc.talk', { targetId: w.giver.id }));
  assert.equal(p.rpg.gold, 0, 'no reward for clicking the giver in town');
  assert.equal(p.rpg.quests.active.length, 1);
  const home = [...w.rt.entities.values()].find((e) => e._quest?.owner === 1 && e._quest.person === 'p.00');
  assert.ok(home, 'the questor waits at the remote house');
  assert.notEqual(home.location, p.rpg.location);
});
