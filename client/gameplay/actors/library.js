// Loads sprite archives on demand from the player's selected ARENA2 files and
// packs every frame of an archive into one RGBA atlas. Nothing is fetched from
// the network and nothing decoded here is sent anywhere.

import { indexFiles } from '../../world/files.js';
import { SpriteArchive, textureFileName, parsePalette, indicesToRgba } from './spriteArchive.js';

const PAD = 1;
const MAX_ATLAS = 4096;

/**
 * Shelf-pack frames ({w,h}) into the smallest power-of-two-wide atlas.
 * Returns { width, height, places: [{x,y}] } or null if it cannot fit MAX_ATLAS.
 */
export function packFrames(sizes, maxSide = MAX_ATLAS) {
  if (!sizes.length) return { width: 1, height: 1, places: [] };
  const area = sizes.reduce((s, f) => s + (f.w + PAD) * (f.h + PAD), 0);
  const widest = Math.max(...sizes.map((f) => f.w + PAD));
  let width = 64;
  while (width < widest || width * width < area) width *= 2;
  for (; width <= maxSide; width *= 2) {
    const order = sizes.map((f, i) => i).sort((a, b) => sizes[b].h - sizes[a].h || a - b);
    const places = new Array(sizes.length);
    let x = 0, y = 0, rowH = 0;
    for (const i of order) {
      const { w, h } = sizes[i];
      if (x + w + PAD > width) { x = 0; y += rowH; rowH = 0; }
      places[i] = { x, y };
      x += w + PAD;
      rowH = Math.max(rowH, h + PAD);
    }
    const height = y + rowH;
    if (height <= maxSide) return { width, height, places };
  }
  return null;
}

/** Build {width,height,pixels,rects[record][frame]={x,y,w,h}} for every frame of an archive. */
export function buildAtlas(sprite, palette) {
  const sizes = [], keys = [];
  for (let r = 0; r < sprite.recordCount; r++) {
    for (let f = 0; f < sprite.frameCount(r); f++) {
      const rec = sprite.records[r];
      sizes.push({ w: rec.width, h: rec.height });
      keys.push([r, f]);
    }
  }
  const pack = packFrames(sizes);
  if (!pack) throw new Error(`${sprite.label}: frames do not fit a ${MAX_ATLAS}px atlas`);
  const pixels = new Uint8Array(pack.width * pack.height * 4);
  const rects = sprite.records.map((rec) => new Array(rec.frameCount));
  keys.forEach(([r, f], i) => {
    const img = sprite.frame(r, f);
    const { x, y } = pack.places[i];
    indicesToRgba(img, palette, { out: pixels, outWidth: pack.width, x0: x, y0: y });
    rects[r][f] = { x, y, w: img.width, h: img.height };
  });
  return { width: pack.width, height: pack.height, pixels, rects };
}

async function bytesOf(file) {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Uint8Array(await new Response(file).arrayBuffer());
}

/**
 * Archive cache. get(archive) returns a ready entry or null and starts loading
 * in the background; `onReady(archive)` fires when one becomes available.
 * Entry: { archive, sprite: SpriteArchive, atlas, version }
 */
export class SpriteLibrary {
  constructor() {
    this.index = null;
    this.palette = null;
    this.entries = new Map();
    this.pending = new Map();
    this.failed = new Map();
    this.generation = 0;
    this.onReady = null;
  }

  /** Point at a new file selection (iterable of File). Drops cached archives. */
  setFiles(files) {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
    this.failed.clear();
    this.palette = null;
    this.paletteLoad = null;
    try {
      this.index = files ? indexFiles(files) : null;
    } catch (err) {
      this.index = null;
      this.failed.set('files', err.message);
    }
  }

  get ready() { return this.entries.size > 0; }

  has(archive) {
    return !!this.index?.has(textureFileName(archive));
  }

  get(archive) {
    const e = this.entries.get(archive);
    if (e) return e;
    if (this.index && !this.pending.has(archive) && !this.failed.has(archive)) {
      this.pending.set(archive, this.load(archive).catch(() => null));
    }
    return null;
  }

  /** Resolve once an archive is loaded (or null when it cannot be). */
  async load(archive) {
    const gen = this.generation;
    try {
      const name = textureFileName(archive);
      const file = this.index?.get(name);
      if (!file) throw new Error(`${name} is not in the selected folder`);
      const palette = await this.#palette();
      const sprite = new SpriteArchive(await bytesOf(file), archive);
      const atlas = buildAtlas(sprite, palette);
      if (gen !== this.generation) return null;
      const entry = { archive, sprite, atlas, version: gen };
      this.entries.set(archive, entry);
      this.pending.delete(archive);
      this.onReady?.(archive);
      return entry;
    } catch (err) {
      if (gen === this.generation) {
        this.pending.delete(archive);
        // Name the file so the player knows what to fix ("Failed to fetch" alone does not say).
        const name = textureFileName(archive);
        this.failed.set(archive, String(err?.message ?? err).includes(name) ? err.message : `${name} could not be read: ${err?.message ?? err}`);
      }
      return null;
    }
  }

  #palette() {
    if (!this.paletteLoad) {
      this.paletteLoad = (async () => {
        const file = this.index?.get('ART_PAL.COL');
        if (!file) throw new Error('ART_PAL.COL is not in the selected folder');
        return (this.palette = parsePalette(await bytesOf(file), 'ART_PAL.COL'));
      })();
    }
    return this.paletteLoad;
  }
}
