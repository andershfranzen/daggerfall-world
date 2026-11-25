// Source-backed people: which authored flats are people, where they stand, who they are and what they do.
//
// Rules follow Daggerfall Unity (MIT, (c) 2009-2023 Daggerfall Workshop):
//  - People vs scenery: RMBLayout.AddMiscBlockFlats/AddExteriorBlockFlats (exterior flat with FactionID != 0),
//    DaggerfallInterior.AddPeople (every interior BlockPeopleRecord), RDBLayout.AddFlat (NPCFlatArchives).
//    Editor flats (archive 199) are markers; exterior lights (210) are scenery even with a faction id.
//  - Placement: RMB exterior flats stand on their base at (x, -y + blockFlatsOffsetY, z + RMBDimension) * scale
//    offset by the block and (sub.XPos, 0, -sub.ZPos) with no sub-record yaw; interior people stand on their base
//    at (x, -y, z) * scale in the building's own frame; dungeon flats are centred at (x, -y, z) * scale in the RDB
//    block at (X, 0, Z) * RDBSide. Billboards always face the camera, so no authored yaw exists.
//  - Identity: StaticNPC.SetLayoutData (nameSeed = Position ^ (buildingKey + locationIndex), female = flags & 32,
//    race from the faction else the region), StaticNPC.GetDisplayName (individuals use the faction name, others
//    DFRandom.srand(nameSeed) + NameHelper.FullName with the region's bank), TalkManager.GetStaticNPCFactionData
//    (faction 0 -> region people or court; random ruler/noble/knight -> court).
//  - Services: PlayerActivate.StaticNPCClick (guild service faction ids, merchants by building type, bank, tavern,
//    witches coven), DaggerfallInterior.AddPeople (shops and other buildings close by PlayerActivate hours).
//  - Quest givers: TalkManager.GetBuildingList (merchants, commoners and nobility in named buildings, 1 in 4).
// All of this module is pure: the caller supplies parsed records and FACTION.TXT/FLATS.CFG/NAMEGEN.DAT data.

import { NAMED_BUILDINGS } from '../../../client/world/interiors/buildingDirectory.js';
export { NAMED_BUILDINGS };
import { dfRandom, readNameBanks } from '../../../client/world/interiors/nameBanks.js';
import { actionRecord, OP } from '../../../client/world/interiors/dungeonActions.js';
export { dfRandom, readNameBanks };
export const SCALE = 0.025;
const RMB_DIMENSION = 4096;
export const BLOCK_SIZE = RMB_DIMENSION * SCALE;
export const RDB_SIDE = 2048 * SCALE;
const BLOCK_FLATS_OFFSET_Y = -6;
export const EDITOR_ARCHIVE = 199;
export const LIGHTS_ARCHIVE = 210;
export const MARKER = Object.freeze({ REST: 4, ENTER: 8, QUEST_SPAWN: 11, QUEST_ITEM: 18, TREASURE: 19 });
/** RDBLayout.NPCFlatArchives */
export const NPC_ARCHIVES = new Set([334, 346, 357, 175, 176, 177, 178, 179, 180, 181, 182, 183, 184]);
/** PlayerActivate.StaticNPCActivationDistance / MobileNPCActivationDistance (256 * GlobalScale). */
export const STATIC_REACH = 256 * SCALE;
export const MOBILE_REACH = 256 * SCALE;

const r3 = (v) => Math.round(v * 1000) / 1000 || 0; // no -0 in snapshots

/** NameHelper.BankTypes */
export const BANK = Object.freeze({ Breton: 0, Redguard: 1, Nord: 2, DarkElf: 3, HighElf: 4, WoodElf: 5, Khajiit: 6, Imperial: 7 });

/** NameHelper.FullName(bank, gender) driven by `rng.rand()` exactly as DFRandom is consumed. */
export function fullName(banks, bankType, female, rng, nordSuffix = 'sen') {
  const bank = banks?.[bankType];
  if (!bank) return '';
  const pick = (set) => {
    const parts = bank[set] ?? [];
    return parts.length ? parts[rng.rand() % parts.length] : '';
  };
  let first = '', last = '';
  if (bankType === BANK.Redguard) {
    const a = pick(0), b = pick(1), c = pick(2);
    let d = '';
    if (female || rng.rand() % 100 < 75) d = pick(female ? 4 : 3);
    first = a + b + c + d;
  } else if (bankType <= BANK.Imperial) {
    first = female ? pick(2) + pick(3) : pick(0) + pick(1);
    if (bankType === BANK.Nord) last = pick(0) + pick(1) + nordSuffix;
    else last = pick(4) + pick(5);
  }
  return last ? `${first} ${last}` : first;
}

