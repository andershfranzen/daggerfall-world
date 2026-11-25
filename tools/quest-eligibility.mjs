// Quest census by genuine eligibility (docs/quest-census.md, backlog package 17). For every QBN in the local
// installation it reports three separate facts:
//   engine   'runs' means the static analyser found no unsupported instruction or resource. Approximations and
//            ignored actions can still occur (server/rpg/quests/engine.js).
//   offer    who in the world starts it and what the character needs first: an ordinary giver's group and the
//            QuestListsManager gates mirrored from server/rpg/quests.js eligible(), or a special trigger
//   played   a recorded test and the portion of the quest it exercised (PLAYED below)
// Givers are the source people the NPC reader marks with a quest group (server/rpg/npcs/people.js); guild joining
// routes come from package 15 (server/rpg/guilds/rules.js GROUPS); Daedra princes from package 19
// (server/rpg/special/daedra.js).
//
//   node tools/quest-eligibility.mjs            summary on stdout
//   node tools/quest-eligibility.mjs --json     one row per quest
import { resolve } from 'node:path';
import { loadCatalog } from '../server/rpg/quests/catalog.js';
import { artifactResolver, loadMagicDef } from '../server/rpg/alchemy/magicdef.js';
import { GROUPS, DIVINES } from '../server/rpg/guilds/rules.js';
import { DAEDRA_QUESTS } from '../server/rpg/special/daedra.js';
import { VAMPIRE_INITIAL } from '../server/rpg/special/triggers.js';

const dir = resolve(process.env.ARENA2_DIR || 'gamedata/DaggerfallGameFiles/arena2');
// Artifact rewards resolve as in production (package 16's MAGIC.DEF catalogue), like tools/classic-feature-gaps.mjs.
const magic = loadMagicDef(dir);
const artifactTemplate = magic.error ? null : artifactResolver(magic.records.filter((r) => r.type === 1 || r.type === 2));
const cat = loadCatalog({ dataPath: dir, artifact: artifactTemplate ? (r) => !!artifactTemplate(r.detail ?? r.classicItem?.index) : null });

/** Selected checks against installed quests. Late-stage fixtures and offer checks have narrower coverage. */
const PLAYED = {
  K0C00Y08: 'test/rpg-quest-dungeon.test.mjs (fixture positions; the live walk is test/rpg-quest-rare-book-walk.test.mjs)',
  K0C00Y09: 'test/rpg-quest-dungeon-jobs.test.mjs (kill and flee branches)',
  A0C01Y03: 'test/rpg-quest-dungeon-jobs.test.mjs',
  A0C10Y05: 'test/rpg-quest-social-routes.test.mjs (escort companions, payment and expiry, staged approaches)',
  K0C00Y07: 'test/rpg-quest-social-routes.test.mjs (ransom, payment and expiry, staged approaches)',
  A0C00Y10: 'test/rpg-quest.test.mjs',
  A0C00Y21: 'test/rpg-world-integration.test.mjs (live sockets)',
  G0B00Y00: 'test/rpg-quest-dungeon-jobs.test.mjs (authored Kynareth giver, membership refusals and acceptance)',
  O0A0AL00: 'test/rpg-special-quests.test.mjs (Thieves Guild invitation, delivery, rank zero and restart)',
  L0A01L00: 'test/rpg-special-quests.test.mjs (Brotherhood invitation, decanter delivery, rank zero and restart)',
  '$CUREVAM': 'test/rpg-special-quests.test.mjs (84-day trigger and vampire cure, staged locations)',
  '$CUREWER': 'test/rpg-special-quests.test.mjs (84-day trigger and lycanthropy cure, staged locations)',
  P0A01L00: 'test/rpg-special-quests.test.mjs (38-day trigger, fixture positions, ring reward once)',
  P0B00L01: 'test/rpg-special-quests.test.mjs (later 38-day trigger, clan faction and journal across restart)',
  S0000008: 'test/rpg-quest-dungeon.test.mjs (late-stage fixture)',
  S0000016: 'test/rpg-quest-dungeon.test.mjs (late-stage fixture)',
};

const GROUP_GIVER = {
  Commoners: 'named-building residents (daily work roll)',
  Merchants: 'shopkeepers and merchants (daily work roll)',
  Nobility: 'nobles and palace courts (daily work roll)',
  FightersGuild: 'Fighters Guild hall', MagesGuild: 'Mages Guild hall', HolyOrder: 'temple staff',
  KnightlyOrder: 'knightly order halls', DarkBrotherHood: 'Dark Brotherhood', GeneralPopulace: 'Thieves Guild',
  Witches: 'witch covens',
};
const GUILD = { FightersGuild: 'fighters', MagesGuild: 'mages', HolyOrder: 'temple', KnightlyOrder: 'knights', DarkBrotherHood: 'brotherhood', GeneralPopulace: 'thieves' };
/** How a character joins (package 15): at the hall, or by the guild's own invitation quest. */
const joinRoute = (guild) => (GROUPS[guild]?.invite ? `invitation ${GROUPS[guild].invite}` : GROUPS[guild] ? 'joins at the hall' : 'no joining route');
const SPECIAL_OK = /^(not a guild or social quest|no offer text|not in the operator quest list)/;

