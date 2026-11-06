-- Support cumulative permanent reservation checks across grants.
CREATE INDEX IF NOT EXISTS team_model_money_workspace ON team_model_money_ledger(workspace_id,grant_id);
