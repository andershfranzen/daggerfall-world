# Health conditions and supernatural characters

Package 10 of the [classic feature backlog](classic-feature-backlog.md). Code: [server/rpg/conditions.js](../server/rpg/conditions.js), [classic tables](../server/rpg/conditions/tables.js), [state machine](../server/rpg/conditions/model.js), [Health panel](../client/gameplay/conditions.js), [shared moon rules](../client/gameplay/conditions/rules.js). Tests: [test/rpg-conditions.test.mjs](../test/rpg-conditions.test.mjs).

The rules and numbers are adapted from Daggerfall Unity (MIT). The source files are named in `tables.js`. Player-facing classic text comes from the operator's own `TEXT.RSC`: disease descriptions are records 100–116, "healthy" is 18, "not sated" is 36 and "death is not eternal" is 401. Vampire clans per region come from the `vam:` field of the province factions in the operator's own `FACTION.TXT`. Nothing from the game archives is copied into the source.

## Time

Each character's conditions run on `rpg.conditions.time`, a classic-minute clock that follows `services.playerMinutes(p)`. This is shared world time plus that character's rest, loiter, travel, prison and vampire awakening time. The Health panel shows the personal date alongside the shared moon phases. Daylight and the moons come from `worldClock()`. Without the calendar feature, the conditions clock advances with live world time, `restEnd` hours and journey minutes. [Calendar and rest protocol](calendar-rest-protocol.md)

## What happens

| Condition | Start | Progress | End |
| --- | --- | --- | --- |
| 17 classic diseases | Monster melee (rat 5 % and giant bat 2 %: plague, stomach rot or brain fever; zombie 2 % and mummy 5 %: 11 diseases; vampire 2 %: plague after the 0.6 % vampirism roll), quests (`makeDiseased`), traps (`conditionExposure`) | Hidden until the first midnight. From then, each day applies the table's attribute, health, fatigue and spell-point damage, rolled between its minimum and maximum. The classic description appears at the first symptoms. | Cure Disease, a temple healer, or after 3–18 days for Caliron's Curse, Blood Rot and Wizard Fever. A cure removes the attribute damage. |
| 12 classic poisons | Weapon poison or traps via `conditionExposure({poison})`, quests via `makePoisoned` | Waits 0–12 minutes, then works for 1–1000 minutes, one magic round per game minute | Cure Poison. A spent poison's attribute damage stays until healed (Heal Attribute or temple). A drug's boosts end when it is spent. |
| Vampirism infection | Vampire melee hit, 0.6 % (bypasses saves), or quests | Dream after one day | Becomes vampirism after more than three days. Temples and Cure Disease remove it before then. |
| Vampirism | Awaken inside an installed cemetery crypt about a fortnight later, at 19:00 on the personal calendar | Clan from the infection region (Lyrezi if unknown). +20 to seven attributes (+ Intelligence for Anthotis), +30 to six skills, immune to disease and paralysis. Sunlight deals 12 health every 4 minutes outdoors by day, and holy ground (a temple or a Fighter Trainers hall) 12 every 4 minutes at any hour. No light- or darkness-powered magery: in DFU that is a career flag, not part of the curse. Hungry one day after feeding (a landed hit or kill). | `cureCondition(p,'vampirism')` (cure quest) removes the innate spells and records `previousClanFactionId`. |
| Lycanthropy infection | Werewolf or wereboar melee hit, 0.6 % | Dream after one day | Lycanthropy after more than three days; a temple can cure it before then |
| Lycanthropy | — | Morph Self once per day (`conditions.morph`), or forced on a full moon of Masser or Secunda. Beast form grants +40 Strength, Agility, Endurance and Speed and +30 to seven skills. Immune to disease. After 30 days without killing a mobile civilian or City Watch knight, maximum health falls by 24 a day, to no less than 4. Those kills count in either form. | `cureCondition(p,'lycanthropy')` (cure quest) |

Level-1 characters cannot catch diseases or poisons (FormulaHelper and DiseaseEffect.Start). Saving throws use package 11's `characterSavingThrow(p, kind)` when present: 50 + modifiers + Willpower/10, clamped to 5–95.

A vampire cannot rest while hungry or travel by day. A lycanthrope in beast form cannot travel. Both rules are registered in the calendar's `preventRest` and `preventTravel`.

Vampire awakening uses the small cemetery layouts from `MAPS.BSA`, starting in the current region and falling back to Daggerfall's cemeteries. The transfer uses the installed start marker, validates its floor and records the actual exit. A fresh awakening leaves the crypt's normal encounter markers unseeded while the awakening players are its sole occupants. An existing shared encounter stays active. If cemetery data is unavailable, the character awakens in place. The fortnight, new location and clan spells are saved together. Active quest deadlines use the advancing personal clock, and the periodic 38- and 84-day supernatural rolls continue from the new date.

