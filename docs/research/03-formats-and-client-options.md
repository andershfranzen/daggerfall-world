# 03: Daggerfall data formats and client options

The project selected a browser client after commissioning this comparison. The [browser architecture decision](../browser-architecture.md) records the chosen implementation. The native-client recommendation below is retained as research history.

Phase 0 research. Status: complete as of 2026-11-24. Facts carry a source, which is a URL, a path in the local reference
clones (`.ref/daggerfall-unity` = DFU at Unity 2019.4.41f2, MIT; `.ref/dfjs-research-03` = DFO Online open-source
edition, commit `a3eb160`, 2026-11-02, MIT), or a measurement of the local game data at
`gamedata/DaggerfallGameFiles/arena2`. Anything marked **[unverified]** is from memory or a search snippet I could not
open (UESP and the DFWorkshop forums returned HTTP 403 to the fetcher).

## Summary

- **The formats are a solved problem.** Every file a multiplayer game needs already has a working, MIT-licensed C#
  reader in DFU's `DaggerfallConnect` (`Assets/Scripts/API/*.cs`). Only 7 of about 45 reader files import
  `UnityEngine`, and those 7 are image, video and book helpers. The readers a server needs (`BsaFile`, `MapsFile`,
  `BlocksFile`, `Arch3dFile`, `WoodsFile`, `PakFile`, `FactionFile`, `TextFile`, `MonsterFile`, `ItemsFile`, `DFRandom`)
  are Unity-free, so they can be lifted into a plain .NET server. MIT JavaScript translations also exist
  (`.ref/dfjs-research-03/src/formats/`, about 11.8k lines).
- **Measured install size:** `arena2` is 1,591 files and 538,247,042 bytes. Almost half of that (248 MB) is 32 sky
  panoramas, and another 86 MB is cutscenes. Neither matters to a server.
- **Server subset (measured):** about **83.3 MB** for world layout and rules (MAPS + BLOCKS + WOODS + small tables).
  Adding ARCH3D.BSA for collision geometry brings it to about **110.4 MB**, roughly 20% of the install. FALL.EXE is not
  needed: DFU already ships its tables transcribed (`Assets/Resources/ItemTemplates.txt`,
  `Assets/Scripts/Utility/EnemyBasics.cs`).
- **Never store procedural output.** Terrain, wilderness, and dungeon layout and contents are regenerated from game
  data plus seeds. Loot, shop stock and random encounters, however, use *unseeded* or frame-seeded `UnityEngine.Random`
  in DFU, so they are not reproducible. The server must roll them and own them, and cache them only as live state with
  an expiry.
- **Prior art shifted under us in Sept–Nov 2026.** "DFO Online" / "Daggerfall JS" (Lattymoy/daggerfall-js-source, MIT) is a
  browser port of all of DFU, about 1.26M lines of JS, live at daggerfalljs.dev. Its networking is a Cloudflare Worker
  *relay* where clients are authoritative (a "host" client publishes dungeon state, saves stay in the browser), and
  ongoing development is private. It proves a browser client works. It is not a base for an authoritative server.

**Recommendation.** Build the **first client as a small fork of Daggerfall Unity (native)**, with networking added as an
isolated module. Do not attempt a DFU WebGL build. **Plan for a browser client later, but do not build one now**. When
that time comes, start from the MIT JS format readers (DFO Online's `src/formats`) and a deliberately thin
"server-driven" client, not a full game port. To keep that option open today:
1. **Transport:** WebSocket over TLS as the baseline, with WebTransport as an optional later addition. Both work from
   browsers and from .NET. Raw UDP, Mirror/Netcode transports and Steam sockets do not work from browsers.
2. **Protocol:** a schema-defined binary format that does not depend on any language or engine, such as FlatBuffers,
   protobuf or a hand-written spec. It must not contain Unity types: no `Vector3`, no `GameObject` ids, no
   `BinaryFormatter`. Use world-space integers or float32s in Daggerfall coordinates (map pixel plus block-local
   position), and stable ids taken from the game data (MapId, block index, record index).
3. **Server owns all rolls and all state.** The client renders and predicts movement only. A thin browser client then
   needs to re-implement *presentation* (rendering, UI, audio), not game rules.
4. **Asset access:** the server only ever refers to game assets by name and record index. It never sends asset bytes.
   Each client reads the player's own files locally.

**Top risks:** (a) DFU's single-player architecture (singleton `GameManager`/`PlayerEntity`, local-only quest machine,
`UnityEngine.Random`) makes server authority a rewrite of game *logic* whichever client we pick. The client choice
does not change that cost much. (b) DFU's music synthesis (`OnAudioFilterRead`) and runtime mod compilation cannot work in
Unity WebGL. (c) Legal grey zones exist in DFU's transcribed FALL.EXE tables and converted quest scripts, though DFU has
shipped them for years.

