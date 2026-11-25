// The navigable sea: where the Iliac Bay's water is, where each port's ships lie, and the water-bound way between two
// ports. Owned by the sailing feature (server/rpg/sailing.js imports `createCoast`); the browser draws `chart()`.
//
// SOURCES (all read at run time from the operator's ARENA2 directory; nothing is bundled):
//   - MAPS.BSA: the port towns. A classic location is a port where its exterior record's PortTownAndUnknown byte is
//     nonzero (the byte Daggerfall's bank reads to sell ships; ./ports.js). Its block grid locates the town on its pixel.
//   - WOODS.WLD + CLIMATE.PAK: the sea. A map pixel is SEA where its height byte is at or under WATER_BYTE (5, the
//     sampler's beach elevation over its base height scale) and its climate is Ocean (223). A pixel is OPEN - a ship's
//     whole pixel - where the four height bytes that shape its ground are sea (the pixel's own and its north, west and
//     north-west neighbours: the sampler interpolates between them). DEEP is open with its eight neighbours open too.
//   - Near the coast the 6.4 m terrain tiles decide: a tile is water where the four DFU height samples at its corners
//     lie at or under the ocean elevation (client/world/wilderness/terrain.js generateSamples, the ground the player
//     walks). That is DFU's tile byte 0 less one corner case (three water corners and one grass corner, which DFU also
//     draws as water and this treats as land, the cautious side).
//
// COMPARED WITH Daggerfall Online (Lattymoy, MIT, .ref/dfjs-research-03 at a3eb1605): its seaLanes.js roadstead (the
// nearest open pixel within 3 of the town, ring by ring), its lanes as an 8-neighbour A* over open pixels with no corner
// cut, straightened wherever a line holds to the water, and a leg the ground refuses searched again (KERNEL_RETRIES)
// are followed here in behaviour (independent code). Its harbours (shipLife.js findHarbour) sound berths on water beside
// land nearest the town with a clear footprint and an approach astern; here a berth is a water tile reachable from the
// roadstead through a channel CHANNEL_CLEAR_M wide, as near the town's block grid as the shore allows, lying
// BERTH_CLEAR_M or more off the land, and its quay is the first dry tile behind it. seaClearance.js keeps hulls
// HULL_CLEAR_M off one another; that is the sailing core's (ships), this module answers the land's clearance.
// DFO ships its own port id table (Travel Options'); this module reads the game's port flag instead.
//
// FRAME (client/world/sea/chart.js): global metres, x east, z SOUTH, the overland frame (exterior/frame.js toGlobal):
// map pixel (px, py) spans x in [px*819.2, (px+1)*819.2], z in [py*819.2, (py+1)*819.2]. Uncompressed: a berth lies
// 1:1 beside the town ground it is drawn with. yaw 0 = north (-z), +PI/2 = east; heading (sin yaw, -cos yaw).
// TIME, not space, is compressed: SEA_COMPRESSION is the suggested time warp on `open` legs; `harbour` legs run 1:1.
//
// WITHOUT GAME DATA the coast serves an invented practice sea (client/world/sea/chart.js FALLBACK_SEA), labelled as
// such in `world` and every port (`fallback: true`, ids `fallback:...`). A server WITH a data path whose files fail to
// load reports 'failed' and never falls back silently.

// COST. Nothing is read until a sailing feature asks (createCoast is called lazily by server/rpg/sailing.js). Then:
//   - main thread, in slices that each yield (none over ~20 ms): the coarse sea (map-pixel grids from WOODS.WLD's
//     height map and CLIMATE.PAK), the port index (the travel feature's loaded catalogue when given, plus MAPS.BSA's
//     exterior records), each port's roadstead, and the connected bodies of open water. Sync queries a moving ship asks
//     (isWater, clearanceAt, segmentClear) read tiles through a small bounded cache; prepareAround warms it ahead.
//   - one worker thread, started on demand and ended after WORKER_IDLE_MS without work: a port's harbour flood (only
//     the ports somebody asks for: portOf, whenPort, nearestPort, routeAsync), routes, and traced outlines.
// Routes are cached per pair, and a request already in flight is shared, so a route is computed once.

