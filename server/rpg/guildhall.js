// Classic Guilds overview/chat/resign + Player-Founded Multiplayer Orders (world_state `pguild:<id>`).
//
// Owns:
//   - Classic guild overview (rank progress, skill/rep/cooldown gates, perks, online fellow members)
//   - Full classic directory (6 guild families, 8 Temples, 10 Knightly Orders)
//   - Classic guild resign & private guild-channel chat (classic guilds + player orders)
//   - Player-founded persistent multiplayer guilds/orders stored in `world_state` as `pguild:<id>`
//     with rank hierarchy (Leader, Officer, Member), invites, MOTD, and atomic shared treasury.
//   - Compact `p.rpg.playerGuild = { id, name, tag, rank }` projection for HUD & peers.

import { randomBytes } from 'node:crypto';
import {
  DIVINES, GROUPS, ORDERS, SERVICE, RANK_CHANGE_DAYS,
  RANK_REQ_REPUTATION, RANK_REQ_SKILL_HIGH, RANK_REQ_SKILL_LOW,
  groupName, guildSkills, trainingSkills, privileges, rankTitle, repFaction, isGroup, factionTable,
} from './guilds/rules.js';
import { groupKey } from './guilds.js';
import { cleanChatText, createChatLimiter, isMuted, regionOf, tokenBucket } from './social/chat.js';
import { regionNameOf } from '../../client/gameplay/travel/identity.js';

export const name = 'guildhall';
export const PGUILD_PREFIX = 'pguild:';
export const ORDER_RANKS = Object.freeze(['Member', 'Officer', 'Leader']);
export const ORDER_MAX_MEMBERS = 50;
export const ORDER_INVITE_TTL_MS = 5 * 60_000;
export const ORDER_MAX_NAME = 32;
export const ORDER_MIN_NAME = 3;
export const ORDER_MAX_MOTD = 200;
export const ORDER_LEDGER_MAX = 20;

const REQUEST_RATE_PER_SEC = 1;
const REQUEST_BURST = 6;
const TAG_RE = /^[A-Z0-9]{2,5}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const PRIV_LABEL = Object.freeze({
  ...SERVICE,
  rest: 'Rest in hall',
  hallAnytime: 'Hall access anytime',
  freeHealing: 'Free healing',
  freeRooms: 'Free tavern rooms',
  freeShips: 'Free ship passage',
});

const TEMPLE_SPECIAL_PERKS = Object.freeze({
  26: 'Faster overland travel ((95 - rank)% journey time)',
  21: 'Reduced disease cure cost ((10 - rank)/10)',
  29: 'Blessing of Luck (+1 Luck for 3 days)',
  27: 'Blessing of Intelligence (+1 Intelligence for 3 days)',
  35: 'Longer underwater breath ((10 + rank)/10)',
  24: 'Blessing of Personality (+1 Personality for 3 days)',
  33: 'Chance to avoid fatal blows (rank/50 when not underwater)',
  22: 'Blessing of Mercantile (+1 Mercantile for 3 days)',
});

const FAMILY_ORDER = Object.freeze(['fighters', 'mages', 'thieves', 'brotherhood', 'temple', 'knights']);

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const newOrderId = () => `pg_${randomBytes(6).toString('hex')}`;
const cleanText = (raw) => String(raw ?? '').normalize('NFC').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
const rankWeight = (rank) => ORDER_RANKS.indexOf(rank);

function toPlayerId(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isSafeInteger(n)) throw new Error('Choose a player first.');
  return n;
}

function toPositiveGold(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('Enter a whole gold amount of at least 1.');
  return n;
}

function skillValue(c, skill) {
  return Math.max(0, Math.trunc(Number(c?.skills?.[skill]) || 0));
}

function goldOf(p) {
  const g = p?.rpg?.gold;
  return Number.isSafeInteger(g) && g > 0 ? g : 0;
}

function normalizeOrderRecord(raw) {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const cleanName = cleanText(raw.name);
  const cleanTag = cleanText(raw.tag).toUpperCase();
  if (cleanName.length < ORDER_MIN_NAME || cleanName.length > ORDER_MAX_NAME || !TAG_RE.test(cleanTag)) return null;
  const members = {};
  if (isObj(raw.members)) {
    for (const m of Object.values(raw.members)) {
      if (!isObj(m) || !Number.isSafeInteger(m.id)) continue;
      const rank = ORDER_RANKS.includes(m.rank) ? m.rank : 'Member';
      members[String(m.id)] = {
        id: m.id,
        name: cleanText(m.name) || `Player ${m.id}`,
        rank,
        joinedAt: typeof m.joinedAt === 'string' ? m.joinedAt : new Date().toISOString(),
      };
    }
  }
  const memberList = Object.values(members);
  if (!memberList.length) return null;
  let leaderId = Number.isSafeInteger(raw.leaderId) && members[String(raw.leaderId)] ? raw.leaderId : null;
  if (leaderId == null) {
    const foundLeader = memberList.find((m) => m.rank === 'Leader') ?? memberList[0];
    leaderId = foundLeader.id;
  }
  for (const m of memberList) {
    if (m.id === leaderId) m.rank = 'Leader';
    else if (m.rank === 'Leader') m.rank = 'Officer';
  }
  const ledger = Array.isArray(raw.ledger)
    ? raw.ledger.filter((e) => isObj(e) && (e.kind === 'deposit' || e.kind === 'withdraw') && Number.isSafeInteger(e.amount) && e.amount > 0).slice(-ORDER_LEDGER_MAX)
    : [];
  return {
    id: raw.id,
    name: cleanName,
    tag: cleanTag,
    motd: cleanText(raw.motd).slice(0, ORDER_MAX_MOTD),
    treasury: Number.isSafeInteger(raw.treasury) && raw.treasury >= 0 ? raw.treasury : 0,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    leaderId,
    members,
    ledger,
  };
}

