import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getIntegrationProvider,
  getSelectedIntegrationsProviderId,
  resetIntegrationProviderCacheForTests,
} from "../src/integrations/runtime.js";
import type { Env } from "../src/env.js";
import { ComposioIntegrationProvider, ComposioIntegrationProviderError } from "../src/integrations/composio-provider.js";
import { composioFetchJson, parseComposioToolkitPage } from "../src/integrations/composio-api.js";

function env(partial: Partial<Env> = {}): Env {
  return {
    GATEWAY_ID: "default",
    ORCHESTRATOR_MODEL: "m",
    CODING_MODEL: "m",
    RUNTIME: "sandbox",
    CodingOrchestrator: {} as Env["CodingOrchestrator"],
    OpenCodeAgent: {} as Env["OpenCodeAgent"],
    Sandbox: {} as Env["Sandbox"],
    Automations: {} as Env["Automations"],
    Mailbox: {} as Env["Mailbox"],
    Memory: {} as Env["Memory"],
    Waitlist: {} as Env["Waitlist"],
    MEMORY_VECTORS: {} as Env["MEMORY_VECTORS"],
    ATTACHMENTS: {} as Env["ATTACHMENTS"],
    AGENT_TOKENS: {} as Env["AGENT_TOKENS"],
    AGENT_AUDIT: {} as Env["AGENT_AUDIT"],
    ASSETS: {} as Env["ASSETS"],
    AI: {} as Env["AI"],
    ModelConfig: {} as Env["ModelConfig"],
    ...partial,
  } as Env;
}

describe("integrations provider factory", () => {
  beforeEach(() => {
    resetIntegrationProviderCacheForTests();
  });

  it("defaults to composio when INTEGRATIONS_PROVIDER is unset", () => {
    expect(getSelectedIntegrationsProviderId(env())).toBe("composio");
    expect(getIntegrationProvider(env()).id).toBe("composio");
  });

  it("selects none and grokbot explicitly", () => {
    expect(getSelectedIntegrationsProviderId(env({ INTEGRATIONS_PROVIDER: "none" }))).toBe("none");
    expect(getIntegrationProvider(env({ INTEGRATIONS_PROVIDER: "none" })).id).toBe("none");
    expect(getIntegrationProvider(env({ INTEGRATIONS_PROVIDER: "grokbot" })).id).toBe("grokbot");
  });

  it("caches provider until config hash changes", () => {
    const first = getIntegrationProvider(env({ INTEGRATIONS_PROVIDER: "composio" }));
    const second = getIntegrationProvider(env({ INTEGRATIONS_PROVIDER: "composio" }));
    expect(first).toBe(second);
    const third = getIntegrationProvider(env({ INTEGRATIONS_PROVIDER: "composio", COMPOSIO_API_KEY: "k" }));
    expect(third).not.toBe(first);
  });

  it("accepts COMPOSITO_API_KEY typo alias for cache hash", () => {
    resetIntegrationProviderCacheForTests();
    const provider = getIntegrationProvider(env({ COMPOSITO_API_KEY: "alias-key" }));
    expect(provider).toBeInstanceOf(Object);
    expect((provider as { id: string }).id).toBe("composio");
  });
});

describe("parseComposioToolkitPage", () => {
  it("reads next_cursor and hasMore from object responses", () => {
    const page = parseComposioToolkitPage(
      { items: [{ slug: "a" }], next_cursor: "cursor-2", has_more: true },
      20,
    );
    expect(page.nextCursor).toBe("cursor-2");
    expect(page.hasMore).toBe(true);
    expect(page.items).toHaveLength(1);
  });
});

describe("ComposioIntegrationProvider unconfigured health", () => {
  beforeEach(() => {
    resetIntegrationProviderCacheForTests();
  });

  it("reports unconfigured without COMPOSIO_API_KEY and serves static fallback catalog", async () => {
    const provider = getIntegrationProvider(env({ INTEGRATIONS_PROVIDER: "composio" }));
    const health = await provider.health();
    expect(health.status).toBe("unconfigured");
    const page = await provider.listCatalog({ userId: "owner-1", limit: 5 });
    expect(page.fallbackCatalog).toBe(true);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((item) => item.connectable === false)).toBe(true);
  });

  it("beginConnect fails closed when unconfigured", async () => {
    const provider = getIntegrationProvider(env({ INTEGRATIONS_PROVIDER: "composio" }));
    const result = await provider.beginConnect({
      userId: "owner-1",
      providerKey: "hubspot",
      callbackOrigin: "https://app.example.test",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/COMPOSIO_API_KEY/i);
  });
});

