// Classic Daggerfall monster taxonomy, stats and random-encounter tables.
//
// Adapted from Daggerfall Unity (MIT License, Copyright (C) 2009-2023 Daggerfall
// Workshop): Assets/Scripts/Utility/EnemyBasics.cs (MobileEnemy definitions,
// monster IDs 0-42, class enemies 128-145), Assets/Scripts/Utility/RandomEncounters.cs (encounter
// tables from FALL.EXE) and Assets/Scripts/Game/Items/LootTables.cs (gold
// ranges). Full licence text: ./THIRD_PARTY_NOTICES.txt.
//
// Only numbers and classic English names are recorded here. `texture` and
// `corpse` are TEXTURE.nnn archive / record indices resolved by the browser
// from the player's own ARENA2 files; no Bethesda art is distributed.
//
// Fields: id (MobileTypes), behaviour (general|flying|spectral|aquatic),
// affinity, texture (MaleTexture archive), corpse ([archive, record]),
// hasIdle (idle records 15-19 exist), minMetal (WeaponMaterialTypes needed to
// damage: -1 none, 0 iron ... 9 daedric), attacks ([[min,max], ...], up to
// three claw/bite rolls per attack), health ([min,max]), level, armor
// (ArmorValue; to-hit armour is armor*5), loot (LootTableKey),
// attackFrames / hitFrame (PrimaryAttackAnimFrames length and the -1 marker).

