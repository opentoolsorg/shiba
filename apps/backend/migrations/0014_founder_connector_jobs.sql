-- One exact, individually human-approved connector operation per occurrence.
CREATE TABLE IF NOT EXISTS founder_connector_jobs (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_account_id TEXT NOT NULL,
  library_id TEXT NOT NULL, member_version INTEGER NOT NULL, member_role TEXT NOT NULL,
  version INTEGER NOT NULL, digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','enabled','paused','revoked','blocked')),
  contract_json TEXT NOT NULL, source_json TEXT NOT NULL, binding_json TEXT NOT NULL, recipe_sha256 TEXT NOT NULL,
  expires_at INTEGER NOT NULL, review_expires_at INTEGER NOT NULL, next_due_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL, blocked_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id,owner_account_id,library_id)
);
CREATE INDEX IF NOT EXISTS founder_connector_jobs_tick ON founder_connector_jobs(state,checked_at);
CREATE TABLE IF NOT EXISTS founder_connector_occurrences (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, plan_version INTEGER NOT NULL, digest TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  request_id TEXT NOT NULL UNIQUE, approval_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('open','cancelled','expired')),
  UNIQUE(plan_id,plan_version,scheduled_at)
);
CREATE INDEX IF NOT EXISTS founder_connector_occurrences_plan ON founder_connector_occurrences(plan_id,state);
