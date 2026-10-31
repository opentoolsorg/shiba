/**
 * Grok Bot bridge runtime: founder-skill cron dispatch, Slack digests, and
 * simulate/complete hooks used by MCP tools and tests.
 */
import {
  getFounderSkillLibraryEntry,
  type FounderSkillLibraryEntry,
} from "@shiba/shared";
import type { Env } from "./env.js";
import { postSlackMessage, SlackPostRejectedError } from "./slack.js";
import {
  createGrokbotBridgeTask,
  createBridgeApproval,
  getBridgeApproval,
  getGrokbotBridgeTask,
  publicBridgeTask,
  updateGrokbotBridgeTask,
  type GrokbotBridgeTask,
} from "./grokbot-bridge-store.js";
import type { Automation, AutomationMatchEvent, MatchedTrigger } from "./automations.js";
import { recordSkip, recordTrigger } from "./automations.js";
import type { FireAutomationDeps, FireAutomationResult } from "./automation-runner.js";
import { automationThreadKey } from "./automation-runner.js";
import { automationCommandId } from "./pending-approvals.js";

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
  if (!["queued", "running", "failed"].includes(task.status)) throw new Error("Bridge task cannot be completed in its current state.");
  if (task.approvalId) throw new Error("Resolve the existing bridge approval instead of replacing its result.");
  const sensitive = Boolean(entry?.requiresSensitiveApproval || task.requiresSensitiveApproval || options.requiresSensitiveApproval);
  if (sensitive && orgId !== "self-hosted") throw new Error("Sensitive bridge approvals are supported only in the self-hosted organization.");
  const slackChannel = task.slackChannel ?? options.slackChannel;
  if (sensitive) {
    const pending = await createBridgeApproval(env, task, JSON.stringify(result), slackText, { ...options, slackChannel }, now);
    if (!pending) throw new Error("Bridge task changed; re-read its status before retrying.");
    return pending;
  }
  // Claim completion before any network side effect. A retry cannot replace the
  // frozen result or post a second digest, even when callers race.
  const claimed = await updateGrokbotBridgeTask(env, orgId, principal, task.id, {
    status: "completed",
    resultJson: JSON.stringify(result), slackText, slackPostedAt: null, approvalId: null, error: null,
  }, now, task.status);
  if (!claimed) throw new Error("Bridge task changed; re-read its status before retrying.");
  if (!options.postSlack) return claimed;
  return postClaimedBridgeDigest(env, claimed, slackChannel, now);
}

async function postClaimedBridgeDigest(env: GrokbotBridgeEnv, task: GrokbotBridgeTask, channel: string | undefined, now: number, sensitive = false) {
  if (!task.slackText) throw new Error("Bridge digest missing.");
  try {
    const post = await postFounderSkillSlack(env, channel, task.slackText);
    return await updateGrokbotBridgeTask(env, task.orgId, task.principal, task.id, {
      status: post.posted ? "completed" : sensitive ? "awaiting_approval" : "failed", slackPostedAt: post.posted ? now : null,
      error: post.posted ? null : post.reason,
    }, now, "completed");
  } catch (error) {
    if (error instanceof SlackPostRejectedError && error.outcomeKnown) {
      return updateGrokbotBridgeTask(env, task.orgId, task.principal, task.id, {
        status: sensitive ? "awaiting_approval" : "failed",
        error: "Slack rejected the digest; check bot permissions and channel configuration before retrying.",
      }, now, "completed");
    }
    // Delivery is uncertain after a network failure: retain the terminal claim
    // so an automatic retry cannot duplicate a possibly delivered digest.
    return updateGrokbotBridgeTask(env, task.orgId, task.principal, task.id, {
      error: "Slack delivery uncertain; check Slack before taking further action.",
    }, now, "completed");
  }
}

/** Dashboard-only caller authorization lives in handleFounderSkills. */
export async function resolveBridgeApproval(env: GrokbotBridgeEnv, orgId: string, approvalId: string, approved: boolean, now = Date.now()) {
  const approval = await getBridgeApproval(env, orgId, approvalId);
  if (!approval) throw new Error("Bridge approval not pending.");
  const task = await getGrokbotBridgeTask(env, orgId, approval.principal, approval.task_id);
  if (!task || task.approvalId !== approvalId || task.status !== "awaiting_approval" || !task.slackText) throw new Error("Bridge approval not pending.");
  const claimed = await updateGrokbotBridgeTask(env, orgId, task.principal, task.id, {
    status: "completed", error: approved ? null : "Sensitive digest rejected by operator.",
  }, now, "awaiting_approval");
  if (!claimed) throw new Error("Bridge approval already resolved.");
  if (!approved || !approval.post_slack) return claimed;
  return postClaimedBridgeDigest(env, claimed, approval.slack_channel ?? undefined, now, true);
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
    delivery: { requiresSensitiveApproval: Boolean(target.requiresSensitiveApproval || entry.requiresSensitiveApproval), slackChannel: target.slackChannel },
    payload: { scheduledAt: nowMs, bridgeCatalogIds: target.bridgeCatalogIds ?? entry.bridgeCatalogIds },
  }, nowMs);
  if (!bridgeSimulateEnabled(env)) return { task, slackPosted: false };
  const result = await simulateGrokbotBridgeResult(entry);
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
