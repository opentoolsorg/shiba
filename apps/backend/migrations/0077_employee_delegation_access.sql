CREATE TABLE employee_delegation_access (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  allowed_employee_ids_json TEXT NOT NULL,
  PRIMARY KEY(tenant_id, workspace_id, employee_id)
);
