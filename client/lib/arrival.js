// Arrival gate: is the player's current place complete enough to show? DOM-free so it can be unit tested.
//
// main.js keeps the loading screen up after joining until, for the location the server put the character in:
//   - the server has published that place's people (snapshot `readiness.npcs`, server/rpg/runtime.js), so the
//     snapshot that says 'ready' already carries the occupants — or reports a genuinely empty place;
//   - the scene drawn is that location's (town, interior, dungeon or wilderness mesh);
//   - this browser's collision for it is built (client/gameplay/collision.js);
//   - a town's flats and sky are built (client/gameplay/scenery.js);
//   - every sprite archive the actors present need is decoded (client/gameplay/actors.js).
// A failed part of this location prevents entry and lets the shell offer a retry.

/** The location a scene mesh draws: `interior:`/`dungeon:`/`wilderness:` meshes name it, towns by their source. */
export function sceneLocation(mesh) {
  if (!mesh) return null;
  if (typeof mesh.location === 'string' && mesh.location) return mesh.location;
  if (mesh.source?.townId) return mesh.source.townId;
  const region = mesh.source?.region ?? mesh.region;
  if (typeof region === 'string' && typeof mesh.name === 'string' && (!mesh.kind || mesh.kind === 'town' || mesh.kind === 'exterior')) {
    return `town:${region}/${mesh.name}`;
  }
  return null;
}

/** Door transfers change coordinate systems. Overland walking carries the current exterior view. */
export function crossesDoor(from, to) {
  return !!from && !!to && from !== to && (/^(interior|dungeon):/.test(from) || /^(interior|dungeon):/.test(to));
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the loading screen says while a server readiness part (server/rpg/runtime.js `readiness`) loads. */
const SERVER_PARTS = {
  combat: 'Placing the creatures here…',
  quests: 'Placing the people and items for your journal…',
};

/**
 * @param {object} api gameplay api (client/gameplay/api.js) with optional feature hooks
 * @param {object} o
 * @param {object|null} o.scene      the mesh the renderer holds
 * @param {{x:number,z:number}} [o.at] the player's position
 * @param {{location:string,message:string}|null} [o.sceneError] the last scene failure reported
 * @param {boolean} [o.requireRoster] the server negotiated the Play client's arrival acknowledgement
 * @returns {{ready:boolean, failed:{part,message}|null, waiting:string[], warnings:{part,message}[], parts:object}}
 */
export function arrivalStatus(api, { scene = null, at = null, sceneError = null, requireRoster = false } = {}) {
  const loc = api?.location ?? null;
  const out = { ready: false, failed: null, waiting: [], warnings: [], parts: {}, location: loc };
  if (!loc || !api.state) {
    out.waiting.push('Waiting for the server to place you…');
    return out;
  }
  if (api.renderer?.lost) out.waiting.push('Restoring the game graphics…');

  // Scene: the mesh on screen must be this location's.
  const shown = sceneLocation(scene);
  if (shown === loc) out.parts.scene = 'ready';
  else if (sceneError && sceneError.location === loc) {
    out.parts.scene = 'failed';
    out.failed = { part: 'scene', message: sceneError.message };
    return out;
  } else {
    out.parts.scene = 'loading';
    out.waiting.push('Drawing this place…');
  }

  // People: the server's readiness for this location (absent on servers without it: nothing to wait for).
  const rd = api.state.readiness;
  if (requireRoster && (!rd || (rd.location === loc && (!rd.npcs || !rd.combat)))) {
    out.failed = { part: 'people', message: 'The server could not confirm which people and creatures are in this location. Try joining again.' };
    return out;
  }
  const npcs = rd && rd.location === loc ? rd.npcs : rd ? { status: 'loading' } : null;
  if (!npcs || npcs.status === 'ready') {
    out.parts.people = npcs ? { status: 'ready', people: npcs.people ?? null } : { status: 'unreported' };
  } else if (npcs.status === 'failed') {
    out.parts.people = { status: 'failed' };
    out.failed = { part: 'people', message: npcs.error || 'The server could not load the occupants of this location.' };
    return out;
  } else {
    out.parts.people = { status: 'loading' };
    out.waiting.push('Gathering the people here…');
  }

  // Every other part the server prepares for this place (combat: its authored enemies placed).
  let serverLoading = out.parts.people.status === 'loading';
  for (const [name, r] of Object.entries(rd && rd.location === loc ? rd : {})) {
    if (name === 'location' || name === 'npcs' || !r || typeof r !== 'object') continue;
    out.parts[name] = r.status;
    if (r.status === 'failed') {
      out.failed = { part: name, message: r.error || 'The server could not prepare this location.' };
      return out;
    }
    if (r.status === 'loading') {
      serverLoading = true;
      out.waiting.push(SERVER_PARTS[name] ?? 'Preparing this place…');
    }
  }

  // Local collision, once the scene is the right one.
  if (out.parts.scene === 'ready' && typeof api.collisionLocal === 'function') {
    const c = api.collisionLocal(loc);
    out.parts.collision = c;
    if (c === 'failed') {
      out.failed = { part: 'collision', message: 'The walls and floors of this location could not be loaded.' };
      return out;
    }
    if (c !== 'ready') out.waiting.push('Building walls and floors…');
  }

  // A town's flats and sky, or a building interior's lamps and decorations when its scene lists them.
  const sc = api.scenery;
  const room = loc.startsWith('interior:') && Array.isArray(scene?.flats);
  if (out.parts.scene === 'ready' && sc && (loc.startsWith('town:') || room)) {
    const matching = sc.town && sc.town === (scene?.source ? scene : scene?.town);
    out.parts.scenery = matching ? sc.status : 'waiting';
    if (out.parts.scenery === 'failed') {
      out.failed = { part: 'scenery', message: sc.error?.message || 'The scenery for this location could not be loaded.' };
      return out;
    }
    if (out.parts.scenery !== 'ready') out.waiting.push(room ? 'Lighting the lamps…' : 'Placing trees, signs and sky…');
  }

  // Terrain and settlements already visible around this exterior use the same stream as walking.
  if (out.parts.scene === 'ready' && /^(town|wilderness):/.test(loc) && api.exterior?.arrival) {
    const exterior = api.exterior.arrival(loc);
    out.parts.exterior = exterior.status;
    if (exterior.status === 'failed') {
      out.failed = { part: 'exterior', message: exterior.error?.message || exterior.error || 'The terrain around this place could not be loaded.' };
      return out;
    }
    if (exterior.status !== 'ready') out.waiting.push('Drawing the surrounding landscape…');
  }

  // Sprites of the occupants now present (only once the server has said who is here).
  if (!serverLoading && typeof api.actors?.arrival === 'function') {
    const s = api.actors.arrival(at ?? {});
    out.parts.sprites = { actors: s.actors, archives: s.archives, ready: s.ready, pending: s.pending.length, failed: s.failed.length };
    if (s.pending.length) out.waiting.push(`Drawing ${plural(s.actors, 'figure')} (${s.ready}/${s.archives} sprite sets)…`);
    if (s.failed.length) {
      const first = s.failed[0];
      out.failed = { part: 'sprites', message: first.error || 'The artwork for a figure in this location could not be loaded.' };
      return out;
    }
  }

  out.ready = out.waiting.length === 0;
  return out;
}
