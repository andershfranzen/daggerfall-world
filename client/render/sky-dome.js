// The outdoor sky: Daggerfall's painted SKYnn.DAT panorama set into a procedural atmosphere.
//
// One fragment shader draws every outdoor sky, in the colours the player finally sees:
//   hybrid  (default) the classic panorama stays in front near the horizon (its ridges, cloud banks and painted
//           sun, one frame per 11.25 game minutes with its own palette), feathered at the top into a dome that
//           takes its colour from the rows the painting fades out over, and at the bottom into the world's fog.
//           Above it: sun and corona, forward scattering, drifting high cloud, and at night Masser, Secunda and
//           a turning starfield over the classic NITEnnI0.IMG ridge line.
//   classic the panorama exactly as Daggerfall Unity places it (a flat band 1.3 half-screens high at the
//           renderer's field of view, nearest texels, the NITE image with fixed stars at night) and nothing else.
// Without the player's ARENA2 files the hybrid style paints its own ridges and cloud; the classic style keeps the
// renderer's plain gradient.
//
// This module is pure (no DOM, no GL objects): shader source, the sky's clock (sun, moons, classic sky frame) and
// the colour arithmetic, so it can be tested in Node. client/render/renderer.js owns the program.
//
// The sky frame per time of day follows Daggerfall Unity's Internal/DaggerfallSky.cs (64 frames between dawn and
// dusk) and the moons' 32-day cycle its Utility/DaggerfallDateTime.cs (MIT, (c) 2009-2023 Daggerfall Workshop).
// See client/world/scenery/THIRD_PARTY_NOTICES.txt.

export const SKY_STYLES = Object.freeze(['hybrid', 'classic']);

/**
 * How high the panorama stands in the hybrid style: the tangent of the elevation its top row reaches (52 degrees).
 * It is wrapped on an upright cylinder, as the classic sky is, so its level cloud lines stay level; unlike the
 * classic placement the height is fixed, and does not stretch with the field of view.
 */
export const PANORAMA_RISE = 1.3;
/** Angular radii (radians) of the two moons' discs. */
const MASSER_RADIUS = 0.075;
const SECUNDA_RADIUS = 0.036;
const DAWN_MINUTE = 360;
const DUSK_MINUTE = 1080;
const MINUTES_PER_FRAME = (DUSK_MINUTE - DAWN_MINUTE) / 64;
const TAU = Math.PI * 2;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const wrapDay = (m) => ((m % 1440) + 1440) % 1440;

/** Night colours, as displayed: sky just above the haze, zenith, and the fog the far ground fades to (before the night shade). */
export const NIGHT_SKY = Object.freeze({ low: [0.03, 0.055, 0.15], top: [0.008, 0.014, 0.045], fog: [0.05, 0.07, 0.13] });

/**
 * Which classic sky frames a minute of the day shows.
 * `frame`/`next` are SKY frame numbers 0..63 (32..63 are the morning frames mirrored), `blend` the way from one to
 * the other, `night` how far the night sky has replaced them (0 by day, 1 at night, a half-hour fade either side).
 */
export function skyFrameAt(minuteOfDay) {
  const m = wrapDay(minuteOfDay);
  const f = Math.min(63, Math.max(0, (m - DAWN_MINUTE) / MINUTES_PER_FRAME));
  const frame = Math.min(63, Math.floor(f));
  const next = Math.min(63, frame + 1);
  const night = m < 720 ? 1 - smooth(DAWN_MINUTE - 45, DAWN_MINUTE + 15, m) : smooth(DUSK_MINUTE - 15, DUSK_MINUTE + 45, m);
  return { frame, next, blend: next === frame ? 0 : f - frame, night };
}

/**
 * Where the sky's sun stands (unit vector, y up, +x east, -z north). It climbs due east, crosses the zenith at
 * noon and sets due west, at the height the painted sun has in the same classic frame, so the two are one sun.
 * Below the horizon it keeps sinking (the world's own light direction, calendar.sunDirection, never does).
 */
