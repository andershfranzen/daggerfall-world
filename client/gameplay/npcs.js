// Town NPC conversations. Talking (G / Talk) happens in the chat dock (`#hud-talk`, drawn by
// ./npcs/chatTalk.js): the world stays visible and the player answers with numbered replies.
// Buying, selling and guild training open the purpose-built `dialogue` menu page
// ("Trade & Services"); repairs and the journal open their own pages. Closing any of them
// returns to the conversation while the server still holds it.
//
// Server rules: server/rpg/npcs.js (protocol: ./npcs/CONTRACT.md). The interact key sends
// npc.talk; the server answers with private {kind:'dialogue'} views that only this player
// receives. Every reply is an intent the server re-checks (session token, range, place).

import { marketNote } from './economy/rules.js';
import { getItemArtSource, itemIcon } from './inventory/icons.js';
import { getNpcAssets } from './npcs/portrait.js';
import {
  ATTITUDE_LABELS, acceptsEvent, buyRows, clampQuantity, commandArgs, factionRelations, guildText, sellRows, standingText,
} from './npcs/model.js';
import { ASK_QUERY_CHARS, acceptsSubjects, choiceIndexForCode, learnedNote, normaliseQuery, passages, questEventForTalk, replyChoices, serviceLabel, subjectsNote } from './npcs/conversation.js';
import { announce, askPicker, focusFirstReply, renderTalk, setTalkOpen, talkRoot } from './npcs/chatTalk.js';
import { dateFromMinutes, formatDate, formatTime } from './atmosphere/calendar.js';

const PANEL = 'dialogue';
const BUSY_MS = 2500;

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};

function addStyles() {
  if (typeof document === 'undefined' || document.querySelector('link[data-feature="npcs"]')) return;
  for (const file of ['./npcs.css', './npcs/chatTalk.css']) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL(file, import.meta.url).href;
    link.dataset.feature = 'npcs';
    document.head.append(link);
  }
}

/** Fields that take typed characters (the chat composer, quantity boxes, …). */
const isTextEntry = (n) => {
  const tag = n?.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || n?.isContentEditable) return true;
  return tag === 'INPUT' && !/^(range|checkbox|radio|button|submit|reset|color|file|image)$/i.test(n.type || 'text');
};

