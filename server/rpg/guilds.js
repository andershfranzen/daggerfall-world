// Guilds, temples, knightly orders, secret recruitment and faction standing (package 15).
//
// Owns, per character:
//   rpg.guilds[group] = {rank, joinedAt, lastRankChange(day), variant?, flags?}   one membership per guild group
//                       (group: fighters | mages | thieves | brotherhood | temple | knights; variant = deity / order)
//   rpg.guildInvites[group] = {tally, letterAt, sent, awaiting?}                    Thieves Guild / Dark Brotherhood
//   rpg.factions[id]   standing with any faction of the installed FACTION.TXT (shared with npcs.js)
//
// Rules are in guilds/rules.js. npcs.js keeps the conversation (sessions, privacy, views) and asks this feature
// for membership at the speaker's own hall, rank changes, joining, gated services, donation and cures.
// Services for other owners (docs/guilds.md):
//   guildHallAccess(p, portal), guildCanRest(p, portalOrLocation), guildRank(p, group, {factionId}),
//   templeRank(p, deityId), guilds.{…}, regionFaction(regionIndex).

import { readFileSync } from 'node:fs';
import { parseFactionText } from '../../client/gameplay/npcs/factionFile.js';
import { holidayAt, holidayPrice } from '../../client/gameplay/atmosphere/holidays.js';
import { regionFactions } from './npcs/people.js';
import { resolveTemplate } from './inventory.js';
import { parseTextRsc } from '../../client/gameplay/character/classic.js';
import { calculateCost, tradePrice, NEUTRAL_ADJUST } from '../../client/gameplay/economy/rules.js';
import { avoidsDeath, breathScale } from '../../client/gameplay/guilds/perks.js';
import {
  DIVINES, GROUPS, ORDERS, SERVICE, TRAINING_MAX, alterReward, applyReputation, canAccessLibrary, canRest, reducedCureCost,
  donationRaises, eligibility, factionTable, freeHealing, freeShipTravel, freeTavernRooms, groupName, groupOfFaction,
  hallAccessAnytime, isGroup, privileges, rankFor, rankTitle, rankUpdate, reducedRepairCost,
  reputationChanges, repFaction, serviceAccess, trainingPrice, trainingSkills, variantOf,
} from './guilds/rules.js';

export const name = 'guilds';

/** people.js role -> guild group. */
const ROLE_GROUP = { fighters: 'fighters', mages: 'mages', priest: 'temple', thieves: 'thieves', brotherhood: 'brotherhood', knights: 'knights' };
const ALIASES = { darkBrotherhood: 'brotherhood', darkbrotherhood: 'brotherhood', 'dark-brotherhood': 'brotherhood', holyOrder: 'temple', knightlyOrder: 'knights', fightersGuild: 'fighters', magesGuild: 'mages', thievesGuild: 'thieves' };
const ARMOR_PIECES = ['cuirass', 'gauntlets', 'greaves', 'left-pauldron', 'right-pauldron', 'helm', 'boots'];
const ARMOR_MATERIALS = ['iron', 'steel', 'silver', 'elven', 'dwarven', 'mithril', 'adamantium', 'ebony', 'orcish', 'daedric'];
const MAX_FACTIONS = 600;
const BUILDING_TAVERN = 15;
const BUILDING_LIBRARY = 10;
const BUILDING_GUILDHALL = 11;
const BUILDING_TEMPLE = 14;
/** Guild faction ids whose halls a member finds on the town map (ThievesGuild/DarkBrotherhood.RevealGuildHallOnMap). */
const SECRET_HALL_FACTION = { thieves: 42, brotherhood: 108 };
/** KnightlyOrder flags. */
const HOUSE_FLAG = 2;

/**
 * Temple.Blessing after a donation (DaggerfallGuildServiceDonation; Temple.BlessingStat). The boost is
 * FormulaHelper.CalculateTempleBlessing = 1. DFU leaves the duration open ("stat effects with timeouts"); the
 * classic blessing texts (TEXT.RSC 705-717) say "for the next few days", taken here as three days of the player's
 * own time. Arkay grants none. Stendarr raises the legal reputation of the region, Zenithar Mercantile.
 */
export const BLESSINGS = Object.freeze({
  26: { attribute: 'Speed', text: 709 }, 29: { attribute: 'Luck', text: 712 }, 27: { attribute: 'Intelligence', text: 710 },
  35: { attribute: 'Endurance', text: 717 }, 24: { attribute: 'Personality', text: 707 },
  33: { legal: true, text: 716 }, 22: { skill: 'Mercantile', text: 705 },
});
export const BLESSING_MINUTES = 3 * 1440;
const BLESSING_FALLBACK = {
  26: 'Akatosh quickens your step for the next few days.', 29: 'Dibella smiles on your fortunes for the next few days.',
  27: 'Julianos sharpens your mind for the next few days.', 35: 'Kynareth fortifies your endurance for the next few days.',
  24: 'Mara warms your manner for the next few days.', 33: 'Stendarr speaks for you before the law.',
  22: 'Zenithar favours your bargaining for the next few days.',
};
/** TEXT.RSC records: spymaster greeting, Thieves Guild map promotions (ThievesGuild.cs). */
const SPYMASTER_TEXT = 402;
const TG_MAP_TEXT = { 6: 5228, 8: 5229 };

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fail = (msg) => {
  throw new Error(msg);
};
export const groupKey = (g) => (isGroup(g) ? g : ALIASES[g] ?? null);

