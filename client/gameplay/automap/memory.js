// Exploration memory shared by the server (server/rpg/automap.js) and the automap panel. DOM-free.
//
// A character's memory of an interior or dungeon is a set of explored cells: CELL-metre squares of the renderer's
// output space (x east, z south) plus the foot height (half-metre steps) the character stood at. The server records
// them from its own authoritative positions; the browser only ever receives its own character's cells and uses them
// to clip the plan it already builds from the player's own archives. Nothing here carries layout data.
//
// Wire format: base64 of little-endian int16 triples (ix, iz, iy). ix = floor(x / CELL), iz = floor(z / CELL),
// iy = round(footY * 2).

export const CELL = 2; // metres per cell side
export const Y_STEP = 0.5; // metres per iy unit
/** Cells within this distance of the player are considered for line-of-sight reveal. */
export const REVEAL_RADIUS = 7;
/** Hard caps (server-enforced; the browser trusts nothing beyond them either). */
export const MAX_CELLS = 12000;
export const MAX_NOTES = 64;
export const MAX_NOTE_TEXT = 120;
export const MAX_NAMES = 1000;
export const MAX_NAME_TEXT = 80;
export const MAX_NOTEBOOK = 200;
export const MAX_NOTEBOOK_TEXT = 500;
const I16 = 32767;

const clamp16 = (n) => Math.max(-I16, Math.min(I16, n));
export const cellIndex = (v) => clamp16(Math.floor(v / CELL));
export const yIndex = (footY) => clamp16(Math.round((Number.isFinite(footY) ? footY : 0) / Y_STEP));
export const cellKey = (ix, iz, iy) => `${ix},${iz},${iy}`;
export function parseCellKey(key) {
  const [ix, iz, iy] = String(key).split(',').map(Number);
  return [ix, iz, iy];
}

// ------------------------------------------------------------------------------------- base64 (node + browser)

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (b === undefined ? '=' : B64[(n >> 6) & 63]) + (c === undefined ? '=' : B64[n & 63]);
  }
  return out;
}

function base64ToBytes(text) {
  const s = String(text ?? '').replace(/=+$/, '');
  if (/[^A-Za-z0-9+/]/.test(s)) throw new Error('invalid exploration data');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const n = (B64_INDEX.get(s[i]) << 18) | ((B64_INDEX.get(s[i + 1]) ?? 0) << 12) | ((B64_INDEX.get(s[i + 2]) ?? 0) << 6) | (B64_INDEX.get(s[i + 3]) ?? 0);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

/** [[ix, iz, iy], ...] -> wire string. */
export function packCells(cells) {
  const list = [...cells];
  const bytes = new Uint8Array(list.length * 6);
  const dv = new DataView(bytes.buffer);
  list.forEach((c, i) => {
    const [ix, iz, iy] = typeof c === 'string' ? parseCellKey(c) : c;
    dv.setInt16(i * 6, clamp16(ix | 0), true);
    dv.setInt16(i * 6 + 2, clamp16(iz | 0), true);
    dv.setInt16(i * 6 + 4, clamp16(iy | 0), true);
  });
  return bytesToBase64(bytes);
}

/** Wire string -> [[ix, iz, iy], ...] (at most MAX_CELLS). Throws on malformed input. */
export function unpackCells(text) {
  if (!text) return [];
  const bytes = base64ToBytes(text);
  if (bytes.length % 6) throw new Error('invalid exploration data');
  const dv = new DataView(bytes.buffer);
  const n = Math.min(MAX_CELLS, bytes.length / 6);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = [dv.getInt16(i * 6, true), dv.getInt16(i * 6 + 2, true), dv.getInt16(i * 6 + 4, true)];
  return out;
}

// ------------------------------------------------------------------------------------- reveal

/**
 * Cells revealed by a character standing at (x, z) with feet at footY: every cell centre within `radius` that is in
 * line of sight (`canSee(x, z, cx, cz)`), each visible cell's 8 neighbours (so the walls bounding a room are kept),
 * and always the 3×3 block the character stands in. Returns cell keys.
 */
export function revealAround(x, z, footY, canSee = null, radius = REVEAL_RADIUS) {
  const iy = yIndex(footY);
  const px = cellIndex(x), pz = cellIndex(z);
  const out = new Set();
  const add = (ix, iz) => out.add(cellKey(ix, iz, iy));
  const visible = [[px, pz]];
  const r = Math.ceil(radius / CELL);
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      if (!dx && !dz) continue;
      const ix = px + dx, iz = pz + dz;
      const cx = (ix + 0.5) * CELL, cz = (iz + 0.5) * CELL;
      if (Math.hypot(cx - x, cz - z) > radius) continue;
      let ok = false;
      try { ok = typeof canSee === 'function' ? !!canSee(x, z, cx, cz) : Math.max(Math.abs(dx), Math.abs(dz)) <= 1; } catch { ok = false; }
      if (ok) visible.push([ix, iz]);
    }
  }
  for (const [ix, iz] of visible) for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) add(ix + a, iz + b);
  return out;
}

