// Parties, trades and chat channels against a minimal in-process runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { install } from '../server/rpg/social.js';
import { regionOf, cleanChatText } from '../server/rpg/social/chat.js';

function makeRuntime({ muted = new Set() } = {}) {
  let clock = 1_000;
  let nextItem = 1;
  const players = new Map();
  const actions = new Map();
  const hooks = { join: [], leave: [], tick: [], events: new Map() };
  const inbox = new Map();
  const dirtied = new Set();
  const emitted = [];
  const services = {
    isMuted: (p) => muted.has(p.id),
    giveItem(p, template, quantity = 1) {
      const stack = p.rpg.inventory.find((i) => i.template === template && i.stack);
      if (stack) {
        stack.quantity += quantity;
        return stack;
      }
      const item = { id: `i${nextItem++}`, template, name: template, quantity, stack: template === 'potion' };
      p.rpg.inventory.push(item);
      return item;
    },
    takeItem(p, itemId, quantity = 1) {
      const idx = p.rpg.inventory.findIndex((i) => i.id === itemId);
      if (idx < 0) throw new Error('missing item');
      const item = p.rpg.inventory[idx];
      if (item.quantity < quantity) throw new Error('not enough');
      item.quantity -= quantity;
      if (!item.quantity) p.rpg.inventory.splice(idx, 1);
      return item;
    },
  };
  const ctx = {
    players,
    entities: new Map(),
    services,
    now: () => clock,
    dirty: (p) => dirtied.add(p.id),
    notify: (p, event) => (inbox.get(p.id) ?? inbox.set(p.id, []).get(p.id)).push(event),
    nearby: () => {},
    onJoin: (fn) => hooks.join.push(fn),
    onLeave: (fn) => hooks.leave.push(fn),
    onTick: (fn) => hooks.tick.push(fn),
    onAction: (verb, fn) => actions.set(verb, fn),
    on: (name, fn) => (hooks.events.get(name) ?? hooks.events.set(name, []).get(name)).push(fn),
    emit: (name, payload) => {
      emitted.push({ name, payload });
      for (const fn of hooks.events.get(name) ?? []) fn(payload);
    },
  };
  const feature = install(ctx);
  // Mirrors the runtime contract: the actor is saved on success; a throw saves nothing.
  const saved = new Map();
  function act(p, verb, args = {}) {
    const fn = actions.get(verb);
    if (!fn) throw new Error(`no action ${verb}`);
    dirtied.clear();
    fn(p, args);
    dirtied.add(p.id);
    for (const id of dirtied) if (players.get(id)) saved.set(id, structuredClone(players.get(id).rpg));
  }
  function join(id, name, extra = {}) {
    const p = {
      id,
      name,
      x: 0,
      z: 0,
      yaw: 0,
      moving: false,
      rpg: { location: 'town:Daggerfall/Gothway Garden', gold: 100, inventory: [], equipment: {}, ...structuredClone(extra) },
    };
    players.set(id, p);
    for (const fn of hooks.join) fn(p);
    return p;
  }
  function leave(p) {
    players.delete(p.id);
    for (const fn of hooks.leave) fn(p);
  }
  const tick = (ms = 40) => {
    clock += ms;
    for (const fn of hooks.tick) fn(ms / 1000, clock);
  };
  const last = (p) => [...(inbox.get(p.id) ?? [])].reverse().find((e) => e.text) ?? {};
  const social = (p) => [...(inbox.get(p.id) ?? [])].reverse().find((e) => e.social)?.social;
  const events = (p) => inbox.get(p.id) ?? [];
  return { ctx, feature, act, join, leave, tick, last, social, events, saved, emitted, services, give: services.giveItem };
}

const total = (players, template) =>
  players.reduce((n, p) => n + p.rpg.inventory.filter((i) => i.template === template).reduce((m, i) => m + i.quantity, 0), 0);
const gold = (players) => players.reduce((n, p) => n + p.rpg.gold, 0);

