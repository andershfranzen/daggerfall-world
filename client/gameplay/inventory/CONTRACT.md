# Inventory contract notes

Owner: `server/rpg/inventory.js` (server) and `client/gameplay/inventory.js` (browser).
Shared protocol: `docs/gameplay-protocol.md`.

## Character fields (in `rpg` / the `character` of each `rpg` message)

- `inventory`: array of item records. Every record is self-describing, so other features never need the catalogue:
  `{id, template, base, index, group, name, material, quantity, condition, maxCondition, weight, value, stackable, world:{archive,record}, icon:{archive,record,set?}, equipped?}`
  - `group`: `weapon | armor | shield | clothing | ammo | potion | gem | ingredient`.
  - Clothing adds `slot, dye, variants` and a saved `variant` (style index). The classic male and female archive records can have different variant counts. Armour can also carry an explicit classic `variant` record offset. Trades, transfers and merchant stock preserve the saved style.
  - Wearables carry `doll:{set, record | male/female, drawOrder, dye, cloak?}` for the paper doll. The art archive depends on the wearer: weapons use 234 (male) or 233 (female), armour `249/245 + body` and clothing `239/235 + body`. `client/gameplay/inventory/images.js` `itemArt()` resolves this.
  - Weapons add `slot:'rightHand', hands:'either'|'both', skill, weaponType, weaponFile, damage:{min,max}, materialModifier`.
  - Armour and shields add `slot, armorValue, covers:[bodyPart…]`. `icon.set:'armor'` means the archive depends on the wearer: `245 + body` (female) or `249 + body` (male), body = Argonian 0, elves 1, others 2, Khajiit 3.
  - Potions add `effect:{stat, amount}`.
  - `equipped` is the slot name while the item is worn.
- `equipment`: slot → item id. Slots: `head, rightArm, leftArm, chestArmor, gloves, legsArmor, feet, rightHand, leftHand, cloak, chestClothes, legsClothes`, plus the jewellery pairs `amulet0/1, bracer0/1, ring0/1, bracelet0/1, mark0/1`. Footwear and armoured boots share `feet`, as in the classic game. A two-handed weapon in `rightHand` keeps `leftHand` empty. Jewellery follows `ItemEquipTable.GetFirstSlot`: an item goes in the open slot of its pair, or replaces slot 0 when both are full. Amulets, torcs and cloth amulets share the amulet pair. Wands have no slot. Older saves without these slots load unchanged.
- `gold`: integer. Gold weighs 1 kg per 400 pieces, as in the classic game.
- `inventoryVersion`: starter kit marker. Version 1 is the sample kit and 100 gold. Version 2 adds starter clothes (white short shirt and brown casual pants, both worn, plus a blue casual cloak and brown shoes). Each step is granted once, so rejoining never duplicates it.
- `weaponView`: **for the first-person weapon view**. It is always present after join:
  `{itemId|null, template, name, weaponType, weaponFile, material, hands}`.

## Weapon view mapping

`weaponType` → `weaponFile` matches Daggerfall Unity `WeaponBasics.GetWeaponFilename`. These are the classic ARENA2 CIF names; read them from the player's files:

| weaponType | weaponFile | templates |
|---|---|---|
| `Dagger` | `WEAPON02.CIF` | dagger |
| `LongBlade` | `WEAPON04.CIF` | tanto, shortsword, wakizashi, broadsword, saber, longsword, katana, claymore, dai-katana |
| `Staff` | `WEAPON01.CIF` | staff |
| `Mace` | `WEAPON05.CIF` | mace |
| `Flail` | `WEAPON06.CIF` | flail |
| `Warhammer` | `WEAPON07.CIF` | warhammer |
| `Battleaxe` | `WEAPON08.CIF` | battle-axe, war-axe |
| `Bow` | `WEAPON09.CIF` | short-bow, long-bow |
| `Melee` | `WEAPON10.CIF` | unarmed (`template:'unarmed'`) |

