/**
 * Slack, Discord, and Telegram can target a saved employee profile with
 * `bot:<slug>` or `employee:<slug>` in the task text, or `CHAT_EMPLOYEE_DEFAULT`.
 * Run queue bodies and employee-tool approval cards reuse the same thread keys
 * as coding approvals (`slack:…`, `discord:…`, `telegram:…`).
 */
import { parseChatThreadName, type ExecutionTarget } from "@shiba/shared";
import type { CustomAgentRecord } from "@shiba/shared";
import { overridesFromCustomAgent, resolveCustomAgentForRun } from "./custom-agents-resolve.js";
import type { Env } from "./env.js";
import { DASHBOARD_ORG_ID } from "./org-request-auth.js";
import { resolveEmployeeRunToolContext } from "./employee-run-tools.js";
import { decideEmployeeActionApproval, type EmployeeApprovalRecord } from "./employee-tool-store.js";
import { postSlackMessage } from "./slack.js";
import {
  buildEmployeeToolApprovalBlocks,
} from "./slack-approval.js";
import { parseSlackThreadName } from "./slack-thread.js";
import { postToChatThread, discordApi, NO_MENTIONS, telegramApi } from "./chat-lane.js";
import { buildEmployeeDecisionData } from "@shiba/shared";

export const CHAT_EMPLOYEE_TOKEN = /(?:^|\s)(?:bot|employee):([a-z0-9][a-z0-9-]{0,62})\b/i;

export function stripChatEmployeeToken(text: string): { slug: string | null; remainder: string } {
  const match = CHAT_EMPLOYEE_TOKEN.exec(text);
  if (!match) {
    return { slug: null, remainder: text.replace(/\s+/g, " ").trim() };
  }
  const slug = match[1]!.toLowerCase();
  const remainder = text.replace(match[0], " ").replace(/\s+/g, " ").trim();
  return { slug, remainder };
}

export function resolveChatEmployeeOrgId(env: Pick<Env, "CHAT_EMPLOYEE_ORG_ID">): string {
  const raw = env.CHAT_EMPLOYEE_ORG_ID?.trim();
  return raw && raw.length <= 128 ? raw : DASHBOARD_ORG_ID;
}

export type ResolveChatEmployeeResult =
  | { kind: "none"; taskText: string }
  | { kind: "error"; error: string; taskText: string }
  | { kind: "ok"; agent: CustomAgentRecord; taskText: string; orgId: string };

export async function resolveChatEmployeeFromText(
  env: Pick<Env, "AGENT_AUDIT" | "CHAT_EMPLOYEE_DEFAULT" | "CHAT_EMPLOYEE_ORG_ID">,
  text: string,
): Promise<ResolveChatEmployeeResult> {
  const { slug: explicit, remainder } = stripChatEmployeeToken(text);
  const slug = explicit ?? env.CHAT_EMPLOYEE_DEFAULT?.trim().toLowerCase() ?? null;
  if (!slug) return { kind: "none", taskText: remainder };
  if (!env.AGENT_AUDIT) return { kind: "error", error: "Bot storage is not configured.", taskText: remainder };
  const orgId = resolveChatEmployeeOrgId(env);
  const agent = await resolveCustomAgentForRun(env, orgId, slug);
  if (!agent) {
    return {
      kind: "error",
      error: `Bot "${slug}" was not found. Create it in the dashboard or check the slug.`,
      taskText: remainder,
    };
  }
  return { kind: "ok", agent, taskText: remainder, orgId };
}

export interface ChatEmployeeQueueExtras {
  customAgentId: string;
  customAgentVersion: number;
  orgId: string;
  employeeToolPolicyVersion?: number;
  executionTarget?: ExecutionTarget;
  harness?: string;
  employeeLabel: string;
  repoUrl?: string;
  publishPullRequest?: boolean;
}

