// Every classic enemy type: source audit against Daggerfall Unity's EnemyBasics / RandomEncounters / RDBLayout
// rules, MONSTER.BSA careers, water placement, classic dungeon slots, climate tables, Seducer transformation,
// multi-hit swings, monster spells through the magic feature and quest foes built by combat.
// Fixtures: the real runtime with the real character, inventory, combat (and magic) features and a manual clock.
// Tests marked [asset] also run against the local operator data (gamedata/DaggerfallGameFiles/arena2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRpgRuntime, DEFAULT_LOCATION } from '../server/rpg/runtime.js';
import { install as character } from '../server/rpg/character.js';
import { install as inventory } from '../server/rpg/inventory.js';
import { install as magic } from '../server/rpg/magic.js';
import * as combat from '../server/rpg/combat.js';
import {
  MONSTERS, HUMAN_CLASSES, ENEMY_BY_ID, ENEMY_EXTRAS, RESERVED_IDS, ENCOUNTER_TABLES, MONSTER_SPELLS,
  dfRandom, classicDungeonSlots, climateEncounterTable, CLIMATES, intermittentSpawn, hitMarkers, enemySpells,
} from '../server/rpg/combat/monsters.js';
import { monsterCareerResolver } from '../server/rpg/combat/careers.js';
import { careerResolver } from '../server/rpg/combat/classes.js';
import { MOBILES as CLIENT_MOBILES } from '../client/gameplay/actors/tables.js';
import { entityAppearance, animRecord } from '../client/gameplay/actors/logic.js';
import { classicEnemySpeed } from '../server/rpg/combat/senses.js';

const ARENA2 = fileURLToPath(new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url));
const HAS_ARENA2 = existsSync(`${ARENA2}MONSTER.BSA`) && existsSync(`${ARENA2}SPELLS.STD`);
const asset = !HAS_ARENA2 && 'local ARENA2 (MONSTER.BSA, SPELLS.STD) not present';
const DUNGEON = 'dungeon:Daggerfall/Test Crypt';

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

function world({ seed = 1, combatOptions = {}, services = {}, dataPath = null, withMagic = false } = {}) {
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
      { name: 'combat', install: (ctx) => (handle = combat.install(ctx, { random: seeded(seed), demoPath: [], nightSites: {}, ...combatOptions })) },
      ...(withMagic ? [{ name: 'magic', install: (ctx) => magic(ctx, { rng: seeded(seed + 1), arena2Dir: dataPath }) }] : []),
    ],
    save: () => {},
    send: (p, msg) => inbox.get(p.id)?.push(JSON.parse(JSON.stringify(msg))),
    now: () => clock,
    services,
    log: { error() {}, warn() {}, info() {} },
  });
  const join = (id, name, x = 0, z = 0, location) => {
    const p = { id, name, x, z, yaw: 0, moving: false, rpg: location ? { location } : {} };
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
  const monsters = () => [...rt.ctx.entities.values()].filter((e) => e.kind === 'monster');
  return { rt, ctx: rt.ctx, S: rt.ctx.services, get handle() { return handle; }, join, tick, events, monsters };
}

test('the enemy table covers every MobileTypes enemy in EnemyBasics, with reserved ids reported, not replaced', () => {
  const ids = [...ENEMY_BY_ID.keys()].sort((a, b) => a - b);
  const expected = [...Array.from({ length: 43 }, (_, i) => i).filter((i) => i !== 39), ...Array.from({ length: 19 }, (_, i) => 128 + i)];
  assert.deepEqual(ids, expected);
  assert.equal(MONSTERS.length, 42);
  assert.equal(HUMAN_CLASSES.length, 19);
  assert.ok(RESERVED_IDS[39] && RESERVED_IDS[99]);
  for (const id of ids) {
    assert.ok(ENEMY_EXTRAS[id]?.seq?.length, `attack frames for ${id}`);
    // The browser's appearance table agrees with the server on archives and corpses.
    const c = CLIENT_MOBILES.get(id);
    const e = ENEMY_BY_ID.get(id);
    assert.ok(c, `client table has ${id}`);
    const tex = e.human ? e.texture : { male: e.texture, female: e.texture };
    assert.deepEqual([c.male, c.female, c.corpse], [tex.male, tex.female, e.corpse], `appearance of ${id}`);
  }
  assert.equal(CLIENT_MOBILES.has(39), false);
  // Every encounter table entry is a spawnable enemy; 40 (Dragonling_Alternate) and 146 only come from markers/quests.
  const inTables = new Set(Object.values(ENCOUNTER_TABLES).flat());
  assert.ok(!inTables.has(40) && !inTables.has(146) && !inTables.has(39));
  // PrimaryAttackAnimFrames: orcs strike twice per swing, rats once.
  assert.deepEqual(hitMarkers(ENEMY_BY_ID.get(7)), [3, 5]);
  assert.deepEqual(hitMarkers(ENEMY_BY_ID.get(0)), [3]);
  // Spell lists from FALL.EXE; class casters use the level-scaled list.
  assert.deepEqual(MONSTER_SPELLS[1], [0x07, 0x0a, 0x1d, 0x2c]);
  assert.deepEqual(enemySpells(ENEMY_BY_ID.get(128), 1), MONSTER_SPELLS[25]);
  assert.deepEqual(enemySpells(ENEMY_BY_ID.get(128), 30), MONSTER_SPELLS[33]);
  assert.deepEqual(enemySpells(ENEMY_BY_ID.get(144), 10), []);
});

