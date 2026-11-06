-- Full lease reservation is retained after unknown/revoked outcomes until expiry.
-- No command, raw source bytes or credentials are stored in this registry.
CREATE TABLE IF NOT EXISTS run_output_archive_reservations (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_account_id TEXT NOT NULL,
  session_id TEXT NOT NULL, run_id TEXT NOT NULL, sandbox_id TEXT NOT NULL, job_id TEXT NOT NULL,
  digest TEXT NOT NULL, contract_json TEXT NOT NULL, max_bytes INTEGER NOT NULL CHECK(max_bytes=8388608),
  expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('reserved','revoked')), created_at INTEGER NOT NULL,
  UNIQUE(owner_account_id,job_id)
);
CREATE INDEX IF NOT EXISTS run_output_archive_owner ON run_output_archive_reservations(owner_account_id,expires_at);
