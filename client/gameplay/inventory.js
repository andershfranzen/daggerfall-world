// Inventory screen: equipment (dressed paper doll, slots with armour ratings), the classic tabbed
// pack list, an inspector that compares an item with what it would replace, an action bar with
// in-panel feedback (both in the right-hand column), gold and carried weight, and nearby loot piles.
// Server rules: server/rpg/inventory.js. Contract: client/gameplay/inventory/CONTRACT.md.

import { getItemArtSource } from './inventory/icons.js';
import { slotAt, DOLL_WIDTH, DOLL_HEIGHT } from './inventory/paperdoll.js';
import {
  TABS, SLOT_ORDER, SLOT_PART, pendingLabel, itemsForTab, matchesQuery, carriedWeight, maxEncumbrance, armorValues, describe, primaryAction, tabOf,
  fitsSlot, isWearable, hasUsePower, jewelSlots, slotLabel, compareItem, conditionPct, conditionLabel, needsCare, kindOf, itemCharges,
} from './inventory/model.js';

const ALL_TAB = Object.freeze({ id: 'all', label: 'All' });
const PANEL_TABS = Object.freeze([ALL_TAB, ...TABS]);

const REPAIR_PANEL = 'townServices';

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};

const qtyName = (it) => (it.quantity > 1 ? `${it.name} ×${it.quantity}` : it.name);
const kg = (n) => `${(Number(n) || 0).toFixed(2)} kg`;

/** One-line key stat for list rows and slots. */
function keyStat(it) {
  if (!it) return '';
  if (it.damage) return `${it.damage.min}–${it.damage.max} dmg`;
  if (it.armorValue) return `AR ${it.armorValue}`;
  if (it.effect) return `+${it.effect.amount} ${it.effect.stat}`;
  return '';
}

/** Panel re-render key: only what this screen shows (not vitals or peers). */
export function inventoryWatch(state) {
  const c = state?.character;
  const ch = c?.character || {};
  return [
    c?.inventory, c?.equipment, c?.gold, c?.weaponView,
    ch.race, ch.gender, ch.faceIndex, ch.className, ch.effectiveAttributes?.Strength ?? ch.attributes?.Strength,
    (state?.entities || []).filter((e) => e.kind === 'loot').map((e) => [e.id, e.name, e.count]),
    c?.lightSource?.itemId,
  ];
}

