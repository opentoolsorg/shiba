CREATE TABLE IF NOT EXISTS workspace_channel_facts (
    id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    fact TEXT NOT NULL CHECK(length(trim(fact)) > 0 AND length(fact) <= 500),
    created_by TEXT NOT NULL,
    source_channel TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(team_id, connection_id, fact)
);
CREATE INDEX IF NOT EXISTS workspace_channel_facts_scope
    ON workspace_channel_facts(team_id, connection_id);
