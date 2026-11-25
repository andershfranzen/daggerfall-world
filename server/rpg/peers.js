// Outdoor peer visibility across location boundaries (brief E).
//
// Every outdoor location (`town:` and `wilderness:`) has its own local frame, but they all sit on
// one global grid (client/world/exterior/frame.js, served by overland.globalOf/localOf). A player
// standing a few metres away on the other side of a town gate or a map-pixel edge is in another
// location; this module finds such players by distance on the global grid and re-expresses
// their position in the viewer's own frame. Same-location players are not handled here: the
// existing per-location `state` and rpg snapshots already carry them, so each actor is keyed once
// (by player id) whichever side of the boundary it is on.
//
// Scope rules:
//   - only exterior locations take part; interiors and dungeons never see out or get seen;
//   - only position, facing and public appearance cross (the projected peer carries no location,
//     no quest state, no character sheet);
//   - the visibility radius is the same on both sides; a small hysteresis stops flicker at the edge.
// Interaction reach (trade, party invites, loot, combat) still requires the same location.
//
// ctx.services.peerView = { across(player) -> [{player, x, z, distance}], range, stats() }

export const name = 'peers';

/** Metres. Close enough to see a companion across a gate or pixel edge; far below the 819.2 m pixel. */
export const VIEW_RANGE = 160;
/** A peer already shown stays shown until it is this much farther away. */
export const HYSTERESIS = 1.15;
/** Upper bound on projected peers per viewer (bytes per player stay bounded in a crowd). */
export const MAX_ACROSS = 24;
/** Index lifetime: one broadcast and the rpg sync that follows it share one build. */
const TTL_MS = 15;

export const isExterior = (loc) => typeof loc === 'string' && (loc.startsWith('town:') || loc.startsWith('wilderness:'));

/**
 * @param {object} o
 * @param {Map} o.players               live players (id -> player with x, z, rpg)
 * @param {(p) => string} o.locationOf
 * @param {() => ({globalOf, localOf}|null)} o.overland  frame service (may be loading)
 */
export function createPeerView({ players, locationOf, overland, range = VIEW_RANGE, maxAcross = MAX_ACROSS, clock = () => performance.now(), scoped = () => false }) {
  let builtAt = -Infinity;
  let index = null; // { cells: Map<key, entry[]>, byId: Map<id, entry> }
  const shown = new Map(); // viewer id -> Set of peer ids shown last time
  const counters = { builds: 0, projected: 0, unplaced: 0 };
  const cellKey = (cx, cz) => `${cx},${cz}`;

  function build() {
    const ov = overland();
    const cells = new Map();
    const byId = new Map();
    if (ov) {
      for (const p of players.values()) {
        const loc = locationOf(p);
        // A scoped scene (a crew's ship deck) is never projected across a boundary nor sees across one.
        if (!isExterior(loc) || scoped(p) || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
        let g = null;
        try {
          g = ov.globalOf(loc, p.x, p.z);
        } catch {
          g = null;
        }
        if (!g || !Number.isFinite(g.e) || !Number.isFinite(g.s)) {
          counters.unplaced++;
          continue; // frame still loading: same-location visibility is unaffected
        }
        const entry = { p, loc, e: g.e, s: g.s, cx: Math.floor(g.e / range), cz: Math.floor(g.s / range) };
        byId.set(p.id, entry);
        const k = cellKey(entry.cx, entry.cz);
        if (!cells.has(k)) cells.set(k, []);
        cells.get(k).push(entry);
      }
    }
    for (const id of shown.keys()) if (!players.has(id)) shown.delete(id);
    counters.builds++;
    index = { cells, byId, ov };
  }

  function current() {
    const t = clock();
    if (!index || t - builtAt > TTL_MS) {
      build();
      builtAt = t;
    }
    return index;
  }

  /** Players in other exterior locations near `viewer`, in the viewer's frame, nearest first. */
  function across(viewer) {
    const loc = locationOf(viewer);
    if (!isExterior(loc) || scoped(viewer)) {
      shown.delete(viewer.id);
      return [];
    }
    const { cells, byId, ov } = current();
    const me = byId.get(viewer.id);
    if (!me) return [];
    const before = shown.get(viewer.id);
    const found = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = cells.get(cellKey(me.cx + dx, me.cz + dz));
        if (!list) continue;
        for (const q of list) {
          if (q === me || q.loc === loc || q.p.arriving) continue; // still loading in (server/game.js)
          const d = Math.hypot(q.e - me.e, q.s - me.s);
          const limit = before?.has(q.p.id) ? range * HYSTERESIS : range;
          if (d > limit) continue;
          found.push({ q, d });
        }
      }
    }
    found.sort((a, b) => a.d - b.d || a.q.p.id - b.q.p.id);
    const out = [];
    for (const { q, d } of found) {
      if (out.length >= maxAcross) break;
      let at = null;
      try {
        at = ov.localOf(loc, q.e, q.s);
      } catch {
        at = null;
      }
      if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.z)) continue;
      out.push({ player: q.p, x: at.x, z: at.z, distance: d });
    }
    counters.projected += out.length;
    if (out.length) shown.set(viewer.id, new Set(out.map((a) => a.player.id)));
    else shown.delete(viewer.id);
    return out;
  }

  return {
    across,
    range,
    /** Force the next call to rebuild (tests; a teleport inside one tick). */
    invalidate() {
      builtAt = -Infinity;
    },
    stats: () => ({ ...counters, indexed: index?.byId.size ?? 0, viewers: shown.size }),
  };
}

export function install(ctx) {
  const view = createPeerView({
    players: ctx.players,
    locationOf: (p) => ctx.location(p),
    scoped: (p) => !!ctx.services.presenceScope?.(p),
    overland: () => {
      const o = ctx.services.overland;
      return o && o.status === 'ready' && typeof o.globalOf === 'function' ? o : null;
    },
  });
  ctx.services.peerView = view;
  return view;
}

export default install;