test('DFRandom and classic dungeon slots are deterministic per dungeon and level', () => {
  const r = dfRandom(1);
  assert.equal(r.rand(), 16838); // MS C rand() with srand(1)
  const a = classicDungeonSlots(0, 4242, 3);
  const b = classicDungeonSlots(0, 4242, 3);
  assert.deepEqual(a, b);
  assert.equal(a.nonWater.length, 256);
  assert.ok(a.nonWater.every((id) => ENCOUNTER_TABLES[0].includes(id)));
  assert.ok(a.water.every((id) => ENCOUNTER_TABLES[19].includes(id)));
  assert.notDeepEqual(classicDungeonSlots(0, 4243, 3).nonWater, a.nonWater);
});

test('climate and building tables follow RandomEncounters.ChooseRandomEnemy', () => {
  assert.equal(climateEncounterTable(CLIMATES.woodlands, { night: false }), 33);
  assert.equal(climateEncounterTable(CLIMATES.woodlands, { night: true }), 34);
  assert.equal(climateEncounterTable(CLIMATES.desert2, { inLocation: true, night: true }), 20);
  assert.equal(climateEncounterTable(CLIMATES.desert, { inLocation: true, night: false }), null);
  assert.equal(climateEncounterTable(CLIMATES.hauntedWoodlands, { night: true }), 37);
  assert.equal(climateEncounterTable(CLIMATES.ocean, {}), null);
  // A spawn check only every 144 game minutes, and in towns only at night.
  assert.equal(intermittentSpawn(12, 'wilderness', () => 0), false);
  assert.equal(intermittentSpawn(11, 'wilderness', () => 0), true); // classic: (minutes / 12) % 12 == 0
  assert.equal(intermittentSpawn(144 * 5, 'wilderness', () => 0), true);
  assert.equal(intermittentSpawn(720, 'location', () => 0), false);
  assert.equal(intermittentSpawn(1440 + 0, 'location', () => 0), true);
});

test('dungeon water: random markers under water use the underwater table, aquatic fixed markers above it are skipped', () => {
  const sites = [
    { x: 0, z: -20, y: -2, table: 0, count: 1, key: 'wet', waterLevel: -80, markerY: 120 },
    { x: 4, z: -20, y: 0, table: 0, count: 1, key: 'dry', waterLevel: 10000, markerY: 0 },
    { x: 8, z: -20, y: 0, monsters: [11], key: 'fish-dry', waterLevel: 10000, markerY: 0 },
    { x: 8, z: -24, y: -3, monsters: [41], key: 'dreugh-wet', waterLevel: -80, markerY: 140 },
    { x: 9, z: -24, y: 0, monsters: [39], key: 'horse' },
  ];
  const w = world({ seed: 5, services: { encounterSites: (loc) => (loc === DUNGEON ? sites : undefined) } });
  w.join(1, 'Ann', 0, 0, DUNGEON);
  w.tick(0.2);
  const byKey = new Map(w.monsters().map((m) => [m._key, m]));
  assert.ok(ENCOUNTER_TABLES[19].includes(byKey.get('wet').monsterId), 'underwater random marker');
  assert.equal(byKey.get('wet').origin, 'rdb-random-water');
  assert.ok(ENCOUNTER_TABLES[0].includes(byKey.get('dry').monsterId));
  assert.equal(byKey.has('fish-dry'), false);
  assert.equal(byKey.get('dreugh-wet').monsterId, 41);
  assert.equal(byKey.get('dreugh-wet').origin, 'rdb-fixed');
  assert.equal(byKey.has('horse'), false);
  const st = w.S.combatStats();
  assert.ok(Object.keys(st.skipped).some((k) => k.startsWith('11|aquatic')));
  assert.ok(Object.keys(st.skipped).some((k) => k.startsWith('39|Horse_Invalid')));
});

