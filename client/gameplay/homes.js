// Personal Homes HUD panel (client/gameplay/homes.js).
// Authentic granite & oxidized verdigris UI for owned homes, furniture build/place/rotate mode,
// guest list & access permissions, storage chests, and house trader stall status.
// Exports `install(api)` (registers panel `homes`) and `renderHomesView(root, state, handlers)`
// for Wave 2B integration under Property or standalone navigation.

export const PANEL_ID = 'homes';
export const PANEL_TITLE = 'Homes';

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;
    else if (k === 'value') n.value = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) {
    if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
};

function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-feature="homes"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./homes.css', import.meta.url).href;
  link.dataset.feature = 'homes';
  document.head.append(link);
}

const DEG_STEPS = [0, 90, 180, 270];
const degToRad = (d) => Math.round(((d * Math.PI) / 180) * 1000) / 1000;
const radToDeg = (r) => ((Math.round((Number(r || 0) * 180) / Math.PI) % 360) + 360) % 360;

/**
 * Stateless/reusable renderer for Personal Homes so Wave 2B can embed it in Property or a dedicated panel.
 */
export function renderHomesView(root, state, handlers = {}) {
  root.classList.add('hm-root');
  const {
    overview = null,
    character = null,
    tab = 'overview',
    selectedHomeId = null,
    selectedCatalogId = 'oak-table',
    selectedChestId = 'chest-main',
    placeX = 3.2,
    placeZ = 2.4,
    placeFloor = 0,
    placeDeg = 0,
    inviteTargetId = '',
    inviteTargetName = '',
    status = '',
    saleQuote = null,
  } = state;

  const act = (verb, args = {}) => handlers.act?.(verb, args);
  const patch = (next) => handlers.setState?.(next);
  const stopKey = (e) => e.stopPropagation();

  const owned = overview?.owned ?? [];
  const activeHome = overview?.activeHome ?? null;
  const currentHome = owned.find((h) => h.id === selectedHomeId) ?? activeHome ?? owned[0] ?? null;

  // Header bar
  const header = el('header', { class: 'hm-header' },
    el('div', { class: 'hm-title-wrap' },
      el('h2', { class: 'hm-title', text: 'Personal Homes' }),
      currentHome ? el('span', { class: 'hm-badge hm-badge-verdigris', text: `${currentHome.townName} · ${currentHome.region}` }) : null,
      activeHome ? el('span', { class: 'hm-badge hm-badge-ok', text: 'Inside Home' }) : null),
    el('div', { class: 'hm-badges' },
      el('span', { class: 'hm-badge', text: `Purse: ${overview?.gold ?? character?.gold ?? 0}g` }),
      el('span', { class: 'hm-badge', text: `Deeds: ${owned.length}` }),
      el('button', { type: 'button', class: 'hm-btn', onclick: () => act('home.overview', {}) }, 'Refresh')));

  // Sub-tabs
  const tabs = [
    { id: 'overview', label: `Owned Homes (${owned.length})` },
    { id: 'build', label: 'Build & Furnish' },
    { id: 'guests', label: 'Guests & Access' },
    { id: 'storage', label: 'Storage Chests' },
  ];
  const tabBar = el('nav', { class: 'hm-tabs', role: 'tablist', 'aria-label': 'Homes sections' },
    tabs.map((t) => el('button', {
      type: 'button',
      role: 'tab',
      class: `hm-tab${tab === t.id ? ' is-active' : ''}`,
      'aria-selected': tab === t.id ? 'true' : 'false',
      onclick: () => patch({ tab: t.id }),
    }, t.label)));

  const live = el('p', { class: 'hm-live', role: 'status', 'aria-live': 'polite', text: status });

  const body = [];

  if (!overview) {
    body.push(el('section', { class: 'hm-card' },
      el('p', { class: 'hm-note', text: 'Loading home deeds and estate records…' })));
  } else if (tab === 'overview') {
    body.push(renderOverviewTab({ overview, owned, currentHome, activeHome, saleQuote, act, patch }));
  } else if (!currentHome) {
    body.push(el('section', { class: 'hm-card' },
      el('h3', { class: 'hm-h', text: 'No Home Selected' }),
      el('p', { class: 'hm-note', text: 'Purchase a house deed from any regional bank to furnish rooms, invite guests, and store goods.' })));
  } else if (tab === 'build') {
    body.push(renderBuildTab({
      overview, currentHome, selectedCatalogId, placeX, placeZ, placeFloor, placeDeg, act, patch, stopKey,
    }));
  } else if (tab === 'guests') {
    body.push(renderGuestsTab({
      overview, currentHome, inviteTargetId, inviteTargetName, act, patch, stopKey,
    }));
  } else if (tab === 'storage') {
    body.push(renderStorageTab({
      character, currentHome, selectedChestId, act, patch,
    }));
  }

  root.replaceChildren(header, tabBar, live, ...body);
}

