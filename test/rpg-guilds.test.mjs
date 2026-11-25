// Package 15: guild/temple/order standing, rank gates, advancement timing, expulsion, secret recruitment,
// hall access/rest for exactly the right hall, temple services and restart persistence.
// Fixture: a stand-in runtime (as test/rpg-npcs.test.mjs) with source-shaped hall staff placed by the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install as installNpcs } from '../server/rpg/npcs.js';
import { install as installGuilds } from '../server/rpg/guilds.js';
import {
  DIVINES, GROUPS, cureCost, donationRaises, eligibility, factionTable, groupOfFaction, hallAccessAnytime,
  newRank, privileges, rankFor, rankUpdate, reputationChanges, serviceAccess, canRest,
} from '../server/rpg/guilds/rules.js';
import { tradePrice } from '../client/gameplay/economy/rules.js';

const HOME = 'interior:Daggerfall/Daggerfall/1,2/3';
const DAY = 1440;

function makeCtx({ minutes = 1000 * DAY, roll = 0 } = {}) {
  const handlers = { join: [], leave: [], tick: [], actions: new Map(), events: new Map() };
  let now = 1000;
  const clock = { minutes };
  const ctx = {
    players: new Map(), entities: new Map(), services: {}, notes: [], emitted: [], dirtied: new Set(), clock,
    onJoin: (fn) => handlers.join.push(fn), onLeave: (fn) => handlers.leave.push(fn), onTick: (fn) => handlers.tick.push(fn),
    onAction: (verb, fn) => handlers.actions.set(verb, fn),
    on: (n, fn) => { if (!handlers.events.has(n)) handlers.events.set(n, []); handlers.events.get(n).push(fn); },
    emit: (n, payload) => { ctx.emitted.push({ name: n, payload }); for (const fn of handlers.events.get(n) || []) fn(payload); },
    notify: (p, ev) => ctx.notes.push({ to: p.id, ev }),
    dirty: (p) => ctx.dirtied.add(p.id),
    now: () => now,
    advance: (ms) => { now += ms; for (const fn of handlers.tick) fn(ms / 1000, now); },
  };
  ctx.services.worldClock = () => ({ minutes: clock.minutes });
  let seq = 0;
  ctx.services.giveItem = (p, template, quantity = 1) => p.rpg.inventory.push({ id: `i${++seq}`, template, name: template, quantity });
  ctx.act = (p, verb, args) => handlers.actions.get(verb)(p, args);
  ctx.join = (p) => { ctx.players.set(p.id, p); for (const fn of handlers.join) fn(p); };
  installNpcs(ctx);
  installGuilds(ctx, { random: () => roll });
  return ctx;
}

let pid = 0;
function player(skills = {}, rpg = {}) {
  return {
    id: ++pid, name: `Hero${pid}`, x: 0, z: 0,
    rpg: {
      location: HOME, gold: 5000, inventory: [], equipment: {},
      character: { level: 3, health: 10, maxHealth: 40, magicka: 0, maxMagicka: 20, skills: { 'Long Blade': 30, Axe: 10, ...skills } },
      ...rpg,
    },
  };
}

/** A hall person shaped like server/rpg/npcs/people.js output. */
function staff(ctx, id, { role, guild, services, hall, npcFaction, quality = 10 }) {
  const e = {
    id, kind: 'npc', role, guild, title: role, name: `Staff ${id}`, location: HOME, x: 0, z: 0, faction: npcFaction ?? hall,
    services, sourced: true, reach: 3, building: { type: 11, factionId: hall, quality }, _source: { factionId: npcFaction ?? hall },
  };
  ctx.entities.set(id, e);
  return e;
}
const talk = (ctx, p, e) => ctx.act(p, 'npc.talk', { targetId: e.id });
const serve = (ctx, p, e, service, extra = {}) => {
  const v = talk(ctx, p, e);
  return ctx.act(p, 'npc.service', { targetId: e.id, session: v.session, service, ...extra });
};

// ------------------------------------------------------------------------------------------- pure rules

