// Place identity conversions shared by the server features and the browser.
//
// Classic records are addressed by (regionIndex, locationIndex). For compatibility, the first
// (or only) record with a given region/name keeps its historic `town:<Region>/<Name>` address;
// later duplicates use `town:<regionIndex>/<locationIndex>`. Interiors and dungeons put the same
// region/location pair after their own prefix. See docs/gameplay-protocol.md (travel).
//
// Pure module: no DOM, no I/O.

import { REGION_NAMES } from '../../world/maps.js';

const NUMERIC = /^\d+$/;

/** Display/account region name for the region part of any address (`0` -> `Alik'r Desert`). */
export function regionNameOf(region) {
  const s = String(region ?? '');
  return NUMERIC.test(s) ? REGION_NAMES[Number(s)] ?? s : s;
}

/**
 * Split any place address into prefix, the exterior's region/location and the remaining suffix.
 * `building:` (legacy, owned by the interiors feature) keeps its own prefix and suffix.
 * @returns {null|{kind:'town'|'dungeon'|'interior'|'building', region:string, location:string, rest:string}}
 */
export function splitAddress(id) {
  if (typeof id !== 'string' || id.length > 200) return null;
  const m = /^(town|dungeon|interior|building):([^/]+)\/([^/]+)((?:\/.*)?)$/.exec(id);
  if (!m) return null;
  const kind = m[1];
  if ((kind === 'interior' || kind === 'building') !== (m[4] !== '')) return null;
  return { kind, region: m[2], location: m[3], rest: m[4] };
}

/** Exterior `town:` address that owns a town, interior or dungeon address. */
export function exteriorAddress(id) {
  const a = splitAddress(id);
  return a ? `town:${a.region}/${a.location}` : null;
}

/**
 * Canonical spelling of a place address against the catalogue: case/accents folded, replacement
 * names (Port of Daggerfall) mapped to the source record, numeric addresses of a first/unique record
 * mapped back to its historic name. `hint` ({regionIndex,index} or {x,y}) picks one record of an
 * ambiguous legacy name; without it the historic first match wins. Unknown addresses are returned
 * unchanged, so a save is never damaged while game data is absent.
 */
export function canonicalAddress(catalog, id, hint = null) {
  const a = splitAddress(id);
  if (!a || !catalog || catalog.source !== 'files') return id;
  const entry = catalog.get(`town:${a.region}/${a.location}`, hint);
  if (!entry) return id;
  if (a.kind === 'town') return entry.id;
  return `${a.kind}:${entry.id.slice('town:'.length)}${a.rest}`;
}

/** Catalogue entry owning any place address (town, interior or dungeon). */
export function entryOf(catalog, id, hint = null) {
  const town = exteriorAddress(id);
  return town && catalog ? catalog.get(town, hint) : null;
}

// ------------------------------------------------------------------ discoveries

/**
 * Personal discoveries: `{ [regionIndex]: sorted locationIndex[] }`. Every one of the 15,251
 * records fits in well under 64 KB (the 4,052 initially hidden ones in about 18 KB).
 */
export function normalizeFound(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, list] of Object.entries(raw)) {
    if (!NUMERIC.test(k) || !REGION_NAMES[Number(k)] || !Array.isArray(list)) continue;
    const clean = [...new Set(list.filter(i => Number.isInteger(i) && i >= 0 && i < 65536))].sort((a, b) => a - b);
    if (clean.length) out[k] = clean;
  }
  return out;
}

export function hasFound(found, entry) {
  const list = found?.[entry.regionIndex];
  if (!Array.isArray(list)) return false;
  // Sorted: binary search.
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] === entry.index) return true;
    if (list[mid] < entry.index) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** Adds an entry; returns true when it was new. */
export function addFound(found, entry) {
  if (!Number.isInteger(entry?.regionIndex) || !Number.isInteger(entry?.index)) return false;
  if (hasFound(found, entry)) return false;
  const list = (found[entry.regionIndex] ??= []);
  let at = list.length;
  while (at > 0 && list[at - 1] > entry.index) at--;
  list.splice(at, 0, entry.index);
  return true;
}

