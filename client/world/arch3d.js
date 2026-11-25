// ARCH3D.BSA mesh decoder.
//
// Adapted from daggerfall-js-source src/formats/arch3dFile.js and faceUVTool.js
// (MIT, (c) 2026 Lattymoy), translations of Daggerfall Unity's
// API/Arch3dFile.cs and API/FaceUVTool.cs (MIT, (c) 2009-2023 Daggerfall
// Workshop; FaceUVTool after Dave Humphrey's DF_3DSTex.CPP). See
// client/world/THIRD_PARTY_NOTICES.txt.
//
// Output per model: { id, planes: [{ archive, record, normal:{x,y,z}, points: [{x,y,z,u,v}] }], failedPlanes }
//   x,y,z  native model units / 256 (Daggerfall's y axis points DOWN)
//   u,v    texel units (native / 16), origin at the texture's top-left
// Each plane is a convex polygon to be triangulated as a fan from point 0,
// matching DFU's MeshReader.LoadIndices. The DFU fixed-size buffers (32
// textures, 512 planes, 16 points) are not imposed.

import { ARCH3D_PATCH } from './arch3dPatch.js';
import { WorldDataError } from './errors.js';

const POINT_DIVISOR = 256;
const TEXTURE_DIVISOR = 16;

/** Unpack special texture coordinates (Arch3dFile.cs UVunpack). */
function uvUnpack(u) {
  if (u > -14336 && u < 14336 && u !== -7168) return u;
  let nextMult = u - 1;
  nextMult >>= 13;
  ++nextMult;
  nextMult <<= 13;
  const prevMult = nextMult - 8192;
  const mult = u - prevMult < nextMult - u ? prevMult : nextMult;
  return u - mult;
}

/** Apply ARCH3D_PATCH bytes that fall within a record starting at `position`. */
export function patchRecord(bytes, position) {
  const end = position + bytes.length;
  for (const [offset, data] of ARCH3D_PATCH) {
    for (let i = 0; i < data.length; i++) {
      const at = offset + i;
      if (at >= position && at < end) bytes[at - position] = data[i];
    }
  }
}

const dot = (ax, ay, az, bx, by, bz) => ax * bx + ay * by + az * bz;

/** FaceUVTool.ComputeFaceUVCoordinates: absolute UVs for every point of an N-gon. Returns null on failure. */
function computeFaceUVs(pts) {
  const [a, b, c] = pts;
  const V0 = [b.x - a.x, b.y - a.y, b.z - a.z];
  let V1 = [c.x - a.x, c.y - a.y, c.z - a.z];
  const k = dot(...V1, ...V0) / dot(...V0, ...V0);
  V1 = [V1[0] - V0[0] * k, V1[1] - V0[1] * k, V1[2] - V0[2] * k];
  const m0 = Math.sqrt(dot(...V0, ...V0));
  const m1 = Math.sqrt(dot(...V1, ...V1));
  if (!(m0 > 0) || !(m1 > 0)) throw new Error('degenerate face');
  const i0 = 1 / m0;
  const i1 = 1 / m1;
  const n0 = [V0[0] * i0, V0[1] * i0, V0[2] * i0];
  const n1 = [V1[0] * i1, V1[1] * i1, V1[2] * i1];
  const px = (p) => Math.trunc(dot(p.x, p.y, p.z, ...n0));
  const py = (p) => Math.trunc(dot(p.x, p.y, p.z, ...n1));
  const X = [px(a), px(b), px(c)];
  const Y = [py(a), py(b), py(c)];
  const U = [a.u, b.u + a.u, c.u + b.u + a.u];
  const V = [a.v, b.v + a.v, c.v + b.v + a.v];

  const det = X[0] * Y[1] + Y[0] * X[2] + X[1] * Y[2] - Y[1] * X[2] - Y[0] * X[1] - X[0] * Y[2];
  if (det === 0) return null;
  const Xi = [(Y[1] - Y[2]) / det, (-X[1] + X[2]) / det, (X[1] * Y[2] - X[2] * Y[1]) / det];
  const Yi = [(-Y[0] + Y[2]) / det, (X[0] - X[2]) / det, (-X[0] * Y[2] + X[2] * Y[0]) / det];
  const Zi = [(Y[0] - Y[1]) / det, (-X[0] + X[1]) / det, (X[0] * Y[1] - X[1] * Y[0]) / det];
  const UA = U[0] * Xi[0] + U[1] * Yi[0] + U[2] * Zi[0];
  const UB = U[0] * Xi[1] + U[1] * Yi[1] + U[2] * Zi[1];
  const UD = U[0] * Xi[2] + U[1] * Yi[2] + U[2] * Zi[2];
  const VA = V[0] * Xi[0] + V[1] * Yi[0] + V[2] * Zi[0];
  const VB = V[0] * Xi[1] + V[1] * Yi[1] + V[2] * Zi[1];
  const VD = V[0] * Xi[2] + V[1] * Yi[2] + V[2] * Zi[2];

  return pts.map((p, i) => {
    if (i === 0) return { u: U[0], v: V[0] };
    if (i === 1) return { u: U[1], v: V[1] };
    if (i === 2) return { u: U[2], v: V[2] };
    const x = px(p);
    const y = py(p);
    return { u: Math.trunc(x * UA + y * UB + UD), v: Math.trunc(x * VA + y * VB + VD) };
  });
}

