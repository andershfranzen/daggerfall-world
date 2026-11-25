# Classic dungeon access and mechanisms

The [world census](world-coverage.md) tracks authored entrance and exit data. The [dungeon access audit](../tools/world-audit/dungeons.mjs) checks playable routes over the installed classic data. Run it with `node tools/world-audit/dungeons.mjs` and set `ARENA2_DIR` if the game files live outside the checkout.

| Installed-data check | Result |
| --- | ---: |
| Associated dungeon records resolved by numeric address | 4,232 / 4,232 |
| Exterior journeys through production travel after discovery | 4,231 / 4,231 |
| Authored entrance and return plans | 4,203 |
| Graveyard compatibility entrance and authored return plans | 28 |
| Quest-only access and public travel/portal refusal | 1 |
| RDB placements resolved | 40,263 / 40,263 |
| Distinct RDB files rendered | 187 |
| Distinct starting/satellite render variants | 310 |
| Dungeon entry floor and clearance checks | 4,232 |
| Authored quest-item marker placements | 10,334 |
| Full dungeon scene sample | 6 |

The audit walks each record through the production catalogue, travel action and portal planner. It assembles each distinct RDB block variant with the same mesh, atlas and object placement code as Play. It checks each record’s full grid and samples complete scene composition in Privateer’s Hold, Peristair, Mantellan Crux, Shedungent and both graveyard templates. Browser playthroughs and the source anomaly counts are tracked separately.

In 101 records, at least one exterior door's default return point needed body clearance. The portal resolves the clear surface below the authored point. Where its capsule still intersects the scenery, it searches outward from that same doorway. Every verified return is within 1.324 m horizontally of its door.

## Source exceptions

