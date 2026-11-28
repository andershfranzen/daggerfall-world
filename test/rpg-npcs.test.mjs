import { test } from 'node:test';
import assert from 'node:assert/strict';
import { install, rosterFor, TALK_RANGE } from '../server/rpg/npcs.js';
import { buyPrice, sellPrice, rankFor, eligibleToJoin } from '../server/rpg/npcs/rules.js';
import { GUILDS, SLOTS, ROLES } from '../server/rpg/npcs/data.js';
import { install as installCharacter } from '../server/rpg/character.js';

const HOME = 'town:Daggerfall/Gothway Garden';

/** Minimal runtime matching docs/gameplay-protocol.md. */
function makeCtx() {
  const handlers = { join: [], leave: [], tick: [], actions: new Map(), events: new Map() };
  let now = 1000;
  const ctx = {
    players: new Map(),
    entities: new Map(),
    services: {},
    notes: [],
    emitted: [],
    dirtied: new Set(),
    onJoin: (fn) => handlers.join.push(fn),
    onLeave: (fn) => handlers.leave.push(fn),
    onTick: (fn) => handlers.tick.push(fn),
    onAction: (verb, fn) => handlers.actions.set(verb, fn),
    on: (name, fn) => { if (!handlers.events.has(name)) handlers.events.set(name, []); handlers.events.get(name).push(fn); },
    emit: (name, payload) => { ctx.emitted.push({ name, payload }); for (const fn of handlers.events.get(name) || []) fn(payload); },
    notify: (p, ev) => ctx.notes.push({ to: p.id, ev }),
    nearby: () => {},
    dirty: (p) => ctx.dirtied.add(p.id),
    now: () => now,
    advance: (ms) => { now += ms; for (const fn of handlers.tick) fn(ms / 1000, now); },
  };
  // Equipment stand-in: a tiny catalogue and atomic give/take.
  let seq = 0;
  ctx.services.giveItem = (p, template, quantity = 1) => {
    if (template === 'forbidden') throw new Error('Unknown item');
    p.rpg.inventory.push({ id: `i${++seq}`, template, name: template, quantity });
  };
  ctx.services.takeItem = (p, itemId, quantity = 1) => {
    const i = p.rpg.inventory.findIndex((x) => x.id === itemId);
    if (i < 0 || p.rpg.inventory[i].quantity < quantity) throw new Error('Not in inventory');
    p.rpg.inventory[i].quantity -= quantity;
    if (p.rpg.inventory[i].quantity === 0) p.rpg.inventory.splice(i, 1);
  };
  ctx.act = (p, verb, args) => handlers.actions.get(verb)(p, args);
  ctx.join = (p) => { ctx.players.set(p.id, p); for (const fn of handlers.join) fn(p); };
  ctx.leave = (p) => { ctx.players.delete(p.id); for (const fn of handlers.leave) fn(p); };
  ctx.last = (p) => [...ctx.notes].reverse().find((n) => n.to === p.id)?.ev;
  return ctx;
}

let pid = 0;
function player(rpg = {}) {
  return {
    id: ++pid, name: `Hero${pid}`, x: 0, z: 0, yaw: 0, moving: false,
    rpg: {
      location: HOME,
      gold: 500,
      inventory: [],
      equipment: {},
      character: {
        race: 'Breton', className: 'Warrior', level: 1, health: 20, maxHealth: 40, fatigue: 10, maxFatigue: 50,
        magicka: 0, maxMagicka: 0, skills: { 'Long Blade': 30, Axe: 10, Mercantile: 0, Destruction: 2 },
      },
      ...rpg,
    },
  };
}

