import { describe, expect, it, vi } from "vitest";
import { handleAskUser } from "../src/ask-user-routes.js";

vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: async () => true,
  resolveUserId: async () => "owner@example.test",
}));
vi.mock("../src/runs-routes.js", () => ({
  resolveRunStoreTarget: async () => ({ userId: "owner@example.test" }),
}));
vi.mock("../src/ask-user-store.js", () => ({
  AskUserError: class extends Error {},
  getPendingAskUser: vi.fn(),
  answerAskUser: async () => ({ pending: {}, receipt: {} }),
}));

describe("ask-user live events", () => {
  it("names the resolved run owner as the answer event audience", async () => {
    const frames: Record<string, unknown>[] = [];
    const response = await handleAskUser(new Request("https://shiba.test/api/runs/run_1/ask-user/ask_1/answer", {
      method: "POST",
      headers: { origin: "https://shiba.test", "content-type": "application/json", "X-Shiba-Workspace": "ws_1" },
      body: JSON.stringify({ answer: { mode: "free_text", text: "Continue" } }),
    }), {
      WorkspaceEvents: { getByName: () => ({ fetch: async (request: Request) => {
        frames.push(await request.json() as Record<string, unknown>);
        return Response.json({ ok: true });
      } }) },
    } as never);
    expect(response?.status).toBe(200);
    expect(frames).toEqual([expect.objectContaining({
      kind: "ask_user.answered", entityId: "run_1", audience: { userIds: ["owner@example.test"] },
    })]);
  });
});
