// Actual Daggerfall ARENA2 equipped-gear peer billboard compositor & LRU cache.
// Composites a remote player's classic BODY*.IMG, FACE*.CIF, and every equipped
// item (cuirass, robes, cloak + interior lining, pauldrons, gauntlets/gloves,
// greaves, boots, helmet, dyed shirt/trousers, shield, held weapon) with a
// transparent (alpha = 0) background into a SpritePass-compatible RGBA atlas
// entry with a pixel-accurate alpha mask for crosshair targeting.
//
// Everything is decoded locally from the viewer's own ARENA2 files. Nothing is
// fetched from the network and nothing decoded here is transmitted.

import { indexFiles } from '../../world/files.js';
import { parsePalette } from '../../world/textures.js';
import {
  ArtSource,
  RACE_FILE_INDEX,
  dollFiles,
  dollLayers,
  isUpperClothed,
  isLowerClothed,
} from '../inventory/images.js';
import {
  composeDoll,
  DOLL_WIDTH,
  DOLL_HEIGHT,
} from '../inventory/paperdoll.js';

export const TARGET_HEIGHT_M = 1.78;
export const MIN_WORLD_HEIGHT_M = 0.5;
export const MAX_WORLD_HEIGHT_M = 2.4;
export const MIN_WORLD_WIDTH_M = 0.25;
export const MAX_WORLD_WIDTH_M = 2.2;

const CANONICAL_RACES = Object.freeze(
  Object.fromEntries(
    Object.keys(RACE_FILE_INDEX).map((name) => [name.toLowerCase().replace(/[\s_-]+/g, ''), name]),
  ),
);

const SLOT_ALIASES = Object.freeze({
  head: 'head',
  helm: 'head',
  helmet: 'head',
  hat: 'head',
  cloak: 'cloak',
  cloak1: 'cloak',
  cape: 'cloak',
  cloak2: 'cloak2',
  chestArmor: 'chestArmor',
  cuirass: 'chestArmor',
  chestClothes: 'chestClothes',
  shirt: 'chestClothes',
  robes: 'chestClothes',
  robe: 'chestClothes',
  tunic: 'chestClothes',
  rightArm: 'rightArm',
  leftArm: 'leftArm',
  gloves: 'gloves',
  gauntlets: 'gloves',
  hands: 'gloves',
  legsArmor: 'legsArmor',
  greaves: 'legsArmor',
  legsClothes: 'legsClothes',
  trousers: 'legsClothes',
  pants: 'legsClothes',
  feet: 'feet',
  boots: 'feet',
  shoes: 'feet',
  rightHand: 'rightHand',
  weapon: 'rightHand',
  leftHand: 'leftHand',
  shield: 'leftHand',
});

const CANONICAL_SLOT_ORDER = Object.freeze([
  'head',
  'cloak',
  'cloak2',
  'chestArmor',
  'chestClothes',
  'rightArm',
  'leftArm',
  'gloves',
  'legsArmor',
  'legsClothes',
  'feet',
  'rightHand',
  'leftHand',
]);

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function normalizeRace(raw) {
  if (typeof raw !== 'string') return 'Breton';
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return CANONICAL_RACES[key] ?? 'Breton';
}

function normalizeGender(raw) {
  return /^f/i.test(String(raw ?? '')) ? 'Female' : 'Male';
}

function normalizeFaceIndex(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < 10 ? n : 0;
}

function isPeerReadied(peer) {
  return peer?.readied === true || peer?.readied === 'weapon' || Boolean(peer?.readiedWeapon);
}

function canonicalSlot(rawSlot, entry) {
  const s = String(rawSlot ?? '').trim();
  if (!s) return null;
  if (s === 'chest') {
    const isArmor = entry?.group === 'armor' || entry?.doll?.set === 'armor' || Boolean(entry?.material && !entry?.dye);
    return isArmor ? 'chestArmor' : 'chestClothes';
  }
  if (s === 'legs') {
    const isArmor = entry?.group === 'armor' || entry?.doll?.set === 'armor' || Boolean(entry?.material && !entry?.dye);
    return isArmor ? 'legsArmor' : 'legsClothes';
  }
  return SLOT_ALIASES[s] ?? null;
}

