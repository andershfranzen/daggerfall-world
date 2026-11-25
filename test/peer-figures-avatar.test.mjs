import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LABEL_HEIGHT,
  CLASSIC_RACE_PALETTES,
  MATERIAL_COLORS,
  CLOTH_DYE_COLORS,
  figureStyleFor,
  ClassicFigure,
} from '../client/render/classicFigure.js';
import { RACES } from '../client/gameplay/character/rules.js';
import { CLOTH_DYES } from '../client/gameplay/inventory/dyes.js';

function assertValidRgb(rgb, label = 'rgb') {
  assert.ok(Array.isArray(rgb) && rgb.length === 3, `${label} must be an [r, g, b] array`);
  for (let i = 0; i < 3; i++) {
    assert.ok(Number.isFinite(rgb[i]), `${label}[${i}] must be finite`);
    assert.ok(rgb[i] >= 0 && rgb[i] <= 1, `${label}[${i}] (${rgb[i]}) must be in [0, 1]`);
  }
}

function assertValidRendererContract(posed, label = 'posed') {
  assert.ok(posed && Array.isArray(posed.parts) && posed.parts.length > 0, `${label} must expose non-empty parts[]`);
  for (let i = 0; i < posed.parts.length; i++) {
    const part = posed.parts[i];
    assert.ok(part.model instanceof Float32Array, `${label}.parts[${i}].model must be Float32Array`);
    assert.equal(part.model.length, 16, `${label}.parts[${i}].model must have length 16`);
    for (let j = 0; j < 16; j++) {
      assert.ok(Number.isFinite(part.model[j]), `${label}.parts[${i}].model[${j}] must be finite`);
    }
    assertValidRgb(part.color, `${label}.parts[${i}].color`);
  }
}

function rgbKey(rgb) {
  return rgb.map((c) => Math.round(c * 1000)).join(',');
}

function maxWorldY(parts) {
  let maxY = -Infinity;
  for (const p of parts) {
    // World-space center Y is m[13]; approximate vertical half-extent from basis column Y components.
    const halfY = (Math.abs(p.model[1]) + Math.abs(p.model[5]) + Math.abs(p.model[9])) * 0.5;
    const top = p.model[13] + halfY;
    if (top > maxY) maxY = top;
  }
  return maxY;
}

describe('ClassicFigure — race palettes & dyes', () => {
  it('exports LABEL_HEIGHT = 2.15 and authentic palettes for all 8 classic Daggerfall races', () => {
    assert.equal(LABEL_HEIGHT, 2.15);
    assert.equal(RACES.length, 8);

    const seenSkins = new Set();
    for (const race of RACES) {
      assert.ok(Object.hasOwn(CLASSIC_RACE_PALETTES, race.name), `missing palette for ${race.name}`);
      const style = figureStyleFor('peer-race-test', { race: race.name });
      assert.equal(style.race, race.name);
      assertValidRgb(style.skin, `${race.name}.skin`);
      assertValidRgb(style.hair, `${race.name}.hair`);
      seenSkins.add(rgbKey(style.skin));
    }
    assert.equal(seenSkins.size, 8, 'all 8 classic Daggerfall races must produce distinct skin palettes');

    // Spot-check iconic hues: Dark Elf ash-slate (B >= R), High Elf golden (R,G > B), Argonian green (G > R,B)
    const darkElf = figureStyleFor('s', { race: 'Dark Elf' }).skin;
    const highElf = figureStyleFor('s', { race: 'High Elf' }).skin;
    const argonian = figureStyleFor('s', { race: 'Argonian' }).skin;
    assert.ok(darkElf[2] >= darkElf[0], 'Dark Elf skin should be cool ash-slate');
    assert.ok(highElf[0] > highElf[2] + 0.2 && highElf[1] > highElf[2] + 0.15, 'High Elf skin should be golden');
    assert.ok(argonian[1] > argonian[0] && argonian[1] > argonian[2], 'Argonian skin should be forest-scale green');
  });

  it('supports every clothing dye name from client/gameplay/inventory/dyes.js', () => {
    for (const dyeName of Object.keys(CLOTH_DYES)) {
      assert.ok(Object.hasOwn(CLOTH_DYE_COLORS, dyeName), `missing dye color for ${dyeName}`);
      const style = figureStyleFor('peer-dye', { primaryDye: dyeName });
      assert.equal(style.primaryDye, dyeName);
      assert.deepEqual(style.cloth, [...CLOTH_DYE_COLORS[dyeName]]);
      assertValidRgb(style.cloth, `dye.${dyeName}`);
    }
  });

  it('falls back deterministically to seed when peer is null or omitted', () => {
    const a = figureStyleFor('player-42');
    const b = figureStyleFor('player-42', null);
    assert.deepEqual(a, b);
    assertValidRgb(a.skin);
    assertValidRgb(a.cloth);
  });
});

