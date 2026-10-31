/**
 * Microsoft Teams lane (Bot Framework activities).
 *
 * Azure Bot Service posts signed JWT-authenticated activities to
 * POST /api/teams/webhook. A @mention or DM with `/shiba <repo> <task>` (or
 * freeform text after a mention) queues a pending approval on the
 * conversation orchestrator (`teams:{conversationId}`). Adaptive Card
 * Action.Submit buttons carry approve/reject pointers; only TEAMS_APPROVERS
 * may invoke them, and the orchestrator honors a pointer only while pending.
 */
import { buildChatThreadName, buildDecisionData, parseDecisionData } from "@shiba/shared";
import { seenDelivery } from "./automations-stub.js";
import {
  chatApprovalText,
  chatTaskChunks,
  decideChatApproval,
  decisionLine,
  parseChatTaskRequest,
  queueChatRun,
  type ResolveOrchestrator,
} from "./chat-lane.js";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";
import { isApprover, parseApproverAllowlist, type ExecutionContextLike } from "./slack-approval.js";
import { getBotFrameworkConnectorToken, verifyTeamsBearerToken } from "./teams-auth.js";

export const TEAMS_WEBHOOK_PATH = "/api/teams/webhook";
export const TEAMS_USAGE = "Usage: /shiba <github-repo-url> <task> — or @mention the bot with a repo URL and task.";
export const TEAMS_ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";

const COMMAND = /^\/shiba(?=\s|$)/i;
const HELP = /^\/(?:help|shiba\s+help)(?=\s|$)|^help$/i;

interface TeamsEntity {
  type?: string;
  text?: string;
  mentioned?: { id?: string };
}

interface TeamsConversation {
  id?: string;
  conversationType?: string;
  tenantId?: string;
}

interface TeamsActivity {
  type?: string;
  id?: string;
  serviceUrl?: string;
  channelId?: string;
  text?: string;
  replyToId?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  conversation?: TeamsConversation;
  entities?: TeamsEntity[];
  name?: string;
  value?: Record<string, unknown>;
  attachments?: Array<{ contentType?: string; content?: unknown }>;
}

export interface TeamsDeps {
  resolveOrchestrator?: ResolveOrchestrator;
  dedupe?: (activityId: string) => Promise<boolean>;
  verifyAuth?: typeof verifyTeamsBearerToken;
  connectorToken?: () => Promise<string>;
  sendActivity?: (input: {
    serviceUrl: string;
    conversationId: string;
    activity: Record<string, unknown>;
  }) => Promise<void>;
  updateActivity?: (input: {
    serviceUrl: string;
    conversationId: string;
    activityId: string;
    activity: Record<string, unknown>;
  }) => Promise<void>;
}

function normalizeServiceUrl(serviceUrl: string): string {
  return serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`;
}

function stripMentions(activity: TeamsActivity): string {
  let text = activity.text?.trim() ?? "";
  for (const entity of activity.entities ?? []) {
    if (entity.type === "mention" && typeof entity.text === "string") {
      text = text.replace(entity.text, " ");
    }
  }
  return text.replace(/\s+/g, " ").trim();
}

function isBotMentioned(activity: TeamsActivity): boolean {
  const botId = activity.recipient?.id ?? "";
  if (!botId) return false;
  return (activity.entities ?? []).some((entity) => entity.type === "mention" && entity.mentioned?.id === botId);
}

function isPersonalChat(activity: TeamsActivity): boolean {
  return activity.conversation?.conversationType === "personal";
}

function teamsUserId(activity: TeamsActivity): string {
  return activity.from?.aadObjectId?.trim() || activity.from?.id?.trim() || "";
}

function displayName(activity: TeamsActivity): string {
  return activity.from?.name?.trim() || teamsUserId(activity) || "unknown";
}

function adaptiveCardAttachment(body: Record<string, unknown>[], actions: Record<string, unknown>[]) {
  return {
    contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
    content: {
      type: "AdaptiveCard",
      $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
      version: "1.4",
      body,
      actions,
    },
  };
}

function approvalCardAttachment(parsed: { repoUrl: string; task: string }, approvalId: string, route?: string) {
  const cardText = chatApprovalText({ ...parsed, approvalId, route });
  return adaptiveCardAttachment(
    [{ type: "TextBlock", text: cardText, wrap: true }],
    [
      { type: "Action.Submit", title: "Approve", data: { shiba: buildDecisionData(true, approvalId) } },
      { type: "Action.Submit", title: "Reject", data: { shiba: buildDecisionData(false, approvalId) } },
    ],
  );
}

function decisionFromInvokeValue(value: Record<string, unknown> | undefined): ReturnType<typeof parseDecisionData> {
  if (!value) return null;
  const action = value.action;
  if (typeof action !== "object" || action === null) return null;
  const data = (action as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return null;
  const shiba = (data as { shiba?: unknown }).shiba;
  return typeof shiba === "string" ? parseDecisionData(shiba) : null;
}

async function defaultSendActivity(
  env: Env,
  input: { serviceUrl: string; conversationId: string; activity: Record<string, unknown> },
  tokenFn: () => Promise<string>,
): Promise<void> {
  const token = await tokenFn();
  const base = normalizeServiceUrl(input.serviceUrl);
  let response: Response;
  try {
    response = await fetch(`${base}v3/conversations/${encodeURIComponent(input.conversationId)}/activities`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.activity),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("Teams send activity request failed.");
  }
  if (!response.ok) {
    throw new Error(`Teams send activity failed (${response.status}).`);
  }
}

async function defaultUpdateActivity(
  env: Env,
  input: { serviceUrl: string; conversationId: string; activityId: string; activity: Record<string, unknown> },
  tokenFn: () => Promise<string>,
): Promise<void> {
  const token = await tokenFn();
  const base = normalizeServiceUrl(input.serviceUrl);
  let response: Response;
  try {
    response = await fetch(
      `${base}v3/conversations/${encodeURIComponent(input.conversationId)}/activities/${encodeURIComponent(input.activityId)}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input.activity),
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch {
    throw new Error("Teams update activity request failed.");
  }
  if (!response.ok) {
    throw new Error(`Teams update activity failed (${response.status}).`);
  }
}

