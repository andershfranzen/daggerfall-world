// Proximity chat, shout/yell, slash-command parser, cross-boundary peerView, emote and whisper tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { install } from '../server/rpg/social.js';
import {
  PROXIMITY_RANGE,
  SHOUT_RANGE,
  canonicalChannel,
  parseChatCommand,
} from '../server/rpg/social/proximity.js';
import { parseChatInput, parseChannelCommand } from '../client/gameplay/social/model.js';

function makeRuntime({ muted = new Set(), acrossFn = null, sameSceneFn = null } = {}) {
  let clock = 1_000;
  const players = new Map();
  const actions = new Map();
  const hooks = { join: [], leave: [], tick: [] };
  const inbox = new Map();
  const services = {
    isMuted: (p) => muted.has(p.id),
    ...(acrossFn ? { peerView: { across: acrossFn, range: SHOUT_RANGE } } : {}),
  };
  const ctx = {
    players,
    entities: new Map(),
    services,
    now: () => clock,
    dirty: () => {},
    notify: (p, event) => (inbox.get(p.id) ?? inbox.set(p.id, []).get(p.id)).push(event),
    sameScene: sameSceneFn ?? ((a, b) => (a.scene ?? null) === (b.scene ?? null)),
    onJoin: (fn) => hooks.join.push(fn),
    onLeave: (fn) => hooks.leave.push(fn),
    onTick: (fn) => hooks.tick.push(fn),
    onAction: (verb, fn) => actions.set(verb, fn),
  };
  const feature = install(ctx);

  function act(p, verb, args = {}) {
    const fn = actions.get(verb);
    if (!fn) throw new Error(`no action ${verb}`);
    fn(p, args);
  }

  function join(id, name, { x = 0, z = 0, location = 'town:Daggerfall/Gothway Garden', scene = null } = {}) {
    const p = {
      id,
      name,
      x,
      z,
      yaw: 0,
      moving: false,
      scene,
      rpg: { location, gold: 100, inventory: [], equipment: {} },
    };
    players.set(id, p);
    for (const fn of hooks.join) fn(p);
    return p;
  }

  const chats = (p) => (inbox.get(p.id) ?? []).filter((e) => e.kind === 'chat');
  return { ctx, feature, act, join, chats, services };
}

test('proximity chat reaches nearby players within 24 m and excludes distant or interior players', () => {
  const rt = makeRuntime();
  const speaker = rt.join(1, 'Ada', { x: 0, z: 0 });
  const close = rt.join(2, 'Bram', { x: 12, z: 0 });
  const edge = rt.join(3, 'Cyra', { x: PROXIMITY_RANGE, z: 0 });
  const far = rt.join(4, 'Doran', { x: 50, z: 0 });
  const indoors = rt.join(5, 'Elin', { x: 2, z: 0, location: 'interior:Daggerfall/Tavern' });
  const otherScene = rt.join(6, 'Fenn', { x: 2, z: 0, scene: 'ship-deck-1' });

  rt.act(speaker, 'chat.send', { channel: 'say', text: 'Keep your voice down.' });

  assert.equal(rt.chats(speaker).at(-1)?.text, 'Keep your voice down.');
  assert.equal(rt.chats(speaker).at(-1)?.channel, 'say');
  assert.equal(rt.chats(close).at(-1)?.text, 'Keep your voice down.');
  assert.equal(rt.chats(edge).at(-1)?.text, 'Keep your voice down.');
  assert.equal(rt.chats(far).length, 0, '50 m away in same town should not hear proximity say');
  assert.equal(rt.chats(indoors).length, 0, 'different interior should not hear proximity say');
  assert.equal(rt.chats(otherScene).length, 0, 'different scene should not hear proximity say');

  // `local` alias behaves identically to `say` and normalizes to `say`.
  rt.act(speaker, 'chat.send', { channel: 'local', text: 'Alias test' });
  assert.equal(rt.chats(close).at(-1)?.channel, 'say');
  assert.equal(rt.chats(far).length, 0);

  // `/me` emote also respects 24 m proximity.
  rt.act(speaker, 'chat.send', { channel: 'emote', text: 'nods quietly.' });
  assert.equal(rt.chats(close).at(-1)?.channel, 'emote');
  assert.equal(rt.chats(far).length, 0);
});

