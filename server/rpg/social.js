// Shared-world social play: parties, consensual two-sided trades, party/region/global chat.
// Location chat stays with the runtime (`{type:"chat"}`); this adds `chat.send` channels.
//
// Persistence: each member's `rpg.party = {id, version, leaderId, members:[{id,name}]}`.
// The highest `version` wins when members return after a restart, so a removed member's stale
// copy cannot re-admit them. Trades and invitations are live-only and end on disconnect.
import { randomBytes } from 'node:crypto';
import { CHANNELS, CHAT_BURST, CHAT_RATE_PER_SEC, cleanChatText, isMuted, regionOf, tokenBucket } from './social/chat.js';
import { TRADE_RANGE, describeOffer, goldOf, normaliseOffer, offerProblem, settle } from './social/trade.js';

export const PARTY_MAX = 6;
export const INVITE_TTL_MS = 60_000;
export const REQUEST_TTL_MS = 60_000;
export const KILL_SHARE_RANGE = 48;
const REQUEST_RATE_PER_SEC = 1;
const REQUEST_BURST = 6;

const newId = (prefix) => `${prefix}${randomBytes(6).toString('hex')}`;

function toPlayerId(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isSafeInteger(n)) throw new Error('Choose a player first.');
  return n;
}

function locationOf(p) {
  return p?.rpg?.location ?? 'town:Daggerfall/Gothway Garden';
}

function distance(a, b) {
  return Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.z ?? 0) - (b.z ?? 0));
}

function fingerprint(p) {
  const r = p.rpg ?? {};
  return JSON.stringify([r.inventory ?? [], r.equipment ?? {}, r.gold ?? 0, locationOf(p)]);
}

