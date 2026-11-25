// Which of the player's own MIDI.BSA songs suits the current scene, and which DAGGER.SND
// clips the world uses for swings, hits and ambience.
//
// Song lists are Daggerfall Unity's SongManager.cs arrays, record names as they appear in
// MIDI.BSA, via daggerfall-js-source src/systems/song/songManager.js; clip numbers are
// DFU's SoundClips.cs enum values (DAGGER.SND record indices). Selection seeds
// Daggerfall's LCG (DFRandom) with the game day, as DFU does, so every player in the same
// kind of place hears the same song that day. Both MIT; see NOTICES.txt.

export const SONGS = Object.freeze({
  sunny: ['GDAY___D.HMI', 'SWIMMING.HMI', 'GSUNNY2.HMI', 'SUNNYDAY.HMI', '02.HMI', '03.HMI', '22.HMI'],
  sunnyFM: ['FDAY___D.HMI', 'FM_SWIM2.HMI', 'FM_SUNNY.HMI', '02FM.HMI', '03FM.HMI', '22FM.HMI'],
  cloudy: ['GDAY___D.HMI', 'SWIMMING.HMI', 'GSUNNY2.HMI', 'SUNNYDAY.HMI', '02.HMI', '03.HMI', '22.HMI', '29.HMI', '12.HMI'],
  cloudyFM: ['FDAY___D.HMI', 'FM_SWIM2.HMI', 'FM_SUNNY.HMI', '02FM.HMI', '03FM.HMI', '22FM.HMI', '29FM.HMI', '12FM.HMI'],
  overcast: ['29.HMI', '12.HMI', '13.HMI', 'GPALAC.HMI', 'OVERCAST.HMI'],
  overcastFM: ['29FM.HMI', '12FM.HMI', '13FM.HMI', 'FPALAC.HMI', 'FMOVER_C.HMI'],
  rain: ['OVERLONG.HMI', 'RAINING.HMI', '08.HMI'],
  rainFM: ['FMOVER_C.HMI', 'FM_RAIN.HMI', '08FM.HMI'],
  snow: ['20.HMI', 'GSNOW__B.HMI', 'OVERSNOW.HMI', 'SNOWING.HMI'],
  snowFM: ['20FM.HMI', 'FSNOW__B.HMI', 'FMOVER_S.HMI'],
  night: ['10.HMI', '11.HMI', 'GCURSE.HMI', 'GEERIE.HMI', 'GRUINS.HMI', '18.HMI', '21.HMI'],
  nightFM: ['11FM.HMI', 'FCURSE.HMI', 'FEERIE.HMI', 'FRUINS.HMI', '18FM.HMI', '21FM.HMI'],
  dungeon: ['DUNGEON.HMI', 'DUNGEON5.HMI', 'DUNGEON6.HMI', 'DUNGEON7.HMI', 'DUNGEON8.HMI', 'DUNGEON9.HMI', 'GDNGN10.HMI', 'GDNGN11.HMI', 'GDUNGN4.HMI', 'GDUNGN9.HMI', '04.HMI', '05.HMI', '07.HMI', '15.HMI', '28.HMI'],
  dungeonFM: ['FM_DNGN1.HMI', 'FM_DNGN1.HMI', 'FM_DNGN2.HMI', 'FM_DNGN3.HMI', 'FM_DNGN4.HMI', 'FM_DNGN5.HMI', 'FDNGN10.HMI', 'FDNGN11.HMI', 'FDUNGN4.HMI', 'FDUNGN9.HMI', '04FM.HMI', '05FM.HMI', '07FM.HMI', '15FM.HMI', '15FM.HMI'],
  tavern: ['SQUARE_2.HMI', 'TAVERN.HMI', 'FOLK1.HMI', 'FOLK2.HMI', 'FOLK3.HMI'],
  tavernFM: ['SQUARE_2.HMI', 'TAVERN.HMI', 'FOLK1.HMI', 'FOLK2.HMI', 'FOLK3.HMI'],
  temple: ['GNEUT.HMI'],
  templeFM: ['FNEUT.HMI'],
  shop: ['GSHOP.HMI'],
  shopFM: ['FM_SQR_2.HMI'],
  guild: ['GMAGE_3.HMI', 'MAGIC_2.HMI'],
  guildFM: ['FM_NITE3.HMI'],
  palace: ['06.HMI'],
  palaceFM: ['06FM.HMI'],
  interior: ['23.HMI'],
  interiorFM: ['23FM.HMI'],
});