function setup({ character = false } = {}) {
  const ctx = makeCtx();
  if (character) installCharacter(ctx);
  install(ctx);
  const p = player();
  if (character) p.rpg.character.attributes = {};
  ctx.join(p);
  const npcs = [...ctx.entities.values()].filter((e) => e.kind === 'npc');
  const byRole = (role) => npcs.find((e) => e.role === role);
  const goTo = (pl, e) => { pl.x = e.x; pl.z = e.z + 1; };
  const talk = (pl, e) => { goTo(pl, e); return ctx.act(pl, 'npc.talk', { targetId: e.id }); };
  return { ctx, p, npcs, byRole, goTo, talk };
}

test('rosters are deterministic, named, sprited and stand in the clear lane ahead of spawn', () => {
  const a = rosterFor(HOME);
  const b = rosterFor(HOME);
  assert.deepEqual(a, b);
  assert.ok(a.length >= 5);
  assert.equal(new Set(a.map((n) => n.name)).size, a.length, 'names are unique');
  for (const n of a) {
    assert.equal(n.kind, 'npc');
    assert.ok(ROLES[n.role]);
    assert.ok(Number.isInteger(n.sprite.archive) && Number.isInteger(n.sprite.record));
    assert.ok(Math.abs(n.x) <= 0.5 && n.z <= -2.5 && n.z >= -12, 'inside the lane findSpawn keeps clear');
    assert.ok(Math.hypot(n.x, n.z) > 1.5, 'not on top of the spawn point');
  }
  // Garden district: herbalist and both guilds; quest giver and merchant closest to spawn.
  const roles = a.map((n) => n.role);
  assert.deepEqual(roles.slice(0, 2), ['crier', 'merchant']);
  assert.ok(roles.includes('herbalist') && roles.includes('fighters') && roles.includes('mages'));
  assert.ok(Math.hypot(a[0].x, a[0].z) < TALK_RANGE + 1, 'quest giver is a step from spawn');
  // Other districts get appropriate trades; wilderness gets nobody.
  assert.ok(rosterFor('town:Daggerfall/Old Market').some((n) => n.role === 'smith'));
  assert.ok(rosterFor('town:Wayrest/Harbour Docks').some((n) => n.role === 'innkeeper'));
  assert.deepEqual(rosterFor('dungeon:Daggerfall/Crypt'), []);
  assert.notDeepEqual(rosterFor('town:Daggerfall/Other Place').map((n) => n.name), a.map((n) => n.name));
  assert.equal(SLOTS.length >= a.length, true);
});

test('roster is shared: entities are created once and seen by every player', () => {
  const { ctx, npcs } = setup();
  const before = ctx.entities.size;
  ctx.join(player());
  assert.equal(ctx.entities.size, before);
  assert.equal(npcs.length, rosterFor(HOME).length);
  // Arrival in a new town (travel) spawns that roster on the next tick.
  const q = player({ location: 'town:Daggerfall/Castle Hold' });
  ctx.players.set(q.id, q);
  ctx.advance(40);
  assert.ok([...ctx.entities.values()].some((e) => e.location === 'town:Daggerfall/Castle Hold' && e.role === 'noble'));
});

test('talking requires being close, in the same location, to a real NPC', () => {
  const { ctx, p, byRole, talk } = setup();
  const crier = byRole('crier');
  p.x = 0; p.z = crier.z + TALK_RANGE + 2;
  assert.throws(() => ctx.act(p, 'npc.talk', { targetId: crier.id }), /too far/);
  assert.throws(() => ctx.act(p, 'npc.talk', { targetId: 'npc:nope:0' }), /nobody/);
  assert.throws(() => ctx.act(p, 'npc.talk', {}), /whom/);
  assert.throws(() => ctx.act(p, 'npc.talk', null), /whom/);
  const elsewhere = player({ location: 'town:Daggerfall/Old Market' });
  ctx.join(elsewhere);
  elsewhere.x = crier.x; elsewhere.z = crier.z;
  assert.throws(() => ctx.act(elsewhere, 'npc.talk', { targetId: crier.id }), /not here/);

  const v = talk(p, crier);
  assert.equal(v.kind, 'dialogue');
  assert.equal(v.npc.id, crier.id);
  assert.ok(v.session);
  assert.ok(v.journal, 'quest giver offers the journal');
  assert.ok(v.topics.some((t) => t.id === 'work'));
  const talkEv = ctx.emitted.find((x) => x.name === 'talk');
  assert.equal(talkEv.payload.player, p);
  assert.equal(talkEv.payload.entity, crier);
  assert.deepEqual(ctx.last(p), v);
});

