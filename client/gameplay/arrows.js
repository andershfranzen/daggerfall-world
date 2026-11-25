// World-space combat arrows. The server owns the trajectory, hit and ammo.
import { identity, rotateX, rotateY } from '../lib/mat.js';
import { indexFiles } from '../world/files.js';
import { buildScene, IDENTITY, ModelLibrary } from '../world/interiors/scene.js';

const FLIGHT_DELAY = 0.12; // Match the delay used by the peer position buffers.
const IMPACT_HOLD = { target: 0.16, wall: 0.24, range: 0 };
const IMPACT_FRAME_GRACE = 0.30;

function loadArrow(files) {
  return buildScene(new ModelLibrary(indexFiles(files)), [{ modelId: 99800, matrix: IDENTITY }], { label: 'Arrow' });
}

export function install(api, { load = loadArrow, now = () => performance.now() / 1000 } = {}) {
  const arrows = new Map();
  let mesh = null;
  let source = null;
  let renderer = null;
  let detach = null;

  async function assets(files) {
    if (!files?.length || files === source) return;
    source = files;
    if (mesh) renderer?.release(mesh);
    mesh = null;
    arrows.clear();
    try {
      const loaded = await load(files);
      if (source !== files) return;
      mesh = loaded;
      renderer?.retain(mesh);
    } catch (err) {
      if (source === files) {
        source = null;
        console.warn('[arrows] Classic arrow model unavailable:', err.message);
      }
    }
  }

  function event(ev) {
    if (!api.location || ev?.location !== api.location || api.screen !== 'game') return;
    const { kind, projectileId, x, y, z, dx, dy, dz, speed, range, reason } = ev;
    if (!Number.isSafeInteger(projectileId)) return;
    if (kind === 'arrowLaunch') {
      if (![x, y, z, dx, dy, dz, speed, range].every(Number.isFinite) || speed <= 0 || range <= 0 ||
          arrows.has(projectileId) || Math.abs(Math.hypot(dx, dy, dz) - 1) > 0.001) return;
      const model = identity();
      rotateY(model, model, -Math.atan2(dx, -dz));
      rotateX(model, model, Math.asin(Math.max(-1, Math.min(1, dy))));
      const starts = now() + FLIGHT_DELAY;
      arrows.set(projectileId, { x, y, z, dx, dy, dz, speed, range, starts, ends: starts + range / speed, model });
    } else if (kind === 'arrowImpact') {
      const a = arrows.get(projectileId);
      if (!a || a.impact) return;
      if (reason === 'cancelled') {
        arrows.delete(projectileId);
        return;
      }
      if (!Object.hasOwn(IMPACT_HOLD, reason) || ![x, y, z].every(Number.isFinite)) return;
      const distance = (x - a.x) * a.dx + (y - a.y) * a.dy + (z - a.z) * a.dz;
      a.ends = a.starts + Math.max(0, Math.min(a.range, distance)) / a.speed;
      a.impact = { x, y, z };
      a.hold = IMPACT_HOLD[reason];
      // Give a slow rendering frame a chance to present the contact, within a
      // bounded window so returning to a backgrounded tab cannot revive it.
      a.retires = a.hold ? Math.max(a.ends, now()) + IMPACT_FRAME_GRACE : a.ends;
    }
  }

  function draw() {
    const time = now();
    const transforms = [];
    for (const [id, a] of arrows) {
      if (time >= (a.retires ?? a.ends)) {
        arrows.delete(id);
        continue;
      }
      if (!mesh || time < a.starts) continue;
      const distance = (time - a.starts) * a.speed;
      const arrived = a.impact && time >= a.ends;
      if (arrived && !a.showingImpact) {
        a.showingImpact = true;
        a.retires = time + a.hold;
      }
      const { x, y, z } = arrived ? a.impact : {
        x: a.x + a.dx * distance, y: a.y + a.dy * distance, z: a.z + a.dz * distance,
      };
      // A late or private impact can leave only the launch on this client. Avoid
      // drawing the predicted shaft through an intervening wall while it expires.
      if (!a.impact && api.canSee?.(a.x, a.z, x, z, { y1: a.y, y2: y, eye: 0, eye2: 0 }) === false) continue;
      a.model[12] = x;
      a.model[13] = y;
      a.model[14] = z;
      transforms.push(a.model);
    }
    if (transforms.length) renderer.drawModels(mesh, transforms);
  }

  function attach({ renderer: next }) {
    if (!next || next === renderer) return;
    detach?.();
    if (mesh) renderer?.release(mesh);
    renderer = next;
    if (mesh) renderer.retain(mesh);
    detach = renderer.addPass(draw);
  }

  api.on('assets', assets);
  api.on('frame', attach);
  api.on('event', event);
  api.on('location', () => arrows.clear());
  api.on('screen', (screen) => { if (screen !== 'game') arrows.clear(); });
  api.on('connection', (state) => { if (state !== 'online') arrows.clear(); });
}
