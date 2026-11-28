// Index a copy of the outdoor triangles. The renderer keeps ownership of the source buffer.
import { worldFromTown } from './world.js';

self.onmessage = ({ data }) => {
  try {
    const index = worldFromTown(data).spatialIndex();
    const buffers = [index.flags, index.minY, index.maxY, ...Object.values(index.solid), ...Object.values(index.walk), ...(index.ground ? Object.values(index.ground) : [])];
    self.postMessage({ index }, buffers.map(array => array.buffer));
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
