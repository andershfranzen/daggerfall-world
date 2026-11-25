# NPC protocol

Server: `server/rpg/npcs.js` (data in `server/rpg/npcs/`). Browser: `client/gameplay/npcs.js` — the conversation
runs in the chat dock (`#hud-talk`, see "Browser" below); buy/sell and training use the menu page `dialogue`
("Trade & Services").

## Entities

With the operator's ARENA2, people come from the original records and rules (docs/world-expansion-plan.md, "F extension"):
authored RMB building people inside `interior:*`, RMB exterior people and DFU mobile townspeople in `town:*`, and RDB
people in `dungeon:*`. They load when a player is in the location and leave 30 s after the last one goes.

`{id, kind:'npc', role, title, name, location, x, y, z, yaw, anchor:'base'|'centre', sprite:{archive,record}, gender, race,
faction, factionName?, individual?, child?, guild?, shop?, bank?, repair?, services?, questGiver?, questGroup?, service,
building?:{type,factionId,quality,key}, reach, sourced:true}`. Mobile townspeople have `mobile:true, moving, variant, face`.
`y` is the foot height in the location's frame. `anchor:'centre'` marks a dungeon flat that collision could not ground yet,
and the browser lowers it by half the sprite height.

Without game data, each `town:*` gets the legacy deterministic seven-person roster, standing in the lane that town spawn
selection keeps clear. Its roles are `crier`, `noble`, `merchant`, `smith`, `herbalist`, `bowyer`, `innkeeper`, `fighters`,
`mages`, `priest`, `guard` and `townsfolk`.

## Actions

All require the player within the NPC's `reach` (6.4 m, DFU activation distance; roster people 3.5 m) in the same location and, for authored people, on the same storey (feet within 1.6 m).
Everything except `npc.talk` also requires the `session` token from the latest dialogue view;
stale, forged or expired tokens are refused ("That conversation has ended").

| verb | args |
|---|---|
| `npc.talk` | `{targetId}` — starts a session, emits server event `talk {player, entity}` |
| `npc.topic` | `{targetId, session, topic}` — `work`, `news`, `rumours`, `directions`, `organisation`, `trade` |
| `npc.buy` | `{targetId, session, key, quantity, price}` — `price` is the unit price shown; a changed price is refused |
| `npc.sell` | `{targetId, session, itemId, quantity, price}` |
| `npc.service` | `{targetId, session, service, skill?}` — `join`, `train`, `heal`, `donate`, `rest`, `bank`, `repair` (the last two answer and push `{kind:'townServices.offer', counterId, services}`) |
| `npc.ask` | `{targetId, session, query}` lists named people and places (event `dialogue.subjects`); `{targetId, session, subject}` asks for directions to one of them (a `dialogue` view) |
| `npc.tone` | `{targetId, session, tone}` — `polite`, `normal` or `blunt`; answers with the same view and line |
| `npc.leave` | `{}` |

**Tone, reactions and knowledge** (`server/rpg/npcs/talk.js`, source-backed speakers and a player with a character
sheet). The view carries `tone` and `tones` while the speaker can be asked for information. News, rumours, directions,
the nearest inn, a street "Any work?" and a "Where is…" pick are each one reaction roll. The chance is 45 % plus half the
tone's skill (Etiquette for polite, Streetwise for blunt, the better of the two at half weight for normal), plus the
speaker's social group's liking for the tone (nobility, learned, merchants, commoners, underworld), attitude and
Personality, clamped to 5–95 %. An answer practises that skill once. A refusal gives a group- and tone-specific line;
after three, the speaker answers no more questions from that player for five minutes, even in a new conversation. A
"Where is…" pick after this conversation's directions request was answered is not rolled again. Whether a speaker
knows where a person or ordinary shop is depends on the speaker, the subject and the distance (deterministic). Landmarks
(bank, guild hall, temple, tavern, palace) and the speaker's own building are always known. An unknowing speaker says
so and marks nothing. News and rumours name one of this town's public named buildings, its people or today's work
giver, rotating by speaker and game day, with the general lines one time in three.

**Learned places.** A building named in an answer (directions, the inn, "Where is…", a work lead, news or rumours) is
saved on the listener only: `rpg.learnedPlaces[town] = [{id, name, type, interior, x, z}]` (portal id, street door in
the town's frame; 200 per town, 64 towns). New entries go out once as the private event
`{kind:'map.learned', silent:true, town, places}` and the server event `placeLearned {player, town, places}`, and the
view's `learned:[{id, name}]` puts "Marked on your map: …" under the line. The automap (package 6) reads
`learnedPlaces` to label buildings. Secret halls, houses and another player's private quest people are never learned.

`topic:'work'` on a quest giver emits server event `npcWork {player, entity}` and the view sets
`journal:true`; the conversation then offers **Review journal…** (`api.openPanel('journal')`).

A street townsperson answering **Any work?** names a person offering work in an open building and gives the
distance and direction to its door. The published giver and the directions use the same daily roll. An individual
away on the listener's quest is excluded from that listener's leads.

**Where is …?** (`npc.ask`, only when the view has `ask:true`: a source-backed speaker with the directions topic).
Subjects are the town's named public buildings that have a surveyed street door (`b:<portal id>`, named from
`portal.meta.buildingName`, else `portal.label`) and the named adults the interiors publish for them (`p:<npc id>`).
Houses, Thieves Guild and Dark Brotherhood halls and their people, witches, children, people out of doors and an
individual that this player's quest has placed elsewhere are never listed or answered. Another player's private
quest people are not included either. A query matches the starts of words in the name, title or building, ignoring case and accents. Name
matches come first, then places, then the nearest door. At most 8 are sent, with `total`. The answer gives the
building, the nearest door's distance and bearing from the speaker, or from the speaker's street door when indoors.
It also says where to look inside, measured from the entry landing and its facing, with the floor. When the player is already inside that building, it
gives the distance and the direction relative to the player's facing. A shop that is shut at this hour is mentioned.

