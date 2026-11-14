import {
  CollaborationStoreError,
  createCollaborationMessage,
  humanActorId,
  type CollaborationScope,
} from "./collaboration-store.js";
import { ensureCollabV2Migrated, finalizeMessageV2, nextMessageSeq } from "./collaboration-v2-store.js";
import type { Env } from "./env.js";
import { randomHex } from "./mailbox-store.js";

export type TaskThreadStatus = "open" | "needs_you" | "working" | "done";
export type TaskReplyRole = "progress" | "result" | "handoff" | "approval";

export interface TaskThreadRow {
  taskId: string;
  roomId: string;
  rootMessageId: string;
  title: string;
  ownerUserId: string;
  ownerActorId: string;
  status: TaskThreadStatus;
  createdAt: number;
  updatedAt: number;
}

function mapTask(row: Record<string, unknown>): TaskThreadRow {
  return {
    taskId: String(row.task_id),
    roomId: String(row.room_id),
    rootMessageId: String(row.root_message_id),
    title: String(row.title),
    ownerUserId: String(row.owner_user_id),
    ownerActorId: String(row.owner_actor_id),
    status: row.status as TaskThreadStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

async function stamp(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  messageId: string,
  roomId: string,
  role: string,
  threadRoot: string | null,
  replyTo: string | null,
): Promise<void> {
  const seq = await nextMessageSeq(env, scope, roomId);
  await finalizeMessageV2(env, scope, messageId, {
    roomId,
    messageSeq: seq,
    threadRootMessageId: threadRoot,
    replyToMessageId: replyTo,
    messageRole: role,
  });
}

export async function openTaskThread(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: { roomId: string; title: string; ownerActorId?: string; createdAt: number },
): Promise<TaskThreadRow> {
  await ensureCollabV2Migrated(env);
  const taskId = `task_${randomHex(8)}`;
  const rootMessageId = `taskroot_${randomHex(8)}`;
  const ownerActorId = input.ownerActorId?.trim() || humanActorId(scope.userId);
  const saved = await createCollaborationMessage(env, scope, {
    messageId: rootMessageId,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    roomId: input.roomId,
    senderUserId: scope.userId,
    senderActorId: humanActorId(scope.userId),
    senderKind: "human",
    body: input.title,
    profileVersion: null,
    createdAt: input.createdAt,
  });
  if (!saved) throw new CollaborationStoreError("Room membership required.", 403);
  await stamp(env, scope, rootMessageId, input.roomId, "task_root", rootMessageId, null);
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_task_threads
      (tenant_id,workspace_id,task_id,room_id,root_message_id,title,owner_user_id,owner_actor_id,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?, 'open', ?, ?)`,
  )
    .bind(
      scope.tenantId,
      scope.workspaceId,
      taskId,
      input.roomId,
      rootMessageId,
      input.title.slice(0, 240),
      scope.userId,
      ownerActorId,
      input.createdAt,
      input.createdAt,
    )
    .run();
  return (await getTaskThread(env, scope, input.roomId, taskId))!;
}

export async function getTaskThread(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
  taskId: string,
): Promise<TaskThreadRow | null> {
  await ensureCollabV2Migrated(env);
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT * FROM collaboration_task_threads
     WHERE tenant_id=? AND workspace_id=? AND room_id=? AND task_id=?
       AND EXISTS (SELECT 1 FROM collaboration_memberships m
         WHERE m.tenant_id=? AND m.workspace_id=? AND m.room_id=? AND m.user_id=? AND m.status='active')`,
  )
    .bind(scope.tenantId, scope.workspaceId, roomId, taskId, scope.tenantId, scope.workspaceId, roomId, scope.userId)
    .first<Record<string, unknown>>();
  return row ? mapTask(row) : null;
}

export async function listRoomTasks(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  roomId: string,
): Promise<TaskThreadRow[]> {
  await ensureCollabV2Migrated(env);
  const rows = await env.AGENT_AUDIT.prepare(
    `SELECT t.* FROM collaboration_task_threads t
     WHERE t.tenant_id=? AND t.workspace_id=? AND t.room_id=?
       AND EXISTS (SELECT 1 FROM collaboration_memberships m
         WHERE m.tenant_id=t.tenant_id AND m.workspace_id=t.workspace_id AND m.room_id=t.room_id AND m.user_id=? AND m.status='active')
     ORDER BY t.updated_at DESC LIMIT 100`,
  )
    .bind(scope.tenantId, scope.workspaceId, roomId, scope.userId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map(mapTask);
}

export async function postTaskReply(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: {
    roomId: string;
    taskId: string;
    body: string;
    role: TaskReplyRole;
    assigneeActorId?: string;
    createdAt: number;
  },
): Promise<{ messageId: string; channelMessageId?: string; task: TaskThreadRow }> {
  const task = await getTaskThread(env, scope, input.roomId, input.taskId);
  if (!task) throw new CollaborationStoreError("Task thread not found.", 404);
  const messageId = `taskreply_${randomHex(8)}`;
  const text = input.role === "handoff" && input.assigneeActorId
    ? `Handoff: ${humanActorId(scope.userId)} assigned ${input.assigneeActorId}. ${input.body}`
    : input.body;
  const saved = await createCollaborationMessage(env, scope, {
    messageId,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    roomId: input.roomId,
    senderUserId: scope.userId,
    senderActorId: humanActorId(scope.userId),
    senderKind: "human",
    body: text.slice(0, 4000),
    profileVersion: null,
    createdAt: input.createdAt,
  });
  if (!saved) throw new CollaborationStoreError("Room membership required.", 403);
  await stamp(env, scope, messageId, input.roomId, input.role, task.rootMessageId, task.rootMessageId);
  let channelMessageId: string | undefined;
  let status: TaskThreadStatus = input.role === "handoff" ? "working" : task.status;
  let ownerActorId = task.ownerActorId;
  if (input.role === "handoff" && input.assigneeActorId) ownerActorId = input.assigneeActorId;
  if (input.role === "approval") status = "needs_you";
  if (input.role === "result") {
    status = "done";
    channelMessageId = `taskresult_${randomHex(8)}`;
    const channel = await createCollaborationMessage(env, scope, {
      messageId: channelMessageId,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      roomId: input.roomId,
      senderUserId: scope.userId,
      senderActorId: humanActorId(scope.userId),
      senderKind: "human",
      body: `Result: ${input.body}`.slice(0, 4000),
      profileVersion: null,
      createdAt: input.createdAt,
    });
    if (channel) {
      await stamp(env, scope, channelMessageId, input.roomId, "result", null, task.rootMessageId);
    }
  }
  await env.AGENT_AUDIT.prepare(
    `UPDATE collaboration_task_threads SET status=?, owner_actor_id=?, updated_at=?
     WHERE tenant_id=? AND workspace_id=? AND task_id=?`,
  )
    .bind(status, ownerActorId, input.createdAt, scope.tenantId, scope.workspaceId, input.taskId)
    .run();
  return { messageId, channelMessageId, task: (await getTaskThread(env, scope, input.roomId, input.taskId))! };
}
