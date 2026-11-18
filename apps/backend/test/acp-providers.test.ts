import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));

import type { AcpProvidersSnapshot } from "@shiba/shared";
import { handleAcpProviders } from "../src/acp-provider-routes.js";
import { ACP_PROVIDER_REGISTRY, acpAdapterPlan } from "../src/acp-providers.js";
import { handleSubscriptionAuth } from "../src/auth-routes.js";
import type { Env } from "../src/env.js";
import { readUserProviderSecret } from "../src/user-provider-keys.js";
import { ACP_LANES } from "../src/harness/index.js";

vi.mock("../../frontend/src/live-status", () => ({
  useModelConfig: () => ({
    state: {
      kind: "data",
      data: { connections: [], policy: { version: 1, models: {}, updatedAt: 0 }, purposes: [] },
    },
    reload: () => {},
    inFlight: false,
  }),
}));

import { ProvidersBoard } from "../../frontend/src/components/ProvidersView";

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

function env(extra: Record<string, unknown> = {}, kv: FakeKV = new FakeKV()): Env {
  return { AGENT_TOKENS: kv, ...extra } as unknown as Env;
}

function request(path: string, init?: RequestInit, email?: string): Request {
  const headers = new Headers(init?.headers);
  if (init?.method === "POST" && !headers.has("Origin")) headers.set("Origin", "http://localhost");
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (email !== undefined) headers.set("CF-Access-Authenticated-User-Email", email);
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function snapshot(response: Response | null): Promise<AcpProvidersSnapshot> {
  if (response === null) throw new Error("expected a provider response");
  expect(response.status).toBe(200);
  return (await response.json()) as AcpProvidersSnapshot;
}

const confirmOk = async () => ({ ok: true, message: "mocked device grant" });
const beginWaiting = async () => ({
  ok: true,
  pending: true,
  message: "paste the callback",
  signInKind: "chatgpt-pkce" as const,
  verificationUri: "https://auth.openai.com/oauth/authorize?x=1",
});

describe("provider registry", () => {
  it("lists an ACP adapter for each dashboard provider, and refuses to call Grok an ACP server", () => {
    expect(ACP_PROVIDER_REGISTRY.map((provider) => provider.id)).toEqual([
      "claude",
      "codex",
      "gemini",
      "grok",
      "cursor", "openai", "anthropic", "openrouter", "groq", "copilot", "kimi", "meta",
    ]);
    for (const provider of ACP_PROVIDER_REGISTRY) {
      if (provider.protocol === "acp") {
        if (provider.harness === "antigravity-subscription" || provider.harness === "cursor-subscription") {
          expect(provider.spawn.length).toBeGreaterThan(0);
        } else {
          const lane = ACP_LANES[provider.harness as keyof typeof ACP_LANES];
          expect(lane, provider.id).toBeDefined();
          expect(provider.spawn).toEqual(lane.spec.spawn);
        }
        expect(acpAdapterPlan(provider.id).harness).toBe(provider.harness);
      }
    }
    expect(ACP_PROVIDER_REGISTRY.find((provider) => provider.id === "grok")?.protocol).toBe("cli");
    expect(() => acpAdapterPlan("grok")).toThrow(/does not speak ACP/);
  });
});

describe("GET /api/providers", () => {
  it("returns the registry when subscription flags are off", async () => {
    const response = await handleAcpProviders(request("/api/providers"), env());
    const body = await snapshot(response);
    expect(body.org).toBe("default");
    expect(body.defaultProviderId).toBeNull();
    expect(body.providers.every((provider) => provider.connection.phase === "disconnected")).toBe(true);
    expect(body.providers.find((provider) => provider.id === "claude")?.capabilities).toMatchObject(
      {
        acp: true,
        oauth: true,
        apiKey: true,
        permissions: true,
        setModel: true,
      },
    );
    expect(JSON.stringify(body)).not.toMatch(/sk-|secret-value|setup-token/);
  });

  it("still lists providers when the connection store is missing", async () => {
    const response = await handleAcpProviders(request("/api/providers"), {} as Env);
    const body = await snapshot(response);
    expect(body.providers).toHaveLength(12);
  });
});

describe("legacy dashboard connector is gone; harness admission stays", () => {
  it("refuses a claude-subscription run that never reached succeeded", async () => {
    const { assertHarnessAuthorized } = await import("../src/auth/index.js");
    const { claudeSubscriptionHarness } = await import("../src/harness/claude-subscription.js");
    await expect(
      assertHarnessAuthorized(env(), claudeSubscriptionHarness, {
        authAccount: "default",
      } as never),
    ).rejects.toThrow(/no authenticated account/);
  });
});

describe("root cause: subscription routes 404 without the flag", () => {
  it("claude-subscription connect is dark, while /api/providers connect is not", async () => {
    const dark = await handleSubscriptionAuth(
      request("/api/auth/claude-subscription", {
        method: "POST",
        body: JSON.stringify({ account: "default" }),
      }),
      env(),
    );
    expect(dark?.status).toBe(404);

    const started = await handleAcpProviders(
      request("/api/providers/claude/connect", {
        method: "POST",
        body: JSON.stringify({ mode: "oauth" }),
      }),
      env(),
    );
    const body = await snapshot(started);
    const claude = body.providers.find((provider) => provider.id === "claude");
    expect(claude?.connection.phase).toBe("waiting");
    expect(claude?.connection.signInKind).toBe("claude-setup-token");
    expect(claude?.connection.userCode).toBeNull();
    expect(claude?.connection.verificationUri).toBeNull();
    expect(claude?.connection.operatorSteps?.join("\n")).toMatch(/claude setup-token/);
    expect(JSON.stringify(body)).not.toMatch(/SHIBA_CLAUDE_SUBSCRIPTION|CLAUDE_SUBSCRIPTION_TOKEN/);
    expect(JSON.stringify(body)).not.toContain("https://claude.ai/login");
  });
});

describe("sign-in is not a local confirmation code", () => {
  const kv = new FakeKV();
  let now = 1_700_000_000_000;
  const deps = {
    now: () => now,
    beginOauth: vi.fn(beginWaiting),
    completeOauth: vi.fn(confirmOk),
  };

  beforeEach(() => {
    kv.map.clear();
    now = 1_700_000_000_000;
    deps.beginOauth.mockClear();
    deps.completeOauth.mockClear();
    deps.beginOauth.mockImplementation(beginWaiting);
    deps.completeOauth.mockImplementation(confirmOk);
  });

  it("starts a real authorize URL and finishes when the callback is accepted", async () => {
    const deployment = env({}, kv);
    const started = await snapshot(
      await handleAcpProviders(
        request("/api/providers/codex/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "oauth" }),
        }),
        deployment,
        deps,
      ),
    );
    const waiting = started.providers.find((provider) => provider.id === "codex");
    expect(waiting?.connection.phase).toBe("waiting");
    expect(waiting?.connection.userCode).toBeNull();
    expect(waiting?.connection.verificationUri).toBe("https://auth.openai.com/oauth/authorize?x=1");
    expect(waiting?.connection.verificationUri).not.toBe("https://chatgpt.com/");

    const callback = "http://127.0.0.1:1455/auth/callback?code=abc&state=xyz";
    const done = await snapshot(
      await handleAcpProviders(
        request("/api/providers/codex/verify", {
          method: "POST",
          body: JSON.stringify({ callbackUrl: callback }),
        }),
        deployment,
        deps,
      ),
    );
    const codex = done.providers.find((provider) => provider.id === "codex");
    expect(codex?.connection.phase).toBe("connected");
    expect(done.defaultProviderId).toBe("codex");
    expect(codex?.connection.authMode).toBe("oauth");
    expect(codex?.connection.message).toBe("mocked device grant");
    expect(deps.completeOauth).toHaveBeenCalledOnce();
    expect([...kv.map.values()].join("\n")).not.toContain(callback);
  });

  it("clears an expired sign-in without calling complete", async () => {
    const deployment = env({}, kv);
    await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "oauth" }),
        }),
        deployment,
        deps,
      ),
    );
    now += 16 * 60 * 1000;
    const expired = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/verify", {
          method: "POST",
          body: JSON.stringify({}),
        }),
        deployment,
        deps,
      ),
    );
    expect(expired.providers.find((provider) => provider.id === "claude")?.connection).toMatchObject({
      phase: "disconnected",
      message: "The last sign-in timed out. Connect again when you're ready.",
      verificationUri: null,
      expiresAt: null,
    });
    expect(deps.completeOauth).not.toHaveBeenCalled();
  });

  it("refuses pasted key material and does not store it", async () => {
    const deployment = env({}, kv);
    const response = await handleAcpProviders(
      request("/api/providers/claude/connect", {
        method: "POST",
        body: JSON.stringify({ mode: "api-key", apiKey: "sk-live-should-not-land" }),
      }),
      deployment,
      deps,
    );
    expect(response?.status).toBe(400);
    expect([...kv.map.values()].join("\n")).not.toContain("sk-live-should-not-land");
  });

  it("rejects a camelCase refresh token instead of connecting", async () => {
    const response = await handleAcpProviders(
      request("/api/providers/claude/connect", {
        method: "POST",
        body: JSON.stringify({ mode: "api-key", refreshToken: "pasted-refresh" }),
      }),
      env({ AI_GATEWAY_TOKEN: "gateway-canary" }),
    );
    expect(response?.status).toBe(400);
  });
});

