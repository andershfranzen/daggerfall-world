// Unit tests for the RPG runtime: feature registry, action transactions, validation, snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createRpgRuntime,
  validateArgs,
  userMessage,
  isValidVerb,
  ActionError,
  DEFAULT_LOCATION,
} from '../server/rpg/runtime.js';
import { openStore, SCHEMA_VERSION, hashToken, newToken } from '../server/db.js';
import { PRODUCTION_FEATURES } from '../server/game.js';

const quiet = { error() {}, warn() {}, log() {} };

function player(id, rpg = {}) {
  return { id, name: `P${id}`, x: 0, z: 0, yaw: 0, moving: false, rpg, dirty: false };
}

test('a failed purchase preserves a queued restock for the next world save', () => {
  const p = player(1);
  const players = new Map([[p.id, p]]);
  const key = 'npcshop:general';
  let failSave = true;
  const runtime = createRpgRuntime({
    players, send() {}, log: quiet, save() { if (failSave) throw new Error('disk full'); },
    features: [{ name: 'shop', install(ctx) {
      ctx.onAction('shop.buy', () => ctx.dirtyWorld(key, { potions: 3 }));
    } }],
  });
  const restock = [[key, { potions: 4 }]];
  runtime.restorePendingWorld(restock);
  assert.equal(runtime.act(p, 'shop.buy', {}).ok, false);
  assert.deepEqual(runtime.takePendingWorld(), restock);
  runtime.restorePendingWorld(restock);
  failSave = false;
  assert.equal(runtime.act(p, 'shop.buy', {}).ok, true);
  assert.deepEqual(runtime.takePendingWorld(), []);
});

function bankFeature(ctx) {
  ctx.onJoin((p) => {
    p.rpg.gold ??= 100;
    p.rpg.joins = (p.rpg.joins ?? 0) + 1;
  });
  ctx.onAction('bank.give', (p, { targetId, amount }) => {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error('amount must be a positive whole number');
    const t = ctx.players.get(targetId);
    if (!t || t === p || ctx.location(t) !== ctx.location(p)) throw new Error('no such player nearby');
    if (p.rpg.gold < amount) throw new Error('not enough gold');
    ctx.dirty(t);
    p.rpg.gold -= amount;
    t.rpg.gold += amount;
    ctx.notify(t, { kind: 'gift', from: p.id, amount });
    ctx.emit('gave', { from: p, to: t, amount });
  });
  ctx.onAction('bank.bug', (p) => {
    p.rpg.gold = 0;
    null.boom; // internal error after a mutation
  });
}

function setup({ features = [bankFeature], save } = {}) {
  const players = new Map();
  const sent = [];
  const saves = [];
  const rt = createRpgRuntime({
    players,
    features,
    save: save ?? ((list) => saves.push(list.map((p) => p.id))),
    send: (p, msg) => sent.push([p.id, msg]),
    log: quiet,
  });
  const add = (id, rpg) => {
    const p = player(id, rpg);
    players.set(id, p);
    rt.join(p);
    return p;
  };
  return { rt, players, sent, saves, add };
}

test('features install once per runtime with isolated state and services', () => {
  let installs = 0;
  const counter = (ctx) => {
    installs++;
    let n = 0; // instance state lives in install
    ctx.services.count = () => ++n;
  };
  const a = setup({ features: [counter] });
  const b = setup({ features: [{ name: 'counter', install: counter }] });
  assert.equal(installs, 2);
  assert.equal(a.rt.ctx.services.count(), 1);
  assert.equal(a.rt.ctx.services.count(), 2);
  assert.equal(b.rt.ctx.services.count(), 1);
  assert.deepEqual(b.rt.installed, ['counter']);
  assert.throws(() => setup({ features: [{ nope: 1 }] }), /install/);
  assert.throws(
    () => setup({ features: [(c) => c.onAction('x.y', () => {}), (c) => c.onAction('x.y', () => {})] }),
    /already registered/
  );
  assert.throws(() => setup({ features: [(c) => c.onAction('BadVerb', () => {})] }), /invalid action verb/);
  assert.ok(Array.isArray(PRODUCTION_FEATURES), 'production manifest exports an array');
});

