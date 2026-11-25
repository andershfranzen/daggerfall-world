# World expansion milestone — a playable Iliac Bay

For the full classic feature queue, the tavern population census, and the remaining quest and spell IDs, see the [classic feature backlog](classic-feature-backlog.md).

Two players should be able to find a merchant in a real town, accept directions to a dungeon, travel together, retrieve the quest item, and return to the same shop. On foot they should see a town before they enter it, see each other across outdoor boundaries, and be able to retrace the route after reconnecting. The same loaders and placement rules should work across the classic map. This document is a proposed work order. The acceptance checks describe work still to do.

## Where to start

The installed `MAPS.BSA` contains **15,251 location records in 45 populated regions**, each at a different map pixel. Today the catalogue keys them by region and name. **354 places share 129 such keys**, leaving 225 records without a distinct lookup. In Alik'r Desert, both Djen Lodges appear in the source, at (310, 435) and (319, 483). Selecting a name can resolve to the first shrine for both. The installed map also has 4,052 initially hidden records. Travel currently retains at most 4,000 personal discoveries. These are inexpensive problems to reproduce before expanding the world. [Catalogue](../client/gameplay/travel/catalog.js) · [Travel persistence](../server/rpg/travel.js)

Towns, wilderness terrain, building interiors, dungeon geometry and encounter markers already load. Players already walk between town and wilderness, fast-travel from either, and share combat and loot. The World of Daggerfall loader already processes 329,040 published placement rows and the Port of Daggerfall town replacement. The next work connects these systems. Today an outdoor crossing replaces the scene, classic towns disappear from the wilderness view, and nearby peers can disappear at the location boundary. Town NPCs use spawn-relative slots and inner dungeon doors are drawn open. [Overland](overland.md) · [Wilderness renderer](../client/world/wilderness/README.md) · [Mod coverage](world-of-daggerfall.md) · [NPC placement](../server/rpg/npcs/rules.js) · [Dungeon layout](../client/world/interiors/layout.js)

## Dispatch order

Use one integration owner and up to three agents for the playable world work at a time. A–C start together. The public website map and the in-game Inventory and Equipment screens each have a separate owner. Dispatch agents on **Opus 5.5 Medium**. Use **6.2 Sol High Fast** only if an Opus agent cannot take the assignment after an attempt to resolve the obstacle.

| Dispatch | Work | What releases the next jobs |
| --- | --- | --- |
| 1 | **A. Place identity**, **B. World audit**, **C. Shared exterior geometry**. **Website map** runs alongside them. | A publishes record lookup and legacy-save examples. B produces a first census and named route records. C publishes position, height and collision examples for a town, its pixel and a neighbour. |
| 2 | **D. Exterior streaming** and **E. Multiplayer boundaries** consume A/C's contracts. **F. Settlements** consumes A/B's building records. | A town edge is walkable in both directions, the two players stay visible there, and a named building has a reachable occupant. |
| 3 | **G. Dungeon mechanisms**, **H. Wilderness and coasts**, **I. Original dungeon quest** | G can start after the initial audit as soon as a slot opens. H builds on C/D. I can implement against marker and merchant fixtures while F/G deliver the live records. |
| 4 | B's owner runs the final census and browser routes. E runs the moving-client benchmark. The integration owner resolves failures with the subsystem owner. | Publish the coverage matrix, remaining source exceptions, strict test result, performance comparison and two-account playthrough. |

The integration owner handles shared entry points and wiring in `client/main.js`, `client/gameplay/api.js`, both feature manifests, `server/game.js`, `server/rpg/runtime.js`, and the network protocol. Give each new packet, service and shared-file edit one writer. A owns the indexed readers in `client/world/maps.js` and `client/world/interiors/dungeonMaps.js`. G owns RDB action decoding. F supplies building records for quest placement and town services through one lookup. H supplies placement data to C/D through their agreed interface. Before splitting into worktrees, ensure each starts with the current project files. The checkout at planning time has no initial commit.

**First playable checkpoint.** Before integrating the quest, have two players start in Gothway Garden, walk out together, turn around while straddling the boundary, and return to a named shop. This short trip exercises the shared coordinates, streaming, peer visibility and town data together. Keep it as a regression when the dungeon and coast work lands.

### First handoffs

