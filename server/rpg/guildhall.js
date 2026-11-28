// Classic Guilds overview/chat/resign + Player-Founded Multiplayer Orders (world_state `pguild:<id>`).
//
// Owns:
//   - Classic guild overview (rank progress, skill/rep/cooldown gates, perks, online fellow members)
//   - Full classic directory (6 guild families, 8 Temples, 10 Knightly Orders)
//   - Classic guild resign & private guild-channel chat (classic guilds + player orders)
//   - Player-founded persistent multiplayer guilds/orders stored in `world_state` as `pguild:<id>`
//     with rank hierarchy (Leader, Officer, Member), custom rank permission matrix + per-member
//     delegation overrides, invites, MOTD, purchasable Order Hall with persistent decor & access,
//     Order Item Vault + shared gold treasury + audit ledger (durable via `runDurable` & `inventory.js`),
//     deterministic succession, disband rules, archive blockers, and purge reconciliation.
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
import { placeOf } from '../../client/gameplay/townServices/rules.js';
import {
  FURNISHING_CATALOG,
  FURNISHING_LIST,
  MAX_FURNISHINGS_PER_HALL,
  getCatalogItem,
  validateFurnishingPlacement,
  furnishingRefundValue,
} from './homes/catalog.js';
import {
  applyDepositToContainer,
  applyWithdrawFromContainer,
  normalizeRecord,
} from './homes/storage.js';

export const name = 'guildhall';
export const PGUILD_PREFIX = 'pguild:';
export const PGUILD_RECONCILE_PREFIX = 'pguild:reconcile:';
export const ORDER_RANKS = Object.freeze(['Member', 'Officer', 'Leader']);
export const ORDER_MAX_MEMBERS = 50;
export const ORDER_INVITE_TTL_MS = 5 * 60_000;
export const ORDER_MAX_NAME = 32;
export const ORDER_MIN_NAME = 3;
export const ORDER_MAX_MOTD = 200;
export const ORDER_LEDGER_MAX = 20;
export const ORDER_VAULT_CAPACITY = 60;
export const ORDER_AUDIT_MAX = 50;

export const ORDER_PERMISSIONS = Object.freeze([
  'invite',
  'kick',
  'promote',
  'editMotd',
  'withdrawTreasury',
  'depositVault',
  'withdrawVault',
  'decorateHall',
  'hallAccess',
  'siegeOfficer',
]);

export const DEFAULT_ORDER_PERMISSIONS = Object.freeze({
  Leader: Object.freeze({
    invite: true,
    kick: true,
    promote: true,
    editMotd: true,
    withdrawTreasury: true,
    depositVault: true,
    withdrawVault: true,
    decorateHall: true,
    hallAccess: true,
    siegeOfficer: true,
  }),
  Officer: Object.freeze({
    invite: true,
    kick: true,
    promote: false,
    editMotd: true,
    withdrawTreasury: true,
    depositVault: true,
    withdrawVault: true,
    decorateHall: true,
    hallAccess: true,
    siegeOfficer: true,
  }),
  Member: Object.freeze({
    invite: false,
    kick: false,
    promote: false,
    editMotd: false,
    withdrawTreasury: false,
    depositVault: true,
    withdrawVault: false,
    decorateHall: false,
    hallAccess: true,
    siegeOfficer: false,
  }),
});

export const ORDER_HALL_CATALOG = Object.freeze({
  'daggerfall-chapterhouse': Object.freeze({
    id: 'daggerfall-chapterhouse',
    name: 'Daggerfall Chapterhouse',
    region: 'Daggerfall',
    town: 'town:Daggerfall/Gothway Garden',
    buildingId: 'hall-daggerfall-01',
    interior: 'interior:Daggerfall/Gothway Garden/2,2/10',
    radius: 16,
    price: 5000,
  }),
  'wayrest-bastion': Object.freeze({
    id: 'wayrest-bastion',
    name: 'Wayrest Bastion Hall',
    region: 'Wayrest',
    town: 'town:Wayrest/Wayrest',
    buildingId: 'hall-wayrest-01',
    interior: 'interior:Wayrest/Wayrest/3,1/12',
    radius: 18,
    price: 7500,
  }),
  'sentinel-conclave': Object.freeze({
    id: 'sentinel-conclave',
    name: 'Sentinel Conclave Hall',
    region: 'Sentinel',
    town: 'town:Sentinel/Sentinel',
    buildingId: 'hall-sentinel-01',
    interior: 'interior:Sentinel/Sentinel/1,4/8',
    radius: 16,
    price: 6500,
  }),
  'iliac-citadel': Object.freeze({
    id: 'iliac-citadel',
    name: 'Iliac Citadel Keep',
    region: 'Daggerfall',
    town: 'town:Daggerfall/Daggerfall',
    buildingId: 'hall-citadel-01',
    interior: 'interior:Daggerfall/Daggerfall/4,4/15',
    radius: 22,
    price: 12000,
  }),
});

export const HALL_VISITOR_MODES = Object.freeze(['members', 'invited', 'open']);
const NEUTRAL_HALL_REFUSAL = 'You cannot enter that order hall right now.';

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
const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const newOrderId = () => `pg_${randomBytes(6).toString('hex')}`;
const newFurnishingId = () => `hfn_${randomBytes(5).toString('hex')}`;
const newAuditId = () => `aud_${randomBytes(5).toString('hex')}`;
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

export function normalizePermissionsMatrix(raw) {
  const out = {
    Leader: { ...DEFAULT_ORDER_PERMISSIONS.Leader },
    Officer: { ...DEFAULT_ORDER_PERMISSIONS.Officer },
    Member: { ...DEFAULT_ORDER_PERMISSIONS.Member },
  };
  if (isObj(raw)) {
    for (const rank of ['Officer', 'Member']) {
      if (!isObj(raw[rank])) continue;
      for (const perm of ORDER_PERMISSIONS) {
        if (typeof raw[rank][perm] === 'boolean') {
          out[rank][perm] = raw[rank][perm];
        }
      }
    }
  }
  return out;
}

function normalizeMemberOverrides(raw, members) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [idKey, perms] of Object.entries(raw)) {
    if (!members[idKey] || !isObj(perms)) continue;
    const clean = {};
    for (const perm of ORDER_PERMISSIONS) {
      if (typeof perms[perm] === 'boolean') clean[perm] = perms[perm];
    }
    if (Object.keys(clean).length) out[idKey] = clean;
  }
  return out;
}

function normalizeHallRecord(raw) {
  if (!isObj(raw) || typeof raw.interior !== 'string' || !raw.interior) return null;
  const catalogSpec = typeof raw.id === 'string' && Object.hasOwn(ORDER_HALL_CATALOG, raw.id) ? ORDER_HALL_CATALOG[raw.id] : null;
  const furnishings = [];
  const seen = new Set();
  for (const f of Array.isArray(raw.furnishings) ? raw.furnishings : []) {
    if (!isObj(f) || typeof f.id !== 'string' || seen.has(f.id)) continue;
    const spec = getCatalogItem(f.catalogId);
    if (!spec || spec.homeOnly) continue;
    if (![f.x, f.y, f.z].every(Number.isFinite)) continue;
    seen.add(f.id);
    furnishings.push({
      id: f.id,
      catalogId: spec.id,
      name: spec.name,
      kind: spec.kind,
      x: Number(f.x),
      y: Number(f.y),
      z: Number(f.z),
      yaw: Number.isFinite(f.yaw) ? Number(f.yaw) : 0,
      floor: Math.max(0, int(f.floor, 0)),
      placedBy: Number.isSafeInteger(f.placedBy) ? f.placedBy : null,
      placedAt: int(f.placedAt, 0),
    });
  }
  const visitors = {};
  if (isObj(raw.visitors)) {
    for (const [k, v] of Object.entries(raw.visitors)) {
      if (!isObj(v) || !Number.isSafeInteger(v.id)) continue;
      visitors[String(v.id)] = {
        id: v.id,
        name: cleanText(v.name) || `Traveller ${v.id}`,
        grantedAt: int(v.grantedAt, 0),
      };
    }
  }
  return {
    id: cleanText(raw.id || catalogSpec?.id || 'custom-hall').slice(0, 48),
    name: cleanText(raw.name || catalogSpec?.name || 'Order Hall').slice(0, 64),
    region: cleanText(raw.region || catalogSpec?.region || 'Daggerfall').slice(0, 64),
    town: cleanText(raw.town || catalogSpec?.town || 'town:Daggerfall/Gothway Garden').slice(0, 200),
    buildingId: cleanText(raw.buildingId || catalogSpec?.buildingId || '').slice(0, 48),
    interior: cleanText(raw.interior).slice(0, 200),
    radius: Number.isFinite(Number(raw.radius)) ? Number(raw.radius) : (catalogSpec?.radius ?? 16),
    price: Math.max(0, int(raw.price, catalogSpec?.price ?? 0)),
    boughtAt: int(raw.boughtAt, 0),
    visitorMode: HALL_VISITOR_MODES.includes(raw.visitorMode) ? raw.visitorMode : 'members',
    visitors,
    furnishings,
    furnishingRev: Math.max(1, int(raw.furnishingRev, 1)),
  };
}

