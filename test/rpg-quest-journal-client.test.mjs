// Browser journal (client/gameplay/quests.js) and the shell's fallback journal, rendered into a
// minimal DOM stand-in. Synthetic quest records only; no game text.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------- minimal DOM
class Node0 {
  constructor() { this.childNodes = []; this.parentNode = null; }
  append(...kids) { for (const k of kids) { const n = typeof k === 'string' ? new Text0(k) : k; n.parentNode = this; this.childNodes.push(n); } }
  replaceChildren(...kids) { this.childNodes = []; this.append(...kids); }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes = [new Text0(String(v))]; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === globalThis.document?.body; }
}
class Text0 extends Node0 { constructor(t) { super(); this.t = t; } get textContent() { return this.t; } }
class El0 extends Node0 {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.attrs = {}; this.dataset = {}; this.listeners = {}; this.className = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  toggleAttribute() {}
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); }
  click() { for (const f of this.listeners.click ?? []) f({ target: this }); }
  get disabled() { return 'disabled' in this.attrs; }
  all(pred, out = []) { for (const c of this.childNodes) if (c instanceof El0) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  byClass(cls) { return this.all((e) => e.className.split(/\s+/).includes(cls)); }
  buttons(text) { return this.all((e) => e.tagName === 'BUTTON' && (!text || e.textContent.includes(text))); }
}
globalThis.Node = Node0;
globalThis.document = { createElement: (t) => new El0(t), createTextNode: (t) => new Text0(t), body: new El0('body') };
document.body.dataset = {};

const { install, journalState, questDeadline, questGiversHere } = await import('../client/gameplay/quests.js');
const { createGameplayApi } = await import('../client/gameplay/api.js');

function harness() {
  const sent = [];
  const notes = [];
  const api = createGameplayApi({
    send: (verb, args) => { sent.push({ verb, args }); return Promise.resolve({ ok: true, verb }); },
    notify: (text) => notes.push(text),
  });
  let openId = null;
  const root = new El0('div');
  document.body.replaceChildren(root);
  api._attachShell({
    open: (id) => { openId = id; api._setModal(true, id); api.getPanel(id).render(root, api); },
    close: () => { openId = null; api._setModal(false); },
    refresh: () => { if (openId) api.getPanel(openId).render(root, api); },
    panelsChanged() {},
  });
  install(api);
  api.screen = 'game';
  return { api, root, sent, notes, open: () => api.openPanel('journal'), text: () => root.textContent };
}

const inst = (over = {}) => ({
  uid: 'Q1-1-a', name: 'Q1', title: 'Work for Test Giver', status: 'active', success: false,
  giver: { id: 'npc:t:0', name: 'Test Giver', location: 'town:Daggerfall/Gothway Garden' },
  log: [{ step: 0, text: 'I agreed to find a lost ring.' }], items: {}, clocks: { 's.1': { total: 2880, endAt: 6190765, running: true, done: false } },
  acceptedAt: 6187885, prompt: null, notes: [], report: { source: 'classic', approximations: [] }, ...over,
});
const rpg = (quests, extra = {}) => ({ type: 'rpg', selfId: 7, character: { location: 'town:Daggerfall/Gothway Garden', quests }, entities: [], peers: [], ...extra });

test('journalState never reports “no quests” for a journal that has not arrived', () => {
  assert.equal(journalState(null, { screen: 'landing', connection: 'idle' }).kind, 'offline');
  assert.equal(journalState(null, { screen: 'game', connection: 'online' }).kind, 'loading');
  assert.equal(journalState(null, { screen: 'game', connection: 'lost' }).kind, 'offline');
  assert.equal(journalState({ character: { location: 'x' } }).kind, 'unavailable');
  assert.equal(journalState({ character: { quests: [] } }).kind, 'unavailable', 'old/unknown shape is not shown as empty');
  const ready = journalState({ character: { quests: { v: 1, active: [], done: [] } } }, { connection: 'lost' });
  assert.equal(ready.kind, 'ready');
  assert.equal(ready.stale, true);
  assert.equal(questDeadline(inst()), 6190765);
  assert.equal(questDeadline(inst({ clocks: { a: { running: false, endAt: 5 } } })), null);
});

