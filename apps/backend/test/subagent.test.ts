import { describe, expect, it } from "vitest";
import {
  canSpawnSubagentAt,
  nextSubagentPath,
  resolveSubagentSandboxId,
  subagentDepth,
} from "@shiba/shared";

describe("subagent tree", () => {
  it("caps delegation at the coordinator's direct children", () => {
    expect(subagentDepth("1")).toBe(1);
    expect(canSpawnSubagentAt("1.2.3")).toBe(false);
    expect(canSpawnSubagentAt("1.2")).toBe(false);
    expect(canSpawnSubagentAt("1")).toBe(false);
    expect(canSpawnSubagentAt(undefined)).toBe(true);
  });

  it("allocates dotted sibling paths", () => {
    expect(nextSubagentPath(undefined, [])).toBe("1");
    expect(nextSubagentPath("1", ["1.1", "1.2"])).toBe("1.3");
    expect(nextSubagentPath("2", ["2.1"])).toBe("2.2");
  });

  it("requires an isolated child sandbox", () => {
    const parent = { sandboxId: "run-abc", runId: "r1" };
    expect(() => resolveSubagentSandboxId(parent, "shared", "run-fresh")).toThrow(/isolated/);
    expect(() => resolveSubagentSandboxId(parent, "fresh", "run-abc")).toThrow(/differ/);
    expect(resolveSubagentSandboxId(parent, "fresh", "run-fresh")).toBe("run-fresh");
  });
});
