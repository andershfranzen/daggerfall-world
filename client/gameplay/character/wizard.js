// Creation wizard view. Renders a CharacterDraft into the panel container; all decisions go through the
// draft model, and only roll/create requests reach the server.

import * as R from './rules.js';
import { STEPS, STEP_TITLES } from './draft.js';
import { h, keptDetails, button, spinner } from './dom.js';
import { renderPortrait } from './art.js';

const GENDER_TEXT = {
  Male: 'Men and women are equal in every attribute and skill. Your choice changes only how you look.',
  Female: 'Men and women are equal in every attribute and skill. Your choice changes only how you look.',
};

const REFLEX_TEXT = {
  'Very High': 'Enemies react very quickly. Skills you use improve fastest.',
  High: 'Enemies react quickly. Skills improve a little faster.',
  Average: 'The standard pace for combat and learning.',
  Low: 'Enemies are slower to react. Skills improve a little more slowly.',
  'Very Low': 'Enemies are slowest to react. Skills improve most slowly.',
};

/**
 * @param {HTMLElement} root
 * @param {import('./draft.js').CharacterDraft} d
 * @param {{ update(): void, roll(): void, create(): void, cancel(): void, error: string|null, cfgNotes: Map<string,string> }} ctl
 */
export function renderWizard(root, d, ctl) {
  const steps = h('ol', { class: 'cc-steps', 'aria-label': 'Creation steps' },
    STEPS.map((s, i) => h('li', {
      class: s === d.step ? 'is-current' : i < d.stepIndex ? 'is-done' : '',
      'aria-current': s === d.step ? 'step' : null,
    }, h('button', {
      type: 'button', class: 'cc-step-btn', disabled: i > d.stepIndex,
      onClick: () => { if (d.goTo(s)) ctl.update(); },
    }, `${i + 1}. ${shortStep(s)}`))),
  );

  const body = h('div', { class: 'cc-step-body' }, STEP_VIEWS[d.step](d, ctl));
  const problem = d.stepProblem();
  const showsProblem = d.step === 'summary' || d.step === 'attributes' || d.step === 'skills' || (d.step === 'class' && d.classMode !== 'list');
  const message = ctl.error ?? (showsProblem ? problem : null);
  const nav = h('div', { class: 'cc-nav' },
    button('Cancel', () => ctl.cancel(), { class: 'btn cc-cancel' }),
    h('span', { class: 'cc-nav-spacer' }),
    d.stepIndex > 0 ? button('Back', () => { d.back(); ctl.update(); }) : null,
    d.step === 'summary'
      ? button('Begin your adventure', () => ctl.create(), { class: 'btn btn-primary', disabled: !!problem || ctl.busy })
      : button('Next', () => {
        if (d.next()) {
          if ((d.step === 'attributes') && !d.roll) ctl.roll();
          ctl.update();
        }
      }, { class: 'btn btn-primary', disabled: !!problem, title: problem ?? '' }),
  );

  root.replaceChildren(
    h('div', { class: 'cc-wizard' },
      h('header', { class: 'cc-wizard-head' }, h('h2', { tabindex: '-1' }, STEP_TITLES[d.step]), steps),
      body,
      h('p', { class: `cc-problem${ctl.error ? ' is-error' : ''}`, role: 'status', 'aria-live': 'polite' }, message ?? ''),
      nav,
    ),
  );
}

function shortStep(s) {
  return { race: 'Race', gender: 'Gender', class: 'Class', biography: 'Biography', name: 'Name', face: 'Face', attributes: 'Attributes', skills: 'Skills', reflexes: 'Reflexes', summary: 'Summary' }[s];
}

// ------------------------------------------------------------------ steps

