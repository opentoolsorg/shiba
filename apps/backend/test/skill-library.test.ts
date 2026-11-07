import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SKILL_LIBRARY, librarySkillSchema, listLibrarySkills } from "../src/skill-library/index.js";

describe("skill library catalog", () => {
  it("has exactly seventeen zod-valid entries with unique slugs, names and instructions", () => {
    expect(SKILL_LIBRARY).toHaveLength(17);
    const slugs = new Set(listLibrarySkills().map((skill) => skill.slug));
    expect(slugs.size).toBe(SKILL_LIBRARY.length);
    expect(new Set(SKILL_LIBRARY.map((skill) => skill.name)).size).toBe(SKILL_LIBRARY.length);
    expect(new Set(SKILL_LIBRARY.map((skill) => skill.instructions)).size).toBe(SKILL_LIBRARY.length);
    expect(readdirSync(new URL("../src/skill-library/seeds/", import.meta.url)).filter((file) => file.endsWith(".md")).sort())
      .toEqual([...slugs].map((slug) => `${slug}.md`).sort());
    for (const skill of SKILL_LIBRARY) {
      expect(librarySkillSchema.safeParse(skill).success).toBe(true);
      expect(readFileSync(new URL(`../src/skill-library/seeds/${skill.slug}.md`, import.meta.url), "utf8").trim()).toBe(skill.instructions.trim());
      expect(skill.instructions.length).toBeLessThanOrEqual(16_000);
      expect(skill.sourceUrl).toBe(`https://github.com/opentoolsorg/shiba/blob/main/apps/backend/src/skill-library/seeds/${skill.slug}.md`);
    }
  });

  it.each([
    ["marketing-campaign-brief", "marketing", "targets from observed results"],
    ["sales-account-brief", "sales", "never invent contacts, buying intent"],
    ["product-spec-draft", "product", "testable"],
    ["design-review-notes", "design", "Static images do not prove keyboard behavior"],
    ["operations-runbook-draft", "operations", "unverified recovery paths"],
    ["qa-test-plan", "qa", "planned, passed, failed, blocked and unrun"],
  ])("keeps %s a sourced, role-specific draft workflow", (slug, role, evidenceRule) => {
    const skill = SKILL_LIBRARY.find((entry) => entry.slug === slug);
    if (!skill) throw new Error(`Missing role workflow: ${slug}`);
    expect(skill.tags).toEqual(expect.arrayContaining([role, "draft-workflow"]));
    expect(skill.version).toBe("1.0.0");
    expect(skill.summary.length).toBeLessThanOrEqual(220);
    expect(skill.instructions.length).toBeLessThanOrEqual(2_000);
    expect(`${skill.summary} ${skill.instructions}`).toContain(evidenceRule);
    for (const boundary of [
      "editable draft for human review",
      "explicitly connected accounts and granted resources",
      "untrusted evidence",
      "source identifiers",
      "exact-action human approval",
      "does not connect accounts, grant access, start a sandbox or configure a schedule",
      "Review and activation of instructions do not approve an external action",
    ]) expect(skill.instructions).toContain(boundary);
  });
});
