/**
 * Discord interactions lane.
 *
 * Discord signs every interaction with Ed25519 over `timestamp + body`
 * (X-Signature-Ed25519 / X-Signature-Timestamp) and disables an endpoint that
 * accepts a bad signature, so verification runs before any parsing
 * (https://discord.com/developers/docs/interactions/overview#setting-up-an-endpoint).
 *
 * `/shiba task:<task> repo:<url>` and the "Run with Shiba" message command
 * defer inside Discord's 3s window, queue a pending approval on the channel's
 * orchestrator (`discord:{channelId}`), and edit the deferred reply into a
 * card with Approve/Reject buttons. With the install flow configured, only
 * servers with an active installation are answered. A button
 * custom_id is a pointer: only DISCORD_APPROVERS may press it, and the
 * orchestrator honors it only while the approval is still pending.
 */
import { buildChatThreadName, parseDecisionData, parseEmployeeDecisionData } from "@shiba/shared";
import { seenDelivery } from "./automations-stub.js";
import { decisionButtons, DISCORD_INTERACTION, discordTransport } from "./channels/discord/index.js";
import {
  CARD_TASK_LIMIT,
  chatApprovalText,
  chatTaskChunks,
  decideChatApproval,
  decisionLine,
  discordApi,
  NO_MENTIONS,
  parseChatTaskRequest,
  queueChatRun,
  type ResolveOrchestrator,
} from "./chat-lane.js";
import {
  chatEmployeeQueueExtras,
  decideChatEmployeeToolApproval,
  resolveChatEmployeeFromText,
  resolveChatEmployeeOrgId,
} from "./chat-employee.js";
import type { Env } from "./env.js";
import { checkDiscordGuildAccess, DISCORD_COMMAND_NAME, DISCORD_MESSAGE_COMMAND_NAME } from "./discord-installations.js";
import { tryAnswerUiBlockFallback } from "./ui-block-fallback.js";
import { redactSecrets } from "./security.js";
import { isApprover, parseApproverAllowlist, type ExecutionContextLike } from "./slack-approval.js";
import { log } from "./obs/log.js";

export { decisionButtons, DISCORD_REPLAY_WINDOW_SECONDS, postDiscordPublicationApproval, verifyDiscordRequest } from "./channels/discord/index.js";

export const DISCORD_INTERACTIONS_PATH = "/api/discord/interactions";
export const DISCORD_COMMAND = DISCORD_COMMAND_NAME;
export const DISCORD_MESSAGE_COMMAND = DISCORD_MESSAGE_COMMAND_NAME;
export const DISCORD_USAGE = "Usage: /shiba task:<task> repo:<github-repo-url>";
const { PING, APPLICATION_COMMAND, MESSAGE_COMPONENT } = DISCORD_INTERACTION;
const EPHEMERAL = 64;

interface DiscordInteraction {
  id?: string;
  type?: number;
  application_id?: string;
  token?: string;
  channel_id?: string;
  guild_id?: string;
  data?: {
    name?: string;
    type?: number;
    target_id?: string;
    resolved?: { messages?: Record<string, { content?: string }> };
  };
}

const MESSAGE_COMMAND_TYPE = 3;
type QueueBody = Parameters<typeof queueChatRun>[1];

