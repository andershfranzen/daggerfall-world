// Crime and the courts in the browser (package 14). Server rules: server/rpg/law.js; docs/law.md.
//
// - Steal mode (api.activationMode === 'steal', F1 by default) routes G here:
//   a townsperson in the crosshair → law.pickpocket, nothing targeted → law.steal (pick the nearest
//   building lock outside, or look at the shelves inside a shop).
// - A watchman's halt, the court (plea, then debate or lie), the verdict and the prison count-down
//   appear in a classic bottom message box. Every button only sends intent; the server rolls.
// - The "Law" menu page lists regional legal reputation, the open charge and past verdicts, all read
//   from the character's saved `rpg.law`.

export const name = 'law';
export const PANEL_ID = 'law';

const LABEL = {
  attemptedBreakingAndEntering: 'attempted breaking and entering', trespassing: 'trespassing',
  breakingAndEntering: 'breaking and entering', assault: 'assault', murder: 'murder', criminalConspiracy: 'criminal conspiracy',
  vagrancy: 'vagrancy', pickpocketing: 'pickpocketing', theft: 'theft',
};
const STAGE = { wanted: 'Wanted', halted: 'Halted by the watch', court: 'Before the court', defence: 'Defending yourself' };

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};

/** Pure: what G does in Steal mode for a target (exported for tests). */
export function stealIntent(entity) {
  if (!entity) return { verb: 'law.steal', args: {} };
  if (entity.kind === 'npc') return { verb: 'law.pickpocket', args: { targetId: String(entity.id) } };
  return null;
}

/** Pure: rows for the Law page from a saved `rpg.law`. */
export function lawSummary(law) {
  const l = law && typeof law === 'object' ? law : {};
  const reps = Object.entries(l.rep ?? {}).map(([region, value]) => ({ region, value })).sort((a, b) => a.region.localeCompare(b.region));
  const c = l.charge ?? null;
  return {
    reps,
    charge: c ? { id: c.id, region: c.region, crime: LABEL[c.crime] ?? c.crime, stage: STAGE[c.stage] ?? c.stage } : null,
    prison: l.prison ? { left: l.prison.left, days: l.prison.days, region: l.prison.region } : null,
    banished: Object.keys(l.banished ?? {}),
    history: [...(l.history ?? [])].reverse().slice(0, 12).map((h) => ({ ...h, crime: LABEL[h.crime] ?? h.crime })),
  };
}