describe("API-key fallback", () => {
  it("does not treat a deployment gateway credential as a personal connection", async () => {
    const deployment = env({ AI_GATEWAY_TOKEN: crypto.randomUUID() });
    const body = await snapshot(await handleAcpProviders(request("/api/providers/claude/connect", {
      method: "POST", body: JSON.stringify({ mode: "api-key" }),
    }), deployment));
    expect(body.providers.find((provider) => provider.id === "claude")?.connection.phase).toBe("disconnected");
    expect((await handleAcpProviders(request("/api/providers/claude/test", { method: "POST", body: "{}" }), deployment))?.status).toBe(409);
  });

  it("does not treat the subscription token as the ACP adapter credential", async () => {
    const body = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "api-key" }),
        }),
        env({ CLAUDE_SUBSCRIPTION_TOKEN: "setup-token-canary-value" }),
      ),
    );
    const claude = body.providers.find((provider) => provider.id === "claude");
    expect(claude?.connection.phase).toBe("disconnected");
    expect(claude?.connection.message ?? "").not.toContain("AI_GATEWAY_TOKEN");
    expect(JSON.stringify(body)).not.toContain("setup-token-canary-value");
  });

  it("stays not connected when no key is pasted and no gateway token is set", async () => {
    const body = await snapshot(
      await handleAcpProviders(
        request("/api/providers/gemini/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "api-key" }),
        }),
        env(),
      ),
    );
    const gemini = body.providers.find((provider) => provider.id === "gemini");
    expect(gemini?.connection.phase).toBe("disconnected");
    expect(gemini?.connection.message ?? "").not.toContain("AI_GATEWAY_TOKEN");
  });

  it("stores a pasted provider key encrypted and does not echo it", async () => {
    const kv = new FakeKV();
    const secret = "AIza-test-key-value";
    const deployment = env({ MODEL_CREDENTIAL_KEY: "ab".repeat(32) }, kv);
    const body = await snapshot(
      await handleAcpProviders(
        request("/api/providers/gemini/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "api-key", credential: secret }),
        }),
        deployment,
      ),
    );
    const gemini = body.providers.find((provider) => provider.id === "gemini");
    expect(gemini?.connection.phase).toBe("connected");
    expect(body.defaultProviderId).toBe("gemini");
    expect(gemini?.connection.message).toMatch(/stored/i);
    expect(JSON.stringify(body)).not.toContain(secret);
    expect([...kv.map.values()].join("\n")).not.toContain(secret);
  });

  it("renders a stale gateway failure as not connected", async () => {
    const kv = new FakeKV();
    await kv.put(
      "acp_provider:default:grok",
      JSON.stringify({
        phase: "failed",
        authMode: "api-key",
        message: "No credential is provisioned. Set AI_GATEWAY_TOKEN.",
        updatedAt: 1,
      }),
    );
    const body = await snapshot(await handleAcpProviders(request("/api/providers"), env({}, kv)));
    expect(body.providers.find((provider) => provider.id === "grok")?.connection.phase).toBe(
      "disconnected",
    );
  });

  it("refuses unknown provider ids", async () => {
    const response = await handleAcpProviders(
      request("/api/providers/opencode/connect", {
        method: "POST",
        body: JSON.stringify({ mode: "oauth" }),
      }),
      env(),
    );
    expect(response?.status).toBe(404);
  });
});

