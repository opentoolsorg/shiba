import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import {
  createExternalMcpServer,
  disableExternalMcpServer,
  discoverExternalMcpServer,
  getExternalMcpServer,
  listExternalMcpCatalogConnections,
  listExternalMcpTools,
  updateExternalMcpServer,
  reviewExternalMcpTool,
  setExternalMcpAccess,
  setExternalMcpToolEnabled,
} from "../src/external-mcp.js";
import {
  beginExternalMcpOAuthConnect,
  discoverExternalMcpOAuth,
  exchangeExternalMcpOAuthCode,
  loadExternalMcpOAuthTokens,
  saveExternalMcpOAuthTokens,
  resolveExternalMcpBearer,
  deleteExternalMcpOAuthTokens,
  saveExternalMcpBearerToken,
  ensureExternalMcpOAuthSchema,
} from "../src/external-mcp-oauth.js";
import { CURATED_MCP_VENDORS, curatedMcpVendorByCatalogId, recommendedExternalMcpToolEffect } from "@shiba/shared";
import { createToolRegistry, visibleToolsForPrincipal } from "../src/mcp-gateway.js";
import { registerExternalMcpTools } from "../src/external-mcp.js";
import { listAuditEntries } from "../src/audit.js";
import { externalMcpD1 } from "./fixtures/external-mcp-schema.js";
import { handleMcp as handleMcpV1 } from "../src/v1/mcp.js";
import type { V1Context } from "../src/v1/context.js";

const KEY = "ab".repeat(32);
const owner = { principal: "owner@example.test", orgId: "org-a", scopes: ["api:read" as const, "api:write" as const] };
const agent = { kind: "agent" as const, principal: "assistant-agent", orgId: "org-a", scopes: ["mcp:external" as const], created: 1, revoked: false };
const stripeEndpoint = "https://mcp.stripe.com";
const remoteTools = [
  { name: "list_customers", description: "List customers", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "create_refund", description: "Create refund", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
];

function environment(clientId = "shiba_test_stripe_client") {
  const { database, sqlite } = externalMcpD1();
  return {
    sqlite,
    env: {
      AGENT_AUDIT: database,
      AGENT_TOKENS: { put: async () => {}, get: async () => null, list: async () => ({ keys: [], list_complete: true }) },
      MCP_TRUSTED_HOSTS: "mcp.example.com",
      MCP_OAUTH_CLIENT_STRIPE: clientId,
      MODEL_CREDENTIAL_KEY: KEY,
    } as unknown as Env,
  };
}

function mockDiscoveryFetch(endpoint = stripeEndpoint) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({
        resource: endpoint,
        authorization_servers: ["https://auth.vendor.com"],
        bearer_methods_supported: ["header"],
      });
    }
    if (url.pathname.endsWith("oauth-authorization-server")) {
      return Response.json({
        issuer: "https://auth.vendor.com",
        authorization_endpoint: "https://auth.vendor.com/oauth/authorize",
        token_endpoint: "https://auth.vendor.com/oauth/token",
        revocation_endpoint: "https://auth.vendor.com/oauth/revoke",
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.href === "https://auth.vendor.com/oauth/token") {
      return Response.json({ access_token: "vendor-access-token", expires_in: 3600, token_type: "Bearer" });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  });
}

