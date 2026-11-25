// Quest text macros. Macro meanings follow Daggerfall Unity's MacroTypes / MacroHelper
// (MIT, see NOTICE.txt): _sym_ name, __sym_ town, ___sym_ place, ____sym_ region,
// =sym_ details, ==sym_ faction, %xx context macros. Unknown macros are left visible
// and counted so they can be listed in the quest report.

import { key } from './script.js';
import { symbolHash } from './qbn.js';

const pron = {
  male: { g: 'he', g1: 'he', g2: 'him', g2self: 'himself', g3: 'his' },
  female: { g: 'she', g1: 'she', g2: 'her', g2self: 'herself', g3: 'her' },
};

/** Finds a resource key by script name, falling back to the classic name hash. */
function findKey(def, inst, name) {
  const k = key(name);
  if (def.resources.has(k)) return k;
  const h = symbolHash(name);
  for (const r of def.resources.values()) if (r.hash === h) return r.key;
  return null;
}

function townOf(location, townName) {
  const m = /^[a-z]+:([^/]*)\/(.+)$/.exec(location || '');
  // interior:<Region>/<Town>/<bx>,<by>/<rec> names its town before the block address.
  return m ? { region: m[1], town: townName?.(location) || m[2].split('/')[0] } : { region: '', town: location || '' };
}

/**
 * Expands macros in `text` for `inst`. `ctx` carries {playerName, race, here (location),
 * now (world minutes), dateText(minutes)}. Returns {text, unknown:string[]}.
 */
