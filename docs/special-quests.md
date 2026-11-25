# Special quest routes

The installed QBN supplies the demand and the matching QRC supplies its text. Package 19 starts the quests from the summoner or invitation. The quest engine runs the actions, the inventory service delivers artifacts, and the guild service grants rank zero on a successful initiation. [Trigger rules](../server/rpg/special.js) · [Installed script adjustments](../server/rpg/special/quests.js) · [Installed-data tests](../test/rpg-special-quests.test.mjs)

## Secret guilds

| Invitation | Work after delivery | Completion and failure exercised |
|---|---|---|
| Thieves Guild `O0A0AL00` | Read the letter, take the clothing from the named residence, read the tucked note and show the clothing to the contact. | One gold, a dungeon map discovery and rank zero. A second initiate read the letter and let its 90-day clock expire. |
| Dark Brotherhood `L0A01L00` | Read the letter and visit the apothecary, take the decanter from the residence so the script uses up the vial, use **Put back wine decanter** in the Journal, then report to the contact. | One gold and rank zero. A second initiate reported before finishing the work, got the original failure message and reputation penalty, faced the indoor ambush and let the contract expire. |

The installed-data fixture used three characters in one temporary SQLite world. It checked that another character in the same room could neither see nor take the clothing, talk to the private contact, receive the reward, see the letter’s map clue or change either initiation. It restarted with an unfinished Brotherhood initiation and a carried decanter, then verified both paid memberships and failures on a second restart. [Initiation regression](../test/rpg-special-quests.test.mjs)

## The sixteen princes

The audit reads the installed QBN, QRC and MAGIC.DEF and checks the selected locations against the installed MAPS catalogue. It uses ordinary summoner dialogue, confirmation and quest acceptance for the fifteen follow-up demands. Existing Mephala evidence covers her acceptance, palace, deadline and reward. `00B00Y00` is a School of Julianos Nightblade job with a gold reward. The unreadable `80C00Y00` duplicates the installed Malacath QBN and lacks its matching QRC. [Prince registry](../server/rpg/special/daedra.js) · [Reference quest list](https://github.com/Interkarma/daggerfall-unity/blob/3d85a28/Assets/StreamingAssets/Tables/QuestList-Classic.txt)

| Prince and QBN | Demand and site | Artifact |
|---|---|---|
| Hircine `X0C00Y00` | Wereboar in a dungeon, then the contact. Elyzabyth Wicking at Glenmoril Coven grants an off-day audience without guild rank. | Hircine’s Ring |
| Clavicus Vile `V0C00Y00` | Werewolf in a dungeon, then the contact. | Masque of Clavicus |
| Mehrunes Dagon `Y0C00Y00` | Frost Daedra in a dungeon, then the tavern contact. | Mehrunes’ Razor |
| Molag Bal `20C00Y00` | Wound the mage in a laboratory. After the escape timer, read the letter, follow him to the second dungeon and report to the tavern. | Mace of Molag Bal |
| Sanguine `70C00Y00` | Monk in dungeon class 4 or 7, then the contact. | Sanguine Rose |
| Peryite `50C00Y00` | Ancient Vampire in a dungeon, then the cleric. | Spell Breaker |
| Malacath `80C0XY00` | Daedra Seducer in a dungeon, recover the letter, read it, refuse the noble’s handover and report to the reward contact. | Volendrung |
| Hermaeus Mora `W0C00Y00` | Wound the palace Spellsword, agree to spare him, receive his gift, then pursue him into the revealed dungeon and report to the librarian. | Oghma Infinium |
| Sheogorath `60C00Y00` | Battlemage in one dungeon, then the innkeeper contact inside a second dungeon. | Wabbajack |
| Boethiah `U0C00Y00` | Let the escape clock run, take the letter from the first dungeon, meet the informant, then pursue the Spellsword and report to the librarian. | Ebony Mail |
| Namira `30C00Y00` | Ancient Vampire in a dungeon, then the librarian. | Ring of Namira |
| Meridia `10C00Y00` | Sorcerer in a dungeon, then the librarian. | Ring of Khajiit |
| Vaernima `90C00Y00` | Lich in a dungeon, then the librarian. | Skull of Corruption |
| Nocturnal `40C00Y00` | Wound the mage, accept his bribe, read the letter, find the illusory bow, let it crumble, find the real bow at his hideout, kill the mage and report to the librarian. | Skeleton Key and Auriel’s Bow. The optional Warlock’s Ring and Staff of Magnus also resolve from the installed catalogue. |
| Mephala `Z0C00Y00` | Knight in a palace, then the librarian. | Ebony Blade |
| Azura `T0C00Y00` | Healer in dungeon class 4 or 7, then the librarian. | Azura’s Star |

## Verification conditions

- The initiation fixture supplied the qualifying crime tallies at the event boundary and advanced personal time to delivery. It staged each building landing and the character beside the item or contact. It used ordinary read, take, talk and drop actions. It advanced the clock for the Brotherhood ambush and conclusion and for the two failures.
- A separate two-account WebSocket fixture staged the apothecary, mansion and recruiter approaches. The owner then walked 1.43 m toward the mansion decanter using movement input and took and returned it through the usual quest actions. The witness in the same room could neither see nor take it. The fixture advanced the one-hour conclusion clock and verified rank zero for the owner.
- The Play fixture used the same three staged approaches. From 4.80 m away in Kirkcart Wood, the browser walked 0.80 m toward the decanter, then used the Journal to take it and put it back. The recruiter’s reply, one-gold reward and completed Journal entry appeared in Play. The fixture advanced invitation delivery and the one-hour conclusion.
- The prince fixture supplied Mages Guild rank, funds, date and summoning rolls. Glenmoril used its outdoor witch. Hircine used ordinary fast travel and dungeon entry with the character staged at the exterior door. The remaining sites used staged landings, contacts and combat positions. Test equipment, restored health and controlled foe health isolated the script effects. The fixture advanced personal time for the pursuit, decoy and completion clocks.
- These tests cover the demand and inventory award. Equipping and using each artifact is covered under package 16. The full walks between doors, quest markers and contacts remain separate checks.
