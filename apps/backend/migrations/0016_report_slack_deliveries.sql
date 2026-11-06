-- One-shot native source-owner disclosure and independently approved Slack delivery.
-- Canonical runtime prerequisites precede invalidation triggers. Existing data is preserved.
CREATE TABLE IF NOT EXISTS team_workspaces (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version>0), created_at INTEGER NOT NULL,
    PRIMARY KEY(tenant_id,workspace_id));
CREATE TABLE IF NOT EXISTS team_workspace_memberships (
    tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','admin','member')),
    status TEXT NOT NULL CHECK(status IN ('active','removed')), version INTEGER NOT NULL CHECK(version>0),
    joined_at INTEGER NOT NULL, removed_at INTEGER, mutation_id TEXT,
    PRIMARY KEY(tenant_id,workspace_id,user_id),
    FOREIGN KEY(tenant_id,workspace_id) REFERENCES team_workspaces(tenant_id,workspace_id));
CREATE TABLE IF NOT EXISTS collaboration_rooms (
    room_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('private','shared')),
    created_by_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
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
CREATE TABLE IF NOT EXISTS report_slack_deliveries (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, library_id TEXT NOT NULL, report_id TEXT NOT NULL,
    creator_id TEXT NOT NULL, creator_account_id TEXT NOT NULL, creator_member_json TEXT NOT NULL,
    request_id TEXT NOT NULL, input_hash TEXT NOT NULL, digest TEXT NOT NULL, disclosure_scope TEXT NOT NULL,
    report_hash TEXT NOT NULL, source_hash TEXT NOT NULL, source_json TEXT NOT NULL,
    content TEXT NOT NULL, content_hash TEXT NOT NULL,
    room_id TEXT NOT NULL, link_id TEXT NOT NULL, destination_json TEXT NOT NULL,
    audience_json TEXT NOT NULL, policy_json TEXT NOT NULL, link_created_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('draft','disclosed','sending','sent','blocked','failed','unknown','cancelled')),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, disclosed_at INTEGER,
    approver_json TEXT, receipt_ts TEXT, error_code TEXT,
    UNIQUE(workspace_id,creator_account_id,request_id));
CREATE INDEX IF NOT EXISTS report_slack_report ON report_slack_deliveries(workspace_id,report_id,created_at);
CREATE UNIQUE INDEX IF NOT EXISTS report_slack_no_duplicate ON report_slack_deliveries(workspace_id,creator_account_id,report_hash,link_id) WHERE state IN ('draft','disclosed','sending','sent','unknown');
CREATE TRIGGER IF NOT EXISTS report_slack_room_member_update AFTER UPDATE OF user_id,actor_id,actor_kind,role,status,capabilities_json,profile_version ON collaboration_memberships
    WHEN OLD.user_id IS NOT NEW.user_id OR OLD.actor_id IS NOT NEW.actor_id OR OLD.actor_kind IS NOT NEW.actor_kind OR OLD.role IS NOT NEW.role OR OLD.status IS NOT NEW.status OR OLD.capabilities_json IS NOT NEW.capabilities_json OR OLD.profile_version IS NOT NEW.profile_version
    BEGIN UPDATE report_slack_deliveries SET state='blocked',error_code='report_slack_room_changed'
      WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed'); END;
CREATE TRIGGER IF NOT EXISTS report_slack_room_member_insert AFTER INSERT ON collaboration_memberships
    BEGIN UPDATE report_slack_deliveries SET state='blocked',error_code='report_slack_room_changed'
      WHERE workspace_id=NEW.workspace_id AND room_id=NEW.room_id AND state IN ('draft','disclosed'); END;
CREATE TRIGGER IF NOT EXISTS report_slack_room_member_delete AFTER DELETE ON collaboration_memberships
    BEGIN UPDATE report_slack_deliveries SET state='blocked',error_code='report_slack_room_changed'
      WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed'); END;
CREATE TRIGGER IF NOT EXISTS report_slack_workspace_member_update AFTER UPDATE OF status,role,version,user_id ON team_workspace_memberships
    WHEN OLD.status IS NOT NEW.status OR OLD.role IS NOT NEW.role OR OLD.version IS NOT NEW.version OR OLD.user_id IS NOT NEW.user_id
    BEGIN UPDATE report_slack_deliveries SET state='blocked',error_code='report_slack_workspace_changed'
      WHERE workspace_id=OLD.workspace_id AND state IN ('draft','disclosed'); END;
CREATE TRIGGER IF NOT EXISTS report_slack_workspace_member_delete AFTER DELETE ON team_workspace_memberships
    BEGIN UPDATE report_slack_deliveries SET state='blocked',error_code='report_slack_workspace_changed'
      WHERE workspace_id=OLD.workspace_id AND state IN ('draft','disclosed'); END;
CREATE TRIGGER IF NOT EXISTS report_slack_link_update AFTER UPDATE ON collaboration_slack_room_links
    BEGIN UPDATE report_slack_deliveries SET state='blocked',error_code='report_slack_destination_changed'
      WHERE workspace_id=OLD.workspace_id AND link_id=OLD.link_id AND state IN ('draft','disclosed'); END;
CREATE TRIGGER IF NOT EXISTS report_slack_link_delete AFTER DELETE ON collaboration_slack_room_links
    BEGIN UPDATE report_slack_deliveries SET state='blocked',error_code='report_slack_destination_changed'
      WHERE workspace_id=OLD.workspace_id AND link_id=OLD.link_id AND state IN ('draft','disclosed'); END;
CREATE TRIGGER IF NOT EXISTS report_slack_room_update AFTER UPDATE ON collaboration_rooms
    BEGIN UPDATE report_slack_deliveries SET state='blocked',error_code='report_slack_room_changed'
      WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed'); END;
CREATE TRIGGER IF NOT EXISTS report_slack_room_delete AFTER DELETE ON collaboration_rooms
    BEGIN UPDATE report_slack_deliveries SET state='blocked',error_code='report_slack_room_changed'
      WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed'); END;