export function expand(text, def, inst, ctx) {
  const unknown = [];
  let lastGender = 'male';
  const resource = (name) => {
    const k = findKey(def, inst, name);
    if (!k) return null;
    const r = def.resources.get(k);
    return { r, k };
  };
  const nameOf = (r, k) => {
    if (r.kind === 'person') { lastGender = inst.people[k]?.gender ?? lastGender; return inst.people[k]?.name; }
    if (r.kind === 'foe') { lastGender = inst.foes[k]?.gender ?? lastGender; return inst.foes[k]?.kind; }
    if (r.kind === 'item') return inst.items[k]?.name;
    if (r.kind === 'place') return inst.places[k] ? placeLabel(inst.places[k], ctx.townName) : null;
    if (r.kind === 'clock') return clockDays(inst.clocks[k], ctx.now);
    return null;
  };
  const out = String(text).replace(/(%[a-z][a-z0-9]*)|(={1,2})([A-Za-z0-9.]+)_|(_{1,4})([A-Za-z0-9.]+)_/g, (m, pct, eq, eqName, us, usName, at, template) => {
    if (pct) {
      const code = pct.slice(1);
      const v = contextMacro(code, { ...ctx, lastGender, inst });
      if (v === null) { unknown.push(pct); return m; }
      return v;
    }
    const name = eqName ?? usName;
    const hit = resource(name);
    if (!hit) {
      // Not a symbol (e.g. a word with underscores); keep it as written.
      return m;
    }
    const { r, k } = hit;
    // Some QRC sentences supply the article before the building macro themselves.
    const buildingText = value => /^the\s/i.test(value) && /\bthe\s+$/i.test(template.slice(0, at))
      ? value.replace(/^the\s+/i, '') : value;
    if (eq === '==') return factionOf(r, k, inst) ?? m;
    if (eq === '=' && r.kind === 'foe') { lastGender = inst.foes[k]?.gender ?? lastGender; return inst.foes[k]?.name ?? m; }
    if (eq === '=' && r.kind === 'person') { lastGender = inst.people[k]?.gender ?? lastGender; return ctx.titleOf?.(inst.people[k]) ?? 'resident'; }
    const depth = us?.length;
    if (eq === '=' || depth === 1) {
      const name = nameOf(r, k) ?? m;
      return r.kind === 'place' ? buildingText(name) : name;
    }
    // Daggerfall Unity MacroTypes: places _ building, __ town, ___ town/dungeon, ____ region;
    // people _ name, __ building they are in, ___ town, ____ region.
    let pl = null;
    if (r.kind === 'place') pl = inst.places[k];
    else if (r.kind === 'person') {
      const person = inst.people[k];
      lastGender = person?.gender ?? lastGender;
      pl = person?.place ? inst.places[person.place] : null;
      if (!pl) pl = { location: person?.location ?? person?.home ?? (person?.questor ? inst.giver?.location : null) ?? ctx.here };
    } else if (r.kind === 'foe' || r.kind === 'item') {
      const thing = r.kind === 'foe' ? inst.foes[k] : inst.items[k];
      pl = thing?.place ? inst.places[thing.place] : { location: thing?.location ?? ctx.here };
    }
    const t = townOf(pl?.location ?? ctx.here, ctx.townName);
    if (depth === 2) {
      if (r.kind !== 'person') return t.town;
      if (pl?.buildingName || pl?.building || pl?.label) return buildingText(placeLabel(pl, ctx.townName));
      // A person standing in a building (a merchant questor): that building's name.
      if (inst.giver?.buildingName && inst.giver.location === pl?.location) return buildingText(inst.giver.buildingName);
      const inside = /^interior:/.test(pl?.location ?? '') ? ctx.buildingName?.(pl.location) : null;
      return inside ? buildingText(inside) : t.town;
    }
    if (depth === 3) return t.town;
    return t.region;
  });
  // Classic text sometimes drops a symbol's closing underscore ("I am _qgiver.", "___npc1."):
  // restore it when the name resolves, then expand that macro the normal way.
  const repaired = out.replace(/(^|[^A-Za-z0-9_=])(_{1,4})([A-Za-z][A-Za-z0-9]*)(?=[.,!?;:'"\s]|$)/g, (m, pre, us, name) =>
    resource(name) ? `${pre}${us}${name}_` : m);
  const fixed = repaired === out ? out : expand(repaired, def, inst, ctx).text;
  return { text: fixed, unknown };
}

/** Building name for a place ("the tavern", "a house"); the town is a separate macro. */
function placeLabel(pl, townName) {
  if (pl.buildingName) return pl.buildingName;
  if (pl.label) return `the ${pl.label.toLowerCase()}`;
  const b = pl.building ? pl.building.replace(/\d+$/, '').replace(/([a-z])([A-Z])/g, '$1 $2') : '';
  const kinds = { generalstore: 'the general store', tavern: 'the tavern', temple: 'the temple', palace: 'the palace', library: 'the library', bank: 'the bank', armory: 'the armory', apothecary: 'the alchemist', bookstore: 'the bookstore', clothingshop: 'the clothier', jewelryshop: 'the jeweler', pawnshop: 'the pawnshop', weaponstore: 'the weaponsmith', furnitureshop: 'the furniture store', guildhall: 'the guildhall', magery: 'the Mages Guild', fighters: "the Fighters Guild", house: 'a house', shop: 'a shop', random: 'a building' };
  return b ? kinds[b] ?? b : townOf(pl.location, townName).town;
}

function clockDays(c, now) {
  if (!c) return '';
  const left = c.running && c.endAt !== null ? Math.max(0, c.endAt - now) : c.total;
  return String(Math.max(1, Math.round(left / 1440)));
}

function factionOf(r, k, inst) {
  if (r.kind === 'person' && inst.people[k]?.questor) return inst.giver?.factionName ?? null;
  return null;
}

function contextMacro(code, ctx) {
  const g = pron[ctx.lastGender] ?? pron.male;
  if (g[code]) return g[code];
  const first = String(ctx.playerName || '').split(/\s+/)[0];
  switch (code) {
    case 'pcn': return ctx.playerName || 'traveler';
    case 'pcf': return first || 'traveler';
    case 'ra': return ctx.race || 'traveler';
    case 'cn': return townOf(ctx.here, ctx.townName).town;
    case 'crn': case 'reg': return townOf(ctx.here).region;
    case 'qdt': return ctx.dateText?.(ctx.inst.startedAt) ?? '';
    case 'di': return 'nearby';
    case 'oth': return 'by the gods';
    case 't': return ctx.title ?? '';
    default: return null;
  }
}
