// Classic character figures for remote players (client/gameplay/actors/peerFigure.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvePeerAppearance,
  peerFigureTint,
  describePeerTarget,
  isPeerDefeated,
} from '../client/gameplay/actors/peerFigure.js';
import {
  PEOPLE,
  ENEMY_ARCHIVES,
  PERSON_ARCHIVES,
  GUARD_ARCHIVE,
} from '../client/gameplay/actors/tables.js';
import { CLOTH_DYES, METAL_DYES } from '../client/gameplay/inventory/dyes.js';

const PRESET_CLASSES = [
  ['Mage', 486, 485],
  ['Spellsword', 476, 475],
  ['Battlemage', 490, 489],
  ['Sorcerer', 478, 477],
  ['Healer', 486, 485],
  ['Nightblade', 490, 489],
  ['Bard', 484, 483],
  ['Burglar', 484, 483],
  ['Rogue', 480, 479],
  ['Acrobat', 484, 483],
  ['Thief', 484, 483],
  ['Assassin', 480, 479],
  ['Monk', 488, 487],
  ['Archer', 482, 481],
  ['Ranger', 482, 481],
  ['Barbarian', 488, 487],
  ['Warrior', 488, 487],
  ['Knight', 488, 487],
];

describe('peerFigure: all 18 classic preset classes (male & female)', () => {
  test('every preset class resolves to its exact classic 8-direction archive when armed/readied', () => {
    for (const [className, maleArchive, femaleArchive] of PRESET_CLASSES) {
      const m = resolvePeerAppearance({ id: `m-${className}`, className, gender: 'male', readied: true });
      assert.equal(m.archive, maleArchive, `${className} male archive`);
      assert.equal(m.layout, 'enemy', `${className} male layout`);
      assert.equal(m.personLike, false);
      assert.equal(m.readied, true);
      assert.equal(m.defeated, false);
      assert.ok(ENEMY_ARCHIVES.has(m.archive), `${className} male in ENEMY_ARCHIVES`);
      assert.deepEqual(m.corpse, [380, 1], `${className} male corpse`);
      assert.ok(typeof m.key === 'string' && m.key.length > 0);
      assert.ok(typeof m.figureLabel === 'string' && m.figureLabel.length > 0);

      const f = resolvePeerAppearance({ id: `f-${className}`, className, gender: 'female', readied: true });
      assert.equal(f.archive, femaleArchive, `${className} female archive`);
      assert.equal(f.layout, 'enemy', `${className} female layout`);
      assert.equal(f.personLike, false);
      assert.ok(ENEMY_ARCHIVES.has(f.archive), `${className} female in ENEMY_ARCHIVES`);
      assert.deepEqual(f.corpse, [380, 1], `${className} female corpse`);
    }
  });

  test('guard role or disguise resolves to City Watch (TEXTURE.399)', () => {
    const byRole = resolvePeerAppearance({ id: 'g1', role: 'guard', gender: 'male' });
    assert.equal(byRole.archive, GUARD_ARCHIVE);
    assert.equal(byRole.guard, true);
    assert.equal(byRole.layout, 'enemy');
    assert.deepEqual(byRole.corpse, [380, 1]);

    const byClass = resolvePeerAppearance({ id: 'g2', className: 'City Watch', gender: 'female' });
    assert.equal(byClass.archive, 399);
    assert.equal(byClass.guard, true);
  });
});

