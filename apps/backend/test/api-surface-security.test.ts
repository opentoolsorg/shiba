import { describe, expect, it, vi } from "vitest";
import type { Scope } from "../src/agent-tokens.js";
import { createApiKey } from "../src/agent-tokens.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";
import { resolveOrgForApiRequest } from "../src/org-request-auth.js";
import { authorizeV1Request } from "../src/v1-auth.js";
import { isOrgApiPath } from "../src/public-routes.js";
import { handleV1 } from "../src/v1-routes.js";

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

class FakeKV {
  rows = new Map<string, { value: string; metadata?: unknown }>();
  async get(key: string) { return this.rows.get(key)?.value ?? null; }
  async put(key: string, value: string, options?: { metadata?: unknown }) {
    this.rows.set(key, { value, metadata: options?.metadata });
  }
  async list() {
    return { keys: [...this.rows].map(([name, row]) => ({ name, metadata: row.metadata })), list_complete: true };
  }
}

function fixture() {
  const bindings: unknown[][] = [];
  const env = {
    REQUIRE_ACCESS: "1",
    Spaces: {} as DurableObjectNamespace,
    AGENT_TOKENS: new FakeKV() as unknown as KVNamespace,
    AGENT_AUDIT: {
      prepare: () => ({
        run: async () => ({ success: true }),
        bind: (...values: unknown[]) => {
          bindings.push(values);
          return {
            first: async () => null,
            all: async () => ({ results: [] }),
          };
        },
      }),
    } as unknown as D1Database,
  } as Env;
  const key = (orgId = "org-a", scopes: Scope[] = ["api:read"]) =>
    createApiKey(env, { orgId, label: "test", principal: "ci", scopes });
  const request = (path: string, token?: string, method = "GET", ambient = false) =>
    new Request(`https://worker.test${path}`, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(ambient ? { "CF-Access-Authenticated-User-Email": "owner@example.com" } : {}),
      },
    });
  return { env, bindings, key, request };
}

