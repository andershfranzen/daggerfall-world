// Quest runtime hooks: timed quest sounds (classic 0x54 play sound), conversation hooks (add dialog, dialog link,
// rumor mill, mute npc, add/drop as questor). The fixtures below are SYNTHETIC test quests (not Daggerfall
// content); they only exercise the script syntax on the shared runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installQuests } from '../server/rpg/quests.js';
import { parseQuest } from '../server/rpg/quests/script.js';
import { analyseQuest, createInstance, updateQuest } from '../server/rpg/quests/engine.js';
import { compileAction } from '../server/rpg/quests/actions.js';
import { metaFromName } from '../server/rpg/quests/catalog.js';
import { clipsForEvent } from '../client/gameplay/atmosphere/playlists.js';
import { install as installNpcs } from '../server/rpg/npcs.js';

/** SYNTHETIC: a sound every 10 minutes 5 times, conversation hooks, and a 25-minute clock that ends the quest. */
const HOOKS = `
Quest: T0C00Y09
DisplayName: Synthetic hooks errand

QRC:

QuestorOffer:  [1000]
TEST OFFER.

RefuseQuest:  [1001]
TEST REFUSED.

AcceptQuest:  [1002]
TEST ACCEPTED.

Message:  1030
TEST RUMOUR about _friend_.

QBN:
Item _parcel_ letter

Person _giver_ group Questor
Person _friend_ group Resident1
Person _stranger_ group Resident2

Place _home_ local house2

Clock _late_ 00:25

	play sound 72 every 10 minutes 5 times
	rumor mill 1030
	add dialog for location _home_ person _friend_ item _parcel_
	dialog link for location _home_ person _friend_
	mute npc _stranger_
	add _friend_ as questor
	add _stranger_ as questor
	drop _stranger_ as questor
	start timer _late_

_late_ task:
	end quest
`;

const catalogOf = (text) => {
  const def = parseQuest(text);
  const entry = { name: def.name, source: 'script', def, meta: { ...metaFromName(def.name), group: 'Commoners', membership: 'N', minReq: 0 }, analysis: analyseQuest(def) };
  return { quests: new Map([[def.name, entry]]), failures: [], listSource: 'test' };
};

function makeWorld(catalog) {
  let clock = 0;
  const players = new Map();
  const sent = new Map();
  const rt = createRpgRuntime({
    players,
    features: [
      (ctx) => ctx.onAction('npc.topic', (p, { targetId }) => ctx.emit('npcWork', { player: p, entity: ctx.entities.get(targetId) })),
      (ctx) => installQuests(ctx, { catalog }),
    ],
    save() {},
    send: (p, msg) => { if (!sent.has(p.id)) sent.set(p.id, []); sent.get(p.id).push(msg); },
    now: () => clock,
    log: { error() {}, warn() {}, info() {} },
  });
  const giver = { id: 'npc:test:0', kind: 'npc', role: 'crier', title: 'Town Crier', name: 'Anna Giver', location: 'town:Daggerfall/Gothway Garden', x: 0, z: -3, yaw: 0, questGiver: true, faction: 201 };
  rt.entities.set(giver.id, giver);
  const join = (id, name, rpg = { gold: 0, character: { name, level: 1, gender: 'Male' } }) => {
    const p = { id, name, x: 0, z: -2, yaw: 0, rpg };
    players.set(id, p);
    rt.join(p);
    return p;
  };
  const events = (p, kind) => (sent.get(p.id) || []).filter((m) => m.type === 'gameEvent' && m.event.kind === kind).map((m) => m.event);
  // The quest feature's fallback world clock runs one minute per 5 s of server time.
  const minutes = (n) => { for (let i = 0; i < n; i++) { clock += 5000; rt.tick(1); } };
  return { rt, players, giver, join, events, minutes };
}

const ok = (r) => assert.equal(r.ok, true, r.error);

