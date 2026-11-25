// Health conditions and supernatural characters (package 10): classic tables, timed progression on
// each character's own clock, cures, persistence and isolation between characters.
//
// Layers:
//   MODEL    server/rpg/conditions/model.js with a seeded RNG (pure).
//   RUNTIME  the real RPG runtime + atmosphere (shared clock, controlled wall time) + calendar
//            (playerMinutes, rest/travel blockers) + conditions, driven through ticks and actions.
//   SERVER   the real HTTP/WebSocket server and SQLite store on a temp DB and an automatic port.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import * as M from '../server/rpg/conditions/model.js';
import {
  DISEASES, POISONS, CARRIERS, lunarPhase, isFullMoon, DISEASE_LIST_B, DISEASE_LIST_C,
} from '../server/rpg/conditions/tables.js';
import { install as installConditions } from '../server/rpg/conditions.js';
import { install as installAtmosphere } from '../server/rpg/atmosphere.js';
import { install as installCalendar } from '../server/rpg/calendar.js';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { createGameServer } from '../server/game.js';
import { dateFromMinutes, WORLD_EPOCH_MS, CLASSIC_GAME_START_TIME } from '../client/gameplay/atmosphere/calendar.js';
import { seededRandom } from './support/rpg-session.mjs';

const HOME = 'town:Daggerfall/Gothway Garden';
const DAY = 1440;
const ATTRS = ['Strength', 'Intelligence', 'Willpower', 'Agility', 'Endurance', 'Personality', 'Speed', 'Luck'];
const sheet = (over = {}) => ({
  level: 5, health: 60, maxHealth: 60, fatigue: 120, maxFatigue: 120, magicka: 80, maxMagicka: 80,
  attributes: Object.fromEntries(ATTRS.map((a) => [a, 50])), skills: {}, ...over,
});
const fresh = (time = 1000 * DAY) => M.normalize({}, time);

// ------------------------------------------------------------------ model

describe('classic tables', () => {
  test('17 diseases and 12 poisons with DFU keys; carrier lists match FormulaHelper.OnMonsterHit', () => {
    assert.equal(DISEASES.length, 17);
    assert.equal(DISEASES[0].key, 'Disease-WitchesPox');
    assert.equal(DISEASES[16].key, 'Disease-WizardFever');
    assert.equal(DISEASES[7].permanent, false, "Caliron's Curse runs 3-18 days");
    assert.deepEqual([DISEASES[1].minDamage, DISEASES[1].maxDamage], [3, 30]);
    assert.equal(POISONS.length, 12);
    assert.equal(POISONS[1].classic, 129);
    assert.deepEqual(DISEASE_LIST_B.map((i) => DISEASES[i].name), ['Plague', 'Stomach Rot', 'Brain Fever']);
    assert.equal(DISEASE_LIST_C.length, 11);
    assert.deepEqual(Object.keys(CARRIERS).map(Number), [0, 3, 9, 14, 17, 19, 28, 30]);
  });

  test('moons follow DaggerfallDateTime.GetLunarPhase (32-day cycle, Masser +3, Secunda -1)', () => {
    const d = dateFromMinutes(CLASSIC_GAME_START_TIME);
    const ratioM = (d.dayOfYear + d.year * 360 + 3) % 32;
    const toFull = (32 - ratioM) % 32;
    const full = dateFromMinutes(CLASSIC_GAME_START_TIME + toFull * DAY);
    assert.equal(lunarPhase(full, true), 'full');
    assert.equal(lunarPhase(dateFromMinutes(CLASSIC_GAME_START_TIME + (toFull + 16) * DAY), true), 'new');
    assert.equal(lunarPhase(dateFromMinutes(CLASSIC_GAME_START_TIME + (toFull + 4) * DAY), false), 'full', 'Secunda is four days behind');
    assert.ok(isFullMoon(full));
  });
});

