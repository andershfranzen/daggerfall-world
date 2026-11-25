#!/usr/bin/env node
// Moving-client benchmark for outdoor peer visibility (brief E, server/rpg/peers.js).
//
//   ARENA2_DIR=gamedata/DaggerfallGameFiles/arena2 nice -n 10 node tools/measure-peers.mjs [options]
//
// Same method as tools/measure-world.mjs (docs/world-performance.md): for every scenario and player
// count the main thread starts a fresh loopback-only game server in-process (production feature
// manifest + ARENA2_DIR, temporary databases deleted afterwards) and a worker thread runs the
// simulated clients at the human input cadence (10 Hz input, chat about once every 6 s).
//
// Scenarios:
//   town       everyone in the default town (the existing one-town run, for comparison)
//   clustered  half the players just west and half just east of one map-pixel edge, so every
//              client sees the others across the border (projected peers)
//   dispersed  every player in a different town, spread over the populated regions
// Players are placed by a benchmark-only action (`bench.place`) after joining; it is not part of
// the production feature list.
//
// Options: --scenarios town,clustered,dispersed  --counts 2,8,32  --warmup 4  --seconds 12
//          --chat 6  --json FILE
import { isMainThread, Worker, parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir, cpus, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const HALF = 409.6;

// ------------------------------------------------------------------------------- worker: clients
if (!isMainThread) {
  const { default: WebSocket } = await import('ws');
  const { port, places, seconds, warmup, chatEvery, seed } = workerData;
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const LINES = ['well met', 'over here', 'to the tavern', 'nice weather today', 'heading north'];
  let measuring = false;
  const clients = places.map((place, i) => {
    const c = { i, place, bytes: 0, msgs: 0, byType: {}, sent: 0, welcome: null, closed: null, errors: [], seen: 0, across: 0, states: 0 };
    c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate: false });
    c.ws.on('message', (data) => {
      const head = data.toString('utf8', 0, 40);
      const type = /^\{"type":"([a-zA-Z]+)"/.exec(head)?.[1] ?? 'other';
      if (!c.welcome || type === 'actionResult' || type === 'error') {
        const m = JSON.parse(data);
        if (m.type === 'welcome') c.welcome = m;
        if (m.type === 'actionResult') c.placed = m.ok ? true : m.error;
        if (m.type === 'error') c.errors.push(m.message);
      }
      if (!measuring) return;
      c.bytes += data.length;
      c.msgs++;
      const t = (c.byType[type] ??= { msgs: 0, bytes: 0 });
      t.msgs++;
      t.bytes += data.length;
      if (type === 'state') {
        // Count visible peers (sampled: every 5th state) without slowing the worker much.
        if (c.states++ % 5 === 0) {
          const m = JSON.parse(data);
          c.seen += m.players.length - 1;
          c.across += m.players.filter((p) => p.across).length;
        }
      }
    });
    c.ws.on('close', (code) => (c.closed = code));
    c.send = (msg) => {
      if (c.ws.readyState !== WebSocket.OPEN) return;
      const d = JSON.stringify(msg);
      if (measuring) c.sent += d.length;
      c.ws.send(d);
    };
    c.ready = new Promise((res, rej) => {
      c.ws.once('open', () => c.send({ type: 'join', name: `Walker ${i}` }));
      c.ws.once('error', rej);
      const timer = setInterval(() => {
        if (c.welcome) { clearInterval(timer); res(); }
        else if (c.closed) { clearInterval(timer); rej(new Error(`client ${i} closed before welcome: ${c.errors.join('; ')}`)); }
      }, 20);
    });
    return c;
  });
  await Promise.all(clients.map((c) => c.ready));
  for (const c of clients) if (c.place) c.send({ type: 'action', seq: 1, verb: 'bench.place', args: c.place });
  await new Promise((r) => {
    const t = setInterval(() => { if (clients.every((c) => !c.place || c.placed !== undefined)) { clearInterval(t); r(); } }, 20);
  });
  const placeErrors = clients.filter((c) => c.place && c.placed !== true).map((c) => c.placed);
  parentPort.postMessage({ type: 'joined', placeErrors: placeErrors.slice(0, 3) });

  for (const c of clients) {
    // Clustered walkers face along the border (north/south) with small turns, so they keep meeting.
    c.yaw = c.place?.yaw ?? rand() * Math.PI * 2 - Math.PI;
    c.turn = 0;
    c.pause = 0;
  }
  const walk = setInterval(() => {
    for (const c of clients) {
      if (rand() < 0.05) c.turn = (rand() - 0.5) * 0.6;
      if (rand() < 0.01) c.pause = 10 + Math.floor(rand() * 20);
      if (rand() < 0.02) c.yaw += Math.PI; // turn back now and then
      c.yaw += c.turn;
      c.yaw = Math.atan2(Math.sin(c.yaw), Math.cos(c.yaw));
      const moving = c.pause-- <= 0;
      c.send({ type: 'input', forward: moving ? 1 : 0, strafe: 0, yaw: Math.round(c.yaw * 1000) / 1000 });
    }
  }, 100);
  const chat = chatEvery > 0 ? setInterval(() => {
    for (const c of clients) if (rand() < 0.5 / chatEvery) c.send({ type: 'chat', text: LINES[Math.floor(rand() * LINES.length)] });
  }, 500) : null;

  await new Promise((r) => setTimeout(r, warmup * 1000));
  measuring = true;
  parentPort.postMessage({ type: 'measuring' });
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  measuring = false;
  const elapsed = (performance.now() - t0) / 1000;
  clearInterval(walk);
  clearInterval(chat);
  const per = clients.map((c) => ({ bytes: c.bytes, sent: c.sent, byType: c.byType, errors: c.errors.slice(0, 3), seen: c.seen, across: c.across, samples: Math.ceil(c.states / 5) }));
  for (const c of clients) c.ws.close(1000);
  await Promise.all(clients.map((c) => new Promise((r) => (c.closed !== null ? r() : c.ws.once('close', r)))));
  parentPort.postMessage({ type: 'done', elapsed, per });
}

