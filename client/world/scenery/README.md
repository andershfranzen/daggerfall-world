# client/world/scenery — outdoor scenery from the player's files

`loadScenery(files, town)` adds what `loadTown` leaves out of a town exterior. It reads the static flats from the
RMB blocks, the climate's day sky and the land around the town. Everything comes from the player's selected ARENA2
files in the browser. No game data is bundled. The browser feature `client/gameplay/scenery.js` draws the result
with `client/gameplay/scenery/pass.js`, using one `Renderer.addPass()` pass.

```js
import { loadScenery } from './world/scenery/index.js';
const scenery = await loadScenery(files, town); // town = await loadTown(files)
```

## What is drawn, and where it comes from

| Part | Data | Rules (Daggerfall Unity, MIT) |
| --- | --- | --- |
| Ground scenery (trees, bushes, rocks in town) | RMB `GroundScenery` 16×16 bytes, record = `bits/4 − 1`, records < 1 skipped | `BlocksFile.ReadRmbGroundSceneryData`, `RMBLayout.AddNatureFlats` |
| Lamps (210), animals (201), decorations (signs, wells, carts…) | RMB misc flat records (17 bytes) | `RMBLayout.AddLights`, `AddMiscBlockFlats` |
| Building-yard flats | sub-record exterior flat records | `RMBLayout.AddExteriorBlockFlats` (nature archives swap to the climate set) |
| Flat images and size | `TEXTURE.nnn` frames, `size + trunc(size × scale / 256)` × 0.025 m, index 0 transparent, 5 fps animation from a deterministic start frame | `TextureFile`, `MeshReader.GetScaledBillboardSize`, `DaggerfallBillboard` |
| Nature archive | `CLIMATE.PAK` value → 500–511 (summer) | `MapsFile.GetWorldClimateSettings`, `ClimateSwaps.GetNatureArchive` |
| Sky | `SKY{SkyBase + season}.DAT`, frame 31, east/west halves, palette per frame. Its horizon colour becomes the fog and clear colour | `SkyFile`, `DaggerfallSky` |
| Surroundings | `WOODS.WLD` 1000×500 heightmap around the town's map pixel (`lon/128`, `499 − lat/128`). Each map pixel is 819.2 m. Height scale is 8 and the sea is at 3.4. Ground tiles 0–3 come from the climate's ground archive | `WoodsFile`, `DefaultTerrainSampler`, `TerrainTexturing` |
| Nature around the town | climate nature archive, records 1–31. Chance is 0.9 on grass, 0.2 on dirt and 0.05 on stone, × elevation scale (clamped to 0.4–1) and × 0.25 in deserts. Flats keep a 4-tile clearance from the town | `DefaultTerrainNature.LayoutNature` |

Placement uses loadTown's transform. Positions are first placed in DFU's left-handed space, (x, y, z) × 0.025 m.
The z axis is then mirrored and the result is translated by `town.source.spawnLocal`, so flats line up with the
buildings. People are excluded: records with a non-zero faction id and the NPC archives in
`RDBLayout.NPCFlatArchives`. They belong to the NPC/actor systems. Editor markers (archive 199) are not drawn.

## Our own work (not DFU, not a claim about the original game)

The surroundings are an approximation. They are not DFU's terrain generator.

- The apron reaches 2.56 km past the town. Its grid spacing is 12.8 m near the town and 51.2 m beyond 768 m. Its height is bilinear over the coarse WOODS.WLD
  heightmap. A little deterministic value noise stands in for DFU's per-pixel noise sampler.
- The apron blends to the flat town ground between 24 m and 420 m from the town edge.
- The tile choice is ours: grass, dirt from slope and noise, stone on steep slopes, and water below sea level.
- Nature placement uses an integer hash seeded from `mapId`, `locationIndex` and `regionIndex`. It is not Unity's
  RNG. Density is scaled down to fit a browser draw budget (`maxNature`, default 16,000). Nature reaches 800 m
  from the town.
- Each sky half spans 180° of yaw around the view. The image rises from the horizon to 1.3 half-screen heights,
  as in `DaggerfallSky.UpdateSkyRects`. The horizontal mapping is angular rather than DFU's fixed screen-width
  scroll.

The same files always give the same placements.

## Output

```ts
{
  town: { name, region },
  townRect: { minX, maxX, minZ, maxZ },          // the town's ground, output space
  billboards: { vertices: Float32Array, count, flats },  // 6 vertices per flat, BILLBOARD_STRIDE floats each
  atlas: { width: 2048, height, pixels },         // RGBA, frames side by side per sprite
  terrain: null | { positions, normals, tiles, records, nature, oceanY, atlas, rects, stats },
  sky: null | { width: 1024, height: 220, pixels, horizon: [r,g,b], zenith: [r,g,b], frame, index, file },
  warnings: string[],
  stats: { townFlats, terrainFlats, drawnFlats, droppedFlats, skippedPeople, skippedEditor, sprites,
           natureArchive, kinds, terrain, sky, atlas },
}
```

