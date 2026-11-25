// Live PostgreSQL 17 integration test (runs when DFW_LIVE_PG_URL is set, skips otherwise).
// Exercises the REAL pg driver against a real PostgreSQL instance:
//   - server/storage/schema.sql (players, account_characters, world_state, accounts, sessions, moderation_log, chat_messages)
//   - server/storage/postgres-game.js + createBufferedGameStore
//   - server/storage/postgres-accounts.js + real PostgreSQL LISTEN/NOTIFY moderation fan-out
//   - server/chat-log.js (openPostgresChatLog)
//   - server/scale/world-bus.js (createPostgresBus real LISTEN/NOTIFY cross-worker messaging)
//   - tools/migrate-to-postgres.mjs (real SQLite -> real PostgreSQL 17 migration + idempotency)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/db.js';
import { createAccounts } from '../server/accounts.js';
import { openPostgresGameStore, createBufferedGameStore, createPgPool } from '../server/storage/postgres-game.js';
import { openPostgresAccountStore } from '../server/storage/postgres-accounts.js';
import { openPostgresChatLog } from '../server/chat-log.js';
import { createPostgresBus, createWorldBus } from '../server/scale/world-bus.js';
import { migrateSqliteToPostgres } from '../tools/migrate-to-postgres.mjs';

const PG_URL = process.env.DFW_LIVE_PG_URL;

test('live PostgreSQL 17 end-to-end: game store, buffered commits, accounts + LISTEN/NOTIFY, chat log, world bus, and SQLite migration', {
  skip: !PG_URL ? 'set DFW_LIVE_PG_URL to run live PostgreSQL integration test' : false,
}, async () => {
  const pool = await createPgPool(PG_URL);
  const tmp = mkdtempSync(join(tmpdir(), 'dfw-live-pg-'));
  try {
    // 1. Game store + schema + buffered write-behind commits.
    const pgGame = await openPostgresGameStore({ pool, applySchema: true });
    const buffered = createBufferedGameStore(pgGame);

    const accChar = await pgGame.createForAccount('pg-acc-1', 'Gothryd', 'Gothryd');
    assert.ok(accChar.id > 0);
    accChar.x = 42.5;
    accChar.z = -17.25;
    accChar.rpg = { gold: 777, location: 'town:Daggerfall/Gothway Garden' };
    buffered.saveCharacters([accChar], [['pg-test:shop:1', { purse: 1200 }]]);
    await buffered.flush();

    const loaded = await pgGame.findByAccount('pg-acc-1');
    assert.equal(loaded.x, 42.5);
    assert.equal(loaded.rpg.gold, 777);
    const worldRows = await pgGame.loadWorld('pg-test:');
    assert.deepEqual(worldRows, [['pg-test:shop:1', { purse: 1200 }]]);

    // 2. Accounts store + real LISTEN/NOTIFY moderation fan-out.
    const pgAccounts = await openPostgresAccountStore({ pool, applySchema: false });
    const receivedMod = [];
    const unsub = await pgAccounts.listenModeration((ev) => receivedMod.push(ev));
    const createdAcc = await pgAccounts.createAccount('LivePgHero', 'scrypt$1024$8$1$salt$hash');
    assert.ok(createdAcc.id > 0);
    await pgAccounts.ban('LivePgHero', { reason: 'live pg moderation check', actor: 'test-operator' });
    for (let i = 0; i < 40 && !receivedMod.length; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(receivedMod.some((e) => e.accountId === createdAcc.id && e.action === 'ban'), 'real PG LISTEN/NOTIFY delivered ban event');
    await unsub();

    // 3. Persistent chat log in real PostgreSQL chat_messages table.
    const pgChat = await openPostgresChatLog(pool);
    await pgChat.record({
      channel: 'shout',
      location: 'town:Daggerfall/Gothway Garden',
      senderPlayerId: accChar.id,
      senderAccountId: String(createdAcc.id),
      senderName: 'Gothryd',
      body: 'Live Postgres chat persistence works!',
    });
    const chatRes = await pgChat.query({ senderName: 'gothryd', channel: 'shout' });
    assert.equal(chatRes.rows.length, 1);
    assert.equal(chatRes.rows[0].body, 'Live Postgres chat persistence works!');

    // 4. Real PostgreSQL LISTEN/NOTIFY cross-worker WorldBus.
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    const workerA = await createPostgresBus({ client: clientA, publishClient: pool, workerId: 'worker-daggerfall', secret: 'live-pg-secret' }).connect();
    const workerB = await createPostgresBus({ client: clientB, publishClient: pool, workerId: 'worker-sentinel', secret: 'live-pg-secret' }).connect();
    const relayed = [];
    workerB.onChat((msg) => relayed.push(msg));
    await workerA.publishChat({ channel: 'global', from: 'Gothryd', text: 'Cross-worker PG bus hello!' });
    for (let i = 0; i < 40 && !relayed.length; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(relayed.some((m) => m.text === 'Cross-worker PG bus hello!'), 'real PG WorldBus relayed cross-worker chat');
    await workerA.close();
    await workerB.close();
    clientA.release();
    clientB.release();

    // 5. Real SQLite -> PostgreSQL 17 migration via tools/migrate-to-postgres.mjs (into clean target tables).
    await pool.query('TRUNCATE account_characters, players, world_state, sessions, moderation_log, accounts RESTART IDENTITY CASCADE');
    const sqliteGamePath = join(tmp, 'game.db');
    const sqliteAccPath = join(tmp, 'accounts.db');
    const sg = openStore(sqliteGamePath);
    const migRow = sg.createForAccount('mig-acc-99', 'Barenziah', 'Barenziah');
    migRow.rpg = { gold: 999, migrated: true };
    sg.saveCharacters([migRow], [['mig:world:1', { ok: true }]]);
    sg.close();
    const sa = createAccounts({ dbPath: sqliteAccPath, secureCookies: false, scrypt: { N: 1024, r: 8, p: 1, keyLen: 32 } });
    sa.close();

    const summary1 = await migrateSqliteToPostgres({ gameDbPath: sqliteGamePath, accountsDbPath: sqliteAccPath, databaseUrl: PG_URL, pool });
    assert.ok(summary1.game.players >= 1);
    const summary2 = await migrateSqliteToPostgres({ gameDbPath: sqliteGamePath, accountsDbPath: sqliteAccPath, databaseUrl: PG_URL, pool });
    assert.ok(summary2.game.players >= 1, 'migration is idempotent on repeat run');
    const migrated = await pgGame.findByAccount('mig-acc-99');
    assert.equal(migrated.name, 'Barenziah');
    assert.equal(migrated.rpg.gold, 999);

    await pgAccounts.close();
    await pgGame.close();
  } finally {
    await pool.end();
    rmSync(tmp, { recursive: true, force: true });
  }
});
