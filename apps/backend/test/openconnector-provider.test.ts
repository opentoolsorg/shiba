import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { OpenConnectorIntegrationProvider, openConnectorConnectionName } from "../src/integrations/openconnector-provider.js";
import { createToolRegistry } from "../src/mcp-gateway.js";
import { registerIntegrationTools } from "../src/mcp-integration-tools.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const configured = {
  OPEN_CONNECTOR_URL: "https://connector.example.test",
  OPEN_CONNECTOR_ADMIN_TOKEN: "admin-secret",
  OPEN_CONNECTOR_RUNTIME_TOKEN: "runtime-secret",
} as Env;
const context = { userId: "alice", providerKey: "github", callbackOrigin: "https://shiba.example.test" };

function provider(fetchImpl: typeof fetch, env = configured) {
  return new OpenConnectorIntegrationProvider({ env, fetchImpl });
}

describe("OpenConnector adapter", () => {
  it("uses the first 16 SHA-256 hex characters, with distinct aliases for different users", async () => {
    expect(await openConnectorConnectionName("alice")).toBe("u_2bd806c97f0e00af");
    expect(await openConnectorConnectionName("bob")).not.toBe(await openConnectorConnectionName("alice"));
  });

  it("reports missing configuration without making an outbound request", async () => {
    const fetchImpl = vi.fn();
    expect((await provider(fetchImpl, {} as Env).health()).status).toBe("unconfigured");
    expect((await provider(fetchImpl, { OPEN_CONNECTOR_URL: configured.OPEN_CONNECTOR_URL } as Env).health()).status).toBe("unconfigured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks public reachability and separately verifies metadata authentication without app actions", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") { expect(new Headers(init?.headers).has("authorization")).toBe(false); return Response.json({ ok: true }); }
      if (path === "/api/providers") { expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-secret"); return Response.json([]); }
      expect(path).toBe("/v1/providers"); expect(new Headers(init?.headers).get("authorization")).toBe("Bearer runtime-secret"); return Response.json({ success: true, data: [] });
    });
    expect((await provider(fetchImpl).health()).status).toBe("healthy");
    expect((await provider(async () => Response.json({ ok: false })).health()).status).toBe("unavailable");
  });

  it("prefers the service binding over the HTTP fallback", async () => {
    const http = vi.fn();
    const bound = vi.fn(async (url: string) => Response.json(url.endsWith("/health") ? { ok: true } : url.endsWith("/api/providers") ? [] : { success: true, data: [] }));
    const env = { ...configured, OPEN_CONNECTOR: { fetch: bound } as unknown as Fetcher };
    expect((await provider(http, env).health()).status).toBe("healthy");
    expect(bound).toHaveBeenCalledTimes(3);
    expect(http).not.toHaveBeenCalled();
  });

  it.each(["http", "binding"] as const)("checks health with Workers-compatible redirect handling through %s", async (transport) => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect === "error") throw new TypeError("Unsupported redirect mode");
      const url = String(_input); return Response.json(url.endsWith("/health") ? { ok: true } : url.endsWith("/api/providers") ? [] : { success: true, data: [] });
    });
    const http = vi.fn();
    const env = transport === "binding"
      ? { ...configured, OPEN_CONNECTOR: { fetch: fetchImpl } as unknown as Fetcher }
      : configured;
    expect((await provider(transport === "binding" ? http : fetchImpl, env).health()).status).toBe("healthy");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(http).not.toHaveBeenCalled();
  });

  it.each(["http", "binding"] as const)("rejects upstream redirects through %s without following them or exposing credentials", async (transport) => {
    for (const status of [301, 302, 303, 307, 308]) {
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("admin-secret runtime-secret private-output", {
        status,
        headers: { location: "https://untrusted.example.test/collect" },
      }));
      const http = vi.fn();
      const env = transport === "binding"
        ? { ...configured, OPEN_CONNECTOR: { fetch: fetchImpl } as unknown as Fetcher }
        : configured;
      const adapter = provider(transport === "binding" ? http : fetchImpl, env);
      await expect(adapter.listConnections({ userId: "alice" })).rejects.toThrow(`OpenConnector request failed (HTTP ${status}).`);
      expect(await adapter.executeTool({ userId: "alice", toolkitSlug: "github", approvedConnectionId: "approved", toolSlug: "github.get_current_user", arguments: {} })).toEqual({
        ok: false, status: "failed", error: `OpenConnector request failed (HTTP ${status}).`,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      for (const [input, init] of fetchImpl.mock.calls) {
        expect(new URL(String(input)).hostname).toBe(transport === "binding" ? "open-connector.internal" : "connector.example.test");
        expect(init?.redirect).toBe("manual");
      }
      expect(http).not.toHaveBeenCalled();
    }
  });

  it("filters connection rows by authenticated alias and excludes virtual, unconfigured and stale grants", async () => {
    const own = await openConnectorConnectionName("alice");
    const base = { id: "own", service: "github", connectionName: own, configured: true, virtual: false, oauthAuthorizationId: "consent-a", profile: { displayName: "Alice" } };
    const fetchImpl = vi.fn(async () => Response.json([
      base,
      { ...base, id: "other", connectionName: await openConnectorConnectionName("bob") },
      { ...base, id: "default", connectionName: "default" },
      { ...base, id: "virtual", virtual: true },
      { ...base, id: "missing", configured: false },
      { ...base, id: "expired", status: "reauth_required" },
      { ...base, id: "revoked", status: "revoked" },
      { ...base, id: "error", status: "error" },
    ]));
    expect(await provider(fetchImpl).listConnections({ userId: "alice" })).toEqual([
      { id: expect.stringMatching(/^ocg_[a-f0-9]{64}$/), provider: "openconnector", providerKey: "github", identityLabel: "Alice", authorizationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), executionReady: true, connectionState: "active" },
    ]);
    const recovery = await provider(fetchImpl).listConnections({ userId: "alice", includeUnavailable: true });
    expect(recovery).toHaveLength(5);
    expect(recovery.find((row) => row.connectionState === "reauth_required")).toMatchObject({ executionReady: false, unavailableReason: expect.stringContaining("Disconnect") });
  });

  it("maps, searches and paginates the catalog with user-scoped connection badges", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/setup")) { expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-secret"); return Response.json({ success: true, data: { service: "github", oauthClient: { configured: true, missingFields: [] } } }); }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-secret");
      if (String(input).endsWith("/api/providers")) return Response.json([
        { service: "github", displayName: "GitHub", description: "Code", authTypes: ["oauth2"] },
        { service: "gitlab", displayName: "GitLab", authTypes: ["api_key"] },
        { service: "slack", displayName: "Slack", authTypes: ["oauth2"] },
      ]);
      return Response.json([{ id: "own", service: "github", connectionName: await openConnectorConnectionName("alice"), configured: true, virtual: false, oauthAuthorizationId: "consent-a", profile: { displayName: "Alice" } }]);
    });
    const adapter = provider(fetchImpl);
    const first = await adapter.listCatalog({ userId: "alice", query: "git", limit: 1 });
    expect(first.items[0]).toMatchObject({ providerKey: "github", source: "openconnector", isConnected: true, connectionId: expect.stringMatching(/^ocg_/), connectable: true });
    expect(first).toMatchObject({ hasMore: true, nextCursor: "1", fallbackCatalog: false });
    const second = await adapter.listCatalog({ userId: "alice", query: "git", cursor: "1", limit: 1 });
    expect(second.items[0]).toMatchObject({ providerKey: "gitlab", connectable: false, isConnected: false });
    expect(second.hasMore).toBe(false);
  });

  it("starts local OAuth using the hashed alias and does not forward callback overrides", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/connections")) return Response.json([]);
      if (String(input).includes("/setup")) return Response.json({ success: true, data: { service: "github", oauthClient: { configured: true, missingFields: [] } } });
      expect(String(input)).toBe("https://connector.example.test/api/oauth/authorizations");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ service: "github", connectionName: "u_2bd806c97f0e00af" });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-secret");
      return Response.json({ authorizationUrl: "https://github.com/login/oauth/authorize?state=random", state: "random" });
    });
    expect(await provider(fetchImpl).beginConnect(context)).toEqual({ ok: true, provider: "openconnector", redirectUrl: "https://github.com/login/oauth/authorize?state=random", authorizationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("disconnects only the authenticated user's named connection", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://connector.example.test/api/connections/github");
      expect(init?.method).toBe("DELETE");
      expect(JSON.parse(String(init?.body))).toEqual({ connectionName: "u_2bd806c97f0e00af" });
      return Response.json({ disconnected: true });
    });
    await provider(fetchImpl).disconnect(context);
  });

  it("searches bounded runtime actions and verifies exact action service without exposing global authentication", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer runtime-secret");
      expect(new Headers(init?.headers).get("x-oo-connector-alias")).toBe(await openConnectorConnectionName("alice"));
      const url = new URL(String(input));
      const action = { id: "github.create_issue", service: "github", name: "Create issue", inputSchema: { type: "object" }, authenticated: true };
      if (url.pathname === "/v1/actions/search") {
        expect(url.searchParams.get("q")).toBe("issue");
        expect(url.searchParams.get("service")).toBe("github");
        expect(url.searchParams.get("limit")).toBe("50");
        return Response.json({ success: true, data: [action, { ...action, id: "slack.send", service: "slack" }] });
      }
      expect(url.pathname).toBe("/v1/actions/github.create_issue");
      return Response.json({ success: true, data: action });
    });
    const adapter = provider(fetchImpl);
    const actions = await adapter.searchActions({ userId: "alice", toolkitSlug: "github", query: "issue", limit: 100 });
    expect(actions).toEqual([{ id: "github.create_issue", service: "github", name: "Create issue", inputSchema: { type: "object" } }]);
    expect(await adapter.searchActions({ userId: "alice", toolkitSlug: "slack", actionId: "github.create_issue", limit: 50 })).toEqual([]);
  });
  it("does not claim healthy credentials or OAuth availability from catalog metadata alone", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/health") ? Response.json({ ok: true }) : new Response("runtime-secret", { status: 401 }));
    expect(await provider(fetcher).health()).toMatchObject({ status: "degraded" });
    const failed = await provider(fetcher).beginConnect(context); expect(failed.ok).toBe(false); expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/api/oauth/authorizations"))).toBe(false);
    expect(JSON.stringify(failed)).not.toContain("runtime-secret");
  });
  it("requires configured OAuth app metadata before creating authorization and supplies a nonempty default discovery query", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("/api/connections") ? Response.json([]) : String(input).includes("/setup") ? Response.json({ success: true, data: { service: "github", oauthClient: { configured: false, missingFields: ["clientId"] } } }) : Response.json({ success: true, data: [] }));
    expect(await provider(fetcher).beginConnect(context)).toMatchObject({ ok: false, error: expect.stringContaining("OAuth application") });
    await provider(fetcher).searchActions({ userId: "alice", toolkitSlug: "github", limit: 20 });
    const search = fetcher.mock.calls.find(([url]) => String(url).includes("/actions/search")); expect(new URL(String(search?.[0])).searchParams.get("q")).toBe("github");
  });

  it("executes upstream action IDs with runtime auth and ignores caller account/session selectors", async () => {
    const row = { id: "checked-upstream-row", service: "github", connectionName: await openConnectorConnectionName("alice"), configured: true, virtual: false, oauthAuthorizationId: "consent-a", profile: { displayName: "Alice" } };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/connections")) return Response.json([row]);
      expect(String(input)).toBe("https://connector.example.test/v1/actions/github.get_current_user");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer runtime-secret");
      expect(headers.get("x-oo-connector-alias")).toBe("u_2bd806c97f0e00af");
      expect(headers.get("x-oo-connector-app-id")).toBe("checked-upstream-row");
      expect(init?.redirect).toBe("manual");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(init?.body))).toEqual({ input: { limit: 2 } });
      return Response.json({ success: true, data: { login: "alice" }, meta: {} });
    });
    const adapter = provider(fetchImpl); const approvedConnectionId = (await adapter.listConnections({ userId: "alice" }))[0]!.id;
    const result = await adapter.executeTool({ userId: "alice", toolkitSlug: "github", approvedConnectionId, toolSlug: "github.get_current_user", arguments: { limit: 2 }, connectedAccountId: "bobs-id", sessionId: "bobs-session" });
    expect(result).toEqual({ ok: true, status: "completed", output: { login: "alice" } });
  });

  it.each(["revoked", "cancelled", "allowed"])("rechecks trusted employee authority after the real account preflight: %s", async (scenario) => {
    const row = { id: "approved-upstream-row", service: "github", connectionName: await openConnectorConnectionName("alice"), configured: true,
      virtual: false, oauthAuthorizationId: "consent-frozen", profile: { displayName: "Alice" } };
    let holdLookup = false;
    let releaseLookup!: (response: Response) => void;
    let beganLookup!: () => void;
    const lookupStarted = new Promise<void>((resolve) => { beganLookup = resolve; });
    const actionPosts: RequestInit[] = [];
    const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/connections") {
        if (!holdLookup) return Response.json([row]);
        beganLookup();
        return new Promise<Response>((resolve) => { releaseLookup = resolve; });
      }
      expect(path).toBe("/v1/actions/github.create_issue");
      if (init?.method !== "POST") return Response.json({ success: true, data: { id: "github.create_issue", service: "github", name: "Create issue" } });
      actionPosts.push(init);
      expect(new Headers(init.headers).get("x-oo-connector-app-id")).toBe(row.id);
      expect(new Headers(init.headers).get("x-oo-connector-alias")).toBe(row.connectionName);
      expect(JSON.parse(String(init.body))).toEqual({ input: { title: "Frozen approved title" } });
      return Response.json({ success: true, data: { id: "created-once" } });
    });
    const bindings = { ...configured, OPEN_CONNECTOR: { fetch: transport }, AGENT_AUDIT: customAgentD1().database } as unknown as Env;
    const adapter = provider(transport, bindings);
    const approvedConnectionId = (await adapter.listConnections({ userId: "alice" }))[0]!.id;
    let authorized = true;
    let cancelled = false;
    const revalidate = vi.fn(async () => {
      if (!authorized) throw new Error("Employee grant revoked fixture");
      if (cancelled) throw new DOMException("Employee task cancelled fixture", "AbortError");
    });
    const registry = createToolRegistry(bindings);
    registerIntegrationTools(registry, bindings, "alice", revalidate, approvedConnectionId);
    holdLookup = true;
    const execution = registry.invoke("integrations.execute", { toolkitSlug: "github", toolSlug: "github.create_issue", arguments: { title: "Frozen approved title" } },
      { principal: "employee-agent", orgId: "self-hosted", kind: "agent", scopes: ["integrations:execute"], created: 1, revoked: false });
    await lookupStarted;
    if (scenario === "revoked") authorized = false;
    if (scenario === "cancelled") cancelled = true;
    releaseLookup(Response.json([row]));
    const result = await execution;
    expect(actionPosts).toHaveLength(scenario === "allowed" ? 1 : 0);
    expect(result.isError === true).toBe(scenario !== "allowed");
    expect(result.structuredContent).toMatchObject({ ok: scenario === "allowed", status: scenario === "allowed" ? "completed" : "failed" });
    expect(revalidate).toHaveBeenCalledTimes(3);
  });

  it("sanitizes upstream HTTP, JSON and network failures without logging tokens or outputs", async () => {
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const row = { id: "checked-row", service: "github", connectionName: await openConnectorConnectionName("alice"), configured: true, virtual: false, oauthAuthorizationId: "consent-a", profile: { displayName: "Alice" } };
    const approvedConnectionId = (await provider(async () => Response.json([row])).listConnections({ userId: "alice" }))[0]!.id;
    const execute = { userId: "alice", toolkitSlug: "github", approvedConnectionId, toolSlug: "github.get_current_user", arguments: {} };
    for (const fetchImpl of [
      async () => new Response("admin-secret runtime-secret private-output", { status: 500 }),
      async () => new Response("private-output"),
      async () => { throw new Error("admin-secret private-output"); },
      async () => Response.json({ success: false, data: "private-output", message: "admin-secret" }),
    ]) {
      const result = await provider(async (input) => String(input).endsWith("/api/connections") ? Response.json([row]) : fetchImpl()).executeTool(execute);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toMatch(/admin-secret|runtime-secret|private-output/);
    }
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it.each([null, {}, [null], [{ id: "secret" }]])("rejects malformed connection payloads: %s", async (payload) => {
    await expect(provider(async () => Response.json(payload)).listConnections({ userId: "alice" })).rejects.toThrow("invalid response");
  });

  it("does not send tokens to insecure or credential-bearing fallback URLs", async () => {
    const fetchImpl = vi.fn();
    for (const url of ["http://connector.example.test", "https://admin:secret@example.test", "https://example.test?token=secret"]) {
      const result = await provider(fetchImpl, { ...configured, OPEN_CONNECTOR_URL: url }).beginConnect(context);
      expect(result.ok).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(["active", "reauth_required", "revoked"])("requires explicit disconnect of an existing owned %s row before new consent", async (status) => {
    const own = { id: "existing", service: "github", connectionName: await openConnectorConnectionName("alice"), status, configured: true, virtual: false, profile: { displayName: "Old" } };
    const fetcher = vi.fn(async () => Response.json([own]));
    expect(await provider(fetcher).beginConnect(context)).toMatchObject({ ok: false, error: expect.stringContaining("Disconnect") });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("invalidates a frozen generation on same-row consent replacement and refuses missing provenance without executing actions", async () => {
    let consent: string | undefined = "consent-a"; let actionRequests = 0;
    const alias = await openConnectorConnectionName("alice");
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/connections")) return Response.json([{ id: "stable-upstream-id", service: "github", connectionName: alias, configured: true, virtual: false, oauthAuthorizationId: consent, profile: { displayName: "Current account" } }]);
      actionRequests++; return Response.json({ success: true, data: "executed" });
    });
    const adapter = provider(fetcher); const first = (await adapter.listConnections({ userId: "alice" }))[0]!;
    expect((await adapter.listConnections({ userId: "alice" }))[0]!.id).toBe(first.id);
    expect(JSON.stringify(first)).not.toContain("consent-a");
    consent = "consent-b"; const replaced = (await adapter.listConnections({ userId: "alice" }))[0]!;
    expect(replaced.id).not.toBe(first.id);
    const args = { userId: "alice", toolkitSlug: "github", toolSlug: "github.write", arguments: {}, approvedConnectionId: first.id };
    expect(await adapter.executeTool(args)).toMatchObject({ ok: false, error: expect.stringContaining("consent generation") });
    consent = undefined; expect(await adapter.listConnections({ userId: "alice" })).toEqual([]); const unverified = (await adapter.listConnections({ userId: "alice", includeUnavailable: true }))[0]!;
    expect(unverified).toMatchObject({ executionReady: false, unavailableReason: expect.stringContaining("no verifiable") });
    expect(await adapter.executeTool({ ...args, approvedConnectionId: unverified.id })).toMatchObject({ ok: false });
    expect(await adapter.executeTool({ ...args, approvedConnectionId: undefined })).toMatchObject({ ok: false });
    expect(actionRequests).toBe(0);
  });
});
