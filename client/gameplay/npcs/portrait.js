// NPC art from the player's own ARENA2. FLATS.CFG and FACTION.TXT resolve
// world sprites to portrait records, following Daggerfall Unity's API/FlatsFile.cs,
// API/CifRciFile.cs and Game/TalkManager.cs (MIT, © 2009–2023 Daggerfall Workshop).
import { TextureArchive, textureFileName } from '../../world/textures.js';
import { artCanvas, ClassicUiArt, toRgba } from '../../hud/classic-art.js';
import { parseFactionText } from './factionFile.js';

const COMMON = 'TFAC00I0.RCI';
const SPECIAL = 'FACES.CIF';
const FACE_SIZE = 64;
const FACE_BYTES = FACE_SIZE * FACE_SIZE;
const NO_COMMON_FACE = 410; // Original "Oops! Tell Mark now!" debugging card.

const spriteKey = (a, r) => `${a}:${r}`;

export function parseFlatFaces(text) {
  const faces = new Map();
  for (const block of text.trim().split(/\r?\n[ \t]*\r?\n/)) {
    const lines = block.trim().split(/\r?\n/);
    const flat = /^(\d+)\s+(\d+)$/.exec(lines[0]);
    const face = lines[5]?.trim();
    if (!flat || !/^\d+$/.test(face ?? '')) continue;
    const key = spriteKey(Number(flat[1]), Number(flat[2]));
    if (!faces.has(key)) faces.set(key, Number(face));
  }
  return faces;
}

export function faceRecord(bytes, record) {
  const start = record * FACE_BYTES;
  if (!Number.isInteger(record) || record < 0 || start + FACE_BYTES > bytes.length) return null;
  return { width: FACE_SIZE, height: FACE_SIZE, indices: bytes.subarray(start, start + FACE_BYTES) };
}

function specialFace(factions, key, faction, useNamedFlat) {
  const matches = (f) => f?.type === 4 && Number.isInteger(f.face) && f.face >= 0 &&
    f.flats.some(([a, r]) => spriteKey(a, r) === key);
  const owner = factions?.get(faction);
  if (matches(owner)) return owner.face;
  if (!useNamedFlat || !factions) return null;
  for (const f of factions.values()) {
    if (matches(f)) return f.face;
  }
  return null;
}

export class NpcAssets {
  constructor() {
    this.setFiles([]);
  }

  setFiles(files) {
    this.art = new ClassicUiArt(files);
    this.archives = new Map();
    this.images = new Map();
    this.flats = null;
    this.factions = null;
  }

  getPalette() { return this.art.palette(); }

  getArchive(archive) {
    if (!this.archives.has(archive)) {
      this.archives.set(archive, this.art.bytes(textureFileName(archive))
        .then((b) => b ? new TextureArchive(b, archive) : null).catch(() => null));
    }
    return this.archives.get(archive);
  }

  getFactions() {
    this.factions ??= this.art.bytes('FACTION.TXT').then((b) => b ? parseFactionText(new TextDecoder().decode(b)) : null);
    return this.factions;
  }

  getFlats() {
    this.flats ??= this.art.bytes('FLATS.CFG').then((b) => b ? parseFlatFaces(new TextDecoder().decode(b)) : null);
    return this.flats;
  }

  /** Decode once per sprite and return a new canvas for each mounted portrait. */
  async portrait(sprite, faction) {
    if (!sprite || !Number.isInteger(sprite.archive) || !Number.isInteger(sprite.record) || typeof document === 'undefined') return null;
    const key = spriteKey(sprite.archive, sprite.record);
    const cacheKey = `${key}:${faction ?? ''}`;
    if (!this.images.has(cacheKey)) {
      this.images.set(cacheKey, this.readPortrait(sprite, key, faction).catch(() => null));
    }
    const image = await this.images.get(cacheKey);
    if (!image) return null;
    const canvas = artCanvas(image.width, image.height, image.rgba);
    canvas.dataset.source = image.source;
    return canvas;
  }

  async readPortrait(sprite, key, faction) {
    const art = this.art;
    const [flats, factions, palette] = await Promise.all([this.getFlats(), this.getFactions(), art.palette()]);
    if (!palette || art !== this.art) return null;
    const common = flats?.get(key);
    // Many named characters reuse common people sprites. Only the named archive's
    // unassigned portraits can be resolved by the flat alone.
    const useNamedFlat = sprite.archive === 334 && (common == null || common === 0);
    const special = specialFace(factions, key, faction, useNamedFlat);
    const candidates = [
      special == null ? null : [special > 60 ? COMMON : SPECIAL, special],
      common == null || common === NO_COMMON_FACE || useNamedFlat ? null : [COMMON, common],
    ];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const [file, record] = candidate;
      const bytes = await art.bytes(file);
      const img = bytes && faceRecord(bytes, record);
      if (img && art === this.art) return { ...img, rgba: toRgba(img, palette, true), source: `${file}#${record}` };
    }
    if (art !== this.art) return null;
    const archive = await this.getArchive(sprite.archive);
    if (!archive || art !== this.art) return null;
    const { width, height, data: indices } = archive.decode(sprite.record);
    return { width, height, rgba: toRgba({ width, height, indices }, palette, true), source: textureFileName(sprite.archive) + '#' + sprite.record };
  }
}


const npcSources = new WeakMap();

export function getNpcAssets(api) {
  if (!npcSources.has(api)) {
    const assets = new NpcAssets();
    assets.setFiles(api.files);
    api.on('assets', (files) => assets.setFiles(files));
    npcSources.set(api, assets);
  }
  return npcSources.get(api);
}