test('topics give meaningful replies; work emits npcWork; unknown topics are refused', () => {
  const { ctx, p, byRole, talk } = setup();
  const crier = byRole('crier');
  const v = talk(p, crier);
  const work = ctx.act(p, 'npc.topic', { targetId: crier.id, session: v.session, topic: 'work' });
  assert.match(work.text, /hear me out/i);
  assert.ok(work.journal);
  assert.ok(ctx.emitted.some((x) => x.name === 'npcWork' && x.payload.entity === crier));
  const dir = ctx.act(p, 'npc.topic', { targetId: crier.id, session: v.session, topic: 'directions' });
  assert.match(dir.text, /m (north|south|east|west)/);
  assert.throws(() => ctx.act(p, 'npc.topic', { targetId: crier.id, session: v.session, topic: 'trade' }), /nothing to say/);
});

test('directions never name another player’s private quest NPCs', () => {
  const { ctx, p, byRole, talk } = setup();
  const crier = byRole('crier');
  const base = { kind: 'npc', location: crier.location, x: crier.x + 3, z: crier.z, title: 'Resident', role: 'resident' };
  ctx.entities.set('qnpc:other', { ...base, id: 'qnpc:other', name: 'Hidden Questperson', visibleTo: ['someone-else'] });
  ctx.entities.set('qnpc:mine', { ...base, id: 'qnpc:mine', name: 'Own Questperson', visibleTo: [p.id] });
  const v = talk(p, crier);
  const dir = ctx.act(p, 'npc.topic', { targetId: crier.id, session: v.session, topic: 'directions' });
  assert.doesNotMatch(dir.text, /Hidden Questperson/);
  assert.match(dir.text, /Own Questperson/);
});

test('stale sessions and walking away end the conversation', () => {
  const { ctx, p, byRole, talk, goTo } = setup();
  const crier = byRole('crier');
  const merchant = byRole('merchant');
  const v1 = talk(p, crier);
  const v2 = talk(p, merchant);
  goTo(p, crier);
  assert.throws(() => ctx.act(p, 'npc.topic', { targetId: crier.id, session: v1.session, topic: 'news' }), /ended/);
  goTo(p, merchant);
  assert.throws(() => ctx.act(p, 'npc.topic', { targetId: merchant.id, session: 'forged', topic: 'news' }), /ended/);
  ctx.act(p, 'npc.topic', { targetId: merchant.id, session: v2.session, topic: 'trade' });
  p.z += 10;
  ctx.advance(40);
  assert.equal(ctx.last(p).kind, 'dialogue.end');
  goTo(p, merchant);
  assert.throws(() => ctx.act(p, 'npc.buy', { targetId: merchant.id, session: v2.session, key: 'bread', quantity: 1, price: 3 }), /ended/);
});

