// Building interiors and dungeons in the browser (docs/gameplay-protocol.md feature module).
//
// The server decides every transfer (server/rpg/interiors.js). This module:
//  - finds the doors of the current town from the player's own files (client/world/interiors, the same code the
//    server validates with) and shows "Enter <building>" when one is in reach;
//  - sends `portal.use {portalId}` / `portal.leave` on the interact key (or the Places panel);
//  - draws the interior or dungeon scene for `interior:` / `dungeon:` locations through api.setScene. Town scenes
//    stay with the travel feature, which restores the exterior when the player walks back out.
//
// Browser events it publishes: 'interiors:doors' {location, doors}, 'teleport' {location, x, y, z, yaw}.
// MIT notices for the adapted world code: client/world/interiors/THIRD_PARTY_NOTICES.txt.

import {
  openWorldData, locationPortals, parseLocation, loadInterior, loadDungeon, townLocation, buildingTypeName, DOOR_TYPE,
  buildingDoorFloor,
} from '../world/interiors/index.js';
import { directAction, mechanismAimPoints, mechanismBounds, mechanismLabel, opcodeFamily } from '../world/interiors/dungeonActions.js';
import { parseTextRsc } from './character/classic.js';
import { GRAVEYARD_ACCESS } from '../world/interiors/dungeonAccess.js';

export const name = 'interiors';
/** Prompt distance; the server accepts up to 3 m so a prompt never offers a door the server would refuse. */
export const REACH = 2.4;

/** Doors a player can use in a town, from a locationPortals() result: [{portalId, label, x, z, floor?}]. */
export function townDoors(portals) {
  const out = [];
  for (const b of portals.buildings) {
    if (!b.exits.length) continue;
    for (const d of b.doors) {
      // A ship cabin door is offered only on its own deck (the server requires the same floor).
      const floor = buildingDoorFloor(b, d);
      out.push({ portalId: b.portalId, label: b.name || buildingTypeName(b.buildingType), x: d.x, z: d.z, kind: 'building',
        ...(floor === null ? {} : { floor }) });
    }
  }
  if (portals.dungeon?.exits.length) {
    for (const d of portals.dungeon.doors) out.push({
      portalId: portals.dungeon.portalId,
      label: d.access === GRAVEYARD_ACCESS ? 'Crypt access (compatibility)' : portals.dungeon.name,
      x: d.x, z: d.z, kind: 'dungeon',
    });
  }
  return out;
}

/** Exit doors of an interior or dungeon scene. */
export function sceneExits(scene) {
  if (scene.exits) return scene.exits.map((d) => ({ ...d, label: 'Leave' }));
  const type = scene.kind === 'dungeon' ? DOOR_TYPE.DUNGEON_EXIT : DOOR_TYPE.BUILDING;
  return scene.doors.filter((d) => d.type === type).map((d) => ({ x: d.x, y: d.y, z: d.z, label: 'Leave' }));
}

/** Nearest door within `reach` of (x, z), or null. */
export function nearestDoor(doors, x, z, reach = REACH, eyeY) {
  let best = null, bd = reach;
  for (const d of doors) {
    // Eye height less the standing eye (1.6 m) is the foot height; unknown eye height offers no floor-bound door.
    if (Number.isFinite(d.floor) && !(Math.abs(eyeY - 1.6 - d.floor) <= 1.25)) continue;
    if (Number.isFinite(eyeY) && Number.isFinite(d.y) && Math.abs(eyeY - d.y) > reach) continue;
    const dist = Math.hypot(d.x - x, d.z - z);
    if (dist <= bd) {
      bd = dist;
      best = d;
    }
  }
  return best;
}

/**
 * @param {object} api  gameplay API
 * @param {object} [opts]  test seams: portalsFor(mesh) -> Promise<locationPortals result>, loadScene(location) -> Promise<scene>
 */
