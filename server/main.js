#!/usr/bin/env node
// Entry point: `npm start`. Configuration via environment variables (see server/README.md).
import { statSync, realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createGameServer, DEFAULTS } from './game.js';
import { createAccounts, ACCOUNT_DEFAULTS } from './accounts.js';
import { openPostgresChatLog } from './chat-log.js';
import { openPostgresHiscoresStore } from './hiscores/postgres-store.js';
import { isPostgresUrl, openPostgresGameStore, createBufferedGameStore } from './storage/index.js';
import { CHAT_LIMITS } from './rpg/social/chat.js';

function redactDbUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.username) u.username = '***';
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return String(raw).replace(/\/\/[^/@]+@/, '//***@');
  }
}

// Single-world capacity default: high practical cap instead of a 32-player instance cap.
// Operators can set MAX_PLAYERS=0 for uncapped, or any positive integer up to 1,000,000.
const DEFAULT_MAX_PLAYERS = 2000;
const MAX_PLAYERS_UPPER_BOUND = 1_000_000;

function maxPlayersEnv(name, fallback) {
  const n = intEnv(name, fallback, 0, MAX_PLAYERS_UPPER_BOUND);
  return n === 0 ? Number.POSITIVE_INFINITY : n;
}

function intEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  return n;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  console.error(`${name} must be 1/0, true/false, yes/no or on/off, got ${JSON.stringify(raw)}`);
  process.exit(2);
}

// Operator-supplied game data (the ARENA2 folder), read-only and outside every public root.
function arena2Dir() {
  const raw = process.env.ARENA2_DIR;
  if (!raw) return null;
  let dir;
  try {
    dir = realpathSync(resolve(raw));
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
  } catch (err) {
    console.error(`ARENA2_DIR=${JSON.stringify(raw)} is not a readable directory (${err.code ?? err.message})`);
    process.exit(2);
  }
  for (const pub of [DEFAULTS.clientDir, process.env.SITE_DIR || DEFAULTS.siteDir]) {
    let root;
    try {
      root = realpathSync(pub);
    } catch {
      continue;
    }
    if (dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep)) {
      console.error(`ARENA2_DIR must not be inside a publicly served directory (${root})`);
      process.exit(2);
    }
  }
  return dir;
}

const dev = process.argv.includes('--dev');

// Accounts are the normal way in. Guests exist only as an explicit development/test escape hatch.
const allowGuests = boolEnv('ALLOW_GUESTS', false);
if (allowGuests && !dev) {
  console.error('ALLOW_GUESTS=1 is only accepted together with --dev (npm run dev)');
  process.exit(2);
}
const secureCookies = boolEnv('COOKIE_SECURE', true);
if (!secureCookies && !dev) {
  console.error('COOKIE_SECURE=0 is only accepted together with --dev (npm run dev)');
  process.exit(2);
}
const trustProxy = boolEnv('TRUST_PROXY', false);
const requireHttps = boolEnv('REQUIRE_HTTPS', false);
const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : null;

const databaseUrl = process.env.DATABASE_URL?.trim() || '';
const accountsUrl = process.env.ACCOUNTS_DATABASE_URL?.trim() || databaseUrl;
const usingPostgresGame = isPostgresUrl(databaseUrl);
const usingPostgresAccounts = isPostgresUrl(accountsUrl);

let accounts;
if (usingPostgresAccounts) {
  const { createPostgresAccounts } = await import('./accounts.js');
  if (typeof createPostgresAccounts !== 'function') {
    console.error('ACCOUNTS_DATABASE_URL / DATABASE_URL requires createPostgresAccounts in server/accounts.js');
    process.exit(1);
  }
  accounts = await createPostgresAccounts({
    connectionString: accountsUrl,
    trustProxy,
    requireHttps,
    publicOrigin,
    secureCookies,
  });
} else {
  accounts = createAccounts({
    dbPath: process.env.ACCOUNTS_DB_PATH ? resolve(process.env.ACCOUNTS_DB_PATH) : ACCOUNT_DEFAULTS.dbPath,
    trustProxy,
    requireHttps,
    publicOrigin,
    secureCookies,
  });
}