function sanitizeDollSpec(doll, fallbackDye) {
  if (!doll || typeof doll !== 'object') return null;
  const out = {};
  if (typeof doll.set === 'string' && doll.set) out.set = doll.set;
  if (Number.isInteger(doll.archive)) out.archive = doll.archive;
  if (Number.isInteger(doll.record)) out.record = doll.record;
  if (Number.isInteger(doll.baseRecord)) out.baseRecord = doll.baseRecord;
  if (Array.isArray(doll.variants)) out.variants = doll.variants.filter((v) => Number.isInteger(v));
  else if (Number.isInteger(doll.variants)) out.variants = doll.variants;
  if (Number.isInteger(doll.male)) out.male = doll.male;
  if (Number.isInteger(doll.female)) out.female = doll.female;
  if (Number.isInteger(doll.maleVariants)) out.maleVariants = doll.maleVariants;
  if (Number.isInteger(doll.femaleVariants)) out.femaleVariants = doll.femaleVariants;
  if (Number.isInteger(doll.variant)) out.variant = doll.variant;
  if (doll.cloak) out.cloak = true;
  if (Number.isFinite(doll.drawOrder)) out.drawOrder = Number(doll.drawOrder);
  const dye = typeof doll.dye === 'string' && doll.dye.trim() ? doll.dye.trim() : fallbackDye;
  if (typeof dye === 'string' && dye) out.dye = dye.toLowerCase();
  return Object.keys(out).length ? out : null;
}

function normalizeSlotItem(slot, raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const template = raw.trim();
    if (!template) return null;
    return { id: `peer-${slot}`, slot, equipped: slot, template, name: template };
  }
  if (typeof raw !== 'object') return null;

  const template = typeof raw.template === 'string' && raw.template.trim() ? raw.template.trim() : null;
  const base = typeof raw.base === 'string' && raw.base.trim() ? raw.base.trim() : null;
  const material = typeof raw.material === 'string' && raw.material.trim() ? raw.material.trim().toLowerCase() : null;
  const dye = typeof raw.dye === 'string' && raw.dye.trim() ? raw.dye.trim().toLowerCase() : null;
  const fallbackDye = dye ?? material;
  const doll = sanitizeDollSpec(raw.doll, fallbackDye);

  if (!template && !base && !doll && !raw.name) return null;

  const item = {
    id: raw.id != null ? String(raw.id) : `peer-${slot}`,
    slot,
    equipped: slot,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : (template ?? base ?? slot),
  };
  if (template) item.template = template;
  if (base) item.base = base;
  if (typeof raw.group === 'string' && raw.group.trim()) item.group = raw.group.trim();
  if (material) item.material = material;
  if (dye) item.dye = dye;
  if (Number.isInteger(raw.variant)) item.variant = raw.variant;
  else if (Number.isInteger(doll?.variant)) item.variant = doll.variant;
  if (typeof raw.hands === 'string' && raw.hands.trim()) item.hands = raw.hands.trim();
  if (doll) item.doll = doll;
  return item;
}

/**
 * Convert a public peer object into the minimal synthetic `rpg` structure
 * consumed by `dollLayers(rpg)` and `composeDoll(...)`.
 */
export function peerToDollRpg(peer) {
  const src = peer && typeof peer === 'object' ? peer : {};
  const character = {
    race: normalizeRace(src.race ?? src.character?.race),
    gender: normalizeGender(src.gender ?? src.sex ?? src.character?.gender ?? src.character?.sex),
    faceIndex: normalizeFaceIndex(src.faceIndex ?? src.character?.faceIndex),
  };

  const equipment = {};
  const inventory = [];
  const addEntry = (rawSlot, rawItem) => {
    const slot = canonicalSlot(rawSlot, rawItem);
    if (!slot || equipment[slot]) return;
    const item = normalizeSlotItem(slot, rawItem);
    if (!item) return;
    equipment[slot] = item.id;
    inventory.push(item);
  };

  if (Array.isArray(src.worn)) {
    for (const entry of src.worn) {
      if (entry && typeof entry === 'object') addEntry(entry.slot ?? entry.equipped, entry);
    }
  } else if (src.worn && typeof src.worn === 'object') {
    for (const [slot, entry] of Object.entries(src.worn)) {
      addEntry(slot, entry);
    }
  }

  if (!equipment.rightHand && src.weapon) {
    addEntry('rightHand', src.weapon);
  }

  return { character, equipment, inventory };
}

