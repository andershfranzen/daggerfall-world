// Classic Daggerfall quests for the shared world (docs/gameplay-protocol.md).
//
// Quests come only from files the operator supplies: ARENA2 QBN/QRC pairs (decompiled by
// server/rpg/quests/qbn.js) and, optionally, Daggerfall Unity format scripts in
// DFW_QUEST_SCRIPTS / config.questScripts. Each player has their own instances in
// `rpg.quests`; every random outcome is rolled on the server; rewards are recorded per
// instance so they are paid once. Lines the engine cannot run are listed, never skipped as
// done, and quests that contain them are not offered. Notices: server/rpg/quests/NOTICE.txt.
//
// rpg.quests = {
//   v: 1,
//   active: Instance[]                    see quests/engine.js createInstance()
//   offer: {id, name, title, text, giver:{id,name}, inst} | null
//   done: [{uid, name, title, result, endedAt, log}]    newest first, capped
//   oneTime: string[]                     one-time quests already accepted
//   seq: number, minutes: number          instance counter; personal game minutes (travel, rest)
// }
//
//   globals: {index: true}                 Daggerfall's 64 global quest variables (Quests-GlobalVars), per player
//
// Dungeon and story sites (docs/world-expansion-plan.md brief I, Mantellan Crux):
//   remote dungeon  Place.SelectRemoteDungeonSite: a keep/labyrinth/ruin/graveyard of the player's region with
//                   dungeon type 0-16, not used by another of their quests; items lie on a quest item marker from
//                   services.interiors.questMarkers() (stable id kept in the instance, so a reload finds it again).
//   permanent       Quests-Places fixed sites (quests/tables.js PERMANENT_PLACES).
//   individuals     FACTION.TXT type-4 people are the source-placed NPC (entity.faction / entity.individual from
//                   server/rpg/npcs); clicking them advances `clicked`/`toting`/classic 0x4e conditions.
//   start quest     schedules the story quest for the same player; `transfer pc inside` calls
//                   services.interiors.questTransfer() (Nulfaga's Mantellan Crux transfer) and completes only once
//                   the player has moved. ctx.emit('questGlobal', {player, index, value}) sets a global variable.
//
// Actions: quest.request {targetId}, quest.accept {offerId}, quest.refuse {offerId},
// quest.answer {uid, yes}, quest.use {uid, item}, quest.click {targetId}, quest.catalog.
// Events (private): questOffer, questAccepted, questRefused, questMessage, questPrompt,
// questLog, questEnd, questCatalog. Emits: questComplete / questFailed {player, quest, factionId}.

import { readFileSync } from 'node:fs';
import { loadCatalog, catalogReport } from './quests/catalog.js';
import { createInstance, updateQuest, answerPrompt, useItem, nextRandom, analyseQuest, assignHome } from './quests/engine.js';
import { expand } from './quests/text.js';
import { readNameGen, bretonName } from './quests/names.js';
import { key } from './quests/script.js';
import { MSG, MOBILES, ITEM_CLASSES, PLACE_TYPES } from './quests/tables.js';
import { MONSTER_BY_ID } from './combat/monsters.js';
import { questItemArt } from './quests/itemArt.js';
import { questItemIdentity } from './quests/itemIdentity.js';
import { itemArt } from '../../client/gameplay/inventory/images.js';
import { dateFromMinutes, formatDate } from '../../client/gameplay/atmosphere/calendar.js';
import { CLASSIC_STARTERS } from '../../client/gameplay/travel/classic.js';
import { SKILLS } from '../../client/gameplay/character/rules.js';
import { parseFactionText } from '../../client/gameplay/npcs/factionFile.js';
import { exteriorOf, parseLocation } from '../../client/world/interiors/index.js';
import { MANTELLAN } from '../../client/world/interiors/dungeonAccess.js';
import { DIVINES } from './guilds/rules.js';
import { installCampaignOpening } from './campaign/opening.js';
import { acceptsCampaignGlobal, revealCampaignDestination, storyTitle, updateSavedCampaignInstance } from './campaign/progress.js';
import { deliverCampaignRewards, permanentQuestItem } from './campaign/rewards.js';
import { annotateTutorialText } from './campaign/tutorial.js';
import { SPECIAL_QUESTS } from './special/quests.js';
import { regionFactions } from './npcs/people.js';

export const name = 'quests';

const ROLE_GROUPS = Object.freeze({ crier: 'Commoners', noble: 'Nobility', fighters: 'FightersGuild', mages: 'MagesGuild', merchant: 'Merchants' });
// Place.IsDungeonType: the three major dungeon types and graveyards; only dungeon types 0-16 carry quest markers.
const QUEST_DUNGEON_TYPES = new Set(['keep', 'labyrinth', 'ruin', 'graveyard']);
const REMOTE_TOWN_TYPES = new Set(['city', 'village', 'hamlet']); // DFRegion TownCity | TownVillage | TownHamlet
const STARTER_TOWN_QUESTS = new Set(['_BRISIEN', 'S0000008']);
const BACKGROUND_STORY_QUESTS = new Set(['S0000977']);
const MAX_MESSAGES = 12;
const COMMON_SITE_TYPES = /^(tavern|generalstore|temple|house\d?|town\d|random|shop)$/i;
const MAX_DUNGEON_TYPE = 16;
const FLOOR_REACH = 2.5; // a quest object on another storey of a dungeon is out of reach
// QuestListsManager.GetGuildQuest: these groups are offered by guild halls and gated on membership and rank (rank 0-9)
// or the guild's reputation (minReq 10+). Temples and knightly orders use the giver's hall.
const GUILD_OF_GROUP = Object.freeze({
  FightersGuild: { guild: 'fighters', factionId: 41 }, MagesGuild: { guild: 'mages', factionId: 40 },
  HolyOrder: { guild: 'temple', factionId: null }, KnightlyOrder: { guild: 'knights', factionId: null },
  DarkBrotherHood: { guild: 'brotherhood', factionId: 108 }, GeneralPopulace: { guild: 'thieves', factionId: 42 },
});
// Generic nouns for quest item classes; classic shows a specific item, which needs FALL.EXE tables.
const ITEM_NOUNS = Object.freeze({
  religious: 'religious item', mens_clothing: 'clothing', womens_clothing: 'clothing', misc: 'parcel', junk: 'parcel',
  small_plant: 'plant', large_plant: 'plant', organs: 'ingredient', skin: 'ingredient', mythic: 'ingredient',
  drug: 'potion', magic_item: 'magic item', specials: 'curiosity', element: 'mineral', transport: 'parcel', deed: 'deed',
});
const MAX_ACTIVE = 8;
const MAX_DONE = 30;
const TALK_RANGE = 4.5;
const TICK_SECONDS = 1;
const CORPSE_MS = 90_000;
const ID_RE = /^[\w:,.-]{1,100}$/; // source people ids carry block coordinates (npc:d:<h>:0,0:1.32)
const fail = (msg) => {
  throw new Error(msg);
};

const SKILL_BY_NORM = new Map(SKILLS.map((s) => [s.toLowerCase().replace(/[^a-z0-9]/g, ''), s]));
/** Resolves a QBN/DFU skill token ("Short_Blade", "ShortBlade", "Long Blade", or numeric index 0..34) to canonical name. */
export function resolveSkillName(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return SKILLS[Number(s)] ?? null;
  return SKILL_BY_NORM.get(s.toLowerCase().replace(/[^a-z0-9]/g, '')) ?? null;
}

const hash32 = (s) => {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
};

/**
 * Saves from before quests/itemIdentity.js: items still in the quest's keeping (not yet in the pack, handed over or
 * given to a foe) whose class had no inventory template get one now, rolled once; a group-1 class other than the
 * potion subclass (O0B60Y18's parcel) loses the random potion it was given. Returns true when the item changed.
 */
export function reviseSavedQuestItem(it, resource, roll) {
  if (it.gold || it.given || it.handedOver || it.holder) return false;
  const cls = resource.classicItem ?? ITEM_CLASSES.get(resource.className);
  const potionForOther = cls?.group === 1 && cls.index !== 1 && /^potion-of-/.test(it.template ?? '');
  if (it.template === null || potionForOther) {
    const before = it.template;
    const id = roll();
    it.template = id?.template ?? null;
    if (id?.appearance) it.appearance = id.appearance;
    return it.template !== before;
  }
  return false;
}

