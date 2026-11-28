// WebGL2 renderer of the 3D automap: a real depth buffer, back-face culling, flat directional shading, a shader
// clip plane for the cutaway, antialiased structural edges, a floor reference grid and distance haze.
//
// Geometry comes from automap/view3d.js (build3DScene); the clip matrix is viewProjection3D(), which matches
// project3D() exactly, so the markers the panel draws on its 2D overlay canvas sit on the geometry.
// create3DRenderer() returns null where WebGL2 is unavailable; the panel then paints build3DDrawList() instead.

import { PALETTE, LIGHT_DIR, AMBIENT, viewProjection3D, cameraPosition3D, orbitDistance } from './view3d.js';

const rgb = (c) => [c[0] / 255, c[1] / 255, c[2] / 255];

const COMMON = `#version 300 es
precision highp float;
uniform mat4 uMvp;
uniform vec3 uEye;
uniform float uTop;      // cutaway plane: nothing above it is solid
uniform float uFloorY;   // height of the viewed floor
uniform float uDist;     // orbit distance (haze scale)
uniform vec3 uBg;
`;

const FACE_VS = `${COMMON}
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
layout(location=2) in vec3 aColour;
out vec3 vWorld;
flat out vec3 vNormal;
flat out vec3 vColour;
void main() {
  vWorld = aPos; vNormal = aNormal; vColour = aColour;
  gl_Position = uMvp * vec4(aPos, 1.0);
}`;

const FACE_FS = `${COMMON}
uniform vec3 uLight;
uniform float uAmbient;
uniform vec3 uBelow;
uniform vec3 uAbove;
uniform vec3 uRim;
uniform float uGhost;
in vec3 vWorld;
flat in vec3 vNormal;
flat in vec3 vColour;
out vec4 outColour;
void main() {
  if (uGhost > 0.5) {
    // Levels above the cutaway: a faint veil so the storeys overhead are hinted at, never in the way.
    if (vWorld.y <= uTop) discard;
    outColour = vec4(uRim, 0.045);
    return;
  }
  if (vWorld.y > uTop) discard;
  float light = uAmbient + (1.0 - uAmbient) * pow(0.5 + 0.5 * dot(vNormal, uLight), 1.35);
  float dy = vWorld.y - uFloorY;
  float below = clamp((-dy - 0.75) / 9.0, 0.0, 1.0);
  float above = clamp((dy - 2.2) / 12.0, 0.0, 1.0);
  vec3 c = vColour;
  c = mix(c, uBelow, below * 0.72);
  c = mix(c, uAbove, above * 0.3);
  c *= light * (1.0 - below * 0.28);
  float wall = 1.0 - smoothstep(0.35, 0.6, abs(vNormal.y));
  // Walls of the viewed level darken toward their foot: rooms read as sculpted volumes.
  float foot = smoothstep(-0.2, 2.6, dy) * (1.0 - step(4.5, dy));
  c *= mix(1.0, mix(0.8, 1.04, foot), wall * (1.0 - below));
  // The cut itself: a bright rim where the cutaway plane slices through a wall.
  float band = max(0.06, fwidth(vWorld.y) * 1.25);
  float rim = wall * smoothstep(uTop - band, uTop - band * 0.4, vWorld.y) * step(uTop, 1.0e8);
  c = mix(c, uRim, rim * 0.8);
  float haze = smoothstep(uDist * 1.15, uDist * 3.4, distance(vWorld, uEye)) * 0.6;
  c = mix(c, uBg, haze);
  outColour = vec4(c, 1.0);
}`;

