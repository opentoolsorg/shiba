import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { V1Principal } from "../src/v1-auth.js";
import type { Env } from "../src/env.js";
import { getIntegrationProvider } from "../src/integrations/runtime.js";
import { OpenConnectorIntegrationProviderError } from "../src/integrations/openconnector-provider.js";
import { handleV1 } from "../src/v1-routes.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";
import { assertConnectorRegistryAllowsRuntime } from "../src/extensions/connectors-store.js";
import {
  archiveWorkspaceConnector,
  listWorkspaceConnectors,
  promoteConnectorToWorkspaceScope,
  upsertPersonalConnectorFromProvider,
} from "../src/extensions/connectors-store.js";

const connectorMigration = readFileSync(new URL("../migrations/0042_workspace_connectors_v2.sql", import.meta.url), "utf8");
const integrationMigration = readFileSync(new URL("../migrations/0010_workspace_integrations.sql", import.meta.url), "utf8");

const fixture = () => {
  const { database, sqlite } = customAgentD1();
  sqlite.exec(connectorMigration);
  sqlite.exec(integrationMigration);
  const env = { AGENT_AUDIT: database, INTEGRATIONS_PROVIDER: "openconnector" } as unknown as Env;
  let principal: V1Principal = { principal: "alice", orgId: "self-hosted", scopes: ["api:read", "api:write"] };
  const send = (path: string, method = "GET", body?: unknown) => handleV1(
    new Request(`https://shiba.test${path}`, {
      method,
      headers: { origin: "https://shiba.test", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    { authorize: async () => principal },
  );
  return { env, sqlite, send, setPrincipal(value: V1Principal) { principal = value; } };
};

describe("workspace connectors registry", () => {
  it("serves the unbound directory and rejects connect with setup metadata", async () => {
    const f = fixture();
    const response = await f.send("/api/v1/extensions/connectors/directory");
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ ok: true, configured: false, items: expect.arrayContaining([
      expect.objectContaining({ id: "stripe", available: false, reason: "setup_required" }),
    ]) });
    const connect = await f.send("/api/v1/extensions/connectors", "POST", { providerKey: "stripe", connectedAccountId: "fixture-account" });
    expect(connect?.status).toBe(409);
    expect(await connect!.json()).toMatchObject({ configured: false, code: "setup_required" });
  });

  it("preserves 503 for configured directory outages", async () => {
    const f = fixture();
    f.env.OPEN_CONNECTOR_URL = "https://oc.example.test";
    const spy = vi.spyOn(getIntegrationProvider(f.env), "listCatalog")
      .mockRejectedValue(new OpenConnectorIntegrationProviderError("Could not reach OpenConnector."));
    try {
      const response = await f.send("/api/v1/extensions/connectors/directory");
      expect(response?.status).toBe(503);
    } finally { spy.mockRestore(); }
  });

  it("rejects runtime grants when the registry row is archived", async () => {
    const { env } = fixture();
    const workspaceId = "self-hosted";
    const connectionId = "wci_test";
    await promoteConnectorToWorkspaceScope(env, workspaceId, "alice", {
      providerKey: "github",
      connectedAccountId: "ocg_github",
      workspaceAppConnectionId: connectionId,
    });
    const rows = await listWorkspaceConnectors(env, workspaceId, "alice", "workspace");
    expect(rows[0]?.workspaceAppConnectionId).toBe(connectionId);
    const archived = await archiveWorkspaceConnector(env, workspaceId, "alice", rows[0]!.id, true);
    expect(archived).toEqual({ ok: true });
    await expect(assertConnectorRegistryAllowsRuntime(env, connectionId)).rejects.toThrow("workspace_connector_archived");
  });

  it("serves personal registry rows from the extensions API", async () => {
    const f = fixture();
    await upsertPersonalConnectorFromProvider(f.env, "self-hosted", "alice", {
      id: "ocg_linear",
      providerKey: "linear",
      provider: "openconnector",
      identityLabel: "Linear account",
      executionReady: true,
    });
    const list = await f.send("/api/v1/extensions/connectors?view=personal");
    const body = await list?.json() as { connectors: Array<{ providerKey: string }> };
    expect(body.connectors).toMatchObject([{ provider: "openconnector", providerKey: "linear", scope: "personal", identityLabel: "Linear account" }]);
  });

  it("proves no legacy 0008 reader remains in backend source", async () => {
    const { readdirSync, readFileSync: read } = await import("node:fs");
    const { join } = await import("node:path");
    const root = new URL("../src/", import.meta.url);
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(path));
        else if (entry.name.endsWith(".ts")) out.push(path);
      }
      return out;
    };
    const hits = walk(new URL(root).pathname).flatMap((path) => {
      const text = read(path, "utf8");
      if (path.includes("extensions/connectors-store")) return [];
      return text.includes("workspace_connectors") ? [path] : [];
    });
    expect(hits).toEqual([]);
  });
});