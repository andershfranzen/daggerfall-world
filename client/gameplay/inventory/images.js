// Classic image readers and item-art addressing for the inventory and paper doll.
// Everything is read from the player's own ARENA2 files; nothing is bundled.
//
// IMG and CIF parsing is adapted from the MIT JS edition
// (.ref/dfjs-research-03 src/formats/imgFile.js, cifRciFile.js and
// baseImageFile.js, MIT, (c) 2026 Lattymoy), which translate Daggerfall Unity's
// API/ImgFile.cs and API/CifRciFile.cs (MIT, (c) 2009-2023 Daggerfall Workshop).
// Item archive/record selection follows Daggerfall Unity's ItemHelper.GetItemImage,
// GetCloakInteriorImage, ItemBuilder.SetRace/ApplyWeaponMaterial and
// RaceTemplate (MIT, Daggerfall Workshop). TEXTURE decoding reuses
// client/world/textures.js.

import { WorldDataError } from '../../world/errors.js';
import { TextureArchive, textureFileName } from '../../world/textures.js';
import { applyDye } from './dyes.js';

const IMG_RLE = 0x0002;

/** Raw IMG-style header at `pos`. */
function readHeader(view, pos) {
  if (pos + 12 > view.byteLength) throw new WorldDataError('image header out of range');
  return {
    xOffset: view.getInt16(pos, true),
    yOffset: view.getInt16(pos + 2, true),
    width: view.getInt16(pos + 4, true),
    height: view.getInt16(pos + 6, true),
    compression: view.getUint16(pos + 8, true),
    pixelDataLength: view.getUint16(pos + 10, true),
    dataPosition: pos + 12,
  };
}

/** Classic RLE: code > 127 repeats the next byte (code - 127) times, else copies code + 1 bytes. */
function readRle(bytes, src, end, dst) {
  let out = 0;
  while (out < dst.length) {
    if (src >= end) throw new WorldDataError('RLE data truncated');
    const code = bytes[src++];
    if (code > 127) {
      const count = code - 127;
      if (src >= end || out + count > dst.length) throw new WorldDataError('invalid RLE repeat');
      dst.fill(bytes[src++], out, out + count);
      out += count;
    } else {
      const count = code + 1;
      if (src + count > end || out + count > dst.length) throw new WorldDataError('invalid RLE copy');
      dst.set(bytes.subarray(src, src + count), out);
      src += count;
      out += count;
    }
  }
}

function decodeRecord(bytes, h) {
  if (h.width <= 0 || h.height <= 0 || h.width > 1024 || h.height > 1024) throw new WorldDataError('image has an invalid size');
  const n = h.width * h.height;
  const data = new Uint8Array(n);
  if (h.compression === IMG_RLE) {
    const end = h.dataPosition + h.pixelDataLength;
    if (end > bytes.length) throw new WorldDataError('RLE data out of range');
    readRle(bytes, h.dataPosition, end, data);
  }
  else {
    if (h.dataPosition + n > bytes.length) throw new WorldDataError('image data out of range');
    data.set(bytes.subarray(h.dataPosition, h.dataPosition + n));
  }
  return { width: h.width, height: h.height, offsetX: h.xOffset, offsetY: h.yOffset, data };
}

/** Parse a headered .IMG file (paper doll bodies and backgrounds). */
export function parseImg(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return decodeRecord(bytes, readHeader(view, 0));
}

/** Parse record `record` of a multi-image .CIF file (for example FACE00I0.CIF). */
export function parseCif(bytes, record) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  for (let r = 0; pos < bytes.length; r++) {
    const h = readHeader(view, pos);
    if (r === record) return decodeRecord(bytes, h);
    if (h.pixelDataLength <= 0 && h.width * h.height <= 0) break;
    pos = h.dataPosition + h.pixelDataLength;
  }
  throw new WorldDataError(`CIF record ${record} does not exist`);
}

