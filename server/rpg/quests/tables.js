// Small symbol tables used by quest scripts and the classic QBN decoder.
// Names and codes adapted from Daggerfall Unity StreamingAssets/Tables/Quests-*.txt
// ("adapted from Template 1.11 by Donald Tipton"), MIT — see NOTICE.txt.

import { CAMPAIGN_SITES } from '../campaign/sites.js';

/** Fixed message names usable in place of ids (Quests-StaticMessages). */
export const STATIC_MESSAGES = Object.freeze({
  message: 0,
  questoroffer: 1000,
  refusequest: 1001,
  acceptquest: 1002,
  questfail: 1003,
  questcomplete: 1004,
  rumorsduringquest: 1005,
  rumorspostfailure: 1006,
  rumorspostsuccess: 1007,
  questorpostsuccess: 1008,
  questorpostfailure: 1009,
  questlogentry: 1010,
  questtimelapse: 1045,
});
export const MSG = Object.freeze({ OFFER: 1000, REFUSE: 1001, ACCEPT: 1002, FAIL: 1003, COMPLETE: 1004 });

/** Foe classes: script name -> mobile id (Quests-Foes). */
const FOE_ROWS = [
  [0, 'Giant_rat'], [1, 'Imp'], [2, 'Spriggan'], [3, 'Giant_bat'], [4, 'Grizzley_bear'], [5, 'Sabretooth_tiger'],
  [6, 'Spider'], [7, 'Orc'], [8, 'Centaur'], [9, 'Werewolf'], [10, 'Nymph'], [11, 'Slaughterfish'], [12, 'Orc_sergeant'],
  [13, 'Harpy'], [14, 'Wereboar'], [15, 'Skeletal_warrior'], [16, 'Giant'], [17, 'Zombie'], [18, 'Ghost'], [19, 'Mummy'],
  [20, 'Giant_scorpion'], [21, 'Orc_shaman'], [22, 'Gargoyle'], [23, 'Wraith'], [24, 'Orc_warlord'], [25, 'Frost_daedra'],
  [26, 'Fire_daedra'], [27, 'Daedroth'], [28, 'Vampire'], [29, 'Daedra_seducer'], [30, 'Ancient_vampire'],
  [31, 'Daedra_lord'], [32, 'Lich'], [33, 'Ancient_lich'], [34, 'Dragonling_souless'], [35, 'Fire_atronach'],
  [36, 'Iron_atronach'], [37, 'Flesh_atronach'], [38, 'Ice_atronach'], [39, 'Horse'], [40, 'Dragonling'], [41, 'Dreugh'],
  [42, 'Lamia'], [128, 'Mage'], [129, 'Spellsword'], [130, 'Battle_mage'], [131, 'Sorcerer'], [131, 'Sorceror'],
  [132, 'Healer'], [133, 'Nightblade'], [134, 'Bard'], [135, 'Burglar'], [136, 'Rogue'], [137, 'Acrobat'], [138, 'Thief'],
  [139, 'Assassin'], [140, 'Monk'], [141, 'Archer'], [142, 'Ranger'], [143, 'Barbarian'], [144, 'Warrior'], [145, 'Knight'],
];
export const FOE_BY_NAME = new Map(FOE_ROWS.map(([id, n]) => [n.toLowerCase(), id]));
export const FOE_NAME_BY_ID = new Map();
for (const [id, n] of FOE_ROWS) if (!FOE_NAME_BY_ID.has(id)) FOE_NAME_BY_ID.set(id, n);

/**
 * Mobile appearance and health (Daggerfall Unity EnemyBasics): id -> [displayName, maleTexture, femaleTexture, minHp, maxHp, level].
 * Humanoid classes have no fixed health; quest code scales them by level like the combat feature does.
 */