export function install(api) {
  if (typeof document === 'undefined') return;
  if (!document.querySelector('link[data-feature="law"]')) {
    const link = el('link', { rel: 'stylesheet', href: new URL('./law.css', import.meta.url).href });
    link.dataset.feature = 'law';
    document.head.append(link);
  }
  const box = el('div', { class: 'law-box', role: 'dialog', 'aria-live': 'polite', hidden: true });
  const chip = el('div', { class: 'law-chip', hidden: true });
  const modeTag = el('div', { class: 'law-mode', hidden: true, text: 'Steal' });
  document.body.append(box, chip, modeTag);
  let current = null; // what the box shows: {kind, ...}

  const law = () => api.state?.character?.law ?? null;
  const freeMouse = () => { if (document.pointerLockElement) document.exitPointerLock?.(); };

  function close() {
    current = null;
    box.hidden = true;
    box.replaceChildren();
  }

  function show(kind, text, buttons = [], extra = null) {
    current = { kind };
    box.replaceChildren(el('p', { class: 'law-text', text }));
    if (extra) box.append(extra);
    if (buttons.length) {
      box.append(el('div', { class: 'law-buttons' }, buttons.map(([label, fn, cls]) =>
        el('button', { type: 'button', class: cls ?? '', onclick: fn, text: label }))));
    }
    box.hidden = false;
    box.dataset.kind = kind;
    if (buttons.length) {
      freeMouse();
      box.querySelector('button')?.focus({ preventScroll: true });
    }
  }

  const send = (verb, args) => {
    const r = api.act(verb, args);
    if (r?.then) r.then((res) => { if (!res.ok) api.refreshPanel?.(PANEL_ID); });
    return r;
  };

  function choose(verb, args) {
    const dialog = current;
    const buttons = [...box.querySelectorAll('button')];
    for (const button of buttons) button.disabled = true;
    Promise.resolve(send(verb, args)).then((result) => {
      if (current !== dialog) return;
      if (result?.ok) close();
      else for (const button of buttons) button.disabled = false;
    });
  }

  function halt(ev) {
    show('halt', ev.text, [
      ['Surrender', () => choose('law.surrender', { chargeId: ev.chargeId }), 'law-primary'],
      ['Resist', () => choose('law.resist', { chargeId: ev.chargeId })],
    ]);
  }

  function court(ev) {
    const buttons = ev.choices?.includes('guilty')
      ? [['Guilty', () => choose('law.plead', { chargeId: ev.chargeId, plea: 'guilty' })],
        ['Not guilty', () => choose('law.plead', { chargeId: ev.chargeId, plea: 'notGuilty' })]]
      : [['Debate (Etiquette)', () => choose('law.defend', { chargeId: ev.chargeId, method: 'debate' })],
        ['Lie (Streetwise)', () => choose('law.defend', { chargeId: ev.chargeId, method: 'lie' })]];
    show('court', ev.text, buttons);
  }

  function shelf(ev) {
    const list = el('ul', { class: 'law-shelf' }, ev.items.map((it) => el('li', {},
      el('span', { text: it.name }), el('span', { class: 'law-dim', text: `×${it.quantity}` }),
      el('button', { type: 'button', onclick: () => send('law.shoplift', { key: it.key }), text: 'Take' }))));
    show('shelf', 'The shelves. Anything you take is not paid for.', [['Leave', close]], list);
  }

  function prison(left, days) {
    if (current?.kind !== 'prison') show('prison', '', []);
    box.querySelector('.law-text').textContent = `Prison — ${left} day${left === 1 ? '' : 's'} until freedom (of ${days}).`;
  }

  api.on('event', (ev) => {
    switch (ev?.kind) {
      case 'law.halt': halt(ev); break;
      case 'law.court': court(ev); break;
      case 'law.shelf': shelf(ev); break;
      case 'law.verdict': show('verdict', ev.text, [['Continue', close, 'law-primary']]); break;
      case 'law.prison': prison(ev.left, ev.days); break;
      case 'law.released': close(); break;
      case 'law.watch': if (String(ev.suspectId) === String(api.selfId)) api.message('The City Watch has been called!', { kind: 'error' }); break;
      case 'law':
        if (ev.text) api.message(ev.text, { kind: ev.pickpocket === 'caught' || ev.shoplift === 'caught' ? 'error' : 'info' });
        break;
      case 'law.slain': if (String(ev.playerId) !== String(api.selfId)) api.message(`${ev.name} has been killed!`); break;
      default: return;
    }
    api.refreshPanel?.(PANEL_ID);
  });

  api.on('stealIntent', (d) => {
    if (d?.handled) return;
    if (!/^(town|interior):/.test(api.location ?? '')) return;
    const it = stealIntent(d.entity);
    if (!it) return; // monsters, loot, players: the usual handlers
    d.preventDefault();
    send(it.verb, it.args);
  });

  function drawMode() {
    modeTag.hidden = api.activationMode !== 'steal' || api.screen !== 'game';
  }
  api.on('activationMode', drawMode);

  api.on('state', () => {
    const l = law();
    const c = l?.charge;
    if (current?.kind === 'halt' && c?.stage !== 'halted') close();
    if (current?.kind === 'court' && c?.stage !== 'court' && c?.stage !== 'defence') close();
    chip.hidden = !c && !l?.prison;
    chip.textContent = l?.prison ? `In prison: ${l.prison.left} days` : c ? `${STAGE[c.stage] ?? 'Wanted'} — ${LABEL[c.crime] ?? c.crime} (${c.region})` : '';
    // After a reconnect: put the open question back on screen.
    if (c?.stage === 'court' && !current) court({ chargeId: c.id, label: LABEL[c.crime], region: c.region, choices: ['guilty', 'notGuilty'], text: `You stand before the court of ${c.region}, charged with ${LABEL[c.crime] ?? c.crime}. How do you plead?` });
    else if (c?.stage === 'defence' && !current) court({ chargeId: c.id, choices: ['debate', 'lie'], text: 'How will you convince the court?' });
    if (l?.prison && current?.kind !== 'prison') prison(l.prison.left, l.prison.days);
    if (!l?.prison && current?.kind === 'prison') close();
    drawMode();
  });
  api.on('screen', () => {
    if (api.screen === 'landing') close();
    drawMode();
  });

  api.registerPanel(PANEL_ID, 'Law', (root) => {
    const s = lawSummary(law());
    root.replaceChildren(el('div', { class: 'law-page' },
      el('h3', { class: 'law-h', text: 'Standing with the law' }),
      s.reps.length
        ? el('dl', { class: 'law-reps' }, s.reps.flatMap((r) => [el('dt', { text: r.region }), el('dd', { class: r.value < 0 ? 'law-bad' : 'law-good', text: r.value > 0 ? `+${r.value}` : String(r.value) })]))
        : el('p', { class: 'law-dim', text: 'No region has an opinion of you yet.' }),
      s.banished.length ? el('p', { class: 'law-bad', text: `Banished from ${s.banished.join(', ')}.` }) : null,
      el('h3', { class: 'law-h', text: 'Open charge' }),
      s.charge ? el('p', {}, `${s.charge.crime} in ${s.charge.region} — ${s.charge.stage}.`) : el('p', { class: 'law-dim', text: 'None.' }),
      s.prison ? el('p', { class: 'law-bad', text: `Serving ${s.prison.days} days in ${s.prison.region}: ${s.prison.left} left.` }) : null,
      el('h3', { class: 'law-h', text: 'Verdicts' }),
      s.history.length
        ? el('ul', { class: 'law-history' }, s.history.map((h) => el('li', {}, `${h.crime}, ${h.region}: ${h.verdict}`,
          h.fine ? `, fined ${h.fine} gold` : '', h.days ? `, ${h.days} days in prison` : '')))
        : el('p', { class: 'law-dim', text: 'A clean record.' }),
      el('p', { class: 'law-dim law-small', text: 'Steal mode (F1): G on a person picks a pocket; G at a locked door picks the lock; G inside a shop looks at the shelves.' }),
    ));
  }, { watch: (st) => st?.character?.law ?? null });
  drawMode();
}

export default { name, install };
