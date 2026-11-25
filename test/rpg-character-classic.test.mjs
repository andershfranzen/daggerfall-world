// Classic questionnaire and biography: parsers, rules and server application.
// All fixtures below are synthetic stand-ins written for these tests; no game text is used or shipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as K from '../client/gameplay/character/classic.js';
import * as R from '../client/gameplay/character/rules.js';
import { CharacterDraft } from '../client/gameplay/character/draft.js';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as character from '../server/rpg/character.js';

/** Builds a TEXT.RSC image: { id: 'text' | ['variant', ...] }. '\n' becomes the NewLine byte. */
function textRsc(records) {
  const ids = Object.keys(records).map(Number).sort((a, b) => a - b);
  const bodies = ids.map((id) => {
    const v = [].concat(records[id]);
    const out = [];
    v.forEach((t, i) => {
      if (i) out.push(0xff);
      for (const ch of t) out.push(ch === '\n' ? 0x00 : ch.charCodeAt(0));
    });
    out.push(0xfe);
    return out;
  });
  const headerLength = (ids.length + 1) * 6;
  const bytes = [];
  const u16 = (n) => bytes.push(n & 0xff, (n >> 8) & 0xff);
  const u32 = (n) => bytes.push(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff);
  u16(headerLength);
  let offset = 2 + ids.length * 6;
  ids.forEach((id, i) => { u16(id); u32(offset); offset += bodies[i].length; });
  for (const b of bodies) bytes.push(...b);
  return new Uint8Array(bytes);
}

// Forty synthetic questions; #7 starts its first answer mid-line, as two classic records do.
function questionRecord() {
  let t = '';
  for (let n = 1; n <= 40; n++) {
    if (n === 7) {
      t += ` {${n}.   Synthetic prompt seven continues\n    here and then: a)  first answer\n    wraps b)  second answer\n c)  third answer\n`;
    } else {
      t += `${n === 1 ? '{' : ' {'}${n}.   Synthetic prompt ${n}\n    second line\n a) alpha ${n}\n    more alpha\n b) beta ${n}\n c) gamma ${n}\n`;
    }
  }
  return t;
}

/**
 * CLASSES.DAT: 18 header bytes, then 66 (warrior, rogue, mage) result triples; slot / 4 picks the header.
 * Headers 0-3 hold full class numbers (Warrior 16, Knight 17 live there); later headers keep the class in
 * the low nibble with junk above it, which the reader must mask.
 */
function classesDat(entries) {
  const d = new Uint8Array(18 + 66 * 3).fill(0xee);
  d.set([16, 17, 0, 1], 0);
  for (let h = 4; h < 18; h++) d[h] = 0xa0 | (h & 0x0f);
  entries.forEach(([weights, slot]) => d.set(weights, 18 + slot * 3));
  return d;
}

// Twelve synthetic biography questions with every effect kind.
function biogText() {
  const q = [];
  q.push('#4500\r\n1.\tSynthetic first question\r\n\tsecond line?\r\na.\tFirst\r\n\t#4600\r\n\t!4601\r\n\t28 +5\r\n\tIT 3 7 1\r\nb.\tSecond\r\n\t29 +3\r\n\tGP +25\r\n');
  q.push('2.\tSecond question\r\na.\tA\r\n\tr0 4\r\n\tr4 -2\r\n\trf201 7\r\nb.\tB\r\n\tMR 10\r\n\tTH 3\r\n\tAE 1\r\n');
  for (let n = 3; n <= 12; n++) q.push(`${n}.\tQuestion ${n}\r\na.\tYes\r\n\tIT 14 0 0\r\nb.\tNo\r\n\tIT 7 0 0\r\nc.\tMaybe\r\n\tGP - 5\r\n`);
  return q.join('\r\n');
}

