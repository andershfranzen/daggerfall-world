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
  player_id BIGINT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  slot INTEGER NOT NULL DEFAULT 1 CHECK (slot >= 1),
  username TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  display_name_key TEXT NOT NULL DEFAULT '',
  grandfathered BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  draft BOOLEAN NOT NULL DEFAULT FALSE,
  linked_at BIGINT NOT NULL,
  last_played_at BIGINT,
  last_selected BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at BIGINT,
  purge_after BIGINT,
  UNIQUE (account_id, slot)
);

-- Additive migration for pre-v5 single-slot PostgreSQL databases:
-- converts account_id PK -> player_id PK and backfills existing linked characters into slot 1 as grandfathered.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'account_characters'
       AND column_name = 'slot'
  ) THEN
    ALTER TABLE account_characters DROP CONSTRAINT IF EXISTS account_characters_pkey;
    ALTER TABLE account_characters ADD COLUMN slot INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE account_characters ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE account_characters ADD COLUMN display_name_key TEXT NOT NULL DEFAULT '';
    ALTER TABLE account_characters ADD COLUMN grandfathered BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE account_characters ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE account_characters ADD COLUMN draft BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE account_characters ADD COLUMN last_played_at BIGINT;
    ALTER TABLE account_characters ADD COLUMN last_selected BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE account_characters ADD COLUMN archived_at BIGINT;
    ALTER TABLE account_characters ADD COLUMN purge_after BIGINT;

    UPDATE account_characters a
       SET display_name = p.name,
           display_name_key = LOWER(BTRIM(p.name)),
           grandfathered = TRUE,
           last_played_at = p.last_seen,
           last_selected = TRUE
      FROM players p
     WHERE p.id = a.player_id;

    ALTER TABLE account_characters ADD PRIMARY KEY (player_id);
    ALTER TABLE account_characters ADD CONSTRAINT account_characters_account_slot_key UNIQUE (account_id, slot);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_account_characters_account
  ON account_characters (account_id, slot);

CREATE INDEX IF NOT EXISTS idx_account_characters_name_key
  ON account_characters (display_name_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_account_characters_name_unique
  ON account_characters (display_name_key)
  WHERE NOT grandfathered AND display_name_key <> '';

CREATE INDEX IF NOT EXISTS idx_account_characters_purge
  ON account_characters (status, purge_after)
  WHERE status = 'archived';

CREATE TABLE IF NOT EXISTS world_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS world_state_key_prefix_idx
  ON world_state (key text_pattern_ops);

-- ---------------------------------------------------------------- durable ops, escrow & claims

CREATE TABLE IF NOT EXISTS durable_ops (
  scope_key TEXT NOT NULL,
  op_key TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'committed',
  result JSONB,
  account_id TEXT,
  character_id BIGINT,
  resource_key TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  expires_at BIGINT,
  PRIMARY KEY (scope_key, op_key)
);

CREATE INDEX IF NOT EXISTS idx_durable_ops_account
  ON durable_ops (account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_durable_ops_expires
  ON durable_ops (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS escrow_records (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  owner_account_id TEXT,
  owner_character_id BIGINT,
  counterparty_character_id BIGINT,
  source_ref TEXT,
  gold BIGINT NOT NULL DEFAULT 0,
  item_json JSONB,
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'released', 'settled', 'refunded', 'expired')),
  revision INTEGER NOT NULL DEFAULT 1,
  expires_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_escrow_owner_status
  ON escrow_records (owner_character_id, status);

CREATE INDEX IF NOT EXISTS idx_escrow_counterparty_status
  ON escrow_records (counterparty_character_id, status);

CREATE INDEX IF NOT EXISTS idx_escrow_due
  ON escrow_records (status, expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_escrow_source
  ON escrow_records (source_ref)
  WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS claim_records (
  id TEXT PRIMARY KEY,
  owner_character_id BIGINT NOT NULL,
  owner_account_id TEXT,
  kind TEXT NOT NULL,
  source_ref TEXT,
  gold BIGINT NOT NULL DEFAULT 0,
  item_json JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'expired', 'forfeited')),
  reason TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  expires_at BIGINT,
  created_at BIGINT NOT NULL,
  claimed_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_claims_owner_status
  ON claim_records (owner_character_id, status, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_claims_due
  ON claim_records (status, expires_at)
  WHERE expires_at IS NOT NULL;

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
  body TEXT NOT NULL,
  recipient_ids TEXT          -- JSON array of player ids who received it (sender excluded)
);

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS recipient_ids TEXT;

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
       (4, 'chronicles_hiscores'),
       (5, 'durable_ops_and_character_slots')
ON CONFLICT (version) DO NOTHING;
