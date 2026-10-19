/**
 * ACP provider registry routes.
 *
 * Root cause of the dead Providers page: every connector called
 * `/api/auth/<provider>-subscription`, and that route 404s unless the
 * matching SHIBA_*_SUBSCRIPTION flag is set. Connect was disabled.
 * `/api/providers` answers without those flags.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  if (email !== undefined) headers.set("CF-Access-Authenticated-User-Email", email);
  return new Request(`http://localhost${path}`, { ...init, headers });
}

async function snapshot(response: Response | null): Promise<AcpProvidersSnapshot> {
  if (response === null) throw new Error("expected a provider response");
  expect(response.status).toBe(200);
  return (await response.json()) as AcpProvidersSnapshot;
}

const confirmOk = async () => ({ ok: true, message: "mocked device grant" });

describe("provider registry", () => {
  it("lists an ACP adapter for each dashboard provider, and refuses to call Grok an ACP server", () => {
    expect(ACP_PROVIDER_REGISTRY.map((provider) => provider.id)).toEqual([
      "claude",
      "codex",
      "gemini",
      "grok",
      "opencode",
    ]);
    for (const provider of ACP_PROVIDER_REGISTRY) {
      if (provider.protocol === "acp") {
        const lane = ACP_LANES[provider.harness as keyof typeof ACP_LANES];
        expect(lane, provider.id).toBeDefined();
        expect(provider.spawn).toEqual(lane.spec.spawn);
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
    expect(body.providers.map((provider) => provider.connection.phase)).toEqual([
      "disconnected",
      "disconnected",
      "disconnected",
      "disconnected",
      "disconnected",
    ]);
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
    expect(body.providers).toHaveLength(5);
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
      { confirmOauth: confirmOk },
    );
    const body = await snapshot(started);
    const claude = body.providers.find((provider) => provider.id === "claude");
    expect(claude?.connection.phase).toBe("waiting");
    expect(claude?.connection.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(claude?.connection.verificationUri).toBe("https://claude.ai/login");
  });
});

describe("device-code sign-in", () => {
  const kv = new FakeKV();
  let now = 1_700_000_000_000;
  const deps = {
    now: () => now,
    confirmOauth: vi.fn(confirmOk),
  };

  beforeEach(() => {
    kv.map.clear();
    now = 1_700_000_000_000;
    deps.confirmOauth.mockClear();
    deps.confirmOauth.mockImplementation(confirmOk);
  });

  it("redeems a matching code through the injected OAuth probe and rejects a mismatch", async () => {
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
    const code = started.providers.find((provider) => provider.id === "codex")?.connection.userCode;
    expect(code).toBeTruthy();

    const wrong = await handleAcpProviders(
      request("/api/providers/codex/verify", {
        method: "POST",
        body: JSON.stringify({ userCode: "XXXX-XXXX" }),
      }),
      deployment,
      deps,
    );
    expect(wrong?.status).toBe(400);
    expect(deps.confirmOauth).not.toHaveBeenCalled();

    const done = await snapshot(
      await handleAcpProviders(
        request("/api/providers/codex/verify", {
          method: "POST",
          body: JSON.stringify({ userCode: code }),
        }),
        deployment,
        deps,
      ),
    );
    const codex = done.providers.find((provider) => provider.id === "codex");
    expect(codex?.connection.phase).toBe("connected");
    expect(codex?.connection.authMode).toBe("oauth");
    expect(codex?.connection.testOk).toBe(true);
    expect(codex?.connection.message).toBe("mocked device grant");
    expect(deps.confirmOauth).toHaveBeenCalledOnce();
  });

  it("fails an expired code without calling the probe", async () => {
    const deployment = env({}, kv);
    const started = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "oauth" }),
        }),
        deployment,
        deps,
      ),
    );
    const code = started.providers.find((provider) => provider.id === "claude")?.connection
      .userCode;
    now += 16 * 60 * 1000;
    const expired = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/verify", {
          method: "POST",
          body: JSON.stringify({ userCode: code }),
        }),
        deployment,
        deps,
      ),
    );
    expect(expired.providers.find((provider) => provider.id === "claude")?.connection.phase).toBe(
      "failed",
    );
    expect(deps.confirmOauth).not.toHaveBeenCalled();
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
});

describe("API-key fallback", () => {
  it("connects when the named secret is present and never echoes the value", async () => {
    const deployment = env({ CLAUDE_SUBSCRIPTION_TOKEN: "setup-token-canary-value" });
    const body = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "api-key" }),
        }),
        deployment,
      ),
    );
    const claude = body.providers.find((provider) => provider.id === "claude");
    expect(claude?.connection.phase).toBe("connected");
    expect(claude?.connection.authMode).toBe("api-key");
    expect(claude?.connection.message).toContain("CLAUDE_SUBSCRIPTION_TOKEN");
    expect(JSON.stringify(body)).not.toContain("setup-token-canary-value");

    const tested = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/test", { method: "POST", body: "{}" }),
        deployment,
      ),
    );
    expect(tested.providers.find((provider) => provider.id === "claude")?.connection.testOk).toBe(
      true,
    );
  });

  it("fails closed when no credential is provisioned", async () => {
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
    expect(gemini?.connection.phase).toBe("failed");
    expect(gemini?.connection.message).toContain("AI_GATEWAY_TOKEN");
  });

  it("refuses OAuth for a provider that has no subscription lane", async () => {
    const response = await handleAcpProviders(
      request("/api/providers/grok/connect", {
        method: "POST",
        body: JSON.stringify({ mode: "oauth" }),
      }),
      env(),
    );
    expect(response?.status).toBe(400);
  });
});

describe("subscription probe reuse", () => {
  it("redeems Claude sign-in through the subscription controller when the lane is on", async () => {
    const kv = new FakeKV();
    const deployment = env(
      { SHIBA_CLAUDE_SUBSCRIPTION: "1", CLAUDE_SUBSCRIPTION_TOKEN: "setup-token-canary-value" },
      kv,
    );
    const started = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "oauth" }),
        }),
        deployment,
        { forwardClaude: async () => new Response("{}", { status: 200 }) },
      ),
    );
    const code = started.providers.find((provider) => provider.id === "claude")?.connection
      .userCode;
    const done = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/verify", {
          method: "POST",
          body: JSON.stringify({ userCode: code }),
        }),
        deployment,
        { forwardClaude: async () => new Response("{}", { status: 200 }) },
      ),
    );
    const claude = done.providers.find((provider) => provider.id === "claude");
    expect(claude?.connection.phase).toBe("connected");
    expect(claude?.connection.message).toContain("setup-token reached the API");
    expect(JSON.stringify(done)).not.toContain("setup-token-canary-value");
    expect([...kv.map.values()].join("\n")).not.toContain("setup-token-canary-value");
  });

  it("records a rejected Claude probe as a failed connection", async () => {
    const deployment = env({
      SHIBA_CLAUDE_SUBSCRIPTION: "1",
      CLAUDE_SUBSCRIPTION_TOKEN: "setup-token-canary-value",
    });
    const started = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/connect", {
          method: "POST",
          body: JSON.stringify({ mode: "oauth" }),
        }),
        deployment,
        { forwardClaude: async () => new Response("no", { status: 401 }) },
      ),
    );
    const code = started.providers.find((provider) => provider.id === "claude")?.connection
      .userCode;
    const done = await snapshot(
      await handleAcpProviders(
        request("/api/providers/claude/verify", {
          method: "POST",
          body: JSON.stringify({ userCode: code }),
        }),
        deployment,
        { forwardClaude: async () => new Response("no", { status: 401 }) },
      ),
    );
    const claude = done.providers.find((provider) => provider.id === "claude");
    expect(claude?.connection.phase).toBe("failed");
    expect(claude?.connection.message).toContain("credential rejected (401)");
  });
});

describe("per-org default", () => {
  it("keeps one org's default off another org, and clears it on disconnect", async () => {
    const kv = new FakeKV();
    const deployment = env({ AI_GATEWAY_TOKEN: "gateway-canary" }, kv);
    const connect = (email: string) =>
      handleAcpProviders(
        request(
          "/api/providers/opencode/connect",
          { method: "POST", body: JSON.stringify({ mode: "api-key" }) },
          email,
        ),
        deployment,
      );
    await connect("ada@example.com");
    await connect("grace@example.com");
    const ada = await snapshot(
      await handleAcpProviders(
        request(
          "/api/providers/opencode/default",
          { method: "POST", body: "{}" },
          "ada@example.com",
        ),
        deployment,
      ),
    );
    expect(ada.org).toBe("ada@example.com");
    expect(ada.defaultProviderId).toBe("opencode");

    const grace = await snapshot(
      await handleAcpProviders(
        request("/api/providers", undefined, "grace@example.com"),
        deployment,
      ),
    );
    expect(grace.defaultProviderId).toBeNull();
    expect(grace.providers.find((provider) => provider.id === "opencode")?.isDefault).toBe(false);

    const cleared = await snapshot(
      await handleAcpProviders(
        request(
          "/api/providers/opencode/disconnect",
          { method: "POST", body: "{}" },
          "ada@example.com",
        ),
        deployment,
      ),
    );
    expect(cleared.defaultProviderId).toBeNull();
    expect(cleared.providers.find((provider) => provider.id === "opencode")?.connection.phase).toBe(
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
                userCode: "ABCD-EFGH",
                verificationUri: "https://chatgpt.com/",
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
        onConnectApiKey: () => {},
        onVerify: () => {},
        onTest: () => {},
        onDisconnect: () => {},
        onDefault: () => {},
      }),
    );
    expect(html).toContain("Org default: Claude Code");
    expect(html).toContain("Ready");
    expect(html).toContain("ABCD-EFGH");
    expect(html).toContain("Sign-in pending");
    expect(html).toContain("Connection failed");
    expect(html).toContain("Finish sign-in");
    expect(html).toContain("Test connection");
    expect(html).toContain("Use API credential");
    expect(html).not.toContain("Connect with sign-in</button>");
  });
});
