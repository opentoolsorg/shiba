-- Durable automation run instances (workflow observability; WS09).
CREATE TABLE IF NOT EXISTS automation_workflow_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workflow_instance_id TEXT,
  command_id TEXT NOT NULL,
  approval_id TEXT,
  run_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('preparing','awaiting_approval','dispatched','terminal','failed','cancelled')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS automation_workflow_runs_automation
  ON automation_workflow_runs(automation_id, created_at);
CREATE INDEX IF NOT EXISTS automation_workflow_runs_command
  ON automation_workflow_runs(command_id);