// Classic potion recipes (Potion Maker, potion merchants and loot).
//
// Transcribed from Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop): the PotionRecipe
// definitions in Assets/Scripts/Game/MagicAndEffects/Effects/**.cs (ingredient template indices,
// price, effect settings, texture record) and PotionRecipe.classicRecipeKeys. Numbers only; item
// names are the operator's ItemTemplates names as registered by the inventory feature.
//
// Ingredient values are classic ItemTemplates indices (Items.*Ingredients* enums):
//   8 twigs, 9 green leaves, 10 red flowers, 11 yellow flowers, 14 pine branch, 16 red berries,
//   19 red rose, 20 yellow rose, 21 black rose, 22 white rose, 24 black poppy, 25 golden poppy,
//   26 white poppy, 27 ginkgo leaves, 28 bamboo, 29 palm, 30 aloe, 31 fig, 32 cactus, 33 werewolf's
//   blood, 35 fairy dragon scales, 37 unicorn horn, 39 ectoplasm, 41 spider venom, 42 troll's blood,
//   43 snake venom, 47 giant scorpion stinger, 49 mummy wrappings, 54 saint's hair, 56 big tooth,
//   58 small tooth, 59 pure water, 60 rain water, 61 orc's blood, 62 elixir vitae, 63 nectar,
//   64 ichor, 65 mercury, 68 lodestone, 69 sulphur, 71 iron, 73 silver, 76 ivory, 77 pearl,
//   gems 3 diamond, 5 turquoise, 6 malachite, 7 amber.

/**
 * effect: what drinking does.
 *   pool  — restore health/fatigue/magicka by magnitude (base + plus × level)
 *   fortify — raise an attribute by magnitude for duration rounds
 *   status — a timed magic status (same names as server/rpg/magic/effects.js)
 *   cure  — removes a condition family
 * mag: [base, plusPerLevel]; dur: [base, plusPerLevel] in magic rounds; chance: [base, plusPerLevel] %.
 * DefaultEffectSettings is duration 1+1/level, chance 1+1/level, magnitude 1+1/level.
 */