## Events (private)

- `{kind:'dialogue', silent:true, entityId, name, session, npc, text, attitude, topics, services, standing, guild?, shop?, journal, gold}`
- `{kind:'dialogue.subjects', silent:true, npcId, session, query, total, subjects:[{id, kind:'person'|'place', label, hint}]}`
- `{kind:'dialogue.end', npcId, text?}` — walked away, timed out or left.
- `{kind:'map.learned', silent:true, town, places:[{id, name, type, interior, x, z}]}` — buildings newly learned in talk.

The dialogue view may also carry `tone`, `tones:[{id, label}]` and `learned:[{id, name}]`.

Shop views are pushed to every player trading with the same merchant after any purchase, sale or restock.

## Rules

- Gold and goods are conserved: buying moves gold to the merchant's purse and stock to the player; selling
  the reverse. The merchant's purse limits what they can buy. Prices are classic (docs/shops-and-economy.md):
  CalculateCost with the shop's quality and the shared regional market, holiday halving, then
  CalculateTradePrice with the player's Mercantile and Personality; a shop never pays a player more for a template
  than that player last paid it. Real shop buildings sell from their shelves (`shelf` on each item) and buy only
  their classic item groups; `sellItems` (Thieves Guild fence, rank 2+) opens a sell-only view (`shop.fence`).
  Purse/stock changes are undone with the player's state if the action fails or cannot be saved (`ctx.onRollback`).
- Reputation `rpg.factions[id]` (−100..100). Attitude combines the NPC's faction with half the region's.
  Hostile NPCs refuse topics, trade and services.
- Guilds `rpg.guilds[id] = {rank, joinedAt}`. Joining and ranks follow Daggerfall Unity's Guild.cs tables
  (reputation 10 per rank; guild skills against high/low thresholds). Rank only rises; it is re-checked when
  talking to the guild, after services and on `questCompleted {player, factionId, reputation}`.
- Training (members): fixed cost by skill and rank, capped per rank, one session per minute,
  `advanceSkill(p, skill, 15 − floor(value/10))`.
- Shops share one ledger per building. SQLite saves its stock and purse in the same transaction as the player's purchase or sale.
- Services published on `ctx.services`: `reputation`, `adjustReputation`, `guildMembership`, `guildRank`, `npcsAt`,
  `npcSessions`, and `npcs` = `{peopleAt(location), workAt(town, playerId?), ready(location), status(location), questSpawn(location),
  questItemMarkers(location), individualHome(factionId), setIndividualAway(factionId, playerId, away), resolve(legacyId,
  town), describe(id), source}`.

`ready(location)` resolves after the source records are read. `peopleAt(location)` returns the occupants the
simulation has published, which begins on the first occupied tick. To look up a job before anyone enters a
building, await `workAt(town, playerId)`. Each result includes the giver's id, name, quest group and interior.

## Browser (in-chat conversation)

- G / Talk on an NPC: `npcs.js` handles `interactIntent` and sends `npc.talk`. Each `dialogue` view is drawn in
  `#hud-talk` inside `#hud-chat` (`npcs/chatTalk.js`). The section's `hidden` is toggled and `body[data-talk]=<npc id>`
  is set while it is open. The layout CSS (`hud/layout.css`) owns the size; the inner look is in `npcs/chatTalk.css`.
  No central menu opens and no toast is shown (`ev.silent`).
- **Tone** is a pressed toggle group (`.talk-tone`, `aria-pressed`) above the replies, drawn from the view's `tones`;
  it is not numbered, so reply numbers stay stable. Choosing one sends `npc.tone`. When `learned` is present the status
  line reads "Marked on your map: …".
- Long text is split into passages (`npcs/conversation.js`, `passages`) with **Continue**. Replies come from the
  view (`replyChoices`): topics, services, **Show me your wares** / **Training…** (open the `dialogue` page),
  **Repairs…** for smiths (`townServices`), **Review journal…**, and **Goodbye** last.
- **Where can I find…** keeps its number. After the server answers, a filter field (`.talk-ask`) opens under the
  replies, with up to 8 people and places. Typing narrows the list, with a 180 ms debounce. Enter or a click asks about the first or chosen
  entry. Arrow keys move through the list, and Esc or × closes it. Lists from an older session are ignored. On touch screens the field is
  only scrolled into view, so the keyboard stays closed until the player taps it.
- Keys while talking (capture phase, only when no menu page is open and no text field is focused): 1–9 choose a
  reply, Esc says goodbye (unless the mouse is captured, when Esc only frees it). Enter / T still open the chat
  composer. Focus is not moved into the replies, but G on the same speaker or Tab moves it there. The mouse is freed
  when a conversation starts. A persistent polite live region announces each passage, and the end of the
  conversation goes to the player's own chat log (never sent to anyone).
- Quest offers from the speaker, Accept/Refuse results and quest lines sent within 2.5 s of speaking are shown in
  the dock. `npcs.js` sets `ev.talkHandled`, and `quests.js` then neither toasts nor opens the Journal (the
  Journal still records them).
- The conversation ends on `dialogue.end` (walked away, timeout), Goodbye, travel (`location`), a lost connection
  (`connection` ≠ online) or leaving the game. Closing a page opened from the conversation returns to it if it
  is still open.