export function skySunDirection(minuteOfDay) {
  const m = wrapDay(minuteOfDay);
  const morning = m <= 720;
  // The classic frame on show, counted from dawn; after noon the frames run back (frame n shows 63 - n mirrored).
  const shown = (m - DAWN_MINUTE) / MINUTES_PER_FRAME;
  const f = morning ? shown : 63 - shown; // negative at night
  // The painted sun's row: 218 - 9.3 * frame of 220, measured in SKY08/16/26.
  const v = 0.0091 + 0.0423 * f;
  let e = Math.atan(v * PANORAMA_RISE);
  const knee = Math.atan(0.8 * PANORAMA_RISE);
  if (e > knee) {
    const fk = (0.8 - 0.0091) / 0.0423;
    const t = clamp01((f - fk) / (32 - fk));
    e = knee + (Math.PI / 2 - knee) * (1 - (1 - t) * (1 - t)); // ease into the zenith at noon
  }
  e = Math.max(e, -Math.PI / 2);
  return [(morning ? 1 : -1) * Math.cos(e), Math.sin(e), 0];
}

/**
 * Masser and Secunda. Each runs a 32-day cycle (phase 0 = full, 0.5 = new), Masser four days ahead of Secunda
 * (day offsets 3 and -1, after Daggerfall Unity's lunar phases), and both keep to the night side of the sky on
 * tilted paths a little apart.
 * @param {number} classicMinutes world minutes (any epoch; only whole days and the minute of the day matter)
 */
export function moonState(classicMinutes) {
  const minutes = Number.isFinite(classicMinutes) ? classicMinutes : 0;
  const day = minutes / 1440;
  const a = (wrapDay(minutes) / 1440) * TAU; // 0 at midnight
  const phase = (offset) => ((((day + offset) % 32) + 32) % 32) / 32;
  const path = (lead, tilt) => {
    const t = a + lead; // overhead at midnight + lead
    return norm([-Math.sin(t) * Math.cos(tilt), Math.cos(t) * Math.cos(tilt), Math.sin(tilt)]); // rises in the east
  };
  return {
    masser: { dir: path(0.3, -0.2), phase: phase(3), radius: MASSER_RADIUS },
    secunda: { dir: path(-0.14, 0.16), phase: phase(-1), radius: SECUNDA_RADIUS },
  };
}

/** Cloud cover, how grey the sky turns, how much of a solid deck it is, and mist, per weather. */
export const SKY_WEATHER = Object.freeze({
  sunny: { cover: 0.5, grey: 0, deck: 0, mist: 0 },
  cloudy: { cover: 0.66, grey: 0.3, deck: 0.3, mist: 0.05 },
  overcast: { cover: 0.86, grey: 0.6, deck: 0.8, mist: 0.2 },
  fog: { cover: 0.8, grey: 0.75, deck: 0.85, mist: 0.78 },
  rain: { cover: 0.95, grey: 0.7, deck: 0.95, mist: 0.45 },
  thunder: { cover: 1, grey: 0.82, deck: 1, mist: 0.5 },
  snow: { cover: 0.92, grey: 0.65, deck: 0.92, mist: 0.55 },
});

/**
 * Everything the sky shader needs to know about the moment, as plain numbers.
 * @param {{minuteOfDay:number, classicMinutes?:number, weather?:string, flash?:number, flashDir?:number[]}} input
 */