const STEP_VIEWS = {
  race(d, ctl) {
    return h('div', { class: 'cc-choice-grid cc-races', role: 'radiogroup', 'aria-label': 'Race' },
      R.RACES.map((r) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(d.race === r.name),
        class: `cc-choice${d.race === r.name ? ' is-selected' : ''}`,
        onClick: () => { d.race = r.name; ctl.update(); },
        onDblclick: () => { d.race = r.name; d.next(); ctl.update(); },
      },
      renderPortrait({ race: r.name, gender: d.gender ?? 'Male', faceIndex: 0, size: 56 }),
      h('strong', null, r.name),
      h('small', null, r.blurb),
      r.resist.length || r.immune?.length
        ? h('em', null, [...r.resist.map((x) => `Resists ${x.toLowerCase()}`), ...(r.immune ?? []).map((x) => `Immune to ${x.toLowerCase()}`)].join(' · '))
        : null)),
    );
  },

  gender(d, ctl) {
    return h('div', null,
      h('div', { class: 'cc-choice-row', role: 'radiogroup', 'aria-label': 'Gender' },
        R.GENDERS.map((g) => h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(d.gender === g),
          class: `cc-choice${d.gender === g ? ' is-selected' : ''}`,
          onClick: () => { d.gender = g; ctl.update(); },
        }, renderPortrait({ race: d.race, gender: g, faceIndex: 0, size: 72 }), h('strong', null, g)))),
      h('p', { class: 'cc-note' }, GENDER_TEXT.Male),
    );
  },

  class(d, ctl) {
    const tabs = h('div', { class: 'cc-tabs', role: 'tablist' },
      [['list', 'Choose from a list'], ['questions', 'Answer questions'], ['custom', 'Design a custom class']].map(([m, label]) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(d.classMode === m), class: `cc-tab${d.classMode === m ? ' is-selected' : ''}`, onClick: () => { d.setMode(m); ctl.update(); } }, label)),
    );
    let content;
    if (d.classMode === 'list') content = classList(d, ctl);
    else if (d.classMode === 'questions') content = questions(d, ctl);
    else content = customBuilder(d, ctl);
    return h('div', null, tabs, content);
  },

  biography(d, ctl) {
    return biographyView(d, ctl);
  },

  name(d, ctl) {
    const input = h('input', {
      type: 'text', id: 'cc-name', class: 'cc-input', 'data-autofocus': true, maxLength: 24, autocomplete: 'off', spellcheck: false, value: d.name,
      onInput: (e) => {
        d.name = e.target.value;
        const msg = R.cleanCharacterName(d.name) ? '' : 'Use letters, spaces, apostrophes, periods or hyphens.';
        e.target.setAttribute('aria-invalid', String(!!msg));
        e.target.closest('.cc-wizard')?.querySelector('.cc-nav .btn-primary')?.toggleAttribute('disabled', !!msg);
        const note = e.target.parentElement.querySelector('.cc-field-note');
        if (note) note.textContent = msg;
      },
      onKeydown: (e) => {
        if (e.key !== 'Escape') e.stopPropagation(); // keep gameplay shortcuts out of the text field; Esc still closes
        if (e.key === 'Enter' && d.next()) ctl.update();
      },
    });
    return h('div', { class: 'cc-field' },
      h('label', { for: 'cc-name' }, 'What is your name?'),
      input,
      h('p', { class: 'cc-field-note', 'aria-live': 'polite' }),
      h('p', { class: 'cc-note' }, `${d.race} ${d.gender?.toLowerCase()} ${d.career()?.name ?? ''}`),
    );
  },

  face(d, ctl) {
    return h('div', null,
      h('div', { class: 'cc-faces', role: 'radiogroup', 'aria-label': 'Face' },
        Array.from({ length: R.FACE_COUNT }, (_, i) => h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(d.faceIndex === i), 'aria-label': `Face ${i + 1}`,
          class: `cc-face${d.faceIndex === i ? ' is-selected' : ''}`,
          onClick: () => { d.faceIndex = i; ctl.update(); },
        }, renderPortrait({ race: d.race, gender: d.gender, faceIndex: i, size: 64 })))),
      h('p', { class: 'cc-note' }, 'Portraits are read from your own game files and stay on this device.'),
    );
  },

  attributes(d, ctl) {
    if (!d.roll) {
      return h('div', { class: 'cc-wait' },
        h('p', null, d.pending ? 'Rolling…' : 'Your attributes have not been rolled yet.'),
        d.pending ? null : button('Roll', () => ctl.roll(), { class: 'btn btn-primary' }));
    }
    const left = d.attributePoolLeft();
    const pv = d.preview();
    const total = R.ATTRIBUTES.reduce((n, a) => n + d.roll.attributeBase[a], 0);
    return h('div', { class: 'cc-two-col' },
      h('div', { class: 'cc-spins' },
        R.ATTRIBUTES.map((a) => spinner({
          label: a, value: d.attributes[a], title: attributeHelp(a),
          highlight: d.attributes[a] > d.roll.attributeBase[a],
          canUp: left > 0 && d.attributes[a] < R.MAX_STAT, canDown: d.attributes[a] > d.roll.attributeBase[a],
          onUp: () => { d.attributeUp(a); ctl.update(); }, onDown: () => { d.attributeDown(a); ctl.update(); },
        }))),
      h('aside', { class: 'cc-side' },
        h('div', { class: 'cc-pool', 'aria-live': 'polite' }, h('span', null, 'Bonus points'), h('strong', null, String(left))),
        h('p', { class: 'cc-note' }, `Rolled total ${total} plus ${d.roll.bonusPool} bonus points. Roll ${d.roll.rolls}.`),
        pv ? h('dl', { class: 'cc-derived' },
          h('dt', null, 'Health'), h('dd', null, String(pv.maxHealth)),
          h('dt', null, 'Fatigue'), h('dd', null, String(pv.maxFatigue)),
          h('dt', null, 'Magicka'), h('dd', null, String(pv.maxMagicka))) : null,
        h('div', { class: 'cc-row' },
          button('Reroll', () => ctl.roll(), { disabled: d.pending || ctl.busy }),
          button('Spend remaining', () => { d.autoDistribute('attributes'); ctl.update(); }, { disabled: left === 0 })),
      ),
    );
  },

  skills(d, ctl) {
    if (!d.roll) return h('p', null, 'Rolling…');
    const career = d.career(); // the server's lists: what create will be validated against
    const group = (g, field, title) => h('section', { class: 'cc-skill-group' },
      h('h3', null, title, h('span', { class: 'cc-pool-inline' }, ` ${d.skillPoolLeft(g)} points left`)),
      career[field].map((s) => spinner({
        label: s, value: d.skills[s], hint: bonusHint(d, s),
        highlight: d.skills[s] > d.roll.skillBase[s],
        canUp: d.skillPoolLeft(g) > 0 && d.skills[s] < R.MAX_SKILL, canDown: d.skills[s] > d.roll.skillBase[s],
        onUp: () => { d.skillUp(s); ctl.update(); }, onDown: () => { d.skillDown(s); ctl.update(); },
      })));
    return h('div', null,
      h('div', { class: 'cc-skill-groups' },
        group('primary', 'primarySkills', 'Primary'),
        group('major', 'majorSkills', 'Major'),
        group('minor', 'minorSkills', 'Minor')),
      h('div', { class: 'cc-row' }, button('Spend remaining', () => { d.autoDistribute('skills'); ctl.update(); })),
      h('p', { class: 'cc-note' }, 'You may spend six points in each group. Your level rises as your primary and major skills improve through use.'),
      d.roll.career?.source === 'cfg' ? h('p', { class: 'cc-note' }, 'Skill groups come from this world\'s class records.') : null,
      bioSkillNote(d, career),
    );
  },

  reflexes(d, ctl) {
    return h('div', { class: 'cc-reflexes', role: 'radiogroup', 'aria-label': 'Reflexes' },
      R.REFLEXES.map((r) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(d.reflexes === r),
        class: `cc-choice cc-choice-wide${d.reflexes === r ? ' is-selected' : ''}`,
        onClick: () => { d.reflexes = r; ctl.update(); },
      }, h('strong', null, r), h('small', null, REFLEX_TEXT[r]))));
  },

  summary(d, ctl) {
    const career = d.career();
    const pv = d.preview();
    return h('div', { class: 'cc-summary' },
      h('div', { class: 'cc-summary-id' },
        renderPortrait({ race: d.race, gender: d.gender, faceIndex: d.faceIndex, size: 112 }),
        h('div', null,
          h('h3', null, R.cleanCharacterName(d.name) ?? ''),
          h('p', null, `${d.gender} ${d.race} ${career?.name ?? ''}`),
          h('p', { class: 'cc-note' }, `Reflexes: ${d.reflexes}`),
          pv ? h('p', { class: 'cc-note' }, `Health ${pv.maxHealth} · Fatigue ${pv.maxFatigue} · Magicka ${pv.maxMagicka}`) : null)),
      h('table', { class: 'cc-table' },
        h('tbody', null, R.ATTRIBUTES.map((a) => h('tr', null, h('th', null, a), h('td', null, String(d.attributes?.[a] ?? '—')))))),
      h('table', { class: 'cc-table' },
        h('tbody', null, [...career.primarySkills, ...career.majorSkills, ...career.minorSkills].map((s) =>
          h('tr', null, h('th', null, s), h('td', null, `${finalSkill(d, s)}%`))))),
      biographySummary(d),
      h('p', { class: 'cc-note cc-wide' }, 'Creation is permanent. Your current default adventurer will be replaced.'),
    );
  },
};