describe('peerFigure: custom classes and gear-aware classic sprite selection', () => {
  test('custom class with bow resolves to Archer (482/481)', () => {
    const m = resolvePeerAppearance({ id: 'c1', className: 'Shadowhunter', gender: 'male', weaponKind: 'bow' });
    assert.equal(m.archive, 482);
    assert.equal(m.layout, 'enemy');

    const f = resolvePeerAppearance({ id: 'c2', className: 'Shadowhunter', gender: 'female', weaponKind: 'bow' });
    assert.equal(f.archive, 481);
    assert.equal(f.layout, 'enemy');
  });

  test('custom class with robes or staff resolves to Mage (486/485) or Battlemage (490/489) when armored', () => {
    const robedM = resolvePeerAppearance({ id: 'r1', className: 'Adept', gender: 'male', wearingRobes: true });
    assert.equal(robedM.archive, 486);

    const staffF = resolvePeerAppearance({ id: 'r2', className: 'Adept', gender: 'female', weaponKind: 'staff' });
    assert.equal(staffF.archive, 485);

    const armoredCasterM = resolvePeerAppearance({
      id: 'r3', className: 'Warlock', gender: 'male', wearingRobes: true, wearingHeavyArmor: true,
    });
    assert.equal(armoredCasterM.archive, 490);

    const armoredCasterF = resolvePeerAppearance({
      id: 'r4', className: 'Warlock', gender: 'female', weaponKind: 'staff', wearingHeavyArmor: true,
    });
    assert.equal(armoredCasterF.archive, 489);
  });

  test('custom class with heavy armor resolves to Warrior (488/487) and dagger to Thief (484/483)', () => {
    const heavyM = resolvePeerAppearance({ id: 'h1', className: 'Paladin', gender: 'male', wearingHeavyArmor: true });
    assert.equal(heavyM.archive, 488);
    assert.equal(heavyM.layout, 'enemy');

    const heavyF = resolvePeerAppearance({ id: 'h2', className: 'Paladin', gender: 'female', wearingHeavyArmor: true });
    assert.equal(heavyF.archive, 487);

    const daggerM = resolvePeerAppearance({ id: 'd1', className: 'Cutpurse', gender: 'male', weaponKind: 'dagger' });
    assert.equal(daggerM.archive, 484);

    const daggerF = resolvePeerAppearance({ id: 'd2', className: 'Cutpurse', gender: 'female', weaponKind: 'dagger' });
    assert.equal(daggerF.archive, 483);
  });

  test('archetype field takes precedence for custom classes', () => {
    const app = resolvePeerAppearance({
      id: 'a1', className: 'Custom Spellblade', archetype: 'Spellsword', gender: 'female', readied: true,
    });
    assert.equal(app.archive, 475);
    assert.equal(app.figureLabel, 'Spellsword');
  });
});

describe('peerFigure: peaceful townsperson variant stability & danger zones', () => {
  test('unarmored, unarmed peer in town uses race & gender town-walker archive stabilized by faceIndex', () => {
    const p = {
      id: 'town-1', name: 'Elysana', race: 'redguard', gender: 'female',
      className: 'Mage', faceIndex: 2, readied: false, weaponKind: 'none',
    };
    const app1 = resolvePeerAppearance(p, { location: 'town:Daggerfall/Daggerfall' });
    const app2 = resolvePeerAppearance({ ...p, id: 'different-session-id' }, { location: 'town:Daggerfall/Daggerfall' });

    assert.equal(app1.layout, 'person');
    assert.equal(app1.personLike, true);
    assert.equal(app1.archive, PEOPLE.redguard.female[2]);
    assert.ok(PERSON_ARCHIVES.has(app1.archive));
    assert.equal(app1.archive, app2.archive, 'same faceIndex yields identical town-walker archive');
    assert.deepEqual(app1.corpse, [380, 1], 'civilian peer still has valid corpse tuple');

    // Explicit variant overrides faceIndex when provided.
    const explicit = resolvePeerAppearance({ ...p, variant: 1 }, { location: 'town:Daggerfall/Daggerfall' });
    assert.equal(explicit.archive, PEOPLE.redguard.female[1]);

    // Nord male and fallback race (High Elf -> Breton set)
    const nord = resolvePeerAppearance({ id: 'n1', race: 'nord', gender: 'male', faceIndex: 3 });
    assert.equal(nord.archive, PEOPLE.nord.male[3]);

    const altmer = resolvePeerAppearance({ id: 'he1', race: 'High Elf', gender: 'female', faceIndex: 0 });
    assert.equal(altmer.archive, PEOPLE.breton.female[0]);
  });

  test('dungeon and wilderness locations switch unarmed peers into their class humanoid figure', () => {
    const peer = { id: 'p-dun', race: 'breton', gender: 'male', className: 'Ranger', readied: false };
    const inTown = resolvePeerAppearance(peer, { location: 'town:Daggerfall/Gothway Garden' });
    assert.equal(inTown.layout, 'person');

    const inDungeon = resolvePeerAppearance(peer, { location: 'dungeon:Daggerfall/Privateers Hold' });
    assert.equal(inDungeon.layout, 'enemy');
    assert.equal(inDungeon.archive, 482);

    const inWilderness = resolvePeerAppearance(peer, { location: 'wilderness:109,159' });
    assert.equal(inWilderness.layout, 'enemy');
    assert.equal(inWilderness.archive, 482);

    const viaFlag = resolvePeerAppearance(peer, { inDangerZone: true });
    assert.equal(viaFlag.layout, 'enemy');
    assert.equal(viaFlag.archive, 482);
  });
});