// ----------------------------------------------------------------------------------------------- regions

/** MapsFile.RegionRaces (NameHelper bank per region). */
export const REGION_RACES = Object.freeze([
  1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 1,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1,
]);
export const regionBank = (regionIndex) => REGION_RACES[regionIndex] ?? BANK.Breton;

/** FactionFile.FactionRaces -> race words used by the actor tables. */
const FACTION_RACE = { 0: 'nord', 1: 'khajiit', 2: 'redguard', 3: 'breton', 4: 'argonian', 5: 'woodelf', 6: 'highelf', 7: 'darkelf' };
const BANK_RACE = ['breton', 'redguard', 'nord', 'darkelf', 'highelf', 'woodelf', 'khajiit', 'argonian'];

export const FACTION_TYPE = Object.freeze({ Individual: 4, WitchesCoven: 8, Temple: 9, Courts: 14, People: 15 });
export const SGROUP = Object.freeze({ Commoners: 0, Merchants: 1, Scholars: 2, Nobility: 3, Underworld: 4, GuildMembers: 7 });
export const GGROUP = Object.freeze({ GeneralPopulace: 4, MagesGuild: 10, FightersGuild: 11, Region: 15, HolyOrder: 17 });
const RANDOM_RULER = 852, RANDOM_NOBLE = 242, RANDOM_KNIGHT = 853;
const CHILDREN_FACTION = 514;

/** PlayerGPS.GetPeopleOfCurrentRegion / GetCourtOfCurrentRegion over a parsed FACTION.TXT. */
export function regionFactions(factions, regionIndex) {
  let people = null, court = null;
  for (const f of factions?.values?.() ?? []) {
    if (f.region !== regionIndex) continue;
    if (f.type === FACTION_TYPE.People && f.sgroup === SGROUP.Commoners && f.ggroup === GGROUP.GeneralPopulace) people ??= f.id;
    if (f.type === FACTION_TYPE.Courts && f.ggroup === GGROUP.Region) court ??= f.id;
  }
  return { people, court };
}

/** TalkManager.GetStaticNPCFactionData: the faction a person actually speaks for. */
export function effectiveFaction(factions, factionId, buildingType, region) {
  let id = factionId;
  if (id === 0) id = buildingType === BUILDING.Palace ? region.court : region.people;
  else if (id === RANDOM_RULER || id === RANDOM_NOBLE || id === RANDOM_KNIGHT) id = region.court;
  return (id != null && factions?.get(id)) || null;
}

// ----------------------------------------------------------------------------------------------- buildings

/** DFLocation.BuildingTypes */
export const BUILDING = Object.freeze({
  Alchemist: 0, HouseForSale: 1, Armorer: 2, Bank: 3, Town4: 4, Bookseller: 5, ClothingStore: 6, FurnitureStore: 7,
  GemStore: 8, GeneralStore: 9, Library: 10, GuildHall: 11, PawnShop: 12, WeaponSmith: 13, Temple: 14, Tavern: 15,
  Palace: 16, House1: 17, House2: 18, House3: 19, House4: 20, House5: 21, House6: 22, Town23: 23, Ship: 24,
});
const SHOPS = new Set([0, 2, 5, 6, 7, 8, 9, 12, 13]);
const REPAIR_SHOPS = new Set([2, 9, 13]);
/** RMBLayout.IsNamedBuilding */

export const isShop = (t) => SHOPS.has(t);
/** PlayerActivate.openHours/closeHours by building type. */
const OPEN = [7, 8, 9, 8, 0, 9, 10, 10, 9, 6, 9, 11, 9, 9, 0, 0, 10, 0, 6, 6, 6, 6, 6, 6, 0];
const CLOSE = [22, 16, 19, 15, 25, 21, 19, 20, 18, 23, 23, 23, 20, 20, 25, 25, 16, 0, 18, 18, 18, 18, 18, 18, 25];
export const isBuildingOpen = (t, hour) => OPEN[t] !== undefined && OPEN[t] <= hour && CLOSE[t] > hour;
export function buildingHours(type) {
  const open = OPEN[type], close = CLOSE[type];
  return open === undefined ? null : { open, close };
}

