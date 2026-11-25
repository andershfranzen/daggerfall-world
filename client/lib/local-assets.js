// Localhost convenience: when /play.html is opened on a loopback origin of a server that has the
// operator's Daggerfall ARENA2 installed (server/local-assets.js), adopt those files without the
// player choosing a folder. Only metadata is fetched up front; bytes are read lazily, per range,
// when a game reader asks for them. Public origins never call the server route.
//
// The File-like objects satisfy what the readers use (client/world/files.js, bsa.js, gameplay/*):
// name, size, lastModified, webkitRelativePath, slice(start, end) and arrayBuffer().

const ROUTE = '/local-assets/';
const HEADER = 'X-DFW-Local-Assets';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const CACHE_BUDGET = 96 * 1024 * 1024; // whole-file reads kept for re-use (textures, palettes)
const CACHE_MAX_FILE = 16 * 1024 * 1024;

/** True when this page is a plain-http loopback origin (the only place discovery is attempted). */
export function isLoopbackPage(loc = globalThis.location) {
  return !!loc && loc.protocol === 'http:' && LOOPBACK.has(loc.hostname);
}

function clampIndex(v, size, fallback) {
  if (v === undefined) return fallback;
  v = Math.trunc(Number(v)) || 0;
  return v < 0 ? Math.max(size + v, 0) : Math.min(v, size);
}

class Source {
  constructor(fetchImpl, token) {
    this.fetch = fetchImpl;
    this.token = token;
    this.cache = new Map(); // name -> Promise<ArrayBuffer>
    this.cached = 0;
  }

  async read(name, start, end, total) {
    if (end <= start) return new ArrayBuffer(0);
    const whole = start === 0 && end === total;
    if (whole && this.cache.has(name)) return (await this.cache.get(name)).slice(0);
    const p = this.request(name, start, end, whole);
    if (whole && total <= CACHE_MAX_FILE && this.cached + total <= CACHE_BUDGET) {
      this.cached += total;
      this.cache.set(name, p);
      p.catch(() => { this.cache.delete(name); this.cached -= total; });
      return (await p).slice(0);
    }
    return p;
  }

  async request(name, start, end, whole) {
    const headers = { [HEADER]: this.token };
    if (!whole) headers.Range = `bytes=${start}-${end - 1}`;
    // Names are validated 8.3 game names (letters, digits, _ - $ .), sent unencoded like the server expects.
    const res = await this.fetch(`${ROUTE}file/${name}`, {
      headers, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error',
    });
    if (res.status !== (whole ? 200 : 206)) throw new Error(`${name}: installed file read failed (HTTP ${res.status})`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength !== end - start) throw new Error(`${name}: short read from installed files`);
    return buf;
  }
}

/** A lazily read slice of an installed game file. */
class LocalBlob {
  constructor(source, name, start, end, total, type = '') {
    this._s = source; this._name = name; this._start = start; this._end = end; this._total = total;
    this.type = type;
  }
  get size() { return this._end - this._start; }
  slice(start, end, type = '') {
    const n = this.size;
    const a = clampIndex(start, n, 0);
    const b = Math.max(a, clampIndex(end, n, n));
    return new LocalBlob(this._s, this._name, this._start + a, this._start + b, this._total, type);
  }
  arrayBuffer() { return this._s.read(this._name, this._start, this._end, this._total); }
  async bytes() { return new Uint8Array(await this.arrayBuffer()); }
  async text() { return new TextDecoder().decode(await this.arrayBuffer()); }
  stream() {
    const self = this;
    return new ReadableStream({ async start(c) { c.enqueue(await self.bytes()); c.close(); } });
  }
}

/** File-like view of one installed ARENA2 file. */
export class LocalFile extends LocalBlob {
  constructor(source, { name, size, mtime }, dir = 'arena2') {
    super(source, name, 0, size, size);
    this.name = name;
    this.lastModified = Number(mtime) || 0;
    this.webkitRelativePath = `${dir}/${name}`;
    this.installed = true;
  }
}

/**
 * Ask the same-origin server for its installed ARENA2 listing.
 * @returns {Promise<null | { files: LocalFile[], dir: string }>} null when unavailable here.
 */
export async function discoverInstalledArena2({ fetch: fetchImpl = globalThis.fetch?.bind(globalThis), location: loc = globalThis.location, signal } = {}) {
  if (!fetchImpl || !isLoopbackPage(loc)) return null;
  let res;
  try {
    res = await fetchImpl(`${ROUTE}manifest`, {
      headers: { [HEADER]: 'manifest' }, credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal,
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body;
  try { body = await res.json(); } catch { return null; }
  if (!body || typeof body.token !== 'string' || !Array.isArray(body.files)) return null;
  const source = new Source(fetchImpl, body.token);
  const dir = typeof body.dir === 'string' && /^[\w-]{1,32}$/.test(body.dir) ? body.dir : 'arena2';
  const files = body.files
    .filter((f) => f && typeof f.name === 'string' && /^\$?[\w-]{1,16}\.\w{1,3}$/.test(f.name) && Number.isSafeInteger(f.size) && f.size >= 0)
    .map((f) => new LocalFile(source, f, dir));
  return files.length ? { files, dir } : null;
}
