-- The existing `skills` table stores Shiba's reviewed, versioned authored
-- skills. Overlay's extension skills have a different lifecycle and shape, so
-- they use `extension_skills` instead of colliding with that deployed table.
CREATE TABLE IF NOT EXISTS extension_skills (
  id TEXT PRIMARY KEY,
  scope TEXT CHECK (scope IN ('personal','workspace')),
  archived_at INTEGER,
  archived_by TEXT,
  archived_from_scope TEXT CHECK (archived_from_scope IN ('personal','workspace')),
  workspace_id TEXT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  enabled INTEGER CHECK (enabled IN (0,1)),
  version INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS extension_skills_workspace_scope_archived
  ON extension_skills(workspace_id, scope, archived_at);
CREATE INDEX IF NOT EXISTS extension_skills_workspace_user_archived
  ON extension_skills(workspace_id, user_id, archived_at);
CREATE INDEX IF NOT EXISTS extension_skills_workspace
  ON extension_skills(workspace_id);
CREATE INDEX IF NOT EXISTS extension_skills_workspace_user
  ON extension_skills(workspace_id, user_id);
CREATE INDEX IF NOT EXISTS extension_skills_user
  ON extension_skills(user_id);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  scope TEXT CHECK (scope IN ('personal','workspace')),
  archived_at INTEGER,
  archived_by TEXT,
  archived_from_scope TEXT CHECK (archived_from_scope IN ('personal','workspace')),
  workspace_id TEXT,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  transport TEXT NOT NULL CHECK (transport IN ('sse','streamable-http')),
  url TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  auth_type TEXT NOT NULL CHECK (auth_type IN ('none','bearer','header','oauth')),
  auth_config_json TEXT,
  encrypted_auth_config TEXT,
  oauth_status TEXT CHECK (oauth_status IN ('pending','connected','needs_reauth')),
  encrypted_oauth_tokens TEXT,
  encrypted_oauth_client TEXT,
  oauth_client_id TEXT,
  oauth_issuer TEXT,
  oauth_scope TEXT,
  oauth_resource TEXT,
  oauth_connected_at INTEGER,
  oauth_error TEXT,
  oauth_token_version INTEGER,
  timeout_ms INTEGER,
  default_tool_policy TEXT CHECK (default_tool_policy IN ('allow','approval_required','deny')),
  tool_policies_json TEXT,
  tool_catalog_json TEXT,
  tool_catalog_updated_at INTEGER,
  tool_catalog_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_servers_workspace_scope_archived
  ON mcp_servers(workspace_id, scope, archived_at);
CREATE INDEX IF NOT EXISTS mcp_servers_workspace_user_archived
  ON mcp_servers(workspace_id, user_id, archived_at);
CREATE INDEX IF NOT EXISTS mcp_servers_workspace
  ON mcp_servers(workspace_id);
CREATE INDEX IF NOT EXISTS mcp_servers_workspace_user
  ON mcp_servers(workspace_id, user_id);
CREATE INDEX IF NOT EXISTS mcp_servers_user
  ON mcp_servers(user_id);
CREATE INDEX IF NOT EXISTS mcp_servers_user_enabled
  ON mcp_servers(user_id, enabled);

CREATE TABLE IF NOT EXISTS workspace_connectors (
  id TEXT PRIMARY KEY,
  scope TEXT CHECK (scope IN ('personal','workspace')),
  archived_at INTEGER,
  archived_by TEXT,
  archived_from_scope TEXT CHECK (archived_from_scope IN ('personal','workspace')),
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  connected_account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_connectors_workspace_scope_archived
  ON workspace_connectors(workspace_id, scope, archived_at);
CREATE INDEX IF NOT EXISTS workspace_connectors_workspace_user_archived
  ON workspace_connectors(workspace_id, user_id, archived_at);
CREATE INDEX IF NOT EXISTS workspace_connectors_workspace
  ON workspace_connectors(workspace_id);
CREATE INDEX IF NOT EXISTS workspace_connectors_workspace_provider
  ON workspace_connectors(workspace_id, provider_key);
CREATE INDEX IF NOT EXISTS workspace_connectors_workspace_user_provider
  ON workspace_connectors(workspace_id, user_id, provider_key);
CREATE INDEX IF NOT EXISTS workspace_connectors_user
  ON workspace_connectors(user_id);

CREATE TABLE IF NOT EXISTS mcp_oauth_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  mcp_server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  encrypted_code_verifier TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('web','desktop')),
  return_to TEXT,
  session_binding_hash TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_oauth_sessions_user ON mcp_oauth_sessions(user_id);
CREATE INDEX IF NOT EXISTS mcp_oauth_sessions_server ON mcp_oauth_sessions(mcp_server_id);
CREATE INDEX IF NOT EXISTS mcp_oauth_sessions_expires ON mcp_oauth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS mcp_tool_executions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  mcp_server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  arguments_hash TEXT NOT NULL,
  policy_decision TEXT NOT NULL CHECK (policy_decision IN ('allow','approval_required','deny')),
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','denied')),
  conversation_id TEXT,
  turn_id TEXT,
  model_id TEXT,
  duration_ms INTEGER,
  error_message TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_tool_executions_user_created
  ON mcp_tool_executions(user_id, created_at);
CREATE INDEX IF NOT EXISTS mcp_tool_executions_server_created
  ON mcp_tool_executions(mcp_server_id, created_at);
