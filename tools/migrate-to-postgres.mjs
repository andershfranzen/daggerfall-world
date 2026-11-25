#!/usr/bin/env node
// Idempotent SQLite -> PostgreSQL migration CLI for Daggerfall World.
// Reads existing SQLite game (DB_PATH) and accounts (ACCOUNTS_DB_PATH) databases
// via node:sqlite and upserts all rows into PostgreSQL in transactions.
//
// Usage:
//   node tools/migrate-to-postgres.mjs --dry-run
//   DATABASE_URL=postgres://dfw:pass@localhost:5432/daggerfallworld \
//     node tools/migrate-to-postgres.mjs
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgPool, loadSchemaSql } from '../server/storage/postgres-game.js';

const DEFAULT_GAME_DB = fileURLToPath(new URL('../server/data/daggerfallworld.db', import.meta.url));
const DEFAULT_ACCOUNTS_DB = fileURLToPath(new URL('../server/data/accounts.db', import.meta.url));

const USAGE = `usage: node tools/migrate-to-postgres.mjs [options]
  --game-db <path>                SQLite game database (default: DB_PATH or server/data/daggerfallworld.db)
  --accounts-db <path>            SQLite accounts database (default: ACCOUNTS_DB_PATH or server/data/accounts.db)
  --database-url <url>            Target PostgreSQL URL for game store (default: DATABASE_URL)
  --accounts-database-url <url>   Target PostgreSQL URL for accounts store (default: ACCOUNTS_DATABASE_URL or --database-url)
  --skip-game                     Do not migrate the game database
  --skip-accounts                 Do not migrate the accounts database
  --dry-run                       Validate and count SQLite rows without writing to PostgreSQL
  -h, --help                      Show this help message`;

function hasTable(db, name) {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return Boolean(row?.ok);
}

function readGameSqlite(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const players = hasTable(db, 'players')
      ? db.prepare('SELECT id, token_hash, name, x, z, yaw, created_at, last_seen, rpg FROM players ORDER BY id').all()
      : [];
    const accountCharacters = hasTable(db, 'account_characters')
      ? db.prepare('SELECT account_id, player_id, username, linked_at FROM account_characters ORDER BY account_id').all()
      : [];
    const worldState = hasTable(db, 'world_state')
      ? db.prepare('SELECT key, value, updated_at FROM world_state ORDER BY key').all()
      : [];
    // Older SQLite files have no recipient_ids column (added with the chat audience record).
    const hasRecipients = hasTable(db, 'chat_messages') &&
      db.prepare('PRAGMA table_info(chat_messages)').all().some((c) => c.name === 'recipient_ids');
    const chatMessages = hasTable(db, 'chat_messages')
      ? db
          .prepare(
            `SELECT id, created_at, channel, location, sender_player_id, sender_account_id, sender_name,
                    target_player_id, target_name, group_id, body,
                    ${hasRecipients ? 'recipient_ids' : 'NULL AS recipient_ids'}
               FROM chat_messages ORDER BY id`,
          )
          .all()
          .map((m) => ({ ...m, id: Number(m.id), created_at: Number(m.created_at) }))
      : [];

    const validatedPlayers = players.map((p) => {
      let rpgObj;
      try {
        rpgObj = JSON.parse(p.rpg ?? '{}');
      } catch {
        throw new Error(`players.id=${p.id} has invalid JSON in rpg column`);
      }
      if (!rpgObj || typeof rpgObj !== 'object' || Array.isArray(rpgObj)) {
        throw new Error(`players.id=${p.id} rpg column must be a JSON object`);
      }
      return {
        id: Number(p.id),
        token_hash: p.token_hash,
        name: p.name,
        x: Number(p.x),
        z: Number(p.z),
        yaw: Number(p.yaw),
        created_at: Number(p.created_at),
        last_seen: Number(p.last_seen),
        rpg: JSON.stringify(rpgObj),
      };
    });

    const validatedLinks = accountCharacters.map((a) => ({
      account_id: String(a.account_id),
      player_id: Number(a.player_id),
      username: a.username,
      linked_at: Number(a.linked_at),
    }));

    const validatedWorld = worldState.map((w) => {
      try {
        JSON.parse(w.value);
      } catch {
        throw new Error(`world_state.key=${JSON.stringify(w.key)} has invalid JSON in value column`);
      }
      return {
        key: w.key,
        value: w.value,
        updated_at: Number(w.updated_at),
      };
    });

    return {
      players: validatedPlayers,
      accountCharacters: validatedLinks,
      worldState: validatedWorld,
      chatMessages,
    };
  } finally {
    if (db.isOpen) db.close();
  }
}