test('TEXT.RSC records, variants and control bytes', () => {
  const rsc = K.parseTextRsc(textRsc({ 10: 'one\ntwo', 11: ['x', 'y', 'z'] }));
  assert.equal(rsc.size, 2);
  assert.equal(rsc.text(10), 'one\ntwo');
  assert.deepEqual(rsc.variants(11), ['x', 'y', 'z']);
  assert.equal(rsc.text(11, 0.99), 'z');
  assert.equal(rsc.variants(12), null);
  assert.throws(() => K.parseTextRsc(new Uint8Array(3)), /TEXT\.RSC/);
});

test('class questions: all forty, numbered, three answers each, mid-line answers split', () => {
  const rsc = K.parseTextRsc(textRsc({ [K.CLASS_QUESTIONS_RECORD]: questionRecord() }));
  const qs = K.parseClassQuestions(rsc.text(K.CLASS_QUESTIONS_RECORD));
  assert.equal(qs.length, 40);
  assert.ok(qs.every((q, i) => q.number === i + 1 && q.answers.length === 3));
  assert.equal(qs[0].prompt, 'Synthetic prompt 1 second line');
  assert.equal(qs[0].answers[0].text, 'alpha 1 more alpha');
  assert.equal(qs[6].prompt, 'Synthetic prompt seven continues here and then:');
  assert.deepEqual(qs[6].answers.map((a) => a.text), ['first answer wraps', 'second answer', 'third answer']);
});

test('questionnaire: ten distinct questions, DFU answer table, CLASSES.DAT lookup with nibble mask', () => {
  let i = 0;
  const picks = K.pickClassQuestions(40, () => [0.5, 0.5, 0.5, 0.1][i++ % 4]);
  assert.equal(picks.length, 10);
  assert.equal(new Set(picks).size, 10, 'collisions step to the next free question');
  // Question 1: a → warrior, b → mage, c → rogue (answerTable row 0 is 0,2,1).
  assert.deepEqual(K.classQuizWeights([[0, 0], [0, 1], [0, 2]]), [1, 1, 1]);
  assert.deepEqual(K.classQuizWeights([[3, 0]]), [0, 0, 1]);
  assert.throws(() => K.classQuizWeights([[40, 0]]), /Invalid/);
  const dat = classesDat([[[10, 0, 0], 1], [[0, 0, 10], 9], [[0, 10, 0], 41]]); // headers 0, 2, 10
  assert.equal(R.CLASSES[K.classIndexFromClassesDat(dat, [10, 0, 0])].name, 'Warrior');
  assert.equal(R.CLASSES[K.classIndexFromClassesDat(dat, [0, 0, 10])].name, 'Mage');
  assert.equal(R.CLASSES[K.classIndexFromClassesDat(dat, [0, 10, 0])].name, 'Thief');
  assert.equal(K.classIndexFromClassesDat(dat, [3, 3, 4]), -1);
});

test('draft questionnaire flow picks the class from the player\'s files', () => {
  const rsc = K.parseTextRsc(textRsc({ [K.CLASS_QUESTIONS_RECORD]: questionRecord(), 2116: 'Synthetic warrior description.' }));
  const classic = { rsc, classQuestions: K.parseClassQuestions(rsc.text(K.CLASS_QUESTIONS_RECORD)), classesDat: null, biogs: new Map() };
  const d = new CharacterDraft('Guest');
  d.race = 'Nord'; d.next(); d.gender = 'Male'; d.next();
  d.setMode('questions');
  assert.match(d.stepProblem(), /needs TEXT\.RSC and CLASSES\.DAT/, 'no invented fallback');
  d.classic = classic;
  assert.equal(d.quizAvailable(), false);
  // All 66 ten-answer weight triples, one per result slot, as the real table has.
  const triples = [];
  for (let w = 0; w <= 10; w++) for (let r = 0; r + w <= 10; r++) triples.push([[w, r, 10 - w - r], triples.length]);
  classic.classesDat = classesDat(triples);
  d.setMode('list'); d.setMode('questions', () => 0.3);
  assert.ok(d.quizAvailable());
  assert.equal(d.quiz.indices.length, 10);
  for (let n = 0; n < 10; n++) {
    assert.ok(d.quizQuestion().prompt.startsWith('Synthetic prompt'));
    assert.ok(d.answerQuiz(n % 3));
  }
  assert.equal(d.quizQuestion(), null);
  assert.equal(d.quiz.weights.reduce((a, b) => a + b), 10);
  assert.equal(d.className, R.CLASSES[K.classIndexFromClassesDat(classic.classesDat, d.quiz.weights)].name);
  d.className = 'Warrior'; // description lookup below
  assert.equal(d.classDescription(), 'Synthetic warrior description.');
  assert.equal(d.stepProblem('class'), null);
  assert.equal(d.answerQuiz(0), false, 'finished');
});

