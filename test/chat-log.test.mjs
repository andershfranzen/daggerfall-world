import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../server/db.js';
import {
  CHAT_CHANNELS,
  createChatLogService,
  formatChatLine,
  normalizeChatEntry,
  openPostgresChatLog,
  openSqliteChatLog,
  runCli,
} from '../server/chat-log.js';

function createBufferStream() {
  let out = '';
  return {
    write(chunk) {
      out += String(chunk);
    },
    toString() {
      return out;
    },
  };
}

/**
 * Lightweight in-memory mock `pg` Pool that records DDL statements and executes
 * parameterized `$1..$n` inserts and filtered queries on `chat_messages`.
 */
function createMockPgPool({ failNextInsert = false } = {}) {
  const ddl = [];
  const queries = [];
  const rows = [];
  let nextId = 1;
  let endCalled = false;
  let shouldFailInsert = failNextInsert;

  function applyWhere(sql, params) {
    let filtered = rows.slice();
    const whereMatch = sql.match(/WHERE\s+([\s\S]*?)(?:\s+ORDER BY|\s*$)/i);
    if (!whereMatch) return filtered;
    const conditions = whereMatch[1].split(/\s+AND\s+/i).map((s) => s.trim());
    for (const cond of conditions) {
      let m;
      if ((m = cond.match(/^sender_account_id\s*=\s*\$(\d+)$/i))) {
        const val = params[Number(m[1]) - 1];
        filtered = filtered.filter((r) => r.sender_account_id === val);
      } else if ((m = cond.match(/^LOWER\(sender_name\)\s*=\s*LOWER\(\$(\d+)\)$/i))) {
        const val = String(params[Number(m[1]) - 1]).toLowerCase();
        filtered = filtered.filter((r) => r.sender_name.toLowerCase() === val);
      } else if ((m = cond.match(/^sender_player_id\s*=\s*\$(\d+)$/i))) {
        const val = Number(params[Number(m[1]) - 1]);
        filtered = filtered.filter((r) => r.sender_player_id === val);
      } else if ((m = cond.match(/^target_player_id\s*=\s*\$(\d+)$/i))) {
        const val = Number(params[Number(m[1]) - 1]);
        filtered = filtered.filter((r) => r.target_player_id === val);
      } else if ((m = cond.match(/^channel\s*=\s*\$(\d+)$/i))) {
        const val = params[Number(m[1]) - 1];
        filtered = filtered.filter((r) => r.channel === val);
      } else if ((m = cond.match(/^channel\s+IN\s*\(([^)]+)\)$/i))) {
        const allowed = new Set(
          m[1].split(',').map((ph) => params[Number(ph.trim().slice(1)) - 1])
        );
        filtered = filtered.filter((r) => allowed.has(r.channel));
      } else if ((m = cond.match(/^location\s*=\s*\$(\d+)$/i))) {
        const val = params[Number(m[1]) - 1];
        filtered = filtered.filter((r) => r.location === val);
      } else if ((m = cond.match(/^group_id\s*=\s*\$(\d+)$/i))) {
        const val = params[Number(m[1]) - 1];
        filtered = filtered.filter((r) => r.group_id === val);
      } else if ((m = cond.match(/^LOWER\(body\)\s+LIKE\s+\$(\d+)\s+ESCAPE\s+'\\'$/i))) {
        const pattern = String(params[Number(m[1]) - 1]);
        // Unwrap leading/trailing % and unescape LIKE wildcards for substring match
        const needle = pattern
          .replace(/^%/, '')
          .replace(/%$/, '')
          .replace(/\\([\\%_])/g, '$1');
        filtered = filtered.filter((r) => r.body.toLowerCase().includes(needle));
      } else if ((m = cond.match(/^created_at\s*>=\s*\$(\d+)$/i))) {
        const val = Number(params[Number(m[1]) - 1]);
        filtered = filtered.filter((r) => r.created_at >= val);
      } else if ((m = cond.match(/^created_at\s*<=\s*\$(\d+)$/i))) {
        const val = Number(params[Number(m[1]) - 1]);
        filtered = filtered.filter((r) => r.created_at <= val);
      } else {
        throw new Error(`Mock PG pool does not handle WHERE condition: ${cond}`);
      }
    }
    return filtered;
  }

  return {
    ddl,
    queries,
    get endCalled() {
      return endCalled;
    },
    setFailNextInsert(v) {
      shouldFailInsert = v;
    },
    async query(sql, params = []) {
      const normalized = sql.trim();
      queries.push({ sql: normalized, params });

      if (/^(CREATE\s+(TABLE|INDEX)|ALTER\s+TABLE)/i.test(normalized)) {
        ddl.push(normalized);
        return { rows: [], rowCount: 0 };
      }

      if (/^INSERT\s+INTO\s+chat_messages/i.test(normalized)) {
        if (shouldFailInsert) {
          shouldFailInsert = false;
          throw new Error('simulated postgres write failure');
        }
        const row = {
          id: String(nextId++),
          created_at: String(params[0]),
          channel: params[1],
          location: params[2],
          sender_player_id: params[3],
          sender_account_id: params[4],
          sender_name: params[5],
          target_player_id: params[6],
          target_name: params[7],
          group_id: params[8],
          body: params[9],
          recipient_ids: params[10] ?? null,
        };
        rows.push({ ...row, id: Number(row.id), created_at: Number(row.created_at) });
        return { rows: [row], rowCount: 1 };
      }

      if (/^SELECT\s+COUNT\(\*\)\s+AS\s+total/i.test(normalized)) {
        const filtered = applyWhere(normalized, params);
        return { rows: [{ total: String(filtered.length) }], rowCount: 1 };
      }

      if (/^SELECT\s+id,\s*created_at/i.test(normalized)) {
        const filtered = applyWhere(normalized, params);
        const asc = /ORDER\s+BY\s+created_at\s+ASC/i.test(normalized);
        filtered.sort((a, b) =>
          asc
            ? a.created_at - b.created_at || a.id - b.id
            : b.created_at - a.created_at || b.id - a.id
        );
        const limMatch = normalized.match(/LIMIT\s+\$(\d+)\s+OFFSET\s+\$(\d+)/i);
        const limit = limMatch ? Number(params[Number(limMatch[1]) - 1]) : 100;
        const offset = limMatch ? Number(params[Number(limMatch[2]) - 1]) : 0;
        const page = filtered.slice(offset, offset + limit).map((r) => ({
          ...r,
          id: String(r.id),
          created_at: String(r.created_at),
        }));
        return { rows: page, rowCount: page.length };
      }

      throw new Error(`Mock PG pool received unexpected SQL: ${normalized}`);
    },
    async end() {
      endCalled = true;
    },
  };
}