/** Daggerfall's LCG (DFRandom.rand after srand(seed)), first draw. */
export function dfRand(seed) {
  const next = (Math.imul(seed >>> 0, 1103515245) + 12345) >>> 0;
  return (next >>> 16) & 0x7fff;
}

/** The scene kind a location string maps to. */
export function sceneKind(location, { night = false, weather = 'sunny' } = {}) {
  const loc = String(location ?? '').toLowerCase();
  const [prefix] = loc.split(':');
  const rest = loc.slice(prefix.length + 1);
  if (prefix === 'dungeon') return 'dungeon';
  const inside = /^(interior|building|house|shop|tavern|temple|guild|palace|castle|inside)$/.test(prefix);
  if (inside) {
    if (prefix === 'tavern' || /tavern|inn\b|\bbar\b|barrel|flagon|tankard/.test(rest)) return 'tavern';
    if (prefix === 'temple' || /temple|chapel|shrine/.test(rest)) return 'temple';
    if (prefix === 'shop' || /shop|store|market|armou?rer|smith|general|pawn|alchemist|bookseller|jewel|cloth/.test(rest)) return 'shop';
    if (prefix === 'guild' || /guild/.test(rest)) return 'guild';
    if (prefix === 'palace' || prefix === 'castle' || /palace|castle/.test(rest)) return 'palace';
    return 'interior';
  }
  if (night) return 'night';
  switch (weather) {
    case 'cloudy': return 'cloudy';
    case 'overcast': case 'fog': return 'overcast';
    case 'rain': case 'thunder': return 'rain';
    case 'snow': return 'snow';
    default: return 'sunny';
  }
}

/**
 * Pick the song for a scene. Tavern songs walk the list day by day; one-song lists
 * never roll; guilds re-roll per visit (pass `random`); everything else is seeded
 * with the game day, so a place keeps its song until midnight.
 * @param {string[]} available upper-case record names present in the player's MIDI.BSA
 */
export function chooseSong(kind, { fm = false, gameDays = 0, available = null, random = Math.random } = {}) {
  let list = SONGS[fm ? `${kind}FM` : kind] ?? SONGS.sunny;
  if (available) {
    const have = list.filter((n) => available.has(n));
    if (!have.length && fm) return chooseSong(kind, { fm: false, gameDays, available, random });
    list = have;
  }
  if (!list.length) return null;
  let index = 0;
  if (kind === 'guild') index = Math.floor(random() * list.length) % list.length;
  else if (kind === 'tavern') index = (Math.trunc(gameDays) >>> 0) % list.length;
  else if (list.length > 1) index = dfRand(Math.trunc(gameDays) >>> 0) % list.length;
  return list[index];
}

