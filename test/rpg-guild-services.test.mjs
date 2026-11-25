// Package 15, second part: the guilds' own specialists and temple perks.
// Guild teleport, spymaster, library access at bookshelves, secret hall and promotion map reveals, temple
// blessings on donation, Akatosh journey time, Kynareth breath, Stendarr's escape from death, the knight's house
// hand-off, and cure prices with the regional adjustment and haggling.
// FIXTURE: a stand-in runtime as in test/rpg-guilds.test.mjs, with the real travel feature (starter catalogue).
// Installed-data checks are in test/rpg-guild-services-data.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install as installNpcs } from '../server/rpg/npcs.js';
import { install as installGuilds, BLESSING_MINUTES } from '../server/rpg/guilds.js';
import { install as installTravel } from '../server/rpg/travel.js';
import { cureCost } from '../server/rpg/guilds/rules.js';
import { calculateCost, tradePrice } from '../client/gameplay/economy/rules.js';
import { avoidsDeath, breathScale, fastTravelMinutes, freeTavernRooms } from '../client/gameplay/guilds/perks.js';
import { quoteJourney } from '../client/gameplay/travel/journey.js';
import { CLASSIC_STARTERS } from '../client/gameplay/travel/classic.js';
import { maxBreath, normalizeMods } from '../client/lib/locomotion.js';

const HOME = 'interior:Daggerfall/Daggerfall/1,2/3';
const TOWN = 'town:Daggerfall/Daggerfall';
const DAY = 1440;

function makeCtx({ minutes = 1000 * DAY, roll = 0, travel = false, rsc = null } = {}) {
  const handlers = { join: [], leave: [], tick: [], actions: new Map(), events: new Map() };
  let now = 1000;
  const clock = { minutes };
  const ctx = {
    players: new Map(), entities: new Map(), services: {}, notes: [], emitted: [], dirtied: new Set(), clock,
    defaultLocation: TOWN,
    onJoin: (fn) => handlers.join.push(fn), onLeave: (fn) => handlers.leave.push(fn), onTick: (fn) => handlers.tick.push(fn),
    onAction: (verb, fn) => handlers.actions.set(verb, fn),
    on: (n, fn) => { if (!handlers.events.has(n)) handlers.events.set(n, []); handlers.events.get(n).push(fn); },
    emit: (n, payload) => { ctx.emitted.push({ name: n, payload }); for (const fn of handlers.events.get(n) || []) fn(payload); },
    notify: (p, ev) => ctx.notes.push({ to: p.id, ev }),
    dirty: (p) => ctx.dirtied.add(p.id),
    now: () => now,
    location: (p) => p.rpg.location,
  };
  ctx.services.worldClock = () => ({ minutes: clock.minutes });
  ctx.act = (p, verb, args) => handlers.actions.get(verb)(p, args);
  ctx.join = (p) => { ctx.players.set(p.id, p); for (const fn of handlers.join) fn(p); };
  installNpcs(ctx);
  if (travel) installTravel(ctx);
  installGuilds(ctx, { random: () => roll, textRsc: rsc });
  return ctx;
}

let pid = 0;
function player(skills = {}, rpg = {}) {
  return {
    id: ++pid, name: `Hero${pid} Brightwater`, x: 0, z: 0,
    rpg: {
      location: HOME, gold: 5000, inventory: [], equipment: {},
      character: { level: 3, health: 10, maxHealth: 40, magicka: 0, maxMagicka: 20, skills: { 'Long Blade': 30, Axe: 10, ...skills } },
      ...rpg,
    },
  };
}
function staff(ctx, id, { role, guild, services, hall, npcFaction, quality = 10, type = 11 }) {
  const e = {
    id, kind: 'npc', role, guild, title: role, name: `Staff ${id}`, location: HOME, x: 0, z: 0, faction: npcFaction ?? hall,
    services, sourced: true, reach: 3, building: { type, factionId: hall, quality }, _source: { factionId: npcFaction ?? hall },
  };
  ctx.entities.set(id, e);
  return e;
}
const talk = (ctx, p, e) => ctx.act(p, 'npc.talk', { targetId: e.id });
const serve = (ctx, p, e, service, extra = {}) => {
  const v = talk(ctx, p, e);
  return ctx.act(p, 'npc.service', { targetId: e.id, session: v.session, service, ...extra });
};