function attributeHelp(a) {
  return {
    Strength: 'Damage and carrying capacity.',
    Intelligence: 'Spell points.',
    Willpower: 'Resistance to magic.',
    Agility: 'Chance to hit.',
    Endurance: 'Health gained per level and fatigue.',
    Personality: 'How others react to you.',
    Speed: 'Movement and dodging.',
    Luck: 'A little of everything.',
  }[a];
}

function classList(d, ctl) {
  const groups = ['Magic', 'Mixed', 'Stealth', 'Combat'];
  const selected = d.className ? d.career() : null;
  return h('div', { class: 'cc-two-col' },
    h('div', { class: 'cc-class-list', role: 'listbox', 'aria-label': 'Classes' },
      groups.map((g) => h('div', { class: 'cc-class-group' },
        h('h3', null, g),
        R.CLASSES.filter((c) => c.group === g).map((c) => h('button', {
          type: 'button', role: 'option', 'aria-selected': String(d.className === c.name),
          class: `cc-class${d.className === c.name ? ' is-selected' : ''}`,
          onClick: () => { d.chooseClass(c.name); ctl.update(); },
          onDblclick: () => { d.chooseClass(c.name); d.next(); ctl.update(); },
        }, c.name)))),
    ),
    selected ? classCard(selected, ctl.cfgNotes?.get(selected.name), d.classDescription(selected.name)) : h('p', { class: 'cc-note' }, 'Select a class to see its skills.'),
  );
}