test('quest sound and conversation lines compile to runtime actions', () => {
  const cases = {
    'play sound 11146 every 1 minutes 1 times': ['playSound', 'approx', { sound: 11146, minutes: 1, times: 1 }],
    'play sound 72': ['playSound', 'approx', { sound: 72, minutes: 0, times: 1 }],
    'play song Tavern': ['playSong', 'approx', { song: 'Tavern' }],
    'rumor mill 1030': ['rumorMill', 'approx', { id: '1030' }],
    'mute npc _x_': ['muteNpc', 'approx', { person: '_x_' }],
    'add _P.01_ as questor': ['addQuestor', 'approx', { person: '_P.01_', add: true }],
    'drop _P.01_ as questor': ['dropQuestor', 'approx', { person: '_P.01_', add: false }],
    'add dialog for location _L.00_ person _missing-1_': ['addDialog', 'approx', { refs: [{ kind: 'place', symbol: '_L.00_' }] }],
    'dialog link for location _a_ person _b_': ['dialogLink', 'approx', { refs: [{ kind: 'place', symbol: '_a_' }, { kind: 'person', symbol: '_b_' }] }],
    // Other spellings stay harmless no-ops, never blockers.
    'play sound SlamDoor every 2 minutes 3 times': ['hookOther', 'ignored', {}],
  };
  for (const [line, [name, status, args]] of Object.entries(cases)) {
    const a = compileAction(line);
    assert.equal(a.name, name, line);
    assert.equal(a.status, status, line);
    assert.deepEqual(a.args, args, line);
  }
  assert.equal(analyseQuest(parseQuest(HOOKS)).offerable, true);
});

test('a timed quest sound repeats on its cadence, survives a restart and stops after its count', () => {
  const def = parseQuest(HOOKS.replace('\tstart timer _late_\n', ''));
  const sounds = [];
  const host = {
    location: () => 'town:Daggerfall/Gothway Garden',
    remoteTown: () => 'town:Daggerfall/Gothway Garden',
    makeName: (_, g) => `Test ${g}`,
    itemName: () => 'letter',
    text: (_, id) => `text ${id}`,
    message() {},
    placed() {},
    sound: (_, what) => sounds.push({ at: now, ...what }),
  };
  let now = 100;
  let inst = createInstance(def, { uid: 'sound-test', seed: 1, giver: { id: 'g', name: 'Giver', location: 'town:Daggerfall/Gothway Garden' }, host, now });
  const step = (n) => { for (let i = 0; i < n; i++) updateQuest(def, inst, host, ++now); };
  updateQuest(def, inst, host, now);
  assert.deepEqual(sounds, [{ at: 100, sound: 72 }], 'plays as soon as the task runs');
  step(9);
  assert.equal(sounds.length, 1, 'nothing before the interval');
  step(1);
  assert.deepEqual(sounds.map((s) => s.at), [100, 110]);
  // Restart: the instance is plain JSON in the character save.
  inst = JSON.parse(JSON.stringify(inst));
  step(10);
  assert.deepEqual(sounds.map((s) => s.at), [100, 110, 120], 'the schedule continues from the save');
  step(100);
  assert.deepEqual(sounds.map((s) => s.at), [100, 110, 120, 130, 140], 'five plays in all');
});

