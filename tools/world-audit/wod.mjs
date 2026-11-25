// World of Daggerfall placement sweep: every published row through the production loader verdict
// (server/rpg/wilderness/store.js rowsAt -> rejectReason) and every dependency an accepted site needs.
// Only aggregate counts, row/site ids, prefab names and model numbers leave this module.
import { createWodStore } from '../../server/rpg/wilderness/store.js';
import { createWodModelStore } from '../../server/rpg/wilderness/models.js';
import { MAP_PIXELS_X, MAP_PIXELS_Y } from '../../client/world/wilderness/data.js';
import { resolveRmbBlock } from '../../client/world/wilderness/replacements.js';
import { add } from './census.mjs';
import { issue, memo } from './blocks.mjs';

const quiet = { info() {}, warn() {}, error() {} };
const SAMPLE = 5;

/**
 * @param {string} root World of Daggerfall root
 * @param {object} data openWorldData() result (ARCH3D, BLOCKS and the same WorldData provider)
 */
export async function wodSweep(root, data, { store = null, models = null } = {}) {
  store ??= createWodStore({ root, maxFolders: 4096, maxPrefabs: 1 << 16, log: quiet });
  models ??= createWodModelStore({ root, max: 1 << 16 });
  const status = await store.init();
  const out = { store, status, pixels: 0, rows: 0, accepted: 0, rejected: {}, kinds: {}, objects: {}, issues: [],
    dependencies: { classicModels: 0, customPrefabs: 0, blocks: 0, layouts: 0 }, unresolved: {}, sample: {} };
  if (status.pack !== 'ready') {
    out.issues.push(issue('optional-dependency', 'H', 'World of Daggerfall', 'Pack ' + status.pack + ': ' + status.note));
    return out;
  }
  const classic = memo(id => data.lib.arch.indexOfId(id) >= 0);
  const custom = memo(async name => { try { return !!(await models.custom(name)); } catch { return false; } });
  const block = memo(async name => (await resolveRmbBlock(data.blocks, name, data.worldData)).index >= 0);
  const seen = { classicModels: new Set(), customPrefabs: new Set(), blocks: new Set(), layouts: new Set() };
  const unresolved = (type, ref, site) => {
    const u = out.unresolved[type] ??= {};
    const e = u[ref] ??= { uses: 0, first: site };
    e.uses++;
  };

  for (let py = 0; py < MAP_PIXELS_Y; py++) {
    for (let px = 0; px < MAP_PIXELS_X; px++) {
      if (!store.hasRows(px, py)) continue;
      const rows = store.rowsAt(px, py);
      if (!rows.length) continue;
      out.pixels++;
      const accepted = new Set();
      for (const r of rows) {
        out.rows++;
        if (r.reject) {
          add(out.rejected, r.reject);
          (out.sample[r.reject] ??= []).length < SAMPLE && out.sample[r.reject].push(r.id + ' ' + r.inst.prefab);
        } else { out.accepted++; accepted.add(r.id); }
      }
      // Compose accepted sites exactly as the scene service does, then keep this pixel's own rows once.
      for (const site of store.sceneSites(px, py)) {
        if (site.pixel[0] !== px || site.pixel[1] !== py || !accepted.has(site.id)) continue;
        add(out.kinds, site.kind);
        for (const name of site.missing ?? []) {
          add(out.dependencies, 'layouts');
          if (!seen.layouts.has(name)) seen.layouts.add(name);
          unresolved('layout', name, site.id);
        }
        for (const o of site.objects) {
          add(out.objects, o.kind);
          if (o.kind === 'model') {
            seen.classicModels.add(o.model);
            if (!classic(o.model)) unresolved('classic-model', 'ARCH3D:' + o.model, site.id);
          } else if (o.kind === 'prefab') {
            seen.customPrefabs.add(o.name);
            if (!(await custom(o.name))) unresolved('custom-prefab', o.name, site.id);
          } else if (o.kind === 'block') {
            seen.blocks.add(o.block);
            if (!(await block(o.block))) unresolved('block', o.block, site.id);
          }
        }
        add(out.objects, 'markers', site.markers.length);
      }
    }
  }
  for (const k of Object.keys(seen)) out.dependencies[k] = seen[k].size;
  for (const [type, refs] of Object.entries(out.unresolved)) {
    for (const [ref, e] of Object.entries(refs)) {
      // Pack pieces are optional by contract: classic geometry never depends on them (brief H).
      out.issues.push({ place: e.first, ...issue('optional-dependency', 'H', ref, 'Unresolved ' + type + ' placed ' + e.uses + ' times in accepted sites') });
    }
  }
  out.status = store.status();
  return out;
}
