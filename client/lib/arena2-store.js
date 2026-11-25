// Remembers the player's ARENA2 folder between visits. Everything stays in this browser:
// nothing here talks to the network.
//
// - Chromium: the FileSystemDirectoryHandle from showDirectoryPicker() is kept in IndexedDB, so a
//   return visit needs at most one permission click instead of the OS folder picker.
// - Everywhere (opt-in on Chromium): a local copy of the selected ARENA2 files in the origin
//   private file system (OPFS), or IndexedDB blobs where OPFS writes are unavailable.
//
// Directory entries come back as { file, path } pairs, the same shape readDroppedEntries returns,
// so selectArena2 (lib/files.js) and indexFiles (world/files.js) treat them like a dropped folder.

const DB_NAME = 'dfw-arena2';
const OPFS_DIR = 'dfw-arena2-cache';
const MAX_DEPTH = 4;
const MAX_FILES = 20000;

const isArena2 = (name) => /^arena2$/i.test(name);

function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Ask for (request: true) or check read permission on a saved handle: 'granted' | 'prompt' | 'denied'. */
export async function folderPermission(handle, { request = false } = {}) {
  const fn = request ? handle?.requestPermission : handle?.queryPermission;
  if (typeof fn !== 'function') return handle ? 'granted' : 'denied';
  try {
    return await fn.call(handle, { mode: 'read' });
  } catch {
    return request ? 'denied' : 'prompt'; // requestPermission throws without a user gesture
  }
}

/**
 * Walk a FileSystemDirectoryHandle into { file, path } pairs (path starts with the handle's name,
 * like webkitRelativePath). When a level holds an ARENA2 folder only that folder is walked, so
 * choosing the Daggerfall install (or the folder above it) does not read unrelated trees.
 */
export async function readDirectoryHandle(handle, { maxDepth = MAX_DEPTH, maxFiles = MAX_FILES } = {}) {
  const out = [];
  async function walk(dir, prefix, depth) {
    const files = [];
    const dirs = [];
    for await (const entry of dir.values()) {
      if (entry.kind === 'file') files.push(entry);
      else if (entry.kind === 'directory') dirs.push(entry);
    }
    const arena = dirs.find((d) => isArena2(d.name));
    if (!isArena2(dir.name) && arena) return walk(arena, `${prefix}/${arena.name}`, depth + 1);
    for (const f of files) {
      if (out.length >= maxFiles) return;
      out.push({ file: await f.getFile(), path: `${prefix}/${f.name}` });
    }
    if (depth >= maxDepth) return;
    for (const d of dirs) await walk(d, `${prefix}/${d.name}`, depth + 1);
  }
  await walk(handle, handle.name, 0);
  return out;
}

export const isQuotaError = (err) => err?.name === 'QuotaExceededError' || err?.code === 22;

/**
 * @param {{ indexedDB?: IDBFactory, storage?: StorageManager }} [env] injectable for tests
 */
