# World of Daggerfall Project: sources, permissions, private install and model support

This covers the custom meshes, materials and rock/mountain metadata of the *World of Daggerfall Project* (Nexus
Daggerfall Unity mod 249). Site placement, ids and the scene descriptor are covered in
[wilderness-protocol.md](wilderness-protocol.md).

## Sources and credits

| What | Where | Pinned |
|---|---|---|
| World of Daggerfall Project (release page, credits, permissions) | <https://www.nexusmods.com/daggerfallunity/mods/249> | — |
| Author repository (the same tree the release is built from) | <https://github.com/drcarademono/world-of-daggerfall> | `3bf8837402cce41421dcb36c64a3a2c4f27d0448` ("Downscale rocks, add Betony bridges"), mod version 0.4.0 |
| Location Loader (the placement semantics we reproduce) | <https://github.com/KABoissonneault/DFU-LocationLoader> | `a5e7a187de1e89465b29001cd7f0b88ecd6d4aa0` |

Credits, as listed by the authors (README and Nexus page). Lead developers: KABoissonneault, Cliffworms, Kamer and
carademono. Contributor: imsobadatnicknames. UncannyValley wrote the original Location Loader, and KABoissonneault
maintains it, with major contributions from Kamer. Kamer made the original World of Daggerfall, the bandit camps,
ruins and shrines. carademono made the GIS Construction Kit and WOD Biomes, maintains the WOD terrain, and placed the
locations and rocks. Ninelan made the heightmap and rivers. Cliffworms made the orc camps. The GitHub contributors are
drcarademono, KABoissonneault, JayH2971 and Cliffworms.

The scale-aware rock texturing idea, the pebble model set, the 1.05/4 stretch thresholds and the 8 m repeat cap
come from the MIT-licensed dfjs-research-03 (`src/world/worldOfDaggerfall/wodRockUv.js`, © 2026 Lattymoy). Our
implementation in `client/world/wilderness/models.js` is independent.

## Permissions and how we honour them

- Neither GitHub repository has a license file (`license: null` via the GitHub API on 2026-11-24). Nexus refuses
  automated fetches (HTTP 403). A search snapshot of the mod 249 page shows these terms: no use of its assets in
  mods or files sold for money (Steam Workshop or elsewhere), no Donation Points for mods that use its assets, and
  the rules also apply to unofficial or alternative versions, including those made with generative AI. **The
  upload, modification and conversion lines could not be read**. Check the live page before changing anything below.
- So this project treats the mod strictly as **operator-installed input**:
  - Nothing from the mod is in git. That includes meshes, textures, prefabs, layouts and JSON. `gamedata/` is
    ignored.
  - Conversion is in memory at runtime, from the player's or operator's own copy. No converted file is written,
    cached to disk, bundled or published.
  - The server reads the pack for site placement, town and farm replacements, encounters and collision. It never serves the pack publicly. The browser
    either reads the player's own folder or, on a loopback development run only, uses the `/local-assets/wod/*` routes behind the same gate as
    ARENA2 (`server/local-assets.js`). Those routes offer only bundled prefab-referenced `.png` textures and
    converted prefabs.
  - Nothing is sold, and no donation points are involved.
- Screenshots that show mod art stay in the ignored `progress/screenshots/` folder (AGENTS.md).

## Private installation

1. Get the mod: download the release from the Nexus page (log in, then use the Files tab), or clone the author
   repository at the pinned commit:
   `git clone https://github.com/drcarademono/world-of-daggerfall gamedata/world-of-daggerfall && git -C gamedata/world-of-daggerfall checkout 3bf8837`
