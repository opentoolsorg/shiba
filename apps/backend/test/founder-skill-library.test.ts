import { describe, expect, it } from "vitest";
import { founderSkillIdSchema, getFounderSkillLibraryEntry, listFounderSkillLibrary } from "@shiba/shared";

describe("founder skill library", () => {
  it("seeds six Viktor-style founder skills", () => {
    expect(listFounderSkillLibrary()).toHaveLength(6);
    for (const entry of listFounderSkillLibrary()) {
      expect(founderSkillIdSchema.safeParse(entry.id).success).toBe(true);
      expect(entry.expectedDeliverables.length).toBeGreaterThan(0);
      expect(entry.schedule.cron.split(" ").length).toBe(5);
    }
  });

  it("includes stripe revenue pulse with bridge metadata", () => {
    const entry = getFounderSkillLibraryEntry("founder-stripe-revenue-pulse");
    expect(entry?.bridgeCatalogIds).toContain("stripe");
    expect(entry?.requiresSensitiveApproval).toBe(false);
  });
});
