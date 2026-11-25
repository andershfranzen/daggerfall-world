# Classic combat and monster coverage

Detection uses the enemy's forward field of view, collision sight lines and a nearby Stealth check. Once alerted, an enemy can hear its target and pursue the last reported position. It gives up after about 12.5 seconds without detection. The server keeps each enemy near its authored area with a 22 m leash. Door-capable enemies call the dungeon's shared door service to open unlocked doors or attempt to bash ordinary locks. Monster movement uses Speed from the installed career record, with 50 as the fallback, and uses floor, flight or water constraints according to the creature. [Combat runtime](../server/rpg/combat.js) · [Daggerfall Unity EnemySenses](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/Game/EnemySenses.cs) · [Daggerfall Unity EnemyMotor](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/Game/EnemyMotor.cs)

A language roll happens on the first eligible encounter. The relevant skill, Personality, weapon readiness and Comprehend Languages affect the outcome. A pacified enemy stays passive for everyone until provoked. Quest foes keep their scripted hostility and owner-only targeting, attack events and loot. Enemy melee damage lands on its animation's hit frames. The armour roll and wear refer to the same body part. Creature exposure and weapon poison use the condition service after health damage. An arrow spends ammunition on release and tests the target and geometry again during flight. Enemy spell projectiles use the magic service. [Combat tests](../test/rpg-combat-monsters.test.mjs) · [Arrow and attack tests](../test/rpg-combat.test.mjs)

Play draws player and enemy arrows with model 99800 from the installed `ARCH3D.BSA`. The world renderer depth-tests the shaft against the scene. A short buffer gives the client time to interpolate to the server's wall or target contact. The arrow briefly holds at contact, then clears. Unconfirmed launches expire at their advertised range. A change of location, screen or connection clears the local flight state. [Arrow renderer](../client/gameplay/arrows.js) · [Flight and cleanup tests](../test/rpg-arrow-client.test.mjs)

Each corpse carries one set of contents. The killer's level determines level-scaled gold and drops. The loot table and the enemy's equipment can contribute goods. Eligible enemies can also drop a map, potion or recipe. Books, recipes and unidentified enchanted items keep their inventory metadata. Dungeon maps can be collected as items. Using one from the Play inventory, labelled “Read map”, follows the classic `RecordLocationFromMap` path for both classic templates, Maps 11:0 and MiscItems 27:7 (template 287), including records loaded from older saves. The reader learns one random place of their current region that MAPTABLE and that character have not yet discovered. The selection excludes ship decks and the Mantellan Crux. The place joins that character's travel map, one of the three TEXT.RSC 499 texts is shown, the notebook records “Discovered the location of … after studying a map.” and the map is used up. In an exhausted region the reader sees the classic “already discovered” refusal and the map is still used up. If the server's world map is not loaded, nothing is revealed and the map is kept. Discoveries and notes stay private to the reader. Repeating a read with the same map returns the first answer without another discovery. A failed save rolls back the discovery, note and consumption together. Guilds can use the same selection through `services.travel.discoverRandomLocation`. In a private-port check with temporary databases and installed data, a staged Mapreader character read both template records through Play, and the places appeared in the Notebook and as travel destinations. A second account looted a dropped map over the socket. That account could not use the first owner's map, and its read and the results kept after a restart stayed separate. [Map reading](../server/rpg/items/mapItem.js) · [Region selection](../server/rpg/travel.js) · [Map item tests](../test/rpg-map-item.test.mjs) · [Loot matrices](../server/rpg/items/loot.js) · [Alchemy and magic loot](../server/rpg/alchemy.js)

## Artifact allies

Using the Sanguine Rose summons a Daedroth. The Skull of Corruption spawns a fresh creature of the nearest eligible enemy's type, with its own health, equipment and spell state. Both look for a non-allied enemy within 12 m on the user's floor and spend 100 condition on a successful summon. The shared server places summons near their owner and excludes private and scripted quest foes and City Watch from the summon scan and AI combat. Pacified public enemies qualify for the scan and stay passive during the fight. [Sanguine Rose source](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/Game/MagicAndEffects/Effects/Special/SanguineRoseEffect.cs) · [Skull of Corruption source](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/Game/MagicAndEffects/Effects/Special/SkullOfCorruptionEffect.cs) · [Enemy targeting source](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/Game/EnemySenses.cs)

