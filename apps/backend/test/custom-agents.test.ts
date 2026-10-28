import { describe, expect, it } from "vitest";
import {
  createCustomAgent,
  deleteCustomAgent,
  getCustomAgentById,
  listCustomAgents,
  getCustomAgentBySlug,
  setCustomAgentArchived,
  updateCustomAgent,
} from "../src/custom-agents-store.js";

import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

describe("custom agents store", () => {
  const env = { AGENT_AUDIT: customAgentD1().database };

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

describe("custom agent lifecycle and atomic versions", () => {
  const config = { name: "Scout", instructions: "Explore the repo.", harness: "opencode" };

  it("archives and restores without losing definition, version history, or identity", async () => {
    const { database, sqlite } = customAgentD1();
    const env = { AGENT_AUDIT: database };
    const created = await createCustomAgent(env, "org-a", "scout", config);
    const archived = await setCustomAgentArchived(env, "org-a", created.id, true);
    expect(archived.archivedAt).toEqual(expect.any(Number));
    expect(await getCustomAgentById(env, "org-a", created.id)).toBeNull();
    expect(await getCustomAgentBySlug(env, "org-a", "scout")).toBeNull();
    expect(await listCustomAgents(env, "org-a")).toEqual([]);
    expect(await listCustomAgents(env, "org-a", { archived: true })).toEqual([archived]);
    const again = await setCustomAgentArchived(env, "org-a", created.id, true);
    expect(again.archivedAt).toBe(archived.archivedAt);
    const restored = await setCustomAgentArchived(env, "org-a", created.id, false);
    expect(restored).toMatchObject({ id: created.id, config, version: 1 });
    expect(restored.archivedAt).toBeUndefined();
    expect(await listCustomAgents(env, "org-a")).toEqual([restored]);
    expect(sqlite.prepare("SELECT COUNT(*) count FROM org_custom_agent_versions").get()?.count).toBe(1);
  });

  it("does not archive, restore, read or edit another org's profile", async () => {
    const { database } = customAgentD1();
    const env = { AGENT_AUDIT: database };
    const created = await createCustomAgent(env, "org-a", "scout", config);
    for (const archived of [true, false]) {
      await expect(setCustomAgentArchived(env, "org-b", created.id, archived)).rejects.toThrow("Agent not found");
    }
    expect(await getCustomAgentById(env, "org-b", created.id, { includeArchived: true })).toBeNull();
    expect(await getCustomAgentById(env, "org-a", created.id)).not.toBeNull();
  });

  it("never restores soft-deleted profiles and keeps archived edits disabled", async () => {
    const { database } = customAgentD1();
    const env = { AGENT_AUDIT: database };
    const created = await createCustomAgent(env, "org-a", "scout", config);
    await setCustomAgentArchived(env, "org-a", created.id, true);
    await expect(updateCustomAgent(env, "org-a", created.id, config, 1)).rejects.toThrow("Agent not found");
    await deleteCustomAgent(env, "org-a", created.id);
    await expect(setCustomAgentArchived(env, "org-a", created.id, false)).rejects.toThrow("Agent not found");
    expect(await listCustomAgents(env, "org-a", { archived: true })).toEqual([]);
  });

  it("applies one of two concurrent edits to the same version and records only its history", async () => {
    const { database, sqlite } = customAgentD1();
    const env = { AGENT_AUDIT: database };
    const created = await createCustomAgent(env, "org-a", "scout", config);
    const results = await Promise.allSettled([
      updateCustomAgent(env, "org-a", created.id, { ...config, name: "First edit" }, 1),
      updateCustomAgent(env, "org-a", created.id, { ...config, name: "Second edit" }, 1),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain("Version conflict");
    const saved = await getCustomAgentById(env, "org-a", created.id);
    expect(saved?.version).toBe(2);
    const history = sqlite.prepare("SELECT version,config_json FROM org_custom_agent_versions ORDER BY version").all();
    expect(history).toHaveLength(2);
    expect(JSON.parse(String(history[1]?.config_json))).toEqual(saved?.config);
  });

  it("rolls back the profile write when recording the version fails", async () => {
    const { database, sqlite } = customAgentD1();
    const env = { AGENT_AUDIT: database };
    const created = await createCustomAgent(env, "org-a", "scout", config);
    sqlite.exec("CREATE TRIGGER fail_history BEFORE INSERT ON org_custom_agent_versions WHEN NEW.version > 1 BEGIN SELECT RAISE(ABORT, 'history unavailable'); END");
    await expect(updateCustomAgent(env, "org-a", created.id, { ...config, name: "Lost edit" }, 1)).rejects.toThrow("history unavailable");
    expect(await getCustomAgentById(env, "org-a", created.id)).toMatchObject({ version: 1, config });
    expect(sqlite.prepare("SELECT COUNT(*) count FROM org_custom_agent_versions").get()?.count).toBe(1);
  });

  it("adds archive support to a legacy table without changing existing configuration", async () => {
    const { database, sqlite } = customAgentD1();
    sqlite.exec(`CREATE TABLE org_custom_agents (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, slug TEXT NOT NULL,
      version INTEGER NOT NULL, config_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER)`);
    sqlite.prepare("INSERT INTO org_custom_agents VALUES (?,?,?,?,?,?,?,NULL)").run("legacy", "org-a", "legacy", 3, JSON.stringify(config), 1, 2);
    const env = { AGENT_AUDIT: database };
    const saved = await getCustomAgentById(env, "org-a", "legacy");
    expect(saved).toMatchObject({ id: "legacy", version: 3, config });
    expect((await setCustomAgentArchived(env, "org-a", "legacy", true)).archivedAt).toEqual(expect.any(Number));
    expect((await setCustomAgentArchived(env, "org-a", "legacy", false)).config).toEqual(config);
  });
});
