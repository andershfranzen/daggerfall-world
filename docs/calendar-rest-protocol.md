# Calendar, holidays, rest and personal time (package 20)

Owner: package 20. Server: [calendar.js](../server/rpg/calendar.js), [atmosphere.js](../server/rpg/atmosphere.js). Shared rules: [holidays.js](../client/gameplay/atmosphere/holidays.js), [calendar.js](../client/gameplay/atmosphere/calendar.js).

## The shared clock contract

World time is a pure function of wall-clock time (12× scale from a fixed epoch). Every player reads the same date and hour. Holidays can be regional, and outdoor weather depends on the political region and local climate. Shop hours, gates, holidays, weather, NPC schedules and shop restocks use this shared clock.

Time that one character spends (rest, loiter, travel, prison, training) goes into that character's **personal ledger**. A private timer that should count that time (quest deadline, room rental, disease incubation, jail release, loan due date for one borrower) reads the character's own clock:

| Service | Returns |
|---|---|
| `services.worldClock()` | `{minutes, year, month, day, hour, …}` shared world time |
| `services.personalMinutes(p)` | Total minutes this character has spent outside the shared clock |
| `services.playerMinutes(p)` | `worldClock().minutes + personalMinutes(p)`. This value is monotonic for one character. Use it only for that character's private timers. |
| `services.spendTime(p, minutes, reason)` | Adds to the ledger and emits `timeSpent` |

`ctx.on('timeSpent', ({player, minutes, reason, from, to}) => …)`. `from` and `to` are `playerMinutes` before and after the change. Reasons are `rest`, `loiter`, `travel`, `prison`, `train` and `wait`. Rest and loiter emit once per hour (60 minutes), so conditions and quest clocks can advance hour by hour. Travel emits the whole journey once.

## Holidays

