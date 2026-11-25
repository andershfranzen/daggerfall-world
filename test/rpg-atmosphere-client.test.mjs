// Browser-side atmosphere: preferences, song choice, event sounds, lighting, HMI decoding,
// the synth planner, and (when a local ARENA2 is present) the real DAGGER.SND / MIDI.BSA.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, openAsBlob } from 'node:fs';
import { join } from 'node:path';

import { normalizePrefs, loadPrefs, savePrefs, busGains, DEFAULT_PREFS, PREFS_KEY } from '../client/gameplay/atmosphere/prefs.js';
import { SONGS, chooseSong, sceneKind, clipsForEvent, ambienceFor, footstepClips, CLIP, dfRand } from '../client/gameplay/atmosphere/playlists.js';
import { lightFor, applyLight, restoreLight, BASE_PALETTE } from '../client/gameplay/atmosphere/light.js';
import { fogDistances, OUTDOOR_FAR } from '../client/render/visibility.js';
import { PALETTE } from '../client/render/renderer.js';
import { HmiFile } from '../client/gameplay/atmosphere/hmi.js';
import { planSong, channelReset, voiceSpec, percussionSpec, noteToHz } from '../client/gameplay/atmosphere/synth.js';
import { pcm8ToFloat32, findAudioFiles, AudioEngine } from '../client/gameplay/atmosphere/engine.js';
import { particleCount } from '../client/gameplay/atmosphere/weather.js';
import { seaSound } from '../client/gameplay/sailing/sound.js';
import { BsaArchive, NAME_RECORD, NUMBER_RECORD } from '../client/world/bsa.js';

const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m }; };

test('preferences persist, clamp and survive garbage', () => {
  const s = memStore();
  assert.deepEqual(loadPrefs(s), normalizePrefs(null));
  assert.deepEqual(normalizePrefs(null), { ...DEFAULT_PREFS });
  savePrefs(s, { master: 2, music: -1, effects: '0.3', muted: true, arrangement: 'fm', musicEnabled: false });
  const p = loadPrefs(s);
  assert.equal(p.master, 1);
  assert.equal(p.music, 0);
  assert.equal(p.effects, 0.3);
  assert.equal(p.muted, true);
  assert.equal(p.arrangement, 'fm');
  assert.equal(p.musicEnabled, false);
  s.setItem(PREFS_KEY, '{not json');
  assert.deepEqual(loadPrefs(s), normalizePrefs(null));
  assert.deepEqual(loadPrefs(null), normalizePrefs(null));
  assert.equal(busGains({ ...DEFAULT_PREFS, muted: true }).master, 0);
  assert.equal(busGains({ ...DEFAULT_PREFS, musicEnabled: false }).music, 0);
  assert.equal(busGains(DEFAULT_PREFS).effects, DEFAULT_PREFS.effects);
});

test('scene kinds follow location, night and weather', () => {
  assert.equal(sceneKind('town:Daggerfall/Gothway Garden', { weather: 'sunny' }), 'sunny');
  assert.equal(sceneKind('town:Daggerfall/Gothway Garden', { night: true, weather: 'rain' }), 'night');
  assert.equal(sceneKind('town:Daggerfall/Gothway Garden', { weather: 'thunder' }), 'rain');
  assert.equal(sceneKind('town:Daggerfall/Gothway Garden', { weather: 'fog' }), 'overcast');
  assert.equal(sceneKind('town:Wayrest', { weather: 'snow' }), 'snow');
  assert.equal(sceneKind("dungeon:Privateer's Hold"), 'dungeon');
  assert.equal(sceneKind('interior:Daggerfall/The Bat and Barrel'), 'tavern');
  assert.equal(sceneKind('interior:Daggerfall/Temple of Kynareth'), 'temple');
  assert.equal(sceneKind('interior:Daggerfall/The Odd Blades Armorer'), 'shop');
  assert.equal(sceneKind('interior:Daggerfall/Mages Guild'), 'guild');
  assert.equal(sceneKind('interior:Daggerfall/Castle Daggerfall'), 'palace');
  assert.equal(sceneKind('interior:Daggerfall/House'), 'interior');
});