function renderOverviewTab({ overview, owned, currentHome, activeHome, saleQuote, act, patch }) {
  const ownedCard = el('section', { class: 'hm-card' },
    el('div', { class: 'hm-card-head' },
      el('h3', { class: 'hm-h', text: 'Owned Residences' }),
      el('span', { class: 'hm-meta', text: 'One house per region · Legacy deeds preserved' })),
    owned.length
      ? el('ul', { class: 'hm-list' }, owned.map((h) => {
        const selected = currentHome?.id === h.id;
        const storedCount = (h.containers ?? []).reduce((n, c) => n + (c.itemCount ?? c.items?.length ?? 0), 0);
        return el('li', { class: `hm-row${selected ? ' is-selected' : ''}` },
          el('div', { class: 'hm-row-main' },
            el('div', { class: 'hm-badges' },
              el('span', { class: 'hm-row-title', text: `${h.townName} (${h.region})` }),
              h.legacy ? el('span', { class: 'hm-badge hm-badge-verdigris', text: 'Legacy Deed' }) : null,
              el('span', { class: 'hm-badge', text: `Access: ${h.access?.mode ?? 'private'}` }),
              h.trader ? el('span', { class: 'hm-badge hm-badge-ok', text: `Trader (${h.trader.listingIds?.length ?? 0} listed)` }) : null),
            el('p', { class: 'hm-meta', text: `Instance ${h.id} · ${h.furnishings.length}/${h.maxFurnishings} decor · ${storedCount} stored · ${h.visitorCount} visitors` })),
          el('div', { class: 'hm-actions' },
            el('button', { type: 'button', class: `hm-btn${selected ? ' is-active' : ''}`, onclick: () => patch({ selectedHomeId: h.id, saleQuote: null }) }, selected ? 'Selected' : 'Manage'),
            activeHome?.id === h.id
              ? el('button', { type: 'button', class: 'hm-btn', onclick: () => act('home.leave', {}) }, 'Step Outside')
              : el('button', { type: 'button', class: 'hm-btn hm-btn-primary', onclick: () => act('home.enter', { homeId: h.id }) }, 'Enter'),
            el('button', { type: 'button', class: 'hm-btn', onclick: () => act('home.saleQuote', { homeId: h.id, includeFurnishingsInQuote: true }) }, 'Sale Quote')));
      }))
      : el('p', { class: 'hm-note', text: 'You do not own any homes yet. Visit a regional bank counter to buy a residence deed.' }));

  const rightCol = [];
  if (currentHome) {
    rightCol.push(el('section', { class: 'hm-card hm-card-accent' },
      el('div', { class: 'hm-card-head' },
        el('h3', { class: 'hm-h', text: `Estate Summary · ${currentHome.townName}` }),
        el('span', { class: 'hm-badge hm-badge-verdigris', text: `Rev ${currentHome.furnishingRev}` })),
      el('p', { class: 'hm-note', text: `Address: ${currentHome.interior}` }),
      el('div', { class: 'hm-badges' },
        el('span', { class: 'hm-badge', text: `Deed Value: ${currentHome.price}g` }),
        el('span', { class: 'hm-badge', text: `Decor: ${currentHome.furnishings.length}/${currentHome.maxFurnishings}` }),
        el('span', { class: 'hm-badge', text: `Chests: ${currentHome.containers.length}` })),
      currentHome.trader
        ? el('div', { class: 'hm-row' },
          el('div', { class: 'hm-row-main' },
            el('span', { class: 'hm-row-title', text: `House Trader: ${currentHome.trader.npcName}` }),
            el('span', { class: 'hm-meta', text: `${currentHome.trader.listingIds?.length ?? 0} active market listings attached` })),
          el('span', { class: 'hm-badge hm-badge-ok', text: currentHome.trader.enabled ? 'Open' : 'Paused' }))
        : el('p', { class: 'hm-meta', text: 'No House Trader Stall placed yet. Place one in Build & Furnish to sell market goods from home.' }),
      el('div', { class: 'hm-actions' },
        el('button', { type: 'button', class: 'hm-btn hm-btn-primary', onclick: () => patch({ tab: 'build', selectedHomeId: currentHome.id }) }, 'Open Build Mode'),
        el('button', { type: 'button', class: 'hm-btn', onclick: () => patch({ tab: 'guests', selectedHomeId: currentHome.id }) }, 'Guest List'),
        el('button', { type: 'button', class: 'hm-btn', onclick: () => patch({ tab: 'storage', selectedHomeId: currentHome.id }) }, 'Storage Chest'))));
  }

  if (saleQuote && currentHome && saleQuote.homeId === currentHome.id) {
    rightCol.push(el('section', { class: 'hm-card' },
      el('h3', { class: 'hm-h', text: 'Bank Sale Quote' }),
      el('p', { class: 'hm-note', text: `Deed buyback: ${saleQuote.baseProceeds}g · Furniture (${saleQuote.furnitureCount}): +${saleQuote.furnitureRefund}g · Total: ${saleQuote.totalProceeds}g` }),
      saleQuote.blockers?.length
        ? el('ul', { class: 'hm-list' }, saleQuote.blockers.map((b) => el('li', { class: 'hm-row' }, el('span', { class: 'hm-badge hm-badge-danger', text: 'Blocked' }), el('span', { text: b }))))
        : el('div', { class: 'hm-actions' },
          el('button', { type: 'button', class: 'hm-btn hm-btn-danger', onclick: () => act('home.sell', { homeId: currentHome.id, includeFurnishingsInQuote: saleQuote.includeFurnishingsInQuote }) }, `Confirm Sale (+${saleQuote.totalProceeds}g)`),
          el('button', { type: 'button', class: 'hm-btn', onclick: () => patch({ saleQuote: null }) }, 'Dismiss'))));
  }

  const invitations = overview.invitations ?? [];
  rightCol.push(el('section', { class: 'hm-card' },
    el('h3', { class: 'hm-h', text: `Home Invitations (${invitations.length})` }),
    invitations.length
      ? el('ul', { class: 'hm-list' }, invitations.map((inv) => el('li', { class: 'hm-row' },
        el('div', { class: 'hm-row-main' },
          el('span', { class: 'hm-row-title', text: `${inv.ownerName}'s Residence` }),
          el('span', { class: 'hm-meta', text: `${inv.townName}, ${inv.region}` })),
        el('button', { type: 'button', class: 'hm-btn hm-btn-primary', onclick: () => act('home.enter', { homeId: inv.homeId }) }, 'Visit'))))
      : el('p', { class: 'hm-note', text: 'No active home invitations.' })));

  return el('div', { class: 'hm-grid' }, ownedCard, el('div', { class: 'hm-stack' }, ...rightCol));
}

