#!/usr/bin/env node
// Server capacity & hot-path profiler for Daggerfall World.
//
// Runs controlled, reproducible benchmarks against real `createGameServer()`
// on ephemeral port 0 (`:memory:` SQLite, `allowGuests: true`, `maxPlayers: 2000`)
// with real `ws` clients in a separate child process so server event-loop delay,
// CPU usage, and RSS/V8 heap measurements are uncontaminated by client sockets.
//
// Usage:
//   node tools/profile-server-capacity.mjs                  # full matrix: 25, 50, 100, 200, 350 x (1-town, 8-towns)
//   node tools/profile-server-capacity.mjs --quick          # fast smoke run: 25, 50 x (1-town, 8-towns)
//   node tools/profile-server-capacity.mjs --counts=25,100 --duration=6000 --json=/tmp/out.json

import { fork } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { cpus, platform, arch, totalmem } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createGameServer } from '../server/game.js';
import { openStore } from '../server/db.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

// 8 Iliac Bay towns (7 CLASSIC_STARTERS + Betony) for the spread-across-8-towns topology.
const EIGHT_TOWNS = Object.freeze([
  'town:Daggerfall/Gothway Garden',
  'town:Daggerfall/Daggerfall',
  'town:Glenpoint/Glenpoint',
  'town:Anticlere/Anticlere',
  'town:Sentinel/Sentinel',
  'town:Lainlyn/Lainlyn',
  'town:Wayrest/Wayrest',
  'town:Betony/Betony',
]);

