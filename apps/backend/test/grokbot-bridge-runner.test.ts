import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAutomation } from "../src/automations.js";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

vi.mock("../src/slack.js", async () => ({
  ...await vi.importActual<typeof import("../src/slack.js")>("../src/slack.js"),
  postSlackMessage: vi.fn(async () => undefined),
}));

import { postSlackMessage, SlackPostRejectedError } from "../src/slack.js";
import { createGrokbotBridgeTask, getGrokbotBridgeTask } from "../src/grokbot-bridge-store.js";
import { completeBridgeTaskAndMaybeSlack, resolveBridgeApproval, runFounderSkillBridgeCron } from "../src/grokbot-bridge-runner.js";

describe("grokbot bridge founder cron", () => {
  beforeEach(() => {
    vi.mocked(postSlackMessage).mockClear();
  });

  it("posts Stripe revenue pulse digest to Slack on cron when simulate + secrets are set", async () => {
    const db = customAgentD1().database;
    const env = {
      AGENT_AUDIT: db,
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APPROVALS_CHANNEL: "CFOUNDER",
      GROKBOT_BRIDGE_SIMULATE: "true",
    } as unknown as Env;
    const { automation } = createAutomation({
      id: "founder-stripe-revenue-pulse",
      prompt: "pulse",
      executionTarget: {
        kind: "grokbot-bridge",
        founderSkillId: "founder-stripe-revenue-pulse",
        expectedDeliverables: ["reports/stripe-revenue-pulse.md"],
      },
      triggers: [{ kind: "schedule", cron: "0 8 * * *", timezone: "UTC" }],
    });
    const { task, slackPosted } = await runFounderSkillBridgeCron(env, "self-hosted", "owner@test", automation, Date.UTC(2026, 9, 1, 8, 0));
    expect(task.status).toBe("completed");
    expect(slackPosted).toBe(true);
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
    const call = vi.mocked(postSlackMessage).mock.calls[0]!;
    expect(call[0]).toBe("xoxb-test");
    expect(call[1]?.channel).toBe("CFOUNDER");
    expect(String(call[1]?.text)).toContain("128400");
  });

  it("leaves live cron work queued and accessible only inside its organization", async () => {
    const env = { AGENT_AUDIT: customAgentD1().database, SLACK_BOT_TOKEN: "token", SLACK_APPROVALS_CHANNEL: "C" } as unknown as Env;
    const { automation } = createAutomation({ id: "live", prompt: "pulse", executionTarget: { kind: "grokbot-bridge", founderSkillId: "founder-stripe-revenue-pulse", expectedDeliverables: ["report.md"] }, triggers: [{ kind: "schedule", cron: "0 8 * * *" }] });
    const { task } = await runFounderSkillBridgeCron(env, "self-hosted", "automations", automation, 1);
    expect(task.status).toBe("queued");
    expect(task.resultJson).toBeNull();
    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(await getGrokbotBridgeTask(env, "self-hosted", "grok-bot", task.id)).toMatchObject({ id: task.id });
    expect(await getGrokbotBridgeTask(env, "other-org", "grok-bot", task.id)).toBeNull();
  });

  it("claims completion once before Slack and preserves the winning result", async () => {
    const env = { AGENT_AUDIT: customAgentD1().database, SLACK_BOT_TOKEN: "token", SLACK_APPROVALS_CHANNEL: "C" } as unknown as Env;
    const task = await createGrokbotBridgeTask(env, { orgId: "self-hosted", ownerId: "grok-bot", principal: "grok-bot", founderSkillId: "founder-stripe-revenue-pulse" });
    const results = await Promise.allSettled([1, 2].map((value) => completeBridgeTaskAndMaybeSlack(env, "self-hosted", "grok-bot", task, { value }, { postSlack: true })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
    const completed = await getGrokbotBridgeTask(env, "self-hosted", "grok-bot", task.id);
    if (!completed) throw new Error("Completed task missing");
    await expect(completeBridgeTaskAndMaybeSlack(env, "self-hosted", "grok-bot", completed, {}, { postSlack: true })).rejects.toThrow("current state");
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
  });

  it("freezes sensitive output and releases it once through its approval", async () => {
    const env = { AGENT_AUDIT: customAgentD1().database, SLACK_BOT_TOKEN: "token", SLACK_APPROVALS_CHANNEL: "C" } as unknown as Env;
    const task = await createGrokbotBridgeTask(env, { orgId: "self-hosted", ownerId: "grok-bot", principal: "grok-bot", founderSkillId: "founder-hubspot-stripe-reconcile" });
    const pending = await completeBridgeTaskAndMaybeSlack(env, "self-hosted", "grok-bot", task, { sensitive: "frozen" }, { postSlack: true, requiresSensitiveApproval: false });
    expect(pending).toMatchObject({ status: "awaiting_approval", slackPostedAt: null });
    if (!pending?.approvalId) throw new Error("Approval missing");
    expect(pending.approvalId).toMatch(/^gba-/);
    expect(postSlackMessage).not.toHaveBeenCalled();
    await expect(resolveBridgeApproval(env, "other-org", pending.approvalId, true)).rejects.toThrow();
    const approvalId = pending.approvalId;
    const outcomes = await Promise.allSettled([true, true].map((approved) => resolveBridgeApproval(env, "self-hosted", approvalId, approved, 42)));
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(postSlackMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(postSlackMessage).mock.calls[0]?.[1]?.text).toBe(pending.slackText);
    expect(await getGrokbotBridgeTask(env, "self-hosted", "grok-bot", task.id)).toMatchObject({ status: "completed", slackPostedAt: 42 });
  });

  it("retains cron sensitivity overrides and Slack channel when MCP supplies the result", async () => {
    const env = { AGENT_AUDIT: customAgentD1().database, SLACK_BOT_TOKEN: "token", SLACK_APPROVALS_CHANNEL: "DEFAULT" } as unknown as Env;
    const { automation } = createAutomation({ id: "private", prompt: "pulse", executionTarget: { kind: "grokbot-bridge", founderSkillId: "founder-stripe-revenue-pulse", requiresSensitiveApproval: true, slackChannel: "PRIVATE", expectedDeliverables: ["report.md"] }, triggers: [{ kind: "schedule", cron: "0 8 * * *" }] });
    const { task } = await runFounderSkillBridgeCron(env, "self-hosted", "automations", automation, 1);
    const pending = await completeBridgeTaskAndMaybeSlack(env, "self-hosted", "grok-bot", task, { metric: 12 }, { postSlack: true });
    if (!pending?.approvalId) throw new Error("Approval missing");
    expect(pending.status).toBe("awaiting_approval");
    expect(postSlackMessage).not.toHaveBeenCalled();
    await resolveBridgeApproval(env, "self-hosted", pending.approvalId, true);
    expect(vi.mocked(postSlackMessage).mock.calls[0]?.[1]?.channel).toBe("PRIVATE");
  });

  it("retries a definitively rejected sensitive post using the frozen approval, but never retries uncertain delivery", async () => {
    const env = { AGENT_AUDIT: customAgentD1().database, SLACK_BOT_TOKEN: "token", SLACK_APPROVALS_CHANNEL: "C" } as unknown as Env;
    const task = await createGrokbotBridgeTask(env, { orgId: "self-hosted", ownerId: "grok-bot", principal: "grok-bot", founderSkillId: "founder-hubspot-stripe-reconcile" });
    const attempts = await Promise.allSettled([1, 2].map((value) => completeBridgeTaskAndMaybeSlack(env, "self-hosted", "grok-bot", task, { value }, { postSlack: true })));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const pending = await getGrokbotBridgeTask(env, "self-hosted", "grok-bot", task.id);
    if (!pending?.approvalId) throw new Error("Approval missing");
    vi.mocked(postSlackMessage).mockRejectedValueOnce(new SlackPostRejectedError("channel_not_found"));
    const rejected = await resolveBridgeApproval(env, "self-hosted", pending.approvalId, true);
    expect(rejected).toMatchObject({ status: "awaiting_approval", resultJson: pending.resultJson });
    if (!rejected) throw new Error("Rejected task missing");
    await expect(completeBridgeTaskAndMaybeSlack(env, "self-hosted", "grok-bot", rejected, { replacement: true }, { postSlack: true })).rejects.toThrow();
    vi.mocked(postSlackMessage).mockRejectedValueOnce(new Error("timeout"));
    expect(await resolveBridgeApproval(env, "self-hosted", pending.approvalId, true)).toMatchObject({ status: "completed", error: expect.stringContaining("uncertain") });
    await expect(resolveBridgeApproval(env, "self-hosted", pending.approvalId, true)).rejects.toThrow();
    expect(postSlackMessage).toHaveBeenCalledTimes(2);
  });

});
