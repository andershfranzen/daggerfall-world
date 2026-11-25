// Shared containers: dungeon treasure, tavern / guild treasure markers, house furniture, library bookshelves and
// owner-registered storage. One server-side record per container; every player in the place sees the same contents
// and an item can be taken exactly once. Contents are world state (ctx.dirtyWorld), saved in the same transaction as
// the player who changed them, so a restart keeps both sides consistent.
//
// Sites come from the scene of the instance (client/world/interiors/containers.js); stocking follows Daggerfall
// Unity's rules (server/rpg/items/loot.js):
//   treasure   dungeon 199/19 and 216/n flats: LootTables.GenerateLoot by dungeon type; tavern/TG/DB markers: by the
//              town's location type (DaggerfallInterior.AddFlats). Stocked once; never restocked (shared world: the
//              first finder empties it for everyone).
//   house      private furniture (DaggerfallLoot.StockHouseContainer by building type and model record), restocked
//              when the classic stocked date (year*1000 + day) has passed. Searching asks for confirmation (classic
//              "private property" prompt); taking marks the items `stolen` and emits `itemStolen` for the law owner.
//              In an interior the player owns (services.ownsInterior) the furniture is plain storage.
//   bookshelf  library / guild hall / temple shelves (DaggerfallBookshelf): ten installed books to read in place.
//              Guild halls and temples require membership (Guild.CanAccessLibrary); libraries are public.
//   shelf      shop shelves are the shop owner's (package 12): they appear only when an adapter is registered.
//
// Actions   container.open {containerId, confirm?}   container.take {containerId, itemId?, quantity?}
//           container.put {containerId, itemId, quantity?}   container.read {containerId, bookId}
// Entities  {id, kind:'container', containerType, name, location, x, y, z, empty, sprite?}
// Events    notify {kind:'container', containerId, name, containerType, items, books?, prompt?, canPut}
//           emit containerOpened {player, containerId, containerType, location}
//           emit itemStolen {player, location, containerId, items}
// Services  ctx.services.containers: list(location), sites(location), contents(id), registerAdapter(type, adapter),
//           createStorage(spec), ready(location)

import { generateItems, dungeonTreasure, stockHouseContainer, stockedDate, randomBook, DUNGEON_LOOT_KEYS, TREASURE_ARCHIVE, TREASURE_ICON_RECORDS } from './items/loot.js';
import { normalizeRecord, carriedWeight, maxEncumbrance, GOLD_PER_KG } from './inventory.js';

export const name = 'containers';
export const WORLD_PREFIX = 'containers/';
/** PlayerActivate.TreasureActivationDistance: 128 classic units. */
export const CONTAINER_REACH = 128 * 0.025 + 0.6; // + body radius: the server measures from the player's centre
const VERTICAL_REACH = 2.5;
const MAX_CONTENTS = 64;
const BOOKSHELF_BOOKS = 10;
const LABELS = { treasure: 'Treasure', house: 'Private property', bookshelf: 'Bookshelf', shelf: 'Shelves', storage: 'Storage', ownedShelf: 'Shelves' };
// FactionFile.FactionIDs used by the library check.
const MAGES_GUILD = 40;
const FIGHTERS_GUILD = 41;

