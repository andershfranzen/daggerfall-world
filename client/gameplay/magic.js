// Spellbook panel, readied-spell HUD chip and first-person casting hands.
// The server owns spells, magicka and effects (server/rpg/magic.js); this module only shows them,
// sends magic.* intents and plays the classic C6 casting animation from the player's own files.
import {
  CAST_FILES, ICON_FILE, ICON_COUNT, CAST_SEQUENCE, CAST_FRAME_S,
  readImageRecords, toRgba, iconPixels, handRects,
} from './magic/art.js';
import {
  TARGET_LABEL, ELEMENT_LABEL, SUPPORT_LABEL, magicOf, statsOf, spellRows, effectLines, magickaCost, eventText,
} from './magic/model.js';
import { artCanvas, ClassicUiArt } from '../hud/classic-art.js';
import { installMaker } from './magic/maker.js';
import { installDetectionCompass } from './magic/detection.js';

/** Remaining duration text: a worn item's held bundle lasts as long as the item is worn (no round countdown). */
export function activeDuration(a) {
  if (a?.bundleType === 'held' && a.source?.itemId) return `while ${a.source.itemName || 'the item'} is worn`;
  return `${a.roundsLeft} round${a.roundsLeft === 1 ? '' : 's'}`;
}

export const CAST_KEY = 'KeyV'; // R opens Rest; V is unbound

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

function imageCanvas(img, palette) {
  return artCanvas(img.width, img.height, toRgba(img, palette));
}