export function install(ctx, options = {}) {
  const services = (ctx.services ||= {});
  const random = options.random ?? (() => Math.random());

  let parsed = options.factions ?? null;
  if (!parsed) {
    try {
      if (typeof ctx.dataFile === 'function') parsed = parseFactionText(readFileSync(ctx.dataFile('FACTION.TXT'), 'latin1'));
    } catch { /* no game data: built-in table */ }
  }
  const table = factionTable(parsed);

  // The operator's TEXT.RSC (classic messages are read, never shipped). Null without game data.
  let rsc = options.textRsc ?? undefined;
  const rscText = (id, pick = random()) => {
    if (rsc === undefined) {
      try { rsc = typeof ctx.dataFile === 'function' ? parseTextRsc(new Uint8Array(readFileSync(ctx.dataFile('TEXT.RSC')))) : null; } catch { rsc = null; }
    }
    const t = rsc?.text?.(id, pick);
    return typeof t === 'string' && t.trim() ? t : null;
  };
  /** Classic text macros used by these records; anything else is dropped. One line of prose. */
  const fillText = (text, vars) => text
    .replace(/%([a-z0-9]+)/gi, (_, k) => vars[k] ?? '')
    .replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const hasFaction = (id) => Number.isInteger(id) && id > 0 && (table.has(id) || [82, 201, 900, 40, 41].includes(id));

  // ---------------------------------------------------------------- clock

  const clock = () => (typeof services.worldClock === 'function' ? services.worldClock() : null);
  const minutesNow = () => {
    const c = clock();
    return c && Number.isFinite(c.minutes) ? Math.trunc(c.minutes) : Math.floor(ctx.now() / 60_000);
  };
  const today = () => Math.floor(minutesNow() / 1440);
  /** A character's own minutes (rest and journeys included, package 20), else the shared clock. */
  const playerNow = (p) => {
    const m = typeof services.playerMinutes === 'function' ? services.playerMinutes(p) : null;
    return Number.isFinite(m) ? m : minutesNow();
  };

  // ---------------------------------------------------------------- state

  function normalize(rpg) {
    if (!isObj(rpg.guilds)) rpg.guilds = {};
    for (const [k, v] of Object.entries(rpg.guilds)) {
      if (!isGroup(k) || !isObj(v)) { delete rpg.guilds[k]; continue; }
      v.rank = Math.max(0, Math.min(9, Math.trunc(v.rank) || 0));
      if (k === 'temple' && !DIVINES[v.variant]) v.variant = 21; // legacy temple (faction 82, the Order of Arkay)
      if (k === 'knights' && !ORDERS[v.variant]) { delete rpg.guilds[k]; continue; }
      if (k !== 'temple' && k !== 'knights') delete v.variant;
      if (v.lastRankChange !== undefined && !Number.isFinite(v.lastRankChange)) delete v.lastRankChange;
      if (v.flags !== undefined) v.flags = Math.trunc(v.flags) || 0;
    }
    if (!isObj(rpg.guildInvites)) rpg.guildInvites = {};
    for (const [k, v] of Object.entries(rpg.guildInvites)) {
      if (!GROUPS[k]?.invite || !isObj(v)) { delete rpg.guildInvites[k]; continue; }
      rpg.guildInvites[k] = { tally: Math.max(0, Math.trunc(v.tally) || 0), letterAt: Math.max(0, Math.trunc(v.letterAt) || 0), sent: !!v.sent, ...(v.awaiting ? { awaiting: true } : {}) };
    }
    if (!isObj(rpg.factions)) rpg.factions = {};
    if (rpg.blessing !== undefined) {
      const b = rpg.blessing;
      const ok = isObj(b) && BLESSINGS[b.deity] && typeof b.key === 'string' && Number.isFinite(b.until);
      if (!ok) delete rpg.blessing;
      else rpg.blessing = { deity: b.deity, key: b.key, bonus: Math.max(0, Math.min(5, Math.trunc(b.bonus) || 0)), until: Math.trunc(b.until) };
    }
    return rpg;
  }
  const stateOf = (p) => normalize((p.rpg ||= {}));

  // ---------------------------------------------------------------- standing

  const reputation = (p, id) => {
    const v = stateOf(p).factions[id];
    return Number.isFinite(v) ? v : 0;
  };
  /** Change standing; `propagate` follows the classic faction hierarchy. Returns the faction's new value. */
  function changeReputation(p, id, amount, { propagate = false } = {}) {
    id = Number(id);
    if (!hasFaction(id) || !Number.isFinite(amount) || !amount) return reputation(p, id);
    const rpg = stateOf(p);
    const changes = table.has(id) ? reputationChanges(table, id, Math.trunc(amount), propagate) : [[id, Math.trunc(amount)]];
    applyReputation(rpg.factions, changes);
    const keys = Object.keys(rpg.factions);
    if (keys.length > MAX_FACTIONS) for (const k of keys.filter((k) => Math.abs(rpg.factions[k]) <= 1).slice(0, keys.length - MAX_FACTIONS)) delete rpg.factions[k];
    ctx.dirty?.(p);
    return reputation(p, id);
  }

  // ---------------------------------------------------------------- halls and membership

  /** Guild group, variant, faction and quality of the hall a guild person serves, or null. */
  function hallOf(e) {
    if (!e) return null;
    const group = ROLE_GROUP[e.role] ?? (e.guild ? groupKey(e.guild) : null);
    if (!group) return null;
    const buildingFaction = e.building?.factionId ?? null;
    let variant = null;
    if (group === 'temple') variant = variantOf(table, 'temple', buildingFaction) ?? variantOf(table, 'temple', e.faction) ?? variantOf(table, 'temple', e._source?.factionId) ?? 21;
    if (group === 'knights') variant = variantOf(table, 'knights', buildingFaction) ?? variantOf(table, 'knights', e.faction);
    return { group, variant, factionId: buildingFaction ?? e.faction ?? null, quality: e.building?.quality ?? 10, name: groupName(table, group, variant) };
  }
  /** Hall described by a portal (`meta.factionId`) or {factionId, buildingType}. */
  function hallOfBuilding(b) {
    const factionId = b?.meta?.factionId ?? b?.factionId ?? null;
    const group = groupOfFaction(table, factionId);
    if (!group) return null;
    return { group, variant: variantOf(table, group, factionId), factionId, buildingType: b?.meta?.buildingType ?? b?.buildingType ?? null };
  }
  /** GuildManager.GetGuild: the membership only when it is this exact temple / order. */
  function memberOf(p, hall) {
    if (!hall) return null;
    const m = stateOf(p).guilds[hall.group];
    if (!m) return null;
    if ((hall.group === 'temple' || hall.group === 'knights') && hall.variant != null && m.variant !== hall.variant) return null;
    return m;
  }
  const rankAt = (p, hall) => memberOf(p, hall)?.rank ?? null;

  /** guildRank(p, group, {factionId}) — the rank, or null; temples/orders match the given faction when supplied. */
  function guildRank(p, group, opts = {}) {
    const g = groupKey(group);
    if (!g) return null;
    const m = stateOf(p).guilds[g];
    if (!m) return null;
    const fid = opts?.factionId ?? null;
    if (fid != null && (g === 'temple' || g === 'knights')) {
      const v = variantOf(table, g, fid);
      if (v != null && v !== m.variant) return null;
    }
    return m.rank;
  }

  function addMembership(p, group, variant, rank = 0) {
    const rpg = stateOf(p);
    rpg.guilds[group] = { rank, joinedAt: new Date().toISOString(), lastRankChange: today(), ...(variant != null ? { variant } : {}) };
    ctx.dirty?.(p);
    ctx.emit?.('guildJoin', { player: p, guild: group, factionId: repFaction(group, variant), variant });
    if (SECRET_HALL_FACTION[group]) revealHalls(p);
    return rpg.guilds[group];
  }

  /** Guild.UpdateRank at a hall of this guild. Returns a line for the speaker, or null. */
  function updateRank(p, group) {
    const rpg = stateOf(p);
    const m = rpg.guilds[group];
    if (!m) return null;
    const c = p.rpg.character;
    if (!c) return null;
    const rep = reputation(p, repFaction(group, m.variant));
    const u = rankUpdate(m, c, group, rep, today());
    if (!u.change) return null;
    const title = rankTitle(group, u.rank);
    if (u.change === 'expulsion') {
      delete rpg.guilds[group];
      ctx.emit?.('guildExpelled', { player: p, guild: group, variant: m.variant ?? null });
      ctx.dirty?.(p);
      return `Your conduct has shamed ${groupName(table, group, m.variant)}. You are no longer one of us.`;
    }
    const before = m.rank;
    m.rank = u.rank;
    m.lastRankChange = today();
    ctx.dirty?.(p);
    ctx.emit?.('guildRank', { player: p, guild: group, from: before, to: u.rank, change: u.change });
    if (u.change === 'promotion') {
      const opened = privileges(group, m.variant, u.rank).filter((s) => !privileges(group, m.variant, before).includes(s));
      const extra = opened.length ? ` You may now use: ${opened.map((s) => SERVICE[s] ?? PRIV_LABEL[s] ?? s).join(', ')}.` : '';
      const secret = promotionSecret(p, group, u.rank);
      return `Your service has been noticed. From today you are ${title}.${extra}${secret ? ` ${secret}` : ''}`;
    }
    return `Your standing has slipped. From today you are ${title}.`;
  }
  const PRIV_LABEL = { rest: 'rest in the hall', hallAnytime: 'the hall at any hour', freeHealing: 'free healing', freeRooms: 'free tavern rooms', freeShips: 'free ship passage' };

  // ---------------------------------------------------------------- conversation hooks (npcs.js)

  /**
   * Called when a player opens a conversation with a guild person. Applies the rank change and the hall's
   * on-arrival benefits (Temple.FreeHealing, Mages Guild magicka for non-regenerating careers). Returns text lines.
   */
  function greet(p, e) {
    const hall = hallOf(e);
    if (!hall) return [];
    const lines = [];
    if (memberOf(p, hall)) {
      const r = updateRank(p, hall.group);
      if (r) lines.push(r);
    }
    const rank = rankAt(p, hall) ?? -1;
    const c = p.rpg?.character;
    if (c && freeHealing(hall.group, hall.variant, rank) && Number.isFinite(c.maxHealth) && c.health < c.maxHealth) {
      c.health = c.maxHealth;
      lines.push('The priests tend your wounds.');
    }
    if (c && hall.group === 'mages' && rank >= 0 && c.noRegenSpellPoints && Number.isFinite(c.maxMagicka) && c.magicka < c.maxMagicka) {
      c.magicka = c.maxMagicka;
      lines.push('A magister restores your magicka.');
    }
    if (lines.length) ctx.dirty?.(p);
    return lines;
  }

  /** Guild block for the dialogue view. */
  function describe(p, e) {
    const hall = hallOf(e);
    if (!hall) return null;
    const m = memberOf(p, hall);
    const other = !m && stateOf(p).guilds[hall.group] ? stateOf(p).guilds[hall.group] : null;
    const rep = reputation(p, repFaction(hall.group, hall.variant));
    return {
      id: hall.group, group: hall.group, variant: hall.variant, name: hall.name,
      factionId: repFaction(hall.group, hall.variant), reputation: rep,
      member: !!m, rank: m ? m.rank : null, rankTitle: m ? rankTitle(hall.group, m.rank) : null,
      ...(other ? { memberElsewhere: groupName(table, hall.group, other.variant) } : {}),
      privileges: m ? privileges(hall.group, hall.variant, m.rank) : [],
      nextRankDay: m && Number.isFinite(m.lastRankChange) ? m.lastRankChange + 28 : null,
    };
  }

  /** Access check for a guild service at this person's hall: {ok, text}. */
  function access(p, e, service) {
    const hall = hallOf(e);
    if (!hall) return { ok: true, text: null, hall: null, rank: null };
    const rank = rankAt(p, hall);
    const a = serviceAccess(hall.group, hall.variant, rank, service);
    if (a.ok) return { ok: true, text: null, hall, rank };
    const label = SERVICE[service] ?? service;
    const text = a.reason === 'rank' ? `You have not risen high enough in ${hall.name} for that (${label} needs the rank of ${rankTitle(hall.group, a.minRank)}).`
      : a.reason === 'members' ? `${label} is for members of ${hall.name} only.`
        : `${hall.name} does not offer ${label.toLowerCase()} here.`;
    return { ok: false, text, hall, rank, reason: a.reason, minRank: a.minRank };
  }

  /** "Ask to join" at a guild person. Returns {text, joined}. */
  function join(p, e) {
    const hall = hallOf(e);
    const c = p.rpg?.character;
    if (!hall) return { text: 'There is nothing here to join.', joined: false };
    if (!c) return { text: 'Come back when you know who you are.', joined: false };
    const rpg = stateOf(p);
    const m = memberOf(p, hall);
    if (m) return { text: `You are already one of us, ${rankTitle(hall.group, m.rank)}.`, joined: false };
    if (rpg.guilds[hall.group]) {
      return { text: `You already serve ${groupName(table, hall.group, rpg.guilds[hall.group].variant)}. We do not share our members.`, joined: false };
    }
    const g = GROUPS[hall.group];
    if (g.invite) {
      const inv = rpg.guildInvites[hall.group];
      if (!inv?.awaiting) return { text: 'Join? I don’t know what you’ve heard, friend, but there is nothing here to join.', joined: false };
    }
    if (hall.group === 'knights' && hall.variant == null) return { text: 'This hall answers to no order you could swear to.', joined: false };
    const rep = reputation(p, repFaction(hall.group, hall.variant));
    const el = eligibility(c, hall.group, hall.variant, rep);
    if (!el.ok && !g.invite) {
      if (el.reason === 'reputation') return { text: `Your reputation with ${hall.name} is poor. Mend it before you ask again.`, joined: false };
      const sk = [...(hall.group === 'temple' ? DIVINES[hall.variant].skills : g.skills)]
        .sort((a, b) => (c.skills?.[b] ?? 0) - (c.skills?.[a] ?? 0)).slice(0, 2);
      return { text: `You lack the skills we look for. Work on ${sk.join(' or ')} and come back.`, joined: false };
    }
    addMembership(p, hall.group, hall.variant, 0);
    if (g.invite) delete rpg.guildInvites[hall.group].awaiting;
    if (rep < 1) changeReputation(p, repFaction(hall.group, hall.variant), 1);
    return { text: `Welcome to ${hall.name}, ${p.name}. You join us as ${rankTitle(hall.group, 0)}.`, joined: true };
  }

  /** Temple donation of `amount` gold (DaggerfallGuildServiceDonation). Gold is taken by the caller. */
  function donate(p, e, amount) {
    const hall = hallOf(e);
    const deity = hall?.group === 'temple' ? hall.variant : null;
    const fid = deity ?? e.faction;
    const rep = reputation(p, fid);
    const raised = donationRaises(amount, rep, random() * 100);
    if (raised) changeReputation(p, fid, 1);
    const blessing = deity != null && amount > 0 ? bless(p, deity) : null;
    return { raised, factionId: fid, reputation: reputation(p, fid), blessing };
  }

  /** Temple.Blessing: one active blessing at a time; the same deity does not bless again until it fades. */
  function bless(p, deity) {
    const b = BLESSINGS[deity];
    if (!b) return null;
    const rpg = stateOf(p);
    const now = playerNow(p);
    const cur = rpg.blessing;
    if (cur && cur.deity === deity && cur.until > now) return null;
    if (b.legal) {
      const law = services.law;
      const region = typeof law?.regionOf === 'function' ? law.regionOf(ctx.location?.(p) ?? p.rpg.location) : null;
      if (!region || typeof law.changeLegalRep !== 'function') return null;
      law.changeLegalRep(p, region, 1, 'blessing');
    }
    rpg.blessing = { deity, key: b.attribute ?? b.skill ?? 'legal', bonus: b.legal ? 0 : 1, until: now + BLESSING_MINUTES };
    ctx.dirty?.(p);
    ctx.emit?.('templeBlessing', { player: p, deity, key: rpg.blessing.key, until: rpg.blessing.until });
    const raw = rscText(b.text, 0);
    return raw ? fillText(raw, {}) : BLESSING_FALLBACK[deity];
  }
  /** Temporary attribute or skill bonus of an active blessing (package 11 adds it to effective values). */
  function blessingModifier(actor, name) {
    const b = actor?.rpg?.blessing;
    if (!b || b.key !== name || !(b.bonus > 0)) return 0;
    return playerNow(actor) < b.until ? b.bonus : 0;
  }

  /**
   * Temple cure (DaggerfallGuildServiceCureDisease): 250 per condition (package 10), the Arkay rank discount, then
   * FormulaHelper.CalculateCost with the hall's quality and the region's price adjustment (package 12), the holiday
   * rule (free, or half on North Winds), and last the haggle (CalculateTradePrice with the player's Mercantile and
   * Personality). Returns {count, cost, rule, base, listed}: `listed` is the price before haggling.
   */
  function cureQuote(p, e) {
    const hall = hallOf(e);
    const count = typeof services.conditionCount === 'function' ? Math.max(0, Math.trunc(services.conditionCount(p, 'disease')) || 0) : 0;
    if (!count) return { count: 0, cost: 0, rule: null, base: 0, listed: 0 };
    const rank = rankAt(p, hall);
    const quality = Number.isFinite(hall?.quality) ? Math.trunc(hall.quality) : 10;
    const base = reducedCureCost(hall?.group, hall?.variant, rank ?? -1, 250 * count);
    const pc = typeof services.priceContext === 'function' ? services.priceContext(p, e.location, quality) : null;
    let cost = calculateCost(base, quality, Number.isFinite(pc?.adjust) ? pc.adjust : NEUTRAL_ADJUST);
    let rule = null;
    const c = clock();
    if (c) {
      const region = e.building?.regionIndex ?? null;
      const h = typeof services.holidayPrice === 'function' ? services.holidayPrice('cure', cost, { p })
        : holidayPrice('cure', cost, pc?.holiday ?? holidayAt(c.minutes, region));
      if (h && Number.isFinite(h.price)) { cost = h.price; rule = h.rule ?? null; }
    }
    const listed = cost;
    if (cost > 0) cost = Math.max(1, tradePrice(cost, quality, false, { mercantile: pc?.mercantile ?? 0, personality: pc?.personality ?? 50 }));
    return { count, cost, rule, base, listed };
  }

  /** KnightlyOrder.ReceiveArmor: one piece of rank-material armour per rank. `piece` picks among the pieces. */
  function receiveArmor(p, e, piece) {
    const hall = hallOf(e);
    const m = memberOf(p, hall);
    if (!m || hall.group !== 'knights') fail('Only knights of this order may draw armour here.');
    const mask = 4 << m.rank;
    if ((m.flags ?? 0) & mask) return { text: 'You have already drawn the armour due to your rank.' };
    const material = ARMOR_MATERIALS[Math.min(m.rank, ARMOR_MATERIALS.length - 1)];
    const offer = ARMOR_PIECES.filter((x) => resolveTemplate(`${material}-${x}`));
    if (!offer.includes(piece)) return { text: `Choose one piece of ${material} armour.`, offer: offer.map((x) => ({ piece: x, template: `${material}-${x}` })) };
    if (typeof services.giveItem !== 'function') fail('The armoury is closed right now.');
    services.giveItem(p, `${material}-${piece}`, 1);
    m.flags = (m.flags ?? 0) | mask;
    ctx.dirty?.(p);
    return { text: `The quartermaster hands you ${material} ${piece.replace('-', ' ')}. Wear it with honour.` };
  }

  /** Trainer catalogue for package 11: which skills, the limit and the price for this player. */
  function tutor(p, e) {
    const hall = hallOf(e);
    if (!hall) return null;
    const rank = rankAt(p, hall);
    const a = serviceAccess(hall.group, hall.variant, rank, 'train');
    const level = Number(p.rpg?.character?.level) || 1;
    return {
      group: hall.group, variant: hall.variant, name: hall.name, member: rank !== null, rank,
      allowed: a.ok, reason: a.ok ? null : access(p, e, 'train').text,
      skills: [...trainingSkills(hall.group, hall.variant)], max: TRAINING_MAX, price: trainingPrice(rank !== null, level),
    };
  }

  // ---------------------------------------------------------------- package 2 / 20 hooks

  function hallFromLocation(location) {
    if (typeof location !== 'string') return null;
    for (const e of ctx.entities.values()) {
      if (e?.kind === 'npc' && e.location === location && e.building?.factionId != null) {
        return { meta: { factionId: e.building.factionId, buildingType: e.building.type } };
      }
    }
    return null;
  }

  /** Guild.HallAccessAnytime for exactly this hall (temples/orders must match). */
  function guildHallAccess(p, portal) {
    const hall = hallOfBuilding(portal);
    if (!hall) return false;
    return hallAccessAnytime(hall.group, rankAt(p, hall) ?? -1);
  }
  /** Guild.CanRest for exactly this hall; never in taverns (they carry the Fighters Guild faction). */
  function guildCanRest(p, where) {
    const b = typeof where === 'string' ? hallFromLocation(where) : where;
    if (!b) return false;
    const type = b.meta?.buildingType ?? b.buildingType;
    if (type === BUILDING_TAVERN) return false;
    const hall = hallOfBuilding(b);
    return !!hall && canRest(hall.group, rankAt(p, hall) ?? -1);
  }

  // ---------------------------------------------------------------- secret recruitment
  //
  // The trigger (crime tally, three-day letter outdoors, starting O0A0AL00 / L0A01L00) is package 19's
  // (server/rpg/special.js, from package 14's `crimeTally`). It emits `guildInvite {player, guild, quest, started}`.
  // This feature owns what follows: membership when the initiation quest succeeds, and, when the quest could not
  // start, the letter itself as the invitation (the hall then offers "Ask to join").

  function onInvite(ev) {
    const p = ev?.player;
    const group = groupKey(ev?.guild);
    if (!p || !GROUPS[group]?.invite) return;
    const rpg = stateOf(p);
    if (rpg.guilds[group]) return;
    const inv = (rpg.guildInvites[group] ||= { tally: 0, letterAt: 0, sent: false });
    inv.sent = true;
    inv.letterAt = 0;
    if (!ev.started && !inv.awaiting) {
      inv.awaiting = true;
      ctx.notify(p, {
        kind: 'questMessage', title: 'A letter',
        text: group === 'thieves'
          ? 'A grubby note is pressed into your hand: “Your talents have been noticed. Ask after work at our hall and say you are expected.”'
          : 'An unsigned letter, sealed in black wax: “We have watched you. Find our sanctuary and tell them you were sent for.”',
      });
    }
    ctx.dirty?.(p);
  }

  // ---------------------------------------------------------------- secret halls and guild maps

  /** Exterior town a player stands in or a building's town, or null. */
  function townOf(p) {
    const loc = ctx.location?.(p) ?? p.rpg?.location;
    if (typeof loc !== 'string') return null;
    if (/^town:/i.test(loc)) return loc;
    const from = services.portals?.into?.(loc)?.from;
    return typeof from === 'string' && /^town:/i.test(from) ? from : null;
  }

  /**
   * ThievesGuild/DarkBrotherhood.RevealGuildHallOnMap: a member finds every hall of their guild in the town they are
   * in, under the guild's name, on joining and whenever they come to a town (package 6 automap names).
   */
  function revealHalls(p, town = townOf(p)) {
    if (!town || typeof services.automap?.learnPlace !== 'function') return 0;
    const g = stateOf(p).guilds;
    let n = 0;
    for (const [group, fid] of Object.entries(SECRET_HALL_FACTION)) {
      if (!g[group]) continue;
      const label = groupName(table, group, null).replace(/^The /, '');
      for (const spec of services.portals?.at?.(town) ?? []) {
        if (spec?.kind !== 'building' || spec.meta?.factionId !== fid) continue;
        if (services.automap.learnPlace(p, { town, portalId: spec.id, label })) n++;
      }
    }
    return n;
  }

  /**
   * ThievesGuild.GetPromotionMsgId (ranks 6 and 8) and DarkBrotherhood.GetPromotionMsgId (every promotion):
   * PlayerGPS.DiscoverRandomLocation in the current region, written in the notebook. Returns a line or null.
   */
  function promotionSecret(p, group, rank) {
    if (!(group === 'brotherhood' || (group === 'thieves' && TG_MAP_TEXT[rank]))) return null;
    const found = services.travel?.discoverRandomLocation?.(p, { random });
    if (found?.status !== 'revealed') return null;
    const place = String(found.entry.name ?? '').trim();
    const region = String(found.entry.region ?? '').trim();
    services.automap?.write?.(p, `${groupName(table, group, null)}: ${place} in ${region}, marked on my map at my promotion.`, { source: 'guild' });
    ctx.emit?.('guildSecretRevealed', { player: p, guild: group, rank, location: found.entry.id });
    const raw = group === 'thieves' ? rscText(TG_MAP_TEXT[rank], 0) : null;
    if (raw) return fillText(raw, { pcf: String(p.name ?? '').split(' ')[0], pcn: p.name ?? '', lev: rankTitle(group, rank), dng: place, reg: region });
    return group === 'thieves'
      ? `A friend in the guild marks ${place} in ${region} on your map: easy pickings for a ${rankTitle(group, rank)}.`
      : `A whisper names ${place} in ${region}, and the place is marked on your map.`;
  }

  // ---------------------------------------------------------------- specialists (package 15's own)

  /** Guild.CanAccessLibrary at a bookshelf (DaggerfallBookshelf.ReadBook): {ok, text}. */
  function guildLibraryAccess(p, meta) {
    const type = meta?.buildingType ?? null;
    if (type === BUILDING_LIBRARY || (type !== BUILDING_GUILDHALL && type !== BUILDING_TEMPLE)) return { ok: true, text: null };
    const hall = hallOfBuilding({ meta });
    const rank = hall ? rankAt(p, hall) : null;
    if (hall && canAccessLibrary(hall.group, hall.variant, rank ?? -1)) return { ok: true, text: null };
    const min = hall ? rankFor(hall.group, hall.variant, 'library') : null;
    const name = hall ? groupName(table, hall.group, hall.variant) : null;
    if (hall && rank !== null && min !== null) {
      return { ok: false, text: `You have not risen high enough in ${name} to use its library (it needs the rank of ${rankTitle(hall.group, min)}).` };
    }
    return { ok: false, text: 'Access to the library is for members only.' };
  }

  /**
   * Guild teleport (Mages Guild rank 8): the first request opens the travel map in teleport mode
   * (DaggerfallTravelMapWindow.ActivateTeleportationTravel); `{to}` then sends the player there at once and for free
   * (DaggerfallTeleportPopUp.TeleportAway), from inside the hall.
   */
  function teleportService(p, info, args = {}) {
    if (args.to === undefined) {
      return info.say('Choose your destination on the map. I will send you there at once, and it will cost you nothing.', { teleport: { open: true } });
    }
    if (typeof services.travel?.teleport !== 'function') fail('The guild’s teleport is not working right now.');
    if (services.enemiesNearby?.(p)) fail('Not with enemies so close.');
    const blocked = services.travelPrevented?.(p);
    if (blocked) fail(blocked);
    const entry = services.travel.teleport(p, args.to);
    ctx.emit?.('guildTeleport', { player: p, to: entry.id });
    return { endConversation: true, teleported: entry.id, text: `The magister speaks a word, and you stand in ${entry.name.trim()}.` };
  }

  /** Spymaster (TG rank 4, DB rank 7): TEXT.RSC 402, then a conversation in which every answer is true. */
  function spymasterService(p, info) {
    info.markSpymaster?.();
    const raw = rscText(SPYMASTER_TEXT);
    return info.say(raw ? fillText(raw, {}) : 'Ask me where anyone is. Others trade in rumours; mine are always true.', { spymaster: true });
  }

  /** KnightlyOrder.ReceiveHouse at the Seneschal (848): rank 9, once, a house of this town for sale (package 13). */
  function houseService(p, info) {
    const e = ctx.entities.get(info.npcId);
    const hall = hallOf(e);
    const m = memberOf(p, hall);
    if (!m || hall.group !== 'knights') return `The order’s houses are for its knights.`;
    if (m.rank < 9) return `The order grants a house to its ${rankTitle('knights', 9)} alone.`;
    if ((m.flags ?? 0) & HOUSE_FLAG) return 'You have already received the house the order owes you.';
    const grant = services.property?.grantHouse;
    if (typeof grant !== 'function') return 'The order’s steward cannot hand over a deed just now. Come back another day.';
    const r = grant(p, { town: townOf(p), random, reason: 'knightly-order' });
    if (r?.status !== 'granted') return r?.text ?? 'There is no house for the order to give in this town.';
    m.flags = (m.flags ?? 0) | HOUSE_FLAG;
    ctx.dirty?.(p);
    return r.text ?? 'The order grants you a house in this town. The deed is yours.';
  }

  // ---------------------------------------------------------------- temple perks (packages 4, 8/11, 20)

  /** Temple.AvoidDeath (Stendarr): called by package 11 when health reaches 0. */
  function avoidDeath(p, source) {
    const g = p?.rpg?.guilds;
    if (!g?.temple) return false;
    const submerged = source?.kind === 'drowning' || services.locomotion?.stateOf?.(p)?.underwater === true;
    if (!avoidsDeath(g, Math.floor(random() * 50), submerged)) return false;
    ctx.notify?.(p, { kind: 'guild', event: 'avoidDeath', text: 'Stendarr has spared you from death.' });
    ctx.emit?.('avoidDeath', { player: p, deity: 33 });
    return true;
  }

  // ---------------------------------------------------------------- events

  ctx.onJoin?.((p) => { stateOf(p); revealHalls(p); });
  ctx.on?.('locationChanged', (ev) => {
    const p = ev?.player;
    if (p?.rpg && typeof ev.to === 'string' && /^town:/i.test(ev.to)) revealHalls(p, ev.to);
  });
  ctx.on?.('guildInvite', onInvite);
  ctx.on?.('questComplete', (ev) => {
    const p = ev?.player;
    const nameOf = String(ev?.quest?.name ?? '').toUpperCase();
    if (!p) return;
    for (const group of ['thieves', 'brotherhood']) {
      if (GROUPS[group].invite !== nameOf || stateOf(p).guilds[group]) continue;
      addMembership(p, group, null, 0);
      const inv = stateOf(p).guildInvites[group];
      if (inv) { inv.sent = true; delete inv.awaiting; }
    }
  });

  // ---------------------------------------------------------------- services

  /** Whether "Ask to join" is offered here: secret guilds only to a player awaiting their invitation. */
  function joinOffered(p, e) {
    const hall = hallOf(e);
    if (!hall || memberOf(p, hall)) return false;
    if (GROUPS[hall.group].invite) return !!stateOf(p).guildInvites[hall.group]?.awaiting;
    return true;
  }
  const freeHealingAt = (p, e) => {
    const hall = hallOf(e);
    return !!hall && freeHealing(hall.group, hall.variant, rankAt(p, hall) ?? -1);
  };

  const api = {
    joinOffered, freeHealingAt, table, hallOf, hallOfBuilding, memberOf, rankAt, describe, access, join, greet, donate, cureQuote, receiveArmor,
    tutor, updateRank, addMembership, changeReputation, normalize,
    reputation, rankFor, privileges: (p) => Object.entries(stateOf(p).guilds).map(([g, m]) => ({
      group: g, variant: m.variant ?? null, name: groupName(table, g, m.variant), rank: m.rank, title: rankTitle(g, m.rank),
      privileges: privileges(g, m.variant, m.rank),
    })),
    memberships: (p) => ({ ...stateOf(p).guilds }),
    repairCost: (p, price) => reducedRepairCost('fighters', guildRank(p, 'fighters') ?? -1, price),
    questReward: (p, group, reward) => alterReward(groupKey(group), guildRank(p, group) ?? -1, reward),
    freeTavernRoom: (p, regionIndex) => {
      const m = stateOf(p).guilds.knights;
      return !!m && freeTavernRooms(m.variant, m.rank, regionIndex);
    },
    freeShipTravel: (p) => freeShipTravel(guildRank(p, 'knights') ?? -1),
  };
  Object.assign(api, { guildLibraryAccess, revealHalls, bless, blessingModifier, avoidDeath, cureQuote });
  services.guilds = api;
  (services.npcServiceHandlers ??= {});
  services.npcServiceHandlers.teleport ??= teleportService;
  services.npcServiceHandlers.spymaster ??= spymasterService;
  services.npcServiceHandlers.house ??= houseService;
  Object.assign(services, {
    guildLibraryAccess,
    blessingModifier,
    avoidDeath,
    guildBreathScale: (p) => breathScale(p?.rpg?.guilds),
    guildHallAccess,
    guildCanRest,
    guildRank,
    templeRank: (p, deityId) => guildRank(p, 'temple', { factionId: deityId }),
    regionFaction: (regionIndex) => (parsed ? regionFactions(parsed, regionIndex).people : null),
    regionCourt: (regionIndex) => (parsed ? regionFactions(parsed, regionIndex).court : null),
    factionName: (id) => table.get(Number(id))?.name ?? null,
    isFaction: hasFaction,
  });
  return api;
}

export default install;