const hash32 = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};
/** Seeded [0,1) generator (mulberry32) so a container's stock is reproducible from its key and stocked date. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function install(ctx, options = {}) {
  const services = (ctx.services ||= {});
  const log = ctx.log ?? console;
  const sites = new Map(); // location -> Map(localId -> site) | Promise
  const state = new Map(); // containerKey -> {stocked, items, books?}
  const adapters = new Map(); // containerType -> adapter
  const viewers = new Map(); // containerKey -> Set(player id)
  const sceneOf = options.scene ?? ((location) => services.interiors?.scene(location));

  for (const [key, v] of ctx.loadWorld?.(WORLD_PREFIX) ?? []) {
    const rec = hydrate(v);
    if (rec) state.set(key.slice(WORLD_PREFIX.length), rec);
  }

  function hydrate(v) {
    if (!v || typeof v !== 'object') return null;
    const items = [];
    for (const raw of Array.isArray(v.items) ? v.items : []) {
      if (raw?.template === 'gold') { if (raw.quantity > 0) items.push({ template: 'gold', name: 'Gold pieces', quantity: Math.trunc(raw.quantity), id: raw.id ?? 'gold' }); continue; }
      const it = normalizeRecord(raw);
      if (it) { delete it.equipped; items.push(it); }
    }
    return { stocked: Number.isFinite(v.stocked) ? v.stocked : 0, items: items.slice(0, MAX_CONTENTS), books: Array.isArray(v.books) ? v.books.filter(Number.isInteger) : undefined };
  }
  const serialize = (rec) => ({ stocked: rec.stocked, items: rec.items, ...(rec.books ? { books: rec.books } : {}) });

  const entityId = (location, localId) => `ct:${localId}@${location}`;
  const keyOf = (location, localId) => `${location}#${localId}`;
  const parseId = (id) => {
    const m = /^ct:([^@]+)@(.+)$/.exec(String(id ?? ''));
    return m ? { localId: m[1], location: m[2] } : null;
  };
  const say = (p, text) => ctx.notify?.(p, { kind: 'inventory', text });
  const fail = (msg) => { throw new Error(msg); };

  // --------------------------------------------------------------- sites and entities

  function ensureSites(location) {
    if (!location || sites.has(location)) return sites.get(location);
    if (!/^(interior|dungeon):/.test(location)) { sites.set(location, new Map()); return sites.get(location); }
    const job = Promise.resolve()
      .then(() => sceneOf(location))
      .then((scene) => {
        const map = new Map();
        const meta = {
          buildingType: scene?.source?.buildingType ?? null, quality: scene?.source?.quality ?? 0,
          factionId: scene?.source?.factionId ?? 0, locationType: scene?.source?.locationType ?? -1,
          dungeonType: scene?.dungeonType ?? null, kind: scene?.kind ?? null,
        };
        for (const c of scene?.containers ?? []) map.set(c.id, { ...c, location, meta });
        sites.set(location, map);
        publish(location);
        return map;
      })
      .catch((err) => {
        sites.set(location, new Map());
        log.warn?.(`[containers] no container sites for ${location}: ${err?.message ?? err}`);
      });
    sites.set(location, job);
    return job;
  }
  const siteMap = (location) => {
    const s = sites.get(location);
    return s instanceof Map ? s : null;
  };

  /** Effective type of a site for a player (owned interiors turn private furniture into storage). */
  function typeFor(site, p) {
    if (site.kind === 'ownedShelf' || site.kind === 'house') {
      if (p && services.ownsInterior?.(p, site.location)) return 'storage';
      return site.kind === 'house' ? 'house' : null;
    }
    if (site.kind === 'shelf') return adapters.has('shelf') ? 'shelf' : null;
    return site.kind;
  }

  function publish(location) {
    const map = siteMap(location);
    if (!map) return;
    for (const site of map.values()) {
      const type = typeFor(site, null);
      if (!type) continue;
      const id = entityId(location, site.id);
      const rec = state.get(keyOf(location, site.id));
      const sprite = type === 'treasure'
        ? site.sprite ?? { archive: TREASURE_ARCHIVE, record: TREASURE_ICON_RECORDS[hash32(id) % TREASURE_ICON_RECORDS.length] }
        : null;
      const e = {
        id, kind: 'container', containerType: type, name: LABELS[type] ?? 'Container', location,
        x: site.x, y: site.y, z: site.z, yaw: 0,
        empty: !!rec && rec.stocked !== 0 && !rec.items.length && type !== 'bookshelf',
        ...(sprite && !(rec && rec.stocked && !rec.items.length) ? { sprite } : {}),
      };
      ctx.entities.set(id, e);
    }
  }

  const seen = new Set();
  ctx.onTick?.(() => {
    seen.clear();
    for (const p of ctx.players?.values?.() ?? []) {
      const loc = ctx.location(p);
      if (seen.has(loc)) continue;
      seen.add(loc);
      if (!sites.has(loc)) ensureSites(loc);
    }
  });
  ctx.on?.('locationChanged', ({ to }) => { if (to) ensureSites(to); });

  // --------------------------------------------------------------- stocking

  function levelOf(p) { return Math.max(1, Math.trunc(Number(p?.rpg?.character?.level) || 1)); }
  function genderOf(p) { return p?.rpg?.character?.gender === 'female' ? 'female' : 'male'; }
  const today = () => stockedDate(services.worldClock?.());

  function materialise(specs) {
    const out = [];
    for (const s of specs) {
      if (!s) continue;
      if (s.template === 'gold') { if (s.quantity > 0) out.push({ id: `gold`, template: 'gold', name: 'Gold pieces', quantity: s.quantity }); continue; }
      try {
        // Package 16 descriptors carry per-item state as `appearance.extra` (potion recipes, MAGIC.DEF items).
        const it = services.makeItemRecord(s.template, s.quantity ?? 1, s.extra ?? s.appearance?.extra ?? null);
        if (Number.isInteger(s.variant) && it.group === 'clothing') it.variant = Math.min(Math.max(0, s.variant), (it.variants ?? 1) - 1);
        if (Number.isInteger(s.variant) && it.group === 'book') it.variant = s.variant;
        out.push(it);
      } catch (err) {
        log.warn?.(`[containers] skipped item ${s.template}: ${err.message}`);
      }
    }
    // Merge gold.
    const gold = out.filter((r) => r.template === 'gold').reduce((n, r) => n + r.quantity, 0);
    const rest = out.filter((r) => r.template !== 'gold');
    return (gold ? [{ id: 'gold', template: 'gold', name: 'Gold pieces', quantity: gold }, ...rest] : rest).slice(0, MAX_CONTENTS);
  }

  /** Make sure the container record exists and is stocked for today. Returns the record (mutations: caller rolls back). */
  function stock(site, p, type) {
    const key = keyOf(site.location, site.id);
    let rec = state.get(key);
    const date = today() || 1;
    const opts = {
      level: levelOf(p), gender: genderOf(p), books: services.books ?? null,
      magicItem: typeof services.randomMagicItem === 'function' ? (rand) => services.randomMagicItem(rand, levelOf(p)) : null,
      // DaggerfallLoot.RandomlyAddMap / RandomlyAddPotion / RandomlyAddPotionRecipe for loot keys J-O.
      extras: {
        map: () => ({ template: 'map' }),
        potion: (rand) => services.randomPotionLoot?.(rand) ?? null,
        recipe: (rand) => services.randomPotionRecipeLoot?.(rand) ?? null,
      },
    };
    if (type === 'treasure') {
      if (rec) return rec;
      const rand = seeded(hash32(key));
      const spec = site.meta.kind === 'dungeon'
        ? dungeonTreasure(site.meta.dungeonType ?? 0, { ...opts, rand })
        : generateItems(DUNGEON_LOOT_KEYS[site.meta.locationType] ?? 'N', { ...opts, rand });
      rec = { stocked: date, items: materialise(spec.items) };
    } else if (type === 'house') {
      if (rec && rec.stocked >= date) return rec;
      const rand = seeded(hash32(`${key}/${date}`));
      const spec = stockHouseContainer(site.meta.buildingType, site.record ?? 0, { ...opts, rand });
      rec = { stocked: date, items: materialise(spec.items) };
    } else if (type === 'bookshelf') {
      if (rec?.books?.length) return rec;
      const rand = seeded(hash32(key));
      const books = [];
      for (let i = 0; i < BOOKSHELF_BOOKS; i++) {
        const b = randomBook(services.books, rand);
        if (b) books.push(b.extra.bookId);
      }
      rec = { stocked: date, items: [], books };
    } else {
      if (rec) return rec;
      rec = { stocked: date, items: [] };
    }
    const prev = state.get(key);
    ctx.onRollback?.(() => { if (prev) state.set(key, prev); else state.delete(key); });
    state.set(key, rec);
    saveRec(key);
    return rec;
  }
  function saveRec(key) {
    if (typeof ctx.dirtyWorld === 'function') ctx.dirtyWorld(WORLD_PREFIX + key, () => (state.has(key) ? serialize(state.get(key)) : null));
  }
  /** Copy-on-write: snapshot the record for rollback before mutating it. */
  function mutable(key) {
    const rec = state.get(key);
    const before = { ...rec, items: rec.items.slice() };
    ctx.onRollback?.(() => state.set(key, before));
    rec.items = rec.items.slice();
    return rec;
  }

  // --------------------------------------------------------------- access

  function siteFor(p, containerId) {
    const ref = parseId(containerId);
    if (!ref) fail('There is nothing there to search.');
    const map = siteMap(ref.location);
    const site = map?.get(ref.localId);
    if (!site) fail('There is nothing there to search.');
    if (ctx.location(p) !== ref.location) fail('That is too far away.');
    const dx = site.x - p.x, dz = site.z - p.z;
    const footY = Number.isFinite(p.y) ? p.y : p.rpg?.portal?.footY;
    if (Math.hypot(dx, dz) > CONTAINER_REACH) fail('You are too far away.');
    if (Number.isFinite(footY) && Number.isFinite(site.y) && Math.abs(site.y - footY) > VERTICAL_REACH + 1.5) fail('You are too far away.');
    const type = typeFor(site, p);
    if (!type) fail('There is nothing there to search.');
    return { site, type, key: keyOf(site.location, site.id), id: entityId(site.location, site.id) };
  }

  function libraryAllowed(p, site) {
    // Package 15: Guild.CanAccessLibrary for exactly this hall and rank (DaggerfallBookshelf.ReadBook).
    if (typeof services.guildLibraryAccess === 'function') return services.guildLibraryAccess(p, site.meta).ok;
    const t = site.meta.buildingType;
    if (t === 10) return true; // Library
    const g = p.rpg?.guilds ?? {};
    if (t === 11) {
      if (site.meta.factionId === MAGES_GUILD) return !!g.mages;
      if (site.meta.factionId === FIGHTERS_GUILD) return !!g.fighters;
      return Object.keys(g).length > 0;
    }
    if (t === 14) return !!g.temple;
    return true;
  }

  const libraryRefusal = (p, site) => services.guildLibraryAccess?.(p, site.meta)?.text ?? 'Access to the library is for members only.';

  const view = (rec) => rec.items.map((r) => ({ ...r }));
  function show(p, c, rec, extra = {}) {
    viewers.get(c.key)?.add(p.id) ?? viewers.set(c.key, new Set([p.id]));
    ctx.notify?.(p, {
      kind: 'container', containerId: c.id, name: LABELS[c.type] ?? 'Container', containerType: c.type,
      items: view(rec), canPut: c.type === 'storage' || c.type === 'treasure', ...extra,
    });
  }
  /** Refresh everyone else looking into the same container (their copy is stale after a take). */
  function refreshViewers(c, rec, except) {
    const ids = viewers.get(c.key);
    if (!ids) return;
    for (const q of ctx.players?.values?.() ?? []) {
      if (!ids.has(q.id) || q === except) continue;
      if (ctx.location(q) !== c.site.location) { ids.delete(q.id); continue; }
      ctx.notify?.(q, { kind: 'container', containerId: c.id, name: LABELS[c.type], containerType: c.type, items: view(rec), canPut: c.type === 'storage' || c.type === 'treasure', refreshed: true });
    }
  }
  function updateEntity(c, rec) {
    const e = ctx.entities.get(c.id);
    if (!e) return;
    ctx.touchEntity?.(e);
    e.empty = c.type !== 'bookshelf' && rec.items.length === 0;
    if (c.type === 'treasure' && e.empty) delete e.sprite;
  }

  ctx.onAction('container.open', (p, args = {}) => {
    const c = siteFor(p, args.containerId);
    const adapter = adapters.get(c.type);
    if (adapter?.open) return adapter.open(p, c.site, args);
    if (c.type === 'bookshelf') {
      if (!libraryAllowed(p, c.site)) fail(libraryRefusal(p, c.site));
      const rec = stock(c.site, p, 'bookshelf');
      const books = (rec.books ?? []).map((id) => ({ id, title: services.bookTitle?.(id) ?? `Book ${id}` }));
      if (!books.length) fail('The shelves hold nothing you can read: the game\'s books are not installed on this server.');
      show(p, c, rec, { books });
      return;
    }
    if (c.type === 'house' && args.confirm !== true) {
      // PlayerActivate: "This is private property. Do you wish to search it?" before stocking.
      ctx.notify?.(p, { kind: 'container', containerId: c.id, name: LABELS.house, containerType: 'house', prompt: 'private', text: 'This is private property. Search it anyway?' });
      return;
    }
    const rec = stock(c.site, p, c.type);
    if (c.type === 'house' && !rec.items.length) { say(p, 'You find nothing of interest.'); updateEntity(c, rec); return; }
    updateEntity(c, rec);
    show(p, c, rec);
    ctx.emit?.('containerOpened', { player: p, containerId: c.id, containerType: c.type, location: c.site.location });
  });

  ctx.onAction('container.take', (p, args = {}) => {
    const c = siteFor(p, args.containerId);
    const adapter = adapters.get(c.type);
    if (adapter?.take) return adapter.take(p, c.site, args);
    if (c.type === 'bookshelf') fail('The books stay on the shelf. Read them here.');
    const rec0 = state.get(c.key);
    if (!rec0 || !rec0.stocked) fail('Search it first.');
    const wantedId = args.itemId == null ? null : String(args.itemId);
    const chosen = wantedId === null ? rec0.items.slice() : rec0.items.filter((r) => r.id === wantedId || (wantedId === 'gold' && r.template === 'gold'));
    if (!chosen.length) fail(rec0.items.length ? 'That item is no longer there.' : 'It is empty.');
    const rpg = p.rpg;
    const qtyFor = (r) => (wantedId !== null && args.quantity != null ? Math.max(1, Math.min(r.quantity, Math.trunc(Number(args.quantity)) || 1)) : r.quantity);
    const addKg = chosen.reduce((kg, r) => kg + (r.template === 'gold' ? qtyFor(r) / GOLD_PER_KG : (r.weight ?? 0) * qtyFor(r)), 0);
    const capacity = services.maxEncumbrance?.(p) ?? maxEncumbrance(rpg);
    if (carriedWeight(rpg) + addKg > capacity) fail('You cannot carry that much.');
    const rec = mutable(c.key);
    const stolen = c.type === 'house' ? { from: c.site.location, at: Date.now() } : null;
    const taken = [];
    for (const r of chosen) {
      const q = qtyFor(r);
      const part = { ...r, quantity: q };
      if (stolen && part.template !== 'gold') part.stolen = stolen;
      if (part.template === 'gold') services.addGold(p, q);
      else services.insertRecord(p, part);
      taken.push(part);
      const i = rec.items.indexOf(r);
      if (q >= r.quantity) rec.items.splice(i, 1);
      else rec.items[i] = { ...r, quantity: r.quantity - q };
    }
    saveRec(c.key);
    updateEntity(c, rec);
    ctx.dirty?.(p);
    show(p, c, rec);
    refreshViewers(c, rec, p);
    const names = taken.map((r) => (r.template === 'gold' ? `${r.quantity} gold` : r.quantity > 1 ? `${r.quantity} × ${r.name}` : r.name));
    ctx.notify?.(p, { kind: 'inventory', text: `You take ${names.join(', ')}.`, artItems: taken.filter((r) => r.template !== 'gold').slice(0, 4).map(({ template, icon, variant }) => ({ template, icon, variant })) });
    if (stolen) ctx.emit?.('itemStolen', { player: p, location: c.site.location, containerId: c.id, items: taken.map((r) => ({ ...r })) });
  });

  ctx.onAction('container.put', (p, args = {}) => {
    const c = siteFor(p, args.containerId);
    const adapter = adapters.get(c.type);
    if (adapter?.put) return adapter.put(p, c.site, args);
    if (c.type !== 'storage' && c.type !== 'treasure') fail('You cannot leave things there.');
    const rec0 = stock(c.site, p, c.type);
    if (rec0.items.length >= MAX_CONTENTS) fail('There is no room left in it.');
    const itemId = String(args.itemId ?? '');
    const held = p.rpg.inventory.find((i) => i.id === itemId);
    const qty = args.quantity == null ? held?.quantity ?? 1 : args.quantity;
    if (held?.quest) fail(`${held.name} must stay with you.`);
    const moved = services.takeItem(p, itemId, qty);
    const rec = mutable(c.key);
    const same = moved.stackable ? rec.items.find((r) => r.template === moved.template && JSON.stringify([r.magic, r.bookId, r.letter, r.recipe]) === JSON.stringify([moved.magic, moved.bookId, moved.letter, moved.recipe])) : null;
    if (same) rec.items[rec.items.indexOf(same)] = { ...same, quantity: same.quantity + moved.quantity };
    else rec.items.push(moved);
    saveRec(c.key);
    updateEntity(c, rec);
    show(p, c, rec);
    refreshViewers(c, rec, p);
    say(p, `You leave ${moved.quantity > 1 ? `${moved.quantity} × ` : ''}${moved.name}.`);
  });

  ctx.onAction('container.read', (p, args = {}) => {
    const c = siteFor(p, args.containerId);
    if (c.type !== 'bookshelf') fail('There is nothing to read there.');
    if (!libraryAllowed(p, c.site)) fail(libraryRefusal(p, c.site));
    const rec = stock(c.site, p, 'bookshelf');
    const id = Math.trunc(Number(args.bookId));
    if (!rec.books?.includes(id)) fail('That book is not on this shelf.');
    const b = services.books?.read(id);
    if (!b) fail('The pages are blank.');
    ctx.notify?.(p, { kind: 'book', containerId: c.id, bookId: id, title: b.title, author: b.author, pages: b.pages });
    ctx.emit?.('itemRead', { player: p, item: null, bookId: id });
  });

  // --------------------------------------------------------------- services

  services.containers = {
    /** Wait for a location's sites (tests and fixtures). */
    ready: (location) => Promise.resolve(ensureSites(location)).then(() => siteMap(location)),
    sites: (location) => [...(siteMap(location)?.values() ?? [])].map((s) => ({ ...s, meta: { ...s.meta } })),
    /** Container entities of a location for Detect Treasure and similar: [{id, containerType, x,y,z, empty, stocked}]. */
    list(location) {
      const out = [];
      for (const site of siteMap(location)?.values() ?? []) {
        const type = typeFor(site, null);
        if (!type) continue;
        const rec = state.get(keyOf(location, site.id));
        out.push({ id: entityId(location, site.id), containerType: type, x: site.x, y: site.y, z: site.z, empty: !!rec && !!rec.stocked && !rec.items.length, stocked: !!rec?.stocked });
      }
      return out;
    },
    contents: (id) => {
      const ref = parseId(id);
      const rec = ref ? state.get(keyOf(ref.location, ref.localId)) : null;
      return rec ? view(rec) : null;
    },
    /**
     * Let another owner handle a container type: {open?(p, site, args), take?(p, site, args), put?(p, site, args)}.
     * 'shelf' makes shop shelves appear (package 12).
     */
    registerAdapter(type, adapter) {
      if (typeof type !== 'string' || !adapter) throw new TypeError('registerAdapter(type, adapter)');
      adapters.set(type, adapter);
      for (const loc of sites.keys()) publish(loc);
    },
    /**
     * A free-standing shared storage container (property, wagon drop, quest stash):
     * {location, id, x, y, z, name?} -> entity id. Contents persist like any other container.
     */
    createStorage({ location, id, x, y, z = 0, name: label = 'Storage' }) {
      if (typeof location !== 'string' || !/^[\w.-]{1,40}$/.test(String(id))) throw new TypeError('createStorage needs a location and a simple id');
      ensureSites(location);
      const add = (map) => {
        map.set(`s.${id}`, { id: `s.${id}`, kind: 'storage', x, y, z, location, meta: { kind: 'storage' } });
        publish(location);
        const e = ctx.entities.get(entityId(location, `s.${id}`));
        if (e) e.name = label;
      };
      const s = sites.get(location);
      if (s instanceof Map) add(s); else Promise.resolve(s).then(() => add(siteMap(location)));
      return entityId(location, `s.${id}`);
    },
  };

  return { services: services.containers, state, sites };
}
