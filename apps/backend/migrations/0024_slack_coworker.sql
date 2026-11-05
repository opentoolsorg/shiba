-- Native-to-Slack identity is a separate, revocable grant. No source or execution authority is implied.
CREATE TABLE IF NOT EXISTS slack_coworker_challenges (
  id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
  account_id TEXT NOT NULL, actor_id TEXT NOT NULL, member_version INTEGER NOT NULL, member_role TEXT NOT NULL,
  installation_id TEXT NOT NULL, app_id TEXT NOT NULL, team_id TEXT NOT NULL, generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','observed','slack_confirmed','consumed','revoked')),
  slack_user_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_coworker_bindings (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, account_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  member_version INTEGER NOT NULL, member_role TEXT NOT NULL, installation_id TEXT NOT NULL,
  app_id TEXT NOT NULL, team_id TEXT NOT NULL, generation INTEGER NOT NULL, slack_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')), created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS slack_coworker_one_native ON slack_coworker_bindings(installation_id,account_id) WHERE status='active';
CREATE UNIQUE INDEX IF NOT EXISTS slack_coworker_one_slack ON slack_coworker_bindings(installation_id,slack_user_id) WHERE status='active';
CREATE TRIGGER IF NOT EXISTS slack_coworker_member_update AFTER UPDATE OF user_id,version,role,status ON team_workspace_memberships
 WHEN OLD.user_id IS NOT NEW.user_id OR OLD.version IS NOT NEW.version OR OLD.role IS NOT NEW.role OR OLD.status IS NOT NEW.status
 BEGIN
  UPDATE slack_coworker_bindings SET status='revoked',revoked_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE workspace_id=OLD.workspace_id AND actor_id=OLD.user_id AND status='active';
  UPDATE slack_coworker_challenges SET state='revoked' WHERE workspace_id=OLD.workspace_id AND actor_id=OLD.user_id AND state IN ('pending','observed','slack_confirmed');
 END;
CREATE TRIGGER IF NOT EXISTS slack_coworker_member_delete AFTER DELETE ON team_workspace_memberships BEGIN
 UPDATE slack_coworker_bindings SET status='revoked',revoked_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE workspace_id=OLD.workspace_id AND actor_id=OLD.user_id AND status='active';
 UPDATE slack_coworker_challenges SET state='revoked' WHERE workspace_id=OLD.workspace_id AND actor_id=OLD.user_id AND state IN ('pending','observed','slack_confirmed');
END;
CREATE TRIGGER IF NOT EXISTS slack_coworker_installation_change AFTER UPDATE OF generation,state ON slack_installations
 WHEN OLD.generation IS NOT NEW.generation OR NEW.state<>'active'
 BEGIN
  UPDATE slack_coworker_bindings SET status='revoked',revoked_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE installation_id=OLD.id AND status='active';
  UPDATE slack_coworker_challenges SET state='revoked' WHERE installation_id=OLD.id AND state IN ('pending','observed','slack_confirmed');
 END;
-- Explicitly selected incoming self-authored event only; no history is fetched.
CREATE TABLE IF NOT EXISTS slack_coworker_intake_grants (
 id TEXT PRIMARY KEY,binding_id TEXT NOT NULL,workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,installation_id TEXT NOT NULL,
 app_id TEXT NOT NULL,team_id TEXT NOT NULL,generation INTEGER NOT NULL,channel_id TEXT NOT NULL,thread_ts TEXT NOT NULL,
 expires_at INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('active','revoked')),created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_coworker_drafts (
 id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,account_id TEXT NOT NULL,app_id TEXT NOT NULL,team_id TEXT NOT NULL,
 channel_id TEXT NOT NULL,thread_ts TEXT NOT NULL,message_ts TEXT NOT NULL,event_id TEXT NOT NULL,slack_user_id TEXT NOT NULL,
 text TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','adopted','invalidated')),created_at INTEGER NOT NULL,
 UNIQUE(app_id,team_id,event_id), UNIQUE(app_id,team_id,channel_id,message_ts)
);
CREATE TRIGGER IF NOT EXISTS slack_coworker_binding_revoke AFTER UPDATE OF status ON slack_coworker_bindings WHEN NEW.status<>'active' BEGIN
 UPDATE slack_coworker_intake_grants SET status='revoked' WHERE binding_id=OLD.id AND status='active';
 UPDATE slack_coworker_drafts SET status='invalidated',text='' WHERE grant_id IN (SELECT id FROM slack_coworker_intake_grants WHERE binding_id=OLD.id) AND status='pending';
END;
CREATE TRIGGER IF NOT EXISTS slack_coworker_grant_revoke AFTER UPDATE OF status ON slack_coworker_intake_grants WHEN NEW.status<>'active' BEGIN
 UPDATE slack_coworker_drafts SET status='invalidated',text='' WHERE grant_id=OLD.id AND status='pending';
END;
CREATE TABLE IF NOT EXISTS slack_coworker_invalidated_messages (
 app_id TEXT NOT NULL,team_id TEXT NOT NULL,channel_id TEXT NOT NULL,message_ts TEXT NOT NULL,created_at INTEGER NOT NULL,
 PRIMARY KEY(app_id,team_id,channel_id,message_ts)
);