Everyone in the scene sees the same summon. It can fight ordinary hostile monsters, and they can strike back or pick it as their target. The server checks each melee contact against reach, floor, facing and sight. Monster arrows and missile spells use the same collision path as other projectiles. Summons and players are friendly when the summon appears. Among players, only the owner can harm it. A landed owner attack can turn the summon against that owner, following the reference's change of allegiance on a player hit. The shared server removes the summon when its owner leaves the scene, disconnects or is defeated. It starts each server session with no saved summons. [Combat runtime](../server/rpg/combat.js) · [Magic delivery](../server/rpg/magic.js) · [Enemy retaliation source](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/Game/EnemyMotor.cs)

Damage by a summon counts as its owner's contribution toward searching an ordinary enemy corpse. The normal loot table rolls once, using the summoner's level when the ally lands the final blow. After the usual contribution window the corpse opens to everyone, with a single successful claim. An allied finishing blow produces a shared death event with the monster as the killer. Player kill rewards, including feeding and party credit, require a player finishing blow. For shared-world reward consistency, an artifact summon itself has no loot, no trappable soul and no player kill credit. [Corpse rules](../server/rpg/combat.js) · [Soul trapping](../server/rpg/magic.js)

### Two-account checkpoint

Two signed-in WebSocket clients connected to a private server with temporary SQLite databases and installed classic records. The fixture granted a Sanguine Rose and placed a nearby Orc with staged health and fixed combat rolls. The owner used the Rose through `inventory.use`. Both clients received the same 21 HP allied hit and saw the Orc strike back. Both received one death event. The witness was refused an early loot claim, the summoner searched the corpse, and a second search was refused. Separate disk-backed runtime fixtures exercised Skull selection, same-floor and quest isolation, ally-to-monster bow and Fireball impacts, owner provocation and summon removal. [Two-account test and fixtures](../test/rpg-combat-allies.test.mjs) · [Artifact charge and item-use tests](../test/rpg-enchant-powers.test.mjs)

## Installed data and encounter sources

The creation and death check covers all 61 supported types, including 42 creatures and 19 humanoid careers. A separate asset test decodes the living and corpse archives. The installed dungeon census read all 4,232 dungeon records. It found 3,656 eligible fixed placements across 47 IDs and 288,467 random placements. Of the random placements, 230,005 name a slot directly. Sampling those slots at levels 1 and 20 yielded 32 and 39 IDs respectively. The 58,462 zero-slot markers draw from slots 1–6 at runtime. The dry or above-water filter excluded 135 Slaughterfish, one Dreugh and one Lamia marker. One fixed marker used invalid ID 99. [Census command](../tools/world-audit/enemies.mjs) · [Species creation and death](../test/rpg-combat-monsters.test.mjs) · [Asset decoding](../test/rpg-actors-data.test.mjs)

| ID | Source |
|---|---|
| 39 | `Horse_Invalid` has no `TEXTURE.294`. The classic game crashes if it is spawned. |
| 99 | Wayrest castle marker `S0000080.RDB:5/0` uses the invalid fixed ID. The stock RDB loader skips it. |
| 40 | The alternate Dragonling has a soul and is placed by the `B0B70Y16` quest. The installed QBN names mobile 40 and remote dungeon type 14. The alternate archive is 295 and its soul value is 500,000. ID 34 uses archive 289 and has no soul. |
| 146 | The City Watch uses `CLASS18.CFG` and enters through law or scripted spawning. Its creature and corpse load in the harness. |

The original fixed placements and two sampled levels yielded 56 distinct IDs together. Sampling levels 1, 8, 11, 14, 17 and 20, with all six possible outcomes for a deferred marker, found ordinary RDB sources for 58 types. The remaining three enter through climate, quest and law. [Source audit](../tools/world-audit/enemies.mjs) [Enemy catalogue](../server/rpg/combat/monsters.js) · [Classic enemy enum and loot source](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/Game/Items/ItemBuilder.cs)

