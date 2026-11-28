// Participating town market boards, location/region helpers, proximity checks,
// and the House Trader access adapter (integrates with `ctx.services.homes?.verifyTraderAccess`
// when installed, with a clean fallback adapter over `rpg.property.houses` & registered traders).
import { MarketError } from './config.js';

export const FEATURED_BOARDS = Object.freeze([
  { id: 'board:daggerfall/gothway-garden', location: 'town:Daggerfall/Gothway Garden', region: 'Daggerfall', town: 'Gothway Garden', label: 'Gothway Garden Market Board', x: 0, z: 0 },
  { id: 'board:daggerfall/daggerfall', location: 'town:Daggerfall/Daggerfall', region: 'Daggerfall', town: 'Daggerfall', label: 'Daggerfall City Exchange Board', x: 0, z: 0 },
  { id: 'board:wayrest/wayrest', location: 'town:Wayrest/Wayrest', region: 'Wayrest', town: 'Wayrest', label: 'Wayrest Grand Market Board', x: 0, z: 0 },
  { id: 'board:sentinel/sentinel', location: 'town:Sentinel/Sentinel', region: 'Sentinel', town: 'Sentinel', label: 'Sentinel Bazaar Board', x: 0, z: 0 },
  { id: 'board:anticlere/anticlere', location: 'town:Anticlere/Anticlere', region: 'Anticlere', town: 'Anticlere', label: 'Anticlere Trade Board', x: 0, z: 0 },
  { id: 'board:betony/betony', location: 'town:Betony/Betony', region: 'Betony', town: 'Betony', label: 'Betony Quay Market Board', x: 0, z: 0 },
]);

const FEATURED_BY_LOC = new Map(FEATURED_BOARDS.map((b) => [b.location.toLowerCase(), b]));

export function parseLocationMeta(location) {
  const loc = typeof location === 'string' ? location.trim() : '';
  const m = /^(town|interior|dungeon|wild|wilderness|sea):([^/]+)(?:\/(.+))?$/.exec(loc);
  if (!m) return { kind: 'unknown', region: 'Iliac Bay', town: loc || 'Unknown', location: loc };
  const [, kind, region, rest = ''] = m;
  const town = rest.split('/')[0] || region;
  return { kind, region, town, location: loc };
}

/**
 * Resolves the market board for a town location, or null when the location is not a participating town.
 */
export function boardForLocation(location, customBoards = null) {
  const meta = parseLocationMeta(location);
  if (meta.kind !== 'town') return null;
  if (customBoards && customBoards.has(meta.location)) return customBoards.get(meta.location);
  const featured = FEATURED_BY_LOC.get(meta.location.toLowerCase());
  if (featured) return { ...featured };
  const slug = `${meta.region}/${meta.town}`.toLowerCase().replace(/[^a-z0-9/]+/g, '-');
  return {
    id: `board:${slug}`,
    location: meta.location,
    region: meta.region,
    town: meta.town,
    label: `${meta.town} Market Board`,
    x: 0,
    z: 0,
  };
}

/**
 * Validates that a player is standing within reach of a participating town market board.
 */
export function assertNearMarketBoard(player, cfg, { customBoards = null, skipProximity = false } = {}) {
  const loc = player?.rpg?.location;
  const board = boardForLocation(loc, customBoards);
  if (!board) {
    throw new MarketError('BOARD_UNAVAILABLE', 'Visit a town market board to use the player market.');
  }
  if (!skipProximity && !cfg.skipProximityCheck) {
    const px = Number.isFinite(player?.x) ? player.x : 0;
    const pz = Number.isFinite(player?.z) ? player.z : 0;
    const dist = Math.hypot(px - board.x, pz - board.z);
    if (dist > cfg.boardReach) {
      throw new MarketError(
        'BOARD_OUT_OF_RANGE',
        `Move closer to ${board.label} (${Math.ceil(dist)} m away, reach ${cfg.boardReach} m).`,
      );
    }
  }
  return board;
}

/**
 * Verifies House Trader access via `ctx.services.homes?.verifyTraderAccess` when installed,
 * falling back to registered house traders or `rpg.property.houses` deeds.
 *
 * @param {object} ctx
 * @param {object} actor
 * @param {{ houseId?: string, traderId?: string, mode: 'manage'|'browse'|'buy' }} req
 * @param {Map<string, object>} fallbackTraders
 */
