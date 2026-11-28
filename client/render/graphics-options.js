// Graphics, Classic Retro Video, Lighting, and Post-Processing options for client/render/renderer.js.
// Pure module (DOM-free, WebGL-free) so it can be unit-tested in Node and shared by the renderer and UI.
// All settings here are strictly client-side presentation: server sight, lighting, and collision rules
// remain completely authoritative and unaffected.

export const GRAPHICS_PREFS_KEY = 'daggerfallworld.graphics.v1';

export const RETRO_PRESETS = Object.freeze({
  off: null,
  '320x200': Object.freeze({ width: 320, height: 200, displayAspect: 4 / 3, label: '320×200 (DOS VGA)' }),
  '640x400': Object.freeze({ width: 640, height: 400, displayAspect: 4 / 3, label: '640×400 (Hi-Res VGA)' }),
});

export const TEXTURE_FILTER_MODES = Object.freeze(['nearest', 'bilinear', 'trilinear']);
export const RETRO_PALETTE_MODES = Object.freeze(['off', 'vga256', 'posterize6', 'daggerfall']);
export const RETRO_DITHER_MODES = Object.freeze(['off', 'bayer4']);
/** Outdoor sky: the classic panorama set into the atmospheric dome, or the classic panorama alone. */
export const SKY_STYLES = Object.freeze(['hybrid', 'classic']);

export const DEFAULT_GRAPHICS = Object.freeze({
  // Resolution & performance
  qualityPreset: 'high',
  fov: 70, // degrees (50..110)
  renderScale: 1.0, // 0.35..2.0
  outdoorViewDistance: 2400, // metres (600..3600)
  textureFiltering: 'nearest', // 'nearest' | 'bilinear' | 'trilinear'
  skyStyle: 'hybrid', // 'hybrid' (classic SKY panorama + atmosphere, moons, stars) | 'classic' (the panorama alone)

  // Classic retro video
  retroMode: 'off', // 'off' | '320x200' | '640x400'
  retroNearest: true,
  retroAspectCorrection: true, // 4:3 CRT aspect for 320x200 / 640x400
  retroPalette: 'off', // 'off' | 'vga256' | 'posterize6' | 'daggerfall'
  retroDither: 'off', // 'off' | 'bayer4'
  retroScanlines: 0, // 0..0.45

  // Lighting & post-processing
  lightingPreset: 'classic',
  ambientLight: 1.0, // 0.2..1.6
  dynamicShadows: true,
  dynamicLights: true,
  spellLightBoost: 1.0, // 0.5..2.2
  antialias: true,
  postProcessing: true,
  bloom: 0.12, // 0..1
  vignette: 0.12, // 0..0.6
});

export const QUALITY_PRESETS = Object.freeze({
  classic: Object.freeze({
    qualityPreset: 'classic',
    renderScale: 1.0,
    outdoorViewDistance: 1600,
    textureFiltering: 'nearest',
    retroMode: '320x200',
    retroNearest: true,
    retroAspectCorrection: true,
    retroPalette: 'vga256',
    retroDither: 'bayer4',
    retroScanlines: 0.12,
    antialias: false,
    postProcessing: true,
    bloom: 0,
    vignette: 0.08,
  }),
  low: Object.freeze({
    qualityPreset: 'low',
    renderScale: 0.65,
    outdoorViewDistance: 1000,
    textureFiltering: 'nearest',
    retroMode: 'off',
    retroPalette: 'off',
    retroDither: 'off',
    retroScanlines: 0,
    dynamicShadows: false,
    dynamicLights: false,
    antialias: false,
    postProcessing: false,
    bloom: 0,
    vignette: 0,
  }),
  medium: Object.freeze({
    qualityPreset: 'medium',
    renderScale: 0.85,
    outdoorViewDistance: 1800,
    textureFiltering: 'bilinear',
    retroMode: 'off',
    retroPalette: 'off',
    retroDither: 'off',
    retroScanlines: 0,
    dynamicShadows: true,
    dynamicLights: true,
    antialias: false,
    postProcessing: true,
    bloom: 0.08,
    vignette: 0.1,
  }),
  high: Object.freeze({
    qualityPreset: 'high',
    renderScale: 1.0,
    outdoorViewDistance: 2400,
    textureFiltering: 'nearest',
    retroMode: 'off',
    retroPalette: 'off',
    retroDither: 'off',
    retroScanlines: 0,
    dynamicShadows: true,
    dynamicLights: true,
    antialias: true,
    postProcessing: true,
    bloom: 0.12,
    vignette: 0.12,
  }),
  ultra: Object.freeze({
    qualityPreset: 'ultra',
    renderScale: 1.25,
    outdoorViewDistance: 3400,
    textureFiltering: 'trilinear',
    retroMode: 'off',
    retroPalette: 'off',
    retroDither: 'off',
    retroScanlines: 0,
    dynamicShadows: true,
    dynamicLights: true,
    antialias: true,
    postProcessing: true,
    bloom: 0.22,
    vignette: 0.16,
  }),
});

