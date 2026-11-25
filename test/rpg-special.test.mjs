// Package 19 rules: Daedra summoning tables and rolls, secret invitation tallies and the vampire/lycanthrope
// quest rolls. Pure functions; the production feature with installed data is exercised in
// test/rpg-special-quests.test.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAEDRA, DAEDRA_BY_FACTION, GLENMORIL, SHEOGORATH_INDEX, TEMPLE_SUMMONERS, rollSummoning, selectDaedra, summonerOf,
  summoningChance, summoningCost, weatherBonus,
} from '../server/rpg/special/daedra.js';
import {
  INVITATIONS, INVITE_SENT, LETTER_DELAY_MINUTES, letterDue, newTally, supernaturalStart, tallyCrime, vampirePool,
} from '../server/rpg/special/triggers.js';

const seq = (...xs) => {
  let i = 0;
  return () => xs[Math.min(i++, xs.length - 1)];
};
const d100 = (n) => (n - 1) / 100 + 0.001; // rng value that Dice100 turns into n

describe('Daedra summoning (DaggerfallQuestPopupWindow.daedraData)', () => {
  test('sixteen princes, original days, quests and weather conditions', () => {
    assert.equal(DAEDRA.length, 16);
    assert.deepEqual(DAEDRA.map((d) => [d.name, d.dayOfYear, d.quest]).slice(0, 3),
      [['Hircine', 155, 'X0C00Y00'], ['Clavicus Vile', 1, 'V0C00Y00'], ['Mehrunes Dagon', 320, 'Y0C00Y00']]);
    assert.equal(DAEDRA_BY_FACTION.get(15).dayOfYear, 283, 'Mephala');
    assert.equal(DAEDRA_BY_FACTION.get(15).quest, 'Z0C00Y00');
    assert.equal(DAEDRA[SHEOGORATH_INDEX].name, 'Sheogorath');
    assert.equal(new Set(DAEDRA.map((d) => d.dayOfYear)).size, 16, 'one prince per summoning day');
    assert.deepEqual(DAEDRA.filter((d) => d.bonus === 'rain').map((d) => d.name), ['Sanguine', 'Peryite', 'Boethiah', 'Nocturnal']);
  });

  test('cost and chance formulas', () => {
    assert.equal(summoningCost(0), 200000);
    assert.equal(summoningCost(40), 160000);
    assert.equal(summoningChance(0, 30), 60);
    assert.equal(summoningChance(-20, 0), 10);
    assert.equal(weatherBonus(DAEDRA_BY_FACTION.get(5), 'sunny'), 0, 'Sanguine needs rain');
    assert.equal(weatherBonus(DAEDRA_BY_FACTION.get(5), 'thunder'), 30, 'a storm also rains');
    assert.equal(weatherBonus(DAEDRA_BY_FACTION.get(9), 'rain'), 0, 'Sheogorath needs thunder');
    assert.equal(weatherBonus(DAEDRA_BY_FACTION.get(15), 'snow'), 30, 'no condition: always');
  });

  test('summoners: Mages Guild rank 6, temple summoning ranks, covens without rank', () => {
    assert.deepEqual(summonerOf({ faction: 66 }), { kind: 'mages', summonerFaction: 66, guild: 'mages', rankNeeded: 6 });
    assert.equal(summonerOf({ faction: 498 }).rankNeeded, 7, 'Kynareth');
    assert.equal(summonerOf({ faction: 482 }).rankNeeded, 6, 'Julianos');
    assert.equal(summonerOf({ faction: 464 }).rankNeeded, 8, 'Zenithar');
    assert.equal(TEMPLE_SUMMONERS.size, 8);
    assert.equal(summonerOf({ faction: 423, role: 'witch' }).kind, 'coven');
    assert.equal(summonerOf({ faction: GLENMORIL, role: 'witch' }).glenmoril, true);
    assert.equal(summonerOf({ faction: 41, role: 'fighters' }), null);
  });

  test('temples and guild halls summon only on the prince\'s day; covens pick one prince per day', () => {
    const mages = summonerOf({ faction: 66 });
    assert.equal(selectDaedra(mages, 282, {}), null, 'not a summoning day');
    assert.equal(selectDaedra(mages, 283, {}).name, 'Mephala');
    assert.equal(selectDaedra(mages, 155, {}).name, 'Hircine', 'Hircine is in the day table too');
    const state = {};
    const coven = summonerOf({ faction: 423, role: 'witch' });
    const first = selectDaedra(coven, 10, state, () => 0.5);
    assert.equal(state.covenDay, 10);
    assert.equal(selectDaedra(coven, 10, state, () => 0).name, first.name, 'same prince all day');
    assert.notEqual(first.index, 0, 'Random.Range(1, 16) never picks Hircine');
    assert.equal(selectDaedra(summonerOf({ faction: GLENMORIL, role: 'witch' }), 10, {}).name, 'Hircine', 'Glenmoril: always Hircine');
  });

  test('roll: Sheogorath stands in on 5 (15 in storms), success at or under the chance', () => {
    const meph = { ...DAEDRA_BY_FACTION.get(15) };
    const rep = () => 0;
    let r = rollSummoning(meph, { weatherType: 'sunny', daedraRep: rep, rng: seq(d100(51), d100(60)) });
    assert.deepEqual([r.daedra.name, r.chance, r.roll, r.success], ['Mephala', 60, 60, true]);
    r = rollSummoning(meph, { weatherType: 'sunny', daedraRep: rep, rng: seq(d100(51), d100(61)) });
    assert.equal(r.success, false, 'roll 61 > 60');
    r = rollSummoning(meph, { weatherType: 'sunny', daedraRep: rep, rng: seq(d100(5), d100(1)) });
    assert.equal(r.daedra.name, 'Sheogorath');
    assert.equal(r.chance, 30, 'Sheogorath without a storm has no bonus');
    r = rollSummoning(meph, { weatherType: 'thunder', daedraRep: rep, rng: seq(d100(15), d100(1)) });
    assert.equal(r.daedra.name, 'Sheogorath', '15% in a storm');
    assert.equal(r.chance, 60);
    r = rollSummoning(meph, { weatherType: 'sunny', daedraRep: (f) => (f === 15 ? 20 : 0), rng: seq(d100(51), d100(80)) });
    assert.equal(r.success, true, 'standing with the prince raises the chance to 80');
  });
});

