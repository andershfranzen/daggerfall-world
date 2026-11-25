// Work package 3: tone of voice, Etiquette/Streetwise reactions, what a speaker knows, local news and rumours
// from the town's real buildings, and buildings learned on the player's own map through dialogue.
// Fixture data: a hand-made town with surveyed doors (as test/npc-directions.test.mjs); no game files needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as npcs from '../server/rpg/npcs.js';
import {
  PATIENCE, TONES, WEARY, cleanLearned, knows, learnPlace, localTale, react, reactionChance, socialGroup,
} from '../server/rpg/npcs/talk.js';
import { learnedNote, replyChoices } from '../client/gameplay/npcs/conversation.js';

const TOWN = 'town:Somewhere/Town';
const INN = 'interior:Somewhere/Town/0,0/1';
const SHOP = 'interior:Somewhere/Town/0,0/2';
const HALL = 'interior:Somewhere/Town/0,0/3';

const person = (id, name, title, location, at, more = {}) => ({
  id, kind: 'npc', role: more.role ?? 'resident', title, name, location, x: at[0], y: at[1] ?? 0, z: at[2], yaw: 0, anchor: 'base',
  sprite: { archive: 182, record: 1 }, faction: 0, reach: 6.4, sourced: true, ...more,
});
const ann = person('npc:i:inn:0', 'Ann Oakby', 'Innkeeper', INN, [4, 0, -6], { role: 'innkeeper', shop: 'inn' });
const bob = person('npc:i:inn:1', 'Bob Ashford', 'Resident', INN, [0, 3.3, -8]);
const walkers = Array.from({ length: 6 }, (_, i) => person(`npc:x:${i}`, `Walker ${i}`, 'Resident', TOWN, [i * 3, 0, 0], { mobile: true }));
const lord = person('npc:x:lord', 'Lord Edric Ashby', 'Lord', TOWN, [40, 0, 0], { mobile: true, _workGroup: 'Nobility' });

function fixture() {
  const residents = [
    { ...ann, interior: INN, buildingType: 15 },
    { ...bob, interior: INN, buildingType: 15 },
    { id: 'npc:i:shop:0', name: 'Ida Ashly', title: 'Lady', role: 'resident', interior: SHOP, x: 1, y: 0, z: -3, buildingType: 9, individual: 900 },
    { id: 'npc:i:hall:0', name: 'Sly Oakner', title: 'Thieves Guild', role: 'thieves', interior: HALL, x: 0, y: 0, z: -3, buildingType: 11, secret: true },
  ];
  const work = [{ id: 'npc:i:shop:w', name: 'Wes Larkby', interior: SHOP, people: 0, group: 'Merchants', buildingType: 9 }];
  const source = {
    tables: { factions: null, banks: null, flatsCfg: null },
    town: async (location) => ({ location, people: [...walkers, lord], nav: null, blocks: 1, climatePeople: 'breton', regionIndex: 17, work, residents, secretHalls: [HALL], buildings: [] }),
    interior: async (location) => ({ location, building: { buildingType: location === INN ? 15 : 9, key: 1 }, people: location === INN ? [ann, bob] : [], markers: { spawn: [], item: [] } }),
    dungeon: async () => { throw new Error('none'); },
    evict() {},
  };
  const door = (id, to, type, name, x, z) => ({
    id, from: TOWN, to, kind: 'building', label: name ?? 'House',
    entrances: [{ x, y: 0, z, enter: { x: 0, y: 0, z: -1, yaw: 0 }, inner: { x: 0, z: 0 }, exit: { x, y: 0, z: z + 1, yaw: 0 } }],
    exits: [{ x: 0, z: 0 }], meta: { buildingType: type, buildingName: name },
  });
  const specs = [
    door('b:0,0:1', INN, 15, 'The Silver Stag', 0, -50),
    door('b:0,0:2', SHOP, 9, 'Oakby General Goods', 300, 0),
    door('b:0,0:3', HALL, 11, 'The Hidden Hand', -20, 0),
  ];
  const players = new Map();
  const w = { day: 0, practised: [] };
  let clock = 0;
  const sent = [];
  const rt = createRpgRuntime({
    players,
    services: {
      portals: { at: (loc) => (loc === TOWN ? specs : []), into: (loc) => specs.find((sp) => sp.to === loc) ?? null },
      worldClock: () => ({ minutes: w.day * 1440 + 12 * 60 }),
      advanceSkill: (p, skill, n) => w.practised.push([p.id, skill, n]),
    },
    features: [{ name: 'npcs', install: (ctx) => npcs.install(ctx, { peopleSource: source, statePath: null }) }],
    save() {}, send: (p, m) => sent.push([p.id, m]), now: () => clock, log: { error: (...a) => console.error(...a), warn() {}, info() {} },
  });
  const tick = (ms = 100) => { clock += ms; rt.tick(ms / 1000, clock); };
  const events = (p, kind) => sent.filter(([id]) => id === p.id).flatMap(([, m]) => (m.type === 'gameEvent' ? [m.event] : [])).filter((e) => e.kind === kind);
  return Object.assign(w, { rt, players, sent, tick, events });
}

