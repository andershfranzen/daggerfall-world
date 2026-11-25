// Tiny DOM builder: elements and text nodes only (never innerHTML), so player-chosen names are inert.

export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function button(label, onClick, props = {}) {
  return h('button', { type: 'button', class: 'btn', onClick, ...props }, label);
}

/** − value + spinner, as on the classic rollout screens. */
export function spinner({ label, value, onUp, onDown, canUp = true, canDown = true, hint = null, highlight = false, title = null }) {
  return h('div', { class: `cc-spin${highlight ? ' is-raised' : ''}`, role: 'group', 'aria-label': label, title },
    h('span', { class: 'cc-spin-label' }, label),
    h('button', { type: 'button', class: 'cc-spin-btn', 'aria-label': `Lower ${label}`, disabled: !canDown, onClick: onDown }, '−'),
    h('output', { class: 'cc-spin-value' }, String(value)),
    h('button', { type: 'button', class: 'cc-spin-btn', 'aria-label': `Raise ${label}`, disabled: !canUp, onClick: onUp }, '+'),
    hint ? h('span', { class: 'cc-spin-hint' }, hint) : null,
  );
}

export function bar(kind, value, max, label) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return h('div', { class: `cc-bar cc-bar-${kind}`, role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value },
    h('span', { class: 'cc-bar-label' }, label),
    h('span', { class: 'cc-bar-track' }, h('span', { class: 'cc-bar-fill', style: { width: `${pct}%` } })),
    h('span', { class: 'cc-bar-num' }, `${value} / ${max}`),
  );
}

// The shell redraws the panel on every state message (vitals regenerate each second), so a <details> the
// player opened would snap shut. Remember open/closed per key for the page's lifetime.
const detailsOpen = new Map();

/** <details> whose open state survives re-renders. */
export function keptDetails(key, defaultOpen, props, summary, ...children) {
  const open = detailsOpen.has(key) ? detailsOpen.get(key) : !!defaultOpen;
  const el = h('details', { ...props, open: open || null, onToggle: (e) => detailsOpen.set(key, e.currentTarget.open) }, h('summary', null, summary), ...children);
  return el;
}
