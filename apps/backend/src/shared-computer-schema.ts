/** Append-only D1 schema shared by lazy initialization and migration verification. */
export const SHARED_COMPUTER_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS shared_computer_sessions (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, room_id TEXT NOT NULL, owner_account_id TEXT NOT NULL,
    request_id TEXT NOT NULL, request_hash TEXT NOT NULL, version INTEGER NOT NULL, digest TEXT NOT NULL,
    binding_json TEXT NOT NULL, contract_json TEXT NOT NULL, state TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_account_id TEXT, lease_version INTEGER NOT NULL DEFAULT 0,
    lease_expires_at INTEGER NOT NULL DEFAULT 0, sequence INTEGER NOT NULL DEFAULT 0, input_count INTEGER NOT NULL DEFAULT 0,
    frame_count INTEGER NOT NULL DEFAULT 0, frame_bytes INTEGER NOT NULL DEFAULT 0, last_input_at INTEGER NOT NULL DEFAULT 0,
    last_frame_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(workspace_id,owner_account_id,request_id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS shared_computer_one_active ON shared_computer_sessions((1)) WHERE state IN ('starting','running','unknown')`,
  `CREATE TABLE IF NOT EXISTS shared_computer_commands (
    session_id TEXT NOT NULL, request_id TEXT NOT NULL, sequence INTEGER NOT NULL, action_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('claimed','completed','unknown')), created_at INTEGER NOT NULL,
    PRIMARY KEY(session_id,request_id), UNIQUE(session_id,sequence))`,
  `CREATE TRIGGER IF NOT EXISTS shared_computer_room_member_changed AFTER UPDATE ON collaboration_memberships
   WHEN OLD.status IS NOT NEW.status OR OLD.role IS NOT NEW.role OR OLD.capabilities_json IS NOT NEW.capabilities_json OR OLD.user_id IS NOT NEW.user_id OR OLD.actor_kind IS NOT NEW.actor_kind OR OLD.created_at IS NOT NEW.created_at
   BEGIN UPDATE shared_computer_sessions SET state='blocked',version=version+1,lease_expires_at=0
    WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','funded','starting','running')
      AND EXISTS(SELECT 1 FROM json_each(binding_json,'$.participants') p WHERE json_extract(p.value,'$.room.actorId')=OLD.actor_id); END`,
  `CREATE TRIGGER IF NOT EXISTS shared_computer_room_member_deleted AFTER DELETE ON collaboration_memberships
   BEGIN UPDATE shared_computer_sessions SET state='blocked',version=version+1,lease_expires_at=0
    WHERE workspace_id=OLD.workspace_id AND room_id=OLD.room_id AND state IN ('draft','funded','starting','running')
      AND EXISTS(SELECT 1 FROM json_each(binding_json,'$.participants') p WHERE json_extract(p.value,'$.room.actorId')=OLD.actor_id); END`,
] as const;