export const MOBILES = Object.freeze({
  0: ['Rat', 255, 255, 9, 16, 1], 1: ['Imp', 256, 256, 11, 18, 2], 2: ['Spriggan', 257, 257, 12, 26, 3],
  3: ['Giant Bat', 258, 258, 12, 26, 3], 4: ['Grizzly Bear', 259, 259, 13, 34, 4], 5: ['Sabertooth Tiger', 260, 260, 13, 34, 4],
  6: ['Spider', 261, 261, 13, 34, 4], 7: ['Orc', 262, 262, 13, 34, 5], 8: ['Centaur', 263, 263, 14, 46, 5],
  9: ['Werewolf', 264, 264, 17, 66, 6], 10: ['Nymph', 265, 265, 15, 50, 6], 11: ['Slaughterfish', 266, 266, 15, 50, 7],
  12: ['Orc Sergeant', 267, 267, 15, 50, 7], 13: ['Harpy', 268, 268, 16, 85, 8], 14: ['Wereboar', 269, 269, 17, 66, 8],
  15: ['Skeletal Warrior', 270, 270, 17, 66, 9], 16: ['Giant', 271, 271, 18, 74, 10], 17: ['Zombie', 272, 272, 52, 66, 10],
  18: ['Ghost', 273, 273, 17, 66, 11], 19: ['Mummy', 274, 274, 17, 66, 11], 20: ['Giant Scorpion', 275, 275, 18, 74, 12],
  21: ['Orc Shaman', 276, 276, 18, 74, 13], 22: ['Gargoyle', 277, 277, 19, 82, 14], 23: ['Wraith', 278, 278, 30, 90, 15],
  24: ['Orc Warlord', 279, 279, 20, 90, 16], 25: ['Frost Daedra', 280, 280, 25, 130, 17], 26: ['Fire Daedra', 281, 281, 26, 138, 17],
  27: ['Daedroth', 282, 282, 27, 146, 18], 28: ['Vampire', 283, 283, 28, 154, 19], 29: ['Daedra Seducer', 284, 284, 27, 146, 19],
  30: ['Vampire Ancient', 285, 285, 30, 170, 20], 31: ['Daedra Lord', 286, 286, 35, 210, 20], 32: ['Lich', 287, 287, 30, 170, 20],
  33: ['Ancient Lich', 288, 288, 30, 170, 21], 34: ['Dragonling', 289, 289, 14, 42, 16], 35: ['Fire Atronach', 290, 290, 25, 130, 16],
  36: ['Iron Atronach', 291, 291, 25, 130, 16], 37: ['Flesh Atronach', 292, 292, 25, 130, 16], 38: ['Ice Atronach', 293, 293, 25, 130, 16],
  40: ['Dragonling', 295, 295, 14, 42, 16], 41: ['Dreugh', 296, 296, 13, 34, 16], 42: ['Lamia', 297, 297, 16, 58, 16],
  128: ['Mage', 486, 485], 129: ['Spellsword', 476, 475], 130: ['Battlemage', 490, 489], 131: ['Sorcerer', 478, 477],
  132: ['Healer', 486, 485], 133: ['Nightblade', 490, 489], 134: ['Bard', 484, 483], 135: ['Burglar', 484, 483],
  136: ['Rogue', 480, 479], 137: ['Acrobat', 484, 483], 138: ['Thief', 484, 483], 139: ['Assassin', 480, 479],
  140: ['Monk', 488, 487], 141: ['Archer', 482, 481], 142: ['Ranger', 482, 481], 143: ['Barbarian', 488, 487],
  144: ['Warrior', 488, 487], 145: ['Knight', 488, 487],
});

/** Place types (Quests-Places): name -> [p1, p2]. p1 0 = building type, 1 = dungeon type, 2 = location type. */
const PLACE_ROWS = [
  ['apothecary', 0, 0], ['town1', 0, 1], ['armory', 0, 2], ['bank', 0, 3], ['town4', 0, 4], ['bookstore', 0, 5],
  ['clothingshop', 0, 6], ['furnitureshop', 0, 7], ['jewelryshop', 0, 8], ['generalstore', 0, 9], ['library', 0, 10],
  ['guildhall', 0, 11], ['magery', 0, 11], ['fighters', 0, 11], ['pawnshop', 0, 12], ['weaponstore', 0, 13],
  ['temple', 0, 14], ['tavern', 0, 15], ['palace', 0, 16], ['house1', 0, 17], ['house2', 0, 18], ['house3', 0, 19],
  ['house4', 0, 20], ['house5', 0, 21], ['house6', 0, 22], ['house7', 0, 23], ['shop', 0, -1], ['house', 0, -1],
  ['random', 0, -1], ['dungeon', 1, -1],
  ...Array.from({ length: 19 }, (_, i) => [`dungeon${i}`, 1, i]),
  ['labyrinth', 2, 4], ['keep', 2, 7], ['ruin', 2, 10], ['graveyard', 2, 12], ['coven', 2, 13], ['farmhome', 2, 3],
  ['wealthyhome', 2, 8], ['poorhome', 2, 11], ['tavernhome', 2, 6], ['templehome', 2, 5], ['cult', 2, 9], ['city', 2, 0],
  ['hamlet', 2, 1], ['village', 2, 2], ['anywhere', 2, -1],
];
export const PLACE_TYPES = new Map(PLACE_ROWS.map(([n, p1, p2]) => [n.toLowerCase(), { p1, p2 }]));
/** First building-type name for a classic building code (p1 = 0). */
export function buildingTypeName(code) {
  if (code === -1 || code === 0xffff) return 'random';
  const row = PLACE_ROWS.find(([, p1, p2]) => p1 === 0 && p2 === code);
  return row ? row[0] : null;
}
export function dungeonTypeName(code) {
  return code === -1 || code === 0xffff ? 'dungeon' : `dungeon${code}`;
}

