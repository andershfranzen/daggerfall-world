// Sea chart geometry shared by the server's navigable coast (server/rpg/sailing/coast.js) and the browser's chart.
//
// Pure, DOM- and Node-neutral. Nothing here carries game data: the server derives the coast at run time from the
// operator's WOODS.WLD and CLIMATE.PAK and sends the simplified outlines; this file only knows how to project, trace
// and simplify them, and the shape of one small invented practice sea used when no game data is installed.
//
// FRAMES
//   world  metres, x east, z SOUTH, y up; the overland global frame (client/world/exterior/frame.js toGlobal): map
//          pixel (px, py) spans x in [px*819.2, (px+1)*819.2], z in [py*819.2, (py+1)*819.2]. Uncompressed, so a berth
//          lies 1:1 against the town and wilderness ground it is drawn beside.
//   yaw    radians, 0 = north (-z), +PI/2 = east; heading vector (sin yaw, -cos yaw) - server/game.js's input law.
//   chart  u east, v south, one unit per map pixel (819.2 m): u = x / 819.2, v = z / 819.2. A yaw keeps its meaning
//          on the chart because both axes keep their direction.

export const CHART_METRES = 819.2; // metres per chart unit (one Daggerfall map pixel)
export const TILE_METRES = 6.4; // one terrain tile
export const TILES_PER_PIXEL = 128;

export const toChart = (x, z) => ({ u: x / CHART_METRES, v: z / CHART_METRES });
export const fromChart = (u, v) => ({ x: u * CHART_METRES, z: v * CHART_METRES });
export const headingOf = (yaw) => ({ x: Math.sin(yaw), z: -Math.cos(yaw) });
export const yawOf = (dx, dz) => Math.atan2(dx, -dz);

/**
 * Fit a chart view (u0..u1, v0..v1) into a canvas of `width` x `height` CSS pixels, aspect kept, centred.
 * @returns {{scale:number, ox:number, oy:number, toScreen(u:number,v:number):[number,number], toChart(sx:number,sy:number):[number,number]}}
 */
export function fitView(view, width, height, pad = 8) {
  const w = Math.max(1e-6, view.u1 - view.u0), h = Math.max(1e-6, view.v1 - view.v0);
  const scale = Math.min((width - 2 * pad) / w, (height - 2 * pad) / h);
  const ox = (width - w * scale) / 2 - view.u0 * scale;
  const oy = (height - h * scale) / 2 - view.v0 * scale;
  return {
    scale, ox, oy,
    toScreen: (u, v) => [ox + u * scale, oy + v * scale],
    toChart: (sx, sy) => [(sx - ox) / scale, (sy - oy) / scale],
  };
}

/**
 * Land outlines of a boolean grid as closed rings on cell corners (u east, v south), land kept on the right when the
 * ring is walked (clockwise on screen). Cells outside the grid count as sea, so land at the edge is closed along it.
 * At a saddle (two land cells touching corner to corner) the rings stay apart.
 * @param {(cx:number, cy:number) => boolean} land
 * @returns {number[][][]} rings of [u, v]
 */
