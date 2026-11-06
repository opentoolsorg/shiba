-- Explicit standing Slack consent; prerequisites come from canonical migrations 0013 and 0016.
CREATE TABLE IF NOT EXISTS founder_automatic_slack_grants (
    id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,library_id TEXT NOT NULL,owner_id TEXT NOT NULL,owner_account_id TEXT NOT NULL,owner_json TEXT NOT NULL,
    request_id TEXT NOT NULL,input_hash TEXT NOT NULL,digest TEXT NOT NULL,version INTEGER NOT NULL CHECK(version=1),
    family_json TEXT NOT NULL,read_grant_id TEXT NOT NULL,read_grant_version INTEGER NOT NULL,read_grant_digest TEXT NOT NULL,
    sample_occurrence_id TEXT NOT NULL,sample_report_hash TEXT NOT NULL,destination_json TEXT NOT NULL,audience_json TEXT NOT NULL,policy_json TEXT NOT NULL,link_created_at INTEGER NOT NULL,
    room_id TEXT NOT NULL,link_id TEXT NOT NULL,destination_key TEXT NOT NULL,max_sends INTEGER NOT NULL CHECK(max_sends BETWEEN 1 AND 10),used_sends INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK(state IN ('draft','disclosed','enabled','paused','revoked','blocked','exhausted')),
    created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,review_expires_at INTEGER NOT NULL,approved_at INTEGER,approver_json TEXT,error_code TEXT,
    UNIQUE(workspace_id,owner_account_id,request_id));

CREATE INDEX IF NOT EXISTS founder_automatic_slack_scope ON founder_automatic_slack_grants(workspace_id,library_id,created_at);

CREATE TABLE IF NOT EXISTS founder_automatic_slack_deliveries (
    id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,occurrence_id TEXT NOT NULL,source_key TEXT NOT NULL UNIQUE,destination_key TEXT NOT NULL,
    report_hash TEXT NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,client_msg_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK(state IN ('sending','sent','blocked','failed','unknown')),lease_id TEXT NOT NULL,lease_expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,receipt_ts TEXT,error_code TEXT);

CREATE INDEX IF NOT EXISTS founder_automatic_slack_busy ON founder_automatic_slack_deliveries(destination_key,state);

CREATE TRIGGER IF NOT EXISTS founder_automatic_slack_room_member_update AFTER UPDATE ON collaboration_memberships
      BEGIN UPDATE founder_automatic_slack_grants SET state='blocked',error_code='automatic_slack_audience_changed'
        WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed','enabled','paused'); END;

CREATE TRIGGER IF NOT EXISTS founder_automatic_slack_room_member_insert AFTER INSERT ON collaboration_memberships
      BEGIN UPDATE founder_automatic_slack_grants SET state='blocked',error_code='automatic_slack_audience_changed'
        WHERE workspace_id=NEW.workspace_id AND room_id=NEW.room_id AND state IN ('draft','disclosed','enabled','paused'); END;

CREATE TRIGGER IF NOT EXISTS founder_automatic_slack_room_member_delete AFTER DELETE ON collaboration_memberships
      BEGIN UPDATE founder_automatic_slack_grants SET state='blocked',error_code='automatic_slack_audience_changed'
        WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed','enabled','paused'); END;

CREATE TRIGGER IF NOT EXISTS founder_automatic_slack_workspace_member_update AFTER UPDATE ON team_workspace_memberships
    BEGIN UPDATE founder_automatic_slack_grants SET state='blocked',error_code='automatic_slack_membership_changed'
      WHERE workspace_id=OLD.workspace_id AND state IN ('draft','disclosed','enabled','paused'); END;

CREATE TRIGGER IF NOT EXISTS founder_automatic_slack_workspace_member_delete AFTER DELETE ON team_workspace_memberships
    BEGIN UPDATE founder_automatic_slack_grants SET state='blocked',error_code='automatic_slack_membership_changed'
      WHERE workspace_id=OLD.workspace_id AND state IN ('draft','disclosed','enabled','paused'); END;

CREATE TRIGGER IF NOT EXISTS founder_automatic_slack_collaboration_slack_room_links_update AFTER UPDATE ON collaboration_slack_room_links
      BEGIN UPDATE founder_automatic_slack_grants SET state='blocked',error_code='automatic_slack_destination_changed'
        WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed','enabled','paused'); END;

CREATE TRIGGER IF NOT EXISTS founder_automatic_slack_collaboration_slack_room_links_delete AFTER DELETE ON collaboration_slack_room_links
      BEGIN UPDATE founder_automatic_slack_grants SET state='blocked',error_code='automatic_slack_destination_changed'
        WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed','enabled','paused'); END;

CREATE TRIGGER IF NOT EXISTS founder_automatic_slack_collaboration_rooms_update AFTER UPDATE ON collaboration_rooms
      BEGIN UPDATE founder_automatic_slack_grants SET state='blocked',error_code='automatic_slack_destination_changed'
        WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed','enabled','paused'); END;

CREATE TRIGGER IF NOT EXISTS founder_automatic_slack_collaboration_rooms_delete AFTER DELETE ON collaboration_rooms
      BEGIN UPDATE founder_automatic_slack_grants SET state='blocked',error_code='automatic_slack_destination_changed'
        WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed','enabled','paused'); END;
