# Town services

Owner: `server/rpg/townServices.js`, `server/rpg/townServices/buildings.js`, `client/gameplay/townServices.js` (+ `.css`), and the shared pure rules in `client/gameplay/townServices/rules.js`. Tests: `test/rpg-town-services.test.mjs`.

The feature reproduces the classic regional bank and the leave-it-with-the-smith repair service as server-authoritative actions. Numbers follow Daggerfall Unity (MIT): `DaggerfallBankManager.cs`, `FormulaHelper.CalculateCost/CalculateItemRepairCost/CalculateItemRepairTime`, `FightersGuild.ReducedRepairCost`, `RMBLayout.IsRepairShop/IsNamedBuilding/GetLocationBuildingData`. All wording is original.

## Inns, buildings and city gates

Talk to an innkeeper with **G** and choose **Room & board**. Food and drink cost 1–3 gold, restore two health per gold of menu value and share a four-game-hour cooldown. New Life makes the menu free. Harvest's End halves prices to a minimum of one gold. Food and drink are served and consumed at the inn.

A room costs seven gold per day, with one free night when the booking covers Heart's Day. A qualifying knight can use the existing guild privilege for free rooms. The server lets a character book up to 350 days ahead. It assigns an available bed from the installed inn's original 199.4 rest markers. An extension adds time to the existing expiry and keeps the same bed. Gold, the character's rental and the shared bed reservation save in one transaction. The keeper quotes the price and gives the bed number, direction and expiry.

The classic data contains 54,757 rest markers across 18,469 tavern building records. 84 tavern records have no authored bed marker. Lodging is unavailable at those counters, and their innkeepers still serve food and drink. [Installed-data census](../tools/classic-feature-gaps.mjs)

The tavern's public room stays open day and night. Return to the inn, walk to the assigned bed on its floor, and choose **Rest**. Sleep requires proximity and a clear line to that bed. A visitor can loiter under the calendar rules. The booking expires on the renter's personal calendar, which advances during sleep and travel. Each physical bed also has a release minute on the shared world clock. Spending personal time reduces that release minute by the same amount, allowing other guests to book the bed as soon as the renter's stay ends.

A public building's street door uses the same schedule as its services. Shops close on Sun's Rest. The current property owner, a guild member with the exact hall privilege, and the holder of a quest that binds a residence can enter their respective buildings after hours. Exits remain available. The law feature owns forced-entry state, including a successful Open spell. Daggerfall city uses the local 446/447 gate models. The gates close at 18:00 and reopen at 06:00, with the same geometry used by the renderer and movement solver.

[Tavern service](../server/rpg/townServices/tavern.js) · [Door access](../server/rpg/townServices/access.js) · [Installed-data tests](../test/rpg-inn-rental.test.mjs) · [Reference tavern menu and rentals](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/Game/UserInterfaceWindows/DaggerfallTavernWindow.cs) · [Reference rest check](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/Game/UserInterfaceWindows/DaggerfallRestWindow.cs) · [Reference access rules](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/Game/PlayerActivate.cs) · [Reference gate schedule](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/Internal/DaggerfallCityGate.cs)

In Play at The Rat and Scorpion, Blackidge Hamlet, a test character used the street door, walked to Mordynak Masterhart, booked two days for 14 gold, bought stew for three gold and extended the stay for seven. After dark the character returned through the same door and walked to the upstairs bed at 3.225 m above the ground floor. A separate cold-restart Play fixture resumed from saved bed viewpoints and verified sleep, expiry and the refusal for an account without a booking. The installed-data socket tests exercised two simultaneous reservations and showed that personal sleep or travel can release a bed while the shared clock and other guests' bookings stay fixed.

The south gate of Daggerfall appeared open at 17:30 and closed at 18:01 in the Play fixture. Server movement tests traversed the passage before dusk and at dawn and were blocked at dusk.

## Where services exist

Counters come from the operator's ARENA2 data, read with the shared world loaders (`loadTown` for the spawn origin, `client/world/interiors` `locationPortals()` for street doors, `parseRmbFull` for building data):

| Building type (DFLocation.BuildingTypes) | Counter | Service |
|---|---|---|
| Bank (3) | `type:'bank'` | deposit, withdraw, letters of credit |
| Armorer (2), WeaponSmith (13), GeneralStore (9) | `armorer` / `weaponsmith` / `general` | repair |

Building quality (1–20), faction and name seed come from the location's MAPS.BSA building list, assigned to RMB buildings in block order. The counter, door prompt and room share a name. Gothway Garden has The Bank of Daggerfall and several distinct general stores, including Doctor Mordistyr's Gear and The Superior General Store. A counter without naming data keeps its generic label.

Smith NPCs from the NPC feature (`kind:'npc', role:'smith'`) are also repair counters, quality 10. Talking to one (`talk` event) sends `townServices.offer`.

A counter serves a player only when the player is:

- in the same `town:` location and within **4 m** of one of the building's street doors (output-space coordinates, the same space as movement and collision), or
- inside that building's own `interior:Region/Location/bx,by/record` instance, or
- within **3.5 m** of the smith NPC.

