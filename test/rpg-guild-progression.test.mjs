// Classic guild, temple, and knightly-order progression & specialist service wiring tests.
// Walks characters from non-member -> Initiate (rank 0) -> mid ranks -> Rank 9 across all 6 guild families,
// verifying 28-day cooldowns, primary/secondary skill gates, reputation thresholds, expulsion & rejoin,
// temple/order exclusivity, after-hours hall access, and live specialist service delegation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install as installNpcs } from '../server/rpg/npcs.js';
import { install as installGuilds } from '../server/rpg/guilds.js';
import { install as installMagic } from '../server/rpg/magic.js';
import { install as installAlchemy } from '../server/rpg/alchemy.js';
import { install as installSpecial } from '../server/rpg/special.js';
import { install as installTravel } from '../server/rpg/travel.js';
import { buildingAccess } from '../server/rpg/townServices/access.js';
import {
  DIVINES, GROUPS, ORDERS, RANK_CHANGE_DAYS, RANK_REQ_REPUTATION, RANK_REQ_SKILL_HIGH, RANK_REQ_SKILL_LOW,
  newRank, privileges, rankFor, serviceAccess,
} from '../server/rpg/guilds/rules.js';
import { avoidsDeath, breathScale, fastTravelMinutes, freeShipTravel, freeTavernRooms } from '../client/gameplay/guilds/perks.js';

const HOME = 'interior:Daggerfall/Daggerfall/1,2/3';
const TOWN = 'town:Daggerfall/Daggerfall';
const DAY = 1440;

function makeCtx({ minutes = 1000 * DAY, roll = 0, full = false } = {}) {
  const handlers = { join: [], leave: [], tick: [], actions: new Map(), events: new Map() };
  let now = 1000;
  const clock = { minutes };
  const ctx = {
    players: new Map(), entities: new Map(), services: {}, notes: [], emitted: [], dirtied: new Set(), clock,
    defaultLocation: TOWN,
    onJoin: (fn) => handlers.join.push(fn),
    onLeave: (fn) => handlers.leave.push(fn),
    onTick: (fn) => handlers.tick.push(fn),
    onAction: (verb, fn) => handlers.actions.set(verb, fn),
    on: (n, fn) => { if (!handlers.events.has(n)) handlers.events.set(n, []); handlers.events.get(n).push(fn); },
    emit: (n, payload) => { ctx.emitted.push({ name: n, payload }); for (const fn of handlers.events.get(n) || []) fn(payload); },
    notify: (p, ev) => ctx.notes.push({ to: p.id, ev }),
    dirty: (p) => ctx.dirtied.add(p.id),
    now: () => now,
    location: (p) => p.rpg.location,
  };
  ctx.services.worldClock = () => ({ minutes: clock.minutes });
  let seq = 0;
  ctx.services.giveItem = (p, template, quantity = 1) => {
    const item = { id: `i${++seq}`, template, name: template, quantity };
    p.rpg.inventory.push(item);
    return item;
  };
  ctx.services.spendGold = (p, amount) => {
    if (p.rpg.gold < amount) throw new Error('Not enough gold.');
    p.rpg.gold -= amount;
  };
  ctx.act = (p, verb, args) => handlers.actions.get(verb)(p, args);
  ctx.join = (p) => { ctx.players.set(p.id, p); for (const fn of handlers.join) fn(p); };

  if (full) installAlchemy(ctx);
  installNpcs(ctx);
  if (full) installTravel(ctx);
  installGuilds(ctx, { random: () => roll });
  if (full) {
    installMagic(ctx);
    installSpecial(ctx, { random: () => roll });
  }
  return ctx;
}

let pid = 0;
function makePlayer(skills = {}, rpg = {}) {
  return {
    id: ++pid, name: `Adventurer${pid}`, x: 0, z: 0,
    rpg: {
      location: HOME, gold: 500_000, inventory: [], equipment: {},
      character: {
        level: 5, health: 20, maxHealth: 60, magicka: 0, maxMagicka: 40,
        noRegenSpellPoints: false,
        skills: { ...skills },
      },
      ...rpg,
    },
  };
}

function makeStaff(ctx, id, { role, guild, services, hall, npcFaction, quality = 10, type = 11 }) {
  const e = {
    id, kind: 'npc', role, guild, title: role, name: `Staff ${id}`, location: HOME, x: 0, z: 0,
    faction: npcFaction ?? hall, services, sourced: true, reach: 3,
    building: { type, factionId: hall, quality }, _source: { factionId: npcFaction ?? hall },
  };
  ctx.entities.set(id, e);
  return e;
}