## Live check at Privateer's Hold

Two signed-in clients on a temporary loopback server started at the exterior doorway with test stats and steel equipment. Both used the authored entrance and walked by regular movement input from the dungeon landing on the 38.4 m floor. Both damaged the Rat at `S0000999.RDB:1/5` and the Imp at `S0000999.RDB:1/6`. Each saw the same damage and death events. One collected the Imp's gold and the second received the already-searched response.

A Chromium Play run used the same entrance with a second signed-in WebSocket client. Right-button drags sent directional swings. The browser showed Wizard's Fire resistance and confirmed a three-gold Imp corpse claim. In a later socket run, the first player's steel cuirass lost one condition point and the Imp paid four gold. Armour location, fatigue accumulation, invisibility, swimming, spell and arrow impacts, and rest interruption are covered by focused tests. Infection was exercised through the condition service tests. The live encounter exercised the Rat and Imp, with the Giant Bat present near the entrance. [Combat tests](../test/rpg-combat.test.mjs) · [Monster tests](../test/rpg-combat-monsters.test.mjs) · [Magic tests](../test/rpg-magic.test.mjs)

Two signed-in Chromium clients tested arrows in `/play.html` on a private loopback server with temporary databases and installed art. The fixture started them at a saved lower-floor checkpoint facing the authored Archer at `S0000999.RDB:0/5`, with test archery stats, a steel short bow and lanterns. A controlled combat roll let the Archer loose an arrow that damaged one player. Right-button bow releases sent a player arrow into a stone wall and another into the Archer, spending one arrow each. Both clients received the same launch and impact records, drew the server's contact positions and continued rendering after all three arrows cleared. The focused tests also check private quest viewers, cancelled flights and range expiry. [Server tests](../test/rpg-combat.test.mjs) · [Play lifecycle tests](../test/rpg-arrow-client.test.mjs)

## Natural encounter follow-up

All 61 supported IDs appeared on the running installed-data server through their ordinary dungeon, climate, quest or law sources. The roster records 19 walked encounters, 36 spawn observations, four checkpoint defeats, the earlier checkpoint Archer test, and the City Watch response and defeat. IDs 39 and 99 remain archive and source checks.

Run `node tools/world-audit/enemies.mjs --sources` against the installed archives to reproduce the dungeon sources. The roster names one source per type. `L` is the seeding player's level, and a deferred slot is a possible draw from an authored marker with flags zero. In shared dungeons the first arrivals establish the level for that instance. A character needs to know a hidden dungeon's location to fast-travel there. The source rows identify archive and encounter table leads. Their routes through doors, drops and water passages remain unverified.

The private socket route used disposable accounts, saved equipment and exterior checkpoints at the authored doors. Each successful walk used normal movement and combat actions on the installed collision data. Controlled rolls made the deferred slot and rare map drop repeatable. **Spawned** means the client received the authored entity after entry. **Staged** means the test started at a saved interior checkpoint. **Source** means the row has an archive or table entry and no encounter playthrough at that site. [Live protocol](gameplay-protocol.md)

The Wereboar hit twice for nine damage at The Cave of Morkucheus and transmitted lycanthropy on a controlled exposure roll. The Ranger at Skulrarugoth's Web came from deferred slot 1, struck back and yielded equipment from one corpse claim. At The Hold of Kington, a steel blade did no damage to the Ghost and a Daedric blade killed it. The ordinary Dragonling at The Pit of Geryon closed the height gap before melee and left a corpse with an empty loot table. Castle Chevrn's Daedra Seducer cast a spell, transformed into its winged form and yielded loot after defeat. The Ice Atronach at The Wicksly Cabin, Mage at The Hold of Gaerfield and Harpy at Old Belladyssa's Shack also fought back before defeat. At The Wicksly Cabin and The Vojthrac Mews, the Spider and Giant Scorpion paralysed the scout and the server refused further swings.

