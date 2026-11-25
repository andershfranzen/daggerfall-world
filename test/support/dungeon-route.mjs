// Route oracle for long dungeon walks (package 17 quest objectives). Like walking-route.mjs, but with a binary
// heap and a larger budget, and it reports the closest point reached when there is no route, so a test can say
// what blocks the approach. Every hop is a collision-world move that ends exactly where it aimed, on clear floor,
// and keeps the body's floor, so the client that replays the waypoints walks the same storeys.
export function dungeonRoute(world, start, target, { reach = 2, step = 0.5, budget = 600000, dy = 1.5 } = {}) {
  const dist = (p) => Math.hypot(p.x - target.x, p.z - target.z);
  const okY = (y) => !Number.isFinite(target.y) || Math.abs(y - target.y) <= dy;
  const move = (p, x, z) => {
    const end = world.move(p.x, p.z, x, z, { y: p.y });
    return Math.hypot(end.x - x, end.z - z) < 0.001 && world.isClear(x, z, end.y) ? end : null;
  };
  const heap = [];
  const push = (n) => {
    heap.push(n);
    for (let i = heap.length - 1; i > 0;) {
      const j = (i - 1) >> 1;
      if (heap[j].f <= heap[i].f) break;
      [heap[i], heap[j]] = [heap[j], heap[i]];
      i = j;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  const key = (p) => `${p.i},${p.j},${Math.round(p.y * 2)}`;
  const origin = { x: start.x, y: start.y, z: start.z, i: 0, j: 0, g: 0, f: dist(start), prev: null };
  const best = new Map([[key(origin), 0]]);
  push(origin);
  let closest = origin;
  let expanded = 0;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const visited = [];
  while (heap.length && expanded < budget) {
    const p = pop();
    if (p.g > best.get(key(p))) continue;
    expanded++;
    visited.push(p);
    if (dist(p) < dist(closest) && okY(p.y)) closest = p;
    if (dist(p) <= reach && okY(p.y)) return { path: simplify(p), expanded, closest: null };
    if (dist(p) < 6) {
      const d = move(p, target.x, target.z);
      if (d && okY(d.y)) return { path: simplify({ ...d, prev: p }), expanded, closest: null };
    }
    for (const [di, dj] of dirs) {
      const i = p.i + di, j = p.j + dj;
      const end = move(p, start.x + i * step, start.z + j * step);
      if (!end) continue;
      const g = p.g + step * Math.hypot(di, dj);
      const n = { x: end.x, y: end.y, z: end.z, i, j, g, f: g + dist(end) * 1.2, prev: p };
      const k = key(n);
      if (g >= (best.get(k) ?? Infinity)) continue;
      best.set(k, g);
      push(n);
    }
  }
  const reached = [];
  for (const n of visited) reached.push(n);
  return { path: null, expanded, reached, closest: { x: closest.x, y: closest.y, z: closest.z, distance: dist(closest) } };

  function simplify(end) {
    const path = [];
    for (let p = end; p; p = p.prev) path.push(p);
    path.reverse();
    const out = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
      const s = move(out.at(-1), path[i + 1].x, path[i + 1].z);
      if (!s || Math.abs(s.y - path[i + 1].y) > 0.15) out.push(path[i]);
    }
    if (path.length > 1) out.push(path.at(-1));
    return out.slice(1).map(({ x, y, z }) => ({ x, y, z }));
  }
}

/** Route from `start` to an already reached node `n` (follows the search tree back), as waypoints. */
export function routeTo(n) {
  const path = [];
  for (let p = n; p; p = p.prev) path.push({ x: p.x, y: p.y, z: p.z });
  return path.reverse().slice(1);
}

/**
 * Closed doors a player standing on a reached node can use (classic activation reach 2.6 m at eye height), nearest
 * to the target first. `isOpen(id)` reads the shared door state; `tried` skips doors that did not help.
 */
export function usableDoors(reached, doors, target, { isOpen, tried = new Set(), reach = 2.1 } = {}) {
  const out = [];
  for (const d of doors) {
    if (!d.door || tried.has(d.id) || isOpen(d.id)) continue;
    let stand = null, sd = Infinity;
    for (const n of reached) {
      const h = Math.hypot(n.x - d.x, n.z - d.z);
      if (h < 0.6 || h > reach || Math.abs(n.y + 1.6 - (d.y + 1.1)) > 1.2 || h >= sd) continue;
      stand = n; sd = h;
    }
    if (stand) out.push({ door: d, stand, score: Math.hypot(d.x - target.x, d.z - target.z) + (d.lock ? 30 : 0) });
  }
  return out.sort((a, b) => a.score - b.score);
}

/**
 * Incremental explorer for a dungeon with closed doors. The search tree is kept between rounds: after a door opens,
 * only the explored nodes near it are expanded again. Paths between explored nodes follow the tree (every link is a
 * collision move that was checked), so the walking client can go from one door to the next without a new search.
 */
export class DungeonExplorer {
  /**
   * `maxDrop` (m): refuse hops that fall further than this. A free fall into a shaft lands the server body where the
   * straight hop did not (it can meet a wall and start climbing), so long walks keep to stairs with about 0.8.
   */
  constructor(world, start, target, { reach = 2.5, step = 0.5, dy = 1.5, maxDrop = Infinity } = {}) {
    Object.assign(this, { world, target, reach, step, dy, maxDrop });
    this.best = new Map();
    this.heap = [];
    this.visited = [];
    this.root = { x: start.x, y: start.y, z: start.z, i: 0, j: 0, g: 0, prev: null };
    this.root.f = this.dist(this.root);
    this.start = start;
    this.best.set(this.key(this.root), 0);
    this.push(this.root);
    this.expanded = 0;
  }
  dist(p) { return Math.hypot(p.x - this.target.x, p.z - this.target.z); }
  okY(y) { return !Number.isFinite(this.target.y) || Math.abs(y - this.target.y) <= this.dy; }
  key(p) { return `${p.i},${p.j},${Math.round(p.y * 2)}`; }
  move(p, x, z) {
    const end = this.world.move(p.x, p.z, x, z, { y: p.y });
    return Math.hypot(end.x - x, end.z - z) < 0.001 && this.world.isClear(x, z, end.y) && p.y - end.y <= this.maxDrop ? end : null;
  }
  push(n) {
    const h = this.heap;
    h.push(n);
    for (let i = h.length - 1; i > 0;) { const j = (i - 1) >> 1; if (h[j].f <= h[i].f) break; [h[i], h[j]] = [h[j], h[i]]; i = j; }
  }
  pop() {
    const h = this.heap, top = h[0], last = h.pop();
    if (h.length) {
      h[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < h.length && h[l].f < h[m].f) m = l;
        if (r < h.length && h[r].f < h[m].f) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]];
        i = m;
      }
    }
    return top;
  }
  /** Expands until the target is within reach (returns its node) or the frontier is exhausted (returns null). */
  search(budget = 400000) {
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (let n = 0; this.heap.length && n < budget; n++) {
      const p = this.pop();
      if (p.g > (this.best.get(this.key(p)) ?? Infinity) || p.done) continue;
      p.done = true;
      this.expanded++;
      this.visited.push(p);
      if (this.dist(p) <= this.reach && this.okY(p.y)) return p;
      if (this.dist(p) < 6) {
        const d = this.move(p, this.target.x, this.target.z);
        if (d && this.okY(d.y)) return { ...d, i: p.i, j: p.j, g: p.g, prev: p };
      }
      for (const [di, dj] of dirs) {
        const i = p.i + di, j = p.j + dj;
        const end = this.move(p, this.start.x + i * this.step, this.start.z + j * this.step);
        if (!end) continue;
        const g = p.g + this.step * Math.hypot(di, dj);
        const k = this.key({ i, j, y: end.y });
        if (g >= (this.best.get(k) ?? Infinity)) continue;
        this.best.set(k, g);
        this.push({ x: end.x, y: end.y, z: end.z, i, j, g, f: g + this.dist(end) * 1.2, prev: p });
      }
    }
    return null;
  }
  /** A door changed: explored nodes within `radius` of it are expanded again on the next search. */
  reopen(at, radius = 4) {
    for (const p of this.visited) {
      if (Math.hypot(p.x - at.x, p.z - at.z) > radius) continue;
      p.done = false;
      this.push({ ...p, f: p.g + this.dist(p) * 1.2, done: false, reopened: true, src: p });
    }
    // Reopened copies replace their originals in the tree when expanded.
    this.visited = this.visited.filter((p) => !(Math.hypot(p.x - at.x, p.z - at.z) <= radius));
  }
  /**
   * Waypoints from explored node `a` to explored node `b` through their common ancestor, simplified. With
   * `{shortcuts: false}` every 0.5 m lattice hop is kept, so a replaying body stays on the oracle's storey and edges.
   */
  between(a, b, { shortcuts = true } = {}) {
    const up = [];
    const seen = new Map();
    for (let p = a, i = 0; p; p = p.prev, i++) { up.push(p); seen.set(p.src ?? p, i); }
    const down = [];
    let meet = null;
    for (let p = b; p; p = p.prev) {
      if (seen.has(p.src ?? p)) { meet = seen.get(p.src ?? p); break; }
      down.push(p);
    }
    const raw = [...up.slice(0, (meet ?? up.length - 1) + 1), ...down.reverse()].map(({ x, y, z }) => ({ x, y, z }));
    if (!shortcuts) return raw.slice(1);
    const out = [raw[0]];
    for (let i = 1; i < raw.length - 1; i++) {
      const s = this.move(out.at(-1), raw[i + 1].x, raw[i + 1].z);
      if (!s || Math.abs(s.y - raw[i + 1].y) > 0.15) out.push(raw[i]);
    }
    if (raw.length > 1) out.push(raw.at(-1));
    return out.slice(1);
  }
}