test('song choice is stable per game day, respects the arrangement and the archive', () => {
  const a = chooseSong('sunny', { gameDays: 1234 });
  assert.equal(chooseSong('sunny', { gameDays: 1234 }), a);
  assert.ok(SONGS.sunny.includes(a));
  assert.equal(a, SONGS.sunny[dfRand(1234) % SONGS.sunny.length]);
  assert.ok(SONGS.sunnyFM.includes(chooseSong('sunny', { fm: true, gameDays: 5 })));
  assert.equal(chooseSong('tavern', { gameDays: 7 }), SONGS.tavern[7 % 5]);
  assert.equal(chooseSong('temple', { gameDays: 99 }), 'GNEUT.HMI');
  assert.equal(chooseSong('guild', { random: () => 0.99 }), 'MAGIC_2.HMI');
  // Only songs present in the player's archive are chosen; FM falls back to GM.
  assert.equal(chooseSong('rain', { available: new Set(['RAINING.HMI']) }), 'RAINING.HMI');
  assert.equal(chooseSong('rain', { fm: true, available: new Set(['RAINING.HMI']) }), 'RAINING.HMI');
  assert.equal(chooseSong('rain', { available: new Set() }), null);
  // Daggerfall's LCG: srand(0), rand() = (12345 >> 16) & 0x7fff = 0.
  assert.equal(dfRand(0), 0);
  assert.equal(dfRand(1), ((1103515245 + 12345) >>> 16) & 0x7fff);
});

test('gameplay events map to Daggerfall clip numbers', () => {
  const swing = clipsForEvent({ kind: 'swing', playerId: 3, direction: 'down' }, { selfId: '3', rand: () => 0 });
  assert.deepEqual(swing, [{ clip: CLIP.SwingLowPitch, self: true }]);
  assert.equal(clipsForEvent({ kind: 'swing', playerId: 4 }, { selfId: 3 })[0].self, false);
  const hit = clipsForEvent({ kind: 'hit', targetId: 3 }, { selfId: 3, rand: () => 0.99 });
  assert.equal(hit[0].clip, CLIP.Hit5);
  assert.equal(hit[0].self, true);
  assert.deepEqual(clipsForEvent({ kind: 'chat' }), []);
  assert.deepEqual(clipsForEvent(null), []);
  assert.equal(CLIP.SwingLowPitch, 105);
  assert.equal(CLIP.AmbientRaining, 389);
  const wet = ambienceFor({ kind: 'rain', night: false, weather: 'rain', indoors: false });
  assert.deepEqual(wet.loops, [CLIP.AmbientRaining]);
  const night = ambienceFor({ kind: 'night', night: true, weather: 'sunny', indoors: false });
  assert.deepEqual(night.loops, [CLIP.AmbientCrickets]);
  assert.deepEqual(ambienceFor({ kind: 'tavern', night: true, weather: 'sunny', indoors: true }), { loops: [], shots: [] });
  assert.deepEqual(footstepClips({ indoors: false, weather: 'snow' }), [CLIP.PlayerFootstepSnow1, CLIP.PlayerFootstepSnow2]);
});

test('a broadside is heard relative to the moving ship and storm surf replaces calm water', () => {
  const ship = { x: 7050, z: 1600, yaw: Math.PI / 2 };
  const shot = { kind: 'naval.shot', balls: [{ p0: [7050, 3, 1670] }] };
  const forward = seaSound(shot, ship, 0), aft = seaSound(shot, ship, Math.PI);
  assert.ok(forward.pan > 0.8 && aft.pan < -0.8);
  for (const [type, bow] of [['small', Math.PI / 2], ['large', Math.PI]]) {
    assert.equal(seaSound(shot, { ...ship, type }, bow).pan, forward.pan);
  }
  assert.equal(seaSound(shot, null), null);
  assert.equal(seaSound({ ...shot, balls: [] }, ship), null);
  assert.equal(seaSound(shot, { ...ship, x: 0 }), null);
  assert.equal(seaSound({ kind: 'naval.hit', zone: 'water', point: [7051, 0, 1600] }, ship).clip, CLIP.SplashLarge);
  const deck = { indoors: false, atSea: true, night: true };
  assert.deepEqual(ambienceFor({ ...deck, weather: 'sunny' }).loops, [CLIP.WaterGentle]);
  assert.deepEqual(ambienceFor({ ...deck, weather: 'thunder' }).loops, [CLIP.AmbientRaining, CLIP.WaterRough]);
  assert.deepEqual(ambienceFor({ ...deck, indoors: true, weather: 'sunny' }).loops, []);
});