export function skyStateFor(input = {}) {
  const minuteOfDay = wrapDay(Number(input.minuteOfDay) || 0);
  const sunDir = skySunDirection(minuteOfDay);
  const elev = Math.asin(Math.max(-1, Math.min(1, sunDir[1])));
  const frames = skyFrameAt(minuteOfDay);
  const w = SKY_WEATHER[input.weather] ?? SKY_WEATHER.sunny;
  return {
    minuteOfDay,
    weather: SKY_WEATHER[input.weather] ? input.weather : 'sunny',
    sunDir,
    day: smooth(-0.14, 0.16, elev), // 0 with the sun well down, 1 once it is up
    night: frames.night,
    warmth: Math.exp(-(((elev - 0.05) / 0.2) ** 2)), // the low sun's amber, either side of the horizon
    stars: clamp01(1 - smooth(-0.22, -0.02, elev)) * (1 - 0.85 * w.deck),
    moons: moonState(Number.isFinite(input.classicMinutes) ? input.classicMinutes : minuteOfDay),
    frames,
    cloud: w,
    flash: clamp01(Number(input.flash) || 0),
    flashDir: input.flashDir ? norm(input.flashDir) : [0.5, 0.45, -0.74],
  };
}

/** A clear late morning: what the sky shows before the world clock is known. */
export const DEFAULT_SKY_STATE = Object.freeze(skyStateFor({ minuteOfDay: DAWN_MINUTE + 31.5 * MINUTES_PER_FRAME, classicMinutes: 0 }));

const grey = (c, t) => { const l = 0.3 * c[0] + 0.5 * c[1] + 0.2 * c[2]; return mix3(c, [l * 0.96, l * 0.98, l * 1.04], t); };

/**
 * The colours the dome and its clouds are painted with.
 * @param {object} state skyStateFor() result
 * @param {{top:number[], mid:number[], horizon:number[]}|null} pano the classic panorama's colours for the moment (day frames
 *   blended): its top row, the band where it fades into the dome, and its fog colour; or null
 * @returns {{low:number[], top:number[], cloudLit:number[], cloudDark:number[], fog:number[]|null}}
 */
export function skyColors(state, pano) {
  const n = state.night, g = state.cloud.grey;
  let low, top, fog = null;
  if (pano) {
    const t = grey(pano.top, g * 0.7);
    // The dome starts in the colour of the rows the painting fades out over, so the join has no step in tone.
    low = mix3(grey(pano.mid ?? pano.top, g * 0.7), NIGHT_SKY.low, n);
    // Deeper and bluer overhead than the painting's top row, as the air thins.
    top = mix3([t[0] * 0.5, t[1] * 0.62, t[2] * 0.86], NIGHT_SKY.top, n);
    fog = mix3(pano.horizon, NIGHT_SKY.fog, n);
  } else {
    // No painting: a sky of our own for the hour (the haze still takes the renderer's fog colour).
    const d = state.day, w = 0.85 * state.warmth;
    low = mix3(NIGHT_SKY.low, mix3([0.6, 0.76, 0.95], [0.96, 0.6, 0.36], w), d);
    top = mix3(NIGHT_SKY.top, mix3([0.17, 0.38, 0.78], [0.3, 0.3, 0.52], w), d);
    const dim = 1 - 0.38 * g * d;
    low = grey(low, g * 0.85).map((v) => v * dim);
    top = grey(top, g * 0.85).map((v) => v * dim);
  }
  const sunTint = mix3([1, 0.52, 0.24], [1, 0.97, 0.9], smooth(0.02, 0.45, state.sunDir[1]));
  const lum = Math.max(low[0], low[1], low[2]);
  let lit = mix3(mix3(low, [1, 1, 1], 0.72), sunTint, 0.35 * state.warmth);
  lit = lit.map((v, i) => v * (0.25 + 0.75 * Math.min(1, lum * 1.6)) * sunTint[i] ** (0.6 * state.warmth));
  lit = mix3(grey(lit, g), [0.1, 0.12, 0.19], n * 0.9);
  const dark = mix3(mix3(low, [lum * 0.5, lum * 0.52, lum * 0.58], 0.65 + 0.3 * g).map((v) => v * (0.82 - 0.3 * g)), [0.022, 0.03, 0.06], n * 0.9);
  return { low, top, cloudLit: lit, cloudDark: dark, fog };
}

