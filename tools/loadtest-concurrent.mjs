#!/usr/bin/env node
// Live Concurrent-Player Stress & Capacity Benchmark Suite for Daggerfall World.
//
// Modes:
//   --local (default) / --spawn-local : spawns an in-process authoritative game server on port 0,
//     measuring server-side event-loop delay, CPU %, heap/RSS, tick interval, and WS bandwidth.
//   --url <ws-or-http-url>            : connects real WebSocket bots to a live remote server
//     (guest join via --guest, or disposable accounts via --register --prefix loadtest_ --cleanup).
//
// Exports `runLoadTest(options)` and `parseLoadTestArgs(argv)` for programmatic & test use.

import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { createGameServer, CLOSE } from '../server/game.js';

export const DEFAULT_OPTIONS = Object.freeze({
  mode: 'local', // 'local' | 'remote'
  url: null,
  guest: true,
  register: false,
  prefix: 'loadtest_',
  cleanup: false,
  stages: [25, 50, 100, 200, 400],
  durationMs: 5000,
  inputHz: 10,
  chatIntervalMs: 15000,
  spreadM: 80,
  clustered: false,
  delta: true,
  json: false,
  quiet: false,
  maxPlayers: 2000,
  joinTimeoutMs: 10000,
  connectConcurrency: 25,
  pingIntervalMs: 1000,
  pingSampleSize: 50,
  features: undefined, // undefined => PRODUCTION_FEATURES in createGameServer
  help: false,
});

const CHAT_LINES = [
  'Hail, traveler! Any news from Daggerfall?',
  'Looking for a party for Privateers Hold.',
  'The market square is bustling today.',
  'Watch your step near the north gate.',
  'Anyone selling a steel claymore?',
  'Rest up at the tavern before heading out.',
];

// ---------------------------------------------------------------------------
// Argument parsing & URL normalization
// ---------------------------------------------------------------------------

function parsePositiveInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} requires a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseNonNegativeInt(raw, flag) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${flag} requires a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseNumber(raw, flag, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${flag} requires a finite number in [${min}, ${max}], got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function parseLoadTestArgs(argv = process.argv.slice(2)) {
  const opts = { ...DEFAULT_OPTIONS, stages: [...DEFAULT_OPTIONS.stages] };
  let explicitSpread = false;

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const eq = raw.indexOf('=');
    const flag = eq >= 0 ? raw.slice(0, eq) : raw;
    const inlineVal = eq >= 0 ? raw.slice(eq + 1) : undefined;
    const nextVal = () => {
      if (inlineVal !== undefined) return inlineVal;
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${flag}`);
      return argv[++i];
    };

    switch (flag) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--local':
      case '--spawn-local':
        opts.mode = 'local';
        opts.url = null;
        break;
      case '--url': {
        const val = nextVal();
        if (!val) throw new Error('--url requires a non-empty URL');
        opts.mode = 'remote';
        opts.url = val;
        break;
      }
      case '--guest':
        opts.guest = true;
        opts.register = false;
        break;
      case '--register':
        opts.register = true;
        opts.guest = false;
        break;
      case '--prefix':
        opts.prefix = nextVal();
        if (!opts.prefix) throw new Error('--prefix requires a non-empty string');
        break;
      case '--cleanup':
        opts.cleanup = true;
        break;
      case '--stages': {
        const val = nextVal();
        const parts = val.split(',').map((s) => s.trim()).filter(Boolean);
        if (!parts.length) throw new Error('--stages requires at least one positive integer');
        opts.stages = parts.map((p) => parsePositiveInt(p, '--stages'));
        break;
      }
      case '--duration-ms':
        opts.durationMs = parsePositiveInt(nextVal(), '--duration-ms');
        break;
      case '--input-hz':
        opts.inputHz = parseNumber(nextVal(), '--input-hz', { min: 0, max: 35 });
        break;
      case '--chat-interval-ms':
        opts.chatIntervalMs = parseNonNegativeInt(nextVal(), '--chat-interval-ms');
        break;
      case '--spread-m':
        opts.spreadM = parseNumber(nextVal(), '--spread-m', { min: 0.5, max: 512 });
        explicitSpread = true;
        break;
      case '--clustered':
        opts.clustered = true;
        if (!explicitSpread) opts.spreadM = 10;
        break;
      case '--no-delta':
        opts.delta = false;
        break;
      case '--delta':
        opts.delta = true;
        break;
      case '--max-players':
        opts.maxPlayers = parseNonNegativeInt(nextVal(), '--max-players');
        break;
      case '--join-timeout-ms':
        opts.joinTimeoutMs = parsePositiveInt(nextVal(), '--join-timeout-ms');
        break;
      case '--connect-concurrency':
        opts.connectConcurrency = parsePositiveInt(nextVal(), '--connect-concurrency');
        break;
      case '--json':
        opts.json = true;
        break;
      case '--quiet':
        opts.quiet = true;
        break;
      default:
        throw new Error(`Unknown argument: ${raw}`);
    }
  }

  if (opts.clustered) {
    opts.spreadM = 10;
  }

  return opts;
}

export function normalizeEndpoints(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${JSON.stringify(rawUrl)}`);
  }
  const isSecure = u.protocol === 'https:' || u.protocol === 'wss:';
  if (!isSecure && u.protocol !== 'http:' && u.protocol !== 'ws:') {
    throw new Error(`Unsupported URL protocol ${JSON.stringify(u.protocol)} (expected http, https, ws, or wss)`);
  }
  const httpProto = isSecure ? 'https:' : 'http:';
  const wsProto = isSecure ? 'wss:' : 'ws:';
  const httpBase = `${httpProto}//${u.host}`;
  const wsPath = !u.pathname || u.pathname === '/' ? '/ws' : u.pathname;
  const wsUrl = `${wsProto}//${u.host}${wsPath}${u.search}`;
  return { httpBase, wsUrl };
}