describe('ClassicFigure — armor tiers, robes, accessories & weapons', () => {
  it('renders distinct authentic palettes for Daedric, Elven, Mithril, and other armor tiers', () => {
    const tiers = ['daedric', 'ebony', 'mithril', 'elven', 'dwarven', 'orcish', 'silver', 'steel', 'iron', 'leather'];
    const seen = new Set();
    for (const tier of tiers) {
      assert.ok(Object.hasOwn(MATERIAL_COLORS, tier), `missing MATERIAL_COLORS.${tier}`);
      const style = figureStyleFor('armored', { armorTier: tier });
      assert.equal(style.armorTier, tier);
      assertValidRgb(style.armor, `armor.${tier}`);
      seen.add(rgbKey(style.armor));

      const fig = new ClassicFigure('armored', { armorTier: tier });
      const posed = fig.pose(0, 0, 0, 0, false, 0.016, 1.0);
      assertValidRendererContract(posed, `armor.${tier}`);
    }
    assert.equal(seen.size, tiers.length, 'each armor tier should have a distinct RGB color');

    // Daedric is dark crimson-iron (R > G,B); Mithril is silver-blue (B > R); Elven is pale gold (R,G > B)
    assert.ok(MATERIAL_COLORS.daedric[0] > MATERIAL_COLORS.daedric[1] * 2);
    assert.ok(MATERIAL_COLORS.mithril[2] > MATERIAL_COLORS.mithril[0]);
    assert.ok(MATERIAL_COLORS.elven[0] > MATERIAL_COLORS.elven[2] && MATERIAL_COLORS.elven[1] > MATERIAL_COLORS.elven[2]);
  });

  it('adds silhouette parts for robes, cloak, helm, and shield', () => {
    const base = new ClassicFigure('gear', { race: 'Breton', primaryDye: 'blue' });
    const withCloak = new ClassicFigure('gear', { race: 'Breton', primaryDye: 'blue', worn: { cloak: { dye: 'red' } } });
    const withHelm = new ClassicFigure('gear', { race: 'Breton', primaryDye: 'blue', armorTier: 'steel', worn: { head: { material: 'steel' } } });
    const withShield = new ClassicFigure('gear', { race: 'Breton', primaryDye: 'blue', hasShield: true });
    const withRobes = new ClassicFigure('gear', { race: 'Breton', primaryDye: 'purple', wearingRobes: true });

    assert.equal(withCloak.style.hasCloak, true);
    assert.ok(withCloak.parts.length > base.parts.length, 'cloak should add cape geometry');

    assert.equal(withHelm.style.hasHelm, true);
    assert.ok(withHelm.parts.length > base.parts.length, 'helm should add crown/crest geometry');

    assert.equal(withShield.style.hasShield, true);
    assert.ok(withShield.parts.length > base.parts.length, 'shield should add shield geometry');

    assert.equal(withRobes.style.wearingRobes, true);
    assert.equal(withRobes.style.hasCloak, true, 'robes include a trailing cloak');

    for (const fig of [base, withCloak, withHelm, withShield, withRobes]) {
      assertValidRendererContract(fig.pose(2, 0, -3, 0.5, true, 0.016, 2.5));
    }
  });

  it('renders readied bow, staff, sword (blade), axe, blunt, and dagger weapons with ready stance and swing pulse', () => {
    const unarmed = new ClassicFigure('hero', { race: 'Redguard', readied: false, weaponKind: 'blade' });
    const weapons = ['blade', 'staff', 'bow', 'axe', 'blunt', 'dagger'];

    for (const weaponKind of weapons) {
      const armed = new ClassicFigure('hero', {
        race: 'Redguard',
        armorTier: 'elven',
        readied: true,
        weaponKind,
      });
      assert.equal(armed.style.weaponKind, weaponKind);
      assert.ok(armed.parts.length > unarmed.parts.length, `readied ${weaponKind} should add weapon parts`);

      const idlePose = armed.pose(0, 0, 0, 0, false, 0.016, 5.0);
      assertValidRendererContract(idlePose, `weapon.${weaponKind}.idle`);
      const beforeSwing = Float32Array.from(idlePose.parts[idlePose.parts.length - 1].model);

      armed.triggerSwing(5.0);
      const midSwingPose = armed.pose(0, 0, 0, 0, false, 0.016, 5.18);
      assertValidRendererContract(midSwingPose, `weapon.${weaponKind}.swing`);
      const duringSwing = midSwingPose.parts[midSwingPose.parts.length - 1].model;

      let moved = false;
      for (let i = 0; i < 16; i++) {
        if (Math.abs(beforeSwing[i] - duringSwing[i]) > 1e-4) {
          moved = true;
          break;
        }
      }
      assert.ok(moved, `triggerSwing should animate the readied ${weaponKind}`);
    }
  });

  it('renders distinct taller werewolf and wereboar beast form silhouettes', () => {
    const human = new ClassicFigure('lycan', { race: 'Nord' });
    const wolf = new ClassicFigure('lycan', { race: 'Nord', beastForm: 'werewolf' });
    const boar = new ClassicFigure('lycan', { race: 'Nord', beastForm: 'wereboar' });

    const humanTop = maxWorldY(human.pose(0, 0, 0, 0, false, 0.016, 1).parts);
    const wolfTop = maxWorldY(wolf.pose(0, 0, 0, 0, false, 0.016, 1).parts);
    const boarTop = maxWorldY(boar.pose(0, 0, 0, 0, false, 0.016, 1).parts);

    assert.equal(wolf.style.beastForm, 'werewolf');
    assert.equal(boar.style.beastForm, 'wereboar');
    assert.ok(wolfTop > humanTop, `werewolf (${wolfTop.toFixed(2)}) should be taller than humanoid (${humanTop.toFixed(2)})`);
    assert.ok(boarTop > humanTop, `wereboar (${boarTop.toFixed(2)}) should be taller than humanoid (${humanTop.toFixed(2)})`);
    assert.ok(boar.parts.length > wolf.parts.length, 'wereboar includes twin tusks');

    assertValidRendererContract(wolf.pose(1, 0, 1, 0.4, true, 0.016, 2));
    assertValidRendererContract(boar.pose(1, 0, 1, 0.4, true, 0.016, 2));
  });

  it('rotates defeated peers cleanly into a supine ground pose at y + 0.16', () => {
    const groundY = 4.0;
    const standing = new ClassicFigure('fallen', { race: 'High Elf', armorTier: 'mithril', defeated: false });
    const downed = new ClassicFigure('fallen', { race: 'High Elf', armorTier: 'mithril', defeated: true });

    const standTop = maxWorldY(standing.pose(10, groundY, -5, 0.7, false, 0.016, 3).parts);
    const downPose = downed.pose(10, groundY, -5, 0.7, false, 0.016, 3);
    assertValidRendererContract(downPose, 'defeated');
    const downTop = maxWorldY(downPose.parts);

    assert.ok(standTop > groundY + 1.5, 'standing figure should reach above groundY + 1.5');
    assert.ok(downTop < groundY + 0.6, `defeated figure top (${downTop.toFixed(2)}) should lie near groundY + 0.16`);
    assert.ok(downTop > groundY, 'defeated figure should stay above ground plane');
  });
});