function renderBuildTab({ overview, currentHome, selectedCatalogId, placeX, placeZ, placeFloor, placeDeg, act, patch, stopKey }) {
  const catalog = overview.catalog ?? [];
  const chosenSpec = catalog.find((c) => c.id === selectedCatalogId) ?? catalog[0] ?? null;
  const half = Math.min(20, Math.max(6, (Number(currentHome.radius) || 10) * 1.4));
  const toPct = (v) => Math.max(6, Math.min(94, 50 + (v / (half * 2)) * 100));

  const floorplan = el('div', {
    class: 'hm-floorplan',
    title: 'Click floor grid to pick placement coordinates',
    onclick: (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const rx = ((e.clientX - rect.left) / rect.width - 0.5) * half * 2;
      const rz = ((e.clientY - rect.top) / rect.height - 0.5) * half * 2;
      patch({ placeX: Math.round(rx * 10) / 10, placeZ: Math.round(rz * 10) / 10 });
    },
  },
  el('div', { class: 'hm-fp-door', text: 'Door' }),
  ...(currentHome.furnishings ?? [])
    .filter((f) => (f.floor ?? 0) === placeFloor)
    .map((f) => el('div', {
      class: `hm-fp-item${f.kind === 'chest' ? ' is-chest' : ''}${f.kind === 'trader' ? ' is-trader' : ''}`,
      style: `left:${toPct(f.x)}%;top:${toPct(f.z)}%;`,
      text: `${f.name} (${radToDeg(f.yaw)}°)`,
    })),
  chosenSpec
    ? el('div', {
      class: 'hm-fp-preview',
      style: `left:${toPct(placeX)}%;top:${toPct(placeZ)}%;`,
      text: `+ ${chosenSpec.name} (${placeDeg}°)`,
    })
    : null);

  const leftCard = el('section', { class: 'hm-card' },
    el('div', { class: 'hm-card-head' },
      el('h3', { class: 'hm-h', text: `Build Mode · Floor ${placeFloor}` }),
      el('span', { class: 'hm-badge hm-badge-verdigris', text: `${currentHome.furnishings.length}/${currentHome.maxFurnishings} Placed` })),
    floorplan,
    el('div', { class: 'hm-form-row' },
      el('label', { class: 'hm-field' },
        el('span', { class: 'hm-label', text: 'Pos X (m)' }),
        el('input', {
          class: 'hm-input', type: 'number', step: '0.5', value: String(placeX),
          oninput: (e) => patch({ placeX: Number(e.target.value) }), onkeydown: stopKey,
        })),
      el('label', { class: 'hm-field' },
        el('span', { class: 'hm-label', text: 'Pos Z (m)' }),
        el('input', {
          class: 'hm-input', type: 'number', step: '0.5', value: String(placeZ),
          oninput: (e) => patch({ placeZ: Number(e.target.value) }), onkeydown: stopKey,
        })),
      el('label', { class: 'hm-field' },
        el('span', { class: 'hm-label', text: 'Floor' }),
        el('select', {
          class: 'hm-select', value: String(placeFloor),
          onchange: (e) => patch({ placeFloor: Number(e.target.value) }),
        }, [0, 1, 2, 3].map((fl) => el('option', { value: String(fl), selected: placeFloor === fl }, `Floor ${fl}`))))),
    el('div', { class: 'hm-actions' },
      el('span', { class: 'hm-label', text: 'Rotation:' }),
      ...DEG_STEPS.map((deg) => el('button', {
        type: 'button',
        class: `hm-btn${placeDeg === deg ? ' is-active' : ''}`,
        onclick: () => patch({ placeDeg: deg }),
      }, `${deg}°`)),
      chosenSpec
        ? el('button', {
          type: 'button',
          class: 'hm-btn hm-btn-primary',
          onclick: () => act('home.furnishPlace', {
            homeId: currentHome.id,
            catalogId: chosenSpec.id,
            x: placeX,
            z: placeZ,
            floor: placeFloor,
            yaw: degToRad(placeDeg),
          }),
        }, `Place ${chosenSpec.name} (${chosenSpec.price}g)`)
        : null));

  const catalogCard = el('section', { class: 'hm-card' },
    el('h3', { class: 'hm-h', text: 'Furnishing Catalogue' }),
    el('div', { class: 'hm-catalog-grid' }, catalog.map((c) => el('button', {
      type: 'button',
      class: `hm-cat-item${selectedCatalogId === c.id ? ' is-selected' : ''}`,
      onclick: () => patch({ selectedCatalogId: c.id }),
    },
    el('div', { class: 'hm-badges' },
      el('strong', { text: c.name }),
      el('span', { class: 'hm-badge hm-badge-verdigris', text: `${c.price}g` })),
    el('span', { class: 'hm-meta', text: `${c.category} · ${c.width}×${c.depth}m · Max ${c.maxPerSpace}` })))));

  const placedCard = el('section', { class: 'hm-card' },
    el('h3', { class: 'hm-h', text: `Placed Furnishings (${currentHome.furnishings.length})` }),
    currentHome.furnishings.length
      ? el('ul', { class: 'hm-list' }, currentHome.furnishings.map((f) => el('li', { class: 'hm-row' },
        el('div', { class: 'hm-row-main' },
          el('span', { class: 'hm-row-title', text: f.name }),
          el('span', { class: 'hm-meta', text: `Floor ${f.floor} · (${f.x}, ${f.z}) · ${radToDeg(f.yaw)}°` })),
        el('div', { class: 'hm-actions' },
          el('button', {
            type: 'button', class: 'hm-btn',
            onclick: () => act('home.furnishMove', { homeId: currentHome.id, furnishingId: f.id, yaw: degToRad((radToDeg(f.yaw) + 90) % 360) }),
          }, 'Rotate +90°'),
          el('button', {
            type: 'button', class: 'hm-btn hm-btn-danger',
            onclick: () => act('home.furnishRemove', { homeId: currentHome.id, furnishingId: f.id }),
          }, 'Remove')))))
      : el('p', { class: 'hm-note', text: 'No furnishings placed yet. Select an item from the catalogue and click Place.' }));

  return el('div', { class: 'hm-grid' }, leftCard, el('div', { class: 'hm-stack' }, catalogCard, placedCard));
}

