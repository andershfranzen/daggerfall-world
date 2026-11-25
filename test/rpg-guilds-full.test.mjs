// Full Guilds functionality tests:
//   - Classic guild overview (rank, next-rank skill/rep/cooldown progress, unlocked/upcoming perks)
//   - Classic guild directory (6 families, 8 Temples, 10 Knightly Orders)
//   - Online fellow-member listing & variant isolation (Temples / Knightly Orders)
//   - Classic guild chat (fellow members only, mute & rate limits) and guild.resign
//   - Player-founded orders: create, unique name/tag, invite/accept/decline, promote/demote/kick/leave/disband,
//     leader succession, MOTD, shared treasury deposit/withdraw, transactional rollback on save failure,
//     order chat, compact `rpg.playerGuild` projection, and restart persistence via `world_state`.
//   - Client Guilds panel registration & event handling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { install as installGuilds } from '../server/rpg/guilds.js';
import { install as installGuildhall, PGUILD_PREFIX } from '../server/rpg/guildhall.js';
import { install as installGuildsClient } from '../client/gameplay/guilds.js';

const DAY = 1440;

function makeWorld({ minutes = 500 * DAY, worldMap = new Map(), savedPlayers = new Map(), failSave = () => false, foundingFee = 0 } = {}) {
  const players = new Map();
  const sent = [];
  let clockMinutes = minutes;
  let nowMs = 10_000;

  const runtime = createRpgRuntime({
    players,
    now: () => nowMs,
    services: {
      worldClock: () => ({ minutes: clockMinutes }),
    },
    worldStore: {
      load: (prefix) => [...worldMap.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)]),
    },
    save: (affected, worldRows = []) => {
      if (failSave()) throw new Error('simulated sqlite write failure');
      for (const p of affected) savedPlayers.set(p.id, structuredClone(p.rpg));
      for (const [k, v] of worldRows) {
        if (v === null) worldMap.delete(k);
        else worldMap.set(k, structuredClone(v));
      }
    },
    send: (p, msg) => sent.push({ to: p.id, msg }),
    features: [
      { name: 'guilds', install: (ctx) => installGuilds(ctx, { random: () => 0.5 }) },
      { name: 'guildhall', install: (ctx) => installGuildhall(ctx, { foundingFee }) },
    ],
  });

  function joinPlayer(id, name, { location = 'town:Daggerfall/Gothway Garden', gold = 1000, skills = {}, guilds = {}, factions = {}, muted = false } = {}) {
    const saved = savedPlayers.get(id);
    const p = {
      id,
      name,
      x: 0,
      z: 0,
      yaw: 0,
      muted,
      rpg: saved
        ? structuredClone(saved)
        : {
          location,
          gold,
          inventory: [],
          equipment: {},
          guilds,
          factions,
          character: { level: 5, health: 40, maxHealth: 40, skills },
        },
    };
    players.set(id, p);
    runtime.join(p);
    return p;
  }

  function eventsFor(playerId, kind = null) {
    return sent
      .filter((s) => s.to === playerId && s.msg.type === 'gameEvent' && (!kind || s.msg.event.kind === kind))
      .map((s) => s.msg.event);
  }

  function lastEvent(playerId, kind = null) {
    const list = eventsFor(playerId, kind);
    return list[list.length - 1] ?? null;
  }

  return {
    runtime,
    players,
    sent,
    worldMap,
    savedPlayers,
    joinPlayer,
    eventsFor,
    lastEvent,
    clearSent: () => { sent.length = 0; },
    advanceDays: (d) => { clockMinutes += d * DAY; },
    advanceMs: (ms) => { nowMs += ms; },
  };
}

// ---------------------------------------------------------------- classic guild overview & directory

