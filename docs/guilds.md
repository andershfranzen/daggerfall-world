# Guilds, temples, knightly orders and standing

Package 15 of the [classic feature backlog](classic-feature-backlog.md). The rules are in [guilds/rules.js](../server/rpg/guilds/rules.js) and the feature is [guilds.js](../server/rpg/guilds.js). The conversation itself stays in [npcs.js](../server/rpg/npcs.js), which asks this feature about the speaker's own hall. The numbers and conditions follow the Daggerfall Unity guild classes, `GuildManager`, `PersistentFactionData.ChangeReputation`, and the donation and cure windows. Rank titles and dialogue are original to this project.

## What a player can do

| Guild | Join | Rank-gated services and privileges |
|---|---|---|
| Fighters Guild (41) | At the trainer, with one guild skill high and another low and standing of at least 0 | Repairs for members at (10−rank)/10 of the price. Members rest in the hall. From rank 6 the hall is open at any hour. Quest rewards are multiplied by (10+rank)/10. |
| Mages Guild (40) | At the trainer | Spell Maker for members. Library from rank 2, magic items from 3, soul gems from 4, Item Maker from 5, summoning from 6, guild teleport from 8. From rank 6 the hall is open at any hour. |
| Temples (one per deity; the hall's faction resolves to the deity) | At the deity's trainer, with that deity's skills | Training, cures, donation and work are open to everyone. Free healing, library, potions, Potion Maker, magic items, Item Maker, spells, Spell Maker, soul gems and summoning open at each deity's own rank (`DIVINES` in rules.js). Arkay reduces cure prices by rank. |
| Knightly orders (368, 408–417) | At the order's questor (846) | Members draw one armour piece per rank at the smith (845), in iron, then steel, and so on. The house comes at rank 9 (848; its property owner is package 13). Free tavern rooms from rank 4 or in the order's home region. Free ship passage from rank 6. |
| Thieves Guild (42) and Dark Brotherhood (108) | By invitation only (below) | TG: magic items sold from rank 2, spymaster from 4. DB: potions from 1, Potion Maker from 3, soul gems from 5, spymaster from 7. Members enter the hall at any hour. Neither guild ever expels: members drop to rank 0 instead. |

Only one membership per guild group is held. A member of the Temple of Kynareth is a stranger at the Order of Arkay, and the same goes for one order versus another. Ranks change only when the player speaks to the guild's people, and only once every 28 days. A rank can rise, fall, or end in expulsion when standing is negative, except in TG and DB. Locked services stay in the dialogue with the classic refusal: "members only", or "not risen high enough", naming the required rank.

Standing is kept for every faction in the installed FACTION.TXT. When a quest succeeds, the questor's faction gets the classic propagated change: allies gain half and enemies lose half, the whole root hierarchy moves (full for the questor and root, half for the rest), and a deity also moves the generic temple hierarchy. The court still gains +1. A donation is 100 gold unless `amount` is given. It raises the deity's standing by 1 with a chance of (2·amount/max(|standing|,1) + 1) percent.

## Services for other features

| Service | Consumer | Meaning |
|---|---|---|
| `guildHallAccess(p, portal)` | package 2 (doors) | `Guild.HallAccessAnytime` for exactly this hall |
| `guildCanRest(p, portal or location)` | packages 2 and 20 (rest) | `Guild.CanRest` for exactly this hall; never in taverns |
| `guildRank(p, group, {factionId})` | quests, repairs, law (14), summoning (19) | rank or null. Groups: `fighters`, `mages`, `thieves`, `brotherhood` (alias `darkBrotherhood`), `temple`, `knights`. Temples and orders must match `factionId` when it is given |
| `templeRank(p, deityId)` | 19 | the same, for a deity |
| `reputation(p, id)`, `adjustReputation(p, id, delta, {propagate})` | everyone | any installed faction id |
| `regionFaction(i)`, `regionCourt(i)` | 14 | a region's commoner and court factions |
| `requireNpcService(p, args, id)` | 9, 16, 19 | validates a follow-up `{targetId, session}` and applies the rank gate |
| `npcServiceHandlers[id](p, info, args)` | 9 (`makeSpells`), 16 (potions, items, identify, soul gems) | called by `npc.service` after the rank gate |
| `daedraSummon(p, e, args, info)` | 19 | `summon`, after the rank gate (covens are ungated) |
| `guilds.tutor(p, e)` | 11 (training) | `{allowed, member, rank, skills, max: 50, price}` for this hall |
| `guilds.cureQuote(p, e)` | temple counter | 250 per condition (`conditionCount`, package 10), Arkay discount, `CalculateCost` with the hall's quality and the region's price adjustment (`priceContext`, package 12), the holiday rule, then the haggle (`tradePrice` with the player's Mercantile and Personality). `listed` is the price before haggling |
| `guildLibraryAccess(p, portalMeta)` | 7 (bookshelves) | `Guild.CanAccessLibrary` for exactly this hall and rank: `{ok, text}`. Libraries are public, Mages Guild halls open at rank 2, temples at the deity's own rank, and other guild halls never |
| `blessingModifier(actor, name)` | 11 (`effectiveAttribute`, `skillValue`) | +1 while a temple blessing lasts |
| `avoidDeath(p, source)` | 11 (`damagePlayer`) | Stendarr: `Random.Range(0, 50) < rank`, never under water; the player is left on 10 % health |
| `guildBreathScale(p)` | 4 (`locomotionMods.breathScale`) | Kynareth: (10 + rank) / 10 |
| `npcServiceHandlers.teleport / spymaster / house` | `npc.service` | this feature's own specialists (below) |

The perk formulas the browser also needs are in [client/gameplay/guilds/perks.js](../client/gameplay/guilds/perks.js): Akatosh journey time, Kynareth breath, Stendarr's escape, free regional lodging for knights and free ship passage from knightly rank 6. The travel map and server use the same rules to calculate journey time, lodging and sea fares.

## Specialists and perks

* **Guild teleport** (Mages Guild, rank 8, the porter 62). The first request answers with `view.teleport = {open: true}`, and the travel map opens in teleport mode. `npc.service {service: 'teleport', to}` then moves the player at once and free of charge to any place on their travel map, from inside the hall (`travel.teleport`, DaggerfallTeleportPopUp). The conversation ends. Unknown places, nearby enemies and the travel blocks (`travelPrevented`) refuse as travel does.
* **Spymaster** (TG rank 4, DB rank 7). The greeting is the operator's TEXT.RSC 402. For the rest of that conversation, "Where is…?" always knows the answer (`TalkManager.isSpyMaster`), and the view carries `spymaster: true`.
* **Library.** The bookshelves of libraries, guild halls and temples (package 7) ask `guildLibraryAccess`. The refusal names the rank needed.
* **Secret halls.** Thieves Guild and Dark Brotherhood members find every hall of their guild in the town they are in, under the guild's name, on the town map (package 6 `learnPlace`). This happens on joining, on joining the server and on each arrival in a town (`RevealGuildHallOnMap`). A Thieves Guild promotion to rank 6 or 8, and every Dark Brotherhood promotion, reveals one unknown place of the current region on the travel map (`travel.discoverRandomLocation`) and writes it in the notebook. The Thieves Guild line is TEXT.RSC 5228/5229 when installed.
* **Blessings.** A donation at a temple brings the deity's blessing (`Temple.Blessing`, `CalculateTempleBlessing` = 1): +1 Speed (Akatosh), Luck (Dibella), Intelligence (Julianos), Endurance (Kynareth), Personality (Mara) or Mercantile (Zenithar). Stendarr instead gives +1 legal reputation in the region (package 14). Arkay gives no blessing. DFU leaves the duration open; the classic texts (TEXT.RSC 705–717, shown when installed) say "for the next few days", taken here as three days of the player's own time. The same deity does not bless again while its blessing lasts, and only one blessing is active at a time. Saved as `rpg.blessing = {deity, key, bonus, until}`.
* **Temple perks.** Akatosh members spend (95 − rank) % of a journey's time (`Temple.FastTravel`, before days and cost). Kynareth members start a dive with (10 + rank) / 10 of their breath; drowning damage is unchanged (`Temple.DeepBreath`). Stendarr members escape a lethal blow at `Random.Range(0, 50) < rank` unless under water (`Temple.AvoidDeath`).
* **Knight's house** (the Seneschal 848, rank 9, once: `KnightlyOrder.ReceiveHouse`). This feature checks the rank and sets the once-only flag (2). The house itself comes from package 13's `services.property.grantHouse(p, {town, random})`. That hook picks a random house of this town for sale, at price 0, using the same deed, map label and notebook entry as a purchase. A player who already owns a house in the region is refused, and so is one where no house is for sale; the flag is then not set. The installed-data test receives a real house in Daggerfall.

Secret recruitment: package 19 tallies crimes from package 14 and sends the letter three days later, outdoors. It then emits `guildInvite {player, guild, quest, started}`. On `questComplete` for O0A0AL00 or L0A01L00, this feature adds the membership at rank 0. If the quest could not start, the letter itself is the invitation, and the hall offers "Ask to join".

Saved state is `rpg.guilds[group] = {rank, joinedAt, lastRankChange, variant?, flags?}`, `rpg.guildInvites` and `rpg.factions`. A legacy temple membership without a deity becomes the Order of Arkay's.

## Not yet covered

The other specialist services belong to their owners: spells (9), potions, items and soul gems (16) and summoning (19). Until an owner registers a handler, the gate runs and then answers that the service is not available yet.
