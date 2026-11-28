// Tests for Wave 1 `dfu-render-mods` deliverables:
//   1. Graphics, resolution/performance, Classic Retro Video (320x200 / 640x400, 4:3, VGA palette/dither),
//      and Lighting/Post-Processing presets (client/render/graphics-options.js, renderer.js, visibility.js).
//   2. Custom local audio sources & soundfont loader + clean reset to classic synth across scene crossings
//      (client/gameplay/atmosphere/audio-sources.js).
//   3. Client-side local asset replacement with deterministic precedence & authoritative collision preservation
//      (client/lib/asset-overrides.js).
//   4. Server-side versioned multi-quest-pack workflow & active quest migration (server/rpg/quests/packs.js, catalog.js).
//   5. Operator-managed Mod Registry + representative end-to-end sample pack (server/rpg/mods.js).
//   6. Video/Audio/Mods controller integration (client/gameplay/video-audio-mods.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_GRAPHICS, QUALITY_PRESETS, LIGHTING_PRESETS,
  normalizeGraphicsOptions, applyQualityPreset, applyLightingPreset,
  loadGraphicsOptions, saveGraphicsOptions, needsOffscreenPass, computeViewport,
  buildVgaPalette, quantizeRgbVga,
} from '../client/render/graphics-options.js';
import { fogDistances } from '../client/render/visibility.js';
import { Renderer } from '../client/render/renderer.js';
import {
  AudioSourceManager, parseSoundfontBank, parseSf2Header, resolveVoiceSpec,
} from '../client/gameplay/atmosphere/audio-sources.js';
import {
  AssetOverrideManager, validateOverridePack, collisionFingerprint, SAMPLE_OVERRIDE_PACK,
} from '../client/lib/asset-overrides.js';
import { createVideoAudioModsController } from '../client/gameplay/video-audio-mods.js';
import {
  parseSemver, compareSemver, satisfiesRange, validateQuestPackManifest,
  resolveQuestPacks, stampQuestPackMeta, reconcileActiveQuests,
} from '../server/rpg/quests/packs.js';
import { loadCatalog, catalogReport } from '../server/rpg/quests/catalog.js';
import { createInstance } from '../server/rpg/quests/engine.js';
import {
  createModRegistry, validateModManifest, SAMPLE_MOD_PACK, install as installMods,
} from '../server/rpg/mods.js';
import { createRpgRuntime } from '../server/rpg/runtime.js';
import { createGameplayApi } from '../client/gameplay/api.js';
import { localArena2 } from './support/rpg-session.mjs';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

