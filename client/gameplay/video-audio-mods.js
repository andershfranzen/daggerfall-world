// Video, Classic Retro, Lighting, Custom Audio Sources, Local Asset Overrides & Server Mods panel.
//
// Registers cleanly through `api.registerPanel` and `api.on('panel', ...)` without editing shell.js.
// Exposes `api.videoAudioMods` for programmatic access and verification.

import {
  DEFAULT_GRAPHICS, QUALITY_PRESETS, LIGHTING_PRESETS, RETRO_PRESETS,
  normalizeGraphicsOptions, applyQualityPreset, applyLightingPreset,
  loadGraphicsOptions, saveGraphicsOptions,
} from '../render/graphics-options.js';
import {
  AudioSourceManager, AUDIO_SCENE_KEYS, BUILTIN_SOUNDFONT_PROFILES,
} from './atmosphere/audio-sources.js';
import {
  AssetOverrideManager, SAMPLE_OVERRIDE_PACK, collisionFingerprint,
} from '../lib/asset-overrides.js';

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function loadCss() {
  if (typeof document === 'undefined') return;
  if (document.querySelector('link[data-feature="video-audio-mods"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./video-audio-mods.css', import.meta.url).href;
  link.dataset.feature = 'video-audio-mods';
  document.head.append(link);
}

/**
 * Pure controller shared by browser UI and Node tests.
 */
export function createVideoAudioModsController(api, { storage = null } = {}) {
  const store = storage ?? (() => { try { return globalThis.localStorage; } catch { return null; } })();
  let graphics = loadGraphicsOptions(store);
  const audioSources = new AudioSourceManager({ storage: store });
  const assetOverrides = new AssetOverrideManager({ storage: store, preloadSample: true });
  let serverMods = null;
  let lastCollisionCheck = null;
  let spellFlash = 0;

  function syncRenderer() {
    if (api?.renderer?.setGraphicsOptions) {
      graphics = api.renderer.setGraphicsOptions(graphics, { persist: true });
    } else {
      graphics = saveGraphicsOptions(graphics, store);
    }
    return { ...graphics };
  }

  function setGraphics(patch) {
    graphics = normalizeGraphicsOptions({ ...graphics, ...(patch || {}) });
    if (!patch || !('qualityPreset' in patch)) {
      if (patch && ('renderScale' in patch || 'outdoorViewDistance' in patch || 'textureFiltering' in patch || 'retroMode' in patch)) {
        graphics.qualityPreset = 'custom';
      }
    }
    if (!patch || !('lightingPreset' in patch)) {
      if (patch && ('ambientLight' in patch || 'dynamicShadows' in patch || 'dynamicLights' in patch || 'spellLightBoost' in patch)) {
        graphics.lightingPreset = 'custom';
      }
    }
    return syncRenderer();
  }

  function setQualityPreset(name) {
    graphics = applyQualityPreset(graphics, name);
    return syncRenderer();
  }

  function setLightingPreset(name) {
    graphics = applyLightingPreset(graphics, name);
    return syncRenderer();
  }

  function setRetroMode(mode, { palette = null, dither = null, aspectCorrection = true } = {}) {
    const patch = { retroMode: mode, retroAspectCorrection: aspectCorrection };
    if (mode !== 'off') {
      patch.retroNearest = true;
      patch.retroPalette = palette ?? (graphics.retroPalette === 'off' ? 'vga256' : graphics.retroPalette);
      patch.retroDither = dither ?? 'bayer4';
      patch.postProcessing = true;
    } else {
      patch.retroPalette = palette ?? 'off';
      patch.retroDither = dither ?? 'off';
    }
    return setGraphics(patch);
  }

  function resetGraphics() {
    graphics = { ...DEFAULT_GRAPHICS };
    return syncRenderer();
  }

  function applyOverridesNow(doc = globalThis.document) {
    assetOverrides.applyUiOverrides(doc);
    if (api?.town) {
      lastCollisionCheck = assetOverrides.applyToMesh(api.town, api.renderer);
    }
    return lastCollisionCheck;
  }

  function attachAudioEngine() {
    const engine = api?.atmosphere?.engine;
    if (engine && audioSources.engine !== engine) {
      audioSources.attachEngine(engine);
    }
  }

  function refreshServerMods() {
    if (typeof api?.act !== 'function') return Promise.resolve(null);
    const res = api.act('mods.list', {}, { quiet: true });
    if (!res || typeof res.then !== 'function') return Promise.resolve(null);
    return res.then((r) => r);
  }

  // Hook into api lifecycle events
  api?.on?.('event', (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'modsList') {
      serverMods = ev;
      api.emit?.('videoAudioModsChange', { kind: 'mods' });
    } else if (ev.kind === 'spellCast' || ev.kind === 'magicCast') {
      spellFlash = 1.0;
    }
  });

  api?.on?.('scene', (mesh) => {
    syncRenderer();
    if (mesh) lastCollisionCheck = assetOverrides.applyToMesh(mesh, api.renderer);
    attachAudioEngine();
  });

  api?.on?.('location', () => {
    attachAudioEngine();
    const info = api?.atmosphere?.now?.();
    if (info?.kind) audioSources.setScene(info.kind);
  });

  api?.on?.('frame', (f = {}) => {
    attachAudioEngine();
    const renderer = f.renderer ?? api.renderer;
    const cam = f.camera ?? api.camera;
    const dt = Math.min(0.1, Number(f.dt) || 0.016);
    if (spellFlash > 0) spellFlash = Math.max(0, spellFlash - dt * 1.6);

    const info = api?.atmosphere?.now?.();
    if (info?.kind) audioSources.setScene(info.kind);

    if (renderer?.setDynamicLight && cam) {
      const heldRadius = Number(info?.lightRadius) || 0;
      const inDark = info?.kind === 'dungeon' || info?.night;
      const hasLight = heldRadius > 0 || spellFlash > 0.05;
      if (hasLight) {
        const radius = Math.max(heldRadius, spellFlash > 0.05 ? 14 : 0);
        const isSpell = spellFlash > 0.15;
        const color = isSpell ? [0.68, 0.85, 1.0] : [1.0, 0.78, 0.48];
        const intensity = (inDark ? 0.92 : 0.32) + spellFlash * 0.55;
        renderer.setDynamicLight({ pos: [cam.x, cam.y, cam.z], color, radius, intensity });
      } else {
        renderer.setDynamicLight({ pos: [cam.x, cam.y, cam.z], radius: 0, intensity: 0 });
      }
    }
  });

  return {
    getGraphics: () => ({ ...graphics }),
    setGraphics,
    setQualityPreset,
    setLightingPreset,
    setRetroMode,
    resetGraphics,
    audioSources,
    assetOverrides,
    applyOverridesNow,
    refreshServerMods,
    getServerMods: () => serverMods,
    getLastCollisionCheck: () => lastCollisionCheck,
    syncRenderer,
  };
}