const talk = (ctx, p, e) => ctx.act(p, 'npc.talk', { targetId: e.id });
const serve = (ctx, p, e, service, extra = {}) => {
  const v = talk(ctx, p, e);
  return ctx.act(p, 'npc.service', { targetId: e.id, session: v.session, service, ...extra });
};

function setRep(ctx, p, factionId, target) {
  const cur = ctx.services.reputation(p, factionId);
  if (target !== cur) ctx.services.adjustReputation(p, factionId, target - cur);
}

// ------------------------------------------------------------------------------------------- Mages Guild 0 -> 9 + wired specialists

test('Mages Guild: non-member -> rank 0 -> rank 9 with skill/rep/cooldown gates, live specialist wiring, expulsion & rejoin', () => {
  const ctx = makeCtx({ full: true });
  const trainer = makeStaff(ctx, 'mgt', { role: 'mages', guild: 'mages', services: ['join', 'train'], hall: 40, npcFaction: 61 });
  const maker = makeStaff(ctx, 'mgm', { role: 'mages', guild: 'mages', services: ['spells', 'makeSpells'], hall: 40, npcFaction: 65 });
  const merchant = makeStaff(ctx, 'mgi', { role: 'mages', guild: 'mages', services: ['magicItems', 'soulgems', 'makeItems', 'identify'], hall: 40, npcFaction: 64 });
  const summoner = makeStaff(ctx, 'mgs', { role: 'mages', guild: 'mages', services: ['summon'], hall: 40, npcFaction: 66 });
  const porter = makeStaff(ctx, 'mgp', { role: 'mages', guild: 'mages', services: ['teleport'], hall: 40, npcFaction: 62 });
  const mgPortal = { kind: 'building', meta: { factionId: 40, buildingType: 11 } };

  // Start with insufficient skills -> join refused.
  const p = makePlayer({ Destruction: 21, Alteration: 3 });
  ctx.join(p);
  assert.equal(ctx.services.guildIsMember(p, 'mages'), false);
  assert.equal(ctx.services.guildIsMember(p, mgPortal), false);
  assert.match(serve(ctx, p, trainer, 'join').text, /lack the skills/);

  // Non-member: spells & identify open, makeSpells / magicItems / soulgems / makeItems / summon / teleport / library locked.
  ctx.notes.length = 0;
  serve(ctx, p, maker, 'spells');
  assert.ok(ctx.notes.some((n) => n.ev.kind === 'spellShop'), 'non-members can buy spells');
  assert.match(serve(ctx, p, maker, 'makeSpells').text, /members of The Mages Guild only/);
  assert.match(serve(ctx, p, merchant, 'magicItems').text, /members of The Mages Guild only/);
  assert.match(serve(ctx, p, merchant, 'soulgems').text, /members of The Mages Guild only/);
  assert.match(serve(ctx, p, merchant, 'makeItems').text, /members of The Mages Guild only/);
  assert.match(serve(ctx, p, summoner, 'summon').text, /members of The Mages Guild only/);
  assert.match(serve(ctx, p, porter, 'teleport').text, /members of The Mages Guild only/);
  assert.equal(ctx.services.guildLibraryAccess(p, { buildingType: 11, factionId: 40 }).ok, false);

  // Meet rank-0 skills (22/4) but negative rep -> join refused.
  p.rpg.character.skills.Destruction = 22;
  p.rpg.character.skills.Alteration = 4;
  setRep(ctx, p, 40, -1);
  assert.match(serve(ctx, p, trainer, 'join').text, /reputation .* poor/);

  // Raise rep to 0 -> join as Novice (rank 0).
  setRep(ctx, p, 40, 0);
  const joined = serve(ctx, p, trainer, 'join');
  assert.match(joined.text, /Welcome to The Mages Guild.*Novice/);
  assert.equal(p.rpg.guilds.mages.rank, 0);
  assert.equal(ctx.services.guildIsMember(p, 'mages'), true);
  assert.equal(ctx.services.guildIsMember(p, mgPortal), true);
  assert.equal(ctx.services.guildIsMember(p, trainer), true);

  // Rank 0: Spell Maker unlocks (wired to magic.js!), magicka restores for non-regen careers, library still locked.
  ctx.notes.length = 0;
  serve(ctx, p, maker, 'makeSpells');
  assert.ok(ctx.notes.some((n) => n.ev.kind === 'spellMaker'), 'Spell Maker opens at rank 0');
  p.rpg.character.noRegenSpellPoints = true;
  p.rpg.character.magicka = 0;
  assert.match(talk(ctx, p, trainer).text, /restores your magicka/);
  assert.equal(p.rpg.character.magicka, 40);
  assert.equal(ctx.services.guildLibraryAccess(p, { buildingType: 11, factionId: 40 }).ok, false);
  assert.equal(ctx.services.guildHallAccess(p, mgPortal), false);

  // Skill gate check: rep 25 qualifies for rank 2, but skills (23/5) only qualify for rank 1.
  setRep(ctx, p, 40, 25);
  p.rpg.character.skills.Destruction = 23;
  p.rpg.character.skills.Alteration = 5;
  ctx.clock.minutes += 27 * DAY;
  talk(ctx, p, trainer);
  assert.equal(p.rpg.guilds.mages.rank, 0, '28-day cooldown holds at day 27');
  ctx.clock.minutes += DAY;
  assert.match(talk(ctx, p, trainer).text, /From today you are Reader/);
  assert.equal(p.rpg.guilds.mages.rank, 1, 'capped at rank 1 by skills despite rep 25');

  // Climb rank by rank through exact classic unlock thresholds (2, 3, 4, 5, 6, 8, 9).
  const climbTo = (targetRank) => {
    setRep(ctx, p, 40, RANK_REQ_REPUTATION[targetRank]);
    p.rpg.character.skills.Destruction = RANK_REQ_SKILL_HIGH[targetRank];
    p.rpg.character.skills.Alteration = RANK_REQ_SKILL_LOW[targetRank];
    ctx.clock.minutes += RANK_CHANGE_DAYS * DAY;
    const v = talk(ctx, p, trainer);
    assert.equal(p.rpg.guilds.mages.rank, targetRank, `reached rank ${targetRank}`);
    return v;
  };

  // Rank 2 (Scribe): Library opens, magicItems still locked.
  climbTo(2);
  assert.equal(ctx.services.guildLibraryAccess(p, { buildingType: 11, factionId: 40 }).ok, true);
  assert.match(serve(ctx, p, merchant, 'magicItems').text, /not risen high enough .* Lector/);

  // Rank 3 (Lector): Buy magic items opens (alchemy.js!), soulgems still locked.
  climbTo(3);
  ctx.notes.length = 0;
  serve(ctx, p, merchant, 'magicItems');
  assert.ok(ctx.notes.some((n) => n.ev.kind === 'alchemyPanel' && n.ev.service === 'magicItems'), 'Buy magic items opens at rank 3');
  assert.match(serve(ctx, p, merchant, 'soulgems').text, /not risen high enough .* Arcanist/);

  // Rank 4 (Arcanist): Soul gems opens (alchemy.js!), makeItems still locked.
  climbTo(4);
  ctx.notes.length = 0;
  serve(ctx, p, merchant, 'soulgems');
  assert.ok(ctx.notes.some((n) => n.ev.kind === 'alchemyPanel' && n.ev.service === 'soulgems'), 'Buy soul gems opens at rank 4');
  assert.match(serve(ctx, p, merchant, 'makeItems').text, /not risen high enough .* Savant/);

  // Rank 5 (Savant): Item Maker opens (alchemy.js!), summon & hallAccessAnytime still locked.
  climbTo(5);
  ctx.notes.length = 0;
  serve(ctx, p, merchant, 'makeItems');
  assert.ok(ctx.notes.some((n) => n.ev.kind === 'alchemyPanel' && n.ev.service === 'makeItems'), 'Item Maker opens at rank 5');
  assert.match(serve(ctx, p, summoner, 'summon').text, /not risen high enough .* Magister/);
  assert.equal(ctx.services.guildHallAccess(p, mgPortal), false);

  // Rank 6 (Magister): Daedra summoning (special.js!) & after-hours hall access open; teleport still locked.
  climbTo(6);
  assert.equal(ctx.services.guildHallAccess(p, mgPortal), true, 'Mages Guild hall opens after hours at rank 6');
  ctx.notes.length = 0;
  serve(ctx, p, summoner, 'summon');
  assert.ok(ctx.notes.some((n) => n.ev.kind === 'daedraSummoning'), 'Daedra summoning routes to special.js at rank 6');
  assert.match(serve(ctx, p, porter, 'teleport').text, /not risen high enough .* Loremaster/);

  // Rank 8 (Loremaster): Guild teleport opens and teleports for free to Wayrest.
  climbTo(8);
  let v = serve(ctx, p, porter, 'teleport');
  assert.deepEqual(v.teleport, { open: true });
  const goldBefore = p.rpg.gold;
  ctx.act(p, 'npc.service', { targetId: porter.id, session: v.session, service: 'teleport', to: 'town:Wayrest/Wayrest' });
  assert.equal(p.rpg.location, 'town:Wayrest/Wayrest');
  assert.equal(p.rpg.gold, goldBefore);
  p.rpg.location = HOME;

  // Rank 9 (Arch-Lector): max rank.
  const maxView = climbTo(9);
  assert.match(maxView.text, /From today you are Arch-Lector/);

  // Negative reputation -> expelled after 28 days, cannot rejoin while negative, can rejoin at rank 0 once repaired.
  setRep(ctx, p, 40, -5);
  ctx.clock.minutes += 27 * DAY;
  talk(ctx, p, trainer);
  assert.equal(p.rpg.guilds.mages?.rank, 9, 'expulsion also respects the 28-day cooldown');
  ctx.clock.minutes += DAY;
  assert.match(talk(ctx, p, trainer).text, /no longer one of us/);
  assert.equal(p.rpg.guilds.mages, undefined);
  assert.equal(ctx.services.guildIsMember(p, 'mages'), false);
  assert.match(serve(ctx, p, trainer, 'join').text, /reputation .* poor/);
  setRep(ctx, p, 40, 0);
  assert.match(serve(ctx, p, trainer, 'join').text, /Welcome to The Mages Guild.*Novice/);
  assert.equal(p.rpg.guilds.mages.rank, 0);
});

