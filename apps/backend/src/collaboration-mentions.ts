import type { CollaborationScope } from "./collaboration-store.js";
import {
  createRootCollaborationHandoff,
  getActiveCollaborationMembership,
  humanActorId,
  type CollaborationHandoffRow,
} from "./collaboration-store.js";
import { finalizeMessageV2, nextMessageSeq } from "./collaboration-v2-store.js";
import type { Env } from "./env.js";
import { randomHex } from "./mailbox-store.js";
import { createWorkspaceNotification, getWorkspaceNotificationPrefs } from "./notifications/notifications-store.js";

export interface ParsedMentions {
  users: string[];
  agents: string[];
}

const USER_MENTION = /@user:([^\s@]+@[^\s@]+)/gi;
const AGENT_MENTION = /@agent:([A-Za-z0-9_-]{1,80})/gi;

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
  const seq = await nextMessageSeq(env, scope, input.roomId);
  const threadRoot =
    input.threadRootMessageId ??
    input.replyToMessageId ??
    null;
  await finalizeMessageV2(env, scope, input.messageId, {
    roomId: input.roomId,
    messageSeq: seq,
    threadRootMessageId: threadRoot,
    replyToMessageId: input.replyToMessageId ?? null,
  });
  return seq;
}

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
): Promise<{ handoffs: CollaborationHandoffRow[] }> {
  const parsed = parseCollaborationMentions(input.body);
  if (parsed.users.length === 0 && parsed.agents.length === 0) return { handoffs: [] };
  const prefs = await getWorkspaceNotificationPrefs(env, scope);
  const handoffs: CollaborationHandoffRow[] = [];

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

  if (parsed.agents.length === 0) return { handoffs };
  if (input.channelKind !== "channel") return { handoffs };

  for (const profileId of parsed.agents) {
    const actorId = `agent:${profileId}`;
    const recipient = await getActiveCollaborationMembership(env, scope, input.roomId, actorId);
    if (!recipient) continue;
    const handoffId = `mention_${randomHex(10)}`;
    const row: CollaborationHandoffRow = {
      handoffId,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      roomId: input.roomId,
      taskId: `mention:${input.messageId}`,
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
      if (prefs.agentApprovals) {
        await createWorkspaceNotification(env, {
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          kind: "agent_mention",
          title: "Agent mention queued",
          body: `Mentioned @agent:${profileId} for approval.`,
          roomId: input.roomId,
          messageId: input.messageId,
          metadata: { handoffId: saved.handoffId, recipientActorId: recipient.actorId },
          createdAt: input.now,
        });
      }
    }
  }
  return { handoffs };
}