test('light adapter darkens at night, greys in rain, restores the renderer', () => {
  const noon = lightFor({ minuteOfDay: 720, weather: 'sunny' });
  const midnight = lightFor({ minuteOfDay: 0, weather: 'sunny' });
  const rain = lightFor({ minuteOfDay: 720, weather: 'rain' });
  assert.deepEqual(noon.zenith.map((v) => +v.toFixed(6)), BASE_PALETTE.zenith.map((v) => +v.toFixed(6)));
  assert.equal(noon.shadeCss, 'rgb(255 255 255)');
  assert.ok(midnight.shade[0] < 0.3 && midnight.shade[2] > midnight.shade[0], 'cool, dark night');
  assert.ok(midnight.zenith[2] < noon.zenith[2]);
  assert.ok(rain.fogScale < 1 && rain.shade[0] < 1);
  assert.deepEqual(fogDistances(OUTDOOR_FAR, noon.fogScale, true), [30, 2400]);
  assert.equal(fogDistances(OUTDOOR_FAR, 0.22, true)[1], 528);
  assert.deepEqual(fogDistances(800, 0.22, false), fogDistances(800, 1, false));
  assert.equal(lightFor({ minuteOfDay: 0, indoors: true }).shadeCss, 'rgb(255 255 255)');
  assert.ok(midnight.sunDir[1] > 0, 'moonlight from above');

  const r = { sunDir: [0.4, 0.7, 0.3], far: 800 };
  applyLight(r, lightFor({ minuteOfDay: 720, weather: 'fog' }));
  assert.equal(r.far, 800);
  assert.equal(r.fogScale, 0.22);
  assert.notDeepEqual(PALETTE.horizon, [...BASE_PALETTE.horizon]);
  r.far = 1000; // a new town arrived and resized the fog
  applyLight(r, lightFor({ minuteOfDay: 720, weather: 'sunny' }));
  assert.equal(r.far, 1000);
  applyLight(r, lightFor({ minuteOfDay: 720, weather: 'fog' }));
  restoreLight(r);
  assert.equal(r.far, 1000);
  assert.equal(r.fogScale, 1);
  assert.deepEqual(r.sunDir, [0.4, 0.7, 0.3]);
  assert.deepEqual([...PALETTE.horizon], [...BASE_PALETTE.horizon]);

  // Another feature (scenery's classic sky) writes PALETTE: noon keeps its colours, restore keeps them.
  PALETTE.horizon.splice(0, 3, 0.5, 0.6, 0.7);
  applyLight(r, lightFor({ minuteOfDay: 0, weather: 'sunny' }));
  assert.ok(PALETTE.horizon[2] < 0.5, 'night darkens the adopted sky');
  applyLight(r, lightFor({ minuteOfDay: 720, weather: 'sunny' }));
  assert.deepEqual(PALETTE.horizon.map((v) => +v.toFixed(6)), [0.5, 0.6, 0.7]);
  restoreLight(r);
  assert.deepEqual(PALETTE.horizon.map((v) => +v.toFixed(6)), [0.5, 0.6, 0.7]);
  PALETTE.horizon.splice(0, 3, ...BASE_PALETTE.horizon);
});

test('weather particle budget scales with intensity and reduced motion', () => {
  assert.equal(particleCount('sunny'), 0);
  assert.ok(particleCount('rain', 1) > particleCount('rain', 0.5));
  assert.ok(particleCount('snow', 1, true) < particleCount('snow', 1, false));
  assert.ok(particleCount('thunder', 1) <= 420);
});

/** Build a minimal one-track HMI song in memory (test fixture, not game data). */
function fixtureSong({ bpm = 120, events }) {
  const trackHeader = 0xb0; // data offset
  const body = [1, 0x80, 0x01, 0x00, 0x00, 0x00, 0x00, ...events, 0x00, 0xff, 0x2f, 0x00];
  const track = new Uint8Array(trackHeader + body.length);
  track.set([...'HMI-MIDITRACK'].map((c) => c.charCodeAt(0)), 0);
  new DataView(track.buffer).setUint32(0x63, trackHeader, true);
  track[0x79] = 0;
  track.set(body, trackHeader);
  const head = 0x172 + 8;
  const out = new Uint8Array(head + track.length + 16);
  out.set([...'HMI-MIDISONG061595'].map((c) => c.charCodeAt(0)), 0);
  const v = new DataView(out.buffer);
  v.setUint16(0xd2, 480, true);
  v.setUint16(0xd4, bpm, true);
  v.setUint32(0xe4, 1, true);
  v.setUint32(0xe8, 0x172, true);
  v.setUint32(0x172, head, true);
  out.set(track, head);
  return out;
}

