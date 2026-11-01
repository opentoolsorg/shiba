import { beforeEach, describe, expect, it, vi } from "vitest";
import { integrationProviderCatalogItemSchema, integrationsProviderIdSchema, parseIntegrationsProviderId } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { handleIntegrationProviderRoutes } from "../src/integrations-provider-routes.js";
import { getIntegrationProvider, resetIntegrationProviderCacheForTests } from "../src/integrations/runtime.js";

vi.mock("../src/request-auth.js", () => ({ isAuthorizedRequest: vi.fn(async () => true) }));
vi.mock("../src/gmail-routes.js", () => ({ gmailOwner: vi.fn(async () => "authenticated-owner") }));

const origin = "https://app.example.test";
function post(path: string, body: unknown, sameOrigin = true): Request {
  return new Request(`${origin}/api/integrations/provider/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(sameOrigin ? { origin } : { origin: "https://other.test" }) },
    body: JSON.stringify(body),
  });
}

describe("openconnector runtime and routes", () => {
  beforeEach(() => { resetIntegrationProviderCacheForTests(); vi.restoreAllMocks(); });

  it("accepts the fourth provider and catalog source, preserving the default", () => {
    expect(integrationsProviderIdSchema.parse("openconnector")).toBe("openconnector");
    expect(parseIntegrationsProviderId(" OPENCONNECTOR ")).toBe("openconnector");
    expect(parseIntegrationsProviderId(undefined)).toBe("composio");
    expect(parseIntegrationsProviderId("unknown")).toBe("composio");
    expect(integrationProviderCatalogItemSchema.parse({
      id: "github", providerKey: "github", name: "GitHub", description: "", source: "openconnector",
      isConnected: false, connectable: true,
    }).source).toBe("openconnector");
  });

  it("does not reuse another environment's service binding or credentials", () => {
    const first = { INTEGRATIONS_PROVIDER: "openconnector", OPEN_CONNECTOR_ADMIN_TOKEN: "first" } as Env;
    const second = { ...first, OPEN_CONNECTOR_ADMIN_TOKEN: "second" };
    expect(getIntegrationProvider(first).id).toBe("openconnector");
    expect(getIntegrationProvider(first)).toBe(getIntegrationProvider(first));
    expect(getIntegrationProvider(second)).not.toBe(getIntegrationProvider(first));
  });

  it("dispatches execute through the selected provider with authenticated identity", async () => {
    const env = { INTEGRATIONS_PROVIDER: "openconnector" } as Env;
    const provider = getIntegrationProvider(env);
    const execute = vi.spyOn(provider, "executeTool").mockResolvedValue({ ok: true, status: "completed", output: { count: 1 } });
    const response = await handleIntegrationProviderRoutes(post("execute", {
      userId: "forged-owner", toolSlug: "github/list-issues", toolkitSlug: "github", arguments: { limit: 1 },
    }), env);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ ok: true, status: "completed", output: { count: 1 } });
    expect(execute).toHaveBeenCalledWith({
      userId: "authenticated-owner", toolSlug: "github/list-issues", toolkitSlug: "github", arguments: { limit: 1 },
      sessionId: undefined, connectedAccountId: undefined,
    });
  });

  it("keeps sessions Composio-only and rejects cross-origin execute", async () => {
    const env = { INTEGRATIONS_PROVIDER: "openconnector" } as Env;
    const execute = vi.spyOn(getIntegrationProvider(env), "executeTool");
    const session = await handleIntegrationProviderRoutes(post("session", { toolkitSlug: "github" }), env);
    expect(session?.status).toBe(503);
    expect(await session?.json()).toMatchObject({ error: expect.stringContaining("INTEGRATIONS_PROVIDER=composio") });
    const crossOrigin = await handleIntegrationProviderRoutes(post("execute", { toolSlug: "github/list-issues" }, false), env);
    expect(crossOrigin?.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed for providers without execute support", async () => {
    const response = await handleIntegrationProviderRoutes(post("execute", { toolSlug: "x" }), { INTEGRATIONS_PROVIDER: "none" } as Env);
    expect(response?.status).toBe(503);
  });
});