describe("subscription probe reuse", () => {
  it("does not turn an operator token or auth flow into a personal connection", async () => {
    const kv = new FakeKV();
    await kv.put("auth_flow_claude-sub:default", JSON.stringify({ phase: "succeeded", ownerSessionId: "default" }));
    const deployment = env({ SHIBA_CLAUDE_SUBSCRIPTION: "1", CLAUDE_SUBSCRIPTION_TOKEN: crypto.randomUUID() }, kv);
    const forwardClaude = vi.fn(async () => new Response("{}"));
    const done = await snapshot(await handleAcpProviders(request("/api/providers/claude/connect", {
      method: "POST", body: JSON.stringify({ mode: "setup-token" }),
    }), deployment, { forwardClaude }));
    expect(done.providers.find((provider) => provider.id === "claude")?.connection.phase).toBe("waiting");
    expect(forwardClaude).not.toHaveBeenCalled();
  });

  it("does not write a test result over a disconnect that landed during the read", async () => {
    const kv = new FakeKV();
    const deployment = env({ SHIBA_CLAUDE_SUBSCRIPTION: "1" }, kv);
    await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "oauth" }),
        }),
        deployment,
        { beginOauth: beginWaiting },
      ),
    );
    await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/verify", {
          method: "POST",
          body: JSON.stringify({}),
        }),
        deployment,
        { completeOauth: async () => ({ ok: true, message: "granted" }) },
      ),
    );
    let release: (value: { ok: boolean; message: string }) => void = () => {};
    let entered: () => void = () => {};
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const inspectOauth = () => {
      entered();
      return new Promise<{ ok: boolean; message: string }>((resolve) => {
        release = resolve;
      });
    };
    const testing = handleAcpProviders(
      request("/api/providers/claude/test", { method: "POST", body: "{}" }),
      deployment,
      { inspectOauth },
    );
    await enteredGate;
    await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/disconnect", { method: "POST", body: "{}" }),
        deployment,
      ),
    );
    release({ ok: true, message: "late" });
    const after = await snapshot(await testing);
    expect(after.providers.find((provider) => provider.id === "claude")?.connection.phase).toBe(
      "disconnected",
    );
  });

  it("does not recreate a provider row when disconnect lands during sign-in confirmation", async () => {
    const kv = new FakeKV();
    const deployment = env({ SHIBA_CLAUDE_SUBSCRIPTION: "1" }, kv);
    await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "oauth" }),
        }),
        deployment,
        { beginOauth: beginWaiting },
      ),
    );
    let release: (value: { ok: boolean; message: string }) => void = () => {};
    let entered: () => void = () => {};
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const completeOauth = () => {
      entered();
      return new Promise<{ ok: boolean; message: string }>((resolve) => {
        release = resolve;
      });
    };
    const confirming = handleAcpProviders(
      request("/api/providers/claude/verify", {
        method: "POST",
        body: JSON.stringify({}),
      }),
      deployment,
      { completeOauth },
    );
    await enteredGate;
    await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/disconnect", { method: "POST", body: "{}" }),
        deployment,
      ),
    );
    release({ ok: true, message: "late grant" });
    const after = await snapshot(await confirming);
    const card = after.providers.find((provider) => provider.id === "claude");
    expect(card?.connection.phase).toBe("disconnected");
    expect(card?.connection.testOk).toBeNull();
    expect(card?.connection.message ?? "").not.toContain("late grant");
    expect([...kv.map.keys()].some((key) => key.startsWith("acp_provider:"))).toBe(false);
  });
});