export const MONSTERS = Object.freeze([
  {id: 0, name: "Rat", behaviour: "general", affinity: "animal", texture: 255, corpse: [401,1], hasIdle: true, minMetal: -1, attacks: [[1,4]], health: [9,16], level: 1, armor: 6, loot: "-", attackFrames: 6, hitFrame: 3},
  {id: 1, name: "Imp", behaviour: "flying", affinity: "darkness", texture: 256, corpse: [406,5], hasIdle: false, minMetal: 1, attacks: [[2,15]], health: [11,18], level: 2, armor: 3, loot: "D", attackFrames: 5, hitFrame: 3},
  {id: 2, name: "Spriggan", behaviour: "general", affinity: "daylight", texture: 257, corpse: [406,3], hasIdle: true, minMetal: -1, attacks: [[1,8],[1,8],[1,10]], health: [12,26], level: 3, armor: -4, loot: "B", attackFrames: 6, hitFrame: 2},
  {id: 3, name: "Giant Bat", behaviour: "flying", affinity: "animal", texture: 258, corpse: [401,0], hasIdle: false, minMetal: -1, attacks: [[2,12]], health: [12,26], level: 3, armor: 6, loot: "-", attackFrames: 4, hitFrame: 2},
  {id: 4, name: "Grizzly Bear", behaviour: "general", affinity: "animal", texture: 259, corpse: [401,2], hasIdle: true, minMetal: -1, attacks: [[1,8],[1,8],[1,10]], health: [13,34], level: 4, armor: 6, loot: "-", attackFrames: 5, hitFrame: 3},
  {id: 5, name: "Sabertooth Tiger", behaviour: "general", affinity: "animal", texture: 260, corpse: [401,3], hasIdle: true, minMetal: -1, attacks: [[1,10],[1,10],[3,15]], health: [13,34], level: 4, armor: 6, loot: "-", attackFrames: 6, hitFrame: 3},
  {id: 6, name: "Spider", behaviour: "general", affinity: "animal", texture: 261, corpse: [401,4], hasIdle: true, minMetal: -1, attacks: [[5,15]], health: [13,34], level: 4, armor: 5, loot: "-", attackFrames: 6, hitFrame: 2},
  {id: 7, name: "Orc", behaviour: "general", affinity: "darkness", texture: 262, corpse: [96,2], hasIdle: true, minMetal: -1, attacks: [[1,6]], health: [13,34], level: 5, armor: 7, loot: "A", attackFrames: 7, hitFrame: 3},
  {id: 8, name: "Centaur", behaviour: "general", affinity: "daylight", texture: 263, corpse: [406,0], hasIdle: true, minMetal: -1, attacks: [[5,15]], health: [14,46], level: 5, armor: 6, loot: "C", attackFrames: 8, hitFrame: 5},
  {id: 9, name: "Werewolf", behaviour: "general", affinity: "darkness", texture: 264, corpse: [96,5], hasIdle: false, minMetal: 2, attacks: [[1,10],[1,10],[2,12]], health: [17,66], level: 6, armor: 5, loot: "-", attackFrames: 4, hitFrame: 2},
  {id: 10, name: "Nymph", behaviour: "general", affinity: "daylight", texture: 265, corpse: [406,2], hasIdle: true, minMetal: 2, attacks: [[1,5]], health: [15,50], level: 6, armor: 0, loot: "C", attackFrames: 6, hitFrame: 5},
  {id: 11, name: "Slaughterfish", behaviour: "aquatic", affinity: "water", texture: 266, corpse: [305,1], hasIdle: false, minMetal: -1, attacks: [[2,12]], health: [15,50], level: 7, armor: 6, loot: "-", attackFrames: 7, hitFrame: 1},
  {id: 12, name: "Orc Sergeant", behaviour: "general", affinity: "darkness", texture: 267, corpse: [96,2], hasIdle: true, minMetal: -1, attacks: [[5,15]], health: [15,50], level: 7, armor: 5, loot: "A", attackFrames: 7, hitFrame: 1},
  {id: 13, name: "Harpy", behaviour: "flying", affinity: "daylight", texture: 268, corpse: [406,4], hasIdle: false, minMetal: 4, attacks: [[5,15]], health: [16,85], level: 8, armor: 2, loot: "D", attackFrames: 4, hitFrame: 3},
  {id: 14, name: "Wereboar", behaviour: "general", affinity: "darkness", texture: 269, corpse: [96,5], hasIdle: false, minMetal: 2, attacks: [[2,12],[2,12],[5,15]], health: [17,66], level: 8, armor: 3, loot: "-", attackFrames: 4, hitFrame: 1},
  {id: 15, name: "Skeletal Warrior", behaviour: "general", affinity: "undead", texture: 270, corpse: [306,1], hasIdle: true, minMetal: -1, attacks: [[5,15]], health: [17,66], level: 9, armor: 2, loot: "H", attackFrames: 6, hitFrame: 4},
  {id: 16, name: "Giant", behaviour: "general", affinity: "daylight", texture: 271, corpse: [406,1], hasIdle: true, minMetal: -1, attacks: [[10,30]], health: [18,74], level: 10, armor: 3, loot: "F", attackFrames: 6, hitFrame: 2},
  {id: 17, name: "Zombie", behaviour: "general", affinity: "undead", texture: 272, corpse: [306,4], hasIdle: true, minMetal: -1, attacks: [[15,50]], health: [52,66], level: 10, armor: 0, loot: "G", attackFrames: 5, hitFrame: 3},
  {id: 18, name: "Ghost", behaviour: "spectral", affinity: "undead", texture: 273, corpse: [306,0], hasIdle: false, minMetal: 2, attacks: [[10,35]], health: [17,66], level: 11, armor: 0, loot: "I", attackFrames: 4, hitFrame: 2},
  {id: 19, name: "Mummy", behaviour: "general", affinity: "undead", texture: 274, corpse: [306,5], hasIdle: true, minMetal: 2, attacks: [[5,15]], health: [17,66], level: 11, armor: 2, loot: "E", attackFrames: 5, hitFrame: 3},
  {id: 20, name: "Giant Scorpion", behaviour: "general", affinity: "animal", texture: 275, corpse: [401,5], hasIdle: false, minMetal: -1, attacks: [[15,25]], health: [18,74], level: 12, armor: 0, loot: "-", attackFrames: 6, hitFrame: 2},
  {id: 21, name: "Orc Shaman", behaviour: "general", affinity: "darkness", texture: 276, corpse: [96,2], hasIdle: true, minMetal: -1, attacks: [[2,20]], health: [18,74], level: 13, armor: 7, loot: "U", attackFrames: 6, hitFrame: 2},
  {id: 22, name: "Gargoyle", behaviour: "general", affinity: "darkness", texture: 277, corpse: [96,1], hasIdle: true, minMetal: 5, attacks: [[10,15]], health: [19,82], level: 14, armor: 0, loot: "-", attackFrames: 7, hitFrame: 5},
  {id: 23, name: "Wraith", behaviour: "spectral", affinity: "undead", texture: 278, corpse: [306,0], hasIdle: false, minMetal: 2, attacks: [[20,45]], health: [30,90], level: 15, armor: 0, loot: "I", attackFrames: 4, hitFrame: 3},
  {id: 24, name: "Orc Warlord", behaviour: "general", affinity: "darkness", texture: 279, corpse: [96,2], hasIdle: true, minMetal: -1, attacks: [[5,50]], health: [20,90], level: 16, armor: 0, loot: "T", attackFrames: 6, hitFrame: 2},
  {id: 25, name: "Frost Daedra", behaviour: "general", affinity: "daedra", texture: 280, corpse: [400,3], hasIdle: true, minMetal: 5, attacks: [[50,100]], health: [25,130], level: 17, armor: -5, loot: "J", attackFrames: 7, hitFrame: 2},
  {id: 26, name: "Fire Daedra", behaviour: "general", affinity: "daedra", texture: 281, corpse: [400,2], hasIdle: true, minMetal: 5, attacks: [[15,50]], health: [26,138], level: 17, armor: 1, loot: "J", attackFrames: 5, hitFrame: 2},
  {id: 27, name: "Daedroth", behaviour: "general", affinity: "daedra", texture: 282, corpse: [400,1], hasIdle: true, minMetal: 5, attacks: [[15,50]], health: [27,146], level: 18, armor: 1, loot: "E", attackFrames: 6, hitFrame: 2},
  {id: 28, name: "Vampire", behaviour: "general", affinity: "darkness", texture: 283, corpse: [96,3], hasIdle: true, minMetal: 2, attacks: [[20,50]], health: [28,154], level: 19, armor: -2, loot: "Q", attackFrames: 6, hitFrame: 4},
  {id: 29, name: "Daedra Seducer", behaviour: "general", affinity: "daedra", texture: 284, corpse: [400,6], hasIdle: true, minMetal: 5, attacks: [[15,50]], health: [27,146], level: 19, armor: 1, loot: "Q", attackFrames: 3, hitFrame: 2},
  {id: 30, name: "Vampire Ancient", behaviour: "general", affinity: "darkness", texture: 285, corpse: [96,3], hasIdle: true, minMetal: 5, attacks: [[20,60]], health: [30,170], level: 20, armor: -5, loot: "Q", attackFrames: 6, hitFrame: 4},
  {id: 31, name: "Daedra Lord", behaviour: "general", affinity: "daedra", texture: 286, corpse: [400,4], hasIdle: true, minMetal: 5, attacks: [[15,50]], health: [35,210], level: 20, armor: -10, loot: "S", attackFrames: 5, hitFrame: 2},
  {id: 32, name: "Lich", behaviour: "general", affinity: "undead", texture: 287, corpse: [306,2], hasIdle: true, minMetal: 5, attacks: [[70,100]], health: [30,170], level: 20, armor: -10, loot: "S", attackFrames: 7, hitFrame: 4},
  {id: 33, name: "Ancient Lich", behaviour: "general", affinity: "undead", texture: 288, corpse: [306,3], hasIdle: true, minMetal: 5, attacks: [[70,100]], health: [30,170], level: 21, armor: -12, loot: "S", attackFrames: 7, hitFrame: 4},
  {id: 34, name: "Dragonling", behaviour: "flying", affinity: "daylight", texture: 289, corpse: [96,0], hasIdle: false, minMetal: -1, attacks: [[5,15]], health: [14,42], level: 16, armor: 6, loot: "-", attackFrames: 4, hitFrame: 3},
  {id: 35, name: "Fire Atronach", behaviour: "general", affinity: "golem", texture: 290, corpse: [405,2], hasIdle: true, minMetal: -1, attacks: [[5,15]], health: [25,130], level: 16, armor: 6, loot: "-", attackFrames: 5, hitFrame: 1},
  {id: 36, name: "Iron Atronach", behaviour: "general", affinity: "golem", texture: 291, corpse: [405,1], hasIdle: true, minMetal: -1, attacks: [[5,15]], health: [25,130], level: 16, armor: 6, loot: "-", attackFrames: 5, hitFrame: 3},
  {id: 37, name: "Flesh Atronach", behaviour: "general", affinity: "golem", texture: 292, corpse: [405,0], hasIdle: true, minMetal: -1, attacks: [[5,15]], health: [25,130], level: 16, armor: 6, loot: "-", attackFrames: 5, hitFrame: 3},
  {id: 38, name: "Ice Atronach", behaviour: "general", affinity: "golem", texture: 293, corpse: [405,3], hasIdle: true, minMetal: -1, attacks: [[5,15]], health: [25,130], level: 16, armor: 6, loot: "-", attackFrames: 5, hitFrame: 3},
  {id: 40, name: "Dragonling", behaviour: "flying", affinity: "daylight", texture: 295, corpse: [96,0], hasIdle: false, minMetal: -1, attacks: [[5,15]], health: [14,42], level: 16, armor: 6, loot: "-", attackFrames: 4, hitFrame: 2},
  {id: 41, name: "Dreugh", behaviour: "aquatic", affinity: "water", texture: 296, corpse: [305,0], hasIdle: false, minMetal: -1, attacks: [[5,15]], health: [13,34], level: 16, armor: 6, loot: "R", attackFrames: 8, hitFrame: 4},
  {id: 42, name: "Lamia", behaviour: "aquatic", affinity: "water", texture: 297, corpse: [305,2], hasIdle: false, minMetal: -1, attacks: [[5,15]], health: [16,58], level: 16, armor: 6, loot: "R", attackFrames: 7, hitFrame: 1},
].map((m) => Object.freeze(m)));