/**
 * DaggerfallInterior.AddPeople visibility: shop people only while the shop is open; other buildings up to House4
 * only while open (guild halls also for members, which callers apply per player).
 */
export function presentAt(buildingType, hour) {
  if (isShop(buildingType)) return isBuildingOpen(buildingType, hour);
  if (buildingType <= BUILDING.House4) return isBuildingOpen(buildingType, hour);
  return true;
}

/** BuildingDirectory.MakeBuildingKey */
export function buildingKey(bx, by, record) {
  const k = (bx << 16) + (by << 8) + record;
  return k === 0 ? 1 << 24 : k;
}

/** Shop stock kind for a shop building type (stock tables in npcs/data.js). */
export const SHOP_KIND = { 0: 'alchemist', 2: 'smith', 5: 'general', 6: 'general', 7: 'general', 8: 'general', 9: 'general', 12: 'general', 13: 'smith' };

// ----------------------------------------------------------------------------------------------- services

/** Services.GuildNpcServices ids -> {guild, service}. Only the services this server implements are mapped. */
const GUILD_NPC = new Map([
  [60, ['mages', 'spells']], [61, ['mages', 'train']], [62, ['mages', 'teleport']], [63, ['mages', 'quests']],
  [64, ['mages', 'makeSpells']], [65, ['mages', 'magicItems']], [66, ['mages', 'summon']], [801, ['mages', 'identify']],
  [802, ['mages', 'makeItems']],
  [849, ['fighters', 'train']], [850, ['fighters', 'repair']], [851, ['fighters', 'quests']],
  [803, ['thieves', 'train']], [804, ['thieves', 'quests']], [805, ['thieves', 'sellItems']], [806, ['thieves', 'spymaster']],
  [807, ['brotherhood', 'quests']], [839, ['brotherhood', 'train']], [840, ['brotherhood', 'makePotions']],
  [841, ['brotherhood', 'potions']], [842, ['brotherhood', 'spymaster']], [843, ['brotherhood', 'soulgems']],
  [240, ['temple', 'quests']], [810, ['temple', 'donate']], [813, ['temple', 'heal']],
  [247, ['temple', 'train']], [241, ['temple', 'train']], [250, ['temple', 'train']], [249, ['temple', 'train']],
  [254, ['temple', 'train']], [245, ['temple', 'train']], [252, ['temple', 'train']], [243, ['temple', 'train']],
  [473, ['temple', 'potions']], [474, ['temple', 'makePotions']], [475, ['temple', 'summon']],
  [453, ['temple', 'potions']], [454, ['temple', 'makePotions']], [456, ['temple', 'summon']], [455, ['temple', 'soulgems']],
  [485, ['temple', 'potions']], [487, ['temple', 'makePotions']], [488, ['temple', 'summon']],
  [480, ['temple', 'magicItems']], [481, ['temple', 'makeItems']], [482, ['temple', 'summon']],
  [496, ['temple', 'spells']], [497, ['temple', 'makeSpells']], [498, ['temple', 'summon']],
  [468, ['temple', 'potions']], [469, ['temple', 'makePotions']], [470, ['temple', 'summon']],
  [490, ['temple', 'potions']], [491, ['temple', 'makePotions']], [492, ['temple', 'summon']],
  [462, ['temple', 'potions']], [463, ['temple', 'makePotions']], [464, ['temple', 'summon']],
  // KO_Smith hands out rank armour and KO_Seneschal the rank-9 house (Services.GetServiceFromNpcFaction).
  [846, ['knights', 'quests']], [845, ['knights', 'armor']], [848, ['knights', 'house']],
]);
const QUEST_GROUP_OF_GUILD = { mages: 'MagesGuild', fighters: 'FightersGuild', temple: 'HolyOrder', thieves: 'GeneralPopulace', brotherhood: 'DarkBrotherHood', knights: 'KnightlyOrder' };
const SOCIAL_QUEST_GROUP = { [SGROUP.Commoners]: 'Commoners', [SGROUP.Merchants]: 'Merchants', [SGROUP.Nobility]: 'Nobility' };
/** Guilds whose membership and rank rules this server implements (server/rpg/guilds/rules.js GROUPS). */
const IMPLEMENTED_GUILDS = new Set(['mages', 'fighters', 'temple', 'thieves', 'brotherhood', 'knights']);
/** Specialist services a guild person offers (rank gates: guilds/rules.js serviceAccess; owners: docs/guilds.md). */
const SPECIALIST = new Set(['spells', 'makeSpells', 'magicItems', 'makeItems', 'potions', 'makePotions', 'soulgems', 'summon',
  'teleport', 'identify', 'sellItems', 'spymaster', 'armor', 'house']);

