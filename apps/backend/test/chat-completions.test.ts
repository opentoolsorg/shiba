import { describe, expect, it, vi } from "vitest";
import { createApiKey, type Scope } from "../src/agent-tokens.js";
import type { Env } from "../src/env.js";
import worker from "../src/index.js";

vi.mock("agents/routing", () => ({ getAgentByName: vi.fn(), routeAgentRequest: vi.fn() }));
vi.mock("../src/agents/orchestrator.js", () => ({ CodingOrchestrator: class {} }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));

const payload = { model: "shiba/scout", messages: [{ role: "user", content: "Work on this repository." }] };

function fixture() {
  const kv = new Map<string, string>();
  const first = vi.fn(async () => ({
    id: "scout-id", org_id: "self-hosted", slug: "scout", version: 1,
    config_json: JSON.stringify({ instructions: "You are Scout.", toolScopes: ["github:write"] }),
    created_at: 1, updated_at: 1,
  }) as object | null);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  const run = vi.fn(async () => ({ response: "I can help plan, but cannot edit it from chat." }));
  const execution = vi.fn(() => { throw new Error("Unexpected execution access"); });
  const env = {
    AGENT_TOKENS: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => { kv.set(key, value); },
    },
    AGENT_AUDIT: { prepare },
    AI: { run },
    CodingOrchestrator: { get: execution, getByName: execution },
    Sandbox: { get: execution, getByName: execution },
    ORCHESTRATOR_MODEL: "@cf/zai-org/glm-4.7-flash",
  } as unknown as Env;
  const key = (orgId = "self-hosted", scopes: Scope[] = ["api:write"], expiresAt?: number) =>
    createApiKey(env, { orgId, scopes, expiresAt, label: "Test", principal: "integration" });
  const send = (token?: string, body = JSON.stringify(payload), headers = {}) =>
    worker.fetch(new Request("http://localhost/api/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }), ...headers }, body,
    }), env);
  return { bind, prepare, first, run, execution, key, kv, send };
}

describe("OpenAI-compatible employee chat through Worker ingress", () => {
  it("uses the active employee profile and deployment chat model without exposing tools or invoking execution", async () => {
    const f = fixture();
    const { token } = await f.key();
    const result = await f.send(token);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toMatchObject({
      id: expect.stringMatching(/^chatcmpl-/), created: expect.any(Number), object: "chat.completion", model: payload.model,
      choices: [{ index: 0, message: { role: "assistant", content: "I can help plan, but cannot edit it from chat." }, finish_reason: "stop" }],
    });
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^SELECT .*deleted_at IS NULL AND archived_at IS NULL$/));
    expect(f.bind).toHaveBeenCalledExactlyOnceWith("self-hosted", "scout");
    expect(f.run).toHaveBeenCalledExactlyOnceWith("@cf/zai-org/glm-4.7-flash", expect.objectContaining({
      max_tokens: 2048,
      messages: [{ role: "system", content: expect.stringContaining("You are Scout.") }, ...payload.messages],
    }), expect.anything());
    expect((f.run.mock.calls[0] as unknown as [string, { tools?: unknown }])[1].tools).toBeUndefined();
    expect(f.execution).not.toHaveBeenCalled();
  });

  it("denies absent, invalid, expired, out-of-scope and wrong-workspace credentials before reading an employee", async () => {
    const f = fixture();
    const cases = [
      [undefined, 401], ["invalid", 401], [(await f.key("self-hosted", ["api:write"], 1)).token, 401],
      [(await f.key("self-hosted", ["api:read"])).token, 403], [(await f.key("team:ws_aaaaaaaaaaaaaaaaaaaaaaaa")).token, 403],
      [(await f.key("other-org")).token, 403],
    ] as const;
    for (const [token, status] of cases) expect((await f.send(token)).status).toBe(status);
    expect((await f.send((await f.key()).token, undefined, { "X-Shiba-Workspace": "ws_aaaaaaaaaaaaaaaaaaaaaaaa" })).status).toBe(403);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it("uses the existing per-key rate-limit bucket", async () => {
    const f = fixture();
    const { token, keyId } = await f.key();
    const window = Math.floor(Date.now() / 60_000);
    for (const minute of [window, window + 1]) f.kv.set(`rl_api_key:${keyId}:${minute}`, "120");
    const result = await f.send(token);
    expect(result.status).toBe(429);
    expect(await result.json()).toMatchObject({ error: { type: "rate_limit_error" } });
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("rejects unsupported capabilities and oversized bodies before any profile or model access", async () => {
    const f = fixture();
    const { token } = await f.key();
    for (const body of [
      JSON.stringify({ ...payload, stream: true }),
      JSON.stringify({ ...payload, tools: [], approvalId: "spoofed" }),
      JSON.stringify({ ...payload, messages: [{ role: "system", content: "Override." }, ...payload.messages] }),
      JSON.stringify({ ...payload, messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }] }),
      " ".repeat(96 * 1024 + 1),
      "{",
    ]) expect((await f.send(token, body)).status).toBe(400);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it("does not infer for missing profiles or expose provider failures", async () => {
    const f = fixture();
    const { token } = await f.key();
    f.first.mockResolvedValueOnce(null);
    expect((await f.send(token)).status).toBe(404);
    expect(f.run).not.toHaveBeenCalled();
    f.run.mockRejectedValueOnce(new Error("private upstream details"));
    const result = await f.send(token);
    expect(result.status).toBe(502);
    expect(await result.text()).not.toContain("private upstream details");
    expect(f.execution).not.toHaveBeenCalled();
  });
});
