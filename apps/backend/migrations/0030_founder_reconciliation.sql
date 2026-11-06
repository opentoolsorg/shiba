-- Private, explicitly reviewed composition of exact authorized source receipts.
CREATE TABLE IF NOT EXISTS founder_reconciliation_reports (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_account_id TEXT NOT NULL,
 owner_json TEXT NOT NULL, input_json TEXT NOT NULL, sources_json TEXT NOT NULL, digest TEXT NOT NULL, executor_digest TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('draft','completed','revoked')), expires_at INTEGER NOT NULL,
 report_json TEXT, report_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS founder_reconciliation_owner ON founder_reconciliation_reports(workspace_id,owner_account_id,created_at);