test('join applies defaults and location; successful action saves all affected players in one call', () => {
  const { rt, add, sent, saves } = setup();
  const a = add(1);
  const b = add(2, { gold: 5, joins: 3 });
  assert.equal(a.rpg.location, DEFAULT_LOCATION);
  assert.equal(a.rpg.gold, 100);
  assert.equal(b.rpg.gold, 5);
  assert.equal(b.rpg.joins, 4);

  let emitted = null;
  rt.ctx.on('gave', (e) => (emitted = e.amount));
  sent.length = 0;
  assert.deepEqual(rt.act(a, 'bank.give', { targetId: 2, amount: 30 }), { ok: true });
  assert.equal(a.rpg.gold, 70);
  assert.equal(b.rpg.gold, 35);
  assert.equal(emitted, 30);
  assert.deepEqual(saves, [[1, 2]]); // one transaction, both characters
  const gift = sent.find(([id, m]) => id === 2 && m.type === 'gameEvent');
  assert.deepEqual(gift[1].event, { kind: 'gift', from: 1, amount: 30 });
  // Both get a fresh private snapshot.
  assert.ok(sent.some(([id, m]) => id === 1 && m.type === 'rpg' && m.character.gold === 70));
  assert.ok(sent.some(([id, m]) => id === 2 && m.type === 'rpg' && m.character.gold === 35));
});

test('failed actions roll back every affected player and drop buffered events', () => {
  let failSave = false;
  const { rt, add, sent } = setup({
    save: () => {
      if (failSave) throw Object.assign(new Error('SQLITE_FULL: database or disk is full'), { code: 'ERR_SQLITE_ERROR' });
    },
  });
  const a = add(1);
  const b = add(2);
  const inv = a.rpg; // identity is preserved across rollback

  sent.length = 0;
  failSave = true;
  const r = rt.act(a, 'bank.give', { targetId: 2, amount: 40 });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not save/);
  assert.doesNotMatch(r.error, /SQLITE/);
  assert.equal(a.rpg.gold, 100);
  assert.equal(b.rpg.gold, 100);
  assert.equal(a.rpg, inv);
  assert.equal(sent.filter(([, m]) => m.type === 'gameEvent').length, 0);

  failSave = false;
  const bug = rt.act(a, 'bank.bug', {});
  assert.deepEqual(bug, { ok: false, error: 'action failed' }); // internal TypeError is not shown
  assert.equal(a.rpg.gold, 100);

  assert.deepEqual(rt.act(a, 'bank.give', { targetId: 2, amount: 1000 }), { ok: false, error: 'not enough gold' });
  assert.deepEqual(rt.act(a, 'bank.give', { targetId: 1, amount: 1 }), { ok: false, error: 'no such player nearby' });
  assert.match(rt.act(a, 'bank.steal', {}).error, /unknown action/);
  assert.equal(rt.act(a, 'Bank.Give!', {}).error, 'invalid action');
});

test('action args are validated before handlers run', () => {
  assert.deepEqual(validateArgs(undefined), {});
  assert.deepEqual(validateArgs(null), {});
  assert.deepEqual(validateArgs({ a: [1, 'x', { b: true }] }), { a: [1, 'x', { b: true }] });
  for (const bad of [[1], 'x', 5, JSON.parse('{"__proto__":{"polluted":1}}'), { constructor: 1 }, { n: Infinity }]) {
    assert.throws(() => validateArgs(bad), ActionError, JSON.stringify(bad));
  }
  let deep = {};
  for (let i = 0; i < 10; i++) deep = { d: deep };
  assert.throws(() => validateArgs(deep), /deeply/);
  assert.throws(() => validateArgs({ s: 'x'.repeat(2000) }), /too long/);
  assert.throws(() => validateArgs({ a: Array.from({ length: 300 }, () => 0) }), /too large/);
  assert.equal({}.polluted, undefined);

  assert.ok(isValidVerb('combat.attack'));
  assert.ok(isValidVerb('inventory.equip'));
  assert.ok(!isValidVerb('attack'));
  assert.ok(!isValidVerb('a.b c'));
  assert.equal(userMessage(new Error('Not enough gold')), 'Not enough gold');
  assert.equal(userMessage(new TypeError('x is undefined')), 'action failed');
  assert.equal(userMessage(new ActionError('Too far away')), 'Too far away');
  assert.equal(userMessage('string'), 'action failed');
});

