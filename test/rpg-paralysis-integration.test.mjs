import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOCATION } from '../server/rpg/runtime.js';
import * as character from '../server/rpg/character.js';
import * as combat from '../server/rpg/combat.js';
import * as magic from '../server/rpg/magic.js';
import * as conditions from '../server/rpg/conditions.js';
import * as locomotion from '../server/rpg/locomotion.js';
import { createCollision } from '../server/rpg/collision.js';
import { openPlaneWorld } from '../client/gameplay/collision/world.js';
import { ATTRIBUTES, SKILL_GROUP_POOL, groupsOf, spendLowest } from '../client/gameplay/character/rules.js';
import { createFixtureWorld, localArena2, STRICT } from './support/rpg-session.mjs';

const dataPath = process.env.ARENA2_DIR || localArena2();

test('[asset] Spider Touch leaves a High Elf Mage mobile and stops a Nord Mage until the spell expires', {
  skip: !dataPath && !STRICT && 'operator ARENA2 directory required',
}, async (t) => {
  assert.ok(dataPath, 'strict runs need the installed game data');
  const willpower = [];
  for (const race of ['High Elf', 'Nord']) {
    // Both worlds roll the same Mage and spider. Force the touch to proc and an ordinary
    // saving throw to fail, so race is the deciding factor. Geometry is a flat fixture.
    const rolls = [0.01, 0.99];
    const world = await createFixtureWorld({
      dbPath: ':memory:', dataPath,
      features: [
        character,
        { name: 'collision', install: (ctx) => createCollision(ctx, { fixtures: { [DEFAULT_LOCATION]: openPlaneWorld() } }) },
        combat, magic, conditions, locomotion,
      ],
      config: { magic: { rng: () => rolls.shift() ?? 0.99 } },
    });
    t.after(() => world.close());
    assert.deepEqual(world.installErrors, []);
    const client = world.connect('mage', 'Aster');
    client.must('character.roll', { className: 'Mage' });
    const draft = client.character.character.draft;
    assert.equal(draft.career.source, 'cfg');
    const attributes = spendLowest({ ...draft.attributeBase }, ATTRIBUTES, draft.bonusPool);
    const skills = { ...draft.skillBase };
    for (const [, group] of groupsOf(draft.career)) spendLowest(skills, group, SKILL_GROUP_POOL);
    client.must('character.create', { name: 'Aster', race, gender: 'Female', attributes, skills, biography: { random: true } });

    const { player } = client;
    const s = world.ctx.services;
    await s.collision.whenSettled(player.rpg.location);
    willpower.push(s.effectiveAttribute(player, 'Willpower'));
    const spider = s.createEnemy(player.rpg.location, 6, player.x, player.z - 1, { yaw: Math.PI });
    assert.equal(spider?.monsterId, 6);
    const cast = s.enemyCast(spider, 66, player, { free: true });
    assert.equal(cast?.spell.name, 'Spider Touch');
    assert.equal(cast.results.length, 1);
    const result = client.events('spellResult').at(-1);
    assert.equal(result.casterId, spider.id);
    assert.equal(result.spellId, 'std:66');
    assert.equal(result.results[0].targetId, `player:${client.id}`);
    assert.equal(result.results[0].outcome, cast.results[0].outcome);
    const rounds = s.magicStatus(player).paralyzed ?? 0;
    const forward = () => {
      const next = s.stepPlayer(player, { forward: 1, yaw: 0 }, 0.1);
      return Math.hypot(next.x - player.x, next.z - player.z);
    };
    const moved = forward();
    if (race === 'High Elf') {
      assert.equal(result.results[0].outcome, 'saved');
      assert.equal(rounds, 0);
      assert.ok(moved > 0);
    } else {
      assert.equal(result.results[0].outcome, 'applied');
      assert.ok(rounds > 0);
      assert.equal(moved, 0);
      world.runtime.entities.delete(spider.id); // No further bites during the recovery check.
      for (let i = 0; i < rounds; i++) world.tick(magic.MAGIC.roundMs);
      assert.ok(!s.magicStatus(player).paralyzed);
      assert.ok(forward() > 0, 'movement returns when the last round expires');
    }
    t.diagnostic(`${race} Mage: ${result.text}  Active rounds: ${rounds}. Forward input moved ${moved.toFixed(2)} m.`);
  }
  assert.equal(willpower[0], willpower[1]);
});