test('BIOG parsing, effects digest and backstory macros', () => {
  const biog = K.parseBiog(biogText(), 16);
  assert.equal(biog.backstoryId, 4500);
  assert.equal(biog.questions.length, 12);
  assert.deepEqual(biog.questions[0].text, ['Synthetic first question', 'second line?']);
  assert.deepEqual(biog.questions[0].answers[0].effects, ['#4600', '!4601', '28 +5', 'IT 3 7 1']);
  assert.throws(() => K.checkBiogAnswers(biog, [0]), /every biography question/);
  assert.throws(() => K.checkBiogAnswers(biog, [5, ...Array(11).fill(0)]), /question 1/);
  const answers = [0, 0, ...Array(10).fill(0)];
  const effects = K.biogEffects(biog, answers);
  assert.ok(effects.includes('#4600 0') && effects.includes('!4601 0'), 'text macros tagged with their question');
  const d = K.digestBiogEffects(effects);
  assert.deepEqual(d.skills, { 'Short Blade': 5 });
  assert.deepEqual(d.socialGroups, [4, 0, 0, 0, -2]);
  assert.deepEqual(d.factions, { 201: 7 });
  assert.equal(d.items.length, 11);
  assert.deepEqual(d.items[0], { group: 3, index: 7, material: 1 });
  assert.deepEqual(d.tokens[0], [4600, 4601]);
  const d2 = K.digestBiogEffects(K.biogEffects(biog, [1, 1, ...Array(10).fill(2)]));
  assert.equal(d2.gold, 0, 'GP losses floor at zero');
  assert.deepEqual(d2.mods, { resistMagic: 10, avoidHit: 3 });
  assert.deepEqual(d2.ignored, ['AE 1']);
  const rsc = K.parseTextRsc(textRsc({
    4500: 'A %ra from %hpn (%hpw). You loved %q1 and %q1a.\nCommoners %r1, Underworld %r5. %bn %zz',
    4600: ['first token', 'other variant'], 4601: 'second token',
  }));
  const lines = K.backstoryLines(rsc, biog, d, { race: 'Nord', pick: () => 0 });
  assert.deepEqual(lines, ['A Nord from Skyrim (mountains). You loved first token and second token. Commoners higher, Underworld lower. a stranger %zz'], 'wrapped lines join into one paragraph');
  const two = K.parseTextRsc(textRsc({ 4500: 'one\ntwo\n \nthree' }));
  assert.deepEqual(K.backstoryLines(two, biog, d, {}), ['one two', 'three']);
});

test('custom classes use the classic affinity rule to choose a biography', () => {
  const custom = { custom: true, primarySkills: ['Axe', 'Long Blade', 'Blunt Weapon'], majorSkills: ['Archery', 'Dodging', 'Hand-to-Hand'], minorSkills: ['Critical Strike', 'Giantish', 'Jumping', 'Orcish', 'Running', 'Swimming'] };
  assert.equal(R.CLASSES[K.biogClassIndex(custom)].name, 'Warrior');
  assert.equal(K.biogClassIndex(R.CLASS_BY_NAME.Mage), 0);
});

// ------------------------------------------------------------------ server