describe("ComposioIntegrationProvider configured fetch", () => {
  beforeEach(() => {
    resetIntegrationProviderCacheForTests();
    vi.restoreAllMocks();
  });

  it("maps toolkit rows, paginates with cursor, and does not use static fallback", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/toolkits\?limit=1(?:&|$)/.test(url)) {
        return new Response(JSON.stringify({ items: [{ slug: "hubspot", name: "HubSpot" }] }), { status: 200 });
      }
      if (url.includes("/connected_accounts")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url.includes("cursor=page-2")) {
        return new Response(
          JSON.stringify({
            items: [{ slug: "stripe", name: "Stripe" }],
            next_cursor: null,
            has_more: false,
          }),
          { status: 200 },
        );
      }
      if (url.includes("/toolkits") && url.includes("limit=10") && !url.includes("cursor=")) {
        return new Response(
          JSON.stringify({
            items: [{ slug: "hubspot", name: "HubSpot", description: "CRM" }],
            next_cursor: "page-2",
            has_more: true,
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    const { ComposioIntegrationProvider } = await import("../src/integrations/composio-provider.js");
    const provider = new ComposioIntegrationProvider({
      env: env({ COMPOSIO_API_KEY: "test-key" }),
      fetchImpl: fetchImpl as typeof fetch,
    });
    const page1 = await provider.listCatalog({ userId: "owner-1", limit: 10 });
    expect(page1.fallbackCatalog).toBeFalsy();
    expect(page1.items[0]?.providerKey).toBe("hubspot");
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe("page-2");

    const page2 = await provider.listCatalog({ userId: "owner-1", limit: 10, cursor: "page-2" });
    expect(page2.items[0]?.providerKey).toBe("stripe");
    expect(page2.hasMore).toBe(false);
  });

  it("throws when catalog API fails with a configured key", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/connected_accounts")) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      if (url.includes("/toolkits")) {
        return new Response("unauthorized", { status: 401 });
      }
      return new Response("{}", { status: 404 });
    });
    const { ComposioIntegrationProvider } = await import("../src/integrations/composio-provider.js");
    const provider = new ComposioIntegrationProvider({
      env: env({ COMPOSIO_API_KEY: "test-key" }),
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(provider.listCatalog({ userId: "owner-1", limit: 5 })).rejects.toBeInstanceOf(
      ComposioIntegrationProviderError,
    );
  });

  it("executes tools through tool-router session + execute endpoints", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.includes("/tool_router/session") && method === "POST") {
        return new Response(JSON.stringify({ session_id: "sess-1" }), { status: 200 });
      }
      if (url.includes("/tool_router/session/sess-1/execute") && method === "POST") {
        return new Response(JSON.stringify({ successful: true, data: { ok: true } }), { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });
    const { ComposioIntegrationProvider } = await import("../src/integrations/composio-provider.js");
    const provider = new ComposioIntegrationProvider({
      env: env({ COMPOSIO_API_KEY: "test-key" }),
      fetchImpl: fetchImpl as typeof fetch,
    });
    const result = await provider.executeTool({
      userId: "owner-1",
      toolSlug: "HUBSPOT_LIST_CONTACTS",
      arguments: { limit: 1 },
      toolkitSlug: "hubspot",
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.sessionId).toBe("sess-1");
    expect(fetchImpl.mock.calls.some(([u]) => String(u).includes("/tool_router/session/sess-1/execute"))).toBe(true);
  });
});


describe("Composio response boundaries", () => {
  const configured = env({ COMPOSIO_API_KEY: "test-key" });
  const context = { userId: "owner-1", providerKey: "hubspot", callbackOrigin: "https://app.example.test" };

  it.each([null, undefined, "not-json", 7, false])("treats primitive catalog payload %s as an empty page", (data) => {
    expect(parseComposioToolkitPage(data, 20)).toEqual({ items: [], nextCursor: null, hasMore: false });
  });

  it.each(["not-json", "null", '{"items":[null]}', '{"items":[{"toolkit":"hubspot"}]}']) (
    "rejects malformed account responses: %s", async (body) => {
      const provider = new ComposioIntegrationProvider({ env: configured, fetchImpl: async () => new Response(body) });
      await expect(provider.listConnections({ userId: "owner-1" })).rejects.toBeInstanceOf(ComposioIntegrationProviderError);
      await expect(provider.disconnect(context)).rejects.toBeInstanceOf(ComposioIntegrationProviderError);
    },
  );

  it("rejects failed account lookup instead of reporting a successful disconnect", async () => {
    const fetchImpl = vi.fn(async () => new Response("unavailable", { status: 503 }));
    const provider = new ComposioIntegrationProvider({ env: configured, fetchImpl });
    await expect(provider.disconnect(context)).rejects.toThrow("account lookup failed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("checks every disconnect response and applies fetch timeouts", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (init?.method === "DELETE") return new Response("unavailable", { status: 503 });
      return Response.json({ items: [{ id: "account-1", toolkit: { slug: "hubspot" }, status: "ACTIVE" }] });
    });
    const provider = new ComposioIntegrationProvider({ env: configured, fetchImpl });
    await expect(provider.disconnect(context)).rejects.toThrow("disconnect failed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await provider.health();
  });

  it("bounds JSON requests while retaining an explicitly supplied signal", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({});
    });
    await composioFetchJson(fetchImpl, "https://example.test", "key");
    const signal = new AbortController().signal;
    await composioFetchJson(fetchImpl, "https://example.test", "key", { signal });
    expect(fetchImpl.mock.calls[1]?.[1]?.signal).toBe(signal);
  });
});
