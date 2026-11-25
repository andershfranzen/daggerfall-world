// Chronicles of the Iliac Bay (Hiscores) — pure, privacy-preserving character & Order projection.
// No database or network I/O. Never leaks private account, credential, coordinate, or inventory fields.

import { SKILLS, MAX_SKILL } from '../../client/gameplay/character/rules.js';
import { countFound } from '../../client/gameplay/travel/identity.js';
import { rankTitle, DIVINES, ORDERS, GROUPS } from '../rpg/guilds/rules.js';
import { CROWN_RANKS } from '../rpg/admiralty.js';
import { TOTAL_CLASSIC_PLACES, resolveBoard } from './categories.js';

const PGUILD_PREFIX = 'pguild:';
const QUEST_SUCCESS_RESULTS = new Set(['success', 'complete', 'completed']);

const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

function nonNegInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function toEpochMs(v) {
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.trunc(v) : null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) && t >= 0 ? Math.trunc(t) : null;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
    }
    const parsed = Date.parse(s);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
  }
  return null;
}

function isAccountBanned(bannedAccountIds, accountId) {
  if (!bannedAccountIds || accountId == null || accountId === '') return false;
  const key = String(accountId);
  if (typeof bannedAccountIds.has === 'function') {
    return bannedAccountIds.has(key) || bannedAccountIds.has(accountId);
  }
  if (Array.isArray(bannedAccountIds)) {
    return bannedAccountIds.some((id) => String(id) === key);
  }
  return false;
}