describe("per-org default", () => {
  it("keeps one org's default off another org, and clears it on disconnect", async () => {
    const kv = new FakeKV();
    const deployment = env({ MODEL_CREDENTIAL_KEY: "ab".repeat(32) }, kv);
    const connect = (email: string) =>
      handleAcpProviders(
        request(
          "/api/providers/grok/connect",
          { method: "POST", body: JSON.stringify({ mode: "api-key", credential: crypto.randomUUID() }) },
          email,
        ),
        deployment,
      );
    await connect("ada@example.com");
    await connect("grace@example.com");
    const ada = await snapshot(
      await handleAcpProviders(
        request(
          "/api/providers/grok/default",
          { method: "POST", body: "{}" },
          "ada@example.com",
        ),
        deployment,
      ),
    );
    expect(ada.org).toBe("ada@example.com");
    expect(ada.defaultProviderId).toBe("grok");

    const grace = await snapshot(
      await handleAcpProviders(
        request("/api/providers", undefined, "grace@example.com"),
        deployment,
      ),
    );
    expect(grace.defaultProviderId).toBe("grok");
    expect(grace.providers.find((provider) => provider.id === "grok")?.isDefault).toBe(true);

    const cleared = await snapshot(
      await handleAcpProviders(
        request(
          "/api/providers/grok/disconnect",
          { method: "POST", body: "{}" },
          "ada@example.com",
        ),
        deployment,
      ),
    );
    expect(cleared.defaultProviderId).toBeNull();
    expect(cleared.providers.find((provider) => provider.id === "grok")?.connection.phase).toBe(
      "disconnected",
    );
    expect(JSON.stringify(cleared)).not.toContain("gateway-canary");
  });

  it("refuses to default a provider that is not connected", async () => {
    const response = await handleAcpProviders(
      request("/api/providers/gemini/default", { method: "POST", body: "{}" }),
      env(),
    );
    expect(response?.status).toBe(409);
  });

  it("refuses to test a provider that is not connected", async () => {
    const response = await handleAcpProviders(
      request("/api/providers/gemini/test", { method: "POST", body: "{}" }),
      env(),
    );
    expect(response?.status).toBe(409);
  });
});

