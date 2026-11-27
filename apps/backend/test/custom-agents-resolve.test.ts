import { describe, expect, it } from "vitest";
import { overridesFromCustomAgent } from "../src/custom-agents-resolve.js";

describe("overridesFromCustomAgent", () => {
  it("includes approvalPolicy when configured", () => {
    const overrides = overridesFromCustomAgent({
      id: "a1",
      orgId: "org-1",
      slug: "bot",
      version: 1,
      config: {
        name: "Bot",
        instructions: "Run",
        harness: "opencode",
        approvalPolicy: "auto_approve",
      },
      createdAt: 1,
      updatedAt: 1,
    });
    expect(overrides.approvalPolicy).toBe("auto_approve");
  });

  it("omits harness when the employee has no coding provider", () => {
    const overrides = overridesFromCustomAgent({
      id: "a1",
      orgId: "org-1",
      slug: "assistant",
      version: 1,
      config: { name: "Assistant", instructions: "Answer questions." },
      createdAt: 1,
      updatedAt: 1,
    });
    expect(overrides).not.toHaveProperty("harness");
  });
});
