import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async (request: Request) => request.headers.get("x-dashboard") === "yes"),
  resolveUserId: vi.fn(async () => "operator"),
}));
vi.mock("../src/slack.js", async () => ({
  ...await vi.importActual<typeof import("../src/slack.js")>("../src/slack.js"), postSlackMessage: vi.fn(async () => undefined) }));
import { handleFounderSkills } from "../src/founder-skills-routes.js";
import { createGrokbotBridgeTask, getGrokbotBridgeTask } from "../src/grokbot-bridge-store.js";
import { completeBridgeTaskAndMaybeSlack } from "../src/grokbot-bridge-runner.js";
import { postSlackMessage } from "../src/slack.js";

describe("sensitive bridge dashboard approval", () => {
  beforeEach(() => vi.mocked(postSlackMessage).mockClear());

  it("requires dashboard identity and same-origin intent, then can reject the stored digest", async () => {
    const env = { AGENT_AUDIT: customAgentD1().database, SLACK_BOT_TOKEN: "token", SLACK_APPROVALS_CHANNEL: "C" } as unknown as Env;
    const task = await createGrokbotBridgeTask(env, { orgId: "self-hosted", ownerId: "grok-bot", principal: "grok-bot", founderSkillId: "founder-hubspot-stripe-reconcile" });
    const pending = await completeBridgeTaskAndMaybeSlack(env, "self-hosted", "grok-bot", task, { amount: 50 }, { postSlack: true });
    if (!pending?.approvalId) throw new Error("Approval missing");
    const url = `https://shiba.test/api/founder-skills/bridge-approvals/${pending.approvalId}`;
    const post = (headers: Record<string, string>) => handleFounderSkills(new Request(url, { method: "POST", headers, body: JSON.stringify({ approved: false }) }), env);
    expect((await post({ origin: "https://shiba.test" }))?.status).toBe(401);
    expect((await post({ "x-dashboard": "yes", authorization: "Bearer connector", origin: "https://shiba.test" }))?.status).toBe(401);
    expect((await post({ "x-dashboard": "yes", origin: "https://attacker.test" }))?.status).toBe(403);
    const listed = await handleFounderSkills(new Request("https://shiba.test/api/founder-skills/bridge-approvals", { headers: { "x-dashboard": "yes" } }), env);
    expect(await listed?.json()).toMatchObject({ approvals: [{ approvalId: pending.approvalId, slackText: pending.slackText }] });
    expect((await post({ "x-dashboard": "yes", origin: "https://shiba.test" }))?.status).toBe(200);
    expect((await post({ "x-dashboard": "yes", origin: "https://shiba.test" }))?.status).toBe(409);
    expect(postSlackMessage).not.toHaveBeenCalled();
    expect(await getGrokbotBridgeTask(env, "self-hosted", "grok-bot", task.id)).toMatchObject({ status: "completed", error: "Sensitive digest rejected by operator." });
  });
});