function triggerOf(name) {
  if (DAEDRA_QUESTS.has(name)) return 'Daedra summoning (package 19)';
  if (/^S\d{7}$|^_|^START/.test(name)) return 'main story (package 18)';
  if (name.startsWith('$')) return 'cure (packages 10/19)';
  return 'other special trigger';
}

const rows = [];
for (const f of cat.failures) rows.push({ id: f.name, engine: 'unreadable', offer: 'none', need: f.error, played: null });
for (const q of [...cat.quests.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const m = q.meta;
  const blockers = q.analysis.unsupported.filter((u) => !SPECIAL_OK.test(u));
  const played = DAEDRA_QUESTS.has(q.name)
    ? 'test/rpg-special-quests.test.mjs (installed demand and artifact payout, staged time, combat and quest sites)'
    : PLAYED[q.name] ?? null;
  const row = { id: q.name, group: m.group, membership: m.membership, minReq: m.minReq, engine: blockers.length ? 'blocked' : 'runs', blockers, played };
  const noText = q.analysis.unsupported.some((u) => /no offer text/.test(u));
  if (!m.group) {
    row.offer = 'special trigger';
    row.need = triggerOf(q.name);
  } else if (m.group === 'Vampires') {
    row.offer = 'vampire clan trigger';
    row.need = q.name === VAMPIRE_INITIAL
      ? 'first clan letter on a successful 38-day vampire check'
      : `later 38-day vampire check, clan member, ${m.minReq >= 10 ? 'clan reputation' : 'level'} ${m.minReq}`;
  } else if (noText) {
    row.offer = 'special trigger';
    row.need = `no message 1000; started by its own trigger (${Object.values(GROUPS).find((g) => g.invite === q.name)?.name ?? m.group} invitation or contact)`;
  } else if (m.adult) {
    row.offer = 'operator opt-in';
    row.need = 'adult quest (questAdult)';
  } else if (!GROUP_GIVER[m.group]) {
    row.offer = 'no ordinary giver';
    row.need = `${m.group}: no source-placed giver`;
  } else if (m.membership === 'P') {
    row.offer = 'special trigger';
    row.need = `${m.group} prospect (invitation) quest`;
  } else if (m.deity !== undefined) {
    row.offer = 'ordinary: temple member';
    row.need = `${DIVINES[m.deity]?.name ?? m.deity} temple member, rank ${m.minReq}, at that deity’s temple`;
  } else if (GUILD[m.group]) {
    const g = GUILD[m.group];
    if (m.membership === 'N') {
      row.offer = m.minReq === 0 ? 'ordinary: new character' : 'unreachable rule';
      row.need = m.minReq === 0 ? `non-member, ${GROUP_GIVER[m.group]}` : `non-member quest with minReq ${m.minReq}`;
    } else {
      row.offer = 'ordinary: guild member';
      row.need = `${g} member (${joinRoute(g)}), ${m.minReq >= 10 ? `reputation ${m.minReq}` : `rank ${m.minReq}`}`;
    }
  } else {
    const sex = m.membership === 'M' ? ' (male)' : m.membership === 'F' ? ' (female)' : '';
    row.offer = m.minReq <= 1 ? 'ordinary: new character' : 'ordinary: level or reputation';
    row.need = `${GROUP_GIVER[m.group]}${sex}${m.minReq > 1 ? `, level ${m.minReq} or reputation ${m.minReq}` : ''}`;
  }
  rows.push(row);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 1));
} else {
  const count = (f) => rows.filter(f).length;
  console.log(`${rows.length} quest files in ${dir}`);
  console.log(`static engine analysis: ${count((r) => r.engine === 'runs')} without a known blocker, ${count((r) => r.engine === 'blocked')} blocked, ${count((r) => r.engine === 'unreadable')} unreadable`);
  const ordinary = [...cat.quests.values()].filter(q => q.analysis.offerable).length;
  console.log(`ordinary-offer analysis: ${ordinary} pass, ${cat.quests.size - ordinary} outside the pool`);
  console.log(`quests with a test cited in this report: ${count((r) => r.played)}\n`);
  const by = new Map();
  for (const r of rows) {
    const k = `${r.offer}${r.engine === 'runs' ? '' : ` [engine ${r.engine}]`}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  for (const [status, list] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`${String(list.length).padStart(4)}  ${status}`);
    const needs = new Map();
    for (const r of list) {
      const k = r.engine === 'blocked' ? `${r.need} — ${r.blockers.join('; ')}` : r.need;
      needs.set(k, [...(needs.get(k) ?? []), r.played ? `${r.id}*` : r.id]);
    }
    for (const [need, ids] of [...needs].sort((a, b) => b[1].length - a[1].length)) console.log(`        ${String(ids.length).padStart(3)}  ${need}: ${ids.join(' ')}`);
  }
  console.log('\n* a recorded test covers this quest; see the played field in --json for its scope');
}
