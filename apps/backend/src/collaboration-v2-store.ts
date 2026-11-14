import { COLLABORATION_CAPABILITIES, isTeamWorkspaceId } from "@shiba/shared";
import {
  COLLAB_TENANT_ID,
  CollaborationStoreError,
  ensureCollaborationSchema,
  ensureCollaborationScopeSchema,
  humanActorId,
  isCollaborationWorkspaceMember,
  type CollaborationScope,
} from "./collaboration-store.js";
import type { Env } from "./env.js";
import { randomHex } from "./mailbox-store.js";

export type CollabRoomKind = "room" | "channel" | "dm";

export class CollabV2StoreError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
    this.name = "CollabV2StoreError";
  }
}

const V2_MARKERS = ["collaboration_read_cursors", "workspace_notifications"] as const;

export async function ensureCollabV2Migrated(env: Pick<Env, "AGENT_AUDIT">): Promise<void> {
  if (!env.AGENT_AUDIT) throw new CollabV2StoreError("Collaboration storage is unavailable.", 503);
  const names = new Set(
    (await env.AGENT_AUDIT.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN (?,?)",
    )
      .bind(V2_MARKERS[0], V2_MARKERS[1])
      .all<{ name: string }>()).results?.map((row) => row.name) ?? [],
  );
  if (V2_MARKERS.some((table) => !names.has(table))) {
    throw new CollabV2StoreError("Multiplayer chat storage is not migrated.", 503);
  }
}

export interface CollabV2RoomRow {
  roomId: string;
  tenantId: string;
  workspaceId: string;
  title: string;
  visibility: "private" | "shared";
  kind: CollabRoomKind;
  topic: string | null;
  isPrivate: boolean;
  dmKey: string | null;
  slackImportChannelId: string | null;
  createdByUserId: string;
  createdAt: number;
  unreadCount: number;
  lastMessageSeq: number;
}

function rowRoom(row: Record<string, unknown>): CollabV2RoomRow {
  return {
    roomId: String(row.room_id),
    tenantId: String(row.tenant_id),
    workspaceId: String(row.workspace_id),
    title: String(row.title),
    visibility: row.visibility as "private" | "shared",
    kind: (row.kind as CollabRoomKind) ?? "room",
    topic: typeof row.topic === "string" ? row.topic : null,
    isPrivate: Number(row.is_private ?? 0) === 1,
    dmKey: typeof row.dm_key === "string" ? row.dm_key : null,
    slackImportChannelId:
      typeof row.slack_import_channel_id === "string" ? row.slack_import_channel_id : null,
    createdByUserId: String(row.created_by_user_id),
    createdAt: Number(row.created_at),
    unreadCount: Number(row.unread_count ?? 0),
    lastMessageSeq: Number(row.last_message_seq ?? 0),
  };
}

const ALL_HUMAN_CAPABILITIES = COLLABORATION_CAPABILITIES;

function teamMemberSql(scope: Pick<CollaborationScope, "workspaceId">, alias: string): string {
  if (!isTeamWorkspaceId(scope.workspaceId)) {
    return scope.workspaceId === "default" ? "1=1" : "0=1";
  }
  return `EXISTS (SELECT 1 FROM team_workspace_memberships team_member
    WHERE team_member.tenant_id=${alias}.tenant_id AND team_member.workspace_id=${alias}.workspace_id
      AND team_member.user_id=${alias}.user_id AND team_member.status='active')`;
}

async function ensureMember(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
): Promise<void> {
  await ensureCollaborationSchema(env);
  await ensureCollabV2Migrated(env);
  await ensureCollaborationScopeSchema(env, scope);
  const allowed = await env.AGENT_AUDIT.prepare(
    `SELECT 1 FROM collaboration_memberships m WHERE m.tenant_id=? AND m.workspace_id=? AND m.room_id=? AND m.user_id=? AND m.status='active' AND ${teamMemberSql(scope, "m")}`,
  )
    .bind(scope.tenantId, scope.workspaceId, roomId, scope.userId)
    .first();
  if (!allowed) throw new CollaborationStoreError("Room not found.", 404);
}

