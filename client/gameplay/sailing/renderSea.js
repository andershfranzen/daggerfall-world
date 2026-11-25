// The open sea drawn around a sailing deck: one polar grid centred under the eye out to the horizon, displaced
// by the shared wave train (renderMath.waveSet) and moved/tilted into the deck frame, so the sea runs past a
// moving hull and the horizon rolls with its heel. Opaque, depth-writing, fogged to the horizon colour.
// Foam washes along the waterline of up to four hulls (their footprint ellipses).

import { createProgram } from '../../render/renderer.js';
import { DISTANCE_FOG } from '../../render/visibility.js';

export const SEA_RINGS = 84;
export const SEA_SEGMENTS = 128;
export const SEA_WAVES = 8; // 5 displacing + 3 ripple-only
export const SEA_MASKS = 4;

const VS = `
attribute vec2 a_pos;
uniform mat4 u_vp;
uniform mat4 u_relToDeck;
uniform vec2 u_center;
uniform vec4 u_wave[${SEA_WAVES}];
uniform float u_displace;
uniform vec3 u_eyeRel;
varying vec3 v_rel;
void main() {
  vec2 p = u_center + a_pos;
  float d = length(p - u_eyeRel.xz);
  float h = 0.0;
  for (int i = 0; i < 5; i++) {
    vec4 w = u_wave[i];
    float len = 6.2831853 / max(length(w.xy), 1e-4);
    float fade = 1.0 - smoothstep(len * 6.0, len * 18.0, d);
    h += w.z * fade * sin(dot(w.xy, p) + w.w);
  }
  v_rel = vec3(p.x, h * u_displace, p.y);
  gl_Position = u_vp * (u_relToDeck * vec4(v_rel, 1.0));
}`;