describe("automatic provider defaults", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["disconnect", "reset"])("preserves a connected default and promotes the latest remaining provider on %s", async (action) => {
    const kv = new FakeKV();
    const deployment = env({}, kv);
    const connect = async (id: string, time: number) => snapshot(await handleAcpProviders(
      request(`/api/providers/${id}/connect`, { method: "POST", body: JSON.stringify({ mode: "oauth" }) }),
      deployment,
      { now: () => time, beginOauth: async () => ({ ok: true, pending: false, message: "Connected" }) },
    ));
    expect((await connect("codex", 1)).defaultProviderId).toBe("codex");
    expect((await connect("gemini", 2)).defaultProviderId).toBe("codex");
    expect((await connect("cursor", 3)).defaultProviderId).toBe("codex");
    const promoted = await snapshot(await handleAcpProviders(
      request(`/api/providers/codex/${action}`, { method: "POST", body: "{}" }), deployment,
    ));
    expect(promoted.defaultProviderId).toBe("cursor");
    expect(promoted.providers.find((provider) => provider.id === "cursor")?.isDefault).toBe(true);
  });

  it("keeps an explicitly chosen connected default when another provider connects", async () => {
    const kv = new FakeKV();
    const deployment = env({}, kv);
    const connect = (id: string) => handleAcpProviders(request(`/api/providers/${id}/connect`, {
      method: "POST", body: JSON.stringify({ mode: "oauth" }),
    }), deployment, { beginOauth: async () => ({ ok: true, pending: false, message: "Connected" }) });
    await connect("codex");
    await connect("gemini");
    await handleAcpProviders(request("/api/providers/gemini/default", { method: "POST", body: "{}" }), deployment);
    const body = await snapshot(await connect("cursor"));
    expect(body.defaultProviderId).toBe("gemini");
  });

  it("makes a stored OpenAI key default and clears it on disconnect", async () => {
    const deployment = env({ MODEL_CREDENTIAL_KEY: "ab".repeat(32) });
    const connected = await snapshot(await handleAcpProviders(request("/api/providers/openai/connect", {
      method: "POST", body: JSON.stringify({ mode: "api-key", credential: "sk-qa-preview-not-real-000000000000" }),
    }), deployment));
    expect(connected.defaultProviderId).toBe("openai");
    const disconnected = await snapshot(await handleAcpProviders(request("/api/providers/openai/disconnect", {
      method: "POST", body: "{}",
    }), deployment));
    expect(disconnected.defaultProviderId).toBeNull();
    expect(disconnected.providers.find((provider) => provider.id === "openai")?.connection.phase).toBe("disconnected");
  });

  it("cancels a pending Codex sign-in without a failure", async () => {
    const deployment = env();
    await handleAcpProviders(request("/api/providers/codex/connect", {
      method: "POST", body: JSON.stringify({ mode: "oauth" }),
    }), deployment, { beginOauth: beginWaiting });
    const body = await snapshot(await handleAcpProviders(request("/api/providers/codex/disconnect", {
      method: "POST", body: "{}",
    }), deployment));
    expect(body.defaultProviderId).toBeNull();
    expect(body.providers.find((provider) => provider.id === "codex")?.connection.phase).toBe("disconnected");
  });

  it("replaces a stale default when a sign-in is verified", async () => {
    const kv = new FakeKV();
    await kv.put("acp_provider_default:default", "gemini");
    const deployment = env({}, kv);
    await handleAcpProviders(request("/api/providers/codex/connect", {
      method: "POST", body: JSON.stringify({ mode: "oauth" }),
    }), deployment, { beginOauth: beginWaiting });
    const body = await snapshot(await handleAcpProviders(request("/api/providers/codex/verify", {
      method: "POST", body: "{}",
    }), deployment, { completeOauth: confirmOk }));
    expect(body.defaultProviderId).toBe("codex");
  });

  it.each(["chatgpt-device", "claude-setup-token"])("clears expired %s pending data on snapshot reads", async (signInKind) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const kv = new FakeKV();
    const deployment = env({}, kv);
    await handleAcpProviders(request("/api/providers/codex/connect", {
      method: "POST", body: JSON.stringify({ mode: "oauth" }),
    }), deployment, {
      beginOauth: async () => ({
        ok: true, pending: true, message: "Waiting", signInKind: signInKind as "chatgpt-device" | "claude-setup-token",
        userCode: "test-code", oauthState: "test-state", expiresAt: 2_000,
      }),
    });
    vi.advanceTimersByTime(1_000);
    const body = await snapshot(await handleAcpProviders(request("/api/providers"), deployment));
    expect(body.providers.find((provider) => provider.id === "codex")?.connection).toMatchObject({
      phase: "disconnected", message: "The last sign-in timed out. Connect again when you're ready.",
      userCode: null, oauthState: null, expiresAt: null, signInKind: null,
    });
    const stored = JSON.parse(kv.map.get("acp_provider:default:codex") ?? "{}");
    expect(stored.phase).toBe("disconnected");
    expect(stored).not.toHaveProperty("oauthState");
    expect(stored).not.toHaveProperty("userCode");
  });

  it.each(["reconnect", "disconnect"])("does not overwrite a concurrent %s while clearing an expired snapshot", async (action) => {
    const kv = new FakeKV();
    const key = "acp_provider:default:codex";
    await kv.put(key, JSON.stringify({ phase: "waiting", authMode: "oauth", updatedAt: 1, expiresAt: 2 }));
    const get = kv.get.bind(kv);
    let raced = false;
    vi.spyOn(kv, "get").mockImplementation(async (requested) => {
      const value = await get(requested);
      if (requested === key && !raced) {
        raced = true;
        if (action === "disconnect") await kv.delete(key);
        else await kv.put(key, JSON.stringify({ phase: "connected", authMode: "oauth", updatedAt: 3 }));
      }
      return value;
    });
    const body = await snapshot(await handleAcpProviders(request("/api/providers"), env({}, kv), { now: () => 4 }));
    const connection = body.providers.find((provider) => provider.id === "codex")?.connection;
    expect(connection?.phase).toBe(action === "reconnect" ? "connected" : "disconnected");
    if (action === "disconnect") expect(kv.map.has(key)).toBe(false);
    else expect(JSON.parse(kv.map.get(key) ?? "{}").updatedAt).toBe(3);
  });

  it("keeps rejected sign-ins failed and leaves the default unset", async () => {
    const deployment = env();
    await handleAcpProviders(request("/api/providers/codex/connect", {
      method: "POST", body: JSON.stringify({ mode: "oauth" }),
    }), deployment, { beginOauth: beginWaiting });
    const body = await snapshot(await handleAcpProviders(request("/api/providers/codex/verify", {
      method: "POST", body: "{}",
    }), deployment, { completeOauth: async () => ({ ok: false, message: "Rejected token" }) }));
    expect(body.defaultProviderId).toBeNull();
    expect(body.providers.find((provider) => provider.id === "codex")?.connection.phase).toBe("failed");
  });
});