// ------------------------------------------------------------------------------------------- Fighters Guild 0 -> 9

test('Fighters Guild: progression 0 -> 9, repair discounts, quest reward scaling, rest, hall access, and no skill expulsion', () => {
  const ctx = makeCtx();
  const trainer = makeStaff(ctx, 'fgt', { role: 'fighters', guild: 'fighters', services: ['join', 'train', 'repair'], hall: 41, npcFaction: 849 });
  const fgPortal = { kind: 'building', meta: { factionId: 41, buildingType: 11 } };
  const p = makePlayer({ 'Long Blade': 22, Axe: 4 });
  ctx.join(p);

  assert.equal(ctx.services.guildCanRest(p, fgPortal), false);
  assert.equal(ctx.services.guildHallAccess(p, fgPortal), false);
  assert.match(serve(ctx, p, trainer, 'repair').text, /members of The Fighters Guild only/);

  serve(ctx, p, trainer, 'join');
  assert.equal(p.rpg.guilds.fighters.rank, 0);
  assert.equal(ctx.services.guildCanRest(p, fgPortal), true, 'members rest in Fighters Guild halls from rank 0');
  assert.equal(ctx.services.guildHallAccess(p, fgPortal), false, 'after-hours access starts at rank 6');
  assert.equal(ctx.services.guilds.repairCost(p, 1000), 1000);
  assert.equal(ctx.services.guilds.questReward(p, 'fighters', 1000), 1000);

  // Regression check: rep >= 0 with low skills must NEVER expel a member (keeps rank 0).
  assert.equal(newRank({ skills: {} }, 'fighters', null, 0), 0);
  assert.equal(newRank({ skills: {} }, 'fighters', null, -1), -1);

  // Advance to rank 5 -> 50% repair cost, 150% quest reward, still no after-hours hall access.
  setRep(ctx, p, 41, 50);
  p.rpg.character.skills['Long Blade'] = 55;
  p.rpg.character.skills.Axe = 21;
  ctx.clock.minutes += 28 * DAY;
  talk(ctx, p, trainer);
  assert.equal(p.rpg.guilds.fighters.rank, 5);
  assert.equal(ctx.services.guilds.repairCost(p, 1000), 500);
  assert.equal(ctx.services.guilds.questReward(p, 'fighters', 1000), 1500);
  assert.equal(ctx.services.guildHallAccess(p, fgPortal), false);

  // Advance to rank 6 -> after-hours hall access unlocks.
  setRep(ctx, p, 41, 60);
  p.rpg.character.skills['Long Blade'] = 63;
  p.rpg.character.skills.Axe = 25;
  ctx.clock.minutes += 28 * DAY;
  assert.match(talk(ctx, p, trainer).text, /Captain.*hall at any hour/);
  assert.equal(p.rpg.guilds.fighters.rank, 6);
  assert.equal(ctx.services.guildHallAccess(p, fgPortal), true);

  // Advance to rank 9 (Lord Marshal) -> 10% repair cost, 190% quest reward.
  setRep(ctx, p, 41, 90);
  p.rpg.character.skills['Long Blade'] = 87;
  p.rpg.character.skills.Axe = 37;
  ctx.clock.minutes += 28 * DAY;
  assert.match(talk(ctx, p, trainer).text, /Lord Marshal/);
  assert.equal(p.rpg.guilds.fighters.rank, 9);
  assert.equal(ctx.services.guilds.repairCost(p, 1000), 100);
  assert.equal(ctx.services.guilds.questReward(p, 'fighters', 1000), 1900);
});