export async function createChannel(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: { roomId: string; title: string; topic?: string; isPrivate?: boolean; createdAt: number },
): Promise<CollabV2RoomRow> {
  await ensureCollabV2Migrated(env);
  await ensureCollaborationSchema(env);
  await ensureCollaborationScopeSchema(env, scope);
  const db = env.AGENT_AUDIT;
  const isPrivate = input.isPrivate ? 1 : 0;
  const visibility = isPrivate ? "private" : "shared";
  const results = await db.batch([
    db.prepare(
      `INSERT INTO collaboration_rooms (room_id,tenant_id,workspace_id,title,visibility,created_by_user_id,created_at,kind,topic,is_private)
       SELECT ?,?,?,?,?,?,?,'channel',?,? ${isTeamWorkspaceId(scope.workspaceId) ? "WHERE EXISTS (SELECT 1 FROM team_workspace_memberships creator WHERE creator.tenant_id=? AND creator.workspace_id=? AND creator.user_id=? AND creator.status='active')" : ""}`,
    ).bind(
      input.roomId,
      scope.tenantId,
      scope.workspaceId,
      input.title,
      visibility,
      scope.userId,
      input.createdAt,
      input.topic ?? null,
      isPrivate,
      ...(isTeamWorkspaceId(scope.workspaceId) ? [scope.tenantId, scope.workspaceId, scope.userId] : []),
    ),
    db.prepare(
      `INSERT INTO collaboration_memberships (tenant_id,workspace_id,room_id,user_id,display_name,actor_id,actor_kind,role,status,capabilities_json,profile_version,created_at)
       SELECT ?,?,?,?,?,?,'human','owner','active',?,NULL,? WHERE changes()=1`,
    ).bind(
      scope.tenantId,
      scope.workspaceId,
      input.roomId,
      scope.userId,
      scope.userId,
      humanActorId(scope.userId),
      JSON.stringify(ALL_HUMAN_CAPABILITIES),
      input.createdAt,
    ),
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
    throw new CollaborationStoreError("Workspace not found.", 404);
  }
  return (await getCollabRoom(env, scope, input.roomId))!;
}

export async function joinChannel(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  createdAt: number,
): Promise<boolean> {
  await ensureCollabV2Migrated(env);
  const channel = await env.AGENT_AUDIT.prepare(
    "SELECT room_id FROM collaboration_rooms WHERE tenant_id=? AND workspace_id=? AND room_id=? AND kind='channel'",
  )
    .bind(scope.tenantId, scope.workspaceId, roomId)
    .first();
  if (!channel) throw new CollaborationStoreError("Channel not found.", 404);
  const inserted = await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_memberships (tenant_id,workspace_id,room_id,user_id,display_name,actor_id,actor_kind,role,status,capabilities_json,profile_version,created_at)
     SELECT ?,?,?,?,?,?,'human','member','active',?,NULL,? WHERE EXISTS (SELECT 1 FROM collaboration_rooms r WHERE r.tenant_id=? AND r.workspace_id=? AND r.room_id=? AND r.kind='channel')
       AND NOT EXISTS (SELECT 1 FROM collaboration_memberships m WHERE m.tenant_id=? AND m.workspace_id=? AND m.room_id=? AND m.actor_id=? AND m.status='active')`,
  )
    .bind(
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.userId,
      scope.userId,
      humanActorId(scope.userId),
      JSON.stringify(ALL_HUMAN_CAPABILITIES),
      createdAt,
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.tenantId,
      scope.workspaceId,
      roomId,
      humanActorId(scope.userId),
    )
    .run();
  return Number(inserted.meta?.changes ?? 0) === 1;
}

export async function leaveChannel(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  removedAt: number,
): Promise<boolean> {
  await ensureMember(env, scope, roomId);
  const result = await env.AGENT_AUDIT.prepare(
    `UPDATE collaboration_memberships SET status='removed', removed_at=? WHERE tenant_id=? AND workspace_id=? AND room_id=? AND user_id=? AND actor_id=? AND status='active'
     AND EXISTS (SELECT 1 FROM collaboration_rooms r WHERE r.tenant_id=? AND r.workspace_id=? AND r.room_id=? AND r.kind='channel' AND r.created_by_user_id<>?)`,
  )
    .bind(
      removedAt,
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.userId,
      humanActorId(scope.userId),
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.userId,
    )
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function listPublicChannels(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
): Promise<CollabV2RoomRow[]> {
  return listRoomsByKind(env, scope, "channel", { publicOnly: true });
}

export function dmKeyFor(userA: string, userB: string): string {
  const pair = [userA.trim().toLowerCase(), userB.trim().toLowerCase()].sort();
  return `dm:${pair[0]}:${pair[1]}`;
}

export async function openDm(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  peerUserId: string,
  createdAt: number,
): Promise<CollabV2RoomRow> {
  await ensureCollabV2Migrated(env);
  if (!await isCollaborationWorkspaceMember(env, scope, peerUserId)) {
    throw new CollaborationStoreError("Choose a current workspace member.", 403);
  }
  const key = dmKeyFor(scope.userId, peerUserId);
  const existing = await env.AGENT_AUDIT.prepare(
    "SELECT room_id FROM collaboration_rooms WHERE tenant_id=? AND workspace_id=? AND dm_key=?",
  )
    .bind(scope.tenantId, scope.workspaceId, key)
    .first<{ room_id: string }>();
  if (existing?.room_id) {
    await ensureDmMembership(env, scope, existing.room_id, peerUserId, createdAt);
    return (await getCollabRoom(env, scope, existing.room_id))!;
  }
  const roomId = `dm_${randomHex(10)}`;
  const title = `DM: ${scope.userId}, ${peerUserId}`;
  const db = env.AGENT_AUDIT;
  await db.batch([
    db.prepare(
      `INSERT INTO collaboration_rooms (room_id,tenant_id,workspace_id,title,visibility,created_by_user_id,created_at,kind,is_private,dm_key)
       VALUES (?,?,?,?,?,?,?,'dm',1,?)`,
    ).bind(roomId, scope.tenantId, scope.workspaceId, title, "private", scope.userId, createdAt, key),
    db.prepare(
      `INSERT INTO collaboration_memberships (tenant_id,workspace_id,room_id,user_id,display_name,actor_id,actor_kind,role,status,capabilities_json,profile_version,created_at)
       VALUES (?,?,?,?,?,?,'human','owner','active',?,NULL,?)`,
    ).bind(
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.userId,
      scope.userId,
      humanActorId(scope.userId),
      JSON.stringify(ALL_HUMAN_CAPABILITIES),
      createdAt,
    ),
    db.prepare(
      `INSERT INTO collaboration_memberships (tenant_id,workspace_id,room_id,user_id,display_name,actor_id,actor_kind,role,status,capabilities_json,profile_version,created_at)
       VALUES (?,?,?,?,?,?,'human','member','active',?,NULL,?)`,
    ).bind(
      scope.tenantId,
      scope.workspaceId,
      roomId,
      peerUserId,
      peerUserId,
      humanActorId(peerUserId),
      JSON.stringify(ALL_HUMAN_CAPABILITIES),
      createdAt,
    ),
  ]);
  return (await getCollabRoom(env, scope, roomId))!;
}

async function ensureDmMembership(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  peerUserId: string,
  createdAt: number,
): Promise<void> {
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_memberships (tenant_id,workspace_id,room_id,user_id,display_name,actor_id,actor_kind,role,status,capabilities_json,profile_version,created_at)
     SELECT ?,?,?,?,?,?,'human','member','active',?,NULL,? WHERE NOT EXISTS (
       SELECT 1 FROM collaboration_memberships m WHERE m.tenant_id=? AND m.workspace_id=? AND m.room_id=? AND m.user_id=? AND m.status='active'
     )`,
  )
    .bind(
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.userId,
      scope.userId,
      humanActorId(scope.userId),
      JSON.stringify(ALL_HUMAN_CAPABILITIES),
      createdAt,
      scope.tenantId,
      scope.workspaceId,
      roomId,
      scope.userId,
    )
    .run();
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_memberships (tenant_id,workspace_id,room_id,user_id,display_name,actor_id,actor_kind,role,status,capabilities_json,profile_version,created_at)
     SELECT ?,?,?,?,?,?,'human','member','active',?,NULL,? WHERE NOT EXISTS (
       SELECT 1 FROM collaboration_memberships m WHERE m.tenant_id=? AND m.workspace_id=? AND m.room_id=? AND m.user_id=? AND m.status='active'
     )`,
  )
    .bind(
      scope.tenantId,
      scope.workspaceId,
      roomId,
      peerUserId,
      peerUserId,
      humanActorId(peerUserId),
      JSON.stringify(ALL_HUMAN_CAPABILITIES),
      createdAt,
      scope.tenantId,
      scope.workspaceId,
      roomId,
      peerUserId,
    )
    .run();
}

export async function listRoomsByKind(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  kind: CollabRoomKind,
  options: { publicOnly?: boolean } = {},
): Promise<CollabV2RoomRow[]> {
  await ensureCollabV2Migrated(env);
  const publicFilter = options.publicOnly ? " AND r.is_private=0 " : "";
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT r.*,
      COALESCE((SELECT MAX(m.message_seq) FROM collaboration_messages m WHERE m.tenant_id=r.tenant_id AND m.workspace_id=r.workspace_id AND m.room_id=r.room_id),0) AS last_message_seq,
      COALESCE((SELECT MAX(m.message_seq) FROM collaboration_messages m WHERE m.tenant_id=r.tenant_id AND m.workspace_id=r.workspace_id AND m.room_id=r.room_id),0)
        - COALESCE((SELECT c.last_read_seq FROM collaboration_read_cursors c WHERE c.tenant_id=r.tenant_id AND c.workspace_id=r.workspace_id AND c.room_id=r.room_id AND c.user_id=? AND c.thread_root_message_id=''),0) AS unread_count
     FROM collaboration_rooms r
     JOIN collaboration_memberships mine ON mine.tenant_id=r.tenant_id AND mine.workspace_id=r.workspace_id AND mine.room_id=r.room_id
     WHERE r.tenant_id=? AND r.workspace_id=? AND r.kind=? AND mine.user_id=? AND mine.status='active'${publicFilter}
     ORDER BY r.created_at DESC LIMIT 100`,
  )
    .bind(scope.userId, scope.tenantId, scope.workspaceId, kind, scope.userId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => {
    const mapped = rowRoom(row);
    mapped.unreadCount = Math.max(0, Number(row.unread_count ?? 0));
    return mapped;
  });
}

