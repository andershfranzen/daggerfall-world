import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  HISCORES_PATH,
  isHiscoresPath,
  createHiscoresHttpHandler,
  handleHiscoresRequest,
} from '../server/hiscores/http.js';

function createMockEngine(overrides = {}) {
  const calls = [];
  const players = new Map([
    ['Aldora', { name: 'Aldora', level: 24, className: 'Spellsword', race: 'Breton', overallRank: 1 }],
    ['Brannoc', { name: 'Brannoc', level: 19, className: 'Knight', race: 'Redguard', overallRank: 2 }],
    ['Sir Galen', { name: 'Sir Galen', level: 15, className: 'Paladin', race: 'Imperial', overallRank: 3 }],
  ]);
  const validBoards = new Set(['overall', 'long_blade', 'destruction', 'wealth']);

  const engine = {
    calls,
    async getCategories() {
      calls.push({ fn: 'getCategories' });
      return {
        categories: [
          { id: 'overall', label: 'Overall' },
          { id: 'long_blade', label: 'Long Blade' },
        ],
      };
    },
    async getOrders(params) {
      calls.push({ fn: 'getOrders', params });
      return {
        sort: params.sort ?? 'members',
        page: params.page ?? 1,
        limit: params.limit ?? 25,
        q: params.q ?? null,
        orders: [{ name: 'Knights of the Dragon', members: 18, avgLevel: 21, treasury: 94000 }],
      };
    },
    async getPlayer(name) {
      calls.push({ fn: 'getPlayer', name });
      return players.get(name) ?? null;
    },
    async comparePlayers(a, b) {
      calls.push({ fn: 'comparePlayers', a, b });
      const pa = players.get(a) ?? null;
      const pb = players.get(b) ?? null;
      if (!pa || !pb) return { a: pa, b: pb };
      return { a: pa, b: pb, levelDiff: pa.level - pb.level };
    },
    async getBoard(params) {
      calls.push({ fn: 'getBoard', params });
      if (!validBoards.has(params.board)) {
        const err = new Error(`Unknown board: ${params.board}`);
        err.code = 'UNKNOWN_BOARD';
        throw err;
      }
      return {
        board: params.board,
        page: params.page ?? 1,
        limit: params.limit ?? 25,
        filters: {
          className: params.className ?? null,
          race: params.race ?? null,
          q: params.q ?? null,
        },
        entries: [{ rank: 1, name: 'Aldora', score: 24 }],
      };
    },
    ...overrides,
  };
  return engine;
}

