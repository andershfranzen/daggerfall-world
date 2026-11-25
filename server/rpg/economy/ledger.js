// Shop ledgers of real shop buildings: shelf stock, daily restocking, classic prices and what a shop will buy.
// Used by the NPC feature's shared ledger (server/rpg/npcs.js `shops`, one `npcshop:shop:<interior>` world row per
// building) and by the shelf feature (server/rpg/economy.js). Roster merchants of towns without game data keep their
// fixed stock tables (server/rpg/npcs/data.js) and only take the classic price rules here.

import { dateFromMinutes } from '../../../client/gameplay/atmosphere/calendar.js';
import {
  DEFAULT_QUALITY, STORE_BUYS, buyPrice, itemGroupOf, priceContext, regionIndexOf, sellPrice, storeRefusal,
} from '../../../client/gameplay/economy/rules.js';
import { stockShelf, stockedDate, TEMPLATE_GROUP } from './stock.js';

const ROSTER_QUALITY = DEFAULT_QUALITY;
/** Classic Thieves Guild faction id (FactionFile.FactionIDs.The_Thieves_Guild) and SellMagicItems rank (ThievesGuild.cs). */
export const THIEVES_GUILD = 42;
export const FENCE_RANK = 2;

export function createShopEconomy(ctx, { describe }) {
  const services = ctx.services ?? (ctx.services = {});
  const minutes = () => {
    const m = services.worldClock?.()?.minutes;
    return Number.isFinite(m) ? m : null;
  };

  /** True when the entity is the keeper of a real (source-backed) shop building. */
  const isBuildingShop = (e) => !!(e?.sourced && e.shop && Number.isInteger(e.building?.type) && STORE_BUYS[e.building.type]);

  /** Portal meta of a building interior (shelves, quality, region index), or null. */
  const metaOf = (location) => {
    try {
      return services.portals?.into?.(location)?.meta ?? null;
    } catch {
      return null;
    }
  };

  /** {type, quality, regionIndex, shelves:[numbers]} of the building an entity (or a location) belongs to. */
  function buildingOf(e) {
    const meta = metaOf(e.location);
    const shelves = (meta?.shelves ?? []).map((s) => s.number).filter(Number.isInteger);
    return {
      type: e.building?.type ?? meta?.buildingType ?? null,
      quality: Math.max(1, Math.min(20, Math.trunc(e.building?.quality ?? meta?.quality ?? ROSTER_QUALITY) || ROSTER_QUALITY)),
      regionIndex: Number.isInteger(meta?.regionIndex) ? meta.regionIndex : regionIndexOf(e.location),
      shelves: shelves.length ? shelves : [1],
    };
  }

  /** The classic price context for this player at this merchant (quality, region, Mercantile, Personality, holiday). */
  function context(p, e, shop = null) {
    const b = shop?.building ?? (isBuildingShop(e) || (shop?.fence && e?.sourced) ? buildingOf(e) : null);
    return priceContext({
      quality: b?.quality ?? ROSTER_QUALITY,
      regionIndex: b?.regionIndex ?? regionIndexOf(e?.location),
      minutes: minutes(),
      character: p?.rpg?.character ?? null,
      guildFaction: null,
      ...(services.tradeInputs?.(p) ?? {}), // live Mercantile and Personality (CalculateTradePrice)
    });
  }

  const groupByIndex = TEMPLATE_GROUP;
  const groupOf = (item) => itemGroupOf(item, groupByIndex);

  /** Unit price the player pays. */
  const buyUnit = (p, e, it, shop) => buyPrice(it.value, 1, context(p, e, shop), it.group ?? null);
  /** Unit price the player is paid. */
  const sellUnit = (p, e, value, shop) => sellPrice(value, 1, context(p, e, shop));

  /** Why this shop will not buy `item` (storeBuysItemType, stolen goods), or null. */
  function refusal(e, item, shop) {
    if (item?.stolen) return `${e.name} will not touch stolen goods.`;
    if (item?.conjuredUntil) return `${e.name} will not buy something that will fade away.`;
    const type = shop?.building?.type ?? (isBuildingShop(e) ? e.building.type : null);
    if (type == null) return null;
    const d = describe(item.template);
    return storeRefusal(type, groupOf({ ...item, ...(d ?? {}), group: d?.group ?? item.group, index: d?.index ?? item.index }));
  }

  /** A new, unstocked ledger for a shop building (stocked the first time someone browses it each day). */
  function newBuildingLedger(e, purse) {
    return { kind: e.shop, purse, stock: new Map(), rev: 1, restockAt: Infinity, building: buildingOf(e), stocked: 0 };
  }

  /**
   * DaggerfallLoot.StockShopShelf for every shelf of the building when the ledger was last stocked on an earlier game
   * day. Classic clears the shelves, including anything sold to the shop. The purse is topped up to `purse`.
   * `p` is the player whose level picks the materials. Returns true when the stock changed.
   */
  function stockIfDue(shop, e, p, purse) {
    if (!shop.building) return false;
    const m = minutes();
    if (m == null) {
      if (shop.stocked) return false;
    } else if (shop.stocked >= stockedDate(dateFromMinutes(m))) return false;
    const fresh = buildingOf(e);
    shop.building = { ...shop.building, ...fresh, shelves: fresh.shelves };
    const day = m == null ? 1 : stockedDate(dateFromMinutes(m));
    const level = Math.max(1, Math.trunc(p?.rpg?.character?.level) || 1);
    const female = p?.rpg?.character?.gender === 'female';
    const stock = new Map();
    for (const n of shop.building.shelves) {
      const items = stockShelf({
        buildingType: shop.building.type, quality: shop.building.quality, level, female,
        seed: `${e.location}|${n}|${day}`, resolve: (k) => !!describe(k),
        randomBook: typeof services.books?.randomId === 'function' ? (r) => services.books.randomId(r) : null,
        // Package 16: potion recipes (alchemists) and unidentified MAGIC.DEF items (pawnshops).
        randomRecipe: typeof services.randomPotionRecipeLoot === 'function'
          ? (r) => { const x = services.randomPotionRecipeLoot(r); return x ? { template: x.template, extra: x.appearance?.extra ?? null } : null; } : null,
        randomMagic: typeof services.randomMagicItem === 'function' ? (r, lv) => services.randomMagicItem(r, lv) : null,
      });
      let unique = 0;
      for (const { template, quantity, extra } of items) {
        let d = describe(template);
        if (extra && typeof services.makeItemRecord === 'function') {
          // Per-item state (a book's title and price) lives on the record.
          const rec = services.makeItemRecord(template, 1, extra);
          if (rec) d = { ...d, name: rec.name ?? d.name, value: Number.isFinite(rec.value) ? rec.value : d.value, icon: rec.icon ?? d.icon };
        }
        // Per-item state never merges: a book keys by its id, a recipe or magic item by its place on the shelf.
        const key = `s${n}:${template}${extra?.bookId != null ? `#${extra.bookId}` : extra ? `#x${++unique}` : ''}`;
        const cur = stock.get(key);
        if (cur) cur.quantity += quantity;
        else stock.set(key, { template, name: d.name, value: d.value, icon: d.icon, quantity, shelf: n, group: groupOf(d), ...(extra ? { extra } : {}) });
      }
    }
    shop.stock = stock;
    shop.stocked = day;
    shop.stockedLevel = level;
    shop.purse = Math.max(shop.purse, purse);
    shop.rev++;
    return true;
  }

  // Multiplayer guard (not in classic): CalculateTradePrice lets a strong haggler sell an item back to a poor shop
  // for more than it cost there, which in a shared world is an endless purse. A shop never pays a player more for a
  // template than that player last paid the same shop for it. Kept in `rpg.shopMemory`, newest first, at most 64.
  const MEMORY = 64;
  function rememberPurchase(p, ledgerKey, template, unit) {
    const rpg = p.rpg;
    const list = Array.isArray(rpg.shopMemory) ? rpg.shopMemory.filter((m) => !(m.k === ledgerKey && m.t === template)) : [];
    list.unshift({ k: ledgerKey, t: template, u: unit });
    rpg.shopMemory = list.slice(0, MEMORY);
  }
  function resaleCap(p, ledgerKey, template, unit) {
    const m = Array.isArray(p.rpg?.shopMemory) ? p.rpg.shopMemory.find((x) => x?.k === ledgerKey && x.t === template) : null;
    return m && Number.isFinite(m.u) ? Math.min(unit, Math.max(0, Math.trunc(m.u))) : unit;
  }

  return { isBuildingShop, buildingOf, context, buyUnit, sellUnit, refusal, newBuildingLedger, stockIfDue, groupOf, rememberPurchase, resaleCap };
}
