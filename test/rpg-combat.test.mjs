// Server combat: shared monsters, classic rolls, AI, defeat/resurrection, single-claim loot.
// Runtime fixtures use the real runtime plus the real character and inventory features with a
// manual clock and a seeded PRNG; the last test drives two real WebSocket clients.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createRpgRuntime, DEFAULT_LOCATION } from '../server/rpg/runtime.js';
import { install as character } from '../server/rpg/character.js';
import { install as inventory } from '../server/rpg/inventory.js';
import * as combat from '../server/rpg/combat.js';
import { MONSTERS, MONSTER_BY_ID, ENCOUNTER_TABLES, chooseEncounter, LOOT_TABLES } from '../server/rpg/combat/monsters.js';
import { successfulHit, weaponOf, swingSeconds, armorToHit } from '../server/rpg/combat/formulas.js';
import { createGameServer } from '../server/game.js';

function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RAT = 0;
const IMP = 1;
const ORC = 7;

/** Real runtime + character + inventory + combat, manual clock, in-process clients. */
function world({ seed = 1, combatOptions = {}, services = {} } = {}) {
  let clock = 1000;
  const players = new Map();
  const inbox = new Map(); // id -> messages
  const emitted = [];
  let handle;
  const rt = createRpgRuntime({
    players,
    features: [
      { name: 'character', install: character },
      { name: 'inventory', install: inventory },
      {
        name: 'combat',
        install: (ctx) => {
          ctx.on('kill', (ev) => emitted.push(['kill', ev.entity.id, ev.player.id]));
          handle = combat.install(ctx, { random: seeded(seed), demoPath: [], nightSites: {}, ...combatOptions });
        },
      },
    ],
    save: () => {},
    send: (p, msg) => inbox.get(p.id)?.push(JSON.parse(JSON.stringify(msg))),
    now: () => clock,
    services,
    log: { error() {}, warn() {} },
  });
  const join = (id, name, x = 0, z = 0, rpg = {}) => {
    const p = { id, name, x, z, yaw: 0, moving: false, rpg };
    players.set(id, p);
    inbox.set(id, []);
    rt.join(p);
    rt.sync([p]);
    return p;
  };
  const tick = (seconds, dt = 0.04) => {
    for (let t = 0; t < seconds; t += dt) {
      clock += dt * 1000;
      rt.tick(dt, clock);
    }
    rt.sync();
  };
  const events = (id, kind) => inbox.get(id).filter((m) => m.type === 'gameEvent' && (!kind || m.event.kind === kind)).map((m) => m.event);
  const lastRpg = (id) => inbox.get(id).filter((m) => m.type === 'rpg').at(-1);
  const act = (p, verb, args) => rt.act(p, verb, args);
  return {
    rt, players, ctx: rt.ctx, S: rt.ctx.services, get handle() { return handle; }, join, tick, events, lastRpg, act, emitted,
    advance: (ms) => (clock += ms), now: () => clock,
  };
}

/** Face `p` toward entity `e` (yaw 0 faces -z). */
const faceTo = (p, e) => (p.yaw = Math.atan2(e.x - p.x, -(e.z - p.z)));

test('monster table and encounter tables follow the classic data', () => {
  assert.equal(MONSTERS.length, 42);
  const rat = MONSTER_BY_ID.get(RAT);
  assert.deepEqual([rat.name, rat.texture, rat.corpse, rat.level, rat.armor, rat.health], ['Rat', 255, [401, 1], 1, 6, [9, 16]]);
  const ghost = MONSTER_BY_ID.get(18);
  assert.equal(ghost.name, 'Ghost');
  assert.equal(ghost.minMetal, 2); // silver
  assert.equal(MONSTER_BY_ID.get(32).name, 'Lich');
  assert.deepEqual(MONSTER_BY_ID.get(2).attacks, [[1, 8], [1, 8], [1, 10]]); // spriggan: three rolls
  for (const [k, table] of Object.entries(ENCOUNTER_TABLES)) assert.equal(table.length, 20, `table ${k}`);
  const r = seeded(9);
  for (let i = 0; i < 200; i++) {
    const id = chooseEncounter(0, 1, r);
    assert.ok(ENCOUNTER_TABLES[0].includes(id) && MONSTER_BY_ID.has(id));
    // Level 1 never meets the crypt's top entries outside the 5% roll window (index <= 3).
    assert.ok(ENCOUNTER_TABLES[0].indexOf(id) <= 5);
  }
  assert.deepEqual(LOOT_TABLES.A.slice(0, 2), [1, 10]);
});

