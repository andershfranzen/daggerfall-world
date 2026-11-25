// Game shell: gameplay API, RPG networking, bindings, targeting and gamepad helpers (DOM-free).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGameplayApi, mergeRpg, locationOf, locationName, vitalsOf, readiedOf, statsOf, pickTarget,
  interactionFor, normalizeBindings, rebind, actionForCode, DEFAULT_BINDINGS, keyLabel,
  installFeatures, manifestEntries, targetables, DEFAULT_LOCATION,
} from '../client/gameplay/api.js';
import { Connection, CLOSE, describeClose, sanitizeRpg, validVerb } from '../client/lib/net.js';
import { PadReader, PAD, deadZone } from '../client/input.js';

// ---------------------------------------------------------------- state helpers

const rpgMsg = (over = {}) => ({
  type: 'rpg', selfId: 7,
  character: {
    location: 'town:Daggerfall/Gothway Garden', readied: false, gold: 12,
    character: { race: 'Breton', className: 'Mage', level: 2, health: 30, maxHealth: 40, fatigue: 80, maxFatigue: 80, magicka: 5, maxMagicka: 60 },
  },
  entities: [{ id: 'npc-1', kind: 'npc', name: 'Gerard', x: 0, z: -3 }],
  peers: [{ id: 9, name: 'Ysmir', x: 3, z: 0 }],
  ...over,
});

test('state helpers read nested p.rpg records and numeric vitals', () => {
  const s = mergeRpg(null, rpgMsg());
  assert.equal(locationOf(s), 'town:Daggerfall/Gothway Garden');
  assert.equal(locationName(locationOf(s)), 'Gothway Garden');
  const town = { name: 'Copperfield Manor', region: 'Daggerfall', displayName: 'Port of Daggerfall' };
  assert.equal(locationName('town:Daggerfall/Copperfield Manor', null, town), town.displayName);
  assert.equal(locationName('town:Daggerfall/Gothway Garden', null, town), 'Gothway Garden');
  const store = { location: 'interior:Daggerfall/Gothway Garden/1,2/15', name: 'General store, Gothway Garden' };
  assert.equal(locationName(store.location, null, store), store.name);
  assert.equal(statsOf(s).className, 'Mage');
  assert.deepEqual(vitalsOf(s), { health: [30, 40], fatigue: [80, 80], magicka: [5, 60] });
  assert.equal(readiedOf(s), false);
  assert.equal(readiedOf(mergeRpg(s, { character: { ...s.character, readied: true } })), true);
  assert.deepEqual(vitalsOf(null), { health: null, fatigue: null, magicka: null });
  // Partial messages keep earlier keys.
  const t = mergeRpg(s, { entities: [] });
  assert.equal(t.peers.length, 1);
  assert.equal(t.entities.length, 0);
});

test('numeric classic addresses show names only from the current scene or portal', () => {
  const town = { name: 'Djen Lodge', source: { regionIndex: 0, locationIndex: 272 } };
  assert.equal(locationName('town:0/272', null, town), 'Djen Lodge');
  assert.equal(locationName('town:0/139', null, town), 'Iliac Bay');
  const interior = 'interior:0/272/0,0/1';
  assert.equal(locationName(interior, null, town, { to: interior, label: 'Shrine' }), 'Shrine');
  const dungeon = { location: 'dungeon:17/179', name: "Privateer's Hold" };
  assert.equal(locationName(dungeon.location, null, dungeon), dungeon.name);
  assert.equal(locationName('dungeon:17/201', null, dungeon), 'Dungeon');
});

test('targetables exclude self and include peers as players', () => {
  const s = mergeRpg(null, rpgMsg({ peers: [{ id: 7, name: 'Me', x: 0, z: 0 }, { id: 9, name: 'Ysmir', x: 1, z: 1 }] }));
  const list = targetables(s, '7');
  assert.deepEqual(list.map((e) => [e.id, e.kind]), [['npc-1', 'npc'], ['9', 'player']]);
});

