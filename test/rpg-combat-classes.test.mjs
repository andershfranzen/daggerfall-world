// Human class enemies (MobileTypes 128-145) and authored encounter markers.
// Fixtures: the real runtime with the real character, inventory and combat features and a manual
// clock. Where the operator data exists locally (gamedata/DaggerfallGameFiles/arena2 CLASS*.CFG and the
// World of Daggerfall pack in gamedata/world-of-daggerfall) the tests also run against it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRpgRuntime, DEFAULT_LOCATION } from '../server/rpg/runtime.js';
import { install as character } from '../server/rpg/character.js';
import { install as inventory } from '../server/rpg/inventory.js';
import * as combat from '../server/rpg/combat.js';
import { HUMAN_CLASSES, ENEMY_BY_ID, ENCOUNTER_TABLES, hasBowAttack, isKnownEnemy } from '../server/rpg/combat/monsters.js';
import { rollEquipment, rollClassHealth, randomMaterial, careerResolver } from '../server/rpg/combat/classes.js';

const ARENA2 = fileURLToPath(new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url));
const WOD = fileURLToPath(new URL('../gamedata/world-of-daggerfall/', import.meta.url));
const HAS_ARENA2 = existsSync(`${ARENA2}CLASS00.CFG`);
const HAS_WOD = existsSync(`${WOD}WorldOfDaggerfall.dfmod.json`);

const THIEF = 138;
const ROGUE = 136;
const MAGE = 128;
const KNIGHT = 145;

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

