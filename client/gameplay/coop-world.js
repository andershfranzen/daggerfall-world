// Co-op, Instances, Smaller Dungeons, Quest Repair, Delves, Living World, Survival & Endgame UI.
//
// Exports:
//   install(api)            registers the `coopWorld` panel and in-world Survival/Follower HUD overlay.
//   coopWorldView(state, s) pure view-model builder (DOM-free, unit-testable in Node).

export const PANEL_ID = 'coopWorld';

export const TABS = Object.freeze([
  { id: 'dungeons', label: 'Dungeons & Instances' },
  { id: 'delves', label: 'Delves & Bounties' },
  { id: 'quests', label: 'Party Quests & Repair' },
  { id: 'living', label: 'Living World & Follower' },
  { id: 'survival', label: 'Survival' },
  { id: 'endgame', label: 'Renown, Wardrobe & Rules' },
]);

const DEFAULT_DELVES = Object.freeze([
  { id: 'delve-peristair-crypt', title: 'Vault of the Ash Warden', region: 'Daggerfall', bossName: 'Ash Warden Malakor', bossHp: 240, bossMaxHp: 240, participantCount: 0, status: 'open', baseGold: 220, baseRenown: 25, scaling: { participants: 1, hpMultiplier: 1 } },
  { id: 'delve-gothway-catacombs', title: 'Gothway Hollows Breach', region: 'Daggerfall', bossName: 'Hollows Reaver', bossHp: 180, bossMaxHp: 180, participantCount: 0, status: 'open', baseGold: 150, baseRenown: 15, scaling: { participants: 1, hpMultiplier: 1 } },
  { id: 'delve-sentinel-tomb', title: 'Sunken Reliquary of Alik’r', region: "Alik'r Desert", bossName: 'Dune Lich', bossHp: 320, bossMaxHp: 320, participantCount: 0, status: 'open', baseGold: 340, baseRenown: 40, scaling: { participants: 1, hpMultiplier: 1 } },
]);

const DEFAULT_RESIDENTS = Object.freeze([
  { id: 'res-maren-vell', name: 'Maren Vell', role: 'Quartermaster', label: 'Gothway Market Square', recruitable: false, relationship: { affinity: 0, tier: 'Acquaintance' } },
  { id: 'res-aldric-thorne', name: 'Aldric Thorne', role: 'Sellsword Companion', label: 'Gothway North Gate', recruitable: true, hireGold: 50, relationship: { affinity: 0, tier: 'Acquaintance' } },
  { id: 'res-lyra-ashford', name: 'Lyra Ashford', role: 'Hedge Alchemist', label: 'General Store', recruitable: true, hireGold: 75, minAffinity: 10, relationship: { affinity: 0, tier: 'Acquaintance' } },
]);

const DEFAULT_PARTY_BOARD = Object.freeze([
  { id: 'pq-peristair-purge', title: 'Purge of Peristair', site: 'dungeon:Daggerfall/The Dungeon of Peristair', goal: 4, rewardGold: 250, rewardRenown: 20, minPartySize: 2 },
  { id: 'pq-gothway-patrol', title: 'Gothway Watch Patrol', site: 'town:Daggerfall/Gothway Garden', goal: 3, rewardGold: 160, rewardRenown: 12, minPartySize: 1 },
]);

const DEFAULT_COSMETICS = Object.freeze([
  { id: 'cloak-daggerfall-crimson', slot: 'cloak', name: 'Daggerfall Crimson Cloak', rarity: 'common' },
  { id: 'cloak-sentinel-gold', slot: 'cloak', name: 'Sentinel Sun-Weave Cloak', rarity: 'rare' },
  { id: 'dye-wayrest-emerald', slot: 'dye', name: 'Wayrest Emerald Dye', rarity: 'common' },
  { id: 'heraldry-dragon-crest', slot: 'heraldry', name: 'Dragon Crest Tabard', rarity: 'epic' },
  { id: 'title-bay-explorer', slot: 'title', name: 'Explorer of the Iliac Bay', rarity: 'rare' },
]);

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = String(v);
    else if (k === 'value') n.value = String(v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
}

function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-feature="coop-world"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./coop-world.css', import.meta.url).href;
  link.dataset.feature = 'coop-world';
  document.head.append(link);
}

