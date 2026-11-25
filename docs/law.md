# Crime, the City Watch and the courts

Package 14 of the [classic backlog](classic-feature-backlog.md). The server decides everything. The browser sends Steal-mode intent and the player's answers to the watch and the court. Rules: [server/rpg/law/rules.js](../server/rpg/law/rules.js) · Feature: [server/rpg/law.js](../server/rpg/law.js) · Browser: [client/gameplay/law.js](../client/gameplay/law.js) · Tests: [test/rpg-law.test.mjs](../test/rpg-law.test.mjs)

The numbers follow the original game as documented by the Daggerfall Unity sources at revision `3d85a283`: `PlayerEntity` (crimes, reputation loss, surrender), `DaggerfallCourtWindow` (FALL.EXE penalty tables, pleas, debate or lie, guild rescue), `FormulaHelper` (lockpicking, pickpocketing, shoplifting), `PlayerActivate` (locks, pickpocket loot) and `WeaponManager` (townsfolk).

## Player actions

| Classic action | How | Crime when seen |
|---|---|---|
| Pick a pocket | Steal mode (F1), G on a person within 3.2 m. Each live person can be tried once per character. Chance = Pickpocket, 5–95. A success yields 1–6 gold, with a one-in-three chance of finding an empty pocket. | Pickpocketing (failure is always noticed) |
| Pick a building's lock | Steal mode, G with nothing targeted at a locked exterior door. Chance = Lockpicking − 5 × (quality / 2), 5–95. After a failure, the character must raise Lockpicking before trying that door again. | None, as in classic |
| Bash a building's door | Face the exterior door within 3 m, ready a melee weapon or fists, and press the attack key. A locked door opens on a roll of 25 − lock strength or lower. | A failed attempt can be reported as attempted breaking and entering. A successful bash can be reported as breaking and entering. Either has a 10% detection roll. |
| Enter through a forced door | Use normal entry after picking or bashing the lock or casting Open. Package 2's `access.entry` reads the shared door state through `services.buildingEntryOverride`. | Trespassing, if a resident or member of staff is present |
| Shoplift | Use an unpaid shop basket or open the shelves with F1 and G. Chance of being caught = 100 − Pickpocket + shop quality + item weight and count, clamped to 5–95 while staffed. A caught basket is returned to the shared shelf. | Theft |
| Strike a townsperson | Combat (package 8) calls `law.strikeTownsperson`. A resident dies to one blow. A watchman turns into a hostile City Watch knight. | Murder / Assault |
| Hit a passive watchman | Combat calls `law.provoked` before the enemy turns hostile. | Assault |
| Camp inside town walls | Package 20 calls `services.reportCrime(p, 'vagrancy')`. | Vagrancy |
| Low legal reputation (< −10) or banishment | Every 5 s in a town of that region, with a 5% or 10% chance. | Criminal conspiracy |

## The watch and the court

1. A witnessed crime in a town or building opens **one** charge per character (`rpg.law.charge`). A graver crime in the same region upgrades the charge. A crime in another region replaces it. Dungeons and the wilderness have no watch.
2. City Watch knights (enemy 146, CLASS18.CFG, levelled above the player) come through `services.createEnemy`. Outdoors, two respond, with the first placed near the incident when that position is available. Indoors, two to five respond near the exit and incident. The cap is five per place. Only the suspect can be halted or targeted by the responding watch. The watch leaves if the suspect falls, leaves or disconnects. A saved warrant can summon a fresh watch when the suspect returns to the same jurisdiction.
3. **Halt.** Legal reputation in that region drops by the crime's classic loss, once per charge. The Daggerfall court faction also changes by half that amount. The player chooses Surrender or Resist. If the halt goes unanswered for 30 s, it counts as resisting. Resisting turns the watch hostile toward that player only.
4. **Defeat by the watch** follows classic `SurrenderToCityGuards(false)`. Above 0 reputation, the player goes to court. Below −20, the watch leaves the player lying there. In between, it is a coin flip.
5. **Court.** The sentence is rolled once and saved with the case, so reconnecting cannot reroll it. Severity follows the classic thresholds: banishment (classic never executes) or a fine and prison. The penalty in 40-gold units becomes 40 gold or 3 days each, and a fine the character cannot pay becomes prison days. A member of the Thieves Guild (attempted breaking and entering, trespassing, breaking and entering, or pickpocketing) or the Dark Brotherhood (assault or murder) is released if `guildRank >= roll`, where the roll is an integer from 0 through 19.
   - *Guilty* halves the fine and term.
   - *Not guilty*, then *Debate* (Etiquette) or *Lie* (Streetwise). The chance to go free is legal rep + (skill + Personality)/2, 5–95. On conviction, rep + d100 < 25 doubles the fine and > 75 halves it.
6. **Verdict.** The verdict closes the charge into `rpg.law.history` exactly once, with crime, region, verdict, fine and days. Replaying a plea with that charge id is refused. Serving or paying the sentence restores half the crime's reputation loss minus one.
7. **Prison** counts down one day per 0.3 s, as on the classic prison screen. Court and prison hold the character in place and block combat, rest, travel, door transitions and Recall. Release spends `days × 1440 + 240` minutes through `services.spendTime(p, …, 'prison')`. The personal ledger and release are saved together, and the shared clock keeps its normal cadence. The player returns to the town's spawn. The remaining term survives reconnecting.

## Saved state

`rpg.law = {rep: {Region: −100..100}, charge, history[≤50], prison, banished: {Region: true}, picks: {door: skill}, tally: {thefts, violent}}`. Forced exterior doors are shared world rows `lawdoor:<from>#<portalId>`. They stay open until the building's next opening hour or for 24 game hours.