export function classCard(c, note, classicText = null) {
  return h('aside', { class: 'cc-class-card' },
    h('h3', null, c.name),
    classicText ? h('p', { class: 'cc-classic-text' }, reflow(classicText)) : h('p', null, c.blurb),
    h('dl', { class: 'cc-derived' },
      h('dt', null, 'Health per level'), h('dd', null, String(c.hitPointsPerLevel)),
      h('dt', null, 'Magicka'), h('dd', null, `${c.spellPointMultiplier}× INT`),
      h('dt', null, 'Advancement'), h('dd', null, `${c.advancementMultiplier}×`)),
    skillLine('Primary', c.primarySkills),
    skillLine('Major', c.majorSkills),
    skillLine('Minor', c.minorSkills),
    [...c.advantages, ...c.disadvantages].length
      ? h('p', { class: 'cc-note' }, [...c.advantages, ...c.disadvantages].map(R.describeAbility).join(' · '))
      : null,
    note ? h('p', { class: 'cc-note cc-cfg-note' }, note) : null,
  );
}

function skillLine(label, list) {
  return h('p', { class: 'cc-skill-line' }, h('strong', null, `${label}: `), list.join(', '));
}

/** Joins the classic file's hard-wrapped lines into paragraphs (wording untouched). */
function reflow(text) {
  return String(text).split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).join('\n\n');
}