function readAccountsSqlite(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const hasRecovery = hasTable(db, 'accounts') &&
      db.prepare('PRAGMA table_info(accounts)').all().some((c) => c.name === 'recovery_hash');
    const accounts = hasTable(db, 'accounts')
      ? db
          .prepare(
            `SELECT id, username, username_key, password_hash, created_at,
                    last_login_at, muted_until, mute_reason, banned_at, ban_reason,
                    ${hasRecovery ? 'recovery_hash' : 'NULL AS recovery_hash'}
               FROM accounts ORDER BY id`,
          )
          .all()
      : [];
    const sessions = hasTable(db, 'sessions')
      ? db
          .prepare(
            `SELECT id, token_hash, account_id, created_at, last_seen_at, expires_at
               FROM sessions ORDER BY id`,
          )
          .all()
      : [];
    const moderationLog = hasTable(db, 'moderation_log')
      ? db
          .prepare(
            `SELECT id, account_id, action, reason, until, actor, at
               FROM moderation_log ORDER BY id`,
          )
          .all()
      : [];

    return {
      accounts: accounts.map((a) => ({
        id: Number(a.id),
        username: a.username,
        username_key: a.username_key,
        password_hash: a.password_hash,
        created_at: Number(a.created_at),
        last_login_at: a.last_login_at == null ? null : Number(a.last_login_at),
        muted_until: a.muted_until == null ? null : Number(a.muted_until),
        mute_reason: a.mute_reason ?? null,
        banned_at: a.banned_at == null ? null : Number(a.banned_at),
        ban_reason: a.ban_reason ?? null,
        recovery_hash: a.recovery_hash ?? null,
      })),
      sessions: sessions.map((s) => ({
        id: Number(s.id),
        token_hash: s.token_hash,
        account_id: Number(s.account_id),
        created_at: Number(s.created_at),
        last_seen_at: Number(s.last_seen_at),
        expires_at: Number(s.expires_at),
      })),
      moderationLog: moderationLog.map((m) => ({
        id: Number(m.id),
        account_id: Number(m.account_id),
        action: m.action,
        reason: m.reason ?? null,
        until: m.until == null ? null : Number(m.until),
        actor: m.actor,
        at: Number(m.at),
      })),
    };
  } finally {
    if (db.isOpen) db.close();
  }
}

async function runTx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    throw err;
  } finally {
    client.release();
  }
}

async function syncSequence(client, table, column = 'id') {
  await client.query(
    `SELECT setval(
       pg_get_serial_sequence($1, $2),
       COALESCE((SELECT MAX(${column}) FROM ${table}), 1),
       (SELECT COUNT(*) > 0 FROM ${table})
     )`,
    [table, column],
  );
}

/**
 * Migrates SQLite game and/or account databases into PostgreSQL idempotently.
 * In `dryRun` mode, reads and validates all SQLite rows without connecting to PostgreSQL.
 */
