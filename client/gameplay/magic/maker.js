import { ELEMENT_LABEL, TARGET_LABEL, magickaCost, statsOf } from './model.js';
import { ICON_COUNT } from './art.js';

const multiplier = { caster: 1, touch: 1, singleAtRange: 1.5, areaAroundCaster: 2, areaAtRange: 2.5 };

function compatible(template, draft) {
  return template.elements.includes(draft.element) &&
    (template.targets === 'all' || (template.targets === 'self') === (draft.targetType === 'caster'));
}

function effectPrice(template, settings) {
  if (!template.groups.length) return 320; // DFU zero-component cost used by Recall.
  const get = (key) => settings[key] ?? 1;
  const average = (a, b) => Math.trunc((get(a) + get(b)) / 2);
  return template.groups.reduce((sum, { group, costs }) => {
    const base = group === 'magnitude' ? average('magnitudeBaseMin', 'magnitudeBaseMax') : get(group + 'Base');
    const plus = group === 'magnitude' ? average('magnitudePlusMin', 'magnitudePlusMax') : get(group + 'Plus');
    return sum + costs.offset + costs.a * base + costs.b * Math.trunc(plus / get(group + 'PerLevel'));
  }, 0);
}

export function installMaker(api, el, icon) {
  let offer, draft, busy = false;
  function open(event) {
    offer = event;
    draft = { name: '', element: 'magic', targetType: 'caster', icon: 0, effects: [] };
    api.openPanel('spellmaker');
  }

  api.on('location', () => { offer = null; api.refreshPanel('spellmaker'); });
  api.registerPanel('spellmaker', 'Spell Maker', (root) => {
    root.classList.add('mg-root');
    if (!offer) {
      root.replaceChildren(el('p', { class: 'mg-empty', text: 'Ask a Spell Maker at the Mages Guild or the School of Kynareth.' }));
      return;
    }
    const templates = new Map(offer.effects.map((e) => [e.key, e]));
    const money = el('output', { class: 'mg-mana', 'aria-live': 'polite' });
    const error = el('p', { class: 'mg-bad', role: 'alert', hidden: true });
    const submit = el('button', { class: 'mg-btn mg-btn-primary', type: 'submit', text: 'Buy spell' });
    const form = el('form', { class: 'mg-maker', onsubmit: async (event) => {
      event.preventDefault();
      if (busy) return;
      busy = true;
      updateCost();
      const result = await api.act('magic.make', { ...offer.counter, ...draft }, { quiet: true });
      busy = false;
      if (result?.ok) {
        offer = null;
        api.openPanel('spellbook');
      } else {
        error.textContent = result?.error || 'The Spell Maker is unavailable.';
        error.hidden = false;
        updateCost();
      }
    } });

    function updateCost() {
      const effects = draft.effects.map(({ key, settings }) => ({ school: templates.get(key).school, gold: effectPrice(templates.get(key), settings) }));
      const price = Math.trunc(effects.reduce((sum, effect) => sum + effect.gold, 0) * multiplier[draft.targetType]);
      const cost = magickaCost({ targetType: draft.targetType, effects }, statsOf(api.state)?.skills);
      money.textContent = effects.length ? `${price} gold · ${cost} magicka` : 'Choose an effect';
      submit.disabled = busy || !draft.name.trim() || !effects.length;
    }

    function choice(label, field, labels) {
      return el('label', { class: 'mg-maker-control' }, label,
        el('select', { onchange: (e) => {
          const old = draft[field];
          draft[field] = e.target.value;
          if (draft.effects.some(({ key }) => !compatible(templates.get(key), draft))) {
            draft[field] = old;
            e.target.value = old;
            error.textContent = 'Remove incompatible effects before changing delivery or element.';
            error.hidden = false;
            return;
          }
          api.refreshPanel('spellmaker');
        } }, Object.entries(labels).map(([value, text]) => el('option', { value, text, selected: draft[field] === value }))));
    }

    const name = el('label', { class: 'mg-maker-control' }, 'Spell name',
      el('input', { required: true, maxlength: 32, value: draft.name, oninput: (e) => { draft.name = e.target.value; updateCost(); } }));
    const iconChoice = el('div', { class: 'mg-maker-icon' }, icon(draft), el('label', { class: 'mg-maker-control' }, 'Icon',
      el('select', { onchange: (e) => { draft.icon = Number(e.target.value); api.refreshPanel('spellmaker'); } },
        Array.from({ length: ICON_COUNT }, (_, i) => el('option', { value: i, text: String(i + 1), selected: i === draft.icon })))));
    form.append(el('div', { class: 'mg-maker-row' }, name, choice('Target', 'targetType', TARGET_LABEL),
      choice('Element', 'element', ELEMENT_LABEL), iconChoice));

    draft.effects.forEach(({ key, settings }, index) => {
      const template = templates.get(key);
      const groups = template.groups.map(({ group, fields }) => {
        const controls = fields.map(([field, label, max]) => el('label', { class: 'mg-maker-control' }, label,
          el('input', { type: 'number', min: 1, max, required: true, value: settings[field] ?? 1, oninput: (e) => {
            const v = e.target.valueAsNumber;
            settings[field] = Number.isFinite(v) ? Math.max(1, Math.min(max, Math.trunc(v))) : 1;
            updateCost();
          } })));
        return el('fieldset', {}, el('legend', { text: group[0].toUpperCase() + group.slice(1) }), controls);
      });
      form.append(el('section', { class: 'mg-maker-effect' },
        el('header', {}, el('strong', { text: template.name }), el('span', { class: 'mg-school', text: template.school }),
          el('button', { class: 'mg-btn mg-btn-quiet', type: 'button', 'aria-label': `Remove ${template.name}`, text: 'Remove',
            onclick: () => { draft.effects.splice(index, 1); api.refreshPanel('spellmaker'); } })),
        groups));
    });

    if (draft.effects.length < 3) {
      const available = offer.effects.filter((e) => compatible(e, draft) && !draft.effects.some(({ key }) => key === e.key))
        .sort((a, b) => a.name.localeCompare(b.name));
      form.append(el('label', { class: 'mg-maker-control' }, 'Add an effect',
        el('select', { onchange: (e) => {
          if (!e.target.value) return;
          draft.effects.push({ key: e.target.value, settings: {} });
          api.refreshPanel('spellmaker');
        } }, el('option', { value: '', text: 'Choose an effect' }), available.map((e) => el('option', { value: e.key, text: e.name })))));
    }
    form.append(error, el('div', { class: 'mg-maker-buy' }, money, submit));
    root.replaceChildren(form);
    updateCost();
  }, { watch: 'none' });
  return open;
}