function questions(d, ctl) {
  if (!d.quizAvailable()) {
    return h('div', { class: 'cc-wait' },
      h('p', null, 'The classic questionnaire is read from your own game files (TEXT.RSC and CLASSES.DAT in ARENA2).'),
      h('p', { class: 'cc-note' }, 'Select your Daggerfall folder when you enter the world to use it, or choose a class from the list.'));
  }
  if (!d.quiz) d.startQuiz();
  const q = d.quiz;
  if (q.classIndex != null) {
    const w = q.weights;
    return h('div', { class: 'cc-two-col' },
      h('div', null,
        h('p', null, 'Your answers suggest the path of the'),
        h('p', { class: 'cc-verdict' }, d.className),
        h('p', { class: 'cc-note' }, `Warrior ${w[0]} · Rogue ${w[1]} · Mage ${w[2]}`),
        button('Answer again', () => { d.startQuiz(); ctl.update(); })),
      classCard(d.career(), ctl.cfgNotes?.get(d.className), d.classDescription()));
  }
  const cq = d.quizQuestion();
  const n = q.answers.length;
  return h('div', { class: 'cc-question' },
    h('p', { class: 'cc-note' }, `Question ${n + 1} of ${q.indices.length}`),
    h('p', { class: 'cc-q cc-classic-text' }, cq.prompt),
    h('div', { class: 'cc-answers', role: 'group', 'aria-label': 'Answers' }, cq.answers.map((a, k) =>
      h('button', { type: 'button', class: 'cc-choice cc-choice-wide', 'data-focus-key': `quiz-${k}`, onClick: () => { d.answerQuiz(k); ctl.update(); } },
        h('strong', null, `${a.letter}) `), a.text))),
  );
}

// ------------------------------------------------------------------ biography (BIOGnnT0.TXT)

function biographyView(d, ctl) {
  d.syncBio();
  if (!d.biog()) {
    return h('div', { class: 'cc-wait' },
      h('p', null, 'The classic biography is read from your own game files (BIOG files and TEXT.RSC in ARENA2).'),
      h('p', { class: 'cc-note' }, d.serverBiography
        ? 'This world will choose your biography at random when you begin, since your files are not loaded here.'
        : 'This world has no biography data, so your character starts without one.'));
  }
  if (!d.serverBiography) {
    return h('div', { class: 'cc-wait' },
      h('p', null, 'This world has no biography data configured, so biography answers would have no effect.'),
      h('p', { class: 'cc-note' }, 'Continue to name your character.'));
  }
  const b = d.biog();
  if (!d.bioMode) {
    return h('div', { class: 'cc-bio-choose' },
      h('p', null, `Twelve questions shape your ${d.career()?.name ?? ''}'s past: starting skills, equipment, gold and how the people of the Iliac Bay regard you.`),
      h('div', { class: 'cc-choice-row' },
        h('button', { type: 'button', class: 'cc-choice', 'data-focus-key': 'bio-answer', onClick: () => { d.chooseBioMode('answer'); ctl.update(); } },
          h('strong', null, 'Answer the questions'), h('small', null, 'Choose each answer yourself.')),
        h('button', { type: 'button', class: 'cc-choice', 'data-focus-key': 'bio-random', onClick: () => { d.chooseBioMode('random'); ctl.update(); } },
          h('strong', null, 'Let fate decide'), h('small', null, 'Answers are chosen at random, as in the classic game.'))),
    );
  }
  const q = d.bioQuestion();
  if (q) {
    const n = d.bioAnswers.length;
    return h('div', { class: 'cc-question' },
      h('p', { class: 'cc-note' }, `Question ${n + 1} of ${b.questions.length}`),
      h('p', { class: 'cc-q cc-classic-text' }, q.text.join(' ')),
      h('div', { class: 'cc-answers', role: 'group', 'aria-label': 'Answers' }, q.answers.map((a, k) =>
        h('button', { type: 'button', class: 'cc-choice cc-choice-wide', 'data-focus-key': `bio-${k}`, onClick: () => { d.answerBio(k); ctl.update(); } },
          h('strong', null, `${String.fromCharCode(97 + k)}) `), a.text))),
      h('div', { class: 'cc-row' },
        n ? button('Previous question', () => { d.undoBio(); ctl.update(); }) : null,
        button('Let fate decide the rest', () => {
          const rest = d.bioAnswers.slice();
          d.chooseBioMode('random');
          d.bioAnswers = rest.concat(d.bioAnswers.slice(rest.length));
          d.bioMode = 'answer';
          ctl.update();
        })),
    );
  }
  return h('div', { class: 'cc-bio-done' },
    biographySummary(d, { full: true }),
    h('div', { class: 'cc-row' },
      button('Answer again', () => { d.chooseBioMode('answer'); ctl.update(); }),
      button('Let fate decide again', () => { d.chooseBioMode('random'); ctl.update(); })),
  );
}