function parseRpg(raw) {
  if (isObj(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return isObj(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function crownRankTitleFor(standing) {
  const s = Number.isFinite(standing) ? standing : 0;
  let current = CROWN_RANKS[0];
  for (const r of CROWN_RANKS) {
    if (s >= r.at) current = r;
  }
  return current.title;
}

function projectInfamy(rpg) {
  const law = isObj(rpg.law) ? rpg.law : {};
  let infamy = 0;
  let worstRegion = null;
  let lowestRep = 0;

  if (isObj(law.rep)) {
    for (const [region, rawRep] of Object.entries(law.rep)) {
      const rep = Number(rawRep);
      if (!Number.isFinite(rep) || rep >= 0) continue;
      infamy += Math.max(0, Math.trunc(-rep));
      if (worstRegion === null || rep < lowestRep) {
        lowestRep = rep;
        worstRegion = region;
      }
    }
  }

  if (isObj(law.banished)) {
    for (const [region, flag] of Object.entries(law.banished)) {
      if (!flag) continue;
      infamy += 50;
      if (worstRegion === null) worstRegion = region;
    }
  }

  if (isObj(law.charge)) {
    infamy += 25;
    if (worstRegion === null && typeof law.charge.region === 'string' && law.charge.region.trim()) {
      worstRegion = law.charge.region.trim();
    }
  }

  const notoriety = isObj(rpg.admiralty?.notoriety) ? rpg.admiralty.notoriety : null;
  if (notoriety) {
    let maxNotoriety = 0;
    let maxNotorietyRegion = null;
    for (const [region, rawN] of Object.entries(notoriety)) {
      const n = Number(rawN);
      if (Number.isFinite(n) && n > maxNotoriety) {
        maxNotoriety = n;
        maxNotorietyRegion = region;
      }
    }
    if (maxNotoriety > 0) {
      infamy += Math.round(maxNotoriety);
      if (worstRegion === null && maxNotorietyRegion) worstRegion = maxNotorietyRegion;
    }
  }

  return { infamy: Math.max(0, Math.trunc(infamy)), worstRegion };
}

function projectAdmiralty(rpg) {
  const adm = isObj(rpg.admiralty) ? rpg.admiralty : {};
  let positiveStandingSum = 0;
  let maxStanding = 0;

  if (isObj(adm.standing)) {
    for (const rawVal of Object.values(adm.standing)) {
      const n = Number(rawVal);
      if (!Number.isFinite(n) || n <= 0) continue;
      const v = Math.trunc(n);
      positiveStandingSum += v;
      if (v > maxStanding) maxStanding = v;
    }
  }

  const log = isObj(adm.log) ? adm.log : {};
  const sunkObj = isObj(log.sunk) ? log.sunk : {};
  const takenObj = isObj(log.taken) ? log.taken : {};
  const contractsObj = isObj(log.contracts) ? log.contracts : {};

  const pirateSunk = nonNegInt(sunkObj.pirate);
  const merchantSunk = nonNegInt(sunkObj.merchant);
  const navySunk = nonNegInt(sunkObj.navy);
  const shipsSunk = pirateSunk + merchantSunk + navySunk;

  const pirateTaken = nonNegInt(takenObj.pirate);
  const repelled = nonNegInt(log.repelled);

  let contractsDone = 0;
  for (const v of Object.values(contractsObj)) contractsDone += nonNegInt(v);

  const admiraltyScore = Math.max(
    0,
    positiveStandingSum + maxStanding + (pirateSunk * 5) + (pirateTaken * 8) + (repelled * 3) + (contractsDone * 10),
  );

  return {
    admiraltyScore,
    admiraltyRankTitle: crownRankTitleFor(maxStanding),
    admiraltyMaxStanding: maxStanding,
    shipsSunk,
  };
}

function projectGuilds(rpg) {
  const rawGuilds = isObj(rpg.guilds) ? rpg.guilds : {};
  const factions = isObj(rpg.factions) ? rpg.factions : {};
  const out = {};

  for (const [group, raw] of Object.entries(rawGuilds)) {
    if (!Object.hasOwn(GROUPS, group) || !isObj(raw)) continue;
    const rawRank = Number(raw.rank);
    if (!Number.isFinite(rawRank) || rawRank < 0) continue;
    const maxRank = GROUPS[group].ranks.length - 1;
    const rank = Math.min(maxRank, Math.trunc(rawRank));

    let variant = null;
    if (raw.variant != null && raw.variant !== '' && Number.isFinite(Number(raw.variant))) {
      variant = Math.trunc(Number(raw.variant));
    }

    let variantName = null;
    if (group === 'temple' && variant != null && Object.hasOwn(DIVINES, variant)) {
      variantName = `Temple of ${DIVINES[variant].name}`;
    } else if (group === 'knights' && variant != null && Object.hasOwn(ORDERS, variant)) {
      variantName = ORDERS[variant].name;
    }

    let reputation = 0;
    if (Number.isFinite(Number(raw.reputation))) {
      reputation = Math.trunc(Number(raw.reputation));
    } else {
      const fid = GROUPS[group].factionId ?? variant;
      if (fid != null && Number.isFinite(Number(factions[fid]))) {
        reputation = Math.trunc(Number(factions[fid]));
      } else if (group === 'temple' && variant != null && DIVINES[variant]) {
        const orderFid = DIVINES[variant].order;
        if (Number.isFinite(Number(factions[orderFid]))) {
          reputation = Math.trunc(Number(factions[orderFid]));
        }
      }
    }

    out[group] = Object.freeze({
      rank,
      title: rankTitle(group, rank) ?? GROUPS[group].ranks[rank] ?? 'Member',
      variant,
      variantName,
      reputation,
    });
  }

  return Object.freeze(out);
}

/**
 * Project a raw character row into a safe, frozen public Chronicles record.
 * Returns null if the character is invalid, uncreated (when required), unlinked (when required),
 * banned, or opted out via `rpg.chronicles.hidden === true`.
 */
export function projectCharacter(row, opts = {}) {
  if (!isObj(row)) return null;
  if (row.id == null || row.id === '' || typeof row.id === 'boolean') return null;
  const playerId = Number(row.id);
  if (!Number.isSafeInteger(playerId) || playerId < 0) return null;

  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (!name) return null;

  const requireCreated = opts.requireCreated !== false;
  const requireLinked = opts.requireLinked === true;
  const bannedAccountIds = opts.bannedAccountIds ?? null;

  if (requireLinked && (row.accountId == null || String(row.accountId).trim() === '')) return null;
  if (isAccountBanned(bannedAccountIds, row.accountId)) return null;

  const rpg = parseRpg(row.rpg);
  const chronicles = isObj(rpg.chronicles) ? rpg.chronicles : {};
  if (chronicles.hidden === true) return null;

  const character = isObj(rpg.character) ? rpg.character : {};
  if (requireCreated && !character.created) return null;

  const rawClassName = character.className || character.custom?.name;
  const className = typeof rawClassName === 'string' && rawClassName.trim() ? rawClassName.trim() : 'Adventurer';
  const race = typeof character.race === 'string' && character.race.trim() ? character.race.trim() : 'Unknown';
  const level = Math.max(1, Math.trunc(Number(character.level) || 1));

  const updatedAt = toEpochMs(row.lastSeen) ?? toEpochMs(row.updatedAt) ?? Date.now();
  const rawSkills = isObj(character.skills) ? character.skills : {};
  const rawSkillMilestones = isObj(chronicles.skillMilestones) ? chronicles.skillMilestones : {};

  const skills = {};
  const skillMilestones = {};
  let totalSkill = 0;

  for (const skill of SKILLS) {
    const n = Number(rawSkills[skill]);
    const val = Number.isFinite(n) ? Math.max(0, Math.min(MAX_SKILL, Math.trunc(n))) : 0;
    skills[skill] = val;
    totalSkill += val;
    skillMilestones[skill] = toEpochMs(rawSkillMilestones[skill]) ?? updatedAt;
  }

  const travel = isObj(rpg.travel) ? rpg.travel : {};
  const foundCount = countFound(travel.found);
  const legacySet = new Set();
  if (Array.isArray(travel.discovered)) {
    for (const item of travel.discovered) {
      if (typeof item === 'string') {
        const s = item.trim();
        if (s) legacySet.add(s);
      }
    }
  }
  const placesDiscovered = Math.min(TOTAL_CLASSIC_PLACES, Math.max(0, foundCount + legacySet.size));
  const trips = nonNegInt(travel.trips);

  const chronQuests = nonNegInt(chronicles.questsCompleted);
  const doneQuests = Array.isArray(rpg.quests?.done) ? rpg.quests.done : [];
  let doneSuccessCount = 0;
  for (const entry of doneQuests) {
    if (isObj(entry) && typeof entry.result === 'string' && QUEST_SUCCESS_RESULTS.has(entry.result.toLowerCase())) {
      doneSuccessCount += 1;
    }
  }
  const questsCompleted = Math.max(chronQuests, doneSuccessCount);
  const monstersSlain = nonNegInt(chronicles.monstersSlain);

  const { infamy, worstRegion } = projectInfamy(rpg);
  const { admiraltyScore, admiraltyRankTitle, admiraltyMaxStanding, shipsSunk } = projectAdmiralty(rpg);
  const guilds = projectGuilds(rpg);

  const pg = isObj(rpg.playerGuild) && typeof rpg.playerGuild.id === 'string' && rpg.playerGuild.id.trim()
    ? Object.freeze({
      id: rpg.playerGuild.id.trim(),
      name: typeof rpg.playerGuild.name === 'string' ? rpg.playerGuild.name.trim() : '',
      tag: typeof rpg.playerGuild.tag === 'string' ? rpg.playerGuild.tag.trim() : '',
      rank: typeof rpg.playerGuild.rank === 'string' && rpg.playerGuild.rank.trim() ? rpg.playerGuild.rank.trim() : 'Member',
    })
    : null;

  const milestoneAt = toEpochMs(chronicles.levelMilestoneAt)
    ?? toEpochMs(chronicles.updatedAt)
    ?? toEpochMs(row.lastSeen)
    ?? toEpochMs(row.updatedAt)
    ?? 0;

  return Object.freeze({
    playerId,
    name,
    className,
    race,
    level,
    skills: Object.freeze(skills),
    totalSkill,
    skillMilestones: Object.freeze(skillMilestones),
    placesDiscovered,
    trips,
    questsCompleted,
    monstersSlain,
    infamy,
    worstRegion,
    admiraltyScore,
    admiraltyRankTitle,
    admiraltyMaxStanding,
    shipsSunk,
    guilds,
    order: pg,
    milestoneAt,
    updatedAt,
  });
}

function lookupCharacter(characterById, id) {
  if (!characterById || id == null) return null;
  if (typeof characterById.get === 'function') {
    return characterById.get(id) ?? characterById.get(Number(id)) ?? characterById.get(String(id)) ?? null;
  }
  return characterById[id] ?? characterById[String(id)] ?? null;
}

/**
 * Project `world_state` rows with prefix `pguild:` into safe public Player Order summaries.
 * Accepts rows as `[key, value]` tuples or `{ key, value }` objects; values may be JSON strings or objects.
 */
export function projectOrders(worldRows, characterById = new Map()) {
  if (!worldRows || typeof worldRows[Symbol.iterator] !== 'function') return [];
  const out = [];

  for (const row of worldRows) {
    let key;
    let rawVal;
    if (Array.isArray(row)) {
      [key, rawVal] = row;
    } else if (isObj(row)) {
      key = row.key ?? row.k;
      rawVal = row.value ?? row.v;
    } else {
      continue;
    }

    if (typeof key !== 'string' || !key.startsWith(PGUILD_PREFIX)) continue;
    const val = parseRpg(rawVal);
    const id = typeof val.id === 'string' && val.id.trim() ? val.id.trim() : key.slice(PGUILD_PREFIX.length).trim();
    const name = typeof val.name === 'string' ? val.name.trim() : '';
    const tag = typeof val.tag === 'string' ? val.tag.trim() : '';
    if (!id || !name || !tag) continue;

    const rawMembers = isObj(val.members)
      ? Object.values(val.members)
      : (Array.isArray(val.members) ? val.members : []);
    const members = rawMembers.filter((m) => isObj(m) && m.id != null && Number.isSafeInteger(Number(m.id)));
    if (!members.length) continue;

    const leaderId = val.leaderId != null && Number.isSafeInteger(Number(val.leaderId)) ? Number(val.leaderId) : null;
    const leaderMember = (leaderId != null ? members.find((m) => Number(m.id) === leaderId) : null)
      ?? members.find((m) => m.rank === 'Leader')
      ?? members[0];
    const leaderChar = leaderMember ? lookupCharacter(characterById, Number(leaderMember.id)) : null;
    const leaderName = (typeof leaderMember?.name === 'string' && leaderMember.name.trim())
      || leaderChar?.name
      || 'Unknown';

    let combinedLevel = 0;
    let combinedTotalSkill = 0;
    for (const m of members) {
      const ch = lookupCharacter(characterById, Number(m.id));
      if (!ch) continue;
      combinedLevel += nonNegInt(ch.level);
      combinedTotalSkill += nonNegInt(ch.totalSkill);
    }

    const treasury = nonNegInt(val.treasury);
    const createdAt = typeof val.createdAt === 'string'
      ? val.createdAt
      : (Number.isFinite(val.createdAt) ? new Date(val.createdAt).toISOString() : null);

    out.push(Object.freeze({
      id,
      name,
      tag,
      leaderName,
      memberCount: members.length,
      combinedLevel,
      combinedTotalSkill,
      treasury,
      createdAt,
    }));
  }

  return out;
}

/**
 * Compute eligibility, primary/secondary scores, tie-break milestone, and display badge
 * for a projected character (or Order summary) on a given board.
 */
export function scoreForBoard(record, boardId) {
  const empty = { eligible: false, score: 0, secondary: 0, milestoneAt: 0, badge: null };
  if (!isObj(record)) return empty;

  const board = isObj(boardId) ? resolveBoard(boardId.id) : resolveBoard(boardId);
  if (!board) return empty;

  const baseMilestone = toEpochMs(record.milestoneAt) ?? toEpochMs(record.updatedAt) ?? 0;

  if (board.group === 'skills') {
    const score = nonNegInt(record.skills?.[board.skill]);
    const secondary = nonNegInt(record.totalSkill);
    const milestoneAt = toEpochMs(record.skillMilestones?.[board.skill]) ?? baseMilestone;
    return {
      eligible: score >= board.minScore,
      score,
      secondary,
      milestoneAt,
      badge: score >= MAX_SKILL ? 'Master' : null,
    };
  }

  if (board.group === 'guilds') {
    const m = record.guilds?.[board.guild];
    if (!isObj(m) || !Number.isFinite(Number(m.rank)) || Number(m.rank) < 0) return empty;
    const score = Math.trunc(Number(m.rank));
    const secondary = Number.isFinite(Number(m.reputation)) ? Math.trunc(Number(m.reputation)) : 0;
    const badge = m.variantName ? `${m.title} · ${m.variantName}` : (m.title ?? null);
    return {
      eligible: score >= board.minScore,
      score,
      secondary,
      milestoneAt: baseMilestone,
      badge,
    };
  }

  if (board.id === 'orders') {
    const score = nonNegInt(record.memberCount);
    if (score < 1) return empty;
    const secondary = nonNegInt(record.combinedTotalSkill);
    const milestoneAt = toEpochMs(record.createdAt) ?? 0;
    return {
      eligible: true,
      score,
      secondary,
      milestoneAt,
      badge: record.tag ? `[${record.tag}]` : null,
    };
  }

  switch (board.id) {
    case 'overall': {
      const score = nonNegInt(record.totalSkill);
      return {
        eligible: score >= board.minScore,
        score,
        secondary: Math.max(1, nonNegInt(record.level)),
        milestoneAt: baseMilestone,
        badge: record.className || null,
      };
    }
    case 'level': {
      const score = nonNegInt(record.level);
      return {
        eligible: score >= board.minScore,
        score,
        secondary: nonNegInt(record.totalSkill),
        milestoneAt: baseMilestone,
        badge: record.className || null,
      };
    }
    case 'exploration': {
      const score = nonNegInt(record.placesDiscovered);
      return {
        eligible: score >= board.minScore,
        score,
        secondary: nonNegInt(record.trips),
        milestoneAt: baseMilestone,
        badge: score > 0 ? `${((score / TOTAL_CLASSIC_PLACES) * 100).toFixed(1)}%` : null,
      };
    }
    case 'quests': {
      const score = nonNegInt(record.questsCompleted);
      return {
        eligible: score >= board.minScore,
        score,
        secondary: Math.max(1, nonNegInt(record.level)),
        milestoneAt: baseMilestone,
        badge: null,
      };
    }
    case 'slayer': {
      const score = nonNegInt(record.monstersSlain);
      return {
        eligible: score >= board.minScore,
        score,
        secondary: Math.max(1, nonNegInt(record.level)),
        milestoneAt: baseMilestone,
        badge: null,
      };
    }
    case 'wanted': {
      const score = nonNegInt(record.infamy);
      return {
        eligible: score >= board.minScore,
        score,
        secondary: Math.max(1, nonNegInt(record.level)),
        milestoneAt: baseMilestone,
        badge: record.worstRegion ?? null,
      };
    }
    case 'admiralty': {
      const score = nonNegInt(record.admiraltyScore);
      return {
        eligible: score >= board.minScore,
        score,
        secondary: nonNegInt(record.admiraltyMaxStanding),
        milestoneAt: baseMilestone,
        badge: record.admiraltyRankTitle ?? null,
      };
    }
    default:
      return empty;
  }
}
