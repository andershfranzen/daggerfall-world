// Mobile sprite tables: which TEXTURE archive a creature or person uses, which
// record holds each animation per facing, frame rates, mirroring and corpses.
//
// Values transcribed from Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall
// Workshop): Utility/EnemyBasics.cs (enemy archives, corpse textures,
// MoveAnims/PrimaryAttackAnims/HurtAnims/IdleAnims/RangedAttack1Anims and the
// rat, ghost/wraith and female-thief variants), Internal/MobilePersonBillboard.cs
// (town people archives and animations), DaggerfallUnityEnums.cs (MobileTypes)
// and Internal/DaggerfallLootDataTables.cs (treasure icons).
// See ./THIRD_PARTY_NOTICES.txt. No game data is included: these are
// archive/record numbers that index into the player's own files.

/** Facing index: 0 front (looking at the viewer), 2 viewer's left, 4 back, 6 viewer's right. */
export const ORIENTATIONS = 8;

// [record, flip] per facing 0..7. "Facing south" in DFU is the sprite drawn facing the viewer.
const set = (base, flips = [0, 0, 0, 0, 0, 1, 1, 1]) => {
  const rec = [0, 1, 2, 3, 4, 3, 2, 1];
  return rec.map((r, i) => [base + r, !!flips[i]]);
};

export const FPS = { move: 6, attack: 10, hurt: 4, idle: 4, ranged: 10, personMove: 4, personIdle: 1, flat: 4 };

export const ENEMY_ANIMS = {
  move: set(0),
  attack: set(5),
  hurt: set(10),
  idle: set(15),
  ranged: set(20),
};

/** Rats are drawn facing the other way in their idle records. */
export const RAT_IDLE = set(15, [0, 1, 1, 1, 0, 0, 0, 0]);
/** Ghost and wraith side views are mirrored relative to every other mobile. */
export const SPECTRAL_MOVE = set(0, [0, 0, 1, 0, 0, 1, 0, 1]);
export const SPECTRAL_ATTACK = set(5, [0, 0, 1, 0, 0, 1, 0, 1]);
/** Female thief idle uses hurt record 11 for the front diagonals (as classic). */
export const FEMALE_THIEF_IDLE = [[15, false], [11, false], [17, false], [18, false], [19, false], [18, true], [17, true], [11, true]];

export const PERSON_ANIMS = {
  move: set(0),
  idle: Array.from({ length: 8 }, () => [5, false]),
  guardIdle: Array.from({ length: 8 }, () => [15, false]),
};

export const RAT_ARCHIVE = 255;
export const SPECTRAL_ARCHIVES = new Set([273, 278]);
export const GUARD_ARCHIVE = 399;
export const CORPSE_FALLBACK = [380, 1];
export const TREASURE_ARCHIVE = 216;
export const TREASURE_ICONS = [0, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 37, 43, 44, 45, 46, 47];