test('quest sounds reach only the owner and end with the quest; conversation hooks are readable by the NPC owner', () => {
  const w = makeWorld(catalogOf(HOOKS));
  const p = w.join(1, 'Rhea');
  const other = w.join(2, 'Bo');
  ok(w.rt.act(p, 'npc.topic', { targetId: w.giver.id }));
  ok(w.rt.act(p, 'quest.accept', { offerId: w.events(p, 'questOffer').at(-1).offerId }));
  const inst = p.rpg.quests.active[0];
  assert.equal(w.events(p, 'questSound').length, 1);
  assert.deepEqual(w.events(p, 'questSound')[0], { kind: 'questSound', uid: inst.uid, title: 'Synthetic hooks errand', sound: 72 });

  const talk = w.rt.ctx.services.quests.talk(p);
  assert.deepEqual(talk.rumours, [{ uid: inst.uid, id: 1030, text: `TEST RUMOUR about ${inst.people.friend.name}.` }]);
  assert.deepEqual(talk.topics.map((t) => [t.kind, t.key]), [['place', 'home'], ['person', 'friend'], ['item', 'parcel']]);
  assert.equal(talk.topics.find((t) => t.kind === 'person').name, inst.people.friend.name);
  assert.deepEqual(talk.links.map((l) => l.map((r) => r.key)), [['home', 'friend']]);
  assert.deepEqual(talk.muted.map((m) => m.key), ['stranger']);
  assert.deepEqual(talk.questors.map((m) => m.key), ['friend'], 'the dropped questor no longer speaks for the quest');
  const empty = w.rt.ctx.services.quests.talk(other);
  assert.deepEqual(empty, { rumours: [], topics: [], links: [], muted: [], questors: [] }, 'hooks are private to the owner');
  const rng = inst.rng;
  w.rt.ctx.services.quests.talk(p);
  assert.equal(inst.rng, rng, 'reading hooks does not disturb the quest PRNG');

  w.minutes(40);
  assert.equal(p.rpg.quests.active.length, 0, 'the 25-minute clock ended the quest');
  const plays = w.events(p, 'questSound').length;
  assert.ok(plays >= 3 && plays <= 4, `played on its 10-minute cadence while running (${plays})`);
  w.minutes(60);
  assert.equal(w.events(p, 'questSound').length, plays, 'no sound after the quest ended');
  assert.equal(w.events(other, 'questSound').length, 0, 'other players never hear it');
  assert.deepEqual(w.rt.ctx.services.quests.talk(p).rumours, [], 'rumours leave with the quest');
});

test('atmosphere maps questSound events to self clips and NPCs consume quest rumours and mute flags', () => {
  assert.deepEqual(clipsForEvent({ kind: 'questSound', sound: 72 }), [{ clip: 72, self: true }]);
  assert.deepEqual(clipsForEvent({ kind: 'questSound', song: 'Tavern' }), []);

  const players = new Map();
  const sent = new Map();
  let talkHook = { rumours: [{ uid: 'q1', id: 1030, text: 'A rare quest rumour circulates.' }], topics: [], links: [], muted: [], questors: [] };
  const rt = createRpgRuntime({
    players,
    features: [
      (ctx) => { ctx.services.quests = { talk: (p) => (p.id === 1 ? talkHook : { rumours: [], topics: [], links: [], muted: [], questors: [] }) }; },
      (ctx) => installNpcs(ctx, {}),
    ],
    save() {},
    send: (p, msg) => { if (!sent.has(p.id)) sent.set(p.id, []); sent.get(p.id).push(msg); },
    now: () => 1000,
    log: { error() {}, warn() {}, info() {} },
  });
  const p = { id: 1, name: 'Rhea', x: 0, z: 0, yaw: 0, rpg: { gold: 0, location: 'town:Daggerfall/Gothway Garden', character: { name: 'Rhea', level: 1, gender: 'Female' } } };
  players.set(1, p);
  rt.join(p);
  const npc = [...rt.entities.values()].find((e) => e.kind === 'npc');
  assert.ok(npc, 'starter town has an NPC');
  npc.sourced = true;
  p.x = npc.x;
  p.z = npc.z;
  ok(rt.act(p, 'npc.talk', { targetId: npc.id }));
  const dlg = (sent.get(1) || []).filter((m) => m.type === 'gameEvent' && m.event.kind === 'dialogue').at(-1)?.event;
  assert.ok(dlg?.session, 'dialogue session opened');
  ok(rt.act(p, 'npc.topic', { targetId: npc.id, session: dlg.session, topic: 'rumours' }));
  const rum = (sent.get(1) || []).filter((m) => m.type === 'gameEvent' && m.event.kind === 'dialogue').at(-1)?.event;
  assert.equal(rum.text, 'A rare quest rumour circulates.');

  talkHook = { ...talkHook, muted: [{ uid: 'q1', key: 'x', name: npc.name, entityId: npc.id, individual: null }] };
  const muted = rt.act(p, 'npc.talk', { targetId: npc.id });
  assert.equal(muted.ok, false);
});
