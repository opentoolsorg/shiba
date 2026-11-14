import type { CollaborationScope } from "./collaboration-store.js";
import {
  createRootCollaborationHandoff,
  getActiveCollaborationMembership,
  humanActorId,
  type CollaborationHandoffRow,
} from "./collaboration-store.js";
import { agentMayReply } from "./collaboration-addressing.js";
import { openTaskThread, postTaskReply } from "./collaboration-task-threads.js";
import { createWorkspaceNotification, getWorkspaceNotificationPrefs } from "./notifications/notifications-store.js";
import type { Env } from "./env.js";
import { randomHex } from "./mailbox-store.js";

export interface ParsedMentions {
  users: string[];
  agents: string[];
}

const USER_MENTION = /@user:([^\s@]+@[^\s@]+)/gi;
const AGENT_MENTION = /@agent:([A-Za-z0-9_-]{1,80})/gi;

/** Agents are not invoked unless the body names them with @agent:<profileId>. */
export function parseCollaborationMentions(body: string): ParsedMentions {
  const users = new Set<string>();
  const agents = new Set<string>();
  for (const match of body.matchAll(USER_MENTION)) {
    if (match[1]) users.add(match[1].trim().toLowerCase());
  }
  for (const match of body.matchAll(AGENT_MENTION)) {
    if (match[1]) agents.add(match[1].trim());
  }
  return { users: [...users], agents: [...agents] };
}

export async function attachMessageV2Metadata(
  env: Pick<Env, "AGENT_AUDIT">,
  scope: CollaborationScope,
  input: {
    roomId: string;
    messageId: string;
    replyToMessageId?: string | null;
    threadRootMessageId?: string | null;
  },
): Promise<number> {
  const { finalizeMessageV2, nextMessageSeq } = await import("./collaboration-v2-store.js");
  const seq = await nextMessageSeq(env, scope, input.roomId);
  await finalizeMessageV2(env, scope, input.messageId, {
    roomId: input.roomId,
    messageSeq: seq,
    threadRootMessageId: input.threadRootMessageId ?? input.replyToMessageId ?? null,
    messageKind: input.threadRootMessageId || input.replyToMessageId ? "text" : "text",
  });
  return seq;
}

/**
 * @agent mentions open a task thread and an approval handoff.
 * Nothing is queued to run until a human approves that handoff.
 */
export async function handleCollaborationMentions(
  env: Env,
  scope: CollaborationScope,
  input: {
    roomId: string;
    messageId: string;
    body: string;
    channelKind?: "room" | "channel" | "dm";
    now: number;
  },
): Promise<{ handoffs: CollaborationHandoffRow[]; taskId?: string }> {
  const parsed = parseCollaborationMentions(input.body);
  const prefs = await getWorkspaceNotificationPrefs(env, scope);
  if (prefs.mentions) {
    for (const userId of parsed.users) {
      if (userId === scope.userId) continue;
      await createWorkspaceNotification(env, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        userId,
        kind: "mention",
        title: "You were mentioned",
        body: input.body.slice(0, 500),
        roomId: input.roomId,
        messageId: input.messageId,
        createdAt: input.now,
      });
    }
  }
  if (parsed.agents.length === 0) return { handoffs: [] };
  const handoffs: CollaborationHandoffRow[] = [];
  let taskId: string | undefined;
  for (const profileId of parsed.agents) {
    const actorId = `agent:${profileId}`;
    const recipient = await getActiveCollaborationMembership(env, scope, input.roomId, actorId);
    if (!recipient) continue;
    if (!agentMayReply({
      mentioned: true,
      ownsThread: false,
      soleAgentInDm: input.channelKind === "dm",
      receivedHandoff: false,
      listenMode: "mentions",
    })) continue;
    const task = await openTaskThread(env, scope, {
      roomId: input.roomId,
      title: input.body.slice(0, 240),
      ownerActorId: actorId,
      createdAt: input.now,
    });
    taskId = task.taskId;
    await postTaskReply(env, scope, {
      roomId: input.roomId,
      taskId: task.taskId,
      body: `Waiting for approval before ${actorId} starts.`,
      role: "approval",
      createdAt: input.now,
    });
    const handoffId = `mention_${randomHex(10)}`;
    const row: CollaborationHandoffRow = {
      handoffId,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      roomId: input.roomId,
      taskId: task.taskId,
      senderUserId: scope.userId,
      senderActorId: humanActorId(scope.userId),
      recipientUserId: recipient.userId,
      recipientActorId: recipient.actorId,
      parentHandoffId: null,
      rootHandoffId: handoffId,
      depth: 0,
      ancestorHandoffIds: [],
      remainingBudget: 0,
      grantedCapabilities: ["room.read", "message.send"],
      profileVersion: recipient.profileVersion,
      status: "active",
      createdAt: input.now,
      cancelledAt: null,
    };
    const saved = await createRootCollaborationHandoff(env, scope, row, undefined);
    if (saved) {
      handoffs.push(saved);
      await createWorkspaceNotification(env, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        userId: scope.userId,
        kind: "needs_you",
        title: "Approve agent",
        body: `Approve ${actorId} before any run starts.`,
        roomId: input.roomId,
        messageId: input.messageId,
        metadata: { handoffId: saved.handoffId, taskId: task.taskId },
        createdAt: input.now,
      });
    }
  }
  return { handoffs, taskId };
}
