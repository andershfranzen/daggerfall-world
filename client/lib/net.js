// WebSocket session with the town server (same origin, /ws).
//
// connect() resolves with the welcome message or rejects with a JoinError describing why.
// After that, handlers receive state/chat/error/rpg/gameEvent messages and a single onClose(info).
//
// Joining: a guest presents `{type:'join', name, token?}`. A signed-in account presents
// `{type:'join', name, account:true, claimToken?}` with no guest token: the server identifies the
// account from the same-origin session cookie sent with the WebSocket upgrade, loads that account's
// character, and on the first account join may adopt the guest character named by `claimToken`.

export const CLOSE = Object.freeze({
  NORMAL: 1000,
  SHUTDOWN: 1001,
  ABNORMAL: 1006,
  POLICY: 1008,
  FULL: 1013,
  REPLACED: 4000,
  PROTOCOL: 4001,
  RATE_LIMIT: 4002,
  INVALID_TOKEN: 4003,
  ACCOUNT: 4004,
});

export class JoinError extends Error {
  constructor(kind, message, { code = 0, retryable = true } = {}) {
    super(message);
    this.kind = kind; // 'unreachable' | 'rejected' | 'invalid-token' | 'full' | 'account' | 'cancelled'
    this.code = code;
    this.retryable = retryable;
  }
}

