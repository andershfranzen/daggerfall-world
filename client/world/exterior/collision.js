// A wilderness world keeps its terrain triangles first so CollisionWorld can
// select the ground below bridges and buildings. Translate town triangles
// from the same native mesh a town player sees, preserving authored openings.
import { HALF, PIXEL, TILE, townFrame, townMeshOffset } from './frame.js';
import { joinCylinders } from '../scenery/colliders.js';

export async function composeTownCollision(scene, loadMesh) {
  const { wilderness } = scene;
  const parts = [];
  let length = scene.positions.length;
  for (const t of wilderness.towns) {
    const { rect } = townFrame({ ...t, spawnLocal: { x: 0, z: 0 } });
    const dx = (t.px - wilderness.px) * PIXEL, dz = (t.py - wilderness.py) * PIXEL;
    // Include one RMB block beyond the walkable cell for protruding models
    // and the short authority sweep across the edge.
    const reach = HALF + 16 * TILE;
    if (dx + rect.minX > reach || dx + rect.maxX < -reach ||
        dz + rect.minZ > reach || dz + rect.maxZ < -reach) continue;
    const mesh = await loadMesh(t);
    parts.push({ mesh, offset: townMeshOffset(t, mesh.source, wilderness) });
    length += mesh.positions.length;
  }
  if (!parts.length) return scene;
  const positions = new Float32Array(length);
  positions.set(scene.positions);
  let at = scene.positions.length;
  const mechanisms = [...(scene.mechanisms ?? [])];
  function copy(target, src, start, offset) {
    for (let i = 0; i < src.length; i += 3) {
      target[start + i] = src[i] + offset.x;
      target[start + i + 1] = src[i + 1] + offset.y;
      target[start + i + 2] = src[i + 2] + offset.z;
    }
  }
  for (const { mesh, offset } of parts) {
    for (const m of mesh.mechanisms ?? []) {
      const alternate = new Float32Array(m.alternate.length);
      copy(alternate, m.alternate, 0, offset);
      mechanisms.push({ ...m, id: `gate:${mechanisms.length}`, firstTriangle: at / 9 + m.firstTriangle, alternate });
    }
    copy(positions, mesh.positions, at, offset);
    at += mesh.positions.length;
  }
  // Solid flats (client/world/scenery/colliders.js) move with their meshes.
  const cylinders = joinCylinders([
    { cylinders: scene.colliders?.cylinders },
    ...parts.map((part) => ({ cylinders: part.mesh.colliders?.cylinders, offset: part.offset })),
  ]);
  return { ...scene, positions, mechanisms, colliders: { ...scene.colliders, cylinders } };
}
