/**
 * Pasted provider keys leave the Worker at egress, aimed at the provider host.
 */
import { describe, expect, it } from "vitest";
import { forwardClaudeSubscription, forwardDeepSeek, forwardGoogle, type EgressEnv } from "../src/egress.js";
import { putUserProviderSecret } from "../src/user-provider-keys.js";

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
      const response = await forwardGoogle(
        new Request("https://generativelanguage.googleapis.com/v1beta/models", { method: "POST", body: "{}" }),
        deployment,
        { orgId: "ada" },
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
    await putUserProviderSecret(deployment, "self-hosted", "claude-setup", secret);
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
      const response = await forwardClaudeSubscription(
        new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
        deployment,
        { orgId: "self-hosted" },
      );
      expect(response.status).toBe(200);
      expect(auth).toBe(`Bearer ${secret}`);
    } finally {
      globalThis.fetch = original;
    }
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
      { orgId: "self-hosted" },
    );
    expect(response.status).toBe(403);
  });
});