test('buying and selling conserve gold and goods and validate prices, stock and range', () => {
  const { ctx, p, byRole, talk } = setup();
  const m = byRole('merchant');
  const v = talk(p, m);
  assert.throws(() => ctx.act(p, 'npc.buy', { targetId: m.id, session: v.session, key: 'potion-of-stamina', price: 1 }), /not trading/);
  const shopView = ctx.act(p, 'npc.topic', { targetId: m.id, session: v.session, topic: 'trade' });
  const pot = shopView.shop.items.find((i) => i.key === 'potion-of-stamina');
  const purse0 = shopView.shop.purse;
  const total0 = p.rpg.gold + purse0;

  assert.throws(() => ctx.act(p, 'npc.buy', { targetId: m.id, session: v.session, key: 'potion-of-stamina', quantity: 2, price: pot.price - 1 }), /price has changed/);
  assert.throws(() => ctx.act(p, 'npc.buy', { targetId: m.id, session: v.session, key: 'potion-of-stamina', quantity: 0, price: pot.price }), /quantity/);
  assert.throws(() => ctx.act(p, 'npc.buy', { targetId: m.id, session: v.session, key: 'potion-of-stamina', quantity: 1.5, price: pot.price }), /quantity/);
  assert.throws(() => ctx.act(p, 'npc.buy', { targetId: m.id, session: v.session, key: 'potion-of-stamina', quantity: pot.quantity + 1, price: pot.price }), /only has/);
  assert.throws(() => ctx.act(p, 'npc.buy', { targetId: m.id, session: v.session, key: 'dragon', quantity: 1, price: 1 }), /no longer/);
  assert.equal(p.rpg.gold + purse0, total0, 'failed attempts change nothing');

  const after = ctx.act(p, 'npc.buy', { targetId: m.id, session: v.session, key: 'potion-of-stamina', quantity: 3, price: pot.price });
  assert.equal(p.rpg.gold, 500 - 3 * pot.price);
  assert.equal(after.shop.purse + p.rpg.gold, total0, 'gold is conserved');
  assert.equal(after.shop.items.find((i) => i.key === 'potion-of-stamina').quantity, pot.quantity - 3);
  const owned = p.rpg.inventory.find((i) => i.template === 'potion-of-stamina');
  assert.equal(owned.quantity, 3);

  // Sell back: price below purchase price, goods return to stock.
  const offer = after.shop.sellable.find((s) => s.itemId === owned.id);
  assert.ok(offer.price < pot.price, 'no buy/sell arbitrage');
  const sold = ctx.act(p, 'npc.sell', { targetId: m.id, session: v.session, itemId: owned.id, quantity: 2, price: offer.price });
  assert.equal(sold.shop.purse + p.rpg.gold, total0, 'gold still conserved');
  assert.equal(owned.quantity, 1);
  assert.equal(sold.shop.items.find((i) => i.key === 'potion-of-stamina').quantity, pot.quantity - 1);
  assert.throws(() => ctx.act(p, 'npc.sell', { targetId: m.id, session: v.session, itemId: owned.id, quantity: 5, price: offer.price }), /only have/);
  assert.throws(() => ctx.act(p, 'npc.sell', { targetId: m.id, session: v.session, itemId: 'ghost', quantity: 1, price: 1 }), /no longer have/);

  // Equipped and quest items cannot be sold.
  p.rpg.inventory.push({ id: 'sword', template: 'iron-longsword', name: 'Iron Longsword', quantity: 1 });
  p.rpg.inventory.push({ id: 'letter', template: 'parchment', name: 'Sealed Letter', quantity: 1, quest: true });
  p.rpg.equipment.rightHand = 'sword';
  assert.throws(() => ctx.act(p, 'npc.sell', { targetId: m.id, session: v.session, itemId: 'sword', quantity: 1, price: 1 }), /Unequip/);
  assert.throws(() => ctx.act(p, 'npc.sell', { targetId: m.id, session: v.session, itemId: 'letter', quantity: 1, price: 1 }), /will not take/);

  // Out of range after moving away, even with a live token.
  p.z += 20;
  assert.throws(() => ctx.act(p, 'npc.buy', { targetId: m.id, session: v.session, key: 'potion-of-stamina', quantity: 1, price: pot.price }), /too far/);
});

