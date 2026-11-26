// Package 21: cinematics (.VID decoding and cue resolution), creature/footstep/mechanism sound tables, and
// dungeon/underwater lighting. The installed-file checks run only when a local ARENA2 is present and never
// copy game data into the repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VidDecoder, SEQUENCES, filesForCue, videoFileName, pcm8ToFloat, BLOCK } from '../client/gameplay/cinematics/vid.js';
import { creatureClip, hearingRadius, CREATURE_SOUNDS, footstepClips, mechanismClip, ambienceFor, clipsForEvent, DUNGEON_AMBIENCE, CLIP } from '../client/gameplay/atmosphere/playlists.js';
import { lightFor, heldLightRadius, DUNGEON_AMBIENT_RADIUS, LIGHT_RADIUS } from '../client/gameplay/atmosphere/light.js';

const ARENA2 = fileURLToPath(new URL('../gamedata/DaggerfallGameFiles/arena2/', import.meta.url));
const HAVE_ARENA2 = existsSync(join(ARENA2, 'ANIM0011.VID'));

// ------------------------------------------------------------------ synthetic VID (test fixture, not game data)

function fixtureVid({ width = 4, height = 2 } = {}) {
  const out = [];
  const u16 = (v) => out.push(v & 255, v >> 8);
  out.push(0x56, 0x49, 0x44); u16(512); u16(2); u16(width); u16(height); u16(4); u16(14);
  out.push(BLOCK.PALETTE);
  for (let i = 0; i < 256; i++) out.push(i % 64, (i * 2) % 64, 63 - (i % 64));
  // audio start: 740 samples of silence-ish
  out.push(BLOCK.AUDIO_START); u16(0); out.push(166); u16(740); for (let i = 0; i < 740; i++) out.push(128 + (i % 3));
  // key frame: run of 5 x colour 1, then 3 literals 2,3,4
  out.push(BLOCK.VIDEO_KEY); u16(0); out.push(0x80 + 5, 1, 3, 2, 3, 4, 0);
  out.push(BLOCK.AUDIO_MORE); u16(1102); for (let i = 0; i < 1102; i++) out.push(128);
  // row delta from row 1: skip 1, literal 1 pixel of colour 9
  out.push(BLOCK.VIDEO_ROW_DELTA); u16(0); u16(1); out.push(0x81, 1, 9, 0);
  out.push(BLOCK.END);
  return new Uint8Array(out);
}

test('VID fixture decodes key and row-delta frames with palette x4 and audio timing', () => {
  const d = new VidDecoder().feed(fixtureVid()).finish();
  assert.equal(d.width, 4);
  assert.equal(d.height, 2);
  const px = (i) => Array.from(d.rgba.subarray(i * 4, i * 4 + 4));
  const colour = (i) => [(i % 64) * 4, ((i * 2) % 64) * 4, (63 - (i % 64)) * 4, 255];
  const next = () => { for (let r; (r = d.next());) if (r.frame || r.type === BLOCK.END) return r; return null; };
  const f1 = next();
  assert.ok(f1.frame);
  for (let i = 0; i < 5; i++) assert.deepEqual(px(i), colour(1));
  assert.deepEqual(px(5), colour(2));
  assert.deepEqual(px(7), colour(4));
  assert.ok(Math.abs(f1.delay - 740 / 11025) < 1e-9);
  const f2 = next();
  assert.ok(f2.frame);
  assert.deepEqual(px(4), colour(1)); // skipped
  assert.deepEqual(px(5), colour(9)); // row 1, after a skip of 1
  assert.deepEqual(px(6), colour(3)); // untouched
  assert.ok(Math.abs(f2.delay - 1102 / 11025) < 1e-9);
  assert.equal(next().type, BLOCK.END);
  assert.equal(d.ended, true);
  assert.equal(d.frames, 2);
});

test('VID streaming: a block split across chunks waits instead of drawing a partial frame', () => {
  const bytes = fixtureVid();
  const d = new VidDecoder();
  const results = [];
  for (let i = 0; i < bytes.length; i += 7) {
    d.feed(bytes.subarray(i, i + 7));
    for (let r; (r = d.next());) results.push(r);
  }
  d.finish();
  for (let r; (r = d.next());) results.push(r);
  assert.equal(results.filter((r) => r.frame).length, 2);
  assert.equal(d.ended, true);
});