test('pickTarget chooses the entity nearest the crosshair within range', () => {
  const cam = { x: 0, z: 0, yaw: 0 }; // facing -z
  const cands = [
    { id: 'ahead', kind: 'npc', x: 0, z: -4 },
    { id: 'side', kind: 'npc', x: 4, z: 0 },
    { id: 'far', kind: 'npc', x: 0, z: -30 },
  ];
  assert.equal(pickTarget(cam, cands), 'ahead');
  assert.equal(pickTarget({ ...cam, yaw: Math.PI / 2 }, cands), 'side'); // facing +x
  assert.equal(pickTarget({ ...cam, yaw: Math.PI }, cands), null);
  // Living creatures win over corpses at similar angles.
  const mixed = [{ id: 'corpse', kind: 'monster', hp: 0, x: 0, z: -2 }, { id: 'rat', kind: 'monster', hp: 5, x: 0.3, z: -3 }];
  assert.equal(pickTarget(cam, mixed), 'rat');
});

test('interactionFor maps targets to registered server verbs only', () => {
  assert.deepEqual(interactionFor({ id: 'n', kind: 'npc' }), { verb: 'npc.talk', args: { targetId: 'n' } });
  assert.deepEqual(interactionFor({ id: 'l', kind: 'loot' }), { verb: 'inventory.inspectLoot', args: { targetId: 'l' } });
  assert.deepEqual(interactionFor({ id: 3, kind: 'player' }), { panel: 'party', args: { targetId: '3' } });
  assert.equal(interactionFor({ id: 'm', kind: 'monster', hp: 4 }), null);
  assert.deepEqual(interactionFor({ id: 'm', kind: 'monster', dead: true, lootable: true }), { verb: 'combat.loot', args: { targetId: 'm' } });
  assert.equal(interactionFor({ id: 'm', kind: 'monster', dead: true, looted: true }), null);
  assert.deepEqual(interactionFor({ id: 2, kind: 'player', defeated: true }), { verb: 'combat.revive', args: { targetId: '2' } });
  assert.equal(interactionFor({ id: 'd', kind: 'door' }), null); // left to the interactIntent consumer
  assert.equal(interactionFor(null), null);
  for (const k of ['npc', 'loot']) assert.ok(validVerb(interactionFor({ id: 1, kind: k }).verb));
});

// ---------------------------------------------------------------- bindings

test('bindings: defaults, validation, rebinding and reserved keys', () => {
  assert.equal(DEFAULT_BINDINGS.ready, 'KeyF');
  assert.equal(DEFAULT_BINDINGS.attack, 'Space');
  assert.equal(DEFAULT_BINDINGS.interact, 'KeyG');
  assert.equal(DEFAULT_BINDINGS.people, 'KeyP');
  const n = normalizeBindings({ ready: 'KeyR', attack: 'KeyW', bogus: 'KeyZ', map: 'KeyR' });
  assert.equal(n.ready, 'KeyR');
  assert.equal(n.attack, 'Space', 'movement keys cannot be bound');
  assert.equal(n.map, null, 'a duplicate key is unbound from the later action');
  assert.ok(!('bogus' in n));
  const r = rebind(DEFAULT_BINDINGS, 'map', 'KeyF');
  assert.equal(r.map, 'KeyF');
  assert.equal(r.ready, null);
  assert.throws(() => rebind(DEFAULT_BINDINGS, 'map', 'Tab'), /reserved/);
  assert.equal(actionForCode(DEFAULT_BINDINGS, 'KeyG'), 'interact');
  assert.equal(keyLabel('KeyG'), 'G');
  assert.equal(keyLabel('Space'), 'Space');
});

// ---------------------------------------------------------------- the API object