/** Remove user, role and channel mention tokens so they never become task text. */
export function stripDiscordMentions(text: string): string {
  return text.replace(/<(?:@[!&]?|#)\d{1,24}>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Turn a Discord request (slash command, message command or bot mention)
 * into the frozen run input an approver will see. The repo comes from the
 * text, the explicit option, or DISCORD_CHANNEL_REPOS.
 */
export async function prepareDiscordTask(
  env: Env,
  input: { threadKey: string; userId: string; text: string; repo?: string },
): Promise<{ queueBody: QueueBody } | { error: string }> {
  const channelId = input.threadKey.slice("discord:".length);
  const parsed = parseChatTaskRequest({
    text: `${input.repo ?? ""} ${input.text}`,
    conversationId: channelId,
    repoMap: env.DISCORD_CHANNEL_REPOS,
    mapName: "DISCORD_CHANNEL_REPOS",
    usage: DISCORD_USAGE,
  });
  const employeeResolution = await resolveChatEmployeeFromText(env, input.text);
  if (employeeResolution.kind === "error") return { error: employeeResolution.error };
  if (employeeResolution.kind === "ok") {
    const extras = await chatEmployeeQueueExtras(
      env,
      employeeResolution.agent,
      employeeResolution.orgId,
      employeeResolution.taskText,
      "error" in parsed ? null : parsed.repoUrl,
    );
    if (!extras.ok) {
      return { error: extras.error || ("error" in parsed ? parsed.error : "No repository: include a repo URL or map this channel.") };
    }
    return {
      queueBody: {
        platform: "discord",
        threadKey: input.threadKey,
        repoUrl: extras.extras.repoUrl ?? "",
        task: extras.task,
        userId: input.userId,
        harness: extras.extras.harness ?? env.DISCORD_AGENT_HARNESS ?? env.AGENT_HARNESS,
        orgId: extras.extras.orgId,
        customAgentId: extras.extras.customAgentId,
        customAgentVersion: extras.extras.customAgentVersion,
        ...(extras.extras.employeeToolPolicyVersion !== undefined
          ? { employeeToolPolicyVersion: extras.extras.employeeToolPolicyVersion }
          : {}),
        ...(extras.extras.executionTarget ? { executionTarget: extras.extras.executionTarget } : {}),
        publishPullRequest: extras.extras.publishPullRequest,
        employeeLabel: extras.extras.employeeLabel,
      },
    };
  }
  if ("error" in parsed) return { error: parsed.error };
  return {
    queueBody: {
      platform: "discord",
      threadKey: input.threadKey,
      repoUrl: parsed.repoUrl,
      task: parsed.task,
      userId: input.userId,
      harness: env.DISCORD_AGENT_HARNESS ?? env.AGENT_HARNESS,
      publishPullRequest: true,
    },
  };
}

/** The approval card body and its Approve/Reject buttons. */
export function discordApprovalCard(queueBody: QueueBody, queued: { approvalId: string; route?: string }) {
  return {
    content: chatApprovalText({
      repoUrl: queueBody.repoUrl,
      task: queueBody.task,
      approvalId: queued.approvalId,
      route: queued.route,
      employeeLabel: queueBody.employeeLabel,
      publishPullRequest: queueBody.publishPullRequest,
    }),
    components: decisionButtons(queued.approvalId),
    allowed_mentions: NO_MENTIONS,
  };
}

export function discordTaskFollowUps(task: string): string[] {
  return chatTaskChunks(task, CARD_TASK_LIMIT, 1900);
}

export interface DiscordDeps {
  /** Interaction webhook call (edit the reply, post a follow-up); defaults to discord.com. */
  send?: (method: "PATCH" | "POST", path: string, body: Record<string, unknown>) => Promise<void>;
  /** Resolve the channel's orchestrator; defaults to the Agents SDK router. */
  resolveOrchestrator?: ResolveOrchestrator;
}

function ephemeral(content: string): Response {
  return Response.json({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: NO_MENTIONS } });
}

/**
 * Handle POST /api/discord/interactions. Returns null for any other path or
 * method so the Worker can fall through to the remaining routes.
 */
export async function handleDiscordInteractions(
  request: Request,
  env: Env,
  ctx?: ExecutionContextLike,
  deps: DiscordDeps = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== DISCORD_INTERACTIONS_PATH || request.method !== "POST") {
    return null;
  }
  // The raw body is the exact signed payload — parse the JSON after verifying.
  const rawBody = await request.text();
  const verified = await discordTransport.verify(rawBody, request.headers, env);
  if (!verified.ok) {
    return Response.json({ error: verified.error }, { status: verified.status });
  }
  let interaction: DiscordInteraction;
  try {
    interaction = JSON.parse(rawBody) as DiscordInteraction;
  } catch {
    return Response.json({ error: "Discord interaction is not valid JSON." }, { status: 400 });
  }
  if (interaction.type === PING) {
    return Response.json({ type: 1 });
  }
  const access = await checkDiscordGuildAccess(env, interaction.guild_id);
  if (!access.ok) {
    return ephemeral(access.message);
  }
  const inbound = discordTransport.parse(rawBody);
  // Discord retries interactions inside the signature window; dedupe on the
  // server-assigned interaction id so a replayed signed payload cannot queue
  // a second run. Dedupe failures fail open (a duplicate is recoverable, a
  // dropped command is not) — the signature still gates unauthenticated calls.
  const interactionId = interaction.id ?? "";
  if (interactionId !== "") {
    const already = await seenDelivery(env, `discord-interaction:${interactionId}`).catch(() => false);
    if (already) {
      return ephemeral("Already processed.");
    }
  }
  const applicationId = interaction.application_id ?? "";
  const token = interaction.token ?? "";
  const userId = inbound?.kind === "action" ? inbound.actorId : inbound?.authorId ?? "";
  let threadKey: string;
  try {
    threadKey = buildChatThreadName("discord", interaction.channel_id ?? "");
  } catch {
    return ephemeral("Shiba can only be used from a channel.");
  }
  if (!/^\d+$/.test(applicationId) || !token) {
    return ephemeral("Malformed interaction.");
  }
  const webhook = `/webhooks/${applicationId}/${token}`;
  const send = deps.send ??
    ((method: "PATCH" | "POST", path: string, body: Record<string, unknown>) =>
      discordApi("interaction reply", path, { method, body }));
  const schedule = async (work: () => Promise<void>) => {
    // The deferred response already went out; failures can only be logged.
    const promise = work().catch((error: unknown) => {
      log.error("Discord interaction failed", redactSecrets(String(error)));
    });
    if (ctx) {
      ctx.waitUntil(promise);
    } else {
      await promise;
    }
  };

  if (interaction.type === APPLICATION_COMMAND) {
    const isMessageCommand = interaction.data?.type === MESSAGE_COMMAND_TYPE;
    if (interaction.data?.name !== (isMessageCommand ? DISCORD_MESSAGE_COMMAND : DISCORD_COMMAND)) {
      return ephemeral("Unknown command.");
    }
    const options = inbound?.kind === "message" ? inbound.command?.options ?? {} : {};
    const option = (name: string) => options[name] ?? "";
    let text: string;
    if (isMessageCommand) {
      const target = interaction.data?.target_id ?? "";
      text = stripDiscordMentions(interaction.data?.resolved?.messages?.[target]?.content ?? "");
      if (!text) return ephemeral("That message has no text Shiba can use as a task.");
    } else {
      text = option("task");
      if (await tryAnswerUiBlockFallback(env, threadKey, userId, text)) return ephemeral("Answer recorded.");
    }
    const prepared = await prepareDiscordTask(env, {
      threadKey,
      userId,
      text,
      ...(isMessageCommand ? {} : { repo: option("repo") }),
    });
    if ("error" in prepared) {
      return ephemeral(prepared.error);
    }
    const queueBody = prepared.queueBody;
    await schedule(async () => {
      const queued = await queueChatRun(env, queueBody, deps.resolveOrchestrator);
      if ("error" in queued) {
        await send("PATCH", `${webhook}/messages/@original`, {
          content: `Failed to queue the task. ${queued.error}`,
          allowed_mentions: NO_MENTIONS,
        });
        return;
      }
      await send("PATCH", `${webhook}/messages/@original`, discordApprovalCard(queueBody, queued));
      for (const chunk of discordTaskFollowUps(queueBody.task)) {
        await send("POST", webhook, { content: chunk, allowed_mentions: NO_MENTIONS });
      }
    });
    return Response.json({ type: 5 });
  }

  if (interaction.type === MESSAGE_COMPONENT) {
    const employeeDecision = parseEmployeeDecisionData(inbound?.kind === "action" ? inbound.value : "");
    if (employeeDecision) {
      if (!isApprover(userId, parseApproverAllowlist(env.DISCORD_APPROVERS))) {
        return ephemeral("You are not on the approver list.");
      }
      await schedule(async () => {
        const result = await decideChatEmployeeToolApproval(env, {
          orgId: resolveChatEmployeeOrgId(env),
          threadKey,
          approvalId: employeeDecision.approvalId,
          approved: employeeDecision.approved,
          decidedBy: `discord:${userId}`,
        });
        if (!result.ok) {
          await send("POST", webhook, { content: result.error, flags: EPHEMERAL, allowed_mentions: NO_MENTIONS });
          return;
        }
        await send("PATCH", `${webhook}/messages/@original`, {
          content: `${(inbound?.kind === "action" ? inbound.messageText : undefined) ?? "Employee approval"}\n\n${decisionLine(employeeDecision.approved, `<@${userId}>`)}`,
          components: [],
          allowed_mentions: NO_MENTIONS,
        });
      });
      return Response.json({ type: 6 });
    }
    const decision = parseDecisionData(inbound?.kind === "action" ? inbound.value : "");
    if (!decision) {
      return ephemeral("This button is not a Shiba approval.");
    }
    // The signature authenticates Discord, not the human. Empty list = nobody.
    if (!isApprover(userId, parseApproverAllowlist(env.DISCORD_APPROVERS))) {
      return ephemeral("You are not on the approver list.");
    }
    await schedule(async () => {
      const result = await decideChatApproval(env, {
        platform: "discord",
        threadKey,
        approvalId: decision.approvalId,
        approved: decision.approved,
        decidedBy: `discord:${userId}`,
      }, deps.resolveOrchestrator);
      if (!result.ok) {
        await send("POST", webhook, { content: result.error, flags: EPHEMERAL, allowed_mentions: NO_MENTIONS });
        return;
      }
      // Empty components retire the buttons so the card can't be pressed again.
      await send("PATCH", `${webhook}/messages/@original`, {
        content: `${(inbound?.kind === "action" ? inbound.messageText : undefined) ?? "Approval"}\n\n${decisionLine(result.approved, result.approved === decision.approved ? `<@${userId}>` : "an earlier decision")}`,
        components: [],
        allowed_mentions: NO_MENTIONS,
      });
    });
    return Response.json({ type: 6 });
  }

  return ephemeral("Unsupported interaction.");
}
