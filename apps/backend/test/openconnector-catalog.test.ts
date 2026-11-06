import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleIntegrationProviderRoutes } from "../src/integrations-provider-routes.js";
import { OpenConnectorIntegrationProvider, openConnectorConnectionName } from "../src/integrations/openconnector-provider.js";

vi.mock("../src/request-auth.js", () => ({ isAuthorizedRequest: vi.fn(async () => true) }));
vi.mock("../src/gmail-routes.js", () => ({ gmailOwner: vi.fn(async () => "alice") }));

const configured = {
  OPEN_CONNECTOR_URL: "https://connector.example.test",
  OPEN_CONNECTOR_ADMIN_TOKEN: "admin-secret",
  OPEN_CONNECTOR_RUNTIME_TOKEN: "runtime-secret",
} as Env;

// Fixture shaped like pinned upstream /api/providers: 120 services across auth modes.
const services = Array.from({ length: 120 }, (_, index) => ({
  service: `svc_${String(index).padStart(3, "0")}`,
  displayName: `Service ${index}`,
  authTypes: index % 3 === 0 ? ["api_key"] : ["oauth2"],
}));
function setupFor(service: string) {
  const index = Number(service.slice(4));
  if (index % 5 === 0) return { configured: true, missingFields: [] as string[] };
  if (index % 7 === 0) return null;
  return { configured: false, missingFields: ["clientId"] };
}

function upstream(connections: unknown[] = []) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/providers") return Response.json(services);
    if (path === "/api/connections" && (init?.method ?? "GET") === "GET") return Response.json(connections);
    if (path.startsWith("/api/connections/") && init?.method === "DELETE") return Response.json({ ok: true });
    const setup = /^\/v1\/providers\/([^/]+)\/setup$/.exec(path);
    if (setup) {
      const service = decodeURIComponent(setup[1]!);
      if (service === "svc_013") return new Response("boom", { status: 500 });
      const client = setupFor(service);
      return Response.json({ success: true, data: { service, ...(client ? { oauthClient: client } : {}) } });
    }
    if (path === "/api/oauth/authorizations") return Response.json({ authorizationUrl: "https://vendor.example.test/consent?state=s", state: "s" });
    throw new Error(`Unexpected fixture request ${path}`);
  });
}

describe("OpenConnector full catalog (fixture upstream)", () => {
  it("pages all 120 services with honest per-service readiness and never marks a listing connected", async () => {
    const fetchImpl = upstream();
    const adapter = new OpenConnectorIntegrationProvider({ env: configured, fetchImpl });
    const seen = new Map<string, string | undefined>();
    let cursor: string | undefined;
    do {
      const page = await adapter.listCatalog({ userId: "alice", limit: 50, ...(cursor ? { cursor } : {}) });
      expect(page).toMatchObject({ total: 120, oauthCapable: 80 });
      for (const item of page.items) {
        seen.set(item.providerKey, item.setupState);
        expect(item.isConnected).toBe(false);
        expect(item.connectable).toBe(item.setupState === "ready");
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.size).toBe(120);
    expect(seen.get("svc_000")).toBe("unsupported");
    expect(seen.get("svc_005")).toBe("ready");
    expect(seen.get("svc_007")).toBe("unsupported");
    expect(seen.get("svc_001")).toBe("needs_configuration");
    expect(seen.get("svc_013")).toBe("unverified");
    // API-key-only services are never probed for an OAuth client.
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/svc_000/setup"))).toBe(false);
  });

  it("filters by readiness with a bounded probe budget and resumable cursor", async () => {
    const fetchImpl = upstream();
    const adapter = new OpenConnectorIntegrationProvider({ env: configured, fetchImpl });
    const ready: string[] = [];
    let cursor: string | undefined, requests = 0;
    do {
      fetchImpl.mockClear();
      const page = await adapter.listCatalog({ userId: "alice", limit: 50, readiness: "ready", ...(cursor ? { cursor } : {}) });
      expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes("/setup")).length).toBeLessThanOrEqual(50);
      for (const item of page.items) { expect(item).toMatchObject({ setupState: "ready", connectable: true }); ready.push(item.providerKey); }
      cursor = page.nextCursor ?? undefined;
      requests++;
    } while (cursor && requests < 10);
    // Multiples of 5 that are not multiples of 3.
    expect(ready).toEqual(services.map((row) => row.service).filter((service) => Number(service.slice(4)) % 5 === 0 && Number(service.slice(4)) % 3 !== 0));
    const unsupported = await adapter.listCatalog({ userId: "alice", limit: 50, readiness: "unsupported" });
    expect(unsupported.items.every((item) => item.setupState === "unsupported" && !item.connectable)).toBe(true);
  });

  it("validates readiness queries and returns filtered catalog totals through the authenticated route", async () => {
    const env = { ...configured, OPEN_CONNECTOR: { fetch: upstream() } } as unknown as Env;
    const bad = await handleIntegrationProviderRoutes(new Request("https://app.example.test/api/integrations/provider/catalog?readiness=live"), env);
    expect(bad?.status).toBe(400);

    const good = await handleIntegrationProviderRoutes(new Request("https://app.example.test/api/integrations/provider/catalog?readiness=ready"), env);
    expect(good?.status).toBe(200);
    const body = await good?.json() as { items: Array<{ providerKey: string; setupState: string }> };
    expect(body).toMatchObject({ ok: true, total: 120, oauthCapable: 80 });
    expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({ providerKey: "svc_005", setupState: "ready" })]));
    expect(body.items.every((item) => item.setupState === "ready")).toBe(true);
  });

  it("reconnects only an unavailable owned row, and only after setup is verified", async () => {
    const own = await openConnectorConnectionName("alice");
    const expired = { id: "row", service: "svc_005", connectionName: own, configured: true, status: "reauth_required", virtual: false, oauthAuthorizationId: "old", profile: { displayName: "Alice" } };
    const context = { userId: "alice", providerKey: "svc_005", callbackOrigin: "https://shiba.example.test" };
    const fetchImpl = upstream([expired]);
    const adapter = new OpenConnectorIntegrationProvider({ env: configured, fetchImpl });
    expect(await adapter.beginConnect(context)).toMatchObject({ ok: false, error: expect.stringContaining("Disconnect") });
    expect(await adapter.beginConnect({ ...context, replaceUnavailable: true })).toMatchObject({ ok: true, redirectUrl: "https://vendor.example.test/consent?state=s" });
    const deletes = fetchImpl.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(JSON.parse(String(deletes[0]![1]!.body))).toEqual({ connectionName: own });

    const active = upstream([{ ...expired, status: "active" }]);
    expect(await new OpenConnectorIntegrationProvider({ env: configured, fetchImpl: active }).beginConnect({ ...context, replaceUnavailable: true })).toMatchObject({ ok: false, error: expect.stringContaining("active") });
    expect(active.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

    const unready = upstream([{ ...expired, service: "svc_001" }]);
    expect(await new OpenConnectorIntegrationProvider({ env: configured, fetchImpl: unready }).beginConnect({ ...context, providerKey: "svc_001", replaceUnavailable: true })).toMatchObject({ ok: false, error: expect.stringContaining("OAuth application") });
    expect(unready.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
});