test('formulas: clamped to-hit, weapon records, swing timing, armour', () => {
  const view = { agility: 50, luck: 50, criticalStrike: 0, dodging: 0, armor: Array(7).fill(100), monster: false };
  // chance clamps to 3..97: with random()=0 the d100 roll is 1, always inside the clamp.
  assert.equal(successfulHit(view, view, -500, 0, () => 0), true);
  assert.equal(successfulHit(view, view, 500, 0, () => 0.99), false); // a 100 never hits
  const w = weaponOf({ template: 'steel-longsword', base: 'longsword', material: 'steel', skill: 'Long Blade', damage: { min: 2, max: 16 }, weaponType: 'LongBlade' });
  assert.deepEqual([w.materialIndex, w.materialMod, w.min, w.max, w.bow], [1, 0, 2, 16, false]);
  assert.equal(weaponOf({ template: 'unarmed' }), null);
  assert.ok(Math.abs(swingSeconds(50) - 1.0) < 0.01);
  assert.deepEqual(armorToHit({ head: 3, chest: 9 }), [85, 100, 100, 55, 100, 100, 100]);
});

test('directional strikes and fatigue use authoritative combat values', () => {
  const w = world({ combatOptions: { random: () => 0.1 } });
  const a = w.join(1, 'Ann');
  a.rpg.character.attributes.Strength = 50;
  const blade = w.S.giveItem(a, 'steel-longsword', 1);
  assert.ok(w.act(a, 'inventory.equip', { itemId: blade.id }).ok);
  assert.ok(w.act(a, 'combat.ready', { ready: true }).ok);
  const foe = w.handle.spawnMonster(DEFAULT_LOCATION, RAT, 0, -2, { team: 1, yaw: Math.PI });
  foe.hp = foe.maxHp = 100;
  const fatigue = a.rpg.character.fatigue;
  for (const direction of ['up', 'down', 'left', 'right', 'downLeft', 'downRight']) {
    assert.ok(w.act(a, 'combat.attack', { targetId: foe.id, direction }).ok);
    w.advance(2000);
  }
  assert.deepEqual(w.events(1, 'swing').map((e) => e.direction), ['up', 'down', 'left', 'right', 'downLeft', 'downRight']);
  assert.equal(w.events(1, 'hit')[0].damage, 7, 'downward hit gains four points over a side strike');
  assert.equal(a.rpg.character.fatigue, fatigue - 1, 'six swings accrue one displayed fatigue point');
  a.rpg.character.fatigue = 0;
  assert.match(w.act(a, 'combat.attack', { direction: 'up' }).error, /exhausted/);
});

test('arrows spend ammunition at launch and hit only along their flight path', () => {
  let wall = false;
  const w = world({
    combatOptions: { random: () => 0.2 },
    services: { canSee: (_where, _x1, z1, _x2, z2) => !wall || z1 <= -3 || z2 > -3 },
  });
  const a = w.join(1, 'Ann');
  a.rpg.character.skills.Archery = 100;
  const bow = w.S.giveItem(a, 'steel-short-bow', 1);
  const ammo = w.S.giveItem(a, 'arrow', 3);
  assert.ok(w.act(a, 'inventory.equip', { itemId: bow.id }).ok);
  assert.ok(w.act(a, 'combat.ready', { ready: true }).ok);
  const rat = w.handle.spawnMonster(DEFAULT_LOCATION, RAT, 0, -9, { team: 1, yaw: Math.PI });
  rat.hp = rat.maxHp = 100;
  const quantity = () => a.rpg.inventory.find((it) => it.id === ammo.id)?.quantity ?? 0;
  const before = quantity();
  const shoot = () => assert.ok(w.act(a, 'combat.attack', { targetId: rat.id }).ok);
  shoot();
  assert.equal(quantity(), before - 1);
  assert.equal(rat.hp, 100);
  wall = true;
  w.tick(0.4);
  assert.equal(rat.hp, 100, 'the wall closed after release but before impact');
  wall = false;
  w.advance(2000);
  shoot();
  rat.x = 1.3;
  rat._home.x = 1.3;
  w.tick(0.4);
  assert.equal(rat.hp, 100, 'moving away avoids a released arrow');
  rat.x = rat._home.x = 0;
  w.advance(2000);
  shoot();
  w.tick(0.1);
  assert.equal(rat.hp, 100);
  w.tick(0.24);
  assert.ok(rat.hp < 100);
  assert.equal(w.events(1, 'arrowLaunch').length, 3);
  assert.deepEqual(w.events(1, 'arrowImpact').slice(0, 2).map((e) => e.reason), ['wall', 'target']);
  const [wallImpact, targetImpact] = w.events(1, 'arrowImpact');
  assert.equal(wallImpact.location, DEFAULT_LOCATION);
  assert.ok(wallImpact.z > -3 && wallImpact.z < -2.99, 'tip stops on the clear side of the wall');
  assert.equal(targetImpact.x, 0);
  assert.equal(targetImpact.targetId, rat.id);
  assert.equal(w.events(1, 'hit').at(-1).source, 'arrow');
});

