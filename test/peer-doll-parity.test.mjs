import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addItem, equip } from '../server/rpg/inventory.js';
import { projectPeerFigure } from '../server/rpg/peerAppearance.js';
import {
  dollFiles,
  dollLayers,
  itemArt,
  RACE_FILE_INDEX,
} from '../client/gameplay/inventory/images.js';
import {
  hasDistinctEquipment,
  peerToClassicDollInput,
  resolvePeerDollManifest,
} from '../client/gameplay/actors/peerGearAdapter.js';
import { textureFileName } from '../client/world/textures.js';

function makeEquippedRpg(character, templates) {
  const rpg = {
    character: {
      race: 'Breton',
      gender: 'Male',
      faceIndex: 0,
      className: 'Warrior',
      level: 5,
      ...character,
    },
    inventory: [],
    equipment: {},
    gold: 100,
  };
  for (const entry of templates) {
    const [template, slot] = Array.isArray(entry) ? entry : [entry, undefined];
    const item = addItem(rpg, template, 1);
    equip(rpg, item.id, slot);
  }
  return rpg;
}

const ARENA2_TEXTURE_RE = /^TEXTURE\.\d{3}$/;
const ARENA2_IMG_RE = /^BODY[01][0-7]I[01]\.IMG$/;
const ARENA2_FACE_RE = /^FACE[01][0-7]I0\.CIF$/;

