-- Base collaboration tables. Fresh databases need these before later ALTERs.

CREATE TABLE IF NOT EXISTS collaboration_rooms (
    room_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('private','shared')),
    created_by_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS collaboration_rooms_scope ON collaboration_rooms(tenant_id, workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_memberships (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human','agent')),
    role TEXT NOT NULL CHECK (role IN ('owner','member','agent')),
    status TEXT NOT NULL CHECK (status IN ('active','removed')),
    capabilities_json TEXT NOT NULL,
    profile_version INTEGER,
    created_at INTEGER NOT NULL,
    removed_at INTEGER,
    PRIMARY KEY (tenant_id, workspace_id, room_id, actor_id)
  );

CREATE INDEX IF NOT EXISTS collaboration_memberships_user ON collaboration_memberships(tenant_id, workspace_id, user_id, status, room_id);

CREATE TABLE IF NOT EXISTS collaboration_messages (
    message_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE,
    sender_user_id TEXT NOT NULL,
    sender_actor_id TEXT NOT NULL,
    sender_kind TEXT NOT NULL CHECK (sender_kind IN ('human','agent')),
    body TEXT NOT NULL,
    profile_version INTEGER,
    source_run_id TEXT,
    source_handoff_id TEXT,
    source_artifact_refs_json TEXT,
    source_slack_event_id TEXT,
    source_slack_team_id TEXT,
    source_slack_channel_id TEXT,
    source_slack_thread_ts TEXT,
    source_slack_user_id TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (tenant_id, workspace_id, room_id, sender_actor_id)
      REFERENCES collaboration_memberships(tenant_id, workspace_id, room_id, actor_id),
    PRIMARY KEY (tenant_id, workspace_id, message_id)
  );

CREATE INDEX IF NOT EXISTS collaboration_messages_room ON collaboration_messages(tenant_id, workspace_id, room_id, created_at, message_id);

CREATE TABLE IF NOT EXISTS collaboration_handoff_budgets (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    root_handoff_id TEXT NOT NULL,
    remaining INTEGER NOT NULL CHECK (remaining >= 0),
    last_spend_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, room_id, task_id, root_handoff_id),
    FOREIGN KEY (room_id) REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE
  );

CREATE TABLE IF NOT EXISTS collaboration_handoffs (
    handoff_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE,
    task_id TEXT NOT NULL,
    sender_user_id TEXT NOT NULL,
    sender_actor_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    recipient_actor_id TEXT NOT NULL,
    parent_handoff_id TEXT,
    root_handoff_id TEXT NOT NULL,
    depth INTEGER NOT NULL CHECK (depth BETWEEN 0 AND 4),
    ancestor_handoff_ids_json TEXT NOT NULL,
    remaining_budget INTEGER NOT NULL CHECK (remaining_budget BETWEEN 0 AND 32),
    granted_capabilities_json TEXT NOT NULL,
    profile_version INTEGER,
    status TEXT NOT NULL CHECK (status IN ('active','cancelled')),
    created_at INTEGER NOT NULL,
    cancelled_at INTEGER,
    approval_id TEXT,
    run_id TEXT,
    FOREIGN KEY (tenant_id, workspace_id, room_id, sender_actor_id)
      REFERENCES collaboration_memberships(tenant_id, workspace_id, room_id, actor_id),
    FOREIGN KEY (tenant_id, workspace_id, room_id, recipient_actor_id)
      REFERENCES collaboration_memberships(tenant_id, workspace_id, room_id, actor_id),
    FOREIGN KEY (tenant_id, workspace_id, parent_handoff_id)
      REFERENCES collaboration_handoffs(tenant_id, workspace_id, handoff_id),
    PRIMARY KEY (tenant_id, workspace_id, handoff_id)
  );

CREATE INDEX IF NOT EXISTS collaboration_handoffs_parent ON collaboration_handoffs(tenant_id, workspace_id, room_id, parent_handoff_id, created_at);

CREATE TABLE IF NOT EXISTS collaboration_slack_observations (
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    last_event_id TEXT NOT NULL,
    last_user_id TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, workspace_id, team_id, channel_id, thread_ts)
  );

CREATE TABLE IF NOT EXISTS collaboration_slack_room_links (
    link_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    room_id TEXT NOT NULL REFERENCES collaboration_rooms(room_id) ON DELETE CASCADE,
    owner_user_id TEXT NOT NULL,
    team_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','revoked')),
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    PRIMARY KEY (tenant_id, workspace_id, link_id)
  );

CREATE UNIQUE INDEX IF NOT EXISTS collaboration_slack_one_active_link ON collaboration_slack_room_links(tenant_id,workspace_id,team_id,channel_id,thread_ts) WHERE status='active';

CREATE INDEX IF NOT EXISTS collaboration_slack_links_room ON collaboration_slack_room_links(tenant_id,workspace_id,room_id,status,created_at DESC);

CREATE TABLE IF NOT EXISTS collaboration_slack_delivery_intents (
    intent_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    link_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    team_id TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    content_hash TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('pending','blocked')),
    delivery_status TEXT NOT NULL DEFAULT 'awaiting_approval',
    created_at INTEGER NOT NULL,
    approved_by_user_id TEXT,
    approved_at INTEGER,
    receipt_ts TEXT,
    outcome_detail TEXT,
    PRIMARY KEY (tenant_id, workspace_id, intent_id),
    UNIQUE (tenant_id, workspace_id, message_id, link_id)
  );

CREATE INDEX IF NOT EXISTS collaboration_slack_intents_room ON collaboration_slack_delivery_intents(tenant_id,workspace_id,room_id,created_at DESC);

-- Thread model on messages and roots.
ALTER TABLE collaboration_messages ADD COLUMN thread_root_id TEXT;
ALTER TABLE collaboration_messages ADD COLUMN message_kind TEXT NOT NULL DEFAULT 'text'
  CHECK (message_kind IN ('text','ack','status','milestone','approval_card','question_card','handoff','handoff_report','result','system'));
ALTER TABLE collaboration_messages ADD COLUMN payload_json TEXT;
ALTER TABLE collaboration_messages ADD COLUMN edited_at INTEGER;
ALTER TABLE collaboration_messages ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE collaboration_messages ADD COLUMN seq INTEGER;
ALTER TABLE collaboration_messages ADD COLUMN also_in_channel INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collaboration_messages ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collaboration_messages ADD COLUMN last_reply_at INTEGER;
ALTER TABLE collaboration_messages ADD COLUMN participant_actor_ids_json TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS collaboration_messages_thread
  ON collaboration_messages(tenant_id, workspace_id, room_id, thread_root_id, seq);

-- Room kinds, DMs, and who an agent listens to.
ALTER TABLE collaboration_rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'room' CHECK (kind IN ('room','channel','dm'));
ALTER TABLE collaboration_rooms ADD COLUMN topic TEXT;
ALTER TABLE collaboration_rooms ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collaboration_rooms ADD COLUMN dm_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS collaboration_rooms_dm_key
  ON collaboration_rooms(tenant_id, workspace_id, dm_key)
  WHERE dm_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS collaboration_task_threads (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  root_message_id TEXT NOT NULL,
  title TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','needs_you','working','done')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, task_id)
);

CREATE TABLE IF NOT EXISTS collaboration_agent_listen_mode (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('mentions','all')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, room_id, actor_id)
);

CREATE TABLE IF NOT EXISTS collaboration_presence (
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('online','away','working')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, actor_id)
);
