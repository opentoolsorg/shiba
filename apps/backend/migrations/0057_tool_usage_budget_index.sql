CREATE INDEX IF NOT EXISTS agent_tool_usage_run
  ON agent_tool_usage(run_id, tool_name);