Magic variants (`WEAPO1nn.CIF`) are not produced yet. Peers expose `weapon:{template,name}` through the runtime. Derive the type from the template base when needed, or call `ctx.services.getEquippedWeapon(p)`.

## Templates

Template keys are `<material>-<base>` (or `<dye>-<base>` for clothing), such as `iron-longsword`, `steel-dagger`, `chain-cuirass` or `daedric-helm`. A bare base gets the default material: iron for weapons, leather for armour. Shields, ammo, potions and gems have no material, for example `buckler`, `arrow`, `potion-of-healing` or `ruby`. `gold` is currency.
Clothing bases: shoes, tall-boots, sandals, casual-pants, breeches, loincloth, long-skirt, short-shirt, long-shirt, vest, open-tunic, short-tunic, plain-robes, priest-robes, casual-cloak, formal-cloak. Dyes: blue, grey, red, brown, purple, tan, white, aquamarine, yellow, green (`client/gameplay/inventory/dyes.js`).
Weapon materials: iron, steel, silver, elven, dwarven, mithril, adamantium, ebony, orcish, daedric. Armour adds leather and chain. Weight, value, condition and armour values follow the classic multipliers in `ItemBuilder.cs`.

## Services (`ctx.services`)

| service | notes |
|---|---|
| `giveItem(p, template, qty=1, {variant}?)` | Returns the record. Merges stacks. Accepts `'gold'`. Throws a user-readable Error. |
| `takeItem(p, itemId, qty=1, {allowEquipped}?)` | Returns a detached record. Use `itemId:'gold'` for currency. **Refuses equipped items** unless `allowEquipped`. |
| `transferItem(from, to, itemId, qty=1)` | Atomic, keeps condition. |
| `addGold(p,n)` / `takeGold(p,n)` | |
| `findItem(p, template)` / `countItem(p, template)` | |
| `getEquippedWeapon(p)` | Returns the record, or an `UNARMED` pseudo-item with `damage`, `skill:'Hand-to-Hand'` and `weaponFile:'WEAPON10.CIF'`. |
| `getArmorValues(p)` | `{head,rightArm,leftArm,chest,hands,legs,feet}` |
| `damageItem(p, itemId|'weapon', amt)` / `damageArmor(p, amt, part?)` | Wear an item. A broken item unequips and notifies the player. |
| `carriedWeight(p)` / `maxEncumbrance(p)` | Maximum is Strength × 1.5 kg. |
| `spawnLoot(location, x, z, contents, name)` | Returns a `kind:'loot'` entity id. A single item uses its classic world record. Mixed contents use the classic heap, and the sprite refreshes when an item is taken. Piles expire after 10 minutes. |
| `itemCatalogue()` / `describeItem(template)` | |

## Actions

`inventory.equip {itemId, slot?}`, `inventory.unequip {itemId|slot}`, `inventory.use {itemId}` (drink potions or toggle gear), `inventory.drop {itemId|'gold', quantity?}`, `inventory.inspectLoot {targetId}`, and `inventory.loot {targetId, itemId?}`. Looting requires the pile to be within 3.5 m and in the same location, and it respects encumbrance.

## Events

- `ctx.emit('inventoryChanged', {player, reason})` after every change.
- Inventory pickup messages may include `artItems` for the toast. An inspected pile sends `{kind:'loot', targetId, name, items}`.
- On `kill` with a monster, inventory leaves a loot pile unless the payload has `noLoot:true` or the entity has `noLoot`. Set either one when combat awards loot itself.

## Browser

Panel `inventory`. Press **I** to open it. The panel uses classic tabs (Weapons & Armor, Magic Items, Clothing & Misc, Ingredients), a filter and a keyboard-navigable listbox. It also has a details pane, Equip, Drink and Drop controls, a paper-doll slot grid, armour ratings by body part, gold and carried weight, and loot piles in the current location.
While an action is waiting for the server, the status line names it with `pendingLabel(action, item)` in `inventory/model.js`, for example “Lighting Torch…”, “Drinking Potion of Healing…” or “Equipping Ring…”.
Item icons come from the player's `TEXTURE.nnn` and `ART_PAL.COL` files, with dyes applied. `getItemArtSource(api)` shares the file-backed cache with other panels. Without the source files, the inventory shows letter placeholders.

