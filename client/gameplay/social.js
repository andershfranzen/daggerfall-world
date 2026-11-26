// Party & trade screen (panel `party`, key O) and party/region/global chat channels.
// Server rules: server/rpg/social.js. All state comes from `{kind:'social', social}` events;
// every button sends one server action and the panel re-renders from the server's reply.
import { getItemArtSource, itemIcon } from './inventory/icons.js';
import { CHAT_HELP_SUMMARY, describeOffer, draftFrom, draftMatches, draftToArgs, parseChatInput, tradeableItems } from './social/model.js';

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
    social: null,
    selectedId: null,
    draft: null, // {tradeId, revision, items: Map, gold}
    channel: 'region',
    whisperTarget: '',
    compose: '',
    scope: 'all', // 'all' | 'region' | 'near'
    search: '',
    recentChat: [], // last 20 dispatches {channel, name, toName, text, self, region}
    status: '',
    synced: false,
  };
  let container = null;

  const character = () => api.state?.character ?? null;
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

  // ---------------------------------------------------------------- server events
  api.on('event', (ev) => {
    if (!ev) return;
    if (ev.kind === 'social') {
      if (ev.social) ui.social = ev.social;
      syncDraft();
      if (ev.text) {
        ev.silent = true;
        api.message(ev.text);
        say(ev.text);
      }
      if ((ev.invite || ev.tradeRequest) && api.panel !== 'party') api.message('Press O to open Party & Trade.');
      rerender();
    } else if (ev.kind === 'chat' && ev.channel) {
      chatLine(ev);
      if (container?.isConnected) renderRecentFeed();
    }
  });
  api.on('state', () => {
    if (!ui.synced && api.state) {
      ui.synced = true;
      act('social.sync');
    }
  });
  api.on('screen', (s) => {
    if (s !== 'game') { ui.synced = false; ui.recentChat.length = 0; }
  });
  api.on('panel', (p) => {
    if (p?.id === 'party' && p.open) act('social.sync');
  });
  api.on('panelDetail', (d) => {
    if (d?.id === 'party' && d.detail?.targetId != null) {
      ui.selectedId = Number(d.detail.targetId);
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
    const invites = invitesView(s);
    const trade = tradeView(s);
    const leftCol = el('div', { class: 'soc-col soc-col-left' },
      partyView(s),
      !s.trade ? satchelView(s) : null,
    );
    const rightCol = el('div', { class: 'soc-col soc-col-right' },
      peopleView(s),
      composeView(s),
    );
    root.replaceChildren(...[
      live,
      invites,
      trade,
      el('div', { class: 'soc-grid' }, leftCol, rightCol),
    ].filter(Boolean));
    renderRecentFeed();
  }

  function section(title, cls, badge, ...kids) {
    const id = `soc-h-${cls}`;
    return el('section', { class: `soc-sec soc-${cls}`, 'aria-labelledby': id },
      el('header', { class: 'soc-sec-head' },
        el('h3', { class: 'soc-h', id, text: title }),
        badge ? el('span', { class: 'soc-head-badge', text: badge }) : null),
      ...kids);
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
        el('p', { class: 'soc-note', text: 'Invite travellers from the roll to share dungeon delves, split kills, and speak over Party chat (/p).' }));
    }

    const self = api.state?.selfId;
    const lead = p.leaderId === self;
    const rows = p.members.map((m) => {
      const me = m.id === self;
      const isLeader = m.id === p.leaderId;
      return el('li', { class: `soc-slot${me ? ' soc-slot-self' : ''}${m.online ? '' : ' soc-offline'}` },
        el('span', { class: `soc-lamp${m.online ? ' soc-lamp-on' : ''}`, 'aria-hidden': 'true' }),
        el('span', { class: 'soc-slot-main' },
          el('span', { class: 'soc-slot-name' }, m.name, me ? ' (you)' : ''),
          el('span', { class: 'soc-meta', text: m.online ? (m.location || 'Online') : 'Offline' })),
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
    return section('Fellowship', 'party', `${p.members.length} / ${p.max}`,
      el('ul', { class: 'soc-slots' }, rows),
      pending,
      el('div', { class: 'soc-foot-actions' },
        el('button', { type: 'button', class: 'btn btn-small btn-danger', 'data-focus-key': 'leave', onclick: () => act('party.leave') }, 'Leave Fellowship')));
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
    const lead = !s.party || s.party.leaderId === api.state?.selfId;
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
          el('p', { class: 'soc-note', text: `No other adventurers are currently online. When travellers enter ${s.region || 'the realm'}, you can hail them, form a fellowship, or barter goods here.` })));
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
                el('span', { class: 'soc-meta', text: locText }))),
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
              el('button', { type: 'button', class: 'btn btn-small', disabled: inviteBlock ? true : null, title: inviteBlock, 'data-focus-key': `invite-${o.id}`, 'aria-label': `Invite ${o.name} to your party${inviteBlock ? ` (${inviteBlock})` : ''}`, onclick: () => act('party.invite', { targetId: o.id }) }, o.partyMember ? 'Allied' : outgoing ? 'Sent' : 'Invite'),
              el('button', { type: 'button', class: `btn btn-small${!tradeBlock ? ' btn-primary' : ''}`, disabled: tradeBlock ? true : null, title: tradeBlock, 'data-focus-key': `trade-${o.id}`, 'aria-label': `Trade with ${o.name}${tradeBlock ? ` (${tradeBlock})` : ''}`, onclick: () => act('trade.request', { targetId: o.id }) }, 'Trade')));
        }))
        : el('p', { class: 'soc-note', text: 'No travellers match that filter.' }));
  }

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

  api.registerPanel('party', 'Party & Trade', render);
  return { ui };
}
