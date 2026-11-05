-- Separate native-owner restricted-key grants; no relation to OAuth or OpenConnector grants.
CREATE TABLE IF NOT EXISTS founder_stripe_read_grants (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_account_id TEXT NOT NULL,
 owner_json TEXT NOT NULL, account_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('test','live')),
 revision INTEGER NOT NULL, expires_at INTEGER NOT NULL, ciphertext TEXT NOT NULL, fingerprint TEXT NOT NULL,
 selection_json TEXT NOT NULL, contract_digest TEXT NOT NULL, executor_digest TEXT NOT NULL, max_calls INTEGER NOT NULL, used_calls INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK(state IN ('draft','verifying','verified','enabled','running','blocked','exhausted','revoked')),
 next_due_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS founder_stripe_read_due ON founder_stripe_read_grants(state,next_due_at);
CREATE TABLE IF NOT EXISTS founder_stripe_read_receipts (
 id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, grant_revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('dispatching','completed','unknown')),
 selection_json TEXT NOT NULL, report_json TEXT, result_digest TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS founder_stripe_read_receipt_grant ON founder_stripe_read_receipts(grant_id,created_at);
