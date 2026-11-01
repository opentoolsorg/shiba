-- Preserve existing installs while upgrading databases that already applied 0005.
CREATE TABLE skill_installs_owner (
  org_id TEXT NOT NULL,
  library_slug TEXT NOT NULL,
  library_version TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  installed_by TEXT NOT NULL,
  installed_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, installed_by, library_slug)
);

INSERT INTO skill_installs_owner
  (org_id, library_slug, library_version, skill_id, installed_by, installed_at)
SELECT org_id, library_slug, library_version, skill_id, installed_by, installed_at
FROM skill_installs;

DROP TABLE skill_installs;
ALTER TABLE skill_installs_owner RENAME TO skill_installs;
CREATE INDEX skill_installs_org ON skill_installs(org_id, installed_at DESC);
