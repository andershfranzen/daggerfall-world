// Reading an ordinary map item (classic template 287: ItemGroups.Maps/Map and ItemGroups.MiscItems/Map).
//
// Daggerfall Unity DaggerfallInventoryWindow.RecordLocationFromMap (MIT, Daggerfall Workshop):
//   - PlayerGPS.DiscoverRandomLocation reveals one random place of the current region that is neither flagged
//     discovered in MAPTABLE nor already known to the character (server/rpg/travel.js discoverRandomLocation);
//   - the notebook gets "Discovered the location of %map after studying a map." (Internal_Strings readMap);
//   - a random variant of TEXT.RSC 499 is shown, with %map the revealed place;
//   - when the region holds nothing more to find, "You have already discovered the location shown by this map."
//     (readMapFail). Either way the map is used up.
// This server adds one case the classic game cannot have: when the installed world map is not available (still
// being read, or not installed), nothing is revealed and the map is kept.
//
// Everything changes inside the player's `inventory.use` action: discovery, notebook entry and consumption are saved
// together or rolled back together. `rpg.lastMapRead` lets a client that lost the answer and asks again with the
// same item id hear the same result, without a second discovery.

import { readFileSync, readdirSync } from 'node:fs';
import { parseTextRsc } from '../../../client/gameplay/character/classic.js';

export const MAP_TEMPLATE_INDEX = 287;
const MAP_TEXT_ID = 499;
const READ_NOTE = 'Discovered the location of %map after studying a map.';
const READ_FAIL = 'You have already discovered the location shown by this map.';
const FALLBACK_TEXT = 'The map shows the location of %map. You record it on your map.';

/** True for both classic map templates, in new drops and in older saved records. */
export function isMapItem(it) {
  if (!it || typeof it !== 'object' || it.magic) return false;
  if (it.template === 'map' || it.group === 'map') return true;
  return it.index === MAP_TEMPLATE_INDEX && it.group !== 'potion' && (it.classicGroup === undefined || it.classicGroup === 11 || it.classicGroup === 27);
}

/**
 * @param {object} ctx runtime ctx (services.travel, services.automap, notify, dirty)
 * @param {{random?: () => number, text?: {variants(id:number): string[]|null}|null}} opts
 *   `text` defaults to the operator's TEXT.RSC, read on the first map (null: the fallback wording).
 */
export function createMapReader(ctx, { random = Math.random, text } = {}) {
  const services = ctx.services;
  const textRsc = () => {
    if (text !== undefined) return text;
    text = null;
    if (!ctx.dataPath || typeof ctx.dataFile !== 'function') return text;
    try {
      const file = readdirSync(ctx.dataPath).find((f) => f.toUpperCase() === 'TEXT.RSC') ?? 'TEXT.RSC';
      text = parseTextRsc(new Uint8Array(readFileSync(ctx.dataFile(file))));
    } catch (err) {
      ctx.log?.warn?.(`[inventory] TEXT.RSC unavailable for map text: ${err.message}`);
    }
    return text;
  };

  const revealText = (name) => {
    let v = null;
    try { v = textRsc()?.variants?.(MAP_TEXT_ID); } catch { v = null; }
    const pick = Array.isArray(v) && v.length ? v[Math.min(v.length - 1, Math.floor(random() * v.length))] : FALLBACK_TEXT;
    return pick.replace(/%map/g, name).replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  };

  /**
   * Read map `it` from player `p`'s pack. `consume()` removes one map. Returns {text, outcome, location?}.
   * Throws (nothing changed) when the world map is unavailable.
   */
  function read(p, it, consume) {
    const travel = services.travel;
    const result = travel?.discoverRandomLocation?.(p, { random }) ?? { status: 'unavailable', reason: 'no-travel' };
    if (result.status === 'unavailable') {
      throw new Error(result.reason === 'loading'
        ? 'The world map is still being read on the server. Try the map again in a moment.'
        : 'This server has no world map to record the place on; you keep the map.');
    }
    consume();
    let out;
    if (result.status === 'revealed') {
      const name = String(result.entry.name ?? '').trim();
      services.automap?.write?.(p, READ_NOTE.replace('%map', name), { source: 'map' });
      out = { outcome: 'revealed', text: revealText(name), location: result.entry.id, name, region: result.entry.region };
    } else {
      out = { outcome: 'exhausted', text: READ_FAIL, region: result.region };
    }
    p.rpg.lastMapRead = { itemId: String(it.id), at: Date.now(), ...out };
    ctx.dirty?.(p);
    return out;
  }

  /** The repeated answer for a map this character already read (lost reply, double click). Null otherwise. */
  function repeat(p, itemId) {
    const last = p?.rpg?.lastMapRead;
    if (!last || typeof last !== 'object' || last.itemId !== String(itemId)) return null;
    return { ...last, repeat: true };
  }

  return { read, repeat };
}
