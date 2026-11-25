// Two CPU-built batches the sailing renderer fills each frame, in the deck frame:
//   SolidBatch - lit, opaque, vertex-coloured triangles drawn with the renderer's own world program (scene fog,
//                light and depth): sails, flags, spars, harbour works, shot, floating wreckage, shores.
//   FxBatch    - camera-facing or flat quads with a procedural shape (soft puff, hard disc, ring, smoke, flame),
//                premultiplied-alpha layers sorted back to front, then additive light (flashes, fire, embers).
//                Depth-tested against the scene, never written.
// No textures are made from or shipped with game data; every shape is computed in the fragment shader.

import { createProgram } from '../../render/renderer.js';
import { DISTANCE_FOG } from '../../render/visibility.js';
import * as M from '../../lib/mat.js';

export const SHAPE = Object.freeze({ soft: 0, disc: 1, ring: 2, smoke: 3, flame: 4, streak: 5 });
const FX_STRIDE = 10; // pos 3, uv 2, rgba 4, shape 1

const FX_VS = `
attribute vec3 a_pos;
attribute vec2 a_uv;
attribute vec4 a_col;
attribute float a_shape;
uniform mat4 u_vp;
varying vec2 v_uv;
varying vec4 v_col;
varying float v_shape;
varying vec3 v_wpos;
void main() {
  v_uv = a_uv; v_col = a_col; v_shape = a_shape; v_wpos = a_pos;
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;

const FX_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
varying vec4 v_col;
varying float v_shape;
varying vec3 v_wpos;
uniform vec3 u_eye;
uniform vec3 u_fogColor;
uniform float u_add;
uniform float u_light;
${DISTANCE_FOG}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  vec2 q = v_uv * 2.0 - 1.0;
  float r = length(q);
  float a;
  if (v_shape < 0.5) a = pow(clamp(1.0 - r, 0.0, 1.0), 1.6);
  else if (v_shape < 1.5) a = 1.0 - smoothstep(0.82, 1.0, r);
  else if (v_shape < 2.5) a = exp(-pow((r - 0.78) / 0.14, 2.0)) * (0.6 + 0.4 * vnoise(q * 9.0 + v_col.a * 7.0));
  else if (v_shape < 3.5) a = clamp(1.0 - r, 0.0, 1.0) * (0.45 + 0.75 * vnoise(q * 3.0 + v_wpos.xz * 0.15));
  else if (v_shape < 4.5) {
    float tongue = 1.0 - smoothstep(0.0, 1.0, length(vec2(q.x * (1.6 + q.y), (q.y + 1.0) * 0.55)));
    a = clamp(tongue * (0.6 + 0.6 * vnoise(vec2(q.x * 4.0, q.y * 3.0 - v_col.a * 10.0))), 0.0, 1.0);
  } else a = (1.0 - abs(q.y)) * (1.0 - smoothstep(0.6, 1.0, abs(q.x)));
  if (a < 0.003) discard;
  float d = length(u_eye - v_wpos);
  float fog = fogAmount(d);
  if (u_add > 0.5) {
    gl_FragColor = vec4(v_col.rgb * a * (1.0 - fog), 1.0);
  } else {
    float alpha = a * clamp(v_col.a, 0.0, 1.0);
    vec3 c = mix(v_col.rgb * u_light, u_fogColor, fog);
    gl_FragColor = vec4(c * alpha, alpha);
  }
}`;

/** Lit opaque triangles in the deck frame (vertex colours), drawn with the renderer's world program. */
export class SolidBatch {
  constructor(cap = 60000) {
    this.pos = new Float32Array(cap * 9); this.col = new Float32Array(cap * 9); this.nrm = new Float32Array(cap * 9);
    this.n = 0; this.cap = cap; this.buf = null; this.version = -1;
  }
  clear() { this.n = 0; }
  tri(a, b, c, col) {
    if (this.n >= this.cap) return;
    const o = this.n * 9;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const P = this.pos, C = this.col, N = this.nrm;
    P[o] = a[0]; P[o + 1] = a[1]; P[o + 2] = a[2]; P[o + 3] = b[0]; P[o + 4] = b[1]; P[o + 5] = b[2]; P[o + 6] = c[0]; P[o + 7] = c[1]; P[o + 8] = c[2];
    for (let k = 0; k < 9; k += 3) { C[o + k] = col[0]; C[o + k + 1] = col[1]; C[o + k + 2] = col[2]; N[o + k] = nx; N[o + k + 1] = ny; N[o + k + 2] = nz; }
    this.n++;
  }
  quad(a, b, c, d, col) { this.tri(a, b, c, col); this.tri(a, c, d, col); }
  /** An oriented box: centre, three half-axis vectors (deck frame). */
  box(c, ax, ay, az, col) {
    const v = (sx, sy, sz) => [c[0] + ax[0] * sx + ay[0] * sy + az[0] * sz, c[1] + ax[1] * sx + ay[1] * sy + az[1] * sz, c[2] + ax[2] * sx + ay[2] * sy + az[2] * sz];
    const p = [v(-1, -1, -1), v(1, -1, -1), v(1, 1, -1), v(-1, 1, -1), v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1)];
    const f = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]];
    for (const [a, b, cc, d] of f) this.quad(p[a], p[b], p[cc], p[d], col);
  }
  draw(gl, renderer) {
    if (!this.n) return;
    if (!this.buf || this.version !== renderer.contextVersion) {
      this.buf = { pos: gl.createBuffer(), col: gl.createBuffer(), nrm: gl.createBuffer() };
      this.version = renderer.contextVersion;
    }
    const count = this.n * 3, w = renderer.world;
    gl.useProgram(w.p);
    gl.uniformMatrix4fv(w.u.u_vp, false, renderer.viewProj);
    gl.uniformMatrix4fv(w.u.u_model, false, M.identity(renderer.model));
    gl.uniform3f(w.u.u_tint, 1, 1, 1);
    gl.uniform1f(w.u.u_shade, 0.8);
    gl.uniform1f(w.u.u_coverage, 1);
    gl.uniform1f(w.u.u_useTex, 0);
    gl.uniform2fv(w.u.u_fog, renderer.fogRange);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, renderer.white);
    for (const [k, loc] of [['pos', 0], ['col', 1], ['nrm', 2]]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf[k]);
      gl.bufferData(gl.ARRAY_BUFFER, this[k].subarray(0, count * 3), gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    }
    gl.disableVertexAttribArray(3);
    gl.vertexAttrib2f(3, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, count);
  }
}