test('rank gates follow the classic guild classes', () => {
  assert.deepEqual(serviceAccess('mages', null, null, 'teleport'), { ok: false, reason: 'members', minRank: 8 });
  assert.equal(serviceAccess('mages', null, 7, 'teleport').reason, 'rank');
  assert.ok(serviceAccess('mages', null, 8, 'teleport').ok);
  assert.equal(rankFor('mages', null, 'magicItems'), 3);
  assert.equal(rankFor('mages', null, 'library'), 2);
  assert.equal(rankFor('thieves', null, 'spymaster'), 4);
  assert.equal(rankFor('brotherhood', null, 'soulgems'), 5);
  // Temples: each deity has its own thresholds; open services need no membership.
  assert.equal(rankFor('temple', 35, 'makeSpells'), 6, 'Kynareth Spell Maker at rank 6');
  assert.equal(rankFor('temple', 22, 'summon'), 8, 'Zenithar summoning at rank 8');
  assert.equal(rankFor('temple', 26, 'makeSpells'), null, 'Akatosh has no Spell Maker');
  assert.ok(serviceAccess('temple', 26, null, 'cure').ok && serviceAccess('temple', 26, null, 'donate').ok);
  assert.ok(serviceAccess('knights', 368, 0, 'armor').ok && !serviceAccess('knights', 368, null, 'armor').ok);
  assert.ok(hallAccessAnytime('fighters', 6) && !hallAccessAnytime('fighters', 5) && hallAccessAnytime('thieves', 0));
  assert.ok(canRest('fighters', 0) && !canRest('mages', 9) && !canRest('fighters', -1));
  assert.deepEqual(privileges('mages', null, 3).sort(), ['library', 'magicItems', 'makeSpells', 'train'].sort());
});

test('eligibility, rank, demotion, expulsion and the 28-day rule', () => {
  const c = { skills: { 'Long Blade': 30, Axe: 10 } };
  assert.ok(eligibility(c, 'fighters', null, 0).ok);
  assert.equal(eligibility(c, 'fighters', null, -1).reason, 'reputation');
  assert.equal(eligibility(c, 'mages', null, 0).reason, 'skills');
  assert.equal(eligibility({ skills: { Archery: 30, Climbing: 10 } }, 'temple', 35, 0).ok, true, 'Kynareth skills');
  assert.equal(eligibility({ skills: { Archery: 30, Climbing: 10 } }, 'temple', 21, 0).ok, false, 'not Arkay skills');
  assert.equal(newRank(c, 'fighters', null, 15), 1);
  assert.equal(newRank(c, 'fighters', null, -1), -1, 'expelled');
  assert.equal(newRank(c, 'thieves', null, -50), 0, 'the Thieves Guild never expels');
  const m = { rank: 0, lastRankChange: 100 };
  assert.equal(rankUpdate(m, c, 'fighters', 15, 127).change, null, 'not before 28 days');
  assert.equal(rankUpdate(m, c, 'fighters', 15, 128).change, 'promotion');
  assert.equal(rankUpdate({ rank: 1, lastRankChange: 0 }, c, 'fighters', 5, 28).change, 'demotion');
  assert.equal(rankUpdate({ rank: 1, lastRankChange: 0 }, c, 'fighters', -3, 28).change, 'expulsion');
});

test('prices, donations and reputation propagation', () => {
  assert.equal(cureCost(2, 'temple', 26, 9, 10), 1000, '250 × 2 at quality 10 doubles');
  assert.equal(cureCost(1, 'temple', 21, 5, 10), 250, 'Arkay rank 5 halves the base');
  assert.ok(donationRaises(100, 0, 99.9) && !donationRaises(100, 50, 5) && donationRaises(100, 50, 4.9));
  const t = factionTable(null);
  assert.equal(groupOfFaction(t, 92), 'temple');
  assert.equal(groupOfFaction(t, 510), null, 'shops are not Fighters Guild halls');
  assert.equal(groupOfFaction(t, 368), 'knights');
  const ch = new Map(reputationChanges(t, 92, 4, true));
  assert.equal(ch.get(92), 4, 'the questor faction moves fully');
  assert.equal(ch.get(26), 4, 'and its root deity');
  assert.ok(ch.has(450), 'deities also move the generic temple');
});

