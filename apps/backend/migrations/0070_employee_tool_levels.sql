CREATE TABLE IF NOT EXISTS employee_tool_levels (
  org_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('ask', 'auto', 'off')),
  set_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(org_id, employee_id, capability_id)
);

ALTER TABLE employee_tool_approvals ADD COLUMN level_at_decision TEXT;
ALTER TABLE employee_tool_approvals ADD COLUMN level_at_execution TEXT;

CREATE INDEX IF NOT EXISTS employee_tool_approvals_decided
    ON employee_tool_approvals(org_id, employee_id, capability_id, status, decided_at DESC);
