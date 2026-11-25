import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VISIBLE_EQUIP_SLOTS,
  ARCHETYPES,
  ARMOR_TIERS,
  inferArchetype,
  projectVisibleEquipment,
  projectPeerFigure,
} from '../server/rpg/peerAppearance.js';
import {
  SLOTS,
  STARTER_KIT,
  STARTER_CLOTHES,
  addItem,
  equip,
  normalizeRpg,
} from '../server/rpg/inventory.js';
import { itemArt } from '../client/gameplay/inventory/images.js';

function makeRpg(items = [], equipSlots = []) {
  const rpg = { inventory: [], equipment: {}, gold: 500 };
  for (const [template, qty = 1, opts] of items) {
    addItem(rpg, template, qty, opts);
  }
  for (const [template, slot] of equipSlots) {
    const it = rpg.inventory.find((i) => i.template === template && !i.equipped);
    assert.ok(it, `expected item ${template} in inventory`);
    equip(rpg, it.id, slot);
  }
  normalizeRpg(rpg);
  return rpg;
}

test('VISIBLE_EQUIP_SLOTS matches real server/rpg/inventory.js visible slots and excludes jewellery', () => {
  assert.ok(Object.isFrozen(VISIBLE_EQUIP_SLOTS));
  assert.ok(Object.isFrozen(ARCHETYPES));
  assert.ok(Object.isFrozen(ARMOR_TIERS));

  const expectedInventoryVisible = SLOTS.filter((s) => !/^(amulet|bracer|ring|bracelet|mark)\d$/.test(s));
  for (const slot of expectedInventoryVisible) {
    assert.ok(VISIBLE_EQUIP_SLOTS.includes(slot), `VISIBLE_EQUIP_SLOTS should include inventory slot "${slot}"`);
  }
  for (const jewel of ['amulet0', 'amulet1', 'bracer0', 'ring0', 'bracelet0', 'mark0']) {
    assert.ok(!VISIBLE_EQUIP_SLOTS.includes(jewel), `VISIBLE_EQUIP_SLOTS must exclude jewellery slot "${jewel}"`);
  }
  assert.ok(VISIBLE_EQUIP_SLOTS.includes('cloak2'));
});

test('projectVisibleEquipment maps real inventory.js equipment & resolves hands->gloves alias', () => {
  const rpg = makeRpg(
    [
      ['steel-longsword', 1],
      ['kite-shield', 1],
      ['dwarven-cuirass', 1],
      ['iron-helm', 1],
      ['leather-gauntlets', 1],
      ['red-formal-cloak', 1],
      ['blue-short-shirt', 1],
      ['brown-casual-pants', 1],
      ['ruby', 3],
      ['potion-of-healing', 5],
    ],
    [
      ['steel-longsword', 'rightHand'],
      ['kite-shield', 'leftHand'],
      ['dwarven-cuirass', 'chestArmor'],
      ['iron-helm', 'head'],
      ['leather-gauntlets', 'gloves'],
      ['red-formal-cloak', 'cloak'],
      ['blue-short-shirt', 'chestClothes'],
      ['brown-casual-pants', 'legsClothes'],
    ],
  );

  const proj = projectVisibleEquipment(rpg);
  assert.equal(proj.armorTier, 'dwarven');
  assert.equal(proj.wearingHeavyArmor, true);
  assert.equal(proj.wearingRobes, false);
  assert.equal(proj.hasShield, true);
  assert.equal(proj.weaponKind, 'blade');
  assert.equal(proj.primaryDye, 'red');

  assert.equal(proj.worn.rightHand.template, 'steel-longsword');
  assert.equal(proj.worn.rightHand.skill, 'Long Blade');
  assert.equal(proj.worn.leftHand.template, 'kite-shield');
  assert.equal(proj.worn.chestArmor.material, 'dwarven');
  assert.equal(proj.worn.gloves.template, 'leather-gauntlets');
  assert.equal(proj.worn.cloak.dye, 'red');
  assert.equal(proj.worn.feet, undefined);

  // Alias support: `hands` resolves to `gloves` when `gloves` is not set.
  const aliasRpg = {
    inventory: rpg.inventory,
    equipment: { hands: rpg.equipment.gloves },
  };
  const aliasProj = projectVisibleEquipment(aliasRpg);
  assert.equal(aliasProj.worn.gloves.template, 'leather-gauntlets');
  assert.equal(aliasProj.worn.hands, undefined);
});