test('loading, unavailable and empty journals each say so; the empty one names nearby quest givers', () => {
  const h = harness();
  h.open();
  assert.equal(h.root.dataset.journal, 'loading');
  assert.match(h.text(), /Loading your journal/);
  assert.doesNotMatch(h.text(), /no current work/i);

  h.api._receiveRpg({ type: 'rpg', selfId: 7, character: { location: 'town:Daggerfall/Gothway Garden' }, entities: [], peers: [] });
  assert.equal(h.root.dataset.journal, 'unavailable');
  assert.match(h.text(), /not running the quest service/);

  h.api._receiveRpg(rpg({ v: 1, active: [], done: [], offer: null }, {
    entities: [
      { id: 'npc:t:0', kind: 'npc', name: 'Test Crier', role: 'crier', questGiver: true, x: 3, z: 4 },
      { id: 'npc:t:1', kind: 'npc', name: 'Plain Merchant', role: 'merchant', x: 1, z: 1 },
    ],
  }));
  assert.equal(h.root.dataset.journal, 'ready');
  assert.match(h.text(), /You have no current work/);
  assert.match(h.text(), /Test Crier · Town Crier/);
  assert.doesNotMatch(h.text(), /Plain Merchant/, 'only quest givers are suggested');

  h.api._receiveRpg(rpg({ v: 1, active: [], done: [], offer: null }, { entities: [], character: { location: 'wilderness:109,158', quests: { v: 1, active: [], done: [] } } }));
  assert.match(h.text(), /No one in the wilderness offers work/);
});

test('offer → accept → active entry with giver, place, deadline and log; done history; actions send intents', async () => {
  const h = harness();
  h.api._receiveRpg(rpg({ v: 1, active: [], done: [], offer: { id: 'Q1-1-a', name: 'Q1', title: 'Work for Test Giver', text: 'Find my ring.', giver: { id: 'npc:t:0', name: 'Test Giver' } } }));
  h.api._emitEvent?.({ kind: 'questOffer' });
  h.open();
  assert.match(h.text(), /Test Giver offers work/);
  h.root.buttons('Accept')[0].click();
  assert.deepEqual(h.sent.at(-1), { verb: 'quest.accept', args: { offerId: 'Q1-1-a' } });
  await new Promise((r) => setTimeout(r, 0));

  h.api._receiveRpg(rpg({ v: 1, active: [inst()], done: [{ uid: 'Q0-1-z', name: 'Q0', title: 'Earlier work', result: 'success', endedAt: 6100000, giver: 'Old Giver', log: ['I was paid.'] }], offer: null }));
  const t = h.text();
  assert.match(t, /Current work \(1\)/);
  assert.match(t, /From Test Giver, Gothway Garden/);
  assert.match(t, /\(Script: Q1\)/);
  assert.match(t, /Due by /);
  assert.match(t, /I agreed to find a lost ring\./);
  assert.match(t, /Finished \(1\)/);
  assert.match(t, /Earlier work.*Completed/);
  assert.match(t, /From Old Giver · Completed /);
  assert.match(t, /I was paid\./);
});

test('the journal shows the saved building and town, including when the player is elsewhere', () => {
  const h = harness();
  const giver = { id: 'npc:t:1', name: 'Peryrick Kinghart', location: 'interior:Daggerfall/Gothway Garden/2,1/15', buildingName: 'The Superior General Store' };
  h.api._receiveRpg(rpg({ v: 1, active: [inst({ giver })], done: [] }));
  h.open();
  assert.match(h.text(), /From Peryrick Kinghart, The Superior General Store, Gothway Garden/);
  const { buildingName, ...legacyGiver } = giver;
  h.api._receiveRpg(rpg({ v: 1, active: [inst({ giver: legacyGiver })], done: [] }));
  assert.match(h.text(), /From Peryrick Kinghart, Building, Gothway Garden/);
  const portGiver = { ...giver, location: 'interior:Daggerfall/Copperfield Manor/0,0/2', buildingName: 'The Silver Bird', townName: 'Port of Daggerfall' };
  h.api._receiveRpg(rpg({ v: 1, active: [inst({ giver: portGiver })], done: [] }));
  assert.match(h.text(), /The Silver Bird, Port of Daggerfall/);
});

test('disconnected: last known journal stays visible, read-only, and is labelled', () => {
  const h = harness();
  h.api._receiveRpg(rpg({ v: 1, active: [inst({ items: { 'i.1': { name: 'Letter', held: true, usedMessage: 1 } } })], done: [], offer: null }));
  h.open();
  h.api.connection = 'lost';
  h.api.emit('connection', 'lost');
  assert.match(h.text(), /Disconnected — this is your journal as last received/);
  assert.match(h.text(), /Work for Test Giver/);
  assert.ok(h.root.buttons('Read Letter')[0].disabled, 'quest actions are disabled while offline');
});

