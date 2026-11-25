// Cross-worker event bus for the single shared Iliac Bay world.
//
// Supports two pluggable transports behind one unified API:
//   - `createMemoryBus`   — in-process pub/sub hub for single-host multi-worker setups & tests.
//   - `createPostgresBus` — PostgreSQL `LISTEN`/`NOTIFY` transport for multi-host production.
//
// Capabilities:
//   1. Global, region, party, and whisper chat relay across zone workers.
//   2. Signed, one-time zone handoff tickets (HMAC-SHA256 + random nonce + TTL) for seamless
//      cross-worker travel with zero replay risk.
//   3. Unified single-world presence directory (worker heartbeats + map snapshots) so
//      `/api/world-map` reflects all online players across every worker in the single world.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const DEFAULT_TICKET_TTL_MS = 15_000;
export const DEFAULT_PRESENCE_TTL_MS = 30_000;
export const DEFAULT_PG_CHANNEL = 'dfw_world_bus';
export const PG_NOTIFY_MAX_BYTES = 7800; // PostgreSQL NOTIFY payload limit is 8000 bytes

const PG_IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const CHAT_CHANNELS = new Set(['global', 'region', 'party', 'whisper']);

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64urlDecode(str) {
  return Buffer.from(str, 'base64url');
}

function signPayload(secret, encodedPayload) {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function safeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Shared in-process hub for `createMemoryBus`. Multiple zone workers connected to the same hub
 * exchange chat, handoff tickets, and presence heartbeats as if over a real network bus.
 */
export function createMemoryHub() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return {
    publish(envelope) {
      // Clone to guarantee transport isolation (no shared mutable references between workers).
      const copy = structuredClone(envelope);
      emitter.emit('message', copy);
    },
    subscribe(listener) {
      emitter.on('message', listener);
      return () => emitter.off('message', listener);
    },
    listenerCount() {
      return emitter.listenerCount('message');
    },
  };
}

/**
 * Core world bus built over any `{ publish(envelope), subscribe(fn), close?() }` transport.
 */
