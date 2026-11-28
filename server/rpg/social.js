// Shared-world social play: parties, consensual two-sided trades, party/region/global chat,
// account-scoped friends & directed blocks, account mailbox letters, moderation reports,
// and party location sharing / map pings / atomic group travel ready-checks.
//
// Persistence:
//   - Party roster: each member's `rpg.party = {id, version, leaderId, members:[{id,name}]}`.
//     The highest `version` wins when members return after a restart, so a removed member's stale
//     copy cannot re-admit them.
//   - Contacts, directed blocks, privacy settings, reports, and account mailbox letters:
//     persisted via `ctx.dirtyWorld` / `ctx.loadWorld` under `social:*` keys so they survive
//     restarts and character switches on both SQLite and PostgreSQL.
//   - Trades, invitations, map pings, and travel ready checks are live-only and reconcile on leave.
import { randomBytes } from 'node:crypto';
import { CHANNELS, cleanChatText, createChatLimiter, isMuted, regionOf, tokenBucket } from './social/chat.js';
import { PROXIMITY_RANGE, SHOUT_RANGE, canonicalChannel, findWhisperTarget, parseChatCommand, selectChatAudience } from './social/proximity.js';
import { TRADE_RANGE, describeOffer, goldOf, normaliseOffer, offerProblem, settle } from './social/trade.js';
import { accountKeyOf, createContactsService } from './social/contacts.js';
import { createMailboxService } from './social/mailbox.js';
import { createPartyTravelService } from './social/party-travel.js';

