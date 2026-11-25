// Outdoor streaming (docs/world-expansion-plan.md, brief D): one bounded cache of exterior
// scenes, the plan that composes them around the current location, and the frame shift that
// keeps the view still when the server moves the player across an outdoor boundary.
//
// Keys are location ids: `wilderness:<px>,<py>` for a map pixel scene (buildWildernessScene,
// 7×7 terrain with the 3×3 gameplay cells), and the catalogue id of a classic town
// (`town:Region/Name`, loadTown). DOM-free; the builders are injected so Node tests can drive it.
//
// Anchors put every scene on one absolute surface (client/world/exterior/frame.js):
//   wilderness  (px·P + H,       datum,         py·P + H)
//   town        (px·P + H + dx,  elevation,     py·P + H + dz)   townFrame(placement + spawnLocal)
// A mesh drawn in the frame of location V is translated by anchor(mesh) − anchor(V). A point
// p in the old frame is p + anchor(old) − anchor(new) in the new one.
import { HALF, PIXEL, townFrame } from './frame.js';
import { parseWildernessLocation, wildernessLocation } from '../wilderness/scene.js';

export const LIMITS = Object.freeze({ wild: 4, town: 6 });
/** Unpinned scenes unused for this long are dropped at the next sweep. */
export const IDLE_MS = 45000;
/** Prefetch a neighbouring pixel when the player is this close to its edge. */
export const PREFETCH_EDGE = 300;

const cancelled = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });
const kindOf = (key) => (parseWildernessLocation(key) ? 'wild' : 'town');

export class ExteriorStream {
  /**
   * @param {object} o
   * @param {(key:string, ctrl:{aborted:boolean}) => Promise<object>} o.buildWild
   * @param {(key:string, placement:object|null, ctrl:{aborted:boolean}) => Promise<object>} o.buildTown
   * @param {(key:string) => {px:number, py:number}|null} [o.townPixel] - a town id's pixel before any wild scene names it
   * @param {(mesh:object, key:string) => void} [o.onEvict]
   * @param {(key:string, mesh:object) => void} [o.onReady]
   */
  constructor({ buildWild, buildTown, townPixel = () => null, onEvict = () => {}, onReady = () => {}, limits = LIMITS, idleMs = IDLE_MS, now = () => performance.now() }) {
    Object.assign(this, { buildWild, buildTown, townPixel, onEvict, onReady, limits, idleMs, now });
    this.entries = new Map(); // key -> {key, kind, state, mesh, error, ctrl, used, priority, wanted}
    this.placements = new Map(); // town id -> placement from a wild scene's wilderness.towns
    this.sources = new Map(); // town id -> loadTown().source (kept after eviction: small)
    this.queue = [];
    this.running = null;
    this.pinned = new Set();
    this.log = []; // recent builds {key, at, ms, ok}
    this.counters = { built: 0, cancelled: 0, discarded: 0, failed: 0, evicted: 0, adopted: 0 };
  }

  // ------------------------------------------------------------------ cache

  ready(key) {
    const e = this.entries.get(key);
    if (e?.state !== 'ready') return null;
    e.used = this.now();
    return e.mesh;
  }

  /** Ask for a scene. Higher priority builds first; returns its promise (never rejects with AbortError for callers that ignore it). */
  request(key, priority = 0) {
    let e = this.entries.get(key);
    if (e && (e.state === 'ready' || e.state === 'loading' || e.state === 'queued')) {
      e.used = this.now();
      if (priority > e.priority) { e.priority = priority; this.sortQueue(); }
      return e.promise;
    }
    if (e?.state === 'error' && this.now() - e.failedAt < 15000) return e.promise;
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    promise.catch(() => {});
    e = { key, kind: kindOf(key), state: 'queued', mesh: null, error: null, ctrl: { aborted: false }, used: this.now(), priority, promise, resolve, reject };
    this.entries.set(key, e);
    this.queue.push(e);
    this.sortQueue();
    this.pump();
    return promise;
  }

  sortQueue() { this.queue.sort((a, b) => b.priority - a.priority || a.used - b.used); }