// ------------------------------------------------------------------------------------------- All 8 Temples

test('Temples: exclusivity, all 8 deities rank gates & perks, Kynareth Spell Maker wiring, expulsion allows switching', () => {
  const ctx = makeCtx({ full: true });
  assert.equal(Object.keys(DIVINES).length, 8, 'all 8 classic Divines are defined');

  // Verify exact rank thresholds across all 8 deities.
  const expected = {
    26: { library: 2, potions: 4, makePotions: 5, summon: 7 }, // Akatosh
    21: { library: 3, potions: 1, makePotions: 4, soulgems: 4, summon: 7 }, // Arkay
    29: { library: 4, potions: 1, makePotions: 5, summon: 7 }, // Dibella
    27: { library: 0, magicItems: 3, makeItems: 5, summon: 6 }, // Julianos
    35: { library: 4, spells: 3, makeSpells: 6, summon: 7 }, // Kynareth
    24: { library: 4, potions: 2, makePotions: 5, summon: 7 }, // Mara
    33: { library: 4, potions: 2, makePotions: 5, summon: 7 }, // Stendarr
    22: { library: 4, potions: 1, makePotions: 6, summon: 8 }, // Zenithar
  };
  for (const [deityId, gates] of Object.entries(expected)) {
    const id = Number(deityId);
    for (const [svc, minRank] of Object.entries(gates)) {
      assert.equal(rankFor('temple', id, svc), minRank, `deity ${id} ${svc} opens at rank ${minRank}`);
      if (minRank > 0) assert.equal(serviceAccess('temple', id, minRank - 1, svc).ok, false, `deity ${id} ${svc} locked at ${minRank - 1}`);
      assert.equal(serviceAccess('temple', id, minRank, svc).ok, true, `deity ${id} ${svc} open at ${minRank}`);
    }
  }

  // Live progression at Temple of Kynareth (35, order 36): spells (rank 3), library (rank 4), makeSpells (rank 6), summon (rank 7).
  const kyTrain = makeStaff(ctx, 'kyt', { role: 'priest', guild: 'temple', services: ['join', 'train'], hall: 36, npcFaction: 254, type: 14 });
  const kySpell = makeStaff(ctx, 'kys', { role: 'priest', guild: 'temple', services: ['spells', 'makeSpells'], hall: 36, npcFaction: 497, type: 14 });
  const arTrain = makeStaff(ctx, 'art', { role: 'priest', guild: 'temple', services: ['join', 'train'], hall: 82, npcFaction: 241, type: 14 });

  const p = makePlayer({ Archery: 22, Climbing: 4, Restoration: 30, Medical: 15 });
  ctx.join(p);

  serve(ctx, p, kyTrain, 'join');
  assert.equal(ctx.services.templeRank(p, 35), 0);
  assert.equal(ctx.services.guildIsMember(p, 'temple', { factionId: 35 }), true);
  assert.equal(ctx.services.guildIsMember(p, 'temple', { factionId: 21 }), false);
  // Temple exclusivity: cannot join Arkay while serving Kynareth.
  assert.match(serve(ctx, p, arTrain, 'join').text, /already serve Temple of Kynareth/);
  assert.match(serve(ctx, p, kySpell, 'spells').text, /not risen high enough .* Deacon/);

  // Advance to rank 3 -> Buy Spells unlocks, Spell Maker still locked.
  setRep(ctx, p, 35, 30);
  p.rpg.character.skills.Archery = 39;
  p.rpg.character.skills.Climbing = 13;
  ctx.clock.minutes += 28 * DAY;
  talk(ctx, p, kyTrain);
  assert.equal(p.rpg.guilds.temple.rank, 3);
  ctx.notes.length = 0;
  serve(ctx, p, kySpell, 'spells');
  assert.ok(ctx.notes.some((n) => n.ev.kind === 'spellShop'), 'Kynareth Buy Spells opens at rank 3');
  assert.match(serve(ctx, p, kySpell, 'makeSpells').text, /not risen high enough .* Prior/);

  // Advance to rank 6 -> Spell Maker opens (wired to magic.js!), breathScale = 1.6.
  setRep(ctx, p, 35, 60);
  p.rpg.character.skills.Archery = 63;
  p.rpg.character.skills.Climbing = 25;
  ctx.clock.minutes += 28 * DAY;
  talk(ctx, p, kyTrain);
  assert.equal(p.rpg.guilds.temple.rank, 6);
  ctx.notes.length = 0;
  serve(ctx, p, kySpell, 'makeSpells');
  assert.ok(ctx.notes.some((n) => n.ev.kind === 'spellMaker'), 'Kynareth Spell Maker opens at rank 6');
  assert.equal(breathScale(p.rpg.guilds), 1.6);

  // Expulsion from Kynareth clears temple membership and allows joining Arkay.
  setRep(ctx, p, 35, -10);
  ctx.clock.minutes += 28 * DAY;
  assert.match(talk(ctx, p, kyTrain).text, /no longer one of us/);
  assert.equal(p.rpg.guilds.temple, undefined);
  assert.match(serve(ctx, p, arTrain, 'join').text, /Welcome to Temple of Arkay/);
  assert.equal(ctx.services.templeRank(p, 21), 0);

  // Verify Akatosh & Stendarr shared perks at rank 9.
  assert.equal(fastTravelMinutes(1000, { temple: { rank: 9, variant: 26 } }), 860);
  assert.equal(avoidsDeath({ temple: { rank: 9, variant: 33 } }, 8, false), true);
  assert.equal(avoidsDeath({ temple: { rank: 9, variant: 33 } }, 9, false), false);
});

