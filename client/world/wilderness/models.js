// World of Daggerfall model pieces: scale-aware texturing and triangle output for ARCH3D models
// placed by the mod's location layouts. DOM-free and Node-free, so the browser renderer and the
// server's collision builder share one geometry path.
//
// Why this exists (audit of world-of-daggerfall @3bf8837, docs/world-of-daggerfall.md): the
// release's shipped layouts reference no custom FBX/prefab. Its rocks and mountains are ARCH3D
// "pebbles" (models 60711-60720, 41719) stretched up to ~200x per axis by the layout object scale
// times the CSV `scale` column. Daggerfall's own UVs ride that stretch, so a 64-texel rock
// texture smears across hundreds of metres of cliff. Here each plane of a stretched piece is
// re-textured by an isometric unfold: the texture keeps the pebble's texels-per-metre, its rows
// run along the image of the pebble's own rows, and it tiles (REPEAT) across the face.
//
// Credit: the problem analysis, the pebble set, the stretch thresholds (1.05 for pebbles, 4 for
// anything else) and the 8 m rock repeat cap come from the MIT-licensed dfjs-research-03
// (src/world/worldOfDaggerfall/wodRockUv.js, Copyright (c) 2026 Lattymoy). This file is an
// independent implementation of that idea, not a copy.
//
// Conventions
//   model metres  town.js convention: (x * SCALE, -y * SCALE, z * SCALE), y up (modelPlanesToMetres)
//   matrix        column-major 4x4 (16 numbers) from model metres to scene metres, T * R * S
//   u, v          texels, as decodeMesh returns them (texture-space pixels; divide by the texture size)

/** Metres per Daggerfall unit; equals client/world/town.js SCALE. */
export const SCALE = 0.025;

/** ARCH3D models the mod builds outcrops and massifs from. */
export const WOD_ROCK_MODELS = Object.freeze(
  new Set([60610, 60711, 60712, 60713, 60714, 60715, 60716, 60717, 60718, 60719, 60720, 41719]),
);
/** A rock pebble is unfolded from any real stretch, so pieces of one outcrop share a texel density. */
export const WOD_ROCK_PEBBLE_MIN = 1.05;
/** Any other model is unfolded once stretched this much on some axis (palisades, dock planks). */
export const WOD_STRETCH_MIN = 4;
/** Rock faces tile no finer than one repeat per this many metres (pebble art reads as a lattice otherwise). */
export const WOD_ROCK_METRES_PER_REPEAT = 8;

// ---- small vector helpers (arrays of 3) ----
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : null;
};
const lin = (m, p) => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2], m[1] * p[0] + m[5] * p[1] + m[9] * p[2], m[2] * p[0] + m[6] * p[1] + m[10] * p[2]];
const xform = (m, p) => {
  const q = lin(m, p);
  return [q[0] + m[12], q[1] + m[13], q[2] + m[14]];
};

/** Largest axis stretch of a column-major matrix's 3x3 (rotation-independent). */
export function pieceStretch(m) {
  return Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]));
}

/** Determinant of the 3x3 part; negative for a mirrored piece. */
export function linearDeterminant(m) {
  return dot([m[0], m[1], m[2]], cross([m[4], m[5], m[6]], [m[8], m[9], m[10]]));
}

/** Whether a piece's faces take unfolded UVs instead of the model's own. */
export function needsUnfold(modelId, matrix) {
  const s = pieceStretch(matrix);
  return WOD_ROCK_MODELS.has(modelId) ? s >= WOD_ROCK_PEBBLE_MIN : s >= WOD_STRETCH_MIN;
}

/** decodeMesh() output -> the same planes in model metres (y up). u/v stay in texels. */
export function modelPlanesToMetres(mesh) {
  return {
    id: mesh.id,
    planes: mesh.planes.map((p) => ({
      archive: p.archive,
      record: p.record,
      points: p.points.map((q) => ({ x: q.x * SCALE, y: -q.y * SCALE, z: q.z * SCALE, u: q.u, v: q.v })),
    })),
  };
}

/**
 * The plane's texture map as an affine function of in-plane metric coordinates:
 * uv = c + A * (s, r) with s along the texture rows (dP/du) and r = n x rows. Null when the
 * plane is degenerate or its UVs do not span (a solid-colour face): those keep their own UVs.
 */
