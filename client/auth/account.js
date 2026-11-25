// Account panel for /play.html. Self-starting: importing this module mounts the UI.
//
// - Talks only to the same origin (/api/me, /api/register, /api/login, /api/logout). The session
//   lives in an HttpOnly cookie; this module never sees or stores a token.
// - Fires `window` event 'account:change' with detail { user: {id, username} | null } after the
//   bootstrap /api/me and after every sign-in / sign-out. `document.body.dataset.account` mirrors it
//   ('pending' | 'in' | 'out') so the shell and CSS can gate entry.
// - window.dfwAccount = { user, ready: Promise<user|null>, refresh(), logout() } for the shell.
// - Stays in step with other tabs (BroadcastChannel) and re-checks /api/me when the tab becomes
//   visible again, so a sign-out elsewhere or an expired session shows up without a reload.
//
// Mount point: the landing panel (#screen-landing .panel), before the join form; else <body>.

const STYLE_HREF = '/auth/account.css';
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{2,19}$/;
const MIN_PASSWORD = 10;

let user = null;
let resolveReady;
const ready = new Promise((r) => (resolveReady = r));

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

async function api(path, body) {
  const init = body === undefined
    ? { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } }
    : {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      };
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw Object.assign(new Error('Could not reach the server. Check your connection and try again.'), { network: true });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    let message = data?.error || `The server answered ${res.status}.`;
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After'));
      if (wait > 0) message += ` (try again in ${wait < 90 ? `${wait} s` : `${Math.ceil(wait / 60)} min`})`;
    }
    throw Object.assign(new Error(message), { status: res.status, field: data?.field });
  }
  return data ?? {};
}

function setUser(next, { muted = null } = {}) {
  const changed = (next?.id ?? null) !== (user?.id ?? null) || (next?.username ?? null) !== (user?.username ?? null);
  user = next ? { id: next.id, username: next.username } : null;
  document.body.dataset.account = user ? 'in' : 'out';
  if (window.dfwAccount) window.dfwAccount.user = user;
  render(muted);
  if (changed || !bootstrapped) {
    bootstrapped = true;
    window.dispatchEvent(new CustomEvent('account:change', { detail: { user } }));
  }
}
let bootstrapped = false;

// ------------------------------------------------------------------ UI

let root;
let mode = 'signin'; // 'signin' | 'register'
let busy = false;
let refs = {};

function feedback(text, kind = 'error') {
  if (!refs.status) return;
  refs.status.textContent = text || '';
  refs.status.dataset.kind = text ? kind : '';
}

function fieldError(name, text) {
  const input = refs[name];
  const note = refs[name + 'Note'];
  if (!input || !note) return;
  if (text) {
    input.setAttribute('aria-invalid', 'true');
    note.textContent = text;
    note.hidden = false;
  } else {
    input.removeAttribute('aria-invalid');
    note.textContent = '';
    note.hidden = true;
  }
}

function setBusy(on) {
  busy = on;
  root?.setAttribute('aria-busy', on ? 'true' : 'false');
  for (const b of root?.querySelectorAll('button, input') ?? []) b.disabled = on;
}

function renderSignedIn(muted) {
  const name = el('strong', { class: 'acct-name', text: user.username });
  const out = el('button', { type: 'button', class: 'acct-btn acct-btn-quiet', text: 'Log out', onclick: onLogout });
  const status = el('p', { class: 'acct-status', role: 'status', 'aria-live': 'polite' });
  const children = [
    el('div', { class: 'acct-row' }, el('span', { class: 'acct-who' }, 'Signed in as ', name), out),
  ];
  if (muted) {
    const until = muted.until ? ` until ${new Date(muted.until).toLocaleString()}` : '';
    children.push(el('p', { class: 'acct-note acct-warn', text: `Your chat is muted${until}.` }));
  }
  children.push(status);
  refs = { status };
  return children;
}