test('api: events are isolated, panels replace built-ins, target is assignable', () => {
  const sent = [];
  const api = createGameplayApi({ send: (v, a) => { sent.push([v, a]); return true; } });
  const seen = [];
  api.on('x', () => { throw new Error('boom'); });
  api.on('x', (d) => seen.push(d));
  const orig = console.error; console.error = () => {};
  try { assert.equal(api.emit('x', 1), 1); } finally { console.error = orig; }
  assert.deepEqual(seen, [1]);

  const builtin = () => {};
  const real = () => {};
  assert.ok(api.registerPanel('inventory', 'Inventory', builtin, { builtin: true }));
  assert.ok(api.registerPanel('inventory', 'Inventory', real));
  assert.equal(api.getPanel('inventory').render, real);
  assert.equal(api.registerPanel('inventory', 'Inventory', builtin, { builtin: true }), false, 'built-in never replaces a feature');
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(api.registerPanel('inventory', 'Other', () => {}), false); } finally { console.warn = warn; }
  assert.ok(api.registerPanel('automap', 'Automap', () => {}, { key: 'Backquote' }));
  assert.deepEqual(api.panels().map((p) => p.id), ['inventory', 'automap']);

  const targets = [];
  api.on('target', (t) => targets.push(t.id));
  api.target = 'npc-1';
  assert.equal(api.target, 'npc-1');
  assert.ok(api.targetOwnedByFeature);
  api.target = 'npc-1'; // unchanged: no event
  api.setTarget(null);
  assert.deepEqual(targets, ['npc-1', null]);

  assert.ok(api.act('combat.attack', { targetId: 'm1' }));
  assert.deepEqual(sent, [['combat.attack', { targetId: 'm1' }]]);
});

test('api.act: resolves with the server result and reports failures once', async () => {
  const notes = [];
  let answer;
  const api = createGameplayApi({ send: () => new Promise((r) => { answer = r; }), notify: (t) => notes.push(t) });
  const p = api.act('travel.go', { to: 'x' });
  assert.ok(p && typeof p.then === 'function');
  answer({ ok: false, verb: 'travel.go', error: 'you cannot afford the journey' });
  assert.deepEqual(await p, { ok: false, verb: 'travel.go', error: 'you cannot afford the journey' });
  assert.deepEqual(notes, ['You cannot afford the journey']);
  const q = api.act('travel.go', {}, { quiet: true });
  answer({ ok: false, error: 'nope' });
  await q;
  assert.equal(notes.length, 1, 'quiet callers show their own errors');
});

test('api: offline actions report failure to the player', () => {
  const notes = [];
  const api = createGameplayApi({ send: () => false, notify: (t, o) => notes.push([t, o.kind]) });
  assert.equal(api.act('combat.ready', { ready: true }), false);
  assert.deepEqual(notes, [['Not connected — action not sent.', 'error']]);
});

test('api: location changes emit once, clear the target and drop stale scenes', async () => {
  const applied = [];
  const api = createGameplayApi({ applyScene: (m) => applied.push(m.name) });
  const locs = [];
  api.on('location', (d) => locs.push([d.location, d.previous, d.peers.length]));
  api._receiveRpg(rpgMsg());
  assert.equal(api.selfId, '7');
  assert.deepEqual(locs, [['town:Daggerfall/Gothway Garden', null, 1]]);
  api._receiveRpg(rpgMsg()); // same place: no event
  assert.equal(locs.length, 1);

  api.target = 'npc-1';
  // A slow scene load started before travel must not overwrite the new place.
  let finishOld;
  const oldLoad = api.setScene(new Promise((r) => { finishOld = r; }));
  const moved = api._receiveRpg(rpgMsg({ character: { location: 'dungeon:Privateer\'s Hold', character: {} }, peers: [] }));
  assert.equal(moved.locationChanged, true);
  assert.equal(api.target, null);
  assert.deepEqual(locs[1], ["dungeon:Privateer's Hold", 'town:Daggerfall/Gothway Garden', 0]);
  finishOld({ name: 'old-town' });
  assert.equal(await oldLoad, false);
  assert.equal(await api.setScene({ name: 'hold' }, { location: "dungeon:Privateer's Hold" }), true);
  assert.equal(await api.setScene({ name: 'wrong' }, { location: 'town:Elsewhere' }), false);
  assert.deepEqual(applied, ['hold']);

  api._reset();
  assert.equal(api.state, null);
  api._receiveRpg({ type: 'rpg', selfId: 1, character: {}, entities: [], peers: [] });
  assert.equal(api.location, DEFAULT_LOCATION, 'missing location falls back to the default town');
});