## Contracts with other packages

| Package | Contract |
|---|---|
| 2 hours/locks | Law installs `services.buildingEntryOverride(p, portal)`. The hook chains, and returns true only for a door this feature recorded open. Law reads `services.buildingAccess.lockedReason(p, portal)` (null = lawful) for its trespass decision. Committed entry is detected from `locationChanged`. |
| 4 activation | `api.activationMode === 'steal'`: the law client handles `interactIntent` before npcs and interiors. |
| 5 dungeon locks | Exterior building locks are law's. Dungeon action doors stay in `services.dungeonLocks`. |
| 8 combat | Combat calls `S.law.strikeTownsperson(p, e, {weapon})` at impact and `S.law.provoked(p, e)` before a passive enemy turns. Law uses `S.createEnemy` and `S.provokeEnemy`. |
| 9 magic | An Open spell calls `services.law.openDoor(p, portal, 'spell')`. |
| 12 shops | `services.shopShelf(location)` in npcs.js shares the shop's ledger (`npcshop:shop:<location>`). |
| 15 guilds | Rescue reads `services.guildRank(p, 'thieves' / 'darkBrotherhood')`. Events: `crimeCommitted`, `crimeSentenced`. |
| 17/18 quests | `services.law.changeLegalRep(p, region, delta, reason)`, `legalRep(p, region)`, `regionOf(location)`. |
| 19 invitations | `crimeTally {player, thieving, amount}`: pick and pickpocket +1, shoplift +1, murder (false, 5). |
| 20 calendar | `services.reportCrime(p, 'vagrancy', {location})`. Prison time is charged through `spendTime(…, 'prison')`. |
| 13 property | The bank applies a default through `services.law.changeLegalRep(p, region, delta, 'loan-default')` and emits `loanDefault`. The personal `timeSpent` event lets a prison term trigger the borrower's due-date check. |

## Verification and limits

The private Play checkpoint placed two fresh signed-in accounts by a resident in Gothway Garden and fixed the law rolls and daylight. The accused used F1 and G in the actual Play view. Both accounts saw two City Watch knights appear. The accused alone received the halt, chose Surrender, Not guilty and Lie, served 15 days, then reopened the Law page after reconnect. The server saved a guilty verdict and Daggerfall legal standing of −2. It added 21,840 personal minutes to the accused and left the second account's ledger and record untouched. The second account used the game WebSocket.

On a private server with the installed game data, two signed-in WebSocket clients drove the production actions. The fixture set daylight, the starting exterior position, equipment and Lockpicking skill, stored guild ranks, and controlled law rolls. Legal standing started at zero, and the law actions produced the charges, standing changes and verdicts.

- **Sentinel burglary and trespass.** The first account walked 13 m to the locked building at `b:4,2:0`. Normal entry was locked. With Lockpicking 65 and a 25% displayed chance, a roll of 99 failed and the door refused a retry at the same skill. Melee bashes rolled 99 and 3 against a threshold of 17, with neither attempt reported on a witness roll of 0.73. The second bash opened the shared door. Both accounts then used normal entry, each in turn. The authored resident Neg noticed each trespass, and only the active suspect received a halt. Surrender carried the raised exterior door's 6.5 m height in the court transfer.
- **Thieves Guild and banishment.** The first account surrendered at Sentinel standing −5. Thieves Guild rank 4 matched a rescue roll of 4, closing the case before a plea with no fine or prison and raising standing to −4. The second account entered the same forced door and surrendered at −5. Rank 0 failed a rescue roll of 1, and a severity roll of 1 against the first threshold of 2 produced a severe sentence. After reconnecting to that same sentence, the account pleaded guilty. The Sentinel banishment at standing −5 and single verdict persisted on a second reconnect, and replaying the plea was refused. A patrol roll of 0.075 triggered a new criminal-conspiracy halt under the 10% banishment chance and lowered standing to −7. The first account's record stayed unchanged throughout the second case.
- **Dark Brotherhood.** The first account travelled to Gothway Garden, approached a live townsperson and struck them in melee. The murder halt lowered Daggerfall standing from 0 to −20. On surrender, Dark Brotherhood rank 6 matched a rescue roll of 6, closing the case before a plea with no fine or prison and raising standing to −11. Reconnecting restored both guild verdicts and the separate Sentinel and Daggerfall standings.
- **City Watch resistance.** Package 8's two-account socket route in Gothway Garden exercised a vagrancy halt, Resist, melee combat and corpse loot. Only the suspect was targeted, and the second account's repeat loot claim was refused. [Combat coverage](classic-combat-coverage.md)

[Focused runtime tests](../test/rpg-law.test.mjs) cover fines, imprisonment, defence, region boundaries, returning warrants, forced entry, witnessed and unwitnessed shoplifting, violence, and atomic sentence release even when a save fails.

Court and prison use Play dialogs at the existing town position. There are no separate courthouse or jail interiors. The witness model uses live residents or shop staff for trespass and theft, automatic detection for failed pickpocketing and murder, and a fixed chance for bashing. Pickpocket attempts are persisted per character in `rpg.law.pickpockets` keyed by stable NPC ID (with TTL expiry and a 200-entry cap), so NPC population rebuilds and server restarts do not reset pickpocket memory. Legal standing and banishment persist by region, and court-faction reputation adjustments resolve each Iliac Bay region’s own noble court/people faction (via `guilds.regionCourt` / `FACTION.TXT`, falling back to Daggerfall’s faction 201 when no faction data is installed).
