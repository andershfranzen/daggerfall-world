// Server-side loading of the travel catalogue from the operator's ARENA2 directory.
// Files are opened lazily as Blobs (fs.openAsBlob) and read through the same
// format code the browser uses (client/gameplay/travel/catalog.js).

import { openAsBlob } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readWorld } from '../../../client/gameplay/travel/catalog.js';

const NEEDED = ['MAPS.BSA', 'CLIMATE.PAK', 'POLITIC.PAK'];

/** Case-insensitive lookup of the travel files in `dir`. Returns Map(UPPER name -> File). */
export async function indexDataDir(dir) {
  const names = await readdir(dir);
  const index = new Map();
  for (const name of names) {
    const upper = name.toUpperCase();
    if (!NEEDED.includes(upper) || index.has(upper)) continue;
    index.set(upper, new File([await openAsBlob(join(dir, name))], upper));
  }
  return index;
}

/** Read the world catalogue, climate and politic maps from an ARENA2 directory. */
export async function loadWorldFromDir(dir, worldData) {
  return readWorld(await indexDataDir(dir), worldData);
}