2. Leave it at `gamedata/world-of-daggerfall/`, or set `WOD_PATH`. The folder must contain
   `WorldOfDaggerfall.dfmod.json`, `Locations/`, `Prefabs/`, `Meshes/`, `Materials/`, `Textures/` and
   `CustomRuntimeMaterials/`. A `.dfmod` asset bundle alone is not readable (it's a Unity AssetBundle).
3. Daggerfall's `ARENA2` must also be installed (`gamedata/DaggerfallGameFiles/arena2`). Rocks use classic textures
   (for example 302.3, 102.3, 103.3), and pebble pieces are ARCH3D models.
4. Run `node --test test/rpg-wilderness-models.test.mjs`. The real-pack and real-ARENA2 cases run when these folders
   exist, and are skipped otherwise.

## What the release actually uses (audit of `3bf8837`)

`auditWodModels(root)` (`server/rpg/wilderness/models.js`) reads the manifest, the bundled CSVs and the layouts they
name, nothing else:

- The manifest lists 866 files, including 185 CSVs, 121 Unity prefabs, 63 materials and 44 PNGs. Its CSVs place
  329,040 instances of 202 layouts. Every layout they name or embed is bundled. Names match case-insensitively,
  as DFU asset lookup does: `wod_prop_scouttower` (type 3 in `WOD_OrcCamp_Large_01`) is `WOD_Prop_ScoutTower.txt`.
- **Type 4 (mod Unity prefab)**: 48 distinct prefabs, all bundled, placed **1,095,412** times. They are 35 rocks
  (`WOD_Rock_*`, `WOD_Rocks_*`, scaled up to ×425, so a rock 0.7 m long in the model reaches 300 m), 12
  `Mountain_*`/`Mountain_1C_*` massifs (a 120–176 m mesh at up to ×35, several kilometres) and
  `WoodenBridge_Section`. Numeric type-4 names (45000–45072, 52990) are ARCH3D models, as in Location Loader.
- **Type 0 ARCH3D pebbles** (60711–60720, 41719) are placed 177,533 times, stretched up to ×75 per axis in the
  layout (×938 in `WOD_Betony_Docks_North_00`). They make up camps, forts, docks and older outcrops.
- Formats: the meshes are binary FBX 7400 (Blender export, cm, Y-up, zlib arrays, n-gons up to 107 vertices).
  Prefabs and materials are Unity YAML resolved through `.meta` GUIDs. Rock materials are picked at runtime by
  `WODRocksMaterials` from `CustomRuntimeMaterials/<prefab>.json` (by climate, season and region). The bridge uses
  DFU's `RuntimeMaterials` (ARENA2 archive/record, climate-swapped).

## Implemented

Shared code, in browser and Node alike: `client/world/wilderness/fbx.js` and `client/world/wilderness/models.js`.
Server code: `server/rpg/wilderness/models.js`.

- **Lossless binary FBX reader** (7100–7700), without dependencies. It inflates arrays with `DecompressionStream`,
  then reads vertices, polygons, ByPolygonVertex/IndexToDirect UVs and normals, per-polygon materials and Model
  transforms.
- **Unity import, reproduced**: positions are `(-x, y, z) × UnitScaleFactor/100 × globalScale`, and normals are
  mirrored. Winding is kept, submeshes are ordered by material index, and n-gons are ear-clipped. The mesh asset is
  used without its node transform, as the prefab references it. All 48 referenced prefabs import with no anomaly.
  The bridge placement (sections 5.55 m apart) confirms that the node rotation isn't applied.
- **Prefab and materials**: root scale (Location Loader multiplies it by the object scale), MeshCollider,
  `.mat` main texture, tiling, offset and tint. `selectRuntimeMaterials` reproduces `WODRocksMaterials`, including
  climate fallbacks, desert/subtropical/snowless winter rules, and the Balfiera/Hammerfell region overrides (the
  Biomes mod is treated as absent). `resolveCustomMaterials` resolves textures in DFU order: a mod
  `<archive>_<record>-<frame>` material first, then ARENA2. Slots left without a material aren't drawn, as in
  Unity.
- **Triangles for the renderer** (`customPieceTriangles`, `pieceTriangles`): these are placed with the renderer's
  `modelMatrix` (scene.js). UVs are in repeats with a top-left origin, shifted by whole repeats, and are meant to be
  drawn with REPEAT.
- **Stretched ARCH3D pebbles**: `unfoldPlaneUvs` gives each plane an isometric unfold. Texture rows follow the
  stretched pebble's rows, density is preserved, and rock is capped at 1 repeat per 8 m using the map's largest
  singular value. The shift is by whole repeats.
- **Collision**: `wildernessCollisionTriangles` returns triangles for ARCH3D pieces and for MeshCollider prefabs,
  with the same matrices as the renderer, for `CollisionWorld`. Pieces larger than `maxExtent` are skipped and
  reported.
- **Pack access**: `createWodModelStore` builds the index from the manifest plus `.meta` GUIDs (218 GUIDs in about
  15 ms) and converts prefabs on demand (all 48 take about 0.5 s). Reads are limited to listed files, with no
  symlinks or traversal. `serializeCustomPrefab`/`deserializeCustomPrefab` validate the HTTP transport format.

Verification: `test/rpg-wilderness-models.test.mjs` passes 15/15, with synthetic FBX and YAML fixtures, the real
pack and real ARENA2. There is also a headless-Chromium WebGL render of the real layouts `WOD_Rocks_Round_Small_10`,
`WOD_Mountain_01` and `WOD_Rocks_Cave_00` (classic UVs vs unfold). It is saved as
`progress/screenshots/agents/wod-custom-models-harness.png` (ignored).

## In-game integration and remaining limits

- The browser has two tested model sources. Loopback uses the installed pack automatically. In the Wilderness menu, **World of Daggerfall model files** lets a player select the author's source folder on any host. The selection stays in that page for the session.
- The shared scene builder uses the composed placement matrix for rendering and collision. A live trip to the Orc Camp near Totambu loaded two mountain FBXs and `Mountain_DarkBrown.png`. A trip to a camp near Sentinel read meshes from a player-selected folder.
- Some sites and replacement blocks reference custom model numbers from the separate RMB Resource Pack. If that geometry is absent from ARCH3D, those pieces are omitted. The game supports the author's source directory format for World of Daggerfall.
- When an outdoor scene loads, the shared calendar selects its sky and the summer or winter ground, nature, block and bridge textures. The bridge follows DFU's two-season `RuntimeMaterials` rule.
- The **WOD Biomes** and snowless companion mods are assumed absent. Hammerfell mountains use the Balfiera set, as
  `WODRocksMaterials` does without Biomes.
- **Not parsed**, because shipped layouts don't reference them: `Meshes/37000.dae`, `FX_Smoke`,
  `CPT_Island_L_f_08`, the `Signs/50000` replacement, and the 73 unreferenced bundled prefabs.
  `store.custom(name)` would load them, but nothing places them.
- **Terrain** uses the player’s WOODS.WLD, site flattening and sink. Towns and farm blocks read the operator’s WorldData overrides. An external replacement heightmap is outside this loader.
- Unity's lighting, shadows and LOD aren't reproduced. Meshes are drawn with the project's own lighting.
