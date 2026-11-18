-- Keep acknowledged IDs reserved so retries and legacy imports cannot revive them.
CREATE TABLE thread_queue (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  thread_key TEXT NOT NULL,
  text TEXT NOT NULL,
  client_key TEXT,
  created_at INTEGER NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0,
  UNIQUE (thread_key, client_key)
);
CREATE INDEX thread_queue_pending ON thread_queue (thread_key, acknowledged, sequence);