test('projectVisibleEquipment classifies weapons, robes, and armor tiers accurately', () => {
  const bowRpg = makeRpg([['elven-long-bow', 1], ['green-open-tunic', 1]], [['elven-long-bow', 'rightHand'], ['green-open-tunic', 'chestClothes']]);
  const bowProj = projectVisibleEquipment(bowRpg);
  assert.equal(bowProj.weaponKind, 'bow');
  assert.equal(bowProj.armorTier, 'none');
  assert.equal(bowProj.wearingHeavyArmor, false);
  assert.equal(bowProj.wearingRobes, false);
  assert.equal(bowProj.primaryDye, 'green');

  const mageRpg = makeRpg(
    [['mithril-staff', 1], ['purple-plain-robes', 1], ['blue-casual-cloak', 1]],
    [['mithril-staff', 'rightHand'], ['purple-plain-robes', 'chestClothes'], ['blue-casual-cloak', 'cloak']],
  );
  const mageProj = projectVisibleEquipment(mageRpg);
  assert.equal(mageProj.weaponKind, 'staff');
  assert.equal(mageProj.wearingRobes, true);
  assert.equal(mageProj.wearingHeavyArmor, false);
  assert.equal(mageProj.primaryDye, 'blue');

  const daggerRpg = makeRpg([['ebony-dagger', 1], ['daedric-helm', 1]], [['ebony-dagger', 'rightHand'], ['daedric-helm', 'head']]);
  const daggerProj = projectVisibleEquipment(daggerRpg);
  assert.equal(daggerProj.weaponKind, 'dagger');
  assert.equal(daggerProj.armorTier, 'daedric');
  assert.equal(daggerProj.wearingHeavyArmor, true);

  const axeRpg = makeRpg([['orcish-battle-axe', 1]], [['orcish-battle-axe', 'rightHand']]);
  assert.equal(projectVisibleEquipment(axeRpg).weaponKind, 'axe');

  const bluntRpg = makeRpg([['silver-warhammer', 1]], [['silver-warhammer', 'rightHand']]);
  assert.equal(projectVisibleEquipment(bluntRpg).weaponKind, 'blunt');
});

