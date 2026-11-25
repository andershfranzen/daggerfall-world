# client/world — original-data town loader

`town.js` builds a town exterior from the player's own Daggerfall files in the browser. It reads the files with
`Blob.slice()` and uploads nothing. It returns flat arrays that a WebGL renderer can draw directly. It ships no game
data and has no substitute geometry: if the data is missing or malformed it throws.

```js
import { loadTown, WorldDataError } from './world/town.js';
const town = await loadTown(input.files); // <input type="file" webkitdirectory>
```

## Input

`loadTown(files, options?)`

- `files` must be an iterable of `File` (or `Blob` with `name`) objects. It can be the `ARENA2` folder itself or the
  installation folder that contains it. Basenames are matched case-insensitively. If the same basename occurs twice,
  the copy whose parent directory is `ARENA2` wins, then the shallowest path (from `webkitRelativePath`).
- These files are required: `MAPS.BSA`, `BLOCKS.BSA`, `ARCH3D.BSA`, `CLIMATE.PAK`, `ART_PAL.COL` and the
  `TEXTURE.nnn` archives the town uses. For Gothway Garden, `TEXTURE.302` supplies the ground tiles and the building
  textures come from the 0xx/1xx/3xx archives. The error message names every missing required file.
- `options.region` and `options.location` default to `"Daggerfall"` and `"Gothway Garden"`. Both are matched
  case-insensitively. The loader never falls back to another town on its own. A caller can pass another location name
  explicitly. All 6,910 locations in the regions Daggerfall, Wayrest, Sentinel, Alik'r Desert, Dragontail Mountains,
  Dwynnen, Wrothgarian Mountains, Orsinium Area and Abibon-Gora load without error.

### Errors

`WorldDataError` (also exported from `errors.js`) is thrown when:

- a required file is missing (the message lists every missing file);
- the input is not an iterable of `File`/`Blob` objects;
- a BSA archive has a bad header or directory, or a size mismatch;
- the region or location is unknown;
- a block, model or texture archive or record is missing or truncated;
- the palette has the wrong size;
- no open spawn point exists.

Every `File.arrayBuffer()` error passes through unchanged.

## Output

```ts
{
  name: string,                 // "Gothway Garden"
  region: string,               // "Daggerfall"
  positions: Float32Array,      // TRIANGLES, 9 floats per triangle (x,y,z ×3), metres
  colors: Float32Array,         // same length as positions; RGB in [0,1]; all 1.0 (every triangle is textured)
  uv: Float32Array,             // 2 floats per vertex (positions.length / 3 * 2), atlas coordinates in [0,1]
  atlas: { width, height, pixels: Uint8Array },  // RGBA8, width*height*4 bytes, row 0 = image top
  uvConvention: 'atlas-v-down',
  frontFace: 'ccw',
  bounds: { minX, maxX, minZ, maxZ, minY, maxY },
  spawn: { x: 0, y: 0, z: 0, yaw: 0, forward: [0, 0, -1] },
  ground: { included: true, meshY: -0.025, walkY: 0, firstTriangle, triangleCount },
  source: { region, regionIndex, locationIndex, mapId, longitude, latitude, climate,
            width, height, blocks: [{ name, x, y }], spawnTileRecord, spawnTier, spawnLocal },
  stats:  { modelInstances, uniqueModels, textures, triangles, modelTriangles, groundTriangles,
            droppedPlanes, climateSwapFallbacks },
}
```

### Coordinates

- The coordinate system is right-handed with +y up. North is −z and east is +x. One unit is one metre, using
  Daggerfall Unity's scale of 0.025 m per native unit. A 16×16-tile RMB block is therefore 102.4 m square and a ground
  tile is 6.4 m.
- The spawn point is the origin. It stands on a cobbled street, and the player looks down −z (north, yaw 0). The
  street is clear of geometry from 0.1 m to 2.2 m within 1.5 m of the spawn and along a 1 m × 12 m corridor ahead.
- The ground is at y = 0 for walking. The ground mesh itself is drawn 2.5 cm lower, at y = −0.025 (DFU's
  `GroundOffset`), so that it does not z-fight with building polygons at ground level. Some props sink slightly
  below the ground, down to about −0.56 m, as they do in the original game.
- `bounds` covers every vertex in output space. The origin always lies inside it.

### Triangles, winding and colours

- Draw with `gl.drawArrays(gl.TRIANGLES, 0, positions.length / 3)`. There is no index buffer.
- Front faces are counter-clockwise, which is the WebGL default. Most building models are single-sided, so back-face
  culling is safe for exterior views. A renderer can also leave culling off.
- No normals are supplied. Compute flat face normals from the triangles. Their direction follows the CCW winding.
- `colors` are always white because every triangle is textured. Multiply them with the texture colour.

### Textures

- `atlas.pixels` is RGBA8 and is 2048 pixels wide. Its height is a power of two (512 for Gothway Garden).
- The v axis runs down: v = 0 is the first row of `atlas.pixels`, which is the top of each source image. Upload the
  pixels with `UNPACK_FLIP_Y_WEBGL = false` and use the uv values as they are.
