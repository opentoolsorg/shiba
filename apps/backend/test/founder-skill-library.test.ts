import { describe, expect, it } from "vitest";
import { founderSkillIdSchema, getFounderSkillLibraryEntry, listFounderSkillLibrary } from "@shiba/shared";
import { founderSkillSetup } from "../src/founder-skill-setup.js";

describe("founder skill library", () => {
  it("seeds six Viktor-style founder skills", () => {
    expect(listFounderSkillLibrary()).toHaveLength(6);
    for (const entry of listFounderSkillLibrary()) {
      expect(founderSkillIdSchema.safeParse(entry.id).success).toBe(true);
      expect(entry.expectedDeliverables.length).toBeGreaterThan(0);
      expect(entry.schedule.cron.split(" ").length).toBe(5);
      const setup = founderSkillSetup(entry);
      expect(setup.profile.expectedDeliverables).toEqual(entry.expectedDeliverables);
      expect(setup.routines).toHaveLength(1);
      expect(setup.routines[0]?.enabled).toBe(false);
      expect(setup.requirements.map((item) => item.name)).toEqual(entry.integrationCatalogIds);
      expect(setup.skills[0]?.instructions).toBe(entry.instructions);
    }
  });

  it("includes stripe revenue pulse with integration metadata", () => {
    const entry = getFounderSkillLibraryEntry("founder-stripe-revenue-pulse");
    expect(entry?.integrationCatalogIds).toContain("stripe");
    expect(entry?.requiresSensitiveApproval).toBe(false);
  });
});
