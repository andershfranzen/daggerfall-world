// Automap exploration memory, learned place names, map annotations and the notebook (package 6).
//
// Per character and private:
//   - explored cells of every interior and dungeon the character has walked (client/gameplay/automap/memory.js).
//     The server reveals them from its own authoritative position, foot height and line of sight
//     (ctx.services.canSee); a client never reports what it has seen. Stored as one world_state row per character
//     and place (`automap:<playerId>:<location>`), saved by the periodic save, never put in any other snapshot.
//   - p.rpg.automap = { names: {townLoc: {portalId: label}}, notes: {location: [{id,x,y,z,text}]},
//                       notebook: [{id, at, text, source}], seq }
//     names are learned by walking in through a building door (and by the discovery hook below); NPC directions
//     record theirs in p.rpg.learnedPlaces (server/rpg/npcs.js), which the browser reads alongside.
//
// Actions
//   automap.sync    {}                         -> private {kind:'automap', location, cells, full:true}
//   automap.note    {x, z, y?, text}           pin a note in the current place (explored ground only indoors)
//   automap.unnote  {id, location?}
//   notebook.write  {text}
//   notebook.erase  {id}
// Private events: {kind:'automap', location, cells, full?, silent:true} (cells: packCells wire string)
//
// Discovery hook (ctx.services.automap), additive, for conversation/quest owners. Call inside your action:
//   learnPlace(player, {town, portalId, label})          a building name on the town map; true when new
//   forgetPlace(player, {town, portalId})                drop a learned building name (a sold house, package 13)
//   reveal(player, location, {x, z, y?, radius?})        explore an area (e.g. a quest map); returns cells added
//   write(player, text, {source?})                       a notebook entry; returns the entry
//   explored(player, location) -> number                 explored cell count (0 = never visited)
//   knows(player, town, portalId) -> boolean
// Server events: ctx.emit('discovered', {player, kind:'place'|'area', location, portalId?, label?})
// Listens:      ctx.on('directions'|'placeLearned', ...) and ctx.on('locationChanged', ...)

import {
  CELL, MAX_CELLS, MAX_NOTES, MAX_NOTE_TEXT, MAX_NAMES, MAX_NAME_TEXT, MAX_NOTEBOOK, MAX_NOTEBOOK_TEXT,
  REVEAL_RADIUS, cellIndex, cellKey, cleanText, fogged, packCells, parseCellKey, revealAround, unpackCells,
  validLocation, validPortalId, yIndex,
} from '../../client/gameplay/automap/memory.js';

export const name = 'automap';
export const WORLD_PREFIX = 'automap:';
const REVEAL_EVERY_MS = 200;
const REVEAL_MOVE = 0.75; // metres moved before revealing again
const MAX_NOTE_PLACES = 64;
const COORD = 100000;
const CACHE_LIMIT = 4000;

const fail = (m) => { throw Object.assign(new Error(m), { expose: true }); };

