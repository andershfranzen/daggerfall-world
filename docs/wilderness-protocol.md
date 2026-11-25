# Wilderness protocol (World of Daggerfall sites)

Owner: wilderness server agent (`server/rpg/wilderness.js`, `server/rpg/wilderness/{store,http}.js`,
`client/world/wilderness/data.js`). Renderer (`client/gameplay/wilderness.js`, `client/world/wilderness/*` except
`data.js`), panel (`client/gameplay/wildernessMap.js`), overland, combat, custom models and WorldData replacements build
against this file. Propose changes by message. This file is the authority.

## Source data and provenance

- **Operator-installed input only.** The source is the World of Daggerfall Project tree: author repo
  `drcarademono/world-of-daggerfall` @ `3bf8837402cce41421dcb36c64a3a2c4f27d0448`, or the same tree unpacked from the
  Nexus release. It lives at `gamedata/world-of-daggerfall/`, or at `config.wodPath` or `$WOD_PATH`. The tree is
  git-ignored and excluded from the public distribution. Neither the mod nor Location Loader (KABoissonneault/DFU-LocationLoader
  @ `a5e7a187`) ships a license file, so no author file or code is copied here. `data.js` is an independent reader of
  the file formats. Test fixtures are written by hand.
- **What is read.** `WorldOfDaggerfall.dfmod.json` `Files` is the authority when present. The reader takes the
  bundle's `Locations/<Region>/*.csv` (or `Locations/<regionIndex>/`), the root `Locations/*.csv` files (`WOD_Docks`,
  `WOD_Bridges`, `WOD_Docks_Clearance`), and every `Locations/LocationPrefab/**/*.txt`. Rocks and mountains live in
  subfolders, and prefabs are found by file name. When the tree has no region folders at all, `CombinedCSVs/*.csv` is
  used instead. `Development/` is never read. `WorldData/location-*.json` is read only for its map pixel and block size,
  which are used for pruning. The local model reader resolves meshes, textures, materials and Unity prefabs separately.
- **CombinedCSVs.** `CombinedCSVs` (GIS kit) is not part of the release. Its scenery families (Rocks, Mountains ×3,
  BorderTowers, BannerPosts) equal the bundled region rows exactly. Its `Locations.csv` and `WOD_*.csv` are an older
  placement generation: only 706 of 61,484 rows are in the release. The bundle wins.
- **Deterministic order.** Folders and files are ordered by an ordinal comparison of the path, and rows stay in file
  order.
- **Measured at `3bf8837`.** The tree has 185 instance files in 47 folders, 329,040 rows and 314 prefabs. Of those
  rows, 329,035 are placed. Five are refused by Location Loader's own rules: 1 overlaps the Port of Daggerfall
  replacement and 4 have a type-0 footprint that crosses the pixel edge. Indexing takes about 0.7 s. After that, only
  the folders recently asked about stay in memory (an LRU of 6), along with the prefabs used.

## Ids

- **Location id**: `wilderness:<px>,<py>` with integer map pixels `0 ≤ px < 1000`, `0 ≤ py < 500` (the `mapPixelOf`
  grid). The form is canonical: no signs, spaces or leading zeros.
- **Site id**: `wod:<px>,<py>:<tx>,<ty>`, where `tx` and `ty` are the row's terrain tile (`0..128`). These are the
  coordinates Location Loader's own 48-bit `locationID` is built from. If two rows share coordinates, the later ones in
  load order get `#2`, `#3` and so on. Ids are stable for a given tree. An id that no longer resolves is refused as
  stale.

## Actions (`api.act(verb, args)` → `{ok, error?}`)

