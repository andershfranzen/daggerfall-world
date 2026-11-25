// Health panel (server: server/rpg/conditions.js). Shows the classic health report, the attribute
// damage conditions are doing, a vampire's clan and hunger or a lycanthrope's form, and the two moons.
// Diseases still incubating are never named here: the player learns of them at the first symptoms
// or from a temple healer. Condition messages themselves are shown by the shell from `event.text`.

import { dateFromMinutes, formatDate } from './atmosphere/calendar.js';
import { moonsOf, isFullMoon, PHASE_LABEL } from './conditions/rules.js';

const PANEL = 'health';

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};

const STYLE = `
.health-panel{display:grid;gap:12px;max-width:560px}
.health-panel .report{white-space:pre-line;margin:0;padding:10px 12px;border:1px solid var(--line,#3a4654);background:rgba(10,16,24,.55)}
.health-panel ul{margin:0;padding-left:18px}
.health-panel .loss{color:#e0a59a}
.health-panel .gain{color:#9fd4b0}
.health-panel .moons{display:flex;gap:16px;flex-wrap:wrap}
.health-panel .moon b{display:block;font-size:.8em;opacity:.7;font-weight:normal}
.health-panel .row{display:flex;gap:8px;flex-wrap:wrap}
`;

/** Pure view model from the merged RPG state and the last status event. Exported for tests. */
export function healthView(state, status, worldMinutes) {
  const rpg = state?.character ?? null;
  const st = status ?? null;
  const date = Number.isFinite(worldMinutes) ? dateFromMinutes(worldMinutes) : null;
  const moons = date ? moonsOf(date) : null;
  const effects = {};
  for (const d of st?.diseases ?? []) for (const [a, v] of Object.entries(d.loss ?? {})) effects[a] = (effects[a] ?? 0) - v;
  for (const p of st?.poisons ?? []) for (const [a, v] of Object.entries(p.mods ?? {})) effects[a] = (effects[a] ?? 0) + v;
  return {
    ready: !!rpg?.character,
    diseases: (st?.diseases ?? []).filter((d) => !d.incubating),
    poisons: st?.poisons ?? [],
    vampire: st?.vampire ?? null,
    lycanthrope: st?.lycanthrope ?? null,
    effects,
    date: Number.isFinite(st?.time) ? formatDate(dateFromMinutes(st.time)) : date ? formatDate(date) : null,
    moons: moons ? { masser: PHASE_LABEL[moons.masser], secunda: PHASE_LABEL[moons.secunda], full: isFullMoon(date) } : null,
  };
}

export function install(api) {
  const S = { status: null, report: null, minutes: null, at: 0 };
  if (globalThis.document && !document.getElementById('health-style')) {
    document.head.append(el('style', { id: 'health-style', text: STYLE }));
  }

  const ask = () => api.act('conditions.status', { quiet: true });
  function render(root) {
    root.replaceChildren();
    const v = healthView(api.state, S.status, S.minutes);
    const wrap = el('section', { class: 'health-panel', 'data-health': '' });
    if (!v.ready) {
      wrap.append(el('p', { text: 'Create your character to see your health.' }));
      root.append(wrap);
      return;
    }
    wrap.append(el('p', { class: 'report', 'data-health-report': '', text: S.report ?? 'Examining yourself…' }));
    if (v.diseases.length) {
      wrap.append(el('h3', { text: 'Diseases' }), el('p', { class: 'hint', text: 'A temple healer can cure diseases for a donation.' }), el('ul', {}, v.diseases.map((d) => el('li', { 'data-disease': d.key }, d.name, d.daysLeft != null ? ` (${d.daysLeft} days to recover)` : ''))));
    }
    if (v.poisons.length) {
      wrap.append(el('h3', { text: 'Poisons' }), el('ul', {}, v.poisons.map((p) => el('li', {}, `${p.name} — ${p.state === 'waiting' ? 'not yet felt' : p.state === 'active' ? 'working' : 'spent'}`))));
    }
    const fx = Object.entries(v.effects).filter(([, n]) => n);
    if (fx.length) {
      wrap.append(el('h3', { text: 'Attributes affected' }), el('ul', {}, fx.map(([a, n]) => el('li', { class: n < 0 ? 'loss' : 'gain', 'data-attr': a }, `${a} ${n > 0 ? '+' : ''}${n}`))));
    }
    if (v.vampire) wrap.append(el('p', { 'data-vampire': '' }, `Vampire of the ${v.vampire.clan} bloodline — ${v.vampire.sated ? 'sated' : 'you hunger'}.`));
    if (v.lycanthrope) {
      wrap.append(el('p', { 'data-lycanthrope': '' }, `${v.lycanthrope.form === 'werewolf' ? 'Werewolf' : 'Wereboar'} — ${v.lycanthrope.transformed ? 'in beast form' : 'in human form'}.`));
    }
    if (v.moons) {
      wrap.append(el('div', { class: 'moons', 'data-moons': '' },
        el('span', { class: 'moon' }, el('b', { text: 'Masser' }), v.moons.masser),
        el('span', { class: 'moon' }, el('b', { text: 'Secunda' }), v.moons.secunda),
        el('span', { class: 'moon' }, el('b', { text: 'Personal date' }), v.date)));
    }
    const row = el('div', { class: 'row' });
    row.append(el('button', { type: 'button', text: 'Examine', onclick: () => api.act('conditions.status', {}) }));
    if (v.lycanthrope) row.append(el('button', { type: 'button', 'data-morph': '', text: v.lycanthrope.transformed ? 'Return to human form' : 'Shapechange', onclick: () => api.act('conditions.morph', {}) }));
    wrap.append(row);
    root.append(wrap);
  }

  api.registerPanel(PANEL, 'Health', (root) => {
    if (Date.now() - S.at > 1000) { S.at = Date.now(); ask(); }
    render(root);
  }, { watch: (st) => [st?.character?.conditions?.time >> 6, S.report, st?.entities?.length] });

  api.on('event', (ev) => {
    if (ev?.kind === 'clock' && Number.isFinite(ev.minutes)) S.minutes = ev.minutes;
    if (ev?.kind !== 'condition') return;
    if (ev.status) S.status = ev.status;
    if (ev.change === 'status') S.report = ev.text;
    else if (!['symptom', 'sunlight', 'holy'].includes(ev.change)) ask();
    if (api.panel === PANEL) api.refreshPanel?.(PANEL);
  });
  return { healthView: (s) => healthView(api.state, s ?? S.status, S.minutes) };
}
