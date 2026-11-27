-- Per-user display name for the personal Chief of Staff; absent row means the default name.
CREATE TABLE IF NOT EXISTS chief_of_staff_names (
  owner_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
