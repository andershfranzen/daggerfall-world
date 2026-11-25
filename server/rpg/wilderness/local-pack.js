import { createWodModelStore, resolveCustomMaterials } from './models.js';
import { climateSettings } from '../../../client/world/maps.js';
import { applyClimate } from '../../../client/world/town.js';

/** The release manifest determines which prefabs and materials the local renderer may read. */
export function createLocalWodPack(root) {
  if (!root) return null;
  const store = createWodModelStore({ root });
  const textures = new Set();

  async function model(name, { climate, winter = false, region = '' } = {}) {
    if (typeof name !== 'string' || !/^[a-z0-9_ -]{1,100}$/i.test(name)) return null;
    const index = await store.index();
    const canonical = Object.keys(index.prefabs).find(key => key.toLowerCase() === name.toLowerCase());
    if (!canonical) return null;
    const prefab = await store.custom(canonical);
    if (!prefab) return null;
    const materials = await resolveCustomMaterials(prefab, index, await store.reader(), {
      climate, winter, region, climateBase: climateSettings(climate).climateBase, applyClimate,
    });
    for (const item of materials) if (item?.kind === 'pack') textures.add(item.path);
    return {
      name, root: prefab.root, meshCollider: prefab.meshCollider,
      submeshes: prefab.submeshes, materials: prefab.materials, textures: materials,
    };
  }

  return {
    model,
    async texture(path) {
      if (!textures.has(path) || !path.endsWith('.png')) return null;
      return (await store.reader())(path);
    },
  };
}
