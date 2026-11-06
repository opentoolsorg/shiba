import { describe, expect, it } from "vitest";
import { founderSkillIdSchema, getFounderSkillLibraryEntry, listFounderSkillLibrary } from "@shiba/shared";
import { founderSkillSetup, FOUNDER_SKILL_LIBRARY_VERSION } from "../src/founder-skill-setup.js";

describe("founder skill library", () => {
  it("seeds six optional founder setup recipes", () => {
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

  it("labels all catalog entries as setup goals without promising automatic collection or delivery", () => {
    for (const entry of listFounderSkillLibrary()) {
      expect(entry.description).toMatch(/^Setup recipe/);
      expect(entry.description).not.toMatch(/posted to Slack on cron|uses Shiba.s native Linear binding|post a concise digest to Slack/);
      expect(entry.instructions).toContain("A template sensitivity label grants no authority.");
      expect(entry.instructions).toContain("Do not connect accounts, invoke new app actions, approve actions, enable schedules or send messages from this recipe alone.");
      expect(entry.automationPrompt).toMatch(/^Draft private reports\//);
      expect(entry.automationPrompt).toContain("explicitly selected authorized");
      const setup = founderSkillSetup(entry);
      expect(setup.routines.every((routine) => !routine.enabled)).toBe(true);
      expect(setup.requirements.every((requirement) => requirement.configurationRequired.length > 0)).toBe(true);
    }
  });

  it("keeps unsupported revenue metrics and native Linear query assumptions out of setup authority", () => {
    const stripe = getFounderSkillLibraryEntry("founder-stripe-revenue-pulse")!;
    expect(stripe.instructions).toContain("Customer lists do not establish subscription state, MRR, net new MRR or churn.");
    expect(stripe.instructions).toContain("complete subscription data and validated definitions");
    expect(stripe.instructions).toContain("Never invent results, replace missing values with zeros");
    expect(getFounderSkillLibraryEntry("founder-linear-triage")!.instructions).toContain("A native webhook event or acknowledgment is not proof of issue-query access.");
    // This legacy presentation hint remains false; it cannot remove the common approval boundary.
    expect(stripe.requiresSensitiveApproval).toBe(false);
    expect(founderSkillSetup(stripe).profile.instructions).toContain("Each needs its own current human authorization.");
  });

  it("pins changed setup instructions to a new portable provenance revision without enabling routines", () => {
    expect(FOUNDER_SKILL_LIBRARY_VERSION).toBe("1.1.0");
    for (const entry of listFounderSkillLibrary()) {
      const setup = founderSkillSetup(entry);
      expect(setup.profile.provenance).toEqual({ kind: "catalog", id: entry.id, revision: "1.1.0" });
      expect(setup.skills.every((skill) => skill.provenance?.revision === "1.1.0")).toBe(true);
      expect(setup.routines.every((routine) => routine.enabled === false)).toBe(true);
    }
  });

  it("includes stripe revenue pulse with integration metadata", () => {
    const entry = getFounderSkillLibraryEntry("founder-stripe-revenue-pulse");
    expect(entry?.integrationCatalogIds).toContain("stripe");
    expect(entry?.requiresSensitiveApproval).toBe(false);
  });
});
