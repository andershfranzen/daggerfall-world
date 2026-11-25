# 02 — Prior art: multiplayer Daggerfall and comparable retrofits

This comparison predates the [browser architecture decision](../browser-architecture.md). The current client connects to the dedicated server over a WebSocket.

Research date: 2026-11-24. Every claim has a source. Anything I could not check is marked **unverified**. "Read in source" means I read the code in a read-only shallow clone under `.ref/`. I did not build or run it.

## Summary

- **One serious multiplayer Daggerfall exists, and it is the opposite of our design.** DFO Online (also called "Daggerfall Online", earlier "Daggerfall Enhanced" and "Daggerfall JavaScript") is by GitHub user Lattymoy. It is a JavaScript/WebGL2 port translated from Daggerfall Unity's C#. Its server is a set of Cloudflare Workers and Durable Objects: it relays messages, and only some things are server-authoritative. It went from launch (Sept 2026) to a live-service MMO in about two months. It added survival, professions, housing, guilds, PvP, sieges, a premium currency, a battle pass and Patreon tiers. The live code is now private, and the public MIT snapshot is frozen at 2026-11-02. It is a cautionary example for scope and governance. Some of its technical lessons are useful.
- **Daggerfall Unity (DFU) multiplayer attempts all stalled at two-player co-op.** The furthest one was Tanguy's Mirror-based custom build (MIT, 2022–23, v0.7), continued by sixthlaw (2025). Both are forks of DFU 0.14.5, not mods. Both are client-authoritative and peer-hosted. Tanguy reported that a Mirror *mod* was "almost impossible" because of DFU's runtime compiler. None of this code is worth reusing beyond a list of the hook points it needed.
- **TES3MP and Skyrim Together Reborn agree on the hard parts.**
  - The server owns the clock. Resting and waiting cannot skip time, and menus do not pause.
  - Quest state is effectively shared, because the quest logic assumes a single player.
  - One client per area runs the AI. TES3MP calls this the "cell authority". This is the cheapest workable answer for enemies, but it is cheat-prone.
  - Both took years and still have rough edges. TES3MP is still 0.8.1 (May 2022). Skyrim Together took roughly 8 years and one full rewrite.
- **Honest concurrency is tens of players, not hundreds.** TES3MP's FAQ says servers start crashing "after a few dozen". Skyrim Together targets 2–8 players and has been tested with 30+. DFO spreads load over many Durable Objects and caps each room at 256 sockets. That is not a single server process.

**Recommendations**

1. Copy the TES3MP model, deliberately simplified. The server owns the world clock, shared quest/world state, the inventory/loot ledger, and persistence. For each dungeon or exterior block, the first player in becomes the "area owner" and simulates the enemies there. The server validates the outcomes (death, loot, XP) within plausible bounds. Full server-side AI would mean porting DFU's game logic to a headless server, which is the multi-year trap.
2. Decide up front how resting, waiting, fast travel, jail time and levelling work under a shared clock. Every comparable project had to change this, and DFO shipped a levelling bug from it.
3. Networking library: **LiteNetLib** (MIT). Use the `1.x` branch (netstandard2.0) in the DFU client mod, shipped as a precompiled `.dll.bytes`, and LiteNetLib 1.x or 2.x on a plain .NET 8 server. Keep the message layer independent of the transport so a WebSocket transport can be added for a browser client. Avoid Mirror, FishNet and Netcode for GameObjects. All three need IL weaving or a newer Unity, and all three want a Unity-built server.
4. Size the "single server application" for **about 32–64 concurrent players** as the design target, with interest management by map pixel or dungeon. Treat anything above 100 as unproven until load-tested.
5. Do not copy DFO's feature creep, monetisation, closed live branch, or global UTC-midnight jobs (they caused a multi-night outage). Stay free, open and close to vanilla.

---

## 1. DFO Online / "Daggerfall Online"

### Identity and status (confirmed)

