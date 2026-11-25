// DOM-free browser model for the character wizard and level-up screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../client/gameplay/character/rules.js';
import { CharacterDraft, LevelUpDraft, STEPS } from '../client/gameplay/character/draft.js';

const roll = (className, extra = {}) => {
  const career = extra.custom ?? R.CLASS_BY_NAME[className];
  let i = 0;
  const rng = () => ((i++ * 0.37) % 1);
  const a = R.rollAttributes(career, rng);
  const s = R.rollSkills(career, rng);
  return { className: career.name, custom: extra.custom ?? null, attributeBase: a.base, bonusPool: a.bonusPool, skillBase: s.base, rolls: extra.rolls ?? 1 };
};

function toAttributes(d) {
  d.race = 'Khajiit'; assert.ok(d.next());
  d.gender = 'Male'; assert.ok(d.next());
  d.chooseClass('Acrobat'); assert.ok(d.next());
  assert.equal(d.step, 'biography'); assert.ok(d.next());
  d.name = "J'zargo"; assert.ok(d.next());
  d.faceIndex = 7; assert.ok(d.next());
  assert.equal(d.step, 'attributes');
}

test('steps gate on their own problems and cannot be skipped', () => {
  const d = new CharacterDraft('Guest');
  assert.deepEqual(STEPS, ['race', 'gender', 'class', 'biography', 'name', 'face', 'attributes', 'skills', 'reflexes', 'summary']);
  assert.equal(d.next(), false);
  assert.equal(d.stepProblem(), 'Choose a race.');
  assert.equal(d.goTo('summary'), false);
  d.race = 'Breton';
  d.next();
  d.back();
  assert.equal(d.step, 'race');
  d.next();
  d.gender = 'Female'; d.next();
  d.chooseClass('Nobody');
  assert.equal(d.className, null);
  d.chooseClass('Mage'); d.next(); d.next();
  d.name = '   ';
  assert.match(d.stepProblem(), /Enter a name/);
  d.name = '<b>';
  assert.equal(d.next(), false);
});

test('attribute and skill spinners respect the rolled floors and pools', () => {
  const d = new CharacterDraft('Guest');
  toAttributes(d);
  assert.match(d.stepProblem(), /Waiting/);
  d.syncRoll(roll('Acrobat'));
  const base = d.roll.attributeBase;
  assert.equal(d.attributeDown('Speed'), false, 'cannot go below the roll');
  for (let i = 0; i < d.roll.bonusPool; i++) assert.ok(d.attributeUp('Speed') || base.Speed + i >= 100);
  assert.equal(d.attributePoolLeft(), Math.max(0, d.roll.bonusPool - (100 - base.Speed)) * (base.Speed + d.roll.bonusPool > 100 ? 1 : 0));
  d.autoDistribute('attributes');
  assert.equal(d.attributePoolLeft(), 0);
  assert.equal(d.attributeUp('Luck'), false);
  assert.ok(d.next());

  const career = R.CLASS_BY_NAME.Acrobat;
  assert.equal(d.skillUp('Swimming') && career.minorSkills.includes('Swimming'), true);
  assert.equal(d.skillUp('Medical'), false, 'not a class skill');
  assert.equal(d.skillDown(career.primarySkills[0]), false);
  for (let i = 0; i < 6; i++) d.skillUp(career.primarySkills[0]);
  assert.equal(d.skillPoolLeft('primary'), 0);
  assert.equal(d.skillUp(career.primarySkills[1]), false);
  d.autoDistribute('skills');
  assert.ok(d.next());
  d.reflexes = 'Very Low';
  assert.ok(d.next());
  assert.equal(d.finalProblem(), null);
  const req = d.createRequest();
  assert.equal(req.name, "J'zargo");
  // The request validates under the same rules the server uses.
  assert.doesNotThrow(() => R.validateAttributeSpend(d.roll.attributeBase, d.roll.bonusPool, req.attributes));
  assert.doesNotThrow(() => R.validateSkillSpend(d.roll.skillBase, career, req.skills));
  assert.ok(d.preview().maxMagicka >= 0);
});

