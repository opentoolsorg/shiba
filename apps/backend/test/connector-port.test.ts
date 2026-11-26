import { describe, expect, it } from "vitest";
import type { Env } from "../src/env.js";
import { connectorProviderContract, type ConnectorContractFactory } from "../src/ports/connector/contract.js";
import { createConnectorProvider } from "../src/ports/connector/registry.js";

const configuredEnv = {
  CONNECTOR_PROVIDER: "openconnector",
  OPEN_CONNECTOR_URL: "https://connector.example.test",
  OPEN_CONNECTOR_ADMIN_TOKEN: "fixture-admin",
  OPEN_CONNECTOR_RUNTIME_TOKEN: "fixture-runtime",
} as Env;

function contractFactory(configured: boolean): ConnectorContractFactory {
  return {
    configured,
    async create(options = {}) {
      const calls: Array<{ path: string; method: string; body: unknown }> = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? "GET";
        calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (options.status) return new Response("private upstream body", { status: options.status });
        if (path === "/health") return Response.json({ ok: true });
        if (path === "/api/providers") return Response.json([{ service: "github", displayName: "GitHub", authTypes: ["oauth2"] }]);
        if (path === "/api/connections") return Response.json(options.connected ? [
          { id: "alice-account", service: "github", connectionName: "u_2bd806c97f0e00af", configured: true, virtual: false, oauthAuthorizationId: "alice-consent", profile: { displayName: "Alice" } },
          { id: "bob-account", service: "github", connectionName: "u_81b637d8fcd2c6da", configured: true, virtual: false, oauthAuthorizationId: "bob-consent", profile: { displayName: "Bob" } },
        ] : []);
        if (path === "/v1/providers") return Response.json({ success: true, data: [] });
        if (path.endsWith("/setup")) return Response.json({ success: true, data: { service: "github", oauthClient: { configured: true, missingFields: [] } } });
        if (path === "/api/oauth/authorizations") return Response.json({ authorizationUrl: "https://github.example.test/authorize", state: "fixture-state" });
        if (path === "/api/connections/github" && method === "DELETE") return Response.json({ disconnected: true });
        if (path === "/v1/actions/search") return Response.json({ success: true, data: [{ id: "github.get_current_user", service: "github", name: "Current user", inputSchema: { type: "object", properties: {} }, operationType: "read" }] });
        if (path === "/v1/actions/github.get_current_user" && method === "POST") return Response.json({ success: true, data: { login: "alice" } });
        throw new Error(`Unexpected fake gateway request: ${method} ${path}`);
      };
      return { provider: createConnectorProvider(configured ? configuredEnv : { CONNECTOR_PROVIDER: "none" } as Env, { fetchImpl }), calls };
    },
  };
}

connectorProviderContract("OpenConnector", contractFactory(true));
connectorProviderContract("none", contractFactory(false));

describe("connector registry", () => {
  it("accepts an injected provider", async () => {
    const { provider } = await contractFactory(false).create();
    expect(createConnectorProvider(configuredEnv, { provider })).toBe(provider);
  });

  it("selects the explicit none adapter even with an OpenConnector binding", () => {
    expect(createConnectorProvider({ ...configuredEnv, CONNECTOR_PROVIDER: "none" }).adapterId).toBe("none");
  });

  it("reports missing OpenConnector setup through the port error", async () => {
    const provider = createConnectorProvider({ CONNECTOR_PROVIDER: "openconnector" } as Env);
    await expect(provider.listConnections({ userId: "alice" })).rejects.toMatchObject({ code: "not_configured" });
  });
});