// ------------------------------------------------------------------------------ main: server side
function parseArgs(argv) {
  const o = { scenarios: ['town', 'clustered', 'dispersed'], counts: [2, 8, 32], warmup: 4, seconds: 12, chat: 6, json: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--scenarios') o.scenarios = v().split(',');
    else if (a === '--counts') o.counts = v().split(',').map(Number);
    else if (a === '--warmup') o.warmup = Number(v());
    else if (a === '--seconds') o.seconds = Number(v());
    else if (a === '--chat') o.chat = Number(v());
    else if (a === '--json') o.json = resolve(v());
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.counts.every((n) => Number.isInteger(n) && n >= 1 && n <= 32)) throw new Error('--counts must be integers in [1, 32]');
  return o;
}

const LOOP_RESOLUTION_MS = 10;
const ms = (ns) => Math.max(0, Math.round(ns / 1e4 - LOOP_RESOLUTION_MS * 100) / 100);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return { calls: s.length, meanMs: r2(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)), p99Ms: r2(pct(s, 0.99)), maxMs: r2(s.at(-1) ?? 0) };
};

/** Benchmark-only feature: put a joined player at a location (stands in for walking there). */
function benchPlacer(ctx) {
  ctx.onAction('bench.place', (p, args) => {
    p.rpg.location = String(args.location);
    p.x = Number(args.x) || 0;
    p.z = Number(args.z) || 0;
    p.yaw = Number(args.yaw) || 0;
  });
}