async function startServer(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(err.message);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('isHiscoresPath', () => {
  test('matches /api/hiscores and nested subpaths only', () => {
    assert.equal(HISCORES_PATH, '/api/hiscores');
    assert.equal(isHiscoresPath('/api/hiscores'), true);
    assert.equal(isHiscoresPath('/api/hiscores/'), true);
    assert.equal(isHiscoresPath('/api/hiscores/categories'), true);
    assert.equal(isHiscoresPath('/api/hiscores/player/Aldora'), true);
    assert.equal(isHiscoresPath('/api/hiscores?board=overall'), true);
    assert.equal(isHiscoresPath('/api/hiscores-extra'), false);
    assert.equal(isHiscoresPath('/api/world-map'), false);
    assert.equal(isHiscoresPath(null), false);
    assert.equal(isHiscoresPath(undefined), false);
  });
});

describe('hiscores HTTP API', () => {
  let engine;
  let srv;

  before(async () => {
    engine = createMockEngine();
    const handler = createHiscoresHttpHandler(engine, {
      corsOrigin: 'https://daggerfall.world',
      onError: () => {},
    });
    srv = await startServer(handler);
  });

  after(async () => {
    await srv.close();
  });

  test('GET /api/hiscores defaults to overall board with security & cache headers', async () => {
    const res = await fetch(`${srv.base}/api/hiscores`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=15, stale-while-revalidate=30');
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://daggerfall.world');
    assert.equal(res.headers.get('vary'), 'Origin');

    const body = await res.json();
    assert.equal(body.board, 'overall');
    assert.equal(body.entries[0].name, 'Aldora');
  });

  test('GET /api/hiscores passes query filters and clamps page/limit/q', async () => {
    const longQuery = 'x'.repeat(100);
    const res = await fetch(
      `${srv.base}/api/hiscores?board=long_blade&page=0&limit=250&class=Spellsword&race=Breton&q=${longQuery}`
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.board, 'long_blade');
    assert.equal(body.page, 1);
    assert.equal(body.limit, 100);
    assert.equal(body.filters.className, 'Spellsword');
    assert.equal(body.filters.race, 'Breton');
    assert.equal(body.filters.q.length, 64);
  });

  test('GET /api/hiscores supports className alias', async () => {
    const res = await fetch(`${srv.base}/api/hiscores?className=Knight&page=3&limit=10`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.page, 3);
    assert.equal(body.limit, 10);
    assert.equal(body.filters.className, 'Knight');
  });

  test('GET /api/hiscores/board/:board queries named board and rejects unknown board with 400', async () => {
    const ok = await fetch(`${srv.base}/api/hiscores/board/wealth?page=2&limit=20`);
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.board, 'wealth');
    assert.equal(okBody.page, 2);
    assert.equal(okBody.limit, 20);

    const bad = await fetch(`${srv.base}/api/hiscores/board/nonexistent_skill`);
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get('cache-control'), 'no-store');
    assert.equal(bad.headers.get('x-content-type-options'), 'nosniff');
    const badBody = await bad.json();
    assert.deepEqual(badBody, { error: 'unknown board', board: 'nonexistent_skill' });
  });

  test('GET /api/hiscores/categories returns categories', async () => {
    const res = await fetch(`${srv.base}/api/hiscores/categories`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=15, stale-while-revalidate=30');
    const body = await res.json();
    assert.equal(body.categories.length, 2);
    assert.equal(body.categories[0].id, 'overall');
  });

  test('GET /api/hiscores/orders validates sort and forwards pagination/search', async () => {
    const res = await fetch(`${srv.base}/api/hiscores/orders?sort=treasury&page=2&limit=50&q=Dragon`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.sort, 'treasury');
    assert.equal(body.page, 2);
    assert.equal(body.limit, 50);
    assert.equal(body.q, 'Dragon');

    const bad = await fetch(`${srv.base}/api/hiscores/orders?sort=invalid`);
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get('cache-control'), 'no-store');
    const badBody = await bad.json();
    assert.equal(badBody.error, 'invalid sort');
  });

  test('GET /api/hiscores/player/:name and /api/hiscores/player?name=... decode names and handle errors', async () => {
    const byPath = await fetch(`${srv.base}/api/hiscores/player/Sir%20Galen`);
    assert.equal(byPath.status, 200);
    assert.equal((await byPath.json()).name, 'Sir Galen');

    const byQuery = await fetch(`${srv.base}/api/hiscores/player?name=Aldora`);
    assert.equal(byQuery.status, 200);
    assert.equal((await byQuery.json()).name, 'Aldora');

    const missing = await fetch(`${srv.base}/api/hiscores/player/NobodyHere`);
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await missing.json(), { error: 'character not found' });

    const badUri = await fetch(`${srv.base}/api/hiscores/player/%E0%A4%A`);
    assert.equal(badUri.status, 400);
    assert.equal(badUri.headers.get('cache-control'), 'no-store');

    const badQueryUri = await fetch(`${srv.base}/api/hiscores/player?name=%E0%A4%A`);
    assert.equal(badQueryUri.status, 400);

    const emptyQuery = await fetch(`${srv.base}/api/hiscores/player?name=`);
    assert.equal(emptyQuery.status, 400);

    const tooLong = await fetch(`${srv.base}/api/hiscores/player/${'a'.repeat(65)}`);
    assert.equal(tooLong.status, 400);
  });

  test('GET /api/hiscores/compare validates params and reports missing player(s)', async () => {
    const ok = await fetch(`${srv.base}/api/hiscores/compare?a=Aldora&b=Brannoc`);
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.levelDiff, 5);

    const missingParam = await fetch(`${srv.base}/api/hiscores/compare?a=Aldora`);
    assert.equal(missingParam.status, 400);
    assert.equal(missingParam.headers.get('cache-control'), 'no-store');

    const missingOne = await fetch(`${srv.base}/api/hiscores/compare?a=Aldora&b=Ghost`);
    assert.equal(missingOne.status, 404);
    assert.equal(missingOne.headers.get('cache-control'), 'no-store');
    const missingOneBody = await missingOne.json();
    assert.match(missingOneBody.error, /Ghost/);
    assert.deepEqual(missingOneBody.missing, ['Ghost']);

    const missingBoth = await fetch(`${srv.base}/api/hiscores/compare?a=Ghost1&b=Ghost2`);
    assert.equal(missingBoth.status, 404);
    const missingBothBody = await missingBoth.json();
    assert.deepEqual(missingBothBody.missing, ['Ghost1', 'Ghost2']);
  });

  test('HEAD returns 200 with exact Content-Length and empty body', async () => {
    const getRes = await fetch(`${srv.base}/api/hiscores/categories`);
    const getBytes = Buffer.byteLength(await getRes.text());

    const headRes = await fetch(`${srv.base}/api/hiscores/categories`, { method: 'HEAD' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(headRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headRes.headers.get('cache-control'), 'public, max-age=15, stale-while-revalidate=30');
    assert.equal(Number(headRes.headers.get('content-length')), getBytes);
    assert.equal(await headRes.text(), '');
  });

  test('POST and DELETE return 405 with Allow: GET, HEAD and no-store', async () => {
    for (const method of ['POST', 'DELETE']) {
      const res = await fetch(`${srv.base}/api/hiscores`, { method });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'GET, HEAD');
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.deepEqual(await res.json(), { error: 'method not allowed' });
    }
  });

  test('unknown subpaths return 404', async () => {
    for (const path of ['/api/hiscores/unknown', '/api/hiscores/player/Aldora/extra', '/api/hiscores/board/overall/extra']) {
      const res = await fetch(`${srv.base}${path}`);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await res.json(), { error: 'not found' });
    }
  });
});