// One instanced quad per structural edge, widened in screen space and feathered for antialiasing.
const EDGE_VS = `${COMMON}
layout(location=0) in vec2 aCorner;   // x: 0 = end A, 1 = end B; y: side -1 / +1
layout(location=1) in vec3 aA;
layout(location=2) in vec3 aB;
layout(location=3) in vec3 aNA;
layout(location=4) in vec3 aNB;
layout(location=5) in float aCrease;
uniform vec2 uViewport;
uniform float uWidth;
out float vSide;
out vec3 vWorld;
void main() {
  vec3 mid = 0.5 * (aA + aB);
  vec3 toEye = uEye - mid;
  bool fa = dot(aNA, toEye) > 0.0;
  bool fb = dot(aNB, toEye) > 0.0;
  // Creases and borders show with either face; gentle bends only where they are the silhouette.
  bool show = aCrease > 0.5 ? (fa || fb) : (fa != fb);
  vec4 a = uMvp * vec4(aA, 1.0);
  vec4 b = uMvp * vec4(aB, 1.0);
  vec3 wa = aA, wb = aB;
  const float NEAR = 0.6;
  if (a.w < NEAR && b.w < NEAR) show = false;
  else if (a.w < NEAR) { float k = (NEAR - a.w) / (b.w - a.w); a = mix(a, b, k); wa = mix(aA, aB, k); }
  else if (b.w < NEAR) { float k = (NEAR - b.w) / (a.w - b.w); b = mix(b, a, k); wb = mix(aB, aA, k); }
  if (!show) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vSide = 0.0; vWorld = mid; return; }
  vec2 sa = a.xy / a.w * uViewport, sb = b.xy / b.w * uViewport;
  vec2 dir = sb - sa;
  float len = length(dir);
  dir = len > 1.0e-4 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 p = aCorner.x < 0.5 ? a : b;
  vWorld = aCorner.x < 0.5 ? wa : wb;
  float half_ = uWidth * 0.5 + 1.0;
  p.xy += (nrm * aCorner.y * half_ + dir * (aCorner.x < 0.5 ? -0.5 : 0.5)) / uViewport * p.w;
  // Pull edges a hair toward the camera so they win against the faces they outline.
  p.z -= 0.0006 * p.w;
  vSide = aCorner.y * half_;
  gl_Position = p;
}`;

const EDGE_FS = `${COMMON}
uniform float uWidth;
uniform vec3 uInk;
uniform vec3 uInkBelow;
uniform vec3 uGhostInk;
uniform float uGhost;
uniform float uAlpha;
in float vSide;
in vec3 vWorld;
out vec4 outColour;
void main() {
  float a = 1.0 - smoothstep(uWidth * 0.5 - 0.5, uWidth * 0.5 + 0.5, abs(vSide));
  if (uGhost > 0.5) {
    if (vWorld.y <= uTop + 0.02) discard;
    // Only the storey just overhead is hinted at, fading out a few metres above the cut.
    float fade = 1.0 - smoothstep(0.6, 6.5, vWorld.y - uTop);
    if (fade < 0.01) discard;
    outColour = vec4(uGhostInk, a * uAlpha * fade);
    return;
  }
  if (vWorld.y > uTop + 0.01) discard;
  float below = clamp((uFloorY - vWorld.y - 0.75) / 9.0, 0.0, 1.0);
  vec3 c = mix(uInk, uInkBelow, below);
  float haze = smoothstep(uDist * 1.15, uDist * 3.4, distance(vWorld, uEye)) * 0.6;
  outColour = vec4(mix(c, uBg, haze), a * uAlpha * (1.0 - haze * 0.5));
}`;

// The reference grid on the viewed floor's plane and flat translucent surfaces (water).
const PLANE_VS = `${COMMON}
layout(location=0) in vec3 aPos;
out vec3 vWorld;
void main() { vWorld = aPos; gl_Position = uMvp * vec4(aPos, 1.0); }`;

const GRID_FS = `${COMMON}
uniform vec3 uTarget;
uniform float uStep;
uniform vec3 uGrid;
in vec3 vWorld;
out vec4 outColour;
float lines(vec2 p, float step_) {
  vec2 g = p / step_;
  vec2 w = max(fwidth(g), vec2(1.0e-5));
  vec2 d = abs(fract(g - 0.5) - 0.5) / w;
  return 1.0 - clamp(min(d.x, d.y), 0.0, 1.0);
}
void main() {
  float minor = lines(vWorld.xz, uStep);
  float major = lines(vWorld.xz, uStep * 4.0);
  // Minor lines fade out before they crowd together in the distance.
  float density = max(fwidth(vWorld.x), fwidth(vWorld.z)) / uStep;
  minor *= 1.0 - smoothstep(0.08, 0.3, density);
  float r = distance(vWorld.xz, uTarget.xz) / uDist;
  float fade = 1.0 - smoothstep(0.9, 3.2, r);
  float a = max(minor * 0.13, major * 0.3) * fade;
  if (a < 0.004) discard;
  outColour = vec4(uGrid, a);
}`;

