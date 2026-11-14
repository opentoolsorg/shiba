-- WS07: secondary indexes and multipart upload sessions.

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

CREATE INDEX knowledge_chunks_workspace ON knowledge_chunks(workspace_id, scope);