import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SKILL_LIBRARY, librarySkillSchema, listLibrarySkills } from "../src/skill-library/index.js";

describe("skill library catalog", () => {
  it("has exactly eleven zod-valid entries with unique slugs", () => {
    expect(SKILL_LIBRARY).toHaveLength(11);
    const slugs = new Set(listLibrarySkills().map((skill) => skill.slug));
    expect(slugs.size).toBe(11);
    for (const skill of SKILL_LIBRARY) {
      expect(librarySkillSchema.safeParse(skill).success).toBe(true);
      expect(readFileSync(new URL(`../src/skill-library/seeds/${skill.slug}.md`, import.meta.url), "utf8").trim()).toBe(skill.instructions.trim());
      expect(skill.instructions.length).toBeLessThanOrEqual(16_000);
    }
  });
});
