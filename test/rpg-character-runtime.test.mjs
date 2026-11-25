// Character feature inside the real gameplay runtime: transactions, rollback, persistence and snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as character from '../server/rpg/character.js';
import { install as inventory } from '../server/rpg/inventory.js';
import * as R from '../client/gameplay/character/rules.js';
import { CharacterDraft } from '../client/gameplay/character/draft.js';

function harness({ careers } = {}) {
  const players = new Map();
  const saved = new Map();
  const sent = [];
  let clock = 10_000;
  const rt = createRpgRuntime({
    players,
    features: [
      { name: 'character', install: (ctx) => character.install(Object.assign(ctx, { careers })) },
      { name: 'inventory', install: inventory },
    ],
    save: (list) => { for (const p of list) saved.set(p.id, JSON.parse(JSON.stringify(p.rpg))); },
    send: (p, msg) => sent.push({ to: p.id, msg }),
    now: () => clock,
    log: { error() {}, warn() {}, info() {} },
  });
  return {
    rt, players, saved, sent,
    advance(ms) { clock += ms; },
    join(id, rpg) {
      const p = { id, name: `Guest${id}`, x: 0, z: 0, yaw: 0, moving: false, rpg: rpg ? structuredClone(rpg) : {} };
      players.set(id, p);
      rt.join(p);
      return p;
    },
    lastRpg(id) { return sent.filter((s) => s.to === id && s.msg.type === 'rpg').at(-1)?.msg; },
  };
}

/** Drives the browser draft model exactly as the wizard does, against the real server. */
function createViaDraft(h, p, { cls = 'Nightblade', race = 'Wood Elf' } = {}) {
  const d = new CharacterDraft(p.name);
  d.race = race; d.next();
  d.gender = 'Female'; d.next();
  d.chooseClass(cls); d.next();
  assert.equal(d.step, 'biography'); d.next(); // no classic data in this world: nothing to answer
  d.name = 'Ithria'; d.next();
  d.faceIndex = 4; d.next();
  assert.equal(d.step, 'attributes');
  h.advance(1000);
  const r = h.rt.act(p, 'character.roll', d.rollRequest());
  assert.deepEqual(r, { ok: true });
  h.rt.sync([p]);
  d.syncRoll(h.lastRpg(p.id).character.character.draft);
  assert.match(d.stepProblem(), /Distribute all bonus points/);
  d.autoDistribute('attributes'); d.next();
  d.autoDistribute('skills'); d.next();
  d.reflexes = 'Low'; d.next();
  assert.equal(d.step, 'summary');
  assert.equal(d.finalProblem(), null);
  return { d, result: h.rt.act(p, 'character.create', d.createRequest()) };
}

test('wizard model + runtime: create, persist, snapshot, rejoin', () => {
  const h = harness();
  const p = h.join(1);
  assert.equal(p.rpg.character.created, false);
  const { d, result } = createViaDraft(h, p);
  assert.deepEqual(result, { ok: true });
  const ch = p.rpg.character;
  assert.equal(ch.created, true);
  assert.equal(ch.name, 'Ithria');
  assert.equal(ch.reflexes, 'Low');
  assert.equal(ch.faceIndex, 4);
  assert.deepEqual(ch.attributes, d.attributes);
  // Saved in the action's transaction, and the client got a fresh snapshot with the sheet.
  assert.equal(h.saved.get(1).character.created, true);
  const snap = h.lastRpg(1);
  assert.equal(snap.character.character.className, 'Nightblade');
  assert.ok(h.sent.some((s) => s.msg.type === 'gameEvent' && s.msg.event.kind === 'characterCreated'));

  // A new server instance loads the saved row and keeps it as is.
  const h2 = harness();
  const again = h2.join(1, h.saved.get(1));
  assert.deepEqual(again.rpg.character, ch);
  assert.equal(h2.rt.act(again, 'character.roll', { className: 'Mage' }).error, 'Your character has already been created.');
});