/** Minimal mock WebGL2 context recording shader uniforms, viewports, FBO bindings, and texture params. */
function createMockGl() {
  const calls = {
    viewports: [],
    framebuffers: [],
    uniforms: new Map(),
    texParams: [],
    draws: 0,
    mipmaps: 0,
  };
  let nextId = 1;
  const activeUniformNames = [
    'u_vp', 'u_model', 'u_tint', 'u_useTex', 'u_tex', 'u_eye', 'u_lightDir', 'u_shade',
    'u_coverage', 'u_fogColor', 'u_fog', 'u_ambient', 'u_shadowStrength',
    'u_dynLightPos', 'u_dynLightColor', 'u_dynLightRadius', 'u_dynLightIntensity',
    'u_invVp', 'u_zenith', 'u_horizon', 'u_ground', 'u_sunDir',
    'u_texSize', 'u_paletteMode', 'u_dither', 'u_scanlines', 'u_bloom', 'u_vignette', 'u_fxaa',
  ];
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ACTIVE_UNIFORMS: 0x8b86,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    UNPACK_ALIGNMENT: 0x0cf5,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    LINEAR: 0x2601,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    CLAMP_TO_EDGE: 0x812f,
    MAX_TEXTURE_SIZE: 0x0d33,
    FRAMEBUFFER: 0x8d40,
    RENDERBUFFER: 0x8d41,
    COLOR_ATTACHMENT0: 0x8ce0,
    DEPTH_ATTACHMENT: 0x8d00,
    DEPTH_COMPONENT16: 0x81a5,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    CULL_FACE: 0x0b44,
    DEPTH_TEST: 0x0b71,
    BLEND: 0x0be2,
    TRIANGLES: 0x0004,
    FLOAT: 0x1406,
    _calls: calls,
    getExtension: () => null,
    getParameter: (p) => (p === 0x0d33 ? 4096 : 1),
    createShader: () => ({ id: nextId++ }),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => ({ id: nextId++ }),
    attachShader: () => {},
    bindAttribLocation: () => {},
    linkProgram: () => {},
    getProgramParameter: (_p, pname) => (pname === 0x8b86 ? activeUniformNames.length : true),
    getProgramInfoLog: () => '',
    getActiveUniform: (_p, i) => ({ name: activeUniformNames[i] }),
    getUniformLocation: (_p, name) => ({ name }),
    createBuffer: () => ({ id: nextId++ }),
    bindBuffer: () => {},
    bufferData: () => {},
    bufferSubData: () => {},
    deleteBuffer: () => {},
    createTexture: () => ({ id: nextId++ }),
    bindTexture: () => {},
    deleteTexture: () => {},
    pixelStorei: () => {},
    texImage2D: () => {},
    texParameteri: (_t, pname, param) => calls.texParams.push([pname, param]),
    texParameterf: () => {},
    generateMipmap: () => { calls.mipmaps++; },
    createFramebuffer: () => ({ id: nextId++ }),
    bindFramebuffer: (_t, fb) => calls.framebuffers.push(fb),
    deleteFramebuffer: () => {},
    framebufferTexture2D: () => {},
    createRenderbuffer: () => ({ id: nextId++ }),
    bindRenderbuffer: () => {},
    deleteRenderbuffer: () => {},
    renderbufferStorage: () => {},
    framebufferRenderbuffer: () => {},
    checkFramebufferStatus: () => 0x8cd5,
    viewport: (x, y, w, h) => calls.viewports.push({ x, y, w, h }),
    clearColor: () => {},
    clear: () => {},
    disable: () => {},
    enable: () => {},
    depthMask: () => {},
    useProgram: () => {},
    activeTexture: () => {},
    enableVertexAttribArray: () => {},
    disableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttrib2f: () => {},
    vertexAttrib3f: () => {},
    vertexAttrib3fv: () => {},
    uniform1i: (loc, v) => loc && calls.uniforms.set(loc.name, v),
    uniform1f: (loc, v) => loc && calls.uniforms.set(loc.name, v),
    uniform2f: (loc, a, b) => loc && calls.uniforms.set(loc.name, [a, b]),
    uniform2fv: (loc, v) => loc && calls.uniforms.set(loc.name, [...v]),
    uniform3f: (loc, a, b, c) => loc && calls.uniforms.set(loc.name, [a, b, c]),
    uniform3fv: (loc, v) => loc && calls.uniforms.set(loc.name, [...v]),
    uniform4f: (loc, a, b, c, d) => loc && calls.uniforms.set(loc.name, [a, b, c, d]),
    uniform4fv: (loc, v) => loc && calls.uniforms.set(loc.name, [...v]),
    blendFunc: () => {},
    depthFunc: () => {},
    uniformMatrix4fv: () => {},
    drawArrays: () => { calls.draws++; },
  };
  return gl;
}

function createMockCanvas(gl, width = 1280, height = 800) {
  return {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {},
    dataset: {},
    addEventListener: () => {},
    getContext: (kind) => (kind === 'webgl2' ? gl : null),
  };
}

// ============================================================================
// 1. Graphics Options, Retro Video Mode & Renderer
// ============================================================================

test('graphics options normalize, clamp, persist, and apply presets cleanly', () => {
  const store = memoryStorage();
  const clamped = normalizeGraphicsOptions({
    fov: 999,
    renderScale: 0.05,
    outdoorViewDistance: 99999,
    textureFiltering: 'invalid',
    retroMode: 'bad',
    ambientLight: -5,
    spellLightBoost: 99,
  });
  assert.equal(clamped.fov, 110);
  assert.equal(clamped.renderScale, 0.35);
  assert.equal(clamped.outdoorViewDistance, 3600);
  assert.equal(clamped.textureFiltering, 'nearest');
  assert.equal(clamped.retroMode, 'off');
  assert.equal(clamped.ambientLight, 0.2);
  assert.equal(clamped.spellLightBoost, 2.2);

  const classic = applyQualityPreset(DEFAULT_GRAPHICS, 'classic');
  assert.equal(classic.retroMode, '320x200');
  assert.equal(classic.retroPalette, 'vga256');
  assert.equal(classic.retroDither, 'bayer4');
  assert.equal(classic.retroAspectCorrection, true);
  assert.equal(classic.retroNearest, true);

  const dark = applyLightingPreset(classic, 'dark-dungeons');
  assert.equal(dark.ambientLight, LIGHTING_PRESETS['dark-dungeons'].ambientLight);
  assert.equal(dark.spellLightBoost, LIGHTING_PRESETS['dark-dungeons'].spellLightBoost);

  saveGraphicsOptions(dark, store);
  const reloaded = loadGraphicsOptions(store);
  assert.deepEqual(reloaded, dark);
});

