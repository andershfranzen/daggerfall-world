// Chronicles of the Iliac Bay (Hiscores) — canonical board & category registry.
// Pure ES module: no database or network I/O.

import { SKILLS, SKILL_CATEGORIES, MAX_SKILL } from '../../client/gameplay/character/rules.js';
import { GROUPS, groupName, rankTitle, DIVINES, ORDERS } from '../rpg/guilds/rules.js';

export const TOTAL_CLASSIC_PLACES = 15251;

/** Convert a canonical Daggerfall skill name into a stable lowercase hyphenated slug. */
export function skillSlug(skillName) {
  return String(skillName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const SLUG_BY_SKILL = Object.freeze(
  Object.fromEntries(SKILLS.map((s) => [s, skillSlug(s)])),
);

export const SKILL_BY_SLUG = Object.freeze(
  Object.fromEntries(SKILLS.map((s) => [SLUG_BY_SKILL[s], s])),
);

const CATEGORY_BY_SKILL = Object.freeze(
  Object.fromEntries(
    Object.entries(SKILL_CATEGORIES).flatMap(([category, list]) => list.map((skill) => [skill, category])),
  ),
);

export const CORE_BOARDS = Object.freeze([
  Object.freeze({
    id: 'overall',
    label: 'Overall',
    group: 'core',
    unit: 'pts',
    description: 'Total skill level summed across all 35 classic Daggerfall skills.',
    minScore: 0,
  }),
  Object.freeze({
    id: 'level',
    label: 'Character Level',
    group: 'core',
    unit: 'lvl',
    description: 'Highest character level attained across the Iliac Bay.',
    minScore: 1,
  }),
  Object.freeze({
    id: 'exploration',
    label: 'Cartography',
    group: 'core',
    unit: 'places',
    description: `Unique places discovered across the ${TOTAL_CLASSIC_PLACES.toLocaleString('en-US')} classic sites of the Iliac Bay.`,
    minScore: 1,
  }),
  Object.freeze({
    id: 'quests',
    label: 'Quests Completed',
    group: 'core',
    unit: 'quests',
    description: 'Completed quests and guild contracts across High Rock and Hammerfell.',
    minScore: 1,
  }),
  Object.freeze({
    id: 'slayer',
    label: 'Monsters Slain',
    group: 'core',
    unit: 'slain',
    description: 'Foes vanquished in dungeons, wilderness, and lairs.',
    minScore: 1,
  }),
  Object.freeze({
    id: 'wanted',
    label: 'Most Wanted',
    group: 'core',
    unit: 'infamy',
    description: 'Iliac Bay infamy across regional courts, banishments, and piracy.',
    minScore: 1,
  }),
  Object.freeze({
    id: 'admiralty',
    label: 'Admiralty & High Seas',
    group: 'core',
    unit: 'prestige',
    description: 'Crown naval standing, sea contracts, and pirate prizes claimed at sea.',
    minScore: 1,
  }),
]);

const GUILD_ORDER = Object.freeze(['fighters', 'mages', 'thieves', 'brotherhood', 'temple', 'knights']);
const EMPTY_FACTION_TABLE = Object.freeze({ get: () => null });

function guildDescription(group) {
  const top = rankTitle(group, 9);
  if (group === 'temple') {
    return `Standing across the ${Object.keys(DIVINES).length} Divines temples, up to ${top}.`;
  }
  if (group === 'knights') {
    return `Standing across the ${Object.keys(ORDERS).length} Knightly Orders of the Iliac Bay, up to ${top}.`;
  }
  return `Guild rank within ${groupName(EMPTY_FACTION_TABLE, group, null)}, up to ${top}.`;
}

export const GUILD_BOARDS = Object.freeze(
  GUILD_ORDER.map((g) => Object.freeze({
    id: `guild:${g}`,
    guild: g,
    label: GROUPS[g].name,
    group: 'guilds',
    unit: 'rank',
    description: guildDescription(g),
    minScore: 0,
    requiresMembership: true,
  })),
);

export const SKILL_BOARDS = Object.freeze(
  SKILLS.map((skill) => {
    const slug = SLUG_BY_SKILL[skill];
    return Object.freeze({
      id: `skill:${slug}`,
      label: skill,
      group: 'skills',
      skill,
      slug,
      category: CATEGORY_BY_SKILL[skill] ?? 'General',
      unit: 'lvl',
      description: `Classic ${skill} mastery (0–${MAX_SKILL}).`,
      minScore: 1,
      maxScore: MAX_SKILL,
    });
  }),
);

export const ORDERS_BOARD = Object.freeze({
  id: 'orders',
  label: 'Player Orders',
  group: 'orders',
  unit: 'members',
  description: 'Persistent player-founded Orders across the Iliac Bay.',
});

export const ALL_BOARDS = Object.freeze([
  ...CORE_BOARDS,
  ...GUILD_BOARDS,
  ...SKILL_BOARDS,
  ORDERS_BOARD,
]);

export const BOARD_BY_ID = Object.freeze(
  Object.fromEntries(ALL_BOARDS.map((b) => [b.id, b])),
);

/**
 * Resolve a board identifier (canonical id, bare skill name/slug, or empty -> 'overall').
 * Returns null if the identifier does not match any known board.
 */
export function resolveBoard(id) {
  if (id == null) return BOARD_BY_ID.overall;
  const raw = String(id).trim();
  if (!raw) return BOARD_BY_ID.overall;

  if (Object.hasOwn(BOARD_BY_ID, raw)) return BOARD_BY_ID[raw];

  const lower = raw.toLowerCase();
  if (Object.hasOwn(BOARD_BY_ID, lower)) return BOARD_BY_ID[lower];

  if (lower.startsWith('skill:')) {
    const slug = skillSlug(lower.slice(6));
    if (Object.hasOwn(SKILL_BY_SLUG, slug)) return BOARD_BY_ID[`skill:${slug}`];
    return null;
  }

  if (lower.startsWith('guild:')) {
    const g = lower.slice(6).trim();
    if (Object.hasOwn(GROUPS, g)) return BOARD_BY_ID[`guild:${g}`];
    return null;
  }

  const slug = skillSlug(raw);
  if (Object.hasOwn(SKILL_BY_SLUG, slug)) return BOARD_BY_ID[`skill:${slug}`];

  if (Object.hasOwn(GROUPS, lower)) return BOARD_BY_ID[`guild:${lower}`];

  return null;
}

/** Public JSON payload describing all Chronicles boards grouped for UI navigation. */
export function publicCategoriesPayload() {
  return {
    version: 1,
    totalClassicPlaces: TOTAL_CLASSIC_PLACES,
    groups: [
      { id: 'core', label: 'Core Chronicles', boards: CORE_BOARDS },
      { id: 'guilds', label: 'Classic Guilds', boards: GUILD_BOARDS },
      { id: 'skills', label: 'Classic Skills', boards: SKILL_BOARDS },
      { id: 'orders', label: 'Player Orders', boards: [ORDERS_BOARD] },
    ],
  };
}
