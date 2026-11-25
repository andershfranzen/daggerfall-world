// Alchemy, enchanting, soul gems and artifacts (docs/classic-feature-backlog.md, package 16).
//
// Owns rpg.alchemy = { version, known: [recipeKey…] } (recipes the character has discovered) and
// rpg.artifacts = { [artifactKey]: {at, source} } (artifacts this character has ever received).
// Per-item magic lives on the inventory record as item.magic (inventory contract, package 7):
//   { enchantments: [{type, param}], identified, name?, soul?: {id, name, points}, artifact?, defIndex?, uses? }
// Charges of an enchanted item are its condition, as in classic.
//
// Services (other features call these):
//   artifactTemplate(nameOrIndex) -> 'artifact-<slug>' | null    QBN detail, MAGIC.DEF name or ArtifactsSubTypes 0..22
//   artifactInfo(key) -> {key, name, subtype, base, enchantments} | null
//   giveItem / countItem / findItem understand artifact keys (wrapped around the inventory services)
//   captureSoul(p, {id, name, points}) -> {captured, itemId?, name?, reason?}
//   randomPotionLoot(random) / randomPotionRecipeLoot(random) / randomMagicLoot(level, random)
//       -> {template, quantity, appearance?:{extra:{magic}}} | null
//   useMagicItem(p, item) -> message | undefined   (inventory.use delegates here)
//   enchantmentPower(item), enchantmentModifiers(p) -> held/striking bonuses for combat, character and magic
//   alchemy/powers.js (consumers): enchantmentStrike(p, monster, {itemId, damage}) -> {damage, after(result)} | null
//       (combat, every landed weapon hit), enchantmentStruck(p, monster, damage) (combat, Ring of Namira),
//       enchantmentSkillModifier(p, skill) (character), socialReactionModifier(p, group) (npcs), wearsArtifact(p, key)
//       (conditions: Hircine's Ring), syncHeldEnchantments(p) (CastWhenHeld bundles through magic.castHeldItemSpell)
//   npcServiceHandlers.{makePotions, potions, soulgems, magicItems, makeItems, identify}
//
// Actions (all validate the service NPC, its guild rank rule and the player's gold first):
//   alchemy.open     {targetId, session?, service}           panel data for one counter
//   alchemy.brew     {targetId, session?, itemIds:[…]}        Potion Maker: consumes one of each ingredient
//   alchemy.buy      {targetId, session?, service, offerId}   potion / soul gem / magic item merchant
//   alchemy.enchant  {targetId, session?, itemId, enchantments:[{type,param}], name?}   Item Maker
//   alchemy.identify {targetId, session?, itemId}            Mages Guild identification
//   alchemy.use      {itemId}                                 use a magic item, recipe or artifact
//   alchemy.release  {itemId}                                 empty a soul gem (Azura's Star)
//
// Classic data sources: recipes transcribed in alchemy/recipes.js, enchantment table in
// alchemy/enchantments.js (both from Daggerfall Unity, MIT), MAGIC.DEF read from the operator's ARENA2.
import * as inventory from './inventory.js';
import { ENCHANTMENTS, ENCHANT_POINTS } from './alchemy/enchantments.js';
import { RECIPES, RECIPE_BY_KEY, RECIPE_BY_TEMPLATE, matchRecipe, classicPotion, scaled } from './alchemy/recipes.js';
import { loadMagicDef, ARTIFACT_SUBTYPES, ARTIFACT_KEYS, artifactResolver } from './alchemy/magicdef.js';
import { ENEMY_BY_ID, ENEMY_EXTRAS } from './combat/monsters.js';
import { installPowers, FORCED_BY_SOUL, SPECIAL } from './alchemy/powers.js';

export const name = 'alchemy';
export const VERSION = 1;
export const SERVICE_REACH = 3.5 + 0.5;
export const MAX_ENCHANTMENTS = 10;
export const CHARGE_PER_USE = 10; // CastWhenUsed durabilityLossOnUse
export const OGHMA_BONUS = 30; // DaggerfallCharacterSheetWindow.oghmaBonusPool
export const EMPTY_GEM_VALUE = 5000;

// Weapon / plate enchantment power multipliers (FormulaHelper.Get{Weapon,Armor}EnchantmentMultiplier).
const MATERIAL_POWER = { iron: -0.25, steel: 0, silver: 0.75, elven: 0.25, dwarven: 0.5, mithril: 0.25, adamantium: 0.75, ebony: 1, orcish: 1.5, daedric: 2, leather: 0, chain: 0 };
const WEAPON_MATERIALS = inventory.MATERIALS.weapon;

// Temple RankData (Temple.cs templeData), by divine faction and by guild-service NPC faction.
// [buyPotions, makePotions, buyMagic, makeItems, soulGems]
const TEMPLE_RANKS = {
  26: [4, 5, -1, -1, -1], 21: [1, 4, -1, -1, 4], 29: [1, 5, -1, -1, -1], 27: [-1, -1, 3, 5, -1],
  35: [-1, -1, -1, -1, -1], 24: [2, 5, -1, -1, -1], 33: [2, 5, -1, -1, -1], 22: [1, 6, -1, -1, -1],
};
const TEMPLE_OF_SERVICE = {};
for (const [deity, ids] of Object.entries({ 26: [473, 474, 475], 21: [453, 454, 455, 456], 29: [485, 487, 488], 27: [480, 481, 482], 35: [496, 497, 498], 24: [468, 469, 470], 33: [490, 491, 492], 22: [462, 463, 464] })) {
  for (const id of ids) TEMPLE_OF_SERVICE[id] = Number(deity);
}
const TEMPLE_COLUMN = { potions: 0, makePotions: 1, magicItems: 2, makeItems: 3, soulgems: 4 };
// MagesGuild.CanAccessService / DarkBrotherhood.CanAccessService minimum ranks (-1: anyone).
const GUILD_RANKS = {
  mages: { identify: -1, magicItems: 3, makeItems: 5 },
  brotherhood: { potions: 1, makePotions: 3, soulgems: 5 },
};
const SERVICES = ['makePotions', 'potions', 'soulgems', 'magicItems', 'makeItems', 'identify'];
const SERVICE_TITLES = {
  makePotions: 'Potion Maker', potions: 'Buy Potions', soulgems: 'Buy Soul Gems', magicItems: 'Buy Magic Items', makeItems: 'Item Maker', identify: 'Identify',
};

