import { describe, expect, it } from "vitest";
import {
  createCustomAgent,
  deleteCustomAgent,
  getCustomAgentById,
  listCustomAgents,
  updateCustomAgent,
} from "../src/custom-agents-store.js";

function mockD1(): D1Database {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  const ensure = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const prepare = (sql: string) => ({
    bind(...args: unknown[]) {
      return {
        async run() {
          if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX") || sql.includes("audit_log")) {
            return { success: true };
          }
          if (sql.includes("INSERT INTO org_custom_agents")) {
            const agents = ensure("org_custom_agents");
            const id = String(args[0]);
            agents.set(id, {
              id,
              org_id: args[1],
              slug: args[2],
                  version: 1,
                  config_json: args[3],
                  created_at: args[4],
                  updated_at: args[5],
              deleted_at: null,
            });
          }
          if (sql.includes("INSERT INTO org_custom_agent_versions")) {
            ensure("org_custom_agent_versions").set(`${args[0]}-${args[2]}`, {});
          }
          if (sql.includes("UPDATE org_custom_agents SET deleted_at")) {
            const row = ensure("org_custom_agents").get(String(args[2]));
            if (row) row.deleted_at = args[0];
          }
          if (sql.includes("UPDATE org_custom_agents SET version")) {
            const row = ensure("org_custom_agents").get(String(args[3]));
            if (row) {
              row.version = args[0];
              row.config_json = args[1];
              row.updated_at = args[2];
            }
          }
          return { success: true };
        },
        async first() {
          if (sql.includes("FROM org_custom_agents WHERE org_id = ? AND slug")) {
            return [...ensure("org_custom_agents").values()].find(
              (r) => r.org_id === args[0] && r.slug === args[1] && r.deleted_at == null,
            );
          }
          if (sql.includes("FROM org_custom_agents WHERE org_id = ? AND id")) {
            const row = ensure("org_custom_agents").get(String(args[1]));
            return row && row.org_id === args[0] && row.deleted_at == null ? row : null;
          }
          return null;
        },
        async all() {
          if (sql.includes("FROM org_custom_agents WHERE org_id")) {
            const agents = [...ensure("org_custom_agents").values()].filter(
              (r) => r.org_id === args[0] && r.deleted_at == null,
            );
            return { results: agents };
          }
          return { results: [] };
        },
      };
    },
    async run() {
      return { success: true };
    },
  });
  return { prepare } as D1Database;
}

describe("custom agents store", () => {
  const env = { AGENT_AUDIT: mockD1() };

  it("creates, updates, lists, and soft-deletes", async () => {
    const created = await createCustomAgent(env, "org-1", "scout", {
      name: "Scout",
      instructions: "Explore the repo.",
      harness: "opencode",
    });
    expect(created.slug).toBe("scout");
    expect(created.version).toBe(1);

    const updated = await updateCustomAgent(env, "org-1", created.id, {
      name: "Scout v2",
      instructions: "Explore deeply.",
      harness: "opencode",
    });
    expect(updated.version).toBe(2);

    const list = await listCustomAgents(env, "org-1");
    expect(list).toHaveLength(1);

    await deleteCustomAgent(env, "org-1", created.id);
    expect(await getCustomAgentById(env, "org-1", created.id)).toBeNull();
  });

  it("does not return another org's agent by id", async () => {
    const created = await createCustomAgent(env, "org-a", "scout", {
      name: "Scout",
      instructions: "Explore.",
      harness: "opencode",
    });
    expect(await getCustomAgentById(env, "org-b", created.id)).toBeNull();
    expect((await getCustomAgentById(env, "org-a", created.id))?.slug).toBe(
      "scout",
    );
  });
});