/**
 * Human class enemies (MobileTypes 128-145) from EnemyBasics.cs. Classic levels them to the
 * player and takes attributes and hit points per level from the matching CLASSnn.CFG career
 * (careerIndex = id - 128), read from the operator's ARENA2 when available (combat/classes.js).
 * `texture` holds the male and female archives (gender is random per spawn, as in
 * DaggerfallMobileUnit.GetTextureArchive). ranged1/ranged2/castsMagic decide bow use
 * (EnemyMotor: bow when ranged1 && (!castsMagic || ranged2)).
 */
export const HUMAN_CLASSES = Object.freeze([
  {id: 128, name: "Mage", careerIndex: 0, texture: {male: 486, female: 485}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: true, loot: "U", mapChance: 3},
  {id: 129, name: "Spellsword", careerIndex: 1, texture: {male: 476, female: 475}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: true, loot: "P", mapChance: 1},
  {id: 130, name: "Battlemage", careerIndex: 2, texture: {male: 490, female: 489}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: true, castsMagic: true, loot: "U", mapChance: 2},
  {id: 131, name: "Sorcerer", careerIndex: 3, texture: {male: 478, female: 477}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: false, loot: "U", mapChance: 3},
  {id: 132, name: "Healer", careerIndex: 4, texture: {male: 486, female: 485}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: true, loot: "U", mapChance: 1},
  {id: 133, name: "Nightblade", careerIndex: 5, texture: {male: 490, female: 489}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: true, castsMagic: true, loot: "U", mapChance: 1},
  {id: 134, name: "Bard", careerIndex: 6, texture: {male: 484, female: 483}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: false, loot: "O", mapChance: 2},
  {id: 135, name: "Burglar", careerIndex: 7, texture: {male: 484, female: 483}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: false, loot: "O", mapChance: 1},
  {id: 136, name: "Rogue", careerIndex: 8, texture: {male: 480, female: 479}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: false, loot: "O", mapChance: 1},
  {id: 137, name: "Acrobat", careerIndex: 9, texture: {male: 484, female: 483}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: false, loot: "O", mapChance: 0},
  {id: 138, name: "Thief", careerIndex: 10, texture: {male: 484, female: 483}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: false, loot: "O", mapChance: 2},
  {id: 139, name: "Assassin", careerIndex: 11, texture: {male: 480, female: 479}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: false, loot: "O", mapChance: 0},
  {id: 140, name: "Monk", careerIndex: 12, texture: {male: 488, female: 487}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: false, loot: "T", mapChance: 1},
  {id: 141, name: "Archer", careerIndex: 13, texture: {male: 482, female: 481}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: false, loot: "C", mapChance: 0},
  {id: 142, name: "Ranger", careerIndex: 14, texture: {male: 482, female: 481}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: false, loot: "C", mapChance: 1},
  {id: 143, name: "Barbarian", careerIndex: 15, texture: {male: 488, female: 487}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: false, loot: "T", mapChance: 0},
  {id: 144, name: "Warrior", careerIndex: 16, texture: {male: 488, female: 487}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: false, loot: "T", mapChance: 0},
  {id: 145, name: "Knight", careerIndex: 17, texture: {male: 488, female: 487}, corpse: [380,1], hasIdle: true, ranged1: true, ranged2: false, castsMagic: false, loot: "T", mapChance: 1},
  // Knight_CityWatch: "Knight" in game (CLASS18.CFG), archive 399, levelled 3-6 above the player, no loot table.
  {id: 146, name: "City Watch", careerIndex: 18, texture: {male: 399, female: 399}, corpse: [380,1], hasIdle: true, ranged1: false, ranged2: false, castsMagic: false, loot: "-", mapChance: 0, guard: true},
].map((h) => Object.freeze({ ...h, human: true, behaviour: "general", affinity: "human", minMetal: -1 })));

