import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getIntegrationProvider,
  getSelectedIntegrationsProviderId,
  resetIntegrationProviderCacheForTests,
} from "../src/integrations/runtime.js";
import type { Env } from "../src/env.js";

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

  it("maps toolkit rows and marks connected accounts", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/toolkits?limit=1")) {
        return new Response(JSON.stringify({ items: [{ slug: "hubspot", name: "HubSpot" }] }), { status: 200 });
      }
      if (url.includes("/connected_accounts")) {
        return new Response(
          JSON.stringify({
            items: [{ id: "acc-1", status: "ACTIVE", toolkit: { slug: "hubspot" } }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/toolkits")) {
        return new Response(
          JSON.stringify({
            items: [{ slug: "hubspot", name: "HubSpot", description: "CRM" }],
            next_cursor: null,
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
    const health = await provider.health();
    expect(health.status).toBe("healthy");
    const page = await provider.listCatalog({ userId: "owner-1", limit: 10 });
    expect(page.items[0]?.isConnected).toBe(true);
    expect(page.items[0]?.providerKey).toBe("hubspot");
  });
});