test('career equipment restrictions apply at creation, equip, Use and reconnect', () => {
  const careers = { ...R.CLASS_BY_NAME, Mage: {
    ...R.CLASS_BY_NAME.Mage,
    disadvantages: [
      { key: 'forbiddenWeaponry', option: 'Long Blade' },
      { key: 'forbiddenMaterial', option: 'Steel' },
      { key: 'forbiddenArmorType', option: 'Chain' },
      { key: 'forbiddenShieldTypes', option: 'Buckler' },
    ],
  } };
  const h = harness({ careers });
  const mage = h.join(11);
  const warrior = h.join(12);
  assert.ok(mage.rpg.equipment.rightHand, 'legacy default adventurer wore the starter sword');
  assert.ok(createViaDraft(h, mage, { cls: 'Mage', race: 'High Elf' }).result.ok);
  assert.ok(createViaDraft(h, warrior, { cls: 'Warrior', race: 'Nord' }).result.ok);
  assert.equal(mage.rpg.equipment.rightHand, undefined);
  for (const [template, answer] of [
    ['iron-longsword', /Long Blade/], ['steel-dagger', /Steel/], ['chain-cuirass', /Chain/], ['buckler', /Buckler/],
  ]) {
    const item = h.rt.ctx.services.giveItem(mage, template);
    const unrestricted = h.rt.ctx.services.giveItem(warrior, template);
    assert.match(h.rt.act(mage, 'inventory.equip', { itemId: item.id }).error, answer);
    assert.match(h.rt.act(mage, 'inventory.use', { itemId: item.id }).error, answer);
    assert.ok(h.rt.act(warrior, 'inventory.equip', { itemId: unrestricted.id }).ok);
  }
  const saved = structuredClone(h.lastRpg(11).character);
  const retained = saved.inventory.find((i) => i.template === 'iron-longsword');
  saved.equipment.rightHand = retained.id;
  const next = harness({ careers }).join(11, saved);
  assert.equal(next.rpg.equipment.rightHand, undefined);
  assert.ok(next.rpg.inventory.some((i) => i.id === retained.id), 'forbidden equipment stays in the pack');
});

