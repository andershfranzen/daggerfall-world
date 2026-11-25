// Dungeon water surfaces (package 21 presentation).
//
// A flooded RDB block (start-marker water level, client/world/interiors/layout.js `water`) gets one translucent sheet
// at its water level, clipped to the columns of open water (client/world/interiors/waterSurface.js). The sheet is
// built from this browser's collision world for the scene, so it agrees with where locomotion swims, and is drawn in
// the renderer's translucent stage after actor billboards: a swimmer or monster below the surface is seen through
// it. Underwater the atmosphere feature's fog still applies; the sheet is then seen from below.
import { createProgram, PALETTE } from '../render/renderer.js';
import { DISTANCE_FOG } from '../render/visibility.js';
import { waterSurfaceTriangles } from '../world/interiors/waterSurface.js';

export const name = 'water';

// Project colours (no classic water texture is referenced by the dungeon water level): the underwater fog tone,
// lightened so the sheet reads against the dark dungeon floor below it.
export const WATER_LOOK = Object.freeze({ color: [0.11, 0.3, 0.34], alpha: 0.62, underAlpha: 0.4 });

const VS = `
attribute vec3 a_pos;
uniform mat4 u_vp;
varying vec3 v_wpos;
void main() { v_wpos = a_pos; gl_Position = u_vp * vec4(a_pos, 1.0); }`;

const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec3 v_wpos;
uniform vec3 u_eye;
uniform vec3 u_color;
uniform vec3 u_fogColor;
uniform float u_alpha;
uniform float u_time;
${DISTANCE_FOG}
void main() {
  // Slow, low-contrast ripple so the sheet reads as water rather than a flat panel.
  float r = sin(v_wpos.x * 1.7 + u_time * 0.9) * sin(v_wpos.z * 1.3 - u_time * 0.7)
          + 0.5 * sin((v_wpos.x + v_wpos.z) * 3.1 + u_time * 1.6);
  vec3 c = u_color * (1.0 + 0.12 * r);
  float d = length(u_eye - v_wpos);
  float f = fogAmount(d);
  gl_FragColor = vec4(mix(c, u_fogColor, f), u_alpha * (1.0 - 0.6 * f));
}`;

export function install(api, { now = () => performance.now() / 1000 } = {}) {
  const S = { mesh: null, positions: null, stats: null, gl: null, version: -1, prog: null, buf: null, renderer: null, detach: null };

  function reset(mesh) {
    S.mesh = mesh?.kind === 'dungeon' && Array.isArray(mesh.water) && mesh.water.length ? mesh : null;
    S.positions = null;
    S.stats = null;
    if (S.buf && S.gl && !S.renderer?.lost) S.gl.deleteBuffer(S.buf);
    S.buf = null;
  }

  /** Build the sheet once this location's collision world is ready here. */
  function surface() {
    if (!S.mesh) return null;
    if (S.positions) return S.positions;
    if (S.mesh.location && S.mesh.location !== api.location) return null;
    const world = api.locomotionWorld?.();
    if (!world) return null;
    const built = waterSurfaceTriangles(world, S.mesh.water);
    S.positions = built.positions;
    S.stats = built.stats;
    return S.positions;
  }

  function draw(gl, r) {
    const pos = surface();
    if (!pos?.length) return;
    if (S.gl !== gl || S.version !== r.contextVersion) {
      S.gl = gl;
      S.version = r.contextVersion;
      S.prog = createProgram(gl, VS, FS, ['a_pos']);
      S.buf = null;
    }
    if (!S.buf) {
      S.buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, S.buf);
      gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    }
    const { p, u } = S.prog;
    gl.useProgram(p);
    gl.uniformMatrix4fv(u.u_vp, false, r.viewProj);
    gl.uniform3fv(u.u_eye, r.eye);
    gl.uniform2fv(u.u_fog, r.fogRange);
    gl.uniform3fv(u.u_fogColor, PALETTE.horizon);
    gl.uniform3fv(u.u_color, WATER_LOOK.color);
    gl.uniform1f(u.u_alpha, api.movement?.underwater ? WATER_LOOK.underAlpha : WATER_LOOK.alpha);
    gl.uniform1f(u.u_time, now());
    gl.bindBuffer(gl.ARRAY_BUFFER, S.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    for (let i = 1; i < 4; i++) gl.disableVertexAttribArray(i);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLES, 0, pos.length / 3);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  function attach({ renderer } = {}) {
    if (!renderer || renderer === S.renderer || typeof renderer.addTranslucentPass !== 'function') return;
    S.detach?.();
    S.renderer = renderer;
    S.gl = null;
    S.buf = null;
    S.detach = renderer.addTranslucentPass(draw);
  }

  api.on('frame', attach);
  api.on('scene', reset);
  api.on('location', ({ location } = {}) => { if (S.mesh && S.mesh.location !== location) reset(null); });
  /** Diagnostics: the built sheet (null until the collision world is ready). */
  api.waterSurface = () => (S.mesh ? { location: S.mesh.location, built: !!S.positions, triangles: (S.positions?.length ?? 0) / 9, stats: S.stats } : null);
  if (api.town) reset(api.town);
}