export function install(api, opts = {}) {
  const S = {
    files: null,
    data: null, // Promise<world data> for S.files
    doors: new Map(), // town location -> door list
    surveying: new Set(),
    scene: null, // current interior/dungeon scene
    sceneLoc: null,
    loading: null,
    near: null,
    prompt: null,
    error: null,
    mechanismState: null,
    rsc: null, // Promise<TEXT.RSC reader | null> from the player's own files
    answer: null, // open opcode 12 prompt element
    mechanisms: [],
    exits: [],
    syncLoc: null,
  };

  const filesNow = () => (api.files ? [...api.files] : []);
  function data() {
    const files = filesNow();
    if (!files.length) return Promise.reject(new Error('Your Daggerfall files are not loaded.'));
    if (S.files !== api.files || !S.data) {
      S.files = api.files;
      S.data = openWorldData(files);
      S.data.catch(() => { S.data = null; });
    }
    return S.data;
  }

  // ---------------------------------------------------------------- authored text (TEXT.RSC, read locally)

  function textFile() {
    if (S.rsc && S.rscFiles === api.files) return S.rsc;
    S.rscFiles = api.files;
    const file = filesNow().find((f) => f?.name?.toUpperCase() === 'TEXT.RSC');
    S.rsc = file ? file.arrayBuffer().then((b) => parseTextRsc(new Uint8Array(b))).catch(() => null) : Promise.resolve(null);
    return S.rsc;
  }
  const tidy = (t) => String(t ?? '').replace(/%[a-z]+/gi, '').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n').trim();
  async function recordText(record) {
    if (record == null) return null;
    const rsc = opts.textFile ? await opts.textFile() : await textFile();
    return rsc ? tidy(rsc.text(record, Math.random())) : null;
  }

  function closeAnswer() {
    S.answer?.remove();
    S.answer = null;
  }
  async function askAnswer(ev) {
    closeAnswer();
    if (typeof document === 'undefined') return;
    const prompt = (await recordText(ev.record)) || 'Answer:';
    const form = document.createElement('form');
    form.className = 'interiors-answer';
    form.setAttribute('role', 'dialog');
    const text = document.createElement('p');
    text.textContent = prompt;
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 20; // DaggerfallInputMessageBox(…, 20, " > ", …)
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Your answer');
    form.append(text, input);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      api.act('dungeon.answer', { id: ev.id, text: input.value });
      closeAnswer();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeAnswer(); } });
    (document.getElementById('hud') ?? document.body).append(form);
    S.answer = form;
    input.focus();
  }

  // ---------------------------------------------------------------- town doors

  async function survey(mesh) {
    const region = mesh?.source?.region ?? mesh?.region;
    if (!mesh || (mesh.kind && mesh.kind !== 'town') || !region || !mesh.source?.spawnLocal) return;
    const loc = mesh.source.townId ?? townLocation(region, mesh.name);
    if (S.doors.has(loc) || S.surveying.has(loc)) return;
    S.surveying.add(loc);
    try {
      const portals = opts.portalsFor
        ? await opts.portalsFor(mesh)
        : await locationPortals(await data(), { region: mesh.source.regionIndex ?? region, location: mesh.source.locationIndex ?? mesh.name }, mesh.source.spawnLocal);
      const doors = townDoors(portals);
      S.doors.set(loc, doors);
      api.emit('interiors:doors', { location: loc, doors });
      api.refreshPanel?.('places');
    } catch (err) {
      console.warn('[interiors] could not read the doors of', loc, err);
    } finally {
      S.surveying.delete(loc);
    }
  }

  // ---------------------------------------------------------------- instance scenes

  function syncScene() {
    const loc = api.location;
    const p = parseLocation(loc);
    if (!p || p.kind === 'town') {
      S.scene = null;
      S.sceneLoc = null;
      return;
    }
    if (S.sceneLoc === loc || S.loading === loc) return;
    if (!opts.loadScene && !filesNow().length) return;
    S.loading = loc;
    S.error = null;
    const job = opts.loadScene
      ? Promise.resolve().then(() => opts.loadScene(loc))
      : data().then((d) => (p.kind === 'dungeon' ? loadDungeon(d, loc) : loadInterior(d, loc)));
    api
      .setScene(job, { location: loc })
      .then((applied) => {
        if (S.loading === loc) S.loading = null;
        if (!applied) return;
      })
      .catch((err) => {
        if (S.loading === loc) S.loading = null;
        S.error = { location: loc, message: err?.message || String(err) };
        api.emit('sceneError', { location: loc, message: S.error.message, source: 'interiors' });
        api.message?.(`Could not draw this place: ${S.error.message}`, { kind: 'error' });
        api.refreshPanel?.('places');
      });
  }

  // ---------------------------------------------------------------- doors in reach

  function currentDoors() {
    const loc = api.location;
    const p = parseLocation(loc);
    if (!p) return [];
    if (p.kind === 'town') return S.doors.get(loc) ?? [];
    return S.sceneLoc === loc ? S.exits : [];
  }

  function drawMechanisms() {
    const scene = S.scene;
    if (!scene?.mechanisms?.length) return;
    const mine = S.mechanismState?.location === scene.location;
    const active = mine ? S.mechanismState.active : new Set();
    const locks = mine ? S.mechanismState.locks : {};
    api.renderer?.setDungeonPoses?.(scene, active);
    for (const m of S.mechanisms) {
      m.locked = !!m.door && !active.has(m.id) && (locks[m.id] ?? m.lock ?? 0) > 0;
      m.label = m.door ? (active.has(m.id) ? 'Close door' : m.locked ? 'Open door (locked)' : 'Open door') : mechanismLabel(m);
    }
  }

  function mechanismNear(cam) {
    if (S.sceneLoc !== api.location) return null;
    let best = null, score = Infinity;
    for (const m of S.mechanisms) {
      for (const [tx, ty, tz] of m.aimPoints) {
        const x = tx - cam.x, z = tz - cam.z;
        const distance = Math.hypot(x, z);
        if (distance > REACH || Math.abs(cam.y - ty) > (m.door ? 1.25 : 1.8)) continue;
        const facing = distance < 0.4 ? 1 : (x * Math.sin(cam.yaw) - z * Math.cos(cam.yaw)) / distance;
        const nextScore = distance + 2 * (1 - facing);
        if (facing < 0.25 || nextScore >= score) continue;
        score = nextScore;
        best = m;
      }
    }
    return best;
  }

  function use(door) {
    if (!door) return false;
    if (door.id) return api.act('dungeon.use', { id: door.id });
    if (door.portalId) return api.act('portal.use', { portalId: door.portalId });
    return api.act('portal.leave', {});
  }

  function ensurePrompt() {
    if (S.prompt || typeof document === 'undefined') return S.prompt;
    const el = document.createElement('div');
    el.className = 'interiors-prompt';
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

  // ---------------------------------------------------------------- panel

  api.registerPanel?.('places', 'Places', (root) => {
    root.replaceChildren();
    const loc = api.location;
    const p = parseLocation(loc);
    const h = document.createElement('h2');
    h.textContent = p ? (p.kind === 'town' ? p.location : S.scene?.name ?? p.location) : 'Unknown place';
    root.append(h);
    const info = document.createElement('p');
    if (!p) info.textContent = 'You are somewhere without doors.';
    else if (p.kind === 'town') info.textContent = S.doors.has(loc) ? `${S.doors.get(loc).length} doors in this town can be opened.` : 'Reading the doors of this town…';
    else info.textContent = p.kind === 'dungeon' ? 'You are inside a dungeon. Find the exit door to leave.' : 'You are inside a building.';
    root.append(info);
    if (S.error && S.error.location === loc) {
      const e = document.createElement('p');
      e.className = 'interiors-error';
      e.textContent = S.error.message;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Try again';
      retry.addEventListener('click', () => { S.error = null; S.sceneLoc = null; syncScene(); });
      root.append(e, retry);
    }
    const near = S.near;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.disabled = !near;
    btn.textContent = near ? (near.portalId ? `Enter: ${near.label}` : near.label) : 'No door within reach';
    btn.addEventListener('click', () => { if (S.near) use(S.near); });
    root.append(btn);
    if (near?.locked) {
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.textContent = 'Pick the lock';
      pick.addEventListener('click', () => { if (S.near?.locked) api.act('dungeon.pick', { id: S.near.id }); });
      const hint = document.createElement('p');
      hint.textContent = 'Attack a door with a readied weapon to try to bash it open.';
      root.append(pick, hint);
    }
  }, { order: 45 });

  // ---------------------------------------------------------------- events

  api.on('scene', (mesh) => {
    if (mesh && (mesh.kind === 'interior' || mesh.kind === 'dungeon')) {
      S.scene = mesh;
      S.sceneLoc = mesh.location;
      S.exits = sceneExits(mesh);
      // People flats with the Dialogue opcode talk through the NPC feature.
      S.mechanisms = (mesh.mechanisms ?? []).filter((m) => m.door || (directAction(m.action?.trigger) && opcodeFamily(m.action.opcode) !== 'dialogue'))
        .map((m) => {
          // Some royal doors have a high hinge and need a target on the reachable panel.
          const first = m.firstTriangle * 9;
          const bounds = m.door ? mechanismBounds(mesh.positions, first, first + m.triangleCount * 9) : null;
          return { ...m, aimPoints: mechanismAimPoints(m, bounds) };
        });
      drawMechanisms();
    } else {
      S.scene = null;
      S.sceneLoc = null;
      survey(mesh);
    }
    api.refreshPanel?.('places');
  });
  api.on('location', () => {
    S.near = null;
    closeAnswer();
    showPrompt(null);
    syncScene();
    api.refreshPanel?.('places');
  });
  api.on('state', (state) => {
    const loc = state && parseLocation(api.location)?.kind === 'dungeon' ? api.location : null;
    if (S.syncLoc === loc) return;
    S.syncLoc = loc;
    if (loc) api.act('dungeon.sync', {});
  });
  api.on('assets', () => {
    S.data = null;
    S.doors.clear();
    if (api.town) survey(api.town);
    syncScene();
  });
  api.on('frame', (f) => {
    const cam = f?.camera;
    if (!cam) return;
    if (!S.doors.size && f.town && !f.town.kind) survey(f.town);
    const near = nearestDoor(currentDoors(), cam.x, cam.z, REACH, cam.y) ?? mechanismNear(cam);
    if (near !== S.near) {
      S.near = near;
      api.refreshPanel?.('places');
    }
    showPrompt(near);
  });
  api.on('interactIntent', (d) => {
    if (d?.handled) return;
    // DFU PlayerActivate.ActivateStaticNPC: people carrying a ShowText or ShowTextWithInput action (the Castle
    // Daggerfall guard, the Benefactor, Sheogorath) answer through their action instead of a conversation.
    const scripted = d?.entity?.kind === 'npc' && S.sceneLoc === api.location
      ? S.mechanisms.find((m) => m.flat && (m.action?.opcode === 11 || m.action?.opcode === 12) &&
        Math.hypot(m.x - d.entity.x, m.z - d.entity.z) < 0.75)
      : null;
    if (scripted) { d.preventDefault?.(); use(scripted); return; }
    if (d?.entity) return; // a person or object in the crosshair wins
    if (!S.near) return;
    d.preventDefault?.();
    use(S.near);
  });
  api.on('stealIntent', (d) => {
    if (d?.handled || d?.entity || !S.near?.locked) return;
    d.preventDefault?.();
    api.act('dungeon.pick', { id: S.near.id });
  });
  api.on('attackIntent', (d) => {
    if (d?.handled || d?.targetId || !api.character?.readied || api.character?.weaponView?.weaponType === 'Bow' ||
        S.near?.kind !== 'building') return;
    const cam = api.camera;
    if (!cam) return;
    const dx = S.near.x - cam.x, dz = S.near.z - cam.z;
    const distance = Math.hypot(dx, dz);
    if (distance >= 0.4 && dx * Math.sin(cam.yaw) - dz * Math.cos(cam.yaw) < distance * 0.5) return;
    d.preventDefault();
    api.act('combat.attack', { buildingPortalId: S.near.portalId });
  });
  // Info mode (package 4): describe the door or mechanism in reach without using it.
  api.on('infoIntent', (d) => {
    if (d?.handled || d?.entity || !S.near) return;
    d.preventDefault?.();
    const m = S.near;
    if (!m.id) { api.message?.(m.label === 'Leave' ? 'An exit.' : `You see ${m.label}.`); return; }
    const lock = S.mechanismState?.locks?.[m.id] ?? m.lock ?? 0;
    api.message?.(m.door ? (m.locked ? (lock >= 20 ? 'This is a magically held lock.' : 'This door is locked.') : 'A door.') : `${mechanismLabel(m)}.`);
  });
  api.on('event', (ev) => {
    if (ev?.kind === 'dungeonState') {
      const prev = S.mechanismState?.location === ev.location ? S.mechanismState.active : null;
      S.mechanismState = { location: ev.location, active: new Set(ev.active), locks: ev.locks ?? {} };
      // Package 21 (sound): mechanisms that moved since this dungeon's previous snapshot. The arrival snapshot
      // is the resting state and is silent. Chained lifts and platforms are included (full scene list).
      if (prev && S.scene?.location === ev.location) {
        const changed = [];
        for (const m of S.scene.mechanisms ?? []) {
          const open = S.mechanismState.active.has(m.id);
          if (open !== prev.has(m.id)) changed.push({ id: m.id, open, door: !!m.door, sound: m.action?.index ?? 0, x: m.x, z: m.z });
        }
        if (changed.length) api.emit?.('mechanisms', { location: ev.location, changed });
      }
      drawMechanisms();
      api.refreshPanel?.('places');
    }
    if (ev?.kind === 'dungeonText') {
      if (ev.text) api.message?.(ev.text);
      else recordText(ev.record).then((t) => { if (t) api.message?.(t, { kind: 'dungeon', record: ev.record }); });
    }
    if (ev?.kind === 'dungeonPrompt') askAnswer(ev);
    if (ev?.kind === 'dungeonHazard') {
      if (ev.pool === 'health' && ev.amount > 0) api.message?.(`A trap hurts you for ${ev.amount} health.`, { kind: 'error' });
      else if (ev.pool === 'magicka' && ev.amount > 0) api.message?.(`Your magicka drains away (${ev.amount}).`);
      else if (ev.pool === 'poison' && ev.contracted?.length) api.message?.('You have been poisoned.', { kind: 'error' });
    }
    if (ev?.kind !== 'teleport') return;
    api.emit('teleport', { location: ev.location, x: ev.x, y: ev.y, z: ev.z, yaw: ev.yaw });
    if (ev.location === api.location) return;
    const inside = parseLocation(ev.location)?.kind;
    if (inside === 'interior' || inside === 'dungeon') api.message?.(`You enter: ${ev.label}.`);
    else if (inside === 'town') api.message?.('You step outside.');
  });

  if (typeof document !== 'undefined' && !document.querySelector('link[data-feature="interiors"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./interiors.css', import.meta.url).href;
    link.dataset.feature = 'interiors';
    document.head.append(link);
  }
  if (api.town) survey(api.town);
  if (api.location) syncScene();
}

export default { name, install };