test('VID: a truncated file ends cleanly and a wrong magic is refused', () => {
  const bytes = fixtureVid();
  const d = new VidDecoder().feed(bytes.subarray(0, bytes.length - 20)).finish();
  let n = 0;
  for (let r; (r = d.next());) n++;
  assert.ok(n >= 2);
  assert.equal(d.ended, true);
  const bad = fixtureVid(); bad[0] = 0x58;
  assert.throws(() => new VidDecoder().feed(bad), /VID/);
});

test('pcm8ToFloat centres unsigned 8-bit samples', () => {
  assert.deepEqual(Array.from(pcm8ToFloat(new Uint8Array([0, 128, 255]))), [-1, 0, 127 / 128]);
});

test('cinematic cues resolve like DFU PlayVideo and the new-game wizard', () => {
  assert.equal(videoFileName(5), 'ANIM0005.VID');
  assert.equal(videoFileName(13), 'ANIM0013.VID');
  assert.equal(videoFileName(-1), null);
  assert.deepEqual(filesForCue({ video: 3 }), ['ANIM0003.VID']);
  assert.deepEqual(filesForCue({ sequence: 'opening', video: 0 }), ['ANIM0000.VID', 'ANIM0011.VID', 'DAG2.VID']);
  assert.deepEqual(filesForCue({ sequence: 'death' }), ['ANIM0012.VID']);
  assert.deepEqual(filesForCue({ sequence: 'nope' }), []);
  assert.deepEqual(filesForCue({ files: ['dag2.vid', '../x.VID', 'A.BSA'] }), ['DAG2.VID']);
  assert.deepEqual(filesForCue(null), []);
});

test('cinematic overlay bar omits video filenames and titles during playback', async () => {
  const { install } = await import('../client/gameplay/cinematics.js');
  const makeEl = (tag) => ({
    tagName: tag.toUpperCase(),
    className: '',
    id: '',
    hidden: false,
    dataset: {},
    style: { setProperty() {} },
    children: [],
    textContent: '',
    setAttribute() {},
    addEventListener() {},
    getContext: () => ({ fillStyle: '', fillRect() {}, putImageData() {} }),
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = [...nodes]; },
    querySelector() { return null; },
  });
  const head = makeEl('head');
  const body = makeEl('body');
  const prevDoc = globalThis.document;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevImageData = globalThis.ImageData;
  globalThis.document = {
    head,
    body,
    querySelector: () => null,
    createElement: makeEl,
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  };
  globalThis.requestAnimationFrame = (fn) => { fn(); return 1; };
  globalThis.ImageData = class { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } };
  try {
    const vid = fixtureVid();
    const api = {
      files: [{ name: 'ANIM0000.VID', size: vid.length, arrayBuffer: async () => vid.buffer.slice(vid.byteOffset, vid.byteOffset + vid.byteLength) }],
      on() {},
      emit() {},
    };
    install(api);
    assert.equal(api.cinematics.play({ sequence: 'opening', title: 'Opening' }), true);
    await new Promise((r) => setTimeout(r, 20));
    const root = body.children.find((el) => el.id === 'cinematic');
    const bar = root.children.find((el) => el.className === 'cine-bar');
    const barText = bar.children.map((c) => c.textContent).join(' ');
    assert.equal(barText, 'Space: next · Esc: skip all');
    assert.doesNotMatch(barText, /ANIM0000|Opening|\.VID/i);
    api.cinematics.skip();
  } finally {
    globalThis.document = prevDoc;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.ImageData = prevImageData;
  }
});

test('installed VIDs: every file decodes to its header frame count while streamed', { skip: !HAVE_ARENA2 && 'no local ARENA2' }, () => {
  const names = readdirSync(ARENA2).filter((n) => /\.VID$/i.test(n));
  for (const want of [...new Set(Object.values(SEQUENCES).flat())]) assert.ok(names.includes(want), `${want} installed`);
  for (const name of names) {
    const bytes = readFileSync(join(ARENA2, name));
    const d = new VidDecoder();
    let off = 0, frames = 0, firstFrameBytes = null;
    for (;;) {
      const r = d.next();
      if (r) { if (r.frame && ++frames === 1) firstFrameBytes = off; if (d.ended) break; continue; }
      if (d.ended) break;
      if (off >= bytes.length) { d.finish(); continue; }
      d.feed(bytes.subarray(off, off + 262144)); off += 262144;
    }
    assert.equal(frames, d.frameCount, `${name} frames`);
    assert.ok(firstFrameBytes <= 262144, `${name} first frame within the first chunk`);
  }
});

