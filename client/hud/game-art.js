// ARENA2 HUD and menu art. Button and compass coordinates are from Daggerfall Unity's
// Game/UserInterface/HUDLarge.cs and HUDCompass.cs (MIT, © 2009–2023 Daggerfall Workshop).
import { artCanvas, ClassicUiArt } from './classic-art.js';

const MAIN = 'MAIN00I0.IMG';
const PICTURES = Object.freeze({
  ready: [MAIN, [225, 0, 47, 23]],
  use: ['MAIN01I0.IMG', [0, 46, 47, 23]],
  inventory: [MAIN, [178, 0, 47, 23]],
  spellbook: [MAIN, [84, 0, 47, 23]],
  map: [MAIN, [178, 23, 47, 23]],
  rest: [MAIN, [225, 23, 47, 23]],
  journal: ['LGBK00I0.IMG', [0, 0, 320, 181], true],
  automap: ['AMAP00I0.IMG', [78, 171, 27, 19]],
  'floor-down': ['AMAP00I0.IMG', [258, 171, 21, 19]],
  'floor-up': ['AMAP00I0.IMG', [237, 171, 21, 19]],
  west: ['TRAVDI05.IMG', null, true],
  east: ['TRAVCI05.IMG', null, true],
  // Authentic 1996 Daggerfall cracked grey granite (INVE00I0) and oxidized verdigris marble (POPU00I0).
  stone: ['INVE00I0.IMG', [52, 18, 102, 168]],
  marble: ['POPU00I0.IMG', [12, 10, 120, 44]],
});

export function installGameArt(api) {
  if (!api) return;
  const root = document.documentElement;
  const compass = document.getElementById('hud-compass');
  const bar = document.getElementById('hud-bar');
  if (bar && typeof ResizeObserver !== 'undefined') {
    const resize = new ResizeObserver(() => {
      if (bar.offsetHeight) root.style.setProperty('--hud-bar-height', `${bar.offsetHeight}px`);
    });
    resize.observe(bar);
  }
  const dial = document.createElement('canvas');
  dial.className = 'classic-compass';
  dial.hidden = true;
  compass?.append(dial);

  let source;
  let sourceFiles;
  let strip;
  let box;
  let yaw = 0;
  let lastScroll = -1;
  let headKey;
  let headRequest = 0;

  function paintCompass() {
    if (!strip || !box) return;
    const turns = yaw / (2 * Math.PI);
    const scroll = Math.floor(258 * (turns - Math.floor(turns)));
    if (scroll === lastScroll) return;
    lastScroll = scroll;
    const ctx = dial.getContext('2d');
    ctx.clearRect(0, 0, dial.width, dial.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(strip, scroll, 0, 64, strip.height, 2, 2, box.width - 4, strip.height);
    ctx.drawImage(box, 0, 0);
  }

  async function updatePortrait() {
    const ch = api.state?.character?.character;
    const key = ch ? `${ch.race}/${ch.gender}/${ch.faceIndex}` : null;
    if (key === headKey) return;
    headKey = key;
    const request = ++headRequest;
    root.style.removeProperty('--classic-character');
    root.classList.remove('has-classic-character');
    if (!ch?.race) return;
    const { loadFace } = await import('../gameplay/character/art.js');
    const face = await loadFace(ch);
    if (request !== headRequest || !face) return;
    const canvas = artCanvas(face.width, face.height, face.rgba);
    root.style.setProperty('--classic-character', `url("${canvas.toDataURL()}")`);
    root.classList.add('has-classic-character');
  }

  async function updateFiles(files) {
    if (source && files === sourceFiles) return;
    sourceFiles = files;
    const art = new ClassicUiArt(files);
    source = art;
    dial.hidden = true;
    compass?.classList.remove('has-classic-compass');
    strip = box = null;
    lastScroll = -1;
    headKey = undefined;
    headRequest++;
    // The character feature handles the same synchronous assets event and indexes faces.
    queueMicrotask(updatePortrait);
    for (const [key, spec] of Object.entries(PICTURES)) {
      const prop = `--classic-${key}`;
      root.style.removeProperty(prop);
      root.classList.remove(`has-classic-${key}`);
      art.picture(...spec).then((image) => {
        if (source !== art || !image) return;
        root.style.setProperty(prop, `url("${image.toDataURL()}")`);
        root.classList.add(`has-classic-${key}`);
      });
    }
    const [newStrip, newBox] = await Promise.all([
      art.picture('COMPASS.IMG'), art.picture('COMPBOX.IMG', null, true),
    ]);
    if (source !== art || newStrip?.width !== 322 || newBox?.width !== 69) return;
    strip = newStrip;
    box = newBox;
    dial.width = box.width;
    dial.height = box.height;
    paintCompass();
    dial.hidden = false;
    compass?.classList.add('has-classic-compass');
  }

  api.on('assets', updateFiles);
  api.on('state', updatePortrait);
  window.addEventListener('game:heading', (e) => {
    if (!Number.isFinite(e.detail?.yaw)) return;
    yaw = e.detail.yaw;
    paintCompass();
  });
  updateFiles(api.files);
}