async function handleMessage(
  activity: TeamsActivity,
  env: Env,
  threadKey: string,
  conversationId: string,
  deps: TeamsDeps,
  send: NonNullable<TeamsDeps["sendActivity"]>,
): Promise<void> {
  if (activity.from?.id === activity.recipient?.id) return;
  const text = stripMentions(activity);
  if (HELP.test(text)) {
    await send({
      serviceUrl: activity.serviceUrl ?? "",
      conversationId,
      activity: { type: "message", text: `${TEAMS_USAGE}\nNothing runs until someone on the approver list presses Approve.` },
    });
    return;
  }
  const isTask = COMMAND.test(text) || (!COMMAND.test(text) && (isPersonalChat(activity) || isBotMentioned(activity)));
  if (!isTask) return;
  const taskText = COMMAND.test(text) ? text.replace(COMMAND, "").trim() : text;
  if (!taskText && !COMMAND.test(text)) return;
  const parsed = parseChatTaskRequest({
    text: taskText,
    conversationId,
    repoMap: env.TEAMS_CONVERSATION_REPOS,
    mapName: "TEAMS_CONVERSATION_REPOS",
    usage: TEAMS_USAGE,
  });
  if ("error" in parsed) {
    await send({
      serviceUrl: activity.serviceUrl ?? "",
      conversationId,
      activity: { type: "message", text: parsed.error },
    });
    return;
  }
  const queued = await queueChatRun(env, {
    platform: "teams",
    threadKey,
    repoUrl: parsed.repoUrl,
    task: parsed.task,
    userId: teamsUserId(activity),
    harness: env.TEAMS_AGENT_HARNESS ?? env.AGENT_HARNESS,
  }, deps.resolveOrchestrator);
  if ("error" in queued) {
    await send({
      serviceUrl: activity.serviceUrl ?? "",
      conversationId,
      activity: { type: "message", text: `Failed to queue the task. ${queued.error}` },
    });
    return;
  }
  await send({
    serviceUrl: activity.serviceUrl ?? "",
    conversationId,
    activity: {
      type: "message",
      attachments: [approvalCardAttachment(parsed, queued.approvalId, queued.route)],
    },
  });
  for (const chunk of chatTaskChunks(parsed.task, 3500)) {
    await send({
      serviceUrl: activity.serviceUrl ?? "",
      conversationId,
      activity: { type: "message", text: chunk },
    });
  }
}

async function handleInvoke(
  activity: TeamsActivity,
  env: Env,
  threadKey: string,
  conversationId: string,
  deps: TeamsDeps,
  send: TeamsDeps["sendActivity"],
  update: TeamsDeps["updateActivity"],
): Promise<Record<string, unknown>> {
  if (activity.name !== "adaptiveCard/action") {
    return { statusCode: 400, type: "application/vnd.microsoft.error", value: { code: "BadRequest", message: "Unsupported invoke." } };
  }
  const decision = decisionFromInvokeValue(activity.value);
  if (!decision) {
    return { statusCode: 400, type: "application/vnd.microsoft.error", value: { code: "BadRequest", message: "This card is not a Shiba approval." } };
  }
  const userId = teamsUserId(activity);
  if (!isApprover(userId, parseApproverAllowlist(env.TEAMS_APPROVERS))) {
    return {
      statusCode: 200,
      type: "application/vnd.microsoft.activity.message",
      value: "You are not on the approver list.",
    };
  }
  const result = await decideChatApproval(env, {
    platform: "teams",
    threadKey,
    approvalId: decision.approvalId,
    approved: decision.approved,
    decidedBy: `teams:${userId}`,
  }, deps.resolveOrchestrator);
  if (!result.ok) {
    return { statusCode: 200, type: "application/vnd.microsoft.activity.message", value: result.error };
  }
  const cardMessageId =
    (typeof activity.value?.messageId === "string" ? activity.value.messageId : null) ??
    activity.replyToId ??
    "";
  const priorText =
    typeof activity.value?.messagePayload === "object" && activity.value.messagePayload !== null
      ? String((activity.value.messagePayload as { text?: unknown }).text ?? "Approval")
      : "Approval";
  const updatedText = `${priorText}\n\n${decisionLine(decision.approved, displayName(activity))}`;
  if (update && cardMessageId) {
    await update({
      serviceUrl: activity.serviceUrl ?? "",
      conversationId,
      activityId: cardMessageId,
      activity: {
        type: "message",
        id: cardMessageId,
        attachments: [
          adaptiveCardAttachment([{ type: "TextBlock", text: updatedText, wrap: true }], []),
        ],
      },
    }).catch((error: unknown) => {
      console.error("Teams approval card update failed", redactSecrets(String(error)));
    });
  } else if (send) {
    await send({
      serviceUrl: activity.serviceUrl ?? "",
      conversationId,
      activity: { type: "message", text: updatedText },
    });
  }
  return {
    statusCode: 200,
    type: "application/vnd.microsoft.activity.message",
    value: decision.approved ? "Approved — run starting." : "Rejected — no run started.",
  };
}