/** Pure view-model derived from RPG snapshot + server event cache (testable in Node). */
export function coopWorldView(state, cache = {}) {
  const rpg = state?.character ?? {};
  const inst = cache.instanceState ?? {
    preferredMode: rpg.dungeonInstance?.preferredMode ?? 'public',
    preferredLayout: rpg.dungeonInstance?.preferredLayout ?? rpg.dungeonLayout?.preference ?? 'classic',
    active: rpg.dungeonInstance?.active ?? null,
    recallAnchor: rpg.dungeonInstance?.recallAnchor ?? null,
    previewLayout: cache.dungeonLayout?.layout ?? {
      dungeonName: 'The Dungeon of Peristair',
      mode: rpg.dungeonInstance?.preferredLayout ?? 'classic',
      blockCount: (rpg.dungeonInstance?.preferredLayout === 'smaller') ? 5 : 8,
      layoutId: rpg.dungeonInstance?.preferredLayout === 'smaller' ? 'smaller:v1:peristair' : 'classic:v1:peristair',
    },
  };
  const survival = cache.survival ?? rpg.survival ?? {
    enabled: false, food: 100, water: 100, warmth: 100, exposure: 0, rations: 4, waterskin: 4, camp: null, penalties: { warnings: [] },
  };
  const living = cache.livingWorld ?? {
    pilotTown: 'town:Daggerfall/Gothway Garden',
    hour: 12,
    residents: DEFAULT_RESIDENTS,
    caravans: [{ id: 'caravan-iliac-north', name: 'Gothway–Daggerfall Merchant Train', stopLabel: 'Gothway Garden', nextLabel: 'Daggerfall Gate', progress: 0.35 }],
    follower: rpg.livingWorld?.follower ?? null,
  };
  const delves = cache.delveBoard ?? DEFAULT_DELVES;
  const partyQuests = cache.partyQuests ?? [];
  const partyBoard = cache.partyBoard ?? DEFAULT_PARTY_BOARD;
  const repair = cache.questRepair ?? { findings: [], actionableCount: 0, history: rpg.questRepairs ?? [] };
  const seaBounties = cache.seaBounties ?? { bounties: [], admiralty: { region: 'Daggerfall', standing: 0, rank: { title: 'Unsworn' } } };
  const endgame = cache.endgame ?? {
    endgame: rpg.endgame ?? { renown: 0, firmamentId: 'warrior', specId: 'vanguard', setId: 'set-sentinel-guard', setPieces: 2, tier: { title: 'Wayfarer', rank: 0 } },
    activeBuild: null,
  };
  const wardrobe = cache.wardrobe ?? {
    wardrobe: rpg.wardrobe ?? { unlocked: ['cloak-daggerfall-crimson', 'dye-wayrest-emerald', 'title-bay-explorer'], equipped: { cloak: 'cloak-daggerfall-crimson', dye: 'dye-wayrest-emerald', title: 'title-bay-explorer' } },
    catalog: DEFAULT_COSMETICS,
  };
  const succession = cache.succession ?? rpg.succession ?? { lineageName: 'House Lineage', generation: 1, heirName: null, heirloomItemIds: [] };
  const rules = cache.optionalRules ?? {};
  const expansions = cache.expansions ?? [];
  return {
    location: rpg.location ?? state?.location ?? 'town:Daggerfall/Gothway Garden',
    inst,
    survival,
    living,
    delves,
    partyQuests,
    partyBoard,
    repair,
    seaBounties,
    endgame,
    wardrobe,
    succession,
    rules,
    expansions,
  };
}