describe('chat-log SQLite store', () => {
  it('records all supported channels and queries with moderation filters & pagination', () => {
    const store = openSqliteChatLog(':memory:');
    try {
      const baseTime = 1_760_000_000_000;
      const samples = [
        { channel: 'say', location: 'town:Daggerfall/Gothway Garden', senderPlayerId: 1, senderAccountId: 'acct-1', senderName: 'Aldric', body: 'Hail travelers!', createdAt: baseTime + 1000 },
        { channel: 'shout', location: 'town:Daggerfall/Gothway Garden', senderPlayerId: 2, senderAccountId: 'acct-2', senderName: 'Brynja', body: 'Guards to the gate!', createdAt: baseTime + 2000 },
        { channel: 'party', location: 'dungeon:Privateer\'s Hold', senderPlayerId: 1, senderAccountId: 'acct-1', senderName: 'Aldric', groupId: 'party_abc', body: 'Watch the left corridor', createdAt: baseTime + 3000 },
        { channel: 'region', location: 'town:Daggerfall/Daggerfall', senderPlayerId: 3, senderAccountId: 'acct-3', senderName: 'Caelum', body: 'Selling 100% pure mithril_ore', createdAt: baseTime + 4000 },
        { channel: 'global', location: 'town:Wayrest/Wayrest', senderPlayerId: 2, senderAccountId: 'acct-2', senderName: 'Brynja', body: 'Anyone forming for Scourg Barrow?', createdAt: baseTime + 5000 },
        { channel: 'whisper', location: 'town:Wayrest/Wayrest', senderPlayerId: 1, senderAccountId: 'acct-1', senderName: 'Aldric', targetPlayerId: 2, targetName: 'Brynja', body: 'Meet me at the tavern', createdAt: baseTime + 6000 },
        { channel: 'emote', location: 'town:Daggerfall/Gothway Garden', senderPlayerId: 3, senderAccountId: 'acct-3', senderName: 'Caelum', body: 'raises a mug of ale', createdAt: baseTime + 7000 },
        { channel: 'guild', location: 'town:Daggerfall/Mages Guild', senderPlayerId: 1, senderAccountId: 'acct-1', senderName: 'Aldric', groupId: 'guild_mages', body: 'Spellcrafting workshop at dusk', createdAt: baseTime + 8000 },
        { channel: 'order', location: 'town:Sentinel/Order of the Candle', senderPlayerId: 4, senderAccountId: 'acct-4', senderName: 'Darian', groupId: 'order_candle', body: 'Report to the chapter house', createdAt: baseTime + 9000 },
        { channel: 'location', location: 'town:Daggerfall/Gothway Garden', senderPlayerId: 4, senderAccountId: 'acct-4', senderName: 'Darian', body: 'Local square check-in', createdAt: baseTime + 10000 },
      ];

      for (const s of samples) {
        const saved = store.record(s);
        assert.ok(saved.id > 0);
        assert.equal(saved.channel, s.channel);
        assert.equal(saved.body, s.body);
      }

      assert.equal(store.count(), samples.length);

      // Case-insensitive senderName search
      const byName = store.query({ senderName: 'ALDRIC' });
      assert.equal(byName.total, 4);
      assert.equal(byName.rows.length, 4);
      assert.equal(byName.rows[0].channel, 'guild'); // newest first

      // Account filter
      const byAccount = store.query({ accountId: 'acct-2' });
      assert.equal(byAccount.total, 2);
      assert.deepEqual(byAccount.rows.map((r) => r.channel), ['global', 'shout']);

      // Player filter
      const byPlayer = store.query({ playerId: 4 });
      assert.equal(byPlayer.total, 2);
      assert.deepEqual(byPlayer.rows.map((r) => r.channel), ['location', 'order']);

      // Single & multi-channel filter
      const whispers = store.query({ channel: 'whisper' });
      assert.equal(whispers.total, 1);
      assert.equal(whispers.rows[0].targetPlayerId, 2);
      assert.equal(whispers.rows[0].targetName, 'Brynja');

      const groupChats = store.query({ channel: ['guild', 'order'] });
      assert.equal(groupChats.total, 2);

      // Location & groupId filters
      const byLoc = store.query({ location: 'town:Daggerfall/Gothway Garden' });
      assert.equal(byLoc.total, 4);

      const byGroup = store.query({ groupId: 'party_abc' });
      assert.equal(byGroup.total, 1);
      assert.equal(byGroup.rows[0].body, 'Watch the left corridor');

      // Case-insensitive substring search with SQL LIKE wildcards escaped
      const byContains = store.query({ contains: '100% PURE MITHRIL_ORE' });
      assert.equal(byContains.total, 1);
      assert.equal(byContains.rows[0].senderName, 'Caelum');

      const noWildcardMatch = store.query({ contains: '100% pure mithrilXore' });
      assert.equal(noWildcardMatch.total, 0);

      // Time range filters (epoch ms and ISO strings)
      const inRange = store.query({
        since: baseTime + 3000,
        until: new Date(baseTime + 6000).toISOString(),
        order: 'asc',
      });
      assert.equal(inRange.total, 4);
      assert.deepEqual(inRange.rows.map((r) => r.channel), ['party', 'region', 'global', 'whisper']);

      // Pagination
      const page1 = store.query({ limit: 3, offset: 0 });
      const page2 = store.query({ limit: 3, offset: 3 });
      assert.equal(page1.total, 10);
      assert.equal(page1.rows.length, 3);
      assert.equal(page2.rows.length, 3);
      assert.notEqual(page1.rows[0].id, page2.rows[0].id);

      // Recent tail
      const latest = store.recent(2);
      assert.equal(latest.length, 2);
      assert.equal(latest[0].channel, 'location');
      assert.equal(latest[1].channel, 'order');
    } finally {
      store.close();
    }
  });

  it('persists messages across close and reopen on a real SQLite file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dfw-chat-log-'));
    const dbFile = join(dir, 'nested', 'world.db');
    try {
      const store1 = openSqliteChatLog(dbFile);
      const first = store1.record({
        channel: 'global',
        location: 'town:Daggerfall/Gothway Garden',
        senderPlayerId: 42,
        senderAccountId: 'acct-42',
        senderName: 'Elowen',
        body: 'Persisted across restarts!',
      });
      assert.equal(first.id, 1);
      store1.close();

      const store2 = openSqliteChatLog(dbFile);
      try {
        assert.equal(store2.count(), 1);
        const rows = store2.recent(10);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].senderName, 'Elowen');
        assert.equal(rows[0].senderAccountId, 'acct-42');
        assert.equal(rows[0].body, 'Persisted across restarts!');
      } finally {
        store2.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shares an existing server/db.js DatabaseSync without closing it on chatLog.close()', () => {
    const gameStore = openStore(':memory:');
    try {
      const { row } = gameStore.create('Seraphina');
      const chatLog = openSqliteChatLog(gameStore.db);
      chatLog.record({
        channel: 'say',
        location: 'town:Daggerfall/Gothway Garden',
        senderPlayerId: row.id,
        senderName: row.name,
        body: 'Sharing the game database cleanly.',
      });
      assert.equal(chatLog.count(), 1);

      // Closing the chat wrapper must NOT close the shared game DB.
      chatLog.close();
      const stillOpen = gameStore.db.prepare('SELECT COUNT(*) AS n FROM players').get();
      assert.equal(Number(stillOpen.n), 1);
    } finally {
      gameStore.close();
    }
  });

  it('validates input strictly and handles unexpected DB errors when safe: true', () => {
    assert.throws(() => normalizeChatEntry({ channel: 'unknown', senderName: 'A', body: 'hi' }), /unsupported chat channel/);
    assert.throws(() => normalizeChatEntry({ channel: 'say', senderName: '', body: 'hi' }), /senderName/);
    assert.throws(() => normalizeChatEntry({ channel: 'say', senderName: 'A', body: '   ' }), /body/);
    assert.throws(() => normalizeChatEntry({ channel: 'say', senderName: 'A', body: 'hi', createdAt: 'not-a-date' }), /createdAt/);

    const errors = [];
    const logger = { error: (...args) => errors.push(args.join(' ')) };
    const store = openSqliteChatLog(':memory:', { logger });
    store.close(); // force DB write error on subsequent insert

    // Validation still throws even when safe: true
    assert.throws(() => store.record({ channel: 'bad', senderName: 'A', body: 'hi' }, { safe: true }), /unsupported chat channel/);

    // Unexpected DB error is caught & logged when safe: true
    const result = store.record({ channel: 'say', senderName: 'A', body: 'hello' }, { safe: true });
    assert.equal(result, null);
    assert.equal(errors.length, 1);
  });
});