- **Map identity.** Use `catalog.at(regionIndex,index)` to resolve a source record and `catalog.atPixel(x,y)` for outdoor coordinates. The identity owner's agreed interface gives every record a numeric `slotId`. Use its `entry.id` for the shared instance. Unique names and the historical first match keep their existing save addresses, and later duplicates use numeric addresses.
- **Exterior coordinates.** The shared frame is in metres, with east increasing x and south increasing z. C will supply `townToWild`, `wildToTown`, `toGlobal` and `inPixel` in `client/world/exterior/frame.js`. Streaming and peer visibility should consume the same frame.
- **Audit routes.** Gothway Garden is 17/197 at (109,159). Daggerfall city is 17/1231 at (207,213). Privateer's Hold is 17/179 at (109,158). The Dungeon of Peristair (17/201) has a candidate linked switch and door in block `N0000051.RDB`. The nearby camp, farm and sea-level dock have site IDs `wod:109,158:21,21`, `wod:110,159:107,54`, and `wod:98,162:63,53`. These are source records for the named tests. Each route still needs its playthrough.

## Agent briefs

### World population, collision and conversation

The installed-data census covers 15,251 place records. The player-facing checks below extend that census to the inhabitants and interactions a traveller encounters. [Coverage results](world-coverage.md)

| Work | Player-facing acceptance check |
| --- | --- |
| NPC placement | For fixed people, resolve the original exterior or interior block, subrecord, local coordinates, facing and floor. Compare transformed coordinates to an independent reading of the source, including a rotated block and a stacked interior. For wandering people and quest actors, exercise their spawning and visibility conditions. Two players can find the same merchant in the correct business after rejoining. Count fixed placements, mobile types and quest-gated people separately. |
| Monster coverage | Trace each original mobile ID through encounter selection, server creation, client art, attacks and death. The starting catalogue contains 42 creature records and 18 human enemy classes. Check reserved IDs and story-only forms against the original records. Preserve encounter conditions and shared loot. |
| Dungeon access | Reconcile every one of the 4,232 associated dungeons. The first survey found 4,203 ordinary entrance-and-return routes, 28 graveyards without an exterior door face, and one quest-only destination. Verify real portal, collision, floor and return behaviour, including special entry and shared switches. |
| Wilderness collision | Hold a movement key against a source-backed solid prop, a boulder and a ruin wall. Compare the first-person camera with server positions. Walk down an adjacent clear path and across a scene boundary. Exclude distant visual terrain from the movement index. |
| Conversation in chat | Talk from the world and choose replies inside the chat area using mouse, keyboard or touch. Keep portraits and private dialogue there. Exercise directions, a quest offer, Goodbye, and a return from an explicitly opened shop or service. Verify that ordinary chat still works and a second player never receives the private exchange. |
| UI layout | Exercise HUD, chat and populated menus on desktop, 360 × 640 portrait, short landscape and at browser zoom. Verify reachable actions, visible focus and unclipped text during a conversation, an inventory change and travel. |

### In-game Inventory and Equipment

Own the inventory panel, equipment slots, paper doll, and item detail and comparison views. Make it easy to find a carried item, see what it would replace, equip or remove it, and confirm the result. Retain the existing game art, item dyes and server-authoritative actions. Verify the same interaction with keyboard controls and on a narrow viewport. Capture the running Play screen with the same character before and after equipping an item.

### Website map of online players

Own the website map page, navigation link, map-specific server module and HTTP route registration in `server/game.js`. The page reads the authoritative list of connected players and groups them by exterior location on a map of the Iliac Bay. Towns use their map pixel, wilderness uses the occupied pixel, and indoor players use their entrance location. Publish location names and counts. Keep player-specific state on the game connection. Use a basemap suitable for the public website and support the exported site on desktop and mobile.

**Accept when** two real clients appear at the correct location with a count of two, travelling separates the markers, entering a building keeps its player at the correct exterior, and disconnecting removes the marker when its last player leaves. Verify the public page also distinguishes an empty world from a failed refresh. Exercise it through the website navigation, capture desktop and mobile views, and verify the site build and server projection tests.

### A. Give every classic place a stable identity