// ------------------------------------------------------------------------------------------- shared perk rules

test('temple and order perks follow Temple.FastTravel / DeepBreath / AvoidDeath and KnightlyOrder rooms', () => {
  const ak = { temple: { rank: 5, variant: 26 } };
  assert.equal(fastTravelMinutes(1000, ak), 900, 'Akatosh rank 5: 90 % of the time');
  assert.equal(fastTravelMinutes(1000, { temple: { rank: 0, variant: 26 } }), 950);
  assert.equal(fastTravelMinutes(1000, { temple: { rank: 9, variant: 21 } }), 1000, 'Arkay gives nothing');
  assert.equal(breathScale({ temple: { rank: 4, variant: 35 } }), 1.4, 'Kynareth rank 4: 140 % breath');
  assert.equal(breathScale({ temple: { rank: 4, variant: 33 } }), 1);
  assert.ok(avoidsDeath({ temple: { rank: 6, variant: 33 } }, 5));
  assert.ok(!avoidsDeath({ temple: { rank: 6, variant: 33 } }, 6), 'Random.Range(0, 50) < rank');
  assert.ok(!avoidsDeath({ temple: { rank: 9, variant: 33 } }, 0, true), 'never under water');
  assert.ok(!avoidsDeath({ temple: { rank: 9, variant: 35 } }, 0));
  assert.ok(freeTavernRooms({ knights: { rank: 0, variant: 368 } }, 17) && !freeTavernRooms({ knights: { rank: 0, variant: 368 } }, 5));
  assert.ok(freeTavernRooms({ knights: { rank: 4, variant: 368 } }, 5));
  // The same rule prices the journey in the browser and on the server.
  const [from, to] = [CLASSIC_STARTERS.find((l) => l.name === 'Daggerfall'), CLASSIC_STARTERS.find((l) => l.name === 'Wayrest')];
  const plain = quoteJourney(from, to, { speed: 'cautious', lodging: 'inn' });
  const fast = quoteJourney(from, to, { speed: 'cautious', lodging: 'inn' }, { fastTravel: (m) => fastTravelMinutes(m, ak) });
  assert.equal(fast.minutes, Math.trunc(plain.minutes * 0.9));
  assert.ok(fast.days <= plain.days && fast.cost.inn <= plain.cost.inn);
  const free = quoteJourney(from, to, { speed: 'cautious', lodging: 'inn' }, { freeInnRooms: true });
  assert.equal(free.cost.inn, 0);
  // Kynareth: the dive starts with more breath; drowning damage stays the plain one.
  assert.equal(maxBreath(normalizeMods({ endurance: 60, breathScale: 1.4 })), Math.floor(25 * 1.4));
  assert.equal(maxBreath(normalizeMods({ endurance: 60 })), 25);
});

test('server travel applies Akatosh time and knightly free inns; the client quote matches', () => {
  const ctx = makeCtx({ travel: true });
  const p = player({}, { location: TOWN });
  ctx.join(p);
  const plain = ctx.services.travel.quote(p, 'town:Wayrest/Wayrest', { speed: 'cautious', lodging: 'inn' });
  ctx.services.guilds.addMembership(p, 'temple', 26, 5);
  const fast = ctx.services.travel.quote(p, 'town:Wayrest/Wayrest', { speed: 'cautious', lodging: 'inn' });
  assert.equal(fast.minutes, Math.trunc(plain.minutes * 0.9));
  ctx.services.guilds.addMembership(p, 'knights', 368, 0);
  assert.equal(ctx.services.travel.quote(p, 'town:Wayrest/Wayrest', { speed: 'cautious', lodging: 'inn' }).cost.inn, 0, 'Daggerfall is the Dragon knights’ home region');
});

// ------------------------------------------------------------------------------------------- guild teleport

