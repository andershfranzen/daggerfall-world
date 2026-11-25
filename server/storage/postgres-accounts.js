// PostgreSQL account store matching server/accounts.js's storage and moderation
// contract, using PostgreSQL LISTEN/NOTIFY on 'dfw_moderation' instead of
// SQLite PRAGMA data_version polling for instant cross-process moderation fan-out.
import { usernameKey } from '../accounts.js';
import { createPgPool, loadSchemaSql } from './postgres-game.js';

export const MODERATION_CHANNEL = 'dfw_moderation';
const FOREVER = Number.MAX_SAFE_INTEGER;

function toNum(v) {
  return v === null || v === undefined ? null : Number(v);
}

function normAccount(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    username: row.username,
    username_key: row.username_key,
    password_hash: row.password_hash,
    recovery_hash: row.recovery_hash ?? null,
    created_at: Number(row.created_at),
    last_login_at: toNum(row.last_login_at),
    muted_until: toNum(row.muted_until),
    mute_reason: row.mute_reason ?? null,
    banned_at: toNum(row.banned_at),
    ban_reason: row.ban_reason ?? null,
    ...(row.sessions !== undefined ? { sessions: Number(row.sessions) } : {}),
  };
}

function normSession(row) {
  if (!row) return null;
  return {
    sid: Number(row.sid),
    last_seen_at: Number(row.last_seen_at),
    expires_at: Number(row.expires_at),
    id: Number(row.id),
    username: row.username,
    banned_at: toNum(row.banned_at),
    ...(row.muted_until !== undefined ? { muted_until: toNum(row.muted_until) } : {}),
  };
}

function normModLog(row) {
  return {
    id: Number(row.id),
    account_id: Number(row.account_id),
    action: row.action,
    reason: row.reason ?? null,
    until: toNum(row.until),
    actor: row.actor,
    at: Number(row.at),
  };
}

/**
 * Opens a PostgreSQL-backed account store.
 * Accepts either an injected `pool` or a `connectionString`.
 */
