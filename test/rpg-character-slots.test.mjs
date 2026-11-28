// Tests for §1 Character Slots, durable transaction/idempotency layer, buffered-store coordination,
// and shared item transfer eligibility + stack split/merge helpers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';

import {
  openStore,
  SCHEMA_VERSION,
  MAX_CHARACTER_SLOTS,
  ARCHIVE_WINDOW_MS,
  DurableConflictError,
  SlotError,
  hashToken,
  newToken,
} from '../server/db.js';
import { createBufferedGameStore } from '../server/storage/postgres-game.js';
import { createAccounts } from '../server/accounts.js';
import { createGameServer, CLOSE } from '../server/game.js';
import {
  TRANSFER_TYPES,
  makeItem,
  checkItemEligibility,
  assertItemEligible,
  itemFingerprint,
  canMergeStacks,
  splitStack,
  mergeStacks,
  takeForTransfer,
  insertRecord,
  normalizeRpg,
} from '../server/rpg/inventory.js';

const FAST_SCRYPT = { N: 2 ** 10, r: 8, p: 1, keyLen: 32 };
const PW = 'velvet lantern dusk';

function createHarness(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dfw-slots-'));
  const clientDir = join(dir, 'client');
  const siteDir = join(dir, 'site');
  mkdirSync(clientDir);
  mkdirSync(siteDir);
  writeFileSync(join(clientDir, 'play.html'), '<!doctype html><title>play</title>');
  writeFileSync(join(siteDir, 'index.html'), '<!doctype html><title>site</title>');

  let clock = opts.startClock ?? 1_700_000_000_000;
  const now = () => clock;
  const dbPath = join(dir, 'game.db');
  const rawStore = opts.store ?? openStore(dbPath, { now });
  const store = opts.wrapStore ? opts.wrapStore(rawStore) : rawStore;
  const accounts = createAccounts({
    dbPath: join(dir, 'accounts.db'),
    scrypt: FAST_SCRYPT,
    moderationPollMs: 25,
    limits: { api: [500, 60_000], login: [100, 60_000], register: [100, 60_000] },
  });
  const server = createGameServer({
    host: '127.0.0.1',
    port: 0,
    store,
    clientDir,
    siteDir,
    accounts,
    features: opts.features ?? [],
    actionRatePerSec: 100,
    actionBurst: 200,
    ...(opts.server ?? {}),
  });

  let origin;
  let wsUrl;
  return {
    dir,
    dbPath,
    store,
    rawStore,
    accounts,
    server,
    get clock() { return clock; },
    advanceClock(ms) { clock += ms; },
    get origin() { return origin; },
    async start() {
      const addr = await server.start();
      origin = `http://127.0.0.1:${addr.port}`;
      wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
    },
    async stop() {
      await server.close();
      accounts.close();
      rmSync(dir, { recursive: true, force: true });
    },
    async api(path, { method = 'POST', body, jar, headers = {} } = {}) {
      const h = { Origin: origin, ...headers };
      if (body !== undefined) h['Content-Type'] = 'application/json';
      if (jar?.cookie) h.Cookie = jar.cookie;
      const res = await fetch(origin + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (jar && setCookie) {
        const [pair] = setCookie.split(';');
        const value = pair.slice(pair.indexOf('=') + 1);
        jar.cookie = value ? pair : '';
      }
      const text = await res.text();
      return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
    },
    connect(cookie, query = '') {
      return new Promise((resolve) => {
        const ws = new WebSocket(`${wsUrl}${query}`, {
          headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
        });
        const messages = [];
        ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
        ws.once('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
        ws.once('open', () => resolve({ ws, messages }));
        ws.once('error', () => {});
      });
    },
  };
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('timed out waiting for condition');
}

function closed(ws) {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) return resolve({ code: ws._closeCode });
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

describe('1. Lossless v2 -> v3 migration & grandfathered names', () => {
  test('migrates existing single-slot characters to slot 1 preserving full state and legacy colliding names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dfw-mig-'));
    const path = join(dir, 'legacy.db');
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE players (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          token_hash TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          x REAL NOT NULL DEFAULT 0,
          z REAL NOT NULL DEFAULT 0,
          yaw REAL NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          rpg TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE account_characters (
          account_id TEXT PRIMARY KEY,
          player_id INTEGER NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
          username TEXT NOT NULL,
          linked_at INTEGER NOT NULL
        );
        PRAGMA user_version = 2;
      `);
      const rpgA = {
        location: 'town:Daggerfall/Gothway Garden',
        gold: 420,
        character: { created: true, name: 'Aldric', race: 'Breton', className: 'Spellsword', level: 5 },
        inventory: [{ id: 'it-legacy1', template: 'iron-longsword', quantity: 1 }],
        quests: [{ id: 'q1', stage: 2 }],
        property: { deeds: [{ town: 'Daggerfall', building: 12 }] },
        playerGuild: { id: 'pg_1', name: 'Order of Dawn', tag: 'DAWN', rank: 'Leader' },
      };
      const id1 = Number(legacy.prepare(
        'INSERT INTO players (token_hash, name, x, z, yaw, created_at, last_seen, rpg) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(hashToken(newToken()), 'Aldric', 12.5, -4.25, 1.2, 1000, 5000, JSON.stringify(rpgA)).lastInsertRowid);
      const id2 = Number(legacy.prepare(
        'INSERT INTO players (token_hash, name, x, z, yaw, created_at, last_seen, rpg) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(hashToken(newToken()), 'aldric', 3, 4, 0, 1000, 4000, JSON.stringify({ gold: 50 })).lastInsertRowid);

      legacy.prepare('INSERT INTO account_characters (account_id, player_id, username, linked_at) VALUES (?, ?, ?, ?)').run('10', id1, 'Aldric', 1000);
      legacy.prepare('INSERT INTO account_characters (account_id, player_id, username, linked_at) VALUES (?, ?, ?, ?)').run('20', id2, 'aldric', 1000);
      legacy.close();

      // Open with v3 store -> migrates losslessly without failing on normalized legacy collision.
      const store = openStore(path);
      try {
        assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
        const listA = store.listByAccount(10);
        const listB = store.listByAccount(20);
        assert.equal(listA.length, 1);
        assert.equal(listB.length, 1);
        assert.equal(listA[0].id, id1);
        assert.equal(listA[0].slot, 1);
        assert.equal(listA[0].status, 'active');
        assert.equal(listA[0].grandfathered, true);
        assert.equal(listA[0].lastSelected, true);
        assert.equal(listA[0].x, 12.5);
        assert.equal(listA[0].z, -4.25);
        assert.deepEqual(listA[0].rpg, rpgA);
        assert.equal(listB[0].id, id2);
        assert.equal(listB[0].slot, 1);
        assert.equal(listB[0].grandfathered, true);

        // New characters cannot reuse a grandfathered name (case-insensitive).
        assert.throws(
          () => store.createCharacterSlot(30, 'ThirdUser', { name: 'ALDRIC' }),
          (err) => err instanceof SlotError && err.code === 'NAME_TAKEN',
        );

        // Account 10 can add slot 2 with a fresh unique name.
        const slot2 = store.createCharacterSlot(10, 'Aldric', { name: 'Lyris' });
        assert.equal(slot2.slot, 2);
        assert.equal(slot2.grandfathered, false);
        assert.equal(store.listByAccount(10).length, 2);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('2. Durable transaction & idempotency layer + buffered-store coordination', () => {
  test('runDurable enforces idempotency replay, conflict rejection, and escrow/claim revisions', async () => {
    const store = openStore(':memory:');
    try {
      const charA = store.createCharacterSlot(1, 'Buyer', { name: 'BuyerHero' });
      const charB = store.createCharacterSlot(2, 'Seller', { name: 'SellerHero' });
      let executions = 0;

      const scope = {
        accountId: 1,
        characterId: charA.id,
        characterIds: [charA.id, charB.id],
        resourceKey: 'market:listing-1',
        params: { listingId: 'L1', qty: 2, gold: 150 },
      };

      const first = await store.runDurable('buy-L1-op', scope, (tx) => {
        executions += 1;
        const esc = tx.createEscrow({
          kind: 'market_listing',
          ownerAccountId: '2',
          ownerCharacterId: charB.id,
          counterpartyCharacterId: charA.id,
          sourceRef: 'L1',
          gold: 150,
          item: makeItem('arrow', 2),
          expiresAt: tx.now + 60_000,
        });
        const claim = tx.createClaim({
          ownerCharacterId: charB.id,
          ownerAccountId: '2',
          kind: 'market_proceeds',
          sourceRef: 'L1',
          gold: 150,
        });
        return { escrowId: esc.id, claimId: claim.id };
      });

      assert.equal(first.replayed, false);
      assert.equal(executions, 1);

      // Exact replay returns original result without re-running fn.
      const replay = await store.runDurable('buy-L1-op', scope, () => {
        executions += 1;
        return { shouldNotRun: true };
      });
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.result, first.result);
      assert.equal(executions, 1);

      // Same opKey with different parameters is refused with DurableConflictError.
      await assert.rejects(
        () => store.runDurable('buy-L1-op', { ...scope, params: { listingId: 'L1', qty: 5, gold: 150 } }, () => ({ ok: true })),
        (err) => err instanceof DurableConflictError && err.code === 'DURABLE_KEY_CONFLICT',
      );

      // Failed durable callback rolls back completely (no durable_ops or escrow persisted).
      await assert.rejects(
        () => store.runDurable('fail-op', { accountId: 1, characterId: charA.id, params: { x: 1 } }, (tx) => {
          tx.createEscrow({ kind: 'trade', ownerCharacterId: charA.id, gold: 99 });
          throw new Error('simulated failure');
        }),
        /simulated failure/,
      );
      assert.equal(store.getDurableOp('fail-op', { accountId: 1, characterId: charA.id }), null);
      assert.equal(store.listEscrow({ ownerCharacterId: charA.id }).length, 0);

      // Escrow revision check & claim settlement.
      await store.runDurable('settle-esc', { characterId: charB.id }, (tx) => {
        const cur = tx.getEscrow(first.result.escrowId);
        assert.equal(cur.revision, 1);
        const updated = tx.updateEscrowStatus(cur.id, 1, 'settled');
        assert.equal(updated.revision, 2);
        assert.throws(
          () => tx.updateEscrowStatus(cur.id, 1, 'refunded'),
          (err) => err instanceof DurableConflictError && err.code === 'REVISION_CONFLICT',
        );
        const claimed = tx.claimRecord(first.result.claimId, 1);
        assert.equal(claimed.status, 'claimed');
        assert.throws(
          () => tx.claimRecord(first.result.claimId, 1),
          (err) => err instanceof DurableConflictError && err.code === 'REVISION_CONFLICT',
        );
      });
    } finally {
      store.close();
    }
  });

  test('buffered-store runDurable drains pending saves before commit and mirrors world writes', async () => {
    const sqlite = openStore(':memory:');
    try {
      const ch = sqlite.createCharacterSlot(1, 'Buffered', { name: 'BufferedHero' });
      const events = [];
      const mockPg = {
        pool: null,
        async saveCharacters(players, world) {
          events.push({ kind: 'bufferedSave', ids: players.map((p) => p.id), worldKeys: world.map((w) => w[0]) });
          sqlite.saveCharacters(players, world);
        },
        async loadWorld(prefix) {
          return sqlite.loadWorld(prefix);
        },
        async runDurable(opKey, scope, fn, tracker) {
          events.push({ kind: 'durableStart', opKey });
          return sqlite.runDurable(opKey, scope, async (tx) => {
            const wrappedTx = {
              ...tx,
              saveCharacters(pList, wList = []) {
                tx.saveCharacters(pList, wList);
                if (tracker) {
                  for (const p of pList) tracker.playerIds.add(p.id);
                  for (const [k, v] of wList) tracker.world.set(k, v);
                }
              },
              putWorld(k, v) {
                tx.putWorld(k, v);
                if (tracker) tracker.world.set(k, v);
              },
            };
            return fn(wrappedTx);
          });
        },
        async close() {},
      };
      const buffered = createBufferedGameStore(mockPg);
      // Queue a buffered save for the character.
      buffered.saveCharacters([{ ...ch, x: 7, rpg: { gold: 50 } }], [['shop:1', { gold: 10 }]]);
      // Immediately execute a durable transaction touching the same character.
      const res = await buffered.runDurable('durable-gold-add', { characterId: ch.id, params: { add: 25 } }, (tx) => {
        const fresh = tx.getCharacter(ch.id);
        assert.equal(fresh.x, 7, 'buffered save drained before durable read');
        assert.equal(fresh.rpg.gold, 50);
        tx.saveCharacters([{ ...fresh, rpg: { ...fresh.rpg, gold: fresh.rpg.gold + 25 } }]);
        tx.putWorld('market:stats', { sales: 1 });
        return { gold: 75 };
      });
      assert.equal(res.result.gold, 75);
      assert.equal(events[0].kind, 'bufferedSave');
      assert.equal(events[1].kind, 'durableStart');
      assert.deepEqual(buffered.loadWorld('market:'), [['market:stats', { sales: 1 }]]);
      assert.equal(sqlite.findAccountCharacter(1, ch.id).rpg.gold, 75);
      await buffered.close();
    } finally {
      sqlite.close();
    }
  });
});

describe('3. Character slots HTTP API, 3-slot isolation, slot-cap race, switch, archive/restore & deletion', () => {
  test('3-slot isolation, slot-cap race, selector-required, switch + save-failure safety', async () => {
    let failNextSave = false;
    const h = createHarness({
      wrapStore(raw) {
        return new Proxy(raw, {
          get(target, prop, receiver) {
            if (prop === 'saveCharacters') {
              return (...args) => {
                if (failNextSave) {
                  failNextSave = false;
                  throw new Error('injected disk save failure');
                }
                return target.saveCharacters(...args);
              };
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === 'function' ? val.bind(target) : val;
          },
        });
      },
      features: [(ctx) => {
        ctx.onAction('test.mark', (p, args = {}) => {
          p.rpg.marker = args.value ?? 'set';
          p.rpg.gold = (p.rpg.gold ?? 0) + (args.gold ?? 0);
          ctx.dirty(p);
        });
      }],
    });
    await h.start();
    try {
      const jar = {};
      const reg = await h.api('/api/register', { body: { username: 'Kaelen', password: PW }, jar });
      assert.equal(reg.status, 201);

      // Initially empty roster.
      const r0 = await h.api('/api/characters', { method: 'GET', jar });
      assert.equal(r0.status, 200);
      assert.equal(r0.json.maxSlots, MAX_CHARACTER_SLOTS);
      assert.deepEqual(r0.json.characters, []);

      // Create slot 1 and slot 2.
      const c1 = await h.api('/api/characters/start', { body: { slot: 1, name: 'Kaelen One' }, jar });
      assert.equal(c1.status, 201);
      assert.equal(c1.json.character.slot, 1);

      const c2 = await h.api('/api/characters/start', { body: { slot: 2, name: 'Kaelen Two' }, jar });
      assert.equal(c2.status, 201);
      assert.equal(c2.json.character.slot, 2);

      // Slot-cap race: 4 concurrent requests competing for the final slot (slot 3).
      const raceResults = await Promise.all([
        h.api('/api/characters/start', { body: { name: 'Race A' }, jar }),
        h.api('/api/characters/start', { body: { name: 'Race B' }, jar }),
        h.api('/api/characters/start', { body: { name: 'Race C' }, jar }),
        h.api('/api/characters/start', { body: { name: 'Race D' }, jar }),
      ]);
      const created = raceResults.filter((r) => r.status === 201);
      const rejected = raceResults.filter((r) => r.status === 409);
      assert.equal(created.length, 1, 'exactly one racer wins the last slot');
      assert.equal(rejected.length, 3, 'other three receive 409 slot cap');
      assert.equal(created[0].json.character.slot, 3);

      const id1 = c1.json.character.id;
      const id2 = c2.json.character.id;
      const id3 = created[0].json.character.id;

      // Legacy join omitting characterId gets SELECTOR_REQUIRED when >1 active characters exist.
      const legacy = await h.connect(jar.cookie);
      legacy.ws.send(JSON.stringify({ type: 'join' }));
      const selErr = await waitFor(() => legacy.messages.find((m) => m.type === 'error'));
      assert.equal(selErr.code, 'SELECTOR_REQUIRED');
      legacy.ws.close();
      await closed(legacy.ws);

      // Join slot 1 and mutate its state.
      const sock1 = await h.connect(jar.cookie);
      sock1.ws.send(JSON.stringify({ type: 'join', characterId: id1 }));
      const w1 = await waitFor(() => sock1.messages.find((m) => m.type === 'welcome'));
      assert.equal(w1.id, id1);
      assert.equal(w1.player.name, 'Kaelen One');
      sock1.ws.send(JSON.stringify({ type: 'action', verb: 'test.mark', args: { value: 'slot-1-only', gold: 111 }, seq: 1 }));
      await waitFor(() => sock1.messages.find((m) => m.type === 'actionResult' && m.seq === 1 && m.ok));

      // Second tab trying to join slot 2 WITHOUT switch: true gets SWITCH_REQUIRED.
      const sockNoSw = await h.connect(jar.cookie);
      sockNoSw.ws.send(JSON.stringify({ type: 'join', characterId: id2 }));
      const swReq = await waitFor(() => sockNoSw.messages.find((m) => m.type === 'error'));
      assert.equal(swReq.code, 'SWITCH_REQUIRED');
      assert.equal(swReq.activeCharacterId, id1);
      sockNoSw.ws.close();
      await closed(sockNoSw.ws);

      // Inject save failure during in-session switch -> switch MUST abort and keep slot 1 alive!
      failNextSave = true;
      sock1.ws.send(JSON.stringify({ type: 'switch', characterId: id2 }));
      const saveFail = await waitFor(() => sock1.messages.find((m) => m.type === 'error' && m.code === 'SWITCH_SAVE_FAILED'));
      assert.equal(saveFail.code, 'SWITCH_SAVE_FAILED');
      // Slot 1 is still active and responsive.
      sock1.ws.send(JSON.stringify({ type: 'action', verb: 'test.mark', args: { value: 'still-slot-1', gold: 9 }, seq: 2 }));
      await waitFor(() => sock1.messages.find((m) => m.type === 'actionResult' && m.seq === 2 && m.ok));

      // Now switch cleanly from slot 1 to slot 2 on the same socket.
      sock1.ws.send(JSON.stringify({ type: 'switch', characterId: id2 }));
      const w2 = await waitFor(() => sock1.messages.find((m) => m.type === 'welcome' && m.id === id2));
      assert.equal(w2.switched, true);
      assert.equal(w2.player.name, 'Kaelen Two');
      sock1.ws.send(JSON.stringify({ type: 'action', verb: 'test.mark', args: { value: 'slot-2-only', gold: 222 }, seq: 3 }));
      await waitFor(() => sock1.messages.find((m) => m.type === 'actionResult' && m.seq === 3 && m.ok));

      // Explicit cross-tab switch to slot 3 via URL query (?characterId=&switch=1) replaces sock1 cleanly.
      const sock1Closed = closed(sock1.ws);
      const sock3 = await h.connect(jar.cookie, `?characterId=${id3}&switch=1`);
      sock3.ws.send(JSON.stringify({ type: 'join' }));
      const w3 = await waitFor(() => sock3.messages.find((m) => m.type === 'welcome'));
      assert.equal(w3.id, id3);
      assert.equal((await sock1Closed).code, CLOSE.REPLACED);
      sock3.ws.send(JSON.stringify({ type: 'action', verb: 'test.mark', args: { value: 'slot-3-only', gold: 333 }, seq: 4 }));
      await waitFor(() => sock3.messages.find((m) => m.type === 'actionResult' && m.seq === 4 && m.ok));
      sock3.ws.close();
      await closed(sock3.ws);

      // Verify full state isolation across all 3 slots in storage.
      const s1 = h.rawStore.findAccountCharacter(reg.json.user.id, id1);
      const s2 = h.rawStore.findAccountCharacter(reg.json.user.id, id2);
      const s3 = h.rawStore.findAccountCharacter(reg.json.user.id, id3);
      assert.equal(s1.rpg.marker, 'still-slot-1');
      assert.equal(s1.rpg.gold, 120);
      assert.equal(s2.rpg.marker, 'slot-2-only');
      assert.equal(s2.rpg.gold, 222);
      assert.equal(s3.rpg.marker, 'slot-3-only');
      assert.equal(s3.rpg.gold, 333);
    } finally {
      await h.stop();
    }
  });

  test('archive blockers, name confirmation, 7-day restore, expiry purge, and account deletion with obligations', async () => {
    const h = createHarness();
    await h.start();
    try {
      const jarA = {};
      const jarB = {};
      const regA = await h.api('/api/register', { body: { username: 'Veyra', password: PW }, jar: jarA });
      const regB = await h.api('/api/register', { body: { username: 'Torin', password: PW }, jar: jarB });

      const c1 = (await h.api('/api/characters/start', { body: { slot: 1, name: 'Veyra Main' }, jar: jarA })).json.character;
      const c2 = (await h.api('/api/characters/start', { body: { slot: 2, name: 'Veyra Alt' }, jar: jarA })).json.character;
      const b1 = (await h.api('/api/characters/start', { body: { slot: 1, name: 'Torin Main' }, jar: jarB })).json.character;

      // Wrong confirmName refused.
      const badConfirm = await h.api('/api/characters/archive', {
        body: { characterId: c2.id, confirmName: 'Wrong Name' },
        jar: jarA,
      });
      assert.equal(badConfirm.status, 400);
      assert.equal(badConfirm.json.code, 'CONFIRM_NAME_MISMATCH');

      // Open escrow blocks archive.
      const escRes = await h.store.runDurable('esc-block-1', { characterId: c2.id }, (tx) => tx.createEscrow({
        kind: 'market_listing',
        ownerAccountId: String(regA.json.user.id),
        ownerCharacterId: c2.id,
        gold: 50,
      }));
      const blockedEsc = await h.api('/api/characters/archive', {
        body: { characterId: c2.id, confirmName: 'Veyra Alt' },
        jar: jarA,
      });
      assert.equal(blockedEsc.status, 409);
      assert.equal(blockedEsc.json.code, 'ARCHIVE_BLOCKED');
      assert.ok(blockedEsc.json.blockers.some((b) => b.code === 'OPEN_ESCROW'));

      // Release escrow -> archive succeeds.
      await h.store.runDurable('esc-release-1', { characterId: c2.id }, (tx) => {
        tx.updateEscrowStatus(escRes.result.id, 1, 'released');
      });
      const arch = await h.api('/api/characters/archive', {
        body: { characterId: c2.id, confirmName: 'Veyra Alt' },
        jar: jarA,
      });
      assert.equal(arch.status, 200);
      assert.equal(arch.json.character.status, 'archived');
      assert.equal(arch.json.character.purgeAfter, h.clock + ARCHIVE_WINDOW_MS);

      // Name stays reserved during 7-day window; joining archived character is refused.
      const stealName = await h.api('/api/characters/start', { body: { name: 'veyra alt' }, jar: jarB });
      assert.equal(stealName.status, 409);
      assert.equal(stealName.json.code, 'NAME_TAKEN');

      const joinArch = await h.connect(jarA.cookie);
      joinArch.ws.send(JSON.stringify({ type: 'join', characterId: c2.id }));
      const archErr = await waitFor(() => joinArch.messages.find((m) => m.type === 'error'));
      assert.equal(archErr.code, 'CHARACTER_ARCHIVED');
      joinArch.ws.close();
      await closed(joinArch.ws);

      // Restore within 7-day window works cleanly.
      const rest = await h.api('/api/characters/restore', { body: { characterId: c2.id }, jar: jarA });
      assert.equal(rest.status, 200);
      assert.equal(rest.json.character.status, 'active');

      // Re-archive and advance clock past 7 days -> purge releases slot and name!
      assert.equal((await h.api('/api/characters/archive', { body: { characterId: c2.id, confirmName: 'Veyra Alt' }, jar: jarA })).status, 200);
      h.advanceClock(ARCHIVE_WINDOW_MS + 1000);
      const purged = await h.server.purgeExpiredArchived(h.clock);
      assert.equal(purged.length, 1);
      assert.equal(purged[0].playerId, c2.id);

      // Now Torin can claim the freed name!
      const b2 = await h.api('/api/characters/start', { body: { slot: 2, name: 'Veyra Alt' }, jar: jarB });
      assert.equal(b2.status, 201);

      // Account deletion cleanup across multiple slots + counterparty escrow refund + order leadership succession.
      const c3 = (await h.api('/api/characters/start', { body: { slot: 2, name: 'Veyra Second' }, jar: jarA })).json.character;
      await h.store.runDurable('buyer-escrow', { characterId: c1.id }, (tx) => tx.createEscrow({
        kind: 'auction_bid',
        ownerAccountId: String(regA.json.user.id),
        ownerCharacterId: c1.id,
        counterpartyCharacterId: b1.id,
        sourceRef: 'auc-99',
        gold: 500,
      }));
      // Order led by c1 with b1 (Officer) and b2 (Member).
      h.store.saveCharacters([], [['pguild:pg_deltest', {
        id: 'pg_deltest',
        name: 'Iron Vanguard',
        tag: 'IRON',
        treasury: 300,
        leaderId: c1.id,
        members: {
          [String(c1.id)]: { id: c1.id, name: c1.name, rank: 'Leader', joinedAt: '2026-01-01T00:00:00.000Z' },
          [String(b1.id)]: { id: b1.id, name: b1.name, rank: 'Officer', joinedAt: '2026-01-02T00:00:00.000Z' },
          [String(b2.json.character.id)]: { id: b2.json.character.id, name: b2.json.character.name, rank: 'Member', joinedAt: '2026-01-01T12:00:00.000Z' },
        },
      }]]);

      const del = await h.api('/api/delete-account', { body: { password: PW }, jar: jarA });
      assert.equal(del.status, 200);
      assert.equal(del.json.deleted, true);

      // Wait for async cleanup to finish.
      await waitFor(() => h.rawStore.listByAccount(regA.json.user.id).length === 0);
      // Both c1 and c3 deleted from players table too.
      assert.equal(h.rawStore.db.prepare('SELECT id FROM players WHERE id IN (?, ?)').all(c1.id, c3.id).length, 0);
      // Counterparty b1 received refund claim for 500 gold.
      const claims = h.rawStore.listClaims({ ownerCharacterId: b1.id, status: 'pending' });
      assert.equal(claims.length, 1);
      assert.equal(claims[0].gold, 500);
      // Order leadership passed to Officer b1 (not earlier-joined Member b2).
      const ord = h.rawStore.loadWorld('pguild:pg_deltest')[0]?.[1];
      assert.equal(ord.leaderId, b1.id);
      assert.equal(ord.members[String(b1.id)].rank, 'Leader');
      assert.equal(ord.members[String(c1.id)], undefined);
    } finally {
      await h.stop();
    }
  });
});

describe('4. Shared item transfer eligibility & stack split/merge helpers', () => {
  test('enforces eligibility consistently across trade, storage, market, auction, and craft', () => {
    assert.deepEqual(TRANSFER_TYPES, ['trade', 'storage', 'market', 'auction', 'craft']);

    const sword = makeItem('iron-longsword', 1);
    const arrows = makeItem('arrow', 10);
    const questItem = makeItem('iron-dagger', 1, undefined, { quest: { uid: 'q1', symbol: 's1' } });
    const conjured = makeItem('iron-dagger', 1, undefined, { conjuredUntil: 99999 });
    const stolen = makeItem('ruby', 1, undefined, { stolen: { from: 'Shop', at: 100 } });
    const charBound = makeItem('steel-dagger', 1, undefined, { bound: { scope: 'character', ownerId: 1 } });
    const acctBound = makeItem('steel-dagger', 1, undefined, { bound: { scope: 'account', ownerId: 'acct-1' } });
    const equipped = { ...makeItem('iron-longsword', 1), equipped: 'rightHand' };
    const horse = makeItem('horse', 1);

    for (const type of TRANSFER_TYPES) {
      assert.equal(checkItemEligibility(sword, type).ok, true, `sword eligible for ${type}`);
      assert.equal(checkItemEligibility(questItem, type).code, 'QUEST_ITEM');
      assert.equal(checkItemEligibility(conjured, type).code, 'CONJURED_ITEM');
      assert.equal(checkItemEligibility(equipped, type).code, 'EQUIPPED_ITEM');
      assert.equal(checkItemEligibility(horse, type).code, 'NON_TRANSFERABLE_ITEM');
    }

    // Personal storage allows bound & stolen; shared storage rejects both.
    assert.equal(checkItemEligibility(charBound, 'storage').ok, true);
    assert.equal(checkItemEligibility(stolen, 'storage').ok, true);
    assert.equal(checkItemEligibility(charBound, 'storage', { shared: true }).code, 'BOUND_ITEM');
    assert.equal(checkItemEligibility(stolen, 'storage', { shared: true }).code, 'STOLEN_ITEM');

    // Trade: account-bound allowed only for sameAccount, stolen rejected.
    assert.equal(checkItemEligibility(acctBound, 'trade').code, 'BOUND_ITEM');
    assert.equal(checkItemEligibility(acctBound, 'trade', { sameAccount: true }).ok, true);
    assert.equal(checkItemEligibility(stolen, 'trade').code, 'STOLEN_ITEM');

    // Market & auction: bound/stolen rejected; auction rejects multi-unit stack.
    assert.equal(checkItemEligibility(arrows, 'market').ok, true);
    assert.equal(checkItemEligibility(arrows, 'auction').code, 'AUCTION_SINGLE_ITEM_ONLY');
    assert.equal(checkItemEligibility({ ...arrows, quantity: 1 }, 'auction').ok, true);
    assert.throws(() => assertItemEligible(stolen, 'market'), (e) => e.code === 'STOLEN_ITEM');
  });

  test('splitStack, mergeStacks, takeForTransfer, and itemFingerprint preserve identity & metadata', () => {
    const craftedArrows = makeItem('arrow', 20, 'it-orig-stack', {
      crafted: { makerId: 7, makerName: 'Aldric', quality: 'fine' },
    });
    const otherQuality = makeItem('arrow', 5, 'it-other-stack', {
      crafted: { makerId: 7, makerName: 'Aldric', quality: 'masterwork' },
    });
    const sameQuality = makeItem('arrow', 5, 'it-same-stack', {
      crafted: { quality: 'fine', makerName: 'Aldric', makerId: 7 }, // different key order
    });

    assert.equal(itemFingerprint(craftedArrows), itemFingerprint(sameQuality));
    assert.notEqual(itemFingerprint(craftedArrows), itemFingerprint(otherQuality));
    assert.equal(canMergeStacks(craftedArrows, sameQuality), true);
    assert.equal(canMergeStacks(craftedArrows, otherQuality), false);

    // Partial split preserves original ID on remaining and assigns a new ID on split.
    const { remaining, split } = splitStack(craftedArrows, 6);
    assert.equal(remaining.id, 'it-orig-stack');
    assert.equal(remaining.quantity, 14);
    assert.notEqual(split.id, 'it-orig-stack');
    assert.equal(split.quantity, 6);
    assert.deepEqual(split.crafted, craftedArrows.crafted);

    // Full split preserves original ID.
    const full = splitStack(craftedArrows, 20);
    assert.equal(full.remaining, null);
    assert.equal(full.split.id, 'it-orig-stack');

    // Merge combines equivalent stacks and preserves target ID.
    const merged = mergeStacks(remaining, split);
    assert.equal(merged.id, 'it-orig-stack');
    assert.equal(merged.quantity, 20);

    // takeForTransfer enforces eligibility & preserves crafted metadata on insertRecord.
    const rpg = normalizeRpg({ inventory: [structuredClone(craftedArrows)], gold: 100 });
    const taken = takeForTransfer(rpg, 'it-orig-stack', 5, 'market');
    assert.equal(taken.quantity, 5);
    assert.notEqual(taken.id, 'it-orig-stack');
    assert.equal(rpg.inventory[0].id, 'it-orig-stack');
    assert.equal(rpg.inventory[0].quantity, 15);

    const destRpg = normalizeRpg({ inventory: [], gold: 0 });
    const inserted = insertRecord(destRpg, taken);
    assert.deepEqual(inserted.crafted, craftedArrows.crafted);
  });
});
