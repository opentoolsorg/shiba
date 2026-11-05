CREATE TABLE IF NOT EXISTS founder_reconciliation_schedules (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,owner_account_id TEXT NOT NULL,owner_json TEXT NOT NULL,
 sample_id TEXT NOT NULL,sample_hash TEXT NOT NULL,sample_digest TEXT NOT NULL,input_json TEXT NOT NULL,sources_json TEXT NOT NULL,
 hub_grant_json TEXT NOT NULL,stripe_grant_json TEXT NOT NULL,contract_json TEXT NOT NULL,digest TEXT NOT NULL,executor_digest TEXT NOT NULL,
 expires_at INTEGER NOT NULL,max_comparisons INTEGER NOT NULL,max_skew_minutes INTEGER NOT NULL,used_comparisons INTEGER NOT NULL DEFAULT 0,
 cutoff_at INTEGER,next_due_at INTEGER,state TEXT NOT NULL CHECK(state IN ('draft','enabled','paused','revoked','exhausted','blocked')),
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS founder_reconciliation_schedule_due ON founder_reconciliation_schedules(state,next_due_at);
CREATE TABLE IF NOT EXISTS founder_reconciliation_schedule_results (
 id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL,hub_receipt_id TEXT NOT NULL,stripe_receipt_id TEXT NOT NULL,slot_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','completed')),expires_at INTEGER NOT NULL,report_json TEXT,report_hash TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
 UNIQUE(schedule_id,hub_receipt_id),UNIQUE(schedule_id,stripe_receipt_id)
);
CREATE INDEX IF NOT EXISTS founder_reconciliation_schedule_result ON founder_reconciliation_schedule_results(schedule_id,state,created_at);