function renderForm() {
  const reg = mode === 'register';
  const title = el('h2', { class: 'acct-title', id: 'acct-title', text: reg ? 'Create account' : 'Sign in' });

  const tabs = el(
    'div',
    { class: 'acct-tabs', role: 'group', 'aria-label': 'Account' },
    el('button', {
      type: 'button',
      class: 'acct-tab',
      'aria-pressed': String(!reg),
      text: 'Sign in',
      onclick: () => switchMode('signin'),
    }),
    el('button', {
      type: 'button',
      class: 'acct-tab',
      'aria-pressed': String(reg),
      text: 'Create account',
      onclick: () => switchMode('register'),
    })
  );

  const username = el('input', {
    id: 'acct-username',
    name: 'username',
    type: 'text',
    required: true,
    minlength: '3',
    maxlength: reg ? '20' : '64',
    autocomplete: 'username',
    autocapitalize: 'none',
    spellcheck: 'false',
    'aria-describedby': 'acct-username-note acct-username-hint',
  });
  const usernameHint = el('p', {
    id: 'acct-username-hint',
    class: 'acct-note',
    text: reg ? '3–20 letters, digits, _ or -, starting with a letter. Shown to other players.' : '',
    hidden: !reg,
  });
  const usernameNote = el('p', { id: 'acct-username-note', class: 'acct-note acct-err', hidden: true });

  const password = el('input', {
    id: 'acct-password',
    name: 'password',
    type: 'password',
    required: true,
    minlength: reg ? String(MIN_PASSWORD) : false,
    maxlength: '256',
    autocomplete: reg ? 'new-password' : 'current-password',
    'aria-describedby': 'acct-password-note acct-password-hint',
  });
  const passwordHint = el('p', {
    id: 'acct-password-hint',
    class: 'acct-note',
    text: reg ? `At least ${MIN_PASSWORD} characters. A passphrase works well.` : '',
    hidden: !reg,
  });
  const passwordNote = el('p', { id: 'acct-password-note', class: 'acct-note acct-err', hidden: true });

  const show = el('input', { id: 'acct-show', type: 'checkbox' });
  show.addEventListener('change', () => (password.type = show.checked ? 'text' : 'password'));

  let confirm = null;
  let confirmNote = null;
  if (reg) {
    confirm = el('input', {
      id: 'acct-confirm',
      name: 'confirm',
      type: 'password',
      required: true,
      maxlength: '256',
      autocomplete: 'new-password',
      'aria-describedby': 'acct-confirm-note',
    });
    confirmNote = el('p', { id: 'acct-confirm-note', class: 'acct-note acct-err', hidden: true });
    show.addEventListener('change', () => (confirm.type = show.checked ? 'text' : 'password'));
  }

  const status = el('p', { class: 'acct-status', role: 'alert', 'aria-live': 'assertive' });
  const submit = el('button', { type: 'submit', class: 'acct-btn acct-btn-primary', text: reg ? 'Create account' : 'Sign in' });

  const form = el(
    'form',
    { class: 'acct-form', novalidate: true, 'aria-labelledby': 'acct-title', onsubmit: onSubmit },
    el('div', { class: 'acct-field' }, el('label', { for: 'acct-username', text: 'Account name' }), username, usernameHint, usernameNote),
    el('div', { class: 'acct-field' }, el('label', { for: 'acct-password', text: 'Password' }), password, passwordHint, passwordNote),
    reg ? el('div', { class: 'acct-field' }, el('label', { for: 'acct-confirm', text: 'Repeat password' }), confirm, confirmNote) : null,
    el('div', { class: 'acct-check' }, show, el('label', { for: 'acct-show', text: 'Show password' })),
    submit,
    status
  );

  refs = { username, usernameNote, password, passwordNote, confirm, confirmNote, status, submit };
  return [title, tabs, form];
}

function render(muted = null) {
  if (!root) return;
  const keepName = refs.username?.value ?? '';
  const focusWasInside = root.contains(document.activeElement);
  root.replaceChildren(...(user ? renderSignedIn(muted) : renderForm()));
  root.dataset.state = user ? 'in' : mode;
  if (!user && refs.username) {
    refs.username.value = keepName;
    if (focusWasInside) (keepName ? refs.password : refs.username).focus();
  }
}

function switchMode(next) {
  if (busy || mode === next) return;
  mode = next;
  render();
  feedback('');
}

