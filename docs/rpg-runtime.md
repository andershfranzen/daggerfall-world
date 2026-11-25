# RPG runtime: server contract and guarantees

Companion to [gameplay-protocol.md](gameplay-protocol.md). Code: [server/rpg/runtime.js](../server/rpg/runtime.js), wired in [server/game.js](../server/game.js), persisted by [server/db.js](../server/db.js). Tests: `test/rpg-runtime.test.mjs` (unit) and `test/rpg-runtime-ws.test.mjs` (real WebSocket + SQLite).

## Features

`createGameServer({ features })` takes an array of installers. Each entry is an `install(ctx)` function, `{ name, install }`, or a module namespace. If it is omitted, the server uses the production manifest `server/rpg/features.js`, which provides the named export `features` and the default export. `features: []` gives an isolated server, as the legacy `test/server.test.mjs` uses. Installers run once per server instance. Registering a duplicate or malformed action verb fails at construction.

These `ctx` additions go beyond the protocol doc:

| API | Meaning |
| --- | --- |
| `ctx.location(p)` | `p.rpg.location`, or the default location |
| `ctx.defaultLocation`, `ctx.config` | read-only; `config` = `{tickHz, maxSpeed, worldHalfExtent, arena2Dir}` |
| `ctx.dataPath`, `ctx.dataFile(name)` | operator ARENA2 directory (realpath) or null; `dataFile` refuses paths that escape it |
| `ctx.touchEntity(e)` | record an entity outside the actor's location **before** mutating it, so it rolls back |
| `ctx.onRollback(fn)` | undo step for feature-private state; runs only if the current action fails, in reverse order |
| `ctx.afterCommit(fn)` | side effect deferred until the action is saved; dropped on failure; immediate outside actions |
| `ctx.inAction()` | true while an action transaction runs |
| `ctx.isMuted(p)`, `ctx.services.isMuted(p)` | account mute via `accounts.isMuted(accountId)`; guests → false |
| `ctx.services.movePlayer(p, x, z)` | optional (the collision feature provides it) and returns `{x,z}`. Called for each proposed movement step before it is committed. A throw or an invalid result keeps the old position. |

## Wire additions