export function traceLand(land, x0, y0, x1, y1) {
  const isLand = (x, y) => x >= x0 && y >= y0 && x < x1 && y < y1 && land(x, y);
  // Directed edges keyed by start corner; each land cell side facing sea contributes one edge, clockwise on screen.
  const next = new Map();
  const key = (x, y) => `${x},${y}`;
  const add = (ax, ay, bx, by) => {
    const k = key(ax, ay);
    const list = next.get(k);
    if (list) list.push([bx, by]);
    else next.set(k, [[bx, by]]);
  };
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!isLand(x, y)) continue;
      if (!isLand(x, y - 1)) add(x, y, x + 1, y); // north side, eastward
      if (!isLand(x + 1, y)) add(x + 1, y, x + 1, y + 1); // east side, southward
      if (!isLand(x, y + 1)) add(x + 1, y + 1, x, y + 1); // south side, westward
      if (!isLand(x - 1, y)) add(x, y + 1, x, y); // west side, northward
    }
  }
  const rings = [];
  for (const [k0, list0] of next) {
    while (list0.length) {
      const [sx, sy] = k0.split(',').map(Number);
      const ring = [[sx, sy]];
      let px = sx, py = sy;
      let [cx, cy] = list0.pop();
      let guard = 0;
      while ((cx !== sx || cy !== sy) && guard++ < 1e7) {
        ring.push([cx, cy]);
        const outs = next.get(key(cx, cy));
        if (!outs || !outs.length) break;
        let pick = 0;
        if (outs.length > 1) {
          // Saddle: turn right (keep the cell we walk along), so touching corners leave two rings.
          const dx = cx - px, dy = cy - py;
          const rx = -dy, ry = dx; // right turn on screen (v down)
          const i = outs.findIndex(([nx, ny]) => nx - cx === rx && ny - cy === ry);
          pick = i >= 0 ? i : 0;
        }
        const [nx, ny] = outs.splice(pick, 1)[0];
        px = cx; py = cy; cx = nx; cy = ny;
      }
      if (ring.length >= 4) rings.push(dropCollinear(ring));
    }
  }
  return rings;
}

function dropCollinear(ring) {
  const out = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[(i + n - 1) % n], b = ring[i], c = ring[(i + 1) % n];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) out.push(b);
  }
  return out;
}

/** Signed area of a ring (positive = clockwise on screen with v down). */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Douglas-Peucker simplification of a closed ring to `tol` chart units. Keeps at least 4 points. */
export function simplifyRing(ring, tol = 0.6) {
  const n = ring.length;
  if (n <= 4) return ring.slice();
  // Split at the two farthest-apart points so a closed ring has stable anchors.
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const d = (ring[i][0] - ring[0][0]) ** 2 + (ring[i][1] - ring[0][1]) ** 2;
    if (d > fd) { fd = d; far = i; }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const stack = [[0, far], [far, n]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = ring[a], B = ring[b % n];
    const dx = B[0] - A[0], dy = B[1] - A[1], L = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((ring[i][0] - A[0]) * dy - (ring[i][1] - A[1]) * dx) / L;
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i]);
  return out.length >= 3 ? out : ring.slice(0, 4);
}

// ------------------------------------------------------------------------------------------------ the practice sea

/**
 * An invented sea for servers without Daggerfall's files: a sound between a northern and a southern shore with two
 * islands, and three invented ports. It is not Daggerfall geography and is labelled so everywhere; its ids start
 * with `fallback:` so they can never be mistaken for a classic location. 48 x 32 map pixels at Daggerfall's scale.
 */
export const FALLBACK_SEA = Object.freeze({
  id: 'fallback:practice-sound',
  label: 'Practice Sound (fallback sea, not Daggerfall)',
  fallback: true,
  width: 48,
  height: 32,
  ports: Object.freeze([
    { name: 'Northmere', px: 9, py: 9 },
    { name: 'Saltreach', px: 26, py: 23 },
    { name: 'Gullhaven', px: 21, py: 13 }, // on the larger island
  ]),
});

/**
 * Land height of the practice sea at a world point (metres; > 0 is land). Smooth, so every scale of the coast agrees.
 */
export function fallbackRelief(x, z) {
  const u = x / CHART_METRES, v = z / CHART_METRES;
  const wobble = 0.9 * Math.sin(u * 0.55) + 0.6 * Math.sin(u * 1.7 + 1.3) + 0.25 * Math.sin(u * 4.1 + v);
  const north = 8.5 + wobble - v; // northern shore around v = 8.5
  const south = v - (23.5 + 0.8 * Math.sin(u * 0.4 + 2) + 0.4 * Math.sin(u * 2.3)); // southern shore around v = 23.5
  const isle = (cu, cv, ru, rv) => 1 - ((u - cu) / ru) ** 2 - ((v - cv) / rv) ** 2;
  const islands = Math.max(isle(20, 15, 3.2, 2.2), isle(33, 18, 1.8, 1.3));
  const west = 1.2 - u; // a western headland closes the sound's west end
  return Math.max(north, south, islands, west) * 30;
}
