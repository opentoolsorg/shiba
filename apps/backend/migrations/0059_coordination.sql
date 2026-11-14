-- Bot coordination: handoff report-back, one reply per message, primary bot, router decisions.
-- Only this migration number. Do not reuse 0048–0049 or 0058.

CREATE TABLE IF NOT EXISTS collaboration_handoff_returns (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  parent_room_id TEXT NOT NULL,
  parent_thread_root_id TEXT,
  parent_actor_id TEXT NOT NULL,
  child_room_id TEXT NOT NULL,
  child_thread_root_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'reported', 'cancelled')),
  reported_message_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, handoff_id)
);

CREATE INDEX IF NOT EXISTS collaboration_handoff_returns_child
  ON collaboration_handoff_returns(tenant_id, workspace_id, child_room_id, child_thread_root_id, status);

CREATE TABLE IF NOT EXISTS collaboration_reply_claims (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  trigger_message_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  source_slack_event_id TEXT,
  PRIMARY KEY (tenant_id, workspace_id, room_id, trigger_message_id, slot)
);

-- A replayed Slack event shares source_slack_event_id even when the message id differs.
CREATE UNIQUE INDEX IF NOT EXISTS collaboration_reply_claims_slack
  ON collaboration_reply_claims(tenant_id, workspace_id, source_slack_event_id, slot)
  WHERE source_slack_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_primary_bot (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS collaboration_router_decisions (
  decision_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  chosen_actor_id TEXT,
  candidates_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_at INTEGER NOT NULL
);
