// Professions HUD & Contextual Views (§3):
//   - Professions sub-tab under Character: ranks, XP bars, recipe book, daily crafting writs
//   - Contextual Crafting Station view (Anvil & Forge, Carpenter Workbench, Cooking Hearth)
//   - Contextual Gathering Progress bar & nearby node prompt
//
// Exports for Wave 2B integration:
//   install(api)
//   renderProfessionsSubtab(container, state, actions)
//   renderCraftingStation(container, stationState, actions)
//   renderGatheringHud(container, gatherState, actions)

export const PANEL_ID = 'professions';
export const STATION_PANEL_ID = 'crafting-station';

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) {
    if (c != null && c !== '') n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
};

function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-professions-css]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./professions.css', import.meta.url).href;
  link.dataset.professionsCss = '';
  document.head.append(link);
}

function fmtDuration(ms) {
  const sec = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}h ${remM}m`;
}

function qualityBadgeClass(tier) {
  if (tier >= 4) return 'prof-qual prof-qual-master';
  if (tier === 3) return 'prof-qual prof-qual-sup';
  if (tier === 2) return 'prof-qual prof-qual-fine';
  return 'prof-qual prof-qual-std';
}

function trackKindLabel(kind) {
  if (kind === 'gathering') return 'Gathering';
  if (kind === 'crafting') return 'Crafting';
  return 'Classic Arcane';
}

/**
 * Renders the Professions sub-tab (designed to mount inside Character or standalone panel).
 * `state`: `{ professions, recipes, writs, gold, encumbrance, subtab?, recipeFilter?, busy?, error? }`
 * `actions`: `{ setSubtab(t), setRecipeFilter(f), turnInWrit(writId), refresh() }`
 */
export function renderProfessionsSubtab(container, state = {}, actions = {}) {
  container.replaceChildren();
  const subtab = state.subtab || 'ranks';
  const recipeFilter = state.recipeFilter || 'all';
  const tracks = state.professions?.tracks ?? [];
  const recipes = state.recipes ?? [];
  const board = state.writs ?? null;

  const root = el('div', { class: 'prof-root' });

  // Header & sub-navigation tabs
  const navTabs = [
    { id: 'ranks', label: 'Ranks & Mastery' },
    { id: 'recipes', label: `Recipe Book (${recipes.filter((r) => r.unlocked).length}/${recipes.length})` },
    { id: 'writs', label: `Daily Writs (${board ? `${board.completedCount}/${board.totalCount}` : '0/3'})` },
  ];

  root.append(
    el('header', { class: 'prof-head' },
      el('div', { class: 'prof-title-block' },
        el('h2', { text: 'Professions & Guild Craft' }),
        el('span', { class: 'prof-sub', text: 'Character mastery, known schematics, and daily account writs' }),
      ),
      el('div', { class: 'prof-head-meta' },
        state.gold != null ? el('span', { class: 'prof-stat-pill', text: `${state.gold} gp` }) : null,
        state.encumbrance ? el('span', { class: 'prof-stat-pill', text: `${Number(state.encumbrance.carried ?? 0).toFixed(1)} / ${Number(state.encumbrance.max ?? 0).toFixed(0)} kg` }) : null,
        actions.refresh ? el('button', { type: 'button', class: 'prof-btn prof-btn-sm', disabled: !!state.busy, onclick: () => actions.refresh() }, 'Refresh') : null,
      ),
    ),
    el('nav', { class: 'prof-tabs', role: 'tablist', 'aria-label': 'Professions sections' },
      navTabs.map((t) => el('button', {
        type: 'button',
        role: 'tab',
        'aria-selected': String(subtab === t.id),
        class: `prof-tab${subtab === t.id ? ' is-active' : ''}`,
        onclick: () => actions.setSubtab?.(t.id),
      }, t.label)),
    ),
  );

  if (state.error) {
    root.append(el('div', { class: 'prof-alert prof-alert-err', role: 'alert', text: state.error }));
  }

  if (subtab === 'ranks') {
    const groups = ['gathering', 'crafting', 'arcane'];
    const grid = el('div', { class: 'prof-groups' });
    for (const kind of groups) {
      const list = tracks.filter((t) => t.kind === kind);
      if (!list.length) continue;
      grid.append(
        el('section', { class: 'prof-group' },
          el('h3', { class: 'prof-section-hd', text: trackKindLabel(kind) }),
          el('div', { class: 'prof-track-grid' },
            list.map((t) => el('article', { class: 'prof-track-card' },
              el('div', { class: 'prof-track-top' },
                el('span', { class: 'prof-track-name', text: t.name }),
                el('span', { class: 'prof-rank-badge', text: `Rank ${t.rank} · ${t.title}` }),
              ),
              el('div', {
                class: 'prof-xp-track',
                role: 'progressbar',
                'aria-label': `${t.name} experience`,
                'aria-valuemin': 0,
                'aria-valuemax': 100,
                'aria-valuenow': t.pct,
              }, el('div', { class: 'prof-xp-fill', style: { width: `${t.pct}%` } })),
              el('div', { class: 'prof-track-foot' },
                el('span', { class: 'prof-mono', text: t.next != null ? `${t.xp} / ${t.next} XP` : `${t.xp} XP (MAX)` }),
                el('span', { class: 'prof-dim', text: `${t.actions ?? 0} ${kind === 'gathering' ? 'harvests' : 'crafts'}` }),
              ),
              el('p', { class: 'prof-desc', text: t.description }),
            )),
          ),
        ),
      );
    }
    root.append(grid);
  } else if (subtab === 'recipes') {
    const filters = [
      { id: 'all', label: 'All Tracks' },
      { id: 'smithing', label: 'Smithing' },
      { id: 'carpentry', label: 'Carpentry' },
      { id: 'cooking', label: 'Cooking' },
    ];
    const shown = recipeFilter === 'all' ? recipes : recipes.filter((r) => r.profession === recipeFilter);
    root.append(
      el('div', { class: 'prof-filter-bar' },
        filters.map((f) => el('button', {
          type: 'button',
          class: `prof-chip${recipeFilter === f.id ? ' is-active' : ''}`,
          onclick: () => actions.setRecipeFilter?.(f.id),
        }, f.label)),
      ),
      el('div', { class: 'prof-recipe-list' },
        shown.length
          ? shown.map((r) => el('article', { class: `prof-recipe-card${r.unlocked ? '' : ' is-locked'}` },
            el('div', { class: 'prof-recipe-head' },
              el('div', {},
                el('strong', { class: 'prof-recipe-name', text: r.name }),
                el('span', { class: 'prof-dim', text: ` · ${r.professionName} · ${r.stationLabel}` }),
              ),
              el('div', { class: 'prof-recipe-badges' },
                el('span', { class: qualityBadgeClass(r.quality?.tier ?? 1), text: r.quality?.label ?? 'Standard' }),
                el('span', { class: 'prof-rank-tag', text: `Rank ${r.minRank}` }),
                r.output?.furniture ? el('span', { class: 'prof-furn-tag', text: 'Furniture' }) : null,
              ),
            ),
            el('p', { class: 'prof-desc', text: r.description }),
            el('div', { class: 'prof-recipe-io' },
              el('div', { class: 'prof-inputs' },
                el('span', { class: 'prof-io-lbl', text: 'Inputs:' }),
                r.inputs.map((inp) => el('span', {
                  class: `prof-ing${inp.enough ? ' is-ok' : ' is-miss'}`,
                  text: `${inp.name} ${inp.have}/${inp.quantity}`,
                })),
              ),
              el('div', { class: 'prof-output' },
                el('span', { class: 'prof-io-lbl', text: 'Yields:' }),
                el('span', { class: 'prof-out-val', text: `${r.output.quantity} × ${r.output.name}` }),
                r.fee > 0 ? el('span', { class: 'prof-fee', text: `Fee ${r.fee} gp` }) : el('span', { class: 'prof-dim', text: 'No fee' }),
                el('span', { class: 'prof-xp-tag', text: `+${r.xp} XP` }),
              ),
            ),
          ))
          : el('p', { class: 'prof-empty', text: 'No recipes match this filter.' }),
      ),
    );
  } else if (subtab === 'writs') {
    root.append(
      el('div', { class: 'prof-writ-banner' },
        el('div', {},
          el('strong', { text: `Daily Crafting Writs — ${board?.utcDay ?? 'Today (UTC)'}` }),
          el('div', { class: 'prof-dim', text: 'Account-scoped allowance: each writ may be turned in once per UTC day across all character slots.' }),
        ),
        board ? el('span', { class: 'prof-stat-pill', text: `Resets in ${fmtDuration(board.resetInMs)}` }) : null,
      ),
      el('div', { class: 'prof-writ-grid' },
        (board?.writs ?? []).map((w) => el('article', { class: `prof-writ-card${w.completed ? ' is-done' : ''}` },
          el('div', { class: 'prof-writ-head' },
            el('span', { class: 'prof-rank-tag', text: w.professionName }),
            el('strong', { class: 'prof-writ-title', text: w.title }),
            w.completed
              ? el('span', { class: 'prof-done-badge', text: `Completed by ${w.completedBy?.characterName ?? 'Account'}` })
              : el('span', { class: 'prof-open-badge', text: 'Active' }),
          ),
          el('p', { class: 'prof-desc', text: w.description }),
          el('div', { class: 'prof-writ-reqs' },
            el('span', { class: 'prof-io-lbl', text: 'Deliver:' }),
            w.requirements.map((req) => el('span', {
              class: `prof-ing${req.enough || w.completed ? ' is-ok' : ' is-miss'}`,
              text: `${req.name} ${w.completed ? req.quantity : req.have}/${req.quantity}`,
            })),
          ),
          el('div', { class: 'prof-writ-foot' },
            el('div', { class: 'prof-writ-rewards' },
              el('span', { class: 'prof-stat-pill', text: `+${w.reward.gold} gp` }),
              el('span', { class: 'prof-xp-tag', text: `+${w.reward.xp} ${w.professionName} XP` }),
            ),
            el('button', {
              type: 'button',
              class: 'prof-btn prof-btn-primary',
              disabled: !!state.busy || w.completed || !w.canTurnIn,
              onclick: () => actions.turnInWrit?.(w.writId),
            }, w.completed ? 'Turned In' : 'Deliver Writ'),
          ),
        )),
      ),
    );
  }

  container.append(root);
}

/**
 * Renders the contextual Crafting Station panel (Anvil & Forge, Carpenter Workbench, Cooking Hearth).
 */
export function renderCraftingStation(container, stationState = {}, actions = {}) {
  container.replaceChildren();
  const station = stationState.station;
  const prof = stationState.profession;
  const recipes = stationState.recipes ?? [];
  const selectedId = stationState.selectedRecipeId ?? recipes[0]?.id ?? null;
  const selected = recipes.find((r) => r.id === selectedId) ?? recipes[0] ?? null;
  const qty = Math.max(1, Math.min(20, Math.trunc(Number(stationState.quantity ?? 1) || 1)));

  const root = el('div', { class: 'prof-root prof-station' });
  if (!station) {
    root.append(el('p', { class: 'prof-empty', text: 'Approach an Anvil, Carpenter Workbench, or Cooking Hearth and press Interact to craft.' }));
    container.append(root);
    return;
  }

  root.append(
    el('header', { class: 'prof-head' },
      el('div', { class: 'prof-title-block' },
        el('h2', { text: station.name }),
        el('span', { class: 'prof-sub', text: `${station.stationLabel} · ${prof?.name ?? ''} Rank ${prof?.rank ?? 1} (${prof?.title ?? 'Novice'})` }),
      ),
      el('div', { class: 'prof-head-meta' },
        el('span', { class: 'prof-stat-pill', text: `${stationState.gold ?? 0} gp` }),
        stationState.encumbrance
          ? el('span', { class: 'prof-stat-pill', text: `${Number(stationState.encumbrance.carried ?? 0).toFixed(1)} / ${Number(stationState.encumbrance.max ?? 0).toFixed(0)} kg` })
          : null,
        actions.close ? el('button', { type: 'button', class: 'prof-btn prof-btn-sm', onclick: () => actions.close() }, 'Leave Station') : null,
      ),
    ),
  );

  if (prof) {
    root.append(
      el('div', { class: 'prof-station-xp' },
        el('span', { class: 'prof-mono', text: `${prof.name} Rank ${prof.rank}` }),
        el('div', { class: 'prof-xp-track' }, el('div', { class: 'prof-xp-fill', style: { width: `${prof.pct ?? 0}%` } })),
        el('span', { class: 'prof-mono', text: prof.next != null ? `${prof.xp}/${prof.next} XP` : 'MAX' }),
      ),
    );
  }

  if (stationState.error) {
    root.append(el('div', { class: 'prof-alert prof-alert-err', role: 'alert', text: stationState.error }));
  }
  if (stationState.notice) {
    root.append(el('div', { class: 'prof-alert prof-alert-ok', role: 'status', text: stationState.notice }));
  }

  const list = el('ul', { class: 'prof-station-list', role: 'listbox', 'aria-label': 'Station recipes' },
    recipes.map((r) => el('li', {},
      el('button', {
        type: 'button',
        class: `prof-station-item${selected?.id === r.id ? ' is-selected' : ''}${r.unlocked ? '' : ' is-locked'}`,
        onclick: () => actions.selectRecipe?.(r.id),
      },
        el('span', { class: 'prof-station-item-name', text: r.name }),
        el('span', { class: r.canCraft ? 'prof-ready-dot' : 'prof-dim', text: !r.unlocked ? `R${r.minRank}` : (r.canCraft ? 'Ready' : 'Need mats') }),
      ),
    )),
  );

  let detail;
  if (selected) {
    const totalFee = (selected.fee || 0) * qty;
    const totalOutQty = selected.output.quantity * qty;
    const allInputsReady = selected.inputs.every((i) => i.have >= i.quantity * qty);
    const goldReady = (stationState.gold ?? 0) >= totalFee;
    const canSubmit = selected.unlocked && allInputsReady && goldReady && !stationState.busy;

    detail = el('section', { class: 'prof-station-detail' },
      el('div', { class: 'prof-detail-head' },
        el('h3', { text: selected.name }),
        el('span', { class: qualityBadgeClass(selected.quality?.tier ?? 1), text: `${selected.quality?.label ?? 'Standard'} Quality` }),
      ),
      el('p', { class: 'prof-desc', text: selected.description }),
      el('div', { class: 'prof-detail-block' },
        el('h4', { text: 'Required Materials' }),
        el('ul', { class: 'prof-req-list' },
          selected.inputs.map((inp) => {
            const need = inp.quantity * qty;
            const ok = inp.have >= need;
            return el('li', { class: `prof-req-row${ok ? ' is-ok' : ' is-miss'}` },
              el('span', { text: inp.name }),
              el('span', { class: 'prof-mono', text: `${inp.have} / ${need}` }),
            );
          }),
        ),
      ),
      el('div', { class: 'prof-detail-block' },
        el('h4', { text: 'Output & Station Terms' }),
        el('div', { class: 'prof-kv-grid' },
          el('span', { class: 'prof-dim', text: 'Produces' }),
          el('strong', { text: `${totalOutQty} × ${selected.output.name}` }),
          el('span', { class: 'prof-dim', text: 'Weight' }),
          el('span', { class: 'prof-mono', text: `${(selected.output.weight * totalOutQty).toFixed(2)} kg` }),
          el('span', { class: 'prof-dim', text: 'Station Fee' }),
          el('span', { class: `prof-mono${goldReady ? '' : ' is-miss'}`, text: totalFee > 0 ? `${totalFee} gp` : 'Free' }),
          el('span', { class: 'prof-dim', text: 'Mastery Gain' }),
          el('span', { class: 'prof-xp-tag', text: `+${selected.xp * qty} ${selected.professionName} XP` }),
          selected.output.furniture ? el('span', { class: 'prof-dim', text: 'Placement' }) : null,
          selected.output.furniture ? el('span', { text: `Home / Order Hall (${selected.output.furniture.category})` }) : null,
        ),
      ),
      el('div', { class: 'prof-craft-bar' },
        el('label', { class: 'prof-qty-box' },
          el('span', { class: 'prof-dim', text: 'Batch' }),
          el('input', {
            type: 'number',
            min: 1,
            max: 20,
            value: qty,
            class: 'prof-qty-input',
            'aria-label': 'Craft quantity',
            onchange: (e) => actions.setQuantity?.(Math.max(1, Math.min(20, Number(e.target.value) || 1))),
          }),
        ),
        el('button', {
          type: 'button',
          class: 'prof-btn prof-btn-primary prof-craft-go',
          disabled: !canSubmit,
          onclick: () => actions.craft?.(station.id, selected.id, qty),
        }, stationState.busy ? 'Crafting…' : `Craft ${selected.output.name}`),
      ),
    );
  } else {
    detail = el('section', { class: 'prof-station-detail' }, el('p', { class: 'prof-empty', text: 'Select a recipe to inspect inputs.' }));
  }

  root.append(el('div', { class: 'prof-station-grid' }, list, detail));
  container.append(root);
}

/**
 * Renders the contextual Gathering Progress HUD & nearby resource node prompt overlay.
 * `gatherState`: `{ active: { nodeId, nodeName, professionName, toolName, elapsedMs, durationMs, charges, maxCharges } | null, nearbyNode: object | null, lastResult?: string }`
 */
export function renderGatheringHud(container, gatherState = {}, actions = {}) {
  container.replaceChildren();
  const active = gatherState.active;
  const node = gatherState.nearbyNode;
  if (!active && !node && !gatherState.lastResult) return;

  const wrap = el('div', { class: 'prof-gather-hud', role: 'region', 'aria-label': 'Gathering status' });

  if (node && !active) {
    wrap.append(
      el('div', { class: 'prof-node-prompt' },
        el('div', { class: 'prof-node-head' },
          el('span', { class: 'prof-node-glyph', text: node.marker?.glyph ?? '◆', style: { color: node.marker?.color ?? '#5fa3a5' } }),
          el('strong', { text: node.name }),
          el('span', { class: 'prof-rank-tag', text: `${node.professionName} R${node.minRank}` }),
        ),
        el('div', { class: 'prof-node-meta' },
          el('span', { text: `Tool: ${node.requiredToolLabel}` }),
          el('span', { class: 'prof-mono', text: node.depleted ? `Depleted (${fmtDuration(node.respawnRemainingMs)})` : `Charges ${node.charges}/${node.maxCharges}` }),
        ),
        actions.startGather
          ? el('button', {
            type: 'button',
            class: 'prof-btn prof-btn-primary prof-btn-sm',
            disabled: !!node.depleted,
            onclick: () => actions.startGather(node.id),
          }, node.depleted ? 'Recovering…' : '[G] Gather')
          : null,
      ),
    );
  }

  if (active) {
    const pct = Math.max(0, Math.min(100, Math.round(((active.elapsedMs ?? 0) / Math.max(1, active.durationMs ?? 2000)) * 100)));
    const remSec = Math.max(0, ((active.durationMs ?? 2000) - (active.elapsedMs ?? 0)) / 1000).toFixed(1);
    wrap.append(
      el('div', { class: 'prof-gather-bar-card' },
        el('div', { class: 'prof-gather-top' },
          el('strong', { text: `Gathering ${active.nodeName}` }),
          el('span', { class: 'prof-mono', text: `${remSec}s` }),
        ),
        el('div', {
          class: 'prof-xp-track prof-gather-track',
          role: 'progressbar',
          'aria-label': `Gathering ${active.nodeName}`,
          'aria-valuemin': 0,
          'aria-valuemax': 100,
          'aria-valuenow': pct,
        }, el('div', { class: 'prof-xp-fill prof-gather-fill', style: { width: `${pct}%` } })),
        el('div', { class: 'prof-gather-foot' },
          el('span', { class: 'prof-dim', text: `${active.professionName} · ${active.toolName ?? 'Tool'} · Charges ${active.charges ?? '?'}/${active.maxCharges ?? '?'}` }),
          actions.cancelGather
            ? el('button', { type: 'button', class: 'prof-btn prof-btn-sm', onclick: () => actions.cancelGather() }, 'Cancel')
            : null,
        ),
      ),
    );
  }

  if (gatherState.lastResult) {
    wrap.append(el('div', { class: 'prof-gather-toast', role: 'status', text: gatherState.lastResult }));
  }

  container.append(wrap);
}

/**
 * Installs the Professions gameplay feature into the client gameplay API.
 * Registers the `professions` panel, the contextual `crafting-station` panel,
 * mounts the gathering progress overlay, and intercepts `interactIntent` for
 * `resource_node` and `crafting_station` entities.
 */
export function install(api) {
  if (typeof document === 'undefined') return null;
  loadStyles();

  const ui = {
    subtab: 'ranks',
    recipeFilter: 'all',
    summary: null,
    station: null,
    selectedRecipeId: null,
    quantity: 1,
    activeGather: null,
    nearbyNode: null,
    lastResult: null,
    busy: false,
    error: null,
    notice: null,
    selfId: null,
    profContainer: null,
    stationContainer: null,
    hudHost: null,
    gatherTimer: null,
    completeSent: false,
  };

  function clearPrivateState() {
    if (ui.gatherTimer) {
      clearInterval(ui.gatherTimer);
      ui.gatherTimer = null;
    }
    ui.summary = null;
    ui.station = null;
    ui.activeGather = null;
    ui.nearbyNode = null;
    ui.lastResult = null;
    ui.error = null;
    ui.notice = null;
    ui.busy = false;
    ui.completeSent = false;
    renderHud();
  }

  function ensureHudHost() {
    if (ui.hudHost?.isConnected) return ui.hudHost;
    const host = el('div', { id: 'prof-gather-hud-host' });
    document.body.append(host);
    ui.hudHost = host;
    return host;
  }

  function renderHud() {
    if (!ui.hudHost && !ui.activeGather && !ui.nearbyNode && !ui.lastResult) return;
    renderGatheringHud(ensureHudHost(), {
      active: ui.activeGather,
      nearbyNode: ui.nearbyNode,
      lastResult: ui.lastResult,
    }, {
      startGather: (nodeId) => api.act('profession.gatherStart', { nodeId }),
      cancelGather: () => api.act('profession.gatherCancel', {}),
    });
  }

  function rerenderProfessions() {
    if (!ui.profContainer?.isConnected || api.panel !== PANEL_ID) return;
    renderProfessionsSubtab(ui.profContainer, {
      ...(ui.summary || {}),
      subtab: ui.subtab,
      recipeFilter: ui.recipeFilter,
      busy: ui.busy,
      error: ui.error,
    }, {
      setSubtab: (t) => { ui.subtab = t; rerenderProfessions(); },
      setRecipeFilter: (f) => { ui.recipeFilter = f; rerenderProfessions(); },
      refresh: () => api.act('profession.summary', {}),
      turnInWrit: (writId) => {
        ui.busy = true;
        ui.error = null;
        rerenderProfessions();
        const opKey = `writ-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        api.act('profession.writTurnIn', { writId, opKey });
      },
    });
  }

  function rerenderStation() {
    if (!ui.stationContainer?.isConnected || api.panel !== STATION_PANEL_ID) return;
    renderCraftingStation(ui.stationContainer, {
      ...(ui.station || {}),
      selectedRecipeId: ui.selectedRecipeId,
      quantity: ui.quantity,
      busy: ui.busy,
      error: ui.error,
      notice: ui.notice,
    }, {
      selectRecipe: (id) => { ui.selectedRecipeId = id; ui.notice = null; rerenderStation(); },
      setQuantity: (q) => { ui.quantity = q; rerenderStation(); },
      close: () => api.closePanel?.(),
      craft: (stationId, recipeId, quantity) => {
        ui.busy = true;
        ui.error = null;
        ui.notice = null;
        rerenderStation();
        const opKey = `craft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        api.act('profession.craft', { stationId, recipeId, quantity, opKey });
      },
    });
  }

  function startGatherTicker() {
    if (ui.gatherTimer) clearInterval(ui.gatherTimer);
    ui.completeSent = false;
    ui.gatherTimer = setInterval(() => {
      if (!ui.activeGather) {
        clearInterval(ui.gatherTimer);
        ui.gatherTimer = null;
        return;
      }
      const elapsed = Date.now() - ui.activeGather.startedLocalAt;
      ui.activeGather.elapsedMs = elapsed;
      renderHud();
      if (elapsed >= ui.activeGather.durationMs && !ui.completeSent) {
        ui.completeSent = true;
        const opKey = `gather-${ui.activeGather.nodeId}-${ui.activeGather.startedLocalAt}`;
        api.act('profession.gatherComplete', { nodeId: ui.activeGather.nodeId, opKey });
      }
    }, 100);
  }

  api.registerPanel(PANEL_ID, 'Professions', (root) => {
    ui.profContainer = root;
    if (!ui.summary) api.act('profession.summary', {});
    rerenderProfessions();
  }, { order: 1.5 });

  api.registerPanel(STATION_PANEL_ID, 'Crafting Station', (root) => {
    ui.stationContainer = root;
    rerenderStation();
  }, { order: 6.7 });

  api.on('state', (st) => {
    const nextId = st?.selfId ?? api.selfId ?? null;
    if (ui.selfId != null && nextId != null && String(ui.selfId) !== String(nextId)) {
      clearPrivateState();
    }
    ui.selfId = nextId;
  });

  api.on('interactIntent', (intent) => {
    const ent = intent?.entity ?? intent;
    if (!ent || typeof ent !== 'object') return;
    if (ent.kind === 'resource_node') {
      intent.handled = true;
      api.act('profession.gatherStart', { nodeId: ent.id });
    } else if (ent.kind === 'crafting_station') {
      intent.handled = true;
      api.act('profession.stationOpen', { stationId: ent.id });
    }
  });

  api.on('event', (ev) => {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.kind) {
      case 'profession.summary':
        ui.busy = false;
        ui.error = null;
        ui.summary = ev;
        rerenderProfessions();
        break;
      case 'profession.station':
        ui.busy = false;
        ui.error = null;
        ui.station = ev;
        if (!ev.recipes?.some((r) => r.id === ui.selectedRecipeId)) {
          ui.selectedRecipeId = ev.recipes?.[0]?.id ?? null;
        }
        if (api.panel !== STATION_PANEL_ID) api.openPanel(STATION_PANEL_ID);
        rerenderStation();
        break;
      case 'profession.crafted':
        ui.busy = false;
        ui.notice = ev.text ?? 'Item crafted.';
        if (ui.station?.station?.id) api.act('profession.stationOpen', { stationId: ui.station.station.id });
        if (api.panel === PANEL_ID) api.act('profession.summary', {});
        rerenderStation();
        break;
      case 'profession.writBoard':
        ui.busy = false;
        ui.summary = { ...(ui.summary || {}), writs: ev.board };
        rerenderProfessions();
        break;
      case 'profession.writCompleted':
        ui.busy = false;
        ui.summary = { ...(ui.summary || {}), writs: ev.board };
        api.act('profession.summary', {});
        rerenderProfessions();
        break;
      case 'profession.gatherStarted':
        ui.lastResult = null;
        ui.activeGather = {
          nodeId: ev.nodeId,
          nodeName: ev.nodeName,
          professionName: ev.professionName,
          toolName: ev.toolName,
          durationMs: ev.durationMs,
          charges: ev.charges,
          maxCharges: ev.maxCharges,
          startedLocalAt: Date.now(),
          elapsedMs: 0,
        };
        startGatherTicker();
        renderHud();
        break;
      case 'profession.gatherComplete':
        if (ui.gatherTimer) { clearInterval(ui.gatherTimer); ui.gatherTimer = null; }
        ui.activeGather = null;
        ui.lastResult = ev.text ?? 'Harvest complete.';
        renderHud();
        setTimeout(() => { if (ui.lastResult === (ev.text ?? 'Harvest complete.')) { ui.lastResult = null; renderHud(); } }, 3500);
        if (api.panel === PANEL_ID) api.act('profession.summary', {});
        break;
      case 'profession.gatherInterrupted':
        if (ui.gatherTimer) { clearInterval(ui.gatherTimer); ui.gatherTimer = null; }
        ui.activeGather = null;
        if (ev.text && !ev.silent) {
          ui.lastResult = ev.text;
          setTimeout(() => { if (ui.lastResult === ev.text) { ui.lastResult = null; renderHud(); } }, 3000);
        }
        renderHud();
        break;
      case 'profession.nodeDelta':
        if (ui.nearbyNode?.id === ev.node?.id) {
          ui.nearbyNode = ev.node;
          renderHud();
        }
        break;
      default:
    }
  });

  return {
    renderProfessionsSubtab,
    renderCraftingStation,
    renderGatheringHud,
    clearPrivateState,
  };
}
