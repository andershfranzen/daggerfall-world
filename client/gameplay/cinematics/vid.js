// Decoder for Daggerfall's .VID movies (ANIM0000-0015.VID, DAG2.VID), read from the player's own ARENA2.
//
// Format as documented by Daggerfall Unity's VidFile.cs (MIT, Copyright (C) 2009-2023 Daggerfall Workshop;
// see ../atmosphere/NOTICES.txt). Layout:
//   header  "VID" u16 unknown(512) u16 frameCount u16 width u16 height u16 globalDelay u16 unknown(14)
//   block   0x02 palette: 768 bytes of 6-bit RGB (x4)
//   blocks  0x7C audio start  (u16 0, u8 rate=166 -> 11025 Hz, u16 len, len bytes unsigned 8-bit PCM)
//           0x7D audio more   (u16 len, bytes)
//           0x03 video key    (u16 delay, RLE over the whole frame)
//           0x01 video delta  (u16 delay, skip/literal RLE from pixel 0)
//           0x04 video delta  (u16 delay, u16 row, skip/literal RLE from that row)
//           0x02 palette (skipped mid-stream, as DFU does), 0x00 null, 0x14 end of file
//
// The decoder is incremental. `feed()` appends bytes as they arrive, and `next()` returns null when the next
// block is not complete yet, so playback can start on the first frame before the whole file has been read.

export const SAMPLE_RATE = 11025;
const MIN_FRAME_DELAY = 740 / SAMPLE_RATE;
export const BLOCK = Object.freeze({
  NULL: 0, VIDEO_DELTA: 1, PALETTE: 2, VIDEO_KEY: 3, VIDEO_ROW_DELTA: 4, END: 20, AUDIO_START: 124, AUDIO_MORE: 125,
});

class NeedMore extends Error {}

export class VidDecoder {
  constructor() {
    this.buf = new Uint8Array(0);
    this.len = 0;
    this.pos = 0;
    this.header = null;
    this.palette = null; // Uint32Array of little-endian RGBA
    this.pixels = null; // Uint32Array, one per pixel (ImageData-compatible view through .rgba)
    this.rgba = null;
    this.ended = false;
    this.complete = false; // every byte of the file has been fed
    this.frames = 0;
    this.lastAudio = null;
  }

