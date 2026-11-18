CREATE TABLE media_generations (
  file_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  mode TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  duration_seconds INTEGER,
  source_file_ids TEXT NOT NULL DEFAULT '[]',
  run_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX media_generations_workspace_created ON media_generations(workspace_id, created_at DESC);
