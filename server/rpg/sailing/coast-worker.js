// The coast's heavy work off the game loop (./coast.js starts it on demand and ends it when idle): a port's harbour
// flood, a port-to-port route, and the traced outlines for the chart and the shore about a ship (./sea.js). Run as a
// worker thread, or in-process (`createEngine`) for the small practice sea and tests. Messages:
//   in : {type:'init', dataPath, fallback, ports:[stub], harbours:[port]}   stubs carry block; harbours already known
//        {type:'want', id} | {type:'route', req, from, to} | {type:'trace', req, kind:'chart'|'shore', ...}
//   out: {type:'ready', loadMs} | {type:'harbour', port, path} | {type:'unreachable', id, name, reason}
//        {type:'route', req, route} | {type:'trace', req, result} | {type:'idle'} | {type:'error', message, fatal?}

import { isMainThread, parentPort } from 'node:worker_threads';
import { realSource, fallbackSource, seaModel, buildHarbour, buildRoute } from './sea.js';
import { TILE_METRES, traceLand, simplifyRing, ringArea } from '../../../client/world/sea/chart.js';

const r2 = (v) => Math.round(v * 100) / 100;
const r4 = (v) => Math.round(v * 10000) / 10000;

/** Harbour record -> the port the main thread publishes. */
export function portRecord(p, hb) {
  return {
    id: p.id, name: p.name, region: p.region, regionIndex: p.regionIndex, px: p.px, py: p.py,
    berthReady: true,
    x: r2(hb.berth.x), z: r2(hb.berth.z), yaw: r4(hb.berth.yaw),
    approach: { x: r2(hb.approach.x), z: r2(hb.approach.z) },
    roadstead: { x: r2(hb.roadstead.x), z: r2(hb.roadstead.z), px: hb.road.px, py: hb.road.py },
    quay: { x: r2(hb.quay.x), z: r2(hb.quay.z), yaw: r4(hb.quay.yaw) },
    shore: hb.shore,
    besideShore: hb.besideShore,
    block: { width: p.block.width, height: p.block.height, custom: p.block.custom },
    ...(p.fallback ? { fallback: true } : {}),
  };
}

export function createEngine(post) {
  let sea = null;
  const stubs = new Map();
  const harbours = new Map(); // id -> {id, port, path, road, roadstead} | null
  const queue = []; // routes and traces, before harbours
  const wants = []; // port ids
  let running = false;

  function harbourOf(id) {
    if (harbours.has(id)) return harbours.get(id);
    const p = stubs.get(id);
    if (!p) return null;
    const hb = buildHarbour(p, sea);
    if (!hb.ok) {
      harbours.set(id, null);
      post({ type: 'unreachable', id, name: p.name, reason: hb.reason });
      return null;
    }
    const port = portRecord(p, hb);
    const path = hb.path.map((q) => ({ x: r2(q.x), z: r2(q.z) }));
    const rec = { id, port, path, road: hb.road, roadstead: hb.roadstead };
    harbours.set(id, rec);
    post({ type: 'harbour', port, path });
    return rec;
  }

  function trace(m) {
    if (m.kind === 'chart') {
      const { u0, v0, u1, v1 } = m.bounds;
      return traceLand((x, y) => !sea.src.sea(x, y), u0, v0, u1, v1)
        .filter((r) => Math.abs(ringArea(r)) >= m.minArea)
        .map((r) => simplifyRing(r, m.tolerance));
    }
    const { g0x, g0z, g1x, g1z } = m;
    return traceLand((gx, gz) => !sea.waterTile(gx, gz), g0x, g0z, g1x, g1z)
      .filter((r) => Math.abs(ringArea(r)) >= 2)
      .map((r) => {
        const clipped = r.some(([a, b]) => a === g0x || a === g1x || b === g0z || b === g1z);
        return { kind: clipped ? 'land' : 'island', clipped, ring: simplifyRing(r, m.tolerance).map(([a, b]) => [r2(a * TILE_METRES), r2(b * TILE_METRES)]) };
      });
  }

  function step() {
    running = false;
    try {
      if (queue.length) {
        const m = queue.shift();
        if (m.type === 'route') {
          const A = harbourOf(m.from), B = harbourOf(m.to);
          post({ type: 'route', req: m.req, route: A && B && m.from !== m.to ? buildRoute(A, B, sea) : null });
        } else post({ type: 'trace', req: m.req, result: trace(m) });
      } else if (wants.length) {
        harbourOf(wants.shift());
      }
    } catch (err) {
      post({ type: 'error', message: err?.stack ?? String(err) });
    }
    if (queue.length || wants.length) schedule();
    else post({ type: 'idle' });
  }
  function schedule() {
    if (running || !sea) return;
    running = true;
    setImmediate(step);
  }

  return {
    async handle(msg) {
      if (msg.type === 'init') {
        const t0 = performance.now();
        try {
          const src = msg.fallback || !msg.dataPath ? fallbackSource() : await realSource(msg.dataPath, { ports: false });
          for (const p of msg.ports ?? []) stubs.set(p.id, p);
          for (const p of msg.harbours ?? []) {
            harbours.set(p.id, { id: p.id, port: p, path: p.path, road: { px: p.roadstead.px, py: p.roadstead.py }, roadstead: { x: p.roadstead.x, z: p.roadstead.z } });
          }
          sea = seaModel(src, { maxPixels: msg.maxPixels ?? 384 });
          post({ type: 'ready', loadMs: Math.round(performance.now() - t0) });
          schedule();
        } catch (err) {
          post({ type: 'error', fatal: true, message: err?.message ?? String(err) });
        }
      } else if (msg.type === 'want') {
        if (!harbours.has(msg.id) && !wants.includes(msg.id)) wants.push(msg.id);
        schedule();
      } else if (msg.type === 'route' || msg.type === 'trace') {
        queue.push(msg);
        schedule();
      }
    },
  };
}

if (!isMainThread && parentPort) {
  const engine = createEngine((m) => parentPort.postMessage(m));
  parentPort.on('message', (m) => engine.handle(m));
}
