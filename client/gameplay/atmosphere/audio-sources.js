// Custom local audio sources (alternate music tracks & soundfont / instrument banks)
// for client/gameplay/atmosphere/engine.js, with clean reset to the classic FM synth
// that stays intact across scene crossings.
//
// All audio stays strictly local in the browser (never uploaded to the server).

import { voiceSpec, noteToHz, percussionSpec } from './synth.js';

export const AUDIO_SOURCE_PREFS_KEY = 'daggerfallworld.audioSources.v1';

export const AUDIO_SCENE_KEYS = Object.freeze([
  'default',
  'town_day',
  'town_night',
  'dungeon',
  'tavern',
  'wilderness',
  'raining',
  'snowing',
  'palace',
  'temple',
  'shop',
  'sea',
]);

export const BUILTIN_SOUNDFONT_PROFILES = Object.freeze({
  classic: Object.freeze({
    id: 'classic',
    name: 'Classic FM Synth (Built-in)',
    format: 'classic',
    description: 'Default Daggerfall World two-operator FM synthesiser.',
    masterGain: 1.0,
    families: {},
  }),
  'warm-orchestral': Object.freeze({
    id: 'warm-orchestral',
    name: 'Warm Orchestral Bank (Sample)',
    format: 'dfw-soundfont',
    description: 'Softer strings, brass, and pipe envelopes inspired by SC-55 / General MIDI soundfonts.',
    masterGain: 1.05,
    families: {
      piano: { index: 1.8, attack: 0.008, decay: 0.65, sustain: 0.25, release: 0.42, gain: 0.85 },
      strings: { index: 0.75, attack: 0.14, decay: 0.35, sustain: 0.86, release: 0.55, gain: 0.72 },
      ensemble: { index: 0.9, attack: 0.18, decay: 0.35, sustain: 0.88, release: 0.62, gain: 0.68 },
      brass: { index: 2.3, attack: 0.06, decay: 0.28, sustain: 0.8, release: 0.28, gain: 0.7 },
      pipe: { index: 0.55, attack: 0.06, decay: 0.2, sustain: 0.9, release: 0.28, gain: 0.68 },
      organ: { index: 0.95, attack: 0.02, decay: 0.1, sustain: 0.95, release: 0.18, gain: 0.62 },
    },
  }),
});

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function readAscii(bytes, offset, len) {
  let out = '';
  for (let i = 0; i < len && offset + i < bytes.length; i++) {
    const ch = bytes[offset + i];
    if (ch === 0) break;
    if (ch >= 32 && ch <= 126) out += String.fromCharCode(ch);
  }
  return out.trim();
}

/**
 * Parse a SoundFont2 (.sf2) RIFF binary header to validate format and extract metadata/preset names,
 * mapping them to Web Audio synth bank overrides with clean fallback.
 */
