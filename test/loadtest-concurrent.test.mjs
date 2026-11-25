import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGameServer } from '../server/game.js';
import { createAccounts } from '../server/accounts.js';
import {
  DEFAULT_OPTIONS,
  parseLoadTestArgs,
  normalizeEndpoints,
  computePercentiles,
  classifyStageVerdict,
  formatReportTable,
  runLoadTest,
} from '../tools/loadtest-concurrent.mjs';

describe('parseLoadTestArgs', () => {
  test('returns expected defaults with no arguments', () => {
    const opts = parseLoadTestArgs([]);
    assert.equal(opts.mode, 'local');
    assert.equal(opts.url, null);
    assert.deepEqual(opts.stages, [25, 50, 100, 200, 400]);
    assert.equal(opts.durationMs, 5000);
    assert.equal(opts.inputHz, 10);
    assert.equal(opts.chatIntervalMs, 15000);
    assert.equal(opts.spreadM, 80);
    assert.equal(opts.clustered, false);
    assert.equal(opts.delta, true);
    assert.equal(opts.json, false);
    assert.equal(opts.prefix, DEFAULT_OPTIONS.prefix);
  });

  test('parses remote URL, account flags, stages, clustered, and json', () => {
    const opts = parseLoadTestArgs([
      '--url', 'https://dreadlode.example.com',
      '--register',
      '--prefix', 'stress_',
      '--cleanup',
      '--stages', '10,25,50',
      '--duration-ms', '2000',
      '--input-hz', '8',
      '--chat-interval-ms', '0',
      '--clustered',
      '--json',
    ]);
    assert.equal(opts.mode, 'remote');
    assert.equal(opts.url, 'https://dreadlode.example.com');
    assert.equal(opts.register, true);
    assert.equal(opts.guest, false);
    assert.equal(opts.prefix, 'stress_');
    assert.equal(opts.cleanup, true);
    assert.deepEqual(opts.stages, [10, 25, 50]);
    assert.equal(opts.durationMs, 2000);
    assert.equal(opts.inputHz, 8);
    assert.equal(opts.chatIntervalMs, 0);
    assert.equal(opts.clustered, true);
    assert.equal(opts.spreadM, 10);
    assert.equal(opts.json, true);
  });

  test('supports --spawn-local alias and --flag=value syntax', () => {
    const opts = parseLoadTestArgs([
      '--spawn-local',
      '--stages=5,15',
      '--spread-m=120',
      '--no-delta',
    ]);
    assert.equal(opts.mode, 'local');
    assert.deepEqual(opts.stages, [5, 15]);
    assert.equal(opts.spreadM, 120);
    assert.equal(opts.delta, false);
  });

  test('rejects invalid flags and malformed values', () => {
    assert.throws(() => parseLoadTestArgs(['--bogus']), /Unknown argument/);
    assert.throws(() => parseLoadTestArgs(['--stages', '0,10']), /positive integer/);
    assert.throws(() => parseLoadTestArgs(['--duration-ms', '-1']), /positive integer/);
    assert.throws(() => parseLoadTestArgs(['--input-hz', '999']), /finite number/);
  });

  test('normalizes http/https/ws/wss URLs', () => {
    assert.deepEqual(normalizeEndpoints('http://127.0.0.1:9000'), {
      httpBase: 'http://127.0.0.1:9000',
      wsUrl: 'ws://127.0.0.1:9000/ws',
    });
    assert.deepEqual(normalizeEndpoints('wss://dreadlode.example.com/ws'), {
      httpBase: 'https://dreadlode.example.com',
      wsUrl: 'wss://dreadlode.example.com/ws',
    });
  });

  test('computes percentiles and classifies verdicts accurately', () => {
    const stats = computePercentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    assert.equal(stats.count, 10);
    assert.equal(stats.min, 10);
    assert.equal(stats.p50, 50);
    assert.equal(stats.p95, 100);
    assert.equal(stats.max, 100);

    assert.equal(
      classifyStageVerdict({ targetPlayers: 100, joined: 100, dropped: 0, rejected: 0, server: { eventLoopDelayMs: { p95: 15 } } }, 'local'),
      'PASS',
    );
    assert.equal(
      classifyStageVerdict({ targetPlayers: 100, joined: 100, dropped: 0, rejected: 0, server: { eventLoopDelayMs: { p95: 65 } } }, 'local'),
      'DEGRADED',
    );
    assert.equal(
      classifyStageVerdict({ targetPlayers: 100, joined: 100, dropped: 0, rejected: 0, server: { eventLoopDelayMs: { p95: 120 } } }, 'local'),
      'SATURATED',
    );
    assert.equal(
      classifyStageVerdict({ targetPlayers: 100, joined: 98, dropped: 2, rejected: 0, server: { eventLoopDelayMs: { p95: 10 } } }, 'local'),
      'SATURATED',
    );
  });
});

