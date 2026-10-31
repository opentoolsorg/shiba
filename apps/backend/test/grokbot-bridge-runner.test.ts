import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAutomation } from "../src/automations.js";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

vi.mock("../src/slack.js", () => ({
  postSlackMessage: vi.fn(async () => undefined),
}));

import { postSlackMessage } from "../src/slack.js";
import { runFounderSkillBridgeCron } from "../src/grokbot-bridge-runner.js";

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
});
