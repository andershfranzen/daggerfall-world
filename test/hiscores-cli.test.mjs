import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseArgs,
  formatTable,
  redactDbUrl,
  runHiscoresCli,
} from '../tools/hiscores.mjs';

function makeIo(extra = {}) {
  let out = '';
  let err = '';
  return {
    io: {
      stdout: { write(chunk) { out += String(chunk); } },
      stderr: { write(chunk) { err += String(chunk); } },
      env: {},
      ...extra,
    },
    get stdout() { return out; },
    get stderr() { return err; },
  };
}

function createFixtureDbs() {
  const dir = mkdtempSync(join(tmpdir(), 'dfw-hiscores-cli-'));
  const gameDbPath = join(dir, 'game.db');
  const accountsDbPath = join(dir, 'accounts.db');

  // Accounts DB with one banned account (id=3)
  const accDb = new DatabaseSync(accountsDbPath);
  accDb.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      banned_at INTEGER
    );
  `);
  accDb.prepare('INSERT INTO accounts (id, username, banned_at) VALUES (?, ?, ?)').run(1, 'aldric', null);
  accDb.prepare('INSERT INTO accounts (id, username, banned_at) VALUES (?, ?, ?)').run(2, 'lyra', null);
  accDb.prepare('INSERT INTO accounts (id, username, banned_at) VALUES (?, ?, ?)').run(3, 'banned_cheater', 1700000000000);
  accDb.close();

  // Game DB with players, account_characters, and world_state (pguild:*)
  const db = new DatabaseSync(gameDbPath);
  db.exec(`
    CREATE TABLE players (
      id INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL,
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
      player_id INTEGER NOT NULL UNIQUE,
      username TEXT NOT NULL,
      linked_at INTEGER NOT NULL
    );
    CREATE TABLE world_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const insertPlayer = db.prepare(
    'INSERT INTO players (id, token_hash, name, created_at, last_seen, rpg) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertLink = db.prepare(
    'INSERT INTO account_characters (account_id, player_id, username, linked_at) VALUES (?, ?, ?, ?)',
  );
  const insertWorld = db.prepare(
    'INSERT INTO world_state (key, value, updated_at) VALUES (?, ?, ?)',
  );

  insertPlayer.run(
    1,
    'hash-1',
    'Aldric',
    1700000001000,
    1700000100000,
    JSON.stringify({
      character: {
        created: true,
        className: 'Mage',
        race: 'Breton',
        level: 14,
        skills: { Destruction: 85, Thaumaturgy: 72, 'Long Blade': 40 },
      },
      chronicles: {
        questsCompleted: 18,
        monstersSlain: 240,
      },
      guilds: {
        mages: { rank: 6, title: 'Magus', variantName: 'Mages Guild' },
      },
      travel: { discovered: ['Daggerfall', 'Wayrest', 'Sentinel'], trips: 12 },
      law: { rep: { Daggerfall: -15 } },
      admiralty: { standing: { Daggerfall: 210 }, log: { sunk: { pirate: 5 } } },
      playerGuild: { id: 'order-bay', tag: 'IBG', name: 'Iliac Bay Guard', rank: 'Leader' },
    }),
  );
  insertLink.run('1', 1, 'aldric', 1700000001000);

  insertPlayer.run(
    2,
    'hash-2',
    'Lyra',
    1700000002000,
    1700000200000,
    JSON.stringify({
      character: {
        created: true,
        className: 'Ranger',
        race: 'Redguard',
        level: 11,
        skills: { Archery: 90, 'Long Blade': 65, Stealth: 50 },
      },
      chronicles: {
        questsCompleted: 9,
        monstersSlain: 310,
      },
      guilds: {
        fighters: { rank: 5, title: 'Swordsman', variantName: 'Fighters Guild' },
      },
      travel: { discovered: ['Daggerfall', 'Betony'], trips: 8 },
      law: { rep: { Sentinel: -60 } },
      admiralty: { standing: { Sentinel: 400 }, log: { sunk: { pirate: 20 } } },
      playerGuild: { id: 'order-corsairs', tag: 'CRS', name: 'Bay Corsairs', rank: 'Leader' },
    }),
  );
  insertLink.run('2', 2, 'lyra', 1700000002000);

  // Banned account character — must be skipped by rebuild
  insertPlayer.run(
    3,
    'hash-3',
    'Cheater',
    1700000003000,
    1700000300000,
    JSON.stringify({
      character: {
        created: true,
        className: 'Mage',
        race: 'Breton',
        level: 99,
        skills: { Destruction: 100 },
      },
    }),
  );
  insertLink.run('3', 3, 'banned_cheater', 1700000003000);

  insertWorld.run(
    'pguild:order-bay',
    JSON.stringify({
      id: 'order-bay',
      name: 'Iliac Bay Guard',
      tag: 'IBG',
      leaderId: 1,
      leaderName: 'Aldric',
      members: { '1': { id: 1, name: 'Aldric', rank: 'Leader' } },
      treasury: 50000,
      createdAt: 1700000001000,
    }),
    1700000100000,
  );

  insertWorld.run(
    'pguild:order-corsairs',
    JSON.stringify({
      id: 'order-corsairs',
      name: 'Bay Corsairs',
      tag: 'CRS',
      leaderId: 2,
      leaderName: 'Lyra',
      members: { '2': { id: 2, name: 'Lyra', rank: 'Leader' } },
      treasury: 120000,
      createdAt: 1700000002000,
    }),
    1700000200000,
  );

  db.close();
  return {
    dir,
    gameDbPath,
    accountsDbPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Unit tests for exported helpers
// ---------------------------------------------------------------------------

test('parseArgs parses subcommands, flags, equals syntax, and backend precedence', () => {
  const topArgs = parseArgs(
    ['top', '--board', 'slayer', '--limit=10', '--class', 'Mage', '--race', 'Breton', '--json'],
    { DB_PATH: '/tmp/game.db' },
  );
  assert.equal(topArgs.command, 'top');
  assert.equal(topArgs.board, 'slayer');
  assert.equal(topArgs.limit, 10);
  assert.equal(topArgs.className, 'Mage');
  assert.equal(topArgs.race, 'Breton');
  assert.equal(topArgs.json, true);
  assert.equal(topArgs.backend, 'sqlite');

  const pgEnv = parseArgs(['stats'], { DATABASE_URL: 'postgres://u:secret@localhost:5432/dfw' });
  assert.equal(pgEnv.backend, 'postgres');
  assert.equal(pgEnv.databaseUrl, 'postgres://u:secret@localhost:5432/dfw');

  // Explicit --db overrides DATABASE_URL in env
  const overrideDb = parseArgs(['stats', '--db', '/tmp/local.db'], {
    DATABASE_URL: 'postgres://u:secret@localhost:5432/dfw',
  });
  assert.equal(overrideDb.backend, 'sqlite');
  assert.equal(overrideDb.databaseUrl, null);

  assert.throws(() => parseArgs(['top', '--limit', '0']), /positive integer/);
  assert.throws(() => parseArgs(['top', '--unknown']), /unknown option/);
  assert.throws(() => parseArgs(['top', '--board']), /requires a value/);
});

test('formatTable aligns headers, right-aligns numbers, and formats empty cells', () => {
  const table = formatTable(
    ['Rank', 'Name', 'Score'],
    [
      ['#1', 'Aldric', '1,240'],
      ['#2', 'Lyra', null],
    ],
  );
  const lines = table.split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^Rank \| Name   \| Score$/);
  assert.match(lines[1], /^-----\+--------\+------$/);
  assert.match(lines[2], /^  #1 \| Aldric \| 1,240$/);
  assert.match(lines[3], /^  #2 \| Lyra   \|     -$/);
});

test('redactDbUrl masks passwords in URLs, query strings, and libpq strings without touching paths', () => {
  assert.equal(
    redactDbUrl('postgres://dfw:superSecret123@db.example.com:5432/daggerfall'),
    'postgres://dfw:***@db.example.com:5432/daggerfall',
  );
  assert.equal(
    redactDbUrl('postgresql://admin:p@ss!word@127.0.0.1:5432/dfw'),
    'postgresql://admin:***@127.0.0.1:5432/dfw',
  );
  assert.equal(
    redactDbUrl('postgres://dfw@localhost:5432/dfw?password=mysecret&sslmode=require'),
    'postgres://dfw@localhost:5432/dfw?password=***&sslmode=require',
  );
  assert.equal(
    redactDbUrl('host=localhost user=dfw password=topsecret dbname=dfw'),
    'host=localhost user=dfw password=*** dbname=dfw',
  );
  assert.equal(redactDbUrl('/var/data/daggerfallworld.db'), '/var/data/daggerfallworld.db');
  assert.equal(redactDbUrl(''), '');
});

// ---------------------------------------------------------------------------
// End-to-end CLI tests against a temporary SQLite database
// ---------------------------------------------------------------------------

test('help and error exit codes on missing/unknown subcommands', async () => {
  const helpRun = makeIo();
  assert.equal(await runHiscoresCli(['help'], helpRun.io), 0);
  assert.match(helpRun.stdout, /Chronicles of the Iliac Bay/);

  const flagHelp = makeIo();
  assert.equal(await runHiscoresCli(['--help'], flagHelp.io), 0);
  assert.match(flagHelp.stdout, /Usage:/);

  const missing = makeIo();
  assert.equal(await runHiscoresCli([], missing.io), 2);
  assert.match(missing.stderr, /missing subcommand/);

  const unknown = makeIo();
  assert.equal(await runHiscoresCli(['bogus'], unknown.io), 2);
  assert.match(unknown.stderr, /unknown subcommand/);

  const missingPlayer = makeIo();
  assert.equal(await runHiscoresCli(['player'], missingPlayer.io), 2);
  assert.match(missingPlayer.stderr, /requires a <name>/);

  const badSort = makeIo();
  assert.equal(await runHiscoresCli(['orders', '--sort', 'invalid'], badSort.io), 2);
  assert.match(badSort.stderr, /invalid --sort/);
});

test('rebuild, top, player, orders, and stats work end-to-end on temp SQLite DB', async () => {
  const fx = createFixtureDbs();
  try {
    // 1. rebuild (excludes banned account id=3)
    const reb = makeIo();
    const rebCode = await runHiscoresCli(
      ['rebuild', '--db', fx.gameDbPath, '--accounts-db', fx.accountsDbPath],
      reb.io,
    );
    assert.equal(rebCode, 0, reb.stderr);
    assert.equal(reb.stdout.trim(), 'rebuilt 2 characters, 2 orders, 1 skipped');

    // 2. top overall (ASCII table)
    const topAscii = makeIo();
    assert.equal(
      await runHiscoresCli(['top', '--db', fx.gameDbPath, '--board', 'overall', '--limit', '10'], topAscii.io),
      0,
      topAscii.stderr,
    );
    assert.match(topAscii.stdout, /Overall/);
    assert.match(topAscii.stdout, /Lyra/);
    assert.match(topAscii.stdout, /Aldric/);
    assert.doesNotMatch(topAscii.stdout, /Cheater/);

    // 3. top with --class, --race, and --json
    const topJson = makeIo();
    assert.equal(
      await runHiscoresCli(
        ['top', '--db', fx.gameDbPath, '--board', 'slayer', '--class', 'Mage', '--race', 'Breton', '--json'],
        topJson.io,
      ),
      0,
      topJson.stderr,
    );
    const topPayload = JSON.parse(topJson.stdout);
    assert.equal(topPayload.board, 'slayer');
    assert.equal(topPayload.entries.length, 1);
    assert.equal(topPayload.entries[0].name, 'Aldric');
    assert.equal(topPayload.entries[0].score, 240);

    // 4. top skill:* and guild:*
    const topSkill = makeIo();
    assert.equal(
      await runHiscoresCli(['top', '--db', fx.gameDbPath, '--board', 'skill:Archery', '--json'], topSkill.io),
      0,
      topSkill.stderr,
    );
    const skillPayload = JSON.parse(topSkill.stdout);
    assert.equal(skillPayload.entries[0].name, 'Lyra');
    assert.equal(skillPayload.entries[0].score, 90);

    const topGuild = makeIo();
    assert.equal(
      await runHiscoresCli(['top', '--db', fx.gameDbPath, '--board', 'guild:mages', '--json'], topGuild.io),
      0,
      topGuild.stderr,
    );
    const guildPayload = JSON.parse(topGuild.stdout);
    assert.equal(guildPayload.entries[0].name, 'Aldric');
    assert.equal(guildPayload.entries[0].score, 6);

    // 5. player (ASCII summary & JSON & not-found)
    const playerTxt = makeIo();
    assert.equal(
      await runHiscoresCli(['player', 'Aldric', '--db', fx.gameDbPath], playerTxt.io),
      0,
      playerTxt.stderr,
    );
    assert.match(playerTxt.stdout, /=== Aldric \[IBG\] ===/);
    assert.match(playerTxt.stdout, /Chronicle Standings:/);
    assert.match(playerTxt.stdout, /Mages Guild/);
    assert.match(playerTxt.stdout, /Destruction/);

    const playerJson = makeIo();
    assert.equal(
      await runHiscoresCli(['player', 'lyra', '--db', fx.gameDbPath, '--json'], playerJson.io),
      0,
      playerJson.stderr,
    );
    const lyra = JSON.parse(playerJson.stdout);
    assert.equal(lyra.player.name, 'Lyra');
    assert.equal(lyra.summary.admiraltyScore, 900);

    const missingPlayer = makeIo();
    assert.equal(
      await runHiscoresCli(['player', 'Ghost', '--db', fx.gameDbPath], missingPlayer.io),
      1,
    );
    assert.match(missingPlayer.stderr, /not found/);

    // 6. orders (--sort treasury & --sort level & --json)
    const ordersTreasury = makeIo();
    assert.equal(
      await runHiscoresCli(['orders', '--db', fx.gameDbPath, '--sort', 'treasury', '--json'], ordersTreasury.io),
      0,
      ordersTreasury.stderr,
    );
    const ordersPayload = JSON.parse(ordersTreasury.stdout);
    assert.equal(ordersPayload.entries.length, 2);
    assert.equal(ordersPayload.entries[0].tag, 'CRS');
    assert.equal(ordersPayload.entries[0].treasury, 120000);

    const ordersAscii = makeIo();
    assert.equal(
      await runHiscoresCli(['orders', '--db', fx.gameDbPath, '--sort', 'level'], ordersAscii.io),
      0,
      ordersAscii.stderr,
    );
    assert.match(ordersAscii.stdout, /Iliac Bay Guard/);
    assert.match(ordersAscii.stdout, /Bay Corsairs/);

    // 7. stats (ASCII & JSON)
    const statsJson = makeIo();
    assert.equal(
      await runHiscoresCli(['stats', '--db', fx.gameDbPath, '--json'], statsJson.io),
      0,
      statsJson.stderr,
    );
    const stats = JSON.parse(statsJson.stdout);
    assert.equal(stats.characters, 2);
    assert.equal(stats.orders, 2);
    assert.equal(stats.backend, 'sqlite');
    assert.equal(stats.target, fx.gameDbPath);
  } finally {
    fx.cleanup();
  }
});

test('stats with injected postgres deps redacts credentials and never leaks password', async () => {
  let closed = false;
  const mockDeps = {
    async openPostgresHiscoresStore() {
      return {
        async count() {
          return { characters: 42, orders: 7 };
        },
        async close() {
          closed = true;
        },
      };
    },
  };

  const run = makeIo({ deps: mockDeps });
  const code = await runHiscoresCli(
    ['stats', '--database-url', 'postgres://dfw_admin:TopSecretPass!@prod.db.internal:5432/iliac', '--json'],
    run.io,
  );
  assert.equal(code, 0, run.stderr);
  assert.equal(closed, true);
  assert.doesNotMatch(run.stdout, /TopSecretPass/);
  const data = JSON.parse(run.stdout);
  assert.equal(data.backend, 'postgres');
  assert.equal(data.characters, 42);
  assert.equal(data.orders, 7);
  assert.equal(data.target, 'postgres://dfw_admin:***@prod.db.internal:5432/iliac');
});
