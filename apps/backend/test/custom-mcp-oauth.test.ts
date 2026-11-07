import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import type { V1Context } from "../src/v1/context.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { createExternalMcpServer, getExternalMcpServer, listExternalMcpTools, updateExternalMcpServer } from "../src/external-mcp.js";
import { discoverExternalMcpOAuth, loadExternalMcpOAuthTokens, resolveExternalMcpBearer, saveExternalMcpOAuthTokens } from "../src/external-mcp-oauth.js";
import { handleMcp } from "../src/v1/mcp.js";

const endpoint = "https://mcp.customer.com/team/mcp", issuer = "https://auth.customer.com/tenant";
const redirectUri = "https://shiba.test/api/v1/mcp/oauth/callback";
const owner = { principal: "owner@example.test", orgId: "org-a", scopes: ["api:read" as const, "api:write" as const] };
const authorizationServer = { issuer, authorization_endpoint: "https://auth.customer.com/authorize", token_endpoint: "https://auth.customer.com/token",
  revocation_endpoint: "https://auth.customer.com/revoke", code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"], response_types_supported: ["code"], authorization_response_iss_parameter_supported: true };
function fixture(overrides: { resource?: Record<string, unknown>; authorization?: Record<string, unknown>; challenge?: string } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    expect(init?.redirect).toBe("error");
    if (url === endpoint) {
      if (init?.method === "GET") return new Response(null, { status: 401, headers: { "WWW-Authenticate": overrides.challenge ?? "Bearer" } });
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-access");
      const rpc = JSON.parse(String(init?.body)) as { id: number; method: string };
      if (rpc.method === "initialize") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "custom-fixture", version: "1" } } });
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { tools: [{ name: "send_message", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } });
      throw new Error("Tool execution must remain approval-gated");
    }
    if (url.includes("oauth-protected-resource")) return Response.json({ resource: endpoint, authorization_servers: [issuer], ...overrides.resource });
    if (url.includes("oauth-authorization-server")) return Response.json({ ...authorizationServer, ...overrides.authorization });
    if (url === authorizationServer.token_endpoint) return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, token_type: "Bearer" });
    if (url === authorizationServer.revocation_endpoint) return new Response(null, { status: 200 });
    throw new Error(`Unexpected request: ${url}`);
  });
}
async function environment() {
  const { database, sqlite } = customAgentD1();
  const env = { AGENT_AUDIT: database, MODEL_CREDENTIAL_KEY: "ab".repeat(32), MCP_TRUSTED_HOSTS: "mcp.customer.com,auth.customer.com" } as unknown as Env;
  const server = (await createExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, name: "Custom public client", endpoint, credentialRef: null, authMode: "oauth" }))!;
  const request = async (path: string, input?: Record<string, unknown>, principal = owner) => {
    const url = new URL(path, "https://shiba.test");
    return (await handleMcp({ url, env, principal, request: new Request(url, input === undefined ? {} : { method: "POST", body: JSON.stringify(input) }) } as V1Context))!;
  };
  const begin = (input: Record<string, unknown> = {}) => request(`/api/v1/mcp/servers/${server.id}/oauth/begin`, { redirectUri, issuer, clientId: "registered-public-client", ...input });
  const callback = (state: string, callbackIssuer: string = issuer) => request(`/api/v1/mcp/oauth/callback?${new URLSearchParams({ state, code: "fixture-code", ...(callbackIssuer ? { iss: callbackIssuer } : {}) })}`);
  return { env, sqlite, server, request, begin, callback };
}
afterEach(() => vi.unstubAllGlobals());

