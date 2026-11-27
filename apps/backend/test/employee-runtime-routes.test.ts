import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleCustomAgents } from "../src/custom-agents-routes.js";
import { handleEmployeeRuntimeRequest } from "../src/employee-runtime-routes.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const authState = vi.hoisted(() => ({ dashboard: false, userId: "owner@example.test" }));

vi.mock("../src/request-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: vi.fn(async () => authState.dashboard),
  resolveUserId: vi.fn(async () => authState.dashboard ? authState.userId : null),
}));

function runtimeEnv(calls: Array<{ url: string; init?: RequestInit }>): Env {
  const namespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        const body = init?.body ? JSON.parse(String(init.body)) as { conversationId?: string } : {};
        const conversationId = body.conversationId ?? new URL(String(input)).searchParams.get("conversationId") ?? undefined;
        return Response.json({ ok: true, ...(conversationId ? { conversationId } : {}) }, { headers: { "x-runtime-stub": "1" } });
      },
    }),
  };
  return {
    AGENT_AUDIT: customAgentD1().database,
    SHIBA_SANDBOX_PROVIDER: "cloudflare",
    Sandbox: {} as unknown,
    AGENT_HARNESS: "opencode",
    EmployeeRuntime: namespace as unknown as DurableObjectNamespace,
  } as unknown as Env;
}