/** DAGGER.SND record indices (DFU SoundClips). */
export const CLIP = Object.freeze({
  ArrowShoot: 3,
  AmbientCrickets: 6,
  AmbientCreepyBirdCall: 14,
  AmbientWindMoan: 65,
  AmbientBirdCall: 75,
  NormalDoorClose: 93,
  NormalDoorOpen: 94,
  AnimalHorse: 99,
  AnimalDog: 100,
  AnimalCat: 101,
  AnimalPig: 102,
  AnimalCow: 103,
  SwingLowPitch: 105,
  SwingHighPitch: 106,
  Bells: 107,
  Hit1: 108,
  Hit2: 109,
  Hit3: 110,
  Hit4: 111,
  Hit5: 112,
  AmbientDistantHowl: 113,
  PlayerFootstepStone1: 309,
  PlayerFootstepOutside1: 310,
  PlayerFootstepSnow1: 311,
  PlayerFootstepWood1: 313,
  PlayerFootstepStone2: 330,
  PlayerFootstepOutside2: 331,
  PlayerFootstepSnow2: 332,
  SwingMediumPitch: 347,
  StormLightningShort: 348,
  StormLightningThunder: 349,
  StormThunderRoll: 350,
  SwingMediumPitch2: 353,
  ButtonClick: 360,
  PageTurn: 362,
  EquipLongBlade: 378,
  AmbientRaining: 389,
  Parry1: 428,
  BirdCall1: 437,
  BirdCall2: 438,
  AmbientPeople1: 441,
  // Package 21 additions (same SoundClips.cs source).
  PlayerDoorBash: 7,
  BodyFall: 15,
  DungeonDoorClose: 24,
  DungeonDoorOpen: 25,
  AmbientDripShort: 63,
  AmbientDripLong: 64,
  AmbientWindMoanDeep: 66,
  AmbientDoorOpen: 67,
  AmbientGrind: 68,
  AmbientStrumming: 69,
  AmbientWindBlow1: 70,
  AmbientWindBlow1a: 71,
  AmbientWindBlow1b: 72,
  AmbientMonsterRoar: 73,
  AmbientGoldPieces: 74,
  AmbientDoorClose: 76,
  FallDamage: 91,
  FallHard: 92,
  AmbientWaterBubbles: 114,
  PlayerFootstepSwimming: 312,
  PlayerFootstepWood2: 333,
  SplashSmallLow: 334,
  SplashLarge: 342,
  SplashSmall: 346,
  ActivateLockUnlock: 316,
  WaterGentle: 439,
  WaterRough: 440,
  Halt: 456,
});

/**
 * Creature voices by MobileTypes id: [move, bark, attack] DAGGER.SND indices, from DFU EnemyBasics.cs
 * (MoveSound/BarkSound/AttackSound) resolved through SoundClips.cs. Id 39 (Ancient Lich) has none in DFU.
 * Wereboar (21) attacks with the Orc attack clip in DFU's table, and that is kept as written.
 */
export const CREATURE_SOUNDS = Object.freeze({
  0: [115, 116, 117], 1: [118, 119, 120], 2: [121, 122, 123], 3: [124, 125, 126], 4: [127, 128, 129],
  5: [130, 131, 132], 6: [133, 134, 135], 7: [136, 137, 138], 8: [139, 140, 141], 9: [142, 143, 144],
  10: [145, 146, 147], 11: [148, 149, 150], 12: [151, 152, 153], 13: [154, 155, 156], 14: [157, 158, 159],
  15: [160, 161, 162], 16: [163, 164, 165], 17: [166, 167, 168], 18: [169, 170, 171], 19: [172, 173, 174],
  20: [175, 176, 177], 21: [178, 179, 138], 22: [181, 182, 180], 23: [183, 184, 185], 24: [186, 187, 188],
  25: [189, 190, 191], 26: [192, 193, 194], 27: [195, 196, 197], 28: [198, 199, 200], 29: [201, 202, 203],
  30: [204, 205, 206], 31: [207, 208, 209], 32: [210, 211, 212], 33: [213, 214, 215], 34: [216, 217, 218],
  35: [219, 220, 221], 36: [222, 223, 224], 37: [225, 226, 227], 38: [228, 229, 230], 40: [216, 217, 218],
  41: [237, 238, 239], 42: [240, 241, 242],
  // Class enemies 128-145 share the human set; City Watch (146) barks "Halt!".
  ...Object.fromEntries(Array.from({ length: 18 }, (_, i) => [128 + i, [243, 244, 245]])),
  146: [243, 456, 245],
});
/** DFU EnemySounds: attract radius (m), delay range (s), move-vs-bark split; human class voices muted except the Watch. */
export const CREATURE_ATTRACT = Object.freeze({ radius: 16, minDelay: 3, maxDelay: 9, moveChance: 0.2 });
export const CITY_WATCH = 146;

/**
 * DFU DaggerfallEnemy: the Acute Hearing career advantage extends the audible enemy range by 25%, or by 50% while
 * an ImprovesTalents (Hearing) item is worn (`improved`: the sheet's improvedTalents).
 */