test('a held quest object can be returned at its assigned building', () => {
  const h = harness();
  const house = 'interior:Daggerfall/Gothway Garden/0,0/1';
  const quest = inst({
    places: { mansion: { location: 'town:Daggerfall/Gothway Garden', interior: house } },
    items: { decanter: { name: 'wine decanter', held: true, dropPlaces: ['mansion'] } },
  });
  const state = rpg({ v: 1, active: [quest], done: [] });
  h.api._receiveRpg(state);
  h.open();
  assert.equal(h.root.buttons('Put back wine decanter').length, 0);
  h.api._receiveRpg({ ...state, character: { ...state.character, location: house } });
  const [drop] = h.root.buttons('Put back wine decanter');
  assert.ok(drop);
  drop.click();
  assert.deepEqual(h.sent.at(-1), { verb: 'quest.drop', args: { uid: quest.uid, item: 'decanter' } });
});

test('another account or character on the same page never sees the previous feed', () => {
  const h = harness();
  h.api.account = { id: '1', username: 'a' };
  h.api._receiveRpg(rpg({ v: 1, active: [], done: [], offer: null }));
  h.open();
  const ev = { kind: 'questMessage', title: 'Secret', text: 'Private quest text for A.' };
  h.api.emit('event', ev);
  assert.match(h.text(), /Private quest text for A/);
  assert.equal(ev.silent, true, 'the journal toasts quest text itself, so main.js must not toast it again');
  assert.equal(h.notes.filter((n) => n.includes('Private quest text')).length, 1, 'one toast');
  // Leave → sign in as B on the same page → join.
  h.api._reset?.();
  h.api.emit('state', null);
  h.api.account = { id: '2', username: 'b' };
  h.api.emit('account', h.api.account);
  h.api._receiveRpg({ ...rpg({ v: 1, active: [], done: [], offer: null }), selfId: 8 });
  h.api.openPanel('journal');
  assert.doesNotMatch(h.text(), /Private quest text for A/);
  assert.doesNotMatch(h.text(), /Secret/);
});

test('questGiversHere sorts by distance and ignores the dead', () => {
  const g = questGiversHere({ entities: [
    { id: 'a', kind: 'npc', name: 'Far', questGiver: true, role: 'noble', x: 30, z: 0 },
    { id: 'b', kind: 'npc', name: 'Near', questGiver: true, role: 'mages', x: 2, z: 0 },
    { id: 'c', kind: 'npc', name: 'Dead', questGiver: true, dead: true, x: 1, z: 0 },
  ] }, { x: 0, z: 0 });
  assert.deepEqual(g.map((x) => [x.name, x.role, x.distance]), [['Near', 'Mages Guild', 2], ['Far', 'Noble', 30]]);
});

test('shell fallback journal reads the server’s v1 journal instead of listing its keys', async () => {
  const { builtinPanels } = await import('../client/gameplay/shell.js');
  const render = (state) => { const el = new El0('div'); builtinPanels.journal(el, { state }); return el.textContent; };
  const t = render({ character: { quests: { v: 1, active: [inst()], done: [{ uid: 'd', title: 'Old job', result: 'success', log: ['Paid.'] }], offer: null, oneTime: [], seq: 2 } } });
  assert.match(t, /Work for Test Giver/);
  assert.match(t, /Old job/);
  assert.doesNotMatch(t, /oneTime|seq/);
  assert.match(render({ character: { quests: { v: 1, active: [], done: [] } } }), /journal is empty/);
  assert.match(render(null), /once your character has loaded/);
  assert.match(render({ character: {} }), /has not sent a quest journal/);
});

test('classic hard-wrapped quest text reflows; paragraphs stay', async () => {
  const { reflow } = await import('../client/gameplay/quests.js');
  assert.equal(reflow('I agreed to help\nTobin find a\nfriend.'), 'I agreed to help Tobin find a friend.');
  assert.equal(reflow('First line\nwraps.\n\nSecond para.'), 'First line wraps.\n\nSecond para.');
  assert.equal(reflow(null), '');
});

test('escort faces: people travelling with the player are listed on their quest', () => {
  const h = harness();
  h.api._receiveRpg(rpg({ v: 1, active: [inst({ faces: [{ person: 'p.01', name: 'Test Giver' }, { person: 'p.00', name: 'Test Betrothed' }] })], done: [], offer: null }));
  h.open();
  assert.match(h.text(), /Travelling with you: Test Giver, Test Betrothed/);
  h.api._receiveRpg(rpg({ v: 1, active: [inst()], done: [], offer: null }));
  assert.doesNotMatch(h.text(), /Travelling with you/);
});

