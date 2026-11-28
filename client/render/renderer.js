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
//   skyState               the outdoor sky's moment (client/render/sky-dome.js skyStateFor): undefined shows a
//                          clear late morning, null keeps the plain gradient (interiors, dungeons, underwater).
//   drawSkyDome(pano)      draw the outdoor sky; a scenery pass hands in its classic panorama textures.
//   shade                  [r, g, b] darkness multiplied over the finished frame (night, weather, dungeons). The
//                          outdoor sky is added back afterwards, so the moons and stars keep their own light.
//   skyTone                {horizon, zenith, frame} the classic sky's own colours for the moment, written when a
//                          panorama is drawn; the light model fogs the world with them (atmosphere/light.js).

import { DISTANCE_FOG, OUTDOOR_FAR, PIXEL_COVERAGE, fogDistances } from './visibility.js';
import {
  DEFAULT_GRAPHICS, QUALITY_PRESETS, LIGHTING_PRESETS, RETRO_PRESETS,
  normalizeGraphicsOptions, applyQualityPreset, applyLightingPreset,
  loadGraphicsOptions, saveGraphicsOptions, needsOffscreenPass, computeViewport,
} from './graphics-options.js';
import { DOME_VS, DOME_FS, DEFAULT_SKY_STATE, skyColors } from './sky-dome.js';
import * as M from '../lib/mat.js';

export { DEFAULT_GRAPHICS, QUALITY_PRESETS, LIGHTING_PRESETS, RETRO_PRESETS };