const sheet = (skill, personality = 50) => ({ skills: { Etiquette: skill, Streetwise: skill }, attributes: { Personality: personality } });
const join = (w, id = 1, character = sheet(100, 100)) => {
  const p = { id, name: `Hero${id}`, x: 0, z: 0, yaw: 0, moving: false, rpg: { location: TOWN, gold: 50, character } };
  w.players.set(id, p);
  w.rt.join(p);
  return p;
};
async function talkTo(w, p, e) {
  await w.rt.ctx.services.npcs.ready(TOWN);
  w.tick();
  p.x = e.x; p.z = e.z + 2;
  const r = w.rt.act(p, 'npc.talk', { targetId: e.id });
  assert.equal(r.ok, true, String(r.error ?? JSON.stringify(r)));
  return w.events(p, 'dialogue').at(-1);
}
const last = (w, p) => w.events(p, 'dialogue').at(-1);

test('social groups prefer different tones; Etiquette and Streetwise move the odds', () => {
  assert.equal(socialGroup(lord), 'nobility');
  assert.equal(socialGroup({ role: 'thieves' }), 'underworld');
  assert.equal(socialGroup(ann), 'merchants');
  assert.equal(socialGroup(walkers[0]), 'commoners');
  const novice = sheet(5), courtier = { skills: { Etiquette: 80, Streetwise: 5 }, attributes: { Personality: 50 } };
  assert.ok(reactionChance(novice, lord, 'polite') > reactionChance(novice, lord, 'blunt'), 'nobles take courtesy better');
  assert.ok(reactionChance(novice, { role: 'thieves' }, 'blunt') > reactionChance(novice, { role: 'thieves' }, 'polite'));
  assert.ok(reactionChance(courtier, lord, 'polite') > reactionChance(novice, lord, 'polite'), 'Etiquette helps a polite request');
  assert.equal(reactionChance(courtier, lord, 'blunt'), reactionChance({ ...courtier, skills: { Etiquette: 5, Streetwise: 5 } }, lord, 'blunt'), 'Etiquette does not help bluntness');
  assert.ok(reactionChance(novice, lord, 'polite', 'friendly') > reactionChance(novice, lord, 'polite', 'cold'));
  for (const t of TONES) for (const c of [sheet(0, 1), sheet(100, 100)]) {
    const v = reactionChance(c, lord, t);
    assert.ok(v >= 5 && v <= 95, `${t} ${v} clamped`);
  }
  // Same seed, same reaction; the rate tracks the chance.
  assert.deepEqual(react(novice, lord, 'blunt', 'neutral', 'x'), react(novice, lord, 'blunt', 'neutral', 'x'));
  const rate = (c, t) => Array.from({ length: 400 }, (_, i) => react(c, lord, t, 'neutral', `s${i}`).ok).filter(Boolean).length / 400;
  assert.ok(rate(courtier, 'polite') > 0.8 && rate(novice, 'blunt') < 0.3);
});

