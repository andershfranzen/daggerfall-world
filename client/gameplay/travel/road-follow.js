// Road-following and junction navigation across map-pixel boundaries (DFU Travel Options / DFO parity).
// Pure route/junction/boundary guidance model + browser HUD feature install(api).
// Works continuously from a town gate through road junctions and across wilderness:<px>,<py> pixel seams.

import { METRES_PER_PIXEL, parseWildernessId } from '../wildernessMap.js';

export const JUNCTION_ALERT_METRES = 55;
export const ARRIVAL_RADIUS_METRES = 36;
export const OFF_ROAD_TOLERANCE_RAD = 0.28; // ~16 deg

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/** Convert a world pixel + local offset into continuous global metres (origin at pixel 0,0 NW corner). */
export function globalMetres(pixel, localX = 0, localZ = 0) {
  const px = Number.isFinite(pixel?.px) ? pixel.px : 0;
  const py = Number.isFinite(pixel?.py) ? pixel.py : 0;
  return {
    gx: (px + 0.5) * METRES_PER_PIXEL + (Number.isFinite(localX) ? localX : 0),
    gz: (py + 0.5) * METRES_PER_PIXEL + (Number.isFinite(localZ) ? localZ : 0),
  };
}

/** Compass bearing in radians (0 = north / -z, +π/2 = east / +x) from a to b. */
export function bearingRad(ax, az, bx, bz) {
  return Math.atan2(bx - ax, -(bz - az));
}

export function compassForRad(rad) {
  const deg = ((rad * 180) / Math.PI + 360) % 360;
  const i = Math.round(deg / 45) % 8;
  return { degrees: Math.round(deg), short: COMPASS[i], arrow: ARROWS[i] };
}

/**
 * Build a deterministic continuous road route from origin pixel through intermediate pixel waypoints
 * and road junctions to a destination pixel (e.g. town gate → junction → across map-pixel boundary → destination).
 * Each waypoint has { id, px, py, localX, localZ, label, kind: 'gate'|'junction'|'crossing'|'destination', branches? }.
 */
export function planRoadRoute({ from, to, junctions = [] }) {
  if (!from || !to || !Number.isFinite(from.px) || !Number.isFinite(from.py) || !Number.isFinite(to.px) || !Number.isFinite(to.py)) {
    throw new Error('planRoadRoute requires valid from and to map pixels');
  }
  const start = {
    id: 'start',
    px: from.px,
    py: from.py,
    localX: Number.isFinite(from.localX) ? from.localX : 0,
    localZ: Number.isFinite(from.localZ) ? from.localZ : 0,
    label: from.label || `Origin (${from.px},${from.py})`,
    kind: 'gate',
  };
  const end = {
    id: 'dest',
    px: to.px,
    py: to.py,
    localX: Number.isFinite(to.localX) ? to.localX : 0,
    localZ: Number.isFinite(to.localZ) ? to.localZ : 0,
    label: to.label || `Destination (${to.px},${to.py})`,
    kind: 'destination',
  };

  const waypoints = [start];

  // Add explicit or synthesized intermediate road junctions and pixel-boundary crossings.
  const dx = end.px - start.px;
  const dy = end.py - start.py;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));

  if (Array.isArray(junctions) && junctions.length) {
    for (let i = 0; i < junctions.length; i++) {
      const j = junctions[i];
      if (!Number.isFinite(j?.px) || !Number.isFinite(j?.py)) continue;
      waypoints.push({
        id: j.id || `junction-${i + 1}`,
        px: j.px,
        py: j.py,
        localX: Number.isFinite(j.localX) ? j.localX : 0,
        localZ: Number.isFinite(j.localZ) ? j.localZ : 0,
        label: j.label || `Road Junction ${i + 1}`,
        kind: 'junction',
        branches: Array.isArray(j.branches) ? j.branches : [],
      });
    }
  } else if (steps >= 1) {
    // Synthesize a road junction near the first pixel crossing so players get realistic fork guidance.
    for (let s = 1; s <= steps; s++) {
      const t = s / (steps + 1);
      const midPx = Math.round(start.px + dx * t);
      const midPy = Math.round(start.py + dy * t);
      const isJunction = s === 1;
      const gxFrom = globalMetres(start, start.localX, start.localZ);
      const gxTo = globalMetres(end, end.localX, end.localZ);
      const mainBearing = bearingRad(gxFrom.gx, gxFrom.gz, gxTo.gx, gxTo.gz);
      const leftPx = midPx + Math.round(Math.sin(mainBearing - Math.PI / 2));
      const leftPy = midPy - Math.round(Math.cos(mainBearing - Math.PI / 2));
      const rightPx = midPx + Math.round(Math.sin(mainBearing + Math.PI / 2));
      const rightPy = midPy - Math.round(Math.cos(mainBearing + Math.PI / 2));
      waypoints.push({
        id: isJunction ? 'junction-1' : `crossing-${s}`,
        px: midPx,
        py: midPy,
        localX: 0,
        localZ: 0,
        label: isJunction ? `Crossroads (${midPx},${midPy})` : `Pixel Border (${midPx},${midPy})`,
        kind: isJunction ? 'junction' : 'crossing',
        branches: isJunction ? [
          { id: 'straight', direction: 'Straight', label: end.label, to: { px: end.px, py: end.py, label: end.label } },
          { id: 'left', direction: 'Left fork', label: `Wilderness (${leftPx},${leftPy})`, to: { px: leftPx, py: leftPy, label: `Wilderness (${leftPx},${leftPy})` } },
          { id: 'right', direction: 'Right fork', label: `Wilderness (${rightPx},${rightPy})`, to: { px: rightPx, py: rightPy, label: `Wilderness (${rightPx},${rightPy})` } },
        ] : [],
      });
    }
  }

  waypoints.push(end);

  // Precompute global coordinates and total distance
  let totalMetres = 0;
  const enriched = waypoints.map((wp) => ({ ...wp, ...globalMetres(wp, wp.localX, wp.localZ) }));
  for (let i = 1; i < enriched.length; i++) {
    totalMetres += Math.hypot(enriched[i].gx - enriched[i - 1].gx, enriched[i].gz - enriched[i - 1].gz);
  }

  return {
    id: `route:${start.px},${start.py}->${end.px},${end.py}`,
    destination: end.label,
    waypoints: enriched,
    currentIndex: enriched.length > 1 ? 1 : 0,
    totalMetres: Math.round(totalMetres),
    crossingsPassed: 0,
    autoFollow: false,
    arrived: false,
  };
}

