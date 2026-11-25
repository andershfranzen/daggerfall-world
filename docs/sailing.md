# Sailing the Iliac Bay

## Daggerfall Online reference

The reference for this work is Lattymoy's public DFO Online edition, revision `a3eb1605ea1dc391b691fe314377458a7e63e483`. It describes the game on November 2, 2026. Development of the live edition continued privately. The public edition implements the Come Sail Away helm and adds its own naval game. [Public edition](https://github.com/Lattymoy/daggerfall-js-source/tree/a3eb1605ea1dc391b691fe314377458a7e63e483)

| At sea | Behaviour in the public edition | Source |
| --- | --- | --- |
| Hull and helm | A rowboat, large boat, small ship, galley and carrack have different rigs and handling. Oars work in a calm. Under sail, wind strength, point of sail, canvas and the hull affect speed. The responsive player helm retains headway upwind. AI captains can tack. | [Hull table](https://github.com/Lattymoy/daggerfall-js-source/blob/a3eb1605ea1dc391b691fe314377458a7e63e483/src/systems/comeSailAway/comeSailAwayHulls.js) · [Helm](https://github.com/Lattymoy/daggerfall-js-source/blob/a3eb1605ea1dc391b691fe314377458a7e63e483/src/systems/helmWay.js) |
| Navigation | Ports have offshore berths. The lane builder finds routes through connected water and straightens a route where the whole segment is navigable. Merchant and naval traffic runs between ports. A traveller can pay a friendly master for a passage and ride the crossing. | [Sea lanes](https://github.com/Lattymoy/daggerfall-js-source/blob/a3eb1605ea1dc391b691fe314377458a7e63e483/src/systems/naval/seaLanes.js) · [Passage](https://github.com/Lattymoy/daggerfall-js-source/blob/a3eb1605ea1dc391b691fe314377458a7e63e483/src/systems/naval/passage.js) |
| Combat | The bearing selects the available battery. Each load trades hull, rigging or crew damage against spread and reload time. Separate ship condition values feed back into performance. An AI ship ordinarily strikes its colours at a quarter hull. | [Gunnery](https://github.com/Lattymoy/daggerfall-js-source/blob/a3eb1605ea1dc391b691fe314377458a7e63e483/src/systems/naval/navalGunnery.js) · [Shot](https://github.com/Lattymoy/daggerfall-js-source/blob/a3eb1605ea1dc391b691fe314377458a7e63e483/src/systems/naval/shotKinds.js) · [Damage](https://github.com/Lattymoy/daggerfall-js-source/blob/a3eb1605ea1dc391b691fe314377458a7e63e483/src/systems/naval/navalDamage.js) |
| Boarding | Grapples pull a surrendering ship alongside. Her surviving hands defend the deck. Winning opens the hold and lets the victor take supplies, press crew, repair, or dispose of the captured ship. | [Boarding](https://github.com/Lattymoy/daggerfall-js-source/blob/a3eb1605ea1dc391b691fe314377458a7e63e483/src/systems/naval/navalBoarding.js) · [Prize](https://github.com/Lattymoy/daggerfall-js-source/blob/a3eb1605ea1dc391b691fe314377458a7e63e483/src/systems/naval/navalPlunder.js) |
| Consequences and work | A first hit on lawful shipping can incur piracy in the relevant crown's waters. A harbour offers repairs, crew and stores. Its board offers bounty, hunt, delivery, salvage and survey contracts. | [Law](https://github.com/Lattymoy/daggerfall-js-source/blob/a3eb1605ea1dc391b691fe314377458a7e63e483/src/systems/naval/navalLaw.js) · [Yard](https://github.com/Lattymoy/daggerfall-js-source/blob/a3eb1605ea1dc391b691fe314377458a7e63e483/src/systems/naval/navalYard.js) · [Board](https://github.com/Lattymoy/daggerfall-js-source/blob/a3eb1605ea1dc391b691fe314377458a7e63e483/src/systems/naval/harbourBoard.js) |
| Multiplayer | DFO elects a nearby player to run local sea traffic. Peers receive vessel poses, volleys and recent hits through the room relay. A handover generation resolves conflicting claims to a ship. | [Naval wire protocol](https://github.com/Lattymoy/daggerfall-js-source/blob/a3eb1605ea1dc391b691fe314377458a7e63e483/src/systems/naval/navalWire.js) |

Here the dedicated world server owns the sea. A character's feet are in metres on the walkable deck or cabin. The ship has a separate position and heading in the bay. That distinction matters for joining another captain, walking through a cabin door, following a shot across moving decks and saving the voyage.

## At the quay and aboard

Open **Ship & Sea** in a port town. The shipyard sells hulls, stores, refits and crew contracts. An owner can board and cast off, and members of the owner's party can board at the same quay. **Sea Passage** offers a paid berth to travellers without a ship. The sea chart can plot a passage from a port. Once under way, the helmsman can select a destination on the chart and choose **Set course**.

| At the helm | Control |
| --- | --- |
| Open Ship & Sea or take/release the helm | U or K |
| Turn to port or starboard | A or D |
| Raise or lower canvas | W or S |
| Back or pull the oars | Q or E |
| Drop or weigh anchor | X |
| Make fast near a berth at low speed | Y |
| Cycle the load of the battery you face | / |
| Fire the ready battery you face | Space |

Two signed-in accounts tested shared boarding, manual sailing, anchoring, a server restart and going ashore. A separate installed-data fixture paid 200 gold for passage from Daggerfall to Sentinel, followed the roughly 201 km charted course with ordinary simulation ticks and reached the quay with zero groundings. An owned vessel completed the same crossing. In-process multi-account integration tests (`test/rpg-naval-multiplayer.test.mjs`: real runtime and SQLite store, ships set up by a fixture verb, one target hull pre-damaged) exercise full open-sea sailing under the helm, naval combat, boarding and disconnect cleanup, offline prize escrow and rejoin reconciliation, party wreck recovery, admiralty bounty persistence, harbour return, and server restarts. The chart and helm were exercised in Play.

## Server protocol (server/rpg/sailing.js)

This section is the fixed wire contract of the sailing core. Clients should hide any control whose field is absent; fields may be added but not renamed.

### Frames

- Vessel `x`, `z` are global metres on the overland grid: x east, z south (`server/rpg/overland.js`). Map pixel: `px = floor(x / 819.2)`, `py = floor(z / 819.2)` (`voyage.js seaToPixel`).
- `yaw` is radians clockwise from north (0 north, +π/2 east). `wind.from` uses the same convention and is the direction the wind blows **from**.
- `speed` is m/s along the bow; negative means sternway.
- A crew member's own `x`/`z`/`yaw` stay the original personal deck coordinates on the classic ship location. Deck bows: small ship +x (`DECK_BOW.small = π/2`), galleon +z (`π`); `voyage.js deckToSea(vessel, x, z)` places a deck point at sea.

### State event

A private gameEvent `{kind:'sailing.state', silent:true, full, at, seq, role, helm, vessel, wind, nearby, ports}`. Every event is a complete snapshot of the vessel. `full:true` also carries every port and `dockRange`/`dockSpeed`; periodic events carry the nearest 12 ports. `seq` increases per player within one server session.

It is sent at 4 Hz while under way and 1 Hz at anchor or docked, after every sailing action, and in full on boarding, launching, docking and `sailing.sync`. Ashore, `sailing.sync` answers `{vessel:null, role:null, own, ownsShip, port, ports, coast}`, where `own` is the player's own vessel wherever it lies and `port` is this town's harbour or null.

- `role`: `'captain'` (owner), `'helm'` (holds the helm, not owner), `'passenger'`; `null` ashore. `helm` is true when this player holds the helm.
- `vessel`: `{id, ownerId, ownerName, type:'small'|'large', name, x, z, yaw, speed, anchored, grounded, docked:portId|null, sunk, sails:0|0.5|1, oars:-1|0|1, rudder:-1..1, helmId, helmName, crew:[{id,name}], hull:{hp,max}, length, deck, pointOfSail, classicPower, naval:{}}`.
- `wind`: `{from, speed}`.
- `nearby`: other vessels within 3 km `{id, kind:'player', type, name, ownerName, x, z, yaw, speed, anchored, docked, distance}`, plus entries from the naval owner's `services.naval.project(vessel, viewer)`.
- `ports`: `{id, name, region, x, z, yaw, charted, distance}`, real coast ports only. coast.js charts harbours on demand. An uncharted port town is listed at its map pixel's centre with `charted:false` and `yaw:null`. Harbours within 8 km of a vessel, and the town a captain stands in, are charted ahead of need.
- `vessel.timeScale`: open-sea time compression (coast.js `SEA_COMPRESSION`, 60×). It applies only beyond 1.6 km of every berth with no other vessel or naval contact within 1.5 km. Speeds stay physical and distance runs faster. A compressed stride never crosses land.

Plain-text notices arrive as `{kind:'sailing', text, grounded?, wrecked?}`.

### Actions

Every action accepts an optional `requestId` (`[\w-]{6,64}`); a repeated id is refused with "That was already done." Refusals are the normal `{ok:false, error}`.

| Verb | Args | Who / where |
| --- | --- | --- |
| `sailing.sync` | `{}` | anyone; full snapshot |
| `sailing.board` | `{vesselId?}` | Owner without `vesselId`: boards their own ship at the port where she lies, creating her at the berth the first time. With `vesselId`: a party member of the online captain at the port where she is docked. "At the port" means standing in the port town, or within 120 m of its quay. |
| `sailing.launch` | `{}` | captain; boards if needed, casts off from the berth and takes the helm |
| `sailing.leave` | `{}` | anyone aboard while docked. Goes ashore where they boarded if that was this port's town, else on the port's quay. The quay is in the town when it lies inside the town's block grid, else in the quay's own wilderness pixel. |
| `sailing.helm` | `{take:true}` / `{take:false}` / `{give:playerId}` | the captain takes or gives; the holder releases |
| `sailing.control` | `{sails?:0\|0.5\|1, oars?:-1\|0\|1, rudder?:-1..1}` | helm holder; send on change |
| `sailing.anchor` | `{down:bool}` | helm holder, not while docked |
| `sailing.course` | `{portId\|null}` | helm holder, at sea with the anchor up. Plots a coast-routed course to a charted port: she sails, comes in and makes fast herself. Any control or anchor order from the helm takes over. Grounding, a hostile or sinking contact within 1 km, or a fight aboard breaks it off. `null` clears it. Shown as `vessel.course {to, name, routed, points}`. |
| `sailing.dock` | `{}` | helm holder, within `dockRange` (160 m) of a berth at no more than `dockSpeed` (1.6 m/s) |

Buying a ship stays `ship.buy` at a port bank (server/rpg/property.js). The cargo hold stays `property.store` / `property.take` with `container:'ship'`; aboard a launched vessel only her owner reaches it. Fast travel is refused aboard.

Party membership governs boarding another owner's ship. `sailing.chart` privately returns the port index and coast outlines, or a route from a berth to a selected port. `sailing.course {portId}` steers a crewed vessel and `sailing.course {portId:null}` returns to manual control. Shipyard, naval combat and Admiralty actions share the vessel's identity.

## Reference attribution

Sailing and naval rules adapted from the public DFO edition are credited to Lattymoy. The copyright and permission notice accompanies this project. [MIT license](sailing-reference-license.txt)

### Charters (server/rpg/passage.js)

`services.sailing` also carries ownerless NPC vessels for booked passage. Call these inside an action (or `ctx.runAtomic`) so they roll back with it:

- `charter({fromPortId, toPortId, type, name, master, record})` returns a vessel (`id` `vc-…`, `ownerId:null`, `ownerName:master`) made fast at the origin berth. `record` is persisted verbatim as `vessel.charter`, up to 4 KB.
- `embark(p, v)` puts p aboard as a passenger and adds p to `charter.passengerIds`. Only these passengers may `sailing.board {vesselId}` her, for example when rejoining.
- `setCourse(v, portId)` requests a water route and returns its distance and estimated travel time when available. The pilot waits for the route, follows its waypoints, approaches under reduced power and makes fast at the berth. A charter keeps sailing while every passenger is offline.
- `disembark(p, v)` puts p ashore at her docked port's quay.
- `retire(v)` removes a charter with nobody aboard. An offline passenger who reconnects later lands at the port where she was retired.

Events, shared with owned vessels: `sailingLaunched {vessel, port, player}`, `sailingDocked {vessel, port, player}` (player is null for a charter), and `sailingAboardChanged {player, vessel|null}`. In `nearby`, charters are listed with `kind:'charter'`.