function normalizeVaultSlot(raw) {
  if (!isObj(raw)) return null;
  const itemRaw = isObj(raw.item) ? raw.item : raw;
  const norm = normalizeRecord(itemRaw);
  if (!norm) return null;
  return {
    item: norm,
    depositedBy: Number.isSafeInteger(raw.depositedBy) ? raw.depositedBy : null,
    depositedByName: cleanText(raw.depositedByName || '') || 'Unknown',
    depositedAt: int(raw.depositedAt, 0),
  };
}

function normalizeAuditEntry(raw) {
  if (!isObj(raw) || typeof raw.action !== 'string') return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newAuditId(),
    at: typeof raw.at === 'string' ? raw.at : new Date().toISOString(),
    actorId: Number.isSafeInteger(raw.actorId) ? raw.actorId : null,
    actorName: cleanText(raw.actorName || '') || 'Unknown',
    action: raw.action,
    ...(raw.itemId != null ? { itemId: String(raw.itemId) } : {}),
    ...(raw.itemName != null ? { itemName: cleanText(raw.itemName).slice(0, 80) } : {}),
    ...(raw.template != null ? { template: String(raw.template).slice(0, 64) } : {}),
    ...(raw.fingerprint != null ? { fingerprint: String(raw.fingerprint).slice(0, 40) } : {}),
    ...(Number.isSafeInteger(raw.quantity) ? { quantity: raw.quantity } : {}),
    ...(Number.isSafeInteger(raw.gold) ? { gold: raw.gold } : {}),
    ...(Number.isSafeInteger(raw.balance) ? { balance: raw.balance } : {}),
    ...(raw.detail != null ? { detail: cleanText(raw.detail).slice(0, 120) } : {}),
  };
}

export function pickDeterministicSuccessor(membersList) {
  if (!Array.isArray(membersList) || !membersList.length) return null;
  const rankPriority = (r) => (r === 'Officer' ? 0 : r === 'Member' ? 1 : 2);
  const sorted = [...membersList].sort((a, b) => {
    const rp = rankPriority(a.rank) - rankPriority(b.rank);
    if (rp !== 0) return rp;
    const ta = Date.parse(a.joinedAt ?? '') || 0;
    const tb = Date.parse(b.joinedAt ?? '') || 0;
    if (ta !== tb) return ta - tb;
    return Number(a.id) - Number(b.id);
  });
  return sorted[0] ?? null;
}