test('classic random selection uses the dungeon seed and marker slot when the marker source gives them', () => {
  const lists = classicDungeonSlots(8, 777, 1);
  const sites = [1, 2, 3, 4, 5, 6].map((slot) => ({ x: slot * 3, z: -20, y: 0, table: 8, count: 1, slot, classicSeed: 777, key: `s${slot}` }));
  const w = world({ services: { encounterSites: (loc) => (loc === DUNGEON ? sites : undefined) } });
  w.join(1, 'Ann', 0, 0, DUNGEON);
  w.tick(0.2);
  for (const m of w.monsters()) assert.equal(m.monsterId, lists.nonWater[Number(m._key.slice(1))], m._key);
});

test('authored markers stay on their own storey: placement and walking use the marker foot height', () => {
  const calls = [];
  const collision = {
    status: () => ({ status: 'ready' }),
    isClear: (loc, x, z, y) => (calls.push(['isClear', y]), true),
    nearestClear: (loc, x, z, d, y) => (calls.push(['nearestClear', y]), { x, z }),
    groundAt: (loc, x, z, y) => (calls.push(['groundAt', y]), y < -5 ? -8 : 0),
  };
  const sites = [{ x: 0, z: -6, y: -7.9, monsters: [0], key: 'lower' }];
  const w = world({ services: { collision, encounterSites: (loc) => (loc === DUNGEON ? sites : undefined) } });
  w.join(1, 'Ann', 0, 0, DUNGEON);
  w.tick(0.2);
  const rat = w.monsters()[0];
  assert.equal(rat.y, -8);
  assert.ok(calls.some(([k, y]) => k === 'nearestClear' && y === -7.9));
  w.tick(1);
  assert.ok(calls.some(([k, y]) => k === 'isClear' && y === -8), 'steps checked on the marker storey');
});

test('orcs strike at each hit marker of a swing', () => {
  const w = world({ seed: 4 });
  const a = w.join(1, 'Ann', 0, 0);
  a.rpg.character.maxHealth = a.rpg.character.health = 5000;
  const orc = w.handle.spawnMonster(DEFAULT_LOCATION, 7, 0, -1.2, { level: 1 });
  let t = 0;
  while (!w.events(1, 'monsterAttack').length && t < 5) { w.tick(0.04); t += 0.04; }
  w.tick(0.3); // frames 3 and 5 at 10 fps: the second roll lands 0.2 s after the first
  const n = w.events(1, 'monsterAttack').filter((e) => e.entityId === orc.id).length;
  assert.equal(n, 2, 'two damage rolls in the first swing');
});

test('Daedra Seducer: transforms when hurt, cannot be struck meanwhile, then fights winged (records 23, 22, 21, 20)', () => {
  const w = world({ seed: 6 });
  const a = w.join(1, 'Ann', 0, 0);
  a.rpg.character.maxHealth = a.rpg.character.health = 5000;
  const s = w.handle.spawnMonster(DEFAULT_LOCATION, 29, 0, -8, { level: 1 });
  w.tick(0.1);
  w.S.damageEntity(a, s, 1);
  w.tick(0.1);
  assert.equal(s.animation, 'transform1');
  assert.equal(s.sprite.record, 23);
  w.tick(1.5);
  assert.equal(s.animation, 'transform2');
  assert.equal(s.sprite.record, 22);
  w.tick(1.6);
  assert.equal(s.form, 'winged');
  assert.equal(s.behaviour, 'flying');
  assert.ok([20, 21].includes(s.sprite.record));
  // The browser draws the same records, front facing only.
  const app = entityAppearance(s);
  assert.equal(app.winged, true);
  assert.deepEqual(animRecord(app, 'move', 3, 24), { record: 21, flip: false, fps: 6, loop: true });
  assert.equal(animRecord(app, 'attack', 5, 24).record, 20);
  assert.equal(animRecord(entityAppearance({ ...s, form: undefined }), 'transform1', 0, 24).record, 23);
});

