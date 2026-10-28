import { describe, expect, it, vi } from "vitest";
import { createApiKey } from "../src/agent-tokens.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";

vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
  proxyToSandbox: vi.fn().mockResolvedValue(null),
  getSandbox: vi.fn(),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: vi.fn(),
  routeAgentRequest: vi.fn().mockResolvedValue(null),
}));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("../src/agents/orchestrator.js", () => ({ CodingOrchestrator: class {} }));

function fixture() {
  const rows = new Map<string, string>();
  const prepare = vi.fn();
  const env = {
    REQUIRE_ACCESS: "1",
    AGENT_AUDIT: { prepare } as unknown as D1Database,
    AGENT_TOKENS: {
      get: async (name: string) => rows.get(name) ?? null,
      put: async (name: string, value: string) => { rows.set(name, value); },
    } as unknown as KVNamespace,
  } as Env;
  return { env, prepare };
}

describe("Worker path and explicit-credential isolation", () => {
  it.each([
    "/api/custom-agents/../runs",
    "/api/custom-agents/%2e%2e/runs",
    "/api/org/model-keys/../../runs",
    "/api/org/model-keys/%2e%2e/%2e%2e/runs",
  ])("does not inherit an org-API ingress exemption after normalizing %s", async (path) => {
    const f = fixture();
    const { token } = await createApiKey(f.env, {
      orgId: "org-a", principal: "automation", label: "test", scopes: ["api:read", "api:write"],
    });
    const request = new Request(`https://worker.test${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(new URL(request.url).pathname).toBe("/api/runs");
    expect((await worker.fetch(request, f.env)).status).toBe(401);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("keeps normalized v1 org-agent traversal out of shared runtime stores", async () => {
    const f = fixture();
    const { token } = await createApiKey(f.env, {
      orgId: "org-a", principal: "automation", label: "test", scopes: ["api:read", "api:write"],
    });
    const request = new Request("https://worker.test/api/v1/org-agents/%2e%2e/threads", {
      headers: {
        authorization: `Bearer ${token}`,
        "CF-Access-Authenticated-User-Email": "owner@example.com",
      },
    });
    expect(new URL(request.url).pathname).toBe("/api/v1/threads");
    const response = await worker.fetch(request, f.env);
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ error: "tenant_runtime_unavailable" });
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it.each(["", " ", "Bearer", "Bearer ", "Basic invalid", "Bearer invalid, Bearer invalid"])(
    "does not upgrade malformed explicit Authorization %j with an ambient dashboard identity",
    async (authorization) => {
      const f = fixture();
      const request = new Request("https://worker.test/api/api-keys", {
        headers: { authorization, "CF-Access-Authenticated-User-Email": "owner@example.com" },
      });
      expect(request.headers.has("authorization")).toBe(true);
      expect((await worker.fetch(request, f.env)).status).toBe(401);
      expect(f.prepare).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate valid bearer credentials instead of choosing one or falling back to a session", async () => {
    const f = fixture();
    const { token } = await createApiKey(f.env, {
      orgId: "org-a", principal: "automation", label: "test", scopes: ["api:keys:admin"],
    });
    const headers = new Headers({ "CF-Access-Authenticated-User-Email": "owner@example.com" });
    headers.append("authorization", `Bearer ${token}`);
    headers.append("authorization", `Bearer ${token}`);
    const response = await worker.fetch(new Request("https://worker.test/api/api-keys", { headers }), f.env);
    expect(response.status).toBe(401);
    expect(f.prepare).not.toHaveBeenCalled();
  });
});
