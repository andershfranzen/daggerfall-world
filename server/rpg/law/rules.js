// Classic crime, legal reputation and court rules (package 14, docs/law.md).
//
// Numbers are references to the original game's tables as documented by Daggerfall Unity (MIT,
// (c) 2009-2023 Daggerfall Workshop) at revision 3d85a283672a4955e32992097ea7719e896dbadb:
//   PlayerEntity.Crimes / reputationLossPerCrime / ClampLegalReputations / SurrenderToCityGuards
//   DaggerfallCourtWindow (FALL.EXE 0x1B34E0 penalty tables, plea, debate/lie, rescue)
//   FormulaHelper.CalculateExteriorLockpickingChance / CalculatePickpocketingChance / CalculateShopliftingChance
//   PlayerActivate.GetBuildingLockValue (quality / 2) and Pickpocket (1..6 gold, 33% nothing)
// Pure functions only: every roll takes an injected `random()` in [0, 1).

/** Classic crime ids (PlayerEntity.Crimes), keyed by the protocol name used here. */
export const CRIMES = Object.freeze({
  attemptedBreakingAndEntering: 1,
  trespassing: 2,
  breakingAndEntering: 3,
  assault: 4,
  murder: 5,
  taxEvasion: 6,
  criminalConspiracy: 7,
  vagrancy: 8,
  smuggling: 9,
  piracy: 10,
  highTreason: 11,
  pickpocketing: 12,
  theft: 13,
  treason: 14,
  loanDefault: 15,
});

export const CRIME_LABELS = Object.freeze({
  attemptedBreakingAndEntering: 'attempted breaking and entering',
  trespassing: 'trespassing',
  breakingAndEntering: 'breaking and entering',
  assault: 'assault',
  murder: 'murder',
  taxEvasion: 'tax evasion',
  criminalConspiracy: 'criminal conspiracy',
  vagrancy: 'vagrancy',
  smuggling: 'smuggling',
  piracy: 'piracy',
  highTreason: 'high treason',
  pickpocketing: 'pickpocketing',
  theft: 'theft',
  treason: 'treason',
  loanDefault: 'defaulting on a loan',
});

// Index = crime id (0 = none). FALL.EXE values; Treason is half of High Treason in DFU.
const REP_LOSS = [0, 10, 5, 10, 8, 20, 10, 2, 1, 2, 2, 75, 2, 8, 36, 10];
// Index = crime id - 1.
const PENALTY_PER_REP = [5, 5, 6, 6, 10, 5, 5, 3, 8, 8, 9, 6, 0, 8, 0];
const BASE_PENALTY = [300, 200, 600, 1000, 10000, 200, 500, 100, 500, 500, 1200, 200, 200, 1000, 100];
const MIN_PENALTY = [50, 10, 80, 10, 9000, 10, 10, 2, 10, 10, 160, 5, 5, 10, 4];
const MAX_PENALTY = [1000, 800, 1200, 1500, 12000, 12000, 1500, 700, 1500, 1500, 2000, 1000, 1000, 1500, 700];

export const LEGAL_REP_MIN = -100;
export const LEGAL_REP_MAX = 100;
/** Classic: guards appear unprovoked (Criminal Conspiracy) below this legal reputation, 5% per game minute. */
export const CONSPIRACY_REP = -10;
/** Thieving crimes the Thieves Guild may get dropped (court window: crime index <= 2 or pickpocketing). */
export const THIEVING = new Set(['attemptedBreakingAndEntering', 'trespassing', 'breakingAndEntering', 'pickpocketing']);
export const VIOLENT = new Set(['assault', 'murder']);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const d100 = (random) => 1 + Math.floor(random() * 100);

export const crimeId = (crime) => CRIMES[crime] ?? 0;
export const isCrime = (crime) => Object.hasOwn(CRIMES, crime);
export const repLossFor = (crime) => REP_LOSS[crimeId(crime)] ?? 0;
export const clampLegalRep = (v) => clamp(Math.trunc(Number(v) || 0), LEGAL_REP_MIN, LEGAL_REP_MAX);

