// Doors of World of Daggerfall RMB buildings in the wilderness (farmhouses), in the browser.
//
// The server decides every transfer through the shared portal service (server/rpg/interiors.js, with the source
// in server/rpg/wilderness/buildings.js). This module, installed by the wilderness panel feature:
//  - finds the building doors of the current `wilderness:<px>,<py>` pixel from the player's own files and the
//    pixel's scene descriptor, with the same code the server validates with (client/world/wilderness/buildings.js);
//  - shows "G — Enter: House" in reach and sends `portal.use {portalId}`; inside, "G — Leave" sends `portal.leave`;
//  - draws `interior:wod:…` scenes through api.setScene.
// Town buildings and dungeons stay with client/gameplay/interiors.js, which ignores these ids.

import { openWorldData } from '../../world/interiors/index.js';
import { DOOR_TYPE } from '../../world/interiors/scene.js';
import {
  parseSiteInterior, siteBuildingPortals, loadSiteInterior,
} from '../../world/wilderness/buildings.js';
import { buildingTypeName } from '../../world/interiors/index.js';
import { parseSiteId } from '../../world/wilderness/data.js';
import { fetchDescriptor } from '../wilderness.js';

/** Prompt distance; the server accepts up to 3 m. */
export const REACH = 2.4;

const parsePixel = (id) => {
  const m = /^wilderness:(\d{1,3}),(\d{1,3})$/.exec(String(id ?? ''));
  return m ? { px: +m[1], py: +m[2] } : null;
};

/** Door list of a siteBuildingPortals() result: [{portalId, label, x, z, site}]. */
export function wildernessDoors(result) {
  const out = [];
  for (const b of result.buildings) {
    for (const d of b.doors) out.push({ portalId: b.portalId, label: buildingTypeName(b.buildingType), x: d.x, z: d.z, site: b.site, siteName: b.siteName });
  }
  return out;
}

/** Nearest door within `reach` of (x, z), or null. */
export function nearestDoor(doors, x, z, reach = REACH) {
  let best = null, bd = reach;
  for (const d of doors) {
    const dist = Math.hypot(d.x - x, d.z - z);
    if (dist <= bd) {
      bd = dist;
      best = d;
    }
  }
  return best;
}

/**
 * @param {object} api gameplay API
 * @param {object} [opts] test seams: descriptor(location), data(), portals(location) -> result, loadScene(location)
 */