describe("Providers page states", () => {
  it("renders waiting, ready, failed, and disconnected cards", () => {
    const base = {
      adapter: "claude-agent-acp",
      packageName: "@agentclientprotocol/claude-agent-acp",
      license: "Apache-2.0",
      harness: "claude-acp",
      protocol: "acp" as const,
      spawn: ["claude-agent-acp"],
      defaultModel: "anthropic/claude-sonnet-4-6",
      docsUrl: "https://agentclientprotocol.com",
      capabilities: {
        streamsText: true,
        toolCalls: true,
        permissions: true,
        setModel: true,
        oauth: true,
        apiKey: true,
        acp: true,
      },
      credentialEnv: ["CLAUDE_SUBSCRIPTION_TOKEN"],
      isDefault: false,
    };
    const html = renderToStaticMarkup(
      React.createElement(ProvidersBoard, {
        snapshot: {
          org: "ada@example.com",
          defaultProviderId: "claude",
          providers: [
            {
              ...base,
              id: "claude",
              label: "Claude Code",
              blurb: "ACP adapter",
              isDefault: true,
              connection: {
                phase: "connected",
                authMode: "oauth",
                message: "setup-token reached the API.",
                userCode: null,
                verificationUri: null,
                expiresAt: null,
                testedAt: 1,
                testOk: true,
              },
            },
            {
              ...base,
              id: "codex",
              label: "Codex",
              blurb: "ACP adapter",
              harness: "codex-acp",
              connection: {
                phase: "waiting",
                authMode: "oauth",
                message: "Open the sign-in page.",
                userCode: null,
                verificationUri: "https://auth.openai.com/oauth/authorize?x=1",
                signInKind: "chatgpt-pkce",
                operatorSteps: ["Paste the http://127.0.0.1 callback URL."],
                expiresAt: 2,
                testedAt: null,
                testOk: null,
              },
            },
            {
              ...base,
              id: "gemini",
              label: "Gemini CLI",
              blurb: "ACP adapter",
              capabilities: { ...base.capabilities, oauth: false },
              connection: {
                phase: "failed",
                authMode: "api-key",
                message: "No credential is provisioned.",
                userCode: null,
                verificationUri: null,
                expiresAt: null,
                testedAt: null,
                testOk: null,
              },
            },
          ],
        },
        loading: false,
        error: null,
        busyId: null,
        actionError: null,
        onRetry: () => {},
        onConnectOauth: () => {},
        onConnectSetupToken: () => {},
        onConnectApiKey: () => {},
        onVerify: () => {},
        onTest: () => {},
        onDisconnect: () => {},
        onDefault: () => {},
      }),
    );
    expect(html).toContain("My default · Claude Code");
    expect(html).toContain("Configuration checked");
    expect(html).toContain("Open ChatGPT sign-in");
    expect(html).toContain("Callback URL (optional if loopback is running)");
    expect(html).not.toContain("https://chatgpt.com/");
    expect(html).not.toContain("Confirmation code");
    expect(html).toContain("Sign-in pending");
    expect(html).toContain("Connection failed");
    expect(html).toContain("Finish sign-in");
    expect(html).toContain("Check saved configuration");
    expect(html).toContain("Use API credential");
    expect(html).not.toContain("Connect with sign-in</button>");
  });

  it("names the in-flight action on the button that was pressed", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProvidersBoard, {
        snapshot: {
          org: "ada@example.com",
          defaultProviderId: null,
          providers: [
            {
              id: "claude",
              label: "Claude Code",
              blurb: "ACP adapter",
              adapter: "claude-agent-acp",
              packageName: "@agentclientprotocol/claude-agent-acp",
              license: "Apache-2.0",
              harness: "claude-acp",
              protocol: "acp",
              spawn: ["claude-agent-acp"],
              defaultModel: "anthropic/claude-sonnet-4-6",
              docsUrl: "https://agentclientprotocol.com",
              capabilities: {
                streamsText: true,
                toolCalls: true,
                permissions: true,
                setModel: true,
                oauth: true,
                apiKey: true,
                acp: true,
              },
              credentialEnv: ["AI_GATEWAY_TOKEN"],
              isDefault: false,
              connection: {
                phase: "disconnected",
                authMode: null,
                message: null,
                userCode: null,
                verificationUri: null,
                expiresAt: null,
                testedAt: null,
                testOk: null,
              },
            },
          ],
        },
        loading: false,
        error: null,
        busyId: "claude",
        busyAction: "api-key",
        actionError: null,
        onRetry: () => {},
        onConnectOauth: () => {},
        onConnectSetupToken: () => {},
        onConnectApiKey: () => {},
        onVerify: () => {},
        onTest: () => {},
        onDisconnect: () => {},
        onDefault: () => {},
      }),
    );
    expect(html).toContain("Review Claude connection options");
    expect(html).toContain("Working…");
    expect(html).not.toContain("Use API credential");
  });

  it("does not paint an empty adapter catalog when the provider request failed", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProvidersBoard, {
        snapshot: null,
        loading: false,
        error: "Providers request failed: 503",
        busyId: null,
        actionError: null,
        onRetry: () => {},
        onConnectOauth: () => {},
        onConnectSetupToken: () => {},
        onConnectApiKey: () => {},
        onVerify: () => {},
        onTest: () => {},
        onDisconnect: () => {},
        onDefault: () => {},
      }),
    );
    expect(html).toContain("Providers request failed: 503");
    expect(html).toContain("Model connections");
    expect(html).not.toContain(">Coding connections<");
    expect(html).not.toContain("provider-card-");
  });
});