export const DOME_VS = `
attribute vec2 a_pos;
varying vec2 v_ndc;
void main() { v_ndc = a_pos; gl_Position = vec4(a_pos, 1.0, 1.0); }`;

export const DOME_FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_ndc;
uniform mat4 u_invVp;
uniform float u_time;
uniform vec3 u_horizon;   // fog colour, before the shade
uniform vec3 u_ground;
uniform vec3 u_shade;     // the darkness laid over the world; the haze must match the shaded fog
uniform vec3 u_outScale;  // 1, or (1 - shade) when the sky is added back over the shaded frame
uniform vec3 u_skyLow;
uniform vec3 u_skyTop;
uniform vec3 u_cloudLit;
uniform vec3 u_cloudDark;
uniform vec3 u_sunDir;
uniform vec4 u_sun;       // day, unused, warmth, stars
uniform vec4 u_cloud;     // cover, grey, deck, mist
uniform vec4 u_flash;     // direction, strength
uniform vec4 u_moonA;     // direction, phase
uniform vec4 u_moonB;
uniform vec4 u_pano;      // style (0 none, 1 hybrid, 2 classic), day frame blend, night mix, 1 if a night image is bound
uniform vec4 u_view;      // zoom, radians per pixel, star turn, ridge height (fallback horizon)
uniform sampler2D u_texA;
uniform sampler2D u_texB;
uniform sampler2D u_texN;

const float PANO_RISE = ${PANORAMA_RISE.toFixed(4)};
const float TAU = 6.28318530718;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}
float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * noise2(p); p = p * 2.03 + vec2(17.3, 9.1); a *= 0.5; }
  return s / 0.9375;
}

// One texel-smoothed sample of a panorama stored in a 256-row texture (image rows from the top).
vec4 panorama(sampler2D t, float width, float rows, float u, float v, float crisp) {
  vec2 p = vec2(u * width, (1.0 - v) * (rows - 1.0) + 0.5) - 0.5;
  vec2 i = floor(p), f = p - i;
  f = mix(smoothstep(0.12, 0.88, f), step(0.5, f), crisp);
  return texture2D(t, vec2((i.x + 0.5 + f.x) / width, (i.y + 0.5 + f.y) / 256.0));
}

float starLayer(vec3 d, float scale, float keep, float size) {
  vec3 p = d * scale;
  vec3 i = floor(p);
  float h = hash31(i);
  if (h < keep) return 0.0;
  vec3 o = vec3(hash31(i + 7.1), hash31(i + 13.7), hash31(i + 29.3)) * 0.6 + 0.2;
  float dist = length(p - i - o) / scale; // radians, near enough
  float r = max(size, u_view.y * 0.8);
  float b = (h - keep) / (1.0 - keep);
  float tw = 0.78 + 0.22 * sin(u_time * (1.3 + 3.0 * b) + h * 311.0);
  return (1.0 - smoothstep(r * 0.35, r, dist)) * (0.35 + 0.65 * b) * tw * min(1.0, (size / r) * (size / r) * 1.6); // at low resolutions the faint ones go out instead of becoming snow
}

