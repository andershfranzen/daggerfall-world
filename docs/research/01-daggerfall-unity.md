# 01 — Daggerfall Unity (DFU) as client and code source

This report evaluates the native client option. The project subsequently selected the [browser implementation](../browser-architecture.md).

Source examined: `Interkarma/daggerfall-unity` @ `3d85a28` (2026-11-13), cloned read-only into `.ref/daggerfall-unity`. Nothing was built or run. All paths below are relative to `Assets/` unless noted. **[V]** means verified in source. **[I]** means inferred or not checked.

## Summary and recommendation

- **Client: DFU 1.1.1, pinned.** It is MIT-licensed, feature-complete and still maintained, though slowly. Its mod system can load our own precompiled C# DLL with full access to engine internals, and it has many usable hooks: static events, 87 overridable formulas, custom activations, replaceable UI windows and mod save data.
- **Phase 1 needs no fork.** Remote avatars, position and facing sync, animation state and chat can all be built as a pure mod.
- **Later phases will probably need a thin fork.** Authoritative combat, shared enemies and loot, shared world time, and server-side persistence collide with DFU's deep single-player assumptions:
  - `GameManager.Instance.PlayerEntity` is referenced 458 times across 143 files.
  - Enemy AI only ever targets "the" player.
  - Generation is unseeded and runs on the client.

  Budget for a small, upstream-style patch set (new events and virtual methods), not a divergent fork. Every existing DFU co-op project ended up modifying core files.
- **Server: option (b) grown through option (c).** Build a standalone .NET server that starts as a thin relay/state server: it owns identities, characters, position, chat and time, and trusts clients for combat at first. It gains authority subsystem by subsystem, reusing a vendored copy of DFU's `DaggerfallConnect` readers to load maps, blocks and locations for validation.
- **Reject option (a), a headless DFU server.** `StreamingWorld`, `FloatingOrigin` and `PlayerEnterExit` each centre on one player and one active context (exterior, interior or dungeon). One DFU process can therefore only simulate one place at a time, which contradicts "one dedicated server".
- **Network position format:** `{context, ids, local position, yaw}`.
  - Exterior: Daggerfall world coordinates (`PlayerGPS.WorldX/WorldZ`, integer DF units of 2.5 cm) plus height.
  - Building interior: `(mapId, buildingKey)` plus a position local to the `DaggerfallInterior` transform.
  - Dungeon: `mapId` plus a position local to the `DaggerfallDungeon` root.
  - Never send raw Unity positions: floating origin shifts the scene on every map-pixel change.
