# Classic quests by genuine eligibility

**25 November 2026.** The supplied ARENA2 has 306 QBN files. Four lack companion QRC text, including the duplicate Malacath file 80C00Y00, A0C00Y04, N0C00Y01 and R0C40Y23. The catalogue parsed the other 302. **301 passed static engine analysis** with the installed MAGIC.DEF artifact catalogue. B0B71Y03 contains the unresolved instruction 0x3c.

**242 of the 302 pass the ordinary-offer analyser.** Of the 60 outside that pool, 56 lack a guild or social group, three further files lack the ordinary offer message, and one contains 0x3c. A character’s eligibility also depends on the giver, membership, standing, level and operator settings. Some files that pass the ordinary-offer check start through a supernatural event. [Production catalogue audit](../tools/classic-feature-gaps.mjs)

- **Engine.** The JSON value `runs` means the static analyser found no unsupported resource or instruction. A script can still have approximated or ignored actions. The analyser does not walk to an objective, execute each branch or check a reward.
- **Offer.** Who in the world starts the quest and what the character needs first. Ordinary offers follow QuestListsManager, mirrored from `eligible()` in [server/rpg/quests.js](../server/rpg/quests.js). Givers are the source people the NPC reader marks with a quest group ([people.js](../server/rpg/npcs/people.js)). Joining routes come from package 15 ([guilds/rules.js](../server/rpg/guilds/rules.js)). The sixteen Daedra princes come from package 19 ([special/daedra.js](../server/rpg/special/daedra.js)).
- **Played.** The cited check describes the portion exercised. Some checks use real account sockets, some place the character at an objective, and some begin with a late campaign save.

[Census tool](../tools/quest-eligibility.mjs)

```sh
node tools/quest-eligibility.mjs          # summary
node tools/quest-eligibility.mjs --json   # one row per quest
```

| Files | Offer | What it takes |
|---:|---|---|
| 83 | Ordinary, new character | A level-1 non-member: building residents (22), merchants (12), nobles (24), witch covens (8), and the non-member halls of the Mages (5), Fighters (4), temples (4) and knightly orders (4). |
| 11 | Ordinary, level or reputation 2–6 | Social givers: minReq ≤ level, or reputation ≥ minReq. |
| 113 | Ordinary, guild member by rank | Fighters, Mages, temples and knightly orders are joined at the hall. The Thieves Guild and Dark Brotherhood are joined through their invitation quests (O0A0AL00, L0A01L00). Temple and order jobs require membership of the giver’s own temple or order. One of the 113 (B0B71Y03) is blocked in the engine. |
| 11 | Ordinary, one deity’s temple | 00B00Y00 (Julianos) and D–J0B… (Akatosh, Arkay, Dibella, Kynareth, Mara, Stendarr, Zenithar). These are QuestList-Classic HolyOrder jobs with that deity’s membership letter, offered at that deity’s temple by rank. |
| 58 | Story, summoning, cure or invitation | 38 campaign files, 16 Daedric princes, two cures and the Thieves Guild and Dark Brotherhood invitations. |
| 15 | Operator opt-in | Adult quests (file flag X) are offered only with `questAdult`. |
| 11 | Vampire clan trigger | A successful 38-day check starts P0A01L00 first. Later checks draw from ten member jobs, including P0B10L07, subject to level, clan standing and one-time requirements. The first letter, dungeon fight and ring payment have an installed-data fixture. [Trigger rules](../server/rpg/special/triggers.js) · [Quest checks](../test/rpg-special-quests.test.mjs) |
| 4 | — | Unreadable (no QRC). |

Before this package, the analyser accepted 100 of 302 files and placed no people or foes in random dungeons. The remaining engine blocker is B0B71Y03 (QuestList-Classic: KnightlyOrder, M, 7, one-time). What the installed data shows about its opcode 0x3c:

- It occurs once in all 306 QBN files, in `_S.20_` after `clicked item _I.01_` and `make _I.01_ permanent`. Item record 1 is artifact subtype 12, Auriel’s Bow.
- Its operands are the owning state (20) and section 0 with value 19. In this file, section 0 carries both item indices (0–2 in `place item`, `clicked item`, `make permanent`) and literals (log ids, repute amounts). The quest has three items, so 19 is a literal, not an item reference.
- In ArtifactsSubTypes, 19 is Auriel’s Shield, which is item record 0 of the same quest and the reward of the `_S.21_` branch. That matches the number only. Nothing in the data shows whether the opcode gives, removes or checks it.
- Daggerfall Unity keeps the line as the comment `_0x3c_ 19`, so its quest runs without the opcode and is listed as “Passed”. That shows a playable route that skips the instruction. It does not show what classic does.