test('cannot buy without gold; merchant purse limits sales; give failure changes nothing', () => {
  const { ctx, p, byRole, talk } = setup();
  const m = byRole('merchant');
  const v = talk(p, m);
  const s = ctx.act(p, 'npc.topic', { targetId: m.id, session: v.session, topic: 'trade' });
  const staff = s.shop.items.find((i) => i.key === 'iron-staff');
  p.rpg.gold = 0;
  assert.throws(() => ctx.act(p, 'npc.buy', { targetId: m.id, session: v.session, key: 'iron-staff', quantity: 1, price: staff.price }), /need/);
  assert.equal(p.rpg.inventory.length, 0);

  p.rpg.inventory.push({ id: 'gem', template: 'gem', name: 'Huge Gem', quantity: 1, value: 100000 });
  const s2 = ctx.act(p, 'npc.topic', { targetId: m.id, session: v.session, topic: 'trade' });
  const gem = s2.shop.sellable.find((x) => x.itemId === 'gem');
  assert.throws(() => ctx.act(p, 'npc.sell', { targetId: m.id, session: v.session, itemId: 'gem', quantity: 1, price: gem.price }), /cannot afford/);
  assert.equal(p.rpg.gold, 0);
  assert.ok(p.rpg.inventory.some((i) => i.id === 'gem'));
});

test('a second trader sees the first trader’s purchase and stale prices are refused', () => {
  const { ctx, p, byRole, talk } = setup();
  const m = byRole('merchant');
  const q = player();
  ctx.join(q);
  const a = talk(p, m);
  const b = talk(q, m);
  ctx.act(p, 'npc.topic', { targetId: m.id, session: a.session, topic: 'trade' });
  const qs = ctx.act(q, 'npc.topic', { targetId: m.id, session: b.session, topic: 'trade' });
  const amber = qs.shop.items.find((i) => i.key === 'amber');
  ctx.act(p, 'npc.buy', { targetId: m.id, session: a.session, key: 'amber', quantity: amber.quantity, price: amber.price });
  const pushed = ctx.last(q);
  assert.equal(pushed.kind, 'dialogue');
  assert.ok(!pushed.shop.items.some((i) => i.key === 'amber'), 'other trader view refreshed');
  assert.throws(() => ctx.act(q, 'npc.buy', { targetId: m.id, session: b.session, key: 'amber', quantity: 1, price: amber.price }), /no longer/);
});

test('reputation changes prices and hostile NPCs refuse trade', () => {
  assert.ok(buyPrice(100, 0, 50) < buyPrice(100, 0, 0));
  assert.ok(buyPrice(100, 100, 100) >= 100);
  assert.ok(sellPrice(100, 100, 100) <= 60);
  const { ctx, p, byRole, talk } = setup();
  const m = byRole('merchant');
  ctx.services.adjustReputation(p, 900, -50);
  const v = talk(p, m);
  assert.equal(v.attitude, 'hostile');
  assert.deepEqual(v.topics, []);
  assert.throws(() => ctx.act(p, 'npc.topic', { targetId: m.id, session: v.session, topic: 'trade' }), /refuses/);
  assert.equal(ctx.services.adjustReputation(p, 900, 1000), 100, 'reputation is clamped');
});