function renderGuestsTab({ currentHome, inviteTargetId, inviteTargetName, act, patch, stopKey }) {
  const mode = currentHome.access?.mode ?? 'private';
  const vh = currentHome.access?.visitingHours ?? { open: 8, close: 20 };

  const accessCard = el('section', { class: 'hm-card' },
    el('div', { class: 'hm-card-head' },
      el('h3', { class: 'hm-h', text: 'Door Access Policy' }),
      el('span', { class: 'hm-badge hm-badge-verdigris', text: mode })),
    el('p', { class: 'hm-note', text: 'Default is Private. Guests can view rooms and furnishings, never open private chests or move furniture. Blocked accounts are always refused without revealing block status.' }),
    el('div', { class: 'hm-actions' },
      [
        { id: 'private', label: 'Private (Owner Only)' },
        { id: 'invited', label: 'Invited Guests' },
        { id: 'hours', label: `Visiting Hours (${vh.open}:00–${vh.close}:00)` },
      ].map((m) => el('button', {
        type: 'button',
        class: `hm-btn${mode === m.id ? ' is-active' : ''}`,
        onclick: () => act('home.setAccess', { homeId: currentHome.id, mode: m.id, visitingHours: vh }),
      }, m.label))),
    el('form', {
      class: 'hm-form-row',
      onsubmit: (e) => {
        e.preventDefault();
        const tid = Number(inviteTargetId);
        if (Number.isSafeInteger(tid) && tid > 0) {
          act('home.inviteGuest', { homeId: currentHome.id, targetId: tid, targetName: inviteTargetName });
          patch({ inviteTargetId: '', inviteTargetName: '' });
        }
      },
    },
    el('label', { class: 'hm-field' },
      el('span', { class: 'hm-label', text: 'Guest Character ID' }),
      el('input', {
        class: 'hm-input', type: 'number', min: '1', step: '1', placeholder: 'e.g. 2', value: inviteTargetId,
        oninput: (e) => patch({ inviteTargetId: e.target.value }), onkeydown: stopKey,
      })),
    el('label', { class: 'hm-field' },
      el('span', { class: 'hm-label', text: 'Guest Name (optional)' }),
      el('input', {
        class: 'hm-input', type: 'text', maxlength: '40', placeholder: 'Traveller name', value: inviteTargetName,
        oninput: (e) => patch({ inviteTargetName: e.target.value }), onkeydown: stopKey,
      })),
    el('button', { type: 'submit', class: 'hm-btn hm-btn-primary' }, 'Invite Guest')));

  const guests = currentHome.access?.guests ?? [];
  const guestCard = el('section', { class: 'hm-card' },
    el('h3', { class: 'hm-h', text: `Invited Guests (${guests.length})` }),
    guests.length
      ? el('ul', { class: 'hm-list' }, guests.map((g) => el('li', { class: 'hm-row' },
        el('div', { class: 'hm-row-main' },
          el('span', { class: 'hm-row-title', text: g.name }),
          el('span', { class: 'hm-meta', text: g.expiresAt ? 'Timed pass' : 'Standing invitation' })),
        el('button', {
          type: 'button', class: 'hm-btn hm-btn-danger',
          onclick: () => act('home.revokeGuest', { homeId: currentHome.id, targetId: g.id }),
        }, 'Revoke'))))
      : el('p', { class: 'hm-note', text: 'No guests invited yet.' }));

  const visitors = currentHome.visitors ?? [];
  const visitorsCard = el('section', { class: 'hm-card' },
    el('h3', { class: 'hm-h', text: `Active Visitors Inside (${visitors.length})` }),
    visitors.length
      ? el('ul', { class: 'hm-list' }, visitors.map((v) => el('li', { class: 'hm-row' },
        el('span', { class: 'hm-row-title', text: v.name }),
        el('button', {
          type: 'button', class: 'hm-btn hm-btn-danger',
          onclick: () => act('home.kickVisitor', { homeId: currentHome.id, targetId: v.id }),
        }, 'Dismiss'))))
      : el('p', { class: 'hm-note', text: 'No visitors are currently inside.' }));

  return el('div', { class: 'hm-grid' }, accessCard, el('div', { class: 'hm-stack' }, guestCard, visitorsCard));
}

