// Social feature inside the real RPG runtime with the real inventory feature:
// atomic two-character saves, rollback of session state on save failure, repeated-request guards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import * as inventory from '../server/rpg/inventory.js';
import * as social from '../server/rpg/social.js';

const flush = () => new Promise((r) => setImmediate(r));

function setup({ muted = new Set() } = {}) {
  const players = new Map();
  const db = new Map(); // id -> last committed rpg
  const sent = new Map();
  const saves = [];
  let failNextSave = false;
  const quiet = { error() {}, warn() {}, log() {} };
  const rt = createRpgRuntime({
    players,
    features: [inventory, social],
    log: quiet,
    services: { isMuted: (p) => muted.has(p.id) },
    save(list) {
      if (failNextSave) {
        failNextSave = false;
        throw new Error('disk full');
      }
      saves.push(list.map((p) => p.id).sort());
      for (const p of list) db.set(p.id, structuredClone(p.rpg));
    },
    send(p, msg) {
      (sent.get(p.id) ?? sent.set(p.id, []).get(p.id)).push(msg);
    },
  });
  const join = (id, name, rpg = {}) => {
    const p = { id, name, x: 0, z: 0, yaw: 0, moving: false, rpg: structuredClone(rpg) };
    players.set(id, p);
    rt.join(p);
    return p;
  };
  const leave = (p) => {
    rt.leave(p);
    players.delete(p.id);
  };
  const act = (p, verb, args) => rt.act(p, verb, args);
  const ok = (p, verb, args) => {
    const r = act(p, verb, args);
    assert.equal(r.error, undefined, `${verb} failed: ${r.error}`);
    return r;
  };
  const socialOf = (p) =>
    (sent.get(p.id) ?? []).filter((m) => m.type === 'gameEvent' && m.event.social).at(-1)?.event.social;
  const texts = (p) => (sent.get(p.id) ?? []).filter((m) => m.type === 'gameEvent' && m.event.text).map((m) => m.event.text);
  const chats = (p) => (sent.get(p.id) ?? []).filter((m) => m.type === 'gameEvent' && m.event.kind === 'chat').map((m) => m.event);
  return { rt, players, db, saves, join, leave, act, ok, socialOf, texts, chats, failSave: () => (failNextSave = true) };
}

const goldSum = (...ps) => ps.reduce((n, p) => n + p.rpg.gold, 0);
const count = (p, template) => p.rpg.inventory.filter((i) => i.template === template).reduce((n, i) => n + i.quantity, 0);

function tradeReady(w, a, b, offerA, offerB) {
  w.ok(a, 'trade.request', { targetId: b.id });
  const id = w.socialOf(b).trade.id;
  w.ok(b, 'trade.accept', { tradeId: id });
  if (offerA) w.ok(a, 'trade.offer', { tradeId: id, ...offerA });
  if (offerB) w.ok(b, 'trade.offer', { tradeId: id, ...offerB });
  return { id, rev: w.socialOf(a).trade.revision };
}

test('real inventory: trade commits both characters in one save and keeps item records', () => {
  const w = setup();
  const a = w.join(1, 'Ada');
  const b = w.join(2, 'Bram');
  const sword = w.rt.ctx.services.giveItem(a, 'iron-longsword');
  sword.condition = 55;
  const potionId = w.rt.ctx.services.giveItem(b, 'potion-of-healing', 4).id;
  const gold0 = goldSum(a, b);
  const swords0 = [count(a, 'iron-longsword'), count(b, 'iron-longsword')];
  const potions0 = [count(a, 'potion-of-healing'), count(b, 'potion-of-healing')];
  const { id, rev } = tradeReady(w, a, b, { items: [{ id: sword.id }], gold: 7 }, { items: [{ id: potionId, quantity: 3 }] });
  w.ok(a, 'trade.confirm', { tradeId: id, revision: rev });
  w.saves.length = 0;
  w.ok(b, 'trade.confirm', { tradeId: id, revision: rev });
  assert.deepEqual(w.saves, [[1, 2]], 'one transaction covering both characters');
  assert.deepEqual([count(a, 'iron-longsword'), count(b, 'iron-longsword')], [swords0[0] - 1, swords0[1] + 1]);
  assert.ok(b.rpg.inventory.some((i) => i.template === 'iron-longsword' && i.condition === 55), 'condition kept');
  assert.ok(!a.rpg.inventory.some((i) => i.id === sword.id));
  assert.deepEqual([count(a, 'potion-of-healing'), count(b, 'potion-of-healing')], [potions0[0] + 3, potions0[1] - 3]);
  assert.equal(goldSum(a, b), gold0);
  assert.equal(w.db.get(1).gold, a.rpg.gold);
  assert.equal(w.db.get(2).gold, b.rpg.gold);
  // Repeated confirm after settlement cannot transfer again.
  assert.match(w.act(b, 'trade.confirm', { tradeId: id, revision: rev }).error, /no longer open/);
  assert.match(w.act(a, 'trade.confirm', { tradeId: id, revision: rev }).error, /no longer open/);
  assert.equal(goldSum(a, b), gold0);
  assert.equal(count(b, 'iron-longsword'), swords0[1] + 1);
});

