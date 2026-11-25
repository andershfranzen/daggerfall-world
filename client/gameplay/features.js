import { install as character } from './character.js';
import { install as inventory } from './inventory.js';
import { install as collision } from './collision.js';
import { install as travel } from './travel.js';
import { install as law } from './law.js';
import { install as interiors } from './interiors.js';
import { install as automap } from './automap.js';
import { install as actors } from './actors.js';
import { install as npcs } from './npcs.js';
import { install as townServices } from './townServices.js';
import { install as alchemy } from './alchemy.js';
import { install as shop } from './shop.js';
import { install as weapons } from './weapons.js';
import { install as arrows } from './arrows.js';
import { install as magic } from './magic.js';
import { install as quests } from './quests.js';
import { install as social } from './social.js';
import { install as guilds } from './guilds.js';
import { install as atmosphere } from './atmosphere.js';
import { install as scenery } from './scenery.js';
import { install as water } from './water.js';
import { install as wilderness } from './wilderness.js';
import { install as wildernessMap } from './wildernessMap.js';
import { install as mount } from './mount.js';
import { install as property } from './property.js';
import { install as sailing } from './sailing.js';
import { install as journey } from './journey.js';
import { install as conditions } from './conditions.js';
import { install as cinematics } from './cinematics.js';

export const features = [
  { name: 'character', install: character },
  { name: 'inventory', install: inventory },
  { name: 'collision', install: collision },
  { name: 'travel', install: travel },
  { name: 'law', install: law }, // before interiors/npcs: Steal mode handles G first
  { name: 'shop', install: shop }, // shop shelves (G at a shelf), before interiors so a shelf beats a door behind it
  { name: 'interiors', install: interiors },
  { name: 'automap', install: automap },
  { name: 'actors', install: actors },
  { name: 'npcs', install: npcs },
  { name: 'townServices', install: townServices },
  { name: 'alchemy', install: alchemy }, // Potion Maker, Item Maker, identify, magic merchants (package 16)
  { name: 'weapons', install: weapons },
  { name: 'arrows', install: arrows },
  { name: 'magic', install: magic },
  { name: 'quests', install: quests },
  { name: 'social', install: social },
  { name: 'guilds', install: guilds },
  { name: 'atmosphere', install: atmosphere },
  { name: 'scenery', install: scenery },
  { name: 'water', install: water }, // dungeon water sheets, after collision (package 21)
  { name: 'wilderness', install: wilderness },
  { name: 'wildernessMap', install: wildernessMap },
  { name: 'mount', install: mount },
  { name: 'property', install: property }, // loans, houses, ships, wagon (package 13)
  { name: 'sailing', install: sailing },
  { name: 'journey', install: journey },
  { name: 'conditions', install: conditions }, // Health panel (package 10)
  { name: 'cinematics', install: cinematics },
];

export default features;