export async function verifyHouseTraderAccess(ctx, actor, req, fallbackTraders) {
  const mode = req?.mode || 'browse';
  const houseId = typeof req?.houseId === 'string' && req.houseId.trim() ? req.houseId.trim() : null;
  const traderId = typeof req?.traderId === 'string' && req.traderId.trim() ? req.traderId.trim() : null;

  if (!houseId && !traderId) {
    throw new MarketError('INVALID_TRADER', 'Specify a house trader.');
  }

  // Primary integration point: Wave 2 `homes` service.
  if (typeof ctx?.services?.homes?.verifyTraderAccess === 'function') {
    const res = await Promise.resolve(ctx.services.homes.verifyTraderAccess(actor, { houseId, traderId, mode }));
    if (!res || res.ok !== true) {
      throw new MarketError(
        res?.code || 'TRADER_ACCESS_DENIED',
        res?.reason || 'You do not have access to this house trader.',
      );
    }
    return {
      houseId: String(res.houseId ?? houseId ?? traderId),
      traderId: String(res.traderId ?? traderId ?? houseId),
      ownerCharacterId: Number(res.ownerCharacterId ?? actor?.id),
      ownerAccountId: res.ownerAccountId != null ? String(res.ownerAccountId) : null,
      location: String(res.location ?? actor?.rpg?.location ?? ''),
      region: String(res.region ?? parseLocationMeta(res.location ?? actor?.rpg?.location).region),
      town: String(res.town ?? parseLocationMeta(res.location ?? actor?.rpg?.location).town),
      label: String(res.label || 'House Trader'),
    };
  }

  // Fallback adapter 1: explicitly registered house traders (used standalone or before Wave 2B wiring).
  const key = traderId || houseId;
  const registered = fallbackTraders?.get(key)
    || (houseId ? [...(fallbackTraders?.values() ?? [])].find((t) => t.houseId === houseId) : null);
  if (registered) {
    if (registered.revoked) {
      throw new MarketError('TRADER_REVOKED', 'That house trader is no longer active.');
    }
    const actorId = Number(actor?.id);
    const isOwner = Number(registered.ownerCharacterId) === actorId;
    if (mode === 'manage' && !isOwner) {
      throw new MarketError('TRADER_NOT_OWNER', 'Only the home owner can manage this house trader.');
    }
    if (mode !== 'manage' && !isOwner) {
      const access = registered.access || 'public';
      const guests = Array.isArray(registered.guests) ? registered.guests.map(Number) : [];
      if (access === 'private') {
        throw new MarketError('TRADER_ACCESS_DENIED', 'This house trader is currently private.');
      }
      if (access === 'guests' && !guests.includes(actorId)) {
        throw new MarketError('TRADER_ACCESS_DENIED', 'You must be an invited guest to trade with this house vendor.');
      }
    }
    return {
      houseId: registered.houseId,
      traderId: registered.traderId,
      ownerCharacterId: Number(registered.ownerCharacterId),
      ownerAccountId: registered.ownerAccountId != null ? String(registered.ownerAccountId) : null,
      location: registered.location || '',
      region: registered.region || parseLocationMeta(registered.location).region,
      town: registered.town || parseLocationMeta(registered.location).town,
      label: registered.label || 'House Trader',
    };
  }

  // Fallback adapter 2: classic `rpg.property.houses` deeds owned by the actor.
  const houses = actor?.rpg?.property?.houses;
  if (houses && typeof houses === 'object') {
    for (const [rk, h] of Object.entries(houses)) {
      if (!h || typeof h !== 'object') continue;
      const hid = h.buildingId || h.interior || rk;
      const tid = `trader:${hid}`;
      if (houseId === hid || houseId === h.interior || houseId === rk || traderId === tid || traderId === hid) {
        return {
          houseId: String(hid),
          traderId: String(traderId || tid),
          ownerCharacterId: Number(actor.id),
          ownerAccountId: actor.accountId != null ? String(actor.accountId) : null,
          location: String(h.interior || h.town || actor.rpg?.location || ''),
          region: String(h.region || parseLocationMeta(h.town).region),
          town: String(parseLocationMeta(h.town).town || h.region || 'Town'),
          label: `${actor.name || 'Owner'}'s House Trader`,
        };
      }
    }
  }

  throw new MarketError('TRADER_NOT_FOUND', 'House trader not found or inaccessible.');
}