test('classic retro viewport computes 320x200 / 640x400 FBO with 4:3 CRT pillarboxing and VGA palette', () => {
  const vp320 = computeViewport(1280, 800, 1, { ...DEFAULT_GRAPHICS, retroMode: '320x200', retroAspectCorrection: true });
  assert.equal(vp320.fbW, 320);
  assert.equal(vp320.fbH, 200);
  assert.equal(vp320.retro, true);
  assert.ok(Math.abs(vp320.aspect - 4 / 3) < 1e-6);
  // 800 * (4/3) = 1067 wide, centered inside 1280 -> x = 106
  assert.equal(vp320.dst.h, 800);
  assert.equal(vp320.dst.w, 1067);
  assert.equal(vp320.dst.x, 106);

  const vp640 = computeViewport(1280, 800, 1, { ...DEFAULT_GRAPHICS, retroMode: '640x400', retroAspectCorrection: true });
  assert.equal(vp640.fbW, 640);
  assert.equal(vp640.fbH, 400);
  assert.equal(vp640.dst.w, 1067);

  const vpStretch = computeViewport(1280, 800, 1, { ...DEFAULT_GRAPHICS, retroMode: '320x200', retroAspectCorrection: false });
  assert.equal(vpStretch.dst.w, 1280);
  assert.equal(vpStretch.dst.x, 0);

  const vpHalf = computeViewport(1280, 800, 1, { ...DEFAULT_GRAPHICS, retroMode: 'off', renderScale: 0.5 });
  assert.equal(vpHalf.fbW, 640);
  assert.equal(vpHalf.fbH, 400);

  assert.equal(needsOffscreenPass({ ...DEFAULT_GRAPHICS, postProcessing: false, renderScale: 1, retroMode: 'off' }), false);
  assert.equal(needsOffscreenPass({ ...DEFAULT_GRAPHICS, retroMode: '320x200' }), true);

  const pal = buildVgaPalette();
  assert.equal(pal.length, 256 * 3);
  const q = quantizeRgbVga(12, 240, 12, pal);
  assert.deepEqual(q, [0, 255, 0]);

  // Outdoor view distance scales client fog without changing indoor fog math
  const fogNear = fogDistances(3600, 1, true, 900);
  const fogFar = fogDistances(3600, 1, true, 3000);
  assert.ok(fogNear[1] < fogFar[1]);
  assert.deepEqual(fogDistances(400, 1, false, 900), fogDistances(400, 1, false, 3000));
});

test('Renderer drives offscreen retro 320x200 VGA FBO, dynamic lighting, and live texture filtering', () => {
  const prevWin = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  try {
    const gl = createMockGl();
    const canvas = createMockCanvas(gl, 1280, 800);
    const renderer = new Renderer(canvas);
    renderer.setTown({
      positions: new Float32Array([0, 0, -5, 1, 0, -5, 0, 1, -5]),
      uv: new Float32Array([0, 0, 1, 0, 0, 1]),
      uniformColor: [1, 1, 1],
      atlas: { width: 64, height: 64, pixels: new Uint8Array(64 * 64 * 4).fill(200) },
      kind: 'town',
    });

    // Switch texture filtering live without re-uploading geometry
    renderer.setGraphicsOptions({ textureFiltering: 'trilinear' }, { persist: false });
    assert.ok(gl._calls.mipmaps >= 1, 'trilinear generates mipmaps for WebGL2 / POT atlas');
    assert.ok(gl._calls.texParams.some(([k, v]) => k === gl.TEXTURE_MIN_FILTER && v === gl.LINEAR_MIPMAP_LINEAR));

    // Activate Classic 320x200 Retro VGA + Dark Dungeons lighting + dynamic torch/spell light
    renderer.applyGraphicsPreset('classic', { persist: false });
    renderer.applyLightingPreset('dark-dungeons', { persist: false });
    renderer.setDynamicLight({ pos: [0, 1.6, 0], color: [1, 0.78, 0.48], radius: 14, intensity: 0.9 });

    gl._calls.viewports.length = 0;
    gl._calls.framebuffers.length = 0;
    renderer.render({ x: 0, y: 1.6, z: 0, yaw: 0, pitch: 0 }, []);

    assert.equal(canvas.style.imageRendering, 'pixelated');
    assert.equal(canvas.dataset.retroMode, '320x200');
    assert.ok(gl._calls.viewports.some((v) => v.w === 320 && v.h === 200), 'renders world at 320x200');
    assert.ok(gl._calls.viewports.some((v) => v.w === 1067 && v.h === 800 && v.x === 106), 'blits with 4:3 pillarbox');
    assert.equal(gl._calls.uniforms.get('u_paletteMode'), 1);
    assert.equal(gl._calls.uniforms.get('u_dither'), 1);
    assert.equal(gl._calls.uniforms.get('u_ambient'), LIGHTING_PRESETS['dark-dungeons'].ambientLight);
    assert.ok(gl._calls.uniforms.get('u_dynLightRadius') > 14, 'spellLightBoost amplifies dynamic light radius');

    const stats = renderer.perfStats();
    assert.equal(stats.fbWidth, 320);
    assert.equal(stats.fbHeight, 200);
    assert.ok(stats.drawCalls >= 3);
  } finally {
    globalThis.window = prevWin;
  }
});

