-- Money v2: permanent authorized USD envelopes, never provider invoices or refunds.
CREATE TABLE IF NOT EXISTS team_model_money_ledger (
  turn_id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,input_hash TEXT NOT NULL,quote_digest TEXT NOT NULL,
  reserved_micro_usd INTEGER NOT NULL CHECK(reserved_micro_usd>0 AND reserved_micro_usd<=8341),
  state TEXT NOT NULL CHECK(state IN ('held','confirmed','unknown')),reported_micro_usd INTEGER,
  receipt_hash TEXT,receipt_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
  CHECK(reported_micro_usd IS NULL OR (reported_micro_usd>=0 AND reported_micro_usd<=reserved_micro_usd)));
CREATE INDEX IF NOT EXISTS team_model_money_grant ON team_model_money_ledger(grant_id,state);