/**
 * PlayerActivate.StaticNPCClick, as data. Returns the role and services of a person standing in a building.
 * @param {number} npcFactionId the record's own FactionID (guild service ids are checked on it, as DFU does)
 * @param {object|null} faction effectiveFaction() of the person
 * @param {{buildingType:number, factionId?:number}|null} building
 */
export function servicesFor(npcFactionId, faction, building) {
  const t = building?.buildingType ?? -1;
  const guild = GUILD_NPC.get(npcFactionId);
  if (guild) {
    const [g, service] = guild;
    const services = [];
    if (IMPLEMENTED_GUILDS.has(g)) {
      // Joining happens at a trainer (and, for knightly orders, which have no trainers, at the order's questor).
      if (service === 'train') services.push('join', 'train');
      if (g === 'knights' && service === 'quests') services.push('join');
      if (g === 'temple' && service === 'heal') services.push('heal', 'cure');
      if (g === 'temple' && service === 'donate') services.push('donate');
      if (SPECIALIST.has(service)) services.push(service);
    }
    return {
      role: g === 'temple' ? 'priest' : g, service, guild: IMPLEMENTED_GUILDS.has(g) ? g : null, services,
      repair: service === 'repair', questGroup: service === 'quests' ? QUEST_GROUP_OF_GUILD[g] : null,
    };
  }
  if (faction?.sgroup === SGROUP.Merchants) {
    if (isShop(t)) return { role: 'shopkeeper', service: REPAIR_SHOPS.has(t) ? 'shop+repair' : 'shop', shop: SHOP_KIND[t], repair: REPAIR_SHOPS.has(t), services: [] };
    if (t === BUILDING.Bank) return { role: 'banker', service: 'bank', bank: true, services: [] };
    if (t === BUILDING.Tavern) return { role: 'innkeeper', service: 'tavern', shop: 'inn', services: ['rest'] };
    return { role: 'merchant', service: 'talk', services: [] };
  }
  if (faction?.type === FACTION_TYPE.WitchesCoven) return { role: 'witch', service: 'coven', services: ['summon'], questGroup: 'Witches' };
  return { role: 'resident', service: 'talk', services: [] };
}

/** TalkManager.GetBuildingList candidate social group for work, or null. */
export function workGroup(faction, building, child) {
  if (child || !faction || !building || !NAMED_BUILDINGS.has(building.buildingType)) return null;
  return SOCIAL_QUEST_GROUP[faction.sgroup] ?? null;
}

// ----------------------------------------------------------------------------------------------- identity

/** TextureReader.IsChildNPCTexture */
const CHILD = { 181: [3], 182: [4, 5, 6, 18, 36, 37, 38, 42, 43, 52, 53], 184: [15], 186: [4, 5, 6, 7, 19, 37, 38, 39, 43, 44, 53, 54], 197: [3], 334: [2, 3, 6, 9, 12], 346: [2, 3, 12, 15, 16, 18], 357: [5, 6, 7, 8] };
export const isChildTexture = (a, r) => CHILD[a]?.includes(r) ?? false;
export const isChild = (a, r, factionId) => isChildTexture(a, r) || factionId === CHILDREN_FACTION;

/** FLATS.CFG: Map flatId -> {archive, record, caption, gender, face}. */
export function parseFlatsCfg(text) {
  const out = new Map();
  const blocks = String(text).split(/\r?\n\s*\r?\n/);
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const m = /^(\d+)\s+(\d+)$/.exec(lines[0]);
    if (!m) continue;
    const archive = +m[1], record = +m[2];
    const id = (archive << 7) + record;
    if (out.has(id)) continue;
    out.set(id, { archive, record, caption: lines[1] ?? '', gender: lines[2] ?? '', face: Number.parseInt(lines[6] ?? '', 10) });
  }
  return out;
}