The engine still reports `unknown opcode 0x3c` and does not offer B0B71Y03.

## Social offers and the faction a job pays

- **Giver sex.** For social jobs, the QuestList-Classic letter M or F refers to the giver. DaggerfallQuestOfferWindow passes `questorNPC.gender` to GetSocialQuest. The installed list has 33 social M rows (13 Commoners, 10 Merchants, 10 Nobility) and no F rows. `eligible()` now checks the giver’s sex; it used to check the player’s. Without an operator QuestList, `metaFromName` reads A0C/K0C/R0C as N, so this rule applies only when `questList` is configured. [Check](../test/rpg-quest-social-routes.test.mjs)
- **Rank by level.** DaggerfallGuildServicePopupWindow raises the effective rank to the player’s level when `IsSatisfyQuestReqByLevel` applies (Mages Guild and knightly orders).
- **Quest.FactionId.** Each ordinary offer records the faction that gains 5 on success and loses 2 on failure (Quest.EndQuest, propagated). Social and coven jobs use the questor’s faction. For guild jobs, GetFactionIdForGuild uses the hall building’s faction for temples and knightly orders, and the guild’s fixed faction otherwise. Special starts keep the faction their trigger supplied. `questFailed` now applies the −2.
- **`factiontype T` / faction code −2.T.** Person.GetFactionTypeFactionID resolves this to the current region’s Province, Court or People faction, or to a random faction of type T. Temples exclude Generic Temple #450. A0C10Y05’s `change repute with _ruler_ by -20` previously reduced the questor’s own faction. It now reduces Daggerfall #201.

## Engine changes

Opcodes were decoded from their operands in all 306 files, then checked against Daggerfall Unity’s translations of the same quests. [qbn.js](../server/rpg/quests/qbn.js) · [actions.js](../server/rpg/quests/actions.js) · [engine.js](../server/rpg/quests/engine.js)

| Opcode | Script line | Runtime |
|---|---|---|
| 0x1b | `reveal _L_ in province R at M` | A MAPS record by region and `mapId & 0xfffff`. A permanent site with no Quests-Places row is resolved from its own reveal line, as in the coven jobs R0C30Y25, R0C4XY23 and R0C60Y24. |
| 0x1e, person −1 | `teleport pc to _L_` | Through the place’s own door landing, after it has loaded. |
| 0x31 / 0x48 | `cure disease N` / `make pc ill with disease N` | `services.cureCondition` / `services.applyCondition` (package 10). Emits `questCure` and `questDisease`. |
| 0x3a / 0x3b | `cure vampirism` / `cure lycanthropy` | `services.cureCondition(p, 'vampirism' \| 'lycanthropy')`. |
| 0x41 | `legal repute ±N` | `services.law.changeLegalRep(p, region, n, 'quest')` (package 14). |
| 0x45 | `cast spell N on _F_` | Recorded on the foe as `questSpells` for combat and magic. Emits `questCastOnFoe`. |
| 0x47 | `clicked _P_ and at least N gold otherwise do _S_` | Existing click-and-pay rule. |
| 0x49 | `cast spell N do _S_` | A standard spell cast by the quest owner (`spellCast` event). |
| 0x4d | `level N completed` | Character level ≥ N. |
| 0x4f | `when repute with faction N is at least M` | Re-evaluated on every update. It does not latch. |
| 0x52 | `npc _P_ at home` | The person stays in or returns to their home. |
| 0x57 | `send _F_ every N minutes [M times] with P% success` | `create foe` with DFU’s placement rule for `send` (package 19 owns that rule). |
| 0x05 | `dropped _I_ at _L_` | The `quest.drop {uid, item}` action, accepted only at that place. |
| 0x37 / 0x38, 0x3f / 0x40 | `add _P_ face` / `drop _P_ face`, `add/drop foe _F_ face` | Escort companions (HUDEscortingNPCFaces). Saved as `faces` on the instance and listed in the journal (“Travelling with you”). They leave when dropped or when the quest ends. |
| 0x2e / 0x30 on the questor | `hide npc _qgiver_` / `restore npc` | The source person is absent for that player only (`npcs.setPersonAway`). This is re-applied from the save after a restart. |
| — | `end quest` | Quest.EndQuest’s `ticksToEnd = 2` means the following update still runs every task, as with K0C00Y07’s `make _gem_ permanent` and message 1022. The update after that ends the quest. |
| 0x54 | `play sound N every M minutes K times` | The DAGGER.SND clip plays when its task runs, then every M game minutes until K plays. It goes to the quest owner only as `questSound`. The schedule is saved in the task’s action state, so a restart continues it. It stops when the task is cleared or the quest ends. Daggerfall Unity’s `play song` sends one song the same way. The journal does not announce either. [Check](../test/rpg-quest-runtime-hooks.test.mjs) |
| 0x0a / 0x0b, 0x26, 0x55 / 0x56 | `add dialog for …`, `dialog link for …`, `rumor mill N`, `add/drop _P_ as questor` (and Daggerfall Unity’s `mute npc`) | Saved on the instance as `dialog`, `dialogLinks`, `rumours`, and `addedQuestor` or `muted` on the person. The NPC owner reads them for that player through `services.quests.talk(p)`. Rumour text is fixed when it is added. NPC conversation does not use these hooks yet. |
| 0x11 | `location marker _L_` | No runtime effect. It appears in A0C10Y05, B0C00Y13, K0C10Y11 and S0000007, the werebeast hunt. Daggerfall Unity has no matching action, and the installed data shows no condition or effect for it. The S0000007 werewolf still uses its authored spawn marker 1 through `place foe`. [Checkpoint](../test/rpg-campaign.test.mjs) |
| 0x36 | `make _I_ permanent` | Item.MakePermanent: a quest item the player is carrying becomes an ordinary inventory record and stays after the quest ends. A `used` letter becomes parchment carrying its text. An artifact is not copied a second time. Gems, minerals, weapons, armour and potions keep the template rolled for them. An item handed over, taken back or never received is not converted, because DFU converts only items still in the player's collection. Classes without an inventory template, such as religious items, trinkets, magic items, drugs and ingredients, stay in the journal until the quest ends, and the quest notes record this. Delivery waits in `rpg.quests.campaignRewards` until there is room in the pack. It is retried on join and on each tick and happens once. [rewards.js](../server/rpg/campaign/rewards.js) |
| — | travel clocks (`flag & 16`, or a zero clock with `flag & 1` and a type) | Clock.GetTravelTimeInSeconds: every Place resource adds its own one-way leg from where the player stands. Each leg uses cautious travel, camping, no ship and the cart modifier, with no guild shortening and at least 1,440 minutes. The total is multiplied by 2.5 once. A place whose site could not be bound adds nothing, as when Clock.cs cannot find the location. If no place binds, the clock gets three days instead of DFU's zero-length clock, which would end the job at once. Clock lengths are fixed when the quest starts, so saved clocks keep their duration and running deadline. Boethiah's `_S.07_` remains pinned to the first place. [engine.js](../server/rpg/quests/engine.js) · [Clock.cs](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Scripts/Game/Questing/Clock.cs) |