export async function migrateSqliteToPostgres(options = {}) {
  const {
    gameDbPath = DEFAULT_GAME_DB,
    accountsDbPath = DEFAULT_ACCOUNTS_DB,
    databaseUrl = null,
    accountsDatabaseUrl = databaseUrl,
    gamePool: injectedGamePool = null,
    accountsPool: injectedAccountsPool = null,
    skipGame = false,
    skipAccounts = false,
    dryRun = false,
    log = console.log,
  } = options;

  const summary = {
    dryRun,
    game: { skipped: true, players: 0, accountCharacters: 0, worldState: 0, chatMessages: 0 },
    accounts: { skipped: true, accounts: 0, sessions: 0, moderationLog: 0 },
  };

  let gameData = null;
  if (!skipGame) {
    if (existsSync(gameDbPath)) {
      gameData = readGameSqlite(gameDbPath);
      summary.game = {
        skipped: false,
        players: gameData.players.length,
        accountCharacters: gameData.accountCharacters.length,
        worldState: gameData.worldState.length,
        chatMessages: gameData.chatMessages.length,
      };
    } else {
      log(`[migrate] game SQLite DB not found at ${gameDbPath}; skipping`);
    }
  }

  let accountsData = null;
  if (!skipAccounts) {
    if (existsSync(accountsDbPath)) {
      accountsData = readAccountsSqlite(accountsDbPath);
      summary.accounts = {
        skipped: false,
        accounts: accountsData.accounts.length,
        sessions: accountsData.sessions.length,
        moderationLog: accountsData.moderationLog.length,
      };
    } else {
      log(`[migrate] accounts SQLite DB not found at ${accountsDbPath}; skipping`);
    }
  }

  if (dryRun) {
    log(
      `[migrate] dry-run complete: game(players=${summary.game.players}, account_characters=${summary.game.accountCharacters}, world_state=${summary.game.worldState}) accounts(accounts=${summary.accounts.accounts}, sessions=${summary.accounts.sessions}, moderation_log=${summary.accounts.moderationLog})`,
    );
    return summary;
  }

  if (!gameData && !accountsData) {
    log('[migrate] nothing to migrate');
    return summary;
  }

  const schemaSql = loadSchemaSql();
  const sameTarget =
    !injectedGamePool &&
    !injectedAccountsPool &&
    databaseUrl &&
    accountsDatabaseUrl &&
    databaseUrl === accountsDatabaseUrl;

  let gamePool = injectedGamePool;
  let accountsPool = injectedAccountsPool;
  let ownsGamePool = false;
  let ownsAccountsPool = false;

  try {
    if (gameData && !gamePool) {
      if (!databaseUrl) throw new Error('DATABASE_URL (or --database-url) is required unless --dry-run is set');
      gamePool = await createPgPool(databaseUrl);
      ownsGamePool = true;
    }
    if (accountsData && !accountsPool) {
      if (sameTarget && gamePool) {
        accountsPool = gamePool;
      } else {
        const url = accountsDatabaseUrl || databaseUrl;
        if (!url) throw new Error('ACCOUNTS_DATABASE_URL or DATABASE_URL is required unless --dry-run is set');
        accountsPool = await createPgPool(url);
        ownsAccountsPool = true;
      }
    }

    if (gameData) {
      await runTx(gamePool, async (client) => {
        await client.query(schemaSql);
        for (const p of gameData.players) {
          await client.query(
            `INSERT INTO players (id, token_hash, name, x, z, yaw, created_at, last_seen, rpg)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
             ON CONFLICT (id) DO UPDATE SET
               token_hash = EXCLUDED.token_hash,
               name = EXCLUDED.name,
               x = EXCLUDED.x,
               z = EXCLUDED.z,
               yaw = EXCLUDED.yaw,
               created_at = EXCLUDED.created_at,
               last_seen = EXCLUDED.last_seen,
               rpg = EXCLUDED.rpg`,
            [p.id, p.token_hash, p.name, p.x, p.z, p.yaw, p.created_at, p.last_seen, p.rpg],
          );
        }
        for (const a of gameData.accountCharacters) {
          await client.query(
            `INSERT INTO account_characters (account_id, player_id, username, linked_at)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (account_id) DO UPDATE SET
               player_id = EXCLUDED.player_id,
               username = EXCLUDED.username,
               linked_at = EXCLUDED.linked_at`,
            [a.account_id, a.player_id, a.username, a.linked_at],
          );
        }
        for (const w of gameData.worldState) {
          await client.query(
            `INSERT INTO world_state (key, value, updated_at)
             VALUES ($1, $2::jsonb, $3)
             ON CONFLICT (key) DO UPDATE SET
               value = EXCLUDED.value,
               updated_at = EXCLUDED.updated_at`,
            [w.key, w.value, w.updated_at],
          );
        }
        for (const m of gameData.chatMessages) {
          await client.query(
            `INSERT INTO chat_messages (id, created_at, channel, location, sender_player_id, sender_account_id,
                                        sender_name, target_player_id, target_name, group_id, body, recipient_ids)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (id) DO NOTHING`,
            [m.id, m.created_at, m.channel, m.location, m.sender_player_id, m.sender_account_id,
              m.sender_name, m.target_player_id, m.target_name, m.group_id, m.body, m.recipient_ids ?? null],
          );
        }
        await syncSequence(client, 'players', 'id');
        if (gameData.chatMessages.length) await syncSequence(client, 'chat_messages', 'id');
      });
      log(
        `[migrate] game migrated: ${summary.game.players} players, ${summary.game.accountCharacters} account_characters, ${summary.game.worldState} world_state rows, ${summary.game.chatMessages} chat_messages`,
      );
    }

    if (accountsData) {
      await runTx(accountsPool, async (client) => {
        await client.query(schemaSql);
        for (const a of accountsData.accounts) {
          await client.query(
            `INSERT INTO accounts (
               id, username, username_key, password_hash, created_at,
               last_login_at, muted_until, mute_reason, banned_at, ban_reason, recovery_hash
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (id) DO UPDATE SET
               username = EXCLUDED.username,
               username_key = EXCLUDED.username_key,
               password_hash = EXCLUDED.password_hash,
               created_at = EXCLUDED.created_at,
               last_login_at = EXCLUDED.last_login_at,
               muted_until = EXCLUDED.muted_until,
               mute_reason = EXCLUDED.mute_reason,
               banned_at = EXCLUDED.banned_at,
               ban_reason = EXCLUDED.ban_reason,
               recovery_hash = EXCLUDED.recovery_hash`,
            [
              a.id,
              a.username,
              a.username_key,
              a.password_hash,
              a.created_at,
              a.last_login_at,
              a.muted_until,
              a.mute_reason,
              a.banned_at,
              a.ban_reason,
              a.recovery_hash,
            ],
          );
        }
        for (const s of accountsData.sessions) {
          await client.query(
            `INSERT INTO sessions (id, token_hash, account_id, created_at, last_seen_at, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (id) DO UPDATE SET
               token_hash = EXCLUDED.token_hash,
               account_id = EXCLUDED.account_id,
               created_at = EXCLUDED.created_at,
               last_seen_at = EXCLUDED.last_seen_at,
               expires_at = EXCLUDED.expires_at`,
            [s.id, s.token_hash, s.account_id, s.created_at, s.last_seen_at, s.expires_at],
          );
        }
        for (const m of accountsData.moderationLog) {
          await client.query(
            `INSERT INTO moderation_log (id, account_id, action, reason, until, actor, at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET
               account_id = EXCLUDED.account_id,
               action = EXCLUDED.action,
               reason = EXCLUDED.reason,
               until = EXCLUDED.until,
               actor = EXCLUDED.actor,
               at = EXCLUDED.at`,
            [m.id, m.account_id, m.action, m.reason, m.until, m.actor, m.at],
          );
        }
        await syncSequence(client, 'accounts', 'id');
        await syncSequence(client, 'sessions', 'id');
        await syncSequence(client, 'moderation_log', 'id');
      });
      log(
        `[migrate] accounts migrated: ${summary.accounts.accounts} accounts, ${summary.accounts.sessions} sessions, ${summary.accounts.moderationLog} moderation_log rows`,
      );
    }

    return summary;
  } finally {
    if (ownsAccountsPool && accountsPool && accountsPool !== gamePool) {
      await accountsPool.end().catch(() => {});
    }
    if (ownsGamePool && gamePool) {
      await gamePool.end().catch(() => {});
    }
  }
}

