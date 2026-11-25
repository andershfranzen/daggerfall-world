// In-chat conversation view: draws the speaker, the current passage and numbered replies into
// the chat dock's `#hud-talk` section (host contract: client/hud-contract.md, "Chat dock").
// State and server traffic live in ../npcs.js; this file only builds DOM.

import { ATTITUDE_LABELS } from './model.js';

export const TALK_ID = 'hud-talk';

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

/** The dock section, created before #chat-log when the page markup does not have it yet. */
export function talkRoot() {
  let root = document.getElementById(TALK_ID);
  if (root) return root;
  const dock = document.getElementById('hud-chat');
  if (!dock) return null;
  root = el('section', { id: TALK_ID, hidden: true, 'aria-label': 'Conversation' });
  dock.insertBefore(root, document.getElementById('chat-log') ?? dock.firstChild);
  return root;
}

/** Show or hide the dock section and the body hook the layout CSS keys off. */
export function setTalkOpen(root, npcId) {
  if (!root) return;
  const open = npcId != null;
  root.hidden = !open;
  if (!open) root.querySelector(':scope > .talk-frame')?.remove();
  if (open) document.body.dataset.talk = String(npcId);
  else delete document.body.dataset.talk;
}

/**
 * Draw one step of the conversation.
 * @param {HTMLElement} root
 * @param {object} m  {view, speaker, text, step, steps, choices, busy, status, note, portrait}
 * @param {(choice:object)=>void} choose
 */
export function renderTalk(root, m, choose) {
  const hadFocus = root.contains(document.activeElement);
  const focusKey = hadFocus ? document.activeElement?.dataset?.choice : null;
  const field = hadFocus && document.activeElement?.classList?.contains('talk-ask-input') ? document.activeElement : null;
  const caret = field ? [field.selectionStart, field.selectionEnd] : null;
  const v = m.view;
  const att = v.attitude || 'neutral';

  const pic = el('div', { class: 'talk-portrait', 'aria-hidden': 'true', hidden: !m.portrait });
  if (m.portrait) pic.append(m.portrait);

  const head = el('header', { class: 'talk-head' }, pic,
    el('div', { class: 'talk-who' },
      el('h2', { class: 'talk-name', id: 'talk-name', text: m.speaker || v.npc.name }),
      el('p', { class: 'talk-title' },
        v.npc.title ? el('span', { text: v.npc.title }) : null,
        el('span', { class: `talk-att talk-att-${att}`, text: ATTITUDE_LABELS[att] ?? att }))));

  const say = el('div', { class: 'talk-say', id: 'talk-say' },
    ...String(m.text || '…').split(/\n{2,}/).map((p) => el('p', { text: p })));

  const progress = m.steps > 1
    ? el('p', { class: 'talk-step', 'aria-hidden': 'true', text: `${m.step + 1} / ${m.steps}` })
    : null;

  const list = el('ol', { class: 'talk-replies', 'aria-label': 'Your replies', 'aria-busy': m.busy ? 'true' : null });
  for (const c of m.choices) {
    list.append(el('li', { class: `talk-reply talk-reply-${c.kind}` },
      el('button', {
        type: 'button', class: 'talk-btn', 'data-choice': c.id, disabled: m.busy && c.kind !== 'leave' && c.kind !== 'continue',
        'aria-keyshortcuts': c.key ? String(c.key) : null,
        onclick: () => choose(c),
      },
      c.key ? el('span', { class: 'talk-key', 'aria-hidden': 'true', text: `${c.key}.` }) : el('span', { class: 'talk-key', 'aria-hidden': 'true' }),
      el('span', { class: 'talk-label', text: c.label }))));
  }

  const status = el('p', { class: `talk-status${m.status?.error ? ' talk-error' : m.status?.learned ? ' talk-learned' : ''}`, role: m.status?.error ? 'alert' : 'status', hidden: !m.status && !m.note },
    m.status?.text ?? m.note ?? '');

  // Tone of voice for questions (server view `tones`): a pressed toggle group, outside the numbered replies.
  const tones = Array.isArray(v.tones) && v.tones.length
    ? el('div', { class: 'talk-tones', role: 'group', 'aria-label': 'Tone of voice' },
      el('span', { class: 'talk-tones-label', 'aria-hidden': 'true', text: 'Tone' }),
      ...v.tones.map((t) => el('button', {
        type: 'button', class: 'talk-tone', 'data-choice': `tone-${t.id}`, 'data-tone': t.id,
        'aria-pressed': v.tone === t.id ? 'true' : 'false', disabled: m.busy,
        onclick: () => { if (v.tone !== t.id) choose({ id: `tone-${t.id}`, kind: 'tone', tone: t.id }); },
      }, t.label)))
    : null;

  const hint = el('p', { class: 'talk-hint', 'aria-hidden': 'true', text: '1–9 reply · G or Tab to select · Esc goodbye' });

  root.setAttribute('aria-labelledby', 'talk-name');
  const frame = el('div', { class: 'talk-frame' }, head, say, progress, tones, list, m.askNode ?? null, status, hint);
  const old = root.querySelector(':scope > .talk-frame');
  if (old) old.replaceWith(frame);
  else root.prepend(frame);
  liveRegion(root);

  if (field && field.isConnected) {
    field.focus({ preventScroll: true });
    try { field.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ }
  } else if (hadFocus) {
    const again = (focusKey && root.querySelector(`[data-choice="${CSS.escape(focusKey)}"]:not([disabled])`))
      || root.querySelector('.talk-btn:not([disabled])');
    again?.focus({ preventScroll: true });
  }
}