describe('disease progression', () => {
  test('incubation until midnight, then daily attribute and health damage; permanent until cured', () => {
    const st = fresh(1000 * DAY + 600); // 10:00
    const rng = seededRandom(7);
    const d = M.addDisease(st, 1, rng); // Plague
    assert.ok(d);
    assert.equal(M.addDisease(st, 1, rng), null, 'one plague at a time (IsLikeKind)');
    let out = M.advance(st, 13 * 60, { rng });
    assert.equal(d.incubationOver, false, 'still incubating at 23:00');
    assert.equal(M.attributePenalty(st, 'Strength'), 0);
    out = M.advance(st, 60, { rng });
    assert.equal(d.incubationOver, true, 'symptoms at the first midnight');
    assert.ok(out.some((e) => e.type === 'symptoms'));
    const v1 = out.find((e) => e.type === 'vitals');
    const s1 = M.attributePenalty(st, 'Strength');
    assert.ok(s1 >= 3 && s1 <= 30, `Plague does 3-30 a day (${s1})`);
    assert.equal(M.attributePenalty(st, 'Intelligence'), 0, 'Plague spares Intelligence');
    assert.equal(v1.health, s1, 'health loss uses the same daily roll');
    M.advance(st, 3 * DAY, { rng });
    assert.ok(M.attributePenalty(st, 'Strength') > s1, 'damage accumulates daily');
    assert.equal(st.diseases.length, 1, 'permanent until cured');
    assert.equal(M.cure(st, 'disease'), 1);
    assert.equal(M.attributePenalty(st, 'Strength'), 0, 'curing removes its attribute damage');
  });

  test("Caliron's Curse ends by itself after 3-18 days of symptoms", () => {
    const st = fresh();
    const rng = seededRandom(3);
    const d = M.addDisease(st, 7, rng);
    assert.ok(d.daysLeft >= 3 && d.daysLeft <= 18);
    const out = [];
    for (let i = 0; i < 20; i++) out.push(...M.advance(st, DAY, { rng }));
    assert.equal(st.diseases.length, 0);
    assert.ok(out.some((e) => e.type === 'diseaseEnded'));
  });

  test('vampires and lycanthropes are immune to disease; vampires to paralysis', () => {
    const st = fresh();
    M.deploy(st, 'vampirism', 150);
    assert.equal(M.addDisease(st, 1, Math.random), null);
    assert.equal(M.immuneTo(st, 'paralysis'), true);
    const w = fresh();
    M.deploy(w, 'werewolf');
    assert.equal(M.immuneTo(w, 'disease'), true);
    assert.equal(M.immuneTo(w, 'paralysis'), false);
  });
});

describe('poisons', () => {
  test('Drothweed waits 5-10 minutes, drains for its rounds, and its damage stays until healed', () => {
    const st = fresh();
    const rng = seededRandom(11);
    const p = M.addPoison(st, 3, rng);
    const wait = p.startIn;
    assert.ok(wait >= 5 && wait <= 10);
    M.advance(st, wait - 1, { rng });
    assert.equal(p.state, 'waiting');
    assert.equal(M.attributePenalty(st, 'Strength'), 0);
    M.advance(st, 1, { rng });
    assert.equal(p.state, 'active');
    assert.ok(M.attributePenalty(st, 'Strength') >= 5);
    M.advance(st, 60, { rng });
    assert.equal(p.state, 'complete');
    const str = M.attributePenalty(st, 'Strength');
    assert.ok(str > 0, 'damage persists after the poison is spent (CompletePoison)');
    M.advance(st, DAY, { rng });
    assert.equal(M.attributePenalty(st, 'Strength'), str, 'and does not wear off with time');
    const total = ['Strength', 'Agility', 'Speed'].reduce((n, a) => n + M.attributePenalty(st, a), 0);
    assert.equal(M.healAttribute(st, 'Strength', 1000), str);
    assert.equal(st.poisons.length, 1, 'still recorded while Agility/Speed are weakened');
    M.healAttribute(st, 'Agility', 1000);
    M.healAttribute(st, 'Speed', 1000);
    assert.equal(st.poisons.length, 0, 'ends when every attribute is healed');
    assert.ok(total > str);
  });

  test('a drug (Sursum) loses its Strength boost when spent; Nux Vomica deals health per minute', () => {
    const st = fresh();
    const rng = seededRandom(5);
    const sursum = M.addPoison(st, 9, rng);
    M.advance(st, sursum.startIn, { rng }); // Sursum waits 1-4 minutes, then lasts 2
    assert.equal(sursum.state, 'active');
    assert.ok(M.attributePenalty(st, 'Strength') < 0, 'Sursum boosts Strength while active');
    M.advance(st, 10, { rng });
    assert.ok(M.attributePenalty(st, 'Strength') >= 0, 'boost removed once spent (RemovePositiveStats)');
    assert.ok(M.attributePenalty(st, 'Intelligence') > 0, 'Intelligence damage remains');
    const n = fresh();
    M.addPoison(n, 0, rng);
    const out = M.advance(n, 20, { rng });
    const hp = out.find((e) => e.type === 'vitals')?.health ?? 0;
    assert.ok(hp >= 3 * 2, `Nux Vomica: 3-10 minutes of 2-11 damage (${hp})`);
    assert.equal(n.poisons.length, 0, 'a spent health-only poison leaves no record');
    M.addPoison(n, 1, rng); // Arsenic: still waiting
    assert.equal(M.cure(n, 'poison'), 1, 'Cure Poison removes a poison before it takes hold');
  });
});

