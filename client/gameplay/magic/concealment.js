/** Visible fraction of a magically concealed peer's figure. */
export function peerCoverage(concealment, moving) {
  if (concealment === 'invisible') return 0;
  if (concealment === 'blending' ||
      (concealment === 'chameleon' && !moving) || (concealment === 'shadow' && moving)) return 0.3;
  return 1;
}
