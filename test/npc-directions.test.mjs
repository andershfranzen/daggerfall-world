// "Where is …?" directions to named people and buildings (server/rpg/npcs.js npc.ask, places.directoryAt,
// world.js residents/secretHalls) and the in-chat picker model (client/gameplay/npcs/conversation.js).
// Fixture data: a hand-made town with surveyed doors; no game files are needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as npcs from '../server/rpg/npcs.js';
import { acceptsSubjects, normaliseQuery, replyChoices, subjectsNote } from '../client/gameplay/npcs/conversation.js';

const TOWN = 'town:Somewhere/Town';
const INN = 'interior:Somewhere/Town/0,0/1';
const SHOP = 'interior:Somewhere/Town/0,0/2';
const HALL = 'interior:Somewhere/Town/0,0/3';
const HOUSE = 'interior:Somewhere/Town/0,0/4';

const person = (id, name, title, location, at, more = {}) => ({
  id, kind: 'npc', role: more.role ?? 'resident', title, name, location, x: at[0], y: at[1] ?? 0, z: at[2], yaw: 0, anchor: 'base',
  sprite: { archive: 182, record: 1 }, faction: 0, reach: 6.4, sourced: true, ...more,
});

// Inn: keeper Ann on the ground floor, Bob upstairs, Cal the barmaid near the door (speaker inside).
const ann = person('npc:i:inn:0', 'Ann Oakby', 'Innkeeper', INN, [4, 0, -6], { role: 'innkeeper' });
const bob = person('npc:i:inn:1', 'Bob Ashford', 'Resident', INN, [0, 3.3, -8]);
const cal = person('npc:i:inn:2', 'Cal Ashby', 'Resident', INN, [0, 0, -2]);
const crier = person('npc:x:0', 'Dora Oakford', 'Resident', TOWN, [0, 0, 0], { mobile: true }); // a street walker

function fixture({ extraResidents = 0, hallWork = 0 } = {}) {
  const residents = [
    { ...ann, interior: INN, buildingType: 15 },
    { ...bob, interior: INN, buildingType: 15 },
    { ...cal, interior: INN, buildingType: 15 },
    { id: 'npc:i:shop:0', name: 'Ida Ashly', title: 'Lady', role: 'resident', interior: SHOP, x: 1, y: 0, z: -3, buildingType: 9, individual: 900 },
    { id: 'npc:i:hall:0', name: 'Sly Oakner', title: 'Thieves Guild', role: 'thieves', interior: HALL, x: 0, y: 0, z: -3, buildingType: 11, secret: true },
  ];
  for (let i = 0; i < extraResidents; i++) residents.push({ id: `npc:i:shop:${i + 1}`, name: `Extra Person ${i}`, title: 'Resident', role: 'resident', interior: SHOP, x: 0, y: 0, z: -4, buildingType: 9 });
  // Commoners standing in the thieves' hall would be ordinary work candidates (TalkManager.GetBuildingList).
  const work = Array.from({ length: hallWork }, (_, i) => ({ id: `npc:i:hall:w${i}`, name: `Hall Worker ${i}`, interior: HALL, people: i, group: 'Commoners', buildingType: 11 }));
  const source = {
    tables: { factions: null, banks: null, flatsCfg: null },
    town: async (location) => ({ location, people: [crier], nav: null, blocks: 1, climatePeople: 'breton', regionIndex: 17, work, residents, secretHalls: [HALL], buildings: [] }),
    interior: async (location) => ({
      location, building: { buildingType: location === INN ? 15 : 9, key: 1 },
      people: location === INN ? [ann, bob, cal] : [], markers: { spawn: [], item: [] },
    }),
    dungeon: async () => { throw new Error('none'); },
    evict() {},
  };
  const door = (id, to, type, name, x, z, more = []) => ({
    id, from: TOWN, to, kind: 'building', label: name ?? 'House',
    entrances: [{ x, y: 0, z, enter: { x: 0, y: 0, z: -1, yaw: 0 }, inner: { x: 0, z: 0 }, exit: { x, y: 0, z: z + 1, yaw: 0 } }, ...more],
    exits: [{ x: 0, z: 0 }], meta: { buildingType: type, buildingName: name },
  });
  const specs = [
    door('b:0,0:1', INN, 15, 'The Silver Stag', 0, -50),
    // Two street doors: the nearer one (25, 10) lands at the back of the shop facing south.
    door('b:0,0:2', SHOP, 9, 'Oakby General Goods', 30, 0, [{ x: 25, y: 0, z: 10, enter: { x: 1, y: 0, z: -9, yaw: Math.PI }, inner: { x: 1, z: -10 }, exit: { x: 25, y: 0, z: 11, yaw: Math.PI } }]),
    door('b:0,0:3', HALL, 11, 'The Hidden Hand', -20, 0),
    door('b:0,0:4', HOUSE, 17, null, 0, 20),
  ];
  const players = new Map();
  const w = { day: 0 };
  let clock = 0;
  const rt = createRpgRuntime({
    players,
    services: { portals: { at: (loc) => (loc === TOWN ? specs : []) }, worldClock: () => ({ minutes: w.day * 1440 + 12 * 60 }) },
    features: [{ name: 'npcs', install: (ctx) => npcs.install(ctx, { peopleSource: source, statePath: null }) }],
    save() {}, send: (p, m) => sent.push([p.id, m]), now: () => clock, log: { error() {}, warn() {}, info() {} },
  });
  const sent = [];
  const tick = (ms = 100) => { clock += ms; rt.tick(ms / 1000, clock); };
  const events = (p, kind) => sent.filter(([id, m]) => id === p.id).flatMap(([, m]) => (m.type === 'gameEvent' ? [m.event] : [])).filter((e) => e.kind === kind);
  return Object.assign(w, { rt, players, sent, tick, events, setClock: (ms) => { clock = ms; } });
}