test('stale or foreign rolls are ignored; a reroll resets working values', () => {
  const d = new CharacterDraft('Guest');
  toAttributes(d);
  d.syncRoll(roll('Warrior'));
  assert.equal(d.roll, null, 'roll for another class ignored');
  const r1 = roll('Acrobat');
  d.syncRoll(r1);
  d.attributeUp('Luck');
  d.syncRoll(structuredClone(r1));
  assert.equal(d.attributes.Luck, r1.attributeBase.Luck + 1, 'identical state does not reset spending');
  d.syncRoll({ ...r1, rolls: 2 });
  assert.equal(d.attributes.Luck, r1.attributeBase.Luck, 'a new roll resets spending');
  d.chooseClass('Bard');
  assert.equal(d.roll, null, 'changing class drops the roll');
});

test('custom class builder cycles skills, conserves the 400 attribute total and prices abilities', () => {
  const d = new CharacterDraft('Guest');
  d.setMode('custom');
  assert.match(d.customProblem(), /Name your class/);
  d.custom.name = 'Duelist';
  for (const s of ['Long Blade', 'Short Blade', 'Dodging']) d.cycleCustomSkill(s);
  assert.deepEqual(d.custom.primarySkills, ['Long Blade', 'Short Blade', 'Dodging']);
  d.cycleCustomSkill('Archery'); // primary full → major
  assert.deepEqual(d.custom.majorSkills, ['Archery']);
  d.cycleCustomSkill('Archery'); // → minor
  assert.deepEqual(d.custom.minorSkills, ['Archery']);
  d.cycleCustomSkill('Archery'); // → none
  assert.equal(d.customSkillGroup('Archery'), null);
  for (const s of ['Archery', 'Critical Strike', 'Running']) d.cycleCustomSkill(s);
  for (const s of ['Etiquette', 'Jumping', 'Climbing', 'Stealth', 'Medical', 'Axe']) d.cycleCustomSkill(s);
  assert.equal(d.customProblem(), null);
  assert.ok(d.customAttribute('Strength', 5));
  assert.match(d.customProblem(), /total 400 \(now 405\)/);
  d.customAttribute('Luck', -5);
  assert.equal(d.customProblem(), null);
  for (let i = 0; i < 40; i++) d.customAttribute('Speed', 1);
  assert.equal(d.custom.attributes.Speed, 75, 'free edit caps at 75');
  for (let i = 0; i < 25; i++) d.customAttribute('Speed', -1);
  d.toggleAbility('advantage', 'increasedMagery', '2x INT');
  d.toggleAbility('advantage', 'increasedMagery', '3x INT');
  assert.deepEqual(d.custom.advantages, [{ key: 'increasedMagery', option: '3x INT' }], 'exclusive family replaces');
  assert.equal(d.customDifficulty(), 10);
  d.customHp(30);
  assert.equal(d.custom.hitPointsPerLevel, 8, 'out-of-range hp change refused');
  for (let i = 0; i < 22; i++) d.customHp(1);
  assert.equal(d.customDifficulty(), 22 + 10);
  d.toggleAbility('advantage', 'immunity', 'Magic');
  assert.match(d.customProblem(), /too powerful/);
  d.toggleAbility('disadvantage', 'forbiddenMaterial', 'Steel');
  assert.equal(d.customProblem(), null);
  assert.deepEqual(Object.keys(d.rollRequest()), ['custom']);
  assert.notEqual(d.rollRequest().custom, d.custom, 'request is a copy');
});

test('level-up draft spends exactly the pool without lowering anything', () => {
  const start = { Strength: 99, Intelligence: 40, Willpower: 40, Agility: 40, Endurance: 40, Personality: 40, Speed: 40, Luck: 40 };
  const lv = new LevelUpDraft(start, 5);
  assert.ok(lv.up('Strength'));
  assert.equal(lv.up('Strength'), false, 'capped at 100');
  assert.equal(lv.down('Luck'), false);
  assert.match(lv.problem(), /4 left/);
  for (let i = 0; i < 4; i++) lv.up('Endurance');
  assert.equal(lv.left(), 0);
  assert.equal(lv.up('Luck'), false);
  assert.equal(lv.problem(), null);
  assert.equal(start.Strength, 99, 'input not mutated');
});