describe('peerFigure: beast forms and defeated / downed peers', () => {
  test('werewolf and wereboar beast forms override class, gear, and town rules', () => {
    const wolf = resolvePeerAppearance({
      id: 'w1', form: 'werewolf', className: 'Mage', gender: 'female', wearingRobes: true, armorTier: 'daedric',
    });
    assert.equal(wolf.archive, 264);
    assert.equal(wolf.layout, 'enemy');
    assert.equal(wolf.mobile?.id, 9);
    assert.deepEqual(wolf.corpse, [96, 5]);
    assert.equal(wolf.tint, null);
    assert.equal(wolf.figureLabel, 'Werewolf');

    const boar = resolvePeerAppearance({
      id: 'w2', form: 'wereboar', className: 'Knight', gender: 'male', readied: true,
    });
    assert.equal(boar.archive, 269);
    assert.equal(boar.layout, 'enemy');
    assert.equal(boar.mobile?.id, 14);
    assert.deepEqual(boar.corpse, [96, 5]);
    assert.equal(boar.tint, null);
    assert.equal(boar.figureLabel, 'Wereboar');
  });

  test('isPeerDefeated detects defeated flag and dead/corpse animations', () => {
    assert.equal(isPeerDefeated(null), false);
    assert.equal(isPeerDefeated({}), false);
    assert.equal(isPeerDefeated({ defeated: false, animation: 'idle' }), false);
    assert.equal(isPeerDefeated({ defeated: true }), true);
    assert.equal(isPeerDefeated({ animation: 'dead' }), true);
    assert.equal(isPeerDefeated({ animation: 'corpse' }), true);
    assert.equal(isPeerDefeated({ animation: 'DEAD' }), true);
  });

  test('defeated peers always set defeated=true, valid corpse [archive, record], and distinct key', () => {
    const alive = resolvePeerAppearance({ id: 'k1', className: 'Knight', gender: 'male', readied: false });
    const downed = resolvePeerAppearance({ id: 'k1', className: 'Knight', gender: 'male', readied: false, defeated: true });

    assert.equal(alive.defeated, false);
    assert.equal(downed.defeated, true);
    assert.ok(Array.isArray(downed.corpse) && downed.corpse.length === 2);
    assert.ok(Number.isInteger(downed.corpse[0]) && Number.isInteger(downed.corpse[1]));
    assert.notEqual(alive.key, downed.key, 'defeated state updates appearance key');
  });
});