  async pump() {
    if (this.running) return;
    const e = this.queue.shift();
    if (!e) return;
    if (e.ctrl.aborted) { this.pump(); return; }
    this.running = e;
    e.state = 'loading';
    const began = this.now();
    let mesh = null, err = null;
    try {
      mesh = e.kind === 'wild'
        ? await this.buildWild(e.key, e.ctrl)
        : await this.buildTown(e.key, this.placements.get(e.key) ?? null, e.ctrl);
    } catch (x) { err = x; }
    this.running = null;
    this.log.push({ key: e.key, at: Math.round(began), ms: Math.round(this.now() - began), ok: !!mesh && !err });
    if (this.log.length > 64) this.log.shift();
    if (this.entries.get(e.key) !== e || e.ctrl.aborted) {
      // Dropped while building: a stale result is never shown.
      if (mesh) {
        this.counters.discarded++;
        this.onEvict(mesh, e.key);
      }
      e.reject(cancelled());
    } else if (err || !mesh) {
      if (err?.name === 'AbortError') { this.counters.cancelled++; this.entries.delete(e.key); e.reject(err); }
      else {
        this.counters.failed++;
        Object.assign(e, { state: 'error', error: err ?? new Error('no geometry'), failedAt: this.now() });
        e.reject(e.error);
      }
    } else {
      this.store(e, mesh);
      e.resolve(mesh);
      this.onReady(e.key, mesh);
    }
    this.enforce();
    this.pump();
  }

  store(e, mesh) {
    Object.assign(e, { state: 'ready', mesh, used: this.now() });
    this.counters.built++;
    this.learn(e.key, mesh);
  }

  learn(key, mesh) {
    for (const t of mesh.wilderness?.towns ?? []) if (t?.id) this.placements.set(t.id, t);
    if (kindOf(key) === 'town' && mesh.source?.spawnLocal) this.sources.set(key, mesh.source);
  }

  /** A scene another feature built for `key` (the town travel.js loaded, the starting town). */
  adopt(key, mesh) {
    if (!key || !mesh?.positions) return;
    const e = this.entries.get(key);
    if (e?.state === 'ready' && e.mesh === mesh) return;
    if (e && e.state !== 'ready') { e.ctrl.aborted = true; this.counters.cancelled++; }
    if (e?.state === 'ready' && e.mesh !== mesh) this.onEvict(e.mesh, key);
    const n = { key, kind: kindOf(key), state: 'ready', mesh, used: this.now(), priority: 0, promise: Promise.resolve(mesh), ctrl: { aborted: false } };
    this.entries.set(key, n);
    if (e?.resolve) e.resolve(mesh);
    this.counters.adopted++;
    this.learn(key, mesh);
    this.enforce();
  }

  /** Drop a ready scene nobody draws (its look is stale); the next request builds it again. */
  discard(key) {
    const e = this.entries.get(key);
    if (e?.state !== 'ready' || this.pinned.has(key)) return false;
    this.entries.delete(key);
    this.counters.evicted++;
    this.onEvict(e.mesh, key);
    return true;
  }

  /** Drop a failed record so the next request builds it again. */
  forget(key) {
    const e = this.entries.get(key);
    if (e?.state === 'error') this.entries.delete(key);
  }

  /** Scenes the current view draws or is waiting for; never evicted. */
  pin(keys) {
    this.pinned = new Set(keys);
    // Prefetches nobody wants any more stop before they start.
    for (const e of this.queue) if (!this.pinned.has(e.key) && e.priority > 0) e.priority = 0;
    this.sortQueue();
  }

  /** Cancel queued or running work outside `keep`. */
  cancelExcept(keep) {
    for (const e of [...this.entries.values()]) {
      if (keep.has(e.key) || e.state === 'ready' || e.state === 'error') continue;
      e.ctrl.aborted = true;
      this.entries.delete(e.key);
      this.counters.cancelled++;
      e.reject(cancelled());
    }
    this.queue = this.queue.filter((e) => !e.ctrl.aborted);
  }

  /** Keep each kind within its bound, oldest unpinned first; also drop idle scenes when `sweep`. */
  enforce(sweep = false) {
    const now = this.now();
    for (const kind of ['wild', 'town']) {
      const ready = [...this.entries.values()].filter((e) => e.kind === kind && e.state === 'ready' && !this.pinned.has(e.key));
      ready.sort((a, b) => a.used - b.used);
      const pinnedCount = [...this.pinned].filter((k) => kindOf(k) === kind && this.entries.get(k)?.state === 'ready').length;
      let excess = pinnedCount + ready.length - this.limits[kind];
      for (const e of ready) {
        if (excess > 0 || (sweep && now - e.used > this.idleMs)) {
          this.entries.delete(e.key);
          this.counters.evicted++;
          excess--;
          this.onEvict(e.mesh, e.key);
        }
      }
    }
    for (const [k, e] of this.entries) if (e.state === 'error' && now - e.failedAt > 60000) this.entries.delete(k);
  }

  clear() {
    for (const e of this.entries.values()) {
      e.ctrl.aborted = true;
      if (e.state === 'ready') this.onEvict(e.mesh, e.key);
      else e.reject?.(cancelled());
    }
    this.entries.clear();
    this.queue = [];
    this.pinned = new Set();
  }

