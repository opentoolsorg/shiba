import { describe, expect, it } from "vitest";
import { SKILL_LIBRARY, librarySkillSchema, listLibrarySkills } from "../src/skill-library/index.js";

describe("skill library catalog", () => {
  it("has exactly five zod-valid entries with unique slugs", () => {
    expect(SKILL_LIBRARY).toHaveLength(5);
    const slugs = new Set(listLibrarySkills().map((skill) => skill.slug));
    expect(slugs.size).toBe(5);
    for (const skill of SKILL_LIBRARY) {
      expect(librarySkillSchema.safeParse(skill).success).toBe(true);
      expect(skill.instructions.length).toBeLessThanOrEqual(16_000);
    }
  });
});
