-- Outbound webhook subscriptions and delivery attempts (WS09).
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  url TEXT NOT NULL,
  events_json TEXT NOT NULL,
  secret_key_id TEXT NOT NULL,
  secret_cipher TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_subscriptions_workspace
  ON webhook_subscriptions(workspace_id, active);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('pending','delivered','failed','dead_letter')),
  response_code INTEGER,
  response_body TEXT,
  next_attempt_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(subscription_id) REFERENCES webhook_subscriptions(id)
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_subscription
  ON webhook_deliveries(subscription_id, created_at);
CREATE INDEX IF NOT EXISTS webhook_deliveries_retry
  ON webhook_deliveries(status, next_attempt_at);