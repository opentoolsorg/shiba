CREATE TABLE IF NOT EXISTS scheduled_job_slots (
  job_name TEXT NOT NULL,
  slot INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running', 'complete')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY (job_name, slot)
);

CREATE INDEX IF NOT EXISTS scheduled_job_slots_started_at_idx
  ON scheduled_job_slots (started_at);
