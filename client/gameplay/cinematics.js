// Story, opening and death movies from the player's own ARENA2 .VID files.
//
// Cues:
//   server {kind:'questVideo', uid, title, video:n}        -> ANIM{n:0000}.VID (QBN "play video n", DFU PlayVideo)
//   server {kind:'questVideo', uid, title, sequence:'opening'} -> ANIM0000, ANIM0011, DAG2 (new-game cinematics)
//   own    {kind:'defeat', playerId:self}                   -> ANIM0012 (death). Its end, played through or skipped
//          (DaggerfallVidPlayerWindow: end of file, any key or back), sends combat.rise so the server resurrects the
//          player then; an own 'resurrect' first (a companion's help, the server's cap) ends it.
//   api.cinematics.play({sequence|video|files, title})      -> other features
// Files are decoded in the browser and never uploaded. A missing or unreadable file shows a labelled card
// for a few seconds and the queue moves on. Nothing here can hold up a quest step: the server has already
// advanced when the cue arrives.
//
// Controls: Space, Enter or click skips the current movie, and Esc skips the rest of the cue. Movement is held while a
// movie is on screen. The world keeps running for everyone else.

import { VidDecoder, SAMPLE_RATE, filesForCue, pcm8ToFloat } from './cinematics/vid.js';

export const name = 'cinematics';
const CHUNK = 256 * 1024;
const AUDIO_LEAD = 0.12; // seconds of audio scheduled ahead of the picture clock
const MISSING_CARD_MS = 3500;
// DFU PlayerDeath pauses input when the player dies, so keys held in the fight do not end the death movie at once.
export const DEATH_SKIP_GUARD_MS = 1000;

const CSS = `
.cine{position:fixed;inset:0;z-index:80;background:#000;display:grid;place-items:center;cursor:pointer;opacity:0;transition:opacity .25s linear}
.cine[data-on="true"]{opacity:1}
.cine canvas{--ar:1.3333;width:min(100vw,calc(100vh*var(--ar)));aspect-ratio:var(--ar);image-rendering:pixelated;image-rendering:crisp-edges;background:#000}
.cine-bar{position:absolute;left:0;right:0;bottom:0;display:flex;justify-content:space-between;gap:1rem;padding:.5rem 1rem;
  font:13px/1.3 var(--font-ui,system-ui,sans-serif);color:#b9c6d2;background:linear-gradient(transparent,rgba(3,6,10,.75));pointer-events:none}
.cine-bar b{color:#e6eef5;font-weight:600}
.cine-card{max-width:32rem;padding:1.25rem 1.5rem;border:1px solid #2b3a48;border-radius:6px;background:#0b1118;color:#c9d5e0;
  font:15px/1.45 var(--font-ui,system-ui,sans-serif);text-align:center}
.cine-card h2{margin:0 0 .4rem;font-size:17px;color:#e6eef5}
.cine-card code{color:#9fc3e6}
`;

function findFile(files, wanted) {
  const up = wanted.toUpperCase();
  for (const f of files ?? []) if (String(f?.name ?? '').toUpperCase() === up) return f;
  return null;
}

async function readSlice(file, start, end) {
  const part = typeof file.slice === 'function' ? file.slice(start, end) : null;
  if (part && typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer());
  const all = new Uint8Array(await file.arrayBuffer());
  return all.subarray(start, end);
}