test('the view offers tones to source-backed speakers; npc.tone switches it without repeating the line', async () => {
  const w = fixture();
  const p = join(w);
  const v = await talkTo(w, p, walkers[0]);
  assert.equal(v.tone, 'normal');
  assert.deepEqual(v.tones.map((t) => t.id), ['polite', 'normal', 'blunt']);
  // Numbered replies are untouched by the tone group (package 1 numbering).
  assert.deepEqual(replyChoices(v).map((c) => c.key), replyChoices({ ...v, tones: undefined, tone: undefined }).map((c) => c.key));
  assert.equal(w.rt.act(p, 'npc.tone', { targetId: walkers[0].id, session: v.session, tone: 'polite' }).ok, true);
  const after = last(w, p);
  assert.equal(after.tone, 'polite');
  assert.equal(after.text, v.text, 'the speaker’s line is unchanged');
  assert.equal(w.rt.act(p, 'npc.tone', { targetId: walkers[0].id, session: v.session, tone: 'rude' }).ok, false);
  assert.equal(w.rt.act(p, 'npc.tone', { targetId: walkers[0].id, session: 'forged', tone: 'blunt' }).ok, false, 'needs the live session');
});

test('a blunt novice is turned away by a lord, then he stops answering; a polite courtier is answered and practises Etiquette', async () => {
  const w = fixture();
  const rude = join(w, 1, sheet(0, 1));
  const v = await talkTo(w, rude, lord);
  w.rt.act(rude, 'npc.tone', { targetId: lord.id, session: v.session, tone: 'blunt' });
  const replies = [];
  for (let i = 0; i < 8; i++) {
    assert.equal(w.rt.act(rude, 'npc.topic', { targetId: lord.id, session: v.session, topic: 'news' }).ok, true);
    replies.push(last(w, rude));
  }
  const refused = replies.filter((r) => r.ask !== true && !r.learned);
  assert.ok(refused.length >= PATIENCE, 'at 5 % he refuses at least three times in eight');
  assert.ok(replies.at(-1).text.endsWith(WEARY), 'then he answers no more questions');
  assert.equal(w.practised.filter(([id]) => id === rude.id).length, replies.length - refused.length, 'only answers practise Streetwise');

  const polite = join(w, 2, { skills: { Etiquette: 100, Streetwise: 0 }, attributes: { Personality: 100 } });
  const v2 = await talkTo(w, polite, lord);
  w.rt.act(polite, 'npc.tone', { targetId: lord.id, session: v2.session, tone: 'polite' });
  let answered = 0;
  for (let i = 0; i < 6; i++) {
    w.rt.act(polite, 'npc.topic', { targetId: lord.id, session: v2.session, topic: 'rumours' });
    if (!last(w, polite).text.includes(WEARY)) answered++;
  }
  assert.ok(answered >= 5);
  assert.ok(w.practised.some(([id, skill]) => id === polite.id && skill === 'Etiquette'));
  assert.ok(!w.practised.some(([id, skill]) => id === polite.id && skill === 'Streetwise'));
});

