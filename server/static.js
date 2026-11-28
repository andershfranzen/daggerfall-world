// Static file delivery rooted strictly in allow-listed directories.
// Only allow-listed extensions are served; dotfiles, traversal and symlinks escaping a root are refused.
//
// Two roots share one origin (see server/README.md, "Routing"):
//   - the game client (client/): exact files only, e.g. /play.html, /main.js, /hud/*.js
//   - the exported website (website/out/): /, /guide/, /development/, /_next/*, RSC payloads, 404.html
import { realpathSync } from 'node:fs';
import { realpath, stat, open } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.xml': 'application/xml; charset=utf-8',
};

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const IMMUTABLE = 'public, max-age=31536000, immutable';
// Unversioned game client scripts and styles must bypass CDN/browser TTL overrides (e.g. Cloudflare's
// default 4-hour Browser Cache TTL on .js/.css) so players receive fixes immediately after a deploy.
const CLIENT_NO_STORE = 'no-store, must-revalidate';

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(res.req.method === 'HEAD' ? undefined : body);
}

// Decodes and validates a request path. Returns { pathname, segments, search } or a numeric status.
export function parseRequestPath(url) {
  let parsed, pathname;
  if (typeof url !== 'string' || !url.startsWith('/')) return 400;
  try {
    parsed = new URL('http://x' + url); // origin-form only; '//host/x' stays a path
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return 400;
  }
  // Trailing '' segment is allowed (directory-style URL like /guide/); empty inner segments are not.
  const segments = pathname.split('/').slice(1);
  const inner = pathname.endsWith('/') ? segments.slice(0, -1) : segments;
  if (
    pathname.includes('\0') ||
    pathname.includes('\\') ||
    inner.some((s) => s === '' || s.startsWith('.'))
  ) {
    return 404;
  }
  return { pathname, rawPathname: parsed.pathname, segments: inner, search: parsed.search, dirStyle: pathname.endsWith('/') };
}

// A single directory root. lookup(segments) resolves to a regular file inside the root, or null.
export function createStaticRoot(dir, label = 'static') {
  let root = null;
  try {
    root = realpathSync(dir);
  } catch {
    console.warn(`[${label}] directory not found: ${dir} (requests for it will 404)`);
  }
  return {
    get exists() {
      return root !== null;
    },
    dir,
    async lookup(segments) {
      if (!root || segments.length === 0) return null;
      const type = MIME[extname(segments.at(-1)).toLowerCase()];
      if (!type) return null;
      const candidate = resolve(root, ...segments);
      if (!candidate.startsWith(root + sep)) return null;
      try {
        const real = await realpath(candidate);
        if (!real.startsWith(root + sep)) return null;
        const st = await stat(real);
        if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
        return { path: real, type };
      } catch {
        return null;
      }
    },
  };
}

async function sendFile(req, res, file, status = 200, cacheControl = 'no-cache', extraHeaders = {}) {
  let fh;
  try {
    fh = await open(file.path, 'r');
    const data = await fh.readFile();
    res.writeHead(status, {
      'Content-Type': file.type,
      'Content-Length': data.length,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...extraHeaders,
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    if (!res.headersSent) sendText(res, 404, 'Not Found');
    else res.end();
  } finally {
    await fh?.close();
  }
}

function methodOk(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  res.setHeader('Allow', 'GET, HEAD');
  sendText(res, 405, 'Method Not Allowed');
  return false;
}

// Backwards-compatible single-root handler: `/` serves index.html, everything else exact files.
export function createStaticHandler(clientDir) {
  const client = createStaticRoot(clientDir, 'static');
  return async function handle(req, res) {
    if (!methodOk(req, res)) return;
    const p = parseRequestPath(req.url);
    if (typeof p === 'number') return sendText(res, p, p === 400 ? 'Bad Request' : 'Not Found');
    if (p.dirStyle && p.segments.length > 0) return sendText(res, 404, 'Not Found');
    const file = await client.lookup(p.segments.length ? p.segments : ['index.html']);
    if (!file) return sendText(res, 404, 'Not Found');
    return sendFile(req, res, file, 200, CLIENT_NO_STORE, { 'CDN-Cache-Control': 'no-store' });
  };
}

// Production handler: game client files first (exact match, no directory index), then the
// exported Next.js site with directory indexes, trailing-slash redirects and its 404 page.
//
// `fallback(req, res)` (dev mode) replaces the exported site: anything the game client does not
// serve is handed to the Next.js dev server instead.
export function createSiteHandler({ clientDir, siteDir, fallback = null }) {
  const client = clientDir ? createStaticRoot(clientDir, 'client') : null;
  const site = fallback ? null : createStaticRoot(siteDir, 'website');

  async function notFound(req, res) {
    const page = site && (await site.lookup(['404.html']));
    if (page) return sendFile(req, res, page, 404);
    return sendText(res, 404, 'Not Found');
  }

  return async function handle(req, res) {
    if (!fallback && !methodOk(req, res)) return;
    const p = parseRequestPath(req.url);
    if (typeof p === 'number') return sendText(res, p, p === 400 ? 'Bad Request' : 'Not Found');

    // 1. Game client: exact files only (never a directory index, so client/index.html cannot shadow /).
    if (client && !p.dirStyle && (!fallback || req.method === 'GET' || req.method === 'HEAD')) {
      const file = await client.lookup(p.segments);
      if (file) return sendFile(req, res, file, 200, CLIENT_NO_STORE, { 'CDN-Cache-Control': 'no-store' });
    }

    // 2. Dev: Next.js dev server handles the website, HMR assets and its own 404s.
    if (fallback) return fallback(req, res);

    if (client && !site.exists && p.pathname === '/') {
      return sendText(res, 302, 'Found', { Location: '/play.html' });
    }
    // Optional website export supplied by the operator.
    if (p.dirStyle) {
      const page = await site.lookup([...p.segments, 'index.html']);
      return page ? sendFile(req, res, page) : notFound(req, res);
    }
    const file = await site.lookup(p.segments);
    if (file) {
      const immutable = p.segments[0] === '_next' && p.segments[1] === 'static';
      return sendFile(req, res, file, 200, immutable ? IMMUTABLE : 'no-cache');
    }
    // trailingSlash: true — /guide redirects to /guide/ when that page exists.
    if (await site.lookup([...p.segments, 'index.html'])) {
      const location = p.rawPathname + '/' + p.search;
      return sendText(res, 308, 'Permanent Redirect', { Location: location });
    }
    return notFound(req, res);
  };
}
