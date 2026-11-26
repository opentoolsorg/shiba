-- Per-user dismissals of Needs-you suggestions; a row hides one suggestion id for 7 days.
CREATE TABLE IF NOT EXISTS needs_you_dismissals (
  owner_id TEXT NOT NULL,
  suggestion_id TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, suggestion_id)
);
