// Wilderness panel: the named World of Daggerfall sites near the player (docs/wilderness-protocol.md).
//
// - Lists the real sites the server reports near the character's map pixel, nearest first,
//   with kind, compass direction and distance. Nothing here invents a site: an empty or
//   missing list is shown as such, with the reason the server gives.
// - "Visit" sends `wilderness.visit {site}`; the server validates and moves the character to
//   the site's `wilderness:<px>,<py>` location. The scene itself is built by wilderness.js,
//   which reports progress with the 'wildernessScene' event.
// - "Return to <town>" sends `wilderness.leave`.
//
// The view model helpers at the top are DOM-free so they can be tested in Node.

import { installWildernessBuildings } from './wilderness/buildings.js';

export const PANEL_ID = 'wilderness';
export const PANEL_TITLE = 'Wilderness';
export const PANEL_KEY = 'KeyL';
const ACT_TIMEOUT_MS = 12000;

// ------------------------------------------------------------------ view model (DOM-free)

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : null);
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** `wilderness:<px>,<py>` → {px, py}, else null. */
export function parseWildernessId(id) {
  const m = /^wilderness:(-?\d+),(-?\d+)(?:[/#:].*)?$/.exec(String(id ?? ''));
  return m ? { px: +m[1], py: +m[2] } : null;
}

/**
 * Site id `wod:<px>,<py>:<tx>,<ty>[#n]` → fractional map position {px, py} (y grows south).
 * Terrain tiles are 0..128 across a pixel and WoD terrainY grows north (docs/wilderness-protocol.md).
 */
export function sitePosition(id) {
  const m = /^wod:(\d+),(\d+):(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?:#\d+)?$/.exec(String(id ?? ''));
  if (!m) return null;
  return { px: +m[1] + +m[3] / 128, py: +m[2] + 1 - +m[4] / 128 };
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const COMPASS_SHORT = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

/**
 * Compass heading from one map pixel to another. Map pixel y grows southwards (MAPS.BSA and
 * World of Daggerfall CSVs), x eastwards. Returns null when both are the same pixel.
 */
export function bearing(from, to) {
  if (!from || !to) return null;
  const dx = to.px - from.px;
  const dy = to.py - from.py;
  if (![dx, dy].every(Number.isFinite)) return null;
  if (dx === 0 && dy === 0) return null;
  const deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  const i = Math.round(deg / 45) % 8;
  return { degrees: Math.round(deg), name: COMPASS[i], short: COMPASS_SHORT[i], arrow: ARROWS[i] };
}

/** Classic terrain tile (one map pixel) is 819.2 m across. */
export const METRES_PER_PIXEL = 819.2;

/** Player-readable distance for a distance in map pixels. */
export function distanceText(pixels) {
  const p = num(pixels);
  if (p === null || p < 0) return '';
  const yards = (p * METRES_PER_PIXEL) / 0.9144;
  if (yards < 60) return 'here';
  const miles = yards / 1760;
  if (miles < 1) return `${Math.round(yards / 50) * 50} yards`;
  const r = miles < 10 ? Math.round(miles * 2) / 2 : Math.round(miles);
  return `${r} ${r === 1 ? 'mile' : 'miles'}`;
}

const KIND_LABELS = {
  camp: 'Camp', ruin: 'Ruin', ruins: 'Ruin', shrine: 'Shrine', tower: 'Tower', cave: 'Cave', farm: 'Farm',
  graveyard: 'Graveyard', cemetery: 'Graveyard', fort: 'Fort', fortress: 'Fort', bandit: 'Bandit camp',
  inn: 'Inn', tavern: 'Inn', mill: 'Mill', monument: 'Monument', bridge: 'Bridge', port: 'Harbour',
  dock: 'Dock', logging: 'Logging camp', mine: 'Mine', landmark: 'Landmark', village: 'Hamlet', hamlet: 'Hamlet', temple: 'Temple',
  wayshrine: 'Wayshrine', outpost: 'Outpost', lighthouse: 'Lighthouse', manor: 'Manor', dungeon: 'Dungeon',
  site: 'Site',
};

/** Human label for a source site kind ('bandit_camp' → 'Bandit camp'). */
export function kindLabel(kind) {
  const k = str(kind);
  if (!k) return 'Site';
  const key = k.toLowerCase().replace(/[\s-]+/g, '_');
  if (KIND_LABELS[key]) return KIND_LABELS[key];
  const words = key.split('_').filter(Boolean).join(' ');
  return words ? words[0].toUpperCase() + words.slice(1) : 'Site';
}

/** `town:Region/Name` → 'Name'. */
export function townName(id) {
  const m = /^town:[^/]*\/(.+)$/.exec(String(id ?? ''));
  return m ? m[1] : null;
}

function normalizeSite(raw, origin) {
  if (!isObj(raw)) return null;
  const id = str(raw.id) ?? str(raw.location) ?? str(raw.siteId);
  const name = str(raw.name) ?? str(raw.title);
  if (!id || !name) return null; // a site with no real name or id is not shown
  const fromId = parseWildernessId(raw.location) ?? parseWildernessId(id);
  const px = num(raw.px) ?? num(raw.mapPixelX) ?? num(raw.mapX) ?? fromId?.px ?? null;
  const py = num(raw.py) ?? num(raw.mapPixelY) ?? num(raw.mapY) ?? fromId?.py ?? null;
  const pos = px !== null && py !== null ? { px, py } : null;
  // Within-pixel precision for bearings, measured from the centre of the origin pixel.
  const fine = sitePosition(id);
  const fineOrigin = origin ? { px: origin.px + 0.5, py: origin.py + 0.5 } : null;
  let distance = num(raw.distance);
  const unit = str(raw.distanceUnit) ?? str(raw.unit);
  if (distance !== null && unit && /^m|metre|meter/i.test(unit)) distance /= METRES_PER_PIXEL;
  if (distance === null && pos && origin) distance = Math.hypot(pos.px - origin.px, pos.py - origin.py);
  const dir = str(raw.direction);
  return {
    id,
    location: str(raw.location) ?? (fromId ? `wilderness:${fromId.px},${fromId.py}` : null),
    name,
    kind: str(raw.kind) ?? str(raw.type) ?? null,
    kindLabel: kindLabel(raw.kind ?? raw.type),
    region: str(raw.region) ?? str(raw.regionName) ?? null,
    pos,
    distance,
    bearing: fine && fineOrigin ? bearing(fineOrigin, fine) : pos && origin ? bearing(origin, pos) : dir ? { name: dir, short: dir, arrow: '', degrees: null } : null,
    discovered: raw.discovered === true,
    available: raw.available !== false,
    note: str(raw.note) ?? str(raw.reason) ?? null,
  };
}

/**
 * Normalise what the server sent into a panel view. Accepts `character.wilderness` (preferred)
 * or a top-level `wilderness` block, plus an optional list fetched with `wilderness.nearby`.
 */
export function wildernessView(state, fetched = null) {
  const c = isObj(state?.character) ? state.character : null;
  const w = (isObj(c?.wilderness) && c.wilderness) || (isObj(state?.wilderness) && state.wilderness) || null;
  const location = str(c?.location) ?? str(state?.location) ?? null;
  const atPixel = parseWildernessId(location);
  const packRaw = w ? (str(w.pack) ?? (w.available === false ? 'missing' : w.available === true ? 'ready' : null)) : null;
  const pack = !w ? 'unknown' : packRaw === 'ready' || packRaw === 'loaded' || packRaw === 'ok' ? 'ready'
    : packRaw === 'loading' ? 'loading' : packRaw === 'missing' || packRaw === 'absent' || packRaw === 'unavailable' ? 'missing'
      : packRaw === 'error' ? 'error' : 'ready';
  const o = isObj(w?.origin) ? w.origin : null;
  const origin = (o && num(o.px) !== null && num(o.py) !== null ? { px: num(o.px), py: num(o.py) } : null)
    ?? (isObj(fetched?.origin) && num(fetched.origin.px) !== null ? { px: num(fetched.origin.px), py: num(fetched.origin.py) } : null)
    ?? atPixel;
  const list = Array.isArray(fetched?.nearby) ? fetched.nearby : Array.isArray(w?.nearby) ? w.nearby : null;
  const nearby = (list ?? []).map((s) => normalizeSite(s, origin)).filter(Boolean);
  // Nearest first; ties by name so every client lists them in the same order.
  nearby.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  // `site` is the visited site id (wod:…); a player who walked overland stands on a wilderness
  // pixel with no site.
  const siteId = str(w?.site);
  const current = isObj(w?.current) ? normalizeSite(w.current, origin) : null;
  const here = current ?? (siteId ? nearby.find((s) => s.id === siteId || s.location === siteId) ?? null : null);
  const discovered = new Set(Array.isArray(w?.discovered) ? w.discovered.filter((x) => typeof x === 'string') : []);
  for (const s of nearby) if (discovered.has(s.id)) s.discovered = true;
  const returnTo = str(w?.returnTo) ?? str(c?.travel?.lastTown) ?? null;
  return {
    pack,
    packNote: str(w?.packNote) ?? str(w?.note) ?? str(w?.reason) ?? null,
    location,
    atSite: !!siteId,
    inWilds: !!atPixel,
    pixel: atPixel,
    siteId,
    radius: num(w?.radius),
    here,
    returnTo,
    returnName: townName(returnTo) ?? str(w?.returnName) ?? null,
    region: str(o?.region) ?? str(w?.region) ?? null,
    origin,
    listKnown: list !== null,
    nearby,
  };
}

/** Readable sentence for a failed wilderness action. */
export function actionErrorText(error, verb) {
  const e = String(error ?? '').trim();
  const code = e.toLowerCase();
  if (!e) return verb === 'wilderness.leave' ? 'You could not return to town.' : 'You could not set out for that site.';
  if (/pack|not installed|unavailable|missing/.test(code)) return 'The World of Daggerfall site pack is not available on this server right now.';
  if (/unknown|stale|no such|not found|invalid site/.test(code)) return 'That site is no longer on the list. The list has been refreshed. Choose again.';
  if (/too far|out of range|not nearby/.test(code)) return 'That site is too far from where you stand. Choose a nearer one, or travel closer first.';
  if (/already/.test(code)) return 'You are already there.';
  if (/combat|enem|danger/.test(code)) return 'You cannot leave while enemies are near.';
  return e[0].toUpperCase() + e.slice(1) + (/[.!?]$/.test(e) ? '' : '.');
}

// ------------------------------------------------------------------ DOM

const el = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else n.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
};

export function install(api) {
  // Farmhouse and other RMB building doors at wilderness sites (shared portal service).
  if (api.wildernessBuildings !== false) installWildernessBuildings(api);
  const S = {
    pending: null, // {verb, site?, name, timer}
    status: '',
    statusKind: '', // '' | 'error' | 'ok'
    scene: null, // last 'wildernessScene' detail
    fetched: null, // {location, nearby, origin} from wilderness.nearby
    fetching: null, // location being fetched
    fetchFailed: null,
    filter: 'all',
    packSelection: 0,
    packLabel: '',
  };

  const view = () => wildernessView(api.state, S.fetched && S.fetched.location === api.location ? S.fetched : null);
  const refresh = () => api.refreshPanel?.(PANEL_ID);

  function treasureInReach() {
    const scene = api.wilderness?.scene;
    const cam = api.camera;
    if (!cam || scene?.location !== api.location) return null;
    const searched = api.state?.character?.wilderness?.looted ?? [];
    let nearest = null, reach = 4;
    for (const item of scene?.wilderness?.treasure ?? []) {
      const distance = Math.hypot(item.x - cam.x, item.z - cam.z);
      if (distance <= reach && !searched.includes(`${item.site}/${item.object}`)) {
        nearest = item;
        reach = distance;
      }
    }
    return nearest;
  }
  function search(item) {
    api.act('wilderness.loot', { site: item.site, object: item.object });
  }
  api.on('interactIntent', (intent) => {
    if (!intent || intent.handled || intent.entity) return;
    const item = treasureInReach();
    if (item) {
      intent.handled = true;
      search(item);
    }
  });

  function setStatus(text, kind = '') { S.status = text ?? ''; S.statusKind = kind; refresh(); }

  function finishPending(text, kind = '') {
    if (!S.pending) return;
    clearTimeout(S.pending.timer);
    S.pending = null;
    setStatus(text, kind);
  }

  /** When the snapshot carries no list, ask the server once per location. */
  function maybeFetch(v) {
    if (v.listKnown || v.pack === 'missing' || v.pack === 'error' || v.pack === 'unknown') return;
    const loc = api.location;
    if (!loc || S.fetching === loc || S.fetched?.location === loc || S.fetchFailed === loc) return;
    S.fetching = loc;
    const r = api.act('wilderness.nearby', {}, { quiet: true });
    if (!r) { S.fetching = null; return; }
    r.then((res) => {
      if (S.fetching === loc) S.fetching = null;
      if (res?.ok && Array.isArray(res.nearby)) S.fetched = { location: loc, nearby: res.nearby, origin: res.origin };
      else S.fetchFailed = loc;
      refresh();
    });
  }

  async function send(verb, args, label) {
    if (S.pending) return;
    S.pending = { verb, site: args.site ?? null, name: label, timer: setTimeout(() => finishPending('No answer from the server. Check your connection and try again.', 'error'), ACT_TIMEOUT_MS) };
    setStatus(verb === 'wilderness.leave' ? `Returning to ${label}…` : `Setting out for ${label}…`);
    const r = api.act(verb, args, { quiet: true });
    if (r === false) { finishPending('Not connected — nothing was sent.', 'error'); return; }
    const res = await r;
    if (res && res.ok === false) {
      if (/unknown|stale|no such|not found|invalid site|too far/i.test(String(res.error))) {
        S.fetched = null; S.fetchFailed = null;
        api.act('wilderness.nearby', {}, { quiet: true }); // recompute the list from where we stand
      }
      finishPending(actionErrorText(res.error, verb), 'error');
    }
    // Success: wait for the location change (state) or the scene report.
  }

  function visit(site) {
    const v = view();
    // Guard a stale selection: the row must still be in the current list for this location.
    if (!v.nearby.some((s) => s.id === site.id)) {
      setStatus(`${site.name} is no longer on the list for where you stand. Choose again.`, 'error');
      return;
    }
    send('wilderness.visit', { site: site.id }, site.name);
  }

  function leave() {
    const v = view();
    send('wilderness.leave', {}, v.returnName ?? 'town');
  }

  // ---------------------------------------------------------------- events

  // After the character really moves, close the menu so the new scene is in view.
  function arrived(text) {
    S.awaiting = null;
    if (S.pending) finishPending(text, 'ok');
    else setStatus(text, 'ok');
    if (api.panel === PANEL_ID) api.closePanel?.();
  }
  api.on('state', () => {
    const a = S.pending ?? S.awaiting;
    if (!a) return;
    const v = view();
    if (a.verb === 'wilderness.visit' && v.atSite && (v.siteId === a.site || v.here?.id === a.site)) {
      arrived(`You arrive at ${a.name}.`);
    } else if (a.verb === 'wilderness.leave' && !v.inWilds && !v.atSite) {
      arrived(`You are back in ${townName(v.location) ?? a.name}.`);
    }
  });
  api.on('location', () => { S.fetched = null; S.fetchFailed = null; refresh(); });
  api.on('wildernessScene', (d) => {
    if (!isObj(d)) return;
    S.scene = d;
    if (d.status === 'error') setStatus(`The site could not be drawn: ${d.message || 'unknown error'}.`, 'error');
    else refresh();
  });
  api.on('event', (ev) => {
    if (!isObj(ev) || ev.kind !== 'wilderness') return;
    if (S.pending) {
      // The server's game event can arrive before the snapshot that moves us; keep watching for it.
      const { verb, site, name } = S.pending;
      if (verb === 'wilderness.visit' || verb === 'wilderness.leave') S.awaiting = { verb, site, name };
      finishPending(ev.text ?? '', ev.ok === false ? 'error' : 'ok');
    }
    else if (ev.text) setStatus(ev.text);
  });
  api.on('screen', (screen) => { if (screen !== 'game' && S.pending) finishPending(''); });

  // ---------------------------------------------------------------- panel

  api.registerPanel(PANEL_ID, PANEL_TITLE, render, {
    key: PANEL_KEY,
    order: 4.5, // beside the travel map
    watch: (s) => {
      const c = s?.character;
      return [c?.location ?? s?.location ?? null, c?.wilderness ?? s?.wilderness ?? null];
    },
  });

  function render(container) {
    const v = view();
    maybeFetch(v);
    const root = el('section', { class: 'wld', 'aria-labelledby': 'wld-heading' });

    // Heading and where you stand
    const where = v.atSite
      ? `You are at ${v.here?.name ?? 'a wilderness site'}${v.here ? ` (${v.here.kindLabel.toLowerCase()})` : ''}${v.region ? `, ${v.region}` : ''}.`
      : v.inWilds ? `You are in the wilderness${v.region ? ` of ${v.region}` : ''}, map square ${v.pixel.px}, ${v.pixel.py}.`
        : townName(v.location) ? `You are in ${townName(v.location)}${v.region ? `, ${v.region}` : ''}.` : '';
    root.append(el('header', { class: 'wld-head' },
      el('h3', { id: 'wld-heading', class: 'wld-h', text: 'Sites in the wilderness' }),
      el('p', { class: 'wld-where', text: where }),
    ));

    // Live status (pending action, scene progress, errors)
    let statusText = S.status;
    if (!statusText && v.atSite && S.scene?.location === v.location) {
      if (S.scene.status === 'loading') statusText = 'Loading the site…';
    }
    root.append(el('p', {
      class: `wld-status${S.statusKind ? ` wld-${S.statusKind}` : ''}`, role: S.statusKind === 'error' ? 'alert' : 'status', 'aria-live': 'polite',
    }, statusText || ''));

    const treasure = treasureInReach();
    if (treasure) root.append(el('button', {
      type: 'button', class: 'wld-btn wld-btn-main', onclick: () => search(treasure),
    }, 'Search nearby treasure'));

    // Return to town
    if ((v.atSite || v.inWilds) && v.returnTo) {
      root.append(el('div', { class: 'wld-box wld-here' },
        el('p', { class: 'wld-dim' }, v.atSite && v.here?.pos ? `Map square ${v.here.pos.px}, ${v.here.pos.py}` : 'The road back leads to the town you set out from.'),
        el('button', {
          type: 'button', class: 'wld-btn wld-btn-main', 'data-focus-key': 'wld-return', disabled: !!S.pending,
          onclick: leave,
        }, v.returnName ? `Return to ${v.returnName}` : 'Return to town'),
      ));
    }

    // Pack / list availability
    if (v.pack === 'missing' || v.pack === 'error') {
      root.append(el('div', { class: 'wld-box wld-empty', role: 'note' },
        el('p', {}, v.pack === 'missing' ? 'The World of Daggerfall site pack is not installed on this server, so no wilderness sites can be visited yet.' : 'The World of Daggerfall site pack could not be read on this server.'),
        v.packNote ? el('p', { class: 'wld-dim' }, v.packNote) : null,
        el('p', { class: 'wld-dim' }, 'You can still travel between towns from the travel map.'),
        travelLink(),
      ));
    } else if (v.pack === 'unknown' || v.pack === 'loading') {
      root.append(el('div', { class: 'wld-box wld-empty', role: 'note' },
        el('p', {}, v.pack === 'loading' ? 'The server is still reading the World of Daggerfall site pack. Try again in a moment.' : 'This server has not reported any wilderness sites.'),
        travelLink(),
      ));
    } else if (!v.listKnown && !S.fetched) {
      root.append(el('p', { class: 'wld-dim' }, S.fetchFailed === api.location ? 'The server could not list nearby sites.' : 'Asking the server for nearby sites…'));
    } else {
      root.append(siteList(v));
    }

    if (v.pack === 'ready') {
      const picker = el('input', {
        type: 'file', webkitdirectory: true, multiple: true, hidden: true,
        onchange: async () => {
          const files = Array.from(picker.files);
          if (!files.length) return;
          const seq = ++S.packSelection;
          try {
            const { folderWodPack } = await import('../world/wilderness/localPack.js');
            const selected = await folderWodPack(files);
            if (seq !== S.packSelection) return;
            S.packLabel = 'World of Daggerfall models loaded from your folder.';
            api.emit('wildernessPack', selected);
            setStatus(S.packLabel, 'ok');
          } catch (err) {
            if (seq === S.packSelection) setStatus(err.message, 'error');
          }
        },
      });
      root.append(el('details', { class: 'wld-box' },
        el('summary', {}, 'World of Daggerfall model files'),
        el('p', { class: 'wld-dim' }, S.packLabel || 'Use your own World of Daggerfall source folder for custom rocks, mountains and bridges. Localhost loads the installed pack automatically.'),
        el('button', { type: 'button', class: 'wld-btn', onclick: () => picker.click() }, 'Choose mod folder…'), picker));
    }
    container.replaceChildren(root);
  }

  function travelLink() {
    return el('button', { type: 'button', class: 'wld-btn wld-btn-quiet', onclick: () => api.openPanel?.('map') }, 'Open the travel map');
  }

  function siteList(v) {
    const box = el('div', { class: 'wld-box' });
    const kinds = [...new Set(v.nearby.map((s) => s.kindLabel))].sort();
    if (S.filter !== 'all' && !kinds.includes(S.filter)) S.filter = 'all';
    const shown = v.nearby.filter((s) => S.filter === 'all' || s.kindLabel === S.filter);
    const head = el('div', { class: 'wld-listhead' },
      el('h4', { class: 'wld-h4', id: 'wld-list-h' }, v.atSite ? 'Other sites nearby' : 'Nearby sites'),
    );
    if (kinds.length > 1) {
      const sel = el('select', { class: 'wld-filter', id: 'wld-filter', 'aria-label': 'Show kind of site', onchange: (e) => { S.filter = e.target.value; refresh(); } },
        el('option', { value: 'all' }, 'All kinds'), ...kinds.map((k) => el('option', { value: k }, k)));
      sel.value = S.filter;
      head.append(sel);
    }
    box.append(head);
    const others = shown.filter((s) => !(v.atSite && (s.id === v.siteId || s.location === v.siteId)));
    if (!others.length) {
      box.append(el('p', { class: 'wld-dim' }, v.nearby.length ? 'No sites of that kind nearby.' : 'There are no recorded sites near here. Travel to another town, then look again.'));
      return box;
    }
    const list = el('ul', { class: 'wld-list', 'aria-labelledby': 'wld-list-h' });
    for (const s of others) {
      const dir = s.bearing ? `${s.bearing.name}` : '';
      const dist = distanceText(s.distance);
      const where = [dist, dir].filter(Boolean).join(' ');
      const busy = S.pending?.site === s.id;
      const fresh = !s.discovered;
      list.append(el('li', { class: `wld-site${busy ? ' wld-busy' : ''}`, dataset: { site: s.id } },
        el('span', { class: 'wld-tag', title: s.kind ?? '' }, s.kindLabel),
        el('span', { class: 'wld-name' }, s.name, fresh ? el('span', { class: 'wld-new', title: 'You have not been here yet' }, ' new') : null, s.region && s.region !== v.region ? el('span', { class: 'wld-region' }, ` · ${s.region}`) : null),
        el('span', { class: 'wld-dir', 'aria-hidden': 'true', title: dir }, s.bearing?.arrow ? `${s.bearing.arrow} ${s.bearing.short}` : ''),
        el('span', { class: 'wld-dist' }, dist),
        el('button', {
          type: 'button', class: 'wld-btn', 'data-focus-key': `wld-visit-${s.id}`,
          disabled: !!S.pending || !s.available,
          'aria-label': `Visit ${s.name}, ${s.kindLabel.toLowerCase()}${where ? `, ${where}` : ''}${fresh ? ', not visited yet' : ''}`,
          title: s.available ? undefined : s.note ?? 'Not available',
          onclick: () => visit(s),
        }, busy ? 'Going…' : 'Visit'),
      ));
    }
    box.append(list);
    const within = v.radius ? ` within ${distanceText(v.radius)}` : '';
    box.append(el('p', { class: 'wld-dim wld-small' }, `${others.length} ${others.length === 1 ? 'site' : 'sites'}${within}, recorded by the World of Daggerfall project. Directions are from ${v.atSite ? 'this site' : 'where you stand'}.`));
    return box;
  }

  // Shortcut handled by main.js through the panel's `key`; nothing else to bind here.
  return { view, visit, leave };
}
