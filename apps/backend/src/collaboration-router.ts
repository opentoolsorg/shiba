import {
  createRootCollaborationHandoff,
  type CollaborationHandoffRow,
  type CollaborationScope,
} from "./collaboration-store.js";
import { AUTO_REPLY_SLOT, ackListenAllAgents, ackThreadOwner, claimReply } from "./collaboration-reply-claims.js";
import { attachHandoffReturn } from "./collaboration-handoff-return.js";
import { handleCollaborationMentions, parseCollaborationMentions } from "./collaboration-mentions.js";
import { classifyRoute, loadRankedBots, primaryActorId, ROUTER_MARGIN, type RankedBot } from "./collaboration-router-rank.js";
import { openTaskThread, postTaskReply } from "./collaboration-task-threads.js";
import { postRoomEvent } from "./collaboration-thread-post.js";
import { ensureCoordinationSchema } from "./coordination-schema.js";
import type { Env } from "./env.js";
import { randomHex } from "./mailbox-store.js";

export interface RouteResult {
  action: "silent" | "handoff" | "question" | "owner";
  handoffs: CollaborationHandoffRow[];
  /** Routing never starts a run. Approval still gates execution. */
  startedRun: false;
}

const SILENT: RouteResult = { action: "silent", handoffs: [], startedRun: false };

