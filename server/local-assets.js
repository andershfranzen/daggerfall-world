// Development convenience: lets /play.html on a real loopback origin read the operator's
// already installed ARENA2 folder without the player choosing (or uploading) anything.
//
// This is NOT a static root and never publishes game data. Every request must pass all of:
//   - the feature is enabled: bound to a loopback host, no reverse proxy (TRUST_PROXY),
//     no PUBLIC_ORIGIN, no REQUIRE_HTTPS, not NODE_ENV=production, LOCAL_ASSETS not off;
//   - the TCP connection is loopback on both ends (actual socket, not configuration);
//   - no forwarding headers (Forwarded, X-Forwarded-*, X-Real-IP, Via, ...);
//   - Host is exactly localhost / 127.0.0.1 / [::1] with the real listening port, so an
//     Internet hostname resolved to 127.0.0.1 (DNS rebinding) is refused;
//   - Origin (when sent) equals http://<Host>; Sec-Fetch-Site (when sent) is same-origin;
//     Sec-Fetch-Mode is not a navigation and Sec-Fetch-Dest is empty (no <img>, <iframe>, ...);
//   - a custom X-DFW-Local-Assets header, which no navigation, embed or simple cross-origin
//     request can carry (it forces a CORS preflight this route never approves). File reads
//     additionally need the per-process token returned by the manifest.
// Files: regular top-level files of the ARENA2 directory only, matched by an allow-list of
// Daggerfall file names. Symlinks, subdirectories, encoded or traversing paths are refused.
//
// Routes (GET/HEAD only):
//   /local-assets/manifest       -> { dir: 'arena2', token, files: [{ name, size, mtime }] }
//   /local-assets/file/<NAME>    -> bytes, with single-range support (Range: bytes=a-b)
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { serializeCustomPrefab } from '../client/world/wilderness/models.js';
import { constants as FS, realpathSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PREFIX = '/local-assets/';
export const HEADER = 'x-dfw-local-assets';
export const MANIFEST_VALUE = 'manifest';

// Default location for a localhost run from this checkout (ignored by git and Docker).
export const CHECKOUT_ARENA2 = fileURLToPath(new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url));

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const HOST_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORWARD_HEADERS = [
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port',
  'x-forwarded-server', 'x-real-ip', 'via', 'x-client-ip', 'client-ip', 'true-client-ip',
  'cf-connecting-ip', 'fastly-client-ip', 'x-cluster-client-ip', 'x-original-host', 'x-host',
];
// Daggerfall ARENA2 content. 8.3 names; numbered extensions (TEXTURE.000, ...) included.
const EXTENSIONS = new Set([
  'BSA', 'CIF', 'RCI', 'IMG', 'CFA', 'COL', 'PAL', 'PAK', 'DAT', 'CFG', 'TXT', 'FNT', 'RAW',
  'LGT', 'CEL', 'BSS', 'GFX', 'WLD', 'TDE', 'TBL', 'STD', 'SND', 'RSC', 'DEF', 'BIN', 'QBN',
  'QRC', 'VID', 'FLC', 'HMI', 'MID', 'AMF', 'DAG', 'SPL', 'TEX', 'MNU', 'FAC', 'SAV',
]);
// Optional leading '$' for the original quest scripts ($CUREVAM.QBN, $CUREWER.QRC, ...).
const NAME_RE = /^\$?[A-Za-z0-9_][A-Za-z0-9_-]{0,15}\.([A-Za-z0-9]{1,3})$/;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MANIFEST_TTL_MS = 2000;

/** True for a name this route may ever serve. */
export function isKnownGameFile(name) {
  if (typeof name !== 'string') return false;
  const m = NAME_RE.exec(name);
  if (!m) return false;
  const ext = m[1].toUpperCase();
  return EXTENSIONS.has(ext) || /^\d{3}$/.test(ext);
}

