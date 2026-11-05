-- Separate Reconciliation standing-disclosure authority. The original delivery ledger remains shared.
CREATE TABLE IF NOT EXISTS founder_reconciliation_slack_grants (
 id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,owner_account_id TEXT NOT NULL,owner_json TEXT NOT NULL,
 request_id TEXT NOT NULL,input_hash TEXT NOT NULL,digest TEXT NOT NULL,version INTEGER NOT NULL CHECK(version=1),
 source_kind TEXT NOT NULL CHECK(source_kind='reconciliation-schedule.v1'),family_json TEXT NOT NULL,sample_result_id TEXT NOT NULL,sample_digest TEXT NOT NULL,
 destination_json TEXT NOT NULL,audience_json TEXT NOT NULL,policy_json TEXT NOT NULL,link_created_at INTEGER NOT NULL,room_id TEXT NOT NULL,link_id TEXT NOT NULL,destination_key TEXT NOT NULL,
 max_sends INTEGER NOT NULL CHECK(max_sends BETWEEN 1 AND 8),used_sends INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL CHECK(state IN ('draft','disclosed','enabled','paused','revoked','blocked','exhausted')),
 created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,review_expires_at INTEGER NOT NULL,approved_at INTEGER,approver_json TEXT,error_code TEXT,
 UNIQUE(workspace_id,owner_account_id,request_id)
);
CREATE INDEX IF NOT EXISTS founder_reconciliation_slack_scope ON founder_reconciliation_slack_grants(workspace_id,owner_account_id,created_at);
CREATE TRIGGER IF NOT EXISTS founder_reconciliation_slack_member_update AFTER UPDATE ON team_workspace_memberships BEGIN UPDATE founder_reconciliation_slack_grants SET state='blocked',error_code='membership_changed' WHERE workspace_id=OLD.workspace_id AND state IN ('draft','disclosed','enabled','paused'); END;
CREATE TRIGGER IF NOT EXISTS founder_reconciliation_slack_member_delete AFTER DELETE ON team_workspace_memberships BEGIN UPDATE founder_reconciliation_slack_grants SET state='blocked',error_code='membership_changed' WHERE workspace_id=OLD.workspace_id AND state IN ('draft','disclosed','enabled','paused'); END;
CREATE TRIGGER IF NOT EXISTS founder_reconciliation_slack_room_member_update AFTER UPDATE ON collaboration_memberships BEGIN UPDATE founder_reconciliation_slack_grants SET state='blocked',error_code='audience_changed' WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed','enabled','paused'); END;
CREATE TRIGGER IF NOT EXISTS founder_reconciliation_slack_room_member_insert AFTER INSERT ON collaboration_memberships BEGIN UPDATE founder_reconciliation_slack_grants SET state='blocked',error_code='audience_changed' WHERE workspace_id=NEW.workspace_id AND room_id=NEW.room_id AND state IN ('draft','disclosed','enabled','paused'); END;
CREATE TRIGGER IF NOT EXISTS founder_reconciliation_slack_room_member_delete AFTER DELETE ON collaboration_memberships BEGIN UPDATE founder_reconciliation_slack_grants SET state='blocked',error_code='audience_changed' WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed','enabled','paused'); END;
CREATE TRIGGER IF NOT EXISTS founder_reconciliation_slack_link_update AFTER UPDATE ON collaboration_slack_room_links BEGIN UPDATE founder_reconciliation_slack_grants SET state='blocked',error_code='destination_changed' WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed','enabled','paused'); END;
CREATE TRIGGER IF NOT EXISTS founder_reconciliation_slack_link_delete AFTER DELETE ON collaboration_slack_room_links BEGIN UPDATE founder_reconciliation_slack_grants SET state='blocked',error_code='destination_changed' WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed','enabled','paused'); END;
CREATE TRIGGER IF NOT EXISTS founder_reconciliation_slack_room_update AFTER UPDATE ON collaboration_rooms BEGIN UPDATE founder_reconciliation_slack_grants SET state='blocked',error_code='destination_changed' WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed','enabled','paused'); END;
CREATE TRIGGER IF NOT EXISTS founder_reconciliation_slack_room_delete AFTER DELETE ON collaboration_rooms BEGIN UPDATE founder_reconciliation_slack_grants SET state='blocked',error_code='destination_changed' WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','disclosed','enabled','paused'); END;
-- A single destination may not have competing standing contracts across families.
-- These triggers are additive; without migration 0034 both older families keep their prior behavior.
CREATE TRIGGER IF NOT EXISTS reconciliation_slack_exclude_existing BEFORE INSERT ON founder_reconciliation_slack_grants
 WHEN NEW.state IN ('draft','disclosed','enabled','paused') AND (EXISTS(SELECT 1 FROM founder_automatic_slack_grants WHERE destination_key=NEW.destination_key AND state IN ('draft','disclosed','enabled','paused')) OR EXISTS(SELECT 1 FROM founder_stripe_slack_grants WHERE destination_key=NEW.destination_key AND state IN ('draft','disclosed','enabled','paused')))
 BEGIN SELECT RAISE(ABORT,'slack_destination_already_granted'); END;
CREATE TRIGGER IF NOT EXISTS reconciliation_slack_exclude_oauth BEFORE INSERT ON founder_automatic_slack_grants
 WHEN NEW.state IN ('draft','disclosed','enabled','paused') AND EXISTS(SELECT 1 FROM founder_reconciliation_slack_grants WHERE destination_key=NEW.destination_key AND state IN ('draft','disclosed','enabled','paused'))
 BEGIN SELECT RAISE(ABORT,'slack_destination_already_granted'); END;
CREATE TRIGGER IF NOT EXISTS reconciliation_slack_exclude_stripe BEFORE INSERT ON founder_stripe_slack_grants
 WHEN NEW.state IN ('draft','disclosed','enabled','paused') AND EXISTS(SELECT 1 FROM founder_reconciliation_slack_grants WHERE destination_key=NEW.destination_key AND state IN ('draft','disclosed','enabled','paused'))
 BEGIN SELECT RAISE(ABORT,'slack_destination_already_granted'); END;
