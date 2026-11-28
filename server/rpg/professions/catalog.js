// Professions catalog (§3): tracks, XP/rank curve, server-owned item bases (tools,
// raw materials, intermediates, home/hall furniture, cooked recovery goods), and recipes.
import * as inventory from '../inventory.js';

export const PROFESSIONS_VERSION = 1;
export const MAX_RANK = 10;

export const RANK_TITLES = Object.freeze([
  'Novice',
  'Apprentice',
  'Journeyman',
  'Artisan',
  'Adept',
  'Expert',
  'Master',
  'Grandmaster',
  'Illustrious',
  'Legendary',
]);

// Cumulative XP needed to reach each rank (index = rank - 1).
export const RANK_XP_THRESHOLDS = Object.freeze([
  0,     // Rank 1: Novice
  100,   // Rank 2: Apprentice
  260,   // Rank 3: Journeyman
  500,   // Rank 4: Artisan
  840,   // Rank 5: Adept
  1300,  // Rank 6: Expert
  1900,  // Rank 7: Master
  2650,  // Rank 8: Grandmaster
  3550,  // Rank 9: Illustrious
  4650,  // Rank 10: Legendary
]);

export const QUALITY_TIERS = Object.freeze([
  { tier: 1, key: 'standard', label: 'Standard', minDelta: 0, conditionBonus: 0 },
  { tier: 2, key: 'fine', label: 'Fine', minDelta: 2, conditionBonus: 0.1 },
  { tier: 3, key: 'superior', label: 'Superior', minDelta: 4, conditionBonus: 0.2 },
  { tier: 4, key: 'masterwork', label: 'Masterwork', minDelta: 6, conditionBonus: 0.3 },
]);

export const PROFESSIONS = Object.freeze({
  mining: Object.freeze({ id: 'mining', name: 'Mining', kind: 'gathering', tool: 'pickaxe', description: 'Extract iron, coal, silver, and dwarven ore from rock veins.' }),
  woodcutting: Object.freeze({ id: 'woodcutting', name: 'Woodcutting', kind: 'gathering', tool: 'hatchet', description: 'Fell rough timber, oak, yew, and harvest sap resin.' }),
  herbalism: Object.freeze({ id: 'herbalism', name: 'Herbalism', kind: 'gathering', tool: 'sickle', description: 'Gather culinary herbs and classic alchemical botanicals.' }),
  fishing: Object.freeze({ id: 'fishing', name: 'Fishing', kind: 'gathering', tool: 'rod', description: 'Catch trout, perch, cod, and kelp along coastal waters and creeks.' }),
  smithing: Object.freeze({ id: 'smithing', name: 'Smithing', kind: 'crafting', station: 'anvil', description: 'Smelt ingots and forge tools, repair supplies, nails, and arms at anvils and forges.' }),
  carpentry: Object.freeze({ id: 'carpentry', name: 'Carpentry', kind: 'crafting', station: 'workbench', description: 'Mill planks, fletch arrows, craft ship repair kits, and build home or order hall furniture.' }),
  cooking: Object.freeze({ id: 'cooking', name: 'Cooking', kind: 'crafting', station: 'hearth', description: 'Prepare hearty meals and herbal teas at hearths and campfires to restore vitals.' }),
  alchemy: Object.freeze({ id: 'alchemy', name: 'Alchemy', kind: 'arcane', station: 'potionMaker', description: 'Classic Potion Maker progression from brewing potions and discovering recipes.' }),
  enchanting: Object.freeze({ id: 'enchanting', name: 'Enchanting', kind: 'arcane', station: 'itemMaker', description: 'Classic Item Maker progression from imbuing gear with enchantments.' }),
});

export const PROFESSION_IDS = Object.freeze(Object.keys(PROFESSIONS));
export const GATHERING_PROFESSIONS = Object.freeze(PROFESSION_IDS.filter((k) => PROFESSIONS[k].kind === 'gathering'));
export const CRAFTING_PROFESSIONS = Object.freeze(PROFESSION_IDS.filter((k) => PROFESSIONS[k].kind === 'crafting'));
export const ARCANE_PROFESSIONS = Object.freeze(PROFESSION_IDS.filter((k) => PROFESSIONS[k].kind === 'arcane'));