export function parseSf2Header(buffer, fileName = 'custom.sf2') {
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : ArrayBuffer.isView(buffer)
        ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        : null;
  if (!bytes || bytes.length < 12) throw new Error('SoundFont file is too short.');
  const riff = readAscii(bytes, 0, 4);
  const form = readAscii(bytes, 8, 4);
  if (riff !== 'RIFF' || form !== 'sfbk') {
    throw new Error('Invalid SF2 file: expected RIFF/sfbk SoundFont header.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let name = String(fileName).replace(/\.sf2$/i, '') || 'Custom SF2';
  const presets = [];
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = readAscii(bytes, pos, 4);
    const size = view.getUint32(pos + 4, true);
    const end = Math.min(bytes.length, pos + 8 + size);
    if (id === 'LIST' && pos + 12 <= bytes.length) {
      const listType = readAscii(bytes, pos + 8, 4);
      let sub = pos + 12;
      while (sub + 8 <= end) {
        const sid = readAscii(bytes, sub, 4);
        const ssize = view.getUint32(sub + 4, true);
        const sdata = sub + 8;
        if (listType === 'INFO' && sid === 'INAM' && ssize > 0) {
          const found = readAscii(bytes, sdata, Math.min(ssize, end - sdata));
          if (found) name = found;
        } else if (listType === 'pdta' && sid === 'phdr') {
          // Each SF2 preset header record is 38 bytes: 20-byte name, uint16 preset, uint16 bank, ...
          for (let p = sdata; p + 38 <= Math.min(end, sdata + ssize); p += 38) {
            const pname = readAscii(bytes, p, 20);
            if (!pname || pname === 'EOP') continue;
            const preset = view.getUint16(p + 20, true);
            const bank = view.getUint16(p + 22, true);
            presets.push({ name: pname, preset, bank });
          }
        }
        sub += 8 + ssize + (ssize & 1);
      }
    }
    pos += 8 + size + (size & 1);
  }
  // Derive tuned timbral profile from the SF2 preset catalogue.
  const hasStrings = presets.some((p) => /string|violin|cello|harp/i.test(p.name));
  const hasBrass = presets.some((p) => /brass|horn|trumpet|tuba/i.test(p.name));
  return {
    id: `sf2:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'custom'}`,
    name,
    format: 'sf2',
    fileName,
    byteLength: bytes.length,
    presetCount: presets.length,
    presets: presets.slice(0, 128),
    masterGain: 1.0,
    families: {
      ...BUILTIN_SOUNDFONT_PROFILES['warm-orchestral'].families,
      ...(hasStrings ? { strings: { index: 0.65, attack: 0.16, decay: 0.4, sustain: 0.88, release: 0.6, gain: 0.76 } } : {}),
      ...(hasBrass ? { brass: { index: 2.1, attack: 0.055, decay: 0.25, sustain: 0.82, release: 0.26, gain: 0.74 } } : {}),
    },
  };
}

/**
 * Parse and validate a custom JSON soundfont/instrument bank definition.
 */
export function parseSoundfontBank(input, fileName = 'custom-bank.json') {
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    return parseSf2Header(input, fileName);
  }
  const obj = typeof input === 'string' ? JSON.parse(input) : input;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('Soundfont bank must be a JSON object or SF2 binary.');
  }
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 80) : String(fileName);
  const id = typeof obj.id === 'string' && /^[\w:-]{1,64}$/.test(obj.id)
    ? obj.id
    : `bank:${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || 'custom'}`;
  const rawFam = obj.families && typeof obj.families === 'object' && !Array.isArray(obj.families) ? obj.families : {};
  const families = {};
  const numericFields = ['car', 'mod', 'index', 'idxDecay', 'attack', 'decay', 'sustain', 'release', 'gain'];
  for (const [fam, patch] of Object.entries(rawFam)) {
    if (FORBIDDEN_KEYS.has(fam) || !patch || typeof patch !== 'object' || Array.isArray(patch)) continue;
    const clean = {};
    for (const k of numericFields) {
      if (Number.isFinite(Number(patch[k]))) clean[k] = Number(patch[k]);
    }
    if (typeof patch.wave === 'string' && ['sine', 'triangle', 'sawtooth', 'square'].includes(patch.wave)) {
      clean.wave = patch.wave;
    }
    if (Object.keys(clean).length) families[fam] = clean;
  }
  const masterGain = Number.isFinite(Number(obj.masterGain)) ? Math.min(2, Math.max(0.1, Number(obj.masterGain))) : 1.0;
  return {
    id,
    name,
    format: obj.format === 'sf2' ? 'sf2' : 'dfw-soundfont',
    description: typeof obj.description === 'string' ? obj.description.slice(0, 200) : '',
    masterGain,
    families,
    presetCount: Object.keys(families).length,
  };
}

/** Merge a custom soundfont bank over the classic FM voiceSpec for a GM program number. */
export function resolveVoiceSpec(program, soundfont = null) {
  const base = voiceSpec(program);
  if (!soundfont || !soundfont.families) return { ...base, wave: 'sine', masterGain: 1 };
  const override = soundfont.families[base.family];
  if (!override) return { ...base, wave: 'sine', masterGain: soundfont.masterGain ?? 1 };
  return {
    ...base,
    ...override,
    wave: override.wave || 'sine',
    masterGain: soundfont.masterGain ?? 1,
  };
}

function normalizeSceneKey(raw) {
  const k = String(raw ?? 'default').trim();
  if (!k) return 'default';
  if (AUDIO_SCENE_KEYS.includes(k.toLowerCase())) return k.toLowerCase();
  return k.toUpperCase(); // specific HMI song name like SONG_G01.HMI
}

/**
 * Manages custom local soundfonts and custom per-scene / per-song local audio tracks,
 * hooking cleanly onto an AudioEngine instance and supporting clean reset to classic synth.
 */