/**
 * Evaluate live road-following guidance given player's current pixel, local coordinates, and yaw.
 * Seamlessly tracks progress across map-pixel boundaries without losing route continuity.
 */
export function stepRoadGuidance(route, { pixel, x = 0, z = 0, yaw = 0 }) {
  if (!route || !Array.isArray(route.waypoints) || !route.waypoints.length || !pixel) return null;
  const pos = globalMetres(pixel, x, z);
  let idx = Math.max(0, Math.min(route.waypoints.length - 1, route.currentIndex));

  // Advance waypoint when within arrival radius
  while (idx < route.waypoints.length - 1) {
    const wp = route.waypoints[idx];
    const d = Math.hypot(wp.gx - pos.gx, wp.gz - pos.gz);
    if (d <= ARRIVAL_RADIUS_METRES) {
      if (wp.kind === 'crossing' || (wp.px !== route.waypoints[Math.max(0, idx - 1)].px || wp.py !== route.waypoints[Math.max(0, idx - 1)].py)) {
        route.crossingsPassed = (route.crossingsPassed || 0) + 1;
      }
      idx++;
      route.currentIndex = idx;
    } else {
      break;
    }
  }

  const target = route.waypoints[idx];
  const finalWp = route.waypoints[route.waypoints.length - 1];
  const distToNext = Math.hypot(target.gx - pos.gx, target.gz - pos.gz);
  const distToFinal = Math.hypot(finalWp.gx - pos.gx, finalWp.gz - pos.gz);

  if (idx === route.waypoints.length - 1 && distToFinal <= ARRIVAL_RADIUS_METRES) {
    route.arrived = true;
  }

  const desiredYaw = bearingRad(pos.gx, pos.gz, target.gx, target.gz);
  const deltaYaw = wrapAngle(desiredYaw - (Number.isFinite(yaw) ? yaw : 0));
  const compass = compassForRad(desiredYaw);
  let steerCue = 'On road';
  if (route.arrived) steerCue = 'Arrived';
  else if (deltaYaw > OFF_ROAD_TOLERANCE_RAD) steerCue = 'Bear right';
  else if (deltaYaw < -OFF_ROAD_TOLERANCE_RAD) steerCue = 'Bear left';

  const activeJunction = target.kind === 'junction' && distToNext <= JUNCTION_ALERT_METRES && target.branches?.length
    ? { id: target.id, label: target.label, distance: Math.round(distToNext), branches: target.branches }
    : null;

  return {
    destination: route.destination,
    pixel: { px: pixel.px, py: pixel.py },
    nextWaypoint: target,
    distanceToNext: Math.round(distToNext),
    distanceRemaining: Math.round(distToFinal),
    desiredYaw,
    deltaYaw,
    compass,
    steerCue,
    activeJunction,
    arrived: route.arrived,
    crossingsPassed: route.crossingsPassed || 0,
  };
}

/** Reroute from a junction onto one of its branch targets. */
export function selectJunctionBranch(route, branchId, currentPixel, localX = 0, localZ = 0) {
  if (!route) return null;
  const wp = route.waypoints?.[route.currentIndex];
  const branch = wp?.branches?.find((b) => b.id === branchId);
  if (!branch?.to) return route;
  const next = planRoadRoute({
    from: { px: currentPixel.px, py: currentPixel.py, localX, localZ, label: wp.label },
    to: branch.to,
  });
  next.autoFollow = route.autoFollow;
  next.crossingsPassed = route.crossingsPassed;
  return next;
}

