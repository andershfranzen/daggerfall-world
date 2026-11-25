import { install as worldData } from './wilderness/replacements.js';
import { install as character } from './character.js';
import { install as inventory } from './inventory.js';
import { install as alchemy } from './alchemy.js';
import { install as collision } from './collision.js';
import { install as travel } from './travel.js';
import { install as interiors } from './interiors.js';
import { install as containers } from './containers.js';
import { install as npcs } from './npcs.js';
import { install as guilds } from './guilds.js';
import { install as guildhall } from './guildhall.js';
import { install as townServices } from './townServices.js';
import { install as economy } from './economy.js';
import { install as combat } from './combat.js';
import { install as magic } from './magic.js';
import { install as quests } from './quests.js';
import { install as special } from './special.js';
import { install as social } from './social.js';
import { install as atmosphere } from './atmosphere.js';
import { install as calendar } from './calendar.js';
import { install as conditions } from './conditions.js';
import { install as wilderness } from './wilderness.js';
import { install as overland } from './overland.js';
import { install as mount } from './mount.js';
import { install as property } from './property.js';
import { install as peers } from './peers.js';
import { install as law } from './law.js';
import { install as automap } from './automap.js';
import { install as locomotion } from './locomotion.js';
import { install as sailing } from './sailing.js';
import { install as shipyard } from './shipyard.js';
import { install as naval } from './naval.js';
import { install as passage } from './passage.js';
import { install as admiralty } from './admiralty.js';
import { install as chronicles } from './chronicles.js';

export const features = [
  { name: 'worldData', install: worldData },
  { name: 'character', install: character },
  { name: 'inventory', install: inventory },
  { name: 'alchemy', install: alchemy }, // right after inventory: wraps giveItem/countItem/findItem for artifacts (package 16)
  { name: 'collision', install: collision },
  { name: 'travel', install: travel },
  { name: 'interiors', install: interiors },
  { name: 'containers', install: containers }, // shared treasure, furniture, bookshelves (package 7)
  { name: 'npcs', install: npcs },
  { name: 'guilds', install: guilds }, // after npcs: per-hall guildRank, any-faction reputation (package 15)
  { name: 'guildhall', install: guildhall }, // classic guild overview/chat/resign + player-founded orders
  { name: 'townServices', install: townServices },
  { name: 'economy', install: economy }, // shop shelves, regional prices (after npcs: uses services.shopLedger)
  { name: 'combat', install: combat },
  { name: 'magic', install: magic },
  { name: 'quests', install: quests },
  { name: 'special', install: special }, // Daedra summoning, secret invitations, cure/clan quest triggers (package 19)
  { name: 'social', install: social },
  { name: 'atmosphere', install: atmosphere },
  { name: 'calendar', install: calendar }, // holidays, personal time, rest/travel legality (docs/calendar-rest-protocol.md)
  { name: 'conditions', install: conditions }, // after atmosphere/combat/magic: clocks, rest blockers, damage
  { name: 'wilderness', install: wilderness },
  { name: 'overland', install: overland },
  { name: 'mount', install: mount },
  { name: 'property', install: property }, // after townServices and travel: loans, houses, ships, wagon
  { name: 'locomotion', install: locomotion }, // modifiers and consequences for collision.stepPlayer
  { name: 'peers', install: peers }, // after overland: projects nearby players across outdoor boundaries
  { name: 'law', install: law }, // last: crimes use npcs, combat, interiors, inventory and the clock
  { name: 'automap', install: automap }, // exploration memory, learned names, map notes and notebook
  { name: 'sailing', install: sailing },
  { name: 'shipyard', install: shipyard },
  { name: 'naval', install: naval },
  { name: 'passage', install: passage },
  { name: 'admiralty', install: admiralty },
  { name: 'chronicles', install: chronicles }, // Chronicles of the Iliac Bay (Hiscores stats, milestones & WS queries)
];

export default features;