function dollSpecKey(doll) {
  if (!doll || typeof doll !== 'object') return '';
  const parts = [];
  if (doll.set) parts.push(`s=${doll.set}`);
  if (Number.isInteger(doll.archive)) parts.push(`a=${doll.archive}`);
  if (Number.isInteger(doll.record)) parts.push(`r=${doll.record}`);
  if (Number.isInteger(doll.baseRecord)) parts.push(`br=${doll.baseRecord}`);
  if (Array.isArray(doll.variants)) parts.push(`vs=${doll.variants.join(',')}`);
  else if (Number.isInteger(doll.variants)) parts.push(`vs=${doll.variants}`);
  if (Number.isInteger(doll.male)) parts.push(`m=${doll.male}`);
  if (Number.isInteger(doll.female)) parts.push(`f=${doll.female}`);
  if (Number.isInteger(doll.maleVariants)) parts.push(`mv=${doll.maleVariants}`);
  if (Number.isInteger(doll.femaleVariants)) parts.push(`fv=${doll.femaleVariants}`);
  if (Number.isInteger(doll.variant)) parts.push(`v=${doll.variant}`);
  if (doll.cloak) parts.push('c=1');
  if (Number.isFinite(doll.drawOrder)) parts.push(`o=${doll.drawOrder}`);
  if (doll.dye) parts.push(`d=${doll.dye}`);
  return parts.join(',');
}

/**
 * Deterministic, compact cache key covering a peer's visual identity and gear:
 * `race`, `gender`, `faceIndex`, every worn slot (`template`, `base`, `material`,
 * `dye`, `variant`, `hands`, `doll`), `weapon` (`template`, `material`, ...),
 * and `readied` state.
 */
export function peerDollSignature(peer) {
  const src = peer && typeof peer === 'object' ? peer : {};
  const rpg = peerToDollRpg(src);
  const { race, gender, faceIndex } = rpg.character;
  const g = gender === 'Female' ? 'F' : 'M';
  const readied = isPeerReadied(src) ? 1 : 0;

  const byId = new Map();
  for (const item of rpg.inventory) byId.set(item.id, item);

  const slotParts = [];
  for (const slot of CANONICAL_SLOT_ORDER) {
    const id = rpg.equipment[slot];
    if (!id) continue;
    const it = byId.get(id);
    if (!it) continue;
    const fields = [
      it.template ?? '',
      it.base ?? '',
      it.material ?? '',
      it.dye ?? '',
      Number.isInteger(it.variant) ? String(it.variant) : '',
      it.hands ?? '',
      dollSpecKey(it.doll),
    ];
    slotParts.push(`${slot}:${fields.join('/')}`);
  }

  let weaponPart = '';
  if (src.weapon) {
    if (typeof src.weapon === 'string') {
      weaponPart = src.weapon.trim().toLowerCase();
    } else if (typeof src.weapon === 'object') {
      const wt = typeof src.weapon.template === 'string' ? src.weapon.template.trim() : '';
      const wm = typeof src.weapon.material === 'string' ? src.weapon.material.trim().toLowerCase() : '';
      weaponPart = `${wt}/${wm}`;
    }
  }

  return `${race}|${g}|${faceIndex}|r${readied}|w:${weaponPart}|${slotParts.join(';')}`;
}

/**
 * Crop transparent outer margins (`alpha === 0`) from an RGBA paper-doll buffer
 * so the character's feet sit flush on the bottom edge (`y = 0` in world space),
 * and compute aspect-preserved world dimensions scaled to classic human height.
 *
 * Returns `null` when the buffer has no non-transparent pixels.
 */