- `{type:'action', verb, args?, seq?}`. `verb` is a dotted lower-camel name such as `combat.attack`. `args` is a plain object of depth ≤ 6 with ≤ 256 nodes, ≤ 64 keys per object, strings of ≤ 1000 characters and finite numbers only. Keys may not be `__proto__`, `constructor` or `prototype`. Actions are limited to 10/s with a burst of 20, enforced per connection and per account (so reconnecting does not reset an account's action burst).
  - Without `seq`, a failed action replies `{type:'error', message, verb}` and a successful one sends no reply; the client sees the change in the next `rpg` snapshot.
  - With `seq`, a non-negative integer, the server always replies `{type:'actionResult', seq, verb, ok, error?}`.
  - A plain `Error` or `ActionError` message reaches the player. Any other error becomes `"action failed"` and is logged, and storage errors become `"could not save your progress; nothing changed, try again"`.
- `{type:'rpg', selfId, character?, entities?, entityDelta?, peers?, readiness?, locomotion?}` is the private snapshot.
  - `character` is the player's own `p.rpg`.
  - `entities` covers this location only. Keys starting with `_` and `visibleTo` are removed. An entity with `visibleTo` (array or Set of player ids) is shown only to those players.
  - For clients that opt into `delta: true` on `join`, unchanged top-level fields are omitted and within-location entity updates arrive as `entityDelta: { upsert?: Entity[], remove?: (string|number)[] }` instead of resending the full `entities` array. `mergeRpg` (`client/gameplay/api.js`) applies `entityDelta` in place. First snapshots, location changes, `force` syncs, and `resetSync` always send the full `entities` array; legacy clients without `delta: true` always receive full snapshots.
  - `peers` are the other occupants as `{id,name,x,z,yaw,moving, readied?, race?, gender?, className?, weapon?:{template,name}, animation?}`. Of `rpg.character`, only `race`, `gender` and `className` (strings ≤ 40 characters) are public.
  - The server sends a snapshot only when its content changes. Peer position changes alone never trigger one, because positions stream through `state` / `stateDelta`.
- `state` (and `stateDelta` for `delta: true` clients) and `chat` are scoped to the location. `state` goes to each location's occupants when it changes, and at least once per `stateHeartbeatMs` (1 s) while idle.

## Accounts integration (exact mapping)

`createGameServer({ accounts, allowGuests })`. `accounts` (server/accounts.js) supplies:

- `handleHttp(req,res)`: every `/api` and `/api/*` request goes here before static delivery.
- `resolveUpgrade(req)` returns `{id, username, sessionKey?}` or null (sync or async). Anything malformed counts as null. Without a verified account, `/ws` gets **401**, unless `allowGuests` is set, which is a development option.
- `isMuted(accountId)` blocks chat with "you are muted" and backs `ctx.isMuted`.
- `onModeration(fn)` closes every socket of that account with **4004** "account access revoked".
- `onSessionEnd(fn)` (logout, password change, logout-all, recovery) closes only the sockets upgraded with that `sessionKey`, with **4004** "signed out".
- `onAccountDelete(fn)` (self-deletion via `POST /api/delete-account`) closes every socket of that account with **4004** "account deleted", runs leave handlers without re-saving the deleted player, and removes the account's `account_characters` and `players` rows.

Storage is `account_characters(account_id TEXT PRIMARY KEY, player_id INTEGER UNIQUE → players.id, username, linked_at)` in the game DB. Each account has exactly one character.

- The character is looked up by `String(account.id)` from the verified upgrade. Fields in the join message (`name`, `token`) are ignored. The in-game name is the account username, and `username` is updated in the mapping on change.
- A new account character gets a random token hash that is never revealed. `findByToken` excludes linked rows, so **no guest token can open an account character**.
- Welcome in accounts mode: `{type:'welcome', id, token:null, account:{id, username}, player}`. Rejoin is by account id. The `sessionKey` never reaches clients.
- Optional claim: `{type:'join', claimToken}` from an account **with no character yet** links that unclaimed guest character. The claim replaces its token hash, which revokes the guest token, and closes any live guest session with 4000. A failed claim gives the non-fatal error "guest character could not be claimed".
- `server.characterForAccount(accountId)` → `{id, name}` | null.

## Persistence (SQLite, additive migration)

Schema v2 (`PRAGMA user_version = 2`) adds `players.rpg TEXT NOT NULL DEFAULT '{}'` and `account_characters`. v1 databases are migrated in place. Existing rows keep their data and get `rpg = '{}'`, so join handlers apply defaults.

- A save writes `name, x, z, yaw, rpg` for all given players in one `BEGIN IMMEDIATE` transaction.
- `rpg` over 256 KiB fails the save, and the transaction leaves the stored row unchanged.
- A row with unreadable `rpg` refuses the join (1008 "character data unavailable") instead of being silently reset.

## Tested guarantees

1. **Atomic actions.** Before an action runs, the runtime snapshots:
   - every player in the actor's location: `rpg`, `name`, `x`, `z`, `yaw`, `moving` and `animation`;
   - every entity in that location;
   - the entity Map's membership.

   Players marked with `ctx.dirty` and entities passed to `ctx.touchEntity` are snapshotted on that first call. If the handler throws or the SQLite save fails, all of these are restored and killed mobs return as the same object. Dropped loot disappears, `onRollback` hooks run in reverse, and buffered `notify`/`nearby` events and `afterCommit` callbacks are discarded. On success all affected players are saved in one transaction, then events are delivered and snapshots sent.
2. **Multi-character trades and rewards** save both characters in one transaction, or neither.
3. **Duplicate sessions.** A second connection for the same character (token or account) takes over the live object. The old socket closes with 4000. Join and leave handlers do not run again, and the old socket's close neither removes nor saves over the character.
4. **Failed final save.** A character whose save on leave fails is kept in memory and retried by the periodic save. If the player rejoins first, the session resumes from that newer in-memory state and the retry is dropped, so it can never overwrite the newer session.
5. **Validation.** Malformed verbs and arguments are rejected before any handler runs.
6. **Game data.** `arena2Dir` (main.js reads `ARENA2_DIR`) must be a directory outside `clientDir` and `siteDir`, or construction throws. Public hosting keeps those files private. A loopback server can opt into authenticated, same-origin reads for local play as described in the README.

## Known limits

- **Shallow entity rollback:** entities that `structuredClone` cannot copy, for example ones holding functions, are restored shallowly, so nested objects inside them are not rolled back.
- **Mutations outside the snapshots are not restored.** This covers entities in other locations that were not passed to `touchEntity`, players outside the actor's location mutated before `ctx.dirty`, and feature-private state without an `onRollback` hook.
- **Tick and leave handlers are not transactional.** Their changes are saved by the periodic 5 s save or by the leave save. A crash can lose up to one save interval of tick-driven and movement changes.
- **Single process.** The session store and transactions are in-process only.
- **Rate limits.** Action limits apply both per connection and per account; message and chat limits apply per connection.
