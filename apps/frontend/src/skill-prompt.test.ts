import { describe, expect, it } from "vitest";
import { formatSkillInstructions, taskWithSkillInstructions } from "./skill-prompt";

describe("selected skill instructions", () => {
  it("includes instruction text and source for every attached skill", () => {
    const text = formatSkillInstructions([
      { id: "a", name: "Security", repoUrl: "https://github.com/example/security", notes: "  Check authorization.\nTest cross-user access.  " },
      { id: "b", name: "Testing", notes: "Run the regression suite." },
    ]);
    expect(text).toBe("Skills:\nSkill: Security\nSource: https://github.com/example/security\nInstructions:\nCheck authorization.\nTest cross-user access.\n\nSkill: Testing\nInstructions:\nRun the regression suite.");
  });

  it("keeps bookmark-only skills useful without inventing instructions", () => {
    expect(formatSkillInstructions([{ id: "a", name: "Review", notes: "   " }])).toBe("Skills:\nSkill: Review");
    expect(formatSkillInstructions([])).toBe("");
  });

  it("freezes instructions into the task sent to both local and cloud coding runs", () => {
    expect(taskWithSkillInstructions("  Fix login  ", [{ id: "security", name: "Security", notes: "Check the session cookie." }]))
      .toBe("Fix login\n\nSkills:\nSkill: Security\nInstructions:\nCheck the session cookie.");
    expect(taskWithSkillInstructions("  Fix login  ", [])).toBe("Fix login");
  });
});