function openTrade(rt, a, b) {
  rt.act(a, 'trade.request', { targetId: b.id });
  const id = rt.social(b).trade.id;
  rt.act(b, 'trade.accept', { tradeId: id });
  return id;
}

test('chat helpers clean text and derive regions', () => {
  assert.equal(regionOf('town:Daggerfall/Gothway Garden'), 'Daggerfall');
  assert.equal(regionOf('dungeon:Privateer’s Hold'), 'Privateer’s Hold');
  assert.equal(cleanChatText('  hi‮  there\n'), 'hi there');
  assert.throws(() => cleanChatText('   '), /empty/);
  assert.throws(() => cleanChatText('x'.repeat(201)), /longer/);
});

test('party invite, accept, visible roster, persistence, leave and disband', () => {
  const rt = makeRuntime();
  const a = rt.join(1, 'Ada');
  const b = rt.join(2, 'Bram');
  const c = rt.join(3, 'Cyra');
  assert.deepEqual(rt.social(a).players.map((p) => p.name), ['Bram', 'Cyra']);
  rt.act(a, 'party.invite', { targetId: b.id });
  assert.equal(rt.social(b).invites[0].fromName, 'Ada');
  assert.throws(() => rt.act(a, 'party.invite', { targetId: b.id }), /already invited/);
  assert.throws(() => rt.act(a, 'party.invite', { targetId: a.id }), /yourself/);
  rt.act(b, 'party.accept', { fromId: a.id });
  const party = rt.social(a).party;
  assert.equal(party.leaderId, a.id);
  assert.deepEqual(party.members.map((m) => m.name).sort(), ['Ada', 'Bram']);
  assert.equal(a.rpg.party.id, b.rpg.party.id);
  assert.deepEqual(rt.saved.get(a.id).party, rt.saved.get(b.id).party, 'both rosters saved by the accept');
  // Non-leader cannot invite; declined invitations are cleared.
  assert.throws(() => rt.act(b, 'party.invite', { targetId: c.id }), /leader/);
  rt.act(a, 'party.invite', { targetId: c.id });
  rt.act(c, 'party.decline', { fromId: a.id });
  assert.match(rt.last(a).text, /declined/);
  assert.throws(() => rt.act(c, 'party.accept', { fromId: a.id }), /no longer open/);
  // Leader leaves: the remaining single member is disbanded and records cleared.
  rt.act(a, 'party.leave');
  assert.equal(a.rpg.party, undefined);
  assert.equal(b.rpg.party, undefined);
  assert.equal(rt.social(b).party, null);
  assert.equal(rt.feature.parties.size, 0);
});

test('invitations expire and are withdrawn on disconnect', () => {
  const rt = makeRuntime();
  const a = rt.join(1, 'Ada');
  const b = rt.join(2, 'Bram');
  rt.act(a, 'party.invite', { targetId: b.id });
  rt.tick(61_000);
  assert.equal(rt.social(b).invites.length, 0);
  assert.throws(() => rt.act(b, 'party.accept', { fromId: a.id }), /no longer open/);
  rt.act(a, 'party.invite', { targetId: b.id });
  rt.leave(a);
  assert.equal(rt.social(b).invites.length, 0);
});

test('party survives reconnect and restart; removed members cannot return on a stale roster', () => {
  const rt = makeRuntime();
  const a = rt.join(1, 'Ada');
  const b = rt.join(2, 'Bram');
  const c = rt.join(3, 'Cyra');
  rt.act(a, 'party.invite', { targetId: b.id });
  rt.act(b, 'party.accept', { fromId: a.id });
  rt.act(a, 'party.invite', { targetId: c.id });
  rt.act(c, 'party.accept', { fromId: a.id });
  const staleC = structuredClone(c.rpg);
  rt.leave(c);
  rt.act(a, 'party.kick', { targetId: c.id });
  const savedA = structuredClone(a.rpg);
  const savedB = structuredClone(b.rpg);

  // Restart: fresh runtime, the kicked member logs in first with an outdated roster.
  const rt2 = makeRuntime();
  const c2 = rt2.join(3, 'Cyra', staleC);
  assert.ok(rt2.social(c2).party, 'stale copy is provisional until a newer roster appears');
  const a2 = rt2.join(1, 'Ada', savedA);
  assert.equal(c2.rpg.party, undefined, 'newer roster removes the kicked member');
  assert.equal(rt2.social(c2).party, null);
  const b2 = rt2.join(2, 'Bram', savedB);
  const party = rt2.social(a2).party;
  assert.deepEqual(party.members.map((m) => m.id).sort(), [1, 2]);
  assert.ok(party.members.every((m) => m.online));
  assert.equal(rt2.social(b2).party.leaderId, 1);
});