test('rule violations reach the player verbatim and roll back nothing-but-everything', () => {
  const h = harness();
  const p = h.join(2);
  h.advance(1000);
  h.rt.act(p, 'character.roll', { className: 'Warrior' });
  const draftBefore = structuredClone(p.rpg.character.draft);
  const savesBefore = h.saved.get(2);
  const r = h.rt.act(p, 'character.create', {
    name: 'Bob', race: 'Nord', gender: 'Male',
    attributes: { ...draftBefore.attributeBase, Strength: 100 },
    skills: draftBefore.skillBase,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /bonus points|cannot exceed/);
  assert.deepEqual(p.rpg.character.draft, draftBefore, 'draft unchanged after a failed create');
  assert.equal(p.rpg.character.created, false);
  assert.equal(h.saved.get(2), savesBefore, 'nothing saved');

  h.advance(1000);
  const bad = h.rt.act(p, 'character.roll', { custom: { name: 'Godking', hitPointsPerLevel: 30, attributes: Object.fromEntries(R.ATTRIBUTES.map((a) => [a, 75])), primarySkills: [], majorSkills: [], minorSkills: [] } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Attributes must total 400/);

  // Oversized or polluted payloads are refused by the runtime before reaching the feature.
  assert.equal(h.rt.act(p, 'character.create', { __proto__: { x: 1 }, constructor: 1 }).ok, false);
});

test('skill use from other features levels the character up through the runtime tick', () => {
  const h = harness();
  const p = h.join(3);
  createViaDraft(h, p, { cls: 'Warrior', race: 'Redguard' });
  const ch = p.rpg.character;
  const career = R.CLASS_BY_NAME.Warrior;
  for (let i = 0; i < 40 && ch.level < 2; i++) {
    for (const s of career.primarySkills) h.rt.ctx.services.advanceSkill(p, s, 100);
    h.advance(character.SKILL_CHECK_MS);
    h.rt.tick(1);
  }
  assert.equal(ch.level, 2);
  assert.ok(ch.bonusPoints >= 4);
  const next = { ...ch.attributes };
  next.Strength = Math.min(100, next.Strength + ch.bonusPoints);
  next.Luck += ch.bonusPoints - (next.Strength - ch.attributes.Strength);
  assert.deepEqual(h.rt.act(p, 'character.levelUp', { attributes: next }), { ok: true });
  assert.equal(h.saved.get(3).character.bonusPoints, 0);
  assert.equal(h.saved.get(3).character.attributes.Strength, next.Strength);
});

test('operator CLASS*.CFG careers are authoritative end to end: the wizard spends against the served lists', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { encodeClassCfg } = await import('../client/gameplay/character/cfg.js');
  const dir = mkdtempSync(join(tmpdir(), 'dfw-arena2-'));
  try {
    // A Warrior whose groups disagree with the built-in table (Giantish primary, Long Blade minor...).
    const std = R.CLASS_BY_NAME.Warrior;
    const odd = { ...std, hitPointsPerLevel: 15, primarySkills: ['Giantish', 'Axe', 'Swimming'], majorSkills: ['Orcish', 'Jumping', 'Running'], minorSkills: ['Long Blade', 'Archery', 'Dodging', 'Medical', 'Climbing', 'Etiquette'] };
    writeFileSync(join(dir, 'CLASS16.CFG'), encodeClassCfg(odd));
    const players = new Map();
    const saved = new Map();
    const sent = [];
    let clock = 0;
    const rt = createRpgRuntime({
      players, dataPath: dir,
      features: [{ name: 'character', install: character.install }],
      save: (list) => { for (const p of list) saved.set(p.id, JSON.parse(JSON.stringify(p.rpg))); },
      send: (p, msg) => sent.push({ to: p.id, msg }),
      now: () => (clock += 1000),
      log: { error() {}, warn() {}, info() {} },
    });
    const p = { id: 9, name: 'Rowan', x: 0, z: 0, yaw: 0, moving: false, rpg: {} };
    players.set(9, p);
    rt.join(p);

    const d = new CharacterDraft(p.name);
    d.race = 'Breton'; d.next(); d.gender = 'Male'; d.next();
    d.chooseClass('Warrior'); d.next(); d.next(); d.next(); d.next();
    assert.deepEqual(d.career().primarySkills, [...std.primarySkills], 'before the roll: built-in preview');
    assert.deepEqual(rt.act(p, 'character.roll', d.rollRequest()), { ok: true });
    rt.sync([p]);
    const served = sent.filter((s) => s.msg.type === 'rpg').at(-1).msg.character.character.draft;
    assert.equal(served.career.source, 'cfg');
    assert.deepEqual(served.career.primarySkills, odd.primarySkills);
    d.syncRoll(served);
    assert.deepEqual(d.career().primarySkills, odd.primarySkills, 'after the roll: the server lists');
    d.autoDistribute('attributes'); d.next();
    d.autoDistribute('skills'); d.next(); d.next();
    assert.equal(d.finalProblem(), null);
    // Built-in lists would have been rejected:
    assert.throws(() => R.validateSkillSpend(served.skillBase, odd, (() => {
      const s = { ...served.skillBase };
      for (const [, list] of R.groupsOf(std)) R.spendLowest(s, list, 6);
      return s;
    })()), /not one of your class skills|Distribute all/);
    assert.deepEqual(rt.act(p, 'character.create', d.createRequest()), { ok: true });
    const ch = p.rpg.character;
    assert.equal(ch.maxHealth, 25 + 15);
    assert.equal(ch.career.source, 'cfg');
    assert.deepEqual(ch.career.minorSkills, odd.minorSkills);
    assert.ok(ch.skills.Giantish >= 28 + 0 && ch.skills.Giantish <= 31 + 6);
    // A forged career in the saved row is replaced on load.
    const row = structuredClone(saved.get(9));
    row.character.career.primarySkills = ['Mysticism', 'Illusion', 'Daedric'];
    const p2 = { id: 9, name: 'Rowan', x: 0, z: 0, yaw: 0, moving: false, rpg: row };
    players.set(9, p2);
    rt.join(p2);
    assert.deepEqual(p2.rpg.character.career.primarySkills, odd.primarySkills);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
