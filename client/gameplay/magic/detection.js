export function markerBearing(camera, marker) {
  const angle = Math.atan2(marker.x - camera.x, camera.z - marker.z) - camera.yaw;
  const relative = Math.atan2(Math.sin(angle), Math.cos(angle));
  return Math.max(0, Math.min(1, 0.5 + relative / Math.PI));
}

export function installDetectionCompass(api, compass, el) {
  if (!compass) return () => {};
  const layer = el('div', { class: 'compass-detection', 'aria-hidden': 'true' });
  compass.append(layer);
  let shown = [];
  let location;

  function update(event) {
    location = event?.location;
    shown = (event?.markers ?? []).filter((m) => Number.isFinite(m.x) && Number.isFinite(m.z)).map((marker) => ({
      marker,
      node: el('span', { class: 'compass-detection-marker' }),
    }));
    layer.replaceChildren(...shown.map(({ node }) => node));
    layer.hidden = true;
  }

  api.on('location', () => update());
  api.on('screen', (screen) => {
    if ((screen?.screen ?? screen) !== 'game') update();
  });
  api.on('frame', ({ camera } = {}) => {
    if (!shown.length || !camera) return;
    const active = api.state?.character?.magic?.active ?? [];
    layer.hidden = location !== api.location || api.state?.character?.defeated ||
      !active.some((a) => a.roundsLeft > 0 && ['detectEnemy', 'detectTreasure', 'detectMagic'].includes(a.status));
    if (layer.hidden) return;
    const footY = api.movement?.y;
    for (const { marker, node } of shown) {
      node.hidden = Number.isFinite(marker.y) && Number.isFinite(footY) && Math.abs(marker.y - footY) > 2.2;
      if (node.hidden) continue;
      node.style.setProperty('--bearing', markerBearing(camera, marker).toFixed(3));
    }
  });
  return update;
}