test('reserved and unknown ids never spawn a stand-in', () => {
  const w = world();
  w.join(1, 'Ann');
  assert.equal(w.handle.spawnMonster(DEFAULT_LOCATION, 39, 0, -5), null);
  assert.equal(w.handle.spawnMonster(DEFAULT_LOCATION, 99, 0, -5), null);
  assert.equal(w.handle.spawnMonster(DEFAULT_LOCATION, 282, 0, -5), null);
  assert.equal(w.monsters().length, 0);
  assert.equal(Object.keys(w.S.combatStats().skipped).length, 3);
});

test('createEnemy: a quest foe is a real enemy that fights only its owner', () => {
  const w = world({ seed: 8 });
  const a = w.join(1, 'Ann', 0, 0);
  const b = w.join(2, 'Ben', 0.5, 0);
  for (const p of [a, b]) p.rpg.character.maxHealth = p.rpg.character.health = 5000;
  const foe = w.S.createEnemy(DEFAULT_LOCATION, 136, 0, -1.5, { id: 'quest:1:x:foe:a:0', level: 3, gender: 'female' });
  foe.visibleTo = [1];
  assert.equal(foe.id, 'quest:1:x:foe:a:0');
  assert.equal(foe.origin, 'quest');
  assert.equal(foe.sprite.archive, 479);
  w.tick(8);
  const hits = w.events(1, 'monsterAttack').filter((e) => e.entityId === foe.id);
  assert.ok(hits.length > 0);
  assert.ok(hits.every((e) => e.targetId === 1));
  assert.equal(w.events(2).filter((e) => e.entityId === foe.id).length, 0);
  assert.throws(() => w.S.damageEntity(b, foe, 1), /cannot be harmed/);

  // For Ben the private foe does not exist: an aimed swing is refused like an unknown id, an untargeted swing in
  // reach passes through it, and its corpse cannot be searched.
  const hp = foe.hp;
  b.x = 0; b.z = -0.6; b.yaw = 0; // in melee reach, facing it
  assert.equal(w.rt.act(b, 'combat.ready', { ready: true }).ok, true);
  assert.match(w.rt.act(b, 'combat.attack', { targetId: foe.id }).error, /nothing there to attack/);
  w.tick(3);
  assert.equal(w.rt.act(b, 'combat.attack', {}).ok, true);
  assert.equal(foe.hp, hp, 'an untargeted swing never picks another player’s private foe');
  foe.dead = true;
  assert.match(w.rt.act(b, 'combat.loot', { targetId: foe.id }).error, /nothing there to search/);
});

test('[asset] monster careers come from MONSTER.BSA for every creature, the City Watch from CLASS18.CFG', { skip: asset }, () => {
  const careerOf = monsterCareerResolver(ARENA2);
  for (const m of MONSTERS) {
    const c = careerOf(m.id);
    assert.ok(c && c.attributes.Strength > 0, `ENEMY${m.id}`);
  }
  assert.ok(careerOf(25).tolerances.cold === 'immune' && careerOf(26).tolerances.fire === 'immune');
  const watch = careerResolver(ARENA2)(18);
  assert.equal(watch.career.name, 'Knight');
  const w = world({ seed: 2, dataPath: ARENA2 });
  w.join(1, 'Ann');
  const g = w.handle.spawnMonster(DEFAULT_LOCATION, 146, 0, -20, { level: 2 });
  assert.ok(g.level >= 5 && g.level <= 8);
  assert.equal(g.sprite.archive, 399);
  const fd = w.handle.spawnMonster(DEFAULT_LOCATION, 25, 0, -22, { level: 2 });
  assert.equal(fd.careerSource, 'cfg');
  assert.equal(fd.resistances.cold, 'immune');
});