/** Resolve current map pixel from location string, town source, or wilderness state. */
export function currentPixelFor(api) {
  const fromWild = parseWildernessId(api.location);
  if (fromWild) return fromWild;
  const src = api.town?.source;
  if (src && Number.isFinite(src.longitude) && Number.isFinite(src.latitude)) {
    return { px: Math.trunc(src.longitude / 128), py: 499 - Math.trunc(src.latitude / 128) };
  }
  const orig = api.character?.wilderness?.origin;
  if (orig && Number.isFinite(orig.px) && Number.isFinite(orig.py)) return { px: orig.px, py: orig.py };
  return null;
}

// ------------------------------------------------------------------ feature install

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};

export function install(api) {
  let activeRoute = null;
  let lastGuidance = null;
  let hudBox = null;
  let lastPixelKey = null;

  function ensureHud() {
    if (typeof document === 'undefined') return null;
    if (hudBox) return hudBox;
    const hud = document.getElementById('hud');
    if (!hud) return null;
    hudBox = el('aside', { id: 'hud-road-follow', class: 'road-hud', 'aria-label': 'Road guidance', hidden: true });
    hud.append(hudBox);
    return hudBox;
  }

  function startRoute(to, { junctions = [] } = {}) {
    const px = currentPixelFor(api);
    if (!px) {
      api.message('Road guidance is available outdoors in towns and wilderness.', { kind: 'error' });
      return null;
    }
    const cam = api.camera ?? { x: 0, z: 0, yaw: 0 };
    activeRoute = planRoadRoute({
      from: { px: px.px, py: px.py, localX: cam.x, localZ: cam.z, label: api.location || 'Here' },
      to,
      junctions,
    });
    lastPixelKey = `${px.px},${px.py}`;
    update();
    return activeRoute;
  }

  function clearRoute() {
    activeRoute = null;
    lastGuidance = null;
    if (hudBox) hudBox.hidden = true;
  }

  function update() {
    const box = ensureHud();
    if (!activeRoute) {
      if (box) box.hidden = true;
      return null;
    }
    const px = currentPixelFor(api);
    if (!px) {
      if (box) box.hidden = true;
      return null;
    }
    const pixelKey = `${px.px},${px.py}`;
    if (lastPixelKey && pixelKey !== lastPixelKey) {
      activeRoute.crossingsPassed = (activeRoute.crossingsPassed || 0) + 1;
      lastPixelKey = pixelKey;
    }
    const cam = api.camera ?? { x: 0, z: 0, yaw: 0 };
    lastGuidance = stepRoadGuidance(activeRoute, { pixel: px, x: cam.x, z: cam.z, yaw: cam.yaw });
    if (!box || !lastGuidance || api.screen !== 'game') {
      if (box) box.hidden = true;
      return lastGuidance;
    }

    box.hidden = false;
    const g = lastGuidance;
    const parts = [
      el('span', { class: 'road-cue', text: `${g.compass.arrow} ${g.compass.short}` }),
      el('span', { text: `${g.destination} · ${g.distanceRemaining} m (${g.steerCue})` }),
      el('span', { class: 'road-cue', text: `Pixel ${g.pixel.px},${g.pixel.py}` }),
      el('button', { type: 'button', class: 'btn btn-small', onclick: clearRoute, text: 'Stop' }),
    ];
    if (g.activeJunction) {
      parts.push(el('div', { class: 'road-junction-bar' },
        el('span', { text: `${g.activeJunction.label} (${g.activeJunction.distance}m): ` }),
        ...g.activeJunction.branches.map((br) => el('button', {
          type: 'button', class: 'btn btn-small',
          onclick: () => {
            activeRoute = selectJunctionBranch(activeRoute, br.id, px, cam.x, cam.z);
            update();
          },
          text: `${br.direction}: ${br.label}`,
        }))));
    }
    box.replaceChildren(...parts);
    return g;
  }

  let lastFrame = 0;
  api.on('frame', () => {
    if (!activeRoute) return;
    const now = Date.now();
    if (now - lastFrame > 250) {
      lastFrame = now;
      update();
    }
  });
  api.on('location', () => update());
  api.on('screen', () => update());

  api.roadFollow = {
    startRoute,
    clearRoute,
    get route() { return activeRoute; },
    get guidance() { return lastGuidance; },
    chooseBranch: (branchId) => {
      const px = currentPixelFor(api);
      if (!activeRoute || !px) return null;
      const cam = api.camera ?? { x: 0, z: 0 };
      activeRoute = selectJunctionBranch(activeRoute, branchId, px, cam.x, cam.z);
      return update();
    },
  };
  return api.roadFollow;
}

export default { name: 'roadFollow', install };
