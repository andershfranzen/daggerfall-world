// Guilds panel (panel `guilds`): Classic Guilds overview, Directory (6 families, 8 Temples, 10 Knightly Orders),
// and Player-Founded Multiplayer Orders (roster, custom rank permission matrix, purchasable Order Hall with
// persistent decor & member access, Order Item Vault + shared gold treasury + audit ledger, succession & chat).
// Server rules: server/rpg/guildhall.js (and server/rpg/guilds.js).

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
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};

const ORDER_PERM_LABELS = Object.freeze({
  invite: 'Invite',
  kick: 'Kick',
  promote: 'Promote',
  editMotd: 'Edit MOTD',
  withdrawTreasury: 'Withdraw Gold',
  depositVault: 'Vault Deposit',
  withdrawVault: 'Vault Withdraw',
  decorateHall: 'Decorate Hall',
  hallAccess: 'Hall Access',
  siegeOfficer: 'Siege Officer',
});

const EXTRA_ORDER_CSS = `
.gld-subtabs {
  display: flex; flex-wrap: wrap; gap: 6px; padding-bottom: 6px;
  border-bottom: 2px solid #121316; box-shadow: 0 1px 0 #484c54;
}
.gld-subtab {
  padding: 5px 11px; font: 600 0.76rem/1.15 var(--font-ui, ui-monospace, monospace);
  letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-2, #b4bac4);
  background: linear-gradient(180deg, #3c4047 0 50%, #2b2e34 50% 100%);
  border: 2px solid; border-color: #7c818a #131518 #131518 #7c818a; cursor: pointer;
}
.gld-subtab.is-active {
  color: #eef7f7; background: linear-gradient(180deg, #346f72 0 50%, #214a4c 50% 100%);
  border-color: #7ab8ba #112a2b #112a2b #7ab8ba;
}
.gld-matrix-wrap { overflow-x: auto; }
.gld-matrix {
  width: 100%; border-collapse: collapse; font-size: 0.8rem;
  background: #16181c; border: 2px solid #40444c;
}
.gld-matrix th, .gld-matrix td {
  padding: 4px 8px; border: 1px solid #34383f; text-align: center;
}
.gld-matrix th:first-child, .gld-matrix td:first-child { text-align: left; }
.gld-matrix thead th {
  background: #232529; color: var(--accent-hi, #a4dadb);
  text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.06em;
}
.gld-perm-toggle {
  min-width: 52px; padding: 2px 7px; font: 600 0.72rem/1.1 var(--font-ui, monospace);
  text-transform: uppercase; cursor: pointer; border: 2px solid; border-radius: 0;
}
.gld-perm-toggle.is-on {
  color: #dff7e3; background: #1e4633; border-color: #68b074 #102418 #102418 #68b074;
}
.gld-perm-toggle.is-off {
  color: #9ba1ab; background: #22252a; border-color: #5a5f68 #121316 #121316 #5a5f68;
}
.gld-perm-toggle:disabled { opacity: 0.75; cursor: default; }
.gld-two-col {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 10px; align-items: start;
}
.gld-two-col > * { align-content: start; }
.gld-hall-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 8px;
}
.gld-hall-card {
  display: grid; gap: 6px; padding: 9px 10px; background: #1a1c20;
  border: 2px solid; border-color: #5a5f68 #131518 #131518 #5a5f68;
}
.gld-audit-row {
  display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; justify-content: space-between;
  padding: 4px 7px; font-size: 0.8rem; background: #16181c; border: 1px solid #34383f;
}
.gld-audit-tag {
  padding: 1px 6px; font-size: 0.68rem; text-transform: uppercase;
  background: #173436; color: var(--accent-hi, #a4dadb); border: 1px solid #5fa3a5;
}
`;

function loadStyles() {
  if (typeof document === 'undefined') return;
  if (!document.querySelector('link[data-feature="guilds"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./guilds.css', import.meta.url).href;
    link.dataset.feature = 'guilds';
    document.head.append(link);
  }
  if (!document.querySelector('style[data-feature="guilds-orders"]')) {
    const st = document.createElement('style');
    st.dataset.feature = 'guilds-orders';
    st.textContent = EXTRA_ORDER_CSS;
    document.head.append(st);
  }
}

const MAX_CHAT_HISTORY = 40;

