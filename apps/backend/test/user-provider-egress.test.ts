/**
 * Pasted provider keys leave the Worker at egress, aimed at the provider host.
 */
import { describe, expect, it } from "vitest";
import { forwardClaudeSubscription, forwardCursorSubscription, forwardDeepSeek, type EgressEnv } from "../src/egress.js";
import { dispatchOutboundRequest } from "../src/sandbox/outbound-dispatch.js";
import { loadOutboundConfig } from "../src/sandbox/outbound-config.js";
import { putUserProviderSecret, readProviderSecretForOrg } from "../src/user-provider-keys.js";

class FakeKV {
  readonly map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
  async delete(key: string) {
    this.map.delete(key);
  }
}

const KEY = "ab".repeat(32);

function env(kv: FakeKV): EgressEnv {
  return {
    AGENT_TOKENS: kv,
    MODEL_CREDENTIAL_KEY: KEY,
    AI: {
      gateway: () => ({
        getUrl: async () => {
          throw new Error("gateway should not be called");
        },
      }),
    },
  } as unknown as EgressEnv;
}

describe("user provider key egress", () => {
  it("refuses the deployment Cursor token when an initiator is present", async () => {
    const deployment = { ...env(new FakeKV()), CURSOR_SUBSCRIPTION_TOKEN: crypto.randomUUID() };
    const response = await forwardCursorSubscription(new Request("https://api2.cursor.sh/models"), deployment, {
      initiatorUserId: "alice",
    });
    expect(response.status).toBe(503);
  });
  it("round trips an encrypted OpenRouter key only through its approved host and owner", async () => {
    const kv = new FakeKV();
    const deployment = env(kv);
    const secret = crypto.randomUUID();
    await putUserProviderSecret(deployment, "ada", "openrouter", secret);
    expect([...kv.map.values()].some((value) => value === secret)).toBe(false);
    let attached = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      attached = new Headers(init?.headers).get("authorization") === `Bearer ${secret}`;
      return new Response("ok");
    }) as typeof fetch;
    try {
      const config = loadOutboundConfig({
        orgId: "workspace", initiatorUserId: "ada", allowedHosts: ["openrouter.ai"],
        outboundByHost: { "openrouter.ai": { kind: "builtin", host: "openrouter.ai" } },
      });
      expect((await dispatchOutboundRequest(new Request("https://openrouter.ai/api/v1/chat/completions"), deployment, config)).status).toBe(200);
      expect(attached).toBe(true);
      expect((await dispatchOutboundRequest(new Request("https://api.groq.com/openai/v1/models"), deployment, config)).status).toBe(403);
      attached = false;
      expect((await dispatchOutboundRequest(new Request("https://openrouter.ai/api/v1/models"), deployment, { ...config, initiatorUserId: "bob" })).status).toBe(503);
      expect(attached).toBe(false);
    } finally { globalThis.fetch = original; }
  });

  it.each([
    ["kimi", "api.kimi.ai", "/coding/v1/chat/completions"],
    ["meta", "api.meta.ai", "/v1/chat/completions"],
    ["deepseek", "api.deepseek.com", "/v1/chat/completions"],
    ["zai", "api.z.ai", "/api/paas/v4/chat/completions"],
    ["minimax", "api.minimax.io", "/v1/chat/completions"],
    ["qwen", "dashscope-intl.aliyuncs.com", "/compatible-mode/v1/chat/completions"],
    ["mistral", "api.mistral.ai", "/v1/chat/completions"],
  ] as const)("attaches a saved %s plan key at %s and never the container placeholder", async (kind, host, path) => {
    const kv = new FakeKV();
    const deployment = env(kv);
    const secret = crypto.randomUUID();
    await putUserProviderSecret(deployment, "ada", kind, secret);
    expect([...kv.map.values()].some((value) => value === secret)).toBe(false);
    let seen: { url?: string; auth?: string | null } = {};
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), auth: new Headers(init?.headers).get("authorization") };
      return new Response("ok");
    }) as typeof fetch;
    try {
      const config = loadOutboundConfig({
        orgId: "workspace", initiatorUserId: "ada", allowedHosts: [host],
        outboundByHost: { [host]: { kind: "builtin", host } },
      });
      const request = new Request(`https://${host}${path}`, {
        method: "POST", body: "{}", headers: { authorization: "Bearer shiba-egress-placeholder" },
      });
      expect((await dispatchOutboundRequest(request, deployment, config)).status).toBe(200);
      expect(seen.url).toBe(`https://${host}${path}`);
      expect(seen.auth).toBe(`Bearer ${secret}`);
      seen = {};
      const other = await dispatchOutboundRequest(new Request(`https://${host}${path}`, { method: "POST", body: "{}" }), deployment, { ...config, initiatorUserId: "bob" });
      expect(other.status).toBe(503);
      expect(seen.auth).toBeUndefined();
    } finally { globalThis.fetch = original; }
  });

  it("sends a saved Gemini key to Google and not the gateway", async () => {
    const kv = new FakeKV();
    const deployment = env(kv);
    const secret = "AIza-test-key-value";
    await putUserProviderSecret(deployment, "ada", "google", secret);
    let seen: { url?: string; key?: string | null } = {};
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), key: new Headers(init?.headers).get("x-goog-api-key") };
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const response = await dispatchOutboundRequest(
        new Request("https://generativelanguage.googleapis.com/v1beta/models", { method: "POST", body: "{}" }),
        deployment,
        loadOutboundConfig({
          orgId: "self-hosted", initiatorUserId: "ada",
          allowedHosts: ["generativelanguage.googleapis.com"],
          outboundByHost: { "generativelanguage.googleapis.com": { kind: "builtin", host: "generativelanguage.googleapis.com" } },
        }),
      );
      expect(response.status).toBe(200);
      expect(seen.url).toContain("generativelanguage.googleapis.com");
      expect(seen.key).toBe(secret);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses DeepSeek with a neutral message when no key is saved", async () => {
    const response = await forwardDeepSeek(
      new Request("https://api.deepseek.com/chat/completions", { method: "POST", body: "{}" }),
      env(new FakeKV()),
    );
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toMatch(/Paste one/i);
    expect(text).not.toContain("AI_GATEWAY_TOKEN");
  });

  it("attaches a saved Claude setup token on the subscription branch", async () => {
    const kv = new FakeKV();
    const deployment = env(kv);
    const secret = "sk-ant-setup-token-value";
    await putUserProviderSecret(deployment, "ada", "claude-setup", secret);
    await kv.put(
      "auth_flow_claude-sub:default",
      JSON.stringify({ phase: "succeeded", ownerSessionId: "self-hosted" }),
    );
    let auth: string | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const response = await dispatchOutboundRequest(
        new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
        deployment,
        loadOutboundConfig({
          orgId: "self-hosted", initiatorUserId: "ada",
          allowedHosts: ["api.anthropic.com"],
          outboundByHost: { "api.anthropic.com": { kind: "named", handler: "claudeSubscription" } },
        }),
      );
      expect(response.status).toBe(200);
      expect(auth).toBe(`Bearer ${secret}`);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("never substitutes a worker Claude token for a missing or disconnected personal token", async () => {
    const kv = new FakeKV();
    const deployment = { ...env(kv), CLAUDE_SUBSCRIPTION_TOKEN: crypto.randomUUID() };
    await kv.put("auth_flow_claude-sub:default", JSON.stringify({ phase: "succeeded" }));
    const original = globalThis.fetch;
    let sent = false;
    globalThis.fetch = (async () => { sent = true; return new Response("ok"); }) as typeof fetch;
    try {
      const response = await forwardClaudeSubscription(new Request("https://api.anthropic.com/v1/messages"), deployment, {
        orgId: "self-hosted", initiatorUserId: "bob",
      });
      expect(response.status).toBe(503);
      expect(sent).toBe(false);
      await putUserProviderSecret(deployment, "bob", "claude-setup", crypto.randomUUID());
      await kv.put("auth_flow_claude-sub:default", JSON.stringify({ phase: "cleared" }));
      expect((await forwardClaudeSubscription(new Request("https://api.anthropic.com/v1/messages"), deployment, {
        orgId: "self-hosted", initiatorUserId: "bob",
      })).status).toBe(200);
    } finally { globalThis.fetch = original; }
  });

  it("refuses Claude subscription egress after the auth flow is cleared", async () => {
    const kv = new FakeKV();
    const deployment = env(kv);
    await kv.put(
      "auth_flow_claude-sub:default",
      JSON.stringify({ phase: "cleared", ownerSessionId: null, generation: 2 }),
    );
    await putUserProviderSecret(deployment, "self-hosted", "claude-setup", "sk-ant-setup-token-value");
    const response = await forwardClaudeSubscription(
      new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
      deployment,
      undefined,
    );
    expect(response.status).toBe(403);
  });
  it("does not let a self-hosted initiator read another user's personal key", async () => {
    const deployment = env(new FakeKV());
    await putUserProviderSecret(deployment, "alice", "google", "AIza-alice-private-key");
    expect(await readProviderSecretForOrg(deployment, "self-hosted", "google", "bob")).toBeNull();
    expect(await readProviderSecretForOrg(deployment, "self-hosted", "google", "alice")).toBe("AIza-alice-private-key");
  });

});
