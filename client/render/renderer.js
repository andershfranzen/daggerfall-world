// First-person WebGL renderer: sky gradient, the town mesh (vertex colours, optional atlas
// texture), simple directional shading derived from face normals, distance fog, and avatars
// drawn from a shared unit cube with per-part transforms.
//
// Extension points for gameplay modules (see client/gameplay/actors/README.md):
//   addPass(fn)            fn(gl, renderer, camera) runs after the town and avatars every
//                          frame, with the depth buffer intact, so billboards are occluded
//                          by buildings. Returns a function that removes the pass.
//   contextVersion         increments whenever GL resources were (re)created.
//   hasActorSprite(id)     true when a real sprite is drawn for that peer/entity id, so the
//                          shell can skip its placeholder cube avatar for it.
//   setActorSprites(ids)   replaces that set (called by the actors pass).
//   spritesActive          true while at least one actor sprite is drawn.
//   setLayers([{mesh, offset:[x,y,z]}])  extra exterior meshes drawn with the scene
//                          (client/world/exterior/stream.js), each translated into the
//                          current scene's frame. setTown keeps them; pass [] to clear.
//   setPrimaryOffset([x,y,z])  draws the current scene translated (a crossing whose
//                          destination is still loading). setTown resets it.
//   retain(mesh) / release(mesh)  keep a mesh's GPU upload while it is not drawn, so a
//                          prefetched scene swaps in without an upload; `gpuStats()`.
//   reskin(mesh)           re-upload only the UVs and atlas of an uploaded mesh whose textures
//                          changed in place (seasonal look, client/world/exterior/season.js).
//   addTranslucentPass(fn)  like addPass, but runs after every addPass pass, so translucent
//                          surfaces (dungeon water) blend over billboards already drawn behind them.
//   primaryVertexLimit     when set, only that many leading vertices of the current scene are drawn
//                          (sailing: a "Your Ship" deck without its sea-level ground tiles). setTown resets it.
//   skyFrame               optional rotation (mat4) from the sky's frame into the scene's frame: a heeling
//                          deck tilts the horizon. `skyInvViewProj` is the inverse view-projection sky passes use.

import { DISTANCE_FOG, OUTDOOR_FAR, PIXEL_COVERAGE, fogDistances } from './visibility.js';
import * as M from '../lib/mat.js';

const WORLD_VS = `
attribute vec3 a_pos;
attribute vec3 a_col;
attribute vec3 a_nrm;
attribute vec2 a_uv;
uniform mat4 u_vp;
uniform mat4 u_model;
varying vec3 v_col;
varying vec3 v_nrm;
varying vec2 v_uv;
varying vec3 v_wpos;
void main() {
  vec4 w = u_model * vec4(a_pos, 1.0);
  v_wpos = w.xyz;
  v_nrm = (u_model * vec4(a_nrm, 0.0)).xyz;
  v_col = a_col;
  v_uv = a_uv;
  gl_Position = u_vp * w;
}`;

