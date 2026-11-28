// WebGL draw pass for town scenery: the terrain apron, static flats (billboards that
// turn about the vertical axis to face the camera, animated at DFU's 5 frames per
// second) and the classic day-sky panorama. It runs as a Renderer.addPass() pass,
// after the town and actors, so everything is depth tested against the buildings.
// Works on WebGL 1 and 2. GL objects are rebuilt from the CPU arrays whenever the
// renderer's contextVersion changes (context loss and restore).

import { DISTANCE_FOG } from '../../render/visibility.js';
import { createProgram, PALETTE } from '../../render/renderer.js';
import { BILLBOARD_STRIDE } from '../../world/scenery/index.js';
import { DEFAULT_SKY_STATE } from '../../render/sky-dome.js';

const HEAD = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

const FLAT_VS = `
attribute vec3 a_center;
attribute vec2 a_corner;
attribute vec2 a_uv;
attribute vec3 a_anim; // frames, atlas stride, start frame
uniform mat4 u_vp;
uniform vec3 u_right;
uniform float u_time;
varying vec2 v_uv;
varying vec3 v_wpos;
void main() {
  vec3 w = a_center + u_right * a_corner.x + vec3(0.0, a_corner.y, 0.0);
  float frame = mod(floor(u_time * 5.0) + a_anim.z, max(a_anim.x, 1.0));
  v_uv = a_uv + vec2(frame * a_anim.y, 0.0);
  v_wpos = w;
  gl_Position = u_vp * vec4(w, 1.0);
}`;

const FLAT_FS = HEAD + `
varying vec2 v_uv;
varying vec3 v_wpos;
uniform sampler2D u_tex;
uniform vec3 u_eye;
uniform vec3 u_fogColor;
${DISTANCE_FOG}
uniform float u_light;
void main() {
  vec4 t = texture2D(u_tex, v_uv);
  if (t.a < 0.5) discard;
  float d = length(u_eye - v_wpos);
  gl_FragColor = vec4(mix(t.rgb * u_light, u_fogColor, fogAmount(d)), 1.0);
}`;