const fail = (msg) => { throw new Error(msg); };
const int = (v, d = 0) => (Number.isFinite(v) ? Math.trunc(v) : d);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Normalise stored alchemy state in place. */
export function normalizeState(rpg) {
  const raw = isObj(rpg.alchemy) ? rpg.alchemy : {};
  const known = (Array.isArray(raw.known) ? raw.known : []).filter((k) => RECIPE_BY_KEY.has(k));
  rpg.alchemy = { version: VERSION, known: [...new Set(known)] };
  const arts = isObj(rpg.artifacts) ? rpg.artifacts : {};
  rpg.artifacts = {};
  for (const [k, v] of Object.entries(arts)) {
    if (/^artifact-[a-z0-9-]{1,40}$/.test(k) && isObj(v)) rpg.artifacts[k] = { at: int(v.at), source: String(v.source ?? '').slice(0, 80) };
  }
  return rpg.alchemy;
}

/** Enchantment power of an item record (FormulaHelper.GetItemEnchantmentPower). */
export function enchantmentPower(item) {
  const base = ENCHANT_POINTS[item?.index] ?? 0;
  if (!base) return 0;
  const mul = item.group === 'weapon' || item.group === 'armor' ? MATERIAL_POWER[item.material] ?? 0 : 0;
  return base + Math.floor(base * mul);
}

/** Enchantment option record for (type, param) or null. */
export function enchantmentOption(type, param) {
  const def = ENCHANTMENTS[type];
  if (!def || !def.options.length) return null;
  // EnhancesSkill: one entry per skill (DaggerfallSkills.Count = 35), all at the single classic cost.
  const opt = type === 10 ? (Number.isInteger(param) && param >= 0 && param < 35 ? [param, def.options[0][1]] : null)
    : def.options.find((o) => o[0] === param);
  if (!opt) return null;
  return { type, param, key: def.key, cost: opt[1], label: opt[2] ?? null, spell: !!def.spell, flags: def.flags };
}

const WEAPON_ONLY = new Set([2, 4, 20]); // CastWhenStrikes, PotentVs, LowDamageVs (ItemMakerFlags.WeaponOnly)
const MULTI_PRIMARY = new Set([0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 13, 14, 16, 17, 20, 21, 22, 25]);

/**
 * Validate an Item Maker selection. Returns {powers, sideEffects, cost, gold, list}. Throws with the
 * classic refusal for every rule the Item Maker enforces.
 */
export function planEnchantment(item, selection, { soulAvailable = () => false } = {}) {
  if (!item) fail('An item must be selected to be enchanted.');
  if (item.conjuredUntil) fail(`${item.name} is conjured and cannot hold an enchantment.`);
  if (item.magic?.enchantments?.length || item.magic?.artifact) fail(`${item.name} is already enchanted.`);
  if (item.group === 'potion' || item.group === 'ammo' || item.group === 'recipe') fail(`${item.name} cannot be enchanted.`);
  const power = enchantmentPower(item);
  if (power <= 0) fail(`${item.name} cannot be enchanted.`);
  if (!Array.isArray(selection) || !selection.length) fail('You have not prepared enchantments for this item.');
  if (selection.length > MAX_ENCHANTMENTS) fail(`An item can hold at most ${MAX_ENCHANTMENTS} enchantments.`);
  const list = [];
  const check = (o, forced) => {
    if (!forced && WEAPON_ONLY.has(o.type) && item.group !== 'weapon') fail(`${ENCHANTMENTS[o.type].key.replace(/([a-z])([A-Z])/g, '$1 $2')} can only be placed on a weapon.`);
    if (forced) {
      // Forced enchantments are added by the soul and are exclusive with the same pairs as chosen ones.
      if (list.some((x) => x.type === o.type && x.param === o.param)) return false;
    } else if (list.some((x) => x.type === o.type && x.param === o.param) && o.type !== 16) fail('That enchantment is already on the list.');
    if (list.some((x) => x.type === o.type) && !MULTI_PRIMARY.has(o.type)) fail('That enchantment can only be chosen once.');
    // Exclusive pairs (IsEnchantmentExclusiveTo).
    if ((o.type === 11 && list.some((x) => x.type === 23)) || (o.type === 23 && list.some((x) => x.type === 11))) fail('Featherweight and Extra Weight cannot be combined.');
    if ((o.type === 12 && list.some((x) => x.type === 24)) || (o.type === 24 && list.some((x) => x.type === 12))) fail('Strengthens Armor and Weakens Armor cannot be combined.');
    if ((o.type === 4 || o.type === 20) && list.some((x) => x.type === (o.type === 4 ? 20 : 4) && x.param === o.param)) fail('Potent Vs and Low Damage Vs cannot target the same creatures.');
    if ((o.type === 14 || o.type === 25) && list.some((x) => x.type === o.type && (x.param === 5 || o.param === 5))) fail('"All" cannot be combined with another group.');
    if (o.type === 15 && !soulAvailable(o.param)) fail('You have no soul gem holding that soul.');
    return true;
  };
  for (const s of selection) {
    const o = enchantmentOption(int(s?.type, -1), int(s?.param, -1));
    if (!o) fail('That enchantment is not offered here.');
    if (check(o, false)) list.push(o);
  }
  // SoulBound.GetForcedEnchantments: binding certain souls adds their powers and side effects.
  for (const bound of list.filter((o) => o.type === 15)) {
    for (const [type, param] of FORCED_BY_SOUL[bound.param] ?? []) {
      const o = enchantmentOption(type, param);
      if (o && check(o, true)) list.push({ ...o, forced: bound.param });
    }
  }
  if (list.length > MAX_ENCHANTMENTS) fail(`An item can hold at most ${MAX_ENCHANTMENTS} enchantments.`);
  const powers = list.filter((o) => o.cost > 0 || o.type === 15);
  const sideEffects = list.filter((o) => !(o.cost > 0 || o.type === 15));
  const cost = list.reduce((n, o) => n + o.cost, 0);
  const gold = 10 * powers.reduce((n, o) => n + Math.max(0, o.cost), 0);
  if (cost > power) fail('You cannot enchant this item beyond its limit.');
  return { powers, sideEffects, cost, gold, power, list };
}

// ------------------------------------------------------------------------------------------ install

