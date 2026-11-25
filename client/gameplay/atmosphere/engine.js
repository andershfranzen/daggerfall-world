// Web Audio engine for the player's own Daggerfall sound and music archives.
//
// Sources, both read lazily from the folder the player selected and never uploaded:
//   ARENA2/DAGGER.SND  sound effects: unsigned 8-bit mono PCM at 11025 Hz per record
//                      (DFU SndFile.cs, via daggerfall-js-source sndFile.js/audio.js)
//   ARENA2/MIDI.BSA    music: HMI songs, decoded by ./hmi.js and played by ./synth.js
// Nothing is synthesised in place of a missing archive: without DAGGER.SND there are no
// effects, without MIDI.BSA no music, and the panel says which is missing.
//
// The AudioContext is created suspended-safe and only resumed from a user gesture.

import { BsaArchive, NAME_RECORD, NUMBER_RECORD } from '../../world/bsa.js';
import { HmiFile } from './hmi.js';
import { SongPlayer } from './synth.js';
import { busGains, normalizePrefs } from './prefs.js';

export const SND_RATE = 11025;
export const SOUND_FILES = ['DAGGER.SND'];
export const MUSIC_FILES = ['MIDI.BSA'];

/** Unsigned 8-bit PCM → Float32 samples, (b - 128) / 128 as in DFU's reader. */
export function pcm8ToFloat32(bytes) {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] - 128) / 128;
  return out;
}

const baseName = (f) => String(f?.webkitRelativePath || f?.relativePath || f?.name || '').split(/[\\/]/).pop().toUpperCase();

/** Find the sound and music archives among selected files. */
export function findAudioFiles(files) {
  const out = { snd: null, midi: null };
  for (const f of files ?? []) {
    if (!f || typeof f.slice !== 'function') continue;
    const n = baseName(f);
    if (!out.snd && SOUND_FILES.includes(n)) out.snd = f;
    if (!out.midi && MUSIC_FILES.includes(n)) out.midi = f;
  }
  return out;
}

export class AudioEngine {
  constructor({ prefs, AudioContextCtor = globalThis.AudioContext ?? globalThis.webkitAudioContext } = {}) {
    this.prefs = normalizePrefs(prefs);
    this.Ctor = AudioContextCtor;
    this.ctx = null;
    this.snd = null;
    this.midi = null;
    this.songNames = new Set();
    this.clipCache = new Map();
    this.loops = new Map();
    this.player = null;
    this.currentSong = null;
    this.wantedSong = null;
    this.error = null;
    this.loading = null;
    this.paused = false;
    this.listeners = new Set();
  }

  get supported() { return typeof this.Ctor === 'function'; }
  get running() { return this.ctx?.state === 'running'; }

