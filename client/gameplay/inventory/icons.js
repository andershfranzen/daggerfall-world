// Item icons and the dressed paper doll, decoded in the browser from the
// player's own ARENA2 files (TEXTURE.nnn, BODY*.IMG, FACE*.CIF, SCBG*.IMG,
// ART_PAL.COL). Nothing is bundled. See ./images.js and ./paperdoll.js for
// the adapted MIT sources.

import { indexFiles } from '../../world/files.js';
import { parsePalette } from '../../world/textures.js';
import { ArtSource, itemArt, dollFiles, dollLayers } from './images.js';
import { buildDoll, DOLL_WIDTH, DOLL_HEIGHT } from './paperdoll.js';

/** Index-0-transparent RGBA from an indexed image. */
function toRgba(img, pal) {
  const out = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0; i < img.data.length; i++) {
    const c = img.data[i];
    if (c === 0 || c === 0xff) continue;
    out[i * 4] = pal[c * 3];
    out[i * 4 + 1] = pal[c * 3 + 1];
    out[i * 4 + 2] = pal[c * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

function rgbaUrl(rgba, width, height) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas.toDataURL('image/png');
}

const artKey = ({ archive, record, dye }) => [archive, record, dye?.kind, dye?.name];

export class IconSource {
  constructor() {
    this.art = new ArtSource(null);
    this.palette = null;
    this.urls = new Map();
    this.dolls = new Map();
    this.generation = 0;
  }

  setFiles(files) {
    if (files === this.files) return;
    this.files = files;
    let index = null;
    try {
      index = files ? indexFiles(files) : null;
    } catch {
      index = null;
    }
    this.art = new ArtSource(index);
    this.palette = null;
    this.urls.clear();
    this.dolls.clear();
    this.generation++;
  }

  get available() {
    return this.art.has('ART_PAL.COL');
  }

  /** True when the body art for this character can be read. */
  dollAvailable(character) {
    const files = dollFiles(character);
    return this.available && this.art.has(files.bodyClothed) && this.art.has(files.heads);
  }

  async #palette() {
    if (!this.palette) {
      this.palette = this.art.bytes('ART_PAL.COL').then((bytes) => bytes ? parsePalette(bytes, 'ART_PAL.COL') : null);
    }
    return this.palette;
  }

  /** Local PNG URL of an item's inventory icon (dyed), or null without game files. */
  url(item, character) {
    if (!this.available) return Promise.resolve(null);
    const art = itemArt(item, character);
    if (!art) return Promise.resolve(null);
    const key = JSON.stringify(artKey(art));
    if (!this.urls.has(key)) {
      const generation = this.generation;
      this.urls.set(key, Promise.all([this.art.image(art), this.#palette()]).then(([img, pal]) =>
        img && pal && this.generation === generation ? rgbaUrl(toRgba(img, pal), img.width, img.height) : null,
      ).catch(() => null));
    }
    return this.urls.get(key);
  }

  /**
   * Compose the dressed paper doll. Resolves to {url, doll} or null when the
   * classic body art is unavailable.
   */
  doll(rpg) {
    const character = rpg?.character;
    if (!this.dollAvailable(character)) return Promise.resolve(null);
    const key = JSON.stringify([dollFiles(character), dollLayers(rpg).map(({ slot, item }) => {
      const layer = itemArt(item, character, { doll: true, slot });
      const interior = itemArt(item, character, { doll: true, interior: true });
      return [slot, layer && artKey(layer), item.doll.cloak && interior && artKey(interior)];
    })]);
    if (!this.dolls.has(key)) {
      const { art, generation } = this;
      const promise = this.#palette().then((palette) => buildDoll(art, palette, rpg)).then((doll) => {
        if (!doll || this.generation !== generation) return null;
        const url = rgbaUrl(doll.rgba, DOLL_WIDTH, DOLL_HEIGHT);
        return url ? { url, doll } : null;
      }).catch(() => null);
      if (this.dolls.size >= 16) this.dolls.delete(this.dolls.keys().next().value);
      this.dolls.set(key, promise);
    }
    return this.dolls.get(key);
  }
}

const sources = new WeakMap();

/** Use the same decoded item art and file lifecycle in every gameplay panel. */
export function getItemArtSource(api) {
  if (!sources.has(api)) {
    const source = new IconSource();
    source.setFiles(api.files);
    api.on('assets', (files) => source.setFiles(files));
    sources.set(api, source);
  }
  return sources.get(api);
}

/** Add an optional decorative sprite alongside a named item in a text row. */
export function itemIcon(api, item) {
  if (!item || typeof document === 'undefined') return '';
  const img = document.createElement('img');
  img.className = 'item-art-icon';
  img.alt = '';
  img.draggable = false;
  img.hidden = true;
  getItemArtSource(api).url(item, api.state?.character?.character).then((url) => {
    if (url) {
      img.src = url;
      img.hidden = false;
    }
  });
  return img;
}