/** Blended effect quads. `axes` = {right, up} of the camera in the deck frame. */
export class FxBatch {
  constructor(cap = 4000) {
    this.cap = cap;
    this.alpha = []; this.add = [];
    this.data = new Float32Array(cap * 6 * FX_STRIDE);
    this.res = null; this.version = -1;
  }
  clear() { this.alpha.length = 0; this.add.length = 0; }
  /** Camera-facing quad. p: centre (deck), size: half extents [w, h], rot: radians in the view plane. */
  billboard(p, size, color, shape = SHAPE.soft, { add = false, rot = 0, axes, stretch = null } = {}) {
    const list = add ? this.add : this.alpha;
    if (this.alpha.length + this.add.length >= this.cap) return;
    let rx = axes.right, uy = axes.up;
    if (rot) {
      const c = Math.cos(rot), s = Math.sin(rot);
      rx = [axes.right[0] * c + axes.up[0] * s, axes.right[1] * c + axes.up[1] * s, axes.right[2] * c + axes.up[2] * s];
      uy = [axes.up[0] * c - axes.right[0] * s, axes.up[1] * c - axes.right[1] * s, axes.up[2] * c - axes.right[2] * s];
    }
    if (stretch) uy = stretch; // a streak along a direction (half-length vector)
    else uy = [uy[0] * size[1], uy[1] * size[1], uy[2] * size[1]];
    list.push({ p, a: [rx[0] * size[0], rx[1] * size[0], rx[2] * size[0]], b: uy, color, shape });
  }
  /** Quad on a plane given by two half-axis vectors (foam laid on the sea, a ring, a streak). */
  flat(p, ax, bx, color, shape = SHAPE.soft, { add = false } = {}) {
    if (this.alpha.length + this.add.length >= this.cap) return;
    (add ? this.add : this.alpha).push({ p, a: ax, b: bx, color, shape });
  }
  ensure(gl, version) {
    if (this.res && this.version === version) return this.res;
    const prog = createProgram(gl, FX_VS, FX_FS, ['a_pos', 'a_uv', 'a_col', 'a_shape']);
    this.res = { prog, vbo: gl.createBuffer() };
    this.version = version;
    return this.res;
  }
  write(list) {
    const D = this.data;
    let o = 0;
    const corner = (q, sx, sy, u, v) => {
      D[o++] = q.p[0] + q.a[0] * sx + q.b[0] * sy; D[o++] = q.p[1] + q.a[1] * sx + q.b[1] * sy; D[o++] = q.p[2] + q.a[2] * sx + q.b[2] * sy;
      D[o++] = u; D[o++] = v;
      D[o++] = q.color[0]; D[o++] = q.color[1]; D[o++] = q.color[2]; D[o++] = q.color[3] ?? 1;
      D[o++] = q.shape;
    };
    for (const q of list) {
      corner(q, -1, -1, 0, 0); corner(q, 1, -1, 1, 0); corner(q, 1, 1, 1, 1);
      corner(q, -1, -1, 0, 0); corner(q, 1, 1, 1, 1); corner(q, -1, 1, 0, 1);
    }
    return o / FX_STRIDE;
  }
  draw(gl, renderer, light = 1) {
    if (!this.alpha.length && !this.add.length) return;
    const { prog, vbo } = this.ensure(gl, renderer.contextVersion);
    const eye = renderer.eye;
    this.alpha.sort((a, b) => dist2(b.p, eye) - dist2(a.p, eye));
    gl.useProgram(prog.p);
    gl.uniformMatrix4fv(prog.u.u_vp, false, renderer.viewProj);
    gl.uniform3fv(prog.u.u_eye, eye);
    gl.uniform3fv(prog.u.u_fogColor, renderer.__sailFog ?? [0.7, 0.66, 0.6]);
    gl.uniform2fv(prog.u.u_fog, renderer.fogRange);
    gl.uniform1f(prog.u.u_light, light);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const S = FX_STRIDE * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, S, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, S, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, S, 20);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, S, 36);
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    for (const [list, add] of [[this.alpha, false], [this.add, true]]) {
      if (!list.length) continue;
      const verts = this.write(list);
      gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, verts * FX_STRIDE), gl.DYNAMIC_DRAW);
      gl.uniform1f(prog.u.u_add, add ? 1 : 0);
      if (add) gl.blendFunc(gl.ONE, gl.ONE); else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, verts);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i);
  }
}
const dist2 = (p, e) => (p[0] - e[0]) ** 2 + (p[1] - e[1]) ** 2 + (p[2] - e[2]) ** 2;

/** Camera right/up in the scene frame from a view matrix (column-major lookAt). */
export function viewAxes(view) {
  return { right: [view[0], view[4], view[8]], up: [view[1], view[5], view[9]] };
}
