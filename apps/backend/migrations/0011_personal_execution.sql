CREATE TABLE IF NOT EXISTS personal_execution_grants (
  grant_id TEXT PRIMARY KEY, owner_account_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  snapshot_json TEXT NOT NULL, scope_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS personal_execution_owner_workspace ON personal_execution_grants(owner_account_id, workspace_id, created_at DESC);
