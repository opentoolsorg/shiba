import { describe, expect, it } from "vitest";
import {
  type EgressEnv,
  forwardAnthropic,
  forwardGoogle,
  forwardOpenAI,
  forwardXAI,
} from "../src/egress.js";
import { dispatchOutboundRequest } from "../src/sandbox/outbound-dispatch.js";
import { defaultOutboundConfig } from "../src/sandbox/outbound-config.js";
import { setOrgModelKey } from "../src/org-model-keys-store.js";

describe("egress org model key injection", () => {
  const hexKey = "ab".repeat(32);

  class FakeD1 {
    private rows = new Map<string, Record<string, unknown>>();
    prepare(sql: string) {
      return {
        run: async () => ({ success: true, results: [], meta: {} }),
        bind: (...params: unknown[]) => ({
          run: async () => {
            if (sql.includes("INSERT INTO org_secrets")) {
              const [orgId, kind, name, cipher, last4, updatedAt] = params;
              this.rows.set(`${orgId}:${kind}:${name}`, {
                org_id: orgId,
                kind,
                name,
                cipher,
                last4,
                updated_at: updatedAt,
              });
            }
            return { success: true, results: [], meta: {} };
          },
          first: async <T>() => {
            if (sql.includes("FROM org_secrets")) {
              const [orgId, kind, name] = params;
              return (this.rows.get(`${orgId}:${kind}:${name}`) as T) ?? null;
            }
            return null;
          },
          all: async () => ({ success: true, results: [], meta: {} }),
        }),
      };
    }
  }

  function mockGatewayEnv(d1: FakeD1): EgressEnv {
    return {
      AI: {
        gateway: () => ({
          getUrl: async () => "https://gateway.example.com/v1",
        }),
      } as unknown as EgressEnv["AI"],
      GATEWAY_ID: "test-gw",
      AI_GATEWAY_TOKEN: "gw-token",
      MODEL_CREDENTIAL_KEY: hexKey,
      AGENT_AUDIT: d1 as unknown as D1Database,
    };
  }

  it("injects x-api-key for Anthropic when org has key", async () => {
    const d1 = new FakeD1();
    await setOrgModelKey(
      { AGENT_AUDIT: d1 as unknown as D1Database, MODEL_CREDENTIAL_KEY: hexKey },
      "org_anthropic",
      "anthropic",
      "sk-ant-test-org-key",
    );

    let capturedHeaders: Headers | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const env = mockGatewayEnv(d1);
      const req = new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-3-5-sonnet" }),
      });
      const res = await forwardAnthropic(req, env, { orgId: "org_anthropic" });
      expect(res.status).toBe(200);
      expect(capturedHeaders).not.toBeNull();
      expect(capturedHeaders!.get("x-api-key")).toBe("sk-ant-test-org-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("injects Authorization Bearer for OpenAI when org has key", async () => {
    const d1 = new FakeD1();
    await setOrgModelKey(
      { AGENT_AUDIT: d1 as unknown as D1Database, MODEL_CREDENTIAL_KEY: hexKey },
      "org_openai",
      "openai",
      "sk-openai-org-key",
    );

    let capturedHeaders: Headers | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const env = mockGatewayEnv(d1);
      const req = new Request("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o" }),
      });
      const res = await forwardOpenAI(req, env, { orgId: "org_openai" });
      expect(res.status).toBe(200);
      expect(capturedHeaders).not.toBeNull();
      expect(capturedHeaders!.get("authorization")).toBe("Bearer sk-openai-org-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("injects x-goog-api-key for Google when org has key", async () => {
    const d1 = new FakeD1();
    await setOrgModelKey(
      { AGENT_AUDIT: d1 as unknown as D1Database, MODEL_CREDENTIAL_KEY: hexKey },
      "org_google",
      "google",
      "AIzaSy-google-key",
    );

    let capturedHeaders: Headers | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const env = mockGatewayEnv(d1);
      const req = new Request("https://generativelanguage.googleapis.com/v1beta/models/gemini", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const res = await forwardGoogle(req, env, { orgId: "org_google" });
      expect(res.status).toBe(200);
      expect(capturedHeaders).not.toBeNull();
      expect(capturedHeaders!.get("x-goog-api-key")).toBe("AIzaSy-google-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("injects Authorization Bearer for xAI when org has key", async () => {
    const d1 = new FakeD1();
    await setOrgModelKey(
      { AGENT_AUDIT: d1 as unknown as D1Database, MODEL_CREDENTIAL_KEY: hexKey },
      "org_xai",
      "xai",
      "xai-test-key",
    );

    let capturedHeaders: Headers | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    try {
      const env = mockGatewayEnv(d1);
      const req = new Request("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      const res = await forwardXAI(req, env, { orgId: "org_xai" });
      expect(res.status).toBe(200);
      expect(capturedHeaders).not.toBeNull();
      expect(capturedHeaders!.get("authorization")).toBe("Bearer xai-test-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  async function forwardWith(d1: FakeD1, env: EgressEnv, orgId: string | undefined) {
    const calls: Headers[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Headers(init?.headers));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const req = new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: "{}",
      });
      const res = await forwardAnthropic(req, env, orgId ? { orgId } : undefined);
      return { res, calls };
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it("uses the gateway alias when the org has no key and never another org's key", async () => {
    const d1 = new FakeD1();
    await setOrgModelKey(
      { AGENT_AUDIT: d1 as unknown as D1Database, MODEL_CREDENTIAL_KEY: hexKey },
      "org_a",
      "anthropic",
      "sk-ant-org-a",
    );
    const other = await forwardWith(d1, mockGatewayEnv(d1), "org_b");
    expect(other.res.status).toBe(200);
    expect(other.calls[0]?.get("x-api-key")).toBeNull();

    const none = await forwardWith(d1, mockGatewayEnv(d1), undefined);
    expect(none.calls[0]?.get("x-api-key")).toBeNull();
  });

  it("fails closed when a stored org key cannot be decrypted", async () => {
    const d1 = new FakeD1();
    await setOrgModelKey(
      { AGENT_AUDIT: d1 as unknown as D1Database, MODEL_CREDENTIAL_KEY: hexKey },
      "org_a",
      "anthropic",
      "sk-ant-org-a",
    );
    const noKeyEnv = { ...mockGatewayEnv(d1), MODEL_CREDENTIAL_KEY: undefined } as EgressEnv;
    const missing = await forwardWith(d1, noKeyEnv, "org_a");
    expect(missing.res.status).toBe(502);
    expect(missing.calls).toHaveLength(0);

    const wrongKeyEnv = { ...mockGatewayEnv(d1), MODEL_CREDENTIAL_KEY: "cd".repeat(32) } as EgressEnv;
    const wrong = await forwardWith(d1, wrongKeyEnv, "org_a");
    expect(wrong.res.status).toBe(502);
    expect(wrong.calls).toHaveLength(0);
  });

  it("dispatch hands the config's orgId to the forwarder", async () => {
    const d1 = new FakeD1();
    await setOrgModelKey(
      { AGENT_AUDIT: d1 as unknown as D1Database, MODEL_CREDENTIAL_KEY: hexKey },
      "org_a",
      "anthropic",
      "sk-ant-org-a",
    );
    const calls: Headers[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(new Headers(init?.headers));
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const config = defaultOutboundConfig();
      config.allowedHosts.push("api.anthropic.com");
      const req = () => new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" });
      await dispatchOutboundRequest(req(), mockGatewayEnv(d1), { ...config, orgId: "org_a" });
      await dispatchOutboundRequest(req(), mockGatewayEnv(d1), config);
      expect(calls[0]?.get("x-api-key")).toBe("sk-ant-org-a");
      expect(calls[1]?.get("x-api-key")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