test('inferArchetype handles standard classic classes and all custom class archetypes', () => {
  // Standard classes
  assert.equal(inferArchetype({ className: 'Mage' }), 'mage');
  assert.equal(inferArchetype({ className: 'Burglar' }), 'thief');
  assert.equal(inferArchetype({ className: 'Acrobat' }), 'rogue');
  assert.equal(inferArchetype({ className: 'Knight' }), 'knight');
  assert.equal(inferArchetype({ className: 'Nightblade' }), 'nightblade');

  // Custom Mage
  const customMage = {
    className: 'Arcane Scholar',
    custom: {
      primarySkills: ['Destruction', 'Alteration', 'Mysticism'],
      majorSkills: ['Illusion', 'Thaumaturgy', 'Restoration'],
      minorSkills: ['Daedric', 'Dragonish', 'Etiquette', 'Medical', 'Short Blade', 'Running'],
      spellPointMultiplier: 2.0,
      hitPointsPerLevel: 6,
    },
  };
  const mageGear = projectVisibleEquipment(makeRpg(
    [['iron-staff', 1], ['purple-plain-robes', 1]],
    [['iron-staff', 'rightHand'], ['purple-plain-robes', 'chestClothes']],
  ));
  assert.equal(inferArchetype(customMage, mageGear), 'mage');

  // Custom Archer
  const customArcher = {
    className: 'Windstalker',
    custom: {
      primarySkills: ['Archery', 'Critical Strike', 'Running'],
      majorSkills: ['Dodging', 'Stealth', 'Climbing'],
      minorSkills: ['Short Blade', 'Jumping', 'Swimming', 'Medical', 'Streetwise', 'Lockpicking'],
      spellPointMultiplier: 0.5,
      hitPointsPerLevel: 14,
    },
  };
  const bowGear = projectVisibleEquipment(makeRpg([['steel-long-bow', 1]], [['steel-long-bow', 'rightHand']]));
  assert.equal(inferArchetype(customArcher, bowGear), 'archer');

  // Custom Knight
  const customKnight = {
    className: 'Order Paladin',
    custom: {
      primarySkills: ['Long Blade', 'Etiquette', 'Blunt Weapon'],
      majorSkills: ['Restoration', 'Critical Strike', 'Medical'],
      minorSkills: ['Axe', 'Running', 'Jumping', 'Climbing', 'Dragonish', 'Streetwise'],
      spellPointMultiplier: 0.5,
      hitPointsPerLevel: 20,
    },
  };
  const knightGear = projectVisibleEquipment(makeRpg(
    [['steel-longsword', 1], ['tower-shield', 1], ['steel-cuirass', 1]],
    [['steel-longsword', 'rightHand'], ['tower-shield', 'leftHand'], ['steel-cuirass', 'chestArmor']],
  ));
  assert.equal(inferArchetype(customKnight, knightGear), 'knight');

  // Custom Assassin
  const customAssassin = {
    className: 'Shadow Fang',
    custom: {
      primarySkills: ['Backstabbing', 'Short Blade', 'Stealth'],
      majorSkills: ['Critical Strike', 'Climbing', 'Dodging'],
      minorSkills: ['Lockpicking', 'Pickpocket', 'Running', 'Jumping', 'Streetwise', 'Archery'],
      spellPointMultiplier: 0.5,
      hitPointsPerLevel: 14,
    },
  };
  const assassinGear = projectVisibleEquipment(makeRpg(
    [['steel-dagger', 1], ['leather-cuirass', 1]],
    [['steel-dagger', 'rightHand'], ['leather-cuirass', 'chestArmor']],
  ));
  assert.equal(inferArchetype(customAssassin, assassinGear), 'assassin');

  // Custom Spellsword
  const customSpellsword = {
    className: 'Rune Blade',
    custom: {
      primarySkills: ['Long Blade', 'Destruction', 'Restoration'],
      majorSkills: ['Alteration', 'Mysticism', 'Dodging'],
      minorSkills: ['Running', 'Critical Strike', 'Illusion', 'Thaumaturgy', 'Medical', 'Etiquette'],
      spellPointMultiplier: 1.5,
      hitPointsPerLevel: 12,
    },
  };
  const swordGear = projectVisibleEquipment(makeRpg(
    [['silver-longsword', 1], ['chain-cuirass', 1]],
    [['silver-longsword', 'rightHand'], ['chain-cuirass', 'chestArmor']],
  ));
  assert.equal(inferArchetype(customSpellsword, swordGear), 'spellsword');

  // Custom Battlemage
  const customBattlemage = {
    className: 'War Caster',
    custom: {
      primarySkills: ['Destruction', 'Axe', 'Mysticism'],
      majorSkills: ['Alteration', 'Thaumaturgy', 'Long Blade'],
      minorSkills: ['Blunt Weapon', 'Dodging', 'Running', 'Medical', 'Daedric', 'Critical Strike'],
      spellPointMultiplier: 1.75,
      hitPointsPerLevel: 10,
    },
  };
  assert.equal(inferArchetype(customBattlemage, knightGear), 'battlemage');
});

test('projectPeerFigure strictly strips private data (pack items, enchantments, gold, quests, stats)', () => {
  const rpg = makeRpg(
    [
      [
        'ebony-longsword',
        1,
        {
          extra: {
            magic: {
              identified: true,
              name: 'Soulrender',
              uses: 50,
              value: 9999,
              enchantments: [{ type: 11, param: 0 }],
            },
            quest: { uid: 'q-secret-42', symbol: 'blade' },
            stolen: { from: 'Bank of Daggerfall', at: 12345 },
          },
        },
      ],
      ['ruby', 10],
      ['potion-of-healing', 8],
      ['white-short-shirt', 1],
      ['leather-boots', 1],
    ],
    [
      ['ebony-longsword', 'rightHand'],
      ['white-short-shirt', 'chestClothes'],
      ['leather-boots', 'feet'],
    ],
  );
  rpg.gold = 987654;
  rpg.quests = [{ id: 'secret-quest', stage: 3 }];
  rpg.character = {
    name: 'Aldric',
    race: 'Breton',
    gender: 'Male',
    className: 'Spellsword',
    faceIndex: 14, // should clamp to 9
    level: 7,
    attributes: { Strength: 88, Intelligence: 77 },
    skills: { 'Long Blade': 65, Destruction: 55 },
    health: 42,
    maxHealth: 90,
    magicka: 12,
    maxMagicka: 110,
    biography: { backstory: ['Secret past'] },
  };

  const player = {
    id: 'p-1',
    accountId: 'acc-secret-999',
    name: 'Aldric',
    rpg,
  };

  const projected = projectPeerFigure(player, {
    guildTitle: 'Warlock',
    orderTag: 'IRON',
  });

  assert.equal(projected.race, 'Breton');
  assert.equal(projected.gender, 'Male');
  assert.equal(projected.className, 'Spellsword');
  assert.equal(projected.faceIndex, 9);
  assert.equal(projected.level, 7);
  assert.equal(projected.archetype, 'spellsword');
  assert.equal(projected.guildTitle, 'Warlock');
  assert.equal(projected.orderTag, 'IRON');
  assert.equal(projected.figure.worn.rightHand.name, 'Soulrender');

  const json = JSON.stringify(projected);
  for (const forbidden of [
    'acc-secret-999',
    '987654',
    'ruby',
    'potion-of-healing',
    'enchantments',
    'q-secret-42',
    'Bank of Daggerfall',
    'secret-quest',
    'Secret past',
    'attributes',
    'skills',
    'maxHealth',
    'maxMagicka',
    'condition',
    'weight',
    'value',
    'charges',
    'magic',
    'stolen',
    'inventory',
  ]) {
    assert.ok(!json.includes(forbidden), `projected JSON must not leak "${forbidden}"`);
  }
  assert.equal(projected.figure.worn.rightHand.id, undefined);
});