Own the travel catalogue, index-based map and dungeon lookup, and travel persistence. Use the pair of region index and location index for classic records. Keep original and replacement names for display and search. Distinguish identical search results by map position. Cover exterior, building and dungeon addresses, discoveries, saved positions, active quests, wilderness returns and outstanding shop repairs. Give the integration owner the conversion for each consumer. For an ambiguous legacy name, use a saved discriminator when available, otherwise preserve the historical first-match result. Convert a save atomically and make repeat loading harmless. Keep starter saves usable while game data is absent or loading.

**Accept when** both Alik'r shrines independently resolve from search, load their own record, and survive save/restart. Port of Daggerfall and Copperfield Manor still lead to the same record. A legacy character saved indoors returns through the same door with their quest and repair intact. A character can retain every personally discovered location across restart.

### B. Measure coverage over the installed world

Own a new audit command under `tools/`, its test fixtures and coverage report. Walk records by numeric index from day one. For every classic record, resolve its exterior layout, referenced blocks and models, building entrances, associated dungeon, and required start/exit markers. Cache repeated block reads. Also classify the WoD placements accepted or rejected by the loader and unresolved optional dependencies. Run classic alone and with the installed pack. Save aggregate counts, denominators and small diagnostic identifiers. Keep source archives, meshes, original text and art local.

**Accept when** all 15,251 installed records reconcile by region and type, a duplicate name cannot hide a failure, and each failure identifies a place, asset reference, reason and owning brief. Add a deliberately broken fixture to prove the audit catches a missing core block. Generate the stratified route list below. Hand implementation failures to their owners and rerun the same census at integration.

### C. Make the town and its surroundings share one surface

Own the shared exterior frame and composition code, `server/rpg/overland.js`, and authoritative exterior collision. Reuse the existing 819.2 m pixel grid, town transforms, WOODS.WLD sampler and WorldData replacements. Set one height reference across neighbouring pixels, flatten the town footprint against that terrain, and place its wall and gate collision in the same position from either side. Supply D/E with forward and inverse transforms, terrain heights and stable object keys. Keep the server responsible for crossing and collision readiness.

**Accept when** the town-to-pixel-to-town round trip preserves position, a diagonal pixel corner agrees from all sides, a gate is walkable and its adjacent wall blocks approach from either side. Cover an ordinary settlement, an 8×8 city and the 3×3 port replacement. Compare browser and server height on identical surface samples to within 0.1 m. Verify a missing or loading destination cannot send the player through a wall.

### D. Keep the outdoor scene visible while walking

Own the browser's streaming and cache code around `client/gameplay/wilderness.js` and `client/world/wilderness/scene.js`. Render classic town blocks in their surrounding terrain. Prefetch neighbouring ground, buildings, flats and mod pieces, retain the current view until replacements are ready, and discard stale asynchronous results. Keep interiors and fast travel working through their existing entry points. Expose diagnostics for resident cells, geometry, textures and cancelled loads.

**Accept when** a player can hold movement from street to open ground, cross a pixel, turn around and walk back with the town visible on approach. Record a continuous live crossing with zero empty-world frames, duplicate buildings, or camera resets on a warmed route. Force one slow load and reverse direction. After ten round trips and the eviction interval, the cache returns to its declared bound.

### E. Keep nearby players visible across outdoor borders

Own outdoor visibility, coordinate conversion for remote actors, and the moving-client benchmark. Deliver the server and client adapters to the integration owner. Select peers by distance in the shared exterior frame and key each actor once across handoffs. Preserve existing interior instance scope, player-specific quest visibility, chat audiences and authoritative interaction reach. A visible player across a boundary should obey the same range checks as one on the same side.

**Accept when** two clients standing a few metres apart on opposite sides of a gate or pixel edge continue to see each other, walking across produces no duplicate peer, and entering a building removes the player from the exterior view. A distant account sees neither the pair nor their private objectives. Measure 2, 8 and 32 moving clients, clustered across one border and dispersed across regions. Report bytes per player, p99 tick and snapshot work, memory and cache residency against the existing one-town run on the same machine. Target p99 tick work under the 40 ms tick period and bounded idle caches. [Existing benchmark](world-performance.md)

### F. Make towns navigable by their buildings and inhabitants

