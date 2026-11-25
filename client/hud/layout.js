// HUD layout slots. Feature modules append some widgets straight to #hud or <body>. This moves
// each one into its layout region (hud/layout.css) so it flows with the region and can't
// overlap it. Only the element's parent changes: modules keep their references, listeners
// and `hidden` toggling.
//
//   .atmo-chip      (gameplay/atmosphere.js) → #hud-status   beside the place plaque
//   .mg-chip        (gameplay/magic.js)      → #hud-dock     above the vitals
//   .interiors-prompt (gameplay/interiors.js)→ #hud-prompts  under the crosshair
//   #actor-target   (gameplay/actors.js)     → #hud-prompts
//
// A module can also append directly into a [data-hud-slot] element.

const RULES = [
  { match: (el) => el.classList?.contains('atmo-chip'), slot: 'hud-status', where: 'append' },
  { match: (el) => el.classList?.contains('mg-chip'), slot: 'hud-dock', where: 'prepend' },
  { match: (el) => el.classList?.contains('interiors-prompt'), slot: 'hud-prompts', where: 'append' },
  { match: (el) => el.id === 'actor-target', slot: 'hud-prompts', where: 'append' },
];

export function adopt(el, doc = document) {
  if (!(el instanceof Element)) return false;
  const rule = RULES.find((r) => r.match(el));
  if (!rule) return false;
  const slot = doc.getElementById(rule.slot);
  if (!slot || el.parentElement === slot) return false;
  // Moving a focused element would blur it; keep focus where the player left it.
  const focused = el.contains(doc.activeElement) ? doc.activeElement : null;
  if (rule.where === 'prepend') slot.prepend(el);
  else slot.append(el);
  focused?.focus?.({ preventScroll: true });
  return true;
}

export function installLayout(doc = document) {
  const hud = doc.getElementById('hud');
  if (!hud) return null;
  const sweep = (root) => { for (const el of [...root.children]) adopt(el, doc); };
  sweep(hud);
  sweep(doc.body);
  const mo = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) adopt(n, doc);
  });
  mo.observe(hud, { childList: true });
  mo.observe(doc.body, { childList: true });
  return mo;
}

installLayout();