test('joining a guild checks skills and reputation; rank rises with reputation', () => {
  const { ctx, p, byRole, talk } = setup();
  const fg = byRole('fighters');
  const mg = byRole('mages');
  // Mages: Destruction 2 is too low.
  let v = talk(p, mg);
  v = ctx.act(p, 'npc.service', { targetId: mg.id, session: v.session, service: 'join' });
  assert.match(v.text, /lack the skills/);
  assert.equal(p.rpg.guilds.mages, undefined);
  // Fighters: Long Blade 30 (high) + Axe 10 (low) qualifies.
  ctx.services.adjustReputation(p, 41, -5);
  v = talk(p, fg);
  v = ctx.act(p, 'npc.service', { targetId: fg.id, session: v.session, service: 'join' });
  assert.match(v.text, /reputation/);
  ctx.services.adjustReputation(p, 41, 5);
  v = ctx.act(p, 'npc.service', { targetId: fg.id, session: v.session, service: 'join' });
  assert.match(v.text, /Welcome/);
  assert.equal(p.rpg.guilds.fighters.rank, 0);
  assert.ok(v.guild.member);
  assert.ok(!v.services.some((s) => s.id === 'join'));
  assert.ok(v.services.some((s) => s.id === 'train'));
  assert.ok(ctx.emitted.some((x) => x.name === 'guildJoin'));
  v = ctx.act(p, 'npc.service', { targetId: fg.id, session: v.session, service: 'join' });
  assert.match(v.text, /already one of us/);

  // Quest completions raise reputation; the next conversation promotes.
  ctx.emit('questCompleted', { player: p, factionId: 41, reputation: 10 });
  assert.equal(ctx.services.reputation(p, 41), 11);
  assert.equal(p.rpg.guilds.fighters.rank, 1, 'promoted on quest completion');
  assert.ok(ctx.dirtied.has(p.id));
  assert.equal(rankFor(p.rpg.character, GUILDS.fighters, 90), 1, 'skills cap the rank');
  assert.ok(eligibleToJoin({ skills: { Axe: 22, Archery: 4 } }, GUILDS.fighters, 0).ok);
  assert.ok(!eligibleToJoin({ skills: { Axe: 22 } }, GUILDS.fighters, 0).ok);
});

test('guild training charges gold, adds practice, limits what the tutor teaches, and survives reconnect', () => {
  const { ctx, p, byRole, talk } = setup({ character: true });
  const fg = byRole('fighters');
  let v = talk(p, fg);
  assert.throws(() => ctx.act(p, 'npc.service', { targetId: fg.id, session: v.session, service: 'train', skill: 'Long Blade' }), /does not offer|Only members/);
  ctx.act(p, 'npc.service', { targetId: fg.id, session: v.session, service: 'join' });
  v = talk(p, fg);
  const t = v.guild.training.find((x) => x.skill === 'Long Blade');
  ctx.act(p, 'npc.service', { targetId: fg.id, session: v.session, service: 'train', skill: 'Long Blade' });
  assert.equal(p.rpg.character.skills['Long Blade'], 30, 'three hours do not yet complete a six-hour practice window');
  assert.ok(p.rpg.character.skillUses['Long Blade'] >= 20 && p.rpg.character.skillUses['Long Blade'] <= 40);
  assert.equal(p.rpg.atmosphere.personalMinutes, 180);
  assert.equal(p.rpg.gold, 500 - t.cost);
  p.rpg.character.skills['Long Blade'] = t.max + 1;
  assert.throws(() => ctx.act(p, 'npc.service', { targetId: fg.id, session: v.session, service: 'train', skill: 'Long Blade' }), /learned all we can teach/);
  ctx.leave(p);
  ctx.join(p);
  v = talk(p, fg);
  assert.throws(() => ctx.act(p, 'npc.service', { targetId: fg.id, session: v.session, service: 'train', skill: 'Axe' }), /too tired/);
  const gold = p.rpg.gold;
  ctx.advance(90_000);
  v = talk(p, fg);
  ctx.act(p, 'npc.service', { targetId: fg.id, session: v.session, service: 'train', skill: 'Axe' });
  assert.equal(p.rpg.character.skills.Axe, 10);
  assert.ok(p.rpg.character.skillUses.Axe >= 20);
  assert.ok(p.rpg.gold < gold);
  assert.throws(() => ctx.act(p, 'npc.service', { targetId: fg.id, session: v.session, service: 'train', skill: 'Destruction' }), /does not teach/);
  assert.throws(() => ctx.act(p, 'npc.service', { targetId: fg.id, session: v.session, service: 'heal' }), /does not offer/);
});