export function install(api) {
  if (typeof document === 'undefined') return;
  const doc = document;
  if (!doc.querySelector('style[data-feature="cinematics"]')) {
    const style = doc.createElement('style');
    style.dataset.feature = 'cinematics';
    style.textContent = CSS;
    doc.head?.append(style);
  }

  const queue = [];
  let current = null; // { cue, files, index, stopFile, stopAll, label }
  const log = []; // recent outcomes for diagnostics and tests
  let root = null, canvas = null, ctx2d = null, bar = null, card = null;
  let heldMovement = false;

  function ensureRoot() {
    if (root) return;
    root = doc.createElement('div');
    root.className = 'cine';
    root.id = 'cinematic';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    canvas = doc.createElement('canvas');
    canvas.width = 320; canvas.height = 200;
    ctx2d = canvas.getContext('2d');
    bar = doc.createElement('div');
    bar.className = 'cine-bar';
    card = doc.createElement('div');
    card.className = 'cine-card';
    card.hidden = true;
    root.append(canvas, card, bar);
    root.addEventListener('click', () => skip(false));
    doc.body.append(root);
  }

  function show(on) {
    ensureRoot();
    if (on) {
      root.hidden = false;
      requestAnimationFrame(() => { root.dataset.on = 'true'; });
      if (!heldMovement) { heldMovement = true; api.movementLocked = true; }
      api.atmosphere?.engine?.duck?.(true);
    } else {
      root.dataset.on = 'false';
      root.hidden = true;
      if (heldMovement) { heldMovement = false; api.movementLocked = false; }
      api.atmosphere?.engine?.duck?.(false);
    }
  }

  function setBar(title, file, n, total) {
    const left = doc.createElement('span');
    const b = doc.createElement('b');
    b.textContent = title || 'Daggerfall';
    left.append(b, doc.createTextNode(total > 1 ? ` · ${file} (${n} of ${total})` : ` · ${file}`));
    const right = doc.createElement('span');
    right.textContent = total > 1 ? 'Space: next · Esc: skip all' : 'Space or Esc: skip';
    bar.replaceChildren(left, right);
  }

  /** A player's skip (key or click); `force` for the shell's own reasons (resurrected, left the game). */
  function skip(all, force = false) {
    if (!current) return;
    if (!force && current.cue?.source === 'defeat' && performance.now() - current.started < DEATH_SKIP_GUARD_MS) return;
    if (all) current.stopAll = true;
    current.stopFile = true;
    current.wake?.();
  }

  const onKey = (e) => {
    if (!current) return;
    if (e.repeat && (e.code === 'Space' || e.code === 'Enter' || e.code === 'Escape')) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.code === 'Escape') skip(true);
    else if (e.code === 'Space' || e.code === 'Enter') skip(false);
    else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  globalThis.addEventListener?.('keydown', onKey, true);

  function audioOut() {
    const engine = api.atmosphere?.engine;
    const ac = engine?.ctx;
    if (!ac || ac.state !== 'running') return null;
    return { ac, dest: engine.bus?.master ?? ac.destination };
  }

  const sleep = (ms, c) => new Promise((res) => {
    const t = setTimeout(res, ms);
    c.wake = () => { clearTimeout(t); res(); };
  });

  /** Play one file. Resolves to an outcome string. */
  async function playFile(c, fileName) {
    const file = findFile(api.files, fileName);
    if (!file) return 'missing';
    const dec = new VidDecoder();
    let offset = 0;
    const size = Number(file.size) || 0;
    let reading = null;
    const pump = () => {
      if (reading || dec.complete) return reading;
      if (offset >= size) { dec.finish(); return null; }
      const end = Math.min(size, offset + CHUNK);
      reading = readSlice(file, offset, end).then((bytes) => { dec.feed(bytes); offset = end; if (offset >= size) dec.finish(); reading = null; });
      return reading;
    };
    // Header and palette.
    while (!dec.header) {
      if (dec.complete) return 'unreadable';
      await pump();
    }
    canvas.width = dec.width; canvas.height = dec.height;
    // 320x200 fills a 4:3 screen, so classic pixels are 5:6 (taller than wide). DAG2's 256 columns keep that shape.
    canvas.style.setProperty('--ar', ((dec.width * 5) / (dec.height * 6)).toFixed(4));
    const image = new ImageData(dec.rgba, dec.width, dec.height);
    const out = audioOut();
    const t0 = performance.now() / 1000;
    const a0 = out ? out.ac.currentTime + AUDIO_LEAD : 0;
    let audioAt = 0; // seconds of audio scheduled
    let frameAt = 0; // presentation time of the next frame
    const sources = [];
    let firstFrame = null;
    try {
      while (!c.stopFile) {
        const r = dec.next();
        if (!r) {
          if (dec.ended) break;
          await pump();
          continue;
        }
        if (offset - dec.pos < CHUNK) pump(); // read ahead while decoding
        if (r.audio && out) {
          const buf = out.ac.createBuffer(1, r.audio.length, SAMPLE_RATE);
          pcm8ToFloat(r.audio, buf.getChannelData(0));
          const src = out.ac.createBufferSource();
          src.buffer = buf;
          src.connect(out.dest);
          src.start(a0 + audioAt);
          audioAt += r.audio.length / SAMPLE_RATE;
          sources.push(src);
          if (sources.length > 64) sources.shift();
        }
        if (r.frame) {
          const wait = t0 + frameAt - performance.now() / 1000;
          if (wait > 0.004) await sleep(wait * 1000, c);
          if (c.stopFile) break;
          ctx2d.putImageData(image, 0, 0);
          if (firstFrame === null) firstFrame = performance.now() / 1000 - t0;
          frameAt += r.delay;
        }
      }
    } finally {
      if (c.stopFile) for (const s of sources) { try { s.stop(); } catch { /* not started */ } }
    }
    c.stats = { file: fileName, frames: dec.frames, of: dec.frameCount, firstFrameMs: firstFrame === null ? null : Math.round(firstFrame * 1000), audio: !!out };
    return c.stopFile ? 'skipped' : 'played';
  }

  async function showMissing(c, fileName, reason) {
    ensureRoot();
    canvas.hidden = true;
    card.hidden = false;
    const h = doc.createElement('h2');
    h.textContent = reason === 'missing' ? 'Movie not installed' : 'Movie could not be read';
    const p = doc.createElement('p');
    const code = doc.createElement('code');
    code.textContent = fileName;
    p.append(reason === 'missing' ? 'Your ARENA2 folder has no ' : 'Your copy of ', code,
      reason === 'missing' ? ', so this scene is skipped. The story continues.' : ' could not be decoded, so this scene is skipped.');
    card.replaceChildren(h, p);
    await sleep(MISSING_CARD_MS, c);
    card.hidden = true;
    canvas.hidden = false;
  }

  async function run() {
    if (current) return;
    while (queue.length) {
      const cue = queue.shift();
      const files = filesForCue(cue);
      if (!files.length) { log.push({ cue, outcome: 'unknown-cue' }); continue; }
      const c = { cue, files, stopFile: false, stopAll: false, started: performance.now() };
      current = c;
      show(true);
      ctx2d.fillStyle = '#000';
      ctx2d.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < files.length && !c.stopAll; i++) {
        c.stopFile = false;
        setBar(cue.title, files[i], i + 1, files.length);
        let outcome;
        try { outcome = await playFile(c, files[i]); } catch (e) { outcome = 'unreadable'; c.error = e.message; }
        if (outcome === 'missing' || outcome === 'unreadable') await showMissing(c, files[i], outcome);
        log.push({ file: files[i], outcome, ...(c.stats ?? {}), ...(c.error ? { error: c.error } : {}), at: Date.now() });
        c.stats = null; c.error = null;
        if (log.length > 40) log.shift();
      }
      current = null;
      if (!queue.length) show(false);
      api.emit?.('cinematicEnd', { cue });
      // The death movie is over (played, skipped or missing): get up now, as DFU leaves the movie for the title.
      if (cue.source === 'defeat' && !c.risenElsewhere) api.act?.('combat.rise');
    }
  }

  function play(cue) {
    if (!cue || typeof cue !== 'object') return false;
    if (!filesForCue(cue).length) return false;
    queue.push({ ...cue });
    run();
    return true;
  }

  api.cinematics = {
    play,
    skip: () => skip(true, true),
    get playing() { return current?.cue ?? null; },
    log,
    installed: () => [...(api.files ?? [])].map((f) => String(f.name).toUpperCase()).filter((n) => n.endsWith('.VID')).sort(),
  };

  api.on('event', (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'questVideo') {
      play({ sequence: typeof ev.sequence === 'string' ? ev.sequence : undefined, video: ev.video, title: ev.title, uid: ev.uid, source: 'quest' });
      return;
    }
    const self = api.selfId != null && String(ev.playerId) === String(api.selfId);
    if (self && ev.kind === 'defeat') play({ sequence: 'death', title: 'You have fallen', source: 'defeat' });
    if (self && ev.kind === 'resurrect' && current?.cue?.source === 'defeat') { current.risenElsewhere = true; skip(true, true); }
  });
  api.on('screen', (s) => {
    const name2 = typeof s === 'string' ? s : s?.screen;
    if (name2 && name2 !== 'game' && current) skip(true, true);
  });
}

export default { name, install };
