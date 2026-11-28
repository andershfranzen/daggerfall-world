// Social screen (panel `party`, key O):
//   - Fellowship & Travel: party roster, location sharing (off/coarse/exact), map pings,
//     travel-to-leader quotes, expiring group travel ready-checks, two-sided trade, travellers roll, chat.
//   - Friends & Blocks: account-scoped friends, exact-name & peer requests, privacy toggles,
//     directed blocks, and moderator report submission.
//   - Letters: account mailbox with inbox, sent, reply threading, unread badge, cursor pagination,
//     plain-text rendering, per-viewer delete, and letter evidence reporting.
import { getItemArtSource, itemIcon } from './inventory/icons.js';
import {
  CHAT_HELP_SUMMARY,
  describeFriendPresence,
  describeMemberLocation,
  describeOffer,
  draftFrom,
  draftMatches,
  draftToArgs,
  formatRelativeTime,
  parseChatInput,
  resetPrivateUiState,
  tradeableItems,
} from './social/model.js';

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

const CHANNEL_LABEL = {
  say: 'Nearby',
  local: 'Nearby',
  shout: 'Shout',
  yell: 'Shout',
  whisper: 'Whisper',
  emote: 'Emote',
  party: 'Party',
  region: 'Region',
  global: 'Global',
};

const QUICK_DESTINATIONS = Object.freeze([
  { id: '', label: 'Follow Party Leader' },
  { id: 'town:Daggerfall/Gothway Garden', label: 'Gothway Garden (Daggerfall)' },
  { id: 'town:Daggerfall/Daggerfall', label: 'City of Daggerfall' },
  { id: 'town:Wayrest/Wayrest', label: 'City of Wayrest' },
  { id: 'town:Sentinel/Sentinel', label: 'City of Sentinel' },
]);

const REPORT_CATEGORIES = Object.freeze([
  ['harassment', 'Harassment'],
  ['spam', 'Spam / Flooding'],
  ['impersonation', 'Impersonation'],
  ['abuse', 'Abuse / Threats'],
  ['other', 'Other'],
]);

function loadStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-feature="social"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./social.css', import.meta.url).href;
  link.dataset.feature = 'social';
  document.head.append(link);
}