/**
 * MobileTypes values that exist in the enum but are not spawnable creatures. They are recorded (not silently
 * dropped or replaced) so callers can report why a source record names them.
 */
export const RESERVED_IDS = Object.freeze({
  39: Object.freeze({ name: "Horse", reason: "Horse_Invalid: no TEXTURE.294 in the classic data; classic crashes when it is spawned" }),
  99: Object.freeze({ name: "(invalid)", reason: "known invalid fixed-enemy marker value; classic and RDBLayout skip it" }),
});

/**
 * Per-type data from EnemyBasics.cs not covered above: `seq` is PrimaryAttackAnimFrames (every -1 is one melee
 * damage roll), `soul` SoulPts, `weight`, `seesInvisible`, `noShadow`, `glow` ([r,g,b,scale]), `blood` BloodIndex,
 * `doors` CanOpenDoors, `seducer` HasSeducerTransform1/2, `prefersRanged`, `map` MapChance.
 */
export const ENEMY_EXTRAS = Object.freeze({
  0: {seq: [0,1,2,-1,3,4,5],weight: 2},
  1: {seq: [0,1,2,-1,3,1],soul: 1000,weight: 40,seesInvisible: 1,doors: 1,map: 1},
  2: {seq: [0,1,-1,2,3,3,3],soul: 1000,weight: 240,doors: 1},
  3: {seq: [0,1,-1,2,3],weight: 80},
  4: {seq: [0,1,2,-1,3,0],weight: 1000},
  5: {seq: [0,1,2,-1,3,4,5],weight: 1000},
  6: {seq: [0,1,-1,2,3,4,5],weight: 400},
  7: {seq: [0,1,2,-1,3,4,-1,5,0],soul: 1000,weight: 600,doors: 1},
  8: {seq: [0,1,1,1,2,-1,3,3,4],soul: 3000,weight: 1200,doors: 1,map: 1},
  9: {seq: [0,1,-1,2,-1,2],soul: 1000,weight: 480,doors: 1},
  10: {seq: [0,1,2,3,4,-1,5],soul: 10000,weight: 200,doors: 1,map: 1},
  11: {seq: [0,-1,1,2,3,4,-1,5,0],weight: 400},
  12: {seq: [0,-1,1,2,3,4,-1,5,0],soul: 1000,weight: 600,doors: 1,map: 1},
  13: {seq: [0,1,2,-1,3],soul: 3000,weight: 200,doors: 1},
  14: {seq: [0,-1,1,2,2],soul: 1000,weight: 560,doors: 1},
  15: {seq: [0,1,2,3,-1,4,5],weight: 80,seesInvisible: 1,blood: 2,doors: 1,map: 1},
  16: {seq: [0,1,-1,2,3,4,-1,5],soul: 3000,weight: 3000,doors: 1,map: 1},
  17: {seq: [0,1,2,-1,3,4],weight: 4000,doors: 1,map: 1},
  18: {seq: [0,1,-1,2,3],soul: 30000,weight: 0,seesInvisible: 1,noShadow: 1,blood: 2,doors: 1,map: 1},
  19: {seq: [0,1,2,-1,3,4],soul: 10000,weight: 300,seesInvisible: 1,blood: 2,doors: 1,map: 1},
  20: {seq: [0,1,-1,3,2,1,0],weight: 600},
  21: {seq: [0,1,-1,3,2,1,0],soul: 3000,weight: 400,doors: 1,map: 3},
  22: {seq: [0,2,1,2,3,-1,4,0],soul: 3000,weight: 300,doors: 1},
  23: {seq: [0,1,2,-1,3],soul: 30000,weight: 0,seesInvisible: 1,noShadow: 1,blood: 2,doors: 1,map: 1},
  24: {seq: [0,1,-1,2,3,4,-1,5],soul: 1000,weight: 700,doors: 1,map: 2},
  25: {seq: [0,1,-1,2,3,-1,4,5,0],soul: 50000,weight: 800,seesInvisible: 1,noShadow: 1,doors: 1,glow: [18,68,88,0.1]},
  26: {seq: [0,1,-1,2,3,-1,4],soul: 50000,weight: 800,seesInvisible: 1,noShadow: 1,doors: 1,glow: [243,239,44,0.05]},
  27: {seq: [0,1,-1,2,3,4,-1,5],soul: 10000,weight: 400,seesInvisible: 1,doors: 1},
  28: {seq: [0,1,2,3,-1,4,5],soul: 70000,weight: 400,seesInvisible: 1,noShadow: 1,doors: 1,map: 3},
  29: {seq: [0,1,-1,2],soul: 150000,weight: 200,seesInvisible: 1,doors: 1,seducer: 1,map: 1},
  30: {seq: [0,1,2,3,-1,4,5],soul: 100000,weight: 400,seesInvisible: 1,noShadow: 1,doors: 1,map: 3},
  31: {seq: [0,1,-1,2,3,-1,4],soul: 800000,weight: 1000,seesInvisible: 1,doors: 1},
  32: {seq: [0,1,1,2,-1,3,4,4],soul: 100000,weight: 300,seesInvisible: 1,blood: 2,doors: 1,map: 4},
  33: {seq: [0,1,1,2,-1,3,4,4],soul: 250000,weight: 300,blood: 2,doors: 1,map: 4},
  34: {seq: [0,1,2,-1,3],weight: 10000},
  35: {seq: [0,-1,1,2,3,4],soul: 30000,weight: 1000,noShadow: 1,doors: 1,glow: [243,150,44,0.05]},
  36: {seq: [0,1,2,-1,3,4],soul: 30000,weight: 1000,doors: 1},
  37: {seq: [0,1,2,-1,3,4],soul: 30000,weight: 1000,doors: 1},
  38: {seq: [0,1,2,-1,3,4],soul: 30000,weight: 1000,doors: 1},
  40: {seq: [0,1,-1,2,3],soul: 500000,weight: 10000},
  41: {seq: [0,1,2,3,-1,4,5,-1,6,7],soul: 10000,weight: 600,doors: 1},
  42: {seq: [0,-1,1,2,3,4,-1,5,0],soul: 10000,weight: 200,doors: 1},
  128: {seq: [0,1,-1,3,2,1,0,-1,5,4,0],doors: 1,map: 3},
  129: {seq: [0,1,-1,2,3,4,5],doors: 1,map: 1},
  130: {seq: [0,1,-1,2,3,4,-1,5,0],doors: 1,map: 2},
  131: {seq: [0,1,2,-1,3,4,5],doors: 1,map: 3},
  132: {seq: [0,1,-1,3,2,1,0,-1,5,4,0],doors: 1,map: 1},
  133: {seq: [0,1,-1,2,3,4,-1,5,0],doors: 1,map: 1},
  134: {seq: [0,1,-1,2,3,4,-1,5,0],doors: 1,map: 2},
  135: {seq: [0,1,-1,2,3,4,-1,5,0],doors: 1,map: 1},
  136: {seq: [0,1,-1,2,3,4,-1,5,0],doors: 1,map: 1},
  137: {seq: [0,1,-1,2,3,4,-1,5,0],doors: 1},
  138: {seq: [0,1,-1,2,3,4,-1,5,0],doors: 1,map: 2},
  139: {seq: [0,1,-1,2,3,4,-1,5,0],doors: 1},
  140: {seq: [0,0,1,-1,2,2,1,0],doors: 1,map: 1},
  141: {seq: [0,1,-1,2,3,4,-1,5],doors: 1,prefersRanged: 1},
  142: {seq: [0,1,-1,2,3,4,-1,5],doors: 1,map: 1},
  143: {seq: [0,0,1,-1,2,2,1,0],doors: 1},
  144: {seq: [0,0,1,-1,2,2,1,0],doors: 1},
  145: {seq: [0,0,1,-1,2,2,1,0],doors: 1,map: 1},
  146: {seq: [0,1,-1,2,3,4],doors: 1},
});