| Fact | Source |
|---|---|
| Built by GitHub user **Lattymoy**. Described as "a separate project translated from [Daggerfall Unity's] C#". Fan project, not affiliated with Bethesda/ZeniMax. | https://daggerfalljs.dev/ |
| Renamed several times: Daggerfall JavaScript → Daggerfall Enhanced (13 Sep 2026) → Daggerfall Online (27 Sep) → DFO Online (11 Oct). | https://daggerfall.online/versions/ (third-party site, see below) |
| Press coverage at launch, around the 30th anniversary: persistent server, world chat, friend lists, parties of up to 4, map tracking of friends, resting does not advance time, shops open 24h, a "server slam" with lag that was fixed live. | https://www.makeuseof.com/classic-the-elder-scrolls-game-just-got-a-community-led-update-that-fans-have-been-begging-for-for-years/ ; https://www.gamingbible.com/news/the-elder-scrolls-daggerfall-enhanced-mmo-844072-20260922 |
| On 14 Oct 2026 it dropped 1:1 parity with DFU and continued as an independent project. | https://yomimono.id/daggerfall-online-project-draws-scrutiny-over-paid-patreon-tiers |
| Status by its own account: "Not finished". It cannot import classic or DFU saves and has no mod support. | https://daggerfalljs.dev/ |
| Access: browser (WebGL2), or a desktop app for Windows, macOS (Apple silicon) and Linux. Players bring their own ARENA2 files. An account is needed only for online play and save backup. | https://daggerfalljs.dev/ |
| Source: the public repo is an "open-source edition … as it stood on 2026-11-02", MIT plus DFU's MIT notice. "Work on DFO Online continues in a private repository", and the edition's client "may not connect to the live servers". Repo created 2026-11-02, so earlier history and PRs are gone. | https://github.com/Lattymoy/daggerfall-js-source (README, LICENSE) |
| `daggerfall.online` is a **different, unaffiliated** site. It self-hosts a client and multiplayer service based on DFO, with separate accounts. It also promotes unrelated browser games. | https://daggerfall.online/versions/ |

### Technology (read in source, `.ref/daggerfall-js-source/`)

- **Client.** A hand-rolled WebGL2 renderer with no engine underneath. Game logic is translated from DFU, and DFU's quest scripts and book table are vendored verbatim. Sources: https://daggerfalljs.dev/ and the repo LICENSE.
- **Server.** A Cloudflare Worker named `daggerfall-online`, plus one Durable Object class `Room` with SQLite storage, using hibernatable WebSockets. A second Worker (`daggerfall-accounts`) uses a D1 database with 55+ migrations. Source: `server/wrangler.toml`, `server/src/index.js`, `server-account/migrations/`.
- **Authority model.** The core is a **relay**. `server/src/index.js` describes itself as "THE RELAY … the upgrade, the hibernatable sockets, the fan-out".
  - Enemies ("foes") are owned and simulated by a client. They are handed to another client when the owner leaves (`server/src/foesHold.js`).
  - The Durable Object is the authority only for specific events: bosses, raids, sea serpents and gates. Comments in `src/net/wire.js` say "the relay is the authority over the fight".
  - So it is roughly TES3MP's cell-authority model with server-authoritative bosses on top.
- **Interest management.** Rooms are keyed by 16-pixel world-map cells (`/room/world:<cx>,<cy>`). A cell tree splits a node at 150 sockets and merges at 40 (`CELL_SPLIT_AT`, `CELL_MERGE_AT`). Each room holds at most 256 sockets, poses are capped at 20 Hz, and the visible roster at 64. Sources: `server/src/cellNodes.js`, `server/wrangler.toml`, `src/net/wire.js` lines 251–269.
- **Time.** The server runs a shared clock and resting does not skip time. Sources: GamingBible, MakeUseOf (above). The dev's PR #307 was titled as fixing "online levelling … caused by the shared world clock" (search-result snippet only). The PR is no longer reachable because the repo was recreated, so the details are **unverified**.

### Changes relative to Daggerfall (read in source)

