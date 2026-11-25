// Health conditions and supernatural characters (docs/conditions.md, package 10).
//
// Owns `rpg.conditions` (shape in ./conditions/model.js): ordinary diseases with incubation and daily
// attribute damage, timed poisons and drugs, vampirism (clan, feeding, sunlight) and lycanthropy
// (werewolf / wereboar, moons, beast form), plus the 3-day supernatural infections that lead to them.
//
// TIME. Each character has its own classic-minute clock, `rpg.conditions.time`. When the calendar
// feature publishes `services.playerMinutes(p)` (world minutes + that character's rest, travel and
// prison ledger) the clock follows it; otherwise it advances with live world time while online, rest
// hours (`restEnd`) and journey minutes (`travel`). Shared facts — daylight and the two moons — come
// from `services.worldClock()`, so every player sees the same sky. One character's rest or journey
// never advances another character's conditions.
//
// Services (all synchronous, never throw):
//   conditionExposure(p, {source, damage, delivery, kind?, list?, poison?, bypassSave?}) -> {contracted:[{kind,key,name}]}
//   conditionPlayerHit(p, target, damage)        vampire feeding strike
//   cureCondition(p, kind) -> count              'disease'|'poison'|'attributes'|'vampirism'|'lycanthropy'|'all'
//   healConditionAttribute(p, attr, amount) -> restored
//   conditionAttributePenalty(actor, attr) -> n  positive lowers; negative is a supernatural bonus
//   conditionSkillModifier(actor, skill) -> n
//   conditionImmune(p, 'disease'|'paralysis'|'poison') -> boolean
//   conditionCount(p, 'disease') -> n            temple count (diseases + pending infection)
//   conditionStatus(p) -> summary                (see statusOf)
//   conditionMorphSelf(p, {force?}) -> {ok, transformed, reason?}
//   makeDiseased(p, typeOrKey), makePoisoned(p, typeOrKey), startInfection(p, kind), deploySupernatural(p, kind, {clan?})
//   moonPhases(minutes?) -> {masser, secunda, full}
// Actions: conditions.status, conditions.morph. Temple cures are the temple counter's (npc.service 'cure',
// package 15): it quotes conditionCount(p,'disease') × 250 and calls cureCondition(p,'disease').
// Events: notify {kind:'condition', change, text, ...}; ctx.emit 'conditionChanged' and 'supernaturalQuest'.

import { readFileSync, readdirSync } from 'node:fs';
import { dateFromMinutes, DUSK_HOUR, isIndoors, MINUTES_PER_DAY, regionOf } from '../../client/gameplay/atmosphere/calendar.js';
import { REGION_NAMES } from '../../client/world/maps.js';
import { parseTextRsc } from '../../client/gameplay/character/classic.js';
import { CITY_WATCH } from './law.js';
import {
  DISEASES, POISONS, CARRIERS, CLANS, DEFAULT_CLAN, TEXT, clanName, moonsOf, isFullMoon, diseaseOf, poisonOf, vampireSpellIndices,
} from './conditions/tables.js';
import * as M from './conditions/model.js';

export const name = 'conditions';

const MAX_STEP = 1440 * 60; // catch-up bound per tick (60 days)
const IDLE_STEP = 15; // game minutes batched while nothing time-critical runs
const NOTIFY_PREFIX = 'condition';
const TEMPLE_BUILDING = 14; // DFLocation.BuildingTypes.Temple
const FIGHTER_TRAINERS = 849; // FactionFile.FactionIDs.Fighter_Trainers