export function install(api) {
  if (typeof document === 'undefined') return;

  let catalogue = null; // public spells from the server
  let source = null;
  let requiresSeller = false;
  let shopCounter = null;
  let requested = false;
  let container = null;
  const ui = { tab: 'known', focus: null, query: '' };

  // ---------------------------------------------------------------- local art
  let art = new ClassicUiArt(api.files);
  const anims = new Map();
  const iconCache = new Map();
  let castRequest = 0;
  const missiles = new Map();
  const openMaker = installMaker(api, el, icon);
  const showDetection = installDetectionCompass(api, document.getElementById('hud-compass'), el);
  let spellChoice;

  api.registerPanel('spellchoice', 'Spell effect', (root) => {
    if (!spellChoice) {
      root.replaceChildren();
      return;
    }
    const { spellId, items, hasAnchor, choice, token, options } = spellChoice;
    if (options) {
      const pick = (text, args) => el('button', {
        type: 'button', class: 'mg-btn', text, onclick: () => api.act('magic.choose', { token, ...args }),
      });
      const conjuring = choice === 'createItem';
      root.replaceChildren(el('div', { class: 'mg-root mg-choice' },
        el('h3', { text: conjuring ? 'Choose equipment to conjure' : 'Choose a spell to dispel' }),
        options.length ? el('div', { class: 'mg-choice-grid' }, options.map(({ index, name }) => pick(name, { index })))
          : el('p', { text: 'You have no spells that can be dispelled.' }),
        conjuring ? null : pick('Cancel', { cancel: true }),
      ));
      return;
    }
    const choose = (args) => {
      spellChoice = null;
      api.closePanel();
      api.act('magic.cast', { spellId, ...args });
    };
    const button = (text, args, disabled = false) => el('button', {
      type: 'button', class: 'mg-btn', text, disabled, onclick: () => choose(args),
    });
    root.replaceChildren(el('div', { class: 'mg-root' }, el('div', { class: 'mg-actions' }, items
      ? items.map(({ id, name }) => button(name, { itemId: id }))
      : [button('Set anchor here', { recall: 'anchor' }), button('Return to anchor', { recall: 'return' }, !hasAnchor)])));
  }, { watch: 'none', listed: false });

  function castFrames(element) {
    if (!anims.has(element)) {
      const source = art;
      const name = CAST_FILES[element] ?? CAST_FILES.magic;
      const frames = Promise.all([source.palette(), source.bytes(name)]).then(([pal, bytes]) => {
        if (!pal || !bytes) return null;
        return readImageRecords(bytes, name).map((img) => imageCanvas(img, pal));
      }).catch((err) => { console.warn('[magic]', err.message); return null; });
      anims.set(element, frames);
    }
    return anims.get(element);
  }

  function iconUrl(index) {
    if (!iconCache.has(index)) {
      const image = Promise.all([art.palette(), art.bytes(ICON_FILE)]).then(([pal, bytes]) => {
        if (!pal || !bytes) return null;
        return imageCanvas(iconPixels(bytes, index), pal).toDataURL();
      }).catch(() => null);
      iconCache.set(index, image);
    }
    return iconCache.get(index);
  }

  function showIcon(box, result) {
    const source = art;
    result.then((url) => {
      if (source !== art || !url) return;
      box.append(el('img', { src: url, alt: '' }));
      box.hidden = false;
    });
    return box;
  }

  function icon(spell, cls = 'mg-icon') {
    const slot = el('span', { class: 'mg-icon-slot', 'aria-hidden': 'true' });
    const index = spell?.icon;
    if (Number.isInteger(index) && index >= 0 && index < ICON_COUNT) {
      slot.append(showIcon(el('span', { class: cls, hidden: true }), iconUrl(index)));
    }
    return slot;
  }

  function spellSymbol(kind, name) {
    const isTarget = kind === 'target';
    const index = Object.keys(isTarget ? TARGET_LABEL : ELEMENT_LABEL).indexOf(name);
    if (index < 0) return null;
    const key = `${kind}:${index}`;
    if (!iconCache.has(key)) {
      const rect = isTarget ? [0, index * 16, 24, 16] : [24, index * 16, 16, 16];
      iconCache.set(key, art.picture('MASK04I0.IMG', rect, true).then((c) => c?.toDataURL()));
    }
    return showIcon(el('span', { class: 'mg-symbol', hidden: true, 'aria-hidden': 'true' }), iconCache.get(key));
  }

  api.on('assets', (list) => {
    art = new ClassicUiArt(list);
    anims.clear();
    iconCache.clear();
    castRequest++;
    cast = null;
    hands.hidden = true;
    rerender();
    updateChip();
  });

  // ---------------------------------------------------------------- casting hands overlay
  const hands = el('canvas', { class: 'fp-spell', 'aria-hidden': 'true', hidden: true });
  const view = document.getElementById('view');
  const weapon = document.querySelector('canvas.fp-weapon');
  const anchor = weapon ?? view;
  if (anchor?.parentNode) anchor.parentNode.insertBefore(hands, anchor.nextSibling);
  else document.body.append(hands);
  const flash = el('div', { class: 'mg-flash', 'aria-hidden': 'true', hidden: true });
  document.body.append(flash);
  let cast = null; // { frames, element, t }
  let screen = api.screen ?? null;

  async function playCast(element) {
    const request = ++castRequest;
    const frames = await castFrames(element);
    if (screen !== 'game' || request !== castRequest) return;
    api.emit('magic:cast', { element, art: !!frames });
    if (!frames?.length) return;
    cast = { frames, element, t: 0 };
    hands.hidden = false;
  }

  function drawHands(dt) {
    if (!cast) return;
    const step = Math.floor(cast.t / CAST_FRAME_S);
    if (step >= CAST_SEQUENCE.length || screen !== 'game') { cast = null; hands.hidden = true; return; }
    const w = innerWidth, h = innerHeight;
    if (hands.width !== w || hands.height !== h) { hands.width = w; hands.height = h; }
    const g = hands.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.imageSmoothingEnabled = false;
    const idx = Math.min(CAST_SEQUENCE[step], cast.frames.length - 1);
    const img = cast.frames[idx];
    const r = handRects(w, h, img, idx, cast.element);
    g.drawImage(img, r.left.x, r.left.y, r.left.w, r.left.h);
    g.save();
    g.translate(r.right.x + r.right.w, r.right.y);
    g.scale(-1, 1);
    g.drawImage(img, 0, 0, r.right.w, r.right.h);
    g.restore();
    cast.t += dt;
  }

  function flashElement(element) {
    flash.dataset.element = element ?? 'magic';
    flash.hidden = false;
    flash.classList.remove('mg-flash-on');
    void flash.offsetWidth;
    flash.classList.add('mg-flash-on');
    setTimeout(() => { flash.hidden = true; }, 600);
  }

  const projectileLayer = el('div', { class: 'mg-projectiles', 'aria-hidden': true });
  document.body.append(projectileLayer);
  function drawMissiles(renderer) {
    const now = performance.now();
    for (const [id, m] of missiles) {
      const elapsed = (now - m.started) / 1000;
      const d = Math.max(0, elapsed * m.speed);
      if (m.location !== api.location || d > m.range || (m.end && elapsed > 0.28)) {
        m.node.remove();
        missiles.delete(id);
        continue;
      }
      const q = m.end ?? { x: m.x + m.direction.x * d, y: m.y + m.direction.y * d, z: m.z + m.direction.z * d };
      const p = renderer?.project(q.x, q.y, q.z);
      m.node.hidden = !p || p.depth < 0.5;
      if (p) {
        const scale = Math.max(0.45, Math.min(m.end ? 3 : 1.8, 7 / p.depth));
        m.node.style.transform = `translate(${p.x}px,${p.y}px) translate(-50%,-50%) scale(${scale})`;
      }
    }
  }
  api.on('location', () => {
    shopCounter = null;
    ui.tab = 'known';
    for (const { node } of missiles.values()) node.remove();
    missiles.clear();
    spellChoice = null;
    api.emit('automap:markers', { source: 'magic', location: api.location, markers: [] });
  });
  api.on('panel', (panel) => {
    if ((panel.id === 'spellbook' && !panel.open) || (panel.id !== 'spellbook' && panel.open)) {
      shopCounter = null;
      ui.tab = 'known';
    }
    if (panel.id === 'spellchoice' && !panel.open && spellChoice?.choice === 'dispel') {
      const { token } = spellChoice;
      spellChoice = null;
      api.act('magic.choose', { token, cancel: true }, { quiet: true });
    }
  });
  api.on('frame', ({ dt, renderer } = {}) => {
    drawHands(Number(dt) || 0.016);
    drawMissiles(renderer);
    const hide = !selectedSpell() || screen !== 'game' || api.modalOpen;
    if (chip.hidden !== hide) chip.hidden = hide;
  });
  api.on('screen', (name) => {
    screen = typeof name === 'string' ? name : name?.screen ?? null;
    if (screen !== 'game') {
      castRequest++;
      hands.hidden = true;
      cast = null;
      shopCounter = null;
      ui.tab = 'known';
    }
    chip.hidden = screen !== 'game' || !selectedSpell();
  });

  // ---------------------------------------------------------------- HUD chip (readied spell)
  const chip = el('button', { type: 'button', class: 'mg-chip', hidden: true, title: 'Readied spell — V to cast, B for spellbook' });
  (document.getElementById('hud') ?? document.body).append(chip);
  chip.addEventListener('click', () => api.openPanel('spellbook'));

  function selectedSpell() {
    const id = magicOf(api.state).selected;
    return id ? catalogue?.find((s) => String(s.id) === id) ?? null : null;
  }
  function updateChip() {
    const sp = selectedSpell();
    chip.replaceChildren();
    chip.hidden = !sp || (screen !== null && screen !== 'game');
    if (!sp) return;
    const cost = magickaCost(sp, statsOf(api.state)?.skills);
    const mana = statsOf(api.state)?.magicka;
    chip.dataset.short = String(Number.isFinite(mana) && mana < cost);
    chip.append(icon(sp, 'mg-icon mg-icon-sm'), el('span', { class: 'mg-chip-name', text: sp.name }), el('span', { class: 'mg-chip-cost', text: `${cost}` }), el('kbd', { text: 'V' }));
  }

  // ---------------------------------------------------------------- intents
  function castSelected(spellId) {
    const sp = spellId ? catalogue?.find((s) => String(s.id) === String(spellId)) : selectedSpell();
    if (!sp) { api.message('No spell is readied. Open the spellbook (B) to choose one.'); return; }
    const args = { spellId: String(sp.id) };
    const t = api.target ? api.entity(api.target) : null;
    if (t && sp.targetType !== 'caster' && sp.targetType !== 'areaAroundCaster') {
      const wantsPlayer = !sp.harmful;
      if ((t.kind === 'player') === wantsPlayer && (wantsPlayer || t.kind === 'monster')) args.targetId = t.kind === 'player' ? `player:${t.id}` : String(t.id);
    }
    if (Number.isFinite(api.camera?.yaw)) args.yaw = api.camera.yaw;
    if (Number.isFinite(api.camera?.pitch)) args.pitch = api.camera.pitch;
    api.act('magic.cast', args);
  }

  window.addEventListener('keydown', (e) => {
    if (e.code !== CAST_KEY || e.repeat || e.ctrlKey || e.metaKey || e.altKey || api.modalOpen || screen !== 'game') return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    castSelected();
  });

  // ---------------------------------------------------------------- server events
  api.on('state', () => {
    if (!catalogue && !requested && api.state?.character) { requested = true; api.act('magic.catalogue'); }
    updateChip();
    rerender();
  });
  api.on('event', (msg) => {
    const ev = msg?.event ?? msg;
    if (!ev?.kind) return;
    if (ev.kind === 'spellCatalogue') {
      catalogue = Array.isArray(ev.spells) ? ev.spells : [];
      requiresSeller = ev.requiresSeller === true;
      if (requiresSeller && !shopCounter) ui.tab = 'known';
      source = ev.source;
      api._spellCatalogue = catalogue.map((s) => ({ ...s, cost: magickaCost(s, statsOf(api.state)?.skills) }));
      updateChip();
      rerender();
      return;
    }
    if (ev.kind === 'spellMaker') { openMaker(ev); return; }
    if (ev.kind === 'spellShop') {
      shopCounter = ev.counter ?? null;
      ui.tab = 'learn';
      ui.focus = null;
      api.openPanel('spellbook');
      return;
    }
    if (ev.kind === 'spellRecallChoice' || ev.kind === 'spellIdentifyChoice' || ev.kind === 'spellEffectChoice') {
      spellChoice = ev;
      if (api.panel === 'spellchoice') api.refreshPanel('spellchoice');
      else api.openPanel('spellchoice');
      return;
    }
    if (ev.kind === 'spellChoiceClosed') {
      spellChoice = null;
      if (api.panel === 'spellchoice') api.closePanel();
      return;
    }
    if (ev.kind === 'spellDetection') {
      showDetection(ev);
      api.emit('automap:markers', { source: 'magic', location: ev.location, markers: ev.markers });
      return;
    }
    const self = String(api.selfId ?? api.state?.selfId ?? '');
    if (ev.kind === 'spellCast') {
      if (!ev.casterKind && String(ev.casterId) === self) playCast(ev.element);
      if (ev.missile) {
        const node = el('span', { class: 'mg-missile', dataset: { element: ev.element }, hidden: true });
        projectileLayer.append(node);
        missiles.set(ev.missile.id, { ...ev.missile, node, x: ev.x, y: ev.y, z: ev.z, started: performance.now() });
      }
      if (ev.targetIds?.includes(`player:${self}`)) flashElement(ev.element);
    }
    if (ev.kind === 'spellImpact') {
      const m = missiles.get(ev.missileId);
      if (m && ev.center && ev.reason !== 'range') {
        m.end = ev.center;
        m.started = performance.now();
        m.node.classList.add('mg-missile-impact');
      } else if (m) { m.node.remove(); missiles.delete(ev.missileId); }
      if (ev.targetIds?.includes(`player:${self}`)) flashElement(ev.element);
    }
    const text = eventText(ev, self);
    if (text) api.message(text);
    if (ev.kind === 'spellLearned') rerender();
  });

  // ---------------------------------------------------------------- panel
  function rerender() { if (container?.isConnected) render(container); }

  function detail(sp) {
    if (!sp) return el('p', { class: 'mg-empty', text: 'Choose a spell to see what it does.' });
    const stats = statsOf(api.state);
    const mana = stats?.magicka;
    const rows = [
      ['Target', TARGET_LABEL[sp.targetType] ?? sp.targetType, spellSymbol('target', sp.targetType)],
      ['Element', ELEMENT_LABEL[sp.element] ?? sp.element, spellSymbol('element', sp.element)],
      ['Schools', (sp.schools ?? []).join(', ')],
      ['Magicka', `${sp.cost}${Number.isFinite(mana) ? ` (you have ${Math.floor(mana)})` : ''}`],
      ...(!sp.known ? [['Price', `${sp.price} gold`]] : []),
      ['Status', SUPPORT_LABEL[sp.support] ?? sp.support],
    ];
    const actions = [];
    if (sp.known) {
      actions.push(el('button', { type: 'button', class: 'mg-btn mg-btn-primary', disabled: !sp.castable, 'data-focus-key': 'cast', onclick: () => { api.closePanel(); castSelected(sp.id); }, text: 'Cast' }));
      actions.push(el('button', { type: 'button', class: 'mg-btn', disabled: sp.selected || !sp.castable, onclick: () => api.act('magic.select', { spellId: String(sp.id) }), text: sp.selected ? 'Readied' : 'Ready (V casts)' }));
      if (!sp.innate) actions.push(el('button', { type: 'button', class: 'mg-btn mg-btn-quiet', onclick: () => { if (confirm(`Remove ${sp.name} from your spellbook?`)) api.act('magic.forget', { spellId: String(sp.id) }); }, text: 'Remove' }));
    } else {
      const gold = api.state?.character?.gold;
      actions.push(el('button', {
        type: 'button', class: 'mg-btn mg-btn-primary', disabled: !sp.castable || (Number.isFinite(gold) && gold < sp.price),
        onclick: () => api.act('magic.learn', { ...shopCounter, spellId: String(sp.id), expectCost: sp.price }), text: sp.castable ? `Learn for ${sp.price} gold` : 'Unavailable',
      }));
    }
    return el('article', { class: 'mg-detail' },
      el('header', { class: 'mg-detail-head' }, icon(sp, 'mg-icon mg-icon-lg'), el('h3', { text: sp.name })),
      el('dl', { class: 'mg-facts' }, rows.flatMap(([k, v, icon]) => [el('dt', { text: k }), el('dd', {}, icon, v)])),
      el('h4', { class: 'mg-h4', text: 'Effects' }),
      el('ul', { class: 'mg-effects' }, (sp.effects ?? []).map((e) => el('li', { dataset: { support: e.support } },
        el('strong', { text: e.name }), el('span', { class: 'mg-school', text: e.school }),
        ...effectLines(e).map((l) => el('span', { class: 'mg-line', text: l })),
        e.support === 'unsupported' ? el('span', { class: 'mg-note mg-bad', text: `Not supported: ${e.reason}.` }) : null))),
      el('div', { class: 'mg-actions' }, actions));
  }

  function render(root) {
    container = root;
    const focusKey = document.activeElement?.dataset?.focusKey;
    root.replaceChildren();
    root.classList.add('mg-root');
    const stats = statsOf(api.state);
    const { known, learnable } = spellRows(catalogue, api.state, { query: ui.query });
    const m = magicOf(api.state);
    const list = ui.tab === 'known' ? known : learnable;
    let focus = list.find((s) => String(s.id) === ui.focus) ?? list[0] ?? null;
    ui.focus = focus ? String(focus.id) : null;

    const mana = Number.isFinite(stats?.magicka) ? `${Math.floor(stats.magicka)} / ${stats.maxMagicka}` : '—';
    root.append(el('header', { class: 'mg-head' },
      el('div', { class: 'mg-tabs', role: 'tablist' },
        (requiresSeller && !shopCounter ? ['known'] : ['known', 'learn']).map((t) => el('button', {
          type: 'button', role: 'tab', class: 'mg-tab', 'aria-selected': String(ui.tab === t), 'data-focus-key': `tab-${t}`,
          onclick: () => { ui.tab = t; ui.focus = null; render(root); },
          text: t === 'known' ? `Spellbook (${m.known.length})` : 'Learn spells',
        }))),
      el('input', { class: 'mg-search', type: 'search', placeholder: 'Find spell or school', value: ui.query, 'aria-label': 'Find spell',
        oninput: (e) => { ui.query = e.target.value; render(root); root.querySelector('.mg-search')?.focus(); } }),
      el('span', { class: 'mg-mana', text: `Magicka ${mana}` })));

    if (!catalogue) {
      root.append(el('p', { class: 'mg-empty', text: 'Waiting for the spell list from the server…' }));
      return;
    }
    const items = list.map((sp) => el('li', {},
      el('button', {
        type: 'button', class: 'mg-row', 'aria-pressed': String(String(sp.id) === ui.focus), 'data-focus-key': `row-${sp.id}`,
        dataset: { support: sp.support, selected: String(sp.selected) },
        onclick: () => { ui.focus = String(sp.id); render(root); },
        ondblclick: () => { if (sp.known && sp.castable) { api.closePanel(); castSelected(sp.id); } },
      }, icon(sp), el('span', { class: 'mg-row-name', text: sp.name }), el('span', { class: 'mg-row-cost', text: sp.known ? `${sp.cost} mp` : `${sp.price} g` }),
      sp.selected ? el('span', { class: 'mg-badge', text: 'readied' }) : null)));
    root.append(el('div', { class: 'mg-layout' },
      el('ul', { class: 'mg-list', 'aria-label': ui.tab === 'known' ? 'Known spells' : 'Spells for sale' },
        items.length ? items : el('li', { class: 'mg-empty', text: ui.tab === 'known' ? 'You know no spells yet.' : 'No spells match.' })),
      detail(focus)));
    root.append(el('footer', { class: 'mg-foot', text: `Spells from ${source === 'SPELLS.STD' ? 'the server’s SPELLS.STD' : 'the built-in list'} · V casts the readied spell at your crosshair target · ${m.active.length ? `${m.active.length} active effect${m.active.length > 1 ? 's' : ''} on you` : 'no active effects'}` }));
    if (m.active.length) {
      root.append(el('ul', { class: 'mg-active' }, m.active.map((a) => el('li', { text: `${a.spellName ?? a.name}: ${a.name} · ${activeDuration(a)}` }))));
    }
    if (focusKey) root.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus();
  }

  api.registerPanel('spellbook', 'Spellbook', render);
}
