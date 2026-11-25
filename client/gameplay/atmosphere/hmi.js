// HMI song reader (Daggerfall's ARENA2/MIDI.BSA holds HMI-MIDISONG061595 songs, not XMI).
//
// Adapted from daggerfall-js-source src/formats/hmiFile.js (MIT, (c) 2026 Lattymoy),
// commit as checked out in .ref/dfjs-research-03. Changes: the MidiBsaFile wrapper is
// replaced by client/world/bsa.js's BsaArchive (see audio.js); the long provenance
// commentary is summarised here. Notices: client/gameplay/atmosphere/NOTICES.txt.
//
// Summary of the format, as established by that project against the retail archive:
//   song header: signature, u16 BPM at 0x0D4, u32 track count at 0x0E4, u32 track
//   table offset at 0x0E8. Tracks: "HMI-MIDITRACK", u32 event-stream offset at +0x63,
//   a prologue of N six-byte records, then VLQ-delta MIDI events with running status.
//   Note-ons carry a VLQ duration instead of a note-off; 0xFE private events have
//   fixed sizes; one tick is 1/BPM seconds (60 ticks per quarter); deltas over 0xFFFF
//   are an authoring artifact and are "shunted" to the track's last tick.

export const SONG_SIGNATURE = 'HMI-MIDISONG061595';
export const TRACK_SIGNATURE = 'HMI-MIDITRACK';

// Song header field offsets.
const SONG_RESOLUTION = 0xd2;
const SONG_TEMPO_BPM = 0xd4;

/** THE CLOCK: the HMI sequencer's ticks per quarter note at the header's
 *  BPM - sixty, so one tick is 1/BPM of a second (WildMIDI f_hmi.c:92;
 *  foo_midi's 192 ppqn at 1,605,632 us is the same 8.36 ms/tick). The
 *  header's own resolution field (0x0D2, 480 throughout the archive) is
 *  NOT this number - reading it as the time base ran every song 8x fast. */
export const HMI_TICKS_PER_QUARTER = 60;

/** THE SHUNT: a delta over this is not time. foo_midi's HMI processor
 *  (`delta > 0xFFFF`: "Large HMI delta detected, shunting") drops the
 *  event onto the track's last event tick rather than advancing by it;
 *  one retail track (SUNNYDAY.HMI track 5) carries such a delta and the
 *  original driver plainly did not wait 2.76 hours on it. */
export const HMI_MAX_DELTA = 0xffff;
const SONG_TRACK_COUNT = 0xe4;
const SONG_TRACK_TABLE = 0xe8;
const SONG_TRAILER_SIZE = 16;

// Track header field offsets.
const TRACK_EVENT_COUNT = 0x61;
const TRACK_DATA_OFFSET = 0x63;
const TRACK_CHANNEL = 0x79;

const PROLOGUE_RECORD_SIZE = 6;

// Bytes an HMI private event occupies after its 0xFE status byte, keyed by
// subtype. 0x10 is variable: subtype + 2 + length byte + length + 4.
const HMI_FIXED_SIZES = Object.freeze({ 0x12: 3, 0x13: 3, 0x14: 3, 0x15: 7 });
const HMI_CHANNEL_SETUP = 0x10;

const META_END_OF_TRACK = 0x2f;

/** Sort rank at equal ticks: note-offs first so a retrigger is not cut short. */
const RANK_NOTE_OFF = 0;
const RANK_EVENT = 1;
// A zero-duration note (37 exist in the archive) would otherwise sort its own
// note-off ahead of its note-on.
const RANK_DEGENERATE_NOTE_OFF = 2;

