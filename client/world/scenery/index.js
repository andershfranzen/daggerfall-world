// loadScenery(files, town): the static outdoor scenery of a town loaded by
// world/town.js — RMB flats (trees, lamps, signs, animals, decorations), the
// climate's SKYnn.DAT day sky and a terrain apron with nature flats from
// WOODS.WLD — as CPU arrays ready for client/gameplay/scenery/pass.js.
// Everything is read from the player's own files; nothing is bundled.
// Contract and fallbacks: README.md in this directory.

import { BsaArchive, NAME_RECORD, readBlob } from '../bsa.js';
import { defaultWorldData, resolveRmbBlock } from '../wilderness/replacements.js';
import { indexFiles, requireFiles } from '../files.js';
import { parsePalette } from '../textures.js';
import { WorldDataError } from '../errors.js';
import { parseRmbFlats, layoutTownFlats, BLOCK_SIZE } from './rmbFlats.js';
import { FlatArchive } from './flatTextures.js';
import { readDaySky, skyBase, natureArchive as natureArchiveOf, skyFileName, SEASONS, DEFAULT_SKY_FRAME } from './sky.js';
import { readWoodsHeightmap, buildSurroundings, mapPixelOf, hash2 } from './terrain.js';
import { applyClimate } from '../town.js';

export { WorldDataError };

const ATLAS_WIDTH = 2048;
const MAX_ATLAS_HEIGHT = 4096;
const MAX_FRAMES = 16;
const PAD = 1;
const TEX = (a) => `TEXTURE.${String(a).padStart(3, '0')}`;

const reader = (file) => (offset, length) => readBlob(file, offset, length);

/**
 * @param {Iterable<File>} files - the same files given to loadTown
 * @param {object} town - the result of loadTown (uses town.source)
 * @param {{skyFrame?:number, season?:keyof SEASONS, winter?:boolean, skyIndex?:number, terrain?:boolean, maxNature?:number}} [options]
 *   `winter`: the climate's winter nature set and snow ground (client/world/exterior/season.js); `skyIndex`: a weather sky.
 */
