// Combat feedback (client/gameplay/combatFeedback.js) against the event shapes server/rpg/combat.js emits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { popupFor, plateFor, bearingFrom, weightOf } from '../client/gameplay/combatFeedback.js';

const ME = 'p1';
const hit = { kind: 'hit', playerId: ME, entityId: 'monster-3', damage: 4, hp: 6, maxHp: 10, source: 'weapon' };

test('own hits show the server amount over the struck monster; kills, backstabs and spells read differently', () => {
  assert.deepEqual(popupFor(hit, ME), { at: 'monster-3', text: '4', cls: 'hit', label: null, scale: weightOf(4, 10), mark: 'hit' });
  assert.deepEqual([popupFor({ ...hit, hp: 0 }, ME).cls, popupFor({ ...hit, hp: 0 }, ME).label, popupFor({ ...hit, hp: 0 }, ME).mark], ['kill', 'Slain', 'kill']);
  assert.deepEqual([popupFor({ ...hit, backstab: true }, ME).cls, popupFor({ ...hit, backstab: true }, ME).label], ['backstab', 'Backstab']);
  assert.equal(popupFor({ ...hit, backstab: true, hp: -2 }, ME).cls, 'kill', 'a killing backstab reads as a kill');
  assert.equal(popupFor({ ...hit, source: 'magic' }, ME).cls, 'magic');
  assert.equal(popupFor({ ...hit, damage: 0 }, ME), null);
});

test('number size follows the blow against the monster health, and works without maxHp', () => {
  assert.ok(weightOf(1, 40) < weightOf(10, 40) && weightOf(10, 40) < weightOf(40, 40));
  assert.equal(weightOf(40, 40), 1.9);
  assert.equal(weightOf(400, 40), 1.9);
  assert.ok(weightOf(3, undefined) > 1);
});

test('own misses, ineffective strikes and absorbed blows read as words, not numbers', () => {
  assert.deepEqual(popupFor({ kind: 'miss', playerId: ME, entityId: 'monster-3' }, ME), { at: 'monster-3', text: 'Miss', cls: 'miss' });
  assert.equal(popupFor({ kind: 'ineffective', entityId: 'monster-3', text: 'x' }, ME).cls, 'noeffect');
  const absorbed = popupFor({ kind: 'monsterAttack', entityId: 'monster-3', targetId: ME, hit: true, damage: 0, absorbed: true }, ME);
  assert.deepEqual([absorbed.text, absorbed.cls, absorbed.from], ['Absorbed', 'absorbed', 'monster-3']);
});

test('damage taken floats on the viewer and remembers the attacker for the side marker', () => {
  assert.deepEqual(popupFor({ kind: 'monsterAttack', entityId: 'monster-3', targetId: ME, hit: true, damage: 2 }, ME),
    { at: null, text: '-2', cls: 'hurt', from: 'monster-3' });
  assert.equal(popupFor({ kind: 'monsterAttack', entityId: 'monster-3', targetId: ME, hit: false, damage: 0 }, ME).cls, 'evade');
  assert.deepEqual(popupFor({ kind: 'hurt', damage: 5, cause: 'fall' }, ME), { at: null, text: '-5', cls: 'hurt', label: 'Fall' });
  assert.equal(popupFor({ kind: 'hurt', damage: 5, cause: 'other' }, ME).label, null);
  assert.equal(popupFor({ kind: 'hurt', damage: 0, cause: 'spell' }, ME), null);
  assert.deepEqual(popupFor({ kind: 'heal', amount: 7 }, ME), { at: null, text: '+7', cls: 'heal' });
  assert.equal(popupFor({ kind: 'heal', amount: 0 }, ME), null);
});

test("other fights stay private: another player's hits, misses and monster attacks show nothing", () => {
  assert.equal(popupFor({ kind: 'hit', playerId: 'p2', entityId: 'monster-3', damage: 9, hp: 1 }, ME), null);
  assert.equal(popupFor({ kind: 'hit', playerId: null, attackerId: 'monster-4', entityId: 'monster-3', damage: 9, hp: 1 }, ME), null);
  assert.equal(popupFor({ kind: 'miss', playerId: 'p2', entityId: 'monster-3' }, ME), null);
  assert.equal(popupFor({ kind: 'monsterAttack', entityId: 'monster-3', targetId: 'p2', hit: true, damage: 5 }, ME), null);
  assert.equal(popupFor({ kind: 'swing', playerId: ME }, ME), null);
  assert.equal(popupFor({ kind: 'hit', playerId: ME, damage: 3 }, null), null);
});

test('the plate follows the monster you fight, drains from server hp, and ignores fights that are not yours', () => {
  let plate = plateFor(null, hit, ME);
  assert.deepEqual(plate, { id: 'monster-3', hp: 6, maxHp: 10, before: 10, slain: false }, 'before: the bar drains from the health it had');
  assert.equal(plateFor(plate, { kind: 'hit', playerId: 'p2', entityId: 'monster-9', damage: 3, hp: 2, maxHp: 9 }, ME), plate, 'someone else\'s fight');
  plate = plateFor(plate, { kind: 'hit', playerId: 'p2', entityId: 'monster-3', damage: 3, hp: 3, maxHp: 10 }, ME);
  assert.equal(plate.hp, 3, 'help from another player still drains the bar');
  plate = plateFor(plate, { ...hit, damage: 5, hp: -2 }, ME);
  assert.deepEqual([plate.hp, plate.slain], [0, true]);
  const bitten = plateFor(null, { kind: 'monsterAttack', entityId: 'monster-7', targetId: ME, hit: true, damage: 2 }, ME);
  assert.deepEqual(bitten, { id: 'monster-7', hp: null, maxHp: null });
  assert.equal(plateFor(null, { kind: 'monsterAttack', entityId: 'monster-7', targetId: 'p2', hit: true, damage: 2 }, ME), null);
  assert.equal(plateFor(null, { kind: 'miss', playerId: 'p2', entityId: 'monster-7' }, ME), null);
  const held = plateFor(null, hit, ME);
  assert.equal(plateFor(held, { kind: 'monsterAttack', entityId: 'monster-7', targetId: ME, hit: true, damage: 2 }, ME).id, 'monster-3',
    'a second monster biting you does not steal the plate from the one you are hitting');
  assert.equal(plateFor(held, { kind: 'miss', playerId: ME, entityId: 'monster-7' }, ME).id, 'monster-7', 'swinging at another does');
});

test('bearing: ahead is 0, right is positive, behind is ±π (yaw 0 looks toward -z)', () => {
  const cam = { x: 0, z: 0, yaw: 0 };
  assert.equal(bearingFrom(cam, 0, -3), 0);
  assert.ok(Math.abs(bearingFrom(cam, 3, 0) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(Math.abs(bearingFrom(cam, 0, 3)) - Math.PI) < 1e-9);
  assert.ok(Math.abs(bearingFrom({ ...cam, yaw: Math.PI / 2 }, 3, 0)) < 1e-9);
  assert.equal(bearingFrom(cam, undefined, 0), null);
});