test('[asset] monster spells: an imp casts from range through the magic feature and the player takes the damage', { skip: asset }, () => {
  const w = world({ seed: 11, dataPath: ARENA2, withMagic: true });
  const a = w.join(1, 'Ann', 0, 0);
  a.rpg.character.maxHealth = a.rpg.character.health = 5000;
  const imp = w.handle.spawnMonster(DEFAULT_LOCATION, 1, 0, -12, { level: 1 });
  assert.equal(imp.maxMagicka, 120);
  w.tick(30);
  const casts = w.events(1, 'spellCast').filter((e) => e.casterId === imp.id);
  assert.ok(casts.length >= 1, 'the imp casts');
  assert.ok(casts.every((c) => ["Wizard's Fire", 'Free Action', 'Toxic Cloud', 'Chameleon'].includes(c.spellName)));
  assert.ok(imp.magicka < imp.maxMagicka);
  assert.ok(Math.hypot(imp.x, imp.z + 12) < 0.01, 'holds position while it has a ranged spell');
  assert.ok(a.rpg.character.health < 5000 || casts.every((c) => c.spellName !== "Wizard's Fire"));
});

test('stacked floors: an enemy directly below never strikes or sees through the floor; same floor it fights', () => {
  const sites = [
    { x: 0, z: -1, y: -6, monsters: [7], key: 'below' },
    { x: 0, z: 1, y: 0.05, monsters: [0], key: 'same' },
  ];
  const w = world({ seed: 12, services: { encounterSites: (loc) => (loc === DUNGEON ? sites : undefined) } });
  const a = w.join(1, 'Ann', 0, 0, DUNGEON);
  a.rpg.portal = { to: DUNGEON, footY: 0 }; // collision keeps the player's dungeon foot height here
  a.rpg.character.maxHealth = a.rpg.character.health = 5000;
  w.tick(6);
  const byKey = new Map(w.monsters().map((m) => [m._key, m]));
  const attacks = w.events(1, 'monsterAttack');
  assert.equal(attacks.filter((e) => e.entityId === byKey.get('below').id).length, 0, 'the orc one floor down stays out of it');
  assert.ok(attacks.some((e) => e.entityId === byKey.get('same').id), 'the rat on the same floor attacks');
});

test('passive fixed markers (castle guards) wait until provoked; marker gender is kept', () => {
  const sites = [{ x: 0, z: -2, y: 0, monsters: [145], key: 'guard', passive: true, gender: 'female' }];
  const w = world({ seed: 3, services: { encounterSites: (loc) => (loc === DUNGEON ? sites : undefined) } });
  const a = w.join(1, 'Ann', 0, 0, DUNGEON);
  a.rpg.character.maxHealth = a.rpg.character.health = 5000;
  w.tick(5);
  const g = w.monsters()[0];
  assert.equal(g.hostile, false);
  assert.equal(g.gender, 'female');
  assert.equal(g.sprite.archive, 487);
  assert.equal(w.events(1, 'monsterAttack').length, 0);
  w.S.damageEntity(a, g, 1);
  w.tick(5);
  assert.ok(w.events(1, 'monsterAttack').length > 0, 'it fights once struck');
});

test('[asset] installed data seeds no invented demonstration encounters', { skip: asset }, () => {
  const w = world({ dataPath: ARENA2, combatOptions: { demoPath: undefined, nightSites: undefined } });
  w.join(1, 'Ann');
  w.tick(0.5);
  assert.equal(w.monsters().length, 0);
});

test('[asset] every supported species creates its own corpse and only known loot', { skip: asset }, () => {
  const w = world({ dataPath: ARENA2 });
  const a = w.join(1, 'Ann', 0, 0, DUNGEON);
  for (const [id, definition] of ENEMY_BY_ID) {
    const e = w.handle.spawnMonster(DUNGEON, id, 0, -2);
    assert.equal(e.monsterId, id);
    assert.equal(w.S.damageEntity(a, e, e.maxHp).killed, true);
    assert.deepEqual([e.sprite.archive, e.sprite.record], definition.corpse);
    for (const { template } of e._loot) if (template !== 'gold') assert.ok(w.S.describeItem(template), template);
  }
  assert.equal(w.events(1, 'death').length, 61);
});

test('a successful soul tether can hold an enemy at one HP before a single corpse is made', () => {
  let tether = true;
  const w = world({ services: { onMonsterLethalHit: () => tether ? false : undefined } });
  const a = w.join(1, 'Ann', 0, 0, DUNGEON);
  const wraith = w.handle.spawnMonster(DUNGEON, 23, 0, -2);
  assert.deepEqual(w.S.damageEntity(a, wraith, 1000), { damage: wraith.maxHp - 1, hp: 1, killed: false });
  assert.equal(w.events(1, 'death').length, 0);
  tether = false;
  assert.deepEqual(w.S.damageEntity(a, wraith, 12), { damage: 1, hp: 0, killed: true });
  assert.equal(w.events(1, 'death').length, 1);
});

