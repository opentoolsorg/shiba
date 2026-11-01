CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','review','active','disabled')),
  active_version INTEGER,
  reviewed_version INTEGER,
  reviewed_instructions TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS skills_org_status_updated ON skills(org_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS skills_owner_updated ON skills(org_id, owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS skill_versions (
  skill_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  source_url TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (skill_id, version)
);
