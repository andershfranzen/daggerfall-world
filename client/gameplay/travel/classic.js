// Starter destinations for servers that have no MAPS.BSA of their own.
//
// When the operator has not configured an ARENA2 directory, the server cannot
// check a destination against the original data, so it accepts only this short,
// hand-checked list: the starting hamlet and the capitals of the Iliac Bay's
// great kingdoms. Names are the exact MAPS.BSA spellings; x/y are classic map
// pixels (MapsFile.LongitudeLatitudeToMapPixel) and the last column is the
// MAPNAMES record index, verified against the original
// data by test/rpg-travel-data.test.mjs. Players still need their own game
// files to see these places.

import { Catalog, locationId } from './catalog.js';

const STARTERS = [
  ['Daggerfall', 17, 'Gothway Garden', 'hamlet', 109, 159, 197],
  ['Daggerfall', 17, 'Daggerfall', 'city', 207, 213, 1231],
  ['Glenpoint', 18, 'Glenpoint', 'city', 167, 109, 181],
  ['Anticlere', 21, 'Anticlere', 'city', 357, 168, 600],
  ['Sentinel', 20, 'Sentinel', 'city', 397, 343, 6],
  ['Lainlyn', 22, 'Lainlyn', 'city', 737, 289, 103],
  ['Wayrest', 23, 'Wayrest', 'city', 859, 244, 601],
];

export const CLASSIC_STARTERS = Object.freeze(
  STARTERS.map(([region, regionIndex, name, type, x, y, index]) =>
    Object.freeze({ id: locationId(region, name), region, regionIndex, name, type, discovered: true, x, y, index, mapId: null }),
  ),
);

export function classicCatalog() {
  return new Catalog(CLASSIC_STARTERS.map((l) => ({ ...l })), 'classic');
}
