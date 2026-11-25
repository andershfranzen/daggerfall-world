// A small two-operator FM synthesiser for the player's own MIDI.BSA songs.
//
// Daggerfall shipped no instrument bank in ARENA2 (the patches lived in the HMI sound
// driver), so the timbres are synthesised. The General MIDI family grouping and the
// percussion key table are adapted from daggerfall-js-source src/systems/gmSynth.js
// (MIT, (c) 2026 Lattymoy); the patch values are approximations, not recovered data.
// Notices: client/gameplay/atmosphere/NOTICES.txt.
//
// The planning half (`planSong`, `channelReset`) is pure and is unit-tested; the
// playback half (`SongPlayer`) needs a Web Audio context.

export const PERCUSSION_CHANNEL = 9;

export const noteToHz = (note) => 440 * Math.pow(2, (note - 69) / 12);
/** Velocity / CC7 / CC11 → amplitude (squared curve). */
export const curve = (v) => {
  const x = Math.max(0, Math.min(127, Number(v) || 0)) / 127;
  return x * x;
};
export const panPosition = (v) => (Math.max(0, Math.min(127, Number(v) || 0)) - 64) / 63;
export const bendCents = (v) => ((Math.max(0, Math.min(16383, Number(v) || 0)) - 8192) / 8192) * 200;

const FAMILIES = ['piano', 'chromatic', 'organ', 'guitar', 'bass', 'strings', 'ensemble', 'brass', 'reed', 'pipe', 'lead', 'pad', 'fx', 'ethnic', 'percussive', 'sfx'];
// car/mod frequency ratios, modulation index and its decay time, ADSR, gain.
const FM = {
  piano: [1, 1, 2.6, 0.3, 0.003, 0.55, 0.18, 0.3, 0.8],
  chromatic: [1, 3.5, 4.0, 0.22, 0.002, 0.7, 0.04, 0.5, 0.7],
  organ: [1, 2, 1.2, 2.0, 0.012, 0.06, 0.92, 0.1, 0.55],
  guitar: [1, 2, 3.2, 0.18, 0.004, 0.45, 0.16, 0.28, 0.7],
  bass: [1, 1, 2.0, 0.16, 0.006, 0.35, 0.45, 0.18, 0.95],
  strings: [1, 1, 1.1, 1.2, 0.09, 0.3, 0.78, 0.4, 0.6],
  ensemble: [1, 1, 1.4, 1.4, 0.13, 0.3, 0.82, 0.5, 0.55],
  brass: [1, 1, 3.4, 0.55, 0.045, 0.22, 0.75, 0.22, 0.65],
  reed: [1, 2, 2.4, 0.6, 0.03, 0.2, 0.78, 0.2, 0.55],
  pipe: [1, 2, 0.8, 1.0, 0.045, 0.15, 0.85, 0.2, 0.6],
  lead: [1, 1, 2.8, 0.7, 0.01, 0.25, 0.7, 0.2, 0.55],
  pad: [1, 2, 1.0, 2.0, 0.3, 0.4, 0.8, 0.7, 0.45],
  fx: [1, 1.41, 2.0, 1.0, 0.1, 0.4, 0.5, 0.5, 0.4],
  ethnic: [1, 3, 2.6, 0.25, 0.004, 0.4, 0.2, 0.3, 0.65],
  percussive: [1, 1.41, 3.0, 0.15, 0.002, 0.3, 0.05, 0.25, 0.7],
  sfx: [1, 1.7, 3.0, 0.5, 0.02, 0.3, 0.3, 0.3, 0.35],
};

export function voiceSpec(program) {
  const p = Math.max(0, Math.min(127, Math.trunc(Number(program) || 0)));
  const family = FAMILIES[p >> 3];
  const [car, mod, index, idxDecay, attack, decay, sustain, release, gain] = FM[family];
  return { program: p, family, car, mod, index, idxDecay, attack, decay, sustain, release, gain };
}

