// Browser collision prediction (docs/gameplay-protocol.md feature module).
//
// Builds the same CollisionWorld the server enforces from the scene mesh the shell already
// loaded from the player's files, and exposes api.constrainMove(x0,z0,x1,z1) -> {x,z} so the
// predictor stops at walls instead of being corrected a moment later. Prediction only: the
// browser never sends positions or collision results; the server decides.
import { worldFromTown } from './collision/world.js';
import { indoorFloor } from '../lib/ground.js';
import { exteriorCollision } from './collision/exterior.js';
import { HALF, BLOCK } from '../world/exterior/frame.js';
import { cityGatesClosed, isCityGateId } from '../world/cityGates.js';

export const name = 'collision';

export function install(api) {
  let world = null;
  let worldLocation = null;
  let walkEvent = null;
  let overlap = null; // the last pixel's solid border, projected into a cold destination
  let currentMesh = null;
  let retry = null;
  let serverStatus = null;
  let localError = null; // {location, message}: the last scene that yielded no collision here
  let dungeonState = { location: null, active: new Set() };
  const body = { y: null };

  const exterior = exteriorCollision(town => api.exterior.load(town.id),
    id => isCityGateId(id) && cityGatesClosed(api.worldMinutes?.()));
  api.on('exteriorScene', ({ mesh, status }) => {
    if (status === 'ready') return exterior.prepare(mesh).promise.catch(() => {}); // activation retries
    else if (status === 'evicted' && mesh !== currentMesh) exterior.release(mesh);
  });

  function pixelSurface(from, to) {
    const stream = api.exterior?.stream;
    const pixel = stream?.pixelOf(from);
    if (!pixel) return null;
    const id = `wilderness:${pixel.px},${pixel.py}`;
    const surface = exterior.world(api.exterior.ready(id));
    const shift = surface && stream.crossing(id, to);
    return shift ? { world: surface, shift, location: to } : null;
  }

  async function useScene(mesh) {
    clearTimeout(retry);
    currentMesh = mesh;
    world = null;
    localError = null;
    worldLocation = mesh?.location ?? mesh?.source?.townId ?? api.location;
    body.y = indoorFloor(mesh, api.character?.portal);
    if (!mesh || !(mesh.positions instanceof Float32Array)) {
      if (mesh) localError = { location: worldLocation, message: 'the scene has no geometry' };
      return;
    }
    try {
      if (mesh.wilderness || (mesh.source?.townId && !mesh.kind) || mesh.kind === 'town' || mesh.kind === 'exterior') {
        const entry = exterior.prepare(mesh);
        const built = entry.world ?? await entry.promise;
        if (currentMesh === mesh && built) {
          world = built;
          overlap = null;
        }
      } else {
        world = worldFromTown(mesh, {
          mechanismActive: (id) => dungeonState.location === mesh.location && dungeonState.active.has(id),
        });
      }
    } catch (err) {
      if (currentMesh !== mesh) return;
      localError = { location: worldLocation, message: err?.message ?? String(err) };
      console.warn('[collision] scene has no usable geometry:', err);
      if (mesh.wilderness) {
        retry = setTimeout(() => {
          if (currentMesh === mesh && worldLocation === api.location) useScene(mesh);
        }, 15000);
      }
    }
  }

  function mode() {
    if (serverStatus && serverStatus.location === api.location) {
      if (serverStatus.status === 'unavailable' || serverStatus.status === 'loading') return 'hold';
      // Older servers also report "fallback" for a wilderness pixel they cannot load.
      if (serverStatus.status === 'fallback') return /^(wilderness|dungeon|interior):/.test(api.location ?? '') ? 'hold' : 'free';
    }
    return (world && worldLocation === api.location) || (overlap && overlap.location === api.location) ? 'solid' : 'hold';
  }
  api.collisionReady = () => mode() !== 'hold';
  /**
   * This browser's own collision for a location (main.js arrival gate): 'ready' once the walls of `location`
   * are built here, 'failed' when its scene has no usable geometry, else 'loading'.
   */
  api.collisionLocal = (location = api.location) => {
    if (world && worldLocation === location) return 'ready';
    if (localError && localError.location === location) return 'failed';
    return 'loading';
  };
  api.constrainMove = (x0, z0, x1, z1) => {
    const state = mode();
    if (state === 'hold') return { x: x0, z: z0 };
    if (state === 'free') return { x: x1, z: z1 };
    let surface = world && worldLocation === api.location ? null : overlap;
    if (world?.openEdges && !world.inBounds(x1, z1)) {
      // A snapshot may acknowledge the walk a few frames after the camera reaches
      // the seam. Keep moving over the same checked ground until the frame changes.
      surface = pixelSurface(api.location, api.location);
    }
    if (surface) {
      const { x, y, z } = surface.shift;
      // Only one block beyond this pixel is guaranteed to contain all town walls.
      if (Math.max(Math.abs(x1 - x), Math.abs(z1 - z)) > HALF + BLOCK - 1) return { x: x0, z: z0 };
      const feet = { y: Number.isFinite(body.y) ? body.y - y : null };
      const m = surface.world.move(x0 - x, z0 - z, x1 - x, z1 - z, feet);
      body.y = m.y + y;
      return { x: m.x + x, z: m.z + z };
    }
    const m = world.move(x0, z0, x1, z1, body);
    return { x: m.x, z: m.z };
  };
  /**
   * The collision world the shared locomotion rule (client/lib/locomotion.js) steps the local body in, or
   * null while it is not this location's own built world (loading, seam overlap, open fallback): main.js
   * then predicts with constrainMove only.
   */
  api.locomotionWorld = () => (mode() === 'solid' && world && worldLocation === api.location ? world : null);
  /** Line of sight for UI hints (targeting); the server's answer is authoritative. */
  api.canSee = (x1, z1, x2, z2, opts) => (world ? world.canSee(x1, z1, x2, z2, opts) : true);
  api.groundAt = (x, z, footY = null) => world
    ? (Number.isFinite(footY) ? world.heightAt(x, z, footY) : world.standHeight(x, z)) : null;

  api.on('scene', useScene);
  api.on('assets', () => {
    if (currentMesh && localError) useScene(currentMesh);
  });
  api.on('location', ({ location, previous } = {}) => {
    overlap = walkEvent && walkEvent.from === previous && walkEvent.to === location ? pixelSurface(previous, location) : null;
    walkEvent = null;
    if (previous == null && worldLocation == null) worldLocation = location;
    if (worldLocation !== location) {
      clearTimeout(retry);
      currentMesh = null;
      world = null;
      body.y = null;
    }
    if (serverStatus?.location !== location) serverStatus = null;
  });
  api.on('event', (ev) => {
    if (ev?.kind === 'overland' && ev.status === 'moved') walkEvent = ev;
    if (ev?.kind === 'dungeonState') dungeonState = { location: ev.location, active: new Set(ev.active) };
    if (ev?.kind === 'teleport' && ev.location === api.location) body.y = ev.y;
    if (ev?.kind !== 'collision') return;
    const location = ev.location ?? api.location;
    if (!api.location || api.location === location) serverStatus = { location, status: ev.status };
  });
  api.on('screen', (screen) => {
    if (screen === 'landing') {
      clearTimeout(retry);
      serverStatus = null;
      walkEvent = overlap = null;
    }
  });
  if (api.town) useScene(api.town);
}
