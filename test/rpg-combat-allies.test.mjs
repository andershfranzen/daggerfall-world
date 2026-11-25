// Artifact items and creature stats come from installed classic data. Fixtures stage the encounters;
// the signed-in live case uses the same inventory and loot actions through real WebSockets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { install as combat } from '../server/rpg/combat.js';
import { install as magic } from '../server/rpg/magic.js';
import { features } from '../server/rpg/features.js';
import { DEFAULT_LOCATION } from '../server/rpg/runtime.js';
import { accountSession, createFixtureWorld, LiveClient, localArena2, startLiveWorld, tempDir } from './support/rpg-session.mjs';

const arena2 = localArena2();
const installed = { skip: !arena2 && 'installed classic data required' };
const combatFeatures = (roll = 0.18) => features.filter((f) => ['character', 'inventory', 'alchemy', 'combat', 'magic'].includes(f.name))
  .map((f) => {
    if (f.name === 'combat') return { ...f, install: (ctx) => combat(ctx, { random: () => roll, classicSpawns: false }) };
    if (f.name === 'magic') return { ...f, install: (ctx) => magic(ctx, { rng: () => 0.9 }) };
    return f;
  });

async function fixture(t, roll) {
  const tmp = tempDir('dfw-allies-', '/var/tmp');
  const world = await createFixtureWorld({ dbPath: join(tmp.dir, 'world.db'), features: combatFeatures(roll), dataPath: arena2 });
  t.after(() => { world.close(); tmp.remove(); });
  assert.deepEqual(world.installErrors, []);
  const a = world.connect('summoner', 'Summoner');
  const b = world.connect('witness', 'Witness');
  Object.assign(a.player, { x: 0, z: 0, y: 0, yaw: 0 });
  Object.assign(b.player, { x: 0, z: 0, y: 0, yaw: 0 });
  const s = world.ctx.services;
  const spawn = (id, x, z, opts = {}) => {
    const e = s.createEnemy(DEFAULT_LOCATION, id, x, z, { origin: 'fixture', yaw: Math.PI, y: 0, ...opts });
    e._encountered = true;
    return e;
  };
  const tick = (ms) => { for (let i = 0; i < ms; i += 50) world.tick(50); };
  const give = (c, name) => s.giveItem(c.player, 'artifact-' + name, 1);
  const use = (c, item) => c.must('inventory.use', { itemId: item.id });
  const allyOf = (c) => [...world.ctx.entities.values()].find((e) => e._ally === c.id && !e.dead);
  return { world, a, b, s, spawn, tick, give, use, allyOf };
}

test('Skull selects the nearest eligible species and keeps ownership and quest combat separate', installed, async (t) => {
  const { world, a, b, s, spawn, tick, give, use, allyOf } = await fixture(t);
  const skull = give(a, 'skull-of-corruption');
  const otherSkull = give(b, 'skull-of-corruption');
  const quest = spawn(24, 0, -2.1, { visibleTo: [b.id] });
  quest._quest = { owner: b.id, foe: '_fixture' };
  quest.hostile = false; // staged just before activation
  spawn(3, 0, -1, { y: 8 });
  use(a, skull);
  use(b, otherSkull);
  assert.match(a.events('inventory').at(-1).text, /no monsters nearby/);
  assert.match(b.events('inventory').at(-1).text, /no monsters nearby/);
  assert.equal(skull.condition, skull.maxCondition);
  assert.equal(otherSkull.condition, otherSkull.maxCondition);
  assert.equal(allyOf(a), undefined);

  const source = spawn(7, 0, -5);
  source.hp = 1;
  source.name = 'Named Orc';
  source._items = ['fixture-only-equipment'];
  spawn(0, 0, -8);
  use(a, skull);
  use(b, otherSkull);
  const copy = allyOf(a);
  const otherCopy = allyOf(b);
  assert.notEqual(copy.id, source.id);
  assert.notEqual(copy.id, otherCopy.id);
  assert.deepEqual([copy.monsterId, copy.name, copy.hp, copy.y], [7, 'Orc', copy.maxHp, 0]);
  assert.ok(copy.hp > source.hp);
  assert.ok(!copy._items.includes('fixture-only-equipment'));
  assert.equal(copy.visibleTo, undefined, 'independent public combat actor');
  assert.equal(copy._quest, undefined);
  assert.equal(skull.condition, skull.maxCondition - 100);
  assert.equal(otherSkull.condition, otherSkull.maxCondition - 100);
  assert.equal(s.monsterOpponents(copy, otherCopy), false);
  assert.equal(s.monsterOpponents(copy, quest), false);
  assert.equal(s.monsterOpponents(quest, copy), false);
  assert.equal(a.entity(quest.id), null);
  assert.ok(b.entity(quest.id));

  b.must('combat.ready', { ready: true });
  assert.match(b.act('combat.attack', { targetId: copy.id }).error, /nothing there/);
  assert.throws(() => s.damageEntity(b.player, copy, 1), /cannot be harmed/);
  const before = quest.hp;
  tick(4000);
  assert.equal(quest.hp, before);
  assert.ok(!a.events().some((e) => e.entityId === quest.id || e.targetId === quest.id));
  assert.ok([...b.events('monsterAttack'), ...a.events('monsterAttack')].every((e) =>
    ![copy.id, otherCopy.id].includes(e.entityId) || typeof e.targetId === 'string'));

  const rollback = world.runtime.ctx.runAtomic(a.player, 'fixture', () => {
    world.ctx.emit('locationChanged', { player: a.player, from: DEFAULT_LOCATION, to: 'town:fixture/Elsewhere' });
    throw new Error('fixture rollback');
  });
  assert.equal(rollback.ok, false);
  assert.ok(world.ctx.entities.has(copy.id), 'departure is rolled back with the transfer');
  a.player.rpg.location = 'town:fixture/Elsewhere';
  world.ctx.emit('locationChanged', { player: a.player, from: DEFAULT_LOCATION, to: a.player.rpg.location });
  assert.equal(world.ctx.entities.has(copy.id), false);
  assert.ok(world.ctx.entities.has(otherCopy.id), 'the witness retains their own summon');
  world.leave(b);
  assert.equal(world.ctx.entities.has(otherCopy.id), false);
});

