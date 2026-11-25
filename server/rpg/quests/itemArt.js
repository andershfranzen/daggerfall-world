// Classic template addresses from Daggerfall Unity's ItemTemplates.txt and ItemEnums.cs
// (MIT, Daggerfall Workshop). Quest resources without a defined subtype use a real
// original item of the requested class. All pixels come from the player's archives.
import { BASES, describeTemplate, resolveTemplate } from '../inventory.js';
import { ITEM_CLASSES } from './tables.js';

// [archive, record] pairs for the virtual items the quest engine can carry or place.
// The first pair is used for class-only resources. Specific QBN subtypes follow it.
const QUEST_TEXTURES = {
  0: [[254, 47]],                                  // Indulcet
  1: [[205, 3], { 1: [205, 11] }],                  // glass jar, potion
  4: [[216, 4]],                                   // magic ring
  7: [[209, 2]],                                   // books share the closed-book art
  9: [[209, 8], { 0: [210, 6], 4: [210, 3] }],      // parchment, torch, candle
  10: [[254, 56], { 4: [211, 49] }],                // prayer beads, holy water
  11: [[209, 8]],                                  // map
  13: [[211, 57]],                                 // painting
  14: [[254, 0], [[254, 0], [254, 1], [254, 2], [254, 3], [254, 4], [254, 5], [254, 7], [254, 8]]],
  15: [[254, 20]],                                  // berries
  16: [[254, 9]],                                   // twigs
  17: [[206, 34], { 12: [254, 51] }],               // werewolf's blood, Daedra's heart
  18: [[254, 48]],                                  // dragon's scales
  19: [[254, 42]],                                  // wereboar's tusk
  20: [[254, 56], { 6: [254, 52] }],                 // holy relic, elixir vitae
  21: [[254, 61], { 9: [254, 62] }],                 // mercury, gold ore
  22: [[254, 70], { 1: [254, 6] }],                  // ivory, pearl
  23: [[213, 1]],                                   // cart
  24: [[209, 8]],                                   // deed
  25: [[254, 56], { 2: [216, 4] }],                  // amulet, ring
  26: [[208, 4], { 5: [380, 1] }],                   // telescope, dead body
};

const equivalent = { 2: 'leather-cuirass', 3: 'iron-longsword', 6: 'short-shirt', 12: 'short-shirt' };

export function questItemArt(item, resource) {
  if (item.gold || item.className === 'gold') return { template: 'gold' };
  const classic = resource?.classicItem ?? ITEM_CLASSES.get(item.className);
  const group = classic?.group;
  const template = resolveTemplate(item.template)?.key ?? equivalent[group];
  if (template) {
    const { icon, world } = describeTemplate(template);
    if (group !== 6 && group !== 12) return { icon, world };
    const garment = group === 6 ? { ...icon, female: null } : { ...icon, male: null };
    return { icon: garment, world };
  }
  const pair = QUEST_TEXTURES[group];
  if (!pair) return null;
  const [archive, record] = pair[1]?.[classic.index] ?? pair[0];
  const world = { archive, record };
  return { world };
}

/** Fixed QBN subclasses identify a specific catalogue item, when present. */
export function exactQuestTemplate(classic) {
  const ranges = { 2: [102, 112], 3: [113, 131], 14: [0, 7], 22: [76, 77] };
  const range = ranges[classic?.group];
  if (!range || !Number.isInteger(classic.index) || classic.index < 0) return null;
  const [first, last] = range;
  const index = first + classic.index;
  if (index > last) return null;
  return Object.entries(BASES).find(([, b]) => b.index === index)?.[0] ?? null;
}
