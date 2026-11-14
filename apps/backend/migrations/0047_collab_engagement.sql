-- Reactions, pins, saved messages, thread follows, read cursors, and the inbox.

CREATE TABLE IF NOT EXISTS collaboration_reactions (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, message_id, user_id, emoji)
);

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

CREATE TABLE IF NOT EXISTS collaboration_thread_follows (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  thread_root_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, user_id, room_id, thread_root_id)
);

CREATE TABLE IF NOT EXISTS collaboration_read_cursors (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  thread_root_id TEXT NOT NULL DEFAULT '',
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, user_id, room_id, thread_root_id)
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