/**
 * Classic monster spell lists, standard-spell indices into SPELLS.STD (EnemyEntity.cs, from FALL.EXE 0x1C0F14).
 * Class enemies that cast magic take EnemyClassSpells[min(6, floor(level / 3))].
 */
export const MONSTER_SPELLS = Object.freeze({
  1: [0x07, 0x0A, 0x1D, 0x2C], 18: [0x22], 21: [0x06, 0x07, 0x16, 0x19, 0x1F], 23: [0x1C, 0x1F], 25: [0x10, 0x14],
  26: [0x0E, 0x19], 27: [0x16, 0x17, 0x1F], 28: [0x33], 29: [0x34, 0x43], 30: [0x08, 0x32], 31: [0x08, 0x0A, 0x0E, 0x3C, 0x43],
  32: [0x08, 0x0A, 0x0E, 0x22, 0x3C], 33: [0x08, 0x0A, 0x0E, 0x1D, 0x1F, 0x22, 0x3C],
});
export const CLASS_SPELL_LISTS = Object.freeze([25, 27, 21, 30, 31, 32, 33].map((id) => MONSTER_SPELLS[id]));

/** Spell list of an enemy type at a level, or []. */
export function enemySpells(e, level = 1) {
  if (!e) return [];
  if (e.human) return e.castsMagic ? CLASS_SPELL_LISTS[Math.min(6, Math.floor(Math.max(1, level) / 3))] : [];
  return MONSTER_SPELLS[e.id] ?? [];
}

/** Melee hit markers: frame positions (index into the played sequence) where a damage roll happens. */
export function hitMarkers(e) {
  const seq = ENEMY_EXTRAS[e?.id]?.seq ?? [];
  const out = [];
  let shown = 0;
  for (const f of seq) {
    if (f === -1) out.push(shown);
    else shown++;
  }
  return out;
}
export const isAquatic = (e) => !!e && e.behaviour === "aquatic";

/**
 * Random-encounter tables from FALL.EXE (20 entries, low to high level), keyed by the classic
 * table index (RandomEncounters.EncounterTables). Comments give the classic table name.
 */
