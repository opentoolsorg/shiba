-- WS02: durable transactional email outbox (verification, reset, invitations).
CREATE TABLE IF NOT EXISTS email_outbox (
  outbox_id TEXT NOT NULL PRIMARY KEY,
  template_kind TEXT NOT NULL,
  to_address TEXT NOT NULL COLLATE NOCASE,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  meta_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS email_outbox_status_next_idx
  ON email_outbox (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS email_suppressions (
  to_address TEXT NOT NULL PRIMARY KEY COLLATE NOCASE,
  reason TEXT NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);