export function install(api) {
  if (typeof document === 'undefined') return;
  loadCss();

  const ctrl = createVideoAudioModsController(api);
  ctrl.syncRenderer();
  ctrl.applyOverridesNow(document);

  let activeTab = 'graphics'; // 'graphics' | 'audio' | 'mods'
  let panelContainer = null;
  let statusLine = '';
  let selectedAudioScene = 'town_day';

  const setStatus = (msg) => {
    statusLine = msg || '';
    if (panelContainer?.isConnected) {
      const st = panelContainer.querySelector('.vam-status');
      if (st) st.textContent = statusLine;
    }
  };

  function renderTelemetry(g) {
    const perf = api.renderer?.perfStats?.() ?? { fps: 60, avgFrameMs: 16.6, fbWidth: 1280, fbHeight: 800, drawCalls: 0 };
    const retroTag = g.retroMode !== 'off'
      ? `Retro ${g.retroMode}${g.retroAspectCorrection ? ' (4:3)' : ''}${g.retroPalette !== 'off' ? ` · ${g.retroPalette.toUpperCase()}` : ''}`
      : `Native ${perf.fbWidth}×${perf.fbHeight}`;
    return el('div', { class: 'vam-telemetry', 'data-testid': 'vam-telemetry' },
      el('span', {}, 'Render: ', el('strong', { text: retroTag })),
      el('span', {}, 'Frame: ', el('strong', { text: `${perf.avgFrameMs} ms (${perf.fps} FPS)` })),
      el('span', {}, 'Draws: ', el('strong', { text: String(perf.drawCalls) })),
      el('span', { class: 'vam-badge', title: 'Server sight, lighting rules, and collision geometry are never altered by client quality settings.' }, 'Server Collision & Sight: Authoritative'),
    );
  }

  function rangeControl(id, label, min, max, step, value, fmt, onChange) {
    const out = el('output', { for: id, text: fmt(value) });
    const inp = el('input', {
      id, type: 'range', min: String(min), max: String(max), step: String(step), value: String(value),
      oninput: (e) => {
        const v = Number(e.target.value);
        out.textContent = fmt(v);
        onChange(v, false);
      },
      onchange: (e) => {
        onChange(Number(e.target.value), true);
      },
    });
    return el('div', { class: 'vam-row' },
      el('label', { for: id, text: label }),
      el('div', { class: 'vam-range-wrap' }, inp, out),
    );
  }

  function renderGraphicsTab() {
    const g = ctrl.getGraphics();

    const qualityCard = el('section', { class: 'vam-card', 'aria-labelledby': 'vam-h-perf' },
      el('h4', { id: 'vam-h-perf', text: 'Resolution & Performance' }),
      el('div', { class: 'vam-presets', role: 'group', 'aria-label': 'Graphics quality presets' },
        ...Object.keys(QUALITY_PRESETS).map((k) => el('button', {
          type: 'button',
          class: 'vam-preset-btn',
          'aria-pressed': String(g.qualityPreset === k),
          text: k[0].toUpperCase() + k.slice(1),
          onclick: () => { ctrl.setQualityPreset(k); setStatus(`Applied ${k} quality preset.`); renderPanel(); },
        })),
      ),
      rangeControl('vam-fov', 'Field of View', 50, 110, 1, g.fov, (v) => `${Math.round(v)}°`, (v) => ctrl.setGraphics({ fov: v })),
      rangeControl('vam-scale', 'Render Scale', 0.35, 2.0, 0.05, g.renderScale, (v) => `${Math.round(v * 100)}%`, (v) => ctrl.setGraphics({ renderScale: v })),
      rangeControl('vam-viewdist', 'Outdoor View Distance', 600, 3600, 100, g.outdoorViewDistance, (v) => `${Math.round(v)} m`, (v) => ctrl.setGraphics({ outdoorViewDistance: v })),
      el('div', { class: 'vam-row' },
        el('label', { for: 'vam-filter', text: 'Texture Filtering' }),
        el('select', {
          id: 'vam-filter', class: 'vam-select',
          onchange: (e) => { ctrl.setGraphics({ textureFiltering: e.target.value }); setStatus(`Texture filtering: ${e.target.value}.`); },
        },
        el('option', { value: 'nearest', selected: g.textureFiltering === 'nearest', text: 'Nearest (Classic crisp)' }),
        el('option', { value: 'bilinear', selected: g.textureFiltering === 'bilinear', text: 'Bilinear (Smooth)' }),
        el('option', { value: 'trilinear', selected: g.textureFiltering === 'trilinear', text: 'Trilinear + Anisotropic' }),
        ),
      ),
      el('div', { class: 'vam-row' },
        el('label', { for: 'vam-sky', text: 'Sky' }),
        el('select', {
          id: 'vam-sky', class: 'vam-select',
          onchange: (e) => { ctrl.setGraphics({ skyStyle: e.target.value }); setStatus(e.target.value === 'classic' ? 'Sky: the classic panorama alone.' : 'Sky: classic panorama with atmosphere, moons and stars.'); },
        },
        el('option', { value: 'hybrid', selected: g.skyStyle !== 'classic', text: 'Hybrid (Classic panorama + atmosphere)' }),
        el('option', { value: 'classic', selected: g.skyStyle === 'classic', text: 'Classic (Panorama only)' }),
        ),
      ),
      el('div', { class: 'vam-actions' },
        el('button', { type: 'button', class: 'btn btn-small', text: 'Reset Graphics Defaults', onclick: () => { ctrl.resetGraphics(); setStatus('Graphics reset to defaults.'); renderPanel(); } }),
      ),
    );

    const retroCard = el('section', { class: 'vam-card', 'aria-labelledby': 'vam-h-retro' },
      el('h4', { id: 'vam-h-retro', text: 'Classic Retro Video' }),
      el('div', { class: 'vam-presets', role: 'group', 'aria-label': 'Retro framebuffer resolution' },
        ...Object.entries(RETRO_PRESETS).map(([k, spec]) => el('button', {
          type: 'button',
          class: 'vam-preset-btn',
          'data-retro-preset': k,
          'aria-pressed': String(g.retroMode === k),
          text: spec ? spec.label : 'Off (Native)',
          onclick: () => { ctrl.setRetroMode(k); setStatus(k === 'off' ? 'Retro mode disabled.' : `Classic retro ${k} VGA mode active.`); renderPanel(); },
        })),
      ),
      el('label', { class: 'vam-check' },
        el('input', { type: 'checkbox', checked: g.retroNearest, onchange: (e) => ctrl.setGraphics({ retroNearest: e.target.checked }) }),
        ' Nearest-neighbor pixel scaling',
      ),
      el('label', { class: 'vam-check' },
        el('input', { type: 'checkbox', checked: g.retroAspectCorrection, onchange: (e) => ctrl.setGraphics({ retroAspectCorrection: e.target.checked }) }),
        ' 4:3 CRT aspect correction (non-square DOS pixels)',
      ),
      el('div', { class: 'vam-row' },
        el('label', { for: 'vam-palette', text: 'VGA Palette Quantization' }),
        el('select', {
          id: 'vam-palette', class: 'vam-select',
          onchange: (e) => { ctrl.setGraphics({ retroPalette: e.target.value }); setStatus(`Retro palette: ${e.target.value}.`); renderPanel(); },
        },
        el('option', { value: 'off', selected: g.retroPalette === 'off', text: 'Off (Truecolor)' }),
        el('option', { value: 'vga256', selected: g.retroPalette === 'vga256', text: 'Classic VGA 256-Color' }),
        el('option', { value: 'posterize6', selected: g.retroPalette === 'posterize6', text: '6-bit VGA DAC (RGB666)' }),
        el('option', { value: 'daggerfall', selected: g.retroPalette === 'daggerfall', text: 'Daggerfall Warm VGA Ramp' }),
        ),
      ),
      el('label', { class: 'vam-check' },
        el('input', {
          type: 'checkbox',
          checked: g.retroDither === 'bayer4',
          onchange: (e) => ctrl.setGraphics({ retroDither: e.target.checked ? 'bayer4' : 'off' }),
        }),
        ' Bayer 4×4 ordered dithering',
      ),
      rangeControl('vam-scanlines', 'CRT Scanlines', 0, 0.45, 0.05, g.retroScanlines, (v) => `${Math.round(v * 100)}%`, (v) => ctrl.setGraphics({ retroScanlines: v })),
    );

    const lightingCard = el('section', { class: 'vam-card', 'aria-labelledby': 'vam-h-light' },
      el('h4', { id: 'vam-h-light', text: 'Lighting & Post-Processing' }),
      el('div', { class: 'vam-presets', role: 'group', 'aria-label': 'Lighting presets' },
        ...Object.keys(LIGHTING_PRESETS).map((k) => el('button', {
          type: 'button',
          class: 'vam-preset-btn',
          'aria-pressed': String(g.lightingPreset === k),
          text: k.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          onclick: () => { ctrl.setLightingPreset(k); setStatus(`Lighting preset: ${k}.`); renderPanel(); },
        })),
      ),
      rangeControl('vam-ambient', 'Ambient Light', 0.2, 1.6, 0.05, g.ambientLight, (v) => `${Math.round(v * 100)}%`, (v) => ctrl.setGraphics({ ambientLight: v })),
      rangeControl('vam-spellboost', 'Torch & Spell Light Boost', 0.5, 2.2, 0.05, g.spellLightBoost, (v) => `${Math.round(v * 100)}%`, (v) => ctrl.setGraphics({ spellLightBoost: v })),
      el('label', { class: 'vam-check' },
        el('input', { type: 'checkbox', checked: g.dynamicShadows, onchange: (e) => ctrl.setGraphics({ dynamicShadows: e.target.checked }) }),
        ' Dynamic directional shading contrast',
      ),
      el('label', { class: 'vam-check' },
        el('input', { type: 'checkbox', checked: g.dynamicLights, onchange: (e) => ctrl.setGraphics({ dynamicLights: e.target.checked }) }),
        ' Dynamic held torch & spell point light',
      ),
      el('label', { class: 'vam-check' },
        el('input', { type: 'checkbox', checked: g.postProcessing, onchange: (e) => ctrl.setGraphics({ postProcessing: e.target.checked }) }),
        ' Post-processing pipeline (Bloom / Vignette / FXAA)',
      ),
      el('label', { class: 'vam-check' },
        el('input', { type: 'checkbox', checked: g.antialias, onchange: (e) => ctrl.setGraphics({ antialias: e.target.checked }) }),
        ' Edge Antialiasing (FXAA, off in Retro mode)',
      ),
      rangeControl('vam-bloom', 'Bloom Glow', 0, 1.0, 0.04, g.bloom, (v) => `${Math.round(v * 100)}%`, (v) => ctrl.setGraphics({ bloom: v })),
      rangeControl('vam-vignette', 'Dungeon Vignette', 0, 0.6, 0.04, g.vignette, (v) => `${Math.round(v * 100)}%`, (v) => ctrl.setGraphics({ vignette: v })),
    );

    return el('div', { class: 'vam-grid' }, qualityCard, retroCard, lightingCard);
  }

  function renderAudioSourcesTab() {
    const st = ctrl.audioSources.status();
    const sfInput = el('input', {
      type: 'file', class: 'vam-file-input', accept: '.sf2,.json',
      onchange: async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          if (/\.sf2$/i.test(file.name)) {
            const buf = await file.arrayBuffer();
            ctrl.audioSources.loadSoundfont(buf, file.name);
          } else {
            ctrl.audioSources.loadSoundfont(await file.text(), file.name);
          }
          setStatus(`Loaded custom soundfont: ${file.name}`);
          renderPanel();
        } catch (err) {
          setStatus(`Soundfont error: ${err.message}`);
        }
      },
    });

    const trackInput = el('input', {
      type: 'file', class: 'vam-file-input', accept: 'audio/*,.ogg,.mp3,.wav,.flac,.webm',
      onchange: async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          await ctrl.audioSources.loadCustomTrack(selectedAudioScene, file, { name: file.name });
          setStatus(`Loaded custom ${selectedAudioScene} track: ${file.name}`);
          renderPanel();
        } catch (err) {
          setStatus(`Custom track error: ${err.message}`);
        }
      },
    });

    const sfCard = el('section', { class: 'vam-card', 'aria-labelledby': 'vam-h-sf' },
      el('h4', { id: 'vam-h-sf', text: 'Instrument Bank / SoundFont' }),
      el('p', { class: 'vam-note' },
        'Active audio source: ',
        el('span', { class: `vam-badge ${st.classicActive ? 'is-classic' : ''}` },
          st.classicActive ? 'Classic FM Synth' : (st.soundfont ? st.soundfont.name : 'Custom Local Tracks')),
      ),
      el('div', { class: 'vam-presets' },
        ...Object.values(BUILTIN_SOUNDFONT_PROFILES).map((p) => el('button', {
          type: 'button',
          class: 'vam-preset-btn',
          'aria-pressed': String((st.soundfont?.id ?? 'classic') === p.id),
          text: p.name,
          onclick: () => {
            ctrl.audioSources.loadSoundfont(p.id);
            setStatus(`Switched instrument bank to ${p.name}.`);
            renderPanel();
          },
        })),
      ),
      sfInput,
      el('div', { class: 'vam-actions' },
        el('button', { type: 'button', class: 'btn btn-small', text: 'Import Local .SF2 / .JSON Bank', onclick: () => sfInput.click() }),
        el('button', {
          type: 'button', class: 'btn btn-small btn-primary', text: 'Reset to Classic Synth',
          onclick: async () => {
            await ctrl.audioSources.resetToClassic();
            setStatus('Audio cleanly reset to Classic ARENA2 FM Synth.');
            renderPanel();
          },
        }),
      ),
      el('p', { class: 'vam-note', text: 'Soundfonts and custom tracks stay strictly local in this browser and reset cleanly across scene crossings.' }),
    );

    const musicCard = el('section', { class: 'vam-card', 'aria-labelledby': 'vam-h-tracks' },
      el('h4', { id: 'vam-h-tracks', text: 'Custom Local Music Tracks' }),
      el('div', { class: 'vam-row' },
        el('label', { for: 'vam-audio-scene', text: 'Scene target' }),
        el('select', {
          id: 'vam-audio-scene', class: 'vam-select',
          onchange: (e) => { selectedAudioScene = e.target.value; },
        },
        ...AUDIO_SCENE_KEYS.map((k) => el('option', { value: k, selected: selectedAudioScene === k, text: k.replace(/_/g, ' ') }))),
      ),
      trackInput,
      el('div', { class: 'vam-actions' },
        el('button', { type: 'button', class: 'btn btn-small', text: 'Choose Local Audio File', onclick: () => trackInput.click() }),
      ),
      st.tracks.length
        ? el('ul', { class: 'vam-pack-list' }, ...st.tracks.map((t) => el('li', { class: 'vam-pack-item' },
          el('div', { class: 'vam-pack-head' },
            el('strong', { text: `${t.key}: ${t.name}` }),
            el('button', {
              type: 'button', class: 'btn btn-small', text: 'Remove',
              onclick: () => { ctrl.audioSources.removeCustomTrack(t.key); setStatus(`Removed custom track for ${t.key}.`); renderPanel(); },
            }),
          ),
        )))
        : el('p', { class: 'vam-note', text: 'No custom local music files assigned. Classic ARENA2 MIDI.BSA soundtrack is active.' }),
    );

    return el('div', { class: 'vam-grid' }, sfCard, musicCard);
  }

  function renderModsAndAssetsTab() {
    const summary = ctrl.assetOverrides.summary();
    const colCheck = ctrl.getLastCollisionCheck();
    const fp = api.town ? collisionFingerprint(api.town) : 'n/a';

    const packInput = el('input', {
      type: 'file', class: 'vam-file-input', accept: '.json',
      onchange: async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const imported = ctrl.assetOverrides.importBundle(await file.text());
          ctrl.applyOverridesNow(document);
          setStatus(`Imported ${imported.length} local asset override pack(s).`);
          renderPanel();
        } catch (err) {
          setStatus(`Import rejected: ${err.message}`);
        }
      },
    });

    const exportJson = () => {
      try {
        const json = ctrl.assetOverrides.exportAll();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = el('a', { href: url, download: 'daggerfallworld-asset-overrides.json' });
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setStatus('Exported local asset override bundle JSON.');
      } catch (err) {
        setStatus(`Export failed: ${err.message}`);
      }
    };

    const assetCard = el('section', { class: 'vam-card', 'aria-labelledby': 'vam-h-assets' },
      el('h4', { id: 'vam-h-assets', text: 'Local Asset Replacement (Client-Side)' }),
      el('div', { class: 'vam-actions' },
        el('span', { class: 'vam-badge' }, `Collision Intact (${colCheck?.collisionIntact !== false ? 'Verified' : 'Error'})`),
        el('span', { class: 'vam-pack-meta', text: `Fingerprint: ${fp}` }),
      ),
      packInput,
      el('div', { class: 'vam-actions' },
        el('button', { type: 'button', class: 'btn btn-small', text: 'Import Pack JSON', onclick: () => packInput.click() }),
        el('button', { type: 'button', class: 'btn btn-small', text: 'Export Packs', onclick: exportJson }),
        el('button', {
          type: 'button', class: 'btn btn-small', text: 'Reset All Overrides',
          onclick: () => {
            ctrl.assetOverrides.resetAll({ keepSampleDisabled: true });
            ctrl.applyOverridesNow(document);
            setStatus('All local asset overrides reset to classic originals.');
            renderPanel();
          },
        }),
      ),
      el('p', { class: 'vam-note', text: `Precedence: ascending priority, then pack ID (later wins). Active order: ${summary.loadOrder.length ? summary.loadOrder.join(' → ') : 'Classic originals'}.` }),
      el('ul', { class: 'vam-pack-list' }, ...summary.packs.map((p) => el('li', { class: 'vam-pack-item' },
        el('div', { class: 'vam-pack-head' },
          el('label', { class: 'vam-check' },
            el('input', {
              type: 'checkbox',
              checked: p.enabled,
              'data-override-pack': p.id,
              onchange: (e) => {
                ctrl.assetOverrides.setPackEnabled(p.id, e.target.checked);
                ctrl.applyOverridesNow(document);
                setStatus(`${e.target.checked ? 'Enabled' : 'Disabled'} ${p.name}.`);
                renderPanel();
              },
            }),
            el('strong', { text: `${p.name} v${p.version}` }),
          ),
          el('span', { class: 'vam-pack-meta', text: `Priority ${p.priority}` }),
        ),
        el('p', { class: 'vam-note', text: p.description || p.id }),
        el('div', { class: 'vam-pack-meta', text: `Textures: ${p.counts.textures} · Models: ${p.counts.models} · UI: ${p.counts.ui} · Animations: ${p.counts.animations}` }),
      ))),
      summary.conflictCount > 0
        ? el('p', { class: 'vam-badge is-warn', text: `${summary.conflictCount} overlapping key(s) resolved deterministically` })
        : null,
    );

    const mods = ctrl.getServerMods();
    const serverCard = el('section', { class: 'vam-card', 'aria-labelledby': 'vam-h-mods' },
      el('h4', { id: 'vam-h-mods', text: 'Server Mods & Versioned Quest Packs' }),
      el('div', { class: 'vam-actions' },
        el('button', {
          type: 'button', class: 'btn btn-small', text: 'Refresh Server Mod List',
          onclick: () => { ctrl.refreshServerMods(); setStatus('Requested server mod registry report.'); },
        }),
      ),
      mods
        ? el('div', {},
          el('p', { class: 'vam-note', text: `API v${mods.apiVersion} · Active mods: ${mods.loadOrder?.length ?? 0} · Quests: ${mods.counts?.quests ?? 0} · Items: ${mods.counts?.items ?? 0} · Factions: ${mods.counts?.factions ?? 0}` }),
          el('ul', { class: 'vam-pack-list' }, ...(mods.registered ?? []).map((m) => el('li', { class: 'vam-pack-item' },
            el('div', { class: 'vam-pack-head' },
              el('strong', { text: `${m.name} v${m.version}` }),
              el('span', { class: `vam-badge ${m.enabled ? '' : 'is-warn'}`, text: m.enabled ? 'Enabled' : 'Disabled' }),
            ),
            el('div', { class: 'vam-pack-meta', text: `Categories: ${(m.categories ?? []).join(', ') || 'none'} · Priority ${m.priority}` }),
          ))),
        )
        : el('p', { class: 'vam-note', text: 'Operator-managed quest packs & content mods (assets, world, quests, items, factions, services) are validated server-side. Click Refresh when connected.' }),
    );

    return el('div', { class: 'vam-grid' }, assetCard, serverCard);
  }

  function renderPanel(container = panelContainer) {
    panelContainer = container;
    if (!panelContainer) return;
    const g = ctrl.getGraphics();
    const tabs = [
      ['graphics', 'Graphics, Retro & Lighting'],
      ['audio', 'Audio Sources & SoundFont'],
      ['mods', 'Asset Overrides & Mods'],
    ];
    panelContainer.replaceChildren(
      el('div', { class: 'vam-panel' },
        renderTelemetry(g),
        el('nav', { class: 'vam-subnav', role: 'tablist', 'aria-label': 'Video, Audio, and Mods sections' },
          ...tabs.map(([id, label]) => el('button', {
            type: 'button',
            role: 'tab',
            'aria-selected': String(activeTab === id),
            'data-vam-tab': id,
            text: label,
            onclick: () => { activeTab = id; renderPanel(); },
          })),
        ),
        activeTab === 'graphics'
          ? renderGraphicsTab()
          : activeTab === 'audio'
            ? renderAudioSourcesTab()
            : renderModsAndAssetsTab(),
        el('p', { class: 'vam-status', role: 'status', 'aria-live': 'polite', text: statusLine }),
      ),
    );
  }

  // Register dedicated panel through gameplay API (never edits shell.js).
  api.registerPanel('graphics', 'Video & Mods', (container) => renderPanel(container), { key: 'F9', watch: 'none' });

  // Inject clean sub-controls into Settings and Sound panels when opened (without editing shell.js or atmosphere.js).
  function enhanceOpenPanel(id) {
    const host = document.getElementById('menu-panel');
    if (!host) return;
    if (id === 'settings') {
      const grid = host.querySelector('.settings-grid');
      if (!grid || grid.querySelector('.vam-quick-card')) return;
      const g = ctrl.getGraphics();
      grid.append(el('section', { class: 'settings-card vam-quick-card', 'aria-labelledby': 'settings-h-vam' },
        el('h4', { id: 'settings-h-vam', text: 'Graphics, Retro Video & Mods' }),
        el('p', { class: 'settings-note', text: `Preset: ${g.qualityPreset} · Retro: ${g.retroMode} · Lighting: ${g.lightingPreset} · FOV ${g.fov}°` }),
        el('div', { class: 'menu-actions' },
          el('button', {
            type: 'button', class: 'btn btn-small btn-primary', text: 'Open Video, Audio & Mods',
            onclick: () => api.openPanel('graphics'),
          }),
          el('button', {
            type: 'button', class: 'btn btn-small',
            text: g.retroMode === '320x200' ? 'Disable 320×200 Retro' : 'Classic 320×200 VGA',
            onclick: () => {
              ctrl.setRetroMode(g.retroMode === '320x200' ? 'off' : '320x200');
              api.refreshPanel('settings');
            },
          }),
        ),
      ));
    } else if (id === 'audio') {
      const box = host.querySelector('.atmo-audio');
      if (!box || box.querySelector('.vam-quick-card')) return;
      const st = ctrl.audioSources.status();
      box.append(el('section', { class: 'vam-card vam-quick-card' },
        el('h4', { text: 'Custom SoundFont & Alternate Music' }),
        el('p', { class: 'vam-note', text: st.classicActive ? 'Active: Classic ARENA2 FM Synth' : `Active: ${st.soundfont?.name ?? 'Custom Local Audio'}` }),
        el('div', { class: 'vam-actions' },
          el('button', {
            type: 'button', class: 'btn btn-small', text: 'Configure Custom Audio Sources',
            onclick: () => { activeTab = 'audio'; api.openPanel('graphics'); },
          }),
          el('button', {
            type: 'button', class: 'btn btn-small', text: 'Reset to Classic Synth',
            onclick: async () => { await ctrl.audioSources.resetToClassic(); api.refreshPanel('audio'); },
          }),
        ),
      ));
    }
  }

  api.on('panel', (detail) => {
    const id = typeof detail === 'string' ? detail : detail?.open === false ? null : detail?.id ?? null;
    if (id !== 'graphics') panelContainer = null;
    if (id === 'settings' || id === 'audio') {
      queueMicrotask(() => enhanceOpenPanel(id));
    }
  });

  api.on('videoAudioModsChange', () => {
    if (api.panel === 'graphics') renderPanel();
  });

  // Expose full programmatic API on `api.videoAudioMods` for features and automated verification.
  api.videoAudioMods = {
    ...ctrl,
    open(tab = 'graphics') {
      activeTab = tab;
      api.openPanel('graphics');
    },
    setTab(tab) {
      activeTab = tab;
      if (api.panel === 'graphics') renderPanel();
    },
    sampleOverridePack: SAMPLE_OVERRIDE_PACK,
    status() {
      return {
        graphics: ctrl.getGraphics(),
        audio: ctrl.audioSources.status(),
        assets: ctrl.assetOverrides.summary(),
        serverMods: ctrl.getServerMods(),
        perf: api.renderer?.perfStats?.() ?? null,
      };
    },
  };
}
