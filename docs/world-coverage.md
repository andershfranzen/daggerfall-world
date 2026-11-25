# World coverage audit

Brief B of the [world expansion plan](world-expansion-plan.md). The audit is a read-only command over the operator's installed data. It walks every classic `MAPS.BSA` record by numeric region/location index. It resolves the exterior layout, every referenced RMB and RDB block, every model, building doors, associated dungeons, and start and exit markers. It classifies every World of Daggerfall placement row with the production loader's verdict. Then it builds a route sample with the same loaders the browser and server use.

```sh
node tools/world-audit/index.mjs                   # classic and pack runs (~1 min + ~2.5 min)
node tools/world-audit/index.mjs --mode classic    # WorldData off, no WoD rows
node tools/world-audit/index.mjs --record 17/197   # one record and its named routes
node tools/world-audit/index.mjs --strict          # exit 1 while an implementation failure remains
node --test test/world-audit.test.mjs              # synthetic, broken-source and installed-data cases
```

The command reads `ARENA2_DIR` (or `gamedata/DaggerfallGameFiles/arena2`) and `WOD_PATH` (or `gamedata/world-of-daggerfall`). It writes `census.json`, `routes.json` and `summary.json` for each mode under the ignored `progress/world-audit/`. The output holds counts, record keys, block and model names, and short reasons. It holds no meshes, art or text. The first census is kept as `progress/world-audit/first-census.<mode>.json`. Every later run is compared with it, and the summary reports changed totals plus fixed and new issues.

| Module | Role |
| --- | --- |
| [`census.mjs`](../tools/world-audit/census.mjs) | Per-record sweep: identity (`catalog.at`, `catalog.get`, `catalog.atPixel`), exterior grid, block references, dungeon association and portals. |
| [`blocks.mjs`](../tools/world-audit/blocks.mjs) | One inspection per distinct archive block (memoised), model triangle expansion, door pairing, switch/door link candidates. |
| [`exceptions.mjs`](../tools/world-audit/exceptions.mjs) | Re-derives evidence for each issue from raw blocks and models, then classifies it. |
| [`wod.mjs`](../tools/world-audit/wod.mjs) | Every published WoD row through `store.rowsAt` (`rejectReason`) and `sceneSites`, with dependency resolution. |
| [`routes.mjs`](../tools/world-audit/routes.mjs) | Route registry and route builds (`loadTown`, `locationPortals`, `loadInterior`, `loadDungeon`, WoD scene sites). |
| [`report.mjs`](../tools/world-audit/report.mjs) | Coverage columns, baseline comparison, console summary. |
| [`sources.mjs`](../tools/world-audit/sources.mjs) | Opens the data and builds the in-memory `withoutBlocks` fault-injection view used by fixtures. |

## Issue contract

Every issue has `{place, kind, owner, asset, reason, at}`. `place` is the `region/index` key or a `wod:` site id. `owner` is the brief letter that fixes it. The exception pass assigns a class:

- **implementation**: a loader or scan bug. This fails `--strict`, and its owner fixes it and reruns.
- **source-anomaly**: the authored data really lacks the piece. It gets its own count and doesn't reduce geometry coverage.
- **quest-only**: reached by scripted teleport, not an ordinary portal.
- **optional-dependency**: a missing pack piece. Classic geometry never depends on one.
- **ownership-prerequisite** appears in the November 24 baseline for the two ships. Current ship routes record ownership as an entry requirement and count a loader error as a failure.

## Route registry

`NAMED_ROUTES` in `routes.mjs` holds the plan's records. Each entry is `{id, kind, owners, key?, site?, pixel?, pack?, why}`. `key` is the numeric `region/index` address. `site` is a WoD site id. `pack: 'on'` routes run only in pack mode. `stratify()` adds one record for each populated region × location type, preferring the lowest index the census found complete. It also adds climate samples and the nearest pixel with no classic record. A named record that also samples its stratum is built once and counted for both.

| Route | Record | Built in | Result |
| --- | --- | --- | --- |
| `gothway-garden` | 17/197 at (109,159), 4×3 | both | 162 buildings, 215 doors, interior with exit |
| `gothway-north-pixel` | (109,158) | both | holds the Privateer's Hold record, `town:17/179` |
| `daggerfall-city` | 17/1231 at (207,213), 8×8 | both | 629 buildings, 817 doors; the 3 known castle interiors are excluded |
| `privateers-hold` | 17/179 | both | entrance, 5-block dungeon, finite start, exit |
| `peristair-switch` | 17/201 | both | lever 61028 → action door 55001 in `N0000051.RDB` (block 0,1) |
| `alikr-djen-lodge-a`/`-b` | 0/139 (310,435), 0/272 (319,483) | both | each loads its own record; the later one's address is `town:0/272` |
| `port-of-daggerfall` | 17/1246 at (207,214) | both | classic Copperfield Manor 1×1 with 11 buildings; pack Port of Daggerfall 3×3 with 95 buildings |
| `ship-a`/`ship-b` | 31/1, 31/2 | both | both ship records load in the current installed-data check; boarding requires ownership |
| `mantellan-crux` | 31/0 | both | quest-only (see below) |
| `wod-camp` | `wod:109,158:21,21` | pack | `WOD_BanditCamp_04`, 5 markers including 2 monsters |
| `wod-farm` | `wod:110,159:107,54` | pack | `WOD_Farmaa03`, one RMB block piece |
| `wod-dock` | `wod:98,162:63,53` | pack | `WOD_Dock_Small_01`, sea-level ground |
| `empty-pixel` | nearest pixel to Gothway Garden with no record | both | no classic record and no WoD rows |

