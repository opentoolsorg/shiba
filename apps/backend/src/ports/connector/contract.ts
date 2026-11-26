import { describe, expect, it } from "vitest";
import type { ConnectorProvider } from "./provider.js";

export interface ConnectorContractFixture {
  provider: ConnectorProvider;
  calls: Array<{ path: string; method: string; body: unknown }>;
}

export interface ConnectorContractFactory {
  configured: boolean;
  create(options?: { connected?: boolean; status?: number }): Promise<ConnectorContractFixture>;
}

const connection = { userId: "alice", providerKey: "github", callbackOrigin: "https://shiba.example.test" };

/** Register this same suite for each adapter, supplying a fake service transport. */
export function connectorProviderContract(name: string, factory: ConnectorContractFactory): void {
  describe(`${name} connector contract`, () => {
    it("declares its configuration and supported auth capabilities", async () => {
      const { provider } = await factory.create();
      expect(provider.capabilities.configured).toBe(factory.configured);
      expect(provider.capabilities.authTypes).toEqual(factory.configured ? ["oauth2"] : []);
      expect(provider.capabilities.actions).toBe(factory.configured);
      expect((await provider.health()).status).toBe(factory.configured ? "healthy" : "unconfigured");
    });

    it("lists apps with auth metadata or reports setup is required", async () => {
      const { provider } = await factory.create();
      const result = provider.listCatalog({ userId: "alice", limit: 8 });
      if (!factory.configured) {
        await expect(result).rejects.toMatchObject({ code: "not_configured" });
        return;
      }
      const page = await result;
      expect(page.items).toEqual([expect.objectContaining({ providerKey: "github", authTypes: ["oauth2"], connectable: true })]);
      expect(page).toMatchObject({ hasMore: false, nextCursor: null });
    });

    it("keeps connections scoped to the authenticated user", async () => {
      const { provider } = await factory.create({ connected: true });
      const result = provider.listConnections({ userId: "alice" });
      if (!factory.configured) {
        await expect(result).rejects.toMatchObject({ code: "not_configured" });
        return;
      }
      expect(await result).toEqual([expect.objectContaining({ identityLabel: "Alice", providerKey: "github", executionReady: true })]);
      expect(await provider.listConnections({ userId: "nobody" })).toEqual([]);
    });

    it("discovers actions or reports setup is required", async () => {
      const { provider } = await factory.create();
      const result = provider.searchActions({ userId: "alice", toolkitSlug: "github", limit: 10 });
      if (!factory.configured) {
        await expect(result).rejects.toMatchObject({ code: "not_configured" });
        return;
      }
      expect(await result).toEqual([expect.objectContaining({ id: "github.get_current_user", service: "github", inputSchema: { type: "object", properties: {} } })]);
    });

    it("starts connect with a redirect or fails closed when setup is absent", async () => {
      const { provider } = await factory.create();
      const result = await provider.beginConnect(connection);
      expect(result.ok).toBe(factory.configured);
      if (factory.configured) expect(result.redirectUrl).toBe("https://github.example.test/authorize");
      else expect(result.error).toBeTruthy();
    });

    it("revokes only the requested owner or reports setup is required", async () => {
      const { provider, calls } = await factory.create();
      const result = provider.disconnect(connection);
      if (!factory.configured) {
        await expect(result).rejects.toMatchObject({ code: "not_configured" });
        expect(calls).toEqual([]);
        return;
      }
      await result;
      expect(calls).toEqual([expect.objectContaining({ path: "/api/connections/github", method: "DELETE" })]);
      expect(calls[0]?.body).toEqual({ connectionName: "u_2bd806c97f0e00af" });
    });

    it("refuses invocation without an approved connection before any action request", async () => {
      const { provider, calls } = await factory.create({ connected: true });
      expect(await provider.executeTool({ userId: "alice", toolkitSlug: "github", toolSlug: "github.get_current_user", arguments: {} })).toMatchObject({ ok: false, status: "failed" });
      expect(calls.some((call) => call.method === "POST")).toBe(false);
    });

    it("honors the trusted permission hook before dispatch", async () => {
      const { provider, calls } = await factory.create({ connected: true });
      if (!factory.configured) {
        expect((await provider.executeTool({ userId: "alice", arguments: {}, toolSlug: "github.get_current_user", beforeDispatch: async () => { throw new Error("denied"); } })).ok).toBe(false);
        expect(calls).toEqual([]);
        return;
      }
      const account = (await provider.listConnections({ userId: "alice" }))[0]!;
      const result = await provider.executeTool({ userId: "alice", toolkitSlug: "github", toolSlug: "github.get_current_user", arguments: {}, approvedConnectionId: account.id,
        beforeDispatch: async () => { throw new Error("denied"); },
      });
      expect(result.ok).toBe(false);
      expect(calls.some((call) => call.method === "POST")).toBe(false);
    });

    it("invokes an action only with the current approved connection", async () => {
      const { provider, calls } = await factory.create({ connected: true });
      if (!factory.configured) {
        expect((await provider.executeTool({ userId: "alice", toolkitSlug: "github", toolSlug: "github.get_current_user", arguments: {}, approvedConnectionId: "missing" })).ok).toBe(false);
        return;
      }
      const account = (await provider.listConnections({ userId: "alice" }))[0]!;
      expect(await provider.executeTool({ userId: "alice", toolkitSlug: "github", toolSlug: "github.get_current_user", arguments: {}, approvedConnectionId: account.id })).toEqual({ ok: true, status: "completed", output: { login: "alice" } });
      expect(calls.filter((call) => call.method === "POST")).toEqual([expect.objectContaining({ path: "/v1/actions/github.get_current_user", body: { input: {} } })]);
    });

    it.each([[401, "auth_expired"], [403, "forbidden"], [429, "rate_limited"]] as const)("classifies HTTP %s without exposing upstream bodies", async (status, code) => {
      const { provider } = await factory.create({ status });
      await expect(provider.listConnections({ userId: "alice" })).rejects.toMatchObject({ code: factory.configured ? code : "not_configured" });
      await expect(provider.listConnections({ userId: "alice" })).rejects.not.toThrow("private upstream body");
    });
  });
}
