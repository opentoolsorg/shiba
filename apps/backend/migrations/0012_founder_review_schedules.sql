-- Storage-only private review drafts. No executable automation or billing grant.
CREATE TABLE IF NOT EXISTS founder_review_schedules (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_account_id TEXT NOT NULL, library_id TEXT NOT NULL,
  version INTEGER NOT NULL, digest TEXT NOT NULL, contract_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','enabled','paused','revoked','blocked')),
  review_expires_at INTEGER NOT NULL, next_due_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL, blocked_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(org_id,owner_account_id,library_id)
);
CREATE INDEX IF NOT EXISTS founder_review_due ON founder_review_schedules(state,checked_at);
CREATE TABLE IF NOT EXISTS founder_review_occurrences (
  id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, schedule_version INTEGER NOT NULL,
  digest TEXT NOT NULL, scheduled_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','dismissed','cancelled')), task TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS founder_review_pending ON founder_review_occurrences(schedule_id,status);
