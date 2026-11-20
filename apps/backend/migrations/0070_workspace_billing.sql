-- Workspace prepaid credits funded through Stripe Checkout. One account per
-- run store owner; top-ups are keyed by the Checkout Session id so webhook
-- redelivery settles each payment exactly once.
CREATE TABLE IF NOT EXISTS workspace_billing_accounts (
  owner TEXT PRIMARY KEY,
  stripe_customer_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_billing_topups (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  amount_micro_usd INTEGER NOT NULL CHECK(amount_micro_usd > 0),
  status TEXT NOT NULL CHECK(status IN ('pending', 'succeeded', 'failed', 'expired')),
  stripe_payment_intent_id TEXT,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);

CREATE INDEX IF NOT EXISTS workspace_billing_topups_owner ON workspace_billing_topups(owner, created_at);