test('classic stealth uses observed motion and an enemy pursues the last visible point', () => {
  let blocked = false;
  const w = world({
    combatOptions: { random: () => 0.3, leash: 200, monsterCareerFor: () => ({ attributes: { Speed: 90 }, tolerances: {} }) },
    services: { canSee: () => !blocked },
  });
  const a = w.join(1, 'Ann', 0, 0, DUNGEON);
  const rat = w.handle.spawnMonster(DUNGEON, 0, 0, -12, { yaw: 0 });
  a.rpg.character.skills.Stealth = 100;
  a.moving = true;
  a.motionSpeed = 1;
  w.tick(0.04);
  assert.equal(rat._targetId, null, 'high Stealth evades an enemy facing away');
  assert.equal(a.rpg.character.skillUses.Stealth, 1);
  rat.yaw = Math.PI;
  w.tick(0.08);
  assert.equal(rat._targetId, a.id, 'stepping into clear forward vision is detected');
  assert.ok(Math.abs(rat.z - (-12 + classicEnemySpeed(90) * 0.04)) < 0.01);
  blocked = true;
  a.x = 15; a.z = 8;
  w.tick(0.5);
  assert.equal(rat.x, 0);
  assert.ok(rat.z > -12 && rat._pursuit.z === 0, 'it follows the recorded point without tracking the hidden player');
  assert.equal(w.events(1, 'monsterAttack').length, 0);
  w.tick(15);
  assert.equal(rat._targetId, null);
  assert.ok(rat.z < -5, 'interest expires and the shared enemy returns toward its marker');
});

test('a sheathed traveller can pacify an orc once, who fights when damaged', () => {
  const w = world({ combatOptions: { random: () => 0.35 } });
  const a = w.join(1, 'Ann', 0, 0, DUNGEON);
  const b = w.join(2, 'Ben', 1, 0, DUNGEON);
  a.rpg.character.skills.Orcish = 100;
  const orc = w.handle.spawnMonster(DUNGEON, 7, 0, -4, { yaw: Math.PI });
  w.tick(0.04);
  assert.equal(orc.hostile, false);
  assert.equal(a.rpg.character.skillUses.Orcish, 1);
  assert.match(w.events(1, 'combat').at(-1).text, /pacify the Orc.*Orcish/);
  assert.equal(w.events(2, 'combat').length, 0);
  w.tick(3);
  assert.equal(w.events(1, 'monsterAttack').length, 0);
  w.S.damageEntity(b, orc, 1);
  assert.equal(orc.hostile, true);
  assert.equal(orc._targetId, b.id);
});

test('concealment hides a traveller from an ordinary enemy while a ghost sees them', () => {
  const w = world({
    services: { magicStatus: (actor) => actor.rpg ? { invisible: true } : {} },
  });
  const a = w.join(1, 'Ann', 0, 0, DUNGEON);
  const rat = w.handle.spawnMonster(DUNGEON, 0, -2, -4, { yaw: Math.PI });
  const ghost = w.handle.spawnMonster(DUNGEON, 18, 2, -4, { yaw: Math.PI });
  w.tick(0.04);
  assert.equal(rat._targetId, null);
  assert.equal(ghost._targetId, a.id);
});

test('a swimming foe stays underwater and a flying foe can change height', () => {
  const sites = [{ x: 0, z: -8, y: -4, monsters: [11], waterLevel: 0, markerY: 160 }];
  const w = world({ combatOptions: { random: () => 0.5 }, services: { encounterSites: () => sites } });
  const a = w.join(1, 'Ann', 0, 0, DUNGEON);
  a.y = 1;
  w.tick(0.4);
  const fish = w.monsters()[0];
  assert.equal(fish._targetId, null);
  a.y = -1;
  w.tick(0.4);
  assert.equal(fish._targetId, a.id);
  assert.ok(fish.y > -4 && fish.y <= -0.25);
  a.y = 3;
  const bat = w.handle.spawnMonster(DUNGEON, 3, 8, 0, { y: 0, yaw: -Math.PI / 2 });
  w.tick(0.5);
  assert.ok(bat.y > 0 && bat.x < 8);
  assert.ok(fish.y <= -0.25);
});