test('HMI reader decodes durations into note pairs; planner applies controllers', () => {
  // program 40 on ch0, volume 64, then two notes: C4 for 60 ticks, E4 for 30 ticks 60 ticks later.
  const bytes = fixtureSong({ events: [0x00, 0xc0, 40, 0x00, 0xb0, 7, 64, 0x00, 0x90, 60, 100, 60, 0x3c, 64, 90, 30] });
  const song = new HmiFile();
  assert.equal(song.load(bytes, 'TEST.HMI'), true);
  assert.equal(song.trackCount, 1);
  assert.equal(song.secondsPerTick, 1 / 120);
  assert.equal(song.durationTicks, 90);
  const ons = song.events.filter((e) => e.type === 'noteOn');
  assert.deepEqual(ons.map((e) => [e.tick, e.note, e.duration]), [[0, 60, 60], [60, 64, 30]]);
  assert.equal(new HmiFile().load(new Uint8Array(400), 'X'), false);

  const ch = channelReset();
  const first = planSong(song.events, 0, 30, ch);
  assert.equal(first.notes.length, 1);
  assert.equal(first.notes[0].program, 40);
  assert.ok(Math.abs(first.notes[0].gain - (100 / 127) ** 2 * (64 / 127) ** 2) < 1e-9);
  const rest = planSong(song.events, first.cursor, 1000, ch);
  assert.deepEqual(rest.notes.map((n) => n.note), [64]);
  assert.equal(rest.cursor, song.events.length);
  assert.equal(voiceSpec(40).family, 'strings');
  assert.equal(percussionSpec(200).key, 87);
  assert.equal(noteToHz(69), 440);
});

test('8-bit PCM converts as DFU does and audio files are found by name', () => {
  assert.deepEqual([...pcm8ToFloat32(new Uint8Array([0, 128, 255]))], [-1, 0, 127 / 128]);
  const f = (name, rel) => ({ name, webkitRelativePath: rel ?? name, size: 1, slice() {} });
  const found = findAudioFiles([f('MAPS.BSA'), f('dagger.snd', 'DF/ARENA2/dagger.snd'), f('MIDI.BSA')]);
  assert.equal(found.snd.name, 'dagger.snd');
  assert.equal(found.midi.name, 'MIDI.BSA');
  assert.deepEqual(findAudioFiles([f('MAPS.BSA')]), { snd: null, midi: null });
  const e = new AudioEngine({ AudioContextCtor: null });
  assert.equal(e.status().supported, false);
  assert.equal(e.status().sounds, false);
});

// ---- local install (never committed; skipped when absent)
const ARENA2 = process.env.DFW_ARENA2 || join(import.meta.dirname, '..', 'gamedata', 'DaggerfallGameFiles', 'arena2');
const haveAudio = existsSync(join(ARENA2, 'MIDI.BSA')) && existsSync(join(ARENA2, 'DAGGER.SND'));

test('local ARENA2: every MIDI.BSA song decodes and every playlist entry exists', { skip: !haveAudio && 'no local ARENA2 audio' }, async () => {
  const midi = await BsaArchive.open(await openAsBlob(join(ARENA2, 'MIDI.BSA')), 'MIDI.BSA', NAME_RECORD);
  const names = new Set(midi.entries.map((e) => e.name));
  for (const list of Object.values(SONGS)) for (const n of list) assert.ok(names.has(n), `${n} in MIDI.BSA`);
  let seconds = 0;
  for (let i = 0; i < midi.count; i++) {
    const s = new HmiFile();
    assert.ok(s.load(await midi.read(i), midi.entries[i].name));
    seconds += s.durationSeconds;
    const { notes } = planSong(s.events, 0, s.durationTicks + 1, channelReset());
    for (const n of notes) assert.ok(Number.isFinite(n.gain) && Number.isFinite(n.cents));
  }
  assert.ok(seconds > 60 * 60, 'over an hour of music');
});

test('local ARENA2: DAGGER.SND holds every clip the game uses', { skip: !haveAudio && 'no local ARENA2 audio' }, async () => {
  const snd = await BsaArchive.open(await openAsBlob(join(ARENA2, 'DAGGER.SND')), 'DAGGER.SND', NUMBER_RECORD);
  for (const [name, index] of Object.entries(CLIP)) {
    assert.ok(index < snd.count, name);
    assert.ok(snd.entries[index].size > 200, `${name} has samples`);
  }
});