export { PROXIMITY_RANGE, SHOUT_RANGE, accountKeyOf };

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
  // Wall-clock UTC ms for persisted timestamps (friends, blocks, letters, reports).
  // Honors injected epoch clocks in tests (>= 1e12), and uses Date.now() when ctx.now() is monotonic performance.now().
  const wallNow = () => {
    const t = now();
    return Number.isFinite(t) && t >= 1_000_000_000_000 ? Math.trunc(t) : Date.now();
  };
  const parties = new Map(); // partyId -> {id, version, leaderId, members: Map<id,{id,name}>}
  const invites = new Map(); // inviteeId -> Map<inviterId, {partyId|null, expires}>
  const trades = new Map(); // tradeId -> trade
  const tradeOf = new Map(); // playerId -> tradeId (pending or open)
  const limits = new WeakMap(); // player -> {chat, request}

  const online = (id) => ctx.players.get(id) ?? null;
  const dirty = (p) => p && typeof ctx.dirty === 'function' && ctx.dirty(p);
  const partyOfPlayer = (p) => {
    const id = p?.rpg?.party?.id;
    const party = id ? parties.get(id) : null;
    return party && party.members.has(p.id) ? party : null;
  };

  // Forward-declared for sub-services; bound below once view/push exist.
  let mailbox;
  let partyTravel;

  const contacts = createContactsService(ctx, {
    now,
    wallNow,
    getLetterForReport: (actorKey, letterId) => mailbox.getLetterForReport(actorKey, letterId),
    onRelationBroken: (blockerKey, targetKey) => {
      // Immediately terminate pending/open trades and party invitations between blocked accounts
      // without telling the blocked player that they were blocked.
      for (const [toId, box] of [...invites]) {
        const toPlayer = online(toId);
        const toKey = toPlayer ? accountKeyOf(toPlayer) : null;
        for (const [fromId] of [...box]) {
          const fromPlayer = online(fromId);
          const fromKey = fromPlayer ? accountKeyOf(fromPlayer) : null;
          if ((fromKey === blockerKey && toKey === targetKey) || (fromKey === targetKey && toKey === blockerKey)) {
            box.delete(fromId);
            if (toPlayer) push(toPlayer);
            if (fromPlayer) push(fromPlayer);
          }
        }
        if (!box.size) invites.delete(toId);
      }
      for (const trade of [...trades.values()]) {
        const pa = online(trade.a.id);
        const pb = online(trade.b.id);
        const ka = pa ? accountKeyOf(pa) : null;
        const kb = pb ? accountKeyOf(pb) : null;
        if ((ka === blockerKey && kb === targetKey) || (ka === targetKey && kb === blockerKey)) {
          endTrade(trade, 'Trade cancelled.');
        }
      }
    },
  });

  mailbox = createMailboxService(ctx, { now, wallNow, contacts });

  // ---- session-state journal ------------------------------------------------------------------
  // The runtime restores every affected `rpg` (and drops buffered events and dirtyWorld rows) when
  // a handler throws or the store save fails, but it cannot see this module's in-memory maps. Each
  // mutating action snapshots them, restores them on throw or rollback, and stamps `rpg.socialTxn`
  // so a failed save also rolls back session state in both the real runtime and mock unit runtimes.
  const BOOT = randomBytes(4).toString('hex');
  let seq = 0;
  let pending = null;
  const captureState = () => ({
    core: structuredClone({ parties, invites, trades, tradeOf }),
    contacts: contacts.capture(),
    mailbox: mailbox.capture(),
    partyTravel: partyTravel.capture(),
  });
  function restoreState(saved) {
    for (const [live, copy] of [
      [parties, saved.core.parties],
      [invites, saved.core.invites],
      [trades, saved.core.trades],
      [tradeOf, saved.core.tradeOf],
    ]) {
      live.clear();
      for (const [k, v] of copy) live.set(k, v);
    }
    contacts.restore(saved.contacts);
    mailbox.restore(saved.mailbox);
    partyTravel.restore(saved.partyTravel);
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
      if (typeof ctx.onRollback === 'function') {
        ctx.onRollback(() => {
          if (pending?.mark === mark) pending = null;
          restoreState(state);
        });
      }
      let mark = null;
      try {
        fn(p, args);
      } catch (err) {
        restoreState(state);
        throw err;
      }
      mark = `${BOOT}.${++seq}`;
      p.rpg.socialTxn = mark;
      pending = { player: p, mark, state, verb };
      queueMicrotask(settlePending);
    });
  }

  function limiter(p) {
    let l = limits.get(p);
    if (!l) {
      l = { chat: createChatLimiter(now), request: tokenBucket(REQUEST_RATE_PER_SEC, REQUEST_BURST) };
      limits.set(p, l);
    }
    return l;
  }

  // ------------------------------------------------------------ view + notification
  function partyView(party, viewer = null) {
    if (!party) return null;
    const extra = partyTravel.partyExtraView(party, viewer);
    return {
      id: party.id,
      leaderId: party.leaderId,
      max: PARTY_MAX,
      myLocationSharing: extra.myLocationSharing,
      leaderDestination: extra.leaderDestination,
      pings: extra.pings,
      travelProposal: extra.travelProposal,
      members: [...party.members.values()].map((m) => {
        const live = online(m.id);
        const locShare = partyTravel.memberLocationView(party, m.id);
        const showLoc = live && (locShare.shared || (viewer && m.id === viewer.id));
        return {
          id: m.id,
          name: live?.name ?? m.name,
          online: Boolean(live),
          location: showLoc ? regionOf(locationOf(live), ctx) : null,
          locationSharing: locShare,
        };
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
        region: regionOf(locationOf(o), ctx),
        sameLocation,
        inTradeRange: sameLocation && distance(o, p) <= TRADE_RANGE,
        partyMember: Boolean(party && party.members.has(o.id)),
        inParty: Boolean(partyOfPlayer(o)),
        busy: tradeOf.has(o.id),
        isFriend: contacts.areFriends(p, o),
        // Only reveal whether the viewer themselves blocked `o` — never whether `o` blocked viewer.
        blockedByMe: contacts.isDirectedBlocked(p, o),
      });
    }
    players.sort((x, y) => Number(y.sameLocation) - Number(x.sameLocation) || x.name.localeCompare(y.name));
    const tid = tradeOf.get(p.id);
    return {
      region: regionOf(loc, ctx),
      channels: ['say', 'shout', ...CHANNELS],
      proximityRange: PROXIMITY_RANGE,
      shoutRange: SHOUT_RANGE,
      party: partyView(party, p),
      invites: myInvites,
      outgoing: [...invites].filter(([, m]) => m.has(p.id)).map(([toId]) => ({ toId, toName: online(toId)?.name ?? 'Someone' })),
      trade: tid ? tradeView(trades.get(tid), p) : null,
      players,
      tradeRange: TRADE_RANGE,
      contacts: contacts.friendsView(p),
      mail: mailbox.summaryView(p),
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
  function pushAccount(acctKey, text, extra = {}) {
    for (const p of contacts.onlinePlayersForAccount(acctKey)) push(p, text, extra);
  }
  function pushFriendsOf(acctKey) {
    for (const friendKey of contacts.friendAccountKeys(acctKey)) {
      pushAccount(friendKey);
    }
  }

  partyTravel = createPartyTravelService(ctx, {
    now,
    wallNow,
    online,
    dirty,
    partyOfPlayer,
    locationOf,
    pushParty,
    push,
  });

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

  function removeMember(party, id, verb = 'left the party') {
    const leavingName = party.members.get(id)?.name ?? online(id)?.name ?? 'A member';
    party.members.delete(id);
    party.version += 1;
    if (party.members.size <= 1) {
      // A party of one is no party: disband and clear the last member's record.
      partyTravel.onPartyDisbanded(party.id);
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
    partyTravel.handleMemberDropped(party, id, leavingName, verb);
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
      partyTravel.onPartyDisbanded(party.id);
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
    if (contacts.isBlocked(pa, pb)) return endTrade(trade, 'Trade cancelled.'), false;
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

  // ------------------------------------------------------------ actions: sync & party
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
    const check = contacts.canInteract(p, target, 'party');
    if (!check.ok) throw new Error(check.reason);
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
    const check = contacts.canInteract(p, inviter, 'party');
    if (!check.ok) throw new Error(check.reason);
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
    const rest = removeMember(party, p.id, 'left the party');
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
    const rest = removeMember(party, targetId, 'was removed from the party');
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

  // ------------------------------------------------------------ actions: party coordination
  txAction('party.locationShare', (p, args = {}) => {
    partyTravel.setLocationSharing(p, args);
  });

  txAction('party.ping', (p, args = {}) => {
    partyTravel.sendPing(p, args);
  });

  ctx.onAction('party.travelQuote', (p, args = {}) => {
    settlePending();
    const quote = partyTravel.quoteToLeader(p, args);
    push(p, null, { partyTravelQuote: quote });
  });

  txAction('party.travelPropose', (p, args = {}) => {
    partyTravel.proposeTravel(p, args);
  });

  txAction('party.travelRespond', (p, args = {}) => {
    partyTravel.respondTravel(p, args);
  });

  txAction('party.travelCancel', (p, args = {}) => {
    partyTravel.cancelTravel(p, args);
  });

  // ------------------------------------------------------------ actions: friends, blocks, privacy, reports
  txAction('friends.request', (p, args = {}) => {
    const res = contacts.sendFriendRequest(p, args);
    if (res.crossed) {
      push(p, `You and ${res.otherLabel} are now friends.`);
      pushAccount(res.otherKey, `${contacts.labelFor(accountKeyOf(p))} accepted your friend request.`);
    } else {
      push(p, `Friend request sent to ${res.otherLabel}.`);
      pushAccount(res.otherKey, `${contacts.labelFor(accountKeyOf(p))} sent you a friend request.`, {
        friendRequest: { fromAccount: accountKeyOf(p), fromLabel: contacts.labelFor(accountKeyOf(p)) },
      });
    }
  });

  txAction('friends.accept', (p, args = {}) => {
    const res = contacts.acceptFriendRequest(p, args);
    push(p, `You are now friends with ${res.otherLabel}.`);
    pushAccount(res.otherKey, `${contacts.labelFor(accountKeyOf(p))} accepted your friend request.`);
  });

  txAction('friends.decline', (p, args = {}) => {
    const res = contacts.declineFriendRequest(p, args);
    push(p, res.withdrew ? `Friend request to ${res.otherLabel} withdrawn.` : `Friend request from ${res.otherLabel} declined.`);
    pushAccount(res.otherKey);
  });

  txAction('friends.remove', (p, args = {}) => {
    const res = contacts.removeFriend(p, args);
    push(p, `Removed ${res.otherLabel} from your friends list.`);
    pushAccount(res.otherKey);
  });

  txAction('friends.settings', (p, args = {}) => {
    contacts.updateSettings(p, args);
    push(p, 'Social privacy settings updated.');
    pushFriendsOf(accountKeyOf(p));
  });

  ctx.onAction('friends.list', (p, args = {}) => {
    settlePending();
    const page = contacts.friendsView(p, args);
    push(p, null, { friendsPage: page });
  });

  txAction('social.block', (p, args = {}) => {
    const res = contacts.blockPlayer(p, args);
    push(p, `Blocked ${res.targetLabel}.`);
    // Refresh blocked party silently without revealing block status.
    if (res.hadRelation) pushAccount(res.targetKey);
  });

  txAction('social.unblock', (p, args = {}) => {
    const res = contacts.unblockPlayer(p, args);
    push(p, `Unblocked ${res.targetLabel}.`);
  });

  txAction('social.report', (p, args = {}) => {
    const res = contacts.submitReport(p, args);
    push(p, 'Report submitted for moderator review.', { reportSubmitted: res });
  });

  // ------------------------------------------------------------ actions: account mailbox
  txAction('mail.send', (p, args = {}) => {
    const res = mailbox.sendLetter(p, args);
    const projected = mailbox.projectLetter(res.letter, accountKeyOf(p), { includeBody: true });
    push(p, res.duplicate ? 'Letter already sent.' : `Letter sent to ${res.letter.toLabel}.`, { mailSent: projected });
    if (!res.duplicate) {
      const recipProjected = mailbox.projectLetter(res.letter, res.recipientKey, { includeBody: true });
      pushAccount(res.recipientKey, `New letter from ${res.letter.fromLabel}: "${res.letter.subject}"`, {
        mailReceived: recipProjected,
      });
    }
  });

  ctx.onAction('mail.list', (p, args = {}) => {
    settlePending();
    const page = mailbox.listLetters(p, args);
    push(p, null, { mailPage: page });
  });

  txAction('mail.thread', (p, args = {}) => {
    const thread = mailbox.getThread(p, args);
    push(p, null, { mailThread: thread });
  });

  txAction('mail.read', (p, args = {}) => {
    const res = mailbox.markRead(p, args);
    push(p, null, { mailRead: res });
  });

  txAction('mail.delete', (p, args = {}) => {
    const res = mailbox.deleteLetter(p, args);
    push(p, 'Letter removed from your mailbox.', { mailDeleted: res });
  });

  // ------------------------------------------------------------ actions: trade
  txAction('trade.request', (p, args = {}) => {
    const targetId = toPlayerId(args.targetId);
    if (targetId === p.id) throw new Error('You cannot trade with yourself.');
    const target = online(targetId);
    if (!target) throw new Error('That player is not online.');
    const check = contacts.canInteract(p, target, 'trade');
    if (!check.ok) throw new Error(check.reason);
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
    const initiator = online(trade.a.id);
    if (initiator) {
      const check = contacts.canInteract(p, initiator, 'trade');
      if (!check.ok) {
        endTrade(trade, 'Trade cancelled.');
        throw new Error(check.reason);
      }
    }
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
  function chatAudience(sender, rawChannel = 'say', options = {}) {
    return selectChatAudience(ctx, sender, rawChannel, { party: partyOfPlayer(sender), ...options });
  }

  ctx.onAction('chat.send', (p, args = {}) => {
    settlePending();
    const channel = canonicalChannel(args.channel);
    if (!channel) throw new Error('Choose say, shout, party, region, global or whisper chat.');
    if (channel === 'whisper' && !args.target && args.targetId == null) {
      throw new Error('Choose a player to whisper to.');
    }
    if (isMuted(ctx, p)) throw new Error('You are muted and cannot chat right now.');
    const text = cleanChatText(args.text);
    // Share the runtime's per-player chat budget when present, plus our own as a floor.
    const okShared = typeof p.chatOk === 'function' ? p.chatOk() : true;
    // Per-channel budgets (CHAT_LIMITS): say/emote/shout use the local one; global stays tightest.
    const budget = channel === 'say' || channel === 'emote' || channel === 'shout' ? 'local' : channel;
    if (!okShared || !limiter(p).chat(budget)) throw new Error('You are chatting too fast.');
    const region = regionOf(locationOf(p), ctx);
    const whisperTo = channel === 'whisper'
      ? findWhisperTarget(ctx.players, p, { target: args.target, targetId: args.targetId })
      : null;
    if (whisperTo) {
      const check = contacts.canInteract(p, whisperTo, 'whisper');
      if (!check.ok) throw new Error(check.reason);
    }
    const recipients = chatAudience(p, channel, { recipient: whisperTo });
    const party = channel === 'party' ? partyOfPlayer(p) : null;
    // Moderation needs every delivered line on record: a failed (synchronous) write is not delivered.
    const logged = ctx.services.logChat?.(p, {
      channel,
      location: locationOf(p),
      targetPlayerId: whisperTo?.id ?? null,
      targetName: whisperTo?.name ?? null,
      groupId: party?.id ?? null,
      recipientIds: recipients.filter((r) => r.id !== p.id).map((r) => r.id),
      text,
    });
    if (logged === null) throw new Error('Chat is unavailable right now.');
    const event = {
      kind: 'chat',
      channel,
      fromId: p.id,
      name: p.name,
      text,
      ...(channel === 'region' ? { region } : {}),
      ...(whisperTo ? { toId: whisperTo.id, toName: whisperTo.name } : {}),
    };
    for (const r of recipients) ctx.notify(r, event);
  });

  // ------------------------------------------------------------ lifecycle & cleanup
  function handleAccountDeleted(accountId) {
    const affectedFriends = contacts.onAccountDeleted(accountId);
    mailbox.onAccountDeleted(accountId);
    for (const friendKey of affectedFriends) pushAccount(friendKey);
  }

  function handleCharacterArchived(accountId, charId) {
    contacts.onCharacterArchived(accountId, charId);
    const key = accountKeyOf(accountId);
    if (key) pushFriendsOf(key);
  }

  function handleModeration(accountId) {
    const key = accountKeyOf(accountId);
    if (key) pushFriendsOf(key);
  }

  // Everyone's partner list changes when someone arrives or leaves.
  const pushAll = (exceptId) => {
    for (const o of ctx.players.values()) if (o.id !== exceptId) push(o);
  };

  ctx.onJoin((p) => {
    settlePending();
    const { accountKey } = contacts.registerPlayer(p);
    rejoin(p);
    pushFriendsOf(accountKey);
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
      // Disconnecting keeps membership; the member shows offline and any ready check updates.
      partyTravel.handleMemberDropped(party, p.id, p.name, 'disconnected');
      const others = [...party.members.keys()].filter((id) => id !== p.id && online(id));
      for (const id of others) push(online(id), `${p.name} went offline.`);
      if (!others.length) {
        parties.delete(party.id); // rebuilt from saved rosters on return
        partyTravel.onPartyDisbanded(party.id);
      }
    }
    const acctKey = contacts.markOffline(p);
    if (acctKey) pushFriendsOf(acctKey);
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
    partyTravel.tick(parties);
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
    ctx.on('connectionReset', (payload) => {
      if (payload?.player) push(payload.player);
    });
    ctx.on('accountDeleted', (payload) => {
      if (payload?.accountId != null) handleAccountDeleted(payload.accountId);
    });
    ctx.on('characterArchived', (payload) => {
      if (payload?.accountId != null && payload?.characterId != null) {
        handleCharacterArchived(payload.accountId, payload.characterId);
      }
    });
    ctx.on('moderation', (payload) => {
      if (payload?.accountId != null) handleModeration(payload.accountId);
    });
  }

  // Cross-feature services (including Wave 2 visits/duels/character-slots hooks).
  services.partyOf = (p) => {
    const party = partyOfPlayer(p);
    return party ? { id: party.id, leaderId: party.leaderId, memberIds: [...party.members.keys()] } : null;
  };
  services.sameParty = (a, b) => {
    const party = partyOfPlayer(a);
    return Boolean(party && party.members.has(b?.id) && partyOfPlayer(b) === party);
  };
  services.tradeOpenFor = (p) => tradeOf.has(p.id);
  // The other side of p's pending or open trade, or null. Crowd culling keeps it visible (server/game.js, runtime.js).
  services.tradePartnerOf = (p) => {
    const t = trades.get(tradeOf.get(p?.id));
    return t ? (t.a.id === p.id ? t.b.id : t.a.id) : null;
  };
  services.goldOf = services.goldOf ?? ((p) => goldOf(p?.rpg));
  services.chatAudience = chatAudience;
  services.parseChatCommand = parseChatCommand;

  // Account-scoped contacts, directed blocks, reports, mailbox, and party travel hooks.
  services.accountKeyOf = accountKeyOf;
  services.isDirectedBlocked = (blocker, target) => contacts.isDirectedBlocked(blocker, target);
  services.isBlocked = (a, b) => contacts.isBlocked(a, b);
  services.areFriends = (a, b) => contacts.areFriends(a, b);
  services.canInteract = (actor, target, kind = 'default') => contacts.canInteract(actor, target, kind);
  services.socialContacts = {
    accountKeyOf,
    isBlocked: services.isBlocked,
    isDirectedBlocked: services.isDirectedBlocked,
    areFriends: services.areFriends,
    canInteract: services.canInteract,
    onAccountDeleted: handleAccountDeleted,
    onCharacterArchived: handleCharacterArchived,
    onModeration: handleModeration,
    listReports: (opts) => contacts.listReports(opts),
    getReport: (id) => contacts.getReport(id),
  };
  services.mailbox = {
    unreadCount: (p) => mailbox.unreadCount(accountKeyOf(p)),
    onAccountDeleted: (accountId) => mailbox.onAccountDeleted(accountId),
  };
  services.partyTravel = {
    isRestrictedArea: (p) => partyTravel.isRestrictedArea(p),
    memberLocationView: (party, id) => partyTravel.memberLocationView(party, id),
    quoteToLeader: (p, args) => partyTravel.quoteToLeader(p, args),
  };

  return { parties, trades, invites, contacts, mailbox, partyTravel, view, settlePending, chatAudience };
}