async function recordDecision(
  env: Env,
  scope: CollaborationScope,
  input: { roomId: string; messageId: string; chosenActorId: string | null; candidates: RankedBot[]; reason: string; confidence: number; now: number },
): Promise<void> {
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO collaboration_router_decisions
      (decision_id, tenant_id, workspace_id, room_id, message_id, chosen_actor_id, candidates_json, reason, confidence, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO NOTHING`,
  ).bind(
    `route_${randomHex(8)}`,
    scope.tenantId,
    scope.workspaceId,
    input.roomId,
    input.messageId,
    input.chosenActorId,
    JSON.stringify(input.candidates.map((bot) => ({ actorId: bot.actorId, name: bot.name, score: bot.score }))),
    input.reason.slice(0, 240),
    input.confidence,
    input.now,
  ).run();
}

/** Primary bot routes a human message that names no @agent. Nothing runs before approval. */
export async function routeUnaddressedMessage(
  env: Env,
  scope: CollaborationScope,
  input: {
    roomId: string;
    messageId: string;
    body: string;
    channelKind?: "room" | "channel" | "dm";
    sourceSlackEventId?: string | null;
    now: number;
  },
): Promise<RouteResult> {
  if (parseCollaborationMentions(input.body).agents.length > 0) return SILENT;
  await ensureCoordinationSchema(env);
  const primaryId = await primaryActorId(env, scope);
  if (!primaryId) return SILENT;
  const member = await env.AGENT_AUDIT.prepare(
    `SELECT user_id, display_name FROM collaboration_memberships
     WHERE tenant_id=? AND workspace_id=? AND room_id=? AND actor_id=? AND status='active'`,
  ).bind(scope.tenantId, scope.workspaceId, input.roomId, primaryId)
    .first<{ user_id: string; display_name: string }>();
  if (!member) return SILENT;
  const ranked = await loadRankedBots(env, scope, input.roomId, input.channelKind ?? "room", input.body);
  const top = ranked[0];
  if (!top) return SILENT;
  const margin = top.score - (ranked[1]?.score ?? 0);
  let chosen = top;
  let confidence = margin >= ROUTER_MARGIN && chosen.score > 0 ? 0.9 : 0.2;
  let reason = chosen.reason;
  let fromModel = false;
  if (margin < ROUTER_MARGIN || chosen.score === 0) {
    const judged = await classifyRoute(env, input.body, ranked);
    if (judged && judged.confidence >= 0.66) {
      const match = ranked.find((bot) => bot.actorId === judged.actorId);
      if (match) {
        chosen = match;
        confidence = judged.confidence;
        reason = judged.reason || match.reason;
        fromModel = true;
      }
    }
  }
  const confident = fromModel || (margin >= ROUTER_MARGIN && chosen.score > 0);
  const claimed = await claimReply(env, scope, {
    roomId: input.roomId,
    triggerMessageId: input.messageId,
    slot: AUTO_REPLY_SLOT,
    actorId: primaryId,
    sourceSlackEventId: input.sourceSlackEventId,
    claimedAt: input.now,
  });
  if (!claimed) return SILENT;
  const speaker = { ...scope, userId: member.user_id };
  if (!confident) {
    const options = [...ranked.filter((bot) => bot.actorId !== primaryId).slice(0, 3).map((bot) => bot.name), "I'll handle it"].slice(0, 4);
    await postRoomEvent(env, speaker, {
      roomId: input.roomId,
      threadRootId: input.messageId,
      kind: "question_card",
      body: ["Who should take this?", ...options].join("\n"),
      actorId: primaryId,
      userId: member.user_id,
      payload: { actorId: primaryId, ownerActorId: primaryId },
      now: input.now,
    });
    await recordDecision(env, scope, { roomId: input.roomId, messageId: input.messageId, chosenActorId: null, candidates: ranked, reason: "Asked who should take this.", confidence, now: input.now });
    return { action: "question", handoffs: [], startedRun: false };
  }
  const task = await openTaskThread(env, scope, {
    roomId: input.roomId,
    title: input.body.slice(0, 240),
    ownerActorId: chosen.actorId,
    createdAt: input.now,
  });
  await postTaskReply(env, scope, {
    roomId: input.roomId,
    taskId: task.taskId,
    body: `Waiting for approval before ${chosen.name} starts.`,
    role: "approval",
    createdAt: input.now,
  });
  if (chosen.actorId === primaryId) {
    await recordDecision(env, scope, { roomId: input.roomId, messageId: input.messageId, chosenActorId: primaryId, candidates: ranked, reason, confidence, now: input.now });
    return { action: "owner", handoffs: [], startedRun: false };
  }
  await postRoomEvent(env, scope, {
    roomId: input.roomId,
    threadRootId: task.rootMessageId,
    kind: "system",
    body: `Parent thread ${input.messageId}.`,
    now: input.now,
  });
  const handoffId = `route_${randomHex(10)}`;
  const saved = await createRootCollaborationHandoff(env, speaker, {
    handoffId,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    roomId: input.roomId,
    taskId: task.taskId,
    senderUserId: member.user_id,
    senderActorId: primaryId,
    recipientUserId: chosen.userId,
    recipientActorId: chosen.actorId,
    parentHandoffId: null,
    rootHandoffId: handoffId,
    depth: 0,
    ancestorHandoffIds: [],
    remainingBudget: 4,
    grantedCapabilities: ["room.read", "message.send"],
    profileVersion: chosen.profileVersion,
    status: "active",
    createdAt: input.now,
    cancelledAt: null,
  });
  if (!saved) return SILENT;
  await attachHandoffReturn(env, scope, {
    handoffId: saved.handoffId,
    parentRoomId: input.roomId,
    parentThreadRootId: input.messageId,
    parentActorId: primaryId,
    childRoomId: input.roomId,
    childThreadRootId: task.rootMessageId,
    createdAt: input.now,
  });
  const taskText = input.body.replace(/\s+/g, " ").trim().slice(0, 180);
  await postRoomEvent(env, speaker, {
    roomId: input.roomId,
    threadRootId: input.messageId,
    kind: "handoff",
    body: `${member.display_name} → ${chosen.name}: ${taskText} · because ${reason}`,
    actorId: primaryId,
    userId: member.user_id,
    payload: { handoffId: saved.handoffId, childThreadRootId: task.rootMessageId, actorId: chosen.actorId, ownerActorId: primaryId },
    now: input.now,
  });
  await recordDecision(env, scope, { roomId: input.roomId, messageId: input.messageId, chosenActorId: chosen.actorId, candidates: ranked, reason, confidence, now: input.now });
  return { action: "handoff", handoffs: [saved], startedRun: false };
}

/** Mention, then thread owner, then listen-mode all, then the router. */
export async function coordinateHumanMessage(
  env: Env,
  scope: CollaborationScope,
  input: {
    roomId: string;
    messageId: string;
    body: string;
    channelKind?: "room" | "channel" | "dm";
    threadRootId?: string | null;
    sourceSlackEventId?: string | null;
    now: number;
  },
): Promise<RouteResult> {
  if (parseCollaborationMentions(input.body).agents.length > 0) {
    const mentions = await handleCollaborationMentions(env, scope, input);
    return { action: "silent", handoffs: mentions.handoffs, startedRun: false };
  }
  if (await ackThreadOwner(env, scope, {
    roomId: input.roomId,
    triggerMessageId: input.messageId,
    threadRootId: input.threadRootId,
    sourceSlackEventId: input.sourceSlackEventId,
    now: input.now,
  })) return { action: "owner", handoffs: [], startedRun: false };
  if (await ackListenAllAgents(env, scope, {
    roomId: input.roomId,
    triggerMessageId: input.messageId,
    sourceSlackEventId: input.sourceSlackEventId,
    now: input.now,
  })) return SILENT;
  return routeUnaddressedMessage(env, scope, input);
}

export async function getWorkspacePrimaryBot(env: Env, scope: CollaborationScope): Promise<{ actorId: string | null; source: "saved" | "default" }> {
  await ensureCoordinationSchema(env);
  const saved = await env.AGENT_AUDIT.prepare(
    "SELECT actor_id FROM workspace_primary_bot WHERE tenant_id=? AND workspace_id=?",
  ).bind(scope.tenantId, scope.workspaceId).first<{ actor_id: string }>();
  if (saved?.actor_id) return { actorId: saved.actor_id, source: "saved" };
  return { actorId: await primaryActorId(env, scope), source: "default" };
}

export async function setWorkspacePrimaryBot(env: Env, scope: CollaborationScope, actorId: string, updatedAt: number): Promise<void> {
  await ensureCoordinationSchema(env);
  await env.AGENT_AUDIT.prepare(
    `INSERT INTO workspace_primary_bot (tenant_id, workspace_id, actor_id, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(tenant_id, workspace_id) DO UPDATE SET actor_id=excluded.actor_id, updated_at=excluded.updated_at`,
  ).bind(scope.tenantId, scope.workspaceId, actorId, updatedAt).run();
}
