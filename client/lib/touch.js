// Phone play: complete touch movement, touch look, action buttons, and local ARENA2 .zip archive loader.
// Pure ZIP parser and virtual thumbstick math are DOM-free so they run under `node --test`.

import { selectArena2 } from './files.js';

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;

// ------------------------------------------------------------------ pure ZIP loader (Stored + Deflate)

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'function') {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const res = new Response(ds.readable);
    return new Uint8Array(await res.arrayBuffer());
  }
  // Node.js runtime fallback for unit tests
  const zlib = await import('node:zlib');
  return new Uint8Array(zlib.inflateRawSync(bytes));
}

/**
 * Parse a ZIP archive ArrayBuffer / Uint8Array into entry descriptors without extracting bytes yet.
 * Supports method 0 (Stored) and method 8 (Deflate).
 */
export function parseZipEntries(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 22) throw new Error('ZIP archive is too small.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate End of Central Directory record (up to 65KB comment).
  const minPos = Math.max(0, bytes.length - 65557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (view.getUint32(i, true) === ZIP_EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP archive (missing central directory).');

  const totalEntries = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const entries = [];
  let p = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== ZIP_CD_SIG) {
      throw new Error('Corrupt ZIP central directory.');
    }
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const path = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith('/')) continue; // skip directories
    entries.push({ path, name: path.split('/').pop(), method, compressedSize, uncompressedSize, localOffset });
  }
  return entries;
}

