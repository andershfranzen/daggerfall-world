// Shared-world NPCs: deterministic town rosters, close-range conversation,
// merchants, guild membership/ranks/services and faction reputation.
// See docs/gameplay-protocol.md for the ctx contract.

import {
  FACTIONS, GUILDS, HOSTILE_REPUTATION, ITEM_VALUES, LINES, MAX_QUANTITY, MERCHANT_PURSE, REGION_FACTION,
  RESTOCK_MS, ROLES, SERVICE_LABELS, SESSION_TTL_MS, STOCK, TALK_RANGE, TOPIC_LABELS,
} from './npcs/data.js';
import {
  buyPrice, clampRep, compassWord, districtFor, eligibleToJoin, hash32, hasRoster, parseLocation, rankFor,
  rosterFor, sellPrice, skillValue, suggestSkills,
} from './npcs/rules.js';
import { parseFactionText } from '../../client/gameplay/npcs/factionFile.js';
import { normaliseQuery } from '../../client/gameplay/npcs/conversation.js';
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createPeopleSource } from './npcs/world.js';
import { createPlaces } from './npcs/places.js';
import { presentAt, SHOP_KIND } from './npcs/people.js';
import { parseLocation as parsePlace, buildingTypeName } from '../../client/world/interiors/index.js';
import { arena2Files } from './collision/arena2.js';
import { createShopEconomy, FENCE_RANK } from './economy/ledger.js';
import { cloneHolds, hydrateHolds, serializeHolds } from './economy/basket.js';
import { loadTown } from '../../client/world/town.js';
import { compassWord as compass } from './npcs/rules.js';
import {
  PATIENCE, TONES, TONE_LABELS, WEARY, cleanLearned, knows, learnPlace, localTale, react, refusalLine, socialGroup, unknownLine,
} from './npcs/talk.js';

export { TALK_RANGE } from './npcs/data.js';
export { rosterFor } from './npcs/rules.js';

const ID_RE = /^[\w:,.-]{1,80}$/;
/** Requests the speaker may refuse depending on the tone (package 3). */
const INFO_TOPICS = new Set(['news', 'rumours', 'directions', 'inn', 'work']);
/** How long a speaker who has run out of patience with a player stays unwilling (real time). */
const PATIENCE_MS = 5 * 60_000;
const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));

function fail(msg) {
  throw new Error(msg);
}