const fmt = (n) => (n > 0 ? `+${n}` : String(n));

function biographySummary(d, { full = false } = {}) {
  const dg = d.bioDigest();
  if (!dg) {
    return d.serverBiography && !d.biog() ? h('p', { class: 'cc-note cc-wide' }, 'Biography: chosen at random by the world when you begin.') : null;
  }
  const skills = Object.entries(dg.skills).filter(([, v]) => v);
  const reps = dg.socialGroups.map((v, i) => [v, i]).filter(([v]) => v);
  const story = full ? d.backstory() : [];
  return h('section', { class: 'cc-bio-summary cc-wide' },
    h('h3', null, 'Biography'),
    skills.length ? h('p', null, h('strong', null, 'Skills: '), skills.map(([k, v]) => `${k} ${fmt(v)}`).join(', ')) : null,
    reps.length ? h('p', null, h('strong', null, 'Reputation: '), reps.map(([v, i]) => `${['Commoners', 'Merchants', 'Scholars', 'Nobility', 'Underworld'][i]} ${v > 0 ? 'higher' : 'lower'}`).join(', ')) : null,
    dg.gold ? h('p', null, h('strong', null, 'Gold: '), String(dg.gold)) : null,
    dg.items.length ? h('p', null, h('strong', null, 'Starting items: '), `${dg.items.length} from your past (given when you begin)`) : null,
    story.length ? keptDetails('wizard-story', true, { class: 'cc-details' }, 'Your story',
      h('div', { class: 'cc-backstory cc-classic-text' }, story.map((l) => (l ? h('p', null, l) : null)))) : null,
  );
}

function bonusHint(d, s) {
  const b = d.bioSkillBonus(s);
  return b ? fmt(b) : R.ATTRIBUTE_ABBR[R.SKILL_ATTRIBUTE[s]];
}

function finalSkill(d, s) {
  const v = d.skills?.[s];
  return v == null ? '—' : Math.max(0, Math.min(R.MAX_SKILL, v + d.bioSkillBonus(s)));
}

function bioSkillNote(d, career) {
  const dg = d.bioDigest();
  if (!dg) return null;
  const outside = Object.entries(dg.skills).filter(([k, v]) => v && !R.skillGroupOf(career, k));
  return h('p', { class: 'cc-note' }, 'Numbers marked + are biography bonuses, added when you begin.',
    outside.length ? ` Also: ${outside.map(([k, v]) => `${k} ${fmt(v)}`).join(', ')}.` : '');
}

