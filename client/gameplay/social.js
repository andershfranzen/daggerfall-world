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
    channel: 'party',
    compose: '',
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
        // main.js toasts event text unless a feature marks it silent; toast it once, here.
        ev.silent = true;
        api.message(ev.text);
        say(ev.text);
      }
      if ((ev.invite || ev.tradeRequest) && api.panel !== 'party') api.message('Press O to open Party & Trade.');
      rerender();
    } else if (ev.kind === 'chat' && ev.channel) {
      chatLine(ev);
    }
  });
  // Ask for a fresh view on (re)connection; the server also pushes on join.
  api.on('state', () => {
    if (!ui.synced && api.state) {
      ui.synced = true;
      act('social.sync');
    }
  });
  api.on('screen', (s) => {
    if (s !== 'game') ui.synced = false;
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
    // A new trade, or the server accepted a new version of my side: start from the server copy.
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
      input.placeholder = 'Speak nearby · /yell or /msg to shout · /help';
      input.title = 'Plain text speaks nearby (~24 m). Start with / or /yell to shout across the area. /p, /r, /g, /w, /me, /help.';
    }
  }

  // ---------------------------------------------------------------- rendering
  function render(root) {
    container = root;
    syncDraft();
    const s = ui.social;
    root.classList.add('soc-root');
    const body = [el('p', { class: 'soc-live', role: 'status', 'aria-live': 'polite', text: ui.status })];
    if (!s) {
      body.push(el('p', { class: 'soc-empty', text: 'Gathering news of other travellers…' }));
      root.replaceChildren(...body);
      return;
    }
    body.push(invitesView(s), tradeView(s), partyView(s), peopleView(s), composeView(s));
    root.replaceChildren(...body.filter(Boolean));
  }

  function section(title, cls, ...kids) {
    const id = `soc-h-${cls}`;
    return el('section', { class: `soc-sec soc-${cls}`, 'aria-labelledby': id }, el('h3', { class: 'soc-h', id, text: title }), ...kids);
  }

  function invitesView(s) {
    if (!s.invites?.length) return null;
    return section('Invitations', 'invites', el('ul', { class: 'soc-list' }, s.invites.map((inv) =>
      el('li', { class: 'soc-row' },
        el('span', { class: 'soc-name', text: `${inv.fromName} invites you to their party.` }),
        el('span', { class: 'soc-actions' },
          el('button', { type: 'button', class: 'btn btn-primary', 'data-focus-key': `inv-accept-${inv.fromId}`, onclick: () => act('party.accept', { fromId: inv.fromId }) }, 'Accept'),
          el('button', { type: 'button', class: 'btn', 'data-focus-key': `inv-decline-${inv.fromId}`, onclick: () => act('party.decline', { fromId: inv.fromId }) }, 'Decline'))))));
  }

  function partyView(s) {
    const p = s.party;
    if (!p) {
      const pending = s.outgoing?.length ? el('p', { class: 'soc-note', text: `Invitation pending: ${s.outgoing.map((o) => o.toName).join(', ')}.` }) : null;
      return section('Party', 'party', el('p', { class: 'soc-note', text: 'You travel alone. Choose someone below and invite them.' }), pending);
    }
    const self = api.state?.selfId;
    const lead = p.leaderId === self;
    return section(`Party (${p.members.length}/${p.max})`, 'party',
      el('ul', { class: 'soc-list' }, p.members.map((m) => {
        const me = m.id === self;
        return el('li', { class: `soc-row${m.online ? '' : ' soc-offline'}` },
          el('span', { class: 'soc-name' }, m.name, me ? ' (you)' : '', m.id === p.leaderId ? el('span', { class: 'soc-badge', text: 'Leader' }) : null),
          el('span', { class: 'soc-meta', text: m.online ? m.location ?? '' : 'Offline' }),
          lead && !me
            ? el('span', { class: 'soc-actions' },
              el('button', { type: 'button', class: 'btn', 'data-focus-key': `promote-${m.id}`, onclick: () => act('party.promote', { targetId: m.id }), 'aria-label': `Make ${m.name} leader` }, 'Make leader'),
              el('button', { type: 'button', class: 'btn btn-danger', 'data-focus-key': `kick-${m.id}`, onclick: () => act('party.kick', { targetId: m.id }), 'aria-label': `Remove ${m.name} from the party` }, 'Remove'))
            : null);
      })),
      el('div', { class: 'soc-actions' },
        el('button', { type: 'button', class: 'btn', 'data-focus-key': 'leave', onclick: () => act('party.leave') }, 'Leave party')));
  }

  function peopleView(s) {
    const lead = !s.party || s.party.leaderId === api.state?.selfId;
    const full = s.party && s.party.members.length >= s.party.max;
    const busy = Boolean(s.trade);
    if (!s.players?.length) return section('Travellers', 'people', el('p', { class: 'soc-note', text: 'No one else is in the world right now.' }));
    return section('Travellers', 'people',
      el('p', { class: 'soc-note', text: `Trading needs you both in the same place, within ${s.tradeRange} paces.` }),
      el('ul', { class: 'soc-list', role: 'list' }, s.players.map((o) => {
        const selected = ui.selectedId === o.id;
        const outgoing = s.outgoing?.some((x) => x.toId === o.id);
        const inviteBlock = !lead ? 'Only the leader can invite' : o.partyMember ? 'In your party' : o.inParty ? 'In another party' : full ? 'Party is full' : outgoing ? 'Invitation sent' : null;
        const tradeBlock = busy ? 'Finish your current trade' : o.busy ? 'Busy trading' : !o.sameLocation ? `In ${o.region}` : !o.inTradeRange ? 'Too far to trade' : null;
        return el('li', { class: `soc-row${selected ? ' soc-selected' : ''}` },
          el('button', { type: 'button', class: 'soc-pick', 'aria-pressed': selected ? 'true' : 'false', 'data-focus-key': `pick-${o.id}`, onclick: () => { ui.selectedId = selected ? null : o.id; rerender(); } },
            el('span', { class: 'soc-name', text: o.name }),
            el('span', { class: 'soc-meta', text: o.sameLocation ? (o.inTradeRange ? 'Beside you' : 'Nearby') : o.region })),
          el('span', { class: 'soc-actions' },
            el('button', { type: 'button', class: 'btn', disabled: inviteBlock ? true : null, title: inviteBlock, 'data-focus-key': `invite-${o.id}`, 'aria-label': `Invite ${o.name} to your party${inviteBlock ? ` (${inviteBlock})` : ''}`, onclick: () => act('party.invite', { targetId: o.id }) }, 'Invite'),
            el('button', { type: 'button', class: 'btn', disabled: tradeBlock ? true : null, title: tradeBlock, 'data-focus-key': `trade-${o.id}`, 'aria-label': `Trade with ${o.name}${tradeBlock ? ` (${tradeBlock})` : ''}`, onclick: () => act('trade.request', { targetId: o.id }) }, 'Trade')));
      })));
  }

  function tradeView(s) {
    const t = s.trade;
    if (!t) return null;
    const cancel = (label = 'Cancel trade') => el('button', { type: 'button', class: 'btn', 'data-focus-key': 'trade-cancel', onclick: () => act('trade.cancel', { tradeId: t.id }) }, label);
    if (t.state === 'pending') {
      if (t.initiator) {
        return section(`Trade with ${t.partner.name}`, 'trade', el('p', { class: 'soc-note', text: `Waiting for ${t.partner.name} to accept…` }), el('div', { class: 'soc-actions' }, cancel('Withdraw request')));
      }
      return section(`Trade with ${t.partner.name}`, 'trade',
        el('p', { class: 'soc-note', text: `${t.partner.name} wants to trade with you.` }),
        el('div', { class: 'soc-actions' },
          el('button', { type: 'button', class: 'btn btn-primary', 'data-focus-key': 'trade-accept', onclick: () => act('trade.accept', { tradeId: t.id }) }, 'Accept'),
          el('button', { type: 'button', class: 'btn', 'data-focus-key': 'trade-decline', onclick: () => act('trade.decline', { tradeId: t.id }) }, 'Decline')));
    }
    const ch = character();
    const draft = ui.draft;
    const dirty = Boolean(draft) && !draftMatches(draft, t.mine, ch);

    const items = tradeableItems(ch);
    const mine = el('fieldset', { class: 'soc-offer soc-mine' },
      el('legend', { text: 'Your offer' }),
      items.length
        ? el('ul', { class: 'soc-items' }, items.map((it) => {
          const id = String(it.id);
          const qty = draft?.items.get(id) ?? 0;
          const max = it.quantity ?? 1;
          const inputId = `soc-q-${id}`;
          return el('li', { class: 'soc-item' },
            el('label', { for: inputId, class: 'soc-item-name' }, itemIcon(api, it), max > 1 ? `${it.name} (${max})` : it.name),
            el('input', {
              id: inputId, type: 'number', min: '0', max: String(max), step: '1', inputmode: 'numeric', value: String(qty), class: 'soc-qty',
              'aria-label': `Quantity of ${it.name} to offer, up to ${max}`,
              oninput: (e) => { draft.items.set(id, Math.max(0, Math.min(max, Math.floor(Number(e.target.value) || 0)))); updateTradeButtons(); },
            }));
        }))
        : el('p', { class: 'soc-note', text: 'Nothing in your pack can be traded. Unequip an item to offer it.' }),
      el('div', { class: 'soc-gold' },
        el('label', { for: 'soc-gold' }, itemIcon(api, { template: 'gold' }), `Gold (you carry ${ch?.gold ?? 0})`),
        el('input', { id: 'soc-gold', type: 'number', min: '0', max: String(ch?.gold ?? 0), step: '1', inputmode: 'numeric', value: String(draft?.gold ?? 0), class: 'soc-qty',
          oninput: (e) => { draft.gold = Math.max(0, Math.min(ch?.gold ?? 0, Math.floor(Number(e.target.value) || 0))); updateTradeButtons(); } })),
      el('div', { class: 'soc-actions' },
        el('button', { type: 'button', class: 'btn', id: 'soc-update', disabled: dirty ? null : true, onclick: () => act('trade.offer', { tradeId: t.id, revision: t.revision, ...draftToArgs(draft, ch) }) }, 'Update offer')),
      el('p', { class: 'soc-offer-now', text: `On the table: ${describeOffer(t.mine)}` }),
      el('p', { class: `soc-confirm-state${t.mine.confirmed ? ' soc-ok' : ''}`, text: t.mine.confirmed ? 'You confirmed.' : 'Not confirmed.' }));

    const theirs = el('section', { class: 'soc-offer soc-theirs', 'aria-label': `${t.partner.name}'s offer` },
      el('h4', { class: 'soc-h4', text: `${t.partner.name} offers` }),
      t.theirs.items.length || t.theirs.gold
        ? el('ul', { class: 'soc-items' }, [
          ...t.theirs.items.map((i) => el('li', { class: 'soc-item' }, el('span', {}, itemIcon(api, i), i.quantity > 1 ? `${i.name} ×${i.quantity}` : i.name))),
          t.theirs.gold ? el('li', { class: 'soc-item' }, el('span', {}, itemIcon(api, { template: 'gold' }), `${t.theirs.gold} gold`)) : null,
        ])
        : el('p', { class: 'soc-note', text: 'Nothing yet.' }),
      el('p', { class: `soc-confirm-state${t.theirs.confirmed ? ' soc-ok' : ''}`, text: t.theirs.confirmed ? `${t.partner.name} confirmed.` : `${t.partner.name} has not confirmed.` }));

    const why = confirmBlock(t, dirty);
    return section(`Trade with ${t.partner.name}`, 'trade',
      el('p', { class: 'soc-note', text: 'Both of you must confirm the same offer. Any change asks both to confirm again.' }),
      el('div', { class: 'soc-trade-grid' }, mine, theirs),
      el('div', { class: 'soc-actions' },
        el('button', { type: 'button', class: 'btn btn-primary', id: 'soc-confirm', disabled: why ? true : null, title: why,
          'aria-describedby': 'soc-confirm-why',
          onclick: () => act('trade.confirm', { tradeId: t.id, revision: t.revision }) }, 'Confirm trade'),
        cancel()),
      el('p', { class: 'soc-note', id: 'soc-confirm-why', text: why ?? `Confirming offer version ${t.revision}.` }));
  }

  // Keep typing smooth: toggle buttons without re-rendering inputs.
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
    if (why) why.textContent = reason ?? `Confirming offer version ${t.revision}.`;
  }

  function confirmBlock(t, dirty) {
    const nothing = !t.mine.items.length && !t.mine.gold && !t.theirs.items.length && !t.theirs.gold;
    return dirty ? 'Update your offer before confirming.' : nothing ? 'Nothing has been offered yet.' : t.mine.confirmed ? 'Waiting for your partner.' : null;
  }

  function composeView(s) {
    const inParty = Boolean(s.party);
    if (!inParty && ui.channel === 'party') ui.channel = 'region';
    const send = (e) => {
      e.preventDefault();
      const text = ui.compose.replace(/\s+/g, ' ').trim();
      if (!text) return;
      act('chat.send', { channel: ui.channel, text });
      ui.compose = '';
      const box = container?.querySelector('#soc-chat-text');
      if (box) box.value = '';
    };
    return section('Send a message', 'compose',
      el('form', { class: 'soc-compose', onsubmit: send },
        el('label', { for: 'soc-chat-channel', class: 'soc-visually-hidden', text: 'Channel' }),
        el('select', { id: 'soc-chat-channel', onchange: (e) => (ui.channel = e.target.value) },
          ['say', 'shout', 'party', 'region', 'global'].map((c) => el('option', { value: c, selected: ui.channel === c ? true : null, disabled: c === 'party' && !inParty ? true : null },
            c === 'region' ? `Region (${s.region})` : CHANNEL_LABEL[c]))),
        el('label', { for: 'soc-chat-text', class: 'soc-visually-hidden', text: 'Message' }),
        el('input', { id: 'soc-chat-text', type: 'text', maxlength: '200', autocomplete: 'off', value: ui.compose, placeholder: 'Message…', oninput: (e) => (ui.compose = e.target.value),
          onkeydown: (e) => e.stopPropagation() }),
        el('button', { type: 'submit', class: 'btn' }, 'Send')),
      el('p', { class: 'soc-note', text: 'Tip: plain chat speaks nearby (~24 m). Start with / or /yell to shout; /p, /r, /g, /w, /me, /help.' }));
  }

  api.registerPanel('party', 'Party & Trade', render);
  return { ui };
}