// A moon: rgb is its lit face, a its disc coverage; halo is the glow around it.
vec4 moon(vec3 dir, vec4 m, float rad, vec3 tint, float seed, out float halo) {
  float ang = acos(clamp(dot(dir, m.xyz), -1.0, 1.0));
  float a = m.w * TAU;
  float full = 0.5 + 0.5 * cos(a);
  halo = (exp(-ang / (rad * 1.5)) * 0.42 + exp(-ang / (rad * 6.0)) * 0.11) * (0.25 + 0.75 * full);
  float cover = 1.0 - smoothstep(rad - u_view.y, rad + u_view.y, ang);
  if (cover <= 0.0) return vec4(0.0);
  vec3 ex = normalize(cross(vec3(0.0, 1.0, 0.0), m.xyz) + vec3(1e-4, 0.0, 0.0));
  vec3 ey = cross(m.xyz, ex);
  vec2 q = vec2(dot(dir, ex), dot(dir, ey)) / sin(rad);
  float z = sqrt(max(1.0 - dot(q, q), 0.0));
  // The cycle runs full (0), waning, new (0.5), waxing: the lit limb changes sides, tipped a little off level.
  vec3 L = normalize(vec3(sin(a) * 0.95, -abs(sin(a)) * 0.3, cos(a)));
  float lit = smoothstep(-0.03, 0.14, dot(vec3(q, z), L));
  float maria = fbm(q * 2.3 + seed);
  float crater = smoothstep(0.62, 0.7, noise2(q * 7.0 + seed * 3.0));
  vec3 face = tint * (0.62 + 0.62 * maria - 0.1 * crater) * (0.6 + 0.4 * z);
  return vec4(face * (lit + 0.03), cover);
}