export class AudioSourceManager {
  constructor({ storage = null, decodeAudioData = null } = {}) {
    this.storage = storage ?? (() => { try { return globalThis.localStorage; } catch { return null; } })();
    this.decodeAudioData = decodeAudioData;
    this.mode = 'classic'; // 'classic' | 'custom'
    this.soundfont = null; // parsed bank or null (= classic FM synth)
    this.tracks = new Map(); // sceneKey or SONG.HMI -> { key, name, buffer?, arrayBuffer?, mimeType? }
    this.sceneKind = 'town_day';
    this.engine = null;
    this._origPlaySong = null;
    this._origStopMusic = null;
    this._origSetPaused = null;
    this._customNode = null;
    this._customGain = null;
    this._activeCustomTrack = null;
    this._patchedPlayer = null;
    this._origPlayerVoice = null;
    this._listeners = new Set();
    this._loadPersistedMeta();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    const st = this.status();
    for (const fn of this._listeners) {
      try { fn(st); } catch { /* ignore listener errors */ }
    }
  }

  _loadPersistedMeta() {
    try {
      const raw = this.storage?.getItem?.(AUDIO_SOURCE_PREFS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed?.mode === 'custom' && parsed?.soundfont) {
        if (BUILTIN_SOUNDFONT_PROFILES[parsed.soundfont.id]) {
          this.soundfont = BUILTIN_SOUNDFONT_PROFILES[parsed.soundfont.id];
          this.mode = 'custom';
        } else {
          this.soundfont = parseSoundfontBank(parsed.soundfont);
          this.mode = 'custom';
        }
      }
    } catch { /* ignore invalid saved state */ }
  }

  _saveMeta() {
    try {
      this.storage?.setItem?.(AUDIO_SOURCE_PREFS_KEY, JSON.stringify({
        mode: this.mode,
        soundfont: this.soundfont && this.soundfont.format !== 'sf2' ? this.soundfont : (this.soundfont ? { id: this.soundfont.id, name: this.soundfont.name, format: 'dfw-soundfont', masterGain: this.soundfont.masterGain, families: this.soundfont.families } : null),
      }));
    } catch { /* ignore storage failure */ }
  }

  status() {
    return {
      mode: this.mode,
      soundfont: this.soundfont ? {
        id: this.soundfont.id,
        name: this.soundfont.name,
        format: this.soundfont.format,
        presetCount: this.soundfont.presetCount ?? Object.keys(this.soundfont.families ?? {}).length,
      } : null,
      tracks: [...this.tracks.values()].map((t) => ({ key: t.key, name: t.name, decoded: !!t.buffer })),
      activeCustomTrack: this._activeCustomTrack,
      sceneKind: this.sceneKind,
      classicActive: this.mode === 'classic' && !this.soundfont && !this._activeCustomTrack,
    };
  }

  /** Attach to an AudioEngine without modifying engine.js. */
  attachEngine(engine) {
    if (!engine || this.engine === engine) return this;
    this.detachEngine();
    this.engine = engine;
    this._origPlaySong = engine.playSong.bind(engine);
    this._origStopMusic = engine.stopMusic.bind(engine);
    this._origSetPaused = engine.setPaused.bind(engine);

    const self = this;
    engine.playSong = async function patchedPlaySong(name) {
      return self._handlePlaySong(name);
    };
    engine.stopMusic = function patchedStopMusic() {
      self._stopCustomTrack();
      return self._origStopMusic();
    };
    engine.setPaused = function patchedSetPaused(paused) {
      if (paused) self._stopCustomTrack();
      const res = self._origSetPaused(paused);
      if (!paused && self.mode === 'custom' && engine.wantedSong) {
        self._handlePlaySong(engine.wantedSong);
      }
      return res;
    };
    this._syncPlayerPatch();
    return this;
  }

  detachEngine() {
    this._stopCustomTrack();
    this._unpatchPlayer();
    if (this.engine && this._origPlaySong) {
      this.engine.playSong = this._origPlaySong;
      this.engine.stopMusic = this._origStopMusic;
      this.engine.setPaused = this._origSetPaused;
    }
    this.engine = null;
    this._origPlaySong = null;
    this._origStopMusic = null;
    this._origSetPaused = null;
  }

  /** Notify scene kind changes across crossings (town_day, dungeon, tavern, wilderness, ...). */
  setScene(sceneKind) {
    const next = normalizeSceneKey(sceneKind);
    if (next === this.sceneKind) return false;
    this.sceneKind = next;
    if (this.engine && this.engine.wantedSong && !this.engine.paused && this.engine.prefs?.musicEnabled) {
      if (this.mode === 'custom') {
        this._handlePlaySong(this.engine.wantedSong);
      } else {
        // Classic mode guarantees custom audio never leaks across scene crossings.
        this._stopCustomTrack();
      }
    }
    this._emit();
    return true;
  }

