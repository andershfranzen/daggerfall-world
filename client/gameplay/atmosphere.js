// Browser side of the shared world clock, weather, resting, and the player's own
// Daggerfall sound effects and music.
//
//  - Clock: the server sends {kind:'clock', minutes, minutesPerSecond, weather, ...} on
//    join, on every game hour, and on location or weather change; this module
//    interpolates between them. Before the first message it computes the same clock
//    locally from the shared epoch (atmosphere/calendar.js).
//  - Light: a small adapter on the 'frame' event tints the renderer's sky palette, moves
//    its sun, shortens fog in bad weather, and lays a multiply-blend shade over the
//    canvas at night. Everything is restored when leaving the game screen.
//  - Weather: rain and snow are drawn on a screen-space canvas over the 3D view; storms
//    flash and roll thunder.
//  - Rest: panel 'rest' sends rest.start / rest.stop; the server owns recovery.
//  - Audio: panel 'audio' controls volumes, mute and the music arrangement, persisted in
//    localStorage. Clips come from the player's ARENA2/DAGGER.SND and songs from
//    ARENA2/MIDI.BSA; nothing is shipped or synthesised in place of a missing archive.

import {
  dateFromMinutes, formatDate, formatTime, regionOf, isIndoors, isSnowFreeClimate,
  weatherAt, recoveryPerHour, WORLD_EPOCH_MS, DEFAULT_TIME_SCALE, CLASSIC_GAME_START_TIME, MINUTES_PER_DAY,
} from './atmosphere/calendar.js';
import { AudioEngine } from './atmosphere/engine.js';
import { regionOfPlace, climateOfPlace } from './travel/catalog.js';
import { loadPrefs, savePrefs } from './atmosphere/prefs.js';
import { sceneKind, chooseSong, clipsForEvent, ambienceFor, footstepClips, creatureClip, mechanismClip, hearingRadius, CREATURE_ATTRACT, CLIP } from './atmosphere/playlists.js';
import { lightFor, restoreLight, heldLightRadius, gutter } from './atmosphere/light.js';
import { WeatherLayer } from './atmosphere/weather.js';
import { cityGatesClosed } from '../world/cityGates.js';
import { seaSound } from './sailing/sound.js';

const DEFAULT_LOCATION = 'town:Daggerfall/Gothway Garden';
const STEP_DISTANCE = 2.1;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