describe('supernatural infections and curses', () => {
  test('vampirism: dream after a day, curse after more than three; clan, feeding, sunlight, bonuses', () => {
    const st = fresh(1000 * DAY + 60);
    M.startInfection(st, 'vampirism', 157); // Anthotis
    let out = M.advance(st, DAY, { rng: Math.random });
    assert.ok(out.some((e) => e.type === 'dream'));
    out = M.advance(st, 2 * DAY, { rng: Math.random });
    assert.equal(st.vampire, null, 'not yet after three days');
    out = M.advance(st, DAY, { rng: Math.random });
    assert.ok(out.some((e) => e.type === 'deploy' && e.kind === 'vampirism'));
    assert.equal(st.vampire.clanFactionId, 157);
    assert.equal(M.attributePenalty(st, 'Strength'), -20);
    assert.equal(M.attributePenalty(st, 'Intelligence'), -20, 'Anthotis also gain Intelligence');
    assert.equal(M.skillModifier(st, 'Stealth'), 30);
    assert.equal(M.isSated(st), true);
    M.advance(st, DAY + 1, { rng: Math.random });
    assert.equal(M.isSated(st), false, 'hungry a day after feeding');
    out = M.advance(st, 10, { rng: Math.random, sunMinutes: 10 });
    assert.equal(out.find((e) => e.type === 'vitals').health, 24, '12 health per 4 minutes of sunlight');
    assert.equal(st.sun, 2, 'remainder carried');
    out = M.advance(st, 10, { rng: Math.random, sunMinutes: 0 });
    assert.equal(out.find((e) => e.type === 'vitals'), undefined, 'no burn in shade');
    out = M.advance(st, 10, { rng: Math.random, holyMinutes: 10 });
    assert.equal(out.find((e) => e.type === 'vitals').health, 24, '12 health per 4 minutes on holy ground');
    assert.equal(out.find((e) => e.type === 'vitals').magicka, 0, 'the curse brings no light/darkness magery (career-only in DFU)');
    assert.equal(st.holy, 2, 'remainder carried');
    assert.equal(M.cure(st, 'vampirism'), 1);
    assert.equal(st.previousClanFactionId, 157);
    assert.equal(M.attributePenalty(st, 'Strength'), 0);
  });

  test('a disease cure (temple) also clears a pending infection; a full curse is not a disease', () => {
    const st = fresh();
    M.startInfection(st, 'werewolf');
    assert.equal(M.cure(st, 'disease'), 1);
    assert.equal(st.infection, null);
    M.deploy(st, 'wereboar');
    assert.equal(M.cure(st, 'disease'), 0);
    assert.ok(st.lycanthrope);
  });

  test('lycanthropy: full moon forces beast form; morph once a day; beast bonuses; urge to kill', () => {
    const st = fresh();
    M.deploy(st, 'werewolf');
    assert.equal(M.morph(st).transformed, true);
    assert.equal(M.attributePenalty(st, 'Strength'), -40);
    assert.equal(M.skillModifier(st, 'Swimming'), 30);
    assert.equal(M.morph(st).transformed, false, 'returning to human form is always allowed');
    assert.equal(M.morph(st).ok, false, 'once per day');
    M.advance(st, DAY + 1, { rng: Math.random });
    assert.equal(M.morph(st).ok, true);
    M.morph(st, { force: true });
    const out = M.advance(st, 1, { rng: Math.random, fullMoon: true });
    assert.ok(out.some((e) => e.type === 'fullMoon'));
    assert.equal(st.lycanthrope.transformed, true);
    assert.equal(M.healthLimit(st, 100), null);
    M.advance(st, 31 * DAY, { rng: Math.random });
    const cap = M.healthLimit(st, 100);
    assert.ok(cap < 100 && cap >= 4, `health limited after 30 days without a kill (${cap})`);
  });

  test('racial override quest ticks every 38 and 84 days of the character clock', () => {
    const st = fresh(0);
    M.deploy(st, 'vampirism', 150);
    let quests = [];
    for (let d = 0; d < 90; d++) quests.push(...M.advance(st, DAY, { rng: Math.random }).filter((e) => e.type === 'quest'));
    assert.deepEqual(quests.map((q) => q.cure), [false, false, true]);
  });
});