function customBuilder(d, ctl) {
  const c = d.custom;
  const diff = d.customDifficulty();
  const total = d.customTotal();
  const inRange = diff >= R.CUSTOM.minDifficulty && diff <= R.CUSTOM.maxDifficulty;
  const gaugePct = Number.isFinite(diff) ? ((Math.max(-12, Math.min(40, diff)) + 12) / 52) * 100 : 0;
  const skillButtons = Object.entries(R.SKILL_CATEGORIES).map(([cat, list]) => h('div', { class: 'cc-custom-cat' },
    h('h4', null, cat),
    list.map((s) => {
      const g = d.customSkillGroup(s);
      return h('button', {
        type: 'button', class: `cc-tag${g ? ` is-${g}` : ''}`, 'aria-pressed': String(!!g),
        title: 'Click to cycle: primary → major → minor → none',
        onClick: () => { d.cycleCustomSkill(s); ctl.update(); },
      }, s, g ? h('span', { class: 'cc-tag-group' }, g[0].toUpperCase()) : null);
    })));

  const abilities = (kind, table) => h('div', { class: 'cc-abilities' },
    Object.entries(table).map(([key, def]) => {
      const picked = c[kind === 'advantage' ? 'advantages' : 'disadvantages'].filter((e) => e.key === key);
      const opts = def.options ? Object.entries(def.options) : [[null, def.cost]];
      return h('div', { class: 'cc-ability' },
        h('span', { class: 'cc-ability-name' }, def.label),
        h('span', { class: 'cc-ability-opts' }, opts.map(([opt, cost]) => {
          const on = picked.some((e) => (e.option ?? null) === opt);
          return h('button', {
            type: 'button', class: `cc-tag${on ? ' is-on' : ''}`, 'aria-pressed': String(on),
            onClick: () => { d.toggleAbility(kind, key, opt); ctl.update(); },
          }, opt ?? 'Take', h('span', { class: 'cc-cost' }, ` ${cost > 0 ? '+' : ''}${cost}`));
        })));
    }));

  const nameInput = h('input', {
    type: 'text', class: 'cc-input', maxLength: 16, value: c.name, placeholder: 'Class name', 'aria-label': 'Class name',
    onInput: (e) => { c.name = e.target.value; d.invalidateRoll(); },
    onChange: () => ctl.update(),
    onKeydown: (e) => { if (e.key !== 'Escape') e.stopPropagation(); },
  });

  return h('div', { class: 'cc-custom' },
    h('div', { class: 'cc-custom-top' },
      nameInput,
      spinner({ label: 'Health per level', value: c.hitPointsPerLevel, canUp: c.hitPointsPerLevel < R.CUSTOM.maxHp, canDown: c.hitPointsPerLevel > R.CUSTOM.minHp, onUp: () => { d.customHp(1); ctl.update(); }, onDown: () => { d.customHp(-1); ctl.update(); } }),
      h('div', { class: `cc-gauge${inRange ? '' : ' is-bad'}`, role: 'meter', 'aria-label': 'Advancement difficulty', 'aria-valuemin': -12, 'aria-valuemax': 40, 'aria-valuenow': diff },
        h('span', { class: 'cc-gauge-label' }, 'Difficulty'),
        h('span', { class: 'cc-gauge-track' }, h('span', { class: 'cc-gauge-mark', style: { left: `${gaugePct}%` } })),
        h('span', { class: 'cc-gauge-num' }, Number.isFinite(diff) ? `${diff} · ×${R.advancementMultiplierFor(diff)}` : '—')),
    ),
    h('section', null,
      h('h3', null, 'Attributes ', h('span', { class: `cc-pool-inline${total === R.CUSTOM.statTotal ? '' : ' is-bad'}` }, `${total} / ${R.CUSTOM.statTotal}`)),
      h('div', { class: 'cc-spins cc-spins-4' }, R.ATTRIBUTES.map((a) => spinner({
        label: a, value: c.attributes[a],
        canUp: c.attributes[a] < R.CUSTOM.statMax, canDown: c.attributes[a] > R.CUSTOM.statMin,
        onUp: () => { d.customAttribute(a, 1); ctl.update(); }, onDown: () => { d.customAttribute(a, -1); ctl.update(); },
      })))),
    h('section', null,
      h('h3', null, 'Skills ', h('span', { class: 'cc-pool-inline' }, `primary ${c.primarySkills.length}/3 · major ${c.majorSkills.length}/3 · minor ${c.minorSkills.length}/6`)),
      h('div', { class: 'cc-custom-skills' }, skillButtons)),
    keptDetails('custom-advantages', c.advantages.length > 0, { class: 'cc-details' }, `Special advantages (${c.advantages.length})`, abilities('advantage', R.ADVANTAGES)),
    keptDetails('custom-disadvantages', c.disadvantages.length > 0, { class: 'cc-details' }, `Special disadvantages (${c.disadvantages.length})`, abilities('disadvantage', R.DISADVANTAGES)),
  );
}