Two clients took the authored door at Privateer's Hold and fought the fixed Rat and Imp. Both contributed damage to the Imp, both saw its death, and exactly one loot claim succeeded. The corpse's regular loot roll yielded a map. Its owner read it with `inventory.use`, received the installed TEXT.RSC discovery wording, consumed the item and could quote travel to The Hold of Buckingston. The witness received no map result and could neither read the owner's item nor quote that journey. This route used the enemy's drop with no map in the initial pack. [Drop rules](../server/rpg/combat.js) · [Map use](../server/rpg/items/mapItem.js)

The installed `B0B70Y16` quest was offered by Peryn Wicksmith of the Knights of the Dragon to a saved rank-7 member. The owner accepted, travelled to Jubithiva's Den and took its authored dungeon door. The second account took the same door, received no alternate Dragonling in its snapshots and was refused both attack and loot. The owner then fought and killed the Dragonling from a saved checkpoint on its floor. The witness received no combat events for the foe. The quest now honours the reference script's Dragon's Den requirement, including when the server searches for a replacement site before revealing it. The regression test checks a region with only an incompatible dungeon and then with a valid den. [Quest selection](../server/rpg/quests.js) · [Focused test](../test/rpg-quest-objectives.test.mjs) · [Classic reference quest](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/StreamingAssets/Quests/B0B70Y16.txt)

At midnight in Ayasofya, the intermittent outdoor spawn used the installed desert climate (224), night table 20 and a level-9 scout. The Acrobat appeared 12.7 m away. The scout walked up, fought and searched the corpse. In Gothway Garden, a real attempt to camp triggered the City Watch. Two level-6 enemies read `CLASS18.CFG`. The witness got no halt and took no Watch attack. After choosing Resist, the suspect defeated one Watchman and took its steel flail and armour. A second corpse claim was refused. [Law and combat contract](law.md)

Three aquatic encounters spawned below the collision water surface through their real doors. The Slaughterfish and Dreugh used fixed markers and the Lamia used underwater slot 3 at level 17. The scout resumed at saved underwater checkpoints and swam toward each foe before the fights. The Lamia and Dreugh yielded gold and equipment. The swimmer had to dive toward the Dreugh's corpse to get within vertical reach. The entrance-to-pool routes are still unverified.

For the spawn-only checks, a socket client entered Scourg Barrow, Castle Llugwych, Woodborne Hall, Orsinium, Castle Daggerfall, The Citadel of Lhofyl, The Moorston Cemetery, The Kingwing Cabin and The Cathedral of Jubith in sequence. Each listed entity matched a marker loaded by the running server. These checks exercised world entry and encounter seeding. Combat and individual approaches are recorded where exercised.

