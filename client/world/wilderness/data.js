// World of Daggerfall (Location Loader format) reader and scene composer.
//
// DOM- and Node-neutral: no imports beyond pure modules, no I/O. The server reads the operator's
// installed mod tree and feeds text here; browsers only ever receive the composed scene descriptor
// (docs/wilderness-protocol.md). This is an independent reader written from the file formats:
//
//   Locations/<Region>/*.csv     instances: name,type,prefab,worldX,worldY,terrainX,terrainY plus the
//                                optional rotW/X/Y/Z, rotXAxis/rotYAxis/rotZAxis (degrees), sink, scale, extraData
//   Locations/LocationPrefab/*.txt  <locationPrefab><height/><width/><winterPrefab/>?<object>...</object>*
//                                object: type, objectID, name, posX/Y/Z, scaleX/Y/Z, rotW/X/Y/Z?, extraData?, groundPlane?
//
// Instance types: 0 flattens the ground and must fit inside its pixel; 1 overlaps neighbouring pixels and may
// sink; 2 and 3 stand at sea level. Object types: 0 classic model, 1 flat ARCHIVE.RECORD, 2 editor marker
// 199.RECORD, 3/4 custom assets by name (4 with a numeric name is a model), 5 RMB block.
//
// Frames: Location Loader places an instance root at (terrainX*6.4, ground, terrainY*6.4) inside its map pixel's
// 819.2 m terrain tile - Unity, left-handed, +z north, origin at the tile's SW corner. Scenes use the repo frame:
// right-handed metres, +y up, east +x, north -z, origin at the pixel centre on the site ground.

import { REGION_NAMES } from '../maps.js';

export const MAP_PIXELS_X = 1000;
export const MAP_PIXELS_Y = 500;
export const TERRAIN_SIZE = 128; // tiles per map pixel side
export const TERRAIN_PIXEL_SIZE = 819.2; // metres per map pixel side
export const TILE_METRES = TERRAIN_PIXEL_SIZE / TERRAIN_SIZE; // 6.4
export const HALF_PIXEL = TERRAIN_PIXEL_SIZE / 2; // 409.6
export const SCENE_VERSION = 1;
export const SCENE_FRAME = 'rh-y-up-north-negz-metres-origin-pixel-centre';

// ---------------------------------------------------------------------------------------------- ids