/** Item classes (Quests-Items) used by town quests: name -> [group, index]. */
const ITEM_ROWS = [
  ['drug', 0, -1], ['junk', 1, -1], ['potion', 1, 1], ['armor', 2, -1], ['weapon', 3, -1], ['magic_item', 4, -1],
  ['artifact', 5, -1], ['mens_clothing', 6, -1], ['book', 7, -1], ['letter', 9, 5], ['religious', 10, -1], ['map', 11, -1],
  ['womens_clothing', 12, -1], ['painting', 13, -1], ['gem', 14, -1], ['ruby', 14, 0], ['emerald', 14, 1],
  ['sapphire', 14, 2], ['diamond', 14, 3], ['jade', 14, 4], ['turquoise', 14, 5], ['malachite', 14, 6], ['amber', 14, 7],
  ['small_plant', 15, -1], ['large_plant', 16, -1], ['organs', 17, -1], ['skin', 18, -1], ['mythic', 19, -1],
  ['misc', 20, -1], ['element', 21, -1], ['mineral', 22, -1], ['pearl', 22, 1], ['transport', 23, -1], ['deed', 24, -1],
  ['trinket', 25, -1], ['ring', 25, 2], ['amulet', 25, 0], ['specials', 26, -1],
];
export const ITEM_CLASSES = new Map(ITEM_ROWS.map(([n, g, i]) => [n.toLowerCase(), { group: g, index: i }]));
export function itemClassName(group, index) {
  const exact = ITEM_ROWS.find(([, g, i]) => g === group && i === index);
  if (exact) return exact[0];
  const any = ITEM_ROWS.find(([, g, i]) => g === group && i === -1);
  return any ? any[0] : null;
}

/** Person faction/group codes (Quests-Factions, p1 = 0): name -> [p2, p3]. */
const FACTION_ROWS = [
  ['Chemist', 0, 0], ['Armorer', 2, 0], ['Banker', 3, 0], ['Bookseller', 5, 0], ['Tailor', 6, 0], ['Carpenter', 7, 0],
  ['Jeweler', 8, 0], ['Shopkeeper', 9, 0], ['Librarian', 10, 0], ['Spellcaster', 11, 0], ['Pawnbroker', 12, 0],
  ['Smith', 13, 0], ['Cleric', 14, 0], ['Innkeeper', 15, 0], ['Noble', 16, 0], ['Resident1', 17, 0], ['Resident2', 18, 0],
  ['Resident3', 19, 0], ['Resident4', 20, 0], ['Questor', 21, 0], ['Local_3.0', -3, 0], ['Local_3.1', -3, 1],
  ['Local_3.2', -3, 2], ['Local_3.3', -3, 3], ['Local_4.0', -4, 0], ['Local_4.1', -4, 1], ['Local_4.2', -4, 2],
  ['Group_5.0', -5, 0], ['Group_5.1', -5, 1], ['Group_5.2', -5, 2], ['Group_6.0', -6, 0], ['Group_7.0', -7, 0],
  ['Group_7.1', -7, 1], ['Group_7.2', -7, 2], ['Group_7.3', -7, 3],
];
export const FACTION_GROUPS = new Map(FACTION_ROWS.map(([n, p2, p3]) => [n.toLowerCase(), { p2, p3, name: n }]));
export function factionGroupName(p2, p3) {
  const row = FACTION_ROWS.find(([, a, b]) => a === p2 && b === p3) || FACTION_ROWS.find(([, a]) => a === p2);
  return row ? row[0] : null;
}

/** Social/guild groups from Daggerfall Unity's QuestList table, by classic file-name prefix letter. */
export const GROUP_BY_PREFIX = Object.freeze({
  A: 'Commoners', B: 'KnightlyOrder', C: 'HolyOrder', K: 'Merchants', L: 'DarkBrotherHood', M: 'FightersGuild',
  N: 'MagesGuild', O: 'GeneralPopulace', P: 'Vampires', Q: 'Witches', R: 'Nobility',
});

/**
 * Global quest variables (Quests-GlobalVars): index -> name. The player keeps 64 booleans across quests;
 * a task declared as `<GlobalName> _symbol_` reads and writes its variable (Task.GetTriggerValue).
 */
