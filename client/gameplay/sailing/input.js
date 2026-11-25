// Helm and gunnery keys. Pure mapping so it can be unit tested without a DOM.
//
// Away from a ship nothing here claims a key. Aboard, only K (helm) and U (Ship & Sea panel) are claimed. At the helm
// the walking keys become the helm (server verb sailing.control): A/D or ←/→ hold the rudder, W/S or ↑/↓ step the
// canvas (struck/half/full), Q/E step the oars (back/rest/pull), X drops or weighs anchor, Y makes fast at the nearest
// berth (sailing.dock). The mouse still looks around. With a naval state, / loads the battery the look bears on and
// Space fires it only when it is ready and you command the ship, so melee keeps Space otherwise.
// Free keys checked against the shell and features: F G C I B J M O P T R H V N L Z X(crouch off-helm) F1-F4 F10.

export const HELM_KEYS = Object.freeze({
  rudderPort: ['KeyA', 'ArrowLeft'],
  rudderStarboard: ['KeyD', 'ArrowRight'],
  sailUp: ['KeyW', 'ArrowUp'],
  sailDown: ['KeyS', 'ArrowDown'],
  oarsBack: ['KeyQ'],
  oarsAhead: ['KeyE'],
  anchor: ['KeyX'],
  dock: ['KeyY'],
});
export const HELM_TOGGLE = 'KeyK';
export const SHIP_PANEL = 'KeyU';
export const GUN_KEYS = Object.freeze({ load: 'Slash', fire: 'Space' });

/** Which helm command a key is at the helm, or null. */
export function helmCommand(code) {
  for (const [cmd, codes] of Object.entries(HELM_KEYS)) if (codes.includes(code)) return cmd;
  return null;
}

/** Rudder from held codes: -1 port, 0 amidships, +1 starboard. */
export function rudderFrom(held) {
  const p = HELM_KEYS.rudderPort.some((c) => held.has(c));
  const s = HELM_KEYS.rudderStarboard.some((c) => held.has(c));
  return p === s ? 0 : p ? -1 : 1;
}