function mockMcp(endpoint: string) {
  const normalized = new URL(endpoint).href;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href !== normalized) throw new Error(`untrusted ${url.href} expected ${normalized}`);
    if (init?.method === "GET") return new Response("GET unsupported", { status: 405 });
    const request = JSON.parse(typeof init?.body === "string" ? init.body : "") as { id: number; method: string };
    if (request.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
    }
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (request.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: request.id, result: { tools: remoteTools } });
    if (request.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "ok" }] } });
    throw new Error(request.method);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("external MCP OAuth + multi-account", () => {
  it.each(["oauth", "bearer_ref"])("rejects a raw %s registration that labels another vendor's endpoint as Stripe", async (authMode) => {
    const { env, sqlite } = environment();
    await getExternalMcpServer(env, owner.orgId, owner.principal, "a".repeat(32));
    await ensureExternalMcpOAuthSchema(env);
    await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, "a".repeat(32));
    const network = vi.fn(async () => { throw new Error("Unexpected vendor request in registration fixture"); });
    vi.stubGlobal("fetch", network);
    const url = new URL("https://shiba.test/api/v1/mcp/servers");
    const response = await handleMcpV1({ url, env, principal: owner, forward: async () => new Response(),
      request: new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        name: "Stripe misleading endpoint", transport: "streamable_http", catalogId: "stripe", connectionLabel: "mismatch",
        url: "https://mcp.notion.com/mcp", authMode, credentialRef: authMode === "bearer_ref" ? "MCP_CREDENTIAL_STRIPE" : null,
      }) }),
    });
    expect(response?.status).toBe(400);
    expect(await response!.json()).toEqual({ ok: false, error: "invalid_endpoint" });
    for (const table of ["external_mcp_servers", "external_mcp_tools", "external_mcp_oauth_pending", "user_subscription_credentials"]) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({ count: 0 });
    }
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    { name: "custom", input: { name: "Custom MCP", url: "https://mcp.example.com/mcp", credentialRef: null }, endpoint: "https://mcp.example.com/mcp", catalogId: null },
    { name: "default curated", input: { catalogId: "stripe", connectionLabel: "canonical", authMode: "oauth", credentialRef: null }, endpoint: stripeEndpoint, catalogId: "stripe" },
  ])("preserves raw $name registration without enabling tools or making vendor requests", async ({ input, endpoint, catalogId }) => {
    const { env } = environment();
    const network = vi.fn(async () => { throw new Error("Unexpected vendor request in registration fixture"); });
    vi.stubGlobal("fetch", network);
    const url = new URL("https://shiba.test/api/v1/mcp/servers");
    const response = await handleMcpV1({ url, env, principal: owner, forward: async () => new Response(),
      request: new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }),
    });
    expect(response?.status).toBe(201);
    const body = await response!.json() as { server: { id: string; endpoint: string; catalogId: string | null; status: string } };
    expect(body.server).toMatchObject({ endpoint, catalogId, status: "draft" });
    expect(await listExternalMcpTools(env, body.server.id)).toEqual([]);
    expect(await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, body.server.id)).toBeNull();
    expect(network).not.toHaveBeenCalled();
  });

  it.each(CURATED_MCP_VENDORS.filter((vendor) => vendor.connectionMethods.includes("oauth")))("completes a local authorized OAuth fixture for $name without enabling tools or exposing another owner's credentials", async (vendor) => {
    const { env } = environment();
    const fetchFixture = mockDiscoveryFetch(vendor.endpoint);
    const discovery = await discoverExternalMcpOAuth(vendor, fetchFixture);
    const server = await createExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, name: vendor.name,
      endpoint: vendor.endpoint, credentialRef: null, catalogId: vendor.catalogId, connectionLabel: "fixture", authMode: "oauth" });
    const consent = await beginExternalMcpOAuthConnect(env, { serverId: server!.id, orgId: owner.orgId, ownerId: owner.principal,
      catalogId: vendor.catalogId, redirectUri: "https://app.test/api/v1/mcp/oauth/callback", clientId: "fixture-preregistered-client", scopes: "", discovery });
    const authorization = new URL(consent.authorizationUrl);
    expect(authorization.searchParams.get("resource")).toBe(vendor.endpoint);
    expect(authorization.searchParams.has("scope")).toBe(false);
    await exchangeExternalMcpOAuthCode(env, { state: consent.state, code: "fixture-code", principal: owner }, fetchFixture);
    const tokenCall = fetchFixture.mock.calls.find(([url]) => String(url) === "https://auth.vendor.com/oauth/token");
    expect(new URLSearchParams(String(tokenCall?.[1]?.body)).get("resource")).toBe(vendor.endpoint);
    expect(await loadExternalMcpOAuthTokens(env, owner.orgId, "other-owner", server!.id)).toBeNull();
    expect(await getExternalMcpServer(env, owner.orgId, owner.principal, server!.id)).toMatchObject({ status: "draft" });
    expect(await listExternalMcpTools(env, server!.id)).toEqual([]);
    await expect(exchangeExternalMcpOAuthCode(env, { state: consent.state, code: "fixture-code", principal: owner }, fetchFixture)).rejects.toThrow("oauth_state_invalid");
  });

  it.each(CURATED_MCP_VENDORS.filter((vendor) => !vendor.connectionMethods.includes("oauth")))("keeps $name bearer setup private, disabled and separate from unsupported OAuth", async (vendor) => {
    const { env } = environment();
    const network = mockMcp(vendor.endpoint);
    vi.stubGlobal("fetch", network);
    const server = (await createExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, name: vendor.name,
      endpoint: vendor.endpoint, credentialRef: null, catalogId: vendor.catalogId, connectionLabel: "fixture", authMode: "oauth" }))!;
    const url = new URL(`https://shiba.test/api/v1/mcp/servers/${server.id}/oauth/begin`);
    const response = await handleMcpV1({ url, env, principal: owner, forward: async () => new Response(),
      request: new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirectUri: "https://shiba.test/api/v1/mcp/oauth/callback" }) }),
    });
    expect(response?.status).toBe(400);
    expect(await response!.json()).toEqual({ ok: false, error: "unsupported_auth_method" });
    const discovery = await discoverExternalMcpOAuth(vendor, mockDiscoveryFetch(vendor.endpoint));
    await expect(beginExternalMcpOAuthConnect(env, { serverId: server.id, orgId: owner.orgId, ownerId: owner.principal,
      catalogId: vendor.catalogId, redirectUri: "https://shiba.test/api/v1/mcp/oauth/callback", clientId: "unsupported", scopes: "", discovery })).rejects.toThrow("unsupported_auth_method");
    expect(network).not.toHaveBeenCalled();
    await saveExternalMcpBearerToken(env, owner.orgId, owner.principal, server.id, "restricted-fixture-token", server.generation);
    expect(await loadExternalMcpOAuthTokens(env, owner.orgId, "other-owner", server.id)).toBeNull();
    expect(await getExternalMcpServer(env, owner.orgId, owner.principal, server.id)).toMatchObject({ status: "draft", visibility: "private" });
    expect(await listExternalMcpTools(env, server.id)).toEqual([]);
    await discoverExternalMcpServer(env, server);
    const tools = await listExternalMcpTools(env, server.id);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((tool) => !tool.enabled && tool.effect === "unreviewed" && tool.recommendedEffect === "approval_required")).toBe(true);
    expect(recommendedExternalMcpToolEffect(vendor.catalogId, "new_vendor_tool")).toBe("approval_required");
    const authenticated = network.mock.calls.find(([, init]) => init?.method === "POST");
    expect(new Headers(authenticated?.[1]?.headers).get("Authorization")).toBe("Bearer restricted-fixture-token");
    expect(network.mock.calls.every(([input]) => String(input instanceof Request ? input.url : input) === vendor.endpoint)).toBe(true);
  });

  it.each(CURATED_MCP_VENDORS.filter((vendor) => !vendor.connectionMethods.includes("bearer")))("rejects static bearer routes and credential references for $name", async (vendor) => {
    const { env } = environment();
    const input = { orgId: owner.orgId, ownerId: owner.principal, name: vendor.name,
      endpoint: vendor.endpoint, credentialRef: null, catalogId: vendor.catalogId, connectionLabel: "fixture", authMode: "oauth" as const };
    const server = (await createExternalMcpServer(env, input))!;
    await expect(saveExternalMcpBearerToken(env, owner.orgId, owner.principal, server.id, "not-supported")).rejects.toThrow("unsupported_auth_method");
    await expect(createExternalMcpServer(env, { ...input, connectionLabel: "ref", credentialRef: "MCP_CREDENTIAL_TOKEN" })).rejects.toThrow("unsupported_auth_method");
    await expect(updateExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, id: server.id, credentialRef: "MCP_CREDENTIAL_TOKEN" })).rejects.toThrow("unsupported_auth_method");
    expect(await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, server.id)).toBeNull();
  });

  it.each(["github-readonly", "linear-readonly"])("pins the %s endpoint and requires authentication", async (catalogId) => {
    const { env } = environment();
    const vendor = curatedMcpVendorByCatalogId(catalogId)!;
    const input = { orgId: owner.orgId, ownerId: owner.principal, name: vendor.name,
      endpoint: vendor.endpoint, credentialRef: null, catalogId, connectionLabel: "fixture", authMode: "oauth" as const };
    await expect(createExternalMcpServer(env, { ...input, authMode: "none" })).rejects.toThrow("unsupported_auth_method");
    await expect(createExternalMcpServer(env, { ...input, endpoint: vendor.endpoint.replace("/readonly", "") })).rejects.toThrow("invalid_endpoint");
    const server = (await createExternalMcpServer(env, input))!;
    await expect(updateExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, id: server.id,
      endpoint: vendor.endpoint.replace("/readonly", "") })).rejects.toThrow("invalid_endpoint");
  });

  it("discovers endpoint-specific metadata and a path-scoped OIDC issuer", async () => {
    const calls: string[] = [];
    const fixtureFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      if (url === "https://mcp.example.com/tenant/mcp") return new Response(null, { status: 405 });
      if (url.endsWith("/.well-known/oauth-protected-resource/tenant/mcp")) return Response.json({ resource: "https://mcp.example.com/tenant/mcp", authorization_servers: ["https://auth.vendor.com/tenant"] });
      if (url.endsWith("/.well-known/openid-configuration/tenant")) return Response.json({ issuer: "https://auth.vendor.com/tenant", authorization_endpoint: "https://auth.vendor.com/authorize", token_endpoint: "https://auth.vendor.com/token", code_challenge_methods_supported: ["S256"] });
      return new Response(null, { status: 404 });
    });
    const discovery = await discoverExternalMcpOAuth({ endpoint: "https://mcp.example.com/tenant/mcp" }, fixtureFetch);
    expect(discovery.authorizationServer.issuer).toBe("https://auth.vendor.com/tenant");
    expect(calls).toContain("https://auth.vendor.com/.well-known/oauth-authorization-server/tenant");
    expect(calls).toContain("https://auth.vendor.com/.well-known/openid-configuration/tenant");
  });

  it("honors a bounded resource metadata challenge and its requested scopes", async () => {
    const discovery = await discoverExternalMcpOAuth({ endpoint: "https://mcp.example.com/mcp" }, vi.fn(async (input) => {
      const url = String(input);
      if (url === "https://mcp.example.com/mcp") return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://mcp.example.com/auth-metadata", scope="reports:read"' } });
      if (url.endsWith("/auth-metadata")) return Response.json({ resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.vendor.com"] });
      return Response.json({ issuer: "https://auth.vendor.com", authorization_endpoint: "https://auth.vendor.com/authorize", token_endpoint: "https://auth.vendor.com/token", code_challenge_methods_supported: ["S256"] });
    }));
    expect(discovery.scopes).toBe("reports:read");
  });

  it.each(["authorization_endpoint", "token_endpoint", "revocation_endpoint"].flatMap((field) =>
    ["http://127.0.0.1/token", "https://127.0.0.1/token", "https://user:password@auth.vendor.com/token", "https://metadata.internal/token"].map((endpoint) => ({ field, endpoint })),
  ))("rejects unsafe delegated $field $endpoint before using it", async ({ field, endpoint }) => {
    const calls: string[] = [];
    const fixtureFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); calls.push(url);
      if (url === stripeEndpoint || url === `${stripeEndpoint}/`) return new Response(null, { status: 405 });
      if (url.includes("oauth-protected-resource")) return Response.json({ resource: stripeEndpoint, authorization_servers: ["https://auth.vendor.com"] });
      return Response.json({ issuer: "https://auth.vendor.com", authorization_endpoint: "https://auth.vendor.com/authorize", token_endpoint: "https://auth.vendor.com/token", revocation_endpoint: "https://auth.vendor.com/revoke", code_challenge_methods_supported: ["S256"], [field]: endpoint });
    });
    await expect(discoverExternalMcpOAuth({ endpoint: stripeEndpoint }, fixtureFetch)).rejects.toThrow("oauth_discovery_failed");
    expect(calls).not.toContain(endpoint);
  });

  it("never restores credentials when the connection is revoked during code exchange", async () => {
    const { env } = environment(), vendor = curatedMcpVendorByCatalogId("stripe")!;
    const discovery = await discoverExternalMcpOAuth(vendor, mockDiscoveryFetch());
    const server = await createExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, name: "Stripe", endpoint: vendor.endpoint,
      credentialRef: null, catalogId: vendor.catalogId, connectionLabel: "revoked", authMode: "oauth" });
    const consent = await beginExternalMcpOAuthConnect(env, { serverId: server!.id, orgId: owner.orgId, ownerId: owner.principal,
      catalogId: vendor.catalogId, redirectUri: "https://app.test/callback", clientId: "fixture-client", scopes: "", discovery });
    const exchange = async () => { await disableExternalMcpServer(env, server!); return Response.json({ access_token: "late-token" }); };
    await expect(exchangeExternalMcpOAuthCode(env, { state: consent.state, code: "fixture-code", principal: owner }, exchange)).rejects.toThrow("oauth_state_invalid");
    expect(await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, server!.id)).toBeNull();
  });

  it.each(["revoke", "replace"])("does not overwrite credentials after a %s during refresh", async (action) => {
    const { env } = environment();
    await saveExternalMcpOAuthTokens(env, owner.orgId, owner.principal, "server", { accessToken: "old", refreshToken: "old-refresh", expiresAt: 0,
      tokenType: "Bearer", tokenEndpoint: "https://auth.vendor.com/token", clientId: "fixture-client", resource: stripeEndpoint });
    const refreshed = await resolveExternalMcpBearer(env, owner.orgId, owner.principal, "server", async (_input, init) => {
      expect(new URLSearchParams(String(init?.body)).get("resource")).toBe(stripeEndpoint);
      if (action === "revoke") await deleteExternalMcpOAuthTokens(env, owner.orgId, owner.principal, "server");
      else await saveExternalMcpOAuthTokens(env, owner.orgId, owner.principal, "server", { accessToken: "new-login", expiresAt: Date.now() + 3600000, tokenType: "Bearer" });
      return Response.json({ access_token: "stale-rotation" });
    });
    expect(refreshed).toBeUndefined();
    expect((await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, "server"))?.accessToken).toBe(action === "replace" ? "new-login" : undefined);
  });

  it("keeps curated endpoints fixed and deletes generic credentials when their destination changes", async () => {
    const { env } = environment();
    const curated = await createExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, name: "Stripe", endpoint: stripeEndpoint,
      credentialRef: null, catalogId: "stripe", connectionLabel: "fixed", authMode: "oauth" });
    await expect(updateExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, id: curated!.id, endpoint: "https://mcp.notion.com/mcp" })).rejects.toThrow("invalid_endpoint");
    const custom = await createExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, name: "Custom", endpoint: "https://mcp.example.com/mcp", credentialRef: null });
    await saveExternalMcpOAuthTokens(env, owner.orgId, owner.principal, custom!.id, { accessToken: "old-destination-token", expiresAt: Date.now()+3600000, tokenType: "Bearer" });
    await updateExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, id: custom!.id, endpoint: "https://other.example.com/mcp" });
    expect(await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, custom!.id)).toBeNull();
  });

  it("rolls endpoint and credential changes back together on injected storage failure", async () => {
    const { env, sqlite } = environment();
    const server = await createExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, name: "Atomic custom", endpoint: "https://mcp.example.com/mcp", credentialRef: null });
    await saveExternalMcpOAuthTokens(env, owner.orgId, owner.principal, server!.id, { accessToken: "old-bound-token", expiresAt: Date.now()+3600000, tokenType: "Bearer" });
    sqlite.exec("CREATE TRIGGER reject_credential_delete BEFORE DELETE ON user_subscription_credentials BEGIN SELECT RAISE(ABORT,'injected delete failure'); END");
    await expect(updateExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, id: server!.id, endpoint: "https://other.example.com/mcp" })).rejects.toThrow("injected delete failure");
    expect(await getExternalMcpServer(env, owner.orgId, owner.principal, server!.id)).toMatchObject({ endpoint: server!.endpoint, generation: server!.generation });
    expect((await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, server!.id))?.accessToken).toBe("old-bound-token");
    sqlite.exec("DROP TRIGGER reject_credential_delete");
    await updateExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, id: server!.id, endpoint: "https://other.example.com/mcp" });
    expect(await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, server!.id)).toBeNull();
  });

  it("refuses stale or disabled bearer saves without restoring credentials", async () => {
    const { env } = environment();
    const server = await createExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, name: "Stale bearer", endpoint: "https://mcp.example.com/mcp", credentialRef: null });
    await updateExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, id: server!.id, endpoint: "https://other.example.com/mcp" });
    await expect(saveExternalMcpBearerToken(env, owner.orgId, owner.principal, server!.id, "fixture-long-bearer-token", server!.generation)).rejects.toThrow("oauth_state_invalid");
    const fresh = await getExternalMcpServer(env, owner.orgId, owner.principal, server!.id);
    await disableExternalMcpServer(env, fresh!);
    await expect(saveExternalMcpBearerToken(env, owner.orgId, owner.principal, server!.id, "fixture-long-bearer-token")).rejects.toThrow("oauth_state_invalid");
    expect(await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, server!.id)).toBeNull();
  });

  it("requires a new labeled connection instead of replacing an existing vendor account under the same approval identity", async () => {
    const { env, sqlite } = environment(), vendor = curatedMcpVendorByCatalogId("stripe")!;
    const server = await createExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, name: "Account one", endpoint: vendor.endpoint,
      credentialRef: null, catalogId: "stripe", connectionLabel: "account-one", authMode: "oauth" });
    await saveExternalMcpBearerToken(env, owner.orgId, owner.principal, server!.id, "original-account-token", server!.generation);
    await expect(saveExternalMcpBearerToken(env, owner.orgId, owner.principal, server!.id, "replacement-account-token", server!.generation)).rejects.toThrow("oauth_state_invalid");
    const discovery = await discoverExternalMcpOAuth(vendor, mockDiscoveryFetch());
    await expect(beginExternalMcpOAuthConnect(env, { serverId: server!.id, orgId: owner.orgId, ownerId: owner.principal, catalogId: "stripe",
      redirectUri: "https://app.test/callback", clientId: "fixture-client", scopes: "", discovery })).rejects.toThrow("oauth_state_invalid");
    sqlite.prepare("UPDATE external_mcp_servers SET status='enabled',schema_version='reviewed-schema' WHERE id=?").run(server!.id);
    await expect(saveExternalMcpBearerToken(env, owner.orgId, owner.principal, server!.id, "replacement-account-token", server!.generation)).rejects.toThrow("oauth_state_invalid");
    expect((await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, server!.id))?.accessToken).toBe("original-account-token");
    expect((await getExternalMcpServer(env, owner.orgId, owner.principal, server!.id))?.generation).toBe(server!.generation);
  });

  it.each([{ access_token: {} }, { access_token: "value", expires_in: -1 }, { access_token: "value", token_type: "Basic" }, { access_token: "x".repeat(40_000) }])("rejects malformed or oversized token material without saving it", async (invalid) => {
    const { env } = environment();
    await saveExternalMcpOAuthTokens(env, owner.orgId, owner.principal, "invalid-token-server", { accessToken: "old-access", refreshToken: "refresh", expiresAt: 0,
      tokenType: "Bearer", tokenEndpoint: "https://auth.vendor.com/token", clientId: "fixture-client" });
    await expect(resolveExternalMcpBearer(env, owner.orgId, owner.principal, "invalid-token-server", async () => Response.json(invalid))).rejects.toThrow("oauth_token_exchange_failed");
    expect((await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, "invalid-token-server"))?.accessToken).toBe("old-access");
  });

  it.each(["stripe_api_write", "convert_currency", "send_money", "setup_recipient", "transfer_money", "atlas_company_formation", "send_stripe_feedback"])("suggests explicit approval for Stripe mutation tool %s", (name) => {
    expect(recommendedExternalMcpToolEffect("stripe", name)).toBe("approval_required");
  });
  it("discovers RFC 9728 metadata and completes PKCE code exchange", async () => {
    const { env } = environment();
    const vendor = curatedMcpVendorByCatalogId("stripe")!;
    const discoveryFetch = mockDiscoveryFetch();
    const discovery = await discoverExternalMcpOAuth(vendor, discoveryFetch);
    expect(discovery.authorizationServer.token_endpoint).toContain("auth.vendor.com");

    const prod = await createExternalMcpServer(env, {
      orgId: "org-a", ownerId: owner.principal, name: "Stripe prod", endpoint: vendor.endpoint, credentialRef: null,
      catalogId: "stripe", connectionLabel: "prod", visibility: "workspace", authMode: "oauth",
    });
    const begin = await beginExternalMcpOAuthConnect(env, {
      serverId: prod!.id,
      orgId: "org-a",
      ownerId: owner.principal,
      catalogId: "stripe",
      redirectUri: "https://app.test/oauth/callback",
      clientId: "shiba_test_stripe_client",
      scopes: "openid",
      discovery,
    });
    expect(begin.authorizationUrl).toContain("code_challenge=");
    const state = new URL(begin.authorizationUrl).searchParams.get("state")!;
    for (const principal of [{ ...owner, orgId: "other-org" }, { ...owner, principal: "other-owner" }]) {
      await expect(exchangeExternalMcpOAuthCode(env, { state, code: "vendor-code", principal }, discoveryFetch)).rejects.toThrow("oauth_state_invalid");
    }
    expect(discoveryFetch.mock.calls.some(([input]) => String(input) === "https://auth.vendor.com/oauth/token")).toBe(false);
    await exchangeExternalMcpOAuthCode(env, { state, code: "vendor-code", principal: owner }, discoveryFetch);
    expect(await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, prod!.id)).toMatchObject({
      tokenEndpoint: "https://auth.vendor.com/oauth/token", clientId: "shiba_test_stripe_client",
      revocationEndpoint: "https://auth.vendor.com/oauth/revoke",
    });
    const audit = await listAuditEntries(env, { limit: 5 });
    expect(audit.some((row) => row.tool === "external_mcp.connect")).toBe(true);
  });

  it("refreshes expired credentials once for concurrent callers and persists rotation", async () => {
    const { env } = environment();
    const stored = { accessToken: "expired", refreshToken: "refresh-1", expiresAt: 0, tokenType: "Bearer",
      tokenEndpoint: "https://auth.vendor.com/oauth/token", clientId: "client", revocationEndpoint: "https://auth.vendor.com/oauth/revoke" };
    await saveExternalMcpOAuthTokens(env, owner.orgId, owner.principal, "server", stored);
    const refresh = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(init?.body)).toBe("grant_type=refresh_token&refresh_token=refresh-1&client_id=client");
      return Response.json({ access_token: "new-access", refresh_token: "refresh-2", expires_in: 3600 });
    });
    const resolve = () => resolveExternalMcpBearer(env, owner.orgId, owner.principal, "server", refresh);
    expect(await Promise.all([resolve(), resolve(), resolve()])).toEqual(["new-access", "new-access", "new-access"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await resolve()).toBe("new-access");
    expect(refresh).toHaveBeenCalledTimes(1);
    const rotated = await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, "server");
    expect(rotated).toMatchObject({ refreshToken: "refresh-2", clientId: "client", revocationEndpoint: stored.revocationEndpoint });
    await saveExternalMcpOAuthTokens(env, owner.orgId, owner.principal, "server", { ...rotated!, expiresAt: 0 });
    const withoutRotation = vi.fn(async () => Response.json({ access_token: "next-access" }));
    expect(await resolveExternalMcpBearer(env, owner.orgId, owner.principal, "server", withoutRotation)).toBe("next-access");
    expect((await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, "server"))?.refreshToken).toBe("refresh-2");
  });

  it("serializes rotation across independent binding objects sharing D1", async () => {
    const { env } = environment();
    const otherEnv = { ...env, AGENT_AUDIT: { ...env.AGENT_AUDIT } } as Env;
    await saveExternalMcpOAuthTokens(env, owner.orgId, owner.principal, "shared-server", {
      accessToken: "expired", refreshToken: "refresh", expiresAt: 0, tokenType: "Bearer",
      tokenEndpoint: "https://auth.vendor.com/oauth/token", clientId: "client",
    });
    const refresh = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ access_token: "rotated", refresh_token: "next" });
    });
    const results = await Promise.all([env, otherEnv].map((binding) =>
      resolveExternalMcpBearer(binding, owner.orgId, owner.principal, "shared-server", refresh)));
    expect(results).toEqual(["rotated", "rotated"]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("releases failed refreshes for retry without overwriting stored credentials", async () => {
    const { env } = environment();
    const stored = { accessToken: "expired", refreshToken: "refresh", expiresAt: 0, tokenType: "Bearer",
      tokenEndpoint: "https://auth.vendor.com/oauth/token", clientId: "client" };
    await saveExternalMcpOAuthTokens(env, owner.orgId, owner.principal, "server", stored);
    const refresh = vi.fn(async () => new Response(null, { status: 400 }));
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(resolveExternalMcpBearer(env, owner.orgId, owner.principal, "server", refresh)).rejects.toThrow("oauth_token_exchange_failed");
    }
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, "server")).toEqual(stored);
  });

  it("returns a conflict for duplicate active catalog labels and frees disabled labels", async () => {
    const { env } = environment();
    const input = { orgId: owner.orgId, ownerId: owner.principal, name: "Stripe", endpoint: stripeEndpoint,
      credentialRef: null, catalogId: "stripe", connectionLabel: "prod", authMode: "oauth" as const };
    const server = (await createExternalMcpServer(env, input))!;
    const url = new URL("https://shiba.test/api/v1/mcp/servers");
    const response = await handleMcpV1({ request: new Request(url, { method: "POST", body: JSON.stringify({ catalogId: "stripe", connectionLabel: "prod" }) }),
      url, env, principal: owner } as V1Context);
    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ error: "connection_label_taken" });
    await disableExternalMcpServer(env, server);
    expect((await createExternalMcpServer(env, input))?.id).not.toBe(server.id);
  });

  it("does not count rolled-back drafts against active server slots", async () => {
    const { env } = environment();
    const input = { orgId: owner.orgId, ownerId: owner.principal, name: "Stripe", endpoint: stripeEndpoint,
      credentialRef: null, catalogId: "stripe", connectionLabel: "prod", authMode: "oauth" as const };
    for (let attempt = 0; attempt < 20; attempt++) {
      const draft = await createExternalMcpServer(env, input);
      if (!draft) throw new Error("Expected created draft");
      await disableExternalMcpServer(env, draft);
    }
    for (let active = 0; active < 20; active++) {
      expect(await createExternalMcpServer(env, { ...input, connectionLabel: `account-${active}` })).toBeTruthy();
    }
    await expect(createExternalMcpServer(env, { ...input, connectionLabel: "overflow" })).rejects.toThrow("server_limit");
  });

  it("keeps two Stripe accounts separate by connection label", async () => {
    const { env } = environment();
    const vendor = curatedMcpVendorByCatalogId("stripe")!;
    const prod = await createExternalMcpServer(env, {
      orgId: "org-a", ownerId: owner.principal, name: "Stripe prod", endpoint: vendor.endpoint, credentialRef: null,
      catalogId: "stripe", connectionLabel: "prod", authMode: "oauth",
    });
    const staging = await createExternalMcpServer(env, {
      orgId: "org-a", ownerId: owner.principal, name: "Stripe staging", endpoint: vendor.endpoint, credentialRef: null,
      catalogId: "stripe", connectionLabel: "staging", authMode: "oauth",
    });
    expect(prod?.id).not.toBe(staging?.id);
    const listed = await listExternalMcpCatalogConnections(env, "org-a", owner.principal);
    expect(listed.map((row) => row.connectionLabel).sort()).toEqual(["prod", "staging"]);
    expect(listed.every((row) => row.health === "unknown" && row.status === "draft")).toBe(true);
  });

  it("marks vendor-sensitive tools for approval review and queues writes", async () => {
    expect(recommendedExternalMcpToolEffect("stripe", "create_refund")).toBe("approval_required");
    expect(recommendedExternalMcpToolEffect("stripe", "list_customers")).toBe("read");

    const { env } = environment();
    const vendor = curatedMcpVendorByCatalogId("stripe")!;
    const fetchMock = mockMcp(vendor.endpoint);
    vi.stubGlobal("fetch", fetchMock);
    const server = (await createExternalMcpServer(env, {
      orgId: "org-a", ownerId: owner.principal, name: "Stripe", endpoint: vendor.endpoint, credentialRef: null,
      catalogId: "stripe", connectionLabel: "prod", authMode: "oauth",
    }))!;
    await discoverExternalMcpServer(env, server);
    const toolList = await listExternalMcpTools(env, server.id);
    const refund = toolList.find((tool) => tool.remoteName === "create_refund");
    expect(refund?.recommendedEffect).toBe("approval_required");
    await reviewExternalMcpTool(env, (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!, refund!.id, "approval_required", refund!.schemaVersion);
    await setExternalMcpToolEnabled(env, (await getExternalMcpServer(env, "org-a", owner.principal, server.id))!, refund!.id, true, refund!.schemaVersion);
    await setExternalMcpAccess(env, { orgId: "org-a", ownerId: owner.principal, serverId: server.id, toolId: refund!.id, principal: agent.principal, enabled: true });
    const registry = createToolRegistry(env);
    await registerExternalMcpTools(registry, env, agent);
    expect(visibleToolsForPrincipal(registry.tools(), agent).map((tool) => tool.name)).toContain(refund!.gatewayName);
    const pending = await registry.invoke(refund!.gatewayName, { id: "re_1" }, agent, { idempotencyKey: "refund-1" });
    expect(pending.structuredContent).toMatchObject({ status: "pending_approval" });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
  });

  it.each(["ok", "network", "http"])("revokes at the vendor and deletes local storage (vendor response: %s)", async (vendorResponse) => {
    const { env } = environment();
    const vendor = curatedMcpVendorByCatalogId("stripe")!;
    const discoveryFetch = mockDiscoveryFetch();
    const server = (await createExternalMcpServer(env, {
      orgId: "org-a", ownerId: owner.principal, name: "Stripe", endpoint: vendor.endpoint, credentialRef: null,
      catalogId: "stripe", connectionLabel: "prod", authMode: "oauth",
    }))!;
    const discovery = await discoverExternalMcpOAuth(vendor, discoveryFetch);
    const begin = await beginExternalMcpOAuthConnect(env, {
      serverId: server!.id, orgId: "org-a", ownerId: owner.principal, catalogId: "stripe",
      redirectUri: "https://app.test/cb", clientId: "shiba_test_stripe_client", scopes: "openid", discovery,
    });
    const state = new URL(begin.authorizationUrl).searchParams.get("state")!;
    await exchangeExternalMcpOAuthCode(env, { state, code: "code", principal: owner }, discoveryFetch);
    const revokeFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(init?.body)).toContain("client_id=shiba_test_stripe_client");
      if (vendorResponse === "network") throw new Error("vendor unavailable");
      return new Response(null, { status: vendorResponse === "http" ? 500 : 200 });
    });
    vi.stubGlobal("fetch", revokeFetch);
    const url = new URL(`https://shiba.test/api/v1/mcp/servers/${server.id}/revoke`);
    const response = await handleMcpV1({ request: new Request(url, { method: "POST" }), url, env, principal: owner } as V1Context);
    expect(response?.status).toBe(200);
    expect(revokeFetch).toHaveBeenCalledTimes(1);
    expect(revokeFetch.mock.calls[0]?.[0]).toBe("https://auth.vendor.com/oauth/revoke");
    expect(await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, server.id)).toBeNull();
    const audit = await listAuditEntries(env, { limit: 10 });
    const revocations = audit.filter((row) => row.tool === "external_mcp.revoke");
    expect(revocations).toHaveLength(1);
    expect(revocations[0]?.outcome).toBe(vendorResponse === "ok" ? "ok" : "error");
  });

  it("exposes vendor catalog over the v1 MCP API", async () => {
    const { env } = environment();
    const vendors = await handleMcpV1({ request: new Request("https://shiba.test/api/v1/mcp/vendors"), env, url: new URL("https://shiba.test/api/v1/mcp/vendors"), principal: owner, forward: async () => new Response() } as V1Context);
    expect(vendors?.status).toBe(200);
    const body = (await vendors!.json()) as { vendors: Array<{ catalogId: string }> };
    expect(body.vendors.map((vendor) => vendor.catalogId)).toEqual(expect.arrayContaining(["stripe", "notion", "sentry"]));
  });
});
