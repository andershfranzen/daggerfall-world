// Character portraits from the player's own game files.
//
// renderPortrait({race, gender, faceIndex, size}) returns an element right away:
//   - the classic head (FACE??I0.CIF record faceIndex with ART_PAL.COL, see ./portraits.js) when
//     it has been decoded, drawn pixel-sharp at an integer scale;
//   - a short "Loading portrait" state that fills in place once the bytes are decoded;
//   - an accessible "Portrait unavailable" state when the files are missing or unreadable.
// There is no drawn substitute: the project ships no game art and does not imitate it.
// Call setPortraitFiles(files) with the ARENA2 File list (api.files / the 'assets' event).

import { indexFiles } from '../../world/files.js';
import { faceSource, decodeFace, parsePalette, FACE_FRAME, PALETTE_FILE } from './portraits.js';

let provider = null;
let index = null;
let bytes = new Map(); // file name -> Promise<Uint8Array|null>
let palette = null; // Promise<Uint8Array|null>
const decoded = new Map(); // "FILE#record" -> {width,height,rgba} | null (unreadable)
let generation = 0;

/** Optional override: fn({race, gender, faceIndex, size}) → HTMLElement | null (null falls through). */
export function setPortraitProvider(fn) {
  provider = typeof fn === 'function' ? fn : null;
}

/** Point portraits at the player's ARENA2 files (iterable of File/Blob with names), or null. */
export function setPortraitFiles(files) {
  let next = null;
  try {
    next = files ? indexFiles(files) : null;
  } catch {
    next = null;
  }
  index = next && next.size ? next : null;
  bytes = new Map();
  palette = null;
  decoded.clear();
  generation++;
}

/** True when the palette and the head file for this choice are present. */
export function portraitAvailable(choice) {
  const src = faceSource(choice);
  return !!(src && index?.has(PALETTE_FILE) && index.has(src.file));
}

function read(name) {
  if (!bytes.has(name)) {
    const f = index?.get(name);
    bytes.set(name, f ? f.arrayBuffer().then((b) => new Uint8Array(b)).catch(() => null) : Promise.resolve(null));
  }
  return bytes.get(name);
}

function readPalette() {
  if (!palette) {
    palette = read(PALETTE_FILE).then((b) => {
      try {
        return b ? parsePalette(b, PALETTE_FILE) : null;
      } catch {
        return null;
      }
    });
  }
  return palette;
}

/** Decoded face for a choice, or null. Cached so re-renders draw synchronously. */
export async function loadFace(choice) {
  const src = faceSource(choice);
  if (!src || !portraitAvailable(choice)) return null;
  const key = `${src.file}#${src.record}`;
  if (decoded.has(key)) return decoded.get(key);
  const gen = generation;
  const [pal, cif] = await Promise.all([readPalette(), read(src.file)]);
  let face = null;
  try {
    face = pal && cif ? decodeFace(cif, src.record, pal) : null;
  } catch {
    face = null;
  }
  if (gen === generation) decoded.set(key, face);
  return face;
}

let stylesAdded = false;
function ensureStyles() {
  if (stylesAdded || typeof document === 'undefined' || !document.head) return;
  stylesAdded = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./portraits.css', import.meta.url).href;
  document.head.append(link);
}

/** Integer scale whose width is at least `size` CSS pixels (minimum 1x). */
export function portraitScale(size) {
  return Math.max(1, Math.ceil((Number(size) || FACE_FRAME.width) / FACE_FRAME.width));
}

function label({ race, gender, faceIndex }) {
  return `${gender} ${race}, face ${faceIndex + 1}`;
}

function paint(frame, face, choice) {
  const canvas = document.createElement('canvas');
  canvas.width = face.width;
  canvas.height = face.height;
  canvas.className = 'cc-portrait';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', label(choice));
  canvas.getContext('2d')?.putImageData(new ImageData(face.rgba, face.width, face.height), 0, 0);
  frame.classList.remove('is-loading', 'is-unavailable');
  frame.removeAttribute('role');
  frame.removeAttribute('aria-label');
  frame.replaceChildren(canvas);
}

function unavailable(frame, choice) {
  frame.classList.remove('is-loading');
  frame.classList.add('is-unavailable');
  frame.setAttribute('role', 'img');
  frame.setAttribute('aria-label', `${label(choice)}: portrait unavailable`);
  const text = document.createElement('span');
  text.className = 'cc-portrait-note';
  text.setAttribute('aria-hidden', 'true');
  text.textContent = 'Portrait unavailable';
  frame.replaceChildren(text);
}

/** Portrait element for a race/gender/face choice; `size` is the minimum CSS width. */
export function renderPortrait({ race = 'Breton', gender = 'Male', faceIndex = 0, size = 80 } = {}) {
  const choice = { race, gender, faceIndex };
  if (provider) {
    try {
      const custom = provider({ ...choice, size });
      if (custom) return custom;
    } catch (err) {
      console.warn('[character] portrait provider failed:', err);
    }
  }
  ensureStyles();
  const scale = portraitScale(size);
  const frame = document.createElement('span');
  frame.className = 'cc-portrait-frame';
  frame.style.width = `${FACE_FRAME.width * scale}px`;
  frame.style.height = `${FACE_FRAME.height * scale}px`;
  frame.dataset.face = String(faceIndex);

  const src = faceSource(choice);
  const key = src && `${src.file}#${src.record}`;
  if (key && decoded.has(key)) {
    const face = decoded.get(key);
    if (face) paint(frame, face, choice);
    else unavailable(frame, choice);
    return frame;
  }
  if (!portraitAvailable(choice)) {
    unavailable(frame, choice);
    return frame;
  }
  frame.classList.add('is-loading');
  frame.setAttribute('role', 'img');
  frame.setAttribute('aria-label', `${label(choice)}: loading portrait`);
  loadFace(choice).then((face) => (face ? paint(frame, face, choice) : unavailable(frame, choice)));
  return frame;
}
