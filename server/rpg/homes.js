// Personal Homes (§2 multiplayer-feature-plan.md):
//   - Stable per-instance home records (`world_state` key `home:<id>`)
//   - Lossless migration of legacy `rpg.property.houses` deeds + `house:<regionKey>` storage,
//     preserving duplicate deeds on the same building as separate isolated home instances
//     and marking legacy-claimed addresses unavailable for new bank offers
//   - Transactional address reservation for new offers (race-safe via `runDurable`)
//   - Guest access control (private / invited / visiting hours) honoring `services.isBlocked`
//     and `services.canInteract(..., 'visit')` without leaking block status
//   - Furnishing placement, movement, rotation, floor, door-clearance, collision & cap checks,
//     replicated by revision to visitors in the same `presenceScope` (`home:<id>`)
//   - Home storage chests (`chest-main` + placed `storage-chest` furnishings) using `runDurable`
//     and `server/rpg/inventory.js` eligibility/stack helpers
//   - House trader furnishing slot & ownership/access verification hooks for `market`
//   - Archive blockers (`ctx.services.characterBlockers`) and purge cleanup (`ctx.services.onCharacterPurge`)

import { randomBytes } from 'node:crypto';
import { dateFromMinutes } from '../../client/gameplay/atmosphere/calendar.js';
import { deedSellPrice, exteriorTownOf } from '../../client/gameplay/property/rules.js';
import { placeOf, regionKey } from '../../client/gameplay/townServices/rules.js';
import {
  FURNISHING_CATALOG,
  FURNISHING_LIST,
  MAX_FURNISHINGS_PER_HOME,
  getCatalogItem,
  validateFurnishingPlacement,
  furnishingRefundValue,
} from './homes/catalog.js';
import {
  applyDepositToContainer,
  applyWithdrawFromContainer,
  ensurePlayerInventory,
  normalizeRecord,
} from './homes/storage.js';

export const name = 'homes';
export const HOME_PREFIX = 'home:';
export const HOME_ADDR_PREFIX = 'home:addr:';
export const DEFAULT_CHEST_ID = 'chest-main';
export const DEFAULT_CHEST_CAPACITY = 100;
export const ACCESS_MODES = Object.freeze(['private', 'invited', 'hours']);
export const MAX_GUESTS = 50;
export const NEUTRAL_VISIT_REFUSAL = 'That home is not accepting visitors right now.';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const int = (v, d = 0) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : d);
const newHomeId = () => `hm_${randomBytes(6).toString('hex')}`;
const newFurnishingId = () => `fn_${randomBytes(5).toString('hex')}`;
const cleanText = (s, max = 64) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function normalizeVisitingHours(raw) {
  const open = Number.isInteger(raw?.open) ? Math.max(0, Math.min(23, raw.open)) : 8;
  const close = Number.isInteger(raw?.close) ? Math.max(0, Math.min(24, raw.close)) : 20;
  return { open, close };
}

function normalizeContainer(raw, fallbackId = DEFAULT_CHEST_ID) {
  const id = typeof raw?.id === 'string' && /^[\w-]{1,48}$/.test(raw.id) ? raw.id : fallbackId;
  const items = [];
  for (const it of Array.isArray(raw?.items) ? raw.items : []) {
    if (!isObj(it)) continue;
    if (it.template === 'gold') {
      const q = int(it.quantity, 0);
      if (q > 0) items.push({ template: 'gold', name: 'Gold pieces', quantity: q });
      continue;
    }
    const norm = normalizeRecord(it);
    if (norm) items.push(norm);
  }
  return {
    id,
    name: cleanText(raw?.name, 48) || (id === DEFAULT_CHEST_ID ? 'House Storage Chest' : 'Storage Chest'),
    capacity: Math.max(10, Math.min(200, int(raw?.capacity, DEFAULT_CHEST_CAPACITY))),
    revision: Math.max(1, int(raw?.revision, 1)),
    items,
  };
}

export function normalizeHomeRecord(raw) {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id.startsWith('hm_')) return null;
  if (!Number.isSafeInteger(raw.ownerId) || typeof raw.interior !== 'string' || !raw.interior) return null;
  const region = cleanText(raw.region, 64) || 'Daggerfall';
  const rKey = typeof raw.regionKey === 'string' && raw.regionKey ? raw.regionKey : regionKey(region);
  const accessRaw = isObj(raw.access) ? raw.access : {};
  const mode = ACCESS_MODES.includes(accessRaw.mode) ? accessRaw.mode : 'private';
  const guests = {};
  if (isObj(accessRaw.guests)) {
    for (const [k, g] of Object.entries(accessRaw.guests)) {
      if (!isObj(g) || !Number.isSafeInteger(g.id)) continue;
      guests[String(g.id)] = {
        id: g.id,
        name: cleanText(g.name, 48) || `Traveller ${g.id}`,
        grantedAt: int(g.grantedAt, 0),
        expiresAt: g.expiresAt != null && Number.isFinite(Number(g.expiresAt)) ? Math.trunc(Number(g.expiresAt)) : null,
      };
    }
  }
  const furnishings = [];
  const seenFurn = new Set();
  for (const f of Array.isArray(raw.furnishings) ? raw.furnishings : []) {
    if (!isObj(f) || typeof f.id !== 'string' || seenFurn.has(f.id)) continue;
    const spec = getCatalogItem(f.catalogId);
    if (!spec) continue;
    if (![f.x, f.y, f.z].every(Number.isFinite)) continue;
    seenFurn.add(f.id);
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
      ...(isObj(f.crafted) ? { crafted: structuredClone(f.crafted) } : {}),
      placedBy: Number.isSafeInteger(f.placedBy) ? f.placedBy : raw.ownerId,
      placedAt: int(f.placedAt, 0),
    });
  }
  const containers = {};
  if (isObj(raw.containers)) {
    for (const [cid, c] of Object.entries(raw.containers)) {
      if (!isObj(c)) continue;
      const norm = normalizeContainer(c, cid);
      containers[norm.id] = norm;
    }
  }
  if (!containers[DEFAULT_CHEST_ID]) {
    containers[DEFAULT_CHEST_ID] = normalizeContainer({ id: DEFAULT_CHEST_ID, name: 'House Storage Chest', capacity: DEFAULT_CHEST_CAPACITY, items: [] });
  }
  // Ensure every placed chest furnishing has its container entry.
  for (const f of furnishings) {
    if (f.kind === 'chest') {
      const cid = `chest-${f.id}`;
      if (!containers[cid]) {
        const spec = getCatalogItem(f.catalogId);
        containers[cid] = normalizeContainer({ id: cid, name: spec?.name || 'Storage Chest', capacity: spec?.capacity ?? 60, items: [] });
      }
    }
  }
  let trader = null;
  const traderFurn = furnishings.find((f) => f.kind === 'trader');
  if (traderFurn) {
    const tr = isObj(raw.trader) ? raw.trader : {};
    trader = {
      furnishingId: traderFurn.id,
      npcName: cleanText(tr.npcName, 48) || 'House Steward',
      enabled: tr.enabled !== false,
      listingIds: Array.isArray(tr.listingIds) ? [...new Set(tr.listingIds.map(String).filter(Boolean))] : [],
      updatedAt: int(tr.updatedAt, 0),
    };
  }
  return {
    id: raw.id,
    ownerId: raw.ownerId,
    ownerAccountId: raw.ownerAccountId != null ? String(raw.ownerAccountId) : null,
    ownerName: cleanText(raw.ownerName, 48) || `Player ${raw.ownerId}`,
    region,
    regionKey: rKey,
    regionIndex: Number.isInteger(raw.regionIndex) ? raw.regionIndex : null,
    town: cleanText(raw.town, 200) || exteriorTownOf(raw.interior) || 'town:Daggerfall/Gothway Garden',
    buildingId: cleanText(raw.buildingId, 48),
    interior: cleanText(raw.interior, 200),
    buildingType: int(raw.buildingType, 1),
    radius: Number.isFinite(Number(raw.radius)) ? Number(raw.radius) : 10,
    price: Math.max(0, int(raw.price, 0)),
    boughtAt: int(raw.boughtAt, 0),
    legacy: raw.legacy === true,
    legacyStorageMigrated: raw.legacyStorageMigrated === true,
    archived: raw.archived === true,
    access: {
      mode,
      guests,
      visitingHours: normalizeVisitingHours(accessRaw.visitingHours),
    },
    furnishings,
    furnishingRev: Math.max(1, int(raw.furnishingRev, 1)),
    containers,
    trader,
    createdAt: int(raw.createdAt, 0),
    updatedAt: int(raw.updatedAt, 0),
    revision: Math.max(1, int(raw.revision, 1)),
  };
}

function isWithinHours(hour, { open, close }) {
  if (!Number.isFinite(hour)) return true;
  if (open === close) return true;
  if (open < close) return hour >= open && hour < close;
  return hour >= open || hour < close;
}