export function installWildernessBuildings(api, opts = {}) {
  const S = {
    files: null,
    data: null,
    doors: new Map(), // wilderness location -> door list
    surveying: new Set(),
    failed: new Map(), // location -> message
    sceneLoc: null,
    loading: null,
    exits: [],
    near: null,
    prompt: null,
  };

  const filesNow = () => (api.files ? [...api.files] : []);
  function data() {
    if (opts.data) return (S.data ??= Promise.resolve(opts.data()));
    const files = filesNow();
    if (!files.length) return Promise.reject(new Error('Your Daggerfall files are not loaded.'));
    if (S.files !== api.files || !S.data) {
      S.files = api.files;
      S.data = openWorldData(files);
      S.data.catch(() => { S.data = null; });
    }
    return S.data;
  }
  const descriptor = (location) => (opts.descriptor ? Promise.resolve(opts.descriptor(location)) : fetchDescriptor(location));

  async function survey(location) {
    if (!parsePixel(location) || S.doors.has(location) || S.surveying.has(location)) return;
    if (!opts.portals && !opts.data && !filesNow().length) return;
    S.surveying.add(location);
    try {
      const result = opts.portals ? await opts.portals(location) : await (async () => {
        const d = await descriptor(location);
        if (!d) return { location, buildings: [], skipped: [] };
        return siteBuildingPortals(await data(), d);
      })();
      const doors = wildernessDoors(result);
      S.doors.set(location, doors);
      S.failed.delete(location);
      api.emit('wildernessBuildings:doors', { location, doors });
    } catch (err) {
      S.failed.set(location, err?.message ?? String(err));
      console.warn('[wilderness] could not read the building doors of', location, err);
    } finally {
      S.surveying.delete(location);
    }
  }

  function syncScene() {
    const loc = api.location;
    const p = parseSiteInterior(loc);
    if (!p) {
      S.sceneLoc = null;
      S.exits = [];
      if (parsePixel(loc)) survey(loc);
      return;
    }
    if (S.sceneLoc === loc || S.loading) return;
    if (!opts.loadScene && !filesNow().length) return;
    const job = opts.loadScene
      ? Promise.resolve().then(() => opts.loadScene(loc))
      : (async () => {
        const site = parseSiteId(p.site);
        const d = await descriptor(`wilderness:${site.px},${site.py}`);
        return loadSiteInterior(await data(), loc, d?.sites.find((s) => s.id === p.site) ?? null);
      })();
    S.loading = job;
    api.setScene(job, { location: loc }).catch((err) => {
      if (S.loading !== job || api.location !== loc) return;
      const message = err?.message ?? String(err);
      api.emit('sceneError', { location: loc, message, source: 'wildernessBuildings' });
      api.message?.(`Could not draw this building: ${message}`, { kind: 'error' });
    }).finally(() => { if (S.loading === job) S.loading = null; });
  }

  function currentDoors() {
    const loc = api.location;
    if (parsePixel(loc)) return S.doors.get(loc) ?? [];
    if (parseSiteInterior(loc) && S.sceneLoc === loc) return S.exits;
    return [];
  }

  function use(door) {
    if (!door) return false;
    if (door.portalId) return api.act('portal.use', { portalId: door.portalId });
    return api.act('portal.leave', {});
  }

  function ensurePrompt() {
    if (S.prompt || typeof document === 'undefined') return S.prompt;
    const el = document.createElement('div');
    el.className = 'interiors-prompt wilderness-door-prompt';
    el.hidden = true;
    el.setAttribute('role', 'status');
    (document.getElementById('hud') ?? document.body).append(el);
    S.prompt = el;
    return el;
  }
  function showPrompt(door) {
    const el = ensurePrompt();
    if (!el) return;
    if (!door || api.modalOpen) {
      if (!el.hidden) el.hidden = true;
      return;
    }
    const text = `G — ${door.portalId ? `Enter: ${door.label}` : door.label}`;
    if (el.textContent !== text) el.textContent = text;
    if (el.hidden) el.hidden = false;
  }

  api.on('scene', (mesh) => {
    if (mesh?.kind === 'interior' && parseSiteInterior(mesh.location)) {
      S.sceneLoc = mesh.location;
      S.exits = (mesh.doors ?? []).filter((d) => d.type === DOOR_TYPE.BUILDING).map((d) => ({ x: d.x, y: d.y, z: d.z, label: 'Leave' }));
    } else if (S.sceneLoc && mesh?.location !== S.sceneLoc) {
      S.sceneLoc = null;
      S.exits = [];
    }
  });
  api.on('location', () => {
    S.near = null;
    showPrompt(null);
    S.loading = null;
    syncScene();
  });
  api.on('assets', () => {
    S.data = null;
    S.doors.clear();
    S.failed.clear();
    syncScene();
  });
  api.on('frame', (f) => {
    const cam = f?.camera;
    if (!cam) return;
    const near = nearestDoor(currentDoors(), cam.x, cam.z, REACH);
    S.near = near;
    showPrompt(near);
  });
  api.on('interactIntent', (d) => {
    if (d?.handled || d?.entity || !S.near) return;
    d.handled = true;
    d.preventDefault?.();
    use(S.near);
  });
  api.on('event', (ev) => {
    if (ev?.kind !== 'teleport') return;
    // The teleport event arrives before the location change it announces.
    if (parseSiteInterior(ev.location)) api.message?.(`You enter: ${ev.label}.`);
    else if (parsePixel(ev.location) && parseSiteInterior(api.location)) api.message?.('You step outside.');
  });

  if (api.location) syncScene();
  const handle = { state: S, survey, currentDoors, use };
  api.wildernessDoors = handle; // diagnostics and end-to-end checks (read-only use)
  return handle;
}
