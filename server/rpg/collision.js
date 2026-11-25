// Server-authoritative player collision (docs/gameplay-protocol.md feature module).
//
// Geometry comes from the operator's ARENA2 data through the browser's own town loader, so
// server and client agree on layout, scale (0.025 m per unit) and spawn (origin). Nothing is
// baked or shipped. The browser predicts with the same CollisionWorld but never reports a
// position: the server moves every player through ctx.services.movePlayer each tick.
//
// Services:
//   movePlayer(p, x, z) -> {x, z}                     legacy horizontal-only step (tests, old loops)
//   stepPlayer(p, input, dt, speed?) -> {x, z, y, moving}  full locomotion step (client/lib/locomotion.js):
//       gravity, jumping, falling, crouch, climbing, swimming and levitation; called by the game loop per tick.
//       Consequences are reported through services.locomotionEvents(p, events); modifiers come from
//       services.locomotionMods(p) (server/rpg/locomotion.js).
//   locomotion.bodyOf(p) -> {y, mode, crouch, running, slow, speed, breath} | null
//   canSee(location, x1, z1, x2, z2, opts?) -> bool    eye-level line of sight for spells/AI
//   collision.status(location) -> {status, source, reason}
//   collision.isClear(location, x, z, footY?) / nearestClear(location, x, z, maxDist?, footY?)
//   collision.groundAt(location, x, z, footY?) uses the authored elevation for stacked floors.
//   collision.whenSettled(location) -> Promise          (tests, travel warm-up)
//   collision.preload(location)                         start loading ahead of arrival
//
// While an area loads, players in it hold position (no teleport later, no unchecked moves),
// and canSee answers false. When operator data is missing, a bounded open plane stands in and
// every player there gets a `collision` game event saying so.
import { HALF } from '../../client/world/exterior/frame.js';
import { parseWildernessId } from '../../client/world/wilderness/data.js';
import { AreaCache } from './collision/areas.js';
import { arena2Loader } from './collision/arena2.js';
import { openPlaneWorld } from '../../client/gameplay/collision/world.js';
import { canResumeSwim, canResumeWaterWalk, newBody, stepBody, normalizeMods, publicBody } from '../../client/lib/locomotion.js';

export const name = 'collision';

const SWEEP_MS = 5_000;

/**
 * @param {object} ctx  runtime context
 * @param {object} [options]
 * @param {(location:string) => Promise<{world, source}>} [options.load]  geometry source (default: ARENA2 via ctx.dataPath)
 * @param {Record<string, object>} [options.fixtures]  location -> CollisionWorld, used before the loader
 * @param {boolean} [options.preloadDefault=true]
 * @param {object} [options.cache]  AreaCache options (maxAreas, idleMs, loadTimeoutMs, retryFailedMs)
 */
