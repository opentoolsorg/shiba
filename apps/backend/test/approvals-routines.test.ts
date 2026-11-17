import { expect, it, vi } from "vitest";

vi.mock("agents/routing", () => ({
  getAgentByName: async (_namespace: unknown, name: string) => ({
    fetch: async (input: string | Request) => {
      const path = new URL(typeof input === "string" ? input : input.url).pathname;
      if (path === "/internal/web-sessions") return Response.json({ sessions: [] });
      return Response.json({ approvals: name === "default" ? [{
        approvalId: "approval-weekly", threadKey: "automation:weekly", status: "pending", createdAt: 1,
      }] : [], decided: [] });
    },
  }),
}));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: async () => true,
  resolveUserId: async () => "operator@example.com",
}));
vi.mock("../src/slack-routes.js", () => ({ ORCHESTRATOR_NAME: "default" }));

import { handleApprovals } from "../src/approvals-routes.js";
import { createAutomation } from "../src/automations.js";
import type { Env } from "../src/env.js";

it("labels the pending approval card response with the routine name and cadence", async () => {
  const automation = createAutomation({
    id: "weekly", name: "Weekly summary", prompt: "Summarize the week", repoUrl: "https://github.com/o/r",
    enabled: false, triggers: [{ kind: "schedule", cron: "0 9 * * 1", timezone: "Asia/Kolkata" }],
  }).automation;
  const env = { CodingOrchestrator: {}, Automations: {
    idFromName: () => "default",
    get: () => ({ fetch: async () => Response.json({ automations: [automation] }) }),
  } } as unknown as Env;
  const response = await handleApprovals(new Request("https://shiba.test/api/approvals"), env);
  expect(response?.status).toBe(200);
  expect(await response?.json()).toMatchObject({ approvals: [{
    approvalId: "approval-weekly", routine: {
      id: "weekly", name: "Weekly summary", schedule: "0 9 * * 1", timezone: "Asia/Kolkata", nextRunAt: null,
    },
  }] });
});
