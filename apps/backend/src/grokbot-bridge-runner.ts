/**
 * Grok Bot bridge runtime: founder-skill cron dispatch, Slack digests, and
 * simulate/complete hooks used by MCP tools and tests.
 */
import {
  getFounderSkillLibraryEntry,
  type FounderSkillLibraryEntry,
} from "@shiba/shared";
import type { Env } from "./env.js";
import { postSlackMessage } from "./slack.js";
import {
  createGrokbotBridgeTask,
  publicBridgeTask,
  updateGrokbotBridgeTask,
  type GrokbotBridgeTask,
} from "./grokbot-bridge-store.js";
import type { Automation, AutomationMatchEvent, MatchedTrigger } from "./automations.js";
import { recordSkip, recordTrigger } from "./automations.js";
import type { FireAutomationDeps, FireAutomationResult } from "./automation-runner.js";
import { automationThreadKey } from "./automation-runner.js";
import { automationCommandId } from "./pending-approvals.js";
import type { GrokbotBridgeTaskStatus } from "@shiba/shared";

export interface GrokbotBridgeEnv extends Pick<Env, "AGENT_AUDIT" | "SLACK_BOT_TOKEN" | "SLACK_APPROVALS_CHANNEL" | "GROKBOT_BRIDGE_SIMULATE"> {}