## Required files, optional files and fallbacks

- **Required** (a `WorldDataError` is thrown): `BLOCKS.BSA` and `ART_PAL.COL`, which `loadTown` already needs.
- **`SKYnn.DAT` missing or truncated:** `sky` is `null`. The renderer's gradient sky stays, and a warning is
  given.
- **`WOODS.WLD` missing or malformed:** the apron is built flat (noise only) and a warning is given.
- **A flat's `TEXTURE.nnn` missing:** those flats are counted in `droppedFlats` and named in a warning. Everything
  else still draws.
- **The ground archive missing:** `terrain` is `null`.

In the browser feature, a failed build only logs. The town stays as `loadTown` drew it.

## Lifetime

`client/gameplay/scenery.js` builds once for each `scene` (town) and drops stale builds with a generation counter.
On travel (a `location` change) or `dispose()`, it does all of the following:

- removes its pass;
- restores the renderer's far plane and `PALETTE` colours;
- frees the GL buffers, textures and programs.

After a context loss, the pass rebuilds its GL objects from the CPU arrays when `renderer.contextVersion` changes.
It keeps only the interleaved terrain buffer.

## Solid flats (colliders.js)

Daggerfall Unity gives flats no collider: `DaggerfallBillboard` and `DefaultTerrainNature` build sprites only, and
only a mesh replacement brings one. Without this module a player walks through every tree, rock, well and barrel.
`colliders.js` decides which placed flats a body bumps into. Each one becomes an upright cylinder that
`CollisionWorld` handles beside its triangles (`client/gameplay/collision/posts.js`). The browser predicts with the
same cylinders the server enforces.

- **Which flats.** Identity comes from Daggerfall Unity's own flat catalogue
  (`RmbBlockEditor/Editor/Persisted/DefaultFlatsCatalog.json`, MIT).
  - Solid: "Trees - <climate>" (the trunk only) and "Rocks - <climate>".
  - Passable: every other nature record (grass, bushes, ferns, flowers).
  - Winter archives use their summer archive's lists.
  - Also passable: crops (301), shrubs, hanging plants, blood, manure, the camp fire, hanging, wall and candle
    lights, treasure (216), editor markers (199), and people and animals. People and animals belong to the
    actor systems.
  - Every other object is a prop and is measured: wells, barrels, carts, signposts, statues, columns, standing
    lamps and braziers.
- **How big.** A flat turns to face the camera about its base centre, so the only collider that does not move with
  the view is a cylinder at that base. Frame 0 of the record (`TEXTURE.nnn`, index 0 transparent) is measured:
  - the radius is the median width of the opaque run through the base centre, over the rows a walking body
    meets (0.1–1.8 m);
  - the height is where that centre column ends;
  - a trunk's radius is capped at 0.5 m and a prop's at 1.6 m, with a 0.1 m minimum;
  - a World of Daggerfall flat's own scale multiplies both.
- **What stays passable on purpose.** No collider is made when the picture does not stand on the ground at its
  base centre: a hanging lamp, or a signpost (212.4, 212.5) or leaning pike (100.11) whose post is drawn at the
  sprite's edge. Any fixed collider there would be an invisible post in empty air. Flats no taller than the step
  height (0.75 m) also get none, because the body steps over them anyway. Canopies never block: only the trunk run
  is measured.
- **Where.** Three paths build the same cylinders:
  - `loadTown` returns `colliders` for town RMB flats, so the browser and the server get them from one call;
  - `buildWildernessScene` returns them for site, block and terrain-nature flats, in `geometryOnly` too;
  - `composeTownCollision` carries the towns' cylinders into a pixel world at the same offsets as their meshes.
- **Missing files.** A missing or unreadable `TEXTURE.nnn` drops only that archive's colliders, which are named in
  `colliders.stats.missingArchives`. Scenes without `colliders` (interiors, dungeons, older fixtures) are
  unchanged.
- **Cost on real data.**
  - About 250 posts in Gothway Garden and 650 in the city of Daggerfall.
  - 6–7 thousand in a wilderness pixel world.
  - 15–460 KiB of index per area.
  - Movement time is within run-to-run noise.

## Limitations

- Only the summer, dry-weather day sky (frame 31) is used. There is no time-of-day frame curve, night sky, rain or
  snow skies, and no winter nature or ground archives.
- Lamps give no light.
- Animals are drawn as static animated flats, with no sound or movement.
- The apron does not continue the town's own ground tiles. Its blend into the town is height-only.
- There is no DFU terrain tile-blending, location flattening or neighbouring terrain tiles. The heightmap is the
  coarse 1000×500 map only. The 5×5 large-map detail in WOODS.WLD is not used.

Notices: [`THIRD_PARTY_NOTICES.txt`](THIRD_PARTY_NOTICES.txt).