test('arrow events stay in their launch location and private quest audience', () => {
  const w = world({ combatOptions: { random: () => 0.01 } });
  const archer = w.join(1, 'Ann');
  const observer = w.join(2, 'Ben', 4, 0);
  const away = w.join(3, 'Cid', 0, 0, { location: 'town:Daggerfall/Daggerfall' });
  archer.rpg.character.skills.Archery = 100;
  const bow = w.S.giveItem(archer, 'steel-short-bow', 1);
  w.S.giveItem(archer, 'arrow', 3);
  assert.ok(w.act(archer, 'inventory.equip', { itemId: bow.id }).ok);
  assert.ok(w.act(archer, 'combat.ready', { ready: true }).ok);
  const foe = w.handle.spawnMonster(DEFAULT_LOCATION, RAT, 0, -9, { team: 1, visibleTo: [archer.id] });
  assert.ok(w.act(archer, 'combat.attack', { targetId: foe.id }).ok);
  w.tick(0.4);
  const shot = w.events(archer.id, 'arrowLaunch').at(-1);
  assert.equal(shot.location, DEFAULT_LOCATION);
  assert.equal(w.events(archer.id, 'arrowImpact').at(-1).targetId, foe.id);
  for (const other of [observer, away]) {
    assert.equal(w.events(other.id, 'arrowLaunch').length, 0);
    assert.equal(w.events(other.id, 'arrowImpact').length, 0);
  }

  w.advance(2000);
  archer.yaw = Math.PI;
  assert.ok(w.act(archer, 'combat.attack', {}).ok);
  const shared = w.events(observer.id, 'arrowLaunch').at(-1);
  archer.rpg.location = away.rpg.location;
  w.tick(0.04);
  assert.equal(w.events(archer.id, 'arrowImpact').length, 1);
  assert.deepEqual(w.events(observer.id, 'arrowImpact').at(-1), {
    kind: 'arrowImpact', projectileId: shared.projectileId, location: DEFAULT_LOCATION, reason: 'cancelled',
  });
  assert.equal(w.events(away.id, 'arrowImpact').length, 0);
});

test('a private Archer shares neither its launch nor its arrival with a nearby observer', () => {
  const w = world({ combatOptions: { random: () => 0.01 } });
  const owner = w.join(1, 'Ann');
  const observer = w.join(2, 'Ben', 0.2, -1);
  const foe = w.handle.spawnMonster(DEFAULT_LOCATION, 141, 0, -9, { yaw: Math.PI, visibleTo: [owner.id], origin: 'quest' });
  w.tick(0.4);
  const [shot] = w.events(owner.id, 'arrowLaunch');
  const [arrival] = w.events(owner.id, 'arrowImpact');
  assert.equal(shot.entityId, foe.id);
  assert.equal(arrival.projectileId, shot.projectileId);
  assert.equal(arrival.targetId, owner.id);
  assert.equal(w.events(observer.id, 'arrowLaunch').length, 0);
  assert.equal(w.events(observer.id, 'arrowImpact').length, 0);
});

test('one shared monster entity for two players, with classic sprite references', () => {
  const w = world({ combatOptions: { demoPath: [{ x: 0, z: -30, monsters: [RAT] }] } });
  const a = w.join(1, 'Ann');
  const b = w.join(2, 'Ben', 1, 0);
  w.tick(0.04);
  const ma = w.lastRpg(1).entities.filter((e) => e.kind === 'monster');
  const mb = w.lastRpg(2).entities.filter((e) => e.kind === 'monster');
  assert.equal(ma.length, 1);
  assert.deepEqual(ma, mb);
  const rat = ma[0];
  assert.equal(rat.name, 'Rat');
  assert.deepEqual(rat.sprite, { archive: 255, record: 15 });
  assert.ok(rat.hp >= 9 && rat.hp <= 16 && rat.hp === rat.maxHp);
  for (const k of Object.keys(rat)) assert.ok(!k.startsWith('_'), `private field ${k} leaked`);
  // Seeding happens once: more ticks and another join do not add monsters.
  w.join(3, 'Cid');
  w.tick(1);
  assert.equal([...w.ctx.entities.values()].filter((e) => e.kind === 'monster').length, 1);
  assert.ok(a && b);
});

test('attack validation: readiness, cooldown, reach, PvP and NPC refusal; swings broadcast on misses', () => {
  const w = world();
  const a = w.join(1, 'Ann');
  const b = w.join(2, 'Ben', 1, 0);
  const rat = w.handle.spawnMonster(DEFAULT_LOCATION, RAT, 0, -8);
  faceTo(a, rat);
  assert.match(w.act(a, 'combat.attack', {}).error, /Ready your weapon/);
  assert.equal(w.act(a, 'combat.ready', { ready: 'yes' }).ok, false);
  assert.equal(w.act(a, 'combat.ready', { ready: true }).ok, true);
  assert.equal(a.rpg.readied, true);
  assert.match(w.act(a, 'combat.attack', { direction: 'sideways' }).error, /Unknown swing/);

  // Out of reach: an accepted, untargeted swing that everyone sees, and no damage.
  assert.equal(w.act(a, 'combat.attack', { targetId: rat.id, direction: 'down' }).ok, true);
  assert.equal(rat.hp, rat.maxHp);
  assert.deepEqual(w.events(2, 'swing').at(-1), { kind: 'swing', playerId: 1, direction: 'down', weapon: 'iron-longsword' });
  assert.equal(w.events(1, 'swing').length, 1);
  assert.equal(w.events(2, 'hit').length + w.events(2, 'miss').length, 0);

  // Cooldown is server-side.
  assert.match(w.act(a, 'combat.attack', {}).error, /still recovering/);
  w.advance(2000);
  assert.equal(w.act(a, 'combat.attack', { direction: 'up' }).ok, true); // untargeted swing in the air
  assert.equal(w.events(2, 'swing').at(-1).direction, 'up');

  w.advance(2000);
  assert.match(w.act(a, 'combat.attack', { targetId: 2 }).error, /other travellers/);
  assert.match(w.act(a, 'combat.attack', { targetId: '2' }).error, /other travellers/);
  w.ctx.entities.set('npc-1', { id: 'npc-1', kind: 'npc', name: 'Guard', location: DEFAULT_LOCATION, x: 0, z: -1, yaw: 0 });
  assert.match(w.act(a, 'combat.attack', { targetId: 'npc-1' }).error, /townsfolk/);
  assert.match(w.act(a, 'combat.attack', { targetId: 'nope' }).error, /nothing there/);
  assert.ok(b);
});

