/**
 * Microsoft Teams bot lane.
 *
 * The Bot Connector posts activities to POST /api/teams/messages with a
 * signed bearer JWT (see channels/teams). A message `shiba <repo-url> <task>`
 * (the leading word is optional once the bot is @mentioned or in a personal
 * chat) queues a pending approval on the conversation's orchestrator
 * (`teams:{conversationId}`) and replies with an Adaptive Card. Its
 * Action.Submit data is a pointer: only TEAMS_APPROVERS ids may press it,
 * and the orchestrator honors it only while it is still pending.
 *
 * The Connector retries slow responses, so an authenticated activity is
 * acked at once and the work runs behind `ctx.waitUntil`, deduped on its id.
 */
import { buildDecisionData, parseDecisionData } from "@shiba/shared";
import {
  CARD_TASK_LIMIT,
  chatApprovalText,
  chatTaskChunks,
  createSeenRing,
  decideChatApproval,
  decisionLine,
  parseChatTaskRequest,
  queueChatRun,
  type ResolveOrchestrator,
} from "./chat-lane.js";
import { stripTeamsMentions, teamsAdapterFromEnv, teamsTransport, type TeamsActivity } from "./channels/teams/index.js";
import type { ChannelAdapter, ChannelTransport, InboundAction, InboundMessage } from "./ports/channel/index.js";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";
import { isApprover, parseApproverAllowlist, type ExecutionContextLike } from "./slack-approval.js";

export const TEAMS_MESSAGES_PATH = "/api/teams/messages";
export const TEAMS_USAGE = "Usage: @Shiba <github-repo-url> <task>";

const COMMAND = /^\/?shiba(?=\s|$)/i;
const HELP = /^\/?(?:help|start)$/i;

const seenActivities = createSeenRing(1000);

/** Test hook: reset the dedupe ring between tests. */
export function clearSeenTeamsActivities(): void {
  seenActivities.clear();
}

export interface TeamsDeps {
  /** Outbound adapter; defaults to the Connector at the activity's serviceUrl. */
  adapter?: ChannelAdapter;
  /** Inbound transport; defaults to the Bot Framework JWT transport. */
  transport?: ChannelTransport;
  resolveOrchestrator?: ResolveOrchestrator;
  /** Durable check-and-record for activity ids. True = already seen. */
  dedupe?: (activityId: string) => Promise<boolean>;
}

function approvalCard(text: string, approvalId: string): Record<string, unknown> {
  return {
    contentType: "application/vnd.microsoft.card.adaptive",
    content: {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body: [{ type: "TextBlock", text, wrap: true }],
      actions: [
        { type: "Action.Submit", title: "Approve", data: { shiba: buildDecisionData(true, approvalId), card: text } },
        { type: "Action.Submit", title: "Reject", data: { shiba: buildDecisionData(false, approvalId), card: text } },
      ],
    },
  };
}

async function handleMessage(message: InboundMessage, env: Env, adapter: ChannelAdapter, deps: TeamsDeps): Promise<void> {
  const activity = message.raw as TeamsActivity;
  const botId = activity.recipient?.id;
  const addressed = message.isDirect || (botId !== undefined && message.mentionedUserIds.includes(botId));
  let text = stripTeamsMentions(message.text);
  if (COMMAND.test(text)) text = text.replace(COMMAND, "").trim();
  else if (!addressed) return;
  const reply = (body: string, native?: Record<string, unknown>) =>
    adapter.post({ placeId: message.placeId, replyToMessageId: message.messageId, text: body, ...(native ? { native } : {}) });
  if (!text || HELP.test(text)) {
    await reply(`${TEAMS_USAGE}\nNothing runs until someone on the approver list presses Approve.`);
    return;
  }
  const parsed = parseChatTaskRequest({
    text,
    conversationId: message.placeId,
    repoMap: env.TEAMS_CHANNEL_REPOS,
    mapName: "TEAMS_CHANNEL_REPOS",
    usage: TEAMS_USAGE,
  });
  if ("error" in parsed) {
    await reply(parsed.error);
    return;
  }
  const queued = await queueChatRun(env, {
    platform: "teams",
    threadKey: message.conversationKey,
    repoUrl: parsed.repoUrl,
    task: parsed.task,
    userId: message.authorId,
    harness: env.TEAMS_AGENT_HARNESS ?? env.AGENT_HARNESS,
  }, deps.resolveOrchestrator);
  if ("error" in queued) {
    await reply(`Failed to queue the task. ${queued.error}`);
    return;
  }
  const cardText = chatApprovalText({ ...parsed, approvalId: queued.approvalId, route: queued.route });
  await reply(cardText, { attachments: [approvalCard(cardText, queued.approvalId)] });
  // A task over the card limit posts in full right after the card so Approve never signs off on hidden text.
  for (const chunk of chatTaskChunks(parsed.task, CARD_TASK_LIMIT, 3900)) {
    await adapter.post({ placeId: message.placeId, text: chunk });
  }
}