// ------------------------------------------------------------------ runtime

/** Real runtime with atmosphere (controlled wall clock), calendar and conditions. */
function stack({ seed = 1, wall = WORLD_EPOCH_MS + 3600_000, save = () => {} } = {}) {
  const players = new Map();
  const sent = [];
  let clock = 0;
  const world = { wall };
  const entities = [];
  const runtime = createRpgRuntime({
    players,
    features: [
      { name: 'atmosphere', install: (ctx) => installAtmosphere(ctx, { wallNow: () => world.wall }) },
      { name: 'conditions', install: (ctx) => installConditions(ctx, { random: seededRandom(seed) }) },
      { name: 'calendar', install: installCalendar },
      { name: 'fixtures', install: (ctx) => { for (const e of entities) ctx.entities.set(e.id, e); } },
    ],
    save,
    send: (p, msg) => sent.push([p.id, msg]),
    now: () => clock,
    log: { info() {}, warn() {}, error() {} },
  });
  const join = (id, over = {}) => {
    const p = { id, name: `P${id}`, x: 0, z: 0, yaw: 0, moving: false, rpg: { location: HOME, gold: 1000, character: sheet(over) } };
    players.set(id, p);
    runtime.join(p);
    return p;
  };
  /** Advance shared world time by game minutes (12x: 5 real seconds per game minute) and tick. */
  const pass = (gameMinutes) => {
    world.wall += (gameMinutes * 60_000) / 12;
    clock += 100;
    runtime.tick(0.1, clock);
  };
  const events = (id, change) => sent.filter(([to, m]) => to === id && m.type === 'gameEvent' && m.event.kind === 'condition' && (!change || m.event.change === change)).map(([, m]) => m.event);
  return { runtime, players, join, pass, events, S: runtime.ctx.services, world, sent };
}

