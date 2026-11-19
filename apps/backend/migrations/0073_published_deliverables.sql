CREATE TABLE published_deliverables (
  owner_session TEXT NOT NULL,
  run_id TEXT NOT NULL,
  artifact_index INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_count INTEGER NOT NULL,
  PRIMARY KEY (owner_session, run_id, artifact_index)
);

CREATE TABLE retired_deliverable_publication_sessions (
  owner_session TEXT PRIMARY KEY NOT NULL
);
