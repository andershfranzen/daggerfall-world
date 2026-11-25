// Test support for multi-system RPG integration (test/rpg-world-integration.test.mjs).
//
// Two layers, reported separately in docs/gameplay-coverage.md:
//
//   FIXTURE  createFixtureWorld(): the real RPG runtime (server/rpg/runtime.js), every real feature
//            module that exports install(ctx), and the real SQLite store (server/db.js) on a temp
//            file. Sockets are replaced by in-process clients whose messages go through a JSON round
//            trip. The join/leave/save glue mirrors docs/gameplay-protocol.md; it is test code, so a
//            pass here proves feature + runtime + persistence behaviour, not the WebSocket wiring.
//
//   LIVE     startLiveWorld() + LiveClient: the real HTTP/WebSocket server (server/game.js) with the
//            real account service (server/accounts.js), two registered accounts, two sockets.
//
// No wall-clock sleeps: waits resolve on received messages; timeouts only bound a failure.
// Randomness is made reproducible with withSeededRandom(); time with the fixture's manual clock.
import { readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RPG_DIR = join(ROOT, 'server', 'rpg');

/** RPG_INTEGRATION_STRICT=1 turns every reported gap into a hard failure (final integration). */
export const STRICT = /^(1|true|yes)$/i.test(process.env.RPG_INTEGRATION_STRICT ?? '');

/**
 * Per-case gap marker for node:test's `todo` option. A todo case still RUNS its body; a failure is
 * reported as "# TODO <reason>" instead of failing the suite. Returns false when nothing is missing.
 */
export function gap(missing) {
  const list = missing.filter(Boolean);
  if (!list.length || STRICT) return false;
  return `GAP: ${list.join('; ')}`;
}

export function tempDir(prefix = 'dfw-rpg-int-', base = tmpdir()) {
  const dir = mkdtempSync(join(base, prefix));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Choose the shared game date for a route through staffed shops or town streets. */
export function withWorldClock(features, clock) {
  return features.map(f => f.name === 'atmosphere' ? { ...f, install: ctx => f.install(ctx, clock) } : f);
}

// ---- deterministic randomness -------------------------------------------------------------------

/** mulberry32: small, fast, reproducible PRNG in [0, 1). */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs fn (sync or async) with Math.random replaced by a seeded PRNG; always restores it. */
export async function withSeededRandom(seed, fn) {
  const original = Math.random;
  Math.random = seededRandom(seed);
  try {
    return await fn();
  } finally {
    Math.random = original;
  }
}

// ---- feature discovery ---------------------------------------------------------------------------

function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else if (ent.isFile() && ent.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

/**
 * Loads the RPG features the way production will: the server/rpg/features.js manifest when it is
 * non-empty, otherwise every server/rpg/**.js module exporting install(ctx). Inventory is installed
 * first because other features consume its services. Import errors are returned, never thrown.
 */
export async function discoverFeatures() {
  const errors = [];
  let manifest;
  try {
    manifest = await import(pathToFileURL(join(RPG_DIR, 'features.js')).href);
  } catch (err) {
    // A feature (or something it imports) is broken: report it as a failing case, not a crash.
    return { source: 'manifest-import-failed', features: [], errors: [{ module: 'features.js', error: err.message }] };
  }
  if (Array.isArray(manifest.features) && manifest.features.length) {
    return { source: 'manifest', features: manifest.features.map((f, i) => ({ name: f.name || `manifest#${i}`, install: f.install ?? f })), errors };
  }
  const features = [];
  for (const file of walk(RPG_DIR)) {
    const rel = relative(RPG_DIR, file);
    if (rel === 'runtime.js' || rel === 'features.js') continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      if (typeof mod.install === 'function') features.push({ name: rel.replace(/\.js$/, ''), install: mod.install });
    } catch (err) {
      errors.push({ module: rel, error: err.message });
    }
  }
  features.sort((a, b) => (a.name === 'inventory' ? -1 : b.name === 'inventory' ? 1 : a.name.localeCompare(b.name)));
  return { source: 'discovered', features, errors };
}

// ---- FIXTURE layer: real runtime + real features + real SQLite -----------------------------------

const wire = (msg) => JSON.parse(JSON.stringify(msg)); // what a socket would deliver

class FixtureClient {
  constructor(world, player) {
    this.world = world;
    this.player = player;
    this.messages = [];
  }
  receive(msg) {
    this.messages.push(wire(msg));
  }
  get id() {
    return this.player.id;
  }
  /** Latest private RPG snapshot (what the browser would render). */
  get state() {
    for (let i = this.messages.length - 1; i >= 0; i--) if (this.messages[i].type === 'rpg') return this.messages[i];
    return null;
  }
  get character() {
    return this.state?.character ?? null;
  }
  events(kind) {
    return this.messages.filter((m) => m.type === 'gameEvent' && (!kind || m.event.kind === kind)).map((m) => m.event);
  }
  mark() {
    return this.messages.length;
  }
  since(mark, type) {
    return this.messages.slice(mark).filter((m) => !type || m.type === type);
  }
  peer(id) {
    return this.state?.peers.find((p) => p.id === id) ?? null;
  }
  entity(id) {
    return this.state?.entities.find((e) => e.id === id) ?? null;
  }
  item(predicate) {
    return this.character?.inventory?.find(typeof predicate === 'function' ? predicate : (i) => i.id === predicate) ?? null;
  }
  /** Sends `{type:'action'}` through the runtime. Returns {ok, error}. */
  act(verb, args = {}) {
    return this.world.runtime.act(this.player, verb, wire(args));
  }
  /** Fails with the server's message if the action is rejected. */
  must(verb, args = {}) {
    const r = this.act(verb, args);
    if (!r.ok) throw new Error(`${verb} rejected: ${r.error}`);
    return r;
  }
  moveTo(x, z) {
    this.player.x = x;
    this.player.z = z;
    this.player.dirty = true;
  }
  leave() {
    this.world.leave(this);
  }
}

/**
 * @param {object} o
 * @param {string} o.dbPath
 * @param {Array}  o.features  [{name, install}]
 */
export async function createFixtureWorld({ dbPath, features, seed = 20261124, dataPath = null, config = {} }) {
  const { openStore } = await import(pathToFileURL(join(ROOT, 'server', 'db.js')).href);
  const { createRpgRuntime } = await import(pathToFileURL(join(RPG_DIR, 'runtime.js')).href);
  let clock = 1_000_000;
  const world = {
    store: null,
    runtime: null,
    players: null,
    clients: new Map(),
    installErrors: [],
    saves: 0,
    get ctx() {
      return this.runtime.ctx;
    },
    clock: {
      now: () => clock,
      advance(ms) {
        clock += ms;
      },
    },
    boot() {
      this.store = openStore(dbPath);
      this.players = new Map();
      this.clients = new Map();
      this.apis = {}; // feature name -> value returned by install(ctx) (e.g. combat.spawnMonster)
      this.verbs = new Map(); // verb -> feature name
      this.eventNames = new Set();
      const installable = [];
      let current = null;
      // Records which feature registered each verb/event (diagnostics and gap reporting).
      installable.push({
        name: 'test-registry-probe',
        install: (ctx) => {
          ctx.random = seededRandom(seed ^ 0x5eed); // character rolls read ctx.random
          const onAction = ctx.onAction.bind(ctx);
          const on = ctx.on.bind(ctx);
          ctx.onAction = (verb, fn) => {
            onAction(verb, fn);
            this.verbs.set(verb, current);
          };
          ctx.on = (name, fn) => {
            this.eventNames.add(name);
            on(name, fn);
          };
        },
      });
      for (const f of features) {
        installable.push({
          name: f.name,
          install: (ctx) => {
            current = f.name;
            try {
              // A night visitor consumes combat rolls. Use the fixture clock for both
              // world time and movement so the fight is identical at any real hour.
              this.apis[f.name] = f.name === 'atmosphere'
                ? f.install(ctx, { epochMs: 0, wallNow: () => clock - 1_000_000 })
                : f.install(ctx);
            } catch (err) {
              this.installErrors.push({ feature: f.name, error: err.message });
            }
          },
        });
      }
      const realRandom = Math.random;
      Math.random = seededRandom(seed);
      try {
      this.runtime = createRpgRuntime({
        players: this.players,
        features: installable,
        dataPath,
        config: { ...(dataPath ? { arena2Dir: dataPath } : {}), ...config },
        worldStore: { load: (prefix) => this.store.loadWorld(prefix) },
        save: (list, rows) => {
          this.saves++;
          this.writeRows(list, rows);
        },
        send: (p, msg) => this.clients.get(p.id)?.receive(msg),
        now: () => clock,
        log: { error() {}, warn() {}, info() {}, log() {} },
      });
      } finally {
        Math.random = realRandom;
      }
    },
    /** Account-backed character (store.createForAccount), joined like a socket session. */
    connect(accountId, username) {
      let row = this.store.findByAccount(accountId);
      if (!row) row = { ...this.store.createForAccount(accountId, username), username };
      if (this.players.has(row.id)) throw new Error(`${username} is already connected`);
      const p = { id: row.id, name: row.name, x: row.x, z: row.z, yaw: row.yaw, moving: false, rpg: row.rpg, dirty: false };
      const client = new FixtureClient(this, p);
      this.clients.set(p.id, client);
      this.players.set(p.id, p);
      this.runtime.join(p);
      this.store.saveCharacters([p]);
      p.dirty = false;
      this.runtime.sync([...this.players.values()]);
      return client;
    },
    leave(client) {
      const p = client.player;
      if (this.players.get(p.id) !== p) return;
      const affected = this.runtime.leave(p);
      this.players.delete(p.id);
      this.store.saveCharacters(affected);
      this.clients.delete(p.id);
      this.runtime.sync([...this.players.values()]);
    },
    writeRows(players, rows) {
      this.store.saveCharacters(players, rows.map(([key, value]) => [key, typeof value === 'function' ? value() : value]));
    },
    flushPending() {
      const dirty = [...this.players.values()].filter((p) => p.dirty);
      const rows = this.runtime.takePendingWorld();
      if (!dirty.length && !rows.length) return;
      try {
        this.writeRows(dirty, rows);
      } catch (err) {
        this.runtime.restorePendingWorld(rows);
        throw err;
      }
      for (const p of dirty) p.dirty = false;
    },
    tick(ms) {
      clock += ms;
      this.runtime.tick(ms / 1000, clock);
      this.flushPending();
      this.runtime.sync([...this.players.values()]);
    },
    /** Graceful shutdown + cold start on the same database file: fresh runtime and feature state. */
    restart() {
      for (const c of [...this.clients.values()]) this.leave(c);
      this.flushPending();
      this.store.close();
      this.boot();
    },
    close() {
      this.store?.close();
    },
  };
  world.boot();
  return world;
}

/** Reads a character's persisted RPG JSON through an independent SQLite connection. */
export function readPersisted(dbPath, playerId) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT id, name, x, z, yaw, rpg FROM players WHERE id = ?').get(playerId);
    return row ? { ...row, rpg: JSON.parse(row.rpg) } : null;
  } finally {
    db.close();
  }
}

