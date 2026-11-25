-- PostgreSQL schema for Daggerfall World (game store + accounts store).
-- Additive migrations only; safe to re-apply idempotently on startup.
-- Timestamps are stored as BIGINT Unix epoch milliseconds to match the
-- existing JavaScript/SQLite runtime (including Number.MAX_SAFE_INTEGER for
-- permanent mutes).

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------- game store

CREATE TABLE IF NOT EXISTS players (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  x DOUBLE PRECISION NOT NULL DEFAULT 0,
  z DOUBLE PRECISION NOT NULL DEFAULT 0,
  yaw DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  last_seen BIGINT NOT NULL,
  rpg JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT players_rpg_is_object CHECK (jsonb_typeof(rpg) = 'object')
);

CREATE INDEX IF NOT EXISTS players_last_seen_idx
  ON players (last_seen DESC);

CREATE INDEX IF NOT EXISTS players_rpg_gin_idx
  ON players USING GIN (rpg jsonb_path_ops);

CREATE TABLE IF NOT EXISTS account_characters (
  account_id TEXT PRIMARY KEY,
  player_id BIGINT NOT NULL UNIQUE REFERENCES players(id) ON DELETE CASCADE,
  username TEXT NOT NULL,
  linked_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS world_state_key_prefix_idx
  ON world_state (key text_pattern_ops);

-- ---------------------------------------------------------------- accounts store

CREATE TABLE IF NOT EXISTS accounts (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  username_key TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  recovery_hash TEXT,
  created_at BIGINT NOT NULL,
  last_login_at BIGINT,
  muted_until BIGINT,
  mute_reason TEXT,
  banned_at BIGINT,
  ban_reason TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id BIGSERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_account_idx
  ON sessions (account_id);

CREATE INDEX IF NOT EXISTS sessions_expires_idx
  ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS moderation_log (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  reason TEXT,
  until BIGINT,
  actor TEXT NOT NULL,
  at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS moderation_log_account_idx
  ON moderation_log (account_id, id DESC);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS recovery_hash TEXT;

-- ---------------------------------------------------------------- persistent chat log

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  created_at BIGINT NOT NULL,
  channel TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  sender_player_id BIGINT,
  sender_account_id TEXT,
  sender_name TEXT NOT NULL,
  target_player_id BIGINT,
  target_name TEXT,
  group_id TEXT,
  body TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at
  ON chat_messages (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_sender_account_created
  ON chat_messages (sender_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_sender_name_created
  ON chat_messages (LOWER(sender_name), created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_created
  ON chat_messages (channel, created_at DESC);

INSERT INTO schema_migrations (version, name)
VALUES (2, 'initial_postgres_schema'),
       (3, 'account_recovery_and_chat_log')
ON CONFLICT (version) DO NOTHING;
