import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleIntegrationProviderRoutes } from "../src/integrations-provider-routes.js";
import { handleMeta } from "../src/meta-routes.js";
import type { SetupStatus } from "../src/setup-status.js";

vi.mock("../src/gmail-routes.js", () => ({ gmailOwner: async () => "alice" }));
vi.mock("../src/request-auth.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/request-auth.js")>(),
  isAuthorizedRequest: async () => true,
}));

const origin = "https://shiba.example.test";
const connectorTokens = {
  OPEN_CONNECTOR_ADMIN_TOKEN: "fixture-admin",
  OPEN_CONNECTOR_RUNTIME_TOKEN: "fixture-runtime",
};

function setupEnv(overrides: Partial<Env>) {
  return { GATEWAY_ID: "default", ORCHESTRATOR_MODEL: "", CODING_MODEL: "", ...overrides } as Env;
}

describe("connector setup across dashboard routes", () => {
  it.each(["catalog", "connections"])("returns a setup state for %s when no service is configured", async (endpoint) => {
    const response = await handleIntegrationProviderRoutes(new Request(`https://shiba.example.test/api/integrations/provider/${endpoint}`), {} as Env);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ configured: false });
  });

  it.each([
    { reason: "disabled", overrides: { ...connectorTokens, CONNECTOR_PROVIDER: "none" } },
    { reason: "missing runtime token", overrides: { OPEN_CONNECTOR_ADMIN_TOKEN: connectorTokens.OPEN_CONNECTOR_ADMIN_TOKEN } },
  ])("reports setup required when $reason, even with a service binding", async ({ reason, overrides }) => {
    const fetch = vi.fn(() => { throw new Error("Unexpected OpenConnector call"); });
    const env = setupEnv({ OPEN_CONNECTOR: { fetch } as unknown as Fetcher, ...overrides });
    const status = await handleMeta(new Request(`${origin}/api/setup/status`), env);
    if (!status) throw new Error("Missing setup status response");
    expect(status.status).toBe(200);
    const body = await status.json() as SetupStatus;
    expect(body.deployment).toMatchObject({ openConnectorBound: true, openConnectorEnabled: false });
    const connectorSecrets = body.missingSecrets.filter((row) => row.secretName.startsWith("OPEN_CONNECTOR_"));
    if (reason === "disabled") expect(connectorSecrets).toEqual([]);
    else expect(connectorSecrets).toContainEqual(expect.objectContaining({ secretName: "OPEN_CONNECTOR_RUNTIME_TOKEN", present: false }));

    for (const endpoint of ["catalog", "connections"]) {
      const response = await handleIntegrationProviderRoutes(new Request(`${origin}/api/integrations/provider/${endpoint}`), env);
      expect(response?.status).toBe(200);
      expect(await response?.json()).toMatchObject({ configured: false });
    }
    const connect = await handleIntegrationProviderRoutes(new Request(`${origin}/api/integrations/provider/connect`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ providerKey: "stripe" }),
    }), env);
    expect(connect?.status).toBe(409);
    expect(await connect?.json()).toMatchObject({ configured: false, code: "setup_required" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a configured default adapter", async () => {
    const status = await handleMeta(new Request(`${origin}/api/setup/status`), setupEnv({
      ...connectorTokens, OPEN_CONNECTOR_URL: "https://connector.example.test",
    }));
    expect(await status?.json()).toMatchObject({ deployment: { openConnectorBound: true, openConnectorEnabled: true } });
  });
});