// ---- LIVE layer: real HTTP + WebSocket server with real accounts --------------------------------

export const FAST_SCRYPT = Object.freeze({ N: 2 ** 10, r: 8, p: 1, keyLen: 32 });

/** Starts server/game.js + server/accounts.js on an ephemeral loopback port with temp DBs. */
export async function startLiveWorld({ dir, port = 0, features, arena2Dir = null }) {
  const { createGameServer } = await import(pathToFileURL(join(ROOT, 'server', 'game.js')).href);
  const { createAccounts } = await import(pathToFileURL(join(ROOT, 'server', 'accounts.js')).href);
  const accounts = createAccounts({
    dbPath: join(dir, 'accounts.db'),
    scrypt: FAST_SCRYPT,
    secureCookies: false,
    moderationPollMs: 60_000,
  });
  const server = createGameServer({
    accounts,
    allowGuests: false,
    host: '127.0.0.1',
    port,
    dbPath: join(dir, 'world.db'),
    clientDir: join(dir, 'client'),
    siteDir: join(dir, 'site'),
    ...(features ? { features } : {}),
    ...(arena2Dir ? { arena2Dir } : {}),
  });
  let addr;
  try {
    addr = await server.start();
  } catch (err) {
    accounts.close();
    throw err;
  }
  const base = `http://127.0.0.1:${addr.port}`;
  return {
    server,
    accounts,
    port: addr.port,
    base,
    dbPath: join(dir, 'world.db'),
    async close() {
      await server.close();
      accounts.close();
    },
  };
}

