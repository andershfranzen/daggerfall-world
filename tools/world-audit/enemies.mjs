// Census of installed dungeon enemy records. No geometry is moved and no game assets are exported.
import { dungeonBlocks, encounterSites } from '../../client/world/interiors/index.js';
import { dungeonLayout, MARKER } from '../../client/world/interiors/layout.js';
import { readDungeon } from '../../client/world/interiors/dungeonMaps.js';
import { classicDungeonSlots, ENEMY_BY_ID, isAquatic } from '../../server/rpg/combat/monsters.js';
import { arena2Dir, openSources } from './sources.mjs';

const arena2 = arena2Dir();
if (!arena2) throw new Error('Set ARENA2_DIR to the installed classic data.');
const { data, catalog } = await openSources({ arena2 });
const mapCache = new Map();
const read = data.maps.read.bind(data.maps);
data.maps.read = (index) => {
  if (!mapCache.has(index)) mapCache.set(index, read(index));
  return mapCache.get(index);
};

const counts = {
  dungeons: 0, eligibleFixed: {}, dryAquaticFixed: {}, otherFixed: {},
  randomMarkers: 0, randomSlotZero: 0, level1: {}, level20: {}, invalid99: 0, failures: [],
};
const bump = (bin, key) => { bin[key] = (bin[key] ?? 0) + 1; };
const includeSources = process.argv.includes('--sources');
const extraLevels = [8, 11, 14, 17];
const examples = {};
const invalidMarkers = [];

// Distance from the landing orders the leads. Collision, doors and water can make the walking route longer.
function remember(id, origin, site, entry, start, selection = {}) {
  if (!ENEMY_BY_ID.has(id) || !start) return;
  const distance = Math.hypot(site.x - start[0], site.y - start[1], site.z + start[2]);
  const byOrigin = examples[id] ??= {};
  if (byOrigin[origin] && byOrigin[origin].distance <= distance) return;
  byOrigin[origin] = {
    location: entry.id, marker: site.key, discovered: entry.discovered, distance,
    ...(site.passive && { passive: true }), ...selection,
  };
}

for (const entry of catalog.locations) {
  const t = await data.maps.read(data.maps.indexOfName(`MAPTABLE.${String(entry.regionIndex).padStart(3, '0')}`));
  if (t[entry.index * 17 + 12] === 255) continue;
  try {
    const dungeon = await readDungeon(data.maps, entry.regionIndex, entry.index);
    const blocks = await dungeonBlocks(data, dungeon);
    for (const { rdb } of blocks) {
      for (const { flat, root, index } of rdb.objects) {
        if (flat?.archive === 199 && flat.record === MARKER.FIXED_ENEMY && (flat.magnitude & 0xff) === 99) {
          counts.invalid99++;
          if (includeSources) invalidMarkers.push({ location: entry.id, marker: `${rdb.name}:${root}/${index}` });
        }
      }
    }
    const level1 = classicDungeonSlots(dungeon.dungeonType, dungeon.dungeonLocationId, 1);
    const level20 = classicDungeonSlots(dungeon.dungeonType, dungeon.dungeonLocationId, 20);
    const samples = includeSources ? [
      [1, level1], ...extraLevels.map(level => [level, classicDungeonSlots(dungeon.dungeonType, dungeon.dungeonLocationId, level)]), [20, level20],
    ] : [];
    const layout = dungeonLayout(blocks, { metadataOnly: true });
    const start = layout.startMarkers[0];
    for (const site of encounterSites(layout, dungeon)) {
      const water = site.waterLevel < site.markerY;
      if (site.monsters) {
        const [id] = site.monsters;
        const enemy = ENEMY_BY_ID.get(id);
        if (!enemy) bump(counts.otherFixed, id);
        else if (isAquatic(enemy) && (site.waterLevel === 10000 || site.waterLevel - 20 > site.markerY)) bump(counts.dryAquaticFixed, id);
        else {
          bump(counts.eligibleFixed, id);
          if (includeSources) remember(id, water ? 'wet-fixed' : 'fixed', site, entry, start);
        }
      } else {
        counts.randomMarkers++;
        const table = water ? 'water' : 'nonWater';
        if (includeSources) {
          const origin = site.slot ? table : `${table}-zero`;
          const slots = site.slot ? [site.slot] : [1, 2, 3, 4, 5, 6];
          for (const [level, lists] of samples) {
            for (const slot of slots) {
              remember(lists[table][slot], origin, site, entry, start, { level, slot, deferred: !site.slot });
            }
          }
        }
        if (!site.slot) {
          counts.randomSlotZero++;
          continue;
        }
        bump(counts.level1, level1[table][site.slot]);
        bump(counts.level20, level20[table][site.slot]);
      }
    }
    counts.dungeons++;
  } catch (error) {
    counts.failures.push([entry.slotId, error.message]);
  }
}

if (includeSources) counts.sources = { examples, invalidMarkers };
console.log(JSON.stringify(counts, null, 2));
if (counts.failures.length) process.exitCode = 1;