const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 v_rel;
uniform vec4 u_wave[${SEA_WAVES}];
uniform vec3 u_eyeRel;
uniform vec3 u_sunRel;
uniform vec3 u_fogColor;
uniform vec3 u_skyColor;
uniform vec3 u_deep;
uniform vec3 u_shallow;
uniform float u_light;
uniform float u_seaState;
uniform mat4 u_mask[${SEA_MASKS}];
uniform vec2 u_maskSize[${SEA_MASKS}];
uniform float u_maskCount;
${DISTANCE_FOG}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec3 toEye = u_eyeRel - v_rel;
  float d = length(toEye);
  float hullFoam = 0.0;
  for (int i = 0; i < ${SEA_MASKS}; i++) {
    if (float(i) >= u_maskCount) break;
    vec3 s = (u_mask[i] * vec4(v_rel, 1.0)).xyz;
    vec2 e = s.xz / u_maskSize[i];
    float r = length(e);
    // Inside a hull the sea is hidden by its decks; the wash is a band along the waterline.
    hullFoam = max(hullFoam, smoothstep(0.75, 0.95, r) * (1.0 - smoothstep(1.0, 1.45, r)));
  }
  // Analytic normal from every wave (ripples too), faded with distance against shimmer.
  vec2 g = vec2(0.0);
  float crest = 0.0;
  for (int i = 0; i < ${SEA_WAVES}; i++) {
    vec4 w = u_wave[i];
    float len = 6.2831853 / max(length(w.xy), 1e-4);
    float fade = 1.0 - smoothstep(len * 8.0, len * 30.0, d);
    float a = dot(w.xy, v_rel.xz) + w.w;
    g += w.xy * (w.z * fade * cos(a));
    if (i < 3) crest += w.z * sin(a);
  }
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 v = toEye / max(d, 1e-3);
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  float ndl = max(dot(n, u_sunRel), 0.0);
  vec3 body = mix(u_deep, u_shallow, clamp(0.5 + crest * 0.6, 0.0, 1.0)) * (0.55 + 0.45 * ndl);
  vec3 r = reflect(-v, n);
  vec3 sky = mix(u_fogColor, u_skyColor, clamp(r.y * 2.5, 0.0, 1.0));
  vec3 c = mix(body, sky, fres);
  float spec = pow(max(dot(r, u_sunRel), 0.0), 220.0) * 1.6 * step(0.0, u_sunRel.y);
  c += vec3(1.0, 0.92, 0.75) * spec;
  // Whitecaps on the crests (more in a blow) and the wash against the hulls.
  float noise = hash(floor(v_rel.xz * 1.7)) * 0.5 + hash(floor(v_rel.xz * 4.3)) * 0.5;
  float caps = smoothstep(0.55, 1.0, crest / max(u_seaState * 0.9, 0.2)) * smoothstep(0.35, 0.9, noise) * clamp(u_seaState - 0.25, 0.0, 1.0);
  caps *= 1.0 - smoothstep(250.0, 900.0, d);
  float foam = max(caps, hullFoam * smoothstep(0.2, 0.7, noise + hullFoam * 0.4));
  c = mix(c, vec3(0.86, 0.9, 0.92), clamp(foam, 0.0, 0.85));
  c *= u_light;
  gl_FragColor = vec4(mix(c, u_fogColor, fogAmount(d)), 1.0);
}`;

/** Ring radii (m) of the polar grid: fine under the eye, coarse toward the horizon. */
export function seaRadii(rings = SEA_RINGS) {
  const out = [0];
  for (let i = 1; i < rings; i++) out.push(1.5 * (Math.pow(1.1, i) - 1));
  return out;
}

export function seaGrid(rings = SEA_RINGS, segs = SEA_SEGMENTS) {
  const radii = seaRadii(rings);
  const pos = new Float32Array(rings * segs * 2);
  for (let r = 0; r < rings; r++) for (let s = 0; s < segs; s++) {
    const a = (s / segs) * Math.PI * 2, o = (r * segs + s) * 2;
    pos[o] = Math.cos(a) * radii[r]; pos[o + 1] = Math.sin(a) * radii[r];
  }
  const idx = new Uint16Array((rings - 1) * segs * 6);
  let k = 0;
  for (let r = 0; r < rings - 1; r++) for (let s = 0; s < segs; s++) {
    const a = r * segs + s, b = r * segs + ((s + 1) % segs), c = a + segs, d = b + segs;
    idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  return { pos, idx, radius: radii[rings - 1] };
}

export class SeaPass {
  constructor() { this.res = null; this.version = -1; }
  ensure(gl, version) {
    if (this.res && this.version === version) return this.res;
    const grid = seaGrid();
    const prog = createProgram(gl, VS, FS, ['a_pos']);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, grid.pos, gl.STATIC_DRAW);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, grid.idx, gl.STATIC_DRAW);
    this.res = { prog, vbo, ibo, count: grid.idx.length };
    this.version = version;
    return this.res;
  }
  /**
   * f: {relToDeck (Float32Array 16), center [x,z], eyeRel [x,y,z], sunRel, waves [{kx,kz,amp,phase}], seaState,
   * masks [{relToShip Float32Array 16, halfBeam, halfLength}], fogColor, skyColor, light}
   */
  draw(gl, renderer, f) {
    const { prog, vbo, ibo, count } = this.ensure(gl, renderer.contextVersion);
    const u = prog.u;
    gl.useProgram(prog.p);
    gl.uniformMatrix4fv(u.u_vp, false, renderer.viewProj);
    gl.uniformMatrix4fv(u.u_relToDeck, false, f.relToDeck);
    gl.uniform2f(u.u_center, f.center[0], f.center[1]);
    gl.uniform3fv(u.u_eyeRel, f.eyeRel);
    gl.uniform3fv(u.u_sunRel, f.sunRel);
    const w = new Float32Array(SEA_WAVES * 4);
    f.waves.slice(0, SEA_WAVES).forEach((x, i) => w.set([x.kx, x.kz, x.amp, x.phase], i * 4));
    gl.uniform4fv(u['u_wave[0]'], w);
    gl.uniform1f(u.u_displace, 1);
    gl.uniform1f(u.u_seaState, f.seaState);
    gl.uniform3fv(u.u_fogColor, f.fogColor);
    gl.uniform3fv(u.u_skyColor, f.skyColor);
    gl.uniform3fv(u.u_deep, f.deep ?? [0.04, 0.15, 0.22]);
    gl.uniform3fv(u.u_shallow, f.shallow ?? [0.1, 0.3, 0.36]);
    gl.uniform1f(u.u_light, f.light ?? 1);
    gl.uniform2fv(u.u_fog, renderer.fogRange);
    const masks = f.masks.slice(0, SEA_MASKS);
    const mm = new Float32Array(SEA_MASKS * 16), ms = new Float32Array(SEA_MASKS * 2);
    masks.forEach((m, i) => { mm.set(m.relToShip, i * 16); ms.set([m.halfBeam, m.halfLength], i * 2); });
    gl.uniformMatrix4fv(u['u_mask[0]'], false, mm);
    gl.uniform2fv(u['u_maskSize[0]'], ms);
    gl.uniform1f(u.u_maskCount, masks.length);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }
}