test('proximity and shout cross-boundary awareness via services.peerView', () => {
  const acrossMap = new Map();
  const rt = makeRuntime({
    acrossFn: (viewer) => acrossMap.get(viewer.id) ?? [],
  });
  const insideGate = rt.join(1, 'Ada', { x: 0, z: 0, location: 'town:Daggerfall/Gothway Garden' });
  const outsideNear = rt.join(2, 'Bram', { x: 10, z: 0, location: 'wilderness:Daggerfall/0,0' });
  const outsideMid = rt.join(3, 'Cyra', { x: 80, z: 0, location: 'wilderness:Daggerfall/0,0' });
  const outsideTooFar = rt.join(4, 'Doran', { x: 200, z: 0, location: 'wilderness:Daggerfall/0,0' });

  acrossMap.set(insideGate.id, [
    { player: outsideNear, x: 14, z: 0, distance: 14 },
    { player: outsideMid, x: 80, z: 0, distance: 80 },
    { player: outsideTooFar, x: 200, z: 0, distance: 200 },
  ]);

  // Proximity say crosses the gate only within 24 m.
  rt.act(insideGate, 'chat.send', { channel: 'say', text: 'Open the gate!' });
  assert.equal(rt.chats(outsideNear).length, 1, '14 m across gate hears proximity chat');
  assert.equal(rt.chats(outsideMid).length, 0, '80 m across gate does not hear proximity chat');
  assert.equal(rt.chats(outsideTooFar).length, 0, '200 m across gate does not hear proximity chat');

  // Shout crosses the gate up to SHOUT_RANGE (160 m).
  rt.act(insideGate, 'chat.send', { channel: 'shout', text: 'Riders approaching!' });
  assert.equal(rt.chats(outsideNear).at(-1)?.channel, 'shout');
  assert.equal(rt.chats(outsideMid).at(-1)?.text, 'Riders approaching!', '80 m across gate hears shout');
  assert.equal(rt.chats(outsideTooFar).length, 0, '200 m across gate is beyond SHOUT_RANGE');
});

test('shout/yell reaches distant players in the same town while respecting mutes, validation and privacy', () => {
  const rt = makeRuntime({ muted: new Set([4]) });
  const speaker = rt.join(1, 'Ada', { x: 0, z: 0 });
  const distantSameTown = rt.join(2, 'Bram', { x: 100, z: 0 });
  const otherTown = rt.join(3, 'Cyra', { x: 0, z: 0, location: 'town:Wayrest/Market' });
  const muted = rt.join(4, 'Mute', { x: 5, z: 0 });
  const interior = rt.join(5, 'Elin', { x: 5, z: 0, location: 'interior:Daggerfall/Guild' });

  // Using `yell` alias normalizes to `shout` and reaches 100 m away in same town.
  rt.act(speaker, 'chat.send', { channel: 'yell', text: 'Rally at the fountain!' });
  assert.equal(rt.chats(speaker).at(-1)?.channel, 'shout');
  assert.equal(rt.chats(distantSameTown).at(-1)?.text, 'Rally at the fountain!');
  assert.equal(rt.chats(distantSameTown).at(-1)?.channel, 'shout');
  assert.equal(rt.chats(otherTown).length, 0, 'other town does not hear shout');
  assert.equal(rt.chats(interior).length, 0, 'unrelated interior does not hear outdoor shout');

  // Mute and empty text validation still apply to shout and say.
  assert.throws(() => rt.act(muted, 'chat.send', { channel: 'shout', text: 'hello' }), /muted/);
  assert.throws(() => rt.act(muted, 'chat.send', { channel: 'say', text: 'hello' }), /muted/);
  assert.throws(() => rt.act(speaker, 'chat.send', { channel: 'shout', text: '   ' }), /empty/);
  assert.throws(() => rt.act(speaker, 'chat.send', { channel: 'say', text: '' }), /empty/);
});

test('whisper delivers privately to sender and recipient and validates targets', () => {
  const rt = makeRuntime();
  const a = rt.join(1, 'Ada');
  const b = rt.join(2, 'Bob the Brave', { location: 'town:Wayrest/Market' });
  const c = rt.join(3, 'Cyra');

  rt.act(a, 'chat.send', { channel: 'whisper', target: 'Bob the Brave', text: 'Meet me north.' });
  assert.equal(rt.chats(a).at(-1)?.toId, b.id);
  assert.equal(rt.chats(a).at(-1)?.toName, 'Bob the Brave');
  assert.equal(rt.chats(b).at(-1)?.text, 'Meet me north.');
  assert.equal(rt.chats(c).length, 0);

  // Unique prefix match works.
  rt.act(a, 'chat.send', { channel: 'whisper', target: 'cyr', text: 'Psst.' });
  assert.equal(rt.chats(c).at(-1)?.text, 'Psst.');

  // Error cases.
  assert.throws(() => rt.act(a, 'chat.send', { channel: 'whisper', text: 'no target' }), /Choose/);
  assert.throws(() => rt.act(a, 'chat.send', { channel: 'whisper', target: 'Ada', text: 'hi' }), /yourself/);
  assert.throws(() => rt.act(a, 'chat.send', { channel: 'whisper', target: 'Ghost', text: 'hi' }), /No online player/);
});