export function install(ctx, options = {}) {
  const S = (ctx.services ||= {});
  const log = ctx.log ?? console;
  const rng = typeof options.random === 'function' ? options.random : Math.random;
  const lastWorld = new Map(); // player id -> world minutes at last tick (fallback clock + sunlight)
  const pending = new Map(); // player id -> {minutes (fallback clock), sun} not yet applied
  const awakenings = new WeakMap();
  let exposureCalled = false; // combat has adopted conditionExposure: stop the damage-event fallback

  // ------------------------------------------------------------------ operator data (optional)

  let rsc = null;
  const vamByRegion = new Map();
  if (ctx.dataPath) {
    try { rsc = parseTextRsc(new Uint8Array(readFileSync(findData('TEXT.RSC')))); } catch (err) { log.warn?.(`[conditions] TEXT.RSC unavailable: ${err.message}`); }
    try { readVampireClans(readFileSync(findData('FACTION.TXT'), 'latin1')); } catch (err) { log.warn?.(`[conditions] FACTION.TXT unavailable: ${err.message}`); }
  }
  function findData(file) {
    const actual = readdirSync(ctx.dataPath).find((f) => f.toUpperCase() === file) ?? file;
    return ctx.dataFile(actual);
  }
  /** Province factions (type 7) carry `vam:` — the clan ruling the region (FormulaHelper.GetVampireClan). */
  function readVampireClans(text) {
    let cur = null;
    const flush = () => { if (cur && cur.type === 7 && cur.region >= 0 && CLANS[cur.vam]) vamByRegion.set(cur.region, cur.vam); };
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const head = /^#(\d+)/.exec(line);
      if (head) { flush(); cur = { type: -1, region: -1, vam: -1 }; continue; }
      const m = /^(type|region|vam):\s*(-?\d+)/i.exec(line);
      if (cur && m) {
        const n = Number(m[2]);
        cur[m[1].toLowerCase()] = m[1].toLowerCase() === 'region' && n !== -1 ? n - 1 : n;
      }
    }
    flush();
  }
  const text = (id, fallback) => {
    try { const v = rsc?.variants(id); if (v?.length) return v[Math.floor(rng() * v.length)].replace(/%\w+/g, '').trim() || fallback; } catch {}
    return fallback;
  };

  // ------------------------------------------------------------------ helpers

  const isPlayer = (p) => !!p && ctx.players.get(p.id) === p && !!p.rpg;
  const character = (p) => (p?.rpg?.character && typeof p.rpg.character === 'object' ? p.rpg.character : null);
  const worldMinutes = () => {
    const c = S.worldClock?.();
    return Number.isFinite(c?.minutes) ? c.minutes : null;
  };
  const playerMinutes = (p) => {
    const v = S.playerMinutes?.(p);
    return Number.isFinite(v) ? Math.trunc(v) : null;
  };
  function state(p) {
    const now = playerMinutes(p) ?? worldMinutes() ?? 0;
    const st = p.rpg.conditions;
    if (st && st.version === M.VERSION && Array.isArray(st.diseases) && Array.isArray(st.poisons) && st.ticks) return st;
    return M.normalize(p.rpg, now);
  }
  const locationOf = (p) => String(ctx.location?.(p) ?? p.rpg?.location ?? '');
  function regionIndexOf(p) {
    const loc = locationOf(p);
    let region = null;
    try { region = S.travel?.regionOf?.(loc) ?? null; } catch {}
    region ??= regionOf(loc);
    const i = REGION_NAMES.indexOf(region);
    return i >= 0 ? i : null;
  }
  const clanHere = (p) => {
    const ri = regionIndexOf(p);
    return (ri !== null && vamByRegion.get(ri)) || DEFAULT_CLAN;
  };
  function cemeteryFor(p, infection) {
    if (!S.travel?.regionLocations || !S.interiors?.cemeteryEntry || !S.portals?.transfer) return null;
    if (S.travel.source === 'loading') return undefined;
    const region = regionIndexOf(p);
    const cached = awakenings.get(p);
    if (cached?.infection === infection && cached.region === region) return cached.entry;
    const job = { infection, region, entry: undefined };
    awakenings.set(p, job);
    const fallback = REGION_NAMES.indexOf('Daggerfall');
    const regions = new Set([region, fallback]);
    (async () => {
      for (const index of regions) {
        const sites = S.travel.regionLocations(index).filter((entry) => entry.dungeonType === 18);
        const first = Math.floor(rng() * sites.length);
        for (const site of [...sites.slice(first), ...sites.slice(0, first)]) {
          try {
            const entry = await S.interiors.cemeteryEntry(site.id);
            if (entry) { job.entry = entry; return; }
          } catch (err) {
            log.warn?.(`[conditions] cemetery ${site.id} is unavailable: ${err.message}`);
          }
        }
      }
      job.entry = null;
    })().catch((err) => {
      log.warn?.(`[conditions] cemetery selection failed: ${err.message}`);
      job.entry = null;
    });
    return job.entry;
  }
  /** Minutes of the last `delta` world minutes this character stood in shared daylight (dawn 06:00). */
  const sunlitMinutes = (p, delta) => {
    const c = S.worldClock?.();
    if (!c || c.isNight !== false || isIndoors(locationOf(p)) || p.rpg?.defeated) return 0;
    if (!(Number(character(p)?.health) > 0)) return 0;
    return Math.max(0, Math.min(delta, c.minuteOfDay - 6 * 60));
  };
  /** PlayerEnterExit.IsPlayerInHolyPlace: inside a temple or a Fighter Trainers hall (faction 849). */
  const holyMinutes = (p, delta) => {
    if (!delta || p.rpg?.defeated || !(Number(character(p)?.health) > 0)) return 0;
    const loc = locationOf(p);
    const meta = loc.startsWith('temple:') ? null : S.portals?.into?.(loc)?.meta;
    const holy = S.isHolyPlace?.(p) ?? (loc.startsWith('temple:') || meta?.buildingType === TEMPLE_BUILDING || meta?.factionId === FIGHTER_TRAINERS);
    return holy ? delta : 0;
  };
  const level = (p) => Math.max(1, Math.trunc(character(p)?.level) || 1);
  const attr = (p, a) => {
    const v = S.effectiveAttribute?.(p, a);
    if (Number.isFinite(v)) return v;
    return Number(character(p)?.attributes?.[a]) || 50;
  };

  function tell(p, change, txt, extra = {}) {
    ctx.notify(p, { kind: NOTIFY_PREFIX, change, text: txt, ...extra });
  }
  function changed(p, change, kind, key) {
    ctx.dirty(p);
    ctx.emit('conditionChanged', { player: p, change, kind, key });
  }

  /**
   * FormulaHelper.SavingThrow for disease/poison. Package 11's `characterSavingThrow(p, kind)` supplies
   * {immune, critical, modifier} (career tolerance + biography); otherwise only the biography mod counts.
   * Returns true when the character resists.
   */
  function resists(p, kind) {
    let st = null;
    try { st = S.characterSavingThrow?.(p, kind) ?? null; } catch {}
    if (st?.immune) return true;
    let save = 50;
    if (st) save += (st.critical ? -50 : 0) + (Number(st.modifier) || 0);
    else {
      const mods = S.biographyModifiers?.(p) ?? character(p)?.biography?.mods ?? {};
      save += Number(kind === 'poison' ? mods.resistPoison : mods.resistDisease) || 0;
    }
    if (save >= 100) return true;
    save += Math.floor(attr(p, 'Willpower') / 10);
    save = Math.max(5, Math.min(95, save));
    return Math.floor(rng() * 100) + 1 <= save;
  }

  // ------------------------------------------------------------------ contracting

  function contractDisease(p, type, { bypassSave = false } = {}) {
    const st = state(p);
    if (level(p) < 2 || M.immuneTo(st, 'disease')) return null;
    if (!bypassSave && resists(p, 'disease')) return null;
    const rec = M.addDisease(st, type, rng);
    if (!rec) return null;
    changed(p, 'contracted', 'disease', DISEASES[type].key);
    return { kind: 'disease', key: DISEASES[type].key, name: DISEASES[type].name };
  }

  function contractPoison(p, type, { bypassSave = false } = {}) {
    const st = state(p);
    if (level(p) < 2) return null; // FormulaHelper.InflictPoison: level 1 targets are spared
    if (!bypassSave && resists(p, 'poison')) return null;
    const rec = M.addPoison(st, type, rng);
    if (!rec) return null;
    changed(p, 'contracted', 'poison', POISONS[type].key);
    return { kind: 'poison', key: POISONS[type].key, name: POISONS[type].name };
  }

  function infect(p, kind) {
    const st = state(p);
    if (!M.startInfection(st, kind, kind === 'vampirism' ? clanHere(p) : undefined)) return null;
    changed(p, 'contracted', kind, kind);
    return { kind, key: kind, name: kind === 'vampirism' ? 'Vampirism' : kind === 'werewolf' ? 'Lycanthropy (werewolf)' : 'Lycanthropy (wereboar)' };
  }

  function exposure(p, opts = {}) {
    const out = { contracted: [] };
    try {
      if (!isPlayer(p) || !character(p)) return out;
      const push = (r) => { if (r) out.contracted.push(r); };
      const bypass = opts.bypassSave === true;
      if (opts.poison !== undefined && opts.poison !== null) {
        const t = poisonOf(opts.poison);
        if (t) push(contractPoison(p, t.index, { bypassSave: bypass }));
      }
      if (opts.kind === 'disease' && Array.isArray(opts.list) && opts.list.length) {
        const list = opts.list.map((v) => diseaseOf(v)).filter(Boolean);
        if (list.length) push(contractDisease(p, list[Math.floor(rng() * list.length)].index, { bypassSave: bypass }));
      } else if (['vampirism', 'werewolf', 'wereboar'].includes(opts.kind)) {
        push(infect(p, opts.kind));
      }
      const src = opts.source;
      const carrier = src && src.kind === 'monster' && Number.isInteger(src.monsterId) ? CARRIERS[src.monsterId] : null;
      if (carrier && (opts.delivery ?? 'melee') === 'melee' && !(Number(opts.damage) <= 0)) {
        const r = rng() * 100; // UnityEngine.Random.Range(0f, 100f)
        if (carrier.special && r <= 0.6) push(infect(p, carrier.special));
        else if (carrier.disease && (carrier.special ? r <= carrier.disease.chance : Math.floor(rng() * 100) + 1 <= carrier.disease.chance)) {
          const list = carrier.disease.list;
          push(contractDisease(p, list[Math.floor(rng() * list.length)]));
        }
      }
    } catch (err) {
      log.warn?.(`[conditions] exposure failed: ${err.message}`);
    }
    return out;
  }

  // ------------------------------------------------------------------ time

  function step(p, minutes, sunMinutes, holyMinutes = 0) {
    const st = state(p);
    const elapsed = Math.max(0, Math.min(minutes, MAX_STEP));
    const due = st.infection?.kind === 'vampirism' && M.infectionDue(st.infection, st.time + elapsed);
    if (!elapsed && !due) return true;
    const cemetery = due ? cemeteryFor(p, st.infection) : undefined;
    const run = () => advance(p, st, elapsed, sunMinutes, cemetery, holyMinutes);
    // The awakening is one save: moving, charging time and granting spells are never separate writes.
    if (due && cemetery !== undefined && ctx.runAtomic && !ctx.inAction?.()) {
      return ctx.runAtomic(p, 'conditions.awakening', run).ok;
    }
    run();
    return true;
  }

  function advance(p, st, minutes, sunMinutes, cemetery, holyMinutes = 0) {
    const c = S.worldClock?.();
    const date = c && Number.isFinite(c.minutes) ? dateFromMinutes(c.minutes) : null;
    const hourBefore = Math.floor(st.time / 60);
    const events = M.advance(st, minutes, {
      rng, sunMinutes, holyMinutes, fullMoon: !!date && isFullMoon(date), maxHealth: Number(character(p)?.maxHealth) || 0, hircine: hircine(p),
      deferVampire: cemetery === undefined,
    });
    if (events.length || Math.floor(st.time / 60) !== hourBefore) ctx.dirty(p);
    for (const e of events) apply(p, st, e, cemetery);
    enforceLimiter(p, st);
  }

  function apply(p, st, e, cemetery) {
    const c = character(p);
    switch (e.type) {
      case 'vitals': {
        if (!c) return;
        if (e.fatigue && Number.isFinite(c.fatigue)) c.fatigue = Math.max(0, Math.min(Number(c.maxFatigue) || c.fatigue, c.fatigue - e.fatigue));
        if (e.magicka && Number.isFinite(c.magicka)) c.magicka = Math.max(0, Math.min(Number(c.maxMagicka) || c.magicka, c.magicka - e.magicka));
        if (e.health > 0) {
          if (typeof S.damagePlayer === 'function') S.damagePlayer(p, e.health, { kind: 'condition' });
          else if (Number.isFinite(c.health)) c.health = Math.max(0, c.health - e.health);
        }
        ctx.dirty(p);
        if (e.health > 0 || e.fatigue > 0 || e.magicka > 0) tell(p, 'symptom', 'You feel somewhat bad.', { health: e.health, fatigue: e.fatigue, magicka: e.magicka });
        return;
      }
      case 'symptoms': {
        const d = DISEASES[e.disease.type];
        changed(p, 'diagnosed', 'disease', d.key);
        tell(p, 'diagnosed', text(d.textId, `You have contracted ${d.name}.`), { key: d.key, name: d.name });
        return;
      }
      case 'diseaseEnded':
        changed(p, 'ended', 'disease', DISEASES[e.disease.type].key);
        tell(p, 'ended', `You have recovered from ${DISEASES[e.disease.type].name}.`, { key: DISEASES[e.disease.type].key });
        return;
      case 'poisonActive':
        changed(p, 'poisonActive', 'poison', POISONS[e.poison.type].key);
        tell(p, 'poisoned', 'You have been poisoned.', { key: POISONS[e.poison.type].key });
        return;
      case 'poisonSpent':
        changed(p, 'ended', 'poison', POISONS[e.poison.type].key);
        return;
      case 'dream':
        changed(p, 'dream', e.kind, e.kind);
        tell(p, 'dream', e.kind === 'vampirism' ? 'You dream of a pale figure feeding in the dark…' : 'You dream of running through moonlit woods…', { infection: e.kind });
        return;
      case 'deploy':
        if (e.kind === 'vampirism') awaken(p, st, cemetery);
        deployed(p, e.kind);
        return;
      case 'sunlight':
        tell(p, 'sunlight', 'The sunlight burns you!', { damage: e.damage });
        return;
      case 'holy':
        tell(p, 'holy', 'This holy place burns you!', { damage: e.damage });
        return;
      case 'fullMoon':
        transformed(p, st.lycanthrope.form, true, 'You dream of the moon.');
        return;
      case 'quest':
        ctx.emit('supernaturalQuest', { player: p, kind: st.vampire ? 'vampire' : st.lycanthrope?.form, cure: e.cure });
        return;
    }
  }

  function awaken(p, st, cemetery) {
    const now = playerMinutes(p) ?? st.time;
    const hour = dateFromMinutes(now).hour;
    const skip = MINUTES_PER_DAY * 14 + (DUSK_HOUR + 1 - hour) * 60;
    S.spendTime?.(p, skip, 'vampireAwakening');
    st.time = now + skip;
    M.deploy(st, 'vampirism', st.vampire.clanFactionId);
    delete p.rpg.defeated;
    ctx.afterCommit?.(() => S.interruptRest?.(p, 'transformed', 'Your rest ends as you awaken.'));
    if (!cemetery) return;
    const { landing, portal, entrance } = cemetery;
    S.portals.transfer(p, landing, { portal, entrance });
    p.rpg.portal.vampireAwakening = true;
    S.travel.discover?.(p, portal.from);
  }

  const beastForm = (p) => {
    const lycan = p?.rpg?.conditions?.lycanthrope;
    return lycan?.transformed && ['werewolf', 'wereboar'].includes(lycan.form) ? lycan.form : null;
  };

  function announceForm(p, form, active) {
    ctx.nearby(locationOf(p), { kind: 'conditionForm', playerId: p.id, transformed: active, form });
  }

  function transformed(p, form, active, message) {
    const c = character(p);
    if (c && Number.isFinite(c.maxHealth)) c.health = c.maxHealth;
    if (active) S.clearEquippedHands?.(p);
    changed(p, 'transformed', 'lycanthropy', form);
    tell(p, 'transformed', message, { transformed: active, form });
    announceForm(p, form, active);
  }

  function deployed(p, kind) {
    const st = state(p);
    const c = character(p);
    // EntityEffectManager.CureAll on deployment: vitals full, every other condition gone.
    if (c) for (const [cur, max] of [['health', 'maxHealth'], ['fatigue', 'maxFatigue'], ['magicka', 'maxMagicka']]) if (Number.isFinite(c[max])) c[cur] = c[max];
    S.setVampireSpells?.(p, st.vampire ? vampireSpellIndices(st.vampire.clanFactionId) : []);
    changed(p, 'deployed', kind, kind);
    const txt = kind === 'vampirism'
      ? `${text(TEXT.deathIsNotEternal, 'Death is not eternal.')} You are now a vampire of the ${clanName(st.vampire.clanFactionId)} bloodline.`
      : `The beast within you awakens. You are now a ${kind}.`;
    tell(p, 'deployed', txt, { infection: kind, clan: st.vampire ? clanName(st.vampire.clanFactionId) : null });
  }

  /** LycanthropyEffect.IsWearingHircineRing (the enchanting feature, package 16, reports equipped artifacts). */
  const hircine = (p) => !!S.wearsArtifact?.(p, 'artifact-hircine-ring');

  /** LycanthropyEffect.SetMaxHealthLimiter while the urge to kill goes unanswered. */
  function enforceLimiter(p, st) {
    const c = character(p);
    const cap = c ? M.healthLimit(st, Number(c.maxHealth) || 0, { hircine: hircine(p) }) : null;
    if (cap !== null && Number.isFinite(c.health) && c.health > cap) {
      c.health = cap;
      ctx.dirty(p);
    }
  }

  ctx.onJoin((p) => {
    if (!p.rpg) return;
    const st = state(p);
    if (st.vampire) S.setVampireSpells?.(p, vampireSpellIndices(st.vampire.clanFactionId));
    if (beastForm(p)) S.clearEquippedHands?.(p);
    lastWorld.set(p.id, worldMinutes());
    registerBlockers();
  });
  ctx.onLeave((p) => { lastWorld.delete(p.id); pending.delete(p.id); });

  ctx.onTick(() => {
    const world = worldMinutes();
    for (const p of ctx.players.values()) {
      if (!p.rpg || !character(p)) continue;
      const st = state(p);
      const prev = lastWorld.get(p.id);
      lastWorld.set(p.id, world);
      const worldDelta = world !== null && prev !== null && prev !== undefined ? Math.max(0, world - prev) : 0;
      const target = playerMinutes(p);
      const due = pending.get(p.id) ?? { minutes: 0, sun: 0, holy: 0 };
      due.sun += sunlitMinutes(p, worldDelta);
      due.holy += holyMinutes(p, worldDelta);
      if (target === null) due.minutes += worldDelta;
      const minutes = target !== null ? target - st.time : due.minutes;
      if (target !== null && target < st.time - 1440) { st.time = target; continue; } // clock reset by an operator: follow it
      // Idle time is applied in quarter hours so the private snapshot does not change every game minute;
      // running poisons, vampires (sunlight) and day boundaries are applied at once.
      const awakening = st.infection?.kind === 'vampirism' && M.infectionDue(st.infection, st.time + Math.max(0, Math.min(minutes, MAX_STEP)));
      const urgent = !!st.vampire || st.poisons.some((x) => x.state !== 'complete') || Math.floor((st.time + minutes) / 1440) !== Math.floor(st.time / 1440);
      if (awakening || (minutes > 0 && (minutes >= IDLE_STEP || urgent))) {
        if (step(p, minutes, due.sun, due.holy)) pending.delete(p.id);
        else pending.set(p.id, due);
      } else pending.set(p.id, due);
    }
  });

  // Fallback clock when the calendar feature does not publish playerMinutes.
  ctx.on('restEnd', (ev) => {
    const p = ev?.player;
    if (isPlayer(p) && playerMinutes(p) === null && ev.hours > 0) step(p, Math.trunc(ev.hours) * 60, 0);
  });
  ctx.on('travel', (ev) => {
    const p = ev?.player;
    if (!isPlayer(p) || playerMinutes(p) !== null) return;
    const m = Number(p.rpg.travel?.lastTrip?.minutes);
    if (m > 0) step(p, Math.trunc(m), 0);
  });

  // ------------------------------------------------------------------ hooks into other features

  // Combat's damage event until it calls conditionExposure itself (melee carriers only: no casting kinds).
  ctx.on('damage', (ev) => {
    if (exposureCalled) return;
    const p = ev?.target ?? ev?.player;
    const src = ev?.source;
    if (!isPlayer(p) || !src || src.kind !== 'monster' || !CARRIERS[src.monsterId]) return;
    exposure(p, { source: src, damage: ev.amount, delivery: 'melee' });
  });

  // Feeding and the lycanthrope's urge: a kill always follows a landed hit.
  function feedOnKill(ev) {
    const p = ev?.player;
    const e = ev?.entity;
    if (!isPlayer(p) || !e) return;
    const st = state(p);
    if (st.vampire) { st.vampire.lastFed = st.time; ctx.dirty(p); }
    if (st.lycanthrope && ((e.kind === 'monster' && e.monsterId === CITY_WATCH) || (e.kind === 'npc' && e.mobile))) {
      st.lycanthrope.lastKill = st.time;
      ctx.dirty(p);
    }
  }
  ctx.on('kill', feedOnKill);
  ctx.on('civilianKilled', feedOnKill);

  function restRefusal(p) {
    if (!isPlayer(p)) return null;
    const st = state(p);
    if (st.vampire && !M.isSated(st)) return text(TEXT.notSated, 'You need to feed before you can rest.');
    return null;
  }
  function travelRefusal(p) {
    if (!isPlayer(p)) return null;
    const st = state(p);
    const c = S.worldClock?.();
    if (st.vampire && c && c.isNight === false) return 'The sunlight would destroy you. Travel by night.';
    if (st.lycanthrope?.transformed) return 'You cannot travel in beast form.';
    return null;
  }
  let blockersRegistered = false;
  function registerBlockers() {
    if (blockersRegistered) return;
    if (S.preventRest instanceof Map && S.preventTravel instanceof Map) {
      S.preventRest.set('conditions', restRefusal);
      S.preventTravel.set('conditions', travelRefusal);
      blockersRegistered = true;
    }
  }
  registerBlockers();
  // Fallbacks for a server without the calendar package's blockers.
  ctx.on('restStart', (ev) => {
    const p = ev?.player;
    if (blockersRegistered || !isPlayer(p)) return;
    const why = restRefusal(p);
    if (why) S.interruptRest?.(p, 'prevented', why);
  });
  ctx.on('travel', (ev) => {
    const p = ev?.player;
    if (blockersRegistered || !isPlayer(p)) return;
    const why = travelRefusal(p);
    if (why) throw new Error(why); // the travel action rolls back
  });

  // ------------------------------------------------------------------ status

  function statusOf(p) {
    const st = state(p);
    const c = character(p);
    const moons = moonPhases();
    return {
      time: st.time,
      diseases: st.diseases.map((d) => ({
        key: DISEASES[d.type].key, name: DISEASES[d.type].name, incubating: !d.incubationOver,
        daysLeft: DISEASES[d.type].permanent ? null : d.daysLeft, loss: { ...d.loss },
      })),
      poisons: st.poisons.map((x) => ({ key: POISONS[x.type].key, name: POISONS[x.type].name, state: x.state, mods: { ...x.mods } })),
      infection: st.infection ? { kind: st.infection.kind, dreamed: st.infection.dreamed } : null,
      vampire: st.vampire ? { clan: clanName(st.vampire.clanFactionId), clanFactionId: st.vampire.clanFactionId, sated: M.isSated(st) } : null,
      lycanthrope: st.lycanthrope ? { form: st.lycanthrope.form, transformed: st.lycanthrope.transformed, healthLimit: c ? M.healthLimit(st, Number(c.maxHealth) || 0, { hircine: hircine(p) }) : null, hircine: hircine(p) } : null,
      previousClanFactionId: st.previousClanFactionId,
      immune: { disease: M.immuneTo(st, 'disease'), paralysis: M.immuneTo(st, 'paralysis') },
      moons,
    };
  }

  /** The classic health popup: only diseases past incubation and poisons that have taken hold. */
  function healthReport(p) {
    const st = state(p);
    const lines = st.diseases.filter((d) => d.incubationOver).map((d) => text(DISEASES[d.type].textId, `You have ${DISEASES[d.type].name}.`));
    if (st.poisons.some((x) => x.state === 'active')) lines.push('You have been poisoned.');
    else if (st.poisons.length) lines.push('Your attributes are still weakened by poison.');
    if (st.vampire) lines.push(`You are a vampire of the ${clanName(st.vampire.clanFactionId)} bloodline${M.isSated(st) ? '.' : ' and you hunger.'}`);
    if (st.lycanthrope) lines.push(`You are a ${st.lycanthrope.form}${st.lycanthrope.transformed ? ', in beast form.' : '.'}`);
    return lines.length ? lines.join('\n') : text(TEXT.healthy, 'You are healthy.');
  }

  function moonPhases(minutes = worldMinutes()) {
    if (!Number.isFinite(minutes)) return null;
    const d = dateFromMinutes(minutes);
    return { ...moonsOf(d), full: isFullMoon(d) };
  }

  // ------------------------------------------------------------------ cures

  /**
   * `kind`: 'disease' | 'poison' | 'attributes' | 'vampirism' | 'lycanthropy' | 'all', or {disease} for one
   * named disease (quest `cure <disease>`; {disease:null} means every disease).
   */
  function cureCondition(p, kind) {
    if (!isPlayer(p)) return 0;
    const st = state(p);
    if (kind && typeof kind === 'object') {
      if (kind.disease === null || kind.disease === undefined) kind = 'disease';
      else {
        const d = diseaseOf(kind.disease);
        const n = d ? M.cureDisease(st, d.index) : 0;
        if (n) {
          changed(p, 'cured', 'disease', d.key);
          tell(p, 'cured', `You are cured of ${d.name}.`, { cured: d.key, count: n });
        }
        return n;
      }
    }
    const previousForm = beastForm(p);
    const wasVampire = !!st.vampire;
    const n = M.cure(st, String(kind));
    if (!n) return 0;
    const c = character(p);
    if (previousForm && !st.lycanthrope) {
      if (c && Number.isFinite(c.maxHealth)) c.health = c.maxHealth;
      announceForm(p, previousForm, false);
    }
    if (wasVampire && !st.vampire) S.setVampireSpells?.(p, []);
    changed(p, 'cured', String(kind), String(kind));
    const what = { disease: 'disease', poison: 'poison', attributes: 'weakness', vampirism: 'vampirism', lycanthropy: 'lycanthropy', all: 'every affliction' }[kind] ?? 'affliction';
    tell(p, 'cured', `You are cured of ${what}.`, { cured: kind, count: n });
    return n;
  }

  // ------------------------------------------------------------------ services

  Object.assign(S, {
    conditionBeastForm: beastForm,
    conditionQuietArrival: (p, location) => !!p.rpg.conditions?.vampire && p.rpg.portal?.to === location && p.rpg.portal.vampireAwakening === true,
    conditionExposure(p, opts) {
      if (opts?.source && opts.source.kind === 'monster') exposureCalled = true;
      return exposure(p, opts);
    },
    conditionPlayerHit(p, target, damage) {
      if (!isPlayer(p) || !(Number(damage) > 0) || !target) return;
      const st = state(p);
      if (st.vampire) { st.vampire.lastFed = st.time; ctx.dirty(p); }
    },
    cureCondition,
    healConditionAttribute(p, attribute, amount) {
      if (!isPlayer(p)) return 0;
      const n = M.healAttribute(state(p), String(attribute), amount);
      if (n) changed(p, 'healed', 'attributes', String(attribute));
      return n;
    },
    conditionAttributePenalty(actor, attribute) {
      if (!isPlayer(actor)) return 0;
      return M.attributePenalty(state(actor), String(attribute));
    },
    conditionSkillModifier(actor, skill) {
      if (!isPlayer(actor)) return 0;
      return M.skillModifier(state(actor), String(skill));
    },
    conditionImmune(p, kind) {
      return isPlayer(p) ? M.immuneTo(state(p), kind) : false;
    },
    conditionCount(p, kind = 'disease') {
      if (!isPlayer(p)) return 0;
      const st = state(p);
      if (kind === 'disease') return st.diseases.length + (st.infection ? 1 : 0);
      if (kind === 'poison') return st.poisons.length;
      return 0;
    },
    conditionStatus: (p) => (isPlayer(p) ? statusOf(p) : null),
    conditionMorphSelf(p, opts = {}) {
      if (!isPlayer(p)) return { ok: false, transformed: false, reason: 'No character.' };
      if (p.rpg.defeated || !(character(p)?.health > 0)) return { ok: false, transformed: !!beastForm(p), reason: 'You cannot change form while defeated.' };
      const st = state(p);
      const r = M.morph(st, { ...opts, hircine: hircine(p) });
      if (r.ok) {
        const form = st.lycanthrope.form;
        transformed(p, form, r.transformed, r.transformed ? `You take the form of a ${form}.` : 'You return to your normal form.');
      }
      return r;
    },
    makeDiseased(p, v) {
      const d = diseaseOf(v);
      if (!isPlayer(p) || !d) return null;
      return contractDisease(p, d.index, { bypassSave: true });
    },
    makePoisoned(p, v) {
      const t = poisonOf(v);
      if (!isPlayer(p) || !t) return null;
      return contractPoison(p, t.index, { bypassSave: true });
    },
    /** Quest `make pc ill with …` and special triggers: {disease} | {poison} | {kind:'vampirism'|'werewolf'|'wereboar'}. */
    applyCondition(p, what = {}) {
      if (!isPlayer(p) || !what || typeof what !== 'object') return null;
      if (what.disease !== undefined && what.disease !== null) return S.makeDiseased(p, what.disease);
      if (what.poison !== undefined && what.poison !== null) return S.makePoisoned(p, what.poison);
      if (['vampirism', 'werewolf', 'wereboar'].includes(what.kind)) return infect(p, what.kind);
      return null;
    },
    startInfection: (p, kind) => (isPlayer(p) ? infect(p, kind) : null),
    deploySupernatural(p, kind, opts = {}) {
      if (!isPlayer(p) || !['vampirism', 'werewolf', 'wereboar'].includes(kind)) return false;
      const st = state(p);
      M.deploy(st, kind, Number.isInteger(opts.clan) ? opts.clan : clanHere(p));
      deployed(p, kind);
      return true;
    },
    moonPhases,
  });

  // ------------------------------------------------------------------ actions

  ctx.onAction('conditions.status', (p, args = {}) => {
    if (!character(p)) throw new Error('Create your character first.');
    // The Health panel refreshes quietly; an explicit Examine shows the report as a message too.
    tell(p, 'status', healthReport(p), { status: publicStatus(p), silent: args.quiet === true });
  });

  ctx.onAction('conditions.morph', (p) => {
    const r = S.conditionMorphSelf(p);
    if (!r.ok) throw new Error(r.reason);
  });

  /** What the owning client may render: incubating diseases stay unnamed until diagnosed. */
  function publicStatus(p) {
    const s = statusOf(p);
    return { ...s, diseases: s.diseases.filter((d) => !d.incubating) };
  }

  return { state, step, statusOf, publicStatus, healthReport, exposure, vamByRegion };
}

export default install;
