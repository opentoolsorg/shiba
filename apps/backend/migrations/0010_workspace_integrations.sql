CREATE TABLE IF NOT EXISTS workspace_app_connections (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, provider_key TEXT NOT NULL, version INTEGER NOT NULL,
  generation INTEGER NOT NULL, state TEXT NOT NULL, issuer_id TEXT NOT NULL, issuer_account_id TEXT NOT NULL, issuer_version INTEGER NOT NULL,
  issuer_role TEXT NOT NULL, pending_id TEXT NOT NULL, pending_expires_at INTEGER NOT NULL, fingerprint TEXT,
  provider_connection_id TEXT, identity_label TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_app_connection_active
  ON workspace_app_connections(workspace_id,provider_key) WHERE state<>'revoked';
CREATE TABLE IF NOT EXISTS workspace_app_grants (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, connection_id TEXT NOT NULL, connection_version INTEGER NOT NULL,
  generation INTEGER NOT NULL, fingerprint TEXT NOT NULL, employee_id TEXT NOT NULL, employee_version INTEGER NOT NULL,
  actor_id TEXT NOT NULL, actor_account_id TEXT NOT NULL, actor_version INTEGER NOT NULL, actor_role TEXT NOT NULL, permissions_json TEXT NOT NULL,
  state TEXT NOT NULL, version INTEGER NOT NULL, manager_id TEXT NOT NULL, manager_account_id TEXT NOT NULL, manager_version INTEGER NOT NULL,
  manager_role TEXT NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(connection_id,employee_id,actor_id)
);
CREATE TABLE IF NOT EXISTS workspace_app_approvals (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, request_id TEXT NOT NULL, requester_id TEXT NOT NULL,
  binding_json TEXT NOT NULL, employee_id TEXT NOT NULL, employee_version INTEGER NOT NULL, employee_name TEXT NOT NULL,
  connection_id TEXT NOT NULL, connection_version INTEGER NOT NULL, action_id TEXT NOT NULL, arguments_json TEXT NOT NULL,
  input_hash TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL, decision_id TEXT, decision_account_id TEXT, decision_version INTEGER,
  decision_role TEXT, decided_at INTEGER, result_json TEXT, error_code TEXT, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, UNIQUE(workspace_id,requester_id,request_id)
);