test('snapshots: per-location entities and peers, private fields stripped, unchanged snapshots not resent', () => {
  const { rt, add, sent } = setup({
    features: [
      (ctx) => {
        ctx.entities.set('rat', { id: 'rat', kind: 'monster', name: 'Rat', location: DEFAULT_LOCATION, x: 1, z: 2, yaw: 0, hp: 3, maxHp: 3, _ai: { plan: 'bite' } });
        ctx.entities.set('ghost', { id: 'ghost', kind: 'monster', name: 'Ghost', location: 'dungeon:Crypt', x: 0, z: 0, yaw: 0 });
        ctx.entities.set('secret', { id: 'secret', kind: 'item', name: 'Key', location: DEFAULT_LOCATION, x: 0, z: 0, yaw: 0, visibleTo: [2] });
      },
    ],
  });
  const a = add(1, { readied: true, inventory: [{ id: 'w1', template: 'iron-longsword', name: 'Iron Longsword', quantity: 1 }], equipment: { rightHand: 'w1' } });
  const b = add(2);
  sent.length = 0;
  rt.sync();
  const ma = sent.find(([id]) => id === 1)[1];
  const mb = sent.find(([id]) => id === 2)[1];
  assert.equal(ma.type, 'rpg');
  assert.equal(ma.selfId, 1);
  assert.deepEqual(ma.entities.map((e) => e.id), ['rat']);
  assert.equal(ma.entities[0]._ai, undefined);
  assert.deepEqual(mb.entities.map((e) => e.id).sort(), ['rat', 'secret']);
  assert.equal(mb.entities.find((e) => e.id === 'secret').visibleTo, undefined);
  assert.deepEqual(mb.peers, [{ id: 1, name: 'P1', x: 0, z: 0, yaw: 0, moving: false, readied: true, weapon: { template: 'iron-longsword', name: 'Iron Longsword' } }]);
  assert.equal(mb.peers[0].inventory, undefined); // private data never in peers

  // Appearance identifiers from the character sheet are public; the rest of the sheet is not.
  a.rpg.character = {
    name: 'Secret Name', race: 'Breton', gender: 'Female', className: 'Spellsword',
    attributes: { Strength: 50 }, skills: { Destruction: 30 }, health: 12, maxHealth: 20, gold: 5, faceIndex: 3,
  };
  sent.length = 0;
  rt.sync();
  const appearance = sent.find(([id]) => id === 2)[1].peers[0];
  assert.deepEqual(appearance, {
    id: 1, name: 'P1', x: 0, z: 0, yaw: 0, moving: false, readied: true,
    race: 'Breton', gender: 'Female', className: 'Spellsword',
    weapon: { template: 'iron-longsword', name: 'Iron Longsword' },
  });
  a.rpg.character.race = { evil: true }; // non-string values are never forwarded
  sent.length = 0;
  rt.sync();
  assert.equal(sent.find(([id]) => id === 2)[1].peers[0].race, undefined);
  delete a.rpg.character;
  rt.sync();

  sent.length = 0;
  rt.sync();
  assert.equal(sent.length, 0, 'unchanged snapshots are not resent');
  a.x = 5; // peer movement alone streams through `state`
  rt.sync();
  assert.equal(sent.length, 0);
  rt.entities.get('rat').hp = 2;
  rt.sync();
  assert.deepEqual(sent.map(([id]) => id).sort(), [1, 2]);

  sent.length = 0;
  a.rpg.location = 'dungeon:Crypt';
  rt.sync();
  const moved = sent.find(([id]) => id === 1)[1];
  assert.deepEqual(moved.entities.map((e) => e.id), ['ghost']);
  assert.deepEqual(moved.peers, []);
  assert.deepEqual(sent.find(([id]) => id === 2)[1].peers, []);

  rt.resetSync(b);
  sent.length = 0;
  rt.sync([b]);
  assert.equal(sent.length, 1, 'a replaced session gets a full snapshot');
});