export async function openPostgresAccountStore(options = {}) {
  const {
    connectionString,
    pool: injectedPool = null,
    poolOptions = {},
    applySchema = true,
    schemaSql = null,
    now = () => Date.now(),
  } = options;

  if (!injectedPool && !connectionString) {
    throw new Error('openPostgresAccountStore requires either pool or connectionString');
  }

  const ownsPool = !injectedPool;
  const pool = injectedPool ?? (await createPgPool(connectionString, poolOptions));
  let closed = false;

  // Dedicated client for LISTEN dfw_moderation.
  let listenClient = null;
  let listenHandler = null;
  const moderationListeners = new Set();

  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      throw err;
    } finally {
      client.release();
    }
  }

  async function ensureSchema() {
    const sql = schemaSql ?? loadSchemaSql();
    await transaction(async (client) => {
      await client.query(sql);
    });
  }

  if (applySchema) {
    await ensureSchema();
  }

  async function find(name) {
    const { rows } = await pool.query(
      'SELECT * FROM accounts WHERE username_key = $1',
      [usernameKey(name)],
    );
    return normAccount(rows[0]);
  }

  async function get(id) {
    const { rows } = await pool.query(
      'SELECT * FROM accounts WHERE id = $1',
      [id],
    );
    return normAccount(rows[0]);
  }

  async function requireAccount(name) {
    const acc = await find(name);
    if (!acc) throw new Error(`no account named ${JSON.stringify(name)}`);
    return acc;
  }

  async function notifyModeration(client, payload) {
    await client.query('SELECT pg_notify($1, $2)', [MODERATION_CHANNEL, JSON.stringify(payload)]);
  }

  function dispatchModeration(event) {
    for (const fn of moderationListeners) {
      try {
        fn(event);
      } catch (err) {
        console.error('[postgres-accounts] moderation listener failed:', err.message);
      }
    }
  }

  async function startModerationListener() {
    if (listenClient || closed) return;
    const client = await pool.connect();
    listenClient = client;
    listenHandler = (msg) => {
      if (!msg || msg.channel !== MODERATION_CHANNEL) return;
      let payload;
      try {
        payload = JSON.parse(msg.payload);
      } catch {
        return;
      }
      if (!payload || typeof payload !== 'object') return;
      dispatchModeration({
        ...payload,
        accountId: Number(payload.accountId),
      });
    };
    client.on('notification', listenHandler);
    await client.query(`LISTEN ${MODERATION_CHANNEL}`);
  }

  async function stopModerationListener() {
    if (!listenClient) return;
    const client = listenClient;
    const handler = listenHandler;
    listenClient = null;
    listenHandler = null;
    try {
      if (handler && typeof client.off === 'function') client.off('notification', handler);
      else if (handler && typeof client.removeListener === 'function') client.removeListener('notification', handler);
      await client.query(`UNLISTEN ${MODERATION_CHANNEL}`);
    } catch {
      /* ignore teardown errors */
    } finally {
      client.release();
    }
  }

  return {
    backend: 'postgres',
    channel: MODERATION_CHANNEL,
    pool,
    transaction,
    ensureSchema,

    // ---------------------------------------------------------------- accounts

    find,
    get,

    async createAccount(username, passwordHash, tsOrOptions = now(), recoveryHashArg = undefined) {
      let ts = now();
      let recoveryHash = recoveryHashArg;
      if (tsOrOptions && typeof tsOrOptions === 'object') {
        ts = tsOrOptions.ts ?? now();
        recoveryHash = tsOrOptions.recoveryHash;
      } else if (tsOrOptions !== undefined) {
        ts = tsOrOptions;
      }
      if (recoveryHash !== undefined && recoveryHash !== null) {
        const { rows } = await pool.query(
          `INSERT INTO accounts (username, username_key, password_hash, created_at, recovery_hash)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [username, usernameKey(username), passwordHash, ts, recoveryHash],
        );
        return normAccount(rows[0]);
      }
      const { rows } = await pool.query(
        `INSERT INTO accounts (username, username_key, password_hash, created_at)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [username, usernameKey(username), passwordHash, ts],
      );
      return normAccount(rows[0]);
    },

    async list(ts = now()) {
      const { rows } = await pool.query(
        `SELECT a.*,
                (SELECT COUNT(*) FROM sessions s WHERE s.account_id = a.id AND s.expires_at > $1) AS sessions
           FROM accounts a
          ORDER BY a.id`,
        [ts],
      );
      return rows.map(normAccount);
    },

    async touchLogin(accountId, ts = now()) {
      await pool.query('UPDATE accounts SET last_login_at = $1 WHERE id = $2', [ts, accountId]);
    },

    async setPassword(accountId, passwordHash) {
      const res = await pool.query(
        'UPDATE accounts SET password_hash = $1 WHERE id = $2',
        [passwordHash, accountId],
      );
      return Number(res.rowCount ?? 0);
    },

    async setRecoveryHash(accountId, recoveryHash) {
      const res = await pool.query(
        'UPDATE accounts SET recovery_hash = $1 WHERE id = $2',
        [recoveryHash ?? null, accountId],
      );
      return Number(res.rowCount ?? 0);
    },

    async setPasswordAndRecovery(accountId, passwordHash, recoveryHash) {
      const res = await pool.query(
        'UPDATE accounts SET password_hash = $1, recovery_hash = $2 WHERE id = $3',
        [passwordHash, recoveryHash ?? null, accountId],
      );
      return Number(res.rowCount ?? 0);
    },

    async deleteAccount(accountId) {
      const res = await pool.query('DELETE FROM accounts WHERE id = $1', [accountId]);
      return Number(res.rowCount ?? 0);
    },

    // ---------------------------------------------------------------- sessions

    async createSession(accountId, tokenHash, { ts = now(), ttlMs = 30 * 24 * 3600_000, maxSessions = 10 } = {}) {
      return transaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO sessions (token_hash, account_id, created_at, last_seen_at, expires_at)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [tokenHash, accountId, ts, ts, ts + ttlMs],
        );
        await client.query(
          `DELETE FROM sessions
            WHERE account_id = $1
              AND id NOT IN (
                SELECT id FROM sessions
                 WHERE account_id = $1
                 ORDER BY last_seen_at DESC, id DESC
                 LIMIT $2
              )`,
          [accountId, maxSessions],
        );
        await client.query('UPDATE accounts SET last_login_at = $1 WHERE id = $2', [ts, accountId]);
        return { sid: Number(rows[0].id), expiresAt: ts + ttlMs };
      });
    },

    async getSession(tokenHash) {
      const { rows } = await pool.query(
        `SELECT s.id AS sid, s.last_seen_at, s.expires_at, a.id, a.username, a.banned_at, a.muted_until
           FROM sessions s
           JOIN accounts a ON a.id = s.account_id
          WHERE s.token_hash = $1`,
        [tokenHash],
      );
      return normSession(rows[0]);
    },

    async listSessionIds(accountId) {
      const { rows } = await pool.query(
        'SELECT id FROM sessions WHERE account_id = $1',
        [accountId],
      );
      return rows.map((r) => Number(r.id));
    },

    async listOtherSessionIds(accountId, keepSid) {
      const { rows } = await pool.query(
        'SELECT id FROM sessions WHERE account_id = $1 AND id <> $2',
        [accountId, keepSid],
      );
      return rows.map((r) => Number(r.id));
    },

    async touchSession(sid, lastSeenAt, expiresAt) {
      await pool.query(
        'UPDATE sessions SET last_seen_at = $1, expires_at = $2 WHERE id = $3',
        [lastSeenAt, expiresAt, sid],
      );
    },

    async deleteSessionByToken(tokenHash) {
      const res = await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
      return Number(res.rowCount ?? 0);
    },

    async deleteSessionById(sid) {
      const res = await pool.query('DELETE FROM sessions WHERE id = $1', [sid]);
      return Number(res.rowCount ?? 0);
    },

    async deleteOtherSessions(accountId, keepSid) {
      const res = await pool.query(
        'DELETE FROM sessions WHERE account_id = $1 AND id <> $2',
        [accountId, keepSid],
      );
      return Number(res.rowCount ?? 0);
    },

    async deleteSessionsForAccount(accountId) {
      const res = await pool.query('DELETE FROM sessions WHERE account_id = $1', [accountId]);
      return Number(res.rowCount ?? 0);
    },

    async expireSessions(ts = now()) {
      const res = await pool.query('DELETE FROM sessions WHERE expires_at <= $1', [ts]);
      return Number(res.rowCount ?? 0);
    },

    // Atomic lifecycle helpers used by createPostgresAccounts HTTP handlers.

    async changePasswordAndRevokeOthers(accountId, newPasswordHash, keepSid) {
      return transaction(async (client) => {
        await client.query('UPDATE accounts SET password_hash = $1 WHERE id = $2', [newPasswordHash, accountId]);
        const { rows } = await client.query(
          'SELECT id FROM sessions WHERE account_id = $1 AND id <> $2',
          [accountId, keepSid],
        );
        await client.query('DELETE FROM sessions WHERE account_id = $1 AND id <> $2', [accountId, keepSid]);
        return rows.map((r) => Number(r.id));
      });
    },

    async deleteAccountAndSessions(accountId) {
      return transaction(async (client) => {
        const { rows } = await client.query('SELECT id FROM sessions WHERE account_id = $1', [accountId]);
        await client.query('DELETE FROM accounts WHERE id = $1', [accountId]);
        return rows.map((r) => Number(r.id));
      });
    },

    async revokeAccountSessions(accountId, { reason = null, actor = 'self', ts = now() } = {}) {
      return transaction(async (client) => {
        const { rows: sessRows } = await client.query('SELECT id FROM sessions WHERE account_id = $1', [accountId]);
        await client.query('DELETE FROM sessions WHERE account_id = $1', [accountId]);
        const { rows: logRows } = await client.query(
          `INSERT INTO moderation_log (account_id, action, reason, until, actor, at)
           VALUES ($1, 'revoke', $2, NULL, $3, $4)
           RETURNING id`,
          [accountId, reason, actor, ts],
        );
        const logId = Number(logRows[0].id);
        await notifyModeration(client, {
          id: logId,
          accountId: Number(accountId),
          action: 'revoke',
          reason,
          actor,
          at: ts,
        });
        return { sids: sessRows.map((r) => Number(r.id)), logId };
      });
    },

    async recoverAccount(accountId, newPasswordHash, nextRecoveryHash, { ts = now() } = {}) {
      return transaction(async (client) => {
        const { rows: sessRows } = await client.query('SELECT id FROM sessions WHERE account_id = $1', [accountId]);
        await client.query(
          'UPDATE accounts SET password_hash = $1, recovery_hash = $2 WHERE id = $3',
          [newPasswordHash, nextRecoveryHash, accountId],
        );
        await client.query('DELETE FROM sessions WHERE account_id = $1', [accountId]);
        const { rows: logRows } = await client.query(
          `INSERT INTO moderation_log (account_id, action, reason, until, actor, at)
           VALUES ($1, 'revoke', $2, NULL, $3, $4)
           RETURNING id`,
          [accountId, 'password recovery', 'recovery', ts],
        );
        const logId = Number(logRows[0].id);
        await notifyModeration(client, {
          id: logId,
          accountId: Number(accountId),
          action: 'revoke',
          reason: 'password recovery',
          actor: 'recovery',
          at: ts,
        });
        return { sids: sessRows.map((r) => Number(r.id)), logId };
      });
    },

    // ---------------------------------------------------------------- moderation + LISTEN/NOTIFY

    async muteOf(accountId) {
      const { rows } = await pool.query('SELECT muted_until FROM accounts WHERE id = $1', [accountId]);
      return rows[0] ? toNum(rows[0].muted_until) : null;
    },

    async getMuteUntil(accountId) {
      return this.muteOf(accountId);
    },

    async isMuted(accountId, ts = now()) {
      const until = await this.muteOf(accountId);
      return until !== null && until > ts;
    },

    async mute(name, { minutes = null, reason = null, actor = 'operator', ts = now() } = {}) {
      const acc = await requireAccount(name);
      const until = minutes == null ? FOREVER : ts + Math.round(minutes * 60_000);
      const loggedUntil = until === FOREVER ? null : until;
      const logId = await transaction(async (client) => {
        await client.query(
          'UPDATE accounts SET muted_until = $1, mute_reason = $2 WHERE id = $3',
          [until, reason, acc.id],
        );
        const { rows } = await client.query(
          `INSERT INTO moderation_log (account_id, action, reason, until, actor, at)
           VALUES ($1, 'mute', $2, $3, $4, $5)
           RETURNING id`,
          [acc.id, reason, loggedUntil, actor, ts],
        );
        const id = Number(rows[0].id);
        await notifyModeration(client, {
          id,
          accountId: acc.id,
          action: 'mute',
          reason,
          until: loggedUntil,
          actor,
          at: ts,
        });
        return id;
      });
      return { id: acc.id, username: acc.username, mutedUntil: loggedUntil, logId };
    },

    async unmute(name, { actor = 'operator', ts = now() } = {}) {
      const acc = await requireAccount(name);
      const logId = await transaction(async (client) => {
        await client.query(
          'UPDATE accounts SET muted_until = NULL, mute_reason = NULL WHERE id = $1',
          [acc.id],
        );
        const { rows } = await client.query(
          `INSERT INTO moderation_log (account_id, action, reason, until, actor, at)
           VALUES ($1, 'unmute', NULL, NULL, $2, $3)
           RETURNING id`,
          [acc.id, actor, ts],
        );
        const id = Number(rows[0].id);
        await notifyModeration(client, {
          id,
          accountId: acc.id,
          action: 'unmute',
          actor,
          at: ts,
        });
        return id;
      });
      return { id: acc.id, username: acc.username, logId };
    },

    async ban(name, { reason = null, actor = 'operator', ts = now() } = {}) {
      const acc = await requireAccount(name);
      const logId = await transaction(async (client) => {
        await client.query(
          'UPDATE accounts SET banned_at = $1, ban_reason = $2 WHERE id = $3',
          [ts, reason, acc.id],
        );
        await client.query('DELETE FROM sessions WHERE account_id = $1', [acc.id]);
        const { rows } = await client.query(
          `INSERT INTO moderation_log (account_id, action, reason, until, actor, at)
           VALUES ($1, 'ban', $2, NULL, $3, $4)
           RETURNING id`,
          [acc.id, reason, actor, ts],
        );
        const id = Number(rows[0].id);
        await notifyModeration(client, {
          id,
          accountId: acc.id,
          action: 'ban',
          reason,
          actor,
          at: ts,
        });
        return id;
      });
      return { id: acc.id, username: acc.username, logId };
    },

    async unban(name, { actor = 'operator', ts = now() } = {}) {
      const acc = await requireAccount(name);
      const logId = await transaction(async (client) => {
        await client.query(
          'UPDATE accounts SET banned_at = NULL, ban_reason = NULL WHERE id = $1',
          [acc.id],
        );
        const { rows } = await client.query(
          `INSERT INTO moderation_log (account_id, action, reason, until, actor, at)
           VALUES ($1, 'unban', NULL, NULL, $2, $3)
           RETURNING id`,
          [acc.id, actor, ts],
        );
        const id = Number(rows[0].id);
        await notifyModeration(client, {
          id,
          accountId: acc.id,
          action: 'unban',
          actor,
          at: ts,
        });
        return id;
      });
      return { id: acc.id, username: acc.username, logId };
    },

    async revokeSessions(name, { actor = 'operator', ts = now() } = {}) {
      const acc = await requireAccount(name);
      const { revoked, logId } = await transaction(async (client) => {
        const res = await client.query('DELETE FROM sessions WHERE account_id = $1', [acc.id]);
        const { rows } = await client.query(
          `INSERT INTO moderation_log (account_id, action, reason, until, actor, at)
           VALUES ($1, 'revoke', NULL, NULL, $2, $3)
           RETURNING id`,
          [acc.id, actor, ts],
        );
        const id = Number(rows[0].id);
        await notifyModeration(client, {
          id,
          accountId: acc.id,
          action: 'revoke',
          actor,
          at: ts,
        });
        return { revoked: Number(res.rowCount ?? 0), logId: id };
      });
      return { id: acc.id, username: acc.username, revoked, logId };
    },

    async moderationLogSince(lastId = 0) {
      const { rows } = await pool.query(
        'SELECT id, account_id, action, reason, until, actor, at FROM moderation_log WHERE id > $1 ORDER BY id',
        [lastId],
      );
      return rows.map(normModLog);
    },

    async recentModerationLog(accountId, limit = 20) {
      const { rows } = await pool.query(
        'SELECT id, account_id, action, reason, until, actor, at FROM moderation_log WHERE account_id = $1 ORDER BY id DESC LIMIT $2',
        [accountId, limit],
      );
      return rows.map(normModLog);
    },

    /**
     * Subscribes to cross-process moderation events delivered via PostgreSQL LISTEN/NOTIFY
     * on channel 'dfw_moderation'. Returns an async unsubscribe function.
     */
    async listenModeration(fn) {
      moderationListeners.add(fn);
      await startModerationListener();
      return async () => {
        moderationListeners.delete(fn);
        if (moderationListeners.size === 0) {
          await stopModerationListener();
        }
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      moderationListeners.clear();
      await stopModerationListener();
      if (ownsPool && typeof pool.end === 'function') {
        await pool.end();
      }
    },
  };
}