describe('runtime: exposure, clocks, cures and isolation', () => {
  test('a rat bite contracts a list-B disease through the combat contract; non-carriers never do', () => {
    const t = stack({ seed: 42 });
    const p = t.join(1);
    const rat = { kind: 'monster', monsterId: 0, name: 'Rat' };
    const orc = { kind: 'monster', monsterId: 7, name: 'Orc' };
    let got = null;
    for (let i = 0; i < 400 && !got; i++) {
      assert.deepEqual(t.S.conditionExposure(p, { source: orc, damage: 5, delivery: 'melee' }).contracted, []);
      got = t.S.conditionExposure(p, { source: rat, damage: 3, delivery: 'melee' }).contracted[0] ?? null;
    }
    assert.ok(got, 'a rat eventually passes on a disease (5% per bite, saving throw applies)');
    assert.ok(['Plague', 'Stomach Rot', 'Brain Fever'].includes(got.name), got.name);
    assert.deepEqual(t.S.conditionExposure(p, { source: rat, damage: 3, delivery: 'ranged' }).contracted, [], 'ranged hits never infect');
    const lvl1 = t.join(2, { level: 1 });
    for (let i = 0; i < 300; i++) t.S.conditionExposure(lvl1, { source: rat, damage: 3, delivery: 'melee' });
    assert.equal(lvl1.rpg.conditions.diseases.length, 0, 'level 1 characters cannot catch diseases');
  });

  test('timed progression on the live clock; one character\'s rest does not age another\'s disease', () => {
    const t = stack();
    const a = t.join(1);
    const b = t.join(2);
    t.S.makeDiseased(a, 'Plague');
    t.S.makeDiseased(b, 'Plague');
    t.pass(1);
    const startA = a.rpg.conditions.time;
    // Character A rests 30 hours (personal ledger); B stays awake.
    t.S.spendTime(a, 30 * 60, 'rest');
    t.pass(1);
    assert.equal(a.rpg.conditions.time, t.S.playerMinutes(a), 'A follows playerMinutes');
    assert.ok(a.rpg.conditions.time - startA >= 30 * 60, 'including the 30 hours of rest');
    assert.ok(a.rpg.conditions.time - b.rpg.conditions.time >= 30 * 60 - 15, "B's clock does not include A's rest");
    assert.equal(a.rpg.conditions.diseases[0].incubationOver, true, 'A is now symptomatic');
    assert.ok(t.S.conditionAttributePenalty(a, 'Strength') > 0);
    assert.equal(b.rpg.conditions.diseases[0].incubationOver, b.rpg.conditions.time % DAY < (b.rpg.conditions.time - 2) % DAY, 'B only by its own clock');
    assert.equal(t.S.conditionAttributePenalty(b, 'Strength'), b.rpg.conditions.diseases[0].loss.Strength ?? 0);
    assert.ok(t.events(1, 'diagnosed').length === 1, 'A is told what it has');
    assert.equal(t.events(2, 'diagnosed').length, b.rpg.conditions.diseases[0].incubationOver ? 1 : 0);
    assert.ok(a.rpg.character.health < 60, 'daily health damage');
    const pub = t.S.conditionStatus(a);
    assert.equal(pub.diseases[0].name, 'Plague');
  });

  test('temple contract: count includes a pending infection; cure removes both; a full curse is not counted', () => {
    const t = stack();
    const p = t.join(1);
    t.S.makeDiseased(p, 'WitchesPox');
    t.S.startInfection(p, 'werewolf');
    assert.equal(t.S.conditionCount(p, 'disease'), 2, 'the temple quotes 2 × 250 gold');
    assert.equal(t.S.cureCondition(p, 'disease'), 2);
    assert.equal(t.S.conditionCount(p, 'disease'), 0);
    assert.equal(t.events(1, 'cured').length, 1);
    t.S.deploySupernatural(p, 'wereboar');
    assert.equal(t.S.conditionCount(p, 'disease'), 0, 'temples cannot cure a full lycanthrope');
    assert.equal(t.S.cureCondition(t.join(2), 'disease'), 0, 'nothing to cure on a healthy character');
    assert.equal(t.runtime.hasAction('conditions.templeCure'), false, 'the temple counter owns the service');
  });

  test('quest contract: applyCondition by name or index, cure one named disease, cure vampirism', () => {
    const t = stack();
    const p = t.join(1);
    assert.equal(t.S.applyCondition(p, { disease: 'Plague' }).name, 'Plague');
    assert.equal(t.S.applyCondition(p, { disease: 3 }).name, 'Stomach Rot');
    assert.equal(t.S.cureCondition(p, { disease: 'Plague' }), 1);
    assert.deepEqual(p.rpg.conditions.diseases.map((d) => d.type), [3], 'only the named disease is cured');
    assert.equal(t.S.cureCondition(p, { disease: null }), 1, 'no name: every disease');
    t.S.deploySupernatural(p, 'vampirism', { clan: 155 });
    assert.equal(t.S.cureCondition(p, 'vampirism'), 1);
    assert.equal(t.S.conditionStatus(p).previousClanFactionId, 155);
  });

  test('vampire: unsated rest is refused, day travel is refused, sunlight burns outdoors not indoors, feeding sates', () => {
    const t = stack();
    const p = t.join(1);
    t.S.deploySupernatural(p, 'vampirism', { clan: 150 });
    assert.equal(t.S.conditionStatus(p).vampire.clan, 'Vraseth');
    assert.equal(t.S.conditionImmune(p, 'paralysis'), true);
    // Find shared daylight.
    while (t.S.worldClock().isNight) t.pass(30);
    const hp0 = p.rpg.character.health;
    t.pass(8);
    assert.ok(p.rpg.character.health <= hp0 - 12, 'burns in the open by day');
    p.rpg.location = 'interior:Daggerfall/Gothway Garden/3';
    const hp1 = p.rpg.character.health;
    t.pass(8);
    assert.equal(p.rpg.character.health, hp1, 'safe indoors');
    p.rpg.location = HOME;
    assert.match(t.S.travelPrevented(p) ?? '', /sunlight/i);
    t.S.spendTime(p, 2 * DAY, 'wait');
    t.pass(1);
    assert.equal(t.S.conditionStatus(p).vampire.sated, false);
    assert.ok(t.S.restPrevented(p), 'cannot rest while hungry');
    t.runtime.ctx.emit('kill', { player: p, entity: { kind: 'monster', monsterId: 7 } });
    assert.equal(t.S.conditionStatus(p).vampire.sated, true);
    assert.equal(t.S.restPrevented(p), null);
    assert.equal(t.S.cureCondition(p, 'vampirism'), 1);
    assert.equal(t.S.conditionStatus(p).previousClanFactionId, 150);
  });

  test('vampire: holy ground burns 12 health per 4 minutes in a temple or Fighter Trainers hall, day or night', () => {
    const t = stack();
    const p = t.join(1);
    const mortal = t.join(2);
    const TEMPLE = 'interior:Daggerfall/Gothway Garden/7';
    const TRAINERS = 'interior:Daggerfall/Gothway Garden/8';
    const SHOP = 'interior:Daggerfall/Gothway Garden/9';
    const metas = { [TEMPLE]: { buildingType: 14 }, [TRAINERS]: { buildingType: 11, factionId: 849 }, [SHOP]: { buildingType: 9, factionId: 0 } };
    t.S.portals = { ...(t.S.portals ?? {}), into: (loc) => (metas[loc] ? { meta: metas[loc] } : null) };
    t.S.deploySupernatural(p, 'vampirism', { clan: 150 });
    while (!t.S.worldClock().isNight) t.pass(30); // night: sunlight plays no part
    for (const q of [p, mortal]) q.rpg.location = TEMPLE;
    t.pass(1);
    const hp0 = p.rpg.character.health;
    const mortal0 = mortal.rpg.character.health;
    t.pass(8);
    assert.equal(hp0 - p.rpg.character.health, 24, 'two holy rounds in 8 minutes');
    assert.ok(t.events(1, 'holy').length > 0, 'the vampire is told why');
    assert.equal(mortal.rpg.character.health, mortal0, 'a mortal is not harmed');
    p.rpg.location = TRAINERS;
    t.pass(1);
    const hp1 = p.rpg.character.health;
    t.pass(4);
    assert.equal(hp1 - p.rpg.character.health, 12, 'a Fighter Trainers hall is holy ground (PlayerEnterExit)');
    p.rpg.location = SHOP;
    t.pass(1);
    const hp2 = p.rpg.character.health;
    t.pass(8);
    assert.equal(p.rpg.character.health, hp2, 'an ordinary shop is not');
    assert.equal(p.rpg.conditions.holy, 0, 'leaving holy ground clears the remainder');
  });

  test('vampire awakening retries a failed save without charging the personal fortnight twice', () => {
    let fail = true;
    const t = stack({ save: () => { if (fail) throw new Error('fixture save failure'); } });
    const a = t.join(1);
    const b = t.join(2);
    const installed = [];
    const deadlines = [];
    t.S.setVampireSpells = (p, indices) => { p.rpg.fixtureSpells = indices; };
    t.runtime.ctx.on('supernaturalQuest', (ev) => deadlines.push(ev));
    t.runtime.ctx.on('timeSpent', (ev) => { if (ev.reason === 'vampireAwakening') installed.push(ev.minutes); });
    t.S.startInfection(a, 'vampirism');
    t.S.spendTime(a, DAY, 'fixture');
    t.pass(0);
    assert.equal(t.events(a.id, 'dream').length, 1);
    t.S.spendTime(a, 3 * DAY, 'fixture');
    const before = t.S.playerMinutes(a);
    const witness = t.S.playerMinutes(b);
    t.pass(0);
    assert.ok(a.rpg.conditions.infection);
    assert.equal(a.rpg.fixtureSpells, undefined);
    assert.equal(t.S.playerMinutes(a), before);
    assert.equal(t.events(a.id, 'deployed').length, 0);
    fail = false;
    t.pass(0);
    assert.ok(a.rpg.conditions.vampire);
    assert.deepEqual(a.rpg.fixtureSpells, [4, 90, 91, 23, 6]);
    assert.equal(t.S.playerClock(a).hour, 19);
    assert.equal(t.S.playerMinutes(a) - before, installed.at(-1));
    assert.equal(a.rpg.conditions.vampire.since, t.S.playerMinutes(a));
    assert.equal(t.S.playerMinutes(b), witness);
    assert.equal(t.events(a.id, 'deployed').length, 1);
    assert.equal(t.events(b.id, 'deployed').length, 0);
    assert.deepEqual(deadlines, []);
  });

  test('werewolf: morph action, once per day, peers told; cure returns to human form', () => {
    const t = stack();
    const p = t.join(1);
    const q = t.join(2);
    t.S.deploySupernatural(p, 'werewolf');
    assert.equal(t.runtime.act(p, 'conditions.morph', {}).ok, true);
    assert.equal(t.S.conditionStatus(p).lycanthrope.transformed, true);
    assert.equal(t.S.conditionAttributePenalty(p, 'Speed'), -40);
    assert.ok(t.sent.some(([to, m]) => to === q.id && m.event?.kind === 'conditionForm' && m.event.transformed === true));
    assert.equal(t.runtime.act(p, 'conditions.morph', {}).ok, true, 'back to human form');
    assert.match(t.runtime.act(p, 'conditions.morph', {}).error, /once per day/);
    assert.equal(t.S.conditionStatus(q).lycanthrope, null, 'the other character is untouched');
    assert.equal(t.S.cureCondition(p, 'lycanthropy'), 1);
  });

  test('lycanthrope hunger is sated by mobile civilians and city watch in human or beast form', () => {
    const t = stack();
    const p = t.join(1);
    t.S.deploySupernatural(p, 'wereboar');
    t.S.spendTime(p, 32 * DAY, 'fixture');
    t.pass(0);
    const limit = t.S.conditionStatus(p).lycanthrope.healthLimit;
    assert.ok(limit < p.rpg.character.maxHealth);
    t.runtime.ctx.emit('kill', { player: p, entity: { kind: 'monster', monsterId: 128 } });
    t.runtime.ctx.emit('kill', { player: p, entity: { kind: 'npc', mobile: false } });
    assert.equal(t.S.conditionStatus(p).lycanthrope.healthLimit, limit);
    t.runtime.ctx.emit('civilianKilled', { player: p, entity: { kind: 'npc', mobile: true } });
    assert.equal(t.S.conditionStatus(p).lycanthrope.healthLimit, null);
    t.S.spendTime(p, 32 * DAY, 'fixture');
    t.pass(0);
    t.S.conditionMorphSelf(p, { force: true });
    t.runtime.ctx.emit('kill', { player: p, entity: { kind: 'monster', monsterId: 146 } });
    assert.equal(t.S.conditionStatus(p).lycanthrope.healthLimit, null);
  });
});