test('summons can be provoked by their owner and leave no loot, soul, or player reward', installed, async (t) => {
  const { a, b, s, spawn, tick, give, use, allyOf } = await fixture(t);
  const skull = give(a, 'skull-of-corruption');
  const foe = spawn(0, 0, -5);
  use(a, skull);
  const copy = allyOf(a);
  s.banishMonster(foe);
  assert.equal(s.monsterThreatens(copy, a.player), false);
  const trapped = s.castItemSpell(a.player, 62, { targetId: copy.id });
  assert.match(trapped.results[0].reason, /no trappable soul/);
  assert.equal(s.damageEntity(a.player, copy, 1).damage, 1);
  assert.equal(copy.hostile, true);
  assert.equal(s.monsterThreatens(copy, a.player), true);
  assert.equal(s.monsterThreatens(copy, b.player), false);
  tick(1600);
  assert.ok(a.events('monsterAttack').some((e) => e.entityId === copy.id && e.targetId === a.id));
  assert.ok(!b.events('monsterAttack').some((e) => e.entityId === copy.id && e.targetId === b.id));
  assert.equal(s.damageEntity(a.player, copy, 1000).killed, true);
  assert.equal(copy.lootable, false);
  assert.match(a.act('combat.loot', { targetId: copy.id }).error, /nothing there/);
  assert.equal(a.events('kill').length, 0);
  assert.equal(a.events('death').filter((e) => e.entityId === copy.id).length, 1);
});

test('a failed artifact save restores the charge and removes the staged summon before retry', installed, async (t) => {
  const { world, a, s, spawn, give, use, allyOf } = await fixture(t);
  const rose = give(a, 'sanguine-rose');
  spawn(7, 0, -5);
  const save = world.writeRows;
  world.writeRows = () => { throw new Error('fixture save failed'); };
  try {
    assert.equal(a.act('inventory.use', { itemId: rose.id }).ok, false);
  } finally {
    world.writeRows = save;
  }
  assert.equal(allyOf(a), undefined);
  assert.equal(a.player.rpg.inventory.find((i) => i.id === rose.id).condition, rose.maxCondition);
  use(a, rose);
  assert.equal(s.monstersIn(DEFAULT_LOCATION).filter((e) => e._ally === a.id).length, 1);
  assert.equal(s.combatStats().spawned['27|sanguine-rose'], 1);
  assert.equal(a.player.rpg.inventory.find((i) => i.id === rose.id).condition, rose.maxCondition - 100);
  assert.equal(a.events('inventory').filter((e) => /summons a Daedroth/.test(e.text)).length, 1);
});

test('copied archers and summoned spellcasters use shared projectile checks against monsters', installed, async (t) => {
  const { a, b, s, spawn, tick, give, use, allyOf } = await fixture(t, 0.01);
  const skull = give(a, 'skull-of-corruption');
  const archer = spawn(141, 0, -11);
  use(a, skull);
  const copy = allyOf(a);
  assert.equal(copy.monsterId, 141);
  const arrows = () => s.countItem(a.player, 'arrow');
  const before = arrows();
  tick(2500);
  const launch = a.events('arrowLaunch').find((e) => e.entityId === copy.id);
  assert.ok(launch);
  assert.ok(b.events('arrowImpact').some((e) => e.projectileId === launch.projectileId && e.targetId === archer.id));
  assert.ok(a.events('hit').some((e) => e.attackerId === copy.id && e.source === 'arrow' && e.entityId === archer.id));
  assert.equal(arrows(), before, 'the owner did not receive the monster’s arrows');

  s.banishMonster(copy);
  s.banishMonster(archer);
  const fireDaedra = spawn(26, 0, -7);
  use(a, skull);
  const caster = allyOf(a);
  assert.equal(caster.monsterId, 26);
  s.banishMonster(fireDaedra);
  const foe = spawn(7, 0, -8);
  const privateFoe = spawn(7, 0.5, -8, { visibleTo: [a.id] });
  const spell = caster._spells.find((i) => s.enemySpellInfo(i)?.targetType === 'areaAtRange');
  assert.ok(spell, 'the installed Fire Daedra has a ranged area spell');
  const privateHp = privateFoe.hp;
  const hp = foe.hp;
  const health = [a.player.rpg.character.health, b.player.rpg.character.health];
  assert.equal(s.enemyCast(caster, spell, privateFoe, { free: true }), null);
  assert.equal(s.enemyCast(caster, spell, b.player, { free: true }), null);
  assert.ok(s.enemyCast(caster, spell, foe, { free: true })?.pending);
  tick(400);
  const impacts = b.events('spellImpact').filter((e) => e.casterId === caster.id && e.targetIds.includes(foe.id));
  assert.equal(impacts.length, 1);
  assert.deepEqual(impacts[0].targetIds, [foe.id]);
  assert.ok(foe.hp < hp);
  assert.equal(privateFoe.hp, privateHp);
  assert.deepEqual([a.player.rpg.character.health, b.player.rpg.character.health], health);
});

