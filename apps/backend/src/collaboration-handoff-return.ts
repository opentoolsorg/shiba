import type { CollaborationScope } from "./collaboration-store.js";
import { ensureCoordinationSchema } from "./coordination-schema.js";
import { publishWorkspaceEvent } from "./platform/workspace-events-do.js";
import type { Env } from "./env.js";
import { randomHex } from "./mailbox-store.js";

export interface HandoffReturnInput {
  handoffId: string;
  parentRoomId: string;
  parentThreadRootId?: string | null;
  parentActorId: string;
  childRoomId: string;
  childThreadRootId?: string | null;
  createdAt: number;
}

export async function attachHandoffReturn(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: HandoffReturnInput,
): Promise<void> {
  await ensureCoordinationSchema(env);
  await env.AGENT_AUDIT.prepare(
    `INSERT OR IGNORE INTO collaboration_handoff_returns
      (tenant_id, workspace_id, handoff_id, parent_room_id, parent_thread_root_id, parent_actor_id,
       child_room_id, child_thread_root_id, status, reported_message_id, created_at)
     VALUES (?,?,?,?,?,?,?,?, 'pending', NULL, ?)`,
  )
    .bind(
      scope.tenantId,
      scope.workspaceId,
      input.handoffId,
      input.parentRoomId,
      input.parentThreadRootId ?? null,
      input.parentActorId,
      input.childRoomId,
      input.childThreadRootId ?? null,
      input.createdAt,
    )
    .run();
}

/**
 * One conditional update in a single batch, so concurrent result posts
 * publish exactly one handoff_report to the parent thread.
 * The report addresses only the parent agent.
 */
export async function reportPendingHandoff(
  env: Env,
  scope: CollaborationScope,
  input: {
    childRoomId: string;
    childThreadRootId: string;
    resultMessageId: string;
    resultBody: string;
    runId?: string;
    pr?: string;
    now: number;
  },
): Promise<{ reported: boolean; messageId?: string }> {
  await ensureCoordinationSchema(env);
  const pending = await env.AGENT_AUDIT.prepare(
    `SELECT handoff_id, parent_room_id, parent_thread_root_id, parent_actor_id
     FROM collaboration_handoff_returns
     WHERE tenant_id=? AND workspace_id=? AND child_room_id=? AND child_thread_root_id=? AND status='pending'
     ORDER BY created_at LIMIT 1`,
  )
    .bind(scope.tenantId, scope.workspaceId, input.childRoomId, input.childThreadRootId)
    .first<{
      handoff_id: string;
      parent_room_id: string;
      parent_thread_root_id: string | null;
      parent_actor_id: string;
    }>();
  if (!pending) return { reported: false };
  const messageId = `evt_${randomHex(8)}`;
  const payload = JSON.stringify({
    handoffId: pending.handoff_id,
    resultMessageId: input.resultMessageId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.pr ? { pr: input.pr } : {}),
    actorId: pending.parent_actor_id,
  });
  const db = env.AGENT_AUDIT;
  const results = await db.batch([
    db.prepare(
      `INSERT INTO collaboration_messages (
         message_id, tenant_id, workspace_id, room_id, sender_user_id, sender_actor_id, sender_kind,
         body, profile_version, created_at, thread_root_id, message_kind, payload_json, seq, version
       )
       SELECT ?, r.tenant_id, r.workspace_id, r.parent_room_id, h.recipient_user_id, h.recipient_actor_id, 'agent',
         ?, h.profile_version, ?, r.parent_thread_root_id, 'handoff_report', ?,
         (SELECT COALESCE(MAX(m.seq), 0) + 1 FROM collaboration_messages m
           WHERE m.tenant_id=r.tenant_id AND m.workspace_id=r.workspace_id AND m.room_id=r.parent_room_id),
         1
       FROM collaboration_handoff_returns r
       JOIN collaboration_handoffs h
         ON h.tenant_id=r.tenant_id AND h.workspace_id=r.workspace_id AND h.handoff_id=r.handoff_id
       WHERE r.tenant_id=? AND r.workspace_id=? AND r.handoff_id=? AND r.status='pending'
         AND EXISTS (
           SELECT 1 FROM collaboration_memberships mem
           WHERE mem.tenant_id=r.tenant_id AND mem.workspace_id=r.workspace_id AND mem.room_id=r.parent_room_id
             AND mem.actor_id=h.recipient_actor_id AND mem.user_id=h.recipient_user_id AND mem.status='active'
         )`,
    ).bind(
      messageId,
      input.resultBody.slice(0, 280),
      input.now,
      payload,
      scope.tenantId,
      scope.workspaceId,
      pending.handoff_id,
    ),
    db.prepare(
      `UPDATE collaboration_handoff_returns
       SET status='reported', reported_message_id=?
       WHERE changes()=1 AND tenant_id=? AND workspace_id=? AND handoff_id=? AND status='pending'`,
    ).bind(messageId, scope.tenantId, scope.workspaceId, pending.handoff_id),
  ]);
  const inserted = Number(results[0]?.meta?.changes ?? 0) === 1;
  if (!inserted) return { reported: false };
  if (pending.parent_thread_root_id) {
    await db.prepare(
      `UPDATE collaboration_messages SET reply_count=reply_count+1, last_reply_at=?
       WHERE tenant_id=? AND workspace_id=? AND message_id=?`,
    )
      .bind(input.now, scope.tenantId, scope.workspaceId, pending.parent_thread_root_id)
      .run();
  }
  const members = await db.prepare(
    `SELECT user_id FROM collaboration_memberships
     WHERE tenant_id=? AND workspace_id=? AND room_id=? AND status='active'`,
  )
    .bind(scope.tenantId, scope.workspaceId, pending.parent_room_id)
    .all<{ user_id: string }>();
  await publishWorkspaceEvent(env, scope.workspaceId, {
    type: "room.message",
    resourceId: pending.parent_room_id,
    version: input.now,
    audience: {
      userIds: (members.results ?? []).map((row) => row.user_id),
      roomId: pending.parent_room_id,
    },
  });
  return { reported: true, messageId };
}

/** Cancelling a handoff marks the return cancelled and posts one system line in the parent thread. */
export async function cancelHandoffReturn(
  env: Env,
  scope: CollaborationScope,
  handoffId: string,
  cancelledAt: number,
): Promise<boolean> {
  await ensureCoordinationSchema(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT parent_room_id, parent_thread_root_id
     FROM collaboration_handoff_returns
     WHERE tenant_id=? AND workspace_id=? AND handoff_id=? AND status='pending'`,
  )
    .bind(scope.tenantId, scope.workspaceId, handoffId)
    .first<{ parent_room_id: string; parent_thread_root_id: string | null }>();
  if (!row) return false;
  const result = await env.AGENT_AUDIT.prepare(
    `UPDATE collaboration_handoff_returns SET status='cancelled'
     WHERE tenant_id=? AND workspace_id=? AND handoff_id=? AND status='pending'`,
  )
    .bind(scope.tenantId, scope.workspaceId, handoffId)
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1) return false;
  const { postRoomEvent } = await import("./collaboration-thread-post.js");
  await postRoomEvent(env, scope, {
    roomId: row.parent_room_id,
    threadRootId: row.parent_thread_root_id,
    kind: "system",
    body: "Handoff cancelled.",
    now: cancelledAt,
  });
  return true;
}