const WILDERNESS_RE = /^wilderness:(0|[1-9]\d{0,2}),(0|[1-9]\d{0,2})$/;
const SITE_RE = /^wod:(0|[1-9]\d{0,2}),(0|[1-9]\d{0,2}):(0|[1-9]\d{0,2}),(0|[1-9]\d{0,2})(?:#([2-9]|[1-9]\d{1,3}))?$/;

/** `wilderness:<px>,<py>` for a valid map pixel, else null. */
export function wildernessId(px, py) {
  return isMapPixel(px, py) ? `wilderness:${px},${py}` : null;
}

export function isMapPixel(px, py) {
  return Number.isInteger(px) && Number.isInteger(py) && px >= 0 && py >= 0 && px < MAP_PIXELS_X && py < MAP_PIXELS_Y;
}

/** Parses a canonical `wilderness:<px>,<py>` id. Returns `{px, py}` or null. */
export function parseWildernessId(id) {
  if (typeof id !== 'string' || id.length > 24) return null;
  const m = WILDERNESS_RE.exec(id);
  if (!m) return null;
  const px = Number(m[1]), py = Number(m[2]);
  return isMapPixel(px, py) ? { px, py } : null;
}

export const isWildernessId = (id) => parseWildernessId(id) !== null;

/** `wod:<px>,<py>:<tx>,<ty>` plus `#n` for the n-th (n >= 2) row sharing those coordinates. */
export function siteId(px, py, tx, ty, n = 1) {
  return `wod:${px},${py}:${tx},${ty}${n > 1 ? `#${n}` : ''}`;
}

/** Parses a site id. Returns `{px, py, tx, ty, n}` or null. */
export function parseSiteId(id) {
  if (typeof id !== 'string' || id.length > 40) return null;
  const m = SITE_RE.exec(id);
  if (!m) return null;
  const [px, py, tx, ty] = [m[1], m[2], m[3], m[4]].map(Number);
  if (!isMapPixel(px, py) || tx > TERRAIN_SIZE || ty > TERRAIN_SIZE) return null;
  return { px, py, tx, ty, n: m[5] ? Number(m[5]) : 1 };
}

// ---------------------------------------------------------------------------------------------- numbers

const INT_RE = /^[\t\n\v\f\r ]*([+-]?\d+)[\t\n\v\f\r ]*$/;
const FLOAT_RE = /^[\t\n\v\f\r ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[\t\n\v\f\r ]*$/;

/** Strict Int32 parse (`int.Parse`); null when malformed or out of range. */
export function parseInt32(s) {
  if (typeof s !== 'string') return null;
  const m = INT_RE.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isSafeInteger(v) && v >= -2147483648 && v <= 2147483647 ? v : null;
}

/** Invariant-culture float parse (`float.Parse(s, en-US)`); null when malformed or non-finite. */
export function parseFloat32(s) {
  if (typeof s !== 'string' || !FLOAT_RE.test(s)) return null;
  const v = Math.fround(Number(s.trim()));
  return Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------------------------- CSV

/** Splits one CSV line: comma separated, `"..."` fields with `""` escapes. Quotes are removed. */
export function splitCsvLine(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  for (;;) {
    if (line[i] === '"') {
      let s = '';
      i++;
      while (i < n) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            s += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else s += line[i++];
      }
      // Anything between the closing quote and the next comma stays part of the field.
      const comma = line.indexOf(',', i);
      s += line.slice(i, comma < 0 ? n : comma);
      out.push(s);
      if (comma < 0) return out;
      i = comma + 1;
    } else {
      const comma = line.indexOf(',', i);
      out.push(line.slice(i, comma < 0 ? n : comma));
      if (comma < 0) return out;
      i = comma + 1;
    }
  }
}

const REQUIRED = ['name', 'type', 'prefab', 'worldX', 'worldY', 'terrainX', 'terrainY'];
const OPTIONAL = ['rotW', 'rotX', 'rotY', 'rotZ', 'rotXAxis', 'rotYAxis', 'rotZAxis', 'sink', 'scale', 'extraData', 'region'];

/**
 * Parses a Location Loader instance CSV. Header names are case-insensitive and may be `,`/`;` separated.
 * Rows that fail to parse are skipped and counted, as Location Loader logs and skips them.
 * @param {string} text
 * @returns {{instances: object[], skipped: number, error: string|null}}
 */
export function parseInstanceCsv(text) {
  if (typeof text !== 'string') return { instances: [], skipped: 0, error: 'not text' };
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  const header = (lines[0] ?? '').split(/[;,]/).map((f) => f.trim().replace(/^"+|"+$/g, ''));
  const col = (name) => header.findIndex((f) => f.toLowerCase() === name.toLowerCase());
  const idx = {};
  for (const k of REQUIRED) {
    idx[k] = col(k);
    if (idx[k] < 0) return { instances: [], skipped: 0, error: `missing column ${k}` };
  }
  for (const k of OPTIONAL) {
    const i = col(k);
    if (i >= 0) idx[k] = i;
  }
  const instances = [];
  let skipped = 0;
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li];
    if (line === '' && li === lines.length - 1) break; // trailing newline
    const t = splitCsvLine(line);
    const inst = readInstanceRow(t, idx);
    if (inst) {
      inst.row = li + 1;
      instances.push(inst);
    } else skipped++;
  }
  return { instances, skipped, error: null };
}

const opt = (t, i) => (i !== undefined && i < t.length && t[i] !== '' ? t[i] : null);

