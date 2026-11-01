import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensionsApi, type McpServerInput } from "./extensions-api";

const serverInput: McpServerInput = {
  name: "Test server",
  transport: "streamable-http",
  url: "https://example.test/mcp",
  enabled: true,
  authType: "bearer",
  defaultToolPolicy: "approval_required",
  scope: "personal",
};

beforeEach(() => extensionsApi.resetStubFixtures());
afterEach(() => {
  extensionsApi.resetStubFixtures();
  vi.unstubAllGlobals();
});

describe("extensions API failures", () => {
  it.each([401, 403, 404, 500])("rejects HTTP %s without inventing a saved server", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Backend refused request" }, { status })));
    await expect(extensionsApi.createMcpServer(serverInput)).rejects.toMatchObject({ message: "Backend refused request" });
    await expect(extensionsApi.listMcpServers("personal")).rejects.toMatchObject({ message: "Backend refused request" });
  });

  it("propagates network errors instead of claiming a connection succeeded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network unavailable"); }));
    await expect(extensionsApi.testMcpServer(serverInput)).rejects.toMatchObject({ message: "Network unavailable" });
  });

  it("rejects successful non-JSON mutations instead of reporting a deletion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Sign in</html>", { status: 200 })));
    await expect(extensionsApi.deleteMcpServer("server-id")).rejects.toMatchObject({ message: "Invalid extensions API response" });
  });

  it("reports the status when an HTTP failure has a non-JSON body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Failure</html>", { status: 500 })));
    await expect(extensionsApi.deleteMcpServer("server-id")).rejects.toMatchObject({ message: "Request failed (500)" });
  });

  it("removes legacy credentials from loaded fixture data and persisted storage", async () => {
    const storage = new Map<string, string>([["shiba-extensions-mcp-v1", JSON.stringify([{
      ...serverInput,
      id: "legacy-server",
      hasAuth: true,
      toolPolicies: {},
      toolCatalogCount: 0,
      authConfig: { bearerToken: "legacy-bearer-secret", headerValue: "legacy-header-secret" },
    }])]]);
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    extensionsApi.useStubs(true);
    const { servers } = await extensionsApi.listMcpServers("personal");
    expect(servers[0]).not.toHaveProperty("authConfig");
    expect(storage.get("shiba-extensions-mcp-v1")).not.toMatch(/legacy-bearer-secret|legacy-header-secret/);
    const { server } = await extensionsApi.updateMcpServer("legacy-server", { name: "Renamed" });
    expect(server).not.toHaveProperty("authConfig");
    expect(storage.get("shiba-extensions-mcp-v1")).not.toMatch(/legacy-bearer-secret|legacy-header-secret/);
  });

  it("keeps explicitly enabled fixture CRUD available without persisting submitted secrets", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {});
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    extensionsApi.useStubs(true);
    const { server } = await extensionsApi.createMcpServer(serverInput);
    const { server: updated } = await extensionsApi.updateMcpServer(server.id, {
      authConfig: { bearerToken: "fixture-bearer-secret", headerValue: "fixture-header-secret" },
    });
    expect(updated.hasAuth).toBe(true);
    expect(updated).not.toHaveProperty("authConfig");
    expect([...storage.values()].join("")).not.toMatch(/fixture-bearer-secret|fixture-header-secret/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
