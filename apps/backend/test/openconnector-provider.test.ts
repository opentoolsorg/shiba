import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { OpenConnectorIntegrationProvider, openConnectorConnectionName } from "../src/integrations/openconnector-provider.js";

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

  it("checks health without sending either token", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://connector.example.test/health");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json({ ok: true });
    });
    expect((await provider(fetchImpl).health()).status).toBe("healthy");
    expect((await provider(async () => Response.json({ ok: false })).health()).status).toBe("unavailable");
  });

  it("prefers the service binding over the HTTP fallback", async () => {
    const http = vi.fn();
    const bound = vi.fn(async () => Response.json({ ok: true }));
    const env = { ...configured, OPEN_CONNECTOR: { fetch: bound } as unknown as Fetcher };
    expect((await provider(http, env).health()).status).toBe("healthy");
    expect(bound).toHaveBeenCalledOnce();
    expect(http).not.toHaveBeenCalled();
  });

  it("filters connection rows by authenticated alias and excludes virtual, unconfigured and stale grants", async () => {
    const own = await openConnectorConnectionName("alice");
    const base = { id: "own", service: "github", connectionName: own, configured: true, virtual: false, profile: { displayName: "Alice" } };
    const fetchImpl = vi.fn(async () => Response.json([
      base,
      { ...base, id: "other", connectionName: await openConnectorConnectionName("bob") },
      { ...base, id: "default", connectionName: "default" },
      { ...base, id: "virtual", virtual: true },
      { ...base, id: "missing", configured: false },
      { ...base, id: "expired", status: "reauth_required" },
    ]));
    expect(await provider(fetchImpl).listConnections({ userId: "alice" })).toEqual([
      { id: "own", provider: "openconnector", providerKey: "github", identityLabel: "Alice" },
    ]);
  });

  it("maps, searches and paginates the catalog with user-scoped connection badges", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-secret");
      if (String(input).endsWith("/api/providers")) return Response.json([
        { service: "github", displayName: "GitHub", description: "Code", authTypes: ["oauth2"] },
        { service: "gitlab", displayName: "GitLab", authTypes: ["api_key"] },
        { service: "slack", displayName: "Slack", authTypes: ["oauth2"] },
      ]);
      return Response.json([{ id: "own", service: "github", connectionName: await openConnectorConnectionName("alice"), configured: true, virtual: false, profile: { displayName: "Alice" } }]);
    });
    const adapter = provider(fetchImpl);
    const first = await adapter.listCatalog({ userId: "alice", query: "git", limit: 1 });
    expect(first.items[0]).toMatchObject({ providerKey: "github", source: "openconnector", isConnected: true, connectionId: "own", connectable: true });
    expect(first).toMatchObject({ hasMore: true, nextCursor: "1", fallbackCatalog: false });
    const second = await adapter.listCatalog({ userId: "alice", query: "git", cursor: "1", limit: 1 });
    expect(second.items[0]).toMatchObject({ providerKey: "gitlab", connectable: false, isConnected: false });
    expect(second.hasMore).toBe(false);
  });

  it("starts local OAuth using the hashed alias and does not forward callback overrides", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://connector.example.test/api/oauth/authorizations");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ service: "github", connectionName: "u_2bd806c97f0e00af" });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-secret");
      return Response.json({ authorizationUrl: "https://github.com/login/oauth/authorize?state=random", state: "random" });
    });
    expect(await provider(fetchImpl).beginConnect(context)).toEqual({ ok: true, provider: "openconnector", redirectUrl: "https://github.com/login/oauth/authorize?state=random" });
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

  it("executes upstream action IDs with runtime auth and ignores caller account/session selectors", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://connector.example.test/v1/actions/github.get_current_user");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer runtime-secret");
      expect(headers.get("x-oo-connector-alias")).toBe("u_2bd806c97f0e00af");
      expect(headers.has("x-oo-connector-app-id")).toBe(false);
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(init?.body))).toEqual({ input: { limit: 2 } });
      return Response.json({ success: true, data: { login: "alice" }, meta: {} });
    });
    const result = await provider(fetchImpl).executeTool({ userId: "alice", toolSlug: "github.get_current_user", arguments: { limit: 2 }, connectedAccountId: "bobs-id", sessionId: "bobs-session" });
    expect(result).toEqual({ ok: true, status: "completed", output: { login: "alice" } });
  });

  it("sanitizes upstream HTTP, JSON and network failures without logging tokens or outputs", async () => {
    const log = vi.spyOn(console, "log");
    const warn = vi.spyOn(console, "warn");
    const error = vi.spyOn(console, "error");
    const execute = { userId: "alice", toolSlug: "github.get_current_user", arguments: {} };
    for (const fetchImpl of [
      async () => new Response("admin-secret runtime-secret private-output", { status: 500 }),
      async () => new Response("private-output"),
      async () => { throw new Error("admin-secret private-output"); },
      async () => Response.json({ success: false, data: "private-output", message: "admin-secret" }),
    ]) {
      const result = await provider(fetchImpl).executeTool(execute);
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
});