describe('peerFigure: material & dye tint bounds', () => {
  test('neutral/default armor tiers and unarmored peers return null tint', () => {
    assert.equal(peerFigureTint(null), null);
    assert.equal(peerFigureTint({}), null);
    assert.equal(peerFigureTint({ armorTier: 'steel' }), null);
    assert.equal(peerFigureTint({ armorTier: 'iron' }), null);
    assert.equal(peerFigureTint({ armorTier: 'leather' }), null);
    assert.equal(peerFigureTint({ armorTier: 'chain' }), null);
    assert.equal(peerFigureTint({ armorTier: 'unarmored' }), null);
  });

  test('distinctive metal armor tiers and all cloth dyes stay within safe, readable RGB bounds', () => {
    const distinctiveMetals = Object.keys(METAL_DYES).filter((k) => k !== 'iron' && k !== 'steel');
    for (const tier of distinctiveMetals) {
      const tint = peerFigureTint({ armorTier: tier });
      assert.ok(Array.isArray(tint) && tint.length === 3, `${tier} produces [r,g,b]`);
      for (const ch of tint) {
        assert.ok(ch >= 0.80 && ch <= 1.12, `${tier} channel ${ch} stays within [0.80, 1.12]`);
      }
    }

    for (const dye of Object.keys(CLOTH_DYES)) {
      const tint = peerFigureTint({ primaryDye: dye });
      assert.ok(Array.isArray(tint) && tint.length === 3, `dye ${dye} produces [r,g,b]`);
      for (const ch of tint) {
        assert.ok(ch >= 0.80 && ch <= 1.12, `dye ${dye} channel ${ch} stays within [0.80, 1.12]`);
      }
    }

    // Two Warriors with different armor tiers share archive 488 but get distinct tints and keys.
    const daedric = resolvePeerAppearance({ id: 'p1', className: 'Warrior', gender: 'male', readied: true, armorTier: 'daedric' });
    const elven = resolvePeerAppearance({ id: 'p2', className: 'Warrior', gender: 'male', readied: true, armorTier: 'elven' });
    assert.equal(daedric.archive, 488);
    assert.equal(elven.archive, 488);
    assert.notDeepEqual(daedric.tint, elven.tint);
    assert.ok(daedric.tint[0] > daedric.tint[2], 'Daedric skews crimson');
    assert.ok(elven.tint[0] > elven.tint[2] && elven.tint[1] > elven.tint[2], 'Elven skews warm gold');
    assert.notEqual(daedric.key, elven.key);

    // Mithril skews cool ice-blue; Ebony darkens subtly; Orcish skews bronze-green.
    const mithril = peerFigureTint({ armorTier: 'mithril' });
    const ebony = peerFigureTint({ armorTier: 'ebony' });
    const orcish = peerFigureTint({ armorTier: 'orcish' });
    assert.ok(mithril[2] > mithril[0], 'Mithril skews ice-blue');
    assert.ok(ebony[0] < 0.92 && ebony[1] < 0.92 && ebony[2] < 0.95, 'Ebony skews charcoal-slate');
    assert.ok(orcish[1] > orcish[0] && orcish[1] > orcish[2], 'Orcish skews bronze-green');

    // Robed caster prefers cloth dye over neutral/light armor.
    const robedMage = peerFigureTint({ wearingRobes: true, primaryDye: 'purple', armorTier: 'elven' });
    assert.deepEqual(robedMage, peerFigureTint({ primaryDye: 'purple' }));
  });
});

describe('peerFigure: rich classic crosshair target labels', () => {
  test('formats full identity, guild tag, readied weapon, and defeated state', () => {
    const barenziah = {
      name: 'Barenziah', level: 12, race: 'High Elf', className: 'Mage', guildTag: 'ARC', readied: true,
    };
    const appB = resolvePeerAppearance(barenziah);
    assert.equal(
      describePeerTarget(barenziah, appB),
      'Barenziah — Lv. 12 High Elf Mage [ARC] · weapon readied',
    );

    const gothryd = {
      name: 'Gothryd', level: 8, race: 'Breton', className: 'Knight', defeated: true,
    };
    const appG = resolvePeerAppearance(gothryd);
    assert.equal(
      describePeerTarget(gothryd, appG),
      'Gothryd — Lv. 8 Breton Knight (Defeated)',
    );

    // Minimal fallback when metadata is absent.
    assert.equal(describePeerTarget({}), 'Traveller');
    assert.equal(describePeerTarget({ name: 'Morgiah' }), 'Morgiah');
    assert.equal(describePeerTarget({ name: 'Morgiah', readied: true }), 'Morgiah · weapon readied');
    assert.equal(describePeerTarget({ name: 'Morgiah', animation: 'corpse' }), 'Morgiah (Defeated)');
  });
});