export function install(ctx, options = {}) {
  const services = (ctx.services ||= {});
  const foundingFee = Number.isSafeInteger(options.foundingFee) && options.foundingFee >= 0 ? options.foundingFee : 0;
  const now = () => (typeof ctx.now === 'function' ? ctx.now() : Date.now());
  const fallbackTable = factionTable(null);
  const table = () => services.guilds?.table ?? fallbackTable;

  const clock = () => (typeof services.worldClock === 'function' ? services.worldClock() : null);
  const minutesNow = () => {
    const c = clock();
    return c && Number.isFinite(c.minutes) ? Math.trunc(c.minutes) : Math.floor(now() / 60_000);
  };
  const today = () => Math.floor(minutesNow() / 1440);
  const locationOf = (p) => ctx.location?.(p) ?? p?.rpg?.location ?? 'town:Daggerfall/Gothway Garden';
  const online = (id) => ctx.players?.get(id) ?? null;
  const dirty = (p) => { if (p && typeof ctx.dirty === 'function') ctx.dirty(p); };

  // ---------------------------------------------------------------- player-founded orders state

  const orders = new Map();       // orderId -> orderRecord
  const memberOrder = new Map();  // playerId -> orderId
  const nameIndex = new Map();    // lowerName -> orderId
  const tagIndex = new Map();     // upperTag -> orderId
  const orderInvites = new Map(); // inviteeId -> Map<orderId, { orderId, orderName, orderTag, fromId, fromName, expires }>
  const limits = new WeakMap();   // player -> { chat, request }

  function rebuildIndexes() {
    memberOrder.clear();
    nameIndex.clear();
    tagIndex.clear();
    for (const ord of orders.values()) {
      nameIndex.set(ord.name.toLowerCase(), ord.id);
      tagIndex.set(ord.tag.toUpperCase(), ord.id);
      for (const m of Object.values(ord.members)) memberOrder.set(m.id, ord.id);
    }
  }

  for (const [key, val] of ctx.loadWorld?.(PGUILD_PREFIX) ?? []) {
    if (!key.startsWith(PGUILD_PREFIX)) continue;
    const rec = normalizeOrderRecord(val);
    if (!rec) continue;
    orders.set(rec.id, rec);
  }
  rebuildIndexes();

  function limiter(p) {
    let l = limits.get(p);
    if (!l) {
      l = { chat: createChatLimiter(now), request: tokenBucket(REQUEST_RATE_PER_SEC, REQUEST_BURST, now) };
      limits.set(p, l);
    }
    return l;
  }

  function rateRequest(p) {
    if (!limiter(p).request()) throw new Error('Slow down a little.');
  }

  // Transactional wrapper: snapshots module maps and restores on handler throw OR runtime save failure.
  function captureState() {
    return {
      orders: structuredClone(orders),
      orderInvites: structuredClone(orderInvites),
    };
  }

  function restoreState(snap) {
    orders.clear();
    for (const [k, v] of snap.orders) orders.set(k, v);
    orderInvites.clear();
    for (const [k, v] of snap.orderInvites) orderInvites.set(k, v);
    rebuildIndexes();
  }

  function txAction(verb, fn) {
    ctx.onAction(verb, (p, args) => {
      const snap = captureState();
      if (typeof ctx.onRollback === 'function') {
        ctx.onRollback(() => restoreState(snap));
        return fn(p, args);
      }
      try {
        return fn(p, args);
      } catch (err) {
        restoreState(snap);
        throw err;
      }
    });
  }

  function persistOrder(ord) {
    ctx.dirtyWorld?.(`${PGUILD_PREFIX}${ord.id}`, structuredClone(ord));
  }

  function deletePersistedOrder(orderId) {
    ctx.dirtyWorld?.(`${PGUILD_PREFIX}${orderId}`, null);
  }

  function orderOf(p) {
    if (!p) return null;
    const id = memberOrder.get(p.id);
    return id ? orders.get(id) ?? null : null;
  }

  function syncProjection(p, { markDirty = true } = {}) {
    if (!p?.rpg) return;
    const ord = orderOf(p);
    const mem = ord?.members?.[String(p.id)] ?? null;
    const next = ord && mem ? { id: ord.id, name: ord.name, tag: ord.tag, rank: mem.rank } : null;
    const cur = p.rpg.playerGuild ?? null;
    if (JSON.stringify(cur) === JSON.stringify(next)) return;
    if (markDirty) dirty(p);
    if (next) p.rpg.playerGuild = next;
    else delete p.rpg.playerGuild;
  }

  function takeGold(p, amount) {
    if (goldOf(p) < amount) throw new Error(`You only have ${goldOf(p)} gold.`);
    dirty(p);
    if (typeof services.takeGold === 'function') {
      services.takeGold(p, amount);
    } else {
      p.rpg.gold = goldOf(p) - amount;
    }
  }

  function addGold(p, amount) {
    dirty(p);
    if (typeof services.addGold === 'function') {
      for (let left = amount; left > 0; left -= 9999) services.addGold(p, Math.min(9999, left));
    } else {
      p.rpg.gold = goldOf(p) + amount;
    }
  }

  function pruneInvites(playerId) {
    const box = orderInvites.get(playerId);
    if (!box) return;
    const t = now();
    for (const [oid, inv] of box) {
      if (t > inv.expires || !orders.has(oid)) box.delete(oid);
    }
    if (!box.size) orderInvites.delete(playerId);
  }

  function clearOrderInvites(orderId) {
    for (const [pid, box] of orderInvites) {
      box.delete(orderId);
      if (!box.size) orderInvites.delete(pid);
    }
  }

  // ---------------------------------------------------------------- classic guild helpers

  function repOf(p, factionId) {
    if (factionId == null) return 0;
    if (typeof services.guilds?.reputation === 'function') return services.guilds.reputation(p, factionId);
    const v = p?.rpg?.factions?.[factionId];
    return Number.isFinite(v) ? v : 0;
  }

  function privilegeBreakdown(group, variant, rank) {
    const cur = privileges(group, variant, rank);
    const unlocked = cur.map((id) => ({ id, label: PRIV_LABEL[id] ?? id }));
    const seen = new Set(cur);
    const upcoming = [];
    for (let r = rank + 1; r <= 9; r++) {
      for (const id of privileges(group, variant, r)) {
        if (seen.has(id)) continue;
        seen.add(id);
        upcoming.push({ id, label: PRIV_LABEL[id] ?? id, rank: r, rankTitle: rankTitle(group, r) });
      }
    }
    return { unlocked, upcoming };
  }

  function allPrivilegesByRank(group, variant) {
    const seen = new Set();
    const out = [];
    for (let r = 0; r <= 9; r++) {
      for (const id of privileges(group, variant, r)) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, label: PRIV_LABEL[id] ?? id, rank: r, rankTitle: rankTitle(group, r) });
      }
    }
    return out;
  }

  function nextRankProgress(c, group, variant, m, rep, day) {
    if (m.rank >= 9) {
      return {
        maxRank: true,
        nextRank: null,
        nextRankTitle: null,
        reputation: { current: rep, required: RANK_REQ_REPUTATION[9], met: true },
        topSkill: null,
        secondSkill: null,
        cooldown: { daysRemaining: 0, nextRankDay: null, lastRankChange: m.lastRankChange ?? null, met: true },
        ready: false,
      };
    }
    const nr = m.rank + 1;
    const reqRep = RANK_REQ_REPUTATION[nr];
    const reqHigh = RANK_REQ_SKILL_HIGH[nr];
    const reqLow = RANK_REQ_SKILL_LOW[nr];
    const list = guildSkills(group, variant)
      .map((s) => ({ name: s, value: skillValue(c, s) }))
      .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
    const top1 = list[0] ?? { name: null, value: 0 };
    const top2 = list[1] ?? { name: null, value: 0 };
    const repMet = rep >= reqRep;
    const top1Met = top1.value >= reqHigh;
    const top2Met = top2.value >= reqLow;
    const lastChange = Number.isFinite(m.lastRankChange) ? Math.trunc(m.lastRankChange) : null;
    const nextRankDay = lastChange != null ? lastChange + RANK_CHANGE_DAYS : day;
    const daysRemaining = lastChange != null ? Math.max(0, nextRankDay - day) : 0;
    const cooldownMet = daysRemaining === 0;
    return {
      maxRank: false,
      nextRank: nr,
      nextRankTitle: rankTitle(group, nr),
      reputation: { current: rep, required: reqRep, met: repMet },
      topSkill: { name: top1.name, current: top1.value, required: reqHigh, met: top1Met },
      secondSkill: { name: top2.name, current: top2.value, required: reqLow, met: top2Met },
      cooldown: { daysRemaining, nextRankDay, lastRankChange: lastChange, met: cooldownMet },
      ready: repMet && top1Met && top2Met && cooldownMet,
    };
  }

  function onlineFellows(p, group, variant) {
    const out = [];
    for (const q of ctx.players?.values?.() ?? []) {
      const m = q?.rpg?.guilds?.[group];
      if (!m) continue;
      if ((group === 'temple' || group === 'knights') && m.variant !== variant) continue;
      out.push({
        id: q.id,
        name: q.name,
        rank: m.rank,
        rankTitle: rankTitle(group, m.rank),
        region: regionOf(locationOf(q), ctx),
        self: q.id === p.id,
      });
    }
    out.sort((a, b) => Number(b.self) - Number(a.self) || b.rank - a.rank || a.name.localeCompare(b.name));
    return out;
  }

  // ---------------------------------------------------------------- views

  function orderView(ord, viewerId) {
    if (!ord) return null;
    const members = Object.values(ord.members).map((m) => {
      const live = online(m.id);
      return {
        id: m.id,
        name: live?.name ?? m.name,
        rank: m.rank,
        online: Boolean(live),
        region: live ? regionOf(locationOf(live), ctx) : null,
        joinedAt: m.joinedAt,
        self: m.id === viewerId,
      };
    });
    members.sort((a, b) =>
      rankWeight(b.rank) - rankWeight(a.rank) ||
      Number(b.online) - Number(a.online) ||
      a.name.localeCompare(b.name),
    );
    const me = ord.members[String(viewerId)] ?? null;
    return {
      id: ord.id,
      name: ord.name,
      tag: ord.tag,
      motd: ord.motd,
      treasury: ord.treasury,
      createdAt: ord.createdAt,
      leaderId: ord.leaderId,
      myRank: me?.rank ?? null,
      maxMembers: ORDER_MAX_MEMBERS,
      members,
      ledger: [...ord.ledger].reverse(),
    };
  }

  function overviewOf(p) {
    const t = table();
    const day = today();
    const c = p?.rpg?.character ?? null;
    const rawGuilds = isObj(p?.rpg?.guilds) ? p.rpg.guilds : {};
    const memberships = [];
    for (const group of FAMILY_ORDER) {
      const m = rawGuilds[group];
      if (!isObj(m)) continue;
      const variant = m.variant ?? null;
      const fid = repFaction(group, variant);
      const rep = repOf(p, fid);
      memberships.push({
        group,
        variant,
        name: groupName(t, group, variant),
        factionId: fid,
        rank: m.rank,
        rankTitle: rankTitle(group, m.rank),
        reputation: rep,
        joinedAt: m.joinedAt ?? null,
        skills: guildSkills(group, variant).map((s) => ({ name: s, value: skillValue(c, s) })),
        nextRank: nextRankProgress(c, group, variant, m, rep, day),
        privileges: privilegeBreakdown(group, variant, m.rank),
        onlineMembers: onlineFellows(p, group, variant),
      });
    }
    pruneInvites(p.id);
    const myOrder = orderOf(p);
    const invites = [...(orderInvites.get(p.id)?.values?.() ?? [])].map((inv) => ({
      orderId: inv.orderId,
      orderName: inv.orderName,
      orderTag: inv.orderTag,
      fromId: inv.fromId,
      fromName: inv.fromName,
      expires: inv.expires,
    }));
    const onlinePlayers = [];
    for (const q of ctx.players?.values?.() ?? []) {
      if (q.id === p.id) continue;
      const qOrd = orderOf(q);
      onlinePlayers.push({
        id: q.id,
        name: q.name,
        region: regionOf(locationOf(q), ctx),
        inOrder: Boolean(qOrd),
        orderTag: qOrd?.tag ?? null,
        inMyOrder: Boolean(myOrder && qOrd && qOrd.id === myOrder.id),
      });
    }
    onlinePlayers.sort((a, b) => a.name.localeCompare(b.name));
    return {
      day,
      gold: goldOf(p),
      foundingFee,
      memberships,
      order: orderView(myOrder, p.id),
      orderInvites: invites,
      onlinePlayers,
    };
  }

  function directoryOf(p) {
    const t = table();
    const rawGuilds = isObj(p?.rpg?.guilds) ? p.rpg.guilds : {};
    const families = FAMILY_ORDER.map((id) => {
      const g = GROUPS[id];
      const m = rawGuilds[id] ?? null;
      const rep = g.factionId != null ? repOf(p, g.factionId) : null;
      return {
        id,
        name: g.factionId != null ? groupName(t, id, null) : g.name,
        factionId: g.factionId,
        inviteOnly: Boolean(g.invite),
        noExpulsion: Boolean(g.noExpulsion),
        exclusiveVariant: Boolean(g.variants),
        skills: g.skills ? [...g.skills] : [],
        training: g.training ? [...g.training] : [],
        ranks: [...g.ranks],
        perks: g.factionId != null ? allPrivilegesByRank(id, null) : [],
        reputation: rep,
        member: m ? { rank: m.rank, rankTitle: rankTitle(id, m.rank), variant: m.variant ?? null } : null,
      };
    });
    const temples = Object.entries(DIVINES).map(([didStr, v]) => {
      const deityId = Number(didStr);
      const m = rawGuilds.temple?.variant === deityId ? rawGuilds.temple : null;
      return {
        deityId,
        orderId: v.order,
        deity: v.name,
        name: groupName(t, 'temple', deityId),
        blessing: v.blessing,
        specialPerk: TEMPLE_SPECIAL_PERKS[deityId] ?? null,
        exclusive: true,
        skills: [...v.skills],
        training: [...v.training],
        perks: allPrivilegesByRank('temple', deityId),
        reputation: repOf(p, deityId),
        member: m ? { rank: m.rank, rankTitle: rankTitle('temple', m.rank) } : null,
      };
    });
    const ordersList = Object.entries(ORDERS).map(([fidStr, v]) => {
      const factionId = Number(fidStr);
      const m = rawGuilds.knights?.variant === factionId ? rawGuilds.knights : null;
      return {
        factionId,
        name: groupName(t, 'knights', factionId),
        regionIndex: v.region,
        region: regionNameOf(v.region),
        exclusive: true,
        skills: [...GROUPS.knights.skills],
        perks: allPrivilegesByRank('knights', factionId),
        specialPerks: [
          `Free tavern rooms in ${regionNameOf(v.region)} at any rank (and everywhere at rank 4+)`,
          'Free ship passage at rank 6+',
          'One piece of rank-material armour per rank',
          'A town house deed at rank 9 (Grand Master)',
        ],
        reputation: repOf(p, factionId),
        member: m ? { rank: m.rank, rankTitle: rankTitle('knights', m.rank) } : null,
      };
    });
    return { families, temples, orders: ordersList };
  }

  function pushOverview(p, action, text, extra = {}) {
    if (!p || !online(p.id)) return;
    ctx.notify(p, { kind: 'guild', action, ...(text ? { text } : {}), ...extra, overview: overviewOf(p) });
  }

  function pushOrderMembers(ord, action, text, exceptId = null) {
    if (!ord) return;
    for (const m of Object.values(ord.members)) {
      if (m.id === exceptId) continue;
      const live = online(m.id);
      if (live) pushOverview(live, action, text);
    }
  }

  // ---------------------------------------------------------------- classic guild actions

  ctx.onAction('guild.overview', (p) => {
    pushOverview(p, 'overview');
  });

  ctx.onAction('guild.directory', (p) => {
    ctx.notify(p, { kind: 'guild', action: 'directory', directory: directoryOf(p) });
  });

  ctx.onAction('guild.resign', (p, args = {}) => {
    const group = groupKey(args.group);
    if (!group || !isGroup(group)) throw new Error('Choose a guild to resign from.');
    const guilds = p?.rpg?.guilds;
    const m = isObj(guilds) ? guilds[group] : null;
    if (!m) throw new Error('You are not a member of that guild.');
    const label = groupName(table(), group, m.variant);
    const variant = m.variant ?? null;
    dirty(p);
    services.guilds.resign(p, group);
    ctx.emit?.('guildResign', { player: p, guild: group, variant });
    pushOverview(p, 'resign', `You have resigned from ${label}.`, { group, variant });
  });

  ctx.onAction('guild.chat', (p, args = {}) => {
    if (isMuted(ctx, p)) throw new Error('You are muted and cannot chat right now.');
    const text = cleanChatText(args.text);
    const okShared = typeof p.chatOk === 'function' ? p.chatOk() : true;
    // Guild and order channels are group conversation: the party budget (CHAT_LIMITS), not the tight global one.
    if (!okShared || !limiter(p).chat('party')) throw new Error('You are chatting too fast.');

    const scope = args.scope === 'order' || args.group === 'order' ? 'order' : 'classic';
    if (scope === 'order') {
      const ord = orderOf(p);
      if (!ord) throw new Error('You are not in a player order.');
      const me = ord.members[String(p.id)];
      const ev = {
        kind: 'guildChat',
        scope: 'order',
        orderId: ord.id,
        tag: ord.tag,
        channelName: `[${ord.tag}] ${ord.name}`,
        fromId: p.id,
        name: p.name,
        rankTitle: me?.rank ?? 'Member',
        text,
        at: now(),
      };
      const heard = Object.values(ord.members).map((m) => online(m.id)).filter(Boolean);
      // Moderation needs every delivered line on record, with who heard it: a failed (synchronous) write is not delivered.
      const logged = ctx.services?.logChat?.(p, {
        channel: 'order',
        location: p?.rpg?.location ?? '',
        groupId: ord.id,
        recipientIds: heard.filter((q) => q.id !== p.id).map((q) => q.id),
        text,
      });
      if (logged === null) throw new Error('Chat is unavailable right now.');
      for (const live of heard) ctx.notify(live, ev);
      return;
    }

    const group = groupKey(args.group);
    if (!group || !isGroup(group)) throw new Error('Choose a guild channel.');
    const m = p?.rpg?.guilds?.[group];
    if (!m) throw new Error('You are not a member of that guild.');
    const variant = m.variant ?? null;
    const channelName = groupName(table(), group, variant);
    const ev = {
      kind: 'guildChat',
      scope: 'classic',
      group,
      variant,
      channelName,
      fromId: p.id,
      name: p.name,
      rankTitle: rankTitle(group, m.rank),
      text,
      at: now(),
    };
    const heard = [...(ctx.players?.values?.() ?? [])].filter((q) => {
      const qm = q?.rpg?.guilds?.[group];
      return qm && !((group === 'temple' || group === 'knights') && qm.variant !== variant);
    });
    const logged = ctx.services?.logChat?.(p, {
      channel: 'guild',
      location: p?.rpg?.location ?? '',
      groupId: variant != null ? `${group}:${variant}` : group,
      recipientIds: heard.filter((q) => q.id !== p.id).map((q) => q.id),
      text,
    });
    if (logged === null) throw new Error('Chat is unavailable right now.');
    for (const q of heard) ctx.notify(q, ev);
  });

  // ---------------------------------------------------------------- player-founded order actions

  txAction('order.create', (p, args = {}) => {
    if (orderOf(p)) throw new Error('Leave or disband your current order first.');
    const cleanName = cleanText(args.name);
    if (cleanName.length < ORDER_MIN_NAME || cleanName.length > ORDER_MAX_NAME) {
      throw new Error(`Order name must be ${ORDER_MIN_NAME}–${ORDER_MAX_NAME} characters.`);
    }
    if (!/[A-Za-z0-9]/.test(cleanName)) throw new Error('Order name must contain letters or numbers.');
    const cleanTag = cleanText(args.tag).toUpperCase();
    if (!TAG_RE.test(cleanTag)) throw new Error('Order tag must be 2–5 letters or numbers.');
    if (nameIndex.has(cleanName.toLowerCase())) throw new Error('An order with that name already exists.');
    if (tagIndex.has(cleanTag)) throw new Error('An order with that tag already exists.');
    const motd = cleanText(args.motd).slice(0, ORDER_MAX_MOTD);

    if (foundingFee > 0) takeGold(p, foundingFee);

    const id = newOrderId();
    const createdAt = new Date().toISOString();
    const ord = {
      id,
      name: cleanName,
      tag: cleanTag,
      motd,
      treasury: 0,
      createdAt,
      leaderId: p.id,
      members: {
        [String(p.id)]: { id: p.id, name: p.name, rank: 'Leader', joinedAt: createdAt },
      },
      ledger: [],
    };
    orders.set(id, ord);
    nameIndex.set(cleanName.toLowerCase(), id);
    tagIndex.set(cleanTag, id);
    memberOrder.set(p.id, id);
    orderInvites.delete(p.id);
    syncProjection(p);
    persistOrder(ord);
    ctx.emit?.('orderCreated', { player: p, orderId: id, name: cleanName, tag: cleanTag });
    pushOverview(p, 'order.create', `Founded [${cleanTag}] ${cleanName}.`);
  });

  txAction('order.invite', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    const me = ord.members[String(p.id)];
    if (!me || (me.rank !== 'Leader' && me.rank !== 'Officer')) {
      throw new Error('Only the Leader or an Officer can invite new members.');
    }
    if (Object.keys(ord.members).length >= ORDER_MAX_MEMBERS) {
      throw new Error(`Your order already holds the maximum of ${ORDER_MAX_MEMBERS} members.`);
    }
    const targetId = toPlayerId(args.targetId);
    if (targetId === p.id) throw new Error('You cannot invite yourself.');
    const target = online(targetId);
    if (!target) throw new Error('That player is not online.');
    if (orderOf(target)) throw new Error(`${target.name} is already in an order.`);
    pruneInvites(targetId);
    const box = orderInvites.get(targetId) ?? new Map();
    if (box.has(ord.id)) throw new Error(`${target.name} already has an invitation to your order.`);
    rateRequest(p);
    const inv = {
      orderId: ord.id,
      orderName: ord.name,
      orderTag: ord.tag,
      fromId: p.id,
      fromName: p.name,
      expires: now() + ORDER_INVITE_TTL_MS,
    };
    box.set(ord.id, inv);
    orderInvites.set(targetId, box);
    pushOverview(target, 'order.invite', `${p.name} invited you to join [${ord.tag}] ${ord.name}.`, { orderInvite: inv });
    pushOverview(p, 'order.invite', `Invitation sent to ${target.name}.`);
  });

  txAction('order.accept', (p, args = {}) => {
    if (orderOf(p)) throw new Error('Leave your current order first.');
    pruneInvites(p.id);
    const box = orderInvites.get(p.id);
    if (!box?.size) throw new Error('You have no pending order invitations.');
    const orderId = args.orderId != null ? String(args.orderId) : (box.size === 1 ? box.keys().next().value : '');
    const inv = box.get(orderId);
    if (!inv) throw new Error('That invitation is no longer open.');
    const ord = orders.get(orderId);
    if (!ord) {
      box.delete(orderId);
      throw new Error('That order no longer exists.');
    }
    if (Object.keys(ord.members).length >= ORDER_MAX_MEMBERS) {
      box.delete(orderId);
      throw new Error('That order is full.');
    }
    ord.members[String(p.id)] = {
      id: p.id,
      name: p.name,
      rank: 'Member',
      joinedAt: new Date().toISOString(),
    };
    memberOrder.set(p.id, ord.id);
    orderInvites.delete(p.id);
    syncProjection(p);
    persistOrder(ord);
    pushOrderMembers(ord, 'order.accept', `${p.name} joined [${ord.tag}] ${ord.name}.`, p.id);
    pushOverview(p, 'order.accept', `You joined [${ord.tag}] ${ord.name}.`);
  });

  txAction('order.decline', (p, args = {}) => {
    pruneInvites(p.id);
    const box = orderInvites.get(p.id);
    const orderId = args.orderId != null ? String(args.orderId) : (box?.size === 1 ? box.keys().next().value : '');
    const inv = box?.get(orderId);
    if (!inv) throw new Error('That invitation is no longer open.');
    box.delete(orderId);
    if (!box.size) orderInvites.delete(p.id);
    const from = online(inv.fromId);
    if (from) pushOverview(from, 'order.decline', `${p.name} declined the invitation to [${inv.orderTag}] ${inv.orderName}.`);
    pushOverview(p, 'order.decline', `Declined invitation to [${inv.orderTag}] ${inv.orderName}.`);
  });

  txAction('order.promote', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    if (ord.leaderId !== p.id) throw new Error('Only the order Leader can promote members.');
    const targetId = toPlayerId(args.targetId);
    if (targetId === p.id) throw new Error('You are already the Leader.');
    const targetMem = ord.members[String(targetId)];
    if (!targetMem) throw new Error('That player is not in your order.');

    let msg;
    if (targetMem.rank === 'Member' && args.rank !== 'Leader') {
      targetMem.rank = 'Officer';
      msg = `${targetMem.name} was promoted to Officer.`;
    } else {
      const me = ord.members[String(p.id)];
      me.rank = 'Officer';
      targetMem.rank = 'Leader';
      ord.leaderId = targetId;
      syncProjection(p);
      msg = `${targetMem.name} is now the Leader of [${ord.tag}] ${ord.name}.`;
    }
    const liveTarget = online(targetId);
    if (liveTarget) syncProjection(liveTarget);
    persistOrder(ord);
    pushOrderMembers(ord, 'order.promote', msg);
  });

  txAction('order.demote', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    if (ord.leaderId !== p.id) throw new Error('Only the order Leader can demote officers.');
    const targetId = toPlayerId(args.targetId);
    if (targetId === p.id) throw new Error('You cannot demote yourself.');
    const targetMem = ord.members[String(targetId)];
    if (!targetMem) throw new Error('That player is not in your order.');
    if (targetMem.rank !== 'Officer') throw new Error(`${targetMem.name} is already a Member.`);
    targetMem.rank = 'Member';
    const liveTarget = online(targetId);
    if (liveTarget) syncProjection(liveTarget);
    persistOrder(ord);
    pushOrderMembers(ord, 'order.demote', `${targetMem.name} was demoted to Member.`);
  });

  txAction('order.kick', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    const me = ord.members[String(p.id)];
    if (!me || (me.rank !== 'Leader' && me.rank !== 'Officer')) {
      throw new Error('Only the Leader or an Officer can kick members.');
    }
    const targetId = toPlayerId(args.targetId);
    if (targetId === p.id) throw new Error('Use Leave to leave the order.');
    const targetMem = ord.members[String(targetId)];
    if (!targetMem) throw new Error('That player is not in your order.');
    if (rankWeight(me.rank) <= rankWeight(targetMem.rank)) {
      throw new Error(`You do not outrank ${targetMem.name}.`);
    }
    delete ord.members[String(targetId)];
    memberOrder.delete(targetId);
    const liveTarget = online(targetId);
    if (liveTarget) syncProjection(liveTarget);
    persistOrder(ord);
    if (liveTarget) pushOverview(liveTarget, 'order.kick', `You were removed from [${ord.tag}] ${ord.name}.`);
    pushOrderMembers(ord, 'order.kick', `${targetMem.name} was removed from [${ord.tag}] ${ord.name}.`);
  });

  txAction('order.leave', (p) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    const wasLeader = ord.leaderId === p.id;
    delete ord.members[String(p.id)];
    memberOrder.delete(p.id);
    syncProjection(p);

    const remaining = Object.values(ord.members);
    if (!remaining.length) {
      if (ord.treasury > 0) addGold(p, ord.treasury);
      orders.delete(ord.id);
      nameIndex.delete(ord.name.toLowerCase());
      tagIndex.delete(ord.tag.toUpperCase());
      clearOrderInvites(ord.id);
      deletePersistedOrder(ord.id);
      pushOverview(p, 'order.leave', `[${ord.tag}] ${ord.name} was disbanded as its last member left.`);
      return;
    }

    let extra = '';
    if (wasLeader) {
      remaining.sort((a, b) =>
        rankWeight(b.rank) - rankWeight(a.rank) ||
        Number(Boolean(online(b.id))) - Number(Boolean(online(a.id))) ||
        String(a.joinedAt).localeCompare(String(b.joinedAt)),
      );
      const heir = remaining[0];
      heir.rank = 'Leader';
      ord.leaderId = heir.id;
      const liveHeir = online(heir.id);
      if (liveHeir) syncProjection(liveHeir);
      extra = ` ${heir.name} succeeds as Leader.`;
    }
    persistOrder(ord);
    pushOrderMembers(ord, 'order.leave', `${p.name} left [${ord.tag}] ${ord.name}.${extra}`);
    pushOverview(p, 'order.leave', `You left [${ord.tag}] ${ord.name}.`);
  });

  txAction('order.disband', (p) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    if (ord.leaderId !== p.id) throw new Error('Only the order Leader can disband the order.');
    const formerIds = Object.values(ord.members).map((m) => m.id);
    if (ord.treasury > 0) addGold(p, ord.treasury);
    orders.delete(ord.id);
    nameIndex.delete(ord.name.toLowerCase());
    tagIndex.delete(ord.tag.toUpperCase());
    clearOrderInvites(ord.id);
    for (const id of formerIds) memberOrder.delete(id);
    for (const id of formerIds) {
      const live = online(id);
      if (live) syncProjection(live);
    }
    deletePersistedOrder(ord.id);
    for (const id of formerIds) {
      const live = online(id);
      if (live) pushOverview(live, 'order.disband', `[${ord.tag}] ${ord.name} has been disbanded.`);
    }
  });

  txAction('order.motd', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    const me = ord.members[String(p.id)];
    if (!me || (me.rank !== 'Leader' && me.rank !== 'Officer')) {
      throw new Error('Only the Leader or an Officer can update the charter / MOTD.');
    }
    const motd = cleanText(args.motd);
    if (motd.length > ORDER_MAX_MOTD) throw new Error(`MOTD must be at most ${ORDER_MAX_MOTD} characters.`);
    ord.motd = motd;
    persistOrder(ord);
    pushOrderMembers(ord, 'order.motd', motd ? `Order MOTD updated: ${motd}` : 'Order MOTD cleared.');
  });

  txAction('order.deposit', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    const amount = toPositiveGold(args.amount);
    takeGold(p, amount);
    ord.treasury += amount;
    ord.ledger.push({
      at: new Date().toISOString(),
      actorId: p.id,
      actorName: p.name,
      kind: 'deposit',
      amount,
      balance: ord.treasury,
    });
    if (ord.ledger.length > ORDER_LEDGER_MAX) ord.ledger.splice(0, ord.ledger.length - ORDER_LEDGER_MAX);
    persistOrder(ord);
    pushOrderMembers(ord, 'order.deposit', `${p.name} deposited ${amount} gold into the treasury (balance: ${ord.treasury}g).`);
  });

  txAction('order.withdraw', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    const me = ord.members[String(p.id)];
    if (!me || (me.rank !== 'Leader' && me.rank !== 'Officer')) {
      throw new Error('Only the Leader or an Officer can withdraw from the treasury.');
    }
    const amount = toPositiveGold(args.amount);
    if (ord.treasury < amount) {
      throw new Error(`The treasury only holds ${ord.treasury} gold.`);
    }
    ord.treasury -= amount;
    addGold(p, amount);
    ord.ledger.push({
      at: new Date().toISOString(),
      actorId: p.id,
      actorName: p.name,
      kind: 'withdraw',
      amount,
      balance: ord.treasury,
    });
    if (ord.ledger.length > ORDER_LEDGER_MAX) ord.ledger.splice(0, ord.ledger.length - ORDER_LEDGER_MAX);
    persistOrder(ord);
    pushOrderMembers(ord, 'order.withdraw', `${p.name} withdrew ${amount} gold from the treasury (balance: ${ord.treasury}g).`);
  });

  // ---------------------------------------------------------------- lifecycle

  ctx.onJoin?.((p) => {
    const ord = orderOf(p);
    if (ord && ord.members[String(p.id)]) {
      ord.members[String(p.id)].name = p.name;
    }
    syncProjection(p, { markDirty: false });
  });

  ctx.onLeave?.((p) => {
    orderInvites.delete(p.id);
    const ord = orderOf(p);
    if (ord) pushOrderMembers(ord, 'overview', null, p.id);
  });

  const api = {
    orders,
    orderOf,
    overviewOf,
    directoryOf,
    orderView,
  };
  services.guildhall = api;
  return api;
}

export default install;