/** Registers (or logs in) an account through the game server's own HTTP origin. */
export async function accountSession(base, username, password = 'integration-pass-phrase', path = '/api/register') {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  const setCookie = res.headers.get('set-cookie');
  const cookie = setCookie ? setCookie.split(';')[0] : null;
  return { status: res.status, json, cookie, user: json?.user ?? null };
}

export class LiveClient {
  constructor(port, { cookie, origin } = {}) {
    this.messages = [];
    this.cursor = 0;
    this.waiters = new Set();
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (origin) headers.Origin = origin;
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    this.closed = new Promise((resolve) => this.ws.on('close', (code, reason) => resolve({ code, reason: String(reason) })));
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', (d) => {
      let msg;
      try {
        msg = JSON.parse(d);
      } catch {
        return;
      }
      this.messages.push(msg);
      for (const w of [...this.waiters]) w();
    });
    this.ws.on('close', () => {
      for (const w of [...this.waiters]) w();
    });
  }
  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }
  get state() {
    for (let i = this.messages.length - 1; i >= 0; i--) if (this.messages[i].type === 'rpg') return this.messages[i];
    return null;
  }
  /**
   * Resolves with the next message after the cursor matching `pred` (advancing the cursor past it).
   * Event-driven; `timeoutMs` only bounds a failure and names what was awaited.
   */
  next(pred, what = 'message', timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        for (let i = this.cursor; i < this.messages.length; i++) {
          if (pred(this.messages[i])) {
            this.cursor = i + 1;
            done();
            return resolve(this.messages[i]);
          }
        }
        if (this.ws.readyState >= WebSocket.CLOSING) {
          done();
          const last = this.messages.filter((m) => m.type === 'error').at(-1);
          reject(new Error(`socket closed while waiting for ${what}${last ? ` (server said: ${last.message})` : ''}`));
        }
      };
      const timer = setTimeout(() => {
        done();
        const seen = [...new Set(this.messages.slice(this.cursor).map((m) => m.type))].join(', ') || 'nothing';
        reject(new Error(`timed out waiting for ${what}; received: ${seen}`));
      }, timeoutMs);
      timer.unref?.();
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      this.waiters.add(check);
      check();
    });
  }
  /**
   * Sends an action and resolves with its outcome: a rejection (`error`, `actionResult{ok:false}`,
   * or gameEvent kind `error`) or the next `rpg` snapshot / `actionResult{ok:true}`.
   */
  async act(verb, args = {}) {
    const seq = (this.seq = (this.seq ?? 0) + 1);
    const from = this.messages.length;
    this.send({ type: 'action', seq, verb, args });
    const saved = this.cursor;
    this.cursor = from;
    const msg = await this.next((m) => m.type === 'actionResult' && m.seq === seq, `actionResult #${seq} for ${verb}`);
    this.cursor = saved;
    return { ok: msg.ok === true, error: msg.error, msg };
  }
  /** Latest rpg snapshot satisfying pred (already received or next to arrive). */
  async stateWhere(pred, what = 'rpg snapshot') {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.type === 'rpg') {
        if (pred(m)) return m;
        break;
      }
    }
    this.cursor = this.messages.length;
    return this.next((m) => m.type === 'rpg' && pred(m), what);
  }
  async close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close();
    await this.closed;
  }
}

