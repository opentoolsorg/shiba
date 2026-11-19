-- Credits and debits as an append-only ledger. A balance is read from these
-- rows only, so clearing run history can never refund spent credits. Every
-- run debit is keyed to its run, so a repeat settle attempt is a no-op.
CREATE TABLE IF NOT EXISTS workspace_billing_debits (
  entry_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  run_id TEXT,
  amount_micro_usd INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('run', 'refund')),
  recorded_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_billing_debits_run
  ON workspace_billing_debits(subject, run_id) WHERE kind = 'run';
CREATE UNIQUE INDEX IF NOT EXISTS workspace_billing_debits_refund
  ON workspace_billing_debits(subject, run_id) WHERE kind = 'refund';
CREATE INDEX IF NOT EXISTS workspace_billing_debits_subject
  ON workspace_billing_debits(subject, recorded_at);

-- Live cost of runs still executing, so a balance covers work in flight across
-- every thread rather than only the one being viewed. Rows are swept by the
-- store that owns the run and expire if that store never comes back.
CREATE TABLE IF NOT EXISTS workspace_billing_pending (
  subject TEXT NOT NULL,
  run_id TEXT NOT NULL,
  amount_micro_usd INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subject, run_id)
);

-- Public top-up ids stop exposing Stripe Checkout Session ids to the dashboard.
ALTER TABLE workspace_billing_topups ADD COLUMN public_id TEXT;
ALTER TABLE workspace_billing_topups ADD COLUMN stripe_session_id TEXT;
ALTER TABLE workspace_billing_topups ADD COLUMN refunded_micro_usd INTEGER NOT NULL DEFAULT 0;
UPDATE workspace_billing_topups SET public_id = 'top_' || id, stripe_session_id = id WHERE public_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS workspace_billing_topups_public ON workspace_billing_topups(public_id);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_billing_topups_session ON workspace_billing_topups(stripe_session_id);
