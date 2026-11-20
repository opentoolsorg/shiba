/**
 * Microsoft Teams bot lane.
 *
 * The Bot Connector posts activities to POST /api/teams/messages with a
 * signed bearer JWT (see channels/teams). A message `shiba <repo-url> <task>`
 * (the leading word is optional once the bot is @mentioned or in a personal
 * chat) queues a pending approval on a task-scoped orchestrator
 * and replies with an Adaptive Card in the original conversation. Its
 * Action.Submit data is a pointer: only TEAMS_APPROVERS ids may press it,
 * and the orchestrator honors it only while it is still pending.
 *
 * The Connector retries slow responses, so an authenticated activity is
 * acked at once and the work runs behind `ctx.waitUntil`, deduped on its id.
 */
import { buildDecisionData, parseDecisionData } from "@shiba/shared";
import { sha256Hex } from "./agent-tokens.js";
import {
  CARD_TASK_LIMIT,
  chatApprovalText,
  createSeenRing,
  decideChatApproval,
  decisionLine,
  parseChatTaskRequest,
  queueChatRun,
  type ResolveOrchestrator,
} from "./chat-lane.js";
import { isTeamsServiceUrl, parseTeamsActivity, stripTeamsMentions, teamsAdapterFromEnv, teamsTransport, type TeamsActivity } from "./channels/teams/index.js";
import { recordTeamsInstallation, reserveTeamsReply, saveTeamsApproval, saveTeamsCard, teamsActivityTenant, teamsApprovalThread, teamsGeneration, teamsReplyAddress, teamsSettings } from "./channels/teams/connection.js";
import type { ChannelAdapter, ChannelTransport, InboundAction, InboundMessage } from "./ports/channel/index.js";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";
import { isApprover, parseApproverAllowlist, type ExecutionContextLike } from "./slack-approval.js";

export const TEAMS_MESSAGES_PATH = "/api/teams/messages";
export const TEAMS_USAGE = "Usage: @Shiba <github-repo-url> <task>";

