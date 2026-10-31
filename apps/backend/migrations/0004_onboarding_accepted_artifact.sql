-- Account activation now requires an explicitly approved useful artifact.
-- Existing installations are upgraded by the route's idempotent ensureSchema.
CREATE TABLE IF NOT EXISTS user_onboarding_progress (
  user_id TEXT PRIMARY KEY,
  current_step TEXT NOT NULL DEFAULT 'channels' CHECK (current_step IN ('channels','agent','models','employee')),
  dismissed_at INTEGER,
  connection_verified_at INTEGER,
  first_successful_run_at INTEGER,
  accepted_artifact_at INTEGER,
  activated_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
