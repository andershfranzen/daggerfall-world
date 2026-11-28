// Server-side quest task machine. One instance per player per quest; all instance state is
// plain JSON kept in the player's `rpg.quests` so it persists with the character.
//
// Task update, trigger, rearm and `when` evaluation rules are adapted from Daggerfall Unity
// Game/Questing/Task.cs, Quest.cs, Actions/WhenTask.cs and the individual actions (MIT,
// see NOTICE.txt). World effects (spawning, gold, reputation, map reveals) go through the
// `host` object supplied by server/rpg/quests.js, so the engine stays testable.

import { parseWhen } from './actions.js';
import { key } from './script.js';
import { MSG, FOE_BY_NAME, MOBILES, PLACE_TYPES, PERMANENT_PLACES } from './tables.js';

/** Small deterministic PRNG (mulberry32) whose state lives in the instance. */
export function nextRandom(inst) {
  let t = (inst.rng = (inst.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (inst, lo, hi) => lo + Math.floor(nextRandom(inst) * (hi - lo + 1));

const DAY = 1440;

const newTaskState = (task, host) => ({
  t: task.type === 'headless' || task.type === 'persist' || (task.global !== undefined && !!host.global?.(task.global)),
  p: false,
  d: false,
  a: task.actions.map(() => ({ c: false })),
});

/** Resolves message references: numeric ids or static names ("QuestComplete"). */
export function messageId(ref) {
  if (ref === undefined || ref === null || ref === '') return 0;
  if (/^\d+$/.test(String(ref))) return Number(ref);
  const names = { questoroffer: 1000, refusequest: 1001, acceptquest: 1002, questfail: 1003, questcomplete: 1004, questlogentry: 1010 };
  return names[String(ref).toLowerCase()] ?? 0;
}

/**
 * Checks what a definition needs before it can be offered. Returns
 * {offerable, unsupported:[...], approximations:[...], ignored:[...]} — the inspectable
 * inventory shown to operators and players.
 */
export function analyseQuest(def, { artifact = null } = {}) {
  const unsupported = [];
  const approximations = [];
  const ignored = [];
  for (const p of def.problems) unsupported.push(p);
  for (const r of def.resources.values()) {
    if (r.kind === 'place') {
      if (r.scope === 'permanent') {
        if (!PERMANENT_PLACES.get(String(r.site).toLowerCase())?.location && !fixedReveal(def, r.key)) unsupported.push(`place ${r.symbol}: fixed site "${r.source}"`);
      } else if (r.scope !== 'local' && r.scope !== 'remote') unsupported.push(`place ${r.symbol}: fixed site "${r.source}"`);
      else {
        const t = r.types.map((x) => PLACE_TYPES.get(x));
        if (t.some((x) => !x)) unsupported.push(`place ${r.symbol}: unknown type ${r.types.join(',')}`);
        // Remote dungeons follow Place.SelectRemoteDungeonSite, local ones the dungeon of the giver's own town
        // (Place.SetupLocalSite); wilderness location classes do not run yet.
        else if (t.some((x) => x.p1 === 2)) unsupported.push(`place ${r.symbol}: ${r.scope} ${r.types.join(',')} (this kind of site is not available)`);
      }
    } else if (r.kind === 'foe') {
      if (!FOE_BY_NAME.has(r.foeName.toLowerCase())) unsupported.push(`foe ${r.symbol}: unknown foe type ${r.foeName}`);
    } else if (r.kind === 'person') {
      // Named people and classic -1.N/-8.N codes resolve to FACTION.TXT records at run time: individuals are the
      // source-placed person (server/rpg/npcs), other factions are a member created for the quest.
      if (r.by === 'named' || r.factionId !== undefined) { /* resolved by host.individual() */ }
      else if (r.by === 'faction' || r.by === 'factiontype' || r.by === 'faction_code') {
        approximations.push(`person ${r.symbol}: ${r.by} ${r.value} is played by a generic resident`);
      }
    } else if (r.kind === 'item') {
      // Artifacts come from the artifact owner's catalogue (services.artifactTemplate); unknown ones still block.
      if (r.className === 'artifact' && !artifact?.(r)) unsupported.push(`item ${r.symbol}: artifact rewards are not in the item catalogue`);
    }
  }
  // People and foes placed inside a random dungeon stand on its quest spawn markers (199/11, server/rpg/quests.js).
  for (const t of def.tasks) {
    for (const a of t.actions) {
      if ((a.name === 'placeFoe' || a.name === 'placeNpc') && !def.resources.has(key(a.args.person ?? a.args.foe))) unsupported.push(`${t.symbol}: ${a.source} (no such ${a.name === 'placeFoe' ? 'foe' : 'person'})`);
      if (a.status === 'unsupported') unsupported.push(`${t.symbol}: ${a.source}`);
      else if (a.status === 'approx') approximations.push(`${t.symbol}: ${a.source}`);
      else if (a.status === 'ignored') ignored.push(`${t.symbol}: ${a.source}`);
      if (a.name === 'when' && !parseWhen(a.args.expr)) unsupported.push(`${t.symbol}: unreadable condition "${a.source}"`);
    }
  }
  const dedupe = (xs) => [...new Set(xs)];
  return { offerable: unsupported.length === 0, unsupported: dedupe(unsupported), approximations: dedupe(approximations), ignored: dedupe(ignored) };
}

/**
 * A permanent site with no Quests-Places row whose own script names its MAPS record with classic 0x1b
 * ("reveal _L_ in province R at M": the Nobility coven jobs R0C30Y25, R0C4XY23, R0C60Y24). Returns {region, mapId}.
 */
export function fixedReveal(def, placeKey) {
  for (const t of def.tasks) for (const a of t.actions) if (a.name === 'revealAt' && key(a.args.place) === placeKey) return { region: a.args.region, mapId: a.args.mapId };
  return null;
}

function clockMinutes(res, inst, host, def) {
  const [a = null, b = null] = res.times || [];
  let total;
  if (a === null) total = randInt(inst, 1, 7 * DAY);
  else if (b !== null && b > a) total = randInt(inst, a, b);
  else total = a;
  // Classic flag 16 / zero-length clock types 1+: duration follows travel time to the quest's places.
  const travelBased = (res.flag & 16) === 16 || (total === 0 && (res.flag & 1) === 1 && res.rangeMax > 0);
  if (travelBased) {
    const places = [...def.resources.values()].filter((r) => r.kind === 'place');
    // A special-quest correction may pin one clock to the first place (U0C00Y00 `_S.07_`, special/quests.js).
    total = travelClockMinutes(res.firstPlaceClock ? places.slice(0, 1) : places, inst, host);
  }
  return Math.max(1, total);
}

/** Clock.cs returnTripMultiplier, applied once to the combined time. */
export const RETURN_TRIP_MULTIPLIER = 2.5;

/**
 * Clock.GetTravelTimeInSeconds() (Daggerfall Unity 3d85a28): every Place resource of the quest adds its own one-way
 * cautious travel time with at least one day (1440 minutes) each, and the sum is multiplied by 2.5 once. A place whose
 * site could not be bound (no location) adds nothing, as Clock.cs adds 0 when ContentReader.GetLocation fails. When no
 * place binds at all, the clock gets three days instead of the classic zero-length timer that would end the job at once.
 */
export function travelClockMinutes(places, inst, host) {
  let sum = 0;
  let bound = 0;
  for (const r of places) {
    const location = inst.places[r.key]?.location;
    if (!location) continue;
    bound++;
    const leg = Number(host.travelMinutes?.(location));
    sum += Math.max(DAY, Number.isFinite(leg) ? Math.trunc(leg) : 0);
  }
  return bound ? Math.trunc(sum * RETURN_TRIP_MULTIPLIER) : 3 * DAY;
}

/**
 * Person.cs / Place.AssignQuestResource: a quest person who is not the questor or an authored individual lives in a
 * building of their home town and stands there until a task places them elsewhere. Also repairs older saves.
 */
export function assignHome(inst, k) {
  const p = inst.people[k];
  if (!p || p.questor || p.individual !== undefined || p.destroyed || p.location || p.place || !p.home) return false;
  const hk = `home.${k}`;
  // Home sites use the exterior town even when the giver stood indoors (bindPlaces moves them out too).
  inst.places[hk] ??= { location: p.home, building: p.homeBuilding ?? 'public', scope: p.remote ? 'remote' : 'local', home: true };
  p.location = inst.places[hk].location;
  p.place = hk;
  p.atHome = true;
  return true;
}

/**
 * Creates a new instance. `giver` is the NPC entity offering the quest (the questor).
 * Random outcomes (names, amounts, clock lengths, remote towns) are rolled here, on the server.
 */
export function createInstance(def, { uid, seed, giver, host, now, source }) {
  const inst = {
    uid,
    name: def.name,
    // Classic quests have no titles; scripts may supply one (DisplayName).
    title: def.displayName || (giver?.name ? `Work for ${giver.name}` : `Quest ${def.name}`),
    status: 'active',
    success: false,
    startedAt: now,
    giver: giver ? {
      id: giver.id, name: giver.name, location: giver.location, faction: giver.faction ?? null,
      ...(giver.factionName ? { factionName: giver.factionName } : {}),
      ...(giver.building?.name ? { buildingName: giver.building.name } : {}),
    } : null,
    rng: seed >>> 0,
    tasks: {},
    clocks: {},
    people: {},
    places: {},
    foes: {},
    items: {},
    log: [],
    prompt: null,
    granted: [],
    notes: [], // unsupported lines reached at run time
    ...(source ? { special: source } : {}),
  };
  for (const r of def.resources.values()) {
    if (r.kind !== 'place') continue;
    if (r.scope === 'permanent') {
      // Fixed story site: its exterior and (for a dungeon) the instance itself. Never bound to a random building.
      const site = PERMANENT_PLACES.get(String(r.site).toLowerCase());
      const fixed = !site?.location ? fixedReveal(def, r.key) : null;
      if (fixed) {
        // Bound now (not yet revealed on the map): its own reveal line names the MAPS record.
        const hit = host.fixedSite?.(fixed.region, fixed.mapId) ?? null;
        inst.places[r.key] = { location: hit?.location ?? null, interior: hit?.interior ?? null, site: hit?.name ?? r.site, scope: 'permanent', noBuilding: true, fixed };
        continue;
      }
      const loc = site?.location ?? null;
      const dungeon = loc?.startsWith('dungeon:') ? loc : null;
      inst.places[r.key] = { location: dungeon ? `town:${loc.slice(8)}` : loc, interior: dungeon, site: site?.name ?? r.site, scope: 'permanent', noBuilding: true };
      continue;
    }
    if (PLACE_TYPES.get(r.types[0])?.p1 === 1) {
      // Remote dungeon (Place.SelectRemoteDungeonSite): a dungeon of the player's region; local: the dungeon of the
      // giver's own town (null when it has none, and the quest is not offered there). Markers bind later.
      const d = (r.scope === 'local' ? host.localDungeon?.(inst, giver) : host.remoteDungeon?.(inst, r)) ?? null;
      inst.places[r.key] = { location: d?.location ?? null, interior: d?.interior ?? null, dungeon: true, building: null, scope: r.scope, noBuilding: true, ...(r.scope === 'local' ? { local: true } : {}) };
      continue;
    }
    const town = r.scope === 'local' ? giver?.location ?? host.location() : host.remoteTown(inst, r);
    inst.places[r.key] = { location: town, building: r.types[nextRandom(inst) * r.types.length | 0] ?? null, scope: r.scope };
  }
  for (const r of def.resources.values()) {
    if (r.kind === 'person') {
      const ind = !r.questor ? host.individual?.(r) ?? null : null;
      if (r.questor && giver) {
        inst.people[r.key] = { name: giver.name, questor: true, entityId: giver.id, location: giver.location, gender: giver.gender ?? 'male' };
      } else if (ind) {
        // A FACTION.TXT individual (King Gothryd, Nulfaga, ...): the authored person is the one to meet. A stand-in
        // is only spawned when a task places them somewhere else.
        inst.people[r.key] = {
          name: ind.name, gender: ind.gender ?? 'male', individual: ind.factionId, faction: ind.factionId, sprite: ind.sprite ?? null,
          remote: !!r.remote, location: null, home: null, hidden: false, destroyed: false,
        };
      } else {
        const gender = r.gender ?? (nextRandom(inst) < 0.5 ? 'male' : 'female');
        inst.people[r.key] = {
          name: r.by === 'named' ? String(r.value).replace(/_/g, ' ') : host.makeName(inst, gender),
          gender, remote: !!r.remote, location: null,
          home: r.remote ? host.remoteTown(inst, r.homeBuilding ? { types: [r.homeBuilding] } : null) : giver?.location ?? host.location(),
          ...(r.homeBuilding ? { homeBuilding: r.homeBuilding } : {}),
          hidden: false, destroyed: false,
          faction: host.factionFor?.(r, inst) ?? (r.factionId ?? giver?.faction ?? null),
        };
        assignHome(inst, r.key);
      }
    } else if (r.kind === 'foe') {
      const mobile = FOE_BY_NAME.get(r.foeName.toLowerCase());
      const kind = MOBILES[mobile]?.[0] ?? r.foeName.replace(/_/g, ' ');
      const gender = nextRandom(inst) < 0.5 ? 'male' : 'female';
      inst.foes[r.key] = {
        mobile, kind, count: r.count, kills: 0, injured: false, spawned: 0, location: null, removed: false,
        gender, name: mobile >= 128 ? host.makeName(inst, gender) : kind, restrained: false, holds: [],
      };
    } else if (r.kind === 'item') {
      const it = { className: r.className, held: false, location: null, holder: null, name: r.label ?? host.itemName(r) };
      if (r.className === 'gold') {
        it.gold = r.range ? randInt(inst, r.range[0], r.range[1]) : host.rewardGold(inst);
        it.name = String(it.gold); // _reward_ expands to the amount, as in the classic text ("300 gold")
      } else {
        // A template key, or {template, appearance} for rolled items (magic items, books); kept for the quest's life.
        const id = host.itemTemplate?.(r, inst) ?? null;
        it.template = (typeof id === 'string' ? id : id?.template) ?? null;
        if (id?.appearance) it.appearance = id.appearance;
      }
      if (r.usedMessage) it.usedMessage = r.usedMessage;
      inst.items[r.key] = it;
    }
  }
  for (const r of def.resources.values()) {
    if (r.kind === 'clock') inst.clocks[r.key] = { total: clockMinutes(r, inst, host, def), endAt: null, running: false, done: false };
  }
  for (const t of def.tasks) {
    inst.tasks[key(t.symbol)] = newTaskState(t, host);
  }
  return inst;
}

// ------------------------------------------------------------------------------------------

/** Runs the engine for one instance. `host` provides world effects; `now` is world minutes. */
export function updateQuest(def, inst, host, now) {
  if (inst.status !== 'active') return false;
  const run = { def, inst, host, now, brk: false, rearm: new Set(), changed: false, globals: globalLinks(def) };
  // Quest.EndQuest sets ticksToEnd = 2: the update after `end quest` still runs every task (so a task started just
  // before it, such as K0C00Y07's `have _gem_ set _S.20_` -> `make _gem_ permanent`, executes); the next one ends it.
  if (inst.endTicks > 0 && --inst.endTicks === 0) {
    delete inst.endTicks;
    host.end(inst, inst.success ? 'success' : 'failed');
    return true;
  }
  // An older saved instance may predate a corrected QBN task.
  for (const task of def.tasks) inst.tasks[key(task.symbol)] ??= newTaskState(task, host);
  // Global-linked tasks read the player's global variable (Task.GetTriggerValue).
  for (const [k, g] of run.globals) {
    const ts = inst.tasks[k];
    if (ts && host.global) ts.t = !!host.global(g);
  }
  // Clocks first (Quest.Update ticks resources before tasks).
  for (const [k, c] of Object.entries(inst.clocks)) {
    if (c.running && c.endAt !== null && now >= c.endAt) {
      c.running = false;
      c.done = true;
      startTask(run, k);
    }
  }
  for (const t of def.tasks) {
    const ts = inst.tasks[key(t.symbol)];
    if (!ts || ts.d) continue;
    if (run.brk || inst.status !== 'active') break;
    updateTask(run, t, ts);
    for (const pk of run.rearm) if (inst.people[pk]) inst.people[pk].clicked = false;
    run.rearm.clear();
  }
  // Clicks that no task consumed do not linger.
  for (const p of Object.values(inst.people)) p.clicked = false;
  for (const it of Object.values(inst.items)) it.clicked = false;
  if (inst.status === 'active' && !inst.endTicks && !inst.prompt && Array.isArray(inst.promptQueue) && inst.promptQueue.length) {
    inst.prompt = inst.promptQueue.shift();
    if (!inst.promptQueue.length) delete inst.promptQueue;
    host.prompt(inst, inst.prompt.id);
  }
  return true;
}

const linkCache = new WeakMap();
function globalLinks(def) {
  let m = linkCache.get(def);
  if (!m) {
    m = new Map(def.tasks.filter((t) => t.global !== undefined).map((t) => [key(t.symbol), t.global]));
    linkCache.set(def, m);
  }
  return m;
}

function setTrigger(run, ts, value, t) {
  if (ts.d) {
    ts.t = false;
    return;
  }
  ts.t = !!value;
  // Task.SetTriggerValue writes a linked global variable too.
  const sym = t ? key(t.symbol) : [...Object.entries(run.inst.tasks)].find(([, v]) => v === ts)?.[0];
  const g = sym !== undefined ? run.globals?.get(sym) : undefined;
  if (g !== undefined && run.host.global?.(g) !== ts.t) run.host.setGlobal?.(g, ts.t);
  if (!value) {
    // Clearing a task rearms its actions (ActionTemplate.RearmAction).
    t?.actions.forEach((a, i) => {
      if (ts.a[i]?.c && a.rearm) ts.a[i] = { c: false };
    });
  }
}

function taskDef(run, sym) {
  return run.def.tasks.find((t) => key(t.symbol) === key(sym)) ?? null;
}

function startTask(run, sym) {
  const ts = run.inst.tasks[key(sym)];
  if (ts) setTrigger(run, ts, true);
}
function clearTask(run, sym) {
  const ts = run.inst.tasks[key(sym)];
  if (ts) setTrigger(run, ts, false, taskDef(run, sym));
}
const isSet = (run, sym) => {
  const k = key(sym);
  if (run.inst.tasks[k]) return !!run.inst.tasks[k].t;
  const c = run.inst.clocks[k];
  return c ? !!c.done : false;
};

function updateTask(run, t, ts) {
  // A prompt can explicitly choose a task that also has an automatic trigger (e.g. $CUREVAM).
  // Run the chosen branch once before its automatic trigger is checked again.
  const chosen = ts.chosen === true;
  if (chosen) delete ts.chosen;
  let ranPrimary = false;
  for (let i = 0; i < t.actions.length; i++) {
    const a = t.actions[i];
    const st = (ts.a[i] ??= { c: false });
    if (st.c) continue;
    if (!chosen && ((a.kind === 'trigger' && !ts.t) || a.always)) {
      if (a.always && !ranPrimary) {
        setTrigger(run, ts, check(run, a, st, ts), t);
        ranPrimary = true;
      } else if (a.always) {
        if (check(run, a, st, ts)) setTrigger(run, ts, true, t);
      } else {
        setTrigger(run, ts, check(run, a, st, ts), t);
      }
    }
    if (ts.t && a.kind !== 'trigger') {
      if (!ts.p) st.init = true;
      perform(run, a, st, t);
      run.changed = true;
      if (run.brk) return;
    }
  }
  if (t.type === 'persist') {
    if (isSet(run, t.target)) setTrigger(run, ts, false, t);
    else t.actions.forEach((a, i) => { if (ts.a[i].c && a.rearm) ts.a[i] = { c: false }; });
  }
  ts.p = ts.t;
}

function evalWhen(run, expr) {
  const evals = parseWhen(expr);
  if (!evals) return false;
  // Port of WhenTask.CheckEvals (left-to-right and/or with short-circuit on a following or).
  let left = false, right = false;
  for (let i = 0; i < evals.length; i++) {
    const e = evals[i];
    right = e.not ? !isSet(run, e.task) : isSet(run, e.task);
    if (e.op === 'when') {
      if (evals.length === 1 && !right) return false;
    } else if (e.op === 'and') {
      if (!left || !right) {
        if (i < evals.length - 1) right = false;
        else return false;
      } else right = true;
      if (right && i < evals.length - 1 && evals[i + 1].op === 'or') return true;
    } else {
      if (!left && !right) {
        if (i < evals.length - 1) right = false;
        else return false;
      } else right = true;
    }
    left = right;
  }
  return true;
}

function compareOp(v, op, amount) {
  switch (op) {
    case '<=': return v <= amount;
    case '<': return v < amount;
    case '>': return v > amount;
    default: return v >= amount;
  }
}

function say(run, ref) {
  const id = messageId(ref);
  if (id) run.host.message(run.inst, id);
}

function check(run, a, st, ts) {
  const { inst } = run;
  const g = a.args;
  switch (a.name) {
    case 'when':
      return evalWhen(run, g.expr);
    case 'clickedNpc': {
      if (ts.t) return true;
      const p = inst.people[key(g.person)];
      if (!p?.clicked) return false;
      say(run, g.say);
      run.rearm.add(key(g.person));
      return true;
    }
    case 'clickedNpcGold': {
      const p = inst.people[key(g.person)];
      if (!p?.clicked) return false;
      run.rearm.add(key(g.person));
      if (run.host.takeGold(inst, g.gold)) return true;
      startTask(run, g.otherwise);
      return false;
    }
    case 'clickedIndividual': {
      if (ts.t) return true;
      const clicks = inst.individualClicks ?? [];
      if (!clicks.includes(g.faction)) return false;
      inst.individualClicks = clicks.filter((f) => f !== g.faction);
      return true;
    }
    case 'clickedItem': {
      if (ts.t) return true;
      const it = inst.items[key(g.item)];
      if (!it?.clicked) return false;
      it.clicked = false;
      say(run, g.say);
      return true;
    }
    case 'toting': {
      if (ts.t) return true;
      const p = inst.people[key(g.person)];
      const it = inst.items[key(g.item)];
      if (!p?.clicked || !it) return false;
      if (!run.host.hasItem(inst, key(g.item))) return false;
      run.rearm.add(key(g.person));
      say(run, g.say);
      run.host.releaseItem(inst, key(g.item)); // handed over to the person
      return true;
    }
    case 'killed': {
      const f = inst.foes[key(g.foe)];
      if (!f || f.kills < g.count) return false;
      if (!st.said) { say(run, g.say); st.said = true; }
      return true;
    }
    case 'injured': {
      const f = inst.foes[key(g.foe)];
      if (!f?.injured) return false;
      if (!st.said) { say(run, g.say); st.said = true; }
      return true;
    }
    case 'whenSkill': {
      const v = run.host.skillValue?.(inst, g.skill) ?? null;
      return v !== null && compareOp(v, g.op ?? '>=', g.amount);
    }
    case 'whenRepute': {
      const v = run.host.factionRepute?.(inst, g.faction ?? key(g.person)) ?? null;
      return v !== null && compareOp(v, g.op ?? '>=', g.amount);
    }
    case 'whenAvailable': {
      const p = inst.people[key(g.person)];
      return !!p && !p.destroyed && !p.hidden && (!p.location || p.atHome === true);
    }
    case 'levelCompleted':
      return (run.host.level?.() ?? 0) >= g.level;
    case 'dropped': {
      if (ts.t) return true;
      const it = inst.items[key(g.item)];
      if (!it || it.droppedAt !== key(g.place)) return false;
      if (!st.said) { say(run, g.say); st.said = true; }
      return true;
    }
    case 'dailyFrom': {
      const m = ((run.now % DAY) + DAY) % DAY;
      return g.from <= g.to ? m >= g.from && m < g.to : m >= g.from || m < g.to;
    }
    default:
      note(run, a);
      return false;
  }
}

function note(run, a) {
  const n = run.inst.notes;
  if (!n.includes(a.source) && n.length < 20) n.push(a.source);
}

function perform(run, a, st, t) {
  const { inst, host } = run;
  const g = a.args;
  const done = () => { st.c = true; };
  switch (a.name) {
    case 'say': say(run, g.id); return done();
    case 'log': {
      inst.log = inst.log.filter((e) => e.step !== g.step);
      inst.log.push({ step: g.step, id: g.id, text: host.text(inst, g.id) ?? '', at: run.now });
      inst.log.sort((x, y) => x.step - y.step);
      host.logged?.(inst, g.step);
      return done();
    }
    case 'removeLog':
      inst.log = inst.log.filter((e) => e.step !== g.step);
      return done();
    case 'prompt': {
      const id = messageId(g.id);
      const next = { id, yes: g.yes, no: g.no };
      if (inst.prompt) {
        if (inst.prompt.id !== id && !(inst.promptQueue ?? []).some((q) => q.id === id)) {
          (inst.promptQueue ??= []).push(next);
        }
      } else {
        inst.prompt = next;
        host.prompt(inst, id);
      }
      return done();
    }
    case 'givePcNothing':
      inst.success = true;
      host.message(inst, MSG.COMPLETE);
      return done();
    case 'givePc': {
      const k = key(g.item);
      if (g.notify) {
        host.grant(inst, k, `${key(t.symbol)}:${a.source}`);
        say(run, g.notify);
      } else if (g.silently) {
        host.grant(inst, k, `${key(t.symbol)}:${a.source}`);
      } else {
        inst.success = true;
        host.message(inst, MSG.COMPLETE);
        host.grant(inst, k, `${key(t.symbol)}:${a.source}`);
      }
      return done();
    }
    case 'getItem':
      // The player carries it for the quest (deliveries, evidence); `give pc` is what pays out.
      host.grant(inst, key(g.item), `${key(t.symbol)}:${a.source}:${inst.log.length}`, { carry: true });
      say(run, g.say);
      return done();
    case 'takeItem':
      host.releaseItem(inst, key(g.item));
      say(run, g.say);
      return done();
    case 'giveItemTo': {
      const k = key(g.item);
      const it = inst.items[k];
      const f = inst.foes[key(g.target)];
      if (it && f) {
        if (it.holder && it.holder !== key(g.target)) {
          const prior = inst.foes[it.holder];
          if (prior) prior.holds = prior.holds.filter((item) => item !== k);
        }
        // GiveItem.cs: the foe receives the item and, if the player is holding it, it leaves their inventory.
        if (it.held || it.given) host.reclaimItem?.(inst, k);
        it.holder = key(g.target);
        it.held = false;
        it.given = false;
        it.location = null;
        if (!f.holds.includes(k)) f.holds.push(k);
      }
      return done();
    }
    case 'endQuest':
      say(run, g.say);
      run.brk = true;
      done();
      if (!(inst.endTicks > 0)) inst.endTicks = 2;
      return undefined;
    case 'startTimer': {
      const c = inst.clocks[key(g.clock)];
      if (c && !c.running) {
        c.running = true;
        c.done = false;
        c.endAt = run.now + c.total;
      }
      return done();
    }
    case 'stopTimer': {
      const c = inst.clocks[key(g.clock)];
      if (c) c.running = false;
      return done();
    }
    case 'startTask': startTask(run, g.task); return done();
    case 'clear':
      done();
      for (const s of g.tasks) clearTask(run, s);
      return undefined;
    case 'unset':
      done();
      for (const s of g.tasks) {
        const ts = inst.tasks[key(s)];
        if (ts) { ts.d = true; ts.t = false; }
      }
      return undefined;
    case 'pickOne': {
      const pick = g.tasks[Math.floor(nextRandom(inst) * g.tasks.length)];
      startTask(run, pick);
      return done();
    }
    case 'placeNpc': {
      const p = inst.people[key(g.person)];
      const place = key(g.place);
      const pl = inst.places[place];
      if (p && pl) {
        if (p.place !== place || (g.marker != null && p.marker !== g.marker)) delete p.spawnAt;
        p.location = pl.location;
        p.place = place;
        p.marker = g.marker ?? null;
        if (p.questor) p.moved = true; // the giver in town no longer stands in for this person
        if (p.individual !== undefined) host.individualAway?.(inst, p.individual, true);
      }
      host.placed(inst);
      return done();
    }
    case 'createNpc': {
      const p = inst.people[key(g.person)];
      if (p && !p.location) p.location = p.home ?? host.location();
      host.placed(inst);
      return done();
    }
    case 'placeFoe': {
      const f = inst.foes[key(g.foe)];
      const place = key(g.place);
      const pl = inst.places[place];
      if (f && pl) {
        if (f.place !== place || (g.marker != null && f.marker !== g.marker)) delete f.spawnAt;
        delete f.ambushAt;
        f.location = pl.location;
        f.place = place;
        f.marker = g.marker ?? null;
        f.removed = false;
      }
      host.placed(inst);
      return done();
    }
    case 'placeItem': {
      const it = inst.items[key(g.item)];
      const pl = inst.places[key(g.place)];
      if (it && pl && !it.held) {
        it.location = pl.location; it.place = key(g.place); it.marker = g.marker ?? null; it.markerAt = null;
        it.handedOver = false;
      }
      host.placed(inst);
      return done();
    }
    case 'hideNpc':
    case 'restoreNpc':
    case 'destroyNpc': {
      const p = inst.people[key(g.person)];
      if (p) {
        if (a.name === 'hideNpc') p.hidden = true;
        else if (a.name === 'restoreNpc') p.hidden = false;
        else p.destroyed = true;
      }
      host.placed(inst);
      return done();
    }
    case 'removeFoe': {
      const f = inst.foes[key(g.foe)];
      if (f) f.removed = true;
      host.placed(inst);
      return done();
    }
    case 'createFoe': {
      const f = inst.foes[key(g.foe)];
      if (!f) return done();
      if (st.count === undefined || st.init) {
        st.count = 0;
        st.last = run.now - Math.floor(nextRandom(inst) * g.minutes);
        st.init = false;
      }
      if (g.times !== -1 && st.count >= g.times) return undefined;
      // CreateFoe.TryPlacement: the `send` variant deploys only while the player is within a location's rect (a town
      // or site, indoors or out — PlayerGPS.IsPlayerInLocationRect), never in open wilderness; `create foe` deploys
      // anywhere. A successful roll stays pending until it can be placed, and no new spawn event is rolled meanwhile
      // (spawnInProgress). The counter advances once the spawn has been placed.
      const deploy = () => {
        st.pending = false;
        st.count++;
        f.location = host.location();
        f.place = null;
        delete f.spawnAt;
        f.ambushAt = host.ambushPosition?.();
        f.removed = false;
        f.ambush = (f.ambush || 0) + 1;
        if (g.msg) say(run, g.msg);
        host.placed(inst);
      };
      const canPlace = () => !g.send || host.inTown(); // inTown: the location's exterior is a MAPS location (town or site)
      if (st.pending) {
        if (canPlace()) deploy();
        return undefined;
      }
      if (run.now >= st.last + g.minutes) {
        st.last = run.now;
        if (nextRandom(inst) * 100 < g.chance) {
          if (canPlace()) deploy();
          else st.pending = true;
        }
      }
      return undefined;
    }
    case 'restrainFoe':
    case 'unrestrainFoe': {
      const f = inst.foes[key(g.foe)];
      if (f) f.restrained = g.restrained;
      host.placed(inst);
      return done();
    }
    case 'changeRepute':
      host.adjustReputation(inst, key(g.person), g.amount);
      return done();
    case 'reputeExceeds':
      if (host.reputation(inst, key(g.person)) > g.amount) startTask(run, g.task);
      return undefined;
    case 'reveal':
      host.reveal(inst, key(g.place));
      return done();
    case 'itemUsedDo': {
      const it = inst.items[key(g.item)];
      if (it) { it.useTask = g.task; if (g.say) it.useSay = messageId(g.say); }
      return done();
    }
    case 'haveItem':
      if (host.hasItem(inst, key(g.item), { ownership: true })) startTask(run, g.task);
      return undefined;
    case 'makePermanent':
      host.permanentItem?.(inst, key(g.item));
      return done();
    case 'revealAt':
      host.revealAt?.(inst, key(g.place), g.region, g.mapId);
      return done();
    case 'npcAtHome': {
      const p = inst.people[key(g.person)];
      if (p) {
        p.atHome = true;
        if (p.individual !== undefined) {
          if (p.location) host.individualAway?.(inst, p.individual, false);
          p.location = null; // the authored record is the person to meet
        } else if (!p.questor) p.location = p.home ?? host.location();
        delete p.place;
        delete p.spawnAt;
      }
      host.placed(inst);
      return done();
    }
    case 'legalRepute':
      host.legalRepute?.(inst, g.amount);
      return done();
    case 'castOnFoe': {
      const f = inst.foes[key(g.foe)];
      if (f) {
        f.spells = [...new Set([...(f.spells ?? []), g.spell])];
        host.castOnFoe?.(inst, key(g.foe), g.spell);
      }
      return done();
    }
    case 'makeIll':
      host.condition?.(inst, 'infect', { disease: g.disease });
      say(run, g.say);
      return done();
    case 'cure':
      host.condition?.(inst, 'cure', g.condition === 'disease' ? { disease: g.disease } : { condition: g.condition });
      return done();
    case 'castSpellDo': {
      // Each cast of that spell (recorded by the host from the magic feature) starts the task once.
      const casts = inst.casts ?? [];
      if (casts.includes(g.spell)) {
        inst.casts = casts.filter((x) => x !== g.spell);
        startTask(run, g.task);
      }
      return undefined;
    }
    case 'startQuest':
      host.startQuest?.(inst, g.quest);
      return done();
    case 'playVideo':
      host.video?.(inst, g.video);
      return done();
    case 'transferPc': {
      // Completes only once the player has actually been moved (or already stands in that instance).
      const pl = inst.places[key(g.place)];
      if (pl && host.transfer?.(inst, pl, g.marker)) return done();
      note(run, a);
      return undefined;
    }
    case 'teleportPc': {
      // Completes once the player stands inside the place (moved now, or the dungeon was still loading: retried).
      const pl = inst.places[key(g.place)];
      if (pl && host.teleport?.(inst, pl, g.marker)) return done();
      return undefined;
    }
    case 'addFace':
    case 'dropFace':
    case 'addFoeFace': {
      // EscortingNPCFacePanel: one face per quest resource; dropped faces leave, and all go when the quest ends.
      const k = key(g.person ?? g.foe);
      const kind = g.person ? 'person' : 'foe';
      const res = kind === 'person' ? inst.people[k] : inst.foes[k];
      const faces = (inst.faces ??= []);
      const has = faces.findIndex((f) => f[kind] === k);
      if (a.name === 'dropFace' || g.add === false) {
        if (has >= 0) faces.splice(has, 1);
      } else if (res && has < 0) {
        faces.push({ [kind]: k, name: res.name ?? res.kind ?? k, ...(res.gender ? { gender: res.gender } : {}) });
        say(run, g.say);
      }
      host.placed(inst);
      return done();
    }
    case 'playSound': {
      // PlaySound: plays when the task fires, then every N minutes until M plays. The schedule lives in the task's
      // action state (st), so it survives a save or restart and stops with the task or the quest.
      const times = Math.max(1, g.times);
      st.played ??= 0;
      if (st.played === 0 || (g.minutes > 0 && run.now >= st.next)) {
        st.played++;
        st.next = run.now + g.minutes;
        host.sound?.(inst, { sound: g.sound });
      }
      if (st.played >= times) {
        delete st.played;
        delete st.next;
        return done();
      }
      return undefined;
    }
    case 'playSong':
      host.sound?.(inst, { song: g.song });
      return done();
    case 'addDialog':
    case 'dialogLink': {
      const refs = g.refs.map((r) => ({ kind: r.kind, key: key(r.symbol) }));
      if (a.name === 'addDialog') {
        const topics = (inst.dialog ??= []);
        for (const r of refs) if (!topics.some((x) => x.kind === r.kind && x.key === r.key)) topics.push(r);
      } else if (refs.length > 1) {
        const links = (inst.dialogLinks ??= []);
        const sig = JSON.stringify(refs);
        if (!links.some((l) => JSON.stringify(l) === sig)) links.push(refs);
      }
      return done();
    }
    case 'rumorMill': {
      const id = messageId(g.id);
      const rumours = (inst.rumours ??= []);
      // Text resolved once (like log entries), so reading rumours later never advances the instance's PRNG.
      if (id && !rumours.some((r) => r.id === id)) rumours.push({ id, text: host.text(inst, id) ?? '' });
      return done();
    }
    case 'muteNpc': {
      const p = inst.people[key(g.person)];
      if (p) p.muted = true;
      return done();
    }
    case 'addQuestor':
    case 'dropQuestor': {
      const p = inst.people[key(g.person)];
      if (p && !p.questor) p.addedQuestor = g.add;
      return done();
    }
    case 'pcAt': {
      const pl = inst.places[key(g.place)];
      if (pl && host.isAt(pl)) {
        if (g.say && !st.shown) { say(run, g.say); st.shown = true; }
        startTask(run, g.task);
      } else clearTask(run, g.task);
      return undefined;
    }
    case 'pcAtAny': {
      if (host.isAtAny?.(g.placeType)) {
        if (g.say && !st.shown) { say(run, g.say); st.shown = true; }
        startTask(run, g.task);
      } else clearTask(run, g.task);
      return undefined;
    }
    case 'payMoney': {
      if (host.takeGold?.(inst, g.gold)) startTask(run, g.task);
      else if (g.otherwise) startTask(run, g.otherwise);
      return done();
    }
    case 'trainPc':
      host.trainSkill?.(inst, g.skill, g.amount);
      return done();
    case 'killFoe': {
      const k = key(g.foe);
      const f = inst.foes[k];
      if (f) {
        f.kills = Math.max(f.kills, f.count * Math.max(1, f.ambush || 1));
        f.injured = true;
        f.removed = true;
        for (const ik of f.holds ?? []) {
          const it = inst.items[ik];
          if (it && it.holder === k) {
            it.held = true;
            it.handedOver = false;
            it.location = null;
            it.holder = null;
          }
        }
        f.holds = [];
        host.killFoe?.(inst, k);
      }
      host.placed(inst);
      return done();
    }
    case 'changeFoe': {
      const k = key(g.foe);
      const f = inst.foes[k];
      if (f) {
        f.team = g.team;
        host.changeFoeTeam?.(inst, k, g.team);
      }
      return done();
    }
    case 'spawnGuards':
      inst.guardsSpawned = { at: run.now, immediate: !!g.immediate };
      host.spawnGuards?.(inst, { immediate: !!g.immediate });
      return done();
    case 'world':
      inst.worldOverrides = { ...(inst.worldOverrides ?? {}), [g.aspect]: g.value };
      host.worldChange?.(inst, g.aspect, g.value);
      return done();
    default:
      if (a.status === 'ignored') return done();
      note(run, a); // unsupported: never marked complete
      return undefined;
  }
}

/** Player answered a prompt. Returns false when there is no pending prompt. */
export function answerPrompt(def, inst, yes) {
  if (!inst.prompt) return false;
  const target = yes ? inst.prompt.yes : inst.prompt.no;
  inst.prompt = null;
  const ts = inst.tasks[key(target)];
  if (ts && !ts.d) {
    ts.t = true;
    ts.chosen = true;
  }
  return true;
}

/** Player used (read) a quest item. Starts its `used do` task when one is registered. */
export function useItem(def, inst, itemKey) {
  const it = inst.items[itemKey];
  if (!it?.useTask) return false;
  const ts = inst.tasks[key(it.useTask)];
  if (ts && !ts.d) ts.t = true;
  return true;
}
