CREATE TABLE IF NOT EXISTS workspace_audit_exports (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  export_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  object_key TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, export_id)
);

CREATE INDEX IF NOT EXISTS workspace_audit_exports_workspace ON workspace_audit_exports(tenant_id, workspace_id, created_at DESC);