  /** Load a custom soundfont (.sf2 binary, JSON string/object, or built-in profile id). */
  loadSoundfont(input, fileName = 'custom-soundfont') {
    if (typeof input === 'string' && BUILTIN_SOUNDFONT_PROFILES[input]) {
      if (input === 'classic') {
        this.soundfont = null;
        if (this.tracks.size === 0) this.mode = 'classic';
      } else {
        this.soundfont = BUILTIN_SOUNDFONT_PROFILES[input];
        this.mode = 'custom';
      }
    } else {
      this.soundfont = parseSoundfontBank(input, fileName);
      this.mode = 'custom';
    }
    this._syncPlayerPatch();
    this._saveMeta();
    this._emit();
    return this.soundfont;
  }

  /** Register a local custom music track for a scene key (e.g. 'dungeon', 'town_day', 'default') or HMI song name. */
  async loadCustomTrack(sceneKey, source, { name = null } = {}) {
    const key = normalizeSceneKey(sceneKey);
    let buffer = null;
    let arrayBuffer = null;
    let label = name || source?.name || `Custom track (${key})`;
    if (source && typeof source.getChannelData === 'function') {
      buffer = source;
    } else if (source && typeof source.arrayBuffer === 'function') {
      arrayBuffer = await source.arrayBuffer();
    } else if (source instanceof ArrayBuffer) {
      arrayBuffer = source.slice(0);
    } else if (ArrayBuffer.isView(source)) {
      arrayBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    } else {
      throw new Error('Custom music track must be a File, Blob, ArrayBuffer, or AudioBuffer.');
    }
    if (!buffer && arrayBuffer) {
      buffer = await this._decode(arrayBuffer);
    }
    const entry = { key, name: String(label).slice(0, 100), buffer, arrayBuffer };
    this.tracks.set(key, entry);
    this.mode = 'custom';
    this._saveMeta();
    if (this.engine && this.engine.running && !this.engine.paused && this.engine.prefs?.musicEnabled) {
      await this._handlePlaySong(this.engine.wantedSong || key);
    }
    this._emit();
    return { key: entry.key, name: entry.name, decoded: !!entry.buffer };
  }

  removeCustomTrack(sceneKey) {
    const key = normalizeSceneKey(sceneKey);
    const removed = this.tracks.delete(key);
    if (this._activeCustomTrack === key) this._stopCustomTrack();
    if (this.tracks.size === 0 && !this.soundfont) this.mode = 'classic';
    this._saveMeta();
    this._emit();
    return removed;
  }

  /**
   * Cleanly reset both custom music tracks and custom soundfont back to the built-in classic FM synth.
   * Stops any custom audio playback and resumes the classic HMI song for the current scene.
   */
  async resetToClassic() {
    this._stopCustomTrack();
    this.tracks.clear();
    this.soundfont = null;
    this.mode = 'classic';
    this._unpatchPlayer();
    this._saveMeta();
    if (this.engine && this._origPlaySong) {
      const wanted = this.engine.wantedSong;
      this.engine.currentSong = null;
      if (wanted && this.engine.running && !this.engine.paused && this.engine.prefs?.musicEnabled) {
        await this._origPlaySong(wanted);
      }
      this.engine._changed?.();
    }
    this._emit();
    return this.status();
  }

  /** Look up which custom track (if any) applies to a song name + current scene. */
  matchTrack(songName, sceneKind = this.sceneKind) {
    if (this.mode !== 'custom' || this.tracks.size === 0) return null;
    const upper = songName ? String(songName).toUpperCase() : null;
    if (upper && this.tracks.has(upper)) return this.tracks.get(upper);
    const sk = normalizeSceneKey(sceneKind);
    if (this.tracks.has(sk)) return this.tracks.get(sk);
    if (this.tracks.has('default')) return this.tracks.get('default');
    return null;
  }

  async _decode(arrayBuffer) {
    const decoder = this.decodeAudioData
      ?? (this.engine?.ctx?.decodeAudioData ? (buf) => this.engine.ctx.decodeAudioData(buf.slice(0)) : null);
    if (!decoder) return null;
    return decoder(arrayBuffer);
  }