export async function loadScenery(files, town, options = {}) {
  const src = town?.source;
  if (!src || !Array.isArray(src.blocks) || !src.spawnLocal || !src.climate) {
    throw new WorldDataError('loadScenery needs a town from world/town.js (town.source is missing)');
  }
  const index = indexFiles(files);
  const [blocksF, palF] = requireFiles(index, ['BLOCKS.BSA', 'ART_PAL.COL']);
  const palette = parsePalette(await readBlob(palF, 0, palF.size), 'ART_PAL.COL');
  const warnings = [];
  const climateValue = src.climate.value;
  const winter = !!options.winter && src.climate.climateBase !== 0;
  // ClimateSwaps.GetNatureArchive: only the woodland, hills, haunted and mountain sets have winter flats.
  const nature = applyClimate(natureArchiveOf(climateValue), 0, src.climate.climateBase, winter);
  const groundArchive = winter ? src.climate.groundArchive + 1 : src.climate.groundArchive;
  const desert = climateValue === 224 || climateValue === 225;

  // --- RMB flats ---
  const bsa = await BsaArchive.open(blocksF, 'BLOCKS.BSA', NAME_RECORD);
  const blocks = [];
  for (const b of src.blocks) {
    const r = await resolveRmbBlock(bsa, b.name, b.replaced ? (options.worldData !== undefined ? options.worldData : defaultWorldData(files)) : null);
    if (r.index < 0) throw new WorldDataError(`BLOCKS.BSA: block ${b.name} (used by ${town.name}) is missing`);
    blocks.push({ x: b.x, y: b.y, rmb: r.block ?? parseRmbFlats(await bsa.read(r.index), r.name) });
  }
  const { flats: townFlats, skipped } = layoutTownFlats(blocks, src.spawnLocal, nature);

  // --- Surroundings ---
  const townRect = {
    minX: -src.spawnLocal.x,
    maxX: src.width * BLOCK_SIZE - src.spawnLocal.x,
    minZ: -(src.height * BLOCK_SIZE - src.spawnLocal.z),
    maxZ: src.spawnLocal.z,
  };
  let surroundings = null;
  if (options.terrain !== false) {
    let heightmap = null;
    const woods = index.get('WOODS.WLD');
    if (woods) {
      try {
        heightmap = await readWoodsHeightmap(reader(woods), woods.size);
      } catch (err) {
        if (!(err instanceof WorldDataError)) throw err;
        warnings.push(`${err.message}; the surroundings are flat.`);
      }
    } else {
      warnings.push('WOODS.WLD is not in the selected folder; the surroundings are flat.');
    }
    const mapPixel = mapPixelOf(src.longitude, src.latitude);
    surroundings = buildSurroundings({
      townRect,
      heightmap,
      mapPixel,
      pixelOffset: { x: (townRect.minX + townRect.maxX) / 2, z: (townRect.minZ + townRect.maxZ) / 2 },
      seed: hash2(src.mapId | 0, src.locationIndex | 0, src.regionIndex | 0),
      desert,
      maxNature: options.maxNature,
    });
  }

  // --- Flat archives ---
  const archives = new Map();
  const missingArchives = new Set();
  const archiveFor = async (archive) => {
    if (archives.has(archive)) return archives.get(archive);
    const f = index.get(TEX(archive));
    let fa = null;
    if (!f) missingArchives.add(archive);
    else {
      try {
        fa = new FlatArchive(new Uint8Array(await f.arrayBuffer()), archive);
      } catch (err) {
        if (!(err instanceof WorldDataError)) throw err;
        warnings.push(err.message);
      }
    }
    archives.set(archive, fa);
    return fa;
  };
  const all = [...townFlats];
  if (surroundings) for (const n of surroundings.nature) all.push({ archive: nature, record: n.record, kind: 'nature', x: n.x, y: n.y, z: n.z, source: 'terrain' });

  const sprites = new Map(); // "archive:record" -> sprite or null
  const placed = [];
  let droppedFlats = 0;
  for (const f of all) {
    const key = `${f.archive}:${f.record}`;
    if (!sprites.has(key)) {
      const fa = await archiveFor(f.archive);
      let sprite = null;
      if (fa) {
        try {
          const frames = Math.min(fa.frameCount(f.record), MAX_FRAMES);
          const imgs = [];
          for (let k = 0; k < frames; k++) imgs.push(fa.decode(f.record, k));
          sprite = { key, archive: f.archive, record: f.record, size: fa.size(f.record), frames: imgs };
        } catch (err) {
          if (!(err instanceof WorldDataError)) throw err;
          warnings.push(err.message);
        }
      }
      sprites.set(key, sprite);
    }
    const sprite = sprites.get(key);
    if (!sprite) { droppedFlats++; continue; }
    placed.push({ ...f, sprite });
  }
  if (missingArchives.size) {
    warnings.push(`Missing ${[...missingArchives].sort((a, b) => a - b).map(TEX).join(', ')}; ${droppedFlats} flats are not drawn.`);
  }

  const { atlas, rects } = packSprites([...sprites.values()].filter(Boolean), palette);
  const billboards = buildBillboards(placed, rects, src);

  // --- Ground tiles for the surroundings ---
  let terrain = null;
  if (surroundings && surroundings.positions.length) {
    const ground = await groundTiles(index, groundArchive, palette);
    if (ground) {
      terrain = { ...surroundings, atlas: ground.atlas, rects: ground.rects };
    } else {
      warnings.push(`${TEX(groundArchive)} is missing; the surroundings are not drawn.`);
    }
  }

  // --- Sky ---
  let sky = null;
  const season = SEASONS[options.season ?? 'summer'] ?? SEASONS.summer;
  const skyIndex = Number.isInteger(options.skyIndex) ? options.skyIndex : skyBase(climateValue) + season;
  const skyName = skyFileName(skyIndex);
  const skyF = index.get(skyName);
  if (skyF) {
    try {
      sky = { ...(await readDaySky(reader(skyF), skyF.size, options.skyFrame ?? DEFAULT_SKY_FRAME, skyName)), index: skyIndex, file: skyName };
    } catch (err) {
      if (!(err instanceof WorldDataError)) throw err;
      warnings.push(`${err.message}; the default sky is kept.`);
    }
  } else {
    warnings.push(`${skyName} is not in the selected folder; the default sky is kept.`);
  }

  const kinds = {};
  for (const f of placed) kinds[`${f.source}:${f.kind}`] = (kinds[`${f.source}:${f.kind}`] ?? 0) + 1;
  return {
    town: { name: town.name, region: town.region },
    townRect,
    billboards,
    atlas,
    terrain,
    sky,
    warnings,
    stats: {
      townFlats: townFlats.length,
      terrainFlats: surroundings?.nature.length ?? 0,
      drawnFlats: placed.length,
      droppedFlats,
      skippedPeople: skipped.people,
      skippedEditor: skipped.editor,
      sprites: rects.size,
      natureArchive: nature,
      kinds,
      terrain: surroundings?.stats ?? null,
      sky: sky ? { file: sky.file, frame: sky.frame } : null,
      atlas: { width: atlas.width, height: atlas.height },
    },
  };
}