// ------------------------------------------------------------------------------------------- in conversation

test('temple membership is per deity: join at Kynareth, a stranger at Arkay; free healing by rank', () => {
  const ctx = makeCtx();
  const ky = staff(ctx, 'ky', { role: 'priest', guild: 'temple', services: ['join', 'train'], hall: 36, npcFaction: 254 });
  const kyHeal = staff(ctx, 'kyh', { role: 'priest', guild: 'temple', services: ['heal', 'cure'], hall: 36, npcFaction: 813 });
  const ar = staff(ctx, 'ar', { role: 'priest', guild: 'temple', services: ['join', 'train'], hall: 82, npcFaction: 241 });
  const p = player({ Archery: 30, Climbing: 10 });
  ctx.join(p);
  let v = serve(ctx, p, ky, 'join');
  assert.match(v.text, /Welcome to Temple of Kynareth/);
  assert.deepEqual({ rank: p.rpg.guilds.temple.rank, variant: p.rpg.guilds.temple.variant }, { rank: 0, variant: 35 });
  assert.equal(v.guild.member, true);
  assert.ok(v.guild.training.length === 0 || v.guild.training.every((t) => DIVINES[35].training.includes(t.skill)));
  // A different temple: not a member there, and joining a second temple is refused.
  v = talk(ctx, p, ar);
  assert.equal(v.guild.member, false);
  assert.equal(v.guild.memberElsewhere, 'Temple of Kynareth');
  v = serve(ctx, p, ar, 'join');
  assert.match(v.text, /already serve Temple of Kynareth/);
  assert.equal(p.rpg.guilds.temple.variant, 35);
  // Kynareth heals members for free only from rank 1.
  assert.equal(talk(ctx, p, kyHeal).services.find((s) => s.id === 'heal').cost, 60);
  p.rpg.guilds.temple.rank = 1;
  v = talk(ctx, p, kyHeal);
  assert.match(v.text, /tend your wounds/);
  assert.equal(p.rpg.character.health, 40);
  assert.equal(ctx.services.templeRank(p, 35), 1);
  assert.equal(ctx.services.templeRank(p, 21), null);
  assert.equal(ctx.services.guildRank(p, 'temple', { factionId: 82 }), null);
});

test('rank-gated specialists refuse non-members and low ranks, then hand over to the owning feature', () => {
  const ctx = makeCtx();
  const calls = [];
  ctx.services.npcServiceHandlers = { teleport: (p, info) => { calls.push(info); return 'The portal opens.'; } };
  const trainer = staff(ctx, 'mgt', { role: 'mages', guild: 'mages', services: ['join', 'train'], hall: 40, npcFaction: 61 });
  const porter = staff(ctx, 'mgp', { role: 'mages', guild: 'mages', services: ['teleport'], hall: 40, npcFaction: 62 });
  const p = player({ Destruction: 30, Alteration: 10 });
  ctx.join(p);
  let v = talk(ctx, p, porter);
  assert.deepEqual(v.services.map((s) => [s.id, !!s.locked]), [['teleport', true]]);
  v = serve(ctx, p, porter, 'teleport');
  assert.match(v.text, /for members of The Mages Guild only|members of .* only/);
  serve(ctx, p, trainer, 'join');
  v = serve(ctx, p, porter, 'teleport');
  assert.match(v.text, /not risen high enough .* Loremaster/);
  assert.equal(calls.length, 0);
  p.rpg.guilds.mages.rank = 8;
  v = serve(ctx, p, porter, 'teleport');
  assert.equal(v.text, 'The portal opens.');
  assert.equal(calls[0].rank, 8);
  // Follow-up actions validate the same way.
  const s = talk(ctx, p, porter).session;
  assert.equal(ctx.services.requireNpcService(p, { targetId: porter.id, session: s }, 'teleport').rank, 8);
  p.rpg.guilds.mages.rank = 2;
  assert.throws(() => ctx.services.requireNpcService(p, { targetId: porter.id, session: s }, 'teleport'), /not risen high enough/);
});