function planeTextureFrame(pts) {
  const P = pts.map((q) => [q.x, q.y, q.z]);
  // The widest triangle of the polygon gives the best-conditioned fit.
  let best = null;
  let bestArea = 0;
  for (let j = 1; j < P.length - 1; j++) {
    for (let k = j + 1; k < P.length; k++) {
      const a = Math.hypot(...cross(sub(P[j], P[0]), sub(P[k], P[0])));
      if (a > bestArea) (bestArea = a), (best = [0, j, k]);
    }
  }
  if (!best || bestArea < 1e-10) return null;
  const [i0, i1, i2] = best;
  const e1 = norm(sub(P[i1], P[i0]));
  const n = norm(cross(sub(P[i1], P[i0]), sub(P[i2], P[i0])));
  const e2 = cross(n, e1);
  const a1 = [dot(sub(P[i1], P[i0]), e1), dot(sub(P[i1], P[i0]), e2)];
  const a2 = [dot(sub(P[i2], P[i0]), e1), dot(sub(P[i2], P[i0]), e2)];
  const det = a1[0] * a2[1] - a1[1] * a2[0];
  if (Math.abs(det) < 1e-12) return null;
  const du1 = pts[i1].u - pts[i0].u, du2 = pts[i2].u - pts[i0].u;
  const dv1 = pts[i1].v - pts[i0].v, dv2 = pts[i2].v - pts[i0].v;
  // M maps (a.x, a.y) in (e1, e2) to (du, dv).
  const M = [
    [(du1 * a2[1] - du2 * a1[1]) / det, (du2 * a1[0] - du1 * a2[0]) / det],
    [(dv1 * a2[1] - dv2 * a1[1]) / det, (dv2 * a1[0] - dv1 * a2[0]) / det],
  ];
  const mdet = M[0][0] * M[1][1] - M[0][1] * M[1][0];
  if (Math.abs(mdet) < 1e-12) return null;
  // dP/du in (e1, e2): first column of M^-1.
  const rows = norm([M[1][1] / mdet * e1[0] + -M[1][0] / mdet * e2[0], M[1][1] / mdet * e1[1] + -M[1][0] / mdet * e2[1], M[1][1] / mdet * e1[2] + -M[1][0] / mdet * e2[2]]);
  if (!rows) return null;
  const t = rows;
  const b = cross(n, t);
  // Change of basis: (s, r) in (t, b) -> (e1, e2) coordinates, then through M.
  const R = [
    [dot(t, e1), dot(b, e1)],
    [dot(t, e2), dot(b, e2)],
  ];
  const A = [
    [M[0][0] * R[0][0] + M[0][1] * R[1][0], M[0][0] * R[0][1] + M[0][1] * R[1][1]],
    [M[1][0] * R[0][0] + M[1][1] * R[1][0], M[1][0] * R[0][1] + M[1][1] * R[1][1]],
  ];
  return { origin: P[i0], uv0: [pts[i0].u, pts[i0].v], t, b, n, e1, A, P };
}

/**
 * New texel UVs for one plane of a stretched piece (one per point, same order).
 * @param {{points: Array<{x,y,z,u,v}>}} plane  model metres
 * @param {ArrayLike<number>} matrix  column-major model -> scene
 * @param {{texW?: number, texH?: number, rock?: boolean, metresPerRepeat?: number}} [opts]
 *   texW/texH: the plane's texture size in texels (needed for the rock cap and the repeat shift)
 * @returns {Array<{u:number, v:number}>}
 */
export function unfoldPlaneUvs(plane, matrix, opts = {}) {
  const pts = plane.points;
  const f = planeTextureFrame(pts);
  if (!f) return pts.map((q) => ({ u: q.u, v: q.v }));
  const texW = opts.texW > 0 ? opts.texW : 64;
  const texH = opts.texH > 0 ? opts.texH : 64;
  // The plane's frame carried through the matrix: rows follow the image of the pebble's rows.
  const t2 = norm(lin(matrix, f.t));
  const n2 = norm(cross(lin(matrix, f.e1), lin(matrix, cross(f.n, f.e1))));
  if (!t2 || !n2) return pts.map((q) => ({ u: q.u, v: q.v }));
  const b2 = cross(n2, t2);
  let A = f.A;
  if (opts.rock) {
    const per = opts.metresPerRepeat > 0 ? opts.metresPerRepeat : WOD_ROCK_METRES_PER_REPEAT;
    // Repeats per metre in the worst direction: the largest singular value of the map with
    // u and v normalised to repeats (pebble maps can be sheared, so rows alone undercount).
    const a = A[0][0] / texW, b = A[0][1] / texW, c = A[1][0] / texH, d = A[1][1] / texH;
    const p = a * a + c * c, q = b * b + d * d, r = a * b + c * d;
    const sigma = Math.sqrt((p + q) / 2 + Math.sqrt(((p - q) / 2) ** 2 + r * r));
    const k = sigma > 0 ? Math.min(1, 1 / per / sigma) : 1;
    if (k < 1) A = A.map((row) => row.map((x) => x * k));
  }
  const o2 = lin(matrix, f.origin);
  const out = f.P.map((p) => {
    const d = sub(lin(matrix, p), o2);
    const s = dot(d, t2), r = dot(d, b2);
    return { u: f.uv0[0] + A[0][0] * s + A[0][1] * r, v: f.uv0[1] + A[1][0] * s + A[1][1] * r };
  });
  // Whole-repeat shift so float32 keeps precision on kilometre faces (invisible under REPEAT).
  let mu = Infinity, mv = Infinity;
  for (const q of out) (mu = Math.min(mu, q.u)), (mv = Math.min(mv, q.v));
  const su = Math.floor(mu / texW) * texW, sv = Math.floor(mv / texH) * texH;
  for (const q of out) (q.u -= su), (q.v -= sv);
  return out;
}

/**
 * Flat triangle lists for one placed piece, grouped by texture.
 * @param {{id:number, planes:Array}} mesh  model metres (modelPlanesToMetres)
 * @param {ArrayLike<number>} matrix  column-major model -> scene
 * @param {{textureSize?: (archive:number, record:number) => ({w:number,h:number}|null), unfold?: boolean}} [opts]
 * @returns {{unfolded: boolean, mirrored: boolean, groups: Array<{archive, record, positions: Float32Array, uvs: Float32Array, normals: Float32Array}>}}
 */