export function install(api) {
  addStyles();
  const assets = getNpcAssets(api);
  getItemArtSource(api);
  const ui = { view: null, ended: null, busy: false, busyTimer: 0, qty: new Map(), tab: 'buy', relations: null };
  // The conversation in the chat dock. `queue` holds the passages still to read; `extra` holds
  // quest text that arrived before the dialogue view it belongs with.
  const talk = {
    view: null, queue: [], step: 0, offer: null, prompt: null, offerAnswered: false,
    awaiting: false, extra: [], lastSpokeAt: -Infinity, status: null, portrait: null, portraitFor: null,
    openShop: false, returnTo: null, pendingNpc: null, lastText: null,
    // "Where is …?" picker: open after the directions topic when the speaker can name people and places.
    ask: null, // {picker, list, query}
  };
  let container = null;
  let root = null;

  const rerender = () => { if (container?.isConnected) render(container); };
  const setBusy = (on) => {
    ui.busy = on;
    clearTimeout(ui.busyTimer);
    if (on) ui.busyTimer = setTimeout(() => { ui.busy = false; rerender(); drawTalk(); }, BUSY_MS);
  };

  api.on('assets', () => {
    if (ui.view) loadRelations(ui.view);
    talk.portrait = null; talk.portraitFor = null;
    rerender();
    drawTalk();
  });

  // ------------------------------------------------------------ chat dock conversation

  const isTalking = () => !!talk.view;
  const dock = () => (root?.isConnected ? root : (root = talkRoot()));

  function loadPortrait(v) {
    const key = `${v.npc.id}:${assets.art ? 1 : 0}`;
    if (talk.portraitFor === key) return;
    talk.portraitFor = key;
    talk.portrait = null;
    assets.portrait(v.npc.sprite, v.npc.faction).then((c) => {
      if (!c || talk.portraitFor !== key) return;
      c.setAttribute('aria-hidden', 'true');
      talk.portrait = c;
      drawTalk();
    });
  }

  function choicesNow() {
    if (!talk.view) return [];
    return replyChoices(talk.view, {
      more: talk.step < talk.queue.length - 1,
      offer: talk.offer,
      prompt: talk.prompt,
      canRepair: talk.view.npc.role === 'smith' && !!api.getPanel('townServices'),
      canJournal: !!api.getPanel('journal'),
    });
  }

  function drawTalk({ speak = false } = {}) {
    const r = dock();
    if (!r) return;
    if (!talk.view) { setTalkOpen(r, null); return; }
    setTalkOpen(r, talk.view.npc.id);
    const text = talk.queue[talk.step] ?? '';
    renderTalk(r, {
      view: talk.view, text, step: talk.step, steps: talk.queue.length,
      choices: choicesNow(), busy: ui.busy, status: talk.status, portrait: talk.portrait,
      askNode: talk.ask?.picker.node ?? null,
    }, choose);
    if (speak) {
      r.scrollTop = 0; // a new passage starts at the top of the (possibly scrolling) dock
      announce(r, `${talk.view.npc.name}: ${text}`);
    }
  }

  // ------------------------------------------------------------ "Where is …?"

  function openAsk() {
    if (!talk.view?.ask) return;
    if (!talk.ask) {
      const picker = askPicker({
        onQuery: (q) => queryAsk(q),
        onPick: (subj) => {
          if (!talk.view || ui.busy) return;
          closeAsk({ refocus: false });
          sendTalk('npc.ask', commandArgs(talk.view, { subject: subj.id }));
        },
        onClose: () => closeAsk(),
      });
      talk.ask = { picker, list: null, query: '' };
    }
    talk.ask.picker.update(null, subjectsNote(null));
    queryAsk(talk.ask.picker.input.value);
    drawTalk();
    // Bring the field into the (scrolling) dock and type straight into it. Touch screens only scroll, so the
    // on-screen keyboard does not cover the conversation until the player taps the field.
    const { node, input } = talk.ask.picker;
    node.scrollIntoView?.({ block: 'nearest' });
    if (!window.matchMedia?.('(pointer: coarse)').matches) input.focus({ preventScroll: true });
  }

  function queryAsk(q) {
    if (!talk.ask || !talk.view) return;
    talk.ask.query = String(q ?? '').slice(0, ASK_QUERY_CHARS);
    api.act('npc.ask', commandArgs(talk.view, { query: talk.ask.query }), { quiet: true })?.then?.((res) => {
      if (!res.ok && talk.ask) talk.ask.picker.update([], res.error ? res.error[0].toUpperCase() + res.error.slice(1) : 'No answer.');
    });
  }

  function closeAsk({ refocus = true } = {}) {
    if (!talk.ask) return;
    const had = talk.ask.picker.node.contains(document.activeElement);
    talk.ask = null;
    drawTalk();
    if (had && refocus) focusFirstReply(dock());
  }

  function setQueue(list) {
    talk.queue = list.length ? list : ['…'];
    talk.step = 0;
  }

  /** Begin, continue or replace the conversation from a server dialogue view. */
  function showView(ev) {
    const fresh = !talk.view || talk.view.npc.id !== ev.npc.id || talk.view.session !== ev.session;
    talk.view = ev;
    talk.status = null;
    if (fresh) {
      // Quest lines sent while the greeting was on its way belong to this conversation.
      const carried = talk.pendingNpc === ev.npc.id;
      talk.offer = null; talk.offerAnswered = false; talk.ask = null;
      if (!carried) { talk.prompt = null; talk.extra = []; }
      talk.pendingNpc = null;
      // Free the mouse so replies can be clicked; movement keys keep working (walking away ends it).
      if (document.pointerLockElement) document.exitPointerLock?.();
    }
    // A shop refresh pushed by the server (another player traded, restock) changes stock only.
    const refreshOnly = !fresh && !talk.awaiting && ev.text === talk.lastText;
    talk.lastText = ev.text;
    if (!refreshOnly) {
      setQueue([...passages(ev.text), ...talk.extra.flatMap((t) => passages(t))]);
      talk.extra = [];
    }
    talk.awaiting = false;
    if (!refreshOnly && ev.learned?.length) talk.status = { text: learnedNote(ev.learned), learned: true };
    loadPortrait(ev);
    // Focus is left where it is (the game view, usually) so Enter / T still open the composer
    // and number keys answer; a reply that had focus keeps it across redraws (renderTalk).
    drawTalk({ speak: !refreshOnly });
    if (talk.openShop && ev.shop) {
      talk.openShop = false;
      openService('shop');
    }
  }

  function endTalk(text) {
    if (!talk.view) return;
    const r = dock();
    const hadFocus = r?.contains(document.activeElement);
    talk.view = null;
    talk.queue = []; talk.offer = null; talk.prompt = null; talk.extra = []; talk.awaiting = false; talk.status = null;
    talk.openShop = false; talk.ask = null;
    drawTalk();
    if (text) localLine(text); // #chat-log is a polite live region, so this is announced
    if (hadFocus) document.getElementById('view')?.focus?.({ preventScroll: true });
  }

  /** A line in this player's own chat log (never sent to anyone). */
  function localLine(text) {
    const log = document.getElementById('chat-log');
    if (!log) return;
    log.append(el('li', { class: 'chat-line chat-system chat-npc', 'data-at': String(performance.now()) },
      el('span', { class: 'chat-text', text })));
    while (log.children.length > 80) log.firstElementChild.remove();
    log.scrollTop = log.scrollHeight;
  }

  function addPassages(text) {
    const more = passages(text);
    if (!more.length) return;
    if (talk.awaiting) { talk.extra.push(text); return; }
    const atEnd = talk.step >= talk.queue.length - 1;
    talk.queue = [...talk.queue, ...more];
    if (atEnd && talk.queue.length > more.length) talk.step = talk.queue.length - more.length;
    drawTalk({ speak: true });
  }

  /** Send a conversation intent; errors stay in the dock instead of a toast. */
  function sendTalk(verb, args, { dialogue = true, then = null } = {}) {
    if (!talk.view || ui.busy) return;
    talk.lastSpokeAt = Date.now();
    talk.awaiting = dialogue;
    talk.status = null;
    setBusy(true);
    drawTalk();
    const r = api.act(verb, args, { quiet: true });
    if (!r) { setBusy(false); talk.awaiting = false; talk.status = { error: true, text: 'Not connected — nothing was said.' }; drawTalk(); return; }
    r.then((res) => {
      setBusy(false);
      if (!talk.view) return;
      if (talk.awaiting) {
        // No new view came (a quest-only answer): show what did arrive.
        talk.awaiting = false;
        if (talk.extra.length) { const t = talk.extra; talk.extra = []; for (const x of t) addPassages(x); }
      }
      if (!res.ok && res.error) talk.status = { error: true, text: res.error[0].toUpperCase() + res.error.slice(1) };
      drawTalk();
      if (res.ok && then) then();
    });
  }

  function choose(c) {
    if (!talk.view) return;
    switch (c.kind) {
      case 'continue':
        talk.step = Math.min(talk.step + 1, talk.queue.length - 1);
        drawTalk({ speak: true });
        break;
      case 'topic':
        if (c.openPanel) talk.openShop = true;
        sendTalk('npc.topic', commandArgs(talk.view, { topic: c.topic }), { then: c.topic === 'directions' && talk.view.ask ? openAsk : null });
        break;
      case 'service':
        // Bank and repair: the server answers in the conversation and offers its counter; the
        // Bank & Repairs page then opens over the conversation.
        sendTalk('npc.service', commandArgs(talk.view, { service: c.service, confirm: c.confirm, ...c.args }), { then: c.panel && api.getPanel(c.panel) ? () => openService(c.panel, c.panel) : null });
        break;
      case 'tone':
        // Changes how the next questions are put; the speaker's last line stays on screen.
        sendTalk('npc.tone', commandArgs(talk.view, { tone: c.tone }), { dialogue: false });
        break;
      case 'quest':
        if (c.verb === 'quest.accept' || c.verb === 'quest.refuse') talk.offerAnswered = true;
        sendTalk(c.verb, c.args, { dialogue: false });
        break;
      case 'pay':
        // Package 12 checkout: the server re-checks the session, the counter reach, the quote and the receipt.
        sendTalk(c.verb, commandArgs(talk.view, c.args));
        break;
      case 'panel':
        openService(c.id === 'shop' ? 'shop' : c.id === 'train' ? 'train' : c.panel, c.panel);
        break;
      case 'teleport':
        openTeleport(talk.view);
        break;
      case 'leave':
      default:
        leave();
        break;
    }
  }

  /** Open a purpose-built page over the conversation; closing it comes back here. */
  function openService(what, panel = PANEL) {
    if (!talk.view) return;
    talk.returnTo = talk.view.npc.id;
    if (panel === PANEL) {
      ui.view = talk.view;
      if (what === 'shop') ui.tab = ui.tab || 'buy';
      ui.focus = what;
    }
    api.openPanel(panel);
  }

  /** Guild teleport: the travel map picks the destination and answers this conversation (client/gameplay/travel.js). */
  function openTeleport(v) {
    if (!v?.teleport) return;
    api.guildTeleport = { ...commandArgs(v, {}), name: v.npc.name, at: Date.now() };
    talk.returnTo = v.npc.id;
    api.openPanel('map');
  }

  function leave() {
    const v = talk.view ?? ui.view;
    if (v) api.act('npc.leave', {}, { quiet: true });
    const name = talk.view?.npc?.name;
    ui.view = null;
    if (api.panel === PANEL) api.closePanel();
    endTalk(name ? `You bid ${name} farewell.` : '');
  }

  // G / Talk on an NPC: start (or return to) the conversation here so quest lines sent with
  // the greeting are kept with it.
  api.on('interactIntent', (d) => {
    const e = d?.entity;
    if (!e || e.kind !== 'npc' || d.handled) return;
    d.preventDefault();
    if (talk.view?.npc?.id === String(e.id) && !api.modalOpen) { drawTalk(); focusFirstReply(dock()); return; }
    talk.pendingNpc = String(e.id);
    talk.lastSpokeAt = Date.now();
    talk.extra = []; talk.prompt = null;
    const r = api.act('npc.talk', { targetId: String(e.id) });
    if (r) r.then((res) => { if (!res.ok && talk.pendingNpc === String(e.id)) talk.pendingNpc = null; });
  });

  // Number keys answer, Esc says goodbye. Runs before the world keys (capture phase), only
  // while talking with no menu page open and nothing being typed.
  window.addEventListener('keydown', (e) => {
    if (!isTalking() || api.modalOpen || e.defaultPrevented || api.screen !== 'game') return;
    if (e.ctrlKey || e.metaKey || e.altKey || isTextEntry(document.activeElement)) return;
    if (e.key === 'Escape') {
      if (document.pointerLockElement) return; // Esc first frees a captured mouse
      e.preventDefault();
      e.stopImmediatePropagation();
      leave();
      return;
    }
    const choices = choicesNow();
    const i = choiceIndexForCode(e.code, choices);
    if (i < 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;
    const c = choices[i];
    if (ui.busy && c.kind !== 'leave' && c.kind !== 'continue') return;
    choose(c);
  }, true);

  // ------------------------------------------------------------ server events

  api.on('event', (ev) => {
    if (!ev || typeof ev.kind !== 'string') return;
    if (ev.kind === 'daedraSummoning' && ev.npc?.id === talk.view?.npc?.id) ev.silent = true;
    if (ev.kind === 'dialogue' || ev.kind === 'dialogue.end') {
      ev.silent = true; // shown in the dock / chat log, never as a toast
      if (!acceptsEvent(talk.view ?? ui.view, ev)) return;
      if (ev.kind === 'dialogue') {
        const newNpc = ui.view?.npc?.id !== ev.npc.id;
        ui.view = ev;
        ui.ended = null;
        if (newNpc) { ui.qty.clear(); ui.tab = 'buy'; ui.relations = null; loadRelations(ev); }
        setBusy(false);
        showView(ev);
        if (api.panel === PANEL) rerender();
      } else {
        const name = talk.view?.npc?.name ?? ui.view?.npc?.name;
        ui.ended = name ? `${name} turns away.` : null;
        ui.view = null;
        setBusy(false);
        rerender();
        endTalk(ev.text || (name ? `${name} turns away.` : ''));
      }
      return;
    }
    if (ev.kind === 'dialogue.subjects') {
      ev.silent = true;
      if (!talk.ask || !acceptsSubjects(talk.view, ev)) return;
      // Only the answer to the latest filter (typing quickly sends several).
      if (ev.query !== normaliseQuery(talk.ask.query)) return;
      talk.ask.list = ev;
      talk.ask.picker.update(ev.subjects, subjectsNote(ev));
      return;
    }
    if (ev.kind === 'townServices.offer' && talk.view && ev.counterId === `npc:${talk.view.npc.id}`) {
      ev.talkHandled = true;
      ev.silent = true;
      return;
    }
    const pendingQuestLine = talk.pendingNpc && talk.view?.npc?.id !== talk.pendingNpc && (ev.kind === 'questMessage' || ev.kind === 'questPrompt')
      && Date.now() - talk.lastSpokeAt < 2500;
    if (pendingQuestLine) {
      ev.talkHandled = true;
      ev.silent = true;
      if (ev.kind === 'questPrompt') talk.prompt = { uid: ev.uid, title: ev.title };
      if (ev.text) talk.extra.push(ev.text);
      return;
    }
    if (ev.kind.startsWith('quest') && questEventForTalk(talk, ev)) {
      // The journal still records it; this conversation shows it instead of a toast or page.
      ev.talkHandled = true;
      ev.silent = true;
      switch (ev.kind) {
        case 'questOffer':
          talk.offer = { id: ev.offerId, title: ev.title };
          addPassages(ev.text || `${ev.title}.`);
          break;
        case 'questAccepted':
          talk.offer = null; talk.offerAnswered = false;
          setQueue(passages(ev.text || '').concat(`Journal: ${ev.title} added.`));
          talk.awaiting = false;
          drawTalk({ speak: true });
          break;
        case 'questRefused':
          talk.offer = null; talk.offerAnswered = false;
          setQueue(passages(ev.text || 'Another time, then.'));
          talk.awaiting = false;
          drawTalk({ speak: true });
          break;
        case 'questPrompt':
          talk.prompt = { uid: ev.uid, title: ev.title };
          addPassages(ev.text);
          break;
        case 'questMessage':
          addPassages(ev.text);
          break;
        default: break;
      }
      if (talk.prompt && ev.kind !== 'questPrompt' && talk.lastSpokeAt && ev.uid === talk.prompt.uid) talk.prompt = null;
      return;
    }
  });
  api.on('actionResult', (res) => {
    // A quest answer clears the question (the server has moved on either way).
    if (res?.verb === 'quest.answer' && talk.prompt) { talk.prompt = null; drawTalk(); }
  });
  api.on('message', (m) => { if (m?.kind === 'error' && ui.busy) { setBusy(false); rerender(); drawTalk(); } });
  // Travel, a lost connection or leaving the world end the conversation here as on the server.
  api.on('location', () => { ui.view = null; ui.ended = null; rerender(); endTalk(''); });
  api.on('connection', (state) => { if (state !== 'online') { ui.view = null; rerender(); endTalk(talk.view ? 'The conversation was interrupted.' : ''); } });
  api.on('screen', (s) => { if (s !== 'game') { ui.view = null; endTalk(''); } });
  // Coming back from a page opened over the conversation.
  api.on('panel', ({ id, open }) => {
    if (open || !talk.view || talk.returnTo !== talk.view.npc.id) return;
    talk.returnTo = null;
    void id;
    // The shell has put focus back on whatever opened the page (a reply or the game view).
    drawTalk();
  });

  async function loadRelations(view) {
    const assetSource = assets.art;
    const factions = await assets.getFactions();
    if (assetSource !== assets.art || ui.view?.npc?.id !== view.npc.id) return;
    ui.relations = factionRelations(factions, view.standing?.factionId);
    rerender();
  }

  function send(verb, extra) {
    if (!ui.view || ui.busy) return;
    setBusy(true);
    rerender();
    if (!api.act(verb, commandArgs(ui.view, extra))) setBusy(false);
  }

  // ------------------------------------------------------------ Trade & Services page

  function header(v) {
    const pic = el('div', { class: 'npc-portrait', 'aria-hidden': 'true', hidden: true });
    assets.portrait(v.npc.sprite, v.npc.faction).then((c) => {
      if (!c) return;
      pic.append(c);
      pic.hidden = false;
    });
    const att = v.attitude || 'neutral';
    return el('header', { class: 'npc-head' }, pic,
      el('div', { class: 'npc-id' },
        el('h3', { class: 'npc-name', text: v.npc.name }),
        el('p', { class: 'npc-title', text: v.npc.title }),
        el('p', { class: 'npc-standing' },
          el('span', { class: `npc-att npc-att-${att}`, text: ATTITUDE_LABELS[att] ?? att }),
          ' ', standingText(v)),
        v.guild ? el('p', { class: 'npc-guild', text: guildText(v) }) : null,
        ui.relations && (ui.relations.allies.length || ui.relations.enemies.length)
          ? el('p', { class: 'npc-rel', text: [
            ui.relations.allies.length ? `Allies: ${ui.relations.allies.join(', ')}` : '',
            ui.relations.enemies.length ? `Enemies: ${ui.relations.enemies.join(', ')}` : '',
          ].filter(Boolean).join(' · ') })
          : null),
      el('p', { class: 'npc-gold' }, itemIcon(api, { template: 'gold' }), `${v.gold ?? 0} gold`));
  }

  function services(v) {
    if (!v.services.length) return null;
    const box = el('section', { class: 'npc-box', 'aria-label': 'Services' }, el('h4', { class: 'npc-h4', text: 'Services' }));
    const row = el('div', { class: 'npc-services' });
    for (const s of v.services) {
      if (s.id === 'train' || (s.id === 'rest' && v.tavern)) continue;
      const cost = s.id === 'cure' && Number.isFinite(s.cost) ? s.cost : undefined;
      const label = s.id === 'heal' || s.id === 'cure' ? serviceLabel(s) : s.label;
      row.append(el('button', {
        type: 'button', class: 'btn', 'data-focus-key': `svc-${s.id}`, disabled: ui.busy,
        onclick: () => send('npc.service', { service: s.id, cost }),
      }, label));
    }
    if (v.teleport) {
      row.append(el('button', { type: 'button', class: 'btn btn-primary', 'data-focus-key': 'svc-teleport-map', disabled: ui.busy, onclick: () => openTeleport(v) }, 'Choose a destination on the map…'));
    }
    if (row.childElementCount) box.append(row);
    if (v.services.some((s) => s.id === 'train') && v.guild?.training?.length) {
      const ul = el('ul', { class: 'npc-list' });
      const minutes = v.guild.training[0].minutesLeft || 0;
      const wait = minutes > 0 ? `Next lesson in ${minutes} game minutes` : null;
      for (const t of v.guild.training) {
        const capped = t.value > t.max;
        const poor = t.cost > (v.gold ?? 0);
        ul.append(el('li', { class: 'npc-row' },
          el('span', { class: 'npc-item', text: t.skill }),
          el('span', { class: 'npc-num', text: `${t.value}/${t.max}` }),
          el('span', { class: 'npc-price', text: `${t.cost} g` }),
          el('button', {
            type: 'button', class: 'btn btn-small', 'data-focus-key': `train-${t.skill}`, disabled: ui.busy || capped || poor || !!wait || t.reason === 'unavailable',
            title: capped ? 'Above this trainer’s skill limit' : wait ?? (poor ? 'Not enough gold' : null),
            onclick: () => send('npc.service', { service: 'train', skill: t.skill }),
          }, 'Train')));
      }
      box.append(el('h4', { class: 'npc-h4', text: 'Training' }));
      if (wait) box.append(el('p', { class: 'npc-line', text: wait }));
      box.append(ul);
    }
    return box.childElementCount > 1 ? box : null;
  }

  function tavern(v) {
    const quote = v.tavern;
    if (!quote) return null;
    const expires = quote.bed && dateFromMinutes(quote.bed.expiresAt);
    const mealAvailable = quote.minute >= quote.mealReadyAt;
    const days = el('input', { type: 'number', min: 1, max: quote.maxDays, step: 1, value: 1, id: 'tavern-days', inputmode: 'numeric', required: true });
    const price = el('output', { for: 'tavern-days' });
    const cost = () => quote.roomRate * (Number(days.value) - Number(Number(days.value) >= quote.freeDay));
    const updateCost = () => { price.value = days.validity.valid ? `${cost()} gold` : ''; };
    days.addEventListener('input', updateCost);
    updateCost();
    const rent = el('form', { class: 'npc-services', onsubmit: e => {
      e.preventDefault();
      send('npc.service', { service: 'rest', days: Number(days.value), cost: cost(), rentalExpiresAt: quote.bed?.expiresAt ?? null });
    } },
    el('label', { for: 'tavern-days', text: quote.bed ? 'Additional days' : 'Days' }), days, price,
    el('button', { class: 'btn', type: 'submit', disabled: ui.busy, text: quote.bed ? 'Extend stay' : 'Rent a room' }));
    return el('section', { class: 'npc-box', 'aria-label': 'Room and board' },
      el('h4', { class: 'npc-h4', text: 'Lodging' }),
      expires ? el('p', { class: 'npc-title', text: `Bed ${quote.bed.number} · ${quote.bed.directions} · Until ${formatTime(expires)}, ${formatDate(expires)}` }) : null,
      quote.hasBeds && quote.maxDays ? rent : el('p', { class: 'npc-title', text: quote.hasBeds ? 'Your stay is booked as far ahead as possible.' : 'There are no beds to let here.' }),
      el('h4', { class: 'npc-h4', text: 'Food & drink' }),
      mealAvailable ? null : el('p', { class: 'npc-title', text: `You can order again at ${formatTime(dateFromMinutes(quote.mealReadyAt))}.` }),
      el('div', { class: 'npc-services' }, quote.menu.map(item => el('button', {
        type: 'button', class: 'btn', disabled: ui.busy || !mealAvailable || item.cost > v.gold,
        onclick: () => send('npc.service', { service: 'rest', menuItem: item.id, cost: item.cost }),
      }, `${item.name} · ${item.cost ? `${item.cost} g` : 'Free'}`))),
    );
  }

  function qtyInput(key, max) {
    const value = clampQuantity(ui.qty.get(key) ?? 1, max);
    return el('input', {
      type: 'number', class: 'npc-qty', min: 1, max, value, 'aria-label': 'Quantity',
      oninput: (e) => ui.qty.set(key, clampQuantity(e.target.value, max)),
    });
  }

  function shop(v) {
    if (!v.shop) return null;
    if (v.shop.fence) ui.tab = 'sell'; // a fence only buys
    const tabs = el('div', { class: 'npc-tabs', role: 'tablist' },
      ...(v.shop.fence ? ['sell'] : ['buy', 'sell']).map((t) => el('button', {
        type: 'button', role: 'tab', class: 'npc-tab', 'aria-selected': String(ui.tab === t), 'data-focus-key': `tab-${t}`,
        onclick: () => { ui.tab = t; rerender(); },
      }, t === 'buy' ? 'Buy' : 'Sell')));
    const ul = el('ul', { class: 'npc-list npc-shop' });
    const rows = ui.tab === 'buy' ? buyRows(v) : sellRows(v);
    for (const r of rows) {
      const key = ui.tab === 'buy' ? `b:${r.key}` : `s:${r.itemId}`;
      ul.append(el('li', { class: `npc-row${r.affordable ? '' : ' npc-poor'}` },
        el('span', { class: 'npc-item' }, itemIcon(api, r), r.name, Number.isInteger(r.shelf) ? el('small', { class: 'npc-shelf', text: ` · shelf ${r.shelf}` }) : null),
        el('span', { class: 'npc-num', text: `×${r.quantity}` }),
        el('span', { class: 'npc-price', text: `${r.price} g` }),
        r.quantity > 1 ? qtyInput(key, r.maxQuantity) : el('span'),
        el('button', {
          type: 'button', class: 'btn btn-small', 'data-focus-key': key, disabled: ui.busy || !r.affordable,
          onclick: () => {
            const quantity = clampQuantity(ui.qty.get(key) ?? 1, r.maxQuantity);
            if (ui.tab === 'buy') send('npc.buy', { key: r.key, quantity, price: r.price });
            else send('npc.sell', { itemId: r.itemId, quantity, price: r.price });
          },
        }, ui.tab === 'buy' ? 'Buy' : 'Sell')));
    }
    if (!rows.length) ul.append(el('li', { class: 'npc-empty', text: ui.tab === 'buy' ? 'Sold out.' : 'Nothing they want to buy.' }));
    return el('section', { class: 'npc-box', 'aria-label': 'Trade' },
      el('div', { class: 'npc-shop-head' }, tabs, el('span', { class: 'npc-purse', text: `${Number.isInteger(v.shop.quality) ? `Quality ${v.shop.quality} · ` : ''}Merchant's purse: ${v.shop.purse} g` })),
      marketNote(v.shop.market?.adjust ?? 1000) || v.shop.market?.holiday ? el('p', { class: 'npc-title', text: [marketNote(v.shop.market?.adjust ?? 1000), v.shop.market?.holiday ? `Today is a holiday (${v.shop.market.holiday.replace(/-/g, ' ')}).` : null].filter(Boolean).join(' ') }) : null,
      ul);
  }

  function render(rootEl) {
    container = rootEl;
    rootEl.replaceChildren();
    const v = ui.view;
    const wrap = el('div', { class: 'npc-root' });
    if (!v) {
      wrap.append(el('p', { class: 'npc-empty', text: ui.ended || 'Talk to a merchant, guild or temple member (G) and choose to trade or train to use this page.' }));
      rootEl.append(wrap);
      return;
    }
    const choices = services(v);
    const nothing = !v.shop && !v.tavern && !choices;
    wrap.append(...[
      header(v),
      // The latest thing they said, so a purchase or training result is visible here too.
      v.text ? el('p', { class: 'npc-say', role: 'status', text: v.text }) : null,
      choices,
      tavern(v),
      shop(v),
      nothing ? el('p', { class: 'npc-empty', text: `${v.npc.name} has nothing to trade or teach you right now.` }) : null,
      el('div', { class: 'npc-actions' },
        isTalking()
          ? el('button', { type: 'button', class: 'btn btn-primary', 'data-focus-key': 'back', autofocus: ui.focus === 'back' ? true : null, onclick: () => api.closePanel() }, 'Back to conversation')
          : null,
        el('button', { type: 'button', class: 'btn', 'data-focus-key': 'leave', onclick: leave }, 'Goodbye')),
    ].filter(Boolean));
    rootEl.append(wrap);
  }

  api.registerPanel(PANEL, 'Trade & Services', render, { order: 6.5 });
  return { ui, talk, assets };
}