// ============================================================================
// 2. Custom Local Audio Sources & SoundFont + Clean Reset across Scene Crossings
// ============================================================================

function makeSyntheticSf2(bankName, presetNames) {
  // Build minimal valid RIFF sfbk with INFO/INAM + pdta/phdr chunks
  const enc = (s, len) => {
    const out = new Uint8Array(len);
    for (let i = 0; i < Math.min(s.length, len); i++) out[i] = s.charCodeAt(i);
    return out;
  };
  const chunk = (id, payload) => {
    const pad = payload.length & 1;
    const out = new Uint8Array(8 + payload.length + pad);
    out.set(enc(id, 4), 0);
    new DataView(out.buffer).setUint32(4, payload.length, true);
    out.set(payload, 8);
    return out;
  };
  const concat = (...arrs) => {
    const total = arrs.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  };
  const inam = chunk('INAM', enc(`${bankName}\0`, bankName.length + 1));
  const infoList = chunk('LIST', concat(enc('INFO', 4), inam));
  const phdrEntries = [...presetNames, 'EOP'].map((pname, idx) => {
    const rec = new Uint8Array(38);
    rec.set(enc(pname, 20), 0);
    new DataView(rec.buffer).setUint16(20, idx, true);
    return rec;
  });
  const phdr = chunk('phdr', concat(...phdrEntries));
  const pdtaList = chunk('LIST', concat(enc('pdta', 4), phdr));
  const body = concat(enc('sfbk', 4), infoList, pdtaList);
  return chunk('RIFF', body);
}

test('custom audio sources load SF2/JSON soundfonts, play custom tracks, and reset cleanly to classic synth across crossings', async () => {
  // SF2 binary validation & parsing
  const sf2 = makeSyntheticSf2('Iliac SC-55', ['Grand Piano', 'Warm Strings', 'French Horn Brass']);
  const parsedSf2 = parseSf2Header(sf2, 'iliac.sf2');
  assert.equal(parsedSf2.name, 'Iliac SC-55');
  assert.equal(parsedSf2.format, 'sf2');
  assert.equal(parsedSf2.presetCount, 3);
  assert.throws(() => parseSf2Header(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])), /Invalid SF2/);

  // JSON bank parsing + voice resolution
  const bank = parseSoundfontBank({ name: 'Lute & Strings', families: { strings: { wave: 'triangle', attack: 0.2 } } });
  const spec = resolveVoiceSpec(40, bank); // program 40 = strings
  assert.equal(spec.family, 'strings');
  assert.equal(spec.wave, 'triangle');
  assert.equal(spec.attack, 0.2);

  // Engine attachment + scene crossing + reset to classic synth
  const playedClassic = [];
  const startedCustom = [];
  let stoppedCustomCount = 0;
  const fakeCtx = {
    currentTime: 1,
    createBufferSource: () => ({
      buffer: null,
      loop: false,
      connect() {},
      disconnect() {},
      start() { startedCustom.push(this.buffer.label); },
      stop() { stoppedCustomCount++; },
    }),
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
  };
  const fakeEngine = {
    ctx: fakeCtx,
    bus: { music: {} },
    running: true,
    paused: false,
    prefs: { musicEnabled: true },
    wantedSong: null,
    currentSong: null,
    error: null,
    _changed() {},
    async playSong(name) {
      this.wantedSong = name;
      this.currentSong = name;
      playedClassic.push(name);
      return true;
    },
    stopMusic() { this.currentSong = null; },
    setPaused(p) { this.paused = p; },
  };

  const mgr = new AudioSourceManager({ storage: memoryStorage() });
  mgr.attachEngine(fakeEngine);
  mgr.loadSoundfont('warm-orchestral');
  assert.equal(mgr.status().classicActive, false);

  const fakeBuf = { label: 'dark-crypt.ogg', getChannelData: () => new Float32Array(8) };
  await mgr.loadCustomTrack('dungeon', fakeBuf, { name: 'Dark Crypt.ogg' });

  // Crossing into dungeon plays custom local track
  mgr.setScene('dungeon');
  await fakeEngine.playSong('SONG_D01.HMI');
  assert.equal(fakeEngine.currentSong, 'Custom: Dark Crypt.ogg');
  assert.deepEqual(startedCustom, ['dark-crypt.ogg']);

  // Crossing back to town_day uses classic HMI song (with soundfont)
  mgr.setScene('town_day');
  await fakeEngine.playSong('SONG_G01.HMI');
  assert.equal(fakeEngine.currentSong, 'SONG_G01.HMI');
  assert.ok(stoppedCustomCount >= 1);

  // Reset to classic synth: clears custom tracks & soundfont and stays classic across every subsequent crossing
  await mgr.resetToClassic();
  assert.equal(mgr.status().classicActive, true);
  assert.equal(mgr.status().tracks.length, 0);
  assert.equal(mgr.status().soundfont, null);

  for (const [scene, song] of [['dungeon', 'SONG_D02.HMI'], ['tavern', 'SONG_T01.HMI'], ['wilderness', 'SONG_W01.HMI']]) {
    mgr.setScene(scene);
    await fakeEngine.playSong(song);
    assert.equal(fakeEngine.currentSong, song, `stays on classic HMI after crossing to ${scene}`);
  }
  assert.equal(startedCustom.length, 1, 'no custom audio played after reset to classic');
});