function validate(reg) {
  const name = refs.username.value.trim();
  const pw = refs.password.value;
  let ok = true;
  let first = null;
  const fail = (field, text) => {
    fieldError(field, text);
    ok = false;
    first ??= refs[field];
  };
  fieldError('username', null);
  fieldError('password', null);
  if (refs.confirm) fieldError('confirm', null);
  if (!name) fail('username', 'Enter your account name.');
  else if (reg && !NAME_RE.test(name)) fail('username', 'Use 3–20 letters, digits, _ or -, starting with a letter.');
  if (!pw) fail('password', 'Enter your password.');
  else if (reg && [...pw].length < MIN_PASSWORD) fail('password', `Use at least ${MIN_PASSWORD} characters.`);
  else if (reg && name && pw.toLowerCase().includes(name.toLowerCase())) {
    fail('password', 'Your password must not contain your account name.');
  }
  if (reg && refs.confirm.value !== pw) fail('confirm', 'The passwords do not match.');
  first?.focus();
  return ok ? { username: name, password: pw } : null;
}

async function onSubmit(ev) {
  ev.preventDefault();
  if (busy) return;
  const reg = mode === 'register';
  feedback('');
  const creds = validate(reg);
  if (!creds) {
    feedback('Please check the highlighted fields.');
    return;
  }
  setBusy(true);
  feedback(reg ? 'Creating your account…' : 'Signing in…', 'info');
  try {
    const data = await api(reg ? '/api/register' : '/api/login', creds);
    setBusy(false);
    setUser(data.user);
    announce();
    feedback(reg ? `Welcome, ${data.user.username}. Your account is ready.` : `Welcome back, ${data.user.username}.`, 'ok');
    root.querySelector('button')?.focus();
  } catch (err) {
    setBusy(false);
    if (err.field && refs[err.field]) {
      fieldError(err.field, err.message);
      refs[err.field].focus();
    } else if (!err.network && err.status === 401) {
      refs.password.value = '';
      refs.password.focus();
    }
    feedback(err.message);
  }
}

async function onLogout() {
  if (busy) return;
  setBusy(true);
  try {
    await api('/api/logout', {});
    setBusy(false);
    mode = 'signin';
    setUser(null);
    announce();
    feedback('You have logged out.', 'ok');
    refs.username?.focus();
  } catch (err) {
    setBusy(false);
    feedback(err.message);
  }
}

async function refresh() {
  try {
    const data = await api('/api/me');
    setUser(data.user ?? null, { muted: data.muted ?? null });
  } catch (err) {
    setUser(null);
    feedback(err.network ? err.message : 'Could not check your sign-in. Reload to try again.');
  }
  return user;
}

// Cross-tab and expiry sync. Only a definite answer from /api/me changes state: a network blip
// must never sign the player out (that would also drop them out of the world).
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('dfw-account') : null;
function announce() {
  try { channel?.postMessage('changed'); } catch {}
}

async function sync() {
  if (busy || !bootstrapped) return;
  let data;
  try {
    data = await api('/api/me');
  } catch {
    return;
  }
  const next = data.user ?? null;
  if ((next?.id ?? null) === (user?.id ?? null)) return; // unchanged: keep anything typed in the form
  if (!next) mode = 'signin';
  setUser(next, { muted: data.muted ?? null });
  feedback(next ? `Signed in as ${next.username} in another tab.` : 'You were signed out, in another tab or because your session ended.', 'info');
}
channel?.addEventListener('message', sync);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') sync();
});

function mount() {
  if (!document.querySelector(`link[href="${STYLE_HREF}"]`)) {
    document.head.append(el('link', { rel: 'stylesheet', href: STYLE_HREF }));
  }
  const host = document.querySelector('#screen-landing .panel') || document.body;
  root = el('section', { id: 'account-panel', class: 'acct', 'aria-label': 'Your account', 'aria-busy': 'true' });
  const form = host.querySelector('#join-form');
  if (form) host.insertBefore(root, form);
  else host.append(root);
  document.body.dataset.account = 'pending';
  root.append(el('p', { class: 'acct-status', role: 'status', text: 'Checking your sign-in…' }));
}

window.dfwAccount = {
  user: null,
  ready,
  refresh,
  logout: onLogout,
};

function start() {
  mount();
  refresh().then((u) => {
    root.setAttribute('aria-busy', 'false');
    resolveReady(u);
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