Vampires gain Levitate, Charm Mortal and Calm Humanoid plus the clan's spells from the installed `SPELLS.STD`. These innate spells cost 5 magicka. The spellbook tracks them separately from learned spells so a cure preserves learned copies. Existing vampire saves receive their clan spells on join.

Beast form clears both hands and prevents equipping weapons or shields, casting spells and talking to NPCs. Ready and attack use claws. Play draws `WEAPON11.CIF` for the owner's paws and the installed werewolf or wereboar sprite for nearby peers. A peer receives the visible form only while it is active. Hircine's Ring still bypasses the Morph Self cooldown, forced full-moon changes and the hunger health cap.

## Services

All are synchronous and never throw.

| Service | Result |
| --- | --- |
| `conditionExposure(p, {source, damage, delivery, kind?, list?, poison?, bypassSave?})` | `{contracted:[{kind,key,name}]}`. Combat calls it after a monster's melee hit lands health damage. Conditions owns the carrier pools and odds. |
| `conditionPlayerHit(p, target, damage)` | Vampire feeding strike |
| `cureCondition(p, kind)` | Number of records removed. `kind` is `disease` (including a pending infection), `poison`, `attributes`, `vampirism`, `lycanthropy` or `all`. |
| `healConditionAttribute(p, attr, amount)` | Points restored |
| `conditionAttributePenalty(actor, attr)` | Positive lowers the attribute; negative is a supernatural bonus. Character's `effectiveAttribute` applies it. |
| `conditionSkillModifier(actor, skill)` | Skill bonus. Character's `skillValue` applies it. |
| `conditionImmune(p, kind)`, `conditionCount(p,'disease')`, `conditionStatus(p)` | Immunity, temple count, summary (`vampire.clanFactionId`, `lycanthrope.form`, …) |
| `conditionMorphSelf(p, {force?})`, `conditionBeastForm(p)` | Morph result and currently visible form |
| `makeDiseased`, `makePoisoned`, `startInfection`, `deploySupernatural`, `moonPhases` | Quests, special triggers, tests |

Events: private `{kind:'condition', change, text, …}` with `change` = `contracted`, `diagnosed`, `symptom`, `poisoned`, `ended`, `dream`, `deployed`, `sunlight`, `holy`, `transformed`, `cured` or `status`. `{kind:'conditionForm', playerId, transformed, form}` goes to everyone in the location. `ctx.emit('conditionChanged', {player, change, kind, key})`, and `ctx.emit('supernaturalQuest', {player, kind, cure})` every 38 days (`cure:false`) and 84 days (`cure:true`) of the character's clock.

Actions: `conditions.status` (the classic health report), `conditions.morph`. Temple cures are the temple counter's (`npc.service` `cure`, package 15).

## Persistence

`rpg.conditions` is saved with the character record. Incubating diseases are part of the private snapshot. The Health panel shows only what the classic health report would show: diseases past incubation, poisons, and the supernatural state. The test suite proves a disease's progress survives a reconnect over the real WebSocket server and SQLite, and that a second character connected to the same server stays healthy.

## Play verification

Two signed-in characters used a private server and disk-backed saves. The fixture forced carrier exposure and elapsed personal time. In Gothway Garden, Shapechange in the Health panel displayed the player's paws and the second player's view showed the werewolf. Combat accepted a claw swing, and Play refused sword equip, spellcasting and conversation. The other account later awoke inside The Hawkston Cemetery at 19:00 on their personal calendar. The local clock and location of the first account stayed put. The vampire cast Levitate for 5 magicka, reconnected in the same crypt, and retained Levitate, Charm Mortal, Calm Humanoid and the Vraseth spell Nimbleness. The pending-infection cure had already been exercised at a temple in Play.

## Remaining coverage

- **Vampire passive effects.** Done: VampirismEffect's compound race adds only SunDamage and HolyDamage (PassiveSpecialsEffect, 12 health per 4 minutes each). Holy places follow PlayerEnterExit: temple interiors (building type 14) and Fighter Trainers halls (faction 849), or `services.isHolyPlace` when present. Light/darkness-powered magery reads the career only, so the curse adds none; a vampire's own career magery still applies through the character feature. The Health panel re-requests status on the `holy` change. Package 16 reports Hircine's Ring through `wearsArtifact`.
- **Combat contract.** Combat calls `conditionExposure` for a landed carrier attack. A fallback reads the `damage` event for combat implementations without the service call.
- **Poisoned enemy weapons** (classic weapon poisons) depend on combat passing `poison`.