// ------------------------------------------------------------------ save migration

export const IDENTITY_VERSION = 1;

/**
 * Convert a character's place addresses to canonical record addresses, in place and all at once.
 * Only runs against a loaded MAPS.BSA catalogue; repeat calls change nothing. Fields owned by other
 * features are only respelled, never dropped. Returns a list of changed paths (for logs/tests).
 */
export function migratePlaces(rpg, catalog) {
  if (!rpg || typeof rpg !== 'object' || !catalog || catalog.source !== 'files') return [];
  const changes = [];
  const next = structuredClone({
    location: rpg.location, travel: rpg.travel, portal: rpg.portal, wilderness: rpg.wilderness,
    quests: rpg.quests, townServices: rpg.townServices,
  });
  const fix = (obj, key, path, hint = null) => {
    if (!obj || typeof obj[key] !== 'string') return;
    const c = canonicalAddress(catalog, obj[key], hint);
    if (c !== obj[key]) {
      changes.push(path);
      obj[key] = c;
    }
  };
  const t = next.travel;
  // A pre-identity save may carry a discriminator for its exterior ({regionIndex, index} or {x, y}).
  // Once converted, addresses are exact and the hint is never consulted again.
  const legacy = t && typeof t === 'object' && t.identity !== IDENTITY_VERSION;
  const here = legacy && t.here && typeof t.here === 'object' ? t.here : null;
  fix(next, 'location', 'location', here);

  if (t && typeof t === 'object' && !Array.isArray(t)) {
    fix(t, 'lastTown', 'travel.lastTown', here);
    if (t.positions && typeof t.positions === 'object' && !Array.isArray(t.positions)) {
      const positions = {};
      for (const [k, v] of Object.entries(t.positions)) {
        const c = canonicalAddress(catalog, k);
        if (c !== k) changes.push(`travel.positions.${k}`);
        if (!(c in positions) || c === k) positions[c] = v;
      }
      t.positions = positions;
    }
    // Legacy string discoveries become record indices. Unknown strings are kept for a later load.
    if (Array.isArray(t.discovered) && t.discovered.length) {
      const found = normalizeFound(t.found);
      const keep = [];
      for (const s of t.discovered) {
        const e = typeof s === 'string' ? catalog.get(s) : null;
        if (e && Number.isInteger(e.index)) addFound(found, e);
        else if (typeof s === 'string') keep.push(s);
      }
      if (keep.length !== t.discovered.length) changes.push('travel.discovered');
      t.found = found;
      t.discovered = keep;
    }
    if (t.identity !== IDENTITY_VERSION) {
      t.identity = IDENTITY_VERSION;
      changes.push('travel.identity');
    }
  }

  const portal = next.portal;
  if (portal && typeof portal === 'object') {
    for (const k of ['to', 'from']) fix(portal, k, `portal.${k}`);
    if (portal.returnTo && typeof portal.returnTo === 'object') fix(portal.returnTo, 'location', 'portal.returnTo.location');
  }
  if (next.wilderness && typeof next.wilderness === 'object') fix(next.wilderness, 'returnTo', 'wilderness.returnTo');

  for (const inst of Array.isArray(next.quests?.active) ? next.quests.active : []) {
    for (const [k, pl] of Object.entries(inst?.places ?? {})) {
      if (!pl || typeof pl !== 'object') continue;
      fix(pl, 'location', `quests.${inst.id ?? '?'}.places.${k}.location`);
      fix(pl, 'interior', `quests.${inst.id ?? '?'}.places.${k}.interior`);
    }
  }
  for (const r of Array.isArray(next.townServices?.repairs) ? next.townServices.repairs : []) {
    if (r && typeof r === 'object') fix(r, 'town', `townServices.repairs.${r.ticket ?? '?'}.town`);
  }

  if (!changes.length) return changes;
  // Commit: every field swaps at once.
  for (const [k, v] of Object.entries(next)) if (v !== undefined) rpg[k] = v;
  return changes;
}