test('a door-capable pursuer can open a nearby dungeon door after losing sight', () => {
  let closed = false;
  let opened = 0;
  const w = world({
    combatOptions: { random: () => 0.9 },
    services: {
      canSee: () => !closed,
      dungeonLocks: {
        doorOnLine: () => closed ? 'door' : null,
        enemyOpen: (level, door) => {
          assert.deepEqual([level, door], [DUNGEON, 'door']);
          opened++;
          closed = false;
          return true;
        },
      },
    },
  });
  const a = w.join(1, 'Ann', 0, 0, DUNGEON);
  a.y = 0;
  a.rpg.readied = true;
  const orc = w.handle.spawnMonster(DUNGEON, 7, 0, -1.9, { y: 0, yaw: Math.PI });
  w.tick(0.08);
  assert.equal(orc._targetId, a.id);
  closed = true;
  w.tick(0.04);
  assert.equal(opened, 1);
  assert.equal(closed, false);
  assert.equal(w.events(1, 'monsterAttack').length, 0);
});

test('monster melee wears armour on the struck part and calls the condition service for actual damage', () => {
  const contacts = [];
  const w = world({
    combatOptions: { random: () => 0 },
    services: { conditionExposure: (p, exposure) => contacts.push([p, exposure]) },
  });
  const a = w.join(1, 'Ann', 0, 0, DUNGEON);
  const helm = w.S.giveItem(a, 'steel-helm', 1);
  const cuirass = w.S.giveItem(a, 'steel-cuirass', 1);
  for (const item of [helm, cuirass]) assert.ok(w.rt.act(a, 'inventory.equip', { itemId: item.id }).ok);
  const health = a.rpg.character.health;
  const [headCondition, chestCondition] = [helm.condition, cuirass.condition];
  const rat = w.handle.spawnMonster(DUNGEON, 0, 0, -1.6, { yaw: Math.PI });
  w.tick(0.7);
  assert.equal(contacts.length, 0, 'the wind-up does no damage');
  w.tick(0.2);
  assert.equal(contacts.length, 1);
  assert.deepEqual(contacts[0], [a, { source: rat, damage: health - a.rpg.character.health, delivery: 'melee' }]);
  assert.ok(a.rpg.inventory.find((item) => item.id === helm.id).condition < headCondition);
  assert.equal(a.rpg.inventory.find((item) => item.id === cuirass.id).condition, chestCondition);
});

test('a recent dungeon alert allows a shared rest encounter on the classic minute schedule', () => {
  const services = { encounterSites: () => [], worldClock: () => ({ minutes: 144 }) };
  const w = world({ combatOptions: { random: () => 0 }, services });
  const a = w.join(1, 'Ann', 0, 0, DUNGEON);
  const b = w.join(2, 'Ben', 0, 0, DUNGEON);
  w.tick(0.04);
  assert.equal(w.S.restEncounter(a, 144), null, 'without an alert a dungeon rest does not spawn an enemy');
  const rat = w.handle.spawnMonster(DUNGEON, 0, 0, -4, { yaw: Math.PI });
  w.tick(0.08);
  w.S.damageEntity(a, rat, rat.maxHp);
  assert.equal(w.S.restEncounter(a, 156), null);
  const visitor = w.S.restEncounter(a, 144);
  assert.equal(visitor.origin, 'dungeon-rest');
  assert.ok(Math.hypot(visitor.x - a.x, visitor.z - a.z) >= 8);
  assert.ok(w.S.monstersIn(DUNGEON).includes(visitor));
  assert.equal(w.S.restEncounter(b, 144), null, 'the alert belongs to the detected character');
});

test('a poisoned enemy weapon delivers its poison once on successful melee contact', () => {
  const contacts = [];
  const w = world({
    combatOptions: { random: () => 0.35 },
    services: { conditionExposure: (_p, exposure) => contacts.push(exposure) },
  });
  const a = w.join(1, 'Ann', 0, 0, DUNGEON);
  a.rpg.readied = true;
  a.rpg.character.health = a.rpg.character.maxHealth = 500;
  const assassin = w.handle.spawnMonster(DUNGEON, 139, 0, -1.6, { yaw: Math.PI, level: 5 });
  w.tick(4);
  assert.ok(contacts.filter((hit) => hit.delivery === 'melee').length > 1);
  const poison = contacts.filter((hit) => hit.delivery === 'weapon');
  assert.equal(poison.length, 1);
  assert.equal(poison[0].source, assassin);
  assert.equal(poison[0].poison, 130);
});