export function defaultUrl(loc = globalThis.location) {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

/** Human description of a close after a successful join; `auto` = worth one silent retry. */
export function describeClose(code, reason) {
  switch (code) {
    case CLOSE.NORMAL: return { text: 'You left the town.', auto: false, canReconnect: true };
    case CLOSE.REPLACED:
      return {
        text: 'This traveller was signed in from another tab or window, so this one was disconnected.',
        auto: false, canReconnect: true,
      };
    case CLOSE.SHUTDOWN: return { text: 'The town server is shutting down.', auto: false, canReconnect: true };
    case CLOSE.FULL: return { text: 'The town is full.', auto: false, canReconnect: true };
    case CLOSE.RATE_LIMIT: return { text: 'Disconnected for sending too many messages.', auto: false, canReconnect: true };
    case CLOSE.INVALID_TOKEN: return { text: 'Your saved traveller is no longer known to the server.', auto: false, canReconnect: true };
    case CLOSE.ACCOUNT:
      return { text: `Your account session ended${reason ? ` (${reason})` : ''}. Sign in again to continue.`, auto: false, canReconnect: false, signIn: true };
    case CLOSE.POLICY:
      return { text: `The server closed the connection${reason ? ` (${reason})` : ''}.`, auto: false, canReconnect: true };
    default:
      return { text: `Connection to the town was lost${reason ? ` (${reason})` : ''}.`, auto: true, canReconnect: true };
  }
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function sanitizePlayer(p) {
  if (!isObj(p) || (typeof p.id !== 'string' && typeof p.id !== 'number')) return null;
  return {
    id: String(p.id),
    name: typeof p.name === 'string' ? p.name.slice(0, 40) : '?',
    x: num(p.x), z: num(p.z), yaw: num(p.yaw), moving: !!p.moving,
    // Locomotion body (server/rpg/collision.js bodyView, client/lib/locomotion.js publicBody): foot height,
    // stance and covered speed. Absent before the body's first step; callers fall back to the ground.
    ...(typeof p.y === 'number' && Number.isFinite(p.y) ? { y: p.y } : {}),
    ...(typeof p.stance === 'string' && p.stance.length <= 16 ? { stance: p.stance } : {}),
    ...(typeof p.speed === 'number' && Number.isFinite(p.speed) ? { speed: p.speed } : {}),
    // Seen across an outdoor boundary (server/rpg/peers.js), already in our frame.
    ...(p.across === true ? { across: true } : {}),
  };
}

const VERB_RE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/i;

/** True for verbs like `combat.attack` or `npc.talk` (letters, digits, _ - and dots). */
export function validVerb(verb) {
  return typeof verb === 'string' && verb.length <= 64 && VERB_RE.test(verb);
}

/**
 * Normalise an RPG message `{type:'rpg', character, entities, peers, selfId}`. Keys missing from
 * the message are omitted so callers can merge partial updates. Returns null when unusable.
 */
export function sanitizeRpg(msg) {
  if (!isObj(msg)) return null;
  const out = {};
  if ('character' in msg) out.character = isObj(msg.character) ? msg.character : null;
  if ('entities' in msg) out.entities = Array.isArray(msg.entities) ? msg.entities.filter((e) => isObj(e) && e.id !== undefined && e.id !== null) : [];
  if ('peers' in msg) out.peers = Array.isArray(msg.peers) ? msg.peers.filter((p) => isObj(p) && p.id !== undefined && p.id !== null) : [];
  if ('selfId' in msg && (typeof msg.selfId === 'string' || typeof msg.selfId === 'number')) out.selfId = String(msg.selfId);
  for (const [k, v] of Object.entries(msg)) if (!(k in out) && k !== 'type') out[k] = v;
  return out;
}

/** Account summary from a welcome or account event: `{id, username}` or null. */
export function sanitizeAccount(a) {
  if (!isObj(a) || typeof a.username !== 'string' || (typeof a.id !== 'string' && typeof a.id !== 'number')) return null;
  return { id: String(a.id), username: a.username.slice(0, 64) };
}

export class Connection {
  constructor(url = defaultUrl(), { WebSocketImpl = globalThis.WebSocket, joinTimeoutMs = 10000 } = {}) {
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.joinTimeoutMs = joinTimeoutMs;
    this.ws = null;
    this.joined = false;
    this.closedByUs = false;
    this.onState = null;
    this.onChat = null;
    this.onError = null;
    this.onClose = null;
    this.onRpg = null; // (rpg) partial/complete RPG snapshot, see sanitizeRpg
    this.onGameEvent = null; // (event) private or nearby gameplay event
    this.onMessage = null; // (msg) any other message type, for forward compatibility
    this.actionTimeoutMs = 10000;
    this.seq = 0;
    this.pending = new Map(); // seq -> {resolve, timer, verb}
  }

  connect({ name, token, account = false, claimToken = null }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let lastError = null;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
        try { ws.close(); } catch { /* ignore */ }
      };
      let ws;
      try {
        ws = new this.WebSocketImpl(this.url);
      } catch (e) {
        reject(new JoinError('unreachable', `Could not open a connection: ${e.message}`));
        return;
      }
      this.ws = ws;
      const timer = setTimeout(
        () => fail(new JoinError('unreachable', 'The town server did not answer in time.')),
        this.joinTimeoutMs,
      );
      this._cancel = () => fail(new JoinError('cancelled', 'Cancelled.', { retryable: true }));

      ws.onopen = () => {
        // arrival: we send {type:'arrived'} once the loading screen shows a complete place (client/main.js).
        const msg = { type: 'join', name, arrival: true };
        if (account) {
          msg.account = true;
          if (claimToken) msg.claimToken = claimToken;
        } else if (token) msg.token = token;
        ws.send(JSON.stringify(msg));
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (!isObj(msg) || typeof msg.type !== 'string') return;
        if (!this.joined) {
          if (msg.type === 'welcome') {
            const player = sanitizePlayer(msg.player);
            // Account joins are identified by the session cookie and may omit the guest token.
            if (!player || (typeof msg.token !== 'string' && !(account && msg.token == null))) {
              return fail(new JoinError('rejected', 'The server sent an unexpected welcome.', { retryable: false }));
            }
            settled = true;
            clearTimeout(timer);
            this.joined = true;
            this.arrival = msg.arrival === true;
            resolve({
              id: String(msg.id ?? player.id),
              token: typeof msg.token === 'string' ? msg.token : null,
              player,
              account: sanitizeAccount(msg.account),
              returning: typeof msg.returning === 'boolean' ? msg.returning : null,
              rpg: isObj(msg.rpg) ? sanitizeRpg(msg.rpg) : null,
            });
          } else if (msg.type === 'error') {
            // Remember it; a fatal error is followed by a close with a code. A non-fatal one
            // during join (e.g. invalid name) means the join failed: stop here.
            lastError = String(msg.message ?? 'error');
            setTimeout(() => {
              if (!settled) fail(new JoinError('rejected', capitalise(lastError), { retryable: false }));
            }, 150);
          }
          return;
        }
        switch (msg.type) {
          case 'state':
            if (Array.isArray(msg.players)) this.onState?.(msg.players.map(sanitizePlayer).filter(Boolean), typeof msg.location === 'string' ? msg.location : null);
            break;
          case 'chat':
            if (typeof msg.text === 'string') this.onChat?.({ name: String(msg.name ?? '?'), text: msg.text });
            break;
          case 'error':
            this.onError?.(String(msg.message ?? 'error'));
            break;
          case 'rpg': {
            const rpg = sanitizeRpg(msg);
            if (rpg) this.onRpg?.(rpg);
            break;
          }
          case 'gameEvent':
            if (isObj(msg.event)) this.onGameEvent?.(msg.event);
            break;
          case 'actionResult':
            this.settle(msg.seq, { ok: msg.ok === true, verb: typeof msg.verb === 'string' ? msg.verb : undefined, ...(msg.ok === true ? {} : { error: String(msg.error ?? 'The action failed.') }) });
            break;
          default:
            this.onMessage?.(msg);
            break;
        }
      };
      ws.onclose = (ev) => {
        const code = ev.code ?? CLOSE.ABNORMAL;
        if (!this.joined) {
          if (code === CLOSE.INVALID_TOKEN) {
            return fail(new JoinError('invalid-token', 'Saved traveller not recognised.', { code }));
          }
          if (code === CLOSE.FULL) {
            return fail(new JoinError('full', 'The town is full right now.', { code }));
          }
          if (code === CLOSE.ACCOUNT) {
            return fail(new JoinError('account', capitalise(lastError || ev.reason || 'Your account cannot join right now.'), { code, retryable: false }));
          }
          if (lastError) return fail(new JoinError('rejected', capitalise(lastError), { code, retryable: true }));
          return fail(new JoinError('unreachable', 'Could not reach the town server.', { code }));
        }
        const info = { code, reason: ev.reason || lastError || '', byUs: this.closedByUs };
        this.joined = false;
        this.settleAll('The connection was lost before the server answered.');
        this.onClose?.(info);
      };
      ws.onerror = () => { /* close follows */ };
    });
  }

  cancel() { this._cancel?.(); }

  send(msg) {
    const ws = this.ws;
    if (!this.joined || !ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  /** Movement input; `extra` adds the optional traversal fields {run, slow, crouch, rise, jump} (server/game.js handleInput). */
  sendInput(forward, strafe, yaw, extra = null) { return this.send({ type: 'input', forward, strafe, yaw, ...(extra || {}) }); }
  sendChat(text) { return this.send({ type: 'chat', text }); }
  /** The place is complete on screen: others may now see this player (only if the welcome offered `arrival`). */
  sendArrived() { return this.arrival ? this.send({ type: 'arrived' }) : false; }

  /**
   * Gameplay intent `{type:'action', verb, args, seq}`. Returns false if it could not be sent,
   * else a promise that always resolves (never rejects) to `{ok, verb, error?}` when the server's
   * matching `actionResult` arrives, after `actionTimeoutMs`, or when the connection closes.
   */
  sendAction(verb, args = {}) {
    if (!validVerb(verb)) return false;
    const seq = ++this.seq;
    if (!this.send({ type: 'action', verb, args: isObj(args) ? args : {}, seq })) return false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(seq, { ok: false, verb, error: 'No answer from the server.', timeout: true }), this.actionTimeoutMs);
      this.pending.set(seq, { resolve, timer, verb });
    });
  }

  settle(seq, result) {
    const p = this.pending.get(seq);
    if (!p) return;
    this.pending.delete(seq);
    clearTimeout(p.timer);
    p.resolve({ verb: p.verb, ...result });
  }

  settleAll(error) {
    for (const seq of [...this.pending.keys()]) this.settle(seq, { ok: false, error, closed: true });
  }

  close() {
    this.closedByUs = true;
    this.settleAll('You left the world.');
    const ws = this.ws;
    this.onState = this.onChat = this.onError = this.onRpg = this.onGameEvent = this.onMessage = null;
    if (ws && ws.readyState <= 1) {
      try { ws.close(1000, 'leaving'); } catch { /* ignore */ }
    }
  }
}

function capitalise(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