test('guild.overview reports exact next-rank requirements, perks, cooldown, and online fellow members', () => {
  const w = makeWorld({ minutes: 510 * DAY });
  const alden = w.joinPlayer(1, 'Alden', {
    location: 'town:Daggerfall/Gothway Garden',
    skills: { 'Long Blade': 35, Axe: 12, Destruction: 40, Alteration: 20 },
    guilds: {
      fighters: { rank: 1, joinedAt: '2026-01-01T00:00:00.000Z', lastRankChange: 500 },
      temple: { rank: 2, variant: 26, joinedAt: '2026-01-02T00:00:00.000Z', lastRankChange: 480 }, // Akatosh
    },
    factions: { 41: 25, 26: 15 },
  });
  // Fellow Fighters Guild & Akatosh member
  w.joinPlayer(2, 'Bryn', {
    location: 'town:Wayrest/Wayrest',
    guilds: {
      fighters: { rank: 4, lastRankChange: 450 },
      temple: { rank: 1, variant: 26, lastRankChange: 450 },
    },
  });
  // Different temple (Arkay, 21) and non-fighter — must NOT appear in Alden's fellow lists
  w.joinPlayer(3, 'Cora', {
    location: 'town:Sentinel/Sentinel',
    guilds: {
      mages: { rank: 3, lastRankChange: 450 },
      temple: { rank: 5, variant: 21, lastRankChange: 450 },
    },
  });

  const res = w.runtime.act(alden, 'guild.overview', {});
  assert.equal(res.ok, true);
  const ev = w.lastEvent(alden.id, 'guild');
  assert.equal(ev.action, 'overview');
  assert.equal(ev.overview.memberships.length, 2);

  // Fighters Guild: rank 1 -> next rank 2 (req rep 20, high 31, low 9, cooldown 500+28-510 = 18d)
  const fg = ev.overview.memberships.find((m) => m.group === 'fighters');
  assert.equal(fg.rank, 1);
  assert.equal(fg.rankTitle, 'Shieldhand');
  assert.equal(fg.reputation, 25);
  assert.equal(fg.nextRank.maxRank, false);
  assert.equal(fg.nextRank.nextRank, 2);
  assert.equal(fg.nextRank.nextRankTitle, 'Blade');
  assert.deepEqual(fg.nextRank.reputation, { current: 25, required: 20, met: true });
  assert.deepEqual(fg.nextRank.topSkill, { name: 'Long Blade', current: 35, required: 31, met: true });
  assert.deepEqual(fg.nextRank.secondSkill, { name: 'Axe', current: 12, required: 9, met: true });
  assert.equal(fg.nextRank.cooldown.daysRemaining, 18);
  assert.equal(fg.nextRank.cooldown.met, false);
  assert.equal(fg.nextRank.ready, false);

  // Unlocked vs upcoming perks for Fighters Guild rank 1
  assert.ok(fg.privileges.unlocked.some((p) => p.id === 'rest'));
  assert.ok(fg.privileges.unlocked.some((p) => p.id === 'repair'));
  assert.ok(fg.privileges.upcoming.some((p) => p.id === 'hallAnytime' && p.rank === 6));

  // Online fellow members: Alden + Bryn only (not Cora)
  assert.deepEqual(fg.onlineMembers.map((m) => m.name), ['Alden', 'Bryn']);
  assert.equal(fg.onlineMembers[1].region, 'Wayrest');
  assert.equal(fg.onlineMembers[1].rankTitle, 'Banneret');

  // Temple of Akatosh: rank 2 -> next rank 3 (cooldown met: 510 >= 480 + 28), online fellows excludes Arkay priest Cora
  const tm = ev.overview.memberships.find((m) => m.group === 'temple');
  assert.equal(tm.variant, 26);
  assert.equal(tm.nextRank.cooldown.daysRemaining, 0);
  assert.equal(tm.nextRank.cooldown.met, true);
  assert.deepEqual(tm.onlineMembers.map((m) => m.name), ['Alden', 'Bryn']);

  // Advance 18 days: Fighters Guild becomes ready!
  w.advanceDays(18);
  w.runtime.act(alden, 'guild.overview', {});
  const fgAfter = w.lastEvent(alden.id, 'guild').overview.memberships.find((m) => m.group === 'fighters');
  assert.equal(fgAfter.nextRank.cooldown.daysRemaining, 0);
  assert.equal(fgAfter.nextRank.ready, true);
});

