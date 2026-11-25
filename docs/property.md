# Loans, property, ships and the wagon (backlog package 13)

Owner: `server/rpg/property.js`, shared rules `client/gameplay/property/rules.js`, panel `client/gameplay/property.js` ("Property & Transport"). Tests: `test/rpg-property.test.mjs`. Rules follow Daggerfall Unity at revision 3d85a28: `DaggerfallBankManager.cs`, `LoanChecker.cs`, `FormulaHelper.CalculateMaxBankLoan/CalculateBankLoanRepayment`, `BuildingDirectory.GetHousesForSale`, `TransportManager.cs`, `ItemHelper.WagonKgLimit` and the inventory window's wagon access. The wording is original.

## Rules

| Action | Where | Rule |
|---|---|---|
| `bank.loan {counterId, amount}` | A bank counter that is open (the town-services reach and hours rules apply) | 100 up to level × 50,000. The amount is paid into that region's account. The debt is the amount plus 10%, due one classic year (360 days) later on the borrower's own clock (`services.playerMinutes`). Refused while a loan is open in that region, or after a default there. |
| `bank.repay {counterId, amount, fromAccount?}` | Bank in the issuing region | Carried gold is used first, then the account. Overpayment is capped at the debt. |
| Due date | Every 5 s and on `timeSpent` | Reminders at 6, 3 and 1 months. When the loan falls due, the regional account pays what it can. If any debt remains, the loan defaults once: legal reputation −10 in that region through `services.law.changeLegalRep`, and that bank never lends again. |
| `house.buy {counterId, houseId, expectPrice}` | Bank | Offers are every HouseForSale plus random House1–4, up to min(buildings / 10, 20), drawn with a seed from the town and the shared-clock month. Price = (int)(building model radius × 1280). Payment comes from carried gold first, then the account. One house per region. |
| `house.sell` / `ship.sell` | Bank | 85% of the price is paid into the account. The store must be emptied first. |
| `ship.buy {type: small or large}` | Bank in a port town (MAPS `PortTownAndUnknown` ≠ 0) | 100,000 or 200,000 gold. One ship per character. The travel map and server waive sea passage for either ship type. A knight of rank 6 or higher also sails free. |
| `ship.board` / `ship.leave` | Outdoors (the rider gets down first) | The boarding point is saved. The player goes to the deck record (`town:31/1` or `town:31/2`) and stands on the deck: 9.075 m at the small ship's start marker, 10.6 m on the large ship's top deck (StreamingWorld RandomStartMarker + PlayerMotor.FixStanding). The way back goes to the saved boarding point. Fast travel to a deck is refused. |
| Ship cabin | The deck's own building door (BuildingTypes.Ship, 24), from the floor at its foot | PlayerActivate.BuildingIsUnlocked opens it for a ship owner at any hour. The door sits under walkable decks: 2.6 m under the small ship's 5.8 m deck, 3.425 m under the large ship's 6.625, 9.875 and 10.6 m decks. Its portal entrance therefore carries `floor`, the doorway's bottom edge, and `portal.use` passes the server body's foot height (`collision.footY`). The registry refuses it beyond 1.25 m of that floor, and also when the foot height is unknown. The Play prompt applies the same floor to the camera's eye height less 1.6 m, so no deck above offers the door. Inside the cabin the owner reaches the hold, and leaving puts them on the storey by the door. |
| `mount.ride {on?, mode?: horse or cart}` | Outdoors | TransportManager.ToggleMount: rides the horse when the character owns one, otherwise drives the small cart. The cart moves at walk × (Speed + dfCartBase 250) / 200, which is 6 m/s at Speed 50. The browser draws MRED01I0.CFA from the player's own files. Doors, defeat or losing the cart put the driver back on foot. |
| `bank.letter` / `bank.redeem` | Bank | A letter of credit is a Letter of Credit item (ItemTemplates 275) in the pack, worth its amount. Redeem pays every carried letter into this region's account (DepositAll_LOC). Letter records from older saves become items on join. |
| Paying for a house or ship | Bank | GetGoldAmount counts carried letters. DeductGoldAmount takes gold when gold covers the price, otherwise letters first (a partly used letter keeps the rest), then gold, then the account. |
| `bank.deposit` | Bank | DepositGold takes the purse first, then gold stored in the wagon. |
| `services.property.grantHouse(p, {town?, random?})` | Called by package 15 (KnightlyOrder.ReceiveHouse, rank 9, once) | A random house for sale in the town, allocated as a purchase at price 0 with no gold or account change. Returns `granted`, `owned` (a house in this region already), `none` (nothing for sale) or `unavailable` (records not ready). |
| Deed | `house.buy` / `house.sell` | AllocateHouseToPlayer: the town map names the house "<name>'s house", and the notebook gets a deed entry. Selling removes the map name (UndiscoverBuilding). |
| `property.store` / `property.take {container, itemId, quantity}` | Wagon: needs a `small-cart`, 750 kg limit, and in a dungeon within 5 m of an exit. House store: inside your own house interior. Hold: aboard your own ship. | Item ids are kept. Gold counts 400 pieces per kg. Encumbrance is checked on take. Equipped and quest items stay with you. |

