-- Replace the dead 0008 workspace_connectors table with the OpenConnector registry.
DROP TABLE IF EXISTS workspace_connectors;

CREATE TABLE workspace_connectors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'openconnector' CHECK (provider = 'openconnector'),
  provider_key TEXT NOT NULL,
  connected_account_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'workspace')),
  archived_at INTEGER,
  archived_by TEXT,
  archived_from_scope TEXT CHECK (
    archived_from_scope IS NULL OR archived_from_scope IN ('personal', 'workspace')
  ),
  workspace_app_connection_id TEXT,
  identity_label TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS workspace_connectors_workspace_view
  ON workspace_connectors(workspace_id, scope, archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS workspace_connectors_workspace_user
  ON workspace_connectors(workspace_id, user_id, archived_at);
CREATE INDEX IF NOT EXISTS workspace_connectors_provider_account
  ON workspace_connectors(workspace_id, provider_key, connected_account_id);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_connectors_active_account
  ON workspace_connectors(workspace_id, user_id, connected_account_id)
  WHERE archived_at IS NULL;