/** MobileTypes id → { name, male, female, corpse:[archive,record], humanoid, flying } */
const ROWS = [
  // id, name, male, female, corpseArchive, corpseRecord, behaviour
  [0, 'Rat', 255, 255, 401, 1, 'g'], [1, 'Imp', 256, 256, 406, 5, 'f'], [2, 'Spriggan', 257, 257, 406, 3, 'g'],
  [3, 'Giant Bat', 258, 258, 401, 0, 'f'], [4, 'Grizzly Bear', 259, 259, 401, 2, 'g'], [5, 'Sabertooth Tiger', 260, 260, 401, 3, 'g'],
  [6, 'Spider', 261, 261, 401, 4, 'g'], [7, 'Orc', 262, 262, 96, 2, 'g'], [8, 'Centaur', 263, 263, 406, 0, 'g'],
  [9, 'Werewolf', 264, 264, 96, 5, 'g'], [10, 'Nymph', 265, 265, 406, 2, 'g'], [11, 'Slaughterfish', 266, 266, 305, 1, 'a'],
  [12, 'Orc Sergeant', 267, 267, 96, 2, 'g'], [13, 'Harpy', 268, 268, 406, 4, 'f'], [14, 'Wereboar', 269, 269, 96, 5, 'g'],
  [15, 'Skeletal Warrior', 270, 270, 306, 1, 'g'], [16, 'Giant', 271, 271, 406, 1, 'g'], [17, 'Zombie', 272, 272, 306, 4, 'g'],
  [18, 'Ghost', 273, 273, 306, 0, 's'], [19, 'Mummy', 274, 274, 306, 5, 'g'], [20, 'Giant Scorpion', 275, 275, 401, 5, 'g'],
  [21, 'Orc Shaman', 276, 276, 96, 2, 'g'], [22, 'Gargoyle', 277, 277, 96, 1, 'g'], [23, 'Wraith', 278, 278, 306, 0, 's'],
  [24, 'Orc Warlord', 279, 279, 96, 2, 'g'], [25, 'Frost Daedra', 280, 280, 400, 3, 'g'], [26, 'Fire Daedra', 281, 281, 400, 2, 'g'],
  [27, 'Daedroth', 282, 282, 400, 1, 'g'], [28, 'Vampire', 283, 283, 96, 3, 'g'], [29, 'Daedra Seducer', 284, 284, 400, 6, 'g'],
  [30, 'Vampire Ancient', 285, 285, 96, 3, 'g'], [31, 'Daedra Lord', 286, 286, 400, 4, 'g'], [32, 'Lich', 287, 287, 306, 2, 'g'],
  [33, 'Ancient Lich', 288, 288, 306, 3, 'g'], [34, 'Dragonling', 289, 289, 96, 0, 'f'], [35, 'Fire Atronach', 290, 290, 405, 2, 'g'],
  [36, 'Iron Atronach', 291, 291, 405, 1, 'g'], [37, 'Flesh Atronach', 292, 292, 405, 0, 'g'], [38, 'Ice Atronach', 293, 293, 405, 3, 'g'],
  [40, 'Dragonling', 295, 295, 96, 0, 'f'], [41, 'Dreugh', 296, 296, 305, 0, 'a'], [42, 'Lamia', 297, 297, 305, 2, 'a'],
  [128, 'Mage', 486, 485], [129, 'Spellsword', 476, 475], [130, 'Battlemage', 490, 489], [131, 'Sorcerer', 478, 477],
  [132, 'Healer', 486, 485], [133, 'Nightblade', 490, 489], [134, 'Bard', 484, 483], [135, 'Burglar', 484, 483],
  [136, 'Rogue', 480, 479], [137, 'Acrobat', 484, 483], [138, 'Thief', 484, 483], [139, 'Assassin', 480, 479],
  [140, 'Monk', 488, 487], [141, 'Archer', 482, 481], [142, 'Ranger', 482, 481], [143, 'Barbarian', 488, 487],
  [144, 'Warrior', 488, 487], [145, 'Knight', 488, 487], [146, 'City Watch', 399, 399, 380, 1, 'guard'],
];

export const MOBILES = new Map(ROWS.map(([id, name, male, female, ca = 380, cr = 1, b = 'h']) => [id, {
  id, name, male, female, corpse: [ca, cr], humanoid: id >= 128, flying: b === 'f', spectral: b === 's',
}]));

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
const BY_NAME = new Map();
for (const m of MOBILES.values()) if (!BY_NAME.has(norm(m.name))) BY_NAME.set(norm(m.name), m);
BY_NAME.set('citywatch', MOBILES.get(146));
BY_NAME.set('guard', MOBILES.get(146));
BY_NAME.set('skeleton', MOBILES.get(15));
BY_NAME.set('bat', MOBILES.get(3));

/** Find a mobile by MobileTypes id or (case/space-insensitive) display name. */
export function mobileFor(idOrName) {
  if (typeof idOrName === 'number') return MOBILES.get(idOrName) ?? null;
  if (idOrName == null) return null;
  return BY_NAME.get(norm(idOrName)) ?? null;
}

/** Corpse [archive, record] for a mobile's archive (any gender). */
const CORPSE_BY_ARCHIVE = new Map();
for (const m of MOBILES.values()) {
  CORPSE_BY_ARCHIVE.set(m.male, m.corpse);
  CORPSE_BY_ARCHIVE.set(m.female, m.corpse);
}
export const corpseForArchive = (archive) => CORPSE_BY_ARCHIVE.get(archive) ?? CORPSE_FALLBACK;

/** Archives that use the 20/25-record enemy layout (0-4 move, 5-9 attack, 10-14 hurt, 15-19 idle, 20-24 ranged). */
export const ENEMY_ARCHIVES = new Set([...MOBILES.values()].flatMap((m) => [m.male, m.female]));

/** Town people: civilian archives by race and gender, four variants each. */
export const PEOPLE = {
  breton: { male: [385, 386, 391, 394], female: [453, 454, 455, 456] },
  redguard: { male: [381, 382, 383, 384], female: [395, 396, 397, 398] },
  nord: { male: [387, 388, 389, 390], female: [392, 393, 451, 452] },
};
export const PERSON_ARCHIVES = new Set(Object.values(PEOPLE).flatMap((g) => [...g.male, ...g.female]));

/** Races without their own town sprites use the Breton set, as Daggerfall Unity does. */
export function peopleFor(race) {
  const r = norm(race);
  return PEOPLE[r] ?? PEOPLE.breton;
}