Own settlement records, the NPC and town-services adapters, directions, and browser presentation of building contents. Reuse RMB people, flats, models, faction and building records. Link the same stable building and door to its occupant, sign or name, directions, automap and service counter. Preserve merchant stock, bank balances and pending repairs. Implement the merchant quest-giver handoff for I. Document deterministic placement rules wherever the classic data supplies a role without an exact position.

**Accept when** a fresh player can ask directions, walk to a named shop, open its actual door, find its merchant and transact. A second player sees the same business and shared stock. Exercise a second settlement of another size and a specialised service, such as banking or guild training. Include an interior capture showing the authored furnishings or flats and the reachable occupant.

#### F extension: every classic person, placed by the original rules

Every person category comes from the installed data and goes through the same server code: `server/rpg/npcs/people.js` (records → entities), `population.js` (mobile townspeople), `places.js` (active-location cache) and `world.js` (ARENA2 reads). With ARENA2 installed, no person stands at a spawn-relative slot. The old seven-slot street roster remains only for servers without game data. Rules follow Daggerfall Unity (MIT):

| Category | Source | Placement (output frame) | Presence and identity | Services |
| --- | --- | --- | --- | --- |
| Building people | RMB `BlockPeopleRecords` of the building's interior sub-record (14,174 records in BLOCKS.BSA) | `(x, −y, −z)·0.025` in the interior frame. `y` is the foot (`DaggerfallInterior.AddPeople` aligns the billboard to its base). Upper storeys keep their own `y` (3.225 m per storey). | Shops and buildings up to House4 only while open (`PlayerActivate` hours on the shared clock). Taverns, temples and palaces are always open. Name from `NameHelper` with `DFRandom.srand(Position ^ (buildingKey + locationIndex))` and the region's bank. Individuals use their FACTION.TXT name. Gender is `flags & 32`. | `StaticNPCClick`: guild-service faction ids (mages 60–66/801/802, fighters 849–851, temples 240/810/813 and per-god ids, TG/DB/KO), merchants by building type (shop, repair shop, bank, tavern), witches' covens, everyone else talks |
| Exterior people | RMB misc and building-exterior flats with a faction id, excluding editor (199) and light (210) flats. 75 records, all coven people plus one temple healer. | Base at `(x, −y−6, z+4096)·0.025` plus the block offset and `(sub.X, 0, −sub.Z)`, with no sub-record yaw (`RMBLayout.AddMiscBlockFlats/AddExteriorBlockFlats`) | FLATS.CFG decides gender (`StaticNPC.SetLayoutData`) | talk / coven |
| Dungeon people | RDB flats in `NPCFlatArchives` (85 records) | Centred at `(x, −y, z)·0.025` in the block at `(X, 0, Z)·51.2` (`RDBLayout.AddFlat`), then stood on the floor below with `collision.groundAt(location, x, z, centreY)` | `FactionOrMobileId` is the faction. Castle blocks (start marker magnitude ≠ 0) add the 1-in-4 castle questor (`IsCastleNpcOfferingQuest`). | talk / castle work |
| Mobile townspeople | `PopulationManager`, only for city, hamlet, village, farm, manor, temple and tavern locations (`StreamingWorld`) | Navgrid = empty automap cells × ground-tile weight (`CityNavigation`, 1.6 m cells). Spawn within 96 cells of a player and out of their 180° view or beyond 120 m. Walk 1.3 m/s cell to cell (`MobilePersonMotor`). Recycle beyond 150 m, after 5 failed seeks, or at dusk. | 06:00–18:00 only. Pool = clamp(blocks/16, 1, 4) × 24 per town, shared by all players and seeded per town and spawn. 1 in 32 is a guard (399). Otherwise 50% female, outfit 0–3, race from the climate. | news, rumours, directions (nearest building of each kind from the surveyed doors), and work (names today's questor and building) |
| Individuals | FACTION.TXT type 4 (58) | Their authored record, wherever one exists (34 have one). `services.npcs.individualHome(id)` finds it. The 24 without one are placed only by quests. | Hidden at home for a player while a quest places them elsewhere (`setIndividualAway`, `QuestMachine.SetupIndividualStaticNPC`) | talk / quest person |
| Quest people | QBN Person records (647 in the install) | The quest engine places them at interior and dungeon quest spawn markers 199/11 (`services.npcs.questSpawn(location)`); item markers 199/18 via `questItemMarkers` | Private per player (`visibleTo`), owned by the quest feature | quest |

**Quest givers.** Each game day, one in four merchants, commoners and nobles in named buildings offers work (`TalkManager.GetBuildingList`, 25%). The roll is seeded by person and day, so every player sees the same givers. Guild-service quest people (FG 851, MG 63, temples 240, TG 804, DB 807, KO 846) always offer work. Entities carry `questGiver` and `questGroup` ('Merchants', 'Commoners', 'Nobility', 'FightersGuild', 'MagesGuild', 'HolyOrder', 'GeneralPopulace', 'DarkBrotherHood', 'KnightlyOrder', 'Witches'), which the quest owner reads. There is no town crier.

**Identity and persistence.** Ids are `npc:i:<hash(interior)>:<people index>`, `npc:x:<hash(town)>:<bx>,<by>:<m|sN.k>`, `npc:d:<hash(dungeon)>:<bx>,<bz>:<root>.<index>` and `npc:m:<hash(town)>:<slot>`. They are stable across restarts because they derive from record positions. Shop stock is one ledger per building (`shop:<interior id>`), shared by every merchant and player there, and saved atomically to `$DFW_NPC_STATE` / `config.npcStatePath`. Legacy roster ids (`npc:<hash>:<slot>`) are never spawned. `services.npcs.resolve(id, town)` maps them to the source person who now plays the part. Repair tickets left with a legacy smith can be collected at any real repair counter in the same town.

**Reach.** Players can talk within DFU's static/mobile activation distance (6.4 m) and on the same storey (feet within 1.6 m). Active locations stay loaded while occupied and for 30 s after, with at most 24 loaded at once.

**Audit.** `node tools/npc-audit.mjs [--record r/i] [--mode classic|pack]` walks all 15,251 locations through parse → place → appearance → identity → service → reachable for each category, then writes counts, exceptions and owners to the ignored `progress/npc-audit/`. Installed classic census: 607,462 building people across 11,025 locations (9,411 distinct block records, every one in a building with a paired door), 549 exterior people (75 records), 85 dungeon people, mobile pools in 9,373 town-type locations (237,840 capacity; 5,878 dungeon/shrine/cottage/coven/graveyard/ship locations correctly have none), 34 of 58 individuals authored, 647 QBN people, and 80,346/153,525 interior and 10,415/10,334 dungeon spawn/item markers. All of these pass every stage. Expected source exceptions: 24 individuals, and the 12 QBN references to them, exist only through quests; #304 has no flat. Daggerfall's three `CUSTAA05` records 4–6 hold no people, and the castle court lives in the castle's RDB blocks.

The doors, room titles, counter, work directions and quest Journal now share names generated from the installed building records. The Order of the Raven in Tunhead uses its chapterhouse record to resolve the guild.

**Still missing:** tavern room prices by quality and stay length, food and drink, guild-hall access after hours for members, per-building greetings and rumour tables, the TG/DB/KO, spell, potion, enchanting and teleport services (people stand there and talk), and wilderness and World of Daggerfall site people.

### G. Make authored dungeon mechanisms usable

Own `client/world/interiors/` action/layout work, the dungeon interaction service and its tests. Decode stable RDB object references, ordinary action doors and a linked switch/door chain. Expose actual quest-item placement markers with block, position and floor for I. The server owns activation, floor, reach, door state and collision. Preserve state while anyone occupies the instance. Start a documented grace period when the last player leaves, cancel it if anyone returns, and reset the instance when it expires. Save personal quest progress separately so it survives that reset.

**Accept when** one player opens a door or activates a switch and a second sees and traverses the same opening. The same input from another floor fails. Repeated activation, reconnect and instance reset leave door state and collision consistent. Demonstrate an authored mechanism from the audit and a stacked-floor entry/exit in Privateer's Hold. Inventory unsupported action types with counts for the next milestone.

### H. Finish representative wilderness, farm and coastal routes

Own site-specific placement and encounter fixes in the wilderness subsystem and dedicated fixtures. Cover an empty pixel, a farm block, a camp, and a coastal dock. Check seasonal variants, waterline, dock alignment, walkable surfaces and encounters against the pinned pack and its placement rules. Connect authored roads and paths where the installed records supply them. Reuse existing combat markers and loot ownership. Expose resolvable doors in wilderness RMB buildings through the portal service. For missing resource-pack models, report the omitted pieces and keep the remaining site usable.

**Accept when** two players walk onto the same camp, fight one shared encounter and search a corpse once. Walk into and back out of an authored farm building. At the coast, capture the dock against the water and check collision on available geometry. Repeat the classic route with WoD disabled. An empty pixel remains traversable, and optional assets never account for a passing classic geometry check.

### I. Play one original dungeon quest through two browsers

Own the quest address resolver, marker selection, the quest regression and browser scenario. Use ***A Rare Book*** (`K0C00Y08`). The local QBN/QRC catalogue identifies it as a merchant quest with no membership requirement. Its script grants gold at the start, reveals a remote dungeon, places a book there, and rewards its return to the giver. The current analyser flags the dungeon place, and the runtime currently has no merchant role in its quest-giver mapping. F supplies the merchant, A the destination identity and G the marker. The DFU reference script specifies a 5–50 gold advance and a separate completion payment. The current classic decompilation emits a generic gold item for the advance. Check the original item parameters, book type and expiry behaviour before enabling the offer. Preserve the existing two-account `A0C00Y21` regression. [Quest engine](../server/rpg/quests/engine.js) · [Quest coverage](gameplay-coverage.md)

**Accept when** two fresh signed-in players can meet, find the merchant, follow the revealed destination, enter the dungeon, and return using the normal Play screen. The second player can help fight ordinary shared enemies. Only the accepting character sees and claims their book and receives the scripted payments. Verify balances separately for the starting payment and completion reward. Disconnect the owner mid-objective, restart on the same temporary database, resume and turn in. A second pickup, a second turn-in, or inviting the helper to a party yields no additional payment. Exercise the expiry branch in a timed fixture. A saved test seed or operator quest list may select the quest for reproducibility. Record that choice in the report.

## How to call the milestone complete

Report five distinct coverage columns. Each one needs its own numerator and denominator. A passing catalogue sweep establishes how many places exist. Only a completed route establishes what a player can do there.

| Coverage | Required evidence |
| --- | --- |
| Catalogued | Every installed record resolves by key and pixel. Count classic records and WoD placement rows separately. |
| Geometry loaded | Sweep every applicable exterior layout, interior and dungeon reference, and build each distinct block used. Also assemble complete scenes for the route sample. Record missing optional packs, genuine source anomalies and implementation failures separately. |
| Reachable | For every populated region and every represented location type, exercise at least one applicable spawn and entry/return using production travel, portal and collision logic. Include the two ship records in the census and classify any ownership prerequisite. |
| Interactable | Reproduce the named service, quest, dungeon mechanism, farm and encounter checks above. Record the tested count within each kind. |
| Multiplayer-verified | Record the exact routes two live browsers completed, the reconnect point and the persistent result. Count automated server sweeps and live browser routes separately. |

Use the **Gothway north road** and its neighbouring pixel for continuous walking, **both Alik'r Djen Lodges** for identity, **Copperfield Manor / Port of Daggerfall** with the pack off and on for replacements, **Privateer's Hold** for stacked floors, and **the dungeon chosen by the merchant quest** for discovery and progression. Let the census supply stable records for a farm, dock, camp, 8×8 city and switch-linked door. Include desert, wooded and mountain exteriors in the sample. The two-browser routes use normal controls without injected coordinates, inventory or objective progress.

Pass the existing suite on the installed data with `RPG_INTEGRATION_STRICT=1 npm test`, the new coverage/benchmark gates, and a classic-only run of the affected paths. Every core implementation failure revealed by the census needs a fix and rerun before its coverage row can pass. An authored missing entrance or absent optional dependency gets a reproducible record and its own count. Run each agent's server on its own port with temporary databases and a separate browser profile. Capture meaningful milestones on `/play.html`, label fixture evidence, and keep game data, mod files and captures in their existing private or ignored locations.

## What follows

Use the audit results to order the next work. First extend the quest resolver to more dungeon objectives and guild quest pools using the measured blocker counts. Then connect additional dungeon actions, world-affecting spells and faction routines to those same buildings and actors. The main campaign needs its own plan for named NPCs, story triggers and persistent consequences. Ship ownership, optional companion packs and public hosting are separate release decisions.