const WATER_FS = `${COMMON}
uniform vec3 uWater;
in vec3 vWorld;
out vec4 outColour;
void main() {
  if (vWorld.y > uTop) discard;
  vec2 g = vWorld.xz * 0.5;
  float ripple = 0.5 + 0.5 * sin(g.x * 3.1 + sin(g.y * 2.3) * 1.4);
  outColour = vec4(uWater * (0.85 + 0.25 * ripple), 0.62);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`automap shader: ${log}`);
  }
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`automap program: ${gl.getProgramInfoLog(p)}`);
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u: uniforms };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @returns {null | {draw: Function, dispose: Function, lost: () => boolean}}
 */
export function create3DRenderer(canvas) {
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, stencil: false, powerPreference: 'low-power' });
  } catch { gl = null; }
  if (!gl) return null;
  let progs;
  try {
    progs = {
      face: program(gl, FACE_VS, FACE_FS),
      edge: program(gl, EDGE_VS, EDGE_FS),
      grid: program(gl, PLANE_VS, GRID_FS),
      water: program(gl, PLANE_VS, WATER_FS),
    };
  } catch (err) {
    console.warn(err);
    return null;
  }
  let lost = false;
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });

  const buf = () => gl.createBuffer();
  const faceVao = gl.createVertexArray(), edgeVao = gl.createVertexArray(), planeVao = gl.createVertexArray(), waterVao = gl.createVertexArray();
  const facePos = buf(), faceNormal = buf(), faceColour = buf(), corner = buf(), edgeData = buf(), planeBuf = buf(), waterBuf = buf();
  let faceCount = 0, edgeCount = 0, waterCount = 0;
  let loaded = { scene: null, key: null, water: null };

  gl.bindVertexArray(faceVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, facePos); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, faceNormal); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.BYTE, true, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, faceColour); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.UNSIGNED_BYTE, true, 0, 0);

  gl.bindVertexArray(edgeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, corner);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 0, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, edgeData);
  const STRIDE = 32; // A(12) B(12) nA(3) nB(3) crease(1) pad(1)
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE, 0); gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, STRIDE, 12); gl.vertexAttribDivisor(2, 1);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 3, gl.BYTE, true, STRIDE, 24); gl.vertexAttribDivisor(3, 1);
  gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 3, gl.BYTE, true, STRIDE, 27); gl.vertexAttribDivisor(4, 1);
  gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 1, gl.UNSIGNED_BYTE, false, STRIDE, 30); gl.vertexAttribDivisor(5, 1);

  gl.bindVertexArray(planeVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, planeBuf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(waterVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, waterBuf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const q = (v) => Math.max(-127, Math.min(127, Math.round(v * 127)));

  function upload(scene, mask) {
    const show = (t) => !mask || mask[t];
    let n = 0;
    for (let t = 0; t < scene.count; t++) if (show(t)) n++;
    const pos = new Float32Array(n * 9), nor = new Int8Array(n * 9), col = new Uint8Array(n * 9);
    let o = 0;
    for (let t = 0; t < scene.count; t++) {
      if (!show(t)) continue;
      pos.set(scene.pos.subarray(t * 9, t * 9 + 9), o * 9);
      for (let v = 0; v < 3; v++) {
        for (let i = 0; i < 3; i++) {
          nor[o * 9 + v * 3 + i] = q(scene.normal[t * 3 + i]);
          col[o * 9 + v * 3 + i] = scene.colour[t * 3 + i];
        }
      }
      o++;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, facePos); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, faceNormal); gl.bufferData(gl.ARRAY_BUFFER, nor, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, faceColour); gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
    faceCount = n * 3;

    const E = scene.edgeCrease.length;
    const data = new ArrayBuffer(E * STRIDE);
    const f32 = new Float32Array(data), i8 = new Int8Array(data), u8 = new Uint8Array(data);
    let e = 0;
    for (let i = 0; i < E; i++) {
      const a = scene.edgeTris[i * 2], b = scene.edgeTris[i * 2 + 1];
      if (!(show(a) || (b >= 0 && show(b)))) continue;
      for (let k = 0; k < 6; k++) f32[e * 8 + k] = scene.edges[i * 6 + k];
      for (let k = 0; k < 6; k++) i8[e * STRIDE + 24 + k] = q(scene.edgeNormals[i * 6 + k]);
      u8[e * STRIDE + 30] = scene.edgeCrease[i];
      e++;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, edgeData);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(data, 0, e * STRIDE), gl.STATIC_DRAW);
    edgeCount = e;
  }

  /**
   * @param {object} f  { scene, mask, maskKey, view, slice, floorY, gridStep, dpr, water: Float32Array|null, ghost }
   */
  function draw(f) {
    if (lost) return false;
    const { scene, view } = f;
    const W = canvas.width, H = canvas.height;
    gl.viewport(0, 0, W, H);
    const bg = rgb(PALETTE.background);
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!scene) return true;
    if (loaded.scene !== scene || loaded.key !== f.maskKey) {
      upload(scene, f.mask);
      loaded = { ...loaded, scene, key: f.maskKey };
    }
    if (loaded.water !== f.water) {
      gl.bindBuffer(gl.ARRAY_BUFFER, waterBuf);
      gl.bufferData(gl.ARRAY_BUFFER, f.water ?? new Float32Array(0), gl.STATIC_DRAW);
      waterCount = f.water ? f.water.length / 3 : 0;
      loaded.water = f.water;
    }

    const dist = orbitDistance(view);
    const b = scene.bounds;
    const reach = Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) + dist * 4;
    const near = Math.max(0.4, dist * 0.02);
    const mvp = viewProjection3D(view, near, near + reach + dist);
    const eye = cameraPosition3D(view);
    const top = Number.isFinite(f.slice?.top) ? f.slice.top : 1e9;
    const common = (pr) => {
      gl.useProgram(pr.p);
      gl.uniformMatrix4fv(pr.u.uMvp, false, mvp);
      gl.uniform3fv(pr.u.uEye, eye);
      gl.uniform1f(pr.u.uTop, top);
      gl.uniform1f(pr.u.uFloorY, f.floorY);
      gl.uniform1f(pr.u.uDist, dist);
      gl.uniform3fv(pr.u.uBg, bg);
    };

    // 1. Solid architecture: depth tested, back faces culled (inward-facing shells open toward the viewer).
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.disable(gl.BLEND);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1.5);
    common(progs.face);
    gl.uniform3fv(progs.face.u.uLight, LIGHT_DIR);
    gl.uniform1f(progs.face.u.uAmbient, AMBIENT);
    gl.uniform3fv(progs.face.u.uBelow, rgb(PALETTE.below));
    gl.uniform3fv(progs.face.u.uAbove, rgb(PALETTE.above));
    gl.uniform3fv(progs.face.u.uRim, rgb(PALETTE.ghost));
    gl.uniform1f(progs.face.u.uGhost, 0);
    gl.bindVertexArray(faceVao);
    gl.drawArrays(gl.TRIANGLES, 0, faceCount);
    gl.disable(gl.POLYGON_OFFSET_FILL);

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);

    // 2. Reference grid on the viewed floor's plane (just under it, so floors cover it).
    gl.disable(gl.CULL_FACE);
    const R = dist * 3.6;
    const gy = f.floorY - 0.04;
    gl.bindBuffer(gl.ARRAY_BUFFER, planeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      view.centerX - R, gy, view.centerZ - R, view.centerX + R, gy, view.centerZ - R, view.centerX - R, gy, view.centerZ + R,
      view.centerX + R, gy, view.centerZ + R,
    ]), gl.DYNAMIC_DRAW);
    common(progs.grid);
    gl.uniform3f(progs.grid.u.uTarget, view.centerX, gy, view.centerZ);
    gl.uniform1f(progs.grid.u.uStep, f.gridStep || 6.4);
    gl.uniform3fv(progs.grid.u.uGrid, rgb(PALETTE.grid));
    gl.bindVertexArray(planeVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // 3. Water.
    if (waterCount) {
      common(progs.water);
      gl.uniform3fv(progs.water.u.uWater, rgb(PALETTE.water));
      gl.bindVertexArray(waterVao);
      gl.drawArrays(gl.TRIANGLES, 0, waterCount);
    }

    // 4. Structural edges.
    const dpr = f.dpr || 1;
    common(progs.edge);
    gl.uniform2f(progs.edge.u.uViewport, W / 2, H / 2);
    gl.uniform1f(progs.edge.u.uWidth, 1.15 * dpr);
    gl.uniform3fv(progs.edge.u.uInk, rgb(PALETTE.edge));
    gl.uniform3fv(progs.edge.u.uInkBelow, rgb([112, 134, 152]));
    gl.uniform3fv(progs.edge.u.uGhostInk, rgb(PALETTE.ghost));
    gl.uniform1f(progs.edge.u.uGhost, 0);
    gl.uniform1f(progs.edge.u.uAlpha, 0.9);
    gl.bindVertexArray(edgeVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, edgeCount);

    // 5. Storeys above the cutaway, as a faint ghost: thin lines and a veil, depth tested against the solid level.
    if (f.ghost && top < 1e8) {
      gl.uniform1f(progs.edge.u.uGhost, 1);
      gl.uniform1f(progs.edge.u.uAlpha, 0.17);
      gl.uniform1f(progs.edge.u.uWidth, 1.0 * dpr);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, edgeCount);
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
    return true;
  }

  function dispose() {
    try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* already gone */ }
  }

  return { draw, dispose, lost: () => lost };
}