export const TOOL_KINDS = Object.freeze({
  pickaxe: Object.freeze({ kind: 'pickaxe', label: 'Pickaxe', bases: ['pickaxe'] }),
  hatchet: Object.freeze({ kind: 'hatchet', label: 'Woodcutter Hatchet', bases: ['hatchet'] }),
  sickle: Object.freeze({ kind: 'sickle', label: 'Herbalist Sickle', bases: ['sickle'] }),
  rod: Object.freeze({ kind: 'rod', label: 'Fishing Rod', bases: ['fishing-rod'] }),
});

export const STATION_KINDS = Object.freeze({
  anvil: Object.freeze({ kind: 'anvil', label: 'Anvil & Forge', profession: 'smithing' }),
  workbench: Object.freeze({ kind: 'workbench', label: 'Carpenter Workbench', profession: 'carpentry' }),
  hearth: Object.freeze({ kind: 'hearth', label: 'Cooking Hearth', profession: 'cooking' }),
});

export function rankForXp(xp) {
  const n = Math.max(0, Math.floor(Number(xp) || 0));
  let rank = 1;
  for (let i = 1; i < RANK_XP_THRESHOLDS.length; i++) {
    if (n >= RANK_XP_THRESHOLDS[i]) rank = i + 1;
  }
  return Math.min(MAX_RANK, rank);
}

export function rankTitle(rank) {
  const idx = Math.max(0, Math.min(RANK_TITLES.length - 1, Math.trunc(Number(rank) || 1) - 1));
  return RANK_TITLES[idx];
}

export function xpProgressFor(xp) {
  const total = Math.max(0, Math.floor(Number(xp) || 0));
  const rank = rankForXp(total);
  const floor = RANK_XP_THRESHOLDS[rank - 1];
  const next = rank < MAX_RANK ? RANK_XP_THRESHOLDS[rank] : null;
  const into = total - floor;
  const span = next != null ? next - floor : 0;
  const pct = next != null && span > 0 ? Math.max(0, Math.min(100, Math.round((into / span) * 100))) : 100;
  return { xp: total, rank, title: rankTitle(rank), floor, next, into, span, pct };
}

/** Predictable output quality based on crafter rank vs recipe minRank. */
export function qualityForRank(crafterRank, recipeMinRank = 1) {
  const delta = Math.max(0, Math.trunc(Number(crafterRank) || 1) - Math.trunc(Number(recipeMinRank) || 1));
  let chosen = QUALITY_TIERS[0];
  for (const q of QUALITY_TIERS) {
    if (delta >= q.minDelta) chosen = q;
  }
  return chosen;
}

const T = (archive, record) => ({ archive, record });

/**
 * Server-owned item template extensions registered with `inventory.registerBases`.
 * Gathering tools use `group: 'weapon'` so players can natively equip them in `rightHand`,
 * wear them via `inventory.wearItem`, and repair them at smiths or with repair kits.
 */
