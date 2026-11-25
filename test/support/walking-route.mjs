// Route oracle for live socket tests. The client still walks every waypoint with normal input.
// Keep the body's floor through each simulated move so a bridge or upper room stays distinct.
export function walkingRoute(world, start, target, reach, indoors) {
  const direct = latticeRoute(world, start, target, reach, indoors);
  if (direct) return direct;
  // The lattice is anchored at the start point, so an aisle barely wider than the body can fall between its nodes.
  // Shift the lattice by a short collision-checked first step and search again.
  for (const [dx, dz] of [[0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1], [0.25, 0.25], [-0.25, -0.25]]) {
    const end = world.move(start.x, start.z, start.x + dx, start.z + dz, { y: start.y });
    if (Math.hypot(end.x - start.x - dx, end.z - start.z - dz) >= 0.001 || !world.isClear(end.x, end.z, end.y)) continue;
    const rest = latticeRoute(world, { ...start, x: end.x, y: end.y, z: end.z }, target, reach, indoors);
    if (rest) return [{ x: end.x, y: end.y, z: end.z }, ...rest];
  }
  return null;
}

function latticeRoute(world, start, target, reach, indoors) {
  const step = indoors ? 0.5 : 1.5;
  const distance = p => Math.hypot(p.x - target.x, p.z - target.z);
  const closeInHeight = (y, ref, tolerance) => !Number.isFinite(ref) || Math.abs(y - ref) <= tolerance;
  const arrive = p => distance(p) <= reach && closeInHeight(p.y, target.y, 1.5);
  function move(p, x, z) {
    const end = world.move(p.x, p.z, x, z, { y: p.y });
    return Math.hypot(end.x - x, end.z - z) < 0.001 && world.isClear(x, z, end.y) ? end : null;
  }
  function waypoints(end) {
    const path = [];
    for (let p = end; p; p = p.prev) path.push(p);
    path.reverse();
    const out = [path[0]];
    for (let i = 1; i < path.length - 1; i++) {
      const next = path[i + 1];
      const shortcut = move(out.at(-1), next.x, next.z);
      if (!shortcut || !closeInHeight(shortcut.y, next.y, 0.15)) out.push(path[i]);
    }
    if (path.length > 1) out.push(end);
    return out.slice(1).map(({ x, y, z }) => ({ x, y, z }));
  }
  const origin = { ...start, i: 0, j: 0, g: 0, f: distance(start) };
  const key = p => `${p.i},${p.j},${indoors ? Math.round(p.y * 2) : 0}`;
  const open = [origin];
  const costs = new Map([[key(origin), 0]]);
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let n = 0; open.length && n < 40000; n++) {
    open.sort((a, b) => a.f - b.f);
    const p = open.shift();
    if (p.g > costs.get(key(p))) continue;
    if (arrive(p)) return waypoints(p);
    if (p === origin || distance(p) < 6) {
      const direct = move(p, target.x, target.z);
      if (direct && arrive(direct)) return waypoints({ ...direct, prev: p });
    }
    for (const [di, dj] of directions) {
      const i = p.i + di, j = p.j + dj;
      const end = move(p, start.x + i * step, start.z + j * step);
      if (!end) continue;
      const g = p.g + step * Math.hypot(di, dj);
      const next = { ...end, i, j, g, f: g + distance(end), prev: p };
      const k = key(next);
      if (g >= (costs.get(k) ?? Infinity)) continue;
      costs.set(k, g);
      open.push(next);
    }
  }
  return null;
}
