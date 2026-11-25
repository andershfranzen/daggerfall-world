// Minimal, lossless reader for binary FBX (Kaydara FBX Binary, versions 7100-7700), as used by
// the World of Daggerfall meshes. Browser and Node alike: DataView for reading, the standard
// DecompressionStream('deflate') for zlib-compressed arrays, no dependencies.
// It returns the node tree and the mesh geometry exactly as stored (float64 vertices, polygon
// index list, per-polygon-vertex UVs and normals, per-polygon material slots). Nothing is
// welded or resampled here; the Unity import rules live in models.js.

const MAGIC = 'Kaydara FBX Binary  \0';
const latin1 = (u8, a, b) => {
  let s = '';
  for (let i = a; i < b; i++) s += String.fromCharCode(u8[i]);
  return s;
};

/** zlib inflate with the platform's DecompressionStream. */
export async function inflateZlib(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Parse a binary FBX file into a node tree: {version, children:[{name, props, children}]}.
 * @param {Uint8Array} bytes
 * @param {{inflate?: (u8: Uint8Array) => Promise<Uint8Array>}} [opts]
 */
export async function parseFbx(bytes, opts = {}) {
  const inflate = opts.inflate ?? inflateZlib;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 27 || latin1(u8, 0, 21) !== MAGIC) throw new Error('not a binary FBX file');
  const version = dv.getUint32(23, true);
  if (version < 7100 || version > 7700) throw new Error(`unsupported FBX version ${version}`);
  const wide = version >= 7500;
  const head = wide ? 24 : 12;
  const nullLen = head + 1;
  const pending = []; // compressed arrays, inflated after the walk

  const u = (p) => (wide ? Number(dv.getBigUint64(p, true)) : dv.getUint32(p, true));

  function readProp(pos) {
    const t = String.fromCharCode(u8[pos++]);
    switch (t) {
      case 'Y': return [dv.getInt16(pos, true), pos + 2];
      case 'C': return [u8[pos] !== 0, pos + 1];
      case 'I': return [dv.getInt32(pos, true), pos + 4];
      case 'F': return [dv.getFloat32(pos, true), pos + 4];
      case 'D': return [dv.getFloat64(pos, true), pos + 8];
      case 'L': return [dv.getBigInt64(pos, true), pos + 8];
      case 'S':
      case 'R': {
        const len = dv.getUint32(pos, true);
        if (pos + 4 + len > u8.length) throw new Error('FBX string overruns file');
        const data = u8.subarray(pos + 4, pos + 4 + len);
        return [t === 'S' ? new TextDecoder().decode(data) : data.slice(), pos + 4 + len];
      }
      case 'f': case 'd': case 'l': case 'i': case 'b': {
        const n = dv.getUint32(pos, true);
        const enc = dv.getUint32(pos + 4, true);
        const clen = dv.getUint32(pos + 8, true);
        if (pos + 12 + clen > u8.length) throw new Error('FBX array overruns file');
        const raw = u8.subarray(pos + 12, pos + 12 + clen);
        if (enc !== 0 && enc !== 1) throw new Error(`unknown FBX array encoding ${enc}`);
        const slot = { t, n, raw, enc, value: null };
        pending.push(slot);
        return [slot, pos + 12 + clen];
      }
      default:
        throw new Error(`unknown FBX property type '${t}' at ${pos - 1}`);
    }
  }

  function readNode(pos) {
    const end = u(pos);
    const numProps = u(pos + (wide ? 8 : 4));
    const propLen = u(pos + (wide ? 16 : 8));
    let p = pos + head;
    const nameLen = u8[p++];
    if (end === 0) return [null, pos + nullLen];
    if (end > u8.length || end <= pos) throw new Error('FBX node overruns file');
    const name = latin1(u8, p, p + nameLen);
    p += nameLen;
    const propsEnd = p + propLen;
    const props = [];
    for (let i = 0; i < numProps; i++) {
      const [v, np] = readProp(p);
      props.push(v);
      p = np;
    }
    if (p !== propsEnd) throw new Error(`FBX node ${name}: property list length mismatch`);
    const children = [];
    while (p < end) {
      if (end - p === nullLen && u8.subarray(p, end).every((b) => b === 0)) {
        p = end;
        break;
      }
      const [c, np] = readNode(p);
      if (!c) {
        p = np;
        break;
      }
      children.push(c);
      p = np;
    }
    return [{ name, props, children }, end];
  }

  const children = [];
  let pos = 27;
  while (pos + nullLen <= u8.length && u(pos) !== 0) {
    const [node, np] = readNode(pos);
    children.push(node);
    pos = np;
  }

  const SIZE = { f: 4, d: 8, l: 8, i: 4, b: 1 };
  for (const s of pending) {
    const data = s.enc === 1 ? await inflate(s.raw) : s.raw;
    const bytesNeeded = s.n * SIZE[s.t];
    if (data.length < bytesNeeded) throw new Error('FBX array shorter than its length');
    const copy = new Uint8Array(bytesNeeded);
    copy.set(data.subarray(0, bytesNeeded));
    const ab = copy.buffer;
    s.value = s.t === 'f' ? new Float32Array(ab) : s.t === 'd' ? new Float64Array(ab) : s.t === 'l' ? new BigInt64Array(ab) : s.t === 'i' ? new Int32Array(ab) : copy;
  }
  const settle = (node) => {
    node.props = node.props.map((p) => (p && typeof p === 'object' && 'raw' in p && 'enc' in p ? p.value : p));
    node.children.forEach(settle);
  };
  children.forEach(settle);
  return { version, children };
}