// ---------------------------------------------------------------------------
// Math, statistics & verdict helpers
// ---------------------------------------------------------------------------

const round2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);

export function computePercentiles(samples) {
  if (!samples || samples.length === 0) {
    return { count: 0, min: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  }
  const sorted = Float64Array.from(samples).sort();
  const n = sorted.length;
  const at = (q) => {
    if (n === 1) return sorted[0];
    const idx = Math.min(n - 1, Math.max(0, Math.ceil(q * n) - 1));
    return sorted[idx];
  };
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  return {
    count: n,
    min: round2(sorted[0]),
    p50: round2(at(0.5)),
    p95: round2(at(0.95)),
    p99: round2(at(0.99)),
    max: round2(sorted[n - 1]),
    mean: round2(sum / n),
  };
}

/**
 * Classify a stage's capacity health:
 *   PASS      : p95 ELD < 40 ms & 0 unexpected drops & 0 rejections (local)
 *   DEGRADED  : p95 ELD 40-100 ms & drops <= 1%
 *   SATURATED : p95 ELD > 100 ms OR drops > 1% OR joined === 0
 */
export function classifyStageVerdict(metrics, mode = 'local') {
  const target = Math.max(1, metrics.targetPlayers || 0);
  const dropRate = (metrics.dropped || 0) / target;
  const rejectRate = (metrics.rejected || 0) / target;

  if (!metrics.joined || dropRate > 0.01 || rejectRate > 0.01) {
    return 'SATURATED';
  }
  if (mode === 'local' && metrics.server?.eventLoopDelayMs) {
    const eldP95 = metrics.server.eventLoopDelayMs.p95;
    if (eldP95 > 100) return 'SATURATED';
    if (eldP95 >= 40 || metrics.dropped > 0 || metrics.rejected > 0) return 'DEGRADED';
    return 'PASS';
  }
  const rttP95 = metrics.rttMs?.p95 ?? 0;
  const jitterP95 = metrics.stateJitterMs?.p95 ?? 0;
  if (rttP95 > 250 || jitterP95 > 100) return 'SATURATED';
  if (rttP95 >= 100 || jitterP95 >= 40 || metrics.dropped > 0 || metrics.rejected > 0) return 'DEGRADED';
  return 'PASS';
}

// ---------------------------------------------------------------------------
// Disposable account helpers (remote --register / --cleanup)
// ---------------------------------------------------------------------------

function makeAccountUsername(prefix, runTag, index) {
  // server/accounts.js USERNAME_RE = /^[A-Za-z][A-Za-z0-9_-]{2,19}$/
  let cleanPrefix = String(prefix || 'lt_').replace(/[^A-Za-z0-9_-]/g, '');
  if (!/^[A-Za-z]/.test(cleanPrefix)) cleanPrefix = `l${cleanPrefix}`;
  const suffix = `${runTag}_${index}`;
  const maxPrefixLen = Math.max(1, 20 - suffix.length);
  const name = `${cleanPrefix.slice(0, maxPrefixLen)}${suffix}`.slice(0, 20);
  return name.length >= 3 ? name : `${name}bot`.slice(0, 20);
}

function extractCookieHeader(res) {
  const rawList = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const pairs = rawList
    .map((line) => String(line).split(';')[0].trim())
    .filter(Boolean);
  return pairs.length ? pairs.join('; ') : null;
}

async function registerDisposableAccount(httpBase, username, password) {
  const res = await fetch(`${httpBase}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const data = await res.json();
      detail = data?.error ? `: ${data.error}` : '';
    } catch {}
    throw new Error(`POST /api/register failed (${res.status}${detail})`);
  }
  const cookie = extractCookieHeader(res);
  if (!cookie) throw new Error('POST /api/register did not return a session cookie');
  const body = await res.json();
  return { username, password, cookie, userId: body?.user?.id ?? null };
}

async function deleteDisposableAccount(httpBase, account) {
  const res = await fetch(`${httpBase}/api/delete-account`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: account.cookie,
    },
    body: JSON.stringify({ password: account.password }),
  });
  return res.ok;
}

// ---------------------------------------------------------------------------
// Stage telemetry collector & Bot client
// ---------------------------------------------------------------------------

function createStageCollector(expectedStateIntervalMs) {
  return {
    active: false,
    expectedStateIntervalMs,
    dropped: 0,
    rejected: 0,
    joinLatenciesMs: [],
    stateIntervalsMs: [],
    stateJitterMs: [],
    rttMs: [],
    bytesRecv: 0,
    bytesSent: 0,
    errors: 0,
    messages: {
      state: { count: 0, bytes: 0 },
      stateDelta: { count: 0, bytes: 0 },
      rpg: { count: 0, bytes: 0, entityDeltaCount: 0 },
      chat: { count: 0, bytes: 0 },
      other: { count: 0, bytes: 0 },
    },
  };
}

function goldenDiskTarget(index, radius) {
  // Golden-angle spiral gives uniform disk density across [0, radius].
  const goldenAngle = 2.399963229728653;
  const r = radius * Math.sqrt((index + 0.5) / Math.max(index + 1, 16));
  const clampedR = Math.min(radius, r);
  const theta = index * goldenAngle;
  return {
    x: Math.cos(theta) * clampedR,
    z: Math.sin(theta) * clampedR,
    yaw: (theta + Math.PI / 2) % (Math.PI * 2),
  };
}

class LoadBot {
  constructor(index, { wsUrl, name, account, delta, spreadM, joinTimeoutMs, getCollector }) {
    this.index = index;
    this.wsUrl = wsUrl;
    this.name = name;
    this.account = account || null;
    this.delta = delta;
    this.joinTimeoutMs = joinTimeoutMs;
    this.getCollector = getCollector;

    const target = goldenDiskTarget(index, spreadM);
    this.targetX = target.x;
    this.targetZ = target.z;
    this.yaw = target.yaw;
    this.turnRate = (index % 2 === 0 ? 1 : -1) * (0.35 + (index % 7) * 0.08);
    this.strafeSign = index % 3 === 0 ? 0.35 : index % 3 === 1 ? -0.35 : 0;
    this.spreadTicksRemaining = Math.min(40, Math.max(4, Math.round((Math.hypot(target.x, target.z) / 4) * 5)));

    this.ws = null;
    this.playerId = null;
    this.connected = false;
    this.joined = false;
    this.closed = false;
    this.intentionalClose = false;
    this.closeCode = null;
    this.lastStateAt = 0;
    this.pendingPingAt = null;
    this.location = null;
    this.roster = new Map();
    this.nextChatAt = 0;
  }

  connect() {
    return new Promise((resolveJoin, rejectJoin) => {
      const connectStart = performance.now();
      let settled = false;
      const done = (ok, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (ok) resolveJoin(val);
        else rejectJoin(val);
      };

      const timeout = setTimeout(() => {
        if (!this.joined) {
          this.intentionalClose = true;
          try { this.ws?.terminate(); } catch {}
          done(false, new Error('join timeout'));
        }
      }, this.joinTimeoutMs);
      timeout.unref?.();

      const wsOpts = this.account?.cookie ? { headers: { Cookie: this.account.cookie } } : undefined;
      const ws = new WebSocket(this.wsUrl, wsOpts);
      this.ws = ws;

      ws.on('open', () => {
        this.connected = true;
        const joinMsg = this.account
          ? { type: 'join', delta: this.delta }
          : { type: 'join', name: this.name, delta: this.delta };
        this.sendJson(joinMsg);
      });

      ws.on('message', (data) => {
        const byteLen = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data), 'utf8');
        const collector = this.getCollector();
        if (collector?.active) collector.bytesRecv += byteLen;

        let msg;
        try {
          msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;

        const now = performance.now();

        if (msg.type === 'welcome') {
          const latencyMs = now - connectStart;
          this.joined = true;
          this.playerId = msg.id;
          if (collector) collector.joinLatenciesMs.push(latencyMs);
          done(true, latencyMs);
          return;
        }

        if (msg.type === 'state') {
          this.location = msg.location;
          this.roster = new Map((msg.players || []).map((p) => [p.id, p]));
          if (collector?.active) {
            collector.messages.state.count += 1;
            collector.messages.state.bytes += byteLen;
            if (this.lastStateAt > 0) {
              const dt = now - this.lastStateAt;
              collector.stateIntervalsMs.push(dt);
              collector.stateJitterMs.push(Math.abs(dt - collector.expectedStateIntervalMs));
            }
          }
          this.lastStateAt = now;
          return;
        }

        if (msg.type === 'stateDelta') {
          if (msg.location === this.location) {
            for (const id of msg.gone ?? []) this.roster.delete(id);
            for (const p of msg.players ?? []) this.roster.set(p.id, { ...this.roster.get(p.id), ...p });
          }
          if (collector?.active) {
            collector.messages.stateDelta.count += 1;
            collector.messages.stateDelta.bytes += byteLen;
            if (this.lastStateAt > 0) {
              const dt = now - this.lastStateAt;
              collector.stateIntervalsMs.push(dt);
              collector.stateJitterMs.push(Math.abs(dt - collector.expectedStateIntervalMs));
            }
          }
          this.lastStateAt = now;
          return;
        }

        if (msg.type === 'rpg') {
          if (collector?.active) {
            collector.messages.rpg.count += 1;
            collector.messages.rpg.bytes += byteLen;
            if (msg.entityDelta) collector.messages.rpg.entityDeltaCount += 1;
          }
          return;
        }

        if (msg.type === 'chat') {
          if (collector?.active) {
            collector.messages.chat.count += 1;
            collector.messages.chat.bytes += byteLen;
          }
          return;
        }

        if (collector?.active) {
          collector.messages.other.count += 1;
          collector.messages.other.bytes += byteLen;
          if (msg.type === 'error') collector.errors += 1;
        }
      });

      ws.on('pong', () => {
        if (this.pendingPingAt !== null) {
          const rtt = performance.now() - this.pendingPingAt;
          this.pendingPingAt = null;
          const collector = this.getCollector();
          if (collector?.active) collector.rttMs.push(rtt);
        }
      });

      ws.on('error', (err) => {
        if (!this.joined) {
          done(false, err);
        }
      });

      ws.on('close', (code) => {
        this.closed = true;
        this.closeCode = code;
        const collector = this.getCollector();
        if (!this.joined) {
          done(false, new Error(`closed before welcome (code=${code})`));
        } else if (!this.intentionalClose && code !== CLOSE.SHUTDOWN) {
          if (collector?.active) collector.dropped += 1;
        }
      });
    });
  }

  sendJson(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    const payload = JSON.stringify(obj);
    const collector = this.getCollector();
    if (collector?.active) collector.bytesSent += Buffer.byteLength(payload, 'utf8');
    this.ws.send(payload);
    return true;
  }

  stepInput(dtSec) {
    if (!this.joined || this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.spreadTicksRemaining > 0) {
      this.spreadTicksRemaining -= 1;
      // Walk outward from spawn along radial angle to achieve realistic spatial spread on remote servers.
      this.sendJson({
        type: 'input',
        forward: 1,
        strafe: 0,
        yaw: Math.round(this.yaw * 1000) / 1000,
        run: true,
      });
      return;
    }
    this.yaw += this.turnRate * dtSec;
    if (this.yaw > Math.PI) this.yaw -= 2 * Math.PI;
    else if (this.yaw <= -Math.PI) this.yaw += 2 * Math.PI;
    this.sendJson({
      type: 'input',
      forward: 1,
      strafe: this.strafeSign,
      yaw: Math.round(this.yaw * 1000) / 1000,
    });
  }

  sendChat() {
    if (!this.joined || this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const text = CHAT_LINES[(this.index + Math.floor(performance.now() / 1000)) % CHAT_LINES.length];
    this.sendJson({ type: 'chat', text });
  }

  sendPing() {
    if (!this.joined || this.closed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.pendingPingAt !== null) return; // wait for previous pong
    this.pendingPingAt = performance.now();
    try {
      this.ws.ping();
    } catch {
      this.pendingPingAt = null;
    }
  }

  close() {
    this.intentionalClose = true;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolveClose) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        resolveClose();
      };
      const killer = setTimeout(() => {
        try { ws.terminate(); } catch {}
        finish();
      }, 1000);
      killer.unref?.();
      ws.once('close', finish);
      try {
        ws.close(1000, 'loadtest done');
      } catch {
        try { ws.terminate(); } catch {}
        finish();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Core load-test runner
// ---------------------------------------------------------------------------

async function runPool(items, concurrency, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

export async function runLoadTest(rawOptions = {}) {
  const opts = {
    ...DEFAULT_OPTIONS,
    ...rawOptions,
    stages: Array.isArray(rawOptions.stages) ? [...rawOptions.stages] : [...DEFAULT_OPTIONS.stages],
  };
  if (opts.url) opts.mode = 'remote';
  if (opts.clustered) opts.spreadM = 10;
  if (!opts.stages.length || opts.stages.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`stages must be a non-empty array of positive integers, got ${JSON.stringify(opts.stages)}`);
  }

  const maxStage = Math.max(...opts.stages);
  const runTag = randomBytes(2).toString('hex');

  let server = null;
  let httpBase = null;
  let wsUrl = null;
  let tickHz = 25;
  let snapshotEveryTicks = 2;

  // Server-side tick instrumentation (local mode only)
  let stageTickIntervals = [];
  let lastServerTickAt = 0;
  let eldMonitor = null;

  if (opts.mode === 'local') {
    server = createGameServer({
      host: '127.0.0.1',
      port: 0,
      allowGuests: true,
      maxPlayers: Math.max(opts.maxPlayers, maxStage + 64),
      dbPath: ':memory:',
      ...(opts.features !== undefined ? { features: opts.features } : {}),
    });
    const addr = await server.start();
    tickHz = server.config.tickHz;
    snapshotEveryTicks = server.config.snapshotEveryTicks;
    httpBase = `http://127.0.0.1:${addr.port}`;
    wsUrl = `ws://127.0.0.1:${addr.port}/ws`;

    server.runtime.ctx.onTick((_dt, now) => {
      if (lastServerTickAt > 0) {
        stageTickIntervals.push(now - lastServerTickAt);
      }
      lastServerTickAt = now;
    });

    eldMonitor = monitorEventLoopDelay({ resolution: 10 });
    eldMonitor.enable();
  } else {
    ({ httpBase, wsUrl } = normalizeEndpoints(opts.url));
  }

  const expectedStateIntervalMs = (1000 / tickHz) * snapshotEveryTicks;
  const activeBots = [];
  const registeredAccounts = [];
  let currentCollector = null;
  let driveTimer = null;
  let pingTimer = null;
  let nextBotIndex = 0;

  const getCollector = () => currentCollector;

  function placeBotInLocalWorld(bot) {
    if (!server || bot.playerId == null) return;
    const p = server.runtime.ctx.players.get(bot.playerId);
    if (!p) return;
    const ext = server.config.worldHalfExtent - 4;
    p.x = Math.max(-ext, Math.min(ext, bot.targetX));
    p.z = Math.max(-ext, Math.min(ext, bot.targetZ));
    p.yaw = bot.yaw;
    bot.spreadTicksRemaining = 0;
  }

  async function spawnBotsUpTo(targetCount, stageCollector) {
    const needed = Math.max(0, targetCount - activeBots.filter((b) => !b.closed).length);
    if (needed === 0) return;

    const indices = Array.from({ length: needed }, () => nextBotIndex++);
    await runPool(indices, opts.connectConcurrency, async (idx) => {
      let account = null;
      const guestName = `Bot_${runTag}_${idx}`;
      try {
        if (opts.mode === 'remote' && opts.register) {
          const username = makeAccountUsername(opts.prefix, runTag, idx);
          const password = `LoadTest!${randomBytes(8).toString('hex')}`;
          account = await registerDisposableAccount(httpBase, username, password);
          registeredAccounts.push(account);
        }
        const bot = new LoadBot(idx, {
          wsUrl,
          name: guestName,
          account,
          delta: opts.delta,
          spreadM: opts.spreadM,
          joinTimeoutMs: opts.joinTimeoutMs,
          getCollector,
        });
        await bot.connect();
        placeBotInLocalWorld(bot);
        if (opts.chatIntervalMs > 0) {
          bot.nextChatAt = performance.now() + Math.random() * opts.chatIntervalMs;
        }
        activeBots.push(bot);
      } catch {
        stageCollector.rejected += 1;
      }
    });
  }

  // Single shared input/chat scheduler to avoid creating hundreds of Node timers.
  const subBuckets = 5;
  let subBucketCursor = 0;
  function startTrafficDriver() {
    if (opts.inputHz > 0) {
      const intervalMs = Math.max(10, Math.round(1000 / (opts.inputHz * subBuckets)));
      const dtSec = 1 / opts.inputHz;
      driveTimer = setInterval(() => {
        const now = performance.now();
        const bucket = subBucketCursor++ % subBuckets;
        for (let i = bucket; i < activeBots.length; i += subBuckets) {
          const bot = activeBots[i];
          if (!bot.joined || bot.closed) continue;
          bot.stepInput(dtSec);
          if (opts.chatIntervalMs > 0 && now >= bot.nextChatAt) {
            bot.sendChat();
            bot.nextChatAt = now + opts.chatIntervalMs * (0.8 + Math.random() * 0.4);
          }
        }
      }, intervalMs);
    } else if (opts.chatIntervalMs > 0) {
      driveTimer = setInterval(() => {
        const now = performance.now();
        for (const bot of activeBots) {
          if (bot.joined && !bot.closed && now >= bot.nextChatAt) {
            bot.sendChat();
            bot.nextChatAt = now + opts.chatIntervalMs * (0.8 + Math.random() * 0.4);
          }
        }
      }, Math.min(500, Math.max(50, Math.floor(opts.chatIntervalMs / 4))));
    }

    if (opts.pingIntervalMs > 0) {
      pingTimer = setInterval(() => {
        const live = activeBots.filter((b) => b.joined && !b.closed);
        if (!live.length) return;
        const step = Math.max(1, Math.floor(live.length / opts.pingSampleSize));
        for (let i = 0; i < live.length; i += step) {
          live[i].sendPing();
        }
      }, opts.pingIntervalMs);
    }
  }

  function stopTrafficDriver() {
    if (driveTimer) {
      clearInterval(driveTimer);
      driveTimer = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  const stageResults = [];
  const startedAt = new Date().toISOString();
  const totalStartMs = performance.now();
  let cleanupSummary = null;

  try {
    startTrafficDriver();

    for (const targetPlayers of opts.stages) {
      const collector = createStageCollector(expectedStateIntervalMs);
      currentCollector = collector;

      // Ramp up new bots for this stage (join latencies are captured on `collector`).
      await spawnBotsUpTo(targetPlayers, collector);

      // Reset per-stage baselines so measurement window only reflects steady-state load at targetPlayers.
      for (const b of activeBots) {
        b.lastStateAt = 0;
        b.pendingPingAt = null;
      }
      stageTickIntervals = [];
      lastServerTickAt = 0;
      if (eldMonitor) eldMonitor.reset();
      const cpuStart = opts.mode === 'local' ? process.cpuUsage() : null;
      const stageStart = performance.now();
      collector.active = true;

      // Trigger an immediate RTT sample at start of stage so even short stages get RTT data.
      const liveAtStart = activeBots.filter((b) => b.joined && !b.closed);
      const pingStep = Math.max(1, Math.floor(liveAtStart.length / opts.pingSampleSize));
      for (let i = 0; i < liveAtStart.length; i += pingStep) liveAtStart[i].sendPing();

      await sleep(opts.durationMs);

      collector.active = false;
      const elapsedMs = Math.max(1, performance.now() - stageStart);
      const elapsedSec = elapsedMs / 1000;

      const liveBots = activeBots.filter((b) => !b.closed);
      const connectedCount = liveBots.filter((b) => b.connected).length;
      const joinedCount = liveBots.filter((b) => b.joined).length;
      const denomClients = Math.max(1, joinedCount);

      const clientIngressKBps = round2((collector.bytesRecv / denomClients) / 1024 / elapsedSec);
      const serverEgressMBps = round2((collector.bytesRecv / (1024 * 1024)) / elapsedSec);
      const serverIngressMBps = round2((collector.bytesSent / (1024 * 1024)) / elapsedSec);

      const mkMsgSummary = (m) => ({
        count: m.count,
        totalBytes: m.bytes,
        avgBytes: m.count > 0 ? round2(m.bytes / m.count) : 0,
        ...(m.entityDeltaCount !== undefined ? { entityDeltaCount: m.entityDeltaCount } : {}),
      });

      let serverMetrics = null;
      if (opts.mode === 'local' && eldMonitor && cpuStart) {
        const cpuDelta = process.cpuUsage(cpuStart);
        const cpuTotalUs = cpuDelta.user + cpuDelta.system;
        const cpuPct = round2((cpuTotalUs / (elapsedMs * 1000)) * 100);
        const mem = process.memoryUsage();
        const nsToMs = (ns) => round2(Math.max(0, Number(ns) / 1e6));
        serverMetrics = {
          eventLoopDelayMs: {
            p50: nsToMs(eldMonitor.percentile(50)),
            p95: nsToMs(eldMonitor.percentile(95)),
            p99: nsToMs(eldMonitor.percentile(99)),
            max: nsToMs(eldMonitor.max),
          },
          tickIntervalMs: {
            ...computePercentiles(stageTickIntervals),
            targetMs: round2(1000 / tickHz),
          },
          cpuPct,
          cpuUserMs: round2(cpuDelta.user / 1000),
          cpuSystemMs: round2(cpuDelta.system / 1000),
          memoryMB: {
            rss: round2(mem.rss / (1024 * 1024)),
            heapUsed: round2(mem.heapUsed / (1024 * 1024)),
            heapTotal: round2(mem.heapTotal / (1024 * 1024)),
          },
          wsBytesSentPerSec: Math.round(collector.bytesRecv / elapsedSec),
          wsBytesRecvPerSec: Math.round(collector.bytesSent / elapsedSec),
        };
      }

      const stageReport = {
        targetPlayers,
        durationMs: round2(elapsedMs),
        connected: connectedCount,
        joined: joinedCount,
        dropped: collector.dropped,
        rejected: collector.rejected,
        errors: collector.errors,
        joinLatencyMs: computePercentiles(collector.joinLatenciesMs),
        stateIntervalMs: computePercentiles(collector.stateIntervalsMs),
        stateJitterMs: computePercentiles(collector.stateJitterMs),
        rttMs: computePercentiles(collector.rttMs),
        bandwidth: {
          clientIngressKBps,
          serverEgressMBps,
          serverIngressMBps,
          totalBytesRecv: collector.bytesRecv,
          totalBytesSent: collector.bytesSent,
        },
        messages: {
          state: mkMsgSummary(collector.messages.state),
          stateDelta: mkMsgSummary(collector.messages.stateDelta),
          rpg: mkMsgSummary(collector.messages.rpg),
          chat: mkMsgSummary(collector.messages.chat),
          other: mkMsgSummary(collector.messages.other),
        },
        server: serverMetrics,
        verdict: 'PASS',
      };
      stageReport.verdict = classifyStageVerdict(stageReport, opts.mode);
      stageResults.push(stageReport);
    }
  } finally {
    stopTrafficDriver();
    currentCollector = null;

    // Close every bot socket cleanly before shutting down server or deleting accounts.
    await Promise.all(activeBots.map((b) => b.close()));

    if (eldMonitor) {
      eldMonitor.disable();
      eldMonitor = null;
    }

    if (server) {
      await server.close();
      server = null;
    }

    if (opts.mode === 'remote' && opts.register && opts.cleanup && registeredAccounts.length > 0) {
      let deleted = 0;
      let failed = 0;
      await runPool(registeredAccounts, Math.min(10, opts.connectConcurrency), async (acc) => {
        try {
          const ok = await deleteDisposableAccount(httpBase, acc);
          if (ok) deleted += 1;
          else failed += 1;
        } catch {
          failed += 1;
        }
      });
      cleanupSummary = { attempted: registeredAccounts.length, deleted, failed };
    }
  }

  const passingStages = stageResults.filter((s) => s.verdict === 'PASS');
  const degradedStages = stageResults.filter((s) => s.verdict === 'DEGRADED');
  const saturatedStages = stageResults.filter((s) => s.verdict === 'SATURATED');

  const report = {
    startedAt,
    totalDurationMs: round2(performance.now() - totalStartMs),
    config: {
      mode: opts.mode,
      url: opts.mode === 'remote' ? wsUrl : 'local://ephemeral',
      stages: opts.stages,
      durationMs: opts.durationMs,
      inputHz: opts.inputHz,
      chatIntervalMs: opts.chatIntervalMs,
      spreadM: opts.spreadM,
      clustered: opts.clustered,
      delta: opts.delta,
      auth: opts.mode === 'remote' ? (opts.register ? 'register' : 'guest') : 'guest',
    },
    stages: stageResults,
    summary: {
      maxPassingPlayers: passingStages.length ? Math.max(...passingStages.map((s) => s.targetPlayers)) : 0,
      maxDegradedPlayers: degradedStages.length ? Math.max(...degradedStages.map((s) => s.targetPlayers)) : 0,
      firstSaturatedStage: saturatedStages.length ? saturatedStages[0].targetPlayers : null,
      peakServerEgressMBps: stageResults.length ? Math.max(...stageResults.map((s) => s.bandwidth.serverEgressMBps)) : 0,
      overallVerdict: saturatedStages.length ? 'SATURATED' : degradedStages.length ? 'DEGRADED' : 'PASS',
    },
    ...(cleanupSummary ? { cleanup: cleanupSummary } : {}),
  };

  return report;
}

// ---------------------------------------------------------------------------
// Human-readable ASCII table formatter
// ---------------------------------------------------------------------------

export function formatReportTable(report) {
  const isLocal = report.config.mode === 'local';
  const headers = [
    'Players',
    'Joined',
    'Drop/Rej',
    'Join p95',
    'Snap p95',
    'RTT p95',
    'In KB/s',
    'Out MB/s',
    'Delta%',
    ...(isLocal ? ['ELD p95', 'CPU %', 'RSS MB'] : []),
    'Verdict',
  ];

  const rows = report.stages.map((s) => {
    const stateTotal = s.messages.state.count + s.messages.stateDelta.count;
    const deltaPct = stateTotal > 0 ? `${Math.round((s.messages.stateDelta.count / stateTotal) * 100)}%` : '0%';
    return [
      String(s.targetPlayers),
      String(s.joined),
      `${s.dropped}/${s.rejected}`,
      `${s.joinLatencyMs.p95.toFixed(1)}ms`,
      `${s.stateIntervalMs.p95.toFixed(1)}ms`,
      `${s.rttMs.p95.toFixed(1)}ms`,
      s.bandwidth.clientIngressKBps.toFixed(1),
      s.bandwidth.serverEgressMBps.toFixed(2),
      deltaPct,
      ...(isLocal
        ? [
            `${s.server.eventLoopDelayMs.p95.toFixed(1)}ms`,
            `${s.server.cpuPct.toFixed(1)}%`,
            s.server.memoryMB.rss.toFixed(1),
          ]
        : []),
      s.verdict,
    ];
  });

  const widths = headers.map((h, col) => Math.max(h.length, ...rows.map((r) => r[col].length)));
  const sep = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const fmtRow = (cols) => '| ' + cols.map((c, i) => c.padStart(widths[i])).join(' | ') + ' |';

  const lines = [
    `Daggerfall World Concurrent-Player Stress Benchmark (${report.config.mode})`,
    `Target: ${report.config.url} | Spread: ${report.config.spreadM}m${report.config.clustered ? ' (clustered)' : ''} | Input: ${report.config.inputHz} Hz | Chat: ${report.config.chatIntervalMs} ms | Delta: ${report.config.delta ? 'on' : 'off'}`,
    sep,
    fmtRow(headers),
    sep,
    ...rows.map(fmtRow),
    sep,
    `Verdict: ${report.summary.overallVerdict} | Max Passing: ${report.summary.maxPassingPlayers} players | Peak Egress: ${report.summary.peakServerEgressMBps.toFixed(2)} MB/s | Total Time: ${(report.totalDurationMs / 1000).toFixed(2)}s`,
  ];
  if (report.cleanup) {
    lines.push(`Account cleanup: ${report.cleanup.deleted}/${report.cleanup.attempted} deleted (${report.cleanup.failed} failed)`);
  }
  return lines.join('\n');
}

function usageText() {
  return [
    'Usage: node tools/loadtest-concurrent.mjs [options]',
    '',
    'Modes:',
    '  --local, --spawn-local       Spawn an in-process server on port 0 (default)',
    '  --url <ws-or-http-url>       Benchmark a live remote server',
    '  --guest                      Join remote server as guest (default)',
    '  --register                   Register disposable accounts on remote server',
    '  --prefix <str>               Username prefix for --register (default: loadtest_)',
    '  --cleanup                    Delete registered accounts via /api/delete-account after run',
    '',
    'Load Profile:',
    '  --stages <csv>               Comma-separated player counts (default: 25,50,100,200,400)',
    '  --duration-ms <ms>           Measurement window per stage (default: 5000)',
    '  --input-hz <hz>              Movement input frequency per bot (default: 10)',
    '  --chat-interval-ms <ms>      Proximity chat interval per bot, 0 disables (default: 15000)',
    '  --spread-m <meters>          Spatial spread radius in meters (default: 80)',
    '  --clustered                  Cluster all players within 10 m (worst-case crowd density)',
    '  --no-delta                   Disable stateDelta / entityDelta opt-in',
    '',
    'Output:',
    '  --json                       Output JSON report to stdout',
    '  --quiet                      Suppress table output',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

async function main() {
  let opts;
  try {
    opts = parseLoadTestArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}\n`);
    console.error(usageText());
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    console.log(usageText());
    return;
  }
  if (opts.json) {
    // Keep stdout pure JSON even if in-process server features emit startup notices.
    const origLog = console.log;
    console.log = (...args) => console.error(...args);
    let report;
    try {
      report = await runLoadTest(opts);
    } finally {
      console.log = origLog;
    }
    console.log(JSON.stringify(report, null, 2));
  } else {
    const report = await runLoadTest(opts);
    if (!opts.quiet) {
      console.log(formatReportTable(report));
    }
  }
}

const isCli = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((err) => {
    console.error('[loadtest] fatal:', err);
    process.exitCode = 1;
  });
}
