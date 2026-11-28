// Party coordination: optional location sharing (coarse by default, exact on explicit opt-in),
// map pings, travel-to-leader fare/route quotes, and expiring atomic party ready-checks.
//
// Invariants:
//   - Respects discovered-place rules, restricted instances, ships, Mantellan Crux, and protected PvP areas.
//   - Preserves quest privacy and each member's own fare, travel options, and gold.
//   - If ANY opted-in member drops or eligibility/fare changes before commit, nobody pays and nobody travels:
//     the party returns to an updated proposal with reset confirmations.
//   - Atomic group commit marks every travelling member dirty before mutation and restores all on any fault.
import { randomBytes } from 'node:crypto';
import { parseLocationId, wildernessOrigin } from '../../../client/gameplay/travel/catalog.js';
import { classicCatalog } from '../../../client/gameplay/travel/classic.js';
import { hasFreeShipPassage, normalizeOptions, presentationMs, quoteJourney } from '../../../client/gameplay/travel/journey.js';
import { hasFound, normalizeFound } from '../../../client/gameplay/travel/identity.js';
import { isMantellan } from '../../../client/world/interiors/dungeonAccess.js';
import { regionOf, tokenBucket } from './chat.js';
import { goldOf } from './trade.js';

export const SHARE_MODES = Object.freeze(['off', 'coarse', 'exact']);
export const PING_TTL_MS = 60_000;
export const MAX_PINGS = 8;
export const READY_CHECK_TTL_MS = 45_000;
export const PING_RATE_PER_SEC = 0.5;
export const PING_BURST = 4;

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const newId = (prefix) => `${prefix}${randomBytes(6).toString('hex')}`;
const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

function cleanStr(raw, maxLen) {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFC').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function placeNameOf(loc, lookup) {
  if (typeof loc !== 'string' || !loc) return 'Unknown';
  const entry = lookup?.(loc);
  if (entry?.name) return String(entry.name).trim();
  const body = loc.includes(':') ? loc.slice(loc.indexOf(':') + 1) : loc;
  const parts = body.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : body;
}

function captureTraveler(p) {
  return {
    rpg: structuredClone(p.rpg),
    x: p.x,
    z: p.z,
    yaw: p.yaw,
    forward: p.forward,
    strafe: p.strafe,
    moving: p.moving,
  };
}

function restoreTraveler(p, snap) {
  for (const k of Object.keys(p.rpg)) delete p.rpg[k];
  Object.assign(p.rpg, snap.rpg);
  p.x = snap.x;
  p.z = snap.z;
  p.yaw = snap.yaw;
  p.forward = snap.forward;
  p.strafe = snap.strafe;
  p.moving = snap.moving;
}