test('two players complete a trade of items and gold with conservation', () => {
  const rt = makeRuntime();
  const a = rt.join(1, 'Ada');
  const b = rt.join(2, 'Bram');
  b.x = 3;
  const sword = rt.give(a, 'iron-longsword');
  sword.condition = 72;
  const potions = rt.give(b, 'potion', 5);
  const before = { gold: gold([a, b]), sword: total([a, b], 'iron-longsword'), potion: total([a, b], 'potion') };

  const id = openTrade(rt, a, b);
  rt.act(a, 'trade.offer', { tradeId: id, items: [{ id: sword.id, quantity: 1 }], gold: 10 });
  rt.act(b, 'trade.offer', { tradeId: id, items: [{ id: potions.id, quantity: 3 }], gold: 0 });
  const rev = rt.social(a).trade.revision;
  assert.deepEqual(rt.social(a).trade.theirs.items, [{ id: potions.id, template: 'potion', name: 'potion', quantity: 3 }]);
  rt.act(a, 'trade.confirm', { tradeId: id, revision: rev });
  assert.equal(rt.social(b).trade.theirs.confirmed, true);
  assert.equal(a.rpg.gold, 100, 'nothing moves on one confirmation');
  rt.act(b, 'trade.confirm', { tradeId: id, revision: rev });

  assert.equal(a.rpg.gold, 90);
  assert.equal(b.rpg.gold, 110);
  assert.equal(total([a], 'iron-longsword'), 0);
  assert.equal(total([b], 'iron-longsword'), 1);
  assert.equal(b.rpg.inventory.find((i) => i.template === 'iron-longsword').condition, 72, 'item state carried over');
  assert.equal(total([a], 'potion'), 3);
  assert.equal(total([b], 'potion'), 2);
  assert.deepEqual(
    { gold: gold([a, b]), sword: total([a, b], 'iron-longsword'), potion: total([a, b], 'potion') },
    before
  );
  // Both characters saved by the completing action.
  assert.equal(rt.saved.get(a.id).gold, 90);
  assert.equal(rt.saved.get(b.id).gold, 110);
  assert.equal(rt.social(a).trade, null);
  assert.match(rt.last(b).text, /Trade complete/);
  assert.equal(rt.emitted.filter((e) => e.name === 'trade').length, 1);
});

test('confirmations are tied to one revision; stale and repeated confirms settle at most once', () => {
  const rt = makeRuntime();
  const a = rt.join(1, 'Ada');
  const b = rt.join(2, 'Bram');
  const id = openTrade(rt, a, b);
  rt.act(a, 'trade.offer', { tradeId: id, gold: 50 });
  const rev = rt.social(a).trade.revision;
  rt.act(a, 'trade.confirm', { tradeId: id, revision: rev });
  // B changes their side after A confirmed: A's confirmation is void.
  rt.act(b, 'trade.offer', { tradeId: id, gold: 1 });
  assert.equal(rt.social(a).trade.mine.confirmed, false);
  assert.throws(() => rt.act(b, 'trade.confirm', { tradeId: id, revision: rev }), /changed/);
  const rev2 = rt.social(b).trade.revision;
  rt.act(b, 'trade.confirm', { tradeId: id, revision: rev2 });
  assert.equal(a.rpg.gold, 100, 'still waiting for A on the new revision');
  rt.act(a, 'trade.confirm', { tradeId: id, revision: rev2 });
  assert.deepEqual([a.rpg.gold, b.rpg.gold], [51, 149]);
  // A racing duplicate confirm from either side finds no trade.
  assert.throws(() => rt.act(b, 'trade.confirm', { tradeId: id, revision: rev2 }), /no longer open/);
  assert.throws(() => rt.act(a, 'trade.confirm', { tradeId: id, revision: rev2 }), /no longer open/);
  assert.deepEqual([a.rpg.gold, b.rpg.gold], [51, 149]);
});