Without operator data the server has no banks or shops, only smith NPCs; the panel says so. Counters load once per town, are cached for up to six towns, and load failures retry after five minutes.

Measured on the operator data: Gothway Garden has one Bank (quality 15) about 133 m south of the spawn and five General Stores; the city of Daggerfall has three banks, four armourers, one weaponsmith and nine general stores. A town loads in about 0.3–0.4 s.

## Persistent state: `rpg.townServices`

```
{ version: 1,
  accounts: { [regionKey]: { region, gold } },      // one account per region, key = lower-case region name
  letters:  [{ id, amount, region, issuedAt }],      // letters of credit the character carries
  repairs:  [{ ticket, counterId, town, shop, item, cost, leftAt, readyAt }],
  recent:   [requestId, …],                          // last 64 processed client request ids
  seq }
```

The record is part of the character row, so it is saved with gold and inventory in the runtime's single transaction. No database schema change is needed. Malformed records are dropped on load.

## Actions

All actions take `counterId` (from the counters event) and an optional `requestId` (`[\w-]{6,64}`). A repeated `requestId` is refused with "That was already done.", so a client resend after a disconnect cannot repeat a transaction. The request id is recorded in the same transaction as the change; a failed save rolls back both, allowing a retry.

| Verb | Args | Rule |
|---|---|---|
| `town.services` | — | Re-sends the counters event. |
| `bank.deposit` | `amount` | Whole gold, at most the gold carried. Credits this region's account. |
| `bank.withdraw` | `amount` | At most this region's balance. Refused if the gold (400 per kg) would exceed the encumbrance limit. |
| `bank.letter` | `amount` | At least 100. Charges `trunc(amount × 1.01)` to this region's account and gives a letter. |
| `bank.redeem` | — | Deposits every carried letter into this region's account (classic deposit-all). |
| `repair.leave` | `itemId, cost` | The item must be an unequipped, damaged weapon, armour or shield. `cost` must equal the server's quote. Pays, removes the item record from the pack, and opens a ticket. |
| `repair.collect` | `ticket, interrupt?` | Only at the same counter, in the same town. When ready, returns the same item record (same id) at full condition. With `interrupt:true` before it is ready, returns it unrepaired and does not refund the fee (classic). |

Repair cost is `max(1, value / 10)`, then `2 × (c × (quality − 10) / 100 + c)` with C# integer division, then the Fighters Guild discount for members (`((10 − rank) << 8) / 10 × price >> 8`), with the shared regional price adjustment applied first and the classic buying trade price (Mercantile, Personality) last. See [shops-and-economy.md](shops-and-economy.md#repairs); several items left together use the classic batch timing. Repair time is `max(damage × 86400 / 1000, 86400)` game seconds, which is at least one game day, rounded up to minutes. It is measured on the shared world clock (`ctx.services.worldClock().minutes`), which advances 12× real time and never skips. A day is two real hours.

Events: `{kind:'townServices', text}` after each transaction, `{kind:'townServices.counters', location, status, reason, counters, reach}` on arrival in a place and on request, and `{kind:'townServices.offer', counterId, services, text}` after talking to a smith.

Services on `ctx.services`: `townCounters(location)`, `bankBalance(player, region)`, `townCountersSettled(townId)`.

## Browser

The panel `townServices` ("Bank & Repairs") is registered with the shell and listed in the menu rail. It shows every counter in town with quality, distance and compass bearing, highlights the counter the player stands at, and offers only that counter's controls: deposit, deposit all, withdraw, write a letter (live commission), deposit letters, damaged items with price and time, and tickets with a Collect or Take back unrepaired action. On reaching a building counter it also posts one message pointing to the panel. Prices come from the same rules module as the server, and the server re-checks every value.

## Supported subset and differences from classic

- Supported: regional accounts, deposit/withdraw, letters of credit (issue and deposit-all), repair at real armourers, weaponsmiths and general stores and at smith NPCs, shared-clock repair times, early pickup without refund, and the Fighters Guild repair discount.
- Letters of credit are kept in `rpg.townServices.letters`, not as inventory items: the equipment catalogue has no letter template. They cannot be dropped, traded or sold.
- Loans, houses, ships, the wagon and owned storage are in docs/property.md (package 13). Outstanding here: and repairing equipped items. Regional prices, batch timing and magic-item restrictions are in [shops-and-economy.md](shops-and-economy.md).
- Using a counter from the street door stands in for the shop interior. Once inside the building's interior instance, the whole interior counts as at the counter.

## Coordination notes

- Server registration is in `server/rpg/features.js` (done by the manifest owner). The browser panel still needs `{ name: 'townServices', install }` from `client/gameplay/townServices.js` in `client/gameplay/features.js`.
- `buildings.js` reuses `arena2Files` from `server/rpg/collision/arena2.js` and the interiors module's `locationPortals`. It loads the town once more for the spawn origin, because the interiors portal registry does not keep building type or quality. If the registry exposed `buildingType` and `quality` per portal, this feature could read counters from it instead.
- Repairs re-insert the stored record with the inventory module's exported `normalizeRpg` and emit `inventoryChanged`. They never create a new item.