test('melee kills a rat with classic rolls; death reaches both players; kill emitted once', () => {
  const w = world({ seed: 7 });
  const a = w.join(1, 'Ann');
  w.join(2, 'Ben', 2, 0);
  const rat = w.handle.spawnMonster(DEFAULT_LOCATION, RAT, 0, -1.5);
  rat.yaw = 0; // facing away from Ann (-z): backstab chance applies
  w.act(a, 'combat.ready', { ready: true });
  let swings = 0;
  while (!rat.dead && swings < 60) {
    rat.x = 0;
    rat.z = -1.5;
    faceTo(a, rat);
    const r = w.act(a, 'combat.attack', { targetId: rat.id, direction: 'downLeft' });
    assert.equal(r.ok, true, r.error);
    swings++;
    w.advance(1500);
  }
  assert.ok(rat.dead, 'rat should die');
  assert.equal(rat.hp, 0);
  assert.equal(rat.animation, 'dead');
  assert.deepEqual(rat.sprite, { archive: 401, record: 1 });
  const hits = w.events(2, 'hit');
  const misses = w.events(2, 'miss');
  assert.equal(w.events(2, 'swing').length, swings);
  assert.equal(hits.length + misses.length + w.events(1, 'ineffective').length, swings);
  assert.equal(hits.reduce((n, h) => n + h.damage, 0), rat.maxHp);
  assert.deepEqual(w.events(2, 'death').map((d) => [d.entityId, d.killerId]), [[rat.id, 1]]);
  assert.equal(w.events(1, 'kill').length, 1);
  assert.deepEqual(w.emitted, [['kill', rat.id, 1]]);
  // Skills advanced through the character service on hits.
  assert.ok(a.rpg.character.skillUses?.['Long Blade'] > 0 || a.rpg.character.skills['Long Blade'] >= 1);
  // A dead monster cannot be attacked or damaged again.
  w.advance(2000);
  assert.match(w.act(a, 'combat.attack', { targetId: rat.id }).error, /nothing there/);
  assert.throws(() => w.S.damageEntity(a, rat.id, 5), /already dead/);
  assert.equal(w.emitted.length, 1);
  // The inventory feature does not drop its own pile for combat kills.
  assert.equal([...w.ctx.entities.values()].filter((e) => e.kind === 'loot').length, 0);
});

test('material resistance: iron cannot hurt an imp; magic damage via damageEntity can', () => {
  const w = world({ seed: 3 });
  const a = w.join(1, 'Ann');
  const imp = w.handle.spawnMonster(DEFAULT_LOCATION, IMP, 0, -1.5);
  faceTo(a, imp);
  w.act(a, 'combat.ready', { ready: true });
  for (let i = 0; i < 5; i++) {
    imp.x = 0;
    imp.z = -1.5;
    faceTo(a, imp);
    assert.equal(w.act(a, 'combat.attack', { targetId: imp.id }).ok, true);
    w.advance(1500);
  }
  assert.equal(imp.hp, imp.maxHp);
  assert.equal(w.events(1, 'ineffective').length, 5);
  // Service validation: other locations, non-monsters and nonsense amounts.
  const far = { ...a, rpg: { location: 'dungeon:Elsewhere' } };
  assert.throws(() => w.S.damageEntity(far, imp.id, 3), /too far/);
  assert.throws(() => w.S.damageEntity(a, 'npc-x', 3), /cannot be harmed/);
  assert.deepEqual(w.S.damageEntity(a, imp.id, -4), { damage: 0, hp: imp.maxHp, killed: false });
  const r = w.S.damageEntity(a, imp.id, 3);
  assert.equal(r.damage, 3);
  assert.equal(imp.hp, imp.maxHp - 3);
  assert.equal(w.S.damageEntity(a, imp.id, 1e9).killed, true);
  assert.equal(w.emitted.length, 1);
});

