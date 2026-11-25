// DOM-free model behind the creation wizard and the level-up screen. Mirrors the classic spinners
// (StatsRollout / SkillsRollout / CreateCharCustomClass) on top of rules.js so the browser can pre-validate
// with the exact rules the server will apply. The server remains the authority.

import * as R from './rules.js';
import * as K from './classic.js';

export const STEPS = Object.freeze(['race', 'gender', 'class', 'biography', 'name', 'face', 'attributes', 'skills', 'reflexes', 'summary']);
export const STEP_TITLES = Object.freeze({
  race: 'Choose your race', gender: 'Choose your gender', class: 'Choose your class', biography: 'Your biography', name: 'Name your character',
  face: 'Choose your face', attributes: 'Distribute attribute points', skills: 'Distribute skill points',
  reflexes: 'Choose your reflexes', summary: 'Review your character',
});

export function blankCustom() {
  return {
    name: '',
    hitPointsPerLevel: R.CUSTOM.defaultHp,
    attributes: Object.fromEntries(R.ATTRIBUTES.map((a) => [a, R.CUSTOM.statDefault])),
    primarySkills: [], majorSkills: [], minorSkills: [],
    advantages: [], disadvantages: [],
  };
}

const GROUP_FIELD = { primary: 'primarySkills', major: 'majorSkills', minor: 'minorSkills' };
const GROUP_SIZE = { primary: 3, major: 3, minor: 6 };

export class CharacterDraft {
  constructor(defaultName = '') {
    this.step = 'race';
    this.race = null;
    this.gender = null;
    this.classMode = 'list'; // list | questions | custom
    this.className = null;
    this.quiz = null; // { indices:[10 question numbers − 1], answers:[0..2], classIndex, weights }
    this.custom = blankCustom();
    this.classic = null; // { rsc, classQuestions, classesDat, biogs: Map } from the player's ARENA2 files
    this.serverBiography = false; // the server has BIOG data and will apply effects
    this.bioMode = null; // null | 'answer' | 'random'
    this.bioAnswers = [];
    this.bioKey = null;
    this.name = defaultName;
    this.faceIndex = 0;
    this.reflexes = 'Average';
    this.roll = null; // server draft we are spending
    this.rollKey = '';
    this.attributes = null;
    this.skills = null;
    this.pending = false; // waiting for the server to roll
    this.localCareers = null; // Map name → career parsed from the player's CLASS*.CFG (display only)
  }

  // ------------------------------------------------------------ navigation

  get stepIndex() { return STEPS.indexOf(this.step); }

  /** Problem that blocks leaving the current step, or null. */
  stepProblem(step = this.step) {
    switch (step) {
      case 'race': return this.race ? null : 'Choose a race.';
      case 'gender': return this.gender ? null : 'Choose a gender.';
      case 'class':
        if (this.classMode === 'custom') return this.customProblem();
        if (this.classMode === 'questions') {
          if (!this.quizAvailable()) return 'The questionnaire needs TEXT.RSC and CLASSES.DAT from your game files.';
          if (!this.quiz || this.quiz.classIndex == null) return 'Answer every question.';
        }
        return this.className ? null : 'Choose a class.';
      case 'biography': {
        if (!this.bioAvailable()) return null; // nothing to answer without the files on both sides
        this.syncBio();
        if (!this.bioMode) return 'Answer the questions or let fate decide.';
        if (this.bioAnswers.length < this.biog().questions.length) return 'Answer every biography question.';
        return null;
      }
      case 'name': return R.cleanCharacterName(this.name) ? null : 'Enter a name using letters, spaces, apostrophes or hyphens (up to 24).';
      case 'face': return null;
      case 'attributes':
        if (!this.roll) return 'Waiting for your attribute roll…';
        return this.attributePoolLeft() === 0 ? null : `Distribute all bonus points (${this.attributePoolLeft()} left).`;
      case 'skills': {
        if (!this.roll) return 'Waiting for your skill roll…';
        for (const g of ['primary', 'major', 'minor']) {
          const left = this.skillPoolLeft(g);
          if (left) return `Distribute all ${g} skill points (${left} left).`;
        }
        return null;
      }
      case 'reflexes': return R.REFLEXES.includes(this.reflexes) ? null : 'Choose your reflexes.';
      case 'summary': return this.finalProblem();
      default: return null;
    }
  }

  canAdvance() { return this.stepProblem() === null; }

  next() {
    if (!this.canAdvance()) return false;
    const i = this.stepIndex;
    if (i < STEPS.length - 1) this.step = STEPS[i + 1];
    return true;
  }

