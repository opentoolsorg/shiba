import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { resolveUserId } from "../src/request-auth.js";
import { assertAuthorizedSandboxDebug } from "../src/sandbox/debug-access.js";

const getAgentByName = vi.hoisted(() => vi.fn());

vi.mock("agents/routing", () => ({ getAgentByName }));

vi.mock("../src/request-auth.js", () => ({
  resolveUserId: vi.fn(async (): Promise<string | null> => "alice@example.com"),
  isAccessConfigured: (env: Env) => Boolean(env.REQUIRE_ACCESS || env.ACCESS_AUD),
  isLoopbackRequest: (request: Request) => new URL(request.url).hostname === "localhost",
}));

vi.mock("../src/slack-approval.js", () => ({
  isApprover: vi.fn(() => false),
  parseApproverAllowlist: vi.fn(() => []),
}));

describe("assertAuthorizedSandboxDebug", () => {
  beforeEach(() => {
    getAgentByName.mockReset();
    vi.mocked(resolveUserId).mockResolvedValue("alice@example.com");
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
  it("rejects API keys without a user before querying shared runs", async () => {
    vi.mocked(resolveUserId).mockResolvedValue(null);
    const request = new Request("https://internal/api/sandboxes/shared/info", { headers: { authorization: "Bearer api-key" } });
    expect((await assertAuthorizedSandboxDebug({} as Env, request, "shared"))?.status).toBe(403);
    expect(getAgentByName).not.toHaveBeenCalled();
  });

  it("keeps anonymous fallback only for unconfigured loopback development", async () => {
    vi.mocked(resolveUserId).mockResolvedValue(null);
    getAgentByName.mockResolvedValue({ fetch: vi.fn(async () => Response.json({ runs: [{ sandboxId: "local" }] })) });
    expect(await assertAuthorizedSandboxDebug({} as Env, new Request("http://localhost/api/sandboxes/local/info"), "local")).toBeNull();
    expect(getAgentByName).toHaveBeenCalledWith(undefined, "default");
    getAgentByName.mockClear();
    expect((await assertAuthorizedSandboxDebug({ REQUIRE_ACCESS: "1" } as Env, new Request("http://localhost/api/sandboxes/local/info"), "local"))?.status).toBe(403);
    expect(getAgentByName).not.toHaveBeenCalled();
  });

});