test('features: manifest shapes and isolated installs', async () => {
  const calls = [];
  const a = { install(api) { calls.push(['a', typeof api.on]); } };
  const b = { install() { throw new Error('broken'); } };
  const c = (api) => calls.push(['c', !!api]);
  assert.equal(manifestEntries({ default: [a, b] }).length, 2);
  assert.equal(manifestEntries({ features: [c] }).length, 1);
  assert.equal(manifestEntries({ inventory: a, nothing: { foo: 1 } }).length, 1);
  assert.deepEqual(manifestEntries(null), []);
  const api = createGameplayApi();
  const orig = console.error; console.error = () => {};
  let res;
  try { res = await installFeatures(api, [a, b, c, { name: 'empty' }]); } finally { console.error = orig; }
  assert.deepEqual(res.map((r) => r.ok), [true, false, true, false]);
  assert.deepEqual(calls, [['a', 'function'], ['c', true]]);
});

// ---------------------------------------------------------------- networking

class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeWS.last = this; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0); }
  send(data) { const m = JSON.parse(data); this.sent.push(m); FakeWS.script?.(this, m); }
  recv(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  close(code = 1000, reason = '') { if (this.readyState === 3) return; this.readyState = 3; setTimeout(() => this.onclose?.({ code, reason }), 0); }
}

test('connection: account join sends no guest token, carries claimToken, accepts null token', async () => {
  FakeWS.script = (ws, msg) => {
    if (msg.type === 'join') ws.recv({ type: 'welcome', id: 4, token: null, account: { id: 12, username: 'Ysmir' }, player: { id: 4, name: 'Ysmir', x: 1, z: 2, yaw: 0 } });
  };
  const c = new Connection('ws://x/ws', { WebSocketImpl: FakeWS });
  const w = await c.connect({ name: 'Ysmir', token: 'should-not-be-sent', account: true, claimToken: 'A'.repeat(43) });
  assert.deepEqual(FakeWS.last.sent[0], { type: 'join', name: 'Ysmir', arrival: true, delta: true, patch: true, account: true, claimToken: 'A'.repeat(43) });
  assert.equal(w.token, null);
  assert.deepEqual(w.account, { id: '12', username: 'Ysmir' });
  assert.equal(c.sendArrived(), false, 'older servers do not negotiate the arrival acknowledgement');
  assert.equal(FakeWS.last.sent.length, 1);
  c.close();
});

test('connection: guest join still requires a token in the welcome', async () => {
  FakeWS.script = (ws, msg) => { if (msg.type === 'join') ws.recv({ type: 'welcome', id: 4, player: { id: 4, name: 'A' } }); };
  await assert.rejects(new Connection('ws://x', { WebSocketImpl: FakeWS }).connect({ name: 'A' }), { kind: 'rejected' });
});