| ID | Enemy | Location | Source | Follow-up evidence |
|---:|---|---|---|---|
| 0 | Rat | Daggerfall / Privateer's Hold | `S0000999.RDB:1/5` · Fixed | Walked and defeated |
| 1 | Imp | Daggerfall / Privateer's Hold | `S0000999.RDB:1/6` · Fixed | Walked, shared kill, map loot |
| 2 | Spriggan | Wayrest / Woodborne Hall | `S0000101.RDB:5/4` · Fixed | Spawned |
| 3 | Giant Bat | Daggerfall / Privateer's Hold | `S0000999.RDB:1/0` · Fixed | Spawned |
| 4 | Grizzly Bear | Dragontail Mountains / Scourg Barrow | `S0000200.RDB:0/5` · Fixed | Spawned |
| 5 | Sabertooth Tiger | Orsinium Area / Orsinium | `S0000020.RDB:4/17` · L11 · deferred slot 4 | Spawned |
| 6 | Spider | Kambria / Ruins of The Wicksly Cabin | `B0000001.RDB:5/1` · L1 · slot 2 | Walked, paralysis blocked swings |
| 7 | Orc | Ykalon / Castle Llugwych | `S0000120.RDB:0/19` · Fixed | Spawned |
| 8 | Centaur | Wayrest / Woodborne Hall | `N0000016.RDB:1/64` · L11 · slot 1 | Spawned |
| 9 | Werewolf | Daenia / The Hold of Kington | `N0000089.RDB:5/6` · L8 · slot 2 | Walked and defeated |
| 10 | Nymph | Ykalon / Castle Llugwych | `W0000009.RDB:1/33` · Fixed | Spawned |
| 11 | Slaughterfish | Ilessan Hills / Ruins of Old Gwynabyth's Shack | `W0000006.RDB:5/35` · Fixed underwater | Spawned, staged swim and defeat |
| 12 | Orc Sergeant | Ykalon / Castle Llugwych | `S0000120.RDB:5/8` · Fixed | Spawned |
| 13 | Harpy | Ykalon / Ruins of Old Belladyssa's Shack | `B0000001.RDB:5/1` · L1 · slot 2 | Walked and defeated |
| 14 | Wereboar | Wrothgarian Mountains / The Cave of Morkucheus | `N0000089.RDB:5/6` · L11 · slot 2 | Walked and defeated |
| 15 | Skeletal Warrior | Dragontail Mountains / The M'ell Graveyard | `B0000003.RDB:1/0` · L8 · slot 1 | Spawned |
| 16 | Giant | Dragontail Mountains / Scourg Barrow | `S0000203.RDB:0/9` · Fixed | Spawned |
| 17 | Zombie | Dragontail Mountains / Scourg Barrow | `S0000205.RDB:1/3` · Fixed | Spawned |
| 18 | Ghost | Daenia / The Hold of Kington | `N0000089.RDB:5/6` · L14 · slot 2 | Walked and defeated |
| 19 | Mummy | Dragontail Mountains / Scourg Barrow | `S0000205.RDB:4/2` · Fixed | Spawned |
| 20 | Giant Scorpion | Wrothgarian Mountains / The Vojthrac Mews | `N0000035.RDB:0/64` · L8 · deferred slot 2 | Walked, paralysis blocked swings |
| 21 | Orc Shaman | Ykalon / Castle Llugwych | `W0000009.RDB:0/33` · L14 · slot 5 | Spawned |
| 22 | Gargoyle | Dragontail Mountains / Scourg Barrow | `S0000202.RDB:0/1` · Fixed | Spawned |
| 23 | Wraith | Dragontail Mountains / Scourg Barrow | `S0000205.RDB:5/24` · Fixed | Spawned |
| 24 | Orc Warlord | Ykalon / Castle Llugwych | `S0000120.RDB:5/9` · Fixed | Spawned |
| 25 | Frost Daedra | Ykalon / Ruins of Old Belladyssa's Shack | `B0000001.RDB:5/1` · L17 · slot 2 | Walked and defeated |
| 26 | Fire Daedra | Dragontail Mountains / Scourg Barrow | `S0000203.RDB:0/17` · Fixed | Spawned |
| 27 | Daedroth | Dragontail Mountains / Scourg Barrow | `S0000204.RDB:4/35` · Fixed | Spawned |
| 28 | Vampire | Anticlere / The Tower of Wickham | `N0000089.RDB:5/6` · L20 · slot 2 | Walked and defeated |
| 29 | Daedra Seducer | Myrkwasa / Castle Chevrn | `N0000089.RDB:5/6` · L17 · slot 2 | Walked, defeated and looted |
| 30 | Vampire Ancient | Dragontail Mountains / Scourg Barrow | `S0000205.RDB:4/7` · Fixed | Spawned |
| 31 | Daedra Lord | Anticlere / The Aviary of Moritor | `N0000089.RDB:5/6` · L17 · slot 2 | Walked and defeated |
| 32 | Lich | Dragontail Mountains / Scourg Barrow | `S0000201.RDB:1/16` · L17 · deferred slot 4 | Spawned |
| 33 | Ancient Lich | Dragontail Mountains / Scourg Barrow | `S0000205.RDB:4/8` · Fixed | Spawned |
| 34 | Dragonling | Wrothgarian Mountains / The Pit of Geryon | `N0000089.RDB:5/6` · L17 · slot 2 | Walked and defeated |
| 35 | Fire Atronach | Dragontail Mountains / Scourg Barrow | `S0000204.RDB:1/14` · Fixed | Spawned |
| 36 | Iron Atronach | Dak'fron / Ruins of The Old Bivem Shack | `B0000000.RDB:5/1` · L14 · slot 2 | Walked and defeated |
| 37 | Flesh Atronach | Glenpoint / The Hold of Gaerfield | `N0000089.RDB:5/6` · L8 · slot 2 | Walked and defeated |
| 38 | Ice Atronach | Kambria / Ruins of The Wicksly Cabin | `B0000001.RDB:5/1` · L11 · slot 2 | Walked and defeated |
| 40 | Dragonling (alternate) | Daggerfall / Jubithiva's Den | `B0B70Y16` · Knightly Order quest | Offered, entered, private spawn, staged defeat |
| 41 | Dreugh | Glenpoint / The Prison of Tristynak | `W0000006.RDB:5/34` · Fixed underwater | Spawned, staged swim, defeat and loot |
| 42 | Lamia | Daggerfall / The Hold of Moorston | `W0000007.RDB:1/1` · L17 · underwater slot 3 | Spawned, staged swim, defeat and loot |
| 128 | Mage | Glenpoint / The Hold of Gaerfield | `N0000089.RDB:5/6` · L1 · slot 2 | Walked, defeated and looted |
| 129 | Spellsword | Daggerfall / Daggerfall | `W0000013.RDB:0/1` · L14 · slot 6 | Spawned |
| 130 | Battlemage | Wayrest / Woodborne Hall | `S0000101.RDB:1/0` · Fixed | Spawned |
| 131 | Sorcerer | Dragontail Mountains / Scourg Barrow | `S0000202.RDB:4/3` · Fixed | Spawned |
| 132 | Healer | Dwynnen / Ruins of The Kingwing Cabin | `B0000006.RDB:4/1` · L1 · slot 6 | Spawned |
| 133 | Nightblade | Dragontail Mountains / Scourg Barrow | `S0000200.RDB:0/11` · Fixed | Spawned |
| 134 | Bard | Wrothgarian Mountains / The Moorston Cemetery | `B0000008.RDB:4/1` · L17 · slot 1 | Spawned |
| 135 | Burglar | Dragontail Mountains / Scourg Barrow | `S0000203.RDB:5/5` · Fixed | Spawned |
| 136 | Rogue | Wayrest / Woodborne Hall | `N0000016.RDB:4/42` · L11 · slot 2 | Spawned |
| 137 | Acrobat | Ayasofya / Ayasofya | `CLIMATE.PAK 224` · Night table 20 · L9 | Walked, defeated and looted |
| 138 | Thief | Dragontail Mountains / Scourg Barrow | `S0000203.RDB:5/7` · Fixed | Spawned |
| 139 | Assassin | Daggerfall / The Dungeon of Peristair | `N0000034.RDB:4/63` · L11 · deferred slot 4 | Spawned |
| 140 | Monk | Dwynnen / Ruins of The Kingwing Cabin | `B0000006.RDB:4/0` · L1 · slot 2 | Spawned |
| 141 | Archer | Daggerfall / Privateer's Hold | `S0000999.RDB:0/5` · Fixed | Staged Play archery |
| 142 | Ranger | Dragontail Mountains / Skulrarugoth's Web | `N0000005.RDB:0/50` · L8 · deferred slot 1 | Walked, defeated and looted |
| 143 | Barbarian | Ykalon / Castle Llugwych | `S0000120.RDB:4/4` · Fixed | Spawned |
| 144 | Warrior | Glenpoint / Ruins of Gaerwing Orchard | `B0000013.RDB:1/1` · L14 · slot 2 | Spawned |
| 145 | Knight | Ykalon / Castle Llugwych | `S0000120.RDB:4/1` · Fixed | Spawned |
| 146 | City Watch | Daggerfall / Gothway Garden | `CLASS18.CFG` · City Watch law encounter | Spawned, resisted, defeated and looted |