export function createWorldBus({
  workerId = 'world-0',
  transport,
  secret = randomBytes(32).toString('hex'),
  ticketTtlMs = DEFAULT_TICKET_TTL_MS,
  presenceTtlMs = DEFAULT_PRESENCE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  if (!transport || typeof transport.publish !== 'function' || typeof transport.subscribe !== 'function') {
    throw new TypeError('createWorldBus requires a transport with publish() and subscribe()');
  }
  if (typeof workerId !== 'string' || !workerId.trim()) {
    throw new TypeError('createWorldBus requires a non-empty workerId');
  }
  if (!secret || (typeof secret !== 'string' && !Buffer.isBuffer(secret))) {
    throw new TypeError('createWorldBus requires a non-empty HMAC secret');
  }

  const chatListeners = new Set();
  const presenceListeners = new Set();
  const handoffListeners = new Set();

  // Presence directory: workerId -> { snapshot, receivedAt }
  const presenceByWorker = new Map();

  // Handoff replay protection:
  //   - `pendingHandoffs`: nonce -> { expiresAt, toWorkerId } (announced by origin worker)
  //   - `consumedNonces`:  nonce -> expiresAt (burned once redeemed)
  const pendingHandoffs = new Map();
  const consumedNonces = new Map();

  let closed = false;
  let heartbeatTimer = null;

  function pruneExpired(t = now()) {
    for (const [nonce, exp] of consumedNonces) {
      if (exp <= t) consumedNonces.delete(nonce);
    }
    for (const [nonce, info] of pendingHandoffs) {
      if (info.expiresAt <= t) pendingHandoffs.delete(nonce);
    }
    for (const [wid, rec] of presenceByWorker) {
      if (t - rec.receivedAt > presenceTtlMs) presenceByWorker.delete(wid);
    }
  }

  function handleEnvelope(envelope) {
    if (closed || !envelope || typeof envelope !== 'object') return;
    const t = now();
    switch (envelope.type) {
      case 'chat': {
        for (const entry of chatListeners) {
          if (!entry.includeSelf && envelope.originWorkerId === workerId) continue;
          entry.fn(envelope.payload, envelope);
        }
        break;
      }
      case 'presence': {
        const snap = envelope.payload;
        if (!snap || typeof snap.workerId !== 'string') return;
        presenceByWorker.set(snap.workerId, { snapshot: snap, receivedAt: t });
        for (const fn of presenceListeners) fn(snap, envelope);
        break;
      }
      case 'handoff.issued': {
        const info = envelope.payload;
        if (info && typeof info.nonce === 'string' && Number.isFinite(info.expiresAt)) {
          pendingHandoffs.set(info.nonce, {
            expiresAt: info.expiresAt,
            toWorkerId: info.toWorkerId,
            fromWorkerId: info.fromWorkerId,
          });
          for (const fn of handoffListeners) fn(info, envelope);
        }
        break;
      }
      case 'handoff.consumed': {
        const info = envelope.payload;
        if (info && typeof info.nonce === 'string') {
          pendingHandoffs.delete(info.nonce);
          consumedNonces.set(info.nonce, info.expiresAt ?? t + ticketTtlMs);
        }
        break;
      }
      default:
        break;
    }
  }

  const unsubscribeTransport = transport.subscribe(handleEnvelope);

  async function publishEnvelope(type, payload) {
    if (closed) throw new Error('WorldBus is closed');
    const envelope = {
      v: 1,
      type,
      originWorkerId: workerId,
      sentAt: now(),
      payload,
    };
    await transport.publish(envelope);
    return envelope;
  }

  // ---- 1. Cross-worker chat relay ---------------------------------------------------------------

  async function publishChat(message) {
    if (!message || typeof message !== 'object') throw new TypeError('publishChat requires a message object');
    const channel = String(message.channel ?? '');
    if (!CHAT_CHANNELS.has(channel)) {
      throw new Error(`Unsupported chat relay channel "${channel}" (expected global, region, party, or whisper)`);
    }
    if (typeof message.text !== 'string' || !message.text.trim()) {
      throw new Error('Chat relay message requires non-empty text');
    }
    const payload = {
      channel,
      fromId: message.fromId,
      fromName: String(message.fromName ?? ''),
      text: message.text,
      ...(message.region != null ? { region: String(message.region) } : {}),
      ...(message.partyId != null ? { partyId: String(message.partyId) } : {}),
      ...(message.targetId != null ? { targetId: message.targetId } : {}),
      ...(message.targetName != null ? { targetName: String(message.targetName) } : {}),
      ...(message.location != null ? { location: String(message.location) } : {}),
    };
    return publishEnvelope('chat', payload);
  }

  function onChat(fn, { includeSelf = false } = {}) {
    if (typeof fn !== 'function') throw new TypeError('onChat requires a callback function');
    const entry = { fn, includeSelf };
    chatListeners.add(entry);
    return () => chatListeners.delete(entry);
  }

  // ---- 2. Seamless zone handoff tickets ---------------------------------------------------------

  async function issueHandoff({
    playerId,
    accountId = null,
    name = '',
    toWorkerId,
    targetLocation,
    state = null,
    ttlMs = ticketTtlMs,
  }) {
    if (playerId === undefined || playerId === null) throw new TypeError('issueHandoff requires playerId');
    if (typeof toWorkerId !== 'string' || !toWorkerId.trim()) throw new TypeError('issueHandoff requires toWorkerId');
    if (typeof targetLocation !== 'string' || !targetLocation.trim()) throw new TypeError('issueHandoff requires targetLocation');

    const issuedAt = now();
    const expiresAt = issuedAt + Math.max(1000, Number(ttlMs) || ticketTtlMs);
    const nonce = randomBytes(16).toString('base64url');
    const ticket = {
      v: 1,
      nonce,
      playerId,
      accountId,
      name: String(name),
      fromWorkerId: workerId,
      toWorkerId,
      targetLocation,
      issuedAt,
      expiresAt,
      ...(state !== null ? { state } : {}),
    };
    const encoded = b64urlEncode(JSON.stringify(ticket));
    const sig = signPayload(secret, encoded);
    const token = `${encoded}.${sig}`;

    pendingHandoffs.set(nonce, { expiresAt, toWorkerId, fromWorkerId: workerId });
    await publishEnvelope('handoff.issued', { nonce, fromWorkerId: workerId, toWorkerId, expiresAt });

    return { token, ticket, expiresAt, toWorkerId, targetLocation };
  }

  async function redeemHandoff(token, { expectedWorkerId = workerId } = {}) {
    if (typeof token !== 'string' || !token.includes('.')) {
      throw new Error('Invalid handoff ticket format');
    }
    const dot = token.lastIndexOf('.');
    const encoded = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expectedSig = signPayload(secret, encoded);
    if (!safeEqualString(sig, expectedSig)) {
      throw new Error('Invalid handoff ticket signature');
    }

    let ticket;
    try {
      ticket = JSON.parse(b64urlDecode(encoded).toString('utf8'));
    } catch {
      throw new Error('Corrupt handoff ticket payload');
    }
    if (!ticket || typeof ticket !== 'object' || typeof ticket.nonce !== 'string') {
      throw new Error('Malformed handoff ticket');
    }

    const t = now();
    pruneExpired(t);

    if (typeof ticket.expiresAt !== 'number' || ticket.expiresAt <= t) {
      throw new Error('Handoff ticket expired');
    }
    if (expectedWorkerId && ticket.toWorkerId !== expectedWorkerId) {
      throw new Error(`Handoff ticket targets worker "${ticket.toWorkerId}", not "${expectedWorkerId}"`);
    }
    if (consumedNonces.has(ticket.nonce)) {
      throw new Error('Handoff ticket already redeemed');
    }

    // Burn nonce locally and broadcast consumption to all peers.
    pendingHandoffs.delete(ticket.nonce);
    consumedNonces.set(ticket.nonce, ticket.expiresAt);
    await publishEnvelope('handoff.consumed', {
      nonce: ticket.nonce,
      redeemedBy: workerId,
      expiresAt: ticket.expiresAt,
    });

    return ticket;
  }

  function onHandoff(fn) {
    if (typeof fn !== 'function') throw new TypeError('onHandoff requires a callback function');
    handoffListeners.add(fn);
    return () => handoffListeners.delete(fn);
  }

  // ---- 3. Unified single-world presence directory -----------------------------------------------

  async function publishPresence(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') throw new TypeError('publishPresence requires a snapshot object');
    const normalized = {
      workerId,
      generatedAt: snapshot.generatedAt ?? new Date(now()).toISOString(),
      online: Number.isFinite(snapshot.online) ? snapshot.online : 0,
      unplaced: Number.isFinite(snapshot.unplaced) ? snapshot.unplaced : 0,
      locations: Array.isArray(snapshot.locations) ? snapshot.locations : [],
      ...(Array.isArray(snapshot.zones) ? { zones: snapshot.zones } : {}),
    };
    presenceByWorker.set(workerId, { snapshot: normalized, receivedAt: now() });
    await publishEnvelope('presence', normalized);
    return normalized;
  }

  function getClusterPresence() {
    pruneExpired(now());
    return [...presenceByWorker.values()].map((r) => r.snapshot);
  }

  function getRemoteSnapshots() {
    pruneExpired(now());
    const out = [];
    for (const [wid, rec] of presenceByWorker) {
      if (wid !== workerId) out.push(rec.snapshot);
    }
    return out;
  }

  function onPresence(fn) {
    if (typeof fn !== 'function') throw new TypeError('onPresence requires a callback function');
    presenceListeners.add(fn);
    return () => presenceListeners.delete(fn);
  }

  function startHeartbeat(getSnapshot, intervalMs = Math.max(1000, Math.floor(presenceTtlMs / 3))) {
    stopHeartbeat();
    if (typeof getSnapshot !== 'function') throw new TypeError('startHeartbeat requires a getSnapshot function');
    const beat = () => {
      if (closed) return;
      Promise.resolve(getSnapshot())
        .then((snap) => (snap ? publishPresence(snap) : null))
        .catch(() => {});
    };
    beat();
    heartbeatTimer = setInterval(beat, intervalMs);
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    return stopHeartbeat;
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    stopHeartbeat();
    if (typeof unsubscribeTransport === 'function') unsubscribeTransport();
    chatListeners.clear();
    presenceListeners.clear();
    handoffListeners.clear();
    if (typeof transport.close === 'function') await transport.close();
  }

  return {
    workerId,
    publishChat,
    onChat,
    issueHandoff,
    redeemHandoff,
    onHandoff,
    publishPresence,
    getClusterPresence,
    getRemoteSnapshots,
    onPresence,
    startHeartbeat,
    stopHeartbeat,
    close,
  };
}

/**
 * In-memory WorldBus for single-host multi-worker deployments and tests.
 * Pass the same `hub` (from `createMemoryHub()`) to connect multiple workers.
 */
export function createMemoryBus({ hub = createMemoryHub(), ...options } = {}) {
  const bus = createWorldBus({ ...options, transport: hub });
  bus.hub = hub;
  return bus;
}

/**
 * PostgreSQL `LISTEN`/`NOTIFY` WorldBus for multi-host production deployments.
 *
 * Accepts any `pg`-compatible client (with `query(sql, params?)`, `on('notification', fn)`,
 * `off('notification', fn)`) and an optional separate `publishClient` / `pool` for `pg_notify`.
 * Call `await bus.connect()` before use (or pass `autoListen: false` if already listening).
 */
export function createPostgresBus({
  client,
  publishClient = client,
  channel = DEFAULT_PG_CHANNEL,
  ...options
} = {}) {
  if (!client || typeof client.query !== 'function' || typeof client.on !== 'function') {
    throw new TypeError('createPostgresBus requires a pg-compatible client with query() and on()');
  }
  if (!PG_IDENT_RE.test(channel)) {
    throw new Error(`Invalid PostgreSQL LISTEN channel "${channel}"`);
  }

  const listeners = new Set();
  const onNotification = (msg) => {
    if (!msg || msg.channel !== channel || typeof msg.payload !== 'string') return;
    let envelope;
    try {
      envelope = JSON.parse(msg.payload);
    } catch {
      return;
    }
    for (const fn of listeners) fn(envelope);
  };
  client.on('notification', onNotification);

  const transport = {
    async publish(envelope) {
      const payload = JSON.stringify(envelope);
      const bytes = Buffer.byteLength(payload, 'utf8');
      if (bytes > PG_NOTIFY_MAX_BYTES) {
        throw new Error(`WorldBus PostgreSQL NOTIFY payload too large (${bytes} > ${PG_NOTIFY_MAX_BYTES} bytes)`);
      }
      await publishClient.query('SELECT pg_notify($1, $2)', [channel, payload]);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async close() {
      if (typeof client.off === 'function') client.off('notification', onNotification);
      else if (typeof client.removeListener === 'function') client.removeListener('notification', onNotification);
      try {
        await client.query(`UNLISTEN ${channel}`);
      } catch {
        // Ignore errors if the PG connection is already closing.
      }
      listeners.clear();
    },
  };

  const bus = createWorldBus({ ...options, transport });
  bus.channel = channel;
  bus.connect = async () => {
    await client.query(`LISTEN ${channel}`);
    return bus;
  };
  return bus;
}