test('promotion waits 28 days, expulsion removes a member, the Thieves Guild only demotes to its lowest rank', () => {
  const ctx = makeCtx();
  const fg = staff(ctx, 'fg', { role: 'fighters', guild: 'fighters', services: ['join', 'train'], hall: 41, npcFaction: 849 });
  const p = player();
  ctx.join(p);
  serve(ctx, p, fg, 'join');
  ctx.services.adjustReputation(p, 41, 14);
  assert.doesNotMatch(talk(ctx, p, fg).text, /From today/, 'too soon after joining');
  assert.equal(p.rpg.guilds.fighters.rank, 0);
  ctx.clock.minutes += 28 * DAY;
  assert.match(talk(ctx, p, fg).text, /From today you are Shieldhand/);
  assert.equal(p.rpg.guilds.fighters.rank, 1);
  ctx.services.adjustReputation(p, 41, -40);
  ctx.clock.minutes += 27 * DAY;
  talk(ctx, p, fg);
  assert.equal(p.rpg.guilds.fighters?.rank, 1, 'rank change also waits after a promotion');
  ctx.clock.minutes += DAY;
  assert.match(talk(ctx, p, fg).text, /no longer one of us/);
  assert.equal(p.rpg.guilds.fighters, undefined);
  assert.ok(ctx.emitted.some((x) => x.name === 'guildExpelled'));
  // Thieves Guild: negative standing leaves the member at rank 0.
  ctx.services.guilds.addMembership(p, 'thieves', null, 3);
  ctx.services.adjustReputation(p, 42, -20);
  ctx.clock.minutes += 28 * DAY;
  const tg = staff(ctx, 'tg', { role: 'thieves', guild: 'thieves', services: ['join', 'train'], hall: 42, npcFaction: 803 });
  talk(ctx, p, tg);
  assert.equal(p.rpg.guilds.thieves.rank, 0);
});

test('hall access and rest honour the exact hall (package 2/20 hooks)', () => {
  const ctx = makeCtx();
  const p = player();
  ctx.join(p);
  const hall = (factionId, buildingType = 11) => ({ kind: 'building', meta: { factionId, buildingType } });
  const G = ctx.services.guilds;
  assert.equal(ctx.services.guildHallAccess(p, hall(41)), false);
  G.addMembership(p, 'fighters', null, 5);
  assert.equal(ctx.services.guildHallAccess(p, hall(41)), false, 'Fighters Guild halls open after hours from rank 6');
  assert.equal(ctx.services.guildCanRest(p, hall(41)), true);
  assert.equal(ctx.services.guildCanRest(p, hall(41, 15)), false, 'taverns carry the guild faction but are never guild rest');
  assert.equal(ctx.services.guildCanRest(p, hall(510)), false, 'shops are not halls');
  p.rpg.guilds.fighters.rank = 6;
  assert.equal(ctx.services.guildHallAccess(p, hall(41)), true);
  assert.equal(ctx.services.guildHallAccess(p, hall(40)), false, 'not the Mages Guild');
  G.addMembership(p, 'brotherhood', null, 0);
  assert.equal(ctx.services.guildHallAccess(p, hall(108, 18)), true, 'secret halls admit members at any hour');
  assert.equal(ctx.services.guildCanRest(p, hall(108, 18)), false);
  // Location form (package 20): the staff's building identifies the hall.
  staff(ctx, 'fgx', { role: 'fighters', guild: 'fighters', services: [], hall: 41 });
  assert.equal(ctx.services.guildCanRest(p, HOME), true);
});

