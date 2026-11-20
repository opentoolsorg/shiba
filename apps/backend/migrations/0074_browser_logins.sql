CREATE TABLE browser_logins (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  scope_id TEXT NOT NULL,
  label TEXT NOT NULL,
  origin TEXT NOT NULL,
  username TEXT NOT NULL,
  password_ciphertext TEXT NOT NULL,
  totp_ciphertext TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_browser_logins_scope ON browser_logins (scope, scope_id, updated_at DESC);
