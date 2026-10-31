import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import {
  createExternalMcpServer,
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
  revokeExternalMcpOAuth,
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
    await exchangeExternalMcpOAuthCode(env, { state, code: "vendor-code" }, discoveryFetch);
    const audit = await listAuditEntries(env, { limit: 5 });
    expect(audit.some((row) => row.tool === "external_mcp.connect")).toBe(true);
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

  it("revokes OAuth storage and writes audit rows", async () => {
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
    await exchangeExternalMcpOAuthCode(env, { state, code: "code" }, discoveryFetch);
    await revokeExternalMcpOAuth(env, { orgId: "org-a", ownerId: owner.principal, serverId: server!.id, revocationEndpoint: "https://auth.vendor.test/oauth/revoke" }, discoveryFetch);
    const audit = await listAuditEntries(env, { limit: 10 });
    expect(audit.some((row) => row.tool === "external_mcp.revoke")).toBe(true);
  });

  it("exposes vendor catalog over the v1 MCP API", async () => {
    const { env } = environment();
    const vendors = await handleMcpV1({ request: new Request("https://shiba.test/api/v1/mcp/vendors"), env, url: new URL("https://shiba.test/api/v1/mcp/vendors"), principal: owner, forward: async () => new Response() } as V1Context);
    expect(vendors?.status).toBe(200);
    const body = (await vendors!.json()) as { vendors: Array<{ catalogId: string }> };
    expect(body.vendors.map((vendor) => vendor.catalogId)).toEqual(expect.arrayContaining(["stripe", "notion", "sentry"]));
  });
});
