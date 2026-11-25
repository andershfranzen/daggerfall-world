-- Additive PostgreSQL schema for persistent server-side in-game chat logging
-- (moderation, abuse investigation, and player safety).
-- Append to server/storage/schema.sql or apply directly as an additive migration.

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  created_at BIGINT NOT NULL, -- UTC epoch milliseconds
  channel TEXT NOT NULL,      -- say | shout | party | region | global | whisper | emote | guild | order | location
  location TEXT NOT NULL DEFAULT '',
  sender_player_id BIGINT,
  sender_account_id TEXT,
  sender_name TEXT NOT NULL,
  target_player_id BIGINT,
  target_name TEXT,
  group_id TEXT,              -- party id, guild id, or order id when applicable
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