function readInstanceRow(t, idx) {
  if (t.length <= Math.max(...REQUIRED.map((k) => idx[k]))) return null;
  const type = parseInt32(t[idx.type]);
  const worldX = parseInt32(t[idx.worldX]);
  const worldY = parseInt32(t[idx.worldY]);
  const terrainX = parseInt32(t[idx.terrainX]);
  const terrainY = parseInt32(t[idx.terrainY]);
  if ([type, worldX, worldY, terrainX, terrainY].some((v) => v === null)) return null;
  const inst = {
    name: t[idx.name],
    type,
    prefab: t[idx.prefab],
    worldX,
    worldY,
    terrainX,
    terrainY,
    rot: [0, 0, 0, 1], // Unity quaternion x,y,z,w
    sink: 0,
    scale: 1,
    extraData: null,
  };
  // Quaternion columns first, then Euler columns override one axis at a time (eulerAngles round trip).
  const q = ['rotX', 'rotY', 'rotZ', 'rotW'].map((k) => opt(t, idx[k]));
  for (let i = 0; i < 4; i++) {
    if (q[i] === null) continue;
    const v = parseFloat32(q[i]);
    if (v === null) return null;
    inst.rot[i] = v;
  }
  const e = ['rotXAxis', 'rotYAxis', 'rotZAxis'].map((k) => opt(t, idx[k]));
  if (e.some((v) => v !== null)) {
    const euler = quatToEulerDeg(inst.rot);
    for (let i = 0; i < 3; i++) {
      if (e[i] === null) continue;
      const v = parseFloat32(e[i]);
      if (v === null) return null;
      euler[i] = v;
    }
    inst.rot = eulerDegToQuat(euler[0], euler[1], euler[2]);
  }
  for (const k of ['sink', 'scale']) {
    const s = opt(t, idx[k]);
    if (s === null) continue;
    const v = parseFloat32(s);
    if (v === null) return null;
    inst[k] = v;
  }
  const extra = opt(t, idx.extraData);
  if (extra !== null) inst.extraData = extra;
  const region = opt(t, idx.region);
  if (region !== null) inst.region = region;
  return inst;
}

// ---------------------------------------------------------------------------------------------- XML

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeText = (s) =>
  s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] ?? m;
  });

/**
 * Minimal XML element/text reader for prefab files: elements, text, entities, comments, CDATA and the `<?xml?>`
 * declaration. Attributes are read and ignored. Throws on malformed nesting.
 * @returns {{tag:string, text:string, children:object[]}} the root element
 */
export function parseXml(xml) {
  let i = 0;
  const n = xml.length;
  const stack = [];
  let root = null;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const end = lt < 0 ? n : lt;
    if (end > i) {
      if (stack.length) stack[stack.length - 1].text += decodeText(xml.slice(i, end));
      else if (/\S/.test(xml.slice(i, end).replace(/^﻿/, ''))) throw new Error('XML: text outside the root element');
      i = end;
      continue;
    }
    if (xml.startsWith('<!--', i)) {
      const c = xml.indexOf('-->', i + 4);
      if (c < 0) throw new Error('XML: unterminated comment');
      i = c + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', i)) {
      const c = xml.indexOf(']]>', i + 9);
      if (c < 0 || !stack.length) throw new Error('XML: bad CDATA');
      stack[stack.length - 1].text += xml.slice(i + 9, c);
      i = c + 3;
      continue;
    }
    if (xml.startsWith('<?', i) || xml.startsWith('<!', i)) {
      const c = xml.indexOf('>', i);
      if (c < 0) throw new Error('XML: unterminated declaration');
      i = c + 1;
      continue;
    }
    const gt = xml.indexOf('>', i);
    if (gt < 0) throw new Error('XML: unterminated tag');
    let body = xml.slice(i + 1, gt);
    i = gt + 1;
    if (body.startsWith('/')) {
      const tag = body.slice(1).trim();
      const top = stack.pop();
      if (!top || top.tag !== tag) throw new Error(`XML: mismatched </${tag}>`);
      continue;
    }
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);
    const tag = body.trim().split(/\s+/)[0];
    if (!/^[A-Za-z_][\w.-]*$/.test(tag)) throw new Error(`XML: bad tag <${tag}>`);
    const el = { tag, text: '', children: [] };
    if (stack.length) stack[stack.length - 1].children.push(el);
    else if (root) throw new Error('XML: second root element');
    else root = el;
    if (!selfClosing) stack.push(el);
  }
  if (stack.length) throw new Error(`XML: unclosed <${stack[stack.length - 1].tag}>`);
  if (!root) throw new Error('XML: no root element');
  return root;
}

const child = (el, tag) => el.children.find((c) => c.tag === tag) ?? null;
const childText = (el, tag) => {
  const c = child(el, tag);
  return c ? c.text : null;
};

/**
 * Parses a LocationPrefab file. Returns null when the root is not `<locationPrefab>`.
 * Objects whose numeric fields fail to parse are dropped (counted in `skipped`).
 */