export function install(ctx, opts = {}) {
  const log = ctx.log ?? console;
  const cfg = ctx.config ?? {};
  const services = ctx.services;
  const scriptsDir = opts.scriptsDir ?? cfg.questScripts ?? process.env.DFW_QUEST_SCRIPTS ?? null;
  const questList = opts.questList ?? cfg.questList ?? process.env.DFW_QUEST_LIST ?? null;
  const allowAdult = !!(opts.allowAdult ?? cfg.questAdult ?? false);
  const roleGroups = { ...ROLE_GROUPS, ...(opts.roleGroups ?? cfg.questRoleGroups ?? {}) };

  // ---------------------------------------------------------------- data

  let catalog = opts.catalog ?? null;
  // Artifact rewards resolve through the artifact owner's catalogue (QBN detail name or classic item index).
  const artifactRef = (r) => r.detail ?? r.classicItem?.index ?? null;
  const artifactKnown = (r) => {
    if (typeof services.artifactTemplate !== 'function') return false;
    try { return !!services.artifactTemplate(artifactRef(r)); } catch { return false; }
  };
  const cat = () => {
    if (!catalog) {
      try {
        catalog = loadCatalog({ dataPath: ctx.dataPath, scriptsDir, questList, warn: (m) => log.warn?.(`[quests] ${m}`), artifact: artifactKnown });
        const r = catalogReport(catalog);
        log.info?.(`[quests] ${r.offerable.length} of ${r.total} quests can be offered (${catalog.scriptsDir ? 'scripts + ' : ''}${catalog.dataPath ? 'ARENA2' : 'no ARENA2'})`);
      } catch (err) {
        log.error?.('[quests] could not read quests:', err);
        catalog = { quests: new Map(), failures: [{ name: '*', error: err.message }], listSource: null };
      }
    }
    return catalog;
  };
  const defOf = (name) => cat().quests.get(name)?.def ?? null;

  let nameBanks = opts.nameBanks ?? null;
  if (!nameBanks && ctx.dataPath) {
    try {
      nameBanks = readNameGen(readFileSync(ctx.dataFile('NAMEGEN.DAT')));
    } catch {
      nameBanks = null;
    }
  }

  let factions = opts.factions ?? null;
  if (!factions && ctx.dataPath) {
    try {
      factions = parseFactionText(readFileSync(ctx.dataFile('FACTION.TXT'), 'latin1'));
    } catch {
      factions = null;
    }
  }
  const factionByName = new Map();
  for (const f of factions?.values() ?? []) if (!factionByName.has(f.name.toLowerCase())) factionByName.set(f.name.toLowerCase(), f);

  // Quest person markers (199/11, Place.cs questSpawnMarkers) per building or dungeon, from the NPC feature.
  const spawnCache = new Map();
  const spawnItemCache = new Map(); // dungeon item markers in the same (people reader) space as its spawn markers
  function spawnsOf(location, cache = spawnCache, which = 'questSpawn') {
    const c = cache.get(location);
    if (c !== undefined) return c;
    const get = services.npcs?.[which];
    if (typeof get !== 'function') return new Error('no marker data');
    cache.set(location, 'pending');
    Promise.resolve()
      .then(() => get(location))
      .then((list) => cache.set(location, Array.isArray(list) ? list.map((m) => ({ ...m, id: m.id ?? m.key })) : []))
      .catch((err) => cache.set(location, err instanceof Error ? err : new Error(String(err))));
    return 'pending';
  }

  // Quest item markers per dungeon, loaded once from the interiors service (array, 'pending' or Error).
  const markerCache = new Map();
  function markersOf(location) {
    const c = markerCache.get(location);
    if (c !== undefined) return c;
    // Dungeons: RDB quest item markers (interiors service, with floor). Buildings: the RMB interior's 199/18 quest
    // item markers (NPC feature). Both give stable ids.
    const get = location.startsWith('dungeon:') ? services.interiors?.questMarkers : services.npcs?.questItemMarkers;
    if (typeof get !== 'function') return new Error('no marker data');
    markerCache.set(location, 'pending');
    Promise.resolve()
      .then(() => get(location))
      .then((list) => markerCache.set(location, Array.isArray(list) ? list.map((m) => ({ ...m, id: m.id ?? m.key })) : []))
      .catch((err) => markerCache.set(location, err instanceof Error ? err : new Error(String(err))));
    return 'pending';
  }

  // ---------------------------------------------------------------- state

  function ensure(p) {
    if (!p.rpg || typeof p.rpg !== 'object') p.rpg = {};
    let q = p.rpg.quests;
    if (!q || typeof q !== 'object' || q.v !== 1) q = p.rpg.quests = { v: 1, active: [], offer: null, done: [], oneTime: [], seq: 0, minutes: 0 };
    if (!Array.isArray(q.active)) q.active = [];
    if (!Array.isArray(q.done)) q.done = [];
    if (!Array.isArray(q.oneTime)) q.oneTime = [];
    if (!Number.isFinite(q.seq)) q.seq = 0;
    if (!Number.isFinite(q.minutes)) q.minutes = 0;
    if (q.offer === undefined) q.offer = null;
    if (!q.globals || typeof q.globals !== 'object' || Array.isArray(q.globals)) q.globals = {};
    return q;
  }

  const worldMinutes = () => {
    const wc = services.worldClock?.();
    if (wc && Number.isFinite(wc.minutes)) return wc.minutes;
    return Math.floor(ctx.now() / 5000); // fallback: 12x time scale
  };
  // Personal time (docs/calendar-rest-protocol.md): the calendar owner's ledger when installed, else this feature's own.
  const nowFor = (p) => {
    const m = typeof services.playerMinutes === 'function' ? services.playerMinutes(p) : null;
    return Number.isFinite(m) ? m : worldMinutes() + (p.rpg?.quests?.minutes || 0);
  };
  const locOf = (p) => (typeof p.rpg?.location === 'string' ? p.rpg.location : ctx.defaultLocation);
  const townName = loc => services.travel?.lookup?.(exteriorOf(loc) ?? loc)?.name?.trim();
  const factionNameOf = (id) => {
    if (!Number.isInteger(id)) return null;
    return factions?.get(id)?.name ?? DIVINES[id]?.name ?? null;
  };
  const COMPASS = ['east', 'southeast', 'south', 'southwest', 'west', 'northwest', 'north', 'northeast'];
  const directionOf = (fromLoc, inst) => {
    const lookup = services.travel?.lookup;
    if (typeof lookup !== 'function') return 'nearby';
    const from = lookup(exteriorOf(fromLoc) ?? fromLoc);
    if (!from || !Number.isFinite(from.x) || !Number.isFinite(from.y)) return 'nearby';
    for (const pl of Object.values(inst.places ?? {})) {
      const loc = exteriorOf(pl?.location) ?? pl?.location;
      if (!loc || loc === (exteriorOf(fromLoc) ?? fromLoc)) continue;
      const to = lookup(loc);
      if (!to || !Number.isFinite(to.x) || !Number.isFinite(to.y)) continue;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      if (Math.hypot(dx, dy) < 1) continue;
      const idx = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
      return COMPASS[((idx % 8) + 8) % 8];
    }
    return 'nearby';
  };

  // ---------------------------------------------------------------- host bindings for the engine

  function hostFor(p) {
    const send = (event) => ctx.notify(p, event);
    const text = (inst, id) => {
      const def = defOf(inst.name);
      const msg = def?.messages.get(id);
      if (!msg) return null;
      const v = msg.variants[Math.floor(nextRandom(inst) * msg.variants.length)] ?? msg.variants[0];
      const expanded = expand(v, def, inst, {
        playerName: p.rpg?.character?.name || p.name,
        race: p.rpg?.character?.race,
        className: p.rpg?.character?.className || p.rpg?.character?.career,
        here: locOf(p),
        now: nowFor(p),
        dateText: (m) => formatDate(dateFromMinutes(m)),
        titleOf: () => 'resident',
        factionNameOf,
        direction: directionOf(locOf(p), inst),
        makeName: (gender) => (nameBanks ? bretonName(nameBanks, gender, () => nextRandom(inst)) : null),
        townName,
        buildingName: (loc) => {
          const portal = services.portals?.into?.(loc);
          return portal?.meta?.buildingName || (portal?.label ? `the ${portal.label.toLowerCase()}` : null);
        },
      }).text;
      return annotateTutorialText(inst.name, id, expanded);
    };
    const factionOfPerson = (inst, k) => {
      const person = inst.people[k];
      if (!person) return null;
      return person.questor ? inst.giver?.faction ?? null : person.faction ?? inst.giver?.faction ?? null;
    };
    return {
      location: () => locOf(p),
      inTown: () => (exteriorOf(locOf(p)) ?? locOf(p)).startsWith('town:'),
      ambushPosition: () => ({ x: p.x, z: p.z, y: p.rpg.portal?.footY, yaw: p.yaw ?? 0 }),
      isAt: (pl) => {
        const here = locOf(p);
        if (pl.interior) return here === pl.interior;
        // Not bound to a building yet (town not surveyed or no such building): the town counts.
        if (here === pl.location) return true;
        const portal = services.portals?.into?.(here);
        return !!portal && portal.from === pl.location;
      },
      remoteTown: (inst, r = null) => {
        // Place.SelectRemoteTownSite: another city, village or hamlet of the region the player is in (also from inside
        // a building). Palaces stand only in cities. Without the MAPS catalogue, the classic starter towns stand in.
        const here = exteriorOf(locOf(p)) ?? locOf(p);
        const lookup = services.travel?.lookup;
        const region = lookup?.(here);
        // Villages and hamlets rarely have specialised buildings (library, bank, guild hall, palace...): those sites
        // are drawn from cities, so the place binds to a real building of its type.
        const wantCity = r?.types?.some((t) => !COMMON_SITE_TYPES.test(t) || (inst.special === 'invitation' && /^(house1|tavern)$/.test(t)));
        // Brisienna's meetings (package 18) keep the verified starter venues.
        const towns = region && !STARTER_TOWN_QUESTS.has(inst.name) && typeof services.travel?.regionLocations === 'function'
          ? services.travel.regionLocations(region.regionIndex).filter((l) => l.id !== here && (wantCity ? l.type === 'city' : REMOTE_TOWN_TYPES.has(l.type)))
          : [];
        if (towns.length) return towns[Math.floor(nextRandom(inst) * towns.length)].id;
        // Region from the catalogue entry of the exterior (duplicate names use numeric addresses), else the id.
        const regionOf = (id) => lookup?.(exteriorOf(id) ?? id)?.region ?? parseLocation(id)?.region;
        const pool = CLASSIC_STARTERS.map((s) => s.id).filter((id) => id !== here && (!lookup || lookup(id)));
        const same = pool.filter((id) => regionOf(id) === regionOf(here));
        const list = same.length ? same : pool;
        return list.length ? list[Math.floor(nextRandom(inst) * list.length)] : here;
      },
      makeName: (inst, gender) => {
        if (nameBanks) return bretonName(nameBanks, gender, () => nextRandom(inst));
        return gender === 'female' ? 'a woman of the town' : 'a man of the town';
      },
      itemName: (r) => {
        if (r.className === 'artifact') {
          const artifact = services.artifactTemplate?.(artifactRef(r));
          const name = artifact && services.artifactInfo?.(artifact)?.name;
          if (name) return name;
        }
        return ITEM_NOUNS[r.className] ?? r.className.replace(/_/g, ' ');
      },
      itemTemplate: (r, inst) => {
        if (r.className === 'artifact') {
          try { return services.artifactTemplate?.(artifactRef(r)) ?? null; } catch { return null; }
        }
        // Item.CreateItem (quests/itemIdentity.js): rolled once; the instance keeps template and appearance.
        const level = Number(p.rpg?.character?.level) || 1;
        return questItemIdentity(r.classicItem ?? ITEM_CLASSES.get(r.className), () => nextRandom(inst), {
          magicItem: typeof services.randomMagicItem === 'function' ? (rand, chosen) => services.randomMagicItem(rand, level, chosen) : null,
          potion: typeof services.randomPotionLoot === 'function' ? (rand) => services.randomPotionLoot(rand) : null,
          books: services.books,
        });
      },
      rewardGold: (inst) => {
        // Daggerfall Unity Item.CreateGold: playerMod = level/2+1 (guild quests: rank+1), capped at 10.
        const level = Number(p.rpg?.character?.level) || 1;
        const g = GUILD_OF_GROUP[cat().quests.get(inst.name)?.meta.group];
        const rank = g ? services.guildRank?.(p, g.guild) : null;
        const mod = Math.min(10, rank !== null && rank !== undefined ? rank + 1 : Math.floor(level / 2) + 1);
        return Math.max(1, 150 * mod + Math.floor(nextRandom(inst) * (50 * mod + 1)));
      },
      message: (inst, id) => {
        const t = text(inst, id);
        if (t) {
          if (!Array.isArray(inst.messages)) inst.messages = [];
          const prev = inst.messages.at(-1);
          if (!prev || prev.id !== id || prev.text !== t) {
            inst.messages.push({ id, text: t, at: nowFor(p) });
            if (inst.messages.length > MAX_MESSAGES) inst.messages.splice(0, inst.messages.length - MAX_MESSAGES);
          }
          send({ kind: 'questMessage', uid: inst.uid, title: inst.title, id, text: t });
        }
        noteQuestClues(inst, SPECIAL_QUESTS[inst.name]?.messages?.[id]);
        revealCampaignDestination(services, p, inst, id);
      },
      text,
      prompt: (inst, id) => {
        const t = text(inst, id) ?? '';
        if (inst.prompt) inst.prompt.text = t; // kept so the journal can show the question until answered
        send({ kind: 'questPrompt', uid: inst.uid, title: inst.title, id, text: t });
      },
      logged: (inst, step) => {
        const e = inst.log.find((x) => x.step === step);
        send({ kind: 'questLog', uid: inst.uid, title: inst.title, step, text: e?.text ?? '' });
      },
      grant: (inst, k, rewardKey, { carry = false } = {}) => {
        const it = inst.items[k];
        if (!it) return;
        const rk = `${inst.uid}:${rewardKey}`;
        if (inst.granted.includes(rk)) return; // paid once, even if the task re-runs
        if (it.gold) {
          // The inventory service adds at most one stack (9999) per call; story rewards are larger (25000).
          if (typeof services.addGold === 'function') for (let left = it.gold; left > 0; left -= 9999) services.addGold(p, Math.min(9999, left));
          else p.rpg.gold = (Number(p.rpg.gold) || 0) + it.gold;
        } else if (it.template && !carry && typeof services.giveItem === 'function') {
          try {
            const got = services.giveItem(p, it.template, 1, it.appearance);
            it.given = true;
            if (got && typeof got.id === 'string') it.invId = got.id; // so `give item to` can take it back
          } catch (err) {
            send({ kind: 'questMessage', uid: inst.uid, title: inst.title, text: `${err.message} The reward waits in your journal.` });
            it.held = true;
          }
        } else {
          it.held = true;
          it.handedOver = false;
        }
        it.location = null;
        inst.granted.push(rk);
        send({ kind: 'questReward', uid: inst.uid, title: inst.title, item: it.gold ? `${it.gold} gold` : it.name, gold: it.gold ?? 0 });
      },
      hasItem: (inst, k, { ownership = false } = {}) => {
        const it = inst.items[k];
        if (ownership && it?.template && defOf(inst.name)?.resources.get(k)?.checkInventory) {
          return (services.countItem?.(p, it.template) ?? 0) > 0;
        }
        return !!it?.held;
      },
      /** GiveItem.cs: a quest item handed to a foe leaves the player's inventory if they carry it. */
      reclaimItem: (inst, k) => {
        const it = inst.items[k];
        if (!it?.invId || typeof services.takeItem !== 'function') return;
        const has = Array.isArray(p.rpg?.inventory) && p.rpg.inventory.some((x) => x.id === it.invId);
        if (has) {
          try { services.takeItem(p, it.invId, 1, { allowEquipped: true }); } catch { /* already gone */ }
        }
        delete it.invId;
      },
      releaseItem: (inst, k) => {
        const it = inst.items[k];
        if (it) { it.held = false; it.handedOver = true; }
      },
      takeGold: (inst, n) => {
        if (n <= 0) return true;
        const gold = Number(p.rpg?.gold) || 0;
        if (gold < n) return false;
        if (typeof services.takeGold === 'function') services.takeGold(p, n);
        else { p.rpg.gold = gold - n; ctx.dirty(p); }
        return true;
      },
      end: (inst, result) => {
        // Story quests (started by `start quest`) end without a questor reward; that is not a failure.
        inst.status = result === 'failed' && inst.story ? 'ended' : result;
        inst.endedAt = nowFor(p);
      },
      adjustReputation: (inst, k, amount) => {
        const fid = factionOfPerson(inst, k);
        if (fid !== null && typeof services.adjustReputation === 'function') services.adjustReputation(p, fid, amount);
      },
      reputation: (inst, k) => {
        const fid = factionOfPerson(inst, k);
        return fid !== null && typeof services.reputation === 'function' ? services.reputation(p, fid) : 0;
      },
      reveal: (inst, k) => {
        const pl = inst.places[k];
        if (!pl) return;
        pl.revealed = true;
        // The owner's online party members learn where the site is (map knowledge only: the quest, its items and
        // payments stay the owner's), so a helper can travel there with them.
        const party = p.rpg.party;
        const mates = Array.isArray(party?.members) ? party.members.map((m) => ctx.players.get(m.id)).filter((q) => q && q !== p && q.rpg?.party?.id === party.id) : [];
        for (const who of [p, ...mates]) {
          try {
            services.travel?.discover?.(who, pl.location);
          } catch {
            /* not a travel destination */
          }
        }
      },
      /** One-way Clock.cs leg in minutes (the engine adds the one-day minimum and the 2.5 return-trip multiplier). */
      travelMinutes: (location) => {
        const exterior = exteriorOf(location) ?? location;
        if (!exterior || exterior === (exteriorOf(locOf(p)) ?? locOf(p))) return 0;
        try {
          const travel = services.travel;
          const m = travel?.questClockMinutes?.(p, exterior) ?? travel?.estimate?.(p, exterior)?.minutes ?? null;
          return Number.isFinite(m) ? m : 0;
        } catch {
          return 0;
        }
      },
      placed: () => {},
      global: (i) => !!ensure(p).globals[i],
      setGlobal: (i, v) => {
        const g = ensure(p).globals;
        if (v) g[i] = true;
        else delete g[i];
        ctx.dirty(p);
      },
      remoteDungeon: (inst, resource) => pickDungeon(p, inst, resource),
      localDungeon: (inst, giver) => {
        const town = exteriorOf(giver?.location ?? locOf(p)) ?? giver?.location ?? locOf(p);
        const e = services.travel?.lookup?.(town);
        if (!e || !(e.dungeonType >= 0 && e.dungeonType < 255)) return null; // 255: no dungeon in MAPS
        const interior = `dungeon:${e.id.slice(5)}`;
        markersOf(interior);
        return { location: e.id, interior };
      },
      individual: (r) => {
        const f = r.factionId !== undefined ? factions?.get(r.factionId)
          : r.by === 'named' ? factionByName.get(String(r.value).replace(/_/g, ' ').toLowerCase()) : null;
        if (!f || f.type !== 4) return null;
        const female = /^(lady|queen|princess|dame|mother)\b/i.test(f.name) || r.face === 1 && /brisienna/i.test(f.name);
        return { factionId: f.id, name: f.name, gender: female ? 'female' : 'male', sprite: f.flats[0] ? { archive: f.flats[0][0], record: f.flats[0][1] } : null };
      },
      individualAway: (inst, factionId, away) => {
        try {
          services.npcs?.setIndividualAway?.(factionId, p.id, !!away);
        } catch { /* NPC feature absent */ }
      },
      startQuest: (inst, name) => {
        if (!pendingStarts.has(p.id)) pendingStarts.set(p.id, []);
        pendingStarts.get(p.id).push({ name, from: inst.uid });
      },
      video: (inst, n) => send({ kind: 'questVideo', uid: inst.uid, title: inst.title, video: n }),
      // Classic 0x54 play sound (DAGGER.SND index) / Daggerfall Unity PlaySong: heard by the quest owner only.
      sound: (inst, what) => send({ kind: 'questSound', uid: inst.uid, title: inst.title, ...what }),
      transfer: (inst, pl, marker) => questTransfer(p, inst, pl, marker),
      // Classic 0x1e with person -1 ("teleport pc to"): through the place's own door landing, once it is loaded.
      teleport: (inst, pl) => {
        const target = pl.interior ?? pl.location;
        if (!target) return false;
        if (locOf(p) === target) return true;
        if (!/^(interior|dungeon):/.test(target)) {
          if (inst.teleportError !== 'exterior') { inst.teleportError = 'exterior'; inst.notes.push(`teleport to ${target}: only instances`); }
          return false;
        }
        const portal = services.portals?.into?.(target);
        if (!portal) { Promise.resolve(services.interiors?.survey?.(pl.location ?? exteriorOf(target))).catch(() => {}); return false; }
        if (!services.collision?.instanceWorld?.(target)) { services.collision?.preload?.(target); return false; }
        const enter = portal.entrances?.[0]?.enter ?? portal.entrances?.[0]?.inner;
        if (!enter || typeof services.portals.transfer !== 'function') return false;
        services.portals.transfer(p, { location: target, x: enter.x, y: enter.y ?? 0, z: enter.z, yaw: enter.yaw ?? 0 }, { portal });
        return true;
      },
      /**
       * Person.GetFactionTypeFactionID for `factiontype T` / classic faction code -2.T: the current region's Province,
       * Court or People faction, or one of that FACTION.TXT type (temples without Generic Temple #450). Null leaves the
       * engine default (the questor's faction).
       */
      factionFor: (r, inst) => {
        const TYPES = { daedra: 0, god: 1, group: 2, subgroup: 3, person: 4, official: 5, vampire_clan: 6, province: 7, witches_coven: 8, temple: 9, knightly_guard: 10, magic_user: 11, generic_group: 12, thieves_den: 13, court: 14, people: 15 };
        let type = null;
        if (r.by === 'faction_code') { const m = /^-2\.(\d+)$/.exec(String(r.value)); if (m) type = Number(m[1]); }
        else if (r.by === 'factiontype') type = TYPES[String(r.value).toLowerCase()] ?? null;
        if (type === null || !factions) return null;
        const rand = () => (inst ? nextRandom(inst) : Math.random());
        if (type === -1) type = [14, 7, 15, 9][Math.floor(rand() * 4)];
        const here = exteriorOf(locOf(p)) ?? locOf(p);
        const region = services.travel?.lookup?.(here)?.regionIndex ?? null;
        const all = [...factions.values()];
        const inRegion = (t) => all.find((f) => f.type === t && f.region === region && (t !== 14 || f.ggroup === 15))?.id ?? null;
        if (type === 7 || type === 14) return inRegion(type);
        if (type === 15) return region === null ? null : regionFactions(factions, region).people;
        if (type === 11) return 40;
        if (type === 13) return 42;
        if (type === 12) return rand() < 0.5 ? 450 : 844;
        if (type === 6 || type === 10) return null; // vampire clans (package 10/19) and knightly guards: questor default
        const pool = all.filter((f) => f.type === type && !(type === 9 && f.id === 450));
        return pool.length ? pool[Math.floor(rand() * pool.length)].id : null;
      },
      // ---- package 17 shared hosts (classic opcodes 0x1b, 0x41, 0x45, 0x48/0x31/0x3a/0x3b, 0x4d, 0x4f, 0x36)
      level: () => Number(p.rpg?.character?.level) || 1,
      factionRepute: (inst, ref) => {
        // A number is a FACTION.TXT id (0x4f); a symbol is a quest person, whose faction is used.
        const fid = typeof ref === 'number' ? ref : factionOfPerson(inst, ref)
          ?? factionByName.get(String(ref).replace(/_/g, ' ').toLowerCase())?.id ?? null;
        if (fid === null || typeof services.reputation !== 'function') return null;
        return Number(services.reputation(p, fid)) || 0;
      },
      fixedSite: (region, mapId) => fixedSite(region, mapId),
      revealAt: (inst, k, region, mapId) => {
        const pl = inst.places[k];
        if (!pl) return;
        const hit = fixedSite(region, mapId);
        if (hit) {
          pl.location = hit.location;
          if (hit.interior) pl.interior ??= hit.interior;
          pl.noBuilding = true;
          pl.fixed = { region, mapId };
        } else if (!inst.notes.includes(`reveal: no MAPS record ${region}/${mapId}`)) inst.notes.push(`reveal: no MAPS record ${region}/${mapId}`);
        hostFor(p).reveal(inst, k);
      },
      legalRepute: (inst, amount) => {
        const law = services.law;
        const region = law?.regionOf?.(locOf(p)) ?? services.travel?.lookup?.(exteriorOf(locOf(p)) ?? locOf(p))?.region ?? null;
        if (typeof law?.changeLegalRep === 'function' && region) law.changeLegalRep(p, region, amount, 'quest');
        else if (region) {
          // Kept for the law owner until their service is installed.
          const legal = (p.rpg.legal && typeof p.rpg.legal === 'object') ? p.rpg.legal : (p.rpg.legal = {});
          legal[region] = Math.max(-100, Math.min(100, (Number(legal[region]) || 0) + amount));
        }
        ctx.dirty(p);
        ctx.emit('questLegalRepute', { player: p, quest: inst.name, uid: inst.uid, region, amount });
      },
      castOnFoe: (inst, k, spell) => {
        for (const id of owned.get(p.id) ?? []) {
          const e = ctx.entities.get(id);
          if (e?._quest?.uid === inst.uid && e._quest.foe === k && !e.dead) e.questSpells = [...(inst.foes[k]?.spells ?? [])];
        }
        ctx.emit('questCastOnFoe', { player: p, quest: inst.name, uid: inst.uid, foe: k, spell });
      },
      condition: (inst, op, what) => {
        try {
          if (op === 'cure') services.cureCondition?.(p, what.condition === 'disease' || !what.condition ? { disease: what.disease } : what.condition, { source: 'quest', quest: inst.name });
          else services.applyCondition?.(p, { disease: what.disease }, { source: 'quest', quest: inst.name });
        } catch (err) {
          log.warn?.(`[quests] ${op} condition: ${err.message}`);
        }
        ctx.emit(op === 'cure' ? 'questCure' : 'questDisease', { player: p, quest: inst.name, uid: inst.uid, ...what });
      },
      permanentItem: (inst, k) => {
        const it = inst.items[k];
        if (it) it.permanent = true;
        permanentQuestItem(ctx, p, inst, k, text);
      },
      // ---- expanded QBN opcodes (whenSkill, pcAtAny, trainPc, killFoe, changeFoe, spawnGuards, world)
      skillValue: (inst, rawSkill) => {
        const canonical = resolveSkillName(rawSkill);
        if (!canonical) return null;
        if (typeof services.skillValue === 'function') return Number(services.skillValue(p, canonical)) || 0;
        const v = p.rpg?.character?.skills?.[canonical];
        return Number.isFinite(v) ? Number(v) : null;
      },
      trainSkill: (inst, rawSkill, amount) => {
        const canonical = resolveSkillName(rawSkill);
        if (!canonical) return;
        const delta = Number.isFinite(amount) && amount > 0 ? Math.trunc(amount) : null;
        if (typeof services.advanceSkill === 'function') {
          try { services.advanceSkill(p, canonical, delta ?? 10); } catch (err) { log.warn?.(`[quests] trainPc ${canonical}: ${err.message}`); }
        } else if (p.rpg?.character?.skills && Object.hasOwn(p.rpg.character.skills, canonical)) {
          p.rpg.character.skills[canonical] = Math.min(100, (Number(p.rpg.character.skills[canonical]) || 0) + (delta ?? 1));
          ctx.dirty(p);
        }
        ctx.emit('questTrainPc', { player: p, quest: inst.name, uid: inst.uid, skill: canonical, amount: delta });
      },
      isAtAny: (placeType) => {
        const kind = String(placeType ?? '').toLowerCase();
        const here = locOf(p);
        if (kind === 'anywhere') return true;
        const ext = exteriorOf(here) ?? here;
        if (kind === 'town') return ext.startsWith('town:');
        const spec = PLACE_TYPES.get(kind);
        if (!spec) return false;
        if (spec.p1 === 0) {
          const bt = services.portals?.into?.(here)?.meta?.buildingType;
          if (bt === undefined || bt === null) return false;
          if (kind === 'house') return HOUSES.has(bt);
          if (kind === 'shop') return SHOPS.has(bt);
          if (kind === 'random') return true;
          return bt === spec.p2;
        }
        if (spec.p1 === 1) {
          if (!here.startsWith('dungeon:')) return false;
          if (spec.p2 < 0) return true;
          const entry = services.travel?.lookup?.(ext.startsWith('town:') ? ext : `town:${here.slice(8)}`);
          return entry?.dungeonType === spec.p2;
        }
        if (spec.p1 === 2) {
          const entry = services.travel?.lookup?.(ext.startsWith('town:') ? ext : here.startsWith('dungeon:') ? `town:${here.slice(8)}` : ext);
          return !!entry?.type && String(entry.type).toLowerCase() === kind;
        }
        return false;
      },
      killFoe: (inst, k) => {
        const mine = owned.get(p.id);
        if (mine) {
          for (const id of [...mine]) {
            const e = ctx.entities.get(id);
            if (e?._quest?.uid === inst.uid && e._quest.foe === k) {
              ctx.entities.delete(id);
              mine.delete(id);
            }
          }
        }
        ctx.dirty(p);
        ctx.emit('questKillFoe', { player: p, quest: inst.name, uid: inst.uid, foe: k });
      },
      changeFoeTeam: (inst, k, team) => {
        for (const id of owned.get(p.id) ?? []) {
          const e = ctx.entities.get(id);
          if (e?._quest?.uid === inst.uid && e._quest.foe === k && !e.dead) e.questTeam = team;
        }
        ctx.dirty(p);
        ctx.emit('questChangeFoeTeam', { player: p, quest: inst.name, uid: inst.uid, foe: k, team });
      },
      spawnGuards: (inst, { immediate = false } = {}) => {
        const location = locOf(p);
        try {
          if (typeof services.law?.spawnGuards === 'function') {
            services.law.spawnGuards(p, { immediate, source: 'quest', quest: inst.name, uid: inst.uid, location });
          }
        } catch (err) {
          log.warn?.(`[quests] spawnGuards: ${err.message}`);
        }
        ctx.dirty(p);
        ctx.emit('questSpawnGuards', { player: p, quest: inst.name, uid: inst.uid, location, immediate });
      },
      worldChange: (inst, aspect, value) => {
        // Multiplayer safety: never mutate the shared world clock or other players' atmosphere; scope strictly to `p`.
        try {
          if (typeof services.atmosphere?.setPlayerOverride === 'function') {
            services.atmosphere.setPlayerOverride(p, aspect, value, { source: 'quest', quest: inst.name, uid: inst.uid });
          }
        } catch (err) {
          log.warn?.(`[quests] worldChange (${aspect}=${value}): ${err.message}`);
        }
        send({ kind: 'questWorld', uid: inst.uid, title: inst.title, aspect, value });
        ctx.dirty(p);
        ctx.emit('questWorldChange', { player: p, quest: inst.name, uid: inst.uid, aspect, value });
      },
    };
  }

  /** A MAPS record by region and the low 20 bits of its mapId (classic 0x1b operands). Dungeon sites get their interior. */
  function fixedSite(region, mapId) {
    const hit = services.travel?.regionLocations?.(region)?.find((l) => ((l.mapId ?? -1) & 0xfffff) === mapId);
    if (!hit) return null;
    const dungeon = QUEST_DUNGEON_TYPES.has(hit.type) || (hit.dungeonType >= 0 && hit.dungeonType < 255);
    return { location: hit.id, interior: dungeon ? `dungeon:${hit.id.slice(5)}` : null, name: hit.name };
  }

  /** Place.SelectRemoteDungeonSite in the player's current region. Returns {location, interior} or null. */
  function pickDungeon(p, inst, resource, reject = []) {
    const travel = services.travel;
    const here = travel?.lookup?.(exteriorOf(locOf(p)) ?? '') ?? null;
    if (!here || typeof travel.regionLocations !== 'function') return null;
    const busy = new Set(reject);
    const active = ensure(p).active;
    const scoped = inst.special === 'summoning' && !active.includes(inst) ? [...active, inst] : active;
    for (const other of scoped) for (const pl of Object.values(other.places)) if (pl.dungeon && pl.interior) busy.add(pl.interior);
    const types = (resource?.only ? resource.types : []).map((name) => PLACE_TYPES.get(name))
      .filter((type) => type?.p1 === 1).map((type) => type.p2);
    const anyType = !types.length || types.includes(-1);
    const pool = travel.regionLocations(here.regionIndex).filter((l) =>
      QUEST_DUNGEON_TYPES.has(l.type) && l.dungeonType >= 0 && l.dungeonType <= MAX_DUNGEON_TYPE
      && (anyType || types.includes(l.dungeonType)) && !busy.has(`dungeon:${l.id.slice(5)}`));
    if (!pool.length) return null;
    const e = pool[Math.floor(nextRandom(inst) * pool.length)];
    const interior = `dungeon:${e.id.slice(5)}`;
    markersOf(interior); // warm the marker survey before the player arrives
    return { location: e.id, interior };
  }

  /** `transfer pc inside`: true once the player is inside the target (moved now or already there). */
  function questTransfer(p, inst, pl, marker) {
    const target = pl.interior ?? pl.location;
    if (!target) return false;
    if (locOf(p) === target) return true;
    const svc = services.interiors;
    if (target === MANTELLAN.dungeon && typeof svc?.questTransfer === 'function') {
      try {
        svc.questTransfer(p, inst);
        return true;
      } catch (err) {
        if (inst.transferError !== err.message) {
          inst.transferError = err.message;
          ctx.notify(p, { kind: 'questMessage', uid: inst.uid, title: inst.title, text: err.message });
        }
        return false;
      }
    }
    // No other quest-driven transfer exists in the classic quests this server runs; never a public warp.
    if (inst.transferError !== 'unsupported') inst.transferError = 'unsupported';
    return false;
  }

  // ---------------------------------------------------------------- world entities

  const owned = new Map(); // player id -> Set(entity id)
  const waitingForMarkers = new WeakMap(); // player -> location -> outstanding private quest placement
  ctx.readiness?.('quests', (location, player) => waitingForMarkers.get(player)?.get(location) ?? null, { perPlayer: true });
  // Talk and combat accept word characters, dots, colons and hyphens. Cure script names start with "$".
  const entityId = (p, inst, kind, k, n = 0) => `quest:${hash32(p.id).toString(36)}:${inst.uid.replaceAll('$', '_')}:${kind}:${k}:${n}`;
  function spot(seed, i) {
    const r = hash32(seed);
    // Beside the lane the town roster keeps clear (npcs/data.js SLOTS stand at x = ±0.5).
    const side = (r & 1 ? 1 : -1) * (1.5 + ((r >>> 1) % 3) * 0.15);
    return { x: side, z: -2.6 - 1.5 * ((i + (r >>> 4)) % 6) };
  }

  /**
   * Where foe `k` #n stands: on its building/dungeon quest person marker (199/11) with that marker's floor, a group
   * fanned out around it on clear floor; otherwise the door-relative spot used for towns.
   */
  function foeSpot(inst, k, f, n) {
    const w = whereOf(inst, f);
    if (f.ambushAt) {
      const { x, y, z, yaw } = f.ambushAt;
      const a = yaw + (n + 1) * 2.4;
      const targetX = x + 4 * Math.sin(a);
      const targetZ = z + 4 * Math.cos(a);
      const clear = services.collision?.nearestClear?.(w.location, targetX, targetZ, 4, y);
      return { w, x: clear?.x ?? targetX, z: clear?.z ?? targetZ, y: clear?.y ?? y };
    }
    if (f.spawnAt && f.spawnAt.id !== null && Number.isFinite(f.spawnAt.x)) {
      const a = (n * 2.4) % (2 * Math.PI);
      const r = n ? 0.9 : 0;
      let x = f.spawnAt.x + r * Math.sin(a);
      let z = f.spawnAt.z + r * Math.cos(a);
      const c = n ? services.collision?.nearestClear?.(w.location, x, z, 2, f.spawnAt.y) : null;
      if (c) ({ x, z } = c);
      return { w, x, z, y: f.spawnAt.y };
    }
    const s0 = spot(`${inst.uid}:${k}:${n}`, n + 2);
    const at = w.door ? near(w.door, s0) : { x: s0.x, z: s0.z - 6 };
    return { w, x: at.x, z: at.z, y: undefined };
  }

  function makeFoe(p, inst, k, f, n) {
    const level = Number(p.rpg?.character?.level) || 1;
    if (typeof services.createEnemy === 'function') {
      // Combat builds the real classic enemy (EnemyBasics stats, careers, spells, loot, AI); quests own the rest.
      const { w, ...at } = foeSpot(inst, k, f, n);
      const id = entityId(p, inst, 'foe', k, n);
      const e = services.createEnemy(w.location, f.mobile, at.x, at.z, { id, level, gender: f.gender, yaw: 0, origin: 'quest', key: id, ...(Number.isFinite(at.y) ? { y: at.y } : {}), ...(f.spells?.length ? { questSpells: [...f.spells] } : {}) });
      if (e) {
        ctx.entities.delete(e.id); // the caller registers it with the quest bookkeeping
        return Object.assign(e, {
          name: f.mobile >= 128 ? `${f.name} the ${f.kind}` : f.kind,
          quest: inst.title, visibleTo: [p.id], _quest: { owner: p.id, uid: inst.uid, foe: k },
          ...(f.spells?.length ? { questSpells: [...f.spells] } : {}),
          ...(f.team !== undefined ? { questTeam: f.team } : {}),
        });
      }
    }
    const base = MONSTER_BY_ID.get(f.mobile);
    const row = MOBILES[f.mobile] ?? [f.kind, 0, 0];
    const m = base ?? {
      // Class foes (Spellsword, Rogue, ...) scale with the player like Daggerfall's class enemies.
      id: f.mobile, name: f.kind, behaviour: 'general', affinity: 'human', texture: row[1], corpse: [380, 1],
      hasIdle: true, minMetal: -1, attacks: [[1, 4 + level * 2]], health: [10 + level * 6, 16 + level * 9],
      level, armor: 6, loot: 'A', attackFrames: 6, hitFrame: 3, origin: 'quest-fallback',
    };
    const hp = m.health[0] + Math.floor(nextRandom(inst) * (m.health[1] - m.health[0] + 1));
    const { w, ...at } = foeSpot(inst, k, f, n);
    return {
      id: entityId(p, inst, 'foe', k, n),
      kind: 'monster',
      name: f.mobile >= 128 ? `${f.name} the ${f.kind}` : f.kind,
      location: w.location,
      x: at.x,
      z: at.z,
      ...(Number.isFinite(at.y) ? { y: at.y } : {}),
      yaw: 0,
      hp,
      maxHp: hp,
      level: m.level,
      monsterId: f.mobile,
      behaviour: m.behaviour,
      sprite: { archive: f.gender === 'female' ? row[2] || row[1] : row[1], record: 0 },
      animation: 'idle',
      noLoot: true,
      quest: inst.title,
      visibleTo: [p.id],
      _m: m,
      _home: { x: at.x, z: at.z },
      _cooldown: 1,
      _targetId: null,
      _damageBy: new Map(),
      _quest: { owner: p.id, uid: inst.uid, foe: k },
      ...(f.team !== undefined ? { questTeam: f.team } : {}),
    };
  }

  const HOUSES = new Set([17, 18, 19, 20, 21, 22]);
  const SHOPS = new Set([0, 2, 5, 6, 7, 8, 9, 12, 13]);
  /** Binds quest places to real buildings once the interiors feature has surveyed the town. */
  function bindPlaces(inst) {
    const at = services.portals?.at;
    if (typeof at !== 'function') return;
    for (const [pk, pl] of Object.entries(inst.places)) {
      if (pl.interior || pl.noBuilding || pl.dungeon || pl.scope === 'permanent') continue;
      const selectedHome = pl.home && inst.people[pk.slice(5)]?.homeBuilding;
      const required = selectedHome || STARTER_TOWN_QUESTS.has(inst.name) || (inst.special === 'invitation' && pk === 'l.00')
        || (inst.special === 'summoning' && (pl.building === 'palace' || pl.building === 'tavern'));
      // A local place named by a giver standing indoors (every building work giver) is in the town around that
      // room, never the room itself. Older saves that bound it to the room move their people/foes/items with it.
      const town = typeof pl.location === 'string' && !pl.location.startsWith('town:') ? exteriorOf(pl.location) : null;
      if (town && town !== pl.location) {
        for (const t of [...Object.values(inst.people), ...Object.values(inst.foes), ...Object.values(inst.items)]) {
          if (t.place === pk && t.location === pl.location) {
            t.location = town;
            delete t.spawnAt;
            if ('markerAt' in t) t.markerAt = null;
          }
        }
        pl.location = town;
      }
      let list;
      try {
        list = at(pl.location).filter((x) => x.kind === 'building' && x.meta);
      } catch {
        continue;
      }
      if (!list.length) {
        // Survey the chosen buildings before the letter or journal sends the player there.
        if (required && services.interiors?.status?.(pl.location) === 'none') services.interiors.survey(pl.location).catch(() => {});
        continue;
      }
      const code = PLACE_TYPES.get(pl.building ?? '')?.p2;
      let match = list.filter((x) => {
        const t = x.meta.buildingType;
        if (pl.building === 'house') return HOUSES.has(t);
        if (pl.building === 'shop') return SHOPS.has(t);
        if (pl.building === 'public') return !HOUSES.has(t); // a quest person's home building
        if (code === undefined || code < 0) return true;
        return t === code;
      });
      if (!match.length && inst.special === 'invitation' && pl.building === 'house1') {
        match = list.filter((x) => HOUSES.has(x.meta.buildingType));
      }
      if (!match.length && required) {
        const region = services.travel?.lookup?.(pl.location)?.regionIndex;
        const rejected = (pl.rejected ??= []);
        rejected.push(pl.location);
        const towns = services.travel?.regionLocations?.(region)?.filter((e) => e.type === 'city' && !rejected.includes(e.id)) ?? [];
        if (towns.length) {
          const next = towns[Math.floor(nextRandom(inst) * towns.length)].id;
          pl.location = next;
          for (const resource of [...Object.values(inst.people), ...Object.values(inst.items)]) {
            if (resource.place !== pk) continue;
            if (resource.home && pl.home) resource.home = next;
            if (resource.location) resource.location = next;
            delete resource.spawnAt;
            delete resource.markerAt;
          }
          continue;
        }
      }
      if (!match.length) {
        pl.noBuilding = true; // this town has none: the town itself stands in (reported as approximate)
        continue;
      }
      const pick = match[hash32(`${inst.uid}:${pl.building}:${pl.location}`) % match.length];
      pl.interior = pick.to;
      pl.label = pick.label;
      if (pick.meta?.buildingName) pl.buildingName = pick.meta.buildingName;
      const entrance = pick.entrances?.[0];
      const enter = entrance?.enter ?? entrance?.inner;
      pl.door = enter ? {
        x: enter.x, z: enter.z,
        ...(Number.isFinite(enter.y) ? { y: enter.y } : {}),
        ...(Number.isFinite(enter.yaw) ? { yaw: enter.yaw } : {}),
      } : null;
    }
  }

  function noteQuestClues(inst, clues) {
    for (const [key, label] of Object.entries(clues ?? {})) {
      const place = inst.places[key];
      if (place && !place.clueLearned) place.clue = label;
    }
  }

  function markQuestClues(p, inst) {
    for (const place of Object.values(inst.places)) {
      if (!place.clue || place.clueLearned || !place.interior) continue;
      const portal = services.portals?.into?.(place.interior);
      if (!portal || !services.automap?.learnPlace) continue;
      services.automap.learnPlace(p, { town: portal.from, portalId: portal.id, label: place.clue });
      place.clueLearned = true;
    }
  }
  /**
   * Puts items placed in a dungeon on one of its quest item markers (Place.AssignQuestResource: `marker n` when the
   * script names one, else a random item marker). A remote dungeon with no markers is replaced, as Daggerfall Unity
   * never selects one.
   */
  function bindMarkers(p, inst) {
    for (const it of Object.values(inst.items)) {
      if (!it.location || it.held || it.handedOver || it.markerAt || !it.place) continue;
      const pl = inst.places[it.place];
      if (!pl?.interior || it.location !== pl.location) continue;
      const list = markersOf(pl.interior);
      if (list === 'pending' || markerCache.get(pl.interior) instanceof Error) continue;
      if (!pl.interior.startsWith('dungeon:')) {
        // A building without item markers keeps the door-relative spot (snapped onto clear floor when shown).
        if (list instanceof Error || !list.length) { it.markerAt = { id: null }; continue; }
      } else if (list instanceof Error || !list.length) {
        if (pl.dungeon && !pl.revealed && (pl.rejected?.length ?? 0) < 5) {
          pl.rejected = [...(pl.rejected ?? []), pl.interior];
          const d = pickDungeon(p, inst, defOf(inst.name)?.resources.get(it.place), pl.rejected);
          if (d) Object.assign(pl, d);
          it.location = pl.location;
        } else if (!inst.notes.includes(`no quest marker in ${pl.interior}`)) inst.notes.push(`no quest marker in ${pl.interior}`);
        continue;
      }
      const m = it.marker !== null && it.marker !== undefined && list[it.marker] ? list[it.marker] : list[hash32(`${inst.uid}:${pl.interior}`) % list.length];
      it.markerAt = { id: m.id, ...(m.block ? { block: m.block } : {}), x: m.x, y: m.floor ?? m.y, z: m.z };
    }
  }

  /** People and foes placed in a building or dungeon stand on its quest person markers (distinct per resource). */
  function bindSpawns(p, inst) {
    const things = [...Object.entries(inst.people).map(([k, v]) => [`p:${k}`, v]), ...Object.entries(inst.foes).map(([k, v]) => [`f:${k}`, v])];
    for (const [k, t] of things) {
      if (!t.place || t.spawnAt || !t.location) continue;
      const pl = inst.places[t.place];
      if (!pl?.interior || t.location !== pl.location) continue;
      const list = spawnsOf(pl.interior);
      if (list === 'pending' || spawnCache.get(pl.interior) instanceof Error) continue;
      if (pl.interior.startsWith('dungeon:') && (list instanceof Error || !list.length)) {
        // Place.SelectRemoteDungeonSite only picks dungeons with the markers a quest needs: an unrevealed site is
        // replaced; a revealed one falls back to its quest item markers so the person or foe is still reachable.
        if (pl.dungeon && !pl.revealed && (pl.rejected?.length ?? 0) < 5) {
          pl.rejected = [...(pl.rejected ?? []), pl.interior];
          const d = pickDungeon(p, inst, defOf(inst.name)?.resources.get(t.place), pl.rejected);
          if (d) {
            Object.assign(pl, d);
            for (const x of [...Object.values(inst.people), ...Object.values(inst.foes), ...Object.values(inst.items)]) if (x.place === t.place) { x.location = pl.location; delete x.spawnAt; if ('markerAt' in x) x.markerAt = null; }
          }
          continue;
        }
        const items = spawnsOf(pl.interior, spawnItemCache, 'questItemMarkers');
        if (items === 'pending') continue;
        if (Array.isArray(items) && items.length) {
          const m = items[hash32(`${inst.uid}:${k}`) % items.length];
          t.spawnAt = { id: m.id, x: m.x, y: m.floor ?? m.y, z: m.z, fallback: 'item' };
          continue;
        }
      }
      if (list instanceof Error || !list.length) { t.spawnAt = { id: null }; continue; }
      // An explicit index addresses the authored list. Otherwise, use a free marker when possible.
      const used = new Set(things.filter(([k2, o]) => k2 !== k && o.spawnAt?.id && o.place === t.place).map(([, o]) => o.spawnAt.id));
      const free = list.filter((m) => !used.has(m.id));
      const pool = free.length ? free : list;
      const m = list[t.marker] ?? pool[hash32(`${inst.uid}:${k}`) % pool.length];
      t.spawnAt = { id: m.id, x: m.x, y: m.floor ?? m.y, z: m.z };
    }
  }

  const doorOf = (pl) => {
    if (!pl) return null;
    if (pl.interior) {
      const entrance = services.portals?.into?.(pl.interior)?.entrances?.[0];
      const enter = entrance?.enter ?? entrance?.inner;
      if (enter && Number.isFinite(enter.x) && Number.isFinite(enter.z)) {
        return {
          x: enter.x, z: enter.z,
          ...(Number.isFinite(enter.y) ? { y: enter.y } : {}),
          ...(Number.isFinite(enter.yaw) ? { yaw: enter.yaw } : {}),
        };
      }
    }
    return pl.door ?? null;
  };
  const whereOf = (inst, thing) => {
    const pl = thing.place ? inst.places[thing.place] : null;
    if (pl && thing.location === pl.location && pl.interior) return { location: pl.interior, door: doorOf(pl) };
    return { location: thing.location, door: null };
  };
  const near = (door, at) => {
    if (!door) return at;
    if (Number.isFinite(door.yaw)) {
      const fx = Math.sin(door.yaw);
      const fz = -Math.cos(door.yaw);
      const rx = Math.cos(door.yaw);
      const rz = Math.sin(door.yaw);
      const fwd = 1.5 + Math.abs(at.z) * 0.15;
      const side = at.x * 0.45;
      return { x: door.x + fx * fwd + rx * side, z: door.z + fz * fwd + rz * side };
    }
    return { x: door.x + at.x * 0.6, z: door.z + 1.5 + Math.abs(at.z) * 0.15 };
  };

  /**
   * Places a fallback quest NPC or item on verified walkable floor reachable from the interior entrance.
   * Prevents spawning behind an inward-facing doorway outside the room's collision hull.
   */
  function interiorFallbackSpot(location, door, fallbackAt, id) {
    const world = services.collision?.instanceWorld?.(location);
    if (!world || !door) {
      const guess = near(door, fallbackAt);
      if (door && !world && services.collision?.instanceWorld) {
        return { x: guess.x, z: guess.z, y: door.y, snapped: false };
      }
      const c = services.collision?.nearestClear?.(location, guess.x, guess.z, 4);
      if (c) return { x: c.x, z: c.z, y: c.y, snapped: true };
      return { x: guess.x, z: guess.z, snapped: !services.collision?.nearestClear };
    }
    const baseY = Number.isFinite(door.y) ? world.heightAt(door.x, door.z, door.y) : world.standHeight(door.x, door.z);
    const anchor = world.isClear(door.x, door.z, baseY)
      ? { x: door.x, z: door.z, y: baseY }
      : (world.nearestClear(door.x, door.z, { maxDist: 1.5, y: baseY }) ?? { x: door.x, z: door.z, y: baseY });
    const yaws = Number.isFinite(door.yaw) ? [door.yaw] : [0, Math.PI, Math.PI / 2, -Math.PI / 2];
    const lat = ((hash32(id) % 5) - 2) * 0.45;
    const sides = [...new Set([lat, -lat, 0, 0.8, -0.8, 1.4, -1.4])];
    const dists = [1.6, 2.2, 1.0, 2.8, 0.6, 3.4];
    let bestPartial = null;
    for (const yaw of yaws) {
      const fx = Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const rx = Math.cos(yaw);
      const rz = Math.sin(yaw);
      for (const d of dists) {
        for (const s of sides) {
          const cx = anchor.x + fx * d + rx * s;
          const cz = anchor.z + fz * d + rz * s;
          const m = world.move(anchor.x, anchor.z, cx, cz, { y: anchor.y });
          if (!world.isClear(m.x, m.z, m.y)) continue;
          const moved = Math.hypot(m.x - anchor.x, m.z - anchor.z);
          if (Math.hypot(m.x - cx, m.z - cz) < 0.35 && moved >= 0.4) {
            return { x: m.x, z: m.z, y: m.y, snapped: true };
          }
          if (moved >= 0.25 && (!bestPartial || moved > bestPartial.moved)) {
            bestPartial = { x: m.x, z: m.z, y: m.y, moved, snapped: true };
          }
        }
      }
    }
    return bestPartial ?? { x: anchor.x, z: anchor.z, y: anchor.y, snapped: true };
  }

  /** Brings ctx.entities in line with the player's quest state. */
  function syncEntities(p) {
    const q = p.rpg?.quests;
    const waiting = new Map();
    function waitingOn(cache, location) {
      const markers = cache.get(location);
      if (markers instanceof Error) {
        waiting.set(location, { status: 'failed', error: markers.message });
        return true;
      }
      if (markers !== 'pending') return false;
      if (!waiting.has(location)) waiting.set(location, { status: 'loading' });
      return true;
    }
    const want = new Map();
    const wantAt = new Map(); // id -> location the entity should be in (people and items)
    const wantMarker = new Map();
    const unsnapped = new Set(); // items shown before their instance's collision was ready
    if (q && ctx.players.get(p.id) === p) {
      for (const inst of q.active) {
        for (const [k, person] of Object.entries(inst.people)) {
          if ((person.questor && !person.moved) || !person.location || person.hidden || person.destroyed) continue;
          // Placed individuals are played by a private copy of the same person (their home record is hidden for
          // this player through services.npcs.setIndividualAway).
          const id = entityId(p, inst, 'npc', k);
          const w = whereOf(inst, person);
          const inside = /^(dungeon|interior):/.test(w.location ?? '');
          if (inside && !person.spawnAt) {
            waitingOn(spawnCache, w.location);
            continue;
          }
          const marked = inside && person.spawnAt.id !== null;
          let at = marked ? { x: person.spawnAt.x, z: person.spawnAt.z, y: person.spawnAt.y } : near(w.door, spot(id, Object.keys(inst.people).indexOf(k)));
          if (!marked && inside) {
            const placed = interiorFallbackSpot(w.location, w.door, spot(id, Object.keys(inst.people).indexOf(k)), id);
            at = { x: placed.x, z: placed.z, y: placed.y };
            if (!placed.snapped) unsnapped.add(id);
          }
          wantAt.set(id, w.location);
          if (marked && person.marker != null) wantMarker.set(id, person.spawnAt.id);
          want.set(id, () => ({
            id, kind: 'npc', role: 'townsfolk', title: 'Resident', name: person.name, location: w.location,
            x: at.x, z: at.z, ...(Number.isFinite(at.y) ? { y: at.y } : {}),
            yaw: Math.PI, sprite: person.sprite ?? { archive: 334, record: [0, 2, 8, 12, 18][hash32(id) % 5] },
            faction: person.faction ?? 201, ...(person.individual !== undefined ? { individual: true } : {}),
            quest: inst.title, visibleTo: [p.id], _quest: { owner: p.id, uid: inst.uid, person: k },
          }));
        }
        for (const [k, f] of Object.entries(inst.foes)) {
          if (!f.location || f.removed) continue;
          const alive = f.count * Math.max(1, f.ambush || 1) - f.kills;
          if (alive > 0 && !f.spawnAt && f.place && waitingOn(spawnCache, whereOf(inst, f).location)) continue;
          for (let n = 0; n < alive; n++) {
            const id = entityId(p, inst, 'foe', k, f.kills + n);
            want.set(id, () => makeFoe(p, inst, k, f, f.kills + n));
            wantAt.set(id, whereOf(inst, f).location); // re-homed (alive only) when its place binds later
            if (f.marker != null && f.spawnAt?.id != null) wantMarker.set(id, f.spawnAt.id);
          }
        }
        for (const [k, it] of Object.entries(inst.items)) {
          if (!it.location || it.held || it.handedOver) continue;
          const id = entityId(p, inst, 'item', k);
          const ground = itemArt(it.art, p.rpg.character, { ground: true });
          const w = whereOf(inst, it);
          const inside = /^(dungeon|interior):/.test(w.location ?? '');
          if (inside && !it.markerAt) {
            waitingOn(markerCache, w.location);
            continue;
          }
          const onMarker = inside && it.markerAt.id !== null && Number.isFinite(it.markerAt.x);
          let at = onMarker ? { x: -it.markerAt.x, z: it.markerAt.z } : near(w.door, spot(id, 5));
          let snapped = true;
          if (!onMarker && inside) {
            const placed = interiorFallbackSpot(w.location, w.door, spot(id, 5), id);
            at = { x: -placed.x, z: placed.z };
            snapped = placed.snapped;
          } else if (!onMarker) {
            // Never inside furniture or walls: the nearest clear floor (when that instance's collision is loaded).
            const c = services.collision?.nearestClear?.(w.location, -at.x, at.z, 4);
            if (c) at = { x: -c.x, z: c.z };
            else snapped = !services.collision?.nearestClear;
          }
          if (!snapped) unsnapped.add(id);
          const inDungeon = onMarker;
          wantAt.set(id, w.location);
          want.set(id, () => ({
            id, kind: 'questItem', name: it.name, location: w.location, x: -at.x, z: at.z,
            ...(inDungeon ? { y: it.markerAt.y, marker: it.markerAt.id } : {}),
            quest: inst.title, itemArt: it.art, sprite: ground ? { archive: ground.archive, record: ground.record } : undefined,
            visibleTo: [p.id], _quest: { owner: p.id, uid: inst.uid, item: k },
          }));
        }
      }
    }
    const mine = owned.get(p.id) ?? new Set();
    for (const id of mine) {
      const e = ctx.entities.get(id);
      if (e?.dead) continue; // corpses stay for looting until the tick clears them
      if (!want.has(id)) {
        ctx.entities.delete(id);
        mine.delete(id);
      }
    }
    for (const [id, make] of want) {
      const cur = ctx.entities.get(id);
      const where = wantAt.get(id);
      const marker = wantMarker.get(id);
      // Re-home a living entity whose place was bound to a building or marker after it first appeared.
      if (cur && !cur.dead && ((where !== undefined && cur.location !== where) ||
          (marker !== undefined && cur._questMarker !== marker))) ctx.entities.delete(id);
      else if (cur && cur._unsnapped && !unsnapped.has(id)) ctx.entities.delete(id); // collision arrived: re-place
      if (!ctx.entities.has(id)) {
        const e = make();
        if (marker !== undefined) e._questMarker = marker;
        if (unsnapped.has(id)) e._unsnapped = true;
        ctx.entities.set(id, e);
        mine.add(id);
      }
    }
    owned.set(p.id, mine);
    waitingForMarkers.set(p, waiting);
    if (ctx.players.get(p.id) === p) syncAway(p);
  }

  function clearEntities(p) {
    for (const id of owned.get(p.id) ?? []) ctx.entities.delete(id);
    owned.delete(p.id);
    syncAway(p, true);
  }

  /**
   * Source people a quest keeps away from this player only: a questor under `hide npc` (A0C10Y05's giver travels
   * with the player as a face) and an individual placed elsewhere. Reconciled from the saved instance, so it holds
   * across a restart and clears on `restore npc`, `npc at home` and the end of the quest.
   */
  const awayNow = new Map(); // player id -> {people:Set(entity id), individuals:Set(faction id)}
  function syncAway(p, gone = false) {
    const npcs = services.npcs;
    if (!npcs) return;
    const want = { people: new Set(), individuals: new Set() };
    if (!gone) {
      for (const inst of ensure(p).active) {
        for (const person of Object.values(inst.people)) {
          if (person.questor && person.entityId && (person.hidden || person.destroyed)) want.people.add(person.entityId);
          if (person.individual !== undefined && person.location) want.individuals.add(person.individual);
        }
      }
    }
    const had = awayNow.get(p.id) ?? { people: new Set(), individuals: new Set() };
    try {
      for (const id of want.people) if (!had.people.has(id)) npcs.setPersonAway?.(id, p.id, true);
      for (const id of had.people) if (!want.people.has(id)) npcs.setPersonAway?.(id, p.id, false);
      for (const f of want.individuals) if (!had.individuals.has(f)) npcs.setIndividualAway?.(f, p.id, true);
      // Individuals released by the quest itself (finish, npc at home) are cleared there; a leaving player keeps the
      // record so the next join re-applies it.
    } catch { /* NPC feature absent */ }
    if (gone) awayNow.delete(p.id);
    else awayNow.set(p.id, want);
  }

  // ---------------------------------------------------------------- running quests

  function finish(p, q, inst) {
    const def = defOf(inst.name);
    for (const person of Object.values(inst.people)) {
      if (person.individual !== undefined && person.location) hostFor(p).individualAway(inst, person.individual, false);
    }
    q.active = q.active.filter((x) => x !== inst);
    const doneLog = inst.log.length ? inst.log.map((e) => e.text).slice(-4) : (inst.messages ?? []).map((m) => m.text).slice(-2);
    q.done.unshift({ uid: inst.uid, name: inst.name, title: inst.title, result: inst.status, endedAt: inst.endedAt, giver: inst.giver?.name ?? null, log: doneLog });
    q.done.length = Math.min(q.done.length, MAX_DONE);
    ctx.notify(p, { kind: 'questEnd', uid: inst.uid, title: inst.title, result: inst.status });
    // Ordinary offers carry their Quest.FactionId; special starts keep the faction their trigger supplied.
    const factionId = Object.hasOwn(inst, 'factionId') ? inst.factionId : inst.giver?.faction ?? null;
    const reputation = Object.hasOwn(inst, 'factionId') ? (inst.status === 'success' ? 5 : inst.status === 'failed' ? -2 : 0) : undefined;
    const payload = {
      player: p, quest: { name: inst.name, uid: inst.uid, title: inst.title, factionId }, factionId, source: 'quests',
      ...(reputation !== undefined ? { reputation } : {}),
    };
    if (inst.status === 'success') ctx.emit('questComplete', payload);
    else if (inst.status === 'failed') ctx.emit('questFailed', payload);
    else ctx.emit('questEnded', payload);
  }

  /** Runs every active quest of `p` (a few passes so chained tasks settle). Returns true when state changed. */
  const pendingStarts = new Map(); // player id -> [{name, from}] scheduled by `start quest`
  const running = new Set();
  const again = new Set();

  /** Starts a story quest for `p` (StartQuest.cs / QuestMachine.ScheduleQuest). Returns the instance or null. */
  function startStory(p, name, from = null) {
    const q = ensure(p);
    const entry = cat().quests.get(String(name).toUpperCase());
    if (!entry) {
      ctx.notify(p, { kind: 'questMessage', text: `${name} is not installed on this server.` });
      log.warn?.(`[quests] start quest ${name}: not installed`);
      return null;
    }
    if (q.active.some((i) => i.name === entry.name)) return null; // already running for this player
    const seed = hash32(`${p.id}:${entry.name}:${q.seq}:${from ?? ''}`);
    const uid = `${entry.name}-${(++q.seq).toString(36)}-${(seed % 46656).toString(36)}`;
    const inst = createInstance(entry.def, { uid, seed, giver: null, host: hostFor(p), now: nowFor(p) });
    inst.title = entry.def.displayName || storyTitle(entry.name) || inst.title;
    if (entry.name === '_BRISIEN' || entry.name === 'S0000008') {
      for (const place of Object.values(inst.places)) {
        if (place.building === 'tavern' && place.location) services.interiors?.survey?.(place.location)?.catch(() => {});
      }
    }
    inst.story = true;
    if (BACKGROUND_STORY_QUESTS.has(entry.name)) inst.background = true;
    inst.startedBy = from;
    inst.acceptedAt = nowFor(p);
    inst.report = { source: entry.source, approximations: entry.analysis.approximations.slice(0, 12), ignored: entry.analysis.ignored.length, unsupported: entry.analysis.unsupported.slice(0, 12) };
    q.active.push(inst);
    ctx.dirty(p);
    ctx.notify(p, { kind: 'questAccepted', uid: inst.uid, title: inst.title, text: '', ...(inst.background ? { background: true } : {}) });
    return inst;
  }

  function run(p) {
    if (running.has(p.id)) {
      again.add(p.id); // re-entered from an effect (a quest transfer emits locationChanged); finish first
      return false;
    }
    running.add(p.id);
    try {
      let changed = false;
      for (let round = 0; round < 4; round++) {
        again.delete(p.id);
        changed = runOnce(p) || changed;
        const starts = pendingStarts.get(p.id);
        pendingStarts.delete(p.id);
        for (const s of starts ?? []) if (startStory(p, s.name, s.from)) { changed = true; again.add(p.id); }
        if (!again.has(p.id)) break;
      }
      return changed;
    } finally {
      running.delete(p.id);
      again.delete(p.id);
    }
  }

  function runOnce(p) {
    const q = ensure(p);
    if (!q.active.length) {
      waitingForMarkers.delete(p);
      return false;
    }
    const before = JSON.stringify(q.active) + JSON.stringify(q.globals);
    const host = hostFor(p);
    for (const inst of [...q.active]) {
      for (const k of Object.keys(inst.people)) assignHome(inst, k); // saves from before quest people had homes
      bindPlaces(inst);
      bindMarkers(p, inst);
      bindSpawns(p, inst);
      const def = defOf(inst.name);
      if (!def) {
        inst.unavailable = true;
        continue;
      }
      inst.unavailable = false;
      updateSavedCampaignInstance(inst, def);
      for (const [k, it] of Object.entries(inst.items)) {
        const resource = def.resources.get(k);
        if (resource?.label) it.name = resource.label;
        if (!Object.hasOwn(it, 'art')) it.art = questItemArt(it, resource);
        if (!Object.hasOwn(it, 'dropPlaces')) it.dropPlaces = dropPlaces(def, k);
        if (inst.story && it.className === 'artifact' && !it.template && resource) {
          it.template = host.itemTemplate(resource, inst);
          if (it.template && it.permanent) host.permanentItem(inst, k);
        }
        if (resource && it.className !== 'artifact' && reviseSavedQuestItem(it, resource, () => host.itemTemplate(resource, inst))) {
          it.art = questItemArt(it, resource);
          if (it.template && it.permanent && it.held) host.permanentItem(inst, k);
        }
      }
      for (let pass = 0; pass < 4 && inst.status === 'active'; pass++) updateQuest(def, inst, host, nowFor(p));
      // Things placed by this update stand on their markers straight away when those are already known.
      bindPlaces(inst);
      markQuestClues(p, inst);
      bindMarkers(p, inst);
      bindSpawns(p, inst);
      if (inst.status !== 'active') finish(p, q, inst);
    }
    syncEntities(p);
    return JSON.stringify(q.active) + JSON.stringify(q.globals) !== before;
  }

  // ---------------------------------------------------------------- offers

  function eligible(p, entry, group, giver) {
    const m = entry.meta;
    if (m.group !== group || !entry.analysis.offerable) return false;
    if (m.adult && !allowAdult) return false;
    const q = ensure(p);
    if (m.oneTime && q.oneTime.includes(entry.name)) return false;
    if (q.active.some((i) => i.name === entry.name)) return false;
    const guild = GUILD_OF_GROUP[group];
    if (guild) {
      const scoped = guild.guild === 'temple' || guild.guild === 'knights';
      const hall = scoped ? services.guilds?.hallOf?.(giver) : null;
      const faction = guild.factionId ?? hall?.variant ?? giver.building?.factionId ?? giver.faction;
      if (m.deity !== undefined && faction !== m.deity && faction !== DIVINES[m.deity]?.order) return false;
      const rank = services.guildRank?.(p, guild.guild, scoped ? { factionId: faction } : undefined)
        ?? (m.deity === undefined ? null : services.templeRank?.(p, m.deity));
      const member = rank !== null && rank !== undefined;
      // DaggerfallGuildServicePopupWindow.GetQuest: IsSatisfyQuestReqByLevel (Mages Guild, knightly orders) lets the
      // player's level stand in for a lower rank.
      const effRank = member && (guild.guild === 'mages' || guild.guild === 'knights')
        ? Math.max(rank, Number(p.rpg?.character?.level) || 1) : rank;
      const status = member ? 'M' : 'N';
      const rep = services.reputation?.(p, faction) ?? 0;
      // 'P' (prospect) jobs are invitations started by their own trigger (package 19), never an ordinary offer.
      if (m.deity === undefined ? m.membership !== status : !member) return false;
      return (status === 'N' && m.minReq === 0) || (m.minReq < 10 && m.minReq <= (effRank ?? 0) && member) || (m.minReq >= 10 && m.minReq <= rep);
    }
    const level = Number(p.rpg?.character?.level) || 1;
    const rep = services.reputation?.(p, giver.faction) ?? 0;
    // DaggerfallQuestOfferWindow.GetQuest passes questorNPC.gender to GetSocialQuest: the social M/F letter is the
    // giver's sex, not the player's (QuestList-Classic: "social: N=any, M=male, F=female").
    const male = String(giver.gender ?? 'male').toLowerCase() !== 'female';
    const sexOk = m.membership === 'N' || m.membership === 'P' || (m.membership === 'M' && male) || (m.membership === 'F' && !male);
    return sexOk && ((m.minReq < 10 && m.minReq <= level) || rep >= m.minReq);
  }

  function makeOffer(p, giver) {
    const q = ensure(p);
    if (q.offer && q.offer.giver.id === giver.id) {
      ctx.notify(p, offerEvent(q.offer));
      return q.offer;
    }
    const group = groupOf(giver);
    if (!group) fail(`${giver.name} has no work for you.`);
    if (q.active.length >= MAX_ACTIVE) fail('Your journal is full. Finish some of your current work first.');
    const pool = [...cat().quests.values()].filter((e) => eligible(p, e, group, giver)).sort((a, b) => a.name.localeCompare(b.name));
    if (!pool.length) {
      const any = [...cat().quests.values()].some((e) => e.meta.group === group);
      fail(any ? `${giver.name} has no work for you right now.` : `${giver.name} has no work for you (this server has no ${group} quests installed).`);
    }
    const day = Math.floor(worldMinutes() / 1440);
    const seed = hash32(`${p.id}:${giver.id}:${day}:${q.seq}`);
    // Skip an impossible site, such as a local dungeon in a town without one or a required dungeon type
    // absent from this region. Daggerfall Unity draws another quest when site setup fails.
    let entry, uid, inst;
    for (let i = 0; i < pool.length; i++) {
      entry = pool[(seed + i) % pool.length];
      uid = `${entry.name}-${(q.seq + 1).toString(36)}-${(seed % 46656).toString(36)}`;
      const factionId = questFactionId(group, giver);
      inst = createInstance(entry.def, {
        uid, seed,
        giver: { ...giver, gender: giver.gender, factionName: giver.factionName ?? factionNameOf(factionId ?? giver.faction) },
        host: hostFor(p), now: nowFor(p),
      });
      if (!Object.entries(inst.places).some(([key, pl]) =>
        !pl.interior && (pl.local || (pl.dungeon && entry.def.resources.get(key)?.only)))) break;
      inst = null;
    }
    if (!inst) fail(`${giver.name} has no work for you right now.`);
    q.seq++;
    inst.factionId = questFactionId(group, giver);
    const town = townName(giver.location);
    if (town) inst.giver.townName = town;
    bindPlaces(inst);
    inst.report = { source: entry.source, approximations: entry.analysis.approximations.slice(0, 12), ignored: entry.analysis.ignored.length };
    const offerText = hostFor(p).text(inst, MSG.OFFER) ?? '';
    q.offer = { id: uid, name: entry.name, title: inst.title, text: offerText, giver: { id: giver.id, name: giver.name }, inst };
    ctx.notify(p, offerEvent(q.offer));
    return q.offer;
  }

  /**
   * Quest.FactionId of an ordinary offer, which takes the classic +5 / −2 at the end (Quest.EndQuest): the questor's
   * own faction for social and coven work (DaggerfallQuestOfferWindow, DaggerfallWitchesCovenPopupWindow); for guild
   * work DaggerfallGuildServicePopupWindow.GetFactionIdForGuild, the hall building's faction for temples and knightly
   * orders, otherwise the guild's fixed faction.
   */
  function questFactionId(group, giver) {
    const guild = GUILD_OF_GROUP[group];
    if (!guild) return Number.isInteger(giver?.faction) ? giver.faction : null;
    if (guild.factionId) return guild.factionId;
    const hall = services.guilds?.hallOf?.(giver);
    const id = hall?.factionId ?? giver?.building?.factionId ?? null;
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  /** Quest pool of a giver: the NPC feature's source-derived questGroup, else the role table. */
  function groupOf(e) {
    return (typeof e?.questGroup === 'string' && e.questGroup) || roleGroups[e?.role] || null;
  }

  const offerEvent = (o) => ({ kind: 'questOffer', offerId: o.id, title: o.title, text: o.text, giver: o.giver });

  function questGiverNear(p, targetId) {
    let e;
    if (services.npcs?.nearNpc) {
      e = services.npcs.nearNpc(p, { targetId });
    } else {
      if (typeof targetId !== 'string' || !ID_RE.test(targetId)) fail('Ask whom?');
      e = ctx.entities.get(targetId);
      if (!e || e.kind !== 'npc') fail('There is nobody like that here.');
      if (e.visibleTo != null && !(e.visibleTo instanceof Set ? e.visibleTo.has(p.id) : e.visibleTo.includes?.(p.id))) fail('There is nobody like that here.');
      if (e.location !== locOf(p)) fail(`${e.name} is not here.`);
      if (!(Math.hypot(e.x - p.x, e.z - p.z) <= TALK_RANGE)) fail(`You are too far away from ${e.name}.`);
    }
    if (!e.questGiver) fail(`${e.name} has no work to offer.`);
    return e;
  }

  // ---------------------------------------------------------------- hooks

  /**
   * Saves from before source people existed name the questor by an old roster id (`npc:<hash>:<slot>`). The NPC
   * feature maps it to the source person who now plays that part in the same town; no stand-in is ever spawned.
   */
  const LEGACY_NPC = /^npc:[^:]+:\d+$/;
  async function migrateGiver(p, inst) {
    if (!inst.giver) return;
    const current = () => ctx.players.get(p.id) === p && ensure(p).active.find(i => i.uid === inst.uid);
    const resolve = services.npcs?.resolve;
    const old = inst.giver.id;
    if (resolve && LEGACY_NPC.test(old) && !inst.giver.migrated) {
      const hit = await resolve(old, inst.giver.location);
      const live = current();
      if (!live || live.giver?.id !== old) return;
      if (hit?.id && hit.id !== old) {
        live.giver = { ...live.giver, id: hit.id, location: hit.location ?? live.giver.location, migrated: old };
        for (const person of Object.values(live.people)) if (person.entityId === old) { person.entityId = hit.id; person.location = hit.location ?? person.location; }
        ctx.dirty(p);
      }
      inst = live;
    }
    // Characters saved before named buildings already have the giver's permanent room address.
    const { id, location, buildingName } = inst.giver;
    if (buildingName || typeof location !== 'string' || !location.startsWith('interior:')) return;
    const name = services.portals?.into?.(location)?.meta?.buildingName
      || (await services.npcs?.source?.interior?.(location))?.building?.name;
    const giver = current()?.giver;
    if (!name || !giver || giver.id !== id || giver.location !== location || giver.buildingName) return;
    giver.buildingName = name;
    ctx.dirty(p);
  }

  ctx.onJoin((p) => {
    const q = ensure(p);
    deliverCampaignRewards(ctx, p);
    const location = locOf(p);
    if (spawnCache.get(location) instanceof Error) spawnCache.delete(location);
    if (markerCache.get(location) instanceof Error) markerCache.delete(location);
    // Offers do not survive a reconnect; the giver can be asked again.
    q.offer = null;
    for (const inst of q.active) migrateGiver(p, inst).catch(() => {});
    run(p);
  });
  ctx.onLeave((p) => clearEntities(p));

  ctx.on('npcWork', (ev) => {
    const p = ev?.player;
    const e = ev?.entity;
    if (!p?.rpg || !e || !e.questGiver || !groupOf(e)) return;
    try {
      makeOffer(p, e);
    } catch (err) {
      ctx.notify(p, { kind: 'questMessage', text: err.message });
    }
  });

  ctx.on('talk', (ev) => {
    const p = ev?.player;
    const e = ev?.entity;
    if (!p?.rpg?.quests || !e) return;
    let hit = false;
    const individual = e.individual && Number.isInteger(e.faction) && !e._quest ? e.faction : null;
    if (individual !== null && e.location !== locOf(p)) return;
    for (const inst of p.rpg.quests.active) {
      for (const person of Object.values(inst.people)) {
        const giverClick = person.entityId === e.id && !person.moved;
        const ownClick = e._quest?.owner === p.id && e._quest?.uid === inst.uid && inst.people[e._quest.person] === person;
        // The authored individual counts while the quest has not moved them elsewhere.
        const homeClick = individual !== null && person.individual === individual && !person.location;
        if (giverClick || ownClick || homeClick) {
          person.clicked = true;
          hit = true;
        }
      }
      if (individual !== null) {
        inst.individualClicks = [...new Set([...(inst.individualClicks ?? []), individual])].slice(-8);
        hit = true;
      }
    }
    if (individual === 303) services.interiors?.prepareQuestTransfer?.()?.catch?.(() => {}); // Nulfaga: warm the transfer
    if (hit) {
      ctx.dirty(p);
      run(p);
    }
  });

  ctx.on('kill', (ev) => {
    const e = ev?.entity;
    const meta = e?._quest;
    if (!meta?.foe) return;
    const owner = ctx.players.get(meta.owner);
    const inst = owner?.rpg?.quests?.active.find((i) => i.uid === meta.uid);
    if (!inst) return;
    const f = inst.foes[meta.foe];
    if (!f) return;
    ctx.dirty(owner);
    f.kills += 1;
    f.injured = true;
    for (const k of f.holds) {
      const it = inst.items[k];
      if (it && it.holder === meta.foe) {
        it.held = true;
        it.handedOver = false;
        it.location = null;
        it.holder = null;
      }
    }
    f.holds = [];
    e._questDeadAt = ctx.now();
    run(owner);
  });

  /** Quest effects never abort another feature's action (a failed reward is logged, the move still happens). */
  const safeRun = (p) => {
    try {
      run(p);
    } catch (err) {
      log.error?.('[quests] update failed:', err);
    }
  };

  ctx.on('travel', (ev) => {
    if (ev?.player?.rpg) {
      ctx.dirty(ev.player);
      safeRun(ev.player);
    }
  });

  ctx.on('locationChanged', (ev) => {
    if (ev?.player?.rpg?.quests?.active?.length) {
      ctx.dirty(ev.player);
      safeRun(ev.player);
    }
  });

  // Another feature changed a global quest variable (the Mantella sets FinishedMantellanCrux, index 36).
  ctx.on('questGlobal', (ev) => {
    const p = ev?.player;
    const i = Number(ev?.index);
    if (!p?.rpg || !Number.isInteger(i) || i < 0 || i > 63) return;
    if (ev.value !== false && !acceptsCampaignGlobal(p, locOf(p), i)) return;
    hostFor(p).setGlobal(i, ev.value !== false);
    safeRun(p);
  });

  // Classic 0x49 "cast spell N do task": a standard SPELLS.STD spell cast by the questee (custom spells never count).
  ctx.on('spellCast', (ev) => {
    const p = ev?.player;
    const q = p?.rpg?.quests;
    if (!q?.active?.length) return;
    const m = /^std:(\d+)$/.exec(String(ev.spell?.id ?? ''));
    const index = Number.isInteger(ev.spell?.standardIndex) ? ev.spell.standardIndex : m ? Number(m[1]) : null;
    if (index === null) return;
    let hit = false;
    for (const inst of q.active) {
      const def = defOf(inst.name);
      if (!def?.tasks.some((t) => t.actions.some((a) => a.name === 'castSpellDo' && a.args.spell === index))) continue;
      inst.casts = [...new Set([...(inst.casts ?? []), index])];
      hit = true;
    }
    if (hit) {
      ctx.dirty(p);
      safeRun(p);
    }
  });

  ctx.on('timeSpent', (ev) => {
    const p = ev?.player;
    if (!p?.rpg || !(ev.minutes > 0)) return;
    if (typeof services.playerMinutes !== 'function') ensure(p).minutes += ev.minutes; // else the calendar ledger counts it
    ctx.dirty(p);
  });

  let acc = 0;
  ctx.onTick((dt) => {
    acc += dt;
    if (acc < TICK_SECONDS) return;
    acc = 0;
    const t = ctx.now();
    for (const [pid, ids] of owned) {
      const p = ctx.players.get(pid);
      for (const id of ids) {
        const e = ctx.entities.get(id);
        if (!e) { ids.delete(id); continue; }
        if (e.dead && t - (e._questDeadAt ?? e._diedAt ?? t) > CORPSE_MS) { ctx.entities.delete(id); ids.delete(id); continue; }
        if (p && e._quest?.foe && !e.dead && e.hp < e.maxHp) {
          const inst = p.rpg?.quests?.active.find((i) => i.uid === e._quest.uid);
          const f = inst?.foes[e._quest.foe];
          if (f && !f.injured) { f.injured = true; ctx.dirty(p); }
        }
      }
    }
    for (const p of ctx.players.values()) {
      deliverCampaignRewards(ctx, p);
      if (!p.rpg?.quests?.active?.length) continue;
      try {
        if (run(p)) ctx.dirty(p);
      } catch (err) {
        log.error?.('[quests] update failed:', err);
      }
    }
  });

  // ---------------------------------------------------------------- actions

  const findInst = (p, uid) => {
    const inst = ensure(p).active.find((i) => i.uid === uid);
    if (!inst) fail('That quest is not in your journal.');
    return inst;
  };

  ctx.onAction('quest.request', (p, args) => {
    makeOffer(p, questGiverNear(p, args.targetId));
  });

  ctx.onAction('quest.accept', (p, args) => {
    const q = ensure(p);
    const o = q.offer;
    if (!o || o.id !== args.offerId) fail('That offer is no longer open.');
    if (q.active.length >= MAX_ACTIVE) fail('Your journal is full.');
    const giver = ctx.entities.get(o.giver.id);
    if (!giver || giver.location !== locOf(p)) fail(`${o.giver.name} is no longer here.`);
    q.offer = null;
    const inst = o.inst;
    inst.acceptedAt = nowFor(p);
    q.active.push(inst);
    const entry = cat().quests.get(inst.name);
    if (entry?.meta.oneTime && !q.oneTime.includes(inst.name)) q.oneTime.push(inst.name);
    const accept = hostFor(p).text(inst, MSG.ACCEPT);
    ctx.notify(p, { kind: 'questAccepted', uid: inst.uid, title: inst.title, text: accept ?? '' });
    run(p);
  });

  ctx.onAction('quest.refuse', (p, args) => {
    const q = ensure(p);
    const o = q.offer;
    if (!o || o.id !== args.offerId) fail('That offer is no longer open.');
    q.offer = null;
    ctx.notify(p, { kind: 'questRefused', title: o.title, text: hostFor(p).text(o.inst, MSG.REFUSE) ?? '' });
  });

  ctx.onAction('quest.answer', (p, args) => {
    const inst = findInst(p, args.uid);
    if (!inst.prompt) fail('There is no question waiting for an answer.');
    if (typeof args.yes !== 'boolean') fail('Answer yes or no.');
    answerPrompt(defOf(inst.name), inst, args.yes);
    run(p);
  });

  ctx.onAction('quest.use', (p, args) => {
    const inst = findInst(p, args.uid);
    const k = typeof args.item === 'string' ? key(args.item) : '';
    const it = inst.items[k];
    if (!it || !it.held) fail('You do not have that.');
    const host = hostFor(p);
    if (it.usedMessage) {
      const t = host.text(inst, it.usedMessage);
      if (t) ctx.notify(p, { kind: 'questMessage', uid: inst.uid, title: it.name, text: t });
    } else ctx.notify(p, { kind: 'questMessage', uid: inst.uid, title: it.name, text: `Nothing happens.` });
    if (useItem(defOf(inst.name), inst, k) && it.useSay) host.message(inst, it.useSay);
    noteQuestClues(inst, SPECIAL_QUESTS[inst.name]?.letters?.[k]);
    run(p);
  });

  ctx.onAction('quest.click', (p, args) => {
    if (typeof args.targetId !== 'string' || !ID_RE.test(args.targetId)) fail('Use what?');
    const e = ctx.entities.get(args.targetId);
    if (!e?._quest || e._quest.owner !== p.id) fail('There is nothing like that here.');
    if (e.location !== locOf(p)) fail('That is not here.');
    if (!(Math.hypot(e.x - p.x, e.z - p.z) <= TALK_RANGE)) fail('You are too far away.');
    const foot = p.rpg.portal?.to === locOf(p) ? p.rpg.portal.footY : null;
    if (Number.isFinite(e.y) && Number.isFinite(foot) && Math.abs(e.y - foot) > FLOOR_REACH) fail('That is on another level.');
    const inst = findInst(p, e._quest.uid);
    if (e._quest.item) {
      const it = inst.items[e._quest.item];
      if (!it) fail('There is nothing like that here.');
      it.held = true;
      it.clicked = true;
      it.location = null;
      ctx.notify(p, { kind: 'questMessage', uid: inst.uid, title: inst.title, text: `You take the ${it.name}.` });
    } else if (e._quest.person) {
      inst.people[e._quest.person].clicked = true;
    } else fail('Nothing happens.');
    run(p);
  });

  // Classic 0x05 "dropped item at place": put a held quest item down where the quest wants it.
  function dropPlaces(def, item) {
    return def.tasks.flatMap((t) => t.actions)
      .filter((a) => a.name === 'dropped' && key(a.args.item) === item)
      .map((a) => key(a.args.place));
  }

  ctx.onAction('quest.drop', (p, args) => {
    const inst = findInst(p, args.uid);
    const k = typeof args.item === 'string' ? key(args.item) : '';
    const it = inst.items[k];
    if (!it || !it.held) fail('You do not have that.');
    const def = defOf(inst.name);
    const host = hostFor(p);
    const here = def && dropPlaces(def, k).find((pk) => inst.places[pk] && host.isAt(inst.places[pk]));
    if (!here) fail(`This is not where the ${it.name} belongs.`);
    it.held = false;
    it.handedOver = true;
    it.droppedAt = here;
    ctx.notify(p, { kind: 'questMessage', uid: inst.uid, title: inst.title, text: `You leave the ${it.name} here.` });
    run(p);
  });

  ctx.onAction('quest.catalog', (p) => {
    const r = catalogReport(cat());
    ctx.notify(p, { kind: 'questCatalog', report: { ...r, failures: r.failures.slice(0, 20) } });
  });

  // ---------------------------------------------------------------- services

  services.quests = {
    get catalog() { return cat(); },
    report: () => catalogReport(cat()),
    analyse: (name) => {
      const e = cat().quests.get(String(name).toUpperCase());
      return e ? { ...e.analysis, source: e.source, meta: e.meta } : null;
    },
    offer: (p, giver) => makeOffer(p, giver),
    run,
    active: (p) => ensure(p).active,
    /** Operator/test entry: start a story quest for a player as `start quest` would (labelled fixtures only). */
    start: (p, name) => {
      const inst = startStory(p, name, 'operator');
      if (inst) run(p);
      return inst;
    },
    globals: (p) => ({ ...ensure(p).globals }),
    /**
     * Conversation hooks of `p`'s running quests for the NPC owner: rumours (add rumor mill), "tell me about" topics
     * (add dialog) and their links (dialog link), people muted for this player (mute npc) and people who speak for a
     * quest besides its giver (add … as questor). Names and texts are resolved for the player.
     */
    talk: (p) => {
      const out = { rumours: [], topics: [], links: [], muted: [], questors: [] };
      const nameOf = (inst, r) => {
        const x = r.kind === 'place' ? inst.places[r.key] : r.kind === 'person' ? inst.people[r.key] : inst.items[r.key];
        return x?.name ?? x?.site ?? x?.building ?? r.key;
      };
      for (const inst of ensure(p).active) {
        const ref = (r) => ({ uid: inst.uid, kind: r.kind, key: r.key, name: nameOf(inst, r) });
        for (const r of inst.rumours ?? []) out.rumours.push({ uid: inst.uid, id: r.id, text: r.text });
        for (const r of inst.dialog ?? []) out.topics.push(ref(r));
        for (const l of inst.dialogLinks ?? []) out.links.push(l.map(ref));
        for (const [k, person] of Object.entries(inst.people)) {
          const who = { uid: inst.uid, key: k, name: person.name, entityId: person.entityId ?? null, individual: person.individual ?? null };
          if (person.muted) out.muted.push(who);
          if (person.addedQuestor) out.questors.push(who);
        }
      }
      return out;
    },
    /**
     * Special triggers (package 19: Daedra summoning, invitations, cures). The trigger owner has already decided
     * eligibility; this runs the normal questOffer -> quest.accept/quest.refuse flow for one named quest.
     */
    offerSpecial: (p, name, { giver, source = 'special' } = {}) => {
      const entry = specialEntry(name);
      if (!giver?.id || !giver?.name) fail('offerSpecial needs a giver {id, name}.');
      const q = ensure(p);
      if (q.active.length >= MAX_ACTIVE) fail('Your journal is full. Finish some of your current work first.');
      if (q.active.some((i) => i.name === entry.name)) fail(`${entry.name} is already in your journal.`);
      const day = Math.floor(worldMinutes() / 1440);
      const seed = hash32(`${p.id}:${giver.id}:${entry.name}:${day}:${q.seq}`);
      const uid = `${entry.name}-${(++q.seq).toString(36)}-${(seed % 46656).toString(36)}`;
      const inst = createInstance(entry.def, {
        uid, seed,
        giver: { ...giver, location: giver.location ?? locOf(p), factionName: giver.factionName ?? factionNameOf(giver.faction) },
        host: hostFor(p), now: nowFor(p), source,
      });
      if (source === 'summoning' && Object.values(inst.places).some((place) => place.dungeon && !place.location)) {
        fail('This region has no suitable dungeon for the demand.');
      }
      bindPlaces(inst);
      inst.report = { source: entry.source, approximations: entry.analysis.approximations.slice(0, 12), ignored: entry.analysis.ignored.length };
      q.offer = { id: uid, name: entry.name, title: inst.title, text: hostFor(p).text(inst, MSG.OFFER) ?? '', giver: { id: giver.id, name: giver.name }, inst };
      ctx.notify(p, offerEvent(q.offer));
      return q.offer;
    },
    /** Starts a special quest straight away (no offer): failure stays failure, unlike a story quest. */
    startSpecial: (p, name, { source = 'special', factionId = null } = {}) => {
      let entry;
      try { entry = specialEntry(name); } catch (err) { return { blocked: [err.message] }; }
      const q = ensure(p);
      if (q.active.some((i) => i.name === entry.name)) return { blocked: [`${entry.name} is already running`] };
      const seed = hash32(`${p.id}:${entry.name}:${q.seq}:${source}`);
      const uid = `${entry.name}-${(++q.seq).toString(36)}-${(seed % 46656).toString(36)}`;
      const inst = createInstance(entry.def, { uid, seed, giver: null, host: hostFor(p), now: nowFor(p), source });
      inst.title = entry.def.displayName || inst.title;
      inst.giver = factionId !== null ? { id: null, name: null, location: locOf(p), faction: factionId } : null;
      inst.acceptedAt = nowFor(p);
      inst.report = { source: entry.source, approximations: entry.analysis.approximations.slice(0, 12), ignored: entry.analysis.ignored.length };
      q.active.push(inst);
      ctx.dirty(p);
      ctx.notify(p, { kind: 'questAccepted', uid: inst.uid, title: inst.title, text: '' });
      run(p);
      return inst;
    },
  };

  /** A quest a special trigger may start: blocked only by its trigger, never by unsupported script lines. */
  const SPECIAL_OK = /^(not a guild or social quest|no offer text|not in the operator quest list)/;
  function specialEntry(name) {
    const entry = cat().quests.get(String(name ?? '').toUpperCase());
    if (!entry) fail(`${name} is not installed on this server.`);
    const blockers = entry.analysis.unsupported.filter((u) => !SPECIAL_OK.test(u));
    if (blockers.length) {
      const err = new Error(`${entry.name} cannot run yet: ${blockers.slice(0, 4).join('; ')}`);
      err.blockers = blockers;
      throw err;
    }
    return entry;
  }

  const opening = installCampaignOpening(ctx, { definition: defOf, start: startStory, run });
  if (opening) services.quests.openingReady = opening.ready;
  return { cat, run, syncEntities, analyseQuest };
}

export default install;