## Census, 24 November 2026

Installed classic data plus the installed World of Daggerfall bundle. The classic run is identical to the preserved first census. Totals, block statistics and all 32 issue identities match.

| Coverage | Classic | With pack |
| --- | --- | --- |
| **Catalogued**: records by key and pixel | 15,251 / 15,251 in 45 regions, 15,251 distinct pixels | 15,251 / 15,251 |
| Catalogued: WoD placement rows accepted | — | 329,035 / 329,040 (4 out of bounds, 1 on a town) |
| **Geometry**: records | 15,251 / 15,251 | 15,251 / 15,251 |
| Geometry: distinct RMB / RDB / models | 658 / 658, 187 / 187, 2,389 / 2,389 | same |
| Geometry: RMB / RDB references | 45,427 / 45,427, 40,263 / 40,263 | 45,435 / 45,435, 40,263 / 40,263 |
| Geometry: route scenes assembled | 560 / 560 | 563 / 563 |
| **Reachable** (loader-level): region × type strata | 550 / 551 (the ship stratum is gated) | 550 / 551 |
| Reachable: RMB interiors with paired outside and return doors | 421,561 / 421,564 | 421,645 / 421,648 |
| Reachable: associated dungeons with entrance, start and exit | 4,203 / 4,232 | 4,203 / 4,232 |
| **Interactable** | pending: F, G, H and I own the checks; candidates are in the registry | |
| **Multiplayer-verified** | pending: E and integration; 0 automated, 0 live browser | |

All 129 duplicate region/name groups (354 records) are audited one row each. The fixtures confirm that a failure on a later duplicate is reported under its own key.

The **Reachable** column here is the automated loader sweep. The production travel, portal-service and collision walks, and the two-browser routes, stay with their owning briefs. Count them separately.

Brief G’s production dungeon audit passed 4,231 exterior journeys and portal round trips, including 28 labeled compatibility entrances, plus the gated Mantellan Crux destination. The source census still reports the original missing faces in the table below. See the [dungeon access report](dungeon-access.md) for coverage counts, action semantics and browser evidence.

### Classified exceptions (unchanged from the first census)

| Class | Owner | Count | Places | Evidence | Next step |
| --- | --- | --- | --- | --- | --- |
| source-anomaly | G | 28 | 28 graveyards: 0/108, 16/27, 16/172, 16/195, 16/411, 17/1137, 18/70, 18/412, 20/364, 21/124, 21/415, 22/10, 22/33, 23/170, 23/524, 32/276, 33/19, 33/33, 36/11, 38/96, 39/138, 40/431, 47/27, 48/175, 52/62, 52/156, 60/198, 60/282 | All use only `GRVEAS10.RMB` (87 models) or `GRVEAS36.RMB` (43 models). Neither block has a door plane of any type, and no other record uses them. The other 746 graveyard dungeons have entrances. | These records have a labeled compatibility entrance at the exterior spawn and use the authored dungeon exit. |
| source-anomaly | F | 3 | 17/1231 `CUSTAA05.RMB` #4, #5, #6 at block 5,6 | Building type 22 with interiors that have 2 return doors each. Each exterior model's only door faces are 2 dungeon entrances (the castle), so the door leads into the Daggerfall dungeon. | F excludes these interiors from building denominators and directions. |
| quest-only | G / I | 1 | 31/0 Mantellan Crux | The exterior has an entrance face. None of its 7 RDB blocks (`S0000000`–`S0000006`) has an exit plane. | Treat it as a quest teleport destination, not an ordinary dungeon route. |
| ownership-prerequisite | A / F | 2 | 31/1, 31/2 (ships) | In the November 24 sweep both rows were complete but had no street spawn. Both now build with their own exterior record. | Boarding now waits until deck collision is ready (fixing the height-0 hull landing); re-verify both vessels in Play with installed data. [Property](property.md) |

There are no implementation failures. `--strict` exits 0.

### World of Daggerfall dependencies

Accepted sites reference 253 distinct classic models, 48 custom prefabs and 17 RMB blocks. Every custom prefab, block and embedded layout resolves. **66 numeric model ids are not in the installed `ARCH3D.BSA`**: 63 ids between 45000 and 45072, plus 45160, 52990 and 53230. They are placed 113,577 times in accepted sites, for example `ARCH3D:52990` in `WOD_BanditCamp_*` (90,292 placements) and `ARCH3D:53230` (6,497). The scene builder skips them with a warning, so the rest of each site stays usable. This is H's optional-dependency list. The full ids are in `progress/world-audit/pack/summary.json`.

## Fixtures

`test/world-audit.test.mjs`:

- Registry contract and plan records, stratification, and summary arithmetic run on synthetic data with no game files.
- **Missing core RMB.** Hiding Gothway Garden's first block fails 17/197 with that block name, `geometry`, owner C and the "no exact or classic fallback RMB" reason. The view also blanks the directory name, so the classic prefix/suffix fallback can't silently substitute another block.
- **Missing RDB.** Hiding `N0000051.RDB` fails 17/201's dungeon with owner G.
- **Duplicate names.** Both Djen Lodges resolve to their own pixels. The two "Your Ship" records use different blocks. Hiding only the second ship's block fails 31/2 and leaves 31/1 complete.
- Installed-data reconciliation, named route builds, and the pack sweep with the camp, farm and dock sites.