/** PlayerActivate.GetBuildingLockValue: building quality / 2. */
export const buildingLockValue = (quality) => Math.trunc((Number(quality) || 0) / 2);
/** FormulaHelper.CalculateExteriorLockpickingChance. Success when chance > d100. */
export const exteriorLockpickChance = (lock, skill) => clamp(skill - 5 * lock, 5, 95);
/** FormulaHelper.CalculatePickpocketingChance (townsperson: no level term). */
export const pickpocketChance = (skill, levelDelta = null) => clamp(skill + (levelDelta == null ? 0 : 5 * levelDelta), 5, 95);
/** FormulaHelper.CalculateShopliftingChance: the chance of being CAUGHT. */
export const shopliftCaughtChance = (pickpocketSkill, shopQuality, weightAndCount) =>
  clamp(100 - pickpocketSkill + (Number(shopQuality) || 0) + Math.trunc(weightAndCount), 5, 95);

/** PlayerActivate.Pickpocket on success: 67% 1..6 gold, else nothing of value. */
export function pickpocketLoot(random) {
  if (d100(random) <= 33) return 0;
  return 1 + Math.floor(random() * 6);
}

/**
 * PlayerEntity.SurrenderToCityGuards. `voluntary` = the player chose to surrender to a halt;
 * false = the guards beat the player down. Returns true when the player goes to court.
 */
export function goesToCourt(legalRep, voluntary, random) {
  if (legalRep < -20 && !voluntary) return false;
  if (legalRep < -20 || legalRep > 0) return true;
  if (!voluntary && random() < 0.5) return false;
  return true;
}

/**
 * DaggerfallCourtWindow state 0: the sentence the court would hand down for `crime` in a region where the
 * character has `legalRep`, with `gold` on hand. Returns {severe, fine, days}. `severe` is banishment
 * (classic never executes). A fine the character cannot pay turns into prison days (40 gold a day).
 */
export function sentenceFor(crime, legalRep, gold, random) {
  const i = crimeId(crime) - 1;
  if (i < 0) throw new Error(`unknown crime ${crime}`);
  let t1 = 0, t2 = 0;
  if (legalRep < 0) {
    t1 = Math.min(75, -legalRep);
    t2 = Math.min(75, Math.trunc(-legalRep / 2));
  }
  // Dice100.FailedRoll(t) = roll > t.
  const severe = !(d100(random) > t2 && d100(random) > t1);
  let penalty = legalRep >= 0 ? PENALTY_PER_REP[i] * legalRep + BASE_PENALTY[i] : BASE_PENALTY[i] - PENALTY_PER_REP[i] * legalRep;
  penalty = clamp(penalty, MIN_PENALTY[i], MAX_PENALTY[i]);
  const units = Math.trunc(penalty / 40);
  let fine = 0, days = 0;
  for (let n = 0; n < units; n++) {
    if (random() < 0.5) fine += 40;
    else days += 3;
  }
  if (gold < fine) {
    days += Math.trunc((fine - gold) / 40);
    fine = Math.max(0, gold);
  }
  return { severe, fine, days };
}

/** Guilty plea: classic halves both the fine and the prison term. */
export const guiltyPlea = ({ fine, days }) => ({ fine: fine >> 1, days: days >> 1 });

/**
 * Not-guilty plea defended by Etiquette ('debate') or Streetwise ('lie'): chance to go free is
 * legalRep + (skill + Personality) / 2, clamped 5..95. On conviction the fine may double (rep + d100 < 25)
 * or halve (> 75).
 */
export function defendChance(legalRep, skill, personality) {
  return clamp(legalRep + Math.trunc((skill + personality) / 2), 5, 95);
}
export function trial({ legalRep, skill, personality, sentence }, random) {
  const chance = defendChance(legalRep, skill, personality);
  if (d100(random) <= chance) return { free: true, chance, fine: 0, days: 0 };
  let { fine, days } = sentence;
  const roll = legalRep + d100(random);
  if (roll < 25) fine *= 2;
  else if (roll > 75) fine >>= 1;
  return { free: false, chance, fine, days };
}

/** Thieves Guild / Dark Brotherhood rescue: guild rank >= Random.Range(0, 20). */
export const guildRescues = (rank, random) => Number.isInteger(rank) && rank >= Math.floor(random() * 20);

/**
 * RaiseReputationForDoingSentence: legal reputation returns by (half the crime's loss - 1).
 * (Classic changes the people faction by the same over two.)
 */
export const sentenceRepair = (crime) => Math.trunc(repLossFor(crime) / 2) - 1;