async function standBy(w, p, e, location) {
  p.rpg.location = location;
  await w.rt.ctx.services.npcs.ready(location);
  w.tick();
  p.x = e.x; p.z = e.z + 2; p.yaw = 0;
  const r = w.rt.act(p, 'npc.talk', { targetId: e.id });
  assert.equal(r.ok, true, r.error);
  return w.events(p, 'dialogue').at(-1);
}

const join = (w) => {
  const p = { id: 1, name: 'Hero', x: 0, z: 0, yaw: 0, moving: false, rpg: { location: TOWN, gold: 50 } };
  w.players.set(1, p);
  w.rt.join(p);
  return p;
};

test('an outdoor local lists public named buildings and people, never houses, underworld halls or their members', async () => {
  const w = fixture();
  const p = join(w);
  await w.rt.ctx.services.npcs.ready(TOWN);
  const v = await standBy(w, p, crier, TOWN);
  assert.equal(v.ask, true, 'the view says this speaker can name people and places');
  assert.equal(w.rt.act(p, 'npc.ask', { targetId: crier.id, session: v.session, query: '' }).ok, true);
  const list = w.events(p, 'dialogue.subjects').at(-1);
  assert.ok(acceptsSubjects(v, list));
  const labels = list.subjects.map((s) => s.label);
  assert.deepEqual(labels.slice(0, 2), ['Oakby General Goods', 'The Silver Stag'], 'places first, nearest door first');
  for (const n of ['Ann Oakby', 'Bob Ashford', 'Ida Ashly']) assert.ok(labels.includes(n), n);
  assert.ok(!labels.includes('The Hidden Hand') && !labels.includes('Sly Oakner'), 'thieves hall and member stay secret');
  assert.ok(!list.subjects.some((s) => /House/.test(s.hint)), 'no private houses');
  assert.ok(!w.rt.act(p, 'npc.ask', { targetId: crier.id, session: v.session, subject: 'p:npc:i:hall:0' }).ok, 'a forged secret id is refused');
  assert.ok(!w.rt.act(p, 'npc.ask', { targetId: crier.id, session: v.session, subject: 'b:b:0,0:3' }).ok);
  assert.ok(!w.rt.act(p, 'npc.ask', { targetId: crier.id, query: '' }).ok, 'needs the conversation session');
});

