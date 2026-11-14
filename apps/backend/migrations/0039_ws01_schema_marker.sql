-- WS01: record that D1 migrations own the Better Auth schema (runtime DDL guard).
CREATE TABLE IF NOT EXISTS shiba_schema_markers (
  marker_id TEXT NOT NULL PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO shiba_schema_markers(marker_id, applied_at)
  VALUES ('ws01_better_auth_v1', unixepoch());