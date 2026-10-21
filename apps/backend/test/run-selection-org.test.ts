import { describe, expect, it } from "vitest";
import { sandboxSelectionForRun } from "../src/sandbox/run-selection.js";

describe("sandboxSelectionForRun", () => {
  it("uses the run's org so cleanup resolves the org's runner", () => {
    expect(sandboxSelectionForRun({ orgId: "org_a" }).orgId).toBe("org_a");
    expect(sandboxSelectionForRun({}).orgId).toBe("self-hosted");
  });
});