test('no double spend: one trade per player, and offers revalidate against live state', () => {
  const rt = makeRuntime();
  const a = rt.join(1, 'Ada');
  const b = rt.join(2, 'Bram');
  const c = rt.join(3, 'Cyra');
  const id = openTrade(rt, a, b);
  assert.throws(() => rt.act(c, 'trade.request', { targetId: a.id }), /busy/);
  assert.throws(() => rt.act(a, 'trade.request', { targetId: c.id }), /current trade/);
  assert.throws(() => rt.act(a, 'trade.offer', { tradeId: id, gold: 101 }), /that much gold/);
  rt.act(a, 'trade.offer', { tradeId: id, gold: 100 });
  const rev = rt.social(a).trade.revision;
  rt.act(a, 'trade.confirm', { tradeId: id, revision: rev });
  // Gold leaves A's purse elsewhere (e.g. a shop) before B confirms.
  a.rpg.gold = 40;
  assert.throws(() => rt.act(b, 'trade.confirm', { tradeId: id, revision: rev }), /no longer open/);
  assert.match(rt.last(b).text, /offer changed/);
  assert.deepEqual([a.rpg.gold, b.rpg.gold], [40, 100]);
});

test('equipping an offered item, moving out of range or disconnecting cancels the trade', () => {
  const rt = makeRuntime();
  const a = rt.join(1, 'Ada');
  const b = rt.join(2, 'Bram');
  const sword = rt.give(a, 'iron-longsword');
  let id = openTrade(rt, a, b);
  rt.act(a, 'trade.offer', { tradeId: id, items: [{ id: sword.id }] });
  a.rpg.equipment.rightHand = sword.id;
  rt.tick();
  assert.equal(rt.social(b).trade, null);
  assert.match(rt.last(b).text, /Unequip/);
  assert.throws(() => rt.act(a, 'trade.confirm', { tradeId: id, revision: 3 }), /no longer open/);
  assert.equal(total([a], 'iron-longsword'), 1);

  // Equipped items cannot be offered in the first place.
  id = openTrade(rt, a, b);
  assert.throws(() => rt.act(a, 'trade.offer', { tradeId: id, items: [{ id: sword.id }] }), /Unequip/);
  b.x = 50;
  rt.tick();
  assert.equal(rt.social(a).trade, null);
  assert.match(rt.last(a).text, /too far/);

  b.x = 0;
  assert.throws(() => rt.act(a, 'trade.request', { targetId: 99 }), /not online/);
  b.rpg.location = 'town:Wayrest/Market';
  assert.throws(() => rt.act(a, 'trade.request', { targetId: b.id }), /no longer here/);
  b.rpg.location = a.rpg.location;
  id = openTrade(rt, a, b);
  rt.leave(b);
  assert.equal(rt.social(a).trade, null);
  assert.match(rt.last(a).text, /left/);
  assert.equal(rt.feature.trades.size, 0);
});

test('a pack change after confirmation resets confirmations', () => {
  const rt = makeRuntime();
  const a = rt.join(1, 'Ada');
  const b = rt.join(2, 'Bram');
  const id = openTrade(rt, a, b);
  rt.act(a, 'trade.offer', { tradeId: id, gold: 5 });
  const rev = rt.social(a).trade.revision;
  rt.act(b, 'trade.confirm', { tradeId: id, revision: rev });
  rt.give(b, 'potion', 1); // B's pack changes (loot, quest reward…)
  rt.tick();
  assert.equal(rt.social(a).trade.theirs.confirmed, false);
  assert.ok(rt.social(a).trade.revision > rev);
  assert.throws(() => rt.act(a, 'trade.confirm', { tradeId: id, revision: rev }), /changed/);
});