test('loot is a single server-side claim, limited to fighters until it opens, granted via inventory', () => {
  const w = world({ seed: 11 });
  const a = w.join(1, 'Ann');
  const b = w.join(2, 'Ben', 1, 0);
  const orc = w.handle.spawnMonster(DEFAULT_LOCATION, ORC, 0, -2);
  w.S.damageEntity(a, orc.id, 1000);
  assert.ok(orc.dead);
  const goldA = a.rpg.gold;
  const goldB = b.rpg.gold;

  assert.match(w.act(b, 'combat.loot', { targetId: orc.id }).error, /Only those who fought/);
  const far = w.handle.spawnMonster(DEFAULT_LOCATION, ORC, 40, 40);
  w.S.damageEntity(a, far.id, 1000);
  assert.match(w.act(a, 'combat.loot', { targetId: far.id }).error, /too far/);

  // Simultaneous claims: the runtime runs actions one at a time; only the first succeeds.
  const first = w.act(a, 'combat.loot', { targetId: orc.id });
  assert.equal(first.ok, true, first.error);
  const loot = w.events(1, 'loot').at(-1);
  assert.equal(a.rpg.gold - goldA, loot.gold);
  assert.ok(loot.gold >= 1 * 1 && loot.gold <= 10 * 1); // table A gold * looter level 1
  assert.match(w.act(a, 'combat.loot', { targetId: orc.id }).error, /already been searched/);
  w.advance(120_000);
  assert.match(w.act(b, 'combat.loot', { targetId: orc.id }).error, /already been searched/);
  assert.equal(b.rpg.gold, goldB);
  assert.equal(w.lastRpg(2).entities.find((e) => e.id === orc.id).looted, true);
  assert.deepEqual(w.events(2, 'looted').map((e) => e.playerId), [1]);

  // Unclaimed corpses open to anyone after lootOpenMs.
  const third = w.handle.spawnMonster(DEFAULT_LOCATION, ORC, 0, -2);
  w.S.damageEntity(a, third.id, 1000);
  assert.match(w.act(b, 'combat.loot', { targetId: third.id }).error, /Only those who fought/);
  w.advance(61_000);
  assert.equal(w.act(b, 'combat.loot', { targetId: third.id }).ok, true);
  assert.match(w.act(a, 'combat.loot', { targetId: third.id }).error, /already been searched/);
  assert.match(w.act(a, 'combat.loot', { targetId: 'monster-404' }).error, /nothing there/);
});

test('a failed grant leaves the corpse unclaimed (no lost or duplicated rewards)', () => {
  const w = world({ seed: 5 });
  const a = w.join(1, 'Ann');
  const orc = w.handle.spawnMonster(DEFAULT_LOCATION, ORC, 0, -2);
  w.S.damageEntity(a, orc.id, 1000);
  const give = w.S.giveItem;
  w.S.giveItem = () => {
    throw new Error('Your pack cannot hold any more items.');
  };
  const gold = a.rpg.gold;
  assert.match(w.act(a, 'combat.loot', { targetId: orc.id }).error, /cannot hold/);
  assert.equal(a.rpg.gold, gold);
  assert.notEqual(orc.looted, true);
  w.S.giveItem = give;
  assert.equal(w.act(a, 'combat.loot', { targetId: orc.id }).ok, true);
});

test('AI chases, attacks on the classic timer, defeats, and the player resurrects at spawn', () => {
  const w = world({ seed: 21, combatOptions: { resurrectMs: 5000 } });
  const a = w.join(1, 'Ann', 3, 3);
  const b = w.join(2, 'Ben', 60, 60); // too far to notice
  const orc = w.handle.spawnMonster(DEFAULT_LOCATION, ORC, 3, -5);
  w.tick(0.2);
  assert.equal(orc.animation, 'move');
  w.tick(6);
  assert.ok(Math.hypot(orc.x - a.x, orc.z - a.z) <= 2.25, 'orc closes to melee range');
  const attacks = w.events(1, 'monsterAttack');
  assert.ok(attacks.length >= 1, 'orc attacks');
  assert.ok(attacks.every((e) => e.targetId === 1));
  assert.equal(w.events(2, 'monsterAttack').length, attacks.length, 'everyone in the scene sees it');

  a.rpg.character.health = 1;
  w.act(a, 'combat.ready', { ready: true });
  let guard = 0;
  while (!a.rpg.defeated && guard++ < 2000) w.tick(0.04);
  assert.equal(a.rpg.defeated, true);
  assert.equal(a.rpg.character.health, 0);
  assert.equal(a.rpg.readied, false);
  assert.equal(w.events(2, 'defeat').at(-1).playerId, 1);
  assert.match(w.act(a, 'combat.attack', {}).error, /defeated/);
  assert.match(w.act(a, 'combat.ready', { ready: true }).error, /defeated/);
  // Pinned where they fell; the orc loses interest.
  const fell = { x: a.x, z: a.z };
  a.x += 5;
  w.tick(0.04);
  assert.deepEqual({ x: a.x, z: a.z }, fell);
  const before = w.events(1, 'monsterAttack').length;
  w.tick(3);
  assert.equal(w.events(1, 'monsterAttack').length, before);

  w.tick(3);
  assert.equal(a.rpg.defeated, undefined);
  assert.deepEqual({ x: a.x, z: a.z }, { x: 0, z: 0 });
  assert.equal(a.rpg.character.health, Math.max(1, Math.floor(a.rpg.character.maxHealth * 0.5)));
  assert.equal(w.events(2, 'resurrect').at(-1).playerId, 1);
  assert.ok(b);

  // The death movie's end (combat.rise) gets the player up before the cap; it does nothing once they are up.
  a.rpg.character.health = 0;
  w.ctx.emit('playerDowned', { player: a, source: null });
  assert.equal(a.rpg.defeated, true);
  const risen = w.events(2, 'resurrect').length;
  const rose = w.act(a, 'combat.rise', {});
  assert.equal(rose.ok, true, JSON.stringify(rose));
  assert.equal(a.rpg.defeated, undefined);
  w.tick(0.04);
  assert.equal(w.events(2, 'resurrect').length, risen + 1);
  assert.equal(w.act(a, 'combat.rise', {}).ok, true);
  w.tick(0.04);
  assert.equal(w.events(2, 'resurrect').length, risen + 1);
});