export function install(ctx, options = {}) {
  const services = (ctx.services ??= {});
  const rng = options.rng ?? Math.random;
  const magicDef = options.magicDef ?? loadMagicDef(options.arena2Dir ?? ctx.dataPath ?? ctx.config?.arena2Dir ?? null);
  if (magicDef.error) console.warn(`alchemy: ${magicDef.error}; artifacts and magic item loot are unavailable`);
  const defs = magicDef.records ?? [];
  const regular = defs.filter((d) => d.type === 0);
  const artifactDefs = defs.filter((d) => d.type === 1 || d.type === 2); // ArtifactsSubTypes order

  // ---- extra templates (recipe potions and recipes) -------------------------------------------
  const extraBases = {};
  for (const r of RECIPES) {
    if (!inventory.BASES[r.template]) {
      extraBases[r.template] = { index: 83, name: `Potion of ${r.name}`, group: 'potion', weight: 0.25, price: r.price, hp: 1, world: { archive: 205, record: r.record }, stack: true, recipe: r.key };
    }
  }
  const registered = typeof inventory.registerBases === 'function';
  if (registered) inventory.registerBases(extraBases);
  else console.warn('alchemy: inventory.registerBases is unavailable; brewed potions other than the classic three cannot be created');

  // ---- template index (classic index -> catalogue key) ----------------------------------------
  let byIndex = null;
  function indexTable() {
    if (byIndex) return byIndex;
    byIndex = new Map();
    for (const key of services.itemCatalogue?.() ?? inventory.catalogue()) {
      let d;
      try { d = inventory.describeTemplate(key); } catch { continue; }
      const list = byIndex.get(d.index) ?? [];
      list.push({ key: d.template, group: d.group, material: d.material, stackable: d.stackable });
      byIndex.set(d.index, list);
    }
    return byIndex;
  }
  /** Catalogue key for a classic template index, in `material` when it has one. */
  function templateFor(index, { material = null } = {}) {
    const k = inventory.templateForIndex?.(index) ?? (indexTable().get(index) ?? [])[0]?.key ?? null;
    if (!k) return null;
    const r = inventory.resolveTemplate(k);
    if (!r) return null;
    const key = material && r.material ? inventory.resolveTemplate(`${material}-${r.base}`)?.key ?? r.key : r.key;
    const d = inventory.describeTemplate(key);
    return { key: d.template, group: d.group, material: d.material, stackable: d.stackable };
  }
  const RECIPE_ITEM = 'potion-recipe';
  const recipeOfItem = (item) => (item?.template === RECIPE_ITEM && item.recipe?.key ? RECIPE_BY_KEY.get(item.recipe.key) ?? null : null);
  const recipeExtra = (r) => ({ recipe: { key: r.key, name: `Recipe for ${r.name}` } });
  const ingredientIndexOf = (item) => {
    if (!item) return null;
    if (item.group === 'ingredient' || item.group === 'gem') return item.index;
    return null;
  };
  const SOUL_GEM_INDEX = 274;

  // ---- artifacts -------------------------------------------------------------------------------
  const artifactTemplate = artifactResolver(artifactDefs);

  // MAGIC.DEF group (ItemGroups) + groupIndex -> base template index.
  const GROUP_BASE = { 2: 102, 3: 113, 7: 277, 15: 8, 25: 133 };
  const PLANT1 = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 23, 25];
  function artifactBase(def) {
    if (!def) return null;
    let index;
    if (def.group === 15) index = PLANT1[def.groupIndex];
    else if (def.group === 7) index = 277; // book
    else index = (GROUP_BASE[def.group] ?? NaN) + def.groupIndex;
    const material = def.group === 3 || def.group === 2 ? WEAPON_MATERIALS[def.material] ?? null : null;
    return templateFor(index, { material });
  }
  function artifactInfo(key) {
    const subtype = ARTIFACT_KEYS.indexOf(key);
    if (subtype < 0) return null;
    const def = artifactDefs[subtype];
    if (!def) return { key, subtype, name: ARTIFACT_SUBTYPES[subtype].replace(/_/g, ' '), base: null, enchantments: [], available: false };
    const base = artifactBase(def);
    return {
      key, subtype, name: def.name.replace(/^The /, 'The '), base: base?.key ?? null, uses: def.uses, value: def.value,
      enchantments: def.enchantments.map((e) => ({ ...e })), available: !!base,
      powers: def.enchantments.map((e) => describeEnchantment(e)),
    };
  }

  // ---- magic records ---------------------------------------------------------------------------
  const spellName = (index) => services.enemySpellInfo?.(index)?.name ?? `spell ${index}`;
  function describeEnchantment(e) {
    const def = ENCHANTMENTS[e.type];
    if (!def) return `unknown power ${e.type}`;
    const label = def.key.replace(/([a-z])([A-Z])/g, '$1 $2');
    if (e.type === 26) return `${ARTIFACT_SUBTYPES[e.param]?.replace(/_/g, ' ') ?? 'artifact'} power`;
    if (def.spell) return `${label}: ${spellName(e.param)}`;
    const o = def.options.find((x) => x[0] === e.param);
    if (o?.[2]) return `${label}: ${o[2]}`;
    if (e.type === 10 && services.skillName) return `${label}: ${services.skillName(e.param)}`;
    return label;
  }
  const magicName = (template, base) => template.replace('%it', base);
  const isArtifactKey = (k) => typeof k === 'string' && ARTIFACT_KEYS.includes(k);

  // ---- state -----------------------------------------------------------------------------------
  const stateOf = (p) => {
    p.rpg ??= {};
    if (!isObj(p.rpg.alchemy) || p.rpg.alchemy.version !== VERSION || !isObj(p.rpg.artifacts)) normalizeState(p.rpg);
    return p.rpg.alchemy;
  };
  const say = (p, text, extra = {}) => ctx.notify?.(p, { kind: 'alchemy', text, ...extra });
  const itemOf = (p, id) => (p.rpg?.inventory ?? []).find((i) => i && i.id === id) ?? null;
  const gold = (p) => services.goldOf?.(p) ?? p.rpg?.gold ?? 0;
  const spend = (p, amount, what) => {
    if (amount <= 0) return;
    if (gold(p) < amount) fail(`You do not have the gold to properly pay the enchanter. ${what} costs ${amount} gold.`);
    services.takeGold(p, amount);
  };
  const giveMagic = (p, template, magic, extra = {}) => original.giveItem(p, template, 1, { extra: { magic, ...extra } });

  // ---- wrap inventory services so artifact keys behave like ordinary templates ------------------
  const original = {
    giveItem: services.giveItem, countItem: services.countItem, findItem: services.findItem,
  };
  if (typeof original.giveItem !== 'function') fail('alchemy requires the inventory feature to be installed first');

  function grantArtifact(p, key, { source = 'reward' } = {}) {
    stateOf(p);
    const info = artifactInfo(key);
    if (!info) fail(`Unknown artifact "${key}".`);
    if (!info.available) fail(`${info.name} is not available in this world.`);
    if ((p.rpg.inventory ?? []).some((i) => i?.magic?.artifact === key)) fail(`You already possess ${info.name}.`);
    const magic = { artifact: key, enchantments: info.enchantments, identified: true, name: info.name, defIndex: artifactDefs[info.subtype].index, uses: info.uses };
    const it = giveMagic(p, info.base, magic);
    if (it && typeof it === 'object' && info.uses > 0) {
      it.maxCondition = info.uses;
      it.condition = Math.min(info.uses, it.condition ?? info.uses);
    }
    const prev = p.rpg.artifacts[key];
    p.rpg.artifacts[key] = { at: prev?.at ?? int(ctx.now?.()), source: String(source).slice(0, 80) };
    ctx.dirty?.(p);
    ctx.emit?.('artifactGranted', { player: p, key, item: it });
    return it;
  }

  services.giveItem = (p, template, quantity = 1, appearance) => {
    if (isArtifactKey(template)) {
      if (quantity !== 1) fail('Artifacts are unique.');
      return grantArtifact(p, template, appearance ?? {});
    }
    return original.giveItem(p, template, quantity, appearance);
  };
  services.countItem = (p, template) => (isArtifactKey(template)
    ? (p.rpg?.inventory ?? []).filter((i) => i?.magic?.artifact === template).length
    : original.countItem(p, template));
  services.findItem = (p, template) => (isArtifactKey(template)
    ? (p.rpg?.inventory ?? []).find((i) => i?.magic?.artifact === template) ?? null
    : original.findItem(p, template));

  // ---- enchantment and artifact powers (alchemy/powers.js) ---------------------------------------
  const powers = installPowers(ctx, { services, rng, say: (p, text) => say(p, text), itemOf, useCharge: (p, it, n) => useCharge(p, it, n), spellName: (i) => spellName(i) });

  // ---- soul gems -------------------------------------------------------------------------------
  const isSoulGem = (i) => i && (i.index === SOUL_GEM_INDEX || i.magic?.artifact === 'artifact-azuras-star');
  const filledWith = (p, monsterId) => (p.rpg?.inventory ?? []).find((i) => isSoulGem(i) && i.magic?.soul?.id === monsterId) ?? null;
  function soulPoints(id) {
    return int(ENEMY_EXTRAS[id]?.soul, 0);
  }
  services.captureSoul = (p, { id, name: soulName, points } = {}) => {
    if (!p?.rpg || !Number.isInteger(id) || id < 0) return { captured: false, reason: 'no soul' };
    const inv = p.rpg.inventory ?? [];
    // Azura's Star first (reusable), then any empty soul gem.
    const star = inv.find((i) => i?.magic?.artifact === 'artifact-azuras-star' && !i.magic.soul);
    let gem = star ?? inv.find((i) => i && i.index === SOUL_GEM_INDEX && !i.magic?.soul);
    if (!gem) return { captured: false, reason: 'no empty soul gem' };
    const soul = { id, name: String(soulName ?? ENEMY_BY_ID.get(id)?.name ?? `creature ${id}`).slice(0, 40), points: Number.isInteger(points) ? points : soulPoints(id) };
    if (!gem.magic && gem.quantity > 1) {
      // Split one gem off the stack so the filled one is its own record.
      services.takeItem(p, gem.id, 1);
      gem = giveMagic(p, gem.template, { enchantments: [], identified: true, soul });
    } else {
      gem.magic = { ...(gem.magic ?? { enchantments: [], identified: true }), soul };
      if (gem.index === SOUL_GEM_INDEX) gem.value = EMPTY_GEM_VALUE + soul.points;
    }
    ctx.dirty?.(p);
    ctx.emit?.('inventoryChanged', { player: p, reason: 'soul' });
    say(p, `The soul of the ${soul.name} is trapped in ${gem.magic?.artifact ? 'Azura\'s Star' : 'a soul gem'}.`);
    return { captured: true, itemId: gem.id, name: soul.name };
  };

  // ---- potions ---------------------------------------------------------------------------------
  const potionRecipe = (item) => RECIPE_BY_TEMPLATE.get(item?.template) ?? (item?.recipe ? RECIPE_BY_KEY.get(item.recipe) : null);
  const levelOf = (p) => Math.max(1, int(p.rpg?.character?.level, 1));

  function drink(p, item, recipe) {
    const c = p.rpg.character;
    if (!c) fail('Create your character first.');
    const level = levelOf(p);
    const parts = [];
    const magic = (p.rpg.magic ??= {});
    if (!Array.isArray(magic.active)) magic.active = [];
    for (const eff of recipe.effects) {
      if (eff.chance && !(rng() * 100 < scaled(eff.chance, level))) { parts.push(`${eff.key ?? recipe.name} has no effect`); continue; }
      if (eff.kind === 'pool') {
        const max = { health: 'maxHealth', fatigue: 'maxFatigue', magicka: 'maxMagicka' }[eff.pool];
        if (!Number.isFinite(c[eff.pool]) || !Number.isFinite(c[max])) continue;
        const before = c[eff.pool];
        c[eff.pool] = Math.min(c[max], before + scaled(eff.mag, level));
        parts.push(`+${c[eff.pool] - before} ${eff.pool}`);
        if (eff.pool === 'health' && c.health > before) ctx.notify?.(p, { kind: 'heal', amount: c.health - before });
      } else if (eff.kind === 'fortify' || eff.kind === 'status') {
        const rounds = Math.max(1, scaled(eff.dur, level));
        const entry = { uid: Date.now() + Math.floor(rng() * 1e6), key: eff.key, name: recipe.name, spellId: `potion:${recipe.key}`, spellName: `Potion of ${recipe.name}`, element: 'magic', casterId: p.id, casterName: p.name, roundsLeft: rounds, totalRounds: rounds };
        if (eff.kind === 'status') entry.status = eff.status;
        else Object.assign(entry, { attribute: eff.attribute, amount: Math.max(1, scaled(eff.mag, level)) });
        if (eff.cures) magic.active = magic.active.filter((a) => !eff.cures.includes(a.key));
        magic.active.push(entry);
        parts.push(eff.kind === 'fortify' ? `${eff.attribute} +${entry.amount} for ${rounds} rounds` : `${recipe.name} for ${rounds} rounds`);
      } else if (eff.kind === 'cure') {
        const before = magic.active.length;
        magic.active = magic.active.filter((a) => !(a.condition === eff.condition || (eff.condition === 'poison' && a.element === 'poison' && a.sign === -1)));
        const cured = services.cureCondition?.(p, eff.condition);
        parts.push(before !== magic.active.length || cured ? `cured of ${eff.condition}` : `no ${eff.condition} to cure`);
      }
    }
    services.takeItem(p, item.id, 1);
    ctx.dirty?.(p);
    return `You drink the Potion of ${recipe.name}${parts.length ? ` (${parts.join('; ')})` : ''}.`;
  }

  function learnRecipe(p, recipe, how) {
    const st = stateOf(p);
    if (st.known.includes(recipe.key)) return false;
    st.known.push(recipe.key);
    ctx.dirty?.(p);
    ctx.emit?.('recipeLearned', { player: p, recipe: recipe.key, how });
    return true;
  }

  // ---- using magic items -----------------------------------------------------------------------
  function useCharge(p, item, amount = CHARGE_PER_USE) {
    if (typeof services.useItemCharge === 'function') return services.useItemCharge(p, item.id, amount);
    item.condition = Math.max(0, int(item.condition) - amount);
    ctx.dirty?.(p);
    if (item.condition > 0) return { remaining: item.condition, broke: false };
    services.takeItem(p, item.id, 1, { allowEquipped: true });
    return { remaining: 0, broke: true };
  }

  function useMagicItem(p, item, args = {}) {
    if (!item) return undefined;
    // Recipes: reading one teaches it (the Potion Maker also lists every recipe carried).
    const recipeFromItem = recipeOfItem(item);
    if (recipeFromItem) {
      const fresh = learnRecipe(p, recipeFromItem, 'read');
      const r = recipeFromItem;
      const names = r.ingredients.map((i) => templateFor(i)?.key ?? `#${i}`).map((k) => k.replace(/-/g, ' '));
      return `${fresh ? 'You learn' : 'You already know'} the recipe for ${r.name}: ${names.join(', ')}.`;
    }
    const recipe = potionRecipe(item);
    if (recipe && item.group === 'potion' && !item.effect) return drink(p, item, recipe);
    const m = item.magic;
    if (!m?.enchantments?.length) return undefined;
    if (m.identified === false && !m.artifact) {
      // Unidentified items still work in classic; the name stays hidden.
    }
    const special = m.enchantments.find((e) => e.type === 26);
    if (special?.param === SPECIAL.oghma) {
      // Oghma Infinium (OghmaInfiniumEffect): a 30-point attribute level-up, then the book vanishes.
      const c = p.rpg.character;
      if (!c) fail('Create your character first.');
      c.bonusPoints = int(c.bonusPoints) + OGHMA_BONUS;
      c.oghmaBonus = int(c.oghmaBonus) + OGHMA_BONUS;
      services.takeItem(p, item.id, 1, { allowEquipped: true });
      ctx.dirty?.(p);
      ctx.emit?.('artifactUsed', { player: p, key: m.artifact, power: 'oghma' });
      return `The Oghma Infinium reveals its secrets and crumbles to dust. Distribute ${OGHMA_BONUS} attribute points on your character sheet.`;
    }
    if (special?.param === SPECIAL.azura && m.soul) {
      // Azura's Star: release the trapped soul so the Star can be filled again.
      const freed = m.soul.name;
      delete m.soul;
      ctx.dirty?.(p);
      return `The soul of the ${freed} is released from Azura's Star.`;
    }
    if (special) {
      const text = powers.useSpecial(p, item, special.param);
      if (text !== undefined) return text;
    }
    const onUse = m.enchantments.filter((e) => e.type === 0);
    if (!onUse.length) return undefined;
    if (typeof services.castItemSpell !== 'function') fail(`${item.name} cannot release its spell in this world yet.`);
    const parts = [];
    for (const e of onUse) {
      const castArgs = { yaw: p.yaw };
      for (const k of ['targetId', 'yaw', 'pitch', 'recall']) if (args?.[k] !== undefined) castArgs[k] = args[k];
      const r = services.castItemSpell(p, e.param, castArgs, { itemName: item.name, itemId: item.id });
      parts.push(r?.pending ? `${spellName(e.param)} is released` : `${spellName(e.param)}`);
    }
    const c = useCharge(p, item, CHARGE_PER_USE);
    powers.used(p, item); // Used payloads of the item's other enchantments (HealthLeech)
    ctx.emit?.('magicItemUsed', { player: p, itemId: item.id, enchantments: onUse });
    return `You use ${item.name}: ${parts.join(', ')}.${c.broke ? ` ${item.name} has broken.` : ''}`;
  }
  services.useMagicItem = useMagicItem;

  // ---- loot descriptors (package 8) -----------------------------------------------------------
  const pick = (arr, random) => arr[Math.min(arr.length - 1, Math.floor((random ?? rng)() * arr.length))];
  /** Package 7 containers / treasure: one regular MAGIC.DEF item as {template, extra:{magic}} (unidentified). */
  // `chosen`: a quest's MagicItems subclass, the index among MAGIC.DEF regular items (CreateRegularMagicItem).
  services.randomMagicItem = (random = rng, level = 1, chosen = null) => {
    const d = services.randomMagicLoot(level, random, chosen);
    return d ? { template: d.template, extra: d.appearance.extra, maxCondition: d.appearance.maxCondition } : null;
  };
  services.randomPotionLoot = (random = rng) => {
    const r = classicPotion(Math.floor(random() * 20));
    return r ? { template: r.template, quantity: 1 } : null;
  };
  services.randomPotionRecipeLoot = (random = rng) => ({ template: RECIPE_ITEM, quantity: 1, appearance: { extra: recipeExtra(pick(RECIPES, random)) } });
  services.randomMagicLoot = (level = 1, random = rng, chosen = null) => {
    if (!regular.length) return null;
    const def = Number.isInteger(chosen) && chosen >= 0 ? regular[chosen] : pick(regular, random);
    if (!def) return null; // CreateRegularMagicItem: "Magic item subclass does not exist"
    const groups = def.group === 0 ? ['armor', 'weapon', 'clothing', 'religious', 'gem', 'jewellery'] : def.group === 1 ? ['armor', 'weapon', 'clothing', 'jewellery'] : ['weapon'];
    const g = pick(groups, random);
    const all = [...indexTable().values()].flat();
    const pool = all.filter((x) => x.group === g && x.group !== 'ammo');
    const fallback = all.filter((x) => x.group === 'weapon');
    const base = pick(pool.length ? pool : fallback, random);
    if (!base) return null;
    const baseName = inventory.describeTemplate(base.key).name;
    return {
      template: base.key, quantity: 1,
      appearance: { extra: { magic: { enchantments: def.enchantments.map((e) => ({ ...e })), identified: false, name: magicName(def.name, baseName), defIndex: def.index, uses: def.uses } }, maxCondition: def.uses },
      level,
    };
  };

  // ---- service NPCs ----------------------------------------------------------------------------
  function serviceNpc(p, args, service) {
    if (!SERVICES.includes(service)) fail('That service is not offered here.');
    if (typeof services.requireNpcService === 'function') return { ...services.requireNpcService(p, args, service), gated: true };
    const e = ctx.entities.get(String(args?.targetId ?? ''));
    if (!e || e.kind !== 'npc') fail('There is nobody like that here.');
    if (e.location !== p.rpg?.location) fail(`${e.name} is not here.`);
    if (Math.hypot(e.x - p.x, e.z - p.z) > (e.reach ?? SERVICE_REACH)) fail(`You are too far away from ${e.name}.`);
    if (!(e.services ?? []).includes(service)) fail(`${e.name} does not offer that.`);
    const rank = e.guild ? services.guildRank?.(p, e.guild) ?? -1 : -1;
    return { npcId: e.id, name: e.name, guild: e.guild ?? null, factionId: e._source?.factionId ?? e.faction, rank, quality: e.quality ?? e._source?.quality ?? 10 };
  }
  /**
   * Classic CanAccessService rank rule for this NPC's guild. When the guilds feature is installed (package 15) it
   * has already gated the request in npc.service / requireNpcService; this table is the fallback without it.
   */
  function requireRank(info, service) {
    if (info.gated || typeof services.guilds?.access === 'function') return info;
    let need = -1;
    if (info.guild === 'temple') {
      const deity = TEMPLE_OF_SERVICE[info.factionId];
      need = deity ? TEMPLE_RANKS[deity][TEMPLE_COLUMN[service]] ?? -1 : -1;
      if (deity && need < 0) fail('This temple does not offer that service.');
    } else need = GUILD_RANKS[info.guild]?.[service] ?? -1;
    const rank = info.rank ?? -1;
    if (need >= 0 && rank < need) {
      fail(rank < 0 ? `Only members of the ${info.guild === 'mages' ? 'Mages Guild' : info.guild === 'brotherhood' ? 'Dark Brotherhood' : 'temple'} may use the ${SERVICE_TITLES[service]}.`
        : `You must reach rank ${need} to use the ${SERVICE_TITLES[service]}.`);
    }
    return info;
  }
  const counter = (p, args, service) => requireRank(serviceNpc(p, args, service), service);

  // Merchant stock: rotates every game day per counter (GetMerchantMagicItems seeds from the date).
  const dayOf = () => Math.floor((services.worldClock?.()?.minutes ?? int(ctx.now?.()) / 5000) / 1440);
  function seeded(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hash = (s) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };
  const bought = new Map(); // `${npcId}:${day}` -> Set(offerId)

  function offers(p, info, service) {
    const day = dayOf();
    const random = seeded(hash(`${info.npcId}:${service}:${day}`));
    const quality = Math.max(1, Math.min(20, int(info.quality, 10)));
    const gone = bought.get(`${info.npcId}:${day}`) ?? new Set();
    const list = [];
    if (service === 'potions') {
      for (let n = 0; n <= quality; n++) {
        const r = classicPotion(Math.floor(random() * 20));
        const qty = 1 + Math.floor(random() * 4);
        list.push({ offerId: `p${n}`, template: r.template, name: `Potion of ${r.name}`, quantity: qty, price: r.price });
      }
    } else if (service === 'soulgems') {
      const n = Math.floor(quality / 2) + 1;
      for (let i = 0; i <= n; i++) {
        if (random() * 100 < 75) list.push({ offerId: `s${i}`, template: 'soul-trap', name: 'Soul Gem (empty)', quantity: 1, price: EMPTY_GEM_VALUE });
        else {
          let id;
          do id = Math.floor(random() * 43); while (id === 34 || id === 39 || !soulPoints(id));
          list.push({ offerId: `s${i}`, template: 'soul-trap', name: `Soul Gem (${ENEMY_BY_ID.get(id)?.name ?? id})`, quantity: 1, price: EMPTY_GEM_VALUE + soulPoints(id), soul: { id, name: ENEMY_BY_ID.get(id)?.name ?? String(id), points: soulPoints(id) } });
        }
      }
    } else if (service === 'magicItems') {
      const n = Math.floor(quality / 2) + 1;
      for (let i = 0; i <= n; i++) {
        const d = services.randomMagicLoot(levelOf(p), random);
        if (!d) break;
        d.appearance.extra.magic.identified = true; // merchant items are already identified
        list.push({ offerId: `m${i}`, template: d.template, name: d.appearance.extra.magic.name, quantity: 1, price: regular[d.appearance.extra.magic.defIndex]?.value ?? 1000, magic: d.appearance.extra.magic, maxCondition: d.appearance.maxCondition });
      }
    }
    return list.filter((o) => !gone.has(o.offerId));
  }

  function panel(p, info, service) {
    const inv = p.rpg?.inventory ?? [];
    const base = { kind: 'alchemyPanel', service, title: SERVICE_TITLES[service], npcId: info.npcId, npcName: info.name, gold: gold(p), ...(info.session ? { session: info.session } : {}) };
    if (service === 'makePotions') {
      const st = stateOf(p);
      const carried = inv.map(recipeOfItem).filter(Boolean).map((r) => r.key);
      const known = [...new Set([...st.known, ...carried])];
      return {
        ...base,
        ingredients: inv.filter((i) => ingredientIndexOf(i) !== null && !i.magic).map((i) => ({ id: i.id, name: i.name, template: i.template, index: i.index, quantity: i.quantity, icon: i.icon })),
        recipes: known.map((k) => RECIPE_BY_KEY.get(k)).map((r) => ({ key: r.key, name: r.name, ingredients: r.ingredients.map((ix) => ({ index: ix, template: templateFor(ix)?.key ?? null })) })),
      };
    }
    if (service === 'makeItems') {
      const soulTypes = [...new Set(inv.filter((i) => isSoulGem(i) && i.magic?.soul).map((i) => i.magic.soul.id))];
      return {
        ...base,
        items: inv.filter((i) => i && !i.conjuredUntil && !i.magic?.enchantments?.length && !i.magic?.artifact && enchantmentPower(i) > 0 && i.group !== 'potion' && i.group !== 'ammo')
          .map((i) => ({ id: i.id, name: i.name, group: i.group, power: enchantmentPower(i), icon: i.icon })),
        enchantments: Object.entries(ENCHANTMENTS).filter(([, d]) => d.options.length).map(([type, d]) => ({
          type: Number(type), key: d.key, weaponOnly: WEAPON_ONLY.has(Number(type)),
          options: d.options.filter((o) => Number(type) !== 15 || soulTypes.includes(o[0])).map((o) => ({ param: o[0], cost: o[1], label: o[2] ?? (d.spell ? spellName(o[0]) : null) })),
        })),
      };
    }
    if (service === 'identify') {
      return { ...base, items: inv.filter((i) => i?.magic && i.magic.identified === false).map((i) => ({ id: i.id, name: i.name, price: identifyCost(p, i, info) })) };
    }
    return { ...base, offers: offers(p, info, service) };
  }

  function identifyCost(p, item, info) {
    if (info.guild === 'mages' && (info.rank ?? -1) >= 3) return 0;
    const value = Number.isFinite(item.value) ? item.value : regular[item.magic?.defIndex]?.value ?? 0;
    const raw = typeof services.identifyCost === 'function' ? services.identifyCost(item) : (25 * value) >> 8;
    return services.holidayPrice?.('identify', raw, { p })?.price ?? raw;
  }

  services.npcServiceHandlers ??= {};
  for (const service of SERVICES) {
    services.npcServiceHandlers[service] = (p, info) => {
      requireRank(info, service);
      ctx.notify?.(p, panel(p, info, service));
      return undefined;
    };
  }

  // ---- actions ---------------------------------------------------------------------------------
  ctx.onJoin?.((p) => { if (p.rpg) stateOf(p); });

  ctx.onAction('alchemy.open', (p, args = {}) => {
    const service = String(args.service ?? '');
    const info = counter(p, args, service);
    ctx.notify?.(p, panel(p, info, service));
  });

  ctx.onAction('alchemy.brew', (p, args = {}) => {
    const info = counter(p, args, 'makePotions');
    let ids = Array.isArray(args.itemIds) ? args.itemIds.map(String) : null;
    if (!ids && typeof args.recipe === 'string') {
      // Recipe button: pick one of each ingredient from the pack (AddRecipeToCauldron).
      const r = RECIPE_BY_KEY.get(args.recipe);
      if (!r) fail('No such recipe.');
      const st = stateOf(p);
      const carried = (p.rpg.inventory ?? []).some((i) => recipeOfItem(i) === r);
      if (!st.known.includes(r.key) && !carried) fail('You do not know that recipe.');
      ids = r.ingredients.map((ix) => (p.rpg.inventory ?? []).find((i) => !i.magic && ingredientIndexOf(i) === ix)?.id ?? null);
      if (ids.includes(null)) fail('You do not have all the required ingredients.');
    }
    if (!ids?.length) fail('Put some ingredients in the cauldron first.');
    if (ids.length > 8) fail('The cauldron holds at most eight ingredients.');
    if (new Set(ids).size !== ids.length) fail('Each ingredient goes in once.');
    const items = ids.map((id) => itemOf(p, id));
    if (items.some((i) => !i)) fail('You no longer have that ingredient.');
    if (items.some((i) => ingredientIndexOf(i) === null || i.magic)) fail('Only ingredients go in the cauldron.');
    if (items.some((i) => i.equipped)) fail('Unequip it first.');
    const indices = items.map(ingredientIndexOf);
    if (new Set(indices).size !== indices.length) fail('Each ingredient goes in once.');
    const recipe = matchRecipe(indices);
    // Validate the result can be stored before consuming anything.
    if (recipe && !registered && !inventory.BASES[recipe.template]) fail('The Potion Maker cannot store that potion yet.');
    for (const it of items) services.takeItem(p, it.id, 1);
    let text;
    if (recipe) {
      services.giveItem(p, recipe.template, 1);
      const fresh = learnRecipe(p, recipe, 'brewed');
      text = `The potion is mixed: Potion of ${recipe.name}.${fresh ? ' You note the recipe.' : ''}`;
    } else text = 'The ingredients fail to mix into anything useful and are lost.';
    ctx.dirty?.(p);
    ctx.emit?.('potionBrewed', { player: p, recipe: recipe?.key ?? null });
    say(p, text, { service: 'makePotions', recipe: recipe?.key ?? null });
    ctx.notify?.(p, panel(p, info, 'makePotions'));
  });

  ctx.onAction('alchemy.buy', (p, args = {}) => {
    const service = String(args.service ?? '');
    if (!['potions', 'soulgems', 'magicItems'].includes(service)) fail('That counter sells nothing.');
    const info = counter(p, args, service);
    const offer = offers(p, info, service).find((o) => o.offerId === args.offerId);
    if (!offer) fail('That is no longer for sale.');
    const qty = service === 'potions' ? Math.max(1, Math.min(offer.quantity, int(args.quantity, 1))) : 1;
    const total = offer.price * qty;
    if (gold(p) < total) fail(`That costs ${total} gold; you have ${gold(p)}.`);
    if (typeof services.carriedWeight === 'function' && services.carriedWeight(p) - total / inventory.GOLD_PER_KG + 0.25 * qty > services.maxEncumbrance(p)) fail('You cannot carry that.');
    services.takeGold(p, total);
    let it;
    if (service === 'potions') it = services.giveItem(p, offer.template, qty);
    else if (service === 'soulgems') it = offer.soul ? giveMagic(p, 'soul-trap', { enchantments: [], identified: true, soul: offer.soul }) : services.giveItem(p, 'soul-trap', 1);
    else {
      it = giveMagic(p, offer.template, offer.magic);
      if (it && offer.maxCondition > 0) { it.maxCondition = offer.maxCondition; it.condition = offer.maxCondition; }
    }
    if (service !== 'potions' || offer.quantity === qty) {
      const key = `${info.npcId}:${dayOf()}`;
      const set = bought.get(key) ?? new Set();
      const had = set.has(offer.offerId);
      set.add(offer.offerId);
      bought.set(key, set);
      ctx.onRollback?.(() => { if (!had) set.delete(offer.offerId); });
    }
    ctx.dirty?.(p);
    say(p, `You buy ${qty > 1 ? `${qty} × ` : ''}${offer.name} for ${total} gold.`, { service, itemId: it?.id });
    ctx.notify?.(p, panel(p, info, service));
  });

  ctx.onAction('alchemy.enchant', (p, args = {}) => {
    const info = counter(p, args, 'makeItems');
    const item = itemOf(p, String(args.itemId ?? ''));
    if (item?.equipped) fail('Unequip it first.');
    const plan = planEnchantment(item, args.enchantments, { soulAvailable: (id) => !!filledWith(p, id) });
    const label = typeof args.name === 'string' && args.name.trim() ? args.name.trim().slice(0, 32) : item.name;
    if (!/^[\p{L}\p{N} '’,.-]{1,32}$/u.test(label)) fail('Choose a plain name of up to 32 letters.');
    spend(p, plan.gold, 'This enchantment');
    // Bound souls leave their gem (SoulBound.RemoveFilledTrap); Azura's Star is emptied, not consumed.
    for (const o of plan.list.filter((x) => x.type === 15)) {
      const gem = filledWith(p, o.param);
      if (gem.magic?.artifact) delete gem.magic.soul;
      else services.takeItem(p, gem.id, 1);
    }
    let target = item;
    if (item.quantity > 1) {
      services.takeItem(p, item.id, 1);
      target = original.giveItem(p, item.template, 1, { extra: { magic: { enchantments: [], identified: true } } });
    }
    target.magic = { enchantments: plan.list.map(({ type, param }) => ({ type, param })), identified: true, name: label };
    powers.enchanted(p, target); // HealthLeech Enchanted payload: the leech clock starts now
    if (plan.list.some((o) => o.type === 11)) target.weight = 0.25; // FeatherWeight
    if (plan.list.some((o) => o.type === 23)) target.weight = Math.round(target.weight * 4 * 100) / 100; // ExtraWeight
    target.name = label;
    target.enchanted = true;
    ctx.dirty?.(p);
    ctx.emit?.('inventoryChanged', { player: p, reason: 'enchant' });
    ctx.emit?.('itemEnchanted', { player: p, itemId: target.id, enchantments: target.magic.enchantments, gold: plan.gold });
    say(p, `The item has been enchanted: ${label} (${plan.cost}/${plan.power} enchantment points, ${plan.gold} gold).`, { service: 'makeItems', itemId: target.id });
    ctx.notify?.(p, panel(p, info, 'makeItems'));
  });

  ctx.onAction('alchemy.identify', (p, args = {}) => {
    const info = counter(p, args, 'identify');
    const item = itemOf(p, String(args.itemId ?? ''));
    if (!item?.magic) fail('That item holds no magic to identify.');
    if (item.magic.identified !== false) fail(`${item.name} is already identified.`);
    const price = identifyCost(p, item, info);
    if (args.expectCost !== undefined && price !== args.expectCost) {
      say(p, `The current identification price is ${price} gold. Check the quote and confirm again.`);
      ctx.notify?.(p, panel(p, info, 'identify'));
      return;
    }
    spend(p, price, 'Identification');
    let result;
    if (typeof services.identifyItem === 'function') result = services.identifyItem(p, item.id);
    else {
      item.magic.identified = true;
      if (item.magic.name) item.name = item.magic.name;
      result = { ok: true, name: item.name };
    }
    ctx.dirty?.(p);
    say(p, `${result?.name ?? item.name} has been identified${price ? ` for ${price} gold` : ''}.`, { service: 'identify', itemId: item.id, powers: item.magic.enchantments.map(describeEnchantment) });
    ctx.notify?.(p, panel(p, info, 'identify'));
  });

  ctx.onAction('alchemy.use', (p, args = {}) => {
    const item = itemOf(p, String(args.itemId ?? ''));
    if (!item) fail('You do not have that item.');
    const text = useMagicItem(p, item);
    if (text === undefined) fail(`${item.name} has no power to use.`);
    ctx.emit?.('inventoryChanged', { player: p, reason: 'use' });
    say(p, text, { itemId: item.id });
  });

  ctx.onAction('alchemy.release', (p, args = {}) => {
    const item = itemOf(p, String(args.itemId ?? ''));
    if (!isSoulGem(item) || !item.magic?.soul) fail('That holds no soul.');
    const freed = item.magic.soul.name;
    delete item.magic.soul;
    if (item.index === SOUL_GEM_INDEX) item.value = EMPTY_GEM_VALUE;
    ctx.dirty?.(p);
    say(p, `The soul of the ${freed} is released.`);
  });

  ctx.onAction('alchemy.artifacts', (p) => {
    const st = stateOf(p);
    void st;
    ctx.notify?.(p, {
      kind: 'artifacts',
      owned: Object.entries(p.rpg.artifacts).map(([key, v]) => ({ key, ...v, name: artifactInfo(key)?.name, held: services.countItem(p, key) > 0 })),
      catalogue: ARTIFACT_KEYS.map((k) => { const i = artifactInfo(k); return { key: k, name: i.name, available: i.available, powers: i.powers ?? [] }; }),
    });
  });

  Object.assign(services, {
    artifactTemplate,
    artifactInfo,
    grantArtifact,
    enchantmentPower,
    describeEnchantment,
    knownRecipes: (p) => [...stateOf(p).known],
    potionRecipes: () => RECIPES.map((r) => ({ key: r.key, name: r.name, template: r.template, recipeItem: { template: RECIPE_ITEM, extra: recipeExtra(r) }, ingredients: [...r.ingredients], price: r.price })),
    giveRecipe: (p, key) => { const r = RECIPE_BY_KEY.get(key); if (!r) fail('No such recipe.'); return original.giveItem(p, RECIPE_ITEM, 1, { extra: recipeExtra(r) }); },
    openAlchemyService: (p, info, service) => ctx.notify?.(p, panel(p, requireRank(info, service), service)),
  });

  return { artifactTemplate, artifactInfo, planEnchantment, offers, panel };
}

export const _test = { MATERIAL_POWER, TEMPLE_OF_SERVICE, TEMPLE_RANKS, GUILD_RANKS };
void cap;