describe('chat-log PostgreSQL store (mock pg pool)', () => {
  it('runs additive DDL, parameterized inserts, and filtered queries', async () => {
    const pool = createMockPgPool();
    const store = await openPostgresChatLog(pool);

    // DDL executed: 1 CREATE TABLE + 4 CREATE INDEX + 1 ALTER TABLE (recipient_ids on older tables)
    assert.equal(pool.ddl.length, 6);
    assert.match(pool.ddl[0], /CREATE TABLE IF NOT EXISTS chat_messages/i);
    assert.match(pool.ddl[0], /BIGSERIAL PRIMARY KEY/i);

    const t0 = 1_760_100_000_000;
    const r1 = await store.record({
      channel: 'whisper',
      location: 'town:Wayrest/Wayrest',
      senderPlayerId: 10,
      senderAccountId: 'pg-acct-10',
      senderName: 'Morgiah',
      targetPlayerId: 11,
      targetName: 'Helseth',
      body: 'Meet at the palace courtyard.',
      createdAt: t0 + 1000,
    });
    const r2 = await store.record({
      channel: 'guild',
      location: 'town:Daggerfall/Fighters Guild',
      senderPlayerId: 12,
      senderAccountId: 'pg-acct-12',
      senderName: 'Gortwog',
      groupId: 'guild_fighters',
      body: 'Training begins at 50% stamina!',
      createdAt: t0 + 2000,
    });

    assert.equal(r1.id, 1);
    assert.equal(r2.id, 2);
    assert.equal(await store.count(), 2);

    // Verify parameterized $1..$10 insert was used
    const insertCall = pool.queries.find((q) => /^INSERT INTO chat_messages/i.test(q.sql));
    assert.ok(insertCall);
    assert.match(insertCall.sql, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10, \$11\)/);
    assert.equal(insertCall.params.length, 11);

    // Filtered queries
    const byUser = await store.query({ senderName: 'morgiah' });
    assert.equal(byUser.total, 1);
    assert.equal(byUser.rows[0].targetName, 'Helseth');

    const byContains = await store.query({ contains: '50% stamina', groupId: 'guild_fighters' });
    assert.equal(byContains.total, 1);
    assert.equal(byContains.rows[0].senderAccountId, 'pg-acct-12');

    const recent = await store.recent(1);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].channel, 'guild');

    // Safe error handling on unexpected DB failure
    const errors = [];
    const safeStore = await openPostgresChatLog(pool, {
      safe: true,
      logger: { error: (...a) => errors.push(a.join(' ')) },
    });
    pool.setFailNextInsert(true);
    const failed = await safeStore.record({ channel: 'say', senderName: 'Test', body: 'should not throw' });
    assert.equal(failed, null);
    assert.equal(errors.length, 1);

    // Closing a caller-owned pool does not call pool.end()
    await store.close();
    assert.equal(pool.endCalled, false);
  });
});

