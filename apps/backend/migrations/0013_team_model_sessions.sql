-- Default-off interactive Workers AI funding, exact turns and permanent room-source invalidation.
-- Collaboration was historically runtime-initialized. Establish the complete
-- canonical prerequisite tables before attaching membership invalidation triggers.
-- Keep these definitions aligned with collaboration-store.ts; existing rows stay intact.
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
CREATE TABLE IF NOT EXISTS team_model_funding (
  id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,room_id TEXT NOT NULL,issuer_id TEXT NOT NULL,recipient_id TEXT NOT NULL,
  version INTEGER NOT NULL,digest TEXT NOT NULL,binding_json TEXT NOT NULL,contract_json TEXT NOT NULL,policy_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','active','revoked','blocked')),review_expires_at INTEGER NOT NULL,
  used_requests INTEGER NOT NULL DEFAULT 0,reserved_input_bytes INTEGER NOT NULL DEFAULT 0,reserved_output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS team_model_turns (
  id TEXT PRIMARY KEY,grant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,room_id TEXT NOT NULL,requester_id TEXT NOT NULL,requester_account_id TEXT NOT NULL,
  request_id TEXT NOT NULL,request_hash TEXT NOT NULL,version INTEGER NOT NULL,grant_version INTEGER NOT NULL,input_hash TEXT NOT NULL,
  prompt TEXT NOT NULL,input_json TEXT NOT NULL,sources_json TEXT NOT NULL,input_bytes INTEGER NOT NULL,expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,output TEXT,error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,dispatch_deadline INTEGER,
  UNIQUE(workspace_id,requester_account_id,request_id));
CREATE INDEX IF NOT EXISTS team_model_room_funding ON team_model_funding(workspace_id,room_id,created_at);
CREATE INDEX IF NOT EXISTS team_model_grant_turns ON team_model_turns(grant_id,status,created_at);
CREATE TRIGGER IF NOT EXISTS team_model_room_membership_changed AFTER UPDATE OF status,role,capabilities_json,profile_version,user_id,actor_kind ON collaboration_memberships
   WHEN OLD.status IS NOT NEW.status OR OLD.role IS NOT NEW.role OR OLD.capabilities_json IS NOT NEW.capabilities_json OR OLD.profile_version IS NOT NEW.profile_version OR OLD.user_id IS NOT NEW.user_id OR OLD.actor_kind IS NOT NEW.actor_kind
   BEGIN UPDATE team_model_funding SET state='blocked',version=version+1 WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','active') AND (json_extract(binding_json,'$.issuerRoom.actorId')=OLD.actor_id OR json_extract(binding_json,'$.recipientRoom.actorId')=OLD.actor_id OR json_extract(binding_json,'$.employeeRoom.actorId')=OLD.actor_id); END;
CREATE TRIGGER IF NOT EXISTS team_model_room_membership_deleted AFTER DELETE ON collaboration_memberships
   BEGIN UPDATE team_model_funding SET state='blocked',version=version+1 WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','active') AND (json_extract(binding_json,'$.issuerRoom.actorId')=OLD.actor_id OR json_extract(binding_json,'$.recipientRoom.actorId')=OLD.actor_id OR json_extract(binding_json,'$.employeeRoom.actorId')=OLD.actor_id); END;