/** Shelf-pack sprites; each sprite's frames sit side by side in one strip. */
export function packSprites(sprites, palette) {
  const items = sprites.map((s) => {
    const fw = s.frames[0].width, fh = s.frames[0].height;
    let n = s.frames.length;
    while (n > 1 && n * (fw + PAD) + PAD > ATLAS_WIDTH) n--;
    return { s, fw, fh, n, w: n * (fw + PAD) + PAD, h: fh + 2 * PAD };
  });
  items.sort((a, b) => b.h - a.h || b.w - a.w);
  let x = 0, y = 0, shelf = 0;
  for (const it of items) {
    if (it.w > ATLAS_WIDTH) throw new WorldDataError(`flat ${it.s.key} is wider than the atlas`);
    if (x + it.w > ATLAS_WIDTH) { x = 0; y += shelf; shelf = 0; }
    it.x = x; it.y = y;
    x += it.w;
    shelf = Math.max(shelf, it.h);
  }
  let height = 1;
  while (height < y + shelf) height *= 2;
  if (height > MAX_ATLAS_HEIGHT) throw new WorldDataError(`flat atlas would be ${height} pixels tall`);
  const pixels = new Uint8Array(ATLAS_WIDTH * height * 4);
  const rects = new Map();
  for (const it of items) {
    for (let k = 0; k < it.n; k++) {
      const { width: w, height: h, data } = it.s.frames[k];
      const ox = it.x + PAD + k * (it.fw + PAD), oy = it.y + PAD;
      for (let yy = 0; yy < Math.min(h, it.fh); yy++) {
        for (let xx = 0; xx < Math.min(w, it.fw); xx++) {
          const idx = data[yy * w + xx];
          if (idx === 0) continue; // transparent
          const o = ((oy + yy) * ATLAS_WIDTH + ox + xx) * 4;
          pixels[o] = palette[idx * 3];
          pixels[o + 1] = palette[idx * 3 + 1];
          pixels[o + 2] = palette[idx * 3 + 2];
          pixels[o + 3] = 255;
        }
      }
    }
    rects.set(it.s.key, {
      u0: (it.x + PAD) / ATLAS_WIDTH, v0: (it.y + PAD) / height,
      du: it.fw / ATLAS_WIDTH, dv: it.fh / height,
      stride: (it.fw + PAD) / ATLAS_WIDTH, frames: it.n,
      size: it.s.size,
    });
  }
  return { atlas: { width: ATLAS_WIDTH, height, pixels }, rects };
}

/** Floats per billboard vertex: centre xyz, corner xy (m), uv, frames, stride, phase. */
export const BILLBOARD_STRIDE = 10;

/** Six vertices per flat; the shell's vertex shader turns each quad to face the camera. */
export function buildBillboards(placed, rects, src) {
  const out = new Float32Array(placed.length * 6 * BILLBOARD_STRIDE);
  let o = 0;
  const seed = (src.mapId | 0) ^ 0x5ce9;
  placed.forEach((f, i) => {
    const r = rects.get(f.sprite.key);
    const hw = r.size.width / 2, h = r.size.height;
    const phase = r.frames > 1 ? hash2(i, r.frames, seed) % r.frames : 0; // DFU: random start frame
    const corners = [[-hw, 0, 0, 1], [hw, 0, 1, 1], [hw, h, 1, 0], [-hw, 0, 0, 1], [hw, h, 1, 0], [-hw, h, 0, 0]];
    for (const [cx, cy, s, t] of corners) {
      out[o++] = f.x; out[o++] = f.y; out[o++] = f.z;
      out[o++] = cx; out[o++] = cy;
      out[o++] = r.u0 + s * r.du; out[o++] = r.v0 + t * r.dv;
      out[o++] = r.frames; out[o++] = r.stride; out[o++] = phase;
    }
  });
  return { vertices: out, count: placed.length * 6, flats: placed.length };
}

/** Ground tile records 0-3 (water, dirt, grass, stone) of the climate ground archive. */
async function groundTiles(index, archive, palette) {
  const f = index.get(TEX(archive));
  if (!f) return null;
  const fa = new FlatArchive(new Uint8Array(await f.arrayBuffer()), archive);
  const imgs = [0, 1, 2, 3].map((r) => fa.decode(r, 0));
  const pad = 2;
  const cellW = Math.max(...imgs.map((i) => i.width)) + pad * 2;
  const cellH = Math.max(...imgs.map((i) => i.height)) + pad * 2;
  const width = cellW * 4, height = cellH;
  const pixels = new Uint8Array(width * height * 4);
  const rects = [];
  imgs.forEach((img, k) => {
    const { width: w, height: h, data } = img;
    for (let yy = -pad; yy < h + pad; yy++) {
      for (let xx = -pad; xx < w + pad; xx++) {
        const idx = data[((yy + h) % h) * w + ((xx + w) % w)];
        const o = ((yy + pad) * width + k * cellW + xx + pad) * 4;
        pixels[o] = palette[idx * 3]; pixels[o + 1] = palette[idx * 3 + 1]; pixels[o + 2] = palette[idx * 3 + 2]; pixels[o + 3] = 255;
      }
    }
    rects.push({ u0: (k * cellW + pad) / width, v0: pad / height, du: w / width, dv: h / height });
  });
  return { atlas: { width, height, pixels }, rects };
}