---

## Part A: Original data formats

Install measured from `gamedata/DaggerfallGameFiles/arena2`: 1,591 files, 538,247,042 bytes (513 MiB). This is the
"DaggerfallGameFiles" distribution DFU points users to. Bethesda released the game as freeware in 2009
(https://en.wikipedia.org/wiki/Daggerfall_Unity), and the data still may not be redistributed. FALL.EXE is **absent**
from this distribution.

References used throughout:
- UESP index: https://en.uesp.net/wiki/Daggerfall_Mod:File_Formats (+ category page
  https://en.m.uesp.net/wiki/Category:Daggerfall_Mod-File_Formats)
- UESP BSA: https://en.uesp.net/wiki/Daggerfall:BSA_file_formats. Dave Humphrey's 2002 guide is mirrored at
  https://github.com/Interkarma/daggerfallexplorer/blob/master/BSA%20File%20Format.txt. The guide itself warns it is
  "not complete or 100% accurate".
- UESP hacking guide: https://en.uesp.net/dagger/daghack.shtml
- DFU readers: `.ref/daggerfall-unity/Assets/Scripts/API/` (API docs: https://thelacus.github.io/daggerfall-unity-docs/api/DaggerfallConnect.Arena2.html)
- JS readers: `.ref/dfjs-research-03/src/formats/`

"Doc quality" below means: **A** = fully understood, with a working open reader and real-game use. **B** = working
reader, but some fields are unknown or guessed. **C** = only partly understood.

| File(s) | Purpose | Measured size | Doc quality / reader | Server needs it? |
|---|---|---|---|---|
| ARCH3D.BSA | 10,251 3D mesh records (buildings, dungeon pieces, furniture) (UESP ARCH3D page) | 27,143,532 B | A. `Arch3dFile.cs`, `Arch3dPatch.cs`. Some face/UV fields are reverse-engineered heuristics (`FaceUVTool.cs`) | **Collision only.** Needed if the server validates movement in towns and dungeons. Uses positions and faces, not textures. |
| BLOCKS.BSA | RMB (city blocks, incl. building interiors and NPC/flat placement), RDB (dungeon blocks, incl. enemy markers, doors, levers, action records), RDI | 32,115K (≈32.9 MB) | A/B. `BlocksFile.cs`, `DFBlock.cs`. Action/script records are partly decoded (UESP "Dungeon Block Records") | **Yes.** Building and dungeon layout, doors, spawn markers, interior ownership (shops, guilds). |
| MAPS.BSA | 62 regions × 4 records: MapNames, MapTable, MapPItem (exteriors), MapDItem (dungeon block grid) (UESP MAPS.BSA) | 21,611K | A. `MapsFile.cs`, `DFLocation.cs`, `DFRegion.cs` | **Yes.** Location list, coordinates, block composition, dungeon type. |
| WOODS.WLD | 1000×500 world heightmap plus per-pixel detail samples, used to generate terrain | 25,392K | A. `WoodsFile.cs` (map 1000×500, lines 27–34) | **Yes, if** the server validates outdoor height or line-of-sight. Otherwise it is optional. |
| CLIMATE.PAK / POLITIC.PAK | 1001×500 RLE maps of climate zone and region ownership | 15K / 20K | A. `PakFile.cs` | **Yes.** Weather, region, law/faction jurisdiction, encounter tables. |
| TEXTURE.000–.511 | 472 texture archives (indexed 8-bit) | 47,490,730 B | A. `TextureFile.cs` | No (client) |
| *.IMG / *.CIF / *.RCI / CFA / BSS / GFX | UI images, paperdoll/weapon sprite sets, icons | 8.1 MB / 4.2 MB / 2.1 MB / small | A. `ImgFile.cs`, `CifRciFile.cs`, `CfaFile.cs`, `BssFile.cs`, `GfxFile.cs` | No |
| *.COL / *.PAL, SKYPAL.DAT, PAL.RAW, SHADE/HAZE.00x | Palettes and colour tables | <1 MB total | A. `DFPalette.cs` | No |
| SKY00–31.DAT | 32 sky panoramas | **248,260,096 B (46% of install)** | A. `SkyFile.cs` | No. The client can also skip them (DFO's "lean" mode does). |
| DAGGER.SND | Sound effects, raw 8-bit PCM (11,025 Hz **[unverified]**) | 7,483K | A. `SndFile.cs`, `DFSound.cs` | No. The server refers to sounds by index only. |
| MIDI.BSA | Music in HMI format (a MIDI variant) | 1,204K | A. DFU converts it and synthesises with a bundled GM SoundFont (`Assets/Resources/TimGM6mb.sf2.bytes`, `Assets/Scripts/AudioSynthesis/`) | No |
| FACTION.TXT | Faction tree, reputations, allies and enemies (text) | 73K | A. `FactionFile.cs` | **Yes** |
| TEXT.RSC | Main string table (UI, dialogue fragments, rumours, spell text) | 346K | A. `TextFile.cs` | **Partly.** The server needs the ids. Text can render on the client. |
| QRC / QBN (297 / 306 files) | Classic quests: QRC = text, QBN = compiled logic | 0.86 MB + 0.85 MB | B. QBN is reverse-engineered (Donald Tipton's "Template" compiler, **[unverified]** detail). **DFU does not run QBN**: it ships 265 converted text quest scripts (`Assets/StreamingAssets/Quests/`, 1.65 MB) and its own interpreter (`Game/Questing`, ~21k LOC) | **Yes.** Quest logic must run on the server. Use DFU's text scripts plus a ported interpreter. |
| MONSTER.BSA | Monster/class career data | 27K | B. `MonsterFile.cs`. DFU's runtime enemy stats are hard-coded in `Scripts/Utility/EnemyBasics.cs` | Indirectly. The server uses the EnemyBasics table. |
| MAGIC.DEF | Artifact and magic item definitions | 4K | A. `MagicItemsFile.cs` | **Yes** |
| SPELLS.STD | Standard spell list | 8K | A. DFU `Spells-Entity.txt` table + reader | **Yes** |
| CLASS*.CFG, CLASSES.DAT, BIOG*.TXT, NAMEGEN.DAT, RUMOR.DAT, PAINT.DAT, FLATS.CFG | Character creation classes, biography questions, name generator, rumours, flat sprite metadata | ~0.1 MB | A. `ClassFile.cs`, `BiogFile.cs`, `RumorFile.cs`, `PaintFile.cs`, `FlatsFile.cs` | **Yes** for class stats, chargen validation and names. Biography text stays on the client. |
| books/ (90 files) | In-game books | 693,164 B | A. `BookFile.cs` | Ids only. Content stays on the client. |
| FALL.EXE (embedded tables) | Item templates, enemy stats, misc tables | not in this distribution | B. `ItemsFile.cs` reads it, but DFU ships the result as `Assets/Resources/ItemTemplates.txt` + `EnemyBasics.cs` | Use DFU's transcriptions. The legal status of those transcriptions is a grey area, noted. |
| *.VID (17) | Cutscenes | 86,192,616 B | A. `VidFile.cs` | No |
| *.FLC (16) | Daedra prince animations | 10,637,182 B | A. `FlcFile.cs` | No |
| *.FNT (5) | Bitmap fonts | 43K | A. `FntFile.cs` | No |
| PACKED.DAT, LIGHT.DAT, WATER.TBL, *.LGT, *.CEL, MAPSAVE.SAV, others | Misc; PACKED.DAT (10.2 MB) is read by **neither** DFU nor DFO (grep) | ~10.6 MB | C/unused | No |

### Server-side subset (measured)

| Subset | Files | Bytes |
|---|---|---|
| World layout only | MAPS.BSA + BLOCKS.BSA + WOODS.WLD | 81,015,477 |
| **Rules + layout (no collision)** | above + CLIMATE.PAK, POLITIC.PAK, MONSTER.BSA, FACTION.TXT, MAGIC.DEF, SPELLS.STD, TEXT.RSC, QRC/QBN, CLASS*.CFG, NAMEGEN.DAT, RUMOR.DAT | **83,268,139** |
| **+ collision geometry** | + ARCH3D.BSA | **110,411,671** |
| Client "lean" | install − SKY*.DAT − *.VID | ≈203.8 MB (DFO's `KEEP` filter does about this: `src/scenes/dataSource.js:140`) |

The server operator supplies the same files the players do. A further option is to pre-bake a derived navigation or
collision cache on the server from ARCH3D + BLOCKS. That cache is derived data and must stay local, like the source
files.

### What is procedurally derived (never persist in the DB)

Regenerate these from game data plus deterministic seeds. Persist only player-caused *deltas*.

| Derived thing | How DFU produces it | Implication |
|---|---|---|
| Outdoor terrain heights and textures | WOODS heightmap + bicubic interpolation + noise (`Scripts/Terrain/DefaultTerrainSampler.cs`, a Burst `IJobParallelFor`) | Deterministic. The server can compute it on demand if it needs heights. Do not store it. |
| Wilderness flats (trees, rocks) | `TerrainNature.cs`, seeded per map pixel | Deterministic, client-only cosmetics |
| Town layout, building interiors | MAPS → BLOCKS (RMB) composition, `MapsFile.cs:1389` seeds `DFRandom` from MapId | Deterministic. Store nothing. |
| Dungeon layout | MAPS MapDItem → RDB blocks | Deterministic |
| Dungeon random enemies | `Utility/RDBLayout.cs:510` `UnityEngine.Random.InitState(seed)` | Seeded, **but with Unity's RNG**. The server must re-implement the RNG or (simpler) roll its own and *own* the result. The live spawn state is a runtime object, not a stored one. |
| Loot piles, enemy drops | `Game/Items/LootTables.cs:191` (`items.GetHashCode()` seed), `FormulaHelper.cs:151/348` (`Time.frameCount` seeds) | **Not reproducible.** The server rolls it. Persist only what a player picks up. |
| Shop stock | `Internal/DaggerfallLoot.cs:150` `StockShopShelf`, restocked when `stockedDate` changes (`PlayerActivate.cs:882`) | Random per restock. The server generates it and holds it in memory with a per-day expiry. Persist at most the current day's stock if restarts must not reroll it. |
| NPC names, faces, rumours, dialogue | `TalkManagerMCP.cs`, `NAMEGEN.DAT`, `DFRandom` seeds | Deterministic. Never store. |
| Quest instances | Text scripts + interpreter, places and NPCs chosen at random at quest start | Store the *instance state* (it is player progress). Never store the script. |

---

## Part B: Client options

Every option shares one cost: **the game rules have to run on the server.** DFU's ~272k lines of C#
(`find Assets/{Scripts,Game} -name '*.cs'`, excluding Editor) are single-player and depend on Unity throughout. The
relevant parts are Formulas 3.3k, Questing 21k, MagicAndEffects 21k, Items 7k and UI 38k LOC. That server cost is
**not** counted in the client estimates below. It belongs to the server research. The estimates below cover only
the client side plus its glue.

### (1) Daggerfall Unity, native, as a small fork. **Recommended first client.**

- **What changes.** Add a network module that (a) streams the player's position and inputs, (b) spawns proxies for
  remote players and server-owned enemies, and (c) disables local authority. That means routing combat rolls,
  loot, shop stock, quest state, world time and saves through the server instead of `GameManager`/`PlayerEntity`
  singletons. Everything else (rendering, UI, audio, chargen screens, the asset readers) stays as it is.
- **Mod or fork?** DFU's mod system (`.dfmod` asset bundles + runtime-compiled C#, `Game/Addons/ModSupport/Mod.cs:946`)
  can add behaviours, but it cannot cleanly *remove* local authority from core systems. Use a fork kept as a small,
  rebasable patch set against upstream, with the network code in its own assembly.
- **Prior attempts:** Visty93/Daggerfall-Unity-Co-op (MIT, based on the DFU 0.14.5-era "DFU-Tanguy-Multiplayer";
  it moves interiors and dungeons underground at −500 so players can share one scene;
  https://github.com/Visty93/Daggerfall-Unity-Co-op), a 2020 forum co-op project
  (https://forums.dfworkshop.net/viewtopic.php?t=4479), and a Mirror-based demo video
  (https://www.youtube.com/watch?v=r2yBhFBGo88). All are peer-hosted or listen-server. None is authoritative.
  Lesson to reuse: DFU builds interiors and dungeons as scenes placed at world coordinates, so multiple players in
  different interiors need either per-client scenes (fine for us, since the server is not Unity) or offset placement.
- **Effort (client side only):** presence + movement + chat ≈ **2–3 person-months**. Server-driven enemies,
  combat, loot and shops ≈ **+4–6 pm**. Server-driven quests and dialogue ≈ **+4–6 pm**. Roughly **10–15 pm** to a
  playable shared world.
- **Risks:** Unity 2019.4 is old (LTS ended 2022 **[unverified date]**), and upgrading DFU is a project of its own.
  Every upstream DFU release means a rebase. Players' existing DFU mods may assume local authority and break.
  Cheating is limited only by how much the server validates.
- **Barrier to entry:** download our build (~200–300 MB **[unverified]**) and point it at an `arena2` folder. This is
  the same flow DFU players already know.
- **Legal:** the cleanest option. It is the DFU model: MIT code, the user supplies `arena2`, and we host nothing
  proprietary.
- **Fit with one authoritative server:** good. The protocol can stay free of Unity types if the network module
  translates at its edge.

### (2) DFU compiled to Unity WebGL. **Not recommended.**

- **Existing attempts:** only Interkarma's early WebGL proof of concept on the DFWorkshop forums
  (https://forums.dfworkshop.net/viewtopic.php?t=59; snippet only, the forum returns 403). That demo was a single city
  with no procedural streaming, no interiors and no sky, and needed "an upgrade to content loading" for real support.
  The DFU code still contains a WebGL stub that just returns `false` with `// TODO`
  (`Assets/Scripts/API/FileProxy.cs:524-527`). I found no later attempt.
- **Concrete blockers:**
  - Runtime C# mod compilation (`Game/Addons/CSharpCompiler/`, Mono.CSharp) cannot work under IL2CPP/WebGL, which is
    AOT-only. There would be no mods.
  - The music synth runs in `OnAudioFilterRead` (`Internal/DaggerfallSongPlayer.cs:376`), which Unity WebGL does not
    support **[unverified for 2019.4 specifically; documented WebGL audio limitation]**. Music would need a JS bridge
    or pre-rendering.
  - File access: every reader uses `System.IO` paths. In WebGL that is an Emscripten in-memory filesystem, so about
    200 MB of user files would have to be copied into the wasm heap, or the readers reworked to stream. The 2019.4
    WebGL heap cap is about 2 GB, raised to 4 GB in 2021.2+ **[unverified]**.
  - Terrain uses Burst jobs (`DefaultTerrainSampler.cs:54`), which run single-threaded on WebGL. Expect noticeable
    hitches while streaming terrain.
  - A realistic WebGL target needs a Unity upgrade to 2022 LTS or Unity 6 first.
- **Effort:** **8–14 pm**, *on top of* option (1)'s networking. Risk is high, and the result is a large wasm download
  (estimate 50–100 MB **[unverified]**) plus a slow first load.
- **Verdict:** gets the worst of both: the browser's limits plus Unity's weight and licensing churn. Skip it.

### (3) A from-scratch browser client (WebGL2/WebGPU, user's files parsed locally)

- **Existing work to stand on:**
  - **DFO Online / Daggerfall JS**: Lattymoy/daggerfall-js-source (MIT; created 2026-11-02 as a snapshot, upstream
    lineage includes Draconghost/travddm forks from Sept 2026; live at https://daggerfalljs.dev/;
    https://github.com/Lattymoy/daggerfall-js-source). It is a JS translation of DFU on a hand-written WebGL2
    renderer, about 1.26M lines in `src/`. Its format readers (`src/formats/*.js`, 11.8k LOC) mirror DFU's file names
    one to one. It gets the user's `arena2` through `<input webkitdirectory>` or drag-and-drop, stores the files once in
    IndexedDB, and filters them to a "lean" set (`src/scenes/dataSource.js:1-10, 140-149`). Its quests are vendored
    DFU text scripts (`vendor/dfu-quests`). Its **multiplayer is a Cloudflare Worker + Durable Object relay**
    (`server/src/index.js`, `server/wrangler.toml`): position fan-out, chat, and a dungeon "host" client that publishes
    world snapshots. Saves stay client-side. It has drifted far beyond vanilla (guns, battle pass, Morrowind asset
    import, poker). Per its README, "work continues in a private repository", so the open edition is a frozen snapshot.
    Code style is heavily annotated and appears largely AI-generated **[judgement]**. Its readers are reusable. Its game
    architecture is not suitable for our server model.
  - HirundoDev/daggerfall-bevy-native (Rust + Bevy, MIT, Oct 2026, describes itself as "AI-built"). It contains a
    zero-dependency clean-room BSA parser crate. Early stage.
  - JaeTheBoo/daggerfall-dungeon-maker (Rust; RDB/ARCH3D/texture readers; no licence declared, so do not reuse).
  - magicono43/Daggerfall_GD and Godot-4_Daggerfall-GD (Godot ports of DFU; no licence declared; weeks old).
  - DaCookieCakes/RobustDaggerfall (C#, MIT, Nov 2026, 183 KB; it calls itself a "Daggerfall Online engine"). Early.
  - Older references: TogDu/DaggerfallTools (Python BSA parser), tamentis/openscrolls (docs), Dude7ox/DFtoPSP.
- **How much of the game must be rebuilt.** Rendering a viewer of world, towns and dungeons is about 2–3 pm with the
  existing readers. A *game* client also needs: HUD, inventory/paperdoll, chargen (classes, BIOG questions, reflex,
  face), spellbook and spellmaker, dialogue and talk UI, maps/automap, travel UI, shops/banks/guild services, books,
  journal, sprite animation for enemies and NPCs, weapon sprites, the music synth (HMI → WebAudio + SoundFont) and
  SFX. Even if the server owns every rule, that presentation layer is roughly DFU's 38k-line UI plus its renderers.
  - Thin, server-driven client at near-vanilla fidelity: **12–20 pm**.
  - Full client-side game, DFO style: **30–50+ pm** by hand. DFO did it in months, but with AI-scale code generation
    and with loose fidelity and quality.
  - Forking DFO's renderer and UI and ripping out its local rules: **6–10 pm** **[estimate; high uncertainty given its
    1.26M-line, fast-moving, now-private codebase]**.
- **Browser file access:** `<input webkitdirectory>` and drag-and-drop work in all current browsers. `showDirectoryPicker`
  (File System Access API) is Chromium-only **[unverified, believed current]**. Copy once into OPFS or IndexedDB
  (about 200 MB lean, which fits normal storage quotas); DFO's approach confirms this works in practice. Parsing then
  runs in Web Workers.
- **Barrier to entry:** the lowest of all options. Open a URL and pick a folder once. Mobile becomes possible.
- **Legal:** clean if the data never leaves the device and the site never serves `arena2`. One caution: DFO's
  `tools/fetch-data.sh` downloads the freeware zip from a third-party Google Drive link. We should only *link* to
  official sources and never mirror the data.
- **Fit with one authoritative server:** excellent *if* it is built thin. It speaks the same protocol as the native
  client over WebSocket.

### (4) Other approaches

- **DOSBox / js-dos running the original DAGGER.EXE.** Faithful by definition. However, multiplayer would require
  reading and writing the DOS process's memory to inject remote players and server state. The original engine has no
  way to represent other actors' authority, and it is notoriously buggy. Browser builds (js-dos) add a mandatory
  original install inside the emulator. **Verdict: not viable** for a shared authoritative world. At most it could be a
  reference oracle for checking formula fidelity.
- **Godot or Bevy re-implementations.** These have the same scope problem as option (3) without the zero-install
  benefit, and the existing ports are weeks old with no or AI-generated licences. **Verdict:** watch them, do not
  depend on them.
- **"Daggerfall Enhanced", "Tamriel Unbound" and similar.** Covered in the press
  (https://www.gamingbible.com/news/the-elder-scrolls-daggerfall-enhanced-mmo-844072-20260922,
  https://windowsforum.com/news/daggerfall-enhanced-browser-multiplayer-launch-requires-arena2.445708/). These appear to
  be forks or rebrands of the same JS code line **[unverified]**. They matter as competitors, and because their "persistent
  shared time, shops open 24/7" changes are an example of how much shared time forces gameplay changes. Our sibling
  design docs should decide that point explicitly.

### Comparison

| | DFU native fork | DFU WebGL | Thin browser client | DOSBox |
|---|---|---|---|---|
| Client effort to playable MP | 10–15 pm | +8–14 pm over native | 12–20 pm | n/a |
| Fidelity to vanilla | Highest (same code) | Same, minus mods/music | Re-implemented UI, risk of drift | Exact, but no MP |
| Player barrier | Download + arena2 | URL + arena2 + long load | URL + arena2 | Install + emulator |
| Legal cleanliness | Clean (DFU precedent) | Clean | Clean if data stays local | Clean |
| Authoritative-server fit | Good | Good | Excellent | Poor |
| Main risk | Rebase churn, DFU singletons | Unity WebGL limits | Scope (UI re-implementation) | Infeasible |

## Recommendation (detail)

1. **First client: DFU fork (native).** Keep the networking in a separate assembly with a hard boundary. Unity types
   are converted to protocol types only inside that module.
2. **Server: plain .NET, not headless Unity.** It reuses the Unity-free `DaggerfallConnect` readers listed above and
   ports the rules (formulas, quest interpreter, effects) out of their MonoBehaviours. That is the dominant cost of
   the whole project; see the sibling server documents.
3. **Browser client: plan it, do not build it yet.** Revisit once the protocol is stable. Build it thin and
   server-driven, reusing MIT JS readers (DFO `src/formats`) or compiling the same C# readers to WASM.
4. **Decisions to make now so the browser option stays open:**
   - WebSocket (TLS) transport. Keep messages small and binary, and avoid any feature that needs raw UDP.
   - A versioned protocol defined in a neutral schema, with Daggerfall-native coordinates and data-derived ids. No
     Unity or .NET serialisation.
   - The server sends *references* (archive/record/frame ids, TEXT.RSC ids, quest message ids), never asset bytes and,
     where possible, not rendered English text. That keeps both clients thin and legally clean, and makes localisation
     possible.
   - The server never needs SKY, VID, FLC, TEXTURE or audio files. Validate the server's data folder against the
     ~110 MB subset only.
   - Treat the client's local data as untrusted. Optionally have clients send a hash of the key files (MAPS, BLOCKS,
     ARCH3D) at login, so the server can refuse mismatched or modded geometry.