test('installed QBN video cues all name installed files', { skip: !HAVE_ARENA2 && 'no local ARENA2' }, async () => {
  const { readQbn, decompileQbn } = await import('../server/rpg/quests/qbn.js');
  const cues = new Set();
  for (const f of readdirSync(ARENA2).filter((n) => /\.QBN$/i.test(n))) {
    let text;
    try { text = JSON.stringify(decompileQbn(readQbn(readFileSync(join(ARENA2, f))))); } catch { continue; }
    for (const m of text.matchAll(/play video (\d+)/g)) cues.add(+m[1]);
  }
  assert.ok(cues.size >= 8);
  for (const n of cues) assert.ok(existsSync(join(ARENA2, videoFileName(n))), `ANIM ${n}`);
});

// ------------------------------------------------------------------ sounds

test('creature voices follow DFU EnemyBasics and EnemySounds', () => {
  assert.deepEqual(CREATURE_SOUNDS[0], [115, 116, 117]); // Rat
  assert.equal(creatureClip(0, 'attack'), 117);
  assert.equal(creatureClip(0, 'attract', () => 0.1), 115); // move (20%)
  assert.equal(creatureClip(0, 'attract', () => 0.9), 116); // bark
  assert.equal(creatureClip(130, 'attract'), null); // human classes muted
  assert.equal(creatureClip(130, 'attack'), 245);
  assert.equal(creatureClip(146, 'attract', () => 0.9), CLIP.Halt); // City Watch: "Halt!"
  assert.equal(creatureClip(39, 'attack'), null); // no sounds in DFU's table
  assert.equal(creatureClip(999, 'attack'), null);
  for (let id = 0; id <= 42; id++) if (id !== 39) assert.ok(CREATURE_SOUNDS[id], `creature ${id}`);
  assert.equal(hearingRadius([]), 16);
  assert.equal(hearingRadius([{ key: 'acuteHearing' }]), 20);
  assert.equal(hearingRadius(undefined), 16);
});

test('footsteps by surface follow DFU PlayerFootsteps', () => {
  assert.deepEqual(footstepClips({ indoors: true, kind: 'dungeon' }), [CLIP.PlayerFootstepStone1, CLIP.PlayerFootstepStone2]);
  assert.deepEqual(footstepClips({ indoors: true, kind: 'tavern' }), [CLIP.PlayerFootstepWood1, CLIP.PlayerFootstepWood2]);
  assert.deepEqual(footstepClips({ indoors: true, kind: 'palace' }), [CLIP.PlayerFootstepWood1, CLIP.PlayerFootstepWood2]);
  assert.deepEqual(footstepClips({ indoors: false, weather: 'sunny', season: 'Winter' }), [CLIP.PlayerFootstepSnow1, CLIP.PlayerFootstepSnow2]);
  assert.deepEqual(footstepClips({ indoors: false, weather: 'sunny', season: 'Winter', snowFree: true }), [CLIP.PlayerFootstepOutside1, CLIP.PlayerFootstepOutside2]);
  assert.deepEqual(footstepClips({ indoors: false, weather: 'sunny', season: 'Summer' }), [CLIP.PlayerFootstepOutside1, CLIP.PlayerFootstepOutside2]);
  assert.deepEqual(footstepClips({ kind: 'dungeon', swimming: true }), [CLIP.SplashSmall, CLIP.SplashSmall]);
  assert.deepEqual(footstepClips({ kind: 'dungeon', wading: true }), [CLIP.SplashSmallLow, CLIP.SplashSmallLow]);
  assert.deepEqual(footstepClips({ indoors: true, kind: 'tavern', surface: 'stone' }), [CLIP.PlayerFootstepStone1, CLIP.PlayerFootstepStone2]);
});