  /** Append a chunk. Call `finish()` after the last one. */
  feed(chunk) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (this.len + bytes.length > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + bytes.length, 65536));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
    if (!this.header) this._tryHeader();
    return this;
  }

  finish() { this.complete = true; return this; }

  get width() { return this.header?.width ?? 0; }
  get height() { return this.header?.height ?? 0; }
  get frameCount() { return this.header?.frameCount ?? 0; }

  _need(n) { if (this.pos + n > this.len) throw new NeedMore(); }
  _u8() { this._need(1); return this.buf[this.pos++]; }
  _u16() { this._need(2); const v = this.buf[this.pos] | (this.buf[this.pos + 1] << 8); this.pos += 2; return v; }

  _tryHeader() {
    if (this.len < 15 + 1 + 768) return;
    const b = this.buf;
    if (b[0] !== 0x56 || b[1] !== 0x49 || b[2] !== 0x44) throw new Error('Not a Daggerfall VID file (missing "VID" header).');
    const u16 = (o) => b[o] | (b[o + 1] << 8);
    this.header = { unknown1: u16(3), frameCount: u16(5), width: u16(7), height: u16(9), globalDelay: u16(11), unknown2: u16(13) };
    const { width, height } = this.header;
    if (!(width > 0 && width <= 640 && height > 0 && height <= 480)) throw new Error(`VID frame size ${width}x${height} is out of range.`);
    if (b[15] !== BLOCK.PALETTE) throw new Error('VID palette block not found after the header.');
    this.palette = new Uint32Array(256);
    for (let i = 0, p = 16; i < 256; i++, p += 3) {
      const r = Math.min(255, b[p] * 4), g = Math.min(255, b[p + 1] * 4), bl = Math.min(255, b[p + 2] * 4);
      this.palette[i] = (255 << 24 | bl << 16 | g << 8 | r) >>> 0;
    }
    this.rgba = new Uint8ClampedArray(width * height * 4);
    this.pixels = new Uint32Array(this.rgba.buffer);
    this.pixels.fill(this.palette[0]);
    this.pos = 16 + 768;
  }

  /**
   * Decode the next block. Returns null if more bytes are needed (or the file has ended), otherwise
   * { type, audio?: Uint8Array, frame?: true, delay: seconds }.
   * The frame result means `this.rgba` now holds the new picture.
   */
  next() {
    if (this.ended || !this.header) return null;
    const start = this.pos;
    try {
      const type = this._u8();
      switch (type) {
        case BLOCK.NULL: return { type, delay: 0 };
        case BLOCK.PALETTE: this._need(768); this.pos += 768; return { type, delay: 0 };
        case BLOCK.AUDIO_START: {
          this._u16();
          const rate = this._u8();
          const n = this._u16();
          this._need(n);
          if (rate !== 166) throw new Error(`Unknown VID audio rate byte ${rate}.`);
          return this._audio(type, n);
        }
        case BLOCK.AUDIO_MORE: { const n = this._u16(); this._need(n); return this._audio(type, n); }
        case BLOCK.VIDEO_KEY: this._u16(); this._keyFrame(); return this._frame(type);
        case BLOCK.VIDEO_DELTA: this._u16(); this._delta(0); return this._frame(type);
        case BLOCK.VIDEO_ROW_DELTA: { this._u16(); const row = this._u16(); this._delta(row * this.header.width); return this._frame(type); }
        case BLOCK.END: this.ended = true; return { type, delay: 0 };
        default: throw new Error(`Unknown VID block type ${type} at byte ${start}.`);
      }
    } catch (e) {
      if (!(e instanceof NeedMore)) throw e;
      this.pos = start;
      if (this.complete) this.ended = true; // truncated file: stop cleanly
      return null;
    }
  }

  _audio(type, n) {
    const audio = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    this.lastAudio = audio;
    return { type, audio, delay: Math.max(MIN_FRAME_DELAY, n / SAMPLE_RATE) };
  }

  _frame(type) {
    this.frames++;
    const n = this.lastAudio?.length ?? 0;
    return { type, frame: true, delay: Math.max(MIN_FRAME_DELAY, n / SAMPLE_RATE) };
  }

  // Decode into a scratch copy first so a block cut short by the stream leaves the picture untouched.
  _keyFrame() {
    const px = this.pixels.slice();
    const pal = this.palette;
    let i = 0;
    while (i < px.length) {
      const c = this._u8();
      if (c >= 0x80) { const v = pal[this._u8()]; const end = Math.min(px.length, i + c - 0x80); while (i < end) px[i++] = v; }
      else if (c === 0) break;
      else { this._need(c); for (let k = 0; k < c && i < px.length; k++) px[i++] = pal[this.buf[this.pos++]]; }
    }
    this.pixels.set(px);
  }

  _delta(from) {
    const px = this.pixels.slice();
    const pal = this.palette;
    let i = from;
    while (i < px.length) {
      const c = this._u8();
      if (c >= 0x80) i += c - 0x80;
      else if (c === 0) break;
      else { this._need(c); for (let k = 0; k < c && i < px.length; k++) px[i++] = pal[this.buf[this.pos++]]; }
    }
    this.pixels.set(px);
  }
}

/** Unsigned 8-bit PCM to float samples. */
export function pcm8ToFloat(bytes, out = new Float32Array(bytes.length)) {
  for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] - 128) / 128;
  return out;
}

/** The file names behind a cinematic cue. `video` follows DFU PlayVideo: ANIM + 4-digit number + .VID. */
export const SEQUENCES = Object.freeze({
  // DaggerfallStartNewGameWizard newGameCinematic1-3.
  opening: ['ANIM0000.VID', 'ANIM0011.VID', 'DAG2.VID'],
  // DaggerfallUI splashVideo / deathVideo.
  splash: ['ANIM0001.VID'],
  death: ['ANIM0012.VID'],
  // VampirismInfection / LycanthropyInfection dream videos.
  vampireDream: ['ANIM0004.VID'],
  lycanthropeDream: ['ANIM0002.VID'],
});

export function videoFileName(n) {
  const v = Math.trunc(Number(n));
  if (!(v >= 0 && v <= 9999)) return null;
  return `ANIM${String(v).padStart(4, '0')}.VID`;
}

/** Resolve a cue ({sequence} or {video}) to file names. Unknown cues resolve to []. */
export function filesForCue(cue) {
  if (!cue || typeof cue !== 'object') return [];
  if (typeof cue.sequence === 'string') return [...(SEQUENCES[cue.sequence] ?? [])];
  if (Array.isArray(cue.files)) return cue.files.filter((f) => typeof f === 'string' && /^[A-Z0-9_]{1,8}\.VID$/i.test(f)).map((f) => f.toUpperCase());
  const one = cue.video !== undefined && cue.video !== null ? videoFileName(cue.video) : null;
  return one ? [one] : [];
}
