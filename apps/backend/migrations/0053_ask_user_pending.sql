-- WS08: durable ask_user pause records until answered (receipt written on resume).
CREATE TABLE IF NOT EXISTS ask_user_pending (
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  ask_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','answered','cancelled')),
  answer_json TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  PRIMARY KEY (tenant_id, owner_id, run_id, ask_id)
);

CREATE INDEX IF NOT EXISTS ask_user_pending_open
  ON ask_user_pending(tenant_id, owner_id, status, created_at);