function renderStorageTab({ character, currentHome, selectedChestId, act, patch }) {
  const containers = currentHome.containers ?? [];
  const activeChest = containers.find((c) => c.id === selectedChestId) ?? containers[0] ?? null;

  const chestTabs = el('div', { class: 'hm-actions' }, containers.map((c) => el('button', {
    type: 'button',
    class: `hm-btn${activeChest?.id === c.id ? ' is-active' : ''}`,
    onclick: () => patch({ selectedChestId: c.id }),
  }, `${c.name} (${c.items.length}/${c.capacity})`)));

  const chestCard = el('section', { class: 'hm-card' },
    el('div', { class: 'hm-card-head' },
      el('h3', { class: 'hm-h', text: activeChest ? `${activeChest.name} (${activeChest.items.length}/${activeChest.capacity})` : 'Storage Chest' }),
      el('span', { class: 'hm-badge hm-badge-verdigris', text: activeChest ? `Rev ${activeChest.revision}` : '—' })),
    chestTabs,
    activeChest?.items?.length
      ? el('ul', { class: 'hm-list' }, activeChest.items.map((it) => el('li', { class: 'hm-row' },
        el('div', { class: 'hm-row-main' },
          el('span', { class: 'hm-row-title', text: it.template === 'gold' ? `${it.quantity} Gold` : `${it.quantity > 1 ? `${it.quantity} × ` : ''}${it.name}` }),
          el('span', { class: 'hm-meta', text: it.template === 'gold' ? 'Currency' : `${it.group ?? 'item'} · Cond ${it.condition ?? it.maxCondition ?? 0}/${it.maxCondition ?? 0}${it.magic ? ' · Enchanted' : ''}` })),
        el('button', {
          type: 'button', class: 'hm-btn hm-btn-primary',
          onclick: () => act('home.storageWithdraw', {
            homeId: currentHome.id,
            containerId: activeChest.id,
            itemId: it.template === 'gold' ? 'gold' : it.id,
            quantity: it.quantity,
          }),
        }, 'Withdraw'))))
      : el('p', { class: 'hm-note', text: 'This storage chest is empty.' }));

  const packItems = character?.inventory ?? [];
  const packCard = el('section', { class: 'hm-card' },
    el('h3', { class: 'hm-h', text: `Your Pack (${packItems.length} items)` }),
    packItems.length
      ? el('ul', { class: 'hm-list' }, packItems.map((it) => {
        const ineligible = Boolean(it.equipped || it.quest || it.conjuredUntil || it.group === 'transport');
        const reason = it.equipped ? 'Equipped' : it.quest ? 'Quest' : it.conjuredUntil ? 'Conjured' : it.group === 'transport' ? 'Transport' : null;
        return el('li', { class: 'hm-row' },
          el('div', { class: 'hm-row-main' },
            el('span', { class: 'hm-row-title', text: `${it.quantity > 1 ? `${it.quantity} × ` : ''}${it.name}` }),
            el('span', { class: 'hm-meta', text: reason ? `Cannot store (${reason})` : `${it.weight ?? 0} kg each` })),
          el('button', {
            type: 'button',
            class: 'hm-btn',
            disabled: ineligible || !activeChest,
            onclick: () => act('home.storageDeposit', {
              homeId: currentHome.id,
              containerId: activeChest.id,
              itemId: it.id,
              quantity: it.quantity,
            }),
          }, 'Store'));
      }))
      : el('p', { class: 'hm-note', text: 'Your pack is empty.' }));

  return el('div', { class: 'hm-grid' }, chestCard, packCard);
}

