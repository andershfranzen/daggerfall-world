// Opens the operator's installed data for the audit, read-only. Nothing is copied or written next to it.
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { operatorFiles } from '../../server/rpg/interiors/data.js';
import { indexDataDir } from '../../server/rpg/travel/data.js';
import { serverWorldData } from '../../server/rpg/wilderness/replacements.js';
import { openWorldData } from '../../client/world/interiors/index.js';
import { readWorld } from '../../client/gameplay/travel/catalog.js';
import { emptyWorldData } from '../../client/world/wilderness/replacements.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const quiet = { info() {}, warn() {}, error() {} };

/** ARENA2 directory from an option, $ARENA2_DIR or the ignored gamedata clone; null when absent. */
export function arena2Dir(dir = process.env.ARENA2_DIR) {
  for (const d of [dir, join(ROOT, 'gamedata/DaggerfallGameFiles/arena2'), join(ROOT, 'gamedata/DaggerfallGameFiles')]) {
    if (d && existsSync(join(d, 'MAPS.BSA')) && existsSync(join(d, 'BLOCKS.BSA'))) return resolve(d);
  }
  return null;
}

/** World of Daggerfall root from an option, $WOD_PATH or the ignored clone; null when absent. */
export function wodRoot(dir = process.env.WOD_PATH) {
  for (const d of [dir, join(ROOT, 'gamedata/world-of-daggerfall')]) {
    if (d && existsSync(join(d, 'WorldOfDaggerfall.dfmod.json'))) return resolve(d);
  }
  return null;
}

/**
 * Classic archives plus a WorldData provider (empty in classic mode), and the travel catalogue read the same way.
 * @param {{arena2: string, wod?: string|null}} opts
 */
export async function openSources({ arena2, wod = null }) {
  const worldData = wod ? await serverWorldData(wod, { log: quiet }) : emptyWorldData('classic audit');
  const files = await operatorFiles(arena2);
  const data = await openWorldData(files, { worldData });
  const { catalog } = await readWorld(await indexDataDir(arena2), worldData);
  return { data, files, catalog, worldData, mode: wod ? 'pack' : 'classic', arena2, wod };
}

/**
 * Fault injection for fixtures: a view of `data` whose BLOCKS.BSA no longer contains `names`.
 * The installed archive is untouched; only this view's lookups and reads change.
 */
export function withoutBlocks(data, names) {
  const hidden = new Set([...names].map(n => n.toUpperCase()));
  const blocks = Object.create(data.blocks);
  // Also blank the directory names so the classic prefix/suffix fallback cannot rediscover the block.
  blocks.entries = data.blocks.entries.map(e => (hidden.has(e.name.toUpperCase()) ? { ...e, name: '~REMOVED~' } : e));
  blocks.indexOfName = name => (hidden.has(String(name).toUpperCase()) ? -1 : data.blocks.indexOfName(name));
  blocks.read = i => {
    if (hidden.has(String(data.blocks.entries[i]?.name).toUpperCase())) throw Error('Fixture removed ' + data.blocks.entries[i].name);
    return data.blocks.read(i);
  };
  return { ...data, blocks, rmb: new Map(), rdb: new Map(), locations: new Map() };
}