- Every uv lies inside a single texture's rectangle. Daggerfall faces repeat their textures, so the loader splits
  each face at the texture's repeat seams (`emitTexturedPolygon`). No `fract()` or atlas-rectangle logic is needed in
  the shader.
- Each texture has a 2-pixel border filled with its own wrapped content. Use `NEAREST` filtering and no mipmaps.
  `CLAMP_TO_EDGE` is fine.
- In model textures, palette index 0 is transparent (alpha 0), as in DFU's `MaterialReader`. Alpha-test it, for
  example `if (a < 0.5) discard;`. Ground textures are fully opaque.
- Textures are decoded from frame 0 of `TEXTURE.nnn` using `ART_PAL.COL`. Archive numbers are swapped for the
  location's climate (`CLIMATE.PAK`) in the summer, dry-weather variant, following DFU's
  `ClimateSwaps.ApplyClimate`. Gothway Garden has climate 231 (Woodlands): temperate (3xx) building sets and
  `TEXTURE.302` ground tiles.

### Ground

- The ground is included in `positions`, `colors` and `uv` as the last `ground.triangleCount` triangles, starting
  at `ground.firstTriangle`. Each 6.4 m tile is one quad (2 triangles). The quad is textured with its RMB ground tile
  record (`bits & 0x3f`; records 56 and above become grass, record 2, as in DFU). The rotate (0x40) and flip (0x80)
  bits are applied by permuting the corner UVs, matching DFU's `TextureReader.GetTerrainTilesetTexture` variants.
- The ground only covers the town's blocks, which are flat. The surrounding `WOODS.WLD` terrain is not generated.

## Data path (source references)

| Step | File | Reference |
| --- | --- | --- |
| Index files, case-insensitive | `files.js` | — |
| BSA container | `bsa.js` | DFU `API/BsaFile.cs` |
| Location → block grid, RMB names | `maps.js` | DFU `API/MapsFile.cs` (`ReadMapPItem`, `ResolveRmbBlockName`, `ReadMapTable`) |
| Climate value | `maps.js` | DFU `API/PakFile.cs`, `MapsFile.GetWorldClimateSettings` |
| RMB block: ground tiles, sub-record positions, exterior and misc 3D models | `blocks.js` | DFU `API/BlocksFile.cs` (`ReadRmbFldHeader`, `ReadRmbBlockData`, `ReadRmbModelRecords`, `CheckName`) |
| Mesh planes, UV generation, patch table | `arch3d.js`, `arch3dPatch.js` | DFU `API/Arch3dFile.cs`, `API/FaceUVTool.cs`, `API/Arch3dPatch.cs` |
| Textures, palette | `textures.js` | DFU `API/TextureFile.cs`, `API/DFPalette.cs` |
| Placement, ground plane, winding, climate swap | `town.js` | DFU `Utility/RMBLayout.cs` (`AddExteriorBlockModels`, `AddMiscBlockModels`), `Internal/DaggerfallLocation.cs`, `MeshReader.cs` (`LoadVertices`, `LoadIndices`, `GetSimpleGroundPlaneMesh`), `Utility/ClimateSwaps.cs` |

The placement rules, in DFU's left-handed space before the z mirror:

- Block `(bx, by)` is placed at `(bx, by) × 102.4 m`. The RMB name for that block is `blockNames[by*width + bx]`.
- Each sub-record is placed at `(XPos, 0, 4096 − ZPos)` and yawed by `−YRotation / 5.68888888888889` degrees.
- A model inside a sub-record is placed at `(XPos, −YPos, ZPos)` with the same yaw formula.
- Misc 3D models are placed at `(XPos, −YPos − 4, ZPos + 4096)`.
- Model vertices are `(x, −y, z)`. All positions above are native units, multiplied by 0.025 to get metres.

Licences and attribution are in [`THIRD_PARTY_NOTICES.txt`](THIRD_PARTY_NOTICES.txt). Both upstreams are MIT.

## Limitations

- Billboards (flats) are not drawn. These include trees, lamps, signs, NPCs and animals.
- Doors are drawn closed, as part of the building model. Interiors and dungeons are not loaded.
- `loadTown(files, { winter: true })` selects Daggerfall Unity's `ClimateSeason.Winter` textures: snow ground
  (`groundArchive + 1`) and the snow variants of building sets, except in desert-based climates (Desert, Desert2,
  Subtropical), which keep their summer look. Geometry is identical in both looks, so an already-loaded scene changes
  texture in place ([`exterior/season.js`](exterior/season.js), driven by `client/gameplay/wilderness.js`). Like Daggerfall
  Unity, rain variants (`archive + 2`), animated texture frames and night window emission are not used.
- The terrain is the flat town area only. There is no `WOODS.WLD` heightmap, no surrounding landscape and no
  blending into terrain at the town edge.
- The spawn search chooses its street from the ground-tile record. Record 46 is the cobbled road (mean colour
  115,115,115) and 47 is the road edge. Road-less places such as farms and manors fall back first to a road tier,
  then to any non-water tile (`SPAWN_TIERS`). Collision clearance is a conservative test of triangle bounding boxes.
- When a plane has more than 3 points, DFU throws away the whole model if it hits a degenerate edge. This loader
  drops only that plane and counts it in `stats.droppedPlanes`. The count is 0 across all 6,910 locations swept.