/**
 * The "Where is …?" picker: a filter field and up to a handful of named people and places. The node is kept by
 * the caller across redraws (so typing is never interrupted); `update` redraws only its results.
 * @param {{onQuery:(q:string)=>void, onPick:(s:object)=>void, onClose:()=>void}} h
 */
export function askPicker(h) {
  const input = el('input', {
    type: 'search', class: 'talk-ask-input', id: 'talk-ask-q', maxlength: 40, autocomplete: 'off', spellcheck: 'false',
    placeholder: 'Name of a person or place', 'aria-describedby': 'talk-ask-note', 'aria-controls': 'talk-ask-list',
  });
  const list = el('ul', { class: 'talk-ask-list', id: 'talk-ask-list', 'aria-label': 'People and places' });
  const note = el('p', { class: 'talk-ask-note', id: 'talk-ask-note', role: 'status' });
  const close = el('button', { type: 'button', class: 'talk-ask-close', 'aria-label': 'Close “Where is…”', onclick: () => h.onClose() }, '×');
  let timer = 0;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => h.onQuery(input.value), 180); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); h.onClose(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); list.querySelector('button')?.click(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector('button')?.focus(); }
  });
  list.addEventListener('keydown', (e) => {
    const btns = [...list.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const j = i + (e.key === 'ArrowDown' ? 1 : -1);
      (j < 0 ? input : btns[Math.min(j, btns.length - 1)]).focus();
    } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); h.onClose(); }
  });
  const node = el('section', { class: 'talk-ask', 'aria-label': 'Where is…' },
    el('div', { class: 'talk-ask-head' }, el('label', { for: 'talk-ask-q', class: 'talk-ask-label', text: 'Ask where to find…' }), close),
    input, list, note);
  return {
    node,
    input,
    update(subjects, text) {
      list.replaceChildren(...(subjects ?? []).map((s) => el('li', {},
        el('button', { type: 'button', class: `talk-ask-pick talk-ask-${s.kind}`, 'data-subject': s.id, onclick: () => h.onPick(s) },
          el('span', { class: 'talk-ask-name', text: s.label }),
          s.hint ? el('span', { class: 'talk-ask-hint', text: s.hint }) : null))));
      note.textContent = text ?? '';
      note.hidden = !text;
    },
  };
}

/** The persistent polite live region (kept across redraws so screen readers hear each line). */
function liveRegion(root) {
  let sr = root.querySelector(':scope > .talk-sr');
  if (!sr) {
    sr = el('p', { class: 'talk-sr', 'aria-live': 'polite', 'aria-atomic': 'true' });
    root.append(sr);
  }
  return sr;
}

/** Announce a line (the speaker's passage, or the end of the conversation). */
export function announce(root, text) {
  if (!root) return;
  const sr = liveRegion(root);
  sr.textContent = '';
  // A separate task, so the same sentence twice is still announced.
  setTimeout(() => { sr.textContent = text; }, 30);
}

/** Focus the first reply (after a menu page closes back into the conversation). */
export function focusFirstReply(root) {
  root?.querySelector('.talk-btn:not([disabled])')?.focus({ preventScroll: true });
}