export function trimDollBounds(rgba, width = DOLL_WIDTH, height = DOLL_HEIGHT) {
  if (!rgba || width <= 0 || height <= 0 || rgba.length < width * height * 4) return null;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    const rowOff = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (rgba[rowOff + x * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) return null;

  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const pixels = new Uint8Array(w * h * 4);
  const srcStride = width * 4;
  const dstStride = w * 4;

  for (let row = 0; row < h; row++) {
    const srcStart = (minY + row) * srcStride + minX * 4;
    pixels.set(rgba.subarray(srcStart, srcStart + dstStride), row * dstStride);
  }

  const worldHeight = clamp(TARGET_HEIGHT_M, MIN_WORLD_HEIGHT_M, MAX_WORLD_HEIGHT_M);
  const worldWidth = clamp(worldHeight * (w / h), MIN_WORLD_WIDTH_M, MAX_WORLD_WIDTH_M);

  return {
    x: minX,
    y: minY,
    w,
    h,
    pixels,
    fullWidth: width,
    fullHeight: height,
    worldWidth,
    worldHeight,
  };
}

/**
 * Build a SpritePass-compatible billboard entry for a remote player by
 * compositing their authentic ARENA2 body, head, and equipped gear with a
 * transparent (`background: null`) alpha channel.
 *
 * Returns `null` when required ARENA2 body/head/palette assets are missing.
 */
export async function buildPeerDollEntry(
  peer,
  { art = null, palette = null, buildDollFn = null, composeDollFn = composeDoll, version = 1 } = {},
) {
  const rpg = peerToDollRpg(peer);
  const character = rpg.character;
  const composeFn = typeof composeDollFn === 'function' ? composeDollFn : composeDoll;

  let composed = null;
  let drawnSlots = [];
  let missingSlots = [];

  if (typeof buildDollFn === 'function') {
    const res = await buildDollFn(art, palette, rpg, { background: null, composeDoll: composeFn });
    if (!res?.rgba) return null;
    composed = res;
    drawnSlots = Array.isArray(res.drawn) ? res.drawn.slice() : [];
    missingSlots = Array.isArray(res.missing) ? res.missing.slice() : [];
  } else {
    if (!art || !palette) return null;
    const f = dollFiles(character);
    const [unclothed, clothed, head] = await Promise.all([
      art.img(f.bodyUnclothed),
      art.img(f.bodyClothed),
      art.cif(f.heads, f.faceIndex),
    ]);
    if (!clothed || !head) return null;

    const worn = dollLayers(rpg);
    const cloak = worn.find(({ slot, item }) => (slot === 'cloak' || slot === 'cloak2') && item.doll?.cloak);
    const [images, lining] = await Promise.all([
      Promise.all(
        worn.map(async ({ slot, item }) => ({
          slot,
          img: await art.item(item, character, { doll: true, slot }),
        })),
      ),
      cloak ? art.item(cloak.item, character, { doll: true, interior: true }) : Promise.resolve(null),
    ]);
    const layers = images.filter(({ img }) => img);
    drawnSlots = layers.map((l) => l.slot);
    missingSlots = images.filter(({ img }) => !img).map(({ slot }) => slot);

    composed = composeFn({
      palette,
      background: null,
      body: unclothed ?? clothed,
      clothed,
      head,
      layers,
      interior: lining ? { slot: cloak.slot, img: lining } : null,
      upperClothed: isUpperClothed(layers),
      lowerClothed: isLowerClothed(layers),
    });
  }

  const trimmed = trimDollBounds(
    composed.rgba,
    composed.width ?? DOLL_WIDTH,
    composed.height ?? DOLL_HEIGHT,
  );
  if (!trimmed) return null;

  const pixelCount = trimmed.w * trimmed.h;
  const alphaMask = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    alphaMask[i] = trimmed.pixels[i * 4 + 3] > 127 ? 1 : 0;
  }

  const sig = peerDollSignature(peer);
  const frameObj = { width: trimmed.w, height: trimmed.h, data: alphaMask };

  return {
    archive: `doll:${sig}`,
    signature: sig,
    version,
    atlas: {
      width: trimmed.w,
      height: trimmed.h,
      pixels: trimmed.pixels,
      rects: [[{ x: 0, y: 0, w: trimmed.w, h: trimmed.h }]],
    },
    sprite: {
      recordCount: 1,
      records: [
        {
          frameCount: 1,
          width: trimmed.w,
          height: trimmed.h,
          world: { width: trimmed.worldWidth, height: trimmed.worldHeight },
        },
      ],
      frameCount: (r = 0) => (r === 0 ? 1 : 0),
      frame: () => frameObj,
    },
    bounds: {
      x: trimmed.x,
      y: trimmed.y,
      w: trimmed.w,
      h: trimmed.h,
      fullWidth: trimmed.fullWidth,
      fullHeight: trimmed.fullHeight,
    },
    drawnSlots,
    missingSlots,
  };
}

async function defaultLoadPalette(art) {
  if (!art) return null;
  for (const name of ['ART_PAL.COL', 'PAL.PAL']) {
    const bytes = await art.bytes(name);
    if (bytes) {
      try {
        return parsePalette(bytes, name);
      } catch {
        // Fall through to next candidate palette file.
      }
    }
  }
  return null;
}

/**
 * LRU-bounded compositor cache for remote player equipped-gear billboards.
 * Reads exclusively from local ARENA2 files supplied via `setFiles(files)`.
 */
