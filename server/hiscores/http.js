// Public read-only HTTP API for the Chronicles of the Iliac Bay (Hiscores).
// Mirrors the safety, header, and error-masking conventions of server/public-world-map.js.

export const HISCORES_PATH = '/api/hiscores';

const CACHE_OK = 'public, max-age=15, stale-while-revalidate=30';
const CACHE_ERROR = 'no-store';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const ALLOWED_METHODS = 'GET, HEAD';
const ORDER_SORTS = new Set(['members', 'level', 'treasury']);
const MAX_QUERY_LEN = 64;
const MAX_NAME_LEN = 64;
const DEFAULT_RATE_MAX = 120;
const DEFAULT_RATE_WINDOW_MS = 60_000;

/** Returns true for `/api/hiscores` or `/api/hiscores/...`. */
export function isHiscoresPath(pathname) {
  if (typeof pathname !== 'string') return false;
  const q = pathname.indexOf('?');
  const path = q === -1 ? pathname : pathname.slice(0, q);
  return path === HISCORES_PATH || path.startsWith(`${HISCORES_PATH}/`);
}

/** Sliding-window per-key rate limiter. hit(key) returns 0 when allowed, else ms until retry. */
function createSlidingWindowLimiter(max, windowMs, now = () => Date.now()) {
  const hits = new Map();
  let lastSweep = now();

  function prune(list, t) {
    while (list.length && list[0] <= t - windowMs) list.shift();
  }

  function sweep(t) {
    if (t - lastSweep < windowMs) return;
    lastSweep = t;
    for (const [key, list] of hits) {
      prune(list, t);
      if (!list.length) hits.delete(key);
    }
  }

  return {
    hit(key) {
      const t = now();
      sweep(t);
      let list = hits.get(key);
      if (!list) hits.set(key, (list = []));
      prune(list, t);
      if (list.length >= max) return Math.max(1, list[0] + windowMs - t);
      list.push(t);
      return 0;
    },
  };
}

function resolveRateLimit(rateLimit) {
  if (rateLimit === false || rateLimit === null) return null;
  if (typeof rateLimit === 'number') {
    return rateLimit > 0 ? { max: rateLimit, windowMs: DEFAULT_RATE_WINDOW_MS } : null;
  }
  if (Array.isArray(rateLimit)) {
    const max = Number(rateLimit[0]);
    const windowMs = Number(rateLimit[1] ?? DEFAULT_RATE_WINDOW_MS);
    return max > 0 && windowMs > 0 ? { max, windowMs } : null;
  }
  if (rateLimit && typeof rateLimit === 'object') {
    const max = Number(rateLimit.max ?? DEFAULT_RATE_MAX);
    const windowMs = Number(rateLimit.windowMs ?? DEFAULT_RATE_WINDOW_MS);
    return max > 0 && windowMs > 0 ? { max, windowMs } : null;
  }
  return { max: DEFAULT_RATE_MAX, windowMs: DEFAULT_RATE_WINDOW_MS };
}

function extractClientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers?.['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    if (typeof raw === 'string' && raw.trim()) {
      const first = raw.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress || 'unknown';
}

function decodeSegment(raw) {
  try {
    return { ok: true, value: decodeURIComponent(raw) };
  } catch {
    return { ok: false, value: '' };
  }
}

function decodeRawQueryParam(rawQuery, key) {
  if (!rawQuery) return { present: false, ok: true, value: '' };
  const query = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    const decodedKey = decodeSegment(rawKey.replace(/\+/g, ' '));
    if (!decodedKey.ok || decodedKey.value !== key) continue;
    const rawVal = eq === -1 ? '' : part.slice(eq + 1);
    const decodedVal = decodeSegment(rawVal.replace(/\+/g, ' '));
    if (!decodedVal.ok) return { present: true, ok: false, value: '' };
    return { present: true, ok: true, value: decodedVal.value };
  }
  return { present: false, ok: true, value: '' };
}

function parseClampedInt(raw, min, max) {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  const i = Math.trunc(n);
  if (max !== undefined) return Math.min(max, Math.max(min, i));
  return Math.max(min, i);
}

function parseSearchString(raw, maxLen = MAX_QUERY_LEN) {
  if (raw == null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLen);
}

function normalizeCharacterName(raw) {
  const name = String(raw ?? '').trim();
  if (!name || [...name].length > MAX_NAME_LEN) return null;
  return name;
}

function resolveMissingComparePlayers(result, a, b) {
  if (result == null) return [a, b];
  if (Array.isArray(result.missing) && result.missing.length > 0) {
    return result.missing.map(String);
  }
  if ('a' in result || 'b' in result) {
    const missing = [];
    if (!result.a) missing.push(a);
    if (!result.b) missing.push(b);
    if (missing.length) return missing;
  }
  if ('playerA' in result || 'playerB' in result) {
    const missing = [];
    if (!result.playerA) missing.push(a);
    if (!result.playerB) missing.push(b);
    if (missing.length) return missing;
  }
  return null;
}

