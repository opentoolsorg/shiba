import type { CollaborationScope } from "./collaboration-store.js";
import { postRoomEvent } from "./collaboration-thread-post.js";
import { ensureCoordinationSchema } from "./coordination-schema.js";
import type { Env } from "./env.js";

/** Explicit @agent mentions claim their own actor id. Everything else shares this slot. */
export const AUTO_REPLY_SLOT = "auto";

export async function claimReply(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: {
    roomId: string;
    triggerMessageId: string;
    slot: string;
    actorId: string;
    sourceSlackEventId?: string | null;
    claimedAt?: number;
  },
): Promise<boolean> {
  await ensureCoordinationSchema(env);
  const result = await env.AGENT_AUDIT.prepare(
    `INSERT OR IGNORE INTO collaboration_reply_claims
      (tenant_id, workspace_id, room_id, trigger_message_id, slot, actor_id, claimed_at, source_slack_event_id)
     VALUES (?,?,?,?,?,?,?,?)`,
  )
    .bind(
      scope.tenantId,
      scope.workspaceId,
      input.roomId,
      input.triggerMessageId,
      input.slot,
      input.actorId,
      input.claimedAt ?? Date.now(),
      input.sourceSlackEventId?.trim() || null,
    )
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

/**
 * Listen-mode `all` agents share the auto slot, so only the first one acks.
 * Call this after the thread owner and before the router.
 */
export async function ackListenAllAgents(
  env: Env,
  scope: CollaborationScope,
  input: {
    roomId: string;
    triggerMessageId: string;
    sourceSlackEventId?: string | null;
    now: number;
  },
): Promise<boolean> {
  await ensureCoordinationSchema(env);
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT m.actor_id, m.user_id, m.display_name
     FROM collaboration_memberships m
     WHERE m.tenant_id=? AND m.workspace_id=? AND m.room_id=? AND m.status='active' AND m.actor_kind='agent'
       AND EXISTS (
         SELECT 1 FROM collaboration_agent_listen_mode l
         WHERE l.tenant_id=m.tenant_id AND l.workspace_id=m.workspace_id AND l.room_id=m.room_id
           AND l.actor_id=m.actor_id AND l.mode='all'
       )
     ORDER BY m.actor_id`,
  )
    .bind(scope.tenantId, scope.workspaceId, input.roomId)
    .all<{ actor_id: string; user_id: string; display_name: string }>();
  for (const row of rows.results ?? []) {
    const won = await claimReply(env, scope, {
      roomId: input.roomId,
      triggerMessageId: input.triggerMessageId,
      slot: AUTO_REPLY_SLOT,
      actorId: row.actor_id,
      sourceSlackEventId: input.sourceSlackEventId,
      claimedAt: input.now,
    });
    if (!won) return false;
    await postRoomEvent(env, { ...scope, userId: row.user_id }, {
      roomId: input.roomId,
      threadRootId: input.triggerMessageId,
      kind: "ack",
      body: `${row.display_name} acknowledged.`,
      actorId: row.actor_id,
      userId: row.user_id,
      now: input.now,
    });
    return true;
  }
  return false;
}

/** The thread owner claims the auto slot before listen-mode agents and the router. */
export async function ackThreadOwner(
  env: Env,
  scope: CollaborationScope,
  input: {
    roomId: string;
    triggerMessageId: string;
    threadRootId?: string | null;
    sourceSlackEventId?: string | null;
    now: number;
  },
): Promise<boolean> {
  if (!input.threadRootId) return false;
  await ensureCoordinationSchema(env);
  const owner = await env.AGENT_AUDIT.prepare(
    `SELECT t.owner_actor_id, m.user_id, m.display_name
     FROM collaboration_task_threads t
     JOIN collaboration_memberships m
       ON m.tenant_id=t.tenant_id AND m.workspace_id=t.workspace_id AND m.room_id=t.room_id
      AND m.actor_id=t.owner_actor_id AND m.status='active' AND m.actor_kind='agent'
     WHERE t.tenant_id=? AND t.workspace_id=? AND t.room_id=? AND t.root_message_id=?`,
  )
    .bind(scope.tenantId, scope.workspaceId, input.roomId, input.threadRootId)
    .first<{ owner_actor_id: string; user_id: string; display_name: string }>();
  if (!owner) return false;
  const won = await claimReply(env, scope, {
    roomId: input.roomId,
    triggerMessageId: input.triggerMessageId,
    slot: AUTO_REPLY_SLOT,
    actorId: owner.owner_actor_id,
    sourceSlackEventId: input.sourceSlackEventId,
    claimedAt: input.now,
  });
  if (!won) return false;
  await postRoomEvent(env, { ...scope, userId: owner.user_id }, {
    roomId: input.roomId,
    threadRootId: input.threadRootId,
    kind: "ack",
    body: `${owner.display_name} acknowledged.`,
    actorId: owner.owner_actor_id,
    userId: owner.user_id,
    now: input.now,
  });
  return true;
}
