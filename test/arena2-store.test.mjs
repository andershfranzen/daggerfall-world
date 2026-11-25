// Persistent local ARENA2 folder (client/lib/arena2-store.js) against in-memory fakes of
// IndexedDB, FileSystemDirectoryHandle and OPFS. Fixture bytes only, never real game content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArena2Store, folderPermission, readDirectoryHandle, isQuotaError } from '../client/lib/arena2-store.js';
import { selectArena2 } from '../client/lib/files.js';
import { indexFiles } from '../client/world/files.js';

// ---------------------------------------------------------------- fakes

function fakeIndexedDB() {
  const dbs = new Map();
  const later = (fn) => setTimeout(fn, 0);
  const request = (run) => {
    const req = {};
    later(() => {
      try { req.result = run(); req.onsuccess?.(); } catch (e) { req.error = e; req.onerror?.(); }
    });
    return req;
  };
  return {
    dbs,
    failPut: null, // (value) => Error | null
    open(name) {
      const factory = this;
      const req = {};
      later(() => {
        let stores = dbs.get(name);
        const db = {
          objectStoreNames: { contains: (s) => stores.has(s) },
          createObjectStore: (s) => stores.set(s, new Map()),
          transaction(storeName, mode) {
            const map = stores.get(storeName);
            const t = {};
            let pending = 0;
            let failed = null;
            const settle = () => later(() => {
              if (pending) return;
              if (failed) { t.error = failed; t.onabort?.(); } else t.oncomplete?.();
            });
            t.objectStore = () => {
              const op = (run) => {
                pending++;
                const r = {};
                later(() => {
                  try { r.result = run(); r.onsuccess?.(); } catch (e) { r.error = e; failed = e; r.onerror?.(); }
                  pending--;
                  settle();
                });
                return r;
              };
              const ro = (name) => { if (mode !== 'readwrite') throw new Error(`${name} in readonly tx`); };
              return {
                get: (k) => op(() => map.get(k)),
                put: (v, k) => op(() => { ro('put'); const e = factory.failPut?.(v); if (e) throw e; map.set(k, v); }),
                delete: (k) => op(() => { ro('delete'); map.delete(k); }),
                clear: () => op(() => { ro('clear'); map.clear(); }),
              };
            };
            return t;
          },
        };
        req.result = db;
        if (!stores) {
          dbs.set(name, (stores = new Map()));
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      });
      return req;
    },
    request,
  };
}

const quotaError = () => Object.assign(new Error('quota'), { name: 'QuotaExceededError' });

function fakeOpfs({ quotaAfter = Infinity, writable = true } = {}) {
  let written = 0;
  const notFound = () => Object.assign(new Error('nf'), { name: 'NotFoundError' });
  const makeDir = (name) => {
    const entries = new Map();
    const dir = {
      kind: 'directory', name, entries,
      async getDirectoryHandle(n, { create } = {}) {
        if (!entries.has(n)) { if (!create) throw notFound(); entries.set(n, makeDir(n)); }
        return entries.get(n);
      },
      async getFileHandle(n, { create } = {}) {
        if (!entries.has(n)) {
          if (!create) throw notFound();
          const fh = { kind: 'file', name: n, data: null, async getFile() { return new File([fh.data ?? ''], n, { lastModified: 999 }); } };
          if (writable) {
            fh.createWritable = async () => {
              let buf = null;
              return {
                async write(b) { if (++written > quotaAfter) throw quotaError(); buf = b; },
                async close() { fh.data = buf; },
                async abort() {},
              };
            };
          }
          entries.set(n, fh);
        }
        return entries.get(n);
      },
      async removeEntry(n) { if (!entries.delete(n)) throw notFound(); },
    };
    return dir;
  };
  const root = makeDir('');
  return { root, storage: { getDirectory: async () => root, estimate: async () => ({ quota: 1e9, usage: 0 }), persist: async () => true } };
}

/** FileSystemDirectoryHandle fake from a nested { name: string | object } tree. */
function dirHandle(name, tree, perms = {}) {
  const children = () => Object.entries(tree).map(([n, v]) =>
    typeof v === 'string'
      ? { kind: 'file', name: n, getFile: async () => new File([v], n, { lastModified: 1 }) }
      : dirHandle(n, v));
  return {
    kind: 'directory', name,
    async *values() { yield* children(); },
    ...perms,
  };
}

const ARENA = { 'ARCH3D.BSA': 'aaaa', 'BLOCKS.BSA': 'bb', 'MAPS.BSA': 'mmm', 'ART_PAL.COL': 'pp' };
const files = () => Object.entries(ARENA).map(([n, v]) => new File([v], n, { lastModified: 42 }));

// ---------------------------------------------------------------- permissions

test('folderPermission reports granted, prompt and denied, and requests on demand', async () => {
  const h = (q, r) => ({ queryPermission: async () => q, requestPermission: async () => r });
  assert.equal(await folderPermission(h('granted')), 'granted');
  assert.equal(await folderPermission(h('prompt', 'granted')), 'prompt');
  assert.equal(await folderPermission(h('prompt', 'granted'), { request: true }), 'granted');
  assert.equal(await folderPermission(h('denied', 'denied'), { request: true }), 'denied');
  const throwing = { queryPermission: async () => { throw new Error('x'); }, requestPermission: async () => { throw new Error('no gesture'); } };
  assert.equal(await folderPermission(throwing), 'prompt');
  assert.equal(await folderPermission(throwing, { request: true }), 'denied');
  assert.equal(await folderPermission(null), 'denied');
});

// ---------------------------------------------------------------- directory reading

test('readDirectoryHandle on ARENA2 itself matches the folder-pick semantics', async () => {
  const entries = await readDirectoryHandle(dirHandle('ARENA2', ARENA));
  assert.deepEqual(entries.map((e) => e.path).sort(), Object.keys(ARENA).map((n) => `ARENA2/${n}`).sort());
  const sel = selectArena2(entries);
  assert.equal(sel.problem, null);
  assert.equal(sel.dir, 'ARENA2');
  assert.deepEqual(sel.missing, []);
  assert.ok(indexFiles(sel.files).get('ARCH3D.BSA'));
});

test('readDirectoryHandle on the install folder walks only its ARENA2 subtree', async () => {
  const install = dirHandle('DAGGER', {
    'DAGGER.EXE': 'x',
    SAVE0: { 'SAVETREE.DAT': 's' },
    Huge: { a: { b: { c: 'deep' } } },
    arena2: ARENA,
  });
  const entries = await readDirectoryHandle(install);
  assert.ok(entries.every((e) => e.path.startsWith('DAGGER/arena2/')), 'unrelated trees are not walked');
  const sel = selectArena2(entries);
  assert.equal(sel.dir, 'DAGGER/arena2');
  assert.deepEqual(sel.missing, []);
});

test('readDirectoryHandle finds ARENA2 below a parent of the install and respects limits', async () => {
  const games = dirHandle('Games', { Other: { 'x.bin': 'x' }, DAGGER: { ARENA2: ARENA } });
  const sel = selectArena2(await readDirectoryHandle(games));
  assert.equal(sel.dir, 'Games/DAGGER/ARENA2');
  const capped = await readDirectoryHandle(dirHandle('ARENA2', ARENA), { maxFiles: 2 });
  assert.equal(capped.length, 2);
  const shallow = await readDirectoryHandle(dirHandle('top', { a: { b: { 'f.txt': 'f' } } }), { maxDepth: 1 });
  assert.deepEqual(shallow, []);
});

// ---------------------------------------------------------------- saved handle

test('saveHandle / loadSavedFolder / forget round-trip through IndexedDB', async () => {
  const store = createArena2Store({ indexedDB: fakeIndexedDB(), storage: null });
  assert.equal(await store.loadSavedFolder(), null);
  const handle = dirHandle('ARENA2', ARENA);
  await store.saveHandle(handle);
  const saved = await store.loadSavedFolder();
  assert.equal(saved.handle, handle);
  assert.equal(saved.name, 'ARENA2');
  assert.ok(saved.savedAt > 0);
  await store.forget();
  assert.equal(await store.loadSavedFolder(), null);
});

test('loadSavedFolder is null when IndexedDB is unavailable', async () => {
  const store = createArena2Store({ indexedDB: undefined, storage: undefined });
  assert.equal(await store.loadSavedFolder(), null);
  assert.equal(await store.cacheInfo(), null);
  await store.forget(); // never throws
});

// ---------------------------------------------------------------- OPFS cache

test('OPFS cache writes, reads back the original names and dates, and clears', async () => {
  const opfs = fakeOpfs();
  const store = createArena2Store({ indexedDB: fakeIndexedDB(), storage: opfs.storage });
  const progress = [];
  const res = await store.cacheFiles(files(), { dir: 'DAGGER/ARENA2', onProgress: (p) => progress.push(p.stored) });
  assert.deepEqual(res, { ok: true, backend: 'opfs', stored: 4 });
  assert.deepEqual(progress, [1, 2, 3, 4]);
  const info = await store.cacheInfo();
  assert.equal(info.backend, 'opfs');
  assert.equal(info.files.length, 4);

  const entries = await store.loadCache();
  const sel = selectArena2(entries);
  assert.equal(sel.problem, null);
  assert.equal(sel.dir, 'DAGGER/ARENA2');
  const arch = sel.files.find((f) => f.name === 'ARCH3D.BSA');
  assert.equal(await arch.text(), 'aaaa');
  assert.equal(arch.lastModified, 42);

  await store.clearCache();
  assert.equal(await store.cacheInfo(), null);
  assert.equal(await store.loadCache(), null);
  assert.equal(opfs.root.entries.size, 0);
});

test('a damaged OPFS copy is ignored instead of loading a broken world', async () => {
  const opfs = fakeOpfs();
  const store = createArena2Store({ indexedDB: fakeIndexedDB(), storage: opfs.storage });
  await store.cacheFiles(files(), { dir: 'ARENA2' });
  opfs.root.entries.get('dfw-arena2-cache').entries.delete('MAPS.BSA');
  assert.equal(await store.loadCache(), null);
});

test('quota exhaustion mid-copy clears the partial OPFS copy and reports quota', async () => {
  const opfs = fakeOpfs({ quotaAfter: 2 });
  const store = createArena2Store({ indexedDB: fakeIndexedDB(), storage: opfs.storage });
  const res = await store.cacheFiles(files(), { dir: 'ARENA2' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'quota');
  assert.equal(await store.cacheInfo(), null);
  assert.equal(opfs.root.entries.size, 0);
});

test('a too-small storage estimate skips caching before writing anything', async () => {
  const opfs = fakeOpfs();
  opfs.storage.estimate = async () => ({ quota: 10, usage: 8 });
  const store = createArena2Store({ indexedDB: fakeIndexedDB(), storage: opfs.storage });
  assert.deepEqual(await store.cacheFiles(files()), { ok: false, reason: 'quota' });
  assert.equal(opfs.root.entries.size, 0);
});

test('an aborted copy is discarded', async () => {
  const ctl = new AbortController();
  const store = createArena2Store({ indexedDB: fakeIndexedDB(), storage: fakeOpfs().storage });
  const res = await store.cacheFiles(files(), { onProgress: ({ stored }) => stored === 2 && ctl.abort(), signal: ctl.signal });
  assert.deepEqual(res, { ok: false, reason: 'aborted' });
  assert.equal(await store.cacheInfo(), null);
});

// ---------------------------------------------------------------- IndexedDB fallback

test('IndexedDB blob fallback when OPFS is missing (older Safari / Firefox)', async () => {
  const idb = fakeIndexedDB();
  const store = createArena2Store({ indexedDB: idb, storage: { estimate: async () => ({ quota: 1e9, usage: 0 }) } });
  const res = await store.cacheFiles(files(), { dir: 'ARENA2' });
  assert.deepEqual(res, { ok: true, backend: 'idb', stored: 4 });
  const sel = selectArena2(await store.loadCache());
  assert.deepEqual(sel.missing, []);
  assert.equal(await sel.files.find((f) => f.name === 'MAPS.BSA').text(), 'mmm');
  await store.forget();
  assert.equal(await store.loadCache(), null);
  assert.equal(idb.dbs.get('dfw-arena2').get('files').size, 0);
});

test('IndexedDB fallback when OPFS cannot create writable files', async () => {
  const store = createArena2Store({ indexedDB: fakeIndexedDB(), storage: fakeOpfs({ writable: false }).storage });
  const res = await store.cacheFiles(files(), { dir: 'ARENA2' });
  assert.equal(res.backend, 'idb');
  assert.equal((await store.loadCache()).length, 4);
});

test('IndexedDB quota failure is reported without throwing and leaves no partial copy', async () => {
  const idb = fakeIndexedDB();
  let n = 0;
  idb.failPut = (v) => (v instanceof File && ++n > 1 ? quotaError() : null);
  const store = createArena2Store({ indexedDB: idb, storage: null });
  const res = await store.cacheFiles(files(), { dir: 'ARENA2' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'quota');
  assert.equal(await store.cacheInfo(), null);
  assert.equal(idb.dbs.get('dfw-arena2').get('files').size, 0);
  assert.ok(isQuotaError(res.error));
});