export class PeerDollLibrary {
  #createArtSource;
  #loadPalette;
  #buildDollFn;
  #composeDollFn;
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  constructor({
    maxEntries = 128,
    createArtSource = null,
    loadPalette = null,
    buildDollFn = null,
    composeDollFn = null,
  } = {}) {
    this.maxEntries = Math.max(1, Math.floor(Number(maxEntries) || 128));
    this.#createArtSource = typeof createArtSource === 'function'
      ? createArtSource
      : (index) => new ArtSource(index);
    this.#loadPalette = typeof loadPalette === 'function' ? loadPalette : defaultLoadPalette;
    this.#buildDollFn = typeof buildDollFn === 'function' ? buildDollFn : null;
    this.#composeDollFn = typeof composeDollFn === 'function' ? composeDollFn : composeDoll;

    this.index = null;
    this.art = null;
    this.palette = null;
    this.paletteLoad = null;
    this.entries = new Map();
    this.pending = new Map();
    this.failed = new Set();
    this.generation = 0;
    this.onReady = null;
  }

  /** Point at a new local ARENA2 FileList / iterable / Map. Drops all cached billboards. */
  setFiles(files) {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
    this.failed.clear();
    this.palette = null;
    this.paletteLoad = null;

    if (!files) {
      this.index = null;
      this.art = null;
      return;
    }

    try {
      this.index = files instanceof Map ? files : indexFiles(files);
      this.art = this.#createArtSource(this.index);
    } catch {
      this.index = null;
      this.art = null;
    }
  }

  /**
   * Synchronously return a cached billboard entry for `peer` (updating LRU recency),
   * or `null` while kicking off deduplicated async composition in the background.
   */
  get(peer) {
    const sig = peerDollSignature(peer);
    const cached = this.entries.get(sig);
    if (cached) {
      this.#hits++;
      this.entries.delete(sig);
      this.entries.set(sig, cached);
      return cached;
    }
    this.#misses++;
    if ((this.art || this.#buildDollFn) && !this.pending.has(sig) && !this.failed.has(sig)) {
      this.load(peer).catch(() => null);
    }
    return null;
  }

  /** Await composition of a peer's equipped-gear billboard (deduplicated by signature). */
  async load(peer) {
    const sig = peerDollSignature(peer);
    const cached = this.entries.get(sig);
    if (cached) {
      this.entries.delete(sig);
      this.entries.set(sig, cached);
      return cached;
    }
    const inflight = this.pending.get(sig);
    if (inflight) return inflight;

    if (!this.art && !this.#buildDollFn) return null;

    const gen = this.generation;
    const art = this.art;

    const task = (async () => {
      try {
        const palette = await this.#ensurePalette(gen, art);
        if (gen !== this.generation) return null;
        if (!palette && !this.#buildDollFn) {
          this.failed.add(sig);
          return null;
        }
        const entry = await buildPeerDollEntry(peer, {
          art,
          palette,
          buildDollFn: this.#buildDollFn,
          composeDollFn: this.#composeDollFn,
          version: gen,
        });
        if (gen !== this.generation) return null;
        if (!entry) {
          this.failed.add(sig);
          return null;
        }
        this.#store(sig, entry);
        this.onReady?.(sig, entry);
        return entry;
      } catch {
        if (gen === this.generation) this.failed.add(sig);
        return null;
      } finally {
        if (gen === this.generation && this.pending.get(sig) === task) {
          this.pending.delete(sig);
        }
      }
    })();

    this.pending.set(sig, task);
    return task;
  }

  #ensurePalette(gen, art) {
    if (this.palette) return Promise.resolve(this.palette);
    if (!this.paletteLoad) {
      this.paletteLoad = Promise.resolve()
        .then(() => this.#loadPalette(art, this.index))
        .then((pal) => {
          if (gen === this.generation) this.palette = pal ?? null;
          return pal ?? null;
        })
        .catch(() => null);
    }
    return this.paletteLoad;
  }

  #store(sig, entry) {
    if (this.entries.has(sig)) {
      this.entries.delete(sig);
    } else {
      while (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        this.entries.delete(oldest);
        this.#evictions++;
      }
    }
    this.entries.set(sig, entry);
  }

  dispose() {
    this.generation++;
    this.entries.clear();
    this.pending.clear();
    this.failed.clear();
    this.index = null;
    this.art = null;
    this.palette = null;
    this.paletteLoad = null;
    this.onReady = null;
  }

  stats() {
    return {
      entries: this.entries.size,
      pending: this.pending.size,
      failed: this.failed.size,
      maxEntries: this.maxEntries,
      generation: this.generation,
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
    };
  }
}
