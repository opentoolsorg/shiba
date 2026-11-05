-- Separate scheduler principals and explicit standing read grants. Never human action approvals.
CREATE TABLE IF NOT EXISTS founder_automatic_read_grants (
  id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,owner_account_id TEXT NOT NULL,library_id TEXT NOT NULL,
  version INTEGER NOT NULL,digest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('draft','enabled','paused','revoked','blocked','exhausted')),
  contract_json TEXT NOT NULL,pins_json TEXT NOT NULL,review_expires_at INTEGER NOT NULL,next_due_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,used_occurrences INTEGER NOT NULL DEFAULT 0,reserved_calls INTEGER NOT NULL DEFAULT 0,reserved_bytes INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(workspace_id,owner_account_id,library_id)
);
CREATE INDEX IF NOT EXISTS founder_automatic_read_due ON founder_automatic_read_grants(state,checked_at);
CREATE TABLE IF NOT EXISTS founder_automatic_read_occurrences (
  id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,grant_version INTEGER NOT NULL,grant_digest TEXT NOT NULL,scheduled_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','claimed','running','completed','partial','failed','unknown','cancelled','blocked')),
  step_count INTEGER NOT NULL,lease_id TEXT,lease_expires_at INTEGER,error TEXT,report_hash TEXT,report_sources_json TEXT,markdown TEXT,json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
  UNIQUE(grant_id,grant_version,scheduled_at)
);
CREATE TABLE IF NOT EXISTS founder_automatic_read_steps (
  id TEXT PRIMARY KEY,occurrence_id TEXT NOT NULL,ordinal INTEGER NOT NULL,nonce TEXT NOT NULL,digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','submitted','claimed','dispatching','completed','failed','unknown','cancelled')),
  request_json TEXT,request_digest TEXT,expires_at INTEGER,claim_used INTEGER NOT NULL DEFAULT 0,dispatch_used INTEGER NOT NULL DEFAULT 0,complete_used INTEGER NOT NULL DEFAULT 0,
  receipt_json TEXT,updated_at INTEGER NOT NULL,UNIQUE(occurrence_id,ordinal)
);
CREATE INDEX IF NOT EXISTS founder_automatic_read_step_occurrence ON founder_automatic_read_steps(occurrence_id,ordinal);