const raceOf = (faction, regionIndex) => FACTION_RACE[faction?.race] ?? BANK_RACE[regionBank(regionIndex)] ?? 'breton';

/** Common identity: name, gender, race, faction, child, appearance. */
function identity(rec, { factions, region, regionIndex, banks, nameSeed, buildingType, flatsCfg, exterior }) {
  let flags = rec.flags ?? 0;
  if (exterior && flatsCfg) {
    // StaticNPC.SetLayoutData(RmbBlockFlatObjectRecord): FLATS.CFG decides the gender of exterior people.
    const cfg = flatsCfg.get((rec.archive << 7) + rec.record);
    if (cfg) flags = cfg.gender.includes('2') ? flags | 32 : flags & 223;
  }
  const female = (flags & 32) === 32;
  const own = factions?.get(rec.factionId) ?? null;
  const faction = effectiveFaction(factions, rec.factionId, buildingType, region);
  let name;
  if (own && own.type === FACTION_TYPE.Individual && own.name) name = own.name;
  else name = fullName(banks, regionBank(regionIndex), female, dfRandom(nameSeed)) || null;
  const cfg = flatsCfg?.get((rec.archive << 7) + rec.record);
  return {
    name,
    gender: female ? 'female' : 'male',
    race: raceOf(own ?? faction, regionIndex),
    faction: faction?.id ?? null,
    factionName: faction?.name ?? null,
    parentName: (own?.type === FACTION_TYPE.Individual && own.parent != null ? factions.get(own.parent)?.name : null) ?? null,
    individual: own?.type === FACTION_TYPE.Individual ? own.id : null,
    child: isChild(rec.archive, rec.record, rec.factionId),
    caption: cfg?.caption ?? null,
    portrait: Number.isFinite(cfg?.face) ? cfg.face : null,
    nameSeed,
  };
}

const TITLE = {
  shopkeeper: 'Shopkeeper', banker: 'Banker', innkeeper: 'Innkeeper', merchant: 'Merchant', resident: 'Resident',
  mages: 'Mages Guild', fighters: 'Fighters Guild', priest: 'Temple', thieves: 'Thieves Guild', brotherhood: 'Dark Brotherhood',
  knights: 'Knightly Order', witch: 'Coven',
};

/**
 * One NPC entity from a person record and its resolved context. `at` is the output-space base (or centre for
 * dungeons) position.
 */
function entity(id, rec, at, ctx, extra = {}) {
  const who = identity(rec, ctx);
  const building = ctx.building ?? null;
  const faction = effectiveFaction(ctx.factions, rec.factionId, ctx.buildingType, ctx.region);
  const svc = building || ctx.dungeon || faction?.type === FACTION_TYPE.WitchesCoven
    ? servicesFor(rec.factionId, faction, building)
    : { role: 'resident', service: 'talk', services: [] };
  const title = who.individual ? (who.parentName ?? 'Resident') : (TITLE[svc.role] ?? 'Resident');
  return {
    id,
    kind: 'npc',
    role: svc.role,
    title,
    name: who.name ?? title,
    location: ctx.location,
    x: r3(at[0]), y: r3(at[1]), z: r3(at[2]),
    yaw: 0,
    anchor: ctx.dungeon ? 'centre' : 'base',
    sprite: { archive: rec.archive, record: rec.record },
    gender: who.gender,
    race: who.race,
    faction: who.faction,
    ...(who.factionName ? { factionName: who.factionName } : {}),
    ...(who.individual ? { individual: true } : {}),
    ...(who.child ? { child: true } : {}),
    ...(svc.guild ? { guild: svc.guild } : {}),
    ...(svc.shop ? { shop: svc.shop } : {}),
    ...(svc.bank ? { bank: true } : {}),
    ...(svc.repair ? { repair: true } : {}),
    ...(svc.services.length ? { services: svc.services } : {}),
    ...(svc.questGroup ? { questGroup: svc.questGroup, questGiver: true } : {}),
    ...(ctx.castle && !who.child && !who.individual && SOCIAL_QUEST_GROUP[effectiveFaction(ctx.factions, rec.factionId, -1, ctx.region)?.sgroup] ? { _castleGroup: SOCIAL_QUEST_GROUP[effectiveFaction(ctx.factions, rec.factionId, -1, ctx.region).sgroup] } : {}),
    service: svc.service,
    ...(building && !svc.questGroup && workGroup(effectiveFaction(ctx.factions, rec.factionId, ctx.buildingType, ctx.region), building, who.child)
      ? { _workGroup: workGroup(effectiveFaction(ctx.factions, rec.factionId, ctx.buildingType, ctx.region), building, who.child) } : {}),
    _source: { ...extra.source, textureArchive: rec.archive, textureRecord: rec.record, factionId: rec.factionId, flags: rec.flags ?? 0, position: rec.position ?? null, nameSeed: who.nameSeed },
    reach: STATIC_REACH,
    ...(extra.building ? { building: extra.building } : {}),
    sourced: true,
  };
}