/** Extract a single entry's raw bytes from a ZIP buffer. */
export async function extractZipEntryBytes(input, entry) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const off = entry.localOffset;
  if (off + 30 > bytes.length || view.getUint32(off, true) !== ZIP_LOCAL_SIG) {
    throw new Error(`Corrupt local header for ${entry.path}`);
  }
  const nameLen = view.getUint16(off + 26, true);
  const extraLen = view.getUint16(off + 28, true);
  const dataStart = off + 30 + nameLen + extraLen;
  const slice = bytes.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return new Uint8Array(slice);
  if (entry.method === 8) return inflateRaw(slice);
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.path}`);
}

/**
 * Load ARENA2 files from a local .zip File or ArrayBuffer/Uint8Array.
 * Returns a selectArena2-compatible result `{ files, dir, total, missing, problem, fromZip: true }`.
 */
export async function extractArena2FromZip(zipInput) {
  const buf = zipInput && typeof zipInput.arrayBuffer === 'function'
    ? new Uint8Array(await zipInput.arrayBuffer())
    : (zipInput instanceof Uint8Array ? zipInput : new Uint8Array(zipInput));
  const entries = parseZipEntries(buf);
  const items = [];
  for (const entry of entries) {
    if (entry.method !== 0 && entry.method !== 8) continue;
    const raw = await extractZipEntryBytes(buf, entry);
    const file = typeof File === 'function'
      ? new File([raw], entry.name, { type: 'application/octet-stream' })
      : {
        name: entry.name,
        size: raw.byteLength,
        lastModified: 0,
        async arrayBuffer() { return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength); },
        slice(a, b) {
          const sub = raw.subarray(a, b);
          return { async arrayBuffer() { return sub.buffer.slice(sub.byteOffset, sub.byteOffset + sub.byteLength); } };
        },
      };
    items.push({ file, path: entry.path });
  }
  const sel = selectArena2(items);
  return { ...sel, fromZip: true };
}

// ------------------------------------------------------------------ pure virtual touch math

export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.matchMedia?.('(pointer: coarse)')?.matches || (navigator.maxTouchPoints || 0) > 0);
}

/**
 * Compute normalized virtual joystick vector { forward, strafe, running, magnitude }
 * from pointer offset (dx, dy) inside a circular pad of `radius` px.
 */
export function computeStickVector(dx, dy, radius = 56, deadzone = 0.14) {
  const r = Math.max(10, radius);
  const dist = Math.hypot(dx, dy);
  const norm = Math.min(1, dist / r);
  if (norm <= deadzone) return { forward: 0, strafe: 0, running: false, magnitude: 0, clampedX: 0, clampedY: 0 };
  const scaled = (norm - deadzone) / Math.max(0.05, 1 - deadzone);
  const ux = dx / dist;
  const uy = dy / dist;
  return {
    forward: Math.max(-1, Math.min(1, -uy * scaled)),
    strafe: Math.max(-1, Math.min(1, ux * scaled)),
    running: norm >= 0.82,
    magnitude: scaled,
    clampedX: ux * Math.min(dist, r),
    clampedY: uy * Math.min(dist, r),
  };
}

export function createTouchState() {
  let lookYaw = 0;
  let lookPitch = 0;
  const state = {
    move: { forward: 0, strafe: 0, running: false },
    addLook(dx, dy, sens = 0.0055, invertY = false) {
      lookYaw += dx * sens;
      lookPitch -= dy * sens * (invertY ? -1 : 1);
    },
    consumeLook() {
      const out = { yaw: lookYaw, pitch: lookPitch };
      lookYaw = 0;
      lookPitch = 0;
      return out;
    },
    reset() {
      state.move = { forward: 0, strafe: 0, running: false };
      lookYaw = 0;
      lookPitch = 0;
    },
  };
  return state;
}

// ------------------------------------------------------------------ feature install (ZIP button + Phone Touch HUD)

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};

export function install(api) {
  const touchState = createTouchState();
  api._touchState = touchState;
  let overlay = null;
  let knob = null;

  // ---- 1. Local ARENA2 .zip loader wired onto the landing drop panel
  function attachZipLoader() {
    if (typeof document === 'undefined') return;
    const actions = document.querySelector('#data-drop .drop-actions');
    const dataInput = document.getElementById('data-input');
    const dataStatus = document.getElementById('data-status');
    const drop = document.getElementById('data-drop');
    if (!actions || document.getElementById('data-pick-zip')) return;

    const zipInput = el('input', { id: 'data-zip-input', type: 'file', accept: '.zip,application/zip', hidden: true });
    const zipBtn = el('button', {
      id: 'data-pick-zip',
      type: 'button',
      class: 'btn btn-small',
      onclick: () => zipInput.click(),
      text: 'Load ARENA2 .zip…',
    });

    async function handleZipFile(file) {
      if (!file) return;
      if (dataStatus) dataStatus.textContent = `Extracting “${file.name}” locally in this browser…`;
      try {
        const res = await extractArena2FromZip(file);
        if (res.problem) {
          if (dataStatus) dataStatus.textContent = res.problem;
          if (drop) drop.dataset.state = 'error';
          return;
        }
        // Feed extracted File objects into #data-input via DataTransfer so main.js's acceptData receives them cleanly.
        if (dataInput && typeof DataTransfer === 'function') {
          const dt = new DataTransfer();
          for (const f of res.files) dt.items.add(f);
          dataInput.files = dt.files;
          dataInput.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          api.files = res.files;
          api.emit('assets', res.files);
        }
      } catch (err) {
        if (dataStatus) dataStatus.textContent = `Could not read ZIP archive: ${err.message}`;
        if (drop) drop.dataset.state = 'error';
      }
    }

    zipInput.addEventListener('change', () => {
      const f = zipInput.files?.[0];
      zipInput.value = '';
      if (f) handleZipFile(f);
    });
    drop?.addEventListener('drop', (e) => {
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => /\.zip$/i.test(f.name));
      if (!file) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      handleZipFile(file);
    }, true);

    actions.append(zipBtn, zipInput);
  }

  // ---- 2. Complete Phone Touch Controls HUD overlay
  function ensureOverlay() {
    if (typeof document === 'undefined') return null;
    if (overlay) return overlay;
    const hud = document.getElementById('hud');
    if (!hud) return null;

    knob = el('div', { class: 'touch-stick-knob', 'aria-hidden': 'true' });
    const stickZone = el('div', { id: 'touch-stick', class: 'touch-stick-zone', role: 'application', 'aria-label': 'Movement stick' }, knob);
    const lookZone = el('div', { id: 'touch-look', class: 'touch-look-zone', 'aria-label': 'Look around touch area' });

    let stickDrag = null;
    stickZone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = stickZone.getBoundingClientRect();
      stickDrag = { id: e.pointerId, cx: r.left + r.width / 2, cy: r.top + r.height / 2, radius: r.width / 2 };
      stickZone.setPointerCapture?.(e.pointerId);
      const v = computeStickVector(e.clientX - stickDrag.cx, e.clientY - stickDrag.cy, stickDrag.radius);
      touchState.move = { forward: v.forward, strafe: v.strafe, running: v.running };
      knob.style.transform = `translate(${v.clampedX}px, ${v.clampedY}px)`;
    });
    stickZone.addEventListener('pointermove', (e) => {
      if (!stickDrag || e.pointerId !== stickDrag.id) return;
      const v = computeStickVector(e.clientX - stickDrag.cx, e.clientY - stickDrag.cy, stickDrag.radius);
      touchState.move = { forward: v.forward, strafe: v.strafe, running: v.running };
      knob.style.transform = `translate(${v.clampedX}px, ${v.clampedY}px)`;
    });
    const endStick = (e) => {
      if (!stickDrag || e.pointerId !== stickDrag.id) return;
      stickDrag = null;
      touchState.move = { forward: 0, strafe: 0, running: false };
      knob.style.transform = '';
    };
    stickZone.addEventListener('pointerup', endStick);
    stickZone.addEventListener('pointercancel', endStick);

    let lookDrag = null;
    lookZone.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      lookDrag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      lookZone.setPointerCapture?.(e.pointerId);
    });
    lookZone.addEventListener('pointermove', (e) => {
      if (!lookDrag || e.pointerId !== lookDrag.id) return;
      const s = api._shellContext?.settings;
      const sens = 0.0055 * (s?.sensitivity ?? 1);
      touchState.addLook(e.clientX - lookDrag.x, e.clientY - lookDrag.y, sens, !!s?.invertY);
      lookDrag.x = e.clientX;
      lookDrag.y = e.clientY;
    });
    const endLook = (e) => { if (lookDrag && e.pointerId === lookDrag.id) lookDrag = null; };
    lookZone.addEventListener('pointerup', endLook);
    lookZone.addEventListener('pointercancel', endLook);

    const triggerKey = (code) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true }));
      setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true })), 70);
    };
    const b = () => api._shellContext?.settings?.bindings ?? {};
    const actBtn = (id, label, fn) => el('button', {
      type: 'button', id: `touch-${id}`, class: 'touch-btn', onclick: fn, text: label,
    });

    const buttons = el('div', { class: 'touch-actions', role: 'group', 'aria-label': 'Touch actions' },
      actBtn('attack', 'Attack', () => document.querySelector('#hud-bar [data-action="attack"]')?.click()),
      actBtn('use', 'Use', () => document.getElementById('hud-use-btn')?.click()),
      actBtn('ready', 'Ready', () => document.getElementById('hud-ready-btn')?.click()),
      actBtn('jump', 'Jump', () => triggerKey(b().jump || 'KeyZ')),
      actBtn('crouch', 'Crouch', () => triggerKey(b().crouch || 'KeyX')),
      actBtn('map', 'Map', () => api.togglePanel('automap')));

    overlay = el('div', { id: 'hud-touch', class: 'touch-overlay', hidden: true }, stickZone, lookZone, buttons);
    hud.append(overlay);
    return overlay;
  }

  function syncOverlay() {
    if (typeof document === 'undefined') return;
    const enabled = api._shellContext?.settings?.touchControls === true || isTouchDevice();
    const show = enabled && api.screen === 'game' && !api.modalOpen;
    if (!show) {
      touchState.reset();
      if (overlay) overlay.hidden = true;
      return;
    }
    const ov = ensureOverlay();
    if (ov) ov.hidden = false;
  }

  attachZipLoader();
  api.on('screen', syncOverlay);
  api.on('panel', syncOverlay);
  api.on('settingsChanged', syncOverlay);
  if (typeof window !== 'undefined') queueMicrotask(syncOverlay);

  api.touch = {
    state: touchState,
    extractArena2FromZip,
    syncOverlay,
  };
  return api.touch;
}

export default { name: 'touch', install };
