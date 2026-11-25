// The inventory identity a QBN item resource rolls once, at quest creation, following Daggerfall Unity
// Questing/Item.cs CreateItem(itemClass, itemSubClass) at revision 3d85a283 (MIT, Daggerfall Workshop):
//   MagicItems (4)          ItemBuilder.CreateRegularMagicItem(subclass): MAGIC.DEF regular item, -1 = random
//   Books (7)               ItemBuilder.CreateRandomBook()
//   UselessItems1 (1), 1    ItemBuilder.CreateRandomPotion()
//   anything else           new DaggerfallUnityItem(group, subclass), -1 = random index of the group's enum
// ItemHelper.GetItemTemplate logs "Item index out of range" for a subclass past the group's enum and builds an empty
// template (O0B60Y18's parcel is UselessItems1 #16 of 11), so such a record keeps no inventory item here: it stays a
// journal quest item. Letters (9/5) are quest parchment with their own text and are not inventory templates here.
import { BASES, resolveTemplate, templateForClassic, classicGroupTemplates } from '../inventory.js';
import { GROUPS as CLASSIC_GROUPS } from '../items/classicTemplates.js';
import { randomBook } from '../items/loot.js';

const GROUP_BY_ID = new Map(Object.entries(CLASSIC_GROUPS).map(([name, g]) => [g.id, { name, size: g.members.length }]));
const LETTER = { group: 9, index: 5 };

/** Armour and weapon subclasses map to the hand-made catalogue (iron/leather, as before this module). */
function armsTemplate(cls, random) {
  const ranges = { 2: [102, 112], 3: [113, 131] };
  const [first, last] = ranges[cls.group];
  if (cls.index >= 0) {
    const index = first + cls.index;
    if (index > last) return null;
    const key = Object.entries(BASES).find(([, b]) => b.index === index)?.[0];
    return key ? resolveTemplate(key)?.key ?? null : null;
  }
  const group = cls.group === 2 ? 'armor' : 'weapon';
  const pool = Object.entries(BASES).filter(([, b]) => b.group === group).map(([k]) => k);
  return pool.length ? resolveTemplate(pool[Math.floor(random() * pool.length)])?.key ?? null : null;
}

/**
 * @param {{group:number,index:number}|null} cls  QBN item class/subclass (catalogue `classicItem` or Quests-Items row)
 * @param {() => number} random                    the quest instance's seeded generator
 * @param {{magicItem?:(random, chosen)=>?{template,extra?}, potion?:(random)=>?{template}, books?:object}} [svc]
 * @returns {{template:string, appearance?:{variant?:number, extra?:object}}|null}
 */
export function questItemIdentity(cls, random, svc = {}) {
  if (!cls || !Number.isInteger(cls.group)) return null;
  const { group } = cls;
  const index = Number.isInteger(cls.index) ? cls.index : -1;
  if (group === LETTER.group && index === LETTER.index) return null;
  if (group === 4) {
    const m = svc.magicItem?.(random, index >= 0 ? index : null);
    return m?.template ? { template: m.template, ...(m.extra ? { appearance: { extra: m.extra } } : {}) } : null;
  }
  if (group === 7) {
    const b = randomBook(svc.books, random);
    return b ? { template: b.template, appearance: { variant: b.variant, extra: b.extra } } : null;
  }
  if (group === 1 && index === 1) {
    const potion = svc.potion?.(random);
    if (potion?.template) return { template: potion.template };
    const pool = Object.entries(BASES).filter(([, b]) => b.group === 'potion').map(([k]) => k);
    return pool.length ? { template: pool[Math.floor(random() * pool.length)] } : null;
  }
  if (group === 2 || group === 3) {
    const template = armsTemplate({ group, index }, random);
    return template ? { template } : null;
  }
  const g = GROUP_BY_ID.get(group);
  if (!g) return null; // clothing, transport, deeds, furniture: no classic group table installed
  if (index >= g.size) return null; // GetItemTemplate: index out of range
  const at = index >= 0 ? index : Math.floor(random() * g.size);
  const template = templateForClassic(group, at);
  return template ? { template } : null;
}

/** Every template a class can roll (for checks and tests); null when the class has no inventory identity. */
export function questClassTemplates(cls) {
  const g = GROUP_BY_ID.get(cls?.group);
  if (!g) return null;
  if (cls.index >= 0) return cls.index < g.size ? [templateForClassic(cls.group, cls.index)].filter(Boolean) : [];
  return classicGroupTemplates(g.name);
}

/**
 * Fallback inventory template for `make _item_ permanent` (0x36) when a quest item has no rolled template
 * (older saves, missing magic loot service, clothing, deeds, out-of-range subclasses, or custom script classes).
 */
const PERMANENT_FALLBACK_TEMPLATES = Object.freeze({
  religious: 'religious-item',
  trinket: 'amulet',
  amulet: 'amulet',
  ring: 'ring',
  magic_item: 'ring',
  drug: 'indulcet',
  small_plant: 'red-flowers',
  large_plant: 'pine-branch',
  organs: 'trolls-blood',
  skin: 'mummy-wrappings',
  mythic: 'unicorn-horn',
  misc: 'holy-relic',
  element: 'mercury',
  mineral: 'ivory',
  gem: 'ruby',
  junk: 'glass-jar',
  potion: 'potion-of-healing',
  book: 'book',
  letter: 'parchment',
  map: 'map',
  painting: 'painting',
  mens_clothing: 'short-shirt',
  womens_clothing: 'long-skirt',
  transport: 'small-cart',
  deed: 'house-deed',
  specials: 'telescope',
  armor: 'leather-cuirass',
  weapon: 'iron-dagger',
});

/**
 * Base inventory template for a template-less non-gold, non-artifact quest item made permanent: an ordinary record of
 * the class's stand-in template. The quest item's own name is not carried over. No `quest` extra: that marks a quest
 * item (untradeable, unstorable), which a permanent item no longer is.
 */
export function permanentFallbackItem(item) {
  if (!item || item.gold || item.className === 'gold' || item.className === 'artifact') return null;
  const cls = String(item.className ?? 'misc').toLowerCase();
  const resolved = resolveTemplate(PERMANENT_FALLBACK_TEMPLATES[cls] ?? 'glass-jar') ?? resolveTemplate('glass-jar');
  return resolved ? { template: resolved.key } : null;
}
