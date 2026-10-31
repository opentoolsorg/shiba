import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { assertAuthorizedSandboxDebug } from "../src/sandbox/debug-access.js";

const getAgentByName = vi.hoisted(() => vi.fn());

vi.mock("agents/routing", () => ({ getAgentByName }));

vi.mock("../src/request-auth.js", () => ({
  resolveUserId: vi.fn(async () => "alice@example.com"),
}));

vi.mock("../src/slack-approval.js", () => ({
  isApprover: vi.fn(() => false),
  parseApproverAllowlist: vi.fn(() => []),
}));

describe("assertAuthorizedSandboxDebug", () => {
  beforeEach(() => {
    getAgentByName.mockReset();
  });

  it("allows a sandbox id that appears on the caller's run list", async () => {
    getAgentByName.mockResolvedValue({
      fetch: vi.fn(async () =>
        Response.json({ runs: [{ runId: "r1", sandboxId: "run-abc123" }] }),
      ),
    });
    const env = { CodingOrchestrator: {} } as Env;
    const request = new Request("https://internal/api/sandboxes/run-abc123/info");
    expect(await assertAuthorizedSandboxDebug(env, request, "run-abc123")).toBeNull();
  });

  it("denies a sandbox id that is not on the caller's run list", async () => {
    getAgentByName.mockResolvedValue({
      fetch: vi.fn(async () => Response.json({ runs: [{ runId: "r1", sandboxId: "run-mine" }] })),
    });
    const env = { CodingOrchestrator: {} } as Env;
    const request = new Request("https://internal/api/sandboxes/run-theirs/info");
    const denied = await assertAuthorizedSandboxDebug(env, request, "run-theirs");
    expect(denied?.status).toBe(403);
  });
});
