# Shops, shelves, regional prices and repairs (package 12)

Owner files: [client/gameplay/economy/rules.js](../client/gameplay/economy/rules.js) (pure price rules, shared by server and browser), [server/rpg/economy/stock.js](../server/rpg/economy/stock.js) (shelf stock), [server/rpg/economy/ledger.js](../server/rpg/economy/ledger.js) (shop ledgers of real buildings), [server/rpg/economy/basket.js](../server/rpg/economy/basket.js) (unpaid baskets on the ledger), [server/rpg/economy.js](../server/rpg/economy.js) (shelf actions and price services), [client/gameplay/shop.js](../client/gameplay/shop.js) (the Shelf page), and the repair rules in [client/gameplay/townServices/rules.js](../client/gameplay/townServices/rules.js). Shelf positions come from `shopShelves()` in [client/world/interiors/layout.js](../client/world/interiors/layout.js). Tests: [test/rpg-shops.test.mjs](../test/rpg-shops.test.mjs).

Rules follow Daggerfall Unity at revision 3d85a283 (MIT): `DaggerfallLoot.StockShopShelf`, `DaggerfallLootDataTables.itemGroups*`, `DaggerfallInterior.AddFurnitureAction`, `FormulaHelper.CalculateCost / CalculateTradePrice / ApplyRegionalPriceAdjustment / UpdateRegionalPrices / RandomMaterial / RandomArmorMaterial / CalculateItemRepairCost / CalculateItemRepairTime`, `DaggerfallTradeWindow` (holiday halving, storeBuysItemType, repair batch times, magic-item repair refusal, Mercantile tally) and `ThievesGuild.CanAccessService`. All wording is original.

## Shelves

Every shop building (RMBLayout.IsShop: alchemist, armourer, bookseller, clothing, furniture, gem store, general store, pawnbroker, weaponsmith) publishes its shelf props in the portal meta as `meta.shelves: [{number, modelId, x, y, z, r}]`. These are the prop models 41000 + {5, 6, 11–19, 26, 28, 29, 31, 35–37, 40–42, 44, 46–49, 808}. On the installed data, all 5 shops in Gothway Garden, all 32 in Daggerfall and all 13 in Wayrest have between 2 and 8 shelves.

Each shelf is stocked on its own, as in classic. For every `[group, chanceMod]` pair of the shop's table, each template with `rarity ≤ shop quality` is stocked with chance `chanceMod × 5 × (21 − rarity) / 100` %. Weapons take `RandomMaterial(level)` and armour takes `RandomArmorMaterial(level)`, using the level of the first player who browses the shop that day. Arrows come in stacks of 1–20. Clothing gets a random dye. Booksellers, general stores and pawnbrokers shelve `((quality+3)/5 …)+1` installed books (package 7's `services.books`). Every general store shelf also offers a Horse and a Small Cart. Other classic groups (ingredients, gems, jewellery, religious items, lights, paintings) come from package 7's `classicGroupTemplates`.

Stock is re-rolled the first time anyone browses the shop on a new game day (`CreateStockedDate` = year × 1000 + day of year). As in classic, this clears the shelves, including goods the shop bought from players.