export function parsePrefabXml(text) {
  const root = parseXml(String(text));
  if (root.tag !== 'locationPrefab') return null;
  const prefab = {
    height: parseInt32(childText(root, 'height') ?? '') ?? 8,
    width: parseInt32(childText(root, 'width') ?? '') ?? 8,
    winterPrefab: (childText(root, 'winterPrefab') ?? '').trim(),
    obj: [],
    skipped: 0,
  };
  for (const el of root.children) {
    if (el.tag !== 'object') continue;
    const o = readPrefabObject(el);
    if (o) prefab.obj.push(o);
    else prefab.skipped++;
  }
  return prefab;
}

function readPrefabObject(el) {
  const type = parseInt32(childText(el, 'type') ?? '');
  const objectID = parseInt32(childText(el, 'objectID') ?? '0');
  if (type === null || objectID === null) return null;
  const f = (tag, dflt) => {
    const s = childText(el, tag);
    if (s === null) return dflt;
    return parseFloat32(s);
  };
  const pos = [f('posX', 0), f('posY', 0), f('posZ', 0)];
  const scale = [f('scaleX', 1), f('scaleY', 1), f('scaleZ', 1)];
  const rot = [f('rotX', 0), f('rotY', 0), f('rotZ', 0), f('rotW', 1)];
  if ([...pos, ...scale, ...rot].some((v) => v === null)) return null;
  let name = (childText(el, 'name') ?? '').trim();
  let t = type;
  if (t === 4) {
    // Path-like asset names keep their file stem; a numeric one is a classic model.
    const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
    if (slash >= 0) name = name.slice(slash + 1).replace(/\.[^.]*$/, '');
    if (parseInt32(name) !== null) t = 0;
  }
  const o = { type: t, objectID, name, pos, rot: normalizeQuat(rot), scale };
  const extra = childText(el, 'extraData');
  if (extra !== null && extra.trim()) o.extraData = extra.trim();
  if ((childText(el, 'groundPlane') ?? '').trim().toLowerCase() === 'true') o.groundPlane = true;
  return o;
}

/** Location Loader's object validation (type and name). */
export function validateObject(type, name) {
  if (type === 0) return parseInt32(name) !== null;
  if (type === 1 || type === 2) {
    const a = String(name).split('.');
    if (a.length !== 2 || parseInt32(a[0]) === null || parseInt32(a[1]) === null) return false;
    return type === 1 || parseInt32(a[0]) === 199;
  }
  return type === 3 || type === 4 || type === 5;
}

// ---------------------------------------------------------------------------------------------- classification

export const MARKER = Object.freeze({ Enter: 8, Start: 10, Quest: 11, RandomMonster: 15, Monster: 16, QuestItem: 18, RandomTreasure: 19 });
export const LIGHT_ARCHIVE = 210;
export const TREASURE_ARCHIVE = 216;

const KIND_RULES = [
  [/logging/i, 'logging'],
  [/fort/i, 'fort'],
  [/camp/i, 'camp'],
  [/tower/i, 'tower'],
  [/ruin/i, 'ruin'],
  [/shrine/i, 'shrine'],
  [/farm/i, 'farm'],
  [/dock/i, 'dock'],
  [/bridge/i, 'bridge'],
  [/banner/i, 'bannerpost'],
  [/mountain|foothill/i, 'mountain'],
  [/rock/i, 'rocks'],
];
/** Kinds that are scenery: drawn in scenes, never listed as places to visit. */
export const SCENERY_KINDS = Object.freeze(['rocks', 'mountain', 'bannerpost', 'bridge']);

/** Site kind from the instance name, prefab and source file name. */
export function siteKind(name = '', prefab = '', file = '') {
  const s = `${name} ${prefab}`;
  for (const [re, kind] of KIND_RULES) if (re.test(s)) return kind;
  const f = String(file).replace(/^.*[/\\]/, '');
  for (const [re, kind] of KIND_RULES) if (re.test(f)) return kind;
  return 'site';
}

export const isPointOfInterest = (kind) => !SCENERY_KINDS.includes(kind);

/** Player-facing name: `WOD_OrcCamp` -> `Orc Camp`; plain names are kept. */
export function displayName(name, prefab = '') {
  let s = String(name || prefab || 'Wilderness site').trim();
  s = s.replace(/^WOD[_ ]/i, '').replace(/_/g, ' ');
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
  return s.slice(0, 60) || 'Wilderness site';
}

