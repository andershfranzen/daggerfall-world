# Overland walking (town ↔ wilderness)

Owner: `server/rpg/overland.js` (feature `overland`), tests in `test/rpg-overland.test.mjs`. The browser streams reachable outdoor scenes in advance and projects the camera into the new frame when the server confirms a crossing.

## What happens

| You are in | You walk | You arrive in |
|---|---|---|
| `town:Region/Name` | past the edge of its RMB block grid (the walkable ground) | `wilderness:<px>,<py>` of the town's own map pixel, at the point on the town boundary where you stepped out. If the town fills its pixel (8×8 cities), you arrive in the neighbouring pixel, or in a town that occupies that point. |
| `wilderness:<px>,<py>` | past the pixel edge (±409.6 m) | the neighbouring pixel, at the same global position, now relative to the next pixel |
| `wilderness:<px>,<py>` | into the rectangle of the classic location in that pixel (heading inward, within 6 m of its edge) | that town at the street position you reached |
| anywhere | past the edge of the 1000×500 world map | nowhere. You are held inside, and a notice says the map ends there. |

You leave by the side you walk out of, and you return to the same spot on the town's edge. North is north on
both sides.

## Walking checks

With a keyboard held down, the browser crossed the Gothway Garden town boundary and the boundary between wilderness pixels 109,159 and 109,158 in both directions. Each route also crossed with the destination’s scene publication delayed. The server includes the viewer’s location in movement snapshots so the browser can apply each position in the right coordinate system, including on an immediate reversal.

In two hardware-accelerated Chromium runs, the requested wilderness pixel was deliberately evicted and its replacement held for 2.5 seconds. The previous scene stayed visible during the crossing. The longest frame within half a second of the boundary was 34 ms and 38 ms. The longest frames after crossing, including preparation of the replacement, were 62 ms and 98 ms. Before slicing geometry and GPU uploads, the same route recorded a 166 ms frame. These timings describe this route and machine.

## Rules

- **Authority.** The server decides every transition in its tick, after movement and collision. Clients never
  request one. Your input direction must point out through the edge. Standing at a wall, turning back, or
  standing inside a town rectangle never triggers a transition.
- **Continuous motion.** The server changes coordinate frames without adding distance to the walk. Turning
  back across a boundary works on the next movement tick. A stationary player stays in the current location.
- **Adjacency.** A transition only ever reaches the same map pixel or one of its eight neighbours. A transition
  that would go further is refused and logged.
- **Arrival.** The server starts loading collision in the direction of travel within 64 m of a pixel edge.
  Both scenes must have clear footing at the crossing. A sweep up to 2.5 m into the destination checks for
  intervening obstacles. The player stays at the position reached by walking while the check runs.
- **Scopes.** `rpg.location` changes, so peers, chat, entities and `state` snapshots switch to the new location in
  the same tick. No reward, gold or teleport is involved. Entering a town calls `services.travel.discover`, which is
  idempotent. Entering a pixel calls `services.wilderness.onEnter(p, id)`, which sets `returnTo` and the nearby list.
- **Events.** `ctx.emit('overland', {player, from, to, side})` is sent to other features. The player receives a
  private `{kind:'overland', status:'moved'|'edge'|'blocked', from, to, side, px, py, text}`.
- **Fast travel** (`travel.go`) is unchanged.

## Frames

Units are metres, +x is east, +z is south (−z north) and y is up.

- In `wilderness:<px>,<py>`, the origin is the pixel centre.
- In a town, the origin is the town's spawn point (`client/world/README.md`).
- The town's block grid sits in its pixel at DFU's `TerrainHelper.GetLocationTerrainTileOrigin`. It is centred, in
  6.4 m tiles of `(128 − w·16)/2`. One-by-one `CUST*` blocks sit at tile (72, 55).
- `xw = x + (ox·6.4 + spawnLocal.x − 409.6)` and `zw = z + (409.6 − oy·6.4 − spawnLocal.z)`.
- The global frame is `E = px·819.2 + 409.6 + x` and `S = py·819.2 + 409.6 + z`. The map pixel's y increases
  southward, as in `MapsFile.MapPixelToWorldCoord`.

These transforms live in `client/world/exterior/frame.js` (`townFrame`, `townToWild`, `wildToTown`, `toGlobal`,
`fromGlobal`, `inPixel`, `exteriorObjectKey`, `townMeshOffset`); the server's `overland.globalOf/localOf` use them.
Heights share one absolute reference: a scene's `wilderness.absoluteHeightAt(x, z)` is its local height plus
`wilderness.datum`, and each town in `wilderness.towns` carries a stable `key`
(`pixel:<px>,<py>/town/<region>/<index>`) and the absolute `elevation` its footprint is flattened to.
`townMeshOffset(town, source, scene)` places the native town mesh in that scene. The server's pixel collision is
the same terrain plus every nearby native town mesh at that offset, so a wall or gate is in the same place seen
from the town or from either pixel. `test/exterior-surface.test.mjs` checks this on the installed data.

The placement of a town (`width`, `height`, `spawnLocal`) is read with the same `loadTown()` that the browser and
collision use. Only `source` is kept, for at most 48 towns. Placements for the 3×3 pixels around each player are
warmed in advance.

## Streaming and collision

- The browser retains nearby terrain and towns and builds their collision indices in a worker. At a walking
  boundary the camera, prediction history and view change frames together. A late destination can keep drawing
  the previous view and use the previously indexed pixel's overlapping collision until its own scene is ready.
- With ARENA2 installed, the server and browser build the same WOODS.WLD terrain and site geometry. A pixel surface
  that is still loading holds a crossing; one that fell back to the open plane blocks it with a notice.
- **Town walls.** Every crossing is swept on the pixel surface, which contains the town's own walls. A walker is
  taken across only when the straight step from where they stand to the arrival point is clear, so a wall blocks
  from both sides and a gate opens from both sides.
- **No road snapping.** Arrival keeps your exact coordinate along the edge. It does not move you onto a road.
- Encounter markers from the current wilderness pixel are available to combat on arrival, including entry on foot. A pixel without markers has no authored enemies.
- **Fast travel** can start in a wilderness pixel. The map quotes the journey from that pixel and the server validates the fare using the same route.
- **Server extent.** `WORLD_HALF_EXTENT` (default 512 m) clamps positions. Every pixel and every town measured so far
  fits inside it. A town whose spawn lies more than about 510 m from a grid edge logs a warning and asks for 820 m or
  more.