// ------------------------------------------------------------------------------------------- All 10 Knightly Orders

test('Knightly Orders: all 10 orders, exclusivity, progression 0 -> 9, perks, and Rank-9 free house', () => {
  const ctx = makeCtx();
  assert.equal(Object.keys(ORDERS).length, 10, 'all 10 classic Knightly Orders are defined');
  const questor = makeStaff(ctx, 'koq', { role: 'knights', guild: 'knights', services: ['join'], hall: 368, npcFaction: 846 });
  const otherQuestor = makeStaff(ctx, 'koq2', { role: 'knights', guild: 'knights', services: ['join'], hall: 409, npcFaction: 846 });
  const smith = makeStaff(ctx, 'kos', { role: 'knights', guild: 'knights', services: ['armor'], hall: 368, npcFaction: 845 });
  const seneschal = makeStaff(ctx, 'kosen', { role: 'knights', guild: 'knights', services: ['house'], hall: 368, npcFaction: 848 });

  const p = makePlayer({ 'Long Blade': 22, Etiquette: 4 });
  ctx.join(p);

  serve(ctx, p, questor, 'join');
  assert.equal(p.rpg.guilds.knights.rank, 0);
  assert.equal(ctx.services.guildIsMember(p, 'knights', { factionId: 368 }), true);
  assert.equal(ctx.services.guildIsMember(p, 'knights', { factionId: 409 }), false);
  assert.match(serve(ctx, p, otherQuestor, 'join').text, /already serve The Knights of the Dragon/);

  // Rank 0: iron armour, free inn in home region (17) only, no free ships.
  assert.match(serve(ctx, p, smith, 'armor', { piece: 'cuirass' }).text, /iron cuirass/);
  assert.equal(freeTavernRooms(p.rpg.guilds, 17), true);
  assert.equal(freeTavernRooms(p.rpg.guilds, 23), false);
  assert.equal(freeShipTravel(p.rpg.guilds.knights.rank), false);

  // Rank 4 (Bachelor): free tavern rooms in any region.
  setRep(ctx, p, 368, 40);
  p.rpg.character.skills['Long Blade'] = 47;
  p.rpg.character.skills.Etiquette = 17;
  ctx.clock.minutes += 28 * DAY;
  talk(ctx, p, questor);
  assert.equal(p.rpg.guilds.knights.rank, 4);
  assert.equal(freeTavernRooms(p.rpg.guilds, 23), true);
  assert.equal(freeShipTravel(p.rpg.guilds.knights.rank), false);

  // Rank 6 (Knight): free ship passage.
  setRep(ctx, p, 368, 60);
  p.rpg.character.skills['Long Blade'] = 63;
  p.rpg.character.skills.Etiquette = 25;
  ctx.clock.minutes += 28 * DAY;
  talk(ctx, p, questor);
  assert.equal(p.rpg.guilds.knights.rank, 6);
  assert.equal(ctx.services.guilds.freeShipTravel(p), true);

  // Rank 8: house still refused.
  setRep(ctx, p, 368, 80);
  p.rpg.character.skills['Long Blade'] = 79;
  p.rpg.character.skills.Etiquette = 33;
  ctx.clock.minutes += 28 * DAY;
  talk(ctx, p, questor);
  assert.equal(p.rpg.guilds.knights.rank, 8);
  assert.match(serve(ctx, p, seneschal, 'house').text, /Grand Master alone/);
  assert.ok(!privileges('knights', 368, 8).includes('house'));

  // Rank 9 (Grand Master): promotion announces Receive house, privileges includes 'house', daedric armour & one-time free house.
  setRep(ctx, p, 368, 90);
  p.rpg.character.skills['Long Blade'] = 87;
  p.rpg.character.skills.Etiquette = 37;
  ctx.clock.minutes += 28 * DAY;
  const promo = talk(ctx, p, questor);
  assert.match(promo.text, /Grand Master.*Receive house/);
  assert.ok(privileges('knights', 368, 9).includes('house'));
  assert.match(serve(ctx, p, smith, 'armor', { piece: 'helm' }).text, /daedric helm/);

  let granted = 0;
  ctx.services.property = {
    grantHouse: () => { granted++; return { status: 'granted', text: 'The deed is yours.' }; },
  };
  assert.match(serve(ctx, p, seneschal, 'house').text, /deed is yours/);
  assert.match(serve(ctx, p, seneschal, 'house').text, /already received/);
  assert.equal(granted, 1);
});

