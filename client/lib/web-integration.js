// Client-side website integration helpers:
// - Map deep-link (?place=<id>) parsing
// - Launcher "What's new" patch-notes feed parsing & seen-state tracking
// - Bug-report draft serialization, live context & screenshot guard (localStorage['dfw_bug_draft'])
// - Chronicles / Hiscores web URL builders & shared website links
//
// DOM-free so every helper can be unit tested directly in Node.

export const BUG_DRAFT_KEY = 'dfw_bug_draft';
export const SEEN_PATCH_KEY = 'dfw_seen_patch_id';
export const BUG_REPORT_URL = '/report-bug/?from=game';
export const PATCH_NOTES_FEED_URL = '/patch-notes/feed.json';
export const PATCH_NOTES_URL = '/patch-notes/';
export const MAX_SCREENSHOT_BYTES = Math.floor(1.5 * 1024 * 1024); // 1.5 MiB cap

export const BUG_CATEGORIES = Object.freeze(['gameplay', 'performance', 'account', 'other']);

export const ACCOUNT_LINKS = Object.freeze({
  recover: '/signup/?mode=recover',
  settings: '/signup/',
});

export const WEBSITE_LINKS = Object.freeze([
  Object.freeze({ label: 'World Map', href: '/map/' }),
  Object.freeze({ label: 'Chronicles', href: '/hiscores/' }),
  Object.freeze({ label: 'Patch notes', href: '/patch-notes/' }),
  Object.freeze({ label: 'Guide', href: '/guide/' }),
]);

/**
 * Parse `?place=<id>` from a query string (e.g. `location.search`) or URLSearchParams.
 * Returns a trimmed place id or null when absent/invalid.
 */
export function parseInitialPlace(search) {
  if (!search) return null;
  let raw = null;
  try {
    const params = search instanceof URLSearchParams ? search : new URLSearchParams(String(search));
    raw = params.get('place');
  } catch {
    return null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 200) return null;
  return trimmed;
}

/**
 * Extract the latest patch-note entry from `/patch-notes/feed.json` (JSON Feed 1.1).
 * Returns `{ id, date, headline, url }` or null if the feed is empty or invalid.
 */
export function parseLatestPatchNote(feed) {
  const items = Array.isArray(feed?.items) ? feed.items : null;
  if (!items || !items.length) return null;

  let best = null;
  let bestTime = -Infinity;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const rawDate = typeof item.date_published === 'string'
      ? item.date_published
      : (typeof item.date_modified === 'string' ? item.date_modified : '');
    const t = rawDate ? Date.parse(rawDate) : NaN;
    const score = Number.isFinite(t) ? t : -Infinity;
    if (!best || score > bestTime) {
      best = item;
      bestTime = score;
    }
  }
  if (!best) return null;

  const rawDate = String(best.date_published ?? best.date_modified ?? '').trim();
  const dateMatch = /^(\d{4}-\d{2}-\d{2})/.exec(rawDate);
  const date = dateMatch ? dateMatch[1] : '';

  let headline = typeof best.title === 'string' ? best.title.trim() : '';
  if (!headline) {
    const body = String(best.content_text ?? best.summary ?? '');
    const firstLine = body.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
    headline = firstLine.replace(/^[•*\-–—]\s*/, '').trim();
  }
  if (!headline) return null;

  const id = String(best.id ?? best.url ?? `${date}:${headline}`).trim();
  if (!id) return null;

  return {
    id,
    date,
    headline,
    url: PATCH_NOTES_URL,
  };
}

export function isPatchNoteUnseen(id, storage = globalThis.localStorage) {
  if (!id) return false;
  try {
    return storage?.getItem?.(SEEN_PATCH_KEY) !== String(id);
  } catch {
    return true;
  }
}

export function markPatchNoteSeen(id, storage = globalThis.localStorage) {
  if (!id) return false;
  try {
    storage?.setItem?.(SEEN_PATCH_KEY, String(id));
    return true;
  } catch {
    return false;
  }
}

const DATA_URL_RE = /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/;

/**
 * Guard a screenshot object `{ name, data }` so only valid image data URLs under the byte cap pass.
 */
export function sanitizeScreenshot(screenshot, { maxBytes = MAX_SCREENSHOT_BYTES } = {}) {
  if (!screenshot || typeof screenshot !== 'object') return null;
  const data = typeof screenshot.data === 'string' ? screenshot.data.trim() : '';
  if (!data || data.length > maxBytes) return null;
  const match = DATA_URL_RE.exec(data);
  if (!match) return null;
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const name = typeof screenshot.name === 'string' && screenshot.name.trim()
    ? screenshot.name.trim().slice(0, 120)
    : `gameplay-screenshot.${ext}`;
  return { name, data };
}

/**
 * Capture a compressed WebP screenshot from a canvas element, guarded under `maxBytes` (1.5 MiB).
 * Returns `{ name, data }` or null on error / oversized output / unsupported canvas.
 */
