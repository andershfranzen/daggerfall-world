// First-person weapon view: draws the readied right-hand weapon from the
// player's own WEAPON*.CIF files and plays the server-authorised swing.
//
// Browser feature per docs/gameplay-protocol.md. Reads `rpg.readied` and the
// right-hand weapon (`rpg.weaponView`, else `rpg.equipment.rightHand`);
// frames are remapped to the item's metal (ImageProcessing.ChangeDye).
// Animates on `swing` events for this player only (the shell sends F/Space).
//
// Right mouse button on the view (classic "swing mode"):
//  - melee: a drag sends one `combat.attack {direction}` per press, using the
//    classic gesture sectors; the camera holds still meanwhile.
//  - bow: press draws (local animation only, nothing sent), release sends one
//    `combat.attack {direction:'down'}`; the server's `swing` looses the arrow.
//    A draw held past 10 s is let down, as in the classic game.
// Emits browser event `weapon:frame` {kind:'hit'|'bowSound'|'done'|'undraw',
// weaponType, direction} so audio can follow the animation.
//
// Image decoding, animation and dye tables are adapted from MIT-licensed code;
// see weapons/THIRD_PARTY_NOTICES.txt. No game art ships with this module.

import { WeaponCif, parsePalette, toRgba } from './weapons/cifReader.js';
import {
  SET, WeaponAnimator, classifyDrag, dyeBitmap, isEnchanted, metalTable, normalizeDirection,
  rightHandItem, weaponFile, weaponQuad, weaponSetForItem,
} from './weapons/animation.js';

const PALETTE_FILE = 'ART_PAL.COL';
const PENDING_TIMEOUT_MS = 800;
const BOW_DRAWBACK_KEY = 'fpWeapon.bowDrawback';

/** Basename → File for a list of user-selected files (case-insensitive). */
export function indexFiles(files) {
  const map = new Map();
  for (const f of files ?? []) {
    if (!f || typeof f.name !== 'string') continue;
    const base = f.name.split(/[\\/]/).pop().toUpperCase();
    if (!map.has(base)) map.set(base, f);
  }
  return map;
}

