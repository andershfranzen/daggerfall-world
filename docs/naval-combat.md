# Naval combat

`server/rpg/naval.js` runs ship combat on the server. The rules live in `server/rpg/sailing/combatRules.js`. They are adapted from Daggerfall Online's naval systems (MIT, © 2026 Lattymoy, public snapshot `a3eb1605`), and the module header lists the source files. No reference art, text or audio is used. Tests are in `test/rpg-naval.test.mjs`.

## Frame and ownership

World x points east and z points south. y is up, sea level is 0, and units are metres. Yaw 0 points north, and the heading is `(sin yaw, −cos yaw)`. The ship frame is x to starboard, y up and z forward. Times on events are server seconds (`ctx.now()/1000`).

The sailing core (`server/rpg/sailing.js`) owns vessels, helm, wind and movement. Naval owns these:

- the gun deck of each vessel, its damage and its colours, stored in `vessel.naval`;
- the hull points, mirrored into the core's canonical `vessel.hull.hp`;
- every ball and barrel in flight;
- NPC ships;
- grapples, boarding and prizes.

When `services.shipyard.shipOfVessel(v)` resolves, the shipyard record supplies the gun count and the sail and crew maxima. Its `stores.shot` is the ammunition, spent through `spend`. Hull and canvas losses go to `damage`, and fallen men are removed with `loseCrew`. With the shipyard installed, a player-against-player prize is trade goods only, moved with `transferCargo`. The classic item hold (`property.stores.ship`) is never touched then. `naval.repair` uses the carpenter's timber at sea through `seaRepair`, adding 25 hull per timber. Shot is bought at the shipyard (`shipyard.supply`), so `naval.restock` refuses for yard ships.

Every naval action requires `sailing.aboard(p)`. An owner whose ship is berthed while they are ashore cannot fight and receives no naval events.

## Mechanics (reference numbers)

- **Guns:** long, swivel, heavy, chain and barrel. Each has its own muzzle speed, elevation limits, scatter, reload and per-ball harm. A volley ripples down the side at 0.09 s per gun. Each ball is a closed-form launch, `p(t) = p0 + v0·t − ½·9.81·t²` on y, laid by elevation-for-range. Scatter is a seeded triangular spread.
- **Shot kinds:** round, grape, chain and heated, loaded per group (broadside, bow or stern). Changing the load of a loaded battery redraws it and costs half the new load's reload. Grape kills men, and its effect falls off after 1.2 s of flight. Chain shreds canvas. Heated shot sets fires.
- **Reload:** a full crew takes the gun's own reload time. A thinned crew takes up to 80% longer. Bracing halves the harm taken but stops the guns and the reload. Each gun fired spends one shot. The shipyard's `stores.shot` is used when present, otherwise `vessel.naval.shot`.
- **Hits:** a ball's segment is tested each tick against every hull box and rig box. A hull hit within 1.1 m of the waterline holes her, for +40%. A rig hit tears canvas and the ball flies on. Lost canvas cuts her way under sail; on bare poles she keeps 35%. Fires burn 1.4 hull points per second for 15 s, up to three at once, and also take canvas and crew. Hull and canvas points are 1.6× the base build. A player's crew counts double against losses.
- **States:** an NPC ship strikes her colours at 25% hull or when her crew is gone. At 0 hull a ship sinks over 22 s. A sunk player ship is handed to `sailing.wreck`, which tows her to port and puts her crew ashore.
- **Ramming:** stem contact closing at 1.6 m/s or more takes 15% of the lesser hull, or 30% for a galley's ram. A ram into the bow or stern does 40% of that. The rammer takes recoil. A ram never takes a ship below her struck line. When the sailing core stops a vessel short of another hull (`sailingCollision`), that counts as a ram, once per cooldown. NPC rows carry `type:'small'|'large'`, which the core uses to size them as obstacles. NPC ships are placed only where `sailing.isWater` returns true.
- **NPC ships:** merchant, raider and patrol classes, with each class's speed, turn rate, skill and fighting range. Merchants trade between ports and follow the chart's sea lanes (`coast.route`), and they flee from attackers. Pirates hunt player ships outside harbours, and they grapple a crippled ship and send a repel party aboard. Navy patrols hunt pirates, and they turn on anyone who strikes a lawful ship within 650 m of them. The director rolls every 30 s for each vessel at sea, with an 80% chance of a spawn. NPCs spawn 450 to 990 m out and despawn beyond 1900 m. Fewer pirates appear near ports.
- **Boarding:** grappling needs a struck target with at most 32 m of water between the hulls. The muster uses DFU MobileTypes for each faction: a captain and her men, between 3 and 12 of them, scaled by the crew left. They are spawned through `services.createEnemy` on the boarder's deck as ordinary melee foes, with `visibleTo` set to the boarding crew. The raid is won when the captain and 70% of the muster are down, or the whole muster. A retreat cuts the grapples and dismisses the muster. Drifting more than 160 m apart abandons the boarding.
- **Plunder:** an NPC prize's hold is drawn from DFU loot matrix keys for her faction, and a flagship gets a strongbox. It goes straight into the plunderer's pack once, and she is scuttled 30 s later. If the pack refuses, the whole action rolls back.
- **Law:** a first strike on a lawful ship emits `naval.lawful`. Without `services.seaLaw`, naval reports `piracy` to the law feature.

