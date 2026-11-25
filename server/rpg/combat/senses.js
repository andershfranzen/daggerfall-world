// Classic rules from Daggerfall Unity (MIT, see THIRD_PARTY_NOTICES.txt):
// EnemySenses, EnemyMotor and FormulaHelper. Distances use MeshReader.GlobalScale.

export const CLASSIC_UNIT = 0.025;
export const SIGHT_RANGE = 4096 * CLASSIC_UNIT;
export const HEARING_RANGE = 25;
export const STEALTH_RANGE = 1024 * CLASSIC_UNIT;
export const PURSUIT_SECONDS = 200 / 16;

const LANGUAGES = new Map([
  [1, 'Impish'], [2, 'Spriggan'], [7, 'Orcish'], [8, 'Centaurian'], [12, 'Orcish'], [13, 'Harpy'],
  [10, 'Nymph'], [16, 'Giantish'], [21, 'Orcish'], [22, 'Giantish'], [24, 'Orcish'],
  [25, 'Daedric'], [26, 'Daedric'], [27, 'Daedric'], [28, 'Etiquette'], [29, 'Daedric'],
  [30, 'Etiquette'], [31, 'Daedric'], [32, 'Etiquette'], [33, 'Etiquette'], [34, 'Dragonish'],
  [40, 'Dragonish'], [41, 'Impish'], [42, 'Nymph'],
]);

export function enemyLanguage(enemy) {
  return enemy.human ? 'Etiquette' : LANGUAGES.get(enemy.id);
}

export function pacificationChance(language, skill, personality, sheathed, magicBonus = 0) {
  const chance = language === 'Etiquette' || language === 'Streetwise'
    ? Math.trunc(skill / 10) + Math.trunc(personality / 5)
    : skill + Math.trunc(personality / 10);
  return (chance + (sheathed ? 10 : -25) + magicBonus) / 200;
}

export function stealthChance(distance, skill) {
  return Math.min(1, 2 * Math.floor(Math.trunc(distance / CLASSIC_UNIT) * skill / 1024) / 100);
}

export const classicEnemySpeed = (speed) => (150 + speed) * CLASSIC_UNIT;
