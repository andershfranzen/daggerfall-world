// Riding a horse: HUD control, first-person horse and movement prediction
// (server rules: server/rpg/mount.js; shared rules: client/gameplay/mount/rules.js).
//
// - A "Ride" button in the action bar and the H key send `mount.ride`. The button shows only
//   while the character owns a horse; indoors it stays visible but disabled with the reason.
// - While riding, the classic first-person horse (MRED00I0.CFA from the player's own ARENA2,
//   drawn as TransportManager does: centred, bottom aligned, scaled by screen height, 0.8 squash,
//   8 frames a second while moving) sits behind the weapon, the eye rises to a rider's height and
//   the local prediction moves at the server's mounted speed.
// - Other players' mount/dismount events become a short message; their sprites ride the horse flat
//   through client/gameplay/actors.js.

import { indexFiles } from '../world/files.js';
import { parsePalette } from '../world/textures.js';
import { readBlob } from '../world/bsa.js';
import { decodeCfa, HORSE_CFA, CART_CFA, CFA_PALETTE, RIDE_FRAME_SECONDS } from './mount/cfa.js';
import { horseOf, cartOf, defaultRideMode, isOutdoors, isRiding, mountedSpeed, rideModeOf, rideRefusal, RIDE_EYE_LIFT } from './mount/rules.js';

export const MOUNT_KEY = 'KeyH';

const STYLE = `
canvas.fp-horse{position:fixed;left:50%;bottom:0;transform:translateX(-50%);pointer-events:none;
  image-rendering:pixelated;z-index:0;height:calc(105 / 200 * 100dvh);width:calc(106 * .8 / 200 * 100dvh)}
canvas.fp-horse[hidden]{display:none}
#hud-ride-btn[aria-disabled=true]{opacity:.55}
`;

