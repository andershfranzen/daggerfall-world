// Daggerfall World — HUD enhancements (presentation only).
// Loaded after /main.js. Never sends game input and never owns state. Behaviour:
//  1. Builds a bearing ribbon in #hud-compass, driven by window 'game:heading'.
//  2. Shows a short arrival title with the real town name on entering the game.

import { installGameArt } from './game-art.js';

installGameArt(globalThis.dfwGame);

const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ------------------------------------------------------------ compass ribbon

function buildCompass(root) {
  if (!root || root.querySelector('.compass-strip')) return null;
  const strip = document.createElement('div');
  strip.className = 'compass-strip';
  const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
  const frag = document.createDocumentFragment();
  // Cover −180°…540° so the visible window (±~90°) never runs off the strip for yaw in [0, 360).
  for (let d = -180; d <= 540; d += 15) {
    const bearing = ((d % 360) + 360) % 360;
    const mark = document.createElement('span');
    mark.className = 'compass-mark';
    mark.style.setProperty('--d', String(d));
    const name = names[bearing];
    if (name) {
      mark.textContent = name;
      mark.classList.add(name.length === 1 ? 'cardinal' : 'inter');
      if (bearing === 0) mark.classList.add('north');
    } else {
      mark.classList.add('minor');
    }
    frag.append(mark);
  }
  strip.append(frag);
  root.prepend(strip);
  root.classList.add('has-ribbon');
  return strip;
}

const compass = $('hud-compass');
const strip = buildCompass(compass);
if (strip) {
  let pending = null;
  let frame = 0;
  const apply = () => {
    frame = 0;
    // yaw: radians, 0 = north, positive clockwise. Map to [0, 360).
    const deg = ((((pending % TAU) + TAU) % TAU) * 180) / Math.PI;
    compass.style.setProperty('--yaw', deg.toFixed(2));
  };
  window.addEventListener('game:heading', (e) => {
    const yaw = Number(e.detail?.yaw);
    if (!Number.isFinite(yaw)) return;
    pending = yaw;
    if (!frame) frame = requestAnimationFrame(apply);
  });
}

// ------------------------------------------------------------ arrival title

let arrivalEl = null;
let lastScreen = document.body.dataset.screen;

function showArrival(location, tries = 0) {
  if (reduceMotion.matches || document.body.dataset.screen !== 'game' || location !== globalThis.dfwGame?.location) return;
  const town = $('hud-town')?.textContent.trim();
  // main.js shows a placeholder ("Entering the world…") until the first snapshot names the place.
  if (!town || town.endsWith('…')) {
    if (tries < 20) setTimeout(() => showArrival(location, tries + 1), 250);
    return;
  }
  arrivalEl?.remove();
  arrivalEl = document.createElement('div');
  arrivalEl.className = 'hud-arrival';
  arrivalEl.setAttribute('aria-hidden', 'true'); // the chat log announces the arrival
  const small = document.createElement('small');
  small.textContent = 'You arrive in';
  const strong = document.createElement('strong');
  strong.textContent = town;
  arrivalEl.append(small, strong);
  arrivalEl.addEventListener('animationend', () => arrivalEl?.remove(), { once: true });
  document.body.append(arrivalEl);
}

window.addEventListener('game:screen', (e) => {
  const screen = e.detail?.screen;
  if (screen === 'game' && lastScreen !== 'game') {
    // main.js sets the town name around the screen switch; read it on the next frame.
    const location = globalThis.dfwGame?.location;
    requestAnimationFrame(() => showArrival(location));
  } else if (screen !== 'game') {
    arrivalEl?.remove();
    arrivalEl = null;
  }
  lastScreen = screen;
});

globalThis.dfwGame?.on('location', () => arrivalEl?.remove());