// ------------------------------------------------------------------------------------------- Thieves Guild & Dark Brotherhood

test('Thieves Guild & Dark Brotherhood: invite-only, rank-gated specialists, after-hours access, never expel', () => {
  const ctx = makeCtx({ full: true });
  const tgFence = makeStaff(ctx, 'tgf', { role: 'thieves', guild: 'thieves', services: ['train', 'sellItems', 'spymaster'], hall: 42, npcFaction: 803, type: 18 });
  const dbStaff = makeStaff(ctx, 'dbs', { role: 'brotherhood', guild: 'brotherhood', services: ['train', 'potions', 'makePotions', 'soulgems', 'spymaster'], hall: 108, npcFaction: 806, type: 18 });
  const p = makePlayer({ Stealth: 87, Lockpicking: 37, Backstabbing: 87, 'Short Blade': 37 });
  ctx.join(p);

  // Join both via initiation quest completion.
  ctx.emit('questComplete', { player: p, quest: { name: 'O0A0AL00' } });
  ctx.emit('questComplete', { player: p, quest: { name: 'L0A01L00' } });
  assert.equal(p.rpg.guilds.thieves.rank, 0);
  assert.equal(p.rpg.guilds.brotherhood.rank, 0);

  // Thieves Guild: rank 0 fails fence (rank 2) & spymaster (rank 4).
  assert.match(serve(ctx, p, tgFence, 'sellItems').text, /not risen high enough .* Footpad/);
  assert.match(serve(ctx, p, tgFence, 'spymaster').text, /not risen high enough .* Locksmith/);
  setRep(ctx, p, 42, 20);
  ctx.clock.minutes += 28 * DAY;
  talk(ctx, p, tgFence);
  assert.equal(p.rpg.guilds.thieves.rank, 2);
  assert.match(serve(ctx, p, tgFence, 'sellItems').text, /No questions asked/);
  assert.match(serve(ctx, p, tgFence, 'spymaster').text, /not risen high enough .* Locksmith/);
  setRep(ctx, p, 42, 40);
  ctx.clock.minutes += 28 * DAY;
  talk(ctx, p, tgFence);
  assert.equal(p.rpg.guilds.thieves.rank, 4);
  assert.equal(serve(ctx, p, tgFence, 'spymaster').spymaster, true);

  // Dark Brotherhood: potions (1), makePotions (3), soulgems (5), spymaster (7) via live alchemy.js & guilds.js.
  assert.match(serve(ctx, p, dbStaff, 'potions').text, /not risen high enough .* Shade/);
  for (const [rank, svc, nextLocked] of [
    [1, 'potions', 'makePotions'],
    [3, 'makePotions', 'soulgems'],
    [5, 'soulgems', 'spymaster'],
  ]) {
    setRep(ctx, p, 108, RANK_REQ_REPUTATION[rank]);
    ctx.clock.minutes += 28 * DAY;
    talk(ctx, p, dbStaff);
    assert.equal(p.rpg.guilds.brotherhood.rank, rank);
    ctx.notes.length = 0;
    serve(ctx, p, dbStaff, svc);
    assert.ok(ctx.notes.some((n) => n.ev.kind === 'alchemyPanel' && n.ev.service === svc), `DB ${svc} opens at rank ${rank}`);
    assert.match(serve(ctx, p, dbStaff, nextLocked).text, /not risen high enough/);
  }
  setRep(ctx, p, 108, 70);
  ctx.clock.minutes += 28 * DAY;
  talk(ctx, p, dbStaff);
  assert.equal(p.rpg.guilds.brotherhood.rank, 7);
  assert.equal(serve(ctx, p, dbStaff, 'spymaster').spymaster, true);

  // Negative reputation demotes both to rank 0 instead of expelling.
  setRep(ctx, p, 42, -30);
  setRep(ctx, p, 108, -30);
  ctx.clock.minutes += 28 * DAY;
  talk(ctx, p, tgFence);
  talk(ctx, p, dbStaff);
  assert.equal(p.rpg.guilds.thieves.rank, 0);
  assert.equal(p.rpg.guilds.brotherhood.rank, 0);
});

