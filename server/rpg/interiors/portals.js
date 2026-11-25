// Portal registry: validated, reusable transfers between two locations (town door -> building interior, dungeon
// entrance -> dungeon, or any pair another feature registers). Pure and synchronous; no game data access.
//
// A portal joins `from` (where its doors are) and `to` (the instance players share). Every entrance is a door in
// `from` space with the landing in `to` space, the matching point inside (`inner`, used to pick the way back out) and
// the landing outside. Exits are doors in `to` space through which a player may leave.

const finite = (...v) => v.every((x) => typeof x === 'number' && Number.isFinite(x));
const ID_RE = /^[A-Za-z0-9:,._-]{1,64}$/;
const LOCATION_RE = /^[a-z]+:[^\u0000-\u001f]{1,190}$/;

/** Horizontal reach to a door, metres. DFU allows 1.5 m from the camera; server positions trail the client. */
export const DEFAULT_REACH = 3;

/** Make clearance at an authored exterior doorway while staying on its outward side. */
export function clearDungeonReturn(world, landing) {
  const { x, y, z, yaw } = landing;
  const check = (px, pz) => {
    const floor = world.heightAt(px, pz, y);
    // The classic reposition point can hang above the exterior terrain.
    // Settle onto the first clear surface below it as the player lands.
    if (floor == null || !world.isClear(px, pz, floor)) return null;
    return { ...landing, x: px, y: floor, z: pz };
  };
  const exact = check(x, z);
  if (exact) return exact;
  const nx = Math.sin(yaw), nz = -Math.cos(yaw);
  for (let offset = 0.25; offset <= 4; offset += 0.25) {
    for (let lateral = 0; lateral <= Math.min(offset, 2); lateral += 0.25) {
      const a = check(x + nx * offset + nz * lateral, z + nz * offset - nx * lateral);
      if (a) return a;
      const b = lateral && check(x + nx * offset - nz * lateral, z + nz * offset + nx * lateral);
      if (b) return b;
    }
  }
  return null;
}

function checkPoint(p, what, withYaw = false) {
  if (!p || !finite(p.x, p.z) || (p.y !== undefined && !finite(p.y)) || (withYaw && !finite(p.yaw))) {
    throw new TypeError(`portal ${what} needs finite coordinates`);
  }
  return withYaw ? { x: p.x, y: p.y ?? 0, z: p.z, yaw: p.yaw } : {
    x: p.x, y: p.y ?? 0, z: p.z, ...(finite(p.floor) ? { floor: p.floor } : {}),
    ...(finite(p.nx, p.nz) ? { nx: p.nx, nz: p.nz } : {}),
  };
}

const h2 = (a, b) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;

