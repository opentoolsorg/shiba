import { beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURED_INTEGRATIONS, INTEGRATION_SETUP_GUIDE, integrationProviderCatalogItemSchema } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { handleIntegrationProviderRoutes } from "../src/integrations-provider-routes.js";
import { getIntegrationProvider, resetIntegrationProviderCacheForTests } from "../src/integrations/runtime.js";

vi.mock("../src/request-auth.js", () => ({ isAuthorizedRequest: vi.fn(async () => true) }));
vi.mock("../src/gmail-routes.js", () => ({ gmailOwner: vi.fn(async () => "authenticated-owner") }));

const origin = "https://app.example.test";
const get = (path: string) => new Request(`${origin}/api/integrations/provider/${path}`);
const REQUIRED = ["stripe", "hubspot", "google-ads", "meta-ads", "notion", "gmail", "google-calendar"];

describe("integrations setup card (OpenConnector unbound)", () => {
  beforeEach(() => resetIntegrationProviderCacheForTests());
  const unbound = {} as Env;

  it("serves the catalog as 200 configured:false with the featured apps", async () => {
    const response = await handleIntegrationProviderRoutes(get("catalog"), unbound);
    expect(response?.status).toBe(200);
    const body = await response!.json() as { configured: boolean; setup: typeof INTEGRATION_SETUP_GUIDE; items: Array<{ id: string; available: boolean; reason: string }> };
    expect(body).toMatchObject({ ok: true, provider: "openconnector", configured: false });
    expect(body.setup.steps).toHaveLength(3);
    expect(body.items.map((item) => item.id)).toEqual(expect.arrayContaining(REQUIRED));
    for (const item of body.items) expect(item).toMatchObject({ available: false, reason: "setup_required" });
    for (const item of body.items) expect(integrationProviderCatalogItemSchema.safeParse({ ...item, logoUrl: undefined }).success).toBe(true);
  });

  it("filters featured apps by query", async () => {
    const body = await (await handleIntegrationProviderRoutes(get("catalog?query=strip"), unbound))!.json() as { items: Array<{ id: string }> };
    expect(body.items.map((item) => item.id)).toEqual(["stripe"]);
  });

  it("lists connections as empty instead of 503", async () => {
    const response = await handleIntegrationProviderRoutes(get("connections"), unbound);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ ok: true, configured: false, connections: [] });
  });

  it("answers connect with 409 setup_required, never 503", async () => {
    const response = await handleIntegrationProviderRoutes(new Request(`${origin}/api/integrations/provider/connect`, {
      method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ providerKey: "stripe" }),
    }), unbound);
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ ok: false, code: "setup_required" });
  });

  it("keeps 503 for a configured provider that is down", async () => {
    const env = { OPEN_CONNECTOR_URL: "https://oc.example.test" } as Env;
    vi.spyOn(getIntegrationProvider(env), "listCatalog").mockRejectedValue(new Error("upstream timed out"));
    const response = await handleIntegrationProviderRoutes(get("catalog"), env);
    expect(response?.status).toBe(503);
  });
});

describe("integrations setup card (OpenConnector bound, mocked)", () => {
  beforeEach(() => resetIntegrationProviderCacheForTests());

  it("merges live rows over featured entries by provider id", async () => {
    const env = { OPEN_CONNECTOR_URL: "https://oc.example.test" } as Env;
    vi.spyOn(getIntegrationProvider(env), "listCatalog").mockResolvedValue({
      items: [{ id: "stripe", providerKey: "stripe", name: "Stripe", description: "live", source: "openconnector", isConnected: true, connectable: true, setupState: "ready" }],
      nextCursor: null, hasMore: false,
    } as never);
    const response = await handleIntegrationProviderRoutes(get("catalog"), env);
    expect(response?.status).toBe(200);
    const body = await response!.json() as { configured: boolean; featured: Array<{ id: string; available: boolean; isConnected: boolean; reason?: string }>; items: unknown[] };
    expect(body.configured).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.featured).toHaveLength(FEATURED_INTEGRATIONS.length);
    expect(body.featured.find((item) => item.id === "stripe")).toMatchObject({ available: true, isConnected: true });
    expect(body.featured.find((item) => item.id === "hubspot")).toMatchObject({ available: false, reason: "not_offered" });
  });

  it("falls back to the setup card when the provider reports missing credentials", async () => {
    const env = { OPEN_CONNECTOR_URL: "https://oc.example.test" } as Env;
    const { OpenConnectorIntegrationProviderError } = await import("../src/integrations/openconnector-provider.js");
    vi.spyOn(getIntegrationProvider(env), "listCatalog").mockRejectedValue(new OpenConnectorIntegrationProviderError("Set OPEN_CONNECTOR_ADMIN_TOKEN to enable OpenConnector admin requests."));
    const response = await handleIntegrationProviderRoutes(get("catalog"), env);
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ configured: false });
  });
});