test('connection: rpg, gameEvent and action messages', async () => {
  FakeWS.script = (ws, msg) => { if (msg.type === 'join') ws.recv({ type: 'welcome', id: 1, token: 't'.repeat(43), player: { id: 1, name: 'A' } }); };
  const c = new Connection('ws://x', { WebSocketImpl: FakeWS });
  await c.connect({ name: 'A' });
  const got = [];
  c.onRpg = (r) => got.push(['rpg', r.selfId, r.entities.length, r.peers.length]);
  c.onGameEvent = (e) => got.push(['event', e.kind]);
  c.onMessage = (m) => got.push(['other', m.type]);
  FakeWS.last.recv({ type: 'rpg', selfId: 1, character: { location: 'x' }, entities: [{ id: 'e' }, { bogus: true }], peers: [] });
  FakeWS.last.recv({ type: 'gameEvent', event: { kind: 'swing', playerId: 1 } });
  FakeWS.last.recv({ type: 'gameEvent', event: 'nope' });
  FakeWS.last.recv({ type: 'future', x: 1 });
  assert.deepEqual(got, [['rpg', '1', 1, 0], ['event', 'swing'], ['other', 'future']]);
  const ready = c.sendAction('combat.ready', { ready: true });
  const sentMsg = FakeWS.last.sent.at(-1);
  assert.deepEqual(sentMsg, { type: 'action', verb: 'combat.ready', args: { ready: true }, seq: sentMsg.seq });
  FakeWS.last.recv({ type: 'actionResult', seq: sentMsg.seq + 99, ok: true }); // unrelated seq: ignored
  FakeWS.last.recv({ type: 'actionResult', seq: sentMsg.seq, verb: 'combat.ready', ok: false, error: 'no weapon' });
  assert.deepEqual(await ready, { verb: 'combat.ready', ok: false, error: 'no weapon' });
  assert.equal(c.sendAction('bad verb!'), false);
  const talk = c.sendAction('npc.talk', 'not-an-object');
  assert.deepEqual(FakeWS.last.sent.at(-1).args, {});
  c.actionTimeoutMs = 10;
  const slow = c.sendAction('travel.go', {});
  assert.equal((await slow).timeout, true);
  c.close(); // pending actions settle instead of hanging
  assert.deepEqual(await talk, { verb: 'npc.talk', ok: false, error: 'You left the world.', closed: true });
});

test('connection: account close codes ask the player to sign in again', async () => {
  FakeWS.script = (ws, msg) => { if (msg.type === 'join') { ws.recv({ type: 'error', message: 'account banned' }); ws.close(CLOSE.ACCOUNT, 'account banned'); } };
  await assert.rejects(new Connection('ws://x', { WebSocketImpl: FakeWS }).connect({ name: 'A', account: true }), { kind: 'account', retryable: false });
  const d = describeClose(CLOSE.ACCOUNT, 'account access revoked');
  assert.equal(d.signIn, true);
  assert.equal(d.canReconnect, false);
  assert.match(d.text, /Sign in again/);
});

test('sanitizeRpg keeps known keys, filters malformed entities', () => {
  assert.equal(sanitizeRpg(null), null);
  const r = sanitizeRpg({ type: 'rpg', selfId: 3, entities: [{ id: 0 }, null, { name: 'x' }], peers: 'bad', extra: 1 });
  assert.deepEqual(r, { entities: [{ id: 0 }], peers: [], selfId: '3', extra: 1 });
  assert.ok(!('character' in r));
});

// ---------------------------------------------------------------- gamepad

test('gamepad: dead zone and button edges with d-pad repeat', () => {
  assert.deepEqual(deadZone(0.1, 0.1), [0, 0]);
  const [x] = deadZone(1, 0);
  assert.ok(Math.abs(x - 1) < 1e-9);
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, value: 0 }));
  const padObj = { connected: true, buttons, axes: [0, -1, 0, 0] };
  const r = new PadReader(() => [null, padObj]);
  let out = r.poll(0);
  assert.equal(out.pressed.size, 0);
  assert.ok(out.axes[1] < -0.99);
  buttons[PAD.A].pressed = true;
  buttons[PAD.DOWN].pressed = true;
  out = r.poll(0.1);
  assert.ok(out.pressed.has(PAD.A) && out.pressed.has(PAD.DOWN));
  out = r.poll(0.2);
  assert.equal(out.pressed.size, 0, 'held buttons do not repeat early');
  out = r.poll(0.65);
  assert.ok(out.pressed.has(PAD.DOWN) && !out.pressed.has(PAD.A), 'only the d-pad repeats');
  assert.equal(new PadReader(() => []).poll(0).pressed.size, 0);
});
