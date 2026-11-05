-- Default-off bot-workspace installations; tokens stay encrypted in Worker-only storage.
-- Canonical native-workspace prerequisites precede owner invalidation triggers.
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
CREATE TABLE IF NOT EXISTS slack_installations (
    id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,owner_id TEXT NOT NULL,owner_account_id TEXT NOT NULL,owner_member_json TEXT NOT NULL,
    app_id TEXT NOT NULL,team_id TEXT NOT NULL,bot_user_id TEXT NOT NULL,bot_id TEXT NOT NULL,installer_slack_user_id TEXT NOT NULL,scopes_json TEXT NOT NULL,
    generation INTEGER NOT NULL,version INTEGER NOT NULL,token_revision INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','active','refreshing','revoked','unknown','blocked')),
    digest TEXT NOT NULL,token_key_id TEXT,token_cipher TEXT,token_expires_at INTEGER,activation_expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,refresh_claim_id TEXT,UNIQUE(app_id,team_id));
CREATE INDEX IF NOT EXISTS slack_installations_workspace ON slack_installations(workspace_id,owner_account_id);
CREATE TABLE IF NOT EXISTS slack_installation_oauth (
    id TEXT PRIMARY KEY,state_hash TEXT NOT NULL UNIQUE,workspace_id TEXT NOT NULL,owner_account_id TEXT NOT NULL,owner_member_json TEXT NOT NULL,
    request_id TEXT NOT NULL,input_hash TEXT NOT NULL,scopes_json TEXT NOT NULL,config_json TEXT NOT NULL,verifier_key_id TEXT NOT NULL,verifier_cipher TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','exchanging','completed','unknown','cancelled')),created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
    UNIQUE(workspace_id,owner_account_id,request_id));
CREATE TABLE IF NOT EXISTS slack_installation_revocations (app_id TEXT NOT NULL,team_id TEXT NOT NULL,received_at INTEGER NOT NULL,epoch INTEGER NOT NULL,PRIMARY KEY(app_id,team_id));
CREATE TABLE IF NOT EXISTS slack_installation_events (app_id TEXT NOT NULL,team_id TEXT NOT NULL,event_id TEXT NOT NULL,received_at INTEGER NOT NULL,PRIMARY KEY(app_id,team_id,event_id));
CREATE TRIGGER IF NOT EXISTS slack_installations_owner_update AFTER UPDATE OF user_id,version,role,status ON team_workspace_memberships
    WHEN OLD.user_id IS NOT NEW.user_id OR OLD.version IS NOT NEW.version OR OLD.role IS NOT NEW.role OR OLD.status IS NOT NEW.status
    BEGIN UPDATE slack_installations SET state='blocked',generation=generation+1,version=version+1,token_cipher=NULL,token_key_id=NULL
      WHERE workspace_id=OLD.workspace_id AND owner_id=OLD.user_id AND state<>'revoked';
      UPDATE slack_installation_oauth SET state='cancelled' WHERE workspace_id=OLD.workspace_id AND json_extract(owner_member_json,'$.userId')=OLD.user_id AND state='pending'; END;
CREATE TRIGGER IF NOT EXISTS slack_installations_owner_delete AFTER DELETE ON team_workspace_memberships
    BEGIN UPDATE slack_installations SET state='blocked',generation=generation+1,version=version+1,token_cipher=NULL,token_key_id=NULL
      WHERE workspace_id=OLD.workspace_id AND owner_id=OLD.user_id AND state<>'revoked';
      UPDATE slack_installation_oauth SET state='cancelled' WHERE workspace_id=OLD.workspace_id AND json_extract(owner_member_json,'$.userId')=OLD.user_id AND state='pending'; END;