const WORLD_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 v_col;
varying vec3 v_nrm;
varying vec2 v_uv;
varying vec3 v_wpos;
uniform vec3 u_tint;
uniform float u_useTex;
uniform sampler2D u_tex;
uniform vec3 u_eye;
uniform vec3 u_lightDir;
uniform float u_shade;
uniform float u_coverage;
uniform vec3 u_fogColor;
${DISTANCE_FOG}
${PIXEL_COVERAGE}
void main() {
  if (u_coverage < 1.0 && !pixelVisible(u_coverage)) discard;
  vec3 base = v_col * u_tint;
  if (u_useTex > 0.5) {
    vec4 t = texture2D(u_tex, v_uv);
    if (t.a < 0.5) discard;
    base *= t.rgb;
  }
  vec3 n = normalize(v_nrm);
  vec3 toEye = u_eye - v_wpos;
  if (dot(n, toEye) < 0.0) n = -n; // geometry is two-sided
  float ndl = max(dot(n, u_lightDir), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  float light = mix(1.0, 0.42 + 0.38 * ndl + 0.2 * sky, u_shade);
  vec3 c = base * light;
  float d = length(toEye);
  gl_FragColor = vec4(mix(c, u_fogColor, fogAmount(d)), 1.0);
}`;

const SKY_VS = `
attribute vec2 a_pos;
varying vec2 v_ndc;
void main() { v_ndc = a_pos; gl_Position = vec4(a_pos, 0.9999, 1.0); }`;

const SKY_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_ndc;
uniform mat4 u_invVp;
uniform vec3 u_zenith;
uniform vec3 u_horizon;
uniform vec3 u_ground;
uniform vec3 u_sunDir;
void main() {
  vec4 a = u_invVp * vec4(v_ndc, -1.0, 1.0);
  vec4 b = u_invVp * vec4(v_ndc, 1.0, 1.0);
  vec3 dir = normalize(b.xyz / b.w - a.xyz / a.w);
  float h = dir.y;
  vec3 c = h > 0.0 ? mix(u_horizon, u_zenith, pow(min(h * 1.6, 1.0), 0.7)) : mix(u_horizon, u_ground, min(-h * 6.0, 1.0));
  float sun = max(dot(dir, u_sunDir), 0.0);
  c += vec3(1.0, 0.78, 0.5) * (pow(sun, 24.0) * 0.35 + pow(sun, 600.0) * 0.8);
  gl_FragColor = vec4(c, 1.0);
}`;

export const PALETTE = {
  zenith: [0.20, 0.30, 0.48],
  horizon: [0.70, 0.66, 0.60],
  ground: [0.32, 0.30, 0.27],
};

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(s));
  return s;
}

export function createProgram(gl, vs, fs, attribs) {
  return program(gl, vs, fs, attribs);
}

function program(gl, vs, fs, attribs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  attribs.forEach((name, i) => gl.bindAttribLocation(p, i, name));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Shader link failed: ' + gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    u[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u };
}

/** Flat per-vertex normals for a non-indexed triangle list. */
export function faceNormals(pos) {
  const out = new Float32Array(pos.length);
  for (let o = 0; o + 8 < pos.length; o += 9) {
    const ux = pos[o + 3] - pos[o], uy = pos[o + 4] - pos[o + 1], uz = pos[o + 5] - pos[o + 2];
    const vx = pos[o + 6] - pos[o], vy = pos[o + 7] - pos[o + 1], vz = pos[o + 8] - pos[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < 9; k += 3) { out[o + k] = nx; out[o + k + 1] = ny; out[o + k + 2] = nz; }
  }
  return out;
}

/** Normalise the colour array to one RGB per vertex (accepts per-vertex or per-triangle). */
export function perVertexColors(colors, vertexCount) {
  if (colors && colors.length === vertexCount * 3) return colors instanceof Float32Array ? colors : new Float32Array(colors);
  const out = new Float32Array(vertexCount * 3);
  if (colors && colors.length === vertexCount) { // per triangle (vertexCount/3 tris * 3)
    for (let v = 0; v < vertexCount; v++) {
      const t = Math.floor(v / 3) * 3;
      out[v * 3] = colors[t]; out[v * 3 + 1] = colors[t + 1]; out[v * 3 + 2] = colors[t + 2];
    }
    return out;
  }
  out.fill(0.75);
  return out;
}

