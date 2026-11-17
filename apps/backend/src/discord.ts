/**
 * Discord interactions lane.
 *
 * Discord signs every interaction with Ed25519 over `timestamp + body`
 * (X-Signature-Ed25519 / X-Signature-Timestamp) and disables an endpoint that
 * accepts a bad signature, so verification runs before any parsing
 * (https://discord.com/developers/docs/interactions/overview#setting-up-an-endpoint).
 *
 * `/shiba task:<task> repo:<url>` defers inside Discord's 3s window, queues a
 * pending approval on the channel's orchestrator (`discord:{channelId}`), and
 * edits the deferred reply into a card with Approve/Reject buttons. A button
 * custom_id is a pointer: only DISCORD_APPROVERS may press it, and the
 * orchestrator honors it only while the approval is still pending.
 */
import { buildChatThreadName, buildDecisionData, parseDecisionData, parseEmployeeDecisionData } from "@shiba/shared";
import { seenDelivery } from "./automations-stub.js";
import { DISCORD_INTERACTION, discordTransport } from "./channels/discord/index.js";
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
import { redactSecrets } from "./security.js";
import { isApprover, parseApproverAllowlist, type ExecutionContextLike } from "./slack-approval.js";

export { DISCORD_REPLAY_WINDOW_SECONDS, verifyDiscordRequest } from "./channels/discord/index.js";

export const DISCORD_INTERACTIONS_PATH = "/api/discord/interactions";
export const DISCORD_COMMAND = "shiba";
export const DISCORD_USAGE = "Usage: /shiba task:<task> repo:<github-repo-url>";
const { PING, APPLICATION_COMMAND, MESSAGE_COMPONENT } = DISCORD_INTERACTION;
const EPHEMERAL = 64;

interface DiscordInteraction {
  id?: string;
  type?: number;
  application_id?: string;
  token?: string;
  channel_id?: string;
  data?: { name?: string };
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

function decisionButtons(approvalId: string): unknown[] {
  return [{
    type: 1,
    components: [
      { type: 2, style: 3, label: "Approve", custom_id: buildDecisionData(true, approvalId) },
      { type: 2, style: 4, label: "Reject", custom_id: buildDecisionData(false, approvalId) },
    ],
  }];
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
      console.error("Discord interaction failed", redactSecrets(String(error)));
    });
    if (ctx) {
      ctx.waitUntil(promise);
    } else {
      await promise;
    }
  };

  if (interaction.type === APPLICATION_COMMAND) {
    if (interaction.data?.name !== DISCORD_COMMAND) {
      return ephemeral("Unknown command.");
    }
    const options = inbound?.kind === "message" ? inbound.command?.options ?? {} : {};
    const option = (name: string) => options[name] ?? "";
    const channelId = threadKey.slice("discord:".length);
    const parsed = parseChatTaskRequest({
      text: `${option("repo")} ${option("task")}`,
      conversationId: channelId,
      repoMap: env.DISCORD_CHANNEL_REPOS,
      mapName: "DISCORD_CHANNEL_REPOS",
      usage: DISCORD_USAGE,
    });
    const taskOption = option("task");
    const employeeResolution = await resolveChatEmployeeFromText(env, taskOption);
    if (employeeResolution.kind === "error") {
      return ephemeral(employeeResolution.error);
    }
    let queueBody: Parameters<typeof queueChatRun>[1] | null = null;
    if (employeeResolution.kind === "ok") {
      const repoFromCommand = "error" in parsed ? null : parsed.repoUrl;
      const extras = await chatEmployeeQueueExtras(
        env,
        employeeResolution.agent,
        employeeResolution.orgId,
        employeeResolution.taskText,
        repoFromCommand,
      );
      if (!extras.ok) {
        const repoError = "error" in parsed ? parsed.error : "No repository: include a repo URL or map this channel.";
        return ephemeral(extras.error || repoError);
      }
      queueBody = {
        platform: "discord",
        threadKey,
        repoUrl: extras.extras.repoUrl ?? "",
        task: extras.task,
        userId,
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
      };
    }
    if ("error" in parsed && !queueBody) {
      return ephemeral(parsed.error);
    }
    if (!queueBody) {
      if ("error" in parsed) return ephemeral(parsed.error);
      queueBody = {
        platform: "discord",
        threadKey,
        repoUrl: parsed.repoUrl,
        task: parsed.task,
        userId,
        harness: env.DISCORD_AGENT_HARNESS ?? env.AGENT_HARNESS,
      };
    }
    await schedule(async () => {
      const queued = await queueChatRun(env, queueBody!, deps.resolveOrchestrator);
      if ("error" in queued) {
        await send("PATCH", `${webhook}/messages/@original`, {
          content: `Failed to queue the task. ${queued.error}`,
          allowed_mentions: NO_MENTIONS,
        });
        return;
      }
      await send("PATCH", `${webhook}/messages/@original`, {
        content: chatApprovalText({
          repoUrl: queueBody!.repoUrl,
          task: queueBody!.task,
          approvalId: queued.approvalId,
          route: queued.route,
          employeeLabel: queueBody!.employeeLabel,
        }),
        components: decisionButtons(queued.approvalId),
        allowed_mentions: NO_MENTIONS,
      });
      for (const chunk of chatTaskChunks(queueBody!.task, CARD_TASK_LIMIT, 1900)) {
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
