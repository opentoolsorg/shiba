import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import {
  OpenConnectorIntegrationProvider,
  openConnectorConnectionName,
} from "../src/integrations/openconnector-provider.js";
import { handleIntegrationProviderRoutes } from "../src/integrations-provider-routes.js";
import { resetIntegrationProviderCacheForTests } from "../src/integrations/runtime.js";

const auth = vi.hoisted(() => ({ owner: "alice" }));
vi.mock("../src/request-auth.js", () => ({ isAuthorizedRequest: vi.fn(async () => true) }));
vi.mock("../src/gmail-routes.js", () => ({ gmailOwner: vi.fn(async () => auth.owner) }));
const servers: Server[] = [];
afterEach(async () => {
  resetIntegrationProviderCacheForTests();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("OpenConnector real HTTP service fixture (no vendor accounts)", () => {
  it("executes only the exact approved owner/consent over HTTP and rejects stale or expired authority", async () => {
    const alice = await openConnectorConnectionName("alice"), bob = await openConnectorConnectionName("bob");
    let consent = "fixture-consent-a";
    const dispatched: Array<{ alias: string | undefined; appId: string | undefined; body: unknown }> = [];
    const server = createServer(async (request, response) => {
      const path = new URL(request.url ?? "/", "http://fixture").pathname;
      const reply = (body: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (path === "/api/connections" && request.headers.authorization === "Bearer fixture-admin") {
        reply([alice, bob].map((alias) => ({ id: `app-${alias}`, service: "github", connectionName: alias,
          configured: true, virtual: false, status: "active", oauthAuthorizationId: consent, profile: { displayName: alias } })));
        return;
      }
      if (path === "/v1/actions/github.get_current_user" && request.method === "POST" && request.headers.authorization === "Bearer fixture-runtime") {
        let raw = "";
        for await (const chunk of request) raw += String(chunk);
        dispatched.push({ alias: request.headers["x-oo-connector-alias"] as string | undefined,
          appId: request.headers["x-oo-connector-app-id"] as string | undefined, body: JSON.parse(raw) });
        reply({ success: true, data: { login: "fixture-alice" } });
        return;
      }
      reply({ error: "unauthorized" }, 401);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const provider = new OpenConnectorIntegrationProvider({ env: {
      OPEN_CONNECTOR_URL: `http://127.0.0.1:${address.port}`,
      OPEN_CONNECTOR_ADMIN_TOKEN: "fixture-admin", OPEN_CONNECTOR_RUNTIME_TOKEN: "fixture-runtime",
    } as Env });
    const own = (await provider.listConnections({ userId: "alice" }))[0];
    const foreign = (await provider.listConnections({ userId: "bob" }))[0];
    if (!own || !foreign) throw new Error("Missing scoped fixture account");
    const action = { userId: "alice", toolkitSlug: "github", toolSlug: "github.get_current_user", arguments: {} };
    expect(await provider.executeTool(action)).toMatchObject({ ok: false });
    expect(await provider.executeTool({ ...action, approvedConnectionId: foreign.id })).toMatchObject({ ok: false });
    expect(dispatched).toEqual([]);
    let dispatchChecks = 0;
    expect(await provider.executeTool({ ...action, approvedConnectionId: own.id, approvedUntil: Date.now() + 60_000,
      beforeDispatch: async () => { dispatchChecks++; },
    })).toEqual({ ok: true, status: "completed", output: { login: "fixture-alice" } });
    expect(dispatchChecks).toBe(1);
    expect(dispatched).toEqual([{ alias: alice, appId: `app-${alice}`, body: { input: {} } }]);
    expect(await provider.executeTool({ ...action, approvedConnectionId: own.id, approvedUntil: Date.now() - 1 })).toMatchObject({ ok: false, error: expect.stringContaining("expired") });
    consent = "fixture-consent-b";
    expect(await provider.executeTool({ ...action, approvedConnectionId: own.id })).toMatchObject({ ok: false, error: expect.stringContaining("consent generation") });
    expect(dispatched).toHaveLength(1);
  });

  it("verifies metadata, OAuth setup, per-owner accounts/discovery and disconnect without an unapproved action", async () => {
    const alice = await openConnectorConnectionName("alice"),
      bob = await openConnectorConnectionName("bob");
    let records = [alice, bob, "default"].map((connectionName) => ({
      id: `id-${connectionName}`,
      service: "github",
      connectionName,
      configured: true,
      virtual: false,
      status: "active",
      oauthAuthorizationId: `fixture-consent-${connectionName}`,
      profile: { displayName: connectionName },
    }));
    let actionCalls = 0,
      oauthCalls = 0;
    const seenAliases: string[] = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture");
      const reply = (body: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (url.pathname === "/health") {
        reply({ ok: true });
        return;
      }
      const token = url.pathname.startsWith("/api/") || url.pathname.endsWith("/setup") ? "fixture-admin" : "fixture-runtime";
      if (request.headers.authorization !== `Bearer ${token}`) {
        reply({ error: "unauthorized" }, 401);
        return;
      }
      if (url.pathname === "/api/providers") {
        reply([{ service: "github", displayName: "GitHub", authTypes: ["oauth2"] }]);
        return;
      }
      if (url.pathname === "/v1/providers") {
        reply({ success: true, data: [] });
        return;
      }
      if (url.pathname === "/v1/providers/github/setup") {
        reply({
          success: true,
          data: { service: "github", oauthClient: { configured: true, missingFields: [] } },
        });
        return;
      }
      if (url.pathname === "/api/connections") {
        reply(records);
        return;
      }
      if (url.pathname === "/api/oauth/authorizations") {
        oauthCalls++;
        reply({ authorizationUrl: "https://oauth.example.test/fixture", state: "new-fixture-consent" });
        return;
      }
      if (url.pathname === "/api/connections/github" && request.method === "DELETE") {
        let raw = "";
        for await (const chunk of request) raw += String(chunk);
        const body = JSON.parse(raw) as { connectionName: string };
        records = records.filter((row) => row.connectionName !== body.connectionName);
        reply({ disconnected: true });
        return;
      }
      if (url.pathname === "/v1/actions/search") {
        seenAliases.push(String(request.headers["x-oo-connector-alias"]));
        reply({
          success: true,
          data: [
            {
              id: "github.get_current_user",
              service: "github",
              name: "Read current user",
              inputSchema: { type: "object" },
            },
          ],
        });
        return;
      }
      if (request.method === "POST" && url.pathname.startsWith("/v1/actions/")) actionCalls++;
      reply({ error: "not_found" }, 404);
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    const env = {
      OPEN_CONNECTOR_URL: `http://127.0.0.1:${address.port}`,
      OPEN_CONNECTOR_ADMIN_TOKEN: "fixture-admin",
      OPEN_CONNECTOR_RUNTIME_TOKEN: "fixture-runtime",
    } as Env;
    // Match the pinned upstream auth matrix: setup metadata is admin scoped,
    // even though its URL has the /v1 prefix.
    expect((await fetch(`${env.OPEN_CONNECTOR_URL}/v1/providers/github/setup`, { headers: { authorization: "Bearer fixture-runtime" } })).status).toBe(401);
    const provider = new OpenConnectorIntegrationProvider({ env });
    expect((await provider.health()).status).toBe("healthy");
    const catalog = await provider.listCatalog({ userId: "alice", limit: 20 });
    expect(catalog.items[0]).toMatchObject({
      connectable: true,
      setupState: "ready",
      connectionId: expect.stringMatching(/^ocg_/),
    });
    for (const owner of ["alice", "bob"]) {
      auth.owner = owner;
      const result = await handleIntegrationProviderRoutes(
        new Request("https://shiba.test/api/integrations/provider/connections"),
        env,
      );
      const body = (await result?.json()) as { connections: Array<{ id: string; identityLabel: string; executionReady: boolean }> };
      expect(body.connections).toHaveLength(1);
      expect(body.connections[0]).toMatchObject({ id: expect.stringMatching(/^ocg_/), identityLabel: owner === "alice" ? alice : bob, executionReady: true });
      await provider.searchActions({ userId: owner, toolkitSlug: "github", limit: 20 });
    }
    expect(seenAliases).toEqual([alice, bob]);
    auth.owner = "alice";
    const denied = await handleIntegrationProviderRoutes(
      new Request("https://shiba.test/api/integrations/provider/execute", {
        method: "POST",
        headers: { Origin: "https://shiba.test", "content-type": "application/json" },
        body: JSON.stringify({
          toolSlug: "github.get_current_user",
          arguments: {},
          connectedAccountId: `id-${bob}`,
        }),
      }),
      env,
    );
    expect(denied?.status).toBe(403);
    expect(actionCalls).toBe(0);
    const context = { userId: "alice", providerKey: "github", callbackOrigin: "https://shiba.test" };
    expect(await provider.beginConnect(context)).toMatchObject({ ok: false, error: expect.stringContaining("Disconnect") });
    expect(oauthCalls).toBe(0);
    await provider.disconnect({
      userId: "alice",
      providerKey: "github",
      callbackOrigin: "https://shiba.test",
    });
    expect(await provider.listConnections({ userId: "alice" })).toEqual([]);
    expect(await provider.beginConnect(context)).toMatchObject({ ok: true, authorizationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(oauthCalls).toBe(1);
    expect(await provider.listConnections({ userId: "bob" })).toHaveLength(1);
    expect(records.some((row) => row.connectionName === "default")).toBe(true);
  });
});
