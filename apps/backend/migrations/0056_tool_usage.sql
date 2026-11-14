CREATE TABLE IF NOT EXISTS agent_tool_usage (
  org_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0,
  budget_limit INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, run_id, tool_name)
);

CREATE INDEX IF NOT EXISTS agent_tool_usage_updated
  ON agent_tool_usage(updated_at DESC);