export const LIGHTING_PRESETS = Object.freeze({
  classic: Object.freeze({
    lightingPreset: 'classic',
    ambientLight: 1.0,
    dynamicShadows: true,
    dynamicLights: true,
    spellLightBoost: 1.0,
    bloom: 0.12,
    vignette: 0.12,
  }),
  'dark-dungeons': Object.freeze({
    lightingPreset: 'dark-dungeons',
    ambientLight: 0.55,
    dynamicShadows: true,
    dynamicLights: true,
    spellLightBoost: 1.45,
    bloom: 0.18,
    vignette: 0.34,
  }),
  bright: Object.freeze({
    lightingPreset: 'bright',
    ambientLight: 1.38,
    dynamicShadows: false,
    dynamicLights: true,
    spellLightBoost: 1.35,
    bloom: 0.06,
    vignette: 0.0,
  }),
  atmospheric: Object.freeze({
    lightingPreset: 'atmospheric',
    ambientLight: 0.85,
    dynamicShadows: true,
    dynamicLights: true,
    spellLightBoost: 1.6,
    bloom: 0.28,
    vignette: 0.24,
  }),
});

const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export function normalizeGraphicsOptions(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const retroMode = Object.hasOwn(RETRO_PRESETS, r.retroMode) ? r.retroMode : DEFAULT_GRAPHICS.retroMode;
  const textureFiltering = TEXTURE_FILTER_MODES.includes(r.textureFiltering)
    ? r.textureFiltering
    : DEFAULT_GRAPHICS.textureFiltering;
  const retroPalette = RETRO_PALETTE_MODES.includes(r.retroPalette)
    ? r.retroPalette
    : DEFAULT_GRAPHICS.retroPalette;
  const retroDither = RETRO_DITHER_MODES.includes(r.retroDither)
    ? r.retroDither
    : DEFAULT_GRAPHICS.retroDither;
  const qualityPreset = typeof r.qualityPreset === 'string' && (r.qualityPreset === 'custom' || Object.hasOwn(QUALITY_PRESETS, r.qualityPreset))
    ? r.qualityPreset
    : DEFAULT_GRAPHICS.qualityPreset;
  const lightingPreset = typeof r.lightingPreset === 'string' && (r.lightingPreset === 'custom' || Object.hasOwn(LIGHTING_PRESETS, r.lightingPreset))
    ? r.lightingPreset
    : DEFAULT_GRAPHICS.lightingPreset;

  return {
    qualityPreset,
    fov: clamp(r.fov, 50, 110, DEFAULT_GRAPHICS.fov),
    renderScale: clamp(r.renderScale, 0.35, 2.0, DEFAULT_GRAPHICS.renderScale),
    outdoorViewDistance: clamp(r.outdoorViewDistance, 600, 3600, DEFAULT_GRAPHICS.outdoorViewDistance),
    textureFiltering,
    skyStyle: SKY_STYLES.includes(r.skyStyle) ? r.skyStyle : DEFAULT_GRAPHICS.skyStyle,

    retroMode,
    retroNearest: r.retroNearest !== false,
    retroAspectCorrection: r.retroAspectCorrection !== false,
    retroPalette,
    retroDither,
    retroScanlines: clamp(r.retroScanlines, 0, 0.45, DEFAULT_GRAPHICS.retroScanlines),

    lightingPreset,
    ambientLight: clamp(r.ambientLight, 0.2, 1.6, DEFAULT_GRAPHICS.ambientLight),
    dynamicShadows: r.dynamicShadows !== false,
    dynamicLights: r.dynamicLights !== false,
    spellLightBoost: clamp(r.spellLightBoost, 0.5, 2.2, DEFAULT_GRAPHICS.spellLightBoost),
    antialias: r.antialias !== false,
    postProcessing: r.postProcessing !== false,
    bloom: clamp(r.bloom, 0, 1, DEFAULT_GRAPHICS.bloom),
    vignette: clamp(r.vignette, 0, 0.6, DEFAULT_GRAPHICS.vignette),
  };
}

export function applyQualityPreset(current, presetName) {
  const preset = QUALITY_PRESETS[presetName];
  if (!preset) return normalizeGraphicsOptions(current);
  return normalizeGraphicsOptions({ ...current, ...preset });
}

export function applyLightingPreset(current, presetName) {
  const preset = LIGHTING_PRESETS[presetName];
  if (!preset) return normalizeGraphicsOptions(current);
  return normalizeGraphicsOptions({ ...current, ...preset });
}

export function loadGraphicsOptions(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem?.(GRAPHICS_PREFS_KEY);
    return normalizeGraphicsOptions(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeGraphicsOptions(null);
  }
}