test('different speakers know different people; one who does not know says so and marks nothing', async () => {
  const w = fixture();
  const p = join(w);
  // Ida Ashly's shop is a 300 m walk: an ordinary shop, so only some locals know her.
  const subj = { id: 'p:npc:i:shop:0', kind: 'person', type: 9, person: { id: 'npc:i:shop:0' }, spec: { to: SHOP } };
  const verdicts = walkers.map((e) => knows(e, subj, { distance: 300 }));
  assert.ok(verdicts.includes(true) && verdicts.includes(false), `locals differ: ${verdicts}`);
  assert.equal(knows(walkers[0], { ...subj, kind: 'place', type: 15, id: 'b:b:0,0:1' }), true, 'everybody knows the tavern');
  assert.equal(knows(ann, { id: 'p:npc:i:inn:1', kind: 'person', type: 15, person: bob, spec: { to: INN } }, { homeInterior: INN }), true, 'housemates');

  const blank = walkers[verdicts.indexOf(false)], wise = walkers[verdicts.indexOf(true)];
  let v = await talkTo(w, p, blank);
  let answer;
  for (let i = 0; i < 3 && !answer; i++) { // a 95 % reaction: retry the rare refusal
    w.rt.act(p, 'npc.ask', { targetId: blank.id, session: v.session, subject: 'p:npc:i:shop:0' });
    if (/Ida Ashly/.test(last(w, p).text)) answer = last(w, p);
  }
  assert.match(answer.text, /couldn't tell you where Ida Ashly|Never heard of Ida Ashly|means nothing/);
  assert.equal(answer.learned, undefined);
  assert.equal(p.rpg.learnedPlaces?.[TOWN]?.length ?? 0, 0);

  v = await talkTo(w, p, wise);
  for (let i = 0; i < 3; i++) {
    w.rt.act(p, 'npc.ask', { targetId: wise.id, session: v.session, subject: 'p:npc:i:shop:0' });
    if (/keeps to/.test(last(w, p).text)) break;
  }
  assert.match(last(w, p).text, /Ida Ashly the lady keeps to Oakby General Goods\. Its door is \d+ m/);
  assert.deepEqual(last(w, p).learned, [{ id: 'b:0,0:2', name: 'Oakby General Goods' }]);
});

test('directions mark the building on that player’s own map only, once, and it survives a save and rejoin', async () => {
  const w = fixture();
  const p = join(w, 1), other = join(w, 2);
  const v = await talkTo(w, p, walkers[1]);
  for (let i = 0; i < 3 && !p.rpg.learnedPlaces?.[TOWN]?.length; i++) w.rt.act(p, 'npc.ask', { targetId: walkers[1].id, session: v.session, subject: 'b:b:0,0:1' });
  assert.deepEqual(p.rpg.learnedPlaces[TOWN], [{ id: 'b:0,0:1', name: 'The Silver Stag', type: 15, interior: INN, x: 0, z: -50 }]);
  const ev = w.events(p, 'map.learned');
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].places.map((x) => x.name), ['The Silver Stag']);
  assert.equal(w.events(other, 'map.learned').length, 0, 'no other player is told');
  assert.equal(other.rpg.learnedPlaces, undefined);
  w.rt.act(p, 'npc.ask', { targetId: walkers[1].id, session: v.session, subject: 'b:b:0,0:1' });
  assert.equal(w.events(p, 'map.learned').length, 1, 'already known: not announced again');
  assert.equal(p.rpg.learnedPlaces[TOWN].length, 1);
  // Save (JSON) and rejoin: the discovery is part of the character record.
  const saved = JSON.parse(JSON.stringify(p.rpg));
  w.rt.leave?.(p);
  const back = { id: 3, name: 'Hero1', x: 0, z: 0, yaw: 0, rpg: saved };
  w.players.set(3, back);
  w.rt.join(back);
  assert.deepEqual(back.rpg.learnedPlaces[TOWN].map((x) => x.name), ['The Silver Stag']);
  assert.equal(learnedNote(last(w, p).learned ?? [{ name: 'The Silver Stag' }]), 'Marked on your map: The Silver Stag.');
});