function loadCss() {
  if (document.querySelector('link[data-feature="atmosphere"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./atmosphere.css', import.meta.url).href;
  link.dataset.feature = 'atmosphere';
  document.head.append(link);
}

export function install(api) {
  if (typeof document === 'undefined') return;
  loadCss();
  const storage = (() => { try { return globalThis.localStorage; } catch { return null; } })();
  let prefs = loadPrefs(storage);
  const engine = new AudioEngine({ prefs });

  // ------------------------------------------------------------ state

  const clock = { minutes: null, at: 0, rate: DEFAULT_TIME_SCALE / 60, info: null };
  let rest = null; // {mode, hoursDone, hoursPlanned}
  let restLog = '';
  let restHours = 8;
  let screen = api.screen ?? 'landing';
  let lastCam = null;
  let stepAcc = 0;
  let stepFoot = 0;
  let nextAmbient = 0;
  let lastSceneKey = '';
  let flash = 0;
  let lastLight = null;
  let lastStep = null;
  let lastCreature = null;
  let lastMechanism = null;
  let vessel = null;
  let lastSeaImpact = -Infinity;

  const location = () => api.location ?? api.state?.character?.location ?? DEFAULT_LOCATION;
  const nowMinutes = () => {
    if (clock.minutes === null) return CLASSIC_GAME_START_TIME + (Math.max(0, Date.now() - WORLD_EPOCH_MS) / 1000) * (DEFAULT_TIME_SCALE / 60);
    return clock.minutes + ((performance.now() - clock.at) / 1000) * clock.rate;
  };
  api.worldMinutes = nowMinutes;
  /** The server's clock event describes this place (older servers send no location: compare regions). */
  const serverDescribes = (loc) => !!clock.info && clock.info.indoors === isIndoors(loc)
    && (clock.info.location !== undefined ? clock.info.location === loc : clock.info.region === regionOf(loc));
  /**
   * Weather region of a place before the server's clock event for it arrives: the same political lookup
   * the server uses (POLITIC.PAK for a wilderness pixel, from the travel map data); while that data is
   * still loading, the last region the server named for an outdoor place, so a walk across a town edge
   * never changes the sky.
   */
  const regionHere = (loc) => regionOfPlace(loc, api.travelWorld?.() ?? null)
    ?? (loc.startsWith('wilderness:') && clock.info?.region ? clock.info.region : regionOf(loc));
  const climateHere = (loc) => (serverDescribes(loc) ? clock.info.climate : null)
    ?? climateOfPlace(loc, api.travelWorld?.());
  const weatherNow = () => {
    const loc = location();
    if (serverDescribes(loc)) {
      return { type: clock.info.weather, label: clock.info.weatherLabel, intensity: clock.info.weatherIntensity ?? 0.7 };
    }
    return weatherAt(regionHere(loc), Math.floor(nowMinutes()), loc, climateHere(loc));
  };
  // Package 21: light sources other features register from the client, and the movement owner's signals.
  const lightSources = new Map();
  let frameMovement = null;
  const movement = () => api.movement ?? frameMovement ?? null;
  const characterNow = () => api.character ?? api.state?.character ?? null;
  // Package 7's rpg.lightSource {radius, condition}: guttering below 3 condition, as DFU's player torch.
  let gutterG = 0;
  const litRadius = () => {
    const c = characterNow();
    const src = c?.lightSource ?? null;
    const g = gutter(src, gutterG);
    gutterG = g.g;
    if (g.scale === 1) return heldLightRadius(c, [...lightSources.values()]);
    const others = heldLightRadius({ ...c, lightSource: null }, [...lightSources.values()]);
    return Math.max(others, heldLightRadius({ lightSource: src }) * g.scale);
  };
  const sceneInfo = () => {
    const minutes = nowMinutes();
    const date = dateFromMinutes(minutes);
    const w = weatherNow();
    const loc = location();
    const indoors = isIndoors(loc);
    const mv = movement();
    return {
      minutes, date, weather: w.type, weatherLabel: w.label, intensity: w.intensity, indoors, night: date.isNight,
      kind: sceneKind(loc, { night: date.isNight, weather: w.type }), season: date.season,
      snowFree: isSnowFreeClimate(climateHere(loc)),
      underwater: !!mv?.underwater, swimming: !!mv?.swimming, wading: !!mv?.wading, surface: vessel ? 'wood' : mv?.surface ?? null,
      atSea: !!vessel,
      lightRadius: litRadius(),
    };
  };

  // ------------------------------------------------------------ HUD chip

  const chip = el('div', { id: 'atmo-chip', class: 'atmo-chip', hidden: true });
  const chipTime = el('button', { type: 'button', class: 'atmo-chip-time', 'aria-label': 'Date, weather and rest', title: 'Date, weather and rest (R)', onclick: () => api.openPanel('rest') });
  const chipAudio = el('button', { type: 'button', class: 'atmo-chip-audio', 'aria-label': 'Sound and music', title: 'Sound and music', onclick: () => api.openPanel('audio') });
  chip.append(chipTime, chipAudio);
  const shade = el('div', { id: 'atmo-shade', 'aria-hidden': 'true', hidden: true });
  const weatherCanvas = el('canvas', { id: 'atmo-weather', 'aria-hidden': 'true', hidden: true });
  const view = document.getElementById('view');
  if (view?.parentNode) view.after(shade, weatherCanvas);
  else document.body.append(shade, weatherCanvas);
  (document.getElementById('hud') ?? document.body).append(chip);
  const weather = new WeatherLayer(weatherCanvas);
  const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');

  function updateChip(info = sceneInfo()) {
    const t = formatTime(info.date);
    const w = info.indoors ? '' : ` · ${info.weatherLabel}`;
    chipTime.textContent = rest ? `${t} · Resting ${rest.hoursDone}${rest.hoursPlanned ? `/${rest.hoursPlanned}` : ''} h` : `${t}${w}`;
    chipTime.setAttribute('aria-label', `${formatDate(info.date)}, ${t}${info.indoors ? '' : `, ${info.weatherLabel}`}. Open rest panel.`);
    chip.dataset.night = String(info.night);
    chip.dataset.resting = String(!!rest);
    const st = engine.status();
    const silent = prefs.muted || !st.running;
    chipAudio.textContent = silent ? '♪̸' : '♪';
    chipAudio.dataset.state = prefs.muted ? 'muted' : st.running ? 'on' : 'off';
    chipAudio.setAttribute('aria-label', prefs.muted ? 'Sound muted. Open sound settings.' : st.running ? 'Sound on. Open sound settings.' : 'Sound not started. Open sound settings.');
  }

  // ------------------------------------------------------------ audio wiring

  const unlock = () => {
    if (engine.running) return;
    engine.unlock().then(() => { pickMusic(true); updateChip(); });
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  document.addEventListener('visibilitychange', () => {
    if (!engine.ctx) return;
    if (document.hidden) engine.ctx.suspend?.().catch(() => {});
    else if (screen === 'game') engine.ctx.resume?.().catch(() => {});
  });

  engine.onChange(() => { updateChip(); if (api.panel === 'audio') renderAudio(); });

  function setPrefs(patch) {
    prefs = savePrefs(storage, { ...prefs, ...patch });
    engine.applyPrefs(prefs);
    if ('arrangement' in patch || 'musicEnabled' in patch) pickMusic(true);
    updateChip();
  }

  function pickMusic(force = false) {
    const info = sceneInfo();
    const key = `${info.kind}|${info.atSea}|${info.weather}|${prefs.arrangement}|${Math.floor(info.minutes / MINUTES_PER_DAY)}`;
    if (!force && key === lastSceneKey) return;
    lastSceneKey = key;
    const song = chooseSong(info.kind, {
      fm: prefs.arrangement === 'fm',
      gameDays: Math.floor(info.minutes / MINUTES_PER_DAY),
      available: engine.midi ? engine.songNames : null,
    });
    if (screen === 'game' && prefs.musicEnabled) engine.playSong(song);
    else engine.wantedSong = song;
    const amb = ambienceFor(info);
    if (screen === 'game') engine.setLoops(amb.loops);
  }

  function panAt(x, z) {
    const cam = api.camera ?? lastCam;
    if (!cam || !Number.isFinite(x) || !Number.isFinite(z)) return 0;
    const ang = Math.atan2(x - cam.x, -(z - cam.z)) - (cam.yaw ?? 0);
    return Math.sin(ang) * 0.8;
  }
  function panFor(playerId) {
    if (playerId === undefined || playerId === null) return 0;
    const peer = (api.state?.peers ?? []).find((p) => String(p.id) === String(playerId));
    return peer ? panAt(peer.x, peer.z) : 0;
  }
  const entityById = (id) => (api.state?.entities ?? []).find((e) => e && String(e.id) === String(id)) ?? null;
  // DFU's 16 m attract radius, x1.25 with the Acute Hearing advantage (package 11 publishes career advantages).
  const hearing = () => {
    const c = api.character ?? api.state?.character;
    const sheet = c && typeof c.character === 'object' && c.character ? c.character : c;
    return hearingRadius(sheet?.career?.advantages, sheet?.improvedTalents);
  };
  /** Distance-scaled volume inside the hearing radius. No wall occlusion is modelled. */
  function nearVolume(e, base = 0.8, radius = hearing()) {
    const cam = api.camera ?? lastCam;
    if (!cam || !Number.isFinite(e?.x)) return base * 0.5;
    const d = Math.hypot(e.x - cam.x, e.z - cam.z);
    if (d > radius) return 0;
    return base * (1 - 0.75 * (d / radius));
  }

  // Creature voices (DFU EnemySounds): every 3-9 s within 16 m, 20% move else bark; the attack voice on attack.
  const creatureWait = new Map();
  function creatureVoices(dt) {
    if (!engine.running) return;
    const cam = api.camera ?? lastCam;
    if (!cam) return;
    const seen = new Set();
    const radius = hearing();
    for (const e of api.state?.entities ?? []) {
      if (e?.kind !== 'monster' || e.dead || !Number.isFinite(e.monsterId)) continue;
      seen.add(e.id);
      if (Math.hypot(e.x - cam.x, e.z - cam.z) > radius) continue;
      let t = creatureWait.get(e.id);
      if (t === undefined) t = CREATURE_ATTRACT.minDelay + Math.random() * (CREATURE_ATTRACT.maxDelay - CREATURE_ATTRACT.minDelay + 1);
      t -= dt;
      if (t <= 0) {
        const clip = creatureClip(e.monsterId, 'attract');
        if (clip !== null) { engine.playClip(clip, { volume: nearVolume(e, 0.8, radius), pan: panAt(e.x, e.z) }); lastCreature = { id: e.id, monsterId: e.monsterId, clip }; }
        t = CREATURE_ATTRACT.minDelay + Math.floor(Math.random() * (CREATURE_ATTRACT.maxDelay - CREATURE_ATTRACT.minDelay + 1));
      }
      creatureWait.set(e.id, t);
    }
    for (const id of creatureWait.keys()) if (!seen.has(id)) creatureWait.delete(id);
  }

  // The server decides fall damage; when its `locomotion` fall arrives and this browser's own landing did not
  // already play FallDamage (a corrected or reconciled body), play it once.
  let lastFallDamage = -Infinity;
  function soundFor(ev) {
    const selfId = api.selfId ?? api.state?.selfId ?? null;
    const sea = seaSound(ev, vessel, api.camera?.yaw);
    if (sea) {
      // Several balls in one broadside can hit on the same frame.
      const now = performance.now();
      if (ev.kind !== 'naval.hit' || now - lastSeaImpact > 70) {
        engine.playClip(sea.clip, sea);
        if (ev.kind === 'naval.hit') lastSeaImpact = now;
      }
      return;
    }
    if (ev.kind === 'locomotion' && ev.event === 'fall' && ev.damage > 0) {
      if (performance.now() - lastFallDamage > 1500) { engine.playClip(CLIP.FallDamage, { volume: 0.8 }); lastFallDamage = performance.now(); }
      return;
    }
    if (ev.kind === 'monsterAttack') {
      const e = entityById(ev.entityId);
      const clip = e ? creatureClip(e.monsterId, 'attack') : null;
      if (clip !== null) { engine.playClip(clip, { volume: Math.max(0.3, nearVolume(e, 0.9)), pan: panAt(e.x, e.z) }); lastCreature = { id: e.id, monsterId: e.monsterId, clip, attack: true }; }
    }
    for (const { clip, self, at, record } of clipsForEvent(ev, { selfId })) {
      if (at) { engine.playClip(clip, { volume: 0.8, pan: panAt(at.x, at.z) }); lastMechanism = { id: at.id, clip, cue: at.cue }; continue; }
      const mine = self || (ev.playerId !== undefined && String(ev.playerId) === String(selfId));
      engine.playClip(clip, { volume: mine ? 0.9 : 0.5, pan: mine ? 0 : panFor(ev.playerId), record });
    }
  }

  if (api.files && [...api.files].length) engine.setFiles(api.files).then(() => pickMusic(true));
  api.on('assets', (files) => { engine.setFiles(files).then(() => { pickMusic(true); if (api.panel === 'audio') renderAudio(); }); });

  // ------------------------------------------------------------ server events

  api.on('event', (ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'sailing.state') {
      const wasAboard = !!vessel;
      vessel = ev.vessel ?? null;
      if (wasAboard !== !!vessel) pickMusic();
      return;
    }
    if (ev.kind === 'clock') {
      clock.minutes = Number(ev.minutes) || 0;
      clock.at = performance.now();
      clock.rate = Number(ev.minutesPerSecond) || DEFAULT_TIME_SCALE / 60;
      clock.info = ev;
      if (api.renderer) api.renderer.cityGatesClosed = cityGatesClosed(clock.minutes);
      rest = ev.resting ?? null;
      updateChip();
      pickMusic();
      if (api.panel === 'rest') renderRest();
      return;
    }
    if (ev.kind === 'rest') {
      if (ev.state === 'started') rest = { mode: ev.mode, hoursDone: 0, hoursPlanned: ev.hoursPlanned };
      else if (ev.state === 'progress') rest = { ...(rest ?? {}), hoursDone: ev.hoursDone, hoursPlanned: ev.hoursPlanned };
      else rest = null;
      if (ev.text) restLog = ev.text; // the shell already shows event text as a notice
      if (ev.state === 'interrupted') engine.playClip(CLIP.Hit2, { volume: 0.4 });
      updateChip();
      if (api.panel === 'rest') renderRest();
      return;
    }
    soundFor(ev);
  });
  api.on('connection', (state) => {
    if (state !== 'online' && vessel) { vessel = null; pickMusic(); }
  });

  api.on('location', ({ location: loc, previous } = {}) => {
    if (previous && isIndoors(loc) !== isIndoors(previous)) engine.playClip(CLIP.NormalDoorOpen, { volume: 0.8 });
    rest = null;
    pickMusic(true);
    updateChip();
  });
  api.on('scene', () => pickMusic());
  // Package 4 one-off movement events: landings (FallHard/FallDamage) and entering water (DFU SplashLarge).
  api.on('movement', (ev = {}) => {
    if (!ev || typeof ev !== 'object') return;
    // A landing in water arrives together with swim {start}, which plays the splash.
    if (ev.kind === 'land') {
      if (ev.water) return;
      for (const { clip } of clipsForEvent(ev)) {
        engine.playClip(clip, { volume: 0.8 });
        if (clip === CLIP.FallDamage) lastFallDamage = performance.now();
      }
      return;
    }
    if (ev.kind === 'submerge' || (ev.kind === 'swim' && ev.start)) engine.playClip(CLIP.SplashLarge, { volume: 0.7 });
  });
  // Dungeon mechanisms that changed state (raised by the interiors feature from dungeonState snapshots).
  api.on('mechanisms', ({ changed = [] } = {}) => {
    for (const m of changed.slice(0, 6)) {
      const clip = mechanismClip(m);
      if (clip !== null) { engine.playClip(clip, { volume: 0.8, pan: panAt(m.x, m.z) }); lastMechanism = { id: m.id, clip }; }
    }
  });
  api.on('state', () => { if (api.panel === 'rest' && restVitalsBox?.isConnected) renderRestVitals(); });

  function setScreen(name) {
    screen = name;
    const inGame = name === 'game';
    chip.hidden = !inGame;
    shade.hidden = !inGame;
    weatherCanvas.hidden = !inGame;
    engine.setPaused(!inGame);
    if (inGame) { keepLayerOrder(); pickMusic(true); updateChip(); } else {
      if (api.renderer) restoreLight(api.renderer);
      weather.clear();
    }
  }
  api.on('screen', (name) => setScreen(typeof name === 'string' ? name : name?.screen));
  setScreen(screen);

  // ------------------------------------------------------------ per frame

  let chipTick = 0;
  let syncAsked = -Infinity;
  // The server sends the join-time clock before its welcome, and the shell drops game events until the
  // welcome is handled. Ask as soon as the character's state arrives, behind the loading screen (the arrival
  // gate waits for the season, client/gameplay/wilderness.js), then once per 10 s until it lands.
  const askClock = () => {
    if (clock.minutes !== null || !api.state || performance.now() - syncAsked <= 10000) return;
    syncAsked = performance.now();
    api.act('time.sync', {}, { quiet: true });
  };
  api.on('state', askClock);
  const labels = document.getElementById('labels');
  const keepLayerOrder = () => {
    // Other features add full-screen canvases (sprites, effects) after #view; the shade and
    // precipitation belong above all 3D layers and below names and the HUD.
    if (labels?.parentNode && (shade.nextElementSibling !== weatherCanvas || weatherCanvas.nextElementSibling !== labels)) labels.before(shade, weatherCanvas);
  };
  api.on('frame', (f = {}) => {
    if (screen !== 'game') return;
    askClock();
    const info = sceneInfo();
    const dt = Math.min(0.1, Number(f.dt) || 0.016);
    const renderer = f.renderer ?? api.renderer;
    if (f.movement && typeof f.movement === 'object') frameMovement = f.movement;
    engine.setUnderwater(info.underwater);
    if (renderer) {
      renderer.cityGatesClosed = cityGatesClosed(info.minutes);
      const L = lightFor({ minuteOfDay: info.minutes % MINUTES_PER_DAY, weather: info.weather, indoors: info.indoors, flash, kind: info.kind, lightRadius: info.lightRadius, underwater: info.underwater });
      lastLight = { light: L.light ?? (info.indoors ? 'interior' : 'sky'), radius: L.radius ?? null, fog: L.fogOverride ?? null, underwater: info.underwater };
      L.apply(renderer);
      shade.style.backgroundColor = L.shadeCss;
    }
    flash = Math.max(0, flash - dt * 3);

    // Storm flashes.
    if (info.weather === 'thunder' && !info.indoors && Math.random() < dt / 14) {
      flash = 1;
      const delay = 400 + Math.random() * 2600;
      setTimeout(() => engine.playClip(Math.random() < 0.5 ? CLIP.StormLightningThunder : CLIP.StormThunderRoll, { bus: 'ambience', volume: 0.9 }), delay);
    }

    const cam = f.camera ?? api.camera;
    let dyaw = 0;
    if (cam && lastCam) {
      const turn = (cam.yaw ?? 0) - (lastCam.yaw ?? 0);
      dyaw = Math.atan2(Math.sin(turn), Math.cos(turn)); // wrap across ±π
      const moved = Math.hypot(cam.x - lastCam.x, cam.z - lastCam.z);
      if (moved < 3) { // ignore teleports
        stepAcc += moved;
        if (stepAcc >= STEP_DISTANCE) {
          stepAcc = 0;
          const pair = footstepClips(info);
          const clip = pair[stepFoot++ & 1];
          lastStep = clip;
          engine.playClip(clip, { volume: 0.35, rate: 0.95 + Math.random() * 0.1 });
        }
      }
    }
    if (cam) lastCam = { x: cam.x, z: cam.z, yaw: cam.yaw ?? 0 };

    weather.draw({ type: info.indoors ? 'indoors' : info.weather, intensity: info.intensity, dt, dyaw, reduced: !!reduceMotion?.matches, flash });

    // Ambient one-shots.
    const now = performance.now();
    if (now >= nextAmbient) {
      const { shots } = ambienceFor(info);
      if (nextAmbient && shots.length && engine.running) engine.playClip(shots[Math.floor(Math.random() * shots.length)], { bus: 'ambience', volume: info.kind === 'dungeon' ? 0.45 : 0.55, pan: Math.random() * 1.4 - 0.7 });
      nextAmbient = now + 9000 + Math.random() * 16000;
    }

    creatureVoices(dt);
    if ((chipTick += dt) > 1) { chipTick = 0; updateChip(info); pickMusic(); keepLayerOrder(); }
  });

  // ------------------------------------------------------------ rest panel

  let restBox = null;
  let restVitalsBox = null;
  function vitalLine(label, cur, max) {
    if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0) return null;
    const pct = Math.round((cur / max) * 100);
    return el('li', { class: 'atmo-vital' },
      el('span', { class: 'atmo-vital-name', text: label }),
      el('meter', { min: '0', max: String(max), value: String(cur), 'aria-label': `${label} ${cur} of ${max}` }),
      el('span', { class: 'atmo-vital-num', text: `${Math.round(cur)} / ${max} (${pct}%)` }));
  }
  function renderRestVitals() {
    if (!restVitalsBox) return;
    const c = api.stats ?? {};
    const rate = recoveryPerHour(c);
    const lines = [vitalLine('Health', c.health, c.maxHealth), vitalLine('Fatigue', c.fatigue, c.maxFatigue), vitalLine('Magicka', c.magicka, c.maxMagicka)].filter(Boolean);
    restVitalsBox.replaceChildren(
      lines.length ? el('ul', { class: 'atmo-vitals' }, lines) : el('p', { class: 'note', text: 'Create a character to rest and recover.' }),
      lines.length ? el('p', { class: 'note fine', text: `Each rested hour restores about ${rate.health} health, ${rate.fatigue} fatigue and ${rate.magicka} magicka.` }) : null,
    );
  }

  function renderRest(container = restBox) {
    restBox = container;
    if (!restBox) return;
    const info = sceneInfo();
    const d = info.date;
    const where = location();
    const inn = api.town?.source?.buildingType === 15;
    const rental = inn && api.character?.tavern?.rooms?.[where];
    const bed = (rental?.releaseAt ?? rental?.expiresAt) > info.minutes && api.town.beds?.find(b => b.number === rental.bed);
    const expiry = bed && dateFromMinutes(rental.expiresAt);
    restVitalsBox = el('div', { class: 'atmo-rest-vitals' });
    const hoursId = 'atmo-rest-hours';
    const hours = el('input', { id: hoursId, type: 'number', min: '1', max: '99', step: '1', value: String(restHours), inputmode: 'numeric', disabled: !!rest });
    const form = el('form', {
      class: 'atmo-rest-form',
      onsubmit: (e) => {
        e.preventDefault();
        const n = Math.trunc(Number(hours.value));
        if (!(n >= 1 && n <= 99)) { restLog = 'Choose between 1 and 99 hours.'; renderRest(); return; }
        restHours = n;
        api.act('rest.start', { hours: n });
      },
    },
    el('label', { for: hoursId, text: 'Hours' }), hours,
    el('button', { type: 'submit', class: 'btn btn-primary', disabled: !!rest, text: 'Rest' }),
    el('button', { type: 'button', class: 'btn', disabled: !!rest, text: 'Rest until healed', onclick: () => api.act('rest.start', { mode: 'healed' }) }),
    el('button', {
      type: 'button', class: 'btn', disabled: !!rest, text: 'Loiter', title: 'Wait without sleeping. Allowed anywhere; recovers nothing.',
      onclick: () => {
        const n = Math.trunc(Number(hours.value));
        if (!(n >= 1 && n <= 99)) { restLog = 'Choose between 1 and 99 hours.'; renderRest(); return; }
        restHours = n;
        api.act('rest.start', { mode: 'loiter', hours: n });
      },
    }),
    rest ? el('button', { type: 'button', class: 'btn', text: 'Stop resting', onclick: () => api.act('rest.stop') }) : null);

    restBox.replaceChildren(
      el('section', { class: 'atmo-panel', 'aria-labelledby': 'atmo-date' },
        el('h3', { id: 'atmo-date', class: 'atmo-date', text: formatDate(d) }),
        el('p', { class: 'atmo-when' },
          el('strong', { text: formatTime(d) }), ` · ${d.season} · ${d.isNight ? 'Night' : 'Day'} · `,
          info.indoors ? 'Indoors' : `${info.weatherLabel} over ${serverDescribes(where) ? clock.info.region : regionHere(where)}`),
        clock.info?.holiday?.name ? el('p', { class: 'atmo-holiday', text: `Holiday: ${clock.info.holiday.name}` }) : null,
        el('p', { class: 'note fine', text: 'Everyone in the world shares this calendar. It keeps running while you rest or travel; resting recovers you in about a second and a half per hour without moving the clock for anyone else.' }),
        el('h4', { text: 'Rest' }),
        inn ? el('p', { class: 'note', text: bed
          ? `Bed ${bed.number} is yours until ${formatTime(expiry)}, ${formatDate(expiry)}. Go to your bed to sleep.`
          : 'Rent a bed from the innkeeper to sleep here.' }) : null,
        restVitalsBox,
        form,
        el('p', { class: 'atmo-rest-status', role: 'status', 'aria-live': 'polite', text: rest ? `${rest.mode === 'loiter' ? 'Waiting' : 'Resting'}… ${rest.hoursDone} hour${rest.hoursDone === 1 ? '' : 's'}${rest.hoursPlanned ? ` of ${rest.hoursPlanned}` : ''}. Moving, fighting or a nearby enemy will wake you.` : restLog }),
        el('p', { class: 'note fine', text: 'You can only rest with your weapon sheathed and no enemies nearby. Sleeping in the streets of a town is a crime: rent a room, or loiter instead. Outdoors and in dungeons, monsters may find you while you rest.' }),
      ),
    );
    renderRestVitals();
  }

  // ------------------------------------------------------------ audio panel

  let audioBox = null;
  const SLIDERS = [['master', 'Master volume'], ['music', 'Music'], ['effects', 'Sound effects'], ['ambience', 'Ambience']];

  function describeSources(st) {
    const parts = [];
    if (!st.supported) return ['This browser has no Web Audio support, so nothing can play.'];
    parts.push(st.sounds
      ? `Sound effects: ${st.clipCount} clips from your ARENA2/DAGGER.SND — weapon swings and hits, footsteps, doors, birds, dogs, crickets, rain and thunder.`
      : 'Sound effects: DAGGER.SND was not found in the selected folder, so no effects play.');
    parts.push(st.music
      ? `Music: ${st.songCount} songs from your ARENA2/MIDI.BSA, chosen by place, time of day and weather and played through a built-in FM synthesiser (Daggerfall's own instrument patches are not part of the game files).`
      : 'Music: MIDI.BSA was not found in the selected folder, so no soundtrack plays. Effects still play if DAGGER.SND is present.');
    return parts;
  }

  function renderAudio(container = audioBox) {
    audioBox = container;
    if (!audioBox) return;
    const st = engine.status();
    const rows = SLIDERS.map(([key, label]) => {
      const id = `atmo-vol-${key}`;
      const out = el('output', { for: id, class: 'atmo-vol-out', text: `${Math.round(prefs[key] * 100)}%` });
      const input = el('input', {
        id, type: 'range', min: '0', max: '100', step: '5', value: String(Math.round(prefs[key] * 100)),
        'aria-valuetext': `${Math.round(prefs[key] * 100)} percent`,
        oninput: (e) => {
          const v = Number(e.target.value) / 100;
          out.textContent = `${Math.round(v * 100)}%`;
          e.target.setAttribute('aria-valuetext', `${Math.round(v * 100)} percent`);
          prefs = savePrefs(storage, { ...prefs, [key]: v });
          engine.applyPrefs(prefs);
        },
        onchange: () => { if (key === 'effects') engine.playClip(CLIP.SwingMediumPitch, { volume: 0.8 }); },
      });
      return el('div', { class: 'atmo-vol' }, el('label', { for: id, text: label }), input, out);
    });
    const now = st.song
      ? `Now playing ${st.song}.`
      : !st.running ? 'Sound starts after your first click or key press in the game.'
        : !prefs.musicEnabled ? 'Music is switched off.'
          : !st.music ? 'No music archive loaded.' : 'Waiting for the next song.';
    audioBox.replaceChildren(
      el('section', { class: 'atmo-panel atmo-audio' },
        st.running ? null : el('button', { type: 'button', class: 'btn btn-primary', text: 'Start sound', disabled: !st.supported, onclick: () => engine.unlock().then(() => { pickMusic(true); renderAudio(); }) }),
        el('div', { class: 'atmo-toggles' },
          el('label', {}, el('input', { type: 'checkbox', checked: prefs.muted, onchange: (e) => setPrefs({ muted: e.target.checked }) }), ' Mute all sound'),
          el('label', {}, el('input', { type: 'checkbox', checked: prefs.musicEnabled, onchange: (e) => setPrefs({ musicEnabled: e.target.checked }) }), ' Play music')),
        el('fieldset', { class: 'atmo-vols', disabled: prefs.muted }, el('legend', { text: 'Volume' }), rows),
        el('div', { class: 'atmo-arr' },
          el('label', { for: 'atmo-arr', text: 'Arrangement' }),
          el('select', { id: 'atmo-arr', onchange: (e) => setPrefs({ arrangement: e.target.value }) },
            el('option', { value: 'gm', selected: prefs.arrangement === 'gm', text: 'General MIDI' }),
            el('option', { value: 'fm', selected: prefs.arrangement === 'fm', text: 'FM sound card' }))),
        el('p', { class: 'atmo-now', role: 'status', 'aria-live': 'polite', text: now }),
        el('button', { type: 'button', class: 'btn', text: 'Test sound', disabled: !st.running || !st.sounds, onclick: () => engine.playClip(CLIP.SwingHighPitch, { volume: 0.9 }) }),
        el('h4', { text: 'What plays' }),
        el('ul', { class: 'atmo-sources' }, describeSources(st).map((t) => el('li', { text: t }))),
        st.error ? el('p', { class: 'note error', text: st.error }) : null,
        el('p', { class: 'note fine', text: 'Settings are saved in this browser. Game audio is read from your own files and never uploaded.' }),
      ),
    );
  }

  api.registerPanel('rest', 'Rest', (container) => renderRest(container), { key: 'KeyR' });
  api.registerPanel('audio', 'Sound', (container) => renderAudio(container));
  // The chip sits where the open menu's header goes; step aside while a menu is open.
  const syncChip = () => { chip.classList.toggle('atmo-chip-under-menu', !!api.modalOpen); };
  api.on('panel', (detail) => {
    const id = typeof detail === 'string' ? detail : detail?.open === false ? null : detail?.id ?? detail?.panel ?? null;
    if (id !== 'rest') restBox = null;
    if (id !== 'audio') audioBox = null;
    syncChip();
  });

  // Live clock in the open rest panel.
  setInterval(() => {
    syncChip();
    if (screen !== 'game') return;
    if (api.panel === 'rest' && restBox?.isConnected) {
      const info = sceneInfo();
      const h = restBox.querySelector('#atmo-date');
      const s = restBox.querySelector('.atmo-when strong');
      if (h) h.textContent = formatDate(info.date);
      if (s) s.textContent = formatTime(info.date);
    }
  }, 1000);

  updateChip();
  // For other features and debugging.
  api.atmosphere = {
    engine, now: sceneInfo, get prefs() { return prefs; }, setPrefs,
    /** True once the server's clock event arrived (the season is the shared one, not a local estimate). */
    get clockKnown() { return clock.minutes !== null; },
    /** Another feature's light: `radius` in metres. */
    setLightSource(id, { radius } = {}) { if (Number(radius) > 0) lightSources.set(String(id), { radius: Number(radius) }); else lightSources.delete(String(id)); },
    clearLightSource(id) { lightSources.delete(String(id)); },
    /** Diagnostics: what lit the last frame and which clips played last. */
    status: () => ({ ...(lastLight ?? {}), lastStep, lastCreature, lastMechanism, sources: [...lightSources.keys()] }),
  };
}