async function placesFor(scenario, count, arena2Dir) {
  if (scenario === 'town') return Array.from({ length: count }, () => null);
  if (scenario === 'clustered') {
    // The east edge of Gothway Garden's map pixel (109,159) and the pixel beyond it (110,159).
    return Array.from({ length: count }, (_, i) => {
      const west = i % 2 === 0;
      const off = 2 + (i >> 1) * 1.5; // 2..25 m from the edge
      return { location: west ? 'wilderness:109,159' : 'wilderness:110,159', x: west ? HALF - off : -HALF + off, z: ((i * 7) % 40) - 20, yaw: i % 4 < 2 ? 0 : Math.PI };
    });
  }
  // dispersed: the first city, town or village of each populated region, one player each.
  const { loadWorldFromDir } = await import(new URL('../server/rpg/travel/data.js', import.meta.url));
  const { catalog } = await loadWorldFromDir(arena2Dir);
  const picks = [];
  const regions = new Set();
  for (const e of catalog.locations) {
    if (!['city', 'hamlet', 'village'].includes(e.type) || regions.has(e.regionIndex)) continue;
    regions.add(e.regionIndex);
    picks.push(e.id);
  }
  return Array.from({ length: count }, (_, i) => ({ location: picks[i % picks.length], x: 0, z: 0 }));
}