export function install(ctx, options = {}) {
  const services = (ctx.services ||= {});
  const now = () => (typeof ctx.now === 'function' ? ctx.now() : Date.now());
  const online = (id) => ctx.players?.get(id) ?? null;
  const locationOf = (p) => (typeof ctx.location === 'function' ? ctx.location(p) : p?.rpg?.location ?? 'town:Daggerfall/Gothway Garden');
  const dirty = (p) => { if (p && typeof ctx.dirty === 'function') ctx.dirty(p); };

  // Authoritative in-memory indexes mirrored with `world_state`.
  const homes = new Map();                 // homeId -> homeRecord
  const homesByOwner = new Map();          // ownerId -> Set<homeId>
  const homesByInterior = new Map();       // interior -> Set<homeId>
  const legacyClaimedAddresses = new Set();// interiors claimed by any legacy deed
  const claimedAddresses = new Set();      // interiors claimed by any active/archived/legacy home
  const activeOccupants = new Map();       // homeId -> Set<playerId>
  const playerHome = new Map();            // playerId -> homeId
  const pendingDurableOps = new Set();     // Promise tracking for whenIdle()

  function trackOp(promise) {
    pendingDurableOps.add(promise);
    const cleanup = () => pendingDurableOps.delete(promise);
    promise.then(cleanup, cleanup);
    return promise;
  }

  function rebuildIndexes() {
    homesByOwner.clear();
    homesByInterior.clear();
    legacyClaimedAddresses.clear();
    claimedAddresses.clear();
    for (const h of homes.values()) {
      if (!homesByOwner.has(h.ownerId)) homesByOwner.set(h.ownerId, new Set());
      homesByOwner.get(h.ownerId).add(h.id);
      if (!homesByInterior.has(h.interior)) homesByInterior.set(h.interior, new Set());
      homesByInterior.get(h.interior).add(h.id);
      claimedAddresses.add(h.interior);
      if (h.legacy) legacyClaimedAddresses.add(h.interior);
    }
  }

  // Load persisted home rows on startup.
  for (const [key, val] of ctx.loadWorld?.(HOME_PREFIX) ?? []) {
    if (!key.startsWith(HOME_PREFIX) || key.startsWith(HOME_ADDR_PREFIX)) continue;
    const rec = normalizeHomeRecord(val);
    if (!rec) continue;
    homes.set(rec.id, rec);
  }
  rebuildIndexes();

  function persistHome(h) {
    h.updatedAt = now();
    h.revision = (h.revision || 1) + 1;
    ctx.dirtyWorld?.(`${HOME_PREFIX}${h.id}`, structuredClone(h));
  }

  function deletePersistedHome(homeId) {
    ctx.dirtyWorld?.(`${HOME_PREFIX}${homeId}`, null);
  }

  function captureState() {
    return {
      homes: structuredClone(homes),
      activeOccupants: structuredClone(activeOccupants),
      playerHome: new Map(playerHome),
    };
  }

  function restoreState(snap) {
    homes.clear();
    for (const [k, v] of snap.homes) homes.set(k, v);
    activeOccupants.clear();
    for (const [k, v] of snap.activeOccupants) activeOccupants.set(k, v);
    playerHome.clear();
    for (const [k, v] of snap.playerHome) playerHome.set(k, v);
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

  function goldOf(p) {
    const g = p?.rpg?.gold;
    return Number.isSafeInteger(g) && g > 0 ? g : 0;
  }

  function takeGold(p, amount) {
    if (amount <= 0) return;
    if (goldOf(p) < amount) throw new Error(`You need ${amount} gold (you carry ${goldOf(p)} gold).`);
    dirty(p);
    if (typeof services.takeGold === 'function') services.takeGold(p, amount);
    else p.rpg.gold = goldOf(p) - amount;
  }

  function addGold(p, amount) {
    if (amount <= 0) return;
    dirty(p);
    if (typeof services.addGold === 'function') {
      for (let left = amount; left > 0; left -= 9999) services.addGold(p, Math.min(9999, left));
    } else {
      p.rpg.gold = goldOf(p) + amount;
    }
  }

  function worldHour() {
    const mins = services.worldClock?.()?.minutes;
    if (!Number.isFinite(mins)) return 12;
    return dateFromMinutes(mins).hour;
  }

  // ------------------------------------------------------------------ block & access rules

  function ownerDescriptor(h) {
    const live = online(h.ownerId);
    if (live) return live;
    return {
      id: h.ownerId,
      name: h.ownerName,
      ...(h.ownerAccountId != null ? { accountId: h.ownerAccountId } : {}),
    };
  }

  function isBlockedPair(visitor, home) {
    if (!visitor || !home || visitor.id === home.ownerId) return false;
    const owner = ownerDescriptor(home);
    if (typeof services.isBlocked === 'function' && services.isBlocked(visitor, owner)) return true;
    if (typeof services.canInteract === 'function') {
      const res = services.canInteract(visitor, owner, 'visit');
      if (res && res.ok === false) return true;
    }
    return false;
  }

  function pruneExpiredGuests(h) {
    const t = now();
    let changed = false;
    for (const [k, g] of Object.entries(h.access.guests)) {
      if (g.expiresAt != null && t >= g.expiresAt) {
        delete h.access.guests[k];
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Authoritative home entry check (non-leaking when blocked or denied).
   * Returns `{ ok: true, role: 'owner'|'guest' }` or `{ ok: false, reason }`.
   */
  function canVisitHome(visitor, h) {
    if (!visitor || !h) return { ok: false, reason: NEUTRAL_VISIT_REFUSAL };
    if (h.archived) return { ok: false, reason: NEUTRAL_VISIT_REFUSAL };
    if (visitor.id === h.ownerId) return { ok: true, role: 'owner' };
    if (isBlockedPair(visitor, h)) return { ok: false, reason: NEUTRAL_VISIT_REFUSAL };
    pruneExpiredGuests(h);
    if (h.access.mode === 'private') return { ok: false, reason: NEUTRAL_VISIT_REFUSAL };
    if (h.access.mode === 'invited') {
      if (h.access.guests[String(visitor.id)]) return { ok: true, role: 'guest' };
      return { ok: false, reason: NEUTRAL_VISIT_REFUSAL };
    }
    if (h.access.mode === 'hours') {
      if (h.access.guests[String(visitor.id)]) return { ok: true, role: 'guest' };
      if (isWithinHours(worldHour(), h.access.visitingHours)) return { ok: true, role: 'guest' };
      return { ok: false, reason: NEUTRAL_VISIT_REFUSAL };
    }
    return { ok: false, reason: NEUTRAL_VISIT_REFUSAL };
  }

  function setOccupant(p, homeId, returnTo = null) {
    const prev = playerHome.get(p.id);
    if (prev && prev !== homeId) {
      activeOccupants.get(prev)?.delete(p.id);
      if (activeOccupants.get(prev)?.size === 0) activeOccupants.delete(prev);
    }
    if (homeId) {
      playerHome.set(p.id, homeId);
      if (!activeOccupants.has(homeId)) activeOccupants.set(homeId, new Set());
      activeOccupants.get(homeId).add(p.id);
      const h = homes.get(homeId);
      if (p.rpg) {
        p.rpg.activeHome = {
          homeId,
          interior: h?.interior ?? locationOf(p),
          returnTo: returnTo ?? p.rpg.activeHome?.returnTo ?? { location: h?.town ?? 'town:Daggerfall/Gothway Garden', x: 0, z: 0, yaw: 0 },
        };
      }
    } else {
      playerHome.delete(p.id);
      if (p.rpg) delete p.rpg.activeHome;
    }
  }

  function exteriorLandingFor(p, h) {
    const saved = p?.rpg?.activeHome?.returnTo ?? p?.rpg?.portal?.returnTo;
    if (saved && typeof saved.location === 'string' && !saved.location.startsWith('interior:') && [saved.x, saved.z, saved.yaw].every(Number.isFinite)) {
      return { location: saved.location, x: saved.x, y: saved.y ?? 0, z: saved.z, yaw: saved.yaw };
    }
    const portal = services.portals?.into?.(h?.interior);
    const exit = portal?.entrances?.[0]?.exit;
    if (portal?.from && exit && [exit.x, exit.z].every(Number.isFinite)) {
      return { location: portal.from, x: exit.x, y: exit.y ?? 0, z: exit.z, yaw: exit.yaw ?? 0 };
    }
    return { location: h?.town ?? exteriorTownOf(locationOf(p)) ?? ctx.defaultLocation ?? 'town:Daggerfall/Gothway Garden', x: 0, y: 0, z: 0, yaw: 0 };
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

  function ejectOccupant(p, h, reason = 'You have been returned outside.') {
    if (!p) return;
    setOccupant(p, null);
    dirty(p);
    const landing = exteriorLandingFor(p, h);
    movePlayer(p, landing, 'the street outside');
    ctx.notify?.(p, { kind: 'home', action: 'ejected', homeId: h?.id ?? null, text: reason });
  }

  function ejectUnauthorizedVisitors(h, reason = 'Your visit to this home has ended.') {
    const occ = activeOccupants.get(h.id);
    if (!occ?.size) return [];
    const ejected = [];
    for (const pid of [...occ]) {
      const live = online(pid);
      if (!live) {
        occ.delete(pid);
        playerHome.delete(pid);
        continue;
      }
      if (live.id === h.ownerId) continue;
      if (!canVisitHome(live, h).ok) {
        ejectOccupant(live, h, reason);
        ejected.push(pid);
      }
    }
    return ejected;
  }

  function ejectAllOccupants(h, reason = 'This home is no longer available.') {
    const occ = activeOccupants.get(h.id);
    if (!occ?.size) return;
    for (const pid of [...occ]) {
      const live = online(pid);
      if (live) ejectOccupant(live, h, reason);
      else {
        occ.delete(pid);
        playerHome.delete(pid);
      }
    }
    activeOccupants.delete(h.id);
  }

  function activeVisitorsOf(h) {
    const occ = activeOccupants.get(h.id);
    if (!occ?.size) return [];
    const out = [];
    for (const pid of occ) {
      if (pid === h.ownerId) continue;
      const live = online(pid);
      if (live && locationOf(live) === h.interior) out.push(live);
    }
    return out;
  }

  // ------------------------------------------------------------------ lossless legacy deed migration

  /**
   * Losslessly migrates every legacy deed in `p.rpg.property.houses` and its storage
   * `p.rpg.property.stores['house:' + regionKey]` into its own separate home instance.
   * Safe to run repeatedly (idempotent) and preserves duplicate deeds across different owners.
   */
  function migrateLegacyDeeds(p, { persist = true } = {}) {
    if (!p?.rpg || !Number.isSafeInteger(p.id)) return [];
    const prop = p.rpg.property;
    if (!isObj(prop) || !isObj(prop.houses)) return [];
    const migrated = [];
    const ownedSet = homesByOwner.get(p.id) ?? new Set();

    for (const [rKey, deed] of Object.entries(prop.houses)) {
      if (!isObj(deed) || typeof deed.interior !== 'string' || !deed.interior) continue;
      let existing = null;
      for (const hid of ownedSet) {
        const h = homes.get(hid);
        if (h && h.interior === deed.interior) { existing = h; break; }
      }
      const storeKey = `house:${rKey}`;
      const legacyItems = isObj(prop.stores) && Array.isArray(prop.stores[storeKey]) ? prop.stores[storeKey] : [];

      if (existing) {
        if (!existing.legacyStorageMigrated && legacyItems.length) {
          const chest = existing.containers[DEFAULT_CHEST_ID];
          for (const raw of legacyItems) {
            if (!isObj(raw)) continue;
            if (raw.template === 'gold' && int(raw.quantity) > 0) {
              const g = chest.items.find((i) => i.template === 'gold');
              if (g) g.quantity += int(raw.quantity);
              else chest.items.push({ template: 'gold', name: 'Gold pieces', quantity: int(raw.quantity) });
              continue;
            }
            const norm = normalizeRecord(raw);
            if (norm && !chest.items.some((i) => i.id === norm.id)) {
              chest.items.push(norm);
            }
          }
          existing.legacyStorageMigrated = true;
          delete prop.stores[storeKey];
          dirty(p);
          if (persist) persistHome(existing);
          migrated.push(existing);
        }
        continue;
      }

      const chestItems = [];
      for (const raw of legacyItems) {
        if (!isObj(raw)) continue;
        if (raw.template === 'gold' && int(raw.quantity) > 0) {
          const g = chestItems.find((i) => i.template === 'gold');
          if (g) g.quantity += int(raw.quantity);
          else chestItems.push({ template: 'gold', name: 'Gold pieces', quantity: int(raw.quantity) });
          continue;
        }
        const norm = normalizeRecord(raw);
        if (norm) chestItems.push(norm);
      }

      const t = now();
      const home = normalizeHomeRecord({
        id: newHomeId(),
        ownerId: p.id,
        ownerAccountId: p.accountId != null ? String(p.accountId) : null,
        ownerName: p.name || `Player ${p.id}`,
        region: deed.region || placeOf(deed.town)?.region || 'Daggerfall',
        regionKey: rKey,
        regionIndex: Number.isInteger(deed.regionIndex) ? deed.regionIndex : null,
        town: deed.town || exteriorTownOf(deed.interior) || 'town:Daggerfall/Gothway Garden',
        buildingId: deed.buildingId || '',
        interior: deed.interior,
        buildingType: int(deed.buildingType, 1),
        radius: Number(deed.radius) || 10,
        price: Math.max(0, int(deed.price, 0)),
        boughtAt: int(deed.boughtAt, 0),
        legacy: true,
        legacyStorageMigrated: true,
        archived: false,
        access: { mode: 'private', guests: {}, visitingHours: { open: 8, close: 20 } },
        furnishings: [],
        furnishingRev: 1,
        containers: {
          [DEFAULT_CHEST_ID]: {
            id: DEFAULT_CHEST_ID,
            name: 'House Storage Chest',
            capacity: DEFAULT_CHEST_CAPACITY,
            revision: 1,
            items: chestItems,
          },
        },
        trader: null,
        createdAt: t,
        updatedAt: t,
        revision: 1,
      });

      homes.set(home.id, home);
      rebuildIndexes();
      if (legacyItems.length) {
        delete prop.stores[storeKey];
        dirty(p);
      }
      if (persist) persistHome(home);
      migrated.push(home);
    }

    return migrated;
  }

  /** True when a building interior address has no existing or legacy claim and can be offered for new sale. */
  function isAddressAvailable(interior) {
    if (typeof interior !== 'string' || !interior) return false;
    return !claimedAddresses.has(interior) && !legacyClaimedAddresses.has(interior);
  }

  function filterAvailableOffers(offers) {
    if (!Array.isArray(offers)) return [];
    return offers.filter((o) => o && isAddressAvailable(o.interior));
  }

  // ------------------------------------------------------------------ views & notifications

  function homeSummary(h, viewerId) {
    const isOwner = h.ownerId === viewerId;
    const liveOwner = online(h.ownerId);
    const visitors = activeVisitorsOf(h).map((v) => ({ id: v.id, name: v.name }));
    const containers = isOwner
      ? Object.values(h.containers).map((c) => ({
        id: c.id,
        name: c.name,
        capacity: c.capacity,
        revision: c.revision,
        itemCount: c.items.length,
        items: c.items.map((it) => ({ ...it })),
      }))
      : [];
    return {
      id: h.id,
      ownerId: h.ownerId,
      ownerName: liveOwner?.name ?? h.ownerName,
      isOwner,
      region: h.region,
      regionKey: h.regionKey,
      town: h.town,
      townName: placeOf(h.town)?.location ?? h.town,
      buildingId: h.buildingId,
      interior: h.interior,
      radius: h.radius,
      price: h.price,
      legacy: h.legacy,
      archived: h.archived,
      access: isOwner
        ? {
          mode: h.access.mode,
          visitingHours: { ...h.access.visitingHours },
          guests: Object.values(h.access.guests).map((g) => ({
            id: g.id,
            name: online(g.id)?.name ?? g.name,
            grantedAt: g.grantedAt,
            expiresAt: g.expiresAt,
          })),
        }
        : { mode: h.access.mode, visitingHours: { ...h.access.visitingHours } },
      furnishings: h.furnishings.map((f) => ({ ...f })),
      furnishingRev: h.furnishingRev,
      maxFurnishings: MAX_FURNISHINGS_PER_HOME,
      containers,
      trader: h.trader ? { ...h.trader, listingIds: [...h.trader.listingIds] } : null,
      visitors: isOwner ? visitors : [],
      visitorCount: visitors.length,
      revision: h.revision,
    };
  }

  function overviewFor(p) {
    const ownedIds = [...(homesByOwner.get(p.id) ?? [])];
    const owned = ownedIds.map((id) => homes.get(id)).filter(Boolean).map((h) => homeSummary(h, p.id));
    const activeId = playerHome.get(p.id) ?? null;
    const active = activeId ? homes.get(activeId) : null;
    const invitations = [];
    for (const h of homes.values()) {
      if (h.ownerId === p.id || h.archived) continue;
      if (isBlockedPair(p, h)) continue;
      pruneExpiredGuests(h);
      if (h.access.guests[String(p.id)]) {
        invitations.push({
          homeId: h.id,
          ownerId: h.ownerId,
          ownerName: online(h.ownerId)?.name ?? h.ownerName,
          region: h.region,
          town: h.town,
          townName: placeOf(h.town)?.location ?? h.town,
          mode: h.access.mode,
        });
      }
    }
    return {
      gold: goldOf(p),
      owned,
      invitations,
      activeHome: active ? homeSummary(active, p.id) : null,
      catalog: FURNISHING_LIST.map((c) => ({ ...c })),
    };
  }

  function pushOverview(p, action = 'overview', text = null, extra = {}) {
    if (!p || !online(p.id)) return;
    ctx.notify?.(p, {
      kind: 'home',
      action,
      ...(text ? { text } : {}),
      ...extra,
      overview: overviewFor(p),
    });
  }

  function broadcastFurnishings(h) {
    const payload = {
      kind: 'home.furnishings',
      homeId: h.id,
      furnishingRev: h.furnishingRev,
      furnishings: h.furnishings.map((f) => ({ ...f })),
      trader: h.trader ? { ...h.trader, listingIds: [...h.trader.listingIds] } : null,
    };
    ctx.nearby?.(h.interior, payload, { scope: `home:${h.id}` });
  }

  function requireOwnedHome(p, homeId) {
    const id = String(homeId ?? playerHome.get(p.id) ?? '');
    const h = homes.get(id);
    if (!h || h.ownerId !== p.id) throw new Error('You do not own that home.');
    if (h.archived) throw new Error('That home is currently archived.');
    return h;
  }

  function doorPositionsFor(interior) {
    const portal = services.portals?.into?.(interior);
    if (!portal) return [{ x: 0, z: 0, floor: 0 }];
    const out = [];
    for (const e of portal.exits ?? []) {
      if (Number.isFinite(e?.x) && Number.isFinite(e?.z)) out.push({ x: e.x, z: e.z, floor: 0 });
    }
    for (const e of portal.entrances ?? []) {
      const pt = e?.enter ?? e?.inner;
      if (Number.isFinite(pt?.x) && Number.isFinite(pt?.z)) out.push({ x: pt.x, z: pt.z, floor: 0 });
    }
    return out.length ? out : [{ x: 0, z: 0, floor: 0 }];
  }

  // ------------------------------------------------------------------ durable operations

  /**
   * Race-safe new house offer reservation & purchase using `runDurable`.
   * Enforces per-region 1-house limit and exclusive address claim across concurrent buyers.
   */
  async function buyHome(p, {
    region,
    regionIndex = null,
    town,
    buildingId = '',
    interior,
    buildingType = 1,
    radius = 10,
    price = 0,
    opKey = null,
    knightlyGrant = false,
  } = {}) {
    if (!p?.rpg || !Number.isSafeInteger(p.id)) throw new Error('Invalid player.');
    if (typeof interior !== 'string' || !interior) throw new Error('Choose a house to buy.');
    const reg = cleanText(region || placeOf(town)?.region, 64) || 'Daggerfall';
    const rKey = regionKey(reg);
    const cost = knightlyGrant ? 0 : Math.max(0, int(price, 0));

    const buildHomeCommit = (existingAddr) => {
      // Check legacy/existing address reservation authoritatively inside the transaction.
      if (legacyClaimedAddresses.has(interior) || claimedAddresses.has(interior) || (existingAddr && existingAddr.homeId)) {
        const err = new Error('That house has already been claimed.');
        err.code = 'ADDRESS_CLAIMED';
        throw err;
      }
      // Enforce classic per-region ownership limit.
      for (const hid of homesByOwner.get(p.id) ?? []) {
        const h = homes.get(hid);
        if (h && h.regionKey === rKey) {
          const err = new Error(`You already own a house in ${reg}. Sell it first.`);
          err.code = 'REGION_LIMIT';
          throw err;
        }
      }
      const nextRpg = structuredClone(p.rpg);
      ensurePlayerInventory(nextRpg);
      if (cost > 0) {
        if ((nextRpg.gold || 0) < cost) {
          const err = new Error(`That house costs ${cost} gold; you carry ${nextRpg.gold || 0} gold.`);
          err.code = 'INSUFFICIENT_GOLD';
          throw err;
        }
        nextRpg.gold -= cost;
      }
      const t = now();
      const home = normalizeHomeRecord({
        id: newHomeId(),
        ownerId: p.id,
        ownerAccountId: p.accountId != null ? String(p.accountId) : null,
        ownerName: p.name,
        region: reg,
        regionKey: rKey,
        regionIndex,
        town: town || exteriorTownOf(interior) || 'town:Daggerfall/Gothway Garden',
        buildingId: String(buildingId || ''),
        interior,
        buildingType,
        radius,
        price: cost,
        boughtAt: t,
        legacy: false,
        legacyStorageMigrated: true,
        archived: false,
        access: { mode: 'private', guests: {}, visitingHours: { open: 8, close: 20 } },
        furnishings: [],
        furnishingRev: 1,
        containers: {
          [DEFAULT_CHEST_ID]: { id: DEFAULT_CHEST_ID, name: 'House Storage Chest', capacity: DEFAULT_CHEST_CAPACITY, revision: 1, items: [] },
        },
        trader: null,
        createdAt: t,
        updatedAt: t,
        revision: 1,
      });

      // Mirror deed onto `rpg.property.houses` for classic bank/door compatibility.
      if (!isObj(nextRpg.property)) nextRpg.property = { version: 1, loans: {}, houses: {}, ship: null, board: null, stores: {}, recent: [], seq: 0 };
      if (!isObj(nextRpg.property.houses)) nextRpg.property.houses = {};
      nextRpg.property.houses[rKey] = {
        region: reg,
        regionIndex,
        town: home.town,
        buildingId: home.buildingId,
        interior: home.interior,
        buildingType: home.buildingType,
        radius: home.radius,
        price: home.price,
        boughtAt: home.boughtAt,
      };

      const addrRec = { homeId: home.id, ownerId: p.id, interior, claimedAt: t };
      return { home, nextRpg, addrRec };
    };

    const runDurable = services.runDurable;
    if (typeof runDurable === 'function') {
      const key = opKey ?? `home-buy-${p.id}-${interior}-${randomBytes(4).toString('hex')}`;
      const scope = {
        accountId: p.accountId ?? null,
        characterId: p.id,
        characterIds: [p.id],
        resourceKeys: [`home:addr:${interior}`, `home:owner:${p.id}:${rKey}`],
        params: { action: 'home.buy', interior, region: rKey, cost, knightlyGrant },
      };
      const outcome = await trackOp(runDurable(key, scope, async (tx) => {
        const existingAddr = await Promise.resolve(tx.getWorld(`${HOME_ADDR_PREFIX}${interior}`));
        const committed = buildHomeCommit(existingAddr);
        await Promise.resolve(tx.saveCharacters(
          [{ ...p, rpg: committed.nextRpg }],
          [
            [`${HOME_PREFIX}${committed.home.id}`, committed.home],
            [`${HOME_ADDR_PREFIX}${interior}`, committed.addrRec],
          ],
        ));
        return { homeId: committed.home.id, home: committed.home, nextRpg: committed.nextRpg };
      }));
      if (!outcome.replayed && outcome.result?.home) {
        const home = normalizeHomeRecord(outcome.result.home);
        homes.set(home.id, home);
        rebuildIndexes();
        Object.assign(p.rpg, outcome.result.nextRpg);
        pushOverview(p, 'home.buy', `Purchased home in ${placeOf(home.town)?.location ?? home.region}.`, { homeId: home.id });
      }
      return { replayed: outcome.replayed, home: homes.get(outcome.result?.homeId) ?? outcome.result?.home ?? null };
    }

    // Synchronous fallback when no runDurable store is attached.
    const committed = buildHomeCommit(null);
    dirty(p);
    Object.assign(p.rpg, committed.nextRpg);
    homes.set(committed.home.id, committed.home);
    rebuildIndexes();
    ctx.dirtyWorld?.(`${HOME_PREFIX}${committed.home.id}`, structuredClone(committed.home));
    ctx.dirtyWorld?.(`${HOME_ADDR_PREFIX}${interior}`, committed.addrRec);
    pushOverview(p, 'home.buy', `Purchased home in ${placeOf(committed.home.town)?.location ?? committed.home.region}.`, { homeId: committed.home.id });
    return { replayed: false, home: committed.home };
  }

  /**
   * Durable atomic deposit into a personal home storage chest.
   */
  async function storageDeposit(p, { homeId, containerId = DEFAULT_CHEST_ID, itemId, quantity = null, opKey = null } = {}) {
    const h = requireOwnedHome(p, homeId);
    const cid = String(containerId || DEFAULT_CHEST_ID);
    if (!h.containers[cid]) throw new Error('That storage chest does not exist in this home.');

    const runDurable = services.runDurable;
    if (typeof runDurable === 'function') {
      const key = opKey ?? `home-dep-${h.id}-${cid}-${p.id}-${randomBytes(4).toString('hex')}`;
      const scope = {
        accountId: p.accountId ?? null,
        characterId: p.id,
        characterIds: [p.id],
        resourceKeys: [`home:${h.id}`, `home:${h.id}:${cid}`],
        params: { action: 'home.storageDeposit', homeId: h.id, containerId: cid, itemId: String(itemId ?? ''), quantity },
      };
      const outcome = await trackOp(runDurable(key, scope, async (tx) => {
        const persisted = await Promise.resolve(tx.getWorld(`${HOME_PREFIX}${h.id}`));
        const curHome = normalizeHomeRecord(persisted ?? h);
        if (!curHome || curHome.ownerId !== p.id) throw new Error('You do not own that home.');
        const chest = curHome.containers[cid];
        if (!chest) throw new Error('That storage chest no longer exists.');
        const res = applyDepositToContainer(p.rpg, chest.items, itemId, quantity, {
          shared: false,
          capacity: chest.capacity,
          allowGold: true,
        });
        chest.items = res.list;
        chest.revision = (chest.revision || 1) + 1;
        curHome.updatedAt = tx.now ?? now();
        curHome.revision = (curHome.revision || 1) + 1;
        await Promise.resolve(tx.saveCharacters([{ ...p, rpg: res.rpg }], [[`${HOME_PREFIX}${curHome.id}`, curHome]]));
        return {
          home: curHome,
          nextRpg: res.rpg,
          moved: res.moved,
          fingerprint: res.fingerprint,
          containerId: cid,
        };
      }));
      if (!outcome.replayed && outcome.result?.home) {
        const updated = normalizeHomeRecord(outcome.result.home);
        homes.set(updated.id, updated);
        rebuildIndexes();
        Object.assign(p.rpg, outcome.result.nextRpg);
        const mv = outcome.result.moved;
        const label = mv.template === 'gold' ? `${mv.quantity} gold` : `${mv.quantity > 1 ? `${mv.quantity} × ` : ''}${mv.name}`;
        pushOverview(p, 'home.storageDeposit', `Stored ${label} in ${updated.containers[cid]?.name || 'storage chest'}.`, { homeId: updated.id, containerId: cid });
      }
      return outcome;
    }

    // Synchronous fallback
    const chest = h.containers[cid];
    const res = applyDepositToContainer(p.rpg, chest.items, itemId, quantity, {
      shared: false,
      capacity: chest.capacity,
      allowGold: true,
    });
    dirty(p);
    Object.assign(p.rpg, res.rpg);
    chest.items = res.list;
    chest.revision = (chest.revision || 1) + 1;
    persistHome(h);
    const mv = res.moved;
    const label = mv.template === 'gold' ? `${mv.quantity} gold` : `${mv.quantity > 1 ? `${mv.quantity} × ` : ''}${mv.name}`;
    pushOverview(p, 'home.storageDeposit', `Stored ${label} in ${chest.name}.`, { homeId: h.id, containerId: cid });
    return { replayed: false, result: { home: h, moved: mv, fingerprint: res.fingerprint, containerId: cid } };
  }

  /**
   * Durable atomic withdrawal from a personal home storage chest.
   */
  async function storageWithdraw(p, { homeId, containerId = DEFAULT_CHEST_ID, itemId, quantity = null, opKey = null } = {}) {
    const h = requireOwnedHome(p, homeId);
    const cid = String(containerId || DEFAULT_CHEST_ID);
    if (!h.containers[cid]) throw new Error('That storage chest does not exist in this home.');
    const maxCarryKg = typeof services.maxEncumbrance === 'function' ? services.maxEncumbrance(p) : null;

    const runDurable = services.runDurable;
    if (typeof runDurable === 'function') {
      const key = opKey ?? `home-wd-${h.id}-${cid}-${p.id}-${randomBytes(4).toString('hex')}`;
      const scope = {
        accountId: p.accountId ?? null,
        characterId: p.id,
        characterIds: [p.id],
        resourceKeys: [`home:${h.id}`, `home:${h.id}:${cid}`],
        params: { action: 'home.storageWithdraw', homeId: h.id, containerId: cid, itemId: String(itemId ?? ''), quantity },
      };
      const outcome = await trackOp(runDurable(key, scope, async (tx) => {
        const persisted = await Promise.resolve(tx.getWorld(`${HOME_PREFIX}${h.id}`));
        const curHome = normalizeHomeRecord(persisted ?? h);
        if (!curHome || curHome.ownerId !== p.id) throw new Error('You do not own that home.');
        const chest = curHome.containers[cid];
        if (!chest) throw new Error('That storage chest no longer exists.');
        const res = applyWithdrawFromContainer(p.rpg, chest.items, itemId, quantity, { maxCarryKg });
        chest.items = res.list;
        chest.revision = (chest.revision || 1) + 1;
        curHome.updatedAt = tx.now ?? now();
        curHome.revision = (curHome.revision || 1) + 1;
        await Promise.resolve(tx.saveCharacters([{ ...p, rpg: res.rpg }], [[`${HOME_PREFIX}${curHome.id}`, curHome]]));
        return {
          home: curHome,
          nextRpg: res.rpg,
          taken: res.taken,
          inserted: res.inserted,
          fingerprint: res.fingerprint,
          containerId: cid,
        };
      }));
      if (!outcome.replayed && outcome.result?.home) {
        const updated = normalizeHomeRecord(outcome.result.home);
        homes.set(updated.id, updated);
        rebuildIndexes();
        Object.assign(p.rpg, outcome.result.nextRpg);
        const tk = outcome.result.taken;
        const label = tk.template === 'gold' ? `${tk.quantity} gold` : `${tk.quantity > 1 ? `${tk.quantity} × ` : ''}${tk.name}`;
        pushOverview(p, 'home.storageWithdraw', `Withdrew ${label} from ${updated.containers[cid]?.name || 'storage chest'}.`, { homeId: updated.id, containerId: cid });
      }
      return outcome;
    }

    // Synchronous fallback
    const chest = h.containers[cid];
    const res = applyWithdrawFromContainer(p.rpg, chest.items, itemId, quantity, { maxCarryKg });
    dirty(p);
    Object.assign(p.rpg, res.rpg);
    chest.items = res.list;
    chest.revision = (chest.revision || 1) + 1;
    persistHome(h);
    const tk = res.taken;
    const label = tk.template === 'gold' ? `${tk.quantity} gold` : `${tk.quantity > 1 ? `${tk.quantity} × ` : ''}${tk.name}`;
    pushOverview(p, 'home.storageWithdraw', `Withdrew ${label} from ${chest.name}.`, { homeId: h.id, containerId: cid });
    return { replayed: false, result: { home: h, taken: tk, inserted: res.inserted, fingerprint: res.fingerprint, containerId: cid } };
  }

  // ------------------------------------------------------------------ house trader hooks for market

  function hasActiveTraderListings(h) {
    if (!h?.trader) return false;
    if (h.trader.listingIds?.length > 0) return true;
    if (typeof services.market?.hasActiveHouseTraderListings === 'function') {
      return Boolean(services.market.hasActiveHouseTraderListings(h.id));
    }
    if (typeof services.market?.hasActiveTraderListings === 'function') {
      return Boolean(services.market.hasActiveTraderListings(h.id));
    }
    return false;
  }

  function verifyTraderAccess(actor, reqOrHomeId) {
    const isReqObj = reqOrHomeId && typeof reqOrHomeId === 'object' && !Array.isArray(reqOrHomeId);
    const reqHouseId = isReqObj ? (reqOrHomeId.houseId ? String(reqOrHomeId.houseId) : null) : (reqOrHomeId != null ? String(reqOrHomeId) : null);
    const reqTraderId = isReqObj && reqOrHomeId.traderId ? String(reqOrHomeId.traderId) : null;
    const mode = isReqObj && reqOrHomeId.mode ? String(reqOrHomeId.mode) : null;

    let h = reqHouseId ? homes.get(reqHouseId) : null;
    if (!h && reqTraderId) {
      for (const cand of homes.values()) {
        if (!cand?.trader) continue;
        if (cand.trader.furnishingId === reqTraderId || `trader:${cand.id}` === reqTraderId) {
          h = cand;
          break;
        }
      }
    }
    if (!h || !h.trader || h.archived) {
      return { ok: false, code: 'TRADER_ACCESS_DENIED', isOwner: false, canBrowse: false, canManage: false, reason: NEUTRAL_VISIT_REFUSAL };
    }
    const isOwner = Number(actor?.id) === Number(h.ownerId);
    const traderId = h.trader.furnishingId || `trader:${h.id}`;
    const meta = {
      homeId: h.id,
      houseId: h.id,
      traderId,
      ownerId: h.ownerId,
      ownerCharacterId: h.ownerId,
      ownerAccountId: h.ownerAccountId ?? null,
      location: h.interior,
      region: h.region,
      town: placeOf(h.town)?.location ?? h.town,
      label: h.trader.npcName || 'House Trader',
      trader: { ...h.trader, listingIds: [...h.trader.listingIds] },
    };
    if (isOwner) {
      return {
        ok: true,
        isOwner: true,
        canBrowse: true,
        canManage: true,
        ...meta,
      };
    }
    if (mode === 'manage') {
      return {
        ok: false,
        code: 'TRADER_NOT_OWNER',
        isOwner: false,
        canBrowse: false,
        canManage: false,
        reason: 'Only the home owner can manage this house trader.',
      };
    }
    const visit = canVisitHome(actor, h);
    if (!visit.ok || !h.trader.enabled) {
      return { ok: false, code: 'TRADER_ACCESS_DENIED', isOwner: false, canBrowse: false, canManage: false, reason: NEUTRAL_VISIT_REFUSAL };
    }
    return {
      ok: true,
      isOwner: false,
      canBrowse: true,
      canManage: false,
      ...meta,
    };
  }

  function attachTraderListing(homeId, ownerId, listingId) {
    const h = homes.get(String(homeId ?? ''));
    if (!h || h.ownerId !== ownerId) throw new Error('You do not own that home.');
    if (!h.trader) throw new Error('Place a House Trader Stall in your home first.');
    const lid = String(listingId ?? '').trim();
    if (!lid) throw new Error('Listing ID is required.');
    if (!h.trader.listingIds.includes(lid)) {
      h.trader.listingIds.push(lid);
      h.trader.updatedAt = now();
      persistHome(h);
    }
    return { ...h.trader, listingIds: [...h.trader.listingIds] };
  }

  function detachTraderListing(homeId, ownerId, listingId) {
    const h = homes.get(String(homeId ?? ''));
    if (!h || (ownerId != null && h.ownerId !== ownerId)) return false;
    if (!h.trader) return false;
    const lid = String(listingId ?? '');
    const before = h.trader.listingIds.length;
    h.trader.listingIds = h.trader.listingIds.filter((x) => x !== lid);
    if (h.trader.listingIds.length !== before) {
      h.trader.updatedAt = now();
      persistHome(h);
      return true;
    }
    return false;
  }

  function saleQuoteFor(h, { includeFurnishingsInQuote = false } = {}) {
    const totalStoredItems = Object.values(h.containers).reduce((n, c) => n + c.items.length, 0);
    const activeListings = hasActiveTraderListings(h);
    const baseProceeds = deedSellPrice(h.price);
    const furnitureRefund = h.furnishings.reduce((sum, f) => sum + furnishingRefundValue(f.catalogId), 0);
    const totalProceeds = includeFurnishingsInQuote ? baseProceeds + furnitureRefund : baseProceeds;
    const blockers = [];
    if (totalStoredItems > 0) blockers.push('Collect all items from your home storage chests before selling.');
    if (activeListings) blockers.push('Cancel or detach active House Trader listings before selling.');
    return {
      homeId: h.id,
      region: h.region,
      town: h.town,
      baseProceeds,
      furnitureCount: h.furnishings.length,
      furnitureRefund,
      includeFurnishingsInQuote,
      totalProceeds,
      storedItemCount: totalStoredItems,
      hasActiveTraderListings: activeListings,
      canSell: blockers.length === 0,
      blockers,
    };
  }

  async function sellHome(p, { homeId, includeFurnishingsInQuote = false, opKey = null } = {}) {
    const h = requireOwnedHome(p, homeId);
    const quote = saleQuoteFor(h, { includeFurnishingsInQuote });
    if (!quote.canSell) {
      const err = new Error(quote.blockers[0]);
      err.code = 'HOME_SALE_BLOCKED';
      throw err;
    }

    const finalizeSale = async (tx) => {
      const nextRpg = structuredClone(p.rpg);
      ensurePlayerInventory(nextRpg);
      nextRpg.gold = (nextRpg.gold || 0) + quote.totalProceeds;
      if (isObj(nextRpg.property?.houses) && nextRpg.property.houses[h.regionKey]?.interior === h.interior) {
        delete nextRpg.property.houses[h.regionKey];
      }
      const returnedClaims = [];
      if (!includeFurnishingsInQuote && h.furnishings.length && tx?.createClaim) {
        for (const f of h.furnishings) {
          const claim = await Promise.resolve(tx.createClaim({
            ownerCharacterId: p.id,
            ownerAccountId: p.accountId != null ? String(p.accountId) : null,
            kind: 'home_furnishing_return',
            sourceRef: `home:${h.id}:${f.id}`,
            gold: furnishingRefundValue(f.catalogId),
            item: { template: 'furnishing', catalogId: f.catalogId, name: f.name, quantity: 1 },
            reason: `Removable furnishing returned from sold home (${h.region}).`,
          }));
          returnedClaims.push(claim);
        }
      }
      const otherOwnersSameAddr = [...(homesByInterior.get(h.interior) ?? [])].filter((id) => id !== h.id);
      const worldOps = [[`${HOME_PREFIX}${h.id}`, null]];
      if (!otherOwnersSameAddr.length) worldOps.push([`${HOME_ADDR_PREFIX}${h.interior}`, null]);
      if (tx?.saveCharacters) await Promise.resolve(tx.saveCharacters([{ ...p, rpg: nextRpg }], worldOps));
      return { nextRpg, worldOps, returnedClaims };
    };

    const runDurable = services.runDurable;
    let returnedClaims = [];
    if (typeof runDurable === 'function') {
      const key = opKey ?? `home-sell-${h.id}-${p.id}-${randomBytes(4).toString('hex')}`;
      const outcome = await trackOp(runDurable(key, {
        accountId: p.accountId ?? null,
        characterId: p.id,
        characterIds: [p.id],
        resourceKeys: [`home:${h.id}`, `home:addr:${h.interior}`],
        params: { action: 'home.sell', homeId: h.id, includeFurnishingsInQuote },
      }, async (tx) => {
        const res = await finalizeSale(tx);
        return { nextRpg: res.nextRpg, returnedClaims: res.returnedClaims, proceeds: quote.totalProceeds };
      }));
      if (outcome.replayed) return outcome;
      returnedClaims = outcome.result?.returnedClaims ?? [];
      Object.assign(p.rpg, outcome.result.nextRpg);
    } else {
      const res = await finalizeSale(null);
      dirty(p);
      Object.assign(p.rpg, res.nextRpg);
      for (const [k, v] of res.worldOps) ctx.dirtyWorld?.(k, v);
    }

    ejectAllOccupants(h, 'This home has been sold; you were returned outside.');
    homes.delete(h.id);
    rebuildIndexes();
    pushOverview(p, 'home.sell', `Sold your home in ${h.region} for ${quote.totalProceeds} gold.`, { proceeds: quote.totalProceeds, returnedClaims });
    return { replayed: false, proceeds: quote.totalProceeds, returnedClaims };
  }

  // ------------------------------------------------------------------ actions

  ctx.onAction('home.overview', (p) => {
    migrateLegacyDeeds(p);
    pushOverview(p, 'overview');
  });

  txAction('home.setAccess', (p, args = {}) => {
    const h = requireOwnedHome(p, args.homeId);
    const mode = String(args.mode ?? '').toLowerCase();
    if (!ACCESS_MODES.includes(mode)) throw new Error('Access mode must be private, invited, or hours.');
    h.access.mode = mode;
    if (args.visitingHours && isObj(args.visitingHours)) {
      h.access.visitingHours = normalizeVisitingHours(args.visitingHours);
    }
    persistHome(h);
    ejectUnauthorizedVisitors(h, 'The home owner changed visiting permissions.');
    pushOverview(p, 'home.setAccess', `Home access updated to ${mode}.`, { homeId: h.id });
  });

  txAction('home.inviteGuest', (p, args = {}) => {
    const h = requireOwnedHome(p, args.homeId);
    const targetId = int(args.targetId, NaN);
    if (!Number.isSafeInteger(targetId) || targetId < 1) throw new Error('Choose a guest to invite.');
    if (targetId === p.id) throw new Error('You already own this home.');
    const liveTarget = online(targetId);
    const targetDesc = liveTarget ?? { id: targetId, name: cleanText(args.targetName, 48) || `Traveller ${targetId}` };

    if (typeof services.isBlocked === 'function' && services.isBlocked(p, targetDesc)) {
      throw new Error(NEUTRAL_VISIT_REFUSAL);
    }
    if (typeof services.canInteract === 'function') {
      const check = services.canInteract(p, targetDesc, 'visit');
      if (check && check.ok === false) throw new Error(NEUTRAL_VISIT_REFUSAL);
    }

    pruneExpiredGuests(h);
    if (Object.keys(h.access.guests).length >= MAX_GUESTS && !h.access.guests[String(targetId)]) {
      throw new Error(`Guest list is limited to ${MAX_GUESTS} guests.`);
    }
    const ttlMs = args.ttlMs != null && Number.isFinite(Number(args.ttlMs)) && Number(args.ttlMs) > 0
      ? Math.min(30 * 86_400_000, Math.trunc(Number(args.ttlMs)))
      : null;
    h.access.guests[String(targetId)] = {
      id: targetId,
      name: liveTarget?.name ?? targetDesc.name,
      grantedAt: now(),
      expiresAt: ttlMs != null ? now() + ttlMs : null,
    };
    if (h.access.mode === 'private') h.access.mode = 'invited';
    persistHome(h);
    if (liveTarget) {
      pushOverview(liveTarget, 'home.invited', `${p.name} invited you to visit their home in ${placeOf(h.town)?.location ?? h.region}.`, { homeId: h.id });
    }
    pushOverview(p, 'home.inviteGuest', `Invited ${targetDesc.name} to your home.`, { homeId: h.id });
  });

  txAction('home.revokeGuest', (p, args = {}) => {
    const h = requireOwnedHome(p, args.homeId);
    const targetId = int(args.targetId, NaN);
    if (!Number.isSafeInteger(targetId)) throw new Error('Choose a guest to revoke.');
    if (!h.access.guests[String(targetId)]) throw new Error('That traveller is not on your guest list.');
    const removedName = h.access.guests[String(targetId)].name;
    delete h.access.guests[String(targetId)];
    persistHome(h);
    const live = online(targetId);
    if (live && playerHome.get(live.id) === h.id) {
      ejectOccupant(live, h, 'Your guest access was revoked; you were returned outside.');
    }
    pushOverview(p, 'home.revokeGuest', `Revoked guest access for ${removedName}.`, { homeId: h.id });
  });

  txAction('home.kickVisitor', (p, args = {}) => {
    const h = requireOwnedHome(p, args.homeId);
    const targetId = int(args.targetId, NaN);
    if (!Number.isSafeInteger(targetId) || targetId === p.id) throw new Error('Choose a visitor to remove.');
    const live = online(targetId);
    if (!live || playerHome.get(live.id) !== h.id) throw new Error('That visitor is not inside your home.');
    ejectOccupant(live, h, 'You were asked to leave the home.');
    pushOverview(p, 'home.kickVisitor', `Removed ${live.name} from your home.`, { homeId: h.id });
  });

  txAction('home.enter', (p, args = {}) => {
    let h = null;
    if (args.homeId) {
      h = homes.get(String(args.homeId));
    } else if (args.interior) {
      const candidates = [...(homesByInterior.get(String(args.interior)) ?? [])].map((id) => homes.get(id)).filter(Boolean);
      if (args.ownerId != null) {
        h = candidates.find((c) => c.ownerId === int(args.ownerId)) ?? null;
      } else {
        h = candidates.find((c) => c.ownerId === p.id) ?? candidates.find((c) => canVisitHome(p, c).ok) ?? null;
      }
    }
    if (!h) throw new Error(NEUTRAL_VISIT_REFUSAL);
    const access = canVisitHome(p, h);
    if (!access.ok) throw new Error(access.reason);

    const curLoc = locationOf(p);
    const returnTo = !curLoc.startsWith('interior:')
      ? { location: curLoc, x: p.x ?? 0, y: 0, z: p.z ?? 0, yaw: p.yaw ?? 0 }
      : exteriorLandingFor(p, h);
    setOccupant(p, h.id, returnTo);
    movePlayer(p, { location: h.interior, x: 0, y: 0, z: 0, yaw: 0 }, `${h.ownerName}'s home`);
    ctx.notify?.(p, {
      kind: 'home.furnishings',
      homeId: h.id,
      furnishingRev: h.furnishingRev,
      furnishings: h.furnishings.map((f) => ({ ...f })),
      trader: h.trader ? { ...h.trader, listingIds: [...h.trader.listingIds] } : null,
    });
    pushOverview(p, 'home.enter', access.role === 'owner' ? 'Entered your home.' : `Entered ${h.ownerName}'s home.`, { homeId: h.id });
  });

  txAction('home.leave', (p) => {
    const hid = playerHome.get(p.id);
    const h = hid ? homes.get(hid) : null;
    if (!h) throw new Error('You are not inside a home.');
    setOccupant(p, null);
    movePlayer(p, exteriorLandingFor(p, h), 'outside');
    pushOverview(p, 'home.leave', 'Stepped outside the home.');
  });

  txAction('home.furnishPlace', (p, args = {}) => {
    const h = requireOwnedHome(p, args.homeId);
    const invItemId = args.inventoryItemId != null ? String(args.inventoryItemId) : null;
    let invItem = null;
    let catalogId = String(args.catalogId ?? '');
    if (invItemId) {
      invItem = (p.rpg?.inventory ?? []).find((it) => it && it.id === invItemId) ?? null;
      if (!invItem) throw new Error('That crafted furniture item is not in your pack.');
      if (invItem.equipped) throw new Error(`Unequip ${invItem.name} first.`);
      if (!catalogId) catalogId = String(invItem.template ?? '');
    }
    const collisionWorld = services.collision?.instanceWorld?.(h.interior) ?? null;
    const check = validateFurnishingPlacement({
      space: h,
      catalogId,
      x: args.x,
      y: args.y,
      z: args.z,
      yaw: args.yaw ?? 0,
      floor: args.floor ?? 0,
      existing: h.furnishings,
      maxTotal: MAX_FURNISHINGS_PER_HOME,
      isOrderHall: false,
      doorPositions: doorPositionsFor(h.interior),
      collisionWorld,
    });
    if (!check.ok) {
      const err = new Error(check.reason);
      err.code = check.code;
      throw err;
    }
    let craftedMeta = null;
    if (check.spec.craftedTemplate && !invItem) {
      invItem = (p.rpg?.inventory ?? []).find((it) => it && !it.equipped && it.template === check.spec.craftedTemplate) ?? null;
      if (!invItem && args.free !== true) {
        throw new Error(`Craft or carry a ${check.spec.name} in your pack to place it.`);
      }
    }
    if (invItem) {
      if (typeof services.takeItem === 'function') {
        const taken = services.takeItem(p, invItem.id, 1);
        if (!taken) throw new Error(`Could not place ${invItem.name} from your pack.`);
        if (taken.crafted) craftedMeta = structuredClone(taken.crafted);
      } else {
        const list = p.rpg?.inventory ?? [];
        const idx = list.indexOf(invItem);
        if (idx >= 0) {
          if ((invItem.quantity ?? 1) > 1) invItem.quantity -= 1;
          else list.splice(idx, 1);
          if (invItem.crafted) craftedMeta = structuredClone(invItem.crafted);
          dirty(p);
        }
      }
    }
    const cost = invItem ? 0 : check.spec.price;
    if (cost > 0 && args.free !== true) takeGold(p, cost);

    const placed = {
      id: newFurnishingId(),
      ...check.placement,
      ...(craftedMeta ? { crafted: craftedMeta } : {}),
      placedBy: p.id,
      placedAt: now(),
    };
    h.furnishings.push(placed);
    h.furnishingRev = (h.furnishingRev || 1) + 1;

    if (placed.kind === 'chest') {
      const cid = `chest-${placed.id}`;
      h.containers[cid] = {
        id: cid,
        name: check.spec.name,
        capacity: check.spec.capacity ?? 60,
        revision: 1,
        items: [],
      };
    } else if (placed.kind === 'trader') {
      h.trader = {
        furnishingId: placed.id,
        npcName: cleanText(args.npcName, 48) || `${p.name}'s Steward`,
        enabled: true,
        listingIds: [],
        updatedAt: now(),
      };
    }

    persistHome(h);
    broadcastFurnishings(h);
    pushOverview(p, 'home.furnishPlace', `Placed ${placed.name}${cost > 0 ? ` (-${cost}g)` : ''}.`, { homeId: h.id, furnishing: placed });
  });

  txAction('home.furnishMove', (p, args = {}) => {
    const h = requireOwnedHome(p, args.homeId);
    const fid = String(args.furnishingId ?? '');
    const item = h.furnishings.find((f) => f.id === fid);
    if (!item) throw new Error('That furnishing is not placed here.');
    const collisionWorld = services.collision?.instanceWorld?.(h.interior) ?? null;
    const check = validateFurnishingPlacement({
      space: h,
      catalogId: item.catalogId,
      x: args.x ?? item.x,
      y: args.y ?? item.y,
      z: args.z ?? item.z,
      yaw: args.yaw ?? item.yaw,
      floor: args.floor ?? item.floor,
      existing: h.furnishings,
      ignoreId: item.id,
      maxTotal: MAX_FURNISHINGS_PER_HOME,
      isOrderHall: false,
      doorPositions: doorPositionsFor(h.interior),
      collisionWorld,
    });
    if (!check.ok) {
      const err = new Error(check.reason);
      err.code = check.code;
      throw err;
    }
    Object.assign(item, check.placement);
    h.furnishingRev = (h.furnishingRev || 1) + 1;
    persistHome(h);
    broadcastFurnishings(h);
    pushOverview(p, 'home.furnishMove', `Moved ${item.name}.`, { homeId: h.id, furnishing: { ...item } });
  });

  txAction('home.furnishRemove', (p, args = {}) => {
    const h = requireOwnedHome(p, args.homeId);
    const fid = String(args.furnishingId ?? '');
    const idx = h.furnishings.findIndex((f) => f.id === fid);
    if (idx < 0) throw new Error('That furnishing is not placed here.');
    const item = h.furnishings[idx];

    if (item.kind === 'chest') {
      const cid = `chest-${item.id}`;
      if (h.containers[cid]?.items?.length > 0) {
        throw new Error('Empty that storage chest before removing it.');
      }
      delete h.containers[cid];
    }
    if (item.kind === 'trader') {
      if (hasActiveTraderListings(h)) {
        throw new Error('Cancel or detach active House Trader listings before removing the stall.');
      }
      h.trader = null;
    }

    h.furnishings.splice(idx, 1);
    h.furnishingRev = (h.furnishingRev || 1) + 1;
    const refund = furnishingRefundValue(item.catalogId);
    if (refund > 0) addGold(p, refund);
    persistHome(h);
    broadcastFurnishings(h);
    pushOverview(p, 'home.furnishRemove', `Removed ${item.name}${refund > 0 ? ` (+${refund}g refund)` : ''}.`, { homeId: h.id, furnishingId: fid });
  });

  ctx.onAction('home.storageDeposit', (p, args = {}) => {
    // Cheap validation before dispatching durable transaction.
    requireOwnedHome(p, args.homeId);
    if (typeof services.runDurable === 'function') {
      ctx.afterCommit(() => {
        storageDeposit(p, args).catch((err) => {
          ctx.notify?.(p, { kind: 'home', action: 'home.storageDeposit', error: true, code: err?.code ?? null, text: err?.message || 'Storage deposit failed.' });
        });
      });
      return;
    }
    // Synchronous fallback path when no runDurable store is configured.
    const h = requireOwnedHome(p, args.homeId);
    const cid = String(args.containerId || DEFAULT_CHEST_ID);
    const chest = h.containers[cid];
    if (!chest) throw new Error('That storage chest does not exist in this home.');
    const snap = captureState();
    ctx.onRollback?.(() => restoreState(snap));
    const res = applyDepositToContainer(p.rpg, chest.items, args.itemId, args.quantity ?? null, {
      shared: false,
      capacity: chest.capacity,
      allowGold: true,
    });
    dirty(p);
    Object.assign(p.rpg, res.rpg);
    chest.items = res.list;
    chest.revision = (chest.revision || 1) + 1;
    persistHome(h);
    const mv = res.moved;
    const label = mv.template === 'gold' ? `${mv.quantity} gold` : `${mv.quantity > 1 ? `${mv.quantity} × ` : ''}${mv.name}`;
    pushOverview(p, 'home.storageDeposit', `Stored ${label} in ${chest.name}.`, { homeId: h.id, containerId: cid });
  });

  ctx.onAction('home.storageWithdraw', (p, args = {}) => {
    requireOwnedHome(p, args.homeId);
    if (typeof services.runDurable === 'function') {
      ctx.afterCommit(() => {
        storageWithdraw(p, args).catch((err) => {
          ctx.notify?.(p, { kind: 'home', action: 'home.storageWithdraw', error: true, code: err?.code ?? null, text: err?.message || 'Storage withdrawal failed.' });
        });
      });
      return;
    }
    const h = requireOwnedHome(p, args.homeId);
    const cid = String(args.containerId || DEFAULT_CHEST_ID);
    const chest = h.containers[cid];
    if (!chest) throw new Error('That storage chest does not exist in this home.');
    const snap = captureState();
    ctx.onRollback?.(() => restoreState(snap));
    const maxCarryKg = typeof services.maxEncumbrance === 'function' ? services.maxEncumbrance(p) : null;
    const res = applyWithdrawFromContainer(p.rpg, chest.items, args.itemId, args.quantity ?? null, { maxCarryKg });
    dirty(p);
    Object.assign(p.rpg, res.rpg);
    chest.items = res.list;
    chest.revision = (chest.revision || 1) + 1;
    persistHome(h);
    const tk = res.taken;
    const label = tk.template === 'gold' ? `${tk.quantity} gold` : `${tk.quantity > 1 ? `${tk.quantity} × ` : ''}${tk.name}`;
    pushOverview(p, 'home.storageWithdraw', `Withdrew ${label} from ${chest.name}.`, { homeId: h.id, containerId: cid });
  });

  ctx.onAction('home.saleQuote', (p, args = {}) => {
    const h = requireOwnedHome(p, args.homeId);
    const quote = saleQuoteFor(h, { includeFurnishingsInQuote: args.includeFurnishingsInQuote === true });
    ctx.notify?.(p, { kind: 'home', action: 'home.saleQuote', quote });
  });

  ctx.onAction('home.sell', (p, args = {}) => {
    const h = requireOwnedHome(p, args.homeId);
    const quote = saleQuoteFor(h, { includeFurnishingsInQuote: args.includeFurnishingsInQuote === true });
    if (!quote.canSell) throw new Error(quote.blockers[0]);
    if (typeof services.runDurable === 'function') {
      ctx.afterCommit(() => {
        sellHome(p, args).catch((err) => {
          ctx.notify?.(p, { kind: 'home', action: 'home.sell', error: true, text: err?.message || 'Could not sell home.' });
        });
      });
      return;
    }
    const snap = captureState();
    ctx.onRollback?.(() => restoreState(snap));
    addGold(p, quote.totalProceeds);
    if (isObj(p.rpg.property?.houses) && p.rpg.property.houses[h.regionKey]?.interior === h.interior) {
      delete p.rpg.property.houses[h.regionKey];
    }
    ejectAllOccupants(h, 'This home has been sold; you were returned outside.');
    homes.delete(h.id);
    rebuildIndexes();
    deletePersistedHome(h.id);
    pushOverview(p, 'home.sell', `Sold your home in ${h.region} for ${quote.totalProceeds} gold.`, { proceeds: quote.totalProceeds });
  });

  // ------------------------------------------------------------------ chaining services & lifecycle

  // Chain presenceScope so each home instance is isolated (including duplicate legacy deeds on the same building!).
  const prevPresenceScope = services.presenceScope;
  services.presenceScope = (p) => {
    const hid = p ? playerHome.get(p.id) : null;
    if (hid) {
      const h = homes.get(hid);
      if (h && locationOf(p) === h.interior) return `home:${hid}`;
    }
    return typeof prevPresenceScope === 'function' ? prevPresenceScope(p) : null;
  };

  // Chain ownsBuilding (door unlock) and ownsInterior (storage rights — strictly OWNER ONLY, never guests!).
  const prevOwnsBuilding = services.ownsBuilding;
  services.ownsBuilding = (p, portal) => {
    if (typeof prevOwnsBuilding === 'function' && prevOwnsBuilding(p, portal)) return true;
    const to = typeof portal === 'string' ? portal : portal?.to;
    if (!to || !p) return false;
    const ids = homesByInterior.get(to);
    if (!ids?.size) return false;
    for (const id of ids) {
      const h = homes.get(id);
      if (h && canVisitHome(p, h).ok) return true;
    }
    return false;
  };

  const prevOwnsInterior = services.ownsInterior;
  services.ownsInterior = (p, loc) => {
    if (typeof prevOwnsInterior === 'function' && prevOwnsInterior(p, loc)) return true;
    if (!p || !loc) return false;
    const hid = playerHome.get(p.id);
    if (hid) {
      const h = homes.get(hid);
      if (h && h.interior === loc && h.ownerId === p.id) return true;
    }
    return false;
  };

  // Reconnect & migration reconciliation on join.
  ctx.onJoin?.((p) => {
    migrateLegacyDeeds(p);
    // Keep owner name up to date on owned homes.
    for (const hid of homesByOwner.get(p.id) ?? []) {
      const h = homes.get(hid);
      if (h && h.ownerName !== p.name) {
        h.ownerName = p.name;
      }
    }
    // Reconcile saved activeHome on reconnect!
    const saved = p.rpg?.activeHome;
    if (saved?.homeId) {
      const h = homes.get(saved.homeId);
      if (!h || locationOf(p) !== h.interior || !canVisitHome(p, h).ok) {
        ejectOccupant(p, h ?? { town: saved.returnTo?.location }, 'Your home visit expired; you were returned outside.');
      } else {
        setOccupant(p, h.id, saved.returnTo);
        ctx.notify?.(p, {
          kind: 'home.furnishings',
          homeId: h.id,
          furnishingRev: h.furnishingRev,
          furnishings: h.furnishings.map((f) => ({ ...f })),
          trader: h.trader ? { ...h.trader, listingIds: [...h.trader.listingIds] } : null,
        });
      }
    } else {
      // If a legacy owner joined directly inside their own interior, bind them to their isolated instance.
      const loc = locationOf(p);
      for (const hid of homesByOwner.get(p.id) ?? []) {
        const h = homes.get(hid);
        if (h && h.interior === loc && !h.archived) {
          setOccupant(p, h.id);
          break;
        }
      }
    }
  });

  ctx.onLeave?.((p) => {
    const hid = playerHome.get(p.id);
    if (hid) {
      activeOccupants.get(hid)?.delete(p.id);
      if (activeOccupants.get(hid)?.size === 0) activeOccupants.delete(hid);
      playerHome.delete(p.id);
    }
  });

  // React to location changes (e.g., walking out via portal.leave or fast travel).
  ctx.on?.('locationChanged', ({ player: p, to }) => {
    if (!p) return;
    const hid = playerHome.get(p.id);
    if (hid) {
      const h = homes.get(hid);
      if (!h || h.interior !== to) setOccupant(p, null);
    }
  });

  // React to block events from social module so blocked visitors are ejected immediately.
  ctx.on?.('socialBlocked', ({ blockerId, blockedId }) => {
    for (const h of homes.values()) {
      if (h.ownerId === blockerId || h.ownerId === blockedId) {
        ejectUnauthorizedVisitors(h, 'Your visit to this home has ended.');
      }
    }
  });

  // Periodic visiting-hours expiry check (bounded, never per-tick DB queries).
  let lastHoursCheck = -Infinity;
  ctx.onTick?.((_dt, t) => {
    if (t - lastHoursCheck < 5_000) return;
    lastHoursCheck = t;
    for (const hid of activeOccupants.keys()) {
      const h = homes.get(hid);
      if (h) ejectUnauthorizedVisitors(h, 'Visiting hours have ended; you were returned outside.');
    }
  });

  // Archive / restore lifecycle: archived home stays private and unavailable for visits/claims until restore or purge.
  ctx.on?.('characterArchived', ({ characterId }) => {
    const cid = int(characterId, NaN);
    if (!Number.isSafeInteger(cid)) return;
    for (const hid of homesByOwner.get(cid) ?? []) {
      const h = homes.get(hid);
      if (!h) continue;
      h.archived = true;
      ejectAllOccupants(h, 'This home is no longer open to visitors.');
      persistHome(h);
    }
  });

  ctx.on?.('characterRestored', ({ characterId }) => {
    const cid = int(characterId, NaN);
    if (!Number.isSafeInteger(cid)) return;
    for (const hid of homesByOwner.get(cid) ?? []) {
      const h = homes.get(hid);
      if (!h || !h.archived) continue;
      h.archived = false;
      persistHome(h);
    }
  });

  // Register archive blockers on `ctx.services.characterBlockers`.
  services.characterBlockers ||= [];
  services.characterBlockers.push((accountId, characterId, kind) => {
    if (kind !== 'archive') return [];
    const cid = int(characterId, NaN);
    if (!Number.isSafeInteger(cid)) return [];
    const blockers = [];
    for (const hid of homesByOwner.get(cid) ?? []) {
      const h = homes.get(hid);
      if (!h) continue;
      const visitors = activeVisitorsOf(h);
      if (visitors.length > 0) {
        blockers.push({
          code: 'ACTIVE_HOME_VISITORS',
          message: `Dismiss ${visitors.length} active visitor${visitors.length === 1 ? '' : 's'} from your home in ${h.region} before archiving.`,
          route: 'homes',
        });
      }
      if (hasActiveTraderListings(h)) {
        blockers.push({
          code: 'ACTIVE_HOUSE_TRADER',
          message: `Resolve active House Trader listings in your ${h.region} home before archiving.`,
          route: 'homes',
        });
      }
    }
    return blockers;
  });

  // Register forced purge / account deletion cleanup on `ctx.services.onCharacterPurge`.
  services.onCharacterPurge ||= [];
  services.onCharacterPurge.push(async ({ characterId }) => {
    const cid = int(characterId, NaN);
    if (!Number.isSafeInteger(cid)) return;
    const owned = [...(homesByOwner.get(cid) ?? [])].map((id) => homes.get(id)).filter(Boolean);
    if (!owned.length) return;
    const worldDeletes = [];
    for (const h of owned) {
      ejectAllOccupants(h, 'This home is no longer available.');
      if (h.trader) {
        if (typeof services.market?.detachAllForHouse === 'function') {
          try { await Promise.resolve(services.market.detachAllForHouse(h.id)); } catch {}
        }
        if (typeof services.market?.onHomeRelinquished === 'function') {
          try { await Promise.resolve(services.market.onHomeRelinquished(h)); } catch {}
        }
      }
      homes.delete(h.id);
      worldDeletes.push([`${HOME_PREFIX}${h.id}`, null]);
      const others = [...(homesByInterior.get(h.interior) ?? [])].filter((id) => id !== h.id);
      if (!others.length) worldDeletes.push([`${HOME_ADDR_PREFIX}${h.interior}`, null]);
    }
    rebuildIndexes();
    if (typeof services.store?.saveCharacters === 'function') {
      await Promise.resolve(services.store.saveCharacters([], worldDeletes));
    } else {
      for (const [k, v] of worldDeletes) ctx.dirtyWorld?.(k, v);
    }
  });

  const api = {
    homes,
    catalog: FURNISHING_CATALOG,
    migrateLegacyDeeds,
    isAddressAvailable,
    filterAvailableOffers,
    claimedAddresses: () => new Set(claimedAddresses),
    legacyClaimedAddresses: () => new Set(legacyClaimedAddresses),
    homesOf: (charId) => [...(homesByOwner.get(charId) ?? [])].map((id) => homes.get(id)).filter(Boolean),
    homeById: (id) => homes.get(String(id ?? '')) ?? null,
    activeHomeOf: (playerId) => {
      const hid = playerHome.get(playerId);
      return hid ? homes.get(hid) ?? null : null;
    },
    canVisitHome,
    overviewFor,
    buyHome,
    sellHome,
    saleQuoteFor,
    storageDeposit,
    storageWithdraw,
    // House Trader hooks for `market`
    verifyTraderAccess,
    getHouseTrader: (homeId) => {
      const h = homes.get(String(homeId ?? ''));
      return h?.trader ? { homeId: h.id, ownerId: h.ownerId, ...h.trader, listingIds: [...h.trader.listingIds] } : null;
    },
    getOwnerTraders: (charId) => [...(homesByOwner.get(charId) ?? [])]
      .map((id) => homes.get(id))
      .filter((h) => h?.trader)
      .map((h) => ({ homeId: h.id, ownerId: h.ownerId, region: h.region, ...h.trader, listingIds: [...h.trader.listingIds] })),
    attachTraderListing,
    detachTraderListing,
    canSellHome: (homeId) => {
      const h = homes.get(String(homeId ?? ''));
      return h ? saleQuoteFor(h) : { canSell: false, blockers: ['Home not found.'] };
    },
    whenIdle: () => Promise.allSettled([...pendingDurableOps]),
  };

  services.homes = api;
  return api;
}

export default install;