export function install(api) {
  loadStyles();

  const ui = {
    tab: 'mine',           // 'mine' | 'directory' | 'order'
    orderSubtab: 'roster', // 'roster' | 'permissions' | 'hall' | 'vault'
    dirFilter: 'all',      // 'all' | 'families' | 'temples' | 'orders'
    overview: null,
    directory: null,
    hallQuote: null,
    status: '',
    synced: false,
    lastSelfId: api.selfId ?? api.state?.selfId ?? null,
    chatLogs: new Map(),   // channelKey -> [{ fromId, name, rankTitle, text, channelName }]
    chatDrafts: new Map(), // channelKey -> string
    confirmResign: null,   // group key awaiting confirmation
    confirmDisband: false,
    createDraft: { name: '', tag: '', motd: '' },
    motdDraft: null,
    depositDraft: '',
    withdrawDraft: '',
    successorDraft: '',
    hallFurnishCatalogId: 'oak-table',
    hallFurnishX: 3.5,
    hallFurnishZ: 2.5,
  };
  let container = null;

  const rerender = () => {
    if (container?.isConnected) render(container);
    else if (api.panel === 'guilds') api.refreshPanel?.('guilds');
  };

  const resetPrivateCache = () => {
    ui.synced = false;
    ui.overview = null;
    ui.directory = null;
    ui.hallQuote = null;
    ui.confirmDisband = false;
    ui.confirmResign = null;
    ui.chatLogs.clear();
  };

  const act = (verb, args) => {
    try {
      api.act(verb, args);
    } catch (e) {
      api.message(e?.message || String(e), { kind: 'error' });
    }
  };

  const say = (text) => {
    ui.status = text;
    const live = container?.querySelector('.gld-live');
    if (live) live.textContent = text;
  };

  function chatKeyForEvent(ev) {
    return ev.scope === 'order' ? 'order' : `classic:${ev.group}`;
  }

  function appendHudChat(ev) {
    if (typeof document === 'undefined') return;
    const log = document.getElementById('chat-log');
    if (!log) return;
    const tag = ev.scope === 'order' ? `[${ev.tag ?? 'Order'}]` : `[${ev.channelName ?? ev.group}]`;
    const li = el('li', { class: `chat-line chat-channel chat-guild chat-guild-${ev.scope}`, 'data-at': String(performance.now()) },
      el('span', { class: 'chat-tag', text: tag }),
      ' ',
      el('span', { class: 'chat-name', text: ev.name }),
      el('span', { class: 'chat-text', text: ev.text }));
    if (ev.fromId === api.selfId || ev.fromId === api.state?.selfId) li.classList.add('chat-self');
    log.append(li);
    while (log.children.length > 80) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  // ---------------------------------------------------------------- server events
  api.on('event', (ev) => {
    if (!ev) return;
    if (ev.kind === 'guild') {
      if (ev.overview) {
        ui.overview = ev.overview;
        ui.confirmResign = null;
        if (!ev.overview.order) {
          ui.confirmDisband = false;
          ui.hallQuote = null;
        }
      }
      if (ev.directory) ui.directory = ev.directory;
      if (ev.quote) ui.hallQuote = ev.quote;
      if (ev.text) {
        ev.silent = true;
        api.message(ev.text, ev.error ? { kind: 'error' } : undefined);
        say(ev.text);
      }
      if (ev.orderInvite && api.panel !== 'guilds') {
        api.message(`Order invite from ${ev.orderInvite.fromName}. Open Guilds to respond.`);
      }
      rerender();
    } else if (ev.kind === 'order.hallFurnishings' && ui.overview?.order?.hall) {
      if (ui.overview.order.id === ev.orderId) {
        ui.overview.order.hall.furnishings = ev.furnishings;
        ui.overview.order.hall.furnishingRev = ev.furnishingRev;
        rerender();
      }
    } else if (ev.kind === 'guildChat') {
      const key = chatKeyForEvent(ev);
      const list = ui.chatLogs.get(key) ?? [];
      list.push({ fromId: ev.fromId, name: ev.name, rankTitle: ev.rankTitle, text: ev.text, channelName: ev.channelName });
      if (list.length > MAX_CHAT_HISTORY) list.splice(0, list.length - MAX_CHAT_HISTORY);
      ui.chatLogs.set(key, list);
      appendHudChat(ev);
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
      act('guild.overview');
    } else if (container?.isConnected) {
      rerender();
    }
  });
  api.on('screen', (s) => {
    if (s !== 'game') resetPrivateCache();
  });
  api.on('panel', (p) => {
    if (p?.id === 'guilds' && p.open) {
      act('guild.overview');
      if (ui.tab === 'directory' || !ui.directory) act('guild.directory');
    }
  });

  // ---------------------------------------------------------------- shared UI pieces
  function stopKey(e) { e.stopPropagation(); }

  function renderTabs() {
    const invCount = ui.overview?.orderInvites?.length ?? 0;
    const tabs = [
      { id: 'mine', label: `My Guilds (${ui.overview?.memberships?.length ?? 0})` },
      { id: 'directory', label: 'Directory' },
      { id: 'order', label: invCount ? `Player Order (${invCount})` : 'Player Order' },
    ];
    return el('div', { class: 'gld-tabs', role: 'tablist', 'aria-label': 'Guild sections' },
      tabs.map((t) => el('button', {
        type: 'button',
        role: 'tab',
        class: `btn btn-small gld-tab${ui.tab === t.id ? ' is-active' : ''}`,
        'aria-selected': ui.tab === t.id ? 'true' : 'false',
        onclick: () => {
          ui.tab = t.id;
          if (t.id === 'directory' && !ui.directory) act('guild.directory');
          else act('guild.overview');
          rerender();
        },
      }, t.label)),
      el('button', {
        type: 'button',
        class: 'btn btn-small gld-refresh',
        title: 'Refresh guild information',
        onclick: () => {
          act('guild.overview');
          if (ui.tab === 'directory') act('guild.directory');
        },
      }, 'Refresh'),
    );
  }

  function renderChatBox(channelKey, placeholder, onSend) {
    const msgs = ui.chatLogs.get(channelKey) ?? [];
    const draft = ui.chatDrafts.get(channelKey) ?? '';
    const send = (e) => {
      e.preventDefault();
      const text = (ui.chatDrafts.get(channelKey) ?? '').replace(/\s+/g, ' ').trim();
      if (!text) return;
      onSend(text);
      ui.chatDrafts.set(channelKey, '');
      rerender();
    };
    return el('div', { class: 'gld-chat' },
      msgs.length
        ? el('ul', { class: 'gld-chat-log' }, msgs.slice(-12).map((m) =>
          el('li', { class: 'gld-chat-line' },
            el('span', { class: 'gld-chat-who', text: `${m.name}${m.rankTitle ? ` (${m.rankTitle})` : ''}: ` }),
            el('span', { class: 'gld-chat-msg', text: m.text }))))
        : el('p', { class: 'gld-note', text: 'No guild messages yet this session.' }),
      el('form', { class: 'gld-chat-form', onsubmit: send },
        el('input', {
          type: 'text',
          maxlength: '200',
          autocomplete: 'off',
          value: draft,
          placeholder,
          oninput: (e) => ui.chatDrafts.set(channelKey, e.target.value),
          onkeydown: stopKey,
        }),
        el('button', { type: 'submit', class: 'btn btn-small btn-primary' }, 'Send')),
    );
  }

  // ---------------------------------------------------------------- Tab 1: My Guilds
  function reqRow(label, detail, met) {
    return el('li', { class: `gld-req${met ? ' is-met' : ''}` },
      el('span', { class: 'gld-req-mark', text: met ? '✓' : '·' }),
      el('span', { class: 'gld-req-label', text: label }),
      el('span', { class: 'gld-req-val', text: detail }));
  }

  function renderMembershipCard(m) {
    const nr = m.nextRank;
    const confirming = ui.confirmResign === m.group;
    const progressEl = nr.maxRank
      ? el('div', { class: 'gld-progress gld-max' }, el('span', { class: 'gld-badge gld-badge-mint', text: 'Highest Rank Attained' }))
      : el('div', { class: 'gld-progress' },
        el('div', { class: 'gld-subhead' },
          el('span', { text: `Next Rank: ${nr.nextRankTitle} (Rank ${nr.nextRank})` }),
          nr.ready ? el('span', { class: 'gld-badge gld-badge-mint', text: 'Ready — Visit Guildhall' }) : null),
        el('ul', { class: 'gld-req-list' },
          reqRow('Reputation', `${nr.reputation.current} / ${nr.reputation.required}`, nr.reputation.met),
          nr.topSkill ? reqRow(`Top Skill (${nr.topSkill.name ?? '—'})`, `${nr.topSkill.current} / ${nr.topSkill.required}`, nr.topSkill.met) : null,
          nr.secondSkill ? reqRow(`2nd Skill (${nr.secondSkill.name ?? '—'})`, `${nr.secondSkill.current} / ${nr.secondSkill.required}`, nr.secondSkill.met) : null,
          reqRow('28-Day Cooldown', nr.cooldown.met ? 'Ready' : `${nr.cooldown.daysRemaining}d remaining`, nr.cooldown.met)));

    const perksEl = el('div', { class: 'gld-perks' },
      el('div', { class: 'gld-perk-group' },
        el('span', { class: 'gld-label', text: 'Unlocked Perks' }),
        m.privileges.unlocked.length
          ? el('div', { class: 'gld-chips' }, m.privileges.unlocked.map((p) => el('span', { class: 'gld-chip is-unlocked', text: p.label })))
          : el('p', { class: 'gld-note', text: 'None yet.' })),
      m.privileges.upcoming.length
        ? el('div', { class: 'gld-perk-group' },
          el('span', { class: 'gld-label', text: 'Upcoming Perks' }),
          el('div', { class: 'gld-chips' }, m.privileges.upcoming.map((p) =>
            el('span', { class: 'gld-chip', text: `${p.label} (R${p.rank})` }))))
        : null);

    const fellowsEl = el('div', { class: 'gld-fellows' },
      el('span', { class: 'gld-label', text: `Online Members (${m.onlineMembers.length})` }),
      el('ul', { class: 'gld-list' }, m.onlineMembers.map((f) =>
        el('li', { class: `gld-row${f.self ? ' is-self' : ''}` },
          el('span', { class: 'gld-dot is-online' }),
          el('span', { class: 'gld-name', text: `${f.name}${f.self ? ' (you)' : ''}` }),
          el('span', { class: 'gld-badge', text: f.rankTitle }),
          el('span', { class: 'gld-meta', text: f.region })))));

    return el('section', { class: 'gld-card' },
      el('div', { class: 'gld-card-head' },
        el('div', { class: 'gld-card-title' },
          el('h3', { class: 'gld-h', text: m.name }),
          el('span', { class: 'gld-badge gld-badge-blue', text: `Rank ${m.rank} · ${m.rankTitle}` }),
          el('span', { class: 'gld-badge', text: `Rep ${m.reputation >= 0 ? `+${m.reputation}` : m.reputation}` })),
        el('div', { class: 'gld-actions' },
          confirming
            ? [
              el('button', { type: 'button', class: 'btn btn-small gld-btn-danger', onclick: () => act('guild.resign', { group: m.group }) }, 'Confirm Resign'),
              el('button', { type: 'button', class: 'btn btn-small', onclick: () => { ui.confirmResign = null; rerender(); } }, 'Cancel'),
            ]
            : el('button', { type: 'button', class: 'btn btn-small gld-btn-danger', onclick: () => { ui.confirmResign = m.group; rerender(); } }, 'Resign'))),
      progressEl,
      perksEl,
      fellowsEl,
      renderChatBox(`classic:${m.group}`, `Message ${m.name}…`, (text) => act('guild.chat', { scope: 'classic', group: m.group, text })),
    );
  }

  function renderMine(ov) {
    if (!ov.memberships.length) {
      return el('section', { class: 'gld-card gld-empty-card' },
        el('h3', { class: 'gld-h', text: 'No Classic Guild Memberships' }),
        el('p', { class: 'gld-note', text: 'You have not joined a classic guild, temple, or knightly order yet. Visit a guildhall, temple, or knightly chapterhouse to petition for entry.' }),
        el('div', { class: 'gld-actions' },
          el('button', {
            type: 'button',
            class: 'btn btn-small btn-primary',
            onclick: () => { ui.tab = 'directory'; if (!ui.directory) act('guild.directory'); rerender(); },
          }, 'Browse Directory')));
    }
    return el('div', { class: 'gld-stack' }, ov.memberships.map(renderMembershipCard));
  }

  // ---------------------------------------------------------------- Tab 2: Directory
  function renderDirectory() {
    const dir = ui.directory;
    if (!dir) return el('p', { class: 'gld-note', text: 'Loading guild directory…' });
    const filters = [
      { id: 'all', label: 'All' },
      { id: 'families', label: `Guilds (${dir.families.length})` },
      { id: 'temples', label: `Temples (${dir.temples.length})` },
      { id: 'orders', label: `Knightly Orders (${dir.orders.length})` },
    ];
    const out = [
      el('div', { class: 'gld-filters' }, filters.map((f) =>
        el('button', {
          type: 'button',
          class: `btn btn-small gld-filter${ui.dirFilter === f.id ? ' is-active' : ''}`,
          onclick: () => { ui.dirFilter = f.id; rerender(); },
        }, f.label))),
    ];

    if (ui.dirFilter === 'all' || ui.dirFilter === 'families') {
      out.push(el('section', { class: 'gld-card' },
        el('h3', { class: 'gld-h', text: 'Classic Guild Families' }),
        el('div', { class: 'gld-dir-grid' }, dir.families.map((f) =>
          el('article', { class: `gld-dir-item${f.member ? ' is-member' : ''}` },
            el('div', { class: 'gld-dir-head' },
              el('strong', { text: f.name }),
              f.member ? el('span', { class: 'gld-badge gld-badge-mint', text: f.member.rankTitle }) : null,
              f.inviteOnly ? el('span', { class: 'gld-badge', text: 'Secret Invite' }) : null,
              f.exclusiveVariant ? el('span', { class: 'gld-badge', text: 'Exclusive' }) : null),
            f.reputation != null ? el('p', { class: 'gld-meta', text: `Standing: ${f.reputation >= 0 ? `+${f.reputation}` : f.reputation}` }) : null,
            f.skills.length ? el('p', { class: 'gld-note', text: `Skills: ${f.skills.join(', ')}` }) : null,
            f.perks.length
              ? el('div', { class: 'gld-chips' }, f.perks.map((p) => el('span', { class: 'gld-chip', text: `${p.label} (R${p.rank})` })))
              : el('p', { class: 'gld-note', text: f.id === 'temple' ? 'See the 8 Temples below for patron perks.' : 'See the 10 Knightly Orders below for regional perks.' }))))));
    }

    if (ui.dirFilter === 'all' || ui.dirFilter === 'temples') {
      out.push(el('section', { class: 'gld-card' },
        el('h3', { class: 'gld-h', text: 'The Eight Temples (Exclusive)' }),
        el('div', { class: 'gld-dir-grid' }, dir.temples.map((t) =>
          el('article', { class: `gld-dir-item${t.member ? ' is-member' : ''}` },
            el('div', { class: 'gld-dir-head' },
              el('strong', { text: t.name }),
              el('span', { class: 'gld-badge', text: t.deity }),
              t.member ? el('span', { class: 'gld-badge gld-badge-mint', text: t.member.rankTitle }) : null),
            el('p', { class: 'gld-meta', text: `Standing: ${t.reputation >= 0 ? `+${t.reputation}` : t.reputation}${t.blessing ? ` · Blessing: ${t.blessing}` : ''}` }),
            t.specialPerk ? el('p', { class: 'gld-note', text: t.specialPerk }) : null,
            el('div', { class: 'gld-chips' }, t.perks.map((p) => el('span', { class: 'gld-chip', text: `${p.label} (R${p.rank})` }))))))));
    }

    if (ui.dirFilter === 'all' || ui.dirFilter === 'orders') {
      out.push(el('section', { class: 'gld-card' },
        el('h3', { class: 'gld-h', text: 'Knightly Orders (Exclusive)' }),
        el('div', { class: 'gld-dir-grid' }, dir.orders.map((o) =>
          el('article', { class: `gld-dir-item${o.member ? ' is-member' : ''}` },
            el('div', { class: 'gld-dir-head' },
              el('strong', { text: o.name }),
              el('span', { class: 'gld-badge', text: o.region }),
              o.member ? el('span', { class: 'gld-badge gld-badge-mint', text: o.member.rankTitle }) : null),
            el('p', { class: 'gld-meta', text: `Standing: ${o.reputation >= 0 ? `+${o.reputation}` : o.reputation}` }),
            el('p', { class: 'gld-note', text: o.specialPerks.join(' · ') }))))));
    }

    return el('div', { class: 'gld-stack' }, out);
  }

  // ---------------------------------------------------------------- Tab 3: Player Order
  function renderOrderInvites(ov) {
    if (!ov.orderInvites?.length) return null;
    return el('section', { class: 'gld-card' },
      el('h3', { class: 'gld-h', text: 'Order Invitations' }),
      el('ul', { class: 'gld-list' }, ov.orderInvites.map((inv) =>
        el('li', { class: 'gld-row' },
          el('span', { class: 'gld-badge gld-badge-blue', text: `[${inv.orderTag}]` }),
          el('span', { class: 'gld-name', text: `${inv.orderName} — invited by ${inv.fromName}` }),
          el('span', { class: 'gld-actions' },
            el('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => act('order.accept', { orderId: inv.orderId }) }, 'Accept'),
            el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('order.decline', { orderId: inv.orderId }) }, 'Decline'))))));
  }

  function renderOrderCreate(ov) {
    const submit = (e) => {
      e.preventDefault();
      act('order.create', {
        name: ui.createDraft.name,
        tag: ui.createDraft.tag,
        motd: ui.createDraft.motd,
      });
    };
    return el('section', { class: 'gld-card' },
      el('h3', { class: 'gld-h', text: 'Found a Player Order' }),
      el('p', { class: 'gld-note', text: ov.foundingFee > 0 ? `Charter fee: ${ov.foundingFee} gold (you carry ${ov.gold} gold).` : 'Found a persistent multiplayer order with custom rank permissions, an Order Hall, shared item vault, treasury, and private order chat.' }),
      el('form', { class: 'gld-form', onsubmit: submit },
        el('div', { class: 'gld-form-row' },
          el('label', { class: 'gld-field' },
            el('span', { class: 'gld-label', text: 'Order Name (3–32 chars)' }),
            el('input', {
              type: 'text',
              maxlength: '32',
              required: true,
              value: ui.createDraft.name,
              placeholder: 'Order of the Silver Wolf',
              oninput: (e) => { ui.createDraft.name = e.target.value; },
              onkeydown: stopKey,
            })),
          el('label', { class: 'gld-field gld-field-tag' },
            el('span', { class: 'gld-label', text: 'Tag (2–5)' }),
            el('input', {
              type: 'text',
              maxlength: '5',
              required: true,
              value: ui.createDraft.tag,
              placeholder: 'WOLF',
              oninput: (e) => { ui.createDraft.tag = e.target.value.toUpperCase(); },
              onkeydown: stopKey,
            }))),
        el('label', { class: 'gld-field' },
          el('span', { class: 'gld-label', text: 'Charter / Message of the Day (optional)' }),
          el('input', {
            type: 'text',
            maxlength: '200',
            value: ui.createDraft.motd,
            placeholder: 'Defenders of the Iliac Bay…',
            oninput: (e) => { ui.createDraft.motd = e.target.value; },
            onkeydown: stopKey,
          })),
        el('div', { class: 'gld-actions' },
          el('button', { type: 'submit', class: 'btn btn-small btn-primary' }, 'Found Order'))));
  }

  function renderOrderPermissionsTab(ord, isLeader) {
    const keys = ord.permissionKeys ?? Object.keys(ORDER_PERM_LABELS);
    const matrix = ord.permissions ?? { Leader: {}, Officer: {}, Member: {} };
    const ranks = ['Leader', 'Officer', 'Member'];

    const table = el('div', { class: 'gld-matrix-wrap' },
      el('table', { class: 'gld-matrix', 'aria-label': 'Order rank permissions matrix' },
        el('thead', {},
          el('tr', {},
            el('th', { text: 'Permission' }),
            ...ranks.map((r) => el('th', { text: r })))),
        el('tbody', {}, keys.map((perm) => el('tr', {},
          el('td', { text: ORDER_PERM_LABELS[perm] ?? perm }),
          ...ranks.map((r) => {
            const on = r === 'Leader' ? true : Boolean(matrix[r]?.[perm]);
            const editable = isLeader && r !== 'Leader';
            return el('td', {},
              el('button', {
                type: 'button',
                class: `gld-perm-toggle${on ? ' is-on' : ' is-off'}`,
                disabled: !editable,
                title: editable ? `Toggle ${ORDER_PERM_LABELS[perm] ?? perm} for ${r}` : `${r} ${on ? 'allowed' : 'denied'}`,
                onclick: () => act('order.setPermissions', { rank: r, permissions: { [perm]: !on } }),
              }, on ? 'Allow' : 'Deny'));
          }))))));

    return el('section', { class: 'gld-card' },
      el('div', { class: 'gld-card-head' },
        el('h3', { class: 'gld-h', text: 'Rank Permission Matrix' }),
        el('span', { class: 'gld-badge gld-badge-blue', text: isLeader ? 'Leader Editing Enabled' : 'Read-Only View' })),
      el('p', { class: 'gld-note', text: 'Configure which powers Officers and Members hold across recruiting, treasury, item vault, Order Hall decoration, and siege registration.' }),
      table);
  }

  function renderOrderHallTab(ord, isLeader, perms) {
    const hall = ord.hall;
    if (!hall) {
      const catalog = ord.hallCatalog ?? [];
      return el('section', { class: 'gld-card' },
        el('div', { class: 'gld-card-head' },
          el('h3', { class: 'gld-h', text: 'Acquire an Order Hall' }),
          el('span', { class: 'gld-badge gld-badge-mint', text: `Treasury: ${ord.treasury}g` })),
        el('p', { class: 'gld-note', text: 'Each order may purchase one regional Order Hall funded directly from the order treasury.' }),
        ui.hallQuote
          ? el('div', { class: 'gld-motd' },
            el('strong', { text: `Purchase Quote: ${ui.hallQuote.hall.name} (${ui.hallQuote.hall.region})` }),
            el('p', { class: 'gld-note', text: `Charge: ${ui.hallQuote.price}g from treasury (${ui.hallQuote.treasury}g available).` }),
            el('div', { class: 'gld-actions' },
              el('button', {
                type: 'button', class: 'btn btn-small btn-primary',
                disabled: !isLeader || !ui.hallQuote.canAfford,
                onclick: () => { act('order.hallBuy', { hallId: ui.hallQuote.hall.id, confirm: true }); ui.hallQuote = null; },
              }, `Confirm Purchase (-${ui.hallQuote.price}g)`),
              el('button', { type: 'button', class: 'btn btn-small', onclick: () => { ui.hallQuote = null; rerender(); } }, 'Cancel')))
          : null,
        el('div', { class: 'gld-hall-grid' }, catalog.map((h) => el('article', { class: 'gld-hall-card' },
          el('div', { class: 'gld-dir-head' },
            el('strong', { text: h.name }),
            el('span', { class: 'gld-badge', text: h.region })),
          el('p', { class: 'gld-meta', text: `Interior: ${h.interior} · Radius ${h.radius}m` }),
          el('div', { class: 'gld-actions' },
            el('span', { class: 'gld-badge gld-badge-mint', text: `${h.price}g` }),
            isLeader
              ? el('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => act('order.hallQuote', { hallId: h.id }) }, 'Request Quote')
              : el('span', { class: 'gld-meta', text: 'Leader only' }))))));
    }

    const canDecorate = Boolean(perms.decorateHall);
    const catalog = ord.furnishingCatalog ?? [];
    const chosen = catalog.find((c) => c.id === ui.hallFurnishCatalogId) ?? catalog[0];

    return el('div', { class: 'gld-stack' },
      el('section', { class: 'gld-card' },
        el('div', { class: 'gld-card-head' },
          el('div', { class: 'gld-card-title' },
            el('h3', { class: 'gld-h', text: hall.name }),
            el('span', { class: 'gld-badge gld-badge-blue', text: hall.region }),
            el('span', { class: 'gld-badge', text: `Decor ${hall.furnishings.length}/${hall.maxFurnishings}` }),
            el('span', { class: 'gld-badge gld-badge-mint', text: `Occupants: ${hall.occupantCount ?? 0}` })),
          el('div', { class: 'gld-actions' },
            hall.insideHall
              ? el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('order.hallLeave', {}) }, 'Leave Hall')
              : el('button', { type: 'button', class: 'btn btn-small btn-primary', disabled: !perms.hallAccess, onclick: () => act('order.hallEnter', {}) }, 'Enter Order Hall'))),
        el('p', { class: 'gld-meta', text: `Location: ${hall.townName} · ${hall.interior} · Visitor mode: ${hall.visitorMode}` }),
        (isLeader || canDecorate)
          ? el('div', { class: 'gld-actions' },
            el('span', { class: 'gld-label', text: 'Visitors:' }),
            ['members', 'invited', 'open'].map((m) => el('button', {
              type: 'button',
              class: `btn btn-small${hall.visitorMode === m ? ' gld-tab is-active' : ''}`,
              onclick: () => act('order.hallAccess', { visitorMode: m }),
            }, m)))
          : null),
      el('section', { class: 'gld-card' },
        el('h3', { class: 'gld-h', text: `Order Hall Furnishings (Rev ${hall.furnishingRev})` }),
        canDecorate && chosen
          ? el('div', { class: 'gld-inline-form' },
            el('select', {
              value: ui.hallFurnishCatalogId,
              onchange: (e) => { ui.hallFurnishCatalogId = e.target.value; rerender(); },
            }, catalog.map((c) => el('option', { value: c.id, selected: c.id === ui.hallFurnishCatalogId }, `${c.name} (${c.price}g)`))),
            el('input', {
              type: 'number', step: '0.5', value: String(ui.hallFurnishX), placeholder: 'X',
              oninput: (e) => { ui.hallFurnishX = Number(e.target.value); }, onkeydown: stopKey,
            }),
            el('input', {
              type: 'number', step: '0.5', value: String(ui.hallFurnishZ), placeholder: 'Z',
              oninput: (e) => { ui.hallFurnishZ = Number(e.target.value); }, onkeydown: stopKey,
            }),
            el('button', {
              type: 'button', class: 'btn btn-small btn-primary',
              onclick: () => act('order.hallFurnishPlace', { catalogId: chosen.id, x: ui.hallFurnishX, z: ui.hallFurnishZ, floor: 0, payFrom: perms.withdrawTreasury ? 'treasury' : 'personal' }),
            }, `Place (${chosen.price}g)`))
          : el('p', { class: 'gld-note', text: 'Only members with Decorate Hall permission may place or move hall decor.' }),
        hall.furnishings.length
          ? el('ul', { class: 'gld-list' }, hall.furnishings.map((f) => el('li', { class: 'gld-row' },
            el('span', { class: 'gld-name', text: f.name }),
            el('span', { class: 'gld-meta', text: `Floor ${f.floor} · (${f.x}, ${f.z})` }),
            canDecorate
              ? el('button', { type: 'button', class: 'btn btn-small gld-btn-danger', onclick: () => act('order.hallFurnishRemove', { furnishingId: f.id }) }, 'Remove')
              : null)))
          : el('p', { class: 'gld-note', text: 'No hall furnishings placed yet.' })));
  }

  function renderOrderVaultTab(ov, ord, perms) {
    const canWithdrawGold = Boolean(perms.withdrawTreasury);
    const canDepositVault = Boolean(perms.depositVault);
    const canWithdrawVault = Boolean(perms.withdrawVault);
    const vaultItems = ord.vault ?? [];
    const packItems = api.state?.character?.inventory ?? [];
    const audit = ord.vaultLedger ?? [];

    const treasuryCard = el('section', { class: 'gld-card' },
      el('h3', { class: 'gld-h', text: `Shared Treasury (${ord.treasury} gold)` }),
      el('p', { class: 'gld-note', text: `Your purse: ${ov.gold} gold.${canWithdrawGold ? ' You may deposit and withdraw gold.' : ' Any member may deposit; withdrawal requires Withdraw Gold permission.'}` }),
      el('div', { class: 'gld-treasury-controls' },
        el('form', {
          class: 'gld-inline-form',
          onsubmit: (e) => {
            e.preventDefault();
            const n = Math.trunc(Number(ui.depositDraft));
            if (n > 0) { act('order.deposit', { amount: n }); ui.depositDraft = ''; }
          },
        },
        el('input', {
          type: 'number', min: '1', max: String(Math.max(1, ov.gold)), step: '1',
          value: ui.depositDraft, placeholder: 'Deposit gold',
          oninput: (e) => { ui.depositDraft = e.target.value; },
          onkeydown: stopKey,
        }),
        el('button', { type: 'submit', class: 'btn btn-small btn-primary' }, 'Deposit')),
        canWithdrawGold
          ? el('form', {
            class: 'gld-inline-form',
            onsubmit: (e) => {
              e.preventDefault();
              const n = Math.trunc(Number(ui.withdrawDraft));
              if (n > 0) { act('order.withdraw', { amount: n }); ui.withdrawDraft = ''; }
            },
          },
          el('input', {
            type: 'number', min: '1', max: String(Math.max(1, ord.treasury)), step: '1',
            value: ui.withdrawDraft, placeholder: 'Withdraw gold',
            oninput: (e) => { ui.withdrawDraft = e.target.value; },
            onkeydown: stopKey,
          }),
          el('button', { type: 'submit', class: 'btn btn-small' }, 'Withdraw'))
          : null));

    const vaultCard = el('section', { class: 'gld-card' },
      el('div', { class: 'gld-card-head' },
        el('h3', { class: 'gld-h', text: `Order Item Vault (${vaultItems.length}/${ord.vaultCapacity ?? 60})` }),
        el('span', { class: 'gld-badge gld-badge-blue', text: `Rev ${ord.vaultRevision ?? 1}` })),
      el('div', { class: 'gld-two-col' },
        el('div', { class: 'gld-stack' },
          el('span', { class: 'gld-label', text: 'Stored Items' }),
          vaultItems.length
            ? el('ul', { class: 'gld-list' }, vaultItems.map((it) => el('li', { class: 'gld-row' },
              el('span', { class: 'gld-name', text: `${it.quantity > 1 ? `${it.quantity} × ` : ''}${it.name}` }),
              el('span', { class: 'gld-meta', text: `by ${it.depositedByName ?? 'Member'}` }),
              canWithdrawVault
                ? el('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => act('order.vaultWithdraw', { itemId: it.id, quantity: it.quantity }) }, 'Withdraw')
                : null)))
            : el('p', { class: 'gld-note', text: 'The order vault is empty.' })),
        el('div', { class: 'gld-stack' },
          el('span', { class: 'gld-label', text: 'Deposit From Pack' }),
          packItems.length
            ? el('ul', { class: 'gld-list' }, packItems.map((it) => {
              const blocked = Boolean(it.equipped || it.quest || it.bound || it.stolen || it.conjuredUntil || it.group === 'transport');
              return el('li', { class: 'gld-row' },
                el('span', { class: 'gld-name', text: `${it.quantity > 1 ? `${it.quantity} × ` : ''}${it.name}` }),
                el('button', {
                  type: 'button', class: 'btn btn-small',
                  disabled: blocked || !canDepositVault,
                  onclick: () => act('order.vaultDeposit', { itemId: it.id, quantity: it.quantity }),
                }, blocked ? 'Ineligible' : 'Deposit'));
            }))
            : el('p', { class: 'gld-note', text: 'No pack items available.' }))));

    const auditCard = el('section', { class: 'gld-card' },
      el('h3', { class: 'gld-h', text: `Vault & Treasury Audit Ledger (${audit.length})` }),
      audit.length
        ? el('ul', { class: 'gld-ledger' }, audit.slice(0, 15).map((e) => el('li', { class: 'gld-audit-row' },
          el('div', { class: 'gld-actions' },
            el('span', { class: 'gld-audit-tag', text: e.action.replace('_', ' ') }),
            el('span', { text: `${e.actorName}: ${e.itemName ? `${e.quantity > 1 ? `${e.quantity} × ` : ''}${e.itemName}` : e.gold ? `${e.gold}g` : (e.detail ?? '')}` })),
          el('span', { class: 'gld-meta', text: e.balance != null ? `Bal ${e.balance}g` : (e.at?.slice(11, 19) ?? '') }))))
        : (ord.ledger?.length
          ? el('ul', { class: 'gld-ledger' }, ord.ledger.slice(0, 6).map((l) =>
            el('li', { class: 'gld-ledger-row' },
              el('span', { class: l.kind === 'deposit' ? 'gld-pos' : 'gld-neg', text: `${l.kind === 'deposit' ? '+' : '-'}${l.amount}g` }),
              el('span', { text: `${l.actorName} (${l.kind})` }),
              el('span', { class: 'gld-meta', text: `Bal ${l.balance}g` }))))
          : el('p', { class: 'gld-note', text: 'No vault or treasury transactions recorded yet.' })));

    return el('div', { class: 'gld-stack' }, treasuryCard, vaultCard, auditCard);
  }

  function renderOrder(ov) {
    const blocks = [renderOrderInvites(ov)];
    const ord = ov.order;
    if (!ord) {
      blocks.push(renderOrderCreate(ov));
      return el('div', { class: 'gld-stack' }, blocks.filter(Boolean));
    }

    const isLeader = ord.myRank === 'Leader';
    const perms = ord.myPermissions ?? {
      invite: isLeader || ord.myRank === 'Officer',
      kick: isLeader || ord.myRank === 'Officer',
      promote: isLeader,
      editMotd: isLeader || ord.myRank === 'Officer',
      withdrawTreasury: isLeader || ord.myRank === 'Officer',
      depositVault: true,
      withdrawVault: isLeader || ord.myRank === 'Officer',
      decorateHall: isLeader || ord.myRank === 'Officer',
      hallAccess: true,
      siegeOfficer: isLeader || ord.myRank === 'Officer',
    };

    // Banner + MOTD
    const motdValue = ui.motdDraft !== null ? ui.motdDraft : ord.motd;
    blocks.push(el('section', { class: 'gld-card' },
      el('div', { class: 'gld-card-head' },
        el('div', { class: 'gld-card-title' },
          el('span', { class: 'gld-crest', text: `[${ord.tag}]` }),
          el('h3', { class: 'gld-h', text: ord.name }),
          el('span', { class: 'gld-badge gld-badge-blue', text: ord.myRank }),
          el('span', { class: 'gld-badge', text: `${ord.members.length}/${ord.maxMembers} Members` })),
        el('div', { class: 'gld-actions' },
          ord.hall ? el('span', { class: 'gld-badge gld-badge-blue', text: ord.hall.name }) : null,
          el('span', { class: 'gld-badge gld-badge-mint', text: `Treasury: ${ord.treasury}g` }))),
      el('div', { class: 'gld-motd' },
        el('span', { class: 'gld-label', text: 'Charter / Message of the Day' }),
        el('p', { class: 'gld-motd-text', text: ord.motd || 'No message of the day set.' }),
        perms.editMotd
          ? el('form', {
            class: 'gld-inline-form',
            onsubmit: (e) => {
              e.preventDefault();
              act('order.motd', { motd: motdValue });
              ui.motdDraft = null;
            },
          },
          el('input', {
            type: 'text',
            maxlength: '200',
            value: motdValue,
            placeholder: 'Update charter / MOTD…',
            oninput: (e) => { ui.motdDraft = e.target.value; },
            onkeydown: stopKey,
          }),
          el('button', { type: 'submit', class: 'btn btn-small' }, 'Save MOTD'))
          : null)));

    // Sub-tabs for Order sections
    const subtabs = [
      { id: 'roster', label: 'Roster & Chat' },
      { id: 'permissions', label: 'Permissions' },
      { id: 'hall', label: ord.hall ? 'Order Hall' : 'Order Hall (Unowned)' },
      { id: 'vault', label: `Vault & Treasury (${ord.vault?.length ?? 0})` },
    ];
    blocks.push(el('div', { class: 'gld-subtabs', role: 'tablist' }, subtabs.map((st) => el('button', {
      type: 'button',
      role: 'tab',
      class: `gld-subtab${ui.orderSubtab === st.id ? ' is-active' : ''}`,
      onclick: () => { ui.orderSubtab = st.id; rerender(); },
    }, st.label))));

    if (ui.orderSubtab === 'permissions') {
      blocks.push(renderOrderPermissionsTab(ord, isLeader));
    } else if (ui.orderSubtab === 'hall') {
      blocks.push(renderOrderHallTab(ord, isLeader, perms));
    } else if (ui.orderSubtab === 'vault') {
      blocks.push(renderOrderVaultTab(ov, ord, perms));
    } else {
      // Roster
      blocks.push(el('section', { class: 'gld-card' },
        el('h3', { class: 'gld-h', text: `Roster (${ord.members.filter((m) => m.online).length} online / ${ord.members.length} total)` }),
        el('ul', { class: 'gld-list' }, ord.members.map((m) =>
          el('li', { class: `gld-row${m.online ? '' : ' is-offline'}${m.self ? ' is-self' : ''}` },
            el('span', { class: `gld-dot${m.online ? ' is-online' : ''}` }),
            el('span', { class: 'gld-name', text: `${m.name}${m.self ? ' (you)' : ''}` }),
            el('span', { class: `gld-badge${m.rank === 'Leader' ? ' gld-badge-blue' : ''}`, text: m.rank }),
            el('span', { class: 'gld-meta', text: m.online ? (m.region ?? 'Online') : 'Offline' }),
            !m.self && (isLeader || (perms.kick && m.rank === 'Member') || (perms.promote && m.rank === 'Member'))
              ? el('span', { class: 'gld-actions' },
                (isLeader || perms.promote) && m.rank === 'Member'
                  ? el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('order.promote', { targetId: m.id }) }, 'Promote')
                  : null,
                isLeader && m.rank === 'Officer'
                  ? el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('order.promote', { targetId: m.id, rank: 'Leader' }) }, 'Make Leader')
                  : null,
                isLeader && m.rank === 'Officer'
                  ? el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('order.demote', { targetId: m.id }) }, 'Demote')
                  : null,
                (isLeader || (perms.kick && m.rank === 'Member'))
                  ? el('button', { type: 'button', class: 'btn btn-small gld-btn-danger', onclick: () => act('order.kick', { targetId: m.id }) }, 'Kick')
                  : null)
              : null)))));

      // Invite online players
      if (perms.invite) {
        const candidates = (ov.onlinePlayers ?? []).filter((q) => !q.inOrder);
        blocks.push(el('section', { class: 'gld-card' },
          el('h3', { class: 'gld-h', text: 'Recruit Online Players' }),
          candidates.length
            ? el('ul', { class: 'gld-list' }, candidates.map((q) =>
              el('li', { class: 'gld-row' },
                el('span', { class: 'gld-dot is-online' }),
                el('span', { class: 'gld-name', text: q.name }),
                el('span', { class: 'gld-meta', text: q.region }),
                el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('order.invite', { targetId: q.id }) }, 'Invite'))))
            : el('p', { class: 'gld-note', text: 'No unaffiliated players are online right now.' })));
      }

      // Order Chat
      blocks.push(el('section', { class: 'gld-card' },
        el('h3', { class: 'gld-h', text: `[${ord.tag}] Order Chat` }),
        renderChatBox('order', `Message [${ord.tag}] ${ord.name}…`, (text) => act('guild.chat', { scope: 'order', text }))));

      // Leave (with explicit successor selector when Leader) / Disband
      const otherMembers = ord.members.filter((m) => !m.self);
      blocks.push(el('div', { class: 'gld-footer-actions' },
        isLeader && otherMembers.length
          ? el('select', {
            value: ui.successorDraft,
            'aria-label': 'Choose successor before leaving',
            onchange: (e) => { ui.successorDraft = e.target.value; },
          },
          el('option', { value: '' }, 'Auto successor…'),
          otherMembers.map((m) => el('option', { value: String(m.id) }, `${m.name} (${m.rank})`)))
          : null,
        el('button', {
          type: 'button', class: 'btn btn-small',
          onclick: () => act('order.leave', ui.successorDraft ? { successorId: Number(ui.successorDraft) } : {}),
        }, 'Leave Order'),
        isLeader
          ? (ui.confirmDisband
            ? [
              el('button', { type: 'button', class: 'btn btn-small gld-btn-danger', onclick: () => act('order.disband') }, 'Confirm Disband'),
              el('button', { type: 'button', class: 'btn btn-small', onclick: () => { ui.confirmDisband = false; rerender(); } }, 'Cancel'),
            ]
            : el('button', { type: 'button', class: 'btn btn-small gld-btn-danger', onclick: () => { ui.confirmDisband = true; rerender(); } }, 'Disband Order'))
          : null));
    }

    return el('div', { class: 'gld-stack' }, blocks.filter(Boolean));
  }

  // ---------------------------------------------------------------- root render
  function render(root) {
    container = root;
    root.classList.add('gld-root');
    const body = [
      renderTabs(),
      el('p', { class: 'gld-live', role: 'status', 'aria-live': 'polite', text: ui.status }),
    ];
    if (ui.tab === 'directory') {
      body.push(renderDirectory());
    } else if (!ui.overview) {
      body.push(el('p', { class: 'gld-note', text: 'Loading guild records…' }));
    } else if (ui.tab === 'mine') {
      body.push(renderMine(ui.overview));
    } else {
      body.push(renderOrder(ui.overview));
    }
    root.replaceChildren(...body.filter(Boolean));
  }

  api.registerPanel('guilds', 'Guilds', render);
  return { ui, render, resetPrivateCache };
}

export default install;