export const child = (node, name) => node?.children.find((c) => c.name === name) ?? null;
export const childrenNamed = (node, name) => node?.children.filter((c) => c.name === name) ?? [];

/** Properties70 -> Map(name -> values after the type/flags columns) */
export function properties70(node) {
  const out = new Map();
  for (const p of childrenNamed(child(node, 'Properties70'), 'P')) out.set(p.props[0], p.props.slice(4));
  return out;
}

function layerElement(geom, name, dataName, indexName) {
  const el = child(geom, name);
  if (!el) return null;
  return {
    mapping: child(el, 'MappingInformationType')?.props[0] ?? 'ByPolygonVertex',
    reference: child(el, 'ReferenceInformationType')?.props[0] ?? 'Direct',
    data: child(el, dataName)?.props[0] ?? null,
    index: indexName ? (child(el, indexName)?.props[0] ?? null) : null,
  };
}

/**
 * Mesh geometries of an FBX tree, with their Model node transforms and global settings.
 */
export function fbxGeometries(tree) {
  const settings = properties70(child(tree, 'GlobalSettings'));
  const objects = child(tree, 'Objects');
  const conns = childrenNamed(child(tree, 'Connections'), 'C');
  const models = new Map();
  for (const m of childrenNamed(objects, 'Model')) {
    const p = properties70(m);
    const v3 = (k, d) => (p.has(k) ? p.get(k).slice(0, 3).map(Number) : d);
    models.set(m.props[0], {
      name: String(m.props[1]).split('\u0000')[0],
      translation: v3('Lcl Translation', [0, 0, 0]),
      rotation: v3('Lcl Rotation', [0, 0, 0]),
      scaling: v3('Lcl Scaling', [1, 1, 1]),
      geometricTranslation: v3('GeometricTranslation', [0, 0, 0]),
      geometricRotation: v3('GeometricRotation', [0, 0, 0]),
      geometricScaling: v3('GeometricScaling', [1, 1, 1]),
    });
  }
  const parentOf = new Map();
  for (const c of conns) if (c.props[0] === 'OO') parentOf.set(c.props[1], c.props[2]);
  const geometries = [];
  for (const g of childrenNamed(objects, 'Geometry')) {
    if (g.props[2] !== 'Mesh') continue;
    geometries.push({
      id: g.props[0],
      name: String(g.props[1]).split('\u0000')[0],
      vertices: child(g, 'Vertices')?.props[0] ?? new Float64Array(0),
      polygonVertexIndex: child(g, 'PolygonVertexIndex')?.props[0] ?? new Int32Array(0),
      uv: layerElement(g, 'LayerElementUV', 'UV', 'UVIndex'),
      normal: layerElement(g, 'LayerElementNormal', 'Normals', 'NormalsIndex'),
      material: layerElement(g, 'LayerElementMaterial', 'Materials', null),
      model: models.get(parentOf.get(g.props[0])) ?? null,
    });
  }
  const num = (k, d) => Number(settings.get(k)?.[0] ?? d);
  return {
    unitScale: num('UnitScaleFactor', 1),
    upAxis: num('UpAxis', 1),
    upSign: num('UpAxisSign', 1),
    frontAxis: num('FrontAxis', 2),
    frontSign: num('FrontAxisSign', 1),
    coordAxis: num('CoordAxis', 0),
    coordSign: num('CoordAxisSign', 1),
    geometries,
  };
}
