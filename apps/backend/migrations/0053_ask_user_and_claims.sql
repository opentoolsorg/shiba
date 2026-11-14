-- Ask-user pauses, task thread binding, run milestones, and repo/branch claims.
CREATE TABLE IF NOT EXISTS ask_user_pending (
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  ask_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','answered','cancelled')),
  answer_json TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  PRIMARY KEY (tenant_id, owner_id, run_id, ask_id)
);

CREATE INDEX IF NOT EXISTS ask_user_pending_open
  ON ask_user_pending(tenant_id, owner_id, status, created_at);

ALTER TABLE team_work_tasks ADD COLUMN room_id TEXT;
ALTER TABLE team_work_tasks ADD COLUMN thread_root_message_id TEXT;

CREATE TABLE IF NOT EXISTS run_milestones (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('ack','status','milestone','result','blocked')),
  text TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE INDEX IF NOT EXISTS run_milestones_recent ON run_milestones(run_id, created_at);

CREATE TABLE IF NOT EXISTS repo_work_claims (
  workspace_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  run_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  room_id TEXT,
  lease_until INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, repo, branch)
);