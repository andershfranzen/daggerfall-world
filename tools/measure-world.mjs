#!/usr/bin/env node
// Measures the cost of the shared world on one Node process (docs/world-performance.md).
//
//   ARENA2_DIR=gamedata/DaggerfallGameFiles/arena2 node tools/measure-world.mjs [options]
//
// For each player count the MAIN thread starts a fresh, loopback-only game server in-process via
// createGameServer() (production RPG feature manifest, ARENA2_DIR, temporary databases in a new
// temp directory that is deleted afterwards). A WORKER thread runs the simulated clients so their
// JSON parsing does not show up in the server's event-loop numbers. Each client joins as a normal
// player, walks around the default town at the human input cadence (one `input` every 100 ms) and
// chats occasionally (well under the 1/s chat limit). Nothing is flooded and nothing leaves 127.0.0.1.
//
// Options:
//   --counts 2,8,32   player counts (each <= the server's maxPlayers, 32 by default)
//   --warmup 3        seconds after every player joined before measuring
//   --seconds 15      measured seconds per count
//   --chat 6          mean seconds between chat lines per player (0 = no chat)
//   --json FILE       write the results as JSON
//   --svg FILE        write a bar chart (convert with: rsvg-convert -w 1400 FILE -o out.png)
//   --no-actors       run with the RPG features disabled (features: []) as a baseline
import { isMainThread, Worker, parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

// ------------------------------------------------------------------------------- worker: clients
if (!isMainThread) {
  const { default: WebSocket } = await import('ws');
  const { port, count, seconds, warmup, chatEvery, seed } = workerData;
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const LINES = ['well met', 'anyone seen the guard?', 'to the tavern', 'nice weather today', 'heading north'];
  let measuring = false;
  const clients = [];

  function client(i) {
    const c = { i, bytes: 0, msgs: 0, byType: {}, sentBytes: 0, welcome: null, closed: null, errors: [] };
    c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate: false });
    c.ws.on('message', (data) => {
      if (!c.welcome) {
        const m = JSON.parse(data);
        if (m.type === 'welcome') c.welcome = m;
        if (m.type === 'error') c.errors.push(m.message);
      }
      if (!measuring) return;
      const len = data.length;
      // Type sniff without a full parse: every server frame starts with {"type":"...".
      const head = data.toString('utf8', 0, 40);
      const type = /^\{"type":"([a-zA-Z]+)"/.exec(head)?.[1] ?? 'other';
      c.bytes += len;
      c.msgs++;
      const t = (c.byType[type] ??= { msgs: 0, bytes: 0 });
      t.msgs++;
      t.bytes += len;
      if (type === 'error') c.errors.push(JSON.parse(data).message);
    });
    c.ws.on('close', (code) => (c.closed = code));
    c.ready = new Promise((res, rej) => {
      c.ws.once('open', () => c.ws.send(JSON.stringify({ type: 'join', name: `Walker ${i}` })));
      c.ws.once('error', rej);
      const timer = setInterval(() => {
        if (c.welcome) {
          clearInterval(timer);
          res();
        } else if (c.closed) {
          clearInterval(timer);
          rej(new Error(`client ${i} closed (${c.closed}) before welcome: ${c.errors.join('; ')}`));
        }
      }, 20);
    });
    c.send = (msg) => {
      if (c.ws.readyState !== WebSocket.OPEN) return;
      const data = JSON.stringify(msg);
      if (measuring) c.sentBytes += data.length;
      c.ws.send(data);
    };
    return c;
  }

  for (let i = 0; i < count; i++) clients.push(client(i));
  await Promise.all(clients.map((c) => c.ready));
  parentPort.postMessage({ type: 'joined' });

  // Walking: hold forward most of the time, turn smoothly, pause now and then. 10 Hz input.
  for (const c of clients) {
    c.yaw = rand() * Math.PI * 2 - Math.PI;
    c.turn = 0;
    c.pause = 0;
  }
  const walk = setInterval(() => {
    for (const c of clients) {
      if (rand() < 0.05) c.turn = (rand() - 0.5) * 0.6;
      if (rand() < 0.01) c.pause = 10 + Math.floor(rand() * 20);
      c.yaw += c.turn;
      if (c.yaw > Math.PI) c.yaw -= 2 * Math.PI;
      if (c.yaw < -Math.PI) c.yaw += 2 * Math.PI;
      const moving = c.pause-- <= 0;
      c.send({ type: 'input', forward: moving ? 1 : 0, strafe: 0, yaw: Math.round(c.yaw * 1000) / 1000 });
    }
  }, 100);
  const chat =
    chatEvery > 0
      ? setInterval(() => {
          for (const c of clients) if (rand() < 0.5 / chatEvery) c.send({ type: 'chat', text: LINES[Math.floor(rand() * LINES.length)] });
        }, 500)
      : null;

  await new Promise((r) => setTimeout(r, warmup * 1000));
  measuring = true;
  parentPort.postMessage({ type: 'measuring' });
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  measuring = false;
  const elapsed = (performance.now() - t0) / 1000;
  clearInterval(walk);
  clearInterval(chat);
  const per = clients.map((c) => ({ bytes: c.bytes, msgs: c.msgs, sent: c.sentBytes, byType: c.byType, errors: c.errors.slice(0, 5), closed: c.closed }));
  for (const c of clients) c.ws.close(1000);
  await Promise.all(clients.map((c) => new Promise((r) => (c.closed !== null ? r() : c.ws.once('close', r)))));
  parentPort.postMessage({ type: 'done', elapsed, per });
}