test('tick, leave, events and dirty outside actions', () => {
  const log = [];
  const { rt, add, sent } = setup({
    features: [
      (ctx) => {
        ctx.onTick((dt, now) => log.push(['tick', dt, typeof now]));
        ctx.onTick(() => {
          throw new Error('one broken tick handler does not stop others');
        });
        ctx.onLeave((p) => {
          for (const q of ctx.players.values()) {
            if (q !== p) {
              ctx.dirty(q);
              q.rpg.partner = null;
              ctx.notify(q, { kind: 'partyLeft', playerId: p.id });
            }
          }
        });
      },
    ],
  });
  const a = add(1);
  const b = add(2, { partner: 1 });
  rt.tick(0.04, 1234);
  assert.deepEqual(log, [['tick', 0.04, 'number']]);
  b.dirty = false;
  rt.ctx.dirty(b);
  assert.equal(b.dirty, true);
  sent.length = 0;
  const toSave = rt.leave(a);
  assert.deepEqual(toSave.map((p) => p.id).sort(), [1, 2]);
  assert.equal(b.rpg.partner, null);
  assert.deepEqual(sent.map(([id, m]) => [id, m.event.kind]), [[2, 'partyLeft']]);
  assert.throws(() => rt.ctx.notify(b, { text: 'no kind' }), /kind/);
});

test('ctx.dataFile stays inside the operator data directory', () => {
  const players = new Map();
  const rt = createRpgRuntime({ players, save() {}, send() {}, dataPath: '/srv/arena2', log: quiet });
  assert.equal(rt.ctx.dataPath, '/srv/arena2');
  assert.equal(rt.ctx.dataFile('MAPS.BSA'), '/srv/arena2/MAPS.BSA');
  assert.throws(() => rt.ctx.dataFile('../etc/passwd'), /invalid/);
  assert.throws(() => rt.ctx.dataFile('/etc/passwd'), /invalid/);
  const none = createRpgRuntime({ players, save() {}, send() {}, log: quiet });
  assert.throws(() => none.ctx.dataFile('MAPS.BSA'), /not configured/);
});