test('guild teleport: rank 8 opens the map, then sends the member to a known place at once and for free', () => {
  const ctx = makeCtx({ travel: true });
  const porter = staff(ctx, 'mgp', { role: 'mages', guild: 'mages', services: ['teleport'], hall: 40, npcFaction: 62 });
  const p = player();
  ctx.join(p);
  ctx.services.guilds.addMembership(p, 'mages', null, 7);
  assert.match(serve(ctx, p, porter, 'teleport').text, /not risen high enough .* Loremaster/);
  p.rpg.guilds.mages.rank = 8;
  let v = serve(ctx, p, porter, 'teleport');
  assert.deepEqual(v.teleport, { open: true }, 'the conversation opens the travel map');
  const gold = p.rpg.gold;
  assert.throws(() => ctx.act(p, 'npc.service', { targetId: porter.id, session: v.session, service: 'teleport', to: 'town:Nowhere/Nowhere' }), /not one of them|no such place|not a place|heard of/i);
  assert.equal(p.rpg.location, HOME, 'a refused destination changes nothing');
  v = talk(ctx, p, porter);
  const r = ctx.act(p, 'npc.service', { targetId: porter.id, session: v.session, service: 'teleport', to: 'town:Wayrest/Wayrest' });
  assert.match(r.text, /you stand in Wayrest/);
  assert.equal(p.rpg.location, 'town:Wayrest/Wayrest', 'from inside the hall, straight to the town');
  assert.equal(p.rpg.gold, gold, 'free');
  assert.equal(p.rpg.travel.lastTown, 'town:Wayrest/Wayrest');
  assert.ok(ctx.notes.some((n) => n.ev.kind === 'dialogue.end'), 'the conversation ends');
  assert.ok(ctx.emitted.some((x) => x.name === 'guildTeleport'));
});

// ------------------------------------------------------------------------------------------- spymaster

test('spymaster: Thieves Guild rank 4 greets with TEXT.RSC 402 and marks the conversation', () => {
  const rsc = { text: (id) => (id === 402 ? 'I am the Spymaster. I know everything that\n happens.' : null) };
  const ctx = makeCtx({ rsc });
  const spy = staff(ctx, 'spy', { role: 'thieves', guild: 'thieves', services: ['spymaster'], hall: 42, npcFaction: 806 });
  const p = player();
  ctx.join(p);
  ctx.services.guilds.addMembership(p, 'thieves', null, 3);
  let v = serve(ctx, p, spy, 'spymaster');
  assert.match(v.text, /not risen high enough .* Locksmith/);
  assert.equal(v.spymaster, undefined);
  p.rpg.guilds.thieves.rank = 4;
  v = serve(ctx, p, spy, 'spymaster');
  assert.equal(v.text, 'I am the Spymaster. I know everything that happens.');
  assert.equal(v.spymaster, true, 'every answer in this conversation is true');
  // A new conversation starts without it.
  assert.equal(talk(ctx, p, spy).spymaster, undefined);
});

// ------------------------------------------------------------------------------------------- library

test('bookshelves: Guild.CanAccessLibrary for exactly this hall and rank; libraries are public', () => {
  const ctx = makeCtx();
  const p = player();
  ctx.join(p);
  const L = ctx.services.guildLibraryAccess;
  assert.equal(L(p, { buildingType: 10, factionId: 0 }).ok, true, 'a public library');
  assert.match(L(p, { buildingType: 11, factionId: 40 }).text, /members only/);
  ctx.services.guilds.addMembership(p, 'mages', null, 1);
  assert.match(L(p, { buildingType: 11, factionId: 40 }).text, /not risen high enough in The Mages Guild .* Scribe/);
  p.rpg.guilds.mages.rank = 2;
  assert.equal(L(p, { buildingType: 11, factionId: 40 }).ok, true);
  ctx.services.guilds.addMembership(p, 'fighters', null, 9);
  assert.equal(L(p, { buildingType: 11, factionId: 41 }).ok, false, 'Fighters Guild halls keep their shelves closed (Guild.CanAccessLibrary)');
  ctx.services.guilds.addMembership(p, 'temple', 27, 0);
  assert.equal(L(p, { buildingType: 14, factionId: 94 }).ok, true, 'Julianos opens the library at rank 0');
  assert.equal(L(p, { buildingType: 14, factionId: 36 }).ok, false, 'not at another deity’s temple');
});

// ------------------------------------------------------------------------------------------- secret halls