// ============================================================================
// 3. Client-Side Local Asset Replacement & Collision Preservation
// ============================================================================

test('local asset overrides enforce deterministic precedence, reject collision tampering, and isolate clients', () => {
  // Reject collision / physics overrides
  assert.throws(() => validateOverridePack({
    id: 'bad-collision-pack',
    version: '1.0.0',
    assets: { models: { '100': { colliders: [{ minX: 0 }] } } },
  }), /collision/i);

  const clientA = new AssetOverrideManager({ storage: memoryStorage() });
  const clientB = new AssetOverrideManager({ storage: memoryStorage() });

  clientA.importPack({
    id: 'base-pack',
    name: 'Base Art',
    version: '1.0.0',
    priority: 10,
    enabled: true,
    assets: {
      textures: { 'atlas:tint': { kind: 'tint', r: 1.2, g: 0.9, b: 0.8 }, 'TEXTURE.002:46': { kind: 'solid', rgba: [10, 20, 30, 255] } },
      ui: { 'hud:accent': { cssVar: '--accent', value: '#112233' } },
      animations: { 'weapon:swing': { frameRateScale: 1.1 } },
    },
  });
  clientA.importPack({
    id: 'hi-res-override',
    name: 'Hi-Res Override',
    version: '1.2.0',
    priority: 20,
    enabled: true,
    assets: {
      textures: { 'TEXTURE.002:46': { kind: 'solid', rgba: [200, 180, 160, 255] } },
      models: { '41000': { tint: [0.9, 0.8, 0.7] } },
    },
  });

  // Deterministic precedence: priority 20 overrides priority 10 and reports conflict
  const resolved = clientA.resolve('textures', 'TEXTURE.002:46');
  assert.equal(resolved.found, true);
  assert.equal(resolved.packId, 'hi-res-override');
  assert.equal(resolved.shadowed.length, 1);
  assert.equal(resolved.shadowed[0].packId, 'base-pack');
  assert.equal(clientA.conflicts().length, 1);

  // Export & import bundle round-trip
  const exported = clientA.exportAll();
  const cloned = new AssetOverrideManager({ storage: memoryStorage() });
  cloned.importBundle(exported);
  assert.deepEqual(cloned.summary().loadOrder, ['base-pack@1.0.0', 'hi-res-override@1.2.0']);

  // Live mesh texture replacement on Client A vs untouched Client B, preserving authoritative collision
  const makeTownMesh = () => ({
    atlas: {
      width: 4,
      height: 4,
      pixels: new Uint8Array(4 * 4 * 4).fill(120),
      rects: { 'TEXTURE.002:46': { x: 0, y: 0, width: 2, height: 2 } },
    },
    colliders: [{ minX: -10, maxX: 10, minY: 0, maxY: 4, minZ: -10, maxZ: 10 }],
    portals: [{ x: 2, y: 0, z: -4 }],
    bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 },
  });
  const meshA = makeTownMesh();
  const meshB = makeTownMesh();
  const origPixels = new Uint8Array(meshA.atlas.pixels);
  const reskinCalls = [];
  const fakeRenderer = { reskin: (m, opts) => reskinCalls.push(opts) };

  const resA = clientA.applyToMesh(meshA, fakeRenderer);
  const resB = clientB.applyToMesh(meshB, fakeRenderer);
  assert.equal(resA.applied, true);
  assert.equal(resA.collisionIntact, true);
  assert.equal(resB.applied, false);
  assert.equal(collisionFingerprint(meshA), collisionFingerprint(meshB), 'both clients share identical authoritative collision');
  assert.deepEqual([...meshA.atlas.pixels.slice(0, 4)], [200, 180, 160, 255], 'Client A sees overridden pixels');
  assert.deepEqual([...meshB.atlas.pixels.slice(0, 4)], [120, 120, 120, 120], 'Client B keeps original art');
  assert.ok(reskinCalls.length >= 1);

  // Model visual override preserves collision references
  const origModel = { positions: new Float32Array([0, 0, 0]), colliders: meshA.colliders, bounds: meshA.bounds };
  const overriddenModel = clientA.applyToModel('41000', origModel);
  assert.equal(overriddenModel.visualOverridePack, 'hi-res-override');
  assert.strictEqual(overriddenModel.colliders, origModel.colliders);

  // Reset restores exact original pixels byte-for-byte
  clientA.resetAll();
  const restored = clientA.applyToMesh(meshA, fakeRenderer);
  assert.equal(restored.restored, true);
  assert.deepEqual([...meshA.atlas.pixels], [...origPixels]);
});