### Paper doll

The paper doll composites the classic dressed character from the player's files: `SCBG0rI0.IMG` background, `BODYsrI0.IMG` body, `BODYsrI1.IMG` underclothes where no shirt, armour or legwear covers them, and head record `faceIndex` of `FACEsrI0.CIF`. Here `s` is 0 for male and 1 for female, and `r` is the race file index (Breton 0 … Argonian 7). The cloak lining goes behind the body, and equipment draws in template order. Item mask index 0xFF clears the character layer and its click target. Clicking a visible equipment pixel selects the item. The image requires the clothed body, face and palette. The slot buttons remain available when image data is incomplete.
Modules: `inventory/images.js` (IMG/CIF readers adapted from the MIT dfjs edition, item art addressing), `inventory/paperdoll.js` (pure compositor, hit testing), `inventory/dyes.js`. The race-portrait work (`character/art.js`) owns face pickers. The paper doll only reads `character.race`, `character.gender` and `character.faceIndex`, and uses `faceIndex` as the record in `FACE{s}{r}I0.CIF`, exactly as Daggerfall Unity's PaperDollRenderer does. Keep that indexing in sync.

## Ordinary items, books, lights and containers (package 7)

- **Classic ordinary templates.** `server/rpg/items/classicTemplates.js` is generated by `tools/gen-classic-items.mjs` from the Daggerfall Unity `ItemTemplates.txt` and `ItemEnums.cs` (MIT, revision 3d85a28). It adds every ingredient, gem, jewellery, religious item, drug, book, light, map, painting, quest prop and miscellaneous item. Keys are kebab-cased template names, for example `red-flowers`, `holy-candle`, `soul-trap`, `parchment` and `book`. A name that collides gets its group as a suffix (`gold-ingredient`). Records carry `classicGroup` and `groupIndex`. `templateForClassic(groupId, groupIndex)`, `templateForIndex(index)` and `classicGroupTemplates(groupName)` map classic references to keys. `registerBases(obj)` adds another owner's templates at install time and never replaces a key.
- **Groups added:** `light`, `book`, `letter`, `jewellery`, `religious`, `drug`, `map`, `painting` and `quest`. Ingredients, oil and books stack (`FormulaHelper.IsItemStackable`). Enchanted and quest items never stack, and books stack only with the same `bookId`.
- **Per-item state** (`ITEM_EXTRAS`, kept by normalisation, transfers and containers, ≤ 4 KB each):
  - `magic {enchantments:[{type,param}], identified, name?, uses?, value?, soul?, artifact?}`. The displayed name is `magic.name` only once the item is identified. Charges are the item's condition (MAGIC.DEF `uses` → maxCondition).
  - `bookId` is the installed `BOKnnnnn.TXT` number. The name, value and `author` come from that file (DFU price rule: DFRandom seeded with the first four bytes, 300–800).
  - Other keys: `letter {title, lines, from?}`, `quest {...}`, `owner {...}`, `recipe {...}` and `stolen {from, at}`.
  - `giveItem(p, template, qty, {variant, extra})` and `makeItemRecord(template, qty, extra)` accept them.
- **Lights.** `rpg.lightSource = {itemId, template, name, radius, condition, maxCondition} | null`. A light burns one condition point every 20 s (EnablePlayerTorch). Torches and candles are consumed at zero. The lantern stays and takes oil when the oil fits (`lantern.condition <= max − oil.condition`). Action: `inventory.light {itemId}`.
- **Reading.** `inventory.read {itemId}` (or `inventory.use` on a book or letter) sends `{kind:'book', itemId, title, author, pages:[lines[]]}` to the reader only. The pages come from the operator's own book files and are never stored in the save.
- **Identification and charges.**
  - Services: `identifyItem(p, id) → {ok, name, already}`, `unidentifiedItems(p)`, `identifyCost(item) = (25·value)>>8` and `useItemCharge(p, id, amount = 10)` (CastWhenUsed).
  - `inventory.use` on an enchanted item goes to `services.useMagicItem` (package 16). If that service doesn't handle the item, it falls back to `services.castItemSpell` (package 9) and spends 10 charges. A spent magic item is destroyed.