async function getCollabRoom(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
): Promise<CollabV2RoomRow | null> {
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT r.*,
      COALESCE((SELECT MAX(m.message_seq) FROM collaboration_messages m WHERE m.tenant_id=r.tenant_id AND m.workspace_id=r.workspace_id AND m.room_id=r.room_id),0) AS last_message_seq,
      COALESCE((SELECT MAX(m.message_seq) FROM collaboration_messages m WHERE m.tenant_id=r.tenant_id AND m.workspace_id=r.workspace_id AND m.room_id=r.room_id),0)
        - COALESCE((SELECT c.last_read_seq FROM collaboration_read_cursors c WHERE c.tenant_id=r.tenant_id AND c.workspace_id=r.workspace_id AND c.room_id=r.room_id AND c.user_id=? AND c.thread_root_message_id=''),0) AS unread_count
     FROM collaboration_rooms r
     WHERE r.tenant_id=? AND r.workspace_id=? AND r.room_id=?
       AND EXISTS (SELECT 1 FROM collaboration_memberships m WHERE m.tenant_id=r.tenant_id AND m.workspace_id=r.workspace_id AND m.room_id=r.room_id AND m.user_id=? AND m.status='active')`,
  )
    .bind(scope.userId, scope.tenantId, scope.workspaceId, roomId, scope.userId)
    .first<Record<string, unknown>>();
  return row ? rowRoom(row) : null;
}

export async function nextMessageSeq(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
): Promise<number> {
  await ensureCollabV2Migrated(env);
  const row = await env.AGENT_AUDIT.prepare(
    "SELECT COALESCE(MAX(message_seq),0)+1 AS next FROM collaboration_messages WHERE tenant_id=? AND workspace_id=? AND room_id=?",
  )
    .bind(scope.tenantId, scope.workspaceId, roomId)
    .first<{ next: number }>();
  return Number(row?.next ?? 1);
}

export async function finalizeMessageV2(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  messageId: string,
  input: { roomId: string; messageSeq: number; threadRootMessageId?: string | null; replyToMessageId?: string | null },
): Promise<void> {
  await ensureCollabV2Migrated(env);
  await env.AGENT_AUDIT.prepare(
    `UPDATE collaboration_messages SET message_seq=?, thread_root_message_id=?, reply_to_message_id=?
     WHERE tenant_id=? AND workspace_id=? AND message_id=? AND room_id=?`,
  )
    .bind(
      input.messageSeq,
      input.threadRootMessageId ?? null,
      input.replyToMessageId ?? null,
      scope.tenantId,
      scope.workspaceId,
      messageId,
      input.roomId,
    )
    .run();
}

export async function toggleReaction(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: { roomId: string; messageId: string; emoji: string; createdAt: number },
): Promise<{ added: boolean }> {
  await ensureMember(env, scope, input.roomId);
  const existing = await env.AGENT_AUDIT.prepare(
    "SELECT 1 FROM collaboration_reactions WHERE tenant_id=? AND workspace_id=? AND message_id=? AND user_id=? AND emoji=?",
  )
    .bind(scope.tenantId, scope.workspaceId, input.messageId, scope.userId, input.emoji)
    .first();
  if (existing) {
    await env.AGENT_AUDIT.prepare(
      "DELETE FROM collaboration_reactions WHERE tenant_id=? AND workspace_id=? AND message_id=? AND user_id=? AND emoji=?",
    )
      .bind(scope.tenantId, scope.workspaceId, input.messageId, scope.userId, input.emoji)
      .run();
    return { added: false };
  }
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_reactions (tenant_id,workspace_id,room_id,message_id,user_id,emoji,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  )
    .bind(scope.tenantId, scope.workspaceId, input.roomId, input.messageId, scope.userId, input.emoji, input.createdAt)
    .run();
  return { added: true };
}

export async function pinMessage(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  messageId: string,
  createdAt: number,
): Promise<void> {
  await ensureMember(env, scope, roomId);
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_pins (tenant_id,workspace_id,room_id,message_id,pinned_by_user_id,created_at)
     VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id,workspace_id,room_id,message_id) DO NOTHING`,
  )
    .bind(scope.tenantId, scope.workspaceId, roomId, messageId, scope.userId, createdAt)
    .run();
}

