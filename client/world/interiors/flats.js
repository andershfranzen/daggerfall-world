// Building interior flats (lights and decorations) placed in the interior's output space.
//
// Placement follows Daggerfall Unity's Internal/DaggerfallInterior.cs AddFlats (MIT, (c) 2009-2023 Daggerfall
// Workshop): position = (XPos, -YPos, ZPos) * GlobalScale in Unity space, and the billboard's base stands on that
// point (DFU lifts the centre by half the sprite height). The output space mirrors Unity z, as the interior models
// do (client/world/interiors/scene.js). Editor markers are placement data only (DFU hides them in play), and
// people are drawn by the actor system from the server's occupants, so neither is returned here.

import { SCALE } from './scene.js';
import { EDITOR_ARCHIVE, NPC_ARCHIVES, flatKind } from '../scenery/rmbFlats.js';

const r3 = (v) => Math.round(v * 1000) / 1000 + 0; // + 0: no negative zero

/**
 * @param {{interior: {flats: Array<{archive, record, xPos, yPos, zPos}>}}} sub - parseRmbFull() building sub-record
 * @returns {Array<{archive:number, record:number, kind:string, x:number, y:number, z:number}>} base points, output space
 */
export function interiorFlats(sub) {
  const out = [];
  for (const f of sub?.interior?.flats ?? []) {
    if (f.archive === EDITOR_ARCHIVE || NPC_ARCHIVES.has(f.archive)) continue;
    out.push({
      archive: f.archive,
      record: f.record,
      kind: flatKind(f.archive),
      x: r3(f.xPos * SCALE),
      y: r3(-f.yPos * SCALE),
      z: r3(-f.zPos * SCALE),
    });
  }
  return out;
}