export function orderHasPermission(ord, playerId, perm) {
  if (!ord || !Number.isSafeInteger(playerId) || !ORDER_PERMISSIONS.includes(perm)) return false;
  const mem = ord.members?.[String(playerId)];
  if (!mem) return false;
  if (ord.leaderId === playerId || mem.rank === 'Leader') return true;
  const override = ord.memberPermissions?.[String(playerId)]?.[perm];
  if (typeof override === 'boolean') return override;
  return ord.permissions?.[mem.rank]?.[perm] === true;
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
  const vault = Array.isArray(raw.vault)
    ? raw.vault.map(normalizeVaultSlot).filter(Boolean).slice(0, ORDER_VAULT_CAPACITY)
    : [];
  const vaultLedger = Array.isArray(raw.vaultLedger)
    ? raw.vaultLedger.map(normalizeAuditEntry).filter(Boolean).slice(-ORDER_AUDIT_MAX)
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
    permissions: normalizePermissionsMatrix(raw.permissions),
    memberPermissions: normalizeMemberOverrides(raw.memberPermissions, members),
    hall: normalizeHallRecord(raw.hall),
    vault,
    vaultCapacity: ORDER_VAULT_CAPACITY,
    vaultRevision: Math.max(1, int(raw.vaultRevision, 1)),
    vaultLedger,
    ledger,
    revision: Math.max(1, int(raw.revision, 1)),
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

  const orders = new Map();        // orderId -> orderRecord
  const memberOrder = new Map();   // playerId -> orderId
  const nameIndex = new Map();     // lowerName -> orderId
  const tagIndex = new Map();      // upperTag -> orderId
  const orderInvites = new Map();  // inviteeId -> Map<orderId, { orderId, orderName, orderTag, fromId, fromName, expires }>
  const hallOccupants = new Map(); // orderId -> Set<playerId>
  const playerHall = new Map();    // playerId -> orderId
  const limits = new WeakMap();    // player -> { chat, request }
  const pendingDurableOps = new Set();

  function trackOp(promise) {
    pendingDurableOps.add(promise);
    const done = () => pendingDurableOps.delete(promise);
    promise.then(done, done);
    return promise;
  }

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
    if (!key.startsWith(PGUILD_PREFIX) || key.startsWith(PGUILD_RECONCILE_PREFIX)) continue;
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

  function captureState() {
    return {
      orders: structuredClone(orders),
      orderInvites: structuredClone(orderInvites),
      hallOccupants: structuredClone(hallOccupants),
      playerHall: new Map(playerHall),
    };
  }

  function restoreState(snap) {
    orders.clear();
    for (const [k, v] of snap.orders) orders.set(k, v);
    orderInvites.clear();
    for (const [k, v] of snap.orderInvites) orderInvites.set(k, v);
    hallOccupants.clear();
    for (const [k, v] of snap.hallOccupants) hallOccupants.set(k, v);
    playerHall.clear();
    for (const [k, v] of snap.playerHall) playerHall.set(k, v);
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
    ord.revision = (ord.revision || 1) + 1;
    ctx.dirtyWorld?.(`${PGUILD_PREFIX}${ord.id}`, structuredClone(ord));
  }

  function deletePersistedOrder(orderId) {
    ctx.dirtyWorld?.(`${PGUILD_PREFIX}${orderId}`, null);
  }

  function orderOf(p) {
    if (!p) return null;
    const pid = typeof p === 'number' ? p : p.id;
    const id = memberOrder.get(pid);
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

  function pushAudit(ord, entry) {
    ord.vaultLedger.push(normalizeAuditEntry({
      id: newAuditId(),
      at: new Date().toISOString(),
      ...entry,
    }));
    if (ord.vaultLedger.length > ORDER_AUDIT_MAX) {
      ord.vaultLedger.splice(0, ord.vaultLedger.length - ORDER_AUDIT_MAX);
    }
  }

  // ---------------------------------------------------------------- Order Hall occupancy & movement

  function canEnterHall(p, ord) {
    if (!p || !ord || !ord.hall) return { ok: false, reason: NEUTRAL_HALL_REFUSAL };
    const mem = ord.members[String(p.id)];
    if (mem) {
      if (orderHasPermission(ord, p.id, 'hallAccess')) return { ok: true, role: 'member' };
      return { ok: false, reason: 'Your rank does not currently have Order Hall access.' };
    }
    const leaderDesc = online(ord.leaderId) ?? { id: ord.leaderId };
    if (typeof services.isBlocked === 'function' && services.isBlocked(p, leaderDesc)) {
      return { ok: false, reason: NEUTRAL_HALL_REFUSAL };
    }
    if (typeof services.canInteract === 'function') {
      const check = services.canInteract(p, leaderDesc, 'visit');
      if (check && check.ok === false) return { ok: false, reason: NEUTRAL_HALL_REFUSAL };
    }
    if (ord.hall.visitorMode === 'open') return { ok: true, role: 'visitor' };
    if (ord.hall.visitorMode === 'invited' && ord.hall.visitors?.[String(p.id)]) {
      return { ok: true, role: 'visitor' };
    }
    return { ok: false, reason: NEUTRAL_HALL_REFUSAL };
  }

  function setHallOccupant(p, orderId, returnTo = null) {
    const prev = playerHall.get(p.id);
    if (prev && prev !== orderId) {
      hallOccupants.get(prev)?.delete(p.id);
      if (hallOccupants.get(prev)?.size === 0) hallOccupants.delete(prev);
    }
    if (orderId) {
      const ord = orders.get(orderId);
      playerHall.set(p.id, orderId);
      if (!hallOccupants.has(orderId)) hallOccupants.set(orderId, new Set());
      hallOccupants.get(orderId).add(p.id);
      if (p.rpg) {
        p.rpg.activeOrderHall = {
          orderId,
          interior: ord?.hall?.interior ?? locationOf(p),
          returnTo: returnTo ?? p.rpg.activeOrderHall?.returnTo ?? { location: ord?.hall?.town ?? 'town:Daggerfall/Gothway Garden', x: 0, z: 0, yaw: 0 },
        };
      }
    } else {
      playerHall.delete(p.id);
      if (p.rpg) delete p.rpg.activeOrderHall;
    }
  }

  function hallExteriorLanding(p, hall) {
    const saved = p?.rpg?.activeOrderHall?.returnTo ?? p?.rpg?.portal?.returnTo;
    if (saved && typeof saved.location === 'string' && !saved.location.startsWith('interior:') && [saved.x, saved.z, saved.yaw].every(Number.isFinite)) {
      return { location: saved.location, x: saved.x, y: saved.y ?? 0, z: saved.z, yaw: saved.yaw };
    }
    return { location: hall?.town ?? ctx.defaultLocation ?? 'town:Daggerfall/Gothway Garden', x: 0, y: 0, z: 0, yaw: 0 };
  }

  function movePlayer(p, landing, label = 'the exterior') {
    if (typeof services.portals?.transfer === 'function') {
      services.portals.transfer(p, landing, { label });
      return;
    }
    const from = locationOf(p);
    dirty(p);
    p.rpg.location = landing.location;
    delete p.rpg.portal;
    Object.assign(p, { x: landing.x, z: landing.z, yaw: landing.yaw ?? 0, moving: false, forward: 0, strafe: 0 });
    ctx.notify?.(p, { kind: 'teleport', location: landing.location, x: landing.x, y: landing.y ?? 0, z: landing.z, yaw: landing.yaw ?? 0, label });
    ctx.emit?.('locationChanged', { player: p, from, to: landing.location });
  }

  function ejectFromHall(p, hall, reason = 'You have been returned outside the Order Hall.') {
    if (!p) return;
    setHallOccupant(p, null);
    dirty(p);
    movePlayer(p, hallExteriorLanding(p, hall), 'outside the hall');
    ctx.notify?.(p, { kind: 'guild', action: 'order.hallEjected', text: reason });
  }

  function ejectUnauthorizedHallOccupants(ord, reason = 'Your access to the Order Hall has ended.') {
    const occ = hallOccupants.get(ord.id);
    if (!occ?.size) return;
    for (const pid of [...occ]) {
      const live = online(pid);
      if (!live) {
        occ.delete(pid);
        playerHall.delete(pid);
        continue;
      }
      if (!canEnterHall(live, ord).ok) {
        ejectFromHall(live, ord.hall, reason);
      }
    }
  }

  function ejectAllHallOccupants(ord, reason = 'The Order Hall has been closed.') {
    const occ = hallOccupants.get(ord.id);
    if (!occ?.size) return;
    for (const pid of [...occ]) {
      const live = online(pid);
      if (live) ejectFromHall(live, ord.hall, reason);
      else {
        occ.delete(pid);
        playerHall.delete(pid);
      }
    }
    hallOccupants.delete(ord.id);
  }

  function broadcastHallFurnishings(ord) {
    if (!ord?.hall) return;
    ctx.nearby?.(ord.hall.interior, {
      kind: 'order.hallFurnishings',
      orderId: ord.id,
      furnishingRev: ord.hall.furnishingRev,
      furnishings: ord.hall.furnishings.map((f) => ({ ...f })),
    }, { scope: `orderhall:${ord.id}` });
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

  function effectivePermissionsFor(ord, playerId) {
    const out = {};
    for (const perm of ORDER_PERMISSIONS) {
      out[perm] = orderHasPermission(ord, playerId, perm);
    }
    return out;
  }

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
        overrides: ord.memberPermissions?.[String(m.id)] ? { ...ord.memberPermissions[String(m.id)] } : {},
      };
    });
    members.sort((a, b) =>
      rankWeight(b.rank) - rankWeight(a.rank) ||
      Number(b.online) - Number(a.online) ||
      a.name.localeCompare(b.name),
    );
    const me = ord.members[String(viewerId)] ?? null;
    const hall = ord.hall
      ? {
        ...ord.hall,
        townName: placeOf(ord.hall.town)?.location ?? ord.hall.town,
        visitors: Object.values(ord.hall.visitors ?? {}).map((v) => ({ ...v, name: online(v.id)?.name ?? v.name })),
        furnishings: ord.hall.furnishings.map((f) => ({ ...f })),
        maxFurnishings: MAX_FURNISHINGS_PER_HALL,
        occupantCount: hallOccupants.get(ord.id)?.size ?? 0,
        insideHall: playerHall.get(viewerId) === ord.id,
      }
      : null;
    return {
      id: ord.id,
      name: ord.name,
      tag: ord.tag,
      motd: ord.motd,
      treasury: ord.treasury,
      createdAt: ord.createdAt,
      leaderId: ord.leaderId,
      myRank: me?.rank ?? null,
      myPermissions: effectivePermissionsFor(ord, viewerId),
      permissions: normalizePermissionsMatrix(ord.permissions),
      permissionKeys: [...ORDER_PERMISSIONS],
      maxMembers: ORDER_MAX_MEMBERS,
      members,
      hall,
      hallCatalog: Object.values(ORDER_HALL_CATALOG).map((h) => ({ ...h })),
      furnishingCatalog: FURNISHING_LIST.filter((c) => !c.homeOnly).map((c) => ({ ...c })),
      vault: ord.vault.map((slot) => ({
        ...slot.item,
        depositedBy: slot.depositedBy,
        depositedByName: slot.depositedByName,
        depositedAt: slot.depositedAt,
      })),
      vaultCapacity: ord.vaultCapacity ?? ORDER_VAULT_CAPACITY,
      vaultRevision: ord.vaultRevision ?? 1,
      vaultLedger: [...ord.vaultLedger].reverse(),
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

  // ---------------------------------------------------------------- durable Vault & Hall operations

  /**
   * Durable atomic Order Item Vault deposit (`shared: true` eligibility via `inventory.js`).
   */
  async function vaultDeposit(p, { itemId, quantity = null, opKey = null } = {}) {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    if (!orderHasPermission(ord, p.id, 'depositVault')) {
      const err = new Error('You do not have permission to deposit into the order vault.');
      err.code = 'PERMISSION_DENIED';
      throw err;
    }
    const orderId = ord.id;
    const runDurable = services.runDurable;

    const applyOnOrder = (curOrd) => {
      if (!curOrd || !curOrd.members[String(p.id)]) {
        const err = new Error('You are no longer a member of that order.');
        err.code = 'NOT_A_MEMBER';
        throw err;
      }
      if (!orderHasPermission(curOrd, p.id, 'depositVault')) {
        const err = new Error('You do not have permission to deposit into the order vault.');
        err.code = 'PERMISSION_DENIED';
        throw err;
      }
      const res = applyDepositToContainer(p.rpg, curOrd.vault, itemId, quantity, {
        shared: true,
        capacity: curOrd.vaultCapacity ?? ORDER_VAULT_CAPACITY,
        allowGold: false,
        wrapSlot: (item) => ({
          item,
          depositedBy: p.id,
          depositedByName: p.name,
          depositedAt: now(),
        }),
        unwrapSlot: (s) => s?.item ?? s,
      });
      curOrd.vault = res.list;
      curOrd.vaultRevision = (curOrd.vaultRevision || 1) + 1;
      curOrd.revision = (curOrd.revision || 1) + 1;
      pushAudit(curOrd, {
        actorId: p.id,
        actorName: p.name,
        action: 'vault_deposit',
        itemId: res.moved.id,
        itemName: res.moved.name,
        template: res.moved.template,
        fingerprint: res.fingerprint,
        quantity: res.moved.quantity,
      });
      return { curOrd, nextRpg: res.rpg, moved: res.moved, fingerprint: res.fingerprint };
    };

    if (typeof runDurable === 'function') {
      const key = opKey ?? `vault-dep-${orderId}-${p.id}-${randomBytes(4).toString('hex')}`;
      const scope = {
        accountId: p.accountId ?? null,
        characterId: p.id,
        characterIds: [p.id],
        resourceKeys: [`pguild:${orderId}`, `pguild:${orderId}:vault`],
        params: { action: 'order.vaultDeposit', orderId, itemId: String(itemId ?? ''), quantity },
      };
      const outcome = await trackOp(runDurable(key, scope, async (tx) => {
        const stored = await Promise.resolve(tx.getWorld(`${PGUILD_PREFIX}${orderId}`));
        const curOrd = normalizeOrderRecord(stored ?? orders.get(orderId));
        const res = applyOnOrder(curOrd);
        await Promise.resolve(tx.saveCharacters(
          [{ ...p, rpg: res.nextRpg }],
          [[`${PGUILD_PREFIX}${orderId}`, res.curOrd]],
        ));
        return { order: res.curOrd, nextRpg: res.nextRpg, moved: res.moved, fingerprint: res.fingerprint };
      }));
      if (!outcome.replayed && outcome.result?.order) {
        const updated = normalizeOrderRecord(outcome.result.order);
        orders.set(updated.id, updated);
        rebuildIndexes();
        Object.assign(p.rpg, outcome.result.nextRpg);
        const mv = outcome.result.moved;
        const label = `${mv.quantity > 1 ? `${mv.quantity} × ` : ''}${mv.name}`;
        pushOrderMembers(updated, 'order.vaultDeposit', `${p.name} deposited ${label} into the order vault.`);
      }
      return outcome;
    }

    const res = applyOnOrder(ord);
    dirty(p);
    Object.assign(p.rpg, res.nextRpg);
    persistOrder(ord);
    const mv = res.moved;
    const label = `${mv.quantity > 1 ? `${mv.quantity} × ` : ''}${mv.name}`;
    pushOrderMembers(ord, 'order.vaultDeposit', `${p.name} deposited ${label} into the order vault.`);
    return { replayed: false, result: { order: ord, moved: mv, fingerprint: res.fingerprint } };
  }

  /**
   * Durable atomic Order Item Vault withdrawal.
   * Re-validates membership & `withdrawVault` permission inside the transaction (catches mid-request
   * revocations), serializes concurrent withdrawals of the last item, and rejects full pack/overweight.
   */
  async function vaultWithdraw(p, { itemId, quantity = null, opKey = null } = {}) {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    if (!orderHasPermission(ord, p.id, 'withdrawVault')) {
      const err = new Error('You do not have permission to withdraw from the order vault.');
      err.code = 'PERMISSION_DENIED';
      throw err;
    }
    const orderId = ord.id;
    const maxCarryKg = typeof services.maxEncumbrance === 'function' ? services.maxEncumbrance(p) : null;
    const runDurable = services.runDurable;

    const applyOnOrder = (curOrd) => {
      if (!curOrd || !curOrd.members[String(p.id)]) {
        const err = new Error('You are no longer a member of that order.');
        err.code = 'NOT_A_MEMBER';
        throw err;
      }
      if (!orderHasPermission(curOrd, p.id, 'withdrawVault')) {
        const err = new Error('Your permission to withdraw from the order vault was revoked.');
        err.code = 'PERMISSION_DENIED';
        throw err;
      }
      const res = applyWithdrawFromContainer(p.rpg, curOrd.vault, itemId, quantity, {
        maxCarryKg,
        unwrapSlot: (s) => s?.item ?? s,
        rewrapSlot: (oldSlot, nextItem) => ({ ...oldSlot, item: nextItem }),
        isWrapped: true,
      });
      curOrd.vault = res.list;
      curOrd.vaultRevision = (curOrd.vaultRevision || 1) + 1;
      curOrd.revision = (curOrd.revision || 1) + 1;
      pushAudit(curOrd, {
        actorId: p.id,
        actorName: p.name,
        action: 'vault_withdraw',
        itemId: res.taken.id,
        itemName: res.taken.name,
        template: res.taken.template,
        fingerprint: res.fingerprint,
        quantity: res.taken.quantity,
      });
      return { curOrd, nextRpg: res.rpg, taken: res.taken, inserted: res.inserted, fingerprint: res.fingerprint };
    };

    if (typeof runDurable === 'function') {
      const key = opKey ?? `vault-wd-${orderId}-${p.id}-${randomBytes(4).toString('hex')}`;
      const scope = {
        accountId: p.accountId ?? null,
        characterId: p.id,
        characterIds: [p.id],
        resourceKeys: [`pguild:${orderId}`, `pguild:${orderId}:vault`],
        params: { action: 'order.vaultWithdraw', orderId, itemId: String(itemId ?? ''), quantity },
      };
      const outcome = await trackOp(runDurable(key, scope, async (tx) => {
        const stored = await Promise.resolve(tx.getWorld(`${PGUILD_PREFIX}${orderId}`));
        const curOrd = normalizeOrderRecord(stored ?? orders.get(orderId));
        const res = applyOnOrder(curOrd);
        await Promise.resolve(tx.saveCharacters(
          [{ ...p, rpg: res.nextRpg }],
          [[`${PGUILD_PREFIX}${orderId}`, res.curOrd]],
        ));
        return { order: res.curOrd, nextRpg: res.nextRpg, taken: res.taken, inserted: res.inserted, fingerprint: res.fingerprint };
      }));
      if (!outcome.replayed && outcome.result?.order) {
        const updated = normalizeOrderRecord(outcome.result.order);
        orders.set(updated.id, updated);
        rebuildIndexes();
        Object.assign(p.rpg, outcome.result.nextRpg);
        const tk = outcome.result.taken;
        const label = `${tk.quantity > 1 ? `${tk.quantity} × ` : ''}${tk.name}`;
        pushOrderMembers(updated, 'order.vaultWithdraw', `${p.name} withdrew ${label} from the order vault.`);
      }
      return outcome;
    }

    const res = applyOnOrder(ord);
    dirty(p);
    Object.assign(p.rpg, res.nextRpg);
    persistOrder(ord);
    const tk = res.taken;
    const label = `${tk.quantity > 1 ? `${tk.quantity} × ` : ''}${tk.name}`;
    pushOrderMembers(ord, 'order.vaultWithdraw', `${p.name} withdrew ${label} from the order vault.`);
    return { replayed: false, result: { order: ord, taken: tk, inserted: res.inserted, fingerprint: res.fingerprint } };
  }

  /**
   * Durable Order Hall purchase funded from `ord.treasury`.
   */
  async function buyHall(p, { hallId, confirm = false, opKey = null } = {}) {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    if (ord.leaderId !== p.id) throw new Error('Only the order Leader can purchase an Order Hall.');
    if (ord.hall) throw new Error('Your order already owns an Order Hall.');
    const spec = Object.hasOwn(ORDER_HALL_CATALOG, String(hallId ?? '')) ? ORDER_HALL_CATALOG[String(hallId)] : null;
    if (!spec) throw new Error('Choose an approved Order Hall building.');
    if (confirm !== true) {
      throw new Error(`Confirm purchase of ${spec.name} for ${spec.price} gold from the order treasury.`);
    }
    const orderId = ord.id;
    const runDurable = services.runDurable;

    const applyBuy = (curOrd) => {
      if (!curOrd || curOrd.leaderId !== p.id) throw new Error('Only the order Leader can purchase an Order Hall.');
      if (curOrd.hall) throw new Error('Your order already owns an Order Hall.');
      if (curOrd.treasury < spec.price) {
        throw new Error(`The treasury needs ${spec.price} gold to buy ${spec.name} (current balance: ${curOrd.treasury}g).`);
      }
      curOrd.treasury -= spec.price;
      curOrd.hall = normalizeHallRecord({
        ...spec,
        boughtAt: now(),
        visitorMode: 'members',
        visitors: {},
        furnishings: [],
        furnishingRev: 1,
      });
      curOrd.ledger.push({
        at: new Date().toISOString(),
        actorId: p.id,
        actorName: p.name,
        kind: 'withdraw',
        amount: spec.price,
        balance: curOrd.treasury,
      });
      if (curOrd.ledger.length > ORDER_LEDGER_MAX) curOrd.ledger.splice(0, curOrd.ledger.length - ORDER_LEDGER_MAX);
      pushAudit(curOrd, {
        actorId: p.id,
        actorName: p.name,
        action: 'hall_buy',
        gold: spec.price,
        balance: curOrd.treasury,
        detail: `Purchased ${spec.name}`,
      });
      curOrd.revision = (curOrd.revision || 1) + 1;
      return curOrd;
    };

    if (typeof runDurable === 'function') {
      const key = opKey ?? `hall-buy-${orderId}-${spec.id}-${randomBytes(4).toString('hex')}`;
      const outcome = await trackOp(runDurable(key, {
        accountId: p.accountId ?? null,
        characterId: p.id,
        characterIds: [p.id],
        resourceKeys: [`pguild:${orderId}`],
        params: { action: 'order.hallBuy', orderId, hallId: spec.id, price: spec.price },
      }, async (tx) => {
        const stored = await Promise.resolve(tx.getWorld(`${PGUILD_PREFIX}${orderId}`));
        const curOrd = normalizeOrderRecord(stored ?? orders.get(orderId));
        const nextOrd = applyBuy(curOrd);
        await Promise.resolve(tx.putWorld(`${PGUILD_PREFIX}${orderId}`, nextOrd));
        return { order: nextOrd };
      }));
      if (!outcome.replayed && outcome.result?.order) {
        const updated = normalizeOrderRecord(outcome.result.order);
        orders.set(updated.id, updated);
        rebuildIndexes();
        pushOrderMembers(updated, 'order.hallBuy', `${p.name} purchased ${spec.name} for ${spec.price}g from the order treasury.`);
      }
      return outcome;
    }

    applyBuy(ord);
    persistOrder(ord);
    pushOrderMembers(ord, 'order.hallBuy', `${p.name} purchased ${spec.name} for ${spec.price}g from the order treasury.`);
    return { replayed: false, result: { order: ord } };
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
      permissions: normalizePermissionsMatrix(null),
      memberPermissions: {},
      hall: null,
      vault: [],
      vaultCapacity: ORDER_VAULT_CAPACITY,
      vaultRevision: 1,
      vaultLedger: [],
      ledger: [],
      revision: 1,
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

  txAction('order.setPermissions', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    if (ord.leaderId !== p.id) throw new Error('Only the order Leader can edit the permission matrix.');
    const perms = args.permissions;
    if (!isObj(perms)) throw new Error('Provide permission toggles to update.');

    if (args.targetId != null) {
      const targetId = toPlayerId(args.targetId);
      if (targetId === p.id) throw new Error('Leader permissions cannot be restricted.');
      const targetMem = ord.members[String(targetId)];
      if (!targetMem) throw new Error('That player is not in your order.');
      const cur = { ...(ord.memberPermissions[String(targetId)] ?? {}) };
      for (const [k, v] of Object.entries(perms)) {
        if (!ORDER_PERMISSIONS.includes(k)) throw new Error(`Unknown permission "${k}".`);
        if (v === null) delete cur[k];
        else if (typeof v === 'boolean') cur[k] = v;
        else throw new Error(`Permission "${k}" must be true, false, or null.`);
      }
      if (Object.keys(cur).length) ord.memberPermissions[String(targetId)] = cur;
      else delete ord.memberPermissions[String(targetId)];
      persistOrder(ord);
      ejectUnauthorizedHallOccupants(ord);
      pushOrderMembers(ord, 'order.setPermissions', `Updated delegated permissions for ${targetMem.name}.`);
      return;
    }

    const rank = String(args.rank ?? '');
    if (rank !== 'Officer' && rank !== 'Member') {
      throw new Error('Choose Officer or Member rank to configure.');
    }
    for (const [k, v] of Object.entries(perms)) {
      if (!ORDER_PERMISSIONS.includes(k)) throw new Error(`Unknown permission "${k}".`);
      if (typeof v !== 'boolean') throw new Error(`Permission "${k}" must be true or false.`);
      ord.permissions[rank][k] = v;
    }
    persistOrder(ord);
    ejectUnauthorizedHallOccupants(ord);
    pushOrderMembers(ord, 'order.setPermissions', `Updated ${rank} rank permissions.`);
  });

  txAction('order.invite', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    if (!orderHasPermission(ord, p.id, 'invite')) {
      throw new Error('You do not have permission to invite new members.');
    }
    if (Object.keys(ord.members).length >= ORDER_MAX_MEMBERS) {
      throw new Error(`Your order already holds the maximum of ${ORDER_MAX_MEMBERS} members.`);
    }
    const targetId = toPlayerId(args.targetId);
    if (targetId === p.id) throw new Error('You cannot invite yourself.');
    const target = online(targetId);
    if (!target) throw new Error('That player is not online.');
    if (typeof services.isBlocked === 'function' && services.isBlocked(p, target)) {
      throw new Error('That traveller is not accepting order invitations right now.');
    }
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
    const targetId = toPlayerId(args.targetId);
    if (targetId === p.id) throw new Error('You cannot promote yourself.');
    const targetMem = ord.members[String(targetId)];
    if (!targetMem) throw new Error('That player is not in your order.');

    const wantsLeader = args.rank === 'Leader' || targetMem.rank === 'Officer';
    if (wantsLeader) {
      if (ord.leaderId !== p.id) throw new Error('Only the order Leader can transfer leadership.');
    } else if (!orderHasPermission(ord, p.id, 'promote')) {
      throw new Error('You do not have permission to promote members.');
    }

    let msg;
    if (targetMem.rank === 'Member' && args.rank !== 'Leader') {
      targetMem.rank = 'Officer';
      msg = `${targetMem.name} was promoted to Officer.`;
    } else {
      const me = ord.members[String(p.id)];
      me.rank = 'Officer';
      targetMem.rank = 'Leader';
      ord.leaderId = targetId;
      delete ord.memberPermissions[String(targetId)];
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
    if (!orderHasPermission(ord, p.id, 'promote') && ord.leaderId !== p.id) {
      throw new Error('Only the order Leader can demote officers.');
    }
    const targetId = toPlayerId(args.targetId);
    if (targetId === p.id) throw new Error('You cannot demote yourself.');
    const targetMem = ord.members[String(targetId)];
    if (!targetMem) throw new Error('That player is not in your order.');
    if (ord.leaderId !== p.id && rankWeight(ord.members[String(p.id)].rank) <= rankWeight(targetMem.rank)) {
      throw new Error(`You do not outrank ${targetMem.name}.`);
    }
    if (targetMem.rank !== 'Officer') throw new Error(`${targetMem.name} is already a Member.`);
    targetMem.rank = 'Member';
    const liveTarget = online(targetId);
    if (liveTarget) syncProjection(liveTarget);
    persistOrder(ord);
    ejectUnauthorizedHallOccupants(ord);
    pushOrderMembers(ord, 'order.demote', `${targetMem.name} was demoted to Member.`);
  });

  txAction('order.kick', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    const me = ord.members[String(p.id)];
    if (!me || !orderHasPermission(ord, p.id, 'kick')) {
      throw new Error('You do not have permission to kick members.');
    }
    const targetId = toPlayerId(args.targetId);
    if (targetId === p.id) throw new Error('Use Leave to leave the order.');
    const targetMem = ord.members[String(targetId)];
    if (!targetMem) throw new Error('That player is not in your order.');
    if (rankWeight(me.rank) <= rankWeight(targetMem.rank)) {
      throw new Error(`You do not outrank ${targetMem.name}.`);
    }
    delete ord.members[String(targetId)];
    delete ord.memberPermissions[String(targetId)];
    memberOrder.delete(targetId);
    const liveTarget = online(targetId);
    if (liveTarget) {
      syncProjection(liveTarget);
      if (playerHall.get(liveTarget.id) === ord.id) {
        ejectFromHall(liveTarget, ord.hall, `You were removed from [${ord.tag}] ${ord.name}.`);
      }
    }
    persistOrder(ord);
    if (liveTarget) pushOverview(liveTarget, 'order.kick', `You were removed from [${ord.tag}] ${ord.name}.`);
    pushOrderMembers(ord, 'order.kick', `${targetMem.name} was removed from [${ord.tag}] ${ord.name}.`);
  });

  txAction('order.leave', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    const wasLeader = ord.leaderId === p.id;
    const otherMembers = Object.values(ord.members).filter((m) => m.id !== p.id);

    if (!otherMembers.length) {
      if (ord.vault.length > 0) {
        throw new Error('Empty the order item vault before leaving as the final member.');
      }
      delete ord.members[String(p.id)];
      memberOrder.delete(p.id);
      syncProjection(p);
      ejectAllHallOccupants(ord, `[${ord.tag}] ${ord.name} was disbanded.`);
      if (ord.treasury > 0) addGold(p, ord.treasury);
      orders.delete(ord.id);
      nameIndex.delete(ord.name.toLowerCase());
      tagIndex.delete(ord.tag.toUpperCase());
      clearOrderInvites(ord.id);
      deletePersistedOrder(ord.id);
      pushOverview(p, 'order.leave', `[${ord.tag}] ${ord.name} was disbanded as its last member left.`);
      return;
    }

    let chosenHeir = null;
    if (wasLeader) {
      if (args.successorId != null) {
        const sid = toPlayerId(args.successorId);
        if (sid === p.id || !ord.members[String(sid)]) {
          throw new Error('Choose a valid member of your order as successor.');
        }
        chosenHeir = ord.members[String(sid)];
      } else {
        chosenHeir = pickDeterministicSuccessor(otherMembers);
      }
    }

    delete ord.members[String(p.id)];
    delete ord.memberPermissions[String(p.id)];
    memberOrder.delete(p.id);
    syncProjection(p);
    if (playerHall.get(p.id) === ord.id) {
      ejectFromHall(p, ord.hall, `You left [${ord.tag}] ${ord.name}.`);
    }

    let extra = '';
    if (wasLeader && chosenHeir) {
      chosenHeir.rank = 'Leader';
      ord.leaderId = chosenHeir.id;
      delete ord.memberPermissions[String(chosenHeir.id)];
      const liveHeir = online(chosenHeir.id);
      if (liveHeir) syncProjection(liveHeir);
      extra = ` ${chosenHeir.name} succeeds as Leader.`;
    }
    persistOrder(ord);
    pushOrderMembers(ord, 'order.leave', `${p.name} left [${ord.tag}] ${ord.name}.${extra}`);
    pushOverview(p, 'order.leave', `You left [${ord.tag}] ${ord.name}.`);
  });

  txAction('order.disband', (p) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    if (ord.leaderId !== p.id) throw new Error('Only the order Leader can disband the order.');
    if (ord.vault.length > 0) {
      throw new Error('Empty the order item vault before disbanding.');
    }
    const formerIds = Object.values(ord.members).map((m) => m.id);
    ejectAllHallOccupants(ord, `[${ord.tag}] ${ord.name} has been disbanded.`);
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
    if (!orderHasPermission(ord, p.id, 'editMotd')) {
      throw new Error('You do not have permission to update the charter / MOTD.');
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
    pushAudit(ord, {
      actorId: p.id,
      actorName: p.name,
      action: 'gold_deposit',
      gold: amount,
      balance: ord.treasury,
    });
    persistOrder(ord);
    pushOrderMembers(ord, 'order.deposit', `${p.name} deposited ${amount} gold into the treasury (balance: ${ord.treasury}g).`);
  });

  txAction('order.withdraw', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    if (!orderHasPermission(ord, p.id, 'withdrawTreasury')) {
      throw new Error('You do not have permission to withdraw from the treasury.');
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
    pushAudit(ord, {
      actorId: p.id,
      actorName: p.name,
      action: 'gold_withdraw',
      gold: amount,
      balance: ord.treasury,
    });
    persistOrder(ord);
    pushOrderMembers(ord, 'order.withdraw', `${p.name} withdrew ${amount} gold from the treasury (balance: ${ord.treasury}g).`);
  });

  // ---------------------------------------------------------------- Order Vault actions

  ctx.onAction('order.vaultDeposit', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    if (!orderHasPermission(ord, p.id, 'depositVault')) {
      throw new Error('You do not have permission to deposit into the order vault.');
    }
    if (typeof services.runDurable === 'function') {
      ctx.afterCommit(() => {
        vaultDeposit(p, args).catch((err) => {
          ctx.notify?.(p, { kind: 'guild', action: 'order.vaultDeposit', error: true, code: err?.code ?? null, text: err?.message || 'Vault deposit failed.' });
        });
      });
      return;
    }
    const snap = captureState();
    ctx.onRollback?.(() => restoreState(snap));
    const res = applyDepositToContainer(p.rpg, ord.vault, args.itemId, args.quantity ?? null, {
      shared: true,
      capacity: ord.vaultCapacity ?? ORDER_VAULT_CAPACITY,
      allowGold: false,
      wrapSlot: (item) => ({ item, depositedBy: p.id, depositedByName: p.name, depositedAt: now() }),
      unwrapSlot: (s) => s?.item ?? s,
    });
    dirty(p);
    Object.assign(p.rpg, res.rpg);
    ord.vault = res.list;
    ord.vaultRevision = (ord.vaultRevision || 1) + 1;
    pushAudit(ord, {
      actorId: p.id,
      actorName: p.name,
      action: 'vault_deposit',
      itemId: res.moved.id,
      itemName: res.moved.name,
      template: res.moved.template,
      fingerprint: res.fingerprint,
      quantity: res.moved.quantity,
    });
    persistOrder(ord);
    const label = `${res.moved.quantity > 1 ? `${res.moved.quantity} × ` : ''}${res.moved.name}`;
    pushOrderMembers(ord, 'order.vaultDeposit', `${p.name} deposited ${label} into the order vault.`);
  });

  ctx.onAction('order.vaultWithdraw', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    if (!orderHasPermission(ord, p.id, 'withdrawVault')) {
      throw new Error('You do not have permission to withdraw from the order vault.');
    }
    if (typeof services.runDurable === 'function') {
      ctx.afterCommit(() => {
        vaultWithdraw(p, args).catch((err) => {
          ctx.notify?.(p, { kind: 'guild', action: 'order.vaultWithdraw', error: true, code: err?.code ?? null, text: err?.message || 'Vault withdrawal failed.' });
        });
      });
      return;
    }
    const snap = captureState();
    ctx.onRollback?.(() => restoreState(snap));
    const maxCarryKg = typeof services.maxEncumbrance === 'function' ? services.maxEncumbrance(p) : null;
    const res = applyWithdrawFromContainer(p.rpg, ord.vault, args.itemId, args.quantity ?? null, {
      maxCarryKg,
      unwrapSlot: (s) => s?.item ?? s,
      rewrapSlot: (oldSlot, nextItem) => ({ ...oldSlot, item: nextItem }),
      isWrapped: true,
    });
    dirty(p);
    Object.assign(p.rpg, res.rpg);
    ord.vault = res.list;
    ord.vaultRevision = (ord.vaultRevision || 1) + 1;
    pushAudit(ord, {
      actorId: p.id,
      actorName: p.name,
      action: 'vault_withdraw',
      itemId: res.taken.id,
      itemName: res.taken.name,
      template: res.taken.template,
      fingerprint: res.fingerprint,
      quantity: res.taken.quantity,
    });
    persistOrder(ord);
    const label = `${res.taken.quantity > 1 ? `${res.taken.quantity} × ` : ''}${res.taken.name}`;
    pushOrderMembers(ord, 'order.vaultWithdraw', `${p.name} withdrew ${label} from the order vault.`);
  });

  // ---------------------------------------------------------------- Order Hall actions

  ctx.onAction('order.hallQuote', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    const spec = Object.hasOwn(ORDER_HALL_CATALOG, String(args.hallId ?? '')) ? ORDER_HALL_CATALOG[String(args.hallId)] : null;
    if (!spec) throw new Error('Choose an approved Order Hall building.');
    ctx.notify(p, {
      kind: 'guild',
      action: 'order.hallQuote',
      quote: {
        hall: { ...spec },
        price: spec.price,
        treasury: ord.treasury,
        canAfford: ord.treasury >= spec.price,
        alreadyOwned: Boolean(ord.hall),
      },
    });
  });

  ctx.onAction('order.hallBuy', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord) throw new Error('You are not in a player order.');
    if (ord.leaderId !== p.id) throw new Error('Only the order Leader can purchase an Order Hall.');
    if (ord.hall) throw new Error('Your order already owns an Order Hall.');
    const spec = Object.hasOwn(ORDER_HALL_CATALOG, String(args.hallId ?? '')) ? ORDER_HALL_CATALOG[String(args.hallId)] : null;
    if (!spec) throw new Error('Choose an approved Order Hall building.');
    if (args.confirm !== true) {
      throw new Error(`Confirm purchase of ${spec.name} for ${spec.price} gold from the order treasury.`);
    }
    if (ord.treasury < spec.price) {
      throw new Error(`The treasury needs ${spec.price} gold to buy ${spec.name} (current balance: ${ord.treasury}g).`);
    }
    if (typeof services.runDurable === 'function') {
      ctx.afterCommit(() => {
        buyHall(p, args).catch((err) => {
          ctx.notify?.(p, { kind: 'guild', action: 'order.hallBuy', error: true, text: err?.message || 'Could not purchase Order Hall.' });
        });
      });
      return;
    }
    const snap = captureState();
    ctx.onRollback?.(() => restoreState(snap));
    ord.treasury -= spec.price;
    ord.hall = normalizeHallRecord({ ...spec, boughtAt: now(), visitorMode: 'members', visitors: {}, furnishings: [], furnishingRev: 1 });
    ord.ledger.push({
      at: new Date().toISOString(),
      actorId: p.id,
      actorName: p.name,
      kind: 'withdraw',
      amount: spec.price,
      balance: ord.treasury,
    });
    if (ord.ledger.length > ORDER_LEDGER_MAX) ord.ledger.splice(0, ord.ledger.length - ORDER_LEDGER_MAX);
    pushAudit(ord, { actorId: p.id, actorName: p.name, action: 'hall_buy', gold: spec.price, balance: ord.treasury, detail: `Purchased ${spec.name}` });
    persistOrder(ord);
    pushOrderMembers(ord, 'order.hallBuy', `${p.name} purchased ${spec.name} for ${spec.price}g from the order treasury.`);
  });

  txAction('order.hallAccess', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord || !ord.hall) throw new Error('Your order does not own an Order Hall.');
    if (!orderHasPermission(ord, p.id, 'decorateHall') && ord.leaderId !== p.id) {
      throw new Error('You do not have permission to change Order Hall visitor access.');
    }
    const mode = String(args.visitorMode ?? '').toLowerCase();
    if (!HALL_VISITOR_MODES.includes(mode)) throw new Error('Visitor mode must be members, invited, or open.');
    ord.hall.visitorMode = mode;
    persistOrder(ord);
    ejectUnauthorizedHallOccupants(ord);
    pushOrderMembers(ord, 'order.hallAccess', `Order Hall visitor access set to ${mode}.`);
  });

  txAction('order.hallInviteVisitor', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord || !ord.hall) throw new Error('Your order does not own an Order Hall.');
    if (!orderHasPermission(ord, p.id, 'invite') && !orderHasPermission(ord, p.id, 'decorateHall')) {
      throw new Error('You do not have permission to invite visitors to the Order Hall.');
    }
    const targetId = toPlayerId(args.targetId);
    const live = online(targetId);
    const targetDesc = live ?? { id: targetId, name: cleanText(args.targetName) || `Traveller ${targetId}` };
    if (typeof services.isBlocked === 'function' && services.isBlocked(p, targetDesc)) {
      throw new Error(NEUTRAL_HALL_REFUSAL);
    }
    ord.hall.visitors[String(targetId)] = { id: targetId, name: targetDesc.name, grantedAt: now() };
    if (ord.hall.visitorMode === 'members') ord.hall.visitorMode = 'invited';
    persistOrder(ord);
    pushOverview(p, 'order.hallInviteVisitor', `Invited ${targetDesc.name} to visit ${ord.hall.name}.`);
  });

  txAction('order.hallRevokeVisitor', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord || !ord.hall) throw new Error('Your order does not own an Order Hall.');
    if (!orderHasPermission(ord, p.id, 'invite') && !orderHasPermission(ord, p.id, 'decorateHall')) {
      throw new Error('You do not have permission to revoke Order Hall visitors.');
    }
    const targetId = toPlayerId(args.targetId);
    delete ord.hall.visitors[String(targetId)];
    persistOrder(ord);
    ejectUnauthorizedHallOccupants(ord, 'Your Order Hall visitor pass was revoked.');
    pushOverview(p, 'order.hallRevokeVisitor', 'Revoked Order Hall visitor pass.');
  });

  txAction('order.hallEnter', (p, args = {}) => {
    const ord = args.orderId ? orders.get(String(args.orderId)) : orderOf(p);
    if (!ord || !ord.hall) throw new Error(NEUTRAL_HALL_REFUSAL);
    const check = canEnterHall(p, ord);
    if (!check.ok) throw new Error(check.reason);
    const curLoc = locationOf(p);
    const returnTo = !curLoc.startsWith('interior:')
      ? { location: curLoc, x: p.x ?? 0, y: 0, z: p.z ?? 0, yaw: p.yaw ?? 0 }
      : hallExteriorLanding(p, ord.hall);
    setHallOccupant(p, ord.id, returnTo);
    movePlayer(p, { location: ord.hall.interior, x: 0, y: 0, z: 0, yaw: 0 }, ord.hall.name);
    ctx.notify(p, {
      kind: 'order.hallFurnishings',
      orderId: ord.id,
      furnishingRev: ord.hall.furnishingRev,
      furnishings: ord.hall.furnishings.map((f) => ({ ...f })),
    });
    pushOverview(p, 'order.hallEnter', `Entered ${ord.hall.name}.`);
  });

  txAction('order.hallLeave', (p) => {
    const oid = playerHall.get(p.id);
    const ord = oid ? orders.get(oid) : null;
    if (!ord || !ord.hall) throw new Error('You are not inside an Order Hall.');
    setHallOccupant(p, null);
    movePlayer(p, hallExteriorLanding(p, ord.hall), 'outside the hall');
    pushOverview(p, 'order.hallLeave', `Left ${ord.hall.name}.`);
  });

  txAction('order.hallFurnishPlace', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord || !ord.hall) throw new Error('Your order does not own an Order Hall.');
    if (!orderHasPermission(ord, p.id, 'decorateHall')) {
      throw new Error('You do not have permission to decorate the Order Hall.');
    }
    const collisionWorld = services.collision?.instanceWorld?.(ord.hall.interior) ?? null;
    const check = validateFurnishingPlacement({
      space: ord.hall,
      catalogId: String(args.catalogId ?? ''),
      x: args.x,
      y: args.y,
      z: args.z,
      yaw: args.yaw ?? 0,
      floor: args.floor ?? 0,
      existing: ord.hall.furnishings,
      maxTotal: MAX_FURNISHINGS_PER_HALL,
      isOrderHall: true,
      collisionWorld,
    });
    if (!check.ok) {
      const err = new Error(check.reason);
      err.code = check.code;
      throw err;
    }
    const cost = check.spec.price;
    if (cost > 0 && args.free !== true) {
      if (args.payFrom === 'treasury') {
        if (!orderHasPermission(ord, p.id, 'withdrawTreasury')) {
          throw new Error('You do not have permission to spend treasury gold.');
        }
        if (ord.treasury < cost) throw new Error(`Treasury needs ${cost} gold.`);
        ord.treasury -= cost;
        ord.ledger.push({ at: new Date().toISOString(), actorId: p.id, actorName: p.name, kind: 'withdraw', amount: cost, balance: ord.treasury });
        if (ord.ledger.length > ORDER_LEDGER_MAX) ord.ledger.splice(0, ord.ledger.length - ORDER_LEDGER_MAX);
      } else {
        takeGold(p, cost);
      }
    }
    const placed = {
      id: newFurnishingId(),
      ...check.placement,
      placedBy: p.id,
      placedAt: now(),
    };
    ord.hall.furnishings.push(placed);
    ord.hall.furnishingRev = (ord.hall.furnishingRev || 1) + 1;
    persistOrder(ord);
    broadcastHallFurnishings(ord);
    pushOrderMembers(ord, 'order.hallFurnishPlace', `${p.name} placed ${placed.name} in ${ord.hall.name}.`);
  });

  txAction('order.hallFurnishMove', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord || !ord.hall) throw new Error('Your order does not own an Order Hall.');
    if (!orderHasPermission(ord, p.id, 'decorateHall')) {
      throw new Error('You do not have permission to decorate the Order Hall.');
    }
    const fid = String(args.furnishingId ?? '');
    const item = ord.hall.furnishings.find((f) => f.id === fid);
    if (!item) throw new Error('That furnishing is not placed in the hall.');
    const collisionWorld = services.collision?.instanceWorld?.(ord.hall.interior) ?? null;
    const check = validateFurnishingPlacement({
      space: ord.hall,
      catalogId: item.catalogId,
      x: args.x ?? item.x,
      y: args.y ?? item.y,
      z: args.z ?? item.z,
      yaw: args.yaw ?? item.yaw,
      floor: args.floor ?? item.floor,
      existing: ord.hall.furnishings,
      ignoreId: item.id,
      maxTotal: MAX_FURNISHINGS_PER_HALL,
      isOrderHall: true,
      collisionWorld,
    });
    if (!check.ok) {
      const err = new Error(check.reason);
      err.code = check.code;
      throw err;
    }
    Object.assign(item, check.placement);
    ord.hall.furnishingRev = (ord.hall.furnishingRev || 1) + 1;
    persistOrder(ord);
    broadcastHallFurnishings(ord);
    pushOrderMembers(ord, 'order.hallFurnishMove', `${p.name} rearranged ${item.name} in ${ord.hall.name}.`);
  });

  txAction('order.hallFurnishRemove', (p, args = {}) => {
    const ord = orderOf(p);
    if (!ord || !ord.hall) throw new Error('Your order does not own an Order Hall.');
    if (!orderHasPermission(ord, p.id, 'decorateHall')) {
      throw new Error('You do not have permission to decorate the Order Hall.');
    }
    const fid = String(args.furnishingId ?? '');
    const idx = ord.hall.furnishings.findIndex((f) => f.id === fid);
    if (idx < 0) throw new Error('That furnishing is not placed in the hall.');
    const [removed] = ord.hall.furnishings.splice(idx, 1);
    ord.hall.furnishingRev = (ord.hall.furnishingRev || 1) + 1;
    const refund = furnishingRefundValue(removed.catalogId);
    if (refund > 0) ord.treasury += refund;
    persistOrder(ord);
    broadcastHallFurnishings(ord);
    pushOrderMembers(ord, 'order.hallFurnishRemove', `${p.name} removed ${removed.name} from ${ord.hall.name}${refund > 0 ? ` (+${refund}g to treasury)` : ''}.`);
  });

  // ---------------------------------------------------------------- presenceScope, blockers & purge

  const prevPresenceScope = services.presenceScope;
  services.presenceScope = (p) => {
    const oid = p ? playerHall.get(p.id) : null;
    if (oid) {
      const ord = orders.get(oid);
      if (ord?.hall && locationOf(p) === ord.hall.interior) return `orderhall:${oid}`;
    }
    return typeof prevPresenceScope === 'function' ? prevPresenceScope(p) : null;
  };

  // Archive blocker: block archiving sole leader with active members or shared assets.
  services.characterBlockers ||= [];
  services.characterBlockers.push((accountId, characterId, kind) => {
    if (kind !== 'archive') return [];
    const cid = int(characterId, NaN);
    if (!Number.isSafeInteger(cid)) return [];
    const ord = orderOf(cid);
    if (!ord || ord.leaderId !== cid) return [];
    const memberCount = Object.keys(ord.members).length;
    const hasSharedAssets = memberCount > 1 || ord.treasury > 0 || Boolean(ord.hall) || ord.vault.length > 0;
    if (!hasSharedAssets) return [];
    return [{
      code: 'SOLE_ORDER_LEADER',
      message: `Transfer leadership of [${ord.tag}] ${ord.name} or settle its shared hall, vault, and treasury before archiving.`,
      route: 'guilds',
    }];
  });

  /**
   * Forced character removal / purge handler (account deletion or archive expiry):
   *   - Elects deterministic successor (longest-serving eligible Officer -> Member -> lowest ID)
   *     while preserving populated Order Hall, Treasury, and Item Vault.
   *   - If no successor remains, returns eligible vault items to original depositors via durable
   *     `claim_records` and records remaining items/treasury in `pguild:reconcile:<id>` BEFORE
   *     deleting the hall and order.
   */
  async function handleCharacterPurge({ characterId }) {
    const cid = int(characterId, NaN);
    if (!Number.isSafeInteger(cid)) return null;
    const ord = orderOf(cid);
    if (!ord) return null;

    const remaining = Object.values(ord.members).filter((m) => m.id !== cid);
    delete ord.members[String(cid)];
    delete ord.memberPermissions[String(cid)];
    memberOrder.delete(cid);

    if (remaining.length > 0) {
      let successor = null;
      if (ord.leaderId === cid) {
        successor = pickDeterministicSuccessor(remaining);
        if (successor) {
          successor.rank = 'Leader';
          ord.leaderId = successor.id;
          delete ord.memberPermissions[String(successor.id)];
          const liveHeir = online(successor.id);
          if (liveHeir) syncProjection(liveHeir);
        }
      }
      ord.revision = (ord.revision || 1) + 1;
      if (typeof services.store?.saveCharacters === 'function') {
        await Promise.resolve(services.store.saveCharacters([], [[`${PGUILD_PREFIX}${ord.id}`, structuredClone(ord)]]));
      } else {
        persistOrder(ord);
      }
      pushOrderMembers(ord, 'order.succession', successor ? `${successor.name} succeeded as Leader of [${ord.tag}] ${ord.name}.` : null);
      return { action: 'succeeded', orderId: ord.id, successorId: successor?.id ?? null };
    }

    // No successor remains: settle vault items & record destinations before deleting hall and order.
    ejectAllHallOccupants(ord, `[${ord.tag}] ${ord.name} was dissolved.`);
    const destinations = [];
    const createdClaims = [];
    const reconcileKey = `${PGUILD_RECONCILE_PREFIX}${ord.id}`;

    const settleInTx = async (tx) => {
      for (const slot of ord.vault) {
        const depositor = slot.depositedBy;
        const canReturnToDepositor = Number.isSafeInteger(depositor) && depositor !== cid;
        if (canReturnToDepositor && tx?.createClaim) {
          const claim = await Promise.resolve(tx.createClaim({
            ownerCharacterId: depositor,
            ownerAccountId: null,
            kind: 'order_vault_return',
            sourceRef: `pguild:${ord.id}:${slot.item.id}`,
            gold: 0,
            item: structuredClone(slot.item),
            reason: `Returned from dissolved order [${ord.tag}] ${ord.name}.`,
          }));
          createdClaims.push(claim);
          destinations.push({
            itemId: slot.item.id,
            itemName: slot.item.name,
            quantity: slot.item.quantity,
            destination: 'depositor_claim',
            depositorId: depositor,
            claimId: claim.id,
          });
        } else {
          destinations.push({
            itemId: slot.item.id,
            itemName: slot.item.name,
            quantity: slot.item.quantity,
            destination: 'operator_reconciliation',
            depositorId: depositor ?? null,
            item: structuredClone(slot.item),
          });
        }
      }
      const reconcileRecord = {
        orderId: ord.id,
        orderName: ord.name,
        orderTag: ord.tag,
        purgedLeaderId: cid,
        dissolvedAt: new Date().toISOString(),
        treasuryRemainder: ord.treasury,
        hadHall: Boolean(ord.hall),
        hallInterior: ord.hall?.interior ?? null,
        vaultDestinations: destinations,
      };
      if (tx?.saveCharacters) {
        await Promise.resolve(tx.saveCharacters([], [
          [reconcileKey, reconcileRecord],
          [`${PGUILD_PREFIX}${ord.id}`, null],
        ]));
      }
      return reconcileRecord;
    };

    let reconcileRecord = null;
    if (typeof services.runDurable === 'function') {
      const outcome = await trackOp(services.runDurable(
        `order-purge-${ord.id}-${cid}`,
        { characterId: cid, resourceKey: `pguild:${ord.id}`, params: { orderId: ord.id, purgedId: cid } },
        (tx) => settleInTx(tx),
      ));
      reconcileRecord = outcome.result;
    } else {
      reconcileRecord = await settleInTx(null);
      ctx.dirtyWorld?.(reconcileKey, reconcileRecord);
      deletePersistedOrder(ord.id);
    }

    orders.delete(ord.id);
    nameIndex.delete(ord.name.toLowerCase());
    tagIndex.delete(ord.tag.toUpperCase());
    clearOrderInvites(ord.id);
    return { action: 'dissolved', orderId: ord.id, claims: createdClaims, reconcileRecord };
  }

  services.onCharacterPurge ||= [];
  services.onCharacterPurge.push(handleCharacterPurge);

  // ---------------------------------------------------------------- lifecycle

  ctx.onJoin?.((p) => {
    const ord = orderOf(p);
    if (ord && ord.members[String(p.id)]) {
      ord.members[String(p.id)].name = p.name;
    }
    syncProjection(p, { markDirty: false });
    // Reconcile Order Hall occupancy on reconnect.
    const saved = p.rpg?.activeOrderHall;
    if (saved?.orderId) {
      const hallOrd = orders.get(saved.orderId);
      if (!hallOrd?.hall || locationOf(p) !== hallOrd.hall.interior || !canEnterHall(p, hallOrd).ok) {
        ejectFromHall(p, hallOrd?.hall ?? { town: saved.returnTo?.location }, 'Your Order Hall visit ended; you were returned outside.');
      } else {
        setHallOccupant(p, hallOrd.id, saved.returnTo);
        ctx.notify?.(p, {
          kind: 'order.hallFurnishings',
          orderId: hallOrd.id,
          furnishingRev: hallOrd.hall.furnishingRev,
          furnishings: hallOrd.hall.furnishings.map((f) => ({ ...f })),
        });
      }
    }
  });

  ctx.onLeave?.((p) => {
    orderInvites.delete(p.id);
    const oid = playerHall.get(p.id);
    if (oid) {
      hallOccupants.get(oid)?.delete(p.id);
      if (hallOccupants.get(oid)?.size === 0) hallOccupants.delete(oid);
      playerHall.delete(p.id);
    }
    const ord = orderOf(p);
    if (ord) pushOrderMembers(ord, 'overview', null, p.id);
  });

  ctx.on?.('locationChanged', ({ player: p, to }) => {
    if (!p) return;
    const oid = playerHall.get(p.id);
    if (oid) {
      const ord = orders.get(oid);
      if (!ord?.hall || ord.hall.interior !== to) setHallOccupant(p, null);
    }
  });

  const api = {
    orders,
    orderOf,
    overviewOf,
    directoryOf,
    orderView,
    hasOrderPermission: (playerOrId, perm) => {
      const pid = typeof playerOrId === 'number' ? playerOrId : playerOrId?.id;
      const ord = orderOf(pid);
      return orderHasPermission(ord, pid, perm);
    },
    hasOrderPermissionForOrder: (orderId, playerOrId, perm) => {
      const pid = typeof playerOrId === 'number' ? playerOrId : playerOrId?.id;
      const ord = orders.get(String(orderId ?? ''));
      return orderHasPermission(ord, pid, perm);
    },
    vaultDeposit,
    vaultWithdraw,
    buyHall,
    handleCharacterPurge,
    hallCatalog: ORDER_HALL_CATALOG,
    furnishingCatalog: FURNISHING_CATALOG,
    whenIdle: () => Promise.allSettled([...pendingDurableOps]),
  };
  services.guildhall = api;
  return api;
}

export default install;