test('secret recruitment: package 19’s invitation event, then membership when the initiation succeeds', () => {
  const ctx = makeCtx();
  const p = player({}, { location: 'town:Daggerfall/Daggerfall' });
  ctx.join(p);
  ctx.emit('guildInvite', { player: p, guild: 'thieves', quest: 'O0A0AL00', started: true });
  assert.deepEqual(p.rpg.guildInvites.thieves, { tally: 0, letterAt: 0, sent: true });
  assert.ok(!ctx.notes.some((n) => /A letter/.test(n.ev.title ?? '')), 'the quest itself carries the letter');
  assert.equal(ctx.services.guildRank(p, 'thieves'), null);
  ctx.emit('questComplete', { player: p, quest: { name: 'O0A0AL00' } });
  assert.equal(p.rpg.guilds.thieves.rank, 0);
  assert.equal(ctx.services.guildRank(p, 'darkBrotherhood'), null);
  ctx.emit('questComplete', { player: p, quest: { name: 'L0A01L00' } });
  assert.equal(ctx.services.guildRank(p, 'darkBrotherhood'), 0, 'package 14 alias');
  ctx.emit('questComplete', { player: p, quest: { name: 'O0A0AL00' } });
  assert.equal(p.rpg.guilds.thieves.rank, 0, 'once');
});

test('without the initiation quest the letter itself invites; walk-ins are turned away', () => {
  const ctx = makeCtx();
  const tg = staff(ctx, 'tg', { role: 'thieves', guild: 'thieves', services: ['join', 'train'], hall: 42, npcFaction: 803 });
  const p = player({ Stealth: 30, Lockpicking: 10 });
  ctx.join(p);
  let v = talk(ctx, p, tg);
  assert.ok(!v.services.some((s) => s.id === 'join'), 'no join for a stranger');
  assert.match(ctx.act(p, 'npc.service', { targetId: tg.id, session: v.session, service: 'join' }).text, /nothing here to join/);
  ctx.emit('guildInvite', { player: p, guild: 'thieves', quest: 'O0A0AL00', started: false });
  assert.ok(ctx.notes.some((n) => n.to === p.id && /talents have been noticed/.test(n.ev.text ?? '')));
  v = talk(ctx, p, tg);
  assert.ok(v.services.some((s) => s.id === 'join'));
  v = ctx.act(p, 'npc.service', { targetId: tg.id, session: v.session, service: 'join' });
  assert.match(v.text, /Welcome to The Thieves Guild/);
});

test('knightly orders: join at the questor, one armour piece per rank at the smith', () => {
  const ctx = makeCtx();
  const q = staff(ctx, 'ko', { role: 'knights', guild: 'knights', services: ['join'], hall: 368, npcFaction: 846 });
  const smith = staff(ctx, 'ks', { role: 'knights', guild: 'knights', services: ['armor'], hall: 368, npcFaction: 845 });
  const other = staff(ctx, 'ks2', { role: 'knights', guild: 'knights', services: ['armor'], hall: 409, npcFaction: 845 });
  const p = player({ Etiquette: 30, Medical: 10 });
  ctx.join(p);
  assert.match(serve(ctx, p, smith, 'armor').text, /members of The Knights of the Dragon only/);
  assert.match(serve(ctx, p, q, 'join').text, /Welcome to The Knights of the Dragon/);
  assert.match(serve(ctx, p, other, 'armor').text, /members of The Knights of the Rose only/, 'another order');
  let v = serve(ctx, p, smith, 'armor');
  assert.ok(v.armorOffer.length >= 3 && v.armorOffer.every((o) => o.template.startsWith('iron-')));
  v = serve(ctx, p, smith, 'armor', { piece: 'helm' });
  assert.match(v.text, /iron helm/);
  assert.equal(p.rpg.inventory.at(-1).template, 'iron-helm');
  assert.match(serve(ctx, p, smith, 'armor', { piece: 'boots' }).text, /already drawn/);
  assert.equal(ctx.services.guilds.freeTavernRoom(p, 17), true, 'free rooms in the order’s home region');
  assert.equal(ctx.services.guilds.freeTavernRoom(p, 5), false);
});