export function createPortalRegistry({ reach = DEFAULT_REACH } = {}) {
  const byKey = new Map(); // `${from}#${id}` -> portal
  const byTarget = new Map(); // to -> portal
  const byFrom = new Map(); // from -> Set(portal)

  /**
   * @param {{id,from,to,kind?,label?,entrances:Array<{x,y?,z,enter:{x,y?,z,yaw},inner?:{x,z},exit:{x,y?,z,yaw}}>,
   *   exits:Array<{x,y?,z}>, meta?:object}} spec
   */
  function register(spec) {
    if (!spec || !ID_RE.test(spec.id ?? '')) throw new TypeError('portal id must be 1-64 safe characters');
    if (!LOCATION_RE.test(spec.from ?? '') || !LOCATION_RE.test(spec.to ?? '')) throw new TypeError('portal locations are invalid');
    if (spec.from === spec.to) throw new TypeError('a portal must join two different locations');
    const questOnly = spec.kind === 'quest';
    if (!Array.isArray(spec.entrances) || (!questOnly && !spec.entrances.length)) throw new TypeError('a portal needs at least one entrance');
    if (!Array.isArray(spec.exits) || (!questOnly && !spec.exits.length)) throw new TypeError('a portal needs at least one exit');
    if (questOnly && (spec.entrances.length || spec.exits.length)) throw new TypeError('a quest portal has no public doors');
    const portal = Object.freeze({
      id: spec.id,
      from: spec.from,
      to: spec.to,
      kind: spec.kind ?? 'door',
      label: String(spec.label ?? 'Door').slice(0, 80),
      entrances: Object.freeze(
        spec.entrances.map((e) =>
          Object.freeze({
            ...checkPoint(e, 'entrance'),
            enter: Object.freeze(checkPoint(e.enter, 'landing', true)),
            inner: Object.freeze(checkPoint(e.inner ?? e.enter, 'inner point')),
            exit: Object.freeze(checkPoint(e.exit, 'exit landing', true)),
          }),
        ),
      ),
      exits: Object.freeze(spec.exits.map((e) => Object.freeze(checkPoint(e, 'exit')))),
      meta: Object.freeze({ ...(spec.meta ?? {}) }),
    });
    const key = `${portal.from}#${portal.id}`;
    const old = byKey.get(key);
    if (old) unregister(old);
    const clash = byTarget.get(portal.to);
    if (clash) throw new Error(`location ${portal.to} already has a portal (${clash.from}#${clash.id})`);
    byKey.set(key, portal);
    byTarget.set(portal.to, portal);
    if (!byFrom.has(portal.from)) byFrom.set(portal.from, new Set());
    byFrom.get(portal.from).add(portal);
    return portal;
  }

  function unregister(portal) {
    byKey.delete(`${portal.from}#${portal.id}`);
    if (byTarget.get(portal.to) === portal) byTarget.delete(portal.to);
    byFrom.get(portal.from)?.delete(portal);
  }

  const get = (from, id) => byKey.get(`${from}#${id}`) ?? null;
  const into = (to) => byTarget.get(to) ?? null;
  const at = (from) => [...(byFrom.get(from) ?? [])];
  const knows = (location) => byFrom.has(location) || byTarget.has(location);

  function nearest(list, p) {
    let best = null, bd = Infinity;
    for (const e of list) {
      if (Number.isFinite(e.floor)) {
        if (!Number.isFinite(p.y) || Math.abs(e.floor - p.y) > 1.25) continue;
      } else if (Number.isFinite(p.y) && Math.abs(e.y - p.y) > reach) continue;
      if (p.visible && !p.visible(e)) continue;
      const d = h2(e, p);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    return { item: best, distance: Math.sqrt(bd) };
  }

  /**
   * Validate entering `portal` from position `pos` in location `location`.
   * @returns {{portal, entrance, landing:{location,x,y,z,yaw}}}
   */
  function planEnter(location, pos, id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('That is not a door.');
    const portal = get(location, id);
    if (!portal || portal.kind === 'quest') throw new Error('There is no such door here.');
    const { item, distance } = nearest(portal.entrances, pos);
    if (!item || !(distance <= reach)) throw new Error('You are too far away from that door.');
    return { portal, entrance: item, landing: { location: portal.to, ...item.enter } };
  }

  /**
   * Validate leaving the instance `location` from `pos`: the nearest exit door must be within reach. Lands outside
   * the entrance whose inner point is closest to the player (PlayerEnterExit.TransitionExterior).
   */
  function planLeave(location, pos, returnTo = null) {
    const portal = into(location);
    if (!portal) throw new Error('There is no way out from here.');
    if (portal.kind === 'quest') throw new Error('There is no exit door here.');
    const { item, distance } = nearest(portal.exits, pos);
    if (!item || !(distance <= reach)) throw new Error('You need to stand at the exit door to leave.');
    if (portal.kind === 'dungeon' && returnTo) {
      return { portal, landing: { location: returnTo.location, ...checkPoint(returnTo, 'saved return', true) } };
    }
    let entrance = portal.entrances[0];
    let bd = Infinity;
    for (const e of portal.entrances) {
      const d = h2(e.inner, item) + (e.inner.y - item.y) ** 2;
      if (d < bd) {
        bd = d;
        entrance = e;
      }
    }
    return { portal, entrance, landing: { location: portal.from, ...entrance.exit } };
  }

  return { register, unregister, get, into, at, knows, planEnter, planLeave, reach, get size() { return byKey.size; } };
}