describe('rate limiting, error masking, and convenience wrapper', () => {
  test('enforces per-IP sliding-window rate limit with 429 and Retry-After', async () => {
    let fakeNow = 1_000_000;
    const engine = createMockEngine();
    const handler = createHiscoresHttpHandler(engine, {
      rateLimit: { max: 3, windowMs: 10_000 },
      trustProxy: true,
      now: () => fakeNow,
      onError: () => {},
    });
    const srv = await startServer(handler);
    try {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${srv.base}/api/hiscores/categories`, {
          headers: { 'x-forwarded-for': '203.0.113.10, 10.0.0.1' },
        });
        assert.equal(res.status, 200);
      }

      const limited = await fetch(`${srv.base}/api/hiscores/categories`, {
        headers: { 'x-forwarded-for': '203.0.113.10' },
      });
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get('cache-control'), 'no-store');
      assert.equal(limited.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(limited.headers.get('retry-after'), '10');
      const limitedBody = await limited.json();
      assert.equal(limitedBody.error, 'rate limit exceeded');

      // Different IP is unaffected.
      const otherIp = await fetch(`${srv.base}/api/hiscores/categories`, {
        headers: { 'x-forwarded-for': '203.0.113.99' },
      });
      assert.equal(otherIp.status, 200);

      // Sliding window recovers after windowMs elapses.
      fakeNow += 10_001;
      const recovered = await fetch(`${srv.base}/api/hiscores/categories`, {
        headers: { 'x-forwarded-for': '203.0.113.10' },
      });
      assert.equal(recovered.status, 200);
    } finally {
      await srv.close();
    }
  });

  test('masks unexpected engine errors as 500 without leaking stack traces', async () => {
    const logged = [];
    const engine = createMockEngine({
      async getCategories() {
        throw new Error('SECRET_DB_PASSWORD_LEAK at /internal/path.js:99');
      },
    });
    const handler = createHiscoresHttpHandler(engine, {
      onError: (err) => logged.push(err),
    });
    const srv = await startServer(handler);
    try {
      const res = await fetch(`${srv.base}/api/hiscores/categories`);
      assert.equal(res.status, 500);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      const text = await res.text();
      assert.equal(text, '{"error":"hiscores unavailable"}');
      assert.ok(!text.includes('SECRET_DB_PASSWORD_LEAK'));
      assert.equal(logged.length, 1);
    } finally {
      await srv.close();
    }
  });

  test('handleHiscoresRequest convenience helper works end-to-end', async () => {
    const engine = createMockEngine();
    const srv = await startServer((req, res) => handleHiscoresRequest(req, res, engine));
    try {
      const res = await fetch(`${srv.base}/api/hiscores/categories`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.categories[0].id, 'overall');
    } finally {
      await srv.close();
    }
  });
});