void main() {
  vec4 a4 = u_invVp * vec4(v_ndc, -1.0, 1.0);
  vec4 b4 = u_invVp * vec4(v_ndc, 1.0, 1.0);
  vec3 dir = normalize(b4.xyz / b4.w - a4.xyz / a4.w);
  float h = dir.y;
  float up = max(h, 0.0);
  float yaw = atan(dir.x, -dir.z); // clockwise from north
  float u = 0.5 + yaw / TAU;
  vec3 haze = u_horizon * u_shade;
  float mist = u_cloud.w;
  float night = u_pano.z;
  vec3 col;

  if (u_pano.x > 1.5) {
    // Classic: DaggerfallSky.UpdateSkyRects per view ray, nearest texels, nothing added.
    float s = 0.5 * u_view.x * up / max(length(dir.xz), 1e-4);
    float v = clamp(s / 1.3, 0.0, 1.0);
    col = mix(panorama(u_texA, 1024.0, 220.0, u, v, 1.0).rgb, panorama(u_texB, 1024.0, 220.0, u, v, 1.0).rgb, u_pano.y);
    if (night > 0.0) {
      vec3 nc = u_skyLow;
      if (u_pano.w > 0.5) {
        vec4 n = panorama(u_texN, 512.0, 219.0, u * 2.0, v, 1.0);
        nc = n.rgb;
        vec2 cell = floor(vec2(fract(u * 2.0) * 512.0, v * 218.0));
        if (n.a < 0.5 && hash21(cell + 3.7) > 0.9975) nc = vec3(0.78);
      }
      col = mix(col, nc, night);
    }
    float band = smoothstep(0.0, 0.09 + 0.26 * mist, h);
    col = mix(haze, col, band * (1.0 - 0.6 * mist));
    gl_FragColor = vec4(col * u_outScale, 0.0); // alpha 0 marks sky for the post pass (renderer.js)
    return;
  }

  float day = u_sun.x;
  float warmth = u_sun.z;
  vec3 sun = u_sunDir;
  float mu = dot(dir, sun);
  float sunUp = smoothstep(-0.1, 0.06, sun.y);
  vec3 sunCol = mix(vec3(1.0, 0.5, 0.2), vec3(1.0, 0.95, 0.84), smoothstep(0.0, 0.4, sun.y));
  float veil = 1.0 - 0.8 * u_cloud.z; // how much of the sun's own light gets through the deck

  // The dome: the low sky's colour deepening to the zenith, lighter toward the sun.
  col = mix(u_skyLow, u_skyTop, pow(smoothstep(0.18, 1.0, up), 0.8));
  col *= 0.94 + 0.12 * day * mu * mu;
  float gm = 0.76;
  float mie = (1.0 - gm * gm) / pow(1.0 + gm * gm - 2.0 * gm * mu, 1.5);
  col += sunCol * mie * 0.018 * sunUp * veil;
  vec2 sxz = sun.xz / max(length(sun.xz), 1e-3);
  float toward = max(dot(dir.xz / max(length(dir.xz), 1e-3), sxz), 0.0);
  col += vec3(1.0, 0.46, 0.16) * warmth * veil * exp(-up * 5.5) * (0.12 + 0.88 * toward * toward) * 0.42;

  // Stars turn about the north-south axis with the night.
  if (u_sun.w > 0.004) {
    float cr = cos(u_view.z), sr = sin(u_view.z);
    vec3 sd = vec3(dir.x * cr - dir.y * sr, dir.x * sr + dir.y * cr, dir.z);
    float st = starLayer(sd, 34.0, 0.9, 0.0042) * 1.25 + starLayer(sd, 71.0, 0.86, 0.0026) * 0.8 + starLayer(sd.zxy, 133.0, 0.8, 0.0017) * 0.5;
    float tintSeed = hash31(floor(sd * 34.0));
    vec3 starCol = mix(vec3(0.72, 0.82, 1.0), vec3(1.0, 0.86, 0.68), tintSeed);
    float lane = exp(-pow(dot(sd, normalize(vec3(0.35, 0.5, 0.79))) * 3.6, 2.0));
    col += (starCol * st + vec3(0.42, 0.48, 0.7) * lane * (0.03 + 0.07 * fbm(sd.xz * 5.0 + sd.y * 3.0))) * u_sun.w * smoothstep(0.0, 0.14, h);
  }

  // Masser and Secunda.
  float moonVis = 1.0 - 0.8 * day;
  float haloA, haloB;
  vec4 mA = moon(dir, u_moonA, ${MASSER_RADIUS.toFixed(4)}, vec3(0.93, 0.4, 0.27), 1.7, haloA);
  vec4 mB = moon(dir, u_moonB, ${SECUNDA_RADIUS.toFixed(4)}, vec3(0.86, 0.9, 1.0), 6.3, haloB);
  col += (vec3(0.85, 0.3, 0.2) * haloA + vec3(0.62, 0.72, 1.0) * haloB) * moonVis * 0.55;
  col = mix(col, max(mA.rgb * moonVis, col * 0.55), mA.a);
  col = mix(col, max(mB.rgb * moonVis, col * 0.55), mB.a);

  // The classic panorama, where it stands (found first: it hides the procedural sun's disc).
  float pv = clamp(up / max(length(dir.xz), 1e-4) / PANO_RISE, 0.0, 1.0);
  float panoA = 0.0;
  vec3 pano = vec3(0.0);
  if (u_pano.x > 0.5) {
    pano = mix(panorama(u_texA, 1024.0, 220.0, u, pv, 0.0).rgb, panorama(u_texB, 1024.0, 220.0, u, pv, 0.0).rgb, u_pano.y);
    panoA = (1.0 - smoothstep(0.3, 0.74, pv)) * (1.0 - night);
  }

  // The sun: a crisp disc and a soft corona, where the painting has not already put it.
  float ang = acos(clamp(mu, -1.0, 1.0));
  float disc = 1.0 - smoothstep(0.04 - u_view.y, 0.04 + u_view.y, ang);
  float corona = exp(-ang / 0.034) * 0.3 + exp(-ang / 0.13) * 0.09;
  col += sunCol * (disc * 1.2 + corona) * sunUp * veil * (1.0 - panoA) * smoothstep(-0.02, 0.03, h);

  // High cloud: streaks drifting on the wind, thickening into a deck in bad weather.
  vec2 cp = dir.xz / (up + 0.16) * 0.9 + u_time * vec2(0.0055, 0.0021);
  float wisp = fbm(cp * vec2(0.55, 1.5) + fbm(cp * 0.6) * 0.9);
  float bulk = fbm(cp * 0.75 + vec2(31.0, 7.0) - u_time * vec2(0.0018, 0.0));
  float field = mix(wisp, 0.55 * wisp + 0.6 * bulk, u_cloud.z);
  float cover = u_cloud.x + 0.12 * (1.0 - step(0.5, u_pano.x)); // with no painted cloud bank, a little more of our own
  float dens = smoothstep(0.98 - cover * 0.86, 1.3 - cover * 0.86, field);
  float cloudA = dens * mix(0.5, 0.97, u_cloud.z) * mix(smoothstep(0.02, 0.26, h), 1.0, u_cloud.z);
  float lightSide = clamp(0.95 - 0.75 * dens + 0.25 * mu * day - 0.55 * u_cloud.z * (bulk - 0.45) * 2.2, 0.0, 1.0);
  vec3 cloudCol = mix(u_cloudDark, u_cloudLit, lightSide);
  cloudCol += sunCol * 0.5 * sunUp * veil * exp(-ang / 0.22) * (1.0 - dens * 0.7); // silver lining
  cloudCol += (vec3(0.85, 0.3, 0.2) * haloA + vec3(0.62, 0.72, 1.0) * haloB) * moonVis * 0.25;
  float bolt = u_flash.w * (0.16 + 1.5 * exp(-(1.0 - dot(dir, u_flash.xyz)) * 7.0));
  cloudCol += vec3(0.72, 0.8, 1.0) * bolt * (0.35 + 0.65 * dens);
  float overPano = panoA * (1.0 - 0.3 * smoothstep(0.25, 0.5, pv)); // the painting's own clouds come first
  col = mix(col, cloudCol, cloudA * (1.0 - overPano));

  if (u_pano.x > 0.5) {
    // The painting greys with the weather, warms with a low sun and lights up with the storm.
    float pl = dot(pano, vec3(0.3, 0.5, 0.2));
    pano = mix(pano, vec3(pl) * vec3(0.94, 0.97, 1.03) * (1.0 - 0.22 * u_cloud.y), u_cloud.y * 0.75);
    pano += vec3(1.0, 0.5, 0.18) * warmth * veil * (0.1 + 0.9 * toward * toward) * 0.2 * (0.35 + pl);
    pano += vec3(0.72, 0.8, 1.0) * bolt * 0.5 * (0.3 + pl);
    col = mix(col, pano, panoA);
    if (night > 0.0 && u_pano.w > 0.5) {
      // The night ridge line: the classic silhouette, in the colour the far ground fades to.
      float ridge = panorama(u_texN, 512.0, 219.0, u * 2.0, pv, 0.0).a;
      col = mix(col, haze * 0.8, ridge * smoothstep(0.25, 0.9, night));
    }
  } else {
    // No classic files: painted ridges of our own, two ranges fading into the haze.
    vec2 c = vec2(cos(yaw), sin(yaw));
    float r1 = u_view.w * (0.3 + 1.1 * fbm(c * 2.1 + 4.0));
    float r2 = u_view.w * (0.12 + 0.75 * fbm(c * 4.3 + 11.0) + 0.1 * noise2(c * 23.0));
    vec3 far = mix(u_skyLow * vec3(0.6, 0.68, 0.84), haze, 0.3);
    col = mix(col, far, smoothstep(r1 + 0.004, r1 - 0.004, h) * step(0.0005, u_view.w));
    col = mix(col, mix(far, haze, 0.55) * 0.8, smoothstep(r2 + 0.003, r2 - 0.003, h) * step(0.0005, u_view.w));
  }

  // Haze: the sky meets the ground in the world's fog colour, deeper in mist.
  float hz = exp(-up / (mix(0.075, 0.03, step(0.5, u_pano.x)) + 0.3 * mist));
  col = mix(col, haze, clamp(hz + 0.6 * mist * (1.0 - hz), 0.0, 1.0));
  if (h < 0.0) col = mix(haze, u_ground * u_shade, 0.7 * smoothstep(0.0, 0.3, -h));

  col += (hash21(gl_FragCoord.xy + 0.37) - 0.5) / 255.0; // break up banding in the long gradients
  gl_FragColor = vec4(max(col, 0.0) * u_outScale, 0.0);
}`;
