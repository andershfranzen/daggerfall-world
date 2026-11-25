# client/world/wilderness — World of Daggerfall sites in the browser

`scene.js` and `terrain.js` build the scene for a `wilderness:<px>,<py>` location from the player's own ARENA2 files and
the server's scene descriptor (`docs/wilderness-protocol.md`). `client/gameplay/wilderness.js` runs them when the
character's location changes. Other files here have their own owners: `data.js` (descriptor composition, server
agent), `models.js`/`fbx.js` (custom meshes), `localPack.js` (loopback mesh/texture transport), `replacements.js`
(WorldData RMB replacements).

No game or mod data is bundled. Nothing is substituted: a missing ARENA2 file or mod mesh is reported in `warnings`,
and that surface is not drawn.

## `terrain.js` (pure; browser and server)

- `WoodsFile.open(read, size)` / `WoodsFile.fromBytes(bytes)`: a byte-range WOODS.WLD reader.
- `buildGround(woods, {px, py, sitesByPixel, ring = 1, spawn})` returns a `Ground` with
  `heightAt(x, z)` (scene metres), `siteLift(siteId)` and `datum`.
- `generateSamples`, `generateTilemap`, `applyLocationLoader`, `overlapSections`, `sinkOffsetAcross`, `layoutNature`.

**Datum.** y = 0 is the spawn site's Location Loader root height (the descriptor's "site ground"). A pixel with no
site uses the ground under the spawn instead. Each site's objects are lifted by `siteLift(id)`, which is that site's
own root height minus the datum. A type-1 sink reads every pixel the site overlaps.

## `scene.js`

`buildWildernessScene({files, descriptor | null, location, neighbours, signal, models, loadAsset, loadTexture,
replacements, worldData, geometryOnly})` returns the mesh contract of `client/world/README.md`, plus
`kind: 'wilderness'`, `wilderness {px, py, datum, climate, sites, heightAt}`, `flats`, `sky`, `stats` and `warnings`.
`signal.aborted` cancels the build between steps with an `AbortError`. `modelMatrix(obj, lift, offset)` is the shared
transform for collision.

What is drawn:

- **Terrain.** Seven by seven map pixels. Full 6.4 m tiles are used within 256 m of the visited pixel, then 25.6 m quads through the inner three by three pixels. The outer terrain uses sparse WOODS.WLD samples up to 102.4 m apart, joined to the inner mesh. From the centre, the horizon terrain reaches 2.87 km in each cardinal direction.
- **Ground tiles.** Each pixel uses its own climate's ground tiles (CLIMATE.PAK → TEXTURE.002/102/302/402).
- **Site objects.** These are ARCH3D models, including scale-aware rock UVs from `models.js`, TEXTURE flats with
  their scale, and BLOCKS.BSA blocks (or WorldData replacements), with block flats and an optional ground plane.
- **Mod meshes.** The mod's FBX prefabs come from `loadAsset`. Their PNG textures are box-filtered to 512 px and
  added to the atlas.
- **Nature and sky.** DFU nature flats are laid out by climate, kept out of type-0 rects. The sky is the climate's
  SKYnn.DAT day panorama.

## `coast.js` and `buildings.js` (pure; browser and server)

- `coast.js`: `findNearestCoast(tilemap, tx, ty, neighbours)` is Location Loader's type-2 coast search. `snapWithWoods`
  moves sea-level sites before the ground is built, so drawing and collision agree. Sites without a coast in their
  pixel keep their tile and are listed in `warnings` and `wilderness.coast`.
- `buildings.js`: `siteBuildingPortals(data, descriptor)` returns the doors of a pixel's RMB building pieces, placed
  with the same transforms the scene uses, together with the town-interior landing and exits.
  `loadSiteInterior(data, location, site)` draws an `interior:<siteId>/<objectID>/<record>` scene. The server
  registers them through `interiors.addSource` (`server/rpg/wilderness/buildings.js`).

## Sources and credits

- **Daggerfall Unity** (MIT, © 2009-2023 Daggerfall Workshop), from `.ref/daggerfall-unity`. These files were
  ported: WoodsFile, DefaultTerrainSampler, TerrainTexturing, TerrainNature, JobA indexing and the GameScene
  TerrainScale (1.25).
- **dfjs-research-03** (MIT, © 2026 Lattymoy), from `.ref/dfjs-research-03/src/world`. These were adapted:
  `formats/woodsFile.js`, `formats/umRandom.js`, `perlin.js`, `terrain/terrainSampler.js`, `terrain/terrainTiles.js`
  and `worldOfDaggerfall/*` (object semantics).
- **Location Loader** (KABoissonneault/DFU-LocationLoader; it ships no license file). This is an independent
  implementation of the behaviour in `LocationLoader.cs` / `LocationHelper.cs`: rect averages, `BlendTerrain`,
  `FindAdjustedHeightOffset` and `GetOverlappingTerrainSections`. No code was copied.

## Departures (deterministic and documented)

- Unity's `Mathf.PerlinNoise` is closed source, so Ken Perlin's improved noise stands in. This affects the ≤10-unit
  ground-noise term and the dirt/grass/stone weights.
- Nature flats use a Unity-style xorshift128 seeded with `MakeTerrainKey`. The placement rules and density match DFU,
  but individual trees do not.
- Classic towns are flattened into the terrain here but not drawn into this mesh. The exterior stream draws each town's own mesh in place (see below).
- Distant quads approximate the landscape. The outer horizon loads terrain only, and height queries retain their existing gameplay extent.

## Streaming (`client/world/exterior/stream.js`, `client/gameplay/wilderness.js`)

One bounded cache holds exterior scenes by location id: `wilderness:<px>,<py>` pixels and classic towns (`loadTown`
by region and location index, so WorldData replacements such as Port of Daggerfall come through `townsAround`). It
builds one scene at a time, with the current location first. Each scene is anchored on the shared absolute surface
(`exterior/frame.js`):

- A pixel draws every town in its 3×3 cells as a layer at `townMeshOffset`, with that town's RMB flats
  (`loadScenery(..., {terrain: false})`).
- A town draws its own pixel scene around it (the inverse offset), with that pixel's nature flats and the other towns.
  The scenery feature skips its separate WOODS apron when streaming is installed.
- Within 300 m of a pixel edge, the neighbouring pixel is prefetched, uploaded and given a ground lookup before the
  server moves the player.
- When the server moves the player between adjacent exteriors, the shell adds `api.exterior.crossing(from, to)` to the
  predicted position. The view stays in place, held movement continues, and the destination scene swaps in during
  the same task. If the destination is still loading, the old scene is drawn translated into the new frame
  (`api.rebaseScene`) until it arrives. Height is provisional for a pixel whose datum is not known yet.
- Each kind of scene has a bound (`LIMITS`: 4 pixels and 6 towns, besides what the current view pins). Scenes idle
  for 45 s are dropped at the 15 s sweep. Eviction releases their GPU buffers and flat passes.
- Builds the new location no longer needs are aborted, and their results are discarded.

`api.exterior.stats()` reports the resident keys and bytes, GPU meshes, layers, and counts of built, cancelled,
discarded and evicted scenes. It also reports frame counters (empty exterior frames, duplicated places, and camera
steps over 3 m in absolute coordinates).