export function hearingRadius(advantages, improved = []) {
  const acute = Array.isArray(advantages) && advantages.some((a) => (a?.key ?? a) === 'acuteHearing');
  if (!acute) return CREATURE_ATTRACT.radius;
  return CREATURE_ATTRACT.radius * (Array.isArray(improved) && improved.includes('acuteHearing') ? 1.5 : 1.25);
}

/** Which creature clip to play: 'attack' on a monster attack, 'attract' (move or bark) while nearby. null if silent. */
export function creatureClip(monsterId, what, rand = Math.random) {
  const id = Number(monsterId);
  const set = CREATURE_SOUNDS[id];
  if (!set || set[0] === null) return null;
  if (what === 'attack') return set[2];
  if (id >= 128 && id !== CITY_WATCH) return null; // EnemySounds.MuteHumanSounds (default true)
  return rand() < CREATURE_ATTRACT.moveChance ? set[0] : set[1];
}

/** AmbientEffectsPlayer Dungeon preset. */
export const DUNGEON_AMBIENCE = Object.freeze([
  63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76,
]);

/** Which clips a gameplay event triggers. Returns [] for events with no sound. `rand` in [0,1). */
/** AcrobatMotor.fallingDamageThreshold (metres); client/lib/locomotion.js LOCO.safeFall. */
export const FALL_DAMAGE_M = 5;

export function clipsForEvent(ev, { selfId = null, rand = Math.random } = {}) {
  if (!ev || typeof ev !== 'object') return [];
  const me = (id) => id !== undefined && id !== null && selfId !== null && String(id) === String(selfId);
  switch (ev.kind) {
    case 'swing': {
      const pool = [CLIP.SwingLowPitch, CLIP.SwingMediumPitch, CLIP.SwingMediumPitch2, CLIP.SwingHighPitch];
      return [{ clip: pool[Math.floor(rand() * pool.length) % pool.length], self: me(ev.playerId) }];
    }
    case 'hit': case 'damage':
      return [{ clip: CLIP.Hit1 + (Math.floor(rand() * 5) % 5), self: me(ev.playerId) || me(ev.targetId) }];
    case 'parry': case 'block':
      return [{ clip: CLIP.Parry1 + (Math.floor(rand() * 9) % 9), self: true }];
    case 'miss':
      return [];
    case 'kill': case 'death':
      return [{ clip: CLIP.Hit1 + 2, self: true }];
    case 'equip':
      return [{ clip: CLIP.EquipLongBlade, self: true }];
    case 'door': case 'enter': case 'exit':
      return [{ clip: CLIP.NormalDoorOpen, self: true }];
    case 'monsterAttack':
      // The creature's own attack voice comes from the frame loop (it needs the entity's monster id).
      return ev.hit && me(ev.targetId) ? [{ clip: CLIP.Hit1 + (Math.floor(rand() * 5) % 5), self: true }] : [];
    case 'dungeonCue': // package 5: lock/unlock (pick, Open, Lock), bash swing on a door, trap fired
      if (ev.cue === 'unlock' || ev.cue === 'lock') return [{ clip: CLIP.ActivateLockUnlock, self: false, at: ev }];
      if (ev.cue === 'bash') return [{ clip: CLIP.PlayerDoorBash, self: false, at: ev }];
      if (ev.cue === 'trap' && Math.trunc(Number(ev.sound)) > 0) return [{ clip: Math.trunc(Number(ev.sound)), self: false, at: ev }];
      return [];
    case 'land': {
      // AcrobatMotor.CheckFallingDamage / PlayerFootsteps: FallDamage beyond fallingDamageThreshold (5 m, the
      // fall that hurts), FallHard beyond half of it, and an ordinary landing is silent here.
      const fall = Number(ev.fall);
      if (ev.damage > 0) return [{ clip: CLIP.FallDamage, self: true }];
      if (fall > FALL_DAMAGE_M / 2 && fall <= FALL_DAMAGE_M) return [{ clip: CLIP.FallHard, self: true }];
      return [];
    }
    case 'splash':
      return [{ clip: CLIP.SplashLarge, self: me(ev.playerId) || ev.playerId === undefined }];
    case 'journal': case 'quest':
      return [{ clip: CLIP.PageTurn, self: true }];
    case 'questSound':
      return Number.isInteger(ev.sound) ? [{ clip: ev.sound, self: true }] : [];
    case 'travel':
      return [{ clip: CLIP.AnimalHorse, self: true }];
    default:
      return [];
  }
}

