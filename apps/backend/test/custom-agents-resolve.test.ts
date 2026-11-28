import { describe, expect, it } from "vitest";
import { composeCustomAgentTask, overridesFromCustomAgent } from "../src/custom-agents-resolve.js";


describe("composeCustomAgentTask", () => {
  it("does not prepend the same employee instructions twice", () => {
    const once = composeCustomAgentTask("Compare Q1 and Q2.", "Reconcile supplied figures.");
    expect(composeCustomAgentTask(once, "Reconcile supplied figures.")).toBe(once);
  });
});

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
  it("does not pin a coding model when no coding provider lane is configured", () => {
    const base = { id: "a1", orgId: "org-1", slug: "assistant", version: 1, createdAt: 1, updatedAt: 1 };
    const withoutLane = overridesFromCustomAgent({ ...base, config: { name: "Assistant", instructions: "Answer.", codingModel: "saved-model" } });
    expect(withoutLane).not.toHaveProperty("codingModel");
    const withHarness = overridesFromCustomAgent({ ...base, config: { name: "Assistant", instructions: "Answer.", harness: "opencode", codingModel: "saved-model" } });
    expect(withHarness.codingModel).toBe("saved-model");
  });
});
