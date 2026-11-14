-- Files, folders, upload sessions, ingestion jobs, and search chunks.

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('personal', 'workspace')),
  parent_id TEXT,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX folders_workspace ON folders(workspace_id, scope, parent_id);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('personal', 'workspace')),
  folder_id TEXT,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  project_id TEXT,
  archived_at INTEGER,
  archived_by TEXT,
  created_by TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ingestion_state TEXT NOT NULL DEFAULT 'pending'
    CHECK(ingestion_state IN ('pending', 'processing', 'done', 'failed')),
  ingestion_error TEXT
);
CREATE INDEX files_workspace ON files(workspace_id, scope, folder_id, updated_at DESC);
CREATE UNIQUE INDEX files_r2_key ON files(r2_key);

CREATE TABLE file_upload_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('personal', 'workspace')),
  folder_id TEXT,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  r2_upload_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX file_upload_sessions_expiry ON file_upload_sessions(expires_at);

CREATE TABLE ingestion_jobs (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('file', 'note')),
  source_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'processing', 'done', 'failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(source_kind, source_id, sha256, version)
);
CREATE INDEX ingestion_jobs_pending ON ingestion_jobs(state, updated_at);

CREATE TABLE knowledge_chunks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('personal', 'workspace')),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('file', 'note')),
  source_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX knowledge_chunks_source ON knowledge_chunks(source_kind, source_id, version, ordinal);
CREATE INDEX knowledge_chunks_workspace ON knowledge_chunks(workspace_id, scope);

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  chunk_id UNINDEXED,
  workspace_id UNINDEXED,
  scope UNINDEXED,
  source_kind UNINDEXED,
  source_id UNINDEXED,
  text,
  tokenize = 'porter'
);
