-- WS04: inbound MCP connected-app grants (OAuth + static token clients).

CREATE TABLE IF NOT EXISTS mcp_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT,
  access TEXT NOT NULL CHECK (access IN ('read','write','full')),
  kind TEXT NOT NULL CHECK (kind IN ('oauth','token')),
  client_name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  code_id TEXT,
  refresh_version INTEGER NOT NULL DEFAULT 0,
  rotated_refresh_hash TEXT,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_grants_user_revoked ON mcp_grants(user_id, revoked_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS mcp_grants_workspace_user ON mcp_grants(workspace_id, user_id);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_grants_oauth_client
  ON mcp_grants(user_id, client_id, kind)
  WHERE kind = 'oauth' AND revoked_at IS NULL;

INSERT OR IGNORE INTO shiba_schema_markers(marker_id, applied_at)
  VALUES ('ws04_external_mcp_v2', unixepoch());
INSERT OR IGNORE INTO shiba_schema_markers(marker_id, applied_at)
  VALUES ('ws04_mcp_grants_v1', unixepoch());