/** Ambient loop and one-shot pool for a scene. */
export function ambienceFor({ kind, night, weather, indoors, underwater = false, atSea = false }) {
  const loops = [];
  let shots = [];
  if (weather === 'rain' || weather === 'thunder') loops.push(CLIP.AmbientRaining);
  if (atSea && !indoors) {
    loops.push(weather === 'thunder' || weather === 'rain' ? CLIP.WaterRough : CLIP.WaterGentle);
    shots = [CLIP.AmbientWindBlow1, CLIP.AmbientWindBlow1a, CLIP.AmbientWindBlow1b];
  } else if (!indoors && kind !== 'dungeon') {
    if (night && weather !== 'rain' && weather !== 'thunder' && weather !== 'snow') loops.push(CLIP.AmbientCrickets);
    if (weather === 'thunder') shots = [CLIP.StormLightningShort, CLIP.StormLightningThunder, CLIP.StormThunderRoll];
    else if (night) shots = [CLIP.AmbientDistantHowl, CLIP.AmbientCreepyBirdCall, CLIP.AnimalDog];
    else if (weather === 'sunny' || weather === 'cloudy') shots = [CLIP.BirdCall1, CLIP.BirdCall2, CLIP.AmbientBirdCall, CLIP.AnimalDog, CLIP.AnimalCat];
    else shots = [CLIP.AmbientWindMoan, CLIP.AnimalDog];
  } else if (kind === 'dungeon') {
    shots = [...DUNGEON_AMBIENCE];
  }
  // Taverns, shops and houses have no ambient one-shots in DFU's AmbientEffectsPlayer (the tavern's
  // ambience is its song list).
  if (underwater) { loops.length = 0; shots = [CLIP.AmbientWaterBubbles]; }
  return { loops, shots };
}

/**
 * Footstep clip pair by ground, after DFU PlayerFootsteps: dungeons and castles are stone, building interiors
 * wood, winter or snowfall outdoors is snow, otherwise outdoor ground. Water overrides: submerged (swimming) uses
 * SplashSmall and wading uses SplashSmallLow. `surface` from the movement owner overrides the inference.
 */
export function footstepClips({ indoors, weather, kind, season, surface, swimming = false, wading = false, snowFree = false }) {
  if (swimming || surface === 'water-deep') return [CLIP.SplashSmall, CLIP.SplashSmall];
  if (wading || surface === 'water') return [CLIP.SplashSmallLow, CLIP.SplashSmallLow];
  if (surface === 'stone') return [CLIP.PlayerFootstepStone1, CLIP.PlayerFootstepStone2];
  if (surface === 'wood') return [CLIP.PlayerFootstepWood1, CLIP.PlayerFootstepWood2];
  if (surface === 'snow') return [CLIP.PlayerFootstepSnow1, CLIP.PlayerFootstepSnow2];
  if (surface === 'grass' || surface === 'ground') return [CLIP.PlayerFootstepOutside1, CLIP.PlayerFootstepOutside2];
  if (kind === 'dungeon') return [CLIP.PlayerFootstepStone1, CLIP.PlayerFootstepStone2];
  if (indoors) return [CLIP.PlayerFootstepWood1, CLIP.PlayerFootstepWood2];
  if (weather === 'snow' || (season === 'Winter' && !snowFree)) return [CLIP.PlayerFootstepSnow1, CLIP.PlayerFootstepSnow2];
  return [CLIP.PlayerFootstepOutside1, CLIP.PlayerFootstepOutside2];
}

/**
 * Sound for a dungeon mechanism that changed state. Doors use DFU's dungeon door pair (SetDungeonDoorSounds);
 * everything else plays its record's own sound byte (DaggerfallAction.Index, played when > 0).
 */
export function mechanismClip({ door = false, open = true, sound = 0 } = {}) {
  if (door) return open ? CLIP.DungeonDoorOpen : CLIP.DungeonDoorClose;
  const n = Math.trunc(Number(sound));
  return n > 0 ? n : null;
}
