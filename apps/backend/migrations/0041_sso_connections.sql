-- WS02 (optional): per-workspace OIDC SSO connection registry.
CREATE TABLE IF NOT EXISTS sso_connections (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  issuer_url TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret_ciphertext TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, connection_id)
);

CREATE INDEX IF NOT EXISTS sso_connections_workspace_idx
  ON sso_connections (tenant_id, workspace_id, enabled);