export function install(api) {
  loadStyles();

  const ui = {
    overview: null,
    tab: 'overview',
    selectedHomeId: null,
    selectedCatalogId: 'oak-table',
    selectedChestId: 'chest-main',
    placeX: 3.2,
    placeZ: 2.4,
    placeFloor: 0,
    placeDeg: 0,
    inviteTargetId: '',
    inviteTargetName: '',
    status: '',
    saleQuote: null,
    synced: false,
    lastSelfId: api.selfId ?? api.state?.selfId ?? null,
  };
  let container = null;

  const rerender = () => {
    if (container?.isConnected) render(container);
    else if (api.panel === PANEL_ID) api.refreshPanel?.(PANEL_ID);
  };

  const resetPrivateCache = () => {
    ui.overview = null;
    ui.selectedHomeId = null;
    ui.saleQuote = null;
    ui.status = '';
    ui.synced = false;
  };

  const act = (verb, args = {}) => {
    try {
      api.act(verb, args);
    } catch (e) {
      api.message?.(e?.message || String(e), { kind: 'error' });
    }
  };

  api.on('event', (ev) => {
    if (!ev) return;
    if (ev.kind === 'home') {
      if (ev.overview) {
        ui.overview = ev.overview;
        if (!ui.selectedHomeId && ev.overview.owned?.length) {
          ui.selectedHomeId = ev.overview.owned[0].id;
        }
      }
      if (ev.quote) ui.saleQuote = ev.quote;
      if (ev.text) {
        ui.status = ev.text;
        ev.silent = true;
        api.message?.(ev.text, ev.error ? { kind: 'error' } : undefined);
      }
      rerender();
    } else if (ev.kind === 'home.furnishings' && ui.overview) {
      for (const h of ui.overview.owned ?? []) {
        if (h.id === ev.homeId) {
          h.furnishings = ev.furnishings;
          h.furnishingRev = ev.furnishingRev;
          if (ev.trader !== undefined) h.trader = ev.trader;
        }
      }
      if (ui.overview.activeHome?.id === ev.homeId) {
        ui.overview.activeHome.furnishings = ev.furnishings;
        ui.overview.activeHome.furnishingRev = ev.furnishingRev;
      }
      rerender();
    }
  });

  api.on('state', () => {
    const sid = api.selfId ?? api.state?.selfId ?? null;
    if (ui.lastSelfId != null && sid != null && ui.lastSelfId !== sid) {
      resetPrivateCache();
    }
    ui.lastSelfId = sid;
    if (!ui.synced && api.state) {
      ui.synced = true;
      act('home.overview');
    } else if (container?.isConnected) {
      rerender();
    }
  });

  api.on('screen', (s) => {
    if (s !== 'game') resetPrivateCache();
  });

  api.on('panel', (p) => {
    if (p?.id === PANEL_ID && p.open) {
      act('home.overview');
    }
  });

  function render(root) {
    container = root;
    renderHomesView(
      root,
      { ...ui, character: api.state?.character ?? null },
      {
        act,
        setState: (next) => {
          Object.assign(ui, next);
          rerender();
        },
      },
    );
  }

  api.registerPanel(PANEL_ID, PANEL_TITLE, render);
  return { ui, render, resetPrivateCache };
}

export default install;