test('services.chatAudience exposes reusable proximity and shout audience selection', () => {
  const rt = makeRuntime();
  const a = rt.join(1, 'Ada', { x: 0, z: 0 });
  const near = rt.join(2, 'Bram', { x: 10, z: 0 });
  const far = rt.join(3, 'Cyra', { x: 90, z: 0 });
  const other = rt.join(4, 'Doran', { x: 0, z: 0, location: 'town:Sentinel/Plaza' });

  assert.deepEqual(
    rt.services.chatAudience(a, 'say').map((p) => p.id).sort(),
    [a.id, near.id],
  );
  assert.deepEqual(
    rt.services.chatAudience(a, 'shout').map((p) => p.id).sort(),
    [a.id, near.id, far.id],
  );
  assert.deepEqual(
    rt.services.chatAudience(a, 'global').map((p) => p.id).sort(),
    [a.id, near.id, far.id, other.id],
  );
  assert.equal(canonicalChannel('yell'), 'shout');
  assert.equal(canonicalChannel('local'), 'say');
  assert.equal(canonicalChannel('unknown'), null);
});

test('command parsers route plain text to proximity, slash/yell to shout, and all known commands', () => {
  for (const parse of [parseChatCommand, parseChatInput]) {
    // Plain text -> proximity say.
    assert.deepEqual(parse('Hello there'), { channel: 'say', text: 'Hello there' });
    assert.deepEqual(parse('  multiple   spaces  '), { channel: 'say', text: 'multiple spaces' });

    // Shout / yell commands and bare leading `/`.
    assert.deepEqual(parse('/shout Watch out!'), { channel: 'shout', text: 'Watch out!' });
    assert.deepEqual(parse('/yell Gather here!'), { channel: 'shout', text: 'Gather here!' });
    assert.deepEqual(parse('/y Incoming!'), { channel: 'shout', text: 'Incoming!' });
    assert.deepEqual(parse('/s Hear ye!'), { channel: 'shout', text: 'Hear ye!' });
    assert.deepEqual(parse('/Hello everyone!'), { channel: 'shout', text: 'Hello everyone!' });
    assert.deepEqual(parse('/Watch out!'), { channel: 'shout', text: 'Watch out!' });
    assert.deepEqual(parse('/  Space after slash'), { channel: 'shout', text: 'Space after slash' });

    // Explicit say/local, party, region, global, emote, help.
    assert.deepEqual(parse('/say quiet'), { channel: 'say', text: 'quiet' });
    assert.deepEqual(parse('/local nearby'), { channel: 'say', text: 'nearby' });
    assert.deepEqual(parse('/p regroup'), { channel: 'party', text: 'regroup' });
    assert.deepEqual(parse('/party ready'), { channel: 'party', text: 'ready' });
    assert.deepEqual(parse('/r Daggerfall news'), { channel: 'region', text: 'Daggerfall news' });
    assert.deepEqual(parse('/region anyone?'), { channel: 'region', text: 'anyone?' });
    assert.deepEqual(parse('/g hi world'), { channel: 'global', text: 'hi world' });
    assert.deepEqual(parse('/global welcome'), { channel: 'global', text: 'welcome' });
    assert.deepEqual(parse('/me waves warmly'), { channel: 'emote', text: 'waves warmly' });
    assert.deepEqual(parse('/help'), { channel: 'help', text: '' });
    assert.deepEqual(parse('/?'), { channel: 'help', text: '' });

    // Whisper with single-word and quoted multi-word names.
    assert.deepEqual(parse('/w Bram meet at the inn'), { channel: 'whisper', target: 'Bram', text: 'meet at the inn' });
    assert.deepEqual(parse('/whisper "Bob the Brave" check north gate'), {
      channel: 'whisper',
      target: 'Bob the Brave',
      text: 'check north gate',
    });

    // Empty / non-string.
    assert.equal(parse('   '), null);
    assert.equal(parse(''), null);
    assert.equal(parse(null), null);
  }

  // Legacy parseChannelCommand remains backwards-compatible.
  assert.deepEqual(parseChannelCommand('/p hi'), { channel: 'party', text: 'hi' });
  assert.equal(parseChannelCommand('/shrug'), null);
});