| verb | args | effect |
|---|---|---|
| `wilderness.nearby` | `{}` | Recomputes `nearby` from where the player stands. It also runs on join, travel, overland, visit and leave. |
| `wilderness.discover` | `{site}` | Marks a site within the radius as known to this character. |
| `wilderness.visit` | `{site}` | Fast travel to a site within the radius of the player's **actual** pixel, from outdoors. Indoors the action is refused. Sets the location to `wilderness:<px>,<py>`, places the player at the scene spawn, records `returnTo` and the town position, and discovers the site. There is a 1.5 s cooldown. |
| `wilderness.leave` | `{}` | Back to `returnTo`, at the saved town position. Falls back to `travel.lastTown`, then the default town. |
| `wilderness.loot` | `{site, object}` | Searches one loot record of a site in the player's current scene: a `216.x` treasure flat (`objects[].loot`) or a `199.19` random-treasure marker (`markers[].loot`). The player must be within 4 m. Each character can search each record once, and gets deterministic gold through `services.giveItem`, so every account finds the same amount. |

Errors are player-readable and cover these cases: not installed, loading, stale, too far, step outside, already
there, not at that site, need to be closer, already searched. Game events:
`{kind:'wilderness', text, site?, location?, gold?}`. On visit and on overland `onEnter` the server also sends
`{kind:'wildernessScene', location, scene}`, which is the same descriptor as the HTTP route.

## Snapshot: `character.wilderness` (private `rpg` message)

```js
{
  pack: 'ready' | 'loading' | 'missing' | 'error', packNote?: string,
  site: 'wod:…' | null, returnTo: 'town:Region/Town' | null, returnPos?: {x, z, yaw},
  origin: { px, py, region } | null,       // the player's real pixel (town pixel, or the wilderness pixel)
  radius: 6,                               // map pixels
  nearby: [{ id, name, kind, prefab, px, py, region, distance /* map pixels, 2 dp */, discovered }],
  discovered: string[], looted: string[],  // capped at 2000 each
}
```

`nearby` is sorted by distance, then by id, and holds at most 24 entries. It lists points of interest only: camp,
fort, tower, ruin, shrine, farm, dock, logging and site. Rocks, mountains, banner posts and bridges are scenery.

## Scene descriptor (public)

`GET /api/wilderness/scene?location=wilderness:<px>,<py>` is mounted in `server/game.js`. Every valid pixel returns 200
(a pixel with nothing on it gives `sites: []`). An invalid id returns 400. A missing or loading pack returns 503 with
`{pack}`. Methods other than GET or HEAD return 405. Every account gets the same bytes. The server-side call is
`services.wilderness.scene(location, focusSiteId?)`.

```js
{
  v: 1, id, px, py, region, regionIndex?,
  frame: 'rh-y-up-north-negz-metres-origin-pixel-centre',
  tile: { size: 819.2, origin: [-409.6, 0, 409.6] },  // SW corner of the pixel
  spawn: { x, y: 0, z, yaw: 0 },                      // 4 m south of the focus site's ground rect, facing north
  sites: [{
    id, name, kind, prefab, region?, instanceType,    // 0 flatten, 1 overlap + sink, 2/3 sea level
    pixel: [px, py], tile: { x: terrainX, y: terrainY }, width, height,  // exact ints from the row and prefab
    ground: 'site' | 'sea', anchor: [x, y, z], rotation: [x, y, z, w], yaw, scale, sink,
    rect: { x, z, width, depth },                     // Location Loader footprint (rotation and scale aware), metres
    objects: [
      { objectID, kind: 'model', model, position, matrix },
      { objectID, kind: 'prefab', name, position, matrix },          // type 4 Unity prefab (custom-models agent)
      { objectID, kind: 'block', block: 'ALCHAS00.RMB', position, matrix, groundPlane? },  // type 5
      { objectID, kind: 'flat', archive, record, position, scale, align: 'base', light?, loot? },
    ],
    markers: [{ objectID, marker, position, enemy?, team?, loot? }],  // 199.x, never drawn
    missing?: string[],                               // type-3 layouts that could not be expanded
  }],
}
```

- **Frame.** The scene frame is right-handed, in metres, with +y up, east +x and north −z. This is the same frame as
  towns and overland. The origin is the pixel centre at the site ground (y = 0). Location Loader puts an instance root
  at `(terrainX·6.4, ground, terrainY·6.4)` in Unity tile space. Unity tile space is left-handed, +z north, with its
  origin at the SW corner, so `x = ux − 409.6` and `z = 409.6 − uz`. Quaternions map as `(−qx, −qy, qz, qw)`. Rows
  rotate by `Euler(rotXAxis, rotYAxis, rotZAxis)` (Unity ZXY) and scale uniformly by `scale`.