test('store: additive migration from the v1 schema, rpg round trip, account mapping', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dfw-store-'));
  try {
    const path = join(dir, 'old.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      x REAL NOT NULL DEFAULT 0, z REAL NOT NULL DEFAULT 0, yaw REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)`);
    const token = newToken();
    const { lastInsertRowid } = old
      .prepare('INSERT INTO players (token_hash, name, x, z, yaw, created_at, last_seen) VALUES (?, ?, 0, 0, 0, 1, 1)')
      .run(hashToken(token), 'Old Timer');
    const row = { id: Number(lastInsertRowid) };
    old.close();
    openStore(path).close(); // migrate
    const store = openStore(path); // reopening is idempotent
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    const cols = store.db.prepare('PRAGMA table_info(players)').all().map((c) => c.name);
    assert.ok(cols.includes('rpg'));
    const found = store.findByToken(token);
    assert.deepEqual(found, { id: row.id, name: 'Old Timer', x: 0, z: 0, yaw: 0, rpg: {} });

    store.saveCharacters([{ ...found, x: 3, rpg: { gold: 7, location: 'town:X' } }]);
    assert.deepEqual(store.findByToken(token).rpg, { gold: 7, location: 'town:X' });
    assert.throws(() => store.saveCharacters([{ ...found, rpg: { big: 'x'.repeat(300_000) } }]), /too large/);
    assert.equal(store.findByToken(token).rpg.gold, 7, 'failed save leaves the row unchanged');

    // Accounts: one character per account; guest tokens never open account characters.
    const acc = store.createForAccount(7, 'alice');
    assert.equal(store.findByAccount(7).id, acc.id);
    assert.equal(store.findByAccount('7').id, acc.id);
    assert.throws(() => store.createForAccount(7, 'alice'));
    assert.equal(store.claimGuest(7, 'alice', token), null, 'account already has a character');
    const claimed = store.claimGuest(8, 'bob', token, 'bob');
    assert.equal(claimed.id, row.id);
    assert.equal(claimed.rpg.gold, 7);
    assert.equal(store.findByToken(token), null, 'claimed guest token is revoked');
    assert.equal(store.findByAccount(8).name, 'bob');

    // Corrupt rows fail loudly instead of being silently reset.
    store.db.prepare("UPDATE players SET rpg = 'nope' WHERE id = ?").run(acc.id);
    assert.throws(() => store.findByAccount(7), /unreadable/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback covers player position/facing, shared entities, feature hooks and events', () => {
  let failSave = false;
  const order = [];
  const party = new Map(); // feature-private state
  const { rt, add, sent } = setup({
    save: () => {
      if (failSave) throw new Error('disk I/O error');
    },
    features: [
      (ctx) => {
        ctx.entities.set('rat', { id: 'rat', kind: 'monster', name: 'Rat', location: DEFAULT_LOCATION, x: 1, z: 1, yaw: 0, hp: 1, maxHp: 3, loot: ['tail'] });
        ctx.entities.set('ghost', { id: 'ghost', kind: 'monster', name: 'Ghost', location: 'dungeon:Crypt', x: 0, z: 0, yaw: 0, hp: 9, maxHp: 9 });
        ctx.entities.set('lamp', { id: 'lamp', kind: 'prop', name: 'Lamp', location: DEFAULT_LOCATION, x: 0, z: 0, yaw: 0, light: () => 1 });
        ctx.onAction('combat.attack', (p, { fail }) => {
          const rat = ctx.entities.get('rat');
          rat.hp = 0;
          rat.loot.push('extra');
          ctx.entities.delete('rat'); // killed
          ctx.entities.set('loot1', { id: 'loot1', kind: 'loot', name: 'Tail', location: ctx.location(p), x: 1, z: 1, yaw: 0 }); // dropped
          ctx.entities.get('lamp').name = 'Broken lamp'; // non-cloneable entity (has a function)
          const ghost = ctx.entities.get('ghost');
          ctx.touchEntity(ghost); // outside the actor's location: record before mutating
          ghost.hp = 1;
          p.rpg.gold = 999;
          p.x = 10;
          p.yaw = 1.5;
          p.animation = 'attack';
          party.set(p.id, 'leader');
          ctx.onRollback(() => {
            order.push('undo-party');
            party.delete(p.id);
          });
          ctx.onRollback(() => order.push('undo-second'));
          ctx.afterCommit(() => order.push('committed'));
          ctx.nearby(ctx.location(p), { kind: 'kill', entityId: 'rat' });
          ctx.emit('kill', { player: p, entity: rat });
          if (fail) throw new Error('target escaped');
        });
      },
    ],
  });
  const a = add(1, { gold: 5 });
  const before = () => ({
    rpg: structuredClone(a.rpg),
    pos: [a.x, a.z, a.yaw, Object.hasOwn(a, 'animation')],
    ids: [...rt.entities.keys()],
    rat: structuredClone(rt.entities.get('rat')),
    ghost: rt.entities.get('ghost').hp,
    lamp: rt.entities.get('lamp').name,
  });
  const initial = before();
  const ratObj = rt.entities.get('rat');

  for (const mode of ['handler', 'save']) {
    order.length = 0;
    sent.length = 0;
    failSave = mode === 'save';
    const r = rt.act(a, 'combat.attack', { fail: mode === 'handler' });
    assert.equal(r.ok, false, mode);
    assert.deepEqual(before(), initial, `${mode}: everything restored`);
    assert.equal(rt.entities.get('rat'), ratObj, 'same entity object is back in the map');
    assert.equal(party.size, 0);
    assert.deepEqual(order, ['undo-second', 'undo-party'], 'hooks run in reverse; afterCommit dropped');
    assert.equal(sent.filter(([, m]) => m.type === 'gameEvent').length, 0, 'events discarded');
  }

  failSave = false;
  order.length = 0;
  assert.deepEqual(rt.act(a, 'combat.attack', {}), { ok: true });
  assert.deepEqual(order, ['committed']);
  assert.equal(rt.entities.has('rat'), false);
  assert.equal(rt.entities.has('loot1'), true);
  assert.equal(rt.entities.get('ghost').hp, 1);
  assert.equal(a.x, 10);
  assert.equal(party.get(1), 'leader');
  assert.equal(sent.filter(([, m]) => m.type === 'gameEvent').length, 1);
  // Outside actions afterCommit runs immediately and onRollback is ignored.
  let ran = false;
  rt.ctx.afterCommit(() => (ran = true));
  rt.ctx.onRollback(() => assert.fail('must not run'));
  assert.equal(ran, true);
  assert.equal(rt.ctx.inAction(), false);
});