/** Team override of a 199.16 marker (`TeamOverride`; 0 = keep the enemy's own team), or 0. */
export function markerTeam(extraData) {
  if (typeof extraData !== 'string' || !extraData.trim().startsWith('{')) return 0;
  try {
    const v = JSON.parse(extraData);
    return Number.isInteger(v?.TeamOverride) && v.TeamOverride > 0 ? v.TeamOverride : 0;
  } catch {
    return 0;
  }
}

/** Enemy id carried by a 199.16 marker's extraData (`{"EnemyId":n}` or a bare integer). */
export function markerEnemyId(extraData) {
  if (typeof extraData !== 'string' || !extraData.trim()) return null;
  const bare = parseInt32(extraData);
  if (bare !== null) return bare;
  try {
    const v = JSON.parse(extraData);
    return v && Number.isInteger(v.EnemyId) ? v.EnemyId : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------- math

const DEG = Math.PI / 180;

/** Unity `Quaternion.Euler(x, y, z)` (degrees; applied Z, then X, then Y). Returns [x, y, z, w]. */
export function eulerDegToQuat(ex, ey, ez) {
  const hx = (ex * DEG) / 2, hy = (ey * DEG) / 2, hz = (ez * DEG) / 2;
  const qx = [Math.sin(hx), 0, 0, Math.cos(hx)];
  const qy = [0, Math.sin(hy), 0, Math.cos(hy)];
  const qz = [0, 0, Math.sin(hz), Math.cos(hz)];
  return quatMul(quatMul(qy, qx), qz);
}

/** Inverse of eulerDegToQuat, angles in [0, 360) like Unity's eulerAngles. */
export function quatToEulerDeg(q) {
  const [x, y, z, w] = q;
  const sinX = 2 * (w * x - y * z);
  const ex = Math.abs(sinX) >= 1 ? Math.sign(sinX) * 90 : Math.asin(sinX) / DEG;
  const ey = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y)) / DEG;
  const ez = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z)) / DEG;
  const wrap = (a) => ((a % 360) + 360) % 360;
  return [wrap(ex), wrap(ey), wrap(ez)];
}

export function quatMul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function normalizeQuat(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  return l > 1e-9 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1];
}

export function rotateVec(q, v) {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}