/** Arch3dFile.GetCornerPoints: indices of points where the outline turns. */
function cornerPoints(pts) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    let a, b, c, idx;
    if (i < n - 2) [a, b, c, idx] = [pts[i], pts[i + 1], pts[i + 2], i + 1];
    else if (i < n - 1) [a, b, c, idx] = [pts[i], pts[i + 1], pts[0], i + 1];
    else [a, b, c, idx] = [pts[i], pts[0], pts[1], 0];
    const l0 = [b.x - a.x, b.y - a.y, b.z - a.z];
    const l1 = [c.x - a.x, c.y - a.y, c.z - a.z];
    const m0 = Math.sqrt(dot(...l0, ...l0));
    const m1 = Math.sqrt(dot(...l1, ...l1));
    if (!(m0 > 0) || !(m1 > 0)) throw new Error('zero-length edge');
    const cos = Math.max(-1, Math.min(1, dot(...l0, ...l1) / (m0 * m1)));
    if (Math.acos(cos) > 0.001) out.push(idx);
  }
  return out;
}

/**
 * Decode one ARCH3D record.
 * @param {Uint8Array} bytes - record bytes (patched)
 * @param {number} id - record id (model id)
 */
export function decodeMesh(bytes, id) {
  if (bytes.length < 64) throw new WorldDataError(`ARCH3D.BSA: model ${id} record is too short`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (version !== 'v2.5' && version !== 'v2.6' && version !== 'v2.7') {
    throw new WorldDataError(`ARCH3D.BSA: model ${id} has unknown mesh version "${version.replace(/[^\x20-\x7e]/g, '?')}"`);
  }
  const planeCount = v.getInt32(8, true);
  const pointListOffset = v.getInt32(48, true);
  const planeListOffset = v.getInt32(60, true);
  const normalListOffset = v.getInt32(52, true);
  const pointScale = version === 'v2.5' ? 3 : 1;
  if (planeCount < 0 || planeCount > 10000) throw new WorldDataError(`ARCH3D.BSA: model ${id} has invalid plane count ${planeCount}`);

  const planes = [];
  let pos = planeListOffset;
  let failed = 0;
  for (let p = 0; p < planeCount; p++) {
    if (pos + 8 > bytes.length) throw new WorldDataError(`ARCH3D.BSA: model ${id} plane list overruns record`);
    const count = bytes[pos];
    const texture = v.getUint16(pos + 2, true);
    pos += 8;
    const np = normalListOffset + p * 12;
    if (np + 12 > bytes.length) throw new WorldDataError(`ARCH3D.BSA: model ${id} normal list overruns record`);
    const normal = { x: v.getInt32(np, true) / POINT_DIVISOR, y: v.getInt32(np + 4, true) / POINT_DIVISOR, z: v.getInt32(np + 8, true) / POINT_DIVISOR };
    const pts = new Array(count);
    for (let i = 0; i < count; i++) {
      const off = v.getInt32(pos, true);
      let u = v.getInt16(pos + 4, true);
      let uv = v.getInt16(pos + 6, true);
      pos += 8;
      if (i < 3 && id < 905) {
        u = uvUnpack(u);
        uv = uvUnpack(uv);
      }
      const pp = pointListOffset + off * pointScale;
      if (pp < 0 || pp + 12 > bytes.length) throw new WorldDataError(`ARCH3D.BSA: model ${id} point offset out of range`);
      pts[i] = { x: v.getInt32(pp, true), y: v.getInt32(pp + 4, true), z: v.getInt32(pp + 8, true), u, v: uv };
    }
    if (count < 3) continue;

    let outPts;
    try {
      if (count === 3) {
        const a = pts[0];
        const b = { ...pts[1], u: pts[1].u + pts[0].u, v: pts[1].v + pts[0].v };
        const c = { ...pts[2], u: pts[2].u + b.u, v: pts[2].v + b.v };
        outPts = [a, b, c];
      } else {
        const corners = cornerPoints(pts);
        const uvs = computeFaceUVs(pts);
        const src = uvs ? pts.map((q, i) => ({ ...q, u: uvs[i].u, v: uvs[i].v })) : pts;
        outPts = corners.map((i) => src[i]);
        if (outPts.length < 3) continue;
      }
    } catch {
      // DFU fails the whole record here; we drop only the malformed plane and count it.
      failed++;
      continue;
    }
    planes.push({
      archive: texture >> 7,
      record: texture & 0x7f,
      normal,
      points: outPts.map((q) => ({
        x: q.x / POINT_DIVISOR,
        y: q.y / POINT_DIVISOR,
        z: q.z / POINT_DIVISOR,
        u: q.u / TEXTURE_DIVISOR,
        v: q.v / TEXTURE_DIVISOR,
      })),
    });
  }
  // Header radius (Arch3dFile.cs: DFMesh.Radius = Header.Radius / 256); prices houses (DaggerfallBankManager.GetHousePrice).
  return { id, planes, failedPlanes: failed, radius: v.getUint32(12, true) / POINT_DIVISOR };
}