## Player against player

Two player ships can harm each other only when both fly hostile colours, neither is within 600 m of a port, and they have different owners. Otherwise the target refuses the gunner, and blind balls pass through her harmlessly. You cannot lower fighting colours within 30 s of being hit, but you can surrender at any time.

When a hostile captain sinks another, the sinking captain's vessel records the wreck. Within 10 minutes and 160 m of the wreck, the killer may haul up her hold once. The prize is the most valuable pieces up to a third of the hold's worth: the best piece always, and at most 8 pieces. A surrendered captain gives her hold the same way to the captain grappled alongside. The loser's hold and the winner's hold, or the winner's pack, change in one transaction. Both accounts are told what moved. The loser must be online, and no event carries anyone's hold.

## Wire

Every event is a private `gameEvent` with `silent: true` and `t`.

- `naval.state {self, contacts, projectiles}` is sent to the crew aboard, 2 times a second while busy and on change. `self` is the public view plus `ready{side: seconds}`, `loads`, `guns{side:{gun,count,range}}`, `braced`, `ammo{shot,barrels}`, `safeHarbour`, `wayShare`, `boarding?`, `repel?` and `wreck?`.
- The public ship view is:
  `{id, kind:'npc'|'player', classId, title, faction, hull, type, x, z, yaw, speed, hullHp, maxHull, sailHp, maxSail, crew, maxCrew, state:'afloat'|'struck'|'sinking'|'wrecked'|'boarded', fire, colours:'peace'|'hostile'|'struck', ownerId?, name?, flagship?, grappledTo?, plundered?}`
- `naval.shot {volleyId, from:{id,kind}, side, gun, shot, g, balls:[{id,p0,v0,t0,kind}]}` goes to every crew within 1500 m. A barrel has `kind:'barrel'` and floats at `p0`.
- `naval.hit {ballId, volleyId, target:{id,kind}|null, zone:'hull'|'holed'|'rig'|'water', point, damage, fire, view}`
- `naval.ram {rammerId, targetId, point, side, closing, damage, recoil, men, view, rammerView}`
- `naval.news {what, shipId, text}`. The values of `what` are `sighted`, `engage`, `struck`, `sinking`, `sunk`, `wrecked`, `respawn`, `colours`, `surrender`, `grapple`, `boardStart`, `boardWon`, `boardEnd`, `retreat`, `repel` and `plunder`.
- Player-readable results arrive as `{kind:'naval', text}`.

Actions:

- `naval.sync`
- `naval.load {group, shot}`
- `naval.fire {side, targetId?, range?}`
- `naval.brace {on}`
- `naval.colours {hostile}`
- `naval.surrender`
- `naval.grapple {targetId}`
- `naval.board {targetId}`
- `naval.retreat`
- `naval.plunder {targetId}`
- `naval.repair`: at sea, one timber
- `naval.restock {count?}`: in port, only when the shipyard does not own the stores

Every refusal is a readable action error.

Services on `services.naval`:

- `actors()`, `shipView(x)`, `combatOf(v)`
- `wayShare(v)`: multiplies the core's sail way; 0 while grappled or sinking
- `helmBlocked(v)`: returns a reason string or null
- `project(v)`: NPC rows for the `nearby` list in `sailing.state`
- `nearbyFor(v)`, `projectiles(near)`
- `damage(v, harm, kind)`: outside harm

In-process events through `ctx.emit` are `naval.fire`, `naval.lawful`, `naval.struck`, `naval.sunk`, `naval.boarded`, `naval.repelled`, `naval.plundered` and `naval.wrecked`. Each carries:

- `player`: the commanding captain, which is the firer, or the owner or helmsman aboard;
- `vessel`: the acting vessel's id;
- `target`: a public view with a lasting `uid`, `x`, `z`, `faction`, `classId`, `hull`, `ownerId?` and `quarry?`.

The admiralty (`services.admiralty`, also known as `seaLaw`) owns the piracy crime, notoriety and rewards. Navy patrols engage a player when `services.admiralty.hostileTo(p, view)` is true, or when they witness a strike on a lawful ship. `services.naval.spawnQuarry({key, classId, x, z, name})` returns one actor per key. It never despawns by distance, and once sunk it never returns while the server runs.
