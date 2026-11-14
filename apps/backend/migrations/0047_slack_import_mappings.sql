-- WS05: Slack history import jobs and idempotent message mapping.

CREATE TABLE IF NOT EXISTS slack_import_jobs (
  job_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  slack_team_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  requested_by_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','completed','cancelled','failed')),
  cursor_ts TEXT,
  imported_count INTEGER NOT NULL DEFAULT 0,
  error_detail TEXT,
  workflow_instance_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS slack_import_jobs_workspace
  ON slack_import_jobs(tenant_id, workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS slack_import_mappings (
  mapping_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES slack_import_jobs(job_id) ON DELETE CASCADE,
  slack_team_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  slack_user_id TEXT,
  shiba_user_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS slack_import_mappings_job
  ON slack_import_mappings(tenant_id, workspace_id, job_id);

CREATE TABLE IF NOT EXISTS slack_imported_messages (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES slack_import_jobs(job_id) ON DELETE CASCADE,
  slack_channel_id TEXT NOT NULL,
  slack_ts TEXT NOT NULL,
  slack_thread_ts TEXT,
  message_id TEXT NOT NULL,
  imported_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, slack_channel_id, slack_ts)
);

CREATE INDEX IF NOT EXISTS slack_imported_messages_job
  ON slack_imported_messages(tenant_id, workspace_id, job_id);