/** 3x3 rotation (row-major rows) of a unit quaternion. */
function quatMat(q) {
  const [x, y, z, w] = q;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

/** Unity tile-local point -> scene point (right-handed, north -z, origin at the pixel centre). */
export const tileToScene = (u) => [u[0] - HALF_PIXEL, u[1], HALF_PIXEL - u[2]];
/** Unity quaternion -> the same rotation in the scene frame (mirror z). */
export const quatToScene = (q) => [-q[0], -q[1], q[2], q[3]];
/** Heading in radians, 0 = north (-z), clockwise from above, of a Unity rotation's forward (+z) axis. */
export const headingOf = (q) => {
  const f = rotateVec(q, [0, 0, 1]);
  return Math.atan2(f[0], f[2]);
};

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const r6 = (v) => Math.round(v * 1e6) / 1e6 || 0;

// ---------------------------------------------------------------------------------------------- placement

/** Location Loader footprint in terrain tiles, rotated about Y and scaled. */
export function instanceDimensions(inst, prefab) {
  const ey = quatToEulerDeg(inst.rot)[1] * DEG;
  let c = Math.abs(Math.cos(ey)), s = Math.abs(Math.sin(ey));
  if (c < 0.01) c = 0;
  if (s < 0.01) s = 0;
  if (Math.abs(c - 1) < 0.01) c = 1;
  if (Math.abs(s - 1) < 0.01) s = 1;
  const k = inst.scale;
  const width = Math.ceil(r6(c * k * prefab.width + s * k * prefab.height));
  const height = Math.ceil(r6(s * k * prefab.width + c * k * prefab.height));
  return { width, height, halfWidth: Math.trunc((width + 1) / 2), halfHeight: Math.trunc((height + 1) / 2) };
}

/** Type 0 instances must lie inside their pixel; 1-3 may overflow. */
export function isOutOfBounds(inst, prefab) {
  if (inst.type === 1 || inst.type === 2 || inst.type === 3) return false;
  const d = instanceDimensions(inst, prefab);
  return (
    inst.terrainX + d.halfWidth > TERRAIN_SIZE ||
    inst.terrainX - d.halfWidth < 0 ||
    inst.terrainY + d.halfHeight > TERRAIN_SIZE ||
    inst.terrainY - d.halfHeight < 0
  );
}

/**
 * Map pixels an instance's ground rect touches, with the rect section in each (Location Loader's overlapping
 * terrain sections). Types 0 and 2 stay in their own pixel. Pixel y grows south while terrainY grows north.
 * @returns {Array<{px:number, py:number, rect:{x:number,y:number,width:number,height:number}}>}
 */
export function overlappingSections(inst, prefab) {
  const d = instanceDimensions(inst, prefab);
  const { terrainX: tx, terrainY: ty } = inst;
  if (inst.type !== 1 && inst.type !== 3) {
    return [{ px: inst.worldX, py: inst.worldY, rect: { x: tx - d.halfWidth, y: ty - d.halfHeight, width: d.halfWidth * 2, height: d.halfHeight * 2 } }];
  }
  const xMin = Math.floor((tx - d.halfWidth) / TERRAIN_SIZE), xMax = Math.trunc((tx + d.halfWidth) / TERRAIN_SIZE);
  const yMin = Math.floor((ty - d.halfHeight) / TERRAIN_SIZE), yMax = Math.trunc((ty + d.halfHeight) / TERRAIN_SIZE);
  const out = [];
  for (let xo = xMin; xo <= xMax; xo++) {
    for (let yo = yMin; yo <= yMax; yo++) {
      const px = inst.worldX + xo, py = inst.worldY - yo;
      if (!isMapPixel(px, py)) continue;
      const x0 = Math.max(tx - d.halfWidth - xo * TERRAIN_SIZE, 0), x1 = Math.min(tx + d.halfWidth - xo * TERRAIN_SIZE, TERRAIN_SIZE);
      const y0 = Math.max(ty - d.halfHeight - yo * TERRAIN_SIZE, 0), y1 = Math.min(ty + d.halfHeight - yo * TERRAIN_SIZE, TERRAIN_SIZE);
      out.push({ px, py, rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
    }
  }
  return out;
}

/** A WorldData replacement town's block area in its pixel (tile units), or null. */
export function worldDataTownArea(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const x = Math.trunc((TERRAIN_SIZE - width * 16) / 2), y = Math.trunc((TERRAIN_SIZE - height * 16) / 2);
  return { x, y, width: width * 16, height: height * 16 };
}

const rectsOverlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Whether Location Loader would refuse an instance: missing prefab, out of bounds, or on a WorldData town.
 * @param {(px:number, py:number) => ({x,y,width,height}|null)} [townAreaAt]
 * @returns {string|null} reason, or null when it is placed
 */
export function rejectReason(inst, prefab, townAreaAt = null) {
  if (!prefab) return 'prefab missing';
  if (isOutOfBounds(inst, prefab)) return 'out of bounds';
  if (townAreaAt) {
    for (const s of overlappingSections(inst, prefab)) {
      const area = townAreaAt(s.px, s.py);
      if (area && rectsOverlap(area, s.rect)) return 'on a town';
    }
  }
  return null;
}

/**
 * Assigns stable site ids to the instances on one pixel, given in deterministic load order
 * (source file path ordinal order, then row order).
 */
export function assignSiteIds(instances) {
  const seen = new Map();
  return instances.map((inst) => {
    const key = `${inst.worldX},${inst.worldY}:${inst.terrainX},${inst.terrainY}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return siteId(inst.worldX, inst.worldY, inst.terrainX, inst.terrainY, n);
  });
}

/** Ordinal (UTF-16 code unit) comparison, used for every deterministic order. */
export const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------- objects

/** What a prefab object becomes in a scene. */
export function classifyObject(o) {
  if (o.type === 0) return { kind: 'model', model: parseInt32(o.name) };
  if (o.type === 1) {
    const [a, r] = o.name.split('.').map((x) => parseInt32(x));
    const c = { kind: 'flat', archive: a, record: r };
    if (a === LIGHT_ARCHIVE) c.light = true;
    if (a === TREASURE_ARCHIVE) c.loot = true;
    return c;
  }
  if (o.type === 2) {
    const record = parseInt32(o.name.split('.')[1]);
    const c = { kind: 'marker', marker: record };
    if (record === MARKER.Monster) {
      const enemy = markerEnemyId(o.extraData);
      if (enemy !== null) c.enemy = enemy;
      const team = markerTeam(o.extraData);
      if (team) c.team = team;
    }
    if (record === MARKER.RandomTreasure) c.loot = true;
    return c;
  }
  if (o.type === 5) return { kind: 'block', block: o.name };
  if (o.type === 4) return { kind: 'prefab', name: o.name };
  return { kind: 'layout', name: o.name }; // type 3, expanded by composeSite
}

// Affine transforms in Unity tile space: 3x4 row-major [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz].
function trs(pos, q, scale) {
  const R = quatMat(q);
  return [
    R[0][0] * scale[0], R[0][1] * scale[1], R[0][2] * scale[2], pos[0],
    R[1][0] * scale[0], R[1][1] * scale[1], R[1][2] * scale[2], pos[1],
    R[2][0] * scale[0], R[2][1] * scale[1], R[2][2] * scale[2], pos[2],
  ];
}

function affMul(a, b) {
  const o = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let v = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
      if (c === 3) v += a[r * 4 + 3];
      o[r * 4 + c] = v;
    }
  }
  return o;
}

/** Column-major 4x4 from model-local metres (Unity local, as town.js meshes are built) to scene metres:
 *  diag(1,1,-1) * M + pixel offset. Its determinant is negative (the z mirror), as in town.js. */
function sceneMatrix(M, shift) {
  const t = tileToScene([M[3], M[7], M[11]]);
  const m = new Array(16).fill(0);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) m[col * 4 + row] = r6((row === 2 ? -1 : 1) * M[row * 4 + col]);
  }
  m[12] = r4(t[0] + shift[0]);
  m[13] = r4(t[1]);
  m[14] = r4(t[2] + shift[2]);
  m[15] = 1;
  return m;
}

export const MAX_PREFAB_DEPTH = 4;

/**
 * Composes one placed instance into scene records.
 * @param {object} inst parsed instance
 * @param {object} prefab parsed prefab
 * @param {object} opts {id, file, region, offsetPx?:[dx,dy], getPrefab?(name) -> prefab|null}
 *   `offsetPx` is the instance pixel minus the scene pixel; `getPrefab` resolves type 3 (embedded layouts).
 */
export function composeSite(inst, prefab, opts = {}) {
  const [dpx, dpy] = opts.offsetPx ?? [0, 0];
  const shift = [dpx * TERRAIN_PIXEL_SIZE, 0, dpy * TERRAIN_PIXEL_SIZE];
  const toScene = (u) => {
    const p = tileToScene(u);
    return [p[0] + shift[0], p[1], p[2] + shift[2]];
  };
  const seaLevel = inst.type === 2 || inst.type === 3;
  const rootU = [inst.terrainX * TILE_METRES, 0, inst.terrainY * TILE_METRES];
  const rootQ = normalizeQuat(inst.rot);
  const k = inst.scale;
  const dims = instanceDimensions(inst, prefab);
  const kind = siteKind(inst.name, inst.prefab, opts.file);
  const anchor = toScene(rootU);
  const site = {
    id: opts.id,
    name: displayName(inst.name, inst.prefab),
    kind,
    prefab: inst.prefab,
    instanceType: inst.type,
    pixel: [inst.worldX, inst.worldY],
    tile: { x: inst.terrainX, y: inst.terrainY },
    width: prefab.width,
    height: prefab.height,
    ground: seaLevel ? 'sea' : 'site',
    anchor: anchor.map(r4),
    rotation: quatToScene(rootQ).map(r6),
    yaw: r6(headingOf(rootQ)),
    scale: k,
    sink: inst.sink,
    rect: {
      x: r4(anchor[0] - dims.halfWidth * TILE_METRES),
      z: r4(anchor[2] - dims.halfHeight * TILE_METRES),
      width: r4(dims.halfWidth * 2 * TILE_METRES),
      depth: r4(dims.halfHeight * 2 * TILE_METRES),
    },
    objects: [],
    markers: [],
  };
  if (opts.region) site.region = opts.region;
  const missing = new Set();

  // node: {M (Unity affine), q (accumulated rotation), s (accumulated per-axis scale), path (objectID chain)}
  const walk = (pf, node, depth, chain) => {
    for (const o of pf.obj) {
      if (!validateObject(o.type, o.name)) continue;
      const oid = node.path ? `${node.path}.${o.objectID}` : o.objectID;
      // Flats and markers never rotate (Location Loader HasRotation: types 0, 3, 4).
      const hasRotation = o.type === 0 || o.type === 3 || o.type === 4;
      const lq = hasRotation ? o.rot : [0, 0, 0, 1];
      const M = affMul(node.M, trs(o.pos, lq, o.scale));
      const q = normalizeQuat(quatMul(node.q, lq));
      const s = [node.s[0] * o.scale[0], node.s[1] * o.scale[1], node.s[2] * o.scale[2]];
      const p = toScene([M[3], M[7], M[11]]);
      if (o.type === 3) {
        const key = String(o.name).toLowerCase();
        const sub = depth < MAX_PREFAB_DEPTH && !chain.includes(key) && opts.getPrefab ? opts.getPrefab(o.name) : null;
        if (!sub) {
          missing.add(o.name);
          continue;
        }
        walk(sub, { M, q, s, path: String(oid) }, depth + 1, [...chain, key]);
        continue;
      }
      const c = o.type === 4 ? { kind: 'prefab', name: o.name } : classifyObject(o);
      if (c.kind === 'marker') {
        const m = { objectID: oid, marker: c.marker, position: p.map(r4) };
        if (c.enemy !== undefined) m.enemy = c.enemy;
        if (c.team) m.team = c.team;
        if (c.loot) m.loot = true;
        site.markers.push(m);
        continue;
      }
      // Flats: position (base), scale. Everything else: position plus the exact model->scene matrix.
      const rec = { objectID: oid, ...c, position: p.map(r4) };
      if (c.kind === 'flat') {
        rec.scale = s.map(r6);
        rec.align = 'base';
      } else {
        rec.matrix = sceneMatrix(M, shift);
      }
      if (o.groundPlane) rec.groundPlane = true;
      site.objects.push(rec);
    }
  };
  walk(prefab, { M: trs(rootU, rootQ, [k, k, k]), q: rootQ, s: [k, k, k], path: '' }, 0, [String(inst.prefab).toLowerCase()]);
  if (missing.size) site.missing = [...missing].sort(ordinal).slice(0, 16);
  return site;
}

/** Spawn for a scene: just south of the focused site's ground rect, facing north; the pixel centre otherwise. */
export function spawnFor(site) {
  if (!site) return { x: 0, y: 0, z: 0, yaw: 0 };
  const z = site.rect.z + site.rect.depth + 4;
  const clamp = (v) => Math.max(-HALF_PIXEL + 1, Math.min(HALF_PIXEL - 1, v));
  return { x: r4(clamp(site.anchor[0])), y: 0, z: r4(clamp(z)), yaw: 0 };
}

/**
 * Builds the public scene descriptor for one pixel.
 * @param {{px:number, py:number, region?:string|null, sites:object[], focus?:string|null}} input
 *   `sites` are composeSite() results already in this pixel's frame, in load order.
 */
export function composeScene({ px, py, region = null, sites = [], focus = null }) {
  const own = sites.filter((s) => s.pixel[0] === px && s.pixel[1] === py);
  const focused = sites.find((s) => s.id === focus) ?? own.find((s) => isPointOfInterest(s.kind)) ?? own[0] ?? null;
  const scene = {
    v: SCENE_VERSION,
    id: wildernessId(px, py),
    px,
    py,
    region,
    frame: SCENE_FRAME,
    tile: { size: TERRAIN_PIXEL_SIZE, origin: [-HALF_PIXEL, 0, HALF_PIXEL] },
    spawn: spawnFor(focused),
    sites,
  };
  const ri = region ? REGION_NAMES.findIndex((n) => n.toLowerCase() === String(region).toLowerCase()) : -1;
  if (ri >= 0) scene.regionIndex = ri;
  return scene;
}

/** Region index for a folder name (`Daggerfall` or `17`), else -1. */
export function regionIndexOf(folder) {
  const s = String(folder);
  if (/^\d{1,2}$/.test(s)) return Number(s) < REGION_NAMES.length ? Number(s) : -1;
  return REGION_NAMES.findIndex((n) => n.toLowerCase() === s.toLowerCase());
}

export const regionNameOf = (folder) => {
  const i = regionIndexOf(folder);
  return i >= 0 ? REGION_NAMES[i] : String(folder);
};