  back() {
    const i = this.stepIndex;
    if (i > 0) this.step = STEPS[i - 1];
  }

  goTo(step) {
    // Only allow jumping to steps whose predecessors are complete.
    const target = STEPS.indexOf(step);
    for (let i = 0; i < target; i++) if (this.stepProblem(STEPS[i])) return false;
    this.step = step;
    return true;
  }

  // ------------------------------------------------------------ class

  /**
   * The career every spend is checked against. Once rolled, it is the server's authoritative view
   * (`draft.career`: built-in ruleset, the operator's CLASS*.CFG, or the validated custom class);
   * before that, the best local preview (`localCareers` from the player's own CLASS*.CFG, else built-in).
   */
  career() {
    if (this.roll?.career) return this.roll.career;
    if (this.roll?.custom) return this.roll.custom;
    if (this.classMode === 'custom') {
      try { return R.buildCustomClass(this.custom); } catch { return null; }
    }
    return this.localCareers?.get(this.className) ?? R.CLASS_BY_NAME[this.className] ?? null;
  }

  chooseClass(name) {
    if (!R.CLASS_BY_NAME[name]) return;
    if (this.className !== name || this.classMode === 'custom') this.invalidateRoll();
    this.className = name;
  }

  setMode(mode, rng = Math.random) {
    if (!['list', 'questions', 'custom'].includes(mode) || mode === this.classMode) return;
    this.classMode = mode;
    this.invalidateRoll();
    if (mode === 'questions') this.startQuiz(rng);
  }

  // ------------------------------------------------------------ classic class questionnaire

  quizAvailable() {
    return !!(this.classic?.classQuestions?.length === 40 && this.classic.classesDat);
  }

  /** CreateCharClassQuestions: ten distinct questions out of forty. */
  startQuiz(rng = Math.random) {
    this.quiz = this.quizAvailable() ? { indices: K.pickClassQuestions(40, rng), answers: [], classIndex: null, weights: null } : null;
    if (this.classMode === 'questions') this.className = null;
  }

  /** The current question as parsed from TEXT.RSC, or null when finished/unavailable. */
  quizQuestion() {
    const q = this.quiz;
    if (!q || q.answers.length >= q.indices.length) return null;
    return this.classic.classQuestions[q.indices[q.answers.length]];
  }

  answerQuiz(choice) {
    const q = this.quiz;
    if (!q || q.classIndex != null || ![0, 1, 2].includes(choice)) return false;
    q.answers.push(choice);
    if (q.answers.length === q.indices.length) {
      q.weights = K.classQuizWeights(q.indices.map((qi, i) => [qi, q.answers[i]]));
      q.classIndex = K.classIndexFromClassesDat(this.classic.classesDat, q.weights);
      if (q.classIndex < 0) { q.classIndex = null; return false; }
      this.className = R.CLASSES[q.classIndex].name;
      this.invalidateRoll();
    }
    return true;
  }

  /** Classic class description (TEXT.RSC 2100 + class index) when the player's files are loaded. */
  classDescription(name = this.className) {
    const i = R.CLASSES.findIndex((c) => c.name === name);
    if (i < 0 || !this.classic?.rsc) return null;
    return this.classic.rsc.text(K.CLASS_DESCRIPTIONS_RECORD + i);
  }

  // ------------------------------------------------------------ classic biography

  careerList() {
    return R.CLASSES.map((c) => this.localCareers?.get(c.name) ?? c);
  }

  biogClassIndex() {
    const c = this.career();
    return c ? K.biogClassIndex(c, this.careerList()) : null;
  }

  biog() {
    const i = this.biogClassIndex();
    return i == null ? null : this.classic?.biogs?.get(i) ?? null;
  }

  /** The biography applies only when both the player (to read it) and the server (to apply it) have it. */
  bioAvailable() {
    return !!(this.serverBiography && this.biog());
  }

  /** A different class means a different BIOG file: start over. */
  syncBio() {
    const key = this.biogClassIndex();
    if (key !== this.bioKey) {
      this.bioKey = key;
      this.bioMode = null;
      this.bioAnswers = [];
    }
  }

  chooseBioMode(mode, rng = Math.random) {
    if (!this.bioAvailable()) return;
    this.syncBio();
    this.bioMode = mode === 'random' ? 'random' : 'answer';
    this.bioAnswers = mode === 'random' ? K.randomBiogAnswers(this.biog(), rng) : [];
  }

  bioQuestion() {
    const b = this.biog();
    if (!b || this.bioMode !== 'answer' || this.bioAnswers.length >= b.questions.length) return null;
    return b.questions[this.bioAnswers.length];
  }