`src/net/` holds 180 entries. They include:
- survival (a "Climates & Calories" port), professions (mining, smithing, logging, fishing, hunting), crafting writs
- housing with decor and yards, guilds and guild halls
- a market and auctions, duels/PvP and an open PvP "wild zone"
- world bosses (dragons, sea serpents, "Dagon's Breach" gates), town-seat sieges, royal tourneys
- a Hold'em poker table, seasonal festivals
- **Aurum**, a premium currency "earned ingame and … purchased" for cosmetics (`aurumLaw.js`, 2026-10-29)
- a **battle pass** with free and premium tracks, opened with Aurum (`battlePassLaw.js`)
- **Patreon-linked titles** (`server-account/migrations/0045_patreon.sql`)

The code comments say all purchasable items are cosmetic. Whether that holds in practice is **unverified**.

### Business model and criticism

- **Confirmed.** A Patreon page was created 24 Sep 2026. Tiers start at $5/month, and a $15,000 tier is listed. It had 85 paid members and $1,253/month around 19 Oct 2026. Lattymoy said on Reddit that donations are optional and fund development time and tools. Criticism spread on Reddit and X, contrasting the project with DFU, which takes no money. Sources: https://automaton-media.com/articles/newsjp/20261019-474335/ and https://yomimono.id/daggerfall-online-project-draws-scrutiny-over-paid-patreon-tiers
- **AI-built (partly confirmed).** Automaton's headline says it was put online "with AI". At least one PR links a Claude Code session (https://github.com/Lattymoy/daggerfall-js-source/pull/462, from a search snippet). An X Community Note says it is "mostly vibe-coded"; the official account called a critic's claim "misinformation". Sources: https://x.com/daggeronline/status/2111937038291173876 and https://x.com/DeMickyD/status/2111943880220586379. The exact extent is **unverified**.
- **Stability (confirmed from the dev's own notes).** `src/net/dayTurn.js` (2026-10-22, "The servers are on fire right now") records that every client hit the account service at 00:00 UTC. Requests went from 60/min to 3,544/min, the single D1 database queue saturated, one request in four got a 503, and sign-ins and relay joins failed "for two hours and more each night", three nights running. The fix was a random per-client offset. A later PR fixed client-side frame lag near World of Daggerfall mountains (PR #462, search snippet).
- **Transparency (confirmed).** The live code moved to a private repo, and the public snapshot is explicitly not compatible with the live servers (repo README).
- **Hearsay, unverified.** An RPGHQ forum user claimed the developers want to push the game toward PvP and "profit from an IP that doesn't belong to them" (https://rpghq.org/forums/viewtopic.php?t=6699, reached via a search snippet; the page returned 403 to me). The PvP systems do exist in source; the motive is opinion.
- **Not found.** Published player counts or peak concurrency. The ~3,500 requests/min at midnight suggests at least thousands of active clients, but that is my **inference**.

### What to take from DFO

- **Copy:** server-owned clock; shops always open; client-owned enemies with handover; spatial rooms keyed by map pixel; per-socket rate limits; a hard cap on sockets per room; and the stampede lesson (no synchronised global jobs).
- **Avoid:**
  - Scope creep: about 80 server systems in 8 weeks.
  - Monetisation of a derivative of someone else's IP.
  - A closed live branch.
  - A serverless design that cannot be self-hosted as one process.
  - Rewriting the engine. The DFO port has to re-translate DFU logic and fix it on its own.

## 2. Other Daggerfall / DFU multiplayer attempts

| Project | Approach | How far | Why it stalled | Licence / reuse |
|---|---|---|---|---|
| **LypyL multiplayer test** (2014–15) | Multiplayer extension for Daggerfall Tools for Unity; Unity Web Player | Tech demo, 4-player cap | Pre-dated DFU gameplay; Unity Web Player is dead | Not reusable. https://www.dfworkshop.net/lypyls-daggerfall-tools-for-unity-multiplayer-test/ , https://www.dfworkshop.net/lypyls-unity-multiplayer-test-2/ |
| **"Beginning COOP multiplayer project"** (DFWorkshop forum, 2020–21) | DFU mod with an in-game server | A client connected to a server inside DFU | Author vanished (Hazelnut, Aug 2021) | No code found. https://forums.dfworkshop.net/viewtopic.php?t=4479 |
| **DFU-Tanguy-Multiplayer** by Y07A/"Tanguy" (Nov 2022 – Jan 2023) | **Custom build** of DFU 0.14.5 + Mirror (KCP, then Steam transport via Steam lobbies). Listen server (host = server). | v0.7, "stable" for co-op. Syncs positions, 8-direction player sprites, doors, foe position/death, shared loot, time, weather, random encounters. | Mod form "almost impossible due to the C# compiler" and duplicate script names. Bugs: enemy HP not synced (enemies "suddenly die"), players floating from floating-origin offsets, invisible players. Inactive since 2023-01-15. | MIT, 60★. https://github.com/EmptyBottleInc/DFU-Tanguy-Multiplayer , forum https://forums.dfworkshop.net/viewtopic.php?t=5946 |
| **DaggerfallMultiplayer_Sixthlaw** (Jul 2025) | Continuation of Tanguy's fork | v0.1: enemy sync extended to dungeons. Still DFU 0.14.5; "working on" an update. | Last push 2025-07-27. Distributed via Google Drive links. | MIT, 14★. https://github.com/sixthlaw/DaggerfallMultiplayer_Sixthlaw |

**Tanguy code review** (read in source, `.ref/dfu-tanguy-multiplayer/`, about 2,100 lines of its own C# plus a vendored Mirror):
- It is fully client-authoritative. Each `NetworkBehaviour` follows the same pattern: `isLocalPlayer` sends a `[Command]`, the host rebroadcasts a `[ClientRpc]`, and the others apply it.
- `TimeCatcher.cs` polls every 2.25 s. If local game time jumped more than 40 classic-seconds (for example after a rest), it either pushes its time to everyone or pulls the host's time, depending on `OptionsMultiplayer.timeHost`. Two players can therefore overwrite each other's clock.
- No server, no persistence, no validation.
- **Reusable as a map of hook points only:** `EntityCatcher`, `LootCatcher`, `DoorsCatcher`, `WeatherCatcher` and `TimeCatcher` show which DFU objects need syncing. The code itself should not be reused.

No multiplayer mod for current DFU (1.1.x) was found on GitHub or in forum search. I did not find a Nexus Mods entry; Nexus was not searched exhaustively.

DFU context: Unity **2019.4.41f2** (`ProjectSettings/ProjectVersion.txt` in https://github.com/Interkarma/daggerfall-unity). API compatibility level 6 corresponds to .NET Standard 2.0; that mapping is my reading of Unity's enum. Last release v1.1.1 (2024), plus a 2025 CVE patch release. The 1.0 notes say development is moving to community maintenance and mod support (https://github.com/Interkarma/daggerfall-unity/releases/tag/v1.0.0). DFU mods can ship source, compiled at runtime by a bundled `mcs.dll`, **or precompiled assemblies as `*.dll.bytes` loaded with `Assembly.Load`**. Source: `Assets/Game/Addons/ModSupport/Mod.cs` lines 906–1014.

## 3. Lessons from comparable retrofits

### TES3MP (OpenMW multiplayer)

- **Shape.** A dedicated `tes3mp-server` with server-side Lua scripts (CoreScripts). The world is persisted as JSON or SQLite per cell and per player. Networking is RakNet (`find_package(RakNet)` in `CMakeLists.txt`). Licence GPLv3. Repo created July 2016. Releases run from 0.3 (Oct 2016) to 0.8.1 (May 2022), with no release since. Sources: https://github.com/TES3MP/TES3MP and its releases page.
- **Authority.** Per cell, one player's client is the "authority". It runs that cell's actors' AI and sends the results through the server; the 2017 announcement says the lowest-ping player is chosen. The server records the authority and broadcasts the actor lists. Sources: https://openmw.org/2017/openmw-multiplayer-here/ , https://docs.tes3mp.com/en/latest/api/ActorFunctions.html , https://github.com/Atkana/tes3mp-scripts/blob/master/Unofficial%20Guide%20to%20tes3mp.md
- **Known side effects.** NPCs greet, follow or arrest only the player whose client runs them. Source: https://github.com/Atkana/tes3mp-scripts/blob/master/tes3mp%20FAQ.md
- **Time.** There is one server clock. A rest runs locally, and "as soon as the bar is filled, my client re-synchronizes back into server time"; "time is never stopped". Source: https://openmw.org/2017/openmw-multiplayer-here/
- **Quests.** The journal, factions and reputation are shared by default. Turning that off breaks things because "Morrowind's quest logic and NPC dialogue is built around the existence of a single player". Some quests reward only one player. Sources: FAQ above; https://openmw.org/2017/openmw-multiplayer-here/
- **World state.** Entering a cell, the client receives the server's record of changes to that cell (deaths, loot, placed items). Items are tracked by `uniqueIndex`. Cells are saved when the last player leaves. Plugins and load order must match exactly. Sources: Unofficial Guide and FAQ above.
- **What took years.** AI ("most remaining gameplay problems involve AI"), client-side script variables needing a sync whitelist "to avoid packet spam", and custom spells and enchantments. Source: https://github.com/TES3MP/TES3MP README. The project stayed in 0.x for 6+ years.

### Skyrim Together Reborn

- **History.** The original started around 2014 and was scrapped in 2019 over SKSE code copied without permission, plus a Patreon backlash. Reborn was rewritten from scratch over about 1.5 years and released 8 Jul 2022. The developers then left further work to the community. Sources: https://www.dsogaming.com/news/skyrim-together-reborn-multiplayer-mod-for-bethesda-rpg-will-release-on-july-8th/ , https://massivelyop.com/2022/07/12/skyrim-together-reborn-multiplayer-mod-officially-releases-and-earns-itself-over-100k-downloads/ . It is still maintained: v1.8.4 on 2026-10-22 (https://github.com/tiltedphoques/TiltedEvolution). The dedicated-server code is a separate executable. Transport is Valve GameNetworkingSockets, via TiltedConnect's `xmake.lua` (https://github.com/TiltedPhoques/TiltedConnect).
- **Rules.**
  - "The server runs the world time"; players "cannot progress the time by waiting or sleeping".
  - Pausing is disabled for inventory, magic, looting and the console, but the map, journal, barter, skills and save menus still pause locally.
  - "Quests are fully synced", and the party leader drives dialogue.
  - Followers are simulated by whoever hosts them.
  - Not synced: some random encounters, and other players picking up dropped items.

  Source: https://wiki.tiltedphoques.com/tilted-online/frequently-asked-questions
- **Distinct lessons.** Licence hygiene with the original engine and tools matters; the project was killed once over it. Monetisation backlash is a recurring pattern (Skyrim Together in 2018–19, DFO in 2026).

### Consensus to adopt

| Concern | TES3MP | Skyrim Together | DFO | Suggested for us |
|---|---|---|---|---|
| Clock | server | server | server | server; rest/wait need a redesign (see below) |
| Pause | never | partly | n/a (browser) | never pause the world; menus stay local |
| Quests | shared by default | shared, leader-driven | per player (unverified) | **open question for design**: shared world flags plus per-player quest instances is the usual compromise |
| Enemies | cell-authority client | host per actor | client owner + handover; server for bosses | area-owner client, server-validated outcomes |
| Interest | cell | cell/party | map-pixel rooms | exterior map pixel / dungeon id |

Open problem specific to Daggerfall: in-game time drives rest healing, level-up timing, quest deadlines, shop hours, jail sentences, banking and travel time. Every project above froze or overrode resting, and DFO reportedly shipped a levelling bug because of it (unverified, see section 1). This needs its own design note.

## 4. Networking library options (for a DFU 2019.4 mod client and a .NET dedicated server)

| Library | Licence | Plain .NET server (no Unity) | Usable inside a DFU mod | WebGL / browser | Maintenance |
|---|---|---|---|---|---|
| **LiteNetLib** (reliable UDP) | MIT | Yes (net8/netstandard) | Yes in principle: pure managed; ship 1.x as `.dll.bytes`. The README says 2.x needs Unity ≥ 2021.2, so use the `1.x` branch (netstandard2.0, last commit 2025-12-16). Loading via `Assembly.Load` inside DFU is **unverified**; prototype first. | No (UDP) | Active: 2.1.5, Oct 2026. https://github.com/RevenantX/LiteNetLib |
| **Mirror** | MIT | No. The server is a Unity build; standalone .NET is not supported (my reading of the codebase, **unverified** in docs) | Poor. Needs Weaver IL post-processing at build time; Tanguy found a mod "almost impossible" and forked DFU instead. | Yes (WebSocket transport) | Very active: v96.11.6, Nov 2026. https://github.com/MirrorNetworking/Mirror |
| **FishNet** | Custom licence: "Other products of like Software (explicitly networking solutions) may not use…" it | No (Unity) | Poor (code generation, newer Unity) | Via transports | Active: 4.7.4, Oct 2026. https://github.com/FirstGearGames/FishNet (LICENSE.md) |
| **Netcode for GameObjects** | Unity Companion Licence | No (Unity) | **No.** 1.12 needs Unity 2021.3; 3.x needs 6000.7. DFU is 2019.4. | Yes (UTP WebSocket) | Active. https://github.com/Unity-Technologies/com.unity.netcode.gameobjects (package.json) |
| **ENet-CSharp** | MIT | Yes | Needs a native `enet` library per platform; loading native plugins from a DFU mod is **unverified** and likely awkward | No | Slow (last push Jul 2025). https://github.com/nxrighthere/ENet-CSharp |
| **Plain WebSocket** (`System.Net.WebSockets` / NativeWebSocket client; ASP.NET Core or similar server) | NativeWebSocket: licence file not asserted by GitHub (**unverified**). websocket-sharp: MIT | Yes (ASP.NET Core / Kestrel) | Yes; NativeWebSocket requires Unity 2019.1+ with the .NET 4.x runtime | **Yes** | NativeWebSocket active (2.0.8, Oct 2026). https://github.com/endel/NativeWebSocket |

**Recommendation: LiteNetLib** for desktop clients. It is pure managed MIT code with no IL weaving and no Unity dependency. The same library and message types run in a plain .NET server, it has the fewest moving parts, and it is actively maintained. Define our own message serialisation over an `ITransport` interface. If a browser client is confirmed later, add a WebSocket transport on the same server, possibly reliable-ordered only, as DFO does over TCP. The browser cannot speak UDP, and none of the Unity high-level frameworks justify their cost given DFU's Unity 2019.4 and mod constraints.

## 5. Realistic concurrency

| Project | Reported capacity | Source |
|---|---|---|
| TES3MP | "no clear limit, but the server currently starts crashing after a few dozen" (FAQ, 2017) | https://github.com/Atkana/tes3mp-scripts/blob/master/tes3mp%20FAQ.md |
| Skyrim Together Reborn | designed for 2–8 ("not an MMO"), tested with 30+ | https://massivelyop.com/2022/07/12/skyrim-together-reborn-multiplayer-mod-officially-releases-and-earns-itself-over-100k-downloads/ |
| Tanguy DFU build | 2-player host/client co-op | forum t=5946 |
| LypyL test | 4-player cap | dfworkshop.net post above |
| DFO Online | not published; per-room cap 256 sockets, split at 150, horizontally sharded across Durable Objects | `src/net/wire.js`, `server/wrangler.toml` |

**Sizing guidance.**
- Plan the single server process for **32–64 concurrent players** at launch, with clients simulating their own area's enemies. A relay-heavy C# process should handle that comfortably.
- Per-player outbound bandwidth scales with players in the same area, not the whole world, so interest management by map pixel or dungeon is mandatory from day one.
- Treat 100–200 as a stretch goal requiring a load test.
- Nothing in this prior art shows a single authoritative process with server-side AI running hundreds of players in a retrofitted single-player RPG.
