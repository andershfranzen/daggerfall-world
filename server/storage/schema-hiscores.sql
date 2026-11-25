-- Additive PostgreSQL schema for Chronicles of the Iliac Bay (Hiscores).
-- Safe to append to server/storage/schema.sql or apply directly as an idempotent migration.
-- Timestamps are stored as BIGINT Unix epoch milliseconds to match the SQLite/JS runtime.

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
  ON hiscores (infamy DESC, milestone_at ASC, player_id ASC);

CREATE INDEX IF NOT EXISTS idx_hiscores_admiralty
  ON hiscores (admiralty_score DESC, ships_sunk DESC, milestone_at ASC, player_id ASC);

CREATE INDEX IF NOT EXISTS idx_hiscores_guilds_gin
  ON hiscores USING GIN (guilds);

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

CREATE INDEX IF NOT EXISTS idx_hiscores_orders_member_count
  ON hiscores_orders (member_count DESC, combined_level DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_hiscores_orders_combined_level
  ON hiscores_orders (combined_level DESC, combined_total_skill DESC, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_hiscores_orders_treasury
  ON hiscores_orders (treasury DESC, member_count DESC, created_at ASC);
