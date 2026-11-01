CREATE TABLE IF NOT EXISTS capability_invocations (
  invocation_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  idempotency_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('dispatching','succeeded','pending_approval','approved','denied','failed','unknown_outcome')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  approval_id TEXT,
  error_code TEXT,
  UNIQUE (org_id, principal, idempotency_key)
);

CREATE INDEX IF NOT EXISTS capability_invocations_created
  ON capability_invocations(created_at DESC);

CREATE INDEX IF NOT EXISTS capability_invocations_status_updated
  ON capability_invocations(status, updated_at);