export function isLoopbackAddress(addr) {
  if (typeof addr !== 'string') return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function within(root, p) {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Decide whether the feature may run and which directory it uses.
 * @returns {{ enabled: boolean, dir: string|null, reason: string }}
 */
export function resolveLocalAssets({
  arena2Dir = null, autoDir = CHECKOUT_ARENA2, host, trustProxy = false, publicOrigin = null,
  requireHttps = false, env = process.env, publicRoots = [], dev = false,
} = {}) {
  const off = (reason) => ({ enabled: false, dir: null, reason });
  const flag = String(env.LOCAL_ASSETS ?? '').toLowerCase();
  if (/^(0|false|no|off)$/.test(flag)) return off('LOCAL_ASSETS is off');
  if (env.NODE_ENV === 'production' && !dev) return off('NODE_ENV=production');
  if (!LOOPBACK_HOSTS.has(String(host ?? ''))) return off(`bound to non-loopback host ${host}`);
  if (trustProxy) return off('TRUST_PROXY is set (behind a reverse proxy)');
  if (publicOrigin) return off('PUBLIC_ORIGIN is set');
  if (requireHttps) return off('REQUIRE_HTTPS is set');
  let dir = null;
  for (const cand of arena2Dir ? [arena2Dir] : [autoDir, autoDir && autoDir.replace(/arena2[\\/]?$/, 'ARENA2')]) {
    if (!cand) continue;
    try {
      const real = realpathSync(resolve(cand));
      if (!statSync(real).isDirectory()) continue;
      dir = real;
      // ARENA2_DIR may name the install folder that contains ARENA2.
      for (const sub of ['arena2', 'ARENA2', 'Arena2']) {
        try {
          const inner = realpathSync(join(real, sub));
          if (within(real, inner) && statSync(inner).isDirectory()) { dir = inner; break; }
        } catch {}
      }
      break;
    } catch {}
  }
  if (!dir) return off(arena2Dir ? `ARENA2 directory ${arena2Dir} is unreadable` : 'no ARENA2_DIR and no gamedata/DaggerfallGameFiles/arena2 in this checkout');
  for (const r of publicRoots) {
    let root;
    try { root = realpathSync(r); } catch { continue; }
    if (dir === root || within(root, dir) || within(dir, root)) return off(`ARENA2 directory overlaps a public root (${root})`);
  }
  return { enabled: true, dir, reason: arena2Dir ? 'ARENA2_DIR' : 'checkout gamedata' };
}

/** Parses a Host header into { name, port } or null. */
function parseHost(h) {
  if (typeof h !== 'string' || h.length > 64) return null;
  const m = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/.exec(h);
  if (!m) return null;
  return { name: m[1], port: m[2] ?? null };
}

/** Returns null when the request may use the route, else a short refusal reason. */
export function refusal(req, { requireToken = null } = {}) {
  const sock = req.socket ?? {};
  if (!isLoopbackAddress(sock.remoteAddress) || !isLoopbackAddress(sock.localAddress)) return 'not a loopback connection';
  for (const h of FORWARD_HEADERS) if (req.headers[h] !== undefined) return 'forwarded request';
  const host = parseHost(req.headers.host);
  if (!host || !HOST_NAMES.has(host.name)) return 'host is not a loopback name';
  const localPort = String(sock.localPort ?? '');
  if ((host.port ?? '80') !== localPort) return 'host port does not match the listening port';
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${req.headers.host}`) return 'cross-origin';
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return 'cross-site';
  const mode = req.headers['sec-fetch-mode'];
  if (mode !== undefined && mode !== 'cors' && mode !== 'same-origin') return 'not a fetch';
  const dest = req.headers['sec-fetch-dest'];
  if (dest !== undefined && dest !== 'empty') return 'not a fetch';
  const marker = req.headers[HEADER];
  if (typeof marker !== 'string') return 'missing local-assets header';
  if (requireToken !== null && marker !== requireToken) return 'bad local-assets token';
  return null;
}

function send(req, res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length, ...headers });
  res.end(req.method === 'HEAD' ? undefined : buf);
}

const BASE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  Vary: 'Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest, X-DFW-Local-Assets',
});

/** Parses a single `bytes=` range against `size`. Returns {start, end} (inclusive), null (none) or 'bad'. */
export function parseRange(header, size) {
  if (header === undefined) return null;
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'bad';
  let start, end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || end < start) return 'bad';
  return { start, end };
}

/**
 * @param {object} opts see resolveLocalAssets(); `log` receives one line describing the state.
 */
export function createLocalAssets(opts = {}) {
  const state = resolveLocalAssets(opts);
  const token = randomBytes(24).toString('base64url');
  let listing = null; // { at, files: Map<UPPER, {name, size, mtime, path}> }

  async function scan() {
    if (listing && Date.now() - listing.at < MANIFEST_TTL_MS) return listing.files;
    const files = new Map();
    const dir = await realpath(state.dir);
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      if (files.size >= MAX_FILES) break;
      if (!ent.isFile() || !isKnownGameFile(ent.name)) continue; // symlinks and dirs are skipped here
      const path = join(dir, ent.name);
      let st;
      try { st = await lstat(path); } catch { continue; }
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const key = ent.name.toUpperCase();
      if (files.has(key)) continue; // case-variant duplicates: keep the first, deterministically
      files.set(key, { name: ent.name, size: st.size, mtime: Math.round(st.mtimeMs), path, ino: st.ino, dev: st.dev });
    }
    listing = { at: Date.now(), files };
    return files;
  }

  async function manifest(req, res) {
    const files = await scan();
    const body = JSON.stringify({
      dir: 'arena2',
      token,
      files: [...files.values()].map(({ name, size, mtime }) => ({ name, size, mtime })),
    });
    send(req, res, 200, body, { 'Content-Type': 'application/json; charset=utf-8' });
  }

  async function file(req, res, rawName) {
    // Raw (undecoded) path segment: plain 8.3 names only, so %-encoding, dots and slashes never match.
    if (!isKnownGameFile(rawName)) return send(req, res, 404, 'Not Found');
    let files = await scan();
    let entry = files.get(rawName.toUpperCase());
    if (!entry) { listing = null; files = await scan(); entry = files.get(rawName.toUpperCase()); }
    if (!entry) return send(req, res, 404, 'Not Found');
    let fh;
    try {
      fh = await open(entry.path, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0));
      const st = await fh.stat();
      const real = await realpath(entry.path);
      if (!st.isFile() || st.ino !== entry.ino || st.dev !== entry.dev || !within(state.dir, real)) {
        listing = null;
        return send(req, res, 409, 'Changed on disk');
      }
      const size = st.size;
      const range = parseRange(req.headers.range, size);
      if (range === 'bad') return send(req, res, 416, 'Range Not Satisfiable', { 'Content-Range': `bytes */${size}` });
      const start = range ? range.start : 0;
      const end = range ? range.end : size - 1;
      const length = size === 0 ? 0 : end - start + 1;
      const headers = {
        ...BASE_HEADERS,
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment',
        'Content-Length': length,
        'Accept-Ranges': 'bytes',
        'Last-Modified': new Date(st.mtimeMs).toUTCString(),
      };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD' || length === 0) return res.end();
      await pipeline(fh.createReadStream({ start, end }), res);
    } catch (err) {
      if (!res.headersSent) send(req, res, err.code === 'ELOOP' ? 404 : 500, err.code === 'ELOOP' ? 'Not Found' : 'Read failed');
      else res.destroy();
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  return {
    enabled: state.enabled,
    dir: state.dir,
    reason: state.reason,
    /** True when `path` belongs to this route (whether or not it is enabled). */
    owns(path) {
      return path === PREFIX.slice(0, -1) || path.startsWith(PREFIX);
    },
    /** Handles any /local-assets/ request. Never falls through to static delivery. */
    async handle(req, res) {
      const rawPath = String(req.url ?? '').split('?')[0];
      if (!state.enabled) return send(req, res, 404, 'Not Found');
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(req, res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' }); // no CORS preflight approval
      }
      const rest = rawPath.slice(PREFIX.length);
      if (opts.wodAssets && (rest === 'wod/model' || rest === 'wod/texture')) {
        if (refusal(req, { requireToken: token })) return send(req, res, 403, 'Forbidden');
        const params = new URL(req.url, 'http://localhost').searchParams;
        if (rest === 'wod/model') {
          const model = await opts.wodAssets.model(params.get('name'), {
            climate: Number(params.get('climate')), winter: params.get('winter') === '1',
            region: (params.get('region') ?? '').slice(0, 64),
          });
          if (!model) return send(req, res, 404, 'Model unavailable');
          const json = JSON.stringify(serializeCustomPrefab(model));
          return send(req, res, 200, json, { 'Content-Type': 'application/json' });
        }
        const png = await opts.wodAssets.texture(params.get('path'));
        if (!png) return send(req, res, 404, 'Texture unavailable');
        return send(req, res, 200, Buffer.from(png), { 'Content-Type': 'image/png' });
      }
      if (rest === 'manifest') {
        const why = refusal(req);
        if (why || req.headers[HEADER] !== MANIFEST_VALUE) return send(req, res, 403, 'Forbidden');
        return manifest(req, res);
      }
      if (rest.startsWith('file/')) {
        if (refusal(req, { requireToken: token })) return send(req, res, 403, 'Forbidden');
        return file(req, res, rest.slice(5));
      }
      return send(req, res, 404, 'Not Found');
    },
  };
}

