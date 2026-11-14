-- Notes stored as markdown in FILES, indexed for the same ingestion path.

CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('personal', 'workspace')),
  title TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  project_id TEXT,
  version INTEGER NOT NULL CHECK(version > 0),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  ingestion_state TEXT NOT NULL DEFAULT 'pending'
    CHECK(ingestion_state IN ('pending', 'processing', 'done', 'failed')),
  ingestion_error TEXT
);
CREATE INDEX notes_workspace ON notes(workspace_id, scope, updated_at DESC);

CREATE TABLE knowledge_projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX knowledge_projects_workspace ON knowledge_projects(workspace_id, created_at DESC);