test('prompts are never duplicated in the feed, persisted messages render across reloads, and background/internal timers stay clean', async () => {
  const { soonestQuestDeadline, restWarningsFor } = await import('../client/gameplay/quickslots.js');
  const h = harness();
  const tut = inst({
    uid: '_TUTOR__-1', name: '_TUTOR__', title: 'Tutorial', giver: null, log: [],
    prompt: { id: 1010, text: 'Do you want to use this tutorial?' },
    messages: [{ id: 1012, text: 'Lesson 1: Move with WASD.', at: 6187886 }],
    clocks: { 's.03': { total: 6, endAt: 6187891, running: true, done: false } },
  });
  const bg = inst({ uid: 'S0000977-2', name: 'S0000977', title: 'Curse of Daggerfall', background: true, giver: null, log: [], clocks: {} });
  const brisPre = inst({
    uid: '_BRISIEN-3', name: '_BRISIEN', title: 'Lady Brisienna', giver: null, log: [],
    items: { 'i.00': { name: 'letter', held: false, handedOver: false } },
    clocks: { 's.00': { total: 14400, endAt: 6202285, running: true, done: false } },
  });
  const brisPost = inst({
    ...brisPre,
    items: { 'i.00': { name: 'letter', held: true, handedOver: false } },
    clocks: { 's.01': { total: 43200, endAt: 6231085, running: true, done: false } },
  });
  assert.equal(questDeadline(tut), null, 'tutorial pacing clock is not a due date');
  assert.equal(questDeadline(bg), null, 'background quest has no due date');
  assert.equal(questDeadline(brisPre), null, 'Brisienna courier delay before letter arrives is not a player deadline');
  assert.equal(questDeadline(brisPost), 6231085, 'Brisienna meeting deadline shows once the letter arrives');

  // Personal quest clock matches server playerMinutes (worldMinutes + personalMinutes).
  const personalDue = soonestQuestDeadline({
    atmosphere: { personalMinutes: 1440 * 10 },
    quests: { active: [tut, bg, brisPre, brisPost] },
  }, 6200000);
  assert.equal(personalDue.title, 'Lady Brisienna');
  assert.equal(personalDue.remaining, 6231085 - (6200000 + 1440 * 10));

  // Vertical floor separation stops upper-floor monsters from triggering "Enemies are nearby".
  const upperRat = { id: 'm1', kind: 'monster', dead: false, hp: 10, x: 1, z: 1, y: 19 };
  assert.equal(restWarningsFor({ character: { location: 'dungeon:test' }, entities: [upperRat] }, { x: 0, z: 0, y: 1.6 }).length, 0);
  const sameFloorRat = { id: 'm2', kind: 'monster', dead: false, hp: 10, x: 1, z: 1, y: 0 };
  assert.equal(restWarningsFor({ character: { location: 'dungeon:test' }, entities: [sameFloorRat] }, { x: 0, z: 0, y: 1.6 }).length, 1);

  h.api._receiveRpg(rpg({ v: 1, active: [tut, bg], done: [] }));
  h.api.emit('event', { kind: 'questPrompt', uid: tut.uid, title: tut.title, text: tut.prompt.text });
  h.api.emit('event', { kind: 'questAccepted', uid: bg.uid, title: bg.title, text: '', background: true });
  h.open();
  const text = h.text();
  assert.equal(text.split('Do you want to use this tutorial?').length - 1, 1, 'prompt appears once, never duplicated in feed');
  assert.match(text, /Lesson 1: Move with WASD\./, 'persisted quest message renders inside the quest card');
  assert.doesNotMatch(text, /No journal entry yet/, 'persisted message replaces empty-log placeholder');
  assert.doesNotMatch(text, /Curse of Daggerfall/, 'silent background quest is hidden from Current work');
  assert.equal(h.notes.some((n) => n.includes('Curse of Daggerfall')), false, 'background quest does not toast');
});

test('opening quest events wait until leaving the loading/creation screen', () => {
  const h = harness();
  h.api.screen = 'loading';
  h.api._receiveRpg(rpg({ v: 1, active: [inst({ uid: 't1', prompt: { id: 1010, text: 'Ready?' } })], done: [] }));
  h.api.emit('event', { kind: 'questMessage', uid: 't1', title: 'Tutorial', text: 'Welcome to Privateer’s Hold.' });
  assert.equal(h.notes.length, 0, 'toasts wait while loading screen is active');
  h.api.screen = 'game';
  h.api.emit('screen', 'game');
  assert.ok(h.notes.some((n) => n.includes('Welcome to Privateer')), 'queued toast flushes once game screen is visible');
});