Every action is refused before anything changes, and a repeated `requestId` is refused. A failed save rolls back the whole `rpg` record, as the runtime does.

## State and isolation

All of this lives in the character row, under `rpg.property` (loans, houses, ship, boarding point, stores). Another character standing in the same house or on the same deck sees none of it. `services.ownsBuilding` lets the owner open the house at any hour. `services.ownsInterior` lets package 7 treat furniture in an owned house as storage.

## Data added to shared readers

- `client/world/arch3d.js`: the mesh header radius.
- `client/world/maps.js`: the `portTown` byte.
- `client/world/interiors/index.js`: building `modelId` and `radius`, plus the location's `port` flag.
- `server/rpg/townServices/buildings.js`: `houses`, `port` and `buildingCount` for each town.
- `server/rpg/townServices.js`: `bankCounter`, `bankAdjust` and `townProperty`.
- `client/world/blocks.js` and `town.js`: a block without streets is entered at its TEXTURE.199/10 start marker, or else at its first model.
- `server/rpg/inventory.js`: the `small-cart` template (ItemTemplates 93) and the `credit` item extra on `letter-of-credit`.
- `client/world/town.js`: `spawn.y` and `spawn.deck` for a deck spawn. `deckHeight` finds the highest model floor with standing room under the marker.
- `client/gameplay/collision/world.js`: a deck world's entry height and a `deck` flag. `server/rpg/collision.js` and `client/main.js` land a teleport on the storey it names.
- `client/gameplay/mount/rules.js`: the cart mode and speed. `server/rpg/automap.js`: `forgetPlace`.
- `client/world/interiors/index.js`: `SHIP_BUILDING_TYPE` and `buildingDoorFloor`, used by `portalSpecs` (server) and `townDoors` (Play). `server/rpg/collision.js`: `footY(p)`, the body the next step would use.

## Known gaps

- Multiplayer adaptation: two owners of the same ship type share one deck location and one cabin instance, as DFU's single-player model has no per-owner ship scene. Owners on the same deck or in the same cabin see each other, as in any shared place. Holds, boarding points and door access stay per character, and only owners can board or open the cabin. The installed two-owner test boarded two large-ship owners from different shore points at the same time. They shared the deck and cabin, each stored cargo the other could neither see nor take, and after a restart each went ashore at their own boarding point. The instance identity therefore stays per ship type. A per-owner deck would need a new location-id scheme and is not needed to protect cargo or shore return.
- House deeds are per character, so two characters can own the same building.
- House and ship prices take no regional adjustment: DFU's GetHousePrice and shipPrices don't call ApplyRegionalPriceAdjustment, so `services.regionalPrice` (package 12) is intentionally not used here.
- Shops (package 12) take letters of credit through `services.spendableGold` and `services.spendGold` (shop.take, shop.pay, npc.buy). Selling pays carried gold, not letters, as in DFU.
- House contents are not shown as furniture.
- Only ship cabin doors check foot height. Other exterior doors keep horizontal reach, so raised doorways such as the Castle Daggerfall, Wayrest and Orsinium entrances, graveyard compatibility doors and old saved landings behave as before. A sweep of 2,755 entrances in Daggerfall, Wayrest, Orsinium, Sentinel, the Stuvam Graveyard and Gothway Garden found a walkable floor within 1.25 m of every doorway's bottom edge at its outward landing, so a general floor check is possible later.
- The live harness shifts only the atmosphere feature's clock (`install(ctx, {wallNow})`). `Date.now` is left alone.