export async function unpinMessage(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  messageId: string,
): Promise<boolean> {
  await ensureMember(env, scope, roomId);
  const result = await env.AGENT_AUDIT.prepare(
    "DELETE FROM collaboration_pins WHERE tenant_id=? AND workspace_id=? AND room_id=? AND message_id=?",
  )
    .bind(scope.tenantId, scope.workspaceId, roomId, messageId)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function saveMessage(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  messageId: string,
  savedAt: number,
): Promise<void> {
  await ensureMember(env, scope, roomId);
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_saved (tenant_id,workspace_id,user_id,room_id,message_id,saved_at)
     VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
  )
    .bind(scope.tenantId, scope.workspaceId, scope.userId, roomId, messageId, savedAt)
    .run();
}

export async function unsaveMessage(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  messageId: string,
): Promise<boolean> {
  const result = await env.AGENT_AUDIT.prepare(
    "DELETE FROM collaboration_saved WHERE tenant_id=? AND workspace_id=? AND user_id=? AND message_id=?",
  )
    .bind(scope.tenantId, scope.workspaceId, scope.userId, messageId)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function listSavedMessages(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
): Promise<Array<{ roomId: string; messageId: string; savedAt: number }>> {
  await ensureCollabV2Migrated(env);
  const rows = await env.AGENT_AUDIT.prepare(
    "SELECT room_id, message_id, saved_at FROM collaboration_saved WHERE tenant_id=? AND workspace_id=? AND user_id=? ORDER BY saved_at DESC LIMIT 200",
  )
    .bind(scope.tenantId, scope.workspaceId, scope.userId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({
    roomId: String(row.room_id),
    messageId: String(row.message_id),
    savedAt: Number(row.saved_at),
  }));
}

export async function followThread(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  threadRootMessageId: string,
  createdAt: number,
): Promise<void> {
  await ensureMember(env, scope, roomId);
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_thread_follows (tenant_id,workspace_id,user_id,room_id,thread_root_message_id,created_at)
     VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
  )
    .bind(scope.tenantId, scope.workspaceId, scope.userId, roomId, threadRootMessageId, createdAt)
    .run();
}

export async function unfollowThread(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  threadRootMessageId: string,
): Promise<boolean> {
  const result = await env.AGENT_AUDIT.prepare(
    "DELETE FROM collaboration_thread_follows WHERE tenant_id=? AND workspace_id=? AND user_id=? AND room_id=? AND thread_root_message_id=?",
  )
    .bind(scope.tenantId, scope.workspaceId, scope.userId, roomId, threadRootMessageId)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function upsertReadCursor(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: { roomId: string; lastReadSeq: number; threadRootMessageId?: string; updatedAt: number },
): Promise<void> {
  await ensureMember(env, scope, input.roomId);
  const threadKey = input.threadRootMessageId ?? "";
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_read_cursors (tenant_id,workspace_id,user_id,room_id,thread_root_message_id,last_read_seq,updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id,workspace_id,user_id,room_id,thread_root_message_id)
     DO UPDATE SET last_read_seq=excluded.last_read_seq, updated_at=excluded.updated_at`,
  )
    .bind(
      scope.tenantId,
      scope.workspaceId,
      scope.userId,
      input.roomId,
      threadKey,
      input.lastReadSeq,
      input.updatedAt,
    )
    .run();
}

export { COLLAB_TENANT_ID };