- **Remote players are drawn with the humanoid "class" enemy sprites.** `MobileTypes` 128–145 map one-to-one onto the 18 base classes, come in male and female versions, and have move, idle, attack, hurt and spell animations, with 8 facing directions handled by `DaggerfallMobileUnit`.
- **Top risks:**
  1. The single-player entity model blocks shared PvE and PvP without a fork.
  2. Enemy AI depends on Unity physics and level geometry, so the server cannot simulate it without Unity. Shared enemies will most likely need a model where one client simulates each area and the server validates.
  3. World time and time skips (rest, fast travel, jail) are a game-design decision, not just a technical one.
  4. The project is tied to Unity 2019.4, which is end-of-life. Every client mod must match the DFU build exactly.
  5. Prior art (Tanguy's co-op fork and its successors, and "Daggerfall Enhanced") shows the demand, and also that those projects ended up as forks.

---

## 1. Basics

| Item | Finding |
|---|---|
| Licence (DFU code) | MIT, `LICENSE` (repo root, "Daggerfall Workshop") and `Licenses/Daggerfall Unity.txt` **[V]** |
| Licence (DaggerfallConnect readers) | MIT, `Licenses/Daggerfall Connect.txt` **[V]** |
| Bundled third-party | Full Serializer (MIT, `Resources/FullSerializer - Unity.dll`), INI File Parser (MIT, `Resources/INIFileParser.dll`), mcs C# compiler (MIT/X11, `Game/Addons/CSharpCompiler/Plugins/mcs.dll`), Unity Console (MIT), C# Synth (MIT), iTween (`Scripts/External/iTween.cs`) — `Licenses/*.txt` **[V]**. `Standard Assets/Environment`: licence not checked **[I]** |
| Game data | Not in the repo; the user supplies their own `arena2` folder (README) **[V]** |
| Unity version | `ProjectSettings/ProjectVersion.txt`: **2019.4.41f2**; `Scripts/VersionInfo.cs:23` baseline 2019.4.40f1 **[V]**. 2019.4 LTS is past end of support **[I]** |
| Runtime | Standalone scripting backend Mono (`ProjectSettings.asset:686-688`, value 0), API level .NET 4.x (`:705`), `runInBackground: 1` (`:79`) **[V]** |
| Version | `VersionInfo.cs:20` = "1.1.1" **[V]**. Latest GitHub release is "DFU 1.1.1 – Security Update" (`v1.1.1-cve-2025`; only the UnityPlayer binary was replaced). Previous releases: 1.1.1 (May), 1.1.0-rc, 1.0.0 (Dec 2023) **[V, web]** |
| Activity | 2026 so far has 1–15 commits per month, mostly merged community PRs (for example #2815 on 2026-11-13). The original lead stepped back after 1.0, and the project is now community-maintained **[V git log; lead stepping back is from web/release notes]** |
| Assembly layout | **No `.asmdef` files.** All scripts, including `DaggerfallConnect`, compile into one `Assembly-CSharp` **[V]** (`find -name '*.asmdef'` returned nothing) |

## 2. Mod system

**How code is loaded [V]**
- A `.dfmod` is an AssetBundle. `Mod.cs:908-927` sorts its assets into source files (`*.cs.txt`) and precompiled assemblies (`*.dll.bytes`).
- `Mod.CompileSourceToAssemblies` (`Mod.cs:946-974`) loads precompiled DLLs with `Assembly.Load(bytes)` (`:962`) and compiles source with the bundled mcs (`ModManager.cs:770-782`).
- The compiler references **every loaded assembly**, including `Assembly-CSharp` (`CSharpCompiler/Compiler.cs:51-63`). Mods therefore see all public engine types, and can reach private members through reflection.
- Entry points are static methods tagged `[Invoke(StateManager.StateTypes.Start|Game, priority)]` (`ModTypes.cs:240-253`). They are called from `ModManager.InvokeModLoaders` (`ModManager.cs:716-746`).

**Supported extension points [V]**
- **Formula overrides:** `FormulaHelper.RegisterOverride` (`Formulas/FormulaHelper.cs:3262`), with 87 override sites. These cover hit, damage, saving throws, random spawn rolls (`:1886-1925`), prices and more.
- **Custom activation** by model ID or billboard: `PlayerActivate.RegisterCustomActivation` (`Game/PlayerActivate.cs:136,149`).
- **UI window replacement:** `UIWindowFactory.RegisterCustomUIWindow` (`UserInterfaceWindows/UIWindowFactory.cs:120`). It covers Rest, TravelPopUp, Inventory, Trade, Talk, Court, UnitySaveGame, PauseOptions and others (`:19-64`), and the engine opens windows through the factory in 71 places.
- **Custom content:** items (`ItemCollection.RegisterCustomItem`, `Items/ItemCollection.cs:38`), guilds (`GuildManager.cs:33`), merchant and guild services (`Guilds/Services.cs:156-224`), enemy careers (`DaggerfallEntity.cs:959`), quest lists (`QuestListsManager.cs:138`), factions (`API/FactionFile.cs:710`).
- **Persistence and console:** serializable objects (`SaveLoadManager.RegisterSerializableGameObject`, `Serialization/SaveLoadManager.cs:551`), per-mod save data (`mod.SaveDataInterface`, `SaveLoadManager.cs:1206`), console commands (`ConsoleCommandsDatabase.RegisterCommand`).
- **Static events:**
  - `StreamingWorld`: `OnTeleportToCoordinates`, `OnFloatingOriginChange`, and others (`Terrain/StreamingWorld.cs:1762-1852`)
  - `PlayerGPS`: `OnMapPixelChanged`, `OnEnterLocationRect`, and others (`Internal/PlayerGPS.cs:1360-1405`)
  - `PlayerEnterExit.OnTransition*` (`Game/PlayerEnterExit.cs:1443-1520`)
  - `SaveLoadManager.OnSave/OnStartLoad/OnLoad` (`:1585-1603`)
  - `GameManager.OnEncounter/OnEnemySpawn` (`GameManager.cs:1114,1127`)
  - `WorldTime.OnNewHour/OnNewDay`, and others (`Internal/WorldTime.cs:154-235`)
  - `DaggerfallRestWindow.OnSleepTick/OnSleepEnd` (`:800,809`)
  - `DaggerfallTravelPopUp.OnPreFastTravel/OnPostFastTravel` (`:561,570`)
  - `FloatingOrigin.OnPositionUpdate` (`Utility/FloatingOrigin.cs:198`)
  - `UserInterfaceManager.OnWindowChange` (`UserInterface/UserInterfaceManager.cs:42`)
- **Asset replacement:** world data, textures and models (`Utility/AssetInjection/*`).

**What a mod cannot do (without runtime patching)**
- Change logic inside non-virtual methods that has no hook. Examples:
  - `EnemySenses` picks its target from `GameManager.Instance.PlayerEntityBehaviour` (`Game/EnemySenses.cs:223`).
  - Damage is applied locally in `WeaponManager`/`EnemyAttack`.
  - `WorldTime.Update` advances time with `Time.deltaTime` (`Internal/WorldTime.cs:60-67`).
  - `PlayerEntity.Update` runs world-wide simulation (`Entities/PlayerEntity.cs:440-500`).
  - Generation seeding (section 4).
- Add a second `PlayerEntity`, or change the singleton `GameManager` structure.
- Shipping Harmony (`0Harmony.dll`) inside a mod as `.dll.bytes` should work under Mono **[I, not verified]**. It would let a mod patch everything listed above, but it is brittle across DFU versions.

**Verdict.** Phase 1, which only adds observers and renders remote players, is realistic as a pure mod: a precompiled DLL in a `.dfmod`, using plain `System.Net.Sockets` or a bundled .NET-Standard networking library **[I]**. Authoritative gameplay needs engine changes in these places, which should be done as a thin fork:
- `EnemySenses`/`EnemyMotor`/`EnemyAttack`: target selection across several players
- `WeaponManager` and `FormulaHelper` damage application: route hits to the server
- `WorldTime`: server clock
- `PlayerEntity.Update`: split world simulation from player simulation
- `SaveLoadManager`: server-backed persistence
- `RDBLayout`/`DaggerfallDungeon`/`LootTables`: seeding

## 3. World streaming and positioning

**[V]** One Unity scene; three parent objects `ExteriorParent`, `InteriorParent`, `DungeonParent` (`PlayerEnterExit.cs:60-62`), only one enabled at a time (`EnableExteriorParent/InteriorParent/DungeonParent`, `:1037-1108`).

- **Units.** 1 DF unit = `MeshReader.GlobalScale` = 0.025 Unity units (`Scripts/MeshReader.cs:58`); `StreamingWorld.SceneMapRatio = 40` (`StreamingWorld.cs:151`). The world is 32,768,000 × 16,384,000 DF units; a map pixel is 32768 DF units = 819.2 m; 1000 × 500 map pixels (`API/MapsFile.cs:33-47`). Conversion: `MapsFile.MapPixelToWorldCoord / WorldCoordToMapPixel` (`:409-431`, Y is flipped: `499 - y`).
- **Player world position.** `PlayerGPS.WorldX/WorldZ` (int DF units, `Internal/PlayerGPS.cs:43-45`). `StreamingWorld.Update` integrates the player's scene movement into them each frame (`StreamingWorld.cs:302-310`) and **stops updating them inside dungeons** (`:296-299`). `CurrentMapPixel` is derived from them (`PlayerGPS.cs:141-143`).
- **Streaming.** When the player's map pixel changes, `StreamingWorld.Update` places a (2·TerrainDistance+1)² grid of terrains around that **single** player and then updates locations (`:242-271`, `UpdateWorld` `:602-614`).
- **Floating origin.** `FloatingOrigin.FixedUpdate` (`Utility/FloatingOrigin.cs:92-135`):
  - On a map-pixel change, it shifts the player and every child of the streaming target by one map pixel (819.2 m).
  - It recentres Y when the player goes beyond ±500 (`:32`).
  - It records the shift in `StreamingWorld.WorldCompensation` (`:176-181`) and raises `OnPositionUpdate`.
- **Interiors.** `TransitionInterior` builds the interior under `InteriorParent`, positioned at the door owner's current scene position plus the building matrix (`PlayerEnterExit.cs:681, 734-735`). The exterior is disabled. The building identity is `buildingKey = (layoutX<<16)+(layoutY<<8)+recordIndex` within the current location (`Game/BuildingDirectory.cs:197-201`).
- **Dungeons.** A `DaggerfallDungeon` GameObject is created under `DungeonParent` (`Utility/GameObjectHelper.cs:1431-1446`). Its blocks are placed at `block.X/Z * RDBSide` local positions (`Internal/DaggerfallDungeon.cs:319`). The layout depends on the **SmallerDungeons** setting, or on the quest that pinned it (`API/MapsFile.cs:783-796`, `:1389` seeds the reduced layout by MapId).
- **The save format already encodes "where"** as `PlayerPositionData_v1`: scene position, worldCompensation, worldPosX/Z, insideDungeon/insideBuilding, exteriorDoors and buildingDiscoveryData (`Serialization/SerializableGameObject.cs:222-245`).

**Recommended network coordinate**
```
Exterior : ctx=0, worldX:int32, worldZ:int32 (DF units, 2.5 cm), y:float (scene.y − WorldCompensation.y), yaw
Interior : ctx=1, mapId:int32, buildingKey:int32, local xyz:float (interior.transform.InverseTransformPoint), yaw
Dungeon  : ctx=2, mapId:int32, local xyz:float (dungeon root InverseTransformPoint), yaw
```
- To render a remote exterior player locally, place it relative to the local player: `scene = localPlayerScenePos + (remoteWorld − localWorld) × 0.025`. This sidesteps floating-origin bookkeeping.
- Show remote interior or dungeon players only when the context IDs match.
- The server must enforce one SmallerDungeons value, an identical DFU version, and no world-altering mods (`WorldDataReplacement`). Building keys, block layouts and positions all depend on them. Visty93's co-op fork documents desync when the SmallerDungeons setting differs between players **[web]**.
- **[I]** Exterior height relative to `WorldCompensation.y` is inferred from `FloatingOrigin.OffsetPlayerController` and `RepositionPlayer` (`StreamingWorld.cs:1348`); validate it in Phase 1.

## 4. Player and entities

**Representation [V]**
- Base class: `DaggerfallEntity` (`Entities/DaggerfallEntity.cs`) holds stats, skills, resistances, career, health, fatigue and magicka, `Items` and `ItemEquipTable`. Subclasses are `PlayerEntity` (2463 lines), `EnemyEntity`, `CivilianEntity`.
- A Unity component, `DaggerfallEntityBehaviour`, wraps each entity.
- Items: `DaggerfallUnityItem` (`Items/`). Effects and spells: `EntityEffectManager` per entity (`MagicAndEffects/EntityEffectManager.cs`, 2333 lines), with effect classes discovered by `EntityEffectBroker`.

**Enemies [V]**
- An enemy is the prefab `DaggerfallUnity.Option_EnemyPrefab`, created by `GameObjectHelper.CreateEnemy` (`Utility/GameObjectHelper.cs:1197-1231`). It carries:
  - `EnemyMotor`: CharacterController plus 15 physics/controller calls
  - `EnemySenses`: line-of-sight raycasts
  - `EnemyAttack`
  - `EnemyHealth`/`EnemyDeath`
  - `DaggerfallEnemy`
  - a `DaggerfallMobileUnit` billboard child
- `EnemySenses` caches `player = GameManager.Instance.PlayerEntityBehaviour` (`EnemySenses.cs:223`). Secondary targets exist but only for allies (`:326-343`).
- Spawning:
  - Dungeon fixed and random monsters: `RDBLayout.AddRandomEnemies` (`Utility/RDBLayout.cs:480-541`)
  - Intermittent world encounters: `PlayerEntity.IntermittentEnemySpawn` → `GameObjectHelper.CreateFoeSpawner` (`PlayerEntity.cs:547-600`)
  - Quest foes: `GameObjectHelper.cs:1087`
- Loot: `LootTables.GenerateRandomLoot` (`Items/LootTables.cs:176-241`). Gold and item counts scale with the **local player's level** (`:194`).

**Combat maths [V]**
- `FormulaHelper.CalculateAttackDamage` (`FormulaHelper.cs:538`), `CalculateWeaponAttackDamage` (`:730`), `CalculateSuccessfulHit` (`:796`), `CalculateStruckBodyPart` (`:863`), `DamageEquipment` (`:1080`), `SavingThrow` (`:1443,1559`).
- All of them are overridable, but they read the player and UI singletons directly. Examples: `GameManager.Instance.PlayerEntity` (`:551`), `WeaponManager.ScreenWeapon` (`:597`) and `PlayerEffectManager` (`:1312-1347`), with 45 such references in this file.
- Pure-maths portions (min/max damage, skill math) are easy to extract.

**Determinism.** In practice, generation is not reproducible across machines. The table shows where it is and isn't seeded **[V]**.

| What | Seed | Ref |
|---|---|---|
| Location and dungeon **block layout** | Fixed by MAPS.BSA/BLOCKS.BSA; "smaller dungeon" seeded by MapId | `MapsFile.cs:1389` |
| Classic dungeon enemy **types** | `DFRandom` seeded by LocationId | `RDBLayout.cs:517,1439-1470` |
| Dungeon enemy placement and alternate selection | `UnityEngine.Random.InitState(seed)` with seed = `DateTime.Now.Ticks` | `RDBLayout.cs:510,1360,1419`; `DaggerfallDungeon.cs:315` |
| Dungeon textures | LocationId (classic) or random, per setting | `DaggerfallDungeon.cs:184-193` |
| Loot | `Random.InitState(items.GetHashCode())`, × player level | `LootTables.cs:191-194` |
| Combat rolls | Unseeded `UnityEngine.Random`, some reseeded with `Time.frameCount` | `FormulaHelper.cs:151,348,659,736,870` |
| Quest foes | `DateTime.Now.Millisecond` | `Questing/Foe.cs:284,293` |
| Quest machine | internal seed | `QuestMachine.cs:668` |

So the static world is deterministic, but everything that spawns is not. To make it reproducible, the server would hand out seeds and the RDBLayout, DaggerfallDungeon and LootTables seed sites would be patched. A pure mod can't change those sites.

## 5. Serialization

**Format [V]**
- `SaveLoadManager` writes one folder per save containing JSON files produced by FullSerializer: `SaveData.txt`, `SaveInfo.txt`, `FactionData.txt`, `QuestData.txt`, `DiscoveryData.txt`, `ConversationData.txt`, `NotebookData.txt`, `WorldVariationData.txt`, `AutomapData.txt`, `QuestExceptions.txt`, and one file per mod (`SaveLoadManager.cs:41-57, 1086-1210`).
- `SaveData_v1` (`SerializableGameObject.cs:82-98`) contains:
  - `PlayerData_v1` (`:141-152`): position, `PlayerEntityData_v1`, guilds
  - enemies, loot containers, bank, scene cache
- `PlayerEntityData_v1` (`:155-200+`) holds stats, skills, vitals, `equipTable`, `ItemData_v1[] items/wagonItems/otherItems`, gold, spellbook (`EffectBundleSettings[]`), live effect bundles (`EntityEffectManager.cs:2077`), region data, and rented rooms.

**Reuse as wire and persistence format**
- **Good fit for persisting characters.** `PlayerEntityData_v1`, `ItemData_v1` (`:267-300`) and `EffectBundleSaveData_v1` are plain data classes. Their only Unity types are `Vector3` and `Quaternion`, in position and scene data (`:224-225, 333-404`). Reusing them means DFU's own load path can restore a character.
- **Not a good wire format.** It is JSON, uses reflection-heavy FullSerializer, carries whole-character snapshots, and embeds scene state (`sceneCache`, `enemyData`) that only makes sense on one client.
- Item UIDs come from a per-save global counter (`DaggerfallUnity.NextUID`, `DaggerfallUnity.cs:134,482`; persisted as `SaveData_v1.currentUID`). In multiplayer the server must allocate them.
- Custom items are resolved by `className` (`ItemCollection.cs:609-615`), so the server must know which mods are active.
- **Recommendation:**
  - Store characters server-side as versioned `PlayerEntityData_v1`-compatible JSON. Copy these POCO classes into the server, replacing `Vector3` with a 3-float struct.
  - Use a compact purpose-built binary protocol on the wire.
  - **[I]** Loading a server character into the client should, at least at first, go through DFU's normal path: write the save files locally, then call `SaveLoadManager.Load`. DFU's load path restores the scene (`:596`, `:1330+`), and re-implementing that is high-risk.

## 6. Single-player assumptions, ranked (hardest first)

| # | Assumption | Evidence | Difficulty | Mod? |
|---|---|---|---|---|
| 1 | Exactly one `PlayerEntity`, used as the implicit target and actor | 458 refs in 143 files; `EnemySenses.cs:223`; `FormulaHelper.cs:551,597`; `EntityEffectManager.cs:296,1830,2263` | Very hard for shared PvE and PvP. Easy if remote players are never entities on the client | No. Needs fork or Harmony |
| 2 | Enemies, loot and spawns simulated locally with unseeded random and Unity physics | Section 4 table; `EnemyMotor`/`EnemySenses` use CharacterController and raycasts | Hard. Needs either per-area authoritative clients or server-side physics | Partial: can suppress random spawns via `RollRandomSpawn_*` overrides and observe via `OnEnemySpawn`; can't reseed |
| 3 | Quest system is one global `QuestMachine` per game with its own clock, NPCs and foes | `Questing/QuestMachine.cs:441,1838`; quests pin dungeon layout (`MapsFile.cs:783-796`) | Hard if shared. Medium if quests stay **per-player and instanced** (quest NPCs and foes visible only to their owner) | Per-player: yes, persist `QuestData` server-side. Shared: no |
| 4 | World time advances locally (12× real time), freezes when paused, and jumps on rest, travel, jail, training and lycanthropy | `WorldTime.cs:32,60-67`; `RaiseTime` in `DaggerfallTravelPopUp.cs:344-374`, `DaggerfallCourtWindow.cs:475,485`, `DaggerfallRestWindow`, `LycanthropyEffect.cs:487`, `VampirismEffect.cs:308`, `VampirismInfection.cs:161` | Medium technically, but a **design decision**: a shared clock means rest and fast travel can't move world time | Mostly. Set time from the server (`DaggerfallDateTime.FromSeconds`, as `SaveLoadManager.cs:1019` does). Rest and travel windows are replaceable. Effect-driven `RaiseTime` calls need patches |
| 5 | `PlayerEntity.Update` runs world simulation: regional prices, faction power, weather, racial-override quests, guard spawns, minute-by-minute catch-up | `PlayerEntity.cs:440-500` | Medium. Should become server-driven | No (not virtual). Tolerable in Phase 1 |
| 6 | Local save/load is the persistence model; loading rebuilds the scene | `SaveLoadManager.cs:374-425,1330+` | Medium | Yes. Replace the `UnitySaveGame`/`PauseOptions` windows and drive load from server data |
| 7 | UI windows pause the game (`Time.timeScale = 0`) | `GameManager.cs:600-620`; `UserInterfaceManager.cs:183`; `UserInterfaceWindow.PauseWhileOpen` | Easy technically; the gameplay change (you're vulnerable in menus) is a design call | Yes. Custom window subclasses set `PauseWhileOpen=false`, or `OnWindowChange` un-pauses. Network code must use unscaled time or a thread |
| 8 | Random encounters are per-player rolls | `PlayerEntity.cs:547-600`; `FormulaHelper.cs:1886-1925` | Easy to disable; spawning them for several players is harder (#2) | Yes (formula overrides) |
| 9 | Floating origin and single-player streaming | Section 3 | Easy for clients (use relative placement) | Yes |

## 7. Server reuse

**What can run without Unity [V, static scan only, not compiled]**
- `Scripts/API` has 64 files, nearly all in namespaces `DaggerfallConnect`, `DaggerfallConnect.Arena2/.Save/.Utility`.
- 48 of them have no `UnityEngine` reference and no `DaggerfallWorkshop` using: `BsaFile`, `Arch3dFile`, `DFBlock`, `DFLocation`, `DFRegion`, `DFCareer`, `WoodsFile`, `MonsterFile`, `FlatsFile`, `PakFile`, `ItemsFile`, `MagicItemsFile`, `ClassFile`, `TextFile`, `SndFile`, `TextureFile`, `ImgFile`, `CifRciFile`, `DFRandom`, and all of `Save/*` except `SaveGames`, `CharacterRecord`, `SaveVars`, `SpellRecord`. Only residual hit: `DFPosition.cs:65` calls `DaggerfallUnity.LogMessage`.
- **`UnityEngine` occurrences:**
  - `BaseImageFile.cs:16` (Mathf/Color)
  - `BiogFile.cs:18` (Debug, `Application.streamingAssetsPath`)
  - `BookFile.cs:16` (Debug)
  - `DFBitmap.cs:13`
  - `DFValidator.cs:139-181` (`Resources.Load`)
  - `FileProxy.cs:13,532` (`Resources.Load` fallback)
  - `FlcFile.cs:12`, `VidFile.cs:13` (Debug)
  - `FactionFile.cs:1021` (commented out)
  - `MapsFile.cs:1382` (commented out)
  - `Save/SaveGames.cs:20`
- **Game-layer coupling in key readers:**
  - `MapsFile.cs:19,783-796,984,999`: `QuestMachine`, `DaggerfallUnity.Settings.SmallerDungeons`, `WorldDataReplacement`
  - `BlocksFile.cs:214,273,385,850-861`: `WorldDataReplacement`
  - `FactionFile.cs:712`: `DaggerfallUnity.LogMessage`
  - `BiogFile`/`BiogFileMCP`/`CharacterRecord`: `GameManager`, `TextManager`
- **Porting cost:** vendor about 50 files with:
  1. a small `UnityEngine` shim (`Debug`, `Mathf`, `Color32`/`Color`, a `Resources.Load` stub)
  2. a stubbed `WorldDataReplacement` (no world mods on the server)
  3. `MapsFile.GetSmallerDungeon*` changed to take a server config value instead of `QuestMachine`
  4. `DaggerfallUnity.LogMessage` routed to a logger

  Estimate: **2–5 days** to compile on .NET 8, plus golden tests against the real data **[I estimate]**. MIT permits vendoring with the notice.
- **Not portable as-is:**
  - Terrain heights come from `DefaultTerrainSampler` (Unity.Jobs/Collections/Mathf, `Terrain/DefaultTerrainSampler.cs:12-15,55-119`). The maths is small and portable, but a "same height as client" guarantee needs a careful port.
  - `RMBLayout`/`RDBLayout`/`MeshReader`/`GameObjectHelper` build GameObjects. Building and marker positions have to be recomputed from `DFBlock` data.
  - Collision geometry: `Arch3dFile` gives raw meshes (Unity-free), but there is no server physics.
- **Data files the server needs** (all present in the provided `gamedata/.../arena2`; checked by size only, not read): `MAPS.BSA` (22 MB), `BLOCKS.BSA` (33 MB), `WOODS.WLD` (26 MB), `CLIMATE.PAK`, `POLITIC.PAK`, `MONSTER.BSA`, `FACTION.TXT`, `FLATS.CFG`, `SPELLS.STD`, `MAGIC.DEF`, `TEXT.RSC`. `ARCH3D.BSA` (27 MB) is needed only for geometry checks. This is the set `Utility/ContentReader.cs:290-302` and `DFValidator.cs:82-86` open **[V]**.

**Server options**

| Option | Effort | Risk | Verdict |
|---|---|---|---|
| (a) Headless DFU build as server | Low to start (it's the game). High to make multi-player: every singleton, `StreamingWorld` centred on one `LocalPlayerGPS`, `FloatingOrigin` on one `Player` tag (`FloatingOrigin.cs:66`), one active Exterior/Interior/Dungeon parent | **Very high.** One process can simulate only one location context; needs a fork of the game and Unity 2019.4 Linux server builds (EOL). The DFU licence is fine, but the Unity runtime and editor are not open source. Heavy memory and CPU per instance | **Reject** as "the" server. A headless DFU could later be a per-dungeon worker, but even that is unlikely to be worth it |
| (b) Standalone .NET server reusing DFU readers | Medium: readers port in days; game rules (formulas, items, effects) have to be ported piece by piece, untangling them from singletons | Medium: rule drift between client and server if both sides aren't fed the same code. Mitigate by sharing a ported "rules" assembly that both client mod and server reference | **Target architecture** |
| (c) Thin relay/state server, trusting clients first | Low: identities, character storage (save-data JSON), presence, position fan-out with interest management by context and map pixel, chat, world clock | Low technical risk; cheating is trivial early on (acceptable for a hobby launch, not for competitive PvP) | **Start here**, inside the (b) codebase, then move authority over step by step: movement sanity checks (speed, map bounds via MapsFile) → inventory/gold/trade → damage validation → loot and spawn seeding |

## 8. Phase 1: remote players walking in one town, plus chat

Everything below is reachable from a mod **[V for APIs, I for the overall plan]**.

**Bootstrap**
- A mod DLL with `[Invoke(StateManager.StateTypes.Start, 0)] static void Init(InitParams p)` (`ModTypes.cs:243-253`).
- `Init` creates a `DontDestroyOnLoad` GameObject carrying a `NetClient` MonoBehaviour. Networking runs on a background thread.
- Inbound messages go into a queue that is drained in `Update`, using `Time.unscaledDeltaTime` so the queue keeps draining while UI windows pause the game.

**Sending local state at 10–20 Hz**
- Position: `GameManager.Instance.PlayerGPS.WorldX/WorldZ` (`PlayerGPS.cs:43-45`), plus Y = `PlayerController.transform.position.y − StreamingWorld.WorldCompensation.y` (`StreamingWorld.cs:146`).
- Facing: `PlayerMouseLook.Yaw` (`PlayerMouseLook.cs:81`).
- Movement flags: `PlayerMotor.IsRunning/IsCrouching/IsStandingStill/IsGrounded/IsRiding/IsSwimming` (`PlayerMotor.cs:93-168`).
- Combat flags: `WeaponManager.IsAttacking()` (`WeaponManager.cs:890`), `WeaponManager.Sheathed` (`:50`).
- Context: `PlayerEnterExit.IsPlayerInsideBuilding/IsPlayerInsideDungeon`, `BuildingDiscoveryData.buildingKey`, and `PlayerGPS.CurrentMapID`.

**Context and world-shift events**
- Transitions: `PlayerEnterExit.OnTransitionInterior/Exterior/DungeonInterior/DungeonExterior` (`PlayerEnterExit.cs:1459-1489`).
- Teleport and map-pixel changes: `StreamingWorld.OnTeleportToCoordinates` (`:1771`), `PlayerGPS.OnMapPixelChanged` (`:1360`).
- Floating origin: `FloatingOrigin.OnPositionUpdate` (`:198`). Remote avatars placed relative to the local player don't need this, but it is useful as a safety resync.
- Save, load and new game: `SaveLoadManager.OnLoad` (`:1603`), `StartGameBehaviour.OnNewGame`. Both mean "re-announce".

**Rendering remote players**
- **Build:**
  - Root GameObject: its rotation is the remote yaw.
  - Child object: `MeshFilter` + `MeshRenderer` + `DaggerfallMobileUnit`.
  - Configure it with `mobileUnit.SetEnemy(DaggerfallUnity.Instance, GameObjectHelper.EnemyDict[(int)MobileTypes.Mage + classIndex] (with .Gender set), MobileReactions.Passive, 0)` (`Internal/Base/MobileUnit.cs:118`; `GameObjectHelper.cs:34`; pattern from `Game/SetupDemoEnemy.cs:77-96`).
  - Drive animation with `ChangeEnemyState(MobileStates.Move|Idle|PrimaryAttack|Spell|Hurt)` (`MobileUnit.cs:137`; states `DaggerfallUnityEnums.cs:217-228`).
- **Why it works:**
  - Billboarding and the 8-direction choice relative to the camera are already handled in `DaggerfallMobileUnit.Update/UpdateOrientation`, using the parent's forward direction (`DaggerfallMobileUnit.cs:143-163, 315-330`).
  - Humanoid IDs 128–145 are the 18 classes Mage…Knight (`DaggerfallUnityEnums.cs:189-208`), each with male and female textures (`Utility/EnemyBasics.cs`, `FemaleTexture` entries).
  - Custom classes map to the closest base class.
- **Don't use `GameObjectHelper.CreateEnemy` or the enemy prefab.** It attaches AI, motor and health, registers with `ActiveGameObjectDatabase` and raises `OnEnemySpawn` (`GameObjectHelper.cs:1197-1231`). The result would be a hostile, attackable enemy.
- **Alternative:** `MobilePersonBillboard` (civilian sprites, `Internal/MobilePersonBillboard.cs`). It only has Redguard, Nord and Breton sets plus guards (`:118-127`), only idle and move animations (`:135-160`), and no attacks, so it is a worse fit.
- **Caveats:**
  - Animation uses `WaitForSeconds` (`DaggerfallMobileUnit.cs:590`), so it freezes while the local game is paused. That is acceptable.
  - There is no built-in world-space name tag; draw one with a small `OnGUI` or DaggerfallUI overlay **[I]**.

**Placement and visibility**
- Exterior: `scene = localPlayer.position + (remoteWorldXZ − localWorldXZ) × 0.025`, y taken from the remote player. Hide avatars more than about 1 map pixel away.
- Interior and dungeon: show only when `(mapId, buildingKey)` or `mapId` match, and place via `interior.transform.TransformPoint(local)`.

**Chat**
- Input: a custom `DaggerfallPopupWindow` containing a `TextBox` (`UserInterface/TextBox.cs:24`), with `PauseWhileOpen = false` (`UserInterface/UserInterfaceWindow.cs:139-142`), opened by a hotkey polled in the `NetClient` MonoBehaviour.
- Output: `DaggerfallUI.AddHUDText` (`Game/DaggerfallUI.cs:759`) for the HUD log.
- Slash commands: `ConsoleCommandsDatabase.RegisterCommand` (`Game/Addons/UnityConsole/Console/Scripts/ConsoleCommandsDatabase.cs:19`).

**Phase 1 hygiene (optional, all mod-level)**
- Disable random encounters with `FormulaHelper.RegisterOverride` on `RollRandomSpawn_*` (`FormulaHelper.cs:1886-1925`).
- Push server time with `WorldTime.DaggerfallDateTime.FromSeconds`.
- Pin `SmallerDungeons` and the DFU version during the handshake.

## Prior art (web, not code-reviewed)
- **Tanguy's DFU multiplayer:** MIT; a modified DFU 0.14.5 build where you join the host's save. Continued by forks, including Visty93 "Daggerfall-Unity-Co-op" on DFU 1.1.1, which modifies core DFU files and moves interiors and dungeons underground (y −500) so players in different contexts don't overlap. It also requires matching dungeon-size settings.
- **"Daggerfall Enhanced"** (announced September 2026): described as a DFU-based persistent online server with synced time, 24/7 shops and grouping. Its architecture and licence weren't stated in the sources found.
- Worth a dedicated look before Phase 1 to borrow ideas and avoid their pitfalls.

Sources: [GitHub releases](https://github.com/Interkarma/daggerfall-unity/releases), [Visty93/Daggerfall-Unity-Co-op](https://github.com/Visty93/Daggerfall-Unity-Co-op), [SPLATPLAYS/DFU-Tanguy-Multiplayer-v1.1.0-Temporary-Builds](https://github.com/SPLATPLAYS/DFU-Tanguy-Multiplayer-v1.1.0-Temporary-Builds), [sixthlaw/DaggerfallMultiplayer_Sixthlaw](https://github.com/sixthlaw/DaggerfallMultiplayer_Sixthlaw), [ixbt.games on Daggerfall Enhanced](https://ixbt.games/en/news/2026/09/26/spustia-30-let-the-elder-scrolls-ii-polucila-multipleer-vysel-mmo-mod-s-kruglosutocnymi-magazinami.html), [gamingbible on Daggerfall Enhanced](https://www.gamingbible.com/news/the-elder-scrolls-daggerfall-enhanced-mmo-844072-20260922).

## Open items to verify next
1. Compile the vendored `DaggerfallConnect` subset on .NET 8 with shims and run golden tests (MapsFile, BlocksFile, WoodsFile) against the real `arena2`.
2. Check that a precompiled mod DLL can open sockets, and whether Harmony works, in a stock DFU 1.1.1 Linux/Windows build.
3. Validate the exterior Y and `WorldCompensation` relationship, and how dungeons interact with `FloatingOrigin`, using a debug mod.
4. Read the Visty93 fork's diff against 1.1.1. It is a ready-made list of the core files a co-op implementation had to touch.
