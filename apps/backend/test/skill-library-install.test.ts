import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { installLibrarySkill, uninstallLibrarySkill } from "../src/skill-library/install.js";
import { getSkillInstall, listSkillInstalls } from "../src/skill-library-store.js";
import { disableSkill, getSkill } from "../src/skills-store.js";
import { customAgentD1 } from "./fixtures/custom-agent-d1.js";

const slug = "pr-review-checklist";
const orgId = "org-test";
const ownerId = "owner@example.test";

function setup() {
  const { database, sqlite } = customAgentD1();
  return { bindings: { AGENT_AUDIT: database }, sqlite };
}

describe("library install ownership and concurrency", () => {
  it("keeps installs and uninstall authority separate for owners in the same org", async () => {
    const { bindings } = setup();
    const first = await installLibrarySkill(bindings, orgId, ownerId, slug);
    expect(await uninstallLibrarySkill(bindings, orgId, "other@example.test", slug)).toBe(false);
    expect(await listSkillInstalls(bindings, orgId, "other@example.test")).toEqual([]);
    const second = await installLibrarySkill(bindings, orgId, "other@example.test", slug);
    expect(second.skillId).not.toBe(first.skillId);
    expect(await uninstallLibrarySkill(bindings, orgId, "other@example.test", slug)).toBe(true);
    expect((await getSkill(bindings, orgId, ownerId, first.skillId))?.status).toBe("draft");
    expect((await getSkillInstall(bindings, orgId, ownerId, slug))?.skillId).toBe(first.skillId);
    expect(await listSkillInstalls(bindings, "another-org", ownerId)).toEqual([]);
  });

  it("converges concurrent first installs on one tracked draft and disables losing drafts", async () => {
    const { bindings, sqlite } = setup();
    const results = await Promise.all(Array.from({ length: 8 }, () => installLibrarySkill(bindings, orgId, ownerId, slug)));
    const winner = results[0];
    if (!winner) throw new Error("Expected concurrent install results");
    expect(new Set(results.map((result) => result.skillId)).size).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect((await getSkillInstall(bindings, orgId, ownerId, slug))?.skillId).toBe(winner.skillId);
    expect(sqlite.prepare("SELECT id FROM skills WHERE status <> 'disabled'").all()).toEqual([{ id: winner.skillId }]);
    expect((await getSkill(bindings, orgId, ownerId, winner.skillId))?.status).toBe("draft");
  });

  it.each(["disabled", "missing"])("atomically replaces a %s installed skill", async (state) => {
    const { bindings, sqlite } = setup();
    const original = await installLibrarySkill(bindings, orgId, ownerId, slug);
    if (state === "disabled") await disableSkill(bindings, orgId, ownerId, original.skillId);
    else sqlite.prepare("DELETE FROM skills WHERE id = ?").run(original.skillId);
    const results = await Promise.all(Array.from({ length: 8 }, () => installLibrarySkill(bindings, orgId, ownerId, slug)));
    const winner = results[0];
    if (!winner) throw new Error("Expected concurrent install results");
    expect(new Set(results.map((result) => result.skillId)).size).toBe(1);
    expect(winner.skillId).not.toBe(original.skillId);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect((await getSkillInstall(bindings, orgId, ownerId, slug))?.skillId).toBe(winner.skillId);
    expect(sqlite.prepare("SELECT id FROM skills WHERE status <> 'disabled'").all()).toEqual([{ id: winner.skillId }]);
  });

  it("migrates previously applied org-scoped keys without losing existing installs", () => {
    const { sqlite } = setup();
    sqlite.exec(`CREATE TABLE skill_installs (
      org_id TEXT NOT NULL, library_slug TEXT NOT NULL, library_version TEXT NOT NULL,
      skill_id TEXT NOT NULL, installed_by TEXT NOT NULL, installed_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, library_slug)
    ); INSERT INTO skill_installs VALUES ('org', 'slug', '1', 'skill-a', 'owner-a', 1);`);
    sqlite.exec(readFileSync(new URL("../migrations/0007_skill_installs_owner.sql", import.meta.url), "utf8"));
    sqlite.exec("INSERT INTO skill_installs VALUES ('org', 'slug', '1', 'skill-b', 'owner-b', 2)");
    expect(sqlite.prepare("SELECT skill_id FROM skill_installs ORDER BY installed_at").all()).toEqual([
      { skill_id: "skill-a" }, { skill_id: "skill-b" },
    ]);
  });
});
