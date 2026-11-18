-- Background learning review: per-thread turn counts, review cursor,
-- workspace turn setting, employee token usage and large-rewrite
-- suggestions surfaced in Needs you.

CREATE TABLE IF NOT EXISTS learning_settings (
    workspace_id TEXT PRIMARY KEY,
    turn_setting TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE TABLE IF NOT EXISTS learning_threads (
    thread_key TEXT PRIMARY KEY,
    org_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    turns_total INTEGER NOT NULL DEFAULT 0,
    reviewed_through INTEGER NOT NULL DEFAULT 0,
    last_turn_at INTEGER NOT NULL,
    closed_at INTEGER,
    review_lease_until INTEGER
  );

CREATE INDEX IF NOT EXISTS learning_threads_idle ON learning_threads(last_turn_at);

CREATE TABLE IF NOT EXISTS learning_turns (
    thread_key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    run_id TEXT NOT NULL,
    text TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    PRIMARY KEY (thread_key, seq),
    UNIQUE (thread_key, run_id)
  );

CREATE TABLE IF NOT EXISTS learning_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    thread_key TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS learning_usage_employee ON learning_usage(workspace_id, employee_id);

CREATE TABLE IF NOT EXISTS learning_suggestions (
    id TEXT PRIMARY KEY,
    thread_key TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    skill_id TEXT NOT NULL,
    skill_version INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    instructions TEXT NOT NULL,
    dropped_share REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','applied','dismissed')),
    created_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS learning_suggestions_owner ON learning_suggestions(workspace_id, owner_id, status);
