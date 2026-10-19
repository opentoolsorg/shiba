import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleCustomAgents } from "../src/custom-agents-routes.js";
import { handleOrgSandboxSettings } from "../src/org-sandbox-routes.js";

const authState = vi.hoisted(() => ({
  dashboard: false,
  principal: null as null | { principal: string; orgId: string; scopes: string[] },
}));

vi.mock("../src/request-auth.js", () => ({
  isAuthorizedRequest: vi.fn(async () => authState.dashboard),
}));

vi.mock("../src/v1-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/v1-auth.js")>();
  return {
    ...actual,
    authorizeV1Request: vi.fn(async () => authState.principal),
  };
});

function mockD1(): D1Database {
  const agents = new Map<string, Record<string, unknown>>();
  const settings = new Map<string, Record<string, unknown>>();
  const stmt = (sql: string, args: unknown[] = []) => ({
    async run() {
      if (sql.includes("CREATE TABLE") || sql.includes("audit_log") || sql.includes("CREATE INDEX")) {
        return { success: true };
      }
      if (sql.includes("INSERT INTO org_custom_agents")) {
        const id = String(args[0]);
        agents.set(id, {
          id,
          org_id: args[1],
          slug: args[2],
          version: 1,
          config_json: args[3],
          created_at: args[4],
          updated_at: args[5],
          deleted_at: null,
        });
      }
      if (sql.includes("INSERT INTO org_sandbox_settings")) {
        settings.set(String(args[0]), {
          org_id: args[0],
          provider_id: args[1],
          computesdk_backend: args[2],
          updated_at: args[3],
        });
      }
      return { success: true };
    },
    async first() {
      if (sql.includes("org_custom_agents") && sql.includes("id = ?")) {
        const row = agents.get(String(args[1]));
        if (!row || row.org_id !== args[0] || row.deleted_at != null) return null;
        return row;
      }
      if (sql.includes("org_sandbox_settings")) {
        return settings.get(String(args[0])) ?? null;
      }
      return null;
    },
    async all() {
      if (sql.includes("FROM org_custom_agents WHERE org_id")) {
        return {
          results: [...agents.values()].filter((r) => r.org_id === args[0] && r.deleted_at == null),
        };
      }
      return { results: [] };
    },
  });
  const prepare = (sql: string) => ({
    ...stmt(sql),
    bind(...args: unknown[]) {
      return stmt(sql, args);
    },
  });
  return { prepare } as unknown as D1Database;
}

function env(): Env {
  return {
    AGENT_AUDIT: mockD1(),
    SHIBA_SANDBOX_PROVIDER: "cloudflare",
    Sandbox: {} as unknown,
    AGENT_HARNESS: "opencode",
  } as Env;
}

beforeEach(() => {
  authState.dashboard = false;
  authState.principal = null;
});

describe("custom agents HTTP authz", () => {
  it("returns 403 when a read-only v1 key attempts create", async () => {
    authState.principal = { principal: "key-read", orgId: "org-a", scopes: ["api:read"] };
    const res = await handleCustomAgents(
      new Request("https://x/api/custom-agents", {
        method: "POST",
        headers: { authorization: "Bearer shk_test" },
        body: JSON.stringify({
          slug: "bot",
          config: { name: "Bot", instructions: "Hi", harness: "opencode" },
        }),
      }),
      env(),
    );
    expect(res?.status).toBe(403);
  });

  it("isolates custom agents by org on GET", async () => {
    authState.principal = { principal: "key-a", orgId: "org-a", scopes: ["api:read", "api:write"] };
    const createRes = await handleCustomAgents(
      new Request("https://x/api/custom-agents", {
        method: "POST",
        headers: { authorization: "Bearer shk_a" },
        body: JSON.stringify({
          slug: "scout",
          config: { name: "Scout", instructions: "Go", harness: "opencode" },
        }),
      }),
      env(),
    );
    const created = (await createRes?.json()) as { agent?: { id: string } };
    const agentId = created.agent?.id;
    expect(agentId).toBeTruthy();

    authState.principal = { principal: "key-b", orgId: "org-b", scopes: ["api:read", "api:write"] };
    const getRes = await handleCustomAgents(
      new Request(`https://x/api/custom-agents/${encodeURIComponent(agentId!)}`, {
        method: "GET",
        headers: { authorization: "Bearer shk_b" },
      }),
      env(),
    );
    expect(getRes?.status).toBe(404);

    const patchRes = await handleCustomAgents(
      new Request(`https://x/api/custom-agents/${encodeURIComponent(agentId!)}`, {
        method: "PATCH",
        headers: { authorization: "Bearer shk_b", "content-type": "application/json" },
        body: JSON.stringify({
          config: { name: "Hijack", instructions: "No", harness: "opencode" },
        }),
      }),
      env(),
    );
    expect(patchRes?.status).toBe(404);
  });
});

describe("org sandbox HTTP authz", () => {
  it("returns 403 when a read-only v1 key attempts PATCH", async () => {
    authState.principal = { principal: "key-read", orgId: "org-a", scopes: ["api:read"] };
    const res = await handleOrgSandboxSettings(
      new Request("https://x/api/org/sandbox", {
        method: "PATCH",
        headers: { authorization: "Bearer shk_test" },
        body: JSON.stringify({ providerId: "cloudflare" }),
      }),
      env(),
    );
    expect(res?.status).toBe(403);
  });

  it("stores sandbox settings per org", async () => {
    authState.principal = { principal: "key-a", orgId: "org-a", scopes: ["api:read", "api:write"] };
    const patch = await handleOrgSandboxSettings(
      new Request("https://x/api/org/sandbox", {
        method: "PATCH",
        headers: { authorization: "Bearer shk_a", "content-type": "application/json" },
        body: JSON.stringify({ providerId: "docker-local" }),
      }),
      env(),
    );
    expect(patch?.status).toBe(200);

    authState.principal = { principal: "key-b", orgId: "org-b", scopes: ["api:read"] };
    const getB = await handleOrgSandboxSettings(
      new Request("https://x/api/org/sandbox", { method: "GET", headers: { authorization: "Bearer shk_b" } }),
      env(),
    );
    const bodyB = (await getB?.json()) as { settings?: { providerId?: string } | null };
    expect(bodyB.settings).toBeNull();
  });
});