describe("custom MCP OAuth public-client lane", () => {
  it("leaves an unsigned custom OAuth draft usable when discovery is requested too early", async () => {
    const { env, server, request, begin } = await environment(); const network = fixture(); vi.stubGlobal("fetch", network);
    const response = await request(`/api/v1/mcp/servers/${server.id}/discover`, {});
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "oauth_sign_in_required" });
    expect(network).not.toHaveBeenCalled();
    expect(await getExternalMcpServer(env, owner.orgId, owner.principal, server.id)).toMatchObject({ status: "draft", health: "unknown" });
    expect((await begin()).status).toBe(200);
  });
  it("pairs a non-catalog server using encrypted PKCE, preserves review gates, then revokes", async () => {
    const { env, sqlite, server, begin, callback, request } = await environment();
    const network = fixture(); vi.stubGlobal("fetch", network);
    const started = await begin({ scopes: "messages:write" }); expect(started.status).toBe(200);
    const consent = await started.json() as { state: string; authorizationUrl: string };
    const authorization = new URL(consent.authorizationUrl);
    expect(authorization.searchParams.get("resource")).toBe(endpoint);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("scope")).toBe("messages:write");
    expect(authorization.searchParams.has("code_verifier")).toBe(false);
    const pendingRows = JSON.stringify(sqlite.prepare("SELECT * FROM external_mcp_oauth_pending").all());
    expect((await callback(consent.state)).status).toBe(200);
    const tokenRequest = network.mock.calls.find(([url]) => String(url) === authorizationServer.token_endpoint)!;
    const tokenBody = new URLSearchParams(String(tokenRequest[1]?.body)), verifier = tokenBody.get("code_verifier")!;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    expect(btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")).toBe(authorization.searchParams.get("code_challenge"));
    expect(pendingRows).not.toContain(verifier); expect(pendingRows).not.toContain(consent.state);
    expect(tokenBody.get("resource")).toBe(endpoint); expect(tokenBody.has("client_secret")).toBe(false);
    expect((await getExternalMcpServer(env, owner.orgId, owner.principal, server.id))?.status).toBe("discovered");
    const tools = await listExternalMcpTools(env, server.id); expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ effect: "unreviewed", recommendedEffect: "unreviewed", enabled: false });
    expect((await request(`/api/v1/mcp/servers/${server.id}/tools/${tools[0]!.id}/enable`, { schemaVersion: tools[0]!.schemaVersion })).status).toBe(409);
    const stored = JSON.stringify(sqlite.prepare("SELECT * FROM user_subscription_credentials").all());
    expect(stored).not.toContain("fixture-access"); expect(stored).not.toContain("fixture-refresh");
    expect(await loadExternalMcpOAuthTokens(env, "other-org", owner.principal, server.id)).toBeNull();
    expect(await loadExternalMcpOAuthTokens(env, owner.orgId, "other-owner", server.id)).toBeNull();
    expect((await callback(consent.state)).status).toBe(400);
    expect((await request(`/api/v1/mcp/servers/${server.id}/revoke`, {})).status).toBe(200);
    expect(await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, server.id)).toBeNull();
    const revoked = network.mock.calls.find(([url]) => String(url) === authorizationServer.revocation_endpoint)!;
    expect(new URLSearchParams(String(revoked[1]?.body)).get("token")).toBe("fixture-refresh");
    expect((await getExternalMcpServer(env, owner.orgId, owner.principal, server.id))?.status).toBe("disabled");
  });
  it.each(["mcp.customer.com", "auth.customer.com", ""])("requires both explicitly trusted hosts before any request: %s", async (hosts) => {
    const { env, begin } = await environment(); env.MCP_TRUSTED_HOSTS = hosts;
    const network = fixture(); vi.stubGlobal("fetch", network);
    expect((await begin()).status).toBe(403); expect(network).not.toHaveBeenCalled();
  });
  it.each([
    { issuer: "http://auth.customer.com/tenant" }, { issuer: "https://127.0.0.1" }, { issuer: "https://[::1]" },
    { issuer: "https://auth.customer.com@evil.net" }, { issuer: "https://auth.customer.com:444/tenant" },
    { issuer: "https://auth.customer.com/tenant?secret=x" }, { issuer: "https://auth.customer.com/tenant#fragment" },
    { clientId: "" }, { clientId: "bad\nclient" }, { scopes: "bad\nscope" }, { clientSecret: "not-supported" },
    { redirectUri: "https://attacker.net/callback" },
  ])("fails closed for unsafe custom input %j", async (input) => {
    const { begin } = await environment(); const network = fixture(); vi.stubGlobal("fetch", network);
    expect((await begin(input)).status).toBeGreaterThanOrEqual(400); expect(network).not.toHaveBeenCalled();
  });
  it.each([
    { resource: { resource: "https://mcp.customer.com/" } }, { resource: { authorization_servers: ["https://auth.other.com"] } },
    { authorization: { issuer: "https://auth.customer.com/another-tenant" } },
    { authorization: { token_endpoint_auth_methods_supported: ["client_secret_basic"] } },
    { authorization: { code_challenge_methods_supported: ["plain"] } }, { authorization: { response_types_supported: ["token"] } },
    { authorization: { grant_types_supported: ["client_credentials"] } },
    { authorization: { authorization_endpoint: "https://mcp.customer.com/authorize" } },
    { authorization: { token_endpoint: "https://mcp.customer.com/token" } },
    { authorization: { revocation_endpoint: "https://mcp.customer.com/revoke" } },
    { challenge: 'Bearer resource_metadata="https://auth.customer.com/oauth-protected-resource"' },
    { challenge: 'Bearer resource_metadata="https://untrusted.net/metadata"' },
  ])("rejects untrusted metadata without following delegated endpoints: %j", async (overrides) => {
    const { begin } = await environment(); const network = fixture(overrides); vi.stubGlobal("fetch", network);
    expect((await begin()).status).toBeGreaterThanOrEqual(400);
    expect(network.mock.calls.every(([url]) => String(url) === endpoint || String(url).startsWith("https://mcp.customer.com/.well-known/") || String(url).startsWith("https://auth.customer.com/.well-known/"))).toBe(true);
  });
  it("selects only the pinned issuer even when another issuer is advertised first", async () => {
    const { env } = await environment(), network = fixture({ resource: { authorization_servers: ["https://untrusted.net", issuer] } });
    expect((await discoverExternalMcpOAuth({ endpoint }, network, { env, issuer })).customIssuer).toBe(issuer);
    expect(network.mock.calls.some(([url]) => String(url).includes("untrusted.net"))).toBe(false);
  });
  it.each(["//169.254.169.254", "//other.customer.com", "/\\\\169.254.169.254"])("rejects network-path issuer %s without fetching its OIDC fallback", async (path) => {
    const { env } = await environment();
    const maliciousIssuer = `https://auth.customer.com${path}`;
    const network = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.href === endpoint) return new Response(null, { status: 405 });
      if (url.pathname.includes("oauth-protected-resource")) return Response.json({ resource: endpoint, authorization_servers: [maliciousIssuer] });
      // Both RFC 8414/first OIDC attempts fail, exercising the legacy fallback if reached.
      return new Response(null, { status: 404 });
    });
    for (const policy of [undefined, { env, issuer: maliciousIssuer }]) {
      network.mockClear();
      await expect(discoverExternalMcpOAuth({ endpoint }, network, policy)).rejects.toThrow();
      expect(network.mock.calls.every(([url]) => [new URL(endpoint).origin, new URL(issuer).origin].includes(new URL(String(url)).origin))).toBe(true);
    }
  });
  it("keeps all path-scoped OIDC fallback requests on the pinned issuer after two 404s", async () => {
    const { env } = await environment();
    const network = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === endpoint) return new Response(null, { status: 405 });
      if (url.includes("oauth-protected-resource")) return Response.json({ resource: endpoint, authorization_servers: [issuer] });
      if (url === `${issuer}/.well-known/openid-configuration`) return Response.json(authorizationServer);
      return new Response(null, { status: 404 });
    });
    expect((await discoverExternalMcpOAuth({ endpoint }, network, { env, issuer })).customIssuer).toBe(issuer);
    expect(network.mock.calls.map(([url]) => String(url))).toEqual([endpoint,
      "https://mcp.customer.com/.well-known/oauth-protected-resource/team/mcp",
      "https://auth.customer.com/.well-known/oauth-authorization-server/tenant",
      "https://auth.customer.com/.well-known/openid-configuration/tenant",
      `${issuer}/.well-known/openid-configuration`]);
  });
  it("rejects wrong owner and mixed-up or missing required issuer before exchanging", async () => {
    const { server, begin, callback, request } = await environment(); const network = fixture(); vi.stubGlobal("fetch", network);
    expect((await request(`/api/v1/mcp/servers/${server.id}/oauth/begin`, { redirectUri, issuer, clientId: "client" }, { ...owner, principal: "other-owner" })).status).toBe(404);
    const { state } = await (await begin()).json() as { state: string };
    expect((await callback(state, "https://auth.customer.com/other-tenant")).status).toBe(400);
    expect((await callback(state, "")).status).toBe(400);
    expect(network.mock.calls.some(([url]) => String(url) === authorizationServer.token_endpoint)).toBe(false);
    expect((await callback(state)).status).toBe(200);
  });
  it.each(["exchange", "refresh", "revoke"])("rechecks operator trust before %s; revocation still deletes locally", async (stage) => {
    const { env, server, begin, callback, request } = await environment(); const network = fixture(); vi.stubGlobal("fetch", network);
    const { state } = await (await begin()).json() as { state: string };
    if (stage !== "exchange") expect((await callback(state)).status).toBe(200);
    if (stage === "refresh") {
      const stored = (await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, server.id))!;
      await saveExternalMcpOAuthTokens(env, owner.orgId, owner.principal, server.id, { ...stored, expiresAt: 0 });
    }
    env.MCP_TRUSTED_HOSTS = "mcp.customer.com"; network.mockClear();
    if (stage === "exchange") expect((await callback(state)).status).toBe(403);
    if (stage === "refresh") await expect(resolveExternalMcpBearer(env, owner.orgId, owner.principal, server.id, network)).rejects.toThrow("destination_not_trusted");
    if (stage === "revoke") {
      expect((await request(`/api/v1/mcp/servers/${server.id}/revoke`, {})).status).toBe(200);
      expect(await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, server.id)).toBeNull();
    }
    expect(network).not.toHaveBeenCalled();
  });
  it("invalidates pending authorization when the endpoint changes", async () => {
    const { env, server, begin, callback } = await environment(); const network = fixture(); vi.stubGlobal("fetch", network);
    const { state } = await (await begin()).json() as { state: string };
    await updateExternalMcpServer(env, { orgId: owner.orgId, ownerId: owner.principal, id: server.id, endpoint: "https://mcp.customer.com/other/mcp" });
    network.mockClear(); expect((await callback(state)).status).toBe(400); expect(network).not.toHaveBeenCalled();
  });
  it("refreshes the pinned public-client resource without losing the issuer binding", async () => {
    const { env, server, begin, callback } = await environment(); const network = fixture(); vi.stubGlobal("fetch", network);
    const { state } = await (await begin()).json() as { state: string };
    expect((await callback(state)).status).toBe(200);
    const stored = await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, server.id);
    if (!stored) throw new Error("Expected encrypted fixture credentials");
    await saveExternalMcpOAuthTokens(env, owner.orgId, owner.principal, server.id, { ...stored, expiresAt: 0 });
    network.mockClear();
    expect(await resolveExternalMcpBearer(env, owner.orgId, owner.principal, server.id, network)).toBe("fixture-access");
    expect(network).toHaveBeenCalledTimes(1);
    const body = new URLSearchParams(String(network.mock.calls[0]?.[1]?.body));
    expect(body.get("grant_type")).toBe("refresh_token"); expect(body.get("resource")).toBe(endpoint);
    expect(body.get("client_id")).toBe("registered-public-client");
    expect(await loadExternalMcpOAuthTokens(env, owner.orgId, owner.principal, server.id)).toMatchObject({ customIssuer: issuer, resource: endpoint });
  });
});