- **Encumbrance.** The base capacity in kilograms is floor(effective Strength × 1.5). An intact, equipped Increased Weight Allowance item adds 25% or 50% of that base, rounded down. The strongest allowance applies. The pack and server use the same capacity for pickups and transfers.
  - `encumbrance(p) → {carried, max, over, sinks}` and `canCarry(p, kg)`.
  - `sinks` is DFU's swimming rule (carried × 4 > 250) for the movement owner.

### Shared containers (`server/rpg/containers.js`)

Sites come from the instance scene (`client/world/interiors/containers.js`, classification from DaggerfallInterior / RDBLayout):

| containerType | where | stocking |
|---|---|---|
| `treasure` | dungeon 199/19 and 216/n flats; 199/19 in taverns, Thieves Guild and Dark Brotherhood buildings | `DaggerfallLoot.GenerateItems` with the loot key of the dungeon type or town location type. Loot keys J–O add the map, potion and potion-recipe rolls. A pile is stocked on its first search and never restocked. The first finder empties it for everyone, and later joiners, reconnects, instance resets and restarts do not refill it. |
| `house` | private furniture (models 418xx and 41000 + house indices) | StockHouseContainer by building type and model record. Restocked when the classic stocked date (year·1000 + day) has passed. Needs the private-property confirmation; taken items get `stolen` and the feature emits `itemStolen`. |
| `storage` | furniture in an interior `services.ownsInterior(p, location)` reports as owned, or `containers.createStorage(spec)` | not stocked; `container.put` is allowed |
| `bookshelf` | library, guild hall and temple shelves | ten installed books to read in place. Guild halls and temples require membership. |
| `shelf` | shop shelves | belong to the shop owner (economy.js). They appear here only if an adapter is registered. |

- **Entities:** `{id:'ct:<site>@<location>', kind:'container', containerType, name, x, y, z, empty, sprite?}`. Treasure is drawn from TEXTURE.216. Furniture has no sprite; G opens the container the player faces within 3.2 m.
- **Actions:** `container.open {containerId, confirm?}`, `container.take {containerId, itemId?, quantity?}`, `container.put {containerId, itemId, quantity?}` and `container.read {containerId, bookId}`. Taking respects encumbrance, and the server serialises actions, so of two players taking the same item only one succeeds. Other players viewing the container get a refreshed list.
- **Persistence:** contents are world-state rows `containers/<location>#<site>`, saved in the same transaction as the player who changed them.
- **Services:** `containers.list(location)` (Detect Treasure), `sites(location)`, `contents(id)`, `ready(location)`, `registerAdapter(type, {open, take, put})` and `createStorage({location, id, x, y, z, name})`.
- **Treasure extras:** a map is the ordinary `map` template, which is read through `inventory.use` (`server/rpg/items/mapItem.js`). Potions come from `services.randomPotionLoot` and recipes from `services.randomPotionRecipeLoot`. Magic items come from `services.randomMagicItem` (package 16). Descriptors may carry their per-item state as `extra` or `appearance.extra`, and both are kept. Without a supplier the roll is skipped and is reported as `skipped`, as before.
- **Keys:** the installed `ItemTemplates` define no key item, and no RDB door asks for one. Locked dungeon doors are picked, bashed or opened with Open, and quest scripts call `dungeonLocks.unlock(p, id, {method:'key'})`.
- **Loot helpers:** `server/rpg/items/loot.js` provides pure, seedable versions of LootTables matrices A–U, GenerateRandomLoot, GenerateItems (`generateItems(key, {extras})`), dungeon treasure, StockHouseContainer, the shop item-group tables, RandomMaterial and RandomArmorMaterial, and the random weapon, armour, clothing, group item and book generators.