test('news and rumours name this town’s public buildings and people, never a secret hall or a private quest person', async () => {
  const w = fixture();
  const p = join(w);
  w.rt.ctx.services.npcs.setIndividualAway(900, p.id, true); // Ida is away on this player's quest
  const named = new Set();
  for (let day = 0; day < 30; day++) {
    w.day = day;
    for (const e of walkers.slice(0, 3)) {
      const v = await talkTo(w, p, e);
      for (const topic of ['news', 'rumours']) {
        w.rt.act(p, 'npc.topic', { targetId: e.id, session: v.session, topic });
        const r = last(w, p);
        assert.doesNotMatch(r.text, /Hidden Hand|Sly Oakner|Ida Ashly/, r.text);
        for (const n of ['The Silver Stag', 'Oakby General Goods', 'Ann Oakby', 'Bob Ashford', 'Wes Larkby']) if (r.text.includes(n)) named.add(n);
      }
    }
  }
  assert.ok(named.has('The Silver Stag') && named.has('Oakby General Goods'), [...named].join());
  assert.ok(p.rpg.learnedPlaces[TOWN].some((x) => x.name === 'The Silver Stag'), 'a tale marks its building');
  assert.ok(!p.rpg.learnedPlaces[TOWN].some((x) => x.name === 'The Hidden Hand'));
});

test('tales rotate by speaker and day and fall back to general lines; learned-place records are bounded', () => {
  const placeList = [{ label: 'The Silver Stag', type: 15, spec: { to: INN } }, { label: 'Oakby General Goods', type: 9, spec: { to: SHOP } }];
  const town = { places: placeList, people: [{ name: 'Bob Ashford', interior: INN }], work: [] };
  const texts = new Set(), general = [];
  for (let d = 0; d < 20; d++) for (const e of walkers) {
    const t = localTale('news', e, town, d);
    if (t) texts.add(t.text); else general.push(d);
  }
  assert.ok(texts.size >= 2 && general.length > 0, `${texts.size} tales, ${general.length} general`);
  assert.equal(localTale('news', walkers[0], { places: [], people: [], work: [] }, 1), null);
  const rpg = { learnedPlaces: { 'town:A/B': [{ id: 'x', name: 'X', x: 1, z: 2 }, { id: 'bad' }], junk: [1] } };
  cleanLearned(rpg);
  assert.deepEqual(Object.keys(rpg.learnedPlaces), ['town:A/B']);
  assert.equal(rpg.learnedPlaces['town:A/B'].length, 1);
  for (let i = 0; i < 300; i++) learnPlace(rpg, 'town:A/B', { id: `b${i}`, name: 'n', x: 0, z: 0 });
  assert.equal(rpg.learnedPlaces['town:A/B'].length, 200);
  assert.equal(learnPlace(rpg, 'town:A/B', { id: 'b299', name: 'n', x: 0, z: 0 }), null);
});

test('a speaker out of patience stays unwilling in a new conversation; a granted directions request is not rolled twice', async () => {
  const w = fixture();
  const rude = join(w, 1, sheet(0, 1));
  let v = await talkTo(w, rude, lord);
  w.rt.act(rude, 'npc.tone', { targetId: lord.id, session: v.session, tone: 'blunt' });
  for (let i = 0; i < 12 && !last(w, rude).text.includes(WEARY); i++) w.rt.act(rude, 'npc.topic', { targetId: lord.id, session: v.session, topic: 'news' });
  assert.ok(last(w, rude).text.includes(WEARY));
  w.rt.act(rude, 'npc.leave', {});
  v = await talkTo(w, rude, lord);
  w.rt.act(rude, 'npc.topic', { targetId: lord.id, session: v.session, topic: 'rumours' });
  assert.equal(last(w, rude).text, WEARY, 'talking again does not reset his patience');

  const polite = join(w, 2, { skills: { Etiquette: 100, Streetwise: 100 }, attributes: { Personality: 100 } });
  const v2 = await talkTo(w, polite, walkers[2]);
  for (let i = 0; i < 4 && last(w, polite).ask !== true; i++) w.rt.act(polite, 'npc.topic', { targetId: walkers[2].id, session: v2.session, topic: 'directions' });
  const before = w.practised.filter(([id]) => id === polite.id).length;
  w.rt.act(polite, 'npc.ask', { targetId: walkers[2].id, session: v2.session, subject: 'b:b:0,0:1' });
  assert.match(last(w, polite).text, /The Silver Stag is \d+ m/);
  assert.equal(w.practised.filter(([id]) => id === polite.id).length, before, 'no second roll, no second practice');
});