export const PROFESSION_ITEM_BASES = Object.freeze({
  // ---- Gathering tools (equipable in rightHand; iron-* / steel-* resolve via inventory.js) ----
  pickaxe: {
    index: 310, name: 'Pickaxe', group: 'weapon', weight: 2.0, price: 6, hp: 60,
    world: T(214, 3), icon: T(234, 25),
    weapon: { weaponType: 'Warhammer', skill: 'Blunt Weapon', min: 1, max: 4, hands: 'either' },
    toolKind: 'pickaxe',
  },
  hatchet: {
    index: 311, name: 'Hatchet', group: 'weapon', weight: 1.75, price: 6, hp: 60,
    world: T(207, 4), icon: T(234, 0),
    weapon: { weaponType: 'Battleaxe', skill: 'Axe', min: 1, max: 4, hands: 'either' },
    toolKind: 'hatchet',
  },
  sickle: {
    index: 312, name: 'Sickle', group: 'weapon', weight: 0.75, price: 5, hp: 60,
    world: T(207, 5), icon: T(234, 5),
    weapon: { weaponType: 'Dagger', skill: 'Short Blade', min: 1, max: 3, hands: 'either' },
    toolKind: 'sickle',
  },
  'fishing-rod': {
    index: 313, name: 'Fishing Rod', group: 'weapon', weight: 1.0, price: 5, hp: 60,
    world: T(207, 7), icon: T(234, 21),
    weapon: { weaponType: 'Staff', skill: 'Blunt Weapon', min: 1, max: 2, hands: 'both' },
    toolKind: 'rod',
  },

  // ---- Raw gathered materials (stackable) ----
  'iron-ore': { index: 320, name: 'Iron Ore', group: 'ingredient', weight: 1.0, price: 6, hp: 100, world: T(254, 71), stack: true },
  'coal-lump': { index: 321, name: 'Coal Lump', group: 'ingredient', weight: 0.5, price: 4, hp: 100, world: T(254, 68), stack: true },
  'silver-ore': { index: 322, name: 'Silver Ore', group: 'ingredient', weight: 1.0, price: 14, hp: 100, world: T(254, 73), stack: true },
  'dwarven-ore': { index: 323, name: 'Dwarven Ore', group: 'ingredient', weight: 1.25, price: 24, hp: 100, world: T(254, 69), stack: true },
  'rough-timber': { index: 324, name: 'Rough Timber', group: 'ingredient', weight: 1.25, price: 5, hp: 100, world: T(254, 8), stack: true },
  'oak-timber': { index: 325, name: 'Oak Timber', group: 'ingredient', weight: 1.5, price: 9, hp: 100, world: T(254, 14), stack: true },
  'yew-timber': { index: 326, name: 'Yew Timber', group: 'ingredient', weight: 1.25, price: 16, hp: 100, world: T(254, 14), stack: true },
  'resin-sap': { index: 327, name: 'Pine Resin', group: 'ingredient', weight: 0.25, price: 5, hp: 100, world: T(254, 7), stack: true },
  'wild-sage': { index: 328, name: 'Wild Sage', group: 'ingredient', weight: 0.15, price: 4, hp: 100, world: T(254, 9), stack: true },
  'mountain-thyme': { index: 329, name: 'Mountain Thyme', group: 'ingredient', weight: 0.15, price: 6, hp: 100, world: T(254, 10), stack: true },
  'river-trout': { index: 330, name: 'River Trout', group: 'ingredient', weight: 0.5, price: 6, hp: 100, world: T(254, 59), stack: true },
  'iliac-perch': { index: 331, name: 'Iliac Perch', group: 'ingredient', weight: 0.5, price: 9, hp: 100, world: T(254, 59), stack: true },
  'bay-cod': { index: 332, name: 'Bay Cod', group: 'ingredient', weight: 0.75, price: 14, hp: 100, world: T(254, 60), stack: true },
  'coastal-kelp': { index: 333, name: 'Coastal Kelp', group: 'ingredient', weight: 0.25, price: 4, hp: 100, world: T(254, 9), stack: true },

  // ---- Refined crafting intermediates & repair supplies (stackable) ----
  'iron-ingot': { index: 340, name: 'Iron Ingot', group: 'material', weight: 1.25, price: 12, hp: 100, world: T(254, 71), stack: true },
  'steel-ingot': { index: 341, name: 'Steel Ingot', group: 'material', weight: 1.5, price: 18, hp: 100, world: T(254, 71), stack: true },
  'silver-ingot': { index: 342, name: 'Silver Ingot', group: 'material', weight: 1.25, price: 28, hp: 100, world: T(254, 73), stack: true },
  'iron-nails': { index: 343, name: 'Iron Nails', group: 'material', weight: 0.1, price: 2, hp: 100, world: T(254, 71), stack: true },
  'oak-plank': { index: 344, name: 'Oak Plank', group: 'material', weight: 1.25, price: 8, hp: 100, world: T(254, 8), stack: true },
  'seasoned-plank': { index: 345, name: 'Seasoned Plank', group: 'material', weight: 1.5, price: 18, hp: 100, world: T(254, 14), stack: true },
  'field-repair-kit': { index: 346, name: 'Field Repair Kit', group: 'supply', weight: 1.0, price: 14, hp: 100, world: T(205, 0), stack: true },
  'hull-patch-kit': { index: 347, name: 'Ship Hull Patch Kit', group: 'supply', weight: 2.5, price: 20, hp: 100, world: T(205, 0), stack: true },

  // ---- Crafted home & order hall furniture (non-stackable, placeable in homes/halls) ----
  'crafted-oak-chair': {
    index: 350, name: 'Oak Chair', group: 'furniture', weight: 4.0, price: 16, hp: 200,
    world: T(205, 1), stack: false,
  },
  'crafted-hearth-table': {
    index: 351, name: 'Hearth Table', group: 'furniture', weight: 7.0, price: 26, hp: 250,
    world: T(205, 1), stack: false,
  },
  'crafted-brass-lamp': {
    index: 352, name: 'Brass Table Lamp', group: 'furniture', weight: 2.0, price: 24, hp: 180,
    world: T(205, 2), stack: false,
  },
  'crafted-framed-painting': {
    index: 353, name: 'Framed Iliac Painting', group: 'furniture', weight: 3.0, price: 36, hp: 160,
    world: T(205, 3), stack: false,
  },
  'crafted-guild-banner-stand': {
    index: 354, name: 'Order Banner Stand', group: 'furniture', weight: 5.0, price: 56, hp: 300,
    world: T(205, 4), stack: false,
  },

  // ---- Cooked food & herbal teas (stackable, restore vitals through existing character rules) ----
  'grilled-trout': {
    index: 360, name: 'Grilled River Trout', group: 'food', weight: 0.4, price: 7, hp: 1,
    world: T(205, 11), stack: true, effect: { health: 8, fatigue: 18, survivalFood: 32 },
  },
  'travelers-hardtack': {
    index: 361, name: "Traveler's Hardtack", group: 'food', weight: 0.25, price: 6, hp: 1,
    world: T(205, 11), stack: true, effect: { fatigue: 20, survivalFood: 28 },
  },
  'herbal-field-tea': {
    index: 362, name: 'Herbal Field Tea', group: 'food', weight: 0.25, price: 10, hp: 1,
    world: T(205, 12), stack: true, effect: { magicka: 24, fatigue: 15, survivalWater: 30 },
  },
  'spiced-perch-stew': {
    index: 363, name: 'Spiced Perch Stew', group: 'food', weight: 0.5, price: 18, hp: 1,
    world: T(205, 15), stack: true, effect: { health: 30, fatigue: 25, survivalFood: 45, survivalWater: 15 },
  },
  'hearty-cod-pie': {
    index: 364, name: 'Hearty Bay Cod Pie', group: 'food', weight: 0.6, price: 26, hp: 1,
    world: T(205, 15), stack: true, effect: { health: 45, fatigue: 35, survivalFood: 55 },
  },
});

