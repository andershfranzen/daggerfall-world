// Shared shop ledgers persist through the normal server entry point (server/game.js -> SQLite world_state),
// written in the same transaction as the buyer's character; a failed save rolls back pack, gold, purse and stock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGameServer } from '../server/game.js';
import { openStore } from '../server/db.js';
import * as inventory from '../server/rpg/inventory.js';
import * as npcs from '../server/rpg/npcs.js';

const TOWN = 'town:Daggerfall/Gothway Garden';
const features = [inventory, npcs];

async function boot(dbPath, extra = {}) {
  const srv = createGameServer({ port: 0, host: '127.0.0.1', dbPath, features, defaultLocation: TOWN, ...extra });
  const { port } = await srv.start();
  const { default: WebSocket } = await import('ws');
  const connect = async (hello) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d)));
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ type: 'join', ...hello }));
    const wait = async (pred, ms = 5000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const m = msgs.find(pred);
        if (m) return m;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('timeout');
    };
    const welcome = await wait((m) => m.type === 'welcome');
    let seq = 0;
    const act = async (verb, args) => {
      const s = ++seq;
      ws.send(JSON.stringify({ type: 'action', seq: s, verb, args }));
      return wait((m) => m.type === 'actionResult' && m.seq === s);
    };
    const dialogue = () => msgs.filter((m) => m.type === 'gameEvent' && m.event?.kind === 'dialogue').at(-1)?.event;
    return { ws, msgs, welcome, act, dialogue, player: () => [...srv.runtime.ctx.players.values()].find((p) => p.name === hello.name) };
  };
  return { srv, connect };
}

async function openShop(c, srv) {
  const merchant = [...srv.runtime.entities.values()].find((e) => e.kind === 'npc' && e.location === TOWN && e.shop === 'general');
  assert.ok(merchant, 'a merchant in town');
  const p = c.player();
  p.x = merchant.x;
  p.z = merchant.z + 1;
  p.rpg.gold = 400;
  assert.equal((await c.act('npc.talk', { targetId: merchant.id })).ok, true);
  const s = c.dialogue().session;
  assert.equal((await c.act('npc.topic', { targetId: merchant.id, session: s, topic: 'trade' })).ok, true);
  await new Promise((r) => setTimeout(r, 30));
  return { merchant, session: s, shop: c.dialogue().shop };
}

const potions = (p) => (p.rpg.inventory ?? []).filter((i) => i.template === 'potion-of-healing').reduce((n, i) => n + (i.quantity ?? 1), 0);

test('a purchase saves the buyer and the shop ledger together; an immediate graceful restart keeps both', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dfw-npc-shop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'world.db');
  let { srv, connect } = await boot(dbPath);
  const a = await connect({ name: 'Aldora' });
  const { merchant, session, shop } = await openShop(a, srv);
  const item = shop.items.find((i) => i.key === 'potion-of-healing');
  const pack0 = potions(a.player());
  const r = await a.act('npc.buy', { targetId: merchant.id, session, key: item.key, quantity: 2, price: item.price });
  assert.equal(r.ok, true, r.error);
  const goldAfter = a.player().rpg.gold;
  const purseAfter = shop.purse + item.price * 2;

  // The row is already in SQLite before any periodic save: same transaction as the character.
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT value FROM world_state WHERE key = ?').get(`npcshop:${merchant.id}`);
  db.close();
  assert.ok(row, 'ledger row written with the purchase');
  const saved = JSON.parse(row.value);
  assert.equal(saved.stock.find((i) => i.key === item.key).quantity, item.quantity - 2);
  assert.equal(saved.purse, purseAfter);

  await srv.close(); // graceful reload straight after the purchase
  ({ srv, connect } = await boot(dbPath));
  t.after(() => srv.close());
  const a2 = await connect({ name: 'Aldora', token: a.welcome.token });
  assert.equal(a2.player().rpg.gold, goldAfter, 'buyer gold persisted');
  assert.equal(potions(a2.player()), pack0 + 2, 'bought goods persisted');
  const b = await connect({ name: 'Brannoc' });
  const again = await openShop(b, srv);
  assert.equal(again.merchant.id, merchant.id, 'same merchant identity after restart');
  assert.equal(again.shop.items.find((i) => i.key === item.key).quantity, item.quantity - 2, 'stock persisted and shared');
  assert.equal(again.shop.purse, purseAfter, 'purse persisted');
});

test('a failed save rolls back the pack, gold, purse and ledger, and writes nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dfw-npc-shop-fail-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'world.db');
  let failShop = false;
  const faulty = (path) => {
    const store = openStore(path);
    const real = store.saveCharacters.bind(store);
    store.saveCharacters = (players, world = []) => {
      if (failShop && world.some(([k]) => k.startsWith('npcshop:'))) throw new Error('disk full');
      return real(players, world);
    };
    return store;
  };
  const { srv, connect } = await boot(dbPath, { openStore: faulty });
  t.after(() => srv.close());
  const a = await connect({ name: 'Aldora' });
  const { merchant, session, shop } = await openShop(a, srv);
  const item = shop.items.find((i) => i.key === 'potion-of-healing');
  const p = a.player();
  const gold0 = p.rpg.gold, pack0 = potions(p);
  failShop = true;
  const r = await a.act('npc.buy', { targetId: merchant.id, session, key: item.key, quantity: 1, price: item.price });
  assert.equal(r.ok, false);
  assert.match(r.error, /could not save/);
  assert.equal(p.rpg.gold, gold0, 'gold restored');
  assert.equal(potions(p), pack0, 'pack restored');
  failShop = false;
  assert.equal((await a.act('npc.topic', { targetId: merchant.id, session, topic: 'trade' })).ok, true);
  await new Promise((r2) => setTimeout(r2, 30));
  const view = a.dialogue().shop;
  assert.equal(view.items.find((i) => i.key === item.key).quantity, item.quantity, 'stock restored');
  assert.equal(view.purse, shop.purse, 'purse restored');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare('SELECT value FROM world_state WHERE key = ?').get(`npcshop:${merchant.id}`);
  db.close();
  assert.ok(!row || JSON.parse(row.value).stock.find((i) => i.key === item.key).quantity === item.quantity, 'no reduced ledger on disk');
});
