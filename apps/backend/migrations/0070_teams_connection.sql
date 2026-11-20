CREATE TABLE IF NOT EXISTS teams_connections (
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  generation TEXT,
  PRIMARY KEY (workspace_id, app_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS teams_installations (
  workspace_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  installed INTEGER NOT NULL CHECK (installed IN (0, 1)),
  event_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, app_id, tenant_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS teams_task_replies (
  thread_key TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  service_url TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  approval_id TEXT UNIQUE,
  card_activity_id TEXT
);
