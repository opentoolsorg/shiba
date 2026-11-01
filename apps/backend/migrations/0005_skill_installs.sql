CREATE TABLE IF NOT EXISTS skill_installs (
  org_id TEXT NOT NULL,
  library_slug TEXT NOT NULL,
  library_version TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  installed_by TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, installed_by, library_slug)
);

CREATE INDEX IF NOT EXISTS skill_installs_org ON skill_installs(org_id, installed_at DESC);
