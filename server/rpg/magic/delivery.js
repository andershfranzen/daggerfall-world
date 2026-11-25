// Swept spell missiles use authoritative geometry and current actor positions.
// An aimed target helps line up the initial shot but does not guide it after launch.
export const ranged = (type) => type === 'singleAtRange' || type === 'areaAtRange';

const delta = (first, last) => ({ x: last.x - first.x, y: last.y - first.y, z: last.z - first.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const pointAt = (start, direction, metres) => ({
  x: start.x + direction.x * metres, y: start.y + direction.y * metres, z: start.z + direction.z * metres,
});

export function directionFrom(start, target, yaw, pitch = 0) {
  if (target) {
    const diff = delta(start, target);
    const length = Math.hypot(diff.x, diff.y, diff.z);
    if (length > 0.001) return pointAt({ x: 0, y: 0, z: 0 }, diff, 1 / length);
  }
  const horizontal = Math.cos(pitch);
  return { x: Math.sin(yaw) * horizontal, y: Math.sin(pitch), z: -Math.cos(yaw) * horizontal };
}

// Small projectiles can hit a moving actor anywhere along one swept tick.
export function actorDistance(start, direction, length, center, radius) {
  const offset = delta(start, center);
  const forward = dot(offset, direction);
  const crossSq = dot(offset, offset) - forward * forward;
  if (crossSq > radius * radius) return null;
  const through = Math.sqrt(Math.max(0, radius * radius - crossSq));
  if (forward + through < 0 || forward - through > length) return null;
  return Math.max(0, forward - through);
}

export function obstructionDistance(start, direction, length, clear) {
  if (clear(start, pointAt(start, direction, length))) return null;
  let near = 0, far = length;
  while (far - near > 0.04) {
    const mid = (near + far) * 0.5;
    if (clear(start, pointAt(start, direction, mid))) near = mid;
    else far = mid;
  }
  return near;
}