/** Decode a TEXTURE record and its paper-doll offset (record header bytes 0-3). */
export function textureImage(archive, record) {
  const img = archive.decode(record);
  const pos = archive.records[record].pos;
  return { ...img, offsetX: archive.view.getInt16(pos, true), offsetY: archive.view.getInt16(pos + 2, true) };
}

// --- Character identity --------------------------------------------------------------------

/** Race index used by BODY/FACE/SCBG file names (RaceTemplate order). */
export const RACE_FILE_INDEX = Object.freeze({
  Breton: 0, Redguard: 1, Nord: 2, 'Dark Elf': 3, 'High Elf': 4, 'Wood Elf': 5, Khajiit: 6, Argonian: 7,
});
/** Body morphology offset used by armour and clothing archives (ItemBuilder.GetBodyMorphology). */
export const BODY_MORPHOLOGY = Object.freeze({ Argonian: 0, 'Dark Elf': 1, 'High Elf': 1, 'Wood Elf': 1, Khajiit: 3 });
export const GOLD_SPRITE = Object.freeze({ archive: 216, record: 1 });
export const LOOT_HEAP_SPRITE = Object.freeze({ archive: 216, record: 0 });
export const CREDIT_LETTER_SPRITE = Object.freeze({ archive: 209, record: 7 });

export function identity(character) {
  character ??= {};
  const female = /^f/i.test(String(character.gender ?? character.sex ?? ''));
  const race = Object.hasOwn(RACE_FILE_INDEX, character.race) ? character.race : 'Breton';
  const faceIndex = Number.isInteger(character.faceIndex) && character.faceIndex >= 0 && character.faceIndex < 10 ? character.faceIndex : 0;
  return { female, race, faceIndex, morph: BODY_MORPHOLOGY[race] ?? 2 };
}

/** Paper-doll file names for a character. */
export function dollFiles(character) {
  const { female, race, faceIndex } = identity(character);
  const r = RACE_FILE_INDEX[race];
  const s = female ? 1 : 0;
  return {
    background: `SCBG0${r}I0.IMG`,
    bodyUnclothed: `BODY${s}${r}I0.IMG`,
    bodyClothed: `BODY${s}${r}I1.IMG`,
    heads: `FACE${s}${r}I0.CIF`,
    faceIndex,
  };
}

/**
 * TEXTURE archive/record and dye for an item's art.
 * @param {object} item inventory record (fields from server/rpg/inventory.js)
 * @param {object} character wearer (gender, race)
 * @param {{doll?:boolean, ground?:boolean, slot?:string, interior?:boolean}} opts
 * @returns {{archive:number, record:number, dye:null|{kind:string,name:string}}|null}
 */
export function itemArt(item, character, { doll = false, ground = false, slot, interior = false } = {}) {
  if (!item) return null;
  const id = identity(character);
  if (interior && !item.doll?.cloak) return null;
  const currency = item.template === 'gold' ? GOLD_SPRITE : item.template === 'letter-of-credit' ? CREDIT_LETTER_SPRITE : null;
  const spec = doll ? item.doll : ground ? item.world ?? currency : item.icon ?? currency ?? item.world;
  if (!spec) return null;
  switch (spec.set) {
    case 'weapon': {
      const record = spec.record + Number(doll && (slot ?? item.equipped ?? item.slot) === 'rightHand' && item.hands === 'either');
      return { archive: id.female ? 233 : 234, record, dye: spec.dye ? { kind: 'metal', name: spec.dye } : null };
    }
    case 'armor': {
      const variant = spec.variants?.includes(item.variant) ? item.variant : null;
      const record = variant === null ? spec.record : spec.baseRecord + variant;
      return { archive: (id.female ? 245 : 249) + id.morph, record, dye: spec.dye ? { kind: 'metal', name: spec.dye } : null };
    }
    case 'clothing': {
      // Use the wearer's sex where the garment exists for it, otherwise the other sex's art.
      const female = id.female ? spec.female != null : spec.male == null;
      const base = female ? spec.female : spec.male;
      if (!Number.isInteger(base) || (interior && !spec.cloak)) return null;
      const variants = (female ? spec.femaleVariants : spec.maleVariants) ?? spec.variants ?? 1;
      const variant = Math.max(0, Math.min(variants - 1, item.variant | 0));
      const record = interior ? base : base + (spec.cloak ? 1 : 0) + variant;
      return { archive: (female ? 235 : 239) + id.morph, record, dye: spec.dye ? { kind: 'clothing', name: spec.dye } : null };
    }
    default:
      return Number.isInteger(spec.archive) && Number.isInteger(spec.record) ? { archive: spec.archive, record: spec.record, dye: null } : null;
  }
}