test('companions can help a defeated player up; leash keeps monsters near their post', () => {
  const w = world({ seed: 4, combatOptions: { leash: 6 } });
  const a = w.join(1, 'Ann', 0, 0);
  const b = w.join(2, 'Ben', 1, 0);
  a.rpg.character.health = 0;
  w.ctx.emit('playerDowned', { player: a, source: null });
  assert.equal(a.rpg.defeated, true);
  assert.match(w.act(b, 'combat.revive', { targetId: 3 }).error, /no one/);
  assert.equal(w.act(b, 'combat.revive', { targetId: 1 }).ok, true);
  assert.equal(a.rpg.defeated, undefined);
  assert.equal(a.rpg.character.health, Math.max(1, Math.floor(a.rpg.character.maxHealth * 0.25)));
  assert.deepEqual({ x: a.x, z: a.z }, { x: 0, z: 0 });

  const rat = w.handle.spawnMonster(DEFAULT_LOCATION, RAT, 0, -12);
  w.tick(10);
  assert.ok(Math.hypot(rat.x - 0, rat.z + 12) <= 6.01, 'rat stays on its leash');
});

test('line of sight and geometry are enforced through the collision services', () => {
  const blocked = { canSee: () => false };
  const w = world({ seed: 2, services: blocked });
  const a = w.join(1, 'Ann');
  const rat = w.handle.spawnMonster(DEFAULT_LOCATION, RAT, 0, -1.5);
  w.tick(3);
  assert.equal(w.events(1, 'monsterAttack').length, 0, 'unseen players are not attacked');
  w.act(a, 'combat.ready', { ready: true });
  faceTo(a, rat);
  assert.equal(w.act(a, 'combat.attack', { targetId: rat.id }).ok, true);
  assert.equal(w.events(1, 'hit').length + w.events(1, 'miss').length, 0, 'no hit through walls');
  assert.equal(w.events(1, 'swing').length, 1);

  // Walls: a monster never steps onto a cell the collision service reports as blocked.
  const walls = { collision: { status: () => ({ status: 'ready' }), isClear: (_l, x, z) => !(z > -6 && z < -4), nearestClear: (_l, x, z) => ({ x, z }) } };
  const w2 = world({ seed: 2, services: walls });
  w2.join(1, 'Ann', 0, 0);
  const orc = w2.handle.spawnMonster(DEFAULT_LOCATION, ORC, 0, -10);
  w2.tick(4);
  assert.ok(orc.z <= -6, `orc held by the wall at z=${orc.z}`);
});

test('scenes seed once when occupied, survive a rejoin, reclaim when idle; defeated rejoin resurrects', () => {
  const w = world({ seed: 8, combatOptions: { demoPath: [{ x: 0, z: -30, monsters: [RAT, RAT] }], reclaimMs: 60_000 } });
  const a = w.join(1, 'Ann');
  w.tick(0.04);
  const ids = [...w.ctx.entities.values()].filter((e) => e.kind === 'monster').map((e) => e.id).sort();
  assert.equal(ids.length, 2);
  w.S.damageEntity(a, ids[0], 2);
  const hp = w.ctx.entities.get(ids[0]).hp;

  // Leave defeated, come back within the reclaim window: same monsters, resurrected at spawn.
  a.rpg.defeated = true;
  a.rpg.character.health = 0;
  w.rt.leave(a);
  w.players.delete(1);
  w.tick(20);
  const back = w.join(1, 'Ann', 12, 12, a.rpg);
  assert.equal(back.rpg.defeated, undefined);
  assert.ok(back.rpg.character.health > 0);
  assert.deepEqual({ x: back.x, z: back.z }, { x: 0, z: 0 });
  w.tick(0.04);
  const again = [...w.ctx.entities.values()].filter((e) => e.kind === 'monster').map((e) => e.id).sort();
  assert.deepEqual(again, ids);
  assert.equal(w.ctx.entities.get(ids[0]).hp, hp);

  // Nobody here for longer than reclaimMs: the scene is cleared and re-seeded fresh next visit.
  w.rt.leave(back);
  w.players.delete(1);
  w.tick(61);
  assert.equal([...w.ctx.entities.values()].filter((e) => e.kind === 'monster').length, 0);
  w.join(1, 'Ann', 0, 0, back.rpg);
  w.tick(0.04);
  const fresh = [...w.ctx.entities.values()].filter((e) => e.kind === 'monster').map((e) => e.id);
  assert.equal(fresh.length, 2);
  assert.ok(fresh.every((id) => !ids.includes(id)));
});