describe("Worker API credential boundaries", () => {
  it("serves the documented public OpenAPI document through Worker ingress", async () => {
    const f = fixture();
    const response = await worker.fetch(f.request("/api/v1/openapi.json"), f.env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ openapi: "3.1.0" });
    expect((await worker.fetch(f.request("/api/v1/openapi.json", undefined, "POST"), f.env)).status).toBe(401);
  });

  it.each(["/api/custom-agents", "/api/org/model-keys", "/api/skills/library", "/api/spaces"])(
    "lets a valid org-scoped bearer reach %s without an Access session",
    async (path) => {
      const f = fixture();
      const { token } = await f.key();
      const response = await worker.fetch(f.request(path, token), f.env);
      expect(response.status).toBe(200);
      expect(f.bindings.length).toBeGreaterThan(0);
      expect(f.bindings.every((values) => values[0] === "org-a")).toBe(true);
    },
  );

  it("denies missing, invalid, and scope-denied credentials at the route's own gate", async () => {
    const f = fixture();
    for (const token of [undefined, "invalid"]) {
      expect((await worker.fetch(f.request("/api/custom-agents", token), f.env)).status).toBe(401);
    }
    const { token } = await f.key("org-a", ["api:read"]);
    expect((await worker.fetch(f.request("/api/custom-agents", token, "POST"), f.env)).status).toBe(403);
    expect((await worker.fetch(f.request("/api/api-keys", token), f.env)).status).toBe(403);
    expect(f.bindings).toEqual([]);
  });

  it.each(["/api/skills/library", "/api/skills/library/write-tests-first/install", "/api/spaces", "/api/spaces/templates", "/api/spaces/space-aaaaaaaaaaaaaaaaaaaaaaaa/items", "/api/v1/extensions/skills", "/api/v1/extensions/skills/skill-123/instructions"])(
    "authenticates and scope-checks new org API path %s through Worker ingress",
    async (path) => {
      const f = fixture();
      expect(isOrgApiPath(path)).toBe(true);
      for (const token of [undefined, "invalid"]) {
        expect((await worker.fetch(f.request(path, token), f.env)).status).toBe(401);
      }
      const { token } = await f.key();
      expect((await worker.fetch(f.request(path, token, "POST"), f.env)).status).toBe(403);
      expect(f.bindings).toEqual([]);
    },
  );

  it("lists API keys only in the bearer's org, including with an ambient dashboard identity", async () => {
    const f = fixture();
    const a = await f.key("org-a", ["api:keys:admin"]);
    await f.key("org-b", ["api:keys:admin"]);
    await f.key("self-hosted", ["api:keys:admin"]);
    const response = await worker.fetch(f.request("/api/api-keys", a.token, "GET", true), f.env);
    expect(response.status).toBe(200);
    const body = await response.json() as { keys: { orgId: string }[] };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]?.orgId).toBe("org-a");
  });

  it("never upgrades an explicit bearer using ambient dashboard or loopback authorization", async () => {
    const f = fixture();
    const { token } = await f.key();
    const scoped = await resolveOrgForApiRequest(f.request("/api/org/model-keys", token, "GET", true), f.env);
    expect(scoped).toMatchObject({ orgId: "org-a", principal: { scopes: ["api:read"] } });
    const res = await worker.fetch(f.request("/api/api-keys", token, "POST", true), f.env);
    expect(res.status).toBe(403);
    for (const url of ["https://worker.test/api/org/model-keys", "http://localhost/api/org/model-keys"]) {
      const request = new Request(url, {
        headers: { authorization: "Bearer invalid", "CF-Access-Authenticated-User-Email": "owner@example.com" },
      });
      const auth = await resolveOrgForApiRequest(request, f.env);
      expect(auth).toBeInstanceOf(Response);
      expect((auth as Response).status).toBe(401);
    }
    expect(await authorizeV1Request(new Request("http://localhost/api/v1/capabilities", {
      headers: { authorization: "Basic invalid", "CF-Access-Authenticated-User-Email": "owner@example.com" },
    }), f.env)).toBeNull();
  });

  it("keeps unrelated dashboard and shared run surfaces behind their existing identity gate", async () => {
    const f = fixture();
    const { token } = await f.key();
    for (const path of ["/api/runs", "/api/v1/threads", "/api/memory/facts", "/api/custom-agents-extra", "/api/skills", "/api/skills/library-extra", "/api/spaces-extra"]) {
      expect((await worker.fetch(f.request(path, token), f.env)).status, path).toBe(401);
    }
  });

  it("fails closed for bearer runtime access even with loopback or ambient dashboard authorization", async () => {
    const f = fixture();
    const { token } = await f.key("org-a", ["api:read", "api:write"]);
    for (const path of ["/api/v1/threads", "/api/v1/events", "/api/v1/usage", "/api/v1/projects/acme%2Frepo/automations"]) {
      for (const origin of ["http://localhost", "https://worker.test"]) {
        const request = new Request(`${origin}${path}`, {
          headers: { authorization: `Bearer ${token}`, "CF-Access-Authenticated-User-Email": "owner@example.com" },
        });
        const response = await worker.fetch(request, f.env);
        expect(response.status, `${origin}${path}`).toBe(501);
        expect(await response.json()).toMatchObject({ error: "tenant_runtime_unavailable" });
      }
    }
    expect(f.bindings).toEqual([]);
  });
});

describe("v1 dispatcher scope enforcement", () => {
  it.each([
    ["POST", "/api/v1/threads/r1/stop", ["api:read"]],
    ["POST", "/api/v1/threads/r1/retry", ["api:read"]],
    ["PATCH", "/api/v1/threads/r1", ["api:read"]],
    ["POST", "/api/v1/projects/acme%2Frepo/automations", ["api:read"]],
    ["GET", "/api/v1/threads/r1/runs", ["api:keys:admin"]],
    ["GET", "/api/v1/capabilities", ["api:write"]],
  ])("rejects %s %s before any storage access", async (method, path, scopes) => {
    const resolveTarget = vi.fn();
    const getStub = vi.fn();
    const response = await handleV1(new Request(`https://worker.test${path}`, { method: method as string }), {} as Env, {
      authorize: async () => ({ principal: "ci", orgId: "org-a", scopes: scopes as Scope[] }),
      resolveTarget,
      getStub,
    });
    expect(response?.status).toBe(403);
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(getStub).not.toHaveBeenCalled();
  });

  it("allows a write-scoped grouped stop command to reach its run store", async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ run: {
      runId: "r1", task: "Fix", repoUrl: "https://github.com/acme/repo", status: request.method === "DELETE" ? "cancelled" : "running",
      createdAt: 1, updatedAt: 2,
    } }));
    const response = await handleV1(new Request("https://worker.test/api/v1/threads/r1/stop", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: "r1" }),
    }), {} as Env, {
      authorize: async () => ({ principal: "ci", orgId: "org-a", scopes: ["api:write"] }),
      resolveTarget: async () => ({ agentName: "scoped-test", userId: "ci" }),
      getStub: async () => ({ fetch }),
    });
    expect(response?.status).toBe(202);
    expect(fetch.mock.calls.some(([request]) => request.method === "DELETE")).toBe(true);
  });
});
