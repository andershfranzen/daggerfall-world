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

-- ---------------------------------------------------------------- chronicles / hiscores

CREATE TABLE IF NOT EXISTS hiscores (
  player_id BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  class_name TEXT NOT NULL,
  race TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  total_skill INTEGER NOT NULL DEFAULT 0,
  places_discovered INTEGER NOT NULL DEFAULT 0,
  trips INTEGER NOT NULL DEFAULT 0,
  quests_completed INTEGER NOT NULL DEFAULT 0,
  monsters_slain INTEGER NOT NULL DEFAULT 0,
  infamy INTEGER NOT NULL DEFAULT 0,
  worst_region TEXT,
  admiralty_score INTEGER NOT NULL DEFAULT 0,
  admiralty_rank_title TEXT NOT NULL DEFAULT 'Unsworn',
  ships_sunk INTEGER NOT NULL DEFAULT 0,
  order_id TEXT,
  order_tag TEXT,
  order_name TEXT,
  order_rank TEXT,
  skills JSONB NOT NULL DEFAULT '{}'::jsonb,
  skill_milestones JSONB NOT NULL DEFAULT '{}'::jsonb,
  guilds JSONB NOT NULL DEFAULT '{}'::jsonb,
  milestone_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_hiscores_name_key
  ON hiscores (name_key);
CREATE INDEX IF NOT EXISTS idx_hiscores_overall
  ON hiscores (total_skill DESC, level DESC, milestone_at ASC, player_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_level
  ON hiscores (level DESC, total_skill DESC, milestone_at ASC, player_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_exploration
  ON hiscores (places_discovered DESC, trips DESC, milestone_at ASC, player_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_quests
  ON hiscores (quests_completed DESC, level DESC, milestone_at ASC, player_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_slayer
  ON hiscores (monsters_slain DESC, level DESC, milestone_at ASC, player_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_wanted
  ON hiscores (infamy DESC, level DESC, milestone_at ASC, player_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_admiralty
  ON hiscores (admiralty_score DESC, ships_sunk DESC, milestone_at ASC, player_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_guilds_gin
  ON hiscores USING GIN (guilds jsonb_path_ops);

CREATE TABLE IF NOT EXISTS hiscores_orders (
  order_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  tag TEXT NOT NULL,
  leader_name TEXT NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 0,
  combined_level INTEGER NOT NULL DEFAULT 0,
  combined_total_skill INTEGER NOT NULL DEFAULT 0,
  treasury BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_hiscores_orders_name_key
  ON hiscores_orders (name_key);
CREATE INDEX IF NOT EXISTS idx_hiscores_orders_members
  ON hiscores_orders (member_count DESC, combined_level DESC, order_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_orders_level
  ON hiscores_orders (combined_level DESC, member_count DESC, order_id ASC);
CREATE INDEX IF NOT EXISTS idx_hiscores_orders_treasury
  ON hiscores_orders (treasury DESC, member_count DESC, order_id ASC);

INSERT INTO schema_migrations (version, name)
VALUES (2, 'initial_postgres_schema'),
       (3, 'account_recovery_and_chat_log'),
       (4, 'chronicles_hiscores')
ON CONFLICT (version) DO NOTHING;