export const ENCOUNTER_TABLES = Object.freeze({
  // Crypt
  0: [0, 15, 3, 0, 15, 3, 19, 15, 6, 17, 18, 17, 17, 18, 18, 23, 23, 28, 30, 32],
  // Orc Stronghold
  1: [0, 3, 7, 12, 4, 7, 15, 7, 12, 5, 16, 21, 6, 21, 24, 20, 27, 20, 21, 24],
  // Human Stronghold
  2: [144, 136, 0, 4, 141, 133, 3, 129, 8, 145, 144, 136, 143, 24, 141, 23, 129, 21, 144, 28],
  // Prison
  3: [3, 0, 134, 15, 135, 6, 133, 6, 143, 138, 37, 138, 139, 17, 133, 36, 23, 18, 17, 135],
  // Desecrated Temple
  4: [3, 1, 132, 140, 131, 15, 13, 140, 19, 140, 21, 22, 23, 27, 29, 140, 25, 26, 34, 31],
  // Mine
  5: [0, 3, 4, 6, 15, 6, 133, 7, 12, 16, 138, 16, 144, 38, 36, 26, 138, 28, 133, 30],
  // Natural Cave
  6: [0, 3, 4, 5, 4, 6, 7, 9, 143, 13, 14, 16, 20, 21, 18, 144, 140, 143, 34, 32],
  // Coven
  7: [1, 3, 128, 131, 13, 133, 10, 37, 35, 36, 10, 27, 131, 129, 29, 26, 130, 128, 25, 31],
  // Vampire Haunt
  8: [0, 0, 3, 6, 9, 133, 15, 15, 18, 19, 23, 18, 28, 23, 28, 28, 30, 28, 30, 30],
  // Laboratory
  9: [1, 128, 131, 130, 17, 128, 131, 37, 130, 38, 35, 36, 22, 27, 131, 32, 128, 131, 32, 33],
  // Harpy Nest
  10: [0, 144, 3, 13, 3, 13, 15, 6, 135, 13, 20, 21, 133, 13, 136, 28, 29, 13, 29, 31],
  // Ruined Castle
  11: [0, 3, 144, 7, 15, 6, 12, 9, 145, 14, 17, 16, 145, 18, 23, 144, 145, 32, 33, 30],
  // Spider Nest
  12: [0, 3, 3, 6, 15, 2, 142, 6, 20, 136, 13, 6, 138, 18, 19, 6, 23, 6, 139, 32],
  // Giant Stronghold
  13: [0, 4, 5, 7, 16, 12, 20, 16, 14, 16, 24, 20, 21, 16, 27, 26, 34, 16, 24, 25],
  // Dragon's Den
  14: [0, 3, 8, 135, 20, 9, 145, 13, 6, 22, 131, 10, 133, 128, 145, 28, 130, 138, 33, 31],
  // Barbarian Stronghold
  15: [144, 143, 0, 3, 144, 8, 136, 141, 9, 143, 141, 14, 6, 144, 28, 136, 143, 30, 131, 33],
  // Volcanic Caves
  16: [3, 1, 5, 5, 143, 35, 13, 14, 16, 18, 20, 36, 35, 128, 36, 23, 27, 26, 31, 33],
  // Scorpion Nest
  17: [0, 3, 6, 15, 20, 138, 20, 17, 1, 18, 20, 22, 23, 132, 20, 133, 29, 20, 27, 31],
  // Cemetery
  18: [0, 0, 3, 0, 138, 3, 15, 3, 7, 141, 7, 1, 7, 1, 17, 19, 134, 136, 0, 0],
  // Underwater
  19: [11, 11, 15, 11, 11, 41, 41, 11, 17, 41, 11, 38, 11, 41, 42, 41, 42, 17, 23, 18],
  // Desert, in location, night
  20: [0, 3, 138, 139, 9, 136, 14, 144, 138, 137, 136, 135, 130, 128, 144, 138, 7, 28, 20, 139],
  // Desert, not in location, day
  21: [0, 5, 5, 8, 10, 34, 13, 16, 136, 20, 21, 139, 138, 144, 24, 129, 134, 136, 139, 145],
  // Desert, not in location, night
  22: [3, 3, 5, 6, 7, 133, 139, 9, 13, 14, 19, 20, 35, 24, 36, 144, 133, 28, 145, 34],
  // Mountain, in location, night
  23: [0, 3, 136, 7, 139, 129, 9, 145, 14, 144, 128, 131, 135, 138, 140, 141, 144, 143, 136, 139],
  // Mountain, not in location, day
  24: [4, 2, 136, 7, 10, 13, 12, 16, 145, 21, 140, 141, 143, 24, 36, 136, 142, 28, 145, 139],
  // Mountain, not in location, night
  25: [3, 4, 2, 8, 139, 142, 9, 34, 12, 16, 18, 21, 131, 22, 130, 23, 129, 28, 142, 145],
  // Rainforest, in location, night
  26: [0, 138, 0, 3, 133, 3, 13, 14, 134, 143, 136, 138, 144, 141, 139, 130, 133, 28, 144, 145],
  // Rainforest, not in location, day
  27: [0, 4, 5, 6, 138, 13, 136, 16, 142, 20, 144, 145, 138, 143, 142, 141, 137, 134, 128, 129],
  // Rainforest, not in location, night
  28: [3, 3, 5, 6, 129, 136, 9, 13, 14, 16, 18, 20, 9, 5, 23, 139, 27, 133, 144, 130],
  // Subtropical, in location, night
  29: [0, 135, 138, 140, 131, 134, 136, 144, 133, 138, 137, 142, 141, 28, 143, 144, 128, 129, 139, 145],
  // Subtropical, not in location, day
  30: [0, 1, 4, 5, 8, 10, 34, 16, 138, 20, 144, 131, 133, 136, 145, 130, 140, 138, 143, 133],
  // Subtropical, not in location, night
  31: [3, 4, 5, 6, 17, 9, 14, 13, 18, 20, 144, 133, 4, 143, 139, 130, 134, 133, 32, 139],
  // Swamp/woodlands, in location, night
  32: [0, 3, 135, 134, 136, 141, 9, 137, 14, 144, 130, 135, 140, 136, 133, 139, 138, 28, 145, 130],
  // Swamp/woodlands, not in location, day
  33: [0, 4, 2, 7, 8, 34, 12, 14, 16, 141, 21, 134, 143, 24, 130, 139, 142, 136, 145, 129],
  // Swamp/woodlands, not in location, night
  34: [3, 4, 6, 17, 133, 145, 9, 34, 14, 16, 142, 22, 129, 140, 134, 136, 142, 133, 145, 131],
  // Haunted woodlands, in location, night
  35: [3, 133, 135, 17, 136, 140, 14, 143, 18, 131, 144, 139, 23, 145, 130, 138, 136, 28, 143, 30],
  // Haunted woodlands, not in location, day
  36: [1, 4, 2, 6, 8, 10, 34, 13, 16, 131, 21, 22, 145, 24, 36, 130, 139, 141, 142, 145],
  // Haunted woodlands, not in location, night
  37: [3, 4, 6, 17, 15, 9, 34, 14, 16, 37, 18, 35, 6, 23, 25, 36, 27, 28, 30, 32],
  // Unused
  38: [0, 0, 138, 0, 0, 3, 3, 17, 18, 0, 139, 3, 136, 0, 3, 0, 3, 0, 0, 28],
  // Default building
  39: [138, 144, 135, 144, 135, 134, 144, 137, 135, 136, 138, 144, 135, 133, 136, 144, 135, 138, 144, 136],
  // Guildhall
  40: [128, 1, 130, 132, 133, 129, 128, 131, 130, 132, 35, 129, 128, 131, 130, 133, 129, 128, 29, 130],
  // Temple
  41: [140, 140, 145, 140, 140, 140, 140, 145, 140, 140, 140, 140, 140, 145, 140, 140, 140, 140, 140, 145],
  // Palace, House1
  42: [144, 141, 134, 129, 145, 144, 145, 144, 141, 134, 129, 145, 144, 145, 144, 141, 129, 145, 144, 145],
  // House2
  43: [134, 144, 136, 138, 144, 129, 135, 136, 140, 128, 133, 137, 144, 134, 132, 131, 138, 28, 136, 144],
  // House3
  44: [0, 0, 135, 138, 134, 140, 134, 132, 136, 140, 135, 138, 134, 136, 142, 135, 138, 134, 140, 136],
});