async function bytesOf(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * Loads one weapon file and the palette from a basename → File map.
 * Resolves to `{cif, palette}`; rejects with a readable Error if missing or malformed.
 */
export async function loadWeaponArt(fileMap, fileName) {
  const cifFile = fileMap.get(fileName);
  const palFile = fileMap.get(PALETTE_FILE);
  if (!cifFile || !palFile) {
    const missing = [!cifFile && fileName, !palFile && PALETTE_FILE].filter(Boolean).join(' and ');
    throw new Error(`Weapon view: ${missing} not found in the selected game files.`);
  }
  const [cifBytes, palBytes] = await Promise.all([bytesOf(cifFile), bytesOf(palFile)]);
  return { cif: new WeaponCif(cifBytes, fileName), palette: parsePalette(palBytes, PALETTE_FILE) };
}

/**
 * What the first-person view should show for a character record:
 * `{set, enchanted, material, fileName}` or null (sheathed, or no art).
 */
export function weaponSpec(rpg) {
  if (!rpg?.readied) return null;
  if (rpg.conditions?.lycanthrope?.transformed) {
    const set = SET.Werecreature;
    return { set, enchanted: false, material: null, fileName: weaponFile(set) };
  }
  const view = rpg.weaponView;
  const item = rightHandItem(rpg) ?? (view?.weaponType && view.template !== 'unarmed' ? view : null);
  const source = item?.template === 'unarmed' ? null : item;
  const set = weaponSetForItem(source);
  if (!set) return null;
  const enchanted = isEnchanted(source);
  const material = set === SET.Melee ? null : source?.material ?? null;
  return { set, enchanted, material, fileName: weaponFile(set, enchanted) };
}

function bowDrawbackSetting() {
  try { return globalThis.localStorage?.getItem(BOW_DRAWBACK_KEY) === '1'; } catch { return false; }
}

export function install(api) {
  if (typeof document === 'undefined') return;

  const canvas = document.createElement('canvas');
  canvas.className = 'fp-weapon';
  canvas.setAttribute('aria-hidden', 'true');
  const view = document.getElementById('view');
  if (view?.parentNode) view.parentNode.insertBefore(canvas, view.nextSibling);
  else document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  let fileMap = indexFiles(api.files);
  const artCache = new Map(); // fileName → Promise<{cif,palette}>
  const frameCache = new Map(); // `${file}:${material}:${r}:${f}` → canvas
  const reported = new Set();
  let screen = null;
  let inJourney = false;
  let current = null; // { key, spec, animator, art|null }
  let pending = 0; // ms timestamp of an unanswered attack this module sent

  const selfId = () => api.state?.selfId ?? null;
  const rpg = () => api.state?.character ?? null;
  const speed = () => {
    const a = rpg()?.character?.attributes ?? rpg()?.attributes;
    return Number(a?.Speed ?? a?.speed ?? 50);
  };

  function report(msg) {
    if (reported.has(msg)) return;
    reported.add(msg);
    api.message?.(msg);
  }

  function art(fileName) {
    if (!artCache.has(fileName)) {
      const job = loadWeaponArt(fileMap, fileName);
      artCache.set(fileName, job);
      job.catch(() => artCache.delete(fileName));
    }
    return artCache.get(fileName);
  }

  function frameImage(spec, loaded, record, frame) {
    const key = `${spec.fileName}:${spec.material ?? ''}:${record}:${frame}`;
    let img = frameCache.get(key);
    if (img) return img;
    const bmp = dyeBitmap(loaded.cif.frame(record, frame), metalTable(spec.material));
    img = document.createElement('canvas');
    img.width = bmp.width;
    img.height = bmp.height;
    img.getContext('2d').putImageData(new ImageData(toRgba(bmp, loaded.palette), bmp.width, bmp.height), 0, 0);
    frameCache.set(key, img);
    return img;
  }

  /** Re-resolves the readied weapon from state; keeps the animator if unchanged. */
  function sync() {
    const spec = weaponSpec(rpg());
    if (!spec) { current = null; return; }
    const key = `${spec.set}:${spec.enchanted}:${spec.material ?? ''}`;
    if (current?.key === key) return;
    const keepAnim = current && current.spec.set === spec.set && current.spec.enchanted === spec.enchanted;
    const animator = keepAnim ? current.animator : new WeaponAnimator(spec.set, spec.enchanted, { bowDrawback: bowDrawbackSetting() });
    current = { key, spec, animator, art: keepAnim ? current.art : null };
    if (current.art) return;
    const mine = current;
    art(spec.fileName).then(
      (loaded) => { if (current === mine) mine.art = loaded; },
      (err) => report(err.message),
    );
  }

  function visible() {
    return screen === 'game' && !api.modalOpen && !inJourney && !!current?.art && current.animator.visible;
  }

  function draw() {
    const dpr = globalThis.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.clearRect(0, 0, w, h);
    if (!visible()) return;
    const { anim, record, frame } = current.animator.current();
    const loaded = current.art;
    const count = loaded.cif.frameCount(record);
    if (!count) return;
    const f = Math.min(frame, count - 1);
    let img;
    try {
      img = frameImage(current.spec, loaded, record, f);
    } catch (err) {
      report(`Weapon view: ${err.message}`);
      current.art = null;
      return;
    }
    const q = weaponQuad(w, h, loaded.cif.size(record), anim);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, Math.round(q.x), Math.round(q.y), Math.round(q.w), Math.round(q.h));
  }

  api.on('assets', (files) => {
    fileMap = indexFiles(files);
    artCache.clear();
    frameCache.clear();
    reported.clear();
    current = null;
    sync();
  });
  api.on('state', () => sync());
  api.on('screen', (name) => {
    screen = typeof name === 'string' ? name : name?.screen ?? null;
    canvas.hidden = screen !== 'game' || inJourney;
  });
  api.on('journey', (j) => {
    inJourney = !!(j && j.phase && j.phase !== 'done');
    canvas.hidden = screen !== 'game' || inJourney;
    if (inJourney) {
      drag = null;
      keyDraw = null;
      if (current?.animator.drawing) current.animator.cancelDraw(speed());
    }
    draw();
  });
  api.on('event', (msg) => {
    const ev = msg?.event ?? msg;
    if (ev?.kind !== 'swing' || ev.playerId == null || String(ev.playerId) !== String(selfId())) return;
    pending = 0;
    sync();
    if (!current) return;
    const a = current.animator;
    if (a.isBow) a.release();
    else a.strike(ev.direction ?? 'down');
  });
  api.on('frame', ({ dt } = {}) => {
    if (current) {
      const a = current.animator;
      const direction = a.state;
      for (const kind of a.update(dt, speed())) api.emit('weapon:frame', { kind, weaponType: current.spec.set, direction });
    }
    if (pending && performance.now() - pending > PENDING_TIMEOUT_MS) {
      pending = 0;
      // The server refused or ignored a bow release: let the draw down.
      if (current?.animator.drawing) current.animator.cancelDraw(speed());
    }
    draw();
  });

  // ---- right button: directional melee strike, or bow draw/release
  const withTarget = (args) => (api.target != null ? { ...args, targetId: String(api.target) } : args);
  let drag = null;
  const target = view ?? window;
  const ready = () => screen === 'game' && !api.modalOpen && !inJourney && !!rpg()?.readied && !!current && !pending;

  window.addEventListener('pointerdown', (e) => {
    if (e.button !== 2 || e.target !== target || screen !== 'game' || api.modalOpen || inJourney) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    drag = { id: e.pointerId, dx: 0, dy: 0, travel: 0, lastX: e.clientX, lastY: e.clientY, sent: false, bow: false };
    if (ready() && current.animator.isBow) drag.bow = current.animator.draw();
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    e.stopImmediatePropagation();
    if (drag.bow) return;
    const locked = !!document.pointerLockElement;
    const mx = locked ? e.movementX : e.clientX - drag.lastX;
    const my = locked ? e.movementY : e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    drag.dx += mx;
    drag.dy += my;
    drag.travel += Math.hypot(mx, my);
    if (drag.sent) return;
    const direction = classifyDrag(drag.dx, drag.dy, drag.travel, Math.max(innerWidth, innerHeight));
    if (!direction) return;
    drag.sent = true;
    if (!ready() || current.animator.attacking || current.animator.isBow) return;
    pending = performance.now();
    api.act('combat.attack', withTarget({ direction }));
  }, true);
  const end = (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const wasBow = drag.bow;
    drag = null;
    if (!wasBow || !current?.animator.drawing) return;
    if (e.type === 'pointercancel' || screen !== 'game' || api.modalOpen) { current.animator.cancelDraw(speed()); return; }
    // One arrow per release.
    pending = performance.now();
    if (!api.act('combat.attack', withTarget({ direction: 'down' }))) { pending = 0; current.animator.cancelDraw(speed()); }
  };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
  window.addEventListener('blur', () => {
    if ((drag?.bow || keyDraw) && current?.animator.drawing) current.animator.cancelDraw(speed());
    drag = null;
    keyDraw = null;
  });

  // ---- shell attacks (Space / click / pad) via the shell's cancellable attackIntent
  let lastKey = { code: null, repeat: false };
  let keyDraw = null; // { code, targetId } while the attack key holds a bow drawn
  window.addEventListener('keydown', (e) => { lastKey = { code: e.code, repeat: e.repeat }; }, true);
  window.addEventListener('keyup', (e) => {
    if (!keyDraw || e.code !== keyDraw.code) return;
    const { targetId } = keyDraw;
    keyDraw = null;
    if (!current?.animator.drawing) return;
    if (screen !== 'game' || api.modalOpen) { current.animator.cancelDraw(speed()); return; }
    pending = performance.now();
    if (!api.act('combat.attack', targetId != null ? { targetId } : {})) { pending = 0; current.animator.cancelDraw(speed()); }
  }, true);
  api.on('attackIntent', (d) => {
    if (!d || !current || screen !== 'game') return;
    if (inJourney) { d.preventDefault(); return; }
    const a = current.animator;
    const busy = !!pending || a.attacking || (a.isBow && a.cooldown > 0) || !!drag;
    if (a.isBow) {
      // One arrow per press: a held key's auto-repeat never fires again.
      if (d.source === 'key' && (lastKey.repeat || keyDraw)) { d.preventDefault(); return; }
      if (busy) { d.preventDefault(); return; }
      if (a.bowDrawback && d.source === 'key' && lastKey.code) {
        // Classic drawback: the key draws, its release looses.
        d.preventDefault();
        if (a.draw()) keyDraw = { code: lastKey.code, targetId: d.targetId };
      }
      return;
    }
    // Melee: don't ask the server for a swing while one is still playing.
    if (busy) d.preventDefault();
  });

  sync();
}

export { normalizeDirection };