test('settlement failure rolls back both characters exactly', () => {
  const rt = makeRuntime();
  const a = rt.join(1, 'Ada');
  const b = rt.join(2, 'Bram');
  const sword = rt.give(a, 'iron-longsword');
  const potions = rt.give(b, 'potion', 4);
  const id = openTrade(rt, a, b);
  rt.act(a, 'trade.offer', { tradeId: id, items: [{ id: sword.id }], gold: 30 });
  rt.act(b, 'trade.offer', { tradeId: id, items: [{ id: potions.id, quantity: 2 }] });
  const rev = rt.social(a).trade.revision;
  rt.act(a, 'trade.confirm', { tradeId: id, revision: rev });
  const beforeA = structuredClone(a.rpg);
  const beforeB = structuredClone(b.rpg);
  const invA = a.rpg.inventory;
  const real = rt.services.giveItem;
  let calls = 0;
  rt.services.giveItem = (p, t, q) => {
    if (++calls === 2) throw new Error('storage fault');
    return real(p, t, q);
  };
  rt.saved.clear();
  assert.throws(() => rt.act(b, 'trade.confirm', { tradeId: id, revision: rev }), /storage fault/);
  assert.deepEqual(a.rpg, beforeA);
  assert.deepEqual(b.rpg, beforeB);
  assert.equal(a.rpg.inventory, invA, 'rolled back in place');
  assert.equal(rt.saved.size, 0, 'failed action saves nothing');
  const t = rt.feature.trades.get(id);
  assert.ok(t, 'trade stays open for another attempt');
  assert.equal(t.a.confirmed, rev);
  assert.equal(t.b.confirmed, 0, "the failed confirmation is not recorded");
  rt.services.giveItem = real;
  rt.act(b, 'trade.confirm', { tradeId: id, revision: rev });
  assert.equal(total([b], 'iron-longsword'), 1);
  assert.equal(a.rpg.gold + b.rpg.gold, 200);
});

test('invalid trade inputs are rejected with readable errors', () => {
  const rt = makeRuntime();
  const a = rt.join(1, 'Ada');
  const b = rt.join(2, 'Bram');
  const sword = rt.give(a, 'iron-longsword');
  a.rpg.inventory.push({ id: 'q1', template: 'letter', name: 'Sealed letter', quantity: 1, quest: 'q' });
  assert.throws(() => rt.act(a, 'trade.request', { targetId: a.id }), /yourself/);
  assert.throws(() => rt.act(a, 'trade.request', { targetId: 'nope' }), /Choose a player/);
  rt.act(a, 'trade.request', { targetId: b.id });
  const id = rt.social(a).trade.id;
  assert.throws(() => rt.act(a, 'trade.offer', { tradeId: id, gold: 1 }), /not been accepted/);
  assert.throws(() => rt.act(a, 'trade.accept', { tradeId: id }), /no trade request waiting/);
  rt.act(b, 'trade.accept', { tradeId: id });
  assert.throws(() => rt.act(a, 'trade.offer', { tradeId: 'trade_other', gold: 1 }), /no longer open/);
  for (const [args, re] of [
    [{ gold: -1 }, /whole number/],
    [{ gold: 1.5 }, /whole number/],
    [{ items: [{ id: sword.id, quantity: 2 }] }, /only have 1/],
    [{ items: [{ id: sword.id }, { id: sword.id }] }, /once/],
    [{ items: [{ id: 'ghost' }] }, /no longer in your pack/],
    [{ items: [{ id: 'q1' }] }, /cannot be traded/],
    [{ items: 'all' }, /list/],
  ]) {
    assert.throws(() => rt.act(a, 'trade.offer', { tradeId: id, ...args }), re);
  }
  assert.throws(() => rt.act(a, 'trade.confirm', { tradeId: id, revision: rt.social(a).trade.revision }), /Nothing has been offered/);
  rt.act(b, 'trade.decline', { tradeId: id });
  assert.equal(rt.social(a).trade, null);
});

