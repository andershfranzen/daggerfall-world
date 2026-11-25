// Classic travel-map pictures from the player's own ARENA2 files: the Iliac Bay
// overview (TRAV0I00.IMG), its region picker mask (TRAV0I01.IMG) and the per-region
// maps (FMAP*.IMG), decoded to RGBA. Pure module, no DOM.
//
// IMG layout, palette choice and the region-map offsets follow Daggerfall Unity's
// API/ImgFile.cs and Game/UserInterfaceWindows/DaggerfallTravelMapWindow.cs
// (GetRegionMapNames, PopulateRegionOffsetDict, GetRegionMapScale) (MIT,
// (c) 2009-2023 Daggerfall Workshop). Notices: client/gameplay/travel/NOTICES.txt.

import { readBlob } from '../../world/bsa.js';
import { parsePalette } from '../../world/textures.js';
import { WorldDataError } from '../../world/errors.js';
import { decodeImg, toRgba } from '../../hud/classic-art.js';

export { decodeImg, toRgba };

export const OVERVIEW_IMG = 'TRAV0I00.IMG';
export const PICKER_IMG = 'TRAV0I01.IMG';

/** Region map origin in classic map pixels (DaggerfallTravelMapWindow.PopulateRegionOffsetDict). */
export const REGION_MAP_ORIGIN = Object.freeze({
  'FMAPAI00.IMG': [212, 340], 'FMAPBI00.IMG': [322, 340],
  'FMAPAI01.IMG': [583, 279], 'FMAPBI01.IMG': [680, 279], 'FMAPCI01.IMG': [583, 340], 'FMAPDI01.IMG': [680, 340],
  'FMAP0I05.IMG': [381, 4], 'FMAP0I09.IMG': [525, 114], 'FMAP0I11.IMG': [437, 340],
  'FMAPAI16.IMG': [578, 0], 'FMAPBI16.IMG': [680, 0], 'FMAPCI16.IMG': [578, 52], 'FMAPDI16.IMG': [680, 52],
  'FMAP0I17.IMG': [39, 106], 'FMAP0I18.IMG': [20, 29], 'FMAP0I19.IMG': [80, 123], 'FMAP0I20.IMG': [217, 293],
  'FMAP0I21.IMG': [263, 79], 'FMAP0I22.IMG': [548, 219], 'FMAP0I23.IMG': [680, 146], 'FMAP0I26.IMG': [680, 80],
  'FMAP0I32.IMG': [41, 0], 'FMAP0I33.IMG': [660, 101], 'FMAP0I34.IMG': [578, 40], 'FMAP0I35.IMG': [525, 3],
  'FMAP0I36.IMG': [440, 40], 'FMAP0I37.IMG': [448, 0], 'FMAP0I38.IMG': [366, 0], 'FMAP0I39.IMG': [300, 8],
  'FMAP0I40.IMG': [202, 0], 'FMAP0I41.IMG': [223, 6], 'FMAP0I42.IMG': [148, 76], 'FMAP0I43.IMG': [15, 340],
  'FMAP0I44.IMG': [61, 340], 'FMAP0I45.IMG': [86, 338], 'FMAP0I46.IMG': [132, 340], 'FMAP0I47.IMG': [344, 309],
  'FMAP0I48.IMG': [381, 251], 'FMAP0I49.IMG': [553, 255], 'FMAP0I50.IMG': [661, 217], 'FMAP0I51.IMG': [672, 275],
  'FMAP0I52.IMG': [680, 256], 'FMAP0I53.IMG': [680, 340], 'FMAP0I54.IMG': [491, 340], 'FMAP0I55.IMG': [293, 340],
  'FMAP0I56.IMG': [263, 340], 'FMAP0I57.IMG': [680, 157], 'FMAP0I58.IMG': [17, 53], 'FMAP0I59.IMG': [0, 0],
  'FMAP0I60.IMG': [107, 11], 'FMAP0I61.IMG': [255, 275],
});

/** Region map panel size in classic pixels. */
export const REGION_MAP_W = 320;
export const REGION_MAP_H = 160;

/** DaggerfallTravelMapWindow.GetRegionMapNames. */
export function regionMapNames(region) {
  if (region === 0) return ['FMAPAI00.IMG', 'FMAPBI00.IMG'];
  if (region === 1) return ['FMAPAI01.IMG', 'FMAPBI01.IMG', 'FMAPCI01.IMG', 'FMAPDI01.IMG'];
  if (region === 16) return ['FMAPAI16.IMG', 'FMAPBI16.IMG', 'FMAPCI16.IMG', 'FMAPDI16.IMG'];
  return [`FMAP0I${String(region).padStart(2, '0')}.IMG`];
}

/** DaggerfallTravelMapWindow.GetRegionMapScale: Betony's map is drawn four times larger. */
export const regionMapScale = (region) => (region === 19 ? 4 : 1);

/**
 * Map pixel shown at the top-left corner of a region map. Equal to the offset
 * table except for Betony: DFU plots its dots by scaling the linear offset of a
 * bottom-up 320x160 buffer by four, which works out to x' = 4(x - 80) and
 * y' = 4y - 969, i.e. a top-left corner of (80, 242.25).
 */
export function regionMapCorner(name) {
  if (name === 'FMAP0I19.IMG') return [80, 969 / 4];
  return REGION_MAP_ORIGIN[name];
}

/** Which region map (of a multi-screen region) shows map pixel (x, y), or -1. */
export function regionMapFor(region, x, y) {
  const names = regionMapNames(region);
  const scale = regionMapScale(region);
  for (let i = 0; i < names.length; i++) {
    const o = regionMapCorner(names[i]);
    if (!o) continue;
    const lx = (x - o[0]) * scale, ly = (y - o[1]) * scale;
    if (lx >= 0 && ly >= 0 && lx < REGION_MAP_W && ly < REGION_MAP_H) return i;
  }
  return -1;
}

/** ImgFile.PaletteName for the images used here. */
export const paletteFor = (name) => (name.startsWith('FMAP') ? 'FMAP_PAL.COL' : 'ART_PAL.COL');

/** Lazily reads and caches the map pictures and palettes from an index of Files. */
export class MapImages {
  constructor(index) {
    this.index = index;
    this.cache = new Map();
  }

  has(name) {
    return this.index.has(name);
  }

  async bytes(name) {
    const f = this.index.get(name);
    if (!f) throw new WorldDataError(`${name} is missing from your Daggerfall files`);
    return readBlob(f, 0, f.size);
  }

  async palette(name) {
    const key = `pal:${name}`;
    if (!this.cache.has(key)) {
      const read = this.bytes(name).then((b) => parsePalette(b, name));
      this.cache.set(key, read);
      read.catch(() => this.cache.delete(key));
    }
    return this.cache.get(key);
  }

  /** {width, height, indices, rgba} */
  async image(name) {
    if (!this.cache.has(name)) {
      this.cache.set(name, (async () => {
        const img = decodeImg(await this.bytes(name), name);
        const rgba = toRgba(img, await this.palette(paletteFor(name)));
        return { ...img, rgba };
      })());
      this.cache.get(name).catch(() => this.cache.delete(name));
    }
    return this.cache.get(name);
  }
}