test('towns stay quiet by day; one night wave per night; dungeons seed from their markers', () => {
  let night = false;
  let minutes = 600;
  const clock = { worldClock: () => ({ minutes, isNight: night }) };
  const w = world({ seed: 6, services: clock, combatOptions: { nightSites: { [DEFAULT_LOCATION]: [{ x: 0, z: -40, table: 32, count: 1 }] } } });
  w.join(1, 'Ann');
  w.tick(1);
  assert.equal([...w.ctx.entities.values()].filter((e) => e.kind === 'monster').length, 0);
  night = true;
  minutes = 1400;
  w.tick(1);
  assert.equal([...w.ctx.entities.values()].filter((e) => e.kind === 'monster').length, 1);
  minutes = 1600; // same night (after midnight)
  w.tick(1);
  assert.equal([...w.ctx.entities.values()].filter((e) => e.kind === 'monster').length, 1);
  minutes = 1400 + 1440; // next night
  w.tick(1);
  assert.equal([...w.ctx.entities.values()].filter((e) => e.kind === 'monster').length, 2);

  const markers = { encounterSites: (loc) => (loc === 'dungeon:Daggerfall/Old Crypt' ? [{ x: 4, z: 4, table: 0, count: 2 }, { x: -4, z: 9, monsters: [18] }] : []) };
  const d = world({ seed: 6, services: markers });
  d.join(1, 'Ann', 0, 0, { location: 'dungeon:Daggerfall/Old Crypt' });
  d.tick(0.04);
  const mons = [...d.ctx.entities.values()].filter((e) => e.kind === 'monster');
  assert.equal(mons.length, 3);
  assert.ok(mons.every((m) => ENCOUNTER_TABLES[0].includes(m.monsterId)));
  assert.ok(mons.some((m) => m.name === 'Ghost'));
});

// ---------------------------------------------------------------- two real WebSocket clients

class Client {
  constructor(port) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.closed = new Promise((resolve) => this.ws.on('close', resolve));
    this.ws.on('message', (d) => {
      const msg = JSON.parse(d);
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => !w(msg));
    });
  }
  next(pred, timeout = 4000) {
    const found = this.messages.find(pred);
    if (found) {
      this.messages.splice(this.messages.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out waiting for message')), timeout);
      this.waiters.push((msg) => {
        if (!pred(msg)) return false;
        clearTimeout(t);
        resolve(msg);
        return true;
      });
    });
  }
  async join(fields) {
    await this.opened;
    this.ws.send(JSON.stringify({ type: 'join', ...fields }));
    return this.next((m) => m.type === 'welcome' || m.type === 'error');
  }
  seq = 0;
  async act(verb, args) {
    const seq = ++this.seq;
    this.ws.send(JSON.stringify({ type: 'action', verb, args, seq }));
    return this.next((m) => m.type === 'actionResult' && m.seq === seq);
  }
  event(kind, pred = () => true) {
    return this.next((m) => m.type === 'gameEvent' && m.event.kind === kind && pred(m.event)).then((m) => m.event);
  }
  close() {
    this.ws.close();
    return this.closed;
  }
}