describe('createChatLogService wrapper', () => {
  it('logs every channel payload shape cleanly without throwing on optional fields', async () => {
    const sqliteStore = openSqliteChatLog(':memory:');
    const pgPool = createMockPgPool();
    const pgStore = await openPostgresChatLog(pgPool);
    try {
      const sqliteSvc = createChatLogService(sqliteStore);
      const pgSvc = createChatLogService(pgStore);

      const player = {
        id: 7,
        name: 'Jagar',
        accountId: 'acct-7',
        rpg: { location: 'town:Daggerfall/Gothway Garden' },
      };
      const target = { id: 8, name: 'Uriel' };

      // Exercise every channel with minimal/optional fields
      for (const ch of CHAT_CHANNELS) {
        const extra =
          ch === 'whisper'
            ? { target }
            : ch === 'party'
              ? { partyId: 'party_1' }
              : ch === 'guild'
                ? { guildId: 'guild_1' }
                : ch === 'order'
                  ? { orderId: 'order_1' }
                  : {};

        const savedSqlite = sqliteSvc.logChat(player, { channel: ch, text: `message on ${ch}`, ...extra });
        assert.ok(savedSqlite);
        assert.equal(savedSqlite.channel, ch);
        assert.equal(savedSqlite.senderPlayerId, 7);
        assert.equal(savedSqlite.senderAccountId, 'acct-7');
        assert.equal(savedSqlite.location, 'town:Daggerfall/Gothway Garden');

        const savedPg = await pgSvc.logChat({ player, channel: ch, body: `pg message on ${ch}`, ...extra });
        assert.ok(savedPg);
        assert.equal(savedPg.channel, ch);
      }

      // Guest player with no accountId and no rpg.location
      const guestSaved = sqliteSvc.logChat({
        channel: 'say',
        senderName: 'Wanderer',
        text: 'Hello from a guest',
      });
      assert.ok(guestSaved);
      assert.equal(guestSaved.senderAccountId, null);
      assert.equal(guestSaved.senderPlayerId, null);
      assert.equal(guestSaved.location, '');

      assert.equal(sqliteSvc.countChat(), CHAT_CHANNELS.length + 1);
      assert.equal(await pgSvc.countChat(), CHAT_CHANNELS.length);

      const queried = sqliteSvc.queryChat({ channel: 'whisper' });
      assert.equal(queried.total, 1);
      assert.equal(queried.rows[0].targetPlayerId, 8);
      assert.equal(queried.rows[0].targetName, 'Uriel');
    } finally {
      sqliteStore.close();
      await pgStore.close();
    }
  });
});

