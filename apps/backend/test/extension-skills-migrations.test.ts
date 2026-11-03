import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createExtensionSkill, listExtensionSkills } from "../src/extension-skills-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const migrations = new URL("../migrations/", import.meta.url);
const files = readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort();
const orgMigration = "0009_org_extension_skills.sql";

for (const initializeAtRuntime of [false, true]) {
  describe(initializeAtRuntime ? "runtime extension skill tables" : "extension skill migrations", () => {
    it("preserves legacy skill rows and keeps new skills scoped to their organization", async () => {
      const { database, sqlite } = customAgentD1();
      try {
        for (const file of files.filter((name) => name < orgMigration)) {
          sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
        }
        sqlite.prepare(`INSERT INTO extension_skills
          (id, user_id, workspace_id, scope, name, description, instructions, created_at, updated_at)
          VALUES ('legacy', 'alice', 'workspace-1', 'workspace', 'Legacy skill', 'Existing description', 'Preserved body', 1, 2)`)
          .run();
        const original = sqlite.prepare("SELECT * FROM extension_skills WHERE id = 'legacy'").get();
        if (!initializeAtRuntime) {
          for (const file of files.filter((name) => name >= orgMigration)) {
            sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
          }
        }
        const env = { AGENT_AUDIT: database };
        const id = await createExtensionSkill(env, "org-1", "alice", {
          name: "New skill", description: "New description", instructions: "New body",
          workspaceId: "workspace-1", scope: "workspace",
        });
        expect(await listExtensionSkills(env, "org-1", "alice", { workspaceId: "workspace-1" }))
          .toEqual([expect.objectContaining({ _id: id, name: "New skill", instructions: "New body" })]);
        expect(await listExtensionSkills(env, "org-2", "alice", { workspaceId: "workspace-1" })).toEqual([]);
        expect(sqlite.prepare("SELECT * FROM extension_skills WHERE id = 'legacy'").get()).toEqual(original);
      } finally {
        sqlite.close();
      }
    });

    it("supports a fresh database", async () => {
      const { database, sqlite } = customAgentD1();
      try {
        if (!initializeAtRuntime) {
          for (const file of files) sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
        }
        const env = { AGENT_AUDIT: database };
        const id = await createExtensionSkill(env, "org-1", "alice", {
          name: "Fresh skill", description: "Description", instructions: "Body",
        });
        expect(await listExtensionSkills(env, "org-1", "alice"))
          .toEqual([expect.objectContaining({ _id: id, name: "Fresh skill" })]);
      } finally {
        sqlite.close();
      }
    });
  });
}