test('filtering is accent/case-free and the answer names the door, distance, bearing, floor', async () => {
  const w = fixture();
  const p = join(w);
  await w.rt.ctx.services.npcs.ready(TOWN);
  const v = await standBy(w, p, crier, TOWN);
  w.rt.act(p, 'npc.ask', { targetId: crier.id, session: v.session, query: 'SÍLVER  stag' });
  const list = w.events(p, 'dialogue.subjects').at(-1);
  assert.equal(list.query, 'silver stag');
  assert.equal(list.subjects[0].id, 'b:b:0,0:1', 'the named inn first, then the people in it');
  assert.deepEqual(list.subjects.slice(1).map((s) => s.label).sort(), ['Ann Oakby', 'Bob Ashford', 'Cal Ashby']);
  w.rt.act(p, 'npc.ask', { targetId: crier.id, session: v.session, query: 'oak' });
  assert.deepEqual(w.events(p, 'dialogue.subjects').at(-1).subjects.map((s) => s.label), ['Oakby General Goods', 'Ann Oakby', 'Ida Ashly'], 'name matches first, then people of the matching building; outdoor people are not listed');
  w.rt.act(p, 'npc.ask', { targetId: crier.id, session: v.session, subject: 'b:b:0,0:1' });
  assert.equal(w.events(p, 'dialogue').at(-1).text, 'The Silver Stag is 50 m north.');
  w.rt.act(p, 'npc.ask', { targetId: crier.id, session: v.session, subject: `p:${ann.id}` });
  const annText = w.events(p, 'dialogue').at(-1).text;
  assert.match(annText, /^Ann Oakby the innkeeper keeps to The Silver Stag\. Its door is 50 m north; inside, look about \d+ m ahead and to the right as you come in\.$/);
  w.rt.act(p, 'npc.ask', { targetId: crier.id, session: v.session, subject: `p:${bob.id}` });
  assert.match(w.events(p, 'dialogue').at(-1).text, /Bob Ashford .* upstairs\.$/);
});

test('an individual away on this player’s quest is not listed for that player', async () => {
  const w = fixture();
  const p = join(w);
  await w.rt.ctx.services.npcs.ready(TOWN);
  w.rt.ctx.services.npcs.setIndividualAway(900, p.id, true);
  const v = await standBy(w, p, crier, TOWN);
  w.rt.act(p, 'npc.ask', { targetId: crier.id, session: v.session, query: 'ida' });
  assert.equal(w.events(p, 'dialogue.subjects').at(-1).total, 0);
  assert.match(w.rt.act(p, 'npc.ask', { targetId: crier.id, session: v.session, subject: 'p:npc:i:shop:0' }).error, /never heard/);
});