// ------------------------------------------------------------------ real server + SQLite

class Client {
  constructor(port) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    this.opened = new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.closed = new Promise((res) => this.ws.once('close', res));
    this.ws.on('message', (d) => {
      const m = JSON.parse(d);
      this.messages.push(m);
      this.waiters = this.waiters.filter((w) => !w(m));
    });
  }
  next(pred, timeout = 4000) {
    const i = this.messages.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.messages.splice(i, 1)[0]);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timed out')), timeout);
      this.waiters.push((m) => { if (!pred(m)) return false; clearTimeout(t); res(m); return true; });
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  async join(f = {}) { await this.opened; this.send({ type: 'join', ...f }); return this.next((m) => m.type === 'welcome'); }
  act(verb, args, seq) { this.send({ type: 'action', verb, args, seq }); return this.next((m) => m.type === 'actionResult' && m.seq === seq); }
  close() { this.ws.close(); return this.closed; }
}

describe('server: persistence and character isolation over WebSocket + SQLite', () => {
  test('a disease survives reconnect with its progress; the second character stays healthy', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dfw-conditions-'));
    const world = { wall: WORLD_EPOCH_MS + 7200_000 };
    const fixture = (ctx) => {
      ctx.onJoin((p) => { p.rpg.character ??= sheet(); p.rpg.gold ??= 0; });
      // Test-only lever: stands in for a monster bite so the outcome is deterministic.
      ctx.onAction('test.catch', (p, { disease }) => { if (!ctx.services.makeDiseased(p, disease)) throw new Error('not contracted'); });
      ctx.onAction('test.sleep', (p, { hours }) => { ctx.services.spendTime(p, hours * 60, 'rest'); });
    };
    const server = createGameServer({
      host: '127.0.0.1', port: 0, dbPath: join(dir, 'game.db'), allowGuests: true,
      clientDir: join(dir, 'c'), siteDir: join(dir, 's'),
      features: [
        { name: 'atmosphere', install: (ctx) => installAtmosphere(ctx, { wallNow: () => world.wall }) },
        { name: 'calendar', install: installCalendar },
        { name: 'conditions', install: (ctx) => installConditions(ctx, { random: seededRandom(9) }) },
        { name: 'fixture', install: fixture },
      ],
    });
    const { port } = await server.start();
    try {
      const a = new Client(port);
      const wa = await a.join({ name: 'Ailing' });
      const b = new Client(port);
      const wb = await b.join({ name: 'Hale' });
      assert.equal((await a.act('test.catch', { disease: 'Plague' }, 1)).ok, true);
      assert.equal((await a.act('test.sleep', { hours: 30 }, 2)).ok, true);
      const sick = await a.next((m) => m.type === 'rpg' && m.character?.conditions?.diseases?.[0]?.incubationOver === true, 6000);
      const loss = sick.character.conditions.diseases[0].loss.Strength;
      assert.ok(loss > 0);
      const diag = await a.next((m) => m.type === 'gameEvent' && m.event.kind === 'condition' && m.event.change === 'diagnosed');
      assert.match(diag.event.text, /plague/i);
      await a.close();
      // Reconnect: same token, same disease record and accumulated damage from SQLite.
      await new Promise((r) => setTimeout(r, 200));
      const a2 = new Client(port);
      const again = await a2.join({ token: wa.token });
      assert.equal(again.id, wa.id);
      const back = await a2.next((m) => m.type === 'rpg' && m.character?.conditions);
      assert.equal(back.character.conditions.diseases[0].type, 1);
      assert.ok(back.character.conditions.diseases[0].loss.Strength >= loss, 'damage persisted');
      const hb = await b.next((m) => m.type === 'rpg' && m.character?.conditions);
      assert.deepEqual(hb.character.conditions.diseases, [], 'the other character never caught it');
      assert.equal((await a2.act('conditions.status', {}, 3)).ok, true);
      const report = await a2.next((m) => m.type === 'gameEvent' && m.event.change === 'status');
      assert.match(report.event.text, /plague/i);
      await a2.close();
      await b.close();
      assert.ok(wb.id !== wa.id);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
