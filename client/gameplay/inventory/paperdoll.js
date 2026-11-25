// Classic paper doll compositor: background, body, censor clothing, head and
// equipped items in draw order. Helmet and cloak mask pixels clear the
// character layer so the background shows through.
//
// Layout and layer rules follow Daggerfall Unity Game/Utility/PaperDollRenderer.cs
// and Game/UserInterface/PaperDoll.cs (MIT, (c) 2009-2023 Daggerfall Workshop):
// a 110x184 frame whose origin is (200, 8) in the files' screen offsets, a
// 40-pixel waist split for the clothed body, and palette index 0xFF as the mask.

import { dollFiles, dollLayers, isLowerClothed, isUpperClothed } from './images.js';

export const DOLL_WIDTH = 110;
export const DOLL_HEIGHT = 184;
export const DOLL_ORIGIN = Object.freeze({ x: 200, y: 8 });
export const WAIST_HEIGHT = 40;
const TRANSPARENT = 0;
const MASK = 0xff;

/**
 * Pure compositor over indexed images ({width,height,data,offsetX,offsetY}).
 * @returns {{rgba:Uint8ClampedArray, hits:Int16Array, slots:string[]}} hits holds slot index + 1 per pixel (0 = none).
 */
export function composeDoll({ palette, background, body, clothed, head, interior, layers = [], upperClothed, lowerClothed }) {
  const W = DOLL_WIDTH;
  const H = DOLL_HEIGHT;
  const bg = new Uint8ClampedArray(W * H * 4);
  const ch = new Uint8ClampedArray(W * H * 4);
  const hits = new Int16Array(W * H);
  const slots = [];
  const rgb = (c, out, o) => {
    out[o] = palette[c * 3];
    out[o + 1] = palette[c * 3 + 1];
    out[o + 2] = palette[c * 3 + 2];
    out[o + 3] = 255;
  };
  const blit = (img, out, { rows = [0, img?.height ?? 0], hit = 0, opaque = false } = {}) => {
    if (!img) return;
    const ox = img.offsetX - DOLL_ORIGIN.x;
    const oy = img.offsetY - DOLL_ORIGIN.y;
    for (let y = rows[0]; y < rows[1]; y++) {
      const ty = oy + y;
      if (ty < 0 || ty >= H) continue;
      for (let x = 0; x < img.width; x++) {
        const tx = ox + x;
        if (tx < 0 || tx >= W) continue;
        const c = img.data[y * img.width + x];
        const p = ty * W + tx;
        if (!opaque && c === TRANSPARENT) continue;
        if (hit && c === MASK) {
          out[p * 4 + 3] = 0; // mask clears what is underneath
          hits[p] = 0;
          continue;
        }
        rgb(c, out, p * 4);
        if (out === ch) hits[p] = hit;
      }
    }
  };
  blit(background, bg, { opaque: true });
  if (interior) blit(interior.img, ch, { hit: addSlot(slots, interior.slot) });
  blit(body, ch);
  if (clothed) {
    const split = Math.min(WAIST_HEIGHT, clothed.height);
    if (!upperClothed) blit(clothed, ch, { rows: [0, split] });
    if (!lowerClothed) blit(clothed, ch, { rows: [split, clothed.height] });
  }
  blit(head, ch);
  for (const l of layers) blit(l.img, ch, { hit: addSlot(slots, l.slot) });
  // Composite character over background.
  const rgba = bg;
  for (let p = 0; p < W * H; p++) {
    const o = p * 4;
    if (ch[o + 3]) {
      rgba[o] = ch[o];
      rgba[o + 1] = ch[o + 1];
      rgba[o + 2] = ch[o + 2];
      rgba[o + 3] = 255;
    } else if (!background) rgba[o + 3] = 0;
  }
  return { rgba, hits, slots };
}

function addSlot(slots, slot) {
  let i = slots.indexOf(slot);
  if (i < 0) i = slots.push(slot) - 1;
  return i + 1;
}

/** Slot under doll pixel (x, y), or null. */
export function slotAt(doll, x, y) {
  x = Math.floor(x);
  y = Math.floor(y);
  if (!doll || x < 0 || y < 0 || x >= DOLL_WIDTH || y >= DOLL_HEIGHT) return null;
  const h = doll.hits[y * DOLL_WIDTH + x];
  return h ? doll.slots[h - 1] : null;
}

/**
 * Load every image the doll needs from an ArtSource and compose it.
 * Returns null when the body art is not available (callers fall back to the slot grid).
 */
export async function buildDoll(art, palette, rpg) {
  const character = rpg?.character || {};
  const f = dollFiles(character);
  const [background, unclothed, clothed, head] = await Promise.all([
    art.img(f.background), art.img(f.bodyUnclothed), art.img(f.bodyClothed), art.cif(f.heads, f.faceIndex),
  ]);
  if (!clothed || !head || !palette) return null;
  const worn = dollLayers(rpg);
  const cloak = worn.find(({ slot, item }) => slot === 'cloak' && item.doll.cloak);
  const [images, lining] = await Promise.all([
    Promise.all(worn.map(async ({ slot, item }) => ({ slot, img: await art.item(item, character, { doll: true, slot }) }))),
    cloak && art.item(cloak.item, character, { doll: true, interior: true }),
  ]);
  const layers = images.filter(({ img }) => img);
  return {
    ...composeDoll({
      palette, background, body: unclothed ?? clothed, clothed, head, layers,
      interior: lining ? { slot: cloak.slot, img: lining } : null,
      upperClothed: isUpperClothed(layers), lowerClothed: isLowerClothed(layers),
    }),
    drawn: layers.map((l) => l.slot),
    missing: images.filter(({ img }) => !img).map(({ slot }) => slot),
    files: f,
  };
}