export const MONSTER_BY_ID = new Map(MONSTERS.map((m) => [m.id, m]));
export const HUMAN_BY_ID = new Map(HUMAN_CLASSES.map((h) => [h.id, h]));
/** Every enemy combat can spawn: monsters 0-38 and 40-42, classes 128-145 and the City Watch (146). */
export const ENEMY_BY_ID = new Map([...MONSTER_BY_ID, ...HUMAN_BY_ID]);
export const isKnownEnemy = (id) => ENEMY_BY_ID.has(id);
/** Classic bow use (EnemyMotor.hasBowAttack). */
export const hasBowAttack = (e) => !!e.human && e.ranged1 && (!e.castsMagic || e.ranged2);

/** Classic dungeon type names (DFRegion.DungeonTypes) → encounter table index. */
export const DUNGEON_TABLE = Object.freeze({
  crypt: 0, orcStronghold: 1, humanStronghold: 2, prison: 3, desecratedTemple: 4, mine: 5, naturalCave: 6, coven: 7,
  vampireHaunt: 8, laboratory: 9, harpyNest: 10, ruinedCastle: 11, spiderNest: 12, giantStronghold: 13, dragonsDen: 14,
  barbarianStronghold: 15, volcanicCaves: 16, scorpionNest: 17, cemetery: 18,
});

/**
 * Pick an enemy ID from an encounter table using the classic level window
 * (RandomEncounters.ChooseRandomEnemy).
 */
export function chooseEncounter(tableIndex, playerLevel, random = Math.random) {
  const table = ENCOUNTER_TABLES[tableIndex];
  if (!table) return null;
  const level = Math.max(1, Math.floor(playerLevel) || 1);
  const roll = 1 + Math.floor(random() * 100);
  let min;
  let max;
  if (roll > 80) {
    if (roll > 95) [min, max] = level <= 5 ? [0, level + 2] : [0, 19];
    else [min, max] = [0, level + 1];
  } else [min, max] = [level - 3, level + 3];
  if (min < 0) [min, max] = [0, 5];
  if (max > 19) [min, max] = [14, 19];
  if (max + 1 > table.length) {
    max = table.length - 1;
    min = max >= 5 ? max - 5 : Math.floor(random() * max);
  }
  return table[min + Math.floor(random() * (max - min + 1))];
}

/**
 * LootChanceMatrix subset: [minGold, maxGold, armour %, weapon %]. Gold found
 * is roll(min,max) * looter level (LootTables.GenerateRandomLoot).
 */
