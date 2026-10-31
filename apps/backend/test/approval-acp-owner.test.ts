import { beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleApprovals } from "../src/approvals-routes.js";

const { getAgentByName, userFetch, sharedFetch } = vi.hoisted(() => ({
  getAgentByName: vi.fn(), userFetch: vi.fn(), sharedFetch: vi.fn(),
}));
vi.mock("agents/routing", () => ({ getAgentByName }));
vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: async () => true,
  resolveUserId: async () => "alice@example.test",
}));
beforeEach(() => {
  vi.clearAllMocks();
  getAgentByName.mockImplementation(async (_binding, name) => ({ fetch: name === "alice@example.test" ? userFetch : sharedFetch }));
});

it.each([true, false])("resolves ACP approval only through the persisted owner's DO (owned=%s)", async (owned) => {
  userFetch.mockImplementation(async (request: Request | string) => {
    if (typeof request !== "string") return Response.json({ result: "approved" });
    if (request.endsWith("web-sessions")) return Response.json({ sessions: [] });
    return Response.json({ approvals: owned ? [{ approvalId: "approval-1", threadKey: "acp:session-1" }] : [] });
  });
  sharedFetch.mockResolvedValue(Response.json({ approvals: [{ approvalId: "approval-1", threadKey: "acp:session-1" }] }));
  const response = await handleApprovals(new Request("https://dashboard/api/approvals", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadKey: "acp:session-1", approvalId: "approval-1", approved: true }),
  }), {} as Env);
  expect(response?.status).toBe(owned ? 200 : 404);
  expect(sharedFetch).not.toHaveBeenCalled();
  expect(userFetch.mock.calls.filter(([request]) => request instanceof Request)).toHaveLength(owned ? 1 : 0);
});