test('donation keeps the 100-gold offering; cures charge by count, rank, quality and holiday', () => {
  const ctx = makeCtx({ roll: 0.5 });
  const tr = staff(ctx, 'tr', { role: 'priest', guild: 'temple', services: ['donate'], hall: 92, npcFaction: 810 });
  const he = staff(ctx, 'he', { role: 'priest', guild: 'temple', services: ['heal', 'cure'], hall: 92, npcFaction: 813, quality: 15 });
  let diseases = 2;
  ctx.services.conditionCount = () => diseases;
  ctx.services.cureCondition = () => { const n = diseases; diseases = 0; return n; };
  const p = player();
  ctx.join(p);
  serve(ctx, p, tr, 'donate');
  assert.equal(p.rpg.gold, 4900);
  assert.equal(ctx.services.reputation(p, 26), 1, 'Akatosh standing rises (roll 50 < 201)');
  ctx.services.adjustReputation(p, 26, 59);
  serve(ctx, p, tr, 'donate');
  assert.equal(ctx.services.reputation(p, 26), 60, 'roll 50 fails at standing 60 (4% chance)');
  let v = talk(ctx, p, he);
  const cost = v.services.find((s) => s.id === 'cure').cost;
  // CalculateCost at quality 15 (neutral market without package 12), then the haggle with Mercantile 0 / Personality 50.
  assert.equal(ctx.services.guilds.cureQuote(p, he).listed, cureCost(2, 'temple', 26, -1, 15));
  assert.equal(cost, tradePrice(cureCost(2, 'temple', 26, -1, 15), 15, false, { mercantile: 0, personality: 50 }));
  v = ctx.act(p, 'npc.service', { targetId: he.id, session: v.session, service: 'cure', cost });
  assert.match(v.text, /sickness leaves you/);
  assert.equal(v.services.find((s) => s.id === 'cure').cost, undefined, 'a healthy patient gets no cure quote');
  assert.equal(p.rpg.gold, 4800 - cost);
  ctx.services.holidayPrice = (svc, price) => ({ price: 0, free: true, rule: 'free' });
  diseases = 1;
  v = serve(ctx, p, he, 'cure');
  assert.match(v.text, /In honour of the day/);
  assert.equal(p.rpg.gold, 4800 - cost);
});

test('politics: quest success moves the hierarchy; any installed faction keeps its standing', () => {
  const ctx = makeCtx();
  const p = player();
  ctx.join(p);
  ctx.emit('questComplete', { player: p, factionId: 94, quest: { name: 'X' } });
  assert.equal(ctx.services.reputation(p, 94), 5);
  assert.equal(ctx.services.reputation(p, 27), 5, 'Julianos, the root');
  assert.equal(ctx.services.reputation(p, 201), 1, 'and the court as before');
  assert.equal(ctx.services.adjustReputation(p, 368, 3), 3, 'knightly order standing is kept');
  assert.equal(ctx.services.adjustReputation(p, 99999, 3), 0, 'unknown ids are ignored');
});

test('memberships, ranks, variants, invitations and standing survive a restart', () => {
  const ctx = makeCtx();
  const p = player();
  ctx.join(p);
  ctx.services.guilds.addMembership(p, 'temple', 35, 4);
  ctx.services.guilds.addMembership(p, 'knights', 413, 2);
  ctx.services.adjustReputation(p, 35, 44);
  ctx.emit('guildInvite', { player: p, guild: 'brotherhood', quest: 'L0A01L00', started: false });
  const saved = JSON.parse(JSON.stringify(p.rpg));
  const ctx2 = makeCtx();
  const p2 = { ...player(), rpg: saved };
  ctx2.join(p2);
  assert.equal(ctx2.services.templeRank(p2, 35), 4);
  assert.equal(ctx2.services.guildRank(p2, 'knights', { factionId: 413 }), 2);
  assert.equal(ctx2.services.guildRank(p2, 'knights', { factionId: 368 }), null);
  assert.equal(ctx2.services.reputation(p2, 35), 44);
  assert.equal(p2.rpg.guildInvites.brotherhood.awaiting, true);
  assert.equal(p2.rpg.guilds.temple.lastRankChange, p.rpg.guilds.temple.lastRankChange);
  // Legacy saves: an un-varianted temple membership is the Order of Arkay's.
  const legacy = { ...player(), rpg: { ...player().rpg, guilds: { temple: { rank: 2 }, fighters: { rank: 1 }, bogus: { rank: 3 } } } };
  ctx2.join(legacy);
  assert.equal(ctx2.services.templeRank(legacy, 21), 2);
  assert.equal(legacy.rpg.guilds.bogus, undefined);
  assert.ok(GROUPS.fighters.ranks.length === 10);
});