import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { realSource, fallbackSource, seaModel, roadsteadOf, arena2Dir } from './sea.js';
import { createEngine } from './coast-worker.js';
import { loadPortIndex } from './ports.js';
import { townFrame, wildToTown } from '../../../client/world/exterior/frame.js';
import { CHART_METRES, TILE_METRES } from '../../../client/world/sea/chart.js';

export {
  WATER_BYTE, OCEAN_CLIMATE, ROADSTEAD_PX, BERTH_CLEAR_M, CHANNEL_CLEAR_M, LANE_CLEAR_M, CLEAR_CAP_M, APPROACH_M,
  SEA_COMPRESSION, SHIP_MINUTES_PER_PIXEL, LEAGUE_M,
} from './sea.js';
export { CHART_METRES, TILE_METRES };

const MAX_ROUTES = 1024;
const WORKER_IDLE_MS = 60000;
/** The most main-thread time prepareAround spends before handing back to the event loop (one unit may overrun it). */
const PREP_BUDGET_MS = 8;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;
const tick = () => new Promise((r) => setImmediate(r));

/**
 * The navigable coast. Returns at once.
 * @param {object} o
 * @param {string|null} [o.dataPath]  ARENA2 (or install) directory; none = the labelled practice sea
 * @param {object} [o.travel]         ctx.services.travel: its loaded catalogue is reused for the port index
 * @param {boolean} [o.fallback]      serve the practice sea even with data
 * @param {'auto'|boolean} [o.worker] harbours, routes and traces in a worker thread (auto: with game data only)
 * @param {boolean} [o.eager]         flood every harbour at once (evidence, tools); default only on demand
 * @param {string[]} [o.filterNames]  only these port names or ids (tests, evidence)
 * @param {number} [o.maxPixels]      main-thread tile cache, pixels (32 KB each)
 *
 * status: 'loading' | 'ready' | 'failed'. `ready` resolves when the sea answers water queries and the port index is
 * known. A port's berth is planned when first asked for: until then it is listed with `berthReady: false`.
 */