test('dungeon mechanisms: doors use the dungeon door pair, other actions their own sound byte', () => {
  assert.equal(mechanismClip({ door: true, open: true }), 25);
  assert.equal(mechanismClip({ door: true, open: false }), 24);
  assert.equal(mechanismClip({ door: false, sound: 68 }), 68);
  assert.equal(mechanismClip({ door: false, sound: 0 }), null);
  assert.equal(clipsForEvent({ kind: 'dungeonCue', cue: 'unlock', id: 'm1', x: 1, z: 2 })[0].clip, CLIP.ActivateLockUnlock);
  assert.equal(clipsForEvent({ kind: 'dungeonCue', cue: 'bash', id: 'm1' })[0].clip, CLIP.PlayerDoorBash);
  assert.equal(clipsForEvent({ kind: 'dungeonCue', cue: 'trap', id: 'm1', sound: 40 })[0].clip, 40);
  assert.deepEqual(clipsForEvent({ kind: 'dungeonCue', cue: 'trap', id: 'm1' }), []);
});

test('ambience: dungeon preset, quiet taverns, bubbles underwater; fall and attack events', () => {
  assert.deepEqual(ambienceFor({ kind: 'dungeon', indoors: true }).shots, [...DUNGEON_AMBIENCE]);
  assert.deepEqual(ambienceFor({ kind: 'tavern', indoors: true }), { loops: [], shots: [] });
  assert.deepEqual(ambienceFor({ kind: 'rain', weather: 'rain', indoors: false, underwater: true }), { loops: [], shots: [CLIP.AmbientWaterBubbles] });
  assert.deepEqual(clipsForEvent({ kind: 'land', fall: 6, damage: 3 }), [{ clip: CLIP.FallDamage, self: true }]);
  assert.deepEqual(clipsForEvent({ kind: 'land', fall: 0 }), []);
  // AcrobatMotor: a jump or step landing is silent, a bad fall (over 2.5 m) is FallHard, a hurting one FallDamage.
  assert.deepEqual(clipsForEvent({ kind: 'land', fall: 1.1, damage: 0 }), []);
  assert.deepEqual(clipsForEvent({ kind: 'land', fall: 3.2, damage: 0 }), [{ clip: CLIP.FallHard, self: true }]);
  assert.deepEqual(clipsForEvent({ kind: 'land', fall: 9, damage: 0 }), [], 'slowfall or levitation landing');
  assert.equal(clipsForEvent({ kind: 'monsterAttack', targetId: 7, hit: true }, { selfId: 7, rand: () => 0 })[0].clip, CLIP.Hit1);
  assert.deepEqual(clipsForEvent({ kind: 'monsterAttack', targetId: 8, hit: true }, { selfId: 7 }), []);
});

// ------------------------------------------------------------------ light

test('dungeon darkness: ambient radius unlit, held light radius from item templates and the Light spell', () => {
  const unlit = lightFor({ minuteOfDay: 720, indoors: true, kind: 'dungeon' });
  assert.equal(unlit.light, 'ambient');
  assert.deepEqual(unlit.fogOverride, [DUNGEON_AMBIENT_RADIUS * 0.3, DUNGEON_AMBIENT_RADIUS]);
  assert.ok(unlit.horizon.every((v) => v < 0.05));
  const candle = lightFor({ minuteOfDay: 720, indoors: true, kind: 'dungeon', lightRadius: LIGHT_RADIUS.candle });
  assert.equal(candle.light, 'held', 'a lit candle shows even within unlit sight');
  assert.equal(candle.radius, DUNGEON_AMBIENT_RADIUS);
  assert.notDeepEqual(candle.shade, unlit.shade);
  const torch = lightFor({ minuteOfDay: 720, indoors: true, kind: 'dungeon', lightRadius: 14 });
  assert.equal(torch.light, 'held');
  assert.equal(torch.fogOverride[1], 14);
  // Building interiors are lit as before.
  assert.equal(lightFor({ minuteOfDay: 0, indoors: true, kind: 'tavern' }).fogOverride, undefined);
  assert.equal(heldLightRadius({ lightSource: { template: 'Lantern' } }), LIGHT_RADIUS.lantern);
  assert.equal(heldLightRadius({ inventory: { items: [{ name: 'Candle', lit: true }, { name: 'Torch' }] } }), 8);
  assert.equal(heldLightRadius({ magic: { active: [{ status: 'light' }] } }), LIGHT_RADIUS.spell);
  assert.equal(heldLightRadius({ magic: { active: [{ status: 'light', radius: 20 }] }, lightSource: { template: 'Torch' } }), 20);
  assert.equal(heldLightRadius(null, [{ radius: 9 }]), 9);
  assert.equal(heldLightRadius({}), 0);
});