export function createCollision(ctx, options = {}) {
  const half = Number.isFinite(ctx.config?.worldHalfExtent) ? ctx.config.worldHalfExtent : 512;
  const baseLoad = options.load ?? arena2Loader(ctx.dataPath, ctx.services);
  const fixtures = options.fixtures ?? {};
  const log = ctx.log ?? console;
  const bodies = new WeakMap(); // player -> locomotion body (client/lib/locomotion.js) + {location}
  const told = new WeakMap(); // player -> "location|status" last announced

  const cache = new AreaCache({
    ...(options.cache || {}),
    load: async (location) => {
      if (fixtures[location]) return { world: fixtures[location], source: 'fixture' };
      return baseLoad(location);
    },
    fallback: (location) => ctx.dataPath
      ? { world: null, source: 'ARENA2' }
      : { world: openPlaneWorld(half, `open plane for ${location}`), source: 'open plane' },
    onSettled: (area) => {
      if (area.status === 'fallback') log.warn?.(`[collision] ${area.location}: no collision geometry (${area.reason}); using an open plane`);
      if (area.status === 'unavailable') log.warn?.(`[collision] ${area.location}: ${area.reason}; holding movement until geometry loads`);
      for (const p of ctx.players.values()) if (ctx.location(p) === area.location) announce(p, area);
    },
  });

  function statusEvent(area) {
    if (area.status === 'unavailable') return {
      kind: 'collision', status: area.status, location: area.location,
      text: 'Movement is paused while the server retries loading this area.',
    };
    if (area.status === 'fallback') {
      return {
        kind: 'collision',
        status: 'fallback',
        location: area.location,
        text: 'Walls are not solid here because the server has no game data for this area.',
        reason: area.reason,
      };
    }
    return { kind: 'collision', status: area.status, location: area.location, source: area.source };
  }

  /** Tell a player once per location/status change. Silent for the normal ready case after the first. */
  function announce(p, area) {
    if (area.status === 'loading') return;
    const key = `${area.location}|${area.status}`;
    if (told.get(p) === key) return;
    told.set(p, key);
    try {
      ctx.notify(p, statusEvent(area));
    } catch {}
  }

  // A town doorway may land above the street. Record the floor with its position so an unrelated move
  // or an old location cannot use it, and keep it current while walking away from that doorway.
  function rememberTownFloor(p, location, x, z, y) {
    if (!location.startsWith('town:') || !Number.isFinite(y)) return;
    y = Math.round(y * 1000) / 1000;
    const floor = p.rpg.townFloor;
    if (floor?.location === location && floor.x === x && floor.z === z && floor.y === y) return;
    p.rpg.townFloor = { location, x, z, y };
    p.dirty = true;
  }

  function bodyOf(p, location, world) {
    let b = bodies.get(p);
    if (!b || b.location !== location) {
      const portal = p.rpg?.portal;
      const floor = p.rpg?.townFloor;
      const townY = floor?.location === location && floor.x === p.x && floor.z === p.z ? floor.y : null;
      const arrival = p.arrival?.location === location && p.arrival.x === p.x && p.arrival.z === p.z ? p.arrival.y : null;
      const saved = portal?.to === location ? portal.footY : townY ?? arrival;
      const swimming = portal?.to === location && canResumeSwim(world, p.x, p.z, portal);
      const waterWalking = portal?.to === location && ctx.services.magicStatus?.(p)?.waterWalking
        && canResumeWaterWalk(world, p.x, p.z, portal);
      // Old saves have no foot height: the instance entry floor (standHeight) applies.
      const y = swimming || waterWalking ? saved : Number.isFinite(saved) ? world.heightAt(p.x, p.z, saved) : null;
      b = Object.assign(newBody(p.x, p.z, y), { location });
      if (swimming) {
        b.mode = 'swim';
        if (Number.isFinite(portal.breath)) b.breath = Math.max(0, portal.breath);
      }
      if (b.y === null) b.y = world.standHeight(p.x, p.z);
      bodies.set(p, b);
    }
    return b;
  }

  function movePlayer(p, x, z) {
    const location = ctx.location(p);
    const area = cache.get(location);
    if (!area.world || (area.status !== 'ready' && ctx.services.interiors?.isInstance(location))) return { x: p.x, z: p.z };
    if (parseWildernessId(location) && ctx.services.overland) {
      // Only the crossing service may enter a different pixel. The collision
      // mesh extends past it so the service can sweep across the seam.
      if (area.status !== 'ready') return { x: p.x, z: p.z };
      x = Math.max(-HALF, Math.min(HALF, x));
      z = Math.max(-HALF, Math.min(HALF, z));
    }
    announce(p, area);
    const b = bodyOf(p, location, area.world);
    const m = area.world.move(p.x, p.z, x, z, b);
    if (area.status === 'ready' && p.rpg?.portal?.to === location) {
      p.rpg.portal.footY = Math.round(m.y * 1000) / 1000;
    }
    return { x: m.x, z: m.z };
  }

  /**
   * One authoritative locomotion step. `input` = {forward, strafe, yaw, run, slow, crouch, rise, jumpSeq}
   * (already validated by the game loop; zeros when the client stopped sending). `speed` is the ground
   * speed from services.moveSpeed (horseback) or undefined for walking.
   */
  function stepPlayer(p, input, dt, speed) {
    const location = ctx.location(p);
    const area = cache.get(location);
    if (!area.world || (area.status !== 'ready' && ctx.services.interiors?.isInstance(location))) return { x: p.x, z: p.z, moving: false };
    const wild = parseWildernessId(location) && ctx.services.overland;
    if (wild && area.status !== 'ready') return { x: p.x, z: p.z, moving: false };
    announce(p, area);
    const world = area.world;
    const b = bodyOf(p, location, world);
    b.x = p.x; b.z = p.z;
    let mods;
    try {
      mods = normalizeMods({ ...(ctx.services.locomotionMods?.(p) ?? {}), ...(Number.isFinite(speed) && speed > 0 ? { baseSpeed: speed, mounted: true } : {}) });
    } catch (err) {
      log.error?.('[collision] locomotionMods failed:', err.message);
      mods = normalizeMods({});
    }
    const events = stepBody(world, b, input, dt, mods);
    if (wild) {
      // Only the crossing service may enter a different pixel.
      b.x = Math.max(-HALF, Math.min(HALF, b.x));
      b.z = Math.max(-HALF, Math.min(HALF, b.z));
    }
    const portal = p.rpg?.portal;
    if (area.status === 'ready' && portal?.to === location && (b.mode === 'ground' || b.mode === 'swim')) {
      const y = Math.round(b.y * 1000) / 1000;
      const swimming = b.mode === 'swim';
      const breath = swimming ? Math.round(b.breath) : undefined;
      if (portal.footY !== y || (portal.swimming === true) !== swimming || portal.breath !== breath) {
        portal.footY = y;
        if (swimming) {
          portal.swimming = true;
          portal.breath = breath;
        } else {
          delete portal.swimming;
          delete portal.breath;
        }
        p.dirty = true;
      }
    }
    if (area.status === 'ready' && b.mode === 'ground' && p.rpg?.townFloor?.location === location) {
      rememberTownFloor(p, location, b.x, b.z, b.y);
    }
    // Transient traversal facts other owners read (combat stealth, AI): metres per second actually
    // covered this tick and the current foot height in this location's frame.
    p.motionSpeed = b.speed;
    p.footY = b.y;
    if (events.length && typeof ctx.services.locomotionEvents === 'function') {
      try { ctx.services.locomotionEvents(p, events, b); } catch (err) { log.error?.('[collision] locomotionEvents failed:', err.message); }
    }
    return { x: b.x, z: b.z, y: b.y, moving: b.moving };
  }

  function canSee(location, x1, z1, x2, z2, opts) {
    if (![x1, z1, x2, z2].every(Number.isFinite)) return false;
    const area = cache.get(String(location));
    if (!area.world) return false;
    return area.world.canSee(x1, z1, x2, z2, opts);
  }

  const settledWorld = (location) => {
    const a = cache.get(String(location));
    return a.status === 'loading' ? null : a.world;
  };

  const service = {
    resetBody: (p) => bodies.delete(p),
    rememberTownFloor,
    /** The live locomotion body of a player in their current location, or null before their first step. */
    bodyOf: (p) => {
      const b = bodies.get(p);
      return b && b.location === ctx.location(p) ? b : null;
    },
    /**
     * Foot height in the player's current location: the live body, or the body their next step would get (the
     * saved instance, town-floor or arrival height). Null while the location's collision is not ready.
     */
    footY(p) {
      const location = ctx.location(p);
      const area = cache.get(String(location));
      if (area.status !== 'ready') return null;
      const y = bodyOf(p, location, area.world).y;
      return Number.isFinite(y) ? y : null;
    },
    instanceWorld(location) {
      const a = cache.get(location);
      return a.status === 'ready' ? a.world : null;
    },
    status(location) {
      const a = cache.get(String(location));
      return { status: a.status, source: a.source, reason: a.reason };
    },
    isClear(location, x, z, footY = null) {
      const w = settledWorld(location);
      return w ? w.isClear(x, z, footY) : false;
    },
    canWalkSegment(location, x, z, toX, toZ, footY = null) {
      const area = cache.get(location);
      if (area.status !== 'ready') return false;
      const m = area.world.move(x, z, toX, toZ, { y: footY });
      return Math.hypot(m.x - toX, m.z - toZ) < 0.001 && area.world.isClear(toX, toZ, m.y);
    },
    absoluteGroundAt(location, x, z) {
      const area = cache.get(location);
      if (area.status !== 'ready' || !Number.isFinite(area.world.datum)) return null;
      return area.world.standHeight(x, z) + area.world.datum;
    },
    nearestClear(location, x, z, maxDist = 8, footY = null) {
      const w = settledWorld(location);
      return w ? w.nearestClear(x, z, { maxDist, y: footY }) : null;
    },
    groundAt(location, x, z, footY = null) {
      const w = settledWorld(location);
      if (!w) return null;
      return Number.isFinite(footY) ? w.heightAt(x, z, footY) : w.standHeight(x, z);
    },
    whenSettled: (location) => cache.whenSettled(String(location)).then((a) => ({ status: a.status, source: a.source, reason: a.reason })),
    preload: (location) => void cache.get(String(location)),
    get cachedBytes() {
      return cache.byteSize;
    },
    cachedLocations: () => [...cache.areas.keys()],
  };

  ctx.services.movePlayer = movePlayer;
  ctx.services.stepPlayer = stepPlayer;
  // Snapshot fields for state.players[]: y (foot height), stance and speed (client/lib/locomotion.js publicBody).
  ctx.services.bodyView = (p) => publicBody(service.bodyOf(p));
  ctx.services.canSee = canSee;
  ctx.services.collision = service;

  ctx.onJoin((p) => {
    bodies.delete(p);
    told.delete(p);
    const area = cache.get(ctx.location(p));
    announce(p, area);
  });
  ctx.onLeave((p) => {
    const body = service.bodyOf(p);
    const portal = p.rpg?.portal;
    if (body?.mode === 'swim' && portal?.to === ctx.location(p)) portal.breath = body.breath;
    bodies.delete(p);
  });

  let sinceSweep = 0;
  ctx.onTick((dt) => {
    sinceSweep += dt * 1000;
    if (sinceSweep < SWEEP_MS) return;
    sinceSweep = 0;
    const occupied = new Set();
    for (const p of ctx.players.values()) occupied.add(ctx.location(p));
    cache.sweep(occupied);
  });

  if (options.preloadDefault !== false && ctx.defaultLocation) cache.get(ctx.defaultLocation);
  return { cache, service, movePlayer, stepPlayer, canSee };
}

export function install(ctx) {
  createCollision(ctx);
}