function harness({ services = {} } = {}) {
  const rsc = K.parseTextRsc(textRsc({ 4500: `Story of a %ra: %q1.${' Long line of a synthetic paragraph.\n'.repeat(12)}`, 4600: 'synthetic token', 4601: 'second' }));
  const biog = K.parseBiog(biogText(), 16);
  const players = new Map();
  const saved = new Map();
  let clock = 0;
  const given = [];
  const rep = {};
  const rt = createRpgRuntime({
    players,
    features: [{
      name: 'character',
      install: (ctx) => {
        ctx.classicData = { rsc, biogs: new Map([[16, biog]]) };
        Object.assign(ctx.services, {
          giveItem: (p, t, q = 1) => { given.push([t, q]); return { template: t, quantity: q }; },
          reputation: (p, id) => rep[id] ?? 0,
          adjustReputation: (p, id, d) => (id === 201 ? (rep[id] = (rep[id] ?? 0) + d) : rep[id] ?? 0),
          ...services,
        });
        return character.install(ctx);
      },
    }],
    save: (list) => { for (const p of list) saved.set(p.id, JSON.parse(JSON.stringify(p.rpg))); },
    send: () => {},
    now: () => (clock += 1000),
    log: { error() {}, warn() {}, info() {} },
  });
  const p = { id: 1, name: 'Hero', x: 0, z: 0, yaw: 0, moving: false, rpg: {} };
  players.set(1, p);
  rt.join(p);
  return { rt, p, saved, given, rep, biog, rsc };
}

function roll(h) {
  assert.deepEqual(h.rt.act(h.p, 'character.roll', { className: 'Warrior' }), { ok: true });
  const d = h.p.rpg.character.draft;
  const skills = { ...d.skillBase };
  for (const [, list] of R.groupsOf(d.career)) R.spendLowest(skills, list, 6);
  const attributes = R.spendLowest({ ...d.attributeBase }, R.ATTRIBUTES, d.bonusPool);
  return { name: 'Hero', race: 'Nord', gender: 'Male', attributes, skills };
}

test('server applies the chosen biography: skills, gold, items, reputation, modifiers, story', () => {
  const h = harness();
  assert.equal(h.p.rpg.character.classicData.biography, true, 'the client is told biography is live');
  const req = roll(h);
  const answers = [0, 0, ...Array(10).fill(0)];
  assert.deepEqual(h.rt.act(h.p, 'character.create', { ...req, biography: { answers } }), { ok: true });
  const ch = h.p.rpg.character;
  assert.equal(ch.skills['Short Blade'], Math.min(100, req.skills['Short Blade'] + 5), 'bonus on top of the spend');
  assert.equal(ch.startingLevelUpSkillSum, R.levelUpSkillSum(ch.skills, ch.career), 'level sum includes bonuses');
  const b = ch.biography;
  assert.deepEqual(b.answers, answers);
  assert.deepEqual(b.socialGroups, [4, 0, 0, 0, -2]);
  assert.deepEqual(b.factions, { 201: 7 });
  assert.equal(h.rep[201], 7);
  // IT 3 7 1 → steel longsword (template 120); IT 14 0 0 → ruby; IT 7 0 0 (books) has no counterpart.
  assert.deepEqual(h.given.map(([t]) => t).sort(), ['ruby', 'ruby', 'ruby', 'ruby', 'ruby', 'ruby', 'ruby', 'ruby', 'ruby', 'ruby', 'steel-longsword'].sort());
  assert.equal(b.items.find((i) => i.group === 3).template, 'steel-longsword');
  assert.equal(b.backstory.length, 1);
  assert.ok(b.backstory[0].startsWith('Story of a Nord: synthetic token. Long line'));
  assert.ok(b.backstory[0].length > 400, 'long paragraphs survive intact');
  assert.deepEqual(h.rt.ctx.services.socialReputation(h.p, 0), 4);
  assert.deepEqual(h.saved.get(1).character.biography, b, 'persisted in the create transaction');
});