export function captureCanvasScreenshot(canvas, { quality = 0.78, maxBytes = MAX_SCREENSHOT_BYTES } = {}) {
  if (!canvas || typeof canvas.toDataURL !== 'function') return null;
  if (typeof canvas.width === 'number' && typeof canvas.height === 'number' && (canvas.width <= 0 || canvas.height <= 0)) {
    return null;
  }
  try {
    const data = canvas.toDataURL('image/webp', quality);
    return sanitizeScreenshot({ name: 'gameplay-screenshot.webp', data }, { maxBytes });
  } catch {
    return null;
  }
}

/** Read a best-effort WebGL renderer string from a Renderer instance or WebGLRenderingContext. */
export function detectWebglRenderer(rendererOrGl) {
  const gl = rendererOrGl?.gl ?? rendererOrGl;
  if (!gl || typeof gl.getParameter !== 'function') return '';
  try {
    const ext = typeof gl.getExtension === 'function' ? gl.getExtension('WEBGL_debug_renderer_info') : null;
    const raw = ext && ext.UNMASKED_RENDERER_WEBGL
      ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
      : (gl.RENDERER ? gl.getParameter(gl.RENDERER) : '');
    return typeof raw === 'string' ? raw.trim().slice(0, 200) : '';
  } catch {
    return '';
  }
}

function cleanText(value, maxLen = 400) {
  if (value === null || value === undefined) return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, maxLen) : '';
}

/**
 * Build a normalized `dfw_bug_draft` payload shared with `/report-bug/`.
 * Schema:
 * `{ createdAt, category, title?, descriptionHint?, context: { screen?, location?, locationId?,
 *    region?, panel?, conn?, error?, errorTitle?, errorMessage?, errorHint?, url?, renderer? },
 *    screenshot: { name, data } | null }`
 */
export function buildBugDraft(opts = {}) {
  const category = BUG_CATEGORIES.includes(opts.category) ? opts.category : 'gameplay';
  const createdAt = Number.isFinite(opts.createdAt) ? Math.trunc(opts.createdAt) : Date.now();
  const title = cleanText(opts.title, 120);
  const descriptionHint = cleanText(opts.descriptionHint, 800);

  const rawCtx = opts.context && typeof opts.context === 'object' ? opts.context : {};
  const context = {};
  const fields = [
    ['screen', 40],
    ['location', 120],
    ['locationId', 160],
    ['region', 80],
    ['panel', 60],
    ['conn', 40],
    ['error', 500],
    ['errorTitle', 160],
    ['errorMessage', 400],
    ['errorHint', 300],
    ['url', 300],
    ['renderer', 200],
  ];
  for (const [key, maxLen] of fields) {
    const val = cleanText(rawCtx[key], maxLen);
    if (val) context[key] = val;
  }
  if (!context.error && (context.errorTitle || context.errorMessage)) {
    context.error = [context.errorTitle, context.errorMessage, context.errorHint].filter(Boolean).join(' — ').slice(0, 500);
  }

  const screenshot = sanitizeScreenshot(opts.screenshot);
  const draft = { createdAt, category, context, screenshot };
  if (title) draft.title = title;
  if (descriptionHint) draft.descriptionHint = descriptionHint;
  return draft;
}

/**
 * Write a bug-report draft into `localStorage['dfw_bug_draft']`.
 * If storage quota rejects the screenshot payload, retries automatically without the screenshot.
 */
export function saveBugDraft(draft, storage = globalThis.localStorage) {
  if (!storage || typeof storage.setItem !== 'function') {
    return { ok: false, droppedScreenshot: false };
  }
  const normalized = buildBugDraft(draft);
  try {
    storage.setItem(BUG_DRAFT_KEY, JSON.stringify(normalized));
    return { ok: true, droppedScreenshot: false, draft: normalized };
  } catch {
    if (normalized.screenshot) {
      const fallback = { ...normalized, screenshot: null };
      try {
        storage.setItem(BUG_DRAFT_KEY, JSON.stringify(fallback));
        return { ok: true, droppedScreenshot: true, draft: fallback };
      } catch {
        return { ok: false, droppedScreenshot: true };
      }
    }
    return { ok: false, droppedScreenshot: false };
  }
}

function normalizeOrigin(origin) {
  if (typeof origin !== 'string') return '';
  const trimmed = origin.trim().replace(/\/+$/, '');
  if (!trimmed || trimmed === 'null' || trimmed.startsWith('file:')) return '';
  return trimmed;
}

/** Build a public Chronicles web URL for a player profile (`?player=...`) or board (`?board=...`). */
export function hiscoresWebUrl({ player = '', board = '', origin = '' } = {}) {
  const base = normalizeOrigin(origin);
  const p = String(player ?? '').trim();
  if (p) return `${base}/hiscores/?player=${encodeURIComponent(p)}`;
  const b = String(board ?? '').trim() || 'overall';
  return `${base}/hiscores/?board=${encodeURIComponent(b)}`;
}

export function hiscoresPlayerWebUrl(name, origin = '') {
  return hiscoresWebUrl({ player: name, origin });
}

export function hiscoresBoardWebUrl(board, origin = '') {
  return hiscoresWebUrl({ board, origin });
}
