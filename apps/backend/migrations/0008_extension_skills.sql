CREATE TABLE IF NOT EXISTS extension_skills (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  workspace_id TEXT,
  scope TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal','workspace')),
  archived_at INTEGER,
  archived_by TEXT,
  archived_from_scope TEXT CHECK (archived_from_scope IS NULL OR archived_from_scope IN ('personal','workspace')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  enabled INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS extension_skills_org_scope_updated
  ON extension_skills(org_id, scope, archived_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS extension_skills_owner_updated
  ON extension_skills(org_id, owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS extension_skills_workspace_scope
  ON extension_skills(workspace_id, scope, archived_at);