function readCString(bytes, offset, maxLength) {
  let s = '';
  for (let i = offset; i < offset + maxLength && i < bytes.length; i++) {
    if (bytes[i] === 0) break;
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

/**
 * One HMI song: header, tracks, and a merged event stream.
 *
 * All ticks are the HMI clock's: HMI_TICKS_PER_QUARTER (60) per quarter note
 * at the header's BPM. The stream is the whole song - a synth needs nothing
 * from this class but `events`, `secondsPerTick` and the channel of each event.
 */
export class HmiFile {
  constructor() {
    this.name = '';
    this.signature = '';
    this.headerResolution = 0; // the 0x0D2 field, 480 in every retail song; not the time base
    this.beatsPerMinute = 0;
    this.trackCount = 0;
    this.tracks = [];
    this.events = [];
    this.durationTicks = 0;
    this.sourceName = '';
    this._bytes = null;
  }

  /**
   * Decodes a song. Returns false if the bytes are not an HMI song at all;
   * throws if they are an HMI song this reader cannot fully decode.
   * @param {Uint8Array} bytes
   * @param {string} name - song name, used in error messages only.
   * @returns {boolean}
   */
  load(bytes, name = '') {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('HmiFile expects a Uint8Array');
    this.name = name;
    if (bytes.length < SONG_TRACK_TABLE + 4) return false;
    this.signature = readCString(bytes, 0, SONG_SIGNATURE.length);
    if (this.signature !== SONG_SIGNATURE) return false;

    this._bytes = bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.headerResolution = view.getUint16(SONG_RESOLUTION, true);
    this.beatsPerMinute = view.getUint16(SONG_TEMPO_BPM, true);
    this.trackCount = view.getUint32(SONG_TRACK_COUNT, true);
    const tableOffset = view.getUint32(SONG_TRACK_TABLE, true);

    if (this.headerResolution <= 0) this._fail('bad header resolution');
    if (this.beatsPerMinute <= 0) this._fail('bad tempo');
    if (this.trackCount <= 0) this._fail('no tracks');
    if (tableOffset + 4 * this.trackCount > bytes.length) this._fail('track table out of range');

    const offsets = [];
    for (let i = 0; i < this.trackCount; i++) {
      const off = view.getUint32(tableOffset + 4 * i, true);
      if (off >= bytes.length) this._fail(`track ${i} offset ${off} out of range`);
      offsets.push(off);
    }

    this.tracks = [];
    let seq = 0;
    const merged = [];
    for (let i = 0; i < this.trackCount; i++) {
      const limit = i + 1 < this.trackCount ? offsets[i + 1] : bytes.length - SONG_TRAILER_SIZE;
      const track = this._readTrack(view, i, offsets[i], limit, seq);
      seq += track.events.length;
      this.tracks.push(track);
      for (const ev of track.events) merged.push(ev);
    }

    merged.sort((a, b) => a.tick - b.tick || a._rank - b._rank || a._seq - b._seq);
    for (const ev of merged) {
      delete ev._rank;
      delete ev._seq;
    }
    this.events = merged;
    this.durationTicks = this.tracks.reduce((n, t) => Math.max(n, t.endTick), 0);
    this.sourceName = readCString(bytes, bytes.length - SONG_TRAILER_SIZE, SONG_TRAILER_SIZE);
    return true;
  }

  /** The HMI clock: ticks per quarter note, for consumers that want a
   *  standard-MIDI division to pair with microsecondsPerQuarterNote. */
  get ticksPerQuarterNote() {
    return HMI_TICKS_PER_QUARTER;
  }

  /** Seconds per tick at the song's single tempo: 1/BPM (THE CLOCK above). */
  get secondsPerTick() {
    return 60 / (this.beatsPerMinute * HMI_TICKS_PER_QUARTER);
  }

  /** Standard-MIDI microseconds per quarter note, for exporting/consumers. */
  get microsecondsPerQuarterNote() {
    return Math.round(60000000 / this.beatsPerMinute);
  }

  /** Song length in seconds. */
  get durationSeconds() {
    return this.durationTicks * this.secondsPerTick;
  }

  /** Converts a tick to seconds from song start. */
  tickToSeconds(tick) {
    return tick * this.secondsPerTick;
  }

  _fail(message, offset) {
    const where = offset === undefined ? '' : ` at byte ${offset}`;
    throw new Error(`${this.name || 'HMI song'}: ${message}${where}`);
  }

  _readTrack(view, index, start, limit, seqBase) {
    const bytes = this._bytes;
    if (readCString(bytes, start, TRACK_SIGNATURE.length) !== TRACK_SIGNATURE) {
      this._fail(`track ${index} is not ${TRACK_SIGNATURE}`, start);
    }
    const dataOffset = view.getUint32(start + TRACK_DATA_OFFSET, true);
    const channel = bytes[start + TRACK_CHANNEL];
    let p = start + dataOffset;
    if (p >= limit) this._fail(`track ${index} data offset out of range`, start);

    const prologueCount = bytes[p];
    const prologueEnd = p + 1 + PROLOGUE_RECORD_SIZE * prologueCount;
    if (prologueEnd > limit) this._fail(`track ${index} prologue out of range`, p);
    const prologue = bytes.slice(p, prologueEnd);
    p = prologueEnd;

    const events = [];
    const pending = [];
    let tick = 0;
    let status = 0;
    let endTick = 0;
    let seq = seqBase;

    const vlq = () => {
      let value = 0;
      for (let i = 0; i < 4; i++) {
        if (p >= limit) this._fail(`track ${index} ran past its data`, p);
        const c = bytes[p++];
        value = (value << 7) | (c & 0x7f);
        if (!(c & 0x80)) return value;
      }
      this._fail(`track ${index} over-long variable-length quantity`, p);
      return 0;
    };
    const data = () => {
      if (p >= limit) this._fail(`track ${index} ran past its data`, p);
      const b = bytes[p++];
      if (b & 0x80) this._fail(`track ${index} data byte 0x${b.toString(16)} has bit 7 set`, p - 1);
      return b;
    };
    const push = (ev, rank) => {
      ev._rank = rank;
      ev._seq = seq++;
      ev.track = index;
      events.push(ev);
      return ev;
    };

    let lastTick = 0; // the shunt's landing: the latest tick any event took
    for (;;) {
      const delta = vlq();
      if (delta > HMI_MAX_DELTA)
        tick = lastTick; // THE SHUNT (foo_midi): an authoring artifact, not time
      else {
        tick += delta;
        if (tick > lastTick) lastTick = tick;
      }
      if (p >= limit) this._fail(`track ${index} ended without end-of-track`, p);
      let st = bytes[p];
      if (st & 0x80) p++;
      else if (status) st = status;
      else this._fail(`track ${index} running status with no status`, p);

      if (st === 0xff) {
        const type = bytes[p++];
        const length = vlq();
        const payload = bytes.slice(p, p + length);
        p += length;
        if (type === META_END_OF_TRACK) {
          endTick = tick;
          break;
        }
        push({ tick, type: 'meta', channel: null, metaType: type, data: payload }, RANK_EVENT);
        continue;
      }
      if (st === 0xfe) {
        if (p + 4 > limit) this._fail(`track ${index} HMI event runs past its data`, p);
        const subtype = bytes[p];
        let size = HMI_FIXED_SIZES[subtype];
        if (subtype === HMI_CHANNEL_SETUP) size = 1 + 2 + 1 + bytes[p + 3] + 4;
        if (!size) this._fail(`track ${index} unknown HMI event 0xFE 0x${subtype.toString(16)}`, p);
        if (p + size > limit) this._fail(`track ${index} HMI event runs past its data`, p);
        push({ tick, type: 'hmi', channel: null, subtype, data: bytes.slice(p + 1, p + size) }, RANK_EVENT);
        p += size;
        continue;
      }
      if (st === 0xf0 || st === 0xf7) {
        const length = vlq();
        const payload = bytes.slice(p, p + length);
        p += length;
        push({ tick, type: 'sysEx', channel: null, status: st, data: payload }, RANK_EVENT);
        continue;
      }
      status = st;
      const kind = st & 0xf0;
      const ch = st & 0x0f;
      switch (kind) {
        case 0x80: {
          const note = data();
          const velocity = data();
          push({ tick, type: 'noteOff', channel: ch, note, velocity }, RANK_NOTE_OFF);
          break;
        }
        case 0x90: {
          const note = data();
          const velocity = data();
          const duration = vlq();
          const on = push({ tick, type: 'noteOn', channel: ch, note, velocity, duration }, RANK_EVENT);
          pending.push({
            tick: tick + duration,
            type: 'noteOff',
            channel: ch,
            note,
            velocity: 0,
            _rank: duration === 0 ? RANK_DEGENERATE_NOTE_OFF : RANK_NOTE_OFF,
            _seq: on._seq,
            track: index,
          });
          break;
        }
        case 0xa0: {
          const note = data();
          const pressure = data();
          push({ tick, type: 'polyPressure', channel: ch, note, pressure }, RANK_EVENT);
          break;
        }
        case 0xb0: {
          const controller = data();
          const value = data();
          push({ tick, type: 'controller', channel: ch, controller, value }, RANK_EVENT);
          break;
        }
        case 0xc0:
          push({ tick, type: 'programChange', channel: ch, program: data() }, RANK_EVENT);
          break;
        case 0xd0:
          push({ tick, type: 'channelPressure', channel: ch, pressure: data() }, RANK_EVENT);
          break;
        case 0xe0: {
          const lsb = data();
          const msb = data();
          push({ tick, type: 'pitchBend', channel: ch, value: (msb << 7) | lsb }, RANK_EVENT);
          break;
        }
        default:
          // AUDIT 19 F3: pitch bend used to be the DEFAULT arm, so every
          // undefined status - 0xF1..0xF6 and 0xF8..0xFD - was decoded as
          // a bend on a phantom channel taken from its low nibble (0xF8
          // became "channel 8"). That directly contradicted this file's
          // own claim that anything outside the vocabulary throws, and it
          // is the shape the reader exists to prevent: garbage in, plausible
          // data out. 0xE0 is now explicit and the default fails loudly.
          this._fail(`track ${index} unknown status byte 0x${st.toString(16)}`, p - 1);
          break;
      }
    }

    const streamEventCount = events.length;
    for (const off of pending) {
      events.push(off);
      if (off.tick > endTick) endTick = off.tick;
    }
    events.sort((a, b) => a.tick - b.tick || a._rank - b._rank || a._seq - b._seq);

    // AUDIT 19 F2: ENFORCE the gate rather than merely reporting it. A
    // track that does not consume exactly to its limit has been misparsed,
    // and continuing produces a plausible-looking event stream that is
    // simply wrong. The whole retail archive satisfies this at 1286/1286.
    if (limit - p !== 0) {
      this._fail(`track ${index} consumed to ${p}, not its limit ${limit} (${limit - p} bytes adrift)`, p);
    }

    return {
      index,
      channel,
      byteOffset: start,
      byteLength: limit - start,
      dataOffset,
      headerEventCount: view.getUint16(start + TRACK_EVENT_COUNT, true),
      header: bytes.slice(start, start + dataOffset),
      prologue,
      events,
      // Events actually present in the byte stream, before note-on durations
      // are resolved into note-offs and excluding the end-of-track meta.
      streamEventCount,
      endTick,
      // AUDIT 19 F2: this is the reader's OWN GATE and it used to be
      // computed and thrown away - only the test looked at it. An injected
      // early FF 2F 00 made D1.HMI silently lose 839 events with load()
      // still returning true, which is exactly the "decodes to garbage
      // silently" failure this reader claims it cannot have. It is
      // enforced below; the field stays for the pins that report it.
      trailingBytes: limit - p,
    };
  }
}