describe('secret invitations (PlayerEntity.TallyCrimeGuildRequirements)', () => {
  test('thieving reaches 10, the letter is due three days later outdoors, then never again', () => {
    const rec = newTally();
    for (let i = 0; i < 9; i++) tallyCrime(rec, INVITATIONS.thieves, 1, 1000);
    assert.deepEqual(rec, { tally: 9, letterAt: 0 });
    tallyCrime(rec, INVITATIONS.thieves, 1, 1000);
    assert.equal(rec.letterAt, 1000 + LETTER_DELAY_MINUTES);
    tallyCrime(rec, INVITATIONS.thieves, 5, 2000);
    assert.equal(rec.tally, 10, 'no counting while the letter is scheduled');
    assert.equal(letterDue(rec, 1000 + LETTER_DELAY_MINUTES, false), false, 'strictly after the time');
    assert.equal(letterDue(rec, 1000 + LETTER_DELAY_MINUTES + 1, true), false, 'not while inside');
    assert.equal(letterDue(rec, 1000 + LETTER_DELAY_MINUTES + 1, false), true);
    assert.equal(rec.tally, INVITE_SENT);
    assert.equal(letterDue(rec, 99999, false), false, 'sent once');
    tallyCrime(rec, INVITATIONS.thieves, 50, 99999);
    assert.equal(rec.tally, INVITE_SENT);
  });

  test('murders count 5 each toward the Dark Brotherhood threshold of 15', () => {
    const rec = newTally();
    tallyCrime(rec, INVITATIONS.brotherhood, 5, 0);
    tallyCrime(rec, INVITATIONS.brotherhood, 5, 0);
    assert.equal(rec.letterAt, 0);
    tallyCrime(rec, INVITATIONS.brotherhood, 5, 7);
    assert.equal(rec.letterAt, 7 + LETTER_DELAY_MINUTES);
    assert.equal(INVITATIONS.brotherhood.quest, 'L0A01L00');
    assert.equal(INVITATIONS.thieves.quest, 'O0A0AL00');
  });
});

describe('vampire and lycanthrope quests (RacialOverrideEffect.StartQuest)', () => {
  const none = () => false;
  test('vampire cure: random_range_inclusive(10, 100) < 30', () => {
    assert.deepEqual(supernaturalStart('vampire', true, {}, none, () => 0), { start: '$CUREVAM' }, '10 < 30');
    assert.deepEqual(supernaturalStart('vampire', true, {}, none, () => 19.5 / 91), { start: '$CUREVAM' }, '29 < 30');
    assert.equal(supernaturalStart('vampire', true, {}, none, () => 20.5 / 91), null, '30 is not < 30');
  });

  test('vampire clan: P0A01L00 first (50%), then the clan pool (50%)', () => {
    const st = { vampireInitial: false };
    assert.equal(supernaturalStart('vampire', false, st, none, () => 0.99), null);
    assert.equal(st.vampireInitial, false);
    assert.deepEqual(supernaturalStart('vampire', false, st, none, () => 0), { start: 'P0A01L00' });
    assert.equal(st.vampireInitial, true);
    assert.deepEqual(supernaturalStart('vampire', false, st, none, () => 0), { pool: 'Vampires' });
  });

  test('lycanthrope: $CUREWER on the cure tick unless already running; nothing on the clan tick', () => {
    assert.deepEqual(supernaturalStart('werewolf', true, {}, none), { start: '$CUREWER' });
    assert.deepEqual(supernaturalStart('wereboar', true, {}, none), { start: '$CUREWER' });
    assert.equal(supernaturalStart('werewolf', true, {}, (n) => n === '$CUREWER'), null);
    assert.equal(supernaturalStart('werewolf', false, {}, none), null);
  });

  test('clan pool: members only, level or reputation requirement, one-time and adult filters', () => {
    const e = (name, membership, minReq, extra = {}) => ({ name, meta: { group: 'Vampires', membership, minReq, oneTime: false, adult: false, ...extra } });
    const rows = [e('P0A01L00', 'P', 0), e('P0B00L01', 'M', 0), e('P0B10L07', 'M', 1), e('P0B20L09', 'M', 2), e('P0B01L02', 'M', 0, { oneTime: true }), e('X', 'M', 15)];
    assert.deepEqual(vampirePool(rows, { level: 1 }).map((r) => r.name), ['P0B00L01', 'P0B01L02', 'P0B10L07']);
    assert.deepEqual(vampirePool(rows, { level: 1, rep: 20, oneTimeDone: ['P0B01L02'] }).map((r) => r.name), ['P0B00L01', 'P0B10L07', 'X']);
  });
});
