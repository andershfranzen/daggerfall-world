// Match the lifetime of each prepared world to its cached render mesh. Both prefetch
// and scene activation share the promise, including any pending town layers.
import { composeTownCollision } from '../../world/exterior/collision.js';
import { worldFromTown } from './world.js';

export function exteriorCollision(loadTown, mechanismActive) {
  const cache = new WeakMap();
  let worker = null;
  let queue = Promise.resolve();
  let workerUnavailable = false;

  async function build(geometry) {
    const { kind, ground, positions } = geometry;
    if (geometry.mechanisms?.length) return worldFromTown(geometry, { mechanismActive });
    if (!workerUnavailable && typeof Worker === 'function') {
      try {
        worker ??= new Worker(new URL('./index-worker.js', import.meta.url), { type: 'module' });
        // Only triangles and their ground range affect these grids. DOM objects, texture
        // atlases, terrain samplers and the renderer's own buffers stay on the UI thread.
        const spatialIndex = await new Promise((resolve, reject) => {
          worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.index);
          worker.onerror = event => reject(new Error(event.message));
          worker.onmessageerror = () => reject(new Error('Could not read collision index'));
          worker.postMessage({ kind, ground, positions });
        });
        return worldFromTown(geometry, { spatialIndex });
      } catch (err) {
        worker?.terminate();
        worker = null;
        workerUnavailable = true;
        console.warn('[collision] using the local index builder:', err.message);
      }
    }
    return worldFromTown(geometry);
  }

  function prepare(mesh) {
    let entry = cache.get(mesh);
    if (entry) return entry;
    entry = { world: null, promise: null };
    cache.set(mesh, entry);
    entry.promise = (async () => {
      const geometry = mesh.wilderness?.towns?.length
        ? await composeTownCollision(mesh, loadTown)
        : mesh;
      // Resolve the render dependencies before entering this queue: their own ready
      // events can prefetch an index too. A single worker bounds simultaneous copies.
      const next = queue.then(() => cache.get(mesh) === entry ? build(geometry) : null);
      queue = next.catch(() => {});
      entry.world = await next;
      return entry.world;
    })().catch(err => {
      if (cache.get(mesh) === entry) cache.delete(mesh);
      throw err;
    });
    return entry;
  }
  return { prepare, world: mesh => cache.get(mesh)?.world, release: mesh => cache.delete(mesh) };
}
