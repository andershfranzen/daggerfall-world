// Day/night and weather lighting adapter for client/render/renderer.js.
//
// The renderer reads its sky colours from the exported PALETTE arrays and its light from
// `renderer.sunDir`, and scales outdoor visibility with `renderer.fogScale`; this adapter writes those in place
// each frame and restores them on demand, so the renderer itself needs no changes.
// Overall darkness is one colour multiplied over the finished frame (`shade`): the renderer does it itself when
// it can (`renderer.shade`, after which it adds the outdoor sky's own light back, so moons and stars are not
// dimmed with the ground); otherwise a multiply-blend element laid over the canvas (`shadeCss`).
// When the classic SKYnn.DAT panorama is on screen the renderer reports its colours for the moment
// (`renderer.skyTone`); given as `tone`, the fog and sky colours follow the painting's own palette through the
// day instead of the fixed day/night blend.

import { PALETTE } from '../../render/renderer.js';
import { daylight, sunDirection } from './calendar.js';

const BASE = Object.freeze({
  zenith: [...PALETTE.zenith],
  horizon: [...PALETTE.horizon],
  ground: [...PALETTE.ground],
});
const NIGHT = Object.freeze({ zenith: [0.015, 0.025, 0.07], horizon: [0.05, 0.07, 0.13], ground: [0.03, 0.03, 0.04] });
const GREY = Object.freeze({ zenith: [0.42, 0.45, 0.5], horizon: [0.6, 0.62, 0.64], ground: [0.3, 0.3, 0.3] });
const DUSK_GLOW = Object.freeze([0.86, 0.5, 0.36]);
const SHADE_NIGHT = [0.2, 0.25, 0.42];
// Dungeons and water. Radii are in metres (world units). Held-light radii are the classic item templates'
// capacityOrTarget, which DFU uses as the torch light's range: Torch 14, Lantern 16, Candle 8, Holy Candle 10.
// DUNGEON_AMBIENT_RADIUS (unlit sight) and the Light spell / underwater radii are package-21 choices, not source values.
export const DUNGEON_AMBIENT_RADIUS = 10;
export const LIGHT_RADIUS = Object.freeze({ torch: 14, lantern: 16, candle: 8, 'holy candle': 10, 'holy-candle': 10, spell: 16 });
const DARK = Object.freeze([0.012, 0.012, 0.016]);
const UNLIT_SHADE = Object.freeze([0.62, 0.64, 0.72]);
const TORCH_SHADE = Object.freeze([1, 0.94, 0.84]);
const UNDERWATER = Object.freeze({ fog: [0.04, 0.16, 0.19], shade: [0.55, 0.76, 0.86], radius: 12 });

/** How grey the sky goes, how much it darkens, and fog distance multiplier, per weather. */
export const WEATHER_LOOK = Object.freeze({
  sunny: { grey: 0, dim: 1, fog: 1 },
  cloudy: { grey: 0.3, dim: 0.94, fog: 0.95 },
  overcast: { grey: 0.6, dim: 0.84, fog: 0.8 },
  fog: { grey: 0.75, dim: 0.86, fog: 0.22 },
  rain: { grey: 0.7, dim: 0.76, fog: 0.55 },
  thunder: { grey: 0.82, dim: 0.66, fog: 0.5 },
  snow: { grey: 0.65, dim: 0.9, fog: 0.45 },
  indoors: { grey: 0, dim: 1, fog: 1 },
});

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/**
 * Pure lighting description for a time of day and weather.
 * @returns {{zenith:number[],horizon:number[],ground:number[],sunDir:number[],fogScale:number,shade:number[],shadeCss:string,daylight:number,apply:(r:object)=>void}}
 */