export function pieceTriangles(mesh, matrix, opts = {}) {
  const unfold = opts.unfold ?? needsUnfold(mesh.id, matrix);
  const rock = WOD_ROCK_MODELS.has(mesh.id);
  const mirrored = linearDeterminant(matrix) < 0;
  const acc = new Map();
  for (const plane of mesh.planes) {
    const pts = plane.points;
    if (pts.length < 3) continue;
    const size = opts.textureSize?.(plane.archive, plane.record) ?? null;
    const uvs = unfold ? unfoldPlaneUvs(plane, matrix, { texW: size?.w, texH: size?.h, rock }) : pts.map((q) => ({ u: q.u, v: q.v }));
    const W = pts.map((q) => xform(matrix, [q.x, q.y, q.z]));
    const key = `${plane.archive}:${plane.record}`;
    let g = acc.get(key);
    if (!g) acc.set(key, (g = { archive: plane.archive, record: plane.record, p: [], uv: [], n: [] }));
    for (let i = 1; i < pts.length - 1; i++) {
      // A mirrored matrix flips winding; swap to keep the model's facing.
      const tri = mirrored ? [0, i + 1, i] : [0, i, i + 1];
      const nn = norm(cross(sub(W[tri[1]], W[tri[0]]), sub(W[tri[2]], W[tri[0]])));
      if (!nn) continue;
      for (const j of tri) {
        g.p.push(W[j][0], W[j][1], W[j][2]);
        g.uv.push(uvs[j].u, uvs[j].v);
        g.n.push(nn[0], nn[1], nn[2]);
      }
    }
  }
  const groups = [...acc.values()].map((g) => ({
    archive: g.archive,
    record: g.record,
    positions: new Float32Array(g.p),
    uvs: new Float32Array(g.uv),
    normals: new Float32Array(g.n),
  }));
  return { unfolded: unfold, mirrored, groups };
}

/** Positions only (9 floats per triangle) for collision; no texture work. */
export function pieceCollisionPositions(mesh, matrix, out = []) {
  for (const plane of mesh.planes) {
    const pts = plane.points;
    if (pts.length < 3) continue;
    const W = pts.map((q) => xform(matrix, [q.x, q.y, q.z]));
    for (let i = 1; i < pts.length - 1; i++) {
      const a = W[0], b = W[i], c = W[i + 1];
      if (!(Math.hypot(...cross(sub(b, a), sub(c, a))) > 1e-9)) continue;
      out.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    }
  }
  return out;
}

// =============================================================================================
// Custom mod prefabs (Location Loader object type 4)
// =============================================================================================
// Pinned Location Loader (KABoissonneault/DFU-LocationLoader @a5e7a187) instantiates a type-4
// object as the mod's Unity prefab of that name (LocationResourceManager.InstantiateUnityPrefab,
// localScale = prefab root scale x object scale). Numeric type-4 names are ARCH3D models
// (LocationHelper.FixupLocationObjectData). At world-of-daggerfall @3bf8837 the 47 named ones
// referenced by shipped layouts are all one-transform prefabs: MeshFilter (an FBX mesh asset),
// MeshRenderer (2 material slots), MeshCollider (same mesh), WODRocksMaterials.
//
// Unity import rules reproduced (ModelImporter, .meta: globalScale 1, useFileScale 1,
// bakeAxisConversion off, importNormals Import):
//   position = (-x, y, z) * UnitScaleFactor / 100 * globalScale   (right- to left-handed, file units -> m)
//   normal   = (-nx, ny, nz); triangle winding reversed with the mirror
//   submesh k = k-th distinct FBX material index used, ascending -> prefab m_Materials[k]
//   n-gons are ear-clipped in their own plane (the mod's mountains have caps of 100+ vertices)
// The prefab references the mesh asset directly, so the FBX Model node's Lcl transform (e.g. the
// Blender exporter's scale 100) is not applied - only GeometricTranslation/Rotation/Scaling would be,
// and those are identity in every shipped mesh (asserted, reported if not).
// Output stays in Unity's left-handed model metres, the same space as modelPlanesToMetres, so the
// renderer's modelMatrix (T * R * S * mirror z) places both kinds alike.

export const WOD_ROCKS_MATERIALS_SCRIPT = '426f76434556e931a830bf5c83c73b54';
/** DFU's own AssetInjection RuntimeMaterials component (per-slot ARENA2 archive/record, optional climate swap). */
export const DFU_RUNTIME_MATERIALS_SCRIPT = '5a6e6870983c00144809e2c44cdd0bc6';
export const CLIMATE = Object.freeze({
  Ocean: 223, Desert: 224, Desert2: 225, Mountain: 226, Rainforest: 227,
  Swamp: 228, Subtropical: 229, MountainWoods: 230, Woodlands: 231, HauntedWoodlands: 232,
});
const HAMMERFELL_REGIONS = ["Alik'r Desert", 'Dragontail Mountains', "Dak'fron", 'Lainlyn', 'Tigonus', 'Ephesus', 'Santaki'];

const v3 = (s) => {
  const m = /\{x: ?([-\d.eE]+), ?y: ?([-\d.eE]+), ?z: ?([-\d.eE]+)(?:, ?w: ?([-\d.eE]+))?\}/.exec(s ?? '');
  return m ? m.slice(1).filter((x) => x !== undefined).map(Number) : null;
};

/** The GUID line of a Unity .meta file. */
export function parseMetaGuid(text) {
  return /^guid: ([0-9a-f]{32})/m.exec(text)?.[1] ?? null;
}