  answerBio(choice) {
    const q = this.bioQuestion();
    if (!q || !Number.isInteger(choice) || choice < 0 || choice >= q.answers.length) return false;
    this.bioAnswers.push(choice);
    return true;
  }

  undoBio() {
    if (this.bioMode === 'answer' && this.bioAnswers.length) this.bioAnswers.pop();
  }

  /** What the chosen answers do (null until complete). */
  bioDigest() {
    const b = this.biog();
    if (!this.bioAvailable() || !b || this.bioAnswers.length !== b.questions.length) return null;
    return K.digestBiogEffects(K.biogEffects(b, this.bioAnswers));
  }

  bioSkillBonus(skill) {
    return this.bioDigest()?.skills[skill] ?? 0;
  }

  /** Backstory preview, seeded exactly as the server seeds it. */
  backstory() {
    const d = this.bioDigest();
    if (!d || !this.classic?.rsc) return [];
    const r = K.seededRandom(`${this.race}:${this.bioAnswers.join('')}`);
    return K.backstoryLines(this.classic.rsc, this.biog(), d, { race: this.race, pick: (n) => Math.floor(r() * n) });
  }

  /** Request to send to the server for the current class choice. */
  rollRequest() {
    return this.classMode === 'custom' ? { custom: structuredClone(this.custom) } : { className: this.className };
  }

  invalidateRoll() {
    this.roll = null;
    this.rollKey = '';
    this.attributes = null;
    this.skills = null;
  }

  /** Adopt the server's latest roll. Resets working values only when the roll itself changed. */
  syncRoll(serverDraft) {
    if (!serverDraft) return;
    const key = JSON.stringify([serverDraft.className, serverDraft.rolls, serverDraft.attributeBase, serverDraft.bonusPool, serverDraft.skillBase]);
    if (key === this.rollKey) return;
    const wanted = this.classMode === 'custom' ? R.cleanCharacterName(this.custom.name, 16) : this.className;
    if (wanted && serverDraft.className !== wanted) return; // a stale roll for another class
    this.roll = serverDraft;
    this.rollKey = key;
    this.attributes = { ...serverDraft.attributeBase };
    this.skills = { ...serverDraft.skillBase };
    this.pending = false;
  }

  // ------------------------------------------------------------ attributes (StatsRollout)

  attributePoolLeft() {
    if (!this.roll) return 0;
    let spent = 0;
    for (const a of R.ATTRIBUTES) spent += this.attributes[a] - this.roll.attributeBase[a];
    return this.roll.bonusPool - spent;
  }

  attributeUp(a) {
    if (!this.roll || this.attributePoolLeft() <= 0 || this.attributes[a] >= R.MAX_STAT) return false;
    this.attributes[a] += 1;
    return true;
  }

  attributeDown(a) {
    if (!this.roll || this.attributes[a] <= this.roll.attributeBase[a]) return false;
    this.attributes[a] -= 1;
    return true;
  }

  // ------------------------------------------------------------ skills (SkillsRollout)

  skillPoolLeft(group) {
    const career = this.career();
    if (!this.roll || !career) return 0;
    let spent = 0;
    for (const s of career[GROUP_FIELD[group]]) spent += this.skills[s] - this.roll.skillBase[s];
    return R.SKILL_GROUP_POOL - spent;
  }

  skillUp(s) {
    const career = this.career();
    const g = career && R.skillGroupOf(career, s);
    if (!g || this.skillPoolLeft(g) <= 0 || this.skills[s] >= R.MAX_SKILL) return false;
    this.skills[s] += 1;
    return true;
  }

  skillDown(s) {
    const career = this.career();
    const g = career && R.skillGroupOf(career, s);
    if (!g || this.skills[s] <= this.roll.skillBase[s]) return false;
    this.skills[s] -= 1;
    return true;
  }

  /** Spend whatever is left, lowest value first (the reference port's headless policy). */
  autoDistribute(which = 'all') {
    const career = this.career();
    if (!this.roll || !career) return;
    if (which === 'all' || which === 'attributes') R.spendLowest(this.attributes, R.ATTRIBUTES, this.attributePoolLeft());
    if (which === 'all' || which === 'skills') {
      for (const g of ['primary', 'major', 'minor']) R.spendLowest(this.skills, career[GROUP_FIELD[g]], this.skillPoolLeft(g));
    }
  }

  // ------------------------------------------------------------ custom class (CreateCharCustomClass)

  customTotal() { return R.ATTRIBUTES.reduce((n, a) => n + this.custom.attributes[a], 0); }