// GM percussion keys 35..87: [note, kind, hz, decay, gain, drop]. 'drop' is the pitch
// fall over the decay; struck metal and wood hold pitch (1).
const DRUMS = [
  [35, 'tone', 55, 0.28, 1.0, 0.5], [36, 'tone', 60, 0.24, 1.0, 0.5], [37, 'noise', 2500, 0.05, 0.55],
  [38, 'noise', 1800, 0.16, 0.75], [39, 'noise', 1500, 0.12, 0.65], [40, 'noise', 2000, 0.14, 0.75],
  [41, 'tone', 90, 0.28, 0.8, 0.5], [42, 'noise', 7000, 0.06, 0.45], [43, 'tone', 110, 0.26, 0.8, 0.5],
  [44, 'noise', 6500, 0.08, 0.4], [45, 'tone', 130, 0.24, 0.8, 0.5], [46, 'noise', 6000, 0.32, 0.45],
  [47, 'tone', 165, 0.22, 0.8, 0.5], [48, 'tone', 195, 0.21, 0.8, 0.5], [49, 'noise', 4500, 0.9, 0.55],
  [50, 'tone', 230, 0.2, 0.8, 0.5], [51, 'noise', 5500, 0.5, 0.4], [52, 'noise', 4000, 0.7, 0.5],
  [53, 'tone', 2200, 0.4, 0.45, 1], [54, 'noise', 9000, 0.12, 0.55], [55, 'noise', 6500, 0.35, 0.45],
  [56, 'tone', 800, 0.22, 0.55, 1], [57, 'noise', 4200, 0.85, 0.55], [58, 'noise', 3000, 0.45, 0.45],
  [59, 'noise', 5200, 0.55, 0.4], [60, 'tone', 400, 0.13, 0.7, 0.8], [61, 'tone', 300, 0.15, 0.7, 0.8],
  [62, 'tone', 360, 0.09, 0.65, 0.8], [63, 'tone', 330, 0.2, 0.7, 0.8], [64, 'tone', 240, 0.24, 0.7, 0.8],
  [65, 'tone', 520, 0.18, 0.65, 0.85], [66, 'tone', 420, 0.2, 0.65, 0.85], [67, 'tone', 1050, 0.18, 0.55, 1],
  [68, 'tone', 850, 0.2, 0.55, 1], [69, 'noise', 8000, 0.07, 0.4], [70, 'noise', 8500, 0.06, 0.4],
  [71, 'tone', 2300, 0.12, 0.4, 1], [72, 'tone', 2300, 0.35, 0.4, 1], [73, 'noise', 2200, 0.1, 0.45],
  [74, 'noise', 2200, 0.3, 0.45], [75, 'tone', 2400, 0.06, 0.6, 1], [76, 'tone', 2000, 0.07, 0.55, 1],
  [77, 'tone', 1600, 0.08, 0.55, 1], [78, 'tone', 600, 0.1, 0.5, 0.9], [79, 'tone', 500, 0.25, 0.5, 0.9],
  [80, 'tone', 6000, 0.08, 0.35, 1], [81, 'tone', 6000, 0.6, 0.35, 1], [82, 'noise', 9000, 0.07, 0.4],
  [83, 'tone', 5000, 0.3, 0.4, 1], [84, 'noise', 7500, 0.7, 0.35], [85, 'noise', 4000, 0.05, 0.5],
  [86, 'tone', 90, 0.16, 0.85, 0.5], [87, 'tone', 80, 0.4, 0.85, 0.5],
];

export function percussionSpec(note) {
  const n = Math.max(0, Math.min(127, Math.trunc(Number(note) || 0)));
  let best = DRUMS[0];
  for (const d of DRUMS) if (Math.abs(d[0] - n) < Math.abs(best[0] - n)) best = d;
  const [key, kind, hz, decay, gain, drop = 0.5] = best;
  return { key, kind, hz, decay, gain, drop };
}

export function channelReset() {
  return Array.from({ length: 16 }, () => ({ program: 0, volume: 100, expression: 127, pan: 64, bend: 8192 }));
}

/**
 * Turn the decoded event stream between two ticks into concrete notes, updating
 * per-channel controller state as it goes. Pure.
 * @param {Array} events HmiFile.events (sorted by tick)
 * @param {number} cursor index of the first unplanned event
 * @param {number} untilTick exclusive
 * @param {ReturnType<typeof channelReset>} channels mutated
 * @returns {{cursor:number, notes:Array<{tick:number,duration:number,channel:number,note:number,velocity:number,program:number,gain:number,pan:number,cents:number,drum:boolean}>}}
 */
export function planSong(events, cursor, untilTick, channels) {
  const notes = [];
  let i = cursor;
  for (; i < events.length && events[i].tick < untilTick; i++) {
    const ev = events[i];
    const ch = channels[ev.channel];
    if (!ch) continue;
    switch (ev.type) {
      case 'programChange': ch.program = ev.program; break;
      case 'pitchBend': ch.bend = ev.value; break;
      case 'controller':
        if (ev.controller === 7) ch.volume = ev.value;
        else if (ev.controller === 11) ch.expression = ev.value;
        else if (ev.controller === 10) ch.pan = ev.value;
        else if (ev.controller === 121) Object.assign(ch, { volume: 100, expression: 127, pan: 64, bend: 8192 });
        break;
      case 'noteOn':
        if (ev.velocity > 0) {
          notes.push({
            tick: ev.tick,
            duration: ev.duration ?? 0,
            channel: ev.channel,
            note: ev.note,
            velocity: ev.velocity,
            program: ch.program,
            gain: curve(ev.velocity) * curve(ch.volume) * curve(ch.expression),
            pan: panPosition(ch.pan),
            cents: bendCents(ch.bend),
            drum: ev.channel === PERCUSSION_CHANNEL,
          });
        }
        break;
      default: break;
    }
  }
  return { cursor: i, notes };
}