- **The 28 doorless graveyards.** `GRVEAS10.RMB` and `GRVEAS36.RMB` contain no exterior door plane. Classic archives associate each graveyard with an RDB dungeon anyway. DFU enters a dungeon through an exterior door of type `DungeonEntrance`, which neither template supplies. The compatibility portal applies only to these one-block exteriors when the archive gives them a dungeon and the normal door scan finds no door. Play labels it **Crypt access (compatibility)** next to the existing clear exterior spawn. It uses the dungeon’s actual entry and exit and returns beside the same exterior access point. The census lists all 28 numeric records. [DFU door activation](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/Game/PlayerActivate.cs#L640)
- **Mantellan Crux (31/0).** The exterior has an entrance face. None of its seven RDB files has an exit face. The travel action and ordinary portal actions reject access. Classic `S0000016.QBN` and DFU `Journey to Aetherius` transfer to quest-spawn marker 0 in `S0000000.RDB` (offset 27168). The story enables the transfer after Totem delivery and recipient activation, when the player clicks Nulfaga. The Mantella model 74143 in `S0000005.RDB` at offset 13737 has a direct action that sets global 36. The return is Shedungent’s quest-spawn marker 0 in `S0000070.RDB` (offset 20910), as specified in `S0000016`. [Quest script](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/StreamingAssets/Quests/S0000016.txt) · [DFU place-ID resolution](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/Game/Questing/Place.cs#L1050)

## Shared dungeon state

`dungeon.use {id}` identifies a nearby authored object by signed block grid coordinates and its byte offset. The server resolves the object in the player’s current instance, checks the collision floor and line of sight, and follows the block-local links. Direct use respects starting locks and trigger modes. The open door has the same trigger-only collision as in DFU. Moving models have collision at their current resting pose. Play updates only the affected mesh ranges when receiving shared state. The renderer applies resting poses immediately.

Peristair’s `N0000051.RDB` at grid (0,1) contains lever 61028 at offset 20764. Its rotation links to the **close** action on door 55001 at offset 21997, followed by seven lock actions. The regression opens 55001 first, crosses its opening, and then tests the authored close chain, repeated activation and wrong-floor refusal. Action changes and state broadcasts follow runtime transactions. A close that would enclose a player is refused.

The state survives while at least one player occupies the dungeon. The last departure starts a five-minute grace period. A player returning before its expiry cancels the timer. After expiry the next visit starts with the original poses and locks. Personal quest progress and dungeon return coordinates stay in the character record. Rejoining checks the saved floor against collision geometry and repairs a trapped position near the saved point when possible.

Treasure is shared world state, not instance state. A pile is stocked once, on its first search, and its contents are saved with the player who changed them. The mechanism reset after the grace period does not restock it. Players who join later, players who reconnect and a server restart all find the same remaining items. DFU's `LootTables` has no dungeon restock rule, so the server adds none. Private house furniture is the only container that restocks: it refills after its classic stocked date (`year·1000 + day`) has passed. [Revisit test](../test/rpg-dungeon-loot-walk.test.mjs)

People flats whose action shows text (opcodes 11 and 12, such as the Castle Daggerfall entrance guard) are action-only, as in DFU `PlayerActivate.ActivateStaticNPC`. Their `npc` entity carries `actionOnly` and the `mechanism` id. The server refuses `npc.talk` for them, and Play activates them through `dungeon.use`.

Item markers use editor flats `199.18`. The server exposes `interiors.questMarkers(location)` as records `{id, block, blockX, blockZ, offset, x, y, z, floor}`. Coordinates are in the dungeon scene frame and `floor` is foot elevation in metres. Quest spawn markers use `199.11`. Main-quest code preloads both authored destinations with `interiors.prepareQuestTransfer()` and calls `interiors.questTransfer(player, questInstance)` after the original prerequisites. The Mantella action emits `questGlobal` with index 36 after returning the player.

## RDB action reconciliation

Run `node tools/world-audit/mechanisms.mjs` (add `--records` for identifiers). It reads every RDB in the installed `BLOCKS.BSA` and checks each authored action against the executor in [server/rpg/interiors/actions.js](../server/rpg/interiors/actions.js). The rules it uses are shared with Play in [dungeonActions.js](../client/world/interiors/dungeonActions.js). They follow DFU `DaggerfallAction`, `DaggerfallActionDoor` and `DaggerfallActionCollision` at the revision cited above.

| Installed-data check | Result |
| --- | ---: |
| RDB files / action records | 187 / 1,470 |
| Records with an executor family | 1,470 |
| Broken `next` links | 0 |
| Text-input records with an answer table | 6 / 6 |
| Spell records resolved in SPELLS.STD | 55 / 56 |
| Door-text records missing from TEXT.RSC | 3 |

The 416 records that the previous audit counted as unsupported now run as follows.

| Opcode | Records | Execution |
| --- | ---: | --- |
| 9 cast spell | 56 | The `SPELLS.STD` index comes from the record’s sound byte. The spell is fired at the triggering player, at that player’s level, through `services.objectCast`. It follows `DaggerfallAction.CastSpell`. The missile starts 40 classic units (1 m) above the object’s position and is aimed from the object’s position at the player’s centre. The trap’s own geometry does not stop its missile. Touch payloads fly as single-target missiles. The DFU cooldown applies: one cast, then another every 22 activations (`Cooldown` 1000, less 45.45 per activation). Spell 0 in S0000160 has no effects in the installed file, so it does nothing. Caster-only beneficial spells (Levitate, Shield, Heal, Slowfalling, Water Breathing, Feet of Notorgo) ready a pending free cast on the player (`p.rpg.magic.readySpell`, castable via `magic.castFree` or `magic.cast({ free: true })` at 0 magicka cost, with expiry and replacement), matching DFU’s ready-to-cast step while keeping harmful trap spells immediate. |
| 11 text | 6 | TEXT.RSC 8600 + index, shown to the triggering player from their own files. |
| 12 text and input | 6 | TEXT.RSC 5400 + index. The prompt gates its chain. A reply that matches DFU’s answer list, ignoring case, activates the next object. Each prompt belongs to the player who opened it. |
| 21 damage, random | 4 | Every 20th activation: `Random.Range(max(1, magnitude), max(1, index)) × level`. |
| 22–25 damage | 50 | Models use the axis byte and flats their magnitude, multiplied by player level. 14 records author 0 and deal no damage, as in DFU. |
| 26 poison | 1 | DFU leaves this empty (“Seems to poison”). The record’s index byte (7) is passed to `conditionExposure` as the classic poison number, with the normal saving throw. |
| 28 drain magicka | 7 | `max(1, axis)` magicka. |
| 29 dialogue | 82 | People flats in archives 178, 182–184, 199, 334, 346 and 357. Conversation belongs to the NPC feature. The action passes its chain on. |
| 31 quest global | 1 | S0000140 sets global 43 through `questGlobal`. The Mantella (global 36) keeps its quest gate. |
| 99 door text | 190 | TEXT.RSC 7700 + index, first activation per player. A door shows its text instead of opening on that first use. Later activations with axis > 5 emit `dungeonTrespass` where DFU calls `MakeEnemiesHostile`. Records 7701–7704 read 7705. Records 7720, 7722 and 7772 are absent from TEXT.RSC; those doors open normally. |
| 27, 32, 50, 100 | 13 | Pass the activation on (below). |

`DaggerfallAction.Play` activates the next linked object before it looks up an opcode’s handler, so opcodes without a handler still relay activations. The 13 records with an unexplained opcode were checked individually. None of them is the target of another record’s link.

- **32 (4 records).** Three chain directly into a door close (N0000048 @19121 → 16178, N0000052 @20955 → 22645, W0000025 @12330 → 11772). The fourth chains into a lock (S0000140 @11715 → 11834). The relay carries out the authored outcome.
- **27 (6).** The same walk-into flat `206.2` at offset 19568 in template blocks N0000000–2, W0000001 and S0000999, plus editor flat 199.19 at N0000007 @20251. None has a `next` link, so the relay has nothing to activate. The N0000007 flat sits beside the only opcode 26 record (@20287).
- **50 (1) and 100 (2).** C0I models S0000082 @13311 and S0000160 @21004 both have axis 50 and no `next` link. S0000020 @23031 is an editor flat with trigger 0 and no incoming link, so neither classic nor DFU can activate it.

### Triggers and locks

Trigger flags follow `RdbTriggerFlags`. Any other value is None, including the lock bits on doors and the flags on people flats, matching DFU’s `Enum.IsDefined`.

- **Direct (2, 6, 8, 9).** `dungeon.use` checks reach, floor and line of sight. Wide doors are also tested through the centre of their geometry.
- **Walk-on (1) and walk-into (3, 8, 9).** Contact is tested against the object’s resting bounds, and only while the player is moving, as in `DaggerfallActionCollision`. A walk-on plate must be stood on: its contact is the top of its model, not the floor beneath an arch or span. Damage, drain and spell hazards repeat every 0.12 s while the player keeps moving in contact. That is DFU’s `Timeout`. DFU tuned its per-activation counters to it (“approximates classic based on observation”): a spell every 22 activations and opcode 21 every 20. Classic timing itself has not been measured. Text, door text, teleports and globals fire only on entering contact. Moving pieces collide at their current resting pose (above). Their animation timing is `ActionDuration / 20` s, or 50 ticks for opcodes 2–7, as in RDBLayout.
- **Attack (5, 8).** These respond to the combat `swing` event when the object is the nearest thing in the melee arc. A closed door struck this way is bashed: it opens on d100 ≤ 20 − lock and never at a magical lock of 20 or more. An open door is bashed shut.
- **Door (10).** Fires on toggles of the door.

Moving objects stay busy for `ActionDuration / 20` seconds, or 50 ticks for opcodes 2–7. Activations during that time are ignored, as `IsPlaying` does in DFU. Players standing on a translating platform move with it. Rotating pieces such as trapdoors do not carry anyone.

All RDB door locks for an instance live in one server ledger, `ctx.services.dungeonLocks`:

- **Picking.** `dungeon.pick` uses `clamp(5 × (level − lock) + Lockpicking, 5, 95)`. It records one attempt per player per skill level and refuses magical locks.
- **Bashing.** As described under Attack triggers.
- **Open and Lock spells.** The armed effect from `takeDoorMagic` is consumed on the next eligible door activation. Open succeeds at caster level ≥ lock. Lock sets the lock to the caster level and closes an open door, subject to the obstruction check.
- **Keys and scripts.** These use `unlock` and `lock`.
- **Enemies.** Enemy AI uses `doorOnLine`, `enemyOpen` and `enemyBash`.

Exterior building doors are owned by the law feature. Lock values, picked doors and open poses go to occupants in `dungeonState`. Sound cues arrive as `dungeonCue`.

## Live route evidence

- Stuvam Graveyard (0/108) was entered and exited with the normal Play interact key. The local server started the character outside at the graveyard’s ordinary spawn.
- Privateer’s Hold (17/179) was reached on foot from the exterior spawn with the normal Play movement keys. The player used the authored door, rejoined at a foot elevation of 38.400 m above the lower rooms and left to the same exterior doorway.
- Peristair (17/201) ran in two real Play clients with separate guest saves positioned at the mechanism for the test. One player opened the door and the second saw it open and walked through. In the switch scenario the lever-side player then closed the door, and the player beyond it rejoined on the same floor with the shared door still closed. The test server disabled combat to isolate the mechanism. The images are labeled as fixture evidence.
- Castle Daggerfall (`dungeon:Daggerfall/Daggerfall`, S0000160) ran in two signed-in Play browsers on a private server with private databases. Both characters started outside in Daggerfall and entered through the castle door with G. The second player walked into the closed foyer door 22866, which has starting lock 255, and was stopped at the door plane. The first player walked 4 m from the entry to the guard, flat 183.3 at offset 29318, and pressed G. TEXT.RSC record 5464 appeared from that player's own files, and the player typed “yes”. Both foyer doors opened. The second player received the new pose and walked through to x = 42.17, 2.6 m beyond the door plane. The first player's browser then closed. On signing back in, that player received the open state and also walked through. Combat was enabled during the run. [Test](../test/rpg-dungeon-mechanisms.test.mjs)
- Mantellan entry and return ran in the automated installed-data fixture, with an active quest instance and the completion player placed near the authored crystal. The full story and puzzle sequence were outside that fixture.
- The Fortress of Gaersmith (`dungeon:Daggerfall/The Fortress of Gaersmith`, start block N0000007) ran on the production feature list. Combat was left out, as in the Peristair run, because its spiders paralysed the walker. One character entered by the exterior portal. That character walked 33.8 m with server locomotion and forward input to the 199.19 treasure at offset 14530 on the entrance storey. On the way the character opened doors 15136, 15184 and 20443 and picked 15088, which has lock 10. The fixture made the character level 10 with Lockpicking 90, and raised the skill by one after each failed pick so the retry rule allows another attempt. The pile was stocked from loot key N and gave a Leather Cuirass. A second player was placed at the pile and found that item gone. That player's take was refused. For the trap, the fixture placed the walker on the upper floor beside the Ice Bolt plate: model 67017 at offset 13486, opcode 9, walk-on, a 3.2 m span reached by a 1 m wide ramp beside a shaft. The walk onto the plate fired one Ice Bolt through `objectCast`, which hit for 45. The other player received no hazard or spell text. Shuffling on the plate cast again after 22 activations. A second case emptied the pile, let the instance reset, and brought in a new character, then reconnected and restarted. The pile stayed empty each time. [Test](../test/rpg-dungeon-loot-walk.test.mjs)
- The same Gaersmith route ran in a real Play page on a private server, with combat on. A WebSocket walker used `input` messages only. It fought a spider in its way and walked from the landing to the pile. The signed-in Play observer had been placed there by the server. The observer opened the same pile with G and saw the walker's item gone. The observer was then placed on the upper floor, walked onto the Ice Bolt plate with W, and received the trap's cast. Both characters had 5000 health. The walker also had Lockpicking 100 at level 20, which scales the pile's gold. The captures are in the ignored `progress/screenshots/agents/p57-*.png`.
- K0C00Y08 “A Rare Book” in the Conclave of Evelyn passed live over two account sockets with normal `input` only. The walker opened five doors to the book. The server restarted while the walker held the book. The walker then retraced 217 m to the entrance, opened six doors and left, and was paid once. Combat was on, and the walker had 5000 health, set again after the restart. The route planner allows no drop deeper than 0.8 m and replays it in 0.5 m hops. The test asserts that neither leg had a defeat, resurrection or teleport, and that no position jumped more than 2 m between snapshots. Without the extra health the new character is defeated on the way out and respawns at the entrance. That respawn is what had looked like a completed retrace before. [Test](../test/rpg-quest-rare-book-walk.test.mjs)