describe('runLoadTest integration', () => {
  test('runs multi-stage local load test (5, 15 bots) on ephemeral port 0 with full telemetry and zero drops', async () => {
    const report = await runLoadTest({
      mode: 'local',
      stages: [5, 15],
      durationMs: 800,
      inputHz: 10,
      chatIntervalMs: 500,
      spreadM: 80,
      pingIntervalMs: 300,
      quiet: true,
    });

    assert.equal(report.config.mode, 'local');
    assert.equal(report.stages.length, 2);

    const [s1, s2] = report.stages;
    assert.equal(s1.targetPlayers, 5);
    assert.equal(s1.joined, 5);
    assert.equal(s1.dropped, 0);
    assert.equal(s1.rejected, 0);

    assert.equal(s2.targetPlayers, 15);
    assert.equal(s2.joined, 15);
    assert.equal(s2.dropped, 0);
    assert.equal(s2.rejected, 0);

    for (const s of report.stages) {
      // Join handshake latency recorded for newly spawned bots in each stage
      assert.ok(s.joinLatencyMs.count > 0, `stage ${s.targetPlayers} recorded join latencies`);
      assert.ok(s.joinLatencyMs.p50 >= 0 && s.joinLatencyMs.p95 >= s.joinLatencyMs.p50 && s.joinLatencyMs.p99 >= s.joinLatencyMs.p95);

      // Bots moved and received stateDelta frames
      assert.ok(s.messages.stateDelta.count > 0, `stage ${s.targetPlayers} received stateDelta frames`);
      assert.ok(s.messages.stateDelta.avgBytes > 0, `stage ${s.targetPlayers} recorded stateDelta avgBytes`);

      // Snapshot interval & RTT metrics recorded
      assert.ok(s.stateIntervalMs.count > 0, `stage ${s.targetPlayers} recorded state intervals`);
      assert.ok(s.stateIntervalMs.p50 > 0);
      assert.ok(s.rttMs.count > 0, `stage ${s.targetPlayers} recorded WS ping RTT`);

      // Bandwidth telemetry
      assert.ok(s.bandwidth.clientIngressKBps > 0);
      assert.ok(s.bandwidth.serverEgressMBps > 0);

      // Server-side metrics (event-loop delay, CPU, memory, tick intervals)
      assert.ok(s.server, `stage ${s.targetPlayers} includes server telemetry`);
      assert.ok(s.server.eventLoopDelayMs.p95 >= 0);
      assert.ok(s.server.eventLoopDelayMs.p99 >= s.server.eventLoopDelayMs.p95);
      assert.ok(s.server.cpuPct >= 0);
      assert.ok(s.server.memoryMB.rss > 0 && s.server.memoryMB.heapUsed > 0);
      assert.ok(s.server.tickIntervalMs.count > 0);
      assert.ok(s.server.wsBytesSentPerSec > 0);
      assert.ok(['PASS', 'DEGRADED', 'SATURATED'].includes(s.verdict));
    }

    // Table formatting renders cleanly
    const table = formatReportTable(report);
    assert.ok(table.includes('Daggerfall World Concurrent-Player Stress Benchmark'));
    assert.ok(table.includes('ELD p95'));
    assert.ok(table.includes('Verdict:'));
  });

  test('supports --url remote mode against an ephemeral server on port 0', async () => {
    const server = createGameServer({
      host: '127.0.0.1',
      port: 0,
      allowGuests: true,
      maxPlayers: 100,
      dbPath: ':memory:',
      features: [],
    });
    const { port } = await server.start();
    try {
      const report = await runLoadTest({
        mode: 'remote',
        url: `http://127.0.0.1:${port}`,
        guest: true,
        stages: [6],
        durationMs: 500,
        inputHz: 10,
        chatIntervalMs: 0,
        clustered: true,
        pingIntervalMs: 200,
        quiet: true,
      });

      assert.equal(report.config.mode, 'remote');
      assert.equal(report.config.clustered, true);
      assert.equal(report.config.spreadM, 10);
      assert.equal(report.stages.length, 1);
      assert.equal(report.stages[0].joined, 6);
      assert.equal(report.stages[0].dropped, 0);
      assert.equal(report.stages[0].rejected, 0);
      assert.equal(report.stages[0].server, null);
      assert.ok(report.stages[0].messages.stateDelta.count > 0);
      assert.equal(report.stages[0].verdict, 'PASS');
    } finally {
      await server.close();
    }
  });

  test('supports --url --register --cleanup disposable accounts lifecycle on port 0', async () => {
    const accounts = createAccounts({
      dbPath: ':memory:',
      secureCookies: false,
      moderationPollMs: 0,
      scrypt: { N: 1024, r: 8, p: 1, keyLen: 32 },
      limits: { api: [1000, 60_000], register: [100, 60_000] },
    });
    const server = createGameServer({
      host: '127.0.0.1',
      port: 0,
      accounts,
      allowGuests: false,
      maxPlayers: 100,
      dbPath: ':memory:',
      features: [],
    });
    const { port } = await server.start();
    try {
      const report = await runLoadTest({
        mode: 'remote',
        url: `http://127.0.0.1:${port}`,
        register: true,
        guest: false,
        prefix: 'lt_',
        cleanup: true,
        stages: [4],
        durationMs: 400,
        inputHz: 10,
        chatIntervalMs: 0,
        pingIntervalMs: 200,
        quiet: true,
      });

      assert.equal(report.config.auth, 'register');
      assert.equal(report.stages[0].joined, 4);
      assert.equal(report.stages[0].dropped, 0);
      assert.equal(report.stages[0].rejected, 0);
      assert.deepEqual(report.cleanup, { attempted: 4, deleted: 4, failed: 0 });
      // Confirm accounts were actually deleted from the account store.
      const remaining = accounts.store.q.list.all(0);
      assert.equal(remaining.length, 0);
    } finally {
      await server.close();
      accounts.close();
    }
  });
});