  customAttribute(a, delta) {
    const v = this.custom.attributes[a] + delta;
    if (v < R.CUSTOM.statMin || v > R.CUSTOM.statMax) return false;
    this.custom.attributes[a] = v;
    this.invalidateRoll();
    return true;
  }

  customHp(delta) {
    const v = this.custom.hitPointsPerLevel + delta;
    if (v < R.CUSTOM.minHp || v > R.CUSTOM.maxHp) return false;
    this.custom.hitPointsPerLevel = v;
    this.invalidateRoll();
    return true;
  }

  customSkillGroup(skill) {
    for (const g of ['primary', 'major', 'minor']) if (this.custom[GROUP_FIELD[g]].includes(skill)) return g;
    return null;
  }

  /** Cycles a skill through none → primary → major → minor → none, skipping full groups. */
  cycleCustomSkill(skill) {
    if (!(skill in R.SKILL_INDEX)) return;
    const order = [null, 'primary', 'major', 'minor'];
    const cur = this.customSkillGroup(skill);
    if (cur) this.custom[GROUP_FIELD[cur]] = this.custom[GROUP_FIELD[cur]].filter((s) => s !== skill);
    let i = order.indexOf(cur);
    for (let n = 0; n < 4; n++) {
      i = (i + 1) % order.length;
      const g = order[i];
      if (g === null) break;
      if (this.custom[GROUP_FIELD[g]].length < GROUP_SIZE[g]) {
        this.custom[GROUP_FIELD[g]].push(skill);
        break;
      }
    }
    this.invalidateRoll();
  }

  toggleAbility(kind, key, option) {
    const list = this.custom[kind === 'advantage' ? 'advantages' : 'disadvantages'];
    const idx = list.findIndex((e) => e.key === key && (e.option ?? '') === (option ?? ''));
    if (idx >= 0) list.splice(idx, 1);
    else {
      // Mutually exclusive families replace the previous pick.
      const exclusive = ['increasedMagery', 'rapidHealing', 'regenerateHealth', 'spellAbsorption', 'darknessPoweredMagery', 'lightPoweredMagery'];
      if (exclusive.includes(key)) {
        const j = list.findIndex((e) => e.key === key);
        if (j >= 0) list.splice(j, 1);
      }
      list.push(option ? { key, option } : { key });
    }
    this.invalidateRoll();
  }

  customDifficulty() {
    try {
      return R.customDifficulty(this.custom.hitPointsPerLevel, this.custom.advantages, this.custom.disadvantages);
    } catch {
      return NaN;
    }
  }

  customProblem() {
    try {
      R.buildCustomClass(this.custom);
      return null;
    } catch (e) {
      return e.message;
    }
  }

  // ------------------------------------------------------------ final

  finalProblem() {
    for (const s of STEPS.slice(0, -1)) {
      const p = this.stepProblem(s);
      if (p) return p;
    }
    try {
      R.validateAttributeSpend(this.roll.attributeBase, this.roll.bonusPool, this.attributes);
      R.validateSkillSpend(this.roll.skillBase, this.career(), this.skills);
    } catch (e) {
      return e.message;
    }
    return null;
  }

  createRequest() {
    return {
      name: R.cleanCharacterName(this.name),
      race: this.race,
      gender: this.gender,
      faceIndex: this.faceIndex,
      reflexes: this.reflexes,
      attributes: { ...this.attributes },
      skills: { ...this.skills },
      ...(this.bioAvailable() && this.bioDigest() ? { biography: { answers: [...this.bioAnswers] } } : {}),
    };
  }

  /** Preview of the derived values the server will compute. */
  preview() {
    const career = this.career();
    if (!career || !this.attributes) return null;
    return {
      maxHealth: R.maxHealthAtLevel1(career),
      ...R.derivedMaxima(this.attributes, career),
    };
  }
}

/** Level-up distribution (DaggerfallCharacterSheetWindow leveling mode). */
export class LevelUpDraft {
  constructor(attributes, pool) {
    this.start = { ...attributes };
    this.attributes = { ...attributes };
    this.pool = pool;
  }
  left() { return this.pool - R.ATTRIBUTES.reduce((n, a) => n + this.attributes[a] - this.start[a], 0); }
  up(a) { if (this.left() > 0 && this.attributes[a] < R.MAX_STAT) { this.attributes[a]++; return true; } return false; }
  down(a) { if (this.attributes[a] > this.start[a]) { this.attributes[a]--; return true; } return false; }
  problem() {
    try { R.validateLevelSpend(this.start, this.pool, this.attributes); return null; } catch (e) { return e.message; }
  }
}
