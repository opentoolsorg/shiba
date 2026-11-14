-- WS05: multiplayer chat v2 — channels, DMs, reactions, pins, saved, threads, notifications.

ALTER TABLE collaboration_rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'room' CHECK (kind IN ('room','channel','dm'));
ALTER TABLE collaboration_rooms ADD COLUMN topic TEXT;
ALTER TABLE collaboration_rooms ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collaboration_rooms ADD COLUMN dm_key TEXT;
ALTER TABLE collaboration_rooms ADD COLUMN slack_import_channel_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS collaboration_rooms_dm_key
  ON collaboration_rooms(tenant_id, workspace_id, dm_key)
  WHERE dm_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS collaboration_rooms_kind
  ON collaboration_rooms(tenant_id, workspace_id, kind, created_at DESC);

ALTER TABLE collaboration_messages ADD COLUMN thread_root_message_id TEXT;
ALTER TABLE collaboration_messages ADD COLUMN reply_to_message_id TEXT;
ALTER TABLE collaboration_messages ADD COLUMN message_seq INTEGER;

CREATE INDEX IF NOT EXISTS collaboration_messages_thread
  ON collaboration_messages(tenant_id, workspace_id, room_id, thread_root_message_id, message_seq);

CREATE TABLE IF NOT EXISTS collaboration_reactions (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, message_id, user_id, emoji),
  FOREIGN KEY (room_id) REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS collaboration_reactions_message
  ON collaboration_reactions(tenant_id, workspace_id, room_id, message_id);

CREATE TABLE IF NOT EXISTS collaboration_pins (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  pinned_by_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, room_id, message_id)
);

CREATE TABLE IF NOT EXISTS collaboration_saved (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, user_id, message_id)
);

CREATE INDEX IF NOT EXISTS collaboration_saved_user
  ON collaboration_saved(tenant_id, workspace_id, user_id, saved_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_thread_follows (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  thread_root_message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, user_id, room_id, thread_root_message_id)
);

CREATE TABLE IF NOT EXISTS collaboration_read_cursors (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  thread_root_message_id TEXT NOT NULL DEFAULT '',
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, user_id, room_id, thread_root_message_id)
);

CREATE TABLE IF NOT EXISTS workspace_notifications (
  notification_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  room_id TEXT,
  message_id TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS workspace_notifications_user
  ON workspace_notifications(tenant_id, workspace_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_notification_prefs (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  prefs_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, user_id)
);