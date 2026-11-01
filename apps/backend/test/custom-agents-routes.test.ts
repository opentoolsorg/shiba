import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleCustomAgents } from "../src/custom-agents-routes.js";
import { handleOrgSandboxSettings } from "../src/org-sandbox-routes.js";
import { createCustomAgent, getCustomAgentById } from "../src/custom-agents-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

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

describe("custom agent archive and version HTTP contracts", () => {
  const config = { name: "Scout", instructions: "Read before changing code.", harness: "opencode" };
  const request = (path: string, method = "GET", body?: unknown) => new Request(`https://x/api/custom-agents${path}`, {
    method, headers: { "content-type": "application/json", ...(authState.principal ? { authorization: "Bearer api-key" } : { origin: "https://x" }) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  it("allows API-key writes without Origin but requires Origin for ambient sessions", async () => {
    const bindings = env();
    authState.principal = { principal: "writer", orgId: "org-a", scopes: ["api:read", "api:write"] };
    const created = await handleCustomAgents(request("", "POST", { slug: "api-scout", config }), bindings);
    expect(created?.status).toBe(201);
    authState.principal = null;
    authState.dashboard = true;
    const denied = await handleCustomAgents(new Request("https://x/api/custom-agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: "browser-scout", config }) }), bindings);
    expect(denied?.status).toBe(403);
  });

  it("archives/restores a profile independently from its retained configuration and history", async () => {
    authState.dashboard = true;
    const bindings = env();
    const created = await createCustomAgent(bindings, "self-hosted", "scout", config);
    const archive = await handleCustomAgents(request(`/${created.id}/archive`, "POST"), bindings);
    expect(archive?.status).toBe(200);
    expect(await archive?.json()).toMatchObject({ agent: { id: created.id, version: 1, archivedAt: expect.any(Number), config } });
    expect(await (await handleCustomAgents(request(""), bindings))?.json()).toMatchObject({ agents: [] });
    expect(await (await handleCustomAgents(request("?archived=true"), bindings))?.json()).toMatchObject({ agents: [{ id: created.id, config }] });
    expect((await handleCustomAgents(request(`/${created.id}`), bindings))?.status).toBe(200);
    expect((await handleCustomAgents(request(`/${created.id}/restore`, "POST"), bindings))?.status).toBe(200);
    expect(await (await handleCustomAgents(request(""), bindings))?.json()).toMatchObject({ agents: [{ id: created.id, config }] });
    expect((await handleCustomAgents(request(`/${created.id}`, "DELETE"), bindings))?.status).toBe(200);
    expect((await handleCustomAgents(request(`/${created.id}/restore`, "POST"), bindings))?.status).toBe(404);
  });

  it("denies cross-org and read-only archive/restore requests", async () => {
    const bindings = env();
    const created = await createCustomAgent(bindings, "org-a", "scout", config);
    authState.principal = { principal: "foreign", orgId: "org-b", scopes: ["api:read", "api:write"] };
    for (const action of ["archive", "restore"]) {
      expect((await handleCustomAgents(request(`/${created.id}/${action}`, "POST"), bindings))?.status).toBe(404);
    }
    authState.principal = { principal: "reader", orgId: "org-a", scopes: ["api:read"] };
    expect((await handleCustomAgents(request(`/${created.id}/archive`, "POST"), bindings))?.status).toBe(403);
    expect(await getCustomAgentById(bindings, "org-a", created.id)).not.toBeNull();
  });

  it("requires POST for explicit lifecycle paths and validates archive filters", async () => {
    authState.dashboard = true;
    const bindings = env();
    for (const method of ["DELETE", "PATCH", "GET"]) {
      expect((await handleCustomAgents(request("/existing/archive", method), bindings))?.status).toBe(405);
    }
    expect((await handleCustomAgents(request("?archived=maybe"), bindings))?.status).toBe(400);
  });

  it("returns one success and one409 for racing edits to the same expectedVersion", async () => {
    authState.dashboard = true;
    const bindings = env();
    const created = await createCustomAgent(bindings, "self-hosted", "scout", config);
    const results = await Promise.all([
      handleCustomAgents(request(`/${created.id}`, "PATCH", { config: { ...config, name: "First" }, expectedVersion: 1 }), bindings),
      handleCustomAgents(request(`/${created.id}`, "PATCH", { config: { ...config, name: "Second" }, expectedVersion: 1 }), bindings),
    ]);
    expect(results.map((item) => item?.status).sort()).toEqual([200, 409]);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid expectedVersion %s before mutation", async (expectedVersion) => {
    authState.dashboard = true;
    const bindings = env();
    const created = await createCustomAgent(bindings, "self-hosted", "scout", config);
    expect((await handleCustomAgents(request(`/${created.id}`, "PATCH", { config, expectedVersion }), bindings))?.status).toBe(400);
    expect((await getCustomAgentById(bindings, "self-hosted", created.id))?.version).toBe(1);
  });

  it("rejects unsupported tool scopes without erasing legacy stored scopes", async () => {
    authState.dashboard = true;
    const bindings = env();
    const legacy = { ...config, toolScopes: ["browser:read"] };
    const created = await createCustomAgent(bindings, "self-hosted", "scout", legacy);
    const patch = await handleCustomAgents(request(`/${created.id}`, "PATCH", { config: legacy, expectedVersion: 1 }), bindings);
    expect(patch?.status).toBe(400);
    expect(await patch?.json()).toMatchObject({ error: "unsupported_tool_scopes" });
    expect((await getCustomAgentById(bindings, "self-hosted", created.id))?.config.toolScopes).toEqual(["browser:read"]);
    const create = await handleCustomAgents(request("", "POST", { slug: "other", config: legacy }), bindings);
    expect(create?.status).toBe(400);
    expect(await create?.json()).toMatchObject({ error: "unsupported_tool_scopes" });
  });
});

function env(): Env {
  return {
    AGENT_AUDIT: customAgentD1().database,
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
        headers: { authorization: "Bearer shk_a", "content-type": "application/json" },
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
