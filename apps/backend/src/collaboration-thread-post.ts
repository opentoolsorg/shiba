/**
 * The only write path for thread events. Other workstreams call postRoomEvent
 * and do not insert into collaboration tables themselves.
 */
import type { PostRoomEventInput, ThreadMessagePayload } from "@shiba/shared";
import {
  createCollaborationMessage,
  ensureCollaborationSchema,
  humanActorId,
  type CollaborationScope,
} from "./collaboration-store.js";
import { finalizeMessageV2, nextMessageSeq } from "./collaboration-v2-store.js";
import { publishWorkspaceEvent } from "./platform/workspace-events-do.js";
import type { Env } from "./env.js";
import { randomHex } from "./mailbox-store.js";

export interface PostRoomEventResult {
  messageId: string;
  seq: number;
  version: number;
  edited: boolean;
}

function payloadJson(payload: ThreadMessagePayload | undefined): string {
  const ids: ThreadMessagePayload = {};
  if (payload?.approvalId) ids.approvalId = payload.approvalId;
  if (payload?.askId) ids.askId = payload.askId;
  if (payload?.runId) ids.runId = payload.runId;
  if (payload?.taskId) ids.taskId = payload.taskId;
  if (payload?.handoffId) ids.handoffId = payload.handoffId;
  if (payload?.pr) ids.pr = payload.pr;
  if (payload?.actorId) ids.actorId = payload.actorId;
  if (payload?.ownerActorId) ids.ownerActorId = payload.ownerActorId;
  return JSON.stringify(ids);
}

async function roomAudience(env: Pick<Env, "AGENT_AUDIT">, scope: CollaborationScope, roomId: string): Promise<string[]> {
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT user_id FROM collaboration_memberships
     WHERE tenant_id=? AND workspace_id=? AND room_id=? AND status='active'`,
  ).bind(scope.tenantId, scope.workspaceId, roomId).all<{ user_id: string }>();
  return (rows.results ?? []).map((row) => row.user_id);
}

export async function postRoomEvent(
  env: Env,
  scope: CollaborationScope,
  input: PostRoomEventInput & { actorId?: string; userId?: string; now?: number },
): Promise<PostRoomEventResult> {
  await ensureCollaborationSchema(env);
  const now = input.now ?? Date.now();
  const actorId = input.actorId ?? humanActorId(scope.userId);
  const userId = input.userId ?? scope.userId;
  if (input.kind === "status" && input.threadRootId) {
    const existing = await env.AGENT_AUDIT.prepare(
      `SELECT message_id, version FROM collaboration_messages
       WHERE tenant_id=? AND workspace_id=? AND room_id=? AND thread_root_id=? AND message_kind='status'
       LIMIT 1`,
    ).bind(scope.tenantId, scope.workspaceId, input.roomId, input.threadRootId).first<{ message_id: string; version: number }>();
    if (existing) {
      const version = Number(existing.version) + 1;
      await env.AGENT_AUDIT.prepare(
        `UPDATE collaboration_messages
         SET body=?, payload_json=?, edited_at=?, version=?
         WHERE tenant_id=? AND workspace_id=? AND message_id=?`,
      ).bind(
        (input.body ?? "Working").slice(0, 500),
        payloadJson(input.payload),
        now,
        version,
        scope.tenantId,
        scope.workspaceId,
        existing.message_id,
      ).run();
      const members = await roomAudience(env, scope, input.roomId);
      await publishWorkspaceEvent(env, scope.workspaceId, {
        type: "room.message",
        resourceId: input.roomId,
        version,
        audience: { userIds: members, roomId: input.roomId },
      });
      return { messageId: existing.message_id, seq: 0, version, edited: true };
    }
  }
  const messageId = `evt_${randomHex(8)}`;
  const saved = await createCollaborationMessage(env, scope, {
    messageId,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    roomId: input.roomId,
    senderUserId: userId,
    senderActorId: actorId,
    senderKind: actorId.startsWith("agent:") ? "agent" : "human",
    body: (input.body ?? input.kind).slice(0, 4000),
    profileVersion: null,
    createdAt: now,
  });
  if (!saved) throw new Error("Room membership required.");
  const seq = await nextMessageSeq(env, scope, input.roomId);
  await finalizeMessageV2(env, scope, messageId, {
    roomId: input.roomId,
    messageSeq: seq,
    threadRootMessageId: input.kind === "result" ? null : input.threadRootId,
    messageKind: input.kind,
    alsoInChannel: input.kind === "result" || input.alsoInChannel === true,
  });
  await env.AGENT_AUDIT.prepare(
    `UPDATE collaboration_messages SET payload_json=?, version=1 WHERE tenant_id=? AND workspace_id=? AND message_id=?`,
  ).bind(payloadJson(input.payload), scope.tenantId, scope.workspaceId, messageId).run();
  if (input.threadRootId && input.kind !== "result") {
    await env.AGENT_AUDIT.prepare(
      `UPDATE collaboration_messages SET reply_count=reply_count+1, last_reply_at=?
       WHERE tenant_id=? AND workspace_id=? AND message_id=?`,
    ).bind(now, scope.tenantId, scope.workspaceId, input.threadRootId).run();
  }
  const members = await roomAudience(env, scope, input.roomId);
  await publishWorkspaceEvent(env, scope.workspaceId, {
    type: "room.message",
    resourceId: input.roomId,
    version: seq,
    audience: { userIds: members, roomId: input.roomId },
  });
  return { messageId, seq, version: 1, edited: false };
}