// ============================================================================
// 4. Server-Side Versioned Multiple Quest Packs & Catalog Compatibility
// ============================================================================

const makeSimpleQuest = (name, title, taskName = '_deliver_', rewardText = 'Here is your gold.') => [
  `Quest: ${name}`,
  `DisplayName: ${title}`,
  'QRC:',
  'QuestorOffer: [1000]',
  `<ce>${title}: will you accept this job?`,
  '',
  'RefuseQuest: [1001]',
  '<ce>Farewell then.',
  '',
  'AcceptQuest: [1002]',
  '<ce>Go speak to _target_.',
  '',
  'QuestComplete: [1004]',
  `<ce>${rewardText}`,
  '',
  'QBN:',
  'Item _reward_ gold range 50 to 50',
  'Person _giver_ group Questor',
  'Person _target_ group Resident1',
  'Place _dest_ local tavern',
  'Clock _timer_ 3.00:00',
  '',
  '  start timer _timer_',
  '  place npc _target_ at _dest_',
  '',
  `${taskName} task:`,
  '  clicked npc _target_',
  '  give pc _reward_',
  '  end quest',
  '',
  '_timer_ task:',
  '  end quest',
].join('\n');

test('versioned quest packs validate manifests, dependencies, conflicts, deterministic order, overlaps, and active migrations', () => {
  // Semver checks
  assert.ok(compareSemver(parseSemver('1.2.0'), parseSemver('1.1.9')) > 0);
  assert.equal(satisfiesRange('1.4.2', '^1.2.0'), true);
  assert.equal(satisfiesRange('2.0.0', '^1.2.0'), false);
  assert.equal(satisfiesRange('1.5.0', '>=1.2.0 <2.0.0'), true);

  // Manifest validation rejects malformed entries
  assert.equal(validateQuestPackManifest({ id: 'BAD ID', version: 'nope', apiVersion: 99 }).ok, false);

  // Two enabled packs with dependency + overlapping quest ID
  const packCore = {
    manifest: { id: 'iliac-core', name: 'Iliac Core Quests', version: '1.0.0', priority: 10 },
    questListText: 'schema: *name, group, membership, minReq, flag\nW0C00Y01, Commoners, N, 0, 0\nW0C00Y02, Commoners, N, 0, 0\n',
    scripts: {
      W0C00Y01: makeSimpleQuest('W0C00Y01', 'Core Errand v1'),
      W0C00Y02: makeSimpleQuest('W0C00Y02', 'Core Courier'),
    },
  };
  const packExpansion = {
    manifest: {
      id: 'iliac-expansion',
      name: 'Iliac Expansion',
      version: '1.0.0',
      priority: 5, // lower numeric priority, but depends on iliac-core so topological sort MUST load it AFTER iliac-core
      dependencies: [{ id: 'iliac-core', range: '^1.0.0' }],
    },
    scripts: {
      W0C00Y01: makeSimpleQuest('W0C00Y01', 'Expansion Overhauled Errand'),
    },
  };
  const packBrokenDep = {
    manifest: { id: 'broken-addon', version: '1.0.0', dependencies: [{ id: 'iliac-core', range: '>=2.0.0' }] },
    scripts: {},
  };

  const resolved = resolveQuestPacks([packExpansion, packCore, packBrokenDep]);
  assert.deepEqual(resolved.loadOrder.map((p) => p.id), ['iliac-core', 'iliac-expansion']);
  assert.equal(resolved.overlaps.length, 1);
  assert.equal(resolved.overlaps[0].questName, 'W0C00Y01');
  assert.equal(resolved.overlaps[0].winner.packId, 'iliac-expansion');
  assert.equal(resolved.overlaps[0].shadowed[0].packId, 'iliac-core');
  assert.equal(resolved.errors.length, 1);
  assert.match(resolved.errors[0].errors[0], /requires >=2\.0\.0/);

  // Declared conflict detection
  const conflicted = resolveQuestPacks([
    { manifest: { id: 'alpha', version: '1.0.0', conflicts: ['beta'] }, scripts: {} },
    { manifest: { id: 'beta', version: '1.0.0' }, scripts: {} },
  ]);
  assert.equal(conflicted.conflicts.length, 1);
  assert.equal(conflicted.loadOrder.length, 0);

  // Load via catalog.js and verify active quest migration across pack update (1.0.0 -> 1.1.0)
  const catV1 = loadCatalog({ packs: [packCore] });
  const q1 = catV1.quests.get('W0C00Y01');
  assert.ok(q1);
  assert.equal(q1.analysis.offerable, true);
  assert.equal(q1.packId, 'iliac-core');
  assert.equal(q1.packVersion, '1.0.0');

  const host = new Proxy({ text: () => '' }, { get: (o, k) => o[k] ?? (() => null) });
  const activeInst = createInstance(q1.def, { uid: 'q-101', seed: 42, giver: null, host, now: 100, source: 'test' });
  stampQuestPackMeta(activeInst, q1);
  activeInst.tasks.deliver.t = true;
  activeInst.granted.push('q-101:step0');

  // Update packCore to 1.1.0 renaming `_deliver_` -> `_handin_` with migration metadata
  const packCoreV2 = {
    manifest: {
      id: 'iliac-core',
      name: 'Iliac Core Quests',
      version: '1.1.0',
      priority: 10,
      migrations: {
        W0C00Y01: { fromRange: '>=1.0.0 <1.1.0', renameTasks: { deliver: 'handin' }, compatible: true },
      },
    },
    questListText: packCore.questListText,
    scripts: {
      W0C00Y01: makeSimpleQuest('W0C00Y01', 'Core Errand v1.1', '_handin_', 'Updated reward text.'),
    },
  };
  const catV2 = loadCatalog({ packs: [packCoreV2] });
  const migReport = reconcileActiveQuests([activeInst], catV2.packs, catV2);
  assert.equal(migReport.migrated.length, 1);
  assert.equal(activeInst.packVersion, '1.1.0');
  assert.equal(activeInst.packCompat, 'migrated');
  assert.equal(activeInst.tasks.handin?.t, true, 'migrated task preserves triggered state');
  assert.deepEqual(activeInst.granted, ['q-101:step0'], 'granted reward idempotency keys preserved');

  // Filesystem pack directory discovery
  const tmpDir = mkdtempSync(join(tmpdir(), 'dfw-qpacks-'));
  try {
    const pDir = join(tmpDir, 'fs-pack');
    mkdirSync(join(pDir, 'quests'), { recursive: true });
    writeFileSync(join(pDir, 'pack.json'), JSON.stringify({ id: 'fs-pack', name: 'FS Pack', version: '1.0.0', priority: 1 }));
    writeFileSync(join(pDir, 'quests', 'W0C00Y09.txt'), makeSimpleQuest('W0C00Y09', 'Filesystem Quest'));
    const fsCat = loadCatalog({ packsDir: tmpDir });
    assert.ok(fsCat.quests.has('W0C00Y09'));
    assert.equal(fsCat.quests.get('W0C00Y09').packId, 'fs-pack');
    const rep = catalogReport(fsCat);
    assert.equal(rep.packs.loadOrder[0].id, 'fs-pack');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

const ARENA2_PATH = process.env.ARENA2_DIR || localArena2();

test('versioned quest pack loads cleanly alongside real ARENA2 classic catalog', { skip: !ARENA2_PATH && 'no local ARENA2' }, () => {
  const arena2 = ARENA2_PATH;
  const cat = loadCatalog({
    dataPath: arena2,
    packs: [{
      manifest: { id: SAMPLE_MOD_PACK.id, name: SAMPLE_MOD_PACK.name, version: SAMPLE_MOD_PACK.version, priority: 10 },
      scripts: SAMPLE_MOD_PACK.hooks.quests.scripts,
      questListText: SAMPLE_MOD_PACK.hooks.quests.questListText,
    }],
    artifact: () => true,
  });
  assert.ok(cat.quests.has('W0C00Y01'), 'sample pack quest loaded');
  assert.equal(cat.quests.get('W0C00Y01').analysis.offerable, true);
  assert.ok(cat.quests.has('A0C00Y10'), 'classic ARENA2 quests remain loaded');
  assert.equal(cat.packs.errors.length, 0);
  assert.equal(cat.failures.filter((f) => String(f.source).startsWith('pack:')).length, 0);
});

// ============================================================================
// 5. Server-Side Mod Management & Representative Sample Pack End-to-End
// ============================================================================

test('mod registry validates categories, rejects Unity DLLs & unsafe hooks, and runs sample pack end-to-end on RPG runtime', () => {
  // Reject Unity-only DLL mod and collision override
  assert.equal(validateModManifest({ id: 'unity-only', version: '1.0.0', unityAssembly: 'MyMod.dll' }).ok, false);
  assert.equal(validateModManifest({ id: 'bad-assets', version: '1.0.0', hooks: { assets: { colliders: [] } } }).ok, false);
  assert.equal(validateModManifest({ id: 'bad-rule', version: '1.0.0', hooks: { rules: { godMode: 99 } } }).ok, false);

  const registry = createModRegistry({ includeSample: true });
  const rep = registry.report();
  assert.equal(rep.errors.length, 0);
  assert.equal(rep.conflicts.length, 0);
  assert.equal(rep.loadOrder.length, 1);
  assert.equal(rep.loadOrder[0].id, 'iliac-wayfarer-pack');
  assert.equal(rep.counts.items, 2);
  assert.equal(rep.counts.factions, 1);
  assert.equal(rep.counts.services, 1);
  assert.equal(rep.counts.landmarks, 1);
  assert.equal(rep.counts.quests, 1);
  assert.equal(rep.rules.lampDurationScale, 1.15);
  assert.equal(rep.questCatalog.offerable.some((q) => q.name === 'W0C00Y01'), true);

  // Disable / re-enable toggling
  registry.setEnabled('iliac-wayfarer-pack', false);
  assert.equal(registry.report().loadOrder.length, 0);
  registry.setEnabled('iliac-wayfarer-pack', true);
  assert.equal(registry.report().loadOrder.length, 1);

  // End-to-end RPG runtime integration (`mods.list` and `mods.inspect`)
  const players = new Map();
  const sent = [];
  const runtime = createRpgRuntime({
    players,
    features: [{ name: 'mods', install: installMods }],
    save: () => {},
    send: (p, msg) => sent.push({ p, msg }),
  });
  const player = { id: 1, name: 'Wayfarer', x: 0, z: 0, yaw: 0, rpg: {} };
  players.set(1, player);
  runtime.join(player);

  const listRes = runtime.act(player, 'mods.list', {});
  assert.equal(listRes.ok, true);
  assert.ok(sent.some((s) => s.msg.type === 'gameEvent' && s.msg.event?.kind === 'modsList' && s.msg.event.loadOrder[0].id === 'iliac-wayfarer-pack'));

  const inspectRes = runtime.act(player, 'mods.inspect', { modId: 'iliac-wayfarer-pack' });
  assert.equal(inspectRes.ok, true);
  assert.ok(sent.some((s) => s.msg.type === 'gameEvent' && s.msg.event?.kind === 'modInspect' && s.msg.event.active === true));
});

// ============================================================================
// 6. Video/Audio/Mods Controller Integration
// ============================================================================

test('video-audio-mods controller coordinates renderer graphics, retro mode, dynamic lights, audio sources, and overrides', () => {
  const api = createGameplayApi();
  let lastOpts = null;
  let lastLight = null;
  api.renderer = {
    setGraphicsOptions(o) { lastOpts = o; return o; },
    setDynamicLight(l) { lastLight = l; },
    reskin() {},
  };
  api.atmosphere = {
    now: () => ({ kind: 'dungeon', night: true, lightRadius: 14 }),
  };

  const ctrl = createVideoAudioModsController(api, { storage: memoryStorage() });
  ctrl.setRetroMode('320x200');
  assert.equal(lastOpts.retroMode, '320x200');
  assert.equal(lastOpts.retroPalette, 'vga256');
  assert.equal(lastOpts.retroDither, 'bayer4');
  assert.equal(lastOpts.retroAspectCorrection, true);

  // Frame event pushes held torch light to renderer
  api.emit('frame', { renderer: api.renderer, camera: { x: 4, y: 1.6, z: -2 }, dt: 0.016 });
  assert.ok(lastLight && lastLight.radius === 14 && lastLight.intensity > 0.5);
  assert.equal(ctrl.audioSources.sceneKind, 'dungeon');

  // Enable sample visual override pack & verify collision integrity on scene mesh
  ctrl.assetOverrides.setPackEnabled(SAMPLE_OVERRIDE_PACK.id, true);
  api.town = {
    atlas: { width: 2, height: 2, pixels: new Uint8Array(16).fill(100) },
    colliders: [{ minX: -1, maxX: 1, minY: 0, maxY: 2, minZ: -1, maxZ: 1 }],
  };
  const check = ctrl.applyOverridesNow(null);
  assert.equal(check.applied, true);
  assert.equal(check.collisionIntact, true);
});
