import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';

import { createGameServer, CLOSE } from '../server/game.js';
import { openPostgresChatLog } from '../server/chat-log.js';
import {
  openPostgresGameStore,
  createBufferedGameStore,
} from '../server/storage/postgres-game.js';

/**
 * In-memory mock PostgreSQL Pool supporting the game store + chat_messages SQL
 * with transactional BEGIN / COMMIT / ROLLBACK and configurable async latency.
 */
function createMockPgPool({ delayMs = 2 } = {}) {
  let state = {
    schemaApplied: 0,
    players: new Map(), // id -> row
    accountCharacters: new Map(), // account_id -> row
    worldState: new Map(), // key -> row
    chatMessages: [], // array of rows
    seqs: { players: 0, chat_messages: 0 },
  };
  let ended = false;

  function cloneState(s) {
    return {
      schemaApplied: s.schemaApplied,
      players: new Map([...s.players].map(([k, v]) => [k, structuredClone(v)])),
      accountCharacters: new Map([...s.accountCharacters].map(([k, v]) => [k, structuredClone(v)])),
      worldState: new Map([...s.worldState].map(([k, v]) => [k, structuredClone(v)])),
      chatMessages: structuredClone(s.chatMessages),
      seqs: { ...s.seqs },
    };
  }

  async function executeSql(rawSql, params = [], clientCtx = null) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    const sql = rawSql.replace(/\s+/g, ' ').trim();

    if (/^BEGIN$/i.test(sql)) {
      clientCtx.txSnapshot = cloneState(state);
      return { rows: [], rowCount: 0 };
    }
    if (/^COMMIT$/i.test(sql)) {
      clientCtx.txSnapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (/^ROLLBACK$/i.test(sql)) {
      if (clientCtx.txSnapshot) {
        state = clientCtx.txSnapshot;
        clientCtx.txSnapshot = null;
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 }; // single-process mock: no contention
    if (sql.startsWith('ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS')) return { rows: [], rowCount: 0 }; // upgrade of older tables

    if (sql.includes('CREATE TABLE IF NOT EXISTS') || sql.includes('CREATE INDEX IF NOT EXISTS')) {
      state.schemaApplied += 1;
      return { rows: [], rowCount: 0 };
    }

    // ---- players ----
    if (sql.startsWith('INSERT INTO players (token_hash, name, x, z, yaw, created_at, last_seen, rpg)')) {
      const hasRpgParam = params.length === 5;
      const [token_hash, name, created_at, last_seen] = params;
      const rpg = hasRpgParam ? JSON.parse(params[4]) : {};
      const id = ++state.seqs.players;
      const row = {
        id: String(id),
        token_hash,
        name,
        x: 0,
        z: 0,
        yaw: 0,
        created_at: String(created_at),
        last_seen: String(last_seen),
        rpg,
      };
      state.players.set(id, row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }

    if (sql.includes('FROM players p WHERE p.token_hash = $1 AND NOT EXISTS')) {
      const [tokenHash] = params;
      const linkedIds = new Set([...state.accountCharacters.values()].map((a) => Number(a.player_id)));
      for (const p of state.players.values()) {
        if (p.token_hash === tokenHash && !linkedIds.has(Number(p.id))) {
          return { rows: [structuredClone(p)], rowCount: 1 };
        }
      }
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes('FROM account_characters a JOIN players p ON p.id = a.player_id WHERE a.account_id = $1')) {
      const link = state.accountCharacters.get(String(params[0]));
      if (!link) return { rows: [], rowCount: 0 };
      const p = state.players.get(Number(link.player_id));
      if (!p) return { rows: [], rowCount: 0 };
      return { rows: [{ ...structuredClone(p), username: link.username }], rowCount: 1 };
    }

    if (sql === 'SELECT player_id FROM account_characters WHERE account_id = $1') {
      const link = state.accountCharacters.get(String(params[0]));
      return { rows: link ? [{ player_id: String(link.player_id) }] : [], rowCount: link ? 1 : 0 };
    }

    if (sql.startsWith('INSERT INTO account_characters (account_id, player_id, username, linked_at)')) {
      const [account_id, player_id, username, linked_at] = params;
      state.accountCharacters.set(String(account_id), {
        account_id: String(account_id),
        player_id: String(player_id),
        username,
        linked_at: String(linked_at),
      });
      return { rows: [], rowCount: 1 };
    }

    if (sql === 'UPDATE account_characters SET username = $1 WHERE account_id = $2') {
      const link = state.accountCharacters.get(String(params[1]));
      if (link) link.username = params[0];
      return { rows: [], rowCount: link ? 1 : 0 };
    }

    if (sql === 'DELETE FROM account_characters WHERE account_id = $1') {
      const existed = state.accountCharacters.delete(String(params[0]));
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    if (sql === 'DELETE FROM players WHERE id = $1') {
      const existed = state.players.delete(Number(params[0]));
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    if (sql === 'UPDATE players SET token_hash = $1, name = $2 WHERE id = $3') {
      const p = state.players.get(Number(params[2]));
      if (p) {
        p.token_hash = params[0];
        p.name = params[1];
      }
      return { rows: [], rowCount: p ? 1 : 0 };
    }

    if (sql.startsWith('UPDATE players SET name = $1, x = $2, z = $3, yaw = $4, rpg = $5::jsonb, last_seen = $6 WHERE id = $7')) {
      const [name, x, z, yaw, rpgText, last_seen, id] = params;
      const p = state.players.get(Number(id));
      if (p) {
        p.name = name;
        p.x = Number(x);
        p.z = Number(z);
        p.yaw = Number(yaw);
        p.rpg = JSON.parse(rpgText);
        p.last_seen = String(last_seen);
      }
      return { rows: [], rowCount: p ? 1 : 0 };
    }

    // ---- world_state ----
    if (sql.startsWith('INSERT INTO world_state (key, value, updated_at)')) {
      const [key, text, updated_at] = params;
      state.worldState.set(key, { key, value: JSON.parse(text), updated_at: String(updated_at) });
      return { rows: [], rowCount: 1 };
    }

    if (sql === 'DELETE FROM world_state WHERE key = $1') {
      const existed = state.worldState.delete(params[0]);
      return { rows: [], rowCount: existed ? 1 : 0 };
    }

    if (sql.startsWith('SELECT key, value FROM world_state WHERE starts_with(key, $1) ORDER BY key')) {
      const prefix = params[0] ?? '';
      const rows = [...state.worldState.values()]
        .filter((r) => r.key.startsWith(prefix))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((r) => ({ key: r.key, value: structuredClone(r.value) }));
      return { rows, rowCount: rows.length };
    }

    // ---- chat_messages ----
    if (sql.startsWith('INSERT INTO chat_messages (')) {
      const [
        created_at,
        channel,
        location,
        sender_player_id,
        sender_account_id,
        sender_name,
        target_player_id,
        target_name,
        group_id,
        body,
        recipient_ids,
      ] = params;
      const id = ++state.seqs.chat_messages;
      const row = {
        id: String(id),
        created_at: String(created_at),
        channel,
        location,
        sender_player_id: sender_player_id == null ? null : String(sender_player_id),
        sender_account_id,
        sender_name,
        target_player_id: target_player_id == null ? null : String(target_player_id),
        target_name,
        group_id,
        body,
        recipient_ids: recipient_ids ?? null,
      };
      state.chatMessages.push(row);
      return { rows: [structuredClone(row)], rowCount: 1 };
    }

    if (sql.startsWith('SELECT COUNT(*) AS total FROM chat_messages')) {
      return { rows: [{ total: String(state.chatMessages.length) }], rowCount: 1 };
    }

    if (sql.startsWith('SELECT id, created_at, channel, location,')) {
      const rows = [...state.chatMessages]
        .sort((a, b) => Number(b.created_at) - Number(a.created_at) || Number(b.id) - Number(a.id))
        .map((r) => structuredClone(r));
      return { rows, rowCount: rows.length };
    }

    throw new Error(`MockPgPool unhandled SQL: ${sql}`);
  }

  return {
    get state() {
      return state;
    },
    get ended() {
      return ended;
    },
    async query(sql, params = []) {
      return executeSql(sql, params, null);
    },
    async connect() {
      const client = new EventEmitter();
      const ctx = { client, txSnapshot: null };
      client.query = (sql, params = []) => executeSql(sql, params, ctx);
      client.release = () => {};
      return client;
    },
    async end() {
      ended = true;
    },
  };
}

function connectWs(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const inbox = [];
    const waiters = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString('utf8'));
      if (waiters.length) {
        for (let i = 0; i < waiters.length; i++) {
          if (waiters[i].pred(msg)) {
            const w = waiters.splice(i, 1)[0];
            clearTimeout(w.timer);
            w.resolve(msg);
            return;
          }
        }
      }
      inbox.push(msg);
    });
    ws.once('open', () => {
      resolve({
        ws,
        send(obj) {
          ws.send(JSON.stringify(obj));
        },
        next(pred = () => true, timeoutMs = 4000) {
          const idx = inbox.findIndex(pred);
          if (idx !== -1) return Promise.resolve(inbox.splice(idx, 1)[0]);
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              const j = waiters.findIndex((w) => w.resolve === res);
              if (j !== -1) waiters.splice(j, 1);
              rej(new Error('timed out waiting for ws message'));
            }, timeoutMs);
            waiters.push({ pred, resolve: res, timer });
          });
        },
        closed(timeoutMs = 4000) {
          if (ws.readyState === WebSocket.CLOSED) return Promise.resolve({ code: null, reason: '' });
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error('timed out waiting for ws close')), timeoutMs);
            ws.once('close', (code, reason) => {
              clearTimeout(timer);
              res({ code, reason: reason.toString('utf8') });
            });
          });
        },
      });
    });
    ws.once('error', reject);
  });
}

