-- Channels, direct messages, and task threads.

ALTER TABLE collaboration_rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'room' CHECK (kind IN ('room','channel','dm'));
ALTER TABLE collaboration_rooms ADD COLUMN topic TEXT;
ALTER TABLE collaboration_rooms ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE collaboration_rooms ADD COLUMN dm_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS collaboration_rooms_dm_key
  ON collaboration_rooms(tenant_id, workspace_id, dm_key)
  WHERE dm_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS collaboration_rooms_kind
  ON collaboration_rooms(tenant_id, workspace_id, kind, created_at DESC);

ALTER TABLE collaboration_messages ADD COLUMN thread_root_message_id TEXT;
ALTER TABLE collaboration_messages ADD COLUMN reply_to_message_id TEXT;
ALTER TABLE collaboration_messages ADD COLUMN message_seq INTEGER;
ALTER TABLE collaboration_messages ADD COLUMN message_role TEXT NOT NULL DEFAULT 'chat'
  CHECK (message_role IN ('chat','task_root','progress','result','handoff','approval'));

CREATE INDEX IF NOT EXISTS collaboration_messages_thread
  ON collaboration_messages(tenant_id, workspace_id, room_id, thread_root_message_id, message_seq);

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

CREATE INDEX IF NOT EXISTS collaboration_task_threads_room
  ON collaboration_task_threads(tenant_id, workspace_id, room_id, updated_at DESC);
