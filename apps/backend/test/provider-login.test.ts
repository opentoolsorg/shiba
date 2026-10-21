import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));

import { handleAcpProviders } from "../src/acp-provider-routes.js";
import type { Env } from "../src/env.js";
import { forwardAnthropic, forwardOpenAI } from "../src/egress.js";
import { createProviderLogin } from "../src/provider-login.js";

const KEY = "ab".repeat(32);

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

function deployment(kv: FakeKV): Env {
  return {
    AGENT_TOKENS: kv,
    MODEL_CREDENTIAL_KEY: KEY,
    AI: { gateway: () => ({ getUrl: async () => "https://gateway.example/v1" }) },
    GATEWAY_ID: "default",
  } as unknown as Env;
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("adapter subscription sign-in", () => {
  const kv = new FakeKV();
  let routes: Array<{ url: string; status: number; body: Record<string, unknown> }>;

  beforeEach(() => {
    kv.map.clear();
    routes = [];
  });

  function fetchImpl(): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const hit = routes.find((route) => url.startsWith(route.url));
      if (!hit) return new Response("missing", { status: 599 });
      return new Response(JSON.stringify(hit.body), { status: hit.status });
    }) as typeof fetch;
  }

  it("refuses subscription sign-in until MODEL_CREDENTIAL_KEY is set", async () => {
    const response = await handleAcpProviders(
      post("/api/providers/codex/connect", { mode: "oauth" }),
      { AGENT_TOKENS: kv } as unknown as Env,
      { login: createProviderLogin(fetchImpl()) },
    );
    expect(response?.status).toBe(503);
    const body = (await response?.json()) as { error: string };
    expect(body.error).toContain("MODEL_CREDENTIAL_KEY");
  });

  it("connects Codex after the device grant and keeps the access token out of the response", async () => {
    routes = [
      {
        url: "https://auth.openai.com/api/accounts/deviceauth/usercode",
        status: 200,
        body: { device_auth_id: "dev-1", user_code: "UPYX-F4F7", interval: 5 },
      },
    ];
    const login = createProviderLogin(fetchImpl());
    const startedResponse = await handleAcpProviders(
      post("/api/providers/codex/connect", { mode: "oauth" }),
      deployment(kv),
      { login },
    );
    expect(startedResponse?.status).toBe(200);
    const started = (await startedResponse?.json()) as {
      providers: Array<{ id: string; connection: { phase: string; userCode: string | null; verificationUri: string | null } }>;
    };
    const waiting = started.providers.find((provider) => provider.id === "codex")?.connection;
    expect(waiting?.phase).toBe("waiting");
    expect(waiting?.userCode).toBe("UPYX-F4F7");
    expect(waiting?.verificationUri).toBe("https://auth.openai.com/codex/device");

    routes = [
      {
        url: "https://auth.openai.com/api/accounts/deviceauth/token",
        status: 404,
        body: {},
      },
    ];
    const pending = await handleAcpProviders(
      post("/api/providers/codex/verify", { userCode: "UPYX-F4F7" }),
      deployment(kv),
      { login: createProviderLogin(fetchImpl()) },
    );
    const pendingBody = (await pending?.json()) as {
      providers: Array<{ id: string; connection: { phase: string; message: string | null } }>;
    };
    expect(pendingBody.providers.find((provider) => provider.id === "codex")?.connection.phase).toBe("waiting");

    routes = [
      {
        url: "https://auth.openai.com/api/accounts/deviceauth/token",
        status: 200,
        body: { authorization_code: "auth-code", code_verifier: "verifier" },
      },
      {
        url: "https://auth.openai.com/oauth/token",
        status: 200,
        body: { access_token: "access-canary", refresh_token: "refresh-canary", expires_in: 3600 },
      },
    ];
    const done = await handleAcpProviders(
      post("/api/providers/codex/verify", { userCode: "UPYX-F4F7" }),
      deployment(kv),
      { login: createProviderLogin(fetchImpl()) },
    );
    const doneBody = (await done?.json()) as {
      providers: Array<{ id: string; connection: { phase: string; authMode: string | null; message: string | null } }>;
    };
    const codex = doneBody.providers.find((provider) => provider.id === "codex");
    expect(codex?.connection.phase).toBe("connected");
    expect(codex?.connection.authMode).toBe("oauth");
    expect(JSON.stringify(doneBody)).not.toContain("access-canary");
    expect(JSON.stringify(doneBody)).not.toContain("refresh-canary");
    expect([...kv.map.values()].join("\n")).not.toContain("access-canary");

    const original = globalThis.fetch;
    let fetched = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      fetched = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer access-canary");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const response = await forwardOpenAI(
        new Request("https://api.openai.com/v1/responses", { method: "POST", body: "{}" }),
        deployment(kv),
      );
      expect(response.status).toBe(200);
      expect(fetched).toBe("https://api.openai.com/v1/responses");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("connects Claude from a pasted code#state and still allows API-key mode", async () => {
    routes = [
      {
        url: "https://api.anthropic.com/v1/oauth/token",
        status: 200,
        body: { access_token: "claude-access-canary", refresh_token: "claude-refresh-canary", expires_in: 3600 },
      },
    ];
    const env = deployment(kv);
    const startedResponse = await handleAcpProviders(
      post("/api/providers/claude/connect", { mode: "oauth" }),
      env,
      { login: createProviderLogin(fetchImpl()) },
    );
    const started = (await startedResponse?.json()) as {
      providers: Array<{ id: string; connection: { phase: string; userCode: string | null; verificationUri: string | null } }>;
    };
    const claude = started.providers.find((provider) => provider.id === "claude")?.connection;
    expect(claude?.phase).toBe("waiting");
    expect(claude?.userCode).toBeNull();
    const uri = new URL(claude?.verificationUri ?? "");
    expect(uri.origin + uri.pathname).toBe("https://claude.ai/oauth/authorize");
    const state = uri.searchParams.get("state");
    expect(state).toBeTruthy();

    const bad = await handleAcpProviders(
      post("/api/providers/claude/verify", { userCode: "code#wrong-state" }),
      env,
      { login: createProviderLogin(fetchImpl()) },
    );
    expect(bad?.status).toBe(400);

    const done = await handleAcpProviders(
      post("/api/providers/claude/verify", { userCode: `authcode#${state}` }),
      env,
      { login: createProviderLogin(fetchImpl()) },
    );
    const doneBody = (await done?.json()) as {
      providers: Array<{ id: string; connection: { phase: string } }>;
    };
    expect(doneBody.providers.find((provider) => provider.id === "claude")?.connection.phase).toBe("connected");
    expect(JSON.stringify(doneBody)).not.toContain("claude-access-canary");

    const original = globalThis.fetch;
    let authHeader = "";
    let beta = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authHeader = headers.get("Authorization") ?? "";
      beta = headers.get("anthropic-beta") ?? "";
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
      const forwarded = await forwardAnthropic(
        new Request("https://api.anthropic.com/v1/messages", { method: "POST", body: "{}" }),
        env,
      );
      expect(forwarded.status).toBe(200);
      expect(authHeader).toBe("Bearer claude-access-canary");
      expect(beta).toContain("oauth-2025-04-20");
    } finally {
      globalThis.fetch = original;
    }

    const keyed = await handleAcpProviders(
      post("/api/providers/gemini/connect", { mode: "api-key" }),
      { ...env, AI_GATEWAY_TOKEN: "gateway-canary" } as Env,
      { login: createProviderLogin(fetchImpl()) },
    );
    const keyedBody = (await keyed?.json()) as {
      providers: Array<{ id: string; connection: { phase: string; authMode: string | null } }>;
    };
    expect(keyedBody.providers.find((provider) => provider.id === "gemini")?.connection).toMatchObject({
      phase: "connected",
      authMode: "api-key",
    });
    expect(JSON.stringify(keyedBody)).not.toContain("gateway-canary");
  });
});
