# Daggerfall World

A shared online world for The Elder Scrolls II: Daggerfall, played in the browser, now in development. One authoritative server hosts every player. Each player's browser draws the world from their own copy of the classic game. The aim is to bring the original game's characters, equipment, combat, creatures, NPCs, guilds, quests and world into one persistent multiplayer service. This is an unofficial fan project.

## Players

Open a game server in your browser and create an account or sign in. On localhost, the launcher finds the installed `ARENA2` automatically. On a public server, choose the extracted `ARENA2` folder from your own classic Daggerfall installation. The browser reads the files locally.

You need a desktop browser with WebGL and folder selection. Testing so far has used Chromium.

Use **WASD** to walk, **Q**/**E** or the arrow keys to turn, and click the game view once to capture the mouse, then move it to look around (**Esc** releases it; on touch screens, drag to look). **F** readies your weapon, **Space** or a click attacks and **G** talks, uses or loots. **C**, **I**, **B**, **J**, **M** and **O** open the character, inventory, spellbook, journal, map and party screens, and **F10** opens settings, where most keys can be rebound. Press **Enter** or **T** to chat and **P** to see who is here. The in-game **Controls** button shows the current list. The player's guide on the website covers accounts, troubleshooting and privacy.

## What works today

- Accounts with password sign-in and secure session cookies. The game requires a signed-in account, and two sessions have been checked side by side in the browser.
- Character creation in the browser, with every number kept on the server.
- Gothway Garden in first person, drawn from the player's own files, with townsfolk sprites, a readied weapon in view, other players' presence, location chat and saved positions.
- An in-game menu shell with keyboard help and rebindable keys.
- Operator moderation: mute, ban and sign out an account everywhere.
- Server systems covered by automated tests: inventory and equipment, merchants and guilds, parties and trades, shared combat and magic, travel between Iliac Bay towns, and a shared world clock. [Gameplay coverage](docs/gameplay-coverage.md) lists exactly what each test checks and what it does not.

Press **M** to travel between towns or **L** to visit nearby camps, guard towers and other World of Daggerfall sites. Two browser accounts visited the same Guard Tower and returned independently. The character creator and inventory use the original race, face, clothing and equipment art. Supported original quests can be offered, accepted and recorded in the journal. The remaining classic features are grouped into 21 ordered work packages, with a playable acceptance check for each. [Classic feature backlog](docs/classic-feature-backlog.md)

## Operating a server

This section is for hosts, not players. The server needs Node.js 22.13 or later and the operator's own `ARENA2` folder:

```sh
npm ci
ARENA2_DIR=/srv/daggerfall/arena2 npm start
```

`npm start` serves the launcher at `/`, the game client at `/play.html`, the account API and the `/ws` game socket on one origin, by default `http://127.0.0.1:8080/`. Public servers read `ARENA2_DIR` privately. On loopback the local-files endpoint can read individual game files for the browser. Server gameplay reads world data from it: the map of towns for travel, building collision and the doors into interiors and dungeons. Without it, travel offers only a short starter list and doors cannot be used. Other settings include `PUBLIC_ORIGIN`, `TRUST_PROXY`, `REQUIRE_HTTPS`, `MAX_PLAYERS`, `DB_PATH` and `ACCOUNTS_DB_PATH`.

For World of Daggerfall, put the extracted author source tree at `gamedata/world-of-daggerfall/` or set `WOD_PATH` to its directory. It should contain `WorldOfDaggerfall.dfmod.json`, `Locations/` and `WorldData/`. The built-in reader uses that tree directly for placements, replacement blocks and custom scenery. On localhost the game loads the installed models automatically. Other players can select their source folder in the Wilderness menu under **World of Daggerfall model files**. [World of Daggerfall Project](https://www.nexusmods.com/daggerfallunity/mods/249) · [Author source](https://github.com/drcarademono/world-of-daggerfall)

For a public deployment, follow [public hosting](docs/public-hosting.md). It covers the Docker Compose and Caddy recipe with TLS, the read-only game-data mount, the `node server/accounts.js` moderation commands and backups.

## Development

```sh
npm ci
npm run dev        # game server, http://127.0.0.1:8080/
npm test
```

On a loopback address (`localhost`, `127.0.0.1` or `[::1]`), `/play.html` offers the server's installed ARENA2 folder automatically, so a local tester does not have to choose it. It uses `ARENA2_DIR`, or `gamedata/DaggerfallGameFiles/arena2/` in the checkout. This convenience turns itself off behind a proxy, with `PUBLIC_ORIGIN`, `REQUIRE_HTTPS` or `NODE_ENV=production`, on a non-loopback `HOST`, or with `LOCAL_ASSETS=0`. Public players always choose their own folder.

`npm run dev` also accepts `ALLOW_GUESTS=1` to test without accounts. The production server refuses that setting. Operators can serve an optional static landing site by setting `SITE_DIR` to its exported directory. The game loads browser ES modules at `/play.html`, and the server stores accounts and characters in SQLite. See the [server guide](server/README.md), the [gameplay protocol](docs/gameplay-protocol.md), the [gameplay coverage](docs/gameplay-coverage.md) and the [technical approach](docs/browser-architecture.md).

This is an unofficial project. The Elder Scrolls and Daggerfall belong to their respective owners. Players and operators must supply their own game data. [Classic Daggerfall on Steam](https://store.steampowered.com/app/1812390/The_Elder_Scrolls_II_Daggerfall/)
