// Daedra summoning rules (package 19). Pure functions and tables, no I/O.
//
// Rules adapted from Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop), revision 3d85a28:
//   UserInterfaceWindows/DaggerfallQuestPopupWindow.cs   daedraData, DaedraSummoningService, ConfirmSummon
//   Formulas/FormulaHelper.cs                            CalculateDaedraSummoningCost / Chance
//   Guilds/MagesGuild.cs, Guilds/Temple.cs               DaedraSummoning rank gates
//   Guilds/Services.cs                                   summoner service faction ids
//   API/FactionFile.cs                                   prince and coven faction ids
// The words a player reads come from the operator's TEXT.RSC (480 not today, 481 are you sure, 482 summoned
// before, 484 failed) and the quest's own QRC; nothing from the game archives is copied here.

/** daedraData, in source order: index 0 is Hircine (Glenmoril), index 8 is Sheogorath (the 5% stand-in). */
export const DAEDRA = Object.freeze([
  { factionId: 4, key: 'hircine', name: 'Hircine', quest: 'X0C00Y00', dayOfYear: 155, bonus: 'none' },
  { factionId: 1, key: 'clavicus-vile', name: 'Clavicus Vile', quest: 'V0C00Y00', dayOfYear: 1, bonus: 'none' },
  { factionId: 2, key: 'mehrunes-dagon', name: 'Mehrunes Dagon', quest: 'Y0C00Y00', dayOfYear: 320, bonus: 'none' },
  { factionId: 3, key: 'molag-bal', name: 'Molag Bal', quest: '20C00Y00', dayOfYear: 350, bonus: 'none' },
  { factionId: 5, key: 'sanguine', name: 'Sanguine', quest: '70C00Y00', dayOfYear: 46, bonus: 'rain' },
  { factionId: 6, key: 'peryite', name: 'Peryite', quest: '50C00Y00', dayOfYear: 99, bonus: 'rain' },
  { factionId: 7, key: 'malacath', name: 'Malacath', quest: '80C0XY00', dayOfYear: 278, bonus: 'none' },
  { factionId: 8, key: 'hermaeus-mora', name: 'Hermaeus Mora', quest: 'W0C00Y00', dayOfYear: 65, bonus: 'none' },
  { factionId: 9, key: 'sheogorath', name: 'Sheogorath', quest: '60C00Y00', dayOfYear: 32, bonus: 'thunder' },
  { factionId: 10, key: 'boethiah', name: 'Boethiah', quest: 'U0C00Y00', dayOfYear: 302, bonus: 'rain' },
  { factionId: 11, key: 'namira', name: 'Namira', quest: '30C00Y00', dayOfYear: 129, bonus: 'none' },
  { factionId: 12, key: 'meridia', name: 'Meridia', quest: '10C00Y00', dayOfYear: 13, bonus: 'none' },
  { factionId: 13, key: 'vaernima', name: 'Vaernima', quest: '90C00Y00', dayOfYear: 190, bonus: 'none' },
  { factionId: 14, key: 'nocturnal', name: 'Nocturnal', quest: '40C00Y00', dayOfYear: 248, bonus: 'rain' },
  { factionId: 15, key: 'mephala', name: 'Mephala', quest: 'Z0C00Y00', dayOfYear: 283, bonus: 'none' },
  { factionId: 16, key: 'azura', name: 'Azura', quest: 'T0C00Y00', dayOfYear: 81, bonus: 'none' },
]);
export const SHEOGORATH_INDEX = 8;
export const DAEDRA_BY_FACTION = new Map(DAEDRA.map((d, i) => [d.factionId, { ...d, index: i }]));
export const DAEDRA_QUESTS = new Set(DAEDRA.map((d) => d.quest));

/** TEXT.RSC records (DaggerfallQuestPopupWindow constants). */
export const SUMMON_TEXT = Object.freeze({ notToday: 480, areYouSure: 481, before: 482, failed: 484 });

/** DaggerfallQuestPopupWindow.daedricFoes (MobileTypes ids): spawned when a coven summoning fails. */
export const DAEDRIC_FOES = Object.freeze([31, 29, 27, 26, 25]); // Daedra Lord, Seducer, Daedroth, Fire, Frost

/** FactionFile: The Glenmoril Witches always summon Hircine. FactionTypes.WitchesCoven = 8. */
export const GLENMORIL = 419;
export const FACTION_TYPE_COVEN = 8;
export const MAGES_SUMMONER = 66;
export const MAGES_SUMMON_RANK = 6;

