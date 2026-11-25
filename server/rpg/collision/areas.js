// Cache of collision worlds keyed by location id. Only occupied and recently used areas stay
// in memory; loads run one at a time so a burst of travel cannot pile up several towns'
// worth of decoding at once.
//
// An area is one of:
//   loading  - a load is in flight; nothing is known yet
//   ready    - built from operator ARENA2 data (or a fixture)
//   fallback - no operator data configured; the prototype uses a bounded open plane
//   unavailable - configured geometry failed; movement waits while the area is retried
//
// Everything here is synchronous except the loader promise. Callers (tick, actions) never
// await: they ask for the area, get its current state, and the load completes later.

export const AREA_DEFAULTS = Object.freeze({
  maxAreas: 4, // ready/fallback areas kept, occupied ones never evicted
  idleMs: 10 * 60_000, // unoccupied areas older than this are dropped
  loadTimeoutMs: 60_000,
  retryUnavailableMs: 5_000,
  retryFailedMs: 5 * 60_000, // a fallback caused by an error is retried after this long (when unoccupied)
});

export class AreaCache {
  /**
   * @param {object} o
   * @param {(location:string) => Promise<{world, source:string}>} o.load  resolves a ready world or rejects
   * @param {(location:string, reason:string) => {world, source:string}} o.fallback
   * @param {(area:object) => void} [o.onSettled]  called once per load when it becomes ready/fallback
   * @param {() => number} [o.now]
   */
  constructor({ load, fallback, onSettled = () => {}, now = () => Date.now(), ...opts }) {
    this.cfg = { ...AREA_DEFAULTS, ...opts };
    this.loadFn = load;
    this.fallbackFn = fallback;
    this.onSettled = onSettled;
    this.now = now;
    this.areas = new Map(); // location -> area
    this.queue = Promise.resolve();
    this.generation = 0;
  }

  /** Area record for `location`, starting a load when it is not cached. Never null. */
  get(location) {
    let a = this.areas.get(location);
    if (!a || (a.status === 'unavailable' && this.now() - a.settledAt >= this.cfg.retryUnavailableMs)) {
      a = { location, status: 'loading', world: null, source: null, reason: null, usedAt: this.now(), settledAt: 0, gen: ++this.generation };
      this.areas.set(location, a);
      a.promise = this.#start(a);
    }
    a.usedAt = this.now();
    return a;
  }

  /** Cached area or undefined, without starting a load. */
  peek(location) {
    return this.areas.get(location);
  }

  /** Resolves when the area is ready or fallback. */
  whenSettled(location) {
    const a = this.get(location);
    return a.promise.then(() => a);
  }

  #start(a) {
    const run = async () => {
      if (this.areas.get(a.location) !== a) return; // evicted while queued
      let timer;
      try {
        const res = await Promise.race([
          this.loadFn(a.location),
          new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error(`loading took longer than ${Math.round(this.cfg.loadTimeoutMs / 1000)} s`)), this.cfg.loadTimeoutMs);
            timer.unref?.();
          }),
        ]);
        if (!res || !res.world) throw new Error('loader returned no geometry');
        this.#settle(a, 'ready', res.world, res.source ?? 'operator data', null);
      } catch (err) {
        const reason = err?.message ? String(err.message) : String(err);
        const fb = this.fallbackFn(a.location, reason);
        this.#settle(a, fb.world ? 'fallback' : 'unavailable', fb.world, fb.source, reason);
      } finally {
        clearTimeout(timer);
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  #settle(a, status, world, source, reason) {
    if (this.areas.get(a.location) !== a) return;
    a.status = status;
    a.world = world;
    a.source = source;
    a.reason = reason;
    a.settledAt = this.now();
    try {
      this.onSettled(a);
    } catch {}
  }

  /**
   * Drop idle areas. `occupied` is the set of locations with players in them right now.
   * Returns the evicted location ids.
   */
  sweep(occupied) {
    const now = this.now();
    const evicted = [];
    for (const a of this.areas.values()) {
      if (occupied.has(a.location)) {
        this.get(a.location); // also retry unavailable geometry for a player waiting here
        continue;
      }
      const idle = now - a.usedAt;
      const retry = a.status === 'fallback' && a.reason && now - a.settledAt > this.cfg.retryFailedMs;
      if (a.status !== 'loading' && (idle > this.cfg.idleMs || retry)) evicted.push(a.location);
    }
    for (const l of evicted) this.areas.delete(l);
    const settled = [...this.areas.values()].filter((a) => a.status !== 'loading' && !occupied.has(a.location));
    let over = this.areas.size - this.cfg.maxAreas;
    settled.sort((x, y) => x.usedAt - y.usedAt);
    for (const a of settled) {
      if (over-- <= 0) break;
      this.areas.delete(a.location);
      evicted.push(a.location);
    }
    return evicted;
  }

  /** Approximate bytes held by cached worlds. */
  get byteSize() {
    let n = 0;
    for (const a of this.areas.values()) n += a.world?.byteSize ?? 0;
    return n;
  }
}
