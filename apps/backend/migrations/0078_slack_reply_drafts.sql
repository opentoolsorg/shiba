CREATE TABLE slack_reply_drafts (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  source_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  review_dm TEXT NOT NULL,
  body TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_at INTEGER,
  receipt_ts TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent','failed','unknown')),
  UNIQUE (team_id, channel_id, thread_ts, source_id)
);
