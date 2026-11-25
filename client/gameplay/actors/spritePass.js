// WebGL billboard pass for actor sprites. Runs inside Renderer.render after the
// town (renderer.addPass), so depth testing against buildings is intact.
// Sprites are cylindrical billboards: upright, turned to the camera's right
// vector, alpha-tested (palette index 0 is transparent), fogged like the town.

import { DISTANCE_FOG, PIXEL_COVERAGE } from '../../render/visibility.js';
import { createProgram, PALETTE } from '../../render/renderer.js';

const VS = `
attribute vec3 a_pos;
attribute vec2 a_uv;
attribute vec4 a_col;
attribute float a_coverage;
uniform mat4 u_vp;
varying vec2 v_uv;
varying vec4 v_col;
varying vec3 v_wpos;
varying float v_coverage;
void main() {
  v_uv = a_uv;
  v_col = a_col;
  v_wpos = a_pos;
  v_coverage = a_coverage;
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;

const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
varying vec4 v_col;
varying vec3 v_wpos;
varying float v_coverage;
uniform sampler2D u_tex;
uniform vec3 u_eye;
uniform vec3 u_fogColor;
${DISTANCE_FOG}
${PIXEL_COVERAGE}
void main() {
  if (v_coverage < 1.0 && !pixelVisible(v_coverage)) discard;
  vec4 t = texture2D(u_tex, v_uv);
  if (t.a < 0.5) discard;
  // v_col.rgb multiplies (light, target highlight); v_col.a mixes toward a hurt red.
  vec3 c = mix(t.rgb * v_col.rgb, vec3(0.85, 0.12, 0.08), v_col.a * 0.55);
  float d = length(u_eye - v_wpos);
  gl_FragColor = vec4(mix(c, u_fogColor, fogAmount(d)), 1.0);
}`;

const FLOATS = 10; // pos3 uv2 col4 coverage
const MAX_SPRITES = 512;

/**
 * Billboard corners for a sprite standing at (x, y, z) with world size w × h,
 * facing a camera whose yaw is `yaw` (client convention). Returns 4 [x,y,z]
 * corners: bottom-left, bottom-right, top-right, top-left as seen by the viewer.
 */
export function billboardCorners(x, y, z, w, h, yaw) {
  const rx = Math.cos(yaw) * w * 0.5, rz = Math.sin(yaw) * w * 0.5;
  return [
    [x - rx, y, z - rz], [x + rx, y, z + rz],
    [x + rx, y + h, z + rz], [x - rx, y + h, z - rz],
  ];
}

export class SpritePass {
  constructor() {
    this.version = -1;
    this.textures = new Map(); // archive → { tex, entry }
    this.data = new Float32Array(MAX_SPRITES * 6 * FLOATS);
    this.items = [];
  }

  #init(gl, renderer) {
    this.prog = createProgram(gl, VS, FS, ['a_pos', 'a_uv', 'a_col', 'a_coverage']);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    this.textures.clear();
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.version = renderer.contextVersion;
  }

  #texture(gl, entry) {
    const have = this.textures.get(entry.archive);
    if (have && have.entry === entry) return have.tex;
    if (have) gl.deleteTexture(have.tex);
    const { atlas } = entry;
    if (atlas.width > this.maxTex || atlas.height > this.maxTex) return null;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, atlas.width, atlas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, atlas.pixels);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(entry.archive, { tex, entry });
    return tex;
  }

  /**
   * Draw the given sprites. Each item: { entry, record, frame, flip, x, y, z, w, h, light, hurt }.
   * Called from a renderer pass with the camera of the frame being drawn.
   */
  draw(gl, renderer, camera, items) {
    if (!items.length) return;
    if (this.version !== renderer.contextVersion) this.#init(gl, renderer);
    const groups = new Map();
    for (const it of items.slice(0, MAX_SPRITES)) {
      let g = groups.get(it.entry.archive);
      if (!g) groups.set(it.entry.archive, (g = []));
      g.push(it);
    }
    const d = this.data;
    let n = 0;
    const ranges = [];
    for (const [, list] of groups) {
      const tex = this.#texture(gl, list[0].entry);
      if (!tex) continue;
      const start = n;
      const { width: AW, height: AH } = list[0].entry.atlas;
      for (const it of list) {
        const rect = it.entry.atlas.rects[it.record]?.[it.frame];
        if (!rect) continue;
        let u0 = rect.x / AW, u1 = (rect.x + rect.w) / AW;
        const v0 = rect.y / AH, v1 = (rect.y + rect.h) / AH; // v0 = top row
        if (it.flip) [u0, u1] = [u1, u0];
        const c = billboardCorners(it.x, it.y, it.z, it.w, it.h, camera.yaw);
        const uv = [[u0, v1], [u1, v1], [u1, v0], [u0, v0]];
        const l = it.light ?? 1;
        const lr = it.tint?.[0] ?? 1, lg = it.tint?.[1] ?? 1, lb = it.tint?.[2] ?? 1;
        for (const k of [0, 1, 2, 0, 2, 3]) {
          const o = n * FLOATS;
          d[o] = c[k][0]; d[o + 1] = c[k][1]; d[o + 2] = c[k][2];
          d[o + 3] = uv[k][0]; d[o + 4] = uv[k][1];
          d[o + 5] = l * lr; d[o + 6] = l * lg; d[o + 7] = l * lb; d[o + 8] = it.hurt ?? 0;
          d[o + 9] = it.coverage ?? 1;
          n++;
        }
      }
      if (n > start) ranges.push({ tex, start, count: n - start });
    }
    if (!n) return;

    const p = this.prog;
    gl.useProgram(p.p);
    gl.uniformMatrix4fv(p.u.u_vp, false, renderer.viewProj);
    gl.uniform3fv(p.u.u_eye, renderer.eye);
    gl.uniform3fv(p.u.u_fogColor, PALETTE.horizon);
    gl.uniform2fv(p.u.u_fog, renderer.fogRange);
    gl.uniform1i(p.u.u_tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, n * FLOATS));
    const stride = FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, stride, 20);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, stride, 36);
    for (const r of ranges) {
      gl.bindTexture(gl.TEXTURE_2D, r.tex);
      gl.drawArrays(gl.TRIANGLES, r.start, r.count);
    }
  }
}