test('guild.directory returns all 6 families, 8 Temples, and 10 Knightly Orders', () => {
  const w = makeWorld();
  const p = w.joinPlayer(1, 'Scholar', {
    guilds: { knights: { rank: 3, variant: 368, lastRankChange: 400 } },
    factions: { 40: 12, 368: 34 },
  });
  const res = w.runtime.act(p, 'guild.directory', {});
  assert.equal(res.ok, true);
  const dir = w.lastEvent(p.id, 'guild').directory;
  assert.equal(dir.families.length, 6);
  assert.deepEqual(dir.families.map((f) => f.id), ['fighters', 'mages', 'thieves', 'brotherhood', 'temple', 'knights']);
  assert.equal(dir.families.find((f) => f.id === 'thieves').inviteOnly, true);
  assert.equal(dir.families.find((f) => f.id === 'brotherhood').inviteOnly, true);
  assert.equal(dir.families.find((f) => f.id === 'mages').reputation, 12);

  assert.equal(dir.temples.length, 8);
  assert.ok(dir.temples.every((t) => t.exclusive === true && t.deity && t.skills.length > 0));

  assert.equal(dir.orders.length, 10);
  const dragon = dir.orders.find((o) => o.factionId === 368);
  assert.equal(dragon.region, 'Daggerfall');
  assert.equal(dragon.member.rank, 3);
  assert.equal(dragon.reputation, 34);
});

test('classic guild.chat reaches only fellow members and respects mute & rate limits', () => {
  const w = makeWorld();
  const a = w.joinPlayer(1, 'Alden', { guilds: { mages: { rank: 2, lastRankChange: 400 }, temple: { rank: 1, variant: 26 } } });
  const b = w.joinPlayer(2, 'Bryn', { guilds: { mages: { rank: 5, lastRankChange: 400 }, temple: { rank: 1, variant: 21 } } });
  const c = w.joinPlayer(3, 'Cora', { guilds: { fighters: { rank: 1, lastRankChange: 400 } } });

  // Mages chat reaches Alden and Bryn, NOT Cora
  assert.equal(w.runtime.act(a, 'guild.chat', { scope: 'classic', group: 'mages', text: 'Meet at the guildhall.' }).ok, true);
  assert.equal(w.eventsFor(a.id, 'guildChat').length, 1);
  assert.equal(w.eventsFor(b.id, 'guildChat').length, 1);
  assert.equal(w.eventsFor(c.id, 'guildChat').length, 0);
  assert.equal(w.eventsFor(b.id, 'guildChat')[0].text, 'Meet at the guildhall.');

  // Temple of Akatosh chat reaches Alden ONLY (Bryn is Arkay, not Akatosh)
  w.clearSent();
  assert.equal(w.runtime.act(a, 'guild.chat', { scope: 'classic', group: 'temple', text: 'Time blesses us.' }).ok, true);
  assert.equal(w.eventsFor(a.id, 'guildChat').length, 1);
  assert.equal(w.eventsFor(b.id, 'guildChat').length, 0);

  // Non-member cannot send to a guild channel
  assert.equal(w.runtime.act(c, 'guild.chat', { scope: 'classic', group: 'mages', text: 'Sneaking in' }).ok, false);

  // Muted player cannot send guild chat
  a.muted = true;
  const mutedRes = w.runtime.act(a, 'guild.chat', { scope: 'classic', group: 'mages', text: 'Muted' });
  assert.equal(mutedRes.ok, false);
  assert.match(mutedRes.error, /muted/i);
  a.muted = false;

  // Rate limit triggers after burst (5)
  let throttled = false;
  for (let i = 0; i < 8; i++) {
    const r = w.runtime.act(b, 'guild.chat', { scope: 'classic', group: 'mages', text: `Spam ${i}` });
    if (!r.ok) { throttled = true; assert.match(r.error, /too fast/i); break; }
  }
  assert.equal(throttled, true);
});

test('guild.resign cleanly removes classic membership and persists', () => {
  const w = makeWorld();
  const a = w.joinPlayer(1, 'Alden', { guilds: { fighters: { rank: 2, lastRankChange: 400 } } });
  const r = w.runtime.act(a, 'guild.resign', { group: 'fighters' });
  assert.equal(r.ok, true);
  assert.equal(a.rpg.guilds.fighters, undefined);
  assert.equal(w.savedPlayers.get(1).guilds.fighters, undefined);
  assert.equal(w.lastEvent(a.id, 'guild').overview.memberships.length, 0);

  // Resigning again fails cleanly
  assert.equal(w.runtime.act(a, 'guild.resign', { group: 'fighters' }).ok, false);
});