/**
 * A Unity prefab (YAML text) reduced to what a static mesh prefab needs.
 * @returns {{name, transforms: number, position, rotation, scale, meshGuid, materialGuids: string[], meshCollider: boolean, wodRocksMaterials: boolean, children: number}}
 */
export function parseUnityPrefab(text) {
  const docs = text.split(/\n--- !u!/).slice(1).map((d) => ({ cls: Number(/^(\d+)/.exec(d)?.[1]), body: d }));
  const go = docs.filter((d) => d.cls === 1);
  const tr = docs.filter((d) => d.cls === 4);
  const root = tr.find((d) => /m_Father: \{fileID: 0\}/.test(d.body)) ?? tr[0];
  const mf = docs.find((d) => d.cls === 33);
  const mr = docs.find((d) => d.cls === 23);
  const mats = mr ? /m_Materials:\n((?:\s*- \{[^\n]*\n)+)/.exec(mr.body + '\n')?.[1] ?? '' : '';
  return {
    name: /m_Name: ([^\n]*)/.exec(go[0]?.body ?? '')?.[1]?.trim() ?? '',
    transforms: tr.length,
    children: tr.length - 1,
    position: v3(/m_LocalPosition: (\{[^}]*\})/.exec(root?.body ?? '')?.[1]) ?? [0, 0, 0],
    rotation: v3(/m_LocalRotation: (\{[^}]*\})/.exec(root?.body ?? '')?.[1]) ?? [0, 0, 0, 1],
    scale: v3(/m_LocalScale: (\{[^}]*\})/.exec(root?.body ?? '')?.[1]) ?? [1, 1, 1],
    meshGuid: mf ? (/m_Mesh: \{fileID: -?\d+, guid: ([0-9a-f]{32})/.exec(mf.body)?.[1] ?? null) : null,
    materialGuids: [...mats.matchAll(/guid: ([0-9a-f]{32})/g)].map((m) => m[1]),
    meshCollider: docs.some((d) => d.cls === 64),
    wodRocksMaterials: text.includes(`guid: ${WOD_ROCKS_MATERIALS_SCRIPT}`),
    dfuRuntimeMaterials: parseDfuRuntimeMaterials(docs.find((d) => d.cls === 114 && d.body.includes(`guid: ${DFU_RUNTIME_MATERIALS_SCRIPT}`))?.body),
  };
}

function parseDfuRuntimeMaterials(body) {
  if (!body) return null;
  const list = [];
  for (const m of body.matchAll(/- Index: (\d+)\s*\n\s*Archive: (\d+)\s*\n\s*Record: (\d+)\s*\n\s*ApplyClimate: (\d)/g)) {
    list.push({ index: Number(m[1]), archive: Number(m[2]), record: Number(m[3]), applyClimate: m[4] === '1' });
  }
  return { materials: list, useDungeonTextureTable: /UseDungeonTextureTable: 1/.test(body) };
}

/** A Unity .mat: main texture GUID, its tiling/offset and the colour tint. */
export function parseUnityMaterial(text) {
  const tex = /- _MainTex:\s*\n\s*m_Texture: \{fileID: -?\d+(?:, guid: ([0-9a-f]{32}))?[^}]*\}\s*\n\s*m_Scale: \{x: ([-\d.eE]+), y: ([-\d.eE]+)\}\s*\n\s*m_Offset: \{x: ([-\d.eE]+), y: ([-\d.eE]+)\}/.exec(text);
  const col = /- _Color: \{r: ([-\d.eE]+), g: ([-\d.eE]+), b: ([-\d.eE]+), a: ([-\d.eE]+)\}/.exec(text);
  return {
    name: /m_Name: ([^\n]*)/.exec(text)?.[1]?.trim() ?? '',
    textureGuid: tex?.[1] ?? null,
    tiling: tex ? [Number(tex[2]), Number(tex[3])] : [1, 1],
    offset: tex ? [Number(tex[4]), Number(tex[5])] : [0, 0],
    color: col ? col.slice(1).map(Number) : [1, 1, 1, 1],
  };
}

/** Ear-clip one polygon (indices into a 3D point list) in its own plane. Falls back to a fan. */
export function triangulatePolygon(pts) {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];
  // Newell normal -> drop the dominant axis.
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  const [i0, i1, sign] = az >= ax && az >= ay ? [0, 1, Math.sign(nz)] : ax >= ay ? [1, 2, Math.sign(nx)] : [2, 0, Math.sign(ny)];
  const P = pts.map((p) => [p[i0], p[i1]]);
  const area2 = (a, b, c) => ((P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0])) * (sign || 1);
  const inside = (p, a, b, c) => area2(a, b, p) >= 0 && area2(b, c, p) >= 0 && area2(c, a, p) >= 0;
  const idx = [...Array(n).keys()];
  const out = [];
  let guard = n * n;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const a = idx[(k + idx.length - 1) % idx.length], b = idx[k], c = idx[(k + 1) % idx.length];
      if (area2(a, b, c) <= 1e-12) continue;
      let ok = true;
      for (const p of idx) if (p !== a && p !== b && p !== c && inside(p, a, b, c)) { ok = false; break; }
      if (!ok) continue;
      out.push([a, b, c]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  else if (idx.length > 3) for (let k = 1; k < idx.length - 1; k++) out.push([idx[0], idx[k], idx[k + 1]]); // degenerate leftovers
  return out;
}