test('server rejects forged answers, chooses at random when asked, and sanitises saved rows', () => {
  const h = harness();
  const req = roll(h);
  assert.match(h.rt.act(h.p, 'character.create', { ...req, biography: { answers: [9, ...Array(11).fill(0)] } }).error, /biography question 1/);
  assert.match(h.rt.act(h.p, 'character.create', { ...req, biography: { answers: [0] } }).error, /every biography question/);
  assert.match(h.rt.act(h.p, 'character.create', { ...req, biography: 'all of it' }).error, /let fate decide/);
  assert.equal(h.p.rpg.character.created, false, 'nothing changed');
  assert.deepEqual(h.given, []);
  assert.deepEqual(h.rt.act(h.p, 'character.create', { ...req, biography: { random: true } }), { ok: true });
  const b = h.p.rpg.character.biography;
  assert.equal(b.answers.length, 12);
  assert.ok(b.answers.every((a, i) => a < h.biog.questions[i].answers.length));
  // A tampered row is clamped on load; nothing in it is re-applied.
  const row = structuredClone(h.saved.get(1));
  row.character.biography.socialGroups = [9999, 0, 0, 0, 0];
  row.character.biography.mods = { avoidHit: 500, flying: 3 };
  const h2 = harness();
  const q = { id: 1, name: 'Hero', x: 0, z: 0, yaw: 0, moving: false, rpg: row };
  h2.rt.ctx.players.set(1, q);
  h2.rt.join(q);
  assert.equal(q.rpg.character.biography.socialGroups[0], 100);
  assert.deepEqual(q.rpg.character.biography.mods, { avoidHit: 100 });
  assert.deepEqual(h2.given, []);
});

test('without classic data the server ignores biography requests and says so', () => {
  const players = new Map();
  const rt = createRpgRuntime({ players, features: [{ name: 'character', install: (ctx) => { ctx.classicData = null; return character.install(ctx); } }], save() {}, send() {}, now: (() => { let c = 0; return () => (c += 1000); })(), log: { error() {}, warn() {}, info() {} } });
  const p = { id: 2, name: 'Hero', x: 0, z: 0, yaw: 0, moving: false, rpg: {} };
  players.set(2, p);
  rt.join(p);
  assert.equal(p.rpg.character.classicData.biography, false);
  const req = roll({ rt, p });
  assert.deepEqual(rt.act(p, 'character.create', { ...req, biography: { answers: [0] } }), { ok: true });
  assert.equal(p.rpg.character.biography, null);
});

test('draft biography flow previews exactly what the server will apply', () => {
  const h = harness();
  const d = new CharacterDraft('Hero');
  d.classic = { rsc: h.rsc, classQuestions: [], classesDat: null, biogs: h.rt.ctx.classicData.biogs };
  d.serverBiography = true;
  d.race = 'Nord'; d.next(); d.gender = 'Male'; d.next(); d.chooseClass('Warrior'); d.next();
  assert.equal(d.step, 'biography');
  assert.match(d.stepProblem(), /let fate decide/);
  d.chooseBioMode('answer');
  for (let i = 0; i < 12; i++) {
    assert.match(d.stepProblem(), /Answer every biography question/);
    assert.ok(d.answerBio(0));
  }
  d.undoBio();
  assert.ok(d.answerBio(0));
  assert.equal(d.stepProblem(), null);
  assert.equal(d.bioSkillBonus('Short Blade'), 5);
  assert.ok(d.backstory()[0].startsWith('Story of a Nord: synthetic token.'));
  d.chooseClass('Mage');
  d.syncBio();
  assert.equal(d.bioMode, null, 'a different class resets the biography');
  assert.equal(d.bioAvailable(), false, 'no BIOG for that class here: step passes through');
  d.chooseClass('Warrior');
  d.chooseBioMode('random', () => 0.99);
  assert.equal(d.bioAnswers.length, 12);
  d.next(); d.name = 'Hero'; d.next(); d.next();
  h.rt.act(h.p, 'character.roll', d.rollRequest());
  d.syncRoll(h.p.rpg.character.draft);
  d.autoDistribute(); d.next(); d.next(); d.next();
  assert.equal(d.finalProblem(), null);
  const request = d.createRequest();
  assert.deepEqual(request.biography, { answers: d.bioAnswers });
  assert.deepEqual(h.rt.act(h.p, 'character.create', request), { ok: true });
  assert.deepEqual(h.p.rpg.character.biography.backstory, d.backstory(), 'preview and server agree');
});