describe('operator CLI & standalone PostgreSQL schema', () => {
  it('supports tail, search, and count subcommands via runCli', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dfw-chat-cli-'));
    const dbFile = join(dir, 'world.db');
    try {
      const store = openSqliteChatLog(dbFile);
      store.record({
        channel: 'say',
        location: 'town:Daggerfall/Gothway Garden',
        senderPlayerId: 1,
        senderAccountId: 'acct-cli-1',
        senderName: 'Tiber',
        body: 'Welcome to the realm.',
        createdAt: 1_760_200_000_000,
      });
      store.record({
        channel: 'global',
        location: 'town:Wayrest/Wayrest',
        senderPlayerId: 2,
        senderAccountId: 'acct-cli-2',
        senderName: 'Barenziah',
        body: 'Looking for a healer!',
        createdAt: 1_760_200_010_000,
      });
      store.close();

      // tail
      const tailOut = createBufferStream();
      const tailErr = createBufferStream();
      const tailCode = await runCli(['tail', '5'], {
        stdout: tailOut,
        stderr: tailErr,
        env: { CHAT_LOG_DB_PATH: dbFile },
      });
      assert.equal(tailCode, 0);
      assert.equal(tailErr.toString(), '');
      assert.match(tailOut.toString(), /Barenziah.*Looking for a healer!/);
      assert.match(tailOut.toString(), /Tiber.*Welcome to the realm\./);

      // search --json
      const searchOut = createBufferStream();
      const searchErr = createBufferStream();
      const searchCode = await runCli(
        ['search', '--user', 'tiber', '--channel', 'say', '--contains', 'realm', '--json'],
        { stdout: searchOut, stderr: searchErr, env: { DB_PATH: dbFile } }
      );
      assert.equal(searchCode, 0);
      const parsed = JSON.parse(searchOut.toString());
      assert.equal(parsed.total, 1);
      assert.equal(parsed.rows[0].senderAccountId, 'acct-cli-1');

      // count
      const countOut = createBufferStream();
      const countCode = await runCli(['count', '--db', dbFile], {
        stdout: countOut,
        stderr: createBufferStream(),
        env: {},
      });
      assert.equal(countCode, 0);
      assert.equal(countOut.toString().trim(), '2');

      // formatChatLine helper sanity check
      const line = formatChatLine(parsed.rows[0]);
      assert.match(line, /\[SAY\].*Tiber#1 acct=acct-cli-1: Welcome to the realm\./);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ships a valid additive PostgreSQL DDL in server/storage/schema-chat.sql', () => {
    const sqlPath = fileURLToPath(new URL('../server/storage/schema-chat.sql', import.meta.url));
    const sql = readFileSync(sqlPath, 'utf8');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS chat_messages/i);
    assert.match(sql, /id BIGSERIAL PRIMARY KEY/i);
    assert.match(sql, /created_at BIGINT NOT NULL/i);
    assert.match(sql, /idx_chat_messages_created_at/i);
    assert.match(sql, /idx_chat_messages_sender_account_created/i);
    assert.match(sql, /idx_chat_messages_sender_name_created/i);
    assert.match(sql, /idx_chat_messages_channel_created/i);
  });
});

