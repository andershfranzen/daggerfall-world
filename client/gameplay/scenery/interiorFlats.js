// Building interior flats (lamps, candles, decorations) as a SceneryPass input: the interior scene's `flats`
// (client/world/interiors/flats.js) with sprites decoded from the player's own TEXTURE.nnn files, packed into one
// atlas with the same packer and billboard layout as the town scenery (client/world/scenery/index.js).

import { readBlob } from '../../world/bsa.js';
import { indexFiles, requireFiles } from '../../world/files.js';
import { parsePalette } from '../../world/textures.js';
import { WorldDataError } from '../../world/errors.js';
import { FlatArchive } from '../../world/scenery/flatTextures.js';
import { packSprites, buildBillboards } from '../../world/scenery/index.js';

const MAX_FRAMES = 16;
const TEX = (a) => `TEXTURE.${String(a).padStart(3, '0')}`;

/** True for a scene this loader draws: a building interior that lists its flats. */
export const hasInteriorFlats = (mesh) => mesh?.kind === 'interior' && Array.isArray(mesh.flats);

/**
 * @param {Iterable<File>} files - the player's ARENA2 files
 * @param {{location:string, name:string, flats:Array<{archive,record,kind,x,y,z}>}} mesh - loadInterior() scene
 * @returns {Promise<{billboards, atlas, terrain:null, sky:null, warnings:string[], stats:object}>}
 */
export async function loadInteriorFlats(files, mesh) {
  if (!hasInteriorFlats(mesh)) throw new WorldDataError('loadInteriorFlats needs an interior scene with flats');
  const index = indexFiles(files);
  const placed = [];
  if (!mesh.flats.length) {
    return {
      billboards: { vertices: new Float32Array(0), count: 0, flats: 0 },
      atlas: { width: 1, height: 1, pixels: new Uint8Array(4) },
      terrain: null,
      sky: null,
      warnings: [],
      stats: stats(placed, 0),
    };
  }
  // Every flat is authored classic art of the installed room, as a town's flats are: a missing or unreadable
  // archive or record fails the build (the arrival gate offers Try again) instead of drawing a room without it.
  const [palF] = requireFiles(index, ['ART_PAL.COL']);
  const palette = parsePalette(await readBlob(palF, 0, palF.size), 'ART_PAL.COL');
  const archives = new Map();
  const archiveFor = async (archive) => {
    let fa = archives.get(archive);
    if (!fa) {
      const [f] = requireFiles(index, [TEX(archive)]);
      fa = new FlatArchive(new Uint8Array(await f.arrayBuffer()), archive);
      archives.set(archive, fa);
    }
    return fa;
  };
  const sprites = new Map(); // "archive:record" -> sprite
  for (const f of mesh.flats) {
    const key = `${f.archive}:${f.record}`;
    let sprite = sprites.get(key);
    if (!sprite) {
      const fa = await archiveFor(f.archive);
      const frames = Math.min(fa.frameCount(f.record), MAX_FRAMES);
      const imgs = [];
      for (let k = 0; k < frames; k++) imgs.push(fa.decode(f.record, k));
      sprite = { key, archive: f.archive, record: f.record, size: fa.size(f.record), frames: imgs };
      sprites.set(key, sprite);
    }
    placed.push({ ...f, sprite });
  }
  const { atlas, rects } = packSprites([...sprites.values()], palette);
  const seed = [...String(mesh.location ?? '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
  const billboards = buildBillboards(placed, rects, { mapId: seed });
  return { billboards, atlas, terrain: null, sky: null, warnings: [], stats: stats(placed, rects.size) };
}

function stats(placed, sprites) {
  const kinds = {};
  for (const f of placed) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
  return { drawnFlats: placed.length, sprites, kinds };
}
