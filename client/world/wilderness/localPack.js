import { isLoopbackPage } from '../../lib/local-assets.js';
import { climateSettings } from '../maps.js';
import { applyClimate } from '../town.js';
import { buildWodPackIndex, deserializeCustomPrefab, loadCustomPrefab, resolveCustomMaterials } from './models.js';

async function decodeTexture(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    return { width, height, rgba: ctx.getImageData(0, 0, width, height).data };
  } finally {
    bitmap.close();
  }
}

/** Player-selected author source folder. File handles and all decoded assets stay in this page. */
export async function folderWodPack(selection) {
  const files = Array.from(selection);
  const manifest = files.find(f => f.name === 'WorldOfDaggerfall.dfmod.json');
  if (!manifest) throw new Error('Choose the World of Daggerfall source folder containing WorldOfDaggerfall.dfmod.json.');
  const root = manifest.webkitRelativePath.slice(0, -manifest.name.length);
  const entries = new Map();
  for (const file of files) {
    if (file.webkitRelativePath.startsWith(root)) entries.set(file.webkitRelativePath.slice(root.length), file);
  }
  const read = async path => {
    const file = entries.get(path);
    return file ? new Uint8Array(await file.arrayBuffer()) : null;
  };
  const index = await buildWodPackIndex([...entries.keys()], read);
  if (!Object.keys(index.prefabs).length) throw new Error('This folder is missing the World of Daggerfall prefabs.');
  const cache = new Map();
  return {
    async loadAsset(requested, context = {}) {
      const name = Object.keys(index.prefabs).find(key => key.toLowerCase() === String(requested).toLowerCase());
      if (!name) return null;
      if (!cache.has(name)) cache.set(name, loadCustomPrefab(index, read, name).catch(err => { cache.delete(name); throw err; }));
      const prefab = await cache.get(name);
      if (!prefab) return null;
      const textures = await resolveCustomMaterials(prefab, index, read, {
        ...context, climateBase: climateSettings(context.climate).climateBase, applyClimate,
      });
      return { ...prefab, textures };
    },
    async loadTexture(path) {
      const file = entries.get(path);
      return file ? decodeTexture(file) : null;
    },
  };
}

// Read only the converted model and textures needed by the current scene. Other origins
// still draw the classic surfaces named in the server's placement descriptor.
export function localWodPack({ fetchFn = globalThis.fetch, location = globalThis.location } = {}) {
  let token = null;
  const options = { credentials: 'same-origin', mode: 'same-origin', redirect: 'error' };
  const header = 'X-DFW-Local-Assets';

  async function manifest() {
    const response = await fetchFn('/local-assets/manifest', { ...options, headers: { [header]: 'manifest' } });
    return response.ok ? (await response.json()).token : null;
  }

  async function request(route, params) {
    if (!isLoopbackPage(location)) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      token ??= manifest().catch(() => null);
      const key = await token;
      if (!key) { token = null; return null; }
      const url = '/local-assets/wod/' + route + '?' + new URLSearchParams(params);
      const response = await fetchFn(url, { ...options, headers: { [header]: key } });
      if (response.status === 403) { token = null; continue; }
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`World of Daggerfall ${route} request failed (HTTP ${response.status})`);
      return response;
    }
    return null;
  }

  return {
    async loadAsset(name, { climate = 0, region = '', winter = false } = {}) {
      const response = await request('model', { name, climate, region, winter: winter ? '1' : '0' });
      return response ? deserializeCustomPrefab(await response.json()) : null;
    },
    async loadTexture(path) {
      const response = await request('texture', { path });
      if (!response) return null;
      return decodeTexture(await response.blob());
    },
  };
}
