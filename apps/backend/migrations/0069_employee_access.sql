CREATE TABLE IF NOT EXISTS employee_access (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL CHECK(principal_kind IN ('everyone', 'user', 'group')),
  principal_id TEXT NOT NULL,
  principal_name TEXT NOT NULL,
  level TEXT NOT NULL CHECK(level IN ('none', 'view', 'chat', 'manage')),
  PRIMARY KEY(tenant_id, workspace_id, employee_id, principal_kind, principal_id)
);