export function install(api) {
  // Shared art source (inventory/icons.js) owns decoded icons, cached dolls and the file lifecycle.
  const icons = getItemArtSource(api);
  const GOLD = { template: 'gold', name: 'Gold' };
  const ui = { tab: 'weapons', selected: null, query: '', slotFilter: null, loot: null, dropQty: 1, status: null, pending: null, listScroll: 0, book: null };
  let container = null;

  const rpg = () => api.state?.character ?? null;

  /** Redraw in place, keeping focus and the panel's scroll position. */
  const rerender = () => {
    if (!container?.isConnected) return;
    const active = document.activeElement;
    const fk = active && container.contains(active) ? (active.dataset.focusKey || (active.id ? `#${active.id}` : null)) : null;
    const scroller = container.closest('#menu-panel') || container.parentElement;
    const top = scroller?.scrollTop;
    render(container);
    if (scroller && top != null) scroller.scrollTop = top;
    if (fk) focusKey(fk);
  };
  const focusKey = (fk) => {
    const n = fk.startsWith('#') ? container?.querySelector(fk.replace(/^#(.*)$/, (_, id) => `#${CSS.escape(id)}`))
      : container?.querySelector(`[data-focus-key="${CSS.escape(fk)}"]`);
    n?.focus({ preventScroll: true });
    return !!n;
  };

  api.on('assets', () => rerender());
  api.on('state', () => {
    // Close the loot view when the pile disappears (the shell redraws via `inventoryWatch`).
    if (ui.loot && !ui.loot.container && !(api.state?.entities || []).some((e) => e.id === ui.loot.targetId)) { ui.loot = null; rerender(); }
  });
  api.on('event', (ev) => {
    if (!ev) return;
    // The shell's message log also shows inventory text; the panel repeats the latest one in place.
    if (ev.kind === 'inventory' && ev.text) { ui.status = { text: ev.text, kind: 'ok' }; ui.pending = null; rerender(); }
    if (ev.kind === 'loot' && ev.targetId) { ui.loot = ev; rerender(); }
    // Shared containers (server/rpg/containers.js) reuse the loot view with their own verbs.
    if (ev.kind === 'container' && ev.containerId) {
      if (ev.refreshed && ui.loot?.targetId !== ev.containerId) return;
      ui.loot = { ...ev, targetId: ev.containerId, container: true };
      ui.book = null;
      api.openPanel('inventory');
      rerender();
    }
    if (ev.kind === 'book' && Array.isArray(ev.pages)) { ui.book = { ...ev, page: 0 }; api.openPanel('inventory'); rerender(); }
  });

  // Furniture containers are 3D models without a sprite, so the sprite picker never targets them. Like the classic
  // activation ray, G with no sprite target opens the container the player faces within reach (3.2 m).
  api.on('interactIntent', (d) => {
    if (d.handled || d.entity?.kind === 'container') return;
    const cam = api.camera;
    if (!cam) return;
    // A sprite target (person, creature, pile) wins unless the furniture is nearer, like the first hit of the ray.
    const targetDist = d.entity && Number.isFinite(d.entity.x) ? Math.hypot(d.entity.x - cam.x, d.entity.z - cam.z) : Infinity;
    let best = null;
    for (const e of api.state?.entities || []) {
      if (e.kind !== 'container') continue;
      const dx = e.x - cam.x, dz = e.z - cam.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 3.4 || (Number.isFinite(e.y) && Number.isFinite(cam.y) && Math.abs(e.y - cam.y) > 3)) continue;
      const off = Math.atan2(Math.sin(Math.atan2(dx, -dz) - cam.yaw), Math.cos(Math.atan2(dx, -dz) - cam.yaw));
      if (Math.abs(off) > (dist < 1 ? 1.2 : 0.7)) continue;
      const score = dist + Math.abs(off) * 2;
      if (!best || score < best.score) best = { e, score };
    }
    if (!best || Math.hypot(best.e.x - cam.x, best.e.z - cam.z) >= targetDist) return;
    d.preventDefault();
    api.act('container.open', { containerId: String(best.e.id) });
  });

  const act = (verb, args, pendingText) => {
    ui.pending = verb;
    if (pendingText) ui.status = { text: pendingText, kind: 'pending' };
    rerender();
    let r;
    try { r = api.act(verb, args); } catch (e) { r = Promise.resolve({ ok: false, error: e?.message || String(e) }); }
    if (r === false) { ui.pending = null; ui.status = { text: 'Not connected — nothing was changed.', kind: 'error' }; rerender(); return; }
    Promise.resolve(r).then((out) => {
      if (ui.pending === verb) ui.pending = null;
      if (out && out.ok === false) {
        const msg = out.error ? out.error[0].toUpperCase() + out.error.slice(1) : 'That did not work.';
        ui.status = { text: msg, kind: 'error' };
      } else if (ui.status?.kind === 'pending') ui.status = null;
      rerender();
    });
  };

  // "I" opens the inventory from the game view.
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || api.modalOpen) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.code === 'KeyI') { e.preventDefault(); api.openPanel('inventory'); }
    });
  }

  function iconImg(item, size = 'md') {
    const box = el('span', { class: `inv-icon inv-icon-${size}`, 'aria-hidden': 'true' });
    const ch = rpg()?.character || {};
    if (item && icons.available) {
      icons.url(item, ch).then((u) => {
        if (u) box.append(el('img', { src: u, alt: '', draggable: 'false' }));
        else box.textContent = (item.name || '?').slice(0, 1);
      });
    } else box.textContent = item ? (item.name || '?').slice(0, 1) : '';
    return box;
  }

  function select(id, { focus = true } = {}) {
    ui.selected = id;
    ui.dropQty = 1;
    const it = rpg()?.inventory?.find((i) => i.id === id);
    if (it && !ui.slotFilter && ui.tab !== 'all') ui.tab = tabOf(it);
    if (ui.status?.kind !== 'pending') ui.status = null;
    rerender();
    if (focus) queueMicrotask(() => {
      const row = container?.querySelector(`.inv-row[data-item-id="${CSS.escape(id)}"]`);
      row?.focus({ preventScroll: true });
    });
  }

  function render(root) {
    container = root;
    root.replaceChildren();
    root.classList.add('inv-root');
    const r = rpg();
    if (!r || !Array.isArray(r.inventory)) {
      root.append(el('p', { class: 'inv-empty', text: 'Your belongings will appear once you are in the world.' }));
      return;
    }
    const inv = r.inventory;
    if (ui.selected && !inv.some((i) => i.id === ui.selected)) ui.selected = null;
    const sel = inv.find((i) => i.id === ui.selected) || null;
    const cmp = sel && isWearable(sel) ? compareItem(r, sel) : null;

    root.append(...[
      summary(r),
      el('div', { class: 'inv-layout' }, equipment(r, sel, cmp), pack(r), side(r, sel, cmp)),
      ui.book ? bookView() : ui.loot ? lootView() : nearbyLoot(),
    ].filter(Boolean));
    const list = root.querySelector('.inv-list');
    if (list) {
      list.scrollTop = ui.listScroll;
      // Keep the selected row in view when equipping re-sorts the list (without scrolling the panel).
      const row = list.querySelector('.inv-row[aria-selected="true"]');
      if (row) {
        const top = row.offsetTop; // .inv-list is position: relative
        if (top < list.scrollTop) list.scrollTop = top;
        else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight;
        ui.listScroll = list.scrollTop;
      }
      list.addEventListener('scroll', () => { ui.listScroll = list.scrollTop; }, { passive: true });
    }
  }

  // ---------------------------------------------------------------- equipment (left)

  function equipment(r, sel, cmp) {
    const ch = r.character || {};
    const sec = el('section', { class: 'inv-equip', 'aria-labelledby': 'inv-equip-h' },
      el('h3', { class: 'inv-h', id: 'inv-equip-h' }, 'Equipment',
        el('span', { class: 'inv-h-sub', text: [ch.race, ch.className].filter(Boolean).join(' ') })));
    sec.append(el('div', { class: 'inv-equip-body' }, dressedFigure(r), slotList(r, sel, cmp)));
    return sec;
  }

  function slotList(r, sel, cmp) {
    const eq = r.equipment || {};
    const av = armorValues(r);
    const delta = new Map((cmp?.armor || []).map(([part, , b, a]) => [part, a - b]));
    const removed = new Set((cmp?.replaces || []).map((i) => i.id));
    const ol = el('ol', { class: 'inv-slots', 'aria-label': 'Equipment slots' });
    const slots = SLOT_ORDER.map(([s]) => s);
    SLOT_ORDER.forEach(([slot, label], n) => {
      const it = r.inventory.find((i) => i.id === eq[slot]) || null;
      const blocked = slot === 'leftHand' && !it && r.inventory.find((i) => i.id === eq.rightHand)?.hands === 'both';
      const part = SLOT_PART[slot];
      const d = part ? delta.get(part) ?? 0 : 0;
      const target = cmp?.mode === 'equip' && cmp.slot === slot;
      const state = it && it.id === ui.selected ? 'selected' : target ? 'target' : it && removed.has(it.id) ? 'removed' : ui.slotFilter === slot ? 'filter' : null;
      const name = it ? it.name : blocked ? 'Two-handed weapon' : 'Empty';
      const desc = [
        `${label}: ${name}`,
        part ? `armor ${av[part]}${d ? `, ${d > 0 ? 'rises' : 'drops'} to ${av[part] + d}` : ''}` : null,
        target ? 'the selected item goes here' : null,
        state === 'removed' ? 'would be taken off' : null,
        !it ? 'show items that fit' : null,
      ].filter(Boolean).join(', ');
      const btn = el('button', {
        type: 'button', class: `inv-slot${it ? '' : ' inv-slot-empty'}`, 'data-slot': slot, 'data-focus-key': `slot-${slot}`,
        'data-state': state, 'aria-label': desc, 'aria-pressed': state === 'selected' || state === 'filter' ? 'true' : 'false',
        onclick: () => {
          if (it) { ui.slotFilter = null; select(it.id, { focus: false }); focusKey(`slot-${slot}`); }
          else { ui.slotFilter = ui.slotFilter === slot ? null : slot; ui.listScroll = 0; rerender(); }
        },
        onkeydown: (e) => {
          if (e.key === 'Home') { e.preventDefault(); focusKey(`slot-${slots[0]}`); return; }
          if (e.key === 'End') { e.preventDefault(); focusKey(`slot-${slots[slots.length - 1]}`); return; }
          if (e.key === 'Enter' && it && state === 'selected') { e.preventDefault(); runPrimary(it); return; }
          const dir = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
          if (!dir) return;
          e.preventDefault();
          focusKey(`slot-${slots[(n + dir + slots.length) % slots.length]}`);
        },
      },
      iconImg(it, 'sm'),
      el('span', { class: 'inv-slot-text' },
        el('span', { class: 'inv-slot-label', text: label }),
        el('span', { class: 'inv-slot-item', text: name })),
      part ? el('span', { class: 'inv-slot-ar', title: `${label} armor rating` }, String(av[part]),
        d ? el('span', { class: `inv-delta ${d > 0 ? 'inv-up' : 'inv-down'}`, text: `${d > 0 ? '+' : '−'}${Math.abs(d)}` }) : null) : el('span'));
      ol.append(el('li', {}, btn));
    });
    return ol;
  }

  /** Dressed classic paper doll, composited from the player's files; null-safe fallback text otherwise. */
  function dressedFigure(r) {
    const ch = r.character || {};
    if (!icons.dollAvailable(ch)) {
      return el('p', { class: 'inv-doll-note', text: icons.available
        ? 'Paper doll art (BODY*.IMG) was not found in your game files; equipment is listed here.'
        : 'Select your Daggerfall folder to see your dressed character; equipment is listed here.' });
    }
    const worn = SLOT_ORDER.map(([slot, label]) => [label, r.inventory.find((i) => i.id === r.equipment?.[slot])]).filter(([, it]) => it);
    const alt = `${[ch.gender, ch.race].filter(Boolean).join(' ') || 'Character'} wearing ${worn.length ? worn.map(([, it]) => it.name).join(', ') : 'nothing equipped'}`;
    const img = el('img', { class: 'inv-figure-img', alt, width: DOLL_WIDTH * 2, height: DOLL_HEIGHT * 2, 'data-state': 'loading', draggable: 'false' });
    const fig = el('figure', { class: 'inv-figure', 'data-doll': 'loading' }, img,
      el('figcaption', { class: 'inv-figure-cap', text: 'Click worn gear to inspect it.' }));
    const promise = icons.doll(r);
    const hit = (e, res) => {
      const rect = img.getBoundingClientRect();
      const slot = slotAt(res.doll, ((e.clientX - rect.left) / rect.width) * DOLL_WIDTH, ((e.clientY - rect.top) / rect.height) * DOLL_HEIGHT);
      return slot && r.inventory.find((i) => i.id === r.equipment?.[slot]);
    };
    promise.then((res) => {
      if (!res) {
        fig.dataset.doll = 'missing';
        fig.replaceChildren(el('p', { class: 'inv-doll-note', text: 'The paper doll could not be drawn from your game files; equipment is listed here.' }));
        return;
      }
      img.src = res.url;
      fig.dataset.doll = 'ready';
      img.dataset.state = 'ready';
      img.dataset.layers = res.doll.drawn.join(' ');
      img.addEventListener('click', (e) => { const it = hit(e, res); if (it) { ui.slotFilter = null; select(it.id); } });
      img.addEventListener('mousemove', (e) => {
        const it = hit(e, res);
        img.style.cursor = it ? 'pointer' : '';
        img.title = it ? it.name : '';
      });
    });
    return fig;
  }

  // ---------------------------------------------------------------- pack (centre) and inspector + actions (right)

  function pack(r) {
    return el('section', { class: 'inv-pack', 'aria-label': 'Pack' }, tabs(r), filterRow(r), listView(r));
  }

  function side(r, sel, cmp) {
    return el('div', { class: 'inv-side' }, inspector(r, sel, cmp), actionBar(r, sel, cmp));
  }

  function tabs(r) {
    const bar = el('div', { class: 'inv-tabs', role: 'tablist', 'aria-label': 'Item categories' });
    const go = (id) => { ui.tab = id; ui.slotFilter = null; ui.listScroll = 0; rerender(); focusKey(`#inv-tab-${id}`); };
    const inv = r.inventory || [];
    PANEL_TABS.forEach((t, i) => {
      const n = t.id === 'all' ? inv.length : inv.filter((it) => tabOf(it) === t.id).length;
      const on = !ui.slotFilter && ui.tab === t.id;
      bar.append(el('button', {
        type: 'button', role: 'tab', id: `inv-tab-${t.id}`, 'aria-selected': on ? 'true' : 'false',
        'aria-controls': 'inv-list', tabindex: (ui.slotFilter ? i === 0 : on) ? 0 : -1, class: 'inv-tab',
        onclick: () => go(t.id),
        onkeydown: (e) => {
          const map = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: PANEL_TABS.length - 1 };
          if (!(e.key in map)) return;
          e.preventDefault();
          go(PANEL_TABS[(map[e.key] + PANEL_TABS.length) % PANEL_TABS.length].id);
        },
      }, el('span', { class: 'inv-tab-name', text: t.label }), el('span', { class: 'inv-tab-n', text: String(n) })));
    });
    return bar;
  }

  function filterRow(r) {
    const search = el('input', {
      type: 'search', class: 'inv-search', placeholder: 'Search name, material, skill, magic…', 'aria-label': 'Search carried items', value: ui.query,
      'data-focus-key': 'inv-search', 'aria-controls': 'inv-list',
      oninput: (e) => {
        ui.query = e.target.value;
        ui.listScroll = 0;
        rerender();
        const s = container?.querySelector('.inv-search');
        if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
      },
      onkeydown: (e) => {
        if (e.key === 'Escape' && ui.query) {
          e.preventDefault();
          e.stopPropagation();
          ui.query = '';
          ui.listScroll = 0;
          rerender();
          focusKey('inv-search');
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          container?.querySelector('.inv-row')?.focus();
        } else if (e.key === 'Enter') {
          const first = visibleItems(r)[0];
          if (first) { e.preventDefault(); select(first.id); }
        }
      },
    });
    const wrap = el('div', { class: 'inv-search-wrap' }, search,
      ui.query ? el('button', {
        type: 'button', class: 'inv-search-clear', 'aria-label': 'Clear search', 'data-focus-key': 'search-clear',
        onclick: () => { ui.query = ''; ui.listScroll = 0; rerender(); focusKey('inv-search'); },
      }, '×') : null);
    const row = el('div', { class: 'inv-filter' }, wrap);
    if (ui.query.trim() && !ui.slotFilter && ui.tab !== 'all') {
      const allCount = itemsForTab(r.inventory, 'all', ui.query).length;
      const tabCount = itemsForTab(r.inventory, ui.tab, ui.query).length;
      if (allCount > tabCount) {
        row.append(el('button', {
          type: 'button', class: 'inv-chip inv-chip-btn', 'data-focus-key': 'search-all',
          onclick: () => { ui.tab = 'all'; ui.listScroll = 0; rerender(); focusKey('inv-search'); },
        }, `${allCount} in All`));
      }
    }
    if (ui.slotFilter) {
      row.append(el('span', { class: 'inv-chip' }, `Fits: ${slotLabel(ui.slotFilter)}`,
        el('button', { type: 'button', class: 'inv-chip-x', 'aria-label': 'Show all items again', 'data-focus-key': 'chip-clear',
          onclick: () => { const s = ui.slotFilter; ui.slotFilter = null; rerender(); focusKey(`slot-${s}`); } }, '×')));
    }
    return row;
  }

  function visibleItems(r) {
    if (!ui.slotFilter) return itemsForTab(r.inventory, ui.tab, ui.query);
    return r.inventory.filter((i) => fitsSlot(i, ui.slotFilter) && matchesQuery(i, ui.query))
      .sort((a, b) => (b.equipped ? 1 : 0) - (a.equipped ? 1 : 0) || String(a.name).localeCompare(String(b.name)));
  }

  function listView(r) {
    const items = visibleItems(r);
    const list = el('ul', {
      class: 'inv-list', id: 'inv-list', role: 'listbox',
      'aria-label': ui.slotFilter ? `Items that fit ${slotLabel(ui.slotFilter)}` : PANEL_TABS.find((t) => t.id === ui.tab)?.label,
    });
    if (!items.length) {
      list.append(el('li', { class: 'inv-empty', role: 'presentation', text: ui.query ? 'No matching items.' : ui.slotFilter ? `You carry nothing for the ${slotLabel(ui.slotFilter).toLowerCase()}.` : 'Nothing here.' }));
      return list;
    }
    const focusIdx = Math.max(0, items.findIndex((i) => i.id === ui.selected));
    items.forEach((it, n) => {
      const selected = it.id === ui.selected;
      const pct = conditionPct(it);
      const broken = pct === 0;
      const ch = itemCharges(it);
      const meta = [
        kindOf(it),
        it.conjuredUntil ? 'Conjured' : null,
        keyStat(it),
        ch ? `${ch.current}/${ch.max} chg` : (pct != null && pct < 100 ? `${conditionLabel(it)} ${pct}%` : null),
      ].filter(Boolean).join(' · ');
      const moveTo = (k) => { const next = items[Math.max(0, Math.min(items.length - 1, k))]; if (next) select(next.id); };
      list.append(el('li', {
        role: 'option', class: `inv-row${broken ? ' inv-row-broken' : ''}`, 'data-item-id': it.id, 'data-focus-key': `item-${it.id}`,
        'aria-selected': selected ? 'true' : 'false', tabindex: n === focusIdx ? 0 : -1,
        'aria-label': `${qtyName(it)}${it.equipped ? ', equipped' : ''}${broken ? ', broken' : ''}. ${meta}`,
        onclick: () => select(it.id),
        ondblclick: () => runPrimary(it),
        onkeydown: (e) => {
          const page = 6;
          const map = { ArrowDown: n + 1, ArrowUp: n - 1, Home: 0, End: items.length - 1, PageDown: n + page, PageUp: n - page };
          if (e.key in map) { e.preventDefault(); moveTo(map[e.key]); }
          else if (e.key === 'Enter') { e.preventDefault(); if (!selected) select(it.id); else runPrimary(it); }
          else if (e.key === ' ') { e.preventDefault(); select(it.id); }
          else if ((e.key === 'e' || e.key === 'E') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); select(it.id, { focus: false }); runPrimary(it); }
          else if (e.key === 'Escape' && ui.slotFilter) { e.preventDefault(); e.stopPropagation(); const s = ui.slotFilter; ui.slotFilter = null; rerender(); focusKey(`slot-${s}`); }
        },
      },
      iconImg(it, 'md'),
      el('span', { class: 'inv-row-text' },
        el('span', { class: 'inv-row-name', text: qtyName(it) }),
        el('span', { class: 'inv-row-meta', text: meta })),
      el('span', { class: 'inv-row-side' },
        it.equipped ? el('span', { class: 'inv-badge', text: 'worn' }) : null,
        broken ? el('span', { class: 'inv-badge inv-badge-bad', text: 'broken' }) : !broken && needsCare(it) ? el('span', { class: 'inv-badge inv-badge-warn', text: 'worn out' }) : null,
        el('span', { class: 'inv-row-wt', text: kg(it.weight * (it.quantity || 1)) }))));
    });
    return list;
  }

  function runPrimary(it) {
    const a = primaryAction(it, rpg()?.lightSource);
    if (a) act(a.verb, a.args, pendingText(a, it));
  }
  const pendingText = pendingLabel;

  function inspector(r, it, cmp) {
    const box = el('section', { class: 'inv-inspect', 'aria-label': 'Selected item' });
    if (!it) {
      box.append(el('p', { class: 'inv-hint', text: 'Select an item to inspect it and compare it with what you wear. Enter or double-click equips, removes or drinks it.' }));
      return box;
    }
    const pct = conditionPct(it);
    box.append(el('div', { class: 'inv-inspect-head' }, iconImg(it, 'lg'),
      el('div', {},
        el('h3', { class: 'inv-h inv-inspect-name', text: qtyName(it) }),
        el('p', { class: 'inv-inspect-kind', text: [kindOf(it), it.equipped ? `worn on ${slotLabel(it.equipped).toLowerCase()}` : null].filter(Boolean).join(' · ') }))));
    if (pct != null) {
      box.append(el('div', { class: `inv-cond${pct === 0 ? ' inv-cond-bad' : pct < 41 ? ' inv-cond-warn' : ''}` },
        el('span', { class: 'inv-cond-label' }, 'Condition ', el('strong', { text: `${conditionLabel(it)} · ${pct}%` })),
        el('meter', { min: 0, max: 100, low: 41, high: 76, optimum: 100, value: pct, 'aria-label': `Condition ${pct}%` })));
    }
    if (cmp) box.append(comparison(cmp, it));
    const dl = el('dl', { class: 'inv-stats' });
    for (const [k, v] of describe(it)) if (k !== 'Equipped' && k !== 'Condition') dl.append(el('dt', { text: k }), el('dd', { text: v }));
    box.append(dl);
    if (needsCare(it)) {
      box.append(el('p', { class: 'inv-care' },
        pct === 0 ? 'Broken: it cannot be worn until a smith repairs it. ' : 'Worn out: a smith can restore it. ',
        it.equipped ? 'Leaving it with a smith takes it off. ' : '',
        el('button', { type: 'button', class: 'inv-link', 'data-focus-key': 'open-repairs', onclick: () => api.openPanel(REPAIR_PANEL) }, 'Open Bank & Repairs')));
    }
    if (isWearable(it)) {
      const slot = it.equipped || it.slot || jewelSlots(it)?.[0] || 'rightHand';
      const others = r.inventory.filter((i) => i.id !== it.id && fitsSlot(i, slot)).length;
      if (others && ui.slotFilter !== slot) {
        box.append(el('button', { type: 'button', class: 'inv-link', 'data-focus-key': 'show-alternatives',
          onclick: () => { ui.slotFilter = slot; ui.listScroll = 0; rerender(); focusKey(`item-${it.id}`); } },
        `Show ${others} other item${others === 1 ? '' : 's'} for the ${slotLabel(slot).toLowerCase()}`));
      }
    }
    return box;
  }

  function comparison(cmp, it) {
    const sec = el('div', { class: 'inv-compare', 'aria-label': cmp.mode === 'equip' ? 'Equip comparison' : 'Unequip comparison' });
    const slotText = slotLabel(cmp.slot);
    if (cmp.mode === 'equip') {
      const currentName = cmp.replaces.length ? cmp.replaces.map((r) => r.name).join(' + ') : `Empty ${slotText.toLowerCase()}`;
      sec.append(
        el('div', { class: 'inv-compare-versus' },
          el('div', { class: 'inv-compare-side' },
            el('span', { class: 'inv-compare-tag', text: `Equipped · ${slotText}` }),
            el('span', { class: `inv-compare-name${cmp.replaces.length ? '' : ' inv-compare-empty'}`, text: currentName })),
          el('span', { class: 'inv-compare-arrow', 'aria-hidden': 'true', text: '→' }),
          el('div', { class: 'inv-compare-side' },
            el('span', { class: 'inv-compare-tag', text: 'Equipping' }),
            el('span', { class: 'inv-compare-name inv-compare-next', text: it.name }))),
      );
    } else {
      sec.append(
        el('div', { class: 'inv-compare-versus' },
          el('div', { class: 'inv-compare-side' },
            el('span', { class: 'inv-compare-tag', text: `Equipped · ${slotText}` }),
            el('span', { class: 'inv-compare-name', text: it.name })),
          el('span', { class: 'inv-compare-arrow', 'aria-hidden': 'true', text: '→' }),
          el('div', { class: 'inv-compare-side' },
            el('span', { class: 'inv-compare-tag', text: 'After removing' }),
            el('span', { class: 'inv-compare-name inv-compare-empty', text: `Empty ${slotText.toLowerCase()}` }))),
      );
    }
    if (cmp.rows.length) {
      const t = el('table', { class: 'inv-compare-table' },
        el('thead', {}, el('tr', {},
          el('th', { scope: 'col' }, el('span', { class: 'inv-sr', text: 'Stat' })),
          el('th', { scope: 'col', text: 'Now' }),
          el('th', { scope: 'col', text: cmp.mode === 'equip' ? 'This' : 'After' }),
          el('th', { scope: 'col', text: 'Delta' }))));
      const tb = el('tbody');
      for (const [label, cur, next, change, sense] of cmp.rows) {
        tb.append(el('tr', {},
          el('th', { scope: 'row', text: label }),
          el('td', { text: cur }),
          el('td', { text: next }),
          el('td', { class: sense > 0 ? 'inv-up' : sense < 0 ? 'inv-down' : '', text: change })));
      }
      t.append(tb);
      sec.append(el('div', { class: 'inv-compare-wrap' }, t));
    }
    if (cmp.armor.length) {
      const ul = el('ul', { class: 'inv-armor-change', 'aria-label': 'Armor rating changes' });
      for (const [, label, b, a] of cmp.armor) {
        ul.append(el('li', {}, `${label} AC `, el('span', { text: `${b} → ${a}` }),
          el('span', { class: `inv-delta ${a > b ? 'inv-up' : 'inv-down'}`, text: `${a > b ? '+' : '−'}${Math.abs(a - b)}` })));
      }
      sec.append(ul);
    } else if (it.group === 'armor' || it.group === 'shield') {
      sec.append(el('p', { class: 'inv-hint inv-tight', text: 'Armor ratings stay the same.' }));
    }
    return sec;
  }

  // ---------------------------------------------------------------- action bar, summary, loot

  function actionBar(r, it, cmp) {
    const bar = el('div', { class: 'inv-bar', role: 'region', 'aria-label': 'Item actions' });
    const st = ui.status;
    bar.append(el('p', { class: `inv-status${st ? ` inv-status-${st.kind}` : ''}`, role: 'status', 'aria-live': 'polite', text: st?.text ?? '' }));
    if (!it) {
      bar.append(el('p', { class: 'inv-bar-hint', text: 'Select an item to equip, use or drop it.' }));
      return bar;
    }
    const busy = !!ui.pending;
    const buttons = el('div', { class: 'inv-actions' });
    const a = primaryAction(it, rpg()?.lightSource);
    if (a) {
      const label = a.label;
      const where = a.label === 'Equip' && it.group === 'weapon' && it.hands === 'either' ? ' in the right hand' : '';
      buttons.append(el('button', { type: 'button', class: 'btn btn-primary inv-primary', 'data-focus-key': 'act-primary', 'aria-busy': busy ? 'true' : null,
        'aria-label': `${label} ${it.name}${where}`, title: where ? 'Equip in the right hand' : null, onclick: () => runPrimary(it) }, label));
    } else if (conditionPct(it) === 0) {
      buttons.append(el('button', { type: 'button', class: 'btn', 'data-focus-key': 'act-repair', onclick: () => api.openPanel(REPAIR_PANEL) }, 'Find a smith'));
    }
    // Worn magic items with a Used power (Warlock's Ring, Skull of Corruption…): equip is primary, use is offered too.
    if (isWearable(it) && hasUsePower(it) && it.condition !== 0) {
      buttons.append(el('button', { type: 'button', class: 'btn', 'data-focus-key': 'act-use', 'aria-label': `Use the power of ${it.name}`,
        onclick: () => act('inventory.use', { itemId: it.id }, `Using ${it.name}…`) }, 'Use'));
    }
    if (it.group === 'weapon' && !it.equipped && it.hands === 'either' && it.condition !== 0) {
      buttons.append(el('button', { type: 'button', class: 'btn', 'data-focus-key': 'act-left', 'aria-label': `Equip ${it.name} in the left hand`,
        onclick: () => act('inventory.equip', { itemId: it.id, slot: 'leftHand' }, `Equipping ${it.name}…`) }, 'Left hand'));
    }
    if (!it.equipped && !it.conjuredUntil) {
      const max = it.quantity || 1;
      if (max > 1) {
        buttons.append(el('label', { class: 'inv-qty' }, 'Qty',
          el('input', { type: 'number', min: 1, max, value: Math.min(ui.dropQty, max), 'data-focus-key': 'drop-qty',
            oninput: (e) => { ui.dropQty = Math.max(1, Math.min(max, Math.trunc(Number(e.target.value)) || 1)); } })));
      }
      buttons.append(el('button', { type: 'button', class: 'btn inv-drop', 'data-focus-key': 'act-drop', 'aria-label': `Drop ${it.name} on the ground`,
        onclick: () => act('inventory.drop', { itemId: it.id, quantity: Math.min(ui.dropQty, max) }, `Dropping ${it.name}…`) }, 'Drop'));
    }
    bar.append(el('div', { class: 'inv-bar-item' }, iconImg(it, 'sm'),
      el('span', { class: 'inv-bar-text' }, el('span', { class: 'inv-bar-name', text: qtyName(it) }), barCompare(cmp))), buttons);
    return bar;
  }

  /** One-line decision summary beside the buttons: what it replaces and what changes. */
  function barCompare(cmp) {
    if (!cmp) return null;
    const parts = [];
    if (cmp.mode === 'equip') parts.push(cmp.replaces.length ? `Replaces ${cmp.replaces.map((i) => i.name).join(' and ')}` : `Empty ${slotLabel(cmp.slot).toLowerCase()} slot`);
    else parts.push(`Worn on ${slotLabel(cmp.slot).toLowerCase()}`);
    const span = el('span', { class: 'inv-bar-cmp' }, parts.join(''));
    const delta = (text, sense) => el('span', { class: sense > 0 ? 'inv-up' : sense < 0 ? 'inv-down' : '', text });
    for (const [, label, b, a] of cmp.armor) span.append(' · ', `${label} ${b}→${a} `, delta(`${a > b ? '+' : '−'}${Math.abs(a - b)}`, Math.sign(a - b)));
    const dmg = cmp.rows.find((r) => r[0] === 'Damage');
    if (dmg) span.append(' · ', `Damage ${dmg[2]} `, delta(dmg[3], dmg[4]));
    return span;
  }

  function summary(r) {
    const w = carriedWeight(r);
    const cap = maxEncumbrance(r);
    return el('div', { class: `inv-summary${w > cap ? ' inv-over' : ''}` },
      el('span', { class: 'inv-gold' }, iconImg(GOLD, 'xs'), 'Gold ', el('strong', { text: String(r.gold ?? 0) })),
      el('span', { class: 'inv-weight' }, 'Carried ', el('strong', { text: `${w.toFixed(1)} / ${cap} kg` })),
      el('meter', { min: 0, max: cap, high: cap * 0.85, optimum: 0, value: Math.min(w, cap), 'aria-label': `Carried weight ${w.toFixed(1)} of ${cap} kilograms` }),
      el('span', { class: 'inv-weapon' }, 'Readied ', el('strong', { text: r.weaponView?.name ?? 'Hand-to-Hand' })),
    );
  }

  function nearbyLoot() {
    const piles = (api.state?.entities || []).filter((e) => e.kind === 'loot');
    if (!piles.length) return null;
    const sec = el('section', { class: 'inv-loot', 'aria-label': 'Nearby loot' }, el('h4', { class: 'inv-h4', text: 'Nearby' }));
    const ul = el('ul', { class: 'inv-loot-list' });
    for (const p of piles) {
      ul.append(el('li', {}, el('span', { text: `${p.name}${p.count ? ` (${p.count})` : ''}` }),
        el('button', { type: 'button', class: 'btn', 'data-focus-key': `loot-${p.id}`, onclick: () => act('inventory.inspectLoot', { targetId: p.id }) }, 'Search')));
    }
    sec.append(ul);
    return sec;
  }

  /** Classic book reader: one page at a time from the installed BOKnnnnn.TXT (or a letter's lines). */
  function bookView() {
    const b = ui.book;
    const pages = b.pages.length ? b.pages : [[]];
    const n = Math.max(0, Math.min(pages.length - 1, b.page | 0));
    const sec = el('section', { class: 'inv-loot inv-book', 'aria-label': `Reading ${b.title}` },
      el('h4', { class: 'inv-h4', text: b.title }),
      b.author ? el('p', { class: 'inv-book-author', text: `by ${b.author}` }) : null,
      el('div', { class: 'inv-book-page', tabindex: '0', 'data-focus-key': 'book-page' }, ...pages[n].map((line) => el('p', { text: line || '\u00a0' }))),
      el('div', { class: 'inv-actions' },
        el('button', { type: 'button', class: 'btn', disabled: n === 0 ? '' : null, 'data-focus-key': 'book-prev', onclick: () => { b.page = n - 1; rerender(); } }, 'Previous page'),
        el('span', { class: 'inv-book-count', text: `Page ${n + 1} of ${pages.length}` }),
        el('button', { type: 'button', class: 'btn', disabled: n >= pages.length - 1 ? '' : null, 'data-focus-key': 'book-next', onclick: () => { b.page = n + 1; rerender(); } }, 'Next page'),
        el('button', { type: 'button', class: 'btn', onclick: () => { ui.book = null; rerender(); } }, 'Close')));
    return sec;
  }

  /** A shared container: take, take all, leave the selected item (storage/treasure) or read shelf books. */
  function containerView() {
    const l = ui.loot;
    const id = l.containerId;
    const sec = el('section', { class: 'inv-loot', 'aria-label': `Contents of ${l.name}` }, el('h4', { class: 'inv-h4', text: l.name }));
    if (l.prompt === 'private') {
      sec.append(el('p', { text: l.text || 'This is private property. Search it anyway?' }), el('div', { class: 'inv-actions' },
        el('button', { type: 'button', class: 'btn btn-primary', 'data-focus-key': 'search-yes', onclick: () => act('container.open', { containerId: id, confirm: true }) }, 'Search'),
        el('button', { type: 'button', class: 'btn', onclick: () => { ui.loot = null; rerender(); } }, 'Leave it')));
      return sec;
    }
    const ul = el('ul', { class: 'inv-loot-list' });
    for (const b of l.books || []) {
      ul.append(el('li', {}, el('span', { text: b.title }),
        el('button', { type: 'button', class: 'btn', 'data-focus-key': `read-${b.id}`, onclick: () => act('container.read', { containerId: id, bookId: b.id }) }, 'Read')));
    }
    for (const it of l.items || []) {
      ul.append(el('li', {}, iconImg(it.template === 'gold' ? GOLD : it, 'sm'),
        el('span', { text: it.template === 'gold' ? `${it.quantity} gold pieces` : qtyName(it) }),
        el('button', { type: 'button', class: 'btn', 'data-focus-key': `take-${it.id ?? 'gold'}`, onclick: () => act('container.take', { containerId: id, itemId: it.template === 'gold' ? 'gold' : it.id }) }, 'Take')));
    }
    if (!(l.items || []).length && !(l.books || []).length) ul.append(el('li', {}, el('span', { text: 'Empty.' })));
    const sel = ui.selected && rpg()?.inventory?.find((i) => i.id === ui.selected && !i.equipped);
    sec.append(ul, el('div', { class: 'inv-actions' },
      (l.items || []).length ? el('button', { type: 'button', class: 'btn btn-primary', 'data-focus-key': 'take-all', onclick: () => act('container.take', { containerId: id }) }, 'Take all') : null,
      l.canPut && sel ? el('button', { type: 'button', class: 'btn', onclick: () => act('container.put', { containerId: id, itemId: sel.id }) }, `Leave ${sel.name}`) : null,
      el('button', { type: 'button', class: 'btn', onclick: () => { ui.loot = null; rerender(); } }, 'Close')));
    return sec;
  }

  function lootView() {
    if (ui.loot.container) return containerView();
    const l = ui.loot;
    const sec = el('section', { class: 'inv-loot', 'aria-label': `Contents of ${l.name}` },
      el('h4', { class: 'inv-h4', text: l.name }));
    const ul = el('ul', { class: 'inv-loot-list' });
    for (const it of l.items || []) {
      ul.append(el('li', {}, iconImg(it.template === 'gold' ? GOLD : it, 'sm'),
        el('span', { text: it.template === 'gold' ? `${it.quantity} gold pieces` : qtyName(it) }),
        el('button', { type: 'button', class: 'btn', 'data-focus-key': `take-${it.id ?? 'gold'}`, onclick: () => act('inventory.loot', { targetId: l.targetId, itemId: it.template === 'gold' ? 'gold' : it.id }) }, 'Take')));
    }
    sec.append(ul, el('div', { class: 'inv-actions' },
      el('button', { type: 'button', class: 'btn btn-primary', 'data-focus-key': 'take-all', onclick: () => act('inventory.loot', { targetId: l.targetId }) }, 'Take all'),
      el('button', { type: 'button', class: 'btn', onclick: () => { ui.loot = null; rerender(); } }, 'Close')));
    return sec;
  }

  api.registerPanel('inventory', 'Inventory', render, { watch: inventoryWatch });
  return { icons, ui };
}