function cube() {
  // Unit cube centred on the origin, 36 vertices, with normals.
  const P = [], N = [];
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [0, 0, -1], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const c = (a, b) => [0, 1, 2].map((i) => n[i] * 0.5 + u[i] * a * 0.5 + v[i] * b * 0.5);
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]) {
      P.push(...c(a, b));
      N.push(...n);
    }
  }
  return { pos: new Float32Array(P), nrm: new Float32Array(N) };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.town = null;
    this.lost = false;
    this.onContextChange = null;
    this.proj = new Float32Array(16);
    this.view = new Float32Array(16);
    this.viewProj = new Float32Array(16);
    this.invViewProj = new Float32Array(16);
    this.tmp = new Float32Array(16);
    this.eye = [0, 1.6, 0];
    this.fov = 70 * Math.PI / 180;
    this.far = 600;
    this.fogScale = 1;
    this.fogOverride = null;
    this.fogRange = fogDistances(this.far, 1, false);
    this.width = 1; this.height = 1;
    this.camera = null;
    this.forward = [0, 0, -1];
    this.passes = [];
    this.translucentPasses = [];
    this.contextVersion = 0;
    this.actorSprites = new Set();
    this.gpu = new Map(); // mesh object -> uploaded buffers
    this.dungeonPoses = new WeakMap();
    this.layers = [];
    this.retained = new Set();
    this.primaryOffset = [0, 0, 0];
    this.primaryVertexLimit = null;
    this.skyFrame = null;
    this.skyInvViewProj = this.invViewProj;
    this.model = new Float32Array(16);
    const sun = [0.45, 0.75, 0.35];
    const l = Math.hypot(...sun);
    this.sunDir = sun.map((v) => v / l);

    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.lost = true;
      this.onContextChange?.('lost');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.init();
      // The lost context took every buffer with it; upload again on demand.
      const layers = this.layers.map(({ mesh, offset }) => ({ mesh, offset }));
      const offset = this.primaryOffset;
      if (this.town) this.setTown(this.town);
      this.primaryOffset = offset;
      this.setLayers(layers);
      this.onContextChange?.('restored');
    });
    this.init();
  }

  init() {
    const opts = { antialias: true, alpha: false, depth: true, powerPreference: 'high-performance' };
    const gl = this.canvas.getContext('webgl2', opts) || this.canvas.getContext('webgl', opts);
    if (!gl) throw new Error('WebGL is not available in this browser.');
    this.gl = gl;
    this.world = program(gl, WORLD_VS, WORLD_FS, ['a_pos', 'a_col', 'a_nrm', 'a_uv']);
    this.sky = program(gl, SKY_VS, SKY_FS, ['a_pos']);
    this.skyBuf = this.buffer(new Float32Array([-1, -1, 3, -1, -1, 3]));
    const c = cube();
    this.cube = { pos: this.buffer(c.pos), nrm: this.buffer(c.nrm), count: c.pos.length / 3 };
    this.white = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    this.mesh = null;
    this.gpu = new Map();
    this.contextVersion++;
  }

  /** Register a draw pass that runs after the world with depth testing intact. */
  addPass(fn) {
    this.passes.push(fn);
    return () => {
      const i = this.passes.indexOf(fn);
      if (i >= 0) this.passes.splice(i, 1);
    };
  }

  /** Register a draw pass that runs after every addPass pass (translucent surfaces). */
  addTranslucentPass(fn) {
    this.translucentPasses.push(fn);
    return () => {
      const i = this.translucentPasses.indexOf(fn);
      if (i >= 0) this.translucentPasses.splice(i, 1);
    };
  }

  /** True when a gameplay module draws a real sprite for this peer or entity id. */
  hasActorSprite(id) {
    return this.actorSprites.has(String(id));
  }

  setActorSprites(ids) {
    this.actorSprites = new Set(Array.from(ids ?? [], String));
  }

  get spritesActive() {
    return this.actorSprites.size > 0;
  }

  buffer(data) {
    const gl = this.gl;
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  }

  /** Supply the same buffers for a synchronous scene change and a prefetched exterior. */
  *uploadParts(town) {
    const gl = this.gl;
    const version = this.contextVersion;
    const pos = town.positions instanceof Float32Array ? town.positions : new Float32Array(town.positions ?? []);
    const count = Math.floor(pos.length / 9) * 3;
    if (!count) throw new Error('The town has no geometry.');
    const mesh = { count, pos: null, col: null, uniformColor: town.uniformColor, nrm: null, uv: null, tex: null, bytes: count * 24 };
    let complete = false;
    try {
      mesh.pos = this.buffer(pos);
      yield;
      if (!mesh.uniformColor) {
        mesh.col = this.buffer(perVertexColors(town.colors, count));
        mesh.bytes += count * 12;
        yield;
      }
      const normals = faceNormals(pos);
      yield;
      mesh.nrm = this.buffer(normals);
      yield;
      const atlas = town.atlas;
      if (atlas && town.uv?.length >= count * 2 && atlas.width > 0 && atlas.height > 0 && atlas.pixels) {
        const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        if (atlas.width <= maxSize && atlas.height <= maxSize) {
          mesh.uv = this.buffer(town.uv instanceof Float32Array ? town.uv : new Float32Array(town.uv));
          yield;
          mesh.tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, mesh.tex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          const px = atlas.pixels instanceof Uint8Array ? atlas.pixels : new Uint8Array(atlas.pixels.buffer, atlas.pixels.byteOffset, atlas.pixels.byteLength);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, atlas.width, atlas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          mesh.bytes += count * 8 + atlas.width * atlas.height * 4;
          yield;
        }
      }
      this.gpu.set(town, mesh);
      complete = true;
      const poses = this.dungeonPoses.get(town);
      if (poses) this.updateDungeonPoses(town, new Set(), poses);
    } finally {
      if (!complete && !this.lost && this.contextVersion === version) this.deleteBuffers(mesh);
    }
  }

  upload(town) {
    if (!this.gpu.has(town)) {
      for (const _ of this.uploadParts(town)) { /* Finish before the caller draws. */ }
    }
    return this.gpu.get(town);
  }

  /** Stream a new, unpublished mesh while the previous scene is still interactive. */
  async prepareExterior(town, signal) {
    if (this.lost || signal.aborted || this.gpu.has(town)) return;
    const version = this.contextVersion;
    let started = performance.now();
    for (const _ of this.uploadParts(town)) {
      if (performance.now() - started < 4) continue;
      await new Promise(resolve => setTimeout(resolve, 0));
      if (signal.aborted || this.lost || this.contextVersion !== version) return;
      started = performance.now();
    }
  }

  deleteBuffers(mesh) {
    const gl = this.gl;
    for (const buffer of [mesh.pos, mesh.col, mesh.nrm, mesh.uv]) if (buffer) gl.deleteBuffer(buffer);
    if (mesh.tex) gl.deleteTexture(mesh.tex);
  }

  setDungeonPoses(scene, poses) {
    const previous = this.dungeonPoses.get(scene) ?? new Set();
    this.dungeonPoses.set(scene, poses);
    if (!this.lost) this.updateDungeonPoses(scene, previous, poses);
  }

  updateDungeonPoses(scene, previous, poses) {
    const mesh = this.gpu.get(scene);
    if (!mesh) return;
    const gl = this.gl;
    for (const m of scene.mechanisms) {
      if (!m.alternate || previous.has(m.id) === poses.has(m.id)) continue;
      const offset = m.firstTriangle * 9;
      const positions = poses.has(m.id) ? m.alternate : scene.positions.subarray(offset, offset + m.triangleCount * 9);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.pos);
      gl.bufferSubData(gl.ARRAY_BUFFER, offset * 4, positions);
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.nrm);
      gl.bufferSubData(gl.ARRAY_BUFFER, offset * 4, faceNormals(positions));
      if (m.alternateUv && mesh.uv) {
        const uvOffset = m.firstTriangle * 6;
        const tex = poses.has(m.id) ? m.alternateUv : scene.uv.subarray(uvOffset, uvOffset + m.triangleCount * 6);
        gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uv);
        gl.bufferSubData(gl.ARRAY_BUFFER, uvOffset * 4, tex);
      }
    }
  }

  updateCityGates(scene, mesh) {
    if (!scene?.mechanisms?.some(m => m.alternateUv) || mesh.gatesClosed === !!this.cityGatesClosed) return;
    const open = new Set(), closed = new Set(scene.mechanisms.filter(m => m.alternateUv).map(m => m.id));
    this.updateDungeonPoses(scene, mesh.gatesClosed ? closed : open, this.cityGatesClosed ? closed : open);
    mesh.gatesClosed = !!this.cityGatesClosed;
  }

  /**
   * The mesh kept its geometry but has new `uv` / `atlas` (client/world/exterior/season.js reskinMesh).
   * Replaces only those GPU objects; positions, normals and colours stay uploaded. A mesh that is not
   * uploaded picks the new textures up on its next upload.
   */
  reskin(town, { uv = true, atlas = true } = {}) {
    const mesh = this.gpu.get(town);
    if (!mesh || this.lost) return false;
    const gl = this.gl;
    const a = town.atlas;
    const usable = a && town.uv?.length >= mesh.count * 2 && a.width > 0 && a.height > 0 && a.pixels
      && a.width <= gl.getParameter(gl.MAX_TEXTURE_SIZE) && a.height <= gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (!usable || !mesh.tex || !mesh.uv) {
      // Textured state changes: start this mesh's upload again (rare; never for a seasonal swap).
      this.deleteBuffers(mesh);
      this.gpu.delete(town);
      this.upload(town);
      return true;
    }
    if (uv) {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uv);
      gl.bufferData(gl.ARRAY_BUFFER, town.uv instanceof Float32Array ? town.uv : new Float32Array(town.uv), gl.STATIC_DRAW);
    }
    if (atlas) {
      gl.bindTexture(gl.TEXTURE_2D, mesh.tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      const px = a.pixels instanceof Uint8Array ? a.pixels : new Uint8Array(a.pixels.buffer, a.pixels.byteOffset, a.pixels.byteLength);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, a.width, a.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      mesh.bytes = mesh.count * (mesh.col ? 32 : 20) + a.width * a.height * 4;
    }
    // A closed gate draws its alternate UVs; keep that pose with the new atlas.
    if (town.mechanisms?.some((m) => m.alternateUv)) {
      const poses = this.dungeonPoses.get(town);
      if (poses) this.updateDungeonPoses(town, new Set(), poses);
      if (mesh.gatesClosed) {
        const closed = new Set(town.mechanisms.filter((m) => m.alternateUv).map((m) => m.id));
        this.updateDungeonPoses(town, new Set(), closed);
      }
    }
    return true;
  }

  /** Keep `mesh` uploaded while it is not drawn. */
  retain(mesh) {
    if (!mesh?.positions) return;
    this.retained.add(mesh);
    if (!this.lost) this.upload(mesh);
  }

  /** Drop a retained mesh; its buffers go unless it is still drawn. */
  release(mesh) {
    this.retained.delete(mesh);
    this.collect();
  }

  /** Delete the buffers of meshes that are neither drawn nor retained. */
  collect() {
    const keep = new Set([this.town, ...this.retained, ...this.layers.map((l) => l.mesh)]);
    for (const [mesh, g] of this.gpu) {
      if (keep.has(mesh)) continue;
      this.deleteBuffers(g);
      this.gpu.delete(mesh);
    }
  }

  gpuStats() {
    let bytes = 0;
    for (const g of this.gpu.values()) bytes += g.bytes;
    return { meshes: this.gpu.size, layers: this.layers.length, retained: this.retained.size, bytes };
  }

  /** Upload a town from world/town.js. Throws with a clear message on malformed data. */
  setTown(town) {
    const mesh = this.upload(town);
    this.town = town;
    this.primaryOffset = [0, 0, 0];
    this.primaryVertexLimit = null;
    this.collect();

    // Interiors use their own bounds. Outdoors the camera can see the surrounding terrain.
    this.outdoors = town.kind !== 'dungeon' && town.kind !== 'interior';
    this.far = OUTDOOR_FAR;
    if (!this.outdoors) {
      let bounds = town.bounds;
      if (!bounds) {
        const pos = town.positions;
        bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
        for (let i = 0; i < pos.length; i += 3) {
          bounds.minX = Math.min(bounds.minX, pos[i]);
          bounds.maxX = Math.max(bounds.maxX, pos[i]);
          bounds.minZ = Math.min(bounds.minZ, pos[i + 2]);
          bounds.maxZ = Math.max(bounds.maxZ, pos[i + 2]);
        }
      }
      const span = Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
      this.far = Math.min(Math.max(span * 0.9, 250), 3000);
    }
    this.mesh = mesh;
    return { vertices: mesh.count, textured: !!mesh.tex };
  }

  /** Extra exterior meshes, each translated into the current scene's frame. */
  setLayers(list) {
    const next = [];
    for (const l of list ?? []) {
      if (!l?.mesh?.positions || l.mesh === this.town) continue;
      const o = l.offset ?? [0, 0, 0];
      next.push({ mesh: l.mesh, offset: [o[0] ?? o.x ?? 0, o[1] ?? o.y ?? 0, o[2] ?? o.z ?? 0] });
    }
    this.layers = next;
    if (!this.lost) for (const l of next) this.upload(l.mesh);
    this.collect();
  }

  setPrimaryOffset(o) {
    this.primaryOffset = o ? [o[0] ?? o.x ?? 0, o[1] ?? o.y ?? 0, o[2] ?? o.z ?? 0] : [0, 0, 0];
  }

  drawMesh(m, offset, model = null, limit = null) {
    const gl = this.gl, w = this.world;
    const T = model ?? M.translate(this.model, M.identity(this.model), ...offset);
    gl.uniformMatrix4fv(w.u.u_model, false, T);
    this.bindAttr(0, m.pos, 3);
    if (m.col) this.bindAttr(1, m.col, 3);
    else {
      gl.disableVertexAttribArray(1);
      gl.vertexAttrib3fv(1, m.uniformColor);
    }
    this.bindAttr(2, m.nrm, 3);
    if (m.uv && m.tex) {
      this.bindAttr(3, m.uv, 2);
      gl.bindTexture(gl.TEXTURE_2D, m.tex);
      gl.uniform1f(w.u.u_useTex, 1);
    } else {
      gl.disableVertexAttribArray(3);
      gl.vertexAttrib2f(3, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, this.white);
      gl.uniform1f(w.u.u_useTex, 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, Number.isFinite(limit) ? Math.max(0, Math.min(limit, m.count)) : m.count);
  }

  /** Draw instances of a world mesh from a gameplay pass using the scene's depth and fog. */
  drawModels(mesh, transforms) {
    const m = this.upload(mesh);
    const gl = this.gl, w = this.world;
    gl.useProgram(w.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform3f(w.u.u_tint, 1, 1, 1);
    gl.uniform1f(w.u.u_shade, 0.55);
    gl.uniform1f(w.u.u_coverage, 1);
    for (const transform of transforms) this.drawMesh(m, null, transform);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
  }

  /** camera: {x, y, z, yaw, pitch}; avatars: [{ parts: [{ model, color }] }] */
  render(camera, avatars = []) {
    if (this.lost) return;
    const gl = this.gl;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);

    const cp = Math.cos(camera.pitch);
    const eye = [camera.x, camera.y, camera.z];
    const fwd = [Math.sin(camera.yaw) * cp, Math.sin(camera.pitch), -Math.cos(camera.yaw) * cp];
    this.eye = eye;
    this.camera = camera;
    this.forward = fwd;
    // fogOverride: [start, end] metres set by the atmosphere feature (dungeon light radius, underwater).
    this.fogRange = this.fogOverride ? [Math.min(this.fogOverride[0], this.far * 0.98), Math.min(this.fogOverride[1], this.far * 0.98)] : fogDistances(this.far, this.fogScale, this.outdoors);
    M.perspective(this.proj, this.fov, this.canvas.width / this.canvas.height, 0.1, this.far);
    M.lookAt(this.view, eye, [eye[0] + fwd[0], eye[1] + fwd[1], eye[2] + fwd[2]], [0, 1, 0]);
    M.multiply(this.viewProj, this.proj, this.view);
    M.invert(this.invViewProj, this.viewProj);
    if (this.skyFrame) {
      this.skyInvViewProj = this.skyInvViewProj === this.invViewProj ? new Float32Array(16) : this.skyInvViewProj;
      M.invert(this.skyInvViewProj, M.multiply(this.tmp, this.viewProj, this.skyFrame));
    } else this.skyInvViewProj = this.invViewProj;

    gl.clearColor(...PALETTE.horizon, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);

    // Sky
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.sky.p);
    gl.uniformMatrix4fv(this.sky.u.u_invVp, false, this.skyInvViewProj);
    gl.uniform3fv(this.sky.u.u_zenith, PALETTE.zenith);
    gl.uniform3fv(this.sky.u.u_horizon, PALETTE.horizon);
    gl.uniform3fv(this.sky.u.u_ground, PALETTE.ground);
    gl.uniform3fv(this.sky.u.u_sunDir, this.sunDir);
    this.bindAttr(0, this.skyBuf, 2);
    for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // World
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    const w = this.world;
    gl.useProgram(w.p);
    gl.uniformMatrix4fv(w.u.u_vp, false, this.viewProj);
    gl.uniform3fv(w.u.u_eye, eye);
    gl.uniform3fv(w.u.u_lightDir, this.sunDir);
    gl.uniform3fv(w.u.u_fogColor, PALETTE.horizon);
    gl.uniform2fv(w.u.u_fog, this.fogRange);
    gl.uniform1i(w.u.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);

    gl.uniform3f(w.u.u_tint, 1, 1, 1);
    gl.uniform1f(w.u.u_shade, 0.55);
    gl.uniform1f(w.u.u_coverage, 1);
    if (this.mesh) {
      this.updateCityGates(this.town, this.mesh);
      this.drawMesh(this.mesh, this.primaryOffset, null, this.primaryVertexLimit);
    }
    for (const l of this.layers) {
      const g = this.gpu.get(l.mesh);
      if (g) {
        this.updateCityGates(l.mesh, g);
        this.drawMesh(g, l.offset);
      }
    }

    // Avatars
    if (avatars.length) {
      gl.bindTexture(gl.TEXTURE_2D, this.white);
      gl.uniform1f(w.u.u_useTex, 0);
      gl.uniform1f(w.u.u_shade, 0.85);
      this.bindAttr(0, this.cube.pos, 3);
      gl.disableVertexAttribArray(1);
      gl.vertexAttrib3f(1, 1, 1, 1);
      this.bindAttr(2, this.cube.nrm, 3);
      gl.disableVertexAttribArray(3);
      gl.vertexAttrib2f(3, 0, 0);
      for (const a of avatars) {
        gl.uniform1f(w.u.u_coverage, a.coverage ?? 1);
        for (const part of a.parts) {
          gl.uniformMatrix4fv(w.u.u_model, false, part.model);
          gl.uniform3fv(w.u.u_tint, part.color);
          gl.drawArrays(gl.TRIANGLES, 0, this.cube.count);
        }
      }
    }

    // Gameplay passes (actor billboards): depth test and depth writes stay on.
    for (const list of [this.passes, this.translucentPasses]) {
      for (const pass of list) {
        try {
          pass(gl, this, camera);
        } catch (err) {
          console.error('Render pass failed', err);
        }
      }
    }
  }

  bindAttr(loc, buf, size) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  /** World point to CSS pixel coordinates (after the last render). */
  project(x, y, z) {
    return M.projectToScreen(this.viewProj, x, y, z, this.width, this.height);
  }
}