/**
 * Handle POST /api/teams/webhook. Returns null for any other path or method.
 */
export async function handleTeamsWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContextLike,
  deps: TeamsDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== TEAMS_WEBHOOK_PATH || request.method !== "POST") {
    return null;
  }
  const appId = env.TEAMS_MICROSOFT_APP_ID?.trim() ?? "";
  const appPassword = env.TEAMS_MICROSOFT_APP_PASSWORD?.trim() ?? "";
  if (!appId || !appPassword) {
    return Response.json(
      { error: "Teams is not configured: set TEAMS_MICROSOFT_APP_ID and TEAMS_MICROSOFT_APP_PASSWORD." },
      { status: 503 },
    );
  }
  const rawBody = await request.text();
  let activity: TeamsActivity;
  try {
    activity = JSON.parse(rawBody) as TeamsActivity;
  } catch {
    return Response.json({ error: "Teams activity is not valid JSON." }, { status: 400 });
  }
  const serviceUrl = activity.serviceUrl?.trim() ?? "";
  if (!serviceUrl) {
    return Response.json({ error: "Teams activity is missing serviceUrl." }, { status: 400 });
  }
  const verifyAuth = deps.verifyAuth ?? verifyTeamsBearerToken;
  if (!(await verifyAuth({ authorization: request.headers.get("Authorization"), appId, serviceUrl }))) {
    return Response.json({ error: "Invalid Teams authorization." }, { status: 401 });
  }
  const conversationId = activity.conversation?.id?.trim() ?? "";
  if (!conversationId) {
    return Response.json({ error: "Teams activity is missing conversation.id." }, { status: 400 });
  }
  let threadKey: string;
  try {
    threadKey = buildChatThreadName("teams", conversationId);
  } catch {
    return Response.json({ error: "Teams conversation id is malformed." }, { status: 400 });
  }
  const activityId = activity.id ?? "";
  if (activityId !== "") {
    const already = deps.dedupe
      ? await deps.dedupe(activityId).catch(() => false)
      : await seenDelivery(env, `teams-activity:${activityId}`).catch(() => false);
    if (already) {
      return new Response("", { status: 200 });
    }
  }
  const tokenFn = deps.connectorToken ?? (() => getBotFrameworkConnectorToken(appId, appPassword));
  const send =
    deps.sendActivity ??
    ((input) => defaultSendActivity(env, input, tokenFn));
  const update =
    deps.updateActivity ??
    ((input) => defaultUpdateActivity(env, input, tokenFn));

  const run = async (): Promise<Response | void> => {
    if (activity.type === "invoke") {
      const body = await handleInvoke(activity, env, threadKey, conversationId, deps, send, update);
      return Response.json(body, { status: 200 });
    }
    if (activity.type === "message") {
      await handleMessage(activity, env, threadKey, conversationId, deps, send);
      return;
    }
  };

  const work = run().catch((error: unknown) => {
    console.error("Teams activity failed", redactSecrets(String(error)));
  });
  if (activity.type === "invoke") {
    if (ctx) {
      const response = await work;
      return response instanceof Response ? response : new Response("", { status: 200 });
    }
    const response = await work;
    return response instanceof Response ? response : new Response("", { status: 200 });
  }
  if (ctx) {
    ctx.waitUntil(work);
    return new Response("", { status: 200 });
  }
  await work;
  return new Response("", { status: 200 });
}

/** Bot Connector post for orchestrator post-backs (same token path as inbound replies). */
export async function teamsConnectorPostMessage(
  env: Env,
  input: { conversationId: string; serviceUrl: string; text: string },
): Promise<void> {
  const appId = env.TEAMS_MICROSOFT_APP_ID?.trim() ?? "";
  const appPassword = env.TEAMS_MICROSOFT_APP_PASSWORD?.trim() ?? "";
  if (!appId || !appPassword) return;
  const token = await getBotFrameworkConnectorToken(appId, appPassword);
  await defaultSendActivity(
    env,
    {
      serviceUrl: input.serviceUrl,
      conversationId: input.conversationId,
      activity: { type: "message", text: input.text.slice(0, 4000) },
    },
    async () => token,
  );
}