The calendar uses the classic `FormulaHelper.GetHolidayId` tables, with 53 holidays. `id` is the `DFLocation.Holidays` ordinal (1–53). `key` is the enum name in kebab case and is stable. For example, `Suns_Rest` becomes `'suns-rest'` on day 200 (20 Sun's Height) in all regions. `Hearts_Day` is `'hearts-day'` on day 46, `Merchants_Festival` is `'merchants-festival'`, and `Witches_Festival` is `'witches-festival'`. Import `HOLIDAY` to get `HOLIDAY.Suns_Rest === 'suns-rest'`.

| Service | Returns |
|---|---|
| `services.holidayAt(minutes, regionIndex)` | Key or `null`. `regionIndex` is the 0-based MAPS region. If `minutes` is null, the service uses the current time. |
| `services.holidayIdAt(minutes, regionIndex)` | Classic id or `0` |
| `services.holidayFor(p)` | `{id, key, name, dayOfYear, regionIndex, textId}` for the player's current region today, or `null` |
| `services.holidayPrice(service, price, {p?, regionIndex?, minutes?, guildFaction?, itemGroup?, days?, startDayOfYear?})` | `{price, free, holiday, rule}` |

`holidayPrice` services follow the classic consumers. `tavern`: New Life is free, and Harvest's End is half price with a minimum of 1. `room`: the Heart's Day night is free. `identify`: free during the Witches' Festival. `spell`: half price during the Witches' Festival, with a minimum of 1. `cure`: free on South Winds Prayer and on the First and Second Harvest, and half price during the North Winds Festival. `trade`: Merchants' Festival halves non-guild prices, Tales and Tallows halves Mages Guild (faction 40) prices, and the Warriors' Festival halves non-guild `itemGroup:'Weapons'` prices. Shops (`RMBLayout.IsShop`) are locked on Sun's Rest.

When a player enters a town exterior on a holiday, the player receives `gameEvent {kind:'holiday', key, name, textId, text}` once per holiday day. `textId` is TEXT.RSC 8349 + id.

## Seasonal weather and scene assets

The season follows Daggerfall Unity’s month boundaries. Daggerfall World uses its own six-hour forecast, seeded by political region and world time. `POLITIC.PAK` identifies the wilderness region and `CLIMATE.PAK` identifies the town or wilderness climate. Desert, Desert2, Rainforest and Subtropical use the reference’s snow-free climate list. In those climates a snow roll becomes clear and winter alone does not select snow footsteps. Daggerfall Unity uses climate-specific probabilities from the *Daggerfall Chronicles*. Daggerfall World keeps its regional probabilities and local lighting and precipitation effects. [Season and forecast rules](../client/gameplay/atmosphere/calendar.js) · [Reference weather table](https://github.com/Interkarma/daggerfall-unity/blob/3d85a283672a4955e32992097ea7719e896dbadb/Assets/Resources/WeatherTable.json)

Wilderness assembly uses the shared season to select installed `TEXTURE.*` and `SKY*.DAT` variants. An already-loaded exterior keeps its visual assets when the season changes. Town assembly still uses dry summer textures. The clock, lighting and precipitation can update while the player remains in either scene. [Wilderness assembly](../client/gameplay/wilderness.js) · [Town textures](../client/world/README.md#textures)

## Follow-up verification

The continuation reused the saved Package 20 fixture character and the same private server setup. It used installed people and interiors, staged character positions and condition records, and a controlled shared epoch. All dates are local fixture dates. The ordinary-day comparison used the same character stats, hall and NPC before each holiday.

| Fixture | Installed service and observed result |
|---|---|
| 12–13 Frostfall, 3E405, 13:00 | At the Daggerfall Mages Guild, Bedore Hawkwing’s identification quote changed from 7 gold to free. The item became identified and the balance held at 1,100. Bedane Kingford quoted 257 gold for *Fenrik’s Door Jam* on the ordinary day and 128 at the Witches’ Festival. The character learned the spell and paid 128 gold. |
| 14–15 Evening Star, 3E405, 13:00 | At Daggerfall’s Temple of Kynareth, Perore Greenford quoted 315 gold for one disease on the ordinary day and 160 at the North Winds Festival. The cure charged 160 and removed the disease. North Winds is eligible in all regions. |
| 15 Evening Star, 3E405, 13:00 | The connected observer received Clear in Sentinel (Subtropical, 229) and Atriga (Desert, 224). Bubyrydata (Mountain, 226) still received Snow. Atriga and Bubyrydata belong to the same political region, Alik’r Desert, and share the same underlying regional snow roll. |
| 30 Sun’s Dusk to 1 Evening Star, 3E409 | Two continuously connected accounts in Daggerfall’s Gothway Garden area received Fall/Clear at 23:59 and Winter/Snow at 00:00. Both were in Woodlands (231), one at Gothway Garden and one on the adjacent wilderness pixel `109,160`. Their shared minute advanced from 3,067,199 to 3,067,200 at 12×. Their personal ledger offsets stayed at 0 and 8,107 minutes. In Play, snow particles appeared over terrain archive 302 and `SKY16.DAT`, the same assets the scene had loaded in fall. |

The Mages Guild and temple quotes and purchases were exercised in Play. The climate comparison used the observer’s live socket, and the seasonal transition used one Play connection and one observer socket. The prior Sun’s Rest, camping, encounter and loan fixtures are separate coverage. Service-level Play checks remain for New Life and Harvest’s End food and drink, Heart’s Day lodging, the free-cure days, and the Merchants’, Tales and Tallows, and Warriors’ trade discounts. Delivery of a holiday notice restricted to a single region also remains to be checked in Play. In-place asset swaps and town winter variants remain open. Selection of the alternate wilderness assets on a fresh winter load was traced in the builder. The Play automation timed out at re-entry before it could verify that path.

## Rest, loiter and their legality

`rest.start {mode:'hours'|'healed'|'loiter', hours}`. Loitering recovers nothing (classic `RestModes.Loiter`), lasts at most 99 hours, and is allowed in places where sleeping is not. Each player follows these rules:

1. A player in a town exterior cannot sleep. The response is the classic message 17 (“camping within city walls is illegal”). The server emits `ctx.emit('crime', {player, crime:'vagrancy', location})` and calls `services.reportCrime?.(p, 'vagrancy', {location})`.
2. Inn beds belong to package 2 (`services.tavern.sleep(p)`): a rental, the allocated bed and its expiry, including how a holder's personal rest and travel release the bed. Package 2 rebases `timeSpent` onto its shared release minute, so no clock compares one player's personal time against another's. Loitering skips the bed check because classic `RestModes.Loiter` skips `CanRest`. In other town buildings, rest is allowed when `services.ownsBuilding?.(p, portal)` or `services.guildCanRest?.(p, portal)` is truthy. Guild rest never applies in a tavern. A ship is also allowed. Everywhere else, the player gets “You have not rented a room here.”
3. Dungeons and the wilderness are always legal.
4. Another feature can block rest by registering `services.preventRest.set(name, (p) => message|null)`. A non-null message refuses the start or ends a rest in progress with `reason:'prevented'`.

A nearby threat refuses or ends rest. The server calls `services.monsterThreatens(e, p)` when package 8 provides it. Otherwise it uses a living hostile monster within 40 units.

**Encounters.** A rest or loiter in a dungeon, wilderness or town exterior calls `services.restEncounter(p, minute)` once for each personal minute rested. `minute` is the rest's start world minute plus the elapsed minutes. A non-null monster ends the rest with `reason:'encounter'`. Package 8 owns timing, tables, distance and the dungeon alert.

Package 8 handles awake players' night, town and wilderness encounters with its shared per-scene `spawnTick`. That tick runs once per occupied scene and world minute, so every player there sees the same monster population. Package 20 makes no awake spawn calls. The `travel` event lets package 8 suppress the arrival roll, as classic `PreventEnemySpawns` does.

Rest emits `restStart` and `restEnd {player, reason, hours, mode}`.

## Travel

`travel.go` is refused while `monsterThreatens` reports an enemy (`cannotTravelWithEnemiesNearby`) or while a `services.preventTravel` entry returns a message. Package 10 uses that hook for sunlight careers by day. The journey's classic duration is charged to the traveller through `spendTime(p, minutes, 'travel')`. The shared clock does not move. The reference revision has no mid-journey ambush. Interruption therefore means a refused departure, a broken rest or loiter, and suppressed spawns on arrival.

The travel map and the server calculate the same sea fare. The fare is waived for ship owners and members of any knightly order at rank 6 or higher. The Akatosh speed bonus changes journey time, and knightly lodging benefits reduce inn expenses. Guild teleportation consumes no travel time. [Journey rules](../client/gameplay/travel/journey.js) · [Fare and travel tests](../test/rpg-travel.test.mjs)

## Prison

On release, package 14 calls `services.spendTime(p, days * 1440 + 240, 'prison')`. The ledger counts the sentence plus four hours for release. The character's quest, rental and condition timers advance on their personal clock.
