// Guilds panel (panel `guilds`): Classic Guilds overview, Directory (6 families, 8 Temples, 10 Knightly Orders),
// and Player-Founded Multiplayer Orders (roster, ranks, MOTD, shared treasury, guild chat).
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

function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-feature="guilds"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./guilds.css', import.meta.url).href;
  link.dataset.feature = 'guilds';
  document.head.append(link);
}

const MAX_CHAT_HISTORY = 40;

export function install(api) {
  loadStyles();

  const ui = {
    tab: 'mine',           // 'mine' | 'directory' | 'order'
    dirFilter: 'all',      // 'all' | 'families' | 'temples' | 'orders'
    overview: null,
    directory: null,
    status: '',
    synced: false,
    chatLogs: new Map(),   // channelKey -> [{ fromId, name, rankTitle, text, channelName }]
    chatDrafts: new Map(), // channelKey -> string
    confirmResign: null,   // group key awaiting confirmation
    confirmDisband: false,
    createDraft: { name: '', tag: '', motd: '' },
    motdDraft: null,
    depositDraft: '',
    withdrawDraft: '',
  };
  let container = null;

  const rerender = () => {
    if (container?.isConnected) render(container);
    else if (api.panel === 'guilds') api.refreshPanel?.('guilds');
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
        if (!ev.overview.order) ui.confirmDisband = false;
      }
      if (ev.directory) ui.directory = ev.directory;
      if (ev.text) {
        ev.silent = true;
        api.message(ev.text);
        say(ev.text);
      }
      if (ev.orderInvite && api.panel !== 'guilds') {
        api.message(`Order invite from ${ev.orderInvite.fromName}. Open Guilds to respond.`);
      }
      rerender();
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
    if (!ui.synced && api.state) {
      ui.synced = true;
      act('guild.overview');
    }
  });
  api.on('screen', (s) => {
    if (s !== 'game') {
      ui.synced = false;
      ui.overview = null;
      ui.directory = null;
    }
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
      el('p', { class: 'gld-note', text: ov.foundingFee > 0 ? `Charter fee: ${ov.foundingFee} gold (you carry ${ov.gold} gold).` : 'Found a persistent multiplayer guild with shared roster, ranks, charter, treasury, and private order chat.' }),
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

  function renderOrder(ov) {
    const blocks = [renderOrderInvites(ov)];
    const ord = ov.order;
    if (!ord) {
      blocks.push(renderOrderCreate(ov));
      return el('div', { class: 'gld-stack' }, blocks.filter(Boolean));
    }

    const isLeader = ord.myRank === 'Leader';
    const isOfficer = ord.myRank === 'Officer';
    const canManage = isLeader || isOfficer;

    // Banner + MOTD
    const motdValue = ui.motdDraft !== null ? ui.motdDraft : ord.motd;
    blocks.push(el('section', { class: 'gld-card' },
      el('div', { class: 'gld-card-head' },
        el('div', { class: 'gld-card-title' },
          el('span', { class: 'gld-crest', text: `[${ord.tag}]` }),
          el('h3', { class: 'gld-h', text: ord.name }),
          el('span', { class: 'gld-badge gld-badge-blue', text: ord.myRank }),
          el('span', { class: 'gld-badge', text: `${ord.members.length}/${ord.maxMembers} Members` })),
        el('span', { class: 'gld-badge gld-badge-mint', text: `Treasury: ${ord.treasury}g` })),
      el('div', { class: 'gld-motd' },
        el('span', { class: 'gld-label', text: 'Charter / Message of the Day' }),
        el('p', { class: 'gld-motd-text', text: ord.motd || 'No message of the day set.' }),
        canManage
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

    // Shared Treasury
    blocks.push(el('section', { class: 'gld-card' },
      el('h3', { class: 'gld-h', text: `Shared Treasury (${ord.treasury} gold)` }),
      el('p', { class: 'gld-note', text: `Your purse: ${ov.gold} gold.${canManage ? ' Leaders & Officers may withdraw.' : ' Any member may deposit; only Leaders & Officers may withdraw.'}` }),
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
        canManage
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
          : null),
      ord.ledger?.length
        ? el('ul', { class: 'gld-ledger' }, ord.ledger.slice(0, 6).map((l) =>
          el('li', { class: 'gld-ledger-row' },
            el('span', { class: l.kind === 'deposit' ? 'gld-pos' : 'gld-neg', text: `${l.kind === 'deposit' ? '+' : '-'}${l.amount}g` }),
            el('span', { text: `${l.actorName} (${l.kind})` }),
            el('span', { class: 'gld-meta', text: `Bal ${l.balance}g` }))))
        : null));

    // Roster
    blocks.push(el('section', { class: 'gld-card' },
      el('h3', { class: 'gld-h', text: `Roster (${ord.members.filter((m) => m.online).length} online / ${ord.members.length} total)` }),
      el('ul', { class: 'gld-list' }, ord.members.map((m) =>
        el('li', { class: `gld-row${m.online ? '' : ' is-offline'}${m.self ? ' is-self' : ''}` },
          el('span', { class: `gld-dot${m.online ? ' is-online' : ''}` }),
          el('span', { class: 'gld-name', text: `${m.name}${m.self ? ' (you)' : ''}` }),
          el('span', { class: `gld-badge${m.rank === 'Leader' ? ' gld-badge-blue' : ''}`, text: m.rank }),
          el('span', { class: 'gld-meta', text: m.online ? (m.region ?? 'Online') : 'Offline' }),
          !m.self && (isLeader || (isOfficer && m.rank === 'Member'))
            ? el('span', { class: 'gld-actions' },
              isLeader && m.rank === 'Member'
                ? el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('order.promote', { targetId: m.id }) }, 'Promote')
                : null,
              isLeader && m.rank === 'Officer'
                ? el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('order.promote', { targetId: m.id, rank: 'Leader' }) }, 'Make Leader')
                : null,
              isLeader && m.rank === 'Officer'
                ? el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('order.demote', { targetId: m.id }) }, 'Demote')
                : null,
              el('button', { type: 'button', class: 'btn btn-small gld-btn-danger', onclick: () => act('order.kick', { targetId: m.id }) }, 'Kick'))
            : null)))));

    // Invite online players
    if (canManage) {
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

    // Leave / Disband
    blocks.push(el('div', { class: 'gld-footer-actions' },
      el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('order.leave') }, 'Leave Order'),
      isLeader
        ? (ui.confirmDisband
          ? [
            el('button', { type: 'button', class: 'btn btn-small gld-btn-danger', onclick: () => act('order.disband') }, 'Confirm Disband'),
            el('button', { type: 'button', class: 'btn btn-small', onclick: () => { ui.confirmDisband = false; rerender(); } }, 'Cancel'),
          ]
          : el('button', { type: 'button', class: 'btn btn-small gld-btn-danger', onclick: () => { ui.confirmDisband = true; rerender(); } }, 'Disband Order'))
        : null));

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
  return { ui, render };
}

export default install;