let gameStore = null;
let chatLog = null;
let hiscoresStore = null;
if (usingPostgresGame) {
  try {
    const pgGame = await openPostgresGameStore({ connectionString: databaseUrl });
    gameStore = createBufferedGameStore(pgGame);
    await gameStore.preloadWorld();
    chatLog = await openPostgresChatLog(pgGame.pool);
    hiscoresStore = await openPostgresHiscoresStore(pgGame.pool, { applySchema: false });
  } catch (err) {
    console.error(`failed to initialize PostgreSQL game store: ${err.message}`);
    await Promise.resolve(accounts.close()).catch(() => {});
    process.exit(1);
  }
}

const server = createGameServer({
  accounts,
  ...(gameStore ? { store: gameStore } : {}),
  ...(chatLog ? { chatLog } : {}),
  ...(hiscoresStore ? { hiscoresStore } : {}),
  allowGuests,
  arena2Dir: arena2Dir(),
  wodPath: process.env.WOD_PATH || null,
  // Loopback-only dev convenience: /play.html reads the installed ARENA2 without a folder pick
  // (server/local-assets.js). Self-disables behind a proxy, with PUBLIC_ORIGIN/REQUIRE_HTTPS,
  // NODE_ENV=production, LOCAL_ASSETS=0, or a non-loopback HOST.
  localAssets: {
    trustProxy: accounts.config.trustProxy,
    publicOrigin: accounts.config.publicOrigin,
    requireHttps: accounts.config.requireHttps,
    dev,
  },
  host: process.env.HOST || DEFAULTS.host,
  port: intEnv('PORT', DEFAULTS.port, 0, 65535),
  dbPath: process.env.DB_PATH ? resolve(process.env.DB_PATH) : DEFAULTS.dbPath,
  maxPlayers: maxPlayersEnv('MAX_PLAYERS', DEFAULT_MAX_PLAYERS),
  chatRatePerSec: intEnv('CHAT_RATE_PER_SEC', CHAT_LIMITS.local.ratePerSec, 1, 100),
  chatBurst: intEnv('CHAT_BURST', CHAT_LIMITS.local.burst, 1, 500),
  worldHalfExtent: intEnv('WORLD_HALF_EXTENT', DEFAULTS.worldHalfExtent, 1, 100_000),
  siteDir: process.env.SITE_DIR ? resolve(process.env.SITE_DIR) : DEFAULTS.siteDir,
});

try {
  const addr = await server.start();
  const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  console.log(`daggerfallworld server listening on http://${host}:${addr.port}/ (WebSocket /ws)`);
  console.log(`database: ${usingPostgresGame ? redactDbUrl(databaseUrl) : server.config.dbPath}`);
  console.log(`accounts: ${usingPostgresAccounts ? redactDbUrl(accountsUrl) : accounts.config.dbPath}${allowGuests ? ' (guest entry enabled for development)' : ''}`);
  if (server.config.arena2Dir) console.log(`game data: ${server.config.arena2Dir} (read-only)`);
  if (server.localAssets?.enabled) console.log(`local game files: ${server.localAssets.dir} offered to /play.html on this loopback origin only (${server.localAssets.reason}; LOCAL_ASSETS=0 to disable)`);
  console.log(`game: http://${host}:${addr.port}/play.html`);
  if (!['127.0.0.1', '::1', 'localhost'].includes(server.config.host) && !accounts.config.trustProxy) {
    console.warn('warning: bound to a non-loopback address without TRUST_PROXY; serve it behind a TLS reverse proxy (docs/public-hosting.md)');
  }
} catch (err) {
  console.error(`failed to start: ${err.message}`);
  await server.close().catch(() => {});
  await Promise.resolve(accounts.close()).catch(() => {});
  process.exit(1);
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\n${sig} received, saving and shutting down...`);
    await server.close();
    await accounts.close(); // after the game server: live sessions may still query mutes while closing
    process.exit(0);
  });
}