test('two WebSocket clients share one monster, see swings and death, and only one claims the loot; rejoin keeps the corpse', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dfw-combat-'));
  const clientDir = join(tmp, 'client');
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, 'play.html'), '<!doctype html>');
  let combatHandle;
  const server = createGameServer({
    host: '127.0.0.1',
    port: 0,
    dbPath: join(tmp, 'db', 'w.db'),
    clientDir,
    siteDir: join(tmp, 'site'),
    features: [
      { name: 'character', install: character },
      { name: 'inventory', install: inventory },
      { name: 'combat', install: (ctx) => (combatHandle = combat.install(ctx, { random: seeded(13), demoPath: [{ x: 0, z: -1.5, monsters: [ORC] }] })) },
    ],
  });
  const { port } = await server.start();
  try {
    const a = new Client(port);
    const b = new Client(port);
    const wa = await a.join({ name: 'Ann' });
    const wb = await b.join({ name: 'Ben' });
    assert.equal(wa.type, 'welcome');
    const stateA = await a.next((m) => m.type === 'rpg' && m.entities.some((e) => e.kind === 'monster'));
    const stateB = await b.next((m) => m.type === 'rpg' && m.entities.some((e) => e.kind === 'monster'));
    const orcA = stateA.entities.find((e) => e.kind === 'monster');
    const orcB = stateB.entities.find((e) => e.kind === 'monster');
    assert.equal(orcA.id, orcB.id);
    assert.equal(orcA.name, 'Orc');
    assert.deepEqual(orcA.sprite.archive, 262);

    assert.equal((await a.act('combat.ready', { ready: true })).ok, true);
    assert.equal((await a.act('combat.attack', { direction: 'downRight' })).ok, true);
    const seen = await b.event('swing', (e) => e.playerId === wa.id);
    assert.equal(seen.direction, 'downRight');
    assert.equal((await a.act('combat.attack', {})).error, 'You are still recovering from your last attack.');

    // Finish it server-side (as a spell would), then race both players for the corpse.
    const orc = server.runtime.entities.get(orcA.id);
    server.runtime.ctx.services.damageEntity(server.runtime.ctx.players.get(wa.id), orc, 999);
    server.runtime.sync();
    await a.event('death', (e) => e.entityId === orcA.id);
    await b.event('death', (e) => e.entityId === orcA.id);
    const [ra, rb] = await Promise.all([a.act('combat.loot', { targetId: orcA.id }), b.act('combat.loot', { targetId: orcA.id })]);
    assert.equal(ra.ok, true, ra.error);
    assert.equal(rb.ok, false);
    assert.equal((await a.act('combat.loot', { targetId: orcA.id })).ok, false);

    // Ben reconnects with his token and sees the same searched corpse.
    await b.close();
    const b2 = new Client(port);
    const wb2 = await b2.join({ token: wb.token });
    assert.equal(wb2.id, wb.id);
    const again = await b2.next((m) => m.type === 'rpg' && m.entities.some((e) => e.id === orcA.id));
    const corpse = again.entities.find((e) => e.id === orcA.id);
    assert.equal(corpse.dead, true);
    assert.equal(corpse.looted, true);
    const [archive, record] = MONSTER_BY_ID.get(ORC).corpse;
    assert.deepEqual(corpse.sprite, { archive, record });
    assert.ok(combatHandle.scenes.size >= 1);
    await a.close();
    await b2.close();
  } finally {
    await server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('feedback: a hit flags backstab exactly when the backstab bonus applied', () => {
  const w = world({ seed: 3 });
  const a = w.join(1, 'Ann');
  const rat = w.handle.spawnMonster(DEFAULT_LOCATION, RAT, 0, -1.5);
  a.rpg.character.skills.Backstabbing = 95;
  w.act(a, 'combat.ready', { ready: true });
  for (let i = 0; i < 40 && !rat.dead; i++) {
    rat.x = 0; rat.z = -1.5; rat.yaw = 0; rat.hp = rat.maxHp; // facing away (-z), kept alive
    faceTo(a, rat);
    w.act(a, 'combat.attack', { targetId: rat.id, direction: 'down' });
    w.advance(1500);
  }
  const seq = w.events(1).filter((e) => e.kind === 'hit' || (e.kind === 'combat' && /backstab/.test(e.text)));
  const hits = seq.filter((e) => e.kind === 'hit');
  assert.ok(hits.some((h) => h.backstab === true), 'at least one backstab');
  seq.forEach((e, i) => {
    if (e.kind !== 'hit') return;
    const told = seq[i + 1]?.kind === 'combat';
    assert.equal(e.backstab === true, told, 'backstab flag matches the backstab message');
    if (!told) assert.equal('backstab' in e, false);
  });
});

test('feedback: a monster blow soaked by a shield is absorbed, not a miss; hurt is private and per cause', () => {
  const w = world({ seed: 21, services: { absorbDamage: () => 0 } });
  const a = w.join(1, 'Ann', 3, 3);
  const b = w.join(2, 'Ben', 4, 3);
  w.handle.spawnMonster(DEFAULT_LOCATION, ORC, 3, -2);
  const hp = a.rpg.character.health;
  w.tick(20);
  const attacks = w.events(2, 'monsterAttack').filter((e) => e.targetId === 1);
  assert.ok(attacks.some((e) => e.absorbed === true && e.hit === false && e.damage === 0), 'absorbed blows');
  assert.ok(attacks.some((e) => !('absorbed' in e)), 'misses stay plain misses');
  assert.equal(a.rpg.character.health, hp);
  assert.equal(w.events(1, 'hurt').length, 0, 'monster melee is reported by monsterAttack, not hurt');

  const w2 = world({ seed: 5 });
  const c = w2.join(1, 'Cat');
  w2.join(2, 'Dan', 1, 0);
  const before = c.rpg.character.health;
  assert.equal(w2.S.hurtPlayerBy(c, 4, { kind: 'trap', id: 't1' }), 4);
  w2.S.hurtPlayerBy(c, 3, { name: 'holy ground', source: 'holy ground' });
  w2.S.hurtPlayerBy(c, 2, { kind: 'monster', name: 'Imp' }, 'spell');
  assert.deepEqual(w2.events(1, 'hurt').map((e) => [e.damage, e.cause]), [[4, 'trap'], [3, 'other'], [2, 'spell']]);
  assert.equal(c.rpg.character.health, before - 9);
  assert.equal(w2.events(2, 'hurt').length, 0, 'hurt goes to the injured player only');
});