async function handleAction(action: InboundAction, env: Env, adapter: ChannelAdapter, deps: TeamsDeps): Promise<void> {
  const say = (text: string) => adapter.post({ placeId: action.placeId, text });
  const decision = parseDecisionData(action.value);
  if (!decision || !action.conversationKey) {
    await say("This button is not a Shiba approval.");
    return;
  }
  // The JWT authenticates the Connector, not the human. Empty list = nobody.
  if (!isApprover(action.actorId, parseApproverAllowlist(env.TEAMS_APPROVERS))) {
    await say("You are not on the approver list.");
    return;
  }
  const result = await decideChatApproval(env, {
    platform: "teams",
    threadKey: action.conversationKey,
    approvalId: decision.approvalId,
    approved: decision.approved,
    decidedBy: `teams:${action.actorId}`,
  }, deps.resolveOrchestrator);
  if (!result.ok) {
    await say(result.error);
    return;
  }
  const { approved, requestedApproved } = result;
  const who = approved === requestedApproved ? action.actorName ?? action.actorId : "an earlier decision";
  if (!action.messageId) {
    await say(decisionLine(approved, who));
    return;
  }
  await adapter.edit({
    ref: { placeId: action.placeId, messageId: action.messageId },
    text: `${action.messageText ?? "Approval"}\n\n${decisionLine(approved, who)}`,
  }).catch((error: unknown) => {
    console.error("Teams approval card update failed", redactSecrets(String(error)));
  });
}

/**
 * Handle POST /api/teams/messages. Returns null for any other path or method
 * so the Worker can fall through to the remaining routes.
 */
export async function handleTeamsMessages(
  request: Request,
  env: Env,
  ctx?: ExecutionContextLike,
  deps: TeamsDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== TEAMS_MESSAGES_PATH || request.method !== "POST") return null;
  const transport = deps.transport ?? teamsTransport;
  const rawBody = await request.text();
  const verified = await transport.verify(rawBody, request.headers, env);
  if (!verified.ok) return Response.json({ error: verified.error }, { status: verified.status });
  const inbound = transport.parse(rawBody);
  if (!inbound?.deliveryId) return new Response("", { status: 200 });
  const key = inbound.deliveryId;
  if (seenActivities.has(key)) return new Response("", { status: 200 });
  if (deps.dedupe) {
    try {
      if (await deps.dedupe(key)) {
        seenActivities.add(key);
        return new Response("", { status: 200 });
      }
    } catch {
      // Dedupe backend down: ack anyway — a duplicate beats a lost activity.
    }
  }
  seenActivities.add(key);
  const serviceUrl = (inbound.raw as TeamsActivity).serviceUrl;
  const adapter = deps.adapter ?? teamsAdapterFromEnv(env, serviceUrl ? { serviceUrl } : {});
  if (!adapter) return new Response("", { status: 200 });
  const work = (inbound.kind === "action"
    ? handleAction(inbound, env, adapter, deps)
    : handleMessage(inbound, env, adapter, deps)
  ).catch((error: unknown) => {
    console.error("Teams activity failed", redactSecrets(String(error)));
  });
  if (ctx) ctx.waitUntil(work);
  else await work;
  return new Response("", { status: 200 });
}