function post(path: string, body: unknown): Request {
  return new Request(`https://x/api/custom-agents${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://x" },
    body: JSON.stringify(body),
  });
}

describe("employee runtime routes", () => {
  beforeEach(() => {
    authState.dashboard = true;
    authState.userId = "owner@example.test";
  });

  it("forwards a server-owned frozen employee profile without harness authority", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = runtimeEnv(calls);
    const agent = await createCustomAgent(env, "self-hosted", "scout", {
      name: "Scout", instructions: "Answer carefully.", harness: "opencode", codingModel: "harness-model", model: "@cf/test/employee-model",
    });
    const response = await handleCustomAgents(post(`/${agent.id}/runtime/chat`, {
      conversationId: "default", message: "hello", profile: { name: "caller-forged" },
    }), env);

    expect(response?.status).toBe(200);
    expect(response?.headers.get("x-runtime-stub")).toBe("1");
    expect(calls[0]?.url).toBe("https://internal/internal/employee-runtime/chat");
    const forwarded = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(forwarded).not.toHaveProperty("profile.name", "caller-forged");
    expect(forwarded.profile).toMatchObject({
      orgId: "self-hosted", employeeId: agent.id, employeeVersion: 1,
      name: "Scout", instructions: "Answer carefully.",
    });
    expect(forwarded.profile).toMatchObject({ model: "@cf/test/employee-model" });
    expect(forwarded.profile).not.toHaveProperty("harness");
    expect(forwarded.profile).not.toHaveProperty("codingModel");
    expect(forwarded.conversationId).toMatch(/^u_[a-f0-9]{32}_[A-Za-z0-9_-]+$/);
    expect(forwarded.conversationId).not.toBe("default");
  });

  it("gives different authenticated actors different private conversation namespaces", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = runtimeEnv(calls);
    const agent = await createCustomAgent(env, "self-hosted", "private-scout", { name: "Scout", instructions: "Answer carefully." });
    await handleCustomAgents(post(`/${agent.id}/runtime/chat`, { conversationId: "default", message: "hello" }), env);
    authState.userId = "teammate@example.test";
    await handleCustomAgents(post(`/${agent.id}/runtime/chat`, { conversationId: "default", message: "hello" }), env);
    const first = JSON.parse(String(calls[0]?.init?.body)) as { conversationId: string };
    const second = JSON.parse(String(calls[1]?.init?.body)) as { conversationId: string };
    expect(first.conversationId).not.toBe(second.conversationId);
  });

  it("rejects invalid chat input before touching the runtime object", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = runtimeEnv(calls);
    const agent = await createCustomAgent(env, "self-hosted", "scout", { name: "Scout", instructions: "Answer carefully.", harness: "opencode" });
    const response = await handleCustomAgents(post(`/${agent.id}/runtime/chat`, { message: "" }), env);
    expect(response?.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("keeps runtime access scoped to the employee organization", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = runtimeEnv(calls);
    const foreign = await createCustomAgent(env, "org-a", "scout", { name: "Scout", instructions: "Answer carefully.", harness: "opencode" });
    const response = await handleCustomAgents(post(`/${foreign.id}/runtime/chat`, { message: "hello" }), env);
    expect(response?.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("rejects unknown runtime suffixes instead of falling through to profile mutation", async () => {
    const env = runtimeEnv([]);
    const agent = await createCustomAgent(env, "self-hosted", "scout", { name: "Scout", instructions: "Answer carefully.", harness: "opencode" });
    const response = await handleCustomAgents(post(`/${agent.id}/runtime/unknown`, { message: "hello" }), env);
    expect(response?.status).toBe(404);
  });
  it("fails closed for unfunded team workspace inference", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = runtimeEnv(calls);
    const agent = await createCustomAgent(env, "team:ws_aaaaaaaaaaaaaaaaaaaaaaaa", "scout", { name: "Scout", instructions: "Answer carefully." });
    const response = await handleEmployeeRuntimeRequest(
      post(`/${agent.id}/runtime/chat`, { message: "hello" }),
      env,
      { orgId: "team:ws_aaaaaaaaaaaaaaaaaaaaaaaa", principal: null },
      agent.id,
      "chat",
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "employee_runtime_funding_required" });
    expect(calls).toEqual([]);
  });
  it("returns client conversation ids while storing actor-scoped ids internally", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = runtimeEnv(calls);
    const agent = await createCustomAgent(env, "self-hosted", "stateful-scout", { name: "Scout", instructions: "Answer carefully." });
    const response = await handleEmployeeRuntimeRequest(
      new Request(`https://x/api/custom-agents/${agent.id}/runtime/state?conversationId=client-thread`),
      env,
      { orgId: "self-hosted", principal: null },
      agent.id,
      "state",
    );
    expect(await response.json()).toMatchObject({ conversationId: "client-thread" });
    expect(calls[0]?.url).toBe("https://internal/internal/employee-runtime/recover");
    expect(new URL(calls[1]!.url).searchParams.get("conversationId")).toMatch(/^u_[a-f0-9]{32}_[A-Za-z0-9_-]+$/);
  });

  it("does not trigger recovery inference when reading an archived employee", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = runtimeEnv(calls);
    const agent = await createCustomAgent(env, "self-hosted", "archived-state-scout", { name: "Scout", instructions: "Answer carefully." });
    await env.AGENT_AUDIT.prepare(`UPDATE org_custom_agents SET archived_at=? WHERE org_id=? AND id=?`).bind(1, "self-hosted", agent.id).run();
    const response = await handleEmployeeRuntimeRequest(
      new Request(`https://x/api/custom-agents/${agent.id}/runtime/state?conversationId=client-thread`),
      env,
      { orgId: "self-hosted", principal: null },
      agent.id,
      "state",
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).not.toBe("https://internal/internal/employee-runtime/recover");
    expect(new URL(calls[0]!.url).searchParams.get("conversationId")).toMatch(/^u_[a-f0-9]{32}_[A-Za-z0-9_-]+$/);
  });

  it("separates conversations for distinctly issued API keys with the same principal", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = runtimeEnv(calls);
    const agent = await createCustomAgent(env, "self-hosted", "keyed-scout", { name: "Scout", instructions: "Answer carefully." });
    for (const keyId of ["key-one", "key-two"]) {
      await handleEmployeeRuntimeRequest(post(`/${agent.id}/runtime/chat`, { conversationId: "default", message: "hello" }), env, {
        orgId: "self-hosted",
        principal: { principal: "owner@example.test", orgId: "self-hosted", scopes: ["api:write"], apiKey: { principal: "owner@example.test", scopes: ["api:write"], created: 1, revoked: false, keyId } },
      }, agent.id, "chat");
    }
    const first = JSON.parse(String(calls[0]?.init?.body)) as { conversationId: string };
    const second = JSON.parse(String(calls[1]?.init?.body)) as { conversationId: string };
    expect(first.conversationId).not.toBe(second.conversationId);
  });
  it("accepts maximum-length client conversation ids", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = runtimeEnv(calls);
    const agent = await createCustomAgent(env, "self-hosted", "long-thread", { name: "Scout", instructions: "Answer carefully." });
    const conversationId = "x".repeat(128);
    const response = await handleCustomAgents(post(`/${agent.id}/runtime/chat`, { conversationId, message: "hello" }), env);
    expect(response?.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
  it("forwards streaming chat to the streaming runtime endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = runtimeEnv(calls);
    const agent = await createCustomAgent(env, "self-hosted", "stream-scout", { name: "Scout", instructions: "Answer carefully." });
    const response = await handleCustomAgents(post(`/${agent.id}/runtime/chat/stream`, { conversationId: "private-thread", message: "stream hello" }), env);
    expect(response?.status).toBe(200);
    expect(calls[0]?.url).toBe("https://internal/internal/employee-runtime/chat/stream");
  });

  it("scopes conversation clearing before forwarding it", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = runtimeEnv(calls);
    const agent = await createCustomAgent(env, "self-hosted", "clear-scout", { name: "Scout", instructions: "Answer carefully." });
    const response = await handleCustomAgents(post(`/${agent.id}/runtime/clear`, { conversationId: "private-thread" }), env);
    expect(response?.status).toBe(200);
    expect(calls[0]?.url).toBe("https://internal/internal/employee-runtime/clear");
    const forwarded = JSON.parse(String(calls[0]?.init?.body)) as { conversationId: string };
    expect(forwarded.conversationId).toMatch(/^u_[a-f0-9]{32}_[A-Za-z0-9_-]+$/);
    expect(forwarded.conversationId).not.toBe("private-thread");
  });

  it("allows clearing runtime history for an archived employee", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = runtimeEnv(calls);
    const agent = await createCustomAgent(env, "self-hosted", "archived-clear-scout", { name: "Scout", instructions: "Answer carefully." });
    await env.AGENT_AUDIT.prepare(`UPDATE org_custom_agents SET archived_at=? WHERE org_id=? AND id=?`).bind(1, "self-hosted", agent.id).run();
    const response = await handleCustomAgents(post(`/${agent.id}/runtime/clear`, { conversationId: "private-thread" }), env);
    expect(response?.status).toBe(200);
    expect(calls[0]?.url).toBe("https://internal/internal/employee-runtime/clear");
  });

  it("scopes thread memory mutations before forwarding them", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const env = runtimeEnv(calls);
    const agent = await createCustomAgent(env, "self-hosted", "memory-scout", { name: "Scout", instructions: "Answer carefully." });
    const response = await handleCustomAgents(post(`/${agent.id}/runtime/memory/update`, {
      memoryId: "mem_1", conversationId: "private-thread", content: "Updated fact",
    }), env);
    expect(response?.status).toBe(200);
    expect(calls[0]?.url).toBe("https://internal/internal/employee-runtime/memory/update");
    const forwarded = JSON.parse(String(calls[0]?.init?.body)) as { conversationId: string };
    expect(forwarded.conversationId).toMatch(/^u_[a-f0-9]{32}_[A-Za-z0-9_-]+$/);
    expect(forwarded.conversationId).not.toBe("private-thread");
  });

});