const TERRAIN_VS = `
attribute vec3 a_pos;
attribute vec3 a_nrm;
attribute vec2 a_tile;
attribute vec4 a_rect;
uniform mat4 u_vp;
varying vec3 v_nrm;
varying vec2 v_tile;
varying vec4 v_rect;
varying vec3 v_wpos;
void main() {
  v_nrm = a_nrm; v_tile = a_tile; v_rect = a_rect; v_wpos = a_pos;
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;

const TERRAIN_FS = HEAD + `
varying vec3 v_nrm;
varying vec2 v_tile;
varying vec4 v_rect;
varying vec3 v_wpos;
uniform sampler2D u_tex;
uniform vec3 u_eye;
uniform vec3 u_lightDir;
uniform vec3 u_fogColor;
${DISTANCE_FOG}
void main() {
  vec2 f = fract(v_tile);
  vec3 base = texture2D(u_tex, v_rect.xy + f * v_rect.zw).rgb;
  vec3 n = normalize(v_nrm);
  float ndl = max(dot(n, u_lightDir), 0.0);
  float light = mix(1.0, 0.42 + 0.38 * ndl + 0.2 * (0.5 + 0.5 * n.y), 0.55);
  float d = length(u_eye - v_wpos);
  gl_FragColor = vec4(mix(base * light, u_fogColor, fogAmount(d)), 1.0);
}`;

const SKY_VS = `
attribute vec2 a_pos;
varying vec2 v_ndc;
void main() { v_ndc = a_pos; gl_Position = vec4(a_pos, 1.0, 1.0); }`;

// DaggerfallSky.UpdateSkyRects, re-expressed per view ray: each half of the panorama
// spans 180 degrees of yaw (seam between east and west halves due north), and the
// image rises from the horizon to 1.3 half-screen heights above it at the
// renderer's field of view.
const SKY_FS = HEAD + `
varying vec2 v_ndc;
uniform mat4 u_invVp;
uniform sampler2D u_tex;
uniform float u_zoom;
uniform vec3 u_horizon;
uniform float u_fogScale;
void main() {
  vec4 a = u_invVp * vec4(v_ndc, -1.0, 1.0);
  vec4 b = u_invVp * vec4(v_ndc, 1.0, 1.0);
  vec3 dir = normalize(b.xyz / b.w - a.xyz / a.w);
  float yaw = atan(dir.x, -dir.z); // clockwise from north
  float u = fract(0.5 + yaw / 6.28318530718);
  float horiz = max(length(dir.xz), 1e-4);
  float s = 0.5 * u_zoom * max(dir.y, 0.0) / horiz;
  float v = clamp(s / 1.3, 0.0, 1.0);
  vec3 sky = texture2D(u_tex, vec2(u, 1.0 - v * (1.0 - 1.0 / 220.0) - 0.5 / 220.0)).rgb;
  float mist = 1.0 - u_fogScale;
  float band = smoothstep(0.0, 0.09 + 0.26 * mist, dir.y);
  gl_FragColor = vec4(mix(u_horizon, sky, band * (1.0 - 0.6 * mist)), 1.0);
}`;

function texture(gl, img) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.pixels);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

const PANO_ROWS = 256;

/**
 * A panorama for the sky dome (client/render/sky-dome.js): the image in the top rows of a 256-row texture, so
 * it may repeat around the horizon and filter across the seam on WebGL 1 as well.
 */
function panoTexture(gl, img, into = null) {
  const t = into ?? gl.createTexture();
  const row = img.width * 4;
  const padded = new Uint8Array(row * PANO_ROWS);
  padded.set(img.pixels.subarray(0, row * Math.min(img.height, PANO_ROWS)));
  const last = img.pixels.subarray(row * (img.height - 1), row * img.height);
  for (let y = img.height; y < PANO_ROWS; y++) padded.set(last, y * row);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, PANO_ROWS, 0, gl.RGBA, gl.UNSIGNED_BYTE, padded);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Interleave terrain arrays: pos3 nrm3 tile2 rect4. */
export function interleaveTerrain(terrain) {
  const n = terrain.positions.length / 3;
  const out = new Float32Array(n * 12);
  for (let i = 0; i < n; i++) {
    const o = i * 12;
    out.set(terrain.positions.subarray(i * 3, i * 3 + 3), o);
    out.set(terrain.normals.subarray(i * 3, i * 3 + 3), o + 3);
    out[o + 6] = terrain.tiles[i * 2];
    out[o + 7] = terrain.tiles[i * 2 + 1];
    const r = terrain.rects[terrain.records[i]];
    out[o + 8] = r.u0; out[o + 9] = r.v0; out[o + 10] = r.du; out[o + 11] = r.dv;
  }
  return out;
}

// The shaders are identical across outdoor scenes. Keep one set for the
// lifetime of a GL context and recreate it after a context restoration.
const scenePrograms = new WeakMap();

export class SceneryPass {
  constructor(data) {
    this.data = data;
    this.version = -1;
    this.gl = null;
    this.res = null;
    this.terrainVerts = data.terrain ? interleaveTerrain(data.terrain) : null;
    if (data.terrain) {
      // The interleaved copy is all the pass needs (also for context restore); drop the rest.
      const t = data.terrain;
      t.vertexCount = t.positions.length / 3;
      t.positions = t.normals = t.tiles = t.records = null;
    }
    this.time = 0;
    this.enabled = true;
  }

  #init(gl, renderer) {
    this.release(); // objects of a lost context are already gone; deleting them is harmless
    this.gl = gl;
    const r = {};
    let programs = scenePrograms.get(gl);
    if (!programs || programs.version !== renderer.contextVersion) {
      programs = { version: renderer.contextVersion };
      scenePrograms.set(gl, programs);
    }
    if (this.data.billboards.count) {
      r.flat = programs.flat ??= createProgram(gl, FLAT_VS, FLAT_FS, ['a_center', 'a_corner', 'a_uv', 'a_anim']);
      r.flatBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, r.flatBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.data.billboards.vertices, gl.STATIC_DRAW);
      r.flatTex = texture(gl, this.data.atlas);
    }
    if (this.terrainVerts) {
      r.terrain = programs.terrain ??= createProgram(gl, TERRAIN_VS, TERRAIN_FS, ['a_pos', 'a_nrm', 'a_tile', 'a_rect']);
      r.terrainBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, r.terrainBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.terrainVerts, gl.STATIC_DRAW);
      r.terrainTex = texture(gl, this.data.terrain.atlas);
    }
    if (this.data.sky) {
      r.sky = programs.sky ??= createProgram(gl, SKY_VS, SKY_FS, ['a_pos']);
      r.skyBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, r.skyBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      r.skyTex = texture(gl, this.data.sky);
    }
    this.res = r;
    this.version = renderer.contextVersion;
  }

  /** Another day sky (season or weather changed): only the sky texture is replaced, at the next draw. */
  setSky(sky) {
    if (!sky || sky === this.data.sky) return;
    const hadSky = !!this.data.sky;
    this.data = { ...this.data, sky };
    if (!this.res) return;
    if (!hadSky) { this.res = null; return; } // no sky program yet: the next draw initialises everything
    if (this.res.skyTex) this.gl?.deleteTexture(this.res.skyTex);
    this.res.skyTex = this.gl ? texture(this.gl, sky) : null;
    this.#dropPano();
  }

  #dropPano() {
    const gl = this.gl, pano = this.res?.pano;
    if (!pano) return;
    this.res.pano = null;
    if (gl) for (const t of [pano.a.tex, pano.b.tex, pano.night]) if (t) gl.deleteTexture(t);
  }

  /**
   * The classic panorama set into the renderer's sky dome: the two day frames around the current minute (a sky
   * read with every frame, world/scenery/sky.js readClassicSky; otherwise its one frame) and the night image.
   */
  #drawDome(gl, renderer, r) {
    const sky = this.data.sky;
    const st = renderer.skyState ?? DEFAULT_SKY_STATE;
    const timed = typeof sky.frameAt === 'function';
    const want = timed ? st.frames : { frame: sky.frame ?? 0, next: sky.frame ?? 0, blend: 0 };
    const pano = r.pano ??= { a: { frame: -1, tex: null, img: null }, b: { frame: -1, tex: null, img: null }, night: null };
    if (pano.a.frame !== want.frame && pano.b.frame === want.frame) [pano.a, pano.b] = [pano.b, pano.a]; // time moved on one frame
    for (const [slot, frame] of [[pano.a, want.frame], [pano.b, want.next]]) {
      if (slot.frame === frame && slot.tex) continue;
      slot.img = timed ? sky.frameAt(frame) : sky;
      slot.tex = panoTexture(gl, slot.img, slot.tex);
      slot.frame = frame;
    }
    if (!pano.night && sky.night) pano.night = panoTexture(gl, sky.night);
    gl.depthFunc(gl.LEQUAL); // only where nothing was drawn: the depth buffer still holds its cleared 1.0 there
    gl.depthMask(false);
    renderer.drawSkyDome({
      texA: pano.a.tex, texB: pano.b.tex, texN: pano.night, blend: want.blend,
      top: mix3(pano.a.img.zenith, pano.b.img.zenith, want.blend),
      mid: mix3(pano.a.img.mid ?? pano.a.img.zenith, pano.b.img.mid ?? pano.b.img.zenith, want.blend),
      horizon: mix3(pano.a.img.horizon, pano.b.img.horizon, want.blend),
    });
    gl.activeTexture(gl.TEXTURE0);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
  }

  /** Renderer pass entry point: fn(gl, renderer, camera). */
  draw(gl, renderer, camera) {
    if (!this.enabled || gl.isContextLost?.()) return;
    if (this.version !== renderer.contextVersion || this.gl !== gl || !this.res) this.#init(gl, renderer);
    const r = this.res;
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.activeTexture(gl.TEXTURE0);
    for (let i = 4; i < 8; i++) gl.disableVertexAttribArray?.(i);

    if (r.terrain) {
      const p = r.terrain;
      gl.useProgram(p.p);
      gl.uniformMatrix4fv(p.u.u_vp, false, renderer.viewProj);
      gl.uniform3fv(p.u.u_eye, renderer.eye);
      gl.uniform3fv(p.u.u_lightDir, renderer.sunDir);
      gl.uniform3fv(p.u.u_fogColor, PALETTE.horizon);
      gl.uniform2fv(p.u.u_fog, renderer.fogRange);
      gl.uniform1i(p.u.u_tex, 0);
      gl.bindTexture(gl.TEXTURE_2D, r.terrainTex);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.terrainBuf);
      const s = 48;
      attrib(gl, 0, 3, s, 0); attrib(gl, 1, 3, s, 12); attrib(gl, 2, 2, s, 24); attrib(gl, 3, 4, s, 32);
      gl.drawArrays(gl.TRIANGLES, 0, this.terrainVerts.length / 12);
    }

    if (this.data.billboards.count) {
      const p = r.flat;
      gl.useProgram(p.p);
      gl.uniformMatrix4fv(p.u.u_vp, false, renderer.viewProj);
      gl.uniform3f(p.u.u_right, Math.cos(camera.yaw), 0, Math.sin(camera.yaw));
      gl.uniform1f(p.u.u_time, this.time);
      gl.uniform3fv(p.u.u_eye, renderer.eye);
      gl.uniform3fv(p.u.u_fogColor, PALETTE.horizon);
      gl.uniform2fv(p.u.u_fog, renderer.fogRange);
      gl.uniform1f(p.u.u_light, 0.95);
      gl.uniform1i(p.u.u_tex, 0);
      gl.bindTexture(gl.TEXTURE_2D, r.flatTex);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.flatBuf);
      const s = BILLBOARD_STRIDE * 4;
      attrib(gl, 0, 3, s, 0); attrib(gl, 1, 2, s, 12); attrib(gl, 2, 2, s, 20); attrib(gl, 3, 3, s, 28);
      gl.drawArrays(gl.TRIANGLES, 0, this.data.billboards.count);
    }

    const dome = typeof renderer.drawSkyDome === 'function';
    if (r.sky && dome && renderer.skyState === null) {
      // No sky to see (underwater): the renderer's plain gradient in the water's colour stays.
    } else if (r.sky && dome && renderer.domeActive()) {
      this.#drawDome(gl, renderer, r);
    } else if (r.sky) {
      // Only where nothing was drawn: the depth buffer still holds its cleared 1.0 there.
      const p = r.sky;
      gl.useProgram(p.p);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(false);
      gl.uniformMatrix4fv(p.u.u_invVp, false, renderer.skyInvViewProj ?? renderer.invViewProj); // a heeling deck's tilted sky
      gl.uniform3fv(p.u.u_horizon, PALETTE.horizon);
      gl.uniform1f(p.u.u_fogScale, renderer.fogScale);
      gl.uniform1f(p.u.u_zoom, 1 / Math.tan(renderer.fov / 2));
      gl.uniform1i(p.u.u_tex, 0);
      gl.bindTexture(gl.TEXTURE_2D, r.skyTex);
      gl.bindBuffer(gl.ARRAY_BUFFER, r.skyBuf);
      attrib(gl, 0, 2, 8, 0);
      for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
    }
    for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i);
  }

  release() {
    const gl = this.gl, r = this.res;
    this.#dropPano();
    this.res = null;
    if (!gl || !r) return;
    for (const k of ['flatBuf', 'terrainBuf', 'skyBuf']) if (r[k]) gl.deleteBuffer(r[k]);
    for (const k of ['flatTex', 'terrainTex', 'skyTex']) if (r[k]) gl.deleteTexture(r[k]);
  }
}

function attrib(gl, loc, size, stride, offset) {
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
}