export function saveGraphicsOptions(opts, storage = globalThis.localStorage) {
  const clean = normalizeGraphicsOptions(opts);
  try {
    storage?.setItem?.(GRAPHICS_PREFS_KEY, JSON.stringify(clean));
  } catch { /* storage disabled or quota full */ }
  return clean;
}

/**
 * Whether the offscreen framebuffer / post-processing blit path is required.
 * When false, the renderer draws straight to the default backbuffer with zero extra pass cost.
 */
export function needsOffscreenPass(opts) {
  const g = normalizeGraphicsOptions(opts);
  if (g.retroMode !== 'off') return true;
  if (g.retroPalette !== 'off' || g.retroDither !== 'off' || g.retroScanlines > 0.001) return true;
  if (Math.abs(g.renderScale - 1.0) > 0.005) return true;
  if (g.postProcessing && (g.bloom > 0.005 || g.vignette > 0.005 || g.antialias)) return true;
  return false;
}

/**
 * Computes canvas backing dimensions, offscreen framebuffer resolution, projection aspect,
 * and final destination viewport (with optional 4:3 pillarbox/letterbox for Classic Retro Video).
 */
export function computeViewport(clientWidth, clientHeight, dpr = 1, opts = DEFAULT_GRAPHICS) {
  const g = normalizeGraphicsOptions(opts);
  const cssW = Math.max(1, Math.round(Number(clientWidth) || 1));
  const cssH = Math.max(1, Math.round(Number(clientHeight) || 1));
  const clampedDpr = Math.min(Math.max(1, Number(dpr) || 1), 2);
  const canvasW = Math.max(1, Math.round(cssW * clampedDpr));
  const canvasH = Math.max(1, Math.round(cssH * clampedDpr));
  const retro = RETRO_PRESETS[g.retroMode];

  if (retro) {
    const fbW = retro.width;
    const fbH = retro.height;
    const targetAspect = g.retroAspectCorrection ? retro.displayAspect : fbW / fbH;
    const canvasAspect = canvasW / canvasH;
    let dstW = canvasW;
    let dstH = canvasH;
    let dstX = 0;
    let dstY = 0;
    if (g.retroAspectCorrection) {
      if (canvasAspect > targetAspect) {
        dstW = Math.max(1, Math.round(canvasH * targetAspect));
        dstX = Math.floor((canvasW - dstW) / 2);
      } else if (canvasAspect < targetAspect) {
        dstH = Math.max(1, Math.round(canvasW / targetAspect));
        dstY = Math.floor((canvasH - dstH) / 2);
      }
    }
    return {
      canvasW,
      canvasH,
      fbW,
      fbH,
      aspect: targetAspect,
      retro: true,
      dst: { x: dstX, y: dstY, w: dstW, h: dstH },
    };
  }

  const fbW = Math.max(64, Math.round(canvasW * g.renderScale));
  const fbH = Math.max(64, Math.round(canvasH * g.renderScale));
  return {
    canvasW,
    canvasH,
    fbW,
    fbH,
    aspect: canvasW / canvasH,
    retro: false,
    dst: { x: 0, y: 0, w: canvasW, h: canvasH },
  };
}

/** Classic 256-color VGA palette (16 EGA + 216 6x6x6 RGB cube + 24 grayscale ramp) as 256*3 Uint8Array. */
export function buildVgaPalette() {
  const pal = new Uint8Array(256 * 3);
  const ega = [
    [0, 0, 0], [0, 0, 170], [0, 170, 0], [0, 170, 170],
    [170, 0, 0], [170, 0, 170], [170, 85, 0], [170, 170, 170],
    [85, 85, 85], [85, 85, 255], [85, 255, 85], [85, 255, 255],
    [255, 85, 85], [255, 85, 255], [255, 255, 85], [255, 255, 255],
  ];
  let idx = 0;
  for (const [r, g, b] of ega) {
    pal[idx++] = r; pal[idx++] = g; pal[idx++] = b;
  }
  const steps = [0, 51, 102, 153, 204, 255];
  for (const r of steps) {
    for (const g of steps) {
      for (const b of steps) {
        pal[idx++] = r; pal[idx++] = g; pal[idx++] = b;
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = Math.round(8 + i * 10);
    pal[idx++] = v; pal[idx++] = v; pal[idx++] = v;
  }
  return pal;
}

/** Nearest color quantization in the 256-color VGA palette (used by tests & CPU previews). */
export function quantizeRgbVga(r, g, b, palette = null) {
  const pal = palette ?? buildVgaPalette();
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < 256; i++) {
    const o = i * 3;
    const dr = r - pal[o];
    const dg = g - pal[o + 1];
    const db = b - pal[o + 2];
    const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
    if (d < bestDist) {
      bestDist = d;
      best = o;
    }
  }
  return [pal[best], pal[best + 1], pal[best + 2]];
}