test('temple heals for gold and donations raise standing', () => {
  const { ctx, p, byRole, talk } = setup();
  const pr = byRole('priest');
  const v = talk(p, pr);
  const heal = v.services.find((s) => s.id === 'heal');
  assert.equal(heal.cost, 40);
  ctx.act(p, 'npc.service', { targetId: pr.id, session: v.session, service: 'heal' });
  assert.equal(p.rpg.character.health, 40);
  assert.equal(p.rpg.gold, 460);
  ctx.act(p, 'npc.service', { targetId: pr.id, session: v.session, service: 'donate' });
  assert.equal(p.rpg.gold, 360);
  assert.equal(ctx.services.reputation(p, 82), 2);
  p.rpg.gold = 50;
  assert.throws(() => ctx.act(p, 'npc.service', { targetId: pr.id, session: v.session, service: 'donate' }), /need 100/);
  assert.equal(p.rpg.gold, 50);
});

test('persistent state survives a JSON round trip and a server restart', () => {
  const a = setup();
  const fg = a.byRole('fighters');
  const v = a.talk(a.p, fg);
  a.ctx.act(a.p, 'npc.service', { targetId: fg.id, session: v.session, service: 'join' });
  a.ctx.services.adjustReputation(a.p, 201, 7);
  const saved = JSON.parse(JSON.stringify(a.p.rpg));

  const b = makeCtx();
  install(b);
  const p2 = { id: 99, name: a.p.name, x: 0, z: 0, yaw: 0, moving: false, rpg: saved };
  b.join(p2);
  assert.equal(b.services.guildRank(p2, 'fighters'), 0);
  assert.equal(b.services.reputation(p2, 201), 7);
  assert.equal(b.services.reputation(p2, 41), 1);
  assert.deepEqual([...b.entities.keys()].sort(), [...a.ctx.entities.keys()].sort(), 'same NPC ids after restart');

  // Garbage persisted state is normalised, not trusted.
  const p3 = { id: 100, name: 'X', x: 0, z: 0, rpg: { location: HOME, factions: { 41: 'lots' }, guilds: { bogus: {}, fighters: { rank: 42 } }, gold: -5 } };
  b.join(p3);
  assert.equal(b.services.reputation(p3, 41), 0);
  assert.equal(p3.rpg.guilds.bogus, undefined);
  assert.equal(p3.rpg.guilds.fighters.rank, 9);
  assert.equal(p3.rpg.gold, 0);
});

test('town kills earn a little court standing; leaving drops the session', () => {
  const { ctx, p, byRole, talk } = setup();
  ctx.emit('kill', { player: p, entity: { kind: 'monster' } });
  assert.equal(ctx.services.reputation(p, 201), 1);
  const v = talk(p, byRole('crier'));
  ctx.leave(p);
  ctx.join(p);
  assert.throws(() => ctx.act(p, 'npc.topic', { targetId: v.npc.id, session: v.session, topic: 'news' }), /ended/);
});

test('dialogue view gold and services honor letters of credit via spendableGold/spendGold', () => {
  const { ctx, p, byRole, talk } = setup();
  let credit = 300;
  ctx.services.spendableGold = (pl) => pl.rpg.gold + credit;
  ctx.services.spendGold = (pl, amount) => {
    const fromPurse = Math.min(pl.rpg.gold, amount);
    pl.rpg.gold -= fromPurse;
    credit -= (amount - fromPurse);
  };
  p.rpg.gold = 20;
  const pr = byRole('priest');
  const v = talk(p, pr);
  assert.equal(v.gold, 320, 'view.gold includes letters of credit');
  ctx.act(p, 'npc.service', { targetId: pr.id, session: v.session, service: 'heal' });
  assert.equal(p.rpg.character.health, 40);
  assert.equal(p.rpg.gold, 0);
  assert.equal(credit, 280);
  ctx.act(p, 'npc.service', { targetId: pr.id, session: v.session, service: 'donate' });
  assert.equal(credit, 180);
});