function layerValue(el, polyVert, vert, poly, width) {
  if (!el?.data) return null;
  let i;
  switch (el.mapping) {
    case 'ByPolygonVertex': i = polyVert; break;
    case 'ByVertice': case 'ByVertex': i = vert; break;
    case 'ByPolygon': i = poly; break;
    case 'AllSame': i = 0; break;
    default: return null;
  }
  if (el.reference === 'IndexToDirect' && el.index) i = el.index[i];
  const o = i * width;
  return Array.from(el.data.subarray ? el.data.subarray(o, o + width) : el.data.slice(o, o + width), Number);
}

/**
 * One FBX geometry -> Unity-imported submeshes (left-handed model metres, unindexed triangles).
 * UVs stay as Unity holds them (bottom-left origin, file values).
 * @param {ReturnType<import('./fbx.js').fbxGeometries>} fbx
 * @param {{globalScale?: number, useFileScale?: boolean}} [importer]
 */
export function unityMeshFromFbx(fbx, importer = {}) {
  const g = fbx.geometries[0];
  if (!g) throw new Error('FBX has no mesh geometry');
  const notes = [];
  if (fbx.geometries.length > 1) notes.push(`${fbx.geometries.length} geometries; first used (prefab references mesh 4300000)`);
  const gm = g.model;
  if (gm && (gm.geometricTranslation.some((x) => x) || gm.geometricRotation.some((x) => x) || gm.geometricScaling.some((x) => x !== 1))) {
    notes.push('geometric transform present and NOT applied');
  }
  if (fbx.upAxis !== 1 || fbx.frontAxis !== 2 || fbx.coordAxis !== 0) notes.push(`non-default FBX axes (up ${fbx.upAxis}, front ${fbx.frontAxis}, coord ${fbx.coordAxis})`);
  const s = (importer.useFileScale === false ? 1 : fbx.unitScale / 100) * (importer.globalScale ?? 1);
  const V = g.vertices;
  const PVI = g.polygonVertexIndex;
  const matIdx = (poly) => (g.material?.data ? (g.material.mapping === 'AllSame' ? g.material.data[0] : g.material.data[poly]) : 0);
  const subs = new Map();
  let start = 0, poly = 0;
  for (let k = 0; k < PVI.length; k++) {
    if (PVI[k] >= 0) continue;
    const corners = [];
    for (let j = start; j <= k; j++) {
      const vi = j === k ? ~PVI[j] : PVI[j];
      corners.push({
        p: [-V[vi * 3] * s, V[vi * 3 + 1] * s, V[vi * 3 + 2] * s],
        uv: layerValue(g.uv, j, vi, poly, 2) ?? [0, 0],
        n: (() => {
          const nn = layerValue(g.normal, j, vi, poly, 3);
          return nn ? [-nn[0], nn[1], nn[2]] : null;
        })(),
      });
    }
    const mi = matIdx(poly);
    let sub = subs.get(mi);
    if (!sub) subs.set(mi, (sub = { fbxMaterial: mi, positions: [], uvs: [], normals: [] }));
    for (const [a, b, c] of triangulatePolygon(corners.map((q) => q.p))) {
      // Mirrored (x negated): reverse winding to keep the authored facing.
      for (const q of [corners[a], corners[c], corners[b]]) {
        sub.positions.push(...q.p);
        sub.uvs.push(q.uv[0], q.uv[1]);
        if (q.n) sub.normals.push(...q.n);
        else sub.normals.push(NaN, NaN, NaN);
      }
    }
    start = k + 1;
    poly++;
  }
  const submeshes = [...subs.values()].sort((a, b) => a.fbxMaterial - b.fbxMaterial).map((sm, slot) => {
    const P = new Float32Array(sm.positions);
    const N = new Float32Array(sm.normals);
    // Fill missing normals from the face.
    for (let t = 0; t < P.length; t += 9) {
      if (!Number.isNaN(N[t])) continue;
      const f = norm(cross([P[t + 3] - P[t], P[t + 4] - P[t + 1], P[t + 5] - P[t + 2]], [P[t + 6] - P[t], P[t + 7] - P[t + 1], P[t + 8] - P[t + 2]])) ?? [0, 1, 0];
      for (let j = 0; j < 3; j++) N.set(f, t + j * 3);
    }
    return { slot, fbxMaterial: sm.fbxMaterial, positions: P, uvs: new Float32Array(sm.uvs), normals: N };
  });
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const sm of submeshes) for (let i = 0; i < sm.positions.length; i += 3) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], sm.positions[i + k]);
    hi[k] = Math.max(hi[k], sm.positions[i + k]);
  }
  return { submeshes, bounds: { min: lo, max: hi }, scale: s, notes };
}

/**
 * Index of the operator's pack: what the release bundles and where Unity GUIDs point.
 * Isomorphic: `paths` are pack-relative paths ('/'-separated), `read(path)` resolves to bytes or null.
 * Only the manifest and the .meta files of bundled materials/textures and of meshes are read.
 */