export function parseArgs(argv, env = process.env) {
  const opts = {
    gameDbPath: env.DB_PATH ? resolve(env.DB_PATH) : DEFAULT_GAME_DB,
    accountsDbPath: env.ACCOUNTS_DB_PATH ? resolve(env.ACCOUNTS_DB_PATH) : DEFAULT_ACCOUNTS_DB,
    databaseUrl: env.DATABASE_URL || null,
    accountsDatabaseUrl: env.ACCOUNTS_DATABASE_URL || null,
    skipGame: false,
    skipAccounts: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--game-db':
        opts.gameDbPath = resolve(argv[++i] ?? '');
        break;
      case '--accounts-db':
        opts.accountsDbPath = resolve(argv[++i] ?? '');
        break;
      case '--database-url':
        opts.databaseUrl = argv[++i] ?? null;
        break;
      case '--accounts-database-url':
        opts.accountsDatabaseUrl = argv[++i] ?? null;
        break;
      case '--skip-game':
        opts.skipGame = true;
        break;
      case '--skip-accounts':
        opts.skipAccounts = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!opts.accountsDatabaseUrl) opts.accountsDatabaseUrl = opts.databaseUrl;
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(USAGE);
      process.exit(0);
    }
    await migrateSqliteToPostgres(opts);
  } catch (err) {
    console.error(`[migrate] error: ${err.message}`);
    process.exit(1);
  }
}