export function install(ctx, options = {}) {
  const services = (ctx.services ||= {});
  const spawned = new Set(); // locations whose roster is in ctx.entities
  const shops = new Map(); // npcId -> shop state (shared by all players)
  const sessions = new Map(); // playerId -> { npcId, token, at, mode, counter }
  const patience = new Map(); // `${playerId}>${npcId}` -> { refusals, until }: a refusal outlasts the conversation
  let tokenSeq = 0;

  // Operator-supplied FACTION.TXT (optional): real faction names and the flats each faction uses.
  const factionNames = Object.fromEntries(Object.values(FACTIONS).map((f) => [f.id, f.name]));
  const factionFlats = new Map();
  try {
    if (typeof ctx.dataFile === 'function') {
      const parsed = parseFactionText(readFileSync(ctx.dataFile('FACTION.TXT'), 'latin1'));
      for (const id of Object.keys(FACTIONS).map(Number)) {
        const f = parsed.get(id);
        if (!f) continue;
        if (f.name) factionNames[id] = f.name;
        if (f.flats.length) factionFlats.set(id, f.flats);
      }
    }
  } catch { /* no game data on this server: built-in names and sprites */ }
  const factionName = (id) => factionNames[id] ?? FACTIONS[id]?.name ?? 'Unknown';
  const nameOfFaction = (e) => e.factionName ?? factionName(e.faction);

  // Source-backed people (installed ARENA2): authored RMB/RDB records, DFU mobile townspeople and work rolls.
  // Without game data the deterministic legacy roster below stands in (tests, data-less servers).
  let townFiles = null;
  const spawnLocal = async (townId) => {
    const ov = services.overland;
    if (ov?.whenPlaced && ov?.townFrame) {
      await ov.whenPlaced(townId);
      const f = ov.townFrame(townId);
      if (f?.spawnLocal) return f.spawnLocal;
    }
    townFiles ??= await arena2Files(ctx.dataPath);
    const rest = townId.slice(5), at = rest.indexOf('/');
    const t = await loadTown(townFiles, { region: rest.slice(0, at), location: rest.slice(at + 1), worldData: await services.worldData?.ready });
    return t.source.spawnLocal;
  };
  const hasBlocks = (dir) => {
    try {
      return readdirSync(dir).some((n) => /^BLOCKS\.BSA$/i.test(n) || (/^arena2$/i.test(n) && readdirSync(join(dir, n)).some((m) => /^BLOCKS\.BSA$/i.test(m))));
    } catch {
      return false;
    }
  };
  const peopleSource = options.peopleSource ?? (ctx.dataPath && hasBlocks(ctx.dataPath) ? createPeopleSource(ctx.dataPath, services.worldData?.ready ?? null, { spawnLocal }) : null);
  const places = peopleSource ? createPlaces(ctx, peopleSource, { onAdd: (e) => { if (e.shop) shopFor(e); } }) : null;
  const statePath = options.statePath ?? ctx.config?.npcStatePath ?? process.env.DFW_NPC_STATE ?? null;

  // ------------------------------------------------------------ player state

  function ensureState(p) {
    const rpg = (p.rpg ||= {});
    if (!rpg.factions || typeof rpg.factions !== 'object' || Array.isArray(rpg.factions)) rpg.factions = {};
    if (!rpg.guilds || typeof rpg.guilds !== 'object' || Array.isArray(rpg.guilds)) rpg.guilds = {};
    for (const [k, v] of Object.entries(rpg.factions)) if (!Number.isFinite(v)) delete rpg.factions[k];
    // Memberships (temples, orders, secret guilds) belong to the guilds feature (server/rpg/guilds.js).
    if (services.guilds) services.guilds.normalize(rpg);
    else for (const [k, v] of Object.entries(rpg.guilds)) {
      if (!GUILDS[k] || !v || typeof v !== 'object') delete rpg.guilds[k];
      else v.rank = Math.max(0, Math.min(9, Math.trunc(v.rank) || 0));
    }
    if (!Number.isInteger(rpg.gold) || rpg.gold < 0) rpg.gold = Math.max(0, Math.trunc(Number(rpg.gold) || 0));
    if (rpg.learnedPlaces !== undefined) cleanLearned(rpg);
    return rpg;
  }

  const reputation = (p, factionId) => ensureState(p).factions[factionId] ?? 0;

  /** Any faction of the installed FACTION.TXT (guilds feature); `opts.propagate` follows the classic hierarchy. */
  function adjustReputation(p, factionId, delta, opts) {
    const id = Number(factionId);
    if (services.guilds && services.isFaction?.(id)) {
      ensureState(p);
      return services.guilds.changeReputation(p, id, delta, opts);
    }
    if (!FACTIONS[id] || !Number.isFinite(delta)) return reputation(p, id);
    const rpg = ensureState(p);
    rpg.factions[id] = clampRep((rpg.factions[id] ?? 0) + delta);
    return rpg.factions[id];
  }

  const membership = (p, guildId) => ensureState(p).guilds[guildId] || null;
  /** Membership at this person's own hall: a temple or knightly order must be the very one the player serves. */
  const memberAt = (p, e) => {
    if (!e?.guild) return null;
    ensureState(p);
    return services.guilds ? services.guilds.memberOf(p, services.guilds.hallOf(e)) : membership(p, e.guild);
  };

  /** Re-evaluate rank (promotion only). Returns the new rank title when promoted. */
  function checkPromotion(p, guildId) {
    if (services.guilds) return null; // classic 28-day rank changes happen at the hall (guilds.greet)
    const m = membership(p, guildId);
    if (!m) return null;
    const guild = GUILDS[guildId];
    const r = rankFor(p.rpg.character, guild, reputation(p, guild.factionId));
    if (r > m.rank) {
      m.rank = r;
      return guild.ranks[r];
    }
    return null;
  }

  // ------------------------------------------------------------ world

  function ensureRoster(location, { retry = false } = {}) {
    if (places) {
      places.load(location, { retry });
      return;
    }
    if (spawned.has(location) || !hasRoster(location)) return;
    spawned.add(location);
    for (const npc of rosterFor(location)) {
      // Guild and temple NPCs wear the flats their faction lists in FACTION.TXT.
      const flats = npc.guild ? factionFlats.get(npc.faction) : null;
      if (flats) {
        const [archive, record] = flats[hash32(npc.id) % flats.length];
        npc.sprite = { archive, record };
      }
      if (npc.guild) npc.factionName = factionName(npc.faction);
      if (!ctx.entities.has(npc.id)) ctx.entities.set(npc.id, npc);
      if (npc.shop) shopFor(npc);
    }
  }

  /** Role definition: the legacy table for roster people, the entity's own source-derived data otherwise. */
  function roleDef(e) {
    if (!e.sourced && !e.mobile && ROLES[e.role]) return ROLES[e.role];
    const topics = ['news', 'rumours', 'directions'];
    if (e.mobile || parsePlace(e.location)?.kind === 'interior') topics.push('inn');
    if (e.shop && e.service !== 'tavern') topics.unshift('trade');
    if (e.questGiver || e.mobile || e._workGroup || e._castleGroup) topics.unshift('work');
    if (e.guild || e.factionName) topics.push('organisation');
    const svc = [...(e.services ?? [])];
    if (e.bank) svc.push('bank');
    if (e.repair) svc.push('repair');
    return { title: e.title, topics, services: svc };
  }

  /** Shop identity: one stock per building (DFU keeps shelves per building), else per roster NPC. */
  const shopKey = (e) => (e.sourced ? `shop:${e.location}` : e.id);
  function shopFor(e) {
    const k = shopKey(e);
    let shop = shops.get(k);
    if (!shop) {
      shop = econ.isBuildingShop(e) ? econ.newBuildingLedger(e, MERCHANT_PURSE[e.shop] ?? 500) : newShop(e.shop, ctx.now());
      shops.set(k, shop);
      shopChanged(k);
    }
    return shop;
  }
  /** Ledger key of the shop or fence this player is selling to. */
  const shopLedgerKey = (e, shop) => (shop?.fence ? `fence:${e.location}` : shopKey(e));
  /** A Thieves Guild fence's purse (no stock for sale). */
  function fenceFor(e) {
    const k = `fence:${e.location}`;
    let shop = shops.get(k);
    if (!shop) {
      shop = { kind: 'general', purse: MERCHANT_PURSE.smith ?? 2500, stock: new Map(), rev: 1, restockAt: Infinity, fence: true, building: null };
      shops.set(k, shop);
      shopChanged(k);
    }
    return shop;
  }
  /** The ledger with today's shelf stock (classic shelves re-stock when first browsed on a new day). */
  function openShop(e, p) {
    const shop = shopFor(e);
    if (econ.stockIfDue(shop, e, p, MERCHANT_PURSE[e.shop] ?? 500)) shopChanged(shopKey(e));
    return shop;
  }

  // ------------------------------------------------------------ shop persistence (shared world state)
  //
  // Each ledger is one `world_state` row (`npcshop:<shop key>`) in the game database, written in the same
  // transaction as the characters of the action that changed it (ctx.dirtyWorld): a purchase saves the buyer's
  // gold/pack and the shop's purse/stock together, and a failed save rolls both back (guardShop + the runtime's
  // player snapshots). Restocks and first sightings outside actions are queued for the periodic save.
  // An explicit `options.statePath` / `config.npcStatePath` / $DFW_NPC_STATE file is still honoured (fixtures).

  const WORLD_PREFIX = 'npcshop:';
  const serializeShop = (shop) => ({
    v: 1, kind: shop.kind, purse: shop.purse, rev: shop.rev, stock: [...shop.stock].map(([key, it]) => ({ key, ...it })),
    ...(shop.building ? { building: shop.building, stocked: shop.stocked, stockedLevel: shop.stockedLevel } : {}),
    ...(shop.fence ? { fence: true } : {}),
    ...(serializeHolds(shop.holds) ? { holds: serializeHolds(shop.holds) } : {}), // package 12 baskets
  });
  function hydrateShop(v) {
    if (!v || typeof v !== 'object' || !STOCK[v.kind]) return null;
    const stock = new Map();
    for (const it of Array.isArray(v.stock) ? v.stock : []) {
      if (it && typeof it.key === 'string' && Number.isInteger(it.quantity) && it.quantity >= 0 && Number.isFinite(it.value)) {
        stock.set(it.key, {
          template: it.template, name: it.name, value: it.value, icon: it.icon, variant: it.variant, quantity: it.quantity,
          ...(Number.isInteger(it.shelf) ? { shelf: it.shelf } : {}), ...(typeof it.group === 'string' ? { group: it.group } : {}),
          ...(it.extra && typeof it.extra === 'object' && !Array.isArray(it.extra) ? { extra: it.extra } : {}),
          ...(Number.isInteger(it.maxCondition) && it.maxCondition > 0 ? { maxCondition: it.maxCondition } : {}),
        });
      }
    }
    const building = v.building && typeof v.building === 'object' && Number.isInteger(v.building.type) ? v.building : null;
    return {
      kind: v.kind, purse: Math.max(0, Math.trunc(v.purse) || 0), stock, rev: Math.max(1, Math.trunc(v.rev) || 1),
      restockAt: building || v.fence ? Infinity : ctx.now() + RESTOCK_MS,
      ...(v.fence ? { fence: true } : {}),
      ...(building ? { building, stocked: Math.trunc(v.stocked) || 0, stockedLevel: Math.trunc(v.stockedLevel) || 1 } : {}),
      ...(building ? { holds: hydrateHolds(v.holds) } : {}),
    };
  }

  let saveTimer = null;
  function loadShops() {
    if (statePath) {
      try {
        const raw = JSON.parse(readFileSync(statePath, 'utf8'));
        for (const [k, v] of Object.entries(raw?.shops ?? {})) {
          const shop = hydrateShop(v);
          if (shop) shops.set(k, shop);
        }
      } catch { /* no fixture file yet */ }
    }
    // The database wins over a fixture file: it is written atomically with the characters.
    for (const [key, v] of ctx.loadWorld?.(WORLD_PREFIX) ?? []) {
      const shop = hydrateShop(v);
      if (shop) shops.set(key.slice(WORLD_PREFIX.length), shop);
    }
  }
  function saveShopsNow() {
    saveTimer = null;
    if (!statePath) return;
    const out = { v: 1, shops: {} };
    for (const [k, shop] of shops) out.shops[k] = serializeShop(shop);
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(`${statePath}.tmp`, JSON.stringify(out));
      renameSync(`${statePath}.tmp`, statePath);
    } catch (err) {
      ctx.log?.warn?.(`[npcs] could not save shop state: ${err.message}`);
    }
  }
  /** A ledger changed: save it with the current action (or the next periodic save), and the fixture file. */
  function shopChanged(k) {
    const shop = shops.get(k);
    try { services.shopLedgerChanged?.(k); } catch (err) { ctx.log?.warn?.(`[npcs] shop listener: ${err.message}`); }
    if (shop && typeof ctx.dirtyWorld === 'function') ctx.dirtyWorld(WORLD_PREFIX + k, () => serializeShop(shops.get(k) ?? shop));
    if (!statePath || saveTimer) return;
    saveTimer = setTimeout(saveShopsNow, 1000);
    saveTimer.unref?.();
  }
  loadShops();

  /** {name, value} for a template from the equipment catalogue, or null when it is not a real item. */
  function describe(template) {
    if (typeof template !== 'string' || template === 'gold') return null;
    if (typeof services.describeItem === 'function') {
      try {
        const d = services.describeItem(template);
        return d && Number.isFinite(d.value) ? { name: d.name || template, value: Math.max(0, Math.round(d.value)), icon: d.icon } : null;
      } catch {
        return null;
      }
    }
    return ITEM_VALUES[template] ? { ...ITEM_VALUES[template] } : null;
  }

  function itemValue(template, item) {
    const d = describe(template);
    if (d) return d.value;
    if (item && Number.isFinite(item.value) && item.value > 0) return Math.round(item.value);
    return 0;
  }

  const econ = createShopEconomy(ctx, { describe });

  function newShop(kind, now) {
    const stock = new Map();
    for (const [template, qty] of STOCK[kind] || []) {
      const d = describe(template);
      if (!d || d.value <= 0) continue;
      stock.set(template, { template, name: d.name, value: d.value, icon: d.icon, quantity: qty });
    }
    return { kind, purse: MERCHANT_PURSE[kind] ?? 500, stock, rev: 1, restockAt: now + RESTOCK_MS };
  }

  function restock(shop, now) {
    const fresh = newShop(shop.kind, now);
    for (const [k, v] of fresh.stock) {
      const cur = shop.stock.get(k);
      if (!cur) shop.stock.set(k, v);
      else cur.quantity = Math.max(cur.quantity, v.quantity);
    }
    shop.purse = Math.max(shop.purse, fresh.purse);
    shop.restockAt = fresh.restockAt;
    shop.rev++;
  }

  /** Feature-private shop state is restored if the surrounding action fails or cannot be saved. */
  function guardShop(shop) {
    if (typeof ctx.onRollback !== 'function') return;
    const saved = { purse: shop.purse, rev: shop.rev, stock: [...shop.stock].map(([k, v]) => [k, { ...v }]), stocked: shop.stocked, building: shop.building, holds: cloneHolds(shop.holds) };
    ctx.onRollback(() => {
      shop.purse = saved.purse;
      shop.rev = saved.rev;
      shop.stock = new Map(saved.stock);
      shop.holds = saved.holds;
      if (saved.building) {
        shop.stocked = saved.stocked;
        shop.building = saved.building;
      }
    });
  }

  const npcsAt = (location) => [...ctx.entities.values()].filter((e) => e.kind === 'npc' && e.location === location);

  // ------------------------------------------------------------ validation

  function nearNpc(p, args) {
    if (services.conditionBeastForm?.(p)) fail('You get no response in beast form.');
    if (!args || typeof args !== 'object') fail('Talk to whom?');
    const { targetId } = args;
    if (typeof targetId !== 'string' || !ID_RE.test(targetId)) fail('Talk to whom?');
    const e = ctx.entities.get(targetId);
    if (!e || e.kind !== 'npc') fail('There is nobody like that here.');
    if (e.visibleTo != null && !(e.visibleTo instanceof Set ? e.visibleTo.has(p.id) : e.visibleTo.includes?.(p.id))) fail('There is nobody like that here.');
    if (e.location !== p.rpg?.location) fail(`${e.name} is not here.`);
    // Text-action people (RDB opcode 11/12, e.g. the Castle Daggerfall guard) answer only through dungeon.use.
    if (e.actionOnly) fail(`${e.name} has nothing to say to you.`);
    const portal = services.portals?.into?.(e.location);
    if (e.sourced && e.shop && portal && services.buildingAccess?.publicOpen(portal.meta?.buildingType, portal.meta?.regionIndex) === false) {
      fail(`${portal.label} is closed.`);
    }
    const d = Math.hypot(e.x - p.x, e.z - p.z);
    if (!(d <= (e.reach ?? TALK_RANGE))) fail(`You are too far away to talk to ${e.name}.`);
    if (!onSameFloor(p, e)) fail(`${e.name} is on another floor.`);
    return e;
  }

  /** Vertical reach for authored people in stacked interiors and dungeons. */
  function onSameFloor(p, e) {
    if (!Number.isFinite(e.y) || !e.sourced) return true;
    const portal = p.rpg?.portal;
    const foot = portal?.to === p.rpg?.location && Number.isFinite(portal?.footY) ? portal.footY : null;
    if (foot === null) return true;
    const base = e.anchor === 'centre' ? e.y - 1 : e.y;
    return Math.abs(foot - base) <= 1.6; // one storey is 3.225 m in classic interiors
  }

  /** NPC plus the live conversation for mutating commands. Stale tokens are refused. */
  function inSession(p, args) {
    const e = nearNpc(p, args);
    const s = sessions.get(p.id);
    if (!s || s.npcId !== e.id || s.token !== args.session || ctx.now() - s.at > SESSION_TTL_MS) {
      fail('That conversation has ended. Talk to them again.');
    }
    s.at = ctx.now();
    return { e, s };
  }

  function attitude(p, e) {
    if (e.guild && memberAt(p, e)) return 'friendly';
    // TalkManager adds the player's live reaction mods per social group (worn GoodRepWith / BadRepWith / Masque).
    const rep = reputation(p, e.faction) + Math.trunc(reputation(p, REGION_FACTION) / 2)
      + (Number(services.socialReactionModifier?.(p, socialGroup(e))) || 0);
    if (rep >= 10) return 'friendly';
    if (rep > -5) return 'neutral';
    if (rep > HOSTILE_REPUTATION) return 'cold';
    return 'hostile';
  }

  const hostile = (p, e) => attitude(p, e) === 'hostile';
  const mercantile = (p) => skillValue(p.rpg?.character, 'Mercantile');
  const tradeRep = (p, e) => reputation(p, e.faction) + Math.trunc(reputation(p, REGION_FACTION) / 2);

  function equippedIds(p) {
    const eq = p.rpg?.equipment;
    const ids = new Set(eq && typeof eq === 'object' ? Object.values(eq).filter(Boolean) : []);
    for (const it of p.rpg?.inventory || []) if (it?.equipped) ids.add(it.id);
    return ids;
  }

  function sellable(p, e, shop = null) {
    const equipped = equippedIds(p);
    const out = [];
    for (const item of p.rpg?.inventory || []) {
      if (!item || typeof item.id !== 'string' || item.template === 'gold' || item.quest || item.conjuredUntil || equipped.has(item.id)) continue;
      // DaggerfallTradeWindow.storeBuysItemType; a fence takes anything, stolen goods included.
      if ((!shop?.fence && econ.refusal(e, item, shop)) || item.conjuredUntil) continue;
      const value = itemValue(item.template, item);
      if (value <= 0) continue;
      const price = shop ? econ.resaleCap(p, shopLedgerKey(e, shop), item.template, econ.sellUnit(p, e, value, shop)) : econ.sellUnit(p, e, value, shop);
      if (price <= 0) continue;
      out.push({ itemId: item.id, name: item.name || item.template, quantity: Math.max(1, Math.trunc(item.quantity) || 1), price, icon: item.icon, variant: item.variant });
    }
    return out;
  }

  // ------------------------------------------------------------ views

  function view(p, e, text, extra = {}) {
    const s = sessions.get(p.id);
    const role = roleDef(e);
    const att = attitude(p, e);
    const out = {
      kind: 'dialogue',
      silent: true, // the dialogue panel shows the text; no toast
      entityId: e.id,
      name: e.name,
      session: s?.token ?? null,
      npc: { id: e.id, name: e.name, title: e.title, role: e.role, sprite: e.sprite, faction: e.faction },
      text,
      attitude: att,
      topics: att === 'hostile' ? [] : role.topics.map((id) => ({ id, label: TOPIC_LABELS[id] })),
      services: [],
      standing: {
        factionId: e.faction,
        faction: nameOfFaction(e),
        reputation: reputation(p, e.faction),
        region: reputation(p, REGION_FACTION),
      },
      journal: !!(e.questGiver || extra.journal),
      gold: p.rpg.gold,
      ...(s?.spymaster ? { spymaster: true } : {}),
    };
    // "Where is …?": this speaker can name people and buildings of the town (npc.ask).
    if (att !== 'hostile' && places && (e.sourced || e.mobile) && role.topics.includes('directions') && !extra.noAsk) out.ask = true;
    // Tone of voice for information requests (news, rumours, directions, "Where is…").
    if (att !== 'hostile' && (e.sourced || e.mobile) && role.topics.some((t) => INFO_TOPICS.has(t))) {
      out.tone = s?.tone ?? 'normal';
      out.tones = TONES.map((id) => ({ id, label: TONE_LABELS[id] }));
    }
    if (extra.learned?.length) out.learned = extra.learned.map((x) => ({ id: x.id, name: x.name }));
    if (extra.summoning) out.summoning = extra.summoning;
    if (extra.teleport) out.teleport = extra.teleport; // package 15: open the travel map in teleport mode
    if (att !== 'hostile') {
      const G = e.guild ? services.guilds : null;
      for (const id of role.services) {
        if (id === 'join' && e.guild && (memberAt(p, e) || (G && !G.joinOffered(p, e)))) continue;
        if (id === 'train' && e.guild && !(G ? G.tutor(p, e)?.allowed : memberAt(p, e))) continue;
        const svc = { id, label: SERVICE_LABELS[id] ?? id };
        if (id === 'heal') svc.cost = healCost(p, e);
        if (id === 'cure' && G) {
          const quote = G.cureQuote(p, e);
          if (quote.count) svc.cost = quote.cost;
        }
        // Rank-gated services stay visible with the classic refusal (guilds/rules.js serviceAccess).
        const gate = G ? G.access(p, e, id) : null;
        if (gate && !gate.ok) Object.assign(svc, { locked: true, reason: gate.text });
        out.services.push(svc);
      }
      if (role.services.includes('rest') && s?.mode === 'tavern') out.tavern = services.tavern?.view(p);
    }
    if (e.guild) {
      // The hall's own guild: per-deity temple and per-order catalogue from the guilds feature.
      const G = services.guilds;
      const d = G?.describe(p, e) ?? null;
      const tut = G?.tutor(p, e) ?? null;
      const guild = d ? { id: d.group, factionId: d.factionId, training: tut?.allowed ? tut.skills : [], ranks: null } : GUILDS[e.guild];
      const m = d ? (tut?.allowed ? memberAt(p, e) ?? false : null) : membership(p, e.guild);
      out.guild = {
        ...(d ?? {}),
        id: guild.id,
        name: d?.name ?? factionName(guild.factionId),
        factionId: guild.factionId,
        member: d ? d.member : !!m,
        rank: d ? d.rank : m ? m.rank : null,
        rankTitle: d ? d.rankTitle : m ? guild.ranks[m.rank] : null,
        training: (tut?.allowed ?? !!m) ? guild.training.map((skill) => {
          const status = services.characterTraining?.(p, skill, { max: tut?.max ?? 50 });
          return status && { skill, ...status, cost: tut?.price ?? legacyTrainCost(p) };
        }).filter(Boolean) : [],
      };
    }
    if (s?.mode === 'trade' && e.shop && att !== 'hostile') {
      const shop = openShop(e, p);
      const pc = econ.context(p, e, shop);
      out.shop = {
        rev: shop.rev,
        purse: shop.purse,
        quality: pc.quality,
        market: { adjust: pc.adjust, holiday: pc.holiday },
        items: [...shop.stock].filter(([, it]) => it.quantity > 0).map(([key, it]) => ({
          key, name: it.name, quantity: it.quantity, icon: it.icon, variant: it.variant, price: econ.buyUnit(p, e, it, shop),
          ...(Number.isInteger(it.shelf) ? { shelf: it.shelf } : {}),
        })),
        sellable: sellable(p, e, shop),
      };
    } else if (s?.mode === 'fence' && att !== 'hostile') {
      const shop = fenceFor(e);
      out.shop = { rev: shop.rev, purse: shop.purse, fence: true, quality: econ.context(p, e, shop).quality, items: [], sellable: sellable(p, e, shop) };
    }
    // Package 12: this player's own unpaid basket, when this person minds the shop it was picked in (checkout reply).
    if (att !== 'hostile' && e.shop && econ.isBuildingShop(e)) {
      const basket = services.shopBasketFor?.(p, e) ?? null;
      if (basket) out.basket = basket;
    }
    return out;
  }

  function say(p, e, text, extra) {
    const v = view(p, e, text, extra);
    ctx.notify(p, v);
    return v;
  }

  /** Push fresh shop views to everybody else trading with this NPC. */
  function refreshOthers(p, e) {
    for (const [pid, s] of sessions) {
      const other0 = ctx.entities.get(s.npcId);
      if (pid === p.id || !other0 || s.mode !== 'trade' || (s.npcId !== e.id && !(other0.shop && shopKey(other0) === shopKey(e)))) continue;
      const other = ctx.players.get(pid);
      if (other) ctx.notify(other, view(other, other0, s.lastText || ''));
    }
  }

  const vars = (p, e, more = {}) => ({
    player: p.name, name: e.name, place: placeName(e.location), district: e.sourced || e.mobile ? 'town' : districtFor(e.location).label,
    faction: nameOfFaction(e), ...more,
  });
  const pick = (arr, seed) => arr[seed % arr.length];
  const placeName = (location) => {
    const m = /^(?:town|interior|dungeon):[^/]+\/([^/]+)/.exec(String(location));
    return m ? m[1] : parseLocation(location).place;
  };

  // ------------------------------------------------------------ prices

  const legacyTrainCost = (p) => 100 * (p.rpg.character?.level ?? 1);
  function healCost(p, e) {
    const c = p.rpg.character;
    if (!c || !Number.isFinite(c.health) || !Number.isFinite(c.maxHealth)) return 0;
    const missing = Math.max(0, c.maxHealth - c.health);
    if (missing === 0) return 0;
    // Temple.FreeHealing: free only from the deity's healing rank at the member's own temple.
    if (e.guild && (services.guilds ? services.guilds.freeHealingAt(p, e) : membership(p, e.guild))) return 0;
    return Math.max(5, missing * 2);
  }

  function spend(p, amount) {
    if (!Number.isInteger(amount) || amount < 0) fail('Invalid price.');
    if (p.rpg.gold < amount) fail(`You need ${amount} gold.`);
    p.rpg.gold -= amount;
  }

  // ------------------------------------------------------------ lifecycle

  ctx.onJoin((p) => {
    ensureState(p);
    if (p.rpg.location) ensureRoster(p.rpg.location, { retry: true }); // a rejoin retries a place that failed
  });

  ctx.onLeave((p) => {
    sessions.delete(p.id);
    for (const k of patience.keys()) if (k.startsWith(`${p.id}>`)) patience.delete(k);
  });

  ctx.onTick((dt, now) => {
    if (places) places.tick(dt);
    for (const p of ctx.players.values()) {
      const loc = p.rpg?.location;
      if (!places && loc && !spawned.has(loc)) ensureRoster(loc);
      const s = sessions.get(p.id);
      if (!s) continue;
      const e = ctx.entities.get(s.npcId);
      const away = !e || e.location !== loc || Math.hypot(e.x - p.x, e.z - p.z) > (e.reach ?? TALK_RANGE) + 0.5;
      if (away || now - s.at > SESSION_TTL_MS) {
        sessions.delete(p.id);
        ctx.notify(p, { kind: 'dialogue.end', npcId: s.npcId, text: e ? `You leave ${e.name}.` : 'The conversation ends.' });
      }
    }
    for (const [id, shop] of shops) {
      if (now >= shop.restockAt) {
        restock(shop, now);
        shopChanged(id);
        for (const [pid, s] of sessions) {
          const other = ctx.players.get(pid);
          const e = ctx.entities.get(s.npcId);
          if (other && e?.shop && shopKey(e) === id && s.mode === 'trade') ctx.notify(other, view(other, e, s.lastText || ''));
        }
      }
    }
  });

  // ------------------------------------------------------------ actions

  ctx.on('conditionChanged', ({ player: p, change }) => {
    if (change !== 'transformed' || !services.conditionBeastForm?.(p)) return;
    const s = sessions.get(p.id);
    if (!s) return;
    ctx.onRollback?.(() => sessions.set(p.id, s));
    sessions.delete(p.id);
    ctx.notify(p, { kind: 'dialogue.end', npcId: s.npcId, silent: true });
  });

  const questTalk = (p) => (typeof services.quests?.talk === 'function' ? services.quests.talk(p) : null);
  const matchesQuestNpc = (e, who) => (who.entityId && who.entityId === e.id) || (who.individual != null && e.faction === who.individual);

  ctx.onAction('npc.talk', (p, args) => {
    ensureState(p);
    const e = nearNpc(p, args);
    if (questTalk(p)?.muted?.some((m) => matchesQuestNpc(e, m))) fail(`${e.name} has nothing to say to you.`);
    const token = `${(++tokenSeq).toString(36)}.${hash32(`${p.id}:${e.id}:${ctx.now()}`).toString(36)}`;
    sessions.set(p.id, { npcId: e.id, token, at: ctx.now(), mode: 'talk', counter: 0, lastText: '', tone: 'normal', refusals: 0 });
    e.yaw = Math.atan2(p.x - e.x, -(p.z - e.z)); // turn to face the speaker (yaw 0 = -z)
    // Guild.UpdateRank and the hall's arrival benefits apply when the player speaks to the guild's people.
    const hall = e.guild && services.guilds ? services.guilds.greet(p, e) : [];
    const att = attitude(p, e);
    const promoted = e.guild ? checkPromotion(p, e.guild) : null;
    let text = pick(LINES.greet[att], hash32(e.id + p.name));
    if (promoted) text = `${fill(LINES.promote, { rank: promoted })} ${text}`;
    if (hall.length) text = `${hall.join(' ')} ${text}`;
    text = fill(text, vars(p, e));
    sessions.get(p.id).lastText = text;
    ctx.emit('talk', { player: p, entity: e });
    return say(p, e, text);
  });

  ctx.onAction('npc.leave', (p) => {
    const s = sessions.get(p.id);
    sessions.delete(p.id);
    if (s) ctx.notify(p, { kind: 'dialogue.end', npcId: s.npcId, silent: true });
  });

  ctx.onAction('npc.topic', (p, args) => {
    const { e, s } = inSession(p, args);
    const role = roleDef(e);
    const topic = args.topic;
    if (hostile(p, e)) fail(`${e.name} refuses to speak with you.`);
    const qt = questTalk(p);
    if (qt?.muted?.some((m) => matchesQuestNpc(e, m))) fail(`${e.name} has nothing to say to you.`);
    const extraQuestor = !!qt?.questors?.some((q) => matchesQuestNpc(e, q));
    if (typeof topic !== 'string' || (!role.topics.includes(topic) && !(topic === 'work' && extraQuestor))) fail(`${e.name} has nothing to say about that.`);
    s.counter++;
    s.mode = topic === 'trade' ? 'trade' : 'talk';
    const seed = hash32(e.id) + s.counter + Math.floor(ctx.now() / 600_000);
    let text, extra = {};
    const refused = topic !== 'work' && INFO_TOPICS.has(topic) ? reaction(p, e, s, topic) : null;
    if (refused) {
      text = refused;
      extra.noAsk = true;
    } else if (topic === 'news' || topic === 'rumours') {
      const qRumours = topic === 'rumours' && qt?.rumours?.length ? qt.rumours.filter((r) => r.text) : [];
      if (qRumours.length) {
        text = qRumours[seed % qRumours.length].text;
      } else {
        const tale = places && (e.sourced || e.mobile) ? taleFor(p, e, topic) : null;
        if (tale) {
          text = tale.text;
          extra.learned = learnSpecs(p, tale.town, [tale.place.spec]);
        } else text = pick(LINES[topic], seed);
      }
    } else if (topic === 'inn' || (topic === 'directions' && (e.sourced || e.mobile))) {
      const d = directionsFrom(e, topic === 'inn', true);
      text = d.text;
      extra.learned = learnSpecs(p, d.town, d.specs);
    }
    else if (topic === 'directions') {
      // Only people this player can see: another player's private quest NPCs (visibleTo) stay private.
      const seen = (o) => o.visibleTo == null
        || (o.visibleTo instanceof Set ? o.visibleTo.has(p.id) : Array.isArray(o.visibleTo) && o.visibleTo.includes(p.id));
      const others = npcsAt(e.location).filter((o) => o.id !== e.id && seen(o));
      text = others.length
        ? `${others.map((o) => `${o.name} the ${o.title.toLowerCase()} — ${Math.round(Math.hypot(o.x - e.x, o.z - e.z))} m ${compassWord(e.x, e.z, o.x, o.z)}`).join('; ')}.`
        : 'There is nobody else about.';
    } else if (topic === 'organisation') {
      const kind = e.guild ? (e.guild === 'temple' ? 'temple' : 'guild') : FACTIONS[e.faction]?.kind ?? (e.factionName ? 'guild' : null);
      text = LINES.organisation[kind] || LINES.organisation.region;
      const d = e.guild ? services.guilds?.describe(p, e) : null;
      const m = e.guild && memberAt(p, e);
      if (d) {
        if (d.member) text += ` You hold the rank of ${d.rankTitle}.`;
        else if (d.memberElsewhere) text += ` You already serve ${d.memberElsewhere}.`;
        text += ` Your standing with ${d.name}: ${d.reputation}.`;
      } else {
        if (m) text += ` You hold the rank of ${GUILDS[e.guild].ranks[m.rank]}.`;
        text += ` Your standing with ${nameOfFaction(e)}: ${reputation(p, e.faction)}.`;
      }
    } else if (topic === 'work') {
      extra.journal = true;
      if (e.mobile) {
        const r = reaction(p, e, s, 'work');
        const lead = r ? null : workLead(e, p, true);
        text = r ?? lead.text;
        if (lead?.spec) extra.learned = learnSpecs(p, lead.town, [lead.spec]);
        extra.journal = false;
      }
      else if (!e.questGiver && !extraQuestor) text = LINES.work.none;
      else if (e.guild && !extraQuestor && !memberAt(p, e)) { text = LINES.work.outsider; extra.journal = false; }
      else {
        text = e.guild ? LINES.work.member : LINES.work.giver;
        ctx.emit('npcWork', { player: p, entity: e });
      }
    } else if (topic === 'trade') {
      text = LINES.trade.open;
    }
    text = fill(text, vars(p, e));
    s.lastText = text;
    return say(p, e, text, extra);
  });

  ctx.onAction('npc.buy', (p, args) => {
    ensureState(p);
    const { e, s } = inSession(p, args);
    const shop = e.shop ? openShop(e, p) : null;
    if (!shop || s.mode !== 'trade') fail(`${e.name} is not trading with you right now.`);
    if (hostile(p, e)) fail(LINES.trade.refuse);
    const it = typeof args.key === 'string' ? shop.stock.get(args.key) : null;
    const qty = args.quantity ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) fail('Choose a quantity between 1 and 99.');
    if (!it || it.quantity < 1) fail('That is no longer for sale.');
    if (it.quantity < qty) fail(`${e.name} only has ${it.quantity} left.`);
    const unit = econ.buyUnit(p, e, it, shop);
    if (args.price !== unit) fail('The price has changed. Look again.');
    const total = unit * qty;
    const spendable = typeof services.spendableGold === 'function' ? services.spendableGold(p) : p.rpg.gold; // gold + letters of credit
    if (spendable < total) fail(`You need ${total} gold for that.`);
    if (typeof services.giveItem !== 'function') fail('Trading is unavailable right now.');
    guardShop(shop);
    services.giveItem(p, it.template, qty, { variant: it.variant, ...(it.extra ? { extra: it.extra } : {}) }); // throws (and changes nothing) if the catalogue or pack refuses
    if (typeof services.spendGold === 'function') services.spendGold(p, total);
    else p.rpg.gold -= total;
    shop.purse += total;
    it.quantity -= qty;
    shop.rev++;
    shopChanged(shopKey(e));
    econ.rememberPurchase(p, shopKey(e), it.template, unit);
    services.advanceSkill?.(p, 'Mercantile', 1); // DaggerfallTradeWindow: TallySkill(Mercantile, 1) per completed trade
    const text = `${qty > 1 ? `${qty} × ` : ''}${it.name} for ${total} gold. Pleasure doing business.`;
    s.lastText = text;
    refreshOthers(p, e);
    return say(p, e, text);
  });

  ctx.onAction('npc.sell', (p, args) => {
    ensureState(p);
    const { e, s } = inSession(p, args);
    const shop = s.mode === 'fence' ? fenceFor(e) : e.shop && s.mode === 'trade' ? openShop(e, p) : null;
    if (!shop) fail(`${e.name} is not trading with you right now.`);
    if (hostile(p, e)) fail(LINES.trade.refuse);
    const qty = args.quantity ?? 1;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) fail('Choose a quantity between 1 and 99.');
    const item = (p.rpg.inventory || []).find((i) => i && i.id === args.itemId);
    if (!item) fail('You no longer have that.');
    if (equippedIds(p).has(item.id)) fail('Unequip it first.');
    if (item.quest || item.conjuredUntil || item.template === 'gold') fail(`${e.name} will not take that.`);
    const refused = shop.fence ? (item.conjuredUntil ? `${e.name} will not buy something that will fade away.` : null) : econ.refusal(e, item, shop);
    if (refused) fail(refused);
    const have = Math.max(1, Math.trunc(item.quantity) || 1);
    if (have < qty) fail(`You only have ${have}.`);
    const value = itemValue(item.template, item);
    const unit = value > 0 ? econ.resaleCap(p, shopLedgerKey(e, shop), item.template, econ.sellUnit(p, e, value, shop)) : 0;
    if (unit <= 0) fail(`${e.name} has no interest in that.`);
    if (args.price !== unit) fail('The offer has changed. Look again.');
    const total = unit * qty;
    if (shop.purse < total) fail(`${e.name} cannot afford that right now.`);
    if (typeof services.takeItem !== 'function') fail('Trading is unavailable right now.');
    const name = item.name || item.template;
    guardShop(shop);
    services.takeItem(p, item.id, qty); // throws (and changes nothing) if invalid
    p.rpg.gold += total;
    shop.purse -= total;
    const variant = item.variant;
    const customVariant = Number.isInteger(variant) && (variant !== 0 || item.group === 'armor');
    // Real shops keep bought goods on the counter until the shelves are re-stocked (classic clears them then).
    const key = `${shop.building || shop.fence ? 'sold:' : ''}${customVariant ? `${item.template}:${variant}` : item.template}`;
    const cur = shop.stock.get(key);
    if (cur) cur.quantity += qty;
    else shop.stock.set(key, { template: item.template, name, value, icon: item.icon, variant, quantity: qty });
    shop.rev++;
    shopChanged(shopKey(e));
    services.advanceSkill?.(p, 'Mercantile', 1); // DaggerfallTradeWindow: TallySkill(Mercantile, 1) per completed trade
    const text = `I will give you ${total} gold for ${qty > 1 ? `${qty} × ` : ''}${name}. Done.`;
    s.lastText = text;
    refreshOthers(p, e);
    return say(p, e, text);
  });

  ctx.onAction('npc.service', (p, args) => {
    ensureState(p);
    const { e, s } = inSession(p, args);
    const role = roleDef(e);
    const id = args.service;
    if (typeof id !== 'string' || !role.services.includes(id)) fail(`${e.name} does not offer that.`);
    if (hostile(p, e)) fail(`${e.name} refuses to deal with you.`);
    s.mode = 'talk';
    const c = p.rpg.character;
    const G = e.guild ? services.guilds : null;
    // The hall's own catalogue (per-deity temple skills); legacy table without the guilds feature.
    const tut = G?.tutor(p, e) ?? null;
    const guild = !e.guild ? null : tut ? { id: tut.group, factionId: G.describe(p, e).factionId, training: tut.skills, ranks: [] } : GUILDS[e.guild];
    let text;

    // Rank gate (Guild.CanAccessService): members-only and insufficient-rank refusals come back as a reply.
    const gate = G && id !== 'join' ? G.access(p, e, id) : null;
    if (gate && !gate.ok) {
      s.lastText = gate.text;
      return say(p, e, gate.text);
    }
    // Specialist services owned by other features (package 16 potions/items/identify, 19 summoning, ...).
    const info = { npcId: e.id, session: s.token, name: e.name, guild: e.guild ?? null, factionId: e._source?.factionId ?? e.faction,
      hallFactionId: e.building?.factionId ?? null, quality: e.building?.quality ?? null, rank: e.guild ? (memberAt(p, e)?.rank ?? -1) : -1, say: (t, x) => say(p, e, t, x),
      // Package 15 spymaster: TalkManager.isSpyMaster for the rest of this conversation.
      markSpymaster: () => { s.spymaster = true; } };
    if (id === 'summon') {
      if (!services.daedraSummon) fail('No one here can summon the Daedra.');
      const out = services.daedraSummon(p, e, args);
      return say(p, e, out.text, { summoning: out.step === 'confirm' ? { cost: out.cost } : null });
    }
    const ext = services.npcServiceHandlers?.[id];
    if (ext) {
      const out = ext(p, info, args);
      if (out?.endConversation) {
        // The service took the player away (package 15 guild teleport): the conversation ends with a plain message.
        sessions.delete(p.id);
        ctx.notify(p, { kind: 'dialogue.end', npcId: e.id, silent: true });
        if (out.text) ctx.notify(p, { kind: 'guild', text: out.text });
        return { ok: true, text: out.text ?? null };
      }
      return typeof out === 'string' ? say(p, e, out) : out;
    }

    if (id === 'sellItems') {
      // ThievesGuild.CanAccessService(SellMagicItems): rank 2 or higher. The fence buys anything, stolen goods included.
      const m = memberAt(p, e) ?? membership(p, 'thieves');
      if (!m || !(m.rank >= FENCE_RANK)) fail(`${e.name} only deals with trusted members of the guild.`);
      s.mode = 'fence';
      text = 'Show me what you have. No questions asked.';
    } else if (id === 'bank' || id === 'repair') {
      // The counters are the town-services feature's (server/rpg/townServices.js); point the panel at them.
      const counter = e.location.startsWith('interior:') ? (/\/(\d+),(\d+)\/(\d+)$/.exec(e.location) ?? []).slice(1).join(',') : null;
      const counterId = counter ? `b:${counter.replace(/,(\d+)$/, ':$1')}` : null;
      ctx.notify(p, { kind: 'townServices.offer', counterId, services: [id], text: id === 'bank' ? `${e.name} can manage your account (Bank & Repairs).` : `${e.name} can repair your weapons and armour (Bank & Repairs).` });
      text = id === 'bank' ? 'Your accounts are in order. What would you like to do?' : 'Leave it with me and come back when it is ready.';
    } else if (id === 'join' && G) {
      text = G.join(p, e).text;
    } else if (id === 'join') {
      if (!c) text = LINES.join.noCharacter;
      else if (membership(p, guild.id)) text = fill(LINES.join.already, { rank: guild.ranks[membership(p, guild.id).rank] });
      else {
        const rep = reputation(p, guild.factionId);
        const el = eligibleToJoin(c, guild, rep);
        if (el.ok) {
          const rank = rankFor(c, guild, rep);
          p.rpg.guilds[guild.id] = { rank, joinedAt: new Date().toISOString() };
          adjustReputation(p, guild.factionId, rep < 0 ? 0 : 1);
          text = fill(LINES.join.welcome, { faction: factionName(guild.factionId), rank: guild.ranks[rank], player: p.name });
          ctx.emit('guildJoin', { player: p, guild: guild.id, factionId: guild.factionId });
        } else if (el.badRep) text = LINES.join.badRep;
        else text = fill(LINES.join.lowSkill, { skills: suggestSkills(c, guild).join(' or ') });
      }
    } else if (id === 'train') {
      if (!(tut?.allowed ?? !!membership(p, guild.id))) fail(tut?.reason ?? 'Only members may train here.');
      const skill = args.skill;
      if (typeof skill !== 'string' || !guild.training.includes(skill)) fail(`${tut?.name ?? factionName(guild.factionId)} does not teach that.`);
      const max = tut?.max ?? 50;
      const status = services.characterTraining?.(p, skill, { max });
      if (!status || status.reason === 'unavailable') fail('Training is unavailable right now.');
      if (status.reason === 'cap') fail(`You have learned all we can teach in ${skill}.`);
      if (status.reason === 'cooldown') fail(`You are too tired to train again. Wait ${status.minutesLeft} game minutes.`);
      const cost = tut?.price ?? legacyTrainCost(p);
      if (p.rpg.gold < cost) fail(`Training costs ${cost} gold.`);
      if (!services.characterTraining(p, skill, { max, commit: true }).ok) fail('Training is unavailable right now.');
      p.rpg.gold -= cost;
      text = `${LINES.train} (${skill}, ${cost} gold)`;
    } else if (id === 'heal') {
      if (!c || !Number.isFinite(c.health) || !Number.isFinite(c.maxHealth)) fail('Create your character first.');
      const cost = healCost(p, e);
      if (c.health >= c.maxHealth) text = LINES.heal.unneeded;
      else {
        spend(p, cost);
        c.health = c.maxHealth;
        text = LINES.heal.done + (cost ? ` (${cost} gold)` : '');
      }
    } else if (id === 'donate') {
      // Classic donation (DaggerfallGuildServiceDonation): the gold is given; the deity's standing may rise by one.
      const amount = args.amount === undefined ? 100 : args.amount;
      if (!Number.isInteger(amount) || amount < 1 || amount > 1_000_000) fail('Choose how much gold to give.');
      spend(p, amount);
      const given = G ? G.donate(p, e, amount) : null;
      if (!G) adjustReputation(p, e.faction, 2);
      text = given?.blessing ? `${LINES.donate} ${given.blessing}` : LINES.donate; // Temple.Blessing (package 15)
    } else if (id === 'cure') {
      if (!G || typeof services.cureCondition !== 'function') fail('The healers cannot cure diseases right now.');
      const q = G.cureQuote(p, e);
      if (!q.count) text = 'You carry no disease we can find.';
      else {
        if (args.cost !== undefined && args.cost !== q.cost) fail('The price has changed. Look again.');
        spend(p, q.cost);
        const n = services.cureCondition(p, 'disease');
        text = `${q.cost ? `For ${q.cost} gold, the` : 'In honour of the day, the'} priests pray over you. ${n > 0 ? 'The sickness leaves you.' : 'Nothing seems to change.'}`;
      }
    } else if (id === 'armor') {
      const r = G.receiveArmor(p, e, args.piece);
      text = r.text;
      if (r.offer) {
        s.lastText = text;
        return { ...say(p, e, text), armorOffer: r.offer };
      }
    } else if (['spells', 'magicItems', 'makeItems', 'potions', 'makePotions', 'soulgems', 'teleport', 'identify', 'sellItems', 'spymaster', 'house'].includes(id)) {
      text = `${e.name} cannot offer that service yet.`;
    } else if (id === 'rest') {
      if (!services.tavern) fail('Room and board are unavailable.');
      text = services.tavern.serve(p, e, args);
      s.mode = 'tavern';
    }
    if (guild) {
      const promoted = checkPromotion(p, guild.id);
      if (promoted) text += ` ${fill(LINES.promote, { rank: promoted })}`;
    }
    text = fill(text, vars(p, e));
    s.lastText = text;
    return say(p, e, text);
  });

  // ------------------------------------------------------------ cross-domain

  const onQuestDone = (ev) => {
    const p = ev?.player;
    if (!p || !p.rpg) return;
    const fid = ev.factionId ?? ev.quest?.factionId;
    const amount = Number.isFinite(ev.reputation) ? ev.reputation : 5;
    // Quest success moves the questor's whole faction hierarchy (PersistentFactionData.ChangeReputation propagate).
    if (FACTIONS[fid] || services.isFaction?.(Number(fid))) adjustReputation(p, fid, amount, { propagate: true });
    adjustReputation(p, REGION_FACTION, 1);
    for (const g of Object.keys(p.rpg.guilds || {})) checkPromotion(p, g);
    ctx.dirty?.(p);
  };
  ctx.on?.('questCompleted', onQuestDone);
  ctx.on?.('questComplete', onQuestDone);
  // Quest.EndQuest: a failed ordinary job costs its Quest.FactionId 2 (QuestFailureRep), propagated the same way.
  ctx.on?.('questFailed', (ev) => {
    const p = ev?.player;
    const fid = ev?.factionId ?? ev?.quest?.factionId;
    if (!p?.rpg || !Number.isFinite(ev?.reputation) || ev.reputation >= 0) return;
    if (FACTIONS[fid] || services.isFaction?.(Number(fid))) {
      adjustReputation(p, fid, ev.reputation, { propagate: true });
      ctx.dirty?.(p);
    }
  });

  ctx.on?.('kill', (ev) => {
    const p = ev?.player;
    const m = ev?.entity;
    if (!p?.rpg || !m || m.kind !== 'monster' || !hasRoster(p.rpg.location)) return;
    // Clearing threats inside town earns modest standing with the court, capped at 20.
    if (reputation(p, REGION_FACTION) < 20) {
      adjustReputation(p, REGION_FACTION, 1);
      ctx.dirty?.(p);
    }
  });

  // Arrival readiness (runtime `readiness` in every snapshot): a place's people count as ready only once the
  // tick has published them into ctx.entities, so the snapshot that says 'ready' is the one that carries them.
  // A loaded place with no one in it (empty, or a closed building) is 'ready' with people: 0.
  ctx.readiness?.('npcs', (location) => {
    if (!places) return { status: 'ready', people: rosterFor(location).length, source: 'roster' };
    const pl = places.places.get(location);
    if (!pl) return parsePlace(location) ? { status: 'loading' } : { status: 'ready', people: 0, source: 'none' };
    if (pl.status === 'failed') return { status: 'failed', error: pl.error };
    if (pl.status !== 'ready' || pl.day === null) return { status: 'loading' };
    return { status: 'ready', people: pl.entities.size };
  });

  /**
   * Shop ledgers for the shelf feature (server/rpg/economy.js): the keeper of a location's shop, the ledger with today's
   * shelf stock, and the same guard/save/refresh hooks the counter uses, so a shelf purchase and a counter purchase write
   * the same `npcshop:` row in the same transaction.
   */
  services.shopLedger = {
    keeperAt: (location) => [...ctx.entities.values()].find((e) => e.kind === 'npc' && e.location === location && e.shop && econ.isBuildingShop(e)) ?? null,
    open: (e, p) => openShop(e, p),
    key: (e) => shopKey(e),
    guard: (shop) => guardShop(shop),
    changed: (e) => shopChanged(shopKey(e)),
    refresh: (p, e) => refreshOthers(p, e),
    economy: econ,
    /** Package 12 baskets: the building ledger of `location` if it exists (never created here). */
    peek: (location) => shops.get(`shop:${location}`) ?? null,
    /** [location, ledger] of every building ledger holding goods in somebody's basket. */
    withHolds: () => [...shops].filter(([k, s]) => k.startsWith('shop:') && s.holds?.size).map(([k, s]) => [k.slice(5), s]),
    /** Save (and refresh) the ledger of `location` after a change made without a keeper at hand. */
    changedAt: (location) => shopChanged(`shop:${location}`),
    /** Package 12 checkout in conversation: the shopkeeper of a live, non-hostile session `{targetId, session}`. */
    talking(p, args) {
      const { e } = inSession(p, args);
      if (hostile(p, e)) fail(LINES.trade.refuse);
      return e;
    },
    /** Re-sends `p`'s conversation with `e` (if any), with `text` as their new line, so the checkout reply follows. */
    talkBack(p, e, text = null) {
      const s = sessions.get(p.id);
      if (!s || !e || s.npcId !== e.id) return;
      if (text) s.lastText = text;
      ctx.notify(p, view(p, e, s.lastText || ''));
    },
  };
  services.shopEconomy = econ;

  Object.assign(services, {
    /**
     * The shelves of the shop building `location` (package 14 shoplifting): the same shared ledger the shopkeeper sells
     * from, also while the shop is closed and nobody minds it. take() removes stock inside the current action (rolled
     * back and saved with it). Null when `location` is not a shop.
     */
    shopShelf(location) {
      const key = `shop:${location}`;
      let shop = shops.get(key);
      if (!shop) {
        const keeper = npcsAt(location).find((e) => e.shop && e.sourced);
        const type = services.portals?.into?.(location)?.meta?.buildingType;
        const kind = keeper?.shop ?? SHOP_KIND[type];
        if (!kind || kind === 'inn' || !STOCK[kind]) return null;
        // A real shop building gets its classic shelf ledger (package 12), even when nobody is minding it.
        const meta = services.portals?.into?.(location)?.meta;
        const owner = keeper ?? { location, shop: kind, sourced: true, building: { type, quality: meta?.quality } };
        shop = econ.isBuildingShop(owner) ? econ.newBuildingLedger(owner, MERCHANT_PURSE[kind] ?? 500) : newShop(kind, ctx.now());
        shops.set(key, shop);
        shopChanged(key);
      }
      if (shop.kind === 'inn') return null;
      if (shop.building) {
        const owner = npcsAt(location).find((e) => e.shop && e.sourced) ?? { location, shop: shop.kind, sourced: true, building: shop.building };
        if (econ.stockIfDue(shop, owner, null, MERCHANT_PURSE[shop.kind] ?? 500)) shopChanged(key);
      }
      return {
        kind: shop.kind,
        quality: shop.building?.quality ?? null, // shop quality for CalculateShopliftingChance
        items: [...shop.stock].map(([k, it]) => ({
          key: k, name: it.name, quantity: it.quantity, value: it.value, icon: it.icon, variant: it.variant,
          weight: services.describeItem?.(it.template)?.weight ?? 0,
          ...(Number.isInteger(it.shelf) ? { shelf: it.shelf } : {}),
        })),
        take(k, qty = 1) {
          const it = shop.stock.get(k);
          if (!it || !Number.isInteger(qty) || qty < 1 || it.quantity < qty) fail('That is not on the shelves.');
          guardShop(shop);
          it.quantity -= qty;
          shop.rev++;
          shopChanged(key);
          return { template: it.template, name: it.name, value: it.value, variant: it.variant, ...(it.extra ? { extra: it.extra } : {}) };
        },
      };
    },
    /** Validates {targetId, session} for a follow-up action of a guild/specialist service (packages 9, 16, 19). */
    requireNpcService(p, args, serviceId) {
      const { e, s } = inSession(p, args);
      if (!roleDef(e).services.includes(serviceId) || hostile(p, e)) fail(`${e.name} does not offer that.`);
      const gate = e.guild ? services.guilds?.access(p, e, serviceId) : null;
      if (gate && !gate.ok) fail(gate.text);
      return { npcId: e.id, session: s.token, name: e.name, guild: e.guild ?? null, factionId: e._source?.factionId ?? e.faction,
        hallFactionId: e.building?.factionId ?? null, quality: e.building?.quality ?? null, rank: e.guild ? (memberAt(p, e)?.rank ?? -1) : -1 };
    },
    reputation,
    adjustReputation,
    guildMembership: membership,
    // The guilds feature (installed after this one) replaces guildRank with the per-hall version.
    guildRank: (p, guildId) => membership(p, guildId)?.rank ?? null,
    npcsAt: (location) => {
      ensureRoster(location);
      return npcsAt(location);
    },
    npcSessions: () => [...sessions.values()].map((s) => s.npcId),
    npcs: {
      nearNpc,
      /** Source-backed people of a location, loading them if needed (bounded active-location cache). */
      peopleAt: async (location) => {
        if (!places) return rosterFor(location);
        await places.ready(location);
        return [...(places.places.get(location)?.entities.values() ?? [])];
      },
      workAt: async (town, playerId) => {
        await places?.ready(town);
        return places?.workAt(town, playerId) ?? [];
      },
      status: (location) => (places ? places.status(location) : { status: 'roster' }),
      ready: (location) => (places ? places.ready(location) : Promise.resolve()),
      questSpawn: async (location) => (await markersOf(location))?.spawn ?? [],
      questItemMarkers: async (location) => (await markersOf(location))?.item ?? [],
      individualHome,
      setIndividualAway: (factionId, playerId, isAway = true) => places?.setIndividualAway(factionId, playerId, isAway),
      setPersonAway: (entityId, playerId, isAway = true) => places?.setPersonAway(entityId, playerId, isAway),
      isPersonAway: (entityId, playerId) => !!places?.isPersonAway(entityId, playerId),
      resolve: resolveLegacy,
      describe: (id) => {
        const e = ctx.entities.get(id);
        return e?.kind === 'npc' ? { id: e.id, location: e.location, x: e.x, y: e.y, z: e.z, anchor: e.anchor, sprite: e.sprite, source: e._source ?? null, grounded: e._grounded ?? null } : null;
      },
      source: peopleSource,
    },
  });

  // ------------------------------------------------------------ source adapters

  async function markersOf(location) {
    if (!peopleSource) return null;
    const kind = String(location).split(':')[0];
    if (kind === 'interior') return (await peopleSource.interior(location)).markers;
    if (kind === 'dungeon') return (await peopleSource.dungeon(location)).markers;
    return null;
  }

  /** Where an individual's authored record stands (first match), or null when the data places them nowhere. */
  let individualIndex = null;
  async function individualHome(factionId) {
    if (!peopleSource || !Number.isInteger(factionId)) return null;
    individualIndex ??= options.individualIndex ?? null;
    if (individualIndex?.has?.(factionId)) return individualIndex.get(factionId);
    for (const pl of places?.places.values() ?? []) {
      const e = pl.data?.people?.find((x) => x.individual && x.faction === factionId);
      if (e) return { location: e.location, entityId: e.id };
    }
    return null;
  }

  /**
   * Legacy roster ids (`npc:<hash>:<slot>`, saved in quests/repairs before source people existed) -> the source
   * person who now plays that part in the same town, or null. Never spawns a stand-in.
   */
  async function resolveLegacy(id, location) {
    if (typeof id !== 'string') return null;
    if (ctx.entities.has(id)) return { id, location: ctx.entities.get(id).location };
    if (!places || typeof location !== 'string') return null;
    const town = places.exteriorOf(location);
    if (!town) return null;
    const legacy = rosterFor(town).find((n) => n.id === id);
    if (!legacy) return null;
    const wantType = { merchant: [9], smith: [2, 13], herbalist: [0], bowyer: [13], innkeeper: [15], fighters: [11], mages: [11], priest: [14] }[legacy.role];
    const t = await peopleSource.town(town);
    const { region, location: ln } = /^town:(?<region>[^/]+)\/(?<location>.+)$/.exec(town).groups;
    const candidates = [];
    for (const b of t.buildings) {
      if (!b.people) continue;
      if (wantType && !wantType.includes(b.buildingType)) continue;
      candidates.push(`interior:${region}/${ln}/${b.bx},${b.by}/${b.record}`);
    }
    for (const loc of candidates) {
      const i = await peopleSource.interior(loc);
      const match = i.people.find((e) => {
        if (legacy.role === 'crier' || legacy.role === 'noble') return !!e._workGroup;
        if (legacy.shop) return !!e.shop;
        if (legacy.guild) return e.guild === legacy.guild && (e.services ?? []).includes('train');
        return false;
      });
      if (match) return { id: match.id, location: match.location, role: legacy.role, legacy: id };
    }
    return null;
  }

  // ------------------------------------------------------------ town talk (mobile people, directions)

  function nearestEntrance(spec, from) {
    let nearest = null;
    for (const door of spec.entrances) {
      const distance = Math.hypot(door.x - from.x, door.z - from.z);
      if (!nearest || distance < nearest.distance) nearest = { door, distance };
    }
    return nearest;
  }

  function direction(from, { door, distance }) {
    return `${Math.round(distance)} m ${compass(from.x, from.z, door.x, door.z)}`;
  }

  function buildingPhrase(spec) {
    return spec.meta?.buildingName || `the ${spec.label.toLowerCase()}`;
  }

  /** Interiors of a town kept off public directions (Thieves Guild / Dark Brotherhood halls, covens). */
  /** `null` while the town's directory is unknown: callers then leave every guild hall out (fail closed). */
  const secretHalls = (town) => places?.directoryAt(town, null)?.secretHalls ?? null;
  const isSecret = (secret, spec) => (secret ? secret.has(spec.to) : spec.meta?.buildingType === 11);

  /** Measure from the speaker outdoors, or from their building's street door when asked inside. */
  function directionsFrom(e, innOnly = false, detail = false) {
    const out = (text, named = []) => (detail ? { text, town, specs: named } : text);
    const town = places?.exteriorOf(e.location);
    const specs = services.portals?.at?.(town) ?? [];
    if (!specs.length) return out('I could not tell you the way just now.');
    const outside = e.location === town;
    const home = outside ? null : specs.find(sp => sp.to === e.location);
    const secret = secretHalls(town);
    const from = outside ? e : home?.entrances[0];
    if (!from) return out('I could not tell you the way from here.');
    const best = new Map();
    for (const spec of specs) {
      if (spec.kind !== 'building' || !spec.entrances?.length) continue;
      if (isSecret(secret, spec) && home?.id !== spec.id) continue; // underworld halls are never pointed out
      const type = spec.meta?.buildingType;
      if (innOnly && type !== 15) continue;
      const kind = type == null ? spec.label : buildingTypeName(type);
      if (kind.startsWith('House') || kind === 'Building') continue;
      const next = nearestEntrance(spec, from);
      if (!best.has(kind) || next.distance < best.get(kind).distance) best.set(kind, { spec, ...next });
    }
    const hits = [...best.values()].sort((a, b) => a.distance - b.distance).slice(0, 6);
    const lines = hits.map(hit => {
      const name = buildingPhrase(hit.spec);
      if (home?.id === hit.spec.id) return `You're in ${name}.`;
      const subject = name[0].toUpperCase() + name.slice(1);
      return `${subject} is ${direction(from, hit)}${outside ? '' : ' from our street door'}.`;
    });
    return out(lines.join(' ') || (innOnly ? 'There is no inn in this settlement.' : 'There is not much to see here.'),
      hits.filter((h) => h.spec.meta?.buildingName && home?.id !== h.spec.id).map((h) => h.spec));
  }

  // ------------------------------------------------------------ "Where is …?" (named people and buildings)

  const FLOOR = 3.225; // one storey in classic interiors
  const clean = normaliseQuery;

  /**
   * What this speaker can direct this player to: public named buildings with a surveyed street door and the named
   * adults standing in them. Never another player's private quest people, underworld halls or an individual the
   * player's own quest has placed elsewhere. `null` without source data (legacy roster towns).
   */
  function askableSubjects(p, e) {
    if (!places || !(e.sourced || e.mobile)) return null;
    const town = places.exteriorOf(e.location);
    const dir = town && places.directoryAt(town, p.id);
    if (!dir) return null;
    const specs = (services.portals?.at?.(town) ?? []).filter((sp) => sp.kind === 'building' && sp.entrances?.length && !dir.secretHalls.has(sp.to));
    const doors = new Map(specs.map((sp) => [sp.to, sp]));
    const out = [];
    for (const sp of specs) {
      const type = sp.meta?.buildingType;
      const kind = type == null ? sp.label : buildingTypeName(type);
      if (kind.startsWith('House') || kind === 'Building') continue;
      out.push({ id: `b:${sp.id}`, kind: 'place', label: sp.meta?.buildingName || sp.label, hint: kind, spec: sp, type });
    }
    for (const r of dir.people) {
      const sp = doors.get(r.interior);
      if (!sp) continue;
      out.push({ id: `p:${r.id}`, kind: 'person', label: r.name, hint: `${r.title} · ${sp.meta?.buildingName || sp.label}`, spec: sp, person: r, type: r.buildingType });
    }
    return { town, list: out };
  }

  /** Where the speaker measures from: themselves outdoors, else their building's street door. */
  function origin(e, town) {
    if (e.location === town) return { at: e, outside: true, home: null };
    const home = (services.portals?.at?.(town) ?? []).find((sp) => sp.to === e.location) ?? null;
    return { at: home?.entrances?.[0] ?? null, outside: false, home };
  }

  const ahead = (yaw, fx, fz, tx, tz) => {
    let d = Math.atan2(tx - fx, -(tz - fz)) - (Number.isFinite(yaw) ? yaw : 0);
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const a = Math.abs(d) * 180 / Math.PI;
    if (a <= 30) return 'straight ahead';
    if (a >= 150) return 'behind';
    return `${a < 70 ? 'ahead and ' : a > 110 ? 'behind and ' : ''}to the ${d > 0 ? 'right' : 'left'}`;
  };
  const storey = (dy) => (dy > FLOOR / 2 ? (dy > FLOOR * 1.5 ? `${Math.round(dy / FLOOR)} floors up` : 'upstairs') : dy < -FLOOR / 2 ? 'downstairs' : '');

  /** Inside the target's building, from the door you came in by (its inward landing and facing). */
  function insideGuide(door, r) {
    const land = door?.enter;
    if (!land) return '';
    const dist = Math.round(Math.hypot(r.x - land.x, r.z - land.z));
    const up = storey((r.y ?? 0) - (land.y ?? 0));
    const where = dist <= 2 ? 'just inside the door' : `about ${dist} m ${ahead(land.yaw, land.x, land.z, r.x, r.z)} as you come in`;
    return up ? `${where}, ${up}` : where;
  }

  function answerAsk(p, e, subj, town, s = null) {
    const hour = Number.isFinite(services.worldClock?.()?.minutes) ? Math.floor(services.worldClock().minutes / 60) % 24 : 12;
    const name = subj.kind === 'person' ? subj.person.name : subj.label;
    const place = subj.spec.meta?.buildingName || `the ${subj.spec.label.toLowerCase()}`;
    const shut = subj.type != null && !presentAt(subj.type, hour);
    const { at, outside, home } = origin(e, town);
    // Already standing in the right building: guide from the player, relative to the way they face.
    if (home && home.id === subj.spec.id && p.rpg?.location === e.location) {
      if (subj.kind === 'place') return `You're in ${place} now.`;
      const r = subj.person;
      if (r.id === e.id) return 'You are speaking with me.';
      const live = ctx.entities.get(r.id);
      const tx = live?.x ?? r.x, tz = live?.z ?? r.z, ty = live?.y ?? r.y;
      const foot = p.rpg?.portal?.to === e.location && Number.isFinite(p.rpg.portal.footY) ? p.rpg.portal.footY : e.y ?? 0;
      const up = storey((ty ?? 0) - foot);
      const dist = Math.round(Math.hypot(tx - p.x, tz - p.z));
      if (shut || !live) return `${name} is not about just now. Try again in daylight hours.`;
      return `${name} is here, about ${dist} m ${ahead(p.yaw, p.x, p.z, tx, tz)}${up ? `, ${up}` : ''}.`;
    }
    if (!at) return 'I could not tell you the way from here.';
    const near = nearestEntrance(subj.spec, at);
    // A guild spymaster knows every answer (TalkManager.GetNPCKnowledgeAboutItem: npcData.isSpyMaster).
    if (!s?.spymaster && !knows(e, subj, { distance: near?.distance ?? Infinity, homeInterior: outside ? null : e.location })) return { text: unknownLine(e, subj, name), unknown: true };
    const way = `${direction(at, near)}${outside ? '' : ' from our street door'}`;
    let text;
    if (subj.kind === 'place') {
      const subject = place[0].toUpperCase() + place.slice(1);
      text = `${subject} is ${way}.`;
    } else {
      const inside = insideGuide(near.door, subj.person); // the same door the bearing points at
      text = `${name} the ${subj.person.title.toLowerCase()} keeps to ${place}. Its door is ${way}${inside ? `; inside, look ${inside}` : ''}.`;
    }
    if (shut) text += subj.kind === 'person' ? ' They will not be there at this hour.' : ' It is shut at this hour.';
    return text;
  }

  const ASK_LIMIT = 8;
  ctx.onAction('npc.ask', (p, args) => {
    const { e, s } = inSession(p, args);
    if (hostile(p, e)) fail(`${e.name} refuses to speak with you.`);
    if (!roleDef(e).topics.includes('directions')) fail(`${e.name} has nothing to say about that.`);
    const subjects = askableSubjects(p, e);
    if (!subjects) fail(`${e.name} cannot point you to anyone in particular.`);
    if (args.subject != null) {
      if (typeof args.subject !== 'string' || args.subject.length > 90) fail('Ask about whom?');
      const subj = subjects.list.find((x) => x.id === args.subject);
      if (!subj) fail(`${e.name} has never heard of them.`);
      s.counter++;
      s.mode = 'talk';
      const refused = reaction(p, e, s, 'ask');
      const answer = refused ?? answerAsk(p, e, subj, subjects.town, s);
      const text = typeof answer === 'string' ? answer : answer.text;
      const learned = refused || answer?.unknown || p.rpg?.location === subj.spec.to ? [] : learnSpecs(p, subjects.town, [subj.spec]);
      s.lastText = text;
      return say(p, e, text, { learned });
    }
    const q = clean(typeof args.query === 'string' ? args.query.slice(0, 40) : '');
    const words = q ? q.split(' ') : [];
    const { at } = origin(e, subjects.town);
    const ref = at ?? e;
    const scored = [];
    for (const x of subjects.list) {
      // Every typed word starts a word of the name (or of its title and building); name matches rank first.
      const own = clean(x.label).split(' '), all = [...own, ...clean(x.hint).split(' ')];
      if (!words.every((w) => all.some((h) => h.startsWith(w)))) continue;
      const starts = words.every((w) => own.some((h) => h.startsWith(w))) ? 0 : 1;
      const d = nearestEntrance(x.spec, ref)?.distance ?? Infinity;
      scored.push({ x, starts, d });
    }
    scored.sort((a, b) => a.starts - b.starts || (a.x.kind === b.x.kind ? 0 : a.x.kind === 'place' ? -1 : 1) || a.d - b.d || a.x.label.localeCompare(b.x.label));
    ctx.notify(p, {
      kind: 'dialogue.subjects', silent: true, npcId: e.id, session: s.token, query: q, total: scored.length,
      subjects: scored.slice(0, ASK_LIMIT).map(({ x }) => ({ id: x.id, kind: x.kind, label: x.label, hint: x.hint })),
    });
  });

  /** DFU mobile "Any work?": name a person who is offering work today and their building. */
  function workLead(e, p, detail = false) {
    const town = places?.exteriorOf(e.location);
    const out = (text, spec = null) => (detail ? { text, town, spec } : text);
    const candidates = places?.workAt(town, p.id) ?? [];
    if (!candidates.length) return out('Nobody I know is looking for help just now.');
    const secret = secretHalls(town);
    const doors = new Map((services.portals?.at?.(town) ?? []).filter((sp) => sp.entrances?.length && !isSecret(secret, sp)).map((sp) => [sp.to, sp]));
    const reachable = candidates.filter((w) => doors.has(w.interior));
    if (!reachable.length) return out('I could not tell you where to ask just now.');
    const day = Math.floor((services.worldClock?.()?.minutes ?? 0) / 1440);
    const w = reachable[hash32(`${e.id}#${day}`) % reachable.length];
    const spec = doors.get(w.interior);
    return out(`${w.name} is looking for help. Ask at ${buildingPhrase(spec)}, ${direction(e, nearestEntrance(spec, e))}.`, spec);
  }

  // ------------------------------------------------------------ tone, reactions and learned places

  /**
   * The speaker's reaction to an information request in the conversation's tone. `null` when they answer
   * (a polite or blunt success practises Etiquette or Streetwise); otherwise their refusal line. After
   * PATIENCE refusals in one conversation they answer no more questions.
   */
  function reaction(p, e, s, what) {
    const c = p.rpg?.character;
    // Source-backed speakers only (the legacy data-less roster keeps its fixed lines), and only for a player
    // with a character sheet to roll against.
    if (!(e.sourced || e.mobile) || !c?.skills) return null;
    // A "Where is…" pick after this conversation's directions request was answered is the same question.
    if (what === 'ask' && s.granted) return null;
    const key = `${p.id}>${e.id}`;
    const mood = patience.get(key);
    if (mood && ctx.now() > mood.until) patience.delete(key);
    s.refusals = patience.get(key)?.refusals ?? 0;
    if (s.refusals >= PATIENCE) return WEARY;
    const r = react(c, e, s.tone, attitude(p, e), `${p.id}:${e.id}:${s.token}:${s.counter}:${what}`);
    if (r.ok) {
      if (what === 'directions') s.granted = true;
      if (r.skill && c && typeof services.advanceSkill === 'function') services.advanceSkill(p, r.skill, 1);
      return null;
    }
    s.refusals++;
    patience.set(key, { refusals: s.refusals, until: ctx.now() + PATIENCE_MS });
    const text = refusalLine(r, `${e.id}:${s.counter}`);
    return s.refusals >= PATIENCE ? `${text} ${WEARY}` : text;
  }

  /** Local news or a rumour naming one of this town's public buildings (never a private or secret one). */
  function taleFor(p, e, topic) {
    const subjects = askableSubjects(p, e);
    if (!subjects) return null;
    const named = subjects.list.filter((x) => x.kind === 'place' && x.spec.meta?.buildingName);
    const doors = new Set(named.map((x) => x.spec.to));
    const people = subjects.list.filter((x) => x.kind === 'person' && x.person.id !== e.id && doors.has(x.spec.to))
      .map((x) => ({ name: x.person.name, interior: x.spec.to }));
    const work = (places.workAt(subjects.town, p.id) ?? []).filter((w) => doors.has(w.interior) && w.id !== e.id);
    const day = Math.floor((services.worldClock?.()?.minutes ?? 0) / 1440);
    const tale = localTale(topic, e, { places: named, people, work }, day);
    return tale && { ...tale, town: subjects.town };
  }

  /** Mark buildings a speaker has just pointed out on this player's own map (`rpg.learnedPlaces`). */
  function learnSpecs(p, town, specs) {
    if (!town || !p.rpg) return [];
    const out = [];
    for (const sp of specs ?? []) {
      const door = sp?.entrances?.[0];
      if (!door || !Number.isFinite(door.x) || !Number.isFinite(door.z)) continue;
      const entry = learnPlace(p.rpg, town, {
        id: sp.id, name: sp.meta?.buildingName || sp.label, type: sp.meta?.buildingType ?? null, interior: sp.to,
        x: Math.round(door.x * 10) / 10, z: Math.round(door.z * 10) / 10,
      });
      if (entry) out.push(entry);
    }
    if (out.length) {
      ctx.dirty?.(p);
      ctx.notify(p, { kind: 'map.learned', silent: true, town, places: out });
      ctx.emit('placeLearned', { player: p, town, places: out });
    }
    return out;
  }

  ctx.onAction('npc.tone', (p, args) => {
    const { e, s } = inSession(p, args);
    if (!TONES.includes(args.tone)) fail('Choose a polite, normal or blunt tone.');
    s.tone = args.tone;
    return say(p, e, s.lastText || '');
  });

  return { ensureRoster, shops, sessions, places };
}