const COMMAND = /^\/?shiba(?=\s|$)/i;
const HELP = /^\/?(?:help|start)$/i;
const ACTIVITY_ID = /^[A-Za-z0-9@:_;=-][A-Za-z0-9@:_;=.\-]{0,255}$/;
const ACTIVITY_BODY_LIMIT = 128 * 1024;

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
      body: [{ type: "TextBlock", text: text.replace(/([\\`*_~\[\]])/g, "\\$1"), wrap: true }],
      actions: [
        { type: "Action.Submit", title: "Approve", data: { shiba: buildDecisionData(true, approvalId) } },
        { type: "Action.Submit", title: "Reject", data: { shiba: buildDecisionData(false, approvalId) } },
      ],
    },
  };
}

type ActivityContext = {
  env: Env;
  settings: NonNullable<ReturnType<typeof teamsSettings>>;
  generation: string;
  deliveryKey: string;
  adapter: ChannelAdapter;
  deps: TeamsDeps;
  activity: TeamsActivity & { id: string; serviceUrl: string; conversation: { id: string } };
  botId: string;
  recipientId: string;
};

async function handleMessage(message: InboundMessage, context: ActivityContext): Promise<void> {
  const { env, adapter, deps, settings, generation, deliveryKey, activity, botId, recipientId } = context;
  const addressed = message.isDirect || message.mentionedUserIds.includes(botId);
  if (!addressed) return;
  let text = stripTeamsMentions(message.text);
  if (COMMAND.test(text)) text = text.replace(COMMAND, "").trim();
  const address = teamsReplyAddress(message.placeId, settings.tenantId, botId, recipientId);
  const reply = (body: string, native?: Record<string, unknown>) =>
    adapter.post({ placeId: message.placeId, replyToMessageId: message.messageId, text: body, native: { ...address, ...native } });
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
  if (parsed.task.length > CARD_TASK_LIMIT) {
    await reply(`Shorten the task to ${CARD_TASK_LIMIT} characters so the approval card can show it in full.`);
    return;
  }
  const threadKey = `teams:task-${deliveryKey}`;
  if (!await reserveTeamsReply(env, settings, generation, threadKey, activity, botId, recipientId)) return;
  const queued = await queueChatRun(env, {
    platform: "teams",
    threadKey,
    repoUrl: parsed.repoUrl,
    task: parsed.task,
    userId: message.authorId,
    harness: env.TEAMS_AGENT_HARNESS ?? env.AGENT_HARNESS,
    publishPullRequest: false,
  }, deps.resolveOrchestrator);
  if ("error" in queued) {
    await reply(`Failed to queue the task. ${queued.error}`);
    return;
  }
  await saveTeamsApproval(env, threadKey, queued.approvalId);
  if (await teamsGeneration(env, settings) !== generation) return;
  const cardText = chatApprovalText({ ...parsed, approvalId: queued.approvalId, route: queued.route });
  const card = await reply("", { attachments: [approvalCard(cardText, queued.approvalId)] });
  if (ACTIVITY_ID.test(card.messageId)) await saveTeamsCard(env, threadKey, card.messageId);
}

async function handleAction(action: InboundAction, context: ActivityContext): Promise<void> {
  const { env, adapter, deps, settings, generation, activity, botId, recipientId } = context;
  const native = teamsReplyAddress(action.placeId, settings.tenantId, botId, recipientId);
  const say = (text: string) => adapter.post({ placeId: action.placeId, replyToMessageId: activity.id, text, native });
  const decision = parseDecisionData(action.value);
  if (!decision || !action.conversationKey) {
    await say("This button is not a Shiba approval.");
    return;
  }
  // The JWT authenticates the Connector, not the human. Empty list = nobody.
  if (typeof activity.from?.aadObjectId !== "string" || !isApprover(activity.from.aadObjectId, parseApproverAllowlist(env.TEAMS_APPROVERS))) {
    await say("You are not on the approver list.");
    return;
  }
  const target = await teamsApprovalThread(env, generation, action.placeId, decision.approvalId);
  if (!target || await teamsGeneration(env, settings) !== generation) {
    await say("This approval isn't available in this conversation or connection.");
    return;
  }
  const result = await decideChatApproval(env, {
    platform: "teams",
    threadKey: target.thread_key,
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
  if (!target.card_activity_id) {
    await say(decisionLine(approved, who));
    return;
  }
  await adapter.edit({
    ref: { placeId: action.placeId, messageId: target.card_activity_id },
    text: `Approval ${decision.approvalId}\n\n${decisionLine(approved, who)}`,
    native,
  }).catch(async (error: unknown) => {
    console.error("Teams approval card update failed", redactSecrets(String(error)));
    await say(decisionLine(approved, who));
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
  let bytes = 0;
  const limited = request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > ACTIVITY_BODY_LIMIT) controller.error(new Error("Teams activity too large."));
      else controller.enqueue(chunk);
    },
  }));
  const rawBody = await new Response(limited).text().catch(() => null);
  if (rawBody === null) return Response.json({ error: "Teams activity body could not be read within its size limit." }, { status: 413 });
  const verified = await transport.verify(rawBody, request.headers, env);
  if (!verified.ok) return Response.json({ error: verified.error }, { status: verified.status });
  const settings = teamsSettings(env);
  if (!settings) return Response.json({ error: "Teams workspace connection is not configured." }, { status: 503 });
  const activity = parseTeamsActivity(rawBody);
  if (!activity || teamsActivityTenant(activity) !== settings.tenantId) return Response.json({ error: "Teams tenant is not connected." }, { status: 403 });
  if (activity.type === "installationUpdate") {
    await recordTeamsInstallation(env, settings, activity);
    return new Response("", { status: 200 });
  }
  const inbound = transport.parse(rawBody);
  const botId = activity.recipient?.id;
  const recipientId = activity.from?.id;
  if (!inbound?.conversationKey || !ACTIVITY_ID.test(inbound.placeId) || typeof inbound.deliveryId !== "string" || !ACTIVITY_ID.test(inbound.deliveryId) ||
    !isTeamsServiceUrl(activity.serviceUrl) || typeof botId !== "string" || typeof recipientId !== "string" ||
    !ACTIVITY_ID.test(botId) || !ACTIVITY_ID.test(recipientId) || botId === recipientId) return new Response("", { status: 200 });
  const generation = await teamsGeneration(env, settings);
  if (!generation) return new Response("", { status: 200 });
  const key = await sha256Hex(JSON.stringify([settings.tenantId, settings.appId.toLowerCase(), inbound.placeId, inbound.deliveryId]));
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
  const adapter = deps.adapter ?? teamsAdapterFromEnv(env, { serviceUrl: activity.serviceUrl });
  if (!adapter) return new Response("", { status: 200 });
  const context = {
    env, settings, generation, deliveryKey: key, adapter, deps, botId, recipientId,
    activity: { ...activity, id: inbound.deliveryId, serviceUrl: activity.serviceUrl, conversation: { id: inbound.placeId } },
  };
  const work = (inbound.kind === "action"
    ? handleAction(inbound, context)
    : handleMessage(inbound, context)
  ).catch((error: unknown) => {
    console.error("Teams activity failed", redactSecrets(String(error)));
  });
  if (ctx) ctx.waitUntil(work);
  else await work;
  return new Response("", { status: 200 });
}