export function createCoast({ dataPath = null, log = console, travel = null, fallback = false, worker = 'auto', eager = false, filterNames = null, maxPixels = 256 } = {}) {
  const useFallback = fallback || !dataPath;
  const coast = { status: 'loading', closed: false, error: null, world: null, progress: { harbours: 0, ports: 0, unreachable: 0 }, timings: {} };
  let sea = null;
  let stubs = []; // port index entries (with block), each with `road` (its roadstead pixel or null)
  const stubById = new Map();
  const ports = new Map(); // id -> planned port (frozen, berthReady)
  const unreachable = new Map();
  const waiters = new Map(); // id -> [resolve]
  const routes = new Map();
  const inflight = new Map();
  const pending = new Map(); // req -> {resolve, msg}
  let reqSeq = 0;
  let chartCache = null;
  const shoreCache = new Map();
  let bodies = null;
  let closed = false;

  const settle = (id) => {
    const list = waiters.get(id);
    if (!list) return;
    waiters.delete(id);
    for (const r of list) r(ports.get(id) ?? null);
  };

  function onMessage(m) {
    if (closed) return; // nothing a closing worker says reaches the coast
    switch (m.type) {
      case 'ready':
        coast.timings.workerLoadMs = m.loadMs;
        coast.timings.workerStarts = (coast.timings.workerStarts ?? 0) + 1;
        break;
      case 'harbour': {
        const port = Object.freeze({ ...m.port, path: Object.freeze(m.path) });
        ports.set(port.id, port);
        coast.progress.harbours++;
        chartCache = null;
        shoreCache.clear();
        settle(port.id);
        break;
      }
      case 'unreachable':
        unreachable.set(m.id, { id: m.id, name: m.name, reason: m.reason });
        coast.progress.unreachable++;
        settle(m.id);
        break;
      case 'route':
      case 'trace': {
        const p = pending.get(m.req);
        pending.delete(m.req);
        p?.resolve(m.type === 'route' ? (m.route ? Object.freeze(m.route) : null) : m.result);
        break;
      }
      case 'idle':
        engine.idle();
        break;
      case 'error':
        log.warn?.(`[sailing] coast worker: ${m.message}`);
        if (m.fatal) for (const [req, p] of pending) { pending.delete(req); p.resolve(null); }
        break;
    }
  }

  // The worker: started for work, ended when idle; a restart is told the harbours already planned.
  const initMsg = () => ({ type: 'init', dataPath, fallback: useFallback, maxPixels: 384, ports: stubs, harbours: [...ports.values()] });
  const inWorker = worker === 'auto' ? !useFallback : !!worker;
  let engine, failures = 0;
  const workerFailed = () => {
    coast.workerError = 'The sea chart worker could not start.';
    log.warn?.(`[sailing] ${coast.workerError} Outstanding harbour and route requests are refused.`);
    settleAll();
  };
  if (inWorker) {
    let w = null, idleTimer = null;
    const live = () => {
      clearTimeout(idleTimer);
      if (!w) {
        // The parent's eval and input-type flags are no worker's (a worker started from `node -e` failed on them).
        // Only rewritten when needed: the inherited flags otherwise (some a test runner sets may not be passed again).
        const opts = process.execArgv.some((f) => f.startsWith('--input-type'))
          ? { execArgv: process.execArgv.filter((f) => !f.startsWith('--input-type')) } : {};
        const me = new Worker(new URL('./coast-worker.js', import.meta.url), opts);
        let started = false;
        w = me;
        me.on('message', (m) => { if (m.type === 'ready') { started = true; failures = 0; } onMessage(m); });
        me.on('error', (err) => log.warn?.(`[sailing] coast worker failed: ${err?.message ?? err}`));
        me.on('exit', () => {
          if (w === me) w = null;
          if (closed) return;
          // Work it never answered goes to the next one; a worker that cannot even start twice running fails the work.
          if (!started && ++failures >= 2) { workerFailed(); return; }
          if (pending.size || [...waiters.values()].some((l) => l.length)) {
            const x = live();
            x.ref();
            for (const p of pending.values()) x.postMessage(p.msg);
            for (const id of waiters.keys()) x.postMessage({ type: 'want', id });
          }
        });
        me.postMessage(initMsg());
        // Refs follow the work: held while it has some (posted below), released on 'idle' and on close. unref after
        // the listeners, since attaching 'message' refs the worker's port again.
        me.unref();
      }
      return w;
    };
    engine = {
      post: (m) => {
        if (closed || coast.workerError) {
          if (m.req) { const p = pending.get(m.req); pending.delete(m.req); p?.resolve(null); }
          return;
        }
        const x = live();
        x.ref();
        x.postMessage(m);
      },
      idle() {
        clearTimeout(idleTimer);
        if (!pending.size && ![...waiters.values()].some((l) => l.length)) w?.unref();
        idleTimer = setTimeout(() => { if (!pending.size && !waiters.size) { w?.terminate(); } }, WORKER_IDLE_MS);
        idleTimer.unref?.();
      },
      close() {
        clearTimeout(idleTimer);
        const x = w;
        w = null;
        if (x) { x.removeAllListeners('message'); x.removeAllListeners('exit'); x.on('error', () => {}); x.terminate(); }
      },
    };
  } else {
    let e = null;
    engine = {
      post(m) {
        if (closed) return;
        if (!e) { e = createEngine((r) => setImmediate(() => onMessage(r))); e.handle(initMsg()); }
        e.handle(m);
      },
      idle() {},
      close() {},
    };
  }

  coast.ready = (async () => {
    const t0 = performance.now();
    try {
      let src, index;
      if (useFallback) {
        src = fallbackSource();
        index = src.ports;
      } else {
        const dir = arena2Dir(dataPath);
        const maps = readdirSync(dir).find((n) => n.toUpperCase() === 'MAPS.BSA');
        if (!maps) throw new Error('MAPS.BSA is missing');
        src = await realSource(dataPath, { ports: false, yieldEach: true });
        const t1 = performance.now();
        const pi = await loadPortIndex(join(dir, maps), travel);
        index = pi.ports;
        coast.timings.portIndexMs = Math.round(performance.now() - t1);
        coast.timings.catalogue = pi.catalogSource;
      }
      if (filterNames) index = index.filter((p) => filterNames.includes(p.name) || filterNames.includes(p.id));
      await tick();
      sea = seaModel(src, { maxPixels });
      coast.world = src.world;
      await tick();
      stubs = [];
      for (const p of index) {
        const stub = { ...p, road: roadsteadOf(p, sea.isOpen, sea.isDeep) };
        stubs.push(stub);
        stubById.set(stub.id, stub);
      }
      coast.progress.ports = stubs.length;
      await tick();
      bodies = await labelBodies(sea);
      coast.timings.readyMs = Math.round(performance.now() - t0);
      coast.status = 'ready';
      log.info?.(`[sailing] ${coast.world.label}: ${stubs.length} port towns indexed in ${coast.timings.readyMs} ms; berths planned on demand`);
      if (eager) for (const s of stubs) coast.portOf(s.id);
      return coast;
    } catch (err) {
      coast.status = 'failed';
      coast.error = err?.message ?? String(err);
      log.warn?.(`[sailing] the sea chart failed to load: ${coast.error}`);
      throw err;
    }
  })();
  coast.ready.catch(() => {});

  const need = () => {
    if (coast.status !== 'ready') throw new Error(coast.status === 'failed' ? `The sea chart failed to load: ${coast.error}` : 'The sea chart is still loading.');
  };
  const request = (msg) => new Promise((resolve) => {
    if (closed) return resolve(null);
    const req = ++reqSeq;
    const m = { ...msg, req };
    pending.set(req, { resolve, msg: m });
    engine.post(m);
  });
  /** A port as published: planned (berthReady) or its index entry (berthReady false; `harbour: false` if none can be). */
  const view = (s) => {
    const p = ports.get(s.id);
    if (p) return p;
    const u = unreachable.get(s.id);
    return {
      id: s.id, name: s.name, region: s.region, regionIndex: s.regionIndex, px: s.px, py: s.py, berthReady: false,
      ...(u || !s.road ? { harbour: false, reason: u?.reason ?? 'no open sea within 3 map pixels' } : {}),
      ...(s.fallback ? { fallback: true } : {}),
    };
  };
  const plan = (id) => {
    if (closed || coast.status !== 'ready' || ports.has(id) || unreachable.has(id)) return;
    const s = stubById.get(id);
    if (!s) return;
    if (!s.road) {
      unreachable.set(id, { id, name: s.name, reason: 'no open sea within 3 map pixels' });
      coast.progress.unreachable++;
      settle(id);
      return;
    }
    if (!waiters.has(id)) waiters.set(id, []);
    engine.post({ type: 'want', id });
  };

  coast.isWater = (x, z) => coast.status === 'ready' && sea.isWater(x, z);
  coast.clearanceAt = (x, z) => (coast.status === 'ready' ? sea.clearanceAt(x, z) : 0);
  coast.segmentClear = (ax, az, bx, bz, opts) => (coast.status === 'ready' ? sea.segmentClear(ax, az, bx, bz, opts) : { ok: false, hitAt: { x: ax, z: az } });

  /** Every port town the files flag, planned or not (see `view`). Cheap; plans nothing. */
  coast.ports = () => stubs.map(view);
  coast.portTowns = coast.ports;
  coast.unreachablePorts = () => [...unreachable.values()];
  /** The port (berthReady true once planned) or null if `id` is no port town. Starts planning its berth. */
  coast.portOf = (id) => {
    const s = stubById.get(id);
    if (!s) return null;
    plan(id);
    return view(s);
  };
  /** The planned port, or null where none can be. */
  coast.whenPort = async (id) => {
    await coast.ready;
    const s = stubById.get(id);
    if (!s) return null;
    if (ports.has(id) || unreachable.has(id)) return ports.get(id) ?? null;
    return new Promise((resolve) => {
      plan(id);
      if (closed || coast.workerError || ports.has(id) || unreachable.has(id)) return resolve(ports.get(id) ?? null);
      waiters.get(id).push(resolve);
    });
  };
  /** Every port planned so far resolved; with `all`, plans every port first (tools and evidence). */
  coast.allHarbours = async () => {
    await coast.ready;
    return Promise.all(stubs.map((s) => coast.whenPort(s.id)));
  };
  /**
   * The nearest port town that can have a harbour, by its berth when planned, else by its town pixel's centre.
   * Starts planning it. {port, distance} | null.
   */
  coast.nearestPort = (x, z) => {
    let best = null, bd = Infinity;
    for (const s of stubs) {
      if (!s.road || unreachable.has(s.id)) continue;
      const p = ports.get(s.id);
      const d = p ? Math.hypot(p.x - x, p.z - z) : Math.hypot((s.px + 0.5) * CHART_METRES - x, (s.py + 0.5) * CHART_METRES - z);
      if (d < bd) { bd = d; best = s; }
    }
    if (!best) return null;
    plan(best.id);
    return { port: view(best), distance: bd };
  };
  coast.quayInTown = (port, spawnLocal) => quayInTown(port, spawnLocal);

  /**
   * The water-bound way between two ports' berths, computed once per pair in the worker (planning both berths).
   * @returns {Promise<{from, to, points:{x,z}[], legs:{kind:'harbour'|'open', a, b, metres}[], metres, leagues, days}|null>}
   */
  coast.routeAsync = async (fromId, toId) => {
    await coast.ready;
    const key = `${fromId}>${toId}`;
    if (routes.has(key)) return routes.get(key);
    if (inflight.has(key)) return inflight.get(key);
    if (!coast.reachable(fromId, toId)) {
      routes.set(key, null);
      return null;
    }
    const p = request({ type: 'route', from: fromId, to: toId }).then((route) => {
      inflight.delete(key);
      if (closed) return route; // a close's null is no answer to keep
      routes.set(key, route);
      while (routes.size > MAX_ROUTES) routes.delete(routes.keys().next().value);
      return route;
    });
    inflight.set(key, p);
    return p;
  };
  /** The cached route, or null while it is computed (asks for it). */
  coast.route = (fromId, toId) => {
    const key = `${fromId}>${toId}`;
    if (routes.has(key)) return routes.get(key);
    if (coast.status === 'ready') coast.routeAsync(fromId, toId);
    return null;
  };
  coast.routeStats = () => ({ cached: routes.size, inflight: inflight.size });

  /**
   * Whether a sea route between two port towns can exist: both can have a harbour and their roadsteads lie in one
   * connected body of open water (8-neighbour, no corner cut past land - the lane search's graph). Sync, plans
   * nothing. null while loading. routeAsync stays the final word.
   */
  coast.reachable = (fromId, toId) => {
    if (coast.status !== 'ready') return null;
    const a = stubById.get(fromId), b = stubById.get(toId);
    if (!a || !b || a === b || !a.road || !b.road || unreachable.has(fromId) || unreachable.has(toId)) return false;
    return bodies[a.road.py * sea.W + a.road.px] === bodies[b.road.py * sea.W + b.road.px];
  };

  /**
   * A lightweight chart, traced in the worker: simplified land outlines in chart units (u east = x/819.2, v south =
   * z/819.2), and the port towns (at their berth when planned, else their town pixel, `berthReady`). `view` bounds a
   * region in chart units; default the sea about every port town. Cached for the default view.
   */
  coast.chartAsync = async ({ view: v0 = null, tolerance = 0.6, minArea = 1 } = {}) => {
    await coast.ready;
    if (!v0 && chartCache) return withPorts(chartCache);
    const v = v0 ?? defaultView();
    const bounds = {
      u0: Math.max(0, Math.floor(v.u0)), v0: Math.max(0, Math.floor(v.v0)),
      u1: Math.min(sea.W, Math.ceil(v.u1)), v1: Math.min(sea.H, Math.ceil(v.v1)),
    };
    const rings = await request({ type: 'trace', kind: 'chart', bounds, tolerance, minArea });
    const base = {
      world: coast.world,
      projection: { metresPerUnit: CHART_METRES, u: 'x / 819.2 (east)', v: 'z / 819.2 (south)', yaw: '0 north, +PI/2 east' },
      bounds, coast: rings ?? [],
    };
    if (!v0 && rings) chartCache = base;
    return withPorts(base);
  };
  function withPorts(base) {
    const { u0, v0, u1, v1 } = base.bounds;
    const list = [];
    for (const s of stubs) {
      if (!s.road) continue;
      const p = ports.get(s.id);
      const u = p ? p.x / CHART_METRES : s.px + 0.5, v = p ? p.z / CHART_METRES : s.py + 0.5;
      if (u < u0 || u > u1 || v < v0 || v > v1) continue;
      list.push({ id: s.id, name: s.name, region: s.region, u: r3(u), v: r3(v), berthReady: !!p, ...(p ? { yaw: p.yaw } : {}), ...(s.fallback ? { fallback: true } : {}) });
    }
    return { ...base, ports: list };
  }
  /** Land outlines within `radius` metres of a world point, in world metres (distant coasts seen from the sea). */
  coast.outlinesNearAsync = async (x, z, radius = 20000, opts = {}) => {
    const r = radius / CHART_METRES, u = x / CHART_METRES, w = z / CHART_METRES;
    const c = await coast.chartAsync({ view: { u0: u - r, v0: w - r, u1: u + r, v1: w + r }, ...opts });
    return c.coast.map((ring) => ring.map(([a, b]) => [r2(a * CHART_METRES), r2(b * CHART_METRES)]));
  };
  function defaultView() {
    if (!stubs.length || coast.world?.fallback) return { u0: 0, v0: 0, u1: sea.W, v1: sea.H };
    let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
    for (const p of stubs) {
      u0 = Math.min(u0, p.px); v0 = Math.min(v0, p.py); u1 = Math.max(u1, p.px + 1); v1 = Math.max(v1, p.py + 1);
    }
    const m = Math.max(2, Math.round((u1 - u0) * 0.03));
    return { u0: u0 - m, v0: v0 - m, u1: u1 + m, v1: v1 + m };
  }

  /**
   * Shoreline about a ship at terrain-tile resolution (6.4 m), traced in the worker, in world metres (x east, z south).
   * rings: [{kind:'land'|'island', clipped, ring:[[x,z],...]}] - land on the right walking the ring (clockwise on
   * screen); `clipped` rings touch the square window and their edges along it are the window's, not a shore; an
   * island is a ring wholly inside it. ports: planned harbours in the window. Cached per 1024 m cell; the same
   * request in flight is shared.
   */
  coast.shoreNear = async (x, z, radius = 2500, { tolerance = 1.5 } = {}) => {
    await coast.ready;
    const R = Math.min(4000, Math.max(200, radius));
    const cx = Math.round(x / 1024) * 1024, cz = Math.round(z / 1024) * 1024;
    const key = `${cx},${cz},${R},${tolerance}`;
    if (shoreCache.has(key)) return shoreCache.get(key);
    const job = (async () => {
      const rings = await request({
        type: 'trace', kind: 'shore', tolerance,
        g0x: Math.floor((cx - R) / TILE_METRES), g0z: Math.floor((cz - R) / TILE_METRES),
        g1x: Math.ceil((cx + R) / TILE_METRES), g1z: Math.ceil((cz + R) / TILE_METRES),
      });
      const inWin = (p) => Math.abs(p.x - cx) <= R && Math.abs(p.z - cz) <= R;
      return Object.freeze({
        world: coast.world, centre: { x: cx, z: cz }, radius: R, tile: TILE_METRES, rings: rings ?? [],
        ports: [...ports.values()].filter(inWin).map((p) => ({
          id: p.id, name: p.name, x: p.x, z: p.z, yaw: p.yaw, kind: 'harbor', quay: p.quay, shore: p.shore,
          ...(p.fallback ? { fallback: true } : {}),
        })),
      });
    })();
    shoreCache.set(key, job);
    if (shoreCache.size > 64) shoreCache.delete(shoreCache.keys().next().value);
    const out = await job;
    if (shoreCache.get(key) === job) shoreCache.set(key, out);
    return out;
  };

  /**
   * Warm the main thread's tiles about a point so the sync queries a ship asks there answer at once. Every call feeds
   * one shared queue, worked a unit at a time (one pixel's sounding, tiles or clearance - a few ms each) and handed
   * back to the event loop whenever PREP_BUDGET_MS has been spent, so overlapping calls never stack their work into
   * one long stretch. Resolves with the number of coastal pixels prepared when its own pixels are done.
   */
  coast.prepareAround = async (x, z, radius = CHART_METRES) => {
    await coast.ready;
    if (closed) return 0;
    const p0 = Math.floor((x - radius) / CHART_METRES), p1 = Math.floor((x + radius) / CHART_METRES);
    const q0 = Math.floor((z - radius) / CHART_METRES), q1 = Math.floor((z + radius) / CHART_METRES);
    const mine = [];
    for (let py = q0; py <= q1; py++) for (let px = p0; px <= p1; px++) {
      if (!sea.inGrid(px, py)) continue;
      const k = py * sea.W + px;
      let job = prepJobs.get(k);
      if (!job) {
        job = { px, py, done: null, resolve: null, coastal: false };
        job.done = new Promise((r) => { job.resolve = r; });
        prepJobs.set(k, job);
        prepQueue.push(job);
      }
      mine.push(job.done);
    }
    pumpPrep();
    return (await Promise.all(mine)).filter(Boolean).length;
  };
  const prepJobs = new Map(); // pixel key -> job, while queued or running
  const prepQueue = [];
  let prepRunning = false;
  /** One unit of a pixel's preparation; true when the pixel is finished. */
  function prepStep(job) {
    const { px, py } = job;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      if (sea.inGrid(px + i, py + j) && !sea.known(px + i, py + j)) { sea.state(px + i, py + j); return false; }
    }
    if (sea.state(px, py) === 0 || sea.calm(px, py)) return true;
    job.coastal = true;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      if (sea.state(px + i, py + j) === 2 && !sea.fine.get((py + j) * sea.W + px + i)?.water) { sea.fineOf(px + i, py + j); return false; }
    }
    sea.clearOf(px, py);
    return true;
  }
  async function pumpPrep() {
    if (prepRunning) return;
    prepRunning = true;
    try {
      let t0 = performance.now();
      while (prepQueue.length && !closed) {
        const job = prepQueue[0];
        if (prepStep(job)) {
          prepQueue.shift();
          prepJobs.delete(job.py * sea.W + job.px);
          job.resolve(job.coastal);
        }
        if (performance.now() - t0 >= PREP_BUDGET_MS) {
          await new Promise((r) => setImmediate(r));
          t0 = performance.now();
        }
      }
    } finally {
      prepRunning = false;
      for (const job of prepQueue.splice(0)) { prepJobs.delete(job.py * sea.W + job.px); job.resolve(false); }
    }
  }

  /**
   * End the coast: the worker is terminated and nothing it still sends is heard; every outstanding whenPort,
   * routeAsync, shoreNear and chartAsync settles at once (null, or what was already known); later requests settle
   * at once the same way. Water queries keep answering from the main thread's grids.
   */
  coast.close = () => {
    if (closed) return;
    closed = true;
    coast.closed = true;
    engine.close();
    settleAll();
  };
  function settleAll() {
    for (const [req, p] of pending) { pending.delete(req); p.resolve(null); }
    for (const id of [...waiters.keys()]) {
      const list = waiters.get(id);
      waiters.delete(id);
      for (const r of list) r(ports.get(id) ?? null);
    }
  }
  coast._sea = () => sea; // tests and evidence
  return coast;
}