test('secret guilds: members find their halls on the town map; promotions mark places (TG 6/8, DB each)', () => {
  const ctx = makeCtx();
  const learned = [];
  const notes = [];
  ctx.services.automap = { learnPlace: (p, x) => { learned.push(x); return true; }, write: (p, text) => notes.push(text) };
  ctx.services.portals = {
    at: (town) => (town === TOWN ? [
      { id: 'b1', kind: 'building', to: 'interior:a', meta: { factionId: 42 } },
      { id: 'b2', kind: 'building', to: 'interior:b', meta: { factionId: 108 } },
      { id: 'b3', kind: 'building', to: 'interior:c', meta: { factionId: 41 } },
    ] : []),
    into: () => ({ from: TOWN }),
  };
  let n = 0;
  ctx.services.travel = { discoverRandomLocation: () => ({ status: 'revealed', entry: { id: `town:Daggerfall/Ruin${++n}`, name: `Old Ruin ${n}`, region: 'Daggerfall' } }) };
  const p = player({ Stealth: 90, Lockpicking: 90, Pickpocket: 90, Backstabbing: 90 });
  ctx.join(p);
  assert.equal(learned.length, 0);
  ctx.emit('questComplete', { player: p, quest: { name: 'O0A0AL00' } });
  assert.deepEqual(learned, [{ town: TOWN, portalId: 'b1', label: 'Thieves Guild' }], 'joining reveals this town’s hall');
  ctx.emit('locationChanged', { player: p, from: 'x', to: TOWN });
  assert.equal(learned.length, 2, 'and again on arrival in a town');
  // Promotion to rank 6 through earned standing, at the 28-day mark, by talking to the guild.
  const tg = staff(ctx, 'tg', { role: 'thieves', guild: 'thieves', services: ['train'], hall: 42, npcFaction: 803 });
  p.rpg.guilds.thieves.rank = 5;
  ctx.services.adjustReputation(p, 42, 65); // rank 6 needs 60, rank 7 needs 70
  ctx.clock.minutes += 28 * DAY;
  const v = talk(ctx, p, tg);
  assert.equal(p.rpg.guilds.thieves.rank, 6);
  assert.match(v.text, /From today you are Burglar.*Old Ruin 1 in Daggerfall/);
  assert.match(notes[0], /Old Ruin 1 in Daggerfall/);
  assert.ok(ctx.emitted.some((x) => x.name === 'guildSecretRevealed' && x.payload.rank === 6));
});

// ------------------------------------------------------------------------------------------- blessings

test('donation blessings: +1 to the deity’s attribute or skill for three days; Stendarr speaks to the law', () => {
  const ctx = makeCtx({ roll: 0.99 });
  const law = [];
  ctx.services.law = { regionOf: () => 'Daggerfall', changeLegalRep: (p, region, d, why) => law.push([region, d, why]) };
  const ky = staff(ctx, 'ky', { role: 'priest', guild: 'temple', services: ['donate'], hall: 36, npcFaction: 810, type: 14 });
  const st = staff(ctx, 'st', { role: 'priest', guild: 'temple', services: ['donate'], hall: 106, npcFaction: 810, type: 14 });
  const ar = staff(ctx, 'ar', { role: 'priest', guild: 'temple', services: ['donate'], hall: 82, npcFaction: 810, type: 14 });
  const p = player();
  ctx.join(p);
  let v = serve(ctx, p, ky, 'donate', { amount: 50 });
  assert.match(v.text, /Kynareth fortifies your endurance/);
  assert.equal(p.rpg.gold, 4950);
  assert.equal(ctx.services.blessingModifier(p, 'Endurance'), 1);
  assert.equal(ctx.services.blessingModifier(p, 'Strength'), 0);
  v = serve(ctx, p, ky, 'donate', { amount: 50 });
  assert.doesNotMatch(v.text, /fortifies/, 'no second blessing while the first lasts');
  ctx.clock.minutes += BLESSING_MINUTES;
  assert.equal(ctx.services.blessingModifier(p, 'Endurance'), 0, 'the blessing fades');
  v = serve(ctx, p, st, 'donate', { amount: 50 });
  assert.match(v.text, /Stendarr/);
  assert.deepEqual(law, [['Daggerfall', 1, 'blessing']]);
  v = serve(ctx, p, ar, 'donate', { amount: 50 });
  assert.doesNotMatch(v.text, /blessed|fortifies/, 'Arkay grants no blessing');
  // Blessings survive a restart (normalized state).
  ctx.services.guilds.normalize(p.rpg);
  assert.equal(p.rpg.blessing.deity, 33);
});

// ------------------------------------------------------------------------------------------- Stendarr