  stats() {
    const out = { wild: 0, town: 0, loading: 0, queued: 0, failed: 0, pinned: this.pinned.size, limits: { ...this.limits }, cpuBytes: 0, keys: [], ...this.counters };
    for (const e of this.entries.values()) {
      if (e.state === 'ready') {
        out[e.kind]++;
        out.keys.push(e.key);
        const m = e.mesh;
        out.cpuBytes += (m.positions?.byteLength ?? 0) + (m.uv?.byteLength ?? 0) + (m.colors?.byteLength ?? 0) + (m.atlas?.pixels?.byteLength ?? 0);
      } else if (e.state === 'loading') out.loading++;
      else if (e.state === 'queued') out.queued++;
      else if (e.state === 'error') out.failed++;
    }
    return out;
  }

  // ------------------------------------------------------------------ frames

  /** The pixel a key stands in. */
  pixelOf(key) {
    const w = parseWildernessLocation(key);
    if (w) return w;
    const p = this.placements.get(key);
    if (p) return { px: p.px, py: p.py };
    return this.townPixel(key);
  }

  /**
   * Absolute anchor of a location's frame, or null while what defines it is unknown.
   * `{ y: null }` when only the horizontal placement is known (a pixel not yet built).
   */
  anchor(key) {
    const w = parseWildernessLocation(key);
    if (w) {
      const m = this.entries.get(key)?.state === 'ready' ? this.entries.get(key).mesh : null;
      return { e: w.px * PIXEL + HALF, s: w.py * PIXEL + HALF, y: m ? m.wilderness.datum : null };
    }
    const p = this.placements.get(key), src = this.sources.get(key);
    if (!p || !src) return null;
    const f = townFrame({ ...p, spawnLocal: src.spawnLocal });
    return { e: p.px * PIXEL + HALF + f.dx, s: p.py * PIXEL + HALF + f.dz, y: p.elevation };
  }

  /** Translation of `key`'s mesh into `view`'s frame, or null. */
  offset(key, view) {
    const a = this.anchor(key), b = this.anchor(view);
    if (!a || !b || a.y === null || b.y === null) return null;
    return [a.e - b.e, a.y - b.y, a.s - b.s];
  }

  /**
   * Shift that re-expresses a point of `from` in `to` (old + shift = new), for adjacent
   * outdoor locations. `provisional` when the destination height datum is not known yet.
   */
  crossing(from, to) {
    const pa = this.pixelOf(from), pb = this.pixelOf(to);
    if (!pa || !pb || Math.abs(pa.px - pb.px) > 1 || Math.abs(pa.py - pb.py) > 1) return null;
    const a = this.anchor(from), b = this.anchor(to);
    if (!a || !b || a.y === null) return null;
    return { x: a.e - b.e, y: b.y === null ? 0 : a.y - b.y, z: a.s - b.s, provisional: b.y === null };
  }

  /**
   * What to draw at `location`: the scenes needed (with priorities) and, for those ready,
   * their offsets into the location's frame. `at` is the player's position in that frame.
   */
  plan(location, at = null) {
    const kind = kindOf(location);
    const need = new Map(); // key -> priority
    const want = (k, p) => { if (k && (need.get(k) ?? -1) < p) need.set(k, p); };
    want(location, 3);
    let surround = null;
    if (kind === 'town') {
      const px = this.pixelOf(location);
      if (px) { surround = wildernessLocation(px.px, px.py); want(surround, 2); }
    } else surround = location;
    const surroundMesh = surround ? this.ready(surround) : null;
    for (const t of surroundMesh?.wilderness?.towns ?? []) if (t.id) want(t.id, 1);
    // Neighbouring pixels the player is walking toward.
    const here = this.anchor(location);
    if (here && at) {
      const e = here.e + at.x, s = here.s + at.z;
      const px = Math.floor(e / PIXEL), py = Math.floor(s / PIXEL);
      const lx = e - px * PIXEL, ls = s - py * PIXEL;
      const dxs = [lx < PREFETCH_EDGE ? -1 : null, PIXEL - lx < PREFETCH_EDGE ? 1 : null, 0].filter((v) => v !== null);
      const dys = [ls < PREFETCH_EDGE ? -1 : null, PIXEL - ls < PREFETCH_EDGE ? 1 : null, 0].filter((v) => v !== null);
      for (const dx of dxs) for (const dy of dys) want(wildernessLocation(px + dx, py + dy), dx || dy ? 0.5 : 2);
    }
    const layers = [];
    for (const [key] of need) {
      if (key === location) continue;
      const mesh = this.ready(key);
      if (!mesh) continue;
      // Only the surrounding pixel and its towns are drawn; prefetched pixels wait in the cache.
      if (kindOf(key) === 'wild' && key !== surround) continue;
      const offset = this.offset(key, location);
      if (offset) layers.push({ key, mesh, offset });
    }
    return { location, need, layers, surround };
  }
}