/** Equipped items in paper-doll draw order (PaperDollRenderer.BlitItems). */
export function dollLayers(rpg) {
  const inv = rpg?.inventory || [];
  const layers = [];
  for (const [slot, id] of Object.entries(rpg?.equipment || {})) {
    const it = inv.find((i) => i.id === id);
    if (it?.doll) layers.push({ slot, item: it, drawOrder: it.doll.drawOrder ?? 0 });
  }
  // Stable sort by draw order, ties broken by a fixed slot order for determinism.
  const ORDER = ['cloak', 'legsClothes', 'feet', 'chestClothes', 'legsArmor', 'chestArmor', 'rightArm', 'leftArm', 'gloves', 'head', 'rightHand', 'leftHand'];
  return layers.sort((a, b) => a.drawOrder - b.drawOrder || ORDER.indexOf(a.slot) - ORDER.indexOf(b.slot));
}

export const isUpperClothed = (layers) => layers.some(({ slot }) => slot === 'chestClothes' || slot === 'chestArmor');
export const isLowerClothed = (layers) => layers.some(({ slot }) => slot === 'legsClothes');

/** Lazily-read, cached access to the player's ARENA2 files by upper-case name. */
export class ArtSource {
  constructor(index = null) {
    this.index = index;
    this.cache = new Map();
  }

  has(name) {
    return !!this.index?.has(name);
  }

  bytes(name) {
    if (!this.cache.has(name)) {
      const f = this.index?.get(name);
      this.cache.set(name, f ? f.arrayBuffer().then((b) => new Uint8Array(b)).catch(() => null) : Promise.resolve(null));
    }
    return this.cache.get(name);
  }

  async archive(n) {
    const key = `#${n}`;
    if (!this.cache.has(key)) {
      this.cache.set(key, this.bytes(textureFileName(n)).then((b) => (b ? new TextureArchive(b, n) : null)).catch(() => null));
    }
    return this.cache.get(key);
  }

  /** Indexed image for an item ({width,height,data,offsetX,offsetY}) with dye applied, or null. */
  item(item, character, opts) {
    return this.image(itemArt(item, character, opts));
  }

  async image(art) {
    if (!art) return null;
    const ta = await this.archive(art.archive);
    if (!ta || art.record < 0 || art.record >= ta.recordCount) return null;
    try {
      const img = textureImage(ta, art.record);
      // Two original human female short-shirt records have misplaced offsets.
      if (art.archive === 237 && (art.record === 52 || art.record === 54)) {
        img.offsetX = 237;
        img.offsetY = 43;
      }
      if (art.dye) applyDye(img.data, art.dye.kind, art.dye.name);
      return img.data.some((c) => c !== 0 && c !== 0xff) ? img : null;
    } catch {
      return null;
    }
  }

  async img(name) {
    const b = await this.bytes(name);
    if (!b) return null;
    try {
      return parseImg(b);
    } catch {
      return null;
    }
  }

  async cif(name, record) {
    const b = await this.bytes(name);
    if (!b) return null;
    try {
      return parseCif(b, record);
    } catch {
      return null;
    }
  }
}