/** Merge profile overrides into a chat-lane queue body after repo resolution. */
export async function chatEmployeeQueueExtras(
  env: Pick<Env, "AGENT_AUDIT">,
  agent: CustomAgentRecord,
  orgId: string,
  taskText: string,
  repoUrl: string | null,
): Promise<
  | { ok: true; task: string; extras: ChatEmployeeQueueExtras }
  | { ok: false; error: string; task: string }
> {
  const overrides = overridesFromCustomAgent(agent);
  let task = taskText;
  if (overrides.instructions) {
    task = `${overrides.instructions}\n\n---\n\n${taskText}`;
  }
  let employeeToolPolicyVersion: number | undefined;
  if (agent.config.toolScopes?.length) {
    const policy = await resolveEmployeeRunToolContext(env as Env, agent.id, orgId);
    if (!policy || policy.allowed.length !== agent.config.toolScopes.length) {
      return {
        ok: false,
        error: "Bot tool policy is unavailable or contains unsupported actions. Review employee tool grants in the dashboard.",
        task,
      };
    }
    employeeToolPolicyVersion = agent.version;
  }
  let resolvedRepo = repoUrl ?? overrides.repoUrl ?? null;
  let executionTarget: ExecutionTarget | undefined;
  let publishPullRequest = true;
  if (!resolvedRepo && overrides.expectedDeliverables?.length) {
    executionTarget = {
      kind: "artifact-workspace",
      workspaceName: `${agent.slug}-workspace`,
      expectedDeliverables: [...overrides.expectedDeliverables],
    };
    resolvedRepo = "";
    publishPullRequest = false;
  }
  if (!resolvedRepo && !executionTarget) {
    return { ok: false, error: "", task };
  }
  return {
    ok: true,
    task,
    extras: {
      customAgentId: agent.id,
      customAgentVersion: overrides.customAgentVersion,
      orgId,
      ...(employeeToolPolicyVersion !== undefined ? { employeeToolPolicyVersion } : {}),
      ...(executionTarget ? { executionTarget } : {}),
      harness: overrides.harness,
      employeeLabel: agent.config.name?.trim() || agent.slug,
      ...(resolvedRepo ? { repoUrl: resolvedRepo } : {}),
      publishPullRequest,
    },
  };
}

export function chatLaneActorId(
  env: Pick<Env, "CHAT_EMPLOYEE_ACTOR">,
  threadName: string | undefined,
): string | undefined {
  if (!threadName) return undefined;
  if (parseSlackThreadName(threadName) || parseChatThreadName(threadName)) {
    const actor = env.CHAT_EMPLOYEE_ACTOR?.trim();
    return actor || undefined;
  }
  return undefined;
}

export function isChatIngressThreadName(threadName: string): boolean {
  return parseSlackThreadName(threadName) !== null || parseChatThreadName(threadName) !== null;
}

function summarizeEmployeePayload(payload: Record<string, unknown>, tool: string): string {
  const keys = Object.keys(payload).sort().slice(0, 8);
  const preview = keys.map((key) => `${key}=${JSON.stringify(payload[key]).slice(0, 120)}`).join("; ");
  return preview || `${tool} (empty payload)`;
}