test('save failure during settlement rolls back items, gold and the trade session', async () => {
  const w = setup();
  const a = w.join(1, 'Ada');
  const b = w.join(2, 'Bram');
  const sword = w.rt.ctx.services.giveItem(a, 'iron-longsword');
  const s0 = [count(a, 'iron-longsword'), count(b, 'iron-longsword')];
  const { id, rev } = tradeReady(w, a, b, { items: [{ id: sword.id }] }, { gold: 20 });
  w.ok(a, 'trade.confirm', { tradeId: id, revision: rev });
  const before = [structuredClone(a.rpg), structuredClone(b.rpg)];
  w.failSave();
  const r = w.act(b, 'trade.confirm', { tradeId: id, revision: rev });
  assert.match(r.error, /could not save/);
  await flush();
  assert.deepEqual([a.rpg, b.rpg], before, 'both characters restored');
  const t = w.socialOf(b).trade;
  assert.equal(t?.id, id, 'trade session restored, still open');
  assert.equal(t.mine.confirmed, false);
  assert.equal(t.theirs.confirmed, true);
  // Retrying after the fault settles exactly once.
  w.ok(b, 'trade.confirm', { tradeId: id, revision: rev });
  assert.deepEqual([count(a, 'iron-longsword'), count(b, 'iron-longsword')], [s0[0] - 1, s0[1] + 1]);
  assert.ok(w.db.get(2).inventory.some((i) => i.id === sword.id || i.template === 'iron-longsword'));
  assert.ok(!w.db.get(1).inventory.some((i) => i.id === sword.id), 'committed row no longer has it');
  assert.match(w.act(b, 'trade.confirm', { tradeId: id, revision: rev }).error, /no longer open/);
});

test('save failure on party accept leaves no phantom membership; repeat accept is refused', async () => {
  const w = setup();
  const a = w.join(1, 'Ada');
  const b = w.join(2, 'Bram');
  w.ok(a, 'party.invite', { targetId: b.id });
  w.failSave();
  assert.match(w.act(b, 'party.accept', { fromId: a.id }).error, /could not save/);
  await flush();
  assert.equal(a.rpg.party, undefined);
  assert.equal(b.rpg.party, undefined);
  assert.equal(w.rt.ctx.services.partyOf(a), null, 'in-memory party rolled back');
  assert.equal(w.socialOf(b).invites.length, 1, 'invitation restored for a retry');
  w.ok(b, 'party.accept', { fromId: a.id });
  assert.deepEqual(w.rt.ctx.services.partyOf(b).memberIds.sort(), [1, 2]);
  assert.equal(w.db.get(1).party.id, w.db.get(2).party.id);
  assert.match(w.act(b, 'party.accept', { fromId: a.id }).error, /Leave your current party|no longer open/);
  assert.match(w.act(a, 'party.invite', { targetId: b.id }).error, /already in a party/);
  // Repeated trade acceptance is refused too.
  w.ok(a, 'trade.request', { targetId: b.id });
  const tid = w.socialOf(b).trade.id;
  w.ok(b, 'trade.accept', { tradeId: tid });
  assert.match(w.act(b, 'trade.accept', { tradeId: tid }).error, /no trade request waiting/);
});

test('save failure on leave keeps the party intact in memory and on disk', async () => {
  const w = setup();
  const a = w.join(1, 'Ada');
  const b = w.join(2, 'Bram');
  w.ok(a, 'party.invite', { targetId: b.id });
  w.ok(b, 'party.accept', { fromId: a.id });
  w.failSave();
  assert.match(w.act(b, 'party.leave').error, /could not save/);
  await flush();
  assert.deepEqual(w.rt.ctx.services.partyOf(a)?.memberIds.sort(), [1, 2]);
  assert.ok(b.rpg.party && a.rpg.party);
  // A later social action also reconciles synchronously even before the microtask.
  w.failSave();
  w.act(a, 'party.kick', { targetId: b.id });
  w.ok(a, 'social.sync');
  assert.deepEqual(w.rt.ctx.services.partyOf(a)?.memberIds.sort(), [1, 2]);
});

test('mutes and rate limits apply to party, region and global chat in the runtime', () => {
  const w = setup({ muted: new Set([2]) });
  const a = w.join(1, 'Ada');
  const b = w.join(2, 'Bram');
  w.ok(a, 'party.invite', { targetId: b.id });
  w.ok(b, 'party.accept', { fromId: a.id });
  for (const channel of ['party', 'region', 'global']) {
    assert.match(w.act(b, 'chat.send', { channel, text: 'hello' }).error, /muted/, channel);
  }
  assert.equal(w.chats(a).length, 0);
  // The runtime's per-player chat bucket (shared with location chat) is honoured.
  a.chatOk = () => false;
  assert.match(w.act(a, 'chat.send', { channel: 'global', text: 'x' }).error, /too fast/);
  delete a.chatOk;
  w.ok(a, 'chat.send', { channel: 'party', text: 'regroup' });
  assert.equal(w.chats(b).at(-1).text, 'regroup');
});

test('disconnect mid-trade cancels it and never moves items', async () => {
  const w = setup();
  const a = w.join(1, 'Ada');
  const b = w.join(2, 'Bram');
  const sword = w.rt.ctx.services.giveItem(a, 'iron-longsword');
  const s0 = [count(a, 'iron-longsword'), count(b, 'iron-longsword')];
  const { id, rev } = tradeReady(w, a, b, { items: [{ id: sword.id }] });
  w.ok(a, 'trade.confirm', { tradeId: id, revision: rev });
  w.leave(b);
  assert.equal(w.socialOf(a).trade, null);
  assert.ok(w.texts(a).some((t) => /left/.test(t)));
  assert.equal(count(a, 'iron-longsword'), s0[0]);
  const b2 = w.join(2, 'Bram', w.db.get(2) ?? {});
  assert.match(w.act(b2, 'trade.confirm', { tradeId: id, revision: rev }).error, /no longer open/);
  assert.equal(count(b2, 'iron-longsword'), s0[1]);
});