export function bridgeSimulateEnabled(env: GrokbotBridgeEnv): boolean {
  const raw = env.GROKBOT_BRIDGE_SIMULATE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function formatFounderSkillSlackDigest(
  entry: FounderSkillLibraryEntry,
  result: Record<string, unknown> | null,
): string {
  const lines = [`*${entry.slackDigestTitle}*`, entry.description, ""];
  if (result && Object.keys(result).length > 0) {
    lines.push("Bridge payload (untrusted):", "```", JSON.stringify(result, null, 2).slice(0, 3500), "```");
  } else {
    lines.push("_No Grok Bot bridge result yet — schedule fired with Shiba-side digest stub._");
  }
  lines.push("", `Skill: \`${entry.id}\` · ${entry.schedule.label}`);
  return lines.join("\n");
}

export async function postFounderSkillSlack(
  env: GrokbotBridgeEnv,
  channel: string | undefined,
  text: string,
): Promise<{ posted: boolean; reason: string }> {
  const token = env.SLACK_BOT_TOKEN?.trim();
  const target = channel?.trim() || env.SLACK_APPROVALS_CHANNEL?.trim();
  if (!token || !target) {
    return { posted: false, reason: "Slack bot token or target channel is not configured." };
  }
  await postSlackMessage(token, { channel: target, text });
  return { posted: true, reason: "Posted digest to Slack." };
}

export async function simulateGrokbotBridgeResult(
  entry: FounderSkillLibraryEntry,
): Promise<Record<string, unknown>> {
  if (entry.id === "founder-stripe-revenue-pulse") {
    return {
      mrrUsd: 128_400,
      netNewMrrUsd: 4_200,
      logoChurnPct: 1.2,
      revenueChurnPct: 0.9,
      source: "grokbot-bridge-simulate",
    };
  }
  return { skillId: entry.id, source: "grokbot-bridge-simulate", at: new Date().toISOString() };
}

export async function completeBridgeTaskAndMaybeSlack(
  env: GrokbotBridgeEnv,
  orgId: string,
  principal: string,
  task: GrokbotBridgeTask,
  result: Record<string, unknown>,
  options: { postSlack: boolean; slackChannel?: string; requiresSensitiveApproval?: boolean },
  now = Date.now(),
): Promise<GrokbotBridgeTask | null> {
  if (!env.AGENT_AUDIT) return null;
  const entry = getFounderSkillLibraryEntry(task.founderSkillId);
  const slackText = entry ? formatFounderSkillSlackDigest(entry, result) : JSON.stringify(result);
  let status: GrokbotBridgeTaskStatus = options.requiresSensitiveApproval ? "awaiting_approval" : "completed";
  let slackPostedAt: number | null = null;
  if (options.postSlack && !options.requiresSensitiveApproval) {
    const post = await postFounderSkillSlack(env, options.slackChannel, slackText);
    if (post.posted) {
      slackPostedAt = now;
      status = "completed";
    } else {
      status = "failed";
    }
  } else if (options.postSlack && options.requiresSensitiveApproval) {
    status = "awaiting_approval";
  }
  return updateGrokbotBridgeTask(env, orgId, principal, task.id, {
    status,
    resultJson: JSON.stringify(result),
    slackText,
    slackPostedAt,
    ...(status === "failed" ? { error: "Slack post failed or channel unset." } : {}),
  }, now);
}

export async function runFounderSkillBridgeCron(
  env: GrokbotBridgeEnv,
  orgId: string,
  ownerId: string,
  automation: Automation,
  nowMs: number,
): Promise<{ task: GrokbotBridgeTask; slackPosted: boolean }> {
  if (!env.AGENT_AUDIT) throw new Error("Bridge storage unavailable.");
  const target = automation.executionTarget;
  if (target?.kind !== "grokbot-bridge") throw new Error("Not a grokbot-bridge automation.");
  const entry = getFounderSkillLibraryEntry(target.founderSkillId);
  if (!entry) throw new Error("Unknown founder skill.");
  const task = await createGrokbotBridgeTask(env, {
    orgId,
    ownerId,
    principal: `automation:${automation.id}`,
    founderSkillId: target.founderSkillId,
    automationId: automation.id,
    payload: { scheduledAt: nowMs, bridgeCatalogIds: target.bridgeCatalogIds ?? entry.bridgeCatalogIds },
  }, nowMs);
  await updateGrokbotBridgeTask(env, orgId, task.principal, task.id, { status: "running" }, nowMs);
  const result = bridgeSimulateEnabled(env) ? await simulateGrokbotBridgeResult(entry) : {};
  const sensitive = target.requiresSensitiveApproval ?? entry.requiresSensitiveApproval;
  const updated = await completeBridgeTaskAndMaybeSlack(
    env,
    orgId,
    task.principal,
    task,
    result,
    {
      postSlack: true,
      slackChannel: target.slackChannel,
      requiresSensitiveApproval: sensitive,
    },
    nowMs,
  );
  if (!updated) throw new Error("Bridge task update failed.");
  return { task: updated, slackPosted: updated.slackPostedAt !== null };
}

export async function fireGrokbotBridgeAutomation(
  automation: Automation,
  event: AutomationMatchEvent,
  deps: FireAutomationDeps,
  nowMs: number,
  recheck: MatchedTrigger,
  orgId: string,
  ownerId: string,
): Promise<FireAutomationResult> {
  const target = automation.executionTarget;
  if (target?.kind !== "grokbot-bridge") {
    return { fired: false, automation, reason: "Missing grokbot-bridge execution target." };
  }
  if (!deps.bridgeContext?.env.AGENT_AUDIT) {
    const skipped = recordSkip(automation, "Grok Bot bridge storage is unavailable.", nowMs);
    return { fired: false, automation: skipped, reason: skipped.lastSkip?.reason ?? "storage" };
  }
  const scheduleAt = recheck.trigger.kind === "schedule" ? recheck.scheduleOccurrenceMs ?? nowMs : nowMs;
  try {
    const { slackPosted } = await runFounderSkillBridgeCron(deps.bridgeContext.env, orgId, ownerId, automation, scheduleAt);
    const scheduleKey = recheck.trigger.kind === "schedule" ? `t${recheck.triggerIndex}` : undefined;
    const next = recordTrigger(automation, nowMs, scheduleKey);
    const reason = slackPosted
      ? "Founder skill bridge cron posted Slack digest."
      : bridgeSimulateEnabled(deps.bridgeContext.env)
        ? "Bridge cron completed; Slack not configured (see SLACK_BOT_TOKEN / SLACK_APPROVALS_CHANNEL)."
        : "Bridge task queued; connect Grok Bot MCP to complete and post.";
    void automationThreadKey(automation.id);
    void automationCommandId(automation.id, event);
    return { fired: true, automation: next, reason };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Bridge cron failed.";
    const skipped = recordSkip(automation, detail, nowMs);
    return { fired: false, automation: skipped, reason: detail };
  }
}

export { publicBridgeTask };