// ---------------------------------------------------------------- player-founded orders full lifecycle

test('player-founded order lifecycle: create, uniqueness, invite/accept/decline, ranks, kick, MOTD, chat, leave/succession, disband', () => {
  const w = makeWorld();
  const alice = w.joinPlayer(1, 'Alice', { gold: 500 });
  const bob = w.joinPlayer(2, 'Bob', { gold: 500 });
  const cara = w.joinPlayer(3, 'Cara', { gold: 500 });
  const dave = w.joinPlayer(4, 'Dave', { gold: 500 });

  // Create order
  assert.equal(w.runtime.act(alice, 'order.create', { name: 'Silver Wolves', tag: 'wolf', motd: 'Guard the bay.' }).ok, true);
  assert.deepEqual(alice.rpg.playerGuild, { id: alice.rpg.playerGuild.id, name: 'Silver Wolves', tag: 'WOLF', rank: 'Leader' });
  const orderId = alice.rpg.playerGuild.id;
  assert.ok(w.worldMap.has(`${PGUILD_PREFIX}${orderId}`));

  // Unique name & tag guards (case-insensitive)
  assert.equal(w.runtime.act(bob, 'order.create', { name: 'silver wolves', tag: 'NEW' }).ok, false);
  assert.equal(w.runtime.act(bob, 'order.create', { name: 'Iron Hawks', tag: 'WOLF' }).ok, false);

  // Invite Bob & Cara; Bob accepts, Cara declines
  assert.equal(w.runtime.act(alice, 'order.invite', { targetId: bob.id }).ok, true);
  assert.equal(w.runtime.act(alice, 'order.invite', { targetId: cara.id }).ok, true);
  assert.equal(w.runtime.act(bob, 'order.accept', { orderId }).ok, true);
  assert.equal(bob.rpg.playerGuild.rank, 'Member');
  assert.equal(w.runtime.act(cara, 'order.decline', { orderId }).ok, true);
  assert.equal(cara.rpg.playerGuild, undefined);

  // Member cannot invite or edit MOTD
  assert.equal(w.runtime.act(bob, 'order.invite', { targetId: dave.id }).ok, false);
  assert.equal(w.runtime.act(bob, 'order.motd', { motd: 'Mutiny!' }).ok, false);

  // Promote Bob -> Officer; now Bob can invite Dave and edit MOTD
  assert.equal(w.runtime.act(alice, 'order.promote', { targetId: bob.id }).ok, true);
  assert.equal(bob.rpg.playerGuild.rank, 'Officer');
  assert.equal(w.runtime.act(bob, 'order.motd', { motd: 'Rally at Wayrest.' }).ok, true);
  assert.equal(w.worldMap.get(`${PGUILD_PREFIX}${orderId}`).motd, 'Rally at Wayrest.');

  assert.equal(w.runtime.act(bob, 'order.invite', { targetId: dave.id }).ok, true);
  assert.equal(w.runtime.act(dave, 'order.accept', { orderId }).ok, true);
  assert.equal(dave.rpg.playerGuild.rank, 'Member');

  // Order chat reaches Alice, Bob, Dave — NOT Cara
  w.clearSent();
  assert.equal(w.runtime.act(bob, 'guild.chat', { scope: 'order', text: 'For the Wolves!' }).ok, true);
  assert.equal(w.eventsFor(alice.id, 'guildChat').length, 1);
  assert.equal(w.eventsFor(bob.id, 'guildChat').length, 1);
  assert.equal(w.eventsFor(dave.id, 'guildChat').length, 1);
  assert.equal(w.eventsFor(cara.id, 'guildChat').length, 0);

  // Officer Bob can kick Member Dave, but cannot kick Leader Alice
  assert.equal(w.runtime.act(bob, 'order.kick', { targetId: alice.id }).ok, false);
  assert.equal(w.runtime.act(bob, 'order.kick', { targetId: dave.id }).ok, true);
  assert.equal(dave.rpg.playerGuild, undefined);

  // Demote Bob -> Member, then re-promote to Officer
  assert.equal(w.runtime.act(alice, 'order.demote', { targetId: bob.id }).ok, true);
  assert.equal(bob.rpg.playerGuild.rank, 'Member');
  assert.equal(w.runtime.act(alice, 'order.promote', { targetId: bob.id }).ok, true);
  assert.equal(bob.rpg.playerGuild.rank, 'Officer');

  // Leader Alice leaves -> Officer Bob succeeds as Leader!
  assert.equal(w.runtime.act(alice, 'order.leave', {}).ok, true);
  assert.equal(alice.rpg.playerGuild, undefined);
  assert.equal(bob.rpg.playerGuild.rank, 'Leader');
  assert.equal(w.worldMap.get(`${PGUILD_PREFIX}${orderId}`).leaderId, bob.id);

  // Bob disbands -> world_state row deleted and tag freed
  assert.equal(w.runtime.act(bob, 'order.disband', {}).ok, true);
  assert.equal(bob.rpg.playerGuild, undefined);
  assert.equal(w.worldMap.has(`${PGUILD_PREFIX}${orderId}`), false);
  // Freed name/tag can now be created again
  assert.equal(w.runtime.act(cara, 'order.create', { name: 'Silver Wolves', tag: 'WOLF' }).ok, true);
});

