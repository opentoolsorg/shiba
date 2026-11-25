import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";

vi.mock("../src/gmail-routes.js", () => ({ gmailOwner: async () => "alice" }));
vi.mock("../src/request-auth.js", () => ({ isAuthorizedRequest: async () => true }));

import { handleIntegrationProviderRoutes } from "../src/integrations-provider-routes.js";

describe("connector setup read responses", () => {
  it.each(["catalog", "connections"])("returns a setup state for %s when no service is configured", async (endpoint) => {
    const response = await handleIntegrationProviderRoutes(new Request(`https://shiba.example.test/api/integrations/provider/${endpoint}`), {} as Env);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ configured: false });
  });

  it.each(["catalog", "connections"])("honors explicit none for %s even when a service URL exists", async (endpoint) => {
    const response = await handleIntegrationProviderRoutes(new Request(`https://shiba.example.test/api/integrations/provider/${endpoint}`), {
      CONNECTOR_PROVIDER: "none", OPEN_CONNECTOR_URL: "https://connector.example.test",
    } as Env);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ configured: false });
  });
});