export function install(ctx) {
  /** playerId -> {places: Map<location, Set<cellKey>>, loaded: Set<location>, touched} */
  const memory = new Map();
  /** player -> {location, x, z, footY, at, sent} */
  const last = new WeakMap();

  const rowKey = (p, location) => `${WORLD_PREFIX}${p.id}:${location}`;

  function memOf(p) {
    let m = memory.get(p.id);
    if (!m) {
      m = { places: new Map(), loaded: false, touched: Date.now() };
      memory.set(p.id, m);
      if (memory.size > CACHE_LIMIT) evict();
    }
    m.touched = Date.now();
    if (!m.loaded) {
      m.loaded = true;
      for (const [key, v] of ctx.loadWorld?.(`${WORLD_PREFIX}${p.id}:`) ?? []) {
        const location = key.slice(`${WORLD_PREFIX}${p.id}:`.length);
        if (!validLocation(location) || m.places.has(location)) continue;
        try {
          m.places.set(location, new Set(unpackCells(v?.cells).map(([ix, iz, iy]) => cellKey(ix, iz, iy))));
        } catch { /* a corrupt row is rebuilt by exploring */ }
      }
    }
    return m;
  }

  function evict() {
    // Oldest offline memories first; a queued save keeps its own reference, so nothing is lost.
    const online = new Set([...ctx.players.values()].map((p) => p.id));
    const old = [...memory].filter(([id, m]) => !online.has(id) && Date.now() - m.touched > 60_000).sort((a, b) => a[1].touched - b[1].touched);
    for (const [id] of old.slice(0, Math.max(1, memory.size - CACHE_LIMIT))) memory.delete(id);
  }

  function cellsOf(p, location) {
    const m = memOf(p);
    let s = m.places.get(location);
    if (!s) m.places.set(location, (s = new Set()));
    return s;
  }

  function persist(p, location, cells) {
    ctx.dirtyWorld(rowKey(p, location), () => ({ cells: packCells(cells), at: Date.now() }));
  }

  /** Adds cell keys; returns the newly added ones. */
  function addCells(p, location, keys) {
    if (!fogged(location) || !validLocation(location)) return [];
    const set = cellsOf(p, location);
    const added = [];
    for (const k of keys) {
      if (set.size >= MAX_CELLS) break;
      if (!set.has(k)) { set.add(k); added.push(k); }
    }
    if (added.length) {
      persist(p, location, set);
      ctx.onRollback(() => { for (const k of added) set.delete(k); });
    }
    return added;
  }

  function send(p, location, keys, full = false) {
    ctx.notify(p, { kind: 'automap', location, cells: packCells(keys), ...(full ? { full: true } : {}), silent: true });
  }

  function footOf(p, location) {
    const portal = p.rpg?.portal;
    if (portal?.to === location && Number.isFinite(portal.footY)) return portal.footY;
    try {
      const g = ctx.services.collision?.groundAt?.(location, p.x, p.z);
      if (Number.isFinite(g)) return g;
    } catch { /* collision still loading */ }
    return 0;
  }

  function sightFor(location, footY) {
    const see = ctx.services.canSee;
    if (typeof see !== 'function') return null;
    return (x, z, cx, cz) => see(location, x, z, cx, cz, { y1: footY, y2: footY });
  }

  /** Reveal around a player's current position. Returns newly explored keys. */
  function explore(p, { force = false } = {}) {
    const location = ctx.location(p);
    if (!fogged(location) || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return [];
    if (p.arriving) return [];
    const footY = footOf(p, location);
    const prev = last.get(p);
    const now = ctx.now();
    if (!force && prev && prev.location === location && now - prev.at < REVEAL_EVERY_MS) return [];
    if (!force && prev && prev.location === location && Math.hypot(p.x - prev.x, p.z - prev.z) < REVEAL_MOVE && Math.abs(footY - prev.footY) < 0.6) return [];
    last.set(p, { location, x: p.x, z: p.z, footY, at: now });
    return addCells(p, location, revealAround(p.x, p.z, footY, sightFor(location, footY), REVEAL_RADIUS));
  }

  // ---------------------------------------------------------------- per-character record (p.rpg.automap)

  function record(p) {
    const r = p.rpg.automap;
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      if (!r.names || typeof r.names !== 'object') r.names = {};
      if (!r.notes || typeof r.notes !== 'object') r.notes = {};
      if (!Array.isArray(r.notebook)) r.notebook = [];
      if (!Number.isInteger(r.seq)) r.seq = 0;
      return r;
    }
    return (p.rpg.automap = { names: {}, notes: {}, notebook: [], seq: 0 });
  }
  const nextId = (r) => `${++r.seq}`;
  const nameCount = (r) => Object.values(r.names).reduce((n, t) => n + Object.keys(t).length, 0);

  function learnPlace(p, { town, portalId, label } = {}) {
    if (!p?.rpg || !validLocation(town) || !/^town:/i.test(town) || !validPortalId(portalId)) return false;
    const text = cleanText(String(label ?? ''), MAX_NAME_TEXT);
    if (!text) return false;
    ctx.dirty(p);
    const r = record(p);
    if (r.names[town]?.[portalId] === text) return false;
    if (!r.names[town] && Object.keys(r.names).length >= 64) return false;
    if (nameCount(r) >= MAX_NAMES && !r.names[town]?.[portalId]) return false;
    (r.names[town] ??= {})[portalId] = text;
    ctx.emit('discovered', { player: p, kind: 'place', location: town, portalId, label: text });
    return true;
  }

  /** Undo learnPlace for one building (PlayerGPS.UndiscoverBuilding: a sold house). True when it was known. */
  function forgetPlace(p, { town, portalId } = {}) {
    if (!p?.rpg || !validLocation(town) || !validPortalId(portalId)) return false;
    const r = record(p);
    if (!r.names[town] || !Object.hasOwn(r.names[town], portalId)) return false;
    ctx.dirty(p);
    delete r.names[town][portalId];
    if (!Object.keys(r.names[town]).length) delete r.names[town];
    return true;
  }

  function write(p, text, { source = 'player' } = {}) {
    const t = cleanText(text, MAX_NOTEBOOK_TEXT);
    if (!t) return null;
    ctx.dirty(p);
    const r = record(p);
    const entry = { id: nextId(r), at: Date.now(), text: t, source: cleanText(String(source), 24) || 'player' };
    r.notebook.push(entry);
    while (r.notebook.length > MAX_NOTEBOOK) r.notebook.shift();
    return entry;
  }

  // ---------------------------------------------------------------- lifecycle

  ctx.onJoin((p) => {
    if (p.rpg?.automap) record(p);
    last.delete(p);
  });
  ctx.onLeave((p) => { last.delete(p); });

  ctx.onTick(() => {
    for (const p of ctx.players.values()) {
      const location = ctx.location(p);
      if (!fogged(location)) continue;
      const added = explore(p);
      if (added.length) send(p, location, added);
    }
  });

  ctx.on('locationChanged', ({ player: p, from, to, portal } = {}) => {
    if (!p?.rpg) return;
    if (portal?.id && portal.kind !== 'quest' && /^town:/i.test(String(from)) && fogged(to)) {
      learnPlace(p, { town: from, portalId: portal.id, label: portal.label });
    }
    last.delete(p);
  });
  // Conversation owner (package 3) publishes newly learned buildings here; the browser reads p.rpg.learnedPlaces too.
  const fromDirections = ({ player, town, places, portalId, label } = {}) => {
    if (!player) return;
    if (Array.isArray(places)) for (const pl of places) ctx.emit('discovered', { player, kind: 'place', location: town, portalId: pl?.id, label: pl?.name });
    else learnPlace(player, { town, portalId, label });
  };
  ctx.on('placeLearned', fromDirections);
  ctx.on('directions', fromDirections);

  // ---------------------------------------------------------------- actions

  ctx.onAction('automap.sync', (p) => {
    const location = ctx.location(p);
    const fresh = explore(p, { force: true });
    void fresh;
    const set = fogged(location) ? cellsOf(p, location) : new Set();
    ctx.afterCommit(() => send(p, location, set, true));
  });

  const num = (v, what) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > COORD) fail(`A ${what} position is needed.`);
    return Math.round(v * 100) / 100;
  };

  ctx.onAction('automap.note', (p, args) => {
    const location = ctx.location(p);
    const text = cleanText(args.text, MAX_NOTE_TEXT);
    if (!text) fail('Write something for the note.');
    const x = num(args.x, 'note'), z = num(args.z, 'note');
    let y = args.y === undefined || args.y === null ? footOf(p, location) : num(args.y, 'note');
    if (fogged(location)) {
      // Indoors a note goes on ground this character has explored, so a note can never probe unseen layout.
      const set = cellsOf(p, location);
      const ix = cellIndex(x), iz = cellIndex(z);
      let best = null;
      for (const k of set) {
        const [cx, cz, cy] = parseCellKey(k);
        if (cx === ix && cz === iz && (best === null || Math.abs(cy * 0.5 - y) < Math.abs(best - y))) best = cy * 0.5;
      }
      if (best === null) fail('You can only mark places you have explored.');
      y = best;
    } else if (Math.hypot(x - p.x, z - p.z) > 4000) {
      fail('That is too far away to mark.');
    }
    ctx.dirty(p);
    const r = record(p);
    const list = r.notes[location] ?? [];
    if (!r.notes[location] && Object.keys(r.notes).length >= MAX_NOTE_PLACES) fail('Your map has too many marked places. Remove some notes first.');
    if (list.length >= MAX_NOTES) fail('This map has too many notes. Remove one first.');
    list.push({ id: nextId(r), x, y: Math.round(y * 100) / 100, z, text });
    r.notes[location] = list;
  });

  ctx.onAction('automap.unnote', (p, args) => {
    const location = args.location === undefined ? ctx.location(p) : args.location;
    if (!validLocation(location)) fail('Which map?');
    const r = record(p);
    const list = r.notes[location];
    const i = list?.findIndex((n) => n.id === String(args.id)) ?? -1;
    if (i < 0) fail('That note is not on your map.');
    ctx.dirty(p);
    list.splice(i, 1);
    if (!list.length) delete r.notes[location];
  });

  ctx.onAction('notebook.write', (p, args) => {
    if (!write(p, args.text, { source: 'player' })) fail('Write something in the notebook.');
  });

  ctx.onAction('notebook.erase', (p, args) => {
    const r = record(p);
    const i = r.notebook.findIndex((n) => n.id === String(args.id));
    if (i < 0) fail('That entry is not in your notebook.');
    ctx.dirty(p);
    r.notebook.splice(i, 1);
  });

  // ---------------------------------------------------------------- discovery hook

  const service = {
    learnPlace,
    forgetPlace,
    write,
    reveal(p, location, { x, z, y, radius = CELL * 3 } = {}) {
      if (!p?.rpg || !fogged(location) || ![x, z].every(Number.isFinite)) return 0;
      const r = Math.max(CELL, Math.min(64, Number(radius) || CELL));
      const iy = yIndex(Number.isFinite(y) ? y : 0);
      const keys = [];
      const n = Math.ceil(r / CELL);
      for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
        const ix = cellIndex(x) + a, iz = cellIndex(z) + b;
        if (Math.hypot((ix + 0.5) * CELL - x, (iz + 0.5) * CELL - z) <= r + CELL) keys.push(cellKey(ix, iz, iy));
      }
      const added = addCells(p, location, keys);
      if (added.length) {
        ctx.afterCommit(() => send(p, location, added));
        ctx.emit('discovered', { player: p, kind: 'area', location });
      }
      return added.length;
    },
    explored: (p, location) => (p ? memOf(p).places.get(location)?.size ?? 0 : 0),
    knows: (p, town, portalId) => !!(p?.rpg?.automap?.names?.[town]?.[portalId]
      || p?.rpg?.learnedPlaces?.[town]?.some?.((e) => e?.id === portalId)),
  };
  ctx.services.automap = service;
  return { service, explore, memory };
}

export default { name, install };
