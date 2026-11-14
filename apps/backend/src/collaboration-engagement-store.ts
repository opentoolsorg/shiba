import { CollaborationStoreError, type CollaborationScope } from "./collaboration-store.js";
import { ensureCollabV2Migrated, ensureMember } from "./collaboration-v2-store.js";
import type { Env } from "./env.js";

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
    `INSERT INTO collaboration_thread_follows (tenant_id,workspace_id,user_id,room_id,thread_root_id,created_at)
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
    "DELETE FROM collaboration_thread_follows WHERE tenant_id=? AND workspace_id=? AND user_id=? AND room_id=? AND thread_root_id=?",
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
    `INSERT INTO collaboration_read_cursors (tenant_id,workspace_id,user_id,room_id,thread_root_id,last_read_seq,updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(tenant_id,workspace_id,user_id,room_id,thread_root_id)
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

