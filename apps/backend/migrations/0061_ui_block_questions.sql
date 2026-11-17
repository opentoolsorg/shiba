CREATE TABLE IF NOT EXISTS ui_block_questions (
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  block_json TEXT NOT NULL,
  fallback_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','answered','cancelled')),
  answer_json TEXT,
  answered_via TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  PRIMARY KEY (tenant_id, owner_id, run_id, block_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ui_block_questions_one_pending
  ON ui_block_questions(tenant_id, owner_id, run_id) WHERE status='pending';

CREATE INDEX IF NOT EXISTS ui_block_questions_run
  ON ui_block_questions(tenant_id, owner_id, run_id, created_at);