export function install(api) {
  loadStyles();
  getItemArtSource(api);
  const ui = {
    tab: 'fellowship', // 'fellowship' | 'friends' | 'letters'
    social: null,
    lastSelfId: null,
    selectedId: null,
    draft: null, // {tradeId, revision, items: Map, gold}
    channel: 'region',
    whisperTarget: '',
    compose: '',
    scope: 'all', // 'all' | 'region' | 'near'
    search: '',
    recentChat: [],
    status: '',
    synced: false,
    // Friends & Blocks UI state
    friendFilter: 'all', // 'all' | 'online'
    addFriendName: '',
    addBlockName: '',
    friendsExtra: [],
    friendsNextCursor: null,
    privacyDraft: null,
    // Letters / Mailbox UI state
    mailFolder: 'inbox', // 'inbox' | 'sent'
    mailExtra: { inbox: [], sent: [] },
    mailNextCursor: { inbox: null, sent: null },
    activeThread: null, // thread object from server
    mailReply: '',
    composeMail: null, // { toAccount, toName, subject, body }
    // Party Coordination UI state
    pingLabel: 'Rally Point',
    pingNote: '',
    travelDest: '',
    travelSpeed: 'reckless',
    travelLodging: 'camp',
    travelShip: false,
    travelQuote: null,
    // Moderation Report drawer state
    reportDraft: null, // { targetId, targetAccount, targetName, evidenceType, evidenceId, evidenceExcerpt, category, reason }
  };
  let container = null;
  let mailReqSeq = 0;

  const character = () => api.state?.character ?? null;
  const selfPlayerId = () => {
    const v = api.selfId ?? api.state?.selfId;
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  };
  const rerender = () => {
    if (container?.isConnected) render(container);
    else if (api.panel === 'party') api.refreshPanel?.('party');
  };
  api.on('assets', rerender);

  const act = (verb, args) => {
    try {
      api.act(verb, args);
    } catch (e) {
      api.message(e?.message || String(e), { kind: 'error' });
    }
  };
  const say = (text) => {
    ui.status = text;
    const live = container?.querySelector('.soc-live');
    if (live) live.textContent = text;
  };

  function syncPrivacyDraft() {
    const c = ui.social?.contacts;
    if (!c) { ui.privacyDraft = null; return; }
    if (!ui.privacyDraft) {
      ui.privacyDraft = {
        publicLabel: c.publicLabel || '',
        allowRequests: c.settings?.allowRequests ?? 'everyone',
        showPresence: c.settings?.showPresence ?? 'friends',
        showLastActive: c.settings?.showLastActive !== false,
        allowLetters: c.settings?.allowLetters !== false,
      };
    }
  }

  // ---------------------------------------------------------------- server events
  api.on('event', (ev) => {
    if (!ev) return;
    if (ev.kind === 'social') {
      if (ev.social) {
        ui.social = ev.social;
        ui.friendsNextCursor = ev.social.contacts?.nextCursor ?? null;
        ui.mailNextCursor.inbox = ev.social.mail?.inboxNextCursor ?? null;
        ui.mailNextCursor.sent = ev.social.mail?.sentNextCursor ?? null;
        if (!ui.privacyDraft && ev.social.contacts) syncPrivacyDraft();
      }
      if (ev.friendsPage) {
        const baseIds = new Set((ui.social?.contacts?.friends ?? []).map((f) => f.accountKey));
        for (const f of ev.friendsPage.friends ?? []) {
          if (!baseIds.has(f.accountKey) && !ui.friendsExtra.some((x) => x.accountKey === f.accountKey)) {
            ui.friendsExtra.push(f);
          }
        }
        ui.friendsNextCursor = ev.friendsPage.nextCursor ?? null;
      }
      if (ev.mailPage) {
        const folder = ev.mailPage.folder === 'sent' ? 'sent' : 'inbox';
        const baseIds = new Set((ui.social?.mail?.[folder] ?? []).map((m) => m.id));
        const list = ui.mailExtra[folder];
        for (const item of ev.mailPage.items ?? []) {
          if (!baseIds.has(item.id) && !list.some((x) => x.id === item.id)) list.push(item);
        }
        ui.mailNextCursor[folder] = ev.mailPage.nextCursor ?? null;
      }
      if (ev.mailThread) {
        ui.activeThread = ev.mailThread;
      }
      if (ev.mailSent) {
        if (ui.composeMail) ui.composeMail = null;
        if (ui.activeThread && ev.mailSent.threadId === ui.activeThread.threadId) {
          act('mail.thread', { threadId: ui.activeThread.threadId, markRead: true });
        }
      }
      if (ev.mailReceived) {
        if (ui.activeThread && ev.mailReceived.threadId === ui.activeThread.threadId) {
          act('mail.thread', { threadId: ui.activeThread.threadId, markRead: false });
        }
        if (api.panel !== 'party') {
          api.message(`New letter from ${ev.mailReceived.fromLabel}. Press O → Letters.`);
        }
      }
      if (ev.mailDeleted && ui.activeThread) {
        ui.activeThread.messages = ui.activeThread.messages.filter((m) => m.id !== ev.mailDeleted.letterId);
        if (!ui.activeThread.messages.length) ui.activeThread = null;
      }
      if (ev.partyTravelQuote) {
        ui.travelQuote = ev.partyTravelQuote;
      }
      if (ev.reportSubmitted) {
        ui.reportDraft = null;
      }
      syncDraft();
      if (ev.text) {
        ev.silent = true;
        api.message(ev.text);
        say(ev.text);
      }
      if ((ev.invite || ev.tradeRequest || ev.friendRequest) && api.panel !== 'party') {
        api.message('Press O to open Social.');
      }
      rerender();
    } else if (ev.kind === 'chat' && ev.channel) {
      chatLine(ev);
      if (container?.isConnected) renderRecentFeed();
    }
  });

  api.on('state', () => {
    const sid = api.state?.selfId ?? null;
    if (sid != null && ui.lastSelfId != null && String(sid) !== String(ui.lastSelfId)) {
      // Clear all private UI state on character/account switch before syncing next character.
      resetPrivateUiState(ui);
      ui.privacyDraft = null;
      ui.synced = false;
    }
    if (sid != null) ui.lastSelfId = sid;
    if (!ui.synced && api.state) {
      ui.synced = true;
      act('social.sync');
    }
  });

  api.on('screen', (s) => {
    if (s !== 'game') {
      ui.synced = false;
      ui.lastSelfId = null;
      ui.privacyDraft = null;
      resetPrivateUiState(ui);
    }
  });

  api.on('panel', (p) => {
    if (p?.id === 'party' && p.open) act('social.sync');
  });

  api.on('panelDetail', (d) => {
    if (d?.id === 'party' && d.detail) {
      if (d.detail.targetId != null) ui.selectedId = Number(d.detail.targetId);
      if (d.detail.tab && ['fellowship', 'friends', 'letters'].includes(d.detail.tab)) {
        ui.tab = d.detail.tab;
      }
      rerender();
    }
  });

  function syncDraft() {
    const t = ui.social?.trade;
    if (!t || t.state !== 'open') {
      ui.draft = null;
      return;
    }
    if (!ui.draft || ui.draft.tradeId !== t.id || ui.draft.serverKey !== JSON.stringify(t.mine)) {
      ui.draft = { tradeId: t.id, serverKey: JSON.stringify(t.mine), ...draftFrom(t.mine) };
    }
  }

  // ---------------------------------------------------------------- channel chat in the HUD log
  function appendChatItem(li) {
    const log = document.getElementById('chat-log');
    if (!log) return;
    log.append(li);
    while (log.children.length > 80) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  function systemChatLine(text, extraClass = '') {
    appendChatItem(el('li', {
      class: `chat-line chat-system${extraClass ? ` ${extraClass}` : ''}`,
      'data-at': String(Date.now()),
    }, el('span', { class: 'chat-text', text })));
  }

  function chatLine(ev) {
    const channel = ev.channel === 'local' ? 'say' : ev.channel === 'yell' ? 'shout' : ev.channel;
    const selfId = api.selfId ?? api.state?.selfId;
    const isSelf = selfId != null && String(ev.fromId) === String(selfId);
    ui.recentChat.push({
      channel,
      name: ev.name || '',
      toName: ev.toName || '',
      region: ev.region || '',
      text: ev.text || '',
      self: isSelf,
    });
    while (ui.recentChat.length > 20) ui.recentChat.shift();

    let li;
    if (channel === 'say') {
      li = el('li', { class: 'chat-line chat-channel chat-say', 'data-at': String(Date.now()) },
        el('span', { class: 'chat-name', text: ev.name }),
        el('span', { class: 'chat-text', text: ev.text }));
    } else if (channel === 'emote') {
      li = el('li', { class: 'chat-line chat-channel chat-emote', 'data-at': String(Date.now()) },
        el('span', { class: 'chat-emote-mark', text: '*' }),
        ' ',
        el('span', { class: 'chat-name', text: ev.name }),
        ' ',
        el('span', { class: 'chat-text', text: ev.text }));
    } else if (channel === 'whisper') {
      const label = isSelf && ev.toName ? `To ${ev.toName}` : ev.name;
      li = el('li', { class: 'chat-line chat-channel chat-whisper', 'data-at': String(Date.now()) },
        el('span', { class: 'chat-tag', text: '[Whisper]' }),
        ' ',
        el('span', { class: 'chat-name', text: label }),
        el('span', { class: 'chat-text', text: ev.text }));
    } else {
      const tag = channel === 'region' && ev.region
        ? `[${CHANNEL_LABEL[channel]}: ${ev.region}]`
        : `[${CHANNEL_LABEL[channel] ?? channel}]`;
      li = el('li', { class: `chat-line chat-channel chat-${channel}`, 'data-at': String(Date.now()) },
        el('span', { class: 'chat-tag', text: tag }),
        ' ',
        el('span', { class: 'chat-name', text: ev.name }),
        el('span', { class: 'chat-text', text: ev.text }));
    }
    if (isSelf) li.classList.add('chat-self');
    appendChatItem(li);
  }

  // Plain text sends proximity chat (~24 m); leading `/` or `/yell` shouts across the area.
  if (typeof document !== 'undefined') {
    const form = document.getElementById('chat-form');
    const input = document.getElementById('chat-input');
    form?.addEventListener('submit', (e) => {
      const cmd = parseChatInput(input?.value ?? '');
      e.preventDefault();
      e.stopImmediatePropagation();
      if (cmd) {
        if (cmd.channel === 'help') {
          systemChatLine(CHAT_HELP_SUMMARY, 'chat-help');
        } else if (cmd.channel === 'whisper') {
          if (!cmd.target || !cmd.text) {
            systemChatLine('Usage: /w <name> <message> (quote names with spaces).', 'chat-help');
          } else {
            act('chat.send', { channel: 'whisper', target: cmd.target, text: cmd.text });
          }
        } else if (cmd.text) {
          act('chat.send', { channel: cmd.channel, text: cmd.text });
        }
      }
      if (input) {
        input.value = '';
        input.blur();
      }
    }, true);
    if (input) {
      input.placeholder = 'Say nearby · /yell to shout · /help';
      input.title = 'Plain text speaks nearby (~24 m). Start with / or /yell to shout across the area. /p, /r, /g, /w, /me, /help.';
    }
  }

  // ---------------------------------------------------------------- rendering
  function renderRecentFeed() {
    const feed = container?.querySelector('.soc-feed');
    if (!feed) return;
    if (!ui.recentChat.length) {
      feed.replaceChildren(el('li', { class: 'soc-feed-empty', text: 'No recent dispatches in this session.' }));
      return;
    }
    feed.replaceChildren(...ui.recentChat.slice(-8).map((m) => {
      const tag = CHANNEL_LABEL[m.channel] ?? m.channel;
      const who = m.channel === 'whisper' && m.self && m.toName ? `To ${m.toName}` : m.name;
      return el('li', { class: `soc-feed-line soc-ch-${m.channel}` },
        el('span', { class: 'soc-feed-tag', text: `[${tag}]` }),
        who ? el('strong', { class: 'soc-feed-who', text: `${who}:` }) : null,
        el('span', { class: 'soc-feed-text', text: m.text }));
    }));
    feed.scrollTop = feed.scrollHeight;
  }

  function render(root) {
    container = root;
    syncDraft();
    const s = ui.social;
    root.classList.add('soc-root');
    const live = el('p', { class: 'soc-live', role: 'status', 'aria-live': 'polite', text: ui.status });
    if (!s) {
      root.replaceChildren(live, el('div', { class: 'soc-sec soc-loading' },
        el('p', { class: 'soc-empty', text: 'Consulting the herald’s rolls for travellers in the Iliac Bay…' })));
      return;
    }

    const pendingReq = s.contacts?.incoming?.length ?? 0;
    const unreadMail = s.mail?.unreadCount ?? 0;
    const hasProposal = Boolean(s.party?.travelProposal);

    const tabs = el('nav', { class: 'soc-tabs', role: 'tablist', 'aria-label': 'Social sections' },
      tabButton('fellowship', 'Fellowship & Travel', hasProposal ? 'Ready Check' : null, hasProposal),
      tabButton('friends', 'Friends & Blocks', pendingReq > 0 ? String(pendingReq) : null, pendingReq > 0),
      tabButton('letters', 'Letters', unreadMail > 0 ? String(unreadMail) : null, unreadMail > 0),
    );

    const reportBox = ui.reportDraft ? reportDrawerView() : null;

    let body;
    if (ui.tab === 'friends') {
      body = friendsTabView(s);
    } else if (ui.tab === 'letters') {
      body = lettersTabView(s);
    } else {
      body = fellowshipTabView(s);
    }

    root.replaceChildren(...[tabs, live, reportBox, body].filter(Boolean));
    if (ui.tab === 'fellowship') renderRecentFeed();
  }

  function tabButton(id, label, badgeText, highlight) {
    const active = ui.tab === id;
    return el('button', {
      type: 'button',
      role: 'tab',
      class: `soc-tab-btn${active ? ' is-active' : ''}`,
      'aria-selected': String(active),
      'data-soc-tab': id,
      onclick: () => {
        ui.tab = id;
        rerender();
      },
    },
      el('span', { text: label }),
      badgeText ? el('span', { class: `soc-tab-badge${highlight ? ' is-alert' : ''}`, text: badgeText }) : null);
  }

  function section(title, cls, badge, ...kids) {
    const id = `soc-h-${cls}`;
    return el('section', { class: `soc-sec soc-${cls}`, 'aria-labelledby': id },
      el('header', { class: 'soc-sec-head' },
        el('h3', { class: 'soc-h', id, text: title }),
        badge ? el('span', { class: 'soc-head-badge', text: badge }) : null),
      ...kids);
  }

  // ---------------------------------------------------------------- Fellowship & Travel tab
  function fellowshipTabView(s) {
    const invites = invitesView(s);
    const trade = tradeView(s);
    const readyBanner = readyCheckBannerView(s);
    const leftCol = el('div', { class: 'soc-col soc-col-left' },
      partyView(s),
      s.party ? partyCoordinationView(s) : null,
      !s.trade ? satchelView(s) : null,
    );
    const rightCol = el('div', { class: 'soc-col soc-col-right' },
      peopleView(s),
      composeView(s),
    );
    return el('div', { class: 'soc-tab-panel', 'data-panel': 'fellowship' },
      invites,
      readyBanner,
      trade,
      el('div', { class: 'soc-grid' }, leftCol, rightCol));
  }

  function readyCheckBannerView(s) {
    const p = s.party;
    const proposal = p?.travelProposal;
    if (!p || !proposal) return null;
    const selfId = selfPlayerId();
    const me = proposal.participants.find((x) => Number(x.id) === selfId);
    const canCancel = Number(proposal.proposerId) === selfId || Number(p.leaderId) === selfId;
    const secsLeft = Number.isFinite(proposal.remainingMs)
      ? Math.max(0, Math.ceil(proposal.remainingMs / 1000))
      : Math.max(0, Math.ceil((proposal.expiresAt - Date.now()) / 1000));
    return section(
      `Group Travel Ready Check — ${proposal.destinationName} (${proposal.destinationRegion})`,
      'invites',
      `Rev #${proposal.revision} · ${secsLeft}s left`,
      proposal.notice ? el('p', { class: 'soc-warn-note', text: proposal.notice }) : null,
      el('ul', { class: 'soc-list soc-ready-list' }, proposal.participants.map((part) => {
        const fareText = part.alreadyThere
          ? 'Already at destination'
          : part.eligible
            ? `${part.cost} gp · ${part.days}d (${part.transport})`
            : `Ineligible: ${part.reason}`;
        return el('li', { class: `soc-row soc-ready-row${part.confirmed ? ' is-ready' : ''}${!part.eligible ? ' is-blocked' : ''}` },
          el('span', { class: 'soc-slot-main' },
            el('span', { class: 'soc-slot-name', text: `${part.name}${Number(part.id) === selfId ? ' (you)' : ''}` }),
            el('span', { class: 'soc-meta', text: fareText })),
          el('span', { class: `soc-seal-state${part.confirmed ? ' soc-ok' : ''}`, text: part.confirmed ? 'Ready' : 'Pending' }));
      })),
      el('div', { class: 'soc-foot-actions' },
        me && !me.confirmed
          ? el('button', {
            type: 'button',
            class: 'btn btn-small btn-primary',
            disabled: me.eligible ? null : true,
            title: me.eligible ? `Confirm ${me.cost} gp journey` : me.reason,
            onclick: () => act('party.travelRespond', {
              proposalId: proposal.id,
              revision: proposal.revision,
              response: 'ready',
              expectCost: me.cost,
            }),
          }, me.alreadyThere ? 'Confirm Ready' : `Confirm Ready (${me.cost} gp)`)
          : null,
        me
          ? el('button', {
            type: 'button', class: 'btn btn-small',
            onclick: () => act('party.travelRespond', { proposalId: proposal.id, revision: proposal.revision, response: 'opt_out' }),
          }, 'Opt Out')
          : null,
        me
          ? el('button', {
            type: 'button', class: 'btn btn-small btn-danger',
            onclick: () => act('party.travelRespond', { proposalId: proposal.id, revision: proposal.revision, response: 'decline' }),
          }, 'Decline')
          : null,
        canCancel
          ? el('button', {
            type: 'button', class: 'btn btn-small',
            onclick: () => act('party.travelCancel', { proposalId: proposal.id }),
          }, 'Cancel')
          : null));
  }

  function invitesView(s) {
    if (!s.invites?.length) return null;
    return section('Fellowship Summons', 'invites', `${s.invites.length} pending`,
      el('ul', { class: 'soc-list' }, s.invites.map((inv) =>
        el('li', { class: 'soc-row soc-invite-row' },
          el('span', { class: 'soc-seal', 'aria-hidden': 'true', text: '✦' }),
          el('span', { class: 'soc-name', text: `${inv.fromName} invites you to ride under their banner.` }),
          el('span', { class: 'soc-actions' },
            el('button', { type: 'button', class: 'btn btn-small btn-primary', 'data-focus-key': `inv-accept-${inv.fromId}`, onclick: () => act('party.accept', { fromId: inv.fromId }) }, 'Accept'),
            el('button', { type: 'button', class: 'btn btn-small', 'data-focus-key': `inv-decline-${inv.fromId}`, onclick: () => act('party.decline', { fromId: inv.fromId }) }, 'Decline'))))));
  }

  function partyView(s) {
    const p = s.party;
    const ch = character();
    const selfName = ch?.character?.name || ch?.name || api.account?.username || 'You';
    const maxSlots = p?.max ?? 6;
    if (!p) {
      const pending = s.outgoing?.length
        ? el('p', { class: 'soc-pending-note', text: `Summons sent to: ${s.outgoing.map((o) => o.toName).join(', ')}.` })
        : null;
      const slots = [
        el('li', { class: 'soc-slot soc-slot-self' },
          el('span', { class: 'soc-lamp soc-lamp-on', 'aria-hidden': 'true' }),
          el('span', { class: 'soc-slot-main' },
            el('strong', { class: 'soc-slot-name', text: selfName }),
            el('span', { class: 'soc-meta', text: s.region || 'Iliac Bay' })),
          el('span', { class: 'soc-badge', text: 'Solo' })),
      ];
      for (let i = 1; i < Math.min(maxSlots, 4); i++) {
        slots.push(el('li', { class: 'soc-slot soc-slot-open' },
          el('span', { class: 'soc-lamp', 'aria-hidden': 'true' }),
          el('span', { class: 'soc-slot-empty', text: 'Open companion slot' })));
      }
      return section('Fellowship', 'party', `1 / ${maxSlots}`,
        el('ul', { class: 'soc-slots' }, slots),
        pending,
        el('p', { class: 'soc-note', text: 'Invite travellers from the roll to share dungeon delves, coordinate map pings, and travel together.' }));
    }

    const self = selfPlayerId();
    const lead = Number(p.leaderId) === self;
    const rows = p.members.map((m) => {
      const me = Number(m.id) === self;
      const isLeader = Number(m.id) === Number(p.leaderId);
      const locLine = describeMemberLocation(m);
      return el('li', { class: `soc-slot${me ? ' soc-slot-self' : ''}${m.online ? '' : ' soc-offline'}` },
        el('span', { class: `soc-lamp${m.online ? ' soc-lamp-on' : ''}`, 'aria-hidden': 'true' }),
        el('span', { class: 'soc-slot-main' },
          el('span', { class: 'soc-slot-name' }, m.name, me ? ' (you)' : ''),
          el('span', { class: 'soc-meta', text: locLine })),
        isLeader ? el('span', { class: 'soc-badge soc-badge-gold', text: 'Leader' }) : null,
        lead && !me
          ? el('span', { class: 'soc-actions' },
            el('button', { type: 'button', class: 'btn btn-small', 'data-focus-key': `promote-${m.id}`, onclick: () => act('party.promote', { targetId: m.id }), 'aria-label': `Make ${m.name} leader` }, 'Promote'),
            el('button', { type: 'button', class: 'btn btn-small btn-danger', 'data-focus-key': `kick-${m.id}`, onclick: () => act('party.kick', { targetId: m.id }), 'aria-label': `Remove ${m.name} from the party` }, 'Remove'))
          : null);
    });
    const openCount = Math.max(0, Math.min(2, p.max - p.members.length));
    for (let i = 0; i < openCount; i++) {
      rows.push(el('li', { class: 'soc-slot soc-slot-open' },
        el('span', { class: 'soc-lamp', 'aria-hidden': 'true' }),
        el('span', { class: 'soc-slot-empty', text: 'Open companion slot' })));
    }
    const pending = s.outgoing?.length
      ? el('p', { class: 'soc-pending-note', text: `Summons sent to: ${s.outgoing.map((o) => o.toName).join(', ')}.` })
      : null;

    const shareMode = p.myLocationSharing ?? 'coarse';
    const shareBar = el('div', { class: 'soc-share-bar' },
      el('span', { class: 'soc-share-label', text: 'Share Location:' }),
      el('div', { class: 'soc-scopes', role: 'group', 'aria-label': 'Party location sharing mode' },
        [
          ['off', 'Hidden'],
          ['coarse', 'Coarse'],
          ['exact', 'Exact Pins'],
        ].map(([mode, label]) => el('button', {
          type: 'button',
          class: 'soc-scope-btn',
          'aria-pressed': String(shareMode === mode),
          onclick: () => act('party.locationShare', { mode }),
        }, label))));

    return section('Fellowship', 'party', `${p.members.length} / ${p.max}`,
      shareBar,
      el('ul', { class: 'soc-slots' }, rows),
      pending,
      el('div', { class: 'soc-foot-actions' },
        el('button', { type: 'button', class: 'btn btn-small btn-danger', 'data-focus-key': 'leave', onclick: () => act('party.leave') }, 'Leave Fellowship')));
  }

  function partyCoordinationView(s) {
    const p = s.party;
    if (!p) return null;
    const selfId = api.state?.selfId;
    const proposal = p.travelProposal;
    const pings = p.pings ?? [];

    const pingForm = el('form', {
      class: 'soc-inline-form',
      onsubmit: (e) => {
        e.preventDefault();
        act('party.ping', { label: ui.pingLabel, note: ui.pingNote });
        ui.pingNote = '';
      },
    },
      el('input', {
        type: 'text', class: 'soc-input-sm', value: ui.pingLabel, maxlength: '48', placeholder: 'Pin label…',
        'aria-label': 'Map ping label',
        oninput: (e) => (ui.pingLabel = e.target.value),
        onkeydown: (e) => e.stopPropagation(),
      }),
      el('input', {
        type: 'text', class: 'soc-input-grow', value: ui.pingNote, maxlength: '120', placeholder: 'Optional note for party…',
        'aria-label': 'Map ping note',
        oninput: (e) => (ui.pingNote = e.target.value),
        onkeydown: (e) => e.stopPropagation(),
      }),
      el('button', { type: 'submit', class: 'btn btn-small btn-primary' }, 'Drop Ping'));

    const pingList = pings.length
      ? el('ul', { class: 'soc-list soc-ping-list' }, pings.slice(-4).reverse().map((pg) => {
        const coords = pg.exact && Number.isFinite(pg.exact.x)
          ? ` (${Math.round(pg.exact.x)}, ${Math.round(pg.exact.z)})`
          : pg.exact && Number.isFinite(pg.exact.mapX)
            ? ` [Map ${pg.exact.mapX},${pg.exact.mapY}]`
            : '';
        return el('li', { class: 'soc-row soc-ping-row' },
          el('span', { class: 'soc-seal', 'aria-hidden': 'true', text: '◈' }),
          el('span', { class: 'soc-slot-main' },
            el('strong', { class: 'soc-slot-name', text: `${pg.label} · ${pg.fromName}` }),
            el('span', { class: 'soc-meta', text: `${pg.landmark || pg.region}${coords}${pg.note ? ` — ${pg.note}` : ''}` })));
      }))
      : el('p', { class: 'soc-note', text: 'No active map pings. Drop a rally pin to mark your current landmark or coordinates.' });

    let travelBlock = null;
    if (!proposal) {
      const destSelect = el('select', {
        class: 'soc-select',
        'aria-label': 'Group travel destination',
        onchange: (e) => { ui.travelDest = e.target.value; rerender(); },
      }, QUICK_DESTINATIONS.map((d) => el('option', {
        value: d.id,
        selected: ui.travelDest === d.id ? true : null,
        text: d.id === '' && p.leaderDestination ? `Leader: ${p.leaderDestination.name} (${p.leaderDestination.region})` : d.label,
      })));

      const optsRow = el('div', { class: 'soc-travel-opts' },
        el('select', {
          class: 'soc-select-sm',
          'aria-label': 'Travel pace',
          onchange: (e) => { ui.travelSpeed = e.target.value; },
        },
          el('option', { value: 'reckless', selected: ui.travelSpeed === 'reckless' ? true : null, text: 'Reckless' }),
          el('option', { value: 'cautious', selected: ui.travelSpeed === 'cautious' ? true : null, text: 'Cautious' })),
        el('select', {
          class: 'soc-select-sm',
          'aria-label': 'Travel lodging',
          onchange: (e) => { ui.travelLodging = e.target.value; },
        },
          el('option', { value: 'camp', selected: ui.travelLodging === 'camp' ? true : null, text: 'Camp' }),
          el('option', { value: 'inn', selected: ui.travelLodging === 'inn' ? true : null, text: 'Inns' })),
        el('label', { class: 'soc-check' },
          el('input', {
            type: 'checkbox',
            checked: ui.travelShip ? true : null,
            onchange: (e) => { ui.travelShip = e.target.checked; },
          }),
          ' Ship'));

      const travelArgs = () => ({
        ...(ui.travelDest ? { to: ui.travelDest } : {}),
        options: { speed: ui.travelSpeed, lodging: ui.travelLodging, ship: ui.travelShip },
      });

      const quoteBox = ui.travelQuote
        ? el('div', { class: 'soc-quote-box' },
          el('p', { class: 'soc-pending-note', text: `Quote to ${ui.travelQuote.destinationName}: ${ui.travelQuote.mine.alreadyThere ? 'Already there' : ui.travelQuote.mine.eligible ? `${ui.travelQuote.mine.cost} gp · ${ui.travelQuote.mine.days}d` : ui.travelQuote.mine.reason}` }),
          el('ul', { class: 'soc-list' }, (ui.travelQuote.members ?? []).map((m) =>
            el('li', { class: 'soc-row' },
              el('span', { class: 'soc-name', text: m.name }),
              el('span', { class: 'soc-meta', text: m.alreadyThere ? 'Here' : m.eligible ? `${m.cost} gp · ${m.days}d` : m.reason })))))
        : null;

      travelBlock = el('div', { class: 'soc-travel-box' },
        el('h4', { class: 'soc-h4', text: 'Group Travel & Ready Check' }),
        destSelect,
        optsRow,
        el('div', { class: 'soc-foot-actions' },
          el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('party.travelQuote', travelArgs()) }, 'Get Travel Quote'),
          el('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => act('party.travelPropose', travelArgs()) }, 'Start Ready Check')),
        quoteBox);
    }

    return section('Party Map Pings & Group Travel', 'coord', proposal ? 'Ready Check Active' : `${pings.length} pin${pings.length === 1 ? '' : 's'}`,
      el('h4', { class: 'soc-h4', text: 'Map Pings' }),
      pingForm,
      pingList,
      travelBlock);
  }

  function satchelView(s) {
    const ch = character();
    const gold = Number.isFinite(ch?.gold) ? ch.gold : 0;
    const items = tradeableItems(ch);
    const nearbyTrade = (s.players ?? []).filter((o) => o.sameLocation && o.inTradeRange && !o.busy);
    const preview = items.slice(0, 8);
    return section('Trade Satchel', 'satchel', `${gold} gp`,
      el('div', { class: 'soc-satchel-stats' },
        el('div', { class: 'soc-stat-pill' },
          itemIcon(api, { template: 'gold' }),
          el('span', { class: 'soc-stat-label', text: 'Purse' }),
          el('strong', { class: 'soc-stat-val', text: `${gold} gold` })),
        el('div', { class: 'soc-stat-pill' },
          el('span', { class: 'soc-stat-label', text: 'Tradeable Goods' }),
          el('strong', { class: 'soc-stat-val', text: `${items.length} item${items.length === 1 ? '' : 's'}` }))),
      preview.length
        ? el('ul', { class: 'soc-satchel-grid' },
          preview.map((it) => el('li', { class: 'soc-satchel-item', title: it.name },
            itemIcon(api, it),
            el('span', { class: 'soc-satchel-name', text: it.quantity > 1 ? `${it.name} ×${it.quantity}` : it.name }))),
          items.length > preview.length ? el('li', { class: 'soc-satchel-more', text: `+${items.length - preview.length} more in pack` }) : null)
        : el('p', { class: 'soc-note', text: 'Only unequipped, non-quest goods can be placed on the trade table.' }),
      el('p', { class: 'soc-note soc-satchel-hint', text: nearbyTrade.length
        ? `${nearbyTrade.length} traveller${nearbyTrade.length === 1 ? '' : 's'} within ${s.tradeRange} paces — choose Trade beside their name.`
        : `Approach within ${s.tradeRange} paces of another traveller to barter gold and gear.` }));
  }

  function peopleView(s) {
    const lead = !s.party || Number(s.party.leaderId) === selfPlayerId();
    const full = s.party && s.party.members.length >= s.party.max;
    const busy = Boolean(s.trade);
    const all = s.players ?? [];
    const nearCount = all.filter((o) => o.sameLocation).length;
    const regCount = all.filter((o) => o.region === s.region).length;

    const scopes = el('div', { class: 'soc-scopes', role: 'group', 'aria-label': 'Filter travellers' },
      [
        ['all', `All (${all.length})`],
        ['region', `Region (${regCount})`],
        ['near', `Here (${nearCount})`],
      ].map(([id, label]) => el('button', {
        type: 'button', class: 'soc-scope-btn', 'aria-pressed': String(ui.scope === id),
        onclick: () => { ui.scope = id; rerender(); },
      }, label)));

    if (!all.length) {
      return section('Travellers Abroad', 'people', '0 online',
        el('div', { class: 'soc-quiet' },
          el('p', { class: 'soc-quiet-title', text: 'The roads of the Iliac Bay are quiet.' }),
          el('p', { class: 'soc-note', text: `No other adventurers are currently online. When travellers enter ${s.region || 'the realm'}, you can hail them, form a fellowship, add friends, or barter goods here.` })));
    }

    const q = ui.search.trim().toLowerCase();
    const filtered = all.filter((o) => {
      if (ui.scope === 'near' && !o.sameLocation) return false;
      if (ui.scope === 'region' && o.region !== s.region) return false;
      if (q && !o.name.toLowerCase().includes(q) && !(o.region || '').toLowerCase().includes(q)) return false;
      return true;
    });

    const searchBox = all.length > 3
      ? el('input', {
        type: 'search', class: 'soc-search', value: ui.search, placeholder: 'Filter travellers…',
        'aria-label': 'Filter travellers by name or region',
        oninput: (e) => { ui.search = e.target.value; rerender(); },
        onkeydown: (e) => e.stopPropagation(),
      })
      : null;

    return section('Travellers Abroad', 'people', `${all.length} online`,
      el('div', { class: 'soc-people-tools' }, scopes, searchBox),
      filtered.length
        ? el('ul', { class: 'soc-list soc-people-list', role: 'list' }, filtered.map((o) => {
          const selected = ui.selectedId === o.id;
          const outgoing = s.outgoing?.some((x) => x.toId === o.id);
          const inviteBlock = !lead ? 'Only the leader can invite' : o.partyMember ? 'In your party' : o.inParty ? 'In another party' : full ? 'Party is full' : outgoing ? 'Invitation sent' : null;
          const tradeBlock = busy ? 'Finish your current trade' : o.busy ? 'Busy trading' : !o.sameLocation ? `In ${o.region}` : !o.inTradeRange ? `Move within ${s.tradeRange} paces` : null;
          const locText = o.sameLocation ? (o.inTradeRange ? 'Beside you · Can trade' : 'Same place') : (o.region || 'Abroad');
          return el('li', { class: `soc-row soc-traveller${selected ? ' soc-selected' : ''}` },
            el('button', { type: 'button', class: 'soc-pick', 'aria-pressed': selected ? 'true' : 'false', 'data-focus-key': `pick-${o.id}`, onclick: () => { ui.selectedId = selected ? null : o.id; rerender(); } },
              el('span', { class: `soc-lamp ${o.inTradeRange ? 'soc-lamp-near' : o.sameLocation ? 'soc-lamp-on' : 'soc-lamp-far'}`, 'aria-hidden': 'true' }),
              el('span', { class: 'soc-pick-text' },
                el('span', { class: 'soc-name', text: o.name }),
                el('span', { class: 'soc-meta', text: `${locText}${o.isFriend ? ' · Friend' : ''}${o.blockedByMe ? ' · Blocked' : ''}` }))),
            el('span', { class: 'soc-actions' },
              el('button', {
                type: 'button', class: 'btn btn-small', title: `Whisper ${o.name}`,
                'data-focus-key': `whisper-${o.id}`,
                onclick: () => {
                  ui.channel = 'whisper';
                  ui.whisperTarget = o.name;
                  rerender();
                  container?.querySelector('#soc-chat-text')?.focus();
                },
              }, 'Whisper'),
              !o.isFriend && !o.blockedByMe
                ? el('button', {
                  type: 'button', class: 'btn btn-small', title: `Send friend request to ${o.name}`,
                  onclick: () => act('friends.request', { targetId: o.id }),
                }, 'Friend')
                : null,
              el('button', { type: 'button', class: 'btn btn-small', disabled: inviteBlock ? true : null, title: inviteBlock, 'data-focus-key': `invite-${o.id}`, 'aria-label': `Invite ${o.name} to your party${inviteBlock ? ` (${inviteBlock})` : ''}`, onclick: () => act('party.invite', { targetId: o.id }) }, o.partyMember ? 'Allied' : outgoing ? 'Sent' : 'Invite'),
              el('button', { type: 'button', class: `btn btn-small${!tradeBlock ? ' btn-primary' : ''}`, disabled: tradeBlock ? true : null, title: tradeBlock, 'data-focus-key': `trade-${o.id}`, 'aria-label': `Trade with ${o.name}${tradeBlock ? ` (${tradeBlock})` : ''}`, onclick: () => act('trade.request', { targetId: o.id }) }, 'Trade'),
              !o.blockedByMe
                ? el('button', { type: 'button', class: 'btn btn-small btn-danger', title: `Block ${o.name}`, onclick: () => act('social.block', { targetId: o.id }) }, 'Block')
                : null,
              el('button', {
                type: 'button', class: 'btn btn-small', title: `Report ${o.name}`,
                onclick: () => openReport({ targetId: o.id, targetName: o.name, evidenceType: 'interaction' }),
              }, 'Report')));
        }))
        : el('p', { class: 'soc-note', text: 'No travellers match that filter.' }));
  }

  // ---------------------------------------------------------------- Friends & Blocks tab
  function friendsTabView(s) {
    const c = s.contacts ?? { friends: [], incoming: [], outgoing: [], blocks: [], settings: {}, totalFriends: 0, onlineFriends: 0 };
    syncPrivacyDraft();

    const baseFriends = c.friends ?? [];
    const seen = new Set(baseFriends.map((f) => f.accountKey));
    const combinedFriends = [...baseFriends, ...ui.friendsExtra.filter((f) => !seen.has(f.accountKey))];
    const shownFriends = ui.friendFilter === 'online' ? combinedFriends.filter((f) => f.online) : combinedFriends;

    const addForm = el('form', {
      class: 'soc-inline-form',
      onsubmit: (e) => {
        e.preventDefault();
        const name = ui.addFriendName.trim();
        if (!name) return;
        act('friends.request', { name });
        ui.addFriendName = '';
      },
    },
      el('input', {
        type: 'text', class: 'soc-input-grow', value: ui.addFriendName, maxlength: '32',
        placeholder: 'Exact character or account label…', 'aria-label': 'Add friend by exact name',
        oninput: (e) => (ui.addFriendName = e.target.value),
        onkeydown: (e) => e.stopPropagation(),
      }),
      el('button', { type: 'submit', class: 'btn btn-small btn-primary' }, 'Send Friend Request'));

    const incomingBox = c.incoming?.length
      ? el('div', { class: 'soc-subblock' },
        el('h4', { class: 'soc-h4', text: `Incoming Requests (${c.incoming.length})` }),
        el('ul', { class: 'soc-list' }, c.incoming.map((req) =>
          el('li', { class: 'soc-row soc-invite-row' },
            el('span', { class: 'soc-seal', 'aria-hidden': 'true', text: '✦' }),
            el('span', { class: 'soc-slot-main' },
              el('strong', { class: 'soc-slot-name', text: req.publicLabel }),
              el('span', { class: 'soc-meta', text: req.fromCharacterName ? `Sent as ${req.fromCharacterName}` : 'Account friend request' })),
            el('span', { class: 'soc-actions' },
              el('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => act('friends.accept', { accountKey: req.accountKey }) }, 'Accept'),
              el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('friends.decline', { accountKey: req.accountKey }) }, 'Decline'),
              el('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: () => act('social.block', { accountKey: req.accountKey }) }, 'Block'))))))
      : null;

    const outgoingBox = c.outgoing?.length
      ? el('div', { class: 'soc-subblock' },
        el('h4', { class: 'soc-h4', text: `Pending Sent (${c.outgoing.length})` }),
        el('ul', { class: 'soc-list' }, c.outgoing.map((req) =>
          el('li', { class: 'soc-row' },
            el('span', { class: 'soc-name', text: req.publicLabel }),
            el('span', { class: 'soc-actions' },
              el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('friends.decline', { accountKey: req.accountKey }) }, 'Withdraw'))))))
      : null;

    const filterRow = el('div', { class: 'soc-scopes', role: 'group', 'aria-label': 'Filter friends' },
      [
        ['all', `All (${c.totalFriends ?? combinedFriends.length})`],
        ['online', `Online (${c.onlineFriends ?? combinedFriends.filter((f) => f.online).length})`],
      ].map(([id, label]) => el('button', {
        type: 'button', class: 'soc-scope-btn', 'aria-pressed': String(ui.friendFilter === id),
        onclick: () => { ui.friendFilter = id; rerender(); },
      }, label)));

    const friendsList = shownFriends.length
      ? el('ul', { class: 'soc-list soc-friends-list' }, shownFriends.map((f) =>
        el('li', { class: `soc-row soc-friend-row${f.online ? '' : ' soc-offline'}` },
          el('span', { class: `soc-lamp${f.online ? ' soc-lamp-on' : ''}`, 'aria-hidden': 'true' }),
          el('span', { class: 'soc-slot-main' },
            el('strong', { class: 'soc-slot-name', text: f.publicLabel }),
            el('span', { class: 'soc-meta', text: describeFriendPresence(f) })),
          el('span', { class: 'soc-actions' },
            el('button', {
              type: 'button', class: 'btn btn-small btn-primary',
              onclick: () => {
                ui.tab = 'letters';
                ui.composeMail = { toAccount: f.accountKey, toName: f.publicLabel, subject: '', body: '' };
                rerender();
              },
            }, 'Letter'),
            f.online && f.characterName
              ? el('button', {
                type: 'button', class: 'btn btn-small',
                onclick: () => {
                  ui.tab = 'fellowship';
                  ui.channel = 'whisper';
                  ui.whisperTarget = f.characterName;
                  rerender();
                },
              }, 'Whisper')
              : null,
            el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('friends.remove', { accountKey: f.accountKey }) }, 'Remove'),
            el('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: () => act('social.block', { accountKey: f.accountKey }) }, 'Block'),
            el('button', {
              type: 'button', class: 'btn btn-small',
              onclick: () => openReport({ targetAccount: f.accountKey, targetName: f.publicLabel, evidenceType: 'interaction' }),
            }, 'Report')))))
      : el('p', { class: 'soc-note', text: 'No friends listed yet. Send a request by exact name or from the Travellers roll.' });

    const loadMoreFriends = ui.friendsNextCursor
      ? el('button', {
        type: 'button', class: 'btn btn-small',
        onclick: () => act('friends.list', { cursor: ui.friendsNextCursor, filter: ui.friendFilter }),
      }, 'Load More Friends')
      : null;

    const friendsSec = section('Account Friends', 'friends', `${c.onlineFriends ?? 0} online / ${c.totalFriends ?? 0} total`,
      addForm,
      incomingBox,
      outgoingBox,
      filterRow,
      friendsList,
      loadMoreFriends);

    // Privacy settings & Directed Blocks column
    const pd = ui.privacyDraft ?? {
      publicLabel: c.publicLabel ?? '',
      allowRequests: 'everyone',
      showPresence: 'friends',
      showLastActive: true,
      allowLetters: true,
    };

    const privacyForm = el('form', {
      class: 'soc-privacy-form',
      onsubmit: (e) => {
        e.preventDefault();
        act('friends.settings', {
          publicLabel: pd.publicLabel,
          allowRequests: pd.allowRequests,
          showPresence: pd.showPresence,
          showLastActive: pd.showLastActive,
          allowLetters: pd.allowLetters,
        });
      },
    },
      el('label', { class: 'soc-field' },
        el('span', { class: 'soc-field-label', text: 'Public Identity Label' }),
        el('input', {
          type: 'text', class: 'soc-input-grow', maxlength: '32', value: pd.publicLabel,
          oninput: (e) => (pd.publicLabel = e.target.value),
          onkeydown: (e) => e.stopPropagation(),
        })),
      el('label', { class: 'soc-field' },
        el('span', { class: 'soc-field-label', text: 'Friend Requests' }),
        el('select', {
          class: 'soc-select',
          onchange: (e) => (pd.allowRequests = e.target.value),
        },
          el('option', { value: 'everyone', selected: pd.allowRequests === 'everyone' ? true : null, text: 'Accept from everyone' }),
          el('option', { value: 'none', selected: pd.allowRequests === 'none' ? true : null, text: 'No new requests' }))),
      el('label', { class: 'soc-field' },
        el('span', { class: 'soc-field-label', text: 'Online Presence' }),
        el('select', {
          class: 'soc-select',
          onchange: (e) => (pd.showPresence = e.target.value),
        },
          el('option', { value: 'friends', selected: pd.showPresence === 'friends' ? true : null, text: 'Visible to friends' }),
          el('option', { value: 'hidden', selected: pd.showPresence === 'hidden' ? true : null, text: 'Appear offline to all' }))),
      el('label', { class: 'soc-check' },
        el('input', {
          type: 'checkbox', checked: pd.showLastActive ? true : null,
          onchange: (e) => (pd.showLastActive = e.target.checked),
        }),
        ' Share last-active timestamp with friends'),
      el('label', { class: 'soc-check' },
        el('input', {
          type: 'checkbox', checked: pd.allowLetters ? true : null,
          onchange: (e) => (pd.allowLetters = e.target.checked),
        }),
        ' Allow letters from accepted friends'),
      el('div', { class: 'soc-foot-actions' },
        el('button', { type: 'submit', class: 'btn btn-small btn-primary' }, 'Save Privacy Settings')));

    const privacySec = section('Privacy & Presence', 'privacy', 'Account-wide', privacyForm);

    const blockForm = el('form', {
      class: 'soc-inline-form',
      onsubmit: (e) => {
        e.preventDefault();
        const name = ui.addBlockName.trim();
        if (!name) return;
        act('social.block', { name });
        ui.addBlockName = '';
      },
    },
      el('input', {
        type: 'text', class: 'soc-input-grow', value: ui.addBlockName, maxlength: '32',
        placeholder: 'Exact name to block…', 'aria-label': 'Block player by exact name',
        oninput: (e) => (ui.addBlockName = e.target.value),
        onkeydown: (e) => e.stopPropagation(),
      }),
      el('button', { type: 'submit', class: 'btn btn-small btn-danger' }, 'Block'));

    const blockList = c.blocks?.length
      ? el('ul', { class: 'soc-list' }, c.blocks.map((b) =>
        el('li', { class: 'soc-row' },
          el('span', { class: 'soc-slot-main' },
            el('strong', { class: 'soc-slot-name', text: b.publicLabel }),
            el('span', { class: 'soc-meta', text: `Blocked ${formatRelativeTime(b.blockedAt)}` })),
          el('span', { class: 'soc-actions' },
            el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('social.unblock', { accountKey: b.accountKey }) }, 'Unblock')))))
      : el('p', { class: 'soc-note', text: 'No accounts blocked. Directed blocks take effect immediately on friend requests, letters, whispers, trade, party, visits, and duels without alerting the blocked account.' });

    const blocksSec = section('Directed Blocks', 'blocks', `${c.blocks?.length ?? 0} blocked`, blockForm, blockList);

    return el('div', { class: 'soc-tab-panel', 'data-panel': 'friends' },
      el('div', { class: 'soc-grid' },
        el('div', { class: 'soc-col soc-col-left' }, friendsSec),
        el('div', { class: 'soc-col soc-col-right' }, privacySec, blocksSec)));
  }

  // ---------------------------------------------------------------- Letters / Mailbox tab
  function lettersTabView(s) {
    const mail = s.mail ?? { unreadCount: 0, inbox: [], sent: [], inboxTotal: 0, sentTotal: 0 };
    const friends = s.contacts?.friends ?? [];
    const folder = ui.mailFolder;
    const baseItems = folder === 'sent' ? (mail.sent ?? []) : (mail.inbox ?? []);
    const seen = new Set(baseItems.map((m) => m.id));
    const items = [...baseItems, ...(ui.mailExtra[folder] ?? []).filter((m) => !seen.has(m.id))];
    const nextCursor = ui.mailNextCursor[folder];

    const toolbar = el('div', { class: 'soc-people-tools' },
      el('div', { class: 'soc-scopes', role: 'group', 'aria-label': 'Mailbox folder' },
        el('button', {
          type: 'button', class: 'soc-scope-btn', 'aria-pressed': String(folder === 'inbox'),
          onclick: () => { ui.mailFolder = 'inbox'; rerender(); },
        }, `Inbox${mail.unreadCount ? ` (${mail.unreadCount})` : ''}`),
        el('button', {
          type: 'button', class: 'soc-scope-btn', 'aria-pressed': String(folder === 'sent'),
          onclick: () => { ui.mailFolder = 'sent'; rerender(); },
        }, `Sent (${mail.sentTotal ?? mail.sent?.length ?? 0})`)),
      el('button', {
        type: 'button', class: 'btn btn-small btn-primary',
        onclick: () => {
          ui.composeMail = ui.composeMail
            ? null
            : { toAccount: friends[0]?.accountKey ?? '', toName: friends[0]?.publicLabel ?? '', subject: '', body: '' };
          rerender();
        },
      }, ui.composeMail ? 'Close Composer' : 'Compose Letter'));

    const composeForm = ui.composeMail
      ? el('form', {
        class: 'soc-mail-compose',
        onsubmit: (e) => {
          e.preventDefault();
          const cm = ui.composeMail;
          if (!cm.body.trim()) { say('Write a letter message first.'); return; }
          act('mail.send', {
            ...(cm.toAccount ? { toAccount: cm.toAccount } : { toName: cm.toName }),
            subject: cm.subject,
            body: cm.body,
            requestId: `ltr_${Date.now()}_${++mailReqSeq}`,
          });
        },
      },
        el('h4', { class: 'soc-h4', text: 'New Plain-Text Letter (Friends Only)' }),
        friends.length
          ? el('select', {
            class: 'soc-select',
            'aria-label': 'Letter recipient',
            onchange: (e) => {
              ui.composeMail.toAccount = e.target.value;
              const match = friends.find((f) => f.accountKey === e.target.value);
              ui.composeMail.toName = match?.publicLabel ?? '';
            },
          }, friends.map((f) => el('option', {
            value: f.accountKey,
            selected: ui.composeMail.toAccount === f.accountKey ? true : null,
            text: `${f.publicLabel}${f.online ? ' (Online)' : ' (Offline delivery)'}`,
          })))
          : el('input', {
            type: 'text', class: 'soc-input-grow', value: ui.composeMail.toName, placeholder: 'Accepted friend name…',
            oninput: (e) => { ui.composeMail.toName = e.target.value; ui.composeMail.toAccount = ''; },
            onkeydown: (e) => e.stopPropagation(),
          }),
        el('input', {
          type: 'text', class: 'soc-input-grow', maxlength: '80', value: ui.composeMail.subject,
          placeholder: 'Subject (optional, max 80 chars)…', 'aria-label': 'Letter subject',
          oninput: (e) => (ui.composeMail.subject = e.target.value),
          onkeydown: (e) => e.stopPropagation(),
        }),
        el('textarea', {
          class: 'soc-textarea', rows: '4', maxlength: '800', value: ui.composeMail.body,
          placeholder: 'Write your plain-text letter (max 800 characters)…', 'aria-label': 'Letter body',
          oninput: (e) => (ui.composeMail.body = e.target.value),
          onkeydown: (e) => e.stopPropagation(),
        }),
        el('div', { class: 'soc-foot-actions' },
          el('button', { type: 'submit', class: 'btn btn-small btn-primary' }, 'Seal & Send Letter'),
          el('button', { type: 'button', class: 'btn btn-small', onclick: () => { ui.composeMail = null; rerender(); } }, 'Cancel')))
      : null;

    const listEl = items.length
      ? el('ul', { class: 'soc-list soc-mail-list' }, items.map((m) => {
        const active = ui.activeThread?.threadId === m.threadId;
        const who = folder === 'sent'
          ? `To ${m.toLabel}${m.toCharName && m.toCharName !== m.toLabel ? ` (${m.toCharName})` : ''}`
          : `From ${m.fromLabel}${m.fromCharName && m.fromCharName !== m.fromLabel ? ` (${m.fromCharName})` : ''}`;
        return el('li', { class: `soc-row soc-mail-row${m.unread ? ' is-unread' : ''}${active ? ' soc-selected' : ''}` },
          el('button', {
            type: 'button', class: 'soc-pick',
            onclick: () => act('mail.thread', { threadId: m.threadId, markRead: true }),
          },
            el('span', { class: `soc-lamp${m.unread ? ' soc-lamp-near' : ''}`, 'aria-hidden': 'true' }),
            el('span', { class: 'soc-pick-text' },
              el('span', { class: 'soc-name', text: m.subject }),
              el('span', { class: 'soc-meta', text: `${who} · ${formatRelativeTime(m.createdAt)}` }))),
          el('span', { class: 'soc-actions' },
            el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('mail.thread', { threadId: m.threadId, markRead: true }) }, 'Read'),
            el('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: () => act('mail.delete', { letterId: m.id }) }, 'Delete')));
      }))
      : el('p', { class: 'soc-note', text: folder === 'inbox' ? 'Your account mailbox is empty. Letters from accepted friends arrive here even while you are offline.' : 'You have not sent any letters yet.' });

    const loadMoreBtn = nextCursor
      ? el('button', {
        type: 'button', class: 'btn btn-small',
        onclick: () => act('mail.list', { folder, cursor: nextCursor }),
      }, 'Load Older Letters')
      : null;

    const listSec = section('Account Mailbox', 'mail', `${mail.unreadCount ?? 0} unread`,
      toolbar,
      composeForm,
      listEl,
      loadMoreBtn);

    const threadSec = threadView();

    return el('div', { class: 'soc-tab-panel', 'data-panel': 'letters' },
      el('div', { class: 'soc-grid' },
        el('div', { class: 'soc-col soc-col-left' }, listSec),
        el('div', { class: 'soc-col soc-col-right' }, threadSec)));
  }

  function threadView() {
    const th = ui.activeThread;
    if (!th) {
      return section('Letter Thread', 'thread', 'Plain text',
        el('div', { class: 'soc-quiet' },
          el('p', { class: 'soc-quiet-title', text: 'Select a letter to read its thread.' }),
          el('p', { class: 'soc-note', text: 'Letters are delivered per account, survive server restarts and character switches, and render strictly as plain text.' })));
    }
    const lastMsg = th.messages[th.messages.length - 1];
    const replyForm = th.canReply && lastMsg
      ? el('form', {
        class: 'soc-reply-form',
        onsubmit: (e) => {
          e.preventDefault();
          const body = ui.mailReply.trim();
          if (!body) return;
          act('mail.send', {
            replyToId: lastMsg.id,
            body,
            requestId: `rep_${Date.now()}_${++mailReqSeq}`,
          });
          ui.mailReply = '';
        },
      },
        el('textarea', {
          class: 'soc-textarea', rows: '3', maxlength: '800', value: ui.mailReply,
          placeholder: `Reply to ${th.otherLabel}…`, 'aria-label': 'Reply text',
          oninput: (e) => (ui.mailReply = e.target.value),
          onkeydown: (e) => e.stopPropagation(),
        }),
        el('div', { class: 'soc-foot-actions' },
          el('button', { type: 'submit', class: 'btn btn-small btn-primary' }, 'Send Reply')))
      : el('p', { class: 'soc-note', text: 'Replies are only available while you are accepted friends.' });

    return section(th.subject, 'thread', `${th.messages.length} letter${th.messages.length === 1 ? '' : 's'}`,
      el('ul', { class: 'soc-thread-list' }, th.messages.map((m) =>
        el('li', { class: `soc-letter-card${m.direction === 'sent' ? ' is-sent' : ''}` },
          el('header', { class: 'soc-letter-meta' },
            el('strong', { text: `${m.fromLabel}${m.fromCharName && m.fromCharName !== m.fromLabel ? ` (${m.fromCharName})` : ''}` }),
            el('span', { class: 'soc-meta', text: `${formatRelativeTime(m.createdAt)}${m.readAt ? ' · Read' : m.direction === 'inbox' ? ' · Unread' : ''}` })),
          el('p', { class: 'soc-letter-body', text: m.body }),
          el('div', { class: 'soc-letter-actions' },
            m.direction === 'inbox' && !m.readAt
              ? el('button', { type: 'button', class: 'btn btn-small', onclick: () => act('mail.read', { letterId: m.id }) }, 'Mark Read')
              : null,
            el('button', {
              type: 'button', class: 'btn btn-small',
              onclick: () => openReport({
                targetAccount: m.direction === 'inbox' ? m.fromAccount : m.toAccount,
                targetName: m.direction === 'inbox' ? m.fromLabel : m.toLabel,
                evidenceType: 'letter',
                evidenceId: m.id,
                evidenceExcerpt: `${m.subject}: ${m.body.slice(0, 120)}`,
              }),
            }, 'Report'),
            el('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: () => act('mail.delete', { letterId: m.id }) }, 'Delete'))))),
      replyForm);
  }

  // ---------------------------------------------------------------- Moderation report drawer
  function openReport(draft) {
    ui.reportDraft = {
      targetId: draft.targetId ?? null,
      targetAccount: draft.targetAccount ?? null,
      targetName: draft.targetName ?? 'Traveller',
      evidenceType: draft.evidenceType ?? 'interaction',
      evidenceId: draft.evidenceId ?? null,
      evidenceExcerpt: draft.evidenceExcerpt ?? '',
      category: 'harassment',
      reason: '',
    };
    rerender();
  }

  function reportDrawerView() {
    const rd = ui.reportDraft;
    return section(`Report ${rd.targetName}`, 'report', `Evidence: ${rd.evidenceType}`,
      rd.evidenceExcerpt ? el('p', { class: 'soc-pending-note', text: `Selected record: ${rd.evidenceExcerpt}` }) : null,
      el('form', {
        class: 'soc-privacy-form',
        onsubmit: (e) => {
          e.preventDefault();
          act('social.report', {
            ...(rd.targetId != null ? { targetId: rd.targetId } : {}),
            ...(rd.targetAccount ? { targetAccount: rd.targetAccount } : {}),
            ...(rd.targetName ? { targetName: rd.targetName } : {}),
            category: rd.category,
            reason: rd.reason,
            evidenceType: rd.evidenceType,
            ...(rd.evidenceId ? { evidenceId: rd.evidenceId } : {}),
            ...(rd.evidenceExcerpt ? { evidenceExcerpt: rd.evidenceExcerpt } : {}),
          });
        },
      },
        el('label', { class: 'soc-field' },
          el('span', { class: 'soc-field-label', text: 'Category' }),
          el('select', {
            class: 'soc-select',
            onchange: (e) => (rd.category = e.target.value),
          }, REPORT_CATEGORIES.map(([v, label]) => el('option', { value: v, selected: rd.category === v ? true : null, text: label })))),
        el('textarea', {
          class: 'soc-textarea', rows: '2', maxlength: '300', value: rd.reason,
          placeholder: 'Describe what happened for moderator review…', 'aria-label': 'Report reason',
          oninput: (e) => (rd.reason = e.target.value),
          onkeydown: (e) => e.stopPropagation(),
        }),
        el('div', { class: 'soc-foot-actions' },
          el('button', { type: 'submit', class: 'btn btn-small btn-danger' }, 'Submit Report'),
          el('button', { type: 'button', class: 'btn btn-small', onclick: () => { ui.reportDraft = null; rerender(); } }, 'Cancel'))));
  }

  // ---------------------------------------------------------------- Trade & Herald
  function tradeView(s) {
    const t = s.trade;
    if (!t) return null;
    const cancel = (label = 'Cancel Trade') => el('button', { type: 'button', class: 'btn btn-small btn-danger', 'data-focus-key': 'trade-cancel', onclick: () => act('trade.cancel', { tradeId: t.id }) }, label);
    if (t.state === 'pending') {
      if (t.initiator) {
        return section(`Barter with ${t.partner.name}`, 'trade', 'Awaiting reply',
          el('p', { class: 'soc-note', text: `Waiting for ${t.partner.name} to approach the trade counter…` }),
          el('div', { class: 'soc-foot-actions' }, cancel('Withdraw Request')));
      }
      return section(`Barter Request from ${t.partner.name}`, 'trade', 'Incoming',
        el('p', { class: 'soc-note', text: `${t.partner.name} wishes to barter gold and goods with you.` }),
        el('div', { class: 'soc-foot-actions' },
          el('button', { type: 'button', class: 'btn btn-small btn-primary', 'data-focus-key': 'trade-accept', onclick: () => act('trade.accept', { tradeId: t.id }) }, 'Open Trade Counter'),
          el('button', { type: 'button', class: 'btn btn-small', 'data-focus-key': 'trade-decline', onclick: () => act('trade.decline', { tradeId: t.id }) }, 'Decline')));
    }
    const ch = character();
    const draft = ui.draft;
    const dirty = Boolean(draft) && !draftMatches(draft, t.mine, ch);
    const items = tradeableItems(ch);
    const maxGold = ch?.gold ?? 0;

    const mine = el('fieldset', { class: 'soc-offer soc-mine' },
      el('legend', { text: 'Your Offer' }),
      items.length
        ? el('ul', { class: 'soc-items' }, items.map((it) => {
          const id = String(it.id);
          const qty = draft?.items.get(id) ?? 0;
          const max = it.quantity ?? 1;
          const inputId = `soc-q-${id}`;
          const setQty = (val) => {
            const clamped = Math.max(0, Math.min(max, Math.floor(Number(val) || 0)));
            draft.items.set(id, clamped);
            const inp = container?.querySelector(`#${CSS.escape(inputId)}`);
            if (inp && Number(inp.value) !== clamped) inp.value = String(clamped);
            updateTradeButtons();
          };
          return el('li', { class: `soc-item${qty > 0 ? ' soc-item-offered' : ''}` },
            el('label', { for: inputId, class: 'soc-item-name' }, itemIcon(api, it), max > 1 ? `${it.name} (${max})` : it.name),
            el('span', { class: 'soc-stepper' },
              el('button', { type: 'button', class: 'soc-step-btn', 'aria-label': `Decrease ${it.name}`, onclick: () => setQty((draft.items.get(id) ?? 0) - 1) }, '−'),
              el('input', {
                id: inputId, type: 'number', min: '0', max: String(max), step: '1', inputmode: 'numeric', value: String(qty), class: 'soc-qty',
                'aria-label': `Quantity of ${it.name} to offer, up to ${max}`,
                oninput: (e) => { draft.items.set(id, Math.max(0, Math.min(max, Math.floor(Number(e.target.value) || 0)))); updateTradeButtons(); },
              }),
              el('button', { type: 'button', class: 'soc-step-btn', 'aria-label': `Increase ${it.name}`, onclick: () => setQty((draft.items.get(id) ?? 0) + 1) }, '+')));
        }))
        : el('p', { class: 'soc-note', text: 'Nothing in your pack can be traded. Unequip an item to offer it.' }),
      el('div', { class: 'soc-gold' },
        el('label', { for: 'soc-gold' }, itemIcon(api, { template: 'gold' }), `Gold (purse: ${maxGold})`),
        el('input', {
          id: 'soc-gold', type: 'number', min: '0', max: String(maxGold), step: '1', inputmode: 'numeric',
          value: String(draft?.gold ?? 0), class: 'soc-qty soc-gold-input',
          oninput: (e) => { draft.gold = Math.max(0, Math.min(maxGold, Math.floor(Number(e.target.value) || 0))); updateTradeButtons(); },
        })),
      el('div', { class: 'soc-offer-bar' },
        el('button', { type: 'button', class: 'btn btn-small', id: 'soc-update', disabled: dirty ? null : true, onclick: () => act('trade.offer', { tradeId: t.id, revision: t.revision, ...draftToArgs(draft, ch) }) }, 'Place on Table'),
        el('span', { class: `soc-seal-state${t.mine.confirmed ? ' soc-ok' : ''}`, text: t.mine.confirmed ? 'Sealed by you' : 'Unsealed' })),
      el('p', { class: 'soc-offer-now', text: `On the table: ${describeOffer(t.mine)}` }));

    const theirs = el('section', { class: 'soc-offer soc-theirs', 'aria-label': `${t.partner.name}'s offer` },
      el('h4', { class: 'soc-h4', text: `${t.partner.name} Places` }),
      t.theirs.items.length || t.theirs.gold
        ? el('ul', { class: 'soc-items' }, [
          ...t.theirs.items.map((i) => el('li', { class: 'soc-item soc-item-offered' }, el('span', { class: 'soc-item-name' }, itemIcon(api, i), i.quantity > 1 ? `${i.name} ×${i.quantity}` : i.name))),
          t.theirs.gold ? el('li', { class: 'soc-item soc-item-offered' }, el('span', { class: 'soc-item-name' }, itemIcon(api, { template: 'gold' }), `${t.theirs.gold} gold`)) : null,
        ])
        : el('p', { class: 'soc-note', text: 'Nothing placed on the table yet.' }),
      el('div', { class: 'soc-offer-bar' },
        el('span', { class: `soc-seal-state${t.theirs.confirmed ? ' soc-ok' : ''}`, text: t.theirs.confirmed ? `Sealed by ${t.partner.name}` : `Awaiting ${t.partner.name}’s seal` })));

    const why = confirmBlock(t, dirty);
    return section(`Merchant’s Counter — ${t.partner.name}`, 'trade', `Offer #${t.revision}`,
      el('p', { class: 'soc-note', text: 'Both travellers must seal the same offer. Any change breaks both seals.' }),
      el('div', { class: 'soc-trade-grid' }, mine, theirs),
      el('div', { class: 'soc-foot-actions' },
        el('button', {
          type: 'button', class: 'btn btn-small btn-primary', id: 'soc-confirm', disabled: why ? true : null, title: why,
          'aria-describedby': 'soc-confirm-why',
          onclick: () => act('trade.confirm', { tradeId: t.id, revision: t.revision }),
        }, 'Seal & Confirm Trade'),
        cancel(),
        el('span', { class: 'soc-note', id: 'soc-confirm-why', text: why ?? `Ready to seal offer #${t.revision}.` })));
  }

  function updateTradeButtons() {
    const t = ui.social?.trade;
    if (!container || !t || !ui.draft) return;
    const dirty = !draftMatches(ui.draft, t.mine, character());
    const upd = container.querySelector('#soc-update');
    const conf = container.querySelector('#soc-confirm');
    const why = container.querySelector('#soc-confirm-why');
    if (upd) upd.disabled = !dirty;
    const reason = confirmBlock(t, dirty);
    if (conf) {
      conf.disabled = Boolean(reason);
      conf.title = reason ?? '';
    }
    if (why) why.textContent = reason ?? `Ready to seal offer #${t.revision}.`;
  }

  function confirmBlock(t, dirty) {
    const nothing = !t.mine.items.length && !t.mine.gold && !t.theirs.items.length && !t.theirs.gold;
    return dirty ? 'Place your updated offer on the table first.' : nothing ? 'Nothing has been offered yet.' : t.mine.confirmed ? 'Waiting for your partner to seal.' : null;
  }

  function composeView(s) {
    const inParty = Boolean(s.party);
    if (!inParty && ui.channel === 'party') ui.channel = 'region';
    const send = (e) => {
      e.preventDefault();
      const text = ui.compose.replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (ui.channel === 'whisper') {
        const target = ui.whisperTarget.trim();
        if (!target) { say('Enter a traveller’s name to whisper.'); return; }
        act('chat.send', { channel: 'whisper', target, text });
      } else {
        act('chat.send', { channel: ui.channel, text });
      }
      ui.compose = '';
      const box = container?.querySelector('#soc-chat-text');
      if (box) box.value = '';
    };

    const channels = [
      { id: 'say', label: 'Nearby', title: 'Speak to travellers within ~24 m' },
      { id: 'shout', label: 'Shout', title: 'Shout across the local area' },
      { id: 'party', label: 'Party', title: 'Fellowship channel (/p)', disabled: !inParty },
      { id: 'region', label: s.region || 'Region', title: 'Region-wide herald (/r)' },
      { id: 'global', label: 'Realm', title: 'All of Iliac Bay (/g)' },
      { id: 'whisper', label: 'Whisper', title: 'Private whisper (/w)' },
    ];

    return section('Herald & Dispatches', 'compose', s.region || 'Iliac Bay',
      el('div', { class: 'soc-channels', role: 'group', 'aria-label': 'Message channel' },
        channels.map((ch) => el('button', {
          type: 'button',
          class: 'soc-ch-btn',
          'aria-pressed': String(ui.channel === ch.id),
          disabled: ch.disabled ? true : null,
          title: ch.disabled ? 'Join a fellowship to use Party chat' : ch.title,
          onclick: () => { ui.channel = ch.id; rerender(); container?.querySelector('#soc-chat-text')?.focus(); },
        }, ch.label))),
      el('ul', { class: 'soc-feed', 'aria-label': 'Recent messages' }),
      el('form', { class: 'soc-compose-form', onsubmit: send },
        ui.channel === 'whisper'
          ? el('input', {
            id: 'soc-whisper-to', type: 'text', class: 'soc-whisper-input', maxlength: '24', autocomplete: 'off',
            value: ui.whisperTarget, placeholder: 'To traveller…', 'aria-label': 'Whisper recipient',
            oninput: (e) => (ui.whisperTarget = e.target.value),
            onkeydown: (e) => e.stopPropagation(),
          })
          : null,
        el('label', { for: 'soc-chat-text', class: 'soc-visually-hidden', text: 'Message' }),
        el('input', {
          id: 'soc-chat-text', type: 'text', maxlength: '200', autocomplete: 'off',
          value: ui.compose,
          placeholder: ui.channel === 'whisper' ? 'Whisper privately…' : `Speak to ${channels.find((c) => c.id === ui.channel)?.label ?? 'channel'}…`,
          oninput: (e) => (ui.compose = e.target.value),
          onkeydown: (e) => e.stopPropagation(),
        }),
        el('button', { type: 'submit', class: 'btn btn-small btn-primary' }, 'Send')),
      el('p', { class: 'soc-cmds' },
        el('span', { text: 'Quick commands: ' }),
        ...['/yell', '/p', '/r', '/g', '/w', '/me'].map((c) => el('kbd', { text: c }))));
  }

  api.registerPanel('party', 'Party, Friends & Letters', render);
  return { ui };
}
