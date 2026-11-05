-- Private deterministic evidence assembled from explicitly selected completed receipts.
CREATE TABLE IF NOT EXISTS founder_evidence_reports (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_account_id TEXT NOT NULL,
  library_id TEXT NOT NULL, request_id TEXT NOT NULL, report_hash TEXT NOT NULL, manifest_digest TEXT NOT NULL,
  authority_json TEXT NOT NULL, markdown TEXT NOT NULL, json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','revoked')), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(workspace_id,owner_account_id,request_id)
);
CREATE INDEX IF NOT EXISTS founder_evidence_owner ON founder_evidence_reports(workspace_id,owner_account_id,created_at);