- **matrix.** A column-major 4×4 matrix. It takes model-local metres, built as in town.js
  (`x·0.025, −y·0.025, z·0.025`), to scene metres, and is exactly `diag(1,1,−1) · M_unity + pixel offset`. The
  determinant is negative, as with town.js `place()`. Everything is already composed (row → prefab → nested type-3
  layouts), so do not apply `anchor` or `rotation` again. Nested ids are dotted paths, for example `"9.1"`.
- **Flats.** Flats never rotate (Location Loader `HasRotation`). `position` is the sprite's base, because Location
  Loader calls `AlignToBase` on them.
- **Overlap.** Type 1 and 3 rows reach into neighbouring pixels, so they appear in those scenes too. They keep their
  own `pixel` and are positioned in the requesting pixel's frame.
- **Heights.** The descriptor is height-free: y = 0 is the focus site's ground. `client/world/wilderness/terrain.js`
  (pure, browser and Node) supplies heights. Call `buildGround(woods, {px, py, sitesByPixel, ring: 1, spawn})` with
  WOODS.WLD from ARENA2. It returns `heightAt(x, z)` in scene metres and `siteLift(siteId)`, which is the site's
  Location Loader root minus `datum`. The datum is the root of the site nearest the spawn, or the ground under the
  spawn when the pixel has no site, so y = 0 still means the visited site's ground. Type-1 sink follows
  `FindAdjustedHeightOffset` across every overlapped pixel. The renderer's mesh and server collision
  (`server/rpg/collision/arena2.js`, `geometryOnly`) both use it, so what is drawn and what collides agree.

## Server hooks

- `services.wilderness = { status(), ready, isWilderness(id), parse(id) -> {px,py}|null, scene(location, focus?),
  siteById(id), nearbyFor(p), onEnter(p, id) }`. `isWilderness` and `parse` are synchronous and pure.
- **Overland owns walking transitions.** It sets `rpg.location`, `x` and `z`, emits
  `'overland' {player, from, to, via}`, and calls `onEnter(p, id)`. On a walk out of a town this feature records
  `returnTo`, refreshes `nearby` and sends the scene. It never creates edge or neighbour transitions.
- **Combat**: `services.encounterSites(location)` is chained.
  - Not a wilderness location: returns the previous handler's result (or `undefined`).
  - Pack loading: returns `null`, meaning not ready, so retry.
  - Ready: returns an authoritative array, possibly empty.
  - Pack missing or errored: defers to the previous handler.
  - Site shapes: a `199.16` marker becomes `{x, z, monsters:[EnemyId], key:'<siteId>#<objectID>', yaw, team?}`. An
    enemy id unknown to combat becomes `{table: 33, count: 1}`. A `199.15` marker becomes
    `{x, z, table: 33, count: 1, key}`.
  - `team` is Location Loader's `TeamOverride`. It is sent only when it is nonzero; 0 means the enemy keeps its own
    team.
- **HTTP**: `handleWildernessScene(service, req, res)` and `WILDERNESS_SCENE_PATH`, exported from
  `server/rpg/wilderness/http.js`.

## Gaps (honest status)

- **Seasonal rules.** `winterPrefab` substitution is not applied: none of the 314 shipped prefabs sets it. Winter
  texture swaps for ground, models and nature follow the climate as for towns (`scene.js` `winter`).