const short = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
};

/**
 * People of one building interior.
 * @param {object} o
 * @param {string} o.location interior location id
 * @param {{bx,by,index,interior:{people:Array}, building:{buildingType,factionId,quality,nameSeed}}} o.sub
 * @param {{buildingType,factionId,quality,nameSeed}} [o.building] pooled location building data (else sub.building)
 * @returns {Array<object>} NPC entities (interior output space: x, y = foot, z mirrored)
 */
export function interiorPeople({ location, sub, bx, by, building, regionIndex, locationIndex, factions, banks, flatsCfg, buildingName = null, region = regionFactions(factions, regionIndex) }) {
  const b = { ...sub.building, ...(building ?? {}) };
  const key = buildingKey(bx, by, sub.index);
  const base = `npc:i:${short(location)}`;
  const out = [];
  sub.interior.people.forEach((rec, k) => {
    const pos = Number.isInteger(rec.position) ? rec.position : k;
    const nameSeed = (pos ^ (key + locationIndex)) | 0;
    const at = [rec.xPos * SCALE, -rec.yPos * SCALE, -(rec.zPos * SCALE)];
    out.push(entity(`${base}:${k}`, rec, at, {
      location, factions, region, regionIndex, banks, nameSeed, buildingType: b.buildingType, flatsCfg, building: b,
    }, { source: { kind: 'rmb-interior', bx, by, record: sub.index, people: k }, building: { type: b.buildingType, factionId: b.factionId ?? 0, quality: b.quality ?? 0, key, name: buildingName ?? b.name ?? null } }));
  });
  return out;
}

/**
 * Exterior people of a town (misc flats and building exterior flats with a faction id).
 * `blocks`: [{x, y, name, rmb: parseRmbFlats() shape}], `spawnLocal`: loadTown source.spawnLocal.
 */
export function exteriorPeople({ location, blocks, spawnLocal, regionIndex, locationIndex, factions, banks, flatsCfg }) {
  const region = regionFactions(factions, regionIndex);
  const base = `npc:x:${short(location)}`;
  const out = [];
  const toOut = (ux, uy, uz) => [ux - spawnLocal.x, uy, -(uz - spawnLocal.z)];
  const isPerson = (f) => f.factionId !== 0 && f.archive !== EDITOR_ARCHIVE && f.archive !== LIGHTS_ARCHIVE;
  for (const b of blocks) {
    const ox = b.x * BLOCK_SIZE, oz = b.y * BLOCK_SIZE;
    const add = (f, ux, uz, tag) => {
      const pos = Number.isInteger(f.position) ? f.position : 0;
      out.push(entity(`${base}:${b.x},${b.y}:${tag}`, f, toOut(ux, (-f.yPos + BLOCK_FLATS_OFFSET_Y) * SCALE, uz), {
        location, factions, region, regionIndex, banks, nameSeed: (pos ^ locationIndex) | 0, buildingType: -1, flatsCfg, exterior: true,
      }, { source: { kind: 'rmb-exterior', block: b.name, bx: b.x, by: b.y, tag } }));
    };
    (b.rmb.miscFlats ?? []).forEach((f, k) => {
      if (isPerson(f)) add(f, ox + f.xPos * SCALE, oz + (f.zPos + RMB_DIMENSION) * SCALE, `m${k}`);
    });
    (b.rmb.subRecords ?? []).forEach((sub, s) => {
      (sub.flats ?? sub.exterior?.flats ?? []).forEach((f, k) => {
        if (isPerson(f)) add(f, ox + (f.xPos + sub.xPos) * SCALE, oz + (f.zPos + RMB_DIMENSION - sub.zPos) * SCALE, `s${s}.${k}`);
      });
    });
  }
  return out;
}

