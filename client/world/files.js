// Case-insensitive index over the File objects of a selected ARENA2 folder or
// the Daggerfall install folder that contains it. Nothing is uploaded; files
// are read lazily with Blob.slice().

import { WorldDataError } from './errors.js';

const pathOf = (f) => String(f.webkitRelativePath || f.relativePath || f.name || '');

/**
 * Index files by upper-case basename. When the same basename occurs more than
 * once (e.g. a CD image copy beside ARENA2), the copy whose parent directory
 * is ARENA2 wins, then the shallowest path.
 * @param {Iterable<File>} files
 * @returns {Map<string, File>}
 */
export function indexFiles(files) {
  if (files == null || typeof files[Symbol.iterator] !== 'function') {
    throw new WorldDataError('loadTown expects an iterable of File objects (for example input.files from a directory picker)');
  }
  const best = new Map();
  const score = (f) => {
    const parts = pathOf(f).split(/[\\/]/).filter(Boolean);
    const parent = parts.length >= 2 ? parts[parts.length - 2].toUpperCase() : '';
    return (parent === 'ARENA2' ? 0 : 1000) + parts.length;
  };
  for (const f of files) {
    if (!f || typeof f.slice !== 'function' || typeof f.size !== 'number') {
      throw new WorldDataError('loadTown expects File/Blob objects with a name');
    }
    const parts = pathOf(f).split(/[\\/]/).filter(Boolean);
    const base = (parts[parts.length - 1] || '').toUpperCase();
    if (!base) continue;
    const prev = best.get(base);
    if (!prev || score(f) < score(prev)) best.set(base, f);
  }
  return best;
}

/** Fetch a required file from the index or throw a clear error naming every missing file. */
export function requireFiles(index, names) {
  const missing = names.filter((n) => !index.has(n));
  if (missing.length) {
    throw new WorldDataError(
      `Daggerfall data not found: ${missing.join(', ')}. Select the ARENA2 folder of a Daggerfall installation, or the folder that contains it.`,
    );
  }
  return names.map((n) => index.get(n));
}
