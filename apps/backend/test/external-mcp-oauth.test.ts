import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import {
  createExternalMcpServer,
  disableExternalMcpServer,
  discoverExternalMcpServer,
  getExternalMcpServer,
  listExternalMcpCatalogConnections,
  listExternalMcpTools,
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
} from "../src/external-mcp-oauth.js";
import { curatedMcpVendorByCatalogId, recommendedExternalMcpToolEffect } from "@shiba/shared";
import { createToolRegistry, visibleToolsForPrincipal } from "../src/mcp-gateway.js";
import { registerExternalMcpTools } from "../src/external-mcp.js";
import { listAuditEntries } from "../src/audit.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
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
  const { database } = customAgentD1();
  return {
    env: {
      AGENT_AUDIT: database,
      AGENT_TOKENS: { put: async () => {}, get: async () => null, list: async () => ({ keys: [], list_complete: true }) },
      MCP_TRUSTED_HOSTS: "mcp.example.com",
      MCP_OAUTH_CLIENT_STRIPE: clientId,
      MODEL_CREDENTIAL_KEY: KEY,
    } as unknown as Env,
  };
}

function mockDiscoveryFetch() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("oauth-protected-resource")) {
      return Response.json({
        resource: stripeEndpoint,
        authorization_servers: ["https://auth.vendor.test"],
        bearer_methods_supported: ["header"],
      });
    }
    if (url.pathname.endsWith("oauth-authorization-server")) {
      return Response.json({
        issuer: "https://auth.vendor.test",
        authorization_endpoint: "https://auth.vendor.test/oauth/authorize",
        token_endpoint: "https://auth.vendor.test/oauth/token",
        revocation_endpoint: "https://auth.vendor.test/oauth/revoke",
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.href === "https://auth.vendor.test/oauth/token") {
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
  it("discovers RFC 9728 metadata and completes PKCE code exchange", async () => {
    const { env } = environment();
    const vendor = curatedMcpVendorByCatalogId("stripe")!;
    const discoveryFetch = mockDiscoveryFetch();
    const discovery = await discoverExternalMcpOAuth(vendor, discoveryFetch);
    expect(discovery.authorizationServer.token_endpoint).toContain("auth.vendor.test");

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
    expect(discoveryFetch).toHaveBeenCalledTimes(2);
    await exchangeExternalMcpOAuthCode(env, { state, code: "vendor-code", principal: owner }, discoveryFetch);
    expect(await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, prod!.id)).toMatchObject({
      tokenEndpoint: "https://auth.vendor.test/oauth/token", clientId: "shiba_test_stripe_client",
      revocationEndpoint: "https://auth.vendor.test/oauth/revoke",
    });
    const audit = await listAuditEntries(env, { limit: 5 });
    expect(audit.some((row) => row.tool === "external_mcp.connect")).toBe(true);
  });

  it("refreshes expired credentials once for concurrent callers and persists rotation", async () => {
    const { env } = environment();
    const stored = { accessToken: "expired", refreshToken: "refresh-1", expiresAt: 0, tokenType: "Bearer",
      tokenEndpoint: "https://auth.vendor.test/oauth/token", clientId: "client", revocationEndpoint: "https://auth.vendor.test/oauth/revoke" };
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
      tokenEndpoint: "https://auth.vendor.test/oauth/token", clientId: "client",
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
      tokenEndpoint: "https://auth.vendor.test/oauth/token", clientId: "client" };
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
      catalogId: "stripe", connectionLabel: "prod", authMode: "none",
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
    expect(revokeFetch.mock.calls[0]?.[0]).toBe("https://auth.vendor.test/oauth/revoke");
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