export function createPartyTravelService(ctx, { now = () => Date.now(), wallNow = () => Date.now(), online, dirty, partyOfPlayer, locationOf, pushParty, push }) {
  const fallbackCatalog = classicCatalog();
  const partyData = new Map(); // partyId -> { sharing: Map<charId, mode>, pings: Ping[], proposal: Proposal|null }
  const pingBuckets = new Map(); // charId -> tokenBucket

  function ensurePartyData(partyId) {
    let d = partyData.get(partyId);
    if (!d) {
      d = { sharing: new Map(), pings: [], proposal: null };
      partyData.set(partyId, d);
    }
    return d;
  }

  function pingLimiter(playerId) {
    let b = pingBuckets.get(playerId);
    if (!b) {
      b = tokenBucket(ctx.config?.partyPingRatePerSec ?? PING_RATE_PER_SEC, ctx.config?.partyPingBurst ?? PING_BURST, now);
      pingBuckets.set(playerId, b);
    }
    return b;
  }

  function lookupPlace(loc) {
    if (!loc || typeof loc !== 'string') return null;
    const viaService = ctx.services?.travel?.lookup?.(loc);
    if (viaService) return viaService;
    return fallbackCatalog.get(loc) ?? null;
  }

  /**
   * True when a player stands inside a restricted instance, ship deck, interior, dungeon,
   * or protected PvP area where exact coordinates/pins must not be shared.
   */
  function isRestrictedArea(p) {
    if (!p) return true;
    if (ctx.services?.isRestrictedLocation?.(p)) return true;
    if (ctx.services?.pvp?.isProtected?.(p)) return true;
    if (ctx.services?.presenceScope?.(p)) return true;
    if (ctx.services?.sailing?.aboard?.(p)) return true;
    const loc = locationOf(p);
    if (typeof loc !== 'string') return true;
    if (loc.startsWith('interior:') || loc.startsWith('dungeon:') || loc.startsWith('home:') || loc.startsWith('arena:') || loc.startsWith('pvp:')) {
      return true;
    }
    if (ctx.services?.property?.isShipLocation?.(loc)) return true;
    return false;
  }

  function shareModeOf(partyId, playerId) {
    const d = partyData.get(partyId);
    return d?.sharing.get(playerId) ?? 'coarse';
  }

  function memberLocationView(party, memberId) {
    const m = online(memberId);
    const mode = shareModeOf(party.id, memberId);
    if (!m) {
      return { mode, shared: false, restricted: false, region: null, landmark: null, locationId: null, exact: null };
    }
    if (mode === 'off') {
      return { mode: 'off', shared: false, restricted: false, region: null, landmark: null, locationId: null, exact: null };
    }
    const loc = locationOf(m);
    const region = regionOf(loc, ctx);
    if (isRestrictedArea(m)) {
      return {
        mode,
        shared: true,
        restricted: true,
        region,
        landmark: 'Restricted area',
        locationId: null,
        exact: null,
      };
    }
    const entry = lookupPlace(loc);
    const landmark = placeNameOf(loc, lookupPlace);
    const locationId = parseLocationId(loc) ? loc : null;
    const exact = mode === 'exact'
      ? {
          x: r3(m.x),
          z: r3(m.z),
          ...(entry ? { mapX: entry.x | 0, mapY: entry.y | 0 } : {}),
        }
      : null;
    return {
      mode,
      shared: true,
      restricted: false,
      region,
      landmark,
      locationId,
      exact,
    };
  }

  function setLocationSharing(p, args = {}) {
    const party = partyOfPlayer(p);
    if (!party) throw new Error('Join a party first.');
    const mode = SHARE_MODES.includes(args.mode) ? args.mode : null;
    if (!mode) throw new Error('Choose location sharing mode: off, coarse, or exact.');
    const d = ensurePartyData(party.id);
    d.sharing.set(p.id, mode);
    const label = mode === 'exact' ? 'exact pins' : mode === 'coarse' ? 'coarse region & landmark' : 'hidden';
    pushParty(party, `${p.name} set party location sharing to ${label}.`, p.id);
    push(p, `Party location sharing set to ${label}.`);
    return { mode };
  }

  function sendPing(p, args = {}) {
    const party = partyOfPlayer(p);
    if (!party) throw new Error('Join a party to place map pings.');
    if (!pingLimiter(p.id)()) throw new Error('Slow down before sending another map ping.');
    const d = ensurePartyData(party.id);
    const label = cleanStr(args.label ?? '', 48) || 'Rally Point';
    const note = cleanStr(args.note ?? '', 120);
    const t = now();
    const ttl = ctx.config?.partyPingTtlMs ?? PING_TTL_MS;

    let region = regionOf(locationOf(p), ctx);
    let location = null;
    let landmark = null;
    let exact = null;

    if (typeof args.location === 'string' && args.location.trim()) {
      const entry = lookupPlace(args.location.trim());
      if (!entry) throw new Error('That map destination could not be found.');
      if (isMantellan(entry.regionIndex, entry.index) || entry.type === 'ships' || ctx.services?.property?.isShipLocation?.(entry.id)) {
        throw new Error('You cannot ping a restricted location.');
      }
      location = entry.id;
      region = entry.region || regionOf(entry.id, ctx);
      landmark = String(entry.name ?? '').trim();
      if (Number.isFinite(args.mapX) && Number.isFinite(args.mapY)) {
        exact = { mapX: Math.trunc(args.mapX), mapY: Math.trunc(args.mapY) };
      } else {
        exact = { mapX: entry.x | 0, mapY: entry.y | 0 };
      }
    } else {
      const loc = locationOf(p);
      const restricted = isRestrictedArea(p);
      const mode = shareModeOf(party.id, p.id);
      if (restricted) {
        landmark = 'Restricted area';
      } else {
        location = parseLocationId(loc) ? loc : null;
        landmark = placeNameOf(loc, lookupPlace);
        const entry = lookupPlace(loc);
        if (mode === 'exact') {
          const px = Number.isFinite(args.x) ? r3(args.x) : r3(p.x);
          const pz = Number.isFinite(args.z) ? r3(args.z) : r3(p.z);
          exact = {
            x: px,
            z: pz,
            ...(entry ? { mapX: entry.x | 0, mapY: entry.y | 0 } : {}),
          };
        }
      }
    }

    const ping = {
      id: newId('ping_'),
      fromId: p.id,
      fromName: p.name,
      label,
      note,
      region,
      landmark,
      location,
      exact,
      createdAt: t,
      wallCreatedAt: wallNow(),
      expiresAt: t + ttl,
    };
    d.pings = d.pings.filter((x) => x.expiresAt > t);
    d.pings.push(ping);
    if (d.pings.length > MAX_PINGS) d.pings.splice(0, d.pings.length - MAX_PINGS);

    const summary = `${p.name} pinged ${label}${landmark ? ` (${landmark})` : ''}${note ? `: ${note}` : ''}.`;
    for (const mid of party.members.keys()) {
      const m = online(mid);
      if (m) push(m, summary, { partyPing: ping });
    }
    return ping;
  }

  function isDiscoveredFor(m, entry) {
    if (entry.discovered) return true;
    const t = m?.rpg?.travel;
    if (!t || typeof t !== 'object') return false;
    const found = normalizeFound(t.found);
    if (hasFound(found, entry)) return true;
    return Array.isArray(t.discovered) && t.discovered.includes(entry.id);
  }

  function transportOf(m) {
    const inv = Array.isArray(m?.rpg?.inventory) ? m.rpg.inventory : [];
    const has = (re) => inv.some((it) => it && typeof it.template === 'string' && re.test(it.template));
    if (has(/^horse$/)) return 'horse';
    if (has(/^(small-)?cart$/)) return 'cart';
    return 'foot';
  }

  function resolveDestinationEntry(destId) {
    if (typeof destId !== 'string' || !destId) throw new Error('Choose a travel destination.');
    if (!parseLocationId(destId)) throw new Error('Group travel requires an exterior town or landmark.');
    const entry = lookupPlace(destId);
    if (!entry) throw new Error('That destination is not on the world map.');
    if (isMantellan(entry.regionIndex, entry.index)) {
      throw new Error('The Mantellan Crux cannot be reached by group travel.');
    }
    if (entry.type === 'ships' || ctx.services?.property?.isShipLocation?.(entry.id)) {
      throw new Error('Ships cannot be selected for group travel.');
    }
    return entry;
  }

  function resolveTargetDestination(party, rawTo) {
    if (typeof rawTo === 'string' && rawTo.trim()) {
      return resolveDestinationEntry(rawTo.trim());
    }
    const leader = online(party.leaderId);
    if (!leader) throw new Error('The party leader is offline. Choose a destination explicitly.');
    if (isRestrictedArea(leader)) {
      throw new Error('The party leader is in a restricted or interior area and cannot be travelled to directly.');
    }
    const loc = locationOf(leader);
    if (!parseLocationId(loc)) {
      throw new Error('The party leader is not at a map landmark.');
    }
    return resolveDestinationEntry(loc);
  }

  function quoteForMember(m, destEntry, rawOptions) {
    if (!m) {
      return {
        id: null,
        eligible: false,
        alreadyThere: false,
        reason: 'Offline',
        cost: 0,
        days: 0,
        minutes: 0,
        transport: 'foot',
        options: normalizeOptions(rawOptions),
        route: null,
      };
    }
    const from = locationOf(m);
    const options = normalizeOptions(rawOptions ?? m.rpg?.travel?.options);
    if (from === destEntry.id) {
      return {
        id: m.id,
        name: m.name,
        from,
        to: destEntry.id,
        eligible: true,
        alreadyThere: true,
        reason: null,
        cost: 0,
        days: 0,
        minutes: 0,
        transport: transportOf(m),
        options,
        route: null,
      };
    }
    if (ctx.services?.sailing?.aboard?.(m)) {
      return { id: m.id, name: m.name, from, to: destEntry.id, eligible: false, alreadyThere: false, reason: 'Aboard a ship', cost: 0, days: 0, minutes: 0, transport: 'foot', options, route: null };
    }
    const fromTown = parseLocationId(from);
    if (!fromTown && !wildernessOrigin(from)) {
      return { id: m.id, name: m.name, from, to: destEntry.id, eligible: false, alreadyThere: false, reason: 'Must step outside first', cost: 0, days: 0, minutes: 0, transport: transportOf(m), options, route: null };
    }
    if (ctx.services?.enemiesNearby?.(m)) {
      return { id: m.id, name: m.name, from, to: destEntry.id, eligible: false, alreadyThere: false, reason: 'Enemies nearby', cost: 0, days: 0, minutes: 0, transport: transportOf(m), options, route: null };
    }
    const prevented = ctx.services?.travelPrevented?.(m);
    if (prevented) {
      return { id: m.id, name: m.name, from, to: destEntry.id, eligible: false, alreadyThere: false, reason: String(prevented), cost: 0, days: 0, minutes: 0, transport: transportOf(m), options, route: null };
    }

    let q;
    try {
      if (typeof ctx.services?.travel?.quote === 'function') {
        q = ctx.services.travel.quote(m, destEntry.id, options);
      } else {
        if (!isDiscoveredFor(m, destEntry)) {
          throw new Error(`Has not discovered ${String(destEntry.name).trim()}`);
        }
        const origin = lookupPlace(from) ?? lookupPlace(m.rpg?.travel?.lastTown) ?? destEntry;
        q = quoteJourney(origin, destEntry, options, {
          transport: transportOf(m),
          freePassage: hasFreeShipPassage(m.rpg) || ctx.services?.property?.ownsShip?.(m) === true,
        });
      }
    } catch (err) {
      return {
        id: m.id,
        name: m.name,
        from,
        to: destEntry.id,
        eligible: false,
        alreadyThere: false,
        reason: err?.message || 'Cannot travel to this destination',
        cost: 0,
        days: 0,
        minutes: 0,
        transport: transportOf(m),
        options,
        route: null,
      };
    }

    const fare = q.cost?.total ?? 0;
    const gold = goldOf(m.rpg);
    const origin = lookupPlace(from) ?? lookupPlace(m.rpg?.travel?.lastTown) ?? destEntry;
    const place = (e) => ({ x: e.x | 0, y: e.y | 0, name: String(e.name ?? '').trim().slice(0, 64), region: String(e.region ?? '').slice(0, 64) });
    const route = { from: place(origin), to: place(destEntry) };

    if (fare > gold) {
      return {
        id: m.id,
        name: m.name,
        from,
        to: destEntry.id,
        eligible: false,
        alreadyThere: false,
        reason: `Needs ${fare} gold (short ${fare - gold} gp)`,
        cost: fare,
        days: q.days,
        minutes: q.minutes,
        transport: q.transport,
        options: q.options,
        route,
      };
    }

    return {
      id: m.id,
      name: m.name,
      from,
      to: destEntry.id,
      eligible: true,
      alreadyThere: false,
      reason: null,
      cost: fare,
      days: q.days,
      minutes: q.minutes,
      transport: q.transport,
      options: q.options,
      route,
    };
  }

  function quoteFingerprint(q) {
    return JSON.stringify([q.from, q.to, q.eligible, q.alreadyThere, q.reason, q.cost, q.days, q.minutes, q.options]);
  }

  function quoteToLeader(p, args = {}) {
    const party = partyOfPlayer(p);
    if (!party) throw new Error('Join a party first.');
    const destEntry = resolveTargetDestination(party, args.to);
    const myQuote = quoteForMember(p, destEntry, args.options);
    const members = [];
    for (const [mid, rec] of party.members) {
      const m = online(mid);
      const q = m ? quoteForMember(m, destEntry, mid === p.id ? args.options : m.rpg?.travel?.options) : null;
      members.push({
        id: mid,
        name: m?.name ?? rec.name,
        online: Boolean(m),
        eligible: q ? q.eligible : false,
        alreadyThere: q ? q.alreadyThere : false,
        reason: q ? q.reason : 'Offline',
        cost: q ? q.cost : 0,
        days: q ? q.days : 0,
      });
    }
    return {
      to: destEntry.id,
      destinationName: String(destEntry.name ?? '').trim(),
      destinationRegion: String(destEntry.region ?? ''),
      leaderId: party.leaderId,
      mine: myQuote,
      members,
    };
  }

  function proposalView(proposal, viewer) {
    if (!proposal) return null;
    const participants = [];
    for (const part of proposal.participants.values()) {
      const isViewer = viewer && part.id === viewer.id;
      participants.push({
        id: part.id,
        name: part.name,
        status: part.status,
        confirmed: part.status === 'ready' && part.confirmedRevision === proposal.revision,
        eligible: part.quote.eligible,
        alreadyThere: part.quote.alreadyThere,
        reason: part.quote.reason,
        cost: part.quote.cost,
        days: part.quote.days,
        minutes: part.quote.minutes,
        transport: part.quote.transport,
        options: part.quote.options,
        ...(isViewer ? { route: part.quote.route, from: part.quote.from } : {}),
      });
    }
    const remainingMs = Math.max(0, Math.round(proposal.expiresAt - now()));
    return {
      id: proposal.id,
      revision: proposal.revision,
      proposerId: proposal.proposerId,
      proposerName: proposal.proposerName,
      to: proposal.to,
      destinationName: proposal.destinationName,
      destinationRegion: proposal.destinationRegion,
      options: proposal.options,
      createdAt: proposal.wallCreatedAt ?? wallNow(),
      expiresAt: wallNow() + remainingMs,
      remainingMs,
      notice: proposal.notice,
      participants,
    };
  }

  function bumpProposal(proposal, notice) {
    proposal.revision += 1;
    proposal.notice = notice;
    for (const part of proposal.participants.values()) {
      part.status = 'pending';
      part.confirmedRevision = 0;
    }
  }

  /**
   * Re-quotes every named participant against live state. Returns a list of human-readable changes;
   * if non-empty, bumps revision and clears all confirmations so the party reviews the updated proposal.
   */
  function revalidateProposal(party, proposal) {
    const destEntry = lookupPlace(proposal.to);
    if (!destEntry) return ['Destination is no longer available'];
    const changes = [];
    for (const [mid, part] of [...proposal.participants]) {
      if (!party.members.has(mid)) {
        proposal.participants.delete(mid);
        changes.push(`${part.name} left the party`);
        continue;
      }
      const m = online(mid);
      if (!m) {
        proposal.participants.delete(mid);
        changes.push(`${part.name} went offline`);
        continue;
      }
      const fresh = quoteForMember(m, destEntry, part.options);
      const nextFp = quoteFingerprint(fresh);
      if (nextFp !== part.fingerprint) {
        if (part.quote.eligible && !fresh.eligible) {
          changes.push(`${m.name} is no longer eligible (${fresh.reason})`);
        } else if (part.quote.cost !== fresh.cost) {
          changes.push(`${m.name}'s fare changed from ${part.quote.cost} to ${fresh.cost} gold`);
        } else if (part.quote.from !== fresh.from) {
          changes.push(`${m.name} moved to a different location`);
        } else {
          changes.push(`${m.name}'s travel quote updated`);
        }
        part.quote = fresh;
        part.fingerprint = nextFp;
        part.name = m.name;
      }
    }
    if (changes.length) {
      bumpProposal(proposal, `Proposal updated: ${changes.join('; ')}. Please review and confirm again.`);
    }
    return changes;
  }

  function proposeTravel(p, args = {}) {
    const party = partyOfPlayer(p);
    if (!party) throw new Error('Join a party first.');
    const destEntry = resolveTargetDestination(party, args.to);
    const d = ensurePartyData(party.id);
    const defaultOpts = normalizeOptions(args.options ?? p.rpg?.travel?.options);

    let participantIds;
    if (Array.isArray(args.participantIds) && args.participantIds.length) {
      participantIds = [...new Set(args.participantIds.map((x) => Number(x)).filter((id) => Number.isSafeInteger(id) && party.members.has(id) && online(id)))];
      if (!participantIds.includes(p.id)) participantIds.unshift(p.id);
    } else {
      participantIds = [...party.members.keys()].filter((id) => online(id));
    }

    if (!participantIds.length) throw new Error('No online party members can join this journey.');

    const participants = new Map();
    let anyTraveler = false;
    for (const id of participantIds) {
      const m = online(id);
      if (!m) continue;
      const quote = quoteForMember(m, destEntry, defaultOpts);
      if (!quote.alreadyThere) anyTraveler = true;
      participants.set(id, {
        id,
        name: m.name,
        status: 'pending',
        confirmedRevision: 0,
        options: quote.options,
        quote,
        fingerprint: quoteFingerprint(quote),
      });
    }
    if (!anyTraveler) {
      throw new Error(`Everyone selected is already in ${String(destEntry.name).trim()}.`);
    }

    const t = now();
    const ttl = ctx.config?.partyReadyCheckTtlMs ?? READY_CHECK_TTL_MS;
    const proposal = {
      id: newId('ptrip_'),
      revision: 1,
      proposerId: p.id,
      proposerName: p.name,
      to: destEntry.id,
      destinationName: String(destEntry.name ?? '').trim(),
      destinationRegion: String(destEntry.region ?? ''),
      options: defaultOpts,
      createdAt: t,
      wallCreatedAt: wallNow(),
      expiresAt: t + ttl,
      notice: null,
      participants,
    };

    // Proposer can opt into auto-confirming their own slot if eligible, when more than one member must confirm.
    const proposerPart = participants.get(p.id);
    if (args.autoReady !== false && proposerPart && proposerPart.quote.eligible && participants.size > 1) {
      proposerPart.status = 'ready';
      proposerPart.confirmedRevision = 1;
    }

    d.proposal = proposal;
    const text = `${p.name} proposed group travel to ${proposal.destinationName} (${proposal.destinationRegion}). Review your quote and confirm ready.`;
    for (const mid of party.members.keys()) {
      const m = online(mid);
      if (m) push(m, text, { partyTravelProposal: proposalView(proposal, m) });
    }
    return proposal;
  }

  function commitGroupTravel(party, d, proposal) {
    const destEntry = resolveDestinationEntry(proposal.to);
    const travelers = [];
    for (const part of proposal.participants.values()) {
      const m = online(part.id);
      if (!m || !party.members.has(part.id)) {
        bumpProposal(proposal, `${part.name} is no longer available; group travel returned to proposal.`);
        return { committed: false, reason: proposal.notice };
      }
      const liveQuote = quoteForMember(m, destEntry, part.options);
      if (!liveQuote.eligible || liveQuote.cost !== part.quote.cost || liveQuote.from !== part.quote.from) {
        part.quote = liveQuote;
        part.fingerprint = quoteFingerprint(liveQuote);
        bumpProposal(proposal, `${m.name}'s travel eligibility or fare changed (${liveQuote.reason ?? `${liveQuote.cost} gp`}); review and confirm again.`);
        return { committed: false, reason: proposal.notice };
      }
      if (!liveQuote.alreadyThere) {
        travelers.push({ player: m, quote: liveQuote });
      }
    }

    if (!travelers.length) {
      d.proposal = null;
      return { committed: true, movedIds: [] };
    }

    // Mark every travelling player dirty BEFORE mutating so runtime saves all in one transaction.
    const snaps = new Map();
    for (const { player: m } of travelers) {
      dirty(m);
      snaps.set(m, captureTraveler(m));
    }

    const tripEvents = [];
    try {
      for (const { player: m, quote: q } of travelers) {
        const t = m.rpg.travel && typeof m.rpg.travel === 'object' ? m.rpg.travel : (m.rpg.travel = {});
        if (!t.positions || typeof t.positions !== 'object') t.positions = {};
        if (!Array.isArray(t.discovered)) t.discovered = [];
        if (!Number.isInteger(t.trips)) t.trips = 0;
        if (!Number.isInteger(t.daysOnRoad)) t.daysOnRoad = 0;

        if (q.cost > 0) {
          if (typeof ctx.services?.takeItem === 'function') ctx.services.takeItem(m, 'gold', q.cost);
          else {
            const g = goldOf(m.rpg);
            if (g < q.cost) throw new Error(`${m.name} does not have enough gold.`);
            m.rpg.gold = g - q.cost;
          }
        }
        const from = q.from;
        if (parseLocationId(from)) {
          t.positions[from] = { x: r3(m.x), z: r3(m.z), yaw: r3(m.yaw) };
        }
        const back = t.positions[destEntry.id];
        m.rpg.location = destEntry.id;
        t.lastTown = destEntry.id;
        t.options = q.options;
        t.trips += 1;
        t.daysOnRoad += q.days;
        t.lastTrip = {
          from,
          to: destEntry.id,
          days: q.days,
          minutes: q.minutes,
          cost: q.cost,
          options: q.options,
          transport: q.transport,
          at: now(),
          n: t.trips,
          route: q.route,
          mounted: ctx.services?.mount?.isRiding?.(m) === true,
          showMs: presentationMs(q.days),
          groupTravel: true,
        };
        if (q.options.speed === 'cautious') {
          const c = m.rpg.character;
          if (c && typeof c === 'object') {
            for (const [cur, max] of [['health', 'maxHealth'], ['fatigue', 'maxFatigue'], ['magicka', 'maxMagicka']]) {
              if (Number.isFinite(c[max]) && Number.isFinite(c[cur])) c[cur] = c[max];
            }
          }
        }
        m.x = back ? back.x : 0;
        m.z = back ? back.z : 0;
        m.yaw = back ? back.yaw : 0;
        m.forward = 0;
        m.strafe = 0;
        m.moving = false;
        ctx.services?.spendTime?.(m, q.minutes, 'travel');
        tripEvents.push({
          player: m,
          from,
          event: {
            kind: 'travel',
            from,
            to: destEntry.id,
            name: proposal.destinationName,
            region: proposal.destinationRegion,
            days: q.days,
            minutes: q.minutes,
            cost: q.cost,
            transport: q.transport,
            options: q.options,
            mounted: t.lastTrip.mounted,
            route: q.route,
            showMs: t.lastTrip.showMs,
            trip: t.trips,
            groupTravel: true,
            silent: !!q.route,
            text: `Your party arrives in ${proposal.destinationName} after ${q.days} day${q.days === 1 ? '' : 's'} (${q.cost} gold spent).`,
          },
        });
      }
    } catch (err) {
      for (const [m, snap] of snaps) restoreTraveler(m, snap);
      throw err;
    }

    d.proposal = null;
    for (const { player: m, from, event } of tripEvents) {
      ctx.notify(m, event);
      ctx.emit?.('travel', { player: m, from, to: destEntry.id, groupTravel: true });
    }
    ctx.emit?.('partyTravel', {
      partyId: party.id,
      to: destEntry.id,
      movedIds: travelers.map((x) => x.player.id),
    });
    for (const mid of party.members.keys()) {
      const m = online(mid);
      if (m) push(m, `Group travel complete: arrived in ${proposal.destinationName}.`);
    }
    return { committed: true, movedIds: travelers.map((x) => x.player.id) };
  }

  function respondTravel(p, args = {}) {
    const party = partyOfPlayer(p);
    if (!party) throw new Error('You are not in a party.');
    const d = partyData.get(party.id);
    const proposal = d?.proposal;
    if (!proposal || (args.proposalId && String(args.proposalId) !== proposal.id)) {
      throw new Error('There is no active party travel ready check.');
    }
    if (now() > proposal.expiresAt) {
      d.proposal = null;
      pushParty(party, 'The party travel ready check expired.');
      throw new Error('That party travel ready check has expired.');
    }
    const part = proposal.participants.get(p.id);
    if (!part) throw new Error('You are not listed in this travel proposal.');

    const response = String(args.response ?? '').toLowerCase();
    if (response === 'decline') {
      d.proposal = null;
      const msg = `${p.name} declined the group travel to ${proposal.destinationName}.`;
      for (const mid of party.members.keys()) {
        const m = online(mid);
        if (m) push(m, msg);
      }
      return { committed: false, cancelled: true };
    }

    if (response === 'opt_out') {
      proposal.participants.delete(p.id);
      const remainingTravelers = [...proposal.participants.values()].filter((x) => !x.quote.alreadyThere);
      if (!proposal.participants.size || !remainingTravelers.length) {
        d.proposal = null;
        for (const mid of party.members.keys()) {
          const m = online(mid);
          if (m) push(m, `${p.name} opted out; group travel proposal closed.`);
        }
        return { committed: false, cancelled: true };
      }
      bumpProposal(proposal, `${p.name} opted out of group travel. Review the updated proposal and confirm.`);
      for (const mid of party.members.keys()) {
        const m = online(mid);
        if (m) push(m, proposal.notice);
      }
      return { committed: false, updated: true };
    }

    if (response !== 'ready') throw new Error('Respond with ready, opt_out, or decline.');

    if (args.revision !== undefined && Number(args.revision) !== proposal.revision) {
      throw new Error('The travel proposal changed; review the updated quote and confirm again.');
    }

    // Apply per-member option changes (speed/lodging/ship) before revalidating.
    if (args.options && typeof args.options === 'object') {
      const nextOpts = normalizeOptions(args.options);
      if (JSON.stringify(nextOpts) !== JSON.stringify(part.options)) {
        const destEntry = resolveDestinationEntry(proposal.to);
        part.options = nextOpts;
        part.quote = quoteForMember(p, destEntry, nextOpts);
        part.fingerprint = quoteFingerprint(part.quote);
        if (args.expectCost !== undefined && Number(args.expectCost) !== part.quote.cost) {
          bumpProposal(proposal, `${p.name}'s fare updated to ${part.quote.cost} gold; confirm again.`);
          for (const mid of party.members.keys()) push(online(mid), proposal.notice);
          return { committed: false, updated: true };
        }
      }
    }

    // Re-check all participants against live state before confirming/committing.
    const changes = revalidateProposal(party, proposal);
    if (changes.length) {
      const remainingTravelers = [...proposal.participants.values()].filter((x) => !x.quote.alreadyThere);
      if (!proposal.participants.size || !remainingTravelers.length) {
        d.proposal = null;
        for (const mid of party.members.keys()) push(online(mid), 'Group travel proposal cancelled because no travellers remain.');
        return { committed: false, cancelled: true };
      }
      for (const mid of party.members.keys()) push(online(mid), proposal.notice);
      return { committed: false, updated: true, notice: proposal.notice };
    }

    if (args.expectCost !== undefined && Number(args.expectCost) !== part.quote.cost) {
      throw new Error(`Your fare is ${part.quote.cost} gold. Review and confirm again.`);
    }
    if (!part.quote.eligible) {
      throw new Error(part.quote.reason || 'You are not currently eligible to travel.');
    }

    part.status = 'ready';
    part.confirmedRevision = proposal.revision;

    const allReady = [...proposal.participants.values()].every((x) => x.status === 'ready' && x.confirmedRevision === proposal.revision);
    if (!allReady) {
      for (const mid of party.members.keys()) {
        const m = online(mid);
        if (m) push(m, mid === p.id ? 'Marked ready for group travel.' : `${p.name} is ready for group travel.`);
      }
      return { committed: false, waiting: true };
    }

    const res = commitGroupTravel(party, d, proposal);
    if (!res.committed) {
      for (const mid of party.members.keys()) push(online(mid), res.reason);
    }
    return res;
  }

  function cancelTravel(p, args = {}) {
    const party = partyOfPlayer(p);
    if (!party) throw new Error('You are not in a party.');
    const d = partyData.get(party.id);
    const proposal = d?.proposal;
    if (!proposal || (args.proposalId && String(args.proposalId) !== proposal.id)) {
      throw new Error('There is no active party travel ready check.');
    }
    if (proposal.proposerId !== p.id && party.leaderId !== p.id) {
      throw new Error('Only the proposer or party leader can cancel the ready check.');
    }
    d.proposal = null;
    for (const mid of party.members.keys()) {
      const m = online(mid);
      if (m) push(m, `${p.name} cancelled the group travel ready check.`);
    }
    return { cancelled: true };
  }

  function handleMemberDropped(party, droppedId, droppedName, verb = 'disconnected') {
    if (!party) return;
    const d = partyData.get(party.id);
    if (!d?.proposal) return;
    const proposal = d.proposal;
    if (!proposal.participants.has(droppedId)) return;
    proposal.participants.delete(droppedId);
    const remainingTravelers = [...proposal.participants.values()].filter((x) => !x.quote.alreadyThere);
    if (!proposal.participants.size || !remainingTravelers.length) {
      d.proposal = null;
      for (const mid of party.members.keys()) {
        if (mid === droppedId) continue;
        push(online(mid), `${droppedName} ${verb}; group travel ready check was cancelled.`);
      }
      return;
    }
    bumpProposal(proposal, `${droppedName} ${verb}; ready check updated and needs re-confirmation.`);
    for (const mid of party.members.keys()) {
      if (mid === droppedId) continue;
      push(online(mid), proposal.notice);
    }
  }

  function onPartyDisbanded(partyId) {
    partyData.delete(partyId);
  }

  function tick(parties) {
    const t = now();
    for (const [partyId, d] of [...partyData]) {
      const party = parties.get(partyId);
      if (!party) {
        partyData.delete(partyId);
        continue;
      }
      const beforePings = d.pings.length;
      if (beforePings) {
        d.pings = d.pings.filter((x) => x.expiresAt > t);
        if (d.pings.length !== beforePings) {
          for (const mid of party.members.keys()) push(online(mid));
        }
      }
      if (d.proposal) {
        if (t > d.proposal.expiresAt) {
          const dest = d.proposal.destinationName;
          d.proposal = null;
          for (const mid of party.members.keys()) push(online(mid), `The group travel ready check to ${dest} expired.`);
        } else {
          const changes = revalidateProposal(party, d.proposal);
          if (changes.length) {
            const remaining = [...d.proposal.participants.values()].filter((x) => !x.quote.alreadyThere);
            if (!d.proposal.participants.size || !remaining.length) {
              d.proposal = null;
              for (const mid of party.members.keys()) push(online(mid), 'Group travel ready check cancelled.');
            } else {
              for (const mid of party.members.keys()) push(online(mid), d.proposal.notice);
            }
          }
        }
      }
    }
  }

  function partyExtraView(party, viewer) {
    if (!party) return null;
    const d = partyData.get(party.id);
    const t = now();
    const pings = d ? d.pings.filter((x) => x.expiresAt > t) : [];
    const leaderOnline = online(party.leaderId);
    const leaderLoc = leaderOnline && !isRestrictedArea(leaderOnline) && parseLocationId(locationOf(leaderOnline))
      ? locationOf(leaderOnline)
      : null;
    return {
      myLocationSharing: viewer ? shareModeOf(party.id, viewer.id) : 'coarse',
      pings,
      travelProposal: d?.proposal ? proposalView(d.proposal, viewer) : null,
      leaderDestination: leaderLoc ? { id: leaderLoc, name: placeNameOf(leaderLoc, lookupPlace), region: regionOf(leaderLoc, ctx) } : null,
    };
  }

  function capture() {
    return structuredClone(partyData);
  }

  function restore(saved) {
    partyData.clear();
    for (const [k, v] of saved) partyData.set(k, v);
  }

  return {
    partyData,
    isRestrictedArea,
    memberLocationView,
    setLocationSharing,
    sendPing,
    quoteToLeader,
    proposeTravel,
    respondTravel,
    cancelTravel,
    handleMemberDropped,
    onPartyDisbanded,
    tick,
    partyExtraView,
    capture,
    restore,
  };
}