export function install(api) {
  loadStyles();

  const ui = {
    tab: 'dungeons',
    status: '',
    cache: {},
    hudEl: null,
    bountyTargetId: '',
    bountyAmount: '200',
    bountyReason: 'Piracy off Daggerfall',
    heirInput: '',
  };

  let container = null;

  const act = (verb, args = {}, opts = {}) => {
    try {
      return api.act(verb, args, opts);
    } catch (err) {
      if (!opts?.quiet) api.message(err?.message || String(err), { kind: 'error' });
      return false;
    }
  };

  api.on?.('characterChange', () => { ui.cache = {}; ui.status = ''; rerender(); });
  api.on?.('disconnect', () => { ui.cache = {}; ui.status = ''; rerender(); });

  const syncAll = () => {
    act('instance.status', {}, { quiet: true });
    act('dungeon.layout.info', {}, { quiet: true });
    act('delve.board', {}, { quiet: true });
    act('partyQuest.sync', {}, { quiet: true });
    act('quest.repair.scan', {}, { quiet: true });
    act('living.status', {}, { quiet: true });
    act('survival.status', {}, { quiet: true });
    act('seaBounty.board', {}, { quiet: true });
    act('endgame.status', {}, { quiet: true });
    act('wardrobe.status', {}, { quiet: true });
    act('succession.status', {}, { quiet: true });
    act('rules.status', {}, { quiet: true });
    act('expansion.list', {}, { quiet: true });
  };

  const rerender = () => {
    if (container?.isConnected) renderPanel(container);
    renderHud();
  };

  api.on('event', (ev) => {
    if (!ev || typeof ev !== 'object') return;
    let touched = true;
    switch (ev.kind) {
      case 'instanceState':
      case 'instanceSelection':
        ui.cache.instanceState = { ...(ui.cache.instanceState || {}), ...ev };
        break;
      case 'dungeonLayout':
        ui.cache.dungeonLayout = ev;
        if (ev.layout) {
          ui.cache.instanceState = { ...(ui.cache.instanceState || {}), previewLayout: ev.layout, preferredLayout: ev.preference ?? ev.layout.mode };
        }
        break;
      case 'delveBoard':
      case 'delveState':
      case 'delveClaim':
        if (Array.isArray(ev.board)) ui.cache.delveBoard = ev.board;
        break;
      case 'partyQuest':
        if (Array.isArray(ev.quests)) ui.cache.partyQuests = ev.quests;
        if (Array.isArray(ev.board)) ui.cache.partyBoard = ev.board;
        break;
      case 'questRepair':
        ui.cache.questRepair = ev;
        break;
      case 'livingWorld':
        ui.cache.livingWorld = ev;
        break;
      case 'follower':
        ui.cache.livingWorld = { ...(ui.cache.livingWorld || {}), follower: ev.follower };
        break;
      case 'survival':
        ui.cache.survival = ev.survival;
        break;
      case 'seaBounty':
      case 'seaBountyClaimed':
        ui.cache.seaBounties = { bounties: ev.bounties ?? [], admiralty: ev.admiralty };
        break;
      case 'endgame':
        ui.cache.endgame = ev;
        break;
      case 'buildComparison':
        ui.cache.buildComparison = ev.comparison;
        break;
      case 'wardrobe':
        ui.cache.wardrobe = ev;
        break;
      case 'succession':
        ui.cache.succession = ev.succession;
        break;
      case 'optionalRules':
        ui.cache.optionalRules = ev.rules ?? {};
        break;
      case 'expansions':
        ui.cache.expansions = ev.provinces ?? [];
        break;
      default:
        touched = false;
    }
    if (touched) {
      if (ev.text) ui.status = ev.text;
      rerender();
    }
  });

  api.on('state', () => renderHud());
  api.on('screen', () => renderHud());
  api.on('panel', (p) => {
    if (p?.id === PANEL_ID && p.open) syncAll();
  });
  api.on('panelDetail', (d) => {
    if (d?.id === PANEL_ID && d.detail?.tab && TABS.some((t) => t.id === d.detail.tab)) {
      ui.tab = d.detail.tab;
      rerender();
    }
  });

  // ------------------------------------------------------------ In-world compact HUD widget
  function meterBar(label, value, cls) {
    const pct = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    return el('div', { class: `cw-meter ${cls}` },
      el('div', { class: 'cw-meter-head' }, el('span', { text: label }), el('span', { text: `${pct}%` })),
      el('div', { class: 'cw-meter-track' }, el('div', { class: 'cw-meter-fill', style: `width:${pct}%` })),
    );
  }

  function renderHud() {
    if (typeof document === 'undefined') return;
    const host = document.getElementById('hud') || document.body;
    if (!host) return;
    const v = coopWorldView(api.state, ui.cache);
    const showSurvival = Boolean(v.survival?.enabled);
    const showFollower = Boolean(v.living?.follower?.active);
    const inWorld = api.screen === 'game' || Boolean(document.getElementById('hud') && !document.getElementById('hud').hidden);

    if (!inWorld || (!showSurvival && !showFollower)) {
      if (ui.hudEl) ui.hudEl.hidden = true;
      return;
    }

    if (!ui.hudEl || !ui.hudEl.isConnected) {
      ui.hudEl = el('aside', { class: 'cw-hud', id: 'cw-world-hud', 'aria-label': 'Living World & Survival HUD' });
      host.append(ui.hudEl);
    }
    ui.hudEl.hidden = false;
    ui.hudEl.replaceChildren();

    if (showSurvival) {
      const s = v.survival;
      const warnText = s.penalties?.warnings?.length ? s.penalties.warnings.join(' · ') : (s.camp?.active ? 'Campfire Lit' : 'Steady');
      ui.hudEl.append(
        el('div', { class: 'cw-hud-card', 'data-hud-survival': '' },
          el('div', { class: 'cw-hud-title' }, el('strong', { text: 'Survival' }), el('span', { class: 'cw-badge', text: warnText })),
          meterBar('Food', s.food, 'cw-food'),
          meterBar('Water', s.water, 'cw-water'),
          meterBar('Warmth', s.warmth, 'cw-warmth'),
          el('div', { class: 'cw-hud-actions' },
            el('button', { type: 'button', class: 'cw-btn-sm', text: `Eat (${s.rations ?? 0})`, onclick: () => act('survival.eat', {}) }),
            el('button', { type: 'button', class: 'cw-btn-sm', text: `Drink (${s.waterskin ?? 0})`, onclick: () => act('survival.drink', {}) }),
            el('button', { type: 'button', class: 'cw-btn-sm', text: s.camp?.active ? 'Pack Camp' : 'Camp', onclick: () => act('survival.camp', { action: s.camp?.active ? 'pack' : 'pitch' }) }),
          ),
        ),
      );
    }

    if (showFollower) {
      const f = v.living.follower;
      ui.hudEl.append(
        el('div', { class: 'cw-hud-card', 'data-hud-follower': '' },
          el('div', { class: 'cw-hud-title' }, el('strong', { text: f.name }), el('span', { class: 'cw-badge', text: f.stance || 'follow' })),
          el('div', { class: 'cw-hud-sub', text: `${f.role} · ${f.location || v.location}` }),
          el('div', { class: 'cw-hud-actions' },
            el('button', { type: 'button', class: 'cw-btn-sm', text: 'Recall', onclick: () => act('follower.recall', {}) }),
            el('button', { type: 'button', class: 'cw-btn-sm', text: f.stance === 'hold' ? 'Follow' : 'Hold', onclick: () => act('follower.stance', { stance: f.stance === 'hold' ? 'follow' : 'hold' }) }),
            el('button', { type: 'button', class: 'cw-btn-sm', text: 'Dismiss', onclick: () => act('follower.dismiss', {}) }),
          ),
        ),
      );
    }
  }

  // ------------------------------------------------------------ Main Panel Renderers
  function renderDungeonsTab(v) {
    const inst = v.inst;
    const layout = inst.previewLayout ?? {};
    const modeRow = el('div', { class: 'cw-row' },
      ['public', 'personal', 'party'].map((mode) =>
        el('button', {
          type: 'button',
          class: `cw-chip${inst.preferredMode === mode ? ' active' : ''}`,
          'data-instance-mode': mode,
          text: mode[0].toUpperCase() + mode.slice(1),
          onclick: () => act('instance.select', { mode, layoutMode: inst.preferredLayout }),
        }),
      ),
    );
    const layoutRow = el('div', { class: 'cw-row' },
      ['classic', 'smaller'].map((lm) =>
        el('button', {
          type: 'button',
          class: `cw-chip${inst.preferredLayout === lm ? ' active' : ''}`,
          'data-layout-mode': lm,
          text: lm === 'smaller' ? 'DFU Smaller Dungeon (5 Blocks)' : 'Classic Multi-Block Layout',
          onclick: () => {
            act('dungeon.layout.select', { mode: lm });
            act('instance.select', { mode: inst.preferredMode, layoutMode: lm });
          },
        }),
      ),
    );

    return el('div', { class: 'cw-grid' },
      el('section', { class: 'cw-card' },
        el('h3', { text: 'Dungeon Instance Selector' }),
        el('p', { class: 'cw-muted', text: 'Choose Public, Personal, or Party entry. Mechanisms, enemies, loot, Recall anchors, and automap memory bind to the selected instance.' }),
        el('div', { class: 'cw-label', text: 'Entry Scope' }),
        modeRow,
        el('div', { class: 'cw-label', text: 'Layout Mode (DFU Smaller Dungeons)' }),
        layoutRow,
        el('div', { class: 'cw-meta-box' },
          el('div', { text: `Target Site: ${layout.dungeonName || 'The Dungeon of Peristair'}` }),
          el('div', { text: `Assigned Layout ID: ${layout.layoutId || 'classic:v1'}` }),
          el('div', { text: `Blocks: ${layout.blockCount ?? 5} · Active Instance: ${inst.active?.instanceId || 'None (Exterior)'}` }),
        ),
        el('div', { class: 'cw-row' },
          el('button', { type: 'button', class: 'cw-btn primary', text: 'Enter Selected Instance', onclick: () => act('instance.enter', { mode: inst.preferredMode, layoutMode: inst.preferredLayout }) }),
          el('button', { type: 'button', class: 'cw-btn', text: 'Leave Instance', onclick: () => act('instance.leave', {}) }),
          el('button', { type: 'button', class: 'cw-btn', text: 'Wipe Recovery', onclick: () => act('instance.recover', {}) }),
        ),
      ),
      el('section', { class: 'cw-card' },
        el('h3', { text: 'Instance Recall Anchor' }),
        el('p', { class: 'cw-muted', text: 'Bind Recall to your active instance and layoutId so returning restores the exact dungeon geometry.' }),
        el('div', { class: 'cw-meta-box' },
          el('div', { text: inst.recallAnchor ? `Bound: ${inst.recallAnchor.location} (${inst.recallAnchor.mode} · ${inst.recallAnchor.layoutId || 'classic'})` : 'No instance Recall anchor set.' }),
        ),
        el('div', { class: 'cw-row' },
          el('button', { type: 'button', class: 'cw-btn', text: 'Set Recall Anchor', onclick: () => act('instance.recallSet', {}) }),
          el('button', { type: 'button', class: 'cw-btn', text: 'Return to Anchor', onclick: () => act('instance.recallReturn', {}) }),
        ),
      ),
    );
  }

  function renderDelvesTab(v) {
    const delveCards = v.delves.map((d) => {
      const pct = Math.max(0, Math.min(100, Math.round((d.bossHp / Math.max(1, d.bossMaxHp)) * 100)));
      return el('div', { class: 'cw-item-card', 'data-delve': d.id },
        el('div', { class: 'cw-item-head' },
          el('strong', { text: d.title }),
          el('span', { class: `cw-badge status-${d.status}`, text: `${d.status.toUpperCase()} · ${d.participantCount} active` }),
        ),
        el('div', { class: 'cw-muted', text: `${d.bossName} (${d.region}) · Scaling ${d.scaling?.hpMultiplier ?? 1}x · Base ${d.baseGold}g / ${d.baseRenown} Renown` }),
        el('div', { class: 'cw-meter cw-boss' },
          el('div', { class: 'cw-meter-head' }, el('span', { text: d.bossName }), el('span', { text: `${d.bossHp} / ${d.bossMaxHp} HP` })),
          el('div', { class: 'cw-meter-track' }, el('div', { class: 'cw-meter-fill', style: `width:${pct}%` })),
        ),
        el('div', { class: 'cw-row' },
          el('button', { type: 'button', class: 'cw-btn', text: 'Join Public Delve', onclick: () => act('delve.join', { delveId: d.id }) }),
          el('button', { type: 'button', class: 'cw-btn primary', text: 'Engage Boss', onclick: () => act('delve.engage', { delveId: d.id, damage: 45 }) }),
          el('button', { type: 'button', class: 'cw-btn', text: 'Claim Reward', onclick: () => act('delve.claim', { delveId: d.id }) }),
          el('button', { type: 'button', class: 'cw-btn', text: 'Reset Run', onclick: () => act('delve.reset', { delveId: d.id }) }),
        ),
      );
    });

    const bountyList = (v.seaBounties.bounties ?? []).map((b) =>
      el('div', { class: 'cw-item-card' },
        el('div', { class: 'cw-item-head' },
          el('strong', { text: `Target: ${b.targetName} — ${b.amount}g` }),
          el('span', { class: 'cw-badge', text: b.status }),
        ),
        el('div', { class: 'cw-muted', text: `${b.reason} · Posted by ${b.posterName} (${b.region})` }),
        el('div', { class: 'cw-row' },
          b.status === 'open' && el('button', { type: 'button', class: 'cw-btn', text: 'Accept Hunt', onclick: () => act('seaBounty.accept', { bountyId: b.id }) }),
          b.claimableByMe && el('button', { type: 'button', class: 'cw-btn primary', text: 'Claim Escrow Payout', onclick: () => act('seaBounty.claim', { bountyId: b.id }) }),
        ),
      ),
    );

    return el('div', { class: 'cw-grid' },
      el('section', { class: 'cw-card' },
        el('h3', { text: 'Repeatable Group PvE Delve Board' }),
        el('p', { class: 'cw-muted', text: 'Public group boss encounters with dynamic participant scaling and contributor rewards separate from classic dungeon treasure.' }),
        ...delveCards,
      ),
      el('section', { class: 'cw-card' },
        el('h3', { text: 'Admiralty Player-Funded Sea Bounties' }),
        el('p', { class: 'cw-muted', text: `Region: ${v.seaBounties.admiralty?.region ?? 'Daggerfall'} · Rank: ${v.seaBounties.admiralty?.rank?.title ?? 'Unsworn'}` }),
        el('div', { class: 'cw-form-row' },
          el('input', { type: 'text', placeholder: 'Target Captain ID', value: ui.bountyTargetId, oninput: (e) => { ui.bountyTargetId = e.target.value; } }),
          el('input', { type: 'number', placeholder: 'Gold', value: ui.bountyAmount, oninput: (e) => { ui.bountyAmount = e.target.value; } }),
          el('button', {
            type: 'button',
            class: 'cw-btn primary',
            text: 'Fund Bounty',
            onclick: () => act('seaBounty.post', { targetId: Number(ui.bountyTargetId), amount: Number(ui.bountyAmount), reason: ui.bountyReason }),
          }),
        ),
        bountyList.length ? el('div', { class: 'cw-stack' }, ...bountyList) : el('p', { class: 'cw-muted', text: 'No active player-funded sea bounties posted.' }),
      ),
    );
  }

  function renderQuestsTab(v) {
    const activeNodes = v.partyQuests.map((q) =>
      el('div', { class: 'cw-item-card' },
        el('div', { class: 'cw-item-head' },
          el('strong', { text: q.title }),
          el('span', { class: 'cw-badge', text: `${q.progress}/${q.goal} · ${q.status}` }),
        ),
        el('div', { class: 'cw-muted', text: `${q.site}${q.layoutId ? ` · Layout ${q.layoutId}` : ''} · Reward ${q.rewardGold}g + ${q.rewardRenown} Renown (once per member)` }),
        el('div', { class: 'cw-row' },
          q.status === 'active' && el('button', { type: 'button', class: 'cw-btn', text: 'Record Progress', onclick: () => act('partyQuest.contribute', { uid: q.uid, amount: 1 }) }),
          (q.status === 'ready' || q.status === 'completed') && !q.claimed && el('button', { type: 'button', class: 'cw-btn primary', text: 'Hand In & Claim Once', onclick: () => act('partyQuest.handIn', { uid: q.uid }) }),
        ),
      ),
    );

    const boardNodes = v.partyBoard.map((t) =>
      el('div', { class: 'cw-item-card' },
        el('div', { class: 'cw-item-head' },
          el('strong', { text: t.title }),
          el('span', { class: 'cw-badge', text: `${t.rewardGold}g · Min ${t.minPartySize}` }),
        ),
        el('div', { class: 'cw-muted', text: `${t.site} · Goal ${t.goal}` }),
        el('button', { type: 'button', class: 'cw-btn', text: 'Accept for Party', onclick: () => act('partyQuest.accept', { templateId: t.id }) }),
      ),
    );

    const repairFindings = (v.repair.findings ?? []).slice(0, 6).map((f) =>
      el('li', { class: f.needsRepair ? 'cw-warn' : '' }, `${f.questName}: ${f.detail}`),
    );

    return el('div', { class: 'cw-grid' },
      el('section', { class: 'cw-card' },
        el('h3', { text: 'Co-op Party Quests' }),
        activeNodes.length ? el('div', { class: 'cw-stack' }, ...activeNodes) : el('p', { class: 'cw-muted', text: 'No active party quests. Form a party and accept one below.' }),
        el('h4', { text: 'Available Party Contracts' }),
        ...boardNodes,
      ),
      el('section', { class: 'cw-card', 'data-quest-repair': '' },
        el('h3', { text: 'Quest Repair & Reconciliation' }),
        el('p', { class: 'cw-muted', text: 'Reconciles missing targets, dungeon markers, or lost collected items from saved progress while strictly preserving payout ownership.' }),
        el('div', { class: 'cw-row' },
          el('button', { type: 'button', class: 'cw-btn', text: 'Scan Quests', onclick: () => act('quest.repair.scan', {}) }),
          el('button', { type: 'button', class: 'cw-btn primary', text: 'Run Quest Repair', onclick: () => act('quest.repair.run', {}) }),
          el('button', { type: 'button', class: 'cw-btn', text: 'Quest Debugger', onclick: () => act('rules.questDebug', {}) }),
        ),
        repairFindings.length
          ? el('ul', { class: 'cw-list' }, ...repairFindings)
          : el('p', { class: 'cw-muted', text: 'No missing markers or broken quest items detected.' }),
      ),
    );
  }

  function renderLivingTab(v) {
    const lv = v.living;
    const follower = lv.follower;
    const residentCards = (lv.residents ?? DEFAULT_RESIDENTS).map((r) =>
      el('div', { class: 'cw-item-card' },
        el('div', { class: 'cw-item-head' },
          el('strong', { text: `${r.name} — ${r.role}` }),
          el('span', { class: 'cw-badge', text: `${r.relationship?.tier ?? 'Acquaintance'} (${r.relationship?.affinity ?? 0})` }),
        ),
        el('div', { class: 'cw-muted', text: `Scheduled now: ${r.label} (${String(lv.hour ?? 12).padStart(2, '0')}:00)` }),
        el('div', { class: 'cw-row' },
          el('button', { type: 'button', class: 'cw-btn', text: 'Talk (+Affinity)', onclick: () => act('living.talk', { residentId: r.id }) }),
          el('button', { type: 'button', class: 'cw-btn', text: 'Gift 15g', onclick: () => act('living.gift', { residentId: r.id, gold: 15 }) }),
          r.recruitable && el('button', { type: 'button', class: 'cw-btn primary', text: `Recruit Follower (${r.hireGold ?? 50}g)`, onclick: () => act('follower.recruit', { residentId: r.id }) }),
        ),
      ),
    );

    const caravanCards = (lv.caravans ?? []).map((c) =>
      el('div', { class: 'cw-meta-box' },
        el('strong', { text: c.name }),
        el('div', { text: `Current Stop: ${c.stopLabel} → Next: ${c.nextLabel} (${Math.round((c.progress ?? 0) * 100)}% leg)` }),
      ),
    );

    return el('div', { class: 'cw-grid' },
      el('section', { class: 'cw-card' },
        el('h3', { text: 'Pilot Town Residents (Gothway Garden)' }),
        ...residentCards,
      ),
      el('section', { class: 'cw-card' },
        el('h3', { text: 'Persistent Follower Controls' }),
        follower
          ? el('div', { class: 'cw-meta-box' },
            el('strong', { text: `${follower.name} (${follower.active ? 'Active' : 'Dismissed'})` }),
            el('div', { text: `Role: ${follower.role} · Stance: ${follower.stance} · Location: ${follower.location}` }),
            el('div', { class: 'cw-row' },
              el('button', { type: 'button', class: 'cw-btn primary', text: 'Recall Across Doors', onclick: () => act('follower.recall', {}) }),
              el('button', { type: 'button', class: 'cw-btn', text: 'Follow', onclick: () => act('follower.stance', { stance: 'follow' }) }),
              el('button', { type: 'button', class: 'cw-btn', text: 'Hold', onclick: () => act('follower.stance', { stance: 'hold' }) }),
              el('button', { type: 'button', class: 'cw-btn', text: 'Guard', onclick: () => act('follower.stance', { stance: 'guard' }) }),
              el('button', { type: 'button', class: 'cw-btn', text: 'Dismiss', onclick: () => act('follower.dismiss', {}) }),
            ),
          )
          : el('p', { class: 'cw-muted', text: 'No persistent follower recruited yet. Recruit Aldric Thorne or Lyra Ashford from Gothway Garden.' }),
        el('h3', { text: 'Cross-Scene Caravan Route' }),
        ...caravanCards,
        el('button', { type: 'button', class: 'cw-btn', text: 'Check Caravan Manifest', onclick: () => act('living.caravan', {}) }),
      ),
    );
  }

  function renderSurvivalTab(v) {
    const s = v.survival;
    return el('section', { class: 'cw-card' },
      el('div', { class: 'cw-item-head' },
        el('h3', { text: 'Optional Survival Ruleset' }),
        el('button', {
          type: 'button',
          class: `cw-btn ${s.enabled ? 'primary' : ''}`,
          text: s.enabled ? 'Survival: ON (Disable)' : 'Survival: OFF (Enable)',
          onclick: () => act('survival.toggle', { enabled: !s.enabled }),
        }),
      ),
      el('p', { class: 'cw-muted', text: 'Tracks Food, Water, Warmth/Exposure, and Wilderness Camping while respecting classic town camping laws.' }),
      meterBar('Food (Satiety)', s.food, 'cw-food'),
      meterBar('Water (Hydration)', s.water, 'cw-water'),
      meterBar('Warmth (vs Exposure)', s.warmth, 'cw-warmth'),
      el('div', { class: 'cw-meta-box' },
        el('div', { text: `Rations: ${s.rations ?? 0} · Waterskin: ${s.waterskin ?? 0} · Camp: ${s.camp?.active ? `Pitched at ${s.camp.location}` : 'Packed'}` }),
        el('div', { text: `Status: ${s.penalties?.warnings?.length ? s.penalties.warnings.join(', ') : 'Healthy & provisioned'}` }),
      ),
      el('div', { class: 'cw-row' },
        el('button', { type: 'button', class: 'cw-btn', text: 'Eat Ration', onclick: () => act('survival.eat', {}) }),
        el('button', { type: 'button', class: 'cw-btn', text: 'Drink Water', onclick: () => act('survival.drink', {}) }),
        el('button', { type: 'button', class: 'cw-btn primary', text: 'Pitch Camp', onclick: () => act('survival.camp', { action: 'pitch' }) }),
        el('button', { type: 'button', class: 'cw-btn', text: 'Rest at Camp', onclick: () => act('survival.camp', { action: 'rest', hours: 2 }) }),
        el('button', { type: 'button', class: 'cw-btn', text: 'Pack Camp', onclick: () => act('survival.camp', { action: 'pack' }) }),
      ),
    );
  }

  function renderEndgameTab(v) {
    const eg = v.endgame.endgame ?? {};
    const w = v.wardrobe.wardrobe ?? { unlocked: [], equipped: {} };
    const catalog = v.wardrobe.catalog ?? DEFAULT_COSMETICS;
    const ruleEntries = Object.entries(v.rules ?? {});
    return el('div', { class: 'cw-grid' },
      el('section', { class: 'cw-card' },
        el('h3', { text: 'Renown, Firmament & Build Comparison' }),
        el('div', { class: 'cw-meta-box' },
          el('div', { text: `Renown: ${eg.renown ?? 0} (${eg.tier?.title ?? 'Wayfarer'})` }),
          el('div', { text: `Firmament: ${eg.firmamentId ?? 'warrior'} · Specialization: ${eg.specId ?? 'vanguard'}` }),
        ),
        el('div', { class: 'cw-row' },
          ['warrior', 'mage', 'thief', 'steed'].map((signId) =>
            el('button', { type: 'button', class: `cw-chip${eg.firmamentId === signId ? ' active' : ''}`, text: signId, onclick: () => act('endgame.selectFirmament', { signId }) }),
          ),
        ),
        el('button', {
          type: 'button',
          class: 'cw-btn primary',
          text: 'Compare Vanguard vs Battlemage Build',
          onclick: () => act('endgame.compareBuilds', {
            buildA: { renownPoints: eg.renown ?? 100, firmamentId: 'warrior', specId: 'vanguard', setId: 'set-sentinel-guard', setPieces: 4 },
            buildB: { renownPoints: eg.renown ?? 100, firmamentId: 'mage', specId: 'battlemage', setId: 'set-direnni-weave', setPieces: 4 },
          }),
        }),
        ui.cache.buildComparison && el('div', { class: 'cw-meta-box' },
          el('div', { text: `Delta (B − A): Atk ${ui.cache.buildComparison.delta.attack}, Spell ${ui.cache.buildComparison.delta.spellpower}, Mit ${ui.cache.buildComparison.delta.mitigation}, Score ${ui.cache.buildComparison.delta.totalScore}` }),
        ),
        el('h4', { text: 'Family Succession' }),
        el('div', { class: 'cw-meta-box', text: `${v.succession.lineageName} (Gen ${v.succession.generation}) · Heir: ${v.succession.heirName || 'Unassigned'}` }),
      ),
      el('section', { class: 'cw-card' },
        el('h3', { text: 'Wardrobe & Cosmetics' }),
        ...catalog.map((c) => {
          const unlocked = (w.unlocked ?? []).includes(c.id);
          const equipped = w.equipped?.[c.slot] === c.id;
          return el('div', { class: 'cw-row cw-between' },
            el('span', { text: `${c.name} [${c.slot}]` }),
            unlocked
              ? el('button', { type: 'button', class: `cw-btn-sm${equipped ? ' primary' : ''}`, text: equipped ? 'Equipped' : 'Equip', onclick: () => act('wardrobe.equip', { slot: c.slot, cosmeticId: c.id }) })
              : el('button', { type: 'button', class: 'cw-btn-sm', text: 'Unlock', onclick: () => act('wardrobe.unlock', { cosmeticId: c.id }) }),
          );
        }),
        el('h4', { text: 'Optional DFU Rules' }),
        ruleEntries.length
          ? el('div', { class: 'cw-stack' }, ...ruleEntries.slice(0, 6).map(([k, spec]) =>
            el('div', { class: 'cw-row cw-between' },
              el('span', { text: `${spec.label} (${spec.scope})` }),
              el('button', { type: 'button', class: 'cw-btn-sm', text: spec.value ? 'ON' : 'OFF', onclick: () => act('rules.set', { rule: k, value: !spec.value }) }),
            ),
          ))
          : el('p', { class: 'cw-muted', text: 'Enemy Infighting, Enhanced AI, Advanced Climbing, Instant/Magic Repairs ready.' }),
      ),
    );
  }

  function renderPanel(root) {
    container = root;
    root.replaceChildren();
    const v = coopWorldView(api.state, ui.cache);

    const tabsBar = el('nav', { class: 'cw-tabs', role: 'tablist' },
      TABS.map((t) =>
        el('button', {
          type: 'button',
          role: 'tab',
          'aria-selected': String(ui.tab === t.id),
          class: `cw-tab${ui.tab === t.id ? ' active' : ''}`,
          'data-cw-tab': t.id,
          text: t.label,
          onclick: () => { ui.tab = t.id; rerender(); },
        }),
      ),
    );

    let body;
    if (ui.tab === 'dungeons') body = renderDungeonsTab(v);
    else if (ui.tab === 'delves') body = renderDelvesTab(v);
    else if (ui.tab === 'quests') body = renderQuestsTab(v);
    else if (ui.tab === 'living') body = renderLivingTab(v);
    else if (ui.tab === 'survival') body = renderSurvivalTab(v);
    else body = renderEndgameTab(v);

    const wrap = el('div', { class: 'cw-panel', 'data-coop-world': '' },
      tabsBar,
      ui.status ? el('div', { class: 'cw-status', role: 'status', text: ui.status }) : null,
      body,
    );
    root.append(wrap);
  }

  api.registerPanel(PANEL_ID, 'Co-op & World', renderPanel, { watch: 'character' });
  renderHud();

  return {
    openTab(tab) {
      if (TABS.some((t) => t.id === tab)) ui.tab = tab;
      api.openPanel(PANEL_ID, { tab: ui.tab });
      rerender();
    },
    setCache(patch) {
      Object.assign(ui.cache, patch);
      rerender();
    },
    renderHud,
  };
}