const GLOBAL_NAMES = [
  'LiftedCurse', 'GothrydGotTotem', 'KingOfWormsGotTotem', 'GortwogGotTotem', 'AkorithiGotTotem', 'Unused1',
  'UnderkingGotTotem', 'EadwyreGotTotem', 'BrisiennaGotTotem', 'MedoraGotHorn', 'Unused2', 'GothrydEnding',
  'KingOfWormsEnding', 'GortwogEnding', 'AkorithiEnding', 'Unused3', 'UnderkingEnding', 'EadwyreEnding',
  'BrisiennaEnding', 'Unused4', 'Unused5', 'UnknownElysanna', 'Unused6', 'MorgiahSatisfied', 'Unused7',
  'ElysannaSatisfied', 'Unused8', 'Unused9', 'BarenziahSatisfied', 'MyniseraSatisfied', 'Unused10',
  'MetLadyBrisienna', 'Unused11', 'KingOfWormsSatisfied', 'Unused12', 'Unused13', 'FinishedMantellanCrux',
];
export const GLOBAL_VAR_COUNT = 64;
export const GLOBAL_BY_NAME = new Map(GLOBAL_NAMES.map((n, i) => [n.toLowerCase(), i]));
for (let i = GLOBAL_NAMES.length; i < GLOBAL_VAR_COUNT; i++) GLOBAL_BY_NAME.set(`unused${i - 23}`.toLowerCase(), i);
for (let i = 0; i < GLOBAL_VAR_COUNT; i++) GLOBAL_BY_NAME.set(`global${i}`, i);
for (const [symbol, index] of [['UnknownHelseth', 42], ['LysandusSatisfied', 43], ['TookTheCure', 5], ['OpenedShapeshifters', 10]]) {
  GLOBAL_BY_NAME.set(symbol.toLowerCase(), index);
}
export const globalName = (i) => GLOBAL_NAMES[i] ?? `Global${i}`;

/**
 * Permanent quest sites (Quests-Places, "Permanent quest locations"): name -> classic place code p1/p2.
 * p1 is the location's MAPS LocationId (exterior entry, or +1 for its dungeon). The p2 low byte is the
 * teleport-cheat variant. `location` is this server's instance id for the site, verified against the operator's
 * MAPS.BSA by test/rpg-quest-dungeon.test.mjs. Rows without `location` are not reachable here yet.
 * Mantellan_Crux (0xc352) is the code S0000016 actually carries; per the table notes the transfer goes
 * to the Mantellan Crux dungeon (0xc350).
 */
const PERMANENT_ROWS = [
  ['DaggerfallCity1', 0xc36a, 0x0001, 'town:Daggerfall/Daggerfall'],
  ['DaggerfallCity2', 0xc36a, 0x0002, 'town:Daggerfall/Daggerfall'],
  ['DaggerfallCastle', 0xc36b, 0x0001, 'dungeon:Daggerfall/Daggerfall'],
  ['DaggerfallCastle1', 0xc36b, 0xfa01, 'dungeon:Daggerfall/Daggerfall'],
  ['DaggerfallCastle2', 0xc36b, 0xfa0c, 'dungeon:Daggerfall/Daggerfall'],
  ['Mantellan_Crux', 0xc352, 0xfa01, 'dungeon:High Rock sea coast/Mantellan Crux'],
  ['MantellanCrux', 0xc350, 0xfa01, 'dungeon:High Rock sea coast/Mantellan Crux'],
  ['ShedungentEntry', 0xc354, 0x0001, 'town:Wrothgarian Mountains/Shedungent'],
  ['Shedungent1', 0xc355, 0xfa01, 'dungeon:Wrothgarian Mountains/Shedungent'],
  ['Shedungent2', 0xc355, 0x0002, 'dungeon:Wrothgarian Mountains/Shedungent'],
  ['Shedungent4', 0xc355, 0xfa04, 'dungeon:Wrothgarian Mountains/Shedungent'],
  ['GlenmorilCoven', 0xc358, 0x0001, 'town:Ilessan Hills/Glenmoril Coven'],
  ...CAMPAIGN_SITES,
];
export const PERMANENT_PLACES = new Map(PERMANENT_ROWS.map(([n, p1, p2, location]) => [n.toLowerCase(), { name: n, p1, p2, location }]));
/** Name of a permanent place from its classic codes (exact variant first, then any variant of the site). */
export function permanentPlaceName(p1, p2) {
  const u = (v) => v & 0xffff;
  const exact = PERMANENT_ROWS.find(([, a, b]) => a === u(p1) && b === u(p2));
  const any = exact ?? PERMANENT_ROWS.find(([, a]) => a === u(p1));
  return any?.[0] ?? null;
}