/** Connected bodies of open water (the lane graph), labelled a slice at a time. */
async function labelBodies(sea) {
  const { W, H } = sea;
  const lab = new Int32Array(W * H).fill(-1);
  const stack = new Int32Array(W * H);
  let n = 0, work = 0;
  for (let i = 0; i < W * H; i++) {
    if (++work > 40000) { work = 0; await tick(); }
    if (lab[i] !== -1 || !sea.isOpen(i % W, Math.floor(i / W))) continue;
    let top = 0;
    stack[top++] = i;
    lab[i] = n;
    while (top) {
      if (++work > 40000) { work = 0; await tick(); }
      const k = stack[--top], x = k % W, y = Math.floor(k / W);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (!sea.isOpen(nx, ny) || lab[ny * W + nx] !== -1) continue;
        if (dx && dy && (!sea.isOpen(x + dx, y) || !sea.isOpen(x, y + dy))) continue;
        lab[ny * W + nx] = n;
        stack[top++] = ny * W + nx;
      }
    }
    n++;
  }
  return lab;
}

/**
 * A port's quay in its town's own frame (client/world/exterior/frame.js, the frame of a player's x/z in that town),
 * from loadTown().source.spawnLocal. The port's own `quay` is in global metres.
 */
export function quayInTown(port, spawnLocal) {
  const b = port.block ?? { width: 8, height: 8, custom: false };
  const f = townFrame({ px: port.px, py: port.py, width: b.width, height: b.height, custom: b.custom, spawnLocal });
  // Relative to the town pixel's centre, whichever pixel the quay itself lies on.
  const xw = port.quay.x - (port.px * CHART_METRES + CHART_METRES / 2);
  const zw = port.quay.z - (port.py * CHART_METRES + CHART_METRES / 2);
  const t = wildToTown(f, xw, zw);
  return { x: t.x, z: t.z, yaw: port.quay.yaw };
}
