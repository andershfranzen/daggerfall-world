// Character sheet view: identity, vitals, attributes, skills by group, level progress and the level-up
// attribute distribution. Values shown are the server's; only the level-up spend is proposed from here.

import * as R from './rules.js';
import { h, keptDetails, button, spinner, bar } from './dom.js';
import { renderPortrait } from './art.js';
import { classCard } from './wizard.js';

/**
 * @param {HTMLElement} root
 * @param {object} ch      state.character from the server
 * @param {{ levelDraft: import('./draft.js').LevelUpDraft|null, update(): void, startCreate(): void,
 *           submitLevel(): void, clearRecent(): void, tab: string, setTab(t: string): void, busy: boolean,
 *           error: string|null }} ctl
 */
export function renderSheet(root, ch, ctl) {
  // The server publishes the career it validates against (ruleset, operator CLASS*.CFG or custom).
  const career = ch.career ?? ch.custom ?? R.CLASS_BY_NAME[ch.className] ?? R.CLASS_BY_NAME[R.DEFAULT_CLASS];
  const progress = R.levelProgress(ch.startingLevelUpSkillSum, ch.currentLevelUpSkillSum);
  const recent = new Set(ch.recentlyRaised ?? []);
  const race = R.RACE_BY_NAME[ch.race];
  const resistances = [...(race?.resist ?? []).map((element) => `Resists ${element}`),
    ...(race?.immune ?? []).map((element) => `Immune to ${element}`)];

  const banner = !ch.created
    ? h('div', { class: 'cc-banner', role: 'note' },
      h('p', null, h('strong', null, 'You are playing a default adventurer. '), 'Create your own character to choose a race, class and appearance. Creation can be done once and replaces this adventurer.'),
      button('Create character', () => ctl.startCreate(), { class: 'btn btn-primary' }))
    : null;

  const id = h('section', { class: 'cc-id' },
    renderPortrait({ race: ch.race, gender: ch.gender, faceIndex: ch.faceIndex, size: 96 }),
    h('div', { class: 'cc-id-text' },
      h('h2', null, ch.name),
      h('p', null, `${ch.gender} ${ch.race} ${ch.className}`),
      h('p', { class: 'cc-level' }, h('span', null, `Level ${ch.level}`),
        h('span', { class: 'cc-level-track', role: 'progressbar', 'aria-label': 'Progress to next level', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(progress * 100) },
          h('span', { class: 'cc-level-fill', style: { width: `${Math.round(progress * 100)}%` } }))),
      h('p', { class: 'cc-note' }, `Reflexes ${ch.reflexes}`),
      resistances.length ? h('p', { class: 'cc-note' }, resistances.join(' · ')) : null),
    h('div', { class: 'cc-vitals' },
      bar('health', ch.health, ch.maxHealth, 'Health'),
      bar('fatigue', ch.fatigue, ch.maxFatigue, 'Fatigue'),
      bar('magicka', ch.magicka, ch.maxMagicka, 'Magicka')),
  );

  const lv = ctl.levelDraft;
  const attrs = h('section', { class: 'cc-attrs' },
    h('h3', null, 'Attributes', lv ? h('span', { class: 'cc-pool-inline' }, ` ${lv.left()} points to distribute`) : null),
    lv
      ? h('div', { class: 'cc-spins' }, R.ATTRIBUTES.map((a) => spinner({
        label: a, value: lv.attributes[a], highlight: lv.attributes[a] > lv.start[a],
        canUp: lv.left() > 0 && lv.attributes[a] < R.MAX_STAT, canDown: lv.attributes[a] > lv.start[a],
        onUp: () => { lv.up(a); ctl.update(); }, onDown: () => { lv.down(a); ctl.update(); },
      })))
      : h('table', { class: 'cc-table' }, h('tbody', null, R.ATTRIBUTES.map((a) => {
        const base = ch.attributes[a];
        const live = ch.effectiveAttributes?.[a] ?? base;
        return h('tr', null, h('th', { title: a }, a),
          h('td', { title: live !== base ? `Base ${base}` : null }, live !== base ? `${live} (${base})` : String(base)),
          h('td', { class: 'cc-mod' }, fmtMod(R.attributeModifier(live))));
      }))),
    lv ? h('div', { class: 'cc-row' },
      button('Accept', () => ctl.submitLevel(), { class: 'btn btn-primary', disabled: !!lv.problem() || ctl.busy }),
      h('span', { class: 'cc-note' }, lv.problem() ?? 'Ready.')) : null,
  );

  const tabs = ['primary', 'major', 'minor', 'misc'];
  const groupList = {
    primary: career.primarySkills, major: career.majorSkills, minor: career.minorSkills,
    misc: R.SKILLS.filter((s) => !R.skillGroupOf(career, s)),
  };
  const skillRows = groupList[ctl.tab].map((s) => {
    const value = ch.skills[s];
    const uses = ch.skillUses?.[s] ?? 0;
    const need = R.usesForAdvancement(value, s, career.advancementMultiplier, ch.level);
    const pct = Math.min(100, Math.round((R.effectiveUses(uses, ch.reflexes) / need) * 100));
    const ceiling = R.skillCeiling(ch.skills, career, s);
    return h('tr', { class: recent.has(s) ? 'is-raised' : null },
      h('th', null, s),
      h('td', { class: 'cc-gov' }, R.ATTRIBUTE_ABBR[R.SKILL_ATTRIBUTE[s]]),
      h('td', { class: 'cc-skill-val' }, `${value}%`),
      h('td', { class: 'cc-skill-prog' }, value >= ceiling
        ? h('span', { title: `Skill limit ${ceiling}%` }, 'Capped')
        : h('span', { class: 'cc-mini-track', title: `${pct}% toward the next point` }, h('span', { class: 'cc-mini-fill', style: { width: `${pct}%` } }))));
  });
  const skills = h('section', { class: 'cc-skills' },
    h('div', { class: 'cc-tabs', role: 'tablist', 'aria-label': 'Skill groups' },
      tabs.map((t) => h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(ctl.tab === t), class: `cc-tab${ctl.tab === t ? ' is-selected' : ''}`,
        onClick: () => ctl.setTab(t),
      }, t === 'misc' ? 'Miscellaneous' : t[0].toUpperCase() + t.slice(1)))),
    h('table', { class: 'cc-table cc-skill-table' },
      h('thead', null, h('tr', null, h('th', null, 'Skill'), h('th', null, 'Attr.'), h('th', null, 'Value'), h('th', null, 'Practice'))),
      h('tbody', null, skillRows)),
    recent.size ? h('div', { class: 'cc-recent-row' },
      h('span', { class: 'cc-note' }, `Recently improved: ${[...recent].join(', ')}`),
      button('Clear', () => ctl.clearRecent(), { class: 'btn btn-small' })) : null,
  );

  root.replaceChildren(h('div', { class: 'cc-sheet' },
    banner,
    id,
    ctl.error ? h('p', { class: 'cc-problem is-error', role: 'alert' }, ctl.error) : null,
    h('div', { class: 'cc-sheet-cols' }, attrs, skills),
    biographyDetails(ch.biography),
    keptDetails('sheet-class', false, { class: 'cc-details' }, `About the ${career.name}`, classCard(career)),
  ));
}