test('inside the right building the reply is relative to the player; elsewhere it leaves by the street door', async () => {
  const w = fixture();
  const p = join(w);
  await w.rt.ctx.services.npcs.ready(TOWN);
  const v = await standBy(w, p, cal, INN);
  // Player stands 2 m south of Cal facing north (yaw 0). Ann is at (4, -6): ahead and to the right.
  w.rt.act(p, 'npc.ask', { targetId: cal.id, session: v.session, subject: `p:${ann.id}` });
  assert.match(w.events(p, 'dialogue').at(-1).text, /^Ann Oakby is here, about \d+ m ahead and to the right\.$/);
  p.yaw = Math.PI; // turned around
  w.rt.act(p, 'npc.ask', { targetId: cal.id, session: v.session, subject: `p:${ann.id}` });
  assert.match(w.events(p, 'dialogue').at(-1).text, /behind and to the left\.$/);
  w.rt.act(p, 'npc.ask', { targetId: cal.id, session: v.session, subject: `p:${bob.id}` });
  assert.match(w.events(p, 'dialogue').at(-1).text, /Bob Ashford is here, .*upstairs\.$/);
  w.rt.act(p, 'npc.ask', { targetId: cal.id, session: v.session, subject: 'b:b:0,0:1' });
  assert.equal(w.events(p, 'dialogue').at(-1).text, 'You\'re in The Silver Stag now.');
  w.rt.act(p, 'npc.ask', { targetId: cal.id, session: v.session, subject: 'b:b:0,0:2' });
  assert.match(w.events(p, 'dialogue').at(-1).text, /^Oakby General Goods is \d+ m south-east from our street door\.$/);
});

test('large towns: at most eight results with a count of the rest', async () => {
  const w = fixture({ extraResidents: 30 });
  const p = join(w);
  await w.rt.ctx.services.npcs.ready(TOWN);
  const v = await standBy(w, p, crier, TOWN);
  w.rt.act(p, 'npc.ask', { targetId: crier.id, session: v.session, query: '' });
  const list = w.events(p, 'dialogue.subjects').at(-1);
  assert.equal(list.subjects.length, 8);
  assert.equal(list.total, 2 + 3 + 1 + 30);
  assert.match(subjectsNote(list), /^28 more — type part of a name/);
  w.rt.act(p, 'npc.ask', { targetId: crier.id, session: v.session, query: 'person 2' });
  assert.deepEqual(w.events(p, 'dialogue.subjects').at(-1).subjects.map((s) => s.label), ['Extra Person 2', 'Extra Person 20', 'Extra Person 21', 'Extra Person 22', 'Extra Person 23', 'Extra Person 24', 'Extra Person 25', 'Extra Person 26']);
});

test('picker model: numbered replies are unchanged by `ask`, stale lists are refused', () => {
  const view = { npc: { id: 'n1' }, session: 's1', topics: [{ id: 'news', label: 'What news?' }, { id: 'directions', label: 'Where can I find…' }, { id: 'inn', label: 'Where is the nearest inn?' }], services: [] };
  assert.deepEqual(replyChoices({ ...view, ask: true }), replyChoices(view));
  assert.deepEqual(replyChoices(view).map((c) => c.key), [1, 2, 3, 4]);
  const ev = { kind: 'dialogue.subjects', npcId: 'n1', session: 's1', subjects: [] };
  assert.ok(acceptsSubjects(view, ev));
  assert.ok(!acceptsSubjects(view, { ...ev, session: 'old' }));
  assert.ok(!acceptsSubjects(view, { ...ev, npcId: 'n2' }));
  assert.equal(normaliseQuery('  Mórgana\'s   INN!'), 'morgana\'s inn');
  assert.equal(subjectsNote({ query: 'zz', subjects: [], total: 0 }), 'Nobody here knows of “zz”.');
});

test('legacy roster towns (no source data) do not offer the picker', () => {
  const players = new Map();
  const sent = [];
  const rt = createRpgRuntime({ players, features: [{ name: 'npcs', install: (ctx) => npcs.install(ctx, { peopleSource: null, statePath: null }) }], save() {}, send: (q, m) => sent.push(m), now: () => 0, log: { error() {}, warn() {}, info() {} } });
  const p = { id: 1, name: 'Hero', x: 0, z: 0, yaw: 0, moving: false, rpg: { location: 'town:Daggerfall/Gothway Garden', gold: 50 } };
  players.set(1, p);
  rt.join(p);
  rt.tick(0.1, 100);
  const e = [...rt.entities.values()].find((x) => x.kind === 'npc');
  p.x = e.x; p.z = e.z + 1;
  assert.equal(rt.act(p, 'npc.talk', { targetId: e.id }).ok, true);
  const v = sent.flatMap((m) => (m.type === 'gameEvent' ? [m.event] : [])).filter((m) => m.kind === 'dialogue').at(-1);
  assert.equal(v.ask, undefined);
  assert.ok(!rt.act(p, 'npc.ask', { targetId: e.id, session: v.session, query: '' }).ok);
});