describe('ClassicFigure — live setPeer() updates & renderer compatibility', () => {
  it('updates appearance live without NaN matrices and only rebuilds when signature changes', () => {
    const fig = new ClassicFigure('peer-live', { race: 'Dark Elf', primaryDye: 'green' });
    const initialPartsRef = fig.parts;

    // Identical appearance should not rebuild parts array
    assert.equal(fig.setPeer({ race: 'Dark Elf', primaryDye: 'green' }), false);
    assert.strictEqual(fig.parts, initialPartsRef);

    // Equipping Daedric armor + helm + shield + readied blade rebuilds cleanly
    const changed = fig.setPeer({
      race: 'Dark Elf',
      primaryDye: 'red',
      armorTier: 'daedric',
      worn: { head: { material: 'daedric' }, cloak: { dye: 'red' }, leftHand: { material: 'daedric' } },
      readied: true,
      weaponKind: 'blade',
    });
    assert.equal(changed, true);
    assert.notStrictEqual(fig.parts, initialPartsRef);

    // Simulate walking, swinging, transforming, and defeat with edge-case inputs
    fig.triggerSwing(1.0);
    assertValidRendererContract(fig.pose(0, 0, 0, 0, true, 0.016, 1.1));
    assertValidRendererContract(fig.pose(0.4, 0, -0.5, 0.3, true, 0.016, 1.2));

    assert.equal(fig.setPeer({ race: 'Dark Elf', beastForm: 'werewolf' }), true);
    assertValidRendererContract(fig.pose(0.8, 0, -1.0, 0.6, true, 0.016, 1.3));

    assert.equal(fig.setPeer({ race: 'Dark Elf', armorTier: 'mithril', defeated: true }), true);
    assertValidRendererContract(fig.pose(0.8, 0, -1.0, 0.6, false, 0.016, 1.4));

    // Guard against NaN/undefined pose arguments
    assertValidRendererContract(fig.pose(NaN, undefined, Infinity, NaN, false, -1, NaN));
  });
});
