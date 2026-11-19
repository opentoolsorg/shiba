CREATE TABLE learning_check_ins (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  slot INTEGER NOT NULL,
  task_key TEXT NOT NULL,
  task TEXT NOT NULL,
  dismissed_at INTEGER,
  UNIQUE (workspace_id, owner_id, slot),
  UNIQUE (workspace_id, owner_id, task_key)
);