export const LOOT_TABLES = Object.freeze({
  '-': [0, 0, 0, 0], A: [1, 10, 5, 5], B: [0, 0, 0, 0], C: [2, 20, 5, 25], D: [1, 4, 0, 0], E: [20, 80, 10, 10],
  F: [4, 30, 50, 50], G: [3, 15, 50, 50], H: [2, 10, 0, 100], I: [0, 0, 0, 0], J: [50, 150, 5, 5], K: [1, 10, 5, 5],
  L: [1, 20, 50, 50], M: [1, 15, 10, 10], N: [1, 80, 5, 5], O: [5, 20, 10, 15], P: [5, 20, 5, 10], Q: [20, 80, 10, 25],
  R: [5, 20, 5, 15], S: [50, 125, 10, 10], T: [20, 80, 100, 100], U: [7, 30, 10, 10],
});

/** Monster skills are (level*5)+30, capped at 100 (EnemyEntity.SetEnemyCareer). */
export const monsterSkill = (m) => Math.min(100, m.level * 5 + 30);

/** Classic FormulaHelper enemy groups for career bonuses/phobias. */
export function enemyGroup(m) {
  if (m.human) return 'Humanoid';
  if (m.affinity === 'daedra') return 'Daedra';
  if (m.affinity === 'golem') return null;
  if (m.affinity === 'animal' || [11, 17, 34].includes(m.id)) return 'Animals';
  if (m.affinity === 'undead' || [28, 30, 40, 41, 42].includes(m.id)) return 'Undead';
  return 'Humanoid';
}

// ------------------------------------------------------------------ classic dungeon enemy slots

/** DFRandom (classic rand(): 32-bit LCG, 15-bit output). */
export function dfRandom(seed) {
  let next = seed >>> 0;
  const rand = () => {
    next = (Math.imul(next, 1103515245) + 12345) >>> 0;
    return (next >>> 16) & 0x7fff;
  };
  return { rand, rangeInclusive: (min, max) => (rand() % (max - min + 1)) + min };
}

/** RDBLayout.ChooseRandomEnemyType: the classic level window, drawn with DFRandom. */
export function chooseRandomEnemyTypeClassic(table, playerLevel, rng) {
  const level = Math.max(1, Math.trunc(playerLevel) || 1);
  let min = 0;
  let max = table.length;
  const roll = rng.rangeInclusive(1, 100);
  if (roll > 95 && level <= 5) max = level + 2;
  else if (roll > 80) max = level + 1;
  else {
    min = level - 3;
    max = level + 3;
  }
  if (min < 0) {
    min = 0;
    max = 5;
  } else if (max > 19) {
    min = 14;
    max = 19;
  }
  return table[rng.rangeInclusive(min, max)];
}

export const UNDERWATER_TABLE = 19;

/**
 * RDBLayout classic selection: srand(dungeon LocationId), then 256 land enemies from the dungeon type's table and 256
 * water enemies from table 19, all with the player's level. A random marker takes slot `Flags` (1-6 when 0).
 */
export function classicDungeonSlots(dungeonType, locationId, playerLevel) {
  const land = ENCOUNTER_TABLES[dungeonType];
  if (!land) return null;
  const rng = dfRandom(locationId);
  const nonWater = Array.from({ length: 256 }, () => chooseRandomEnemyTypeClassic(land, playerLevel, rng));
  const water = Array.from({ length: 256 }, () => chooseRandomEnemyTypeClassic(ENCOUNTER_TABLES[UNDERWATER_TABLE], playerLevel, rng));
  return { nonWater, water };
}

// ------------------------------------------------------------------ region / climate encounters

/** MapsFile.Climates values (CLIMATE.PAK). */
export const CLIMATES = Object.freeze({
  ocean: 223, desert: 224, desert2: 225, mountain: 226, rainforest: 227, swamp: 228, subtropical: 229,
  mountainWoods: 230, woodlands: 231, hauntedWoodlands: 232,
});
const CLIMATE_TABLE_BASE = new Map([
  [224, 20], [225, 20], [226, 23], [227, 26], [229, 29], [228, 32], [230, 32], [231, 32], [232, 35],
]);

/**
 * RandomEncounters.ChooseRandomEnemy table for an outdoor scene: `inLocation` (inside a town's rectangle) only at night;
 * otherwise day (+1) or night (+2). Returns null when classic spawns nothing (ocean, unknown climate, town by day).
 */
export function climateEncounterTable(climate, { inLocation = false, night = false } = {}) {
  const base = CLIMATE_TABLE_BASE.get(climate);
  if (base === undefined) return null;
  if (inLocation) return night ? base : null;
  return base + (night ? 2 : 1);
}

/** Building-interior tables (ChooseRandomEnemy inside buildings), by DFLocation.BuildingTypes. */
export function buildingEncounterTable(buildingType) {
  if (buildingType === 11) return 40; // GuildHall
  if (buildingType === 14) return 41; // Temple
  if (buildingType === 16 || buildingType === 17) return 42; // Palace, House1
  if (buildingType === 18) return 43;
  if (buildingType === 19) return 44;
  return 39;
}

/**
 * PlayerEntity.IntermittentEnemySpawn for one game minute. Returns true when classic would start a spawn check
 * that succeeds (FormulaHelper.RollRandomSpawn_*). `where`: 'location' | 'wilderness' | 'dungeonRest'.
 */
export function intermittentSpawn(minute, where, random = Math.random) {
  if (Math.floor(minute / 12) % 12 !== 0) return false;
  const tod = ((minute % 1440) + 1440) % 1440;
  const night = tod < 360 || tod > 1080;
  if (where === 'location') return night && Math.floor(random() * 24) === 0;
  if (where === 'wilderness') return Math.floor(random() * (tod >= 360 && tod <= 1080 ? 36 : 24)) === 0;
  if (where === 'dungeonRest') return Math.floor(random() * 36) === 0; // only while an enemy alert is active
  return false;
}
