// DOM-free model for the in-chat conversation (client/gameplay/npcs/chatTalk.js).
// The server owns the conversation: every reply here maps to an npc.* / quest.* intent or to
// opening a purpose-built menu page. Unit tested in Node (test/npc-chat-talk.test.mjs).

/** Longest passage shown at once in the chat dock before a "Continue" step. */
export const PASSAGE_CHARS = 320;
/** Replies past this many get no number key (they stay clickable and Tab-reachable). */
export const MAX_NUMBERED = 9;

/**
 * Split NPC or quest text into passages for the dock. Blank lines separate paragraphs; single
 * line breaks inside a paragraph (fixed-width classic text) become spaces. Paragraphs are packed
 * together up to `max` characters; an overlong paragraph is cut at sentence ends.
 */
export function passages(text, max = PASSAGE_CHARS) {
  const paras = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const pieces = [];
  for (const p of paras) {
    if (p.length <= max) { pieces.push(p); continue; }
    const sentences = p.match(/[^.!?]+(?:[.!?]+["'”’)]*|$)\s*/g) ?? [p];
    let cur = '';
    for (const s of sentences) {
      if (cur && (cur + s).trim().length > max) { pieces.push(cur.trim()); cur = ''; }
      if (s.trim().length > max) {
        // One giant sentence: hard wrap at a space.
        let rest = s.trim();
        while (rest.length > max) {
          const cut = rest.lastIndexOf(' ', max);
          const at = cut > max / 2 ? cut : max;
          pieces.push(rest.slice(0, at).trim());
          rest = rest.slice(at).trim();
        }
        cur = rest ? `${rest} ` : '';
      } else cur += s;
    }
    if (cur.trim()) pieces.push(cur.trim());
  }
  const out = [];
  for (const piece of pieces) {
    const last = out.length ? out[out.length - 1] : null;
    if (last !== null && last.length + 1 + piece.length <= max) out[out.length - 1] = `${last}\n\n${piece}`;
    else out.push(piece);
  }
  return out;
}

const SERVICE_FALLBACK = { join: 'I would like to join.', heal: 'Healing', donate: 'Make a donation', rest: 'Room & board…', bank: 'Banking…', repair: 'Repairs…' };
/** Services that continue on the Bank & Repairs page once the server has answered. */
export const SERVICE_PAGES = Object.freeze({ bank: 'townServices', repair: 'townServices', rest: 'dialogue', sellItems: 'dialogue' });

export const serviceLabel = (s) => {
  const label = SERVICE_PAGES[s.id] ? SERVICE_FALLBACK[s.id] : (s.label && s.label !== s.id ? s.label : SERVICE_FALLBACK[s.id] ?? s.id);
  if (s.id === 'heal' || (s.id === 'cure' && Number.isFinite(s.cost))) {
    return s.cost ? `${label} (${s.cost} gold)` : `${label} (free)`;
  }
  return label;
};

/**
 * Replies for the current step of a conversation.
 * @param {object} view    latest server dialogue view
 * @param {object} [o]
 * @param {boolean} [o.more]       more passages follow: only Continue and Goodbye
 * @param {object}  [o.offer]      quest offer from this NPC `{id, title}`
 * @param {object}  [o.prompt]     quest question `{uid, title}` waiting for yes/no
 * @param {boolean} [o.canRepair]  the Bank & Repairs page knows this NPC's counter
 * @param {boolean} [o.canJournal] a Journal page is installed
 * @returns {{id:string,label:string,kind:string,verb?:string,args?:object,panel?:string,
 *   topic?:string,openPanel?:boolean,key?:number|null}[]}
 */
export function replyChoices(view, o = {}) {
  const out = [];
  if (!view?.npc) return out;
  if (o.more) {
    out.push({ id: 'continue', label: 'Continue', kind: 'continue' });
  } else if (o.offer?.id) {
    out.push({ id: 'quest-accept', label: 'I accept.', kind: 'quest', verb: 'quest.accept', args: { offerId: o.offer.id } });
    out.push({ id: 'quest-refuse', label: 'I must decline.', kind: 'quest', verb: 'quest.refuse', args: { offerId: o.offer.id } });
  } else if (o.prompt?.uid) {
    out.push({ id: 'prompt-yes', label: 'Yes.', kind: 'quest', verb: 'quest.answer', args: { uid: o.prompt.uid, yes: true } });
    out.push({ id: 'prompt-no', label: 'No.', kind: 'quest', verb: 'quest.answer', args: { uid: o.prompt.uid, yes: false } });
  } else if (view.summoning) {
    out.push({ id: 'summon-yes', label: `Summon for ${view.summoning.cost.toLocaleString()} gold`, kind: 'service', service: 'summon', confirm: true });
    out.push({ id: 'summon-no', label: 'Decline summoning', kind: 'service', service: 'summon', confirm: false });
  } else if (view.teleport) {
    // Package 15 guild teleport: the destination is picked on the travel map.
    out.push({ id: 'teleport-map', label: 'Choose a destination on the map…', kind: 'teleport' });
  } else {
    // Package 12: goods picked from this shop's shelves and not yet paid for (checkout at the keeper, `shop.pay`).
    const b = view.basket;
    if (b?.basket && b.count > 0 && Number.isInteger(b.total)) {
      out.push({
        id: 'basket-pay', kind: 'pay', verb: 'shop.pay', args: { basket: b.basket, seq: b.seq, total: b.total },
        label: `I'll pay for my basket: ${basketSummary(b)} — ${b.total.toLocaleString()} gold.`,
      });
    }
    for (const t of view.topics ?? []) {
      if (t.id === 'trade' && view.shop) {
        out.push({ id: 'shop', label: 'Show me your wares.', kind: 'panel', panel: 'dialogue' });
      } else {
        out.push({ id: `topic-${t.id}`, label: t.label, kind: 'topic', topic: t.id, openPanel: t.id === 'trade' });
      }
    }
    for (const s of view.services ?? []) {
      if (s.id === 'train') {
        if (view.guild?.training?.length) out.push({ id: 'train', label: 'Training…', kind: 'panel', panel: 'dialogue' });
        continue;
      }
      const args = s.id === 'cure' && Number.isFinite(s.cost) ? { cost: s.cost } : undefined;
      out.push({ id: `svc-${s.id}`, label: serviceLabel(s), kind: 'service', service: s.id, panel: s.locked ? null : (SERVICE_PAGES[s.id] ?? null), args });
    }
    if (o.canRepair && !(view.services ?? []).some((s) => s.id === 'repair')) out.push({ id: 'repairs', label: 'Repairs…', kind: 'panel', panel: 'townServices' });
    if (view.journal && o.canJournal) out.push({ id: 'journal', label: 'Review journal…', kind: 'panel', panel: 'journal' });
  }
  out.push({ id: 'leave', label: 'Goodbye.', kind: 'leave' });
  return out.map((c, i) => ({ ...c, key: i < MAX_NUMBERED ? i + 1 : null }));
}

/** "2 × Candle, Torch" (first three lines, then "and N more"). */
export function basketSummary(b) {
  const lines = Array.isArray(b?.lines) ? b.lines : [];
  const named = lines.slice(0, 3).map((l) => `${l.quantity > 1 ? `${l.quantity} × ` : ''}${l.name}`);
  const more = lines.length - named.length;
  if (!named.length) return `${b?.count ?? 0} item${b?.count === 1 ? '' : 's'}`;
  return more > 0 ? `${named.join(', ')} and ${more} more` : named.join(', ');
}

/** Number key → reply index, or -1. Accepts Digit1–9 and Numpad1–9. */
export function choiceIndexForCode(code, choices) {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(String(code ?? ''));
  if (!m) return -1;
  const n = Number(m[1]);
  return choices.findIndex((c) => c.key === n);
}

/** Is `ev` a quest event this conversation should show instead of the journal's toast? */
export function questEventForTalk(talk, ev, now = Date.now(), windowMs = 2500) {
  if (!talk?.view || !ev || typeof ev.kind !== 'string') return false;
  if (ev.kind === 'questOffer') return ev.giver?.id === talk.view.npc.id;
  if (ev.kind === 'questAccepted' || ev.kind === 'questRefused') return !!talk.offerAnswered;
  if (ev.kind === 'questMessage' || ev.kind === 'questPrompt') {
    // Lines the quest script sends straight after the player spoke to this NPC (talking to a
    // quest person, answering a question) belong to this exchange.
    return Number.isFinite(talk.lastSpokeAt) && now - talk.lastSpokeAt <= windowMs;
  }
  return false;
}

/** Longest "Where is …?" filter sent to the server (it truncates to the same). */
export const ASK_QUERY_CHARS = 40;

/** Case-, accent- and punctuation-free form of a name or filter (server and browser agree on it). */
export const normaliseQuery = (s) => String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Does a `dialogue.subjects` list belong to the conversation on screen (same speaker and session)? */
export function acceptsSubjects(view, ev) {
  return !!view?.npc && ev?.kind === 'dialogue.subjects' && ev.npcId === view.npc.id && ev.session === view.session
    && Array.isArray(ev.subjects);
}

/** Short status line under the "Where is …?" results. */
export function subjectsNote(list) {
  if (!list) return 'Looking…';
  const shown = list.subjects.length;
  if (!shown) return list.query ? `Nobody here knows of “${list.query}”.` : 'There is nowhere in particular to point you to.';
  const more = Math.max(0, (list.total ?? shown) - shown);
  return more ? `${more} more — type part of a name to narrow the list.` : '';
}

/** Status line after a speaker pointed out buildings now marked on the player's own map (`view.learned`). */
export function learnedNote(learned) {
  const names = (Array.isArray(learned) ? learned : []).map((x) => x?.name).filter((n) => typeof n === 'string' && n);
  if (!names.length) return '';
  const list = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `Marked on your map: ${list}.`;
}