  status() {
    return {
      supported: this.supported,
      running: this.running,
      sounds: !!this.snd,
      clipCount: this.snd?.count ?? 0,
      music: !!this.midi,
      songCount: this.midi?.count ?? 0,
      song: this.currentSong,
      error: this.error,
      paused: this.paused,
    };
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _changed() { for (const fn of this.listeners) { try { fn(this.status()); } catch { /* listener */ } } }

  /** Index the archives from the player's files. Safe to call again with a new folder. */
  async setFiles(files) {
    const { snd, midi } = findAudioFiles(files);
    this.stopAll();
    this.clipCache.clear();
    this.snd = null; this.midi = null; this.songNames = new Set(); this.error = null;
    const job = (async () => {
      const problems = [];
      if (snd) {
        try { this.snd = await BsaArchive.open(snd, 'DAGGER.SND', NUMBER_RECORD); } catch (e) { problems.push(e.message); }
      }
      if (midi) {
        try {
          this.midi = await BsaArchive.open(midi, 'MIDI.BSA', NAME_RECORD);
          this.songNames = new Set(this.midi.entries.map((e) => e.name));
        } catch (e) { problems.push(e.message); }
      }
      this.error = problems.length ? problems.join(' ') : null;
    })();
    this.loading = job;
    await job;
    if (this.loading === job) this.loading = null;
    this._changed();
    if (this.wantedSong) this.playSong(this.wantedSong);
    return this.status();
  }

  /** Create or resume the context. Call from a user gesture. */
  async unlock() {
    if (!this.supported) return false;
    if (!this.ctx) {
      this.ctx = new this.Ctor();
      this.bus = {};
      this.bus.master = this.ctx.createGain();
      this.bus.master.connect(this.ctx.destination);
      for (const k of ['music', 'effects', 'ambience']) {
        this.bus[k] = this.ctx.createGain();
        this.bus[k].connect(this.bus.master);
      }
      this.applyPrefs(this.prefs);
      this.ctx.onstatechange = () => this._changed();
    }
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* needs a gesture */ }
    }
    this._changed();
    if (this.running && this.wantedSong && !this.currentSong) this.playSong(this.wantedSong);
    return this.running;
  }

  applyPrefs(prefs) {
    this.prefs = normalizePrefs(prefs);
    if (!this.ctx) return;
    const g = busGains(this.prefs);
    const t = this.ctx.currentTime;
    for (const k of ['master', 'music', 'effects', 'ambience']) this.bus[k].gain.setTargetAtTime(this.ducked && k !== 'master' ? 0 : g[k] * (k !== 'master' ? this.filterGain ?? 1 : 1), t, 0.03);
    if (!this.prefs.musicEnabled) this.stopMusic();
    else if (this.wantedSong && !this.currentSong) this.playSong(this.wantedSong);
  }

  /** Silence music, effects and ambience (a movie is playing through the master bus). */
  duck(on) {
    this.ducked = !!on;
    this.applyPrefs(this.prefs);
  }

  /**
   * Underwater: a low-pass on everything below master and a little quieter. `on` false restores.
   * DFU muffles world audio while the player is submerged.
   */
  setUnderwater(on) {
    on = !!on;
    if (this.underwater === on) return;
    this.underwater = on;
    if (!this.ctx) return;
    if (!this.lowpass) {
      this.lowpass = this.ctx.createBiquadFilter();
      this.lowpass.type = 'lowpass';
      this.lowpass.frequency.value = 22050;
      this.lowpass.connect(this.bus.master);
      for (const k of ['music', 'effects', 'ambience']) { this.bus[k].disconnect(); this.bus[k].connect(this.lowpass); }
    }
    this.lowpass.frequency.setTargetAtTime(on ? 700 : 22050, this.ctx.currentTime, 0.08);
    this.filterGain = on ? 0.7 : 1;
    this.applyPrefs(this.prefs);
  }

  /** Pause everything (e.g. leaving the game screen) without forgetting what was wanted. */
  setPaused(paused) {
    this.paused = !!paused;
    if (this.paused) {
      this.player?.stop(0.3);
      this.currentSong = null;
      for (const id of [...this.loops.keys()]) this.stopLoop(id);
    } else if (this.wantedSong) {
      this.playSong(this.wantedSong);
    }
    this._changed();
  }

  async _buffer(index) {
    if (!this.snd || !this.ctx) return null;
    if (this.clipCache.has(index)) return this.clipCache.get(index);
    const p = (async () => {
      if (index < 0 || index >= this.snd.count) return null;
      const bytes = await this.snd.read(index);
      if (!bytes.length) return null;
      const buf = this.ctx.createBuffer(1, bytes.length, SND_RATE);
      buf.getChannelData(0).set(pcm8ToFloat32(bytes));
      return buf;
    })().catch(() => null);
    this.clipCache.set(index, p);
    return p;
  }

  /** One-shot DAGGER.SND clip by SoundClips index. */
  async playClip(index, { bus = 'effects', volume = 1, pan = 0, rate = 1 } = {}) {
    if (!this.running || this.paused) return false;
    const buf = await this._buffer(index);
    if (!buf || !this.running) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    let tail = g;
    if (pan && this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p); tail = p;
    }
    src.connect(g);
    tail.connect(this.bus[bus] ?? this.bus.effects);
    src.onended = () => { try { src.disconnect(); g.disconnect(); tail.disconnect(); } catch { /* gone */ } };
    src.start();
    return true;
  }

  async startLoop(index, { bus = 'ambience', volume = 1 } = {}) {
    if (this.loops.has(index) || !this.running || this.paused) return;
    this.loops.set(index, null);
    const buf = await this._buffer(index);
    if (!buf || !this.loops.has(index) || this.loops.get(index)) { if (!buf) this.loops.delete(index); return; }
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, this.ctx.currentTime);
    g.gain.linearRampToValueAtTime(volume, this.ctx.currentTime + 1.5);
    src.connect(g); g.connect(this.bus[bus]);
    src.start();
    this.loops.set(index, { src, g });
  }

  stopLoop(index) {
    const l = this.loops.get(index);
    this.loops.delete(index);
    if (!l || !this.ctx) return;
    const t = this.ctx.currentTime;
    l.g.gain.cancelScheduledValues(t);
    l.g.gain.setTargetAtTime(0, t, 0.3);
    l.src.stop(t + 1.5);
    l.src.onended = () => { try { l.src.disconnect(); l.g.disconnect(); } catch { /* gone */ } };
  }

  /** Make exactly these clips loop on the ambience bus. */
  setLoops(indices) {
    const want = new Set(indices);
    for (const id of [...this.loops.keys()]) if (!want.has(id)) this.stopLoop(id);
    for (const id of want) this.startLoop(id);
  }

  async playSong(name) {
    this.wantedSong = name;
    if (!name || !this.midi || !this.running || this.paused || !this.prefs.musicEnabled) return false;
    if (this.currentSong === name && this.player?.playing) return true;
    const index = this.midi.indexOfName(name);
    if (index < 0) return false;
    try {
      const song = new HmiFile();
      if (!song.load(await this.midi.read(index), name)) throw new Error(`${name} is not an HMI song`);
      if (this.wantedSong !== name || this.paused) return false;
      if (!this.player) this.player = new SongPlayer(this.ctx, this.bus.music);
      this.player.play(song);
      this.currentSong = name;
      this.error = null;
    } catch (e) {
      this.error = `Could not play ${name}: ${e.message}`;
      this.currentSong = null;
    }
    this._changed();
    return !!this.currentSong;
  }

  stopMusic() {
    this.player?.stop();
    if (this.currentSong) { this.currentSong = null; this._changed(); }
  }

  stopAll() {
    this.stopMusic();
    for (const id of [...this.loops.keys()]) this.stopLoop(id);
  }
}