/** Plays one decoded HMI song on a Web Audio destination, looping, with a look-ahead scheduler. */
export class SongPlayer {
  constructor(ctx, destination, { lookAhead = 0.6, maxVoices = 56 } = {}) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.32;
    this.out.connect(destination);
    this.lookAhead = lookAhead;
    this.maxVoices = maxVoices;
    this.song = null;
    this.timer = null;
    this.live = new Set();
    this._noise = null;
  }

  get playing() { return !!this.song; }

  play(song) {
    this.stop();
    if (!song?.events?.length || !(song.durationTicks > 0)) return;
    this.song = song;
    this.spt = song.secondsPerTick;
    this.channels = channelReset();
    this.cursor = 0;
    this.loopStart = this.ctx.currentTime + 0.12;
    this.plannedTick = 0;
    this.timer = setInterval(() => this._pump(), 150);
    this._pump();
  }

  stop(fade = 0.4) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.song = null;
    const t = this.ctx.currentTime;
    for (const v of this.live) {
      try {
        v.gain.gain.cancelScheduledValues(t);
        v.gain.gain.setTargetAtTime(0, t, fade / 4);
        for (const o of v.oscs) o.stop(t + fade);
      } catch { /* already stopped */ }
    }
    this.live.clear();
  }

  dispose() {
    this.stop(0.05);
    this.out.disconnect();
  }

  _pump() {
    const song = this.song;
    if (!song) return;
    const horizon = this.ctx.currentTime + this.lookAhead;
    for (let guard = 0; guard < 4 && this.song; guard++) {
      const horizonTick = Math.floor((horizon - this.loopStart) / this.spt);
      if (this.plannedTick >= horizonTick) break;
      const until = Math.min(horizonTick, song.durationTicks + 1);
      const { cursor, notes } = planSong(song.events, this.cursor, until, this.channels);
      this.cursor = cursor;
      this.plannedTick = until;
      for (const n of notes) this._voice(n, this.loopStart + n.tick * this.spt);
      if (until > song.durationTicks) {
        // Loop: restart the stream right after the song's last tick.
        this.loopStart += (song.durationTicks + 1) * this.spt;
        this.cursor = 0;
        this.plannedTick = 0;
        this.channels = channelReset();
      }
    }
  }

  _noiseBuffer() {
    if (this._noise) return this._noise;
    const len = Math.floor(this.ctx.sampleRate * 1);
    const b = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = b.getChannelData(0);
    let s = 0x2545f491;
    for (let i = 0; i < len; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; d[i] = ((s >>> 0) / 4294967296) * 2 - 1; }
    return (this._noise = b);
  }

  _voice(n, at) {
    const ctx = this.ctx;
    if (at < ctx.currentTime - 0.05 || n.gain <= 0.0005) return;
    if (this.live.size >= this.maxVoices) return;
    const start = Math.max(at, ctx.currentTime);
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) { pan.pan.value = n.pan; gain.connect(pan); pan.connect(this.out); } else gain.connect(this.out);
    const voice = { gain, oscs: [] };
    let end;
    if (n.drum) {
      const d = percussionSpec(n.note);
      const peak = d.gain * n.gain;
      end = start + d.decay + 0.02;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + d.decay);
      if (d.kind === 'noise') {
        const src = ctx.createBufferSource();
        src.buffer = this._noiseBuffer();
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass'; f.frequency.value = d.hz; f.Q.value = 0.9;
        src.connect(f); f.connect(gain);
        src.start(start, Math.random() * 0.5); src.stop(end);
        voice.oscs.push(src);
      } else {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(d.hz, start);
        if (d.drop !== 1) o.frequency.exponentialRampToValueAtTime(d.hz * d.drop, start + d.decay);
        o.connect(gain); o.start(start); o.stop(end);
        voice.oscs.push(o);
      }
    } else {
      const v = voiceSpec(n.program);
      const hz = noteToHz(n.note) * Math.pow(2, n.cents / 1200);
      const held = Math.max(n.duration * this.spt, 0.03);
      const peak = v.gain * n.gain;
      const release = start + held;
      end = release + v.release + 0.05;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(peak, start + v.attack);
      gain.gain.setTargetAtTime(peak * v.sustain, start + v.attack, v.decay / 3);
      gain.gain.setTargetAtTime(0, release, v.release / 4);
      const car = ctx.createOscillator();
      car.frequency.value = hz * v.car;
      const mod = ctx.createOscillator();
      mod.frequency.value = hz * v.mod;
      const depth = ctx.createGain();
      const idx = hz * v.mod * v.index;
      depth.gain.setValueAtTime(idx, start);
      depth.gain.setTargetAtTime(idx * 0.35, start, v.idxDecay);
      mod.connect(depth); depth.connect(car.frequency);
      car.connect(gain);
      car.start(start); mod.start(start); car.stop(end); mod.stop(end);
      voice.oscs.push(car, mod);
    }
    this.live.add(voice);
    voice.oscs[0].onended = () => {
      this.live.delete(voice);
      try { gain.disconnect(); pan?.disconnect(); } catch { /* gone */ }
    };
  }
}