// ------------------------------------------------------------------------------ main: server side
function parseArgs(argv) {
  const o = { counts: [2, 8, 32], warmup: 3, seconds: 15, chat: 6, json: null, svg: null, actors: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--counts') o.counts = v().split(',').map(Number);
    else if (a === '--warmup') o.warmup = Number(v());
    else if (a === '--seconds') o.seconds = Number(v());
    else if (a === '--chat') o.chat = Number(v());
    else if (a === '--json') o.json = resolve(v());
    else if (a === '--svg') o.svg = resolve(v());
    else if (a === '--no-actors') o.actors = false;
    else if (a === '-h' || a === '--help') {
      console.log('usage: ARENA2_DIR=... node tools/measure-world.mjs [--counts 2,8,32] [--seconds 15] [--warmup 3] [--chat 6] [--json f] [--svg f] [--no-actors]');
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  if (!o.counts.every((n) => Number.isInteger(n) && n >= 1 && n <= 32)) throw new Error('--counts must be integers in [1, 32]');
  if (!(o.seconds > 0 && o.seconds <= 120 && o.warmup >= 0 && o.warmup <= 60)) throw new Error('--seconds in (0,120], --warmup in [0,60]');
  return o;
}

// monitorEventLoopDelay samples include its own timer period; report only the excess (ns -> ms).
const LOOP_RESOLUTION_MS = 10;
const ms = (ns) => Math.max(0, Math.round(ns / 1e4 - LOOP_RESOLUTION_MS * 100) / 100);
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;

/** Wraps a runtime method to collect wall time per call (the server calls it through the object). */
function timeMethod(obj, name, sink) {
  const orig = obj[name];
  obj[name] = function (...args) {
    const t = performance.now();
    try {
      return orig.apply(this, args);
    } finally {
      if (sink.on) sink.samples.push(performance.now() - t);
    }
  };
  return () => (obj[name] = orig);
}

async function runOnce(count, o, arena2Dir) {
  const { createGameServer } = await import(new URL('../server/game.js', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'dfw-measure-'));
  mkdirSync(join(dir, 'client'));
  mkdirSync(join(dir, 'site'));
  let server;
  try {
    server = createGameServer({
      host: '127.0.0.1', // loopback only
      port: 0,
      accounts: null, // guest join; account checks happen only at upgrade and are not measured here
      dbPath: join(dir, 'world.db'),
      clientDir: join(dir, 'client'), // nothing static is served from the repo
      siteDir: join(dir, 'site'),
      arena2Dir,
      ...(o.actors ? {} : { features: [] }),
    });
    const tick = { on: false, samples: [] };
    const sync = { on: false, samples: [] };
    const unwrap = [timeMethod(server.runtime, 'tick', tick), timeMethod(server.runtime, 'sync', sync)];
    const addr = await server.start();
    if (addr.address !== '127.0.0.1') throw new Error(`refusing: bound to ${addr.address}`);

    const worker = new Worker(fileURLToPath(import.meta.url), {
      workerData: { port: addr.port, count, seconds: o.seconds, warmup: o.warmup, chatEvery: o.chat, seed: 0xdf00 + count },
    });
    const h = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
    let elu0, cpu0, t0, entityCount = 0, locations = new Set();
    const result = await new Promise((res, rej) => {
      worker.on('error', rej);
      worker.on('exit', (code) => code && rej(new Error(`client worker exited ${code}`)));
      worker.on('message', (m) => {
        if (m.type === 'measuring') {
          h.enable();
          elu0 = performance.eventLoopUtilization();
          cpu0 = process.cpuUsage();
          t0 = performance.now();
          tick.on = sync.on = true;
        } else if (m.type === 'done') {
          tick.on = sync.on = false;
          h.disable();
          const wall = (performance.now() - t0) / 1000;
          const elu = performance.eventLoopUtilization(elu0);
          const cpu = process.cpuUsage(cpu0);
          entityCount = server.runtime.entities?.size ?? 0;
          for (const e of server.runtime.entities?.values?.() ?? []) if (e?.location) locations.add(e.location);
          res({ ...m, wall, elu, cpu });
        }
      });
    });
    unwrap.forEach((u) => u());
    await worker.terminate();

    const per = result.per;
    const kbps = per.map((c) => c.bytes / result.elapsed / 1024).sort((a, b) => a - b);
    const byType = {};
    for (const c of per)
      for (const [t, v] of Object.entries(c.byType)) {
        const b = (byType[t] ??= { msgsPerSec: 0, kbPerSec: 0, avgBytes: 0, _b: 0, _m: 0 });
        b._b += v.bytes;
        b._m += v.msgs;
      }
    for (const b of Object.values(byType)) {
      b.msgsPerSec = r1(b._m / per.length / result.elapsed);
      b.kbPerSec = r2(b._b / per.length / result.elapsed / 1024);
      b.avgBytes = Math.round(b._b / Math.max(1, b._m));
      delete b._b;
      delete b._m;
    }
    const st = (arr) => {
      const s = [...arr].sort((a, b) => a - b);
      return { calls: s.length, meanMs: r2(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)), p99Ms: r2(pct(s, 0.99)), maxMs: r2(s.at(-1) ?? 0) };
    };
    const errors = [...new Set(per.flatMap((c) => c.errors))];
    return {
      players: count,
      actors: o.actors,
      seconds: r1(result.elapsed),
      entities: entityCount,
      entityLocations: [...locations].slice(0, 4),
      downKBps: { mean: r2(kbps.reduce((a, b) => a + b, 0) / kbps.length), min: r2(kbps[0]), max: r2(kbps.at(-1)) },
      upKBps: r2(per.reduce((a, c) => a + c.sent, 0) / per.length / result.elapsed / 1024),
      serverOutKBps: r1(per.reduce((a, c) => a + c.bytes, 0) / result.elapsed / 1024),
      byType,
      loopDelayMs: { mean: ms(h.mean), p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max) },
      loopUtilization: r2(result.elu.utilization),
      cpuPercent: r1(((result.cpu.user + result.cpu.system) / 1e6 / result.wall) * 100),
      runtimeTick: st(tick.samples),
      runtimeSync: st(sync.samples),
      rssMB: Math.round(process.memoryUsage().rss / 2 ** 20),
      clientErrors: errors.slice(0, 5),
    };
  } finally {
    await server?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

function svgChart(results, meta) {
  const W = 1000, H = 560, pad = 60;
  const panelW = (W - pad * 3) / 2, panelH = 340, top = 110;
  const cats = results.map((r) => `${r.players} players`);
  const bar = (vals, max, x0, colors, labels) => {
    const groupW = panelW / vals.length;
    let out = '';
    vals.forEach((group, gi) => {
      group.forEach((v, si) => {
        const bw = (groupW * 0.7) / group.length;
        const x = x0 + gi * groupW + groupW * 0.15 + si * bw;
        const h = (v / max) * panelH;
        out += `<rect x="${x.toFixed(1)}" y="${(top + panelH - h).toFixed(1)}" width="${(bw - 3).toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${colors[si]}"/>`;
        out += `<text x="${(x + bw / 2 - 1.5).toFixed(1)}" y="${(top + panelH - h - 6).toFixed(1)}" text-anchor="middle" class="v">${labels(v)}</text>`;
      });
      out += `<text x="${(x0 + gi * groupW + groupW / 2).toFixed(1)}" y="${top + panelH + 22}" text-anchor="middle" class="c">${cats[gi]}</text>`;
    });
    return out + `<line x1="${x0}" x2="${x0 + panelW}" y1="${top + panelH}" y2="${top + panelH}" stroke="#4b5563"/>`;
  };
  const types = ['state', 'rpg', 'chat', 'gameEvent'];
  const colorsA = ['#60a5fa', '#f59e0b', '#34d399', '#a78bfa'];
  const bw = results.map((r) => types.map((t) => r.byType[t]?.kbPerSec ?? 0));
  const maxA = Math.max(1, ...bw.flat()) * 1.15;
  const lag = results.map((r) => [r.loopDelayMs.p50, r.loopDelayMs.p99, r.runtimeSync.p99Ms]);
  const colorsB = ['#93c5fd', '#2563eb', '#f97316'];
  const maxB = Math.max(1, ...lag.flat()) * 1.15;
  const legend = (x, names, colors, step) =>
    names.map((n, i) => `<rect x="${x + i * step}" y="78" width="12" height="12" rx="2" fill="${colors[i]}"/><text x="${x + i * step + 18}" y="89" class="l">${n}</text>`).join('');
  const totals = results
    .map((r, gi) => `<text x="${(pad + gi * (panelW / results.length) + panelW / results.length / 2).toFixed(1)}" y="${top + panelH + 38}" text-anchor="middle" class="s">server out ${Math.round(r.serverOutKBps)} KB/s</text>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>text{font-family:DejaVu Sans,Arial,sans-serif;fill:#e5e7eb}.t{font-size:20px;font-weight:bold}.s{font-size:13px;fill:#9ca3af}.v{font-size:11px}.c{font-size:13px}.l{font-size:12px}.h{font-size:15px;font-weight:bold}</style>
<rect width="100%" height="100%" fill="#111827"/>
<text x="${pad}" y="34" class="t">daggerfallworld: measured cost per player (one Node server, loopback)</text>
<text x="${pad}" y="56" class="s">${meta}</text>
${legend(pad, ['state', 'rpg', 'chat', 'gameEvent'], colorsA, 95)}
${bar(bw, maxA, pad, colorsA, (v) => v.toFixed(1))}
${totals}
<text x="${pad}" y="${top + panelH + 66}" class="h">Download per player, by message type (KB/s)</text>
${legend(pad * 2 + panelW, ['loop delay p50', 'loop delay p99', 'runtime.sync p99'], colorsB, 135)}
${bar(lag, maxB, pad * 2 + panelW, colorsB, (v) => v.toFixed(1))}
<text x="${pad * 2 + panelW}" y="${top + panelH + 66}" class="h">Server event-loop delay and sync time (ms)</text>
</svg>`;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const raw = process.env.ARENA2_DIR;
  let arena2Dir = null;
  if (raw) {
    arena2Dir = resolve(raw);
    if (!existsSync(arena2Dir) || !statSync(arena2Dir).isDirectory()) throw new Error(`ARENA2_DIR ${raw} is not a directory`);
  } else console.warn('warning: ARENA2_DIR is not set; data-driven actors (NPCs, monsters, collision) stay inactive');

  console.log(`measure-world: counts=${o.counts.join(',')} warmup=${o.warmup}s measured=${o.seconds}s chat≈1/${o.chat}s/player actors=${o.actors} cpus=${cpus().length} node=${process.version}`);
  const results = [];
  for (const n of o.counts) {
    process.stdout.write(`  ${String(n).padStart(2)} players ... `);
    const r = await runOnce(n, o, arena2Dir);
    results.push(r);
    const t = (k) => r.byType[k]?.kbPerSec ?? 0;
    console.log(
      `down ${r.downKBps.mean} KB/s/player (state ${t('state')}, rpg ${t('rpg')}, chat ${t('chat')}) | up ${r.upKBps} KB/s | server out ${r.serverOutKBps} KB/s | ` +
        `loop delay p50 ${r.loopDelayMs.p50} p99 ${r.loopDelayMs.p99} max ${r.loopDelayMs.max} ms | ELU ${r.loopUtilization} | CPU ${r.cpuPercent}% | ` +
        `sync mean ${r.runtimeSync.meanMs} p99 ${r.runtimeSync.p99Ms} ms | tick mean ${r.runtimeTick.meanMs} ms | entities ${r.entities}` +
        (r.clientErrors.length ? ` | client errors: ${r.clientErrors.join('; ')}` : '')
    );
  }
  const out = { measuredAt: new Date().toISOString(), node: process.version, cpus: cpus().length, cpuModel: cpus()[0]?.model, arena2: !!arena2Dir, options: { ...o, json: undefined, svg: undefined }, results };
  if (o.json) writeFileSync(o.json, JSON.stringify(out, null, 2) + '\n');
  if (o.svg) {
    const meta = `${new Date().toISOString().slice(0, 10)} · ${process.version} · ${cpus()[0]?.model?.trim() ?? ''} · ARENA2 ${arena2Dir ? 'on' : 'off'} · RPG features ${o.actors ? 'on' : 'off'} · ${o.seconds}s measured per run, input 10 Hz, chat ≈1/${o.chat}s`;
    writeFileSync(o.svg, svgChart(results, meta.replace(/&/g, '&amp;').replace(/</g, '&lt;')));
  }
  if (!o.json) console.log(JSON.stringify(out.results, null, 2));
}

if (isMainThread) await main();