function parseArgs(argv) {
  const opts = {
    role: 'orchestrator',
    quick: false,
    counts: null,
    topologies: ['1-town', '8-towns'],
    durationMs: null,
    saveIntervalMs: null,
    jsonPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--quick') opts.quick = true;
    else if (arg.startsWith('--role=')) opts.role = arg.slice('--role='.length);
    else if (arg.startsWith('--counts=')) {
      opts.counts = arg
        .slice('--counts='.length)
        .split(',')
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    } else if (arg.startsWith('--topologies=')) {
      opts.topologies = arg
        .slice('--topologies='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--duration=')) {
      opts.durationMs = Number.parseInt(arg.slice('--duration='.length), 10);
    } else if (arg.startsWith('--save-interval=')) {
      opts.saveIntervalMs = Number.parseInt(arg.slice('--save-interval='.length), 10);
    } else if (arg.startsWith('--json=')) {
      opts.jsonPath = arg.slice('--json='.length);
    }
  }
  if (!opts.counts || opts.counts.length === 0) {
    opts.counts = opts.quick ? [25, 50] : [25, 50, 100, 200, 350];
  }
  if (!Number.isFinite(opts.durationMs) || opts.durationMs <= 0) {
    opts.durationMs = opts.quick ? 2500 : 8000;
  }
  if (!Number.isFinite(opts.saveIntervalMs) || opts.saveIntervalMs <= 0) {
    opts.saveIntervalMs = opts.quick ? 1000 : 3500;
  }
  return opts;
}

function statsOf(samples) {
  if (!samples.length) return { count: 0, avg: 0, p50: 0, p95: 0, p99: 0, max: 0, sum: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < sorted.length; i++) sum += sorted[i];
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
  return {
    count: sorted.length,
    avg: sum / sorted.length,
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    max: sorted[sorted.length - 1],
    sum,
  };
}

function r2(n) {
  return Math.round(n * 100) / 100;
}

function r3(n) {
  return Math.round(n * 1000) / 1000;
}

// ============================================================================
// SERVER CHILD ROLE
// ============================================================================

async function runServerRole() {
  let server = null;
  let elMonitor = null;
  let collecting = false;
  let baseMem = null;
  let cpuStart = null;
  let wallStart = 0;

  let locomotionSamples = [];
  let runtimeTickSamples = [];
  let broadcastSamples = [];
  let runtimeSyncSamples = [];
  let persistSamples = [];
  let persistPlayerCounts = [];

  // Track synchronous tick() -> broadcastState() -> runtime.sync() timing.
  let lastRuntimeTickEnd = 0;
  let awaitingSnapshotSync = false;
  let tickLocomotionAcc = 0;

  function resetMetrics() {
    locomotionSamples = [];
    runtimeTickSamples = [];
    broadcastSamples = [];
    runtimeSyncSamples = [];
    persistSamples = [];
    persistPlayerCounts = [];
    tickLocomotionAcc = 0;
    if (elMonitor) elMonitor.reset();
    cpuStart = process.cpuUsage();
    wallStart = performance.now();
  }

  process.on('message', async (msg) => {
    try {
      if (msg.cmd === 'start') {
        const instrumentedOpenStore = (dbPath) => {
          const store = openStore(dbPath);
          const origSave = store.saveCharacters.bind(store);
          store.saveCharacters = (list, world = []) => {
            const t0 = performance.now();
            try {
              return origSave(list, world);
            } finally {
              if (collecting) {
                persistSamples.push(performance.now() - t0);
                persistPlayerCounts.push(Array.isArray(list) ? list.length : 0);
              }
            }
          };
          return store;
        };

        // Silence noisy per-location fallback warnings during benchmark runs.
        const origWarn = console.warn;
        console.warn = (...args) => {
          const first = String(args[0] ?? '');
          if (first.includes('[collision]') && first.includes('open plane')) return;
          origWarn(...args);
        };

        server = createGameServer({
          host: '127.0.0.1',
          port: 0,
          allowGuests: true,
          maxPlayers: 2000,
          dbPath: ':memory:',
          saveIntervalMs: msg.saveIntervalMs,
          openStore: instrumentedOpenStore,
        });

        // Wrap runtime.tick, runtime.sync, and services.stepPlayer without modifying server files.
        const origTick = server.runtime.tick;
        const origSync = server.runtime.sync;
        const origStep = server.runtime.ctx.services.stepPlayer;

        if (typeof origStep === 'function') {
          server.runtime.ctx.services.stepPlayer = function wrappedStepPlayer(...args) {
            if (!collecting) return origStep.apply(this, args);
            const t0 = performance.now();
            try {
              return origStep.apply(this, args);
            } finally {
              tickLocomotionAcc += performance.now() - t0;
            }
          };
        }

        server.runtime.tick = function wrappedRuntimeTick(dt, now) {
          if (collecting) {
            locomotionSamples.push(tickLocomotionAcc);
            tickLocomotionAcc = 0;
          }
          const t0 = performance.now();
          try {
            return origTick.call(this, dt, now);
          } finally {
            const t1 = performance.now();
            if (collecting) {
              runtimeTickSamples.push(t1 - t0);
              lastRuntimeTickEnd = t1;
              awaitingSnapshotSync = true;
              // Clears right after the synchronous tick() turn finishes so non-tick sync() calls
              // (e.g. join/leave/action) are never mistaken for tick broadcastState().
              queueMicrotask(() => {
                awaitingSnapshotSync = false;
              });
            }
          }
        };

        server.runtime.sync = function wrappedRuntimeSync(...args) {
          const t0 = performance.now();
          if (collecting && awaitingSnapshotSync && args.length === 0) {
            awaitingSnapshotSync = false;
            broadcastSamples.push(t0 - lastRuntimeTickEnd);
          }
          try {
            return origSync.apply(this, args);
          } finally {
            if (collecting && args.length === 0) {
              runtimeSyncSamples.push(performance.now() - t0);
            }
          }
        };

        elMonitor = monitorEventLoopDelay({ resolution: 1 });
        elMonitor.enable();

        const addr = await server.start();
        baseMem = process.memoryUsage();
        process.send({ type: 'started', port: addr.port, baseMem });
      } else if (msg.cmd === 'assign-topology') {
        const players = [...server.runtime.ctx.players.values()];
        const towns = msg.topology === '8-towns' ? EIGHT_TOWNS : [EIGHT_TOWNS[0]];
        for (let i = 0; i < players.length; i++) {
          const p = players[i];
          const town = towns[i % towns.length];
          p.rpg.location = town;
          // Distribute players within a realistic town square (+/- 28m) around origin.
          const angle = (i / Math.max(1, players.length)) * Math.PI * 2;
          const radius = 4 + ((i * 7) % 24);
          p.x = Math.cos(angle) * radius;
          p.z = Math.sin(angle) * radius;
          p.dirty = true;
        }
        server.runtime.sync();
        process.send({
          type: 'topology-assigned',
          playerCount: players.length,
          townCount: new Set(players.map((p) => p.rpg.location)).size,
        });
      } else if (msg.cmd === 'begin-measure') {
        resetMetrics();
        collecting = true;
        process.send({ type: 'measuring' });
      } else if (msg.cmd === 'end-measure') {
        collecting = false;
        const wallMs = performance.now() - wallStart;
        const cpuDelta = process.cpuUsage(cpuStart);
        const endMem = process.memoryUsage();
        const playerCount = server.runtime.ctx.players.size;

        const elp = {
          p50: r2(elMonitor.percentile(50) / 1e6),
          p95: r2(elMonitor.percentile(95) / 1e6),
          p99: r2(elMonitor.percentile(99) / 1e6),
          max: r2(elMonitor.max / 1e6),
          mean: r2(elMonitor.mean / 1e6),
        };

        const wallSec = Math.max(wallMs / 1000, 0.001);
        const cpuUserMsPerSec = cpuDelta.user / 1000 / wallSec;
        const cpuSysMsPerSec = cpuDelta.system / 1000 / wallSec;
        const cpuTotalMsPerSec = cpuUserMsPerSec + cpuSysMsPerSec;

        const rssMB = endMem.rss / (1024 * 1024);
        const heapUsedMB = endMem.heapUsed / (1024 * 1024);
        const baseRssMB = baseMem.rss / (1024 * 1024);
        const baseHeapMB = baseMem.heapUsed / (1024 * 1024);
        const rssKbPerPlayer = playerCount > 0 ? (endMem.rss - baseMem.rss) / 1024 / playerCount : 0;
        const heapKbPerPlayer = playerCount > 0 ? (endMem.heapUsed - baseMem.heapUsed) / 1024 / playerCount : 0;

        process.send({
          type: 'metrics',
          metrics: {
            wallMs: r2(wallMs),
            playerCount,
            entityCount: server.runtime.entities.size,
            eventLoopMs: elp,
            cpu: {
              userMsPerSec: r2(cpuUserMsPerSec),
              sysMsPerSec: r2(cpuSysMsPerSec),
              totalMsPerSec: r2(cpuTotalMsPerSec),
              corePct: r2(cpuTotalMsPerSec / 10),
            },
            memory: {
              baseRssMB: r2(baseRssMB),
              baseHeapMB: r2(baseHeapMB),
              rssMB: r2(rssMB),
              heapUsedMB: r2(heapUsedMB),
              rssKbPerPlayer: r2(rssKbPerPlayer),
              heapKbPerPlayer: r2(heapKbPerPlayer),
            },
            phases: {
              locomotion: formatPhase(statsOf(locomotionSamples)),
              runtimeTick: formatPhase(statsOf(runtimeTickSamples)),
              broadcastState: formatPhase(statsOf(broadcastSamples)),
              runtimeSync: formatPhase(statsOf(runtimeSyncSamples)),
              persist: {
                ...formatPhase(statsOf(persistSamples)),
                avgDirtyPlayers: r2(statsOf(persistPlayerCounts).avg),
              },
            },
          },
        });
      } else if (msg.cmd === 'stop') {
        if (elMonitor) elMonitor.disable();
        if (server) await server.close();
        process.send({ type: 'stopped' });
        process.exit(0);
      }
    } catch (err) {
      process.send({ type: 'error', message: err?.stack || String(err) });
      process.exit(1);
    }
  });
}

function formatPhase(s) {
  return {
    count: s.count,
    avgMs: r3(s.avg),
    p50Ms: r3(s.p50),
    p95Ms: r3(s.p95),
    p99Ms: r3(s.p99),
    maxMs: r3(s.max),
  };
}

// ============================================================================
// CLIENTS CHILD ROLE
// ============================================================================

async function runClientsRole() {
  const clients = [];
  let measuring = false;
  let measureStart = 0;
  let totalBytes = 0;
  let totalMsgs = 0;
  const bytesByType = { state: 0, stateDelta: 0, rpg: 0, gameEvent: 0, other: 0 };
  const msgsByType = { state: 0, stateDelta: 0, rpg: 0, gameEvent: 0, other: 0 };
  let disconnects = 0;
  let inputTimer = null;

  function connectOne(url, idx) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      const client = {
        idx,
        ws,
        joined: false,
        yaw: (idx * 0.6180339887) * Math.PI * 2,
        turnRate: (idx % 2 === 0 ? 1 : -1) * (0.25 + (idx % 5) * 0.08),
      };
      const timeout = setTimeout(() => {
        if (!client.joined) reject(new Error(`client ${idx} join timeout`));
      }, 20_000);

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'join', name: `Bench${idx + 1}`, delta: true }));
      });

      ws.on('message', (data) => {
        const len = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(data);
        if (!client.joined) {
          const text = data.toString('utf8');
          if (text.includes('"type":"welcome"')) {
            client.joined = true;
            clearTimeout(timeout);
            resolve(client);
          } else if (text.includes('"type":"error"')) {
            clearTimeout(timeout);
            reject(new Error(`client ${idx} join error: ${text}`));
          }
          return;
        }
        if (!measuring) return;
        totalBytes += len;
        totalMsgs += 1;
        // Fast prefix extraction avoids full JSON.parse overhead across 350 clients.
        const head = data.subarray(0, 48).toString('utf8');
        let kind = 'other';
        if (head.includes('"type":"stateDelta"')) kind = 'stateDelta';
        else if (head.includes('"type":"state"')) kind = 'state';
        else if (head.includes('"type":"rpg"')) kind = 'rpg';
        else if (head.includes('"type":"gameEvent"')) kind = 'gameEvent';
        bytesByType[kind] += len;
        msgsByType[kind] += 1;
      });

      ws.on('close', () => {
        if (measuring) disconnects++;
      });

      ws.on('error', (err) => {
        if (!client.joined) {
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  process.on('message', async (msg) => {
    try {
      if (msg.cmd === 'connect') {
        const url = `ws://127.0.0.1:${msg.port}/ws`;
        // Connect in batches of 25 to avoid TCP SYN backlog drops during ramp-up.
        const batchSize = 25;
        for (let start = 0; start < msg.count; start += batchSize) {
          const batch = [];
          const end = Math.min(msg.count, start + batchSize);
          for (let i = start; i < end; i++) batch.push(connectOne(url, i));
          const joined = await Promise.all(batch);
          clients.push(...joined);
        }
        process.send({ type: 'connected', count: clients.length });
      } else if (msg.cmd === 'start-moving') {
        // Send movement inputs at 10 Hz (every 100 ms), well inside inputTimeoutMs (400 ms).
        // Stagger across 5 sub-batches of 20 ms so inputs arrive smoothly like real players.
        const slices = 5;
        let sliceIdx = 0;
        inputTimer = setInterval(() => {
          const s = sliceIdx++ % slices;
          for (let i = s; i < clients.length; i += slices) {
            const c = clients[i];
            if (c.ws.readyState !== WebSocket.OPEN) continue;
            c.yaw += c.turnRate * 0.1;
            if (c.yaw > Math.PI) c.yaw -= 2 * Math.PI;
            else if (c.yaw < -Math.PI) c.yaw += 2 * Math.PI;
            c.ws.send(`{"type":"input","forward":1,"strafe":0,"yaw":${Math.round(c.yaw * 1000) / 1000}}`);
          }
        }, 20);
        process.send({ type: 'moving' });
      } else if (msg.cmd === 'begin-measure') {
        totalBytes = 0;
        totalMsgs = 0;
        disconnects = 0;
        for (const k of Object.keys(bytesByType)) {
          bytesByType[k] = 0;
          msgsByType[k] = 0;
        }
        measureStart = performance.now();
        measuring = true;
        process.send({ type: 'measuring' });
      } else if (msg.cmd === 'end-measure') {
        measuring = false;
        const wallSec = Math.max((performance.now() - measureStart) / 1000, 0.001);
        const n = Math.max(1, clients.length);
        const aggregateBytesPerSec = totalBytes / wallSec;
        const perClientBytesPerSec = aggregateBytesPerSec / n;
        const byTypeKBps = {};
        const byTypeMsgPerSec = {};
        for (const k of Object.keys(bytesByType)) {
          byTypeKBps[k] = r2(bytesByType[k] / wallSec / 1024);
          byTypeMsgPerSec[k] = r2(msgsByType[k] / wallSec);
        }
        process.send({
          type: 'metrics',
          metrics: {
            wallSec: r2(wallSec),
            clients: clients.length,
            disconnects,
            perClientKBps: r2(perClientBytesPerSec / 1024),
            aggregateMBps: r3(aggregateBytesPerSec / (1024 * 1024)),
            aggregateKBps: r2(aggregateBytesPerSec / 1024),
            totalMsgPerSec: r2(totalMsgs / wallSec),
            perClientMsgPerSec: r2(totalMsgs / wallSec / n),
            byTypeKBps,
            byTypeMsgPerSec,
          },
        });
      } else if (msg.cmd === 'stop') {
        if (inputTimer) clearInterval(inputTimer);
        await Promise.all(
          clients.map(
            (c) =>
              new Promise((resolve) => {
                if (c.ws.readyState === WebSocket.CLOSED) return resolve();
                c.ws.once('close', resolve);
                c.ws.terminate();
                setTimeout(resolve, 200).unref();
              }),
          ),
        );
        process.send({ type: 'stopped' });
        process.exit(0);
      }
    } catch (err) {
      process.send({ type: 'error', message: err?.stack || String(err) });
      process.exit(1);
    }
  });
}

// ============================================================================
// ORCHESTRATOR ROLE
// ============================================================================

function sendAndWait(child, payload, expectedType, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for ${expectedType} from child`));
    }, timeoutMs);
    const onMessage = (msg) => {
      if (msg?.type === 'error') {
        cleanup();
        reject(new Error(msg.message));
      } else if (msg?.type === expectedType) {
        cleanup();
        resolve(msg);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Child exited early (code=${code}, signal=${signal}) while waiting for ${expectedType}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.send(payload);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runScenario({ count, topology, durationMs, saveIntervalMs }) {
  const serverChild = fork(SCRIPT_PATH, ['--role=server'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const clientChild = fork(SCRIPT_PATH, ['--role=clients'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });

  try {
    const started = await sendAndWait(serverChild, { cmd: 'start', saveIntervalMs }, 'started');
    await sendAndWait(clientChild, { cmd: 'connect', port: started.port, count }, 'connected', 90_000);
    await sendAndWait(serverChild, { cmd: 'assign-topology', topology }, 'topology-assigned');
    await sendAndWait(clientChild, { cmd: 'start-moving' }, 'moving');

    // Warmup so JIT, AOI grid, and initial full snapshots settle before measurement.
    await sleep(1200);

    await Promise.all([
      sendAndWait(serverChild, { cmd: 'begin-measure' }, 'measuring'),
      sendAndWait(clientChild, { cmd: 'begin-measure' }, 'measuring'),
    ]);

    await sleep(durationMs);

    const [serverRes, clientRes] = await Promise.all([
      sendAndWait(serverChild, { cmd: 'end-measure' }, 'metrics'),
      sendAndWait(clientChild, { cmd: 'end-measure' }, 'metrics'),
    ]);

    return {
      count,
      topology,
      durationMs,
      saveIntervalMs,
      server: serverRes.metrics,
      network: clientRes.metrics,
    };
  } finally {
    await Promise.allSettled([
      sendAndWait(clientChild, { cmd: 'stop' }, 'stopped', 5000).catch(() => clientChild.kill('SIGKILL')),
      sendAndWait(serverChild, { cmd: 'stop' }, 'stopped', 5000).catch(() => serverChild.kill('SIGKILL')),
    ]);
  }
}

function pad(str, len, right = false) {
  const s = String(str);
  return right ? s.padStart(len) : s.padEnd(len);
}

function printSummaryTable(results) {
  console.log('\n=== Daggerfall World Server Capacity Profile (25 Hz tick = 40.0 ms budget, 12.5 Hz snapshots) ===\n');
  const header = [
    pad('Topology', 9),
    pad('N', 4, true),
    pad('EL p50', 7, true),
    pad('EL p95', 7, true),
    pad('EL p99', 7, true),
    pad('CPU ms/s', 9, true),
    pad('RSS MB', 7, true),
    pad('Heap MB', 8, true),
    pad('KB/p', 6, true),
    pad('Egr/c', 7, true),
    pad('Agg MB/s', 9, true),
    pad('Loco', 6, true),
    pad('rTick', 6, true),
    pad('bcast', 6, true),
    pad('rSync', 6, true),
    pad('pers', 6, true),
  ].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const r of results) {
    const s = r.server;
    const n = r.network;
    const row = [
      pad(r.topology, 9),
      pad(r.count, 4, true),
      pad(`${s.eventLoopMs.p50.toFixed(1)}`, 7, true),
      pad(`${s.eventLoopMs.p95.toFixed(1)}`, 7, true),
      pad(`${s.eventLoopMs.p99.toFixed(1)}`, 7, true),
      pad(`${s.cpu.totalMsPerSec.toFixed(0)}`, 9, true),
      pad(`${s.memory.rssMB.toFixed(1)}`, 7, true),
      pad(`${s.memory.heapUsedMB.toFixed(1)}`, 8, true),
      pad(`${s.memory.heapKbPerPlayer.toFixed(0)}`, 6, true),
      pad(`${n.perClientKBps.toFixed(1)}K`, 7, true),
      pad(`${n.aggregateMBps.toFixed(2)}`, 9, true),
      pad(`${s.phases.locomotion.avgMs.toFixed(2)}`, 6, true),
      pad(`${s.phases.runtimeTick.avgMs.toFixed(2)}`, 6, true),
      pad(`${s.phases.broadcastState.avgMs.toFixed(2)}`, 6, true),
      pad(`${s.phases.runtimeSync.avgMs.toFixed(2)}`, 6, true),
      pad(`${s.phases.persist.avgMs.toFixed(1)}`, 6, true),
    ].join(' | ');
    console.log(row);
  }
  console.log('\nColumns: EL = event-loop delay (ms); CPU ms/s = user+sys ms per wall sec (1000 = 1 full core);');
  console.log('KB/p = V8 heap delta KB/player; Egr/c = per-client egress (KB/s); Agg MB/s = total server WS egress;');
  console.log('Loco/rTick/bcast/rSync/pers = avg duration (ms) of stepPlayer, runtime.tick, broadcastState, runtime.sync, persist.');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.role === 'server') return runServerRole();
  if (opts.role === 'clients') return runClientsRole();

  const cpuModel = cpus()[0]?.model ?? 'unknown';
  const hostInfo = {
    node: process.version,
    platform: `${platform()}/${arch()}`,
    cpuModel,
    cpuCores: cpus().length,
    totalMemGB: r2(totalmem() / (1024 ** 3)),
    timestamp: new Date().toISOString(),
  };
  console.log(`[profile] Host: Node ${hostInfo.node} on ${hostInfo.platform} (${hostInfo.cpuCores}x ${hostInfo.cpuModel}, ${hostInfo.totalMemGB} GB RAM)`);
  console.log(`[profile] Matrix: counts=[${opts.counts.join(', ')}] topologies=[${opts.topologies.join(', ')}] duration=${opts.durationMs}ms saveInterval=${opts.saveIntervalMs}ms`);

  const results = [];
  for (const topology of opts.topologies) {
    for (const count of opts.counts) {
      process.stdout.write(`[profile] Running ${topology} @ ${count} moving players... `);
      const res = await runScenario({
        count,
        topology,
        durationMs: opts.durationMs,
        saveIntervalMs: opts.saveIntervalMs,
      });
      results.push(res);
      console.log(
        `done (EL p99=${res.server.eventLoopMs.p99}ms, CPU=${res.server.cpu.totalMsPerSec}ms/s, ` +
        `bcast=${res.server.phases.broadcastState.avgMs}ms, rSync=${res.server.phases.runtimeSync.avgMs}ms, ` +
        `persist=${res.server.phases.persist.avgMs}ms, egress=${res.network.aggregateMBps}MB/s)`,
      );
    }
  }

  printSummaryTable(results);

  if (opts.jsonPath) {
    writeFileSync(opts.jsonPath, JSON.stringify({ host: hostInfo, results }, null, 2));
    console.log(`\n[profile] Wrote raw JSON results to ${opts.jsonPath}`);
  }
}

main().catch((err) => {
  console.error('[profile] FATAL:', err);
  process.exit(1);
});