test('underwater view: short blue-green fog and a cool shade', () => {
  const w = lightFor({ minuteOfDay: 720, underwater: true });
  assert.equal(w.light, 'underwater');
  assert.ok(w.fogOverride[1] <= 16);
  assert.ok(w.horizon[2] > w.horizon[0]);
  assert.ok(w.shade[2] > w.shade[0]);
});

test('renderer honours fogOverride and restoreLight clears it', async () => {
  const { applyLight, restoreLight } = await import('../client/gameplay/atmosphere/light.js');
  const r = { sunDir: [0, 1, 0], fogScale: 1 };
  applyLight(r, lightFor({ minuteOfDay: 720, indoors: true, kind: 'dungeon', lightRadius: 16 }));
  assert.equal(r.fogOverride[1], 16);
  applyLight(r, lightFor({ minuteOfDay: 720, indoors: false }));
  assert.equal(r.fogOverride, null);
  applyLight(r, lightFor({ minuteOfDay: 720, underwater: true }));
  restoreLight(r);
  assert.equal(r.fogOverride, null);
});

test('held light gutters below 3 condition (DFU EnablePlayerTorch)', async () => {
  const { gutter } = await import('../client/gameplay/atmosphere/light.js');
  assert.deepEqual(gutter({ radius: 14, condition: 40 }, 1), { scale: 1, g: 0 });
  assert.deepEqual(gutter(null), { scale: 1, g: 0 });
  const g = gutter({ radius: 14, condition: 2 }, 0, () => 0.25);
  assert.ok(Math.abs(g.g - 0) < 1e-12);
  assert.ok(Math.abs(g.scale - 0.84) < 1e-9);
  const low = gutter({ condition: 0 }, Math.PI, () => 0.25);
  assert.ok(Math.abs(low.scale - 0.52) < 1e-9);
  assert.equal(heldLightRadius({ lightSource: { itemId: 'i1', template: 'torch', name: 'Torch', radius: 14, condition: 30, maxCondition: 50 } }), 14);
});

test('dungeon water sheet: RDBLayout.AddWater level, clipped to open water between floor and ceiling', async () => {
  const { CollisionWorld } = await import('../client/gameplay/collision/world.js');
  const { waterSurfaceTriangles, openWater } = await import('../client/world/interiors/waterSurface.js');
  const quad = (x0, x1, z0, z1, y, up) => up
    ? [x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0]
    : [x0, y, z0, x1, y, z1, x0, y, z1, x0, y, z0, x1, y, z0, x1, y, z1];
  const positions = new Float32Array([
    ...quad(0, 4, 0, 4, 0, true), ...quad(0, 4, 0, 4, 4, false), // flooded room: floor 0, ceiling 4
    ...quad(6, 10, 0, 4, 3, true), ...quad(6, 10, 0, 4, 6, false), // dry room whose floor is above the water level
    ...quad(12, 16, 0, 4, -3, true), ...quad(12, 16, 0, 4, 1.4, false), ...quad(12, 16, 0, 4, 1.6, true), // sealed under
  ]);
  const world = new CollisionWorld({ name: 'pool fixture', positions });
  assert.equal(openWater(world, 2, 2, 2), true);
  assert.equal(openWater(world, 8, 2, 2), false, 'dry room above the water');
  // Under a slab whose top is a walkable face below the surface (collision stands on any near-horizontal face), the
  // column above the slab counts; the sheet there lies inside closed geometry and is occluded by it.
  assert.equal(openWater(world, 14, 2, 2), true);
  assert.equal(openWater(world, 5, 2, 2), false, 'rock between the rooms');
  const { positions: sheet, stats } = waterSurfaceTriangles(world, [{ minX: 0, maxX: 10, minZ: 0, maxZ: 4, y: 2, block: 'FIXTURE.RDB' }]);
  assert.ok(sheet.length > 0 && sheet.length % 9 === 0);
  let maxX = -Infinity, minX = Infinity;
  for (let i = 0; i < sheet.length; i += 3) {
    assert.equal(sheet[i + 1], 2, 'the sheet lies at the block water level');
    maxX = Math.max(maxX, sheet[i]); minX = Math.min(minX, sheet[i]);
  }
  assert.equal(minX, 0);
  assert.ok(maxX <= 4.5 + 1e-6, `the sheet stops one cell past the flooded room (${maxX})`);
  assert.equal(stats[0].wet, 64);
  assert.deepEqual(waterSurfaceTriangles(world, []).positions.length, 0);
});