// ---- operator game data (ASSET layer) -------------------------------------------------------

/** The operator's local ARENA2 copy (gitignored gamedata/), or null when it is absent. */
export function localArena2() {
  for (const rel of ['gamedata/DaggerfallGameFiles/arena2', 'gamedata/arena2', 'gamedata/ARENA2']) {
    const dir = join(ROOT, rel);
    if (existsSync(join(dir, 'A0C00Y10.QBN'))) return dir;
  }
  return null;
}

/**
 * Production feature list with the quest feature installed against a catalogue of the named
 * original quests only (read from the operator's ARENA2 by server/rpg/quests/catalog.js). The
 * catalogue is the one quest-owner-supported way to make the offered quest deterministic.
 */
export async function featuresWithQuestCatalog(features, dataPath, names) {
  const { loadCatalog } = await import(pathToFileURL(join(RPG_DIR, 'quests', 'catalog.js')).href);
  const quests = await import(pathToFileURL(join(RPG_DIR, 'quests.js')).href);
  const full = loadCatalog({ dataPath });
  const only = new Map();
  for (const n of names) {
    const e = full.quests.get(n);
    if (!e) throw new Error(`quest ${n} is not in ${dataPath}`);
    only.set(n, e);
  }
  const catalog = { ...full, quests: only };
  return features.map((f) => (f.name === 'quests' ? { name: 'quests', install: (ctx) => quests.install(ctx, { catalog }) } : f));
}