describe("live Anthropic credential validation", () => {
  const token = "sk-ant-oat01-synthetic-invalid-test-value";
  const card = (body: AcpProvidersSnapshot, id = "claude") => {
    const provider = body.providers.find((p) => p.id === id);
    if (!provider) throw new Error(`Missing provider ${id}`);
    return provider.connection;
  };
  const post = (id: string, action: string, body: Record<string, unknown> = {}) =>
    request(`/api/providers/${id}/${action}`, { method: "POST", body: JSON.stringify(body) });

  it.each([401, 403, 500, 429, "timeout"])("does not store Claude credentials after %s", async (status) => {
    const deployment = env({ MODEL_CREDENTIAL_KEY: "ab".repeat(32) });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (status === "timeout") throw new DOMException("Timed out", "TimeoutError");
      return new Response("{}", { status: status as number });
    });
    await snapshot(await handleAcpProviders(post("claude", "connect", { mode: "oauth" }), deployment, { fetchImpl }));
    const rejected = await snapshot(await handleAcpProviders(post("claude", "verify", { credential: token }), deployment, { fetchImpl }));
    expect(card(rejected).phase).toBe("waiting");
    expect(card(rejected).message).toContain(status === 401 || status === 403 ? "Anthropic rejected this token" : "Couldn't reach Anthropic");
    expect(JSON.stringify(rejected)).not.toContain(token);
    expect(await readUserProviderSecret(deployment, "default", "claude-setup")).toBeNull();
    const listed = await snapshot(await handleAcpProviders(request("/api/providers"), deployment, { fetchImpl }));
    expect(card(listed).phase).toBe("waiting");
    expect(card(listed).testOk).not.toBe(true);
    expect((await handleAcpProviders(post("claude", "test"), deployment, { fetchImpl }))?.status).toBe(409);
    const disconnected = await snapshot(await handleAcpProviders(post("claude", "disconnect"), deployment, { fetchImpl }));
    expect(card(disconnected).phase).toBe("disconnected");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("stores only an accepted token, checks it live, and retains a rejected saved token until disconnect", async () => {
    const deployment = env({ MODEL_CREDENTIAL_KEY: "ab".repeat(32) });
    let status = 200;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status }));
    const deps = { fetchImpl };
    await snapshot(await handleAcpProviders(post("claude", "connect", { mode: "setup-token" }), deployment, deps));
    const verified = await snapshot(await handleAcpProviders(post("claude", "verify", { credential: token }), deployment, deps));
    expect(card(verified).phase).toBe("connected");
    expect(await readUserProviderSecret(deployment, "default", "claude-setup")).toBe(token);
    expect(JSON.stringify(verified)).not.toContain(token);
    const tested = await snapshot(await handleAcpProviders(post("claude", "test"), deployment, deps));
    expect(card(tested)).toMatchObject({ phase: "connected", testOk: true });
    status = 503;
    const unavailable = await snapshot(await handleAcpProviders(post("claude", "test"), deployment, deps));
    expect(card(unavailable)).toMatchObject({ phase: "connected", testOk: false });
    expect(card(unavailable).message).toContain("Couldn't reach Anthropic");
    status = 401;
    const rejected = await snapshot(await handleAcpProviders(post("claude", "test"), deployment, deps));
    expect(card(rejected)).toMatchObject({ phase: "failed", testOk: false, message: "Anthropic rejected the saved token. Paste a new one." });
    expect(card(await snapshot(await handleAcpProviders(request("/api/providers"), deployment, deps))).phase).toBe("failed");
    expect(await readUserProviderSecret(deployment, "default", "claude-setup")).toBe(token);
    await snapshot(await handleAcpProviders(post("claude", "disconnect"), deployment, deps));
    expect(await readUserProviderSecret(deployment, "default", "claude-setup")).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it.each(["claude", "anthropic"])("does not save %s credentials when disconnect lands during validation", async (id) => {
    const deployment = env({ MODEL_CREDENTIAL_KEY: "ab".repeat(32) });
    let signalEntered: () => void = () => {};
    let release: (response: Response) => void = () => {};
    const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
    const response = new Promise<Response>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(() => { signalEntered(); return response; });
    const deps = { fetchImpl };
    if (id === "claude") {
      await snapshot(await handleAcpProviders(post(id, "connect", { mode: "setup-token" }), deployment, deps));
    }
    const verifying = handleAcpProviders(post(id, id === "claude" ? "verify" : "connect", {
      ...(id === "anthropic" ? { mode: "api-key" } : {}), credential: token,
    }), deployment, deps);
    await entered;
    await snapshot(await handleAcpProviders(post(id, "disconnect"), deployment, deps));
    release(new Response("{}"));
    expect(card(await snapshot(await verifying), id).phase).toBe("disconnected");
    expect(await readUserProviderSecret(deployment, "default", id === "claude" ? "claude-setup" : "anthropic-api")).toBeNull();
  });

  it("checks pasted Anthropic API keys before saving and during Test", async () => {
    const deployment = env({ MODEL_CREDENTIAL_KEY: "ab".repeat(32) });
    let status = 401;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status }));
    const deps = { fetchImpl };
    const connect = () => handleAcpProviders(post("anthropic", "connect", { mode: "api-key", credential: "sk-ant-api-synthetic-test-value" }), deployment, deps);
    const rejected = await snapshot(await connect());
    expect(card(rejected, "anthropic").phase).toBe("failed");
    expect(await readUserProviderSecret(deployment, "default", "anthropic-api")).toBeNull();
    status = 200;
    expect(card(await snapshot(await connect()), "anthropic").phase).toBe("connected");
    expect(card(await snapshot(await handleAcpProviders(post("anthropic", "test"), deployment, deps)), "anthropic").testOk).toBe(true);
    status = 403;
    expect(card(await snapshot(await handleAcpProviders(post("anthropic", "test"), deployment, deps)), "anthropic")).toMatchObject({ phase: "failed", testOk: false });
    expect(await readUserProviderSecret(deployment, "default", "anthropic-api")).not.toBeNull();
  });
});