export function lightFor(input) {
  const { minuteOfDay, weather = 'sunny', indoors = false, flash = 0, base = BASE, kind = null, lightRadius = 0, underwater = false, tone = null } = input;
  if (underwater) {
    const water = UNDERWATER;
    return finish({ zenith: [...water.fog], horizon: [...water.fog], ground: [...water.fog], sunDir: indoors ? null : sunDirection(minuteOfDay), fogScale: 1,
      fogOverride: [1, water.radius], shade: [...water.shade], daylight: indoors ? 1 : daylight(minuteOfDay), light: 'underwater' }, input);
  }
  if (kind === 'dungeon') {
    // Classic dungeons are unlit: what the player sees is what their light reaches.
    // Any held light warms the view. A Candle (8 m) or Holy Candle (10 m) reaches no further than unlit sight, so
    // only its warmth shows; it must still read as lit.
    const radius = Math.max(DUNGEON_AMBIENT_RADIUS, Number(lightRadius) || 0);
    const lit = (Number(lightRadius) || 0) > 0;
    return finish({ zenith: [...DARK], horizon: [...DARK], ground: [...DARK], sunDir: null, fogScale: 1,
      fogOverride: [radius * 0.3, radius], shade: lit ? [...TORCH_SHADE] : [...UNLIT_SHADE], daylight: 0, light: lit ? 'held' : 'ambient', radius }, input);
  }
  if (indoors) {
    const out = { zenith: [...base.zenith], horizon: [...base.horizon], ground: [...base.ground], sunDir: null, fogScale: 1, shade: [1, 1, 1], daylight: 1 };
    return finish(out, input);
  }
  const look = WEATHER_LOOK[weather] ?? WEATHER_LOOK.sunny;
  const d = daylight(minuteOfDay);
  const glow = Math.max(0, 1 - Math.abs(d - 0.45) / 0.45) * (1 - look.grey) * 0.55; // warm horizon at dawn/dusk
  const sky = {};
  for (const k of ['zenith', 'horizon', 'ground']) {
    if (tone?.[k]) {
      // The classic sky's colour for this minute (dawn reds, the night's blue) only loses saturation to the weather.
      const l = 0.3 * tone[k][0] + 0.5 * tone[k][1] + 0.2 * tone[k][2];
      sky[k] = mix(tone[k], [l, l, l * 1.03], look.grey * 0.8);
      continue;
    }
    let c = mix(base[k], GREY[k], look.grey);
    c = mix(NIGHT[k], c, d);
    sky[k] = c;
  }
  if (!tone?.horizon) sky.horizon = mix(sky.horizon, DUSK_GLOW, glow);
  if (flash > 0) for (const k of ['zenith', 'horizon']) sky[k] = mix(sky[k], [0.85, 0.88, 1], Math.min(1, flash) * 0.7);
  const nightness = 1 - d;
  let shade = mix([1, 1, 1], SHADE_NIGHT, nightness);
  shade = shade.map((v) => v * (look.dim + (1 - look.dim) * nightness));
  if (tone?.horizon) {
    // Under the classic sky the ground takes its light from the painting: dimmer and warmer as its horizon reddens.
    const h = tone.horizon, peak = Math.max(h[0], h[1], h[2], 1e-3);
    const bright = Math.min(1, 0.45 + 0.75 * peak);
    const day = 1 - nightness;
    // Only a coloured horizon tints: the pale blue-white of midday leaves the ground its own colours.
    const sat = 1 - Math.min(h[0], h[1], h[2]) / peak;
    const warm = 0.3 * day * (1 - look.grey) * Math.min(1, Math.max(0, (sat - 0.2) / 0.4));
    shade = shade.map((v, i) => v * (1 + (bright - 1) * day) * (1 + (h[i] / peak - 1) * warm));
  }
  if (flash > 0) shade = mix(shade, [1, 1, 1], Math.min(1, flash) * 0.8);
  const sun = d > 0.02 ? sunDirection(minuteOfDay) : sunDirection((minuteOfDay + 720) % 1440); // moonlight from the opposite side
  return finish({ ...sky, sunDir: sun, fogScale: look.fog, shade, daylight: d }, input);
}

function finish(out, input) {
  out.input = input;
  const css = (v) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  out.shadeCss = `rgb(${css(out.shade[0])} ${css(out.shade[1])} ${css(out.shade[2])})`;
  out.apply = (renderer) => applyLight(renderer, out);
  return out;
}

