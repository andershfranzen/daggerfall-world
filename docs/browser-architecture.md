# Browser client feasibility

## Decision

Use browser ES modules and WebGL for the client, a single Node process for HTTP and WebSockets, and SQLite for persistent characters. The first milestone is a walk through one original town with a second player. It exercises the game-data formats, renderer, shared coordinates, network protocol and persistence before adding combat or quests.

The public website uses Next.js App Router with TypeScript. The home page, play guide and development roadmap share a React layout. A production build exports those pages and their assets for the dedicated server to serve. The play link opens the WebGL client at `/play.html` on the same origin as the multiplayer endpoint, `/ws`.

## Existing implementations

| Implementation | Finding | Consequence for this project |
| --- | --- | --- |
| DOS Daggerfall | The installation provides separate archives for location layouts, block placements, models, textures and palettes. | The player can select a local installation and the browser can read the required records through the File API. The server has no need to distribute art. |
| Daggerfall Unity | The C# archive readers are distinct from the Unity scene, terrain streaming and object-construction code. | Use the readers as format references. Keep the browser renderer and the multiplayer simulation independent of Unity. [Archive reader sources](https://github.com/Interkarma/daggerfall-unity/tree/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/API) · [World streaming](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/Terrain/StreamingWorld.cs) |
| DFO Online | The public browser edition reads a player's own ARENA2 folder. Its published server uses Cloudflare Workers, Durable Objects for rooms and a separate account service. Its README identifies the source as a November 2026 snapshot and warns of possible incompatibility with the live servers. | Reuse format knowledge and give this client its own protocol. One process and one database suffice for the first town. [Published edition](https://github.com/Lattymoy/daggerfall-js-source/tree/a3eb1605ea1dc391b691fe314377458a7e63e483) · [Server configuration](https://github.com/Lattymoy/daggerfall-js-source/blob/a3eb1605ea1dc391b691fe314377458a7e63e483/server/wrangler.toml) |
| DFU-Tanguy-Multiplayer | The project describes itself as a custom build of Daggerfall Unity 0.14.5 and documents a Steam setup. | It offers a native co-op reference. Adopting it would require a Unity client and a different connection path. [Project README](https://github.com/EmptyBottleInc/DFU-Tanguy-Multiplayer/tree/5bd65105c53bafda3a3992f64beeb9e0bad6df12) |

## Loading a town

1. The player grants the page read access to a local folder. The browser indexes filenames case-insensitively.
2. `MAPS.BSA` provides the named location's exterior grid. The grid identifies the town blocks.
3. The RMB records in `BLOCKS.BSA` place the buildings, exterior objects and ground tiles. Their model IDs refer to faces and vertices in `ARCH3D.BSA`.
4. The renderer draws the assembled exterior in a shared coordinate system. Classic texture records come from `TEXTURE.###` archives and use the game's palette. Original game bytes stay on the player's device.

## Shared state

The browser sends movement intent and facing. The server advances positions against its own clock and sends snapshots of the occupied town. Both players see the same positions. The character record belongs to the server, and a returning browser presents a guest credential to resume it. Town geometry is reconstructed from local files each session. The first milestone needs a database row per character and no database rows for buildings.

Adding combat will require server-side encounter state and collision queries against trusted world data. Inventory and trades will need atomic database transactions. Interiors and dungeons will need location identifiers so that snapshots and chat reach the correct occupants. These are dependencies for later milestones.

## Code and game assets

Daggerfall Unity and the inspected public DFO Online edition publish MIT notices. Adapted code must retain the applicable notices, including upstream attributions. Each installation supplies its own Bethesda game files. The browser client, static server and source distribution should carry only project code and licensed dependencies. This is an unofficial project. Donations remain deferred pending legal clarification. [Daggerfall Unity license](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/LICENSE) · [DFO Online licenses](https://github.com/Lattymoy/daggerfall-js-source/blob/a3eb1605ea1dc391b691fe314377458a7e63e483/LICENSE) · [Classic Daggerfall on Steam](https://store.steampowered.com/app/1812390/The_Elder_Scrolls_II_Daggerfall/)
