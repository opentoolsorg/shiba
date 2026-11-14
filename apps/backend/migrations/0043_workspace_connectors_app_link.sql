-- Link workspace-shared connectors to explicit workspace app consent rows.
CREATE INDEX IF NOT EXISTS workspace_connectors_app_connection
  ON workspace_connectors(workspace_app_connection_id)
  WHERE workspace_app_connection_id IS NOT NULL;