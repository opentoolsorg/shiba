import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { OpenConnectorIntegrationProvider, openConnectorConnectionName } from "../src/integrations/openconnector-provider.js";
import { createCustomAgent } from "../src/custom-agents-store.js";
import { handleEmployeeTools } from "../src/employee-tool-routes.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

vi.mock("../src/request-auth.js", () => ({ isAuthorizedRequest: async () => true, resolveUserId: async () => "owner@example.test" }));
vi.mock("../src/gmail-routes.js", () => ({ gmailOwner: async () => '["better-auth","owner-a"]' }));
vi.mock("../src/v1-auth.js", async (original) => ({ ...await original<typeof import("../src/v1-auth.js")>(), authorizeV1Request: async () => null }));

const OWNER = '["better-auth","owner-a"]';
const configured = { OPEN_CONNECTOR_URL: "https://connector.example.test", OPEN_CONNECTOR_ADMIN_TOKEN: "fixture-admin", OPEN_CONNECTOR_RUNTIME_TOKEN: "fixture-runtime" };
afterEach(() => vi.restoreAllMocks());
function expectMetadataOnly(transport: { mock: { calls: Array<[RequestInfo | URL, RequestInit?]> } }): void {
  // Keep this assertion outside the transport: executeTool deliberately catches
  // upstream errors, including an assertion thrown by a fixture fetch function.
  expect(transport.mock.calls.length).toBeGreaterThan(0);
  expect(transport.mock.calls.every(([url, init]) => String(url).endsWith("/api/connections") && (init?.method ?? "GET") === "GET")).toBe(true);
}
function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error("Expected one fixture account");
  return row;
}

async function fixtureRow(authType: string | undefined = "api_key") {
  return { id: "fixture-stable-row", service: "linear", connectionName: await openConnectorConnectionName(OWNER), configured: true,
    virtual: false, source: "local", status: "active", ...(authType ? { authType } : {}), profile: { displayName: "Fixture account" } };
}