/** Services.cs temple DaedraSummoning ids -> deity faction (Temple.Divines) and Temple.cs summoning rank. */
export const TEMPLE_SUMMONERS = Object.freeze(new Map([
  [475, { deity: 26, name: 'Akatosh', rank: 7 }],
  [456, { deity: 21, name: 'Arkay', rank: 7 }],
  [488, { deity: 29, name: 'Dibella', rank: 7 }],
  [482, { deity: 27, name: 'Julianos', rank: 6 }],
  [498, { deity: 35, name: 'Kynareth', rank: 7 }],
  [470, { deity: 24, name: 'Mara', rank: 7 }],
  [492, { deity: 33, name: 'Stendarr', rank: 7 }],
  [464, { deity: 22, name: 'Zenithar', rank: 8 }],
]));

/** FormulaHelper.CalculateDaedraSummoningCost: the summoner faction's standing lowers the price. */
export const summoningCost = (summonerRep) => 200000 - (Math.trunc(Number(summonerRep) || 0) * 1000);

/** FormulaHelper.CalculateDaedraSummoningChance. */
export const summoningChance = (daedraRep, bonus) => 30 + (Math.trunc(Number(daedraRep) || 0)) + bonus;

/**
 * The 30% weather bonus. Princes without a condition always get it; Rain needs rain (a thunderstorm also
 * rains: WeatherManager sets IsRaining for both) and Thunder needs a storm.
 */
export function weatherBonus(daedra, weatherType) {
  if (daedra.bonus === 'none') return 30;
  if (daedra.bonus === 'rain') return weatherType === 'rain' || weatherType === 'thunder' ? 30 : 0;
  if (daedra.bonus === 'thunder') return weatherType === 'thunder' ? 30 : 0;
  return 0;
}

/**
 * Who can summon here. `entity` is the NPC (source person) the player is talking to.
 * Returns {kind:'mages'|'temple'|'coven', summonerFaction, rankNeeded, guild, deity?} or null.
 */
export function summonerOf(entity, factionType = null) {
  if (!entity) return null;
  const f = Number(entity.faction);
  if (f === MAGES_SUMMONER) return { kind: 'mages', summonerFaction: f, guild: 'mages', rankNeeded: MAGES_SUMMON_RANK };
  const t = TEMPLE_SUMMONERS.get(f);
  if (t) return { kind: 'temple', summonerFaction: f, guild: 'temple', rankNeeded: t.rank, deity: t.deity, deityName: t.name };
  if (entity.role === 'witch' || factionType === FACTION_TYPE_COVEN) return { kind: 'coven', summonerFaction: f, guild: null, rankNeeded: null, glenmoril: f === GLENMORIL };
  return null;
}

/**
 * Selects the prince for an attempt (DaedraSummoningService). `state` is the player's coven roll
 * {day, index}; it is updated in place when a coven picks a new prince for the day (Random.Range(1, 16)).
 * Returns the daedra row (with index) or null when it is not a summoning day.
 */
export function selectDaedra(summoner, dayOfYear, state, rng = Math.random) {
  if (summoner.kind === 'coven') {
    if (summoner.glenmoril) return { ...DAEDRA[0], index: 0 };
    if (state.covenDay !== dayOfYear || !(state.covenIndex >= 1 && state.covenIndex < DAEDRA.length)) {
      state.covenIndex = 1 + Math.floor(rng() * (DAEDRA.length - 1));
      state.covenDay = dayOfYear;
    }
    return { ...DAEDRA[state.covenIndex], index: state.covenIndex };
  }
  const i = DAEDRA.findIndex((d) => d.dayOfYear === dayOfYear);
  return i < 0 ? null : { ...DAEDRA[i], index: i };
}

/** Day-of-year of every summoning (for players' research and the coverage report). */
export const summoningDays = () => DAEDRA.map((d) => ({ name: d.name, dayOfYear: d.dayOfYear, quest: d.quest }));

/**
 * ConfirmSummon_OnButtonClick after payment: Sheogorath's chance to stand in, the weather bonus and the roll.
 * Returns {daedra, chance, sheoChance, roll, success}. Dice100.Roll() is 1..100.
 */
export function rollSummoning(daedra, { weatherType, daedraRep, rng = Math.random }) {
  const storming = weatherType === 'thunder';
  const sheoChance = storming ? 15 : 5;
  const d100 = () => 1 + Math.floor(rng() * 100);
  let who = daedra;
  if (d100() <= sheoChance) who = { ...DAEDRA[SHEOGORATH_INDEX], index: SHEOGORATH_INDEX };
  const bonus = weatherBonus(who, weatherType);
  const chance = summoningChance(daedraRep(who.factionId), bonus);
  const roll = d100();
  return { daedra: who, chance, sheoChance, bonus, roll, success: roll <= chance };
}
