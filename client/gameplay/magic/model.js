// DOM-free spellbook view model shared by the panel and the HUD. Mirrors the server's cost rules
// (server/rpg/magic/formulas.js, adapted from Daggerfall Unity, MIT) for live magicka estimates.

export const TARGET_LABEL = Object.freeze({
  caster: 'Caster', touch: 'Touch', singleAtRange: 'Target at range', areaAroundCaster: 'Area around caster', areaAtRange: 'Area at range',
});
export const ELEMENT_LABEL = Object.freeze({ fire: 'Fire', cold: 'Frost', poison: 'Poison', shock: 'Shock', magic: 'Magic' });
export const SUPPORT_LABEL = Object.freeze({
  full: 'Applied on impact', tracked: 'Lasting effect', partial: 'Partly supported', unsupported: 'Unavailable',
});
const TARGET_MULT = { caster: 1, touch: 1, singleAtRange: 1.5, areaAroundCaster: 2, areaAtRange: 2.5 };

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** `p.rpg` arrives as state.character; its stats record is state.character.character. */
export function rpgOf(state) {
  const c = state?.character;
  return isObj(c) ? c : null;
}
export function statsOf(state) {
  const c = rpgOf(state);
  return c ? (isObj(c.character) ? c.character : c) : null;
}
export function magicOf(state) {
  const m = rpgOf(state)?.magic;
  return {
    known: Array.isArray(m?.known) ? m.known.map(String) : [],
    selected: m?.selected != null ? String(m.selected) : null,
    active: Array.isArray(m?.active) ? m.active : [],
    readySpell: isObj(m?.readySpell) ? m.readySpell : null,
  };
}

/** Live magicka cost for a caster with `skills`. */
export function magickaCost(spell, skills = {}) {
  if (spell?.innate) return spell.baseCosts.magicka;
  let total = 0;
  for (const e of spell?.effects ?? []) {
    const skill = Math.max(0, Math.min(100, Number(skills?.[e.school]) || 0));
    total += Math.trunc(((e.gold ?? 0) * (110 - skill)) / 400);
  }
  return Math.max(5, Math.trunc(total * (TARGET_MULT[spell?.targetType] ?? 1)));
}

const perLevel = (n) => (n > 1 ? `per ${n} levels` : 'per level');

/** One readable line per effect setting. */
export function effectLines(e) {
  const out = [];
  if (e.key === 'MorphSelf') out.push('Shifts between human and beast form (lycanthropes only; once per day)');
  if (e.magnitude) {
    const m = e.magnitude;
    const plus = m.plusMax > 0 ? ` + ${m.plusMin === m.plusMax ? m.plusMin : `${m.plusMin}–${m.plusMax}`} ${perLevel(m.perLevel)}` : '';
    out.push(`Magnitude ${m.min === m.max ? m.min : `${m.min}–${m.max}`}${plus}`);
  }
  if (e.duration) out.push(`Duration ${e.duration.base}${e.duration.plus ? ` + ${e.duration.plus} ${perLevel(e.duration.perLevel)}` : ''} rounds`);
  if (e.chance) out.push(`Chance ${e.chance.base}%${e.chance.plus ? ` + ${e.chance.plus}% ${perLevel(e.chance.perLevel)}` : ''}`);
  return out;
}

/** Sorted rows for the known list and the learnable list. */
export function spellRows(catalogue, state, { query = '' } = {}) {
  const m = magicOf(state);
  const s = statsOf(state);
  const skills = s?.skills ?? {};
  const byId = new Map((catalogue ?? []).map((sp) => [String(sp.id), sp]));
  const q = query.trim().toLowerCase();
  const row = (sp) => ({
    ...sp, known: m.known.includes(String(sp.id)), selected: m.selected === String(sp.id),
    cost: magickaCost(sp, skills), castable: sp.support !== 'unsupported',
  });
  const match = (sp) => !q || sp.name.toLowerCase().includes(q) || sp.schools?.some((x) => x.toLowerCase().includes(q));
  const known = m.known.map((id) => byId.get(id) ?? { id, name: id, effects: [], schools: [], support: 'unsupported', missing: true }).filter(match).map(row);
  const learnable = (catalogue ?? []).filter((sp) => !m.known.includes(String(sp.id)) && match(sp)).map(row)
    .sort((a, b) => (a.castable === b.castable ? a.price - b.price || a.name.localeCompare(b.name) : a.castable ? -1 : 1));
  known.sort((a, b) => a.name.localeCompare(b.name));
  return { known, learnable };
}

/** Text for a game event this module shows, or null. `selfId` is the viewer. */
export function eventText(ev, selfId) {
  const me = String(selfId ?? '');
  const self = `player:${me}`;
  switch (ev?.kind) {
    case 'spellResult':
    case 'spellLearned':
      return null; // carry `text`, which the game shell already shows for every event
    case 'spellCast':
    case 'spellImpact':
      if (String(ev.casterId) === me) return null; // the caster gets spellResult
      if (ev.targetIds?.includes(self)) return `${ev.casterName} casts ${ev.spellName} on you.`;
      return null;
    case 'magicEffect':
      if (ev.targetId === self) return `${ev.name}: ${ev.sign < 0 ? '-' : '+'}${ev.amount} ${ev.pool}.`;
      return null;
    case 'magicExpired':
      if (ev.targetId === self) return `${ev.spellName ?? ev.name} has worn off.`;
      return null;
    default:
      return null;
  }
}