test('trade requests expire', () => {
  const rt = makeRuntime();
  const a = rt.join(1, 'Ada');
  const b = rt.join(2, 'Bram');
  rt.act(a, 'trade.request', { targetId: b.id });
  const id = rt.social(b).trade.id;
  rt.tick(61_000);
  assert.throws(() => rt.act(b, 'trade.accept', { tradeId: id }), /no longer open/);
});

test('party, region and global chat honour membership, regions, mutes and rate limits', () => {
  const rt = makeRuntime({ muted: new Set([4]) });
  const a = rt.join(1, 'Ada');
  const b = rt.join(2, 'Bram');
  const c = rt.join(3, 'Cyra', { location: 'town:Wayrest/Market' });
  const m = rt.join(4, 'Mute');
  const chats = (p) => rt.events(p).filter((e) => e.kind === 'chat');
  assert.throws(() => rt.act(a, 'chat.send', { channel: 'party', text: 'hi' }), /not in a party/);
  rt.act(a, 'party.invite', { targetId: c.id });
  rt.act(c, 'party.accept', { fromId: a.id });
  rt.act(a, 'chat.send', { channel: 'party', text: 'to the party' });
  assert.equal(chats(c).at(-1).text, 'to the party');
  assert.equal(chats(b).length, 0);
  rt.act(a, 'chat.send', { channel: 'region', text: 'Daggerfall only' });
  assert.equal(chats(b).at(-1).region, 'Daggerfall');
  assert.equal(chats(c).at(-1).text, 'to the party');
  rt.act(b, 'chat.send', { channel: 'global', text: 'everyone' });
  for (const p of [a, b, c, m]) assert.equal(chats(p).at(-1).text, 'everyone');
  assert.throws(() => rt.act(m, 'chat.send', { channel: 'global', text: 'spam' }), /muted/);
  assert.throws(() => rt.act(a, 'chat.send', { channel: 'whisper', text: 'x' }), /Choose/);
  assert.throws(() => rt.act(a, 'chat.send', { channel: 'global', text: '  ' }), /empty/);
  // Shared runtime budget is respected.
  b.chatOk = () => false;
  assert.throws(() => rt.act(b, 'chat.send', { channel: 'global', text: 'x' }), /too fast/);
  // Our own bucket: burst of 5 per player, then refused.
  const d = rt.join(5, 'Dov');
  for (let i = 0; i < 5; i++) rt.act(d, 'chat.send', { channel: 'global', text: `m${i}` });
  assert.throws(() => rt.act(d, 'chat.send', { channel: 'global', text: 'm6' }), /too fast/);
});

test('kills are shared with nearby party members through a partyKill event', () => {
  const rt = makeRuntime();
  const a = rt.join(1, 'Ada');
  const b = rt.join(2, 'Bram');
  const c = rt.join(3, 'Cyra');
  rt.act(a, 'party.invite', { targetId: b.id });
  rt.act(b, 'party.accept', { fromId: a.id });
  rt.act(a, 'party.invite', { targetId: c.id });
  rt.act(c, 'party.accept', { fromId: a.id });
  c.x = 500;
  const credited = [];
  rt.services.creditKill = (p, e) => credited.push([p.id, e.id]);
  rt.ctx.emit('kill', { player: a, entity: { id: 'rat1', name: 'Rat' } });
  const shared = rt.emitted.filter((e) => e.name === 'partyKill');
  assert.deepEqual(shared.map((e) => e.payload.player.id), [2]);
  assert.deepEqual(credited, [[2, 'rat1']]);
  assert.match(rt.last(b).text, /Ada slew Rat/);
});