test('secret halls stay out of every public direction: the type list, the inn reply, work leads and npc.ask', async () => {
  const w = fixture({ hallWork: 8 });
  const p = join(w);
  await w.rt.ctx.services.npcs.ready(TOWN);
  let v = await standBy(w, p, crier, TOWN);
  assert.equal(w.rt.act(p, 'npc.topic', { targetId: crier.id, session: v.session, topic: 'inn' }).ok, true);
  assert.equal(w.events(p, 'dialogue').at(-1).text, 'The Silver Stag is 50 m north.');
  w.rt.act(p, 'npc.topic', { targetId: crier.id, session: v.session, topic: 'directions' });
  const typeList = w.events(p, 'dialogue').at(-1).text;
  assert.match(typeList, /The Silver Stag is 50 m north/);
  assert.doesNotMatch(typeList, /Hidden Hand|guild hall/i);
  // Work: every candidate stands in the hall, so whichever day it is the local names nobody there.
  let offered = 0;
  for (let day = 0; day < 6; day++) {
    w.day = day;
    offered += (await w.rt.ctx.services.npcs.workAt(TOWN, p.id)).length;
    v = await standBy(w, p, crier, TOWN);
    assert.equal(w.rt.act(p, 'npc.topic', { targetId: crier.id, session: v.session, topic: 'work' }).ok, true);
    const lead = w.events(p, 'dialogue').at(-1).text;
    assert.doesNotMatch(lead, /Hidden Hand|Hall Worker/);
    assert.match(lead, /Nobody I know|could not tell you/);
  }
  assert.ok(offered > 0, 'the hall people really were offering work on some day');
  w.rt.act(p, 'npc.ask', { targetId: crier.id, session: v.session, query: 'hidden' });
  assert.equal(w.events(p, 'dialogue.subjects').at(-1).total, 0);
});

test('with several doors the inside guidance starts from the door the bearing points at', async () => {
  const w = fixture();
  const p = join(w);
  await w.rt.ctx.services.npcs.ready(TOWN);
  const v = await standBy(w, p, crier, TOWN);
  w.rt.act(p, 'npc.ask', { targetId: crier.id, session: v.session, subject: 'p:npc:i:shop:0' });
  // Nearest door (25, 10) is 27 m east-south-east -> "east"; its landing faces south with Ida 6 m ahead.
  assert.equal(w.events(p, 'dialogue').at(-1).text, 'Ida Ashly the lady keeps to Oakby General Goods. Its door is 27 m east; inside, look about 6 m straight ahead as you come in.');
});

test('people indoors can still be asked after the street has been evicted', async () => {
  const w = fixture();
  const p = join(w);
  await w.rt.ctx.services.npcs.ready(TOWN);
  p.rpg.location = INN;
  await w.rt.ctx.services.npcs.ready(INN);
  w.tick();
  w.setClock(10 * 60_000); // long past the idle grace: the town entry is gone
  w.tick();
  assert.equal(w.rt.ctx.services.npcs.status(TOWN).status, 'none');
  const v = await standBy(w, p, cal, INN);
  assert.equal(w.rt.act(p, 'npc.ask', { targetId: cal.id, session: v.session, query: 'stag' }).ok, true);
  assert.equal(w.events(p, 'dialogue.subjects').at(-1).subjects[0].label, 'The Silver Stag');
  w.rt.act(p, 'npc.topic', { targetId: cal.id, session: v.session, topic: 'directions' });
  assert.doesNotMatch(w.events(p, 'dialogue').at(-1).text, /Hidden Hand/);
});