export const FOOD_EFFECTS = Object.freeze(
  Object.fromEntries(
    Object.entries(PROFESSION_ITEM_BASES)
      .filter(([, b]) => b.group === 'food' && b.effect)
      .map(([k, b]) => [k, Object.freeze({ ...b.effect })]),
  ),
);

export const FURNITURE_SPECS = Object.freeze({
  'crafted-oak-chair': Object.freeze({ category: 'seating', footprint: { w: 0.7, d: 0.7 }, decorative: true }),
  'crafted-hearth-table': Object.freeze({ category: 'table', footprint: { w: 1.6, d: 0.9 }, decorative: true }),
  'crafted-brass-lamp': Object.freeze({ category: 'lighting', footprint: { w: 0.4, d: 0.4 }, decorative: true }),
  'crafted-framed-painting': Object.freeze({ category: 'wall', footprint: { w: 1.0, d: 0.2 }, decorative: true }),
  'crafted-guild-banner-stand': Object.freeze({ category: 'heraldry', footprint: { w: 0.8, d: 0.8 }, decorative: true }),
});

let itemsRegistered = false;

/** Idempotently register all profession item bases into `server/rpg/inventory.js`. */
export function registerProfessionItems() {
  if (itemsRegistered) return [];
  const added = inventory.registerBases(PROFESSION_ITEM_BASES);
  itemsRegistered = true;
  return added;
}

const TOOL_BASE_TO_KIND = Object.freeze({
  pickaxe: 'pickaxe',
  hatchet: 'hatchet',
  sickle: 'sickle',
  'fishing-rod': 'rod',
});