describe("operator-managed account provenance boundary (synthetic metadata, no credentials)", () => {
  it.each(["api_key", "custom_credential"])("keeps a configured %s account unavailable and does not offer OAuth reconnect", async (authType) => {
    const row = await fixtureRow(authType);
    const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      return Response.json([row]);
    });
    const provider = new OpenConnectorIntegrationProvider({ env: configured as Env, fetchImpl: transport });
    expect(await provider.listConnections({ userId: OWNER })).toEqual([]);
    const unavailable = await provider.listConnections({ userId: OWNER, includeUnavailable: true });
    expect(unavailable).toEqual([expect.objectContaining({ executionReady: false, reconnectSupported: false,
      unavailableReason: expect.stringContaining("version-pinned operator enrollment") })]);
    expect(unavailable[0]).not.toHaveProperty("authorizationFingerprint");
    expect(await provider.listConnections({ userId: "another-owner", includeUnavailable: true })).toEqual([]);
    expect(await provider.executeTool({ userId: OWNER, toolkitSlug: "linear", toolSlug: "linear.list_issues", arguments: {}, approvedConnectionId: only(unavailable).id })).toMatchObject({ ok: false });
    row.status = "reauth_required";
    expect(await provider.beginConnect({ userId: OWNER, providerKey: "linear", callbackOrigin: "https://shiba.test", replaceUnavailable: true })).toMatchObject({ ok: false,
      error: expect.stringContaining("version-pinned operator enrollment") });
    expectMetadataOnly(transport);
  });

  it.each(["api_key", "custom_credential", "no_auth", "marketplace", "unknown"])("rejects an explicit %s credential even if it carries a copied OAuth marker", async (authType) => {
    const row = { ...await fixtureRow("oauth2"), oauthAuthorizationId: "fixture-consent" };
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://connector.example.test/api/connections");
      expect(init?.method ?? "GET").toBe("GET");
      return Response.json([row]);
    });
    const provider = new OpenConnectorIntegrationProvider({ env: configured as Env, fetchImpl: transport });
    const approved = only(await provider.listConnections({ userId: OWNER }));
    expect(approved.executionReady).toBe(true);
    row.authType = authType;
    expect(await provider.listConnections({ userId: OWNER })).toEqual([]);
    const unavailable = only(await provider.listConnections({ userId: OWNER, includeUnavailable: true }));
    expect(unavailable.executionReady).toBe(false);
    expect(unavailable.reconnectSupported).toBe(false);
    expect(unavailable).not.toHaveProperty("authorizationFingerprint");
    expect(unavailable.id).not.toBe(approved.id);
    expect(await provider.executeTool({ userId: OWNER, toolkitSlug: "linear", toolSlug: "linear.list_issues", arguments: {}, approvedConnectionId: approved.id })).toMatchObject({ ok: false });
    expectMetadataOnly(transport);
  });

  it("does not convert caller-supplied enrollment or revision fields into provenance", async () => {
    const row = { ...await fixtureRow(), revision: "revision-a", credentialGeneration: "generation-a", operatorEnrollmentId: "claimed-enrollment" };
    const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      return Response.json([row]);
    });
    const provider = new OpenConnectorIntegrationProvider({ env: configured as Env, fetchImpl: transport });
    const before = only(await provider.listConnections({ userId: OWNER, includeUnavailable: true }));
    row.revision = "revision-b";
    row.credentialGeneration = "generation-b";
    const after = only(await provider.listConnections({ userId: OWNER, includeUnavailable: true }));
    // An inventory ID is deliberately not an enrollment or credential generation.
    expect(before.id).toBe(after.id);
    expect(before.executionReady).toBe(false);
    expect(after.executionReady).toBe(false);
    expect(await provider.executeTool({ userId: OWNER, toolkitSlug: "linear", toolSlug: "linear.list_issues", arguments: {},
      approvedConnectionId: before.id, connectedAccountId: row.id })).toMatchObject({ ok: false });
    expectMetadataOnly(transport);
  });

  it.each([true, false])("retains completed OAuth generation checks (explicit auth type: %s)", async (explicit) => {
    const row = { ...await fixtureRow(), oauthAuthorizationId: "consent-a" };
    if (explicit) row.authType = "oauth2";
    else delete row.authType;
    const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      return Response.json([row]);
    });
    const provider = new OpenConnectorIntegrationProvider({ env: configured as Env, fetchImpl: transport });
    const before = only(await provider.listConnections({ userId: OWNER }));
    expect(before.executionReady).toBe(true);
    row.oauthAuthorizationId = "consent-b";
    const after = only(await provider.listConnections({ userId: OWNER }));
    expect(after.id).not.toBe(before.id);
    expect(after.authorizationFingerprint).not.toBe(before.authorizationFingerprint);
    expect(await provider.executeTool({ userId: OWNER, toolkitSlug: "linear", toolSlug: "linear.list_issues", arguments: {}, approvedConnectionId: before.id })).toMatchObject({ ok: false });
    expectMetadataOnly(transport);
  });

  it.each(["api_key", "custom_credential"])("cannot grant an employee authority over an unenrolled %s account", async (authType) => {
    const { database, sqlite } = customAgentD1();
    const row = await fixtureRow(authType);
    const transport = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      return Response.json([row]);
    });
    const env = { ...configured, AGENT_AUDIT: database, OPEN_CONNECTOR: { fetch: transport } } as unknown as Env;
    const employee = await createCustomAgent(env, "self-hosted", `unenrolled-${authType}`, { name: "Connector", instructions: "Only use granted resources", harness: "opencode" });
    const response = await handleEmployeeTools(new Request(`https://shiba.test/api/employee-tools/${employee.id}/policy`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedVersion: 1, actorId: "agent-a", role: "operator", resourcesByCapability: { "mcp:shiba:integrations.execute": ["linear"] } }),
    }), env);
    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ error: "integration_connection_not_owned" });
    // Rejection occurs before even initializing the grant or approval stores.
    expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE name IN ('employee_tool_grants','employee_tool_approvals')").all()).toEqual([]);
    expectMetadataOnly(transport);
  });
});