export function install(ctx) {
  const services = (ctx.services ??= {});
  const now = () => (typeof ctx.now === 'function' ? ctx.now() : Date.now());
  const parties = new Map(); // partyId -> {id, version, leaderId, members: Map<id,{id,name}>}
  const invites = new Map(); // inviteeId -> Map<inviterId, {partyId|null, expires}>
  const trades = new Map(); // tradeId -> trade
  const tradeOf = new Map(); // playerId -> tradeId (pending or open)
  const limits = new WeakMap(); // player -> {chat, request}

  // ---- session-state journal ------------------------------------------------------------------
  // The runtime restores every affected `rpg` (and drops buffered events) when a handler throws or
  // the store save fails, but it cannot see this module's maps. Each mutating action therefore
  // snapshots them, restores them if the handler throws, and stamps the actor's `rpg.socialTxn`
  // with a unique mark. The runtime only keeps that mark if the save committed, so a missing mark
  // (checked in a microtask, and before any later social handler, tick, join or leave) means the
  // action was rolled back and the maps are restored too.
  const BOOT = randomBytes(4).toString('hex');
  let seq = 0;
  let pending = null;
  const captureState = () => structuredClone({ parties, invites, trades, tradeOf });
  function restoreState(saved) {
    for (const [live, copy] of [[parties, saved.parties], [invites, saved.invites], [trades, saved.trades], [tradeOf, saved.tradeOf]]) {
      live.clear();
      for (const [k, v] of copy) live.set(k, v);
    }
  }
  function settlePending() {
    const pd = pending;
    if (!pd) return;
    pending = null;
    if (pd.player.rpg?.socialTxn === pd.mark) return; // committed
    restoreState(pd.state);
    ctx.log?.warn?.(`[social] ${pd.verb} was rolled back by the runtime; session state restored`);
    if (online(pd.player.id)) push(pd.player);
  }
  function txAction(verb, fn) {
    ctx.onAction(verb, (p, args) => {
      settlePending();
      const state = captureState();
      try {
        fn(p, args);
      } catch (err) {
        restoreState(state);
        throw err;
      }
      const mark = `${BOOT}.${++seq}`;
      p.rpg.socialTxn = mark;
      pending = { player: p, mark, state, verb };
      queueMicrotask(settlePending);
    });
  }

  function limiter(p) {
    let l = limits.get(p);
    if (!l) {
      l = { chat: tokenBucket(CHAT_RATE_PER_SEC, CHAT_BURST), request: tokenBucket(REQUEST_RATE_PER_SEC, REQUEST_BURST) };
      limits.set(p, l);
    }
    return l;
  }
  const online = (id) => ctx.players.get(id) ?? null;
  const dirty = (p) => p && typeof ctx.dirty === 'function' && ctx.dirty(p);
  const partyOfPlayer = (p) => {
    const id = p?.rpg?.party?.id;
    const party = id ? parties.get(id) : null;
    return party && party.members.has(p.id) ? party : null;
  };

  // ------------------------------------------------------------ view + notification
  function partyView(party) {
    if (!party) return null;
    return {
      id: party.id,
      leaderId: party.leaderId,
      max: PARTY_MAX,
      members: [...party.members.values()].map((m) => {
        const live = online(m.id);
        return { id: m.id, name: live?.name ?? m.name, online: Boolean(live), location: live ? regionOf(locationOf(live)) : null };
      }),
    };
  }

  function tradeView(trade, p) {
    if (!trade) return null;
    const me = trade.a.id === p.id ? trade.a : trade.b;
    const them = me === trade.a ? trade.b : trade.a;
    const other = online(them.id);
    return {
      id: trade.id,
      state: trade.state,
      revision: trade.revision,
      initiator: trade.a.id === p.id,
      partner: { id: them.id, name: other?.name ?? them.name },
      mine: { items: me.offer.items, gold: me.offer.gold, confirmed: me.confirmed === trade.revision },
      theirs: { items: them.offer.items, gold: them.offer.gold, confirmed: them.confirmed === trade.revision },
      expires: trade.state === 'pending' ? trade.expires : null,
    };
  }

  function view(p) {
    const loc = locationOf(p);
    const party = partyOfPlayer(p);
    const myInvites = [...(invites.get(p.id) ?? new Map())].map(([fromId, inv]) => ({
      fromId,
      fromName: online(fromId)?.name ?? 'Someone',
      expires: inv.expires,
    }));
    const players = [];
    for (const o of ctx.players.values()) {
      if (o.id === p.id) continue;
      const sameLocation = locationOf(o) === loc && (ctx.sameScene?.(o, p) ?? true);
      players.push({
        id: o.id,
        name: o.name,
        region: regionOf(locationOf(o)),
        sameLocation,
        inTradeRange: sameLocation && distance(o, p) <= TRADE_RANGE,
        partyMember: Boolean(party && party.members.has(o.id)),
        inParty: Boolean(partyOfPlayer(o)),
        busy: tradeOf.has(o.id),
      });
    }
    players.sort((x, y) => Number(y.sameLocation) - Number(x.sameLocation) || x.name.localeCompare(y.name));
    const tid = tradeOf.get(p.id);
    return {
      region: regionOf(loc),
      channels: ['location', ...CHANNELS],
      party: partyView(party),
      invites: myInvites,
      outgoing: [...invites].filter(([, m]) => m.has(p.id)).map(([toId]) => ({ toId, toName: online(toId)?.name ?? 'Someone' })),
      trade: tid ? tradeView(trades.get(tid), p) : null,
      players,
      tradeRange: TRADE_RANGE,
    };
  }

  function push(p, text, extra = {}) {
    if (!p || !online(p.id)) return;
    ctx.notify(p, { kind: 'social', ...(text ? { text } : {}), ...extra, social: view(p) });
  }
  function pushParty(party, text, exceptId) {
    if (!party) return;
    for (const m of party.members.keys()) if (m !== exceptId) push(online(m), text);
  }

  // ------------------------------------------------------------ party persistence
  function writeParty(party) {
    const record = {
      id: party.id,
      version: party.version,
      leaderId: party.leaderId,
      members: [...party.members.values()].map((m) => ({ id: m.id, name: m.name })),
    };
    for (const id of party.members.keys()) {
      const p = online(id);
      if (!p?.rpg) continue;
      dirty(p); // before mutating: lets the runtime snapshot members in other locations
      p.rpg.party = structuredClone(record);
    }
  }
  function clearParty(p) {
    if (p?.rpg && p.rpg.party != null) {
      dirty(p);
      delete p.rpg.party;
    }
  }

  function createParty(leader) {
    const party = { id: newId('party_'), version: 1, leaderId: leader.id, members: new Map([[leader.id, { id: leader.id, name: leader.name }]]) };
    parties.set(party.id, party);
    return party;
  }

  function removeMember(party, id) {
    party.members.delete(id);
    party.version += 1;
    if (party.members.size <= 1) {
      // A party of one is no party: disband and clear the last member's record.
      for (const rest of party.members.keys()) {
        const r = online(rest);
        clearParty(r);
        push(r, 'Your party has disbanded.');
      }
      parties.delete(party.id);
      for (const m of invites.values()) for (const [from, inv] of m) if (inv.partyId === party.id) m.delete(from);
      return null;
    }
    if (party.leaderId === id) {
      const next = [...party.members.keys()].find((m) => online(m)) ?? party.members.keys().next().value;
      party.leaderId = next;
    }
    writeParty(party);
    return party;
  }

  // Rebuild membership after restart or reconnect.
  function rejoin(p) {
    const rec = p.rpg?.party;
    if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string') return;
    const roster = Array.isArray(rec.members) ? rec.members.filter((m) => m && Number.isSafeInteger(m.id)) : [];
    let party = parties.get(rec.id);
    const version = Number.isSafeInteger(rec.version) ? rec.version : 0;
    if (!party) {
      if (!roster.some((m) => m.id === p.id)) return clearParty(p);
      party = { id: rec.id, version, leaderId: rec.leaderId ?? p.id, members: new Map(roster.map((m) => [m.id, { id: m.id, name: String(m.name ?? '') }])) };
      parties.set(party.id, party);
    } else if (version > party.version) {
      // This member carries a newer roster: adopt it, dropping anyone removed since.
      const keep = new Map(roster.map((m) => [m.id, { id: m.id, name: String(m.name ?? '') }]));
      for (const id of party.members.keys()) {
        if (!keep.has(id)) {
          const gone = online(id);
          clearParty(gone);
          push(gone, 'You are no longer in that party.');
        }
      }
      party.members = keep;
      party.version = version;
      party.leaderId = keep.has(rec.leaderId) ? rec.leaderId : p.id;
    }
    if (!party.members.has(p.id)) return clearParty(p);
    party.members.get(p.id).name = p.name;
    if (!party.members.has(party.leaderId)) party.leaderId = p.id;
    if (party.members.size <= 1) {
      parties.delete(party.id);
      return clearParty(p);
    }
    writeParty(party);
    pushParty(party, `${p.name} has returned.`, p.id);
  }

  // ------------------------------------------------------------ trades
  function endTrade(trade, reason) {
    if (!trades.has(trade.id)) return;
    trades.delete(trade.id);
    for (const side of [trade.a, trade.b]) if (tradeOf.get(side.id) === trade.id) tradeOf.delete(side.id);
    for (const side of [trade.a, trade.b]) push(online(side.id), reason);
  }

  function rangeProblem(a, b) {
    if (!a || !b) return 'Your trading partner is no longer here.';
    if (locationOf(a) !== locationOf(b) || ctx.sameScene?.(a, b) === false) return `${b.name} is no longer here.`;
    if (distance(a, b) > TRADE_RANGE) return `${b.name} is too far away to trade.`;
    return null;
  }

  // Re-check an open trade. Cancels on invalid state; resets confirmations on any change.
  function refresh(trade) {
    const pa = online(trade.a.id);
    const pb = online(trade.b.id);
    if (!pa || !pb) return endTrade(trade, 'Trade cancelled: your partner left.'), false;
    const far = rangeProblem(pa, pb);
    if (far) return endTrade(trade, `Trade cancelled: ${pa.name} and ${pb.name} are too far apart.`), false;
    if (trade.state === 'pending') {
      if (now() > trade.expires) return endTrade(trade, 'The trade request expired.'), false;
      return true;
    }
    for (const [side, p] of [[trade.a, pa], [trade.b, pb]]) {
      const problem = offerProblem(p.rpg, side.offer);
      if (problem) return endTrade(trade, `Trade cancelled: ${p.name}'s offer changed (${problem})`), false;
    }
    const fa = fingerprint(pa);
    const fb = fingerprint(pb);
    if (fa !== trade.a.print || fb !== trade.b.print) {
      trade.a.print = fa;
      trade.b.print = fb;
      if (trade.a.confirmed || trade.b.confirmed) {
        bump(trade);
        for (const p of [pa, pb]) push(p, 'A pack changed, so the trade needs confirming again.');
      }
    }
    return true;
  }

  function bump(trade) {
    trade.revision += 1;
    trade.a.confirmed = 0;
    trade.b.confirmed = 0;
  }

  function myTrade(p, tradeId) {
    const tid = tradeOf.get(p.id);
    const trade = tid ? trades.get(tid) : null;
    if (!trade || (tradeId !== undefined && String(tradeId) !== trade.id)) throw new Error('That trade is no longer open.');
    const side = trade.a.id === p.id ? trade.a : trade.b;
    const other = side === trade.a ? trade.b : trade.a;
    return { trade, side, other };
  }

  // ------------------------------------------------------------ actions: party
  function rate(p) {
    if (!limiter(p).request()) throw new Error('Slow down a little.');
  }

  ctx.onAction('social.sync', (p) => {
    settlePending();
    push(p);
  });

  txAction('party.invite', (p, args = {}) => {
    const targetId = toPlayerId(args.targetId);
    if (targetId === p.id) throw new Error('You cannot invite yourself.');
    const target = online(targetId);
    if (!target) throw new Error('That player is not online.');
    if (partyOfPlayer(target)) throw new Error(`${target.name} is already in a party.`);
    const party = partyOfPlayer(p);
    if (party && party.leaderId !== p.id) throw new Error('Only the party leader can invite.');
    if (party && party.members.size >= PARTY_MAX) throw new Error(`A party holds at most ${PARTY_MAX}.`);
    const box = invites.get(targetId) ?? new Map();
    if (box.has(p.id)) throw new Error(`You already invited ${target.name}.`);
    rate(p);
    box.set(p.id, { partyId: party?.id ?? null, expires: now() + INVITE_TTL_MS });
    invites.set(targetId, box);
    push(target, `${p.name} invites you to join their party.`, { invite: { fromId: p.id, fromName: p.name } });
    push(p, `Invitation sent to ${target.name}.`);
  });

  function takeInvite(p, fromId) {
    const box = invites.get(p.id);
    const inv = box?.get(fromId);
    if (!inv) throw new Error('That invitation is no longer open.');
    box.delete(fromId);
    if (!box.size) invites.delete(p.id);
    if (now() > inv.expires) throw new Error('That invitation has expired.');
    return inv;
  }

  txAction('party.accept', (p, args = {}) => {
    const fromId = toPlayerId(args.fromId);
    if (partyOfPlayer(p)) throw new Error('Leave your current party first.');
    const inv = takeInvite(p, fromId);
    const inviter = online(fromId);
    if (!inviter) throw new Error('Whoever invited you has left.');
    let party = partyOfPlayer(inviter);
    if (inv.partyId && party?.id !== inv.partyId) throw new Error('That party no longer exists.');
    if (party && party.leaderId !== inviter.id) throw new Error('Whoever invited you is no longer the leader.');
    if (!party) {
      if (inv.partyId) throw new Error('That party no longer exists.');
      party = createParty(inviter);
    }
    if (party.members.size >= PARTY_MAX) throw new Error('That party is full.');
    party.members.set(p.id, { id: p.id, name: p.name });
    party.version += 1;
    // Accepting one invitation answers the rest.
    for (const other of invites.get(p.id)?.keys() ?? []) push(online(other), `${p.name} joined another party.`);
    invites.delete(p.id);
    writeParty(party);
    pushParty(party, `${p.name} joined the party.`, p.id);
    push(p, `You joined ${inviter.name}'s party.`);
  });

  txAction('party.decline', (p, args = {}) => {
    const fromId = toPlayerId(args.fromId);
    const box = invites.get(p.id);
    if (!box?.delete(fromId)) throw new Error('That invitation is no longer open.');
    if (!box.size) invites.delete(p.id);
    push(online(fromId), `${p.name} declined your invitation.`);
    push(p, 'Invitation declined.');
  });

  txAction('party.leave', (p) => {
    const party = partyOfPlayer(p);
    if (!party) throw new Error('You are not in a party.');
    clearParty(p);
    const rest = removeMember(party, p.id);
    pushParty(rest, `${p.name} left the party.`);
    push(p, 'You left the party.');
  });

  txAction('party.kick', (p, args = {}) => {
    const party = partyOfPlayer(p);
    if (!party) throw new Error('You are not in a party.');
    if (party.leaderId !== p.id) throw new Error('Only the party leader can remove members.');
    const targetId = toPlayerId(args.targetId);
    if (targetId === p.id) throw new Error('Use Leave to leave the party.');
    const member = party.members.get(targetId);
    if (!member) throw new Error('That player is not in your party.');
    const target = online(targetId);
    clearParty(target);
    const rest = removeMember(party, targetId);
    pushParty(rest, `${member.name} was removed from the party.`);
    push(target, 'You were removed from the party.');
  });

  txAction('party.promote', (p, args = {}) => {
    const party = partyOfPlayer(p);
    if (!party || party.leaderId !== p.id) throw new Error('Only the party leader can hand over leadership.');
    const targetId = toPlayerId(args.targetId);
    if (!party.members.has(targetId) || targetId === p.id) throw new Error('Choose another party member.');
    party.leaderId = targetId;
    party.version += 1;
    writeParty(party);
    pushParty(party, `${party.members.get(targetId).name} now leads the party.`);
  });

  // ------------------------------------------------------------ actions: trade
  txAction('trade.request', (p, args = {}) => {
    const targetId = toPlayerId(args.targetId);
    if (targetId === p.id) throw new Error('You cannot trade with yourself.');
    const target = online(targetId);
    if (!target) throw new Error('That player is not online.');
    if (tradeOf.has(p.id)) throw new Error('Finish or cancel your current trade first.');
    if (tradeOf.has(targetId)) throw new Error(`${target.name} is busy with another trade.`);
    const far = rangeProblem(p, target);
    if (far) throw new Error(far);
    rate(p);
    const t = now();
    const trade = {
      id: newId('trade_'),
      state: 'pending',
      revision: 1,
      expires: t + REQUEST_TTL_MS,
      a: { id: p.id, name: p.name, offer: { items: [], gold: 0 }, confirmed: 0, print: fingerprint(p) },
      b: { id: target.id, name: target.name, offer: { items: [], gold: 0 }, confirmed: 0, print: fingerprint(target) },
    };
    trades.set(trade.id, trade);
    tradeOf.set(p.id, trade.id);
    tradeOf.set(target.id, trade.id);
    push(target, `${p.name} wants to trade with you.`, { tradeRequest: { tradeId: trade.id, fromId: p.id, fromName: p.name } });
    push(p, `Trade request sent to ${target.name}.`);
  });

  txAction('trade.accept', (p, args = {}) => {
    const { trade } = myTrade(p, args.tradeId);
    if (trade.state !== 'pending' || trade.b.id !== p.id) throw new Error('There is no trade request waiting for you.');
    if (!refresh(trade)) throw new Error('That trade is no longer open.');
    trade.state = 'open';
    trade.expires = null;
    for (const s of [trade.a, trade.b]) push(online(s.id), 'Trade opened. Add items or gold, then both confirm.');
  });

  txAction('trade.decline', (p, args = {}) => {
    const { trade } = myTrade(p, args.tradeId);
    endTrade(trade, trade.state === 'pending' && trade.b.id === p.id ? `${p.name} declined the trade.` : `${p.name} cancelled the trade.`);
  });
  txAction('trade.cancel', (p, args = {}) => {
    const { trade } = myTrade(p, args.tradeId);
    endTrade(trade, `${p.name} cancelled the trade.`);
  });

  txAction('trade.offer', (p, args = {}) => {
    const { trade, side } = myTrade(p, args.tradeId);
    if (trade.state !== 'open') throw new Error('The trade has not been accepted yet.');
    if (args.revision !== undefined && args.revision !== trade.revision) throw new Error('The trade changed; review it and try again.');
    if (!refresh(trade)) throw new Error('That trade is no longer open.');
    const offer = normaliseOffer(p.rpg, { items: args.items, gold: args.gold });
    side.offer = offer;
    bump(trade);
    for (const s of [trade.a, trade.b]) push(online(s.id), s.id === p.id ? 'Offer updated.' : `${p.name} changed their offer.`);
  });

  txAction('trade.confirm', (p, args = {}) => {
    const { trade, side, other } = myTrade(p, args.tradeId);
    if (trade.state !== 'open') throw new Error('The trade has not been accepted yet.');
    if (!refresh(trade)) throw new Error('That trade is no longer open.');
    if (args.revision !== trade.revision) throw new Error('The offer changed; review it and confirm again.');
    if (!side.offer.items.length && !side.offer.gold && !other.offer.items.length && !other.offer.gold) {
      throw new Error('Nothing has been offered yet.');
    }
    side.confirmed = trade.revision;
    if (other.confirmed !== trade.revision) {
      for (const s of [trade.a, trade.b]) push(online(s.id), s.id === p.id ? 'You confirmed. Waiting for your partner.' : `${p.name} confirmed the trade.`);
      return;
    }
    // Both confirmed the same revision: settle atomically.
    const pa = online(trade.a.id);
    const pb = online(trade.b.id);
    const gaveA = describeOffer(pa.rpg, trade.a.offer);
    const gaveB = describeOffer(pb.rpg, trade.b.offer);
    // Both join the one atomic save; marked before mutation so both can be rolled back.
    dirty(pa);
    dirty(pb);
    try {
      settle(services, { player: pa, offer: trade.a.offer }, { player: pb, offer: trade.b.offer });
    } catch (err) {
      // Nothing changed hands; the trade stays open (the journal restores it) for another try.
      throw new Error(`Trade failed and nothing changed hands: ${err.message}`);
    }
    trades.delete(trade.id);
    tradeOf.delete(pa.id);
    tradeOf.delete(pb.id);
    const record = { at: Date.now(), gaveA, gaveB };
    if (typeof ctx.emit === 'function') ctx.emit('trade', { a: pa, b: pb, ...record });
    const line = (o) => [...o.items.map((i) => `${i.quantity} × ${i.name}`), ...(o.gold ? [`${o.gold} gold`] : [])].join(', ') || 'nothing';
    push(pa, `Trade complete. You gave ${line(gaveA)} and received ${line(gaveB)}.`, { tradeDone: true });
    push(pb, `Trade complete. You gave ${line(gaveB)} and received ${line(gaveA)}.`, { tradeDone: true });
  });

  // ------------------------------------------------------------ chat channels
  ctx.onAction('chat.send', (p, args = {}) => {
    settlePending();
    const channel = String(args.channel ?? '');
    if (!CHANNELS.includes(channel)) throw new Error('Choose party, region or global chat.');
    if (isMuted(ctx, p)) throw new Error('You are muted and cannot chat right now.');
    const text = cleanChatText(args.text);
    // Share the runtime's per-player chat budget when present, plus our own as a floor.
    const okShared = typeof p.chatOk === 'function' ? p.chatOk() : true;
    if (!okShared || !limiter(p).chat()) throw new Error('You are chatting too fast.');
    let recipients;
    const region = regionOf(locationOf(p));
    if (channel === 'party') {
      const party = partyOfPlayer(p);
      if (!party) throw new Error('You are not in a party.');
      recipients = [...party.members.keys()].map(online).filter(Boolean);
    } else if (channel === 'region') {
      recipients = [...ctx.players.values()].filter((o) => regionOf(locationOf(o)) === region);
    } else {
      recipients = [...ctx.players.values()];
    }
    const event = { kind: 'chat', channel, fromId: p.id, name: p.name, text, ...(channel === 'region' ? { region } : {}) };
    for (const r of recipients) ctx.notify(r, event);
  });

  // ------------------------------------------------------------ lifecycle
  // Everyone's partner list changes when someone arrives or leaves.
  const pushAll = (exceptId) => {
    for (const o of ctx.players.values()) if (o.id !== exceptId) push(o);
  };

  ctx.onJoin((p) => {
    settlePending();
    rejoin(p);
    pushAll();
  });

  ctx.onLeave((p) => {
    settlePending();
    const tid = tradeOf.get(p.id);
    if (tid && trades.has(tid)) endTrade(trades.get(tid), `Trade cancelled: ${p.name} left.`);
    invites.delete(p.id);
    for (const [toId, box] of invites) {
      if (box.delete(p.id)) push(online(toId));
      if (!box.size) invites.delete(toId);
    }
    const party = partyOfPlayer(p);
    if (party) {
      // Disconnecting keeps membership; the member shows offline.
      const others = [...party.members.keys()].filter((id) => id !== p.id && online(id));
      for (const id of others) push(online(id), `${p.name} went offline.`);
      if (!others.length) parties.delete(party.id); // rebuilt from saved rosters on return
    }
    pushAll(p.id);
  });

  ctx.onTick(() => {
    settlePending();
    const t = now();
    for (const [toId, box] of invites) {
      for (const [fromId, inv] of box) {
        if (t > inv.expires) {
          box.delete(fromId);
          push(online(toId));
          push(online(fromId));
        }
      }
      if (!box.size) invites.delete(toId);
    }
    for (const trade of [...trades.values()]) refresh(trade);
  });

  // Share kill progression with nearby party members via a gameplay event.
  if (typeof ctx.on === 'function') {
    ctx.on('kill', (payload) => {
      const killer = payload?.player;
      const entity = payload?.entity;
      const party = killer && partyOfPlayer(killer);
      if (!party || payload.shared) return;
      for (const id of party.members.keys()) {
        if (id === killer.id) continue;
        const m = online(id);
        if (!m || locationOf(m) !== locationOf(killer) || distance(m, killer) > KILL_SHARE_RANGE) continue;
        dirty(m);
        ctx.emit('partyKill', { player: m, entity, killer, partyId: party.id });
        if (typeof services.creditKill === 'function') services.creditKill(m, entity, { shared: true, killer });
        ctx.notify(m, { kind: 'social', text: `${killer.name} slew ${entity?.name ?? 'a foe'} nearby.`, partyKill: { killerId: killer.id, entityId: entity?.id ?? null } });
      }
    });
  }

  // Cross-feature services.
  services.partyOf = (p) => {
    const party = partyOfPlayer(p);
    return party ? { id: party.id, leaderId: party.leaderId, memberIds: [...party.members.keys()] } : null;
  };
  services.sameParty = (a, b) => {
    const party = partyOfPlayer(a);
    return Boolean(party && party.members.has(b?.id) && partyOfPlayer(b) === party);
  };
  services.tradeOpenFor = (p) => tradeOf.has(p.id);
  services.goldOf = services.goldOf ?? ((p) => goldOf(p?.rpg));

  return { parties, trades, invites, view, settlePending };
}