// ------------------------------------------------------------------------------------- text and notes

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** Player text made safe to store and show: control and bidi characters removed, spaces collapsed, trimmed. */
export function cleanText(text, max) {
  if (typeof text !== 'string') return '';
  return text.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const LOCATION_RE = /^[a-z]+:[^\u0000-\u001f]{1,190}$/i;
export const validLocation = (loc) => typeof loc === 'string' && loc.length <= 150 && LOCATION_RE.test(loc);
export const validPortalId = (id) => typeof id === 'string' && /^(b:-?\d{1,4},-?\d{1,4}:\d{1,4}|dungeon|[a-z][\w:.,-]{0,47})$/i.test(id);

/** Location kinds whose plan is hidden until explored. Towns and the overland stay fully drawn. */
export function fogged(location) {
  return /^(interior|building|dungeon):/i.test(String(location ?? ''));
}

// ------------------------------------------------------------------------------------- browser fog helpers

/** Cells (as [ix, iz, iy]) whose foot height lies within [bottom, top] of a slice; all of them for an unsliced map. */
export function cellsInSlice(cells, slice) {
  const out = [];
  for (const c of cells) {
    const [ix, iz, iy] = typeof c === 'string' ? parseCellKey(c) : c;
    const y = iy * Y_STEP;
    if (slice && (y > slice.top || y < (slice.bottom ?? -Infinity))) continue;
    out.push([ix, iz, iy]);
  }
  return out;
}

/** {minX,maxX,minZ,maxZ} of cells, or null. */
export function cellsBounds(cells) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const c of cells) {
    const [ix, iz] = typeof c === 'string' ? parseCellKey(c) : c;
    minX = Math.min(minX, ix * CELL); maxX = Math.max(maxX, (ix + 1) * CELL);
    minZ = Math.min(minZ, iz * CELL); maxZ = Math.max(maxZ, (iz + 1) * CELL);
  }
  return Number.isFinite(minX) ? { minX, maxX, minZ, maxZ } : null;
}

/** True when (x, z) lies in an explored cell whose height is within `dy` of y (any height when y is not finite). */
export function isExplored(index, x, z, y = NaN, dy = 2.5) {
  const list = index.get(`${cellIndex(x)},${cellIndex(z)}`);
  if (!list) return false;
  return !Number.isFinite(y) || list.some((iy) => Math.abs(iy * Y_STEP - y) <= dy);
}

/** Map "ix,iz" -> [iy...] for quick lookups. */
export function cellIndexMap(cells) {
  const m = new Map();
  for (const c of cells) {
    const [ix, iz, iy] = typeof c === 'string' ? parseCellKey(c) : c;
    const k = `${ix},${iz}`;
    const l = m.get(k);
    if (l) l.push(iy); else m.set(k, [iy]);
  }
  return m;
}