describe('peerGearAdapter: server peerAppearance -> classic paper-doll parity', () => {
  it('resolves a Full Daedric Knight with exact parity to classic inventory paper-doll art', () => {
    const rpg = makeEquippedRpg(
      { race: 'Redguard', gender: 'Male', faceIndex: 3, className: 'Knight' },
      [
        'daedric-helm',
        'daedric-cuirass',
        'daedric-left-pauldron',
        'daedric-right-pauldron',
        'daedric-gauntlets',
        'daedric-greaves',
        'daedric-boots',
        'red-formal-cloak',
        'kite-shield',
        'daedric-longsword',
      ],
    );

    const projected = projectPeerFigure(rpg);
    const dollInput = peerToClassicDollInput(projected);
    const manifest = resolvePeerDollManifest(projected);

    assert.equal(hasDistinctEquipment(projected), true);
    assert.equal(manifest.bodyUnclothed, 'BODY01I0.IMG');
    assert.equal(manifest.bodyClothed, 'BODY01I1.IMG');
    assert.equal(manifest.heads, 'FACE01I0.CIF');
    assert.equal(manifest.faceIndex, 3);
    assert.equal(manifest.upperClothed, true);
    assert.equal(manifest.lowerClothed, false);

    // Every single equipped slot must resolve to the exact same archive, record, and dye
    // as the player's own classic inventory paper doll.
    const expectedLayers = dollLayers(rpg);
    assert.equal(manifest.layers.length, expectedLayers.length);
    assert.equal(manifest.layers.length, 10);

    for (let i = 0; i < expectedLayers.length; i++) {
      const expected = expectedLayers[i];
      const expectedArt = itemArt(expected.item, rpg.character, { doll: true, slot: expected.slot });
      const actual = manifest.layers[i];

      assert.equal(actual.slot, expected.slot);
      assert.match(actual.file, ARENA2_TEXTURE_RE);
      assert.equal(actual.file, textureFileName(expectedArt.archive));
      assert.equal(actual.frame, expectedArt.record);
      assert.equal(actual.dye, expectedArt.dye?.name ?? null);
    }

    // Verify specific Daedric Knight highlights:
    const bySlot = Object.fromEntries(manifest.layers.map((l) => [l.slot, l]));
    assert.equal(bySlot.chestArmor.dye, 'daedric');
    assert.equal(bySlot.chestArmor.material, 'daedric');
    assert.equal(bySlot.head.dye, 'daedric');
    assert.equal(bySlot.rightHand.file, 'TEXTURE.234');
    // One-handed longsword in rightHand uses record 12 + 1 = 13!
    assert.equal(bySlot.rightHand.frame, 13);
    assert.equal(bySlot.rightHand.dye, 'daedric');
    assert.equal(bySlot.leftHand.base, 'kite-shield');
    assert.equal(bySlot.leftHand.file, 'TEXTURE.251');
    assert.equal(bySlot.leftHand.frame, 35);

    // Cloak interior lining wraps behind the body (record 30 vs exterior 31).
    assert.ok(manifest.cloakInterior);
    assert.equal(manifest.cloakInterior.slot, 'cloak');
    assert.equal(manifest.cloakInterior.file, 'TEXTURE.241');
    assert.equal(manifest.cloakInterior.frame, 30);
    assert.equal(manifest.cloakInterior.dye, 'red');
    assert.equal(bySlot.cloak.frame, 31);
    assert.equal(dollInput.character.race, 'Redguard');
  });

  it('resolves a High Elf Mage in dyed robes with an iron staff', () => {
    const rpg = makeEquippedRpg(
      { race: 'High Elf', gender: 'Female', faceIndex: 4, className: 'Mage' },
      [
        'purple-plain-robes',
        'blue-casual-cloak',
        'brown-shoes',
        'iron-staff',
      ],
    );

    const projected = projectPeerFigure(rpg);
    const manifest = resolvePeerDollManifest(projected);

    assert.equal(hasDistinctEquipment(projected), true);
    assert.equal(manifest.bodyUnclothed, 'BODY14I0.IMG');
    assert.equal(manifest.bodyClothed, 'BODY14I1.IMG');
    assert.equal(manifest.heads, 'FACE14I0.CIF');
    assert.equal(manifest.faceIndex, 4);
    assert.equal(manifest.upperClothed, true);
    assert.equal(manifest.lowerClothed, false);

    const bySlot = Object.fromEntries(manifest.layers.map((l) => [l.slot, l]));
    // Female High Elf clothing archive = 235 + morph(1) = 236.
    assert.equal(bySlot.chestClothes.file, 'TEXTURE.236');
    assert.equal(bySlot.chestClothes.frame, 47);
    assert.equal(bySlot.chestClothes.dye, 'purple');
    assert.equal(bySlot.feet.file, 'TEXTURE.236');
    assert.equal(bySlot.feet.frame, 10);
    assert.equal(bySlot.feet.dye, 'brown');

    // Female weapon archive = 233; Staff is two-handed so record stays 21.
    assert.equal(bySlot.rightHand.file, 'TEXTURE.233');
    assert.equal(bySlot.rightHand.frame, 21);
    assert.equal(bySlot.rightHand.dye, 'iron');
    assert.equal(bySlot.rightHand.material, 'iron');

    // Cloak exterior (22) and interior lining (21) in TEXTURE.236.
    assert.equal(bySlot.cloak.file, 'TEXTURE.236');
    assert.equal(bySlot.cloak.frame, 22);
    assert.equal(bySlot.cloak.dye, 'blue');
    assert.ok(manifest.cloakInterior);
    assert.equal(manifest.cloakInterior.file, 'TEXTURE.236');
    assert.equal(manifest.cloakInterior.frame, 21);
    assert.equal(manifest.cloakInterior.dye, 'blue');
  });

  it('resolves a Wood Elf Archer in leather armor with a longbow', () => {
    const rpg = makeEquippedRpg(
      { race: 'Wood Elf', gender: 'Male', faceIndex: 2, className: 'Archer' },
      [
        'leather-cuirass',
        'leather-greaves',
        'leather-boots',
        'leather-gauntlets',
        'green-casual-cloak',
        'elven-long-bow',
      ],
    );

    const projected = projectPeerFigure(rpg);
    const manifest = resolvePeerDollManifest(projected);

    assert.equal(hasDistinctEquipment(projected), true);
    assert.equal(manifest.bodyUnclothed, 'BODY05I0.IMG');
    assert.equal(manifest.bodyClothed, 'BODY05I1.IMG');
    assert.equal(manifest.heads, 'FACE05I0.CIF');
    assert.equal(manifest.faceIndex, 2);

    const bySlot = Object.fromEntries(manifest.layers.map((l) => [l.slot, l]));
    // Male Wood Elf armor archive = 249 + morph(1) = 250.
    assert.equal(bySlot.chestArmor.file, 'TEXTURE.250');
    assert.equal(bySlot.chestArmor.frame, 3);
    assert.equal(bySlot.chestArmor.material, 'leather');
    assert.equal(bySlot.chestArmor.dye, 'silver');

    assert.equal(bySlot.legsArmor.file, 'TEXTURE.250');
    assert.equal(bySlot.legsArmor.frame, 10);
    assert.equal(bySlot.legsArmor.material, 'leather');

    assert.equal(bySlot.gloves.file, 'TEXTURE.250');
    assert.equal(bySlot.gloves.frame, 8);
    assert.equal(bySlot.feet.file, 'TEXTURE.250');
    assert.equal(bySlot.feet.frame, 0);

    // Longbow is two-handed: male weapon archive 234, record 11, elven dye.
    assert.equal(bySlot.rightHand.file, 'TEXTURE.234');
    assert.equal(bySlot.rightHand.frame, 11);
    assert.equal(bySlot.rightHand.material, 'elven');
    assert.equal(bySlot.rightHand.dye, 'elven');

    // Green cloak exterior + interior lining in TEXTURE.240 (male elf clothing).
    assert.equal(bySlot.cloak.file, 'TEXTURE.240');
    assert.equal(bySlot.cloak.frame, 22);
    assert.equal(bySlot.cloak.dye, 'green');
    assert.equal(manifest.cloakInterior?.file, 'TEXTURE.240');
    assert.equal(manifest.cloakInterior?.frame, 21);
    assert.equal(manifest.cloakInterior?.dye, 'green');
  });

  it('resolves unarmored peers across all 8 classic races and both genders with waist-split censor clothing', () => {
    const races = Object.keys(RACE_FILE_INDEX);
    assert.equal(races.length, 8);

    for (const race of races) {
      for (const gender of ['Male', 'Female']) {
        const faceIndex = (RACE_FILE_INDEX[race] + (gender === 'Female' ? 1 : 0)) % 10;
        const rpg = makeEquippedRpg({ race, gender, faceIndex, className: 'Monk' }, []);
        const projected = projectPeerFigure(rpg);
        const manifest = resolvePeerDollManifest(projected);
        const expectedFiles = dollFiles({ race, gender, faceIndex });

        assert.equal(hasDistinctEquipment(projected), false);
        assert.match(manifest.bodyUnclothed, ARENA2_IMG_RE);
        assert.match(manifest.bodyClothed, ARENA2_IMG_RE);
        assert.match(manifest.heads, ARENA2_FACE_RE);
        assert.equal(manifest.bodyUnclothed, expectedFiles.bodyUnclothed);
        assert.equal(manifest.bodyClothed, expectedFiles.bodyClothed);
        assert.equal(manifest.heads, expectedFiles.heads);
        assert.equal(manifest.faceIndex, faceIndex);
        assert.equal(manifest.layers.length, 0);
        assert.equal(manifest.cloakInterior, null);
        // Classic waist-split censor clothing flags: both false -> clothed torso & legs rendered.
        assert.equal(manifest.upperClothed, false);
        assert.equal(manifest.lowerClothed, false);
      }
    }

    // Spot-check specific race BODY/FACE filenames for Breton, Redguard, Dark Elf, Argonian, Khajiit.
    assert.equal(resolvePeerDollManifest({ race: 'Breton', gender: 'Male' }).bodyClothed, 'BODY00I1.IMG');
    assert.equal(resolvePeerDollManifest({ race: 'Redguard', gender: 'Female' }).heads, 'FACE11I0.CIF');
    assert.equal(resolvePeerDollManifest({ race: 'Dark Elf', gender: 'Male' }).bodyUnclothed, 'BODY03I0.IMG');
    assert.equal(resolvePeerDollManifest({ race: 'Khajiit', gender: 'Female' }).bodyClothed, 'BODY16I1.IMG');
    assert.equal(resolvePeerDollManifest({ race: 'Argonian', gender: 'Male' }).heads, 'FACE07I0.CIF');
  });

  it('reconstructs missing doll metadata for legacy/minimal peers and normalizes slot aliases', () => {
    const legacyPeer = {
      race: 'nord',
      gender: 'male',
      faceIndex: 1,
      weapon: { template: 'steel-longsword' },
    };

    assert.equal(hasDistinctEquipment(legacyPeer), true);
    const manifest = resolvePeerDollManifest(legacyPeer);
    assert.equal(manifest.bodyUnclothed, 'BODY02I0.IMG');
    assert.equal(manifest.bodyClothed, 'BODY02I1.IMG');
    assert.equal(manifest.heads, 'FACE02I0.CIF');
    assert.equal(manifest.layers.length, 1);
    assert.equal(manifest.layers[0].slot, 'rightHand');
    assert.equal(manifest.layers[0].file, 'TEXTURE.234');
    // One-handed longsword in rightHand => 12 + 1 = 13.
    assert.equal(manifest.layers[0].frame, 13);
    assert.equal(manifest.layers[0].material, 'steel');
    assert.equal(manifest.layers[0].dye, 'steel');

    // Compact peer using `peer.worn` directly with `hands` and `cloak1` aliases and no `doll` objects.
    const aliasPeer = {
      race: 'dark_elf',
      gender: 'Female',
      worn: {
        hands: { base: 'gauntlets', group: 'armor', material: 'ebony' },
        cloak1: { template: 'purple-casual-cloak' },
        chestClothes: { base: 'short-shirt', group: 'clothing', dye: 'white' },
        legsClothes: { base: 'casual-pants', group: 'clothing', dye: 'brown' },
      },
    };

    const aliasManifest = resolvePeerDollManifest(aliasPeer);
    assert.equal(hasDistinctEquipment(aliasPeer), true);
    assert.equal(aliasManifest.bodyUnclothed, 'BODY13I0.IMG');
    assert.equal(aliasManifest.upperClothed, true);
    assert.equal(aliasManifest.lowerClothed, true);

    const bySlot = Object.fromEntries(aliasManifest.layers.map((l) => [l.slot, l]));
    assert.equal(bySlot.gloves.file, 'TEXTURE.246');
    assert.equal(bySlot.gloves.frame, 9); // baseRecord 8 + plate offset 1
    assert.equal(bySlot.gloves.dye, 'ebony');
    assert.equal(bySlot.cloak.file, 'TEXTURE.236');
    assert.equal(bySlot.cloak.frame, 22);
    assert.equal(bySlot.cloak.dye, 'purple');
    assert.equal(aliasManifest.cloakInterior?.file, 'TEXTURE.236');
    assert.equal(aliasManifest.cloakInterior?.frame, 21);
    assert.equal(aliasManifest.cloakInterior?.dye, 'purple');
  });
});
