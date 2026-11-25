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

export const BITSET_PREFIX = 'b:';
/** Regions above this many entries auto-compact to a base64 bitset (all 15,251 Iliac Bay records: about 23 KB). */
export const BITSET_THRESHOLD = 512;
const MAX_LOCATION_INDEX = 65535;
const MAX_BITSET_BYTES = (MAX_LOCATION_INDEX + 1) >> 3; // 8192 bytes

const B64_TABLE = new Int8Array(128).fill(-1);
{
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < alpha.length; i++) B64_TABLE[alpha.charCodeAt(i)] = i;
}
const NIBBLE_POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

function bytesToBitset(bytes) {
  let len = bytes.length;
  while (len > 0 && bytes[len - 1] === 0) len--;
  if (len === 0) return '';
  let bin = '';
  for (let i = 0; i < len; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, Math.min(len, i + 0x8000)));
  }
  return BITSET_PREFIX + btoa(bin);
}

function decodeBitset(str) {
  if (typeof str !== 'string' || !str.startsWith(BITSET_PREFIX)) return null;
  const raw = str.slice(BITSET_PREFIX.length);
  if (!raw) return new Uint8Array(0);
  let bin;
  try {
    bin = atob(raw);
  } catch {
    return null;
  }
  if (bin.length > MAX_BITSET_BYTES) return null;
  let len = bin.length;
  while (len > 0 && bin.charCodeAt(len - 1) === 0) len--;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Encode an iterable of location indices in [0, 65535] into a compact `'b:<base64>'` bitset. */
export function encodeFoundBitset(indices) {
  let max = -1;
  for (const idx of indices) {
    if (Number.isInteger(idx) && idx >= 0 && idx <= MAX_LOCATION_INDEX && idx > max) max = idx;
  }
  if (max < 0) return '';
  const bytes = new Uint8Array((max >> 3) + 1);
  for (const idx of indices) {
    if (Number.isInteger(idx) && idx >= 0 && idx <= MAX_LOCATION_INDEX) bytes[idx >> 3] |= 1 << (idx & 7);
  }
  return bytesToBitset(bytes);
}

/** O(1) bit check directly on a `'b:<base64>'` bitset string. */
function bitsetHas(str, index) {
  if (!Number.isInteger(index) || index < 0 || index > MAX_LOCATION_INDEX) return false;
  const byteIdx = index >> 3;
  const quad = Math.floor(byteIdx / 3);
  const off = BITSET_PREFIX.length + quad * 4;
  if (off + 3 >= str.length) return false;
  const c0 = str.charCodeAt(off), c1 = str.charCodeAt(off + 1), c2 = str.charCodeAt(off + 2), c3 = str.charCodeAt(off + 3);
  const v0 = c0 < 128 ? B64_TABLE[c0] : -1;
  const v1 = c1 < 128 ? B64_TABLE[c1] : -1;
  if (v0 < 0 || v1 < 0) return false;
  const rem = byteIdx % 3;
  let byte;
  if (rem === 0) {
    byte = (v0 << 2) | (v1 >>> 4);
  } else {
    if (c2 === 61 /* '=' */) return false;
    const v2 = c2 < 128 ? B64_TABLE[c2] : -1;
    if (v2 < 0) return false;
    if (rem === 1) {
      byte = ((v1 & 0x0f) << 4) | (v2 >>> 2);
    } else {
      if (c3 === 61 /* '=' */) return false;
      const v3 = c3 < 128 ? B64_TABLE[c3] : -1;
      if (v3 < 0) return false;
      byte = ((v2 & 0x03) << 6) | v3;
    }
  }
  return ((byte >>> (index & 7)) & 1) !== 0;
}

function bitsetAdd(str, index) {
  const prev = decodeBitset(str) ?? new Uint8Array(0);
  const byteIdx = index >> 3;
  const bytes = byteIdx >= prev.length ? new Uint8Array(byteIdx + 1) : prev;
  if (bytes !== prev) bytes.set(prev);
  bytes[byteIdx] |= 1 << (index & 7);
  return bytesToBitset(bytes);
}

function bitsetCount(str) {
  const bytes = decodeBitset(str);
  if (!bytes) return 0;
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    n += NIBBLE_POP[b & 0x0f] + NIBBLE_POP[b >>> 4];
  }
  return n;
}

/**
 * Personal discoveries: `{ [regionIndex]: sorted locationIndex[] | 'b:<base64>' }`.
 * Small regions stay sorted index arrays for readability and legacy test compatibility;
 * regions above `BITSET_THRESHOLD` (512) auto-compact to a base64 bitset so all 15,251
 * Iliac Bay records persist cleanly well within `MAX_RPG_BYTES`.
 */
export function normalizeFound(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, list] of Object.entries(raw)) {
    if (!NUMERIC.test(k) || !REGION_NAMES[Number(k)]) continue;
    if (Array.isArray(list)) {
      const clean = [...new Set(list.filter(i => Number.isInteger(i) && i >= 0 && i <= MAX_LOCATION_INDEX))].sort((a, b) => a - b);
      if (clean.length > BITSET_THRESHOLD) out[k] = encodeFoundBitset(clean);
      else if (clean.length) out[k] = clean;
    } else if (typeof list === 'string' && list.startsWith(BITSET_PREFIX)) {
      const bytes = decodeBitset(list);
      if (bytes && bytes.length) out[k] = bytesToBitset(bytes);
    }
  }
  return out;
}

/** Total number of personally discovered records across both array and bitset regions. */
export function countFound(found) {
  if (!found || typeof found !== 'object' || Array.isArray(found)) return 0;
  let total = 0;
  for (const v of Object.values(found)) {
    if (Array.isArray(v)) total += v.length;
    else if (typeof v === 'string' && v.startsWith(BITSET_PREFIX)) total += bitsetCount(v);
  }
  return total;
}

/** Compact every region above `threshold` (default 0: all regions) into a base64 bitset. */
export function compactFound(found, { threshold = 0 } = {}) {
  const out = normalizeFound(found);
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v) && v.length > threshold) out[k] = encodeFoundBitset(v);
  }
  return out;
}

export function hasFound(found, entry) {
  if (!Number.isInteger(entry?.regionIndex) || !Number.isInteger(entry?.index) || entry.index < 0 || entry.index > MAX_LOCATION_INDEX) {
    return false;
  }
  const list = found?.[entry.regionIndex];
  if (typeof list === 'string' && list.startsWith(BITSET_PREFIX)) return bitsetHas(list, entry.index);
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
  if (!Number.isInteger(entry?.regionIndex) || !Number.isInteger(entry?.index) || entry.index < 0 || entry.index > MAX_LOCATION_INDEX) {
    return false;
  }
  if (hasFound(found, entry)) return false;
  const cur = found[entry.regionIndex];
  if (typeof cur === 'string' && cur.startsWith(BITSET_PREFIX)) {
    found[entry.regionIndex] = bitsetAdd(cur, entry.index);
    return true;
  }
  const list = Array.isArray(cur) ? cur : (found[entry.regionIndex] = []);
  let at = list.length;
  while (at > 0 && list[at - 1] > entry.index) at--;
  list.splice(at, 0, entry.index);
  if (list.length > BITSET_THRESHOLD) found[entry.regionIndex] = encodeFoundBitset(list);
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