export const RECIPES = Object.freeze([
  { key: 'healing', name: 'Healing', template: 'potion-of-healing', price: 50, record: 15, ingredients: [62, 16, 65, 42], effects: [{ kind: 'pool', pool: 'health', mag: [5, 9] }] },
  { key: 'healTrue', name: 'True Healing', price: 100, record: 16, ingredients: [62, 16, 14, 37], effects: [{ kind: 'pool', pool: 'health', mag: [5, 19] }] },
  { key: 'restorePower', name: 'Magicka', template: 'potion-of-magicka', price: 75, record: 12, ingredients: [63, 73, 33, 54], effects: [{ kind: 'pool', pool: 'magicka', mag: [5, 4] }] },
  { key: 'stamina', name: 'Stamina', template: 'potion-of-stamina', price: 25, record: 11, ingredients: [59, 30, 27], effects: [{ kind: 'pool', pool: 'fatigue', mag: [5, 4] }] },
  { key: 'orcStrength', name: 'Orc Strength', price: 50, record: 13, ingredients: [61, 71, 59], effects: [{ kind: 'fortify', key: 'Fortify-Strength', attribute: 'Strength', mag: [1, 14], dur: [1, 1] }] },
  { key: 'cureDisease', name: 'Cure Disease', price: 100, record: 11, ingredients: [62, 31, 56], effects: [{ kind: 'cure', key: 'Cure-Disease', condition: 'disease', chance: [1, 10] }] },
  { key: 'purification', name: 'Purification', price: 500, record: 11, ingredients: [62, 63, 60, 31, 56, 39, 3, 49], effects: [{ kind: 'cure', key: 'Cure-Disease', condition: 'disease', chance: [1, 10] }, { kind: 'pool', pool: 'health', mag: [5, 19] }] },
  { key: 'curePoison', name: 'Cure Poison', price: 200, record: 35, ingredients: [64, 47, 58, 77], effects: [{ kind: 'cure', key: 'Cure-Poison', condition: 'poison', chance: [5, 19] }] },
  { key: 'freeAction', name: 'Free Action', price: 125, record: 14, ingredients: [64, 41, 8, 28], effects: [{ kind: 'status', key: 'FreeAction', status: 'freeAction', dur: [1, 1], chance: [5, 19], cures: ['Paralyze'] }] },
  { key: 'resistFire', name: 'Resist Fire', price: 75, record: 34, ingredients: [64, 7, 10, 35, 32], effects: [{ kind: 'status', key: 'ElementalResistance-Fire', status: 'resistFire', dur: [1, 1], chance: [100, 1] }] },
  { key: 'resistFrost', name: 'Resist Frost', price: 75, record: 34, ingredients: [64, 5, 14, 22], effects: [{ kind: 'status', key: 'ElementalResistance-Frost', status: 'resistFrost', dur: [1, 1], chance: [100, 1] }] },
  { key: 'resistShock', name: 'Resist Shock', price: 75, record: 34, ingredients: [64, 68, 16], effects: [{ kind: 'status', key: 'ElementalResistance-Shock', status: 'resistShock', dur: [1, 1], chance: [100, 1] }] },
  { key: 'resistPoison', name: 'Resist Poison', price: 125, record: 14, ingredients: [64, 43, 25], effects: [{ kind: 'status', key: 'ElementalResistance-Poison', status: 'resistPoison', dur: [1, 1], chance: [5, 19] }] },
  { key: 'slowFalling', name: 'Slow Falling', price: 100, record: 11, ingredients: [59, 26, 24], effects: [{ kind: 'status', key: 'Slowfall', status: 'slowfall', dur: [1, 1] }] },
  { key: 'waterBreathing', name: 'Water Breathing', price: 100, record: 32, ingredients: [60, 62, 76], effects: [{ kind: 'status', key: 'WaterBreathing', status: 'waterBreathing', dur: [1, 1] }] },
  { key: 'chameleonForm', name: 'Chameleon Form', price: 200, record: 33, ingredients: [60, 63, 9, 11, 16], effects: [{ kind: 'status', key: 'Chameleon-Normal', status: 'chameleon', dur: [1, 1] }] },
  { key: 'invisibility', name: 'Invisibility', price: 250, record: 33, ingredients: [60, 63, 39, 3], effects: [{ kind: 'status', key: 'Invisibility-Normal', status: 'invisible', dur: [1, 1] }] },
  { key: 'shadowForm', name: 'Shadow Form', price: 200, record: 33, ingredients: [60, 63, 6, 21], effects: [{ kind: 'status', key: 'Shadow-Normal', status: 'shadow', dur: [1, 1] }] },
  { key: 'levitation', name: 'Levitation', price: 125, record: 11, ingredients: [59, 63, 39], effects: [{ kind: 'status', key: 'Levitate', status: 'levitating', dur: [1, 1] }] },
  { key: 'waterWalking', name: 'Water Walking', price: 50, record: 32, ingredients: [59, 29, 20, 69], effects: [{ kind: 'status', key: 'WaterWalking', status: 'waterWalking', dur: [1, 1] }] },
].map((r) => Object.freeze({
  ...r,
  slug: r.key.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase(),
  template: r.template ?? `potion-of-${r.name.toLowerCase().replace(/[^a-z]+/g, '-')}`,
  recipeTemplate: `recipe-${r.key.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
  ingredients: Object.freeze([...r.ingredients]),
})));

/** C# PotionRecipe.GetHashCode over ingredient ids (the C# class sorts them first; int32 overflow). */
export function recipeHash(ids) {
  let h = 17;
  for (const id of ids) h = (Math.imul(h, 23) + id) | 0;
  return h;
}

/** PotionRecipe.classicRecipeKeys: classic potion typeDependentData index -> recipe hash. */
export const CLASSIC_RECIPE_KEYS = Object.freeze([221871, 239524, 4975678, 5017404, 5188896, 111516185, 4826108, 216843, 224588, 220192,
  240081, 4937012, 228890, 221117, 4870452, 5361377, 112080144, 4842851, 4815872, 2031019196]);

const sortedKey = (ids) => [...ids].sort((a, b) => a - b).join(',');
const BY_INGREDIENTS = new Map(RECIPES.map((r) => [sortedKey(r.ingredients), r]));
export const RECIPE_BY_KEY = new Map(RECIPES.map((r) => [r.key, r]));
export const RECIPE_BY_TEMPLATE = new Map(RECIPES.map((r) => [r.template, r]));
export const RECIPE_BY_RECIPE_TEMPLATE = new Map(RECIPES.map((r) => [r.recipeTemplate, r]));

/** The recipe whose ingredient set (order-free, no repeats) equals `ids`, else null. */
export function matchRecipe(ids) {
  return BY_INGREDIENTS.get(sortedKey(ids)) ?? null;
}

/** Classic potion index (0..19) -> recipe, via the DFU hash of the ingredient list. */
export function classicPotion(index) {
  const h = CLASSIC_RECIPE_KEYS[index];
  return RECIPES.find((r) => recipeHash([...r.ingredients].sort((a, b) => a - b)) === h) ?? null;
}

/** Magnitude/duration/chance value at `level` for [base, perLevel]. */
export const scaled = (pair, level) => (pair ? pair[0] + pair[1] * Math.max(1, Math.trunc(level) || 1) : 0);