describe('chat-log review fixes', () => {
  it('stores who heard each message and upgrades an existing table', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    // A table written by the first release, before recipient_ids existed.
    db.exec(`CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
      channel TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', sender_player_id INTEGER, sender_account_id TEXT,
      sender_name TEXT NOT NULL, target_player_id INTEGER, target_name TEXT, group_id TEXT, body TEXT NOT NULL)`);
    db.prepare(`INSERT INTO chat_messages (created_at, channel, sender_name, body) VALUES (1, 'say', 'Old', 'kept')`).run();
    const log = createChatLogService(openSqliteChatLog(db));
    log.logChat({ id: 7, name: 'Aldric', accountId: 3, rpg: { location: 'town:Daggerfall/Daggerfall' } },
      { channel: 'shout', text: 'Watch out!', recipientIds: [8, 9] });
    const rows = log.queryChat({ order: 'asc' }).rows;
    assert.equal(rows[0].body, 'kept');
    assert.equal(rows[0].recipientIds, null);
    assert.deepEqual(rows[1].recipientIds, [8, 9]);
  });

  it('PostgreSQL store adds and returns recipient_ids', async () => {
    const pool = createMockPgPool();
    const store = await openPostgresChatLog(pool);
    assert.ok(pool.queries.some((q) => /ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS recipient_ids/i.test(q.sql)));
    const r = await store.record({ channel: 'say', senderName: 'A', body: 'x', recipientIds: [2] });
    assert.deepEqual(r.recipientIds, [2]);
  });

  it('CLI reads the database the game server writes by default', async () => {
    const { DEFAULTS } = await import('../server/game.js');
    const { CLI_DEFAULT_DB_PATH } = await import('../server/chat-log.js');
    assert.equal(CLI_DEFAULT_DB_PATH, DEFAULTS.dbPath);
  });
});