async function runOnce(scenario, count, o, arena2Dir) {
  const { createGameServer } = await import(new URL('../server/game.js', import.meta.url));
  const { features } = await import(new URL('../server/rpg/features.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'dfw-peers-bench-'));
  mkdirSync(join(dir, 'client'));
  mkdirSync(join(dir, 'site'));
  let server;
  try {
    const places = await placesFor(scenario, count, arena2Dir);
    server = createGameServer({
      host: '127.0.0.1', port: 0, accounts: null,
      dbPath: join(dir, 'world.db'), clientDir: join(dir, 'client'), siteDir: join(dir, 'site'), arena2Dir,
      features: [...features, { name: 'benchPlacer', install: benchPlacer }],
    });
    const tick = { on: false, samples: [] };
    const sync = { on: false, samples: [] };
    const across = { on: false, samples: [], perTick: 0 };
    const wrap = (obj, name, sink) => {
      const orig = obj[name];
      obj[name] = function (...args) {
        const t = performance.now();
        try { return orig.apply(this, args); } finally { if (sink.on) sink.samples.push(performance.now() - t); }
      };
      return () => (obj[name] = orig);
    };
    const unwrap = [wrap(server.runtime, 'tick', tick), wrap(server.runtime, 'sync', sync)];
    const addr = await server.start();
    if (addr.address !== '127.0.0.1') throw new Error(`refusing: bound to ${addr.address}`);
    const view = server.runtime.ctx.services.peerView;
    if (view) unwrap.push(wrap(view, 'across', across));

    const worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: { port: addr.port, places, seconds: o.seconds, warmup: o.warmup, chatEvery: o.chat, seed: 0xe0 + count },
    });
    const h = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    let elu0, cpu0, t0, heap0, placeErrors = [];
    const result = await new Promise((res, rej) => {
      worker.on('error', rej);
      worker.on('exit', (code) => code && rej(new Error(`client worker exited ${code}`)));
      worker.on('message', (m) => {
        if (m.type === 'joined') placeErrors = m.placeErrors;
        if (m.type === 'measuring') {
          h.enable();
          elu0 = performance.eventLoopUtilization();
          cpu0 = process.cpuUsage();
          heap0 = process.memoryUsage().heapUsed;
          t0 = performance.now();
          tick.on = sync.on = across.on = true;
        } else if (m.type === 'done') {
          tick.on = sync.on = across.on = false;
          h.disable();
          res({ ...m, wall: (performance.now() - t0) / 1000, elu: performance.eventLoopUtilization(elu0), cpu: process.cpuUsage(cpu0) });
        }
      });
    });
    const mem = process.memoryUsage();
    const peerStats = view?.stats?.() ?? null;
    unwrap.forEach((u) => u());
    await worker.terminate();

    const per = result.per;
    const down = per.map((c) => c.bytes / result.elapsed / 1024);
    const byType = {};
    for (const c of per) for (const [t, v] of Object.entries(c.byType)) {
      const b = (byType[t] ??= { _b: 0, _m: 0 });
      b._b += v.bytes;
      b._m += v.msgs;
    }
    for (const [t, b] of Object.entries(byType)) byType[t] = { kbPerSec: r2(b._b / per.length / result.elapsed / 1024), avgBytes: Math.round(b._b / Math.max(1, b._m)), msgsPerSec: r1(b._m / per.length / result.elapsed) };
    const samples = per.reduce((a, c) => a + c.samples, 0) || 1;
    // Snapshot work per broadcast tick: sync plus the projection calls made by broadcastState
    // (runtime.sync's own across() calls are already inside the sync samples).
    const ticks = Math.max(1, sync.samples.length);
    const acrossPerTick = across.samples.reduce((a, b) => a + b, 0) / ticks;
    return {
      scenario, players: count, seconds: r1(result.elapsed),
      downKBps: { mean: r2(down.reduce((a, b) => a + b, 0) / down.length), max: r2(Math.max(...down)) },
      upKBps: r2(per.reduce((a, c) => a + c.sent, 0) / per.length / result.elapsed / 1024),
      byType,
      visiblePeers: { mean: r1(per.reduce((a, c) => a + c.seen, 0) / samples), acrossMean: r1(per.reduce((a, c) => a + c.across, 0) / samples) },
      loopDelayMs: { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max) },
      loopUtilization: r2(result.elu.utilization),
      cpuPercent: r1(((result.cpu.user + result.cpu.system) / 1e6 / result.wall) * 100),
      runtimeTick: stats(tick.samples),
      runtimeSync: stats(sync.samples),
      peerAcross: { ...stats(across.samples), perTickMs: r2(acrossPerTick) },
      peerView: peerStats,
      heapMB: Math.round(mem.heapUsed / 2 ** 20), heapDeltaMB: r1((mem.heapUsed - heap0) / 2 ** 20), rssMB: Math.round(mem.rss / 2 ** 20),
      placeErrors, clientErrors: [...new Set(per.flatMap((c) => c.errors))].slice(0, 3),
    };
  } finally {
    await server?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const raw = process.env.ARENA2_DIR;
  if (!raw || !existsSync(raw) || !statSync(raw).isDirectory()) throw new Error('ARENA2_DIR must name the ARENA2 folder (frames and towns come from it)');
  const arena2Dir = resolve(raw);
  console.log(`measure-peers: scenarios=${o.scenarios.join(',')} counts=${o.counts.join(',')} warmup=${o.warmup}s measured=${o.seconds}s cpus=${cpus().length} load=${loadavg().map((v) => v.toFixed(1)).join('/')} node=${process.version}`);
  const results = [];
  for (const sc of o.scenarios) {
    for (const n of o.counts) {
      process.stdout.write(`  ${sc.padEnd(9)} ${String(n).padStart(2)} players ... `);
      const r = await runOnce(sc, n, o, arena2Dir);
      results.push(r);
      console.log(`down ${r.downKBps.mean} KB/s/player (state ${r.byType.state?.kbPerSec ?? 0} @ ${r.byType.state?.avgBytes ?? 0} B, rpg ${r.byType.rpg?.kbPerSec ?? 0}) | peers ${r.visiblePeers.mean} (across ${r.visiblePeers.acrossMean}) | ` +
        `tick mean/p99 ${r.runtimeTick.meanMs}/${r.runtimeTick.p99Ms} ms | sync mean/p99 ${r.runtimeSync.meanMs}/${r.runtimeSync.p99Ms} ms | across/tick ${r.peerAcross.perTickMs} ms (p99 call ${r.peerAcross.p99Ms}) | ` +
        `loop p99 ${r.loopDelayMs.p99} ms | ELU ${r.loopUtilization} | heap ${r.heapMB} MB` + (r.placeErrors.length ? ` | place errors: ${r.placeErrors.join('; ')}` : '') + (r.clientErrors.length ? ` | client errors: ${r.clientErrors.join('; ')}` : ''));
    }
  }
  const out = { measuredAt: new Date().toISOString(), node: process.version, cpus: cpus().length, cpuModel: cpus()[0]?.model, loadavg: loadavg(), options: { ...o, json: undefined }, results };
  if (o.json) writeFileSync(o.json, JSON.stringify(out, null, 2) + '\n');
}

if (isMainThread) await main();
