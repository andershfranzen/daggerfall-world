import { install as worldData } from './wilderness/replacements.js';
import { install as character } from './character.js';
import { install as inventory } from './inventory.js';
import { install as alchemy } from './alchemy.js';
import { install as collision } from './collision.js';
import { install as travel } from './travel.js';
import { install as interiors } from './interiors.js';
import { install as smallerDungeons } from './interiors/smaller-dungeons.js';
import { install as dungeonInstances } from './interiors/instances.js';
import { install as containers } from './containers.js';
import { install as npcs } from './npcs.js';
import { install as guilds } from './guilds.js';
import { install as guildhall } from './guildhall.js';
import { install as townServices } from './townServices.js';
import { install as economy } from './economy.js';
import { install as combat } from './combat.js';
import { install as magic } from './magic.js';
import { install as mods } from './mods.js';
import { install as quests } from './quests.js';
import { install as special } from './special.js';
import { install as social } from './social.js';
import { install as partyQuests } from './quests/party-quests.js';
import { install as questRepair } from './quests/repair.js';
import { install as delves } from './delves.js';
import { install as atmosphere } from './atmosphere.js';
import { install as calendar } from './calendar.js';
import { install as conditions } from './conditions.js';
import { install as wilderness } from './wilderness.js';
import { install as overland } from './overland.js';
import { install as mount } from './mount.js';
import { install as property } from './property.js';
import { install as professions } from './professions.js';
import { install as homes } from './homes.js';
import { install as market } from './market.js';
import { install as locomotion } from './locomotion.js';
import { install as peers } from './peers.js';
import { install as law } from './law.js';
import { install as pvp } from './pvp.js';
import { install as automap } from './automap.js';
import { install as sailing } from './sailing.js';
import { install as shipyard } from './shipyard.js';
import { install as naval } from './naval.js';
import { install as passage } from './passage.js';
import { install as admiralty } from './admiralty.js';
import { install as seaBounties } from './sailing/bounties.js';
import { install as livingWorld } from './living-world.js';
import { install as survival } from './survival.js';
import { install as optionalRules } from './optional-rules.js';
import { install as chronicles } from './chronicles.js';

export const features = [
  { name: 'worldData', install: worldData },
  { name: 'character', install: character },
  { name: 'inventory', install: inventory },
  { name: 'alchemy', install: alchemy }, // right after inventory: wraps giveItem/countItem/findItem for artifacts (package 16)
  { name: 'collision', install: collision },
  { name: 'travel', install: travel },
  { name: 'interiors', install: interiors },
  { name: 'smallerDungeons', install: smallerDungeons }, // DFU deterministic 5-block layouts (after interiors)
  { name: 'dungeonInstances', install: dungeonInstances }, // public/personal/party instances (after smallerDungeons)
  { name: 'containers', install: containers }, // shared treasure, furniture, bookshelves (package 7)
  { name: 'npcs', install: npcs },
  { name: 'guilds', install: guilds }, // after npcs: per-hall guildRank, any-faction reputation (package 15)
  { name: 'guildhall', install: guildhall }, // classic guild overview/chat/resign + player-founded orders, halls & item vaults
  { name: 'townServices', install: townServices },
  { name: 'economy', install: economy }, // shop shelves, regional prices (after npcs: uses services.shopLedger)
  { name: 'combat', install: combat },
  { name: 'magic', install: magic },
  { name: 'mods', install: mods }, // operator mod & versioned quest-pack registry (before quests)
  { name: 'quests', install: quests },
  { name: 'special', install: special }, // Daedra summoning, secret invitations, cure/clan quest triggers (package 19)
  { name: 'social', install: social }, // party, trade, persistent friends, directed blocks, mailbox & group travel
  { name: 'partyQuests', install: partyQuests }, // co-op party quests (after quests, social, smallerDungeons, combat)
  { name: 'questRepair', install: questRepair }, // quest target/item/layout repair (after quests, partyQuests, inventory)
  { name: 'delves', install: delves }, // repeatable group PvE delves (after combat, inventory, containers)
  { name: 'atmosphere', install: atmosphere },
  { name: 'calendar', install: calendar }, // holidays, personal time, rest/travel legality (docs/calendar-rest-protocol.md)
  { name: 'conditions', install: conditions }, // after atmosphere/combat/magic: clocks, rest blockers, damage
  { name: 'wilderness', install: wilderness },
  { name: 'overland', install: overland },
  { name: 'mount', install: mount },
  { name: 'property', install: property }, // after townServices and travel: loans, houses, ships, wagon
  { name: 'professions', install: professions }, // gathering nodes, crafting stations, daily writs (after inventory/alchemy/combat)
  { name: 'homes', install: homes }, // personal homes, furnishing, guest access & chests (after property/social/professions)
  { name: 'market', install: market }, // fixed-price boards, auctions, buy orders, house traders & claims (after homes/professions)
  { name: 'locomotion', install: locomotion }, // modifiers and consequences for collision.stepPlayer
  { name: 'peers', install: peers }, // after overland: projects nearby players across outdoor boundaries
  { name: 'law', install: law }, // crimes use npcs, combat, interiors, inventory and the clock
  { name: 'pvp', install: pvp }, // unified Land PvP (duels, arena, open district, order sieges; after combat/magic/law/guildhall/social)
  { name: 'automap', install: automap }, // exploration memory, learned names, map notes and notebook
  { name: 'sailing', install: sailing },
  { name: 'shipyard', install: shipyard },
  { name: 'naval', install: naval },
  { name: 'passage', install: passage },
  { name: 'admiralty', install: admiralty },
  { name: 'seaBounties', install: seaBounties }, // player-funded sea bounties (after naval & admiralty)
  { name: 'livingWorld', install: livingWorld }, // scheduled residents, caravan route & persistent follower
  { name: 'survival', install: survival }, // optional survival ruleset (after calendar & conditions)
  { name: 'optionalRules', install: optionalRules }, // DFU optional rules, quest debugger, renown, wardrobe & succession
  { name: 'chronicles', install: chronicles }, // Chronicles of the Iliac Bay (Hiscores stats, milestones & WS queries)
];

export default features;