test('Stendarr spares a member from death at Random.Range(0, 50) < rank, never when drowning', () => {
  const ctx = makeCtx({ roll: 0.1 }); // Math.floor(0.1 * 50) = 5
  const p = player();
  ctx.join(p);
  assert.equal(ctx.services.avoidDeath(p, null), false);
  ctx.services.guilds.addMembership(p, 'temple', 33, 6);
  assert.equal(ctx.services.avoidDeath(p, { kind: 'monster' }), true);
  assert.ok(ctx.notes.some((n) => /Stendarr has spared you/.test(n.ev.text ?? '')));
  assert.equal(ctx.services.avoidDeath(p, { kind: 'drowning' }), false);
  p.rpg.guilds.temple.rank = 5;
  assert.equal(ctx.services.avoidDeath(p, null), false);
  assert.equal(ctx.services.guildBreathScale(p), 1);
});

// ------------------------------------------------------------------------------------------- knight's house

test('the Seneschal grants the rank-9 house once through package 13', () => {
  const ctx = makeCtx();
  const sen = staff(ctx, 'sen', { role: 'knights', guild: 'knights', services: ['house'], hall: 368, npcFaction: 848 });
  const p = player();
  ctx.join(p);
  ctx.services.guilds.addMembership(p, 'knights', 368, 8);
  assert.match(serve(ctx, p, sen, 'house').text, /Grand Master alone/);
  p.rpg.guilds.knights.rank = 9;
  assert.match(serve(ctx, p, sen, 'house').text, /cannot hand over a deed/, 'without the property hook nothing is granted');
  const grants = [];
  ctx.services.property = { grantHouse: (q, o) => { grants.push(o); return { status: 'granted', text: 'The deed to a house is yours.' }; } };
  assert.match(serve(ctx, p, sen, 'house').text, /deed to a house is yours/);
  assert.match(serve(ctx, p, sen, 'house').text, /already received/);
  assert.equal(grants.length, 1);
  assert.equal(p.rpg.guilds.knights.flags & 2, 2);
});

// ------------------------------------------------------------------------------------------- cure price

test('cure price: regional adjustment and quality, the holiday rule, then haggling with the player’s skills', () => {
  const ctx = makeCtx();
  const he = staff(ctx, 'he', { role: 'priest', guild: 'temple', services: ['heal', 'cure'], hall: 82, npcFaction: 813, quality: 14, type: 14 });
  let diseases = 1;
  ctx.services.conditionCount = () => diseases;
  ctx.services.cureCondition = () => { const n = diseases; diseases = 0; return n; };
  const market = { adjust: 1200, mercantile: 40, personality: 70, holiday: null };
  ctx.services.priceContext = (p, loc, quality) => ({ ...market, quality });
  const p = player();
  ctx.join(p);
  ctx.services.guilds.addMembership(p, 'temple', 21, 4);
  const q = ctx.services.guilds.cureQuote(p, he);
  const listed = calculateCost(150, 14, 1200); // Arkay rank 4: 250 → 150
  assert.equal(q.listed, listed);
  assert.equal(q.cost, tradePrice(listed, 14, false, { mercantile: 40, personality: 70 }));
  assert.ok(q.cost < q.listed, 'a good haggler pays less');
  market.mercantile = 0; market.personality = 10;
  assert.ok(ctx.services.guilds.cureQuote(p, he).cost > q.cost, 'a poor one pays more');
  market.holiday = 'north-winds-festival';
  assert.equal(ctx.services.guilds.cureQuote(p, he).listed, Math.floor(listed / 2), 'North Winds halves the price before haggling');
  market.holiday = 'south-winds-prayer';
  const free = ctx.services.guilds.cureQuote(p, he);
  assert.deepEqual([free.cost, free.rule], [0, 'free']);
  market.holiday = null;
  const v = talk(ctx, p, he);
  const cost = v.services.find((s) => s.id === 'cure').cost;
  const gold = p.rpg.gold;
  assert.match(ctx.act(p, 'npc.service', { targetId: he.id, session: v.session, service: 'cure', cost }).text, /sickness leaves you/);
  assert.equal(p.rpg.gold, gold - cost);
  assert.equal(cureCost(1, 'temple', 21, 4, 14), calculateCost(150, 14, 1000), 'the neutral-market rule is unchanged');
});