export function install(api) {
  const S = {
    art: null, // {width,height,frames:ImageData[]}
    artFor: null, // files the art was read from
    artName: null, // MRED00I0.CFA (horse) or MRED01I0.CFA (cart)
    artError: null,
    canvas: null,
    ctx2d: null,
    shownFrame: -1,
    clock: 0,
    pending: false,
    raised: false, // journey camera on screen
    inJourney: false,
  };
  const doc = globalThis.document;
  const character = () => api.state?.character ?? null;
  const riding = () => { const c = character(); return !!c && isRiding(c); };

  // ------------------------------------------------------------------ prediction and eye

  // api.state.character is the whole rpg record; its `character` holds the sheet (attributes).
  api.moveSpeed = () => (riding() ? mountedSpeed(character()) : null);
  const artName = () => (rideModeOf(character()) === 'cart' ? CART_CFA : HORSE_CFA);

  (api.viewTransforms ||= []).push((camera, f) => {
    const on = riding();
    if (on && f?.moving && !S.inJourney) S.clock += f.dt ?? 0;
    drawHorse(on && !S.inJourney, on && f?.moving && !S.inJourney);
    return on && !S.raised ? { ...camera, y: camera.y + RIDE_EYE_LIFT } : camera;
  });

  // ------------------------------------------------------------------ first-person art

  async function loadArt() {
    const files = api.files ? [...api.files] : [];
    const want = artName();
    if (S.artFor === api.files && S.artName === want) return;
    S.artFor = api.files;
    S.artName = want;
    S.art = null;
    S.artError = null;
    S.shownFrame = -1;
    if (!files.length) return;
    try {
      const index = indexFiles(files);
      const cfa = index.get(want), pal = index.get(CFA_PALETTE);
      if (!cfa || !pal) throw new Error(`${cfa ? CFA_PALETTE : want} is not in your Daggerfall files`);
      const [bytes, palBytes] = await Promise.all([readBlob(cfa, 0, cfa.size), readBlob(pal, 0, pal.size)]);
      const img = decodeCfa(bytes, want);
      const palette = parsePalette(palBytes, CFA_PALETTE);
      const frames = img.frames.map((idx) => {
        const rgba = new Uint8ClampedArray(img.width * img.height * 4);
        for (let i = 0; i < idx.length; i++) {
          const c = idx[i];
          if (!c) continue;
          rgba[i * 4] = palette[c * 3]; rgba[i * 4 + 1] = palette[c * 3 + 1]; rgba[i * 4 + 2] = palette[c * 3 + 2]; rgba[i * 4 + 3] = 255;
        }
        return new ImageData(rgba, img.width, img.height);
      });
      if (S.artFor === api.files && S.artName === want) S.art = { width: img.width, height: img.height, frames };
    } catch (err) {
      S.artError = err?.message ?? String(err);
      console.warn('[mount] first-person horse unavailable:', S.artError);
    }
  }

  function ensureCanvas() {
    if (S.canvas || !doc?.createElement) return S.canvas;
    if (!doc.getElementById('mount-style')) {
      const style = doc.createElement('style');
      style.id = 'mount-style';
      style.textContent = STYLE;
      doc.head?.append(style);
    }
    const c = doc.createElement('canvas');
    c.className = 'fp-horse';
    c.hidden = true;
    c.setAttribute('aria-hidden', 'true');
    // Behind the first-person weapon (DFU draws the horse first), above the 3D view.
    const weapon = doc.querySelector('canvas.fp-weapon');
    if (weapon?.parentNode) weapon.parentNode.insertBefore(c, weapon);
    else doc.body?.append(c);
    S.canvas = c;
    S.ctx2d = c.getContext('2d');
    return c;
  }

  function drawHorse(show, moving) {
    if (show && S.artName !== artName()) loadArt();
    const visible = show && api.screen === 'game' && !!S.art;
    if (!visible) {
      if (S.canvas && !S.canvas.hidden) S.canvas.hidden = true;
      if (show && !S.art && !S.artError) loadArt();
      return;
    }
    const c = ensureCanvas();
    if (!c) return;
    if (c.width !== S.art.width) { c.width = S.art.width; c.height = S.art.height; S.shownFrame = -1; }
    const n = S.art.frames.length;
    const frame = moving ? Math.floor(S.clock / RIDE_FRAME_SECONDS) % n : 0;
    if (frame !== S.shownFrame) {
      S.ctx2d.clearRect(0, 0, c.width, c.height);
      S.ctx2d.putImageData(S.art.frames[frame], 0, 0);
      S.shownFrame = frame;
    }
    if (c.hidden) c.hidden = false;
  }

  // ------------------------------------------------------------------ control

  async function toggle() {
    if (S.pending) return;
    const c = character();
    if (!c) return;
    const on = !riding();
    if (on) {
      const why = rideRefusal(c, defaultRideMode(c) ?? 'horse');
      if (why) { api.message(why, { kind: 'error' }); return; }
    }
    S.pending = true;
    refresh();
    try {
      await api.act('mount.ride', { on });
    } finally {
      S.pending = false;
      refresh();
    }
  }

  let button = null;
  function ensureButton() {
    if (button || !doc?.getElementById) return button;
    const bar = doc.getElementById('hud-bar');
    if (!bar) return null;
    button = doc.createElement('button');
    button.type = 'button';
    button.className = 'bar-btn';
    button.id = 'hud-ride-btn';
    button.hidden = true;
    button.setAttribute('aria-pressed', 'false');
    const name = doc.createElement('span');
    name.className = 'bar-name';
    const kbd = doc.createElement('kbd');
    kbd.textContent = 'H';
    button.append(name, kbd);
    button.addEventListener('click', (e) => {
      e.preventDefault();
      if (button.getAttribute('aria-disabled') === 'true') {
        const c = character() ?? {};
        const why = rideRefusal(c, defaultRideMode(c) ?? 'horse');
        if (why) api.message(why, { kind: 'error' });
        return;
      }
      toggle();
    });
    const sep = bar.querySelector('.bar-sep');
    bar.insertBefore(button, sep ?? null);
    const help = doc.getElementById('hud-help-list');
    if (help && !help.querySelector('[data-mount-help]')) {
      const dt = doc.createElement('dt');
      dt.textContent = 'H';
      dt.dataset.mountHelp = '';
      const dd = doc.createElement('dd');
      dd.textContent = 'Mount your horse or drive your cart, or get down (outdoors)';
      help.append(dt, dd);
    }
    return button;
  }

  function refresh() {
    const b = ensureButton();
    if (!b) return;
    const c = character();
    const owns = !!c && (!!horseOf(c) || !!cartOf(c));
    const on = riding();
    b.hidden = !owns && !on;
    if (b.hidden) return;
    const outside = isOutdoors(c?.location);
    const disabled = S.pending || (!on && (!outside || !!c?.defeated));
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-disabled', String(disabled));
    const cart = on ? rideModeOf(c) === 'cart' : defaultRideMode(c) === 'cart';
    b.title = on ? (cart ? 'Leave the cart (H)' : 'Dismount (H)') : outside ? (cart ? 'Drive your cart (H)' : 'Mount your horse (H)') : 'You cannot change transportation indoors.';
    b.dataset.mode = cart ? 'cart' : 'horse';
    const label = on ? 'Dismount' : cart ? 'Cart' : 'Ride';
    const name = b.querySelector('.bar-name');
    if (name.textContent !== label) name.textContent = label;
  }

  // ------------------------------------------------------------------ events

  globalThis.addEventListener?.('keydown', (e) => {
    if (e.code !== MOUNT_KEY || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable) return;
    if (doc?.body?.dataset.screen !== 'game' || api.modalOpen || api.movementLocked) return;
    const c = character();
    if (!c || (!horseOf(c) && !cartOf(c) && !riding())) return;
    e.preventDefault();
    toggle();
  });

  api.on('assets', () => { S.artFor = null; if (riding()) loadArt(); });
  api.on('state', refresh);
  api.on('screen', () => { refresh(); if (api.screen !== 'game' && S.canvas) S.canvas.hidden = true; });
  api.on('event', (ev) => {
    if (!ev || ev.kind !== 'mount') return;
    if (String(ev.playerId) === String(api.selfId)) {
      if (ev.mounted) loadArt(); // the shell shows ev.text itself
    } else if (ev.name) {
      api.message(`${ev.name} ${ev.mounted ? (ev.mode === 'cart' ? 'drives a cart' : 'mounts a horse') : 'dismounts'}.`);
    }
    refresh();
  });
  api.on('journey', (j) => {
    S.raised = !!j?.raised;
    S.inJourney = !!(j && j.phase && j.phase !== 'done');
    if (S.inJourney && S.canvas) S.canvas.hidden = true;
  });

  refresh();
  return {
    toggle,
    get riding() { return riding(); },
    get artReady() { return !!S.art; },
    get artError() { return S.artError; },
    get artName() { return S.art ? S.artName : null; },
  };
}