Placement:

- People and foes in a random dungeon stand on its quest spawn markers (199/11). A resource gets a marker no other resource of the quest uses, as in Place.AssignQuestResource. If an unrevealed dungeon has no spawn markers, a different dungeon is picked. A revealed one falls back to its item markers.
- `local dungeon` is the dungeon of the giver’s own town. A town without one (MAPS dungeonType 255) passes that quest over.
- A quest person who is not the questor or an authored individual lives in a public building of their home town until a task places them elsewhere (Person.cs home). Older saves are repaired when they load.
- Remote towns come from every city, village and hamlet of the region (SelectRemoteTownSite). Sites that need a specialised building (library, bank, guild hall, palace and so on) are drawn from cities. `_BRISIEN` and `S0000008` keep the verified starter venues (package 18). Package 8 owns typed remote-dungeon filtering.
- Special triggers use `services.quests.offerSpecial` (normal offer, accept and refuse) or `startSpecial` (starts directly; a failure is still recorded as a failure).

## Play checks

| Check | What was exercised | Where |
|---|---|---|
| G0B00Y00, Kynareth | The installed Daggerfall quest giver refused a stranger and a rank-six Julianos member. A rank-zero member of Kynareth then received and accepted the offer. The fixture selected this quest, placed the character beside the giver and assigned membership. | [Temple offer check](../test/rpg-quest-dungeon-jobs.test.mjs) |
| P0A01L00 and P0B00L01, vampire clan | Two fixture vampires shared the world clock. Only one spent personal time. At the first 38-day boundary the owner received the original letter. At the next boundary the owner received a member job with the regional clan faction, and its journal entry survived restart. The fixture controlled the rolls and advanced the owner’s time ledger. | [Clan clock checks](../test/rpg-special-quests.test.mjs) |
| Sixteen Daedric demands | Installed-data fixtures accepted each prince’s original offer and obtained each artifact. Branches include Hircine at Glenmoril Coven, a fleeing Spellsword and Nocturnal’s false bow. The fixtures supplied guild rank, fees, dates, dice and positions. | [Routes, artifacts and fixture scope](special-quests.md) |
| K0C00Y09, kill | A Ranger stood on a dungeon marker in the Conclave of Evelyn, visible only to its owner. It died once, was not respawned after a restart, and the merchant paid once (16 gold, classic 10–45). | [test/rpg-quest-dungeon-jobs.test.mjs](../test/rpg-quest-dungeon-jobs.test.mjs) |
| K0C00Y09, flee branch | A wound short of death moved the Ranger to Ruins of Wicksmith Court. The merchant paid the larger sum (66, classic 50–150). | same |
| A0C01Y03, errand chain | A created contact in a Warham home, a librarian in Whitewood Borough’s library, a contact on a marker in Edworyan Laboratory, then back to the giver for 178 gold. | same |
| Branches, refusal, deadline, letters, chaining | Prompt yes and no, `pick one of`, non-latching repute, level, cast-spell, drop at place, illness and cure hooks, a letter whose reading starts the next quest, a deadline that fails the job without payment, and special offers. | [test/rpg-quest-objectives.test.mjs](../test/rpg-quest-objectives.test.mjs) |
| A0C10Y05, escort | Accepted from a male Commoners questor. The questor left the room for the owner only, though a second account still saw them, and travelled as a face. The betrothed was met in a remote Wilderford house and joined, after which both stayed with the owner through a restart. The priest of a Tunmoth temple married them, paying 183 once. `factiontype Province` took −20 from Daggerfall, not the questor. Leaving restored the questor and added +5 to People of Daggerfall. | [test/rpg-quest-social-routes.test.mjs](../test/rpg-quest-social-routes.test.mjs) |
| A0C10Y05, expiry | Loitering with `rest.start` until the travel clock ran out. Its house and temple legs gave 33,750 minutes in this run. The job failed with message 1020, the questor returned, nothing was paid, and People of Daggerfall lost 2. | same |
| K0C00Y07, ransom | Accepted from a Gothway Garden merchant, who handed over the gem. The Thieves Guild kidnapper (faction 42) was in an Aldfort Hill building and visible only to the owner. Carrying the gem to them opened prompt 1011. Answering yes paid the ransom. After a restart the merchant paid 8, from the classic range of 5–25, once. | same |
| K0C00Y07, expiry | The job clock lapsed with the gem unspent. Message 1022 and the merchant’s −5 ran in the update after `end quest`, followed by the −2 failure. `make _gem_ permanent` turned the carried gem into one ordinary inventory gem: an Emerald in this run, the template rolled when the quest began, with no quest marker. It was saved with the character and was neither repeated nor lost after a restart and rejoin. | same |
| Social M by giver sex | With the real QuestList-Classic row `A0C10Y05, Commoners, M, 1, 0`, a female character was offered the job by male questors and refused by a female questor. | same |
| Clocks and make permanent | Stub-host checks covered travel clocks with several places, an unbound site, a single site, a fixed duration, a pinned first place and a saved running clock. Classic K0C00Y02 (four places), A0C10Y05 (two) and K0C00Y07 (one) were checked with assigned legs. Make-permanent checks covered a gem, a full pack followed by delivery after rejoin, items that were handed over, never received or had no template, artifacts and letters. | [test/rpg-quest-clock-permanent.test.mjs](../test/rpg-quest-clock-permanent.test.mjs) |
| K0C00Y08 “A Rare Book” | Fixture: offer, a 12-gold advance, a private book on its marker, a restart, the return, and 157 gold paid once (fixture positions inside the dungeon). | [test/rpg-quest-dungeon.test.mjs](../test/rpg-quest-dungeon.test.mjs) |

The social-route checks are staged, not walked. Every quest step uses a production action (`quest.request/accept/answer`, `npc.talk`, `travel.go`, `portal.use/leave`, `rest.start`). The fixture places the character at doors and beside people.

Two accounts walked into the merchant’s shop, travelled to the Conclave of Evelyn and entered through its exterior door. The owner walked to the book, opening five doors, then took it from marker 0,1:21435. The witness could neither see nor take it. The owner rejoined at the book after a server restart and eventually returned it for 157 gold, following a 12-gold advance. Repeating the handover gave no further payment. The fixture restricted the merchant’s offer pool, opened the shop at 08:00 and gave the owner extra health. The route planner sent ordinary WebSocket movement and door actions. The saved positions and server events show the returning character died near the book and respawned at the entrance. The stricter acceptance test rejects that route. An uninterrupted outward walk still needs confirmation. [Two-account walk](../test/rpg-quest-rare-book-walk.test.mjs)