/**
 * People of a dungeon: RDB NPC-archive flats. `blocks`: [{x, z, rdb: parseRdb() shape}] as DaggerfallDungeon lays them.
 */
export function dungeonPeople({ location, blocks, regionIndex, locationIndex, factions, banks, flatsCfg }) {
  const region = regionFactions(factions, regionIndex);
  const base = `npc:d:${short(location)}`;
  const out = [];
  for (const b of blocks) {
    // DaggerfallDungeon: a block is a castle block when its start marker (199/10) has a non-zero magnitude.
    const castle = b.rdb.objects.some((o) => o.type === 3 && o.flat.archive === EDITOR_ARCHIVE && o.flat.record === 10 && o.flat.magnitude !== 0);
    for (const o of b.rdb.objects) {
      if (o.type !== 3 || !NPC_ARCHIVES.has(o.flat.archive)) continue;
      const factionId = o.flat.magnitude | (o.flat.soundIndex << 8);
      const rec = { archive: o.flat.archive, record: o.flat.record, factionId, flags: o.flat.flags & 0xff, position: o.flat.position };
      const pos = Number.isInteger(o.flat.position) ? o.flat.position : o.position;
      const at = [b.x * RDB_SIDE + o.xPos * SCALE, -o.yPos * SCALE, -(b.z * RDB_SIDE + o.zPos * SCALE)];
      const e = entity(`${base}:${b.x},${b.z}:${o.root}.${o.index}`, rec, at, {
        location, factions, region, regionIndex, banks, nameSeed: (pos ^ locationIndex) | 0, buildingType: -1, flatsCfg, dungeon: true, castle,
      }, { source: { kind: 'rdb', block: b.rdb.name, bx: b.x, bz: b.z, root: o.root, index: o.index } });
      // PlayerActivate.ActivateStaticNPC: people whose RDB action shows text (11) or a text prompt (12) never talk;
      // activating them runs the action only (the Castle Daggerfall entrance guard, Sheogorath). The mechanism id is
      // the dungeon.use id (server/rpg/interiors/actions.js).
      const action = actionRecord(o);
      if (action && (action.opcode === OP.TEXT || action.opcode === OP.TEXT_INPUT)) {
        e.actionOnly = true;
        e.mechanism = `${b.x},${b.z}:${o.position}`;
      }
      out.push(e);
    }
  }
  return out;
}

/** Quest spawn (199/11) and item (199/18) markers of an interior, in interior output space. */
export function interiorQuestMarkers(sub) {
  const spawn = [], item = [];
  sub.interior.flats.forEach((f, k) => {
    if (f.archive !== EDITOR_ARCHIVE) return;
    const m = { key: `f${k}`, x: r3(f.xPos * SCALE), y: r3(-f.yPos * SCALE), z: r3(-(f.zPos * SCALE)) };
    if (f.record === MARKER.QUEST_SPAWN) spawn.push(m);
    else if (f.record === MARKER.QUEST_ITEM) item.push(m);
  });
  return { spawn, item };
}

/** Quest spawn/item markers of a dungeon (DaggerfallDungeon.EnumerateDungeonQuestMarkers), output space. */
export function dungeonQuestMarkers(blocks) {
  const spawn = [], item = [];
  for (const b of blocks) {
    for (const o of b.rdb.objects) {
      if (o.type !== 3 || o.flat.archive !== EDITOR_ARCHIVE) continue;
      const m = { key: `${b.x},${b.z}:${o.root}.${o.index}`, block: b.rdb.name, x: r3(b.x * RDB_SIDE + o.xPos * SCALE), y: r3(-o.yPos * SCALE), z: r3(-(b.z * RDB_SIDE + o.zPos * SCALE)) };
      if (o.flat.record === MARKER.QUEST_SPAWN) spawn.push(m);
      else if (o.flat.record === MARKER.QUEST_ITEM) item.push(m);
    }
  }
  return { spawn, item };
}

export { short as shortHash };