describe('PostgreSQL async runtime cutover (createGameServer + buffered PG store + PG chat log)', () => {
  it('preloads worldCache for synchronous loadWorld and updates it immediately on saveCharacters', async () => {
    const pool = createMockPgPool({ delayMs: 2 });
    const pgStore = await openPostgresGameStore({ pool });
    await pgStore.saveCharacters([], [
      ['shop:wayrest', { gold: 500 }],
      ['shop:daggerfall', { gold: 800 }],
      ['guild:fighters', { rank: 1 }],
    ]);

    const buffered = createBufferedGameStore(pgStore);
    assert.equal(buffered.pool, pool);
    assert.deepEqual(buffered.loadWorld('shop:'), []);

    await buffered.preloadWorld();
    assert.deepEqual(buffered.loadWorld('shop:'), [
      ['shop:daggerfall', { gold: 800 }],
      ['shop:wayrest', { gold: 500 }],
    ]);

    // Synchronous write-through into worldCache + async PostgreSQL commit
    buffered.saveCharacters([], [
      ['shop:wayrest', null],
      ['shop:sentinel', { gold: 1200 }],
    ]);
    // Immediately visible synchronously before flush()
    assert.deepEqual(buffered.loadWorld('shop:'), [
      ['shop:daggerfall', { gold: 800 }],
      ['shop:sentinel', { gold: 1200 }],
    ]);

    await buffered.flush();
    assert.deepEqual(await pgStore.loadWorld('shop:'), [
      ['shop:daggerfall', { gold: 800 }],
      ['shop:sentinel', { gold: 1200 }],
    ]);

    await buffered.close();
  });

  it('runs join, movement, chat logging, account deletion, and clean flush on close over WebSockets', async () => {
    const pool = createMockPgPool({ delayMs: 3 });
    const pgStore = await openPostgresGameStore({ pool });
    await pgStore.saveCharacters([], [['test:banner', { text: 'Welcome to Daggerfall' }]]);

    const store = createBufferedGameStore(pgStore);
    await store.preloadWorld();
    const chatLogStore = await openPostgresChatLog(store.pool);

    const deleteListeners = new Set();
    const accounts = {
      config: { trustProxy: false, requireHttps: false, publicOrigin: null },
      async handleHttp(_req, res) {
        res.writeHead(404);
        res.end();
      },
      async resolveUpgrade(req) {
        await new Promise((r) => setTimeout(r, 5));
        const user = req.headers['x-test-user'];
        const id = req.headers['x-test-account-id'];
        if (!user || !id) return null;
        return { id: Number(id), username: String(user), sessionKey: `sess-${id}` };
      },
      isMuted() {
        return false;
      },
      onModeration() {
        return () => {};
      },
      onSessionEnd() {
        return () => {};
      },
      onAccountDelete(fn) {
        deleteListeners.add(fn);
        return () => deleteListeners.delete(fn);
      },
      async close() {},
    };

    const server = createGameServer({
      host: '127.0.0.1',
      port: 0,
      store,
      chatLog: chatLogStore,
      accounts,
      allowGuests: false,
      features: [],
      tickHz: 50,
      snapshotEveryTicks: 1,
      saveIntervalMs: 60_000,
    });

    const addr = await server.start();

    try {
      // Unauthenticated upgrade is rejected with 401
      await assert.rejects(() => connectWs(addr.port), /401/);

      // Authenticated upgrade via async resolveUpgrade
      const client = await connectWs(addr.port, {
        'x-test-account-id': '42',
        'x-test-user': 'Nerevarine',
      });

      // Fire two concurrent join messages to verify conn.joining race guard
      client.send({ type: 'join' });
      client.send({ type: 'join' });

      const welcome = await client.next((m) => m.type === 'welcome');
      assert.equal(welcome.account.id, 42);
      assert.equal(welcome.account.username, 'Nerevarine');
      assert.equal(welcome.player.name, 'Nerevarine');
      assert.equal(pool.state.players.size, 1);
      assert.equal(pool.state.accountCharacters.size, 1);

      // Verify characterForAccount works with async store
      const summary = await server.characterForAccount(42);
      assert.deepEqual(summary, { id: welcome.id, name: 'Nerevarine' });

      // Move the player forward and wait for state update
      client.send({ type: 'input', forward: 1, strafe: 0, yaw: 0 });
      const movedState = await client.next(
        (m) => m.type === 'state' && m.players.some((p) => p.id === welcome.id && p.z < -0.05),
      );
      const movedPlayer = movedState.players.find((p) => p.id === welcome.id);
      assert.ok(movedPlayer.z < -0.05, `expected player to move along -z, got ${movedPlayer.z}`);

      // Send chat and verify openPostgresChatLog persisted it
      client.send({ type: 'chat', text: 'Greetings from Wayrest!' });
      const chatMsg = await client.next((m) => m.type === 'chat');
      assert.equal(chatMsg.name, 'Nerevarine');
      assert.equal(chatMsg.text, 'Greetings from Wayrest!');

      // Wait briefly for async chat log INSERT to complete
      await new Promise((r) => setTimeout(r, 25));
      const logged = await chatLogStore.recent(10);
      assert.equal(logged.length, 1);
      assert.equal(logged[0].senderName, 'Nerevarine');
      assert.equal(logged[0].senderAccountId, '42');
      assert.equal(logged[0].body, 'Greetings from Wayrest!');

      // Second player joins, moves, and stays connected until server.close() to verify flush on shutdown
      const client2 = await connectWs(addr.port, {
        'x-test-account-id': '99',
        'x-test-user': 'Cyrus',
      });
      client2.send({ type: 'join' });
      const welcome2 = await client2.next((m) => m.type === 'welcome');
      client2.send({ type: 'input', forward: 1, strafe: 0, yaw: 0 });
      await client2.next((m) => m.type === 'state' && m.players.some((p) => p.id === welcome2.id && p.z < -0.05));

      // Trigger onAccountDelete for account 42: disconnects client 1 and deletes both PG rows
      const closedPromise = client.closed();
      const deletePromises = [...deleteListeners].map((fn) => fn({ accountId: 42, username: 'Nerevarine' }));
      const closeInfo = await closedPromise;
      assert.equal(closeInfo.code, CLOSE.ACCOUNT);
      await Promise.all(deletePromises);

      assert.equal(await pgStore.findByAccount(42), null);
      assert.equal(pool.state.accountCharacters.has('42'), false);
      assert.equal(pool.state.players.has(welcome.id), false);

      // Account 99's character is still intact
      assert.ok(pool.state.players.has(welcome2.id));

      // Closing the server flushes all pending buffered writes for Cyrus cleanly
      await server.close();
      const cyrusRow = pool.state.players.get(welcome2.id);
      assert.ok(cyrusRow.z < -0.05, `expected Cyrus position to be flushed on close, got z=${cyrusRow.z}`);
      assert.equal(store.pendingCount, 0);
    } finally {
      await server.close();
    }
  });
});