const MATERIAL_TIER = Object.freeze({
  iron: 1,
  steel: 2,
  silver: 3,
  elven: 4,
  dwarven: 5,
  mithril: 6,
  adamantium: 7,
  ebony: 8,
  orcish: 9,
  daedric: 10,
});

export function toolKindOf(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.base && TOOL_BASE_TO_KIND[item.base]) return TOOL_BASE_TO_KIND[item.base];
  const tpl = String(item.template ?? '');
  for (const [base, kind] of Object.entries(TOOL_BASE_TO_KIND)) {
    if (tpl === base || tpl.endsWith(`-${base}`)) return kind;
  }
  return null;
}

export function toolTierOf(item) {
  if (!item) return 0;
  return MATERIAL_TIER[item.material] ?? 1;
}

/** Find the player's equipped gathering tool matching `toolKind` (must be equipped in rightHand or leftHand). */
export function findEquippedTool(rpg, toolKind) {
  if (!rpg || !Array.isArray(rpg.inventory) || !rpg.equipment) return null;
  for (const slot of ['rightHand', 'leftHand']) {
    const id = rpg.equipment[slot];
    if (!id) continue;
    const it = rpg.inventory.find((x) => x && x.id === id);
    if (it && toolKindOf(it) === toolKind) return it;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recipes (Smithing, Carpentry, Cooking)
// Every recipe is balanced so output base value <= 0.80 * (sumInputBaseValue + fee)
// and NPC buyback of crafted items is capped so no infinite gold loop is possible.
// ---------------------------------------------------------------------------

export const RECIPES = Object.freeze([
  // ---- Smithing (anvil / forge) ----
  {
    id: 'smelt-iron-ingot',
    name: 'Smelt Iron Ingot',
    profession: 'smithing',
    stationKind: 'anvil',
    category: 'material',
    minRank: 1,
    xp: 18,
    fee: 3,
    inputs: [{ template: 'iron-ore', quantity: 2 }, { template: 'coal-lump', quantity: 1 }],
    output: { template: 'iron-ingot', quantity: 1 },
    description: 'Refine raw iron ore with coal into a workable smithing ingot.',
  },
  {
    id: 'forge-iron-nails',
    name: 'Forge Iron Nails',
    profession: 'smithing',
    stationKind: 'anvil',
    category: 'material',
    minRank: 1,
    xp: 15,
    fee: 1,
    inputs: [{ template: 'iron-ingot', quantity: 1 }],
    output: { template: 'iron-nails', quantity: 4 },
    description: 'Draw an iron ingot into sturdy nails used by carpenters.',
  },
  {
    id: 'craft-field-repair-kit',
    name: 'Field Repair Kit',
    profession: 'smithing',
    stationKind: 'anvil',
    category: 'supply',
    minRank: 1,
    xp: 22,
    fee: 3,
    inputs: [{ template: 'iron-ingot', quantity: 1 }, { template: 'rough-timber', quantity: 1 }],
    output: { template: 'field-repair-kit', quantity: 1 },
    description: 'Portable whetstone, rivets, and haft stock to restore worn tools and gear.',
  },
  {
    id: 'forge-iron-dagger',
    name: 'Forge Iron Dagger',
    profession: 'smithing',
    stationKind: 'anvil',
    category: 'weapon',
    minRank: 1,
    xp: 24,
    fee: 2,
    inputs: [{ template: 'iron-ingot', quantity: 1 }, { template: 'rough-timber', quantity: 1 }],
    output: { template: 'iron-dagger', quantity: 1 },
    description: 'A dependable sidearm forged on the anvil.',
  },
  {
    id: 'forge-iron-pickaxe',
    name: 'Forge Iron Pickaxe',
    profession: 'smithing',
    stationKind: 'anvil',
    category: 'tool',
    minRank: 1,
    xp: 26,
    fee: 4,
    inputs: [{ template: 'iron-ingot', quantity: 2 }, { template: 'rough-timber', quantity: 1 }],
    output: { template: 'iron-pickaxe', quantity: 1 },
    description: 'Balanced mining pickaxe for iron and coal veins.',
  },
  {
    id: 'forge-iron-hatchet',
    name: 'Forge Iron Hatchet',
    profession: 'smithing',
    stationKind: 'anvil',
    category: 'tool',
    minRank: 1,
    xp: 26,
    fee: 4,
    inputs: [{ template: 'iron-ingot', quantity: 2 }, { template: 'rough-timber', quantity: 1 }],
    output: { template: 'iron-hatchet', quantity: 1 },
    description: 'Sturdy felling hatchet for timber stands.',
  },
  {
    id: 'forge-iron-sickle',
    name: 'Forge Iron Sickle',
    profession: 'smithing',
    stationKind: 'anvil',
    category: 'tool',
    minRank: 1,
    xp: 22,
    fee: 2,
    inputs: [{ template: 'iron-ingot', quantity: 1 }, { template: 'rough-timber', quantity: 1 }],
    output: { template: 'iron-sickle', quantity: 1 },
    description: 'Curved blade for cleanly cutting herbs and wild blossoms.',
  },
  {
    id: 'forge-iron-shortsword',
    name: 'Forge Iron Shortsword',
    profession: 'smithing',
    stationKind: 'anvil',
    category: 'weapon',
    minRank: 2,
    xp: 32,
    fee: 4,
    inputs: [{ template: 'iron-ingot', quantity: 2 }, { template: 'rough-timber', quantity: 1 }],
    output: { template: 'iron-shortsword', quantity: 1 },
    description: 'Balanced infantry blade suited for close combat.',
  },
  {
    id: 'smelt-steel-ingot',
    name: 'Smelt Steel Ingot',
    profession: 'smithing',
    stationKind: 'anvil',
    category: 'material',
    minRank: 2,
    xp: 28,
    fee: 4,
    inputs: [{ template: 'iron-ore', quantity: 2 }, { template: 'coal-lump', quantity: 2 }],
    output: { template: 'steel-ingot', quantity: 1 },
    description: 'High-heat crucible smelting produces tempered steel.',
  },
  {
    id: 'forge-buckler',
    name: 'Forge Iron Buckler',
    profession: 'smithing',
    stationKind: 'anvil',
    category: 'armor',
    minRank: 2,
    xp: 30,
    fee: 3,
    inputs: [{ template: 'iron-ingot', quantity: 1 }, { template: 'oak-plank', quantity: 1 }],
    output: { template: 'buckler', quantity: 1 },
    description: 'Light parrying shield reinforced with an iron boss.',
  },
  {
    id: 'forge-steel-pickaxe',
    name: 'Forge Steel Pickaxe',
    profession: 'smithing',
    stationKind: 'anvil',
    category: 'tool',
    minRank: 3,
    xp: 42,
    fee: 8,
    inputs: [{ template: 'steel-ingot', quantity: 2 }, { template: 'oak-timber', quantity: 1 }],
    output: { template: 'steel-pickaxe', quantity: 1 },
    description: 'Hardened steel pickaxe capable of working rich silver and dwarven seams.',
  },
  {
    id: 'forge-steel-shortsword',
    name: 'Forge Steel Shortsword',
    profession: 'smithing',
    stationKind: 'anvil',
    category: 'weapon',
    minRank: 3,
    xp: 45,
    fee: 10,
    inputs: [{ template: 'steel-ingot', quantity: 2 }, { template: 'rough-timber', quantity: 1 }],
    output: { template: 'steel-shortsword', quantity: 1 },
    description: 'Keen steel blade holding a reliable edge.',
  },
  {
    id: 'smelt-silver-ingot',
    name: 'Smelt Silver Ingot',
    profession: 'smithing',
    stationKind: 'anvil',
    category: 'material',
    minRank: 3,
    xp: 40,
    fee: 6,
    inputs: [{ template: 'silver-ore', quantity: 2 }, { template: 'coal-lump', quantity: 1 }],
    output: { template: 'silver-ingot', quantity: 1 },
    description: 'Pure Iliac silver refined for ceremonial arms and hall fittings.',
  },
  {
    id: 'forge-steel-longsword',
    name: 'Forge Steel Longsword',
    profession: 'smithing',
    stationKind: 'anvil',
    category: 'weapon',
    minRank: 4,
    xp: 60,
    fee: 42,
    inputs: [{ template: 'steel-ingot', quantity: 4 }, { template: 'oak-timber', quantity: 1 }],
    output: { template: 'steel-longsword', quantity: 1 },
    description: 'Masterfully fullered steel longsword.',
  },

  // ---- Carpentry (workbench) ----
  {
    id: 'saw-oak-plank',
    name: 'Mill Oak Plank',
    profession: 'carpentry',
    stationKind: 'workbench',
    category: 'material',
    minRank: 1,
    xp: 16,
    fee: 2,
    inputs: [{ template: 'rough-timber', quantity: 2 }],
    output: { template: 'oak-plank', quantity: 1 },
    description: 'Plane rough timber into true joinery planks.',
  },
  {
    id: 'fletch-arrows',
    name: 'Fletch Quiver of Arrows',
    profession: 'carpentry',
    stationKind: 'workbench',
    category: 'supply',
    minRank: 1,
    xp: 18,
    fee: 3,
    inputs: [{ template: 'rough-timber', quantity: 1 }, { template: 'iron-nails', quantity: 2 }, { template: 'twigs', quantity: 1 }],
    output: { template: 'arrow', quantity: 6 },
    description: 'Shape and tip half a dozen straight flight arrows.',
  },
  {
    id: 'craft-fishing-rod',
    name: 'Craft Fishing Rod',
    profession: 'carpentry',
    stationKind: 'workbench',
    category: 'tool',
    minRank: 1,
    xp: 22,
    fee: 4,
    inputs: [{ template: 'rough-timber', quantity: 2 }, { template: 'resin-sap', quantity: 1 }],
    output: { template: 'iron-fishing-rod', quantity: 1 },
    description: 'Flexible waxed rod rigged for creek and bay fishing.',
  },
  {
    id: 'craft-oak-chair',
    name: 'Build Oak Chair',
    profession: 'carpentry',
    stationKind: 'workbench',
    category: 'furniture',
    minRank: 1,
    xp: 26,
    fee: 4,
    inputs: [{ template: 'oak-plank', quantity: 2 }, { template: 'iron-nails', quantity: 2 }],
    output: { template: 'crafted-oak-chair', quantity: 1 },
    description: 'High-backed oak chair suitable for personal homes and order halls.',
  },
  {
    id: 'craft-hearth-table',
    name: 'Build Hearth Table',
    profession: 'carpentry',
    stationKind: 'workbench',
    category: 'furniture',
    minRank: 2,
    xp: 34,
    fee: 6,
    inputs: [{ template: 'oak-plank', quantity: 3 }, { template: 'iron-nails', quantity: 4 }],
    output: { template: 'crafted-hearth-table', quantity: 1 },
    description: 'Broad trestle table joined for dining rooms and meeting halls.',
  },
  {
    id: 'craft-hull-patch-kit',
    name: 'Assemble Hull Patch Kit',
    profession: 'carpentry',
    stationKind: 'workbench',
    category: 'supply',
    minRank: 2,
    xp: 32,
    fee: 5,
    inputs: [{ template: 'oak-plank', quantity: 2 }, { template: 'resin-sap', quantity: 1 }, { template: 'iron-nails', quantity: 2 }],
    output: { template: 'hull-patch-kit', quantity: 1 },
    description: 'Pitch-sealed planks and spikes for emergency ship repairs.',
  },
  {
    id: 'craft-brass-lamp',
    name: 'Assemble Brass Lamp',
    profession: 'carpentry',
    stationKind: 'workbench',
    category: 'furniture',
    minRank: 2,
    xp: 32,
    fee: 5,
    inputs: [{ template: 'iron-ingot', quantity: 1 }, { template: 'resin-sap', quantity: 2 }, { template: 'oak-plank', quantity: 1 }],
    output: { template: 'crafted-brass-lamp', quantity: 1 },
    description: 'Warm resin-oil table lamp for home parlors.',
  },
  {
    id: 'craft-seasoned-plank',
    name: 'Cure Seasoned Plank',
    profession: 'carpentry',
    stationKind: 'workbench',
    category: 'material',
    minRank: 3,
    xp: 36,
    fee: 3,
    inputs: [{ template: 'oak-timber', quantity: 2 }, { template: 'resin-sap', quantity: 1 }],
    output: { template: 'seasoned-plank', quantity: 1 },
    description: 'Resin-sealed hardwood prized for fine furnishings.',
  },
  {
    id: 'craft-framed-painting',
    name: 'Frame Iliac Painting',
    profession: 'carpentry',
    stationKind: 'workbench',
    category: 'furniture',
    minRank: 3,
    xp: 44,
    fee: 8,
    inputs: [{ template: 'seasoned-plank', quantity: 2 }, { template: 'red-flowers', quantity: 1 }, { template: 'yellow-flowers', quantity: 1 }],
    output: { template: 'crafted-framed-painting', quantity: 1 },
    description: 'Pigment-dyed canvas set in a seasoned oak frame for home walls.',
  },
  {
    id: 'craft-guild-banner-stand',
    name: 'Build Order Banner Stand',
    profession: 'carpentry',
    stationKind: 'workbench',
    category: 'furniture',
    minRank: 4,
    xp: 58,
    fee: 12,
    inputs: [{ template: 'seasoned-plank', quantity: 2 }, { template: 'silver-ingot', quantity: 1 }, { template: 'iron-nails', quantity: 4 }],
    output: { template: 'crafted-guild-banner-stand', quantity: 1 },
    description: 'Silver-capped ceremonial standard built for Order Halls.',
  },

  // ---- Cooking (hearth / campfire) ----
  {
    id: 'cook-grilled-trout',
    name: 'Grill River Trout',
    profession: 'cooking',
    stationKind: 'hearth',
    category: 'food',
    minRank: 1,
    xp: 16,
    fee: 0,
    inputs: [{ template: 'river-trout', quantity: 1 }, { template: 'wild-sage', quantity: 1 }],
    output: { template: 'grilled-trout', quantity: 1 },
    description: 'Crisp sage-seasoned trout that restores health and fatigue.',
  },
  {
    id: 'cook-travelers-hardtack',
    name: "Bake Traveler's Hardtack",
    profession: 'cooking',
    stationKind: 'hearth',
    category: 'food',
    minRank: 1,
    xp: 15,
    fee: 0,
    inputs: [{ template: 'coastal-kelp', quantity: 1 }, { template: 'red-berries', quantity: 1 }],
    output: { template: 'travelers-hardtack', quantity: 1 },
    description: 'Dense trail biscuits that keep fatigue at bay on long marches.',
  },
  {
    id: 'cook-herbal-field-tea',
    name: 'Steep Herbal Field Tea',
    profession: 'cooking',
    stationKind: 'hearth',
    category: 'food',
    minRank: 1,
    xp: 20,
    fee: 1,
    inputs: [{ template: 'green-leaves', quantity: 2 }, { template: 'aloe', quantity: 1 }],
    output: { template: 'herbal-field-tea', quantity: 1 },
    description: 'Restorative infusion that replenishes magicka and fatigue.',
  },
  {
    id: 'cook-spiced-perch-stew',
    name: 'Simmer Spiced Perch Stew',
    profession: 'cooking',
    stationKind: 'hearth',
    category: 'food',
    minRank: 2,
    xp: 30,
    fee: 2,
    inputs: [{ template: 'iliac-perch', quantity: 2 }, { template: 'mountain-thyme', quantity: 1 }],
    output: { template: 'spiced-perch-stew', quantity: 1 },
    description: 'Rich coastal stew restoring substantial health and stamina.',
  },
  {
    id: 'cook-hearty-cod-pie',
    name: 'Bake Hearty Bay Cod Pie',
    profession: 'cooking',
    stationKind: 'hearth',
    category: 'food',
    minRank: 3,
    xp: 44,
    fee: 3,
    inputs: [{ template: 'bay-cod', quantity: 2 }, { template: 'wild-sage', quantity: 1 }, { template: 'red-berries', quantity: 1 }],
    output: { template: 'hearty-cod-pie', quantity: 1 },
    description: 'Savory hearth pie favored by veteran dungeon delvers.',
  },
].map((r) => Object.freeze({
  ...r,
  inputs: Object.freeze(r.inputs.map((i) => Object.freeze({ ...i }))),
  output: Object.freeze({ ...r.output }),
})));

export const RECIPE_BY_ID = new Map(RECIPES.map((r) => [r.id, r]));

export function recipesForProfession(professionId) {
  return RECIPES.filter((r) => r.profession === professionId);
}