test('shared treasury deposit/withdraw enforces permissions, balances, and rolls back atomically on save failure', () => {
  let shouldFail = false;
  const w = makeWorld({ failSave: () => shouldFail });
  const leader = w.joinPlayer(1, 'Leader', { gold: 1000 });
  const member = w.joinPlayer(2, 'Member', { gold: 400 });

  assert.equal(w.runtime.act(leader, 'order.create', { name: 'Gold Guard', tag: 'GOLD' }).ok, true);
  const orderId = leader.rpg.playerGuild.id;
  assert.equal(w.runtime.act(leader, 'order.invite', { targetId: member.id }).ok, true);
  assert.equal(w.runtime.act(member, 'order.accept', { orderId }).ok, true);

  // Member can deposit 150g
  assert.equal(w.runtime.act(member, 'order.deposit', { amount: 150 }).ok, true);
  assert.equal(member.rpg.gold, 250);
  assert.equal(w.worldMap.get(`${PGUILD_PREFIX}${orderId}`).treasury, 150);

  // Insufficient player gold rejected cleanly
  assert.equal(w.runtime.act(member, 'order.deposit', { amount: 9999 }).ok, false);
  assert.equal(member.rpg.gold, 250);
  assert.equal(w.worldMap.get(`${PGUILD_PREFIX}${orderId}`).treasury, 150);

  // Regular Member cannot withdraw
  assert.equal(w.runtime.act(member, 'order.withdraw', { amount: 50 }).ok, false);
  assert.equal(member.rpg.gold, 250);
  assert.equal(w.worldMap.get(`${PGUILD_PREFIX}${orderId}`).treasury, 150);

  // Leader cannot withdraw more than treasury holds
  assert.equal(w.runtime.act(leader, 'order.withdraw', { amount: 500 }).ok, false);
  assert.equal(leader.rpg.gold, 1000);
  assert.equal(w.worldMap.get(`${PGUILD_PREFIX}${orderId}`).treasury, 150);

  // Atomic rollback on simulated DB save failure during deposit
  shouldFail = true;
  const failDep = w.runtime.act(leader, 'order.deposit', { amount: 200 });
  assert.equal(failDep.ok, false);
  assert.equal(leader.rpg.gold, 1000, 'leader gold rolled back');
  assert.equal(w.worldMap.get(`${PGUILD_PREFIX}${orderId}`).treasury, 150, 'world_state treasury untouched');
  shouldFail = false;

  // Verify in-memory treasury also rolled back (overview still shows 150, not 350)
  w.runtime.act(leader, 'guild.overview', {});
  assert.equal(w.lastEvent(leader.id, 'guild').overview.order.treasury, 150);

  // Atomic rollback on simulated DB save failure during withdraw
  shouldFail = true;
  const failWith = w.runtime.act(leader, 'order.withdraw', { amount: 100 });
  assert.equal(failWith.ok, false);
  assert.equal(leader.rpg.gold, 1000);
  assert.equal(w.worldMap.get(`${PGUILD_PREFIX}${orderId}`).treasury, 150);
  shouldFail = false;

  // Successful withdraw after recovery
  assert.equal(w.runtime.act(leader, 'order.withdraw', { amount: 100 }).ok, true);
  assert.equal(leader.rpg.gold, 1100);
  assert.equal(w.worldMap.get(`${PGUILD_PREFIX}${orderId}`).treasury, 50);
});