- **Coast.** Type-2 (sea-level) sites move to their coast with Location Loader's `FindNearestCoast` rule
  (`client/world/wilderness/coast.js`) when the browser or server collision builds the scene. A site authored on
  water moves back to the last water tile before land. A site authored on land moves to the first water tile north,
  east, south or west. The descriptor itself stays as authored. The visit spawn moves with a snapped dock
  (`server/rpg/wilderness/coast.js`). Measured at `3bf8837` against the installed WOODS.WLD: of 382 dock rows, 10 start on
  water, 166 start on land and find water, and **206 find no water in their own pixel**. Those docks keep their tile at
  the ocean elevation, under the hill, as Location Loader does. The scene reports them in `warnings` and
  `wilderness.coast`. The audit dock `wod:98,162:63,53` is in this group: WOODS.WLD height is 34 across its 3×3 pixels.
  `wod:160,221:63,123` (Fontborne Docks) is authored on the waterline.
  A visit requested while the shoreline lookup is pending leaves the player at the origin and can be retried.
  At Westhead Moor Docks, the resolved landing is 17 terrain tiles north of the authored landing.
- **Dock models.** With the pack's WorldData, docks are `ALCHAS00`–`ALCHBS01` replacements whose decks and piers are
  models 52866–53500 from the optional *RMB Resource Pack*. Those models are not in ARCH3D.BSA and are reported as
  missing, never substituted. Only the classic barrels and crates on the dock (41xxx, 9xx) are drawn and collide.
- **Buildings.** Doors of RMB buildings in type-5 pieces (for example the `FARMAA03` farmhouse) are portals of the
  shared registry (`server/rpg/interiors.js` `interiors.addSource`, source in `server/rpg/wilderness/buildings.js`). Their
  instance ids are `interior:<siteId>/<objectID>/<record>`, with portal ids `wb:<tx>,<ty>[.<n>]:<objectID>:<record>`.
  `portal.use`, `portal.leave`, collision and reconnect work as for town buildings. The browser finds the same doors
  with `client/world/wilderness/buildings.js` and shows the G prompt (`client/gameplay/wilderness/buildings.js`).
  If the saved farmhouse layout fails to load on sign-in, Play shows the error and offers **Try again**.
- **Roads.** The installed records hold no roads or paths. Location Loader only consults the optional *Basic Roads*
  mod, which is not installed. `WOD_Road_Gate` ships as a prefab with no placed row. The 63 `WOD_Bridges` rows are
  drawn as scenery.
- **Type 5 blocks** name an RMB block. The scene loader reads its WorldData replacement when present and otherwise uses the classic BLOCKS.BSA record.
- **Type 4 prefabs** carry names and placement matrices. On loopback the model reader resolves the installed pack’s FBX geometry, materials and texture references on demand. Converted meshes and their referenced pack PNGs use the same protected local asset transport as the ARENA2 preview. Players on another host can choose their source folder under World of Daggerfall model files in the Wilderness panel. Conversion and collision details: `docs/world-of-daggerfall.md` (`server/rpg/wilderness/models.js`).
- **Type 3 layouts** are expanded by `composeSite`, with names matched case-insensitively as Location Loader does (e.g. `wod_prop_scouttower` → `WOD_Prop_ScoutTower.txt`, which ships). Of 13 distinct type-3 names in the bundle's 314 prefabs, 10 do not resolve (rock/mountain layouts named by `WOD_Pirate_Cove_01`, `WOD_Pirate_Cove_LightGray_01`, `WOD_Giant_MountainCastle_01`, `WOD_OrcCamp_{Small,Medium}_Mountains_03`), but no published row places those five prefabs, so every placed site expands completely. A future row using them would list the names in `missing`.
- **Collision** in `wilderness:` scenes comes from the descriptor, `terrain.js` and the custom mesh colliders. With overland travel enabled, the server holds the player in place until solid geometry is ready. A failed read of configured ARENA2 data is retried while the area is occupied. The browser waits for matching scene collision before sending movement. The outer visual horizon contributes no solid or walkable triangles. After a visit, a player still standing inside a solid at the spawn moves to the nearest clear spot within 24 m.
- **Data, not a bug:** at `wilderness:614,324` the `WOD_Mountain_Small_07` foothill flank stands about 12 m above the Bandit Fort's flattened ground after sink, so the fort sits inside the mountain's skin. This follows from the mod data and Location Loader rules.
- **Loot** is deterministic gold. Players can press **G** next to unsearched site treasure or choose **Search nearby treasure** in the Wilderness menu.