/** Post an exact-payload employee-tool approval card into the originating chat thread. */
export async function notifyEmployeeToolApprovalInChat(
  env: Env,
  record: Pick<
    EmployeeApprovalRecord,
    "approvalId" | "employeeId" | "action" | "payload" | "executionContextId" | "orgId"
  > & { employeeLabel?: string },
): Promise<void> {
  const threadName = record.executionContextId?.trim() ?? "";
  if (!threadName || !isChatIngressThreadName(threadName)) return;
  const preview = summarizeEmployeePayload(record.payload, record.action);
  const label = record.employeeLabel ?? record.employeeId;
  const slackIds = parseSlackThreadName(threadName);
  const token = env.SLACK_BOT_TOKEN?.trim();
  if (slackIds && token) {
    await postSlackMessage(token, {
      channel: slackIds.channelId,
      threadTs: slackIds.threadTs,
      text: `Employee action approval · ${label} · ${record.action}`,
      blocks: buildEmployeeToolApprovalBlocks({
        threadKey: threadName,
        approvalId: record.approvalId,
        employeeId: record.employeeId,
        orgId: record.orgId,
        tool: record.action,
        employeeLabel: label,
        payloadPreview: preview,
      }),
    }).catch(() => undefined);
    return;
  }
  const chatIds = parseChatThreadName(threadName);
  if (chatIds?.platform === "discord") {
    const bot = env.DISCORD_BOT_TOKEN?.trim();
    if (!bot) return;
    const content =
      `Employee action approval\nBot: ${label}\nTool: ${record.action}\nPayload: ${preview.slice(0, 900)}\n` +
      `Use the buttons to approve or reject.`;
    await discordApi("employee approval", `/channels/${chatIds.conversationId}/messages`, {
      method: "POST",
      botToken: bot,
      body: {
        content: content.slice(0, 2000),
        allowed_mentions: NO_MENTIONS,
        components: [{
          type: 1,
          components: [
            { type: 2, style: 3, label: "Approve", custom_id: buildEmployeeDecisionData(true, record.approvalId) },
            { type: 2, style: 4, label: "Reject", custom_id: buildEmployeeDecisionData(false, record.approvalId) },
          ],
        }],
      },
    }).catch(() => undefined);
    return;
  }
  if (chatIds?.platform === "telegram") {
    const tg = env.TELEGRAM_BOT_TOKEN?.trim();
    if (!tg) return;
    await telegramApi(tg, "sendMessage", {
      chat_id: chatIds.conversationId,
      text:
        `Employee action approval\nBot: ${label}\nTool: ${record.action}\n` +
        `${preview.slice(0, 800)}\nApprove: ${buildEmployeeDecisionData(true, record.approvalId)}\n` +
        `Reject: ${buildEmployeeDecisionData(false, record.approvalId)}`.slice(0, 4000),
    }).catch(() => undefined);
    return;
  }
  const relay = postToChatThread(env, threadName, `Employee action pending approval: ${record.action} (${record.approvalId})`);
  if (relay) await relay.catch(() => undefined);
}

export async function decideChatEmployeeToolApproval(
  env: Env,
  input: { orgId: string; threadKey: string; approvalId: string; approved: boolean; decidedBy: string },
): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  if (!env.AGENT_AUDIT) return { ok: false, error: "Employee policy storage is unavailable." };
  if (!isChatIngressThreadName(input.threadKey)) {
    return { ok: false, error: "This employee approval does not belong to this chat thread." };
  }
  const row = await env.AGENT_AUDIT.prepare(
    `SELECT employee_id, execution_context_id, status FROM employee_tool_approvals WHERE org_id = ? AND approval_id = ? LIMIT 1`,
  )
    .bind(input.orgId, input.approvalId)
    .first<{ employee_id: string; execution_context_id: string | null; status: string }>();
  if (!row?.employee_id) return { ok: false, error: "This employee approval is unknown or expired." };
  if (row.execution_context_id !== input.threadKey) {
    return { ok: false, error: "This employee approval does not belong to this chat thread." };
  }
  if (row.status !== "pending") {
    return { ok: false, error: "This approval is already resolved or expired — nothing to do." };
  }
  const decided = await decideEmployeeActionApproval(env, {
    orgId: input.orgId,
    employeeId: row.employee_id,
    approvalId: input.approvalId,
    approved: input.approved,
    decidedBy: input.decidedBy,
    requirePendingTransition: true,
  });
  if (!decided || decided.status !== (input.approved ? "approved" : "denied")) {
    return { ok: false, error: "This approval is already resolved or expired — nothing to do." };
  }
  return { ok: true, status: decided.status };
}