  async _handlePlaySong(name) {
    const engine = this.engine;
    if (!engine) return false;
    engine.wantedSong = name;
    if (!engine.running || engine.paused || !engine.prefs?.musicEnabled) {
      this._stopCustomTrack();
      return false;
    }
    const track = this.matchTrack(name, this.sceneKind);
    if (track) {
      if (!track.buffer && track.arrayBuffer) {
        try { track.buffer = await this._decode(track.arrayBuffer); } catch { track.buffer = null; }
      }
      if (track.buffer && engine.ctx && engine.bus?.music) {
        if (this._activeCustomTrack === track.key && this._customNode) return true;
        this._origStopMusic?.();
        this._stopCustomTrack();
        const src = engine.ctx.createBufferSource();
        src.buffer = track.buffer;
        src.loop = true;
        const g = engine.ctx.createGain();
        g.gain.value = 1;
        src.connect(g);
        g.connect(engine.bus.music);
        src.start();
        this._customNode = src;
        this._customGain = g;
        this._activeCustomTrack = track.key;
        engine.currentSong = `Custom: ${track.name}`;
        engine.error = null;
        engine._changed?.();
        this._emit();
        return true;
      }
    }
    this._stopCustomTrack();
    const ok = await this._origPlaySong(name);
    this._syncPlayerPatch();
    return ok;
  }

  _stopCustomTrack() {
    if (this._customNode) {
      try { this._customNode.stop(); } catch { /* already stopped */ }
      try { this._customNode.disconnect(); } catch { /* ignore */ }
    }
    if (this._customGain) {
      try { this._customGain.disconnect(); } catch { /* ignore */ }
    }
    this._customNode = null;
    this._customGain = null;
    this._activeCustomTrack = null;
  }

  _unpatchPlayer() {
    if (this._patchedPlayer && this._origPlayerVoice) {
      this._patchedPlayer._voice = this._origPlayerVoice;
    }
    this._patchedPlayer = null;
    this._origPlayerVoice = null;
  }

  _syncPlayerPatch() {
    const player = this.engine?.player;
    if (!player) return;
    if (this.mode !== 'custom' || !this.soundfont) {
      this._unpatchPlayer();
      return;
    }
    if (this._patchedPlayer === player) return;
    this._unpatchPlayer();
    this._patchedPlayer = player;
    this._origPlayerVoice = player._voice.bind(player);
    const self = this;
    player._voice = function customSoundfontVoice(n, at) {
      if (self.mode !== 'custom' || !self.soundfont) return self._origPlayerVoice(n, at);
      return self._playSoundfontVoice(player, n, at);
    };
  }

  _playSoundfontVoice(player, n, at) {
    const ctx = player.ctx;
    if (!ctx || at < ctx.currentTime - 0.05 || n.gain <= 0.0005) return;
    if (player.live.size >= player.maxVoices) return;
    if (n.drum) return this._origPlayerVoice(n, at);
    const v = resolveVoiceSpec(n.program, this.soundfont);
    const start = Math.max(at, ctx.currentTime);
    const hz = noteToHz(n.note) * Math.pow(2, n.cents / 1200);
    const dur = Math.max(0.05, Math.min(8, (n.duration || 0) * (player.spt || 0.01)));
    const end = start + dur + v.release + 0.03;
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) { pan.pan.value = n.pan; gain.connect(pan); pan.connect(player.out); } else gain.connect(player.out);
    const peak = Math.min(1.5, v.gain * (v.masterGain ?? 1) * n.gain);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(peak, start + Math.max(0.002, v.attack));
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * Math.max(0.01, v.sustain)), start + Math.max(0.005, v.attack + v.decay));
    gain.gain.setValueAtTime(Math.max(0.0001, peak * Math.max(0.01, v.sustain)), start + dur);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    const car = ctx.createOscillator();
    car.type = v.wave || 'sine';
    car.frequency.setValueAtTime(hz * v.car, start);
    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.setValueAtTime(hz * v.mod, start);
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(hz * v.index, start);
    modGain.gain.exponentialRampToValueAtTime(0.001, start + Math.max(0.02, v.idxDecay));
    mod.connect(modGain);
    modGain.connect(car.frequency);
    car.connect(gain);
    car.start(start);
    mod.start(start);
    car.stop(end);
    mod.stop(end);
    const voice = { gain, oscs: [car, mod] };
    player.live.add(voice);
    car.onended = () => {
      player.live.delete(voice);
      try { car.disconnect(); mod.disconnect(); modGain.disconnect(); gain.disconnect(); pan?.disconnect(); } catch { /* gone */ }
    };
  }
}

export { percussionSpec };
