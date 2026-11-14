-- WS04: outbound MCP schema (moved off cold-start runtime DDL) + execution log.
-- Replaces dead Overlay-parity tables from 0008_extensions.sql for MCP.

DROP TABLE IF EXISTS mcp_tool_executions;
DROP TABLE IF EXISTS mcp_oauth_sessions;
DROP TABLE IF EXISTS mcp_servers;

-- Legacy runtime shape (no-op when already present) so greenfield migrate can rebuild.
CREATE TABLE IF NOT EXISTS external_mcp_servers (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK(transport='streamable_http'), endpoint TEXT NOT NULL, credential_ref TEXT,
  status TEXT NOT NULL CHECK(status IN ('draft','discovered','reviewed','enabled','disabled','error')),
  generation INTEGER NOT NULL DEFAULT 1, schema_version TEXT, health TEXT NOT NULL DEFAULT 'unknown' CHECK(health IN ('unknown','healthy','error')),
  last_checked_at INTEGER, last_error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  catalog_id TEXT, connection_label TEXT, visibility TEXT NOT NULL DEFAULT 'private', auth_mode TEXT NOT NULL DEFAULT 'bearer_ref'
);
CREATE TABLE IF NOT EXISTS external_mcp_tools (
  id TEXT PRIMARY KEY, server_id TEXT NOT NULL, remote_name TEXT NOT NULL, capability_id TEXT NOT NULL UNIQUE,
  gateway_name TEXT NOT NULL UNIQUE, description TEXT NOT NULL, input_schema_json TEXT NOT NULL, schema_version TEXT NOT NULL,
  effect TEXT NOT NULL CHECK(effect IN ('unreviewed','read','approval_required')), reviewed_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 0, lifecycle TEXT NOT NULL DEFAULT 'active' CHECK(lifecycle IN ('active','revoked')),
  UNIQUE(server_id, remote_name)
);
CREATE TABLE IF NOT EXISTS external_mcp_access (
  org_id TEXT NOT NULL, server_id TEXT NOT NULL, capability_id TEXT NOT NULL, principal TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL,
  PRIMARY KEY(org_id, server_id, capability_id, principal)
);
CREATE TABLE IF NOT EXISTS external_mcp_approval_uses (
  approval_id TEXT PRIMARY KEY, used_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'dispatching'
    CHECK(status IN ('dispatching','succeeded','failed','unknown_outcome')), error_code TEXT
);

CREATE TABLE IF NOT EXISTS external_mcp_oauth_pending (
  state_hash TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  catalog_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_verifier_cipher TEXT NOT NULL,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS external_mcp_oauth_refresh_locks (
  server_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS external_mcp_executions (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  actor TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow','approval_required','deny')),
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','denied')),
  duration_ms INTEGER,
  error_code TEXT,
  arguments_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS external_mcp_executions_server_created
  ON external_mcp_executions(server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS external_mcp_executions_actor_created
  ON external_mcp_executions(actor, created_at DESC);

CREATE TABLE external_mcp_servers_v2 (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport = 'streamable_http'),
  endpoint TEXT NOT NULL,
  credential_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft','discovered','reviewed','enabled','disabled','error')),
  generation INTEGER NOT NULL DEFAULT 1,
  schema_version TEXT,
  health TEXT NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown','healthy','error')),
  last_checked_at INTEGER,
  last_error_code TEXT,
  catalog_id TEXT,
  connection_label TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  auth_mode TEXT NOT NULL DEFAULT 'bearer_ref',
  scope TEXT CHECK (scope IN ('personal','workspace')),
  archived_at INTEGER,
  archived_by TEXT,
  archived_from_scope TEXT CHECK (archived_from_scope IN ('personal','workspace')),
  default_tool_policy TEXT CHECK (default_tool_policy IN ('allow','approval_required','deny')),
  oauth_status TEXT CHECK (oauth_status IN ('pending','connected','needs_reauth')),
  oauth_token_version INTEGER NOT NULL DEFAULT 0,
  timeout_ms INTEGER,
  tool_catalog_updated_at INTEGER,
  tool_catalog_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO external_mcp_servers_v2 (
  id, org_id, owner_id, name, transport, endpoint, credential_ref, status, generation,
  schema_version, health, last_checked_at, last_error_code, catalog_id, connection_label,
  visibility, auth_mode, scope, archived_at, archived_by, archived_from_scope,
  default_tool_policy, oauth_status, oauth_token_version, timeout_ms,
  tool_catalog_updated_at, tool_catalog_error, created_at, updated_at
)
SELECT
  id, org_id, owner_id, name, transport, endpoint, credential_ref, status, generation,
  schema_version, health, last_checked_at, last_error_code, catalog_id, connection_label,
  visibility, auth_mode,
  CASE WHEN visibility = 'workspace' THEN 'workspace' ELSE 'personal' END,
  NULL, NULL, NULL,
  'deny',
  NULL,
  0,
  NULL,
  last_checked_at,
  last_error_code,
  created_at, updated_at
FROM external_mcp_servers
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'external_mcp_servers');

DROP TABLE IF EXISTS external_mcp_servers;
ALTER TABLE external_mcp_servers_v2 RENAME TO external_mcp_servers;

CREATE INDEX IF NOT EXISTS external_mcp_owner ON external_mcp_servers(org_id, owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS external_mcp_workspace_scope ON external_mcp_servers(org_id, scope, archived_at);
CREATE UNIQUE INDEX IF NOT EXISTS external_mcp_catalog_label
  ON external_mcp_servers(org_id, owner_id, catalog_id, connection_label)
  WHERE catalog_id IS NOT NULL AND connection_label IS NOT NULL AND status <> 'disabled';

CREATE TABLE external_mcp_tools_v2 (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  remote_name TEXT NOT NULL,
  capability_id TEXT NOT NULL UNIQUE,
  gateway_name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  input_schema_json TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('unreviewed','read','approval_required')),
  policy TEXT NOT NULL DEFAULT 'deny' CHECK (policy IN ('allow','approval_required','deny')),
  reviewed_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 0,
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','revoked')),
  UNIQUE(server_id, remote_name)
);

INSERT INTO external_mcp_tools_v2 (
  id, server_id, remote_name, capability_id, gateway_name, description,
  input_schema_json, schema_version, effect, policy, reviewed_at, enabled, lifecycle
)
SELECT
  id, server_id, remote_name, capability_id, gateway_name, description,
  input_schema_json, schema_version, effect,
  CASE effect
    WHEN 'read' THEN 'allow'
    WHEN 'approval_required' THEN 'approval_required'
    ELSE 'deny'
  END,
  reviewed_at, enabled, lifecycle
FROM external_mcp_tools
WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'external_mcp_tools');

DROP TABLE IF EXISTS external_mcp_tools;
ALTER TABLE external_mcp_tools_v2 RENAME TO external_mcp_tools;

CREATE INDEX IF NOT EXISTS external_mcp_tools_server ON external_mcp_tools(server_id, enabled, lifecycle);