const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;

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
uniform float u_ambient;
uniform float u_shadowStrength;
uniform vec3 u_dynLightPos;
uniform vec3 u_dynLightColor;
uniform float u_dynLightRadius;
uniform float u_dynLightIntensity;
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
  float ambientFloor = (0.42 * u_ambient);
  float direct = u_shadowStrength * ndl + 0.2 * sky * u_ambient;
  float shaded = max(0.08, ambientFloor + direct);
  vec3 lit = vec3(mix(1.0, shaded, u_shade));
  if (u_dynLightRadius > 0.01 && u_dynLightIntensity > 0.001) {
    vec3 toLight = u_dynLightPos - v_wpos;
    float ld = length(toLight);
    if (ld < u_dynLightRadius) {
      float att = 1.0 - (ld / u_dynLightRadius);
      att = att * att;
      vec3 ldir = ld > 0.001 ? toLight / ld : vec3(0.0, 1.0, 0.0);
      float lnd = 0.45 + 0.55 * max(dot(n, ldir), 0.0);
      lit += u_dynLightColor * (att * lnd * u_dynLightIntensity);
    }
  }
  vec3 c = base * lit;
  float d = length(toEye);
  gl_FragColor = vec4(mix(c, u_fogColor, fogAmount(d)), 1.0);
}`;

const POST_VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const POST_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texSize;
uniform float u_paletteMode;
uniform float u_dither;
uniform float u_scanlines;
uniform float u_bloom;
uniform float u_vignette;
uniform float u_fxaa;
uniform vec3 u_unshade; // the frame's shade while a retro palette is on, else 1: the palette is applied to the lit scene

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

float bayer4(vec2 p) {
  vec2 q = mod(floor(p), 4.0);
  float x = q.x;
  float y = q.y;
  float low = 2.0 * mod(x + y, 2.0) + mod(y, 2.0);
  vec2 h = floor(q / 2.0);
  float high = 2.0 * mod(h.x + h.y, 2.0) + mod(h.y, 2.0);
  return (4.0 * low + high + 0.5) / 16.0 - 0.5;
}

vec3 sampleScene(vec2 uv) {
  vec3 c = texture2D(u_tex, uv).rgb;
  if (u_fxaa > 0.5) {
    vec2 px = 1.0 / max(u_texSize, vec2(1.0));
    vec3 cN = texture2D(u_tex, uv + vec2(0.0, -px.y)).rgb;
    vec3 cS = texture2D(u_tex, uv + vec2(0.0, px.y)).rgb;
    vec3 cW = texture2D(u_tex, uv + vec2(-px.x, 0.0)).rgb;
    vec3 cE = texture2D(u_tex, uv + vec2(px.x, 0.0)).rgb;
    float lC = luma(c);
    float lMin = min(lC, min(min(luma(cN), luma(cS)), min(luma(cW), luma(cE))));
    float lMax = max(lC, max(max(luma(cN), luma(cS)), max(luma(cW), luma(cE))));
    float edge = lMax - lMin;
    if (edge > max(0.05, lMax * 0.12)) {
      vec3 avg = 0.25 * (cN + cS + cW + cE);
      c = mix(c, avg, clamp(edge * 1.4, 0.0, 0.55));
    }
  }
  if (u_bloom > 0.005) {
    vec2 px = 2.0 / max(u_texSize, vec2(1.0));
    vec3 b = vec3(0.0);
    b += max(texture2D(u_tex, uv + vec2(px.x, px.y)).rgb - 0.72, 0.0);
    b += max(texture2D(u_tex, uv + vec2(-px.x, px.y)).rgb - 0.72, 0.0);
    b += max(texture2D(u_tex, uv + vec2(px.x, -px.y)).rgb - 0.72, 0.0);
    b += max(texture2D(u_tex, uv + vec2(-px.x, -px.y)).rgb - 0.72, 0.0);
    c += b * (0.28 * u_bloom);
  }
  return c;
}

void main() {
  vec3 c = sampleScene(v_uv);
  if (u_vignette > 0.005) {
    vec2 d = v_uv * 2.0 - 1.0;
    float vig = 1.0 - dot(d, d) * (0.35 * u_vignette);
    c *= clamp(vig, 0.25, 1.0);
  }
  vec2 pix = v_uv * u_texSize;
  float dith = u_dither > 0.5 ? bayer4(pix) : 0.0;
  // The night shade is already in the frame. A retro palette would crush a darkened scene to a few black
  // steps, so the ground (alpha 1; the outdoor sky writes 0 and is not shaded) is lifted back to its lit
  // colours for the palette and darkened again after it, as when the shade was laid over the finished picture.
  float ground = texture2D(u_tex, v_uv).a;
  vec3 sh = mix(vec3(1.0), u_unshade, ground);
  c /= sh;
  // The sky's long gradients get the finer ramp a 256-colour scene palette keeps for them.
  vec3 skyRamp = floor(clamp(c + dith / 40.0, 0.0, 1.0) * 31.0 + 0.5) / 31.0;
  if (u_paletteMode > 2.5) {
    // Daggerfall warm VGA palette: 12-level earth-biased quantization + slight shadow crush
    vec3 warm = c * vec3(1.02, 0.99, 0.94);
    warm = clamp(warm + dith / 14.0, 0.0, 1.0);
    c = mix(skyRamp, floor(warm * 11.0 + 0.5) / 11.0, ground);
  } else if (u_paletteMode > 1.5) {
    // 6-bit VGA DAC posterization (64 levels/channel)
    vec3 q = clamp(c + dith / 48.0, 0.0, 1.0);
    c = floor(q * 31.0 + 0.5) / 31.0;
  } else if (u_paletteMode > 0.5) {
    // Classic 256-color VGA palette (6x6x6 RGB cube + 24-step neutral greyscale ramp)
    vec3 dithered = clamp(c + dith / 5.5, 0.0, 1.0);
    vec3 cube = floor(dithered * 5.0 + 0.5) / 5.0;
    float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
    float g = floor(clamp(luma(c) + dith / 22.0, 0.0, 1.0) * 23.0 + 0.5) / 23.0;
    vec3 grey = vec3(g);
    c = mix(skyRamp, sat < 0.065 ? grey : cube, ground);
  }
  c *= sh;
  if (u_scanlines > 0.005) {
    float scan = 1.0 - u_scanlines * step(0.5, fract(pix.y * 0.5));
    c *= scan;
  }
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
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

const FILL_FS = `
precision mediump float;
uniform vec3 u_color;
void main() { gl_FragColor = vec4(u_color, 1.0); }`;

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
    this.graphics = loadGraphicsOptions();
    this.fov = (this.graphics.fov * Math.PI) / 180;
    this.far = 600;
    this.fogScale = 1;
    this.fogOverride = null;
    this.fogRange = fogDistances(this.far, 1, false, this.graphics.outdoorViewDistance);
    this.width = 1; this.height = 1;
    this.viewport = computeViewport(1, 1, 1, this.graphics);
    this.framebuffer = null;
    this.dynamicLight = { pos: [0, 0, 0], color: [1, 0.78, 0.52], radius: 0, intensity: 0 };
    this._perf = { lastAt: 0, frameMs: 16.6, avgFrameMs: 16.6, fps: 60, drawCalls: 0, samples: 0 };
    this.fbo = null;
    this.isWebGL2 = false;
    this.anisoExt = null;
    this.maxAniso = 1;
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
    this.skyState = undefined;
    this.skyTone = null;
    this.shade = null;
    this.shadeInGl = true; // the atmosphere feature hands its night shade to `shade` instead of a CSS layer
    this.frameId = 0;
    this._skyPano = null;
    this._skyPanoFrame = -9;
    this._skyDrawH = 1;
    this._skyEpoch = typeof performance !== 'undefined' ? performance.now() : Date.now();
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
    const opts = { antialias: this.graphics?.antialias !== false, alpha: false, depth: true, powerPreference: 'high-performance' };
    const gl2 = this.canvas.getContext('webgl2', opts);
    const gl = gl2 || this.canvas.getContext('webgl', opts);
    if (!gl) throw new Error('WebGL is not available in this browser.');
    this.gl = gl;
    this.isWebGL2 = !!gl2;
    this.anisoExt = gl.getExtension('EXT_texture_filter_anisotropic')
      || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
      || gl.getExtension('MOZ_EXT_texture_filter_anisotropic');
    this.maxAniso = this.anisoExt ? gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1 : 1;
    this.world = program(gl, WORLD_VS, WORLD_FS, ['a_pos', 'a_col', 'a_nrm', 'a_uv']);
    this.sky = program(gl, SKY_VS, SKY_FS, ['a_pos']);
    this.fill = program(gl, SKY_VS, FILL_FS, ['a_pos']);
    try {
      this.dome = program(gl, DOME_VS, DOME_FS, ['a_pos']);
    } catch (err) {
      this.dome = null; // the plain gradient still draws
      console.error('Sky shader unavailable', err);
    }
    this.post = program(gl, POST_VS, POST_FS, ['a_pos']);
    this.skyBuf = this.buffer(new Float32Array([-1, -1, 3, -1, -1, 3]));
    const c = cube();
    this.cube = { pos: this.buffer(c.pos), nrm: this.buffer(c.nrm), count: c.pos.length / 3 };
    this.white = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    this.fbo = null;
    this.mesh = null;
    this.gpu = new Map();
    this.contextVersion++;
    this._syncCanvasStyle();
  }

  getGraphicsOptions() {
    return { ...this.graphics };
  }

  setGraphicsOptions(patch, { persist = true } = {}) {
    const prevFilter = this.graphics.textureFiltering;
    const next = normalizeGraphicsOptions({ ...this.graphics, ...(patch || {}) });
    this.graphics = persist ? saveGraphicsOptions(next) : next;
    this.fov = (this.graphics.fov * Math.PI) / 180;
    this._syncCanvasStyle();
    if (!this.lost && this.gl && prevFilter !== this.graphics.textureFiltering) {
      this._reapplyAllTextureFilters();
    }
    if (!this.lost && this.gl && this.fbo) {
      this._updateFboFilter();
    }
    return this.getGraphicsOptions();
  }

  applyGraphicsPreset(presetName, opts) {
    return this.setGraphicsOptions(applyQualityPreset(this.graphics, presetName), opts);
  }

  applyLightingPreset(presetName, opts) {
    return this.setGraphicsOptions(applyLightingPreset(this.graphics, presetName), opts);
  }

  resetGraphicsOptions(opts) {
    return this.setGraphicsOptions({ ...DEFAULT_GRAPHICS }, opts);
  }

  setDynamicLight({ pos, color, radius = 0, intensity = 0 } = {}) {
    this.dynamicLight = {
      pos: Array.isArray(pos) && pos.length >= 3 ? [Number(pos[0]) || 0, Number(pos[1]) || 0, Number(pos[2]) || 0] : this.dynamicLight.pos,
      color: Array.isArray(color) && color.length >= 3 ? [Number(color[0]) || 1, Number(color[1]) || 0.8, Number(color[2]) || 0.55] : [1.0, 0.78, 0.52],
      radius: Math.max(0, Number(radius) || 0),
      intensity: Math.max(0, Number(intensity) || 0),
    };
  }

  perfStats() {
    return {
      fps: Math.round(this._perf.fps),
      frameMs: Number(this._perf.frameMs.toFixed(2)),
      avgFrameMs: Number(this._perf.avgFrameMs.toFixed(2)),
      fbWidth: this.viewport?.fbW ?? this.canvas.width,
      fbHeight: this.viewport?.fbH ?? this.canvas.height,
      canvasWidth: this.canvas.width,
      canvasHeight: this.canvas.height,
      retroMode: this.graphics.retroMode,
      drawCalls: this._perf.drawCalls,
      gpu: this.gpuStats(),
    };
  }

  _syncCanvasStyle() {
    if (!this.canvas?.style) return;
    const pixelated = this.graphics.retroMode !== 'off' && this.graphics.retroNearest;
    this.canvas.style.imageRendering = pixelated ? 'pixelated' : '';
    if (this.canvas.dataset) {
      this.canvas.dataset.retroMode = this.graphics.retroMode;
      this.canvas.dataset.retroPalette = this.graphics.retroPalette;
    }
  }

  _applyTextureFilter(tex, width, height) {
    const gl = this.gl;
    if (!gl || !tex) return;
    const mode = this.graphics.textureFiltering;
    const canMip = this.isWebGL2 || (isPow2(width) && isPow2(height));
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (mode === 'trilinear' && canMip) {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (this.anisoExt && this.maxAniso > 1) {
        gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, this.maxAniso));
      }
    } else if (mode === 'bilinear' || (mode === 'trilinear' && !canMip)) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      if (this.anisoExt) gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, 1);
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      if (this.anisoExt) gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, 1);
    }
  }

  _reapplyAllTextureFilters() {
    for (const g of this.gpu.values()) {
      if (g?.tex) this._applyTextureFilter(g.tex, g.texWidth || 0, g.texHeight || 0);
    }
  }

  _updateFboFilter() {
    if (!this.fbo?.colorTex || !this.gl) return;
    const gl = this.gl;
    const nearest = this.graphics.retroMode !== 'off' ? this.graphics.retroNearest : false;
    const filter = nearest ? gl.NEAREST : gl.LINEAR;
    gl.bindTexture(gl.TEXTURE_2D, this.fbo.colorTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  }

  _ensureFbo(w, h) {
    const gl = this.gl;
    if (this.fbo && this.fbo.width === w && this.fbo.height === h) {
      this._updateFboFilter();
      return this.fbo;
    }
    if (this.fbo) {
      gl.deleteFramebuffer(this.fbo.fb);
      gl.deleteTexture(this.fbo.colorTex);
      gl.deleteRenderbuffer(this.fbo.depthRb);
      this.fbo = null;
    }
    const fb = gl.createFramebuffer();
    const colorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, colorTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const depthRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depthRb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, colorTex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depthRb);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      gl.deleteFramebuffer(fb);
      gl.deleteTexture(colorTex);
      gl.deleteRenderbuffer(depthRb);
      return null;
    }
    this.fbo = { fb, colorTex, depthRb, width: w, height: h };
    this._updateFboFilter();
    return this.fbo;
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
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          mesh.texWidth = atlas.width;
          mesh.texHeight = atlas.height;
          this._applyTextureFilter(mesh.tex, atlas.width, atlas.height);
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
      mesh.texWidth = a.width;
      mesh.texHeight = a.height;
      this._applyTextureFilter(mesh.tex, a.width, a.height);
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
    const vp = computeViewport(this.canvas.clientWidth || this.canvas.width || 1, this.canvas.clientHeight || this.canvas.height || 1, dpr, this.graphics);
    this.viewport = vp;
    if (this.canvas.width !== vp.canvasW || this.canvas.height !== vp.canvasH) {
      this.canvas.width = vp.canvasW;
      this.canvas.height = vp.canvasH;
    }
    this.width = this.canvas.clientWidth || vp.canvasW;
    this.height = this.canvas.clientHeight || vp.canvasH;
  }

  /** camera: {x, y, z, yaw, pitch}; avatars: [{ parts: [{ model, color }] }] */
  render(camera, avatars = []) {
    if (this.lost) return;
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const gl = this.gl;
    const g = this.graphics;
    this.resize();

    const useOffscreen = needsOffscreenPass(g);
    const activeFbo = useOffscreen ? this._ensureFbo(this.viewport.fbW, this.viewport.fbH) : null;
    this.framebuffer = activeFbo ? activeFbo.fb : null;
    const drawW = activeFbo ? activeFbo.width : this.canvas.width;
    const drawH = activeFbo ? activeFbo.height : this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, activeFbo ? activeFbo.fb : null);
    gl.viewport(0, 0, drawW, drawH);

    const cp = Math.cos(camera.pitch);
    const eye = [camera.x, camera.y, camera.z];
    const fwd = [Math.sin(camera.yaw) * cp, Math.sin(camera.pitch), -Math.cos(camera.yaw) * cp];
    this.eye = eye;
    this.camera = camera;
    this.forward = fwd;
    // fogOverride: [start, end] metres set by the atmosphere feature (dungeon light radius, underwater).
    const viewDist = this.outdoors ? g.outdoorViewDistance : this.far;
    const farDist = this.outdoors ? Math.max(this.far, g.outdoorViewDistance + 400) : this.far;
    this.fogRange = this.fogOverride
      ? [Math.min(this.fogOverride[0], farDist * 0.98), Math.min(this.fogOverride[1], farDist * 0.98)]
      : fogDistances(farDist, this.fogScale, this.outdoors, viewDist);
    M.perspective(this.proj, this.fov, this.viewport.aspect, 0.1, farDist);
    M.lookAt(this.view, eye, [eye[0] + fwd[0], eye[1] + fwd[1], eye[2] + fwd[2]], [0, 1, 0]);
    M.multiply(this.viewProj, this.proj, this.view);
    M.invert(this.invViewProj, this.viewProj);
    if (this.skyFrame) {
      this.skyInvViewProj = this.skyInvViewProj === this.invViewProj ? new Float32Array(16) : this.skyInvViewProj;
      M.invert(this.skyInvViewProj, M.multiply(this.tmp, this.viewProj, this.skyFrame));
    } else this.skyInvViewProj = this.invViewProj;

    let drawCalls = 0;
    gl.clearColor(...PALETTE.horizon, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);

    // Sky. Outdoors it is the atmospheric dome; a scenery pass that holds the classic panorama draws the dome
    // again with it (after the world, where nothing was drawn), so this first one is skipped while that runs.
    this.frameId++;
    this._skyDrawH = drawH;
    this._skyDomeFrame = -9;
    const panoRuns = this._skyPanoFrame === this.frameId - 1;
    const domeBase = this.domeActive() && g.skyStyle !== 'classic';
    gl.depthMask(false);
    gl.disable(gl.DEPTH_TEST);
    if (domeBase) {
      if (!panoRuns) { this.drawSkyDome(null); drawCalls++; }
      else this._skyDomeFrame = this.frameId;
    } else if (!(panoRuns && this.domeActive())) {
      gl.useProgram(this.sky.p);
      gl.uniformMatrix4fv(this.sky.u.u_invVp, false, this.skyInvViewProj);
      gl.uniform3fv(this.sky.u.u_zenith, PALETTE.zenith);
      gl.uniform3fv(this.sky.u.u_horizon, PALETTE.horizon);
      gl.uniform3fv(this.sky.u.u_ground, PALETTE.ground);
      gl.uniform3fv(this.sky.u.u_sunDir, this.sunDir);
      this.bindAttr(0, this.skyBuf, 2);
      for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      drawCalls++;
    }

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
    gl.uniform1f(w.u.u_ambient, g.ambientLight);
    gl.uniform1f(w.u.u_shadowStrength, g.dynamicShadows ? 0.38 : 0.16);
    const dl = this.dynamicLight;
    const dynRadius = g.dynamicLights ? dl.radius * g.spellLightBoost : 0;
    const dynIntensity = g.dynamicLights ? dl.intensity * (0.75 + 0.25 * g.spellLightBoost) : 0;
    gl.uniform3fv(w.u.u_dynLightPos, dl.pos);
    gl.uniform3fv(w.u.u_dynLightColor, dl.color);
    gl.uniform1f(w.u.u_dynLightRadius, dynRadius);
    gl.uniform1f(w.u.u_dynLightIntensity, dynIntensity);
    gl.activeTexture(gl.TEXTURE0);

    gl.uniform3f(w.u.u_tint, 1, 1, 1);
    gl.uniform1f(w.u.u_shade, 0.55);
    gl.uniform1f(w.u.u_coverage, 1);
    if (this.mesh) {
      this.updateCityGates(this.town, this.mesh);
      this.drawMesh(this.mesh, this.primaryOffset, null, this.primaryVertexLimit);
      drawCalls++;
    }
    for (const l of this.layers) {
      const gmesh = this.gpu.get(l.mesh);
      if (gmesh) {
        this.updateCityGates(l.mesh, gmesh);
        this.drawMesh(gmesh, l.offset);
        drawCalls++;
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
          drawCalls++;
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

    // The night and weather shade over everything drawn, then the sky's own light added back where the sky shows.
    drawCalls += this._shadeFrame();

    // Fullscreen retro / post-processing blit to screen backbuffer
    if (activeFbo) {
      this.framebuffer = null;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const { x, y, w: dw, h: dh } = this.viewport.dst;
      gl.viewport(x, y, dw, dh);
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.disable(gl.BLEND);
      const post = this.post;
      gl.useProgram(post.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, activeFbo.colorTex);
      gl.uniform1i(post.u.u_tex, 0);
      gl.uniform2f(post.u.u_texSize, activeFbo.width, activeFbo.height);
      const palMap = { off: 0, vga256: 1, posterize6: 2, daggerfall: 3 };
      gl.uniform1f(post.u.u_paletteMode, palMap[g.retroPalette] ?? 0);
      gl.uniform1f(post.u.u_dither, g.retroDither === 'bayer4' ? 1 : 0);
      gl.uniform1f(post.u.u_scanlines, g.retroMode !== 'off' || g.retroScanlines > 0 ? g.retroScanlines : 0);
      gl.uniform1f(post.u.u_bloom, g.postProcessing ? g.bloom : 0);
      gl.uniform1f(post.u.u_vignette, g.postProcessing ? g.vignette : 0);
      gl.uniform1f(post.u.u_fxaa, g.postProcessing && g.antialias && g.retroMode === 'off' ? 1 : 0);
      const quantized = (palMap[g.retroPalette] ?? 0) > 0 || g.retroDither === 'bayer4';
      const sh = quantized && this.shade ? this.shade.map((v) => Math.min(1, Math.max(0.06, v))) : [1, 1, 1];
      gl.uniform3f(post.u.u_unshade, sh[0], sh[1], sh[2]);
      this.bindAttr(0, this.skyBuf, 2);
      for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      drawCalls++;
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);
    }

    const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const frameMs = Math.max(0.05, t1 - t0);
    const dt = this._perf.lastAt > 0 ? Math.max(1, t1 - this._perf.lastAt) : 16.6;
    this._perf.lastAt = t1;
    this._perf.frameMs = frameMs;
    this._perf.avgFrameMs = this._perf.samples === 0 ? frameMs : this._perf.avgFrameMs * 0.9 + frameMs * 0.1;
    this._perf.fps = this._perf.samples === 0 ? Math.min(240, 1000 / dt) : this._perf.fps * 0.9 + Math.min(240, 1000 / dt) * 0.1;
    this._perf.drawCalls = drawCalls;
    this._perf.samples++;
  }

  /** Whether the outdoor sky is the dome (outdoors, shader built, and not held to the plain gradient). */
  domeActive() {
    return !!this.dome && this.outdoors === true && this.skyState !== null;
  }

  /**
   * Draw the outdoor sky over the whole view with the current GL depth and blend state.
   * @param {{texA:WebGLTexture, texB:WebGLTexture, texN:WebGLTexture|null, blend:number, top:number[], mid:number[], horizon:number[]}|null} pano
   *   the classic panorama for the moment (two day frames, how far between them, the night ridge image, and
   *   the frames' blended top-row and fog colours), or null for the procedural horizon
   * @param {number[]|null} scale output multiplier (the shade pass adds the sky back with 1 - shade)
   */
  drawSkyDome(pano = null, scale = null) {
    const gl = this.gl, p = this.dome;
    if (!p) return false;
    const st = this.skyState ?? DEFAULT_SKY_STATE;
    const g = this.graphics;
    const colors = skyColors(st, pano);
    if (scale === null) {
      this._skyDomeFrame = this.frameId;
      this._skyPano = pano;
      if (pano) {
        this._skyPanoFrame = this.frameId;
        this.skyTone = { horizon: colors.fog, zenith: colors.low, frame: this.frameId };
      }
    }
    const u = p.u;
    gl.useProgram(p.p);
    gl.uniformMatrix4fv(u.u_invVp, false, this.skyInvViewProj);
    gl.uniform1f(u.u_time, ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - this._skyEpoch) / 1000);
    gl.uniform3fv(u.u_horizon, PALETTE.horizon);
    gl.uniform3fv(u.u_ground, PALETTE.ground);
    gl.uniform3fv(u.u_shade, this.shade ?? [1, 1, 1]);
    gl.uniform3fv(u.u_outScale, scale ?? [1, 1, 1]);
    gl.uniform3fv(u.u_skyLow, colors.low);
    gl.uniform3fv(u.u_skyTop, colors.top);
    gl.uniform3fv(u.u_cloudLit, colors.cloudLit);
    gl.uniform3fv(u.u_cloudDark, colors.cloudDark);
    gl.uniform3fv(u.u_sunDir, st.sunDir);
    gl.uniform4f(u.u_sun, st.day, 0, st.warmth, st.stars);
    gl.uniform4f(u.u_cloud, st.cloud.cover, st.cloud.grey, st.cloud.deck, st.cloud.mist);
    gl.uniform4f(u.u_flash, st.flashDir[0], st.flashDir[1], st.flashDir[2], st.flash);
    const { masser, secunda } = st.moons;
    gl.uniform4f(u.u_moonA, masser.dir[0], masser.dir[1], masser.dir[2], masser.phase);
    gl.uniform4f(u.u_moonB, secunda.dir[0], secunda.dir[1], secunda.dir[2], secunda.phase);
    gl.uniform4f(u.u_pano, pano ? (g.skyStyle === 'classic' ? 2 : 1) : 0, pano?.blend ?? 0, st.night, pano?.texN ? 1 : 0);
    // No ridges at sea: a ship's sky frame means open water all round.
    gl.uniform4f(u.u_view, 1 / Math.tan(this.fov / 2), this.fov / Math.max(1, this._skyDrawH), (st.minuteOfDay / 1440) * Math.PI * 2, this.skyFrame ? 0 : 0.085);
    const tex = [pano?.texA, pano?.texB, pano?.texN];
    for (let i = 2; i >= 0; i--) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex[i] ?? this.white);
    }
    gl.uniform1i(u.u_texA, 0);
    gl.uniform1i(u.u_texB, 1);
    gl.uniform1i(u.u_texN, 2);
    this.bindAttr(0, this.skyBuf, 2);
    for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return true;
  }

  /** Multiply `shade` over the frame, then add the outdoor sky back (it is drawn in its final colours). */
  _shadeFrame() {
    const s = this.shade;
    if (!s || (s[0] > 0.996 && s[1] > 0.996 && s[2] > 0.996)) return 0;
    const gl = this.gl;
    let calls = 1;
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.DST_COLOR, gl.ZERO);
    gl.useProgram(this.fill.p);
    gl.uniform3f(this.fill.u.u_color, Math.min(1, Math.max(0, s[0])), Math.min(1, Math.max(0, s[1])), Math.min(1, Math.max(0, s[2])));
    this.bindAttr(0, this.skyBuf, 2);
    for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (this._skyDomeFrame === this.frameId && this.dome) {
      // Only where the depth buffer still holds its cleared 1.0: the sky itself.
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.drawSkyDome(this._skyPanoFrame === this.frameId ? this._skyPano : null, [1 - s[0], 1 - s[1], 1 - s[2]].map((v) => Math.min(1, Math.max(0, v))));
      gl.depthFunc(gl.LESS);
      calls++;
    }
    gl.disable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ZERO);
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    return calls;
  }

  bindAttr(loc, buf, size) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  }

  /** World point to CSS pixel coordinates (after the last render). */
  project(x, y, z) {
    const vp = this.viewport;
    if (vp?.retro && vp.dst && this.canvas.width > 0 && this.canvas.height > 0) {
      const sx = this.width / this.canvas.width;
      const sy = this.height / this.canvas.height;
      const localW = vp.dst.w * sx;
      const localH = vp.dst.h * sy;
      const p = M.projectToScreen(this.viewProj, x, y, z, localW, localH);
      if (!p) return null;
      return {
        ...p,
        x: p.x + vp.dst.x * sx,
        y: p.y + (this.canvas.height - vp.dst.y - vp.dst.h) * sy,
      };
    }
    return M.projectToScreen(this.viewProj, x, y, z, this.width, this.height);
  }
}