function world({ seed = 1, combatOptions = {}, services = {}, extra = [], dataPath = null } = {}) {
  let clock = 1000;
  const players = new Map();
  const inbox = new Map();
  let handle;
  const rt = createRpgRuntime({
    players,
    dataPath,
    features: [
      { name: 'character', install: character },
      { name: 'inventory', install: inventory },
      ...extra,
      { name: 'combat', install: (ctx) => (handle = combat.install(ctx, { random: seeded(seed), demoPath: [], nightSites: {}, ...combatOptions })) },
    ],
    save: () => {},
    send: (p, msg) => inbox.get(p.id)?.push(JSON.parse(JSON.stringify(msg))),
    now: () => clock,
    services,
    log: { error() {}, warn() {}, info() {} },
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
  const monsters = () => [...rt.ctx.entities.values()].filter((e) => e.kind === 'monster');
  return { rt, ctx: rt.ctx, S: rt.ctx.services, get handle() { return handle; }, join, tick, events, lastRpg, monsters, act: (p, v, a) => rt.act(p, v, a), advance: (ms) => (clock += ms) };
}

const faceTo = (p, e) => (p.yaw = Math.atan2(e.x - p.x, -(e.z - p.z)));

test('class enemy table matches EnemyBasics, and every classic encounter entry is now spawnable', () => {
  // MobileTypes 128-145 (CLASS00-17) plus 146 Knight_CityWatch (CLASS18.CFG, archive 399), as in EnemyBasics.cs.
  assert.equal(HUMAN_CLASSES.length, 19);
  assert.deepEqual(HUMAN_CLASSES.map((h) => h.id), Array.from({ length: 19 }, (_, i) => 128 + i));
  assert.equal(HUMAN_CLASSES.at(-1).careerIndex, 18);
  const thief = ENEMY_BY_ID.get(THIEF);
  assert.deepEqual([thief.name, thief.careerIndex, thief.texture, thief.corpse, thief.loot], ['Thief', 10, { male: 484, female: 483 }, [380, 1], 'O']);
  assert.equal(ENEMY_BY_ID.get(KNIGHT).name, 'Knight');
  // EnemyMotor.hasBowAttack: ranged1 && (!castsMagic || ranged2).
  assert.equal(hasBowAttack(ENEMY_BY_ID.get(THIEF)), true);
  assert.equal(hasBowAttack(ENEMY_BY_ID.get(MAGE)), false); // spells only
  assert.equal(hasBowAttack(ENEMY_BY_ID.get(133)), true); // Nightblade: ranged2
  assert.equal(hasBowAttack(ENEMY_BY_ID.get(0)), false);
  assert.equal(Object.keys(ENCOUNTER_TABLES).length, 45);
  // All 45 FALL.EXE tables (DFU's commented-out "Cemetery - DF Unity version" is not one of them).
  for (const [k, table] of Object.entries(ENCOUNTER_TABLES)) {
    for (const id of table) assert.ok(isKnownEnemy(id), `table ${k} entry ${id}`);
  }
  // Swamp/woodlands by day now keeps its classic humans instead of re-rolling them.
  assert.deepEqual(ENCOUNTER_TABLES[33].slice(9, 12), [141, 21, 134]);
});

test('classic class equipment, armour clamp and levelled health', () => {
  const r = seeded(17);
  for (let i = 0; i < 200; i++) {
    const kit = rollEquipment(1 + (i % 20), r);
    assert.ok(kit.armor.every((v) => v <= 60), 'class armour clamps to 60');
    assert.equal(kit.armor[6], 60, 'boots never count (Head..Feet exclusive)');
    const set = kit.variant === 0 ? ['broadsword', 'saber', 'longsword'] : ['claymore', 'dai-katana', 'mace', 'flail', 'warhammer', 'battle-axe'];
    assert.ok(set.includes(kit.weapon.base));
    assert.ok(kit.items[0].endsWith(kit.weapon.base));
  }
  for (let i = 0; i < 50; i++) {
    const hp = rollClassHealth(5, 12, r);
    assert.ok(hp >= 15 && hp <= 70);
  }
  // RandomMaterial at level 1: combined modifier <= 219 reaches at most elven (64+128+10, then 21).
  for (let i = 0; i < 400; i++) assert.ok(randomMaterial(1, r) <= 3);
  assert.ok(Array.from({ length: 400 }, () => randomMaterial(20, r)).some((m) => m >= 4), 'higher levels reach better metals');
});

test('careers come from the operator CLASS*.CFG when present', { skip: !HAS_ARENA2 && 'no local ARENA2' }, () => {
  const careerFor = careerResolver(ARENA2);
  const thief = careerFor(10);
  assert.equal(thief.source, 'cfg');
  assert.ok(thief.career.hitPointsPerLevel >= 1 && thief.career.attributes.Agility > 0);
  const fallback = careerResolver(null)(10);
  assert.equal(fallback.source, 'fallback');
});

test('a shared class enemy: same entity for both players, gendered class sprite, classic level and armour', () => {
  const w = world({ seed: 3, dataPath: HAS_ARENA2 ? ARENA2 : null });
  w.join(1, 'Ann');
  w.join(2, 'Ben', 1, 0);
  const thief = w.handle.spawnMonster(DEFAULT_LOCATION, THIEF, 0, -30, { level: 4 });
  w.rt.sync();
  const seenA = w.lastRpg(1).entities.find((e) => e.id === thief.id);
  const seenB = w.lastRpg(2).entities.find((e) => e.id === thief.id);
  assert.deepEqual(seenA, seenB);
  assert.equal(seenA.name, 'Thief');
  assert.equal(seenA.level, 4);
  assert.equal(seenA.sprite.archive, seenA.gender === 'female' ? 483 : 484);
  assert.equal(seenA.sprite.record, 15);
  assert.equal(seenA.careerSource, HAS_ARENA2 ? 'cfg' : 'fallback');
  assert.ok(seenA.maxHp >= 14);
  for (const k of Object.keys(seenA)) assert.ok(!k.startsWith('_'));
});

test('class enemies use weapons in melee and shoot bows between 6 and 51.2 m; arrows land in the pack', () => {
  const w = world({ seed: 9 });
  const a = w.join(1, 'Ann', 0, 0);
  const rogue = w.handle.spawnMonster(DEFAULT_LOCATION, ROGUE, 0, -10, { level: 3 });
  const arrows = () => a.rpg.inventory.find((i) => i.template === 'arrow')?.quantity ?? 0;
  const before = arrows();
  w.tick(8);
  const shots = w.events(1, 'monsterAttack').filter((e) => e.ranged);
  assert.ok(shots.length >= 1, 'the rogue shoots from range');
  assert.ok(Math.hypot(rogue.x, rogue.z + 10) < 0.01, 'and holds position while it has a shot');
  assert.equal(arrows() - before, shots.length);
  // Inside 6 m it closes to melee and swings its weapon.
  rogue.x = 0;
  rogue.z = -3;
  rogue._home = { x: 0, z: -3 };
  a.rpg.character.health = a.rpg.character.maxHealth;
  const n = w.events(1, 'monsterAttack').length;
  w.tick(6);
  const melee = w.events(1, 'monsterAttack').slice(n).filter((e) => !e.ranged);
  assert.ok(melee.length >= 1, 'melee at close range');
  assert.ok(Math.hypot(rogue.x - a.x, rogue.z - a.z) <= 2.25);
});

test('mages carry no bow: they close to melee instead of shooting', () => {
  const w = world({ seed: 2 });
  const a = w.join(1, 'Ann', 0, 0);
  a.rpg.readied = true;
  const mage = w.handle.spawnMonster(DEFAULT_LOCATION, MAGE, 0, -10, { level: 2 });
  w.tick(6);
  assert.equal(w.events(1, 'monsterAttack').filter((e) => e.ranged).length, 0);
  assert.ok(Math.hypot(mage.x, mage.z) < 3);
});

test('killing a class enemy: corpse holds its equipment, one claim only', () => {
  const w = world({ seed: 12 });
  const a = w.join(1, 'Ann');
  const b = w.join(2, 'Ben', 1, 0);
  const warrior = w.handle.spawnMonster(DEFAULT_LOCATION, 144, 0, -2, { level: 2 });
  const kit = [...warrior._items];
  w.act(a, 'combat.ready', { ready: true });
  // Player rolls against a class target use its equipment armour and no +40 monster bonus.
  let swings = 0;
  while (!warrior.dead && swings++ < 80) {
    warrior.x = 0;
    warrior.z = -2;
    faceTo(a, warrior);
    a.rpg.character.health = a.rpg.character.maxHealth;
    assert.equal(w.act(a, 'combat.attack', { targetId: warrior.id, direction: 'down' }).ok, true);
    w.advance(1500);
  }
  if (!warrior.dead) w.S.damageEntity(a, warrior, 999);
  assert.equal(warrior.dead, true);
  assert.deepEqual(warrior.sprite, { archive: 380, record: 1 });
  assert.equal(warrior.lootable, true);
  const before = a.rpg.inventory.length;
  assert.equal(w.act(a, 'combat.loot', { targetId: warrior.id }).ok, true);
  const got = w.events(1, 'loot').at(-1);
  assert.ok(got.items.length >= kit.length, 'equipment is on the corpse');
  assert.ok(a.rpg.inventory.length >= before + kit.length);
  w.advance(120_000);
  assert.match(w.act(b, 'combat.loot', { targetId: warrior.id }).error, /already been searched/);
});

test('encounterSites: null defers, an authoritative array replaces fallbacks, keys and allies are honoured', () => {
  let answer = null;
  const services = { encounterSites: (loc) => (loc === DEFAULT_LOCATION ? answer : undefined) };
  const w = world({ seed: 5, services, combatOptions: { demoPath: [{ x: 0, z: -40, monsters: [0] }] } });
  const a = w.join(1, 'Ann');
  w.tick(0.5);
  assert.equal(w.monsters().length, 0, 'null: still loading, nothing seeded');
  answer = [
    { x: 3, z: -20, monsters: [ROGUE], key: 'wod:test#1', yaw: 1 },
    { x: -3, z: -20, monsters: [KNIGHT], key: 'wod:test#2', team: 1 },
  ];
  w.tick(0.04);
  const ms = w.monsters();
  assert.deepEqual(ms.map((m) => m.name).sort(), ['Knight', 'Rogue'], 'the demo path is not added to an authored scene');
  const knight = ms.find((m) => m.name === 'Knight');
  assert.equal(knight.hostile, false);
  assert.equal(ms.find((m) => m.name === 'Rogue')._key, 'wod:test#1');
  // The allied knight ignores a player standing beside it until hurt.
  a.x = knight.x;
  a.z = knight.z + 1.5;
  w.tick(4);
  const knightAttacks = w.events(1, 'monsterAttack').filter((e) => e.entityId === knight.id);
  assert.ok(knightAttacks.some((e) => e.targetId === ms.find((m) => m.name === 'Rogue').id));
  assert.ok(knightAttacks.every((e) => e.targetId !== a.id));
  w.S.damageEntity(a, knight, 1);
  assert.equal(knight.hostile, true);

  // An empty authoritative answer seeds nothing, not even the demonstration path.
  answer = [];
  const w2 = world({ seed: 5, services, combatOptions: { demoPath: [{ x: 0, z: -40, monsters: [0] }] } });
  w2.join(1, 'Ann');
  w2.tick(0.5);
  assert.equal(w2.monsters().length, 0);
});

test('dungeons without a marker source get no invented ring of monsters', () => {
  const w = world({ seed: 1 });
  w.join(1, 'Ann', 0, 0, { location: 'dungeon:Daggerfall/Privateer\'s Hold' });
  w.tick(0.5);
  assert.equal(w.monsters().length, 0);
});

test('dungeon markers keep their floor height', () => {
  const services = { encounterSites: () => [{ x: 2, y: -6.5, z: 4, monsters: [THIEF], key: 'RDB:1/2' }] };
  const w = world({ seed: 1, services });
  w.join(1, 'Ann', 160, 160, { location: 'dungeon:Daggerfall/Somewhere' });
  w.tick(0.04);
  const [t] = w.monsters();
  assert.deepEqual([t.x, t.y, t.z], [2, -6.5, 4]);
});

test('World of Daggerfall bandit camp: the real pack seeds its Rogues for everyone, nothing else', { skip: !HAS_WOD && 'no local World of Daggerfall pack' }, async () => {
  const { install: wilderness } = await import('../server/rpg/wilderness.js');
  let wild;
  const w = world({ seed: 7, extra: [{ name: 'wilderness', install: (ctx) => (wild = wilderness(ctx, { root: WOD })) }] });
  await wild.ready;
  const loc = 'wilderness:237,131'; // WOD_BanditCamp_05 (EnemyId 136 Rogue x2, TeamOverride 0)
  const a = w.join(1, 'Ann', -279, -260, { location: loc });
  const b = w.join(2, 'Ben', -278, -261, { location: loc });
  a.rpg.readied = b.rpg.readied = true;
  w.tick(0.04);
  const ms = w.monsters().filter((m) => m.location === loc);
  assert.deepEqual(ms.map((m) => m.name), ['Rogue', 'Rogue']);
  assert.ok(ms.every((m) => m._key.startsWith('wod:237,131:21,107#')));
  assert.ok(ms.every((m) => m.hostile !== false));
  const ids = (id) => w.lastRpg(id).entities.filter((e) => e.kind === 'monster').map((e) => `${e.id}@${e.x},${e.z}`).sort();
  assert.deepEqual(ids(1), ids(2));
  assert.ok(a);
});

test('client interact key (G) on a lootable corpse sends combat.loot; living or searched ones do nothing', async () => {
  const { interactionFor, DEFAULT_BINDINGS } = await import('../client/gameplay/api.js');
  assert.equal(DEFAULT_BINDINGS.interact, 'KeyG');
  assert.deepEqual(interactionFor({ id: 'monster-3', kind: 'monster', dead: true, lootable: true, hp: 0 }), { verb: 'combat.loot', args: { targetId: 'monster-3' } });
  assert.equal(interactionFor({ id: 'monster-3', kind: 'monster', dead: true, lootable: true, looted: true }), null);
  assert.equal(interactionFor({ id: 'monster-3', kind: 'monster', dead: true, lootable: false }), null);
  assert.equal(interactionFor({ id: 'monster-3', kind: 'monster', hp: 4 }), null);
});

test('a player defeated in the wilderness gets up at the scene spawn, not the pixel centre', () => {
  const loc = 'wilderness:109,160';
  const services = {
    encounterSites: () => [],
    wilderness: { isWilderness: (id) => id.startsWith('wilderness:'), scene: () => ({ spawn: { x: -275.2, z: -245.6, yaw: 0 } }) },
  };
  const w = world({ services, combatOptions: { resurrectMs: 1000 } });
  const a = w.join(1, 'Ann', -270, -270, { location: loc });
  a.rpg.character.health = 0;
  w.ctx.emit('playerDowned', { player: a, source: null });
  w.tick(1.2);
  assert.equal(a.rpg.defeated, undefined);
  assert.deepEqual([a.x, a.z], [-275.2, -245.6]);
});