const GROUPS = ['Commoners', 'Merchants', 'Scholars', 'Nobility', 'Underworld'];
const titleCase = (key) => key.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** The server's record of the classic biography: story, standing, bonuses and what it gave. */
function biographyDetails(bio) {
  if (!bio) return null;
  const skills = Object.entries(bio.skills ?? {}).filter(([, v]) => v);
  const counts = new Map();
  for (const i of bio.items ?? []) if (i.template) counts.set(i.template, (counts.get(i.template) ?? 0) + 1);
  const given = [...counts].map(([t, n]) => (n > 1 ? `${titleCase(t)} ×${n}` : titleCase(t)));
  const missing = (bio.items ?? []).filter((i) => !i.template).length;
  return keptDetails('sheet-biography', false, { class: 'cc-details cc-bio' }, 'Biography',
    h('div', { class: 'cc-backstory cc-classic-text' }, (bio.backstory ?? []).map((l) => (l ? h('p', null, l) : null))),
    h('table', { class: 'cc-table' }, h('tbody', null, GROUPS.map((g, i) => {
      const v = bio.socialGroups?.[i] ?? 0;
      return h('tr', null, h('th', null, g), h('td', null, v === 0 ? 'unchanged' : `${v > 0 ? '+' : ''}${v}`));
    }))),
    skills.length ? h('p', { class: 'cc-note' }, `Skill bonuses: ${skills.map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(', ')}`) : null,
    bio.gold || given.length ? h('p', { class: 'cc-note' }, `Received: ${[bio.gold ? `${bio.gold} gold` : null, ...given].filter(Boolean).join(', ')}`) : null,
    missing ? h('p', { class: 'cc-note' }, `${missing} item${missing > 1 ? 's' : ''} from your past have no counterpart in this world yet.`) : null,
  );
}

function fmtMod(n) {
  return n > 0 ? `+${n}` : String(n);
}
