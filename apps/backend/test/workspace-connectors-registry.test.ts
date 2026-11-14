import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { V1Principal } from "../src/v1-auth.js";
import type { Env } from "../src/env.js";
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