// Another feature (e.g. scenery's classic sky colours) may write PALETTE too. Whatever is
// there that this adapter did not write becomes the new base it tints from.
const track = { base: null, written: null };
const KEYS = ['zenith', 'horizon', 'ground'];
const same = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) < 1e-6);

function adoptBase() {
  if (!track.base) track.base = Object.fromEntries(KEYS.map((k) => [k, [...PALETTE[k]]]));
  else for (const k of KEYS) if (!same(PALETTE[k], track.written?.[k])) track.base[k] = [...PALETTE[k]];
  return track.base;
}

export function applyLight(renderer, L) {
  const base = adoptBase();
  const lit = L.input ? lightFor({ ...L.input, base }) : L;
  for (const k of KEYS) for (let i = 0; i < 3; i++) PALETTE[k][i] = lit[k][i];
  track.written = Object.fromEntries(KEYS.map((k) => [k, [...PALETTE[k]]]));
  if (!renderer) return lit;
  if (!renderer.__atmo) renderer.__atmo = { sunDir: [...renderer.sunDir], fogScale: renderer.fogScale ?? 1 };
  const a = renderer.__atmo;
  renderer.sunDir = lit.sunDir ? lit.sunDir : [...a.sunDir];
  renderer.fogScale = lit.fogScale;
  renderer.fogOverride = lit.fogOverride ?? null;
  return lit;
}

export function restoreLight(renderer) {
  if (track.base) {
    for (const k of KEYS) if (same(PALETTE[k], track.written?.[k])) for (let i = 0; i < 3; i++) PALETTE[k][i] = track.base[k][i];
  }
  track.base = null;
  track.written = null;
  const a = renderer?.__atmo;
  if (!a) return;
  renderer.sunDir = [...a.sunDir];
  renderer.fogScale = a.fogScale;
  renderer.fogOverride = null;
  if (renderer.shadeInGl) { renderer.shade = null; renderer.skyState = undefined; }
  delete renderer.__atmo;
}

export const BASE_PALETTE = BASE;

/**
 * The player's light radius from private state: the Light spell (package 9: character.magic.active entries with
 * status 'light', optional radius) and a held light (package 7: character.lightSource {template, radius} or a
 * lit inventory item), plus any client-registered sources. Largest wins.
 */
export function heldLightRadius(character, extra = []) {
  let r = 0;
  const c = character ?? {};
  const byName = (t) => LIGHT_RADIUS[String(t ?? '').toLowerCase().replace(/_/g, ' ')] ?? 0;
  for (const e of c.magic?.active ?? []) {
    if (e?.status === 'light') r = Math.max(r, Number(e.radius) > 0 ? Number(e.radius) : LIGHT_RADIUS.spell);
  }
  const src = c.lightSource;
  if (src) r = Math.max(r, Number(src.radius) > 0 ? Number(src.radius) : byName(src.template ?? src.name));
  for (const it of (Array.isArray(c.inventory) ? c.inventory : c.inventory?.items ?? c.items) ?? []) {
    if (it?.lit) r = Math.max(r, Number(it.radius) > 0 ? Number(it.radius) : byName(it.template ?? it.name));
  }
  for (const x of extra) if (Number(x?.radius) > 0) r = Math.max(r, Number(x.radius));
  return r;
}

/**
 * DFU EnablePlayerTorch guttering: below 3 condition a held light's intensity is 0.85 + cos(g) * 0.2 instead of
 * 1.25, with g random-walking by [-0.02, 0.06) per frame. Applied here as a radius scale. Returns { scale, g }.
 */
export function gutter(source, g = 0, rand = Math.random) {
  if (!source || !(Number(source.condition) < 3)) return { scale: 1, g: 0 };
  const next = g + (-0.02 + rand() * 0.08);
  return { scale: (0.85 + Math.cos(next) * 0.2) / 1.25, g: next };
}