test('projectPeerFigure produces deterministic JSON, stays compact (< 1 KB typical), and keeps itemArt-compatible doll specs', () => {
  // Typical adventurer loadouts (< 1 KB)
  const typicalMage = makeRpg(
    [['mithril-staff', 1], ['purple-plain-robes', 1], ['blue-casual-cloak', 1]],
    [['mithril-staff', 'rightHand'], ['purple-plain-robes', 'chestClothes'], ['blue-casual-cloak', 'cloak']],
  );
  typicalMage.character = { race: 'High Elf', gender: 'Female', className: 'Mage', faceIndex: 2, level: 4 };
  const mageBytes = Buffer.byteLength(JSON.stringify(projectPeerFigure({ rpg: typicalMage }, { orderTag: 'ARC' })), 'utf8');
  assert.ok(mageBytes < 1024, `expected typical mage peer figure < 1024 bytes, got ${mageBytes} bytes`);

  const typicalFighter = makeRpg(
    [['steel-longsword', 1], ['steel-cuirass', 1], ['steel-helm', 1], ['steel-boots', 1]],
    [['steel-longsword', 'rightHand'], ['steel-cuirass', 'chestArmor'], ['steel-helm', 'head'], ['steel-boots', 'feet']],
  );
  typicalFighter.character = { race: 'Redguard', gender: 'Male', className: 'Warrior', faceIndex: 1, level: 5 };
  const fighterBytes = Buffer.byteLength(JSON.stringify(projectPeerFigure({ rpg: typicalFighter }, { orderTag: 'IRON' })), 'utf8');
  assert.ok(fighterBytes < 1024, `expected typical 4-slot fighter peer figure < 1024 bytes, got ${fighterBytes} bytes`);

  // Full 6-slot starter loadout: deterministic across inventory & equipment ordering
  const rpgA = { inventory: [], equipment: {}, gold: 100 };
  for (const [template, qty, slot] of [...STARTER_KIT, ...STARTER_CLOTHES]) {
    const it = addItem(rpgA, template, qty);
    if (slot) equip(rpgA, it.id, slot);
  }
  normalizeRpg(rpgA);
  rpgA.character = {
    race: 'Nord',
    gender: 'Female',
    className: 'Warrior',
    faceIndex: 3,
    level: 2,
  };

  // Same logical state, reversed inventory and shuffled equipment key insertion order
  const rpgB = {
    inventory: [...rpgA.inventory].reverse(),
    equipment: Object.fromEntries(Object.entries(rpgA.equipment).reverse()),
    gold: 100,
    character: { ...rpgA.character },
  };

  const projA = projectPeerFigure({ rpg: rpgA }, { orderTag: 'BAY', guildTitle: 'Apprentice' });
  const projB = projectPeerFigure({ rpg: rpgB }, { orderTag: 'BAY', guildTitle: 'Apprentice' });
  const jsonA = JSON.stringify(projA);
  const jsonB = JSON.stringify(projB);

  assert.equal(jsonA, jsonB, 'JSON serialization must be deterministic regardless of inventory/equipment order');
  assert.ok(Buffer.byteLength(jsonA, 'utf8') < 1600, 'full starter kit projection should remain compact');

  // Verify projected `doll` objects resolve directly through client/gameplay/inventory/images.js itemArt()
  for (const [slot, item] of Object.entries(projA.figure.worn)) {
    const art = itemArt(item, rpgA.character, { doll: true, slot });
    assert.ok(art && Number.isInteger(art.archive) && Number.isInteger(art.record), `itemArt should resolve projected doll for slot "${slot}"`);
  }
});
