// Picks the ARENA2 directory out of whatever folder the player selected (ARENA2 itself,
// the Daggerfall install folder, or something above it). DOM-light: works on File objects
// or { file, path } pairs (from drag and drop).

const KEY_FILES = ['ARCH3D.BSA', 'BLOCKS.BSA', 'MAPS.BSA'];

function entryOf(item) {
  if (item && item.file) return { file: item.file, path: item.path || item.file.name };
  return { file: item, path: item.webkitRelativePath || item.name };
}

function parentOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/**
 * @returns {{ files: File[], dir: string, total: number, missing: string[], problem: string|null }}
 */
export function selectArena2(items) {
  const entries = Array.from(items ?? [], entryOf).filter((e) => e.file);
  const total = entries.length;
  if (!total) {
    return { files: [], dir: '', total, missing: KEY_FILES, problem: 'That folder is empty.' };
  }
  // Group by directory, score each by Daggerfall archives it holds.
  const dirs = new Map();
  for (const e of entries) {
    const d = parentOf(e.path);
    let g = dirs.get(d);
    if (!g) dirs.set(d, (g = { dir: d, files: [], names: new Set(), bsa: 0 }));
    const upper = e.file.name.toUpperCase();
    g.files.push(e.file);
    g.names.add(upper);
    if (upper.endsWith('.BSA')) g.bsa++;
  }
  let best = null;
  for (const g of dirs.values()) {
    const keys = KEY_FILES.filter((k) => g.names.has(k)).length;
    const score = keys * 1000 + g.bsa * 10 + (/(^|\/)arena2$/i.test(g.dir) ? 5 : 0);
    const bestScore = best ? best.score : -1;
    if (score > bestScore || (score === bestScore && g.dir.length < best.dir.length)) best = { ...g, score };
  }
  if (!best || best.bsa === 0) {
    return {
      files: [],
      dir: '',
      total,
      missing: KEY_FILES,
      problem:
        'No Daggerfall archives (.BSA files) were found there. Choose the ARENA2 folder inside your Daggerfall install, or the install folder itself.',
    };
  }
  const missing = KEY_FILES.filter((k) => !best.names.has(k));
  return { files: best.files, dir: best.dir, total, missing, problem: null };
}

/** Recursively read a dropped directory (DataTransferItem.webkitGetAsEntry) into {file, path}. */
export async function readDroppedEntries(dataTransfer) {
  const roots = [];
  for (const item of dataTransfer.items ?? []) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  const out = [];
  const readAll = (reader) =>
    new Promise((resolve, reject) => {
      const acc = [];
      const next = () =>
        reader.readEntries((batch) => {
          if (!batch.length) resolve(acc);
          else { acc.push(...batch); next(); }
        }, reject);
      next();
    });
  async function walk(entry, prefix, depth) {
    if (depth > 6 || out.length > 20000) return;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path });
    } else if (entry.isDirectory) {
      for (const child of await readAll(entry.createReader())) await walk(child, path, depth + 1);
    }
  }
  for (const r of roots) await walk(r, '', 0);
  return out;
}
