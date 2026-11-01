import { describe, expect, it } from "vitest";
import { formatSkillInstructions, taskWithSkillInstructions } from "./skill-prompt";
import type { SavedSkill } from "./saved";

const active = (overrides: Partial<SavedSkill> = {}): SavedSkill => ({
  id: "skill-a1b2c3",
  version: 3,
  status: "active",
  owned: true,
  name: "Security",
  sourceUrl: "https://github.com/example/security",
  instructions: "Check authorization.\nTest cross-user access.",
  activeVersion: 3,
  createdAt: 10,
  updatedAt: 12,
  ...overrides,
});

describe("selected skill instructions", () => {
  it("includes an immutable version pin, provenance and reviewed text", () => {
    expect(formatSkillInstructions([active()])).toBe(
      "Skills:\nSkill: Security (skill-a1b2c3@3)\nSource: https://github.com/example/security\nReviewed instructions:\nCheck authorization.\nTest cross-user access.",
    );
  });

  it("formats without source metadata and preserves the selected version", () => {
    expect(formatSkillInstructions([active({ sourceUrl: undefined, instructions: "Run the tests." })]))
      .toBe("Skills:\nSkill: Security (skill-a1b2c3@3)\nReviewed instructions:\nRun the tests.");
    expect(formatSkillInstructions([])).toBe("");
  });

  it("freezes reviewed text into the task sent to execution", () => {
    expect(taskWithSkillInstructions("  Fix login  ", [active()])).toBe(
      "Fix login\n\nSkills:\nSkill: Security (skill-a1b2c3@3)\nSource: https://github.com/example/security\nReviewed instructions:\nCheck authorization.\nTest cross-user access.",
    );
    expect(taskWithSkillInstructions("  Fix login  ", [])).toBe("Fix login");
  });
});