/**
 * Creates the public read-only HTTP handler for `/api/hiscores*`.
 *
 * @param {object} engine - Hiscores engine with getCategories, getOrders, getPlayer, comparePlayers, getBoard.
 * @param {object} [options]
 * @param {string} [options.corsOrigin] - Optional Access-Control-Allow-Origin value.
 * @param {object|number|Array|false} [options.rateLimit] - Sliding-window rate limit (default 120 req/min per IP).
 * @param {boolean} [options.trustProxy=false] - Trust X-Forwarded-For for client IP extraction.
 * @param {() => number} [options.now] - Clock function for rate limiting (defaults to Date.now).
 * @param {(err: Error) => void} [options.onError] - Optional error logger override.
 */
export function createHiscoresHttpHandler(engine, options = {}) {
  const trustProxy = Boolean(options.trustProxy);
  const corsOrigin = typeof options.corsOrigin === 'string' && options.corsOrigin.trim()
    ? options.corsOrigin.trim()
    : null;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const rateCfg = resolveRateLimit(options.rateLimit);
  const limiter = rateCfg ? createSlidingWindowLimiter(rateCfg.max, rateCfg.windowMs, now) : null;
  const logError = typeof options.onError === 'function'
    ? options.onError
    : (err) => console.error('[hiscores] request failed:', err?.message ?? String(err));

  function sendJson(req, res, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    const headers = {
      'Content-Type': JSON_CONTENT_TYPE,
      'Content-Length': Buffer.byteLength(body),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': status === 200 ? CACHE_OK : CACHE_ERROR,
      ...extraHeaders,
    };
    if (corsOrigin) {
      headers['Access-Control-Allow-Origin'] = corsOrigin;
      if (corsOrigin !== '*') headers.Vary = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  return async function handleHiscoresHttp(req, res) {
    if (limiter) {
      const ip = extractClientIp(req, trustProxy);
      const retryMs = limiter.hit(ip);
      if (retryMs > 0) {
        const retryAfter = Math.max(1, Math.ceil(retryMs / 1000));
        return sendJson(
          req,
          res,
          429,
          { error: 'rate limit exceeded', retryAfter },
          { 'Retry-After': String(retryAfter) }
        );
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(
        req,
        res,
        405,
        { error: 'method not allowed' },
        { Allow: ALLOWED_METHODS }
      );
    }

    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return sendJson(req, res, 400, { error: 'invalid url' });
    }

    const pathname = url.pathname;
    if (!isHiscoresPath(pathname)) {
      return sendJson(req, res, 404, { error: 'not found' });
    }

    const sub = pathname.slice(HISCORES_PATH.length);

    try {
      // GET /api/hiscores or GET /api/hiscores/
      if (sub === '' || sub === '/') {
        const board = (url.searchParams.get('board') ?? '').trim() || 'overall';
        return await handleBoard(req, res, url.searchParams, board);
      }

      // GET /api/hiscores/categories
      if (sub === '/categories') {
        const data = await engine.getCategories();
        return sendJson(req, res, 200, data);
      }

      // GET /api/hiscores/orders
      if (sub === '/orders') {
        const rawSort = url.searchParams.get('sort');
        let sort;
        if (rawSort != null && rawSort.trim() !== '') {
          const normalized = rawSort.trim().toLowerCase();
          if (!ORDER_SORTS.has(normalized)) {
            return sendJson(req, res, 400, {
              error: 'invalid sort',
              allowed: [...ORDER_SORTS],
            });
          }
          sort = normalized;
        }
        const page = parseClampedInt(url.searchParams.get('page'), 1);
        const limit = parseClampedInt(url.searchParams.get('limit'), 1, 100);
        const q = parseSearchString(url.searchParams.get('q'));
        const params = {};
        if (sort !== undefined) params.sort = sort;
        if (page !== undefined) params.page = page;
        if (limit !== undefined) params.limit = limit;
        if (q !== undefined) params.query = q;
        const data = await engine.getOrders(params);
        return sendJson(req, res, 200, data);
      }

      // GET /api/hiscores/player?name=...
      if (sub === '/player') {
        const rawName = decodeRawQueryParam(url.search, 'name');
        if (!rawName.ok) {
          return sendJson(req, res, 400, { error: 'invalid character name encoding' });
        }
        const name = normalizeCharacterName(rawName.present ? rawName.value : '');
        if (!name) {
          return sendJson(req, res, 400, { error: 'invalid character name' });
        }
        const player = await engine.getPlayer(name);
        if (player == null) {
          return sendJson(req, res, 404, { error: 'character not found' });
        }
        return sendJson(req, res, 200, player);
      }

      // GET /api/hiscores/player/:name
      if (sub.startsWith('/player/')) {
        const rawSegment = sub.slice('/player/'.length);
        if (rawSegment.includes('/')) {
          return sendJson(req, res, 404, { error: 'not found' });
        }
        const decoded = decodeSegment(rawSegment);
        if (!decoded.ok) {
          return sendJson(req, res, 400, { error: 'invalid character name encoding' });
        }
        const name = normalizeCharacterName(decoded.value);
        if (!name) {
          return sendJson(req, res, 400, { error: 'invalid character name' });
        }
        const player = await engine.getPlayer(name);
        if (player == null) {
          return sendJson(req, res, 404, { error: 'character not found' });
        }
        return sendJson(req, res, 200, player);
      }

      // GET /api/hiscores/compare?a=...&b=...
      if (sub === '/compare') {
        const rawA = decodeRawQueryParam(url.search, 'a');
        const rawB = decodeRawQueryParam(url.search, 'b');
        if (!rawA.ok || !rawB.ok) {
          return sendJson(req, res, 400, { error: 'invalid character name encoding' });
        }
        const a = normalizeCharacterName(rawA.present ? rawA.value : '');
        const b = normalizeCharacterName(rawB.present ? rawB.value : '');
        if (!a || !b) {
          return sendJson(req, res, 400, { error: 'both a and b parameters are required' });
        }
        let comparison;
        try {
          comparison = await engine.comparePlayers(a, b);
        } catch (err) {
          if (err?.code === 'PLAYER_NOT_FOUND' || err?.code === 'NOT_FOUND') {
            const missing = Array.isArray(err.missing)
              ? err.missing
              : err.player
                ? [err.player]
                : [a, b];
            return sendJson(req, res, 404, {
              error: `character not found: ${missing.join(', ')}`,
              missing,
            });
          }
          throw err;
        }
        const missing = resolveMissingComparePlayers(comparison, a, b);
        if (missing) {
          return sendJson(req, res, 404, {
            error: `character not found: ${missing.join(', ')}`,
            missing,
          });
        }
        return sendJson(req, res, 200, comparison);
      }

      // GET /api/hiscores/board/:board
      if (sub.startsWith('/board/')) {
        const rawSegment = sub.slice('/board/'.length);
        if (rawSegment.includes('/')) {
          return sendJson(req, res, 404, { error: 'not found' });
        }
        const decoded = decodeSegment(rawSegment);
        if (!decoded.ok) {
          return sendJson(req, res, 400, { error: 'invalid board encoding' });
        }
        const board = decoded.value.trim();
        if (!board) {
          return sendJson(req, res, 400, { error: 'unknown board', board: '' });
        }
        return await handleBoard(req, res, url.searchParams, board);
      }

      return sendJson(req, res, 404, { error: 'not found' });
    } catch (err) {
      logError(err);
      if (!res.headersSent) {
        return sendJson(req, res, 500, { error: 'hiscores unavailable' });
      }
      if (!res.writableEnded) res.end();
    }
  };

  async function handleBoard(req, res, searchParams, board) {
    const page = parseClampedInt(searchParams.get('page'), 1);
    const limit = parseClampedInt(searchParams.get('limit'), 1, 100);
    const className = parseSearchString(searchParams.get('class') ?? searchParams.get('className'));
    const race = parseSearchString(searchParams.get('race'));
    const q = parseSearchString(searchParams.get('q'));

    const params = { board };
    if (page !== undefined) params.page = page;
    if (limit !== undefined) params.limit = limit;
    if (className !== undefined) params.className = className;
    if (race !== undefined) params.race = race;
    if (q !== undefined) params.query = q;

    try {
      const data = await engine.getBoard(params);
      return sendJson(req, res, 200, data);
    } catch (err) {
      if (err?.code === 'UNKNOWN_BOARD') {
        return sendJson(req, res, 400, { error: 'unknown board', board });
      }
      throw err;
    }
  }
}

const defaultHandlers = new WeakMap();

/**
 * Convenience single-request entrypoint for `/api/hiscores*`.
 * Reuses a per-engine handler when `options` is omitted so rate limiting persists across calls.
 */
export function handleHiscoresRequest(req, res, engine, options) {
  if (options === undefined && engine && typeof engine === 'object') {
    let handler = defaultHandlers.get(engine);
    if (!handler) {
      handler = createHiscoresHttpHandler(engine);
      defaultHandlers.set(engine, handler);
    }
    return handler(req, res);
  }
  return createHiscoresHttpHandler(engine, options)(req, res);
}
