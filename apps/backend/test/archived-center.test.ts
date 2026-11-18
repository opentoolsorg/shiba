import { describe, expect, it } from "vitest";
import { listArchivedCenter } from "../src/governance/archived-center.js";
import { createTeamWorkspace } from "../src/team-workspaces-store.js";
import { governanceD1Fixture } from "./fixtures/governance-d1.js";

describe("archived center migration schema", () => {
  it("lists archived agents from the member's workspace using the migrated table", async () => {
    const { env, sqlite } = await governanceD1Fixture();
    try {
      const owner = "owner@example.test";
      const workspace = await createTeamWorkspace(env, owner, { name: "Design" }, 1);
      const insert = sqlite.prepare(`INSERT INTO org_custom_agents
        (id,org_id,slug,version,config_json,created_at,updated_at,archived_at,deleted_at)
        VALUES (?,?,?,1,?,1,1,?,?)`);
      const config = JSON.stringify({ name: "Researcher", instructions: "Research", harness: "codex" });
      insert.run("archived", `team:${workspace.workspaceId}`, "archived", config, 20, null);
      insert.run("active", `team:${workspace.workspaceId}`, "active", config, null, null);
      insert.run("deleted", `team:${workspace.workspaceId}`, "deleted", config, 30, 40);
      insert.run("other", "team:ws_aaaaaaaaaaaaaaaaaaaaaaaa", "other", config, 50, null);

      await expect(listArchivedCenter(env, workspace.workspaceId, owner)).resolves.toEqual([
        { resourceKind: "custom_agent", resourceId: "archived", title: "Researcher", archivedAt: 20, restoreSupported: true },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