**Source-checked stock.**
- Alchemists: each shelf has a 25 % chance of one potion recipe (`RandomlyAddPotionRecipe(25)`, package 16's `randomPotionRecipeLoot`). Classic alchemist shelves hold no potions. Potions are sold by package 16's potion merchants (Mages Guild and temple services). The earlier departure that shelved basic potions at alchemists is gone.
- Magic items: the `MagicItems` group reads template 0 (Ruby, rarity 10) through `GetItemTemplate(MagicItems, 0)`. A shop of quality 10 or more therefore rolls `chanceMod × 5 × 11 / 100` % for one `CreateRandomMagicItem` (package 16's `randomMagicItem`, unidentified MAGIC.DEF item). Pawnshops have chanceMod 10 (5 %). General stores have chanceMod 0, so they never stock one.
- Furniture stores: `StockShopShelf` has no case for `FurnitureStore`, so `itemGroups` stays `{0}`. DFU reads past the end of that one-entry array, and the shelves hold nothing. `DaggerfallLootDataTables.itemGroupsFurnitureStore` (paintings, 20) is never read, and the shop buys only `Furniture`, which has no catalogue items. Furniture store shelves are empty here too, and the counter has nothing to buy.
- The catalogue's clothing is unisex, so a men's and a women's clothing roll draw on the same list (departure).

### Ledger

One ledger per shop building is shared by every player and every shelf. It is the NPC feature's `npcshop:shop:<interior location>` world row. Stock keys are `s<shelf>:<template>` (`s1:book#42` for a book) and `sold:<template>` for goods bought from players. A shelf purchase and a counter purchase change the same row, guarded by the same rollback and written in the same transaction as the buyer's gold and pack. Unpaid baskets live on the same row (`holds`, see Basket). The shopkeeper's counter ("Show me your wares") lists the whole ledger, with each item's shelf. Taking goods while nobody minds the shop (closed hours, keeper absent) is refused here. Doing it anyway is shoplifting, which belongs to package 14 through `services.shopShelf(location)`.

### Basket (pick at the shelf, pay at the counter)

Classic `DaggerfallTradeWindow` in Buy mode, opened on a shelf of an open shop, moves picked goods into a basket. Remove puts a line back. Closing the window returns everything (`ClearSelectedItems`). Buy pays for the whole basket with one `GetTradePrice`. Steal rolls `CalculateShopliftingChance` on the basket's weight plus its item count (`DoSteal`). Here:

- `shop.pick` moves goods from the shelf into the player's basket. The basket is held on the shop's shared ledger (`holds`, keyed by player). The goods leave the shelf for everybody at once, so two shoppers can never both take the last one: the second gets "no longer on this shelf". Nothing is paid. `CanCarryAmount` is checked against what the player carries plus the basket.
- `shop.unpick` puts a line, or part of one, back on its own shelf from anywhere in the shop. Everyone browsing that shelf, and everyone trading at the counter, gets a fresh view.
- `shop.pay` works only within 4 m of the shopkeeper (the counter). The total is classic: the `CalculateCost` lines are summed (each holiday-adjusted), then one `CalculateTradePrice`. The browser sends the basket id, its revision and the total it showed; any change is refused. Gold, goods, the purse and the basket change in one transaction. A failed save restores both sides. Capacity is checked again at settlement against the *current* maximum (effective Strength and a worn Increased Weight Allowance, `services.canCarry`). Classic `CanCarryAmount` runs only when goods are picked, but here Strength or the allowance can change between picking and paying, so the check is repeated. As in classic, gold you are about to pay still counts as carried. The character keeps a receipt (`rpg.shopReceipt`), so a retry after a lost reply or a reconnect is answered "already paid" and never charges twice. One Mercantile tally per payment.
- `shop.steal` hands the basket to package 14 (`services.law.shopliftBasket`): detection by Pickpocket against shop quality and weight + count (a stack counts once), a Pickpocket tally, then either the thieving tally with the goods (marked `stolen`, so only a fence buys them) or a witnessed theft charge with the goods back on the shelves. The old `law.shoplift` (one item straight off the shelves) and `shop.take` (buy one shelf line at once) still work for older callers.
- The basket goes back on the shelves when its owner leaves the shop, when the shop closes by its hours, after 15 minutes untouched, or 2 minutes after a disconnect without a reconnect. A reconnect inside the shop, and a graceful restart, find the basket where it was: it is saved on the ledger row. Day restocking leaves held goods in the basket.
- Privacy: only the owner receives `shop.basket`, with their own prices. Other players see only lower shelf quantities. The counter's ware list never includes held goods.

### Checkout in the shopkeeper's conversation

Talking to the person who minds the shop (G) while you have an unpaid basket there adds `basket: {basket, seq, count, total, lines:[{name, quantity}]}` to your own dialogue view (`services.shopBasketFor`). Nobody else's view has it. It reads the ledger's basket and the keeper match only, so right after a reconnect it is present before the interior survey re-announces the basket; when that announce arrives, an open conversation with the keeper is re-sent as well. The conversation then offers the first numbered reply **"I'll pay for my basket: 2 × Candle, Torch — 12 gold."** It can be chosen with its number key, Tab and G, or a click, and screen readers announce it like any other reply. Choosing it sends the existing `shop.pay {basket, seq, total}` with the conversation's `{targetId, session}`. The protections are the same as on the Shelf page:

- a live, unforged session with that shopkeeper, who must not be hostile (`shopLedger.talking`). Talking to another person in the shop refuses with "pay <keeper>".
- the counter reach (4 m), even though conversations reach 6.4 m.
- the quoted total and basket revision. Any change refuses with "The price has changed".
- the receipt. A retry from the conversation answers "already paid" in the conversation and charges nothing.
- one transaction with rollback for gold, goods, purse and ledger.

The keeper's answer ("12 gold for 3 items. Thank you, and come again.") replaces the line, and the reply disappears. A pick, a put-back, a theft or an automatic return also refreshes an open conversation with that keeper (`shopLedger.talkBack`).

**Source notes for this conversation.**
- *Wagon.* In `DaggerfallTradeWindow` Buy mode, the wagon button only switches the local list to the wagon so you can take things *from* it into your pack while trading. `ConfirmTrade` always does `PlayerEntity.Items.TransferAll(basketItems)`, and `CanCarryAmount` checks `CarriedWeight + basket weight` against your own encumbrance. Purchases therefore never go into the wagon, and the basket never skips the carry check. No buy-to-wagon is offered. The wagon stays package 13's private store (`property.take` moves goods from it to the pack, also in a shop).
- *Regional price comments.* `FormulaHelper.UpdateRegionalPrices` sets a region's `PricesHigh` flag above 2000 and `PricesLow` below 500. The only code that reads them is the monthly faction update (`PlayerEntity`), where three or more flagged provinces change The Merchants' power by one. No dialogue or rumour reads them. The Shelf and counter pages already show `marketNote` with the same thresholds. No conversation line is added.
- *Identification.* Only the Mages Guild service (`DaggerfallGuildServicePopupWindow`) and the Identify spell open `WindowModes.Identify`. The ordinary merchant popup (`DaggerfallMerchantServicePopupWindow`) offers Talk and Sell only. Shopkeepers do not identify. That service is package 16's Mages Guild `identify`, and pawnshop magic stays unidentified.

## Prices

| Step | Rule |
|---|---|
| Regional adjustment | `cost × adjust / 1000`. `adjust` is per region and per game day, shared by the whole server: 750–1250 on New Life each year, then one classic step per day (fall 2 % if `d100 > (merchantsPower − regionPower)/5 + 50 − (adjust − 1000)/25`, else rise 2 %, clamped 250–4000). The powers are The Merchants (510) and the region's province faction (type 7, `FindFactionByTypeAndRegion`) from the operator's FACTION.TXT. Without game data the term is 0. On the installed data The Merchants have 40 and Daggerfall 80, so Daggerfall's prices drift down. |
| Shop quality | `2 × (cost × (quality − 10) / 100 + cost)` (CalculateCost) |
| Holidays | Package 20's `holidayPrice('trade', …)`, applied per basket line: Merchants' Festival halves shop prices, Warriors' Festival halves weapons. |
| Haggling | CalculateTradePrice. The merchant's Mercantile and Personality are `5 × (quality − 10) + 50`, against the player's **live** Mercantile (`Skills.GetLiveSkillValue`) and Personality (`Stats.LivePersonality`). Buying and selling use different curves. |

**Live inputs.** `services.tradeInputs(p)` returns `{mercantile, personality}` from the character feature's `skillValue` and `attributeValue`. These include temple blessings (Zenithar +Mercantile, Mara +Personality), conditions, magic attribute effects and EnhancesSkill. They feed every trade price on the server: shelves and the counter (`shopLedger.economy.context`), and repairs, the temple cure and spell sellers (`services.priceContext`). The browser's repair quote uses the same values. `townServices.counters` publishes them as `trade: {mercantile, personality}` and re-sends the event within about a second when they change, for example when a blessing fades. `priceContext()` takes them as `mercantile`/`personality`. Without them (fallback fixtures, no character feature), it uses the stored skill and the snapshot's `effectiveAttributes.Personality`.

Measured on the installed data at one shared moment, for a horse (value 1000) and the same character, with faction power: Gothway Garden quality 3 shop **1081**, quality 11 **1600**, quality 19 **2168**. Wayrest quality 11 shop **1677** (Daggerfall region adjustment 1127, Wayrest 1182).

**Multiplayer guard (not classic).** CalculateTradePrice lets a strong haggler sell an item back to a poor shop for more than it cost there. In a shared world that would be an endless purse. A shop never pays a player more for a template than that player last paid the same shop for it (`rpg.shopMemory`, the last 64 purchases). Trading between different shops follows classic and is limited by each merchant's purse.

What a shop buys follows storeBuysItemType. For example, general stores do not buy armour, and alchemists buy only gems and ingredients. Roster merchants in towns without game data keep their fixed stock tables and buy anything, but they use the same price formulas at quality 10. Items with `stolen` set are refused everywhere except at a Thieves Guild fence. Conjured items (`conjuredUntil`) are refused everywhere.

**Fence.** A Thieves Guild member of rank 2 or higher can use the `sellItems` service (NPC service 805, "Sell magic items"). The fence buys anything, stolen goods included, at `CalculateCost(value, quality)` and the selling trade price, from its own purse (`fence:<location>` row). Source check: DFU's SellMagic price is `CalculateCost(item.value, quality)` with the comment "TODO: Fencing base price higher and guild rep affects it". ThievesGuild has no price modifier, so no reputation modifier exists in the source to follow, and none is applied.

Every completed purchase or sale tallies one Mercantile use (`services.advanceSkill`).

## Repairs

Repair cost is CalculateItemRepairCost with the regional adjustment (`max(1, value/10)`, then CalculateCost), then the Fighters Guild discount, then the buying trade price (DaggerfallTradeWindow.GetTradePrice). The browser's quote uses the same function, with `market.adjust` from the `townServices.counters` event and the character's skills. `services.repairQuote(p, counterId, itemIds)` returns the exact charge. Several items can be left together with `repair.leave {itemIds, cost}`. Each item takes its own time, except the slowest, which takes its time plus half of all the others' (UpdateRepairTimes). Smiths refuse enchanted items (`item.magic`, `enchantments`), templates that cannot be repaired, conjured items, quest items and stacks. The time is at least one game day on the shared clock.

## Protocol

| Verb | Args | Result |
|---|---|---|
| `shop.shelves` | — | `{kind:'shop.shelves', location, shop, quality, shelves:[{shelf,x,y,z,r}]}`. The list is empty outside shops. Also sent on arrival. |
| `shop.shelf` | `{shelf}` | Must stand within the shelf's half-width + 1.75 m on the same floor. Returns `{kind:'shop.shelf', location, shelf, rev, quality, market:{adjust, holiday, note}, keeper, gold, items:[{key,name,quantity,price,icon,variant}]}`. |
| `shop.take` | `{shelf, key, quantity, price}` | Direct purchase (older callers). `price` is the unit price shown, and a changed price is refused. Pays the keeper and moves the goods. Everyone browsing that shop gets a fresh view. Emits `shopPurchase`. |
| `shop.pick` | `{shelf, key, quantity, price}` | At the shelf: goods into your basket, unpaid. Returns a fresh `shop.shelf` and `shop.basket`. |
| `shop.unpick` | `{key, quantity?}` | Anywhere in the shop: a basket line back on its shelf. |
| `shop.basket` | — | `{kind:'shop.basket', location, basket, seq, keeper, lines:[{key,name,quantity,icon,variant,shelf,price}], count, total, gold, text?}` to the owner only. Also sent on arrival when a basket is waiting. |
| `shop.pay` | `{basket, seq, total, targetId?, session?}` | At the counter (within 4 m of the keeper). Pays for the whole basket. With `targetId`/`session` it is the conversation's checkout reply: the session must be live, the speaker must be the shop's keeper and not hostile, and the keeper answers in the conversation. Emits `shopPurchase {basket:true, total, count}`. A retry of a completed payment answers "already paid". |
| `shop.steal` | `{basket, seq}` | Package 14 decides. Emits `shopTheft` on success. |

Services: `regionalPrice(p, cost)`, `regionPriceAdjust(regionIndex)`, `priceContext(p, location, quality)` (live inputs), `tradeInputs(p)`, `shopBasketFor(p, keeper)`, `shopLedger` (from npcs.js: `keeperAt, open, key, guard, changed, refresh, economy, talking, talkBack`), `shopEconomy`, `repairQuote`.

In the browser, a player who faces a shelf within reach and presses G opens the **Shelf** page, unless a person in the crosshair takes priority. The page lists the shelf's goods with the price for this character, the shop's quality, gold, the regional market note and any holiday. **Take** puts goods in the basket shown below the list, with **Put back**, **Pay** (at the counter) and **Steal**.

## Evidence

- `node --test test/rpg-shops.test.mjs` runs the pure formulas and shelf stocking. The `[asset]` case runs the production manifest on real SQLite with the installed data. Two accounts buy from a real shelf of First Class Supply Store, and the ledger, counter and second account agree. It checks horse prices by quality and region against the formulas. The worn item is repaired at that shop's counter: the other account cannot collect it, the server restarts, the shared clock passes and the item comes back with its original id, collected once.
- `[asset] classic checkout` runs on the production manifest with two accounts: contention for the last item, undo, payment refused away from the counter and at a changed price, an injected failed save (nothing changes), the retry, a second retry answered "already paid", leaving the shop, a disconnect inside and after the grace period, a graceful restart with a held basket, a witnessed and an unwatched basket theft (goods marked stolen, refused by the shopkeeper).
- `[asset] checkout in the shopkeeper conversation` (two accounts) checks:
  - the basket in A's dialogue view and not in B's;
  - refusal across the shop but within talk range (counter reach);
  - refusal with a forged session, and with a changed quote;
  - that B cannot pay A's basket;
  - payment answered in the conversation, with the reply gone afterwards;
  - a conversation retry answered "already paid" with no charge;
  - payment refused while Strength is lowered after picking (nothing changes), then accepted once it is restored;
  - a held basket offered by the keeper again after a graceful restart, then paid.

  `checkout reply in the conversation` checks the numbered reply and its arguments.
  `checkout reply right after a reconnect` (fixture ledger, survey pending) checks that the first dialogue view already carries the basket and that the late announce re-sends the conversation.
- `[asset] live Mercantile and Personality` blesses a character (Zenithar, +1 Mercantile, on the shared clock) and checks that the shelf price, `services.priceContext` and the published `trade` inputs follow it. The browser repair quote equals `repairQuote` before, during and after the blessing. After the blessing fades, everything reverts. A pure case covers the fallback.
- Browser, private server (ports 8492 and 8493, temporary databases, clock shifted to morning, players placed at the shelf, at the counter and outside by a labelled fixture): screenshots `progress/screenshots/agents/p12-*.png`. That run's `outside()` read a field that does not exist, so the door transfer had no coordinates and its saves failed (`NOT NULL players.x`). The conversation run below uses the door's real `entrances[0].exit` landing.
- Browser, conversation checkout. Private server on port 8496 with temporary databases and the clock shifted to morning. One Chromium page (A) plus a raw second WebSocket (B), in Doctor Mordistyr's Gear, Gothway Garden (quality 17). Screenshots `progress/screenshots/agents/p12-20…24-talk-*.png`. **Staged setup** (labelled in the script):
  - A lands on the door's own entry landing.
  - B stands at shelf 1.
  - both get a fixture purse;
  - the taken item is set to the last one;
  - B leaves through a portal transfer to the door's real `exit` landing;
  - A is given a cart.

  Grid routes come from the server's `collision.isClear`. Everything else is real input. A walked door → shelf 1 (9 legs) with the arrow keys and W, browsed it with G and took the last Bandage. B's socket was then refused ("no longer on this shelf") and got no basket event. A walked shelf → shopkeeper to 2.2 m and pressed G. The conversation offered "1. I'll pay for my basket: Bandage — 1 gold." B's conversation with the same keeper had no basket. Key 1 paid: the keeper answered "1 gold for 1 item. Thank you, and come again.", gold went 2500 → 2499 and the Bandage was in the pack. A retry of the same payment charged nothing. B picked Parchment and left by the door: the shelf went 0 → 1 and B was told the goods went back. The run logged no save errors. A's purchase went to the pack, not the wagon. Only A reaches A's wagon (B reaches none). After closing the page and reconnecting, A has the same gold, the same item ids and the cart, inside the shop. B's socket reconnected on the street outside, so the helper, which waits for the shop, timed out.
- The earlier positions beside the shelves (`stand()`) are inside furniture collision. A player placed there cannot move. Positions in later runs use the door landing or `collision.nearestClear`.

## Dynamic economy & regional holidays

- Live faction power updates (`services.setFactionPower` / `adjustFactionPower`) and the monthly Merchants' faction power step (`services.updateMonthlyEconomy`, ±1 when three or more provinces hit `PricesHigh` or `PricesLow`) persist in shared world state (`economy:state`) and immediately update `priceAdjust`.
- Regional holiday trade pricing (`server/rpg/economy/dynamic.js`: Saturalia in Wayrest, Festival of Blades and Baranth Do in Alik'r Desert, Dancing Day in Daggerfall, Broken Diamonds in Glenpoint, Appreciation Day in Anticlere, Koomu Alazeri in Ykalon) applies alongside the three global trade holidays (Merchants' Festival, Tales and Tallows, Warriors' Festival).

## Outstanding

- Selling magic items at ordinary shops is not restricted beyond the classic group tables.
- The counter's ware list (package 3's "Show me your wares" page) still offers direct purchase from every shelf (`npc.buy`). Classic's merchant popup offers only Talk and Sell; buying happens at the shelves. It is kept for older callers. The basket checkout is in the conversation and on the Shelf page.