test('two signed-in accounts see an allied hit, retaliation, one death and one corpse claim', installed, async (t) => {
  const tmp = tempDir('dfw-allies-live-', '/var/tmp');
  const clients = [];
  let foe;
  let roseId;
  const live = await startLiveWorld({ dir: tmp.dir, arena2Dir: arena2, features: [...combatFeatures(), { name: 'allies-fixture', install(ctx) {
    ctx.onJoin((p) => Object.assign(p, { x: 0, z: 0, yaw: 0 }));
    ctx.onAction('fixture.allies', (p) => {
      const s = ctx.services;
      roseId = s.giveItem(p, 'artifact-sanguine-rose', 1).id;
      foe = s.createEnemy(ctx.location(p), 7, 0, -3.3, { yaw: Math.PI, origin: 'fixture' });
      foe.hp = foe.maxHp = 85; // staged HP ensures the Orc has time to retaliate
      foe._encountered = true; // the checkpoint starts after any language roll
      // Start the encounter when both sides are present. An Orc already in melee with a
      // player correctly keeps that target, which would make the result depend on socket timing.
      foe._nextSense = Infinity;
    });
    ctx.on('artifactUsed', () => { if (foe) foe._nextSense = 0; });
  } }] });
  t.after(async () => {
    for (const client of clients) await client.close();
    await live.close();
    tmp.remove();
  });
  async function connect(username) {
    const jar = await accountSession(live.base, username);
    assert.ok(jar.cookie);
    const client = new LiveClient(live.port, { cookie: jar.cookie });
    clients.push(client);
    await client.opened;
    client.send({ type: 'join', name: username, account: true });
    await client.next((m) => m.type === 'welcome');
    return client;
  }
  const a = await connect('Summoner');
  const b = await connect('Witness');
  const event = (f) => (m) => m.type === 'gameEvent' && f(m.event);
  assert.ok((await a.act('fixture.allies')).ok);
  await a.stateWhere((m) => m.character.inventory.some((i) => i.id === roseId), 'Rose in pack');
  assert.ok((await a.act('inventory.use', { itemId: roseId })).ok);
  const view = await b.stateWhere((m) => m.entities.some((e) => e.origin === 'sanguine-rose'), 'shared summon');
  const ally = view.entities.find((e) => e.origin === 'sanguine-rose');
  const attack = event((e) => e.kind === 'hit' && e.entityId === foe.id && e.attackerId === ally.id && e.damage > 0);
  const aHit = await a.next(attack, 'owner saw an allied hit', 10000);
  const bHit = await b.next(attack, 'witness saw the same allied hit', 10000);
  assert.deepEqual(aHit, bHit);
  const retaliation = event((e) => e.kind === 'monsterAttack' && e.entityId === foe.id && e.targetId === ally.id);
  if (!b.messages.some(retaliation)) await b.next(retaliation, 'the Orc struck back at the Daedroth', 10000);
  const death = event((e) => e.kind === 'death' && e.entityId === foe.id);
  const aDeath = await a.next(death, 'owner saw the Orc die', 12000);
  const bDeath = await b.next(death, 'witness saw the Orc die', 12000);
  assert.deepEqual(aDeath, bDeath);
  assert.equal(aDeath.event.killerId, ally.id);
  assert.match((await b.act('combat.loot', { targetId: foe.id })).error, /Only those who fought/);
  assert.ok((await a.act('combat.loot', { targetId: foe.id })).ok);
  assert.match((await a.act('combat.loot', { targetId: foe.id })).error, /already been searched/);
  for (const client of clients) {
    assert.equal(client.messages.filter(death).length, 1);
    assert.equal(client.messages.filter(event((e) => e.kind === 'kill' && e.entityId === foe.id)).length, 0);
  }
  assert.equal(a.messages.filter(event((e) => e.kind === 'loot' && e.entityId === foe.id)).length, 1);
  t.diagnostic(`Two sockets saw Daedroth hit Orc for ${aHit.event.damage} HP (${aHit.event.hp}/${aHit.event.maxHp} remaining), then one death and one owner claim.`);
});
