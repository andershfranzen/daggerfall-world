// Metres. The outer terrain surrounds the entire walkable area, even at a pixel edge.
export const OUTDOOR_FAR = 3600;
export const CLEAR_VISIBILITY = 2400;

export function fogDistances(far, weatherScale, outdoors, viewDistance = CLEAR_VISIBILITY) {
  if (!outdoors) return [far * 0.35, far * 0.98];
  const baseVis = Number.isFinite(viewDistance) && viewDistance > 0 ? viewDistance : CLEAR_VISIBILITY;
  const end = Math.min(baseVis * weatherScale, far * 0.98);
  return [Math.min(30 * weatherScale, end * 0.1), end];
}

// Shared by solid geometry, the ground apron, scenery flats and actor billboards.
export const DISTANCE_FOG = `
uniform vec2 u_fog;
float fogAmount(float distanceToEye) {
  float t = clamp((distanceToEye - u_fog.x) / (u_fog.y - u_fog.x), 0.0, 1.0);
  return t * (2.0 - t);
}`;
// Ordered pixel coverage preserves the depth test for overlapping classic billboards.
export const PIXEL_COVERAGE = `
bool pixelVisible(float coverage) {
  vec2 xy = floor(gl_FragCoord.xy);
  float low = 2.0 * mod(xy.x + xy.y, 2.0) + mod(xy.y, 2.0);
  vec2 highXY = floor(xy / 2.0);
  float high = 2.0 * mod(highXY.x + highXY.y, 2.0) + mod(highXY.y, 2.0);
  return coverage > (4.0 * low + high + 0.5) / 16.0;
}`;
