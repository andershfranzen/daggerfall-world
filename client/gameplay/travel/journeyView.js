// Pure helpers for the travel journey view (client/gameplay/journey.js): the whole Iliac Bay
// assembled from the original region maps in the player's own ARENA2, the framing that zooms out
// from the traveller to show origin and destination, and the journey's timeline. No DOM.
//
// Every FMAP*.IMG region map is a 320x160 window onto the same 1000x500 map-pixel grid the
// catalogue uses (REGION_MAP_ORIGIN, from DaggerfallTravelMapWindow), so pasting each at its corner
// gives one continuous map on which a journey's map pixels can be drawn directly. Betony's map is
// drawn at four times scale and is left out; the surrounding maps cover its island.

import { REGION_MAP_ORIGIN, regionMapCorner, REGION_MAP_W, REGION_MAP_H } from './mapimages.js';
import { MAP_WIDTH, MAP_HEIGHT } from './catalog.js';

export const MAP_W = MAP_WIDTH;
export const MAP_H = MAP_HEIGHT;
/** The tightest view (map pixels across): about a region map's height. */
export const MIN_VIEW_W = 110;
/** The view the zoom starts and ends in, close round the traveller. */
export const CLOSE_VIEW_W = 48;

const BETONY = 'FMAP0I19.IMG';
/** Region maps in paste order. Each region's own map is drawn last over its neighbours' copies. */
export const COMPOSITE_MAPS = Object.freeze(Object.keys(REGION_MAP_ORIGIN).filter((n) => n !== BETONY));

/**
 * Assemble the bay from decoded region maps.
 * @param {(name:string) => ({width:number, height:number, rgba:Uint8ClampedArray}|null)} imageOf
 * @returns {{width:number, height:number, rgba:Uint8ClampedArray, maps:number}}
 */
export function compositeWorld(imageOf) {
  const rgba = new Uint8ClampedArray(MAP_W * MAP_H * 4);
  let maps = 0;
  for (const name of COMPOSITE_MAPS) {
    const img = imageOf(name);
    if (!img) continue;
    const [ox, oy] = regionMapCorner(name);
    const w = Math.min(img.width, REGION_MAP_W), h = Math.min(img.height, REGION_MAP_H);
    for (let y = 0; y < h; y++) {
      const Y = oy + y;
      if (Y < 0 || Y >= MAP_H) continue;
      for (let x = 0; x < w; x++) {
        const X = ox + x;
        if (X < 0 || X >= MAP_W) continue;
        const s = (y * img.width + x) * 4, d = (Y * MAP_W + X) * 4;
        rgba[d] = img.rgba[s]; rgba[d + 1] = img.rgba[s + 1]; rgba[d + 2] = img.rgba[s + 2]; rgba[d + 3] = 255;
      }
    }
    maps++;
  }
  // Corners no region map covers are open sea: fill them with the maps' own commonest water colour.
  const counts = new Map();
  for (let i = 0; i < rgba.length; i += 4 * 7) {
    if (!rgba[i + 3]) continue;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (b > r + 40 && b > g + 30) {
      const k = (r << 16) | (g << 8) | b;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  let sea = 0x2c46a8, best = 0;
  for (const [k, n] of counts) if (n > best) { best = n; sea = k; }
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3]) continue;
    rgba[i] = sea >> 16; rgba[i + 1] = (sea >> 8) & 255; rgba[i + 2] = sea & 255; rgba[i + 3] = 255;
  }
  return { width: MAP_W, height: MAP_H, rgba, maps };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A view {cx, cy, w} (centre and width in map pixels) for a viewport `aspect` (width / height), kept on the map. */
export function fitView(cx, cy, w, aspect) {
  const a = aspect > 0 ? aspect : 16 / 9;
  w = clamp(w, 8, MAP_W);
  let h = w / a;
  if (h > MAP_H) { h = MAP_H; w = Math.min(MAP_W, h * a); }
  return { cx: clamp(cx, w / 2, MAP_W - w / 2), cy: clamp(cy, h / 2, MAP_H - h / 2), w, h };
}

/** The view showing both ends of a journey with room round them (and for the HUD below). */
export function frameRoute(from, to, aspect) {
  const a = aspect > 0 ? aspect : 16 / 9;
  const dx = Math.abs(to.x - from.x), dy = Math.abs(to.y - from.y);
  const margin = 1.5;
  const w = Math.max(MIN_VIEW_W, dx * margin + 24, (dy * margin + 24) * a);
  return fitView((from.x + to.x) / 2 + 0.5, (from.y + to.y) / 2 + 0.5 + w / a * 0.06, w, a);
}

/** Close view round one map pixel. */
export const closeView = (p, aspect) => fitView(p.x + 0.5, p.y + 0.5, CLOSE_VIEW_W, aspect);

/** Interpolate two views; the width moves geometrically so the zoom feels even. */
export function lerpView(a, b, t, aspect) {
  const s = clamp(t, 0, 1);
  const w = a.w * Math.pow(b.w / a.w, s);
  return fitView(a.cx + (b.cx - a.cx) * s, a.cy + (b.cy - a.cy) * s, w, aspect);
}

export const smooth = (t) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

/**
 * The journey's timeline over `ms`: zoom out from the origin, ride the route, settle on the
 * destination. Under reduced motion the view does not move; only the traveller advances.
 * @returns {{zoomOut:number, travel:number, settle:number, progress:number, done:boolean}} each in [0,1]
 */
export function timelineAt(elapsed, ms, { reducedMotion = false } = {}) {
  const total = Math.max(1, ms);
  const t = clamp(elapsed / total, 0, 1);
  if (reducedMotion) return { zoomOut: 1, travel: t, settle: 0, progress: t, done: elapsed >= total };
  const A = 0.18, B = 0.88; // zoom out until A, travel until B, settle to the end
  const zoomOut = smooth(t / A);
  const travel = t <= A ? 0 : t >= B ? 1 : (t - A) / (B - A);
  const settle = t <= B ? 0 : smooth((t - B) / (1 - B));
  return { zoomOut, travel, settle, progress: travel, done: elapsed >= total };
}

/** Days on the road shown for progress `f` of a journey of `days`. */
export const dayAt = (f, days) => Math.min(days, Math.max(1, Math.ceil(clamp(f, 0, 1) * days) || 1));

/** Map pixel to canvas pixel for a view drawn over a `cw` x `ch` canvas. */
export function toCanvas(view, cw, ch, x, y) {
  const s = cw / view.w;
  return { x: (x - (view.cx - view.w / 2)) * s, y: (y - (view.cy - view.h / 2)) * s, scale: s };
}