export function createArena2Store({ indexedDB = globalThis.indexedDB, storage = globalThis.navigator?.storage } = {}) {
  let dbp = null;
  const db = () =>
    (dbp ??= new Promise((resolve, reject) => {
      if (!indexedDB) return reject(new Error('IndexedDB is not available in this browser.'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        for (const s of ['meta', 'files']) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbp = null; reject(req.error); };
    }));

  async function tx(store, mode, fn) {
    const t = (await db()).transaction(store, mode);
    const req = fn(t.objectStore(store));
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(req?.result);
      t.onerror = t.onabort = () => reject(t.error || req?.error);
    });
  }
  const get = (key) => tx('meta', 'readonly', (s) => s.get(key));
  const put = (key, value) => tx('meta', 'readwrite', (s) => s.put(value, key));
  const del = (key) => tx('meta', 'readwrite', (s) => s.delete(key));
  const quiet = (p) => p.then((v) => v, () => undefined);

  const opfsRoot = () => (typeof storage?.getDirectory === 'function' ? storage.getDirectory() : null);

  async function clearCache() {
    await quiet(del('cache'));
    await quiet(tx('files', 'readwrite', (s) => s.clear()));
    const root = await quiet(Promise.resolve(opfsRoot()));
    if (root) await quiet(root.removeEntry(OPFS_DIR, { recursive: true }));
  }

  async function writeOpfs(files, onFile, signal) {
    const dir = await (await opfsRoot()).getDirectoryHandle(OPFS_DIR, { create: true });
    for (const f of files) {
      if (signal?.aborted) return false;
      const fh = await dir.getFileHandle(f.name, { create: true });
      if (typeof fh.createWritable !== 'function') throw Object.assign(new Error('OPFS writes unsupported'), { unsupported: true });
      const w = await fh.createWritable();
      try {
        await w.write(f);
        await w.close();
      } catch (err) {
        await quiet(Promise.resolve(w.abort?.()));
        throw err;
      }
      onFile();
    }
    return true;
  }

  async function writeIdb(files, onFile, signal) {
    for (const f of files) {
      if (signal?.aborted) return false;
      await tx('files', 'readwrite', (s) => s.put(f, f.name)); // File is structured-cloneable
      onFile();
    }
    return true;
  }

  return {
    /** Remember a folder the player picked (Chromium FileSystemDirectoryHandle). */
    saveHandle: (handle) => put('folder', { handle, name: handle.name, savedAt: Date.now() }),

    /** @returns {Promise<null | { handle, name, savedAt }>} */
    async loadSavedFolder() {
      try {
        const v = await get('folder');
        return v?.handle ? v : null;
      } catch {
        return null;
      }
    },

    /** Manifest of the local copy, or null when there is no complete copy. */
    async cacheInfo() {
      try {
        const v = await get('cache');
        return v?.complete ? v : null;
      } catch {
        return null;
      }
    },

    /**
     * Copy the selected ARENA2 files into this browser. Never throws: a full disk or an aborted run
     * clears the partial copy and reports why.
     * @returns {Promise<{ ok: true, backend: string, stored: number } | { ok: false, reason: 'quota'|'aborted'|'unavailable'|'error', error?: Error }>}
     */
    async cacheFiles(files, { dir = '', onProgress, signal } = {}) {
      files = [...files];
      const bytes = files.reduce((n, f) => n + f.size, 0);
      try {
        await clearCache();
        const est = await quiet(Promise.resolve(storage?.estimate?.()));
        if (est?.quota && est.quota - (est.usage || 0) < bytes) return { ok: false, reason: 'quota' };
        await quiet(Promise.resolve(storage?.persist?.())); // ask the browser not to evict it
        let stored = 0;
        const onFile = () => { stored++; onProgress?.({ stored, total: files.length }); };
        let backend = 'opfs';
        let finished;
        try {
          if (!(await opfsRoot())) throw Object.assign(new Error('no OPFS'), { unsupported: true });
          finished = await writeOpfs(files, onFile, signal);
        } catch (err) {
          if (!err?.unsupported && err?.name !== 'NotAllowedError' && err?.name !== 'SecurityError') throw err;
          await clearCache();
          backend = 'idb';
          stored = 0;
          finished = await writeIdb(files, onFile, signal);
        }
        if (!finished) {
          await clearCache();
          return { ok: false, reason: 'aborted' };
        }
        const meta = files.map((f) => ({ name: f.name, size: f.size, lastModified: f.lastModified }));
        await put('cache', { complete: true, backend, dir, bytes, files: meta, savedAt: Date.now() });
        return { ok: true, backend, stored };
      } catch (error) {
        await clearCache();
        if (isQuotaError(error)) return { ok: false, reason: 'quota', error };
        return { ok: false, reason: indexedDB ? 'error' : 'unavailable', error };
      }
    },

    /** Read the local copy back as { file, path } pairs, or null when missing or damaged. */
    async loadCache() {
      const info = await this.cacheInfo();
      if (!info) return null;
      const base = info.dir || 'ARENA2';
      try {
        const out = [];
        if (info.backend === 'opfs') {
          const dir = await (await opfsRoot()).getDirectoryHandle(OPFS_DIR);
          for (const m of info.files) {
            const f = await (await dir.getFileHandle(m.name)).getFile();
            if (f.size !== m.size) return null;
            // Restore the original name/date so a later pick of the same folder is recognised.
            out.push({ file: new File([f], m.name, { lastModified: m.lastModified }), path: `${base}/${m.name}` });
          }
        } else {
          for (const m of info.files) {
            const b = await tx('files', 'readonly', (s) => s.get(m.name));
            if (!b || b.size !== m.size) return null;
            out.push({ file: new File([b], m.name, { lastModified: m.lastModified }), path: `${base}/${m.name}` });
          }
        }
        return out;
      } catch {
        return null;
      }
    },

    clearCache,

    /** Forget the saved folder handle and delete the local copy. */
    async forget() {
      await quiet(del('folder'));
      await clearCache();
    },
  };
}
