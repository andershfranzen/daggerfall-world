// Guest identity: one resumable token per display name ("profile"), stored locally.
//
// Two tabs (or two windows of one browser profile) must not share a token: the server
// treats a second join with the same token as "signed in elsewhere" and kicks the first.
// So each tab claims the profile with a Web Lock. The tab that holds the lock uses and may
// persist the stored token; any other tab joins as a separate guest whose token lives only
// in memory (enough to resume after a dropped connection) and never overwrites storage.

const PREFIX = 'dfw.';

export function profileKey(name) {
  return String(name).trim().replace(/\s+/g, ' ').toLowerCase();
}

export function cleanDisplayName(name) {
  return String(name).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().replace(/\s+/g, ' ').slice(0, 24);
}

/** Mirrors the server's rule so we can explain problems before connecting. */
export function nameProblem(name) {
  const n = cleanDisplayName(name);
  if (!n) return 'Enter a name for your traveller.';
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _'-]*$/u.test(n)) {
    return "Names may use letters, digits, spaces, _ ' and -, and must start with a letter or digit.";
  }
  return null;
}

function safeStorage(storage) {
  return {
    get(k) { try { return storage?.getItem(k) ?? null; } catch { return null; } },
    set(k, v) { try { storage?.setItem(k, v); } catch { /* quota / disabled */ } },
    remove(k) { try { storage?.removeItem(k); } catch { /* ignore */ } },
  };
}

async function tryLock(locks, name) {
  if (!locks || typeof locks.request !== 'function') return { ok: true, locked: false, release() {} };
  return new Promise((resolve, reject) => {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve({ ok: false, locked: false, release() {} });
          return undefined;
        }
        return new Promise((done) => resolve({ ok: true, locked: true, release: done }));
      })
      .catch(reject);
  });
}

export class Identity {
  constructor({ storage = globalThis.localStorage, locks = globalThis.navigator?.locks } = {}) {
    this.store = safeStorage(storage);
    this.locks = locks;
  }

  get lastName() { return this.store.get(PREFIX + 'name') ?? ''; }
  set lastName(v) { this.store.set(PREFIX + 'name', v); }

  tokens() {
    try {
      const t = JSON.parse(this.store.get(PREFIX + 'tokens') ?? '{}');
      return t && typeof t === 'object' && !Array.isArray(t) ? t : {};
    } catch { return {}; }
  }

  storedToken(key) {
    const t = this.tokens()[key];
    return typeof t === 'string' ? t : null;
  }

  writeToken(key, token) {
    const all = this.tokens();
    if (token) all[key] = token; else delete all[key];
    this.store.set(PREFIX + 'tokens', JSON.stringify(all));
  }

  /**
   * Claim a profile for this tab. Resolves to a Claim; call claim.release() on leave.
   */
  async claim(name) {
    const key = profileKey(name);
    let lock;
    try {
      lock = await tryLock(this.locks, PREFIX + 'profile:' + key);
    } catch {
      lock = { ok: true, locked: false, release() {} };
    }
    return new Claim(this, key, lock);
  }
}

export class Claim {
  constructor(identity, key, lock) {
    this.identity = identity;
    this.key = key;
    this.lock = lock;
    /** True when this tab owns the profile and may persist its token. */
    this.owned = lock.ok;
    this.sessionToken = null;
    this.released = false;
  }

  /** Token to present when joining (null = create a new guest). */
  get token() {
    if (this.sessionToken) return this.sessionToken;
    return this.owned ? this.identity.storedToken(this.key) : null;
  }

  /** Remember the token from a welcome message. */
  adopt(token) {
    if (typeof token !== 'string' || !token) return;
    this.sessionToken = token;
    if (this.owned && !this.released) this.identity.writeToken(this.key, token);
  }

  /** The server rejected `token`; forget it (only if it is still the stored one). */
  invalidate(token) {
    if (this.sessionToken === token) this.sessionToken = null;
    if (this.owned && !this.released && this.identity.storedToken(this.key) === token) {
      this.identity.writeToken(this.key, null);
    }
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.lock.release();
  }
}