// ------------------------------------------------------------------------------------------- After-hours hall access with buildingAccess

test('after-hours guild hall access integrates with buildingAccess for public guild halls and secret halls', () => {
  const ctx = makeCtx({ minutes: 1000 * DAY + 2 * 60 }); // 02:00 AM (after hours)
  const access = buildingAccess(ctx);
  const p = makePlayer();
  ctx.join(p);

  const fgDoor = { kind: 'building', label: 'Fighters Guild', meta: { buildingType: 11, factionId: 41, regionIndex: 17 } };
  const mgDoor = { kind: 'building', label: 'Mages Guild', meta: { buildingType: 11, factionId: 40, regionIndex: 17 } };
  const tgDoor = { kind: 'building', label: 'Thieves Guild', meta: { buildingType: 18, factionId: 42, regionIndex: 17 } };
  const dbDoor = { kind: 'building', label: 'Dark Brotherhood', meta: { buildingType: 18, factionId: 108, regionIndex: 17 } };

  // Non-member at 02:00: all locked.
  assert.match(access.lockedReason(p, fgDoor), /locked/);
  assert.match(access.lockedReason(p, mgDoor), /locked/);
  assert.match(access.lockedReason(p, tgDoor), /locked/);
  assert.match(access.lockedReason(p, dbDoor), /locked/);

  // Rank 5 in Fighters & Mages: still locked after hours.
  ctx.services.guilds.addMembership(p, 'fighters', null, 5);
  ctx.services.guilds.addMembership(p, 'mages', null, 5);
  assert.match(access.lockedReason(p, fgDoor), /locked/);
  assert.match(access.lockedReason(p, mgDoor), /locked/);

  // Rank 6 in Fighters & Mages: unlocked after hours.
  p.rpg.guilds.fighters.rank = 6;
  p.rpg.guilds.mages.rank = 6;
  assert.equal(access.lockedReason(p, fgDoor), undefined);
  assert.equal(access.lockedReason(p, mgDoor), undefined);

  // Rank 0 in Thieves Guild & Dark Brotherhood: private halls (House2) unlocked at any hour.
  ctx.services.guilds.addMembership(p, 'thieves', null, 0);
  ctx.services.guilds.addMembership(p, 'brotherhood', null, 0);
  assert.equal(access.lockedReason(p, tgDoor), undefined);
  assert.equal(access.lockedReason(p, dbDoor), undefined);
  assert.equal(GROUPS.thieves.noExpulsion, true);
  assert.equal(GROUPS.brotherhood.noExpulsion, true);
});