test('player-founded order persists fully across server restart via world_state', () => {
  const worldMap = new Map();
  const savedPlayers = new Map();

  // First server boot
  const w1 = makeWorld({ worldMap, savedPlayers });
  const a1 = w1.joinPlayer(1, 'Alden', { gold: 800 });
  const b1 = w1.joinPlayer(2, 'Bryn', { gold: 600 });
  assert.equal(w1.runtime.act(a1, 'order.create', { name: 'Dawn Watch', tag: 'DAWN', motd: 'Hold the wall.' }).ok, true);
  const orderId = a1.rpg.playerGuild.id;
  assert.equal(w1.runtime.act(a1, 'order.invite', { targetId: b1.id }).ok, true);
  assert.equal(w1.runtime.act(b1, 'order.accept', { orderId }).ok, true);
  assert.equal(w1.runtime.act(a1, 'order.promote', { targetId: b1.id }).ok, true);
  assert.equal(w1.runtime.act(b1, 'order.deposit', { amount: 250 }).ok, true);

  // Second server boot (fresh runtime, same persisted world_state & player saves)
  const w2 = makeWorld({ worldMap, savedPlayers });
  const a2 = w2.joinPlayer(1, 'Alden');
  const b2 = w2.joinPlayer(2, 'Bryn');

  assert.deepEqual(a2.rpg.playerGuild, { id: orderId, name: 'Dawn Watch', tag: 'DAWN', rank: 'Leader' });
  assert.deepEqual(b2.rpg.playerGuild, { id: orderId, name: 'Dawn Watch', tag: 'DAWN', rank: 'Officer' });

  w2.runtime.act(a2, 'guild.overview', {});
  const ord = w2.lastEvent(a2.id, 'guild').overview.order;
  assert.equal(ord.name, 'Dawn Watch');
  assert.equal(ord.tag, 'DAWN');
  assert.equal(ord.motd, 'Hold the wall.');
  assert.equal(ord.treasury, 250);
  assert.equal(ord.members.length, 2);
  assert.equal(ord.ledger.length, 1);

  // Uniqueness index was rebuilt on restart
  const c2 = w2.joinPlayer(3, 'Cora');
  assert.equal(w2.runtime.act(c2, 'order.create', { name: 'Dawn Watch', tag: 'NEW' }).ok, false);
  assert.equal(w2.runtime.act(c2, 'order.create', { name: 'Other Order', tag: 'DAWN' }).ok, false);
});

test('client guilds panel registers cleanly and tracks guild/chat events', () => {
  const listeners = new Map();
  const panels = new Map();
  const actions = [];
  const messages = [];
  const mockApi = {
    state: { selfId: 1 },
    panel: null,
    on: (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
    },
    act: (verb, args) => actions.push({ verb, args }),
    message: (text) => messages.push(text),
    registerPanel: (id, title, render) => panels.set(id, { id, title, render }),
    refreshPanel: () => {},
  };

  const { ui } = installGuildsClient(mockApi);
  assert.ok(panels.has('guilds'));
  assert.equal(panels.get('guilds').title, 'Guilds');

  // Opening the panel requests overview & directory
  for (const fn of listeners.get('panel') ?? []) fn({ id: 'guilds', open: true });
  assert.ok(actions.some((a) => a.verb === 'guild.overview'));
  assert.ok(actions.some((a) => a.verb === 'guild.directory'));

  // Receiving guild & guildChat events updates ui state cleanly
  for (const fn of listeners.get('event') ?? []) {
    fn({ kind: 'guild', action: 'overview', text: 'Updated.', overview: { day: 500, gold: 100, foundingFee: 0, memberships: [], order: null, orderInvites: [], onlinePlayers: [] } });
    fn({ kind: 'guildChat', scope: 'order', orderId: 'pg_1', tag: 'WOLF', channelName: '[WOLF] Silver Wolves', fromId: 2, name: 'Bryn', rankTitle: 'Officer', text: 'Hello!' });
  }
  assert.equal(ui.overview.day, 500);
  assert.equal(ui.chatLogs.get('order').length, 1);
  assert.equal(messages[0], 'Updated.');
});