export async function buildWodPackIndex(paths, read) {
  const text = async (p) => {
    const b = await read(p);
    return b ? new TextDecoder().decode(b) : null;
  };
  const manifestText = await text('WorldOfDaggerfall.dfmod.json');
  if (!manifestText) throw new Error('WorldOfDaggerfall.dfmod.json not found in the World of Daggerfall folder');
  const manifest = JSON.parse(manifestText);
  const bundled = new Set((manifest.Files ?? []).map((f) => f.replace(/^.*\/world-of-daggerfall\//, '')));
  const base = (p) => p.slice(p.lastIndexOf('/') + 1);
  const pathSet = new Set(paths);
  const prefabs = {}, runtimeMaterials = {}, materialsByName = {}, guids = {};
  for (const p of bundled) {
    if (!pathSet.has(p)) continue;
    if (p.endsWith('.prefab')) prefabs[base(p).slice(0, -7)] = p;
    else if (p.endsWith('.json') && p.startsWith('CustomRuntimeMaterials/')) runtimeMaterials[base(p).slice(0, -5)] = p;
    else if (p.endsWith('.mat')) materialsByName[base(p).slice(0, -4)] = p;
  }
  // Meshes are bundled as prefab dependencies, so they are not in the manifest: take Meshes/.
  const guidSources = paths.filter((p) => (bundled.has(p) && /\.(mat|png)$/i.test(p)) || (/^Meshes\//.test(p) && /\.(fbx|dae)$/i.test(p)));
  await Promise.all(
    guidSources.map(async (p) => {
      if (!pathSet.has(`${p}.meta`)) return;
      const meta = await text(`${p}.meta`);
      const g = meta && parseMetaGuid(meta);
      if (g) guids[g] = p;
    }),
  );
  return { title: manifest.ModTitle, version: manifest.ModVersion, prefabs, runtimeMaterials, materialsByName, guids };
}

/**
 * Load one custom prefab through the index: prefab YAML -> FBX mesh -> Unity submeshes, its
 * material slots (.mat -> texture path, tiling, tint) and its WODRocksMaterials settings.
 * @returns {Promise<object|null>} null when the pack has no such prefab
 */
export async function loadCustomPrefab(index, read, name, opts = {}) {
  // DFU asset lookups by name are case-insensitive.
  let prefabPath = index.prefabs[name];
  if (!prefabPath) {
    const k = Object.keys(index.prefabs).find((n) => n.toLowerCase() === String(name).toLowerCase());
    if (k) (prefabPath = index.prefabs[k]), (name = k);
  }
  if (!prefabPath) return null;
  const dec = (b) => new TextDecoder().decode(b);
  const prefabBytes = await read(prefabPath);
  if (!prefabBytes) return null;
  const prefab = parseUnityPrefab(dec(prefabBytes));
  const meshPath = prefab.meshGuid && index.guids[prefab.meshGuid];
  if (!meshPath) throw new Error(`${name}: mesh GUID ${prefab.meshGuid} not found in the pack`);
  if (!/\.fbx$/i.test(meshPath)) throw new Error(`${name}: mesh ${meshPath} is not an FBX`);
  const { parseFbx, fbxGeometries } = await import('./fbx.js');
  const fbxBytes = await read(meshPath);
  if (!fbxBytes) throw new Error(`${name}: ${meshPath} is unreadable`);
  const metaText = await read(`${meshPath}.meta`).then((b) => (b ? dec(b) : ''));
  const importer = {
    globalScale: Number(/globalScale: ([-\d.eE]+)/.exec(metaText)?.[1] ?? 1),
    useFileScale: (/useFileScale: (\d)/.exec(metaText)?.[1] ?? '1') === '1',
  };
  const mesh = unityMeshFromFbx(fbxGeometries(await parseFbx(fbxBytes, opts)), importer);
  const materials = await Promise.all(
    prefab.materialGuids.map(async (g) => {
      const p = index.guids[g];
      if (!p) return { path: null, texture: null, tiling: [1, 1], offset: [0, 0], color: [1, 1, 1, 1], missing: g };
      const m = parseUnityMaterial(dec((await read(p)) ?? new Uint8Array()));
      return { path: p, name: m.name, texture: m.textureGuid ? (index.guids[m.textureGuid] ?? null) : null, tiling: m.tiling, offset: m.offset, color: m.color };
    }),
  );
  let runtime = null;
  const rtKey = Object.keys(index.runtimeMaterials).find((n) => n.toLowerCase() === name.toLowerCase());
  if (prefab.wodRocksMaterials && rtKey) {
    const b = await read(index.runtimeMaterials[rtKey]);
    if (b) runtime = JSON.parse(dec(b));
  }
  return {
    name,
    prefab: prefabPath,
    mesh: meshPath,
    root: { position: prefab.position, rotation: prefab.rotation, scale: prefab.scale },
    meshCollider: prefab.meshCollider,
    submeshes: mesh.submeshes,
    bounds: mesh.bounds,
    importScale: mesh.scale,
    notes: mesh.notes,
    materials,
    runtimeMaterials: runtime,
    dfuRuntimeMaterials: prefab.dfuRuntimeMaterials,
  };
}

const nonEmpty = (cm) => (cm?.defaultMaterials?.length ?? 0) > 0;

/**
 * WODRocksMaterials.UpdateMaterialBasedOnClimateAndSeason, reproduced: the {archive, record, frame}
 * list for this climate, season and region, or null (keep the prefab's own materials).
 * @param {object} settings  the prefab's CustomRuntimeMaterials JSON
 * @param {{climate:number, winter?:boolean, region?:string, biomesMod?:boolean, snowlessMod?:boolean}} ctx
 */
export function selectRuntimeMaterials(settings, ctx) {
  if (!settings) return null;
  const c = ctx.climate;
  const S = (k) => settings[k] ?? {};
  let chosen;
  switch (c) {
    case CLIMATE.Desert: chosen = S('desert'); break;
    case CLIMATE.Desert2: chosen = nonEmpty(S('desert2')) ? S('desert2') : S('desert'); break;
    case CLIMATE.Mountain: chosen = S('mountain'); break;
    case CLIMATE.Rainforest: chosen = S('rainforest'); break;
    case CLIMATE.Swamp: chosen = nonEmpty(S('swamp')) ? S('swamp') : S('rainforest'); break;
    case CLIMATE.Subtropical: chosen = nonEmpty(S('subtropical')) ? S('subtropical') : S('desert'); break;
    case CLIMATE.MountainWoods: chosen = nonEmpty(S('mountainWoods')) ? S('mountainWoods') : S('mountain'); break;
    case CLIMATE.HauntedWoodlands:
    case CLIMATE.Ocean: chosen = nonEmpty(S('hauntedWoodlands')) ? S('hauntedWoodlands') : S('woodlands'); break;
    default: chosen = S('woodlands');
  }
  if (c === CLIMATE.Mountain) {
    const has = (cm) => (cm?.defaultMaterials?.length ?? 0) > 0 || (cm?.winterMaterials?.length ?? 0) > 0;
    if (ctx.region === 'Isle of Balfiera' && has(settings.mountainBalfiera)) chosen = settings.mountainBalfiera;
    else if (ctx.biomesMod && HAMMERFELL_REGIONS.includes(ctx.region) && has(settings.mountainHammerfell)) chosen = settings.mountainHammerfell;
    else if (!ctx.biomesMod && HAMMERFELL_REGIONS.includes(ctx.region) && has(settings.mountainBalfiera)) chosen = settings.mountainBalfiera;
  }
  const winter =
    !!ctx.winter &&
    c !== CLIMATE.Desert && c !== CLIMATE.Desert2 && c !== CLIMATE.Subtropical &&
    (!ctx.snowlessMod || (c !== CLIMATE.Rainforest && c !== CLIMATE.Swamp));
  const defs = (winter ? chosen.winterMaterials : chosen.defaultMaterials) ?? [];
  return defs.length ? defs.map((d) => ({ archive: d.archive | 0, record: d.record | 0, frame: d.frame | 0 })) : null;
}

/**
 * The texture each submesh slot draws with, as the game would pick it.
 * Runtime definitions resolve like DFU's MaterialReader: a mod material named
 * "<archive>_<record>-<frame>" (texture replacement) first, else the classic ARENA2 texture.
 * Definitions that resolve to nothing are dropped, as WODRocksMaterials does; a slot left
 * without a material is not drawn (Unity skips submeshes past the material array).
 * @returns {Promise<Array<null | {kind:'arena2', archive, record, frame} | {kind:'pack', path, tiling, offset, color}>>}
 */
export async function resolveCustomMaterials(custom, index, read, ctx = {}) {
  let fromPrefab = custom.materials.map((m) => (m.texture ? { kind: 'pack', path: m.texture, tiling: m.tiling, offset: m.offset, color: m.color } : null));
  // DFU RuntimeMaterials (e.g. the wooden bridge) uses classic textures per slot for the current season.
  const drm = custom.dfuRuntimeMaterials;
  if (drm?.materials?.length && !drm.useDungeonTextureTable) {
    fromPrefab = fromPrefab.slice();
    for (const r of drm.materials) {
      const archive = r.applyClimate && ctx.applyClimate && Number.isFinite(ctx.climateBase) ? ctx.applyClimate(r.archive, r.record, ctx.climateBase, ctx.winter) : r.archive;
      fromPrefab[r.index] = { kind: 'arena2', archive, record: r.record, frame: 0 };
    }
  }
  const defs = selectRuntimeMaterials(custom.runtimeMaterials, ctx);
  if (!defs) return custom.submeshes.map((_, i) => fromPrefab[i] ?? null);
  const out = [];
  for (const d of defs) {
    const matPath = index.materialsByName[`${d.archive}_${d.record}-${d.frame}`];
    if (matPath) {
      const m = parseUnityMaterial(new TextDecoder().decode((await read(matPath)) ?? new Uint8Array()));
      const tex = m.textureGuid ? index.guids[m.textureGuid] : null;
      if (tex) {
        out.push({ kind: 'pack', path: tex, tiling: m.tiling, offset: m.offset, color: m.color });
        continue;
      }
    }
    if (!ctx.hasArena2Texture || ctx.hasArena2Texture(d.archive, d.record)) out.push({ kind: 'arena2', archive: d.archive, record: d.record, frame: d.frame });
  }
  if (!out.length) return custom.submeshes.map((_, i) => fromPrefab[i] ?? null);
  return custom.submeshes.map((_, i) => out[i] ?? null);
}

/**
 * Triangles of a placed custom prefab, grouped per submesh, for the renderer.
 * UVs are returned in REPEATS with a top-left origin (like town.js), material tiling/offset
 * applied, and shifted by whole repeats per triangle so float32 keeps precision; draw them with
 * REPEAT. `matrix` maps the prefab's local metres to the scene (modelMatrix with the prefab root
 * scale folded in: see prefabMatrix).
 */
export function customPieceTriangles(custom, matrix, textures) {
  const mirrored = linearDeterminant(matrix) < 0;
  const groups = [];
  custom.submeshes.forEach((sm, i) => {
    const tex = textures?.[i] ?? null;
    if (!tex) return; // no material -> not drawn, as in Unity
    const [tu, tv] = tex.tiling ?? [1, 1];
    const [ou, ov] = tex.offset ?? [0, 0];
    const P = sm.positions, U = sm.uvs, N = sm.normals;
    const n = P.length / 3;
    const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), nrm = new Float32Array(n * 3);
    // Normals: inverse-transpose of the 3x3 (cofactor matrix; sign fixed for mirrors).
    const m = matrix;
    const c0 = cross([m[4], m[5], m[6]], [m[8], m[9], m[10]]);
    const c1 = cross([m[8], m[9], m[10]], [m[0], m[1], m[2]]);
    const c2 = cross([m[0], m[1], m[2]], [m[4], m[5], m[6]]);
    const sg = mirrored ? -1 : 1;
    for (let t = 0; t < n; t += 3) {
      const order = mirrored ? [0, 2, 1] : [0, 1, 2];
      let su = Infinity, sv = Infinity;
      const tri = order.map((o) => {
        const v = t + o;
        const u = U[v * 2] * tu + ou;
        const vv = 1 - (U[v * 2 + 1] * tv + ov);
        su = Math.min(su, u);
        sv = Math.min(sv, vv);
        return v;
      });
      su = Math.floor(su);
      sv = Math.floor(sv);
      tri.forEach((v, k) => {
        const w = xform(m, [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
        pos.set(w, (t + k) * 3);
        uv[(t + k) * 2] = U[v * 2] * tu + ou - su;
        uv[(t + k) * 2 + 1] = 1 - (U[v * 2 + 1] * tv + ov) - sv;
        const nx = N[v * 3], ny = N[v * 3 + 1], nz = N[v * 3 + 2];
        const wn = norm([
          sg * (c0[0] * nx + c1[0] * ny + c2[0] * nz),
          sg * (c0[1] * nx + c1[1] * ny + c2[1] * nz),
          sg * (c0[2] * nx + c1[2] * ny + c2[2] * nz),
        ]) ?? [0, 1, 0];
        nrm.set(wn, (t + k) * 3);
      });
    }
    groups.push({ slot: i, texture: tex, positions: pos, uvs: uv, normals: nrm });
  });
  return { mirrored, groups };
}

/** Collision positions (9 floats per triangle) of a placed custom prefab: every submesh (MeshCollider uses the whole mesh). */
export function customCollisionPositions(custom, matrix, out = []) {
  for (const sm of custom.submeshes) {
    const P = sm.positions;
    for (let i = 0; i < P.length; i += 9) {
      const a = xform(matrix, [P[i], P[i + 1], P[i + 2]]);
      const b = xform(matrix, [P[i + 3], P[i + 4], P[i + 5]]);
      const c = xform(matrix, [P[i + 6], P[i + 7], P[i + 8]]);
      if (!(Math.hypot(...cross(sub(b, a), sub(c, a))) > 1e-9)) continue;
      out.push(...a, ...b, ...c);
    }
  }
  return out;
}

/**
 * Fold the prefab root's own transform into a placement matrix (Location Loader keeps the
 * root's localScale and multiplies it by the object scale; the root position/rotation are
 * replaced by the object's). Pass the matrix built from the object with scale = rootScale * objScale,
 * or use this to post-multiply a matrix built from the object alone.
 */
export function prefabMatrix(objectMatrix, custom) {
  const [sx, sy, sz] = custom.root?.scale ?? [1, 1, 1];
  if (sx === 1 && sy === 1 && sz === 1) return objectMatrix;
  const m = Array.from(objectMatrix);
  for (let k = 0; k < 3; k++) (m[k] *= sx), (m[4 + k] *= sy), (m[8 + k] *= sz);
  return m;
}

/** JSON-safe form of loadCustomPrefab() output (typed arrays -> plain arrays), for an HTTP transport. */
export function serializeCustomPrefab(custom) {
  return {
    ...custom,
    submeshes: custom.submeshes.map((s) => ({ ...s, positions: Array.from(s.positions), uvs: Array.from(s.uvs), normals: Array.from(s.normals) })),
  };
}

/** Inverse of serializeCustomPrefab; validates shapes so a bad response cannot poison the renderer. */
export function deserializeCustomPrefab(json) {
  if (!json || typeof json.name !== 'string' || !Array.isArray(json.submeshes) || !Array.isArray(json.materials)) throw new Error('not a custom prefab');
  const f32 = (a, k) => {
    if (!Array.isArray(a) || a.length % k) throw new Error('bad custom prefab array');
    const out = new Float32Array(a);
    for (const x of out) if (!Number.isFinite(x)) throw new Error('non-finite value in custom prefab');
    return out;
  };
  return {
    ...json,
    submeshes: json.submeshes.map((s, slot) => {
      const positions = f32(s.positions, 9);
      const uvs = f32(s.uvs, 2), normals = f32(s.normals, 3);
      if (uvs.length / 2 !== positions.length / 3 || normals.length !== positions.length) throw new Error('custom prefab arrays disagree');
      return { slot, fbxMaterial: s.fbxMaterial | 0, positions, uvs, normals };
    }),
  };
}
