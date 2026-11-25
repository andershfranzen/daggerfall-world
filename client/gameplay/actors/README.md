# Actor sprites (`client/gameplay/actors.js`)

Draws shared entities (`api.state.entities`) and remote players (`api.state.peers`) as classic 8-direction billboards. The billboards are decoded in the browser from the player's own `TEXTURE.nnn` and `ART_PAL.COL`. The module also picks the actor under the crosshair. It only reads state: it never changes entities, sends actions or transmits art.

## Files

| File | Role |
| --- | --- |
| `actors.js` | `install(api)`, `ActorController`: state sync, animation, picking, fallback readout |
| `actors/spriteArchive.js` | Multi-frame TEXTURE reader for every record and frame. Applies the record scale (`size + size*scale/256`, 0.025 m per unit) |
| `actors/library.js` | Loads archives on demand from the selected files and packs each archive into one RGBA atlas |
| `actors/tables.js` | Archive numbers, per-facing record/flip tables, frame rates, corpses, town people, treasure icons |
| `actors/logic.js` | Appearance resolution, facing index, record/frame choice, `AnimState` |
| `actors/occlusion.js` | Segment against town triangles (line of sight for targeting) |
| `actors/spritePass.js` | WebGL billboard pass (alpha test, fog, depth test against the town) |

## What the shell gets

`install(api)` returns the following object and also stores it as `api.actors`:

- `hasSprite(id)` is true when a real sprite was drawn for that peer or entity id this frame.
- `drawnIds()` returns the ids drawn this frame.
- `target()` returns the current target info (see below) or `null`.
- `appearance(id)` returns the resolved appearance `{archive, layout, record, mobile, guard, personLike, corpse, readied?}`.
- `library` is the `SpriteLibrary` (`get(archive)`, `load(archive)`, `failed`).
- `update(camera, dt, now, renderer, town)` drives one frame manually. Normally the `frame` event or the render pass does this.

The module also sets these fields on `api`:

- `api.spritesActive` is true while at least one actor sprite is drawn.
- `api.target` is set through `api.setTarget(id)` to the visible actor under the crosshair. The actor must be within 40 m, have an opaque pixel under the crosshair and not be hidden by town geometry. Peers count. The feature claims the target only once a sprite is drawn, so the shell's fallback picker keeps working when no files are loaded.
- `api.targetInfo` is `{id, kind, name, distance, dead, loot, hp?, maxHp?, role?, readied?}`. `kind` is `player`, `monster`, `npc`, `loot` or `corpse` (a dead monster).

The renderer additions in `client/render/renderer.js` are:

- `renderer.addPass(fn)` runs `fn(gl, renderer, camera)` after the town and avatars with depth intact. It returns a remover.
- `renderer.hasActorSprite(id)`, `renderer.setActorSprites(ids)` and `renderer.spritesActive`.
- `renderer.contextVersion` changes after a WebGL context restore, and the pass rebuilds its textures.
- `createProgram(gl, vs, fs, attribs)` is exported for other passes.

### Hiding placeholder cubes

The shell skips its cube avatar for a remote while a sprite is drawn or can still be drawn (archive loading, out of range, snapshot not in yet). A remote whose figure can never be drawn (no game files, archive failed) keeps the cube instead of vanishing:

```js
if (shouldSkipFallbackAvatar({ hasActorSprite: renderer.hasActorSprite(r.id), figureDrawable: api.actors?.figureDrawable?.(r.id), peer })) continue;
```

The pass runs inside `renderer.render`. If the shell does not emit `frame`, the pass updates itself from `renderer.camera` and `renderer.town`. Sprites only show while the screen is `game`.

## Inputs read

- **Entities.** The module reads `id, kind, name, x, z, yaw, y?, moving?, animation?, hp?, maxHp?, location?`. Appearance comes from `sprite {archive, record}` when present; otherwise from `mobileType` (a MobileTypes id or name such as `"Skeletal Warrior"`), or the name for monsters. `gender` and `race`, `role` and `variant` apply to NPCs, and `corpseSprite`, `loot`/`items`/`lootable`/`looted` to corpses and loot. A `sprite` from a person archive uses the walker layout. A `sprite` from any other non-mobile archive is drawn as a flat.
- **Peers.** The module reads `id, name, x, z, yaw, moving, readied, className, gender, race, variant, animation`, and the worn-gear summary from `server/rpg/peerAppearance.js` (`wearingHeavyArmor`, `wearingRobes`, `weaponKind`, `armorTier`, `primaryDye`, `form`, `defeated`, `mounted`). By default (`classic8dir`) every peer is an 8-direction world sprite. A peer with any weapon equipped (drawn or sheathed), any armour or robes, or anywhere in a dungeon or the wilderness, is drawn from the class's armed archive (for example Battlemage female 489), which has attack records. Only a peer with nothing equipped but clothes, in a town or interior, is drawn from a town-walker archive for their race and gender (Breton art for races Daggerfall has no town walkers for). Only identifiers come from the server; every pixel comes from the viewer's own files.
- **Events.** `swing`/`attack {playerId|attackerId|entityId}` plays an attack, and `cast {playerId}` plays the ranged/spell records. `hit`/`damage {targetId}` plays the hurt frames with a red flash. `loot`/`looted {entityId}` gives a brief glow. An hp drop in state also plays hurt.

## Animation rules (classic tables)

- **Facing.** The index is `round(-angle/45°)` of the viewer relative to the actor's facing. Records 0–4 cover front to back; facings 5–7 mirror records 3–1. Rats (idle) and ghosts/wraiths use their own mirroring tables.
- **Mobile records.** Walk is records 0–4 at 6 fps. Attack is 5–9 at 10 fps, played once and repeated while the server holds `animation:"attack"`. Hurt is 10–14 at 4 fps, idle is 15–19 at 4 fps, and ranged/spell is 20–24 on humanoid classes. Fliers and 15-record archives keep flapping when idle.
- **Town people.** Walk is records 0–4 at 4 fps. Idle is record 5 at 1 fps, front only. The City Watch idles on record 15.
- **Death.** The hurt frames play for 0.9 s, then the creature's corpse texture shows (for example Skeletal Warrior → TEXTURE.306 record 1). A corpse already dead when first seen shows at once. Corpses with loot shimmer, and searched ones are dimmed.
- **Size.** Each record is drawn at its native size, scaled by its own record scale, so attack frames that are wider than walk frames stay correct. The feet stand on `y` or on the town ground under `(x, z)`.

## Tests

`test/rpg-actors.test.mjs` is synthetic: archive codecs, atlas packing, appearance tables, facing and mirroring, animation states, occlusion, picking, and the shell API contract. `test/rpg-actors-data.test.mjs` decodes every creature, class, town-person, corpse and treasure archive in the local install. It skips when `gamedata/` is absent.
